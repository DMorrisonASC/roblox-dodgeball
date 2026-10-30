import { OnStart } from "@flamework/core";
import { BaseComponent, Component } from "@flamework/components";
import { Players, Workspace } from "@rbxts/services";
import { abilityOn } from "shared/ability";
import { CollisionIgnore } from "shared/CollisionIgnore";
import {
	BALL_NAME,
	BALL_TAGGED_BODIES_ATTRIBUTE,
	BALL_TAGGED_TEAM_ATTRIBUTE,
	DUCKING_ATTRIBUTE,
	PRACTICE_ZONE_ATTRIBUTE,
	TEAM_ATTRIBUTE,
	THROWER_TOKEN,
} from "shared/constants";
import { isDuckExempt } from "shared/duck";
import { isPractising } from "../services/zone/practiceZoneMembership";
import { BALL_CONFIG } from "shared/config/ball.config";
import { DEBUG_CONFIG } from "shared/config/debug.config";
import { SOUND_CONFIG } from "shared/config/sound.config";
import { SUPER_CONFIG } from "shared/config/super.config";
import { logInfo } from "shared/logger";
import { BallService } from "../services/ball/BallService";
import { emitSound } from "../services/ball/SoundEmitter";
import { setBallLoose } from "../collision/CollisionGroups";
import { CatchService } from "../services/actions/CatchService";
import { FreezeService } from "../services/actions/FreezeService";
import { RoundService } from "../services/round/RoundService";
import { roundCelebrating } from "../services/round/roundStatus";
import { StatsService } from "../services/stats/StatsService";
import { SuperService } from "../services/super/SuperService";
import { BadgeService } from "../services/badges/BadgeService";
import { resolved as probeResolved, tagged as probeTagged } from "../dev/HitDisagreementProbe";

/**
 * The tag every dodgeball carries — **the same string as this component's own `tag: "Ball"`, which
 * is what puts this component on a ball at all.**
 *
 * Copied rather than shared for the reason the name is copied in `BallFactory`, `BallService` and
 * `BallPickupService`: the decorator's argument has to be a literal where Flamework's transformer
 * can read it, so the one place this cannot live is a shared constant. Written down here because
 * {@link isBall} has to recognise a ball *without* asking for its component — a part reported to
 * `Touched` may have no component on it at all, or one that has not started yet.
 */
const BALL_TAG = "Ball";

/**
 * TEMPORARY — **the catch trace, and this constant is the whole of its removal.**
 *
 * Set to `false`, or delete this block and its four call sites, once the log has been read. **A flag of its own
 * rather than `DEBUG_CONFIG.VERBOSE_LOGS`**, because that switch also turns on a per-frame aim report; this prints
 * only when a ball is refused, which is what a catch report needs to see and nothing else.
 *
 * **What it exists to separate.** A ball nobody could catch has four possible reasons, and from a log they are
 * indistinguishable: the throw was already over (`Armed` not true — the ball touched something that is not a body,
 * and the world branch disarms it), **it was the thrower's own ball**, the ball was not in the air, or nobody's
 * catch window was open when it arrived. The first two are by design, the others are timing, and the fix is
 * different in each case.
 */
const TRACE_CATCH = true;

/**
 * Whether `instance` is a dodgeball.
 *
 * **Both the tag and the name, because each answers a question the other cannot.** The tag is what
 * carries {@link BallComponent}, and `BallFactory.finish` puts it on every ball the game makes; the
 * name is what a ball is called in the log. A part with one and not the other is something assembled
 * by hand, and calling that a ball is the safe direction to be wrong in — it costs a throw, where
 * the other direction costs a body.
 *
 * **A ball inside a character is answered by this too, and that is the point.** A ball welded into
 * somebody's hand sits at the centre of the silhouette a throw is aimed at, so it is decided by the
 * same guard as any other ball rather than being left to the body branch — where `struckBodyPart`
 * would drop the contact and let the throw carry on. See {@link BallComponent.handleTouch}.
 */
function isBall(instance: Instance): boolean {
	return instance.HasTag(BALL_TAG) || instance.Name === BALL_NAME;
}

interface BallAttributes {
	/**
	 * Whether this ball is a live throw: in flight, or carrying bodies it has hit but not yet
	 * resolved.
	 *
	 * **True through a body, and false the moment the ball touches the world.** That is the rule a
	 * catch exists to serve: a hit's fate is not decided at the hit but at the ball's death, so the
	 * ball has to *stay* armed — still carrying the throw, still carrying its tags — until it hits
	 * something that is not a body. A body does not end a throw; the floor, a wall, or a prop, does.
	 * So does another ball, but only once this throw has somebody on it — see
	 * {@link BallComponent.handleTouch}, which is where that condition is decided. Disarming on a
	 * body would abandon the tags before they resolved, and a ball nobody had been told was dead
	 * would sit in the world with deaths still owed.
	 */
	Armed: Boolean;

	/**
	 * Whether this throw has already been scored. See {@link BallComponent.score}.
	 *
	 * On the ball rather than in here, because it is cleared by the same `Armed` transition that
	 * clears {@link BallComponent.hitModels} — the ball's own state, kept with the ball's own state.
	 */
	StatsRecorded: Boolean;
}

/** What an uncaught hit does. Lethal on purpose — a hit ends the round. */
const HIT_DAMAGE = 1000;

/**
 * How slow a ball may be and still be worth bouncing off somebody, in studs per second.
 *
 * A ball that arrived this slowly has no throw left in it to reflect, and reflecting a
 * near-zero velocity about a near-zero direction scatters it somewhere arbitrary — the one
 * thing a bounce must never be.
 */
const BOUNCE_MIN_SPEED = 1;

/**
 * How far a ball must be from the part it touched for the line between them to mean
 * anything, in studs.
 *
 * Below this the direction is float noise and the bounce is a coin toss.
 */
const BOUNCE_MIN_SEPARATION = 0.01;

/**
 * What an impact sound's emitter is called.
 *
 * Named because the emitter is a bare part in `Workspace` with nothing else to distinguish it:
 * invisible, tiny, and parented to the world at large rather than to anything that says what it is.
 * The way to check that none has been left behind is to search for one name, and that check is the
 * acceptance test for this whole arrangement — which is why the name lives per *event* rather than a
 * single name shared by every sound in the game. A catch names its emitter something else
 * (`CATCH_EMITTER_NAME`, in `BallService`), so that "no impact emitters remain" is a statement about
 * impacts. One per impact, each gone when its clip ends, so this is a name to grep for rather than a
 * taxonomy.
 *
 * The emitter itself is built by {@link emitSound}, which is shared with the catch sound and takes
 * this name as an argument.
 */
const IMPACT_EMITTER_NAME = "ImpactEmitter";

/**
 * The next number {@link BallComponent.identity} will take.
 *
 * **A counter, because nothing else on a ball distinguishes it.** Every ball in the game is named
 * `DodgeballBall`, so the name identifies nothing, and a clock is the wrong shape for this: `os.clock`
 * counts CPU time, which this codebase has already been caught by once — see the note in
 * `ThrowProbe.ts` about a stopwatch error that read as a physics fault — and `os.time` is whole
 * seconds, so two balls handed out inside the same second would share a number and the log would be
 * ambiguous again. A counter cannot collide, and an ordinal reads better in a log than a timestamp.
 */
let ballSequence = 0;

@Component({
	tag: "Ball",
	defaults: { Armed: false, StatsRecorded: false },
})
export class BallComponent extends BaseComponent<BallAttributes, BasePart> implements OnStart {
	/**
	 * Every body this ball has tagged on this throw, keyed on the model and holding the body part
	 * that decided the contact.
	 *
	 * **A tag list, not a hit list — that is the whole of this change.** Nothing in it is a death.
	 * The models in it have been struck, and their fate is still in the air: it resolves when the
	 * ball dies (on a world contact) and is released when the ball is caught. What the map buys is
	 * both halves of that future in one place — the model to resolve, and the part that was struck,
	 * kept so a deferred death can still say *where* the ball landed rather than only that it did.
	 *
	 * The key is what stops one throw taking the same body twice: the first part to arrive wins, and
	 * every part the engine reports after it is refused here.
	 *
	 * On the instance rather than on the ball as an attribute, because an attribute holds
	 * primitives and this holds models.
	 */
	private readonly hitModels = new Map<Model, BasePart>();

	/**
	 * Which ball this is, for the log — assigned the moment the ball is armed.
	 *
	 * **Every ball is named `DodgeballBall`, so a `logTouch` line without this cannot say which of
	 * them it came from** — and that is the entire question when a touch turns up that the ball could
	 * not physically have made. Attribution is the only thing this number is for; nothing decides
	 * anything with it, and it is never cleaned up, because the ball it describes goes away with it.
	 *
	 * **In practice it is an id per ball, not per throw.** `BallService` arms a ball on a hand-out and
	 * `throwBall` arms it again, but an attribute set to the value it already holds fires no signal —
	 * so {@link BallComponent.onStart}'s handler runs once, on the hand-out, and the id from that
	 * hand-out is the one the throw and the whole flight are reported under. It only moves on after a
	 * real disarm (a drop, or a pickup that makes the ball inert again), which is a genuinely
	 * different handing and worth a different number.
	 *
	 * 0 means the ball was never seen armed, which should not happen while anything prints.
	 */
	private identity = 0;

	constructor(
		private readonly catches: CatchService,
		private readonly balls: BallService,
		private readonly stats: StatsService,
		private readonly rounds: RoundService,
		private readonly abilities: SuperService,
		private readonly freezes: FreezeService,
		private readonly badges: BadgeService,
	) {
		super();
	}

