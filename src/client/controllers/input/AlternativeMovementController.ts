import { Controller, OnStart } from "@flamework/core";
import { Players, ReplicatedStorage, RunService, UserInputService } from "@rbxts/services";

/** Prints the mount line. The line that says this controller ran at all. */
const DEBUG = true;

/** The context and the action inside it. Named here because the Explore tree is how this is checked. */
const CONTEXT_NAME = "AlternativeMovement";
const ACTION_NAME = "UHJK";

/** The name this binding is registered under, for `UnbindFromRenderStep` if it ever has to be. */
const BINDING_NAME = "AlternativeMovement";

/**
 * The four keys the default controls walk with.
 *
 * **Read by the scaffolding below and by nothing else**, which is why the list exists rather than the
 * keys being tested inline: what the diagnostic asks is "is the *keyboard* asking to move", and that
 * question is about these four keys rather than about anything this file binds.
 */
const MOVEMENT_KEYS: Array<Enum.KeyCode> = [
	Enum.KeyCode.W,
	Enum.KeyCode.A,
	Enum.KeyCode.S,
	Enum.KeyCode.D,
];

/**
 * **The whole risk of this change, and it is a documented one rather than a guess.**
 *
 * The default control scripts write the character's movement **every frame**, so a second writer only
 * has any effect if it runs *after* them in the same frame. Two facts from the engine reference fix
 * where that is:
 *
 * - The default control scripts are bound to the render step at **priority 100 (Player Input) and
 *   200 (Camera Controls)**, and lower numbers run first. A `Heartbeat` connection would not do at
 *   all: `Heartbeat` runs *after* the physics step, so anything written there is overwritten by the
 *   next frame's render step before it is ever simulated.
 * - `Enum.RenderPriority.Character` is **300** — after both of them, and the value the enum reserves
 *   for exactly this: "intended for character-response callbacks".
 *
 * It is also the right slot for the *camera*: the camera script updates at 200, so a movement call
 * bound at 300 is resolved against this frame's camera rather than last frame's, which is what
 * `relativeToCamera` below means.
 *
 * The docs put it plainly for `Humanoid:Move`: *"RunService:BindToRenderStep() is required here as
 * the default control scripts will overwrite the player's movement every frame."* **Do not move this
 * to `Heartbeat` or a bare `RenderStepped:Connect`** — the first never lands, and the second lands in
 * connection order, which is not ours to choose.
 */
const MOVE_PRIORITY = Enum.RenderPriority.Character.Value;

/**
 * The context's own priority, against the *other* contexts — a different ladder from {@link MOVE_PRIORITY}.
 *
 * **`2000`, and the reason has changed twice.** The first version sat at `100`, on the sound argument
 * that the default controls should win any tie — which does nothing here, because the defaults bind
 * WASD and this context binds four keys of its own, so there is no tie to break. It was then raised
 * on the theory that the default camera claims **`I`** as zoom in and would swallow it from a
 * lower-priority context. **That theory was never confirmed and the key it was about is no longer
 * used** — the binding is `U`/`H`/`J`/`K`, chosen so that this file sits on none of the camera's
 * documented zoom keys. This ladder is not where a key is lost in any case: nothing here sinks, so
 * this context cannot take a key from anyone, and sitting lower would lose one exactly the same way.
 *
 * The number stays where it is, on the engine reference's own terms rather than on that theory:
 * `2000` is the figure given for a context that sits above the default `PlayerScripts` contexts, and
 * no key code is shared with them, so nothing is decided by it either way. **WASD is untouched**
 * regardless — this context sinks nothing, so the defaults still receive every key they ever did, and
 * what keeps the two movement writers from fighting is the zero-vector guard in the render step.
 */
const CONTEXT_PRIORITY = 2000;

