import { BALL_CONFIG } from "shared/config/ball.config";
import { NPC_CONFIG } from "shared/config/npc.config";
import { throwAnimationWindowSeconds } from "shared/animation";
import { CHARGING_ATTRIBUTE, NPC_ANIM_MOVING_ATTRIBUTE, PENDING_ABILITY_ATTRIBUTE, THROW_WALK_ATTRIBUTE } from "shared/constants";
import type { ThrowWalk } from "shared/constants";
import { pendingAbilityOn } from "shared/ability";
import { resolveDodgeable } from "shared/dodge";
import { chargeForRange, getThrowMuzzle } from "shared/throw";
import { BEHAVIOR_THROWING, NpcBehavior } from "../Behavior";
import { detectEnemy } from "../detect";
import type { BallService } from "../../services/ball/BallService";

/**
 * How often this behaviour looks for something to throw at, in seconds.
 *
 * **Fast, because the rig has to *turn* before it throws and the turn is watched from here.** The
 * interval is not a throw rate — a throw needs a ball in the hand, and this behaviour never hands
 * itself one, so the rate is set by how often `Behavior_Seeking` and `Behavior_Pickup` fetch another.
 * What the interval paces is the reaction: how soon the rig notices an enemy, and how often it
 * re-checks that it has finished turning. A tenth of a second is the same cadence the catcher and the
 * dodger ask for, which keeps `NpcService`'s one-loop-per-rig turn rate unchanged for a rig wearing
 * any of them.
 *
 * This is deliberately *not* the old throw's five seconds. That number paced a rig that refilled its
 * own hand and threw on a metronome; with the refill gone (see the file comment), a slow tick would
 * only delay the turn.
 *
 * **Exported, because the practice variant next door now runs at it too.** `AlwaysThrowBehavior` used to be
 * ticked once every five seconds — the tick *was* its pace — which a windup cannot be held on: a hold that
 * cannot be looked at for five seconds is a hold that is not `charge × RIG_CHARGE_SECONDS`. So the pair shares this
 * cadence, that behaviour keeps its five seconds as a pace of its own (see its `DECISION_SECONDS`), and the
 * windup is watched on the same tenth of a second for both.
 */
export const THROW_TICK_SECONDS = 0.1;

/**
 * How many turns of silence mean a rig's windup is over — **the freeze detector, and it exists because a
 * frozen rig is a rig this behaviour never hears from.**
 *
 * **`NpcService`'s loop skips a frozen model entirely** — `if (frozen) { task.wait(period); continue; }` — so a
 * windup cannot *observe* its own freeze: the turns simply stop and then resume, and a windup held as an
 * absolute instant would be past its deadline by then and fire the throw on the first turn after the thaw, with
 * a charge solved before the freeze and a target that has moved since. That is precisely the thing the windup
 * must not do (a frozen rig that throws is the bug the hold is meant to make visible), so what the behaviour
 * watches instead is the *gap*: three turns of the shared cadence is four hundredths of a second past a
 * healthy one and far inside any freeze the game deals, and a lag spike that long costs a rig one re-decision
 * rather than a throw it should not have made.
 *
 * **Exported with {@link THROW_TICK_SECONDS}**, because the practice variant holds a windup too and a freeze
 * stops its turns in exactly the same way.
 */
export const WINDUP_GAP_TURNS = 3;

/**
 * How long past its own deadline a windup may sit before a timer takes it down anyway, in seconds.
 * **Placeholder — 0.25.**
 *
 * **The belt to the tick's braces, and it closes the one leak no turn can close.** A windup is cleared by the
 * turn that fires it or cancels it, which covers everything that happens while the rig is still being driven —
 * but a rig can stop being driven *while* a windup is live: `LobbyRigService` strips the six behaviour tags at
 * the round boundary, and `NpcService` skips an untagged behaviour, so a rig mid-windup when the round ends
 * would never tick again and would leave {@link CHARGING_ATTRIBUTE} set on its body for the rest of the
 * session — a looping effect welded to a rig standing in the lobby. `onPlaced` does not cover it, because the
 * tag removal races `returnRigsToLobby`. So a windup arms a timer for its own length plus this margin, and the
 * timer can only ever *cancel*.
 *
 * **That restriction is what makes it safe, and it is the difference between this and the `task.delay` the
 * windup deliberately does not use.** A timer that fired the throw would race the tick that is also watching
 * for the deadline; a timer that can only clear state whose token it still matches cannot race anything, because
 * the fire path has already thrown its token away by the time the timer looks. A quarter of a second is longer
 * than a turn's latency and shorter than the blink a stale effect would be noticed in.
 */
const WINDUP_EXPIRY_SLACK_SECONDS = 0.25;

/** The name on the attachment the aim constraint hangs from, so a stray one can be found. */
const AIM_ATTACHMENT_NAME = "NpcAimAttachment";

/** The name on the aim constraint itself, for the same reason. */
const AIM_CONSTRAINT_NAME = "NpcAimBalance";

/**
 * How hard the aim constraint may torque the rig, and how quickly it answers.
 *
 * **`AlignOrientation` rather than a per-tick `CFrame` write, and the codebase already made this
 * choice once**: `DodgeService.startDash` turns a dashing body with the same constraint, at the same
 * torque and responsiveness, for the same reason — a constraint turns the body *and* what the engine
 * thinks the body is doing, where a `CFrame` write on a physics-simulated root fights the solver and
 * reads as a snap. The numbers are copied from there deliberately so a rig turning to throw and a rig
 * dashing look like the same engine doing the same thing. They are not tuning values and so are not
 * in the config beside the range and the angle: they are the mechanism, and a rig that turns at a
 * different speed to a dodge is a different complaint to file.
 */
const AIM_MAX_TORQUE = 1e6;
const AIM_RESPONSIVENESS = 50;

/** Below this a target is too close to have a horizontal heading worth turning to. */
const AIM_FLAT_EPSILON = 0.001;

/**
 * One rig's aim: the constraint that is turning it, and what the humanoid's rotation was before.
 *
 * **State rather than locals, because the constraint has to outlive the tick that built it.** An
 * `AlignOrientation` turns a body over *time* — that is what makes the turn smooth — so it cannot be
 * created, used and destroyed inside one `tick`. It is kept per rig and reused until the aim ends.
 */
interface Aim {
	readonly attachment: Attachment;
	readonly balance: AlignOrientation;

	/** The rig's humanoid, if it has one, so its own rotation can be handed back. */
	readonly humanoid?: Humanoid;

	/** What `Humanoid.AutoRotate` was before this file switched it off. */
	readonly autoRotate: boolean;

	/**
	 * **When this aim may be dropped, if the rig has just thrown.** `undefined` for an ordinary aim, which ends
	 * the moment the rig stops aiming at something.
	 *
	 * **The aim outlives the throw by the throw's own animation**, and this is the number that says so: the tick
	 * that fires a throw sets it to `os.clock() + BALL_CONFIG.THROW_ANIMATION_SECONDS`, and the branch that would
	 * otherwise clear the aim on the next turn — a rig holding no ball is not aiming at anything — leaves it
	 * standing until this has passed. See `holdAimThroughThrow` for why the facing has to survive the release at
	 * all, and for the timer that closes it if the rig stops being ticked.
	 *
	 * **A time rather than a boolean**, so the window needs no second number and cannot be left switched on: an
	 * aim that is `undefined` here ends on the next turn, and one whose deadline has passed ends on the turn after
	 * that.
	 */
	holdUntil?: number;
}

/**
 * A rig holding a charge before it throws — **the delay that gives the throw something to display.**
 *
 * **A rig that fires in the same tick it decides has no charge to display. The windup is what makes the rig's
 * throw visible to a person watching the same way a player's hold is — and it is the only way a rig can show an
 * effect whose meaning is "this is being held".** A player's charge is a *duration*: the button is down for
 * `CHARGE_SECONDS` and the arm is visibly loaded for all of it. A rig has no button — it has a distance, and
 * `chargeForRange` answers which hold covers it — so the hold exists as a number and nothing else unless the rig
 * is made to *take* it. That is what this is: the rig decides, holds for a hold's worth of time, and then
 * releases. **The effect on its hand therefore means the same thing on both bodies**, which is the whole
 * property being bought; a rig playing a brief flash before an instant release would be an effect whose meaning
 * only held on one of the two.
 *
 * **The duration behind that effect is the rig's own figure, and it has been longer than a player's since the
 * charge split.** It was one constant, and a mobile complaint about how long a hold takes shortened the
 * *player's* — see `BALL_CONFIG.CHARGE_SECONDS`, and `BALL_CONFIG.RIG_CHARGE_SECONDS` for the number this file
 * reads. What the split protects is exactly the property in the paragraph above: the *meaning* of a loaded hand
 * has to be shared, and the *length* of the hold is not part of that meaning — a rig that released a fifth of a
 * second after it decided would still be showing the same effect, on a body nobody had time to dodge.
 *
 * **What it costs, named because it is a gameplay change rather than a graphics one: a rig now telegraphs its
 * throw.** A player watching sees the windup on the rig's hand and knows a ball is coming, which is exactly what
 * a player's own charge already does to everybody watching them — and it is what makes a rig dodgeable, since
 * the ball now leaves a fifth to five quarters of a second after the decision instead of on the frame of it.
 *
 * **State rather than a `task.delay`, and that is not a stylistic choice.** The deadline is read by the tick
 * that owns the throw — the same turn that would otherwise fire it checks this clock — so a timer that fired the
 * ball would be a second writer of the rig's throw, racing the turn that is watching the same instant and
 * duplicating the hand, miss and log work either could do first. {@link WINDUP_EXPIRY_SLACK_SECONDS} is the one
 * timer allowed near this, and its whole contract is that it may only clear state, never throw.
 */
