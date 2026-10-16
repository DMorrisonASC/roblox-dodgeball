import { Controller, OnStart } from "@flamework/core";
import { Players, RunService, StarterPlayer, UserInputService, Workspace } from "@rbxts/services";
import { isMobile } from "../../platform";
import { hudTheme } from "../../ui/hudTheme";
import { getScreenSpaceGui } from "../../ui/screenGui";

/** Prints the mount line, the engine-stick probe, and one line per grab and per release. */
const DEBUG = true;

/**
 * **The mobile joystick: the engine's thumbstick switched off, and a bigger one drawn in its place.**
 *
 * **Why the engine's stick had to go rather than be resized.** Its size is not this project's to set: a `Size`
 * write is reverted by the ControlModule on its next layout pass (which runs on every viewport change), and a
 * `UIScale` changes what is *drawn* without changing what the reading is a fraction of — proved in the previous
 * pass, where a `1.5×` scale left the walk plateau at exactly the `0.68` it had been, and dividing the sprint's
 * thresholds by the measured ratio then made ordinary walks sprint. So the drawn size and the usable size are
 * the engine's together, and the only way to have a bigger stick is to stop using theirs.
 *
 * **The switch is `Player.DevTouchMovementMode`**, whose `Scriptable` member the reference documents as *"The
 * player's character will not respond to default controls; any character movement must be defined in custom
 * scripts."* — which is both halves of what this file needs: the engine stops writing movement, and this file
 * becomes the writer. **And this file cannot throw that switch, which the first session that ran it proved in one
 * line.** A client-side write is refused with *"The current thread cannot set 'DevTouchMovementMode' (lacking
 * capability `RobloxScript`)"*, and `RobloxScript` is a capability of the **thread** rather than of the peer — a
 * server script has no more claim on it than a `LocalScript` does. The property is therefore a **place-file**
 * setting: `StarterPlayer.DevTouchMovementMode`, which seeds every player's own copy when they join. What this
 * file does about that is *check first, try once, and stand down rather than draw a second stick beside a live
 * one* — see the mount for the three cases its log line distinguishes, and {@link MOUNT_ANYWAY} for the one way to
 * see the ring on a client where the switch is not available.
 *
 * **The movement path is `Humanoid:Move`, which is the engine's own** — the call the default control scripts
 * make, not a replacement for it. That is what keeps everything downstream working: the humanoid really walks,
 * so its animations, its `MoveDirection` and the `GetMoveVelocity()` the sprint reads are all produced by the
 * engine exactly as they were. **What this file replaces is the *input*, not the movement.**
 *
 * **And the ring is a `TextButton` rather than a `Frame`, for one reason that is not about its look: it has to
 * sink the touch.** The engine's touch camera rotates the view on a drag anywhere that is not over a control,
 * so a stick that let its own finger through would spin the camera every time a player pushed forward. A
 * `GuiButton` is the form of sinking this codebase already relies on (`MobileControlsController`'s buttons), and
 * it is why `gameProcessedEvent` is **deliberately not tested** below — our own ring is what sets it.
 *
 * **What this is not:** not a second movement source beside the engine's. The engine's is off while this is on,
 * and on a non-touch client this file does nothing at all. It is also not a `PlayerModule` fork: nothing here
 * reaches into the module, and the only engine object it touches is the property the reference publishes for
 * exactly this purpose.
 */
@Controller()
export class TouchJoystickController implements OnStart {
	public onStart(): void {
		// Spawned for the reason every controller in this project does it: the mount creates instances and waits
		// on the engine's own GUI, and none of that is something the rest of the client's boot should sit behind.
		task.spawn(() => this.mount());
	}

