import { OnStart, Service } from "@flamework/core";
import { CollectionService, ReplicatedStorage, Workspace } from "@rbxts/services";
import { BALL_CONFIG } from "shared/config/ball.config";
import { MATCH_SPAWNER_TAG, ROUND_STATE_ATTRIBUTE, ROUND_STATUS_FOLDER } from "shared/constants";
import { taggedPartsInWorkspace } from "shared/taggedParts";
import { MATCH_BALL_COUNT } from "../../config/match.config";
import { scheduleBallExpiry } from "./ballExpiry";
import { BallFactory } from "./BallFactory";
import { BallService } from "./BallService";

/** Prints a line when the round's balls are cleared, and nothing else. */
const DEBUG = true;

/**
 * The tag that marks a ball as one the round owns.
 *
 * A **second** tag rather than a reuse of `"Ball"`, because they answer two different questions.
 * `"Ball"` means "this is a dodgeball" — pick it up, throw it, hit people with it — and every ball
 * in the game carries it. This one means "this ball is part of the arena's furniture and goes when
 * the round does", and only the spawner applies it. Keeping them apart is what lets the cleanup be
 * one loop over one tag without having to work out which balls were whose.
 */
const ROUND_BALL_TAG = "RoundBall";

/**
 * The tag every ball carries, which is how the count finds the balls at all.
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
 * Every ball it spawns carries {@link ROUND_BALL_TAG}, which is what the cleanup sweeps — and any
 * ball *not* spawned here never gets it, so a thrown ball is never swept up by a round ending.
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

		if (DEBUG) {
			print(
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
	 * The raw tag rather than `taggedParts`, because this is the same set {@link cleanupRoundBalls} sweeps
	 * and the two must agree about what the match owns.
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
	 */
	private spawn(spawner: BasePart): void {
		const range = BALL_CONFIG.SPAWN_OFFSET_RANGE;
		const offset = new Vector3(
			math.random(-range * 100, range * 100) / 100,
			0,
			math.random(-range * 100, range * 100) / 100,
		);
		const position = spawner.Position.add(offset).add(new Vector3(0, spawner.Size.Y / 2 + 1, 0));

		const ball = this.factory.createLoose(position);
		ball.AddTag(ROUND_BALL_TAG);

		scheduleBallExpiry(ball, math.huge, (expiring) => this.balls.isHeld(expiring));
	}

	/**
	 * Takes back every ball the round owned, when the round ends.
	 *
	 * **A ball still in somebody's hand is left alone**, and that is the one judgement here. A ball
	 * that leaves the arena's floor and ends up held is no longer litter, and destroying it out of
	 * a hand would take a ball from a player mid-action for a reason that has nothing to do with
	 * them. It keeps the ordinary lifetime instead, so it goes when it is next dropped or thrown —
	 * the same clock every other ball is on.
	 *
	 * The tag comes off before the destroy, which matters for the one frame in between: a ball on
	 * its way out should not still be counted as the round's.
	 */
	private cleanupRoundBalls(): void {
		let cleared = 0;

		for (const instance of CollectionService.GetTagged(ROUND_BALL_TAG)) {
			if (!instance.IsA("BasePart")) continue;
			if (this.balls.isHeld(instance)) continue;

			instance.RemoveTag(ROUND_BALL_TAG);
			instance.Destroy();
			cleared++;
		}

		if (DEBUG) print(`[Spawner] round over — cleared ${cleared} round balls`);
	}

	/** The phase the round is in, as `RoundService` last published it. */
	private stateOf(): string {
		const state = this.statusFolder?.GetAttribute(ROUND_STATE_ATTRIBUTE);

		return typeIs(state, "string") ? state : "";
	}
}