interface Windup {
	/** `os.clock` seconds at which the hold is over and the ball should go. */
	readonly until: number;

	/**
	 * The charge this windup will throw, solved when the decision was made.
	 *
	 * **Recorded rather than recomputed at the release, so the hold lasts exactly as long as the charge it is
	 * holding.** Recomputing would make the release solve a fresh distance against a deadline set by the old
	 * one, and then a rig's windup would no longer be `charge × RIG_CHARGE_SECONDS` for any charge in particular —
	 * which is the one thing acceptance rests on and the one property a reader can check. The price is stated
	 * with the fire path: a rig that is *shoved or dashes* mid-windup releases the charge for where it was.
	 *
	 * **One exception, and it is the whole of {@link Windup.moving}**: a throw rolled as one made *on the move*
	 * is a throw whose body is **deliberately** walking, so its release solves a fresh charge and this one is
	 * only what the hold was bought with. See the release for the argument, and `NPC_CONFIG.THROW_MOVING_CHANCE`
	 * for the roll itself. A planted throw has no exception at all, which is what keeps this paragraph true of
	 * every rig that stands still to shoot.
	 */
	readonly charge: number;

	/**
	 * The horizontal distance {@link Windup.charge} was solved from, in studs — **kept so the throw line's two
	 * figures are one throw's.**
	 *
	 * The line a reader compares against a player's `[Throw]` line is *charge at distance*, and it is only a
	 * comparison while both numbers describe the same throw. The release turn has a fresh distance of its own
	 * (the target has moved, and the rig's hand with it), so printing that beside a charge solved on the
	 * decision turn would be exactly the two-numbers-from-two-throws the comparison is meant to rule out.
	 */
	readonly distance: number;

	/**
	 * Which of the three shapes this hold took — see {@link ThrowWalk}, which is the vocabulary, and
	 * `NPC_CONFIG.THROW_MOVE_AND_AIM_CHANCE`, which is where it is drawn.
	 *
	 * **On the record rather than read back off the model at the release, and that matters.** The release is
	 * *after* `endWindup`, which is what takes {@link THROW_WALK_ATTRIBUTE} off the body — so a release that
	 * asked the attribute would read `undefined` on every throw and quietly throw the planted shape's charge for
	 * all of them. A field cannot be cleared by the operation the release itself performs.
	 */
	readonly walk: ThrowWalk;

	/**
	 * **How wide this throw was rolled, if it was** — the error drawn on the decision turn and carried to the
	 * release. `undefined` is a true throw, which is the common case.
	 *
	 * **An offset rather than a point, and that is the difference between a wide throw and a stale one.** A point
	 * would be where the target stood when the rig decided; the hold is up to a second and a quarter long and the
	 * two shapes that walk move the rig twenty studs in that time, so an absolute point would send every wide throw
	 * at the body's *old* position — a systematic short-or-long bias every watcher could learn, which is the one
	 * kind of error a miss rate must not produce. The offset is re-applied to wherever the target is each turn, by
	 * the same `missedPoint` call the facing and the release both use, so the facing and the ball agree and a wide
	 * throw still leads a moving body.
	 *
	 * **It is here rather than in the caller for `Windup.walk`'s reason**: the release runs after `endWindup`, so
	 * anything the release needs has to be on this row before it goes. One draw, one row, one throw.
	 */
	readonly miss?: Miss;

	/**
	 * Identifies this windup against the others this rig will hold.
	 *
	 * **The expiry timer's whole guard.** A rig winds up again and again, so a timer armed for one hold has to
	 * be able to tell "my windup is still the live one" from "my windup was thrown and a later one is running
	 * now" without a second map to keep in step — the record *is* the token, the way `CatchService`'s window
	 * record is, and each new windup takes a number nobody will use again.
	 */
	readonly token: number;

	/**
	 * When this rig's last turn was, **which is how a freeze is noticed without being observable.**
	 *
	 * A frozen rig is not ticked at all, so the only evidence of a freeze is the absence of turns. Rewritten on
	 * every turn of the hold, and compared against `WINDUP_GAP_TURNS` ticks before anything else this tick does
	 * with the windup.
	 */
	lastTurnAt: number;
}

/**
 * The line one throw leaves along, worked out from where the rig's hand actually is — **the arithmetic the
 * windup's start and its release both need, written once so the two cannot measure different throws.**
 *
 * **The distance is taken from the muzzle and not from `sighting.distance`.** That figure is the range from the
 * rig's *root*, and the ball does not leave the root: `planChargedThrow` will solve from `getThrowMuzzle` on the
 * server's copy of this body a moment from now, and measuring from anywhere else would be a charge describing a
 * throw two studs behind the one that happens. Two studs is nothing across an arena and is a tenth of a short
 * throw, which is exactly why the measurement is taken the way the solve takes it.
 *
 * **Heading and distance come off the same flattened vector, and that is what keeps them one throw.**
 * `planChargedThrow` projects a heading onto the ground plane itself, so a heading that still carried the height
 * difference would arrive at the same compass direction — but the *distance* has to be a horizontal one, because
 * that is the distance the ballistic range is measured in. Flattening once here is what stops the two describing
 * different throws.
 *
 * **And the rise goes with it, because a rig aims downhill.** A charged throw leaves the hand at head height and
 * `sighting.aimPoint` is a body's *root* — about two and a half studs lower — so a charge solved from the
 * horizontal distance alone would fly long by a fifth and the ball would pass behind the body it was aimed at.
 * See `chargeForRange`: this is the one figure a rig has in hand that a player never has, and the reason the
 * bridge takes two arguments rather than one.
 */
interface ThrowLine {
	/** Horizontal distance from the hand to the point, in studs. */
	readonly distance: number;

	/** How far above the hand the point is, in studs — negative for a body on the same floor. */
	readonly rise: number;

	/** The compass direction to throw in, flattened; the rig's own facing when the point is under the hand. */
	readonly heading: Vector3;
}

/**
 * A deliberate miss: how far off this throw is aimed, and which way.
 *
 * **An offset and not a point, which is the one thing about its shape worth arguing.** The obvious version of
 * this carried the offset *and* the point it produced, so the throw site could hand `throwBall` a target — and
 * that version was wrong the moment the roll moved to the decision turn. A hold is up to a second and a quarter
 * long, two of the three throw shapes walk, and a target may have moved the whole time; a stored point is where
 * the body *was*, so every wide throw would be aimed at a stale position. A systematic error like that is the one
 * a watcher can name and predict, which is the opposite of what a misclick is for. An offset can be re-applied to
 * whatever point the aim is at *now*, by {@link missedPoint}, which is why the facing and the ball can keep
 * tracking a moving body while still being wrong by the same few studs.
 *
 * **Exported, and it is the pair's rather than this file's**: `AlwaysThrowBehavior` records the same offset on its
 * own windups and re-applies it with {@link missedPoint}, which is what makes a practice rig wide by the same
 * studs as a gated one for the same draw.
 */
export interface Miss {
	/** How far off the aim is, in studs. Never zero — see `THROW_MISS_STUDS_MIN`. */
	readonly studs: number;

	/** Which way, in the rig's own terms: `1` is its right, `-1` its left. */
	readonly side: number;
}

/**
 * Moves `aimPoint` sideways by `miss` — **the one place a deliberate miss becomes a point, used by everybody who
 * needs one.**
 *
 * **Both readers of a recorded miss call this rather than doing the arithmetic**: the tick, which turns the body
 * onto the point it is about to throw at, and the release, which aims the ball at it. That is what makes the
 * telegraph honest — a rig holding a wide throw is visibly pointed a few studs off the player, and the ball goes
 * where the body is pointed. Two copies of `aimPoint.add(right * side * studs)` would be two chances for the turn
 * and the throw to disagree about the same mistake, which would read as a rig that flinched at the last moment.
 *
 * **The rig's own right, flattened, read fresh every call** — so a rig that has turned since it decided still
 * misses to the side its body is now on. The Y component is dropped for `rollMiss`'s reason: a body leaning on a
 * slope would otherwise throw the ball over the target instead of past it, which is a different miss and the only
 * one this is not allowed to produce. A body with no usable right (which cannot happen for a live rig, and does
 * for a degenerate one) gets the point unchanged rather than a NaN.
 */
export function missedPoint(root: BasePart, aimPoint: Vector3, miss: Miss): Vector3 {
	const right = new Vector3(root.CFrame.RightVector.X, 0, root.CFrame.RightVector.Z);
	if (right.Magnitude < AIM_FLAT_EPSILON) return aimPoint;

	return aimPoint.add(right.Unit.mul(miss.side * miss.studs));
}

