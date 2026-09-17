import { Workspace } from "@rbxts/services";

/**
 * Ballistics for thrown objects, kept deliberately free of Flamework so both
 * sides of the network can use it.
 *
 * The server uses it to decide the arc; the client uses the exact same maths to
 * draw the aim guide. Anything the two disagree about would show up as a guide
 * that lies, so there is only one copy of the formulas.
 *
 * This module knows nothing about players, balls, or the game's numbers — see
 * `shared/throw.ts` for those.
 */

/**
 * The flat throw's launch angle, in radians, and the shallow end of what the
 * overhead solver will produce.
 *
 * The curveball deliberately does not use it: for a flat launch the angle *is*
 * the speed control, so the curve gets its own steeper one — see
 * `THROW_CURVE_ANGLE` in `shared/constants.ts`.
 */
const MIN_THROW_ANGLE = math.rad(5);
const MAX_THROW_ANGLE = math.rad(85);

/**
 * The ways to reach a point.
 *
 * `overhead` is a real thrown arc: lofted off the hand, carried by its own
 * velocity, and dropping onto the target.
 *
 * `straight` barely leaves the hand at all — it goes out at the flattest angle
 * the game allows and gravity alone curves it down onto the mark. Its speed is
 * not a free parameter: it is solved from the fall, see {@link flatLaunchSpeed}.
 *
 * `curve` is a `straight` throw flown under a sideways force: the same flat
 * launch and the same fall, plus a constant lateral acceleration that bows the
 * path out and then brings it back. See {@link solveLaunchVelocity}.
 *
 * All of them land on the target exactly, which is what makes it safe to let
 * the player choose.
 */
export type ThrowArc = "overhead" | "straight" | "curve";

/**
 * Unit horizontal direction from `origin` toward `target`.
 *
 * Falls back to due north when the two points sit on top of each other, which
 * only happens on a throw aimed at your own feet — the direction is meaningless
 * there, but a real one keeps every formula downstream finite.
 */
function horizontalDirection(origin: Vector3, target: Vector3): Vector3 {
	const horizontal = new Vector3(target.X - origin.X, 0, target.Z - origin.Z);
	return horizontal.Magnitude > 0.001 ? horizontal.Unit : new Vector3(0, 0, -1);
}

/** Distance between two points as seen from above, ignoring the height between them. */
function horizontalDistance(origin: Vector3, target: Vector3): number {
	return new Vector3(target.X - origin.X, 0, target.Z - origin.Z).Magnitude;
}

/** Builds a velocity of `speed` from a launch angle toward `target`. */
function velocityAtAngle(origin: Vector3, target: Vector3, speed: number, angle: number): Vector3 {
	const direction = horizontalDirection(origin, target);

	return direction.mul(speed * math.cos(angle)).add(new Vector3(0, speed * math.sin(angle), 0));
}

/**
 * The horizontal unit vector pointing to the thrower's **left**, for a throw
 * from `origin` toward `target`.
 *
 * "Left" has to be left *relative to the throw*. A world axis would send every
 * curveball the same compass way — correct only for the one facing that happens
 * to line up, and wrong for anyone throwing the other way.
 *
 * Derived from the aim rather than from a solved launch velocity, because the
 * velocity depends on the acceleration the caller is about to choose, and that
 * would be circular.
 */
export function leftAxis(origin: Vector3, target: Vector3): Vector3 {
	return new Vector3(0, 1, 0).Cross(horizontalDirection(origin, target)).Unit;
}

/** A launch position and velocity, ready to hand to a projectile. */
export interface LaunchPlan {
	/** Where the projectile actually starts — clear of the thrower. */
	origin: Vector3;
	/** Velocity to apply at that origin. */
	velocity: Vector3;
	/**
	 * The arc that was actually used, which is not always the one asked for: a
	 * `straight` or `curve` throw aimed above the launch line has no fall to solve
	 * with and comes back as an `overhead` one. Read this, not your input, when
	 * you want to know what happened.
	 */
	arc: ThrowArc;
	/**
	 * Constant world-space acceleration the flight runs under, on top of gravity.
	 * Zero for every arc except the curve, which needs one: an initial velocity
	 * alone can never bend a path.
	 *
	 * The server turns this into a force and the client simulates the identical
	 * vector, from this same field, so the guide and the ball fly one curve.
	 */
	acceleration: Vector3;
	/**
	 * How long the flight to the target is expected to take, in seconds.
	 *
	 * The server uses it to stop applying {@link acceleration} once the throw has
	 * arrived: a curve is a flight phenomenon, and a force still attached to a
	 * ball that has landed would keep shoving it sideways across the floor.
	 */
	flightTime: number;
}

