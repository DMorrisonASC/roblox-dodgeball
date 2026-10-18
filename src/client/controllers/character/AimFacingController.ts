import { Controller, OnStart } from "@flamework/core";
import Fusion from "@rbxts/fusion-3.0";
import { Players, RunService, Workspace } from "@rbxts/services";
import { AIM_CONFIG } from "shared/config/aim.config";
import { DEBUG_CONFIG } from "shared/config/debug.config";
import { AFTERIMAGE_WINDOW_ATTRIBUTE } from "shared/constants";
import { aiming, predictedLanding } from "../../aiming";
import { isMobile } from "../../platform";

/** Prints that this controller mounted, and (behind the log gate) each time a body starts or stops turning. */
const DEBUG = true;

/**
 * How close to the body the aim point has to be before its direction stops being worth using, in studs.
 *
 * **A guard on normalising, not a preference.** The direction is the horizontal offset from the body to the
 * point the throw lands on, and aiming at one's own feet puts that point half a stud away — a vector whose
 * direction is decided by centimetres of foot position rather than by where the player is pointing. Below
 * this the camera's own forward is used instead, which is where the player is looking and is never a
 * degenerate answer. Half a stud is well inside the body's own radius, so no aim a player can mean is
 * reached by it.
 */
const MIN_AIM_DISTANCE = 0.5;

/**
 * **The body turns onto the aim while a throw is being charged, and turns back when it is not.**
 *
 * *"Face the player's body at the aim while they charge a throw."* This is the client half of a thing the
 * NPCs already do on the server — `ThrowBehavior.aimAt` — and it is deliberately **not** that code: a rig's
 * facing is the server's, because the server owns the rig, while a player's character is simulated by their
 * own client and a pose that had to make a round trip before it turned would be a pose the player is already
 * finished with.
 *
 * **The signal is `aiming`, which is the charge and nothing else.** That flag is written in exactly one place
 * in the game — `ThrowController.updateGuide`, from the same expression that decides whether the guide is
 * drawn — and it is written on *both* transitions by the same line, because a Fusion `Value` given the value
 * it already holds does nothing. So there is no "cancel" to remember here: a release, a drop, a death and a
 * round boundary that destroys the ball all arrive as the same edge, a frame later, because the ball leaving
 * the hand is what makes `charging` false. **A second release path in this file would be the bug**: the four
 * cancellations live in `ThrowController` and it already reports them through this one flag.
 *
 * **Two different aim directions, and neither of them is a second ray.**
 *
 * - **A desktop aims with the cursor**, and the direction the body is turned onto is the point the drawn arc
 *   comes to rest — `aiming.ts`'s `predictedLanding`, published from `updateGuide` as `arc.contact ??
 *   arc.landing`, which is the same expression the landing marker is placed from. **That is the whole reason
 *   it is read rather than recomputed**: a second ray here would agree with the arc today and drift from it
 *   the first time the arc's radius, gravity or exclusion list changed, and the body would then be facing
 *   somewhere the ball is not going — the failure mode the aim preview was built to end.
 * - **A touch client aims along the camera's axis**, because it has no cursor (`ThrowController
 *   .getThrowDirection` makes the same call for the same reason). So the facing is the camera's forward
 *   flattened onto the ground — which is exactly what the custom shift lock already points at, so a phone
 *   player turns their view and the body follows it, with nothing to touch.
 *
 * The point is deliberately read **after** the arc is solved rather than from the raw crosshair: aiming at
 * the sky has a landing point far away and a direction that is still the direction the player is looking,
 * while aiming at a nearby wall has a landing point where the ball stops — and that is the direction the
 * throw will actually travel.
 *
 * **`AlignOrientation` and not a per-frame `CFrame` write, and the project has already had this argument
 * twice.** `DodgeService` turns a *player's* body with an `AlignOrientation` on an attachment at the root —
 * the exact construction below, at `Responsiveness = 50`, for a dash — and `ThrowBehavior.aimAt` and
 * `WalkToJoinPadBehavior` do the same for rigs, with the note that a constraint "turns a body over *time*,
 * which is what makes the turn smooth". A per-frame `HumanoidRootPart.CFrame` write is the alternative and
 * it costs two things: it **snaps** rather than turns, because a write is a pose and not a torque, and it
 * moves the root the camera is placed against — which is the property `ShiftLock` reads every frame to keep
 * its shoulder offset camera-relative. Adding a per-frame root write to a game that already smooths that
 * offset would be introducing motion where the complaint was about motion.
 *
 * **`AutoRotate = false` for the duration, and the previous value is restored rather than assumed.** With it
 * on, the humanoid turns the body toward `MoveDirection` every step and would win the argument with the
 * constraint for as long as a player was walking; with it off, the constraint is the only writer and the body
 * is free to face one way while the legs go another. `ThrowBehavior.aimAt` captures and restores the same
 * property for the same reason, and so does `WalkToJoinPadBehavior` — **the restore is to what was there, not
 * to `true`**, because a client-side script is not the only thing that can have switched it off.
 *
 * **What the player gets while walking and aiming is a strafe, and that is a decision rather than an
 * oversight.** With `AutoRotate` off and the facing held on the aim, the body keeps pointing at the target
 * while the humanoid walks it in whichever direction the keys say — so a player can circle a target with
 * their shoulder to it. That is what "face the aim while charging" means, it is what the NPCs do, and the
 * alternative — facing the movement direction and only turning when standing still — would make the feature
 * invisible in exactly the situation it was asked for. Whether strafing should be *allowed* is a gameplay
 * question for the user, not a technical one; nothing here restricts it.
 *
 * **Not touched, checked rather than assumed.** `LocomotionAnimationController` decides which clip plays from
 * `Humanoid.MoveDirection` and `Humanoid.WalkSpeed` — not from the root's `CFrame` — so a body facing the
 * aim while strafing still plays its walk and run clips. The throw's direction is not read from the body
 * anywhere (`ThrowController.getThrowDirection` uses the camera, and `planChargedThrow` flattens that), so
 * turning the body changes what the player *sees* and nothing about where the ball goes.
 */
