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
 * **One kind of throw is the game's now, and telling it apart from the one it replaced is the first thing to
 * do in this file.** A **charged** throw is what *every* body makes: a heading, a hold and whether the ball
 * bends, with no target anywhere in it — see {@link planChargedThrow}. A player measures the hold with a
 * button; a rig measures a *distance* with `detectEnemy` and asks {@link chargeForRange} what hold that
 * distance is. One solve, one config, one envelope — which is the property the whole file is arranged
 * around, and the reason retuning {@link BALL_CONFIG.THROW_MAX_SPEED} moves a rig and a player together.
 *
 * **An *aimed* throw — a point to land on and a discrete arc — is what every throw in the game used to be,
 * and {@link planAimedThrow} still solves one.** **No caller passes it any more**: the two rig behaviours
 * that did have moved onto the charged arm, and a player's path never did. It is kept rather than deleted
 * because it is a working solve with its own comments behind it, and because removing it would reach into
 * `shared/Trajectory.ts` and `ball.config.ts` — see that function's own note for the state it is in.
 *
 * **The charged throw keeps the rule above on its own.** It is planned here and called by *both* the
 * client's preview and the server's launch, from the same three inputs, so the drawn line and the flown line
 * cannot come from different arithmetic — and a rig's throw, being the same solve, cannot come from a third.
 */

/**
 * Where a throw starts: **a fixed height above the thrower's `HumanoidRootPart`, on the body's own axis.**
 *
 * **The root and nothing else, and that absence is the whole of this function.** It used to be head height, at
 * the torso's position, two studs along the body's facing — and each of those three readings was a way for the
 * *animated* body to move the launch point:
 *
 * - **The torso is animated.** A rig's `UpperTorso` leans, twists and swings on its `Motor6D`s, so a
 *   torso-anchored muzzle moved with the walk cycle and with every turn: the aim guide wobbled as the player
 *   walked, and the ball left from wherever the chest happened to be pointing.
 * - **The facing is animated too, and slower than the intent.** A body turns *towards* the aim over a fraction of
 *   a second, so "two studs in front" was measured along the direction the body was still pointing. Quick-tap a
 *   throw before the turn had finished and the ball started a body-width to the side of the line to the target,
 *   then flew across to it — the report this change answers.
 * - **The head height was read per frame**, which is right per rig but is one more animated part that could carry
 *   the muzzle up and down with a look.
 *
 * **Nothing here knows which way anybody is facing, and that is the point.** The aim does not belong in this
 * function: *every* throw is a ballistic solve that starts from this point and lands on the target — see
 * `planChargedThrow` and `planAimedThrow` — so the line the ball flies is already the aim's. All this has to be
 * is a point the body cannot drag around, and the root is the one part no animation moves.
 *
 * **Being on the body's axis is not a self-hit risk.** `BallService.throwBallBody` calls
 * `CollisionIgnore.between(ball, model)` before it moves the ball, so the thrower's parts are not in the ball's
 * collision set at all — the forward offset this replaces was never what kept the ball out of its thrower, which
 * `BALL_CONFIG.THROW_MUZZLE_HEIGHT`'s own note says from the other end.
 *
 * **`THROW_MUZZLE_HEIGHT` is one number for every body**, and that is a deliberate trade: an R15 head and an R6
 * head are not carried at the same height, so the ball leaves a few tenths of a stud higher on one than the
 * other. It cannot be seen — the solve lands the ball on the target whatever height it starts from — and what it
 * buys is a muzzle no animation can move, which a per-frame head measurement could not promise.
 *
 * **Called once per frame by the aim guide**, so this is a `FindFirstChild` and some vector arithmetic and
 * nothing else. No print: a line here would be a line per frame.
 */
export function getThrowMuzzle(character: Model): Vector3 {
	const root = character.FindFirstChild("HumanoidRootPart");
	const origin = root !== undefined && root.IsA("BasePart") ? root.Position : character.GetPivot().Position;

	return origin.add(new Vector3(0, BALL_CONFIG.THROW_MUZZLE_HEIGHT, 0));
}

