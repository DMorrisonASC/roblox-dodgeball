import { Controller, OnStart } from "@flamework/core";
import Net from "@rbxts/net";
import { Players, UserInputService, Workspace } from "@rbxts/services";
import { flattenToGround } from "shared/dodge";
import { events } from "shared/networking";
import { inRoundOrZone } from "../../roundZone";

/** Prints each completed combination, every refusal, and whether the request went out. */
const DEBUG = true;

/**
 * Every input that can dodge, and the direction each one points.
 *
 * Read in *camera space*: `Z` is the camera's heading and `X` is across it to the right, so `W` is
 * one step of heading and `A` is one step of -right.
 *
 * **The table is the rule as well as the geometry.** An input dodges exactly when it has a row here,
 * which is what lets a diagonal be added without a second list to keep in step — and what makes
 * `W+S`, `A+D` and anything holding three keys invalid *by being absent* rather than by being
 * checked for. Each diagonal is written as the sum of the two keys it is made of, so there is
 * nothing here that can drift from the singles.
 *
 * A key is named by `Enum.KeyCode.Name`, and the keys held are named by sorting them and joining
 * them — see {@link comboOf} — so `W` with `A` and `A` with `W` are both the row `"AW"`. **The order
 * the player pressed them in is not part of any of this**, which is the same reason the input was
 * spelled this way before: what is being named is a *set* of keys down at one moment, and two orders
 * of arriving at one set are one direction.
 */
const COMBO_AXES: Record<string, Vector3 | undefined> = {
	W: new Vector3(0, 0, 1),
	S: new Vector3(0, 0, -1),
	D: new Vector3(1, 0, 0),
	A: new Vector3(-1, 0, 0),
	AW: new Vector3(-1, 0, 1),
	DW: new Vector3(1, 0, 1),
	AS: new Vector3(-1, 0, -1),
	DS: new Vector3(1, 0, -1),

	// **The same geometry for the other hand, and it has to be here rather than in a second table.**
	// `U`/`H`/`J`/`K` is the alternative to WASD — `AlternativeMovementController` moves the body with
	// these four keys — and a dodge has to come from either set or the two features disagree about
	// which keys count as movement. `W` and `U` are one step of heading, `H` and `A` one step of
	// -right; a player who has learned one set has learned the other.
	//
	// **Rows are keyed by the *sorted* join of the keys — see {@link comboOf} — so the key is not the
	// pair written the way it is read.** `U` with `H` is the row `"HU"` and `U` with `K` is `"KU"`,
	// because `H` and `K` sort before `U`. That ordering is the table's own rule and not a detail of
	// these rows: writing `UH` here would be a row nothing ever looks up, and the diagonal it was
	// meant to describe would silently become a combination that dodges nothing at all.
	//
	// The diagonals are here for the reason the WASD ones are, which is not symmetry for its own
	// sake: a player holding `W` and `A` and clicking is asking for a diagonal, and it is the
	// direction they are already moving in. Leaving `U+K` out would not make it dodge differently
	// from `D+W`, it would make it a press that does nothing.
	U: new Vector3(0, 0, 1),
	J: new Vector3(0, 0, -1),
	K: new Vector3(1, 0, 0),
	H: new Vector3(-1, 0, 0),
	HU: new Vector3(-1, 0, 1),
	KU: new Vector3(1, 0, 1),
	HJ: new Vector3(-1, 0, -1),
	JK: new Vector3(1, 0, -1),
};

/**
 * The button that completes a dodge, with a movement key.
 *
 * **The right one, and it is free — verified, not assumed.** Nothing in this game binds
 * `MouseButton2`: the throw and everything that aims use the *left* button (`ThrowController`), and
 * the only other mouse handlers in the project are UI buttons. Right-click-drag does rotate the
 * engine's camera, and that is the one thing to know about this binding: **a dodge is *read* off the
 * press, never taken from it**, because nothing here sinks or rebinds the button. The camera keeps
 * every press it ever had, and this gets one alongside it.
 */
const DODGE_BUTTON = Enum.UserInputType.MouseButton2;

/**
 * `keys` as the canonical name of the input they make.
 *
 * Sorted, so the order the player pressed them in cannot matter: `W` with `A` and `A` with `W` are
 * one direction and have to produce one string, or the diagonal could be dodged in by one finger
 * order and not the other.
 */