@Controller()
export class AimFacingController implements OnStart {
	private readonly player = Players.LocalPlayer;

	/** The body whose facing this controller is holding, or nothing when it is not holding one. */
	private character?: Model;

	/** That body's humanoid — the thing `AutoRotate` belongs to. */
	private humanoid?: Humanoid;

	/** What `AutoRotate` was before this file switched it off. See the class doc for why it is captured. */
	private previousAutoRotate?: boolean;

	/** The attachment the constraint measures from. One per hold, destroyed with it. */
	private attachment?: Attachment;

	/** The constraint doing the turning, or nothing when no pose is being held. */
	private balance?: AlignOrientation;

	/** The aiming flag as last acted on, so the two edges print once each rather than once a frame. */
	private wasAiming = false;

	/**
	 * **The direction the body was last being turned onto**, kept so the release can finish the turn itself.
	 *
	 * The constraint is a *pull* — `Responsiveness = 30` takes a few frames to arrive — so a throw released a
	 * tenth of a second into the charge leaves a body that is still halfway round, and the ball goes out of a
	 * shoulder pointing somewhere else. `release` reads this and writes the orientation directly, once, which
	 * is the only way to guarantee the pose is right at the instant the ball leaves.
	 *
	 * Cleared on every release, so it can never be applied to a later throw: it is the *last* frame's aim of
	 * *this* hold, and a stale copy is the one thing worse than no copy.
	 */
	private lastDirection?: Vector3;

	public onStart(): void {
		// **`Heartbeat` rather than `RenderStepped`, and the order is the reason.** `ThrowController`
		// rebuilds the arc in a `RenderStepped` connection; reading `predictedLanding` from the same signal
		// would make this controller's answer depend on which of the two connected first, which is
		// Flamework's ignition order and not a fact either file can see. `Heartbeat` runs after the render
		// steps of the same frame, so the landing point read here is always this frame's.
		//
		// **Per frame and not on an interval**, because the thing being held is a pose and a pose that
		// stopped being updated would be a body facing where the player aimed a moment ago. The cost when
		// nothing is charged is one `peek` and one early return — see `step`.
		RunService.Heartbeat.Connect(() => this.step());

		// The line that says this controller ran at all, for the reason every file in this project prints
		// one: "nothing happens" has two causes — never started, or started and found nothing to do — and
		// this is the line that tells them apart. `[Facing]` rather than `[Aim]` so it sits beside
		// `AimTargetController`'s line in the output and does not read as a duplicate of it.
		if (DEBUG) print(`[Facing] up — the body turns onto the aim while a throw is charged`);
	}

