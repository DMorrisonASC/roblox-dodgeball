import { Service, OnStart } from "@flamework/core";
import { Players, ReplicatedStorage, Workspace } from "@rbxts/services";
import { BALL_NAME, BALL_SIZE, THROW_VERTICAL_BOOST } from "shared/constants";
import { CollisionIgnore } from "shared/CollisionIgnore";
import { REMOTES } from "shared/remotes";
import { planPlayerThrow, getThrowMuzzle } from "shared/throw";
import { LaunchPlan, ThrowArc } from "shared/Trajectory";
import { TrailEffect } from "shared/TrailEffect";
import { SphereService } from "./SphereService";
import { watchThrow } from "../ThrowProbe";

const PROJECTILE_LIFETIME = 15; // seconds before a thrown ball is cleaned up

/**
 * Seconds after a throw before the player gets another ball.
 *
 * Zero means no cooldown — you can throw as fast as you can click. The callback
 * still runs a frame later rather than inline, which keeps the new ball from
 * being created while the old one is mid-launch.
 */
const NEW_BALL_DELAY = 0;

const DEBUG = true; // prints the mode, speed and angle of each throw

/**
 * How far a client's claimed launch point may sit from the thrower's hand as the
 * server sees it before that claim is thrown away, in studs.
 *
 * Normally the claim is good to well under a stud — it is the difference between
 * two copies of the same character, not a disagreement about the game. This is
 * the bound for "that is not a stale character, that is a client inventing a
 * launch point".
 */
const MUZZLE_TOLERANCE = 10;

/** Where the ball sits relative to the hand while it is being held. */
const GRIP_OFFSET = new CFrame();

/** Name of the weld that holds a ball in a hand, so it can be found again. */
const GRIP_NAME = "DodgeballGrip";

/** A ball currently welded into somebody's hand, plus its (disabled) trail. */
interface HeldBall {
	/**
	 * A `BasePart` rather than a `Part`: a caught ball arrives as whatever the
	 * component's instance is, and it is the same object either way.
	 */
	ball: BasePart;
	trail: TrailEffect;
}

@Service()
export class BallService implements OnStart {
	private throwRemote?: RemoteEvent;

	/**
	 * What each model is holding, keyed on the **model** rather than the player.
	 *
	 * A catcher can be an NPC, and a caught ball has to end up in the same place a
	 * handed-out one does — otherwise it could not be thrown afterwards. Everything
	 * that genuinely needs a `Player`, which is the throw remote and the `UserId`
	 * stamped on a ball at release, stays in the player path.
	 */
	private readonly heldBalls = new Map<Model, HeldBall>();

	constructor(private readonly spheres: SphereService) {}

	onStart() {
		this.throwRemote = this.createThrowRemote();
		this.throwRemote.OnServerEvent.Connect((player, target, arc, claim) => {
			if (!typeIs(target, "Vector3")) return;

			// Anything unrecognised falls back to the regular throw. All three arcs
			// reach the same point, so a bad value costs the player the shape they
			// asked for and nothing else.
			let chosen: ThrowArc = "overhead";
			if (arc === "straight") {
				chosen = "straight";
			} else if (arc === "curve") {
				chosen = "curve";
			}

			this.throwBall(player, target, chosen, typeIs(claim, "Vector3") ? claim : undefined);
		});

		Players.PlayerRemoving.Connect((player) => {
			const character = player.Character;
			if (character) this.heldBalls.delete(character);
		});
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
		player.CharacterAdded.Connect((character) => this.attachBall(character, player.UserId));

		const character = player.Character;
		if (character) {
			this.attachBall(character, player.UserId);
		}
	}