function comboOf(keys: Set<Enum.KeyCode>): string {
	const names: string[] = [];
	for (const key of keys) names.push(key.Name);
	names.sort();

	return names.join("");
}

/** The client half of the dodge remote, as the declarations build it. */
type ClientRemotes = Net.Util.GetClientRemotes<Net.Util.GetDeclarationDefinitions<typeof events>>;

/**
 * Turns a movement key plus a right-click into a dodge request. Decides nothing
 * else.
 *
 * **The binding, and what it replaced.** A dodge used to be a *double-tap* of a movement key: two
 * presses of the same input within `DOUBLE_TAP_WINDOW` (0.5s), with `GESTURE_WINDOW_MS` (100ms)
 * deciding whether a second key was the other half of one press or a turn — both deleted from
 * `dodge.config.ts` along with this binding, because nothing in the tree reads them now. What is
 * left is a *combination*: the right mouse button plus a movement key, held or tapped, in either
 * order. A combination has no rhythm to measure, so this class no longer owns a clock at all; what
 * it owns is which keys are down and whether the button is.
 *
 * **Why the click is the trigger and the keys are the direction.** The click is the thing the player
 * *does* — an event, with a moment — and the keys are a state that is already down for movement. So
 * the direction is read off the keys at the instant the combination completes, which is what makes
 * the same code answer both orders: a key that is already down when the click lands, and a click
 * that is already down when the key lands.
 *
 * **No prediction on purpose:** the server owns the dash and replication brings the character along
 * with it, so this class has no idea whether the dodge happened and does not need one. **And the
 * flourish is the server's, not this one's** — `DodgeService.playDodgeAnimation` starts it there, on
 * purpose, so that every client sees somebody else's dodge rather than only the dodger seeing their
 * own. A track played here would be a private flourish, which is the one thing a dodge cue must not
 * be.
 */
@Controller()
export class DodgeController implements OnStart {
	private readonly player = Players.LocalPlayer;

	/**
	 * The keys currently held down.
	 *
	 * `InputBegan` does not mean "the player pressed this key once". The engine re-sends it
	 * for a key that never came up — while a held key repeats, when the window regains focus,
	 * when a chat box closes and the key state is handed back to the game. Counted as presses,
	 * any two of those would be a dodge nobody asked for. A key already in here is not a press.
	 *
	 * **This is also the whole of what decides the direction.** A dodge points the way the keys that
	 * are down point, read through {@link COMBO_AXES} by {@link comboOf} — so the set is not
	 * bookkeeping kept beside the input, it *is* the input, and its whole contents are read at once.
	 */
	private readonly heldKeys = new Set<Enum.KeyCode>();

	/**
	 * Whether the dodge button is down, and the reason a held click is one dodge rather than many.
	 *
	 * **The same guard the keys get, for the same reason.** `InputBegan` is not "the player pressed
	 * this once": the engine re-sends it for a button that never came up, when the window regains
	 * focus or a menu closes. Read as a fresh press every time, a held right-click would dodge again
	 * on each of those — and, worse, the whole combination would become a *state* that dodges on
	 * every cooldown expiry for as long as both halves were held. Only the button coming up clears
	 * this, so **one press is one dodge** however long the player keeps holding.
	 *
	 * **Not the same question as `IsMouseButtonPressed`**, which is asked for the other order and is
	 * the engine's answer about *now*. This is this controller's answer about *events*, and the two
	 * are deliberately not shared: the engine does not know which presses this class has already
	 * acted on, and a latch is the only thing that can.
	 */
	private rightDown = false;

	/** Resolved on first use: `Client.Get` waits for the server's remote. */
	private dodgeRemote?: ClientRemotes["dodge"];

