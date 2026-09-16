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
 * Note that the offset follows the *throw direction*, so it is only as safe as
 * the point it is measured from — offset from a hand held against your side and
 * an inward throw will push the start point straight through your own chest.
 * `shared/throw.ts` handles that by measuring from the thrower's head.
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

/** How to simulate the arc. All optional. */
export interface TrajectoryOptions {
	/** Gravity to integrate against. Defaults to `Workspace.Gravity`. */
	gravity?: number;
	/** Simulation timestep, in seconds. Smaller is smoother and costlier. */
	step?: number;
	/** Give up after this many seconds of flight. */
	maxTime?: number;
	/** Instances the arc flies straight through — usually the thrower. */
	ignore?: Instance[];
	/** Set false for pure maths with no collision checks at all. */
	collide?: boolean;
}

const DEFAULT_STEP = 0.1;
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
	/** Final point — the ground, a wall, or wherever `maxTime` ran out. */
	public readonly landing: Vector3;
	/** What the arc hit, if anything. */
	public readonly hit: BasePart | undefined;
	/** Flight time to `landing`, in seconds. */
	public readonly duration: number;

	constructor(origin: Vector3, velocity: Vector3, options: TrajectoryOptions = {}) {
		const gravity = options.gravity ?? Workspace.Gravity;
		const step = options.step ?? DEFAULT_STEP;
		const maxTime = options.maxTime ?? DEFAULT_MAX_TIME;
		const collide = options.collide ?? true;

		const params = new RaycastParams();
		params.FilterType = Enum.RaycastFilterType.Exclude;
		params.FilterDescendantsInstances = options.ignore ?? [];
		params.IgnoreWater = true;

		const points: Vector3[] = [origin];
		let position = origin;
		let currentVelocity = velocity;
		let elapsed = 0;
		let hit: BasePart | undefined;

		while (elapsed < maxTime) {
			// Semi-implicit Euler: advance by the current velocity, then let
			// gravity bend it — which is what the engine does to the real ball.
			const stepPosition = position
				.add(currentVelocity.mul(step))
				.add(new Vector3(0, -0.5 * gravity * step * step, 0));
			currentVelocity = currentVelocity.add(new Vector3(0, -gravity * step, 0));
			elapsed += step;

			const result = collide ? Workspace.Raycast(position, stepPosition.sub(position), params) : undefined;
			if (result) {
				points.push(result.Position);
				hit = result.Instance;
				position = result.Position;
				break;
			}

			points.push(stepPosition);
			position = stepPosition;
		}

		this.origin = origin;
		this.velocity = velocity;
		this.points = points;
		this.landing = position;
		this.hit = hit;
		this.duration = elapsed;
	}
}
