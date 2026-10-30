import { OnStart, Service } from "@flamework/core";
import { CollectionService, ReplicatedStorage, Workspace } from "@rbxts/services";
import { BALL_CONFIG } from "shared/config/ball.config";
import { DEBUG_CONFIG } from "shared/config/debug.config";
import { MATCH_SPAWNER_TAG, ROUND_STATE_ATTRIBUTE, ROUND_STATUS_FOLDER } from "shared/constants";
import { taggedPartsInWorkspace } from "shared/taggedParts";
import { LOGGING_ENABLED, logInfo } from "shared/logger";
import { insideZoneAt } from "../zone/PracticeZoneService";
import { scheduleBallExpiry } from "./ballExpiry";
import { BallFactory } from "./BallFactory";
import { BallService } from "./BallService";

/**
 * **The tag that marks a ball as one of the match's own** — the spawner's, and nothing else's.
 *
 * A **second** tag rather than a reuse of `"Ball"`, because they answer two different questions.
 * `"Ball"` means "this is a dodgeball" — pick it up, throw it, hit people with it — and every ball
 * in the game carries it. This one means "the arena's stocking put this one out", and only
 * {@link BallSpawnerService.spawn} applies it.
 *
 * **It used to be a budget's set as well, and that reading is gone with the budget.** A count of these
 * tags was what `MATCH_BALL_COUNT` was spent against, which is why a practice ball had to be excluded from
 * it. There is no ceiling any more — a round has exactly as many balls as there are spawner parts — so the
 * tag is now only two things: the marker the sweep strips as it destroys, and the Explorer-visible answer
 * to "which of these balls did the arena put out". It is still worth writing, and still worth *not* writing
 * on a practice ball, which is why `spawn` keeps its flag.
 *
 * **And a third reader arrived with item 143, which is worth knowing about before trusting the word "only"
 * above.** `BallService.lifetimeOf` asks this tag first and skips the status-folder read when it hits — a
 * fast path, not the rule. The rule there is the *phase*: while a round is being played, no loose ball is on
 * a clock at all, because this tag could not describe the hand-out balls that were disappearing mid-round.
 * So the tag means what it always meant — *the arena put this one out* — and the sweep and the Explorer are
 * still the things that depend on it.
 *
 * **It used to be the sweep's list as well, and that was wrong in a way nobody could see.** The
 * sweep read this tag and nothing else, on the argument that a ball *not* spawned here could not be
 * the round's. That is false: `BallService.giveBall` makes a ball too, and it is how an
 * `AlwaysThrowing` rig, a MultiBall window and a dev's `InfiniteBalls` are armed — and none of those
 * balls ever carried this tag, so a round's worth of hand-out dodgeballs stayed in the arena until
 * their own sixty-second lifetime ran out. The report was "the balls are not cleaned up between
 * rounds", and the litter was most of a round old by the time anybody saw it. The sweep takes every
 * loose ball in the world now and this tag means the arena's own stocking alone; see
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
 * **Puts out one ball beside every spawner part when a round begins — and that is the whole of what it
 * does.** No topping up, no refill, no budget: the number of balls in a round is the number of spawner
 * parts in the arena, decided once at the whistle and untouched until the whistle goes again.
 *
 * **It used to keep the arena stocked instead, and the difference is the point of this pass.** A tick
 * walked every part once a second and put a ball beside any part that did not already have one, spending
 * a global `MATCH_BALL_COUNT` as it went — so the floor refilled itself all round, and the number of
 * balls in play was a race between how fast players threw them away and how fast the tick replaced them.
 * That made the arena's supply a function of nothing anybody had decided. One ball per part, once, is a
 * supply a dev can see in the Explorer: **add a spawner part and the round has one more ball**.
 *
 * **It reads the round, and does not know the round exists.** Everything it needs is the phase on
 * the status folder in `ReplicatedStorage` — the same attribute the HUD reads — so this is a
 * sibling of `RoundService` rather than a dependent of it, and a round can be rewritten without
 * this file being touched. The two edges it wants are both here: the one where a round begins, which is
 * when the floor is stocked, and the one where it ends, which is when a round's balls stop being the
 * arena's and start being litter.
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
 *
 * **The practice zone is not this service's, and never was.** A practice floor's ball comes from
 * `PracticeZoneService.stockAt`, which calls {@link spawn} with `roundBudget = false` from the zone
 * service's own loop — so the zone keeps its own refill, its own rate and its own count, and nothing in
 * this file walks, limits or touches it.
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

			// **And the arena is stocked on the way in, once.** This is the *only* call that puts a round's
			// balls out, which is what makes the count a property of the arena rather than of the clock.
			//
			// **What stood here was wrong, and is worth recording.** It said the tick's ancestry guard
			// meant nothing was put out during an intermission — true when that guard was written,
			// because the arena was a clone that sat out of the world between rounds. The arena is
			// permanent now, so these parts are in `Workspace` all through an intermission.
			if (state === PLAYING) this.stockArena();

			this.previousState = state;
		});

		// **A service that comes up mid-round stocks once, for the same reason the edge does.** The line
		// above only fires on a *change*, and this service can mount with the phase already `Playing` — a
		// Studio session resuming a saved place whose status folder still says so, or a boot that lands
		// after the whistle. The loop this replaced used to cover that within a second; with no loop, the
		// only honest place to cover it is here, and the call is idempotent (see {@link stockArena}).
		if (this.previousState === PLAYING) this.stockArena();

		this.report();
	}

	/**
	 * Says what the tag found, once, at boot.
	 *
	 * **Because "the spawner does nothing" has two causes and {@link stockArena} is silent about both.** A
	 * tag is invisible in code: nothing may wear it, or the parts wearing it may not be in the world —
	 * and each is a `continue` with nothing on the other side, so the only evidence is a floor with no
	 * balls on it and an output that says nothing at all. This project has paid for the first of those
	 * three times over, with the barrier, the join pads and this tag; `taggedPartsInWorkspace` is the half
	 * of the answer that makes a container work, and this line is the half that says what was found.
	 *
	 * **Two numbers rather than one, and the pair is the point.** The first is how many things wear the
	 * tag; the second is how many parts the round will actually stock — so `1 tagged thing(s), 6 usable
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
	 * **A snapshot of boot, and now a *complete* one rather than a live total.** It used to say that a part
	 * tagged while the server ran started being stocked within a second, so this line going stale was not
	 * evidence of anything. **That is no longer true and the change is deliberate**: the walk happens once,
	 * at the start of a round, so **a spawner part tagged mid-round puts nothing on the floor until the next
	 * round begins**. This line is printed at boot and does not update, so the two facts together mean "count
	 * the parts before the round, not after it".
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

	/**
	 * **Puts out one ball beside every round spawner part — the whole supply, and the only time it is
	 * decided.**
	 *
	 * A plain walk over the tagged parts rather than a registry: the tag is the list, so the number of
	 * balls a round puts out is the number of parts somebody painted with it. **Nothing here limits
	 * that** — no budget, no cap, no cooldown, no second pass — and that is the deliberate change. What
	 * the count used to be was a race: a tick refilled any part that had lost its ball, so how many balls
	 * a round contained depended on how fast they were thrown away. Now it depends on the arena.
	 *
	 * **The parts come from `taggedPartsInWorkspace`, which is what the two guards that used to stand in
	 * this loop became.** A tagged folder stocks the parts inside it, and a spawner outside the world
	 * stocks nothing: this walk's whole act is to put a ball into `Workspace` beside a part, so a part
	 * that is not in `Workspace` is somewhere a ball cannot lie — that reasoning lives with the function
	 * now. The `IsA("BasePart")` check that was here is gone rather than kept as a harmless no-op: it can
	 * no longer be false, and a guard that cannot fail teaches a reader something untrue about what this
	 * is handed.
	 *
	 * **Nothing is stocked outside a match, and that is a guard rather than a condition on each spawn.**
	 * The arena is permanent, so these parts are in the world for the whole of an intermission — which is
	 * exactly where the balls used to come from: a tick landing mid-intermission stocked the floor for a
	 * match nobody had asked for. The phase is read once here rather than asked per part, because it is a
	 * fact about the whole walk.
	 *
	 * **There is no skip at all: every spawner part gets a ball, every time this runs.** There used to be
	 * one — `countLoose(part.Position) > 0`, *is any loose ball within eight studs of this part* — and it was
	 * there to make this call idempotent against the two ways a round can open. It was wrong twice over.
	 *
	 * - **It was a distance test standing in for an identity question**, so it only behaved while the parts
	 *   were further apart than the radius. With twenty-six parts closer together than that it read
	 *   `10 ball(s) put out, 16 part(s) already had one`: the ball put out for one part counted for its
	 *   neighbours, and the supply became the size of an independent set over the parts' neighbourhoods
	 *   instead of the number of parts. The report was *"I added more spawn parts but more balls were not
	 *   spawned"*.
	 * - **It was answering a question that cannot come up.** A second stocking in the same round would need
	 *   the phase to be written `Playing` twice with no `Intermission` between, because {@link mount} seeds
	 *   `previousState` from the folder before it subscribes and the handler only stocks on the *edge*. There
	 *   is no such edge, so the guard was protecting against nothing.
	 *
	 * **If it ever did fire twice the symptom would be a second ball per part for one round**, cleared at the
	 * whistle like every other ball — a visible, self-correcting mistake, which is a better failure than a
	 * supply that silently depends on somebody having spaced the parts out. **Spacing the parts is a level
	 * design question, not a correctness rule**, and nothing here reads it.
	 *
	 * **What the walk deliberately does not do is replace anything.** A ball thrown out of the arena,
	 * destroyed on impact or carried off is gone until the next round; there is no refill, because a refill
	 * is what made the count a function of the clock. The floor is a fixed supply, and picking a ball up is
	 * how it is re-used.
	 */
	private stockArena(): void {
		if (this.stateOf() !== PLAYING) return;

		// **The scope is around the body rather than split from it, and the split this replaced was there
		// for a loop that no longer exists.** `tick`/`tickBody` were two methods so a `profileend` could
		// not be missed by a tick that returned early; with one call at a boundary there is nothing to
		// guard, and one method is the whole of it. **No `try`/`finally`**, deliberately: roblox-ts
		// compiles one to an `xpcall`, which would add a call and a closure to the very path being
		// measured and would change how an error leaves this walk.
		// Scope: BallSpawner.stockArena — once a round, a walk of every round spawner part.
		if (DEBUG_CONFIG.PROFILE) debug.profilebegin("BallSpawner.stockArena");

		// **The one line that makes "the balls disappeared" answerable, and it is here because nothing else
		// was.** A round's supply is a fixed number decided at the whistle and never touched again, so the
		// question a bug report actually asks — *how many are left of what was put out* — has exactly two
		// readable ends: this one, and {@link cleanupRoundBalls}'s count of what was lying there at the end.
		// Without this line the stocking was completely silent, and a log showing balls being picked up and
		// thrown could not be told apart from one where the floor had quietly emptied.
		//
		// **One number, because the two it used to print could disagree and the disagreement was the bug.**
		// It read `${placed} ball(s) put out, ${already} part(s) already had one`, and `already` was the skip
		// above counting parts it had declined to stock — so the line reported a supply smaller than the arena
		// and called it normal. With no skip there is one quantity: the number of parts walked, and therefore
		// the number of balls. **That it is now the same number twice is the property worth having**, and
		// printing it twice would only invite a reader to wonder which one is authoritative.
		let parts = 0;

		for (const instance of taggedPartsInWorkspace(MATCH_SPAWNER_TAG)) {
			this.spawn(instance);
			parts++;
		}

		logInfo(
			`[Spawner] round stocked — ${parts} ball(s), one beside every spawner part` +
				`; this is the whole supply until the whistle`,
		);

		if (DEBUG_CONFIG.PROFILE) debug.profileend();
	}

	/**
	 * Puts one ball out beside `spawner`.
	 *
	 * The offset is drawn per ball and small — see {@link BALL_CONFIG.SPAWN_OFFSET_RANGE} — so two
	 * neighbouring spawners do not drop their balls on the same spot. The height clears the spawner part's
	 * own top, so a ball dropped on a platform lands on the platform rather than inside it.
	 *
	 * **This offset is the only thing standing between two close parts and two coincident balls, now that a
	 * part is never skipped** — see {@link stockArena} for why there is no skip any more. Two parts closer
	 * together than a ball's diameter will still make two balls overlap on the frame they are made; the
	 * engine separates them, and how far apart the parts sit is a level-design decision this file does not
	 * read. That is the deliberate trade: a supply that is always one ball per part, rather than one that
	 * quietly depends on spacing.
	 *
	 * **No expiry clock at all, which is now the truth for every ball this service makes.** The clock used
	 * to depend on the round — `math.huge` inside one, the ordinary lifetime between them — and that was
	 * how an intermission avoided slowly carpeting itself. {@link stockArena}'s phase guard does that job
	 * now by not making the ball in the first place, so a match ball is always on `math.huge`: still there
	 * when somebody goes back for it, and cleared by the round's own end.
	 * `BALL_CONFIG.LIFETIME_SECONDS` is untouched and still governs a thrown ball, which is
	 * `BallService`'s business rather than this one's.
	 *
	 * **`roundBudget` is the one word the practice zone needs, and it is a parameter rather than a second
	 * method because a second method would be a second construction path.** `false` skips the
	 * {@link ROUND_BALL_TAG} write and nothing else: the ball is made by the same factory, placed by the
	 * same offset, and put on the same "no clock" call.
	 *
	 * **What it prevents is no longer a budget but a false label.** The parameter is named for the job it
	 * did — a practice ball wearing `ROUND_BALL_TAG` would have spent one of the arena's eight — and the
	 * ceiling that made that matter is gone. What is left is the tag's meaning: it says *the arena's
	 * stocking put this one out*, and a practice floor's ball is not that, so it does not wear it. The
	 * sweep reads every loose ball rather than this tag, so nothing breaks either way; the reason to keep
	 * the flag truthful is that the next reader of the tag will be a person in the Explorer.
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
	 * leaving the world should stop wearing a marker that says the arena stocked it. It is a no-op for the
	 * hand-out balls, which never carried it.
	 */
	private cleanupRoundBalls(): void {
		let cleared = 0;
		// **The other half of the count {@link stockArena} prints.** A ball still wearing the arena's tag is
		// one the stocking put out and nothing has destroyed since; a cleared ball without it is a hand-out
		// — a rig's refill, a MultiBall, a dev's `InfiniteBalls` — and there are always more of those than
		// the arena has balls. Comparing this number against the stock line is how a round's losses are read
		// off a log: two numbers at the whistle, two at the end.
		let fromArena = 0;

		for (const instance of CollectionService.GetTagged(BALL_TAG)) {
			if (!instance.IsA("BasePart")) continue;
			if (instance.Parent !== Workspace) continue;
			if (this.balls.isHeld(instance)) continue;
			if (insideZoneAt(instance.Position)) continue;

			if (instance.HasTag(ROUND_BALL_TAG)) fromArena++;
			instance.RemoveTag(ROUND_BALL_TAG);
			instance.Destroy();
			cleared++;
		}

		logInfo(`[Spawner] round over — cleared ${cleared} ball(s), ${fromArena} of them the arena's own`);
	}

	/** The phase the round is in, as `RoundService` last published it. */
	private stateOf(): string {
		const state = this.statusFolder?.GetAttribute(ROUND_STATE_ATTRIBUTE);

		return typeIs(state, "string") ? state : "";
	}
}
