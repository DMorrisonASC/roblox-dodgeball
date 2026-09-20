import { Controller, OnStart } from "@flamework/core";
import Net from "@rbxts/net";
import { ContextActionService, Players } from "@rbxts/services";
import { events } from "shared/networking";

const ACTION_NAME = "Catch";

/** Prints each press and whether it went out. */
const DEBUG = true;

/** The client half of the catch remote, as the declarations build it. */
type ClientRemotes = Net.Util.GetClientRemotes<Net.Util.GetDeclarationDefinitions<typeof events>>;

/**
 * Says "I pressed E", and decides nothing else.
 *
 * No payload and no prediction: the server knows who pressed the key from the
 * `Player` the engine hands it, so anything sent here would only be an invitation
 * to trust it. Whether a catch happens — whether a window is even open, and
 * whether the ball arriving is one this character is allowed to catch — is
 * entirely the server's business. The ball appearing in the hand is replication.
 */
@Controller()
export class CatchController implements OnStart {
	private readonly player = Players.LocalPlayer;

	/** Resolved on first use: `Client.Get` waits for the server's remote. */
	private catchRemote?: ClientRemotes["catch"];

	public onStart(): void {
		ContextActionService.BindAction(
			ACTION_NAME,
			(_actionName, inputState) => {
				if (inputState !== Enum.UserInputState.Begin) return Enum.ContextActionResult.Pass;

				this.requestCatch();
				return Enum.ContextActionResult.Sink;
			},
			false,
			Enum.KeyCode.E,
		);
	}

	/** Asks the server to open a catch window. */
	private requestCatch(): void {
		const character = this.player.Character;
		const humanoid = character?.FindFirstChildWhichIsA("Humanoid");
		if (!character || !humanoid || humanoid.Health <= 0) {
			if (DEBUG) print(`[Catch] nothing to catch with`);
			return;
		}

		if (DEBUG) print(`[Catch] asking to catch`);

		this.getCatchRemote().SendToServer();
	}

	private getCatchRemote(): ClientRemotes["catch"] {
		if (!this.catchRemote) {
			this.catchRemote = events.Client.Get("catch");
		}

		return this.catchRemote;
	}
}
