import { BEHAVIOR_ALWAYS_CATCHING, NpcBehavior } from "../Behavior";
import { makeCatchBehavior } from "./CatchBehavior";
import type { BallService } from "../../services/ball/BallService";
import type { CatchService } from "../../services/actions/CatchService";

/**
 * The always-on catcher: **it asks on every tick, so its window is open for as long as the rig lives.**
 *
 * **This file is the wrapper; `CatchBehavior.ts` is the body.** That is the rule these pairs are laid
 * out by — the base file holds the implementation and the `Always*` file extends it — and it is stated
 * here rather than only in the base because a reader who arrives by the file name should be told in one
 * sentence that everything they came for is one import away. This used to be the other way round; see
 * `CatchBehavior.ts` for why it was reversed.
 *
 * **The two arguments it passes are both "the old behaviour", and neither is inherited by the gated
 * tag.** A predicate that is always `true` is not a placeholder for a missing rule — it *is* the rule
 * for this tag, which is a window held open continuously — and `true` for `dropCaught` is the drop tail
 * this behaviour has always had, which is precisely what lets a pure catcher catch twice in a row. See
 * {@link makeCatchBehavior} for the body both of them select.
 *
 * **What "always" costs, and it is the reason the split exists.** Because the window is never closed, a
 * rig wearing this *and* `BEHAVIOR_DODGING` can never dodge — `DodgeService.blocksDodge` refuses a dash
 * while a window is open, wherever the window came from. That is a rig that should always catch, so the
 * combination is the rule rather than a bug, and it is the whole of the difference this tag has against
 * `Behavior_Catching`, whose window genuinely closes.
 */
export function createAlwaysCatchBehavior(catches: CatchService, balls: BallService): NpcBehavior {
	return makeCatchBehavior(catches, balls, BEHAVIOR_ALWAYS_CATCHING, true, () => true);
}