/** How a launch is shaped, and the forces it flies under. All optional. */
export interface LaunchOptions {
	/** Gravity to solve against. Defaults to `Workspace.Gravity`. */
	gravity?: number;
	/**
	 * Constant sideways acceleration, in studs per second squared — the pull a
	 * `curve` flies under. Ignored by the other arcs.
	 */
	acceleration?: Vector3;
	/**
	 * Whether a `curve` cancels that pull's drift in its launch, so it arrives on
	 * the mark. Defaults to true; see {@link withLateralCompensation} for what
	 * false does instead.
	 */
	compensate?: boolean;
	/**
	 * Launch angle for the flat arcs, in radians. Defaults to
	 * {@link MIN_THROW_ANGLE}.
	 *
	 * Worth knowing what this can and cannot do, because it looks like a "how much
	 * does it curve" knob and is not one. On level ground a flat launch has exactly
	 * one speed that lands on a given point, `v = √(g·d / sin 2θ)`, so a steeper
	 * angle buys a *slower* throw and a longer flight — and since the sideways pull
	 * has that longer flight to work in, more bend per unit of it. It cannot change
	 * how far the ball bows for a given launcher angle off the aim line: see
	 * {@link withLateralCompensation}.
	 */
	angle?: number;
}

/**
 * Solves for the launch velocity that sends a projectile from `origin` to
 * `target` at a given `speed`. Gravity then shapes the parabola.
 *
 * `overhead` picks between the quadratic's two roots and takes the flatter one.
 * Both roots reach the target exactly; the flatter one gets there sooner and
 * lower. When the target is out of reach for `speed`, it falls back to a 45°
 * lob, which is the maximum range for that speed.
 *
 * `straight` and `curve` both ignore `speed` as a tunable and launch flat —
 * `straight` at {@link MIN_THROW_ANGLE}, `curve` at
 * {@link LaunchOptions.angle} if the caller gave one. The caller must have taken
 * that speed from {@link flatLaunchSpeed} *at the same angle*, or the throw will
 * miss. `curve` then either cancels `acceleration`'s drift in the launch, so it
 * arrives on the mark, or leaves the launch alone and lets the pull carry it off
 * the mark; see {@link LaunchOptions.compensate}.
 */
export function solveLaunchVelocity(
	origin: Vector3,
	target: Vector3,
	speed: number,
	arc: ThrowArc,
	options: LaunchOptions = {},
): Vector3 {
	const gravity = options.gravity ?? Workspace.Gravity;

	if (arc === "straight" || arc === "curve") {
		// No launch arc to speak of: out flat, and let gravity do the shaping.
		const flat = velocityAtAngle(origin, target, speed, options.angle ?? MIN_THROW_ANGLE);
		if (arc === "straight") return flat;

		return withLateralCompensation(
			origin,
			target,
			flat,
			options.acceleration ?? new Vector3(),
			options.compensate ?? true,
		);
	}

	const delta = target.sub(origin);
	const horizontal = new Vector3(delta.X, 0, delta.Z);
	const distance = horizontal.Magnitude;
	const height = delta.Y;

	const speedSq = speed * speed;
	const discriminant = speedSq * speedSq - gravity * (gravity * distance * distance + 2 * height * speedSq);

	let angle: number;
	if (distance > 0.001 && discriminant >= 0) {
		const root = math.sqrt(discriminant);
		// Lower root = the flatter of the two arcs that reach the target. At the
		// exact minimum speed the roots coincide and the arcs merge; more speed
		// separates them, so how hard a throw is pushed decides how flat it sits.
		// See THROW_ARC_SPREAD.
		const flat = math.atan((speedSq - root) / (gravity * distance));
		angle = math.clamp(flat, MIN_THROW_ANGLE, MAX_THROW_ANGLE);
	} else {
		// Out of range for this speed — lob at 45° for the most distance we can get.
		angle = math.rad(45);
	}

	return velocityAtAngle(origin, target, speed, angle);
}

