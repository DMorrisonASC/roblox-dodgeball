import { OnStart, Service } from "@flamework/core";
import { CollectionService, ReplicatedStorage, Workspace } from "@rbxts/services";
import { BALL_CONFIG } from "shared/config/ball.config";
import { DEBUG_CONFIG } from "shared/config/debug.config";
import { MATCH_SPAWNER_TAG, ROUND_STATE_ATTRIBUTE, ROUND_STATUS_FOLDER } from "shared/constants";
import { taggedPartsInWorkspace } from "shared/taggedParts";
import { LOGGING_ENABLED, logInfo } from "shared/logger";
import { MATCH_BALL_COUNT } from "../../config/match.config";
import { insideZoneAt } from "../zone/PracticeZoneService";
import { scheduleBallExpiry } from "./ballExpiry";
import { BallFactory } from "./BallFactory";
import { BallService } from "./BallService";

/**
 * **The tag that marks a ball as one of the match's own** — the spawner's, counted against the budget.
 *
 * A **second** tag rather than a reuse of `"Ball"`, because they answer two different questions.
 * `"Ball"` means "this is a dodgeball" — pick it up, throw it, hit people with it — and every ball
 * in the game carries it. This one means "the arena's stocking put this one out", and only
 * {@link BallSpawnerService.spawn} applies it.
 *
 * **It used to be the sweep's list as well, and that was wrong in a way nobody could see.** The
 * sweep read this tag and nothing else, on the argument that a ball *not* spawned here could not be
 * the round's. That is false: `BallService.giveBall` makes a ball too, and it is how an
 * `AlwaysThrowing` rig, a MultiBall window and a dev's `InfiniteBalls` are armed — and none of those
 * balls ever carried this tag, so a round's worth of hand-out dodgeballs stayed in the arena until
 * their own sixty-second lifetime ran out. The report was "the balls are not cleaned up between
 * rounds", and the litter was most of a round old by the time anybody saw it. The sweep takes every
 * loose ball in the world now and this tag means the budget alone; see
 * {@link BallSpawnerService.cleanupRoundBalls}.
 */
const ROUND_BALL_TAG = "RoundBall";

/**
 * The tag every ball carries, which is how the loose-ball count and the round's own sweep find the
 * balls at all — the one name that covers a spawner's ball and a hand-out alike, which is why
 * {@link BallSpawnerService.cleanupRoundBalls} asks for it rather than for `ROUND_BALL_TAG`.
 *
 * **Must match the `tag` in `BallComponent`'s decorator**, which is the source of truth: the
 * decorator is what turns a ball into a component, and Flamework reads that literal at build time,
 * so it cannot be imported. This is therefore a copy rather than a shared constant — exactly as it
 * is in `BallFactory`, `BallService` and `BallPickupService`, which are the other readers of a name
 * several files have to agree on.
 */
const BALL_TAG = "Ball";

/** The two phase names `RoundService` publishes. A word between two files, not a setting. */
const PLAYING = "Playing";
const INTERMISSION = "Intermission";

/**
 * Keeps the arena stocked with loose balls, one count per spawner part.
 *
 * **It reads the round, and does not know the round exists.** Everything it needs is the phase on
 * the status folder in `ReplicatedStorage` — the same attribute the HUD reads — so this is a
 * sibling of `RoundService` rather than a dependent of it, and a round can be rewritten without
 * this file being touched. The one thing it wants the round for is the edge between Playing and
 * Intermission, which is when a round's balls stop being the arena's and start being litter.
 *
 * **It does not create balls, and does not hold them.** `BallFactory` makes them and knows how a
 * ball is built; this decides only *where* and *when*. That is the whole of the split: a second
 * place that made balls would be a second place to get the tag, the physical properties and the
 * attribute order right.
 *
 * **It is also the one sweep between rounds, and that job is bigger than its own balls.** Everything
 * this service spawns carries {@link ROUND_BALL_TAG}, but not every ball in a round is the
 * spawner's — a hand-out makes a fresh one, and it is how an `AlwaysThrowing` rig, a MultiBall window
 * and a dev's `InfiniteBalls` get a ball. Those are the arena's litter all the same once the whistle
 * goes, so {@link cleanupRoundBalls} takes every loose ball in the world rather than only the ones
 * wearing its tag.
 */