	/**
	 * Welds `ball` into `model`'s hand, as if it had been picked up.
	 *
	 * The catch's entry point, though nothing in here knows that: a caught ball goes
	 * through the same path a hand-out does, which is what lets its catcher throw it
	 * with the same click as anybody else.
	 *
	 * Held but **not armed**, and owned by nobody — `throwBall` stamps the thrower
	 * at release, which is the moment ownership starts to mean anything.
	 */
	public catchBall(model: Model, ball: BasePart): boolean {
		if (!this.holdBall(model, ball, 0, false)) return false;

		print(`[Ball] ${model.Name} caught a dodgeball`);

		return true;
	}

	/** Creates a ball and welds it into the hand of the given character. */
	private attachBall(character: Model, throwerId: number) {
		this.holdBall(character, this.spheres.createBall(BALL_SIZE, { trail: false }), throwerId, true);
	}

	/**
	 * The one place a held ball is set up.
	 *
	 * Shared by the spawn hand-out, the refill after a throw and a catch, so all
	 * three produce the same thing in the same state: a ball welded into a hand,
	 * massless and non-colliding, with its trail switched off until it flies again.
	 *
	 * `armed` is passed in rather than assumed, because the two callers disagree and
	 * always have: a handed-out ball is live the moment it exists, while a caught
	 * one stays inert until its new owner throws it.
	 */
	private holdBall(character: Model, ball: BasePart, throwerId: number, armed: boolean): boolean {
		const hand = this.getRightHand(character);
		if (!hand) {
			warn(`[Ball] ${character.Name}: could not find a right hand to hold the ball`);
			ball.Destroy();
			return false;
		}

		// Respawn safety, and catching safety: whatever this character was already
		// holding goes, so two balls can never end up sharing one hand.
		this.heldBalls.get(character)?.ball.Destroy();
		this.heldBalls.delete(character);

		// A caught ball arrives mid-flight, still carrying the weld that held it in
		// its thrower's hand and the trail it flew with. One weld and one trail per
		// ball, and both of these are about to be replaced.
		ball.FindFirstChild(GRIP_NAME)?.Destroy();
		ball.FindFirstChild(TrailEffect.INSTANCE_NAME)?.Destroy();

		// The trail stays off until the throw — otherwise it streams purple off the
		// hand every time the holder walks around. The effect reuses the ball's
		// existing attachments, so replacing the trail leaves nothing behind.
		const trail = this.spheres.addTrail(ball, { enabled: false });

		ball.Name = BALL_NAME;
		ball.CanCollide = false; // don't shove the holder around while held
		ball.Massless = true;
		ball.CFrame = hand.CFrame.mul(GRIP_OFFSET);
		ball.Parent = character;
		ball.AddTag("Ball");
		// Attributes after the tag, never before: tagging is what creates the
		// component, and its defaults would write over anything set first.
		ball.SetAttribute("Armed", armed);
		ball.SetAttribute("ThrowerId", throwerId);
		this.setPromptEnabled(ball, false);

		const grip = new Instance("WeldConstraint");
		grip.Name = GRIP_NAME;
		grip.Part0 = hand;
		grip.Part1 = ball;
		grip.Parent = ball;

		this.heldBalls.set(character, { ball, trail });

		return true;
	}