	private mount(): void {
		// **The gate, and it is the whole of this file's behaviour on a desktop client.** `isMobile()` is
		// `TouchEnabled && !KeyboardEnabled`, so a touchscreen laptop with a keyboard in front of it keeps the
		// engine's controls and the keyboard, and nothing here runs.
		if (!isMobile()) {
			if (DEBUG) print("[Joystick] not a touch client — the engine's own controls are left alone");

			return;
		}

		const player = Players.LocalPlayer;
		const playerGui = player.WaitForChild("PlayerGui") as PlayerGui;

		/**
		 * **The switch, and the log's own answer to whether it took: the engine refused the client-side write.**
		 *
		 * The first session that ran this file settled the question this line was written to ask, and the answer is
		 * *no*: `player.DevTouchMovementMode = …` throws
		 * `"The current thread cannot set 'DevTouchMovementMode' (lacking capability RobloxScript)"`, with Studio's
		 * own line above it reading *"Insufficent permissions to set DevTouchMovementMode"*. **`RobloxScript` is
		 * Roblox's own scripts' capability — it is a property of the *thread*, not of the peer**, so a server script
		 * has no better claim on it than this one does, and the write is a place-file setting or nothing.
		 *
		 * **So the write is fenced, and a refusal is a report rather than a fault.** Unguarded, that throw took
		 * `mount()` with it: no ring, no mount line, no probe — a silent nothing, which is the worst of the three
		 * ways this could have gone and is what the first log shows. Three things follow from the fence:
		 *
		 * - **Already `Scriptable` is the *good* case, and it is not hypothetical** — it is what this file wants a
		 *   place file to say (`StarterPlayer.DevTouchMovementMode`, which seeds every player's copy of this
		 *   property). Set there, this line finds nothing to do, says so, and the joystick proceeds.
		 * - **A refusal stands the joystick down**, because mounting a second stick beside a live engine one gives
		 *   the player two controls fighting over one character — worse than not having the feature.
		 * - **`MOUNT_ANYWAY` is the one way past that**, for looking at the ring on a client where the switch is not
		 *   available. It is a diagnostic, not a configuration; see that constant.
		 */
		const engineMode = player.DevTouchMovementMode;
		let switched = engineMode === Enum.DevTouchMovementMode.Scriptable;
		let refusal = "";

		if (!switched) {
			// The `pcall` is the point rather than the style: this write is refused by the engine itself, with a
			// throw, and the two things it can be are "the property is protected" and "the property is writable and
			// something changed underneath" — which is why the outcome is *reported* rather than assumed.
			const [ok, message] = pcall(() => {
				player.DevTouchMovementMode = Enum.DevTouchMovementMode.Scriptable;
			});

			switched = ok && player.DevTouchMovementMode === Enum.DevTouchMovementMode.Scriptable;
			if (!switched) refusal = tostring(message);
		}

		if (DEBUG) {
			// **Three states, and the third one is a correction this log earned.** A client whose *first* read is
			// already `Scriptable` cannot see who set it: a place file's `StarterPlayer` setting and a server write at
			// join both land before this file runs. **The first version of this line blamed the place file either
			// way, and the session that proved the server's write works shows why that was wrong** — it read "set on
			// StarterPlayer" for a client whose `StarterPlayer` was `UserChoice`, which sent the next hour of this
			// project's reading in the wrong direction. `StarterPlayer`'s own copy is the tie-breaker, read under a
			// `pcall` because a client's *read* of that property may be refused the same way its write to the
			// player's copy is.
			const [readable, placeMode] = pcall(() => StarterPlayer.DevTouchMovementMode);
			const fromPlace = readable && tostring(placeMode) === Enum.DevTouchMovementMode.Scriptable.Name;

			const state = switched
				? engineMode === Enum.DevTouchMovementMode.Scriptable
					? "already Scriptable — set before this file ran, by " +
						(fromPlace
							? "the place file's StarterPlayer setting"
							: readable
								? "something outside this client (not the place file — the server, most likely)"
								: "something this client cannot identify (StarterPlayer is unreadable from here)") +
						", so the engine's stick is off"
					: `Scriptable — written from here (was ${engineMode.Name})`
				: `STILL ${engineMode.Name} — the engine refused the write`;

			print(`[Joystick] engine touch movement: ${state}${refusal === "" ? "" : ` — ${refusal}`}`);
		}

		/**
		 * **And the property is watched rather than read once, because the switch may arrive from the server a
		 * frame after this file starts.**
		 *
		 * The write this file cannot do is now attempted server-side, per player (see `main.server.ts`). A
		 * `PlayerAdded` handler there and this file's `onStart` are two scripts starting at the same join, and
		 * **the order between them is not promised** — so a one-off read can catch `UserChoice` and then report the
		 * refusal as final when the mode was about to arrive. That is a wrong conclusion about the feature rather
		 * than a wrong-looking ring, and it is three lines to remove.
		 *
		 * **This subscription is a report and not a switch.** It does not retro-fit a ring onto a client that stood
		 * down: mounting is the whole of `mount()` and there is no second entry into it. While `MOUNT_ANYWAY` is on
		 * the ring is drawn either way; **before turning that constant off, note what the stand-down path plus a
		 * late `Scriptable` would leave behind — the engine's stick off, and no ring, which is a touch player with
		 * no way to move.** So it is a step to take against a log whose *first* joystick line already reads
		 * `Scriptable`, not before one.
		 */
		if (DEBUG) {
			player.GetPropertyChangedSignal("DevTouchMovementMode").Connect(() => {
				print(`[Joystick] engine touch movement changed to ${player.DevTouchMovementMode.Name}`);
			});
		}

		// **A live engine stick means this file must not draw one.** Two writers on one humanoid is a character
		// that moves to whichever wrote last, which is a worse control than either alone. See {@link MOUNT_ANYWAY}
		// for the diagnostic that ignores this. **The switch itself cannot come from this file** — the server now
		// attempts it per player at join, and the place file's `StarterPlayer.DevTouchMovementMode` sets it before
		// any script runs — and this line is what reports whether it arrived.
		if (!switched && !MOUNT_ANYWAY) {
			if (DEBUG) {
				print(
					"[Joystick] standing down — the engine's stick still drives this character, so no ring is " +
						"drawn; the mode switch has to come from outside this file. The server attempts it per " +
						"player at join — its own line says whether it was refused — or set " +
						"StarterPlayer.DevTouchMovementMode in the place file",
				);
			}

			return;
		}

		const theme = hudTheme();

		/**
		 * **The ring, which is the touch target and the input sink.** A `TextButton` with no text and no button
		 * colouring: everything it does here is a side effect of being a `GuiButton` (see the class doc), and the
		 * look is drawn with its own `BackgroundColor3` and a `UIStroke` rim.
		 */
		const ring = new Instance("TextButton");
		ring.Name = RING_NAME;
		ring.Text = "";
		ring.AutoButtonColor = false;
		ring.BackgroundColor3 = theme.colors.trough;
		ring.BackgroundTransparency = RING_FILL_TRANSPARENCY;
		ring.AnchorPoint = new Vector2(0, 1);
		// **The derived corner plus the hand's half of it.** `UDim2.fromScale` cannot carry the offsets, so the
		// position is written as what it is: two fractions of the axes — the inset, and `1` minus the inset because
		// a screen's Y grows downwards — and the two distances a thumb disagreed with. See {@link STICK_NUDGE}.
		ring.Position = new UDim2(
			STICK_EDGE_INSET_SCALE,
			STICK_NUDGE.X,
			1 - STICK_EDGE_INSET_SCALE,
			STICK_NUDGE.Y,
		);
		ring.Parent = getScreenSpaceGui();

		const corner = new Instance("UICorner");
		corner.CornerRadius = new UDim(1, 0);
		corner.Parent = ring;

		const rim = new Instance("UIStroke");
		rim.Color = theme.colors.accent;
		rim.Thickness = RING_RIM_THICKNESS;
		rim.Transparency = RING_RIM_TRANSPARENCY;
		rim.Parent = ring;

		/**
		 * **The thumb: the part the player watches.** A child of the ring, so it is positioned in the ring's own
		 * space and moves with it for free, and the only instance in this file written while a finger is down.
		 */
		const thumb = new Instance("Frame");
		thumb.Name = THUMB_NAME;
		thumb.AnchorPoint = new Vector2(0.5, 0.5);
		thumb.Position = new UDim2(0.5, 0, 0.5, 0);
		thumb.BackgroundColor3 = theme.colors.accent;
		thumb.BackgroundTransparency = THUMB_TRANSPARENCY;
		thumb.Parent = ring;

		const thumbCorner = new Instance("UICorner");
		thumbCorner.CornerRadius = new UDim(1, 0);
		thumbCorner.Parent = thumb;

		/**
		 * **The ring's radius in pixels, which is the denominator of every reading this file produces.**
		 *
		 * Written only by {@link applyGeometry} and read by the touch handlers and the render step, so the one
		 * number that decides what "fully pushed" means has one writer. It is in *pixels* rather than as a
		 * fraction because the thing being divided is a touch position in pixels.
		 */
		let radius = 0;

		/**
		 * **Whether the ring has ever been given its size, which is the flag the sizing line and the mount line
		 * both report on.**
		 *
		 * It exists because the geometry is derived *late* on a normal client — see the mount print's own note —
		 * so "did this work" is a question about a function that has not run yet by the time the mount is built. It
		 * sits beside {@link radius} rather than after the function because it is the same kind of thing: state
		 * that {@link applyGeometry} writes and that nothing else does.
		 */
		let sized = false;

		/**
		 * **The geometry, recomputed on the two occasions it changes: the mount and a new viewport.**
		 *
		 * The diameter is a fraction of the **smaller axis of the viewport**, which `UDim2.fromScale` cannot
		 * express — a scale size is per-axis, and a ring that used it would be an ellipse on anything that is not
		 * square. The *position* below is in scale for the opposite reason: the engine re-lays out a scale
		 * position by itself on a rotation, so the only thing that has to be written when the screen changes is
		 * the size.
		 *
		 * **Read from `Camera.ViewportSize` and not from the frame's own `AbsoluteSize`**, deliberately: the
		 * viewport is the value whose change is the signal being reacted to, so the two cannot disagree, where a
		 * frame's `AbsoluteSize` is a product of the layout pass and reads as the *old* size in the frame a write
		 * lands — the round trip `SprintController.scaleStickFrame` documents with a `task.wait()` in it.
		 */
		const applyGeometry = (): void => {
			const viewport = Workspace.CurrentCamera?.ViewportSize;
			if (viewport === undefined) return;

			const shortAxis = math.min(viewport.X, viewport.Y);
			if (shortAxis <= 0) return;

			const diameter = shortAxis * STICK_DIAMETER_SCALE;
			radius = diameter / 2;

			ring.Size = UDim2.fromOffset(diameter, diameter);
			thumb.Size = UDim2.fromOffset(diameter * THUMB_RADIUS_RATIO, diameter * THUMB_RADIUS_RATIO);

			// **The one line that says the ring is up, and it exists because the mount's own line cannot.** At the
			// mount there is usually no camera yet, so this function returns without a number and the ring is left
			// at `0 × 0` until the camera arrives — which is one frame of nothing on most clients and every frame
			// of nothing on a client that never got this far. Printing *here* rather than at the mount is what
			// makes "the ring drew" a fact in a log rather than an inference from a size that reads as `0`. Once
			// only, because a rotation re-derives the same number and would otherwise print on every layout pass.
			if (DEBUG && !sized) {
				sized = true;

				print(
					`[Joystick] ring sized — ${string.format("%.0f", diameter)}px from a ${
						string.format("%.0f", shortAxis)
					}px short axis (${string.format("%.0f", viewport.X)} x ${string.format("%.0f", viewport.Y)})`,
				);
			}
		};

		applyGeometry();

		// **The one place the geometry is re-derived, and the read is cheap because it is a signal and not a
		// frame.** A rotation and a window being dragged are the two ways this changes, and both fire it —
		// `ui/screenGui.ts` and `MobileControlsController` watch this same property for the same class of reason.
		const camera = Workspace.CurrentCamera;
		if (camera !== undefined) {
			camera.GetPropertyChangedSignal("ViewportSize").Connect(() => applyGeometry());
		}

		// **And the same re-derivation for the camera itself, which is the one way this ring can be invisible
		// rather than merely misplaced.** `applyGeometry` has nothing to measure without a camera, so a mount that
		// happens first leaves a ring at `0 × 0`: parented, drawn, holding no pixels, and reported by nothing —
		// every diagnostic in this file prints a *size*, and `0` reads as an honest answer. A client that ignites
		// before its camera exists is not hypothetical (the HUD's own scale falls back to a reference viewport for
		// exactly that reason), and one subscription is a better answer than a fallback number: the camera arriving
		// is the event that makes the geometry knowable.
		Workspace.GetPropertyChangedSignal("CurrentCamera").Connect(() => applyGeometry());

		/**
		 * **The touch this stick is following, by the `InputObject` itself.**
		 *
		 * Identity rather than position is what makes multi-touch safe: a second finger on the cluster's buttons
		 * sends its own `TouchMoved` events to the same connection, and following the wrong finger would walk the
		 * character towards wherever the player is holding a throw button. **The assumption in it, stated because
		 * it is the one thing here that cannot be read out of the typings**: the engine hands the *same*
		 * `InputObject` to `TouchStarted`, every `TouchMoved` and the `TouchEnded` of one touch. If it does not,
		 * the symptom is a stick that grabs and never moves — visible in one Studio session, and the fix is to
		 * match on the position instead.
		 */
		let touch: InputObject | undefined;

		/** The thumb's offset from the ring's centre, in pixels, clamped to the radius. Also the reading's length. */
		let pushX = 0;
		let pushY = 0;

		/** The push's direction as a unit vector, kept so the reading and the drawing share one set of numbers. */
		let unitX = 0;
		let unitY = 0;

		/** The reading: the push as a fraction of the radius, deadzoned. **This is the number `Move` is called with.** */
		let reading = 0;

		/**
		 * **The largest reading of the current grab.** Not the live one, and not a diagnostic for this file's
		 * sake: the sprint's thresholds (`0.9`/`0.8`) were placed against the *engine's* stick, and the number
		 * that decides whether they are still right on this one is the **peak a deliberate push reaches** — which
		 * is exactly what this is. It is printed on release, so one session of play answers the question the
		 * thresholds are waiting on, and it is bounded by how often a person lets go of a stick rather than by a
		 * frame count. See `SprintController`'s `SPRINT_START_MAGNITUDE` for the pair and its provenance.
		 */
		let peak = 0;

		/** Puts the thumb back at the ring's centre. The reading is set by {@link release}. */
		const centreThumb = (): void => {
			pushX = 0;
			pushY = 0;
			unitX = 0;
			unitY = 0;
			thumb.Position = new UDim2(0.5, 0, 0.5, 0);
		};

		/**
		 * **The two paints, and the latch that keeps them off the per-frame path.**
		 *
		 * See {@link RING_MAX_LINE} for what the white means and why the line is the rim. **The latch is the
		 * reason this is a function rather than two branches at the call site**: `TouchMoved` fires as often as the
		 * finger moves, which on a phone is a per-frame event, so an unguarded write here would set four properties
		 * and print a line sixty times a second in the middle of a push. `bright` is seeded `false` because the ring
		 * is *built* dark (the same `trough` and `RING_FILL_TRANSPARENCY` this writes), so the drawing and the state
		 * cannot disagree at the mount.
		 *
		 * **The print is evidence rather than commentary.** This control's look has still never been seen on screen
		 * — the ring is drawn on a client whose engine stick is live, see {@link MOUNT_ANYWAY} — so one line saying
		 * the white was painted is worth the two per push it costs, and it pairs with `[Sprint] pressed` to show the
		 * two facts landing on the same push.
		 */
		let bright = false;
		const setMaxLook = (on: boolean): void => {
			if (on === bright) return;

			bright = on;
			ring.BackgroundColor3 = on ? theme.colors.onAccent : theme.colors.trough;
			ring.BackgroundTransparency = on ? RING_MAX_FILL_TRANSPARENCY : RING_FILL_TRANSPARENCY;
			rim.Color = on ? theme.colors.onAccent : theme.colors.accent;
			rim.Transparency = on ? RING_MAX_RIM_TRANSPARENCY : RING_RIM_TRANSPARENCY;

			if (DEBUG) print(`[Joystick] the ring went ${on ? "white — the thumb is at the rim" : "dark"}`);
		};

		/**
		 * **A touch's offset from the ring's centre, and how far out it is — one set of numbers for both the
		 * drawing and the reading.**
		 *
		 * Everything in it is in screen pixels: `input.Position` is a screen position, and `AbsolutePosition` /
		 * `AbsoluteSize` are screen measurements. That is not a coincidence to be left implicit — it is the reason
		 * this file mounts into `getScreenSpaceGui()` rather than the shared HUD GUI, which insets its contents
		 * below the topbar and would put the ring's centre half a topbar away from the touch being measured
		 * against it. See that function's own doc, which is where this rule is written down.
		 */
		const reachOf = (position: Vector3): { x: number; y: number; distance: number } => {
			const centreX = ring.AbsolutePosition.X + ring.AbsoluteSize.X / 2;
			const centreY = ring.AbsolutePosition.Y + ring.AbsoluteSize.Y / 2;
			const x = position.X - centreX;
			const y = position.Y - centreY;

			return { x, y, distance: math.sqrt(x * x + y * y) };
		};

		/** Follows the finger: the thumb's place, the direction, and the reading. */
		const track = (input: InputObject): void => {
			const reach = reachOf(input.Position);

			// **The clamp is on the *offset*, so the thumb and the reading cannot disagree.** A finger past the
			// rim keeps the direction it went out at and sits on the rim, which is what every stick on every
			// platform does — and it is why the reading below is a division by the radius rather than a distance.
			const overshoot = math.clamp(reach.distance / radius, 0, 1);

			pushX = reach.x * overshoot;
			pushY = reach.y * overshoot;

			// A touch exactly on the centre has no direction to report, and `0/0` is a `nan` that would reach
			// `Humanoid:Move` — so the unit vector is left at the last one and multiplied by a reading of `0`.
			const normalised = reach.distance > 0 ? 1 / reach.distance : 0;
			unitX = reach.x * normalised;
			unitY = reach.y * normalised;

			// **The reading: the push as a fraction of the radius, then the deadzone as a floor rather than a
			// scale.** A scale — subtracting the deadzone and dividing by what is left — would put "fully pushed"
			// at the rim either way and only change the numbers in between; a floor says "below this, the player is
			// not asking for anything", which is the honest reading of a thumb resting on the stick.
			const raw = math.clamp(reach.distance / radius, 0, 1);
			reading = raw < DEADZONE ? 0 : raw;

			peak = math.max(peak, reading);

			// **The white, decided by the same reading that drives the body**, so there is no second copy of "how far
			// is this pushed" and nothing to keep in step. Written here rather than in the render step below: that
			// loop runs per frame and this is a fact about the finger, which is what this handler exists to report.
			// See {@link RING_MAX_LINE} — and note that a thumb resting *exactly* on the rim can flicker between the
			// two paints, which is a property of any level test at a boundary and is what the player's own hand
			// settles by pushing past it.
			setMaxLook(reading >= RING_MAX_LINE);

			// The thumb follows the finger *exactly*, deadzone and all, because the thumb is where the finger is
			// rather than a readout of what the game is doing about it. The reading above is the one that has an
			// opinion; the drawing does not.
			thumb.Position = new UDim2(0.5, pushX, 0.5, pushY);
		};

		/** The local player's live humanoid, or nothing while there is no body to move. */
		let humanoid = humanoidOf(player.Character);

		/**
		 * **Stops driving the body, returns the thumb, and reports the grab.**
		 *
		 * The zero write is here rather than left to the render step below, and it is the one write in this file
		 * that is not a repeat of the last one: with no touch tracked the render step writes nothing at all, so
		 * without this line a release would leave the last direction in force until something else moved the
		 * character. It is also a *single* write rather than a per-frame zero — see the render step's own argument
		 * for why a zero call is the one thing that must not repeat.
		 */
		const release = (): void => {
			// **Nothing held, nothing to release** — and the guard is load-bearing rather than tidy: the focus
			// signal below fires whether or not this stick is being held, and without this line an unrelated
			// focus change would write one frame of zero movement on a client where nothing else is writing.
			if (touch === undefined) return;

			touch = undefined;
			centreThumb();
			reading = 0;

			// **And the ring goes back to dark with the thumb**, which is the same paint the mount wrote — so a
			// release can never leave a white ring behind on a hand that is no longer on the stick. The latch inside
			// makes this free when the state was already dark, which is every release but the ones from a full push.
			setMaxLook(false);

			if (DEBUG) print(`[Joystick] released — the push peaked at ${string.format("%.2f", peak)} this grab`);

			peak = 0;

			if (humanoid === undefined) humanoid = humanoidOf(player.Character);
			humanoid?.Move(Vector3.zero, true);
		};

		/**
		 * **The movement writer: one call per frame while a finger is down, and nothing at all when none is.**
		 *
		 * `BindToRenderStep` at `Enum.RenderPriority.Character` (300), which is `AlternativeMovementController`'s
		 * slot and its argument: the default control scripts write the character's movement at priorities 100 and
		 * 200, `Heartbeat` runs after the physics step (so a call there is a frame late and overwritten), and 300
		 * is the rung the enum reserves for character-response work. With `Scriptable` set there is a second reason
		 * for the same slot and it is the better one: the camera script still updates at 200, and
		 * `relativeToCamera` below is resolved against *this* frame's camera rather than last frame's.
		 *
		 * **The per-frame write is deliberate, and `Humanoid:Move` would hold its direction on its own.** A single
		 * call would be enough while nothing else writes, but the body's movement is cleared by things this file
		 * cannot see — a state change, a dodge's `PlatformStand`, a caught ball — and a stick that went dead until
		 * the player lifted a finger and put it back would be a fault nobody could describe. Writing every frame
		 * makes the stick the authority for exactly as long as it is being held. **The cost of that is the one
		 * `AlternativeMovementController` records**: a zero-vector call cancels whatever the default controls
		 * asked for that frame, so this must never write while no finger is down — which is why the first line
		 * below is a `return` and why the release above is a single write rather than a loop.
		 */
		RunService.BindToRenderStep(RENDER_BINDING_NAME, MOVE_PRIORITY, () => {
			if (touch === undefined) return;

			// The re-resolve on a frame with no body, for the race both sibling controllers record at length:
			// `CharacterAdded` hands over the model before its children have replicated, so a miss in the handler
			// is permanent — the event does not fire again for the same character.
			if (humanoid === undefined) humanoid = humanoidOf(player.Character);
			if (humanoid === undefined) return;

			// **Screen space to camera space, and the two signs are the whole of it.** A screen's Y grows
			// *downwards* and camera-forward is `-Z`, so a finger pushed away from the player (up the screen, a
			// negative Y here) is a negative Z — no flip. **`AlternativeMovementController` writes the mirror of
			// this line with a flip in it**, and both are right: its vector comes from an `InputAction`, whose Y
			// is *up*-positive, where this one comes from a touch position, whose Y is *down*-positive.
			//
			// A reading of `0` is written rather than skipped, and that is a decision: a finger down but inside
			// the deadzone is the player saying *stop*, so the stick says stop. Writing nothing would leave the
			// body walking from the last frame that had a direction.
			humanoid.Move(new Vector3(unitX * reading, 0, unitY * reading), true);
		});

		// **The humanoid is re-resolved per body; the connections are not.** One subscription serves every
		// character, and `CharacterRemoving` clears the reference because a destroyed humanoid is not something to
		// call a method on. **The touch is deliberately not cancelled here**: a touch ends when its own
		// `TouchEnded` arrives, so cutting it here would be this file inventing an ending for a gesture the player
		// is still making — and a finger still on the ring when the next body loads is a player asking to walk.
		player.CharacterAdded.Connect((character) => {
			humanoid = humanoidOf(character);
		});

		player.CharacterRemoving.Connect(() => {
			humanoid = undefined;
		});

		// **The release that never arrives, on the rule three other input controllers in this project follow.**
		// A touch that ends while the window is elsewhere is not delivered here, and a stick stuck at its last
		// reading is a character that walks until the player touches the screen again. `SprintController` clears
		// its held keys on this signal for the same reason.
		UserInputService.WindowFocusReleased.Connect(() => release());

		// **The grab.** One touch at a time, and it has to *begin* inside the ring: a stick that grabbed whichever
		// finger moved first would be a stick the player could not avoid touching.
		UserInputService.TouchStarted.Connect((input) => {
			if (touch !== undefined) return;

			// **The test is the drawn circle and not the button's rectangle.** A `GuiObject`'s bounds are a
			// rectangle, and the corners of this one's are outside the ring the player can see — so a corner touch
			// neither grabs the stick nor counts as one. (It still sinks, being a `GuiButton`: the corners are a
			// few pixels of screen the camera cannot use. That is the price of the sink, and it is the cheaper side
			// of it.)
			//
			// **And `radius <= 0` is a refusal rather than an edge to reason about.** It means the geometry has
			// never run — a client with no camera — and every reading below is a division by that number: a
			// `0/0` there is a `nan`, and a `nan` handed to `Humanoid:Move` is a body that does nothing at all
			// with no error anywhere.
			if (radius <= 0) return;
			if (reachOf(input.Position).distance > radius) return;

			touch = input;
			peak = 0;
			track(input);

			if (DEBUG) {
				print(
					`[Joystick] grabbed at ${string.format("%.0f", input.Position.X)}, ` +
						`${string.format("%.0f", input.Position.Y)} — ring ${string.format("%.0f", radius * 2)}px`,
				);
			}
		});

		// **The follow, and the identity test is what keeps a second finger out of it.** `TouchMoved` fires for
		// every finger on the screen, so the cluster's buttons and the engine's own controls send events here too.
		UserInputService.TouchMoved.Connect((input) => {
			if (input !== touch) return;

			track(input);
		});

		// **The release, taken however it arrives.** A finger that slides off the screen still ends the touch it
		// began, and `TouchEnded` is where that is announced for the touch this stick is holding.
		UserInputService.TouchEnded.Connect((input) => {
			if (input !== touch) return;

			release();
		});

		// **Whether the switch did what it says, asked once and reported rather than assumed.** Two questions are
		// open on a client nobody has run this on: whether `Scriptable` leaves the engine's movement frame drawn
		// (this file cannot hide it — see the report), and whether the engine's jump button survives — which
		// matters more than it looks like, because `MobileControlsController` draws its whole cluster only once
		// that button has been found, so a jump button that went away with the movement mode would take the five
		// battle buttons with it. One line, after the GUI exists, naming the children of the engine's own control
		// frame and the button's presence: that is the reading the next session starts from.
		if (DEBUG) {
			task.spawn(() => {
				const touchGui = playerGui.WaitForChild("TouchGui", TOUCH_GUI_WAIT_SECONDS);

				if (touchGui === undefined) {
					print(
						`[Joystick] no TouchGui after ${TOUCH_GUI_WAIT_SECONDS}s — either this client has no ` +
							`engine touch controls or the switch took them away`,
					);

					return;
				}

				const control = touchGui.FindFirstChild("TouchControlFrame");
				const names =
					control === undefined
						? "no TouchControlFrame"
						: `${control.GetChildren().size()} child(ren): ${control
								.GetChildren()
								.map((child) => child.Name)
								.join(", ")}`;
				const jump = touchGui.FindFirstChild("JumpButton", true);

				// **The class test before the visibility read, and it is not ceremony.** `FindFirstChild` answers
				// with whatever class wears that name, so the test is what stops a decoy from making this line
				// read as "the button is there" — and `Visible` only exists on a `GuiObject`, so the compiler
				// refuses the read without it. The question this probe asks is exactly that pair: is the thing
				// there, and is it a control.
				const jumpLine =
					jump === undefined || !jump.IsA("GuiObject")
						? "no JumpButton"
						: `JumpButton ${jump.Visible ? "visible" : "HIDDEN"}`;

				print(`[Joystick] engine touch GUI — ${names}; ${jumpLine}`);
			});
		}

		if (DEBUG) {
			// **The size, or the honest absence of one.** This line runs at the mount, and on a normal client the
			// mount happens *before* `Workspace.CurrentCamera` exists — so `applyGeometry` has nothing to measure and
			// leaves the radius at `0`, which the first version of this print reported as `ring 0px`: a number that
			// reads as a broken control rather than as the order two things happen in. **The line that reports the
			// size is inside `applyGeometry`** (`[Joystick] ring sized — …`), because that is where the number is
			// known; this one says which of the two cases the mount was in and nothing more.
			const size =
				radius > 0
					? `ring ${string.format("%.0f", radius * 2)}px`
					: "ring not sized yet — no camera at the mount, so it is derived when one arrives";

			print(
				`[Joystick] up — ${size} at ${formatPercent(STICK_DIAMETER_SCALE)} of the short axis, thumb ratio ` +
					`${formatPercent(THUMB_RADIUS_RATIO)}, deadzone ${formatPercent(DEADZONE)}, inset ` +
					`${formatPercent(STICK_EDGE_INSET_SCALE)} of each axis nudged ` +
					`(${string.format("%.0f", STICK_NUDGE.X)}, ${string.format("%.0f", STICK_NUDGE.Y)})px; ` +
					`bound to the render step at ${MOVE_PRIORITY}`,
			);
		}
	}
}