@Service()
export class BallSpawnerService implements OnStart {
	/** The phase last seen, so a round *ending* can be told from a round that never started. */
	private previousState = "";

	/**
	 * The round's status folder, held once it has been found.
	 *
	 * Kept rather than looked up per tick, because finding it is a `WaitForChild` and the tick loop
	 * runs forever: a lookup in there would be a yield on a folder this service has already
	 * established exists, once a second.
	 */
	private statusFolder?: Folder;

	constructor(private readonly factory: BallFactory, private readonly balls: BallService) {}

	public onStart(): void {
		// Spawned rather than done inline: the status folder is made by `RoundService`, and waiting
		// for it can yield — so a service's `onStart` is the wrong place to hold up the rest of the
		// boot for something another service has not made yet. The same reasoning, and the same
		// shape, as the round HUD's mount.
		task.spawn(() => this.mount());
	}

	private mount(): void {
		const statusFolder = ReplicatedStorage.WaitForChild(ROUND_STATUS_FOLDER) as Folder;
		this.statusFolder = statusFolder;

		// Seeded before subscribing, so the first change is compared against what the round was
		// actually doing rather than against an empty string.
		this.previousState = this.stateOf();

		statusFolder.GetAttributeChangedSignal(ROUND_STATE_ATTRIBUTE).Connect(() => {
			const state = this.stateOf();

			// The edge, not the state: the sweep belongs to the moment a round *ends*, and running
			// it on every change would also run it on the way in, taking the balls that were just
			// put out for the next round.
			if (this.previousState === PLAYING && state === INTERMISSION) this.cleanupRoundBalls();

			// **And the arena is stocked on the way in, not a tick later.** The loop below would get
			// to this within a second anyway, but that second is a second of a round with an empty
			// floor — and with the tick now gated on the phase, this is the first call allowed to put
			// anything out, so the floor is stocked on the boundary itself rather than up to a second
			// after it.
			//
			// **What stood here was wrong, and is worth recording.** It said the tick's ancestry guard
			// meant nothing was put out during an intermission — true when that guard was written,
			// because the arena was a clone that sat out of the world between rounds. The arena is
			// permanent now, so these parts are in `Workspace` all through an intermission and the loop
			// was quietly stocking the floor for a match nobody had asked for. That is where the balls
			// at boot came from. The gate in `tick` makes the sentence true again, for a different
			// reason.
			if (state === PLAYING) this.tick();

			this.previousState = state;
		});

		task.spawn(() => this.tickLoop());

		this.report();
	}

	/**
	 * Says what the tag found, once, at boot.
	 *
	 * **Because "the spawner does nothing" has two causes and the loop below is silent about both.** A
	 * tag is invisible in code: nothing may wear it, or the parts wearing it may not be in the world —
	 * and each is a `continue` with nothing on the other side, so the only evidence is a floor with no
	 * balls on it and an output that says nothing at all. This project has paid for the first of those
	 * three times over, with the barrier, the join pads and this tag; `taggedPartsInWorkspace` is the half
	 * of the answer that makes a container work, and this line is the half that says what was found.
	 *
	 * **Two numbers rather than one, and the pair is the point.** The first is how many things wear the
	 * tag; the second is how many parts the loop will actually walk — so `1 tagged thing(s), 6 usable
	 * part(s)` is a folder doing its job, and `1 tagged thing(s), 0 usable part(s)` is a tag that found
	 * nothing the world can use. Either way the count is printed, **including at nought**, in the shape
	 * `ShiftLock` prints for its own zone tag: it arrives in the first second rather than an hour later.
	 *
	 * **And the tag's own name is in the line, which is what makes a rename diagnosable.** The spawner
	 * tag is the one Studio-visible thing this service names, and re-tagging the parts is a manual step
	 * that can be forgotten — so a place still wearing the old tag reads
	 * `MatchSpawner: 0 tagged thing(s), 0 usable part(s)`, which says "nothing wears this" rather than
	 * leaving a bare nought to interpret.
	 *
	 * **A snapshot of boot rather than a live total**, because the loop re-reads the tag every second and a
	 * part tagged while the server runs starts being stocked immediately — this line not changing is not
	 * evidence that nothing changed.
	 */
	private report(): void {
		// The raw tag for the first number, the filtered parts for the second: the difference between them
		// is what says a tag exists and the world cannot use it, which is the one fault this line is for.
		const tagged = CollectionService.GetTagged(MATCH_SPAWNER_TAG);
		const parts = taggedPartsInWorkspace(MATCH_SPAWNER_TAG);

		if (LOGGING_ENABLED) {
			logInfo(
				`[Spawner] up — watching ${ROUND_STATUS_FOLDER}.${ROUND_STATE_ATTRIBUTE}, ${MATCH_SPAWNER_TAG}:` +
					` ${tagged.size()} tagged thing(s), ${parts.size()} usable part(s)`,
			);
		}
	}

