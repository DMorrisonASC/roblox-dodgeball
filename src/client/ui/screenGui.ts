import Fusion from "@rbxts/fusion-3.0";
import { Players, Workspace } from "@rbxts/services";

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
		existing.ScreenInsets = Enum.ScreenInsets.None;
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
 * The name of the one column the round's two readouts live in.
 *
 * Named for the same reason `GUI_NAME` is: it is found rather than remembered, so a second call cannot make a
 * second column.
 */
const COLUMN_NAME = "TopReadouts";

/**
 * How far below the top of the safe region the column sits, in pixels. **Placeholder — 14.**
 *
 * **This is one number where there used to be two, and the two are worth the paragraph.** The score bar sat at
 * its own offset and the clock sat at *its* own offset, in the same GUI from the same origin — so the two were
 * the rows of one column that nothing declared. Both files said so at length: `ScoreHudController`'s
 * `SCORE_TOP_INSET` argued that it and the band's offset "have to be moved together", and
 * `RoundStatusController`'s `HUD_TOP_INSET` argued the same pair from the other end, each of them naming
 * roughly `44` against `4` as the pair that fits because the score plate is about forty pixels tall. **Both
 * values were `14`.** So the plate was drawn from `14` to about `54` and the band from `14` to about `38` — and
 * because the plate sits at `SCORE_Z_INDEX = 4` and the band at the default rung, the plate was drawn *across
 * the clock* for the whole of every intermission, which is the one phase the clock exists for.
 *
 * **That is what a `UIListLayout` answers and what two coordinates cannot.** A column places its second child
 * under its first, whatever either of them turns out to be tall — so the offset is decided once, here, and the
 * distance between the two readouts is the layout's business rather than a number that has to be kept in step
 * with a plate's height. See {@link getHudColumn}.
 */
const COLUMN_TOP_INSET = 14;

/**
 * The gap between the two readouts, as a **fraction of the viewport's height** with a floor in pixels.
 *
 * **Relative because a gap between two readouts should shrink with the screen, and derived from the *viewport*
 * rather than from the column because the column cannot be asked.** A `UDim`'s scale component is a fraction of
 * the size of the element it pads — and this frame is `AutomaticSize`, so its height is computed *from* the gap
 * between its children: a scale padding there is a value that determines the size it is measured against, which
 * is a feedback loop rather than a layout. The viewport is a number nobody in this tree is deriving, so it is
 * the honest thing to be relative to — the same move `addViewportConstraint` makes so that a cap can be "92% of
 * the screen" without a measurement cycle. `0.012` of a 1080-pixel viewport is 13 pixels, and the floor keeps a
 * very short screen from closing the gap to nothing.
 */
const COLUMN_GAP_SCALE = 0.012;
const COLUMN_GAP_MIN_PIXELS = 8;

/**
 * The scope the column's own reactive value lives in, and **the one thing in this module that is a graph object
 * rather than an instance.**
 *
 * A module-level scope, for `panels.ts`' reason read from this side of the wire: the value is a fact about the
 * *screen*, it outlives every controller that reads it, and the column it feeds is a session-lifetime
 * singleton — exactly like the `ScreenGui` this module already owns. Nothing here is per-controller, so there
 * is nothing for a controller's scope to clean up.
 */
const columnScope = Fusion.scoped();

/** The column, once it has been made. See {@link getHudColumn} for why it is a module's to hold. */
let column: Frame | undefined;

/**
 * The transparent column that holds **both of the round's readouts**: the score bar first, the clock under it.
 *
 * **One container, so the order is a fact rather than two numbers that agree.** The bar and the band were each
 * mounted straight into the shared GUI and each carried its own offset from the same origin — see
 * {@link COLUMN_TOP_INSET} for what the pair of offsets actually did, which was to draw one over the other.
 * Here each readout is a child, the vertical `UIListLayout` places the second under the first, and neither
 * knows or cares how tall the other is.
 *
 * **It is a module here rather than a wire between the two controllers, and this module is where it belongs.**
 * `screenGui.ts` and `panels.ts` are the two places this client lets two HUDs share something without either of
 * them owning it — a `ScreenGui`, or a fact about the session — and a parent is the first of those two kinds of
 * thing. Both readouts already import this file, so the column is reachable from each of them with no new
 * dependency and no new file; the alternative was for one controller to mount into the other's frame, which is
 * a controller→controller edge this codebase refuses everywhere else (the phase is published for the same
 * reason). **`panels.ts` describes this arrangement as "the same shape `client/ui/screenGui.ts` uses"**, which
 * is this function.
 *
 * **The order is part of the contract and is `LayoutOrder`'s**: `1` is the scores, `2` is the clock. It is
 * named here rather than in either readout because it is a fact about the *column* — the whole point of the
 * layout is that the clock is below the scores, and a readout that set its own order would be deciding where it
 * sits in somebody else's frame. **Each readout keeps its own visibility rule, which is why they are two
 * children rather than one**: the bar is drawn only while a mode that keeps score is published, the clock in
 * every phase. `UIListLayout` leaves an invisible child out of the layout entirely, so a hidden bar costs no
 * gap and no height and the clock simply rises to the top of the column.
 *
 * **Nothing here is painted and nothing here needs a `ZIndex`.** The frame's `BackgroundTransparency` is `1`, so
 * it cannot occlude anything, and it deliberately does *not* call `raiseZIndex` — that helper exists to lift a
 * *painted* container over its own children, and running it here would flatten the bar's own rung
 * (`SCORE_Z_INDEX`) into the clock's. The ZIndex question these two used to raise is answered by the layout
 * instead: siblings in a list layout cannot be drawn over each other, because they cannot be drawn in the same
 * place.
 *
 * **What this is not: a padding, a size, or a bound.** The frame has no `UIPadding` — an inset on a *container*
 * moves its contents off its own edges, while the space *between* two children is the layout's `Padding`, which
 * is where the gap lives ({@link COLUMN_GAP_SCALE}). It has no `UISizeConstraint` of its own either, because
 * its width is its widest child and both children are already bounded: the bar by its own
 * `addViewportConstraint`, the band by the one on its wrapper.
 */