/**
 * Why the muzzle is where it is, as one line for the throw log.
 *
 * **The three numbers that decide it, because the failure they describe is invisible everywhere else.** A muzzle
 * that sits too low throws the ball out of the chest and everything still works — the solve lands it on the
 * target either way — so nothing in the flight says where it started. This names the root it is measured from,
 * the height added, and the point that comes out.
 *
 * Called once per throw, from the throw path. Delete it when the offset is trusted.
 */
export function describeMuzzle(character: Model): string {
	const root = character.FindFirstChild("HumanoidRootPart");
	const hasRoot = root !== undefined && root.IsA("BasePart");
	const rootY = hasRoot ? (root as BasePart).Position.Y : 0;
	const height = BALL_CONFIG.THROW_MUZZLE_HEIGHT;

	const found = hasRoot ? `root y ${string.format("%.2f", rootY)}` : "root NOT FOUND";

	return found + `, rise ${string.format("%.2f", height)}, ` + `muzzle y ${string.format("%.2f", rootY + height)}`;
}

/** How far the ball's edge sits from the point its centre is aimed at. */
const BALL_RADIUS = BALL_SIZE / 2;

/** The curve's launch angle, in radians — see {@link BALL_CONFIG.THROW_CURVE_ANGLE}. */
const CURVE_ANGLE = math.rad(BALL_CONFIG.THROW_CURVE_ANGLE);

/**
 * The point to aim the ball's *centre* at so that its *surface* arrives at
 * `target`.
 *
 * **Reached only through the aimed solve, and that solve has no caller any more** — see `planAimedThrow`.
 * Nothing a charged throw does consults it, because a charged throw has no target to centre anything on.
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
 * **Reached only through the aimed solve, and that solve has no caller any more** — see `planAimedThrow`.
 * A charged throw has no arc to choose and no distance to solve against, so neither of the two arms below
 * is on the path any throw the game makes takes.
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
 * Plans an **aimed** throw — a point to land on and a discrete arc, which is what every throw in this game
 * used to be.
 *
 * **Nothing calls this, and that is the current and deliberate state rather than an oversight.** A rig used
 * to: `ThrowBehavior` picked a body and asked for a ball at it, and this was the arithmetic that got one
 * there. The rigs now make the same throw a player makes — see {@link chargeForRange} for the one question a
 * rig has to ask first — so the last caller is gone and this function, `planFlatThrow`,
 * `centreAimPoint` and the `overhead`/`straight`/`curve` vocabulary they read are all unreachable from the
 * game today.
 *
 * **Kept rather than deleted, and this is a note about scope rather than about merit.** It is a working
 * solve with its own comments and history, and it is the thing the charged throw replaced — so a reader
 * arriving at `ThrowArc` or `overhead` has somewhere to look. Deleting it would take `shared/Trajectory.ts`'s
 * `solveLaunchVelocity`, `flatLaunchSpeed` and `minimumReachSpeed`, `ThrowArc` and `LaunchPlan.arc`,
 * `AimedRequest` and half of `ThrowRequest`, the `aimed` arm of `BallService.throwBall`, and four constants
 * in `ball.config.ts` — a change of a different size to the one that removed its caller, and one worth doing
 * on its own. **If it is deleted, `chargeForRange` and `planChargedThrow` are the whole of the throw.**
 *
 * What follows is still true of it, and is what a future caller would be reading.
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

/**
 * What a rig's behavior used to produce: a point to land on, and one of the three named arcs.
 *
 * **Constructed nowhere today.** A rig now builds a {@link ChargeRequest} like everybody else — a heading and
 * a hold — and the arc vocabulary this type carries is the half of the aimed solve that is unreachable. See
 * {@link planAimedThrow}.
 */
export interface AimedRequest {
	readonly target: Vector3;
	readonly arc: ThrowArc;
}

