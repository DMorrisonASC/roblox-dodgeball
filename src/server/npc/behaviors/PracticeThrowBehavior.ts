import { Workspace } from "@rbxts/services";
import { pendingAbilityOn } from "shared/ability";
import { NPC_CONFIG } from "shared/config/npc.config";
import { NEXT_THROW_AT_ATTRIBUTE, PENDING_ABILITY_ATTRIBUTE, PRACTICE_THROW_TAG } from "shared/constants";
import { NpcBehavior } from "../Behavior";
import { rigBayGap, targetFor } from "../practiceBay";
import { THROW_TICK_SECONDS, WINDUP_GAP_TURNS, createWindupTracker } from "./ThrowBehavior";
import type { BallService } from "../../services/ball/BallService";

/**
 * **How small a flattened vector may be before this file treats it as having no direction at all.**
 *
 * The same figure `ThrowBehavior` and `AlwaysThrowBehavior` use privately for their own aims. Duplicated rather than
 * exported for the reason those two give: it is a comparison tolerance and not a setting, and a shared constant would
 * invite somebody to tune one file's aim by changing it.
 */
const FLAT_EPSILON = 0.001;

/**
 * **How much a published deadline may drift before it is rewritten, in seconds.**
 *
 * `NEXT_THROW_AT_ATTRIBUTE` is replicated, so an unconditional write per tick would be ten network writes a second
 * per drill rig to publish a number that only changes three times a cycle. A tenth of a second is smaller than any
 * change worth showing and larger than the rounding in a `GetServerTimeNow` sample — which matters because
 * {@link publishDeadline} converts a *duration* into an instant on every call, so two calls a tick apart produce two
 * figures that are never quite equal. This is what keeps that from becoming a write.
 */
const COUNTDOWN_EPSILON = 0.1;

/**
 * **The flat line from `root` to `point` — one subtraction that feeds both the heading and the distance printed on
 * the throw line.**
 *
 * **One vector rather than two measurements, and the project already argues this about the pair on a throw line.**
 * `Windup.distance` records it: charge and distance are only comparable numbers while they describe *the same
 * throw*, and computing "the unit vector to the target" and "how far away the target is" in two places is two ways of
 * naming one line, free to disagree the first time one of them changes. So the line is built once, the heading is its
 * unit, and the log prints its magnitude.
 *
 * **This is the half of the aim that is not the charge, and it is the half that is easy to miss.** Aiming the charge
 * at a player only decides *how fast* the ball leaves; **the ball travels along the heading**, and a heading built
 * from the rig's own facing would send it wherever the body happened to be looking — a rig planted facing its bay's
 * far corner throws into that corner no matter what the charge was solved for.
 *
 * **Horizontal by construction**, for `practiceBay`'s reason: a bay is a footprint, so the line a drill aims along is
 * a ground line and the rise is the solve's business rather than the aim's.
 */
function flatLine(root: BasePart, point: Vector3): Vector3 {
	return new Vector3(point.X - root.Position.X, 0, point.Z - root.Position.Z);
}

/**
 * The direction a body with nowhere to aim is pointing — **its own facing, flattened.**
 *
 * **The fallback for {@link headingToward}'s `undefined` and for nothing else.** The flattening is not required by the
 * solve — `planChargedThrow` projects a heading onto the ground plane and takes its compass direction, so the vertical
 * part of a `LookVector` following a slope never reaches the throw — but it is what makes the vector printed on the
 * throw line the same vector the *distance* was measured along.
 */
function facingOf(root: BasePart): Vector3 {
	const facing = new Vector3(root.CFrame.LookVector.X, 0, root.CFrame.LookVector.Z);

	return facing.Magnitude < FLAT_EPSILON ? root.CFrame.LookVector : facing.Unit;
}

