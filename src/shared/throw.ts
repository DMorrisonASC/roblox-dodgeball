import { Workspace } from "@rbxts/services";
import { BALL_SIZE, THROW_ARC_SPREAD, THROW_MAX_SPEED, THROW_MUZZLE_DISTANCE, THROW_SPEED } from "shared/constants";
import { LaunchPlan, minimumReachSpeed, planLaunch, ThrowArc } from "shared/Trajectory";

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

/** How far the ball's edge sits from the point its centre is aimed at. */
const BALL_RADIUS = BALL_SIZE / 2;

/**
 * The point to aim the ball's *centre* at so that its *surface* arrives at
 * `target`.
 *
 * A ball stops when its edge touches something — a full radius before its
 * centre gets there. How far short that is depends on the angle it arrives at,
 * so a flat throw and a lobbed one would otherwise stop in visibly different
 * places even though the solve says they land together. Aiming the centre one
 * radius out along the surface normal removes the approach angle from the
 * answer entirely.
 *
 * The normal comes from a ray down the aim line, which both sides can cast for
 * themselves. No extra data crosses the wire, and the server never has to trust
 * the client for it.
 */
function centreAimPoint(character: Model, muzzle: Vector3, target: Vector3): Vector3 {
	const params = new RaycastParams();
	params.FilterType = Enum.RaycastFilterType.Exclude;
	params.FilterDescendantsInstances = [character];
	params.IgnoreWater = true;

	const hit = Workspace.Raycast(muzzle, target.sub(muzzle), params);
	// When the aim line is blocked, assume level ground — the usual landing
	// anyway. Being one radius out in the wrong direction is bounded and small.
	const normal = hit ? hit.Normal : new Vector3(0, 1, 0);

	return target.add(normal.mul(BALL_RADIUS));
}

/**
 * Plans a player's throw at `target` by solving the arc from the muzzle.
 *
 * The throw is at {@link THROW_SPEED} for anything within its reach, and only
 * winds up harder when the target is genuinely further than that can carry —
 * up to {@link THROW_MAX_SPEED}. Without this, anything past ~51 studs silently
 * fell back to a 45° lob that landed short of where you aimed.
 *
 * The reach figure carries {@link THROW_ARC_SPREAD}, which sets how far apart
 * the two arcs sit and keeps the solve off the discriminant-zero knife edge.
 * See that constant for both jobs.
 *
 * `arc` is which of the two the player asked for. It changes the shape and the
 * duration of the flight, never the landing: both roots reach the same point,
 * which is what makes it safe to let the player choose.
 */
export function planPlayerThrow(character: Model, target: Vector3, arc: ThrowArc): LaunchPlan {
	const muzzle = getThrowMuzzle(character);
	const aim = centreAimPoint(character, muzzle, target);
	const needed = minimumReachSpeed(muzzle, aim) * THROW_ARC_SPREAD;
	const speed = math.clamp(needed, THROW_SPEED, THROW_MAX_SPEED);

	return planLaunch(muzzle, aim, speed, arc);
}