	public onStart(): void {
		// **A ball that is not armed is litter, and it starts in the group that says so.** `Armed` defaults to
		// `false` in this component's decorator, so a spawner's ball, a practice ball and a ball sitting in the
		// place file are all in this case. `CollisionGroups.assignPart` already reaches the same answer when the
		// tag is added — it derives the group from this same attribute — and that is exactly why this line is
		// cheap rather than redundant: **the two run off one signal and nobody can say which is first.**
		// Whichever order they land in, both write the same group, and a ball is never briefly a trip hazard.
		//
		// **Read from the attribute rather than passed `true`, and that is not belt-and-braces.** A hand-out is
		// armed one line *after* the attach that creates this component (`BallService.giveBall` explains why it
		// has to be), so a hard-coded `true` here would be right only if `onStart` were guaranteed to run before
		// that write. Nothing in the typings promises it. Deriving the answer means this line is correct in
		// either order, and correct again if a future caller arms a ball at some other moment.
		//
		// See {@link setBallLoose} for what the group changes, and `LOOSE_BALL_GROUP` in `CollisionGroups` for why
		// this is a group rather than `CanCollide = false`.
		setBallLoose(this.instance, this.instance.GetAttribute("Armed") !== true);

		this.instance.Touched.Connect((otherPart) => {
			this.logTouch(otherPart);
			this.handleTouch(otherPart);
		});

		// **This ball joins the registry the eight-stud radius searches**, on `BallService`'s own table so a
		// `CatchService` proximity pass can find it without reaching for a Flamework component from outside. The
		// handler closes over this component, which is the only thing that knows whether this ball can be caught and
		// how to resolve the throw if it is. See `BallService.registerCatchHandler`.
		//
		// **Registered here and forgotten in the `Destroying` hook below**, because a destroyed ball must not stay in
		// the table: the map is keyed on the instance, and an instance held by a map is an instance that cannot be
		// collected — a leak that would grow for the whole session.
		this.balls.registerCatchHandler(this.instance, (catcher) => this.tryCatch(catcher, this.instance, "proximity"));

		// **The one case this file is otherwise silent about: a ball destroyed while it still owes a
		// death.** A ball that tags a body and never touches the world — wedged on something, or
		// simply never coming down — is destroyed with its tags unresolved, and until this line there
		// was nothing anywhere in the output to say so. From a player's seat that produces exactly
		// "the enemy didn't die and the round didn't end", which is the failure this hook exists to
		// tell apart from an intermission that is stuck.
		//
		// **On the component rather than in the expiry, and that is forced rather than chosen.** The
		// tag count lives here; the expiry is a free function in `ballExpiry.ts` that has never heard
		// of a component and cannot see one. So the destruction is hooked where the count is, which
		// also makes this the *superset*: every way a ball can be destroyed comes through here, not
		// only the timer — and for a diagnostic that is the right side to err on. The line names what
		// it knows and does not claim which of them it was.
		//
		// Ungated, unlike almost everything else here: it fires at most once per ball, and it firing
		// at all is the finding.
		this.instance.Destroying.Connect(() => {
			// **Out of the catch registry first, and unconditionally** — that map is keyed on the instance, so an entry
			// left behind holds a destroyed ball for the session. This runs before the early returns below because it is
			// cleanup rather than a diagnostic.
			this.balls.forgetCatchHandler(this.instance);

			if (this.instance.GetAttribute("Armed") !== true) return;
			if (this.hitModels.size() === 0) return;

			logInfo(
				`[Ball] ${this.instance.Name} #${this.identity}: destroyed still armed with ` +
					`${this.hitModels.size()} unresolved tag(s) — nobody was resolved`,
			);
		});

		// **The start of a throw, and the only moment this ball's memory is emptied.**
		//
		// `Armed` going *on* is the ball being released: `BallService` arms it in `throwBall`,
		// and again on a hand-out. That is precisely "a new throw", so the tag list is empty for
		// it by construction — which is what keeps one throw's tags from leaking into the next,
		// and what lets a ball taken off the floor tag the same players all over again.
		//
		// Nothing has to empty it while the ball is merely *held*, and that is why this is
		// not hooked to the hand instead: a ball in somebody's hand cannot damage anybody, so
		// a list sitting in it is unreadable, and the throw that follows clears it anyway.
		//
		// Keeping it here rather than having `BallService` call in also keeps the ball's own
		// state in the ball: no service has to know a tag list exists, or reach into a
		// component to reset one.
		this.instance.GetAttributeChangedSignal("Armed").Connect(() => {
			// **The one line in the game that decides whether a ball may stop a body, and it is here because this
			// signal is the only thing that fires on both transitions.** `Armed` going *off* is the ball being
			// spent — a landing at {@link resolveTags}'s world branch, or the pull that takes one out of the air —
			// and a spent ball on the floor must be walkable-over rather than a two-stud obstacle, which is the
			// report this answers. `Armed` going *on* is a new throw, which must be solid again or every throw
			// passes through everybody. Both are written by the same call because they are the same rule read
			// twice, and splitting them would be two places to get the pairing wrong.
			//
			// **Before the early return below, which is the whole of the placement argument.** That guard exists to
			// skip the *throw bookkeeping* — the tag list, the identity, the tagged team — none of which means
			// anything for a disarmed ball. This line is not bookkeeping: a ball that went from armed to spent is
			// exactly the transition that has to be handled, so it cannot sit below something that returns on it.
			setBallLoose(this.instance, this.instance.GetAttribute("Armed") !== true);

			if (this.instance.GetAttribute("Armed") !== true) return;

			// **A tag thrown away, said out loud, because this is the one way it can happen in
			// silence.** The clear below is right — a new throw owes nothing — but reaching it with a
			// non-empty list means a body was tagged on an earlier throw and never resolved, and that
			// body is now safe for good. Nothing else in the file can report it: the ball was not
			// destroyed (so `Destroying` stays silent), it did not die on the world (so `resolveTags`
			// never ran), and it was not caught (so `resolveCatch` never ran). Ungated on the
			// `Destroying` hook's terms — it fires only when there is something to report, and it
			// firing at all is the finding.
			if (this.hitModels.size() > 0) {
				logInfo(
					`[Ball] ${this.instance.Name} #${this.identity}: re-armed holding ` +
						`${this.hitModels.size()} unresolved tag(s) — nobody will be resolved`,
				);
			}

			// A new number to be reported under, taken at the same moment as everything else here
			// and for the same reason: `Armed` going on is a new throw. See {@link identity} for why
			// this usually happens once per ball rather than once per throw.
			ballSequence += 1;
			this.identity = ballSequence;

			this.hitModels.clear();

			// **And the tagged side goes with them**, because this is a new throw: a ball that kept the last
			// throw's label would show `CATCH IT!` to a side it has not hit yet, for a save that is not owed.
			// The two writes are one statement of state and always happen together — see
			// `BALL_TAGGED_TEAM_ATTRIBUTE`.
			this.instance.SetAttribute(BALL_TAGGED_TEAM_ATTRIBUTE, "");
			this.publishTaggedBodies();

			// And the throw is unscored again, for the same reason and at the same moment: `Armed`
			// going on *is* a new throw, and a new throw gets its own one contact. See {@link score}.
			this.instance.SetAttribute("StatsRecorded", false);
		});
	}