/**
 * The ring's diameter as a fraction of the viewport's smaller axis. **Placeholder — 0.30, raised from 0.20 on the
 * ask that the box be larger.**
 *
 * **What `0.30` is worth, because a fraction is not a size**: **118px** of diameter on the 393-wide reference —
 * half again the 79px the first cut drew, and level with the bigger of the two sticks the engine ships (70px and
 * 120px, so that one is 0.31 of the same axis). It is still inside the corner: with the 3% inset the ring spans
 * about `x 12…130` on that phone, against the mobile cluster's box at roughly `x 145` in this project's logs — if
 * they ever do meet, the levers are {@link STICK_NUDGE} here and `BOX_NUDGE`/`BOX_EDGE_GAP` there.
 *
 * **Named for the diameter because that is what it is.** The brief for this file named the constant
 * `STICK_RADIUS_SCALE` while its own description said "ring diameter as a fraction of the viewport's smaller
 * axis", and the two cannot both be right: `0.20` of a 393px axis is a **79px** ring, which is the size the
 * reference screenshot describes, where `0.20` as a *radius* would be a 157px ring — two fifths of the screen's
 * short edge. The value is the one that was asked for, so the name follows the value. See
 * {@link THUMB_RADIUS_RATIO}, which keeps the brief's name because a ratio of radii and a ratio of diameters are
 * the same number.
 *
 * **Why the smaller axis rather than the width or the height.** The same argument `MobileControlsController`
 * makes for its box: the width alone lets a phone held sideways keep a full-size ring on a viewport half as
 * tall, and the height alone shrinks it on every wide screen. The *smaller* of the two is the one that fits, and
 * a ring is a circle, so one number has to serve both axes.
 *
 * **`0.20` of the short axis is about a quarter of it** — the proportion the reference screenshot shows, and
 * three times the engine's own stick on the larger of this project's two logged devices (120px on a 393px axis
 * is `0.31`, so this is *smaller* than that one; on the 70px device it is `0.18`, so this is four times it).
 * **The engine's size is not one number and cannot be tuned against**: its module picks 70 or 120px from a
 * `min(viewport's short axis) <= 500` test, so the same stick is a very different fraction of two phones. That
 * variance is the real argument for this file, more than either size is.
 */
