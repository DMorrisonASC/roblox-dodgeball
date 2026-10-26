import { OnStart, Service } from "@flamework/core";
import { Players, ReplicatedStorage } from "@rbxts/services";
import { startAfterimage, stopAfterimage } from "shared/afterimage";
import { ACTION_CONFIG } from "shared/config/action.config";
import { BALL_CONFIG } from "shared/config/ball.config";
import { DODGE_CONFIG, DODGE_SPEED } from "shared/config/dodge.config";
import { DEBUG_CONFIG } from "shared/config/debug.config";
import { SOUND_CONFIG } from "shared/config/sound.config";
import { CATCH_READY_AT, BALL_SIZE, BALL_TAGGED_BODIES_ATTRIBUTE, DODGE_DIRECTION_ATTRIBUTE, DODGE_READY_AT, IN_ROUND_ATTRIBUTE, PRACTICE_ZONE_ATTRIBUTE, ROUND_STATE_ATTRIBUTE, ROUND_STATUS_FOLDER } from "shared/constants";
import { canDodge, dodgeDirectionOf, flattenToGround, resolveDodgeable } from "shared/dodge";
import type { DodgeDirection } from "shared/dodge";
import type { Dodgeable } from "shared/dodge";
import { events } from "shared/networking";
import { lockoutElapsed } from "./actionLock";
import type { DuckState } from "./DuckService";
import { DevService } from "../../dev/DevService";
import { FreezeService } from "./FreezeService";
import { extendReadyAt, publishReadyAt } from "./readyAt";
import { emitSound } from "../ball/SoundEmitter";
import { insideZone } from "../zone/PracticeZoneService";
import { BadgeService } from "../badges/BadgeService";
import { BallService } from "../ball/BallService";

/** Prints what every dodge request did, and why it did nothing. */
const DEBUG = false; // off for frame time — see shared/config/debug.config.ts

/**
 * Shortest direction vector that is accepted.
 *
 * Rejects a zero-length vector, and anything a client might send that is not
 * roughly unit length. The direction is normalized before it is used, so this is
 * only about refusing input that does not mean a direction at all — and it is
 * checked *before* flattening, so a request aimed at the sky is refused for
 * having no heading rather than accepted for having length.
 */
const MIN_DIRECTION_MAGNITUDE = 0.9;

/**
 * What a dodge sound's emitter is called.
 *
 * The third of these, and separate from the other two for the reason given in `SoundEmitter`: the
 * emitter is an anonymous part in `Workspace`, so its name is the only handle a leftover check has,
 * and one name per event is what makes "no dodge emitters remain" a statement about dodges.
 */
const DODGE_EMITTER_NAME = "DodgeEmitter";

/** What `ROUND_STATE_ATTRIBUTE` says while a round is being played. A word between two files. */
const PLAYING = "Playing";

/*
 * **`BODY_CONTACT_RADIUS` is gone, and the note is here rather than beside a declaration because there is no
 * declaration any more.** It asked "was the ball at this body" from one point at the body's centre, and the ball
 * can now answer that question exactly: `BallComponent` publishes the bodies a throw has tagged, and a tag *is*
 * a contact with a part of the rig. The two things that made the radius wrong are worth recording, because they
 * are the two ways a proximity test of this kind fails:
 *
 * - **It measured the wrong place.** The root sits at the hips; a ball into the chest, the head or an arm was
 *   several studs from it, so the radius had to be generous — generous enough to swallow a real near miss.
 * - **It measured the wrong *time*.** The watch opens when the dash starts, and a ball that struck the body
 *   *before* that instant is already past it — a proximity test run a frame later cannot see a contact that has
 *   already happened. That is the log this was found from: a body tagged at `20:15:30.512` and reported as a
 *   "perfect dodge" against the same body at `20:15:30.793`, 281 ms later.
 *
 * A `GetBoundingBox()` volume was the other candidate and is rejected for a reason the constant list cannot
 * show: **a held ball is a child of the character** (`BallService.attachToHand` parents it to the model), so the
 * character's own bounding box includes it — which would push the contact volume about three studs out on the
 * side the hand is on, past `PERFECT_DISTANCE`, and silently swallow every dodge made by a body carrying a ball.
 * See `watchForPerfectDodge` for what replaced both.
 */

/**
 * How near a body a ball has to be *predicted* to arrive for the dodge that avoided it to be disqualified, in
 * studs — **the radius {@link stillOnCourse} uses, and the one place a radius is still the right instrument.**
 *
 * `BALL_SIZE / 2` is the ball and the other `1.5` is a body: an R15 torso is two studs wide and an arm hangs a
 * little beyond that.
 *
 * **This is not the retired contact test, though it looks like it.** That test asked "is the ball at the body
 * *now*" and was replaced by the ball's own tag list, because a tag is exact and a sphere is not. This one asks
 * "will the ball be at the body *later*", which no tag can answer — the contact has not happened yet — so a
 * prediction is the only available instrument and a radius is what a prediction is made of.
 */
const PREDICTED_HIT_RADIUS = BALL_SIZE / 2 + 1.5;

/**
 * A dash in flight, and the one way to end it early.
 *
 * `finish` is a function *property*, not a method, and that is load-bearing:
 * roblox-ts compiles the two differently, and a method signature here rejects
 * the object literal below with "Attempted to assign non-method where method was
 * expected". Write it `finish(): void` and this file stops compiling.
 */
interface ActiveDash {
	finish: () => void;
}

/**
 * What a dodge has to know about catching, answered by whoever owns the catch window.
 *
 * Declared as **methods**, which is the opposite of {@link ActiveDash} and right for the
 * same reason: the only thing that implements this is `CatchService` itself, passed as an
 * instance, and a class's methods satisfy a method signature. An object literal could
 * not — it would need function properties.
 */
export interface CatchState {
	/** Whether `model` has a catch window open at this instant. */
	isCatching(model: Model): boolean;

	/**
	 * `os.clock` seconds at which `model`'s catch window stopped counting, or `undefined`
	 * if it has never had one open.
	 */
	getLastCatchWindowCloseTime(model: Model): number | undefined;
}

/**
 * **The dodge flourishes are no longer played by the server, and this note is what stands in for the three
 * functions that played them.**
 *
 * This service used to resolve the clip (`dodgeAnimationId`), load it onto a player character's animator
 * (`playDodgeAnimation`) and stop it when the dash ended (`stopDodgeAnimation`) — a track started on the
 * server, on the argument that a client-started one would be that client's private flourish. A rig was drawn
 * by every client from the direction published below, so the game had two ways of drawing one dodge, and the
 * two could disagree about which of the four clips a dash was.
 *
 * **There is one way now, and it is the direction below.** Every body's dash is drawn from
 * `DODGE_DIRECTION_ATTRIBUTE` by `client/controllers/character/BodyAnimator.ts` — a rig on every client, a
 * player's own body on the client that owns it — and the clip is `BODY_ANIMATION`'s dodge row for the
 * direction that was published. So this service's animation duty is one attribute write and one clear, and
 * the clip table is the shared one rather than a second lookup here.
 */

/**
 * Dodging, decided by the server.
 *
 * `requestDodge` is the entry point for everything: the remote handler below and
 * an NPC's AI call the same method, so neither has to be a player — a humanoid,
 * though, is required, which is what keeps this to things that can actually
 * dodge. The dash itself is a velocity applied to the model's root for a fixed
 * time, which is what makes it behave the same on a character the player's
 * client is simulating and on a rig the server owns.
 */
