import { Workspace } from "@rbxts/services";
import { BALL_SIZE } from "shared/constants";
import { BALL_CONFIG } from "shared/config/ball.config";
import {
	compensateLateral,
	flatLaunchSpeed,
	LaunchPlan,
	leftAxis,
	minimumReachSpeed,
	planLaunch,
	ThrowArc,
	velocityAtAngle,
} from "shared/Trajectory";

/**
 * How a throw is planned. This is the game's rulebook, kept in one
 * place so the server (which applies the throw for real) and the client (which
 * predicts it for the aim guide) can never disagree.
 *
 * **Two kinds of throw live here now, and telling them apart is the first thing to do in this file.** A
 * **charged** throw is what a player makes: a heading, a hold and whether the ball bends, with no target
 * anywhere in it — see {@link planChargedThrow}. An **aimed** throw is what a rig makes: a point to land on
 * and a discrete arc, which is what every throw in the game used to be — see {@link planAimedThrow}.
 *
 * **Each kind keeps the rule above on its own, and neither can borrow the other's.** The charged throw is
 * planned here and called by *both* the client's preview and the server's launch, from the same three
 * inputs, so the drawn line and the flown line cannot come from different arithmetic. The aimed throw has
 * one caller — `BallService.throwBall` invoked by a rig's behavior — because a rig draws no preview, so
 * there is nothing on the other side for it to disagree with.
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
		// `undefined` for the angle keeps `flatLaunchSpeed`'s own default; the gravity is the ball's, not the
		// world's — see `BALL_CONFIG.BALL_GRAVITY`. Passing it matters here more than anywhere else, because
		// this is the function that decides how hard a flat throw is thrown: solved against the world's
		// gravity it comes out too slow, and the ball drops short of its own marker.
		const wanted = flatLaunchSpeed(muzzle, aim, undefined, BALL_CONFIG.BALL_GRAVITY);
		if (wanted === undefined) return undefined;

		return planLaunch(
			muzzle,
			aim,
			math.clamp(wanted, BALL_CONFIG.THROW_SPEED, BALL_CONFIG.THROW_MAX_SPEED),
			"straight",
			// The engine pulls the ball down at `BALL_GRAVITY`, not the world's — see `BallFactory`.
			{ gravity: BALL_CONFIG.BALL_GRAVITY },
		);
	}

	const wanted = flatLaunchSpeed(muzzle, aim, CURVE_ANGLE, BALL_CONFIG.BALL_GRAVITY);
	if (wanted === undefined) return undefined;

	// Deliberately no BALL_CONFIG.THROW_SPEED floor here. That floor is what keeps
	// the other two feeling like throws, but a flat launch faster than its own
	// solve overshoots the mark — and at the curve's angle the solve sits under
	// the floor for every target inside ~33 studs, which is most of them.
	return planLaunch(muzzle, aim, math.min(wanted, BALL_CONFIG.THROW_MAX_SPEED), "curve", {
		angle: CURVE_ANGLE,
		acceleration: leftAxis(muzzle, aim).mul(BALL_CONFIG.CURVE_STRENGTH),
		compensate: BALL_CONFIG.THROW_CURVE_COMPENSATED,
		gravity: BALL_CONFIG.BALL_GRAVITY,
	});
}

/**
 * Plans an **aimed** throw — the rig's solve, and what every throw in this game used to be.
 *
 * **The name says "aimed" rather than "player" because a player does not make one any more.** A player's
 * throw is charged — a heading and a hold, with no point to land on anywhere in it — and lives in
 * {@link planChargedThrow} below. What is left here is the solve for a thrower that *has* a point in mind,
 * which means a rig: `ThrowBehavior` picks a body and asks for a ball at it, and this is the arithmetic that
 * gets one there. It is still the game's rulebook in the sense that matters — one function, one answer —
 * it simply has one caller now instead of two, because a rig has no preview to draw.
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
export function planAimedThrow(
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

		// **No fallback to `overhead`, and that is a deliberate removal.** A `straight` or `curve` throw used
		// to be converted into an arcing one whenever the flat solve had no answer — which happens when the
		// aim sits above the launch line, so there is no fall to drop onto the mark. That made the arc the
		// player chose unreliable: pick straight, get a lob, with nothing on screen saying why. The chosen arc
		// is now honoured, and this case leaves the hand along the aim line at `THROW_MAX_SPEED`.
		//
		// **What that costs, stated rather than hidden:** this is the one case where the ball can pass the
		// marker instead of arriving at it, because there is no fall shaped to land on it. Passing a mark
		// you aimed above is the honest reading of that geometry; silently lobbing is not.
		return planLaunch(muzzle, aim, BALL_CONFIG.THROW_MAX_SPEED, arc, {
			angle: CURVE_ANGLE,
			acceleration:
				arc === "curve" ? leftAxis(muzzle, aim).mul(BALL_CONFIG.CURVE_STRENGTH) : Vector3.zero,
			compensate: BALL_CONFIG.THROW_CURVE_COMPENSATED,
			gravity: BALL_CONFIG.BALL_GRAVITY,
		});
	}

	const needed = minimumReachSpeed(muzzle, aim, BALL_CONFIG.BALL_GRAVITY) * BALL_CONFIG.THROW_ARC_SPREAD;
	const speed = math.clamp(needed, BALL_CONFIG.THROW_SPEED, BALL_CONFIG.THROW_MAX_SPEED);

	return planLaunch(muzzle, aim, speed, "overhead", { gravity: BALL_CONFIG.BALL_GRAVITY });
}

// ------------------------------------------------------------------ charged

/**
 * What the player's input produces: **where they are pointing, how long they held, and whether the ball
 * bends.**
 *
 * **The absence of a target is the design and not a simplification.** The model this replaces asked the
 * player *where the ball should land* and solved a throw that got there. That has two failures built into
 * it rather than bolted on: a moving target has to be clicked where the body *will* be, which is guesswork,
 * and a click that goes past a target lands in the sky — a legitimate thing to aim at, and a solve that
 * dutifully reaches it — so the throw goes as far as the ball allows. Both of those come from range being a
 * *place* the player nominates and cannot see. Here range is a length of time they hold, the maximum is one
 * number they can learn, and the landing marker says where it lands.
 *
 * **Three fields, and each is exactly one input.** `heading` is the aim ray, still carrying the camera's
 * pitch, because both sides flatten it in `velocityAtAngle` and the same number therefore means the same
 * compass direction on both. `charge` is the hold as a fraction. `curve` is the lateral shape, which is the
 * one arc that survives the change because it is not on the charge's axis — see {@link planChargedThrow}.
 */