const STICK_DIAMETER_SCALE = 0.3;

/**
 * The thumb's diameter as a fraction of the ring's. **Placeholder — 0.35.**
 *
 * **A ratio of radii, which is the same number as a ratio of diameters** — so the brief's name is exact and
 * needs no footnote, unlike the ring's above. Three tenths of the ring makes the thumb a dot inside a large
 * ring, which is what the reference shows: big enough to see where the finger is, small enough that the ring
 * still reads as the travel rather than as a well.
 */
const THUMB_RADIUS_RATIO = 0.35;

/**
 * The fraction of the ring's radius below which the stick says nothing at all. **Placeholder — 0.08.**
 *
 * **A floor on the reading rather than a scale on it.** Below this the reading is `0` — the stick is at rest —
 * and above it the reading is the raw fraction, unre-scaled. The alternative (subtracting the deadzone and
 * dividing by what remains) maps the rim to `1` either way and only moves the numbers in between, which is not
 * worth a second piece of arithmetic: the sprint's thresholds are placed well above this either way, and a
 * player's thumb resting on a stick is *moving* rather than hidden behind a curve.
 *
 * **Small on purpose.** Eight hundredths of a radius is about 3px on the reference phone, which is the width of
 * a fingertip's wobble rather than a control the player has to push past. A generous deadzone is a stick that
 * feels unresponsive at the start of a push, and this one is only here so that a resting thumb reads as nothing.
 */
