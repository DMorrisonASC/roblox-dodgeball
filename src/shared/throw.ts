import { THROW_MUZZLE_DISTANCE, THROW_SPEED } from "shared/constants";
import { LaunchPlan, planLaunch } from "shared/Trajectory";

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
 * thrower's torso, along the direction the torso is facing.
 *
 * The torso, not the head. The head is animated, so idle turns — looking left
 * and right — visibly swing the launch point around. The torso only moves when
 * the body itself does, so the ball always leaves from the same place relative
 * to the player no matter what the head is doing.
 *
 * When a throw animation lands, this is the seam it plugs into: return the
 * animated hand's release point instead, and nothing else has to change.
 */
export function getThrowMuzzle(character: Model): Vector3 {
	const torso = findTorso(character);
	if (torso) {
		return torso.CFrame.Position.add(torso.CFrame.LookVector.mul(THROW_MUZZLE_DISTANCE));
	}

	warn(`[Throw] ${character.Name}: no torso, throwing from the pivot`);
	return character.GetPivot().Position;
}

function findTorso(character: Model): BasePart | undefined {
	for (const name of TORSO_PARTS) {
		const part = character.FindFirstChild(name);
		if (part && part.IsA("BasePart")) return part;
	}

	return undefined;
}

/**
 * Plans a player's throw at `target`: solves the arc from the muzzle to the
 * target at the game's throw speed.
 */
export function planPlayerThrow(character: Model, target: Vector3): LaunchPlan {
	return planLaunch(getThrowMuzzle(character), target, THROW_SPEED);
}
