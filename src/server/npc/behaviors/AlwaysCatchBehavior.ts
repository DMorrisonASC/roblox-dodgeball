import { BEHAVIOR_ALWAYS_CATCHING, NpcBehavior } from "../Behavior";
import type { BallService } from "../../services/ball/BallService";
import type { CatchService } from "../../services/actions/CatchService";

/**
 * Catching, for an NPC — **and the two ways to ask for it.**
 *
 * A catch *attempt* is only ever an attempt: asking opens a window, and the ball that arrives inside
 * it is the one caught. So the honest way to run this on a timer is to ask, and the rule that decides
 * *when* to ask is the whole difference between the two tags this file serves:
 *
 * - **`Behavior_AlwaysCatching`** asks on every tick, which holds a window open continuously — an NPC
 *   with its hands ready is a catcher, and it still has to be hit on the torso or the arms to take the
 *   ball. This is the behaviour that predates the split, preserved exactly; see
 *   {@link createAlwaysCatchBehavior}.
 * - **`Behavior_Catching`** asks only when a 50 %-per-window decision says this rig is a catcher *and*
 *   a ball is in its detection radius. The decision is re-rolled on a coarse cadence rather than every
 *   tick, which is what leaves the window **closed** for roughly half the timeline — and a closed
 *   window is what a sibling `Behavior_Dodging` needs, because an open one refuses a dodge outright
 *   (`DodgeService.blocksDodge`). See `CatchBehavior.ts`, which is that variant.
 *
 * **Why one tick body and two factories, rather than two files that each carry this essay.** The two
 * variants differ in exactly one line — whether `attemptCatch` is called this turn — and everything
 * around it (the interval, the free-hand rule, the drop-if-not-armed tail) is identical. Two copies
 * of that would be two places to fix the next time the hand rule changes. So the body lives here,
 * parameterised by a `shouldAsk` predicate, and each tag is a named factory that supplies its own
 * predicate. {@link makeCatchBehavior} is the internal factory; the two `create*` functions are the
 * only things `NpcService` should see.
 *
 * Nothing here decides whether a catch happens. `CatchService` owns the window, its expiry and its
 * consumption, so an attempt from an NPC runs the exact code a keypress from a player does; this
 * file only knows how to ask, and when.
 */

/**
 * The shared body of both catch behaviours.
 *
 * **A predicate rather than a boolean, and that is forced by the drop tail.** The tail below runs
 * every turn regardless — a catcher that has just taken a ball out of the air must put it down before
 * its *next* catch can land — so the tick body cannot be "ask, then drop, only on some turns". It is
 * "maybe ask, then always drop", and `shouldAsk` is the maybe. A caller that wants the old behaviour
 * passes a predicate that always answers `true`; a caller that wants the gated one passes a predicate
 * that owns the decision and its clock.
 */
export function makeCatchBehavior(
	catches: CatchService,
	balls: BallService,
	tag: string,
	shouldAsk: (model: Model, now: number) => boolean,
): NpcBehavior {
	return {
		tag,

		// Well under `CATCH_CONFIG.WINDOW_SECONDS` on purpose. The window is refreshed by asking,
		// so this period is how stale a window can get between refreshes — not how
		// long a catcher is allowed to catch for, which stays the window's job.
		tickInterval: 0.1,

		tick(model) {
			// **The maybe.** For the always variant this is an unconditional ask, which is the
			// behaviour that held a window open every tick; for the gated variant it is a decision
			// made once per window rather than once per turn. Which of the two this rig is wearing
			// is the whole of the difference between `Behavior_Catching` and `Behavior_AlwaysCatching`.
			if (shouldAsk(model, os.clock())) catches.attemptCatch(model);

			// Whatever it has just taken out of the air goes straight back down.
			//
			// Two reasons, and both come from the hand being one slot. A catcher that keeps its
			// catches cannot catch again, because a catch needs a free hand — `attemptCatch` refuses
			// an occupied one, and a caught ball counts as much as an armed one — so this drop is what
			// makes the next tick's attempt count for anything. And a ball nobody is going to throw is
			// better left in play than carried around.
			//
			// What it leaves alone is the ball it was *issued* — a throwing rig's own. `Armed` is what
			// tells the two apart in the same hand: a handed-out ball is armed from the moment it
			// exists, while a caught one is inert until its catcher throws it. An issued ball is kept,
			// because a throwing rig's own behavior is what decides when that one goes, and it is kept
			// knowing the price: while it is held, `attemptCatch` will not open a window at all —
			// the same rule, and the same price, as a player's.
			//
			// **And it runs on every turn of both variants**, which is the reason the ask above is a
			// predicate rather than the whole tick: a gated catcher that decided *not* to catch this
			// window must still put down a ball it caught in the last one, or the next window it does
			// decide on would find its hands full.
			const held = balls.getHeldBall(model);
			if (held && held.GetAttribute("Armed") !== true) balls.dropBall(model);
		},
	};
}

/**
 * The always-on catcher: asks every tick, so its window is open for as long as the rig is alive.
 *
 * **This is the behaviour that was `Behavior_Catching` before the split, unchanged but for its tag.**
 * A rig wearing `Behavior_AlwaysCatching` is a catcher continuously — the "honest way to model a
 * catcher" the old file comment argued for — and the price is the one that made the split necessary:
 * because the window is never closed, a rig wearing this *and* `Behavior_Dodging` can never dodge.
 * That is a rig that should always catch, and the combination is the rule rather than a bug.
 *
 * A predicate that is always `true` is not a placeholder for a missing rule — it *is* the rule for
 * this tag. See {@link makeCatchBehavior} for the body it selects.
 */
export function createAlwaysCatchBehavior(catches: CatchService, balls: BallService): NpcBehavior {
	return makeCatchBehavior(catches, balls, BEHAVIOR_ALWAYS_CATCHING, () => true);
}