const DEADZONE = 0.08;

/**
 * How far the ring sits from the screen's left and bottom edges, as a fraction of *each* axis. **Placeholder —
 * 0.03.**
 *
 * **A fraction rather than a pixel count, and that is the one thing about this number that is not taste.** The
 * GUI this mounts into does not inset (`getScreenSpaceGui`), so a pixel inset would be right — but the ring's
 * *size* is recomputed on a rotation while a scale position is re-laid out by the engine itself, and a scale
 * inset is the same fraction of the screen the ring is a fraction of. One unit for the whole corner.
 *
 * **`0.03` is about 12px on the reference phone and a little more on a big one**, which is the same kind of gap
 * the rest of this project's furniture leaves. **The bottom-left corner used to be shared, and the collision
 * that was real when this number was chosen is worth recording rather than deleting**: the cooldown readout sat
 * on exactly these pixels (12px inset, two 120px bars), so on a 393 × 852 screen the ring's lower third covered
 * it — reported at the time rather than papered over, because the two ways out were a bigger inset, which lifts
 * the stick into the middle of the left edge where a thumb does not rest, or moving somebody else's bars. **It
 * is not a problem any more and it is not the reason for anything here**: the cooldown readout has since been
 * deleted at the user's request (*“it's not needed anymore and it's distracting”*), so this ring has the corner
 * to itself and the number below is a gap and nothing more.
 */
