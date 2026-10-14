import { chargeForRange, getThrowMuzzle } from "shared/throw";
import { BEHAVIOR_ALWAYS_THROWING, NpcBehavior } from "../Behavior";
import { THROW_TICK_SECONDS, WINDUP_GAP_TURNS, createWindupTracker } from "./ThrowBehavior";
import type { BallService } from "../../services/ball/BallService";

/**
 * How far in front of itself an NPC throws, in studs.
 *
 * **A stand-in for aim, not a throw setting.** This behaviour has no target and never had one: a
 * practice rig throws whether or not anybody is there, and "straight ahead of wherever it is facing"
 * is the only direction it can name. So this is the *distance* half of an aim, and the throw's own
 * half comes from the config every other throw reads — see the tick below, which turns this distance
 * into the same charge a player's hold would have produced at it. It is not a speed, not an arc and
 * not a ceiling: change it and the rig still throws the game's throw, only aimed at a different point
 * ahead.
 *
 * Replacing it — with the nearest player's torso, say — is a change to this file alone, and that is
 * the whole of what makes this the practice variant.
 */
const THROW_RANGE = 60;

/**
 * How often this rig **decides** to throw, in seconds. **Placeholder — 5, which is the number `tickInterval`
 * used to hold.**
 *
 * **A pace of its own, because the tick can no longer be the pace.** This behaviour was `tickInterval: 5.0`, and
 * the tick *was* the timer: it decided and released in one turn, so a five-second tick was a throw every ten
 * seconds (the hand is refilled on one turn and thrown on the next — see the tick, where the empty hand is
 * checked first). A windup cannot work that way: the hold has to be *watched*, and a rig whose turns are five
 * seconds apart would either fire on the same turn it decided — no hold at all — or hold for five seconds, which
 * is not `charge × CHARGE_SECONDS` and would put a five-second looping effect on a practice dummy. So the
 * cadence moved here and the tick moved onto the shared tenth.
 *
 * **What that changes, stated rather than discovered.** The decision is still every five seconds, but the release
 * now follows after the hold instead of on the frame of the decision, so the period is one interval *plus* one
 * windup — about 5.8 seconds rather than the ten a five-second tick with a refill turn produced. That is a real
 * change to how often a practice rig throws, it is the same for every charge this rig can produce (`THROW_RANGE`
 * is fixed), and the number to move is this one: raise it by the old gap's worth — roughly 8.5 — to have a dummy
 * that throws as rarely as it did before.
 */
const DECISION_SECONDS = 5.0;

/**
 * Throwing, for an NPC — **the always-on variant, worn by `Behavior_AlwaysThrowing`.**
 *
 * **This is the behaviour that was `Behavior_Throwing` before the split, preserved.** A rig wearing it
 * is issued a ball at spawn (`prepare`) and refills its own hand whenever a throw empties it, then
 * throws straight ahead on a slow timer — an NPC that throws whether or not there is anything to
 * throw at. That is the honest model of "a rig that throws", and it is what a practice dummy wants;
 * the variant that picks a target and turns to face it is `Behavior_Throwing` in `ThrowBehavior.ts`.
 *
 * The ball leaves the hand through `BallService.throwBall` and nothing else, so an NPC's throw *is* a
 * throw with a different direction in it: the same weld release, the same token stamped at release, the
 * same hand of gates, and — since the rigs moved onto the charged arm — the same *solve*. A rig has no
 * button to hold, so the one thing it works out for itself is the hold: it knows the distance it is
 * throwing and asks `chargeForRange` which charge covers it. Everything downstream of that is the throw
 * a player makes.
 *
 * **The hold is the same hold the gated thrower takes**, and that is the point of the pair: this rig has no
 * target and never had one, so the only thing a windup can do for it is make its throw *visible* for as long as
 * the charge it is throwing takes — exactly as it does for a rig that had to find somebody first. The mechanism
 * is `ThrowBehavior`'s (`createWindupTracker`), built fresh here so the two behaviours keep separate tables, and
 * the only difference between the two holds is which ways out of one exist: this rig has no target to lose, so
 * its hold ends by throwing, by dying, by the round being switched off, or by the expiry that covers a rig that
 * stops being ticked at all.
 *
 * `tickInterval` is the shared windup cadence rather than the pace; {@link DECISION_SECONDS} is the pace, and it
 * is still deliberately slower than the catching behavior's, so a rig that both catches and throws has time to be
 * hit between its own throws.
 */
