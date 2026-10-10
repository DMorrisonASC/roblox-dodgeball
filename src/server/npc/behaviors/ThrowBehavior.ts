import { ThrowArc } from "shared/Trajectory";
import { BEHAVIOR_THROWING, NpcBehavior } from "../Behavior";
import type { BallService } from "../../services/ball/BallService";

/**
 * How far in front of itself an NPC aims, in studs.
 *
 * A direction is not a throw: the solve takes a *point*, and the only point an
 * NPC has to offer is "straight ahead of wherever it is facing". This is the
 * stand-in for aim. Replacing it — with the nearest player's torso, say — is a
 * change to this file alone.
 */
const THROW_RANGE = 60;

/**
 * Which arc an NPC throws. Straight is the plain default; a real aim is what would choose.
 *
 * **A rig is the only thing in the game that still names an arc.** A player's throw is charged — a heading
 * and a hold, with no point in it at all — so `overhead`, `straight` and `curve` survive here, where there
 * really is a target and a choice of how to reach it. This constant is therefore the whole of what selects
 * between them, which makes it the line to change if a rig should arc a ball instead of driving it.
 */
const THROW_ARC: ThrowArc = "straight";

/**
 * Throwing, for an NPC.
 *
 * The ball leaves the hand through `BallService.throwBall` and nothing else, so
 * an NPC's throw *is* a throw with a different direction in it: the same weld release,
 * the same token stamped at release and the same hand of gates — with one difference that
 * is worth knowing at this call site, which is that the *solve* is a different function from a player's.
 * A rig has a point to reach and asks for a throw at it; a player has a heading and a hold and asks for a
 * throw along it. Both are in `shared/throw.ts`, and the request below says which one this is.
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
			// Empty hand: take another ball, by the same call `prepare` made the first
			// time. A throwing rig is one of the only two things in the game that is
			// never left without one — the other is a dev with `InfiniteBalls` — and this
			// is where that lives. It is a *behavior* asking, rather than the throw
			// handing a ball back to everybody who throws one.
			if (!balls.getHeldBall(model)) {
				balls.giveBall(model);
				return;
			}

			const root = model.FindFirstChild("HumanoidRootPart");
			if (!root || !root.IsA("BasePart")) return;

			const target = root.Position.add(root.CFrame.LookVector.mul(THROW_RANGE));

			// **The `aimed` kind, which is the one a caller with a point in mind uses.** It is tagged rather
			// than inferred because `BallService.throwBall` accepts both kinds and a target handed to the
			// charged solve would be a distance — see `ThrowRequest` in `shared/throw.ts`, which is where that
			// argument lives in full.
			balls.throwBall(model, { kind: "aimed", target: target, arc: THROW_ARC });
		},
	};
}
