import { BALL_CONFIG } from "shared/config/ball.config";
import { resolveDodgeable } from "shared/dodge";
import { BEHAVIOR_SEEKING, NpcBehavior } from "../Behavior";
import type { BallPickupService } from "../../services/ball/BallPickupService";
import type { BallService } from "../../services/ball/BallService";

/**
 * How often the behavior looks again, in seconds: the retarget interval.
 *
 * **This is the only thing that paces `MoveTo`, and that is the point of it.** A walk is issued when
 * there is a new ball to walk to, or when the ball already being walked to has moved far enough to
 * be worth re-aiming at — so the call lands on the turn a walk *starts* or *re-aims*, and no other:
 * `MoveTo` re-issued at the same point is the same walk asked for again, and asked for sixty times a
 * second it would be that as well.
 *
 * This is also the behavior's tick interval, deliberately, so that there is one number here rather
 * than a tick rate that can drift away from a retarget rate.
 *
 * **Placeholder.**
 */
const SEEK_RETARGET_SECONDS = 0.5;

/**
 * How far a ball has to move before what this behavior knows about it is out of date, in studs.
 *
 * One number for two questions, because it is one question — *has this ball moved enough to be a
 * different ball?* — asked about the ball being walked to (re-aim at it) and about a ball the rig
 * gave up on (ask about it again). A ball that has been thrown and landed somewhere else is worth
 * a second look for exactly the reason it is worth re-aiming at.
 *
 * **Placeholder.**
 */
const SEEK_BALL_MOVED_STUDS = 4;

/**
 * How many turns in a row of failing to get closer end the walk to a ball.
 *
 * **Turns rather than seconds, and that is the point of the number.** `NpcService` skips a
 * behavior's tick while its rig is frozen or out of the world, so a rig held still by somebody
 * else never had the chance to make progress and must not be charged for the time it spent not
 * making any. A count of the ticks that actually happened cannot charge it; a clock would, and
 * would abandon balls on the strength of a freeze.
 *
 * At the interval above this is a second and a half of walking without getting closer. It is not
 * a reachability test — see the file comment for what it stands in for and why nothing here can
 * test reachability directly.
 *
 * **Placeholder.**
 */
const SEEK_STALL_TICKS = 3;

/**
 * What one rig is doing about balls.
 *
 * Kept per rig because a behavior is **one object shared by every rig that wears its tag**, so the
 * only place a rig's own progress can live is a map keyed by its model — the same shape
 * `RespawnBehavior` keeps its templates and its homes in, and for the same reason.
 */
interface Seek {
	/** The loose ball this rig is walking to, and `undefined` when it is not walking anywhere. */
	ball?: BasePart;

	/** Where that ball was when the walk was last issued, so a ball that rolls can be re-aimed at. */
	aimedAt?: Vector3;

	/** The closest this rig has been to {@link ball} so far. */
	best: number;

	/** How many turns in a row have failed to beat {@link best}. */
	stalled: number;

	/** Balls this rig has given up on, and where each was when it gave up. */
	givenUp: Map<BasePart, Vector3>;
}

/**
 * Walking to a ball, for an NPC.
 *
 * **This is the one behavior that moves the rig, and `MoveTo` is the whole of the movement.** Not
 * `PathfindingService`: it would put a path object, its waypoints and its failure modes into a
 * behavior whose job is to walk at something in an open field, and a path recomputed every half
 * second for every rig is the most expensive thing that could be put in this directory. What going
 * without costs is stated rather than hidden — `MoveTo` walks a straight line and cannot go round
 * anything — so this behavior is only ever as good as the floor it stands on. If the arena ever
 * grows something worth walking around, the change is inside `tick`, and the timing, the give-up
 * and the state all survive it.
 *
 * **Reachability, and what is done instead of testing it.** A rig on one side of the midline
 * barrier and a ball on the other is the plain case, and there is no cheap way to ask about it:
 * the barrier is `CanQuery = false` — the very flag that lets a ball cross it and an aim guide
 * pass through it — so a raycast from the rig to the ball goes straight through the wall and
 * reports a clear path. (A ray with `RespectCanCollide` does see the barrier, and then also sees
 * every dip in the floor and every low prop, which would silently refuse balls a rig could walk
 * straight to. A test against the barrier's own planes is exact, but it is arena geometry inside a
 * behavior, and it rests on the wall's parts being slabs.) So the walk is **bounded** instead: a
 * rig that has failed to get closer for `SEEK_STALL_TICKS` turns gives up on that ball, walks to
 * the next one, and will not walk at that one again until it has moved far enough to be a
 * different question.
 *
 * Its price is the only visible thing about this file: up to a second and a half of a rig pressed
 * against whatever is in its way, paid once per ball per rig. What that buys is a bound on *every*
 * obstruction rather than on the one the arena happens to have today — and, unlike a test, a bound
 * that needs nothing verified about the inside of a place file.
 *
 * **It fetches; it does not take.** A rig wearing this and not `Behavior_Pickup` walks to a ball
 * and then stands next to it, which is the correct reading of two tags that each mean one thing.
 * The pair is what produces a rig that collects, and the handover between them is
 * `BALL_CONFIG.PICKUP_RADIUS`: inside that distance the walk is over, because the ball is within a
 * picker's reach — and taking it is not this tag's job. That is also what stops a *successful*
 * walk from being read as a failure, since a rig standing next to the ball it set off for gets no
 * closer to it and would otherwise run out of patience on arrival.
 */
