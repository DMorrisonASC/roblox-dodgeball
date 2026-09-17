import { Service, OnStart } from "@flamework/core";
import { Players, ReplicatedStorage, Workspace } from "@rbxts/services";
import { BALL_NAME, BALL_SIZE } from "shared/constants";
import { CollisionIgnore } from "shared/CollisionIgnore";
import { REMOTES } from "shared/remotes";
import { planPlayerThrow } from "shared/throw";
import { TrailEffect } from "shared/TrailEffect";
import { SphereService } from "./SphereService";

const PROJECTILE_LIFETIME = 15; // seconds before a thrown ball is cleaned up

/**
 * Seconds after a throw before the player gets another ball.
 *
 * Zero means no cooldown — you can throw as fast as you can click. The callback
 * still runs a frame later rather than inline, which keeps the new ball from
 * being created while the old one is mid-launch.
 */
const NEW_BALL_DELAY = 0;

const DEBUG = true; // prints where each throw was launched from

/** Where the ball sits relative to the hand while it is being held. */
const GRIP_OFFSET = new CFrame();

/** A ball currently welded to a player's hand, plus its (disabled) trail. */
interface HeldBall {
	ball: Part;
	trail: TrailEffect;
}

@Service()
export class BallService implements OnStart {
	private throwRemote?: RemoteEvent;
	private readonly heldBalls = new Map<Player, HeldBall>();

	constructor(private readonly spheres: SphereService) {}

	onStart() {
		this.throwRemote = this.createThrowRemote();
		this.throwRemote.OnServerEvent.Connect((player, target) => {
			this.throwBall(player, target as Vector3);
		});

		Players.PlayerRemoving.Connect((player) => this.heldBalls.delete(player));
	}

	/**
	 * Welds a dodgeball into the player's hand whenever their character spawns.
	 *
	 * This deliberately does NOT use a Tool. A Tool's handle is gripped by the
	 * engine, and in this project that grip never actually forms (the character
	 * ends up with no `RightGrip`), so the unanchored ball falls straight out of
	 * the world. Welding the ball to the hand ourselves is deterministic.
	 */
	public giveBall(player: Player) {
		player.CharacterAdded.Connect((character) => this.attachBall(player, character));

		const character = player.Character;
		if (character) {
			this.attachBall(player, character);
		}
	}

	/** Creates a ball and welds it into the hand of the given character. */
	private attachBall(player: Player, character: Model) {
		// Respawn safety: never leave an orphaned ball behind.
		this.heldBalls.get(player)?.ball.Destroy();
		this.heldBalls.delete(player);

		const hand = this.getRightHand(character);
		if (!hand) {
			warn(`[Ball] ${player.Name}: could not find a right hand to hold the ball`);
			return;
		}

		const ball = this.spheres.createBall(BALL_SIZE, { trail: false });
		// The trail stays off until the throw — otherwise it streams purple off
		// the player's hand every time they walk around.
		const trail = this.spheres.addTrail(ball, { enabled: false });
		ball.Name = BALL_NAME;
		ball.CanCollide = false; // don't shove the player around while held
		ball.Massless = true;
		ball.CFrame = hand.CFrame.mul(GRIP_OFFSET);
		ball.Parent = character;

		const grip = new Instance("WeldConstraint");
		grip.Name = "DodgeballGrip";
		grip.Part0 = hand;
		grip.Part1 = ball;
		grip.Parent = ball;

		this.heldBalls.set(player, { ball, trail });
		print(`[Ball] ${player.Name} is holding a dodgeball`);
	}

	/** R6 rigs use "Right Arm"; R15 rigs use "RightHand". */
	private getRightHand(character: Model): BasePart | undefined {
		const humanoid = character.WaitForChild("Humanoid", 10);
		if (!humanoid) return undefined;
		if (!humanoid.IsA("Humanoid")) return undefined;

		const name = humanoid.RigType === Enum.HumanoidRigType.R15 ? "RightHand" : "Right Arm";
		const hand = character.WaitForChild(name, 10);
		if (!hand) return undefined;

		return hand.IsA("BasePart") ? hand : undefined;
	}

	private createThrowRemote(): RemoteEvent {
		const folder = this.findOrCreateFolder(ReplicatedStorage, REMOTES.folder);
		return this.findOrCreateRemote(folder, REMOTES.throwBall);
	}

	private findOrCreateRemote(parent: Instance, name: string): RemoteEvent {
		const existing = parent.FindFirstChild(name);
		if (existing?.IsA("RemoteEvent")) return existing;

		const remote = new Instance("RemoteEvent");
		remote.Name = name;
		remote.Parent = parent;
		return remote;
	}

	private findOrCreateFolder(parent: Instance, name: string): Folder {
		const existing = parent.FindFirstChild(name);
		if (existing?.IsA("Folder")) return existing;

		const folder = new Instance("Folder");
		folder.Name = name;
		folder.Parent = parent;
		return folder;
	}

	private throwBall(player: Player, target: Vector3) {
		const character = player.Character;
		const held = this.heldBalls.get(player);
		if (!character || !held || held.ball.Parent !== character) return;

		const ball = held.ball;

		// Release the ball from the hand before launching it.
		ball.FindFirstChild("DodgeballGrip")?.Destroy();

		// The client runs this exact same plan to draw its aim guide, so the
		// throw and the predicted arc can never disagree.
		const releasePosition = ball.Position;
		const plan = planPlayerThrow(character, target);
		if (DEBUG) {
			print(`[Ball] ${player.Name}: release ${releasePosition} -> launch ${plan.origin}`);
		}

		// The thrower can never be hit by their own ball. Without this, a throw
		// aimed back across the body clips it, and the engine resolves that
		// overlap the only way it can — by shoving the player. Ball size and
		// muzzle distance only ever changed how hard that shove was.
		CollisionIgnore.between(ball, character);

		// Move the ball before it can collide. Setting collision this frame
		// while the ball is still inside the hand would leave the thrower's own
		// overlap to be resolved if this frame's constraint changes haven't
		// replicated yet.
		ball.CanCollide = false;
		ball.Position = plan.origin;
		ball.Parent = Workspace;
		ball.AssemblyLinearVelocity = plan.velocity;

		// Arm the ball a frame later, by which point the ignore above has
		// certainly replicated. This also means the ball is never solid while it
		// is still sitting in the hand.
		task.delay(0, () => {
			ball.CanCollide = true;
			ball.Massless = false;
		});

		// Airborne now, so the trail can start drawing behind it.
		held.trail.setEnabled(true);

		this.heldBalls.delete(player);

		task.delay(PROJECTILE_LIFETIME, () => ball.Destroy());
		task.delay(NEW_BALL_DELAY, () => {
			const current = player.Character;
			const humanoid = current?.FindFirstChildOfClass("Humanoid");
			if (current && humanoid && humanoid.Health > 0) {
				this.attachBall(player, current);
			}
		});
	}
}
