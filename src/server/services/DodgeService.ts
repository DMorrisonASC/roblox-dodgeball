import { OnStart, Service } from "@flamework/core";
import { DODGE_COOLDOWN, DODGE_DISTANCE, DODGE_DURATION, DODGE_SPEED } from "shared/constants";
import { canDodge, flattenToGround, resolveDodgeable } from "shared/dodge";
import type { Dodgeable } from "shared/dodge";
import { events } from "shared/networking";

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

		const now = os.clock();
		const last = this.lastDodgeAt.get(model);
		if (last !== undefined && now - last < DODGE_COOLDOWN) {
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
		// requests can both pass the check.
		this.lastDodgeAt.set(model, now);

		this.startDash(model, entity, heading);

		return true;
	}

	/**
	 * Builds the dash itself: a `LinearVelocity` on the root, held for
	 * {@link DODGE_DURATION} and then destroyed.
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

		// Where the constraint is anchored. A world-relative constraint does not
		// care where that is, only that it exists.
		const attachment = new Instance("Attachment");
		attachment.Name = "DodgeAttachment";
		attachment.Parent = root;

		const velocity = new Instance("LinearVelocity");
		velocity.Name = "DodgeVelocity";
		velocity.Attachment0 = attachment;
		velocity.RelativeTo = Enum.ActuatorRelativeTo.World;
		// Unopposed, so the dash wins its half second outright instead of racing
		// gravity and the humanoid's own push for it.
		velocity.MaxForce = math.huge;
		velocity.VectorVelocity = heading.mul(DODGE_SPEED);
		velocity.Parent = root;

		// The walk controller keeps steering toward whatever is held on WASD, which
		// bends the dash into a curve. Platform stand switches it off for the
		// duration — and is put back to whatever it was, not just to `false`.
		const wasPlatformStanding = humanoid?.PlatformStand ?? false;
		if (humanoid) {
			humanoid.PlatformStand = true;
		}

		const start = root.Position;
		let diedConnection: RBXScriptConnection | undefined;

		const record: ActiveDash = {
			finish: () => {
				diedConnection?.Disconnect();
				diedConnection = undefined;

				velocity.Destroy();
				attachment.Destroy();

				// The humanoid may be gone by now: a character can be removed mid-dash.
				if (humanoid && humanoid.Parent !== undefined) {
					humanoid.PlatformStand = wasPlatformStanding;
				}

				if (DEBUG) {
					// What actually moved, against what was asked for. The two match
					// unless something else got a hold of the character mid-dash.
					const travelled =
						new Vector3(root.Position.X - start.X, 0, root.Position.Z - start.Z).Magnitude;

					print(
						`[Dodge] ${model.Name}: dashed ${string.format("%.1f", travelled)} of ` +
							`${string.format("%.1f", DODGE_DISTANCE)} studs`,
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
				`[Dodge] ${model.Name}: ${string.format("%.1f", DODGE_DISTANCE)} studs over ` +
					`${string.format("%.2f", DODGE_DURATION)}s at ${string.format("%.1f", DODGE_SPEED)} studs/s ` +
					`toward (${string.format("%.2f", heading.X)}, ${string.format("%.2f", heading.Y)}, ` +
					`${string.format("%.2f", heading.Z)})`,
			);
		}

		task.delay(DODGE_DURATION, () => {
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
		record.finish();
	}
}