	/**
	 * What a touch means: a catch, a tag, or the death of the whole throw.
	 *
	 * The catcher is taken from the part's ancestry rather than from the players
	 * list. An NPC is a humanoid model like any other and has no `Player` behind
	 * it, so anything that asks "is this a player?" leaves NPCs unable to do what a
	 * player can.
	 *
	 * **A body does not decide anything — it is tagged, and the world ends the throw.** A hit's
	 * fate is not settled at the hit: real dodgeball lets a catch save the hit player, so a body
	 * the ball touches is *tagged* and nothing happens to it yet. The ball goes on flying, still
	 * armed, still carrying every tag — off the body it struck, unless the ball is a **Pierce** ball,
	 * which goes through it and on to the next one. See the tag branch below for what that difference
	 * takes, and why it is more than declining a bounce. It is the next contact that is not a body —
	 * the floor, a wall, a prop — that ends the throw and resolves every tag into a death. See
	 * {@link resolveTags}. And a catch before that moment releases every tag and never resolves a
	 * one: see {@link resolveCatch}.
	 *
	 * **Another ball is the third kind of contact, and which of the two it is depends on what the
	 * throw already owes.** A throw that has landed on nobody treats a ball as scenery and carries
	 * on, so it still reaches the body standing behind it. A throw that has already tagged somebody
	 * is ended by the next ball it touches, exactly as the floor would end it. See the guard at the
	 * top of this method, which is where both halves of that live.
	 */
	private handleTouch(otherPart: BasePart): void {
		// Spent already: a landing or a wall has taken this ball out of play — its tags were
		// resolved there, or there were none — and nothing below can put it back.
		if (this.instance.GetAttribute("Armed") !== true) {
			// TEMPORARY — remove with `TRACE_CATCH` once the log has been read. **This is the line that proves
			// whether a bounced ball is even eligible to be caught**, which is the whole question: a non-body
			// contact disarms the ball at the bottom of the world branch, and every later touch returns here, so
			// the catch branch below is unreachable. If this prints for a ball somebody was reaching for, the
			// answer is "the throw was already over" and nothing in the catch path is at fault.
			//
			// **And it only prints for somebody who was reaching, which is the second pass at it.** Ungated it was the
			// loudest line in the game by an order of magnitude — a spent ball rolling through a crowd of rigs prints
			// once per part per frame, forty lines a second forever — and a diagnostic that buries every other line is
			// answering a question nobody can now read the answer to. A spent ball touching somebody with *no* window
			// open is the ordinary case and says nothing; a spent ball touching somebody who is trying to catch it is
			// exactly the case worth printing.
			if (TRACE_CATCH) {
				const body = otherPart.FindFirstAncestorWhichIsA("Model");

				if (body !== undefined && this.catches.isCatching(body)) {
					const what =
						body.FindFirstChildWhichIsA("Humanoid") !== undefined ? `a body (${body.Name})` : otherPart.Name;

					logInfo(
						`[Catch] ${this.instance.Name}: NOT catchable — out of play (Armed not true), ` +
							`touch on ${what}`,
					);
				}
			}

			return;
		}

		// **Another dodgeball is the world only when this throw already owes somebody a death — and
		// that condition is the third version of this rule, reached by finding out what the first two
		// got wrong.**
		//
		// A ball in the world is a `BasePart` parented to `Workspace`, so nothing above it is a
		// `Model`. The first version treated that as a world contact outright, which ends the throw on
		// the first ball it meets. The second ignored ball contacts altogether, so a ball could never
		// spend a throw. **Both are right in one arrival and wrong in the other**, because the engine
		// reports an arrival as an unordered overlap set rather than a sequence — and a hand-held ball
		// sits in front of the chest, so a throw into a torso meets both:
		//
		// - **Body first, then a ball** — the body is tagged, and under the second version that tag sat
		//   waiting for the ball to come down. Whether it ever did is wherever the ball happened to
		//   roll, so a hit that visibly landed left the body standing.
		// - **Ball first, then the body** — and under the first version the throw was over before it
		//   touched anybody. Nothing was tagged, so nothing died, and aiming at the torso of anybody
		//   carrying a ball did nothing at all.
		//
		// **So the rule is conditional, and the condition is what the throw already owes.** A throw
		// that has landed on nobody treats a ball as scenery and carries on: the ball is an obstacle
		// the thrower never chose, and spending a throw on one before it reaches anybody spends it on
		// nothing. A throw that has landed on somebody is *finished* by the next ball it touches, which
		// resolves the tag there and then instead of leaving it hostage to where the ball finally comes
		// to rest. **Both orders then end the same way, and both end in a death.**
		//
		// The guard sits above the ancestry lookup rather than in the world branch below, and that is
		// load-bearing: a ball in somebody's hand has a `Model` above it, so it would otherwise be
		// answered as a body contact, dropped by `struckBodyPart`, and leave the throw carrying on
		// exactly as the second version did.
		//
		// **And the bounce that made a veto of this necessary is gone, in `CollisionGroups` rather than here.**
		// That file now writes `Ball` against `Ball` as non-collidable (§15 item 135), so a throw crossing another
		// ball is no longer *deflected* by it: what the row takes away is the engine's collision response, which is
		// the half no branch in this file could ever have taken away. Everything above was written while that
		// response was still happening, and it is kept for two reasons — it is the statement of what a ball contact
		// *means* to a throw, and it is what makes the row sufficient on its own.
		//
		// **What the row does not take away is the contact itself, and that is deliberate rather than an oversight.**
		// Collision and touch are separate switches in this engine — the same fact the duck's veto and the practice
		// zone's are built on, and the one `BallService.pierceBodies` states in the same words: *`CanTouch` exists
		// precisely because a non-colliding part still fires `Touched`*. So this branch is still expected to run,
		// once per ball the throw crosses, and it costs one `HasTag` and one `if` when it does.
		//
		// **What would prove the expectation wrong is in the log rather than in this comment.** If a Studio run
		// shows balls passing through each other *and* no `carried on past it` line for the crossing, then a group
		// does silence the contact and this guard has become dead code — the throw is still right either way, but
		// the two ball branches below would be unreachable and one of them (`isBall` in the world branch) is what
		// ends a throw that has already tagged somebody. That is the line to read before deleting anything.
		if (isBall(otherPart) && this.hitModels.size() === 0) {
			this.noteDecidedNothing(otherPart, "a ball, and this throw owes nobody — carried on past it");
			return;
		}

		const character = otherPart.FindFirstAncestorWhichIsA("Model");
		const humanoid = character?.FindFirstChildWhichIsA("Humanoid");

		// **A practice player is a body to this ball now, and this is where the rule used to veto them.**
		//
		// What stood here refused the contact outright — `in a practice zone — carried on past them` — and the
		// reasoning was sound for what it was for: the collision group stops the *bounce* (`PracticePlayer`
		// against `Ball` does not collide) but a group does not suppress `Touched`, so without a veto the ball
		// would sail through somebody in a practice zone and *tag* them on the way, which was the rule inverted
		// rather than enforced.
		//
		// **What that cost is the reason it is gone: a practice zone was a place to stand rather than a place to
		// practise.** A ball that cannot contact a body cannot be caught either — `canCatch` is only ever reached
		// from this funnel — so the one thing a person standing in a zone might want to work on, catching, was
		// the one thing the veto made impossible. And with no contact there was no impact sound, no impact
		// effect, and no evidence at all that a ball had arrived.
		//
		// **The kill moved instead of the contact, and the two are now separate questions.** Everything up to and
		// including the tag, the catch window, the sound and the impact effect happens exactly as it does
		// anywhere else; the health write is the single thing a practice zone suppresses, and it is suppressed
		// one layer down in `landHit` where `TakeDamage` actually happens. **A tag is not a death** — that is
		// what the deferral in this file is for — so tagging a practice player is simply the truth about a ball
		// that touched them, and a catch can still take it back.
		//
		// **The freeze that the group applies is unchanged, and it is why this is not a group change.** A
		// practice player's parts stay in `PracticePlayer` and so keep passing through balls rather than being
		// knocked about; what changed is only that the contact is now *noticed*. That is the same asymmetry the
		// duck relies on: the group stops the bounce, and the code decides what the contact means.

		// Not a character — or a ball, which reaches here only when this throw already has somebody on
		// it, and is then the throw's death like any wall. See the guard above for the whole rule.
		if (!character || !humanoid || isBall(otherPart)) {
			// **This is where every tagged body meets its fate, and it is the only place it could.**
			// The ball has stayed armed through every body it hit — see {@link BallAttributes.Armed}
			// for why — so "the ball stopped being armed" and "the tagged bodies are resolved" are the
			// same event, and this branch is it. A catch would have released them earlier and returned
			// above; reaching this line means nobody saved them.
			//
			// **The sound goes first, by the same rule as before.** Everything in this branch is an
			// account of one event — the ball arrived somewhere — so it runs in the order it
			// happened: heard, then resolved, then taken out of play. It plays for every world
			// contact rather than only for throws that wound up missing on purpose, because this *is*
			// the end of the throw: a ball that lands on the floor is the only evidence a player gets
			// that a throw is over, short of watching it all the way down.
			this.playImpactSound(otherPart, SOUND_CONFIG.WORLD_HIT);

			// **The end of a throw, and it was invisible until now.** This branch is the death of
			// every throw that does not end in a catch, and it used to leave no trace at all: the
			// sound is the only thing it announces, and the one line `emitSound` prints is behind
			// {@link DEBUG_CONFIG.VERBOSE_LOGS}, which is off by default and turns on a per-frame aim
			// report with it. So a throw that landed on the floor and a throw that was never fired
			// produced the same log — nothing — and that is the *first* question anybody asks of a hit
			// that did not register: did the ball arrive at all, and where.
			//
			// Named by part and counted, because the two facts are the answer: a landing short of the
			// body is an aim or a range problem, and one that arrived with nobody tagged is a contact
			// problem. The tag lines and this one are read against each other, which is why this is
			// ungated on `landHit`'s terms — a diagnostic that has to be switched on cannot explain a
			// log captured without it.
			//
			// **Exactly one line per throw, and the disarm below is what guarantees that.** `Armed`
			// goes off on the line after this, so the second contact of an arrival is refused at the
			// top of `handleTouch` like any other spent ball. A ball that is destroyed while still
			// armed is the one case that ends without this line, and it has its own.
			// **And the ball's ability, for the same reason the tag line above carries it.** A Freeze ball
			// that misses is the case where the *miss* splash below should fire, and whether it did is
			// otherwise a question about a line that says only where the ball stopped. Read once, here,
			// rather than at the branch below, so the line and the branch cannot disagree about it.
			const ability = abilityOn(this.instance);
			const labelled = ability === undefined ? "" : ` [${ability}]`;

			logInfo(
				`[Ball] ${this.instance.Name} #${this.identity}: ended on ${otherPart.Name} — ` +
					`${this.hitModels.size()} tag(s)${labelled}`,
			);

			// The thrower is still readable here: the world branch never made the ball inert, so
			// `ThrowerId` is whatever `throwBall` stamped on it. Read once, before the tags resolve,
			// because a resolution turns tags into deaths and a death is credited to this.
			const throwerId = this.instance.GetAttribute("ThrowerId");
			const taggedAny = this.hitModels.size() > 0;
			// `hitAny` is what `score` decides on, and it is narrower than `taggedAny`: a tag whose
			// body had already died is skipped by `resolveTags` and is not a hit. `taggedAny` stays
			// for the miss splash below, which asks whether the ball tagged anybody at all.
			const hitAny = this.resolveTags(throwerId);
			this.score(hitAny);

			// **A Freeze ball that arrived without tagging anybody splashes where it stopped**, and the
			// flag it asks is the one this branch already reads to count the throw: `taggedAny` was taken
			// before `resolveTags` emptied the list, and "did this throw land on a body" is exactly the
			// question a splash has to answer before it fires.
			//
			// **A ball that tagged somebody does not splash here**, because it splashed at that contact —
			// see the tag branch above. That is what keeps "a ball that hits two enemies" at two splashes
			// rather than three: the landing of a ball that hit somebody is the end of that event, not a
			// second one.
			//
			// The radius is the *miss* radius and the position is the ball's own, both of which are the
			// difference between a free hit and a throw that went somewhere it was not aimed.
			if (!taggedAny && ability === "Freeze") {
				// Where the ball stopped, which is where the burst is fired. See the tag branch above for why
				// it is the ball's own position rather than the position of whatever it came to rest on.
				this.freezes.freezeInRadius(
					this.instance.Position,
					SUPER_CONFIG.FREEZE_MISS_RADIUS,
					(model) => this.splashSpares(throwerId, model),
				);
			}

			// **The Pierce trail comes off here, because this is the throw's death.** The effect is a child of
			// the ball, so the ball's own destruction takes it — but an ordinary ball that has *landed* is not
			// destroyed, it lies on the floor until somebody collects it or it expires, and a particle
			// emitter on a stationary ball is a plume of trail sitting in the middle of the arena for as long
			// as that takes. (A MultiBall window's spent throw is the exception, and it is destroyed below.)
			// `BallTrail` refused to be an emitter for exactly this reason and named this branch as the honest
			// hook; see `BallService.detachPierceEffect` for the other two exits, and note this one is the only
			// place that knows the throw is over while the ball lives on.
			this.balls.detachPierceEffect(this.instance);

			this.instance.SetAttribute("Armed", false);

			// **And a throw the MultiBall window has finished with is *marked* for cleanup here, but not destroyed
			// here.** `BALL_DESPAWN_ON_LAND_ATTRIBUTE` says the throw spent itself; the destroy waits until the ball
			// is on the floor, and `BallService.settleLooseBalls` is what does it, poof included.
			//
			// **This line ends the throw, and that is not the end of the ball's fall — the difference was a report.**
			// A tagged throw can be finished by another *ball*: a rig holding one, a spent one underfoot. That makes
			// this branch run at chest height, a frame after the tag, with the thrown ball still in the air beside the
			// body it just hit — and a destroy here made it vanish on the model. The sweep asks `isOnGround` instead,
			// so the ball falls, lands, and goes with a poof.
			//
			// **And the tag is not the trigger either**, for the reason above it: a tag is not a death, and the ball
			// has a hit still owed until this branch resolves it.
			return;
		}

		// **A worn accessory is not a shield: the contact belongs to the body underneath it.**
		//
		// A hat's `Handle` sits inside the accessory, welded to the part it is worn on, and it is a
		// `BasePart` the ball reaches before it reaches anything that counts. Left as its own
		// thing — which is what this did until now — a player can wear something wide enough to
		// spend throws on: the ball is thrown off the accessory, no hit is ever recorded, and
		// whether that works is an asset property nobody in this codebase sets. So a worn part is
		// resolved to the body part it is attached to and handled as a contact with that part,
		// which makes an accessory invisible to the ball instead of armour for it. See
		// {@link struckBodyPart}.
		//
		// **This reverses the rule that used to be here, and the reason it existed is worth
		// keeping.** An earlier version treated an accessory *as itself*: a `Handle` is not a part of
		// the rig by any measure — it was not in the catchable set the config used to carry, and the
		// engine does not call it a limb either — so a scarf's tassel lying across the chest read as
		// a lethal hit, and the torso contact behind it — the one that would have caught the ball —
		// was then skipped by {@link hitModels}. The reply was to ignore accessory contacts
		// entirely, which fixed the scarf by making the accessory inert and turned it into a shield
		// in the same move. Resolving to the host part is the option neither of those took: the
		// scarf contact becomes an `UpperTorso` contact, which is a part of the body and so a
		// catchable one, so that case comes out right for the right reason. What remains is a hat
		// whose mesh reaches further from the head than the head is wide — a glance off a beanie is a
		// head contact, and lethal. That is the price of a hitbox a player cannot shrink by what they
		// choose to wear.
		const struck = this.struckBodyPart(humanoid, otherPart);
		if (!struck) {
			this.noteDecidedNothing(
				otherPart,
				"not a body part, and not traceable to one — nothing to tag",
			);
			return;
		}

		// Nobody is hurt by their own ball — including off the rebound, which is the case
		// that matters now that balls come off people — and the *catch* is offered
		// separately below. Both come down to the same string: the token stamped on the
		// ball at release, held against the token on the model it is touching. A player's
		// token is their `UserId` as text and an NPC's is a GUID, and this comparison
		// cannot tell them apart — which is the point. Asking "is this a player?" instead
		// would leave an NPC free to hit itself with its own throw.
		const throwerId = this.instance.GetAttribute("ThrowerId");
		const token = character.GetAttribute(THROWER_TOKEN);
		const ownThrow = typeIs(throwerId, "string") && throwerId !== "" && throwerId === token;

		// **A body cannot hurt itself with its own ball, and it *can* catch it — the two halves are now separate.**
		//
		// **What this line used to do, and why it changed.** It was one `return`, and its comment argued the case:
		// *"Nobody is hurt by their own ball, and nobody catches it either — including off the rebound."* That was
		// coherent when a rebound was only ever an accident. A playtest says otherwise: throwing at a rig and taking
		// your own ball back out of the air is the most satisfying thing the throw can do, and refusing it made the
		// bounce read as the game snatching the ball away. **So the rule is split rather than deleted** — the catch is
		// offered first and the damage is refused below, which is exactly the pair of sentences that were always meant.
		//
		// **The ordering is load-bearing.** `canCatch` is asked *before* anything else about this contact, so a thrower
		// with an open window takes the ball; a thrower without one falls through to the `return` and the ball passes
		// through them as it always did — no tag, no damage, no bounce. Falling through into the tag branch instead
		// would let a player kill themselves with the one ball the game promised they could not.
		//
		// **It also cannot be used as a shield.** A self-catch spends the window through `tryCatch` → `consume`, exactly
		// as any other catch does, so it costs the same second and catches the same one ball. See `CATCH_CONFIG`.
		//
		// **And this `return` is why the perfect-dodge watch filters by thrower.** A perfect dodge is measured from
		// the tag list, and this branch writes no tag — the whole point is that the contact did nothing. So a ball of
		// your own coming back past you is a contact the measurement cannot see at all, and a pass close enough to
		// count would be called a dodge if the watch did not know whose ball it was.
		// `DodgeService.watchForPerfectDodge` compares `ThrowerId` against this same `token` for exactly that
		// reason; the two files agree about "this ball is mine" by reading one string, and a change to either
		// comparison has to move with the other.
		if (ownThrow) {
			if (this.tryCatch(character, struck, "touch")) return;

			// TEMPORARY — remove with `TRACE_CATCH`. **The honest line for this branch now**: the ball came back to
			// its own thrower and nothing happened, because the window was not open. Before the split this was the
			// whole outcome and printed as a refusal; now it is only the case where the catch was not available.
			if (TRACE_CATCH) {
				logInfo(`[Catch] ${this.instance.Name}: own throw reached ${character.Name} — no window, no damage`);
			}

			return;
		}

		// **The catch comes first, and above the "already tagged" guard on purpose.** That guard is what makes
		// the first body part final for a throw; leaving it above this branch is what made a *tagged* body
		// unable to catch the ball it had just been hit by. The ball bounced off, the victim pressed catch, the
		// ball came back to them — and the contact was refused a line before the catch was ever considered. The
		// save this game advertises ("catch the rebound and nobody dies") was therefore available only to a body
		// the ball had *not* hit: every teammate, and never the victim.
		//
		// **Nothing is weakened by the move.** A catch spends the window, takes the ball out of the air and
		// releases every tag in one call — see `resolveCatch` — so the only thing an earlier-part catch could
		// disturb is the *same arrival* reporting more parts of the same body, and that cannot happen: a window
		// open at the first part would have caught the ball there. The guard below still refuses every later
		// part of a tag, so one tag per body per throw is exactly where it was.
		//
		// **A body can therefore catch a ball that has already tagged it, and that is the feature rather than a
		// loophole**: the throw is still in the air, the tag is still owed, and catching it is the save. See
		// `canCatch` for the refusals that remain — a Pierce ball, a Freeze ball, and a ball already in a hand.
		if (this.tryCatch(character, struck, "touch")) return;

		// **Decided already — or decided by an earlier part of this same arrival.** Either way
		// this body's turn has been taken and the ball passes through it.
		//
		// This is what makes the *first* part final: every part the engine reports after it is
		// refused here. It is also what stops one throw taking the same body twice.
		if (this.hitModels.has(character)) return;

		// **The first body part to arrive decides which body the contact is about, and nothing later may change
		// its mind.** The tag, the one-per-throw rule, and the fact that every part the engine reports
		// afterwards is refused above are all this rule.
		//
		// **It does not decide hit-versus-catch, and the catch above is not a part test at all.** Every part of
		// the body can catch — `struckBodyPart` has already resolved the contact to a limb — so the note that
		// used to stand here, arguing that a head reported first *had* to read as a hit, was describing the old
		// hand-written part list rather than this rule. What is left is what the rule was always for: bounding
		// one contact to one body.
		//
		// **The cost is the point of the parts change, and it is worth reading twice**: a catcher whose
		// window is open cannot be hit by an ordinary throw at all, wherever it lands on them. See
		// `canCatch` for the answers that remain.

		// **Friendly fire is off, and this is the one place that decides it.**
		//
		// A same-side contact is vetoed *entirely* — no bounce, no damage, no death, no record, no
		// points. It is one rule for every mode rather than a mode's own decision, because it is not
		// a rule about how a round is won; it is a rule about what a throw may do to a body at all,
		// and a mode that wanted friendly fire back would be changing the game rather than its own
		// rules. That is why this is here and not in `GameMode`.
		//
		// **Before `landHit`, and therefore before `TakeDamage` — that order is the contract.** The
		// veto has to be able to refuse the contact outright, and a check placed after the damage
		// would be describing a hit that has already happened: a `Died` already fired, the round's
		// hit record already written, and nothing left to take either back. So it sits ahead of the
		// bounce and the damage alike, and a teammate is simply not a body this ball interacts with.
		//
		// A catch is deliberately *not* covered: the catch branch above has already returned, so a
		// teammate may still catch a throw. Catching is a different mechanic from hurting somebody,
		// and this rule is only about hurting them.
		if (typeIs(throwerId, "string") && this.rounds.isFriendlyFire(throwerId, character)) {
			this.noteDecidedNothing(struck, "same side — vetoed, so no damage and no record");
			return;
		}

		// **A duck, and this is the veto half of a rule whose other half is a collision group.**
		//
		// A ducking body's head and arms have been moved into a group the ball does not collide with — see
		// `shared/duck.ts` for the parts and `CollisionGroups` for the row — so the ball *passes* rather
		// than bouncing off. **What the group does not do is suppress `Touched`**, which is the same engine
		// fact the practice-zone veto above relies on and the arena barrier is built on: this contact fires
		// anyway, and without this refusal the ball would pass *and* count.
		//
		// **The two halves are one rule, and neither is the mechanic on its own.** A veto with no group
		// leaves the ball visibly bouncing off a body the game says it missed; a group with no veto leaves
		// it passing and tagging. The note in `shared/duck.ts` says the same thing from the other end, and
		// they are deliberately written twice: a reader who finds one of them has found half a rule.
		//
		// **`struck` and not `otherPart`, and that is load-bearing.** `struckBodyPart` has already resolved
		// an accessory to the limb it is worn on and the root to the torso it is jointed to, so asking the
		// raw contact would let a hat's `Handle` be exempt while the head behind it was not. A ball into the
		// hips is a *torso* contact and is therefore a hit — which is the whole point of the parts list:
		// **a duck moves the head and the arms, and a low ball still hits.**
		//
		// **Placed beside the friendly-fire veto and before the tag**, because a tag written above could not
		// be taken back: the ball carries its tags until it dies, and a duck that starts *after* this contact
		// cannot save anybody. **A duck has to be up when the ball arrives.**
		if (character.GetAttribute(DUCKING_ATTRIBUTE) === true && isDuckExempt(humanoid, struck)) {
			if (DEBUG_CONFIG.VERBOSE_LOGS) {
				logInfo(`[Duck] ${character.Name}: ${struck.Name} exempted — the ball passed`);
			}

			return;
		}

		// **Heard here, which is after every reason this contact might not be a hit.** A catch returned
		// above, a friendly hit has just returned, and the ball's own thrower and a body it has already
		// been through were refused earlier still — so arriving at this line *is* the hit, and the
		// refusals above stay silent by construction rather than by a second check here.
		//
		// **The head is a limb, so the engine names it rather than this code matching on `"Head"`.**
		// `GetLimb` is what {@link isBodyPart} already asks, and for the reason it gives there: it
		// answers for R6 and R15 alike, and a hand-written name list would have to know both. It is
		// asked of `struck` rather than of `otherPart`, which is what makes the accessories change
		// carry through — a ball that struck a beanie was turned into a head contact by
		// {@link struckBodyPart}, so it is a head hit and sounds like one.
		//
		// `GetLimb` raises for a part that is not a direct child of the rig. Nothing can reach this
		// line without having passed `isBodyPart`, which is the test that established exactly that.
		const isHead = humanoid.GetLimb(struck) === Enum.Limb.Head;
		this.playImpactSound(struck, isHead ? SOUND_CONFIG.HEAD_HIT : SOUND_CONFIG.BODY_HIT);

		// **Tagged, not killed.** The ball has hit this body, and that is the whole of what happens
		// now: the body goes onto the tag list, and the ball carries on. No death, no point, no score —
		// all of those wait for the ball to die, which is the moment a catch can no longer save them.
		// Tagged before it leaves, so that every other part of this same arrival — and every later
		// contact with this body — is a body the ball has already tagged.
		this.hitModels.set(character, struck);

		// **The disagreement probe, and this is the frame the hit was *decided*.** The death is not until the
		// ball lands — a catch can still save every tag — so the two moments the probe prints are here and
		// `resolveTags`, and the distance between their two `body=` figures is the answer to "why did it hit me
		// after I moved". One line, gated on the verbose logs, and it changes nothing: see
		// `HitDisagreementProbe` for the four numbers and what each pattern of them means.
		probeTagged(character, struck, this.instance);

		// **And the side of the body that was tagged, published on the ball for the client's prompt.** The ball
		// now owes this body a death, and the only people who can take that back are the ones who may catch it —
		// the victim and their side — so the side is what a client needs to decide whether to draw `CATCH IT!`.
		//
		// **Nothing on the server reads it.** `canCatch` answers about the ball and the catcher's window and
		// never about the tag, so this attribute is a *publishing* fact only: it exists so that each client can
		// answer "is this mine to catch" without a remote and without a list of who has been hit.
		//
		// **Read from the right place per kind of body**, which is `npc/detect.ts`'s rule: a player's side lives
		// on the `Player` — the roster is player-keyed and a character is replaced on every death — while a
		// rig's lives on the rig itself. A body with no side at all (a practice player, a rig nobody has given a
		// team to) writes `""`, which is the prompt's off state, so a stale label can never outlive the tag.
		const taggedPlayer = Players.GetPlayerFromCharacter(character);
		const taggedTeam =
			taggedPlayer !== undefined
				? taggedPlayer.GetAttribute(TEAM_ATTRIBUTE)
				: character.GetAttribute(TEAM_ATTRIBUTE);

		this.instance.SetAttribute(BALL_TAGGED_TEAM_ATTRIBUTE, typeIs(taggedTeam, "string") ? taggedTeam : "");
		this.publishTaggedBodies();

		// **The other half of `landHit`'s line, and the half that was missing.** `landHit` reports a
		// death when the throw resolves; with no line saying a body was *tagged*, a throw that tagged
		// somebody and then never resolved is indistinguishable in the log from a throw that never
		// touched anybody — which is exactly the confusion this pair exists to end. Ungated for
		// `landHit`'s reason and on the same terms: it fires once per tagged body per throw, and the
		// two lines are meant to be read against each other.
		//
		// **The ball's ability is named on the line, and that is a third fact the same sentence has to
		// carry.** A ball-carried ability is read off the ball *at this moment* — it survives the throw,
		// see `BallService.throwBall` — so "the ball was a Freeze ball when it landed" is a fact about
		// this contact and not about the mark somebody saw while holding it. Without it here, a splash
		// that did not fire has two possible causes and no way to tell them apart: the ball carried no
		// ability by the time it arrived, or it carried one and the splash itself did nothing. The
		// bracket is empty for an ordinary ball, which is what most throws are.
		const ability = abilityOn(this.instance);
		const labelled = ability === undefined ? "" : ` [${ability}]`;

		logInfo(`${character.Name} was tagged by ${this.instance.Name} on ${struck.Name}${labelled}`);

		// **The splash, and it fires here rather than at the landing — which is the whole of what this
		// ability is.** The tag above is the direct hit, and it is deliberately nothing special: that body
		// dies when the ball lands, like any other hit, and no line here treats it differently. What the
		// ability adds is everything *around* it, frozen at the contact.
		//
		// **At the contact and not at the landing, which is not an implementation detail.** A splash that
		// waited for the ball to come down would be a different ability — one that arrives late, misses
		// anybody who walked away, and can be outrun. Freezing the room is supposed to be unavoidable once
		// the ball has touched somebody, so it happens on the touch.
		//
		// **This branch runs once per body, so a ball that tags two enemies splashes twice**, at each
		// impact point. The tag list is per body and so is this; nothing counts them.
		//
		// **The body just struck is inside its own radius and is not excluded from it.** Excluding it would
		// be exactly the "special handling for the direct hit" this ability does not have, and it changes
		// nothing about the outcome: that body is already tagged, and a tagged body dies when the ball lands
		// whether or not it was frozen on the way there.
		if (ability === "Freeze") {
			// **The struck part is the splash's centre, and it is the *first* part to arrive by
			// construction.** The `hitModels.has(character)` guard above returns for every later part of the
			// same body, so `struck` is the part the engine reported first — which is exactly what
			// `SUPER_CONFIG.FREEZE_HIT_RADIUS` promises ("from the body part a Freeze ball *struck*") and
			// what `HANDOFF.md` §11 says the ability does.
			//
			// **It used to be the ball's own centre, and both of the places the number is documented had
			// gone on saying "the struck part"** — so the code was the odd one out rather than the rule. The
			// argument for the ball was that a limb's centre is *inside* the limb, so the burst would fire
			// inside somebody's chest; the counter-argument is that the ball's centre at the contact is a
			// ball radius *outside* the skin, which is where nothing happened. **Inside the body is the
			// honest place for the shards to start** — they travel outward, so the effect reads as coming
			// out of the hit — and the cost of the change is bounded: the moved centre is at most a torso's
			// half-width, against an eight-stud radius, so the set of bodies caught is the same set.
			//
			// **The whole of the target list is `freezeInRadius`'s and not this branch's.** What is passed
			// here is a point, a radius and who may be spared; the service asks the *world*
			// (`Workspace:GetPartBoundsInRadius`), walks every part back to its model and freezes each body
			// once. That is why a Freeze ball that strikes a **rig** freezes the players and rigs around it
			// through exactly the same path as one that strikes a player — there is no player list and no
			// rig list here, and deliberately so. See that method for the argument, and `splashSpares` below
			// for the three rules that decide who is left alone.
			this.freezes.freezeInRadius(
				struck.Position,
				SUPER_CONFIG.FREEZE_HIT_RADIUS,
				(model) => this.splashSpares(throwerId, model),
			);
		}

		// **An ordinary ball comes off the body it hit; a Pierce ball goes through it.**
		//
		// **Declining `bounceOff` is not enough on its own, and that is the whole physics of this
		// ability.** A thrown ball is `CanCollide = true` and, while it is a threat, sits in the `Ball`
		// collision group (`BallService.throwBall` sets the flag; `setBallLoose` in `onStart` and in the
		// `Armed` handler above is what moves it into `LooseBall` once it is spent), every character is put
		// into `Character`, and `Ball` against `Character` is left at the engine's default, which is
		// *collides*. So the engine is deflecting the ball off this body whatever this
		// file does with velocities: `bounceOff` is an addition **on top of** a live contact rather than
		// the contact itself. `CollisionIgnore` is what takes the contact away — one
		// `NoCollisionConstraint` per part of this body, parented to the ball, so they die with the ball
		// *instance* and nothing has to be undone here. That file's own doc describes the job as exactly
		// this: solid against the world and everyone else, passing through the thing it was aimed at.
		//
		// **And `LooseBall` against `Character` being *off* does not do this job, which is worth saying
		// because it looks like it should.** A Pierce implementation that relied on the loose group would be
		// relying on the ball being spent, and the whole point of a Pierce throw is that it is not: it goes
		// through this body, still armed, and on to the next. The two rules coincide only after the throw is
		// over — a spent Pierce ball is indeed walkable-over — and that coincidence is a side effect of the
		// loose group rather than the mechanism of the ability.
		//
		// **The lifetime is the ball and not the throw, and that is a known rough edge rather than an
		// oversight — the prompt asked for "the rest of the flight" and this gives longer.** A ball that
		// lands is not destroyed: it lies there until it expires or somebody collects it, so these
		// constraints outlast the flight that needed them, and `attachToHand` does not remove them (it
		// clears the *ability* on the ball, which is a different thing). Pick a spent Pierce ball up and
		// throw it again and it is an ordinary ball that is still intangible to the one player it went
		// through — and whether that also means it never *tags* them again depends on whether a
		// `NoCollisionConstraint` suppresses `Touched` as well as the contact, which is engine behaviour
		// this file cannot read out of the typings. The fix, if this matters, is to keep the handles
		// `CollisionIgnore.between` returns and destroy them where `hitModels` is cleared — one array and
		// one line — rather than to change anything about the branch below.
		//
		// **Against this body, and this is a backstop rather than the rule.** The set-up that matters
		// happened at the throw, against every body in the world — see `BallService.throwBall` — so this
		// line is redundant and is kept only while that arrangement is being verified.
		//
		// **What it is *not* is where the teammate rule lives.** With every body constrained at the throw,
		// a teammate is a body a Pierce ball no longer collides with either — that is the rule now:
		// nothing alive stops a Pierce ball, so a teammate who wanders into the line cannot cancel
		// somebody's ability. A teammate is still not *hurt* by one: the friendly-fire veto returned above
		// this line, so there is no tag and no damage. That veto is about what a contact is *allowed to
		// do*, and this is about the ball's path — two rules that used to look like one.
		//
		// Not against the world, here or there: the wall still has to stop the ball, and the floor is what
		// ends the throw and resolves every tag.
		//
		// **What this deliberately does not do is fix the aim guide, and the gap is named here so that
		// nobody has to rediscover it.** `ThrowController` draws its arc from a `Trajectory`, which
		// breaks on the first thing its raycast finds and does not ignore other characters — so for a
		// Pierce ball the preview stops at the first body the real ball will pass straight through, and
		// the *target highlight* follows the same stopped arc. The preview lies about Pierce, and it is
		// known to. That fix belongs in `Trajectory` rather than here, because the guide is a
		// client-side simulation and this is the server's contact, and it is deferred to its own pass
		// rather than forgotten. **Do not "correct" this branch to make the picture agree with itself.**
		if (abilityOn(this.instance) === "Pierce") {
			CollisionIgnore.between(this.instance, character);
		} else {
			this.bounceOff(struck);
		}
	}