/**
 * A throw as its caller states it — **and the tag is still load-bearing, even though only one member is
 * built today.**
 *
 * The two bodies that throw used to speak different arms: a player sent a `charged` request, a rig sent an
 * `aimed` one. **Both send `charged` now** — a rig asks {@link chargeForRange} for the hold its distance
 * needs and passes a heading like anybody else — so the `aimed` member is constructed nowhere and the branch
 * in `BallService.throwBall` has one live arm.
 *
 * **The union is kept because the branch it feeds is the property worth keeping**: the two kinds take
 * different arguments and answer to different rules, so mixing them would be *wrong* rather than merely odd —
 * a charge handed to the aimed solve is a number it would read as a distance, and a target handed to the
 * charged solve is a point with no meaning. Collapsing this to a single interface would delete the typed
 * statement of that, and put the two solves back within reach of each other's arguments.
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
 * `sqrt(2·g·CHARGE_PEAK_HEIGHT)` = 17.9 studs/s and the floor is `CHARGE_MIN_SPEED` = 45, so this branch needs
 * a peak of about 12 studs or a floor under 18 before it can run. **Whichever of the two is ever tuned, the
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
 * The hold whose charged throw lands `range` studs away, as a fraction of a full one — **the inverse of
 * {@link chargeSpeed} and {@link peakAngle} read together, and the one bridge between a distance and a
 * charge.**
 *
 * **A player and a rig arrive at a charge from opposite ends, and this is the direction a rig travels.** A
 * player holds a button and *measures* how long they held: the hold is the charge and the range is whatever
 * it produces, which is `chargeSpeed`'s direction and the one the preview and the ball both read. A rig has
 * no button — it has a target, so it knows a *distance* and needs the hold that covers it. One law read
 * backwards, which is why this is arithmetic over the config rather than a table somebody keeps in step
 * with it.
 *
 * **The algebra, in the order it is written below.** A charged throw's vertical launch is
 * `v_y = sqrt(2·g·h)` — a *constant*, because the peak is fixed and the speed only changes the angle — and
 * the flight time to a point `rise` studs above the hand is the later root of `v_y·t − ½·g·t² = rise`. The
 * horizontal speed that covers `range` in that time is `range/t`, and the launch speed the charge has to
 * produce is `v = sqrt(v_y² + (range/t)²)`. Inverting {@link chargeSpeed} — a straight line from
 * {@link BALL_CONFIG.CHARGE_MIN_SPEED} to {@link BALL_CONFIG.THROW_MAX_SPEED} — turns that speed back into a
 * hold.
 *
 * **`rise` is a parameter rather than an assumption, and without it a rig misses long every single throw.**
 * A charged throw leaves the hand at head height and the thing a rig aims at is a body's *root*, about two
 * and a half studs lower. A ball launched above the point it is aimed at stays in the air longer than the
 * level flight, so it covers more ground: at `rise = −2.5` the flight is `0.559 s` against the level
 * `0.447 s`, and a rig that asked for the *level* hold at a target sixty studs away would fly the ball
 * `75`. That is not a misclick, it is a broken aim — and it is a difference the forward direction simply
 * does not have, because a player has no target and therefore no rise to get wrong. **A caller holding a
 * point passes `target.Y − launch.Y` and lands on the point**; a caller with only a distance leaves it at
 * `0` and gets the level-ground throw.
 *
 * **Exact while the target is at or below the peak, and flat-out above it.** A `rise` higher than
 * {@link BALL_CONFIG.CHARGE_PEAK_HEIGHT} above the hand cannot be reached at *any* speed, because the apex
 * is fixed by the peak — so the root is floored at zero there and the answer is the charge that throws
 * flat-out, which is the same "falls short" the clamp below gives. Nothing in the game asks for it: a rig
 * aims at a body, which is below its own head, and every floor slopes down from there.
 *
 * **The clamp is the honest answer at both ends, and neither end is an error.** Below the tap's reach the
 * charge is `0`, so the throw is the softest ball the mechanic has — exactly what a player who presses and
 * releases inside one frame gets. Above a full hold's reach the charge is `1` and **the ball falls short**,
 * which is what a player at that distance gets too, and the reason there is no refusal anywhere in here: a
 * rig that declined to throw would read, from a seat, as a rig that had stopped working, and the throw it
 * declined is one a player would have made and watched land short. **Falling short is the shared
 * behaviour**; it is not a rig being worse at anything.
 *
 * **Who calls it: the rig, and only the rig.** `ThrowBehavior` has a point from `detectEnemy` and turns it
 * into `chargeForRange(distance, aimPoint.Y − muzzle.Y)`; `AlwaysThrowBehavior` does the same from the
 * stand-in distance it throws along, measured against its own hip height. Both read the muzzle with
 * `getThrowMuzzle`, the same call the solve itself will make a moment later. A player's path never calls this,
 * because a player never has a distance to start from — see {@link ChargeRequest}, whose `charge` is a
 * measurement. Both of this function's callers are the same mechanic as a player's throw, entered from the
 * other end.
 *
 * **Placeholder-free on purpose.** There is no number here of its own to tune: every figure is
 * {@link BALL_CONFIG}'s, so retuning the throw retunes both bodies at once, which is the whole point of the
 * rig asking this question instead of carrying a table of its own.
 */
