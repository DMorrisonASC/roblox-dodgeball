import { Controller, OnStart } from "@flamework/core";
import Net from "@rbxts/net";
import { Players, UserInputService } from "@rbxts/services";
import { AbilityKind, ABILITY_NAMES } from "shared/ability";
import { IS_DEV_ATTRIBUTE } from "shared/constants";
import { POWER_ROSTER } from "shared/config/economy.config";
import { events } from "shared/networking";

/** Prints the binds once, every press that went out, and nothing else. */
const DEBUG = true;

/**
 * The key that uses whatever power a mystery box gave you. **`3`, and nothing else in the game binds it.**
 *
 * **One key for every power, because the player does not choose the power — the box does.** What a press
 * means is therefore not a fact this file knows: it is the *window's* kind, which the server reads for
 * itself when the request arrives. So the press sends no argument at all, on the argument
 * `useMysteryPower` gives in `shared/networking.ts` — a client naming the power would be sending a replica
 * of a fact the server holds authoritatively, and a stale one could buy a power the player was never given.
 *
 * **This replaced a key per ability, and the mismatch it removes is worth recording.** `3` used to mark as
 * Pierce, `4` bought a MultiBall window and `5` marked as Freeze: three keys a player had to remember, for
 * a mechanic where the game decides which one applies. A box that rolled Freeze left its owner pressing
 * keys that asked for something else, and the server had no way to say so — the charge test it reached was
 * the same one either way. The per-ability keys survive for a dev, below, which is what they were always
 * more useful for.
 */
const POWER_KEY = Enum.KeyCode.Three;

/**
 * The keys that use one *named* power each — **and they are a dev's**, bound for a machine that has been
 * marked as a developer's and not for anybody else.
 *
 * **`4`, `5` and `6`, in `POWER_ROSTER` order**, so that a power can be exercised without waiting for a box
 * to roll it. The mystery box is the only source of a power in play, and a 5% roll every ten seconds is not
 * a way to test one — the same reasoning every other dev shortcut in this game exists for, applied at the
 * *binding* rather than at the ability. These keys send the requests that already existed, and the
 * server-side bypasses they lean on were already there.
 *
 * **A `Record<AbilityKind, Enum.KeyCode>` rather than a list of pairs**, which is `ABILITY_NAMES`' shape
 * and its reason: adding an ability to the union without choosing a key for it is a compile error rather
 * than a key that silently does nothing. The lookup runs the other way at press time, through
 * {@link abilityOf}, because a key is what arrives.
 *
 * **Not bound for a non-dev, and the client is the only machine that can decide that** — it is the one
 * holding the keyboard. It reads `IS_DEV_ATTRIBUTE` off the player, so an ordinary player has exactly one
 * power key and no dead ones. The server never takes a client's word for it: it asks `DevService.isDev` for
 * itself before honouring a press, which is why a forged flag buys a player a refused request and nothing.
 */
const TEST_KEYS: Record<AbilityKind, Enum.KeyCode> = {
	Pierce: Enum.KeyCode.Four,
	MultiBall: Enum.KeyCode.Five,
	Freeze: Enum.KeyCode.Six,
};

/** The client half of the remote declarations, as they are built. */
type ClientRemotes = Net.Util.GetClientRemotes<Net.Util.GetDeclarationDefinitions<typeof events>>;