/**
 * Rolls this throw's error: nothing at all when it is aimed true, or a few studs to one side of the target.
 *
 * **A rig is fallible on purpose, and the error is in the *aim* rather than in the charge.** A miss that lowered
 * the charge would make the ball fall short, which reads as a *weak* rig rather than as an inaccurate one — and a
 * weak rig is a worse character than a fallible one. The lateral error keeps every throw exactly as strong as the
 * one before it: the ball simply leaves for a point a few studs off the body. See
 * `NPC_CONFIG.THROW_MISS_STUDS_MAX` for why the unit is studs and not degrees, and
 * `NPC_CONFIG.THROW_MISS_CHANCE` for why this is a rate rather than a spread.
 *
 * **A rate and not a spread, and the difference is the whole of the design.** A spread applied to every throw
 * makes every ball slightly wrong, which reads as a rig that cannot aim and which teaches a player to distrust
 * the throw altogether. A rate leaves half the throws exactly as honest as they ever were, so the rig reads as a
 * capable opponent that occasionally gets one wrong — which is what the user asked for ("to simulate real player
 * misclicks") and what makes the *windup* worth watching. Move the chance, not the magnitude, if the rigs still
 * feel too accurate.
 *
 * **Left and right are the rig's own.** The offset is along the flattened `RightVector`, so a rig facing
 * north that misses to its right sends the ball east. World-relative sides would have a rig facing east
 * missing "right" by throwing north, which is nobody's idea of a misclick.
 *
 * **It does not print, and it does not know whether the throw lands.** `throwBall` answers whether a ball
 * actually left, and it refuses some attempts — a frozen body keeps its ball — so a line from in here
 * would be a line per throw attempt for the whole of a freeze, describing throws that never happened. The
 * caller logs, once, and only for a throw that went. See the throw site.
 *
 * **Called exactly once per throw attempt, and that is a rule rather than a convention.** The only caller is
 * `createWindupTracker.beginWindup`, which runs on the turn a rig commits — reachable only from a behaviour's
 * decide branch, and only while no windup is live. So a rig decides *hit or miss* once, per throw, and nothing
 * downstream draws again: the release re-applies the offset this returned through `missedPoint`, and every turn
 * of the hold does the same. **A per-tick roll would be a body changing its mind during its own hold**, which
 * would make the telegraph a lie — the rig would be aimed one way and then throw another; a per-second roll
 * would be that same fault on a clock. If this function is ever called from anywhere else, it has stopped being
 * one decision per throw.
 *
 * **The common case returns nothing**, so a rig that is not missing this time is throwing exactly what it
 * threw before any of this existed.
 */
function rollMiss(root: BasePart): Miss | undefined {
	if (math.random() > NPC_CONFIG.THROW_MISS_CHANCE) return undefined;

	// The body's own right, flattened, and only to *check* it is usable: the point itself is what `missedPoint`
	// builds, because it has to be built again on every turn of the hold and at the release. A rig with no usable
	// right cannot be missed sideways, and it throws true rather than throwing nowhere.
	const right = new Vector3(root.CFrame.RightVector.X, 0, root.CFrame.RightVector.Z);
	if (right.Magnitude < AIM_FLAT_EPSILON) return undefined;

	const studs =
		NPC_CONFIG.THROW_MISS_STUDS_MIN +
		math.random() * (NPC_CONFIG.THROW_MISS_STUDS_MAX - NPC_CONFIG.THROW_MISS_STUDS_MIN);

	// A coin flip for the side, so a rig is as likely to be wide one way as the other — the two-sided
	// error a person makes, rather than a habitual bias toward one shoulder.
	const side = math.random() < 0.5 ? -1 : 1;

	return { studs, side };
}

/**
 * Throwing, for an NPC — **the gated variant, worn by `Behavior_Throwing`.**
 *
 * **It throws at an enemy, and it has to be facing one to do it.** Where `Behavior_AlwaysThrowing`
 * throws straight ahead on a timer whether or not anybody is there, this rig throws at the nearest
 * opposing model — and only when that model is roughly in front of it and within range. That facing
 * rule is not a property of throwing; it is the prerequisite the user asked for, and it lives in
 * `detect.ts` so a later dodge or catch can ask the same question of the same maths.
 *
 * **It never calls `prepare`, and it never hands itself a ball.** The rig that wears this is expected
 * to be wearing `Behavior_Seeking` and `Behavior_Pickup` too: it walks to a loose ball, picks it up,
 * and throws the one it has. **An empty hand is therefore not an error but the ordinary state after a
 * throw** — the rig goes and fetches another — so the tick below returns without throwing when there
 * is nothing in the hand, which is what `BallService.throwBall` would answer anyway, without the
 * lookups this file would have spent getting there.
 *
 * **It turns, and it throws when the turn is done — `turn-then-fire`, not `fire-when-close-enough`
 * (see `aimAt`).** The angle gate is re-read every tick from the rig's *current* facing, so the rig
 * visibly rotates onto its target and the ball leaves once the target is inside the window. The
 * alternative — throw the instant the *enemy* is within ±45° of wherever the rig happens to be
 * looking — is a rig that fires sideways while still standing, which reads as a bug from the seat
 * even though the aimed solve would land the ball anyway. The turn is what makes it read as a throw.
 *
 * **What the turn is not:** a change to the throw's *arithmetic*. `BallService.throwBall` is handed a
 * heading taken from the muzzle to the target's own point, and the charged solve flies the ball along
 * that compass direction from wherever the muzzle is — so the rotation is presentation, and the facing
 * window is a plausibility gate ("do not throw behind you") rather than a correction the solver needs.
 * Stated because the opposite is easy to assume: the ball is not thrown along `LookVector`, it is thrown
 * along the line to the target, which the rig merely happens to be facing.
 */

/**
 * The windup's state machine — **one implementation, two behaviours.**
 *
 * `ThrowBehavior` and `AlwaysThrowBehavior` both hold a charge before they throw, and they differ in *why* a hold
 * ends — a gated rig loses its target, a practice rig has none to lose — rather than in what a hold *is*. So the
 * mechanism lives here and each behaviour builds its own copy: two rigs on two behaviours must not share one
 * table, but they must agree on what a windup is, and this is the whole of what there is to agree about. The catch
 * pair's arrangement is the same one — the file named for the ordinary tag holds the body, and the `Always*` file
 * imports it rather than writing a second one.
 */
export interface WindupTracker {
	/**
	 * This rig's hold, or nothing. The tick asks once a turn and branches on the answer.
	 *
	 * **Declared as function-typed properties rather than as methods, and that is not a style choice.**
	 * `rbxtsc` refuses to let an arrow function satisfy a method — "Attempted to assign non-method where method
	 * was expected" — which is the same rule `NpcBehavior`'s own doc records for `tick`. This object is a bundle
	 * of closures over one table rather than a class, so the properties are what its shape actually is.
	 */
	get: (model: Model) => Windup | undefined;

	/**
	 * Start a hold aimed at `aimPoint`, from the hand of `model` — **the charge, the error and the shape are all
	 * worked out in here**, and the walk is the caller's answer because only the caller drew it.
	 *
	 * **`aimPoint` rather than a charge, and that is what makes one call site impossible to forget.** The roll
	 * lives behind this signature, so a behaviour that starts a hold gets the error whether or not its author
	 * remembered one existed — which is how a behaviour added later inherits it instead of being a second place the
	 * rule has to be added. `root` is the body the error is measured sideways from; passing it rather than looking it
	 * up keeps this a pure function of what the caller already resolved.
	 *
	 * **`trueAim`, and it is the one exception the paragraph above has to make room for.** A caller that passes it
	 * `true` suppresses the roll, and **exactly one caller does: `PracticeThrowBehavior`.** The reasoning is the
	 * distinction `THROW_MISS_CHANCE` was always about — that number is a difficulty dial for an *opponent*, and a
	 * drill is not one. A drill exists to be practised against: it is aimed at the person in front of it so they can
	 * work on dodging *that*, and a rig that is trying to miss is a rig you cannot learn from. **The exception is
	 * opt-in and defaulted off, which is what keeps the paragraph above true** — every existing call site behaves
	 * exactly as it did, and a new call site that says nothing gets the error. What stops the opt-out spreading is
	 * that it has to be *argued for at the call site*: a behaviour that wants a true throw has to say so in a comment,
	 * where the round's rigs silently passing it would be invisible.
	 */
	beginWindup: (model: Model, root: BasePart, aimPoint: Vector3, walk: ThrowWalk, trueAim?: boolean) => void;

	/** The hold ended by *throwing*: the row and the published charge go, and nothing is printed. */
	endWindup: (model: Model) => void;

	/** The hold ended without a throw: the same two lines, plus one naming the reason. */
	cancelWindup: (model: Model, reason: string) => void;
}

/**
 * Builds one behaviour's windups — the table, the token counter, and the four operations above.
 *
 * **{@link WindupTracker.endWindup} and {@link WindupTracker.cancelWindup} clear everything a hold published, and they
 * are the only two things that do.** That is what makes every path that ends a hold one line rather than one line
 * plus a `SetAttribute` each, and it is why cancelling is safe to call for a rig with no hold at all — every path
 * can call it unconditionally rather than each having to know whether one ever started. **Two facts go with it
 * since a throw can be rolled as one made on the move**: the charge and
 * {@link THROW_MOVING_ATTRIBUTE}, which are cleared together and therefore cannot disagree about whether a rig is
 * still winding up. The two are separate because only one of them is news: a throw has its own line a few lines
 * below, and a cancellation is a thing the `[Rig]` output would otherwise never mention.
 *
 * **The reason is printed on the server rather than published**, and that is a limit of the attribute rather than
 * a choice: `CHARGING_ATTRIBUTE` is a boolean, so a client can see that a hold ended and not why. The line below
 * is where the why lives, and it is the difference between "the rigs stopped throwing" and "the rigs lost their
 * targets" — the same question `ThrowBehavior`'s `idle` latch exists to answer for a rig with nothing to throw at.
 */
