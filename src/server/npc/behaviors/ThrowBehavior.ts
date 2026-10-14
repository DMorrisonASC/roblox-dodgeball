import { BALL_CONFIG } from "shared/config/ball.config";
import { NPC_CONFIG } from "shared/config/npc.config";
import { CHARGING_ATTRIBUTE, PENDING_ABILITY_ATTRIBUTE } from "shared/constants";
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
 * cannot be looked at for five seconds is a hold that is not `charge × CHARGE_SECONDS`. So the pair shares this
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
}

/**
 * A rig holding a charge before it throws — **the delay that gives the throw something to display.**
 *
 * **A rig that fires in the same tick it decides has no charge to display. The windup is what makes the rig's
 * throw visible to a person watching the same way a player's hold is — and it is the only way a rig can show an
 * effect whose meaning is "this is being held".** A player's charge is a *duration*: the button is down for
 * `CHARGE_SECONDS` and the arm is visibly loaded for all of it. A rig has no button — it has a distance, and
 * `chargeForRange` answers which hold covers it — so the hold exists as a number and nothing else unless the rig
 * is made to *take* it. That is what this is: the rig decides, holds for exactly the time a player's hold of
 * that charge would have taken, and then releases. **The effect on its hand therefore means the same thing on
 * both bodies**, which is the whole property being bought; a rig playing a brief flash before an instant release
 * would be an effect whose meaning only held on one of the two.
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
	 * one, and then a rig's windup would no longer be `charge × CHARGE_SECONDS` for any charge in particular —
	 * which is the one thing acceptance rests on and the one property a reader can check. The price is stated
	 * with the fire path: a rig that is *shoved or dashes* mid-windup releases the charge for where it was.
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
 * A deliberate miss: how far off this throw is aimed, which way, and the point that produces.
 *
 * **Precomputed into a target rather than left as a vector and a description**, because the two readers of
 * it want different things — `throwBall` wants the point to solve to, and the log line wants the studs and
 * the side in the words a person reads — and deriving either from the other at the call site is how the
 * line and the ball would come to disagree about the same throw.
 */
interface Miss {
	/** How far off the aim is, in studs. Never zero — see `THROW_MISS_STUDS_MIN`. */
	readonly studs: number;

	/** Which way, in the rig's own terms: `1` is its right, `-1` its left. */
	readonly side: number;

	/** The point to aim at instead: the true target moved sideways by {@link Miss.studs}. */
	readonly target: Vector3;
}

/**
 * Rolls for this throw's aim: nothing at all when it is aimed true, or a point a few studs to one side.
 *
 * **A rig is fallible on purpose, and the miss is in the *release* rather than the posture.** The roll
 * happens here, at the moment the throw fires, and it offsets the *point the ball is solved to*: the rig
 * has already turned onto its true target and the aim constraint is already down (see the tick, which
 * calls this after `clearAim`), so the body stays pointed at the player it meant to hit and only the ball
 * goes wide. That is what reads as a misclick — a rig that turned *away* from its target instead would
 * read as one that cannot aim, which is a different and worse character. **The turn is deliberately
 * untouched by this function**: it is handed a point and returns a point, and nothing it does is visible
 * to `aimAt`.
 *
 * **The design the alternative would cost.** Every throw a rig makes is a solved shot to the target's
 * own position, so without a miss term a rig never misses at any range the angle gate passes — and a
 * round against something that cannot miss reads as an opponent rather than as a player. The user's
 * request was to "add some randomness to make them intentionally throw a few studs to the left or right,
 * to simulate real player misclicks"; this is that, and the numbers are in `NPC_CONFIG`.
 *
 * **Left and right are the rig's own.** The offset is along the flattened `RightVector`, so a rig facing
 * north that misses to its right sends the ball east. World-relative sides would have a rig facing east
 * missing "right" by throwing north, which is nobody's idea of a misclick.
 *
 * **One roll per throw, and the structure of the tick is what makes that true rather than a promise.** It
 * is called from the throw site and nowhere else, below every early return in the tick — a rig with no
 * ball, no body, no target or a target out of range never reaches it, and a rig still turning returns
 * before it — so the roll happens on exactly the tick that throws. The throw then empties the hand, so the
 * *next* tick returns at its first check and cannot roll for the same throw again. This behaviour runs ten
 * times a second; a roll per tick would be a ball that changed its mind on the way and a rig that read as
 * drunk rather than as human.
 *
 * **It does not print, and it does not know whether the throw lands.** `throwBall` answers whether a ball
 * actually left, and it refuses some attempts — a frozen body keeps its ball — so a line from in here
 * would be a line per tick for the whole of a freeze, describing throws that never happened. The caller
 * logs, once, and only for a throw that went. See the throw site.
 *
 * **The common case returns nothing**, so a rig that is not missing this time is throwing exactly what it
 * threw before any of this existed.
 */
