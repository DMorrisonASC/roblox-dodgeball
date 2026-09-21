import { Service } from "@flamework/core";
import { CollectionService, Workspace } from "@rbxts/services";
import { PICKUP_RADIUS } from "shared/constants";
import { resolveDodgeable } from "shared/dodge";
import { BallService } from "./BallService";

/**
 * The tag every ball carries.
 *
 * Must match the `tag` in `BallComponent`'s decorator, which is what turns a ball
 * into a component — and this is the *second* reader of it, so the two have to
 * agree or this service searches an empty list forever.
 */
const BALL_TAG = "Ball";

/**
 * Picking a ball up off the ground.
 *
 * The same act a player performs through a ball's ProximityPrompt, offered as a
 * call so anything with a humanoid can do it — an NPC behavior today, a prompt or
 * a keybind later. The *search* is all this owns: which ball, and whether it is
 * near enough. The attach is `BallService`'s, so a picked-up ball is
 * indistinguishable from a caught one the moment it is in the hand, and can be
 * thrown by the same call.
 */
@Service()
export class BallPickupService {
	constructor(private readonly balls: BallService) {}

	/**
	 * Picks up the nearest loose ball, if there is one within reach.
	 *
	 * Returns whether a ball changed hands, which is the question every caller
	 * actually has. Refuses quietly: an empty floor and a full hand are ordinary
	 * states, not errors.
	 *
	 * `radius` defaults to {@link PICKUP_RADIUS} so a caller can reach further, or
	 * not as far, without changing anybody else's reach.
	 */
	public pickupNearest(model: Model, radius = PICKUP_RADIUS): boolean {
		// A picker is a living humanoid — the same rule a dodge and a catch use, asked
		// through the same helper so the three cannot drift apart.
		const entity = resolveDodgeable(model);
		if (!entity?.humanoid || entity.humanoid.Health <= 0) return false;

		// One ball per hand, and this is the rule rather than a safety net: the attach
		// destroys whatever the hand was already holding, so a pickup that ran anyway
		// would eat the ball the model was about to throw.
		if (this.balls.getHeldBall(model)) return false;

		const ball = this.nearestLooseBall(entity.root.Position, radius);
		if (!ball) return false;

		return this.balls.pickupBall(model, ball);
	}

	/**
	 * The closest ball lying loose within `radius`, or `undefined`.
	 *
	 * Loose means three things, and each is a ball this must not take: **not armed**
	 * (an armed ball is in flight and belongs to the throw), **not anchored** (that
	 * is scenery somebody placed), and **parented to the world** — anything else is
	 * inside the hand holding it, which is the same test a catch makes before it
	 * takes a ball out of the air.
	 */
	private nearestLooseBall(origin: Vector3, radius: number): BasePart | undefined {
		let best: BasePart | undefined;
		let bestDistance = radius;

		for (const instance of CollectionService.GetTagged(BALL_TAG)) {
			if (!instance.IsA("BasePart")) continue;
			if (instance.GetAttribute("Armed") === true) continue;
			if (instance.Anchored) continue;
			if (instance.Parent !== Workspace) continue;

			const distance = instance.Position.sub(origin).Magnitude;
			if (distance > bestDistance) continue;

			best = instance;
			bestDistance = distance;
		}

		return best;
	}
}
