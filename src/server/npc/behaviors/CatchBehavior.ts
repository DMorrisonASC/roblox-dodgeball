import { BEHAVIOR_CATCHING, NpcBehavior } from "../Behavior";
import { NPC_CONFIG } from "shared/config/npc.config";
import { detectThreat } from "../detect";
import { makeCatchBehavior } from "./AlwaysCatchBehavior";
import type { BallService } from "../../services/ball/BallService";
import type { CatchService } from "../../services/actions/CatchService";

/**
 * What one rig has decided about catching, and for how long.
 *
 * **One row per rig, replaced when its clock runs out, and that is the whole of the state.** It is
 * the shape `DodgeBehavior`'s `pledged` map already has and for the same reason: the decision is
 * about a *stretch of time*, not about a turn, so the answer has to survive across turns — and the
 * tempting alternative, re-rolling every tick, is exactly the bug this file exists to avoid.
 */
interface CatchDecision {
	/** `os.clock` seconds at which this decision stops counting and is re-rolled. */
	until: number;

	/** Whether this rig is a catcher for the life of this decision. See `NPC_CONFIG.CATCH_CHANCE`. */
	willCatch: boolean;

	/**
	 * Whether this decision has already produced its one ask.
	 *
	 * **The flag that makes the roll mean what it says.** Without it the rig would ask on *every*
	 * turn of a `willCatch` decision, and each ask refreshes the catch window — so a decision that
	 * lasted a window would hold the window open for as long as it lasted, and a run of them would
	 * leave it open continuously. One ask per decision keeps the window `CATCH_CONFIG.WINDOW_SECONDS`
	 * long *because one ask opened it*, which is what lets a `willCatch = false` decision actually
	 * leave a gap. See the file comment for the arithmetic.
	 */
	asked: boolean;
}

/**
 * Catching, for an NPC — **the gated variant, worn by `Behavior_Catching`.**
 *
 * **The bug this is built not to repeat, because it is the one `DodgeBehavior` already paid for.**
 * That behaviour's chance started life as a *rate per second*, scaled by the tick into a chance per
 * turn — and a rate scaled per turn compounds over a flight, so "1" read as "always dodges" while
 * actually dodging about 40 % of the balls aimed at it. The number was measuring exposure while
 * everybody read it as a percentage. This file was asked to "decide once if model will catch rather
 * than per ticks" for exactly that reason: **a 50 % roll at 10 Hz is not a 50 % catcher, it is a
 * window that is open ~97 % of any half-second**, and the fix in both places is the same — roll once
 * per decision, hold the answer for the whole of it.
 *
 * **The cadence, and why it is a window and not a tick.** A decision lives
 * `NPC_CONFIG.CATCH_DECISION_SECONDS`, which is one `CATCH_CONFIG.WINDOW_SECONDS` — the length of the
 * window a `willCatch` decision opens. So a `true` decision asks once and hides behind an open window
 * for its whole life; a `false` decision asks not at all, and the window from the last `true` lapses
 * one window later. Rolled twice, that is one window open and one shut, i.e. **the time-share equals
 * the chance** — at `CATCH_CHANCE = 0.5` the window is genuinely open about half the timeline, not
 * "almost always".
 *
 * **One ask per decision, not one per tick, is what makes that arithmetic hold** — see
 * {@link CatchDecision.asked}. Answering the temptation to "keep the window up while the decision is
 * true" would put the open and shut windows end to end and leave no gap at all.
 *
 * **A ball in the detection radius, or the rig does not bother.** The `willCatch` decision says the
 * rig *would* catch; `detectThreat` says whether there is anything to catch. Asking only when a ball
 * is near is what stops a rig holding its window open across an empty arena — a window that catches
 * nothing but starves a sibling `Behavior_Dodging` all the same, because the dodge is refused while
 * the window is open wherever it came from.
 *
 * **And that is the whole of the coordination with the dodge: the window is the arbiter.** There is
 * no shared roll and no priority table between the two behaviours, and none is needed — a rig wearing
 * both `Behavior_Catching` and `Behavior_Dodging` catches in the windows this file opens and dodges
 * in the gaps it leaves, because `DodgeService.blocksDodge` refuses the dodge the moment a window is
 * open. **This does not bypass that gate and must not**: the ask goes through
 * `CatchService.attemptCatch`, the same call a player's keypress makes, so every rule the service
 * owns — the freeze, the free hand, the dodge lockout — still holds. What changed is only *how often*
 * a rig asks, and the combination that used to be "a catcher that never dodges" is now a rig that
 * does both, in turns.
 *
 * The variant that asks every tick is `Behavior_AlwaysCatching`, in `AlwaysCatchBehavior.ts`; the two
 * share this body and differ in the predicate below.
 *
 * **And in one other argument: this variant does not drop what it catches.** `makeCatchBehavior`'s
 * `dropCaught` is `false` here and `true` for its sibling, and the reason is the rig rather than the tag
 * — the lobby placeholders wear `Behavior_Pickup` and `Behavior_Throwing` beside this one, so **the
 * throw is what empties their hand**, and the always catcher's drop-on-every-tick rule was putting a ball
 * back on the floor two ticks after the pickup that fetched it. A rig wearing this tag and *not* a
 * thrower keeps its one ball for the rest of the round and stops playing; that price is argued where the
 * rule lives, in `AlwaysCatchBehavior`'s tick.
 */
export function createCatchBehavior(catches: CatchService, balls: BallService): NpcBehavior {
	/**
	 * One row per rig. **Never cleared, and that is `DodgeBehavior`'s argument rather than an
	 * oversight**: a destroyed rig never ticks again, so its row is never read again either, and each
	 * new rig overwrites its own. A `Map` rather than a `WeakMap` because that is what every other
	 * per-rig table in this directory uses, and the number of live rigs is small.
	 */
	const decisions = new Map<Model, CatchDecision>();

	/**
	 * Whether this rig should ask this turn: **once per decision, and only if it decided to catch
	 * and has something to catch.**
	 */
	const shouldAsk = (model: Model, now: number): boolean => {
		let decision = decisions.get(model);

		if (decision === undefined || now >= decision.until) {
			decision = {
				until: now + NPC_CONFIG.CATCH_DECISION_SECONDS,
				willCatch: math.random() < NPC_CONFIG.CATCH_CHANCE,
				asked: false,
			};

			decisions.set(model, decision);
		}

		if (!decision.willCatch || decision.asked) return false;

		// Widened to the whole decision when a ball turns up, rather than being lost if none was near
		// on the turn the decision was made: the decision says the rig is willing to catch, and this
		// is it noticing something worth catching. `asked` is set here, where the ask really happens,
		// so a decision that never saw a ball stays live for the rest of its window.
		if (detectThreat(model, balls) === undefined) return false;

		decision.asked = true;

		return true;
	};

	return makeCatchBehavior(catches, balls, BEHAVIOR_CATCHING, false, shouldAsk);
}