/**
 * Bends a flat launch sideways, so a lateral `acceleration` either still lands
 * the throw on the mark or visibly carries it off.
 *
 * The pull is constant, so the offset it accumulates over a flight of length `T`
 * is just a parabola: `offset(t) = ½·a·t² + v_lat·t`.
 *
 * - **Compensated** (the default) forces `offset(T) = 0`, so the launch leaves
 *   the aim line by `v_lat = -½·a·T` and the pull brings it back. Nothing to
 *   iterate — it is closed form, unlike the in-plane solve.
 * - **Uncompensated** returns the launch untouched: straight at the target, with
 *   the pull carrying the ball `½·a·T²` wide of it. Four times as far, because
 *   the compensated path only gets half the flight to fall away and spends the
 *   other half coming back. The caller's aim guide has to show that landing, and
 *   in this project it does — it simulates the same pull.
 *
 * **Both ends pinned is expensive, and this is the thing to know when tuning.**
 * The compensated bow works out to `d·tan φ / 4`, where `tan φ = a·tan θ / g` is
 * the angle the launch leaves the aim line by. So the bend and the launch's
 * off-line angle are *the same quantity*: a flight that bows by 20% of its range
 * has to be slung 39° wide to do it. Leaving it uncompensated is the way to get
 * a bend without a side-armed launch.
 *
 * Only the part of `acceleration` perpendicular to the aim is compensated. A
 * pull along the aim line changes the flight time rather than the heading, and
 * that is a faster or slower throw, not a curve.
 */
function withLateralCompensation(
	origin: Vector3,
	target: Vector3,
	flat: Vector3,
	acceleration: Vector3,
	compensate: boolean,
): Vector3 {
	const direction = horizontalDirection(origin, target);
	const lateral = acceleration.sub(direction.mul(acceleration.Dot(direction)));
	if (lateral.Magnitude < 0.001) return flat;

	if (!compensate) return flat;

	// The along-aim speed is what carries the ball to the target, and a
	// perpendicular force never touches it — so this flight time is exact.
	const alongSpeed = new Vector3(flat.X, 0, flat.Z).Magnitude;
	if (alongSpeed < 0.001) return flat;

	const flight = horizontalDistance(origin, target) / alongSpeed;
	return flat.add(lateral.mul(-0.5 * flight));
}

/**
 * The speed a launch at `angle` needs so that gravity alone drops it onto
 * `target`. Defaults to {@link MIN_THROW_ANGLE}, the flat throw's angle.
 *
 * A throw at a fixed angle only has one speed that lands on a given point, and
 * it follows from how much fall the flight has to work with:
 * `v² = g·d² / (2·cos²θ·(d·tanθ - h))`. That is why a steeper angle is a slower
 * throw and not a different way of aiming one.
 *
 * Returns `undefined` when the target sits above the launch line — there is no
 * fall to work with, so no speed exists and the caller should use the arcing
 * throw instead. A steeper `angle` raises that line, so it fails less often.
 */
export function flatLaunchSpeed(
	origin: Vector3,
	target: Vector3,
	angle = MIN_THROW_ANGLE,
	gravity = Workspace.Gravity,
): number | undefined {
	const delta = target.sub(origin);
	const distance = new Vector3(delta.X, 0, delta.Z).Magnitude;
	const height = delta.Y;

	// How far the launch line climbs over the distance, minus how far it must
	// climb to reach the target. This is the drop gravity gets to work with.
	const drop = distance * math.tan(angle) - height;
	if (distance <= 0.001 || drop <= 0) return undefined;

	const cos = math.cos(angle);
	return math.sqrt((gravity * distance * distance) / (2 * cos * cos * drop));
}