const STICK_EDGE_INSET_SCALE = 0.03;

/**
 * **How far the ring is moved from where that inset puts it, in screen pixels: `X` right, `Y` down.**
 * **Placeholder — `(0, 0)`, which is exactly where the derivation puts it.**
 *
 * **The same shape as `MobileControlsController`'s `BOX_NUDGE`, and for the same reason.** The derived place is
 * right on every device — it is a fraction of the screen, so it cannot land off it — but "right" is not the same
 * question as "where a thumb wants it", and a hand is the only instrument that can answer the second one. A
 * *delta* rather than a corner keeps the derivation: `new Vector2(0, -60)` reads as "60px higher than the
 * derivation thinks, on whatever device this is", which is the sentence a person actually has in mind when they
 * say the stick should be higher.
 *
 * **In screen pixels rather than a fraction, which is the one place this differs from the cluster's box.** That
 * box is described in reference pixels because every number in that HUD is multiplied by a viewport fit; this ring
 * is not — its *size* is already a fraction of the screen (see {@link STICK_DIAMETER_SCALE}) — so the only thing
 * left to move it by is a distance. **`X` right and `Y` down, positive in those directions**, because that is the
 * way a finger moves and there is then no sign to flip between the intent and the file.
 *
 * **What this lever deliberately does not do: stop at the edge.** The ring's bottom edge is the inset above the
 * screen's bottom, so a positive `Y` walks it off the screen — a legitimate thing to discover with a thumb and a
 * bad thing to ship. **Nothing here is clamped**, for `BOX_NUDGE`'s own reason: a nudge that silently stopped
 * would be a number this file disagrees with, and the line that reports the geometry would be lying about where
 * the ring is. What keeps the *derived* place safe is that it is a fraction; what keeps the nudged place honest is
 * that a person typed it.
 */