export function chargeForRange(range: number, rise = 0): number {
	// The vertical launch a charged throw always has. It is a property of the config rather than of this
	// throw — the same `v_y` `peakAngle` clamps against and the same flight `ballisticFlight` reports.
	const vertical = math.sqrt(2 * BALL_CONFIG.BALL_GRAVITY * BALL_CONFIG.CHARGE_PEAK_HEIGHT);

	// The *later* root of `v_y·t − ½·g·t² = rise`, which is the time the ball comes back down to the target's
	// height: it passes that height on the way up first, and the aimed point is the one it meets on the way
	// down. Floored at zero, so a target above the fixed apex answers with the apex's own time rather than a
	// `nan` — see the doc, where that case is stated rather than hidden.
	const reach = vertical * vertical - 2 * BALL_CONFIG.BALL_GRAVITY * rise;
	const flight = (vertical + math.sqrt(math.max(0, reach))) / BALL_CONFIG.BALL_GRAVITY;

	// The horizontal speed that covers the range in that flight, recombined with the vertical to give the
	// launch speed the charge must produce.
	const along = range / flight;
	const speed = math.sqrt(vertical * vertical + along * along);

	const floor = BALL_CONFIG.CHARGE_MIN_SPEED;

	return math.clamp((speed - floor) / (BALL_CONFIG.THROW_MAX_SPEED - floor), 0, 1);
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
 * **On level ground that gives 18.5 studs at a tap, 52.0 at a quarter, 84.8 at a half, 117.5 at three
 * quarters and 150.1 at a full hold** — monotone, and now reaching exactly as far as a rig's own range gate.
 *
 * **The ceiling was raised, and the paragraph that stood here argued the opposite.** It read *"that loss is
 * the price of the shape and it is a real one"*, and it wrote down the numbers that would undo it "rather
 * than found by tuning later": 150 studs needs roughly `THROW_MAX_SPEED = 335`, or a peak near 18 studs,
 * which puts the apex several character-heights up and is the lob this change exists to remove. **The speed
 * is the one that moved and the peak did not** — `THROW_MAX_SPEED` is `336`, and the arithmetic that lands on
 * it is written up beside the constant. The old table was 18.5 / 27.9 / 37.2 / 46.3 / 55.3, and the numbers
 * above are that table with one figure of the config changed: nothing in this function's shape moved.
 *
 * **A rig is why, and it is the whole reason.** A rig throws the ball a player throws — same solve, same
 * config, same envelope — and a rig's range gate is `NPC_CONFIG.THROW_RANGE_STUDS`. So a ceiling that reaches
 * 55 studs leaves a rig past that range throwing its hardest and watching the ball land short, which is a
 * worse reading of "the rigs are like the players" than a longer throw is. One envelope, wide enough for the
 * body that has a *distance* in its hand rather than a button. **What that costs is stated beside the
 * constant**: the top of a hold now covers much more ground — a half hold was 37 studs and is 85 — so the
 * band a player learns is the same shape stretched, and the shot that used to be near the end of the throw is
 * nearer the middle.
 *
 * **Every charge is in the air for the same 0.45 s, and that is a consequence rather than a coincidence.** A
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
	// total for every other caller: a hold taken all the way to the end of `CHARGE_SECONDS` can produce
	// `1.0000000001` in floating point, and that must draw the same preview as `1` rather than put a `NaN`
	// into a velocity and take the arc off the screen.
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