function rollMiss(root: BasePart, aimPoint: Vector3): Miss | undefined {
	if (math.random() > NPC_CONFIG.THROW_MISS_CHANCE) return undefined;

	// The body's own right, flattened. A rig leaning on a slope has a `RightVector` with a Y component,
	// and keeping it would make the ball fly over the target rather than past it — which is a different
	// miss from the one asked for, and the only one this is not allowed to produce.
	const right = new Vector3(root.CFrame.RightVector.X, 0, root.CFrame.RightVector.Z);
	if (right.Magnitude < AIM_FLAT_EPSILON) return undefined;

	const studs =
		NPC_CONFIG.THROW_MISS_STUDS_MIN +
		math.random() * (NPC_CONFIG.THROW_MISS_STUDS_MAX - NPC_CONFIG.THROW_MISS_STUDS_MIN);

	// A coin flip for the side, so a rig is as likely to be wide one way as the other — the two-sided
	// error a person makes, rather than a habitual bias toward one shoulder.
	const side = math.random() < 0.5 ? -1 : 1;

	return { studs, side, target: aimPoint.add(right.Unit.mul(side * studs)) };
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

	/** Start a hold of `charge`, solved from `distance`. Publishes the rig as charging. */
	beginWindup: (model: Model, charge: number, distance: number) => void;

	/** The hold ended by *throwing*: the row and the published charge go, and nothing is printed. */
	endWindup: (model: Model) => void;

	/** The hold ended without a throw: the same two lines, plus one naming the reason. */
	cancelWindup: (model: Model, reason: string) => void;
}