/**
 * **A drill: a rig that throws at the person in its own bay, and at nobody else — worn by
 * {@link PRACTICE_THROW_TAG}.**
 *
 * ## What this is, and what it is deliberately not
 *
 * This is `AlwaysThrowBehavior`'s mechanism with a **target**, and the four things that separates it are all
 * consequences of having one:
 *
 * | | `AlwaysThrowBehavior` | this |
 * | --- | --- | --- |
 * | what it aims at | `THROW_RANGE` studs past its own nose | the `HumanoidRootPart` of a player in its bay |
 * | when it throws | every `DECISION_SECONDS`, unconditionally | only while somebody is in its bay |
 * | whether it misses | 90 % of the time, by ten to fifteen studs | never — see `beginWindup`'s `trueAim` |
 * | what the client sees | `CHARGING_ATTRIBUTE`, for the hold | that **and** {@link NEXT_THROW_AT_ATTRIBUTE}, a countdown to the whole cycle |
 *
 * **It is a sibling and not a mode**, which is the one design decision worth arguing here. Folding this into
 * `AlwaysThrowBehavior` behind a "has a bay" check would have made one behaviour mean two things depending on
 * geography the behaviour cannot see — and it would have made the always-thrower's own users (a dummy that throws to
 * prove a throw exists) pay for a target they do not want. **Two tags, two files.** The machinery they share — the
 * windup tracker, the charge solve, the miss, `BallService.throwBall` — is imported rather than copied, so "a drill's
 * throw is the game's throw" stays a fact about one call and not a claim in a comment.
 *
 * **`Behavior_AlwaysThrowing` is not retired by this file existing.** The user stopped painting it on drills; the code
 * stays, and a rig wearing both tags runs both behaviours and throws twice. That is left alone on purpose: a
 * mutual-exclusion rule is a rule nobody asked for, and the double throw is the honest reading of a rig wearing two
 * throwing tags.
 *
 * ## The gate, which is the whole of the feature
 *
 * Every turn, before anything else, the rig asks **one sentence: is a player standing in a bay** (`targetFor`), and
 * idles unless the answer is yes.
 *
 * **The first version asked two questions — "am I in a bay" *and* "is somebody in that bay" — and the first of them
 * was a mistake.** A live session proved it can never fire in this place file: the rig sits at
 * `(52.1, 93.8, 542.0)` and reported itself inside its bay on the first tick and outside it four seconds later, having
 * provably not moved. **A rule that needs the rig and the box to be co-located needs a coincidence**, and it made the
 * strict half the wrong one: the box is what a person painted to practise in, and the rig is a fixture beside it. So
 * the strict test is on the **player**, which is what was actually asked for, and the rig's own bay is a preference —
 * tried first, so two drills beside two boxes each take their own — rather than a requirement.
 *
 * A "no" **stands the rig down and clears its countdown** — it does not fall back to a bigger area, and it does not
 * throw at nothing. That much is a correction a live report bought: an earlier version fell back to the whole
 * `practiceZone` when a rig had no bay, which meant every drill on the practice floor fired at whoever was anywhere on
 * it, at sixty and a hundred and thirty studs. **Nobody in a bay, nothing thrown** is the whole of the requirement.
 *
 * **Standing down also forgets the decision deadline**, and that is not tidiness. Without it a rig whose player walked
 * out keeps the deadline it banked while they were there, so the moment they step back in it arms and throws on the
 * same turn — a throw with no countdown at all, which is the one thing a telegraph cannot be. The deletion is what
 * turns "somebody came back" into a fresh cycle.
 *
 * ## The pace, and why the tick is not the pace
 *
 * `tickInterval` is the shared windup cadence — a tenth of a second — because a hold has to be *watched*. The pace is
 * `NPC_CONFIG.PRACTICE_THROW_CADENCE_SECONDS`, and it is a separate number for the reason `AlwaysThrowBehavior`
 * records: a hold that lasted a whole tick interval would either fire on the turn it decided (no hold at all) or hold
 * for five seconds, which is not `charge × RIG_CHARGE_SECONDS` and would put a five-second looping effect on a
 * practice dummy.
 */