const STICK_NUDGE = new Vector2(0, 0);

/**
 * The ring's fill, as a transparency rather than a colour. **Placeholder — 0.85.**
 *
 * **Almost nothing, so the game shows through** — which is the only honest way to draw a control that covers the
 * screen's most-played region. The colour it is a transparency *of* is `theme.colors.trough`, the same near-black
 * the cluster's idle buttons use at 0.6, so the ring reads as the same furniture as the buttons beside it
 * without being as solid as they are. **A fill rather than nothing at all** because a ring drawn only as a rim
 * is invisible over a bright sky, and because the fill is the one part of this control that says "this region is
 * the stick" before the player has touched it.
 */
const RING_FILL_TRANSPARENCY = 0.85;

/**
 * The ring's rim: its thickness in pixels and its opacity. **Placeholder — 3px at 0.20, thickened and darkened on
 * the same ask that made the ring bigger.**
 *
 * **This outline is the whole point of drawing our own control, and that is a player's sentence rather than a
 * designer's.** The classic thumbstick is liked because *“you can visibly see the outer circle that shows that you
 * are hitting max (1.0) on movement”* — the engine's fixed stick draws a disc with a rim, and the dynamic one draws
 * nothing until a finger lands and then has no rim at all, so the same push reads the same number with no way to
 * see it. **A rim at a fixed radius is the only thing that can say `1.0` before the player gets there**, which is
 * why it is drawn thicker and more solidly than the first cut's hairline.
 *
 * **The rim is the ring.** A stick's travel is a radius, and a circle drawn as a hairline is the only form that
 * states it without a fill heavy enough to hide the game. It is drawn in `theme.colors.accent` — the same colour
 * as the thumb and as the cluster's pressed buttons — which is the vocabulary this HUD already uses for "the
 * thing to look at".
 */
const RING_RIM_THICKNESS = 3;
const RING_RIM_TRANSPARENCY = 0.2;

/**
 * The thumb's opacity. **Placeholder — 0.**
 *
 * **Opaque, and the one solid pixel of this control** — the reference screenshot's own reading, and the reason
 * it works: the thumb is the only part of the stick that *changes*, so it has to be the part that reads first.
 * Under a thumb is also the one place on a touch screen where nothing needs to be seen.
 */
const THUMB_TRANSPARENCY = 0;

