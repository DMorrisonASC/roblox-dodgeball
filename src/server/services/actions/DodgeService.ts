import { OnStart, Service } from "@flamework/core";
import { Players, ReplicatedStorage } from "@rbxts/services";
import { startAfterimage, stopAfterimage } from "shared/afterimage";
import { ACTION_CONFIG } from "shared/config/action.config";
import { DODGE_CONFIG, DODGE_SPEED } from "shared/config/dodge.config";
import { DEBUG_CONFIG } from "shared/config/debug.config";
import { SOUND_CONFIG } from "shared/config/sound.config";
import { CATCH_READY_AT, DODGE_READY_AT, PRACTICE_ZONE_ATTRIBUTE, ROUND_STATE_ATTRIBUTE, ROUND_STATUS_FOLDER } from "shared/constants";
import { canDodge, flattenToGround, resolveDodgeable } from "shared/dodge";
import type { Dodgeable } from "shared/dodge";
import { events } from "shared/networking";
import { lockoutElapsed } from "./actionLock";
import { DevService } from "../../dev/DevService";
import { FreezeService } from "./FreezeService";
import { extendReadyAt, publishReadyAt } from "./readyAt";
import { emitSound } from "../ball/SoundEmitter";

/** Prints what every dodge request did, and why it did nothing. */
const DEBUG = true;

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
 * The animation id a dodge plays on a rig of `rigType`.
 *
 * One id per rig type, both from {@link DODGE_CONFIG} so the pair that swaps out when
 * a real clip is bought is in one place. The choice is not cosmetic: an R6 clip never
 * loads onto an R15 rig, so the wrong answer here is a dodge that silently does
 * nothing rather than one that looks slightly off.
 */
function dodgeAnimationId(rigType: Enum.HumanoidRigType): string {
	return rigType === Enum.HumanoidRigType.R15
		? DODGE_CONFIG.DODGE_ANIMATION_R15
		: DODGE_CONFIG.DODGE_ANIMATION_R6;
}

/**
 * Plays `character`'s dodge flourish and hands back the track playing it.
 *
 * Played from the **server** on purpose: a track started here replicates to every
 * client, so the other players see the dodge rather than only the one who asked for
 * it. A track started on the client would be that client's private flourish.
 *
 * **Never waited on.** `Play` returns at once and the clip streams in behind the dash,
 * which is what lets the caller apply the dash velocity without gating it on an asset
 * that may not be cached. The dash is the authoritative part; this is a visual.
 *
 * The `Animator` is looked up rather than assumed — a modern character already carries
 * one, but a bare rig may not, and a track cannot be loaded without it.
 *
 * The returned track is the caller's to stop: it owns the lifecycle, because only the
 * caller knows when the dash it belongs to is over. Nothing is cached between dodges —
 * a fresh `Animation` and a fresh track each time, and the engine deduplicates the
 * identical asset id underneath.
 *
 * **This never raises, and it may return nothing.** That is the whole contract, and it
 * is load-bearing rather than defensive: a flourish is a *visual*, and the one thing it
 * must never be able to do is take the dash down with it. A load that fails — an asset
 * the place does not own, a moderated one, a mistyped id — would otherwise fall straight
 * out of `startDash` and strand the dash constraints on the character, which is how a
 * dodge turns into a character that flies away and never comes back.
 */
function playDodgeAnimation(character: Model, humanoid: Humanoid): AnimationTrack | undefined {
	const animationId = dodgeAnimationId(humanoid.RigType);

	// An empty id is the *off* switch, and a legitimate one: it is what the config holds
	// between taking the placeholder out and putting the bought clip in. Checked before
	// the loader sees it, because `LoadAnimation` raises on an empty id rather than
	// quietly playing nothing.
	if (animationId === "") {
		if (DEBUG) print(`[Dodge] ${character.Name}: no dodge animation set for this rig`);
		return undefined;
	}

	let track: AnimationTrack | undefined;

	// Everything the loader touches is inside the `pcall`, and the error is reported
	// rather than swallowed: a flourish that cannot play is worth a line in the output,
	// but it is never worth a broken dash. The empty-id check above is the common case
	// and it does not even reach here.
	const [ok, err] = pcall(() => {
		const animator = humanoid.FindFirstChildOfClass("Animator") ?? new Instance("Animator");

		// Only a rig that arrived without one is parented here: a character's own animator
		// is already on the humanoid, and moving it would be pointless. Built first and
		// attached after, because this codebase's `Instance` constructor is not given a
		// property table.
		if (animator.Parent === undefined) animator.Parent = humanoid;

		const animation = new Instance("Animation");
		animation.Name = "DodgeAnimation";
		animation.AnimationId = animationId;

		const loaded = animator.LoadAnimation(animation);

		// Above the movement animations, so the dodge is not fought by the walk or run the
		// humanoid happened to be playing when the dash started: the flourish takes priority
		// for as long as it is on, and hands control back when it is stopped.
		loaded.Priority = Enum.AnimationPriority.Action;

		loaded.Play();

		track = loaded;
	});

	if (!ok) {
		warn(
			`[Dodge] ${character.Name}: the dodge animation ${animationId} would not load: ${tostring(err)}`,
		);
		return undefined;
	}

	if (DEBUG) print(`[Dodge] ${character.Name}: playing ${animationId}`);

	return track;
}

