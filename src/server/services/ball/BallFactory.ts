import { Service } from "@flamework/core";
import { Workspace } from "@rbxts/services";
import { BALL_CONFIG } from "shared/config/ball.config";
import { BALL_NAME, BALL_SIZE } from "shared/constants";
import { SphereService } from "./SphereService";

/**
 * The tag every ball carries.
 *
 * **Must match the `tag` in `BallComponent`'s decorator**, which is the source of truth: the
 * decorator is what turns a ball into a component, and Flamework reads that literal at build time,
 * so it cannot be imported from here. This is therefore a copy rather than a shared constant —
 * exactly as it is in `BallService` and `BallPickupService`, which are the other readers of a name
 * that several files have to agree on.
 *
 * It lives here as well as there because every ball in the game is made by this service, and a
 * ball that arrives without it is a ball that no pickup, no hit and no outline will ever see. One
 * place to forget it would be one place too many, so the factory tags what it builds and there is
 * no call site left that could.
 */
const BALL_TAG = "Ball";

/** What the ball's per-ball gravity force is called, so a stray one can be told apart on a part. */
const GRAVITY_FORCE_NAME = "BallGravity";

/**
 * Makes balls.
 *
 * **Everything about a ball's *construction*, and nothing about its life.** This knows how a
 * dodgeball is shaped, how heavy it is, what it is called and what it is tagged; it does not know
 * what happens next, whether anyone is holding it, whether a round is running, or how long it
 * should live. Those are the callers' business — `BallService` owns hands and throws,
 * `BallSpawnerService` owns the loose balls the arena keeps — which is what lets two services make
 * balls without either of them owning the other.
 *
 * The one thing beyond construction it does is find a hand, because a ball made *for* a hand
 * cannot be placed without one. That is why {@link getRightHand} is public: whoever welds the ball
 * in needs the same hand, and there is no sense in two copies of the rig-type rule.
 */
@Service()
export class BallFactory {
	constructor(private readonly spheres: SphereService) {}

	/**
	 * A ball lying in the world: solid, armed with nothing, and nobody's.
	 *
	 * This is the shape a ball has *before* anyone picks it up, which is why it is the one the
	 * spawner uses — a ball that appears on the floor should be as pickupable as one that has been
	 * dropped, and the two are configured identically on purpose.
	 */
	public createLoose(position: Vector3): BasePart {
		const ball = this.create();

		ball.CanCollide = true;
		ball.Anchored = false;
		ball.Position = position;
		ball.Parent = Workspace;

		this.finish(ball);

		// **After `finish`, and that order is the point.** `finish` builds the gravity force and `setHeld`
		// sizes it from the ball's mass — and `setHeld` sets `Massless` itself, so the line that used to sit
		// above this would now be a second write to the same property from a different place.
		this.setHeld(ball, false);

		return ball;
	}

	/**
	 * A ball made for `model`, or nothing if the model has no hand to hold one.
	 *
	 * **It makes the ball and stops there.** How a ball behaves *in* a hand — where it sits, that it
	 * is massless and non-colliding, that it is nobody's — is not done here, and that is a correction
	 * rather than a preference: a hand-out is only one of four ways a ball ends up in a hand, and the
	 * other two that matter — a catch and a pickup — bring a ball in from the world without ever
	 * coming through this method. Anything a held ball needs therefore has to be done by the one place
	 * all four pass through, which is `BallService.attachToHand`; done here instead, it is done for
	 * hand-outs only, and a caught ball arrives in the hand still configured as a projectile.
	 *
	 * What this decides is whether a ball is worth making at all. Asking here means a model with no
	 * hand costs no part and no tagged component, rather than a ball built and thrown away again.
	 */
	public createInHand(model: Model): BasePart | undefined {
		if (!this.getRightHand(model)) return undefined;

		const ball = this.create();
		this.finish(ball);

		return ball;
	}

	/**
	 * The hand that holds a ball, by rig type: R6 wears "Right Arm", R15 "RightHand".
	 *
	 * Public because the caller that welds the ball in needs the hand this placed it at. Yielding,
	 * on the same terms the rest of the codebase waits on a character: a rig that is still arriving
	 * is not a rig without hands, and a ball that failed to appear because the model was a frame
	 * early would be a bug that only ever shows up on a slow join.
	 */
	public getRightHand(model: Model): BasePart | undefined {
		const humanoid = model.WaitForChild("Humanoid", 10);
		if (!humanoid) return undefined;
		if (!humanoid.IsA("Humanoid")) return undefined;

		const name = humanoid.RigType === Enum.HumanoidRigType.R15 ? "RightHand" : "Right Arm";
		const hand = model.WaitForChild(name, 10);
		if (!hand) return undefined;

		return hand.IsA("BasePart") ? hand : undefined;
	}

	/** A bare sphere with the ball's physical properties, before anything is done with it. */
	private create(): BasePart {
		const ball = this.spheres.createBall(BALL_SIZE, { trail: false });

		/**
		 * What the ball is made of, for the engine's contact solver.
		 *
		 * It matters at the instant of contact and nowhere else — see the note in
		 * `ball.config.ts` for why there is no drag here and why that is deliberate. A ball in
		 * the air is pure ballistics whatever its material says, which is what lets the throw
		 * solver and the client's aim guide agree with the engine about the arc.
		 */
		ball.CustomPhysicalProperties = new PhysicalProperties(
			BALL_CONFIG.DENSITY,
			BALL_CONFIG.GROUND_FRICTION,
			BALL_CONFIG.ELASTICITY,
			1,
			1,
		);

		return ball;
	}

