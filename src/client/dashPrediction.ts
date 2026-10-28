import { Players, Workspace } from "@rbxts/services";
import { CATCH_READY_AT, DEV_FLAG_ATTRIBUTE_PREFIX, DODGE_DIRECTION_ATTRIBUTE, DODGE_READY_AT, DUCK_READY_AT, FROZEN_ATTRIBUTE } from "shared/constants";
import { DODGE_CONFIG, DODGE_SPEED } from "shared/config/dodge.config";
import { logDebug } from "shared/logger";

/**
 * **The client's half of a dash: the body starts moving on the frame the key was pressed, and the server
 * confirms rather than initiates.**
 *
 * `DodgeService.startDash` is the authority and is unchanged — it builds the `LinearVelocity`, the
 * `AlignOrientation` and the `Humanoid` state on the server, and every rule about *whether* a dash is
 * allowed lives in `DodgeService.requestDodge` and `blocksDodge`. What this module adds is the round trip
 * that stood between the press and the movement: the client sent a direction and then waited for the
 * server's constraint to replicate back before its body went anywhere, which is long enough for a ball that
 * the player watched arrive in front of them to land where they were standing. **That is the whole of what
 * this closes** — the server's copy of the body still lags by a replication step afterwards, so a hit
 * resolved against the place the body has just left is untouched by this file. See
 * `server/dev/HitDisagreementProbe`, which exists to measure the part this does not fix.
 *
 * **Velocity rather than `PivotTo`, for `startDash`'s reason and with one more behind it here.** The
 * server's comment argues that a teleport moves the model without moving its *motion*, so the walking
 * humanoid steers it straight back and the dash reads as a stumble. On this side there is a second reason:
 * a `PivotTo` on a client-owned character is a position the server's copy has to be talked out of, and a
 * snap-back when the prediction is refused would be a new class of jitter — visibly worse than the bug
 * this file exists to fix. So this writes **no `PivotTo`, no `CFrame` and no `WalkSpeed`**, and a refused
 * prediction simply leaves the body where the dash took it.
 *
 * ## The two failure modes, both accepted on purpose
 *
 * - **A refused prediction.** The dash the client applied is not sanctioned: no cooldown is charged, no
 *   catch lockout, no `DodgeDirection`, no afterimage, no perfect-dodge watch. The body has moved anyway,
 *   because the client owns its physics and the server's copy follows it like any other movement — so the
 *   cost of a missing gate is not "the body stays put", it is **a dash the game did not charge for**. That
 *   is why the gates below matter more than they look: each one is a way to get a free dash, and the
 *   honest player gets them by accident (a press during the catch lockout, or mid-duck) rather than by
 *   cheating.
 * - **A doubled constraint.** The server's `LinearVelocity` replicates to this machine while the local one
 *   is still alive, and two of them apply force for whatever overlap there is — at twice the speed. The
 *   teardown below is the answer, and the overlap it allows is bounded by one `DescendantAdded` callback
 *   rather than by a frame.
 * - **A state restored too early.** The three `Humanoid` writes are the client's own — `PlatformStand` is
 *   written by nothing else in the game — but `DodgeService.startDash` records what it found there, so a
 *   restore that landed between the server's write and its own would leave a body standing for good. The
 *   handover therefore defers the restore to the moment the *server's* dash ends, which is one dash later and
 *   never a frame of it lost. See the comment on that restore.
 *
 * ## The gates, and why each one is a *fact* the server also checks
 *
 * The server's answer is `requestDodge` → `blocksDodge`, and every gate here mirrors a term of it rather
 * than inventing a rule. Two of them are already asked by the caller: `DodgeController.requestDodge` has
 * checked `roundZone.inRoundOrZone` (the phase and this player's `IN_ROUND_ATTRIBUTE`, or a practice zone)
 * and that the humanoid is alive before this is reached, so they are not repeated — the same facts, asked
 * once, one file up. What is left is the four clocks and two states:
 *
 * | gate | source | what a miss would cost |
 * |---|---|---|
 * | not on the dodge's clock | `DODGE_READY_AT` on the `Player` | a free dash on every press |
 * | not inside a catch cycle | `CATCH_READY_AT` **and** the window's own lockout, one instant | a free dash during a catch |
 * | not ducking, and not in the duck's lockout | `DUCK_READY_AT` covers both | a free dash mid-duck, and a dash under the duck's anchor |
 * | not frozen | `FROZEN_ATTRIBUTE` on the body | **a frozen body moved**, which the server cannot undo |
 * | not already dashing | `DODGE_DIRECTION_ATTRIBUTE` on the body | a second constraint, so twice the speed |
 *
 * **`DODGE_READY_AT` is the one gate a dev can legitimately skip**, and it is asked with
 * `DEV_FLAG_ATTRIBUTE_PREFIX` because `NoCooldown` means the server never publishes a fresh instant at
 * all: the attribute left over from the last charged dash would refuse every prediction for as long as the
 * flag was on. The two action clocks above are deliberately *not* skipped for a dev, which is
 * `DodgeService.blocksDodge`'s own rule — `NoCooldown` buys freedom from the dodge's clock and not from the
 * rules the two actions share.
 *
 * **Every clock is compared against `Workspace.GetServerTimeNow()`**, which is the clock `readyAt.ts` wrote
 * them with. That is the whole reason the values are instants rather than durations: this machine subtracts
 * its own reading of the same clock and gets a remaining time that is right, with no correction for the
 * packet's own age. It also means these gates are a step **behind** the server by one replication interval,
 * which is the same lag that makes the dash feel late in the first place — the cooldown ring a player sees
 * is the same reading, so the two never disagree by more than the wire.
 *
 * ## What this file does not do
 *
 * It does not publish `DODGE_DIRECTION_ATTRIBUTE`, start the afterimage, play the dodge's sound or count the
 * badge — all four are the server's, and all four arrive with the server's constraint. It does not touch
 * `Trajectory`, `ThrowController` or `shared/throw.ts`: the aim guide is drawn from the throw's solve, and
 * the body's position is not an input to it. And it draws no animation: `client/bodyAnimation` reads the
 * attribute, so the clip changes when the server's dash does, which is a round trip after the move rather
 * than a round trip before it.
 */

