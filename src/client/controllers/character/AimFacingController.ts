import { Controller, OnStart } from "@flamework/core";
import Fusion from "@rbxts/fusion-3.0";
import { Players, RunService, Workspace } from "@rbxts/services";
import { AIM_CONFIG } from "shared/config/aim.config";
import { BALL_CONFIG } from "shared/config/ball.config";
import { DEBUG_CONFIG } from "shared/config/debug.config";
import { throwAnimationWindowSeconds } from "shared/animation";
import { AFTERIMAGE_WINDOW_ATTRIBUTE, CATCHING_ATTRIBUTE, THROW_ANIMATION_ATTRIBUTE } from "shared/constants";
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
 * **The body turns onto the aim while a throw is being charged, keeps facing it through the throw's own
 * animation, and turns back when that is done.**
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
 *
 * ## The facing outlives the release
 *
 * **The body keeps facing where it threw until the throw's own animation is done**, which is the third reason
 * this file holds a pose and the one that is about the *past* rather than the present. Without it the throw's
 * follow-through plays on a body that has already turned away: `release` gives `AutoRotate` back, and the
 * humanoid steers a walking player toward `MoveDirection` on the very next step — so the arm goes out of a
 * shoulder pointing at the new heading while the ball has gone along the old one. **The window is
 * `BALL_CONFIG.THROW_ANIMATION_SECONDS`**, the same number the server uses for the `THROW_ANIMATION_ATTRIBUTE`
 * mark and for how long every client dresses a body with the throw clip, so the pose and the clip end together
 * by construction rather than by two numbers agreeing.
 *
 * **It is opened by the charge's falling edge and extended by the server's mark**, which is not belt and braces
 * but the fix for a one-frame hole: the charge ends on this client the instant the player lets go, while the
 * mark is written on the server and arrives a frame or three later. Releasing on the falling edge and re-holding
 * when the mark turned up would hand the body back to `AutoRotate` for exactly the frames the animation begins
 * in. See {@link followThroughUntil} for the whole argument, including what a *cancelled* charge costs.
 *
 * **The direction held is the aim's, not the camera's**, which is the point: a player who releases and
 * immediately swings the view is still finishing a throw at the old heading, and re-deriving the facing from the
 * view would make the body turn into the next throw while the last one is being animated. Nothing recomputes it
 * during the window — `lastDirection` is simply kept, and {@link release} is what clears it.
 *
 * **A rig does the same thing, from the other side of the wire.** `ThrowBehavior.holdAimThroughThrow` keeps its
 * `AlignOrientation` up for the same window instead of taking it down at the release, so an NPC's follow-through
 * and a player's are one rule applied to two bodies.
 *
 * ## A catch is the same pose, from a second signal
 *
 * **A body waiting for a ball turns onto the camera exactly as a body aiming a throw turns onto the aim**, and
 * reusing this controller rather than writing a second one is the point: the constraint, the `AutoRotate`
 * capture-and-restore, the dodge stand-down and the snap-on-release are all the same problem, and a second copy
 * of them would be a second place for the restore to be forgotten.
 *
 * **The signal is `CATCHING_ATTRIBUTE`**, the server's published window — not a local flag. A press the server
 * refuses (a ball in the hand, a dodge lockout, a freeze) opens no window and therefore turns nothing, which is
 * the difference between a body reacting to a request and a body reacting to the game. The attribute is cleared
 * by `CatchService.consume`, the one path every close goes through, so the pose ends with the window on every
 * exit including a death; and `WalkSpeedService` asks the same question every frame, which is what makes the
 * attribute disappear on the frame the window lapses rather than on the next ball.
 *
 * **The direction is the camera's forward**, not `predictedLanding`: a catch has no arc — a catch needs an empty
 * hand, so a throw cannot be charged at the same time — and the ball being waited for may be anywhere. The view
 * is where the player is looking, which is the answer the touch path above already gives for the same reason.
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

	/**
	 * Whether a pose was being held on the last frame, whatever asked for it — so the two edges print once each
	 * rather than once a frame.
	 *
	 * **Named for the pose rather than for the charge**, because a catch holds the same one: the field answers
	 * "was this file holding the body", which is the question both the edge print and the snap-on-release ask.
	 */
	private wasHolding = false;

	/**
	 * **The direction the body was last being turned onto**, kept so the release can finish the turn itself *and*
	 * so the throw's follow-through knows which way to keep facing.
	 *
	 * The constraint is a *pull* — `Responsiveness = 30` takes a few frames to arrive — so a throw released a
	 * tenth of a second into the charge leaves a body that is still halfway round, and the ball goes out of a
	 * shoulder pointing somewhere else. `release` reads this and writes the orientation directly, once, which
	 * is the only way to guarantee the pose is right at the instant the ball leaves.
	 *
	 * **It also outlives the charge**, which is the whole of the follow-through: when the hold ends the body keeps
	 * this direction until the throw's animation is done — see {@link followThroughUntil} — and nothing re-derives
	 * it in that window, because a body that corrected its aim *after* releasing would be aiming a throw it has
	 * already made.
	 *
	 * Cleared on every release, so it can never be applied to a later throw: it is the *last* frame's aim of
	 * *this* hold, and a stale copy is the one thing worse than no copy.
	 */
	private lastDirection?: Vector3;

	/**
	 * **When the throw's follow-through ends**, as an `os.clock()` reading — the last moment the body keeps facing
	 * the aim it threw along. Zero means there is no follow-through running.
	 *
	 * **A window rather than a flag, because the thing it is waiting for is a replicated attribute and a frame is
	 * not a guarantee.** The charge ends on *this* client the instant the player lets go, while the body's
	 * `THROW_ANIMATION_ATTRIBUTE` is written by the server on the throw it received and arrives a frame or three
	 * later. So "the charge stopped" cannot be followed by "release, then hold again when the mark turns up": for
	 * those frames the body would be handed back to `AutoRotate` mid-throw, which for a walking player is exactly
	 * the snap this feature exists to prevent.
	 *
	 * **So the window opens on the charge's own falling edge** and is long enough to cover both the replication
	 * delay and the animation itself, counting from the release. The attribute then *extends* nothing — it is a
	 * second reason to hold, not a timer — and a throw whose mark arrives late simply keeps the hold alive past
	 * the window rather than re-starting it.
	 *
	 * **The cost, named rather than discovered: a cancelled charge follows through too.** A drop, a death that
	 * leaves the body standing, a round boundary — all of them end the charge, and none of them is a throw. What
	 * that looks like is a body facing where the player was aiming for a fifth of a second after the ball never
	 * left, which is a fifth of a second of a pose nobody is looking at, and the alternative is a per-frame
	 * question this controller cannot answer honestly (nothing local distinguishes "released" from "cancelled";
	 * only the server's mark does, and it is the thing that has not arrived yet).
	 */
	private followThroughUntil = 0;

	/** Whether a charge was held on the last frame, so its falling edge can be detected. */
	private wasAiming = false;

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
		if (DEBUG) {
			print(`[Facing] up — the body turns onto the aim while a throw is charged, and holds it to the end of the throw`);
		}
	}

	/**
	 * **The frame's pose decision, and it is now three questions rather than one:** is a throw being charged, is
	 * a catch window open, and is a throw's own animation still running. All three want the body held and none of
	 * them wants it turned by the humanoid's own steering; the only thing that differs is *which* direction the
	 * turn is onto, decided in {@link aimDirection}.
	 */
	private step(): void {
		const character = this.player.Character;
		const humanoid = character?.FindFirstChildWhichIsA("Humanoid");
		const root = humanoid?.RootPart;

		// **Read before the body is checked**, because the attribute is on the model and a character that has
		// just been replaced is exactly when a stale `true` must not be trusted: `CatchService` clears it through
		// `consume`, and a death closes the window that way, so a new body starts without one.
		const aimingNow = Fusion.peek(aiming);
		const catchingNow = character !== undefined && character.GetAttribute(CATCHING_ATTRIBUTE) === true;

		// **The server's own mark that a throw has left this body** — written by `BallService` for
		// `BALL_CONFIG.THROW_ANIMATION_SECONDS`, for every body that throws rather than for rigs alone. It is what
		// the follow-through below is really waiting for; see {@link followThroughUntil} for why it cannot be the
		// only thing the window is built from.
		const throwingNow = character !== undefined && character.GetAttribute(THROW_ANIMATION_ATTRIBUTE) === true;

		// **The charge's falling edge opens the follow-through window.** It is the one edge that says "the ball
		// has just left" on this client, and it arrives immediately — unlike the attribute above, which is a
		// round trip behind it. The window is measured from here so the body is still held on the frames between
		// the two. See {@link followThroughUntil} for the whole argument and for what a cancelled charge costs.
		//
		// **The length is `BallService`'s own expression for the mark's window**, `math.max` of the constant and
		// the clip's length — a clip longer than `THROW_ANIMATION_SECONDS` extends the animation, and a hold that
		// read only the constant would let the body go a fraction of a second before the arm finished moving.
		if (!aimingNow && this.wasAiming) {
			const window = math.max(BALL_CONFIG.THROW_ANIMATION_SECONDS, throwAnimationWindowSeconds());

			this.followThroughUntil = os.clock() + window;
		}

		this.wasAiming = aimingNow;

		const followingThrough = os.clock() < this.followThroughUntil;

		// **No** reason to hold a pose: let go. A charge, a catch and a throw's follow-through are the only three,
		// and a release that has run out of window, a death, a round boundary and a catch window lapsing all
		// arrive here as the same edge.
		if (!aimingNow && !catchingNow && !throwingNow && !followingThrough) {
			this.release();
			return;
		}

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

		const direction = this.aimDirection(root, aimingNow, catchingNow);
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

		if (!this.wasHolding) {
			this.wasHolding = true;
			if (DEBUG && DEBUG_CONFIG.VERBOSE_LOGS) {
				// **Three names for the three reasons, in the order they outrank each other**, so the log says
				// which one opened the hold rather than only that one did.
				const reason = aimingNow ? "aim" : catchingNow ? "catch" : "throw";

				print(`[Facing] ${character.Name}: turning onto the ${reason}`);
			}
		}
	}

	/**
	 * The horizontal direction the body should face, or nothing when there is no honest answer.
	 *
	 * **Flat and normalised before it leaves here**, and the flattening is the difference between a facing
	 * and a lean: a point on the ground is at the body's own feet height, but the camera's forward is
	 * unflattened and would tip the body into the floor by however much the player is looking down.
	 *
	 * **Three answers, in the order the reasons outrank each other**, which is the shape the hold itself has:
	 * a charge aims, a catch watches, and a follow-through *remembers*.
	 */
	private aimDirection(root: BasePart, aimingNow: boolean, catchingNow: boolean): Vector3 | undefined {
		const camera = Workspace.CurrentCamera;
		if (!camera) return undefined;

		// **A catch with no charge is the view, and it is asked first because it is the newer intent.** A
		// catching body has no arc to read — the hand is empty, so no throw is charged — and the ball it is
		// waiting for may be anywhere, so the only honest direction is where the player is looking. That is the
		// same answer the touch path below gives, for the same reason, on every platform. If a charge and a
		// window are somehow both up for a frame — the press that opens a catch cancels a hold in the same
		// breath — the charge wins, because it has a real aim point to use. **A follow-through loses to both**,
		// for the same reason: it is the only one of the three that is about the past.
		if (!aimingNow) {
			if (catchingNow) return flatUnit(camera.CFrame.LookVector);

			// **The follow-through: the direction the throw was aimed along, not where the player is looking
			// now.** This is the whole of "keep facing that direction": the body holds the last aim the charge
			// produced while the throw's animation plays, so the motion the player sees is the throw they made
			// rather than the turn they started on the next one. Nothing re-derives it — a body that corrected
			// its facing after releasing would be aiming a throw it has already thrown.
			//
			// **The camera is the fallback rather than the answer**, for the case where this controller never
			// held the aim: a client that mounted, or a body replaced, in the middle of a throw's window. The
			// view is the same guess `aimDirection` makes everywhere else when there is no better one.
			return this.lastDirection ?? flatUnit(camera.CFrame.LookVector);
		}

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
		if (this.wasHolding) {
			this.wasHolding = false;
			this.snapOntoAim();
			if (DEBUG && DEBUG_CONFIG.VERBOSE_LOGS) print(`[Facing] released — back to the movement direction`);
		}

		this.lastDirection = undefined;

		// **The follow-through ends when the pose does**, which is what makes the window self-closing rather than
		// something a later frame has to remember to cancel. It matters on the paths that cut a hold short — a
		// dodge, a death, a destroyed character — where the window would otherwise still be in the future on the
		// next frame and would re-open a hold on a body that has just been handed back to its own steering.
		this.followThroughUntil = 0;

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