export function createSeekBehavior(pickups: BallPickupService, balls: BallService): NpcBehavior {
	/** One row per rig. See `onDied` for the row that goes with the rig it belonged to. */
	const walking = new Map<Model, Seek>();

	/** The rig's own row, made on first use. */
	const stateOf = (model: Model): Seek => {
		let seek = walking.get(model);
		if (seek === undefined) {
			seek = { best: math.huge, stalled: 0, givenUp: new Map() };
			walking.set(model, seek);
		}

		return seek;
	};

	/**
	 * The closest loose ball this rig has not given up on, or `undefined`.
	 *
	 * **The nearest-ball arithmetic is written twice in this project, and this is the second.**
	 * `BallPickupService.nearestLooseBall` cannot serve here, because it answers "what is closest"
	 * and the question asked here is "what is closest *among the balls this rig has not already
	 * failed to reach*" — a filter that belongs to the walker and not to the floor. Given the list,
	 * the difference is four lines; handed to the service it would be a skip list or a callback on
	 * a service that has no idea what a give-up is.
	 */
	const nearest = (loose: BasePart[], from: Vector3, givenUp: Map<BasePart, Vector3>): BasePart | undefined => {
		let best: BasePart | undefined;
		let bestDistance = math.huge;

		for (const ball of loose) {
			if (givenUp.has(ball)) continue;

			const distance = ball.Position.sub(from).Magnitude;
			if (distance > bestDistance) continue;

			best = ball;
			bestDistance = distance;
		}

		return best;
	};

	/**
	 * Forgets the balls this rig gave up on that are no longer the balls it gave up on.
	 *
	 * **This is what makes giving up temporary, and there is no clock in it.** A ball that has been
	 * thrown, kicked or rolled somewhere else is a different question — it may be reachable now —
	 * so it leaves the record by *moving*; a ball that has been destroyed leaves it for the mundane
	 * reason that a reference to nothing is nothing. Neither is a timer, and that is on purpose: a
	 * ball that has not moved has not become reachable, and re-asking about it every few seconds
	 * would buy a second walk into the same wall.
	 */
	const prune = (seek: Seek): void => {
		for (const [ball, givenUpAt] of seek.givenUp) {
			if (ball.Parent === undefined || ball.Position.sub(givenUpAt).Magnitude > SEEK_BALL_MOVED_STUDS) {
				seek.givenUp.delete(ball);
			}
		}
	};

	/**
	 * Stops the walk: the rig stands where it is and forgets what it was walking to.
	 *
	 * **`MoveTo` at the rig's own position is the stop; there is no separate one.** A humanoid walks
	 * until something tells it otherwise, and a destination it is already standing on is the
	 * engine's own way of saying "stay here" — the same call, with the point it is at.
	 *
	 * The early return is what keeps this from being a call issued on every retarget forever: a rig
	 * with no target was not walking, so there is nothing to stop, which makes **the target the flag
	 * for "there is a walk in progress"**. The rest of the state is cleared either way, because a
	 * rig that has just been given a ball has a progress count that means nothing any more.
	 */
	const stand = (humanoid: Humanoid, root: BasePart, seek: Seek): void => {
		if (seek.ball !== undefined) humanoid.MoveTo(root.Position);

		seek.ball = undefined;
		seek.aimedAt = undefined;
		seek.best = math.huge;
		seek.stalled = 0;
	};

	return {
		tag: BEHAVIOR_SEEKING,

		// The retarget interval, not a tick rate: see the constant for why those are the same
		// number here and why it is not a frame.
		tickInterval: SEEK_RETARGET_SECONDS,

		tick(model, humanoid) {
			// The part this rig is judged and moved by. `resolveDodgeable` rather than a name or a
			// `Humanoid.RootPart` read, because it is the helper a dodge, a catch and a pickup
			// already ask the same question through, and it answers for a rig with no humanoid too.
			const root = resolveDodgeable(model)?.root;
			if (!root) return;

			const seek = stateOf(model);

			// **Stop conditions, before anything is asked or moved.** The first is a ball in hand:
			// there is nothing to fetch, and this is the state a throwing rig spends most of its
			// time in. Asked of `BallService` rather than of the floor, because "am I holding one"
			// is the one question about balls that a list of loose ones cannot answer.
			if (balls.getHeldBall(model)) {
				stand(humanoid, root, seek);
				return;
			}

			// What is on the floor, asked once per turn and used for both questions below: is the
			// ball I set off for still there, and if not, which ball is next.
			const loose = pickups.looseBalls();

			// The ball it was walking to is not loose any more — taken out of the world, armed into
			// a throw, in somebody's hand, or dropped and still settling. The walk ends rather than
			// being re-aimed at something that is gone: which ball is right *now* is the question
			// below, and it is asked once.
			if (seek.ball !== undefined && !loose.includes(seek.ball)) stand(humanoid, root, seek);

			// Nothing to walk to. Quietly ordinary: an empty floor, every ball loose enough to be
			// seen but not yet settled, or nothing left that this rig has not already given up on.
			let ball = seek.ball;
			if (ball === undefined) {
				prune(seek);

				ball = nearest(loose, root.Position, seek.givenUp);
				if (ball === undefined) return;

				// A fresh walk, with no history: the distance is re-learned from this turn's, so a
				// rig that picks a ball up from further away than it gave the last one up gets the
				// whole patience again rather than whatever was left of it.
				seek.ball = ball;
				seek.aimedAt = undefined;
				seek.best = math.huge;
				seek.stalled = 0;
			}

			const distance = ball.Position.sub(root.Position).Magnitude;

			// **Close enough, and that is the end of the walk.** Inside a picker's reach the ball is
			// somebody's to take and this tag's job is done; the count is zeroed rather than left
			// standing, because a rig beside a ball has not been failing to reach it — see the file
			// comment. Nothing is issued either, so the rig keeps walking only as far as its own
			// arrival and stays there.
			if (distance <= BALL_CONFIG.PICKUP_RADIUS) {
				seek.best = math.huge;
				seek.stalled = 0;
				return;
			}

			// Closer than last turn, or not. Recorded as the *best* rather than the previous, so a
			// rig that is drifting closer counts as getting somewhere and a rig that is not counts
			// from the point it reached — which is what makes the count a measure of being *stuck*
			// rather than of being slow.
			if (distance < seek.best) {
				seek.best = distance;
				seek.stalled = 0;
			} else {
				seek.stalled += 1;
			}

			// Out of patience with this ball. It is written down *where it was*, so that the record
			// expires by the ball moving rather than by time passing, and the rig is stopped rather
			// than left walking at a wall it is not going to get past.
			if (seek.stalled >= SEEK_STALL_TICKS) {
				seek.givenUp.set(ball, ball.Position);
				stand(humanoid, root, seek);
				return;
			}

			// And the walk itself, issued only when there is something new to say: a new ball, or
			// one that has moved far enough that the old destination is out of date. Everything
			// else about this behavior exists to make this call rare.
			if (
				seek.aimedAt !== undefined &&
				ball.Position.sub(seek.aimedAt).Magnitude <= SEEK_BALL_MOVED_STUDS
			) {
				return;
			}

			humanoid.MoveTo(ball.Position);
			seek.aimedAt = ball.Position;
		},

		/**
		 * The rig's row goes when the rig does.
		 *
		 * A behavior is shared, so a row keyed by a model is a reference *to* that model: a corpse
		 * that `RespawnBehavior` is about to replace would otherwise keep the rig it belonged to
		 * alive for as long as the server runs. Nothing in the row is carried across, because there
		 * is nothing worth carrying — a replacement is a different model standing somewhere else,
		 * with the balls where they are, and a fresh row it makes itself on its first turn. The same
		 * reasoning `RespawnBehavior` uses to hand over a home and a template and nothing else.
		 */
		onDied(model) {
			walking.delete(model);
		},
	};
}
