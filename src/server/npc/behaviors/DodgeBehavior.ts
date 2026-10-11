import { BEHAVIOR_DODGING, NpcBehavior } from "../Behavior";
import { NPC_CONFIG } from "shared/config/npc.config";
import { makeDodgeBehavior } from "./AlwaysDodgeBehavior";
import type { DodgeService } from "../../services/actions/DodgeService";
import type { BallService } from "../../services/ball/BallService";

/**
 * Dodging, for an NPC — **the gated variant, worn by `Behavior_Dodging`.**
 *
 * **This is the behaviour that tag has always named, and the split did not change it.** A rig wearing
 * `Behavior_Dodging` dodges a fraction of the balls aimed at it — `NPC_CONFIG.DODGE_CHANCE_PER_BALL`
 * of them — decided once per ball and held, exactly as it did before this file was split in two. That
 * is worth stating plainly because the catch/throw split next door *did* move a stable tag string onto
 * new code, and the question the owner of a place-file rig will ask of this file is "did mine change?"
 * **It did not.**
 *
 * **The chance is the only thing here the always variant does not have**, and it is the reason the
 * split was worth making: before it, a rig that should dodge *everything* could only be expressed by
 * editing the chance — a tuning number for the rigs that should dodge *sometimes* — and turning it up
 * to `1`. Now the two kinds of rig are two tags, and the number stays a number for the kind it
 * describes. See `AlwaysDodgeBehavior.ts` for the other one.
 *
 * The mechanism — the threat test, the per-ball decision held in `pledged`, the escape-direction
 * search, the cooldown — is {@link makeDodgeBehavior}, which both variants share. See that function
 * for the whole design; this file supplies one predicate and nothing else.
 */
export function createDodgeBehavior(dodges: DodgeService, balls: BallService): NpcBehavior {
	return makeDodgeBehavior(dodges, balls, BEHAVIOR_DODGING, () => math.random() < NPC_CONFIG.DODGE_CHANCE_PER_BALL);
}
