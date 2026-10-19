import { BEHAVIOR_ALWAYS_DODGING, NpcBehavior } from "../Behavior";
import { makeDodgeBehavior } from "./DodgeBehavior";
import type { DodgeService } from "../../services/actions/DodgeService";
import type { BallService } from "../../services/ball/BallService";

/**
 * The always-on dodger: **it answers yes to every ball it can move away from.**
 *
 * **This file is the wrapper; `DodgeBehavior.ts` is the body.** That is the rule these pairs are laid
 * out by — the base file holds the implementation and the `Always*` file extends it — and the reason it
 * is worth stating in the wrapper rather than only in the base is that a reader who arrives here by the
 * file name should be told in one sentence that they are about to import everything they came for. This
 * used to be the other way round, with the body here and the gated tag as a one-line wrapper; see
 * `DodgeBehavior.ts` for why that was reversed.
 *
 * **What this one answer means.** A rig wearing `Behavior_AlwaysDodging` is the dummy that is meant to
 * be evasive: it commits to every ball it can move away from, without touching the shared chance that
 * governs the rigs which dodge only sometimes. It is not "dodges five times a second" —
 * `DodgeService` refuses a dodge inside `DODGE_CONFIG.COOLDOWN`, which the body also pre-checks — so
 * "always" means **always tries**, and a second ball arriving within 1.5 s of a successful dodge finds
 * the rig walking rather than dashing. See {@link makeDodgeBehavior} for what that walk is and for the
 * whole of the body both tags share.
 *
 * A predicate that is always `true` is not a placeholder for a missing rule — it *is* the rule for this
 * tag. The sibling's answer is the coin-flip in `NPC_CONFIG.DODGE_CHANCE_PER_BALL`.
 */
export function createAlwaysDodgeBehavior(dodges: DodgeService, balls: BallService): NpcBehavior {
	return makeDodgeBehavior(dodges, balls, BEHAVIOR_ALWAYS_DODGING, () => true);
}
