import { Players } from "@rbxts/services";

/** Named so that every HUD finds the same one and shares it instead of making another. */
const GUI_NAME = "HudGui";

/**
 * The name of the second GUI — the one that paints into the safe region instead of respecting it.
 *
 * A separate name and a separate `ScreenGui`, because the two answer opposite questions about the
 * same screen. See {@link getSplashScreenGui}.
 */
const SPLASH_GUI_NAME = "SplashGui";

/**
 * Where the splash GUI sits against the shared one, in the `ScreenGui` order.
 *
 * **Zero is the shared GUI's value, and it is the default** — nothing in this project sets
 * `DisplayOrder`, so `HudGui` has been at `0` all along, and every panel's layering has been
 * `ZIndex` *inside* it. This is a different ladder: `DisplayOrder` orders whole `ScreenGui`s against
 * each other and it wins outright, so a pixel drawn by the GUI at `1` is drawn over every pixel of
 * the GUI at `0`, whatever either tree's `ZIndex` says. That is exactly what a full-screen splash
 * needs, and exactly why one cannot be built out of the shared GUI's tree.
 */
const SPLASH_DISPLAY_ORDER = 1;

/**
 * The third GUI's name and its rung on that ladder, and it sits above the splash on purpose.
 *
 * **2 is the next number rather than a big one.** `DisplayOrder` is a ladder, not a priority: `0` is
 * every HUD, `1` is the join splash, and this is the one screen-wide cover that happens *during* a
 * session rather than at its start — so it is the next rung. A value chosen for headroom, `100` say,
 * would be saying "this has to beat something I have not met" about a GUI that only has to beat two, and
 * it would hide the more useful fact: the splash and this one answer the same question, and are worth
 * keeping adjacent so that stays visible.
 *
 * **Above the splash rather than below, and it is the one case where they can meet.** A client still
 * under the join splash when a round begins is a client that joined during the intermission and has not
 * finished arriving; the round starts without it either way. Below the splash, the wipe would simply not
 * be seen — above it, the worst case is a wipe over a join screen, which is a client being told a round
 * started while it was still loading, which is true.
 */
const TRANSITION_GUI_NAME = "TransitionGui";
const TRANSITION_DISPLAY_ORDER = 2;

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

/**
 * The `ScreenGui` a full-screen splash mounts into: the same find-or-create, with **no insets at
 * all**.
 *
 * **The one difference from {@link getHudScreenGui}, and it is the whole point: that one respects
 * the safe region and this one paints into it.** `ScreenInsets` belongs to the `ScreenGui` and
 * applies to everything inside it, so a child of the shared GUI — however it is sized — can never
 * draw into the strip under Roblox's topbar, nor the strip the touch controls sit in on a phone. For
 * a HUD that is right: the strip is Roblox's chrome, and a panel that painted into it would be
 * drawing where the GUI does not own. For an image whose job is to *cover the screen* it is wrong in
 * the opposite direction: a splash that stops a few pixels below the top of the screen leaves a band
 * of the game showing through it, which reads as broken rather than as deliberate.
 *
 * **A second GUI rather than a setting on the first, and this is forced rather than chosen.** `Do
 * not change getHudScreenGui` is not a style rule: nine HUD controllers parent into it and every one
 * of them wants `CoreUISafeInsets`, so the shared helper's value is a decision nine files depend on.
 * The alternative — a flag on the helper, or the caller setting the property — would put a
 * screen-wide decision in the hands of whichever HUD mounted last.
 *
 * **`PlayerGui` holding two `ScreenGui`s is expected, and it is not the thing that helper exists to
 * prevent.** The argument there was against a GUI *per HUD* — six of them, indistinguishable — and
 * it is answered by these two having different jobs and different names. See
 * {@link SPLASH_DISPLAY_ORDER} for why the second one has to be *above* the first rather than
 * merely beside it.
 *
 * Found by name on a second call exactly as its sibling is, and for the same reason: a `Folder`
 * somebody happened to call `SplashGui` is not this GUI, so the name is checked and the class is
 * confirmed before the existing instance is handed back.
 */
export function getSplashScreenGui(): ScreenGui {
	const playerGui = Players.LocalPlayer.WaitForChild("PlayerGui") as PlayerGui;

	const existing = playerGui.FindFirstChild(SPLASH_GUI_NAME);
	if (existing?.IsA("ScreenGui")) {
		existing.ResetOnSpawn = false;
		existing.ScreenInsets = Enum.ScreenInsets.None;
		existing.DisplayOrder = SPLASH_DISPLAY_ORDER;
		return existing;
	}

	const gui = new Instance("ScreenGui");
	gui.Name = SPLASH_GUI_NAME;
	gui.ResetOnSpawn = false;
	gui.ScreenInsets = Enum.ScreenInsets.None;
	gui.DisplayOrder = SPLASH_DISPLAY_ORDER;
	gui.Parent = playerGui;

	return gui;
}

/**
 * The `ScreenGui` the round-start wipe mounts into: the same find-or-create as both of its siblings, and
 * `None` insets for the splash's reason.
 *
 * **Why this is a third `ScreenGui`, restated because a third one is where the argument has to be
 * made rather than inherited.** `getHudScreenGui`'s case against one GUI per feature was about
 * *panels* — a thing that sits in a corner and wants the safe region — and it is answered by these GUIs
 * not being panels but whole-screen covers with two different moments. A wipe parented into the shared
 * GUI inherits `CoreUISafeInsets` from it, and `ScreenInsets` belongs to the `ScreenGui`: a child cannot
 * paint the strip under Roblox's topbar however it is sized, so the grid would leave a band of the game
 * showing along the top and another along the bottom of a phone screen. That is the same failure the
 * splash's doc describes, and it reads as broken rather than as deliberate in both cases.
 *
 * **It is also what puts the wipe over the HUDs rather than behind them.** `DisplayOrder` orders whole
 * `ScreenGui`s and beats any `ZIndex` inside either tree, so the eleven HUD controllers' panels, the
 * shop, the result screen and the spectator label are all covered by one value on this GUI — see
 * {@link TRANSITION_DISPLAY_ORDER} for the value and for why it is one above the splash rather than far
 * above it.
 *
 * **The `ScreenGui` is reused between rounds and never destroyed.** The controller destroys the grid
 * inside it when the wipe ends, so what stays in `PlayerGui` between rounds is an empty, disabled-free
 * GUI with a name — the same thing the splash leaves behind after a join. Making a new one per round
 * would be a `ScreenGui` created and thrown away once a minute, and the find-or-create below is what
 * makes that unnecessary.
 */
export function getTransitionScreenGui(): ScreenGui {
	const playerGui = Players.LocalPlayer.WaitForChild("PlayerGui") as PlayerGui;

	const existing = playerGui.FindFirstChild(TRANSITION_GUI_NAME);
	if (existing?.IsA("ScreenGui")) {
		existing.ResetOnSpawn = false;
		existing.ScreenInsets = Enum.ScreenInsets.None;
		existing.DisplayOrder = TRANSITION_DISPLAY_ORDER;
		return existing;
	}

	const gui = new Instance("ScreenGui");
	gui.Name = TRANSITION_GUI_NAME;
	gui.ResetOnSpawn = false;
	gui.ScreenInsets = Enum.ScreenInsets.None;
	gui.DisplayOrder = TRANSITION_DISPLAY_ORDER;
	gui.Parent = playerGui;

	return gui;
}