@Service()
export class DodgeService implements OnStart {
	/**
	 * When each model last dodged, keyed on the *model*.
	 *
	 * A player's cooldown therefore resets on respawn along with their character,
	 * which is the behaviour we want, and an NPC needs no bookkeeping of its own.
	 * Entries for models that go away are left behind: they are a number each, and
	 * pruning them would need a `Destroying` subscription per model.
	 */
	private readonly lastDodgeAt = new Map<Model, number>();

	/**
	 * The dash each model has in flight.
	 *
	 * Kept so a second dodge can *end* the first rather than stack on it, and so
	 * nothing is left attached to a model whose dash is cut short by a death.
	 */
	private readonly dashes = new Map<Model, ActiveDash>();

	/**
	 * When each model's last dash stopped, keyed on the model.
	 *
	 * **Not {@link lastDodgeAt},** which is when a dodge *started* and exists only to time
	 * the cooldown between two of them. This one is the moment a dash was over, which is
	 * what a catch is gated on — and the two are written at opposite ends of a dash for
	 * that reason: the cooldown is charged when the request is accepted, this when the dash
	 * ends, however it ends.
	 */
	private readonly lastDodgeEndAt = new Map<Model, number>();

	/**
	 * The watch each model's **most recent** dodge owns, so a newer dodge silences an older one's window.
	 *
	 * **The dashes table cannot answer this one**, and the difference is the whole reason this exists: a dash
	 * is over after {@link DODGE_CONFIG.DURATION} (0.2 s) while the perfect-dodge window outlives it by design
	 * ({@link DODGE_CONFIG.PERFECT_WINDOW_SECONDS}, 0.6 s), so "is this still my dash" is false for most of the
	 * window it is supposed to be measuring. What has to be compared instead is *which dodge opened the watch*,
	 * and the token is that question. It only matters for a dev with `NoCooldown`, who can dodge again inside
	 * the window — for everybody else the cooldown is longer than the window and there is never a second one.
	 *
	 * An entry per model that is replaced rather than pruned, exactly like {@link lastDodgeAt}: they are one
	 * table reference each, and pruning would need a `Destroying` subscription per body.
	 */
	private readonly perfectWatches = new Map<Model, object>();

	/**
	 * The catch window, as answered by the service that owns it.
	 *
	 * Handed over rather than injected: the two services are gated on each other, and
	 * Flamework **errors on a circular dependency** — so `CatchService` holds this service
	 * and this is how the other direction is closed. Unset until `CatchService` is
	 * constructed, which is during ignite and long before anything can dodge; while it is
	 * unset nothing is refused, because a service that does not exist cannot be holding a
	 * window open.
	 */
	private catchState?: CatchState;

	/**
	 * The duck, as this service has to see it — **the same handover as {@link catchState}, in the other
	 * direction, and it is a handover rather than an injection for a mechanical reason.** `DuckService`
	 * injects this service, because it has to ask whether a dash is in flight before it starts one, so
	 * this service cannot inject that one back. `DuckService.onStart` hands itself over instead, which is
	 * the arrangement {@link watchCatchState} already established one file over.
	 *
	 * Unset until then, and while it is unset nothing is refused — a service that does not exist cannot
	 * be holding a body in a duck.
	 */
	private duckState?: DuckState;

	constructor(
		private readonly dev: DevService,
		private readonly freezes: FreezeService,
		private readonly badges: BadgeService,
		/**
		 * **The balls, and the one thing this service needs from that domain: what is in flight.**
		 *
		 * The perfect dodge is the only part of a dodge that has to look at the world — a dash is a velocity and
		 * needs nothing else — and what it has to look at is a ball's *position*, which is the ball domain's to
		 * report rather than this service's to enumerate. See `BallService.armedBalls` for the query and why
		 * `Armed` is the definition of "still a throw".
		 *
		 * **Injected rather than handed over**, unlike {@link catchState} and {@link duckState} above: those
		 * are the *other* direction of a pair of services that have to see each other, and a handover is how a
		 * cycle is broken. `BallService` does not reach back into this one, so there is nothing to break.
		 */
		private readonly balls: BallService,
	) {}

	/**
	 * Hands this service the catch window it has to respect. Called by `CatchService` itself.
	 *
	 * A handover rather than a subscription: there is one catch window and it has one owner,
	 * so whatever is passed here is what a dodge is gated on from then on.
	 */
	public watchCatchState(state: CatchState): void {
		this.catchState = state;
	}

	/** Hands this service the duck it has to respect. Called by `DuckService` itself. See {@link duckState}. */
	public watchDuckState(state: DuckState): void {
		this.duckState = state;
	}

	public onStart() {
			events.Server.OnEvent("dodge", (player, direction, reference) => {
				if (DEBUG) print(`[Dodge] ${player.Name} asked to dodge ${direction}`);

				const character = player.Character;
				if (!character) {
					if (DEBUG) print(`[Dodge] ${player.Name}: no character to move`);
					return;
				}

				// **The reference is passed straight through as the optional argument it is.** A client that could not
				// read its camera sends zero, which flattens to nothing, which is the same as not sending one — and
				// then the dash reads the body itself. See the `dodge` event for what the two fields are.
				this.requestDodge(character, direction, reference);
		});
	}

