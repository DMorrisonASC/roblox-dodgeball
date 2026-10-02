import { Controller, OnStart } from "@flamework/core";
import Net from "@rbxts/net";
import { Players, UserInputService } from "@rbxts/services";
import { events } from "shared/networking";
import { sprinting } from "../../sprinting";

/** Prints the bind once, and each change of what is being asked for. */
const DEBUG = true;

/**
 * The keys that sprint — either of them.
 *
 * **Two, and the pair is the whole of this arrangement.** The right hand that drives with
 * `U`/`H`/`J`/`K` should not have to cross the keyboard for the sprint, and the left hand that is
 * already on WASD is the one that owns `LeftShift` — the left little finger, and the one key on that
 * side of the board that nothing else in this game uses. Neither key is *the* sprint key: they are
 * two spellings of one input, and every decision below is about the pair rather than about either of
 * them.
 *
 * **`LeftShift`, and the key before it was `LeftAlt`.** The old binding worked, and it also took the
 * player's movement with it: holding a direction, holding `LeftAlt`, and letting go of `LeftAlt`
 * stopped the body dead with the direction key still down, and it would not move again until a fresh
 * press. **The cause is outside the game — Alt is the one key Windows itself acts on.** Tapping it
 * hands the window's focus to the system menu and back, which fires `WindowFocusReleased`; three
 * controllers here clear the keys they believe are held on that event — this one among them, and
 * correctly — and the engine's own default controls do the same with *their* held keys, so the
 * movement was dropped and only a new press could restore it. Recorded because it read as a gameplay
 * bug and was chased as one: the server reporting `[Walk] 20 (Base:20)` on the release, and the body's
 * own measured speed at `0.0` inside the next 80 milliseconds. **A key the operating system has an
 * opinion about is not a key to bind a hold to**, which is the lesson `RightAlt` taught from the other
 * end of the keyboard.
 *
 * **Shift is only free because the engine's own use of it is switched off.** Roblox's default shift
 * lock is a `LeftShift` toggle, and it is disabled in the place file — see `ShiftLock`, which says so,
 * and which is the reason this game has a shift lock of its own at all. If that setting is ever turned
 * back on, this binding starts toggling the engine's mouse lock as well and the two shift locks will
 * fight over the camera.
 *
 * **`M`, and it was `RightAlt` first.** `RightAlt` is the obvious right-hand answer — it is the key
 * beside the arrow cluster — and it was bound and tried. **It did not sprint.** The cause was not
 * chased, deliberately: a key that does nothing is a key to replace, and `M` sits on the same side of
 * the board and was unbound. What that binding turned out to have in common with `LeftAlt` is the
 * paragraph above: on a layout with `AltGr`, the right-hand Alt is the operating system's
 * character-composition key, and whether it is delivered as `RightAlt` at all is the OS's decision
 * rather than the engine's. Neither Alt key survives in this list, for that reason.
 *
 * Annotated rather than inferred, for the reason the movement controller's key list is: a bare array
 * of two key codes is narrowed to those two literals, and `includes` then refuses the general
 * `KeyCode` that an input event carries.
 */
const SPRINT_KEYS: Array<Enum.KeyCode> = [Enum.KeyCode.LeftShift, Enum.KeyCode.M];

/** The client half of the sprint remote, as the declarations build it. */
type ClientRemotes = Net.Util.GetClientRemotes<Net.Util.GetDeclarationDefinitions<typeof events>>;

