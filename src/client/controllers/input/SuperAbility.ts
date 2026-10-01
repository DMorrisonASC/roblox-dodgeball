import { Controller, OnStart } from "@flamework/core";
import Net from "@rbxts/net";
import { UserInputService } from "@rbxts/services";
import { AbilityKind, ABILITY_NAMES } from "shared/ability";
import { events } from "shared/networking";

/** Prints the binds once, and every press that went out. */
const DEBUG = true;

/** The key that asks the server to mark the held ball. **`3`, and nothing else in the game binds it.** */
const MARK_KEY = Enum.KeyCode.Three;

/**
 * The key that asks the server to spend the charge on a MultiBall window. **`4`, and nothing else binds
 * it.**
 *
 * **A second key beside the mark rather than a mode the first one switches between**, because the two
 * presses ask for different *kinds* of thing: `3` marks a ball, which is a fact about the object in the
 * player's hand, and `4` buys a window, which is a fact about the player and needs no ball at all. A
 * player with a charge and no ball can use the second and not the first, and that is a difference a
 * shared key could not express.
 */
const MULTI_BALL_KEY = Enum.KeyCode.Four;

/**
 * The key that asks the server to mark the held ball as Freeze. **`5`, and nothing else binds it.**
 *
 * **A key of its own rather than a mode the marking keys switch between.** `3` and `5` send the same
 * remote with a different word in it, and the only thing this file has to know about an ability is its
 * name — what it *does* is the server's business, which is why a new ability costs one constant and one
 * branch here and nothing else on the client.
 */
const FREEZE_KEY = Enum.KeyCode.Five;

/**
 * The ability `3` marks.
 *
 * **A constant per key rather than something the player selects**, which is the honest shape of a
 * mechanic whose abilities are bound to letters: there is nothing to cycle through, so there is no
 * selection and no key to select with. The word still travels on the wire, because the server is being
 * asked to mark a ball *as* something — and it is written here rather than derived from the key, because
 * a mapping between keys and abilities on two machines is a mapping that can disagree with itself.
 *
 * This used to be called `ABILITY` and to be described as "the only one that exists". There are three
 * abilities now and two of them are marks, so a name that tells the two marking keys apart is worth the
 * four lines it costs.
 */
const PIERCE: AbilityKind = "Pierce";

/** What `5` marks, named for {@link PIERCE}'s reason: each key names what it is asking for. */
const FREEZE: AbilityKind = "Freeze";

/** The client half of the mark remote, as the declarations build it. */
type ClientRemotes = Net.Util.GetClientRemotes<Net.Util.GetDeclarationDefinitions<typeof events>>;

/**
 * Presses `3` to ask the server to mark the ball in hand, or `4` to ask it to spend the charge on a
 * MultiBall window.
 *
 * **Two keys that decide nothing**, together in one controller because they are one subject: a key that
 * spends a charge. Which press is legal is entirely the server's question — whether there is a ball in
 * the hand, whether the player holds a charge, whether they are a dev, whether a window is already
 * open — and it is the only machine that knows any of them. A client that refused to send a request
 * because *its* copy of the charge was wrong would be a second copy of the rule, which is the one thing
 * this codebase consistently refuses to write. So the press goes out and the answer arrives as an
 * attribute the HUD already reads: the mark on the ball, the window on the player.
 *
 * **Which is also why nothing is sent back.** The acknowledgement is the attribute appearing — a
 * replicated fact in this player's own hands — so a remote saying "done" would be a second channel
 * carrying something the client already has. A refusal needs no message either: an unmarked ball, or
 * unchanged window attributes a moment later, *is* the answer, and the server prints the reason where a
 * reader can find it.
 *
 * **The two presses are not two shapes of one thing.** One marks an object and the other buys a stretch
 * of time from a player who may be holding nothing at all, which is why the second one sends no
 * argument: there is nothing for a client to name. See `SuperAbility`'s server half in `BallService`,
 * where both handlers live and where that difference is spelled out.
 *
 * A tap rather than a hold, so each key is built from the pair of signals a tap needs — the same shape
 * `SprintController` uses for its held key, and for the same reason.
 */
@Controller()
export class SuperAbility implements OnStart {
	/** Resolved on first use: `Client.Get` waits for the server's remote. */
	private markRemote?: ClientRemotes["markHeldBall"];

	/** The second key's remote, resolved the same way and for the same reason. */
	private multiBallRemote?: ClientRemotes["multiBall"];

