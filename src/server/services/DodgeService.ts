import { OnStart, Service } from "@flamework/core";
import { Players } from "@rbxts/services";
import { ACTION_CONFIG } from "shared/config/action.config";
import { DODGE_CONFIG, DODGE_SPEED } from "shared/config/dodge.config";
import { CATCH_READY_AT, DODGE_READY_AT } from "shared/constants";
import { canDodge, flattenToGround, resolveDodgeable } from "shared/dodge";
import type { Dodgeable } from "shared/dodge";
import { events } from "shared/networking";
import { lockoutElapsed } from "../actionLock";
import { DevService } from "../dev/DevService";
import { extendReadyAt, publishReadyAt } from "../readyAt";

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

	constructor(private readonly dev: DevService) {}

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
	 * Returns whether the model moved. Everything that decides that — the model
	 * having a living humanoid, being off cooldown and having been given a usable
	 * direction — is checked here, so a caller cannot half-ask, and the
	 * direction is normalized rather than trusted: a client can send anything, and
	 * the only thing its direction is allowed to decide is which way the dash goes.
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

				if (DEBUG) {
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

		// Dying is the one thing that must not leave the character standing: a
		// `PlatformStand` left on is a player who cannot walk after respawning.
		diedConnection = humanoid?.Died.Connect(() => this.endDash(model));

		if (DEBUG) {
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
	 */
	private endDash(model: Model): void {
		const record = this.dashes.get(model);
		if (!record) return;

		this.dashes.delete(model);

		// When the dash stopped counting, which is *this* instant for every way one can end:
		// its own timer, a newer dodge replacing it, or its dasher dying. Stamped before the
		// cleanup so that anything the cleanup wakes sees the dash as already over.
		this.lastDodgeEndAt.set(model, os.clock());

		record.finish();
	}
}
