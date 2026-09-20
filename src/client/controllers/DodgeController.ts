import { Controller, OnStart } from "@flamework/core";
import Net from "@rbxts/net";
import { Players, UserInputService, Workspace } from "@rbxts/services";
import { DODGE_DOUBLE_TAP_WINDOW } from "shared/constants";
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

	/** When each key was last tapped, in `os.clock` seconds. */
	private readonly lastTapAt = new Map<Enum.KeyCode, number>();

	/** Resolved on first use: `Client.Get` waits for the server's remote. */
	private dodgeRemote?: ClientRemotes["dodge"];

	public onStart(): void {
		UserInputService.InputBegan.Connect((input, gameProcessed) => {
			// Typing in chat, or a menu is open: not a movement key, whatever it was.
			if (gameProcessed) return;

			this.onTap(input.KeyCode);
		});
	}

	/**
	 * Counts one press of `key`, and asks for a dodge if it completes a pair.
	 *
	 * Taps of different keys are kept apart, so `W` then `A` is two first taps
	 * rather than a dodge — the direction has to be the key you hit twice.
	 */
	private onTap(key: Enum.KeyCode): void {
		if (directionAxis(key) === undefined) return;

		// Taps are only counted while there is something to move, and a death clears
		// what was counted: half a pair held across a respawn should not become a
		// dodge the moment the player is back on their feet.
		if (this.findHumanoid() === undefined) {
			this.lastTapAt.clear();
			return;
		}

		const now = os.clock();
		const last = this.lastTapAt.get(key);

		if (last !== undefined && now - last <= DODGE_DOUBLE_TAP_WINDOW) {
			// The pair is spent, so a third tap has to start a new one — tapping in a
			// rhythm cannot chain dodges.
			this.lastTapAt.delete(key);
			this.requestDodge(key);
			return;
		}

		this.lastTapAt.set(key, now);
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
