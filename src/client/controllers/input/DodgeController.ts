import { Controller, OnStart } from "@flamework/core";
import Net from "@rbxts/net";
import { Players, UserInputService, Workspace } from "@rbxts/services";
import { DODGE_CONFIG } from "shared/config/dodge.config";
import { flattenToGround } from "shared/dodge";
import { events } from "shared/networking";

/** Prints which key completed a double-tap, and whether the request went out. */
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
 * A key is named by `Enum.KeyCode.Name` and a gesture by its keys sorted and joined — see
 * {@link comboOf} — so `W` then `A` and `A` then `W` are both the row `"AW"` and pair with each
 * other as they should.
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
};

/**
 * How long a second key may follow the first and still count as part of the same press, in seconds.
 *
 * See {@link DODGE_CONFIG.GESTURE_WINDOW_MS}. Seconds, because every clock in this class is.
 */
const GESTURE_WINDOW = DODGE_CONFIG.GESTURE_WINDOW_MS / 1000;

/**
 * `keys` as the canonical name of the gesture they make.
 *
 * Sorted, so the order the player pressed them in cannot matter: `W` then `A` and `A` then `W` are
 * one input and have to produce one string, or two presses of the same diagonal could never pair.
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
 * Turns double-taps on the movement keys into dodge requests. Decides nothing
 * else.
 *
 * No prediction on purpose: the server owns the dash and replication brings the
 * character along with it, so this class has no idea whether the dodge happened
 * and does not need one. When an animation exists, `AnimationTrack:Play()` belongs
 * right after the `SendToServer` below — a throwaway is a local flourish, so it
 * would live here rather than on the server.
 */
@Controller()
export class DodgeController implements OnStart {
	private readonly player = Players.LocalPlayer;

	/**
	 * The last tap made, while it is still young enough to pair with the next one.
	 *
	 * One tap, not one per key: a pair is two taps *in a row*, so a tap that is not the very
	 * next one to arrive can never pair with anything and there is no reason to remember it.
	 *
	 * The combo is the gesture's name — its keys sorted and joined, see {@link comboOf} — so two
	 * presses of `W+A` pair with each other whichever order the keys went down in.
	 */
	private lastTap?: { combo: string; at: number };

	/**
	 * What was pending before the current gesture touched it.
	 *
	 * **A gesture is evaluated more than once**, because every key that joins it inside
	 * {@link GESTURE_WINDOW} re-evaluates it, and each evaluation commits a tap. Without this
	 * snapshot the second evaluation would be judged against the tap *of the same gesture*, which
	 * breaks a gesture in two opposite ways:
	 *
	 * - Re-pressing one key of a held diagonal would read as a double-tap of the whole diagonal —
	 *   the same combo, twice, milliseconds apart. Releasing and re-pressing a key is a gesture that
	 *   carries on, and it must not fire.
	 * - The second tap of `W A` / `W A` would be compared against the `W` the new gesture committed
	 *   instead of against the `A W` the first gesture actually left behind, so the diagonal could
	 *   never pair with itself.
	 *
	 * So every re-evaluation first puts the pending tap back exactly as this gesture found it, and
	 * decides afresh against that.
	 */
	private tapBeforeGesture?: { combo: string; at: number };

	/**
	 * The keys this gesture is made of, which is not the same as the keys held.
	 *
	 * Held keys come and go; a gesture is the set that arrived together, and it stops growing
	 * {@link GESTURE_WINDOW} after it started. Adding a key later is a change of direction, not a
	 * bigger gesture — see {@link onDown}.
	 */
	private gestureKeys = new Set<Enum.KeyCode>();

	/** When the current gesture began, as `os.clock` seconds. Only meaningful while one is running. */
	private gestureStart = 0;

	/**
	 * The keys currently held down.
	 *
	 * `InputBegan` does not mean "the player pressed this key once". The engine re-sends it
	 * for a key that never came up — while a held key repeats, when the window regains focus,
	 * when a chat box closes and the key state is handed back to the game. Counted as taps,
	 * any two of those inside the window are a dodge nobody asked for, which is what holding
	 * `W` and getting a dash is. A key already in here is not a tap.
	 */
	private readonly heldKeys = new Set<Enum.KeyCode>();

	/** Resolved on first use: `Client.Get` waits for the server's remote. */
	private dodgeRemote?: ClientRemotes["dodge"];

	public onStart(): void {
		UserInputService.InputBegan.Connect((input, gameProcessed) => {
			// Typing in chat, or a menu is open: not a movement key, whatever it was.
			if (gameProcessed) return;

			this.onDown(input.KeyCode);
		});

		// The key-ups are what make a *tap* out of a press, so they are taken however the
		// engine labels them: a release is unambiguous, and one delivered while a menu has
		// focus is still a release.
		UserInputService.InputEnded.Connect((input) => this.heldKeys.delete(input.KeyCode));

		// Losing focus hands the key-ups to whatever took it, so a key held at that moment
		// would sit in the set for the rest of the session and that direction could never
		// dodge again. Nothing is more certain than the window not having the key.
		UserInputService.WindowFocusReleased.Connect(() => this.heldKeys.clear());

		// Printed once at startup, for the same reason as the catch's bind line: it
		// separates "no double-tap ever arrived" from "a double-tap arrived and did
		// nothing". A tap is dropped *silently* while the chat box has focus — that is
		// what `gameProcessed` means — and having just typed a dev command is exactly
		// how a player ends up in that state, so this line is also how that shows up as
		// the cause rather than as a broken dodge.
		if (DEBUG) print(`[Dodge] listening for double-taps`);
	}

