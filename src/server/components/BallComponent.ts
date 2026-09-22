import { OnStart } from "@flamework/core";
import { BaseComponent, Component } from "@flamework/components";
import { Players, Workspace } from "@rbxts/services";
import { THROWER_TOKEN } from "shared/constants";
import { CATCH_CONFIG } from "shared/config/catch.config";
import { BallService } from "../services/BallService";
import { CatchService } from "../services/CatchService";

interface BallAttributes {
	Armed: Boolean;
}

/** What an uncaught hit does. Lethal on purpose — a hit ends the round. */
const HIT_DAMAGE = 1000;

@Component({
	tag: "Ball",
	defaults: { Armed: false },
})
export class BallComponent extends BaseComponent<BallAttributes, BasePart> implements OnStart {
	constructor(private readonly catches: CatchService, private readonly balls: BallService) {
		super();
	}

	public onStart(): void {
		this.instance.Touched.Connect((otherPart) => {
			this.logTouch(otherPart);
			this.handleTouch(otherPart);
		});
	}

	/**
	 * What a touch means: a catch, a hit, or nothing at all.
	 *
	 * The catcher is taken from the part's ancestry rather than from the players
	 * list. An NPC is a humanoid model like any other and has no `Player` behind
	 * it, so anything that asks "is this a player?" leaves NPCs unable to do what a
	 * player can — which is what this used to do.
	 */
	private handleTouch(otherPart: BasePart): void {
		const character = otherPart.FindFirstAncestorWhichIsA("Model");
		const humanoid = character?.FindFirstChildWhichIsA("Humanoid");

		// Not a character. The ball has hit the world, and is live no longer.
		if (!character || !humanoid) {
			this.instance.SetAttribute("Armed", false);
			return;
		}

		// Already spent — a hit or a landing has taken it out of play.
		if (this.instance.GetAttribute("Armed") !== true) return;

		// The root decides nothing. It is engine plumbing sitting *inside* the torso,
		// not a body part: a ball in contact with it is in contact with the torso as
		// well, and a contact reported against it alone means nothing happened. Left
		// in, it was the part that killed a catcher — it is not in
		// {@link CATCH_CONFIG.CATCHABLE_PARTS}, so the first event of a torso arrival
		// read as a hit, and the catch that should have saved them arrived after the
		// damage.
		if (otherPart.Name === "HumanoidRootPart") return;

		// Nobody is hurt by their own ball, and nobody catches it either. Both come
		// down to the same string: the token stamped on the ball at release, held
		// against the token on the model it is touching. A player's token is their
		// `UserId` as text and an NPC's is a GUID, and this comparison cannot tell
		// them apart — which is the point. Asking "is this a player?" instead would
		// leave an NPC free to hit itself with its own throw.
		const throwerId = this.instance.GetAttribute("ThrowerId");
		const token = character.GetAttribute(THROWER_TOKEN);
		if (typeIs(throwerId, "string") && throwerId !== "" && throwerId === token) return;

		if (this.canCatch(otherPart, character)) {
			// Spent before the ball is handed over, so one attempt catches one ball
			// even if two arrive together.
			this.catches.consume(character);
			this.balls.catchBall(character, this.instance);
			return;
		}

		this.landHit(character, humanoid);
	}

	/**
	 * Hurts `character`, once this frame's other contacts have been seen.
	 *
	 * One arrival reports **several** parts, because `Touched` fires once per part
	 * and in no particular order. A ball reaching a torso also reports the
	 * `HumanoidRootPart` it is sitting inside — which is not a part a catch can be
	 * made with, and which the engine may well report first. Applied on the spot,
	 * the hit went in before the catch had been asked about, so a catcher died of a
	 * contact that is not even a body part.
	 *
	 * Deferring to the end of the frame gives every part of that one contact its
	 * turn, so the outcome is decided by *what the ball touched* rather than by the
	 * order the engine happened to report it in. A ball that ends the frame welded
	 * into this character's hand was caught, and nothing lands.
	 */
	private landHit(character: Model, humanoid: Humanoid): void {
		task.defer(() => {
			// Caught in the same frame: the catch is the answer to this contact.
			if (this.balls.getHeldBall(character) === this.instance) return;

			// Already dead, from another part of the very same contact.
			if (humanoid.Health <= 0) return;

			humanoid.TakeDamage(HIT_DAMAGE);
		});
	}

	/** Whether this touch is a catch: a catchable part, on a character whose window is open. */
	private canCatch(otherPart: BasePart, character: Model): boolean {
		if (!CATCH_CONFIG.CATCHABLE_PARTS.has(otherPart.Name)) return false;

		// Only a ball in flight can be caught. One welded into somebody's hand is
		// already held, and taking it would leave a ball with two welds on it.
		if (this.instance.Parent !== Workspace) return false;

		return this.catches.isCatching(character);
	}

	private logTouch(otherPart: BasePart): void {
		const character = otherPart.FindFirstAncestorWhichIsA("Model");

		const player = character ? Players.GetPlayerFromCharacter(character) : undefined;

		if (this.instance.GetAttribute("Armed") === false) {
			return;
		}

		if (this.isPlayer(otherPart)) {
			print(`${this.instance.Name} touched ${otherPart.Name} of ${player?.Name}`);
		} else if (this.isNpc(otherPart)) {
			print(`${this.instance.Name} touched ${otherPart.Name} of ${character?.Name}`);
		} else {
			print(`${this.instance.Name} touched ${otherPart.Name}`);
		}
	}

	private isPlayer(otherPart: BasePart): boolean {
		const character = otherPart.FindFirstAncestorWhichIsA("Model");

		const player = character ? Players.GetPlayerFromCharacter(character) : undefined;

		if (player) {
			return true;
		}

		return false;
	}

	private isNpc(otherPart: BasePart): boolean {
		const character = otherPart.FindFirstAncestorWhichIsA("Model");
		const humanoid = character?.FindFirstChildWhichIsA("Humanoid");
		const player = character ? Players.GetPlayerFromCharacter(character) : undefined;

		if (humanoid && !player) {
			return true;
		}

		return false;
	}
}