/**
 * The power key, and a developer's three.
 *
 * **One key that decides nothing**, which is the whole of the design: `3` asks the server to use whatever a
 * mystery box gave this player, and the answer — whether it worked, what it marked, whether a window is
 * open — comes back as attributes the HUD already reads. Which press is legal is entirely the server's
 * question: whether there is a window at all, whether there is a ball in the hand, whether the power it
 * rolled can ride one, whether a round is being played, whether they are a dev. It is the only machine that
 * knows any of them, and a client that refused to send a request because *its* copy of the rules was wrong
 * would be a second copy of the rule — the one thing this codebase consistently refuses to write. So the
 * press goes out and the answer arrives as a fact: the mark on the ball, the window on the player.
 *
 * **Which is also why nothing is sent back.** The acknowledgement is the attribute appearing — a
 * replicated fact in this player's own hands — so a remote saying "done" would be a second channel
 * carrying something the client already has. A refusal needs no message either: an unmarked ball, or
 * unchanged window attributes a moment later, *is* the answer, and the server prints the reason where a
 * reader can find it.
 *
 * **The dev keys are a shortcut for testing rather than a second way to play, and they are bound
 * accordingly.** They name one ability each, so a power can be tried without waiting for a box to roll it,
 * and they are bound only on a machine marked as a developer's — which is why an ordinary player has one
 * power key rather than four with three that do nothing. See {@link TEST_KEYS} for that decision, and for
 * what the server does about a machine that lies about being one.
 *
 * A tap rather than a hold, so each key is built from the pair of signals a tap needs — the same shape
 * `SprintController` uses for its held key, and for the same reason.
 */
@Controller()
export class SuperAbility implements OnStart {
	/** Resolved on first use: `Client.Get` waits for the server's remote. */
	private markRemote?: ClientRemotes["markHeldBall"];

	/** The dev MultiBall key's remote, resolved the same way and for the same reason. */
	private multiBallRemote?: ClientRemotes["multiBall"];

	/** The power key's, which carries nothing — see `useMysteryPower` for why it has nothing to say. */
	private powerRemote?: ClientRemotes["useMysteryPower"];

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
	 * **A set rather than a boolean, because there is more than one key.** One flag for all of them would
	 * swallow a press of the power key for as long as a dev happened to be sitting on `4`, which is a state
	 * a player reaches by resting a finger on a key.
	 */
	private readonly holding = new Set<Enum.KeyCode>();