	/** Every spawner's count, once a second. See {@link tick}. */
	private tickLoop(): void {
		while (true) {
			task.wait(BALL_CONFIG.SPAWN_TICK_INTERVAL);
			this.tick();
		}
	}

	/**
	 * Tops up every spawner that is short of its ball, while a match is on and the arena has room.
	 *
	 * A plain walk over the tagged parts rather than a registry: the tag is the list, and a spawner
	 * placed in Studio while the game is running starts being topped up on the next tick with
	 * nothing to tell this service about it.
	 *
	 * **The parts come from `taggedPartsInWorkspace`, which is what the two guards that used to stand in
	 * this loop became.** A tagged folder stocks the parts inside it, and a spawner outside the world
	 * stocks nothing: this loop's whole act is to put a ball into `Workspace` beside a part, so a part that
	 * is not in `Workspace` is somewhere a ball cannot lie — that reasoning lives with the function now.
	 * The `IsA("BasePart")` check that was here is gone rather than kept as a harmless no-op: it can no
	 * longer be false, and a guard that cannot fail teaches a reader something untrue about what this loop
	 * is handed.
	 *
	 * **Nothing is stocked outside a match, and that is the first line rather than a condition on each
	 * spawn.** The arena is permanent, so these parts are in the world for the whole of an intermission —
	 * which is exactly where the balls used to come from: this loop's first turn landed mid-intermission
	 * and stocked the floor for a match nobody had asked for. The phase is read once here rather than
	 * asked per part, because it is a fact about the whole tick.
	 *
	 * **One ball each, under a budget of {@link MATCH_BALL_COUNT}.** The per-part rule is the `continue`
	 * below; the budget is counted from the world as this tick starts and spent as the walk goes, so the
	 * two limits cannot disagree about how many balls the arena is holding.
	 */
	private tick(): void {
		// Scope: BallSpawner.tick — once a second, a budget count plus a walk of every spawner part.
		if (DEBUG_CONFIG.PROFILE) debug.profilebegin("BallSpawner.tick");
		this.tickBody();
		if (DEBUG_CONFIG.PROFILE) debug.profileend();
	}

	/**
	 * The body of {@link tick}, split off **only** so the scope above can wrap it.
	 *
	 * **Why a second method rather than the pair written into the body.** The first line of the original
	 * is `if (this.stateOf() !== PLAYING) return;`, i.e. every turn outside a round leaves the function
	 * immediately — a `profileend` at the bottom would then never run, and the MicroProfiler would be left
	 * holding an open band for a tick that did nothing. The split makes the pairing structural rather than
	 * remembered: one statement between `begin` and `end`, and the early return is a return into it. The
	 * `break` inside the loop is untouched and needs nothing, since it is not an exit from the function.
	 *
	 * **No `try`/`finally`**, deliberately: roblox-ts compiles one to an `xpcall`, which would add a call
	 * and a closure to the very path being measured and would change how an error leaves this loop.
	 */
	private tickBody(): void {
		if (this.stateOf() !== PLAYING) return;

		let budget = MATCH_BALL_COUNT - this.roundBallCount();

		for (const instance of taggedPartsInWorkspace(MATCH_SPAWNER_TAG)) {
			// **One each: a part with a ball lying beside it is not short of anything.** `countLoose` is
			// the same question the pickup search asks, so "there is a ball here" means the same thing to
			// both — and it counts any loose ball, which is why a ball somebody threw back is as good as
			// one this service made.
			if (this.countLoose(instance.Position) > 0) continue;

			// **The cap, and the caveat that comes with it.** When the parts outnumber the budget this walks
			// from the front of `GetTagged`'s list and leaves the tail empty, and that order promises
			// nothing — it is not the arena's layout, or its folders, or anything anybody chose. It cannot
			// happen at six parts and a budget of eight, and it is not guarded against now: the fix would be
			// to spread the balls across the parts, and what "spread" should mean for twelve of them is a
			// question about the arena rather than about this loop. Left until there is an arena that asks
			// it.
			if (budget <= 0) break;

			this.spawn(instance);
			budget--;
		}
	}

