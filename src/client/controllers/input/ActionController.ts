import { Controller, OnStart } from "@flamework/core";
import Net from "@rbxts/net";
import { ContextActionService } from "@rbxts/services";
import { events } from "shared/networking";

const DROP_ACTION = "DropBall";
const TOGGLE_ACTION = "ToggleThrow";

/** Prints both binds once, and each press. */
const DEBUG = true;

/** The client halves of the two remotes, as the declarations build them. */
type ClientRemotes = Net.Util.GetClientRemotes<Net.Util.GetDeclarationDefinitions<typeof events>>;

/**
 * The two keys that are not aiming: `1` drops the ball in hand, `2` switches throwing off.
 *
 * Both are one-way and both are silent about the result. The client says a key was pressed
 * and nothing else — it does not check whether there is a ball to drop or whether throwing
 * is allowed, because a check here would be a second copy of a rule the server already
 * owns, and the two would drift. What the player sees instead is the ball leaving their
 * hand, which is replication.
 *
 * Bound with `ContextActionService` rather than read from `UserInputService`, for the same
 * reason the catch is: a bound action is what priority and the chat box are about, so a
 * press that reaches the game is a press this handler gets.
 */
@Controller()
export class ActionController implements OnStart {
	/** Resolved on first use: `Client.Get` waits for the server's remote. */
	private dropRemote?: ClientRemotes["drop"];
	private toggleRemote?: ClientRemotes["toggleThrow"];

	public onStart(): void {
		ContextActionService.BindAction(
			DROP_ACTION,
			(_actionName, inputState) => {
				if (inputState !== Enum.UserInputState.Begin) return Enum.ContextActionResult.Pass;

				this.requestDrop();
				return Enum.ContextActionResult.Sink;
			},
			false,
			Enum.KeyCode.One,
		);

		ContextActionService.BindAction(
			TOGGLE_ACTION,
			(_actionName, inputState) => {
				if (inputState !== Enum.UserInputState.Begin) return Enum.ContextActionResult.Pass;

				this.requestToggleThrow();
				return Enum.ContextActionResult.Sink;
			},
			false,
			Enum.KeyCode.Two,
		);

		// Both binds on one line, printed once, for the reason the catch prints its bind:
		// "the key does nothing" has two completely different causes — the bind never
		// happened, or the press never arrived — and this is the line that tells them
		// apart. If it is missing from the output, nothing below it can be trusted.
		if (DEBUG) print(`[Action] 1 bound (drop), 2 bound (throw on/off)`);
	}

	/** Asks the server to drop the ball in hand. */
	private requestDrop(): void {
		if (DEBUG) print(`[Action] asked to drop`);

		this.getDropRemote().SendToServer();
	}

	/** Asks the server to flip whether this player may throw. */
	private requestToggleThrow(): void {
		if (DEBUG) print(`[Action] asked to toggle throwing`);

		this.getToggleRemote().SendToServer();
	}

	private getDropRemote(): ClientRemotes["drop"] {
		if (!this.dropRemote) {
			this.dropRemote = events.Client.Get("drop");
		}

		return this.dropRemote;
	}

	private getToggleRemote(): ClientRemotes["toggleThrow"] {
		if (!this.toggleRemote) {
			this.toggleRemote = events.Client.Get("toggleThrow");
		}

		return this.toggleRemote;
	}
}
