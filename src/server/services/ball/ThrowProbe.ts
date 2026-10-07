import { RunService, Workspace } from "@rbxts/services";
import { BALL_NAME, BALL_SIZE } from "shared/constants";
import { LaunchPlan, Trajectory } from "shared/Trajectory";

/**
 * Measurement scaffolding for "the ball does not land where the guide drew it,
 * and not in the same place twice".
 *
 * **The clock is engine time, not `os.clock()`.** `os.clock` reports CPU time,
 * and it falls behind the game clock by however long the process spent waiting —
 * which lands in these numbers looking exactly like a physics problem. One run
 * of this probe reported 9.7 studs/s of "lost" sideways velocity and 6.4 studs/s
 * of "lost" vertical velocity, in the precise ratio of the curve's pull to
 * gravity, 300 : 196.2, with nothing at all missing along the throw. That is a
 * stopwatch error: a real force error cannot be proportional to the one vector
 * the physics is already applying, and a real launch error cannot be invisible
 * in the aim direction. Both axes independently implied the same lag, 32ms.
 *
 * Per throw it prints:
 *
 * - **`predict`** — the plan's own curve, with the same options the client's aim
 *   guide draws from. `Trajectory` integrates that curve exactly (its step is
 *   exact for a constant pull), so this is the guide, not a model of it.
 * - **`clock`** — how far the ball is ahead of (or behind) the probe's clock,
 *   from projecting the velocity deviation onto the pull.
 * - **`launch error`** — what is left of that deviation once the clock is taken
 *   out. **This is the number to watch**: a vector that repeats across throws is
 *   a lost impulse at release and can be put back; one that scatters is timing,
 *   and no amount of arithmetic fixes it.
 * - **`path`** — position error at the same instant, clock offset removed. The
 *   solve and the engine flying different curves shows up here and grows with
 *   time; a constant offset instead means the launch point itself differed.
 * - **`landing`** — where the ball's *centre* crossed the surface the plan
 *   expected to be hit, interpolated across the frame the velocity changed in.
 *   This is the one to compare across throws: same click, same landing numbers
 *   => the maths is right and what you are seeing move is the engine's contact.
 *
 * **A Pierce throw compares a plan that stops at a body with a ball that does not, and that difference
 * is not an error.** The reference curve below is built with no `passable` predicate — it is the plan as
 * an *ordinary* ball would fly it — so for a Pierce throw the ball keeps going past the contact this
 * predicts, and the `landing` error printed will be about the length of the throw. Passing the guide's
 * `passesThroughBodies` when the ball's own attribute says `Pierce` is the one-line fix when somebody
 * needs this number for that ability. It is not done here because the predicate is written where the
 * guide is drawn, and lifting it into shared code is a change nobody has asked for.
 *
 * Printed from `BallService`, behind `DEBUG_CONFIG.VERBOSE_LOGS` — see
 * `shared/config/debug.config.ts`. Everything this file prints is behind that gate; the probe is
 * not even started when it is off.
 */

/** When to take the first path and velocity sample, in seconds of engine time. */
const SAMPLE_AT = 0.1;

/**
 * How often to sample again after that, in seconds of engine time.
 *
 * **One sample cannot say what shape an error has, and that is the whole question here.** A deviation
 * that is a constant *velocity* offset grows linearly with time; one that is an *acceleration* offset
 * grows with the square of it. Both read as "the ball lands short", and they want opposite fixes — so
 * the curve between the samples is the answer, and a single reading at 0.1s was what hid it. The first
 * throw measured with this reported a launch *above* the plan and a landing *below* it, which no
 * constant velocity offset can do and is exactly what more than one sample is needed to see.
 */
const SAMPLE_PERIOD = 0.1;
/** Stop watching a throw after this long, in seconds of engine time. */
const WATCH_LIMIT = 3;
/** Ignore velocity changes this soon after release — replication has not settled. */
const IMPACT_GRACE = 0.05;
/** Standoff between the ball's centre and the surface it rests on: its own radius. */
const RADIUS = BALL_SIZE / 2;

