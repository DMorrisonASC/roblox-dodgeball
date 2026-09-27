import { Controller, OnStart } from "@flamework/core";
import { Button } from "@rbxts/big-ui";
import Fusion from "@rbxts/fusion-3.0";
import { getHudScreenGui } from "../../ui/screenGui";

/** Prints on click — the line that says the controller mounted and the button is wired up. */
const DEBUG = true;

/** The button's own size: a fixed tap target, not sized to its label. */
const BUTTON_SIZE = new UDim2(0, 120, 0, 44);

/** How far in from the screen's top-left corner the button sits, in pixels. */
const EDGE_INSET = 12;

/** What the button says. big-ui sets buttons in caps, so this draws as `SHOP`. */
const BUTTON_TEXT = "Shop";

/**
 * The shop's way in: one button in the screen's top-left corner.
 *
 * **Top-left because it is the only corner left.** The other three are spoken for, and each of
 * them by something that would rather not be moved — the round status reads from the top-centre
 * (`RoundStatusController`, a 360px card anchored `(0.5, 0)`, so it covers x∈[460, 820] on a
 * 1280px screen), the controls legend is pinned to the right edge vertically centred
 * (`ControlsLegendController`), and the cooldown bars are anchored to the *bottom*-left
 * (`CooldownHudController`, anchor `(0, 1)`). At 12px in from a 1280×720 corner this button
 * covers x∈[12, 132], y∈[12, 56] — clear of all three by hundreds of pixels, and clear at 1920×1080
 * by more.
 *
 * **This is a placeholder and holds no logic.** It exists so the shop has somewhere to hang from
 * that is already themed, already placed and already known to fit. Clicking prints and nothing
 * else: no panel, no remote, no service call, no toggle state. Whether a click opens anything is
 * a question for the change that builds the shop, and answering it here would mean guessing at it
 * now.
 *
 * **One instance for the session, not one per character.** It is mounted once into the shared
 * `ScreenGui`, which sets `ResetOnSpawn = false`, so it survives every death without anything
 * here having to know that respawning happens.
 */
@Controller()
export class ShopController implements OnStart {
	public onStart(): void {
		// Spawned rather than done inline, for the same reason the other HUDs do it: mounting waits
		// for `PlayerGui`, and a controller's `onStart` is the wrong place to hold up the rest of
		// the client's boot while that resolves.
		task.spawn(() => this.mount());
	}

	private mount(): void {
		const scope = Fusion.scoped();

		// `label`, not `children`. big-ui's `Button` takes its text as a string prop and builds its
		// own `TextLabel` from it (`node_modules/@rbxts/big-ui/out/components/Button.d.ts` —
		// `label: string` required, `variant` limited to `contained | outlined | text`). There is no
		// `children` prop and no `"button"` variant, so the `Text`-inside-`Button` shape does not
		// exist to build; the label is the button's own business and it draws it in caps.
		//
		// `size: "large"` rather than a number, because big-ui's sizes are a *bundle* — the type
		// size and the horizontal padding come with the height — and picking "large" is what keeps
		// the label proportional to a 44px-tall target. The height it would have used is overridden
		// below; the rest of the bundle is not, and should not be.
		const button = Button(scope, {
			label: BUTTON_TEXT,
			variant: "contained",
			color: "primary",
			size: "large",
		});

		// **`AutomaticSize.None` is required, and is not a tidy-up.** `Button` builds its
		// `TextButton` with `AutomaticSize = Enum.AutomaticSize.X` so that it hugs its label, and an
		// automatic axis wins over `Size` — setting the size alone would leave the width at whatever
		// "SHOP" plus padding comes to, which is roughly half of the 120 asked for. Clearing it
		// first is what makes the fixed target the fixed target, and it is set before `Size` for the
		// same reason: the width is only stored once nothing is overriding it.
		button.AutomaticSize = Enum.AutomaticSize.None;
		button.Size = BUTTON_SIZE;

		// `AnchorPoint` left at its default `(0, 0)`, so `Position` is measured from that corner and
		// the offsets below are the distances from the two edges. The two *other* HUDs are anchored
		// to a far corner — `(1, 0.5)` and `(0, 1)` — because they hang off the right and bottom
		// edges; nothing here does, and an anchor of `(0, 1)` would put the button at the
		// bottom-left, on top of the cooldown bars.
		//
		// `12` from the top is 12px *below the safe area*, not below the screen edge: the shared
		// `ScreenGui` is built with `ScreenInsets = CoreUISafeInsets`, so y=0 is already under the
		// topbar. That is the wanted reading — the button clears the Roblox chrome without this file
		// knowing how tall that chrome is.
		button.Position = new UDim2(0, EDGE_INSET, 0, EDGE_INSET);

		// `Button` calls itself "Button", which is no help in the Explorer — and two HUDs both
		// calling their root the same thing is how a HUD stops being findable. Named after what it
		// is, the way `CooldownHudController` names its container.
		button.Name = "ShopButton";

		// A `TextButton`, so `Activated` is the button's own signal rather than a child's. big-ui
		// also offers an `onActivate` prop; the signal is used instead so that this line reads the
		// same way the future shop's own wiring would, and so nothing about the debug print depends
		// on how big-ui chooses to forward its events.
		button.Activated.Connect(() => {
			if (DEBUG) print("[Shop] clicked — no shop implemented yet");
		});

		// The shared GUI, never a second one: `PlayerGui` collecting a `ScreenGui` per feature is
		// how a game ends up with six of them, and the settings that belong to the screen rather
		// than to any one HUD — `ResetOnSpawn`, the screen insets — are decided once there.
		button.Parent = getHudScreenGui();

		if (DEBUG) print(`[Shop] button up — ${BUTTON_SIZE.X.Offset}x${BUTTON_SIZE.Y.Offset} at the top-left`);
	}
}