/** The name the server gives its own constraint — `DodgeService.startDash`'s, copied here as a word. */
const SERVER_DASH_VELOCITY = "DodgeVelocity";

/** The name this module gives its own, so the teardown can tell the two apart in one `DescendantAdded`. */
const CLIENT_DASH_VELOCITY = "ClientDashVelocity";

/** And the attachment the client's constraint hangs from, named for the same reason. */
const CLIENT_DASH_ATTACHMENT = "ClientDashAttachment";

/**
 * **Placeholder — 0.5.** How long after the server's dash should have ended the deferred state restore fires
 * anyway, in seconds.
 *
 * A backstop rather than a part of the mechanism: the restore normally runs the instant the server's
 * constraint comes off the root, and this only runs if that never happens. The cost of it firing when it
 * should not is a `PlatformStand` cleared half a second late; the cost of it being absent is a body that can
 * never walk again.
 */
const HANDOVER_GRACE_SECONDS = 0.5;

/** Whether a prediction is in flight. One at a time, so two presses cannot stack into one 30-stud move. */
let inFlight = false;

/**
 * Moves `character` along `direction` locally, if every gate above says the server would allow it.
 *
 * Returns whether a prediction was applied. **A `false` here does not cancel the request** — the caller
 * sends it either way, because the server is the authority and this module only decides whether the body
 * may start moving before the answer arrives.
 *
 * Called by `DodgeController.requestDodge` on the line before `SendToServer`.
 */
