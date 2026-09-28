import { Controller, OnStart } from "@flamework/core";
import Net from "@rbxts/net";
import { Players, UserInputService } from "@rbxts/services";
import { events } from "shared/networking";

/** Prints the bind once, and each change of what is being asked for. */
const DEBUG = true;

/** The client half of the sprint remote, as the declarations build it. */
type ClientRemotes = Net.Util.GetClientRemotes<Net.Util.GetDeclarationDefinitions<typeof events>>;

/**
 * Holds a key down and says so; decides nothing.
 *
 * **`LeftAlt` is a held key, so this controller is built from the pair of signals a *hold* needs.**
 * `InputBegan` and `InputEnded` rather than one bound action with an `inputState`, which is the
 * shape `DodgeController` already uses for its movement keys and for the same reason: an action
 * bound once fires on the way down and again on the way up, and half of those arrivals are the
 * engine re-announcing a key that never came up.
 *
 * **Nothing is decided here, including whether the sprint is allowed.** The pool is the server's,
 * and a client that refused to send a press because its own copy of the pool was at zero would be a
 * second copy of a rule — the one thing this codebase consistently refuses to write. So the client
 * reports the key and the server answers by changing how fast the character walks, which the player
 * sees as the character walking faster.
 *
 * **Nothing is sent when the answer has not changed.** `InputBegan` fires again for a key that never
 * came up — while a held key repeats, and when a chat box closes and the key state is handed back to
 * the game — so a press is only news the first time. The flag is what makes that true, and it is the
 * same guard `DodgeController` keeps over its held keys, arrived at for the same reason.
 */
@Controller()
export class SprintController implements OnStart {
	private readonly player = Players.LocalPlayer;

	/** Resolved on first use: `Client.Get` waits for the server's remote. */
	private sprintRemote?: ClientRemotes["setSprinting"];

	/** Whether the key is being reported as down. The client's own copy of what it last said. */
	private holding = false;

	public onStart(): void {
		// **Resolved before any input can arrive, and out of band.** `Client.Get` waits for the
		// server's remote, and a controller's `onStart` is the wrong place to hold up the rest of the
		// client's boot — so this is the usual `task.spawn`. It matters more here than elsewhere: a
		// press and a release that each waited for the remote would be two handlers yielding in turn,
		// and a quick tap could be reported out of order.
		task.spawn(() => {
			this.getRemote();
		});

		UserInputService.InputBegan.Connect((input, gameProcessed) => {
			if (input.KeyCode !== Enum.KeyCode.LeftAlt) return;

			// Typing in chat, or a menu is open: Alt belonged to whatever has focus, not to the game.
			if (gameProcessed) return;

			this.setHolding(true);
		});

		// The key-up is taken however the engine labels it, exactly as `DodgeController` takes its
		// releases: a release is unambiguous, and one delivered while a menu has focus is still a
		// release.
		UserInputService.InputEnded.Connect((input) => {
			if (input.KeyCode !== Enum.KeyCode.LeftAlt) return;

			this.setHolding(false);
		});

		// **Losing focus releases the key, because nothing else will.** The window that took focus
		// receives the key-up, so without this the sprint would continue for the rest of the session:
		// the client would never send `false`, and the server — which is told the key state rather
		// than asking for it — would go on believing it. `DodgeController` clears its held keys on
		// this same signal for the same reason, and that is the shape being followed here.
		UserInputService.WindowFocusReleased.Connect(() => this.setHolding(false));

		// Printed once at startup, for the reason the catch prints its bind: "the key does nothing"
		// has two completely different causes — the bind never happened, or the press never arrived —
		// and this is the line that tells them apart.
		if (DEBUG) print(`[Sprint] LeftAlt bound`);
	}

	/**
	 * Reports the key if that is news.
	 *
	 * The guard is not tidiness: it is what stops a held key's repeat announcements from becoming a
	 * stream of remote calls, and it is also what makes the trailing `false` on a focus loss harmless
	 * when the key was never down.
	 */
	private setHolding(active: boolean): void {
		if (this.holding === active) return;

		this.holding = active;

		if (DEBUG) print(`[Sprint] ${active ? "held" : "released"}`);

		this.getRemote().SendToServer(active);
	}

	private getRemote(): ClientRemotes["setSprinting"] {
		if (!this.sprintRemote) {
			this.sprintRemote = events.Client.Get("setSprinting");
		}

		return this.sprintRemote;
	}
}