	/**
	 * Asks for `model` to dodge `direction`.
	 *
	 * Returns whether the model moved. Everything that decides that — a round being played, the model
	 * having a living humanoid, being off cooldown and having been given a usable direction — is checked
	 * here, so a caller cannot half-ask, and the direction is normalized rather than trusted: a client can
	 * send anything, and the only thing its direction is allowed to decide is which way the dash goes.
	 *
	 * **`reference` is optional, and which caller omits it is the whole of the rule.** A player's client sends
	 * it — the frame its keys were read in, which is the camera — because the server has no camera to read.
	 * An NPC's AI does not, because the server owns *that* body and the rig's own facing is both fresher and
	 * the right frame for a step the AI chose: `DodgeBehavior` reaches this through
	 * `requestDodge(model, direction)`. Omitting it is therefore not a degraded path — it is the correct
	 * answer for a body whose direction is motion rather than input. What the two callers must not do is
	 * disagree about *whose* reading wins for the same body, which is why the fallback lives where the dash
	 * starts rather than being decided by the caller. See {@link startDash}.
	 */
	public requestDodge(model: Model, direction: Vector3, reference?: Vector3): boolean {
		const entity = resolveDodgeable(model);
		if (!entity || !canDodge(entity)) {
			if (DEBUG) print(`[Dodge] ${model.Name}: no living humanoid to dodge with`);
			return false;
		}

		// The cooldown goes when the humanoid does, so a dead model does not leave an
		// entry behind. `Once` because dying happens once.
		entity.humanoid!.Died.Once(() => this.lastDodgeAt.delete(model));

		// The other action has the first word, and it is asked before the cooldown rather
		// than after: a dodge refused because a catch is in the way has not happened, so it
		// must not be charged for one. Deliberately not skipped for a dev with `NoCooldown` —
		// that flag buys freedom from the *dodge's* own clock, and this is a rule about the two
		// actions rather than a clock of either one. Turn the flag off to test it.
		if (this.blocksDodge(model)) return false;

		// **The state gate: this player has to be in the round being played, or the body has to be in a practice zone.**
		//
		// **This supersedes "round only", and the reason it was round-only is the reason it changed.** The
		// earlier argument was cost: a zone half here would have been a `GetPartBoundsInBox` walk over
		// every tagged zone part on every press of a movement key — the one place in the game where the
		// query rate is set by how fast somebody can mash rather than by a tick. That argument was correct
		// for as long as the zone was a *question the server had to ask*. It is not a question any more:
		// `PracticeZoneService` owns membership and publishes it on the player, so the zone half below is
		// an attribute read, and the cost that ruled it out is the thing that has gone. The decision
		// changed because its reason did, which is the only good reason to change one.
		//
		// **And the round half is `IN_ROUND_ATTRIBUTE` as well as the phase, which is the correction a report
		// bought.** The half used to be the phase alone — *a round is being played* — and that is a fact about the
		// **server**, not about this body: it is true for every player watching from the lobby. So a player who
		// opted out of the round, or who surrendered out of it, could dodge for the whole length of somebody else's
		// match. The phase says the game is on; the attribute says the round has *this player* in it; a dodge needs
		// both, and the client's half (`roundZone.inRoundOrZone`) asks the identical pair so a press is not refused
		// a round trip later. See `IN_ROUND_ATTRIBUTE`, which is written where a player is admitted and cleared in
		// `eliminate`.
		//
		// **Placed here, before the cooldown is read or charged**, which is the position `blocksDodge`
		// occupies and for the reason that method gives: a dodge that was never allowed has not happened, so
		// it must not be charged for one. `blocksDodge` keeps the first word of the two — a freeze is a
		// state about the *body*, and this one is about where the body is and what the round is doing.
		//
		// The round is read from the round folder, which is how every other reader on this side gets at it,
		// and it is the *same* source the client's half reads — so the two sides cannot disagree about what
		// the round is doing. Membership and the zone are read from the player, which is how every other
		// consumer gets at *that*, and it is likewise the client's source once the attributes have
		// replicated. A folder that is not there yet reads as "no round" and a player who has never been in a
		// zone carries no attribute; both are the right answer while the server is still igniting.
		//
		// **A rig is the one body that still asks the phase alone, because a rig cannot be asked anything
		// else, and this paragraph is the exception to the rule above.** The attribute is written on the
		// *player* — `PracticeZoneService.tick` takes a `Player`, one per body — so `GetPlayerFromCharacter`
		// answers `nil` for an NPC rig and the attribute half of this gate would answer `false` for it for
		// ever. A round covers that, because the round half is about the *round* rather than about the body,
		// which is why an NPC dodges in play and why the hole only shows in the practice area: the place a
		// rig is most likely to be tested in. So a body with no player queries the zone directly, through
		// `insideZone` — already exported, already taking any `Instance` for the mystery box's sake, and
		// already the one place the rule about what a zone *is* lives.
		//
		// **What makes the exception legitimate is the rule's own reason.** The cost the tracker exists to
		// avoid is a query whose rate is set by *how fast somebody can mash a key* — and a rig does not
		// mash. Its requests come from `DodgeBehavior`, which pre-checks `DODGE_CONFIG.COOLDOWN` on its own
		// side, so the query runs at most once per 1.5 seconds per rig, for the handful of rigs that exist.
		// A player never reaches it: the attribute arm is what a player takes, and a ternary does not
		// evaluate the arm it does not need.
		const status = ReplicatedStorage.FindFirstChild(ROUND_STATUS_FOLDER);
		const playing = status?.GetAttribute(ROUND_STATE_ATTRIBUTE) === PLAYING;

		const player = Players.GetPlayerFromCharacter(model);

		// A rig has no membership to ask about, so the phase is its whole answer — see the paragraph above.
		const inRound = player !== undefined ? playing && player.GetAttribute(IN_ROUND_ATTRIBUTE) === true : playing;

		if (!inRound) {
			// **The player's arm of this line is unchanged, character for character**, which is the whole
			// of what the zone change promised: the same single attribute read, compared the same way. The
			// query arm is the new one, and it is only reachable by a model the engine does not consider a
			// character.
			const inZone =
				player !== undefined
					? player.GetAttribute(PRACTICE_ZONE_ATTRIBUTE) === true
					: insideZone(model);

			if (!inZone) {
				if (DEBUG) print(`[Dodge] ${model.Name}: refused — not in the round, and not in a practice zone`);

				return false;
			}
		}

		// A dev with `NoCooldown` drops the clock entirely — the read here *and* the
		// write below, because keeping only one of them would mean charging a cooldown
		// nobody checks, or checking one that was never charged.
		const free = this.dodgesFreely(model);

		const now = os.clock();
		const last = this.lastDodgeAt.get(model);
		if (!free && last !== undefined && now - last < DODGE_CONFIG.COOLDOWN) {
			if (DEBUG) print(`[Dodge] ${model.Name}: still cooling down`);
			return false;
		}

		if (!typeIs(direction, "Vector3") || direction.Magnitude < MIN_DIRECTION_MAGNITUDE) {
			if (DEBUG) print(`[Dodge] ${model.Name}: not a usable direction`);
			return false;
		}

		// Flattened before anything is applied: a camera pointed at the floor must
		// still dash along the floor, not into it.
		const heading = flattenToGround(direction);
		if (!heading) {
			if (DEBUG) print(`[Dodge] ${model.Name}: no heading in that direction`);
			return false;
		}

		// **The reference the requester reported, when it reported a usable one.** Flattened here rather than
		// trusted, for the reason the direction is: the value arrives from a client, and the only thing this
		// side does with it is name a clip — so a value with no horizontal part is the same as no value, and
		// the dash falls back to reading the body itself. See {@link startDash}, which owns that fallback
		// because it is the only place that has the body's root to read.
		const reportedReference = typeIs(reference, "Vector3") ? flattenToGround(reference) : undefined;

		// Charged now, before the dash exists: the request has been accepted at this
		// point, and charging it after the fact would leave a window in which two
		// requests can both pass the check. Nothing is charged for a dev who is not
		// gated by it in the first place — and nothing is published either, so the
		// readout agrees with the rule rather than with what was asked for.
		if (!free) {
			this.lastDodgeAt.set(model, now);
			publishReadyAt(model, DODGE_READY_AT, DODGE_CONFIG.COOLDOWN);
		}

		// The dodge shuts catching for its whole length plus the tail that follows it, told to the
		// client in the same currency as every other cooldown. Deliberately outside the `free`
		// branch: `NoCooldown` skips the dodge's *own* clock, and this is the rule about the two
		// actions, which holds for a dev exactly as it holds for anybody else.
		//
		// "At least" rather than outright, because a catch cycle already running may end after this
		// does — and the readout has to show the longer of the two waits, or it would go light
		// while the pair was still shut.
		extendReadyAt(model, CATCH_READY_AT, DODGE_CONFIG.DURATION + ACTION_CONFIG.ACTION_LOCKOUT_SECONDS);

		this.startDash(model, entity, heading, reportedReference);

		// **Heard here, which is after every reason this dodge might not have happened.** No living
		// humanoid, a catch in the way, a cooldown not yet elapsed, a direction that is not a
		// direction, a heading with no horizontal part — each of those returned above. So arriving at
		// this line *is* the dodge, and a refused attempt is silent by construction rather than by a
		// condition written here. That matters more for this sound than for the other two: a dodge
		// refused for cooldown is the common case, and it is the one a stray sound would give away.
		//
		// **At the root part, which is where the model *is*.** `Dodgeable.root` is the part whose
		// position the model's position is — see `resolveDodgeable` for how one is chosen — so this is
		// the dodger rather than whatever the humanoid's own centre happens to be. It is also the part
		// the dash's own constraints are hung from, so the sound and the move are in the same place by
		// construction rather than by two lookups agreeing.
		//
		// **On the server, which costs a round trip and buys every nearby player the sound.** The
		// rejected alternative is worth naming because it is not a bad idea: this client already knows
		// it dodged — it pressed the key — so a sound played locally would be immediate, and the one
		// the dodger heard would not arrive a round trip after their own input. It is rejected because
		// the sound is not *for* the dodger. A dodge is something other people need to notice, which is
		// exactly why `playDodgeAnimation` starts its flourish from the server and not from the client
		// that asked, and a locally-played sound would be a private flourish for the one person who
		// already knows what they just did. Consistency with the hit and catch sounds is the deciding
		// factor, not a tie-break: all three are the same kind of event, so all three are told the same
		// way.
		emitSound(entity.root.CFrame, model.Name, SOUND_CONFIG.DODGE, DODGE_EMITTER_NAME);

		// **And the round's badge count, on the line after the sound and for the sound's own reason.** Everything
		// above this sentence has returned for a reason the dodge did not happen — no humanoid, a catch in the
		// way, a cooldown, a direction that is not one — so arriving here *is* the dodge, and a refused attempt
		// is not counted by construction rather than by a condition written here. The counters are keyed on the
		// body, which folds to its `Player`; a rig's dodge is counted under its model, because a rig has a head
		// for the badge strip to hang over.
		this.badges.recordDodge(model);

		return true;
	}

