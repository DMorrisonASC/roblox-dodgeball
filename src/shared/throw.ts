import { THROW_CLEARANCE, THROW_SPEED } from "shared/constants";
import { LaunchPlan, planLaunch } from "shared/Trajectory";

/**
 * How a player's throw is planned. This is the game's rulebook, kept in one
 * place so the server (which applies the throw for real) and the client (which
 * predicts it for the aim guide) can never disagree.
 */

/**
 * The point a throw is measured from.
 *
 * Deliberately not the ball's position: the ball sits in a hand that hangs
 * beside the body, so an offset measured from there can point straight across
 * your own chest. The head sits on the body's centre line, so offsetting from
 * it always moves outward, whichever way you aim.
 *
 * It also happens to sit on the camera's line, which is where the mouse ray
 * comes from — so the arc solves against the same viewpoint you aimed with.
 */
export function getThrowMuzzle(character: Model): Vector3 {
	const head = character.FindFirstChild("Head");
	if (head && head.IsA("BasePart")) return head.Position;

	const root = character.FindFirstChild("HumanoidRootPart");
	if (root && root.IsA("BasePart")) return root.Position;

	return character.GetPivot().Position;
}

/**
 * Plans a player's throw at `target`: solves the arc, then pushes the start
 * point {@link THROW_CLEARANCE} studs along the throw so the ball leaves from
 * in front of the thrower rather than through them.
 *
 * When a throw animation lands later, this is the seam it plugs into — the
 * muzzle becomes the animated hand release point instead of the head, and
 * nothing else has to change.
 */
export function planPlayerThrow(character: Model, target: Vector3): LaunchPlan {
	return planLaunch(getThrowMuzzle(character), target, THROW_SPEED, THROW_CLEARANCE);
}
