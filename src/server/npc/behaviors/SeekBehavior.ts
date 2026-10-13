import { BALL_CONFIG } from "shared/config/ball.config";
import { resolveDodgeable } from "shared/dodge";
import { claim, claimedBy, release } from "../ballClaims";
import { fetchRegionFor, insideZone } from "../sideZones";
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

	/**
	 * Balls this rig has already been *told about* for being outside its region, so that line is an edge
	 * rather than a drumbeat.
	 *
	 * **A set of balls rather than a flag, because one line per ball is what makes the log readable.** A rig
	 * standing in a lobby with three loose balls in it says so three times, once, and then says nothing more —
	 * where a per-turn print would be six lines a second per rig, from every rig, in the one room where nobody
	 * is playing. Membership is cleared by `prune` when the ball is destroyed, which is also what stops the set
	 * holding a reference to a body that is gone.
	 *
	 * **Not cleared by movement, deliberately, and that is the difference from `givenUp`.** A give-up is a
	 * record about *this ball at this position* and expires when the ball moves, because the ball may have
	 * become reachable. A skip is a record about *this ball* and where the region is: a ball carried from the
	 * lobby into the rig's own half and back is the same ball, and the second skip is the same fact as the
	 * first — the state that would make it worth saying twice is the ball's position, which the line already
	 * carries as a distance.
	 */
	outside: Set<BasePart>;
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
 *
 * **And since 2026-10-13 it fetches only from one region, which is the rule the behaviour is really
 * parameterised by.** The factory takes a tag and a region, and the two variants built from it are a *round*
 * rig fetching inside its own half of the court and a *practice* rig fetching inside the practice zone — two
 * files, two tags, and no other difference between them. A ball outside the region is not a candidate and is
 * never walked to, which is what makes the walk-at-a-wall case above largely historical: the barrier now sits
 * beyond a boundary the selection refuses to cross, so the stall budget is left for the obstructions *inside*
 * a rig's own region, where a straight line can still be wrong. See `SeekRegion` below.
 */
export interface SeekRegion {
	/** What this region is called in the log — "its half", "the practice zone". See the skip line in `nearest`. */
	readonly label: string;

	/**
	 * The parts that *are* this rig's region, read once per choice.
	 *
	 * **A function returning parts rather than a function answering about a point, and the cost is why.** The
	 * test runs once per candidate ball on every turn, while finding the parts is a `CollectionService` tag
	 * walk — so asking for the parts once and testing each ball against them keeps that walk at one per turn,
	 * where a point-at-a-time predicate would re-walk the tags for every ball on the floor. An empty list means
	 * *this rig may fetch nothing*, which is a real state — a round rig with no side — rather than a fault.
	 */
	readonly parts: (model: Model) => Array<BasePart>;
}

/**
 * **The one seek, parameterised.** Both variants in the game are one call to this: `createRoundSeekBehavior`
 * at the end of this file, and `createAlwaysSeekBehavior` in `AlwaysSeekingBehavior.ts`, differing in a tag
 * and a region. Everything else is shared — the candidate list, the region test, the nearest arithmetic, the
 * claim, the stall budget, the give-up record and the edge log — so the two cannot drift apart in any of the
 * ways that matter. That is the whole reason the split is a parameter rather than a second copy of this file.
 */