export interface ChargeRequest {
	readonly heading: Vector3;
	/**
	 * How far the hold got, from `0` (a tap) to `1` (held to the end of its run).
	 *
	 * **The one number that has to cross the wire unchanged, because it is the one number both sides act
	 * on.** The client draws its preview from the charge it computes at the instant it releases, and sends
	 * that same value; the server has no clock for this and never re-derives one. So this is not two
	 * measurements of one hold that have to be kept close — it is one value used twice, which is why the
	 * preview cannot drift from the throw as the charge grows.
	 */
	readonly charge: number;
	/** Whether the ball bends to the thrower's left. See {@link BALL_CONFIG.CURVE_STRENGTH}. */
	readonly curve: boolean;
}

/** What a rig's behavior produces: a point to land on, and one of the three named arcs. */
export interface AimedRequest {
	readonly target: Vector3;
	readonly arc: ThrowArc;
}

/**
 * A throw as its caller states it — **and the tag is load-bearing rather than decorative.**
 *
 * The two kinds take different arguments and answer to different rules, and mixing them would be *wrong*
 * rather than merely odd: a charge handed to the aimed solve is a number it would read as a distance, and a
 * target handed to the charged solve is a point with no meaning. `BallService.throwBall` branches on this
 * tag at the single line where a solve happens, so the two arms sit two lines apart and each names the
 * function it calls — which is what keeps "one solve, both sides" a thing a reader can check rather than a
 * thing this comment claims.
 */
