import { Workspace } from "@rbxts/services";
import { BALL_SIZE } from "shared/constants";
import { BALL_CONFIG } from "shared/config/ball.config";
import { LaunchPlan, flatLaunchSpeed, leftAxis, minimumReachSpeed, planLaunch, ThrowArc } from "shared/Trajectory";

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
 * The part the launch point's *height* is taken from.
 *
 * The same name on both rigs, which is why there is no list beside {@link TORSO_PARTS}: R6 calls it
 * `Head` and so does R15.
 */
const HEAD_PART = "Head";

/**
 * Where a throw starts: level with the thrower's head, {@link BALL_CONFIG.THROW_MUZZLE_DISTANCE} studs
 * in front of the thrower's torso.
 *
 * **The head's height, the torso's position, and the split between them is the whole point.** Taking
 * the launch point *from the head* is what let idle turns — looking left and right — visibly swing it
 * around the player, because the head is animated and the torso is not. Dropping to the torso alone
 * fixes the swing and puts the ball out of a chest, which is lower than where a throw reads as coming
 * from. So the *position and facing* come from the body, which does not move with the head, and the
 * *height* comes from the head — a number that barely changes when it turns, and one that is measured
 * rather than written down because it is the part of this that differs between rigs: an R15 head and an
 * R6 head are not carried at the same height above the part this function measures from, and the exact
 * difference in studs is not something to write down here and keep true. Reading the offset instead of
 * naming it follows both rigs, and any custom one, without a number to maintain.
 *
 * The *direction* comes from the `HumanoidRootPart` rather than the torso. Motor6Ds hang off the root,
 * so animation moves the torso but never the root — and because this offset is a multi-stud lever, any
 * torso rotation gets multiplied into the launch point several times over, which shows up as the aim
 * guide wobbling along with the walk cycle. The root's facing only changes when the character itself
 * actually turns.
 *
 * A character with no head of its own throws from torso height rather than not throwing at all: the
 * offset is zero, which is what this function did before the head was read at all. Nothing is printed
 * for that case, and the reason is the caller: this runs once per frame per client while the aim guide
 * is up, so a line per frame is not a report.
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

	// Read from the head's own position rather than from its size or a rig table: what is wanted is the
	// height it is actually carried at, which is the whole reason the head is consulted instead of the
	// torso.
	const head = character.FindFirstChild(HEAD_PART);
	const height = head !== undefined && head.IsA("BasePart") ? head.Position.Y - anchor.Position.Y : 0;

	const muzzle = anchor.CFrame.Position.add(forward.mul(BALL_CONFIG.THROW_MUZZLE_DISTANCE));

	return muzzle.add(new Vector3(0, height, 0));
}

function findTorso(character: Model): BasePart | undefined {
	for (const name of TORSO_PARTS) {
		const part = character.FindFirstChild(name);
		if (part && part.IsA("BasePart")) return part;
	}

	return undefined;
}

/**
 * Why the muzzle is where it is, as one line for the throw log.
 *
 * **The same two readings `getThrowMuzzle` adds up, named.** The number that matters is the rise — the
 * head's height above the part the muzzle is anchored to — because a muzzle at the anchor's own height
 * throws the ball out of the chest, and everything about the throw still works when it does. That is
 * the failure this offset exists to prevent and the one nothing else in the game prints: `getThrowMuzzle`
 * cannot say it (the client calls it once a frame while the aim guide is up, so a print there is not a
 * report), and the ball's flight does not reveal its own starting height against a body whose
 * proportions nobody has written down.
 *
 * Called once per throw, from the throw path. Delete it when the offset is trusted.
 */
export function describeMuzzle(character: Model): string {
	const anchor = findTorso(character);
	const head = character.FindFirstChild(HEAD_PART);
	const headIsPart = head !== undefined && head.IsA("BasePart");

	const anchorY = anchor ? anchor.Position.Y : 0;
	const headY = headIsPart ? (head as BasePart).Position.Y : anchorY;

	return (
		`${anchor ? anchor.Name : "no anchor"} y ${string.format("%.2f", anchorY)}, ` +
		`head ${headIsPart ? `y ${string.format("%.2f", headY)}` : "NOT FOUND"} ` +
		`(rise ${string.format("%.2f", headY - anchorY)})`
	);
}

/** How far the ball's edge sits from the point its centre is aimed at. */
const BALL_RADIUS = BALL_SIZE / 2;

/** The curve's launch angle, in radians — see {@link BALL_CONFIG.THROW_CURVE_ANGLE}. */
const CURVE_ANGLE = math.rad(BALL_CONFIG.THROW_CURVE_ANGLE);

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
 *
 * The ray deliberately runs *past* the aim point rather than ending on it.
 * `target` is by definition a point on a surface, so a ray that stops exactly
 * there sits on the boundary between hitting and missing: floating-point noise
 * picks, and the two answers differ by a whole `BALL_RADIUS` in whatever
 * direction the fallback happens to point. Overshooting by two radii puts the
 * hit comfortably inside the ray, so the normal is the surface's own and is the
 * same every time — which is what the landing needs to be.
 */
