import { OnStart } from "@flamework/core";
import { BaseComponent, Component } from "@flamework/components";
import { Players, Workspace } from "@rbxts/services";
import { THROWER_TOKEN } from "shared/constants";
import { BALL_CONFIG } from "shared/config/ball.config";
import { CATCH_CONFIG } from "shared/config/catch.config";
import { DEBUG_CONFIG } from "shared/config/debug.config";
import { BallService } from "../services/BallService";
import { CatchService } from "../services/CatchService";

interface BallAttributes {
	Armed: Boolean;
}

/** What an uncaught hit does. Lethal on purpose — a hit ends the round. */
const HIT_DAMAGE = 1000;

/**
 * How slow a ball may be and still be worth bouncing off somebody, in studs per second.
 *
 * A ball that arrived this slowly has no throw left in it to reflect, and reflecting a
 * near-zero velocity about a near-zero direction scatters it somewhere arbitrary — the one
 * thing a bounce must never be.
 */
const BOUNCE_MIN_SPEED = 1;

/**
 * How far a ball must be from the part it touched for the line between them to mean
 * anything, in studs.
 *
 * Below this the direction is float noise and the bounce is a coin toss.
 */
const BOUNCE_MIN_SEPARATION = 0.01;

@Component({
	tag: "Ball",
	defaults: { Armed: false },
})
export class BallComponent extends BaseComponent<BallAttributes, BasePart> implements OnStart {
	/**
	 * Every body this ball has already hit on this throw.
	 *
	 * What it buys is a ball that survives a hit: the same player cannot be taken out twice
	 * by one throw, and — the point of the whole thing — a ball that comes off one player is
	 * still looking for the next one.
	 *
	 * On the instance rather than on the ball as an attribute, because an attribute holds
	 * primitives and this holds models.
	 */
	private readonly hitModels = new Set<Model>();

	constructor(private readonly catches: CatchService, private readonly balls: BallService) {
		super();
	}

	public onStart(): void {
		this.instance.Touched.Connect((otherPart) => {
			this.logTouch(otherPart);
			this.handleTouch(otherPart);
		});

		// **The start of a throw, and the only moment this ball's memory is emptied.**
		//
		// `Armed` going *on* is the ball being released: `BallService` arms it in `throwBall`,
		// and again on a hand-out. That is precisely "a new throw", so the set is empty for
		// it by construction — which is what makes the cap count per throw, and what lets a
		// ball taken off the floor hit the same players all over again.
		//
		// Nothing has to empty it while the ball is merely *held*, and that is why this is
		// not hooked to the hand instead: a ball in somebody's hand cannot damage anybody, so
		// a set sitting in it is unreadable, and the throw that follows clears it anyway.
		//
		// Keeping it here rather than having `BallService` call in also keeps the ball's own
		// state in the ball: no service has to know a hit list exists, or reach into a
		// component to reset one.
		this.instance.GetAttributeChangedSignal("Armed").Connect(() => {
			if (this.instance.GetAttribute("Armed") !== true) return;

			this.hitModels.clear();
		});
	}