export type ThrowRequest =
	| ({ readonly kind: "charged" } & ChargeRequest)
	| ({ readonly kind: "aimed" } & AimedRequest);

/**
 * `sin 45°`, the largest fraction of a launch speed that may go upwards before the throw stops being one —
 * the clamp {@link peakAngle} falls back to. See that function for when it is reached and why 45° rather than
 * anything steeper.
 */
const MAX_VERTICAL_FRACTION = 1 / math.sqrt(2);

/**
 * The launch angle that arcs to {@link BALL_CONFIG.CHARGE_PEAK_HEIGHT} at `speed`, in radians.
 *
 * **One line of physics and one clamp, and the line is the whole of the shape.** A projectile's apex is
 * `v_y² / 2g`, so reaching a peak of `h` needs a vertical launch of `v_y = sqrt(2·g·h)` and nothing else.
 * Everything else about the throw is already decided by the charge — the speed is the hold, and the heading is
 * where the player is pointing — so the angle is `asin(v_y / v)`, and **the flattening is now a consequence
 * rather than a second thing being lerped**: as the hold fills, `v` climbs, `v_y / v` falls, and the throw
 * flattens on its own. That is the change this replaced a two-angle lerp with, and it is why a tap and a full
 * hold can peak at the same height while leaving the hand at 29° and 10°.
 *
 * **One solution, not two — and this is worth being exact about, because the opposite is true one function
 * away.** A conventional solve fixes the *target* and the speed, and there are then two launch angles that
 * reach it: the steep one and the shallow one, which is the choice {@link solveLaunchVelocity} makes for a
 * rig. Fixing the *peak* is a different constraint — it pins the vertical component outright — so there is no
 * second angle that reaches the same height at the same speed. `asin`'s other root is `180° − θ`, a throw
 * pointed backwards, which is not a solution to anything.
 *
 * **The clamp is the unreachable-peak case.** `v_y > v` means this speed cannot lift the ball to the
 * configured peak at all, and the answer is a 45° launch: the longest throw the speed allows, at the highest
 * peak available *while still going somewhere*. Steeper would buy height and cost the throw — 90° reaches the
 * peak and lands on the thrower's own head — and anything below 45° would fail at a much shorter distance
 * without getting any closer to the peak. So 45° is the one launch that is not a lie about either half of
 * "throw it as far as you can to that height".
 *
 * **It is unreachable in the shipped numbers, and deliberately so.** The demand is
 * `sqrt(2·g·CHARGE_PEAK_HEIGHT)` = 21.9 studs/s and the floor is `CHARGE_MIN_SPEED` = 45, so this branch needs
 * a peak of about 12 studs or a floor under 22 before it can run. **Whichever of the two is ever tuned, the
 * invariant is that the demand stays under the floor** — and if it does not, the visible symptom is not a
 * broken throw but a *flatter* one that lands closer than the charge promised, which is exactly what the
 * fallback is for and exactly why it is a clamp rather than a refusal.
 */
function peakAngle(speed: number): number {
	const vertical = math.sqrt(2 * BALL_CONFIG.BALL_GRAVITY * BALL_CONFIG.CHARGE_PEAK_HEIGHT);

	// A speed of zero would divide by it; the clamp answers that case with the same 45° it answers an
	// unreachable peak with, which is the honest reading of "this throw has no speed to shape".
	return math.asin(math.clamp(vertical / speed, 0, MAX_VERTICAL_FRACTION));
}

/**
 * The launch speed a hold of `charge` uses, in studs per second.
 *
 * The top of the climb is {@link BALL_CONFIG.THROW_MAX_SPEED} rather than a number of its own, so the cap on
 * a throw and the top of the range are one figure — there is nothing here that could be raised past the cap
 * and quietly stop capping.
 */
