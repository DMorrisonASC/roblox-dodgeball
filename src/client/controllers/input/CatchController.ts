import { Controller, OnStart } from "@flamework/core";
import Fusion from "@rbxts/fusion-3.0";
import Net from "@rbxts/net";
import { ContextActionService, Players } from "@rbxts/services";
import { BALL_NAME } from "shared/constants";
import { events } from "shared/networking";
import { logDebug } from "shared/logger";
import { chargeStartedAt } from "../../throwing";

const ACTION_NAME = "Catch";

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
 * press and a click are now two inputs for two actions.
 *
 * **What the two controllers do share is one fact, and it is a fact rather than a call.** `E` has a second
 * meaning — a press while a throw is being held *cancels* that throw instead of asking to catch, see the
 * handler below — so this file has to know whether one is being held. That answer lives in
 * `client/throwing.ts`, in neither controller, so nothing here reaches into the throw and nothing there has
 * to know this file exists. See that module for why the state moved rather than a callback being published.
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

				// **The press itself is `press`, and it is public because the catch is also a button.** The cluster
				// on a touch device calls the same method this callback does — which is what makes the two inputs
				// one behaviour rather than two that have to be kept in step, and why everything about what `E`
				// *means* (including its second meaning, cancelling a hold) lives in there rather than here. `Sink`
				// when the press was used, `Pass` when it was not; see `requestCatch` for why a refusal is not a
				// claim on the key.
				return this.press() ? Enum.ContextActionResult.Sink : Enum.ContextActionResult.Pass;
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
		logDebug(`[Catch] E bound`);
	}

	/**
	 * **The press, and the whole of what `E` means** — the key's callback calls this, and so does the catch
	 * button on a touch device. Answers whether the press was used, which is the question the callback turns
	 * into `Sink` or `Pass`.
	 *
	 * **The two meanings of one press, and the rule between them is what the hand is doing.** A throw in
	 * progress is a decision the player is still making, and a press is how they take it back; the catch that
	 * the press might otherwise have been does not go out, so catching takes a press of its own.
	 *
	 * **The cancel is a write to the charge's state, not a request to cancel it**, which is the part worth
	 * reading twice. A player who presses the button *instead of* letting go — the obvious way to use this —
	 * can put the press and the release inside one frame, and anything the throw collected later would have let
	 * the ball go off in the gap. Clearing the state means the release handler, whenever it runs, finds nothing
	 * to throw. Nothing else is needed: a charge is a start time, a live preview and a sound, all three of which
	 * follow the one value — so `ThrowController`'s frame loop takes the arc, the markers and the charge sound
	 * down on its own next pass, which is what makes this file the only one that has to know the cancel exists
	 * at all.
	 *
	 * **And cancelling a throw does not free the hand**, so the press right after a cancel is usually refused
	 * here: the ball stayed where it was, and a catch needs an empty hand. That rule is about catching and not
	 * about this press — but it is worth knowing before reading the refusal line as a bug, which is what it
	 * looks like from the outside.
	 */
	public press(): boolean {
		if (Fusion.peek(chargeStartedAt) !== undefined) {
			chargeStartedAt.set(undefined);
			logDebug("[Catch] press cancelled the throw");
			return true;
		}

		return this.requestCatch();
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
			logDebug(`[Catch] nothing to catch with`);
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
			logDebug(`[Catch] refused — a ball is already in hand`);
			return false;
		}

		logDebug(`[Catch] asking to catch`);

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