/**
 * Holds a key down and says so; decides nothing.
 *
 * **These are held keys, so this controller is built from the pair of signals a *hold* needs.**
 * `InputBegan` and `InputEnded` rather than one bound action with an `inputState`, which is the
 * shape `DodgeController` already uses for its movement keys and for the same reason: an action
 * bound once fires on the way down and again on the way up, and half of those arrivals are the
 * engine re-announcing a key that never came up.
 *
 * **Two keys and one flag, which is why the keys held are counted rather than remembered one at a
 * time.** The pair can overlap: hold `LeftShift`, press `M`, release `LeftShift` — the *sprint* has not
 * changed, and a controller holding a single "is it down" flag would report a release on that last
 * event and stop a sprint the player is still asking for with the other hand. So what goes to the
 * server is whether *any* of the two is down, and a set is what makes that answerable. It is the same
 * rule `DodgeController` keeps over its movement keys, arrived at the same way.
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

	/** Whether a sprint key is being reported as down. The client's own copy of what it last said. */
	private holding = false;

	/**
	 * The sprint keys currently down.
	 *
	 * **A set and not a second boolean**, because either key can hold the sprint and the two can
	 * overlap — see the class doc. It answers the only question the server is told about: is any of
	 * them down.
	 */
	private readonly heldKeys = new Set<Enum.KeyCode>();

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
			if (!SPRINT_KEYS.includes(input.KeyCode)) return;

			// Typing in chat, or a menu is open: Alt belonged to whatever has focus, not to the game.
			if (gameProcessed) return;

			this.heldKeys.add(input.KeyCode);
			this.setHolding(this.heldKeys.size() > 0);
		});

		// The key-up is taken however the engine labels it, exactly as `DodgeController` takes its
		// releases: a release is unambiguous, and one delivered while a menu has focus is still a
		// release. The key is dropped from the set first, so what is reported is what is *still*
		// down — which is the whole reason the set exists.
		UserInputService.InputEnded.Connect((input) => {
			if (!SPRINT_KEYS.includes(input.KeyCode)) return;

			this.heldKeys.delete(input.KeyCode);
			this.setHolding(this.heldKeys.size() > 0);
		});

		// **Losing focus releases every key, because nothing else will.** The window that took focus
		// receives the key-up, so without this the sprint would continue for the rest of the session:
		// the client would never send `false`, and the server — which is told the key state rather
		// than asking for it — would go on believing it. `DodgeController` clears its held keys on
		// this same signal for the same reason, and that is the shape being followed here.
		UserInputService.WindowFocusReleased.Connect(() => {
			this.heldKeys.clear();
			this.setHolding(false);
		});

		// Printed once at startup, for the reason the catch prints its bind: "the key does nothing"
		// has two completely different causes — the bind never happened, or the press never arrived —
		// and this is the line that tells them apart. Both keys are named, read from the list itself
		// so that the line cannot fall out of step with what is actually bound.
		if (DEBUG) print(`[Sprint] ${SPRINT_KEYS.map((key) => key.Name).join(" and ")} bound`);
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

		// **And the client's own half of the same fact, which goes out to nothing.** The remote tells the
		// *server* what to do with the key; this tells the rest of the client what the key is, because one
		// reader needs to know: the moving clip cannot tell a sprint from a walk by looking at the body —
		// both are simply "moving" — so it asks the key. See `client/sprinting.ts`.
		//
		// Written inside the guard, so the published state changes exactly when the server is told that it
		// has, and a held key's repeat announcements cannot become a stream of writes either.
		sprinting.set(active);

		// The keys down come along, because with two of them a bare "held" cannot say which one, and
		// the case where that matters is exactly the one the second key introduced: a `held` line that
		// still names a key after one of the two has come up is the overlap working.
		if (DEBUG) print(`[Sprint] ${active ? "held" : "released"} — ${this.heldKeysLabel()}`);

		this.getRemote().SendToServer(active);
	}

	/**
	 * The sprint keys currently down, as one string.
	 *
	 * Sorted, so that the same two keys make the same line whichever order they were pressed in —
	 * the rule `DodgeController`'s `comboOf` follows, and for the same reason: a diagnostic whose text
	 * depends on the order of two events is one nobody can compare between runs.
	 */
	private heldKeysLabel(): string {
		const names: string[] = [];
		for (const key of this.heldKeys) names.push(key.Name);
		names.sort();

		return names.size() === 0 ? "nothing" : names.join(" + ");
	}

	private getRemote(): ClientRemotes["setSprinting"] {
		if (!this.sprintRemote) {
			this.sprintRemote = events.Client.Get("setSprinting");
		}

		return this.sprintRemote;
	}
}