	/**
	 * Counts this throw as a hit, once, at the ball's death — if it landed on a living body.
	 *
	 * **One throw, at most one entry — whether any tagged body was still alive when the ball died
	 * decides it, and nothing later may change its mind.** That is not a tidiness rule, it is what
	 * makes the number mean what it says:
	 *
	 * - A single landing reports *every* part the ball overlaps, so without this a ball rolling to a
	 *   stop would be a dozen hits.
	 * - A ball that tagged three players and then hit the floor is one hit, not three. The throw
	 *   landed on somebody; where it came to rest afterwards is not a second throw.
	 * - A ball whose only tags are bodies that died while it was still in the air is no hit at all.
	 *   Striking a corpse gains nothing — the death is the thing the hit would have caused, and
	 *   another hand caused it first. This is also what makes one victim worth one hit across a
	 *   MultiBall volley: the first ball to resolve kills the body, and every later ball that tags
	 *   the same corpse resolves against a dead humanoid and adds nothing.
	 * - A ball that is caught is counted nowhere: the catch returns before the ball dies, so nothing
	 *   reaches here. The caught thrower's death is not this figure either — that is an out, and it
	 *   is counted by the round, which is the only thing that knows an elimination happened.
	 *
	 * **Nothing is counted when no living body was tagged, and that is the rule rather than an
	 * omission.** The record is hits against outs — outcomes, not throws — so a throw that lands on
	 * the floor is a throw with no entry, and there is no such figure as a miss to add one to. The
	 * flag below is still written either way: it means "this throw's accounting is done", which is
	 * worth being able to say whether or not the answer was a hit.
	 *
	 * **Taken at the death, not at the hit**, because a hit is no longer final — a catch can still
	 * take it back. `StatsRecorded` is cleared by the same `Armed` transition that clears the tag
	 * list, so a ball picked up and thrown again is scored all over again.
	 *
	 * The token is the ball's own `ThrowerId`, which is the only thing it knows about who threw it.
	 * Whether that names a person at all is `StatsService`'s question — a rig's token is a GUID and
	 * falls out there, which is what keeps NPCs out of the record.
	 */
	private score(hitAny: boolean): void {
		if (this.instance.GetAttribute("StatsRecorded") === true) return;

		this.instance.SetAttribute("StatsRecorded", true);

		// **A throw that hit nobody alive is a miss, and nothing is told about it.** This branch used
		// to report one to `SuperService`, which zeroed the thrower's run of hits. The count is "hits
		// since you last died" now and has no miss reset, so there is nothing on the other end of that
		// call — see `SuperService.noteHit` for what stood there and why it went.
		//
		// **`hitAny` is narrower than "tagged anybody", and the narrowing is the point.** A ball that
		// tagged a body which then died before this ball resolved has `hitAny` false: `resolveTags`
		// skipped the corpse, and a death that already happened by another hand is not this throw's to
		// claim. So the test is the same one `resolveTags` applied per body, reduced to "did any of
		// them pass" — and it is what stops a MultiBall volley scoring twice for one victim.
		//
		// **The branch itself stays, and it is load-bearing rather than a leftover.** What follows it is
		// the hit accounting, and that accounting does not re-test `hitAny` — so deleting this as the
		// empty branch it now looks like would record every miss as a hit and raise the thrower's count
		// for it. The `return` is the whole of what this does: a miss is a throw whose accounting is done,
		// which is what `StatsRecorded` above has just said, and that is the end of it.
		//
		// **A caught throw never reaches here at all** — the catch branch returns long before this — so a
		// throw that was caught is neither a hit nor a miss. It also used to end the thrower's run, by a
		// call of its own in `resolveCatch`; that call has gone with this one, so a caught throw leaves
		// the count alone in every mode. In Team Elimination and Dodge and Seek the thrower dies for it
		// and the count goes anyway; in Score Rush the thrower survives, and that is the one mode where
		// the difference is visible.
		if (!hitAny) return;

		const throwerToken = this.instance.GetAttribute("ThrowerId");
		if (!typeIs(throwerToken, "string") || throwerToken === "") return;

		this.stats.recordHit(throwerToken);

		// **The same fact, told to the thing that counts runs.** A second *reader* of one hit rather than
		// a second hit-detection path: the detection is the tag list, both notifications are driven by it,
		// and neither owns it. `StatsService` keeps a career total and `SuperService` keeps a run in a row
		// — different questions about one event, which is why they are handed the same token rather than
		// one being worked out from the other.
		//
		// **And the run is gated here rather than inside `noteHit`, because the gate is a round fact and the
		// round owns it.** The thrower is resolved through `throwerOf` — a `Player` for any account, or a rig
		// only while it is in the round — and the run only moves when that body is *in this round*: a player
		// in `activePlayers`, a rig on a side during `Playing`. A practice hit therefore records a career hit
		// (above) but never a run, and the crown cannot grow out of one. `noteHit` takes the resolved body
		// and no longer asks the phase itself — the participation gate subsumes it.
		const thrower = this.rounds.throwerOf(throwerToken);
		if (thrower !== undefined && this.rounds.isActive(thrower)) {
			this.abilities.noteHit(thrower);
		}
	}

