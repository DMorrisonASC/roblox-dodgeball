import { BEHAVIOR_CATCHING, NpcBehavior } from "../Behavior";
import { NPC_CONFIG } from "shared/config/npc.config";
import { detectThreat } from "../detect";
import type { BallService } from "../../services/ball/BallService";
import type { CatchService } from "../../services/actions/CatchService";

/**
 * Catching, for an NPC — **and the two ways to ask for it.**
 *
 * A catch *attempt* is only ever an attempt: asking opens a window, and the ball that arrives inside
 * it is the one caught. So the honest way to run this on a timer is to ask, and the rule that decides
 * *when* to ask is the whole difference between the two tags this file serves:
 *
 * - **`Behavior_Catching`** asks only when a 50 %-per-window decision says this rig is a catcher *and*
 *   a ball is in its detection radius. The decision is re-rolled on a coarse cadence rather than every
 *   tick, which is what leaves the window **closed** for roughly half the timeline — and a closed
 *   window is what a sibling `Behavior_Dodging` needs, because an open one refuses a dodge outright
 *   (`DodgeService.blocksDodge`). It is the tag this file is named for.
 * - **`Behavior_AlwaysCatching`** asks on every tick, which holds a window open continuously — an NPC
 *   with its hands ready is a catcher, and it still has to be hit on the torso or the arms to take the
 *   ball. This is the behaviour that predates the split, preserved exactly, and it is the thin file
 *   next door: `AlwaysCatchBehavior.ts`.
 *
 * **Why one tick body and two factories, rather than two files that each carry this essay.** The two
 * variants differ in exactly one line — whether `attemptCatch` is called this turn — and everything
 * around it (the interval, the free-hand rule, the drop-if-not-armed tail) is identical. Two copies
 * of that would be two places to fix the next time the hand rule changes. So the body is one function,
 * parameterised by a `shouldAsk` predicate, and each tag is a factory that supplies its own predicate.
 * {@link makeCatchBehavior} is the internal factory; the two `create*` functions are the only things
 * `NpcService` should see.
 *
 * **The body lives in the file named for the tag that is *not* the special case, and that is a
 * reversal.** It used to live in `AlwaysCatchBehavior.ts`, with the gated tag as a wrapper in this file
 * — so the file named for the common case held nothing to read, and the file holding everything was
 * named for the exception. **The rule, and it is the same one the dodge pair follows: the base file
 * holds the body, and the `Always*` file is the wrapper that extends it.** So {@link makeCatchBehavior}
 * is here, `createCatchBehavior` is here beside it with the decision machinery the gated tag owns, and
 * `AlwaysCatchBehavior.ts` imports this file and supplies nothing but `true, () => true`.
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
 * Catching, for an NPC — **the gated tag, `Behavior_Catching`, and the decision machinery it owns.**
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
 * share the body above and differ in the predicate below.
 *
 * **And in one other argument: this variant does not drop what it catches.** `makeCatchBehavior`'s
 * `dropCaught` is `false` here and `true` for its sibling, and the reason is the rig rather than the tag
 * — the lobby placeholders wear `Behavior_Pickup` and `Behavior_Throwing` beside this one, so **the
 * throw is what empties their hand**, and the always catcher's drop-on-every-tick rule was putting a ball
 * back on the floor two ticks after the pickup that fetched it. A rig wearing this tag and *not* a
 * thrower keeps its one ball for the rest of the round and stops playing; that price is argued where the
 * rule lives, in `makeCatchBehavior`'s tick.
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
