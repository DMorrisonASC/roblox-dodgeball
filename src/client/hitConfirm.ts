import Fusion from "@rbxts/fusion-3.0";
import { Players } from "@rbxts/services";
import { events } from "shared/networking";
import { mountToast } from "./ui/hudToast";

/** Prints once at boot, and one line per confirmation. */
const DEBUG = true;

/**
 * # The hit confirmation — "You hit <name>", over the power-up stack
 *
 * **A toast, not an effect.** The pixels that say a hit landed are `hitVfx`'s, drawn on the victim's body;
 * this is the sentence, on the local player's own screen, and it exists because a gold burst on a rig fifteen
 * studs away is a thing you have to *be looking at* to notice. It is drawn only when **this client landed the
 * hit**.
 *
 * **The event is `hitImpact`, and that choice is the whole of whether this works at all.** `roundHit` — the
 * event the hit feed reads — is sent only for hits with a person at both ends (`RoundService.logHit` is
 * reached only when the thrower is a `Player` *and* the victim is), so a player's throw that lands on a rig
 * produces no `roundHit` at all — and a rig is most of what a player hits in a round against them. **A "you
 * hit" toast built on the feed's event would be silent for exactly the hits a player cares about.** See
 * `networking.ts` on `hitImpact`.
 *
 * **It subscribes in its own right rather than being called from `HitLogController`.** That reader is the
 * feed's, and the feed is about the *round* rather than about the player: it draws the same list on every
 * machine and deliberately no longer knows who is playing it. It also reads the event this one cannot use. So
 * the decision "this hit was mine" is made here, by comparing the thrower's name against
 * `Players.LocalPlayer.Name` — one comparison, against a payload that already carries the name.
 *
 * **Nothing needs resolving and nothing needs looking up**, which is worth stating because `hitVfx` does far
 * more work for less: the toast draws *text*, so the victim's name off the wire is the whole of what it
 * wants. A hit on a body that has since respawned or disconnected still says the right sentence — the name is
 * a string the server wrote from the model it landed on, and a model always has one. **There is no
 * unresolved-name case to decide**, unlike every other reader of a body in this codebase.
 *
 * ## What this is not
 *
 * - **Not a VFX, and nothing is cloned.** Text on the screen: no template, no `ReplicatedStorage` lookup, no
 *   `Debris`. See `hitVfx` for the pixels.
 * - **Not fired when the player is hit.** Being hit is the red effect on your own body and nothing here. Only
 *   the thrower sees a confirmation, because a confirmation is about having *done* something.
 * - **Not a change to the hit log, the hit event, the damage or the effects.** It reads an event the server
 *   already sends, and no existing module is edited to make it work — not `HitLogController`, not `hitVfx`.
 * - **Not stacked.** A second hit replaces the first toast rather than joining it — see {@link SLOT} and
 *   {@link CONFIRM_SECONDS}.
 */
