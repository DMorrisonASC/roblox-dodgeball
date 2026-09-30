import { Controller, OnStart } from "@flamework/core";
import Net from "@rbxts/net";
import { UserInputService } from "@rbxts/services";
import { AbilityKind } from "shared/ability";
import { events } from "shared/networking";

/** Prints the bind once, and every press that went out. */
const DEBUG = true;

/** The key that marks the held ball. **`3`, and nothing else in the game binds it.** */
const MARK_KEY = Enum.KeyCode.Three;

/**
 * The ability this key marks, which is the only one that exists.
 *
 * **A constant rather than something the player selects**, and that is the honest shape of a feature
 * with one ability in it: there is nothing to choose between, so there is no selection and no key to
 * choose with. It still travels on the wire, because the server is being asked to mark a ball *as*
 * something and inferring the something from the key would put the mapping between keys and abilities
 * on two machines. When a second ability exists this becomes the value a selection sets, and nothing
 * else in this file changes.
 */
const ABILITY: AbilityKind = "Pierce";

/** The client half of the mark remote, as the declarations build it. */
type ClientRemotes = Net.Util.GetClientRemotes<Net.Util.GetDeclarationDefinitions<typeof events>>;

/**
 * Presses `3` and asks the server to mark the ball in hand.
 *
 * **One key, and it decides nothing.** Whether there is a ball in the hand, whether the player is
 * holding a charge, whether they are a dev, and whether the ball is already marked are all the
 * server's questions — it is the only machine that knows any of them. A client that refused to send
 * the request because *its* copy of the charge was wrong would be a second copy of the rule, which is
 * the one thing this codebase consistently refuses to write. So the press goes out and the answer
 * arrives as the ball's own attribute, which the HUD reads.
 *
 * **Which is also why nothing is sent back.** The acknowledgement is the marked ball: it is a
 * replicated instance in this player's hand, so its attribute appearing is the reply, and a remote
 * saying "marked" would be a second channel carrying a fact the client already has. The refusal case
 * needs no message either — an unmarked ball a moment later *is* the answer, and the server prints the
 * reason where a reader can find it.
 *
 * A tap rather than a hold, so this is built from the pair of signals a tap needs — the same shape
 * `SprintController` uses for its held key, and for the same reason.
 */
@Controller()
export class SuperAbility implements OnStart {
	/** Resolved on first use: `Client.Get` waits for the server's remote. */
	private markRemote?: ClientRemotes["markHeldBall"];

	/**
	 * Whether `3` is being reported as down.
	 *
	 * **`InputBegan` does not mean "the player pressed this key once".** The engine re-sends it for a
	 * key that never came up — while a held key repeats, and when the window regains focus and the key
	 * state is handed back to the game — and every one of those would be a second mark request for one
	 * press. The server refuses to mark a ball twice, so the cost is a refused request rather than a
	 * second ability, but a mark is something a player does deliberately and it should go out once.
	 * The same guard `SprintController` and `DodgeController` keep over their own keys.
	 */
	private holding = false;

	public onStart(): void {
		// **Resolved before any input can arrive, and out of band.** `Client.Get` waits for the
		// server's remote, and a controller's `onStart` is the wrong place to hold up the rest of the
		// client's boot — so this is the usual `task.spawn`, the same one every other sending
		// controller opens with.
		task.spawn(() => {
			this.getRemote();
		});

		UserInputService.InputBegan.Connect((input, gameProcessed) => {
			if (input.KeyCode !== MARK_KEY) return;

			// Typing in chat, or a menu is open: `3` belonged to whatever has focus, not to the game.
			if (gameProcessed) return;

			// A repeat announcement of a key already down, which is not a second press. See the flag.
			if (this.holding) return;
			this.holding = true;

			if (DEBUG) print(`[Super] ${MARK_KEY.Name} — asking to mark the held ball as ${ABILITY}`);

			this.getRemote().SendToServer(ABILITY);
		});

		// The key-up is taken however the engine labels it, exactly as `SprintController` takes its
		// releases: a release is unambiguous, and one delivered while a menu has focus is still a
		// release — leaving the flag set would swallow the next press for the rest of the session.
		UserInputService.InputEnded.Connect((input) => {
			if (input.KeyCode !== MARK_KEY) return;

			this.holding = false;
		});

		// **Losing focus releases the key, because nothing else will.** The window that took focus
		// receives the key-up, so without this the flag would stay set and the next press would be
		// swallowed — the same hazard `SprintController.clear`s its held keys for.
		UserInputService.WindowFocusReleased.Connect(() => {
			this.holding = false;
		});

		// Printed once at startup, for the reason every other input controller prints its bind: "the
		// key does nothing" has two completely different causes — the bind never happened, or the press
		// never arrived — and this is the line that tells them apart.
		if (DEBUG) print(`[Super] ${MARK_KEY.Name} bound — marks the held ball as ${ABILITY}`);
	}

	private getRemote(): ClientRemotes["markHeldBall"] {
		if (!this.markRemote) {
			this.markRemote = events.Client.Get("markHeldBall");
		}

		return this.markRemote;
	}
}
