import { NPC_CONFIG } from "shared/config/npc.config";

/**
 * **Which rig has set off for which loose ball — one answer, asked by everyone who walks to a ball.**
 *
 * **The problem this exists for.** Eight rigs run `SeekBehavior` independently, and every one of them asks
 * "which ball is nearest to me". That question has no idea other rigs are asking it, so with four balls on
 * the floor and eight rigs wanting one, the same ball is the nearest answer for several of them at once —
 * and what that looks like from a seat is a scrum: three rigs walking the same line, two arriving together,
 * one taking the ball while the others stand there having spent the whole walk on it.
 *
 * **The minimum that fixes it is agreement about a fact, not communication.** Nothing here sends a message,
 * raises an event or keeps a queue: a rig that has decided on a ball *writes down that it has*, and every
 * other rig reading the same list sees the ball as taken and takes the next nearest. That is a `Map` and
 * three functions, which is why this is a module beside `rigs.ts` and `detect.ts` rather than a service —
 * `HANDOFF.md` §0's rule, and the reason `rigs.ts` exists at all: a derivation two callers need does not
 * deserve a lifecycle, a constructor and a `flamework.build` entry.
 *
 * **What a claim is and is not.**
 *
 * - It **is** a route reservation: while rig A is walking to a ball, rig B will not choose that ball.
 * - It is **not** a lock on the ball. Whoever is standing next to it when the pickup runs takes it, claimed
 *   or not — see `PickupBehavior`, which asks `BallPickupService` for the nearest ball in reach and has no
 *   business knowing about this file. A snatch is possible and it repairs itself: the loser's next turn
 *   finds its target no longer loose and picks again.
 * - It is **not** a turn order, a priority, or a queue. There is no "next in line": a released ball is
 *   simply free, and whichever rig reaches it in its own selection gets it.
 *
 * **State, and why one map rather than two.** `Map<BasePart, Claim>` — ball to holder — with `release`
 * scanning for the rig's own entry, which is O(balls) and there are never more than `MATCH_BALL_COUNT` of
 * them. The alternative is a second map the other way round (rig to ball) so `release` is O(1), and it is
 * worse than it looks: two maps mean two writers, and the one bug this module can have is the two
 * disagreeing about who holds what. A handful of comparisons per release is not a price worth that.
 * `claim` and `claimedBy` are O(1) single-entry reads; the sweep in `claim` is O(balls) and runs a few
 * times a round per rig.
 *
 * **Why a `Map` and not a `WeakMap`.** Both the expiry sweep and `release(rig)` have to *look* at entries
 * nobody asked about, and a `WeakMap` cannot be iterated. So the entries are pruned explicitly instead of
 * being collected, and the pruning is the whole of what makes that safe — see `isStale`.
 *
 * **Why there is a timeout at all, which is the one thing here that is not obvious.** A claim is released
 * explicitly on every route this game actually takes — a pickup, a walk that ends, a give-up, a death (see
 * `SeekBehavior`, which releases in `stand` and in `onDied`). What no hook covers is a rig whose
 * `Behavior_Seeking` tag is **removed**: `NpcBehavior` has `prepare`, `tick` and `onDied` and nothing else,
 * and `NpcService` has no "your tag just left me" callback to offer — so the tag switching off at a round
 * boundary leaves whatever this module knows about that rig exactly where it was. `isStale` is the answer to
 * that: a claim that has not been **renewed** inside `NPC_CONFIG.CLAIM_SECONDS` stops counting, and because
 * `SeekBehavior` renews on every turn of a walk, the figure means "the owner stopped asking" rather than
 * "the walk took a while". A rig that is dead, out of the world, or no longer seeking therefore parks
 * nothing, and a ball is never ignored for a round because somebody forgot a hook.
 */

/** One rig's reservation: who holds it, and when they last said so. */
interface Claim {
	/** The rig that set off for this ball. */
	readonly rig: Model;

	/**
	 * `os.clock` seconds at which the holder last renewed it.
	 *
	 * **A timestamp rather than a countdown**, so nothing has to run on a clock: the entry is judged when it
	 * is read, and a rig that is walking renews it every turn, which is cheaper than a timer per claim and
	 * cannot drift away from the thing it is measuring.
	 */
	readonly at: number;
}