	/** One frame: hold the pose, or let go of it. */
	private step(): void {
		const aimingNow = Fusion.peek(aiming);
		if (!aimingNow) {
			this.release();
			return;
		}

		const character = this.player.Character;
		const humanoid = character?.FindFirstChildWhichIsA("Humanoid");
		const root = humanoid?.RootPart;

		// **A charge with nothing to turn is not an error, it is a gap between frames.** The ball leaving the
		// hand, a death and a respawn all pass through here with `aiming` still true for a frame; falling back
		// to "nothing to hold" means the next frame with a body builds a fresh constraint instead of writing
		// the aim into a root that is in the middle of being destroyed.
		if (!character || !humanoid || !root) {
			this.release();
			return;
		}

		// **A body in a dodge belongs to the dodge.** `DodgeService` already puts an `AlignOrientation` on
		// this root for the length of the dash — `DodgeBalance`, at `Responsiveness = 50` — and two
		// constraints pulling one body is the same class of fault as two scripts writing one property: the
		// aim's turn would be added to the dash's and the body would try to face two directions at once. The
		// window that says a dash is running is already published on the body for exactly this kind of read
		// (`CameraZoomController` follows the same attribute for the same reason), so this stands down while
		// it is open and picks the aim back up on the frame it closes. Nothing is lost: a player dodging with
		// a throw charged is mid-dash for a fraction of a second, and the pose is re-derived every frame
		// rather than animated, so there is no state to restore.
		if (character.GetAttribute(AFTERIMAGE_WINDOW_ATTRIBUTE) === true) {
			this.release();
			return;
		}

		const direction = this.aimDirection(root);
		if (direction === undefined) {
			this.release();
			return;
		}

		// **A body that is not the one being held gets a fresh hold**, which is the respawn case: the
		// constraint and the attachment live on a root that has been destroyed, so there is nothing to
		// reuse and nothing to clean up but the bookkeeping.
		if (this.character !== character) {
			this.release();
			this.hold(character, humanoid, root);
		}

		if (this.balance === undefined) return;

		// **`root.Position` for both ends, so this is a yaw and nothing else.** Same construction as
		// `DodgeService`'s dash, and for its reason: two points at the same height cannot describe a pitch,
		// so the body stays upright and is never leaned into the ground by an aim at the floor.
		this.balance.CFrame = CFrame.lookAt(root.Position, root.Position.add(direction));

		// Kept for `release`: the turn the constraint is still making is finished in one write there, because
		// the ball can leave before the constraint has arrived. See {@link lastDirection}.
		this.lastDirection = direction;

		if (!this.wasAiming) {
			this.wasAiming = true;
			if (DEBUG && DEBUG_CONFIG.VERBOSE_LOGS) print(`[Facing] ${character.Name}: turning onto the aim`);
		}
	}

	/**
	 * The horizontal direction the body should face, or nothing when there is no honest answer.
	 *
	 * **Flat and normalised before it leaves here**, and the flattening is the difference between a facing
	 * and a lean: a point on the ground is at the body's own feet height, but the camera's forward is
	 * unflattened and would tip the body into the floor by however much the player is looking down.
	 */
	private aimDirection(root: BasePart): Vector3 | undefined {
		const camera = Workspace.CurrentCamera;
		if (!camera) return undefined;

		// **The touch path, first and unconditionally.** A phone has no cursor, so the aim point is whatever
		// the arc solved for and the *view* is what the player is turning — `ThrowController` makes the same
		// distinction for the same reason, and this keeps the body and the throw on the same side of it.
		if (isMobile()) return flatUnit(camera.CFrame.LookVector);

		// **The desktop path: where the throw lands**, which is the arc's own answer rather than a second
		// ray. See the class doc for why a landing point and not the crosshair.
		const landing = Fusion.peek(predictedLanding);
		if (landing === undefined) return flatUnit(camera.CFrame.LookVector);

		const offset = new Vector3(landing.X - root.Position.X, 0, landing.Z - root.Position.Z);

		// Aiming at one's own feet: the direction is decided by centimetres rather than by where the player
		// is pointing, so the view is the better answer. See `MIN_AIM_DISTANCE`.
		if (offset.Magnitude < MIN_AIM_DISTANCE) return flatUnit(camera.CFrame.LookVector);

		return offset.Unit;
	}