	/**
	 * Which ability keys are being reported as down.
	 *
	 * **`InputBegan` does not mean "the player pressed this key once".** The engine re-sends it for a
	 * key that never came up — while a held key repeats, and when the window regains focus and the key
	 * state is handed back to the game — and every one of those would be a second request for one press.
	 * The server refuses the second request either way, so the cost is a refused request rather than two
	 * abilities, but a key press is something a player does deliberately and it should go out once. The
	 * same guard `SprintController` and `DodgeController` keep over their own keys.
	 *
	 * **A set rather than the boolean this used to be, because there are two keys now.** One flag for
	 * both would swallow a press of `4` for as long as `3` happened to be held, which is a state a player
	 * reaches by resting a finger on a key.
	 */
	private readonly holding = new Set<Enum.KeyCode>();

	public onStart(): void {
		// **Resolved before any input can arrive, and out of band.** `Client.Get` waits for the
		// server's remote, and a controller's `onStart` is the wrong place to hold up the rest of the
		// client's boot — so this is the usual `task.spawn`, the same one every other sending
		// controller opens with.
		task.spawn(() => {
			this.getRemote();
			this.getMultiBallRemote();
		});

		UserInputService.InputBegan.Connect((input, gameProcessed) => {
			const key = input.KeyCode;
			if (key !== MARK_KEY && key !== FREEZE_KEY && key !== MULTI_BALL_KEY) return;

			// Typing in chat, or a menu is open: the key belonged to whatever has focus, not to the game.
			if (gameProcessed) return;

			// A repeat announcement of a key already down, which is not a second press. See the set.
			if (this.holding.has(key)) return;
			this.holding.add(key);

			// **The three presses, and the only place this file decides which is which.** Everything else
			// about them is the server's: this asks, and reads the answer off an attribute.
			if (key === MULTI_BALL_KEY) {
				if (DEBUG) print(`[Super] ${MULTI_BALL_KEY.Name} — asking to spend the charge on a window`);

				this.getMultiBallRemote().SendToServer();

				return;
			}

			// **One remote for both marking keys, and the word is the whole of the difference between
			// them.** `"Pierce"` and `"Freeze"` are both abilities a *ball* can carry, and the server
			// checks that the word names one rather than trusting it — see `isBallAbility`, which is also
			// what refuses the word for a player-level buff arriving at this same remote.
			const kind: AbilityKind = key === FREEZE_KEY ? FREEZE : PIERCE;

			if (DEBUG) print(`[Super] ${key.Name} — asking to mark the held ball as ${ABILITY_NAMES[kind]}`);

			this.getRemote().SendToServer(kind);
		});

		// The key-up is taken however the engine labels it, exactly as `SprintController` takes its
		// releases: a release is unambiguous, and one delivered while a menu has focus is still a
		// release — leaving a key marked down would swallow the next press for the rest of the session.
		UserInputService.InputEnded.Connect((input) => {
			this.holding.delete(input.KeyCode);
		});

		// **Losing focus releases every key, because nothing else will.** The window that took focus
		// receives the key-ups, so without this they would stay marked down and the next press of either
		// would be swallowed — the same hazard `SprintController.clear`s its held keys for. Clearing the
		// whole set rather than the one key, because focus can be lost with both keys down.
		UserInputService.WindowFocusReleased.Connect(() => {
			this.holding.clear();
		});

		// Printed once at startup, for the reason every other input controller prints its binds: "the
		// key does nothing" has two completely different causes — the bind never happened, or the press
		// never arrived — and this is the line that tells them apart.
		if (DEBUG) {
			print(`[Super] ${MARK_KEY.Name} bound — marks the held ball as ${ABILITY_NAMES[PIERCE]}`);
			print(`[Super] ${FREEZE_KEY.Name} bound — marks the held ball as ${ABILITY_NAMES[FREEZE]}`);
			print(`[Super] ${MULTI_BALL_KEY.Name} bound — buys a ${ABILITY_NAMES.MultiBall} window`);
		}
	}

	private getRemote(): ClientRemotes["markHeldBall"] {
		if (!this.markRemote) {
			this.markRemote = events.Client.Get("markHeldBall");
		}

		return this.markRemote;
	}

	/** The `4` key's remote, held for the same reason: `Client.Get` waits for the server's remote. */
	private getMultiBallRemote(): ClientRemotes["multiBall"] {
		if (!this.multiBallRemote) {
			this.multiBallRemote = events.Client.Get("multiBall");
		}

		return this.multiBallRemote;
	}
}