/** Watches one thrown ball and reports how far the engine's flight is from the plan's. */
export function watchThrow(ball: BasePart, plan: LaunchPlan, thrower: Model): void {
	// The reference curve: the same plan, the same maths and the same options the
	// aim guide draws from, so this is the guide rather than a model of it.
	const predicted = new Trajectory(plan.origin, plan.velocity, {
		acceleration: plan.acceleration,
		radius: RADIUS,
		// **The plan's own gravity, read off the plan.** The guide integrates the same number and the ball
		// flies under it — see `BallFactory.applyBallGravity`. A probe that stepped at anything else would
		// hold the ball against an arc nobody throws, and report it as wrong for matching its own plan.
		gravity: plan.gravity,
		ignore: [thrower, ball, ...otherBalls(ball)],
	});

	// Gravity and the curve's pull collapsed into one vector, exactly as
	// `Trajectory` does internally — so the ideal below comes from the closed
	// form rather than from stepping anything.
	const pull = new Vector3(plan.acceleration.X, plan.acceleration.Y - plan.gravity, plan.acceleration.Z);
	const pullSquared = pull.Dot(pull);
	const heading = horizontalHeading(plan.origin, predicted.landing);
	const contact = predicted.contact ?? predicted.landing;
	const normal = predicted.normal ?? new Vector3(0, 1, 0);

	print(
		`[Probe] predict landing ${reported(predicted.landing)}` +
			` contact ${reported(contact)} in ${fixed(predicted.duration)}s over ${predicted.points.size()} points`,
	);

	let elapsed = 0;
	let nextSample = SAMPLE_AT;
	let previousPosition = ball.Position;
	let previousElapsed = 0;

	const connection = RunService.Heartbeat.Connect((frame) => {
		// Engine time, accumulated from the deltas the engine itself reports.
		elapsed += frame;

		if (ball.Parent === undefined || elapsed > WATCH_LIMIT) {
			connection.Disconnect();

			// **The case that used to leave no trace at all.** A ball that meets something which does not
			// stop it — a glancing wall, another ball — never crosses the predicted surface and never trips
			// the impact test, so this watch simply ended in silence and read as "this throw was never
			// watched". One line, on the timeout only, for the reason the HUD controllers print that they
			// are up: a measurement that produces nothing has to be distinguishable from no measurement.
			if (ball.Parent !== undefined) {
				print(
					`[Probe] still flying at t=${fixed(elapsed)}s (at ${reported(ball.Position)})` +
						` — never met the predicted surface`,
				);
			}

			return;
		}

		const position = ball.Position;
		const velocity = ball.AssemblyLinearVelocity;
		const idealVelocity = plan.velocity.add(pull.mul(elapsed));

		// The pull is the only thing that changes a velocity in flight, so any
		// deviation along it is a disagreement about *time*, not about force. Split
		// it out and the rest becomes readable: a lost launch impulse cannot hide
		// in the pull's direction, because a launch points along the aim and the
		// pull points across it.
		const loss = velocity.sub(idealVelocity);
		const clock = pullSquared > 0.001 ? loss.Dot(pull) / pullSquared : 0;
		const launchError = loss.sub(pull.mul(clock));

		if (elapsed >= nextSample) {
			nextSample += SAMPLE_PERIOD;
			// Compared at the instant the ball is actually at, so the clock offset is
			// not counted twice.
			const at = elapsed + clock;
			const expected = plan.origin.add(plan.velocity.mul(at)).add(pull.mul(0.5 * at * at));

			print(
				`[Probe] t=${fixed(elapsed)} frame=${fixed(frame)} clock ${signed(clock * 1000)}ms` +
					` | launch error ${reported(launchError)}` +
					` | path ${describe(position.sub(expected), heading)}`,
			);
		}

		// The engine taking the velocity back is the impact: it is rising when the
		// plan says it is still falling, or its horizontal part has collapsed.
		// Detected this way because `Touched` cannot be relied on for a part whose
		// owner may have changed mid-flight.
		//
		// **"Rising while the plan says falling" is the first clause, and it took a log to see that it
		// was written as something else.** As `velocity.Y > idealVelocity.Y + 1` it fires on a throw that
		// is flying perfectly: at 60 steps a second the ideal's own vertical velocity drops by
		// `g/60 ≈ 3.3` studs per second between two samples, so a sampling offset of a third of a frame
		// is already more than the 1 stud/s of tolerance. The test can therefore only pass if the ball's
		// velocity is read at exactly the plan's instant, which it never is — and every throw of a
		// session ended this watch within a few frames, before the 0.1s sample, which is why this file
		// had never reported a landing. Both meanings are kept and nothing else is: a ball that has
		// genuinely been stopped satisfies the horizontal collapse, and a ball coming off something
		// satisfies the first. A clock offset satisfies neither.
		const horizontal = new Vector3(velocity.X, 0, velocity.Z).Magnitude;
		const idealHorizontal = new Vector3(idealVelocity.X, 0, idealVelocity.Z).Magnitude;
		const caught =
			(velocity.Y > 0 && idealVelocity.Y < 0) || (idealHorizontal > 1 && horizontal < idealHorizontal * 0.5);

		if (elapsed > IMPACT_GRACE && caught) {
			connection.Disconnect();

			// Where the ball's centre crossed the surface the plan expected, taken
			// across the last frame rather than at the last sample: at 80 studs/s a
			// frame is over a stud of travel, so sampling whole frames would put more
			// error on this number than the thing being measured.
			const standoff = (p: Vector3) => p.sub(contact).Dot(normal) - RADIUS;
			const from = standoff(previousPosition);
			const to = standoff(position);

			if (from > 0 && to <= 0) {
				const part = from / (from - to);
				const hit = previousPosition.add(position.sub(previousPosition).mul(part));
				const when = previousElapsed + (elapsed - previousElapsed) * part;
				print(
					`[Probe] landing ${describe(hit.sub(predicted.landing), heading)}` +
						` | flight ${fixed(when)}s (plan ${fixed(predicted.duration)}s)` +
						` | frame ${fixed(frame)}s`,
				);
			} else {
				// **And the landing is reported either way, because a ball that bounces inside a single frame
				// never crosses the predicted surface *between two samples*.** At 60 steps a second and
				// 170 studs a second a frame is nearly three studs of travel, and the bounce sends the ball
				// back up inside one of them — so the crossing the interpolation above looks for is not
				// there, and the one throw this matters most for reported no landing at all. The sample
				// before the impact is the closest thing to where it met the floor.
				print(
					`[Probe] stopped t=${fixed(elapsed)}s without crossing the predicted` +
						` surface (at ${reported(position)}) — it hit something else`,
				);
				print(
					`[Probe] landing (last sample)` +
						` ${describe(previousPosition.sub(predicted.landing), heading)}`,
				);
			}

			return;
		}

		previousPosition = position;
		previousElapsed = elapsed;
	});
}