/**
 * Seconds for a projectile launched at `velocity` to cover the horizontal
 * distance to `target`.
 *
 * Exact for all three arcs: nothing in this module accelerates a projectile
 * *along* the aim line, so the along-aim speed it leaves with is the one it
 * arrives with. A perpendicular pull changes the heading, not the progress.
 *
 * Returns zero for a launch that never travels, which only happens on a
 * degenerate aim with nothing to throw at.
 */
function flightTimeTo(origin: Vector3, target: Vector3, velocity: Vector3): number {
	const along = velocity.Dot(horizontalDirection(origin, target));
	return along > 0.001 ? horizontalDistance(origin, target) / along : 0;
}

/**
 * Turns "throw this at that" into the exact origin/velocity pair a projectile
 * needs.
 *
 * `arc` chooses between the ways to reach the target; see
 * {@link solveLaunchVelocity}. For `straight` and `curve`, `speed` must come
 * from {@link flatLaunchSpeed} rather than being chosen freely.
 *
 * `options.acceleration` is the constant sideways pull the flight runs under,
 * which is what makes a curve; leave it out for the gravity-only arcs, and leave
 * it out for a `curve` too if you want that throw to fly straight.
 */
export function planLaunch(
	from: Vector3,
	target: Vector3,
	speed: number,
	arc: ThrowArc,
	options: LaunchOptions = {},
): LaunchPlan {
	const velocity = solveLaunchVelocity(from, target, speed, arc, options);
	return {
		origin: from,
		velocity,
		arc,
		acceleration: options.acceleration ?? new Vector3(),
		flightTime: flightTimeTo(from, target, velocity),
	};
}

/**
 * The slowest launch speed that can still reach `target` from `origin`.
 *
 * The cheapest arc to a point is launched at 45° plus half the angle to the
 * target, and that arc's speed works out to `sqrt(g * (h + sqrt(h² + d²)))` for
 * horizontal distance `d` and height difference `h`. At `h = 0` it agrees with
 * the familiar `v² / g` range limit: reaching 51 studs takes exactly 100 studs/s.
 *
 * Targets below `origin` need less speed, and one directly below needs none —
 * which is correct, it just has to fall.
 */
export function minimumReachSpeed(origin: Vector3, target: Vector3, gravity = Workspace.Gravity): number {
	const delta = target.sub(origin);
	const distance = new Vector3(delta.X, 0, delta.Z).Magnitude;
	const height = delta.Y;

	return math.sqrt(gravity * (height + math.sqrt(height * height + distance * distance)));
}

/** How to simulate the arc. All optional. */
export interface TrajectoryOptions {
	/** Gravity to integrate against. Defaults to `Workspace.Gravity`. */
	gravity?: number;
	/**
	 * Constant world acceleration on top of gravity, in studs per second squared.
	 * This is what makes a curve — pass {@link LaunchPlan.acceleration} so the
	 * drawn path matches the force the server applies.
	 */
	acceleration?: Vector3;
	/** Simulation timestep, in seconds. Smaller is smoother and costlier. */
	step?: number;	/** Give up after this many seconds of flight. */
	maxTime?: number;
	/** Instances the arc flies straight through — usually the thrower. */
	ignore?: Instance[];
	/** Set false for pure maths with no collision checks at all. */
	collide?: boolean;
	/**
	 * Radius of the projectile, in studs. Zero (the default) traces the path as a
	 * mathematical line instead.
	 *
	 * Worth setting for anything with real size: a ball bounces off a surface
	 * when its *edge* touches, which is a full radius before its centre arrives.
	 * Predicting with a bare ray always marks the impact too late.
	 */
	radius?: number;
}

/**
 * Simulation timestep. This is a real trade-off, not a detail:
 *
 * - Each step adds a corner to the drawn path, so a large step renders the arc
 *   as a visibly angular polygon rather than a curve.
 * - Each step's collision test runs along a straight *chord*, which sags below
 *   the true parabola by `g * step² / 8`. At 0.1s that is nearly a quarter of a
 *   stud, so hits are detected early by a variable margin — and which chord
 *   crosses a surface first can flip from frame to frame, which makes the
 *   reported landing point jump while the arc itself is barely moving.
 *
 * 0.03s keeps the sag under 0.03 studs and the corners small enough to read as
 * a curve, at roughly three times the raycast count of the old 0.1s.
 */