/**
 * Builds one behaviour's windups — the table, the token counter, and the four operations above.
 *
 * **{@link WindupTracker.endWindup} and {@link WindupTracker.cancelWindup} clear the published charge, and they
 * are the only two things that do.** That is what makes every path that ends a hold one line rather than one line
 * plus a `SetAttribute` each, and it is why cancelling is safe to call for a rig with no hold at all — every path
 * can call it unconditionally rather than each having to know whether one ever started. The two are separate
 * because only one of them is news: a throw has its own line a few lines below, and a cancellation is a thing the
 * `[Rig]` output would otherwise never mention.
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
	 * **The duration is arithmetic rather than a constant** — `charge × CHARGE_SECONDS`, which is the same number
	 * a player's hold of that charge takes — so a rig winding up for a short throw holds briefly and one throwing
	 * across the arena holds for the full charge. That is the property the whole change rests on, and it is why
	 * there is no windup constant in any config: a number here would be a second way of saying how long a charge
	 * takes, free to disagree with the one a player's own arm obeys.
	 *
	 * **And the timer armed at the end is the only timer anywhere near a hold.** It is armed for the hold's own
	 * length plus a margin, and it does nothing at all in the ordinary case — the turn that releases the throw, or
	 * the turn that cancels it, has already taken this token out of the table by the time it looks. It exists for
	 * the case no turn can cover: a rig whose tags come off mid-hold stops being ticked, and without this its
	 * charge would stay published for the rest of the session. See {@link WINDUP_EXPIRY_SLACK_SECONDS}, which also
	 * argues why a timer that can only cancel cannot race the tick.
	 */
	const beginWindup = (model: Model, charge: number, distance: number): void => {
		const now = os.clock();
		const duration = charge * BALL_CONFIG.CHARGE_SECONDS;

		nextWindupToken += 1;
		const token = nextWindupToken;

		// The charge *and* the distance it came from, because the two are one throw's and the log line needs both
		// of them from the same turn. See {@link Windup.distance}.
		windups.set(model, { until: now + duration, charge, distance, token, lastTurnAt: now });

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

		print(
			`[Rig] ${model.Name}: winding up — charge ${string.format("%.2f", charge)} ` +
				`over ${string.format("%.2f", duration)}s`,
		);

		task.delay(duration + WINDUP_EXPIRY_SLACK_SECONDS, () => {
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
	const beginWindup = (model: Model, charge: number, distance: number): void =>
		windups.beginWindup(model, charge, distance);

	const cancelWindup = (model: Model, reason: string): void => windups.cancelWindup(model, reason);

	/**
	 * The line from the rig's hand to the point it is aiming at — {@link ThrowLine}'s arithmetic, called by the
	 * turn that *decides* to throw and by the turn that *releases* it.
	 *
	 * **Two callers and one function, because a windup measures the same throw twice.** The start needs the
	 * distance and the rise to solve the charge; the release needs the heading to aim with, from a hand that may
	 * have moved and a target that certainly has. Written twice, the two would be two chances for a charge and a
	 * heading to describe different throws — the same reason {@link ThrowLine} exists at all.
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
	 * Called on the three ways an aim can end — a throw, a lost target, and a death — and safe to call
	 * when there is no aim, so each of those paths can call it unconditionally rather than each having
	 * to know whether one was ever built.
	 */
	const clearAim = (model: Model): void => {
		const aim = aims.get(model);
		if (aim === undefined) return;

		aim.balance.Destroy();
		aim.attachment.Destroy();
		if (aim.humanoid) aim.humanoid.AutoRotate = aim.autoRotate;

		aims.delete(model);
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
			// **And a hold cannot survive it.** A rig whose ball left its hand mid-windup — a throw by another
			// path, a pickup it lost, a round boundary that destroyed the ball — is not winding anything up any
			// more, and a windup left standing would fire a ball that is not there and leave its charge published
			// on a body with an empty hand.
			if (!balls.getHeldBall(model)) {
				cancelWindup(model, "the ball left the hand");
				clearAim(model);

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
			aimAt(model, rigBody.root, sighting.aimPoint);

			const windup = windups.get(model);

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

				// Not yet facing it: keep turning, and do not release. The angle was measured this tick from
				// the rig's current facing, so this is the *turn* being watched and not a fixed pose.
				if (math.abs(sighting.angle) > math.rad(NPC_CONFIG.THROW_ANGLE_DEGREES)) {
					cancelWindup(model, "the target left the angle");

					return;
				}

				// **Still holding.** Everything that could end this hold early has been checked — the hand, the
				// sighting, the freeze, the angle — so what is left is the clock, and until it is up this turn has
				// nothing more to do. Returning here rather than falling through is what keeps the release and the
				// decision one code path each.
				if (now < windup.until) return;
			} else {
				// Not yet facing it: keep turning, and do not throw. The angle was measured this tick from
				// the rig's current facing, so this is the *turn* being watched and not a fixed pose.
				if (math.abs(sighting.angle) > math.rad(NPC_CONFIG.THROW_ANGLE_DEGREES)) return;

				// **On target: the rig decides, and then holds for as long as the throw it decided on takes.**
				// This is the whole of the change — where the old code went straight on to the throw below, a
				// rig now solves its charge here and waits out the equivalent of a player's own hold, so that
				// the effect on its hand means what the same effect on a player's hand means. See `Windup` for
				// why that is the only honest way to display a charge, and `beginWindup` for the hold and the
				// published flag; the release is the code below, reached on a later turn.
				const decision = aimOf(model, rigBody.root, sighting.aimPoint);
				beginWindup(model, chargeForRange(decision.distance, decision.rise), decision.distance);

				return;
			}

			// **On target, and the hold is over: stop turning and throw at the body.** The constraint comes down
			// before the throw so the ball leaves a body that has finished moving, and the charge — solved on the
			// turn that *decided*, not this one — carries it to the target from the muzzle the rig is now facing
			// along.
			//
			// **The hold ends here through `endWindup` rather than through `cancelWindup`, because a throw is not a
			// cancellation.** The row and the published charge go exactly as a cancellation's do — see
			// `createWindupTracker`, where those two operations differ by one `print` — and the difference is the
			// line: a "cancelled" line above the throw line would describe the same event twice, and the throw line
			// below is this throw's report.
			clearAim(model);
			windups.endWindup(model);

			// **And the point handed over is the only thing the miss touches.** `rollMiss` runs once per throw —
			// here, on the turn that actually releases it, which is the property its own doc rests on — and
			// answers either nothing, aim at the body, or a point a few studs to the rig's left or right. The rig
			// has finished turning onto the true target (see the `aimAt` call above, which ran whether or not this
			// throw was going to be a wide one, and which ran on every turn of the hold), so the body is aimed at
			// the player and only the ball goes somewhere else. See that function for the rule and `NPC_CONFIG`
			// for the numbers.
			const miss = rollMiss(rigBody.root, sighting.aimPoint);
			const aimPoint = miss?.target ?? sighting.aimPoint;
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
			// **`windup.charge` and `windup.distance` come from the decision turn, and that is the windup's
			// whole arithmetic.** The charge is solved once, where the rig decided, because the hold it bought
			// has to *be* that charge's hold — recomputing here would solve a fresh distance against a deadline
			// the old one set, and then a hold would last `charge × CHARGE_SECONDS` for no charge in particular.
			// The price is stated where it belongs: a rig that is shoved, or that dashes, between deciding and
			// releasing throws the charge for where it *was*. See `aimOf` for the frame the two figures come off,
			// which is the same one the solve will use a moment from now.
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

			const thrown = balls.throwBall(model, {
				kind: "charged",
				heading: release.heading,
				charge: windup.charge,
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
			// of that comparison. Both figures are the *decision turn's*, so the pair is one throw's rather than
			// a charge from one and a range from the other. `BallService` prints the solved speed, the launch
			// angle and the muzzle a moment later for both bodies, in its `[Ball]` line, so nothing about the
			// flight is repeated here.
			if (thrown) {
				const wide =
					miss === undefined
						? ""
						: `, ${string.format("%.1f", miss.studs)} studs to the ` +
							`${miss.side > 0 ? "right" : "left"} (missed on purpose)`;

				print(
					`[Rig] ${model.Name}: throw — charge ${string.format("%.2f", windup.charge)} at ` +
						`${string.format("%.1f", windup.distance)} studs, heading ` +
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
	};
}