	public onStart(): void {
		UserInputService.InputBegan.Connect((input, gameProcessed) => {
			// Typing in chat, or a menu is open: not a movement key and not a dodge click, whatever
			// it was. Honoured for the button as well as for the keys, which is a decision worth
			// naming — the engine's camera rotates on a right-drag, and whether that arrives
			// *processed* is not something this file can find out from here. If a right-click turns
			// out to be swallowed in practice, this branch is the one to change: dropping the check
			// for the button alone would also make a click in a menu a dodge nobody asked for.
			if (gameProcessed) return;

			if (input.UserInputType === DODGE_BUTTON) {
				this.onRightDown();
				return;
			}

			this.onDown(input.KeyCode);
		});

		// The releases are what make a press out of a hold, so they are taken however the engine
		// labels them: a release is unambiguous, and one delivered while a menu has focus is still
		// a release. The button's release is as load-bearing as the keys' — see `rightDown`.
		UserInputService.InputEnded.Connect((input) => {
			if (input.UserInputType === DODGE_BUTTON) {
				this.rightDown = false;
				return;
			}

			this.heldKeys.delete(input.KeyCode);
		});

		// Losing focus hands the releases to whatever took it, so a key or a button held at that
		// moment would keep its entry for the rest of the session and that input could never fire
		// again. Nothing is more certain than the window not having the key.
		UserInputService.WindowFocusReleased.Connect(() => {
			this.heldKeys.clear();
			this.rightDown = false;
		});

		// Printed once at startup, for the same reason as the catch's bind line: it separates "no
		// combination ever arrived" from "a combination arrived and did nothing". A press is dropped
		// *silently* while the chat box has focus — that is what `gameProcessed` means — and having
		// just typed a dev command is exactly how a player ends up in that state, so this line is
		// also how that shows up as the cause rather than as a broken dodge.
		if (DEBUG) print(`[Dodge] bound: a movement key plus right-click`);
	}

	/**
	 * Registers a press of `key`, and asks for a dodge if the button is already down.
	 *
	 * The gate that makes a press real: whatever the engine's reason for announcing a held key
	 * twice, the second announcement is not something the player did, and only a release can clear
	 * the way for a new press. A key already held is added to nothing and fires nothing.
	 *
	 * **The second order lives here.** A click that arrives with no key down has nothing to point
	 * at, so it does nothing on its own; the key that follows is what completes the combination and
	 * this is the line that catches it. The engine is asked about the button rather than a second
	 * copy of its state being kept, which is what keeps the two orders from needing two pieces of
	 * state to agree with each other.
	 *
	 * **A key pressed while the button is held is a new press of the combination**, so holding the
	 * button and tapping `W`, `A`, `S`, `D` in turn is four presses and up to four dodges — bounded
	 * by the server's cooldown, and each one a deliberate thing the player did. What cannot happen is
	 * a dodge from keys that are *merely held*: nothing here runs on a clock, and every dodge is
	 * caused by a press.
	 */
	private onDown(key: Enum.KeyCode): void {
		if (!isMovementKey(key)) return;

		if (this.heldKeys.has(key)) return;

		this.heldKeys.add(key);

		if (UserInputService.IsMouseButtonPressed(DODGE_BUTTON)) this.press();
	}

	/**
	 * Registers a press of the dodge button, and asks for a dodge if a movement key is down.
	 *
	 * **The one-per-press guard is the first line, and it is the whole difference between a binding
	 * and a bug.** Everything else here is an event handler: this fires when the button goes down,
	 * `tryDodge` reads the keys and sends at most one request, and nothing resends. Without this
	 * latch the second announcement of a held button would be a second dodge, and — because the
	 * direction comes from a state rather than from the event — holding `W` and the button would
	 * dodge again every time the server's cooldown expired, which is a stutter that makes the
	 * cooldown meaningless. See {@link rightDown}.
	 */
	private onRightDown(): void {
		if (this.rightDown) return;

		this.rightDown = true;

		this.press();
	}

	/**
	 * **The keyboard's dodge: the right-click completed by the keys that are down.** Called by both orders, and
	 * public because the cluster's Dodge button is a second way to ask for the same request — see {@link push},
	 * which is the one thing about it that differs.
	 *
	 * The direction is worked out here rather than at either call site: all the two events decide between them is
	 * *when* the combination became complete. The combo is the held keys sorted and joined — {@link comboOf} —
	 * which is the same string the double-tap binding built for its gesture, and for the same reason: the order
	 * the keys went down in cannot be part of what the input means.
	 */
	public press(): boolean {
		const combo = comboOf(this.heldKeys);

		// **Right-click alone is nothing.** Every direction in this game is a key, so a click with no
		// key down has no direction to dodge in: the combination is the input, and half of it is not
		// an input. This is also the ordinary case rather than a mistake — a player dragging the
		// camera with the button down and no hand on the movement keys — so it is not a refusal worth
		// shouting about, only worth a line when the logs are being read.
		if (combo === "") {
			if (DEBUG) print(`[Dodge] right-click with no movement key held`);
			return false;
		}

		// Not a dodge input — `W`+`S`, three keys at once. **The table is the rule and an absent row
		// is the whole of it**: there is no fallback to "the most recently pressed key", because a
		// player asking for two opposite directions has not asked for a direction, and picking one of
		// the two would be inventing an answer. See `COMBO_AXES`.
		if (!isDodgeCombo(combo)) {
			if (DEBUG) print(`[Dodge] ${combo} is not a direction to dodge in`);
			return false;
		}

		// **The key's row *is* a direction, and it is the only thing this path has to turn into one.** Unreachable
		// as `undefined` — `isDodgeCombo` just said the row exists — and written as a guard rather than an `as`
		// because an assertion here would be a claim about a table in another file.
		const axis = COMBO_AXES[combo];
		if (axis === undefined) return false;

		const axes = this.cameraAxes();
		if (axes === undefined) return false;

		return this.requestDodge(combo, dodgeDirection(axis, axes[0], axes[1]), axes[0]);
	}