	/**
	 * How many balls the match owns right now: every part wearing {@link ROUND_BALL_TAG}, on the floor or
	 * in somebody's hand.
	 *
	 * **Counted from the world rather than tallied as the balls are made**, and that is the correction a
	 * tally would need: a ball destroyed on impact is gone before anybody takes it back, so a counter
	 * incremented at {@link spawn} would drift above the truth and the budget would quietly stop replacing
	 * anything. Read afresh each tick, this cannot disagree with what is out there.
	 *
	 * **A held ball counts**, deliberately — it is still the match's ball and still one of the budget, and
	 * a count that ignored it would put a replacement on the floor for a ball somebody is carrying.
	 *
	 * **The raw tag rather than `taggedParts`, and it is now the budget's set alone.** It used to be
	 * shared with {@link cleanupRoundBalls}, on the argument that the two had to agree about what the
	 * match owns. They no longer do and must not: the sweep takes every loose ball because a hand-out
	 * ball is the round's litter too, while this count stays on the spawner's own balls so that a rig
	 * throwing one does not spend the budget the arena's floor is stocked from. Counting those would
	 * have emptied the floor the moment eight rigs were throwing.
	 */
	private roundBallCount(): number {
		let count = 0;

		for (const instance of CollectionService.GetTagged(ROUND_BALL_TAG)) {
			if (instance.IsA("BasePart")) count++;
		}

		return count;
	}

	/** How many loose balls are lying within {@link BALL_CONFIG.SPAWN_RADIUS} of `centre`. */
	private countLoose(centre: Vector3): number {
		let count = 0;

		for (const instance of CollectionService.GetTagged(BALL_TAG)) {
			if (!instance.IsA("BasePart")) continue;
			// Loose means three things, and each is a ball that is not this spawner's to count: not
			// in the world (held, or in somebody's hand), armed (it is a live projectile in flight,
			// not a ball lying around), and not nearby. The pickup search reads the same three
			// facts — see `BallPickupService` — which is what keeps the two agreeing about what
			// "on the floor" means.
			if (instance.Parent !== Workspace) continue;
			if (instance.GetAttribute("Armed") === true) continue;
			if (instance.Position.sub(centre).Magnitude > BALL_CONFIG.SPAWN_RADIUS) continue;

			count++;
		}

		return count;
	}

	/**
	 * Puts one ball out beside `spawner`.
	 *
	 * The offset is drawn per ball and small — see {@link BALL_CONFIG.SPAWN_OFFSET_RANGE} — so two
	 * neighbouring spawners do not drop their balls on the same spot. The height clears the spawner part's
	 * own top, so a ball dropped on a platform lands on the platform rather than inside it.
	 *
	 * **No expiry clock at all, which is now the truth for every ball this service makes.** The clock used
	 * to depend on the round — `math.huge` inside one, the ordinary lifetime between them — and that was
	 * how an intermission avoided slowly carpeting itself. The gate in {@link tick} does that job now by
	 * not making the ball in the first place, so a match ball is always on `math.huge`: still there when
	 * somebody goes back for it, and cleared by the round's own end. `BALL_CONFIG.LIFETIME_SECONDS` is
	 * untouched and still governs a thrown ball, which is `BallService`'s business rather than this
	 * one's.
	 *
	 * **`roundBudget` is the one word the practice zone needs, and it is a parameter rather than a second
	 * method because a second method would be a second construction path.** `false` skips the
	 * {@link ROUND_BALL_TAG} write and nothing else: the ball is made by the same factory, placed by the
	 * same offset, and put on the same "no clock" call. **The bug it prevents is the budget**: that tag is
	 * what {@link roundBallCount} counts and what `MATCH_BALL_COUNT` is spent against, so a practice ball
	 * wearing it would spend one of the arena's eight on a ball nobody is playing with — and eight zones
	 * would empty the arena's floor while the practice floors stayed stocked.
	 *
	 * **What the flag deliberately does not change is the ball's state**, because there is only one state a
	 * new ball has: `BallFactory.createLoose` leaves it unarmed, unnamed to anybody, parented to
	 * `Workspace`, and on no clock. That *is* the practice zone's inert ball, so the practice arm writes
	 * nothing about the ball except its own tag — see `PracticeZoneService.stockAt`. A flag that also
	 * rewrote `Armed` would be this method deciding what a practice ball is, which is the zone's job.
	 */
	public spawn(spawner: BasePart, roundBudget = true): BasePart {
		const range = BALL_CONFIG.SPAWN_OFFSET_RANGE;
		const offset = new Vector3(
			math.random(-range * 100, range * 100) / 100,
			0,
			math.random(-range * 100, range * 100) / 100,
		);
		const position = spawner.Position.add(offset).add(new Vector3(0, spawner.Size.Y / 2 + 1, 0));

		const ball = this.factory.createLoose(position);
		if (roundBudget) ball.AddTag(ROUND_BALL_TAG);

		scheduleBallExpiry(ball, math.huge, (expiring) => this.balls.isHeld(expiring));

		return ball;
	}