	/**
	 * Puts a ball at rest: not in flight, and nobody's.
	 *
	 * Two attributes with one meaning. `Armed` is what the ball's own component reads to decide
	 * whether it can hurt anything, and `ThrowerId` is who it must not hurt — so either of them left
	 * set from an earlier flight is a ball that damages the hand it has just been picked up with.
	 *
	 * **Public because making a ball and holding one are different events**, and both need this. The
	 * factory calls it on everything it builds; `BallService.attachToHand` calls it on everything that
	 * arrives in a hand, which includes a ball caught mid-throw that is still armed and still named to
	 * whoever threw it. One implementation, so the two can never disagree about what "at rest" is.
	 */
	public makeInert(ball: BasePart): void {
		ball.SetAttribute("Armed", false);
		ball.SetAttribute("ThrowerId", "");
	}

	/**
	 * The last steps of making a ball: its name, its tag, and the state it starts in.
	 *
	 * **The tag goes on before the attributes, and that order is load-bearing.** Tagging is what
	 * creates the `Ball` component, and the component's defaults are written when it is made — so
	 * an attribute set first would be overwritten by the component arriving, and an unarmed ball
	 * would come back armed. Both callers run this after everything positional is already set, so
	 * the component is created onto a finished ball rather than one still being assembled.
	 */
	private finish(ball: BasePart): void {
		ball.Name = BALL_NAME;
		ball.AddTag(BALL_TAG);
		this.makeInert(ball);
		this.applyBallGravity(ball);
	}

	/**
	 * Cancels the part of the world's gravity the ball should not feel.
	 *
	 * **A `VectorForce` because Roblox has no per-part gravity.** `Workspace.Gravity` is global and the only
	 * gravity there is, so a ball that falls under less of it has to push up against the difference itself —
	 * `mass × (world − ball)` upward, which is exactly the force gravity would have applied if this part were
	 * allowed its own. `RelativeTo = World` so the push is always straight up whatever the ball's orientation,
	 * and `ApplyAtCenterOfMass` so it counteracts the pull *exactly* rather than adding a spin as a side
	 * effect of where it pushes.
	 *
	 * **`Attachment0` is the whole of it, and leaving it out is the fault this comment exists to stop.** A
	 * `VectorForce` pushes on the attachment it is given and on nothing else: one with no `Attachment0` is a
	 * live instance that applies precisely no force, with no error and nothing in any log. Shipped that way,
	 * the ball fell at `Workspace.Gravity` while the plan, the aim guide, the throw probe and the server's own
	 * solve all assumed `BALL_GRAVITY` — and the only thing on screen was a throw that hit the floor short of
	 * the wall it was aimed at, with the probe measuring the flight as roughly two-and-a-half times too heavy
	 * at every sample. `BallService.applyAcceleration` builds the curve's force the same way, and is the
	 * working example to copy from.
	 *
	 * **The mass is read by `setHeld`, not here.** Force in Roblox is mass × acceleration, and the mass that
	 * matters is the ball's *own*: a held ball is `Massless` and welded into the character's assembly, so a
	 * force sized against it pushes on the character instead. See {@link setHeld}, which is also the only
	 * thing that turns the force on.
	 *
	 * **Nothing is added when the ball's gravity is at or above the world's**: a zero force would still be an
	 * instance and a physical object's worth of bookkeeping for no effect, and a ball meant to fall *heavier*
	 * than the world cannot be done this way at all — that needs mass, not a force. So the config can only
	 * lower gravity, and a value above `Workspace.Gravity` silently means "the world's".
	 */
	private applyBallGravity(ball: BasePart): void {
		if (Workspace.Gravity - BALL_CONFIG.BALL_GRAVITY <= 0) return;

		// Parented to the ball, so it can never outlive the projectile it belongs to — the same trick
		// `applyAcceleration` and `CollisionIgnore` use.
		const anchor = new Instance("Attachment");
		anchor.Parent = ball;

		const force = new Instance("VectorForce");
		force.Name = GRAVITY_FORCE_NAME;
		force.Attachment0 = anchor;
		force.RelativeTo = Enum.ActuatorRelativeTo.World;
		force.ApplyAtCenterOfMass = true;
		// **Disabled and unsized until `setHeld` says the ball is its own.** Disabled is the honest default:
		// the first thing that happens to most balls is that they go into somebody's hand.
		force.Force = new Vector3();
		force.Enabled = false;
		force.Parent = ball;
	}

	/**
	 * Frees a ball from a hand, or takes it back — **the one place `Massless` and the ball's own gravity are
	 * written together**, so that the two can never come apart.
	 *
	 * They are the same question, which is why one call answers both. A held ball is welded into the
	 * character's assembly, so the gravity force — `ballMass × (world − ball)`, parented to the ball — would
	 * otherwise push on the *character*: on this config that is a lift worth a noticeable fraction of the
	 * ball's own weight, every time somebody is carrying one. And the force is `mass × cancelled`, a number
	 * the ball only has once it is out of the hand; a massless one reads zero, exactly as `throwBall` warns
	 * about its own force.
	 *
	 * **What this deliberately is not: a per-frame write.** It runs where a ball changes hands or changes
	 * state, which is a handful of events in a ball's life, and the force between them is constant.
	 */
	public setHeld(ball: BasePart, held: boolean): void {
		ball.Massless = held;

		const cancelled = Workspace.Gravity - BALL_CONFIG.BALL_GRAVITY;
		if (cancelled <= 0) return;

		const force = ball.FindFirstChild(GRAVITY_FORCE_NAME);
		if (!force || !force.IsA("VectorForce")) return;

		if (!held) force.Force = new Vector3(0, ball.GetMass() * cancelled, 0);
		force.Enabled = !held;
	}
}