function centreAimPoint(character: Model, muzzle: Vector3, target: Vector3): Vector3 {
	// **The filter is set with `ExcludeInstances`, and the pair it replaces is deprecated.** The typings
	// for `RaycastParams` mark `FilterType`, `FilterDescendantsInstances` and `AddToFilter` as deprecated
	// in favour of `ExcludeInstances` and `IncludeInstances` — so this is the way the engine is
	// maintained for, and the same sentence is now true of every other ray in the throw path.
	//
	// **Worth being certain about rather than merely working, because of what this ray decides.** It is
	// cast for the surface *normal* at the aim point, and a filter that quietly failed would not read as
	// a broken ray: it would come back with the thrower's own body as the surface, and aim the ball a
	// radius off the mark in whatever direction their torso happens to face. Small, systematic, and
	// invisible in every line the aim prints.
	const params = new RaycastParams();
	params.ExcludeInstances = [character];
	params.IgnoreWater = true;

	const delta = target.sub(muzzle);
	const reach = delta.Magnitude;
	const direction = reach > 0.001 ? delta.div(reach) : new Vector3(0, 0, -1);
	const hit = Workspace.Raycast(muzzle, direction.mul(reach + BALL_RADIUS * 2), params);

	// When the aim line genuinely hits nothing, assume level ground — the usual
	// landing anyway. Being one radius out in the wrong direction is bounded and
	// small.
	const normal = hit ? hit.Normal : new Vector3(0, 1, 0);

	return target.add(normal.mul(BALL_RADIUS));
}

/**
 * The flat launch that both of the low arcs are solved from: `straight` at the
 * game's flattest angle, `curve` at its own steeper one, plus the sideways pull
 * the curveball flies under.
 *
 * The two share everything except angle and pull, and both take their speed from
 * {@link flatLaunchSpeed} at the angle they will actually be launched at. Get
 * those two out of step and the throw misses the mark, which is why they are
 * read from the same variable here.
 *
 * {@link BALL_CONFIG.THROW_CURVE_COMPENSATED} decides which of the two curveballs
 * this is. Compensated, the launch cancels the pull's drift and the ball arrives on the
 * mark; uncompensated, the launch goes straight at the target and the ball is
 * carried off it. Either way the aim guide simulates the same pull, so it is the
 * landing that moves, never the honesty.
 */
function planFlatThrow(muzzle: Vector3, aim: Vector3, arc: "straight" | "curve"): LaunchPlan | undefined {
	if (arc === "straight" ) {
		const wanted = flatLaunchSpeed(muzzle, aim);
		if (wanted === undefined) return undefined;

		return planLaunch(
			muzzle,
			aim,
			math.clamp(wanted, BALL_CONFIG.THROW_SPEED, BALL_CONFIG.THROW_MAX_SPEED),
			"straight",
		);
	}

	const wanted = flatLaunchSpeed(muzzle, aim, CURVE_ANGLE);
	if (wanted === undefined) return undefined;

	// Deliberately no BALL_CONFIG.THROW_SPEED floor here. That floor is what keeps
	// the other two feeling like throws, but a flat launch faster than its own
	// solve overshoots the mark — and at the curve's angle the solve sits under
	// the floor for every target inside ~33 studs, which is most of them.
	return planLaunch(muzzle, aim, math.min(wanted, BALL_CONFIG.THROW_MAX_SPEED), "curve", {
		angle: CURVE_ANGLE,
		acceleration: leftAxis(muzzle, aim).mul(BALL_CONFIG.CURVE_STRENGTH),
		compensate: BALL_CONFIG.THROW_CURVE_COMPENSATED,
	});
}

/**
 * Plans a player's throw at `target` by solving the arc from the muzzle.
 *
 * The modes get their speed from different places, because they are answering
 * different questions:
 *
 * - `overhead` asks how fast it has to leave the hand to reach that far, and
 *   takes {@link BALL_CONFIG.THROW_SPEED} as a floor so anything in range is
 *   thrown with the same authority. Only a target genuinely out of reach winds it
 *   up, to {@link BALL_CONFIG.THROW_MAX_SPEED}, and the reach figure carries
 *   {@link BALL_CONFIG.THROW_ARC_SPREAD}.
 * - `straight` is barely thrown at all. Its speed is whatever makes a nearly
 *   flat launch fall onto the mark, so there is nothing to clamp except sanity
 *   bounds.
 * - `curve` is that same flat throw under a constant sideways pull. The pull is
 *   compensated for in the launch, so it lands on the mark as well — the shape
 *   of the flight is the difference, not the destination.
 *
 * All of them land on the target exactly, which is what makes it safe to let the
 * player choose between them. The plan reports the arc it actually used, so a
 * flat throw that fell back to `overhead` says so.
 *
 * Aiming above the launch line leaves no fall to work with, and both flat modes
 * quietly become an `overhead` throw rather than missing. A curve has no fall to
 * work with in that case either, so it arrives unfurled: the plan's
 * `acceleration` is left at zero rather than bending a throw that is no longer
 * flat.
 *
 * `launchFrom` overrides where the ball leaves the hand, and the thrower's own
 * client supplies it.
 *
 * The launch point is not a detail the solve absorbs. Every arc that reaches the
 * target is a *different curve*, so a plan solved from a different origin draws
 * a path the ball will not fly — and it still lands on the mark, which is
 * exactly why that fault shows up as a trajectory that lies rather than a throw
 * that misses. The server's copy of the character is up to one replication
 * interval behind, and while the thrower is walking or turning that is a stud or
 * two of hand.
 */
export function planPlayerThrow(
	character: Model,
	target: Vector3,
	arc: ThrowArc,
	launchFrom?: Vector3,
): LaunchPlan {
	const muzzle = launchFrom ?? getThrowMuzzle(character);
	const aim = centreAimPoint(character, muzzle, target);

	if (arc === "straight" || arc === "curve") {
		const flat = planFlatThrow(muzzle, aim, arc);
		if (flat !== undefined) return flat;
	}

	const needed = minimumReachSpeed(muzzle, aim) * BALL_CONFIG.THROW_ARC_SPREAD;
	const speed = math.clamp(needed, BALL_CONFIG.THROW_SPEED, BALL_CONFIG.THROW_MAX_SPEED);

	// `overhead` for the fallback too: a straight throw with no solution would
	// otherwise fire off at the geometry behind the target.
	return planLaunch(muzzle, aim, speed, "overhead");
}
