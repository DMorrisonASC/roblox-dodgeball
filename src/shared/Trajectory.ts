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

/** Steepest and shallowest throws the solver will produce. */
const MIN_THROW_ANGLE = math.rad(5);
const MAX_THROW_ANGLE = math.rad(85);

/** A launch position and velocity, ready to hand to a projectile. */
export interface LaunchPlan {
	/** Where the projectile actually starts — clear of the thrower. */
	origin: Vector3;
	/** Velocity to apply at that origin. */
	velocity: Vector3;
}

/**
 * Solves for the launch velocity that sends a projectile from `origin` to
 * `target` at a fixed `speed`. Gravity then shapes the parabola.
 *
 * When the target is further away than `speed` can reach, this falls back to a
 * 45° lob, which is the maximum range for that speed.
 */
export function solveLaunchVelocity(
	origin: Vector3,
	target: Vector3,
	speed: number,
	gravity = Workspace.Gravity,
): Vector3 {
	const delta = target.sub(origin);
	const horizontal = new Vector3(delta.X, 0, delta.Z);
	const distance = horizontal.Magnitude;
	const height = delta.Y;

	const horizontalDir = distance > 0.001 ? horizontal.div(distance) : new Vector3(0, 0, -1);

	const speedSq = speed * speed;
	const discriminant = speedSq * speedSq - gravity * (gravity * distance * distance + 2 * height * speedSq);

	let angle: number;
	if (distance > 0.001 && discriminant >= 0) {
		const root = math.sqrt(discriminant);
		// Lower root = flatter (direct) throw; higher root = lobbed throw.
		const flat = math.atan((speedSq - root) / (gravity * distance));
		angle = math.clamp(flat, MIN_THROW_ANGLE, MAX_THROW_ANGLE);
	} else {
		// Out of range for this speed — lob at 45° for the most distance we can get.
		angle = math.rad(45);
	}

	const horizontalSpeed = speed * math.cos(angle);
	const verticalSpeed = speed * math.sin(angle);
	return horizontalDir.mul(horizontalSpeed).add(new Vector3(0, verticalSpeed, 0));
}

/**
 * Turns "throw this at that" into the exact origin/velocity pair a projectile
 * needs.
 *
 * `clearance` nudges the start point that many studs along the throw, so the
 * projectile begins its flight outside the thrower instead of inside them.
 * Because the offset follows the *throw direction*, it is only as safe as the
 * point it is measured from — offset from a hand held against your side and an
 * inward throw will push the start point straight through your own chest.
 * Player throws place their muzzle directly (see `shared/throw.ts`) and leave
 * this at zero; it is here for projectiles that launch from a fixed point.
 */
export function planLaunch(
	from: Vector3,
	target: Vector3,
	speed: number,
	clearance = 0,
	gravity = Workspace.Gravity,
): LaunchPlan {
	const velocity = solveLaunchVelocity(from, target, speed, gravity);
	return { origin: from.add(velocity.Unit.mul(clearance)), velocity };
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
	 * PreDicting with a bare ray always marks the impact too late.
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
			// Semi-implicit Euler: advance by the current velocity, then let
			// gravity bend it — which is what the engine does to the real ball.
			const stepPosition = position
				.add(currentVelocity.mul(step))
				.add(new Vector3(0, -0.5 * gravity * step * step, 0));
			currentVelocity = currentVelocity.add(new Vector3(0, -gravity * step, 0));
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