/**
 * **A second movement source on `U`/`H`/`J`/`K`, alongside WASD rather than instead of it.**
 *
 * **Additive, and that is the whole design.** The default `PlayerModule` keeps everything it already
 * does — jumping, the camera, WASD — and this adds a call to `Humanoid:Move` that only happens while
 * a key this context owns is held. It does not sink WASD, does not disable or fork the module, and
 * does not replace any detection: with no `U`/`H`/`J`/`K` key down this file writes nothing at all,
 * and the default controls behave exactly as they did before it existed.
 *
 * **Why a second `Move` call is safe here and what makes it safe is the guard, not the priority.**
 * `Humanoid:Move` sets the direction the humanoid walks in, and the last caller in a frame wins — so
 * the rule this file lives by is that it only calls `Move` with a *non-zero* direction. A zero-vector
 * call would cancel the default module's movement for that frame, which is the failure that stops
 * WASD working while these keys are idle. See the render step below.
 *
 * **Why these four keys and not `I`/`J`/`K`/`L`.** The set started as IJKL and was moved one key to
 * the left, the same cluster for the same right hand: `I`→`U`, `J`→`H`, `K`→`J`, `L`→`K`. `I` is
 * documented as the default camera's zoom-in key, and although no run ever showed the camera *doing*
 * anything with it, **no run ever showed the key reaching the client either** — four sessions of
 * testing produced raw input lines for `J`, `K`, `L` and a stray `H`, and never once for `I`. Moving
 * the cluster off that key costs nothing and closes the question rather than answering it.
 *
 * **What is measured, and what is not.** `J` and `K` have both been seen to drive the *action* — the
 * raw input line and the action's own `StateChanged` line, the second carrying the direction that
 * belongs to the key — and `H` has been seen as a raw input event, so it at least reaches the client.
 * `L` was proven the same way and is no longer bound. **`U` has never been pressed in any capture**,
 * and is the one key here with nothing behind it.
 *
 * **The open fault is not in this file, and it is the same one.** The render step is proven to run, to
 * resolve the body, to read a real `Vector2` from the action, and to call `Humanoid:Move` with the
 * camera-space vector that belongs to each key — `MoveDirection` echoes that vector back inside the
 * same frame, so the direction is accepted and nothing here is dropping it. What is left is either a
 * humanoid that cannot walk at all or a writer that runs later in the frame than this one; the
 * scaffolding in the render step prints the two readings that tell those apart.
 */
@Controller()
export class AlternativeMovementController implements OnStart {
	/**
	 * The action this controller reads.
	 *
	 * Held rather than reached for each frame: the render step is the wrong place to be walking the
	 * DataModel, and this never changes after the mount.
	 */
	private action?: InputAction;

	public onStart(): void {
		// Spawned for the reason every controller does it: the mount creates instances and is not
		// something the rest of the client's boot should wait behind.
		task.spawn(() => this.mount());
	}