export function createPracticeThrowBehavior(balls: BallService): NpcBehavior {
	/** This rig's holds. The mechanism is `ThrowBehavior`'s, built fresh so behaviours keep separate tables. */
	const windups = createWindupTracker();

	/**
	 * **When each rig's next ball leaves its hand**, in `os.clock` seconds.
	 *
	 * **The release, not the decision, and that is the correction that made the countdown honest.** This used to be
	 * the instant the rig *started winding up*, with the hold's own length published afterwards as a second deadline —
	 * so the digits ran `3 2 1`, then a fresh `1` for the hold, and the ball arrived after the number had already
	 * promised it. A countdown has one job and it is to name the throw, so the map holds the throw and the hold is
	 * scheduled backwards from it: see the tick, which starts a windup `charge × RIG_CHARGE_SECONDS` before this
	 * instant so the hold *ends* on it.
	 *
	 * A row is made the first time a rig is seen armed and re-armed at every release, so `PRACTICE_THROW_CADENCE_SECONDS`
	 * is now the whole cycle rather than the wait plus the hold. **Deleted, not merely cleared, whenever the rig stands
	 * down** — see this file's header for the throw-with-no-countdown that a banked deadline produces.
	 */
	const nextThrowAt = new Map<Model, number>();

	/**
	 * **Whether each rig is standing down, so the line is printed when the answer *changes* and not once a tick.**
	 *
	 * `""` is armed and `"empty"` is the one refusal. **The edge is the whole point**: an empty bay stays empty for
	 * minutes at a time, so a line per tick would be ten a second per rig, and a line only on the transition is exactly
	 * the sequence a person needs — *standing down* when they step out and *armed* when they step back in. It is also
	 * the only thing a drill ever says when nothing is wrong, which makes "no line at all" mean the rig never ticked.
	 */
	const standingDownBecause = new Map<Model, string>();

	/**
	 * **The last gap each rig reported, so the stand-down line reprints when the measurement moves and not otherwise.**
	 *
	 * The reason latch alone cannot carry the number: it prints once at boot, when a player has no `Character` yet, and
	 * then stays quiet for the session — which is precisely how two sessions went by with a box that existed and nobody
	 * ever standing on it. A stud of movement is the threshold, so a person walking across the box gets a new reading
	 * and a person standing still does not.
	 */
	const lastGap = new Map<Model, number>();

	/**
	 * **Writes this rig's next-throw deadline, or clears it — the one place `NEXT_THROW_AT_ATTRIBUTE` is set.**
	 *
	 * **Two call sites now, and both name a *throw*.** The turn a rig arms, and the release that re-arms it — nothing
	 * else sets a deadline. **The windup starting used to be a third**, publishing the hold's own length, and that was
	 * the bug: it turned a countdown to a ball into `3 2 1` followed by a second `1`, because a hold is
	 * `charge × RIG_CHARGE_SECONDS` and a sub-second instant can only round up to the same number again. The attribute
	 * is read as *when does the ball come*, so that is what it now holds — see `nextThrowAt`, which is the release, and
	 * the tick, which starts the windup a hold early so the hold finishes on it.
	 *
	 * **`undefined` clears, and that is the only spelling of "not armed".** See the attribute's own doc for why an
	 * absence rather than a `0`. **A rig with no target is cleared, not left standing** — which is the same correction
	 * as the gate: a drill that is doing nothing has nothing to telegraph, and a number over an idle rig would be a
	 * countdown to a throw that is not coming.
	 *
	 * **`GetServerTimeNow` and not `os.clock`**, because the deadline crosses the wire to a machine that does not share
	 * this clock. The caller passes a *duration* and the conversion happens here so that no caller can forget it.
	 *
	 * **The epsilon guard is here rather than at the call sites**, because a guard that three callers each had to
	 * remember is a guard that the fourth caller will not have.
	 */
	const publishDeadline = (model: Model, secondsFromNow: number | undefined): void => {
		const current = model.GetAttribute(NEXT_THROW_AT_ATTRIBUTE);

		if (secondsFromNow === undefined) {
			if (current !== undefined) model.SetAttribute(NEXT_THROW_AT_ATTRIBUTE, undefined);

			return;
		}

		const at = Workspace.GetServerTimeNow() + secondsFromNow;

		if (typeIs(current, "number") && math.abs(current - at) < COUNTDOWN_EPSILON) return;

		model.SetAttribute(NEXT_THROW_AT_ATTRIBUTE, at);
	};

	const cadence = NPC_CONFIG.PRACTICE_THROW_CADENCE_SECONDS;

	return {
		tag: PRACTICE_THROW_TAG,
		tickInterval: THROW_TICK_SECONDS,

		// A rig that throws needs something to throw, by the same call a player's character is given a ball by —
		// `AlwaysThrowBehavior`'s decision, taken here for its reason: a behaviour asks for its own ball, so neither
		// `NpcService` nor `spawn` has to know that throwing wants one or that balls exist.
		//
		// **And this rig has nobody who will fetch for it.** `Behavior_Seeking` and `Behavior_Pickup` are for a rig
		// that walks to a ball on the floor, and a drill is planted in a bay by definition — it never leaves it, so a
		// drill relying on a fetch would be a drill that throws once and then stands there. The refill in the tick
		// below is the other half of that.
		prepare(model) {
			balls.giveBall(model);
		},

		tick(model) {
			const now = os.clock();

			// Empty hand: take another ball, and **a hold cannot outlive the hand that was holding it.** A ball that is
			// gone means there is nothing to release, and a windup left standing would fire a throw that cannot happen
			// and keep its charge published on a body with an empty hand. The deadline goes with it for the same
			// reason one step further out: the client is counting down to a throw this rig can no longer make.
			if (!balls.getHeldBall(model)) {
				windups.cancelWindup(model, "the ball left the hand");
				publishDeadline(model, undefined);
				balls.giveBall(model);

				return;
			}

			const root = model.FindFirstChild("HumanoidRootPart");
			if (!root || !root.IsA("BasePart")) return;

			// **The gate, and everything below this line is "the rig has somebody to throw at".**
			//
			// **One question: is a player standing in a bay.** The rig's own bay is a *preference* — it is tried first,
			// so two drills beside two boxes each take their own — and never a requirement. It was a requirement in the
			// first version and a live session proved the rule could not fire: the rig sits at `(52.1, 93.8, 542.0)` and
			// was inside its bay on the first tick and outside it four seconds later, having provably not moved. **A rule
			// that needs the rig and the box to be co-located is a rule that needs a coincidence**, and the box is what a
			// person painted to practise in while the rig is a fixture beside it. See `practiceBay.targetFor`.
			//
			// **`cancelWindup` cannot carry the stand-down line** because it returns early when there is no hold to
			// cancel, so an idle drill would print nothing at all — which is why the latch below exists. It prints on the
			// *transition* rather than per tick, because an empty bay is a state that lasts for minutes and a line per
			// turn would be ten a second per rig.
			const target = targetFor(model);

			if (target === undefined) {
				// **The line carries the measurement, and it is reprinted whenever that measurement moves by a stud.**
				// A stand-down latch alone would print once at boot, when the player has no `Character` yet, and then
				// say nothing for the rest of the session — which is exactly how two sessions went by with a box that
				// existed and nobody ever standing on it. Keying the line on the *gap* means it speaks the moment a
				// body appears and again if that body walks from one side of the box to the other, and stays quiet
				// while a person stands still.
				const measured = rigBayGap(model);
				const previous = lastGap.get(model);
				const moved =
					previous === undefined ||
					(previous === math.huge) !== (measured.gap === math.huge) ||
					math.abs(measured.gap - previous) >= 1;

				if (standingDownBecause.get(model) !== "empty" || moved) {
					standingDownBecause.set(model, "empty");
					lastGap.set(model, measured.gap);

					print(
						`[Drill] ${model.Name}: standing down — nobody is standing in this rig's bay. ` +
							`${measured.text}. The bay is a footprint: height is ignored, so this is a flat distance.`,
					);
				}

				windups.cancelWindup(model, "nobody is standing in this rig's bay");
				publishDeadline(model, undefined);
				nextThrowAt.delete(model);

				return;
			}

			// Armed: the first turn this rig has somebody to throw at says so, including which box they are in — the
			// pair of lines is a person stepping into and out of a bay, and it is the whole of this behaviour's output
			// when nothing is wrong.
			if (standingDownBecause.get(model) !== "") {
				standingDownBecause.set(model, "");
				lastGap.delete(model);
				print(`[Drill] ${model.Name}: armed — ${target.player.Name} is in ${target.bay.Name}`);
			}

			const windup = windups.get(model);

			// **The instant the ball leaves, read before anything else this turn does with the hold.** It is the deadline
			// the client is counting down to, so it — and not the hold's own end — is what the release waits for. The two
			// agree whenever the target has not moved; where they disagree, the published number is the one a player has
			// been watching, and a ball that arrives when the countdown said zero is worth more than a hold of exactly
			// `charge × RIG_CHARGE_SECONDS`. `windup.until` is the fallback for a hold with no deadline behind it, which
			// no path should produce.
			const due = nextThrowAt.get(model);

			if (windup !== undefined) {
				// **The freeze, seen the way the other two throwers see it** — as turns that did not happen. A rig frozen
				// mid-hold is not ticked at all, so a deadline that passed while it was frozen would release a throw with
				// nothing having moved it, and the whole point of holding is that it can be taken away. See
				// `WINDUP_GAP_TURNS`.
				if (now - windup.lastTurnAt > THROW_TICK_SECONDS * WINDUP_GAP_TURNS) {
					windups.cancelWindup(model, "the turns stopped — frozen");
					publishDeadline(model, undefined);

					return;
				}

				windup.lastTurnAt = now;

				// Still holding: the release is a later turn, and that is the whole of the hold.
				if (now < (due ?? windup.until)) return;

				windups.endWindup(model);

				// **Read live from the target resolved at the top of this turn, rather than carried from the decision.**
				// The player has had the whole hold to move in, and a drill that threw at where they *were* half a
				// second ago is a drill that cannot be practised against. The charge is the half that is carried — it
				// is measured from the hand and does not move with a step — and this is the half that is re-asked.
				//
				// **The fallback is the rig's facing and not a second aim point**, so the degenerate case (a player
				// standing on the rig's own feet) throws where the body is looking rather than dividing by nothing. That
				// is a real case and not a defensive flourish: a player standing on the rig's feet is inside its bay by
				// every measure this project uses.
				const line = flatLine(root, target.at);
				const heading = line.Magnitude < FLAT_EPSILON ? facingOf(root) : line.Unit;

				// **The drill spends its pending ability on this throw, exactly as the other two throwers do.** A box on
				// the practice floor is furniture a rig walks through constantly, so the slot has to be consumed here or
				// the first box strands it for the rest of the session. Same mark-or-window before the throw, same clear
				// after — see `ThrowBehavior`'s throw site for the argument.
				const pending = pendingAbilityOn(model);
				if (pending === "MultiBall") {
					balls.activateMultiBall(model);
				} else if (pending !== undefined) {
					balls.markHeldBall(model, pending);
				}

				const thrown = balls.throwBall(model, {
					kind: "charged",
					heading,
					charge: windup.charge,
					curve: false,
				});

				if (pending !== undefined) model.SetAttribute(PENDING_ABILITY_ATTRIBUTE, "");

				// Re-armed on every release rather than on every decision, so a hold that was cancelled or expired costs
				// the rig a decision rather than a whole interval of standing still with a ball in hand.
				nextThrowAt.set(model, now + cadence);

				// **And the countdown restarts with it — the *same* instant, not a second one.** The attribute is
				// `NEXT_THROW_AT_ATTRIBUTE`, which is a countdown to a ball; writing the hold's length here used to make it
				// a countdown to a windup, and the digits restarted at `1` for every cycle and lied about when the ball
				// would come. There are now exactly two writes that set a deadline — this one, and the one the turn a rig
				// arms makes — and both of them name a throw.
				publishDeadline(model, cadence);

				// **Logged once per throw, under a `[Drill]` prefix rather than `[Rig]`, and that is not vanity.** The
				// other two throwing behaviours both print `[Rig]`, and a rig in this place file is literally *named*
				// `Behavior_Throwing` — so `[Rig] Behavior_Throwing: throw` is a line that cannot be attributed without
				// knowing the source. The prefix says which behaviour spoke. The fields are the shared ones for the
				// reason `Windup.distance` records: charge and distance are one throw's two numbers or they are not
				// comparable. **The miss is absent because there is never one here** — that is what `trueAim` buys — and
				// printing an empty field would suggest it had been considered and happened to be zero.
				if (thrown) {
					print(
						`[Drill] ${model.Name}: throw — charge ${string.format("%.2f", windup.charge)} at ` +
							`${string.format("%.1f", windup.distance)} studs, at ${target.player.Name} ` +
							`(${string.format("%.1f", line.Magnitude)} studs), heading ` +
							`(${string.format("%.2f", heading.X)}, ${string.format("%.2f", heading.Y)}, ` +
							`${string.format("%.2f", heading.Z)})`,
					);
				}

				return;
			}

			// **Not holding: is the next throw's instant known?** The first answer is *made* rather than read, so a rig
			// whose player has just walked in waits one cadence before its first throw instead of throwing on the turn
			// they arrived. That is what makes the countdown mean something: `3 2 1` is the last three seconds of a wait
			// the player can see the beginning of.
			//
			// **A whole `cadence`, and it is the instant of the *release*.** Everything after this line is scheduled
			// backwards from it: the windup below starts a hold early so that the hold *ends* on this number, which is
			// what makes the digits the truth about the ball rather than about the windup.
			if (due === undefined) {
				nextThrowAt.set(model, now + cadence);
				publishDeadline(model, cadence);

				return;
			}

			// **`plantNow` — a drill never throws on the move**, and that is a fact about its walk rather than a choice
			// about its throw. `NPC_CONFIG.THROW_MOVE_AND_AIM_CHANCE` is for a rig with a carry-through to keep alive,
			// and this one never has one: `SeekBehavior.pickupWalk` draws that movement on the turn a rig *takes* a
			// ball, and a drill is handed one by `prepare` and by its own refill, so `seek.ball` is never what filled its
			// hand. Drawing one of the other shapes would publish a walk instruction for a body with nothing to walk and
			// then plant it anyway — a log line that lied about every one of its throws.
			//
			// **`trueAim` on the end, and this is the only call site in the game that passes it.** `NPC_CONFIG`'s miss
			// chance is a difficulty dial for an opponent, and a drill is not an opponent — it is aimed at the person in
			// front of it so they can practise dodging *that*. A rig trying to miss is a rig you cannot learn from. See
			// `beginWindup`'s own doc for why the exception is opt-in rather than a change of default.
			//
			// **It skips the miss roll and nothing else — the charge is still solved from the point handed here.** That
			// distinction had to be checked against the source rather than assumed: a spec once read this flag as the
			// reason a drill threw with `charge 0.00`, and it is not. `beginWindup` computes
			// `chargeForRange(distance, point.Y − muzzle.Y)` whether or not the roll happened; what made the charge
			// bottom out was the *height* of `target.at`, which is why that point is now raised to hand height. See
			// `playerInBay`.
			//
			// **The windup starts a hold before the deadline, and that offset is the whole of this pass.** The hold is
			// `charge × RIG_CHARGE_SECONDS` — up to a second and a quarter — so a windup started *at* the deadline puts
			// the ball that much past every number the client drew. `holdFor` is the same arithmetic `beginWindup` is
			// about to run, asked a turn early, so the start is exactly one hold before the throw and the `1` on the board
			// is the second the rig spends winding up. **Asked every turn rather than stored at the arm**, because the
			// answer depends on where the player is standing and a plan made five seconds ago is a plan for a body that
			// has since moved: this is the last turn before the hold, so it is the freshest answer there is.
			if (now < due - windups.holdFor(model, target.at)) return;

			windups.beginWindup(model, root, target.at, "plantNow", true);
		},

		// **A hold dies with the rig holding it.** A corpse is not winding up a throw, the charge has to come off the
		// body rather than sitting there for `RESPAWN_DELAY_SECONDS`, and the row has to go because nothing will tick
		// this rig again. **The countdown goes with it**, or a dead rig's number sits over its corpse counting toward a
		// throw that cannot happen.
		onDied(model) {
			windups.cancelWindup(model, "the rig died");
			publishDeadline(model, undefined);
		},

		/**
		 * **A drill whose tag is taken off mid-cycle takes its countdown with it, and this hook is the only thing that
		 * can.**
		 *
		 * `onDied` cannot cover this: the tags come off from outside at every round boundary
		 * (`LobbyRigService.setGameplayBehaviors` strips six at once), the body is alive, and a stopped behaviour is
		 * never ticked again. **`CHARGING_ATTRIBUTE` already had a fallback for that** — the expiry timer armed inside
		 * `beginWindup` — and `NEXT_THROW_AT_ATTRIBUTE` has nothing equivalent, because it is not a hold and nothing
		 * arms a timer for it. Without this line, a drill unpainted mid-countdown wears a number over its head for the
		 * rest of the session: the client's only other hide condition is "the remaining time ran out", and a client
		 * whose clock is behind the server's would show a stale `1` rather than nothing.
		 *
		 * **The decision row goes too**, for the reason the gate's deletion gives: a rig re-tagged half a minute later
		 * would otherwise find a deadline already in the past and arm on its first turn, with no countdown.
		 */
		onStopped(model) {
			windups.cancelWindup(model, "the rig stopped being a drill");
			publishDeadline(model, undefined);
			nextThrowAt.delete(model);

			// **And the stand-down latch, so a rig re-tagged later reports its next refusal afresh** rather than being
			// silent because it was already standing down for the same reason when the tag came off.
			standingDownBecause.delete(model);
		},
	};
}