	/**
	 * Throws the ball off a body it has just hit.
	 *
	 * **Not the engine's elasticity.** That acts off everything at a strength decided by
	 * the two materials meeting, so it cannot be told "spring off people, thud off walls" —
	 * a bouncy ball bounces off the floor and the walls too, which is the opposite of what
	 * the rest of this game wants. This is the same reflection done by hand, for bodies
	 * only, so the bounce has one strength and the rest of the world stays as dead as it
	 * was.
	 *
	 * The direction is the line from the part that was touched to the ball's own centre,
	 * which is the best stand-in available: `Touched` carries no geometry, and a body is not
	 * a flat wall to take a normal from. What it produces is a **deflection** rather than a
	 * mirror bounce — a ball clipping a shoulder is sent off to one side, and a ball
	 * arriving dead centre comes back the way it came.
	 */
	private bounceOff(otherPart: BasePart): void {
		const velocity = this.instance.AssemblyLinearVelocity;
		if (velocity.Magnitude < BOUNCE_MIN_SPEED) return;

		const separation = this.instance.Position.sub(otherPart.Position);
		if (separation.Magnitude < BOUNCE_MIN_SEPARATION) return;

		const normal = separation.Unit;
		const reflected = velocity.sub(normal.mul(2 * velocity.Dot(normal)));

		this.instance.AssemblyLinearVelocity = reflected.mul(BALL_CONFIG.BOUNCE_FACTOR);
	}

	/**
	 * **Publishes the tag list as a name list**, which is the only form another service can read.
	 *
	 * **Why the list is published at all, when nothing on this side reads it.** A ball's tags are the record of
	 * which bodies this throw has already struck, and one reader needs exactly that question answered about a
	 * *particular* body: `DodgeService.watchForPerfectDodge`, which reports a near miss as a perfect dodge and
	 * must not report one for a body this ball already hit. That watch opens when a dash starts, so a ball that
	 * tagged the body a moment *before* that instant is invisible to every geometric test it can run afterwards
	 * — the body has dashed away, and the ball is several studs from where it stood. The log that proves it:
	 * tagged at `20:15:30.512`, `perfect dodge` reported against the same body at `20:15:30.793`.
	 *
	 * **Called beside every mutation of {@link hitModels}**, so the attribute and the list are one fact and
	 * cannot drift. The team attribute is written at the same moments for the same reason; see
	 * `BALL_TAGGED_BODIES_ATTRIBUTE`, which is where the two questions are told apart.
	 *
	 * **`|`-joined**, the shape `OWNED_ITEMS_ATTRIBUTE` already uses for "a set in one string", because an
	 * attribute cannot carry a table. Empty rather than removed when the list is empty, on the same
	 * one-empty-value convention as every other attribute here.
	 */
	private publishTaggedBodies(): void {
		const names = new Array<string>();

		for (const entry of this.hitModels) names.push(entry[0].Name);

		this.instance.SetAttribute(BALL_TAGGED_BODIES_ATTRIBUTE, names.join("|"));
	}

	/**
	 * Takes a tagged character out, and prints which part decided that.
	 *
	 * **Called at the ball's death, not at the hit.** A hit only tags; the death happens when the
	 * ball lands on the world and every tag resolves — see {@link resolveTags} — so this runs then,
	 * once per tagged body, in the order the ball tagged them. Nothing about the *method* changed
	 * with the deferral: it is still "take this humanoid out now", and the damage below still fires
	 * the `Died` that reaches `RoundService.handleDeath`.
	 *
	 * The print is the rule made visible: it says which tagged body is being resolved, on which
	 * part, at the moment it happens. The tag itself was silent, and this line is where the throw's
	 * outcome becomes a fact instead of a possibility.
	 *
	 * ## The practice zone stops here, and this is the only place it can
	 *
	 * **A practising player is tagged, reported and then left alive** — the damage is the one line a practice zone
	 * suppresses, and it is suppressed at the single place the game writes throw damage. That is why the contact
	 * itself is no longer vetoed in `handleTouch`: a ball that cannot touch a body cannot be caught or heard, so the
	 * veto was suppressing the wrong half. **Everything above this line has already happened** — the tag, the impact
	 * sound at the contact, `registerHit`'s `hitImpact` for every client — so the person practising sees and hears the
	 * hit and simply does not die of it.
	 *
	 * **A rig is deliberately not spared**, in a practice zone or anywhere else: `isPractising` answers only for a
	 * `Player`, because the request was about a person practising and a zone that silently made every NPC in it
	 * immortal would be a second rule nobody asked for. A drill's ball that misses its player and lands on a rig
	 * still kills that rig, which is what keeps "no kills in the zone" from meaning "no consequences anywhere".
	 *
	 * **The line still prints when the health is spared**, and that is not noise: `was hit by … on …` is the record
	 * that the contact happened, and a hit that silently did nothing would be indistinguishable from a ball that
	 * missed. The spare gets its own line beside it, so a reader can tell "no damage because practice" from "no
	 * damage because the tag never resolved".
	 */
	private landHit(character: Model, humanoid: Humanoid, part: BasePart): void {
		// Gated where the rest of this file's output is not: this is one line per hit, and it is
		// worth reading only while tuning what a contact is worth.
		if (DEBUG_CONFIG.VERBOSE_LOGS) logInfo(`[Ball] ${character.Name}: hit on ${part.Name}`);
		logInfo(humanoid.Name + " was hit by " + this.instance.Name + " on " + part.Name);

		// **The one gate, and it wraps the health write rather than the hit.** `TakeDamage` is what fires `Died`,
		// which is what reaches `RoundService.handleDeath` — so this single refusal is the whole of "no kills in a
		// practice zone" on the ball's path, and it sits here rather than earlier because everything before it is
		// the record of a contact that really did happen.
		if (isPractising(character)) {
			logInfo(`[Ball] ${character.Name}: health spared — practising, so this tag does no damage`);

			return;
		}

		// **And a decided round spares everybody, practising or not.** A ball already in the air when the whistle
		// went can land ten seconds later, and `ARENA_CONFIG.CELEBRATION_SECONDS` is the window in which a
		// player has been told the result and is being left alone to read it — so a death in it is a death the
		// round cannot explain and does not count (the phase is `Intermission`, so `handleDeath` returns after
		// handing the body straight back). Refusing here rather than at the tag is the same choice the practice
		// zone made and for the same argument: everything above this line already happened, so the contact is
		// still reported, still sounds, and still draws its impact — the body simply survives it.
		//
		// **It sits beside the practice refusal rather than inside it**, because the two are different
		// exemptions that happen to meet here: one is about *where* a body is, the other about *when*. Folding
		// them into one test would leave the next reader unable to tell which of the two spared a given hit.
		if (roundCelebrating()) {
			logInfo(`[Ball] ${character.Name}: health spared — the round is celebrating`);

			return;
		}

		humanoid.TakeDamage(HIT_DAMAGE);
	}