	/**
	 * **The cluster's dodge, and the one decision this feature needed: the direction is the stick's.**
	 *
	 * On a keyboard the direction is *input* — a set of keys, which `COMBO_AXES` turns into a camera-space axis
	 * and the camera then turns into a heading. A touch device has no such keys, and the thing the player is
	 * already doing with the direction they want is pushing the stick, so the direction is read from the body
	 * instead: `Humanoid.MoveDirection` is exactly the world direction the movement input asked for, which is
	 * the stick's own answer after the engine has converted it and the body has been told.
	 *
	 * **`MoveDirection` rather than the stick itself, because the engine already owns the conversion.** Reading
	 * the control module's thumbstick directly would be a second reader of the thing `Humanoid` exists to
	 * expose, and it would have to be found, typed and kept working across a Roblox update — for a vector the
	 * body already has.
	 *
	 * **The camera is read for the frame the direction was decided in, and the direction is not re-derived from
	 * it.** A key gets multiplied by the camera's axes because that is what a key *means* ("away from the
	 * camera"); the stick has already been through that conversion, so its heading is sent as it stands and the
	 * camera is read only for the reference the clip is classified against. See `dodgeDirectionOf` for that rule.
	 *
	 * **A centred stick is refused rather than guessed at**, which is the same answer the keyboard gives a
	 * right-click with no key down — a dodge towards nothing is not a direction, and the two candidate guesses
	 * (the body's facing, the camera's heading) are both answers the player did not give. Nothing happens, and
	 * the log says which of the two refusals it was.
	 */
	public push(): boolean {
		const humanoid = this.findHumanoid();
		if (humanoid === undefined) {
			if (DEBUG) print(`[Dodge] the button with nothing to move`);

			return false;
		}

		const move = flattenToGround(humanoid.MoveDirection);
		if (move === undefined) {
			if (DEBUG) print(`[Dodge] the button with the stick centred — nothing to dodge towards`);

			return false;
		}

		const axes = this.cameraAxes();
		if (axes === undefined) return false;

		return this.requestDodge("the stick", move, axes[0]);
	}

	/**
	 * The camera's ground heading and its ground right, or `undefined` when there is no camera to take either
	 * from — with the two refusal lines, because a camera that is not there and a camera pointed straight up are
	 * different faults and this is the only place that can tell them apart.
	 *
	 * **Both are flattened**, so an aim at the floor still dodges along it: the camera's own pitch is dropped, and
	 * the right vector is taken from the camera rather than crossed from the heading, so it stays correct with the
	 * camera pointed straight down. That is the read every path shares — the keyboard builds its direction from
	 * these, and the stick's own heading is classified against them.
	 */
	private cameraAxes(): [Vector3, Vector3] | undefined {
		const camera = Workspace.CurrentCamera;
		if (!camera) {
			if (DEBUG) print(`[Dodge] no camera to take a heading from`);

			return undefined;
		}

		const forward = flattenToGround(camera.CFrame.LookVector);
		const right = flattenToGround(camera.CFrame.RightVector);
		if (!forward || !right) {
			if (DEBUG) print(`[Dodge] the camera has no heading to dodge along`);

			return undefined;
		}

		return [forward, right];
	}

