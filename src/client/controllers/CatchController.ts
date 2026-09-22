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

		// Printed once at startup, on purpose. "The key does nothing" has two completely
		// different causes — the bind never happened, or the key never arrived — and this
		// is the line that tells them apart: if it is missing from the output, nothing
		// below it can be trusted and the fault is up here.
		//
		// Deliberately **not** paired with a `UserInputService` listener on the same key.
		// The idea was that `gameProcessed` would say whether something else took the
		// press, but `ContextActionService` marks the inputs it consumes as processed
		// too — so a press that works and a press the chat box ate both report `true`,
		// and the second listener cannot tell them apart. A press that reaches here
		// prints `asking to catch`; one that does not prints nothing, and that is the
		// whole answer.
		if (DEBUG) print(`[Catch] E bound`);
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