const DEFAULT_STEP = 0.03;
const DEFAULT_MAX_TIME = 4;

/**
 * A simulated flight path.
 *
 * ```ts
 * const plan = planPlayerThrow(character, aimPoint);
 * const arc = new Trajectory(plan.origin, plan.velocity, { ignore: [character] });
 * print(arc.landing, arc.duration, arc.hit);
 * ```
 */
export class Trajectory {
	/** Where the simulation started. */
	public readonly origin: Vector3;
	/** Velocity the flight started with. */
	public readonly velocity: Vector3;
	/** Sampled positions along the arc, starting at `origin`. */
	public readonly points: ReadonlyArray<Vector3>;
	/**
	 * Final point of the path — where the projectile's *centre* comes to rest.
	 *
	 * For anything with a radius this sits one radius clear of the surface; see
	 * {@link contact} for the point that actually stopped it.
	 */
	public readonly landing: Vector3;
	/** The point on a surface that stopped the projectile, if anything did. */
	public readonly contact: Vector3 | undefined;
	/** Which way that surface faces, if anything was hit. */
	public readonly normal: Vector3 | undefined;
	/** What the arc hit, if anything. */
	public readonly hit: BasePart | undefined;
	/** Flight time to `landing`, in seconds. */
	public readonly duration: number;

	constructor(origin: Vector3, velocity: Vector3, options: TrajectoryOptions = {}) {
		const gravity = options.gravity ?? Workspace.Gravity;
		// Gravity and a constant acceleration are the same thing to an
		// integrator, so they collapse into one pull vector. Keeping them
		// separate in the options is for the reader, not the maths.
		const acceleration = options.acceleration ?? new Vector3();
		const pull = new Vector3(acceleration.X, acceleration.Y - gravity, acceleration.Z);
		const step = options.step ?? DEFAULT_STEP;
		const maxTime = options.maxTime ?? DEFAULT_MAX_TIME;
		const collide = options.collide ?? true;
		const radius = options.radius ?? 0;

		const params = new RaycastParams();
		params.FilterType = Enum.RaycastFilterType.Exclude;
		params.FilterDescendantsInstances = options.ignore ?? [];
		params.IgnoreWater = true;

		const points: Vector3[] = [origin];
		let position = origin;
		let currentVelocity = velocity;
		let elapsed = 0;
		let hit: BasePart | undefined;
		let contact: Vector3 | undefined;
		let normal: Vector3 | undefined;

		while (elapsed < maxTime) {
			// Semi-implicit Euler: advance by the current velocity, then let the
			// pull bend it — which is what the engine does to the real ball.
			const stepPosition = position.add(currentVelocity.mul(step)).add(pull.mul(0.5 * step * step));
			currentVelocity = currentVelocity.add(pull.mul(step));
			elapsed += step;

			const offset = stepPosition.sub(position);
			let result: RaycastResult | undefined;
			if (collide && offset.Magnitude > 0.001) {
				// A sphere sweep asks "where does this ball touch?", where a ray
				// only asks where its centre would go.
				result =
					radius > 0
						? Workspace.Spherecast(position, radius, offset, params)
						: Workspace.Raycast(position, offset, params);
			}

			if (result) {
				// `Distance` is how far the shape travelled, so this is where the
				// projectile's centre stops. `Position` is the point on the surface
				// that stopped it — a radius away from that centre.
				points.push(position.add(offset.Unit.mul(result.Distance)));
				hit = result.Instance;
				contact = result.Position;
				normal = result.Normal;
				position = points[points.size() - 1];
				break;
			}

			points.push(stepPosition);
			position = stepPosition;
		}

		this.origin = origin;
		this.velocity = velocity;
		this.points = points;
		this.landing = position;
		this.contact = contact;
		this.normal = normal;
		this.hit = hit;
		this.duration = elapsed;
	}
}