	private mount(): void {
		const action = buildAction();
		this.action = action;

		// **The line that says whether the action ever saw the key at all**, and it is the first thing
		// worth knowing when a direction does nothing: a context that never receives `U` and a context
		// that receives it and moves nothing look identical from the player's seat, and they have
		// completely different causes. One line per change — a press and its release are two — so
		// pressing `U` and seeing nothing here is the whole diagnosis, and seeing `(0, 1)` here with a
		// character that does not move means this file is fine and the fault is in the `Move` call.
		if (DEBUG) {
			action.StateChanged.Connect((state) => print(`[Move] ${ACTION_NAME} -> ${tostring(state)}`));
		}

		// **Scaffolding: what does the *client* see?** The `StateChanged` line above says whether the
		// action received a key; this says whether the raw input event did, and the pair of them
		// separates the three cases that otherwise look identical from a player's seat:
		//
		// - **Neither line** — the press never reached the game. A chat box or another focused
		//   `TextBox` is the usual cause, which is what `gameProcessed` below reports.
		// - **This line only** — the key arrived and the `InputContext` did not see it, so the fault is
		//   in the context, the action or the binding rather than in the driver.
		// - **Both** — the action is reporting a direction and the character still is not moving, which
		//   puts the fault in the `Move` call itself.
		//
		// It drives nothing — it is a print and nothing else — so it is not a second movement path, and
		// it goes when the question does. `gameProcessed` is worth its place here for a reason beyond
		// this file: `DodgeController` drops a press whose input reports it, so a `true` on `U` would
		// explain a missing forward dodge as well as a missing step forward.
		//
		// **It watches every key rather than this file's four, and that is the point of it.** A log
		// that contains only the absence of a key cannot tell "it was never pressed" from "it never
		// reached the client" — they are the same log, which is precisely how `I` was chased for two
		// sessions before the keys were moved off it. Watching everything gives the test its own
		// control: press a key that has to work next to one that might not, and the gap where the
		// second line should be is the answer rather than an artefact of the capture.
		//
		// **Keyboard only.** `InputBegan` fires for the mouse as well, and every button reports a
		// `KeyCode` of `Unknown`, which would print a line per click for no reason.
		if (DEBUG) {
			UserInputService.InputBegan.Connect((input, gameProcessed) => {
				if (input.UserInputType !== Enum.UserInputType.Keyboard) return;

				print(`[Move] raw ${input.KeyCode.Name} — gameProcessed ${gameProcessed}`);
			});
		}

		// **Scaffolding: whether the window itself lost focus, which is the one event that explains a
		// body stopping dead with the key still down.** Three controllers in this codebase handle
		// `WindowFocusReleased` — `SprintController` on the sprint keys, and `DodgeController` and
		// `SuperAbility` on theirs — and every one of them *clears the keys it believes are held*,
		// because a key-up delivered while the window is elsewhere never arrives here. That is the
		// right behaviour and it is invisible in a capture: the release it produces is the same line
		// the player letting go produces, so the two causes read identically.
		//
		// **`LeftAlt` was the suspect these lines were added for, and it is gone from the game.** The
		// sprint used to be bound to it, and Alt is the one key Windows itself does something with: a tap
		// hands the window's focus to the system menu and back, which fires the release above, drops the
		// keys the engine's default controls believe are held — `S` included, still physically down — and
		// leaves a body that will not move until a fresh press. The sprint has since moved to
		// `LeftShift`, so that particular trigger is gone by construction and these two prints are no
		// longer watching for it. **They stay, because the mechanism is not specific to Alt**: a chat
		// box, an alt-tab, a notification stealing focus, and any future binding on a key the operating
		// system has an opinion about all produce the same reading, and it is a reading that is
		// expensive to reconstruct from a log after the fact.
		if (DEBUG) {
			UserInputService.WindowFocusReleased.Connect(() => print(`[Move] window focus LOST`));
			UserInputService.WindowFocused.Connect(() => print(`[Move] window focus back`));
		}

		// **The humanoid is re-resolved per body; the *connection* is not.** `CharacterAdded` fires
		// once for each new character and one subscription serves every one of them, so what has to
		// change on a respawn is the reference this closure holds and nothing else. Seeded from the
		// character as it is now, because a player who joins and stands still may never see the event
		// again — and `CharacterRemoving` clears it, because a destroyed humanoid is not something to
		// call a method on: left in place, the render step would throw every frame for the rest of the
		// session after the first death.
		//
		// **The seed is `nil` for every player on every load, which is what makes the event
		// load-bearing.** This runs while `Players.LocalPlayer.Character` is still `nil` — the loading
		// screen on the same client has not seen a character yet at the moment this line executes — so
		// the seed always misses and `CharacterAdded` is the only thing that ever fills the reference
		// in. Read the render step for what happens when that event misses too.
		const player = Players.LocalPlayer;
		let humanoid = humanoidOf(player.Character);

		player.CharacterAdded.Connect((character) => {
			humanoid = humanoidOf(character);
		});

		player.CharacterRemoving.Connect(() => {
			humanoid = undefined;
		});

		/** The last frame line printed, so the scaffolding below narrates a *change* and not a frame rate. */
		let lastFrameLine = "";

		/**
		 * The last held-keys line printed, for the same reason.
		 *
		 * A separate variable from {@link lastFrameLine} because the two narrate different things: that
		 * one is about the body, this one is about the keyboard, and a change in either is worth a line
		 * even when the other has not moved.
		 */
		let lastKeyLine = "";

		/** The last direction `Move` was called with, so a re-press of the same key prints again. */
		let lastCalled = "";

		RunService.BindToRenderStep(BINDING_NAME, MOVE_PRIORITY, () => {
			// **Re-resolved on any frame where it is missing, and this is not belt-and-braces — it is
			// the race.** `CharacterAdded` hands over the `Character` *model*, and the model's children
			// replicate separately: the event can fire while `FindFirstChildWhichIsA("Humanoid")` still
			// answers `nil`, and since the event does not fire a second time for the same character, a
			// miss there is permanent. The failure is completely silent, and it is the exact shape of
			// the one this file just produced — the action reports the key, `Move` is never reached,
			// and nothing errors, because the only reader of the reference was a `return` on the next
			// line. This costs one `FindFirstChildWhichIsA` on a frame with no body, and nothing at all
			// once there is one.
			if (humanoid === undefined) humanoid = humanoidOf(player.Character);

			// **Scaffolding: the direction the *keyboard* is asking for, against the direction the
			// humanoid is being walked in.** These are two different facts and the freeze is the gap
			// between them: `IsKeyDown` is the physical key, and `MoveDirection` is what the last
			// writer in the frame asked for. A held `W`/`A`/`S`/`D` with a zero `MoveDirection` is a
			// body *nobody is asking to move* — the default controls have lost the key, which is what a
			// focus loss does to them — and that is the reading the freeze needs, because from the
			// player's seat a body that cannot walk and a body nobody is asking to walk look identical.
			//
			// **The reverse is deliberately not printed.** A non-zero `MoveDirection` with no direction
			// key down is this file's own `U`/`H`/`J`/`K` source doing its job, so a line for it would
			// be one this file prints at itself whenever its own feature works.
			//
			// Printed on change and not per frame, for the reason the frame line above is, and the
			// vector is printed in full rather than its length: a `nan` in it is a different fault
			// again and would read as `0`. `WalkSpeed` and the focused text box ride along because they
			// are the two legitimate reasons a held key moves nothing — a body that is not allowed to
			// walk, and a keyboard that is typing rather than playing.
			if (DEBUG) {
				const held = MOVEMENT_KEYS.filter((key) => UserInputService.IsKeyDown(key));
				const asked = humanoid !== undefined && humanoid.MoveDirection.Magnitude > 0;

				if (held.size() > 0 && !asked) {
					const line =
						`${held.map((key) => key.Name).join("+")} held, ` +
						`MoveDirection ${humanoid === undefined ? "n/a" : tostring(humanoid.MoveDirection)}, ` +
						`WalkSpeed ${humanoid === undefined ? "n/a" : string.format("%.1f", humanoid.WalkSpeed)}, ` +
						`text box ${UserInputService.GetFocusedTextBox() === undefined ? "no" : "yes"}`;

					if (line !== lastKeyLine) {
						lastKeyLine = line;
						print(`[Move] keys — ${line}`);
					}
				}
			}

			// **Read from `GetState`, which is the action's current value** — a `Direction2D` action
			// answers with a `Vector2`, and one that has never been touched answers with something
			// that is not one, which is why this is a type test rather than a cast.
			const state = action.GetState();

			// **Scaffolding: what this closure actually sees.** The two prints above say the key
			// arrived and the action read it; neither says whether the render step got as far as its
			// `Move` call, and every way of failing to get there is silent — so this line names the
			// three facts that decide it:
			//
			// - `state` and its `typeOf`: whether the type test below passes at all. **Measured: it
			//   passes.** The test is not the fault and can be trusted.
			// - the humanoid, or `none`: whether the reference was ever filled in. **Measured: `none`
			//   on the first frame of the session, a name by the next** — the seed really does always
			//   miss, and the re-resolution below is what fills it in.
			// - `PlatformStand` and the root's `Anchored`, because **a humanoid that cannot walk accepts
			//   a direction and ignores it**, and both of those leave `WalkSpeed`, the state and
			//   `MoveDirection` reading exactly as they do on a healthy character — which is the shape of
			//   this failure and the reason these two are here. `PlatformStand` is not hypothetical in
			//   this codebase: the dodge sets it for its whole duration, so a character mid-dash is a
			//   character that will not answer `Move`. **Measured: both `false` on a character that is
			//   walking**, which is what rules the pair out as the reason a key does nothing.
			//
			// **`MoveDirection` used to be on this line and is not any more, deliberately.** It varies on
			// every frame the character is walking, so it made the comparison below true every frame and
			// turned a diagnostic into a heartbeat — thirty lines a second in the first log that captured
			// a walk, which buries the lines it was meant to be read against. Rounding it would only
			// soften that, because a character that is turning changes its rounded direction too. And it
			// has already said everything it had to say: it is echoed by `Move` inside the same frame, so
			// it was never the overwrite test it was written as, and the walking it demonstrated is
			// visible in the character's own movement.
			//
			// **The check below is the point of the line and has to survive.** A line that prints every
			// frame is not a report of anything, because a reader cannot pick out which of forty
			// identical-looking lines was the one where something changed.
			if (DEBUG) {
				const line =
					`state ${tostring(state)} (${typeOf(state)}) — humanoid ` +
					`${humanoid === undefined ? "none" : (humanoid.Parent?.GetFullName() ?? "?")}, ` +
					`PlatformStand ${humanoid === undefined ? "n/a" : tostring(humanoid.PlatformStand)}, ` +
					`root anchored ${humanoid?.RootPart?.Anchored ?? "n/a"}`;

				if (line !== lastFrameLine) {
					lastFrameLine = line;
					print(`[Move] frame — ${line}`);
				}
			}

			if (!typeIs(state, "Vector2")) return;

			// **Up is `+Y` and forward is `-Z`.** `W`/`U` are the action's `Up`, so a held `U` reads
			// as `(0, 1)`; the camera-space forward axis is `-Z`. `ClampMagnitudeToOne` on the binding
			// keeps a diagonal (`(1, 1)`) from being longer than a single key, so this vector is at
			// most 1 long and a diagonal is not faster than a straight line.
			const direction = new Vector3(state.X, 0, -state.Y);

			// **The guard the whole arrangement rests on.** Nothing is written while these keys are
			// idle, so the default module's own call is the only one this frame and WASD keeps working.
			// See the class doc.
			if (direction.Magnitude === 0) {
				lastCalled = "";

				return;
			}

			// After the guards rather than before them, so that a missing body is reported by the
			// frame line above instead of being swallowed by a `return` at the top.
			if (humanoid === undefined) return;

			// **`relativeToCamera = true`, and this is what makes it feel right rather than merely
			// work.** The direction above is written in *camera* space — one step of "forward" as the
			// camera sees it — and the parameter is the engine's own translation of that into world
			// axes. Building the world vector here instead, out of `Camera.CFrame`, would be the same
			// arithmetic one frame earlier and would be wrong in the same way the default controls
			// are: an extra pitch to flatten, a right vector to cross, and a heading that is stale by
			// the time the physics step reads it. Without this argument the character would walk
			// along fixed world axes no matter where the camera looked, which is the failure this
			// line exists to prevent.
			humanoid.Move(direction, true);

			// **Scaffolding: what `MoveDirection` reads immediately after the call.** **Measured: it
			// reads the direction back**, so `Move` accepts this call and nothing in this file is
			// dropping it. What this line was written to test — that a value gone by the next frame
			// means a writer bound after {@link MOVE_PRIORITY} is replacing this one — is **not
			// supported**: the value is back to `(0, 0, 0)` a frame later on a character that is simply
			// not walking, which is exactly what "the direction it is walking in" describes. It stays
			// for the echo, not as an overwrite test.
			//
			// **The ground speed is the reading that matters**, and it is the one thing here that a
			// call landing and being ignored cannot satisfy: it is the body's own velocity after the
			// last physics step, so it reports whether the character is being carried at all rather
			// than whether it was asked to move. Once per press — `WalkSpeed` and the state ride along
			// because they are the other two reasons a direction gets ignored, and they cost nothing
			// to read here.
			if (DEBUG && tostring(direction) !== lastCalled) {
				lastCalled = tostring(direction);

				// Horizontal only: a character standing on the ground still reads a little vertical
				// noise, and the question is whether it is being carried sideways.
				const velocity = humanoid.RootPart?.AssemblyLinearVelocity;
				const speed = velocity === undefined ? -1 : new Vector3(velocity.X, 0, velocity.Z).Magnitude;

				print(
					`[Move] called ${direction} on ${humanoid.Parent?.Name ?? "?"} — MoveDirection reads ` +
						`${humanoid.MoveDirection}, WalkSpeed ${humanoid.WalkSpeed}, ` +
						`state ${humanoid.GetState().Name}, ground speed ${string.format("%.1f", speed)} studs/s`,
				);
			}
		});

		if (DEBUG) {
			print(
				`[Move] up — ${CONTEXT_NAME}.${ACTION_NAME}, context priority ${CONTEXT_PRIORITY}, ` +
					`bound to the render step at ${MOVE_PRIORITY}`,
			);
		}
	}
}

