import { OnStart } from "@flamework/core";
import { BaseComponent, Component } from "@flamework/components";
import { Players, Workspace } from "@rbxts/services";
import { BallService } from "../services/BallService";
import { CatchService } from "../services/CatchService";

interface BallAttributes {
	Armed: Boolean;
}

/**
 * The parts a catch can be made with: the torso and the arms, and nothing else.
 *
 * Both rig types are named, because a catch that worked on R15 and not on R6
 * would be a rule that changed with the avatar — R15 splits each limb into upper
 * and lower halves, R6 calls them "Right Arm". Legs and the head are absent on
 * purpose: they are what you throw *at*, so if they could catch, a catch would
 * stop being a read of the throw.
 */
const CATCHABLE_PARTS = new Set<string>([
	"Torso",
	"UpperTorso",
	"LowerTorso",
	"LeftUpperArm",
	"LeftLowerArm",
	"Left Arm",
	"RightUpperArm",
	"RightLowerArm",
	"Right Arm",
]);

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

		// Nobody is hurt by their own ball, and nobody catches it either. Both come
		// down to the same number: the id stamped on the ball when it was thrown.
		const throwerId = this.instance.GetAttribute("ThrowerId");
		const player = Players.GetPlayerFromCharacter(character);
		if (throwerId !== undefined && player !== undefined && throwerId === player.UserId) return;

		if (this.canCatch(otherPart, character)) {
			// Spent before the ball is handed over, so one attempt catches one ball
			// even if two arrive together.
			this.catches.consume(character);
			this.balls.catchBall(character, this.instance);
			return;
		}

		humanoid.TakeDamage(HIT_DAMAGE);
	}

	/** Whether this touch is a catch: a catchable part, on a character whose window is open. */
	private canCatch(otherPart: BasePart, character: Model): boolean {
		if (!CATCHABLE_PARTS.has(otherPart.Name)) return false;

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