	/**
	 * Resolves every tagged body into a death, credited to the thrower.
	 *
	 * Called from the world branch, which is the ball's death: this is the moment the tags stop
	 * being possibilities and become the throw's outcome. One death per tagged body, in the order
	 * the ball tagged them, and each death is the same pair a live hit used to run — the round told
	 * about the hit, then the body damaged — in the same order, for the same reason: the damage can
	 * fire `Died` synchronously and take the victim out of the round, so the notification goes
	 * first.
	 *
	 * **A tag whose body is already gone is skipped, not resolved.** A tagged model may have died of
	 * something else while this ball was still in the air — another throw, a reset — and a death
	 * that has already happened cannot be caused a second time. `registerHit` carries the same guard
	 * inside it for the scoring half; the humanoid check here is the damage half of the same rule.
	 *
	 * The list is emptied after the loop rather than during it, so nothing reads a half-resolved
	 * throw.
	 */
	private resolveTags(throwerId: unknown): boolean {
		// **What question this answers:** whether the ball died on the world at all, and with how
		// many tags owed. `landHit` below already prints one line per body it resolves, so this adds
		// only the count — and, more importantly, the case of *zero*, where the method ran and had
		// nothing to do. A throw that resolves nothing prints this and then no `was hit by` lines,
		// which is a different story from a throw that never reached here.
		if (DEBUG_CONFIG.VERBOSE_LOGS) {
			logInfo(
				`[Ball] ${this.instance.Name} #${this.identity}: died on the world — ` +
					`resolving ${this.hitModels.size()} tag(s)`,
			);
		}

		const token = typeIs(throwerId, "string") ? throwerId : "";

		// **The answer this returns: did any tag resolve into a hit.** A tag whose body is already
		// dead is skipped — see the doc above — and a throw whose only tags are corpses is not a hit
		// at all: striking a body that has already died gains nothing, because the death is what the
		// hit would have caused and another hand caused it first. Tracked here rather than re-derived
		// by `score`, because this loop is the only place that reads the humanoid's health, and the
		// answer is gone once the list is cleared below.
		let hitAny = false;

		for (const [model, part] of this.hitModels) {
			const humanoid = model.FindFirstChildWhichIsA("Humanoid");
			if (!humanoid || humanoid.Health <= 0) continue;

			hitAny = true;

			// The tag became a death on the next two lines, so this is the second half of the probe's pair:
			// where the body is *now*, against where it was when the contact was decided. Nothing is changed
			// by it — see `HitDisagreementProbe` — and it sits above the comment below because that comment is
			// about the two calls this one must not separate.
			probeResolved(model, this.instance);

			// **The ability goes with the hit, because nothing can be asked about it afterwards.** A mark rides
			// the *ball*, and by the time a client reacts to the impact this instance may already be gone — so
			// the word is read here, once per body, and travels on the event. A Pierce ball's three bodies all
			// name Pierce, which is what the splash counts.
			if (token !== "") this.rounds.registerHit(token, model, abilityOn(this.instance) ?? "");
			this.landHit(model, humanoid, part);
		}

		this.hitModels.clear();

		// **The tags are deaths now, so the prompt's subject is gone.** `landHit` has already run for every body
		// above, and a ball that has resolved its throw has nothing left to catch — the next thing that happens
		// to it is `Armed = false` on the line below the caller. Clearing here as well as on the re-arm is what
		// keeps the property honest between those two moments, when the ball is still in the world for a frame.
		this.instance.SetAttribute(BALL_TAGGED_TEAM_ATTRIBUTE, "");
		this.publishTaggedBodies();

		return hitAny;
	}

	/**
	 * Resolves a catch: every tag released, and the thrower punished if the catcher is their enemy.
	 *
	 * **Three jobs, in this order, and the first is the absence of a death.** A catch saves every
	 * body the ball tagged — so the tag list is emptied here rather than resolved, and that
	 * emptying is the whole of the save; nothing fires, and a log of the throw would otherwise show
	 * no trace of it. Then the thrower is out if the catcher is on the other side, and the catcher's
	 * side scores if the mode keeps score — both decided by the round, which owns sides and score,
	 * in one call: see `RoundService.resolveCaughtThrower`. A friendly catch does neither, and a
	 * catch of a rig's throw does neither, for the reasons that method gives.
	 *
	 * **There used to be a fourth job here: ending the thrower's run of hits.** A caught throw is a throw
	 * that did not land, and the run used to be broken by anything that did not land — so this was the
	 * line that ended it in the one mode that does *not* kill the thrower for being caught, which is Score
	 * Rush. The count has no miss reset any more and a caught throw is not special, so there is nothing to
	 * report and nothing replaced it. See `BallComponent.score` for the other end of the same removal.
	 *
	 * **A catch that cannot be made never reaches here.** `handleTouch` only calls this after
	 * `catchBall` has accepted the catch — which since the pull means "the ball is on its way into
	 * the catcher's hand or is already in it", because the only refusal that answers `false` is a
	 * body with no right hand. Either way the decision behind the save below is a fact and not a
	 * hope.
	 */
	private resolveCatch(catcher: Model, throwerId: unknown): void {
		// **What question this answers:** whether the ball was caught rather than landing — the third
		// way a throw can end, and the one that resolves nobody *on purpose*. The release below is
		// silent in normal play because silence is the feature: a catch is a save, and the bodies it
		// saves are the ones nothing happens to. Printed before the clear, so the count is the number
		// of tags actually released rather than the zero it leaves behind.
		if (DEBUG_CONFIG.VERBOSE_LOGS) {
			logInfo(
				`[Ball] ${this.instance.Name} #${this.identity}: caught by ${catcher.Name} — ` +
					`releasing ${this.hitModels.size()} tag(s)`,
			);
		}

		this.hitModels.clear();

		// **And the prompt goes with the release, because the save has already happened.** This is the one clear
		// that runs while the ball is still alive and about to be carried in a hand: a `CATCH IT!` left on it
		// would be advertising a catch that has just been made, to a side whose teammate may now be holding the
		// ball. Both writes are one statement of state — see `BALL_TAGGED_TEAM_ATTRIBUTE`.
		this.instance.SetAttribute(BALL_TAGGED_TEAM_ATTRIBUTE, "");
		this.publishTaggedBodies();

		const token = typeIs(throwerId, "string") ? throwerId : "";
		if (token !== "") this.rounds.resolveCaughtThrower(token, catcher);

		// **The run of hits used to end here, and no line replaced it.** A caught throw is still a throw
		// that landed on nobody, but the count is not broken by one any more — it is "hits since you last
		// died" — so a catch cannot touch it. In Team Elimination and Dodge and Seek the thrower dies for
		// the catch and the count goes through `noteDeath` anyway; in Score Rush the thrower survives and
		// keeps it, which is the one place this removal is visible. See `SuperService.noteHit` for what
		// the count is now and why nothing ends it but a death.
	}

	/**
	 * Whether this touch is a catch: **any part of the body**, on a character whose window is open.
	 *
	 * **"Any part of the body" is a rule rather than a list, and it is `struckBodyPart`'s answer.** What
	 * arrives here is never the part the engine reported — it is what that method resolved the contact to,
	 * which is always a part `Humanoid.GetLimb` recognises as a limb of this rig. So the exclusion of the
	 * head and the legs used to be the *only* thing the part test did, and deleting it is the whole of
	 * "every part of the body can catch". See the test's own note, below the ability refusals.
	 *
	 * **A Pierce ball cannot be caught, and refusing here — before the weld — is the whole of what that
	 * costs.**
	 *
	 * The catch branch is `if (canCatch) { …; return; }`, so answering `false` falls through to the
	 * friendly-fire veto and then to the tag branch: **the catcher is tagged like any other body and
	 * dies when the ball lands.** A Pierce ball is not *harmless* to somebody who tries to catch it; it
	 * is unblockable by them. That is the intent — the answer to a super is to move, not to stand there
	 * with your hands out.
	 *
	 * **The refusal has to sit above the pull rather than after it**, and that is not just tidiness:
	 * the weld at the end of a pull runs `attachToHand`, which *clears* the ball's ability so that a ball
	 * arriving in a hand is an ordinary ball again. A catch allowed as far as the hand would therefore erase
	 * the very marker that made it illegal, and the ball would leave the catcher's hand a normal ball — the
	 * ability would have been cancelled by the thing it was supposed to defeat. Now that the ball spends a
	 * moment in flight before the weld, the same argument says the refusal must be decided on the contact
	 * rather than watched for during the pull: a ball already travelling to a hand has been promised it.
	 *
	 * **What is not done on the refusing path is `catches.consume(character)`**, which the catch branch
	 * would have done. That is deliberate: a catcher's window is an attempt, and an attempt that was
	 * never allowed to happen should not be spent — so a Pierce ball does not also leave them unable to
	 * catch the next ordinary one.
	 *
	 * **A Freeze ball cannot be caught either, and the reason is timing rather than symmetry.** The
	 * ability's whole effect lands at the *contact* — the splash fires there, before the ball has finished
	 * flying — so a catch would be a save against the wrong moment: by the time a window could have
	 * mattered, the thing it might have prevented has already happened to everybody standing around. And
	 * letting it be caught would hand the catcher a ball whose effect they were just inside the radius
	 * of, which is not a save, it is a reward for standing where the splash was.
	 */
	private canCatch(otherPart: BasePart, character: Model): boolean {
		// **Asked before the part test, not after it**, because this is an answer about the whole
		// contact rather than about one part of it: a Pierce ball is un-catchable by any part, so there
		// is nothing to learn from whether the part it happened to touch first was a catchable one.
		//
		// **Said out loud, because the refusal is otherwise invisible.** A catcher who fails to catch
		// produces the same log as one who never tried, and the two are completely different faults, so
		// this goes through the same ungated helper the friendly-fire veto uses. Its own doc explains
		// why it is not behind a flag: a diagnostic that has to be switched on cannot explain a log that
		// was captured without it.
		if (abilityOn(this.instance) === "Pierce") {
			this.noteDecidedNothing(otherPart, "a Pierce ball — this body cannot catch it");

			return false;
		}

		// The third ability's refusal, and a peer of the one above rather than a special case of it: what
		// makes a ball un-catchable is the ability on it, and each ability gives its own reason here. See
		// the doc above for the timing argument this one is making.
		if (abilityOn(this.instance) === "Freeze") {
			this.noteDecidedNothing(otherPart, "a Freeze ball — this body cannot catch it");

			return false;
		}

		// **Where the part test used to be, and there is no replacement — that absence is the change.** What
		// stood here asked whether `otherPart.Name` was in a hand-written set of torso and arm names, and the
		// answer it gave for everything else was "this part cannot catch" — the head and the legs, on purpose,
		// because they were what a throw was aimed *at*.
		//
		// **`otherPart` is not the part the engine reported, which is why the set could go.** It is what
		// `struckBodyPart` resolved the contact to: an accessory becomes the body part it is worn on, the root
		// becomes the torso it is jointed to, and a tool or a ball in a hand becomes nothing at all and never
		// reaches this method. So "is this a part of the body" has already been answered a frame earlier — by
		// `Humanoid.GetLimb`, which knows R6, R15 and any rig nobody has written a list for yet.
		//
		// **A rule rather than a longer list, and the list is the thing being replaced.** Adding `Head` and
		// four leg names would have made the same mistake somewhere new: R6 calls a thigh `Left Leg` and R15
		// calls it `LeftUpperLeg`, and a rig from a generation nobody has seen would be un-catchable until
		// somebody noticed. The engine's own answer to "what limbs does this rig have" cannot drift from the
		// rig it is asked about.
		//
		// **What it costs, said plainly: the window is now a shield.** While it is open, *any* body contact
		// with a catchable ball is a catch — so a catcher cannot be hit by an ordinary throw for that second,
		// wherever it lands on them. That is "all parts of the body catch" read from the other end, and
		// `CATCH_CONFIG.WINDOW_SECONDS` carries the same note with the answers that remain: the length of the
		// window, one ball per window, and the two abilities a window cannot stop — both refused just above.

		// Only a ball in flight can be caught. One welded into somebody's hand is
		// already held, and taking it would leave a ball with two welds on it.
		//
		// **`Armed` belongs here, beside the parent test, and it is not redundant with `handleTouch`'s own guard.**
		// The `Touched` door is behind that guard already, so asking again costs one attribute read on a path that
		// runs once per contact. **The proximity door is not behind it** — `BallService.catchByProximity` calls
		// `tryCatch` directly — and without this line an eight-stud radius would sweep up any spent ball lying on the
		// floor beside a catcher, which is a player picking a ball off the ground by pressing catch while looking at
		// the sky. "A live throw" is the rule, so it is stated where both doors pass.
		if (this.instance.GetAttribute("Armed") !== true) {
			// TEMPORARY — remove with `TRACE_CATCH`. **The one refusal that is neither timing nor ability**: the ball is
			// no longer a throw, so nothing could catch it at any distance.
			if (TRACE_CATCH) {
				logInfo(`[Catch] ${this.instance.Name}: refused for ${character.Name} — not armed (the throw is over)`);
			}

			return false;
		}

		if (this.instance.Parent !== Workspace) {
			// TEMPORARY — remove with `TRACE_CATCH`. **Proves the other half of the question**: the ball IS still
			// armed and reached this method, so the throw is live — but it is not in `Workspace`, which means it is
			// in somebody's hand (or being carried) rather than in the air.
			if (TRACE_CATCH) {
				logInfo(
					`[Catch] ${this.instance.Name}: refused for ${character.Name} — not in the world ` +
						`(parent ${this.instance.Parent?.Name ?? "nil"})`,
				);
			}

			return false;
		}

		const open = this.catches.isCatching(character);

		// TEMPORARY — remove with `TRACE_CATCH`. **The last silent refusal in this file.** If this prints, the ball
		// was armed, in the world, and the right ability — so the only thing missing was the *window*, and the fault
		// is on the input side (or the ball arrived outside it) rather than in the ball's state.
		if (!open && TRACE_CATCH) {
			logInfo(`[Catch] ${this.instance.Name}: refused for ${character.Name} — no catch window open`);
		}

		return open;
	}

