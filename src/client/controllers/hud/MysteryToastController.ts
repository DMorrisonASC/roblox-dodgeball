import { Controller, OnStart } from "@flamework/core";
import Fusion from "@rbxts/fusion-3.0";
import { Players } from "@rbxts/services";
import { ABILITY_NAMES } from "shared/ability";
import { POWER_ROSTER } from "shared/config/economy.config";
import { MYSTERY_CONFIG } from "shared/config/mystery.config";
import { MYSTERY_POWER_ATTRIBUTE } from "shared/constants";
import { mountToast } from "../../ui/hudToast";

/** Prints on mount — the line that says the controller ran at all. */
const DEBUG = true;

/**
 * Which slot of the bottom-centre column this toast occupies, counted from the bottom.
 *
 * **Slot 1, which is where the camera toast used to be.** That toast went with the `~` release — both of
 * its states *were* the release — so the slot has been unused since, and this is the thing that takes it.
 * Slot 0 is the throw toggle's; the two can be up at once (a player with throwing switched off is free to
 * collect a box), so they stack rather than share. See `ui/hudToast.ts`, which owns the width, the gap
 * from the screen edge and the height the stack is built from.
 */
const SLOT = 1;

/**
 * The one line a mystery box has to say, and the reason there is only one.
 *
 * **big-ui's `Alert` reads `title` and `message` once, while it is being built** — the argument
 * `ThrowStateToastController` writes out at length. So a toast whose *words* change cannot be one alert
 * that is told to change its mind; it has to be one alert per thing it can say. The thing that varies here
 * is which power the box rolled, and the vocabulary for that is fixed and small — `POWER_ROSTER` is three
 * names tonight and one line to extend — so the honest reading of that API is **one alert per power**,
 * built once, each gated on the power it names. The body does not vary at all, which is why it is a
 * constant rather than a second template.
 */
function body(): string {
	return `Free for ${MYSTERY_CONFIG.WINDOW_SECONDS} seconds — no charge needed`;
}

/**
 * The mystery box, announced: which power it gave, and for how long.
 *
 * **It reads `MYSTERY_POWER_ATTRIBUTE` and never writes anything.** What a box grants and when the window
 * closes are `SuperService`'s — this file has no opinion about either, only about saying so. The window's
 * end needs no timer here for exactly that reason: `clearMysteryWindow` publishes the empty value, so the
 * value *is* the visibility, and the toast cannot outlive the power by so much as a frame even if it is
 * told about the end late.
 *
 * **No countdown, and the attribute that could drive one is deliberately unused.** The message is a fixed
 * string read once at construction, so a number that ticked would need the alert rebuilt every second —
 * which is the thing the note above refuses. A readout that counts down belongs on a HUD with a `Computed`
 * text, not on a toast, and none is built: `MYSTERY_POWER_ENDS_AT_ATTRIBUTE` is published and read by
 * nothing, ready for whoever wants one.
 */
@Controller()
export class MysteryToastController implements OnStart {
	public onStart(): void {
		// Spawned rather than done inline, matching the other HUDs: mounting waits for `PlayerGui`.
		task.spawn(() => this.mount());
	}

	private mount(): void {
		const scope = Fusion.scoped();
		const player = Players.LocalPlayer;

		/**
		 * The power a collection is currently paying for, mirrored. `""` when there is none.
		 *
		 * Seeded from the attribute rather than defaulted to empty, for the reason the throw toggle's twin
		 * gives: a player can already have a window open when this runs — they collected a box, then their
		 * HUD finished mounting — and the toast is supposed to be up on the first frame rather than only
		 * from the next change onwards. A cleared window publishes `""`, so "empty" is a real value this
		 * sees and not just its initial state.
		 */
		const value = player.GetAttribute(MYSTERY_POWER_ATTRIBUTE);
		const power = Fusion.Value(scope, typeIs(value, "string") ? value : "");

		scope.push(
			player.GetAttributeChangedSignal(MYSTERY_POWER_ATTRIBUTE).Connect(() => {
				// `raw` and not `next`: `next` is Lua's own iterator, and roblox-ts refuses the identifier
				// outright — "Cannot use identifier reserved for compiler internal usage" — rather than
				// letting it shadow anything.
				const raw = player.GetAttribute(MYSTERY_POWER_ATTRIBUTE);
				const text = typeIs(raw, "string") ? raw : "";
				power.set(text);

				if (DEBUG) print(`[Toast] ${MYSTERY_POWER_ATTRIBUTE} = ${text}`);
			}),
		);

		// **One alert per power, and all of them in one slot.** They are mutually exclusive — a player has
		// exactly one window and therefore one kind — so "slot 1" is one toast where it is observable, which
		// is the same arrangement the throw toggle's two alerts have in slot 0.
		for (const kind of POWER_ROSTER) {
			mountToast(scope, {
				name: `MysteryToast_${kind}`,
				title: ABILITY_NAMES[kind],
				message: body(),
				severity: "success",
				visible: Fusion.Computed(scope, (use) => use(power) === kind),
				slot: SLOT,
			});
		}

		if (DEBUG) {
			print(
				`[Toast] mounted — ${MYSTERY_POWER_ATTRIBUTE} = ${typeIs(value, "string") ? value : ""},` +
					` ${POWER_ROSTER.size()} alert(s)`,
			);
		}
	}
}