	/** Puts the constraint on a body and takes its `AutoRotate` away. See the class doc for the construction. */
	private hold(character: Model, humanoid: Humanoid, root: BasePart): void {
		this.character = character;
		this.humanoid = humanoid;
		this.previousAutoRotate = humanoid.AutoRotate;
		humanoid.AutoRotate = false;

		const attachment = new Instance("Attachment");
		attachment.Name = "AimFacingAttachment";
		attachment.Parent = root;

		const balance = new Instance("AlignOrientation");
		balance.Name = "AimFacing";
		balance.Attachment0 = attachment;
		// One attachment, so `CFrame` below is the goal *in world space* — the same mode `DodgeService` uses
		// for a dash and `ThrowBehavior` for a rig's windup.
		balance.Mode = Enum.OrientationAlignmentMode.OneAttachment;
		balance.MaxTorque = 1e6;
		// The one number that is a feel decision: see `AIM_CONFIG.AIM_FACING_RESPONSIVENESS`.
		balance.Responsiveness = AIM_CONFIG.AIM_FACING_RESPONSIVENESS;
		// Unopposed, so the constraint does not have to out-pull the humanoid's own balance — there is no
		// balancing state left to out-pull once `AutoRotate` is off, and `DodgeService` makes the same choice.
		balance.RigidityEnabled = false;
		balance.Parent = root;

		this.attachment = attachment;
		this.balance = balance;
	}

	/**
	 * **Finishes the turn the constraint was still making, in one write, on the frame the pose is dropped.**
	 *
	 * **This is the fix for "it throws the ball before the body rotates".** A short charge is the whole of the
	 * case: the constraint pulls the body round over several frames, and a release a tenth of a second in
	 * catches it a third of the way there — so the ball leaves a shoulder pointing somewhere the player was
	 * not aiming, and then the body arrives afterwards, which reads as the animation running late. Nothing in
	 * the release path could have known that from the constraint's state, which is why this keeps the last aim
	 * direction itself.
	 *
	 * **Only when the body is not already there**, so the ordinary release — the constraint having arrived a
	 * frame or more ago — writes nothing and cannot re-aim a body that was already correct. The test is a dot
	 * product against a cosine rather than an angle because it needs no `math.floor` to be right; **the
	 * threshold is 5°, a placeholder**, and it exists so the last frame's own noise cannot write a CFrame for a
	 * difference nobody can see.
	 *
	 * `CFrame.lookAt` with both points at the root's height, for `hold`'s reason: two points at one height
	 * cannot describe a pitch, so this is a yaw and the body stays upright.
	 */
	private snapOntoAim(): void {
		const direction = this.lastDirection;
		const root = this.humanoid?.RootPart;

		if (direction === undefined || root === undefined || root.Parent === undefined) return;

		if (root.CFrame.LookVector.Dot(direction) >= math.cos(math.rad(5))) return;

		root.CFrame = CFrame.lookAt(root.Position, root.Position.add(direction));
	}

	/**
	 * Lets go of the pose: the constraint goes, and the body is handed back to its own steering.
	 *
	 * **Idempotent**, because it is called on every frame no throw is charged — the ordinary case — and on
	 * every path that loses the body. It is also called *before* a new hold, so a respawn cannot leave two
	 * constraints on two roots with one of them orphaned.
	 *
	 * **`AutoRotate` is restored to the captured value and only when a body is still there to write it to.**
	 * The humanoid may have been destroyed between the charge and this call, and a write to a destroyed
	 * instance is at best a no-op and at worst an error in the log during a respawn — the next body starts
	 * from its own value anyway, which is why `WalkToJoinPadBehavior` treats the same case the same way.
	 */
	private release(): void {
		if (this.wasAiming) {
			this.wasAiming = false;
			this.snapOntoAim();
			if (DEBUG && DEBUG_CONFIG.VERBOSE_LOGS) print(`[Facing] released — back to the movement direction`);
		}

		this.lastDirection = undefined;

		if (this.balance !== undefined) {
			this.balance.Destroy();
			this.balance = undefined;
		}

		if (this.attachment !== undefined) {
			this.attachment.Destroy();
			this.attachment = undefined;
		}

		const humanoid = this.humanoid;
		if (humanoid !== undefined && humanoid.Parent !== undefined && this.previousAutoRotate !== undefined) {
			humanoid.AutoRotate = this.previousAutoRotate;
		}

		this.character = undefined;
		this.humanoid = undefined;
		this.previousAutoRotate = undefined;
	}
}

/**
 * `vector` with its Y dropped and the result normalised, or nothing when there is nothing left.
 *
 * **The normalise is what the constraint wants** — `CFrame.lookAt` with two points derives the direction and
 * does not care about length — and the nothing is the case of a camera pointing straight down, where the
 * flattened vector is zero and there is no horizontal direction to face. Returning `undefined` rather than a
 * default keeps the caller's "nothing to do" branch in one place, which is why `aimDirection`'s two fallbacks
 * are the only places a default is chosen.
 */
function flatUnit(vector: Vector3): Vector3 | undefined {
	const flat = new Vector3(vector.X, 0, vector.Z);
	if (flat.Magnitude < 1e-3) return undefined;

	return flat.Unit;
}
