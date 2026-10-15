import { BALL_CONFIG } from "shared/config/ball.config";
import { CHARACTER_CONFIG } from "shared/config/character.config";
import { NPC_CONFIG } from "shared/config/npc.config";
import { CHARGING_ATTRIBUTE, DODGE_DIRECTION_ATTRIBUTE } from "shared/constants";
import { pendingAbilityOn } from "shared/ability";
import { resolveDodgeable } from "shared/dodge";
import { claim, claimedBy, release } from "../ballClaims";
import { detectEnemy } from "../detect";
import { fetchRegionFor, insideZone } from "../sideZones";
import { BEHAVIOR_SEEKING, NpcBehavior } from "../Behavior";
import type { BallPickupService } from "../../services/ball/BallPickupService";
import type { BallService } from "../../services/ball/BallService";
import type { WalkSpeedService } from "../../services/character/WalkSpeedService";
import type { MysteryBoxService } from "../../services/mystery/MysteryBoxService";

/**
 * How often the behavior looks again, in seconds: the retarget interval.
 *
 * **This is the only thing that paces `MoveTo`, and it used to be the *and no other* that made the call rare.**
 * The paragraph that sat here said a walk is issued when there is a new ball to walk to *or* when the ball
 * already being walked to has moved far enough to be worth re-aiming at, and **that is no longer how the walk is
 * issued**: a curving walk aims at a different point on every turn, so every turn issues. What is left of the old
 * argument is the part that was always true — `MoveTo` re-issued at the same point is the same walk asked for
 * again, and asked for sixty times a second it would be that as well — so this is the interval that decides how
 * many times a second the same-walk-asked-again happens, which is once per half second per rig.
 *
 * **Half a second is also what the curve is sampled at, and that is a real limit rather than a detail.** A rig's
 * arc is read out as one point per retarget, so at a period of 1.8 seconds the shape is drawn from three or four
 * points; the humanoid's own steering smooths the corners between them, which is why that reads as an arc rather
 * than as a zig-zag. Shortening the period below this is a change to how the arc is *sampled* and not only to how
 * it looks, and it is the first thing to reach for if a rig's walk reads as angular.
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
 * **It has one reader since the curve arrived, where it had two, and the one that went is worth naming:**
 * *has the ball moved enough to be worth re-aiming at?* was half of this number's job — see
 * {@link SEEK_RETARGET_SECONDS} — and the walk now re-aims on every turn, at a point that is not the ball's. What
 * is left is the same question asked about the **give-up record**: a ball this rig gave up on that has since been
 * thrown, kicked or rolled somewhere else is a different question, and this is the distance at which it stops
 * being the ball this rig gave up on. See `prune`, which is where that reading lives.
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
 * The contribution a rig's sprint is added under, **deliberately the same word a player's sprint uses.**
 *
 * `WalkSpeedService` keeps a private key of its own with this spelling for a player's character, and this is the
 * same string for the same reason the service gives for the key being the identity rather than the caller: a body
 * has one sprint or none. **The two cannot collide**, because a key is scoped to a *model* and a player's
 * character is never a rig — so the same word on two bodies is two contributions, and the day something asks the
 * service "is this body sprinting" it gets one answer for both rather than a name it has to know per body kind.
 *
 * **What a rig's sprint adds is `CHARACTER_CONFIG.SPRINT_SPEED_BONUS` rather than a number of its own.** The
 * reason used to be the run clip: a bonus that did not carry the body's speed past
 * `CHARACTER_CONFIG.RUN_ANIMATION_SPEED` was a rig whose legs did not agree with its speed. **The clip no longer
 * reads a speed at all** — a body's moving clip is chosen from the request, and the *sprint* is chosen from this
 * contribution being present, which `WalkSpeedService.isSprinting` answers for the publisher — so there is
 * nothing left here for a number to disagree with. The 15 stays because a sprint is the same sprint whoever
 * takes it, and because a rig sprinting should move at a sprinting speed. See `animationFor`, which is the one
 * rule both bodies are dressed by.
 *
 * **What a rig does *not* have is the pool.** `STAMINA_MAX_SECONDS` belongs to a `Player`, is drained by
 * `WalkSpeedService.step` on the keys that player holds, and exists to make *choosing* to sprint cost something.
 * A rig has no key, no HUD, and a walk that ends in a second or two — so a rig's sprint is the length of the walk
 * and nothing else, which is what this file's gate re-read on every turn already produces.
 */
const SPRINT_KEY = "Sprint";

/**
 * How long a rig's sprint survives without a turn to renew it, in seconds.
 *
 * **A watchdog, because a behaviour has no `onStopped` and no other way to learn that it has stopped being run.**
 * A sprint is a contribution on the body, and the body outlives the tag: a rig whose `Behavior_Seeking` comes off
 * mid-walk — which `LobbyRigService.setGameplayBehaviors` does on every round boundary, by `RemoveTag` — never
 * ticks again, so nothing in this file can take the contribution back off. What is left behind is a rig walking
 * at `base + 15` for the rest of the session, which from a seat is a rig in the lobby that moves wrong with
 * nothing in the output to say why.
 *
 * **The fix is the one `ThrowBehavior`'s windup already uses, for the same class of bug**: a token-guarded timer
 * that can only *undo*. `startSprint` re-arms it on every turn of the walk and the timer does nothing in the
 * ordinary case, because the turn that clears the sprint has already changed the token by the time it looks.
 *
 * **Three retarget intervals, and the arithmetic is the point rather than the number.** One interval would be a
 * sprint dropped by a single slow frame; this tolerates the rig being skipped for a few turns — a freeze, a dash
 * that hides the root for a moment, a `MoveTo` the engine is still working out — while still ending the sprint
 * well inside `CLAIM_SECONDS`'s own budget for "a rig that has stopped saying anything". See `stand`, which is the
 * ordinary way the sprint ends and which needs none of this.
 */
const SPRINT_WATCHDOG_SECONDS = SEEK_RETARGET_SECONDS * 3;

