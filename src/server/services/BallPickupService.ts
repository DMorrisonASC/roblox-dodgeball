import { OnStart, Service } from "@flamework/core";
import { CollectionService, Players, Workspace } from "@rbxts/services";
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
 * How often the players are looked over for a loose ball in reach, in seconds.
 *
 * A walking character covers about 16 studs a second, so this wants to be short
 * enough that nobody strides past a ball inside {@link PICKUP_RADIUS} between two
 * looks — and long enough that the scan is not the most expensive thing the
 * server does.
 */
const PLAYER_PICKUP_PERIOD = 0.3;

/**
 * Picking a ball up off the ground.
 *
 * Two callers, one search. An NPC asks through its `Behavior_Pickup`, and the
 * players are collected for from here — a character that comes within reach of a
 * loose ball takes it, with nothing to press. One rule for both, which is what
 * stops a player and an NPC disagreeing about what is on the floor.
 *
 * The *search* is all this owns: which ball, and whether it is near enough. The
 * attach is `BallService`'s, so a picked-up ball is indistinguishable from a
 * caught one the moment it is in the hand, and is thrown by the same call.
 */
@Service()
export class BallPickupService implements OnStart {
	constructor(private readonly balls: BallService) {}

	public onStart() {
		task.spawn(() => this.collectForPlayers());
	}

	/**
	 * Collects for every player, in one loop rather than a thread each.
	 *
	 * One loop because the work is a few distance checks, and a per-player thread
	 * would be bookkeeping for no gain — the player list is read fresh each turn, so
	 * there is nothing to keep in step with joins and leaves. A service lives as long
	 * as the server does, which is why this loop has no ending.
	 *
	 * A hand that is already full makes `pickupNearest` return on its first check, so
	 * the ordinary case — a player holding the ball they are about to throw — costs
	 * nothing at all.
	 */
	private collectForPlayers(): void {
		while (true) {
			for (const player of Players.GetPlayers()) {
				const character = player.Character;
				if (character) this.pickupNearest(character);
			}

			task.wait(PLAYER_PICKUP_PERIOD);
		}
	}

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
