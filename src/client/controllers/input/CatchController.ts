import { Controller, OnStart } from "@flamework/core";
import Net from "@rbxts/net";
import { ContextActionService, Players } from "@rbxts/services";
import { BALL_NAME } from "shared/constants";
import { events } from "shared/networking";

const ACTION_NAME = "Catch";

/** Prints each press and whether it went out. */
const DEBUG = true;

/** The client half of the catch remote, as the declarations build it. */
type ClientRemotes = Net.Util.GetClientRemotes<Net.Util.GetDeclarationDefinitions<typeof events>>;

/**
 * Says "I asked to catch", and decides nothing else.
 *
 * No payload and no prediction: the server knows who pressed from the `Player` the
 * engine hands it, so anything sent here would only be an invitation to trust it.
 * Whether a catch happens — whether a window is even open, and whether the ball
 * arriving is one this character is allowed to catch — is entirely the server's
 * business. The ball appearing in the hand is replication.
 *
 * The one thing it does decide is **which action a shared left click was**, because the click is
 * also the throw's and something has to say which of the two it meant. See {@link requestCatch}.
 *
 * **`E` and a left click are one action, not two.** Both are bound to the same handler below and
 * send the same remote, because they are the same request: the server sees one `catch` per press and
 * cannot tell which input fired it, which is the point — two paths into one rule are two things that
 * can drift, so there is one path.
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

				// **`Pass` when this press is not a catch, `Sink` when it is.** The left click is shared
				// with the throw, so a press this refuses has to be handed on rather than swallowed —
				// `Sink` here would make the throw do nothing on any press that reached this action
				// first, and which action that is depends on `ContextActionService`'s bind order rather
				// than on anything either controller asked for.
				return this.requestCatch() ? Enum.ContextActionResult.Sink : Enum.ContextActionResult.Pass;
			},
			false,
			// One handler and one remote for both inputs: a key and a click are the same request.
			Enum.KeyCode.E,
			Enum.UserInputType.MouseButton1,
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
		if (DEBUG) print(`[Catch] E and left click bound`);
	}

	/**
	 * Asks the server to open a catch window.
	 *
	 * Returns whether the ask went out, which is the same question as whether this press was a catch at
	 * all — the handler above hands a press this refuses back to the throw.
	 */
	private requestCatch(): boolean {
		const character = this.player.Character;
		const humanoid = character?.FindFirstChildWhichIsA("Humanoid");
		if (!character || !humanoid || humanoid.Health <= 0) {
			if (DEBUG) print(`[Catch] nothing to catch with`);
			return false;
		}

		// **A catch needs a free hand, and this holds for both inputs alike.** A hand holds one ball
		// and a ball arriving into an occupied hand destroys what was in it — see `attachToHand` — so
		// a catch while armed is a trade the press did not ask for. Applying it here, on the path both
		// inputs share, is what keeps `E` and the click identical: the alternative is one of them
		// catching while armed and the other not, which is the same rule stated two ways.
		//
		// Asked of the character rather than of any list, because a held ball *is* a child of the
		// character. That is the same question `ThrowController` asks to decide whether a click is a
		// throw, so the two halves of the shared click cannot disagree about which one it is: this
		// takes the presses with no ball, the throw takes the ones with.
		if (character.FindFirstChild(BALL_NAME)) {
			if (DEBUG) print(`[Catch] refused — a ball is already in hand`);
			return false;
		}

		if (DEBUG) print(`[Catch] asking to catch`);

		this.getCatchRemote().SendToServer();
		return true;
	}

	private getCatchRemote(): ClientRemotes["catch"] {
		if (!this.catchRemote) {
			this.catchRemote = events.Client.Get("catch");
		}

		return this.catchRemote;
	}
}
