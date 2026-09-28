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
 * **`E` is the only input now. The left click belongs to the throw, and only to the throw.**
 *
 * The click used to open this window as well, split from the throw by what was in the hand: this took
 * the presses with an empty hand and `ThrowController` took the ones with a ball. It worked, and the
 * two gates were written to be complementary precisely so that `ContextActionService`'s bind order
 * could not decide the outcome — but it cost a rule about *catching* a permanent home inside the code
 * that decides a *throw*, and it left two handlers obliged to agree about one button forever. A key
 * press and a click are now two inputs for two actions, and these two controllers no longer have to
 * know that each other exists.
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

				// **`Sink` when the ask went out, `Pass` when it did not.** A refusal is not a claim on the
				// key: nothing here acted on the press, and `E` is bound to nothing else in this game, so
				// handing it on costs nothing and stops this action swallowing input it did not use.
				return this.requestCatch() ? Enum.ContextActionResult.Sink : Enum.ContextActionResult.Pass;
			},
			false,
			// One input, one handler, one remote.
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

	/**
	 * Asks the server to open a catch window.
	 *
	 * Returns whether the ask went out, which is the same question as whether this press was a catch at
	 * all — the handler above sinks a press only when it was.
	 */
	private requestCatch(): boolean {
		const character = this.player.Character;
		const humanoid = character?.FindFirstChildWhichIsA("Humanoid");
		if (!character || !humanoid || humanoid.Health <= 0) {
			if (DEBUG) print(`[Catch] nothing to catch with`);
			return false;
		}

		// **A catch needs a free hand.** A hand holds one ball and a ball arriving into an occupied
		// hand destroys what was in it — see `attachToHand` — so a catch while armed is a trade the
		// press did not ask for. Refused here as a courtesy, so the common refusal prints without a
		// round trip; `CatchService` refuses it again on the server, and that is the refusal that
		// counts, because this one is a client and can be bypassed.
		//
		// Asked of the character rather than of any list, because a held ball *is* a child of the
		// character.
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
