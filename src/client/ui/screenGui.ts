import { Players } from "@rbxts/services";

/** Named so that every HUD finds the same one and shares it instead of making another. */
const GUI_NAME = "HudGui";

/**
 * The `ScreenGui` the HUDs mount into: the one that is already there, or a new one.
 *
 * One GUI for every HUD rather than one each, because `PlayerGui` collecting a `ScreenGui` per
 * feature is how a game ends up with six of them and no way to tell which is which.
 *
 * **Found by name, not by class.** `PlayerGui` is not an empty box: the engine creates its own
 * `ScreenGui`s in there — the chat's, and the touch controls' on a mobile device — so "the first
 * `ScreenGui` child" and "our GUI" are two different things. Taking the first one is how this
 * function used to return the chat's GUI: every HUD mounted into a GUI Roblox owns and may rebuild
 * at will, the settings below were applied to somebody else's tree, and `GUI_NAME` was never
 * actually used to find anything despite being documented as the thing that makes every HUD share
 * one GUI. Asking for `"HudGui"` can only ever match the one this function makes.
 *
 * Both settings below are about the *screen* rather than about any one HUD, so they are decided
 * once, here, and a HUD added later inherits them by sharing:
 *
 * - `ResetOnSpawn = false`, set even on a GUI this did not create. A `ScreenGui`'s default is to
 *   be destroyed with the character it spawned for, and a HUD that vanished on every death would
 *   be the one thing a HUD must not do.
 * - `ScreenInsets = CoreUISafeInsets`, which keeps the GUI's origin inside the safe area —
 *   the region not covered by the topbar. `y = 0` is the first pixel below Roblox's chrome,
 *   not the true top of the viewport. This is deliberate: a HUD element pinned at `y = 0`
 *   should sit *under* the topbar, not behind it, so nothing the player needs to read is
 *   occluded by Roblox's own UI. The cost is that negative `y` values land in chrome the GUI
 *   does not draw into, and `Scale` fractions are measured against the safe region rather than
 *   the full viewport. Account for both when positioning: use `y = 0` as the top, and treat
 *   `YScale` as a fraction of `viewportHeight - topbarHeight`.
 */
export function getHudScreenGui(): ScreenGui {
	// `PlayerGui` is not a typed member of `Player` in these typings (nor is `Backpack`), so it is
	// found like any other child and the cast names the class rather than guessing it.
	const playerGui = Players.LocalPlayer.WaitForChild("PlayerGui") as PlayerGui;

	// By name first, then checked for class: a `Folder` somebody happened to call `HudGui` is not
	// this GUI, and falling through to create the real one is the right answer. The same two-step
	// the round folder and the throw remotes already use.
	const existing = playerGui.FindFirstChild(GUI_NAME);
	if (existing?.IsA("ScreenGui")) {
		existing.ResetOnSpawn = false;
		existing.ScreenInsets = Enum.ScreenInsets.CoreUISafeInsets;
		return existing;
	}

	const gui = new Instance("ScreenGui");
	gui.Name = GUI_NAME;
	gui.ResetOnSpawn = false;
	gui.ScreenInsets = Enum.ScreenInsets.CoreUISafeInsets;
	gui.Parent = playerGui;

	return gui;
}