	/**
	 * Registers a press of `key`, and decides whether it is a tap or part of one.
	 *
	 * The gate that makes a dodge two *presses* rather than one press held: whatever the engine's
	 * reason for announcing the same held key twice, the second announcement is not something the
	 * player did, and only a release can clear the way for a new press.
	 *
	 * What the press *means* depends on what was already held, and there are three cases:
	 *
	 * - **Nothing was.** This press opens a gesture, and the gesture is evaluated straight away.
	 * - **Something was, and it is younger than {@link GESTURE_WINDOW}.** The press is the second
	 *   half of the same gesture — `W` and `A` landing together as one diagonal rather than two
	 *   directions — so the gesture grows by this key and is evaluated again.
	 * - **Something was, and it is older.** The player was already moving and has turned. That is
	 *   not a tap of anything, so nothing is counted and `lastTap` is deliberately left alone:
	 *   a turn neither starts nor interrupts a double-tap.
	 */
	private onDown(key: Enum.KeyCode): void {
		if (!isMovementKey(key)) return;

		if (this.heldKeys.has(key)) return;

		this.heldKeys.add(key);

		const now = os.clock();

		if (this.heldKeys.size() === 1) {
			this.gestureStart = now;
			this.gestureKeys = new Set([key]);
			this.tapBeforeGesture = this.lastTap;

			this.evaluateGesture(now);
			return;
		}

		if (now - this.gestureStart <= GESTURE_WINDOW) {
			this.gestureKeys.add(key);

			// Back to how this gesture found it, so the gesture is judged against the tap *before*
			// it rather than against its own earlier evaluation. See `tapBeforeGesture`.
			this.lastTap = this.tapBeforeGesture;

			this.evaluateGesture(now);
		}
	}

	/**
	 * Counts the current gesture as one tap, and asks for a dodge if it completes a pair.
	 *
	 * Called on every press that opens or grows a gesture, so it runs more than once for a diagonal.
	 * That is what {@link tapBeforeGesture} is for: each call starts from the state the gesture
	 * began in, so one gesture is one tap however many times it was looked at.
	 *
	 * The pair is the **last two taps in a row**, so the input you hit twice has to be the only thing
	 * you hit. Strafing `A` `D` `A` puts a tap of another input between the two `A`s, so each of
	 * those is a first tap and none of them is a dodge. The same holds for `A` `D` `A` `D`.
	 */
	private evaluateGesture(now: number): void {
		// Taps are only counted while there is something to move, and a death clears
		// what was counted: half a pair held across a respawn should not become a
		// dodge the moment the player is back on their feet.
		if (this.findHumanoid() === undefined) {
			this.lastTap = undefined;
			return;
		}

		const combo = comboOf(this.gestureKeys);

		// Not a dodge input — `W+S`, `A+D`, three keys at once. Whatever was pending is dropped
		// rather than kept: a pair has to be two of the *same* input in a row, and an input that
		// cannot dodge at all is the strongest possible interruption of one.
		if (!isDodgeCombo(combo)) {
			this.lastTap = undefined;
			return;
		}

		const last = this.lastTap;

		// Whatever was pending is spent either way: this tap either completes the pair or replaces
		// the one it interrupted, so there is never a third tap waiting behind it.
		this.lastTap = undefined;

		if (last !== undefined && last.combo === combo && now - last.at <= DODGE_CONFIG.DOUBLE_TAP_WINDOW) {
			this.requestDodge(combo);
			return;
		}

		this.lastTap = { combo, at: now };
	}

	/**
	 * Sends one dodge request, for the direction `combo` means to the camera.
	 *
	 * Only the direction is decided here, and only because this is the one machine
	 * that can see a key: distance, duration and cooldown all belong to the server.
	 */
	private requestDodge(combo: string): void {
		if (this.findHumanoid() === undefined) {
			if (DEBUG) print(`[Dodge] ${combo} double-tapped with nothing to move`);
			return;
		}

		const camera = Workspace.CurrentCamera;
		if (!camera) {
			if (DEBUG) print(`[Dodge] no camera to take a heading from`);
			return;
		}

		// Heading and right are both flattened: the camera's own pitch is dropped so
		// an aim at the floor still dodges along it, and the right vector is taken
		// from the camera rather than crossed from the heading, so it stays correct
		// with the camera pointed straight down.
		const forward = flattenToGround(camera.CFrame.LookVector);
		const right = flattenToGround(camera.CFrame.RightVector);
		if (!forward || !right) {
			if (DEBUG) print(`[Dodge] the camera has no heading to dodge along`);
			return;
		}

		const direction = dodgeDirection(combo, forward, right);
		if (!direction) return;

		if (DEBUG) {
			print(
				`[Dodge] ${combo} double-tapped → (${string.format("%.2f", direction.X)}, ` +
					`${string.format("%.2f", direction.Y)}, ${string.format("%.2f", direction.Z)})`,
			);
		}

		this.getDodgeRemote().SendToServer(direction);
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

/** Whether `key` is one of the movement keys, and so may open or grow a gesture. */
function isMovementKey(key: Enum.KeyCode): boolean {
	return COMBO_AXES[key.Name] !== undefined;
}

/** Whether `combo` is an input that dodges at all — one movement key, or one perpendicular pair. */
function isDodgeCombo(combo: string): boolean {
	return COMBO_AXES[combo] !== undefined;
}

/** Where `combo` points, given the camera's heading and its right. */
function dodgeDirection(combo: string, forward: Vector3, right: Vector3): Vector3 | undefined {
	const axis = COMBO_AXES[combo];
	if (!axis) return undefined;

	return forward.mul(axis.Z).add(right.mul(axis.X)).Unit;
}
