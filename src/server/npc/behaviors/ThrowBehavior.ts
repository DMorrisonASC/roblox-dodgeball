import { ThrowArc } from "shared/Trajectory";
import { BEHAVIOR_THROWING, NpcBehavior } from "../Behavior";
import type { BallService } from "../../services/BallService";

/**
 * How far in front of itself an NPC aims, in studs.
 *
 * A direction is not a throw: the solve takes a *point*, and the only point an
 * NPC has to offer is "straight ahead of wherever it is facing". This is the
 * stand-in for aim. Replacing it — with the nearest player's torso, say — is a
 * change to this file alone.
 */
const THROW_RANGE = 60;

/** Which arc an NPC throws. Straight is the plain default; a real aim is what would choose. */
const THROW_ARC: ThrowArc = "straight";

/**
 * Throwing, for an NPC.
 *
 * The ball leaves the hand through `BallService.throwBall` and nothing else, so
 * an NPC's throw *is* a player's throw with a different direction in it: the
 * same solve, the same plan, the same weld release and the same token stamped at
 * release.
 *
 * `tickInterval` is what paces the throws. It is deliberately slower than the
 * catching behavior's, so a rig that both catches and throws has time to be hit
 * between its own throws.
 */
export function createThrowBehavior(balls: BallService): NpcBehavior {
	return {
		tag: BEHAVIOR_THROWING,
		tickInterval: 5.0,

		// A rig that throws needs something to throw, and it gets it by the same call
		// a player's character is given a ball by. Declared here, not in `NpcService`,
		// so the next throwing mechanic asks for its own ball the same way and the tag
		// runner never has to know what a ball is.
		prepare(model) {
			balls.giveBall(model);
		},

		tick(model) {
			// An empty hand has nothing to throw. `throwBall` checks again before it
			// does anything — a behavior is allowed to be wrong about this, and the
			// service is where that has to be caught.
			if (!balls.getHeldBall(model)) return;

			const root = model.FindFirstChild("HumanoidRootPart");
			if (!root || !root.IsA("BasePart")) return;

			const target = root.Position.add(root.CFrame.LookVector.mul(THROW_RANGE));

			balls.throwBall(model, target, THROW_ARC);
		},
	};
}