/** Ball to holder. See the module doc for why this is one map rather than two. */
const claims = new Map<BasePart, Claim>();

/**
 * Whether an entry has stopped meaning anything: the holder's gone, the ball's gone, or nobody has renewed
 * it for `NPC_CONFIG.CLAIM_SECONDS`.
 *
 * **Three ways to be stale, and each is a real one.** A **destroyed ball** is the ordinary case at a round
 * boundary — `BallSpawnerService.cleanupRoundBalls` destroys every round ball on the intermission edge, and
 * `LobbyRigService` destroys rigs when a player joins — and a `Map` key that no longer exists in the world
 * is a reference to nothing that would otherwise sit there until the server stopped. A **rig out of the
 * world** is the case no hook covers, because `NpcService` calls `onDied` only when a loop ends with no
 * health left: a rig that is simply `Destroy()`ed takes its claim with it only if somebody notices. And
 * **the timeout** is the case neither of those catches — a rig that is alive, in the world, and no longer
 * wearing the tag that would ever release anything.
 *
 * **`rig.Parent` rather than `IsDescendantOf(Workspace)`**, which is the same test `NpcService.run` uses for
 * its world gate: this runs inside a per-tick read for every rig, and `Parent` is a field read where
 * `IsDescendantOf` walks the tree.
 */
function isStale(ball: BasePart, claim: Claim, now: number): boolean {
	if (ball.Parent === undefined) return true;
	if (claim.rig.Parent === undefined) return true;

	return now - claim.at > NPC_CONFIG.CLAIM_SECONDS;
}

/**
 * **Attempts to reserve `ball` for `rig`. `true` if the rig holds it afterwards.**
 *
 * **Idempotent, and that is what makes renewal free.** A rig that already holds `ball` gets `true` and a
 * refreshed timestamp, so the caller does not have to know whether this is a fresh walk or the five
 * hundredth turn of one — the difference between claiming and renewing is a decision this function makes by
 * looking, not a distinction every caller has to carry.
 *
 * **A refused claim is somebody else's**, and the answer is a plain `false` rather than a wait or a queue:
 * the caller's job is to look at the next nearest ball, not to negotiate.
 *
 * **The sweep is here rather than in the read** for the reason the module doc gives: this is called once per
 * fresh walk and once per turn of a walk, while `claimedBy` is called for every loose ball on every turn by
 * every rig — so the O(balls) pass belongs on the cheaper path and the single-entry check on the hot one.
 */
export function claim(rig: Model, ball: BasePart): boolean {
	const now = os.clock();

	for (const [candidate, held] of claims) {
		if (candidate !== ball && isStale(candidate, held, now)) claims.delete(candidate);
	}

	const held = claims.get(ball);

	if (held !== undefined && !isStale(ball, held, now) && held.rig !== rig) return false;

	claims.set(ball, { rig, at: now });

	return true;
}

/**
 * **Gives up whatever `rig` was holding, if anything.**
 *
 * Called from every route that ends a walk — the ball arriving in the rig's hand, the target stopping being
 * loose, the rig giving up on it, and the rig dying — all of which are `SeekBehavior`'s to call, because it
 * is the only thing that knows when a walk is over. Wrong-but-harmless if called with nothing to release,
 * so each of those paths can call it unconditionally rather than asking first.
 */
export function release(rig: Model): void {
	for (const [ball, held] of claims) {
		if (held.rig === rig) claims.delete(ball);
	}
}

/**
 * **Who, if anyone, has set off for `ball` — and `undefined` for a ball nobody is walking to.**
 *
 * **Judged as it is read, not swept.** This is the hot path: every rig asks it about every loose ball on
 * every turn, so it checks the one entry it was asked about and no others. A stale entry is deleted on the
 * way past rather than reported, which is what makes the answer honest without a second pass — and it is
 * also the moment a ball becomes available again for everyone, so the two facts stay one fact.
 */
export function claimedBy(ball: BasePart): Model | undefined {
	const held = claims.get(ball);
	if (held === undefined) return undefined;

	if (isStale(ball, held, os.clock())) {
		claims.delete(ball);

		return undefined;
	}

	return held.rig;
}