/** Below this, the flat offset to a ball has no sideways direction to be — `detect.ts`'s own guard, for its reason. */
const CURVE_MIN_FLAT_STUDS = 0.001;

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

	/**
	 * How this walk curves, seeded when the walk begins — **and `undefined` is "no walk", which is the same fact
	 * {@link ball} carries.**
	 *
	 * **A field where there used to be the ball's last-aimed position, and that is the reversal this whole
	 * behaviour's `MoveTo` cadence turned on.** The old walk re-issued `MoveTo` only when the ball had moved
	 * `SEEK_BALL_MOVED_STUDS`, on the argument that asking for one point twice is the same walk asked for twice.
	 * A curving walk aims at a *different* point every turn by construction, so that gate would freeze the curve
	 * at whatever offset the first turn happened to produce — see the walk at the end of `tick` for the argument
	 * in full. `aimedAt` had no other reader.
	 */
	curve?: Curve;

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

	/**
	 * Whether this rig's sprint contribution is on the body right now.
	 *
	 * **The latch that makes a per-turn decision safe to ask per turn.** The gate is re-read every turn of a walk,
	 * so without this the walking case would call `addModifier` sixty times a second — and `WalkSpeedService`
	 * prints a `[Walk]` line on *every* recalculation, so the fault would not be a wasted call but a wall of log.
	 * Edge-guarding here is the same shape `WalkSpeedService.applySprint` uses for a player, for the same reason.
	 */
	sprinting: boolean;

	/**
	 * The token of the live sprint watchdog, or `undefined` when no sprint is being watched — see
	 * {@link SPRINT_WATCHDOG_SECONDS}. Only equality is ever asked of it.
	 */
	sprintToken?: number;

	/** `os.clock` at this rig's last hop, for the cooldown. `0` is "never", which is what every rig starts at. */
	jumpedAt: number;

	/**
	 * **Whether this walk is a cautious one** — the 15 % roll, drawn when the walk begins and spent the first time
	 * an armed enemy is near enough to be worth bluffing.
	 *
	 * Drawn per *walk* rather than rolled per turn; see `NPC_CONFIG.PANIC_SHUFFLE_CHANCE` for why that is the
	 * whole of the design and for what a per-turn roll would actually produce.
	 */
	panic: boolean;

	/**
	 * The point this rig is sidestepping to, or `undefined` when it is walking at the ball like any other turn.
	 *
	 * **A point rather than a direction, because a sidestep is a place a person steps to and stands for a beat.**
	 * A direction issued every turn would be the rig walking sideways for as long as the condition held, which has
	 * no end and no shape; a stored point means the step is made once, the rig arrives, and the walk to the ball
	 * resumes — see `NPC_CONFIG.PANIC_SHUFFLE_SECONDS`, where the difference between the two is the reason the
	 * window is longer than the step.
	 */
	sidestep?: Vector3;

	/** `os.clock` at which {@link sidestep} is over. Only meaningful while there is one. */
	shuffleUntil: number;

	/**
	 * The point this rig is still walking to after its hand filled, or `undefined` when it has stopped.
	 *
	 * **The walk does not end when the ball arrives, and this is where it goes instead.** Drawn on the turn the
	 * hand fills, from the direction the rig was already travelling — or, on a coin, *backwards* away from the
	 * enemy it is about to throw at. See `pickupWalk` for both and for why a backwards walk reads at all.
	 */
	pickupWalk?: Vector3;

	/** `os.clock` at which {@link pickupWalk} is over. Only meaningful while there is one. */
	pickupWalkUntil: number;
}

/**
 * One walk's arc: **the shape is drawn when the walk begins and does not change while it lasts.**
 *
 * **Per walk rather than per rig, and that is the difference between a person and a tell.** A rig with a fixed
 * curve is a rig that always walks the same way, which is a shape a player learns; two rigs with one shared curve
 * are two bodies tracing the same path, which is worse. Drawn here, two walks made at the same instant by the same
 * rule are different paths — and the walk is the unit because that is what a detour belongs to: this approach to
 * *this* ball, not a personality the body carries between balls.
 */
interface Curve {
	/** `os.clock` when the walk started, so the sine's clock begins with the walk rather than with the round. */
	beganAt: number;

	/** One full left-right cycle, in seconds, drawn once from the config range. */
	period: number;

	/** How far off the line this walk may stray, as an angle from it. See the config constant for why an angle. */
	amplitudeDegrees: number;

