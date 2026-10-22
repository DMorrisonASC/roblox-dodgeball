import { pendingAbilityOn } from "shared/ability";
import { PENDING_ABILITY_ATTRIBUTE } from "shared/constants";
import { BEHAVIOR_ALWAYS_THROWING, NpcBehavior } from "../Behavior";
import { THROW_TICK_SECONDS, WINDUP_GAP_TURNS, createWindupTracker, missedPoint } from "./ThrowBehavior";
import type { Miss } from "./ThrowBehavior";
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
 * is not `charge × RIG_CHARGE_SECONDS` and would put a five-second looping effect on a practice dummy. So the
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
 * How small a flattened facing may be before this file treats it as having no direction at all.
 *
 * The same figure `ThrowBehavior` uses privately for its own aim and its own miss. Duplicated rather than
 * exported because it is a comparison tolerance and not a setting: two files agreeing on "close enough to zero
 * to be zero" is cheaper than one file owning the number for the other.
 */
const FLAT_EPSILON = 0.001;

/**
 * **The point a practice rig is aiming at**: {@link THROW_RANGE} studs ahead of its body, at its own root height.
 *
 * **Written out as a point because the shared windup takes one, and the two figures it used to take were this
 * point's distance and rise.** `beginWindup` measures from the hand to whatever point it is given, so handing it
 * a point is the same arithmetic the tick used to do itself — deliberately, because the point is also what the
 * error is rolled against and what the charge is solved to, and a behaviour that could only name a distance could
 * not be given the miss without a second call site. **The height is the root's rather than the hand's**, which is
 * where the old rise came from: the ball leaves at head height and the stand-in is at hip height, so this is a
 * throw angled down exactly as the gated thrower's is.
 *
 * **`Vector3.zAxis` for a body with no flat facing**, which cannot happen to a humanoid standing on a floor and
 * does for a body lying in a corner. The distance is what this point is for — the heading is decided at the
 * release, from the facing the body has then, by {@link headingFor} — so any horizontal direction gives a legal
 * throw rather than a charge solved for zero studs.
 */
function standInPoint(root: BasePart): Vector3 {
	const facing = new Vector3(root.CFrame.LookVector.X, 0, root.CFrame.LookVector.Z);
	const ahead = facing.Magnitude < FLAT_EPSILON ? Vector3.zAxis : facing.Unit;

	return new Vector3(
		root.Position.X + ahead.X * THROW_RANGE,
		root.Position.Y,
		root.Position.Z + ahead.Z * THROW_RANGE,
	);
}

/**
 * The heading a practice rig's throw leaves along: **its own live facing, turned aside if this throw was rolled
 * wide.**
 *
 * **A turn rather than an offset, and the difference is which units the error is measured in.** The roll draws a
 * few *studs*, which only becomes a direction once it is placed at a range — the gated thrower has an aim point
 * to place it against, and this rig has {@link standInPoint}'s stand-in. So the point is built, moved sideways by
 * `missedPoint` (the gated thrower's own function, so both behaviours are wide by the same studs for the same
 * draw) and turned back into a heading. Reusing that function rather than writing a rotation here is what keeps
 * "a miss is five to ten studs to one side" one rule across two rigs.
 *
 * **The facing is read here and not carried from the decision** — see the release, which argues why a rig with no
 * target still has one thing that can change. The error is the part that is carried, on the windup row.
 *
 * **A body with no flat facing has none to turn aside**, so it throws along its own look vector and lets the solve
 * project it, which is exactly what this behaviour did before any of this existed.
 */