/**
 * Stops a dodge track, if there is still a track to stop.
 *
 * A character can be destroyed mid-dash — dying is the ordinary way — and that takes
 * its `Animator`, and every track loaded onto it, down with it. Stopping a track whose
 * animator has gone raises, and a death is not exceptional, so the guard is not
 * optional: it is what keeps a dodge that ends in death quiet in the output.
 */
function stopDodgeAnimation(track: AnimationTrack): void {
	if (track.Parent === undefined) return;

	track.Stop();
}

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

	constructor(private readonly dev: DevService, private readonly freezes: FreezeService) {}

	/**
	 * Hands this service the catch window it has to respect. Called by `CatchService` itself.
	 *
	 * A handover rather than a subscription: there is one catch window and it has one owner,
	 * so whatever is passed here is what a dodge is gated on from then on.
	 */
	public watchCatchState(state: CatchState): void {
		this.catchState = state;
	}

	public onStart() {
		events.Server.OnEvent("dodge", (player, direction) => {
			if (DEBUG) print(`[Dodge] ${player.Name} asked to dodge ${direction}`);

			const character = player.Character;
			if (!character) {
				if (DEBUG) print(`[Dodge] ${player.Name}: no character to move`);
				return;
			}

			this.requestDodge(character, direction);
		});
	}

	/**
	 * Asks for `model` to dodge `direction`.
	 *
	 * Returns whether the model moved. Everything that decides that — a round being played, the model
	 * having a living humanoid, being off cooldown and having been given a usable direction — is checked
	 * here, so a caller cannot half-ask, and the direction is normalized rather than trusted: a client can
	 * send anything, and the only thing its direction is allowed to decide is which way the dash goes.
	 */
	public requestDodge(model: Model, direction: Vector3): boolean {
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

		// **The state gate: a round has to be being played, or this body has to be in a practice zone.**
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
		// **Placed here, before the cooldown is read or charged**, which is the position `blocksDodge`
		// occupies and for the reason that method gives: a dodge that was never allowed has not happened, so
		// it must not be charged for one. `blocksDodge` keeps the first word of the two — a freeze is a
		// state about the *body*, and this one is about where the body is and what the round is doing.
		//
		// The two halves come from different places on purpose. The round is read from the round folder,
		// which is how every other reader on this side gets at it, and it is the *same* source the client's
		// half reads — so the two sides cannot disagree about what the round is doing. The zone is read from
		// the player, which is how every other consumer gets at *that*, and it is likewise the client's
		// source once the tracker's fact has replicated. A folder that is not there yet reads as "no round"
		// and a player who has never been in a zone carries no attribute; both are the right answer while
		// the server is still igniting.
		const status = ReplicatedStorage.FindFirstChild(ROUND_STATUS_FOLDER);
		const playing = status?.GetAttribute(ROUND_STATE_ATTRIBUTE) === PLAYING;

		if (!playing) {
			const player = Players.GetPlayerFromCharacter(model);
			const inZone = player !== undefined && player.GetAttribute(PRACTICE_ZONE_ATTRIBUTE) === true;

			if (!inZone) {
				if (DEBUG) print(`[Dodge] ${model.Name}: refused — no round, and not in a practice zone`);

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

		this.startDash(model, entity, heading);

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
	private startDash(model: Model, entity: Dodgeable, heading: Vector3): void {
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

		// Declared here and started at the *end* of this method, once the dash is
		// registered and its cleanup is armed. The animation is the only part of a dash
		// that can fail on something outside our control — an asset that will not load —
		// so it is deliberately the last thing to run: by the time it can raise, `endDash`
		// is already able to undo the constraints below, and a broken flourish costs the
		// flourish and nothing else. The `finish` closure reads this by reference, and it
		// only ever runs after the assignment, so the late start is safe.
		let track: AnimationTrack | undefined;

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

				// The flourish goes with the dash, and it is stopped **after** the mechanics
				// are already undone — deliberately, and for the same reason the animation is
				// started last: the velocity that carries the dash is the one thing here that
				// has to come off no matter what, so the visual is the final step rather than
				// something that could stand between the dash and its own cleanup. Stopped
				// rather than left to finish its clip, because `DODGE_CONFIG.DURATION` is
				// shorter than the placeholder and a clip allowed to run on would keep
				// swinging after the character had stopped moving. A clip shorter than the
				// dash is already over here and the stop is a no-op; either way the visual
				// ends exactly when the move does.
				if (track) stopDodgeAnimation(track);

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

		// Last, on purpose. See the declaration above: the dash is registered and its
		// cleanup is armed before the one step that depends on an external asset runs, so
		// a flourish that cannot play can never leave a character flying.
		track = humanoid ? playDodgeAnimation(model, humanoid) : undefined;
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
		stopAfterimage(model);

		record.finish();
	}
}