/**
 * **The ring's second look — the white one — and the line at which it is drawn. Copied from another game rather
 * than invented here, and the ask is the user's, in their own words:**
 *
 * > *“The classic controllers works well because I can visibly see the outer circle that shows that you are hitting
 * > max (1.0) on movement. … I need a box I can see for both, and its to be larger”*, then two screenshots of a
 * > football game and *“it turn white when sprint is activated / full throttle of joystick. It dark when throttle is
 * > not at max. This is a different game I am copying.”*
 *
 * **So the ring has two states and no gradient**: {@link RING_FILL_TRANSPARENCY}'s dark well while the thumb is
 * anywhere inside the circle, and a white disc with a solid rim once it is at the rim. That makes it a **stick
 * readout rather than a status light** — it says where the thumb is, which is a thing the player can check against
 * their own hand at any moment — and it is the direct answer to the complaint that opened this work: the engine's
 * dynamic thumbstick draws nothing at all, so the same push produced the same reading with nothing on screen to
 * confirm it.
 *
 * **`RING_MAX_LINE` is `1` and it is deliberately not a tuning value.** The reading is the push as a fraction of the
 * ring's *own* radius (see {@link STICK_DIAMETER_SCALE}) clamped at `1`, so **the line *is* the rim**: the state
 * changes when the thumb reaches the edge of the circle drawn on screen, not at some fraction of it that could drift
 * away from what the player can see. Any other number would put the white somewhere the ring draws no line at all.
 *
 * **It coincides with the sprint, and that is by construction rather than by upkeep.** `SprintController`'s start
 * line is `SPRINT_START_MAGNITUDE = 1` — a reading *at the clamp* — so one full push turns the ring white and
 * engages the sprint from a single number, and the white arrives slightly *before* the sprint does, because the
 * sprint's own `SPRINT_HOLD_SECONDS` hold sits behind it. **The ring is deliberately not driven by `sprinting`
 * itself**: that value is the client's *want* rather than the server's grant, so a player whose stamina pool has run
 * dry would be shown a white ring over a body that is not running — a control lying about the one thing it exists to
 * show. What the ring is allowed to be wrong about is nothing at all: it reports a finger.
 *
 * **And it is not a bar.** No second threshold has to be kept in step with the sprint pair, and if that pair is ever
 * moved the white stays where the rim is — see {@link setMaxLook}, which is the only place the two paints live.
 *
 * **Both are Placeholders**: how solid the white disc is over grass and over a goal net, and how solid its edge is.
 * `theme.colors.onAccent` is `Palette.common.white`, the theme's own brightest value, so none of this needs a
 * `Color3.fromRGB` and it cannot drift away from the HUD's vocabulary.
 */
const RING_MAX_LINE = 1;
const RING_MAX_FILL_TRANSPARENCY = 0.25;
const RING_MAX_RIM_TRANSPARENCY = 0;

/**
 * The priority the movement write takes on the render step: `Enum.RenderPriority.Character`, i.e. `300`.
 *
 * **The same rung `AlternativeMovementController` binds at**, and for the argument recorded there: the default
 * control scripts write the character's movement at 100 and 200, the camera updates at 200, and this enum member
 * is documented as what a character-response callback is for. **`Heartbeat` is refused for the reference's own
 * reason** — it runs after the physics step, so anything written there is a frame late and belongs to a frame
 * nobody is looking at.
 *
 * **A name rather than a number**, because `BindToRenderStep` takes a number and the intent is a rung: the
 * `.Value` is read here once so no call site has to know what `Character` is worth.
 */
const MOVE_PRIORITY = Enum.RenderPriority.Character.Value;

/**
 * **The name this writer is bound under.** `BindToRenderStep` keys every binding by name, so this is what an
 * `UnbindFromRenderStep` would take — nothing calls one, because a controller lives as long as the client does
 * and a binding that outlives its controller is exactly what this controller *is*.
 */
const RENDER_BINDING_NAME = "TouchJoystick";

/**
 * The two instances' names. **Named rather than anonymous** because both this file's diagnostics and a Studio
 * `Explore` are read by people: a touch control found by name is one that can be inspected in a running client,
 * and the `Thumb` says what it is.
 */
const RING_NAME = "TouchJoystick";
const THUMB_NAME = "Thumb";

/**
 * **Whether the ring is drawn even when the engine's own stick is still live. `true`, and that is a decision with a
 * reason rather than a default that stuck.**
 *
 * **Why it is on.** The engine refuses the `Scriptable` write from any script — see the class doc for the error —
 * and the ask this constant answers is *“the classic stick works because you can see the outer circle that means
 * `1.0`; the dynamic one has no circle at all — I want a box I can see, in both, and bigger.”* **A ring that is
 * waiting for a place file is not a ring anybody can see, size or place**, so it is on while the mode switch is
 * being settled: the ring draws, the thumb follows a finger, and the numbers to tune are the ones below.
 *
 * **What it costs, stated rather than discovered.** With the engine's stick live there are two writers on one
 * character. Ours is bound at `Enum.RenderPriority.Character` (300) and the ControlModule's at 100 and 200, so
 * **ours is the later write of the two and wins while a finger is on the ring** — which is what makes the ring
 * *feel* right rather than merely appear — but the engine's stick is still there, still drawn where the player
 * touched, and still in charge of every touch that starts off the ring. Two controls, one body: that is a
 * diagnostic, not a ship state.
 *
 * **And the log says which state a session is in**, one line each: `[Joystick] engine touch movement: already
 * Scriptable …` (the switch came from the server or the place file — turn this constant off) against `STILL …
 * — the engine refused the write` (this constant is the only thing making the ring visible).
 */
const MOUNT_ANYWAY = true;

/**
 * **How long the engine-stick probe waits for `TouchGui`.** Not a tuning value: it is the patience of a lookup,
 * and it is the same ten seconds the previous reader gave the same GUI. The engine builds its touch GUI during
 * boot — one of this project's logs put it about 1.5s after the client ignited — so the wait is normally over
 * before it starts.
 */
const TOUCH_GUI_WAIT_SECONDS = 10;

/** The local player's live humanoid, or nothing while there is no body to move. */
function humanoidOf(character: Model | undefined): Humanoid | undefined {
	return character?.FindFirstChildWhichIsA("Humanoid");
}

/** A fraction as the percentage a log line reads better as. **Diagnostics only** — nothing here is game logic. */
function formatPercent(fraction: number): string {
	return `${string.format("%.1f", fraction * 100)}%`;
}