	/**
	 * Whether a dash is in flight for `model`.
	 *
	 * The dashes table *is* the answer: an entry exists only while a dash does, and every
	 * way a dash ends goes through {@link endDash}, which drops the entry. A second set of
	 * active dashers would be a second copy of that fact to keep in step.
	 */
	public isDodging(model: Model): boolean {
		return this.dashes.has(model);
	}

	/**
	 * `os.clock` seconds at which `model`'s last dash ended, or `undefined` if it has never
	 * dashed.
	 *
	 * The fact a catch is gated on: a dodge that has *finished* still keeps a catch shut for
	 * the lockout, and that is measured from here rather than from `lastDodgeAt` so it means
	 * the same thing whatever the dodge's duration is. See {@link lockoutElapsed}.
	 */
	public getLastDodgeEndTime(model: Model): number | undefined {
		return this.lastDodgeEndAt.get(model);
	}

	/**
	 * Whether `model`'s catch is in the way of a dodge: open now, or closed within the
	 * lockout.
	 *
	 * Both halves are one comparison over the catch's own timing, which is why the catch
	 * state is asked for its clock rather than told what the rule is — the window is the
	 * catch's to know about, the lockout is the reader's to apply, and the lockout itself is
	 * {@link lockoutElapsed}, so this gate and the two others cannot disagree about it.
	 */
	private blocksDodge(model: Model): boolean {
		// **Frozen first, because everything below is a clock and this is a state.** A window and a
		// lockout both expire on their own, so a refusal from either of them can be waited out; a freeze
		// cannot, and it is the only thing in this list that changes the answer to "can this body act at
		// all". Asked first so a frozen player is told the real reason rather than that they are still
		// cooling down from something that finished two seconds ago.
		if (this.freezes.isFrozen(model)) {
			if (DEBUG) print(`[Dodge] ${model.Name}: refused — frozen`);

			return true;
		}

		// **The duck, asked before the catch and for a state's reason rather than a clock's.** A duck is
		// *up* for as long as it is up, so a dodge refused by one has not been charged for a cooldown it
		// could have waited out — which is the position the freeze occupies above. What follows it is the
		// duck's own lockout, and then the catch's, and both of those are clocks.
		//
		// **A ducking body cannot dash, and the anchor is why it must not.** `DuckService` anchors the root
		// for the duration, so a dash started underneath it would be a velocity applied to a part the engine
		// is not simulating: the rig would commit, the bar would charge, and nothing would move. Refusing is
		// the honest answer to the same fact.
		const duck = this.duckState;
		if (duck !== undefined) {
			if (duck.isDucking(model)) {
				if (DEBUG) print(`[Dodge] ${model.Name}: refused — ducking`);
				return true;
			}

			const sinceDuck = lockoutElapsed(duck.getLastDuckEndTime(model));
			if (sinceDuck !== undefined) {
				if (DEBUG) {
					print(
						`[Dodge] ${model.Name}: refused — the duck ended ` +
							`${string.format("%.2f", sinceDuck)}s ago`,
					);
				}

				return true;
			}
		}

		const state = this.catchState;
		if (!state) return false;

		if (state.isCatching(model)) {
			if (DEBUG) print(`[Dodge] ${model.Name}: refused — a catch window is open`);
			return true;
		}

		const since = lockoutElapsed(state.getLastCatchWindowCloseTime(model));
		if (since === undefined) return false;

		if (DEBUG) {
			print(
				`[Dodge] ${model.Name}: refused — the catch window closed ` +
					`${string.format("%.2f", since)}s ago`,
			);
		}

		return true;
	}

	/**
	 * Whether `model` is a dev who has switched `NoCooldown` on.
	 *
	 * Asked of the model rather than of the remote's player, so the same question
	 * could be asked of an NPC's AI — an NPC has no player, so it simply never dodges
	 * for free.
	 */
	private dodgesFreely(model: Model): boolean {
		const player = Players.GetPlayerFromCharacter(model);
		const free = player !== undefined && this.dev.getFlag(player, "NoCooldown");

		// Printed only when the flag *is* on, so the line's absence is the diagnosis: a
		// dash still refused on a cooldown, with the chat log saying `NoCooldown on`,
		// means this never ran — which points at the flag reaching the service rather
		// than at the cooldown arithmetic below.
		if (free && DEBUG) print(`[Dodge] ${model.Name}: NoCooldown on — the cooldown is skipped`);

		return free;
	}