/**
 * Every other ball in the world.
 *
 * The guide passes through them for a reason — a swept sphere that grazes one
 * flips between touching and missing it frame to frame — so the reference curve
 * has to ignore them too, or this probe would be reporting their wobble.
 */
function otherBalls(exclude: BasePart): BasePart[] {
	const balls: BasePart[] = [];
	for (const child of Workspace.GetChildren()) {
		if (child !== exclude && child.Name === BALL_NAME && child.IsA("BasePart")) {
			balls.push(child);
		}
	}

	return balls;
}

/** Unit direction of a throw as seen from above. */
function horizontalHeading(from: Vector3, to: Vector3): Vector3 {
	const flat = new Vector3(to.X - from.X, 0, to.Z - from.Z);
	return flat.Magnitude > 0.001 ? flat.Unit : new Vector3(0, 0, -1);
}

/**
 * Splits an error into the three directions that matter: how far along the
 * throw it is, how far to the side of it, and how far above or below.
 */
function describe(offset: Vector3, heading: Vector3): string {
	const along = offset.Dot(heading);
	const left = offset.Dot(new Vector3(0, 1, 0).Cross(heading).Unit);
	return `along ${signed(along)} left ${signed(left)} up ${signed(offset.Y)}`;
}

/** Two decimals with an explicit sign, so a bias is visible at a glance. */
function signed(value: number): string {
	return string.format("%+.2f", value);
}

/** Three decimals, for times and frame lengths. */
function fixed(value: number): string {
	return string.format("%.3f", value);
}

/** A vector, for eyeballing pairs of throws against each other. */
function reported(v: Vector3): string {
	return `(${string.format("%.2f", v.X)}, ${string.format("%.2f", v.Y)}, ${string.format("%.2f", v.Z)})`;
}