export function createWindupTracker(): WindupTracker {
	/** One row per rig currently holding a charge. See {@link Windup}. */
	const windups = new Map<Model, Windup>();

	/** The token the next hold takes. Only equality is ever asked of it, so one counter is enough. */
	let nextWindupToken = 0;

	/**
	 * Ends a rig's hold by throwing it: **the row and the published charge go, and no line is printed.**
	 *
	 * The throw's own line is the report for this path, so a "cancelled" line here would describe one event
	 * twice — which is the whole reason this is not simply `cancelWindup` with a silent flag.
	 */
	const endWindup = (model: Model): void => {
		windups.delete(model);
		model.SetAttribute(CHARGING_ATTRIBUTE, undefined);
		model.SetAttribute(THROW_WALK_ATTRIBUTE, undefined);
	};

	/** Ends a rig's hold without a throw: the same two lines, and the reason said out loud. */
	const cancelWindup = (model: Model, reason: string): void => {
		const windup = windups.get(model);
		if (windup === undefined) return;

		endWindup(model);

		print(`[Rig] ${model.Name}: windup cancelled — ${reason}`);
	};

	/**
	 * Starts a hold: **the charge is recorded, the deadline is set from it, and the rig is published as
	 * charging.**
	 *
	 * **The duration is arithmetic rather than a constant** — `charge × RIG_CHARGE_SECONDS` — so a rig winding up
	 * for a short throw holds briefly and one throwing across the arena holds for the full charge. That is the
	 * property the whole change rests on, and it is why there is no windup constant here: a number written into
	 * this file would be a second way of saying how long a hold takes, free to disagree with the config's.
	 *
	 * **What it is no longer is "the same number a player's hold of that charge takes", and the sentence is
	 * corrected rather than deleted because it was true for the life of this file until the charge split.** It
	 * read `charge × CHARGE_SECONDS` and argued exactly that. Then a mobile complaint shortened the *player's*
	 * hold to 0.6 s, and a rig's windup — which is the only warning a player gets that a ball is coming — was
	 * the last thing that should have come down with it. So the config now carries two figures:
	 * {@link BALL_CONFIG.CHARGE_SECONDS} for a hold in a hand, {@link BALL_CONFIG.RIG_CHARGE_SECONDS} for the
	 * hold a rig takes on purpose, and this line reads the second. **A rig's hold is now deliberately longer
	 * than a player's**, which is the honest description of a body that telegraphs to be dodgeable.
	 *
	 * **And the timer armed at the end is the only timer anywhere near a hold.** It is armed for the hold's own
	 * length plus a margin, and it does nothing at all in the ordinary case — the turn that releases the throw, or
	 * the turn that cancels it, has already taken this token out of the table by the time it looks. It exists for
	 * the case no turn can cover: a rig whose tags come off mid-hold stops being ticked, and without this its
	 * charge would stay published for the rest of the session. See {@link WINDUP_EXPIRY_SLACK_SECONDS}, which also
	 * argues why a timer that can only cancel cannot race the tick.
	 *
	 * **It publishes two facts rather than one, and the second is the walk's.** `walk` is the shape the thrower
	 * drew — see `NPC_CONFIG.THROW_MOVE_AND_AIM_CHANCE` — and it goes out as {@link THROW_WALK_ATTRIBUTE} for
	 * `SeekBehavior`, which is the behaviour that has to act on it: keep the body walking, leave its walk alone,
	 * or stand it where it is. Both facts are cleared together by {@link WindupTracker.endWindup}, which is what
	 * makes this the only writer of either and removes any way for a cancelled hold to leave a body published as
	 * walking.
	 *
	 * **The expiry timer is armed for the longest hold there can be, and one shape can hold well past its own
	 * charge.** `moveThenPlant` waits for the body to stop before it releases — that wait is the whole of what
	 * makes it a different shape — and the body may still be walking its carry-through for up to
	 * `PICKUP_WALK_SECONDS` after the deadline, plus the beat a decelerating humanoid takes to read as stopped.
	 * **A timer armed for the charge alone would cancel exactly the throws that shape exists to make**, so the
	 * walk's whole window is added to the margin for every hold rather than only for that shape: a timer that can
	 * only ever *cancel* costs nothing when it is late, and the alternative is a second branch here deciding how
	 * long a hold may be, which is the thing this file has spent its comments refusing to have.
	 *
	 * **It also rolls the throw's error, which is the one thing it does that is not about the hold.** The miss is
	 * drawn here rather than at the release so that the *charge is solved for the point the ball will actually
	 * leave for*, and so that both rig behaviours get it from one place — see `rollMiss`, which argues the
	 * decision-versus-release question and the rate-versus-spread one, and
	 * `NPC_CONFIG.THROW_MISS_CHANCE`. What that costs this function is two extra arguments (the body the error is
	 * measured from, and the point it is measured against) and a measurement of the throw it used to be handed;
	 * what it buys is that a hold on a wide throw lasts exactly as long as the wide throw it is holding, which is
	 * the same property the `charge` argument already existed to keep.
	 */
	const beginWindup = (model: Model, root: BasePart, aimPoint: Vector3, walk: ThrowWalk, trueAim?: boolean): void => {
		const now = os.clock();

		// **One roll, on the turn that decides, and nothing downstream rolls again.** `rollMiss` answers either
		// nothing — the common case, and the rig then throws exactly what it threw before any of this existed — or
		// a few studs to one side of the target, which `missedPoint` turns into the point the throw is really for.
		// The offset is what goes on the row, not the point: the release and every turn of the hold re-apply it to
		// wherever the target is *then*, so a wide throw still tracks a moving body. See {@link Windup.miss}.
		//
		// **`trueAim` skips the roll entirely rather than rolling and discarding it, and the difference is the log.**
		// A drill that suppressed the error after drawing one would still have a `Windup.miss`-shaped hole to fill;
		// leaving it `undefined` here is what makes every downstream reader — the release's heading, the throw's line
		// — say "aimed true" because it *was*, rather than because nobody looked.
		const miss = trueAim === true ? undefined : rollMiss(root);
		const point = miss === undefined ? aimPoint : missedPoint(root, aimPoint, miss);

		// The line from the hand to that point, measured the way the release will measure its own — the same
		// flattening, the same rise, for the reason {@link ThrowLine} gives. This is the *only* place the decision
		// turn measures a throw now; the release has its own `aimOf` because its hand and its target have moved.
		const muzzle = getThrowMuzzle(model);
		const flat = new Vector3(point.X - muzzle.X, 0, point.Z - muzzle.Z);
		const distance = flat.Magnitude;
		const charge = chargeForRange(distance, point.Y - muzzle.Y);

		// **The rig's own figure, and not the player's.** The two were one constant until a mobile complaint
		// about how long a hold takes; they are separate now because a player's hold is a decision and a rig's
		// is a telegraph, and shortening this one would make every rig harder to dodge. See
		// `BALL_CONFIG.RIG_CHARGE_SECONDS`, which is the value this line held before the split and still does.
		const duration = charge * BALL_CONFIG.RIG_CHARGE_SECONDS;

		nextWindupToken += 1;
		const token = nextWindupToken;

		// The charge *and* the distance it came from, because the two are one throw's and the log line needs both
		// of them from the same turn. See {@link Windup.distance}. `walk` rides along for the release, which runs
		// after this row is gone — see {@link Windup.walk}. `miss` does too, and it is the reason a wide throw can
		// be re-aimed at the release without being re-rolled: see {@link Windup.miss}.
		windups.set(model, { until: now + duration, charge, distance, walk, token, lastTurnAt: now, miss });

		// **The whole of what a client needs, and nothing else is sent.** Every client already has this rig's body,
		// so this one number is the effect's entire cause; a remote would be a second way for the same fact to
		// arrive, and the attribute is the way the rest of a rig's state already arrives.
		//
		// **The charge itself rather than a `true`, which is a reversal** — the flag was enough while the only
		// question was "is a hold happening", and the fire ball's threshold needs the value. See
		// `CHARGING_ATTRIBUTE`, where the reversal is argued: the number is already solved and in hand at this
		// line, so publishing it instead of `true` costs nothing and saves a second attribute carrying the same
		// event.
		model.SetAttribute(CHARGING_ATTRIBUTE, charge);

		// **And the walk's half of the same decision, which is a fact about a body rather than about a charge.**
		// The seek reads this on its own turn and acts on it — see {@link THROW_WALK_ATTRIBUTE} for why it cannot
		// be folded into the number above, and `NPC_CONFIG.THROW_MOVE_AND_AIM_CHANCE` for the draw that produced
		// it.
		model.SetAttribute(THROW_WALK_ATTRIBUTE, walk);

		print(
			`[Rig] ${model.Name}: winding up — charge ${string.format("%.2f", charge)} ` +
				`over ${string.format("%.2f", duration)}s, ${walk}`,
		);

		task.delay(duration + WINDUP_EXPIRY_SLACK_SECONDS + NPC_CONFIG.PICKUP_WALK_SECONDS, () => {
			const live = windups.get(model);
			if (live === undefined) return;
			if (live.token !== token) return;

			cancelWindup(model, "the windup outlived every turn that could end it");
		});
	};

	return {
		get: (model) => windups.get(model),
		beginWindup,
		endWindup,
		cancelWindup,
	};
}

