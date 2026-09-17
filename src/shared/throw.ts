import { THROW_MAX_SPEED, THROW_MUZZLE_DISTANCE, THROW_REACH_HEADROOM, THROW_SPEED } from "shared/constants";
import { LaunchPlan, minimumReachSpeed, planLaunch } from "shared/Trajectory";

/**
 * How a player's throw is planned. This is the game's rulebook, kept in one
 * place so the server (which applies the throw for real) and the client (which
 * predicts it for the aim guide) can never disagree.
 */

/**
 * Parts checked, in order, for the thrower's torso.
 *
 * R15 rigs have `UpperTorso`, R6 rigs have `Torso`; `HumanoidRootPart` catches
 * anything custom.
 */
const TORSO_PARTS = ["UpperTorso", "Torso", "HumanoidRootPart"];

/**
 * Where a throw starts: {@link THROW_MUZZLE_DISTANCE} studs in front of the
 * thrower's torso.
 *
 * The torso, not the head. The head is animated, so idle turns — looking left
 * and right — visibly swing the launch point around. The torso only moves when
 * the body itself does, so the ball always leaves from the same place relative
 * to the player no matter what the head is doing.
 *
 * The *direction* comes from the `HumanoidRootPart` rather than the torso.
 * Motor6Ds hang off the root, so animation moves the torso but never the root —
 * and because this offset is a multi-stud lever, any torso rotation gets
 * multiplied into the launch point several times over, which shows up as the
 * aim guide wobbling along with the walk cycle. The root's facing only changes
 * when the character itself actually turns.
 *
 * When a throw animation lands, this is the seam it plugs into: return the
 * animated hand's release point instead, and nothing else has to change.
 */
export function getThrowMuzzle(character: Model): Vector3 {
	const anchor = findTorso(character);
	if (!anchor) {
		warn(`[Throw] ${character.Name}: no torso, throwing from the pivot`);
		return character.GetPivot().Position;
	}

	const root = character.FindFirstChild("HumanoidRootPart");
	const forward = root && root.IsA("BasePart") ? root.CFrame.LookVector : anchor.CFrame.LookVector;

	return anchor.CFrame.Position.add(forward.mul(THROW_MUZZLE_DISTANCE));
}

function findTorso(character: Model): BasePart | undefined {
	for (const name of TORSO_PARTS) {
		const part = character.FindFirstChild(name);
		if (part && part.IsA("BasePart")) return part;
	}

	return undefined;
}

/**
 * Plans a player's throw at `target` by solving the arc from the muzzle.
 *
 * The throw is at {@link THROW_SPEED} for anything within its reach, and only
 * winds up harder when the target is genuinely further than that can carry —
 * up to {@link THROW_MAX_SPEED}. Without this, anything past ~51 studs silently
 * fell back to a 45° lob that landed short of where you aimed.
 *
 * The reach figure carries {@link THROW_REACH_HEADROOM}. Solving for the exact
 * minimum puts the discriminant at zero and the target at the arc's limit, and
 * the answer then depends on floating-point noise — which showed up as the
 * landing marker wandering about on long throws but sitting still on short
 * ones.
 */
export function planPlayerThrow(character: Model, target: Vector3): LaunchPlan {
	const muzzle = getThrowMuzzle(character);
	const needed = minimumReachSpeed(muzzle, target) * THROW_REACH_HEADROOM;
	const speed = math.clamp(needed, THROW_SPEED, THROW_MAX_SPEED);

	return planLaunch(muzzle, target, speed);
}