	/**
	 * What a touch means: a catch, a hit, or nothing at all.
	 *
	 * The catcher is taken from the part's ancestry rather than from the players
	 * list. An NPC is a humanoid model like any other and has no `Player` behind
	 * it, so anything that asks "is this a player?" leaves NPCs unable to do what a
	 * player can.
	 *
	 * **A body does not stop the ball — the world does.** A body is damaged, and the ball
	 * is thrown off it and carries on armed, looking for the next one, which is what makes
	 * a single well-placed throw capable of a chain. Only a contact that is not a body
	 * (floor, wall, prop) ends the throw, exactly as it always has.
	 */
	private handleTouch(otherPart: BasePart): void {
		// Spent already: a landing, a wall, or a chain that has run its length has taken
		// this ball out of play, and nothing below can put it back.
		if (this.instance.GetAttribute("Armed") !== true) return;

		const character = otherPart.FindFirstAncestorWhichIsA("Model");
		const humanoid = character?.FindFirstChildWhichIsA("Humanoid");

		// Not a character. The ball has hit the world, and is live no longer.
		if (!character || !humanoid) {
			this.instance.SetAttribute("Armed", false);
			return;
		}

		// The root decides nothing. It is engine plumbing sitting *inside* the torso,
		// not a body part: a ball in contact with it is in contact with the torso as
		// well, and a contact reported against it alone means nothing happened. Left
		// in, it was the part that killed a catcher — it is not in
		// {@link CATCH_CONFIG.CATCHABLE_PARTS}, so the first event of a torso arrival
		// read as a hit, and the catch that should have saved them arrived after the
		// damage.
		//
		// It matters at least as much now that a body no longer stops the ball: one
		// arrival reports every part it overlaps, so without this the torso and the root
		// would be two hits on the same player — two bounces, in the same frame.
		if (otherPart.Name === "HumanoidRootPart") return;

		// **A body contact has to be a part of a body.** Anything else inside a character —
		// a hat, a tool, the ball in its hand — belongs to somebody without being part of
		// them, and a ball that has touched one of those has touched nothing: not a hit, not
		// a catch, and no reason to disarm.
		//
		// Not hypothetical. An accessory's `Handle` sits inside the accessory, and a ball
		// passing a head clips a beanie often enough to matter. Left in, every such glance
		// read as a body hit — lethal, and enough to record the character as hit, which then
		// skipped the torso contact that was about to catch the ball.
		if (!this.isBodyPart(humanoid, otherPart)) return;

		// Nobody is hurt by their own ball, and nobody catches it either — including off
		// the rebound, which is the case that matters now that balls come off people. Both
		// come down to the same string: the token stamped on the ball at release, held
		// against the token on the model it is touching. A player's token is their
		// `UserId` as text and an NPC's is a GUID, and this comparison cannot tell
		// them apart — which is the point. Asking "is this a player?" instead would
		// leave an NPC free to hit itself with its own throw.
		const throwerId = this.instance.GetAttribute("ThrowerId");
		const token = character.GetAttribute(THROWER_TOKEN);
		if (typeIs(throwerId, "string") && throwerId !== "" && throwerId === token) return;

		// **Decided already — or decided by an earlier part of this same arrival.** Either way
		// this body's turn has been taken and the ball passes through it.
		//
		// This is what makes the *first* part final: every part the engine reports after it is
		// refused here. It is also what stops one throw taking the same body twice.
		if (this.hitModels.has(character)) return;

		// **The first body part to arrive decides the whole contact, and nothing later may
		// change its mind.** A catchable part first — a torso or an arm — is a catch; anything
		// else first, the head or a leg, is a hit.
		//
		// Being plain about what that means: this is a rule about the engine's report order.
		// At throw speeds the ball crosses several studs in a frame, so an arrival is not a
		// sequence of hits but one overlap set, reported in whatever order the engine walks it
		// — a ball into the chest is often reported against the head too. If the head comes
		// first, this reads as a hit, and that is the intended rule rather than a slip.
		//
		// The alternative — letting any catchable part anywhere in the set win — takes the head
		// out of the game: a ball aimed at one would be caught by the torso it also touches.
		if (this.canCatch(otherPart, character)) {
			// Spent before the ball is handed over, so one attempt catches one ball
			// even if two arrive together.
			this.catches.consume(character);
			this.balls.catchBall(character, this.instance);
			return;
		}

		// A hit. Recorded before the ball is thrown off, so that every other part of this
		// same arrival — and every later contact with this body — is a body the ball has
		// already been through.
		this.hitModels.add(character);

		this.bounceOff(otherPart);

		this.landHit(character, humanoid, otherPart);

		// The chain's length. Checked *after* the bounce, so the last player a throw takes
		// out still throws the ball off them rather than catching it on the chest.
		if (this.hitModels.size() >= BALL_CONFIG.MAX_CHAIN_HITS) this.instance.SetAttribute("Armed", false);
	}