	/**
	 * **Takes back every loose ball in the world when the round ends — not only the ones this service
	 * put out.**
	 *
	 * **The bug this replaced, because the shape of it is the lesson.** This swept
	 * {@link ROUND_BALL_TAG} and nothing else, which is correct only if the spawner is the only thing
	 * that makes a ball. It is not: `BallService.giveBall` builds one, and that is how an
	 * `AlwaysThrowing` rig, a MultiBall window and a dev's `InfiniteBalls` are armed — so a round's
	 * worth of hand-out dodgeballs was invisible to the sweep and stayed on the arena floor until its
	 * own sixty-second lifetime expired. The arena is permanent now, so nothing else takes them: the
	 * report was "the balls are not cleaned up between rounds". The fix is to ask the question the
	 * sweep is actually about — *is this ball lying in the world* — rather than the question the tag
	 * happens to answer.
	 *
	 * **Three things are skipped, and each is a different reason a loose ball is not litter.**
	 *
	 * - **A ball still in somebody's hand** (`isHeld`) — taken from a player mid-action for a reason
	 *   that has nothing to do with them. It keeps the ordinary lifetime, so it goes when it is next
	 *   released, and `RoundService.clearHeldBalls` empties the hands that are on their way into the
	 *   next round anyway.
	 * - **A ball that is not parented to `Workspace`** — welded into a hand is the ordinary case, and
	 *   a parent that is not the world is a ball somebody else is still holding on to. This is the
	 *   belt to `isHeld`'s braces and costs one comparison.
	 * - **A ball inside a practice zone** — the one place in this game that is deliberately outside
	 *   the round, and the same skip `RoundService`'s two cleanups make for a player standing in one.
	 *   A practice player's MultiBall ball is thrown on a practice floor rather than in the arena, and
	 *   a round ending on the other side of the map is not its business. Asked through
	 *   `PracticeZoneService.insideZoneAt`, which is the zone module's own answer to "is this point on
	 *   a practice floor" rather than a second copy of the geometry.
	 *
	 * **The tag still comes off before the destroy**, for the one frame in between and because a ball
	 * leaving the world should stop being counted by `roundBallCount` at the same instant: a
	 * spawner-made ball on its way out must not still be spending budget. It is a no-op for the
	 * hand-out balls, which never carried it.
	 */
	private cleanupRoundBalls(): void {
		let cleared = 0;

		for (const instance of CollectionService.GetTagged(BALL_TAG)) {
			if (!instance.IsA("BasePart")) continue;
			if (instance.Parent !== Workspace) continue;
			if (this.balls.isHeld(instance)) continue;
			if (insideZoneAt(instance.Position)) continue;

			instance.RemoveTag(ROUND_BALL_TAG);
			instance.Destroy();
			cleared++;
		}

		logInfo(`[Spawner] round over — cleared ${cleared} ball(s)`);
	}

	/** The phase the round is in, as `RoundService` last published it. */
	private stateOf(): string {
		const state = this.statusFolder?.GetAttribute(ROUND_STATE_ATTRIBUTE);

		return typeIs(state, "string") ? state : "";
	}
}