function headingFor(root: BasePart, miss: Miss | undefined): Vector3 {
	const facing = new Vector3(root.CFrame.LookVector.X, 0, root.CFrame.LookVector.Z);
	if (facing.Magnitude < FLAT_EPSILON) return root.CFrame.LookVector;
	if (miss === undefined) return facing.Unit;

	const point = missedPoint(root, standInPoint(root), miss);
	const turned = new Vector3(point.X - root.Position.X, 0, point.Z - root.Position.Z);

	return turned.Magnitude < FLAT_EPSILON ? facing.Unit : turned.Unit;
}

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
				//
				// **And the error, if one was rolled, is applied to this live facing rather than to a stored
				// point** — `headingFor` builds the same stand-in point the charge was solved against, moves it
				// sideways by the studs the roll drew, and turns the result back into a heading. So a wide practice
				// throw is a few studs off *wherever the body is pointing now*, which is the only reading that
				// makes a dummy's miss look like a person's: the miss is a mistake in the aim, not a throw at a
				// remembered place. With no miss it is the plain flattened facing, which is what this line did
				// before the roll existed at all.
				const heading = headingFor(root, windup.miss);

				// **The practice rig spends its pending ability on this throw, exactly as the gated thrower
				// does.** A box on the practice floor is furniture this rig walks through constantly, so the
				// slot has to be consumed here or the first box strands it for the rest of the session. Same
				// mark-or-window before the throw, same clear after — see `ThrowBehavior`'s throw site for the
				// argument.
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

				// Re-armed on every release rather than on every decision, so a hold that was cancelled or expired
				// costs the rig a decision rather than a whole interval of standing still with a ball in hand.
				nextDecisionAt.set(model, now + DECISION_SECONDS);

				// **Logged once per throw**, in the shape `ThrowBehavior` logs, so the two rig behaviours can be
				// read against each other and against a player's `[Throw]` line. See that file for why the charge
				// and the distance are the two fields worth printing, and why nothing about the flight is repeated
				// here.
				//
				// **The distance is the one the charge was solved at, and that is no longer always `THROW_RANGE`.** A
				// throw rolled wide is solved to a point a few studs to one side, so its distance is the hypotenuse
				// — printing the nominal sixty beside a charge for sixty-one would be exactly the two-numbers-from-
				// two-throws fault the pair exists to rule out. `windup.distance` is the solved figure, and it is
				// `THROW_RANGE` to a tenth of a stud on the throws that are aimed true.
				//
				// **And the miss is named, in the gated thrower's own words**, so a run of practice throws can be
				// counted for how often a dummy was deliberately wide without reading its aim off a screenshot.
				if (thrown) {
					const wide =
						windup.miss === undefined
							? ""
							: `, ${string.format("%.1f", windup.miss.studs)} studs to the ` +
								`${windup.miss.side > 0 ? "right" : "left"} (missed on purpose)`;

					print(
						`[Rig] ${model.Name}: throw — charge ${string.format("%.2f", windup.charge)} at ` +
							`${string.format("%.1f", windup.distance)} studs, heading ` +
							`(${string.format("%.2f", heading.X)}, ${string.format("%.2f", heading.Y)}, ` +
							`${string.format("%.2f", heading.Z)})${wide}`,
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
			//
			// **The point is built rather than the pair, and that is what gives this rig the miss.** `beginWindup`
			// rolls the error and solves the charge against the point it is handed, so a behaviour that can only
			// name a distance and a rise could not be given one — the roll would have to be added here, at the
			// second call site, which is exactly where it would eventually go missing. So the stand-in target is
			// written out as the point it always implicitly was: `THROW_RANGE` studs ahead of the body at its own
			// root height. The distance and rise the solve gets are the same two numbers as before (a hypotenuse
			// a few tenths of a stud longer on a wide one), which is what keeps this behaviour's ball, pace and
			// shape unchanged — see `standInPoint`.
			const standIn = standInPoint(root);

			// **`plantNow` — this rig never throws on the move, and that is a fact about its walk rather than a
			// choice about its throw.** `NPC_CONFIG.THROW_MOVE_AND_AIM_CHANCE` is for a rig that has a
			// carry-through to keep alive, and this one never has one: `SeekBehavior.pickupWalk` draws that movement
			// on the turn a rig *takes* a ball, and a practice rig is handed one by `prepare` and by its own refill
			// below, so `seek.ball` is never the thing that filled its hand and the leg is never drawn. Drawing one
			// of the other shapes here would publish a walk instruction for a body with nothing to walk and then
			// plant it anyway — a log line that lied about every one of its throws.
			//
			// **What that means for a practice dummy, said because it is the user's observation rather than an
			// omission:** this is the rig that most visibly stands still and throws, and it stands because it is
			// never between a ball and a walk — not because anything here refuses to move it. A dummy that moved
			// would need a walk of its own, which is a different feature: its job is to be a target that is always
			// there. Its charge still solves from the fixed stand-in distance, so on a throw aimed true this shape
			// is byte for byte what it was before any of the three existed — the only throws whose numbers have
			// moved are the ones deliberately aimed wide, and those moved by the few studs of the error.
			windups.beginWindup(model, root, standIn, "plantNow");
		},

		// **A hold dies with the rig holding it**, for the gated thrower's reason: a corpse is not winding up a
		// throw, the charge has to come off the body rather than sitting there for `RESPAWN_DELAY_SECONDS`, and
		// the row has to go because nothing will tick this rig again.
		onDied(model) {
			windups.cancelWindup(model, "the rig died");
		},
	};
}