export function createSeekBehavior(
	pickups: BallPickupService,
	balls: BallService,
	tag: string,
	region: SeekRegion,
): NpcBehavior {
	/** One row per rig. See `onDied` for the row that goes with the rig it belonged to. */
	const walking = new Map<Model, Seek>();

	/** The rig's own row, made on first use. */
	const stateOf = (model: Model): Seek => {
		let seek = walking.get(model);
		if (seek === undefined) {
			seek = { best: math.huge, stalled: 0, givenUp: new Map(), outside: new Set() };
			walking.set(model, seek);
		}

		return seek;
	};

	/**
	 * The closest loose ball this rig may walk to, or `undefined`.
	 *
	 * **The nearest-ball arithmetic is written twice in this project, and this is the second.**
	 * `BallPickupService.nearestLooseBall` cannot serve here, because it answers "what is closest"
	 * and the question asked here is "what is closest *among the balls this rig has not already
	 * failed to reach*" — a filter that belongs to the walker and not to the floor. Given the list,
	 * the difference is four lines; handed to the service it would be a skip list or a callback on
	 * a service that has no idea what a give-up is.
	 *
	 * **And now a second filter, for the other reason a ball is not this rig's to walk to: somebody else
	 * has already set off for it.** That is `npc/ballClaims.ts`, and it is *read-only* here — the filter
	 * asks who holds a ball and moves past it, because taking the claim is a decision about the ball this
	 * rig has actually chosen, and a search that claimed as it went would leave a rig holding reservations
	 * on every ball it looked at before settling. So the order is: choose among the free ones here, claim
	 * the winner in `tick`. **It cannot claim the ball of a rig that is already walking to it**, which is
	 * the whole point: eight rigs asking "what is nearest to me" independently is what produced three of
	 * them walking the same line to the same ball.
	 *
	 * **And the region, which is the filter that decides whether a ball is this rig's at all.** The variant's
	 * `region` names the parts its rigs may fetch from — its own half for a round rig, the practice zone for a
	 * practice rig — and a ball **outside** them is not a candidate: not walked to, not stalled at, never
	 * reached for. **That is the opposite of what this function used to do**: the *other* side's box was
	 * excluded and every remaining ball in `Workspace` stayed fair game, which is how a rig came to walk into
	 * the lobby after a ball. See `SeekRegion`, and `shared/constants.ts` at the two tags for the same
	 * correction written where the tags are declared.
	 */
	const nearest = (rig: Model, loose: BasePart[], from: Vector3, seek: Seek): BasePart | undefined => {
		let best: BasePart | undefined;
		let bestDistance = math.huge;

		// **The region this rig may fetch from, read once per choice rather than once per ball.** Its own
		// half for a round rig; the practice zone for a practice rig; and for a rig with no side, nothing at
		// all — which is a rig that fetches *nothing* rather than one that fetches everything, and is why the
		// practice rigs in the place file wear a tag of their own. See `sideZones.fetchRegionFor` and
		// `AlwaysSeekingBehavior`.
		const parts = region.parts(rig);

		for (const ball of loose) {
			if (seek.givenUp.has(ball)) continue;

			// Somebody else is on their way to it. Read rather than taken: see the doc above.
			const holder = claimedBy(ball);
			if (holder !== undefined && holder !== rig) continue;

			const distance = ball.Position.sub(from).Magnitude;

			// **A ball outside the region is not this rig's to fetch, and the line that says so is said once
			// per ball.** Skipped rather than given up on: `givenUp` is a record about *this* ball at *this*
			// position, and a ball later thrown inside the region is a fresh question, while a ball outside it
			// is out of reach by the place's own design — asking again next turn costs one comparison. **The
			// print is the diagnostic the previous version of this file lacked**: a region that does not cover
			// the floor its rigs walk on looks exactly like a rig with nothing to do, and this is the line that
			// tells those two apart from a log alone.
			if (!insideZone(parts, ball.Position)) {
				if (!seek.outside.has(ball)) {
					seek.outside.add(ball);

					print(
						`[Rig] ${rig.Name}: skipped a ball outside ${region.label} — ` +
							`${string.format("%.0f", distance)} studs away`,
					);
				}

				continue;
			}

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

		// **And the skip line's memory, on the one condition that matters for it: the ball is gone.** A
		// destroyed ball has to leave this set for the reason every map keyed on an instance has to — the
		// reference is what keeps a destroyed body alive — while a ball still in the world is still the ball
		// whose skip was already reported, and stays in the set wherever it is thrown next. See `Seek.outside`
		// for why movement is deliberately not a condition here, unlike the give-up record above.
		for (const ball of seek.outside) {
			if (ball.Parent === undefined) seek.outside.delete(ball);
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
	const stand = (model: Model, humanoid: Humanoid, root: BasePart, seek: Seek): void => {
		if (seek.ball !== undefined) humanoid.MoveTo(root.Position);

		// **Every way a walk can end, and the reservation ends with it.** This is where the three
		// non-death routes converge — the rig has a ball in hand, the ball stopped being loose, and the rig
		// gave up on it — so one release here is what makes "the claim lives exactly as long as the walk"
		// true without three copies of it. The route it deliberately does not cover is *arrival*: a rig
		// standing inside `PICKUP_RADIUS` of its ball keeps the claim, because the ball is not free — this
		// rig is about to take it, and it takes it on its next turn.
		release(model);

		seek.ball = undefined;
		seek.aimedAt = undefined;
		seek.best = math.huge;
		seek.stalled = 0;
	};

	return {
		// **The variant's tag, and the only thing here besides the region that is not shared.** Both seek
		// behaviours are this object; what tells them apart is this string and the region the factory was
		// given. See `createRoundSeekBehavior` at the end of this file, and `createAlwaysSeekBehavior` in
		// `AlwaysSeekingBehavior.ts`.
		tag,

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
				stand(model, humanoid, root, seek);
				return;
			}

			// What is on the floor, asked once per turn and used for both questions below: is the
			// ball I set off for still there, and if not, which ball is next.
			const loose = pickups.looseBalls();

			// The ball it was walking to is not loose any more — taken out of the world, armed into
			// a throw, in somebody's hand, or dropped and still settling. The walk ends rather than
			// being re-aimed at something that is gone: which ball is right *now* is the question
			// below, and it is asked once.
			if (seek.ball !== undefined && !loose.includes(seek.ball)) stand(model, humanoid, root, seek);

			// Nothing to walk to, and the reasons are ordinary rather than exceptional: an empty floor;
			// every ball loose enough to be seen but not yet settled; nothing left this rig has not already
			// given up on; **every ball outside the region this rig may fetch from** — the enemy's half, the
			// practice court, the lobby, for a round rig; and — the other new one — every remaining ball
			// already claimed by another rig. **The last two are not the same wait**, and the difference is
			// worth the sentence: a claimed ball frees itself the moment its owner takes it or gives up, so the
			// rig's next turn has something to pick, while a ball outside the region may never be this rig's at
			// all. Both end in the same place — the rig standing — because issuing no `MoveTo` is what standing
			// is: a rig that has nothing to fetch does not join a scrum to watch somebody else fetch it, and it
			// does not need to be told to stop, because `stand` above has already stopped any walk it was
			// making. It is a wait, not a fault.
			let ball = seek.ball;
			if (ball === undefined) {
				prune(seek);

				// The row rather than the give-up map, because selection now skips on two records: the balls
				// this rig gave up on, and the balls it has already reported as outside its region.
				ball = nearest(model, loose, root.Position, seek);
				if (ball === undefined) return;

				// A fresh walk, with no history: the distance is re-learned from this turn's, so a
				// rig that picks a ball up from further away than it gave the last one up gets the
				// whole patience again rather than whatever was left of it.
				seek.ball = ball;
				seek.aimedAt = undefined;
				seek.best = math.huge;
				seek.stalled = 0;
			}

			// **The reservation: taken here, and renewed on every turn the rig is still walking to it.**
			// Claiming and renewing are one call because they are one statement about one fact — *this ball
			// is mine to fetch* — and a caller that had to know which of the two it was making would be a
			// caller with a state machine bolted to the side of it. What the renewal buys is the meaning of
			// the claim's timeout: a claim is kept alive by a rig that keeps asking, so it lapses exactly
			// when the rig stops asking — held still by a freeze, parked out of the world (the loop is
			// skipped there too), or no longer wearing the tag at all — and never in the middle of a walk
			// that is still being made. See `npc/ballClaims.ts`.
			if (!claim(model, ball)) {
				// **The one way this refuses, and it is a race that resolved against this rig.** It can only
				// happen when this rig was walking to a ball and stopped asking about it for longer than
				// `CLAIM_SECONDS` — one of the three cases just named — and another rig claimed the ball in
				// the meantime; a fresh choice cannot reach this line, because `nearest` only offers balls
				// nobody else holds. Standing is the right answer, for the same reason it is right on
				// arrival: the ball is not this rig's to fetch, and next turn's selection will choose from
				// whatever is free by then.
				stand(model, humanoid, root, seek);
				return;
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

				// **The give-up route, and it frees the ball for somebody else on the way out.** `stand`
				// releases the claim, because every way a walk can end lets the ball go — see the note inside
				// `stand` itself — and this is the route where that matters most: a ball this rig cannot reach
				// is a ball the next rig should be allowed to try, and without the release it would sit behind
				// a claim held by a rig standing still and thinking about it.
				stand(model, humanoid, root, seek);

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
		 *
		 * **And the claim goes with the row, because the rig that comes back is a different model.**
		 * `RespawnBehavior` does not revive a corpse: it destroys it and clones a *new* model from a template
		 * taken while the rig was alive, so every map in this file — and `npc/ballClaims.ts` — is keyed by a
		 * model that is about to stop existing. A claim held by the corpse would be a reservation by a body
		 * that is gone, and it *would* eventually clear itself, because `claimedBy` judges an entry partly by
		 * its holder's `Parent` — but only **when something next asked about that ball**, and until then every
		 * other rig would have read it as taken. That is the whole difference between "free the instant the
		 * rig dies" and "free on the next unlucky lookup", and it is the class of bug the previous task's
		 * missing `Team` was in.
		 */
		onDied(model) {
			walking.delete(model);
			release(model);
		},
	};
}

/**
 * **The round variant: a rig fetches only inside its own half of the court.**
 *
 * One call to the factory above, and the two facts that make it this variant are the tag the round already
 * uses and the region the place file paints. Nothing about the behaviour itself is repeated here, which is the
 * whole point of the arrangement: this file is the seek, and this function is the round's tap on it.
 *
 * **Its region is `fetchRegionFor`, which answers per rig** — the `SideKeepOutA` box for a rig on A and
 * `SideKeepOutB` for one on B, with the tag names meaning the opposite of what they say, since the reading was
 * inverted on 2026-10-13. See `shared/constants.ts` at the two tags.
 *
 * **A rig with no side gets an empty region, and therefore stands.** That is not a case to be handled here but
 * the rule falling out of the code: `insideZone` answers `false` for an empty list, so no ball is ever a
 * candidate, `nearest` returns `undefined` and `tick` issues no `MoveTo` — the rig keeps whatever walk it was
 * making until that ends, and then stays. It is the same "a rig with no side is inert" the rest of the project
 * keeps, and it is why a rig that is *supposed* to fetch a ball needs either a side or the practice tag.
 */
export function createRoundSeekBehavior(pickups: BallPickupService, balls: BallService): NpcBehavior {
	return createSeekBehavior(pickups, balls, BEHAVIOR_SEEKING, {
		label: "its half",
		parts: fetchRegionFor,
	});
}
