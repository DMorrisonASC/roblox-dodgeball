import { Controller, OnStart } from "@flamework/core";
import Fusion from "@rbxts/fusion-3.0";
import { Players, RunService, Workspace } from "@rbxts/services";
import { AFTERIMAGE_WINDOW_ATTRIBUTE } from "shared/constants";
import { CAMERA_ZOOM_CONFIG } from "shared/config/cameraZoom.config";
import { sprinting } from "../../sprinting";

/** Prints once when the controller is up, and on every change of what the camera is following. */
const DEBUG = false; // off for frame time — see shared/config/debug.config.ts

/** How close to the target counts as arrived, in degrees. See {@link CameraZoomController.step}. */
const SETTLED_DEGREES = 0.01;

/**
 * The camera pulls in slightly while the player is sprinting or dodging, and lets go when neither is true.
 *
 * **A narrower field of view, and not a move of the camera.** `Humanoid.CameraOffset` — the property
 * `ShiftLock` and `cameraShake` already write — moves where the camera is aimed *from*, so pulling it towards
 * the body is a dolly: the body gets bigger and the world does not narrow, which reads as the camera being
 * nudged rather than as a change of what the player can see. Narrowing the view is the effect the ask
 * describes, and it has a second property worth naming: **it is a different property on a *different object*
 * from both of those writers**, so a sprint while shift-locked, or a dodge during a throw's shake, needs no
 * co-ordination with either of them. Nothing else in `src/client` writes `FieldOfView` at all.
 *
 * **The sprint fact is the key state; the dodge fact is the server's window.** Those are the two conventions
 * this project already keeps, and each is read where it is already the rule rather than for one rule here:
 *
 * - **Sprinting** comes from `client/sprinting.ts`, which is the key rather than the sprint the server
 *   granted — the choice `LocomotionAnimationController` makes for the running clip, and for its reason: this
 *   is feedback on what the player is *doing*, and the camera and the legs should not disagree about whether
 *   the player is running. It is also what makes the ask literal: the zoom goes back when the key comes up,
 *   not when a stamina pool runs out.
 * - **Dodging** comes from `AFTERIMAGE_WINDOW_ATTRIBUTE` on the player's own body, which the server publishes
 *   from the one function that already knows a window opened. **This file never decides that a dodge
 *   happened**, which is `DodgeController`'s documented rule and `AfterimageController`'s — so a press the
 *   server refuses (a cooldown, no round, no charge) zooms nothing, and nothing here has to re-derive the
 *   server's window from the input and the cooldown stamps, which is the second copy of a server rule this
 *   project does not keep. The cost is named rather than discovered: **the dodge zoom arrives when the window
 *   does, a round trip after the key** — the same lateness the afterimage trail already has, because it is the
 *   same attribute.
 *
 * **Both facts are polled once a frame rather than observed.** `sprinting` is documented as a value nothing
 * observes and this keeps that true — `Fusion.peek` builds no graph edge — and the attribute is bridged into a
 * plain boolean by its own subscription instead of a per-frame `GetAttribute`, because a `GetAttribute` inside
 * a frame loop is a *sample* of a replicated fact rather than a dependency on it. One `peek` and one boolean
 * per frame is the whole cost of the idle case, and the idle case writes nothing: see {@link step}.
 *
 * **Nothing of anybody else's is borrowed, so nothing has to be handed back.** This writes one property it is
 * the only writer of, which is why the release can simply restore the value it captured and why a dodge that
 * ends while the player is dead needs no cleanup beyond clearing a boolean — contrast
 * `client/cameraShake.ts`, which borrows the property `ShiftLock` owns per frame and has to reason about
 * whose value it is holding.
 */
@Controller()
export class CameraZoomController implements OnStart {
	/** The body whose dodge window this client is following. Replaced on every respawn. */
	private character?: Model;

	/** Whether that body's window is open — the server's answer, mirrored. See {@link syncWindow}. */
	private dodging = false;

	/** The field of view the camera rests at, re-read every frame it is at rest. See {@link step}. */
	private restingFieldOfView = 0;

	/** How far in the camera currently is, in degrees. Zero is at rest. */
	private depth = 0;

	public onStart(): void {
		// **No `WaitForChild` and no yield anywhere in this file**, on `AfterimageController`'s argument: a
		// controller's `onStart` runs inside the ignition sequence, so a yield here delays every controller
		// after it. Everything below is either already true or arranged to be noticed when it becomes true.
		const player = Players.LocalPlayer;

		const existing = player.Character;
		if (existing !== undefined) this.watchCharacter(existing);

		player.CharacterAdded.Connect((character) => this.watchCharacter(character));
		player.CharacterRemoving.Connect((character) => this.forgetCharacter(character));

		// A plain `RenderStepped` rather than `BindToRenderStep`, and the difference from `ShiftLock`'s binding
		// is the point: that one has to run *after* the camera has placed itself so the offset it writes is read
		// by the next frame, which is what a priority buys it. A field of view is read by the camera when it
		// places itself, so writing it from any pre-render step means the same one-frame lag whichever step it
		// is — and a step whose whole purpose is ordering would be a priority chosen for nothing. It also
		// carries the frame's `deltaTime`, which is the one clock this file needs and the reason it does not
		// reach for `os.clock` (CPU time in this engine — a trap `ThrowProbe.ts` records).
		RunService.RenderStepped.Connect((delta) => this.step(delta));

		if (DEBUG) {
			print(
				`[CameraZoom] up — ${CAMERA_ZOOM_CONFIG.SPRINT_DEGREES}° while sprinting,` +
					` ${CAMERA_ZOOM_CONFIG.DODGE_DEGREES}° while dodging`,
			);
		}
	}

