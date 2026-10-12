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
 * **Two parameters, and they are two different questions.** `shouldAsk` is *when* this rig wants a
 * window open — a predicate, because one variant asks every turn while the other owns a decision and a
 * clock. `dropCaught` is *whether a ball it is holding goes back down*, and that one is a boolean
 * because there are only two answers and one belongs to each rig.
 *
 * **Why the drop is a question at all, and why the answer changed.** The tail was written for a
 * catcher and nothing else: catch a ball, put it down, catch the next one — because a catch needs a
 * free hand, so a catcher that kept its catches could never catch again. That reasoning holds for
 * `Behavior_AlwaysCatching`, which *is* a pure catcher, and it does **not** hold for `Behavior_Catching`
 * — the tag the lobby placeholders wear. Those rigs wear `Behavior_Pickup` and `Behavior_Throwing` as
 * well, and the thing that empties their hand is the throw, so dropping on every tick was not a rule
 * applied to them; it was the always catcher's rule applied to a rig that is not one. Its cost was
 * exact: a rig picked a loose ball up, and the catcher's next tick put it straight back down, twice a
 * second, for the whole round — never far enough from the ball to walk, never holding one long enough to
 * throw. See `dropCaught`'s use in the tick for the two cases side by side.
 */
export function makeCatchBehavior(
	catches: CatchService,
	balls: BallService,
	tag: string,
	dropCaught: boolean,
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

			// **The hand rule, and it is the one thing the two variants disagree about.**
			//
			// `dropCaught` **true** — the always catcher, which is a catcher and nothing else. Whatever it
			// has just taken out of the air goes straight back down, for the reason that behaviour has
			// always had: a catch needs a free hand (`attemptCatch` refuses an occupied one, and a caught
			// ball counts as much as an armed one), so a catcher that keeps its catches can never catch
			// again — and a ball nobody is going to throw is better left in play than carried around.
			//
			// `dropCaught` **false** — the gated catcher, and the rigs that wear it are the lobby
			// placeholders. They keep what they catch, because **the throw is what empties their hand**:
			// they wear `Behavior_Throwing` beside this, they hold a ball only until they have a target in
			// front of them, and dropping on a timer instead produced a rig that put a ball down two ticks
			// after picking it up — never walking (it never left the ball), never throwing (its hand was
			// empty half the time), and reading in the log as a rig that follows balls around. See the
			// factory's doc for the whole of that.
			//
			// **The price of keeping, named because it is a real way to lose a mechanic.** A rig wearing
			// this tag and *not* `Behavior_Throwing` takes one ball and keeps it for the rest of the
			// round: it cannot catch again (no free hand), it cannot pick another up (the same rule), and
			// nothing in this file will ever put it down. Every rig this game spawns wears the pair —
			// `LobbyRigService`'s six-tag set has both — so what the trade buys is a placeholder that
			// plays, against a hand-tagged rig that was already a catcher and is now a catcher holding
			// one ball. It used to put the ball down; it does not any more.
			//
			// **What neither answer touches: an *issued* ball.** `Armed` is what tells the two apart in
			// the same hand — a handed-out ball is armed from the moment it exists, while a caught or
			// picked-up one is inert until its holder throws it. An armed ball is never dropped here,
			// under either answer, because a throwing rig's own behaviour is what decides when that one
			// goes; and it is kept knowing the price, which is that while it is held `attemptCatch` will
			// not open a window at all — the same rule, and the same price, as a player's.
			if (dropCaught) {
				const held = balls.getHeldBall(model);
				if (held && held.GetAttribute("Armed") !== true) balls.dropBall(model);
			}
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
 * **The two arguments it passes are both "the old behaviour", and neither is inherited by the gated
 * variant.** A predicate that is always `true` is not a placeholder for a missing rule — it *is* the rule
 * for this tag, which is a window held open continuously — and `true` for `dropCaught` is the drop tail
 * this behaviour has always had, which is precisely what lets a pure catcher catch twice in a row. See
 * {@link makeCatchBehavior} for the body both of them select.
 */
export function createAlwaysCatchBehavior(catches: CatchService, balls: BallService): NpcBehavior {
	return makeCatchBehavior(catches, balls, BEHAVIOR_ALWAYS_CATCHING, true, () => true);
}