	/**
	 * Builds the dash itself: a `LinearVelocity` on the root, held for
	 * {@link DODGE_CONFIG.DURATION} and then destroyed.
	 *
	 * Velocity rather than a `PivotTo`: a teleport moves the model without moving
	 * its *motion*, so the humanoid — which is still steering toward wherever it
	 * was headed — walks it straight back and the dash reads as a stumble. A
	 * constraint moves the model and what the engine thinks it is doing, so there
	 * is nothing to walk back from.
	 */
	private startDash(model: Model, entity: Dodgeable, heading: Vector3, reference?: Vector3): void {
		// A dash already in flight is ended first: two of them would stack into
		// twice the distance, which is not what a 20-stud dodge means.
		this.endDash(model);

		const root = entity.root;
		const humanoid = entity.humanoid;

		// Spin left over from a jump, a turn, or the shove that prompted the dodge
		// would carry straight into the dash and tip it over. It starts from rest,
		// rotationally.
		root.AssemblyAngularVelocity = Vector3.zero;

		// Flattened and guarded here as well as at the request: a dash is a ground
		// move, and a direction with no horizontal part has no heading to normalize.
		const flat = new Vector3(heading.X, 0, heading.Z);
		if (flat.Magnitude < 0.01) {
			if (DEBUG) print(`[Dodge] ${model.Name}: no heading to dash along`);
			return;
		}

		const direction = flat.Unit;

		// **Which of the four dodge clips this dash wears, worked out here and published below.** The
		// dash is the only thing that knows the direction it actually went, and a client cannot derive
		// it: the body is turned to face the dash by the balance constraint a few lines down, so by the
		// time a client could see anything the answer would read as "forward" every time. See
		// `dodgeDirectionOf` for the four words, the rule, and why they are body-relative rather than
		// world-relative.
		//
		// **The reference is the requester's when it reported one, and this machine's own copy otherwise.**
		// That is not a preference, it is *which frame the decision was made in*: a player's dodge is an
		// input, read by the client through its camera, so the camera's heading is the frame that makes `S`
		// mean backward — and the server has no camera, so it has to be told. A *rig*'s dodge is motion
		// chosen by its AI, and the rig's own facing is both the right frame for it and a value the server
		// owns, so `DodgeBehavior`'s call arrives with no reference at all and this read is the answer.
		//
		// **Both reads are *before* the turn below, which is the whole reason this line sits here.** The
		// reference is where the body was pointing when the dodge was asked for, and the `balance` a few lines
		// down is what takes it away. Read the root's `CFrame` after the `lookAt` is parented and every dash
		// in the game classifies as forward. (For a player's dodge this ordering costs nothing and buys
		// nothing — the camera is not what the dash turns — but one line serves both callers.)
		const reported = reference !== undefined;
		const frame = reference ?? root.CFrame.LookVector;

		const dodgeDirection = dodgeDirectionOf(direction, frame);

		// **Said out loud, once per dash, at the edge — and it says which reference was used, because that is
		// the one fact the log otherwise cannot show and the one this classification kept getting wrong.**
		// `(from the client)` is a player's camera; `(read here)` is the server's own copy of the body's
		// facing, which is what a rig's dodge always is. One line per dash rather than per tick, in the four
		// words the clips are named by, so a test can read a dodge off the output without a second instrument.
		if (DEBUG) {
			print(
				`[Dodge] ${model.Name}: direction (${string.format("%.2f", direction.X)}, ` +
					`${string.format("%.2f", direction.Y)}, ${string.format("%.2f", direction.Z)}), ` +
					`measured against (${string.format("%.2f", frame.X)}, ${string.format("%.2f", frame.Y)}, ` +
					`${string.format("%.2f", frame.Z)}) (${reported ? "from the client" : "read here"}) ` +
					`→ ${dodgeDirection}`,
			);
		}

		// The two constraints share this attachment. The velocity does not care where
		// it sits; the orientation wants it at the point the body turns about, which
		// is the root's own centre.
		const attachment = new Instance("Attachment");
		attachment.Name = "DodgeAttachment";
		attachment.Parent = root;

		const velocity = new Instance("LinearVelocity");
		velocity.Name = "DodgeVelocity";
		velocity.Attachment0 = attachment;
		velocity.RelativeTo = Enum.ActuatorRelativeTo.World;
		// Unopposed, so the dash wins its whole duration outright instead of racing
		// gravity and the humanoid's own push for it.
		velocity.MaxForce = math.huge;
		velocity.VectorVelocity = direction.mul(DODGE_SPEED);
		velocity.Parent = root;

		// Platform stand takes the humanoid's own balance away — which is the point,
		// because that balance is the walk controller steering toward whatever is
		// held on WASD — so something has to hold the character up in its place. Both
		// points of the `lookAt` sit at the same height, so this is a yaw and nothing
		// else: upright, and never pitched into the ground.
		const balance = new Instance("AlignOrientation");
		balance.Name = "DodgeBalance";
		balance.Attachment0 = attachment;
		balance.Mode = Enum.OrientationAlignmentMode.OneAttachment;
		balance.CFrame = CFrame.lookAt(root.Position, root.Position.add(direction));
		balance.MaxTorque = 1e6;
		balance.Responsiveness = 50;
		balance.RigidityEnabled = false;
		balance.Parent = root;

		// **Nothing about the animation is declared here any more.** There was a `let track` on this line, and
		// a comment explaining that the clip was started at the very *end* of this method so that a flourish
		// which would not load could not leave a character flying — the one part of a dash that depends on an
		// asset outside this project's control, deliberately last. That whole arrangement is gone with the
		// server-side flourish: nothing here loads a track, so nothing here can fail on one. The dash is
		// registered, its cleanup is armed, and the direction published below is the entire animation contract.
		// See the note above `CatchState` for what replaced it.

		// The fall states are what the humanoid answers a shove with, and with no
		// balance of its own it would flop, get up, and flop again for as long as the
		// dash lasts. Switched off for the duration, and back on in the cleanup
		// — platform stand is put back to whatever it was, not just to `false`.
		const wasPlatformStanding = humanoid?.PlatformStand ?? false;
		if (humanoid) {
			humanoid.SetStateEnabled(Enum.HumanoidStateType.FallingDown, false);
			humanoid.SetStateEnabled(Enum.HumanoidStateType.Ragdoll, false);
			humanoid.PlatformStand = true;
		}

		const start = root.Position;
		let diedConnection: RBXScriptConnection | undefined;

		const record: ActiveDash = {
			finish: () => {
				diedConnection?.Disconnect();
				diedConnection = undefined;

				velocity.Destroy();
				balance.Destroy();
				attachment.Destroy();

				// The humanoid may be gone by now: a character can be removed mid-dash.
				if (humanoid && humanoid.Parent !== undefined) {
					humanoid.PlatformStand = wasPlatformStanding;
					humanoid.SetStateEnabled(Enum.HumanoidStateType.FallingDown, true);
					humanoid.SetStateEnabled(Enum.HumanoidStateType.Ragdoll, true);
				}

				// **And the published direction goes with the rest of the dash**, which is what puts the body
				// back into its walking or standing clip: the renderer reads the clear as "no longer dashing"
				// and picks its clip from the ordinary state again, through the one decision it always uses
				// rather than through a second path kept in step with this one. Empty rather than left
				// standing, so a body that has never dodged and one whose dash has just ended read alike.
				//
				// **This is the whole of the dodge's ending, now that the clip is not this service's.** The
				// flourish used to be stopped on the line above this one, because a track cannot be allowed to
				// run on past the move it describes. Nothing needs stopping any more: the renderer sees the
				// clear on this attribute change, and its own rule takes the dodge clip off — which is the same
				// instant and one fewer thing to keep in step.
				model.SetAttribute(DODGE_DIRECTION_ATTRIBUTE, undefined);

				if (DEBUG && DEBUG_CONFIG.VERBOSE_LOGS) {
					// What actually moved, against what was asked for. The two match
					// unless something else got a hold of the character mid-dash.
					const travelled =
						new Vector3(root.Position.X - start.X, 0, root.Position.Z - start.Z).Magnitude;

					print(
						`[Dodge] ${model.Name}: dashed ${string.format("%.1f", travelled)} of ` +
							`${string.format("%.1f", DODGE_CONFIG.DISTANCE)} studs`,
					);
				}
			},
		};

		this.dashes.set(model, record);

		// **And the perfect-dodge watch opens with the window it measures**, which is the same instant and for
		// the same reason the trail below does: the dashes table *is* the window, so a watch started anywhere
		// else would be measuring a dodge that was not in flight. `start` is the body's position before this
		// method moved it — the value the travelled-distance line at the end of `finish` measures from — and it
		// is the point the ball is measured against, so the two uses are one read rather than two that could
		// disagree about where the dash began.
		this.watchForPerfectDodge(model, root, humanoid, start);

		// **Restored, and the history matters because it went round a full turn.** This line was removed on
		// request — a ghost trail on a dash was read as visual noise rather than as motion — and the catch's
		// trail was left standing in its place. That reading was then reversed in the other direction: the
		// cue is a *dodge's*, so the dodge keeps it and the catch lost its own. The argument below is the
		// original one, and it stands again unchanged.
		//
		// **The trail opens exactly here, which is where `isDodging` starts answering yes.** The dashes table
		// *is* the window — see {@link isDodging} — so the ghosts and the state they stand for begin in the
		// same instant by construction rather than by two places agreeing to write at the same time. It
		// cannot be anywhere later in the method and still mean that: the timer below and the flourish at the
		// end are both still to come, and a trail started after either of them would begin emitting against
		// a dash that had already finished.
		//
		// **And the trail has already emitted by the time this returns**, which is the reversal recorded in
		// `afterimage.ts`: the version before this waited a whole interval first, on the argument that a copy
		// laid down here would sit inside the body that was still standing — true, and the wrong thing to
		// optimise, because that is the position the eye expects a smear to start from. So a dash is its
		// opening position *plus* the positions it travels, and the queueing is the trail's business rather
		// than this method's. See `emitGhost`.
		//
		// Above the death connection on purpose. A model that dies later has already fired this, and the stop
		// in {@link endDash} is what ends it; a trail *below* the connection would be one a death in the same
		// frame could outrun.
		startAfterimage(model);

		// **The direction is published in the same instant the dash is registered, so a reader cannot see
		// one without the other.** The renderer plays a dodge clip from this attribute and nothing else,
		// and it reads it on the same `AttributeChanged` connection the rest of a rig's state arrives on —
		// so writing it here is the whole of the wiring, and there is no second signal to keep in step.
		//
		// **It goes on the model rather than on the rig, and both bodies now read it.** A player's character
		// gets it too — this method runs a player's dash exactly as it runs a rig's — and the client that owns
		// that character draws the dodge from it, the way it draws a throw and a catch. **That is a change**:
		// the player's dodge used to be a flourish the *server* played, so this attribute was published for a
		// body that did not read it, and the note here said so. It has a reader on both bodies now, which is
		// what makes the four directional clips one feature rather than two. See `DODGE_DIRECTION_ATTRIBUTE`.
		//
		// **Cleared in `finish` below**, which is the only path a dash ends by, and before that happens for
		// a dash being replaced the newer one's own write comes after it — so the attribute never describes
		// a dash that is not the one in flight.
		model.SetAttribute(DODGE_DIRECTION_ATTRIBUTE, dodgeDirection);

		// Dying is the one thing that must not leave the character standing: a
		// `PlatformStand` left on is a player who cannot walk after respawning.
		diedConnection = humanoid?.Died.Connect(() => this.endDash(model));

		if (DEBUG && DEBUG_CONFIG.VERBOSE_LOGS) {
			print(
				`[Dodge] ${model.Name}: ${string.format("%.1f", DODGE_CONFIG.DISTANCE)} studs over ` +
					`${string.format("%.2f", DODGE_CONFIG.DURATION)}s at ${string.format("%.1f", DODGE_SPEED)} studs/s ` +
					`toward (${string.format("%.2f", direction.X)}, ${string.format("%.2f", direction.Y)}, ` +
					`${string.format("%.2f", direction.Z)})`,
			);
		}

		task.delay(DODGE_CONFIG.DURATION, () => {
			// Only if this dash is still the one in flight: a newer dodge replaces
			// this record, and that one's own timer is what should end it.
			if (this.dashes.get(model) === record) {
				this.endDash(model);
			}
		});
	}