export function startHitConfirm(): void {
	// **Said at boot**, for the reason `hitVfx` says its own: a module with a subscription and no Flamework
	// controller around it is started by hand from `main.client.ts`, and a toast that never fires and one that
	// was never wired print the same nothing.
	if (DEBUG) print(`[HUD] hit confirm up — "You hit <name>" on every hit I land`);

	const scope = Fusion.scoped();

	/**
	 * Whether the confirmation is on screen.
	 *
	 * **One `Value` for a toast that is rebuilt, rather than one per toast**, because at most one of these is
	 * ever up: a second hit replaces the first rather than joining it, so there is never a second wrapper for
	 * a value to be wrong about. Once a wrapper has been destroyed the value drives a dead instance, which
	 * does nothing.
	 */
	const visible = Fusion.Value(scope, false);

	/** The toast currently up, so the next hit can take it down before building its own. */
	let toast: Frame | undefined;

	/**
	 * Bumped by every confirmation, and captured by every dismissal timer.
	 *
	 * **The house pattern for a timer that cannot be cancelled**: a `task.delay` already in flight can only be
	 * *ignored*, so a timer acts only while the token it captured is still current. Without it, two hits inside
	 * {@link CONFIRM_SECONDS} would have the first one's clock hide the second one's toast: a message about the
	 * hit you just landed, taken off the screen by a clock that started before it existed.
	 */
	let dismissToken = 0;

	events.Client.Get("hitImpact").Connect((victim, thrower) => {
		// **The whole trigger: this client is the thrower.** Not the victim — that is the red effect and no
		// toast — not a bystander, which is the neutral effect, and not a rig's throw that landed on somebody
		// else. The comparison is against the name the payload carries, which is the player's name when the
		// throw was a player's.
		if (thrower !== Players.LocalPlayer.Name) return;

		// **Rebuilt rather than updated, which the alert's own API forces.** big-ui's `Alert` reads its title
		// and message once, while it is being built, so a toast that has to say a different name next time has
		// to *be* a different toast. The old wrapper goes before the new one is mounted, so the column never
		// holds two of these at once.
		toast?.Destroy();
		toast = mountToast(scope, {
			name: TOAST_NAME,
			// **No title.** The whole message is one line, and `Alert` omits the heading entirely when it is
			// not given one — see `ToastOptions.title`, which is optional for this reason.
			message: `You hit ${victim}`,
			severity: "success",
			visible: visible,
			slot: SLOT,
		});

		visible.set(true);

		dismissToken += 1;
		const token = dismissToken;
		task.delay(CONFIRM_SECONDS, () => {
			if (token !== dismissToken) return;

			visible.set(false);
		});

		if (DEBUG) print(`[HUD] hit confirm — You hit ${victim}`);
	});
}

/** The wrapper's name in the GUI, and the base of the alert's own name. */
const TOAST_NAME = "HitConfirmToast";

/**
 * Which slot of the bottom-centre column this toast occupies — **slot 0, the bottom row.**
 *
 * **It was slot 1, and it moved down when slot 0 came free.** The bottom row belonged to the throw toggle's
 * two toasts, and the argument for keeping this one out of it was that a confirmation about something this
 * player just did should not share a row with a statement about the game's state — nor be read as one message
 * with two lines. When the toggle retired, its row emptied; a toast 69 pixels up the screen with nothing
 * beneath it is a gap rather than a stack, and the column is built from the bottom, so the bottom is where
 * the last remaining toast belongs.
 *
 * **What "above the power-up HUD" means, in pixels.** `SuperHudController` anchors its stack at
 * `UDim2.new(0.5, 0, 1, -12)` with `AnchorPoint (0.5, 1)`, and the stack is `ICON_SIZE` 56 plus `STACK_GAP` 10
 * plus a 10px segment row = 76px tall, so it occupies the 12th to the 88th pixel up from the bottom edge. The
 * column's own bottom row starts at `TOAST_BOTTOM_OFFSET` 96 — above the stack, with the whole of
 * `hudToast`'s arithmetic between it and the screen edge. **Nothing here is a new number**: the column's
 * width, height and gap belong to `hudToast`, and the only decision this file makes is which row of it to
 * stand in.
 *
 * **Pixel-based rather than scale-based, because the thing it sits above is.** The stack's inset and the
 * column's offset are both pixels measured from the bottom edge, so the toast tracks the Super HUD at every
 * screen size without either being a fraction of the viewport. A `YScale` here would be a fraction of
 * *whichever region the shared GUI is in* — the safe one on a mobile client, the screen's own origin on a
 * desktop — rather than of the screen: see `screenGui.ts` on `ScreenInsets` and on the device gate.
 */
const SLOT = 0;

/**
 * How long the confirmation stays up, in seconds. **Placeholder — 2.**
 *
 * **Short, because this is not the receipt for a decision.** A toast confirming a state a player deliberately
 * entered can afford to sit there — they made the decision, and the message is the acknowledgement of it.
 * This one is about a moment in the world: the ball has landed, the body it landed on is already wearing a
 * 0.9-second effect, and the round has moved on by the time four words have been read. Two seconds is about
 * how long it takes to read them and look back at the arena.
 *
 * **The two ways to be wrong are asymmetric.** Too short and the player misses it while watching the impact
 * they just caused; too long and a stale "You hit" is still up after that player has been hit back, which
 * reads as the game telling them something that is no longer true.
 */
const CONFIRM_SECONDS = 2;