	/**
	 * **One catch, in one place, because there are now two ways to attempt one.**
	 *
	 * **Touching the ball and being near it are two doors to the same room**, and both have to spend the window,
	 * attach the ball, credit the badge and resolve the thrower in that order — so the body is written once here and
	 * `handleTouch` calls it. The alternative was a second copy inside `CatchService`'s proximity loop, which is
	 * exactly the pairing this project has already paid for once (`isFriendlyFire` written twice would have drifted).
	 *
	 * **Returns whether a ball was caught, which is what lets the proximity loop stop.** A `false` means the window
	 * was not open, or the ball was not catchable, or the hand could not take it — and in every one of those cases
	 * **nothing was spent and nothing changed**, so `tryCatch` is safe to call as a probe while looking for a ball.
	 * That property is the whole reason the radius can afford to ask every neighbouring ball in turn.
	 *
	 * **`part` is the contact, and the proximity path passes the catcher's own root.** `canCatch` no longer tests the
	 * part for anything — "every limb can catch" is answered a frame earlier by `struckBodyPart` — so the two callers
	 * passing different parts of the same body changes no answer. It is kept in the signature because the *contract*
	 * is still "this contact, with this part", and a future part rule should have somewhere to live.
	 *
	 * **`contact` is which door this came through, and it is the one thing the two callers know that this cannot
	 * derive.** A ball taken on the body has no journey into the hand to animate, and pulling it is what produced the
	 * yo-yo — the ball carried through the catcher on its own momentum and was dragged back out from behind them. So the
	 * contact door says so, and `beginPull` welds on the spot; a proximity catch keeps its pull. Note that this is
	 * *not* the same question as "how far away was it", which `beginPull` also asks — see `PULL_INSTANT_STUDS`.
	 */
	public tryCatch(character: Model, part: BasePart, contact: "touch" | "proximity"): boolean {
		if (!this.canCatch(part, character)) return false;

		// **Spent before the ball is handed over**, so one attempt catches one ball even if two arrive together —
		// and so a proximity catch closes the window before the loop can consider a second ball.
		this.catches.consume(character);

		// Read before the ball changes hands: the weld in `attachToHand` makes the ball inert, which clears
		// `ThrowerId`, and the resolution below is about the thrower the ball *arrived* with rather than
		// whoever is holding it next. Read here rather than in `catchBall`'s callback because the pull means
		// the weld is a fifth of a second away and this frame is the last one guaranteed to be before it.
		const throwerId = this.instance.GetAttribute("ThrowerId");

		// A catch that cannot attach (no right hand) is not a catch: `attachToHand` destroys the ball in that case,
		// and nothing below should resolve a throw that is no longer in the air. That refusal is the only route
		// through `catchBall` that answers `false` — every other answer means a ball is on its way into the hand or
		// already in it.
		if (!this.balls.catchBall(character, this.instance, contact === "touch")) return false;

		// **The sound belongs to the catch and not to the weld**, so it is emitted here, on the frame the ball is taken
		// out of the air, at the ball's own position — which for a proximity catch is up to eight studs from the hand
		// it is about to be pulled into. It used to be emitted at the weld, on the argument that the sound is the ball
		// *landing*; a playtest says that reads as a delay between pressing and hearing, and the press is the event the
		// player is asking about. See `BallService.emitCatchSound`.
		this.balls.emitCatchSound(character, this.instance.CFrame);

		// **The round's badge count, and it goes here rather than in `CatchService.consume`.** That method is the
		// *close* of a window and not the catch of a ball — it runs for an expiry, a death, a departure and a spent
		// attempt alike — so counting it would hand `wall` and `safeHands` to anybody who merely pressed the key.
		// This is the one place a ball has actually been caught, and it is inside the `catchBall` answer for the same
		// reason: a catch that could not attach a ball is not a catch.
		this.badges.recordCatch(character);

		this.resolveCatch(character, throwerId);

		return true;
	}

	/**
	 * Whether a Freeze splash has to leave `model` alone: **the thrower, the thrower's own side, and
	 * anybody standing in a practice zone.**
	 *
	 * **Three tests because they are three rules, and the first is not a case of the second.**
	 * `RoundService.isFriendlyFire` answers about *sides*, and sides only exist while a round is being
	 * played — it returns `false` outside one, and it returns `false` for a thrower with no player
	 * behind it. So on its own it would let a dev testing in the lobby, or a rig's throw, freeze the
	 * thrower with their own ball. The token comparison is that missing half, and it is the same
	 * comparison the contact rules already make: the ball carries the thrower's token, the model carries
	 * its own, and a player's is their `UserId` as text where a rig's is a GUID — which is the point,
	 * because this check cannot tell the two apart and has no reason to.
	 *
	 * **The zone is a rule about the *target* rather than about the throw, and it is asked first for
	 * that reason.** Both of the rules below are claims about who threw the ball; this one is a claim
	 * about where the body is standing, and it holds whatever the answer to the other two is — a splash
	 * that lands in a practice zone leaves its players alone *whoever* threw it, which is the only
	 * reading of a shared practice area that is worth anything to the person standing in it.
	 *
	 * **Asked above the token guard rather than below it, and that is not tidiness.** The guard returns
	 * `false` before any test of the body, so a zone check placed under it would be skipped for exactly
	 * the throws most likely to reach a practice zone — a rig's, and a dev's in the lobby, which are the
	 * tokenless cases that guard exists for. See the note below for why a tokenless ball excludes nobody:
	 * that rule is about a missing fact on the *ball*, and it was never meant to decide anything about
	 * the body it lands beside.
	 *
	 * **A ball with no token excludes nobody**, which is the honest reading of a fact that is missing
	 * rather than a body that is protected: every thrown ball is stamped at release, so this is the
	 * never-happens case, and freezing everybody in the radius is the safer direction to be wrong in —
	 * the alternative is a splash that silently does nothing.
	 */
	private splashSpares(throwerToken: unknown, model: Model): boolean {
		// Read from the tracker's published fact rather than from the zone geometry: this predicate runs
		// once per body in the radius, so a bounds walk here would be a query per body per splash — the
		// cost that kept the server from asking this question until `PracticeZoneService` existed.
		const player = Players.GetPlayerFromCharacter(model);
		if (player && player.GetAttribute(PRACTICE_ZONE_ATTRIBUTE) === true) return true;

		const token = typeIs(throwerToken, "string") ? throwerToken : "";
		if (token === "") return false;

		if (model.GetAttribute(THROWER_TOKEN) === token) return true;

		return this.rounds.isFriendlyFire(token, model);
	}

	/**
	 * Whether `part` is part of `humanoid`'s body, rather than something it is holding or
	 * wearing.
	 *
	 * Two questions, in this order, and both are needed:
	 *
	 * 1. **Is it a direct child of the rig?** `GetLimb` *throws* — "Part is not a child of
	 *    Humanoid", with a stack trace in the output — for anything deeper. A hat's `Handle`
	 *    lives inside its accessory and a tool's inside its tool; without this an ordinary
	 *    glance off a beanie became an error that drowned the log and left the contact
	 *    half-handled.
	 * 2. **Does the engine call it a limb?** `GetLimb` answers for R6 and R15 alike, so no
	 *    list of names is needed here — an R15 rig has `UpperTorso` where an R6 one has
	 *    `Torso`, and a hand-written list would have to know both and would still miss a rig
	 *    nobody has seen yet. It reports `Unknown` for the `HumanoidRootPart`, so it agrees
	 *    with the explicit check above, and for a ball welded into the hand, which is a
	 *    direct child of the rig and so gets past the first question.
	 */
	private isBodyPart(humanoid: Humanoid, part: BasePart): boolean {
		if (part.Parent !== humanoid.Parent) return false;

		return humanoid.GetLimb(part) !== Enum.Limb.Unknown;
	}

	/**
	 * The body part a contact should be treated as, or `undefined` when it is not a contact with a
	 * body at all.
	 *
	 * Four answers, and the middle two are the point of the method:
	 *
	 * - **A part of the rig itself** → itself, which is the ordinary case.
	 * - **A part of something worn on the rig** → the body part it is attached to. See
	 *   {@link wornOn} for why the weld is the right thing to follow rather than a name, a
	 *   distance, or the accessory's own idea of where it is.
	 * - **The root part** → the body part it is jointed to, which is the torso. See
	 *   {@link rootHost}, which is where the reason for that lives.
	 * - **Anything else inside a character** → `undefined`: a tool, the dodgeball in somebody's hand,
	 *   or a worn part that cannot be traced back to a body. A ball that has touched one of those has
	 *   touched nothing — not a hit, not a catch, and no reason to disarm.
	 */
	private struckBodyPart(humanoid: Humanoid, otherPart: BasePart): BasePart | undefined {
		if (this.isBodyPart(humanoid, otherPart)) return otherPart;

		const accessory = otherPart.FindFirstAncestorWhichIsA("Accoutrement");
		if (accessory) return this.wornOn(humanoid, accessory);

		// **The root, and only the root.** Not every welded thing inside a character is routed to its
		// host — see {@link wornOn} for why a tool and a held ball deliberately are not — so this is
		// the root asked of *the humanoid* rather than a rule widened to cover everything welded: a
		// tool and a held ball must stay the ball's business and not become hits on the hand.
		//
		// **`Humanoid.RootPart` is the engine's own answer to which part that is** — "a reference to
		// the humanoid's `HumanoidRootPart` object" — so this is a link rather than a name, which is
		// the same choice {@link wornOn} makes and for the same reason. It also means a rig that
		// something has named oddly is still understood.
		if (otherPart === humanoid.RootPart) return this.rootHost(humanoid, otherPart);

		return undefined;
	}