	/**
	 * Turns the ball's pickup prompt off while it is held, and back on when it is
	 * thrown.
	 *
	 * Nothing creates a prompt today — balls are handed out rather than picked up —
	 * so this does nothing yet. The hook is here so that a ball which grows one is
	 * still only offered while it is lying on the ground.
	 */
	private setPromptEnabled(ball: BasePart, enabled: boolean): void {
		const prompt = ball.FindFirstChildWhichIsA("ProximityPrompt");
		if (prompt) prompt.Enabled = enabled;
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

	private throwBall(player: Player, target: Vector3, arc: ThrowArc, claimedLaunch?: Vector3) {
		const character = player.Character;
		const held = character ? this.heldBalls.get(character) : undefined;
		if (!character || !held || held.ball.Parent !== character) return;

		const ball = held.ball;

		// Release the ball from the hand before launching it.
		ball.FindFirstChild(GRIP_NAME)?.Destroy();
		// Armed and attributed at the moment of release rather than when the ball
		// was made: a caught ball has been through somebody else's hand since, and
		// this throw is what decides whose ball it is now. The immunity check and
		// the catch check both read this one number.
		ball.SetAttribute("Armed", true);
		ball.SetAttribute("ThrowerId", player.UserId);
		this.setPromptEnabled(ball, true);
		// Airborne now, so the trail can start drawing behind it.
		held.trail.setEnabled(true);

		// The client runs this exact same plan to draw its aim guide, so the throw
		// and the predicted arc can never disagree — which only holds while both
		// sides solve from the same launch point, see `planPlayerThrow`.
		const releasePosition = ball.Position;
		const ownLaunch = getThrowMuzzle(character);
		const launch = this.acceptLaunch(ownLaunch, claimedLaunch);
		const plan = planPlayerThrow(character, target, arc, launch);

		// What actually goes on the ball: the solve, plus the launch boost that
		// covers the engine's own vertical loss. See THROW_VERTICAL_BOOST — the
		// guide draws the solve, so this is what makes the ball fly the drawn line
		// instead of sagging below it.
		const commanded = plan.velocity.add(new Vector3(0, THROW_VERTICAL_BOOST, 0));

		if (DEBUG) {
			print(
				`[Ball] ${player.Name}: ${plan.arc} ${this.describeThrow(plan, commanded)}, ` +
					`release ${releasePosition} -> launch ${plan.origin}` +
					` (${string.format("%.2f", launch.sub(ownLaunch).Magnitude)} studs from our own)`,
			);
		}

		// The thrower can never be hit by their own ball. Without this, a throw
		// aimed back across the body clips it, and the engine resolves that
		// overlap the only way it can — by shoving the player. Ball size and
		// muzzle distance only ever changed how hard that shove was.
		CollisionIgnore.between(ball, character);

		// Move the ball, hand it to this machine's solver, and arm it — all inside
		// the one frame.
		//
		// Every line of this used to be spread across `task.delay(0)`, which left
		// the ball non-colliding, massless and unforced for a physics step. That
		// step's length depends on the frame, so the ball had a window it could
		// pass through something by, and a different-sized one every throw — the
		// exact shape of "it does not land in the same place twice".
		//
		// The old reason for the delay was that a solid ball still sitting in the
		// hand got the thrower shoved. `CollisionIgnore` above settles that
		// structurally: the ball cannot collide with its thrower's body at all, so
		// being close to the hand for a frame no longer matters.
		ball.CanCollide = false;
		ball.Position = plan.origin;
		ball.Parent = Workspace;

		// The ball was welded into the character, so it belonged to the thrower's
		// client's physics — and that machine was the one simulating it, including
		// the frame it was released on. Called with no argument the server takes it
		// back, so the whole flight is simulated in one place.
		ball.SetNetworkOwner();

		ball.AssemblyLinearVelocity = commanded;
		ball.CanCollide = true;
		ball.Massless = false;
		// After `Massless`, never before: the force is sized from the ball's
		// mass, and a massless ball reads zero and gets nothing.
		this.applyAcceleration(ball, plan.acceleration, plan.flightTime);

		// How far the engine's flight actually is from the plan's, per throw.
		if (DEBUG) watchThrow(ball, plan, character);



		this.heldBalls.delete(character);

		task.delay(PROJECTILE_LIFETIME, () => {
			// A ball that has been caught since it was thrown is not a projectile any
			// more — it belongs to whoever is holding it, and how long it lives is
			// theirs to decide. Without this, the cleanup would take the ball out of a
			// catcher's hand a few seconds after they caught it.
			if (this.isHeld(ball)) return;

			ball.Destroy();
		});
		task.delay(NEW_BALL_DELAY, () => {
			const current = player.Character;
			const humanoid = current?.FindFirstChildOfClass("Humanoid");
			if (current && humanoid && humanoid.Health > 0) {
				this.attachBall(current, player.UserId);
			}
		});
	}

	/** Whether `ball` is in somebody's hand right now. */
	private isHeld(ball: BasePart): boolean {
		for (const [model, held] of this.heldBalls) {
			if (held.ball === ball) {
				if (DEBUG) print(`[Ball] ${ball.Name} is still held by ${model.Name}`);
				return true;
			}
		}

		return false;
	}

	/**
	 * The launch point to plan from.
	 *
	 * Normally the thrower's own, because that is the one their aim guide was
	 * drawn from. Checked rather than trusted: a client can claim any point it
	 * likes, so a claim that does not look like a stale copy of the hand the
	 * server can see is discarded and the muzzle we can see is used instead.
	 */
	private acceptLaunch(own: Vector3, claimed: Vector3 | undefined): Vector3 {
		if (!claimed) return own;

		const offset = claimed.sub(own).Magnitude;
		if (offset <= MUZZLE_TOLERANCE) return claimed;

		warn(`[Ball] ignoring a launch point ${string.format("%.1f", offset)} studs from the thrower's hand`);
		return own;
	}

	/**
	 * Formats a plan's launch for the debug print: the in-plane flight, plus the
	 * sideways part of it when there is one.
	 *
	 * Reports the **commanded** velocity — the one actually written to the ball,
	 * boost included — because that is the input whose effect is worth watching.
	 * The in-plane figure is still the honest one for speed: a curve's sideways
	 * launch is not part of how fast the throw travels, it is what bends it, and
	 * printing the raw vector made a curveball read as the fastest throw in the
	 * game at 265 studs/s when the throw itself was only doing 95.
	 */
	private describeThrow(plan: LaunchPlan, commanded: Vector3): string {
		const sideways = plan.acceleration.Magnitude > 0.001 ? plan.acceleration.Unit : undefined;
		const inPlane = sideways ? commanded.sub(sideways.mul(commanded.Dot(sideways))) : commanded;

		const horizontal = new Vector3(inPlane.X, 0, inPlane.Z);
		const angle = math.deg(math.atan2(inPlane.Y, horizontal.Magnitude));
		const travel =
			`${string.format("%.1f", inPlane.Magnitude)} studs/s at ${string.format("%.1f", angle)}deg`;

		if (!sideways) return travel;

		return `${travel} + ${string.format("%.1f", math.abs(commanded.Dot(sideways)))} sideways`;
	}

	/**
	 * Applies the constant force a curveball flies under.
	 *
	 * This is the part that cannot be done with a velocity. A ball thrown in a
	 * straight line is a ball travelling in a straight line, however hard it is
	 * thrown; bending it takes a force acting *during* the flight. The plan solved
	 * the launch so the drift this force accumulates is cancelled by the time the
	 * ball arrives, which is why the throw still lands on the mark the guide drew.
	 *
	 * A no-op for every other arc, and for a curve that unfurled into an overhead
	 * throw because the aim had no fall to solve with.
	 */
	private applyAcceleration(ball: BasePart, acceleration: Vector3, flightTime: number) {
		if (acceleration.Magnitude < 0.001) return;

		// Parented to the ball, so it can never outlive the projectile it belongs
		// to — the same trick `CollisionIgnore` uses.
		const attachment = new Instance("Attachment");
		attachment.Parent = ball;

		const force = new Instance("VectorForce");
		force.Attachment0 = attachment;
		// Without this the force is applied where the attachment sits, which is
		// not the centre of mass, and it spins the ball like an off-centre
		// thruster instead of curving it.
		force.ApplyAtCenterOfMass = true;
		force.RelativeTo = Enum.ActuatorRelativeTo.World;
		force.Force = acceleration.mul(ball.GetMass());
		force.Parent = attachment;

		// The curve belongs to the flight. Left attached once the ball has landed
		// it would keep shoving it sideways along the ground, at a constant
		// acceleration, for the rest of its lifetime.
		task.delay(flightTime + 0.1, () => force.Destroy());
	}
}