	/**
	 * Ends whatever dash `model` has in flight, if any.
	 *
	 * Safe to call at any time: a dash that has already finished is no longer in
	 * the table, so this either does the work or does nothing.
	 *
	 * **Every way a dash can end arrives here**, which is why this is also the whole of how the trail is
	 * stopped: its own timer, a newer dodge replacing it ({@link startDash} ends the old one first), and its
	 * dasher dying. There is deliberately no second path that ends the emission — a stop written into the
	 * timer would leave a death mid-dash emitting for as long as the corpse existed, and one written into
	 * the death connection would leave an ordinary dash emitting for the rest of its life. Both of those are
	 * the same fault seen from opposite ends, and both are avoided by asking the question this method already
	 * asks: is this dash still the one in flight.
	 */
	private endDash(model: Model): void {
		const record = this.dashes.get(model);
		if (!record) return;

		this.dashes.delete(model);

		// When the dash stopped counting, which is *this* instant for every way one can end:
		// its own timer, a newer dodge replacing it, or its dasher dying. Stamped before the
		// cleanup so that anything the cleanup wakes sees the dash as already over.
		this.lastDodgeEndAt.set(model, os.clock());

		// **The trail stops beside the clock, and before the cleanup**, for the reason above and in that
		// order: the entry has already left the table, so `isDodging` is false from this line onwards and the
		// emitting has to have stopped with it. The ghosts already in the world are deliberately *not* this
		// line's business — each fades and destroys itself on its own timer, so a trail's tail outlives the
		// window by exactly as long as one ghost takes to fade and not a frame longer.
		//
		// Stopping an emission that was never started is the ordinary case rather than a fault: a dash that
		// ends by being replaced had its predecessor's trail stopped when that one ended a moment ago, and
		// `stopAfterimage` is a map delete either way.
		//
		// **And the trail table is keyed on the body rather than on the action, which is worth knowing here.**
		// One body has one trail however many windows it has open, so this line ends whatever trail that body
		// has — exactly right while the dodge is the only action that opens one, and a real fault while the
		// catch opened one too: a dash ending would have cut a catch's cue short. The catch's trail has since
		// been removed, so the collision is gone. **If a second action is ever given a trail, this is the line
		// that needs the split** — one trail per action rather than per body.
		stopAfterimage(model);

		record.finish();
	}