/** The local player's live humanoid, or nothing while there is no body to move. */
function humanoidOf(character: Model | undefined): Humanoid | undefined {
	return character?.FindFirstChildWhichIsA("Humanoid");
}

/**
 * The context and the action, made once.
 *
 * `ReplicatedStorage.Inputs` is where the engine's own documentation puts input contexts, and the
 * full path is printed on failure rather than assumed — see the mount line.
 *
 * **One binding carrying all four keys rather than four bindings**, because the four are one
 * direction: `Up`/`Down`/`Left`/`Right` on a single `InputBinding` is the composite the engine is
 * built for, and four separate bindings would each have to be kept in step with the others to say
 * the same thing.
 *
 * **`Sink` is off.** Sinking is what would let this context consume its bound keys and block them
 * from lower-priority contexts — right for a context that means to *replace* a control, and wrong
 * for one that means to sit beside it. WASD is not this context's to take away.
 */
function buildAction(): InputAction {
	let inputs = ReplicatedStorage.FindFirstChild("Inputs");

	if (inputs === undefined || !inputs.IsA("Folder")) {
		const folder = new Instance("Folder");
		folder.Name = "Inputs";
		folder.Parent = ReplicatedStorage;
		inputs = folder;
	}

	const context = new Instance("InputContext");
	context.Name = CONTEXT_NAME;
	context.Enabled = true;
	context.Sink = false;

	// **Priority `CONTEXT_PRIORITY` — above the default scripts rather than below them.** See that
	// constant for the whole argument. Nothing here sinks, so this ladder cannot be why a key goes
	// missing; the keys themselves were moved off the one that did.
	context.Priority = CONTEXT_PRIORITY;
	context.Parent = inputs;

	const action = new Instance("InputAction");
	action.Name = ACTION_NAME;
	action.Type = Enum.InputActionType.Direction2D;
	action.Parent = context;

	// **The cluster is the one a step to the left of IJKL, so every key shifts rather than one being
	// renamed**: `U` is up, `H` left, `J` down, `K` right — each one key left of the `I`/`J`/`K`/`L`
	// key that meant the same thing. Written out because two of the four do not read the way the name
	// suggests: `K` is *right*, where anyone reading this as "IJKL with a letter swapped" would take
	// it for down, and the same for `U` against `I`.
	const binding = new Instance("InputBinding");
	binding.Name = "Keyboard";
	binding.Type = Enum.InputBindingType.Automatic;
	binding.Up = Enum.KeyCode.U;
	binding.Down = Enum.KeyCode.J;
	binding.Left = Enum.KeyCode.H;
	binding.Right = Enum.KeyCode.K;
	binding.ClampMagnitudeToOne = true;
	binding.Parent = action;

	return action;
}