function chargeSpeed(charge: number): number {
	const floor = BALL_CONFIG.CHARGE_MIN_SPEED;

	return floor + (BALL_CONFIG.THROW_MAX_SPEED - floor) * charge;
}

/**
 * How long a projectile launched at `speed` and `angle` stays up, if it lands at the height it left from:
 * `2·v·sin θ / g`.
 *
 * **The only flight time a charged throw can honestly state**, because it has no target and so no distance
 * to divide by. It is exact over level ground, short for a landing below the launch height and long for one
 * above. It has exactly one consumer — the sideways force of a curve, which the server removes this long
 * after the throw, see `BallService.applyAcceleration` — and being a little early or late with that costs
 * part of a bow on sloping ground, where being absent would leave a constant force pushing a ball that had
 * already stopped.
 *
 * **With the peak setting the angle, this is the same number at every charge** — `v·sin θ` is the fixed
 * vertical component, so a hold changes how far the ball travels and never how long it hangs. That is worth
 * knowing before the peak is tuned: it is the figure a curve's force is timed to, and moving the peak moves
 * it.
 */
function ballisticFlight(speed: number, angle: number): number {
	return (2 * speed * math.sin(angle)) / BALL_CONFIG.BALL_GRAVITY;
}

/**
 * Plans a **charged** throw: a direction, a hold and nothing else. **The player's solve, and the one both
 * the preview and the ball come from.**
 *
 * **What the hold decides is the speed, and the speed decides the rest.** The charge climbs the launch speed
 * from {@link BALL_CONFIG.CHARGE_MIN_SPEED} to {@link BALL_CONFIG.THROW_MAX_SPEED}; the angle is derived from
 * that speed so the arc peaks at {@link BALL_CONFIG.CHARGE_PEAK_HEIGHT} — see {@link peakAngle} — and the
 * range is what those two produce. So the sentence a player learns is still *hold longer, further*, and it is
 * now true of one number rather than of two moving together: **nothing but the speed changes with the hold**,
 * and the flattening is a consequence of it rather than a second dial.
 *
 * **On level ground that gives 21.5 studs at a tap, 33.5 at a quarter, 45 at a half, 56 at three quarters and
 * 67 at a full hold** — monotone, and far shorter than the lob it replaces (22 / 52 / 90 / 127 / 150).
 * **That loss is the price of the shape and it is a real one**, so the numbers that would restore it are
 * written down here rather than found by tuning later. Reach rises with both the speed and the peak, and at
 * full charge it is about `2·v·sqrt(2·g·h)/g` for a small peak: 150 studs needs roughly
 * `THROW_MAX_SPEED = 275`, which is more than twice anything this game has thrown, or a peak near 7 studs,
 * which puts the apex two character-heights up and is the lob this change exists to remove. **Neither was
 * moved.** The table above is what the current numbers do, and the honest reading of it is that a real
 * trajectory at a 125 studs/s ceiling reaches about 67 studs — which is the same shape and about the same
 * distance as a baseball pitch at that speed.
 *
 * **Every charge is in the air for the same 0.55 s, and that is a consequence rather than a coincidence.** A
 * fixed apex from a fixed hand means a fixed *vertical* flight — `2·v_y/g`, and `v_y` is the same number for
 * every hold — so only the horizontal distance covered changes. Two things follow, and both are changes to how
 * the game plays rather than to how it looks. The ball arrives at a target in about half the time the lob took
 * (0.97 s at a tap and 1.4 s at full, before), so it needs less leading; and it arrives *flat* rather than
 * dropping onto the mark, which is the shape the change was asked for and does mean a hit reads differently as
 * well as a throw.
 *
 * **With no target there is nothing to land on and nothing to be wrong about.** No `centreAimPoint`, no
 * `flatLaunchSpeed`, no arc to choose: the launch is a velocity the charge names outright, and the preview
 * integrates the identical vector under the identical pull. The one thing that used to be *solved* is now
 * *measured*: the guide places the landing marker where the ball's edge actually touches, and the player
 * judges the shot by that.
 *
 * **The curve survives, and it survives because it is not on this axis.** `overhead` and `straight` named two
 * ways of *reaching a point*, which is the thing the hold replaced, so neither is part of a player's throw
 * any more. `curve` names a lateral shape — a sideways force rather than an elevation — and folding it in
 * would be folding two axes into one number, so a charged throw carries it separately: the same launch, with
 * a constant pull to the thrower's left and the launch slung wide to cancel it, which leaves the bend as a
 * shape and the landing where the unbent version of the same charge would have put it. The cancellation is
 * calibrated at {@link ballisticFlight}, so on ground that is not level the ball rejoins its own line a
 * little early or late — and the preview draws exactly that, which is what keeps even this honest.
 *
 * **`arc` is `undefined` for the plain version and `"curve"` for the bent one.** A charged throw's shape is a
 * number rather than a name, and calling a 40° hold "straight" would invent a member this game does not have;
 * the name is kept only where it is still true. See {@link LaunchPlan.arc}.
 */
