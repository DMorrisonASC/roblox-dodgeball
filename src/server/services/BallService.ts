import { Service, OnStart } from "@flamework/core";
import { Players, ReplicatedStorage, Workspace } from "@rbxts/services";
import { BALL_NAME, BALL_SIZE, THROWER_TOKEN } from "shared/constants";
import { BALL_CONFIG } from "shared/config/ball.config";
import { CollisionIgnore } from "shared/CollisionIgnore";
import { REMOTES } from "shared/remotes";
import { planPlayerThrow, getThrowMuzzle } from "shared/throw";
import { LaunchPlan, ThrowArc } from "shared/Trajectory";
import { TrailEffect } from "shared/TrailEffect";
import { DevService } from "../dev/DevService";
import { SphereService } from "./SphereService";
import { watchThrow } from "../ThrowProbe";

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
	 * handed-out one does — otherwise it could not be thrown afterwards. The only
	 * thing that genuinely needs a `Player` is the throw remote's handler, which
	 * recovers the character from it; everything else is model work.
	 */
	private readonly heldBalls = new Map<Model, HeldBall>();

	constructor(private readonly spheres: SphereService, private readonly dev: DevService) {
		// **Switching `InfiniteBalls` on hands the dev a ball, if their hand is empty.**
		//
		// The refill at the end of a throw is not enough on its own. A dev whose hand is
		// empty has nothing to throw, so a flag that only applies *at the end of a throw*
		// can never take effect on one — and an empty hand is exactly the state a dev is
		// in when they reach for this flag, having thrown the ball they had and wanting
		// another. So the flag answers on the spot, through the same call the hand-out
		// uses. Switching it off does nothing: the ball already in the hand is theirs to
		// throw either way.
		this.dev.onFlagChanged("InfiniteBalls", (player, on) => {
			if (DEBUG) print(`[Ball] ${player.Name}: InfiniteBalls ${on ? "on" : "off"}`);

			if (!on) return;

			const character = player.Character;
			if (!character || this.getHeldBall(character)) return;

			this.attachBall(character);

			if (DEBUG) print(`[Ball] ${character.Name}: handed a ball by InfiniteBalls`);
		});
	}

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

			this.throwForPlayer(player, target, chosen, typeIs(claim, "Vector3") ? claim : undefined);
		});

		Players.PlayerRemoving.Connect((player) => {
			const character = player.Character;
			if (character) this.heldBalls.delete(character);
		});
	}

	/**
	 * Puts a ball in `model`'s hand.
	 *
	 * Keyed on the **model**, like everything else here, so this is one call for a
	 * player's character and for an NPC alike. What differs between them is the
	 * token on the model, which this does not touch, and who arranges for a *new*
	 * model to be handed a ball when the old one dies — and that is a fact about
	 * players, so it lives in `JoinService`.
	 *
	 * This deliberately does NOT use a Tool. A Tool's handle is gripped by the
	 * engine, and in this project that grip never actually forms (the character
	 * ends up with no `RightGrip`), so the unanchored ball falls straight out of
	 * the world. Welding the ball to the hand ourselves is deterministic.
	 */
	public giveBall(model: Model): void {
		this.attachBall(model);
	}

	/**
	 * Welds `ball` into `model`'s hand as a **catch**: a ball taken out of the air.
	 *
	 * Named for the intent rather than the mechanism, which is
	 * {@link attachToHand}'s. The two are one line apart today and are kept apart
	 * on purpose: the moment a catch grows something a pickup does not — an
	 * animation, a grace frame, its own telemetry — the seam is already there, and
	 * until then it costs nothing.
	 */
	public catchBall(model: Model, ball: BasePart): boolean {
		if (!this.attachToHand(model, ball)) return false;

		print(`[Ball] ${model.Name} caught a dodgeball`);

		return true;
	}

	/**
	 * Welds `ball` into `model`'s hand as a **pickup**: a ball collected off the
	 * ground.
	 *
	 * The same hand either way, which is the point: a picked-up ball is thrown by
	 * the same call as a caught one, because by the time it is in the hand there is
	 * nothing left to tell the two apart.
	 */
	public pickupBall(model: Model, ball: BasePart): boolean {
		if (!this.attachToHand(model, ball)) return false;

		print(`[Ball] ${model.Name} picked up a dodgeball`);

		return true;
	}

	/**
	 * Lets go of whatever `model` is holding, leaving the ball in the world.
	 *
	 * Keyed on the **model**, like every other hand operation here, so any model
	 * that can hold a ball can drop one. The ball leaves the hand limp — unarmed,
	 * and non-colliding with the model it came out of — because a dropped ball is
	 * scenery, not a projectile.
	 *
	 * Returns whether there was anything to drop.
	 */
	public dropBall(model: Model): boolean {
		const held = this.heldBalls.get(model);
		if (!held) return false;

		const ball = held.ball;

		// Out of the hand first, so the weld is not fighting the reparent below.
		ball.FindFirstChild(GRIP_NAME)?.Destroy();

		// Nobody's ball now: unarmed, because an armed ball is a live projectile and
		// would hurt whoever walked into it lying there.
		ball.SetAttribute("Armed", false);
		ball.Parent = Workspace;
		ball.Massless = false;
		ball.CanCollide = true;

		// It becomes solid exactly where the hand was, which is inside the model, and
		// the engine settles that overlap by shoving whatever is lighter. Without
		// this, the old thrower-push bug comes back wearing a different hat.
		CollisionIgnore.between(ball, model);

		this.heldBalls.delete(model);

		// Loose balls are cleaned up on the clock thrown ones are. A catching NPC
		// drops every ball it takes, so without this the map collects scenery for the
		// rest of the session; the `isHeld` guard leaves a ball that has since been
		// caught to its new owner.
		task.delay(BALL_CONFIG.LIFETIME_SECONDS, () => {
			if (this.isHeld(ball)) return;

			ball.Destroy();
		});

		if (DEBUG) print(`[Ball] ${model.Name} dropped a dodgeball`);

		return true;
	}

	/**
	 * Creates a ball and welds it into the hand of the given model.
	 *
	 * A hand-out is the one case where the ball is live from the moment it exists,
	 * so it is armed *after* the attach: attaching is what creates the component,
	 * and the component's defaults would write over anything set before it.
	 *
	 * The model's token is not stamped either, because this does not know who it is
	 * handing a ball to and should not have to: whoever knows stamps it —
	 * `JoinService` for a joining player, `NpcService` for a rig. The ball reads it
	 * back off the model at release, see `tokenOf`.
	 */
	private attachBall(model: Model) {
		const ball = this.spheres.createBall(BALL_SIZE, { trail: false });
		if (!this.attachToHand(model, ball)) return;

		ball.SetAttribute("Armed", true);
	}

	/**
	 * The one place a ball is put into a hand: the weld, the inert state, nobody's
	 * name on it, and an entry in `heldBalls`.
	 *
	 * Shared by the hand-out, the refill after a throw, a catch and a pickup, so all
	 * four produce the same thing in the same state: a ball welded into a hand,
	 * massless and non-colliding, with its trail switched off until it flies again.
	 *
	 * Reached through {@link catchBall} or {@link pickupBall} rather than directly,
	 * so a caller says which it meant — the hand itself does not care, which is what
	 * keeps one weld in the game instead of four.
	 */
	private attachToHand(model: Model, ball: BasePart): boolean {
		const hand = this.getRightHand(model);
		if (!hand) {
			warn(`[Ball] ${model.Name}: could not find a right hand to hold the ball`);
			ball.Destroy();
			return false;
		}

		// Respawn safety, and catching safety: whatever this model was already
		// holding goes, so two balls can never end up sharing one hand.
		this.heldBalls.get(model)?.ball.Destroy();
		this.heldBalls.delete(model);

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
		ball.Parent = model;
		ball.AddTag("Ball");
		// Attributes after the tag, never before: tagging is what creates the
		// component, and its defaults would write over anything set first.
		//
		// Armed false and the thrower blank, because a ball in a hand is nobody's and
		// nothing's: that is what a hand-out, a catch and a pickup have in common.
		// `throwBall` arms it and names its thrower at release, and `attachBall` arms
		// it early because a hand-out is live from the moment it exists.
		ball.SetAttribute("Armed", false);
		ball.SetAttribute("ThrowerId", "");
		this.setPromptEnabled(ball, false);

		const grip = new Instance("WeldConstraint");
		grip.Name = GRIP_NAME;
		grip.Part0 = hand;
		grip.Part1 = ball;
		grip.Parent = ball;

		this.heldBalls.set(model, { ball, trail });

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

	/**
	 * Throws whatever `model` is holding, at `target`.
	 *
	 * Keyed on the **model**, so an NPC's throw is this function with a different
	 * model and target in it rather than a second copy of the throw. The only
	 * player-shaped thing left in here is the remote handler below — the one place a
	 * `Player` exists to take a character from — plus the dev check that lets a
	 * flagged dev throw with an empty hand.
	 *
	 * **Throwing empties the hand.** A ball comes from the hand-out on join, from a
	 * pickup, from a catch — or, for a dev with `InfiniteBalls`, from the throw they
	 * just made, which is the one throw in the game that answers itself. Everyone else
	 * fetches the next one, which is what the loose balls on the floor are for.
	 *
	 * Returns whether a ball went. An empty hand is not an error: a behavior may
	 * ask while there is nothing to throw.
	 */
	public throwBall(model: Model, target: Vector3, arc: ThrowArc, claimedLaunch?: Vector3): boolean {
		const held = this.heldBalls.get(model);
		if (!held || held.ball.Parent !== model) return false;

		const ball = held.ball;

		// Release the ball from the hand before launching it.
		ball.FindFirstChild(GRIP_NAME)?.Destroy();
		// Armed and attributed at the moment of release rather than when the ball
		// was made: a caught ball has been through somebody else's hand since, and
		// this throw is what decides whose ball it is now. The immunity check and
		// the catch check both read this one token.
		ball.SetAttribute("Armed", true);
		ball.SetAttribute("ThrowerId", this.tokenOf(model));
		this.setPromptEnabled(ball, true);
		// Airborne now, so the trail can start drawing behind it.
		held.trail.setEnabled(true);

		// The client runs this exact same plan to draw its aim guide, so the throw
		// and the predicted arc can never disagree — which only holds while both
		// sides solve from the same launch point, see `planPlayerThrow`.
		const releasePosition = ball.Position;
		const ownLaunch = getThrowMuzzle(model);
		const launch = this.acceptLaunch(ownLaunch, claimedLaunch);
		const plan = planPlayerThrow(model, target, arc, launch);

		// What actually goes on the ball: the solve, plus the launch boost that
		// covers the engine's own vertical loss. See BALL_CONFIG.THROW_VERTICAL_BOOST —
		// the guide draws the solve, so this is what makes the ball fly the drawn
		// line instead of sagging below it.
		const commanded = plan.velocity.add(new Vector3(0, BALL_CONFIG.THROW_VERTICAL_BOOST, 0));

		if (DEBUG) {
			print(
				`[Ball] ${model.Name}: ${plan.arc} ${this.describeThrow(plan, commanded)}, ` +
					`release ${releasePosition} -> launch ${plan.origin}` +
					` (${string.format("%.2f", launch.sub(ownLaunch).Magnitude)} studs from our own)`,
			);
		}

		// The thrower can never be hit by their own ball. Without this, a throw
		// aimed back across the body clips it, and the engine resolves that
		// overlap the only way it can — by shoving the player. Ball size and
		// muzzle distance only ever changed how hard that shove was.
		CollisionIgnore.between(ball, model);

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
		if (DEBUG) watchThrow(ball, plan, model);



		this.heldBalls.delete(model);

		task.delay(BALL_CONFIG.LIFETIME_SECONDS, () => {
			// A ball that has been caught since it was thrown is not a projectile any
			// more — it belongs to whoever is holding it, and how long it lives is
			// theirs to decide. Without this, the cleanup would take the ball out of a
			// catcher's hand a few seconds after they caught it.
			if (this.isHeld(ball)) return;

			ball.Destroy();
		});

		// A dev with `InfiniteBalls` never runs out: the throw they just made is answered
		// with another ball, by the same call the first one arrived by. This is the one
		// throw in the game that refills itself — every other thrower fetches its next
		// ball, which is what the loose balls on the floor are for. It is not the only way
		// in: switching the flag on gives an empty hand a ball too, which is what a dev who
		// has just thrown their last one actually needs. See the constructor.
		if (this.hasInfiniteBalls(model)) {
			this.attachBall(model);

			if (DEBUG) print(`[Ball] ${model.Name}: refilled by InfiniteBalls`);
		}

		return true;
	}

	/**
	 * The player path: what the throw remote's handler calls.
	 *
	 * A player is not a special kind of thrower, just the only one with a `Player`
	 * behind it — so there is nothing here but recovering the character and handing
	 * it to {@link throwBall} as the model. The refill belongs to the throw itself,
	 * which is what makes it the same refill for an NPC.
	 */
	private throwForPlayer(player: Player, target: Vector3, arc: ThrowArc, claimedLaunch?: Vector3) {
		const character = player.Character;
		if (character) this.throwBall(character, target, arc, claimedLaunch);
	}

	/**
	 * The thrower token of a model, or `""` when it has none.
	 *
	 * A player's is their `UserId` as text and an NPC's is a GUID — both stamped on
	 * the model itself, so a ball only ever carries a string copy of whichever one
	 * threw it. That is what makes the immunity check in `BallComponent` the same
	 * single comparison for a player and for an NPC.
	 */
	private tokenOf(model: Model): string {
		const token = model.GetAttribute(THROWER_TOKEN);
		return typeIs(token, "string") ? token : "";
	}

	/**
	 * The ball `model` is holding, if any.
	 *
	 * Public for the NPC behaviors, which have to know whether there is anything to
	 * throw. The throwing itself stays {@link throwBall}'s — this only reports.
	 */
	public getHeldBall(model: Model): BasePart | undefined {
		return this.heldBalls.get(model)?.ball;
	}

	/**
	 * Whether `model` is a dev who has switched `InfiniteBalls` on.
	 *
	 * Asking about a dev is the only reason a `Player` appears in this file at all —
	 * the flags live on players, and an NPC never has one, so an NPC simply never
	 * takes this branch.
	 */
	private hasInfiniteBalls(model: Model): boolean {
		const player = Players.GetPlayerFromCharacter(model);
		return player !== undefined && this.dev.getFlag(player, "InfiniteBalls");
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