export function createThrowBehavior(balls: BallService): NpcBehavior {
	/** One row per rig currently turning toward a target. See {@link Aim}. */
	const aims = new Map<Model, Aim>();

	/**
	 * The rigs that have already been reported as **holding a ball with nobody to throw it at**.
	 *
	 * A `Set` rather than a flag on the aim, because it is about a state that is not an aim: a rig with no
	 * target has no aim at all (this file clears it), so the fact has nowhere else to live. Presence is the
	 * latch — a rig is reported the turn it becomes blocked and again the turn it stops being blocked, and
	 * says nothing in between. Never cleared, like every other per-rig table in this directory: a destroyed
	 * rig never ticks again, so its entry is never read again either.
	 */
	const idle = new Set<Model>();

	/**
	 * **When each rig is allowed to decide**, in `os.clock` seconds — the hesitation clock behind
	 * `NPC_CONFIG.THROW_DECISION_SECONDS`.
	 *
	 * **A deadline rather than a "hesitating" flag, and the difference is what a flickering window does to it.**
	 * A flag would have to be set on the turn the window opened and cleared on the turn it closed, so a target
	 * that dropped out of range and came back a tenth of a second later would start the wait again — and a rig
	 * whose target is bobbing on the edge of `THROW_RANGE_STUDS` would then never finish hesitating. An absolute
	 * time is armed once and cannot be pushed back by anything the world does; the only things that remove it are
	 * the ones that genuinely end the window — an empty hand, and the tags coming off.
	 *
	 * **Not cleared on death, like every other per-rig table in this directory.** A dead rig is replaced by a
	 * *new model*, which has no row here, so the stale entry is the same kind of litter as the `idle` set's and
	 * the aims map's — read by nobody and dropped with the map when the behaviour's closure goes. `onStopped`
	 * clears it anyway, for the reason it clears `idle`: the tags come off at a round boundary and the same rig
	 * wears them again in the next round, so a deadline spent in the last round would otherwise let the first
	 * throw of the new one skip the hesitation.
	 */
	const readyAt = new Map<Model, number>();

	/**
	 * This rig's windups, and the operations the tick below uses on them — **the machinery itself rather than a
	 * copy of it.** See {@link createWindupTracker}, which the practice variant next door builds its own of: the
	 * hold is one mechanic, and a second hand-written copy of "arm a deadline, publish a flag, clear it if the
	 * token still matches" is exactly the second place a fix to it would go missing.
	 */
	const windups = createWindupTracker();

	/**
	 * The two operations **bound to the local names the tick's own comments use**, so the calls below read as
	 * they always did: `windups` is the state, and these two are what happens to it.
	 */
	const beginWindup = (model: Model, root: BasePart, aimPoint: Vector3, walk: ThrowWalk): void =>
		windups.beginWindup(model, root, aimPoint, walk);

	const cancelWindup = (model: Model, reason: string): void => windups.cancelWindup(model, reason);

	/**
	 * The line from the rig's hand to a point — {@link ThrowLine}'s arithmetic, **and now only the release's
	 * version of it.**
	 *
	 * **The decision's half moved into `createWindupTracker.beginWindup`, which is where the error is rolled and
	 * where the charge is solved from it.** It has to be: the charge is solved for the point the ball will
	 * actually leave for, so the roll and the solve cannot sit on opposite sides of a function boundary — and the
	 * tracker is the one place both rig behaviours pass through. What is left here is the release's own
	 * measurement, which is a *different* throw by design: the hand has moved, the target certainly has, and the
	 * two shapes that walk re-solve from figures taken now. See {@link ThrowLine} for the frame both use.
	 */
	const aimOf = (model: Model, root: BasePart, aimPoint: Vector3): ThrowLine => {
		const muzzle = getThrowMuzzle(model);

		// Flattened once, so the heading, the distance and the solve all describe the same throw. See
		// {@link ThrowLine} for why the frame matters to each of the three.
		const flat = new Vector3(aimPoint.X - muzzle.X, 0, aimPoint.Z - muzzle.Z);
		const distance = flat.Magnitude;

		return {
			distance,
			rise: aimPoint.Y - muzzle.Y,
			heading: distance > AIM_FLAT_EPSILON ? flat.Unit : root.CFrame.LookVector,
		};
	};

	/**
	 * Points `model`'s body at `aimPoint`, building the constraint the first time and re-aiming it
	 * after.
	 *
	 * **The humanoid's own rotation is switched off for the duration, and handed back afterwards.**
	 * A standing humanoid steers its own facing, which would fight the constraint for the body — the
	 * same fight `DodgeService` settles with `PlatformStand`, and settled here more cheaply because a
	 * rig that is walking must not be put on platform stand. `AutoRotate = false` leaves the walk
	 * controller alone and takes only the facing, which is the one thing this wants.
	 */
	const aimAt = (model: Model, root: BasePart, aimPoint: Vector3): void => {
		let aim = aims.get(model);

		if (aim === undefined) {
			const attachment = new Instance("Attachment");
			attachment.Name = AIM_ATTACHMENT_NAME;
			attachment.Parent = root;

			const balance = new Instance("AlignOrientation");
			balance.Name = AIM_CONSTRAINT_NAME;
			balance.Attachment0 = attachment;
			balance.Mode = Enum.OrientationAlignmentMode.OneAttachment;
			balance.MaxTorque = AIM_MAX_TORQUE;
			balance.Responsiveness = AIM_RESPONSIVENESS;
			balance.RigidityEnabled = false;
			balance.Parent = root;

			const humanoid = model.FindFirstChildWhichIsA("Humanoid");
			const autoRotate = humanoid?.AutoRotate ?? true;
			if (humanoid) humanoid.AutoRotate = false;

			aim = { attachment, balance, humanoid, autoRotate };
			aims.set(model, aim);
		}

		// Flat, so the turn is a yaw and never pitches the rig into the floor — the same reasoning
		// `DodgeService` gives for the two points of its own `lookAt`. A target directly overhead has
		// no heading to turn to, and the guard leaves the last good aim standing rather than turning
		// the rig to face nothing.
		const flat = new Vector3(aimPoint.X - root.Position.X, 0, aimPoint.Z - root.Position.Z);
		if (flat.Magnitude < AIM_FLAT_EPSILON) return;

		aim.balance.CFrame = CFrame.lookAt(root.Position, root.Position.add(flat.Unit));
	};

	/**
	 * Ends an aim: destroys the constraint and gives the humanoid its own rotation back.
	 *
	 * **Called on the three ways an aim can truly end — a lost target, a death, and the run-out of the window a
	 * throw holds it open for** — and safe to call when there is no aim, so each of those paths can call it
	 * unconditionally rather than each having to know whether one was ever built.
	 *
	 * **A throw is no longer one of them**, which is the one thing this function stopped doing. See
	 * {@link holdAimThroughThrow}: the body has to keep facing where it threw for the length of the throw's own
	 * animation, so the release leaves the aim standing and the moment it is cleared moves out to the end of that
	 * window.
	 */
	const clearAim = (model: Model): void => {
		const aim = aims.get(model);
		if (aim === undefined) return;

		aim.balance.Destroy();
		aim.attachment.Destroy();
		if (aim.humanoid) aim.humanoid.AutoRotate = aim.autoRotate;

		aims.delete(model);
	};

	/**
	 * **Keeps the rig facing where it threw, for the length of the throw's own animation.**
	 *
	 * **The problem it solves is the follow-through.** `Humanoid.AutoRotate` is restored the moment an aim ends,
	 * and a walking rig steers its facing from `MoveDirection` — so a rig that threw while walking (the
	 * `moveAndAim` shape, and the carry-through half of `moveThenPlant`) snapped back to its walk direction on the
	 * very frame the ball left its hand. The body then throws its arm out while already pointing somewhere else,
	 * which reads as the animation running after the throw instead of being the throw. A player's body has the
	 * same fault from the same cause, and `AimFacingController` fixes its half in its own file — **this is the
	 * server's half, and the two are the same rule**: the facing outlives the release by
	 * {@link BALL_CONFIG.THROW_ANIMATION_SECONDS}, which is the number both the animation's length and the
	 * `THROW_ANIMATION_ATTRIBUTE` window are set from.
	 *
	 * **What it is not: a constraint that keeps *tracking* the target.** The aim's `CFrame` was last written on
	 * the turn that threw, and nothing re-writes it here — the rig holds the one heading it released along, which
	 * is precisely "keep facing that direction". Re-aiming during the animation would be the rig correcting its
	 * throw after making it.
	 *
	 * **Two mechanisms, and the second one is for the rig that stops being driven.** The tick's own "no ball"
	 * branch is what normally ends the aim, and it has been taught to leave it standing while this deadline has
	 * not passed — but `LobbyRigService` strips the behaviour tags at a round boundary, and a rig that threw
	 * within this window of one would never tick again, leaving an `AlignOrientation` and a switched-off
	 * `AutoRotate` on a body standing in the lobby for the rest of the session. So a timer is armed for the window
	 * plus {@link WINDUP_EXPIRY_SLACK_SECONDS}, and **it can only ever clear, never act** — the same restriction
	 * the windup's own expiry timer carries, and for the same reason: it cannot race a turn that has already
	 * thrown its token away.
	 *
	 * **The length is the clip's, not the constant's**, and it is written the way `BallService` writes the mark's
	 * window — `math.max` of the two — because a clip longer than {@link BALL_CONFIG.THROW_ANIMATION_SECONDS}
	 * extends the animation and the mark with it. Reading the constant alone here would drop the facing a fraction
	 * of a second before the arm finished moving, which is the same fault this function exists to fix, only
	 * smaller.
	 *
	 * **The token is the aim object itself.** A rig cannot pick up a ball and throw again inside this window — it
	 * has to fetch one — but the check is a reference comparison rather than a promise about timing, so a rig that
	 * somehow aimed again would keep its new aim and only the old one would be dropped.
	 */
	const holdAimThroughThrow = (model: Model): void => {
		const aim = aims.get(model);
		if (aim === undefined) return;

		const window = math.max(BALL_CONFIG.THROW_ANIMATION_SECONDS, throwAnimationWindowSeconds());

		aim.holdUntil = os.clock() + window;

		task.delay(window + WINDUP_EXPIRY_SLACK_SECONDS, () => {
			if (aims.get(model) === aim) clearAim(model);
		});
	};

	return {
		tag: BEHAVIOR_THROWING,
		tickInterval: THROW_TICK_SECONDS,

		tick(model) {
			const now = os.clock();

			// Nothing to throw with: the ordinary state after a throw, and the rig is expected to go
			// and fetch another. Ending the aim is the honest thing here — a rig holding no ball is
			// not aiming at anything, and a constraint left standing would keep turning a body that
			// has nothing to do with the turn.
			//
			// **Except for the length of the throw it has just made**, which is the one case this branch is asked
			// to leave alone. The turn after a release arrives here with the ball already gone and the throw's
			// animation still running, and clearing the aim at that instant restores `AutoRotate` and snaps a
			// walking rig back to its walk direction mid-throw. See `holdAimThroughThrow`, which set the deadline
			// this reads, and which also arms the timer that closes the window if this branch never runs again.
			//
			// **And a hold cannot survive it.** A rig whose ball left its hand mid-windup — a throw by another
			// path, a pickup it lost, a round boundary that destroyed the ball — is not winding anything up any
			// more, and a windup left standing would fire a ball that is not there and leave its charge published
			// on a body with an empty hand.
			if (!balls.getHeldBall(model)) {
				const aim = aims.get(model);
				const holdingFacing = aim !== undefined && aim.holdUntil !== undefined && os.clock() < aim.holdUntil;

				cancelWindup(model, "the ball left the hand");
				if (!holdingFacing) clearAim(model);

				// **And the hesitation goes with the ball, which is what makes a new ball a new decision.** The
				// deadline below is keyed from the moment a throw became *available*, and the moment this rig has
				// another ball in its hand that moment is a different one — a pickup, or a catch. Without this
				// line the whole point of the clock would be lost on exactly the case it was asked for: a rig's
				// spent deadline would still be sitting in the table, so a caught ball would be thrown on the
				// first turn after the catch with no hesitation at all, which is the "catch and fire inside the
				// catch window" behaviour the dwell exists to stop. See `NPC_CONFIG.THROW_DECISION_SECONDS`.
				//
				// **This is the only place it is cleared while the rig is being played**, and the tags coming off
				// is the other one (`onStopped`). Nothing else has to know about the table: this branch is reached
				// on the first turn of every empty hand, so a throw does not clear it here — the throw's own turn
				// returns before this line — but the turn after one arrives with the hand empty and comes through
				// it.
				readyAt.delete(model);

				return;
			}

			const rigBody = resolveDodgeable(model);
			if (!rigBody) {
				cancelWindup(model, "no body to throw it with");
				clearAim(model);

				return;
			}

			// The enemy, or nothing — and nothing also covers "no round is playing", because
			// `detectEnemy` is silent outside one. A rig with no enemy stops aiming.
			const sighting = detectEnemy(model);

			// **A rig holding a ball with nobody to throw it at says so once, and says when that ends.** This
			// is the one state this behaviour has that is invisible in every other line a server prints: a rig
			// with a ball in hand and its target out of range does *nothing*, for as long as the state lasts,
			// and looks from a seat exactly like a rig that is thinking about it. In and out, once each, is
			// what turns "the rigs stopped throwing after a while" into a distance and a range to compare —
			// which is otherwise a question about a number in a config file that nothing reports.
			if (sighting === undefined || sighting.distance > NPC_CONFIG.THROW_RANGE_STUDS) {
				// **And a hold does not outlive the sighting that started it.** This is the first of the ways a
				// windup ends without a throw, and the one that matters most: a target that has walked out of
				// range, behind something, or out of the round is a target the rig can no longer see, and
				// releasing at where it *was* would be a rig throwing at nothing — the opposite of the telegraph
				// the hold exists to give, and the reason a rig is not simply allowed to fire on a timer.
				cancelWindup(model, sighting === undefined ? "the target is gone" : "the target left the range");
				clearAim(model);

				if (!idle.has(model)) {
					idle.add(model);

					const reason =
						sighting === undefined
							? "no enemy in the round"
							: `the nearest is ${math.floor(sighting.distance)} studs off, ` +
								`and the range is ${NPC_CONFIG.THROW_RANGE_STUDS}`;

					print(`[Rig] ${model.Name}: holding a ball and not throwing — ${reason}`);
				}

				return;
			}

			if (idle.has(model)) {
				idle.delete(model);

				print(`[Rig] ${model.Name}: throwing again — target ${math.floor(sighting.distance)} studs off`);
			}

			// Turn toward it. This runs whether or not the rig is already on target, because the
			// target may have moved and because re-aiming is what keeps the constraint pointing at
			// the body rather than at where it was.
			//
			// **And it runs on every turn of a windup too, which is what lets the hold be a hold.** The rig is
			// turning for the whole of the wait rather than being frozen mid-pose: the constraint is not
			// one-shot (see `aimAt`), so re-aiming each turn keeps the body on a target that is moving, and the
			// angle below is measured from the rig's *current* facing on each of those turns. A rig that
			// stopped tracking during its own windup would throw at where the player was when it decided, which
			// is the un-dodgeable rig this whole change is against.
			//
			// **And once a wide one has been rolled, this is where the body is told about it.** The point watched
			// here is the one the ball will leave for, error included — so a rig mid-windup on a wide throw is
			// *visibly* aiming a few studs to one side, and the telegraph points where the ball goes rather than at
			// the player. That is the house's own rule about a preview being honest applied to a rig: a hold that
			// said "this is coming at you" and then sent the ball elsewhere would be an invitation to a dodge that
			// was never available. The error is re-applied to the target's *current* point each turn, so the turn
			// still tracks a moving body — see `missedPoint` — and the release applies it the same way, which is
			// what keeps the facing and the throw describing one point.
			//
			// **What that costs, named rather than discovered: a wide-windup rig's retreat is off-line too.** The
			// seek's backpedal is the facing reversed — the legs one way, the eyes the other — so a rig winding up
			// on a ten-stud miss at twenty studs of range walks away along a line about twenty-six degrees off
			// straight-back. It does not break anything (`SeekBehavior.pickupWalk` reads the facing, and the facing
			// is still a real direction), and it arguably reads better than the alternative: a body whose retreat
			// is perfectly square while its throw is crooked is a body with two different ideas. It is a *cost*
			// because a watcher who has learned a rig's backpedal from its accurate throws will see the wide ones
			// drift, which is one more thing the error is visible in.
			const windup = windups.get(model);

			const turnTo =
				windup === undefined || windup.miss === undefined
					? sighting.aimPoint
					: missedPoint(rigBody.root, sighting.aimPoint, windup.miss);

			aimAt(model, rigBody.root, turnTo);

			if (windup !== undefined) {
				// **The freeze, seen as an absence rather than as a state.** A frozen rig is not ticked at all
				// — `NpcService` skips it — so this behaviour cannot be *told* it was frozen: the only evidence
				// is that the turns stopped and then resumed, by which time an absolute deadline is long past
				// and the throw would go on the first turn after the thaw with a charge solved before the
				// freeze and a target that has walked since. See `WINDUP_GAP_TURNS`.
				if (now - windup.lastTurnAt > THROW_TICK_SECONDS * WINDUP_GAP_TURNS) {
					cancelWindup(model, "the turns stopped — frozen");
					clearAim(model);

					return;
				}

				windup.lastTurnAt = now;

				// **The gate is measured against the point this throw is for, which after a wide roll is the error
				// point and not the target.** This used to read `sighting.angle` — the angle from the body's nose to
				// the enemy — and that was the same measurement while the body was turned onto the enemy. It is not
				// any more: the facing follows `turnTo`, so a rig winding up on a ten-stud miss at ten studs of range
				// sits about forty-five degrees off the *target*, and the gate would cancel its own wide throw with a
				// line about the target having left the angle — a report about something that never happened, and
				// for the rig the same hesitation round again. What the gate is actually asking is "is this body
				// still pointed at what it is throwing at", so that is what it now measures. Both vectors are
				// flattened, exactly as `detectEnemy`'s own angle is.
				const facing = new Vector3(rigBody.root.CFrame.LookVector.X, 0, rigBody.root.CFrame.LookVector.Z);
				const toAim = new Vector3(turnTo.X - rigBody.root.Position.X, 0, turnTo.Z - rigBody.root.Position.Z);

				const offBy =
					facing.Magnitude < AIM_FLAT_EPSILON || toAim.Magnitude < AIM_FLAT_EPSILON
						? 0
						: facing.Angle(toAim);

				if (math.abs(offBy) > math.rad(NPC_CONFIG.THROW_ANGLE_DEGREES)) {
					cancelWindup(model, "the target left the angle");

					return;
				}

				// **Still holding.** Everything that could end this hold early has been checked — the hand, the
				// sighting, the freeze, the angle — so what is left is the clock, and until it is up this turn has
				// nothing more to do. Returning here rather than falling through is what keeps the release and the
				// decision one code path each.
				if (now < windup.until) return;

				// **And one shape's hold is not over when its clock is.** `moveThenPlant` is *defined* by throwing
				// from a body that has come to a stop, so its release waits for that stop as well as for the clock:
				// the rig is still walking its carry-through, or decelerating out of it, and letting the ball go now
				// would make this shape identical to `moveAndAim` — the other seventy per cent of throws. The fact
				// is `NPC_ANIM_MOVING_ATTRIBUTE`, written by `NpcService.publishAnimation` *before* this behaviour
				// ticks from the two edges a rig's walk has — `Humanoid.Running` for the start and
				// `Humanoid.MoveToFinished` for the stop — so it is this turn's answer rather than a stale one, and
				// it is the same fact every client is already using to choose the rig's walk or idle clip, so the
				// rule reads as "the body waits to be seen standing before it throws". A body being *shoved* does
				// delay this, because the engine reports the speed the body actually moved at rather than a key:
				// the shove is motion, and the expiry timer below covers the frame where it never quite ends.
				//
				// **Nothing here can hold forever, which is what makes waiting safe.** The seek ends the walk on its
				// own — arrival, or its `PICKUP_WALK_SECONDS` window — and the expiry timer is armed to cover that
				// window as well as the hold (see `beginWindup`), so the shape that waits is the shape the timer
				// waits longest for. **The deadline is deliberately not extended**: it is what the charge was bought
				// with, and this is the release learning something a clock cannot know.
				if (windup.walk === "moveThenPlant" && model.GetAttribute(NPC_ANIM_MOVING_ATTRIBUTE) === true) return;
			} else {
				// **The hesitation, and it comes before the turn gate rather than after it.** Everything above
				// this line has established that a throw is *available*: a ball in the hand, a body to throw it
				// with, a target in range. That is the window, and this is the clock it opens — a rig does not act
				// on the first turn a throw exists. It waits `THROW_DECISION_SECONDS` and then decides, so a rig
				// that has just picked a ball up or caught one is seen to consider the throw instead of
				// converting it inside the same tenth of a second. See `NPC_CONFIG.THROW_DECISION_SECONDS` for why
				// the wait is here and not between throws, and for why a third of a second.
				//
				// **Armed once per window, and that is the whole of what makes it a decision rather than a
				// debounce.** The first turn that reaches here sets the deadline and returns; every later turn
				// reads it. A target that drops out of range for a turn and comes back does *not* re-arm it —
				// it went through the branch above, which neither clears this table nor adds to it — so a
				// flickering window cannot keep a rig from ever becoming ready, which is what a re-armed clock
				// would do. It is cleared on an empty hand, so the next ball starts a fresh hesitation: see the
				// `readyAt.delete` in the empty-hand branch above.
				//
				// **The angle is not part of the window**, which is why this is above the turn gate. The rig is
				// turning during the wait (the `aimAt` call above runs every turn), and the two delays overlap
				// rather than adding: a rig that has swung onto its target has already spent its hesitation, and a
				// rig that is still turning when the clock runs out throws the moment it is on target — which is
				// the old behaviour for a rig with nothing to hesitate about.
				const ready = readyAt.get(model);
				if (ready === undefined) {
					readyAt.set(model, now + NPC_CONFIG.THROW_DECISION_SECONDS);

					return;
				}

				if (now < ready) return;

				// Not yet facing it: keep turning, and do not throw. The angle was measured this tick from
				// the rig's current facing, so this is the *turn* being watched and not a fixed pose.
				if (math.abs(sighting.angle) > math.rad(NPC_CONFIG.THROW_ANGLE_DEGREES)) return;

				// **On target: the rig decides, and then holds for as long as the throw it decided on takes.**
				// This is the whole of the change — where the old code went straight on to the throw below, a
				// rig now solves its charge here and waits out the equivalent of a player's own hold, so that
				// the effect on its hand means what the same effect on a player's hand means. See `Windup` for
				// why that is the only honest way to display a charge, and `beginWindup` for the hold and the
				// published flag; the release is the code below, reached on a later turn.
				//
				// **And it decides, on the same turn, which of the three shapes this throw takes.** One draw,
				// here, because here is the only moment a throw exists to draw for: everything below the angle
				// gate is "there is a throw coming", and everything above it is a rig still turning or with
				// nothing to throw at. Drawing per tick instead would be a body that changed its mind during its
				// own hold — see `NPC_CONFIG.THROW_MOVE_AND_AIM_CHANCE` for the three shapes and the bands, and
				// {@link ThrowWalk} for what each one asks of the walk.
				//
				// **Two bands of one roll, and the order is the whole of the arithmetic.** The first band is the
				// share that throws on the move, the second the share that finishes its walk first, and whatever
				// is left is the shape that stops where it stands. Written as cumulative thresholds rather than as
				// two independent draws so the three shares are absolute and cannot overlap — and so asking for
				// more than all of them simply stops drawing the last shape rather than producing a negative one.
				const roll = math.random();
				const walk: ThrowWalk =
					roll < NPC_CONFIG.THROW_MOVE_AND_AIM_CHANCE
						? "moveAndAim"
						: roll < NPC_CONFIG.THROW_MOVE_AND_AIM_CHANCE + NPC_CONFIG.THROW_CARRY_THROUGH_CHANCE
							? "moveThenPlant"
							: "plantNow";

				beginWindup(model, rigBody.root, sighting.aimPoint, walk);

				return;
			}

			// **On target, and the hold is over: throw at the body.** The charge carries it to the target from the
			// muzzle the rig is facing along — solved on the turn that *decided* for the shape that stops there,
			// and on this turn for the two shapes whose body has walked since.
			//
			// **The aim constraint stays up, which reverses what this line did.** It used to come down here, on the
			// argument that "the ball leaves a body that has finished moving" — true, but only for the instant of
			// the release. What that cost was the follow-through: with the constraint gone, `AutoRotate` came back
			// on the same frame and a rig that threw while walking turned back to its walk direction *during* the
			// throw animation, so the arm went out of a body already facing somewhere else. Nothing here re-aims
			// it — the heading is the one written on this turn, and the body holds exactly that. See
			// `holdAimThroughThrow` for the window and for the timer that closes it if the rig stops being ticked.
			//
			// **The hold ends here through `endWindup` rather than through `cancelWindup`, because a throw is not a
			// cancellation.** The row and the published charge go exactly as a cancellation's do — see
			// `createWindupTracker`, where those two operations differ by one `print` — and the difference is the
			// line: a "cancelled" line above the throw line would describe the same event twice, and the throw line
			// below is this throw's report. **The shape is taken off the row first**, because `endWindup` is what
			// clears {@link THROW_WALK_ATTRIBUTE} and the branch below has to be chosen from the throw's own draw
			// rather than from an attribute that is now gone.
			const walk = windup.walk;

			// **The error this throw was rolled with, which is now the only thing the release has to look up.**
			// It was drawn on the turn the rig *decided* — see `createWindupTracker.beginWindup` — and it rides on
			// the row for exactly the two reasons the row exists: it has to survive `endWindup`, and it has to be
			// one throw's. Read here rather than re-rolled, because a second roll at the release would be a throw
			// whose charge and whose aim described two different mistakes.
			const miss = windup.miss;

			holdAimThroughThrow(model);
			windups.endWindup(model);

			// **And the point handed over is the only thing the miss touches.** `missedPoint` reapplies the offset
			// to the target's *current* position, which is the difference between a wide throw and a stale one: the
			// error is a fixed number of studs to one side, so the ball still leads a moving target — it is simply
			// a few studs off the line it would otherwise have taken. Applying the decision turn's absolute point
			// instead would send every wide throw at where the body *was*, which is a systematic short-or-long bias
			// and the one error a watcher can learn. The rig's own right is read off the body as it stands, so a rig
			// that has turned since deciding still misses to the side its body is on.
			//
			// **The facing above already used this same point** (see the `aimAt` call, which runs whether or not the
			// throw is a wide one), so the body is aimed at the error and the ball leaves for it — one point, drawn
			// once, used by the turn and by the throw. See `rollMiss` for why the miss is in the aim rather than in
			// the charge, and `NPC_CONFIG` for the numbers.
			const aimPoint = miss === undefined ? sighting.aimPoint : missedPoint(rigBody.root, sighting.aimPoint, miss);
			const release = aimOf(model, rigBody.root, aimPoint);

			// **A rig throws the ball the player throws — the same charge, the same arc, the same envelope. The
			// rig differs only in how it picks a target, in being allowed to miss, and in *when* it lets go.**
			// That is the whole of this block: a heading and a hold, handed to the one method both bodies throw
			// through, which is what makes a retune of `BALL_CONFIG` move a rig and a player together.
			//
			// **The hold is the one thing a rig works out rather than measures.** A player's charge is how long a
			// button was held; a rig has no button, so it has a *distance* and asks `chargeForRange` for the hold
			// that covers it. Same law read backwards — and backwards is the only direction a rig can read it in,
			// because the answer is exactly what a player's own hold would have been at that distance. The arc
			// word is gone with it: `overhead`/`straight`/`curve` named ways of *reaching a point*, which is the
			// axis the charge replaced, so there is no rig-only throw number left in this file.
			//
			// **Two charges, and the divide is not "moving or not" but "did this body walk at all".** `plantNow`
			// throws `windup.charge`, solved on the decision turn, because the hold it bought has to *be* that
			// charge's hold — recomputing would solve a fresh distance against a deadline the old one set, and then a
			// hold would last `charge × RIG_CHARGE_SECONDS` for no charge in particular. That shape can afford the
			// decision's figures for the reason it is a shape at all: the hold stops the body on the very turn the
			// charge was solved, so the two distances are the same one and the throw cannot land short. The price it
			// still pays is unchanged and still named: a rig *shoved*, or that dashes, between deciding and releasing
			// throws the charge for where it was.
			//
			// **The other two shapes have walked on purpose, so they solve again here.** `moveAndAim` walks through
			// the hold, and `moveThenPlant` walks its carry-through and then stops — either way the distance it
			// decided at is no longer the distance it is standing at, and the two differ by everything the body did
			// in between: at a rig's own walk, up to twenty studs, which is twice the widest deliberate miss in
			// `NPC_CONFIG`. Thrown anyway, every one of those throws would land long or short *in the same direction
			// every time* — and that is not the shape of a person's error, which is bad aim rather than a systematic
			// bias, so it is the one error a watcher could name and predict. The release's own figures are already in
			// hand: `release` is measured from the muzzle to the aimed point for the *heading*, in the same frame the
			// decision turn's solve used, so the charge it answers with is the charge for the throw about to happen.
			//
			// **What re-solving costs, and it is not nothing: the hold is no longer that charge's own hold.** Those
			// throws hold for the charge they decided with and release with the charge they ended up needing, so the
			// effect on the hand is a fraction of a beat off the ball — where `plantNow`'s is exact. Named rather
			// than discovered. The alternative was refused: re-solving *during* the hold would republish the charge
			// every turn, and a fire ball that visibly shrank as the rig walked closer is a rig adjusting its power,
			// which no player does and which the windup exists to make legible.
			//
			// See `aimOf` for the frame both figures come off.
			//
			// **A rig does not bend the ball, and that is the decision rather than a missing one.** `curve`
			// is a player's lateral control — one key, held or not — and a rig has no input of that kind. Its
			// error model is `rollMiss` instead, which moves the *aim* rather than the flight, and the two are
			// different throws: a bending ball arrives on the mark and a missed one does not. So `false` here
			// is the same `false` an untouched player sends, and the two bodies are doing one thing.
			// **The rig's pending ability, applied here because this is the throw that spends it.** A box
			// collected earlier wrote `PENDING_ABILITY_ATTRIBUTE`; Pierce and Freeze mark the ball in hand,
			// and MultiBall opens a window. Both are applied *before* the throw so the ball that leaves
			// carries them — and the slot is cleared *after* the throw, success or failure, because a refused
			// mark or throw that left the slot full would strand the rig with a prize it can never use. See
			// `BallService.markHeldBall` and `BallService.activateMultiBall`, which each re-check the slot on
			// their own access axis.
			const pending = pendingAbilityOn(model);
			if (pending === "MultiBall") {
				balls.activateMultiBall(model);
			} else if (pending !== undefined) {
				balls.markHeldBall(model, pending);
			}

			// **The one place the three shapes part company, and everything else about the throw is shared.** The
			// two that walked ask the same law the same question a moment later; the one that stopped where it stood
			// hands over the pair it decided with. All three are a *charge* and a *heading* — no arc, no rig-only
			// speed, no second throw — so a retune of `BALL_CONFIG` still moves a rig and a player together, which
			// is the property this whole block exists to keep.
			const walked = walk !== "plantNow";
			const charge = walked ? chargeForRange(release.distance, release.rise) : windup.charge;
			const solvedAt = walked ? release.distance : windup.distance;

			const thrown = balls.throwBall(model, {
				kind: "charged",
				heading: release.heading,
				charge,
				curve: false,
			});

			// **The slot empties on the throw, whatever the throw did.** The mark or the window above was
			// applied before `throwBall`, so the ball already carries it whether or not the throw was refused;
			// the slot is the *permission* and the throw is the *use*, and one use is all a box buys.
			if (pending !== undefined) model.SetAttribute(PENDING_ABILITY_ATTRIBUTE, "");

			// **Logged once, and only for a throw that actually left** — which is the difference between
			// one line per throw and a line per tick for a rig that cannot throw at all. `throwBall`
			// answers whether a ball went, and its refusals include a frozen body: a rig frozen with a
			// ball in hand reaches this line every tenth of a second, and a print from `rollMiss` would
			// have described thirty throws that never happened for the length of one freeze.
			//
			// **The line names the charge and the distance it was solved from, and those are the two numbers
			// that make the shared envelope checkable rather than asserted.** "The same throw" means the same
			// charge at the same distance; a reader with a player's `[Throw]` line and this one has both halves
			// of that comparison. Both figures come from the *same turn* — the decision's for the shape that throws
			// where it stands, the release's for the two that walked (see above) — so the pair always describes one
			// throw rather than a charge from one and a range from the other. `BallService` prints the solved
			// speed, the launch angle and the muzzle a moment later for both bodies, in its `[Ball]` line, so
			// nothing about the flight is repeated here. **And which of the three shapes it was is said out loud**,
			// in {@link ThrowWalk}'s own words, because that is the only way to count the mix from a log: the
			// attribute has already been cleared by the time this prints, and the three shapes are otherwise
			// indistinguishable from the outside.
			if (thrown) {
				const wide =
					miss === undefined
						? ""
						: `, ${string.format("%.1f", miss.studs)} studs to the ` +
							`${miss.side > 0 ? "right" : "left"} (missed on purpose)`;

				print(
					`[Rig] ${model.Name}: throw ${walk} — ` +
						`charge ${string.format("%.2f", charge)} at ` +
						`${string.format("%.1f", solvedAt)} studs, heading ` +
						`(${string.format("%.2f", release.heading.X)}, ${string.format("%.2f", release.heading.Y)}, ` +
						`${string.format("%.2f", release.heading.Z)})${wide}`,
				);
			}
		},

		// A rig killed mid-turn leaves a constraint on its root otherwise, and `RespawnBehavior`
		// replaces the whole model a moment later — so the turn would be left running on a body that
		// is about to be thrown away.
		//
		// **And a hold dies with the rig that was holding it.** This is the one hook a death reaches, and the
		// windup needs it for two reasons at once: a corpse is not winding up a throw, so the charge must come
		// off the body rather than sitting on it for the whole of `RESPAWN_DELAY_SECONDS` with a looping effect
		// welded to its hand — and the *row* has to go, because nothing will ever tick this rig again and a row
		// left behind would be a windup the replacement body never inherited. `RespawnBehavior` destroys the
		// corpse and builds a new body, so the state cannot follow the rig across the death either way; leaving
		// it is not a bug that corrects itself, it is one that shows until the body is replaced.
		onDied(model) {
			cancelWindup(model, "the rig died");
			clearAim(model);
		},

		/**
		 * **The tags were taken off with an aim still on the body** — `NpcBehavior.onStopped`, and the bug
		 * that hook was added for.
		 *
		 * `LobbyRigService.setGameplayBehaviors` strips this behaviour at every round boundary, and a rig that
		 * had a target in sight when the round ended keeps an `AlignOrientation` on its root plus the
		 * `AutoRotate = false` that went with it. Nothing calls this behaviour again, so nothing takes them
		 * off, and the body's facing stays locked to whatever it was last aiming at — which for a rig walking
		 * to its join pad in the intermission means **walking backwards**, moving toward the pad while held
		 * facing away from it. Reported 2026-10-18, "sometimes", which is exactly the set of rigs that had a
		 * target at that instant.
		 *
		 * **Silent, and the windup row is ended rather than cancelled.** The round-boundary line already says
		 * the tags came off, and `cancelWindup`'s vocabulary ("the rig died", "the target left the angle")
		 * would be a lie here — so its two published attributes are cleared straight through `endWindup` and
		 * no reason is printed for an event that has a better sentence somewhere else.
		 *
		 * `idle` is cleared too, so that the next round's first "holding a ball and not throwing" is reported
		 * again rather than being swallowed by a latch that was set before the last intermission. **`readyAt`
		 * goes for the same reason, one round further on:** a deadline spent in the last round is still in the
		 * table, so the rig's first throw of the new round would skip the hesitation it owes — and the round's
		 * first throw is the one a player is most likely to be standing in front of.
		 */
		onStopped(model) {
			windups.endWindup(model);
			idle.delete(model);
			readyAt.delete(model);
			clearAim(model);
		},
	};
}