	/**
	 * The body part the root is jointed to — the torso, on both rig types.
	 *
	 * **This is the fix for a hit that landed and did nothing, and it is the second version of it.**
	 * The root used to be dropped outright, on the reasoning that a ball in contact with it is in
	 * contact with the torso as well, so a report against the root alone means nothing happened. That
	 * is true of *collision* and false of `Touched`: an R15 rig's root sits below the torso's centre,
	 * so its underside is exposed between the legs, and a throw arriving at the hips touches the root
	 * and nothing else. The contact was then discarded, the throw carried on, and the body it had
	 * visibly struck survived — which is the report this was chased from, and what the refusal line at
	 * the old `return` finally showed.
	 *
	 * **Resolved rather than dropped, and resolved rather than taken as itself.** Treating the root as
	 * a body part in its own right is what this did even earlier, and it made a catcher unreachable: the
	 * root is not a limb — `Humanoid.GetLimb` answers `Unknown` for it, which is the same fact the
	 * config's catchable-names set used to spell out — so the first event of a chest arrival read as a
	 * hit and the catch that should have saved them arrived after the damage. Following the
	 * joint gets the answer those two options each missed — the contact becomes a *torso* contact, so
	 * it is a hit **and** it is catchable, which is what a ball into the chest always was.
	 *
	 * **Searches the whole rig, and that is the correction the first version of this method needed.**
	 * That version followed the link, which was right, and it looked for the link *inside the root*,
	 * which was an assumption — and a false one. **Where the joint lives depends on the rig**: on R15
	 * the joint holding the root on is a child of `LowerTorso` (and there is no `RootJoint` on the
	 * root at all), while on R6 it is a child of the root itself. Walking the root's descendants
	 * therefore found the torso on one rig and nothing on the other — and it failed by *declining*,
	 * which is the quiet way to be wrong: the throw that landed on a body produced the refusal line
	 * and then no tag, which is the symptom this method was written to remove and not a new one. A rig
	 * is one object and the link is somewhere in it, so the whole of it is searched and the answer no
	 * longer depends on which generation the rig is.
	 *
	 * **Follows the link rather than naming a part**, for {@link wornOn}'s reason: which part a rig
	 * calls its torso is the rig's business, and a hand-written name would have to know R6's `Torso`
	 * and R15's `LowerTorso` and would still miss a rig nobody has seen. The link is what "inside"
	 * means here, exactly as it is what "worn" means there — and both shapes of it are handled, see
	 * {@link connectionParts}.
	 *
	 * Only a link with the root at one end counts, so the rest of the rig's joints are nothing to do
	 * with this — and see {@link wornOn} for the two things deliberately not routed to their host.
	 *
	 * Answers `undefined` when no body part is jointed to the root, which would be a rig with no
	 * torso; the caller reports that rather than swallowing it.
	 */
	private rootHost(humanoid: Humanoid, root: BasePart): BasePart | undefined {
		// The rig, not the root: see the note above on where the joint lives. `root.Parent` rather
		// than `humanoid.Parent` because the root is a direct child of its rig and asking the part
		// itself is what makes that assumption visible instead of hidden behind a second lookup.
		const rig = root.Parent;
		if (rig === undefined) return undefined;

		for (const descendant of rig.GetDescendants()) {
			const sides = connectionParts(descendant);

			if (sides[0] !== root && sides[1] !== root) continue;

			// `side`, not `end`: `end` is a Luau keyword and roblox-ts refuses to emit it.
			for (const side of sides) {
				if (side === undefined || side === root) continue;
				if (this.isBodyPart(humanoid, side)) return side;
			}
		}

		return undefined;
	}

	/**
	 * The body part a worn accessory is attached to.
	 *
	 * **Follows the link, because the link is what "worn" means.** An accessory on a character is
	 * held there by something — that is the whole of the difference between wearing a hat and having
	 * dropped one — so the link already records the answer rather than leaving it to be guessed
	 * at. A distance test would return whichever body part happened to be nearest, which for a
	 * shoulder accessory is the head and for a long scarf is the floor; and an accessory's own
	 * `AttachmentPoint` is a `CFrame` for placing the model, not a reference to the part it landed
	 * on.
	 *
	 * Only links *inside the accessory* are searched, which is where the engine keeps the one that
	 * holds it on. **Both of Roblox's shapes for that link are handled rather than one being
	 * assumed** — see {@link connectionParts} — because a lookup written against welds alone finds
	 * nothing on a rig whose accessories are held by a `RigidConstraint`, and it fails by declining
	 * rather than by answering wrongly, which is precisely the kind of failure that survives review.
	 *
	 * The end that matters is the end that is not a descendant of the accessory, and it has to be a
	 * part of **this** rig: an accessory attached to anything else is not a body contact, so this
	 * answers `undefined` and the touch is ignored exactly as it was before this existed. That is the
	 * safe direction to fail in — a behaviour that does not change, rather than a hit on the wrong
	 * body.
	 *
	 * **Deliberately not widened past accessories.** A tool is welded to a hand in the same way, and
	 * so is the dodgeball a player is holding; routing every welded thing to its host would make a
	 * ball that clipped somebody's held ball into a hit on their hand.
	 */
	private wornOn(humanoid: Humanoid, accessory: Accoutrement): BasePart | undefined {
		for (const descendant of accessory.GetDescendants()) {
			// `side`, not `end`: `end` is a Luau keyword and roblox-ts refuses to emit it.
			for (const side of connectionParts(descendant)) {
				if (side === undefined) continue;
				if (side.IsDescendantOf(accessory)) continue;
				if (this.isBodyPart(humanoid, side)) return side;
			}
		}

		return undefined;
	}

	/**
	 * Plays one impact sound from a throwaway emitter at the point it happened.
	 *
	 * **Not parented to the thing that was struck, and that is the reversal of what this used to
	 * do.** The comment here argued that the sound should live and die with the part it was heard at,
	 * which is true of a wall and wrong of a body: a hit's head stops existing almost immediately and
	 * the clip went with it. An impact is a fact about a *moment*, and the one part of the scene with
	 * a reason to stop existing right then is the thing that was hit — so the emitter is deliberately
	 * something with no such reason.
	 *
	 * **Where the sharp case is, because it is not every death, and the difference is what to look
	 * for.** An NPC rig keeps its corpse: `RespawnBehavior` sets `BreakJointsOnDeath = false` and
	 * builds the replacement from a clone seconds later, long after any impact clip has finished. An
	 * eliminated player is the same story — out of the round, left dead, and given a new body by
	 * `RespawnService`. **A death in the lobby, or the load that ends an in-round wait, is not**: those go
	 * through `RespawnService.loadNow`, which destroys the old character on the spot, and that is the hit
	 * whose sound can be cut short.
	 *
	 * **A converted player in Dodge and Seek used to be the example here, and no longer is.** That mode
	 * answers `respawn`, and the load that answer asks for is now *scheduled* by the arena's own delay
	 * rather than run on the spot — so the corpse outlives any impact clip and this emitter's parenting stops
	 * mattering to it. The reasoning above stands on its own reason rather than on that case: an impact is a
	 * fact about a *moment*, and the thing that was hit is the one part of the scene with a reason to stop
	 * existing right then.
	 *
	 * Everything about the emitter itself — the flags, the parenting order, the two cleanup paths and
	 * the `PlayOnRemove` that is deliberately not used — now lives in {@link emitSound}, which is
	 * shared with the catch sound. What is left here is the part that is about *impacts*: which part
	 * the sound is heard from, and which id is chosen.
	 *
	 * The struck part's own name goes to the log, because at an impact that is the interesting fact —
	 * there are two ids for a body and a reader of the output should be able to tell which one this
	 * was without listening.
	 */
	private playImpactSound(at: BasePart, soundId: string): void {
		emitSound(at.CFrame, at.Name, soundId, IMPACT_EMITTER_NAME);
	}

	/**
	 * Records one raw `Touched` report, under the number of the ball that reported it.
	 *
	 * **Gated, and ungated was the wrong default for this one specifically.** Every other print in
	 * this file reports a *decision* — one line per landing, which is the whole story of a throw.
	 * This reports the engine's input instead: every part of every overlap set, in the engine's own
	 * order, on every contact an armed ball makes, including the ones that decide nothing. On a
	 * normal arrival that is a dozen lines that mean no more than the one line `handleTouch` ends it
	 * with, and it drowns the log it was meant to be read in. It earns its place only when a contact
	 * is *missing* or *impossible*, which is a question somebody has to be asking, so it lives with
	 * the other diagnostics behind {@link DEBUG_CONFIG.VERBOSE_LOGS}.
	 *
	 * **The identity is the point of the line, not decoration.** Several balls are in play — the
	 * arena's, the thrower's, one in a rig's hand — and they are all called `DodgeballBall`, so a
	 * bare `touched` line cannot be attributed to a throw and cannot be checked against where that
	 * throw's ball actually was. See {@link identity}.
	 *
	 * The `Armed` test is here as well as in `handleTouch` so the log and the decision agree about
	 * which reports were live: a contact on a ball that is already spent is not part of any story.
	 */
	private logTouch(otherPart: BasePart): void {
		if (!DEBUG_CONFIG.VERBOSE_LOGS) return;

		if (this.instance.GetAttribute("Armed") === false) return;

		const character = otherPart.FindFirstAncestorWhichIsA("Model");
		const player = character ? Players.GetPlayerFromCharacter(character) : undefined;

		// Built here rather than written inside the `print`, because a template literal nested
		// inside another one compiles to backticks inside backticks and renders empty — it parses,
		// it runs, and the log it produces has a hole in it.
		const subject = this.isPlayer(otherPart)
			? `${otherPart.Name} of ${player?.Name}`
			: this.isNpc(otherPart)
				? `${otherPart.Name} of ${character?.Name}`
				: otherPart.Name;

		logInfo(`${this.instance.Name} #${this.identity} touched ${subject}`);
	}

	/**
	 * Reports a contact this ball made that decided nothing, and why.
	 *
	 * **The half of a throw's story that was silent by construction, and the reason a hit that did
	 * not register was indistinguishable from a ball that never arrived.** Every refusal in
	 * {@link handleTouch} used to `return` without a word — deliberately, because a normal arrival
	 * makes a dozen of them that mean nothing. The cost is that "this ball met the body and refused
	 * it" and "this ball never met the body" produce exactly the same empty log, which is the
	 * question behind every report of a hit that did not count.
	 *
	 * The refusals worth seeing are named, and they are chosen by how often they can fire rather than
	 * by how interesting they are: **the ones left silent are the ones a single arrival makes a dozen
	 * of** — a body already on the tag list, and the extra parts of the overlap set that follow it.
	 * Everything else fires at most once or twice per arrival, and only when something happened that
	 * the thrower did not intend.
	 *
	 * Ungated, like the tag and the landing, because it is the *absence* of those two lines that this
	 * exists to explain — and a diagnostic that has to be switched on cannot explain a log captured
	 * without it.
	 *
	 * **The body as well as the part, and that is the other half of the same lesson.** `HumanoidRootPart`
	 * is the name of a part on every rig in the game, so a line saying only that leaves the one
	 * question it is being read for unanswered: whose root was it? The ball's own thrower and the body
	 * the throw was aimed at are completely different faults — a ball released into its thrower's own
	 * leg is a spawn offset, while a ball into a victim's hip is this file failing to resolve a
	 * contact — and the part's name alone cannot tell them apart. Both are named here, so a refusal
	 * can be attributed without a second run.
	 */
	private noteDecidedNothing(part: BasePart, reason: string): void {
		const body = part.FindFirstAncestorWhichIsA("Model");
		const subject = body ? `${part.Name} of ${body.Name}` : part.Name;

		logInfo(`[Ball] ${this.instance.Name} #${this.identity}: ${subject} — ${reason}`);
	}

	private isPlayer(otherPart: BasePart): boolean {
		const character = otherPart.FindFirstAncestorWhichIsA("Model");

		const player = character ? Players.GetPlayerFromCharacter(character) : undefined;

		if (player) {
			return true;
		}

		return false;
	}

	private isNpc(otherPart: BasePart): boolean {
		const character = otherPart.FindFirstAncestorWhichIsA("Model");
		const humanoid = character?.FindFirstChildWhichIsA("Humanoid");
		const player = character ? Players.GetPlayerFromCharacter(character) : undefined;

		if (humanoid && !player) {
			return true;
		}

		return false;
	}
}

/**
 * The two parts a connective instance holds together, or an empty list if it holds none.
 *
 * **Two shapes, because Roblox has two and which one a rig's accessories use is not ours to
 * choose.** A `Weld` or a `WeldConstraint` names the parts directly, in `Part0` and `Part1` — that
 * is the older way an accessory was held on. A `Constraint`, which is what a rigid accessory is
 * attached with (`RigidConstraint`), names an `Attachment` at each end instead, and the part is
 * whichever `BasePart` that attachment is parented to; there is no `Part0` to read at all. A lookup
 * that only understands the first shape finds nothing on a modern rig, and because
 * {@link BallComponent.wornOn} treats "found nothing" as "not a body contact", the whole thing fails
 * quietly rather than loudly.
 *
 * An end with no part behind it is reported as `undefined` rather than left out, so the two
 * positions keep meaning "first end" and "second end".
 */
function connectionParts(link: Instance): Array<BasePart | undefined> {
	if (link.IsA("JointInstance") || link.IsA("WeldConstraint")) return [link.Part0, link.Part1];

	if (!link.IsA("Constraint")) return [];

	// The part an attachment sits in, or nothing when it sits in something that is not a part.
	// A local rather than a second exported helper: it exists only to be applied to the same two
	// fields, and roblox-ts types `Array.push` against `defined[]`, so the two ends are built as one
	// literal instead of pushed onto an accumulator.
	const partOf = (attachment: Attachment | undefined): BasePart | undefined => {
		const parent = attachment?.Parent;
		return parent !== undefined && parent.IsA("BasePart") ? parent : undefined;
	};

	return [partOf(link.Attachment0), partOf(link.Attachment1)];
}