	/**
	 * **Watches the balls for the length of one dodge, and says `perfect` if one passes close enough to the
	 * place the body left — and never close enough to the place the body went.**
	 *
	 * **Why this exists at all: a dodge leaves no trace for the hit path to read.** The dash is a velocity, and
	 * the mechanics that make it work are purely geometric — the body is simply no longer where the ball was
	 * going — so by the time a ball would have touched somebody it touches nothing, and `Touched` is not called
	 * at all. `isDodging` is asked by everything that *uses* a dodge (a catch, a duck, a pickup, the action
	 * lock), and by nothing that *measures* one, because there is nothing to measure at the moment of contact.
	 * So the miss has to be observed while it is happening, and this is the only thing in the game that
	 * observes it.
	 *
	 * **The distance is measured to `origin` — where the body was standing when it dodged — and not to where
	 * the dash takes it.** That is the whole of "the ball would have hit me": the ball is not aimed at a body,
	 * it is aimed at a patch of floor, and the patch it passes through on the way is the patch the body was
	 * standing on. Measuring against the *live* position instead would count a dash that carried a body *into*
	 * a ball it was never in the way of, which is the opposite of a perfect dodge, and it would also make the
	 * figure depend on which way the dash went.
	 *
	 * **The second half of the rule is "was this body hit", and it is answered by the ball rather than by a
	 * radius.** A ball can pass within a ball's width of where a body *was* and still have hit it — a dash a step
	 * blocked, or one taken straight into the throw — and the near miss is real in both cases while "perfect
	 * dodge" is not. `BallComponent` publishes the bodies a throw has tagged, so this asks that list about this
	 * body on every frame and **ends the whole watch the moment this body appears in it**: a body that has been
	 * struck has not dodged, whatever else is in the air, and there is no caption to draw.
	 *
	 * **That check replaced a radius around the root, and it replaced it because the radius was wrong twice.**
	 * See the note where `BODY_CONTACT_RADIUS` used to be declared: a root-centred sphere misses the chest, the
	 * head and the arms, and — the fault a Studio log actually found — it cannot see a contact that happened
	 * *before the watch opened*, which is the ordinary case for a dodge taken after a hit. **281 ms**, not a
	 * frame: a body tagged at `20:15:30.512` and reported as a perfect dodge against the same body at
	 * `20:15:30.793`, because the ball had hit it, flown on, and the watch that opened afterwards could only see
	 * a ball leaving. A tag is the exact record of that contact and it survives the ball flying on, which is why
	 * the answer is the tag list and not a bigger sphere.
	 *
	 * **What the tag check does not cover, stated rather than left to be found.** A contact that produces no tag
	 * is not a contact to this test: a same-side ball (friendly fire is vetoed before any tag is written) and a
	 * ball into a practice-zone player (a practice player is not a body to a ball at all). In both cases the game
	 * itself says the ball did nothing to the body, so a pass close enough to be a near miss is a near miss —
	 * the caption can appear for a teammate's throw that goes past you. **Making that exact is a side comparison
	 * and not a geometry change**, and it is written up in `HANDOFF.md` §15 rather than done here.
	 *
	 * **And a dead body cannot have dodged anything, so the humanoid is asked every tick.** A tagged body is not
	 * killed at the tag — the tags resolve when the ball dies, and the throw can take up to a second to land — so
	 * between the two moments the body is alive, hittable and already doomed. The tag check above ends the watch
	 * for that body; this one is the backstop for every other way a body dies mid-dash (another throw, a reset, a
	 * freeze falling off a ledge), and both are needed because they answer different questions.
	 *
	 * **Per frame, and against the segment the ball travelled rather than its position.** A thrown ball does
	 * `THROW_MAX_SPEED` studs a second, which is over three studs between two frames; sampling positions alone
	 * would leave gaps wider than the threshold and miss the passes this exists to reward. The start of each
	 * segment is the ball's position on the previous turn, so the distance tested is
	 * `distance(point, segment)` — the closest the ball actually came, not the closest it was ever sampled at.
	 * The first turn seeds that map and tests nothing; the segment from the dash's own instant to it is the one
	 * frame of path this does not see, and it is skipped rather than guessed from a velocity, because a
	 * velocity's extrapolation is a *prediction* and this measurement is deliberately an observation.
	 *
	 * **The caption waits for the pass rather than for the approach, and the difference is the number in the
	 * log.** A ball inside the radius gets a *candidate* record and the watch keeps following it until the
	 * distance stops falling — that instant is the closest approach, which is the figure worth reporting:
	 * firing on the frame a ball *enters* a four-stud radius would always print something just under four,
	 * because a ball covers three studs a frame, and a tuning note that reads `3.3` for a pass that went
	 * straight through the body is worse than no note at all. It also delays the caption by a frame or two,
	 * which is the beat the ball has finished going past — the moment the player saw it.
	 *
	 * **The contact test runs over the whole window and not just the moment of the miss**, and that is a
	 * correction a simulation made rather than a guess: a ball can hit the body *on its way to* the point the
	 * body left — a dash toward an incoming throw — so a test restricted to the frames the candidate was being
	 * followed would see a clean pass and call a hit a perfect dodge. The tag check runs on every frame, for
	 * every armed ball, whether or not it is the candidate.
	 * **The candidate is the first ball to come inside the radius**, and it has the measurement to itself until
	 * it has passed. A MultiBall throw is three paths on the same schedule and they are the same dodge, so there
	 * is nothing to gain from measuring all of them — and a ball that missed perfectly is the one worth saying.
	 *
	 * **A loop rather than a `Heartbeat` connection**, like every other long-lived loop in this project: it runs
	 * for one dodge's worth of frames and then ends, and a connection that had to be hung up per body would be
	 * the same lifetime with an unsubscribe to forget. The cost is one `armedBalls()` per frame per body mid
	 * dash, which is a handful of balls and at most a few bodies.
	 *
	 * **Not `DodgeBehavior.threatAgainst`, which looks similar and answers a different question.** That test
	 * predicts, from a ball's current velocity alone, whether it *will* arrive inside a hit radius — it is a
	 * decision about whether to dodge, taken before the fact, and it solves in the plane because gravity has no
	 * horizontal component. This is an observation after it: the actual path, in three dimensions, against a
	 * point the body has already left. Sharing them would mean a function that had to be told which of the two
	 * it was answering.
	 */
	private watchForPerfectDodge(model: Model, root: BasePart, humanoid: Humanoid | undefined, origin: Vector3): void {
		/** This watch's identity — see {@link perfectWatches}, which is what a newer dodge replaces. */
		const watch = {};

		this.perfectWatches.set(model, watch);

		/** The last position seen for each ball, so each turn tests a path rather than a point. */
		const observed = new Map<BasePart, Vector3>();

		/**
		 * The ball being measured, from the frame it came inside {@link DODGE_CONFIG.PERFECT_DISTANCE} until the
		 * frame it starts leaving again, with the closest it has come so far.
		 */
		let candidate: { ball: BasePart; closest: number } | undefined;

		const deadline = os.clock() + DODGE_CONFIG.PERFECT_WINDOW_SECONDS;

		/** The miss is over and measured: say it, unless the ball is still coming for the body. */
		const settle = (ball: BasePart, closest: number) => {
			// **The window closing is not a reason to skip the death check.** The loop asks it every tick, but a
			// miss settled on the *last* tick leaves the loop and comes here, so the same question is asked once
			// more rather than assumed — a body that died with the pass is a body that did not dodge it.
			if (humanoid !== undefined && humanoid.Health <= 0) return;

			// **Still on course for the body it just missed** — see `stillOnCourse`, and note that the horizon is
			// what is left of the window rather than an arbitrary look-ahead: a ball that will be at the body
			// before this dodge stops being responsible for it was not dodged by it, and one that would arrive
			// after that is a different throw's problem.
			if (stillOnCourse(ball, root.Position, deadline - os.clock())) return;

			this.announcePerfectDodge(model, closest);
		};

		task.spawn(() => {
			while (os.clock() < deadline && this.perfectWatches.get(model) === watch) {
				// A body that has left the world has no place to have dodged from, and its window is over.
				if (root.Parent === undefined) return;

				// **A dead body has not dodged anything.** Checked every tick rather than once, because the death
				// can arrive at any point in the window and the whole feature is a claim about something that has
				// not happened to the body — a hit that did not land. See this method's note.
				if (humanoid !== undefined && humanoid.Health <= 0) return;

				for (const ball of this.balls.armedBalls()) {
					// **Struck by this ball, so this was not a dodge** — and the whole watch ends, not just this
					// ball's candidacy: the body is hit, whatever else is still in the air. This is the test a
					// radius could not make, because the contact may have happened before the dash began. See
					// `BALL_TAGGED_BODIES_ATTRIBUTE`.
					if (hasTagged(ball, model.Name)) return;

					const now = ball.Position;
					const before = observed.get(ball);

					observed.set(ball, now);

					// The seeding turn: this ball's first sighting has no path behind it yet.
					if (before === undefined) continue;

					const missedBy = distanceToSegment(origin, before, now);

					if (candidate !== undefined && candidate.ball === ball) {
						// Still closing on the point it was aimed at: keep the best figure and keep watching.
						if (missedBy <= candidate.closest) {
							candidate.closest = missedBy;

							continue;
						}

						// Moving away — that was the pass, and this is the closest it came.
						const passed = candidate;
						candidate = undefined;

						settle(passed.ball, passed.closest);

						return;
					}

					if (candidate === undefined && missedBy <= DODGE_CONFIG.PERFECT_DISTANCE) {
						candidate = { ball, closest: missedBy };
					}
				}

				task.wait();
			}

			// **The window closed with the ball still coming** — a pass at the very end of it, a ball caught or
			// destroyed mid-flight, or one that landed inside the radius. Whatever the reason, the figure held is
			// the closest this watch managed to see, and a near miss it did see is worth saying.
			if (candidate !== undefined) settle(candidate.ball, candidate.closest);
		});
	}