	/**
	 * Throws the ball off a body it has just hit.
	 *
	 * **Not the engine's elasticity.** That acts off everything at a strength decided by
	 * the two materials meeting, so it cannot be told "spring off people, thud off walls" —
	 * a bouncy ball bounces off the floor and the walls too, which is the opposite of what
	 * the rest of this game wants. This is the same reflection done by hand, for bodies
	 * only, so the bounce has one strength and the rest of the world stays as dead as it
	 * was.
	 *
	 * The direction is the line from the part that was touched to the ball's own centre,
	 * which is the best stand-in available: `Touched` carries no geometry, and a body is not
	 * a flat wall to take a normal from. What it produces is a **deflection** rather than a
	 * mirror bounce — a ball clipping a shoulder is sent off to one side, and a ball
	 * arriving dead centre comes back the way it came.
	 */
	private bounceOff(otherPart: BasePart): void {
		const velocity = this.instance.AssemblyLinearVelocity;
		if (velocity.Magnitude < BOUNCE_MIN_SPEED) return;

		const separation = this.instance.Position.sub(otherPart.Position);
		if (separation.Magnitude < BOUNCE_MIN_SEPARATION) return;

		const normal = separation.Unit;
		const reflected = velocity.sub(normal.mul(2 * velocity.Dot(normal)));

		this.instance.AssemblyLinearVelocity = reflected.mul(BALL_CONFIG.BOUNCE_FACTOR);
	}

	/**
	 * Takes the character out, and prints which part decided that.
	 *
	 * Applied straight away rather than at the end of the frame. It used to be deferred so that
	 * a catchable part *later* in the same arrival could still win the contact — which is the
	 * exact behaviour the rule above reverses: the first part decides, so there is nothing left
	 * for a deferral to wait for, and waiting would only make the decision that was already
	 * made at the first touch look like it depended on the last one.
	 *
	 * The print is the rule made visible. Everything above it in the output is the engine's
	 * list of contacts; this line says which of them counted, and after it the rest of that
	 * arrival is silent — which would otherwise read the same as an arrival that was ignored.
	 */
	private landHit(character: Model, humanoid: Humanoid, part: BasePart): void {
		// Gated where the rest of this file's output is not: this is one line per hit, and it is
		// worth reading only while tuning what a contact is worth.
		if (DEBUG_CONFIG.VERBOSE_LOGS) print(`[Ball] ${character.Name}: hit on ${part.Name}`);

		humanoid.TakeDamage(HIT_DAMAGE);
	}

	/** Whether this touch is a catch: a catchable part, on a character whose window is open. */
	private canCatch(otherPart: BasePart, character: Model): boolean {
		if (!CATCH_CONFIG.CATCHABLE_PARTS.has(otherPart.Name)) return false;

		// Only a ball in flight can be caught. One welded into somebody's hand is
		// already held, and taking it would leave a ball with two welds on it.
		if (this.instance.Parent !== Workspace) return false;

		return this.catches.isCatching(character);
	}

	/**
	 * Whether `part` is part of `humanoid`'s body, rather than something it is holding or
	 * wearing.
	 *
	 * Two questions, in this order, and both are needed:
	 *
	 * 1. **Is it a direct child of the rig?** `GetLimb` *throws* — "Part is not a child of
	 *    Humanoid", with a stack trace in the output — for anything deeper. A hat's `Handle`
	 *    lives inside its accessory and a tool's inside its tool; without this an ordinary
	 *    glance off a beanie became an error that drowned the log and left the contact
	 *    half-handled.
	 * 2. **Does the engine call it a limb?** `GetLimb` answers for R6 and R15 alike, so no
	 *    list of names is needed here — an R15 rig has `UpperTorso` where an R6 one has
	 *    `Torso`, and a hand-written list would have to know both and would still miss a rig
	 *    nobody has seen yet. It reports `Unknown` for the `HumanoidRootPart`, so it agrees
	 *    with the explicit check above, and for a ball welded into the hand, which is a
	 *    direct child of the rig and so gets past the first question.
	 */
	private isBodyPart(humanoid: Humanoid, part: BasePart): boolean {
		if (part.Parent !== humanoid.Parent) return false;

		return humanoid.GetLimb(part) !== Enum.Limb.Unknown;
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