export function getHudColumn(): Frame {
	if (column !== undefined) return column;

	const camera = Workspace.CurrentCamera;
	const viewportHeight = Fusion.Value(columnScope, camera !== undefined ? camera.ViewportSize.Y : 0);

	// Guarded rather than assumed, for `addViewportConstraint`'s reason: there is no camera before there is
	// one, and a column that cannot measure the screen keeps its floor rather than failing to be built.
	if (camera !== undefined) {
		columnScope.push(
			camera.GetPropertyChangedSignal("ViewportSize").Connect(() => viewportHeight.set(camera.ViewportSize.Y)),
		);
	}

	const gap = Fusion.Computed(columnScope, (use) =>
		new UDim(0, math.max(COLUMN_GAP_MIN_PIXELS, use(viewportHeight) * COLUMN_GAP_SCALE)),
	);

	const frame = Fusion.New(columnScope, "Frame")({
		Name: COLUMN_NAME,
		// No size of its own: the layout and `AutomaticSize` make it exactly as big as its two children, so a
		// hidden readout costs no height. The anchor is on the *column* because its children are positioned by
		// the layout, and an anchor on a child would be a second opinion about where that child goes.
		Size: UDim2.fromOffset(0, 0),
		AutomaticSize: Enum.AutomaticSize.XY,
		AnchorPoint: new Vector2(0.5, 0),
		Position: new UDim2(0.5, 0, 0, COLUMN_TOP_INSET),
		BackgroundTransparency: 1,
	});

	Fusion.New(columnScope, "UIListLayout")({
		Parent: frame,
		FillDirection: Enum.FillDirection.Vertical,
		SortOrder: Enum.SortOrder.LayoutOrder,
		HorizontalAlignment: Enum.HorizontalAlignment.Center,
		Padding: gap,
	});

	frame.Parent = getHudScreenGui();

	column = frame;

	return frame;
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
 * shop, the result screen and the respawn countdown are all covered by one value on this GUI — see
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

/**
 * **There was a fourth GUI here — a `ScreenGui` of the round status board's own — and it is deleted with its
 * only caller.** It existed to give one panel a `ScreenInsets` of its own, and three values were tried across
 * three revisions. All three failed the same way, and that is the thing worth keeping:
 *
 * - **`None` and `DeviceSafeInsets` both *drop* the topbar inset rather than moving anything into it.** On a
 *   desktop, where there are no device cutouts, the two are the same area: `y = 0` becomes the true top of the
 *   viewport, so any panel that had been positioned just under the topbar is now drawn *underneath* Roblox's
 *   own chrome instead. The typings say it in as many words for `DeviceSafeInsets` — "no inset is added for
 *   Roblox core UI elements like the top bar buttons".
 * - **`TopbarSafeInsets` moves the panel *into* that chrome's row, and there is nothing to tune there.** The
 *   area is a top bar tall by definition — "limited to the space available within the top bar area itself" —
 *   so a panel inside it is flush with the top of the screen by construction, and no offset in any file can
 *   give it room to sit lower. "Too close to the top" is not a value to adjust; it is the ceiling.
 *
 * **The distinction to carry forward is region versus offset.** `ScreenInsets` decides *which region* a GUI
 * draws in — the safe area, the top bar's row, the whole screen — and it cannot move anything *within* the
 * region it picks. A panel that wants to be some distance down the screen wants an **offset**, in the shared
 * GUI, where every other HUD already is; {@link COLUMN_TOP_INSET} is that number for the two readouts, and the
 * band it was written for (`RoundStatusController`'s own `HUD_TOP_INSET`) says so in the same words before
 * moving into this file's column. **A second `ScreenGui` earns its name only when a panel has to draw where
 * the nine others must not** — whole-screen covers, which is exactly the three remaining here — never to
 * reposition one of them.
 */