export function createAlwaysThrowBehavior(balls: BallService): NpcBehavior {
	/** This rig's holds. See `createWindupTracker` — the mechanism is the gated thrower's, not a copy of it. */
	const windups = createWindupTracker();

	/**
	 * When each rig is next allowed to decide to throw, in `os.clock` seconds.
	 *
	 * **The pace, which a tick interval can no longer express** — see {@link DECISION_SECONDS}. A row is made the
	 * first time a rig is seen holding a ball and re-armed at every release, so the interval is measured from one
	 * throw to the next decision rather than from the spawn. Never cleared, like every other per-rig table in this
	 * directory: a destroyed rig never ticks again, and a replaced body is a new model.
	 */
	const nextDecisionAt = new Map<Model, number>();

	return {
		tag: BEHAVIOR_ALWAYS_THROWING,
		tickInterval: THROW_TICK_SECONDS,

		// A rig that throws needs something to throw, and it gets it by the same call
		// a player's character is given a ball by. Declared here, not in `NpcService`,
		// so the next throwing mechanic asks for its own ball the same way and the tag
		// runner never has to know what a ball is.
		//
		// **The gated variant does not do this, and that is the difference between the two tags.**
		// `Behavior_Throwing` relies on `Behavior_Seeking` and `Behavior_Pickup` to have put a ball in
		// the rig's hand, which is what makes it throw at a target it had to go and find; this one is
		// handed a ball so it can throw on a timer regardless.
		prepare(model) {
			balls.giveBall(model);
		},

		tick(model) {
			const now = os.clock();

			// Empty hand: take another ball, by the same call `prepare` made the first
			// time. A throwing rig is one of the only two things in the game that is
			// never left without one — the other is a dev with `InfiniteBalls` — and this
			// is where that lives. It is a *behavior* asking, rather than the throw
			// handing a ball back to everybody who throws one.
			//
			// **And a hold cannot outlive the hand that was holding it**, for the gated variant's reason: a ball
			// that is gone means there is nothing to release, and a windup left standing would fire a throw that
			// cannot happen and keep its charge published on a body with an empty hand.
			if (!balls.getHeldBall(model)) {
				windups.cancelWindup(model, "the ball left the hand");
				balls.giveBall(model);

				return;
			}

			const root = model.FindFirstChild("HumanoidRootPart");
			if (!root || !root.IsA("BasePart")) return;

			const windup = windups.get(model);

			if (windup !== undefined) {
				// **The freeze, the same way the gated thrower sees it** — as turns that did not happen. A rig
				// frozen mid-hold is not ticked at all, so a deadline that has passed by the time it thaws would
				// release a throw with nothing having moved it, and the whole point of holding is that it can be
				// taken away. See `WINDUP_GAP_TURNS`.
				if (now - windup.lastTurnAt > THROW_TICK_SECONDS * WINDUP_GAP_TURNS) {
					windups.cancelWindup(model, "the turns stopped — frozen");

					return;
				}

				windup.lastTurnAt = now;

				// Still holding: the release is a later turn, and that is the whole of the hold.
				if (now < windup.until) return;

				windups.endWindup(model);

				// **The heading is the facing, flattened, because a rig with no target has nothing else to go
				// on.** The flattening is not required by the solve — `planChargedThrow` projects a heading onto
				// the ground plane and takes its compass direction, so the vertical part of a `LookVector` that
				// follows a slope never reaches the throw — but it is what makes the vector printed below the same
				// vector the *distance* was measured along, which is the pair this behaviour has to be honest
				// about.
				//
				// **Asked again here rather than carried from the decision, and the two differ on purpose.** A
				// rig with no target cannot lose one, but it can *turn*: the facing is the only thing this throw
				// is aimed by, so releasing along the facing of the decision turn would be a rig throwing where it
				// used to be looking. The charge, which is measured from the hand and does not move with a turn,
				// is the half that is carried — see `windup.charge`.
				const heading = new Vector3(root.CFrame.LookVector.X, 0, root.CFrame.LookVector.Z);

				const thrown = balls.throwBall(model, {
					kind: "charged",
					heading,
					charge: windup.charge,
					curve: false,
				});

				// Re-armed on every release rather than on every decision, so a hold that was cancelled or expired
				// costs the rig a decision rather than a whole interval of standing still with a ball in hand.
				nextDecisionAt.set(model, now + DECISION_SECONDS);

				// **Logged once per throw**, in the shape `ThrowBehavior` logs, so the two rig behaviours can be
				// read against each other and against a player's `[Throw]` line. See that file for why the charge
				// and the distance are the two fields worth printing, and why nothing about the flight is repeated
				// here.
				if (thrown) {
					print(
						`[Rig] ${model.Name}: throw — charge ${string.format("%.2f", windup.charge)} at ` +
							`${string.format("%.1f", THROW_RANGE)} studs, heading ` +
							`(${string.format("%.2f", heading.X)}, ${string.format("%.2f", heading.Y)}, ` +
							`${string.format("%.2f", heading.Z)})`,
					);
				}

				return;
			}

			// **Not holding: is it time to decide?** The first answer is made rather than read, so a rig handed a
			// ball at spawn waits one interval before its first throw instead of throwing on its first turn — which
			// is what a five-second tick gave it for free and what a tenth-of-a-second tick would otherwise take
			// away.
			const due = nextDecisionAt.get(model);
			if (due === undefined) {
				nextDecisionAt.set(model, now + DECISION_SECONDS);

				return;
			}

			if (now < due) return;

			// **The charge is the same inverse a target-picking rig uses**, which is what makes this
			// behaviour and `ThrowBehavior` two ways of *aiming* one throw rather than two throws. The numbers
			// going in are a horizontal distance and a rise and nothing else: no speed, no arc, no ceiling of
			// its own.
			//
			// **The rise is where this rig's own hips sit, because there is no enemy to measure.** The
			// stand-in target is `THROW_RANGE` studs in front of the hand at the height a body standing on the
			// same floor would carry its root — and the ball leaves at head height, so this is a throw angled
			// down, exactly as `ThrowBehavior`'s is. Leaving the rise at its default of `0` is what a level
			// throw would be, and it flies the ball about a fifth long, which on a practice rig is a rig that
			// cannot hit the thing it is pointed at.
			//
			// **And this changes this behaviour's ball, for the better.** What stood here was the aimed throw
			// on a `straight` arc, whose solve is capped at the speed ceiling: at the flat launch angle that
			// cap reaches about thirty-four studs, so a rig told to throw sixty studs ahead landed its ball
			// barely half way and nothing anywhere said so. A charge is not capped away from its own distance
			// until the distance is past the envelope, so this now does what the constant above says it does.
			//
			// **Solved here, on the turn that decides, and then held** — the charge and the distance both, so the
			// hold lasts exactly as long as the throw it is for takes. See `Windup` in `ThrowBehavior.ts` for why
			// the pair has to come off one turn, and `createWindupTracker.beginWindup` for what the hold does with
			// them.
			const muzzle = getThrowMuzzle(model);
			windups.beginWindup(model, chargeForRange(THROW_RANGE, root.Position.Y - muzzle.Y), THROW_RANGE);
		},

		// **A hold dies with the rig holding it**, for the gated thrower's reason: a corpse is not winding up a
		// throw, the charge has to come off the body rather than sitting there for `RESPAWN_DELAY_SECONDS`, and
		// the row has to go because nothing will tick this rig again.
		onDied(model) {
			windups.cancelWindup(model, "the rig died");
		},
	};
}