	/**
	 * **Says a perfect dodge happened** — to the player's own screen, and to the output for either kind of body.
	 *
	 * **The event is sent to the player and to nobody else**, on `teamWipe`'s arrangement: the caption is on the
	 * dodger's own screen, and the near miss is not news to anybody else in the arena. The name travels anyway
	 * so the receiving client makes the same `Players.LocalPlayer.Name` comparison it makes for every other
	 * event rather than trusting the addressing — see `networking.ts` on `perfectDodge`.
	 *
	 * **A rig is measured and printed and nothing more, and that is not an omission.** The rule is uniform —
	 * a rig dodges by the same code and its misses are the same fact about the same geometry — but a rig has no
	 * screen to draw on, and the one client that could draw it (the owner of the camera watching that rig) has
	 * no business being told about a near miss it was not part of. **`DodgeBehavior` needs no message either**:
	 * its dodges are decided by its own threat solve, and nothing in its AI reads a caption.
	 *
	 * **The print is unconditional for both kinds of body**, which is unusual in a file where almost everything
	 * is behind `DEBUG`. The reason is that this is the feature's *only* observable evidence: whether the
	 * threshold is right is a question only a session can answer, and a line per perfect dodge — at most one
	 * per cooldown per body — is what a run in Studio reads. The distance is in the line rather than only in
	 * the fact, because "it worked" and "it fired for a ball three studs past my shoulder" are the two
	 * findings this needs to be told apart by.
	 */
	private announcePerfectDodge(model: Model, missedBy: number): void {
		const distance = string.format("%.1f", missedBy);
		const player = Players.GetPlayerFromCharacter(model);

		if (player !== undefined) {
			events.Server.Get("perfectDodge").SendToPlayer(player, player.Name);

			print(`[Dodge] ${model.Name}: perfect dodge — the ball missed by ${distance} studs`);

			return;
		}

		print(`[Dodge] ${model.Name}: perfect dodge — the ball missed by ${distance} studs (a rig, so nothing is drawn)`);
	}
}

/**
 * How far `point` is from the segment `from`→`to` — **the closest a ball came, not the closest it was sampled
 * at.**
 *
 * A ball moves over three studs between two frames at the game's fastest throw, so the distance to a *position*
 * can be larger than {@link DODGE_CONFIG.PERFECT_DISTANCE} for a pass that went straight through it. Projecting
 * the point onto the segment and clamping to its ends is the same arithmetic a closest-approach solve does,
 * without the assumption that the thing being measured is still coming: the clamp is what makes a point beside
 * the segment's end read as "past it" rather than "on the line behind it".
 *
 * A zero-length segment is a ball that did not move — a frame of rest, or a repeat — and it is answered as a
 * distance to the point rather than by dividing by zero.
 */
function distanceToSegment(point: Vector3, from: Vector3, to: Vector3): number {
	const travel = to.sub(from);
	const lengthSquared = travel.Dot(travel);

	if (lengthSquared < 1e-6) return point.sub(to).Magnitude;

	const along = math.clamp(point.sub(from).Dot(travel) / lengthSquared, 0, 1);

	return point.sub(from.add(travel.mul(along))).Magnitude;
}

/**
 * Whether `ball` has already tagged the body named `body` — **the exact "was this body hit" question, asked of
 * the ball's own published record.**
 *
 * `BallComponent.publishTaggedBodies` writes the tagged models' names `|`-joined, so this is a substring test
 * on a string that is empty unless a tag is owed. The name is the identity every cross-service fact about a body
 * uses (`hitImpact`, `teamWipe`, `LAST_HIT_BY_*`), and a model name is the player's name for a character and the
 * rig's own for a rig, so one string answers for both kinds of body.
 *
 * **Paired with separators on purpose.** A plain `find` would let `Rig1` match `Rig10`, so the attribute is
 * wrapped in `|` before the search and the needle is wrapped to match — the same shape `OWNED_ITEMS_ATTRIBUTE`'s
 * readers use to avoid a prefix collision between two ids in one string.
 *
 * **Absent reads as "no tags"**, which is the truth for a ball that has never hit anybody and is the right answer
 * for a ball whose attribute has not replicated yet.
 */
function hasTagged(ball: BasePart, body: string): boolean {
	const tagged = ball.GetAttribute(BALL_TAGGED_BODIES_ATTRIBUTE);

	if (!typeIs(tagged, "string") || tagged === "") return false;

	return string.find(`|${tagged}|`, `|${body}|`, 1, true)[0] !== undefined;
}

/**
 * **Whether `ball` is still on course to be at a body standing at `body` within `horizon` seconds** — the veto a
 * near miss has to survive before it is called a dodge.
 *
 * **The one prediction in this file, and it exists because a measurement alone cannot tell a dodge from a
 * failure.** A ball can pass within a ball's width of where a body stood and then simply keep going into the
 * body it dodged away from — a backward dash is *along* the throw, and the ball is faster than the dash, so the
 * player sees the ball go by and then gets hit by it. That pass is real and the dodge is not, so the question
 * has to be asked after it: is that ball *going to be here*?
 *
 * **The arithmetic is `DodgeBehavior.threatAgainst`'s** — the instant of closest approach is
 * `t = dot(toBody, v) / |v|²`, positive while the ball is closing — with the two differences the question
 * needs. It is solved in **three dimensions**, because the body's height is the thing that decides whether a
 * throw goes over it, and it is evaluated with the ball's **gravity** applied at that instant, because a
 * quarter-second of fall is two studs and two studs is the whole radius being judged.
 *
 * **What it gets wrong, in `threatAgainst`'s own words**: a ball that is about to hit the floor short of the
 * body is predicted to reach it, and one curved by a super or about to bounce is predicted from its current
 * motion alone. Both are wrong in the harmless direction for a *reward* — they cost a caption rather than
 * printing one that should not exist — and the horizon is short enough (what is left of a 0.6-second window)
 * that neither has much room to develop.
 */
function stillOnCourse(ball: BasePart, body: Vector3, horizon: number): boolean {
	if (horizon <= 0) return false;

	const velocity = ball.AssemblyLinearVelocity;
	const speedSquared = velocity.Dot(velocity);

	if (speedSquared < 1e-6) return false;

	const toBody = body.sub(ball.Position);
	const time = toBody.Dot(velocity) / speedSquared;

	// Already past, or not due to arrive inside the window this dodge is responsible for.
	if (time <= 0 || time > horizon) return false;

	// Where it will actually be, gravity included: the straight-line solve names the instant, and the fall is
	// what decides whether "at the body" is true when it gets there.
	const fall = 0.5 * BALL_CONFIG.BALL_GRAVITY * time * time;
	const arrived = ball.Position.add(velocity.mul(time)).sub(new Vector3(0, fall, 0));

	return arrived.sub(body).Magnitude <= PREDICTED_HIT_RADIUS;
}