	/** Where in the cycle the walk began, in radians. Drawn once per walk, so no two walks start together. */
	phase: number;
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
 * **And since 2026-10-13 the walk is deliberately not a straight line, which is the one place this file tells the
 * rig to do something the shortest path would not.** A straight line to the ball is the tell: **it is the shape of
 * a body walking to a *coordinate*, and a person walks an arc because they are watching where the ball is going** —
 * they aim where it will be, they drift off the line and back, and no two approaches have the same shape. So every
 * walk is given a small oscillation perpendicular to the line it would otherwise walk (`curveTarget`), drawn fresh
 * per walk from `NPC_CONFIG.SEEK_CURVE_*` so that two rigs setting off together are two paths rather than one path
 * twice. It is a few studs of drift at arena distances and less as the rig closes, which is the property that keeps
 * it from costing the rig its ball. **What this is not:** not pathfinding arriving by the back door — it routes
 * around nothing, and the paragraph above about the floor still holds — and not wandering, which is the failure
 * mode to look for if the amplitude is ever raised.
 *
 * **Three more things hang off the same walk, and all three are in `tick` for the reason the curve is.** A rig
 * **runs** when the ball is further away than `SEEK_SPRINT_DISTANCE_STUDS` — through `WalkSpeedService`, on the
 * same named contribution a player's sprint is, because two bodies wearing one run clip have to be moving at
 * speeds that clip was drawn for — and it **hops** when it is walking past somebody within
 * `SEEK_JUMP_ENEMY_RADIUS_STUDS` and its cooldown allows it. See `startSprint` and `maybeJump`. **And it does not
 * stop when its hand fills**: the walk carries on past the pickup — onwards, or *backwards* away from the body it
 * is about to throw at — with the throw's own aim constraint holding its face on that body the while. See
 * `pickupWalk`, which is the one movement in this file that a person makes and a rig did not. All of it was added
 * together because it is one question asked four ways, which is what a rig's economy of motion looks like from a
 * seat.
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
 *
 * **The speed service is a parameter for the same reason the tag and the region are**: a rig's sprint is a fact
 * about the *walk*, and both variants walk. It is handed in rather than reached for because that is how
 * `NpcService` gives every behaviour everything it needs — see its constructor, which builds this list — and
 * because a behaviour that resolved its own services would be a behaviour whose dependencies are invisible from
 * the place the whole set is assembled.
 *
 * **And the mystery service is a parameter since a box became a fetch target (2026-10-14).** The walk is no
 * longer only to a ball: a live box inside the region outranks every ball, asked of `MysteryBoxService` the
 * same way the floor is asked of `BallPickupService` — the seek gets the floor, and the boxes are part of what
 * is on it. It is handed in rather than reached for for the same reason as the speed service, and it is the one
 * dependency this file holds that has nothing to do with balls — see `nearestBox`, where it is used.
 */
export function createSeekBehavior(
	speeds: WalkSpeedService,
	pickups: BallPickupService,
	balls: BallService,
	mystery: MysteryBoxService,
	tag: string,
	region: SeekRegion,
): NpcBehavior {
	/** One row per rig. See `onDied` for the row that goes with the rig it belonged to. */
	const walking = new Map<Model, Seek>();

	/** The token the next sprint watchdog takes. Only equality is ever asked of it, so one counter is enough. */
	let nextSprintToken = 0;

	/** The rig's own row, made on first use. */
	const stateOf = (model: Model): Seek => {
		let seek = walking.get(model);
		if (seek === undefined) {
			seek = {
				best: math.huge,
				stalled: 0,
				givenUp: new Map(),
				outside: new Set(),
				sprinting: false,
				jumpedAt: 0,
				panic: false,
				shuffleUntil: 0,
				pickupWalkUntil: 0,
			};
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
	 * The nearest live box this rig may walk to, or `undefined`.
	 *
	 * **A box is a second kind of fetch target, and it outranks every ball** — see the `tick`, which asks
	 * this before the ball selection and walks to the box instead of to whatever ball the rig was chasing.
	 * The box's own gates are the same two a ball's are, asked in the same place: it must be inside the
	 * rig's region (the same `MoveTo`-cannot-go-round reasoning as a ball), and the rig must have an empty
	 * `PENDING_ABILITY_ATTRIBUTE` — one slot, and a second box has nothing to do. **There is deliberately no
	 * claim on a box**: it is collected by `Touched`, and whoever reaches it first takes it, so a reservation
	 * would be a lock on a thing that despawns the moment it is used.
	 */
	const nearestBox = (rig: Model, from: Vector3): BasePart | undefined => {
		// **The slot gate first, because it is the cheap one and it is the whole of "may this rig take a
		// box".** A rig holding a prize has no use for a second, so the walk is not even offered.
		if (pendingAbilityOn(rig) !== undefined) return undefined;

		const boxes = mystery.liveBoxes();
		if (boxes.size() === 0) return undefined;

		// The region this rig may fetch from, read once per choice — the same read `nearest` makes for balls,
		// and the same reason: the parts are painted and a dev moves them between runs.
		const parts = region.parts(rig);

		let best: BasePart | undefined;
		let bestDistance = math.huge;

		for (const box of boxes) {
			if (!insideZone(parts, box.Position)) continue;

			const distance = box.Position.sub(from).Magnitude;
			if (distance > bestDistance) continue;

			best = box;
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
	 * Starts this rig's sprint, **and arms the watchdog that ends it if this behaviour stops being run.**
	 *
	 * **The contribution is the mechanism rather than a `Humanoid.WalkSpeed` write, and that is a requirement
	 * rather than a preference.** Two other services put numbers on a body this way — `FreezeService` holds a body
	 * at its `Frozen` speed and `RoundService` holds an arena's at `ArenaFreeze` — and a rig can be the body both
	 * of them mean. A direct write would overwrite whichever of those is on the body, so a frozen rig would sprint
	 * out of its hold; a named contribution sums with them instead, which is exactly what `WalkSpeedService`
	 * exists for. What it costs is named honestly: **a rig now has a speed sum**, where nothing but the pad walk's
	 * direct write ever touched one, and the two can disagree — see `prepare`, which is where the base is stated so
	 * that the sum has a number a rig's own walk agrees with.
	 *
	 * **The watchdog is re-armed on every turn of the sprint rather than only on the edge**, and the cost of that
	 * is stated rather than hidden: one `task.delay` per turn per sprinting rig, two a second, almost every one of
	 * which returns on its first line. What it buys is that the timer cannot fire during a walk at all — a turn
	 * that renews it has changed the token before the timer looks — so the only thing it ever catches is a rig that
	 * nothing is turning any more. See {@link SPRINT_WATCHDOG_SECONDS}.
	 */
	const startSprint = (model: Model, seek: Seek, distance: number): void => {
		nextSprintToken += 1;
		const token = nextSprintToken;
		seek.sprintToken = token;

		task.delay(SPRINT_WATCHDOG_SECONDS, () => {
			if (seek.sprintToken !== token) return;

			endSprint(model, seek);

			print(`[Rig] ${model.Name}: sprint ended — the walk it was for stopped being ticked`);
		});

		// The edge: everything below happens once per walk, everything above happens once per turn.
		if (seek.sprinting) return;

		seek.sprinting = true;
		speeds.addModifier(model, SPRINT_KEY, CHARACTER_CONFIG.SPRINT_SPEED_BONUS);

		// **The one line a sprint gets, on the edge and not per turn.** What ends it is already in the output —
		// `WalkSpeedService` prints every recalculation with the contributions it was summed from — so a second
		// line here would be that line said again in different words.
		print(`[Rig] ${model.Name}: sprinting to a ball — ${string.format("%.0f", distance)} studs`);
	};

	/**
	 * Ends this rig's sprint, **on every route that ends the walk.**
	 *
	 * Idempotent through the latch, which is what lets it be called unconditionally by `stand` on every turn a rig
	 * is not walking, and by the watchdog of a sprint that may already have been cleared. Removing a contribution
	 * that was never added is a no-op inside the service, so the two together mean no caller has to work out
	 * whether there was anything to take off.
	 */
	const endSprint = (model: Model, seek: Seek): void => {
		// **The token goes first, so a watchdog in flight is disarmed rather than raced.** Both roads end in this
		// function and the latch makes that harmless, but a watchdog that fired a frame after the walk ended would
		// print "the walk stopped being ticked" about a walk that ended in the ordinary way.
		seek.sprintToken = undefined;

		if (!seek.sprinting) return;

		seek.sprinting = false;
		speeds.removeModifier(model, SPRINT_KEY);
	};

	/**
	 * Draws everything about this walk that is decided once, at the moment the walk begins — **which is two things
	 * now, and both are draws: the arc, and whether this approach is a cautious one.**
	 *
	 * **One function rather than two, because a walk beginning is one event.** The arc's period and phase and the
	 * panic roll are all "the shape of this approach", and a second entry point would be a second place the turn a
	 * walk starts is handled — which is the sort of duplication this file's own candidate list avoids for the same
	 * reason. See `NPC_CONFIG.PANIC_SHUFFLE_CHANCE` for why the roll is per walk rather than per turn.
	 *
	 * **The line is the whole report of the curve, and it is here rather than in the walk because this is the
	 * only turn on which the shape is new.** Two walks by one rig are two different shapes, so "amplitude 4.0°,
	 * period 1.8 s" is a statement about *this* trip; printed per turn it would be the same sentence thirty times.
	 * The studs in brackets are there because the angle is what the code uses and the studs are what a person can
	 * picture — and because the `tan` above is the load-bearing part of the rule, since it is what makes the
	 * detour shrink as the rig arrives.
	 *
	 * **The roll prints nothing, and that is deliberate.** A line for "this walk will not shuffle" would be a line
	 * for four fifths of every walk every rig ever makes, about something that did not happen; the shuffle's own
	 * line is where the event is reported, and it is printed by `maybeShuffle` on the turn it starts.
	 */
	const seedWalk = (model: Model, seek: Seek, distance: number, now: number): void => {
		const span = NPC_CONFIG.SEEK_CURVE_PERIOD_MAX_SECONDS - NPC_CONFIG.SEEK_CURVE_PERIOD_MIN_SECONDS;
		const period = NPC_CONFIG.SEEK_CURVE_PERIOD_MIN_SECONDS + math.random() * span;

		seek.curve = {
			beganAt: now,
			period,
			amplitudeDegrees: NPC_CONFIG.SEEK_CURVE_AMPLITUDE_DEGREES,
			phase: math.random() * math.pi * 2,
		};

		seek.panic = math.random() < NPC_CONFIG.PANIC_SHUFFLE_CHANCE;

		const lateral = math.tan(math.rad(NPC_CONFIG.SEEK_CURVE_AMPLITUDE_DEGREES)) * distance;

		print(
			`[Rig] ${model.Name}: walk curving — amplitude ` +
				`${string.format("%.1f", NPC_CONFIG.SEEK_CURVE_AMPLITUDE_DEGREES)}° ` +
				`(${string.format("%.1f", lateral)} studs here), period ${string.format("%.1f", period)} s`,
		);
	};

	/**
	 * Where this turn's walk is aimed: **the ball, offset to one side by however far into the arc the walk is.**
	 *
	 * **The offset is taken from the line to the ball rather than from a fixed axis**, so "sideways" means sideways
	 * of *this* approach and the detour follows a rig that is being pushed off course rather than pointing at a
	 * world direction that stopped being across the walk three turns ago.
	 *
	 * **The amplitude is an angle, so the detour shrinks as the rig arrives** — see
	 * `NPC_CONFIG.SEEK_CURVE_AMPLITUDE_DEGREES`, where that is the argument for the whole shape. It is also what
	 * keeps this honest against the two things the walk has to be able to do anyway: **the arrival check reads the
	 * distance to the *ball*** (it is tested above, before this is ever called) and the stall budget counts turns
	 * spent getting no closer to the *ball*. A fixed lateral offset would leave a rig curving three studs wide
	 * within eight of its target and could cost it the ball on patience alone; at four degrees it is a third of a
	 * stud by then.
	 *
	 * **No offset at all is a real answer and it is the first branch**: a `Seek` with no curve is a walk that was
	 * never seeded — which cannot happen through `tick`, since `seedWalk` runs on the same turn the ball is
	 * chosen, and exists so that this function has one answer rather than a caller that has to know.
	 */
	const curveTarget = (ball: BasePart, root: BasePart, seek: Seek, now: number): Vector3 => {
		const curve = seek.curve;
		if (curve === undefined) return ball.Position;

		const toBall = ball.Position.sub(root.Position);
		const flat = new Vector3(toBall.X, 0, toBall.Z);

		// A ball directly overhead has no sideways direction to be away from. The arithmetically dishonest
		// alternative is to normalize a zero vector, which is `NaN` — one frame of that and the humanoid is
		// walking at a body that is not there.
		if (flat.Magnitude < CURVE_MIN_FLAT_STUDS) return ball.Position;

		const sideways = new Vector3(-flat.Z, 0, flat.X).Unit;
		const swing = math.sin(((now - curve.beganAt) / curve.period) * math.pi * 2 + curve.phase);
		const lateral = math.tan(math.rad(curve.amplitudeDegrees)) * flat.Magnitude * swing;

		return ball.Position.add(sideways.mul(lateral));
	};

	/**
	 * **A bluff: the sidestep a person makes when somebody is armed and looking at them and they both know it.**
	 *
	 * **The shuffle is a bluff, not a dodge.** It does not use `DodgeService`, it grants no invulnerability, and the
	 * ball that was coming still hits: nothing here touches the rig's hurtbox, the round's damage, or the ball's
	 * flight. What it does is what a person does when somebody is aiming at them and they know it — the body stops
	 * walking a straight line towards where it is going, steps off it, and then carries on. The rig is exactly as
	 * hittable while shuffling as it was before, and it is the same body in the same place a moment later.
	 *
	 * **The gates, in the order they are cheap to ask.** The walk has already been chosen and its roll already
	 * drawn (`seedWalk`) — so the first test is that this walk is one of the 15 % and that it has not spent its
	 * bluff yet, which costs nothing and throws away four walks in five. Then a dash, which has the body: a walk
	 * issued under a dash is a second mover fighting the one `DodgeBehavior` already has, and the attribute it
	 * publishes for the length of a dash is exactly that fact — `WalkSpeedService` reads the same one as its gate
	 * for its own reason. Only then the two world questions, a body near enough and that body *armed*.
	 *
	 * **"Armed" is the whole of the threat test and it is deliberately the enemy's hand, not a ball in the air.**
	 * The dodge answers "is a ball coming at me", which is a trajectory solve about a throw already made; this
	 * answers "is somebody about to", which is where the ball is *now* — see `detectThreat` for that first question,
	 * which is a different question and belongs to a different behaviour. A rig shuffling because a ball is already
	 * in flight would be a dodge wearing a walk, and the two firing at once is the shape this gate exists to avoid.
	 *
	 * **One step, in a direction drawn at the moment it starts**, so the rig leaves the line rather than crossing it
	 * — see `NPC_CONFIG.PANIC_SIDESTEP_STUDS`. The point is stored rather than re-derived per turn, because a
	 * sidestep that follows the rig as it moves is a direction, and a direction has no end: this is a place the body
	 * goes to and stands for a beat, and then the walk to the ball resumes on its own because `sidestep` is cleared.
	 */
	const maybeShuffle = (model: Model, root: BasePart, ball: BasePart, seek: Seek, now: number): void => {
		if (!seek.panic) return;

		// **Once per walk, spent on the first turn the whole trigger is true.** Cleared here rather than at the end
		// of the shuffle, because the roll is about *deciding*, and a rig that decided and then found no armed
		// enemy has had its cautious approach and nothing to be cautious about.
		seek.panic = false;

		// A dash has the body. See the doc above; this is the same attribute `WalkSpeedService` reads.
		if (model.GetAttribute(DODGE_DIRECTION_ATTRIBUTE) !== undefined) return;

		const enemy = detectEnemy(model);
		if (enemy === undefined) return;
		if (enemy.distance > NPC_CONFIG.PANIC_ENEMY_RADIUS_STUDS) return;

		if (balls.getHeldBall(enemy.model) === undefined) return;

		const flat = new Vector3(ball.Position.X - root.Position.X, 0, ball.Position.Z - root.Position.Z);
		if (flat.Magnitude < CURVE_MIN_FLAT_STUDS) return;

		// **The line to the ball turned a quarter turn, and a coin for which side.** A rig that always chose the
		// same side would have a signature — every cautious approach a step to its left — which is the same class of
		// tell as the straight line this file has just spent a feature removing.
		const sideways = new Vector3(-flat.Z, 0, flat.X).Unit;
		const side = math.random() < 0.5 ? -1 : 1;

		seek.sidestep = root.Position.add(sideways.mul(NPC_CONFIG.PANIC_SIDESTEP_STUDS * side));
		seek.shuffleUntil = now + NPC_CONFIG.PANIC_SHUFFLE_SECONDS;

		print(
			`[Rig] ${model.Name}: shuffling — ${enemy.model.Name} armed at ` +
				`${string.format("%.0f", enemy.distance)} studs`,
		);
	};

	/**
	 * **A hop, of the sort a person makes while walking past somebody they have nothing to say to.**
	 *
	 * Four gates, and each one is a different reason not to jump — see the comments at each. What is worth saying
	 * here is what this is *not*: it is not a dodge, it does not move the rig anywhere it was not already going,
	 * and it is not aimed at anything. It is one `Humanoid.Jump` on a body that is already walking, and the whole
	 * of what it buys is that a rig crossing a floor is not the only body in the game that never leaves it.
	 *
	 * **The animation is not this function's business and nothing tells it.** `NpcService.publishAnimation`
	 * publishes `AnimGrounded` from `humanoid.FloorMaterial`, this makes the floor `Air`, and `animationFor` reads
	 * `!grounded` as the `jump` clip — so the clip follows from the engine's own physics, on the same rule a
	 * player's jump is dressed by, with no second path and nothing to keep in step. See
	 * `RigAnimationController.conditionsOf`, which is the rig's half of that read.
	 *
	 * **`Humanoid.Jump` rather than a state change**, because that is the property a player's own jump sets and
	 * the engine's controller honours — the same call, for the same reason this file uses the same `MoveTo` a
	 * player's controller does.
	 */
	const maybeJump = (model: Model, humanoid: Humanoid, seek: Seek, now: number): void => {
		// **Occasionally, whatever the floor is doing.** A cooldown rather than a chance; see
		// `NPC_CONFIG.SEEK_JUMP_COOLDOWN_SECONDS` for why a rig's own clock is the honest way to say that.
		if (now - seek.jumpedAt < NPC_CONFIG.SEEK_JUMP_COOLDOWN_SECONDS) return;

		// **Grounded, read exactly as the rig's published state reads it.** `NpcService.publishAnimation` publishes
		// `AnimGrounded` from this same comparison, so this gate and the clip cannot disagree: a jump this lets
		// through is a jump every client has already been told the rig is standing for.
		if (humanoid.FloorMaterial === Enum.Material.Air) return;

		// **A body the engine has handed to something else does not jump.** `DodgeService` puts a rig on
		// `PlatformStand` for the length of a dash, and a `Jump` under it is swallowed — so without this the rig
		// would spend its whole cooldown on a hop nobody ever saw.
		if (humanoid.PlatformStand) return;

		// **Let go of the throw first.** A hold is a body standing still on purpose for as long as a full charge
		// takes, and a hop would carry it off its own aim; the hold is also the one fact about a throw that is
		// *published*, so it is read here rather than asked of `ThrowBehavior` — which this file has no business
		// importing, and whose windup is the same state by construction.
		if (model.GetAttribute(CHARGING_ATTRIBUTE) !== undefined) return;

		const enemy = detectEnemy(model);
		if (enemy === undefined) return;

		// **The near one, and inside a round** — `detectEnemy` answers nothing outside one, which is its own rule
		// rather than a second gate here: a rig walking to a pad in the lobby has no enemies, so a lobby rig never
		// hops, and that is the same sentence as "the pad walk does not jump".
		if (enemy.distance > NPC_CONFIG.SEEK_JUMP_ENEMY_RADIUS_STUDS) return;

		seek.jumpedAt = now;
		humanoid.Jump = true;

		print(`[Rig] ${model.Name}: jump — ${enemy.model.Name} at ${string.format("%.0f", enemy.distance)} studs`);
	};

	/**
	 * Forgets the walk: **the reservation, the sprint, the arc and the progress counters, in one place.**
	 *
	 * **One function rather than the list repeated at each end of a walk, because there are now two ends that
	 * share it.** `stand` is the ordinary one — the rig stops where it is — and `pickupWalk` is the one where the
	 * ball arriving does *not* end the movement; both need the walk's state gone, and neither is a place to keep a
	 * second copy of the list. **The end that deliberately does not come through here is *arrival***, which is
	 * argued in `stand`: a rig inside `PICKUP_RADIUS` of its ball has not finished with it.
	 *
	 * `release` is the reservation and it goes with everything else, because "the claim lives exactly as long as
	 * the walk" is what the renewal at the top of `tick` is built on. See `stand` for the routes that converge.
	 */
	const endWalk = (model: Model, seek: Seek): void => {
		release(model);
		endSprint(model, seek);

		seek.ball = undefined;
		seek.curve = undefined;
		seek.best = math.huge;
		seek.stalled = 0;
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
	 *
	 * **Every way a walk can end converges here or in `endWalk`, and the three that are not death are the
	 * point of it** — the ball stopped being loose, the claim was lost, and the give-up budget ran out. What
	 * deliberately does not come through here is **arrival**: a rig standing inside `PICKUP_RADIUS` of its ball
	 * keeps its claim, because the ball is not free — this rig is about to take it, and it takes it on its next
	 * turn.
	 *
	 * **And the carry-through dies here too**, which is what makes this the single place a rig is *planted*: a
	 * rig at its rest point is a rig that is standing, and a `pickupWalk` left set would be a point the next
	 * turn's `MoveTo` would set it walking to again.
	 */
	const stand = (model: Model, humanoid: Humanoid, root: BasePart, seek: Seek): void => {
		// **Two things can be "a walk in progress" now, and either is enough to need stopping**: the ball this rig
		// set off for, and the carry-through it is making after taking it. The flag's meaning has not changed — it
		// is "there is somewhere this body is walking to" — it has two sources since `pickupWalk` arrived, and a
		// stop issued for one of them while the other was still set would leave a rig walking to a point nobody
		// meant.
		if (seek.ball !== undefined || seek.pickupWalk !== undefined) humanoid.MoveTo(root.Position);

		seek.pickupWalk = undefined;
		endWalk(model, seek);
	};

	/**
	 * **What the rig does instead of stopping when the ball arrives: it keeps walking.**
	 *
	 * **A rig used to stop on the turn the pickup took its ball, and nothing about throwing wanted that.** The
	 * stop was an accident of this file's first condition — "is a ball in hand" — because a rig with a full hand
	 * has nothing left to *fetch*, and `stand` is what a behaviour with nothing to do does. What it looks like
	 * from a seat is a body that arrives at a ball, stops dead on it, and then turns and throws, which is the one
	 * shape in a rig's whole cycle that a player's does not have: a person arrives *moving*, and the throw comes
	 * out of a body that is still going somewhere.
	 *
	 * **Which way it goes is drawn on the turn the hand fills, and it is the user's own addition.** Onward is the
	 * walk it was already making, carried past the point it was aimed at — the plain reading of "keep the last
	 * walk alive". On a coin it is the other one: **backwards, away from the body it is about to throw at**, which
	 * is the movement a person makes when they have the ball and the other body has the angle on them. What makes
	 * it read at all is already in the code and was not built for this: `ThrowBehavior`'s `AlignOrientation` holds
	 * the rig's *facing* on its target with `AutoRotate = false`, which is precisely what leaves the walk free to
	 * go somewhere else — the legs one way, the eyes the other.
	 *
	 * **The backwards draw needs a body to face, and that is what the range gate is for.** The throw only holds an
	 * aim inside `THROW_RANGE_STUDS`; outside it the rig is not facing anybody, and a backwards walk would be a
	 * body sliding the wrong way with its legs cycling forwards — a moonwalk, which is worse than a stop. So the
	 * coin is only *spent* when there is an enemy in range to face, which also means this number reads as "of the
	 * pickups taken under a watchful body, this many go backwards".
	 *
	 * **A hold ends the carry-through, and it usually ends it on the same turn.** The throw behaviour is earlier
	 * in `NpcService`'s registry, so a windup that begins on a turn is already published by the time this runs: the
	 * rig plants and throws from where it stands, with a charge solved on this very turn, which is why this is a
	 * movement that cannot make a throw land short. The one case where it can is a windup that begins on a turn
	 * this behaviour does not run on — the seek is half a second behind the throw's tenth — and that is the same
	 * price `ThrowBehavior` already pays and documents for a shoved or dashing rig: a charge solved a moment
	 * before the body finished moving.
	 */
	const pickupWalk = (model: Model, humanoid: Humanoid, root: BasePart, seek: Seek, now: number): void => {
		// **The draw, on the first turn the hand is full** — which is the last turn the direction the rig was
		// walking is still known, because `endWalk` below is what forgets it. `seek.ball` is the ball this rig set
		// off for and has just taken.
		if (seek.ball !== undefined && seek.pickupWalk === undefined) {
			// The way it was going: **at the ball, which is the point the walk was aimed at.** The magnitude is
			// small by now — the ball is in the hand, a few studs away at most — but the *direction* is the walk's,
			// because a walk at a ball ends pointing at it. The fallback is the one `aimOf` uses, for the same
			// reason: a body with a heading of zero length has nowhere to walk that is not a guess.
			const toBall = new Vector3(
				seek.ball.Position.X - root.Position.X,
				0,
				seek.ball.Position.Z - root.Position.Z,
			);

			let direction =
				toBall.Magnitude < CURVE_MIN_FLAT_STUDS
					? new Vector3(root.CFrame.LookVector.X, 0, root.CFrame.LookVector.Z).Unit
					: toBall.Unit;

			let reason = `walking on after the pickup — ${string.format("%.0f", NPC_CONFIG.PICKUP_WALK_STUDS)} studs`;

			// **The enemy, and the range gate that makes the backwards case a backpedal rather than a moonwalk.**
			// See the doc above; `THROW_RANGE_STUDS` is read here because it is the same number the throw's own aim
			// is bounded by, and a rig outside it is a rig with nothing holding its face.
			const enemy = detectEnemy(model);
			if (enemy !== undefined && enemy.distance <= NPC_CONFIG.THROW_RANGE_STUDS) {
				const away = new Vector3(
					root.Position.X - enemy.aimPoint.X,
					0,
					root.Position.Z - enemy.aimPoint.Z,
				);

				if (away.Magnitude >= CURVE_MIN_FLAT_STUDS && math.random() < NPC_CONFIG.PICKUP_BACKPEDAL_CHANCE) {
					direction = away.Unit;
					reason = `backing off the pickup — ${enemy.model.Name} at ${string.format("%.0f", enemy.distance)} studs`;
				}
			}

			seek.pickupWalk = root.Position.add(direction.mul(NPC_CONFIG.PICKUP_WALK_STUDS));
			seek.pickupWalkUntil = now + NPC_CONFIG.PICKUP_WALK_SECONDS;

			print(`[Rig] ${model.Name}: ${reason}`);

			// **And the walk it was making is over, which is what makes this a *new* movement rather than the old
			// one.** The claim on the ball it just took has nothing left to do, the sprint is off anyway because the
			// ball is in its hand rather than thirty studs away, and the arc belongs to a walk that has ended.
			endWalk(model, seek);
		}

		// **A hold plants the rig, and this is the turn it happens on.** The charge was solved by the throw
		// behaviour a moment ago — see the doc above for why this cannot make a throw short — and the body is
		// standing where the windup began rather than wherever the walk happened to be heading.
		if (model.GetAttribute(CHARGING_ATTRIBUTE) !== undefined) {
			stand(model, humanoid, root, seek);
			return;
		}

		// **Or the window is simply over**, which is the ordinary end of it: the rig reaches its rest point, stands
		// for the remainder of the window, and throws from there when its gate opens.
		if (seek.pickupWalk === undefined || now >= seek.pickupWalkUntil) {
			stand(model, humanoid, root, seek);
			return;
		}

		humanoid.MoveTo(seek.pickupWalk);
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

		/**
		 * **The rig's walk speed, stated rather than inherited — and this is the cost of the sprint arriving
		 * through the speed sum.**
		 *
		 * A rig's walk to a ball used to be whatever its template said, because nothing in this file ever touched
		 * `Humanoid.WalkSpeed`. That stops being true the moment a sprint is a *contribution*, and the reason is
		 * inside the service: the first thing to give a model a contribution **creates the model's entry, and an
		 * entry is created with a base** — `CHARACTER_CONFIG.BASE_WALK_SPEED`, which is a *player's* number, 20.
		 * So a rig that only ever added `Sprint` would silently walk at 20 while it was not sprinting, and the
		 * change would arrive as a side effect of a feature that was supposed to be about speed *while running*.
		 *
		 * **The number is the pad walk's, deliberately, and it is the only rig walk speed the game has.** Sixteen
		 * is the engine's own default, which is what makes this near enough to a no-op to be safe — see
		 * `NPC_CONFIG.WALK_TO_PAD_SPEED`, where the same number is set for the same reason (a template authored
		 * as a pose carries a `WalkSpeed` of zero, and a rig whose humanoid cannot walk is a rig that agrees to be
		 * told to walk and then does not move). **What it costs is named**: a rig's speed is now managed by two
		 * things rather than one — this base, and the contribution the sprint adds to it — and the place the two
		 * could fight is a rig wearing `Behavior_WalkToJoinPad` as well, which writes `WalkSpeed` *directly* and
		 * would clobber the sum for as long as it is on. No rig in this game wears both; see
		 * `WalkToJoinPadBehavior`'s own note on the pair, which is the same warning from the other side.
		 */
		prepare(model) {
			speeds.setBaseSpeed(model, NPC_CONFIG.WALK_TO_PAD_SPEED);
		},

		tick(model, humanoid) {
			// The part this rig is judged and moved by. `resolveDodgeable` rather than a name or a
			// `Humanoid.RootPart` read, because it is the helper a dodge, a catch and a pickup
			// already ask the same question through, and it answers for a rig with no humanoid too.
			const root = resolveDodgeable(model)?.root;
			if (!root) return;

			const seek = stateOf(model);

			// **One reading of the clock for the turn**, taken here rather than at each use: the arc's phase and
			// the jump's cooldown are both measured against it, and two `os.clock()` calls in one turn are two
			// instants pretending to be one. `NpcService` takes its own for the turn it is running — this is the
			// behaviour's, and it is the only clock a behaviour can have.
			const now = os.clock();

			// **Stop conditions, before anything is asked or moved.** The first is a ball in hand: there is nothing
			// to fetch, and this is the state a throwing rig spends most of its time in. Asked of `BallService`
			// rather than of the floor, because "am I holding one" is the one question about balls that a list of
			// loose ones cannot answer.
			//
			// **And it no longer means "stop".** A full hand used to be the end of the movement on the turn the
			// pickup landed, which was never a decision about throwing — nothing wanted the body still, it was just
			// that a rig with nothing to fetch has nothing to walk at. `pickupWalk` is what the rig does about
			// that instead, and it is where the "walk on / back off" draw lives.
			if (balls.getHeldBall(model)) {
				pickupWalk(model, humanoid, root, seek, now);
				return;
			}

			// **The box candidate, asked before anything else about balls — a live box outranks every ball.**
			// A rig holding a ball never reaches this line (the gate above throws first), so "the box
			// supersedes the walk, not the throw" falls out of the ordering: a throwing rig keeps its ball,
			// and the box is its *next* target the turn after the hand empties. A rig mid-walk to a ball
			// abandons the walk here — `endWalk` releases the ball's claim — and goes for the box instead.
			const box = nearestBox(model, root.Position);
			if (box !== undefined) {
				if (seek.ball !== undefined) endWalk(model, seek);

				// A box is walked to plain: no curve, no sprint, no hop — the five movements are the ball
				// walk's, and a box is a short, transient walk to a thing that despawns the moment the body
				// reaches it. `MoveTo` at the box's own position is the whole of it; the humanoid walks the
				// XZ, and the `Touched` that collects the box is the arrival.
				humanoid.MoveTo(box.Position);

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
				seek.best = math.huge;
				seek.stalled = 0;

				// **And this walk's own arc, drawn on the turn the walk is decided and never again.** This is
				// the only turn on which the shape is new — which is why the line about it is printed from
				// `seedWalk` rather than from the walk below, where it would be a drumbeat — and it is drawn
				// *per walk* rather than per rig so that two rigs setting off for two balls are two paths rather
				// than one path run twice. The distance is this turn's, measured before the body has moved.
				seedWalk(model, seek, ball.Position.sub(root.Position).Magnitude, now);
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

				// **And the sprint ends here too, which is the route the third one does not cover.** Arrival is
				// not a `stand` — the rig keeps its claim because it is about to take the ball — so this branch
				// is the only place the run can be ended on the way in. Without it a rig would arrive at
				// sprint speed and stand there with the contribution still on its body.
				endSprint(model, seek);

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

			// **The run, decided from what this turn measured and re-decided on every turn of the walk.** A gate
			// read once at the start of a walk would have a rig sprint the last three studs of an approach and
			// stroll the first thirty of a retreat; read here, a rig runs while the ball is far and is already
			// walking by the time it arrives, which is what a person does and is the only reason the two calls
			// below are a pair rather than one call and a clean-up.
			if (distance > NPC_CONFIG.SEEK_SPRINT_DISTANCE_STUDS) startSprint(model, seek, distance);
			else endSprint(model, seek);

			// **The walk, re-issued on every turn of the walk, and that is a reversal of what this line was.**
			//
			// It used to be issued only when the ball had moved `SEEK_BALL_MOVED_STUDS`, on the argument that a
			// `MoveTo` to the point it is already walking to is the same request made twice. **A curving walk
			// breaks that argument rather than merely outgrowing it**: the destination is a *different point*
			// every turn by construction — that is what an arc is — so the old gate would issue the first
			// turn's offset and then hold it, which is not a curve but a body walking at a spot beside the ball.
			//
			// **What replaced the gate is `curveTarget` and nothing else**, so the cost is one `MoveTo` per rig
			// per retarget interval. That is the same cost `WalkToJoinPadBehavior` already pays twice a second on
			// every rig in the lobby, and it is the number this behaviour's constant was always written as a
			// *retarget interval* rather than a tick rate to be. See `SEEK_RETARGET_SECONDS`, whose own doc has
			// been corrected with this one.
			// **And the bluff, which replaces the destination rather than being a second walk.** There is one
			// `MoveTo` per turn in this behaviour and there stays one: a shuffle is a different *point* to walk to
			// for a few tenths of a second, after which the arc below has it again. That is what keeps the arrival
			// check, the stall budget and the claim untouched by any of this — the rig is walking to its ball the
			// whole time, by a route that briefly goes six studs sideways.
			//
			// The expiry is checked before the start, so a rig that is mid-sidestep does not roll a second one, and
			// `maybeShuffle` is only reached on the turns when the rig is walking at the ball — which is where the
			// whole trigger belongs, since the bluff is about an approach and not about a body standing still.
			if (seek.sidestep !== undefined && now >= seek.shuffleUntil) seek.sidestep = undefined;
			if (seek.sidestep === undefined) maybeShuffle(model, root, ball, seek, now);

			humanoid.MoveTo(seek.sidestep ?? curveTarget(ball, root, seek, now));

			// **And the hop, after the walk has been issued, because "while moving" is exactly this line having
			// been reached.** Everything above is gates — a ball in hand, nothing to fetch, a claim that failed,
			// arrival, and the stall budget — so reaching here *is* the statement that this rig is walking to a
			// ball, and the jump's trigger needs no second way of asking. `SEEK_BALL_MOVED_STUDS`'s other reader
			// is `prune`, which is a record about a ball rather than about a walk and is untouched by any of this.
			maybeJump(model, humanoid, seek, now);
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
			// **The sprint comes off before the row does, and that ordering is the whole of the line.** The row is
			// where "this rig is sprinting" is written down, so a row dropped first would take the only record of
			// a contribution that is still on the body with it — and the body is about to be destroyed, which
			// forgets the entry through the service's own `Destroying` hook rather than through anything here.
			// Stated because the two are the same three lines in either order and only one of them is right.
			const seek = walking.get(model);
			if (seek !== undefined) endSprint(model, seek);

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
export function createRoundSeekBehavior(
	speeds: WalkSpeedService,
	pickups: BallPickupService,
	balls: BallService,
	mystery: MysteryBoxService,
): NpcBehavior {
	return createSeekBehavior(speeds, pickups, balls, mystery, BEHAVIOR_SEEKING, {
		label: "its half",
		parts: fetchRegionFor,
	});
}
