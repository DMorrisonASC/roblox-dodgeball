import { Players } from "@rbxts/services";

/** Named so that every HUD finds the same one and shares it instead of making another. */
const GUI_NAME = "HudGui";

/**
 * The `ScreenGui` the HUDs mount into: the one that is already there, or a new one.
 *
 * One GUI for every HUD rather than one each, because `PlayerGui` collecting a `ScreenGui` per
 * feature is how a game ends up with six of them and no way to tell which is which.
 *
 * It is also the only way the two settings below stay true. Both are about the *screen* rather
 * than about any one HUD, so a HUD added later inherits them by sharing, and neither of the two
 * has to remember settings that are not its business:
 *
 * - `ResetOnSpawn = false`, set even on a GUI this did not create. A `ScreenGui`'s default is to
 *   be destroyed with the character it spawned for, and a HUD that vanished on every death would
 *   be the one thing a HUD must not do.
 * - `ScreenInsets = None`, which puts the GUI's origin at the actual top-left of the screen
 *   rather than at the corner of the safe area — the safe area is where the topbar lives, and a
 *   HUD meant to sit *at* the top cannot reach it through an inset. Skipped on a GUI somebody else
 *   made, since the insets are part of their layout.
 */
export function getHudScreenGui(): ScreenGui {
	// `PlayerGui` is not a typed member of `Player` in these typings (nor is `Backpack`), so it is
	// found like any other child and the cast names the class rather than guessing it.
	const playerGui = Players.LocalPlayer.WaitForChild("PlayerGui") as PlayerGui;

	const existing = playerGui.FindFirstChildWhichIsA("ScreenGui");
	if (existing) {
		existing.ResetOnSpawn = false;
		return existing;
	}

	const gui = new Instance("ScreenGui");
	gui.Name = GUI_NAME;
	gui.ResetOnSpawn = false;
	gui.ScreenInsets = Enum.ScreenInsets.None;
	gui.Parent = playerGui;

	return gui;
}