	/**
	 * Sends one dodge request: the direction to go, and the frame it was decided in.
	 *
	 * **`label` is for the log and nothing else.** It used to be the combo, because the combo was the only
	 * input; now that a stick can ask for a dodge too, the thing both paths have in common is a *direction* —
	 * so the parameter that used to be the input is a word for the log line, and `"the stick"` is what the
	 * cluster's button sends.
	 *
	 * **`direction` is a world heading and `forward` is the frame it was read in**, and the two are passed in
	 * together because everything between them is the caller's: a key becomes a direction by being multiplied
	 * by the camera's axes, and a stick is already one — so the only thing left to decide here is whether this
	 * request may go out at all.
	 *
	 * **The gates come before the send, and each one is here rather than at a call site because both paths ask
	 * it.** `inRoundOrZone` first, because it is not a clock: `DodgeService.requestDodge` asks the same question
	 * and is the authority, and asking it here is what stops a press in the lobby going out on the wire and
	 * coming back a refusal a round trip later. Then the body, then the camera — all three of which the caller
	 * has usually already read, and none of which is worth a parameter that says so.
	 *
	 * Returns whether the request went out.
	 */
	private requestDodge(label: string, direction: Vector3, forward: Vector3): boolean {
		if (!inRoundOrZone(this.player.Character)) {
			if (DEBUG) print(`[Dodge] ${label} + the button outside a round and outside a zone`);

			return false;
		}

		if (this.findHumanoid() === undefined) {
			if (DEBUG) print(`[Dodge] ${label} + the button with nothing to move`);

			return false;
		}

		// **And the frame the direction was decided in, which is the camera's heading — not the body's facing.**
		// The clip a dodge wears is chosen by classifying the direction in the frame the decision was made
		// in, and for a player that frame is the camera: `W` means "away from the camera" because that is
		// what the key does, and the body is free to be pointing anywhere while it does it. Classifying
		// against the body instead was the earlier version, and it produced the wrong clip roughly half the
		// time — `RotationType` is `MovementRelative`, so the body turns to face wherever it is moving, and
		// a dodge asked for a moment after an `S` press is classified against a body that has already
		// turned to face the way it is about to go. See `dodgeDirectionOf`, which states the rule.
		//
		// **It is sent rather than re-derived on the server**, which has no camera to read, and it is the
		// same vector the heading above was built from — so the two are in one frame by construction rather
		// than by two reads happening to agree.
		if (DEBUG) {
			print(
				`[Dodge] ${label} + the button → (${string.format("%.2f", direction.X)}, ` +
					`${string.format("%.2f", direction.Y)}, ${string.format("%.2f", direction.Z)}) ` +
					`camera (${string.format("%.2f", forward.X)}, ${string.format("%.2f", forward.Y)}, ` +
					`${string.format("%.2f", forward.Z)})`,
			);
		}

		this.getDodgeRemote().SendToServer(direction, forward);
		return true;
	}

	/** The local character's humanoid, while it is alive. */
	private findHumanoid(): Humanoid | undefined {
		const character = this.player.Character;
		const humanoid = character?.FindFirstChildWhichIsA("Humanoid");

		return humanoid !== undefined && humanoid.Health > 0 ? humanoid : undefined;
	}

	private getDodgeRemote(): ClientRemotes["dodge"] {
		if (!this.dodgeRemote) {
			this.dodgeRemote = events.Client.Get("dodge");
		}

		return this.dodgeRemote;
	}
}

/** Whether `key` is one of the movement keys, and so is half of a dodge when the button is down. */
function isMovementKey(key: Enum.KeyCode): boolean {
	return COMBO_AXES[key.Name] !== undefined;
}

/** Whether `combo` is an input that dodges at all — one movement key, or one perpendicular pair. */
function isDodgeCombo(combo: string): boolean {
	return COMBO_AXES[combo] !== undefined;
}

/**
 * Where `axis` points, given the camera's heading and its right.
 *
 * **The axis rather than the combo, which is the change the cluster forced.** A key's row in `COMBO_AXES` is a
 * camera-space axis, so the keyboard's direction is this call with the row; the stick's is already a world
 * direction and never reaches here. Both paths therefore agree about what a direction *is* — one arithmetic
 * step, in one place — rather than one of them being written out beside the other.
 *
 * `Unit` and no refusal: the two terms are a unit axis on the camera's own perpendicular vectors, so the sum
 * cannot be a zero vector, and the `undefined` this used to return came from a lookup that has moved to the
 * caller that owns the table.
 */
function dodgeDirection(axis: Vector3, forward: Vector3, right: Vector3): Vector3 {
	return forward.mul(axis.Z).add(right.mul(axis.X)).Unit;
}
