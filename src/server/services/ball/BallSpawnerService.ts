import { OnStart, Service } from "@flamework/core";
import { CollectionService, ReplicatedStorage, Workspace } from "@rbxts/services";
import { BALL_CONFIG } from "shared/config/ball.config";
import { ROUND_STATE_ATTRIBUTE, ROUND_STATUS_FOLDER } from "shared/constants";
import { scheduleBallExpiry } from "./ballExpiry";
import { BallFactory } from "./BallFactory";
import { BallService } from "./BallService";

/** Prints a line when the round's balls are cleared, and nothing else. */
const DEBUG = true;

/**
 * The tag that marks a part as a spawner: a piece of arena that keeps loose balls around it.
 *
 * **A tag rather than a list**, for the reason everything else here is tagged: a spawner is a
 * placement decision — where the balls should be — and placing one is done in Studio by tagging a
 * part, with nothing to write and nothing to register. Several are independent, and the tag is
 * how the loop finds them all without being told about any of them.
 */
const SPAWNER_TAG = "BallSpawner";

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

			this.previousState = state;
		});

		task.spawn(() => this.tickLoop());

		if (DEBUG) print(`[Spawner] up — watching ${ROUND_STATUS_FOLDER}.${ROUND_STATE_ATTRIBUTE}`);
	}

	/** Every spawner's count, once a second. See {@link tick}. */
	private tickLoop(): void {
		while (true) {
			task.wait(BALL_CONFIG.SPAWN_TICK_INTERVAL);
			this.tick();
		}
	}

	/**
	 * Tops up every spawner that is short of its count.
	 *
	 * A plain walk over the tagged parts rather than a registry: the tag is the list, and a spawner
	 * placed in Studio while the game is running starts being topped up on the next tick with
	 * nothing to tell this service about it.
	 */
	private tick(): void {
		const state = this.stateOf();

		for (const instance of CollectionService.GetTagged(SPAWNER_TAG)) {
			if (!instance.IsA("BasePart")) continue;

			const nearby = this.countLoose(instance.Position);
			const missing = BALL_CONFIG.BALLS_PER_SPAWNER - nearby;

			for (let index = 0; index < missing; index++) this.spawn(instance, state);
		}
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
	 * The offset is drawn per ball and small — see {@link BALL_CONFIG.SPAWN_OFFSET_RANGE} — so a
	 * spawner refilling its whole count does not stack them in one place. The height clears the
	 * spawner part's own top, so a ball dropped on a platform lands on the platform rather than
	 * inside it.
	 *
	 * The clock it is put on depends on the round, and that is the entire difference the round
	 * makes to a ball: during a round it is not on a clock at all, because the arena's balls have
	 * to still be there when somebody goes back for one, and the round's own end is what clears
	 * them. Between rounds they are on the ordinary lifetime, so a server sitting in intermission
	 * does not quietly fill with them.
	 */
	private spawn(spawner: BasePart, state: string): void {
		const range = BALL_CONFIG.SPAWN_OFFSET_RANGE;
		const offset = new Vector3(
			math.random(-range * 100, range * 100) / 100,
			0,
			math.random(-range * 100, range * 100) / 100,
		);
		const position = spawner.Position.add(offset).add(new Vector3(0, spawner.Size.Y / 2 + 1, 0));

		const ball = this.factory.createLoose(position);
		ball.AddTag(ROUND_BALL_TAG);

		const timeout = state === PLAYING ? math.huge : BALL_CONFIG.LIFETIME_SECONDS;

		scheduleBallExpiry(ball, timeout, (expiring) => this.balls.isHeld(expiring));
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
