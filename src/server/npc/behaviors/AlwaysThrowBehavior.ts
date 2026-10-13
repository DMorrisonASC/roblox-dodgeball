import { chargeForRange, getThrowMuzzle } from "shared/throw";
import { BEHAVIOR_ALWAYS_THROWING, NpcBehavior } from "../Behavior";
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
 * `tickInterval` is what paces the throws. It is deliberately slower than the catching behavior's, so
 * a rig that both catches and throws has time to be hit between its own throws.
 */
export function createAlwaysThrowBehavior(balls: BallService): NpcBehavior {
	return {
		tag: BEHAVIOR_ALWAYS_THROWING,
		tickInterval: 5.0,

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

			// **The heading is the facing, flattened, because a rig with no target has nothing else to go
			// on.** The flattening is not required by the solve — `planChargedThrow` projects a heading onto
			// the ground plane and takes its compass direction, so the vertical part of a `LookVector` that
			// follows a slope never reaches the throw — but it is what makes the vector printed below the same
			// vector the *distance* was measured along, which is the pair this behaviour has to be honest
			// about.
			const heading = new Vector3(root.CFrame.LookVector.X, 0, root.CFrame.LookVector.Z);

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
			const muzzle = getThrowMuzzle(model);
			const charge = chargeForRange(THROW_RANGE, root.Position.Y - muzzle.Y);

			const thrown = balls.throwBall(model, { kind: "charged", heading, charge, curve: false });

			// **Logged once per throw**, in the shape `ThrowBehavior` logs, so the two rig behaviours can be
			// read against each other and against a player's `[Throw]` line. See that file for why the charge
			// and the distance are the two fields worth printing, and why nothing about the flight is repeated
			// here.
			if (thrown) {
				print(
					`[Rig] ${model.Name}: throw — charge ${string.format("%.2f", charge)} at ` +
						`${string.format("%.1f", THROW_RANGE)} studs, heading ` +
						`(${string.format("%.2f", heading.X)}, ${string.format("%.2f", heading.Y)}, ` +
						`${string.format("%.2f", heading.Z)})`,
				);
			}
		},
	};
}