	public onStart(): void {
		// **Resolved before any input can arrive, and out of band.** `Client.Get` waits for the
		// server's remote, and a controller's `onStart` is the wrong place to hold up the rest of the
		// client's boot — so this is the usual `task.spawn`, the same one every other sending
		// controller opens with.
		task.spawn(() => {
			this.getMarkRemote();
			this.getMultiBallRemote();
			this.getPowerRemote();
		});

		UserInputService.InputBegan.Connect((input, gameProcessed) => {
			const key = input.KeyCode;

			// **The dev keys are resolved per press rather than cached**, which is one attribute read on a
			// key press and is what lets a flag granted mid-session start working with nothing watching for
			// it. A non-dev gets `undefined` here for every key, so the guard below leaves them exactly one
			// live key — which is the requirement, rather than four keys with three that do nothing.
			const test = this.isDev() ? this.abilityOf(key) : undefined;

			if (key !== POWER_KEY && test === undefined) return;

			// Typing in chat, or a menu is open: the key belonged to whatever has focus, not to the game.
			if (gameProcessed) return;

			// A repeat announcement of a key already down, which is not a second press. See the set.
			if (this.holding.has(key)) return;
			this.holding.add(key);

			// **The power key, and the whole of what it sends: nothing.** The server reads the window it is
			// holding to find out which power to use, so a client cannot name one — not to be polite, but
			// because which power a box rolled is not this machine's to report. See `useMysteryPower` in
			// `shared/networking.ts`, and the handler of the same name in `BallService`.
			if (key === POWER_KEY) {
				if (DEBUG) print(`[Super] ${POWER_KEY.Name} — asking to use the mystery box's power`);

				this.getPowerRemote().SendToServer();

				return;
			}

			// Unreachable without a kind, because the guard above is the only way past it.
			if (test === undefined) return;

			// **The one dev key that is not a mark**, asked by name because the question here is which of
			// the two requests this press goes to — and the server's router asks the same question about
			// the same word when a box is paying.
			if (test === "MultiBall") {
				if (DEBUG) print(`[Super] ${key.Name} — asking to buy a ${ABILITY_NAMES.MultiBall} window`);

				this.getMultiBallRemote().SendToServer();

				return;
			}

			// **One remote for every marking key, and the word is the whole of the difference between
			// them.** `"Pierce"` and `"Freeze"` are both abilities a *ball* can carry, and the server
			// checks that the word names one rather than trusting it — see `isBallAbility`, which is also
			// what refuses the word for a player-level buff arriving at this same remote.
			if (DEBUG) print(`[Super] ${key.Name} — asking to mark the held ball as ${ABILITY_NAMES[test]}`);

			this.getMarkRemote().SendToServer(test);
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
		// whole set rather than the one key, because focus can be lost with every key still down.
		UserInputService.WindowFocusReleased.Connect(() => {
			this.holding.clear();
		});

		// Printed once at startup, for the reason every other input controller prints its binds: "the
		// key does nothing" has two completely different causes — the bind never happened, or the press
		// never arrived — and this is the line that tells them apart.
		if (DEBUG) {
			print(`[Super] ${POWER_KEY.Name} bound — uses whatever power the mystery box gave`);

			// **The dev binds are printed only for a dev, because for anybody else they are not bound** —
			// and a startup line naming keys that do nothing is worse than no line at all. Read here rather
			// than remembered: the *binding* is decided per press, so this can only be a snapshot of the
			// flag as the client booted, and it reports which keys exist rather than which will work.
			if (this.isDev()) {
				for (const kind of POWER_ROSTER) {
					const what =
						kind === "MultiBall"
							? `buys a ${ABILITY_NAMES[kind]} window`
							: `marks the held ball as ${ABILITY_NAMES[kind]}`;

					print(`[Super] ${TEST_KEYS[kind].Name} bound (dev) — ${what}`);
				}
			}
		}
	}

	private getMarkRemote(): ClientRemotes["markHeldBall"] {
		if (!this.markRemote) {
			this.markRemote = events.Client.Get("markHeldBall");
		}

		return this.markRemote;
	}

	/** The dev MultiBall key's, held for the same reason: `Client.Get` waits for the server's remote. */
	private getMultiBallRemote(): ClientRemotes["multiBall"] {
		if (!this.multiBallRemote) {
			this.multiBallRemote = events.Client.Get("multiBall");
		}

		return this.multiBallRemote;
	}

	/** The power key's, resolved the same way. The one remote in this file sent with no argument at all. */
	private getPowerRemote(): ClientRemotes["useMysteryPower"] {
		if (!this.powerRemote) {
			this.powerRemote = events.Client.Get("useMysteryPower");
		}

		return this.powerRemote;
	}

	/**
	 * Whether this machine has been marked as a developer's.
	 *
	 * **Read per press rather than cached**, which costs one attribute read on a key press and buys two
	 * things: a flag granted mid-session starts working with nothing watching for it, and there is no copy
	 * of the answer to go stale. The server asks `DevService` the same question about the same attribute
	 * before it honours anything, so this decides *which keys exist* and never what a press does.
	 */
	private isDev(): boolean {
		return Players.LocalPlayer.GetAttribute(IS_DEV_ATTRIBUTE) === true;
	}

	/**
	 * Which named power `key` asks for, or `undefined` when it asks for none.
	 *
	 * **A search over {@link POWER_ROSTER} rather than a second table keyed by key.** The table is keyed by
	 * ability, which is the shape that makes the *union* complete — a new ability without a key is a
	 * compile error — so the reverse question is asked of the roster rather than answered by a second
	 * mapping that could disagree with the first. Three comparisons, on a key press.
	 */
	private abilityOf(key: Enum.KeyCode): AbilityKind | undefined {
		for (const kind of POWER_ROSTER) if (TEST_KEYS[kind] === key) return kind;

		return undefined;
	}
}
