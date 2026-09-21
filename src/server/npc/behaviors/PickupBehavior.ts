import { BEHAVIOR_PICKUP, NpcBehavior } from "../Behavior";
import type { BallPickupService } from "../../services/BallPickupService";
import type { BallService } from "../../services/BallService";

/**
 * Picking loose balls up, for an NPC.
 *
 * A rig that collects what has been thrown at it and thrown past it: the same
 * action a player performs on a ball's prompt, asked for on a timer like every
 * other behavior here. Nothing about *which* ball is decided here — the search,
 * the reach and the refusals are `BallPickupService`'s, and the weld is
 * `BallService`'s. This only knows when to ask.
 *
 * Note it composes with the others rather than replacing them: a rig with
 * throwing and pickup tags holds an issued ball nearly all the time, so it
 * collects only when a throw has emptied its hand.
 */
export function createPickupBehavior(pickups: BallPickupService, balls: BallService): NpcBehavior {
	return {
		tag: BEHAVIOR_PICKUP,
		tickInterval: 0.3,

		tick(model) {
			// A full hand means nothing to do — and worth asking before the search,
			// which walks every tagged ball in the game. `pickupNearest` would reach
			// the same answer, but only after doing that walk, several times a second.
			if (balls.getHeldBall(model)) return;

			pickups.pickupNearest(model);
		},
	};
}
