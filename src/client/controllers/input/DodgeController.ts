import { Controller, OnStart } from "@flamework/core";
import Net from "@rbxts/net";
import { Players, UserInputService, Workspace } from "@rbxts/services";
import { DODGE_CONFIG } from "shared/config/dodge.config";
import { flattenToGround } from "shared/dodge";
import { events } from "shared/networking";

/** Prints which key completed a double-tap, and whether the request went out. */
const DEBUG = true;

/**
 * The movement keys, and the direction each one means.
 *
 * Read in *camera space*: `Z` is the camera's heading and `X` is across it to the
 * right, so `W` is one step of heading and `A` is one step of -right. Adding a
 * key — a diagonal on two keys, say — is one more row here and nothing else.
 */
const KEY_AXES: ReadonlyArray<[Enum.KeyCode, Vector3]> = [
	[Enum.KeyCode.W, new Vector3(0, 0, 1)],
	[Enum.KeyCode.S, new Vector3(0, 0, -1)],
	[Enum.KeyCode.D, new Vector3(1, 0, 0)],
	[Enum.KeyCode.A, new Vector3(-1, 0, 0)],
];

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
	 */
	private lastTap?: { key: Enum.KeyCode; at: number };

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
	 * Registers a press of `key`, and counts it as a tap only if the key was not already down.
	 *
	 * The gate that makes a dodge two *presses* rather than one press held: whatever the
	 * engine's reason for announcing the same held key twice, the second announcement is not
	 * something the player did, and only a release can clear the way for a new tap.
	 */
	private onDown(key: Enum.KeyCode): void {
		if (directionAxis(key) === undefined) return;

		if (this.heldKeys.has(key)) return;

		this.heldKeys.add(key);

		this.onTap(key);
	}

	/**
	 * Counts one tap of `key`, and asks for a dodge if it completes a pair.
	 *
	 * Called only for a press that followed a release, so what arrives here is a tap rather
	 * than a press however many times the engine announced the key.
	 *
	 * The pair is the **last two taps in a row**, so the key you hit twice has to be the only
	 * thing you hit. Strafing `A` `D` `A` puts a tap of the other key between the two `A`s, so
	 * each of those is a first tap and none of them is a dodge.
	 */
	private onTap(key: Enum.KeyCode): void {
		if (directionAxis(key) === undefined) return;

		// Taps are only counted while there is something to move, and a death clears
		// what was counted: half a pair held across a respawn should not become a
		// dodge the moment the player is back on their feet.
		if (this.findHumanoid() === undefined) {
			this.lastTap = undefined;
			return;
		}

		const now = os.clock();
		const last = this.lastTap;

		// Whatever was pending is spent either way: this tap either completes the pair or
		// replaces the one it interrupted, so there is never a third tap waiting behind it.
		this.lastTap = undefined;

		if (last !== undefined && last.key === key && now - last.at <= DODGE_CONFIG.DOUBLE_TAP_WINDOW) {
			this.requestDodge(key);
			return;
		}

		this.lastTap = { key, at: now };
	}

	/**
	 * Sends one dodge request, for the direction `key` means to the camera.
	 *
	 * Only the direction is decided here, and only because this is the one machine
	 * that can see a key: distance, duration and cooldown all belong to the server.
	 */
	private requestDodge(key: Enum.KeyCode): void {
		if (this.findHumanoid() === undefined) {
			if (DEBUG) print(`[Dodge] ${key.Name} double-tapped with nothing to move`);
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

		const direction = dodgeDirection(key, forward, right);
		if (!direction) return;

		if (DEBUG) {
			print(
				`[Dodge] ${key.Name} double-tapped → (${string.format("%.2f", direction.X)}, ` +
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

/** The camera-space axis `key` means, or `undefined` if it is not a dodge key. */
function directionAxis(key: Enum.KeyCode): Vector3 | undefined {
	for (const [dodgeKey, axis] of KEY_AXES) {
		if (dodgeKey === key) return axis;
	}

	return undefined;
}

/** Where a dodge on `key` points, given the camera's heading and its right. */
function dodgeDirection(key: Enum.KeyCode, forward: Vector3, right: Vector3): Vector3 | undefined {
	const axis = directionAxis(key);
	if (!axis) return undefined;

	return forward.mul(axis.Z).add(right.mul(axis.X)).Unit;
}