	/**
	 * Follows one body's dodge window for as long as that body is the local player's.
	 *
	 * **The attribute is read on arrival as well as watched**, because a client can arrive in the middle of a
	 * window: a respawn into a dash, or a reconnect. An edge-only listener would leave such a body with no zoom
	 * until the window closed and opened again.
	 *
	 * The connection made here is deliberately not stored and not disconnected — `AfterimageController`'s
	 * arrangement, and its reason: it belongs to the *character*, which is destroyed on the next death, and a
	 * signal connection to a destroyed instance goes with it.
	 */
	private watchCharacter(character: Model): void {
		this.character = character;

		character.GetAttributeChangedSignal(AFTERIMAGE_WINDOW_ATTRIBUTE).Connect(() => this.syncWindow(character));
		this.syncWindow(character);
	}

	/**
	 * Stops following a body that is leaving the world.
	 *
	 * **Clearing the flag is the whole of the cleanup and it is load-bearing**: a player killed in the middle of
	 * a dodge would otherwise leave `dodging` true for a body that no longer exists, and the camera would hold
	 * the zoom for the rest of the session with nothing left to close the window.
	 */
	private forgetCharacter(character: Model): void {
		if (this.character !== character) return;

		this.character = undefined;
		this.dodging = false;
	}

	/** Mirrors the window onto {@link dodging}. See {@link watchCharacter} for why the attribute is the source. */
	private syncWindow(character: Model): void {
		// A late signal from a body that has already been replaced: the attribute changed for a model this
		// client has stopped caring about, and following it would zoom the camera for a corpse.
		if (character !== this.character) return;

		const open = character.GetAttribute(AFTERIMAGE_WINDOW_ATTRIBUTE) === true;
		if (open === this.dodging) return;

		this.dodging = open;

		if (DEBUG) print(`[CameraZoom] dodge window ${open ? "open" : "closed"}`);
	}

	/**
	 * One frame of the effect: how far the camera *should* be in, how far it is, and the field of view between
	 * them.
	 *
	 * **The field of view is written only while there is something to write**, which is why the at-rest case
	 * returns before touching the camera. That is not an optimisation: it is what makes this controller *not* a
	 * second owner of `Camera.FieldOfView`. At rest it reads the property and writes nothing, so a camera whose
	 * field of view is changed by something else — a place file, a future effect, a developer in the command
	 * bar — keeps that change instead of being quietly reset to a number this file remembered.
	 *
	 * **And that read is what lets the effect survive a replaced camera.** `Workspace.CurrentCamera` is a new
	 * instance when a player respawns, at its own default field of view; a resting value captured once at mount
	 * would be a number belonging to a camera nobody is looking through, and the first sprint after a death
	 * would snap the view. Re-reading it every resting frame costs one property read and adapts to whatever the
	 * camera in hand actually rests at.
	 *
	 * **The wanted depth is the deeper of the two, not their sum** — `cameraZoom.config.ts` argues it — so a
	 * dodge during a sprint holds the sprint's depth rather than deepening it.
	 *
	 * **The approach is exponential and the snap is what makes "at rest" reachable.** Closing a constant
	 * *fraction* of the remaining gap per frame is smooth and has no end state, so the depth would approach zero
	 * without ever writing the exact resting value and the at-rest branch above could never be taken. Once the
	 * gap is under {@link SETTLED_DEGREES} it is closed outright, which is a difference of a hundredth of a
	 * degree — invisible — and it is what hands the property back exactly rather than nearly.
	 */
	private step(delta: number): void {
		const camera = Workspace.CurrentCamera;
		if (!camera) return;

		const sprintDepth = Fusion.peek(sprinting) ? CAMERA_ZOOM_CONFIG.SPRINT_DEGREES : 0;
		const dodgeDepth = this.dodging ? CAMERA_ZOOM_CONFIG.DODGE_DEGREES : 0;
		const wanted = math.max(sprintDepth, dodgeDepth);

		if (wanted === 0 && this.depth === 0) {
			this.restingFieldOfView = camera.FieldOfView;
			return;
		}

		// The attack is the faster of the two, so which one applies is decided by the direction the depth is
		// moving rather than by which source asked for it: a dodge starting during a sprint deepens at the
		// attack's rate and a sprint ending during a dodge releases at the release's.
		const seconds = wanted > this.depth ? CAMERA_ZOOM_CONFIG.ATTACK_SECONDS : CAMERA_ZOOM_CONFIG.RELEASE_SECONDS;
		const alpha = math.clamp(delta / seconds, 0, 1);

		this.depth += (wanted - this.depth) * alpha;
		if (math.abs(wanted - this.depth) < SETTLED_DEGREES) this.depth = wanted;

		camera.FieldOfView = this.restingFieldOfView - this.depth;
	}
}
