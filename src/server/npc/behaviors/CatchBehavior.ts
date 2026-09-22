import { BEHAVIOR_CATCHING, NpcBehavior } from "../Behavior";
import type { BallService } from "../../services/BallService";
import type { CatchService } from "../../services/CatchService";

/**
 * Catching, for an NPC.
 *
 * A catch *attempt* is only ever an attempt: asking opens a window, and the ball
 * that arrives inside it is the one caught. So the honest way to run this on a
 * timer is to keep asking, which is what holds a window open continuously — an
 * NPC with its hands ready is a catcher, and it still has to be hit on the torso
 * or the arms to take the ball.
 *
 * Nothing here decides whether a catch happens. `CatchService` owns the window,
 * its expiry and its consumption, so an attempt from an NPC runs the exact code
 * a keypress from a player does; this function only knows how to ask.
 *
 * A catcher is not a keeper, though. What it takes out of the air goes back on
 * the ground — see the drop in `tick` below.
 */
export function createCatchBehavior(catches: CatchService, balls: BallService): NpcBehavior {
	return {
		tag: BEHAVIOR_CATCHING,

		// Well under `CATCH_CONFIG.WINDOW_SECONDS` on purpose. The window is refreshed by asking,
		// so this period is how stale a window can get between refreshes — not how
		// long a catcher is allowed to catch for, which stays the window's job.
		tickInterval: 0.1,

		tick(model) {
			catches.attemptCatch(model);

			// Whatever it has just taken out of the air goes straight back down.
			//
			// Two reasons, and both come from the hand being one slot: a catcher that
			// keeps its catches can never catch twice, because the next catch destroys
			// the ball already sitting in that hand; and a ball nobody is going to throw
			// is better left in play than carried around.
			//
			// What it leaves alone is the ball it was *issued* — a throwing rig's own.
			// `Armed` is what tells the two apart in the same hand: a handed-out ball is
			// armed from the moment it exists, while a caught one is inert until its
			// catcher throws it.
			const held = balls.getHeldBall(model);
			if (held && held.GetAttribute("Armed") !== true) balls.dropBall(model);
		},
	};
}
