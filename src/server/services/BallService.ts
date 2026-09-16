import { Service, OnStart } from "@flamework/core";
import { Players, ReplicatedStorage, Workspace } from "@rbxts/services";
import { BALL_NAME } from "shared/constants";
import { REMOTES } from "shared/remotes";
import { SphereService } from "./SphereService";

const BALL_SIZE = 4;
const THROW_SPEED = 100; // studs per second
const PROJECTILE_LIFETIME = 15; // seconds before a thrown ball is cleaned up
const NEW_BALL_DELAY = 3; // seconds after a throw before the player gets another ball
const MIN_THROW_ANGLE = math.rad(5);

/** Where the ball sits relative to the hand while it is being held. */
const GRIP_OFFSET = new CFrame();

@Service()
export class BallService implements OnStart {
	private throwRemote?: RemoteEvent;
	private readonly heldBalls = new Map<Player, Part>();

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
		this.heldBalls.get(player)?.Destroy();
		this.heldBalls.delete(player);

		const hand = this.getRightHand(character);
		if (!hand) {
			warn(`[Ball] ${player.Name}: could not find a right hand to hold the ball`);
			return;
		}

		const ball = this.spheres.createBall(BALL_SIZE);
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

		this.heldBalls.set(player, ball);
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
		const ball = this.heldBalls.get(player);
		if (!character || !ball || ball.Parent !== character) return;

		// Release the ball from the hand before launching it.
		ball.FindFirstChild("DodgeballGrip")?.Destroy();

		const origin = ball.Position;
		const velocity = this.computeLaunchVelocity(origin, target, THROW_SPEED);
		const direction = velocity.Unit;

		ball.CanCollide = true;
		ball.Massless = false;
		// Start the ball clear of the thrower's body so it can't hit them.
		ball.Position = origin.add(direction.mul(BALL_SIZE));
		ball.Parent = Workspace;
		ball.AssemblyLinearVelocity = velocity;

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

	/**
	 * Solves for the launch velocity that sends the ball from `origin` toward
	 * `target` along a parabolic arc using a fixed throw speed. Gravity then
	 * shapes the parabola naturally.
	 */
	private computeLaunchVelocity(origin: Vector3, target: Vector3, speed: number): Vector3 {
		const gravity = Workspace.Gravity;
		const delta = target.sub(origin);
		const horizontal = new Vector3(delta.X, 0, delta.Z);
		const distance = horizontal.Magnitude;
		const height = delta.Y;

		const horizontalDir = distance > 0.001 ? horizontal.div(distance) : new Vector3(0, 0, -1);

		const speedSq = speed * speed;
		const discriminant = speedSq * speedSq - gravity * (gravity * distance * distance + 2 * height * speedSq);

		let angle: number;
		if (distance > 0.001 && discriminant >= 0) {
			const root = math.sqrt(discriminant);
			// Lower root = flatter (direct) throw; higher root = lobbed throw.
			const flat = math.atan((speedSq - root) / (gravity * distance));
			angle = math.clamp(flat, MIN_THROW_ANGLE, math.rad(85));
		} else {
			// Target is out of range for the given speed — lob at 45° for max range.
			angle = math.rad(45);
		}

		const horizontalSpeed = speed * math.cos(angle);
		const verticalSpeed = speed * math.sin(angle);
		return horizontalDir.mul(horizontalSpeed).add(new Vector3(0, verticalSpeed, 0));
	}
}