export function planChargedThrow(
	character: Model,
	request: ChargeRequest,
	launchFrom?: Vector3,
): LaunchPlan {
	const muzzle = launchFrom ?? getThrowMuzzle(character);

	// **Clamped rather than refused, because this function's contract is to return a plan.** An impossible
	// charge is refused at the wire — see `BallService`'s handler — and this clamp is what makes the function
	// total for every other caller: a hold of exactly one second can produce `1.0000000001` in floating
	// point, and that must draw the same preview as `1` rather than put a `NaN` into a velocity and take the
	// arc off the screen.
	const charge = math.clamp(request.charge, 0, 1);

	// **The speed first, because the angle is derived from it.** The order is the model: the hold picks one
	// number, and the shape of the arc is a function of that number rather than a parallel input. See
	// `peakAngle` for the derivation and this function's doc for what the pair produces.
	const speed = chargeSpeed(charge);
	const angle = peakAngle(speed);

	// **The heading is flattened here, and both sides flatten the same number.** What crosses the wire is the
	// aim ray's own direction, which carries the camera's pitch because that is the vector there is; the only
	// part a heading can use is the compass direction, so it is projected once, here, rather than by each
	// caller. Looking straight down has no heading at all, and the fallback is due north — the same fallback
	// `horizontalDirection` makes, so a degenerate aim behaves identically in both files.
	const along = new Vector3(request.heading.X, 0, request.heading.Z);
	const heading = along.Magnitude > 0.001 ? along.Unit : new Vector3(0, 0, -1);

	// A point one stud along the heading, because a horizontal direction is the only thing
	// `velocityAtAngle` reads of a target. Naming the heading as a point beside the muzzle keeps one reader
	// of "target" in the shared maths instead of two.
	const nominal = muzzle.add(heading);

	const flat = velocityAtAngle(muzzle, nominal, speed, angle);
	const flight = ballisticFlight(speed, angle);

	if (!request.curve) {
		return {
			origin: muzzle,
			velocity: flat,
			arc: undefined,
			gravity: BALL_CONFIG.BALL_GRAVITY,
			// Zero, and so there is nothing for the server to apply — `applyAcceleration` returns at once on
			// a pull of nothing. A plain charged throw is pure ballistics.
			acceleration: Vector3.zero,
			// Stated even though nothing reads it for a plain throw, so that the field means the same thing
			// on every plan rather than something that depends on the shape.
			flightTime: flight,
		};
	}

	const pull = leftAxis(muzzle, nominal).mul(BALL_CONFIG.CURVE_STRENGTH);

	return {
		origin: muzzle,
		velocity: BALL_CONFIG.THROW_CURVE_COMPENSATED ? compensateLateral(flat, pull, flight) : flat,
		arc: "curve",
		gravity: BALL_CONFIG.BALL_GRAVITY,
		acceleration: pull,
		flightTime: flight,
	};
}