export function predictDash(character: Model, direction: Vector3): boolean {
	// **The player, and a rig is not this file's business.** `DodgeService` asks the phase alone for a body
	// with no player behind it, because a rig has no membership to ask about; a client never predicts for
	// one either, and `undefined` here is that answer rather than a failure.
	const player = Players.GetPlayerFromCharacter(character);
	if (player === undefined) return false;

	if (inFlight) {
		logDebug(`[Dash] ${character.Name}: a prediction is already in flight`);

		return false;
	}

	// **The body's own clock**, which is the server's dash in its last frame or two as replication delivers
	// it. Asked before the action clocks because it is the one that answers "is a dash happening right now",
	// and a second constraint is the one failure this file can cause that the server cannot see.
	if (character.GetAttribute(DODGE_DIRECTION_ATTRIBUTE) !== undefined) {
		logDebug(`[Dash] ${character.Name}: already dashing — the server's dash is up`);

		return false;
	}

	if (character.GetAttribute(FROZEN_ATTRIBUTE) === true) {
		logDebug(`[Dash] ${character.Name}: frozen — a prediction would move a body the server is holding`);

		return false;
	}

	const noCooldown = player.GetAttribute(DEV_FLAG_ATTRIBUTE_PREFIX + "NoCooldown") === true;

	if (!noCooldown && onCooldown(player, DODGE_READY_AT)) return false;

	// Deliberately not skipped for a dev, which is `DodgeService.blocksDodge`'s rule for both of these.
	if (onCooldown(player, CATCH_READY_AT)) return false;
	if (onCooldown(player, DUCK_READY_AT)) return false;

	const humanoid = character.FindFirstChildWhichIsA("Humanoid");
	const root = humanoid?.RootPart;
	if (!humanoid || !root || humanoid.Health <= 0) return false;

	// **Flattened and re-normalized here as well as at the request**, for `startDash`'s reason: a dash is a
	// ground move, and the speed comes from a unit vector, so a caller handing over an unnormalized one would
	// move the body further than the server's dash would.
	const flat = new Vector3(direction.X, 0, direction.Z);
	if (flat.Magnitude < 0.01) return false;

	inFlight = true;

	const wasPlatformStanding = humanoid.PlatformStand;

	// The plain velocity again: spin from a jump or a turn would otherwise tip the dash over.
	root.AssemblyAngularVelocity = Vector3.zero;

	// **The humanoid's own balance taken away for the move**, exactly as the server does it. Without this the
	// walk controller steers toward whatever is held on the keys and fights the constraint for the whole
	// 0.2 s; the fall states are switched off so a shove during the dash cannot put the body on the floor
	// with no balance to get up with.
	humanoid.SetStateEnabled(Enum.HumanoidStateType.FallingDown, false);
	humanoid.SetStateEnabled(Enum.HumanoidStateType.Ragdoll, false);
	humanoid.PlatformStand = true;

	const attachment = new Instance("Attachment");
	attachment.Name = CLIENT_DASH_ATTACHMENT;
	attachment.Parent = root;

	const velocity = new Instance("LinearVelocity");
	velocity.Name = CLIENT_DASH_VELOCITY;
	velocity.Attachment0 = attachment;
	velocity.RelativeTo = Enum.ActuatorRelativeTo.World;
	velocity.MaxForce = math.huge;
	velocity.VectorVelocity = flat.Unit.mul(DODGE_SPEED);
	velocity.Parent = root;

	let finished = false;
	let restored = false;
	let handoff: RBXScriptConnection | undefined;
	let handedBack: RBXScriptConnection | undefined;

	/**
	 * Puts the three `Humanoid` writes back, once.
	 *
	 * **`PlatformStand` is written by nothing else in this game**, which is what makes a
	 * restore to `false` safe to do at any moment: `FreezeService` refuses `PlatformStand` by name and
	 * `CatchBehavior` refuses it beside `AutoRotate`, both with the argument that a standing humanoid still
	 * falls, so a dash is the only thing that ever turns it on. That matters because of a race the server
	 * cannot see: `DodgeService.startDash` records `wasPlatformStanding` from *its* copy of the humanoid, and
	 * if a client's own write ever reached it the server would record `true` and hand the body back standing
	 * — a player who cannot walk, which is the failure that method's own comment warns about. Restoring on
	 * this side clears that state whatever the answer to that question turns out to be.
	 */
	const restoreState = () => {
		if (restored) return;

		restored = true;

		handedBack?.Disconnect();
		handedBack = undefined;

		// The humanoid can be gone by now: a character removed mid-dash takes its own state with it.
		if (humanoid.Parent === undefined) return;

		humanoid.PlatformStand = wasPlatformStanding;
		humanoid.SetStateEnabled(Enum.HumanoidStateType.FallingDown, true);
		humanoid.SetStateEnabled(Enum.HumanoidStateType.Ragdoll, true);
	};

	/**
	 * Ends the prediction, once.
	 *
	 * **`handedOff` decides *when* the state is restored, and the difference is a race rather than tidiness.**
	 * With nothing to hand over to, the clock has run out on a dash nobody sanctioned and the three state
	 * writes are ours to take back immediately or the body cannot walk. With a server dash in hand, the server
	 * is about to set `PlatformStand` itself and will clear it at its own `endDash`; restoring on this frame
	 * would race that write for the same property and the loser would be whichever packet landed second. So
	 * the restore is deferred to the moment the *server's* dash ends — its constraint being removed from the
	 * root — which is the same instant one dash later and never a lost frame of it.
	 */
	const finish = (handedOff: boolean) => {
		if (finished) return;

		finished = true;
		inFlight = false;

		handoff?.Disconnect();
		handoff = undefined;

		velocity.Destroy();
		attachment.Destroy();

		if (!handedOff) {
			restoreState();

			return;
		}

		handedBack = root.ChildRemoved.Connect((child) => {
			if (!child.IsA("LinearVelocity")) return;
			if (child.Name !== SERVER_DASH_VELOCITY) return;

			restoreState();
		});

		// **And a backstop, because the alternative to a late restore is a body that never walks again.**
		// A server dash that ends without its constraint coming back off this root — a dash replaced by a
		// newer one, a death mid-dash, an instance removed some way `ChildRemoved` does not describe — would
		// otherwise leave `PlatformStand` on for the rest of the session, which is unplayable rather than
		// merely wrong. One dash's length plus half a second is long enough that it can only fire when
		// something has gone wrong.
		task.delay(DODGE_CONFIG.DURATION + HANDOVER_GRACE_SECONDS, restoreState);
	};

	// **The handover, watched on the root and filtered by name, because the name is the only handle the two
	// constraints have.** The alternative was `DODGE_DIRECTION_ATTRIBUTE` going non-empty, and it is the
	// worse trigger on both of its edges: `startDash` writes the attribute *after* it creates the three
	// instances, and a property change and an instance creation are not promised to arrive in the same
	// packet — so on a bad ordering the attribute would light up a frame after the server's force had
	// already arrived, leaving both constraints applying for that frame. In the other direction the
	// attribute is cleared at `endDash`, which is a moment this one has already finished by.
	handoff = root.DescendantAdded.Connect((descendant) => {
		if (!descendant.IsA("LinearVelocity")) return;
		if (descendant.Name !== SERVER_DASH_VELOCITY) return;

		finish(true);
	});

	task.delay(DODGE_CONFIG.DURATION, () => finish(false));

	logDebug(`[Dash] ${character.Name}: predicted locally — the server's dash has not arrived yet`);

	return true;
}

/**
 * Whether `attribute` on `player` names an instant that has not passed yet.
 *
 * **Absent means ready**, which is `readyAt.ts`'s contract: the writer publishes a deadline and nothing
 * clears it, so a body that has never caught, ducked or dashed carries no attribute and is not being held
 * by anything. A value that is not a number is treated the same way — the attribute is only ever written by
 * `publishReadyAt` and `extendReadyAt`, and a reader that invented a cooldown out of a malformed value
 * would refuse a dash nobody is charging for.
 */
function onCooldown(player: Player, attribute: string): boolean {
	const readyAt = player.GetAttribute(attribute);

	return typeIs(readyAt, "number") && Workspace.GetServerTimeNow() < readyAt;
}
