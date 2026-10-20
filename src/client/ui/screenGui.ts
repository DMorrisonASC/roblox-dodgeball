import Fusion from "@rbxts/fusion-3.0";
import { Players, UserInputService, Workspace } from "@rbxts/services";
import { isMobile } from "../platform";

/**
 * Prints one line per GUI when it is made, plus a line if a GUI is ever found in the wrong region.
 *
 * **Placeholder — on**, and it is on because the five lines it costs a session are the whole of what this
 * module can tell a reader: which region each GUI ended up in and what decided it. The one session it earns its
 * keep in is the one where a HUD element is drawn under the topbar.
 */
const DEBUG = false; // off for frame time — see shared/config/debug.config.ts

/**
 * **Two questions decide which `ScreenGui` a thing mounts into, and they are asked in this order. The first is
 * the rule; the second answers only where the first has nothing to say.**
 *
 * 1. **Where does the number that positions it come from?** If it is a *screen* coordinate — a
 *    `UserInputService:GetMouseLocation()`, an `AbsolutePosition` read off something the engine owns — it
 *    belongs in a `ScreenInsets.None` GUI, because a `None` GUI's origin *is* the screen's corner. If it is a
 *    *touch* position, it belongs in a `CoreUISafeInsets` one, because that is the space a touch is reported in
 *    (see {@link getStickScreenGui} for how that was found, and for what it cost to find it). **It has an
 *    answer whenever the element's geometry is a statement about the *screen* — a point to line up with, or an
 *    edge to reach — and where it has one it wins**, and it wins because the failure is otherwise quiet: the
 *    engine hit-tests each `ScreenGui` in *that GUI's* own space, so a control placed with numbers from the
 *    other space still **presses** where the player's finger is and is only **drawn** somewhere else. A working
 *    button is not evidence about a coordinate space.
 * 2. **Which device is this?** Where question 1 is silent — an element whose position and size are *fractions
 *    of the region it is in*, so that it is placed correctly in either one and only its distance from Roblox's
 *    chrome differs — the device decides:
 *    `CoreUISafeInsets` on a mobile client, `ScreenInsets.None` on a desktop one. On a phone that region is not
 *    only the device's cutouts but Roblox's own chrome as well, and a HUD element anchored at `y = 0` drawn
 *    from the screen's origin lands underneath both; on a desktop the player has a window, a mouse and no
 *    cutout, and the decision is that the HUD sits at the screen's own origin there. **Where the region's inset
 *    is zero** — no cutout and no topbar, which no client of this project has been measured on — the two
 *    answers are the same origin, so the split is unobservable rather than wrong.
 *
 * **The two counter-examples are the load-bearing part of this, one on each side of the split.**
 *
 * - **The aim sight is `None` on a *mobile* client**, and that is the case that shows the order of the questions
 *   rather than a mistake. Every number that places it is a screen number: a phone aims down the camera's own
 *   axis (`ThrowController.getThrowDirection` returns `camera.CFrame.LookVector` when `isMobile()`), and that
 *   axis is the middle of the *screen* — so `ShiftLock` draws the sight at `(0.5, 0.5)` and needs that to be the
 *   middle. Drawn in the safe region it would be half a topbar low, which is a crosshair a finger's width off
 *   the line the ball actually goes down. Question 1 is not silent about it, so question 2 is never asked.
 * - **The movement stick is `CoreUISafeInsets` on the mobile client it exists on**, and that is a coordinate
 *   requirement rather than the device rule agreeing with itself: a touch is reported in the safe region's
 *   space, so an inset GUI is the one whose origin *is* the touch's own origin, and the conversion that used to
 *   reconcile the two was deleted rather than corrected. See {@link getStickScreenGui} for the long version and
 *   for the arithmetic that depends on it.
 *
 * **The device half is one function rather than an `if` at each accessor** ({@link edgeAnchoredInsets}), and
 * the reason is a bug this file has already had: `getHudScreenGui` created its GUI with `CoreUISafeInsets` and
 * then *found* that GUI on every later call and set `None`, so which region the HUD was in depended on how many
 * times somebody had asked — and because eleven HUD controllers ask it, and two of this client's own modules
 * besides, `None` always won. **That bug is `if`-shaped, so the fix is to leave nowhere to put a second `if`**:
 * one expression, called from both branches of both gated accessors, cannot disagree with itself, and a
 * create/find pair is exactly where a disagreement hides.
 */

/**
 * The region an element whose position is a fraction of the region it is in belongs in on **this** client: the
 * safe area on a mobile client, the screen's own origin on a desktop one.
 *
 * **This is question 2 of the rule above, in one place, and the one place is the point.** Both branches of both
 * gated accessors call *this* function rather than an `if` of their own, so a create and a find cannot disagree
 * about the region — which is the failure the rule describes, and the one a second copy of the test would
 * reintroduce the moment somebody edited one of them.
 *
 * **Read per call rather than latched into a module-level constant**, for `platform.ts`'s reason: a client does
 * not change platform during a session, so every call gets the same answer, and a `const` would only be a value
 * captured whenever this file happened to be required.
 *
 * **What it is not: a test of whether the *screen* has an inset.** On a desktop client `CoreUISafeInsets` is
 * still not `None` — Roblox's topbar is part of it — so this is a decision about which region a HUD should live
 * in rather than a measurement. The measurement, where one is wanted, is `GuiService`'s, and
 * `TouchJoystickController` is where the one in this client is taken and printed.
 */
function edgeAnchoredInsets(): Enum.ScreenInsets {
	return isMobile() ? Enum.ScreenInsets.CoreUISafeInsets : Enum.ScreenInsets.None;
}

/**
 * The device, in the two flags the test is made of, for the `[screenGui]` lines.
 *
 * **The reader's next question after "which region" is "why did it decide that"**, and the two flags are the
 * whole of the answer rather than a footnote: `isMobile()` is `TouchEnabled && !KeyboardEnabled`, so a phone
 * with a keyboard in front of it reads as a desktop here exactly as it does in every other caller — see
 * `platform.ts` for the argument, for the one client that leaves open, and for the count of callers.
 */
function deviceSentence(): string {
	const touch = UserInputService.TouchEnabled ? "touch, " : "no touch, ";
	const keyboard = UserInputService.KeyboardEnabled ? "keyboard" : "no keyboard";

	return `isMobile() ${isMobile() ? "true" : "false"} — ${touch}${keyboard}`;
}

/**
 * Reports a GUI this module has just created: its name, the region it ended up in, and what decided it.
 *
 * **The region is read back off the instance rather than echoed from the caller's local**, which is the habit
 * `CoreGuiController` describes about its own read-back: the line should say what the GUI *has*, so a write that
 * did not take is visible in a log rather than asserted away by the line that was supposed to report it.
 *
 * **It deliberately does not print the inset itself.** `GuiService:GetGuiInset()` has been measured answering
 * `0, 0` at the moment a client's controllers first run — see `TouchJoystickController.readInsets`, which moved
 * its own copy of this line out of the mount for exactly that reason — so a measurement taken here would read
 * "no inset" on every device and would be the kind of diagnostic that lies once per session. What this line is
 * about is the *decision*; what the region actually measures is the joystick's line's business, and that one
 * reads it at the first frame the number is real.
 */
function reportCreated(gui: ScreenGui, decided: string): void {
	if (!DEBUG) return;

	print(`[screenGui] ${gui.Name} created — ScreenInsets = ${gui.ScreenInsets.Name}; ${decided}`);
}

/**
 * Reports a GUI that was *found* with insets this client's rule does not ask for, before correcting them.
 *
 * **This is the create/find agreement made observable rather than assumed.** The failure the rule at the top of
 * this file describes was a find branch that set a different value from its create branch, and nothing in a
 * session said so — the HUD was simply in the other region. A line here turns the next one into a log entry. It
 * cannot fire in a healthy session: nothing outside this module writes `ScreenInsets` on these GUIs.
 */
function reportDrift(gui: ScreenGui, insets: Enum.ScreenInsets): void {
	if (!DEBUG || gui.ScreenInsets === insets) return;

	print(
		`[screenGui] ${gui.Name} was found with ScreenInsets = ${gui.ScreenInsets.Name} and this client's rule asks ` +
			`for ${insets.Name} — setting it. Something other than this module wrote the property, or one branch of ` +
			`the find-or-create has drifted from its pair.`,
	);
}

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
 * **Zero is the HUD plane.** `HudGui` never sets `DisplayOrder` at all, so it is the default `0`, and every
 * panel's layering has been `ZIndex` *inside* it — while the other GUIs on that plane (`FullScreenGui`,
 * `ScreenSpaceGui`, `StickGui`) set the same `0` explicitly, because they are new instances with no inherited
 * value to rely on and the rung is part of what each of them is. This is a different ladder: `DisplayOrder`
 * orders whole `ScreenGui`s against each other and it wins outright, so a pixel drawn by the GUI at `1` is
 * drawn over every pixel of the GUI at `0`, whatever either tree's `ZIndex` says. That is exactly what a
 * full-screen splash needs, and exactly why one cannot be built out of the shared GUI's tree.
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
 * - `ScreenInsets` from {@link edgeAnchoredInsets} — **the safe area on a mobile client, the screen's own
 *   origin on a desktop one**, which is the device half of the rule at the top of this file. On a mobile client
 *   `y = 0` is the first pixel below Roblox's chrome, not the true top of the viewport. This is deliberate: a
 *   HUD element pinned at `y = 0` should sit *under* the topbar, not behind it, so nothing the player needs to
 *   read is occluded by Roblox's own UI. The cost there is that negative `y` values land in chrome the GUI does
 *   not draw into, and `Scale` fractions are measured against the safe region rather than the full viewport —
 *   so use `y = 0` as the top, and treat `YScale` as a fraction of `viewportHeight - topbarHeight`.
 *
 *   **On a desktop client the region is the screen, and both of those sentences read the other way.** The
 *   topbar is chrome this GUI now draws *under*, so a HUD element whose offset is measured from the top —
 *   {@link COLUMN_TOP_INSET} is the one in this file — is drawn behind Roblox's own UI rather than below it.
 *   That is the desktop half of the rule working as written rather than a bug in that number, and it is worth
 *   knowing before reading a desktop screenshot as a regression.
 */

export function getHudScreenGui(): ScreenGui {
	// `PlayerGui` is not a typed member of `Player` in these typings (nor is `Backpack`), so it is
	// found like any other child and the cast names the class rather than guessing it.
	const playerGui = Players.LocalPlayer.WaitForChild("PlayerGui") as PlayerGui;

	// One read, used by both branches below. See `edgeAnchoredInsets` for why the device test is a function
	// rather than an `if` written out twice.
	const insets = edgeAnchoredInsets();

	// By name first, then checked for class: a `Folder` somebody happened to call `HudGui` is not
	// this GUI, and falling through to create the real one is the right answer. The same two-step
	// the round folder and the throw remotes already use.
	const existing = playerGui.FindFirstChild(GUI_NAME);
	if (existing?.IsA("ScreenGui")) {
		existing.ResetOnSpawn = false;
		reportDrift(existing, insets);
		existing.ScreenInsets = insets;
		return existing;
	}

	const gui = new Instance("ScreenGui");
	gui.Name = GUI_NAME;
	gui.ResetOnSpawn = false;
	gui.ScreenInsets = insets;
	gui.Parent = playerGui;

	reportCreated(gui, `the device gate — ${deviceSentence()}`);

	return gui;
}

/** The name of the GUI for HUD furniture measured from the screen's own corner rather than the gated region. */
const FULL_SCREEN_GUI_NAME = "FullScreenGui";

/**
 * Its rung on the `DisplayOrder` ladder: **`-1`, one below the HUD plane**, which is the whole reason this
 * constant exists rather than reusing `0`.
 *
 * **A whole-GUI ladder is the only way to be covered by a panel, and this GUI needs to be.** `ZIndex` orders
 * siblings inside one tree and says nothing across two `ScreenGui`s, so the readout column being drawn in a GUI
 * of its own would otherwise float *over* the shop and the inventory panel — which are mounted in
 * {@link getHudScreenGui} at `PANEL_Z_INDEX` and are the one thing in this client that must be able to cover
 * the screen. A negative rung puts these two readouts under everything the HUD draws, which is what a `ZIndex`
 * of `0` inside the shared GUI used to mean for them.
 *
 * **And it is still under both covers**, which is all any rung below the HUD plane has to promise: the splash
 * at `1` and the wipe at `2` cover this GUI exactly as they cover the rest.
 */
const FULL_SCREEN_DISPLAY_ORDER = -1;

/**
 * The `ScreenGui` for HUD furniture that has to be measured from **the screen's own top-left corner on every
 * device**, rather than from whatever region {@link getHudScreenGui} picks for this client.
 *
 * **Its one tenant is the round's readout column** — the score plate and the clock, both mounted through
 * {@link getHudColumn} — and the reason is the one thing about them that is not a HUD panel: they are pinned to
 * the *top edge of the screen*, and their position is the same number on every device. On a mobile client the
 * gated region starts below Roblox's chrome **and** below the device's cutouts, which on a phone puts those two
 * readouts a topbar-plus-notch lower than they sit on a desktop for no reason the player can see. They are the
 * one pair in this client that looked wrong on a phone *because* the gate was working as written, so the gate is
 * not asked — question 1 of the rule at the top of this file has an answer here: the number they are placed
 * with is a distance from the top of the screen.
 *
 * **Why a `ScreenGui` and not a child of the shared one, which is forced rather than chosen.** `ScreenInsets`
 * belongs to the `ScreenGui` and a child cannot opt out of its parent's, so there is no way to say "this tree's
 * `y = 0` is the screen's" from inside the HUD's tree. Same mechanism as the splash's, opposite requirement: a
 * cover must reach the screen's edges, and these two must be measured from it.
 *
 * **What this function used to be is why it is documented at this length: it was a copy of
 * {@link getHudScreenGui} that looked up the *same* `GUI_NAME`.** So it never made a second GUI — it found the
 * shared one, and then wrote `ScreenInsets.None` onto it. That is the create/find disagreement the rule at the
 * top of this file spends a paragraph forbidding, performed by a helper whose entire name promised a second GUI,
 * and it cost exactly what that paragraph says such a bug costs: **two writers of one property, last call wins**,
 * so on a mobile client the whole HUD's region depended on whether the dock or a HUD controller happened to run
 * last. It is a GUI of its own now, with a name of its own, and the only thing that writes its region is the
 * branch above.
 *
 * **Why not {@link getScreenSpaceGui}, which is `None` on the same terms.** That GUI's rule is narrower than
 * "no insets": its tenants are placed with *screen numbers* — a mouse position, an `AbsolutePosition` read off
 * the engine's own touch controls — and the readout column is placed as a fraction of its region like any other
 * HUD element. Same region, different reason, and this file's two questions are made of that difference. The
 * day one of the two needs a different `DisplayOrder` it also costs nothing to have kept them apart.
 *
 * **The cost, stated so it is not a surprise in a screenshot**: `y = 0` here is the true top of the screen, so
 * these two readouts are drawn *under* Roblox's chrome rather than below it — which on a desktop is the
 * decision {@link COLUMN_TOP_INSET} already recorded, now made on both devices. The column is centre-anchored,
 * so the one piece of that chrome with any width — the menu button in the top-left corner — clears it.
 */
export function getFullScreenGui(): ScreenGui {
	// `PlayerGui` is not a typed member of `Player` in these typings (nor is `Backpack`), so it is
	// found like any other child and the cast names the class rather than guessing it.
	const playerGui = Players.LocalPlayer.WaitForChild("PlayerGui") as PlayerGui;

	const insets = Enum.ScreenInsets.None;

	// By name first, then checked for class: a `Folder` somebody happened to call `FullScreenGui` is not
	// this GUI, and falling through to create the real one is the right answer. The same two-step
	// the round folder and the throw remotes already use.
	const existing = playerGui.FindFirstChild(FULL_SCREEN_GUI_NAME);
	if (existing?.IsA("ScreenGui")) {
		existing.ResetOnSpawn = false;
		reportDrift(existing, insets);
		existing.ScreenInsets = insets;
		existing.DisplayOrder = FULL_SCREEN_DISPLAY_ORDER;
		return existing;
	}

	const gui = new Instance("ScreenGui");
	gui.Name = FULL_SCREEN_GUI_NAME;
	gui.ResetOnSpawn = false;
	gui.ScreenInsets = insets;
	gui.DisplayOrder = FULL_SCREEN_DISPLAY_ORDER;
	gui.Parent = playerGui;

	reportCreated(gui, "None on both devices — its tenants are pinned to the screen's own top edge");

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
 * How far below the top of the region the column sits, in pixels. **Placeholder — 14.**
 *
 * **"The region" is the screen on every device now, and that is a change rather than a phrasing.** The column
 * used to be mounted in {@link getHudScreenGui}, whose region is the device gate's answer — the safe area on a
 * phone, the screen itself on a desktop — so this same number meant "below Roblox's chrome" on one and "below the
 * true top" on the other, and the readouts sat a topbar-and-notch lower on mobile than on a desktop. They are in
 * {@link getFullScreenGui} now: `y` here is a distance from the top of the **screen** on both, which is the only
 * reading of "the top of the screen" that can be the same picture on two devices. See that function for the
 * argument, for the bug it used to be, and for the one thing this costs — these readouts draw *under* Roblox's
 * chrome on a client whose topbar is opaque behind them. The column is centre-anchored, so the menu button in the
 * top-left corner clears it.
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

	// **The full-screen GUI rather than the shared one, and this is the line the two readouts' position hangs
	// off.** These are the only HUD elements in this client pinned to the *top edge of the screen* rather than
	// to a corner of the safe region, and on a phone the safe region starts a topbar-plus-cutout lower — which
	// read as "the timer and the score are too low on mobile" while the gate was doing exactly what it says.
	// The column is centre-anchored, so the screen's own top is where it belongs on both devices; see
	// `getFullScreenGui` for the region argument and for what this call used to do instead.
	frame.Parent = getFullScreenGui();

	column = frame;

	return frame;
}

/**
 * The `ScreenGui` a full-screen splash mounts into: the same find-or-create, with **no insets at
 * all**.
 *
 * **The difference from {@link getHudScreenGui}, and it is the whole point: that one is in whichever region
 * the device gate picks and this one is `None` on both devices.** `ScreenInsets` belongs to the `ScreenGui` and
 * applies to everything inside it, so a child of the shared GUI — however it is sized — can never draw into the
 * strip under Roblox's topbar, nor the strip the touch controls sit in on a phone. For a HUD that is right: the
 * strip is Roblox's chrome, and a panel that painted into it would be drawing where the GUI does not own. For an
 * image whose job is to *cover the screen* it is wrong in the opposite direction: a splash that stops a few
 * pixels below the top of the screen leaves a band of the game showing through it, which reads as broken rather
 * than as deliberate. **A cover is the one kind of thing the device gate must never reach**, because covering
 * the chrome is exactly what it is for and that is true on both devices — which is question 1 answering, so the
 * gate is not asked.
 *
 * **A second GUI rather than a setting on the first, and this is forced rather than chosen.** `Do not change
 * getHudScreenGui` is not a style rule: every HUD panel and controller in this client parents into it, the
 * region they get is the decision the gate at the top of this file makes, and nothing that mounts beside them
 * may move because a cover needed a different origin. The alternative — a flag on the helper, or the caller setting the property —
 * would put a screen-wide decision in the hands of whichever HUD mounted last.
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

	reportCreated(gui, "None on both devices — a full-screen cover has to reach the screen's edges");

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
 * GUI inherits the region the device gate picked for it, and `ScreenInsets` belongs to the `ScreenGui`:
 * a child cannot paint the strip under Roblox's topbar however it is sized, so on a mobile client the
 * grid would leave a band of the game showing along the top and another along the bottom. That is the
 * same failure the splash's doc describes, and it reads as broken rather than as deliberate in both
 * cases. **It is `None` on both devices**, by the splash's argument.
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

	reportCreated(gui, "None on both devices — a full-screen cover, by the splash's argument");

	return gui;
}

/**
 * The name of the GUI the client's **screen-space** elements are drawn in, and its rung on the
 * `DisplayOrder` ladder.
 *
 * **Zero, which is the HUD's own rung, and that is a deliberate choice rather than a leftover.** Both
 * of this GUI's contents belong on the HUD plane rather than on the covers' — the splash at `1` and the
 * wipe at `2` must both be able to hide them, and a cover that left a crosshair or a ring of controls
 * floating over it would be the one thing a full-screen cover is for — so the only rungs they can take
 * are `0` and below. `0` is the one that needs no new rung and no argument in this file's ladder: the
 * two GUIs at that value do not overlap (the HUD's elements are all anchored to an edge, and these are
 * not anchored at all), so which of them paints first is unobservable.
 */
const SCREEN_SPACE_GUI_NAME = "ScreenSpaceGui";
const SCREEN_SPACE_DISPLAY_ORDER = 0;

/**
 * The `ScreenGui` the client's screen-space elements mount into: the same find-or-create, and **`None`
 * insets because these are the only elements in the client whose positions are screen positions.**
 *
 * **The reason is the one place where "region versus offset" catches something rather than explaining it.**
 * On a mobile client `getHudScreenGui` puts its contents inside the safe area — below Roblox's topbar and
 * inside the cutouts — and that is right for everything whose position is a fraction of the region it is in.
 * A mark at `(0.5, 0.5)` of that region is not at the middle of the screen: it is half a topbar lower, which on
 * a phone is a finger's width and is exactly the amount by which a crosshair would be off the line the throw
 * goes down. The alternative was to place the mark in the shared GUI by subtracting the inset — arithmetic that
 * has to be redone on every viewport change, that is only right while the shared GUI's own `ScreenInsets` is
 * what you think it is, and that **the device gate would have made conditional as well**: the shared GUI insets
 * on a phone and does not on a desktop, so one subtraction would be right on one of the two and wrong on the
 * other. A GUI that does not inset has no such question, so anything positioned in screen coordinates has one.
 *
 * **This is the rule's counter-example read from the mobile side**: the aim sight is drawn on a *touch* client,
 * into this GUI, and deliberately `None` there — see the rule at the top of this file for why question 1 beats
 * question 2 in that case.
 *
 * **Its second tenant is what turned "the sight's GUI" into "the screen-space GUI"**, and the shared reason is
 * worth stating once rather than twice: the mobile control ring has to sit *on the engine's jump button*, which
 * is a screen-space object in the engine's own `TouchGui`. Every number that can describe where that button is
 * — `AbsolutePosition`, `AbsoluteSize` — is in screen pixels, so the ring can only be placed with them in a GUI
 * that starts at the screen's own origin. Both tenants are here for the same reason and neither could be
 * anywhere else, which is the difference between one shared GUI and one GUI per feature.
 *
 * **A `ScreenGui` for two small elements is not the "GUI per feature" that `getHudScreenGui` argues against.**
 * That argument is about *panels* — corners, cards, a window's worth of contents — and these are instances with
 * fixed positions that must be outside the safe region; there is no smaller home for them, since `ScreenInsets`
 * belongs to the `ScreenGui` and a child cannot opt out of its parent's.
 *
 * **And it is not the fourth GUI this file deleted, which was the round board's.** That one existed to give a
 * *panel* insets of its own — a thing that wanted the safe region and got three different answers — where this
 * is the opposite case: elements that must *not* be inset. Same mechanism, opposite requirement.
 */
export function getScreenSpaceGui(): ScreenGui {
	const playerGui = Players.LocalPlayer.WaitForChild("PlayerGui") as PlayerGui;

	const existing = playerGui.FindFirstChild(SCREEN_SPACE_GUI_NAME);
	if (existing?.IsA("ScreenGui")) {
		existing.ResetOnSpawn = false;
		existing.ScreenInsets = Enum.ScreenInsets.None;
		existing.DisplayOrder = SCREEN_SPACE_DISPLAY_ORDER;
		return existing;
	}

	const gui = new Instance("ScreenGui");
	gui.Name = SCREEN_SPACE_GUI_NAME;
	gui.ResetOnSpawn = false;
	gui.ScreenInsets = Enum.ScreenInsets.None;
	gui.DisplayOrder = SCREEN_SPACE_DISPLAY_ORDER;
	gui.Parent = playerGui;

	reportCreated(gui, "None on both devices — its tenants are placed by screen numbers, so question 1 answers");

	return gui;
}

/**
 * The name of the GUI the mobile movement stick is drawn in.
 *
 * **`CoreUISafeInsets` on the mobile client it exists on, and that is the whole reason this GUI exists as one of
 * its own.** A touch is reported in the space of the safe region — the screen minus Roblox's topbar and the
 * device's cutouts — which is the space a `CoreUISafeInsets` `ScreenGui` uses, and it is the mobile client's
 * default. **A ring drawn in a `ScreenInsets.None` GUI is therefore being placed with numbers that come from a
 * different origin, and it lands one inset up and to the left of the thumb** — which is what "the joystick is off"
 * turned out to mean, and what a long hunt went looking for in the arithmetic. **Matching the GUI to the space the
 * input is in removes the arithmetic rather than cancelling it**: a touch position and a ring `Position` are then
 * the same kind of number, and the joystick controller has no conversion left to get wrong.
 *
 * **It asks the device gate like the HUD does, and the honest description of that is "for the rule's sake".** A
 * touch exists only on a mobile client, so on a desktop this GUI's region is unobservable — and unreachable with
 * it, because `TouchJoystickController` is the only caller of {@link getStickScreenGui} and it returns before
 * mounting anything when `isMobile()` is false. Nothing on a desktop client creates this GUI at all. It follows
 * the gate anyway, so that "the GUIs placed as fractions of their region follow the device" stays one sentence
 * with no exception to remember — and so that the two GUIs beside each other in this file do not answer the same
 * question two ways.
 *
 * **What must never happen is this value changing while the ring is mounted, and the arithmetic is why.**
 * `TouchJoystickController.applyGeometry` derives the base's home position from `GuiService:GetGuiInset()`'s two
 * corners and then draws it from *this* GUI's own origin — two numbers that are in the same space only while this
 * GUI insets. A desktop client calling this accessor would get a ring one inset up and to the left of the corner
 * its home is a fraction of, which is the bug this whole pass fixed, arrived at from the other side. `platform.ts`
 * is what makes that impossible today (a client does not change platform mid-session), and an eighth caller with
 * a different idea about the device is what would break it.
 *
 * **Why not `getHudScreenGui()`, which is inset on the same client.** Consequence rather than taste: that GUI
 * carries every panel, plate and readout in this client, and a HUD in it is positioned against whatever its
 * `ScreenInsets` happen to be. Nothing else may move because the stick needed a different origin — and the day the
 * joystick's GUI and the HUD's want to be the same GUI is the day somebody has to be sure they agree, which is a
 * question worth never asking.
 */
const STICK_GUI_NAME = "StickGui";

/**
 * The stick GUI's rung on the `DisplayOrder` ladder: `0`, the HUD plane.
 *
 * Only `0` or below is available, for the reason {@link getScreenSpaceGui} gives about its own rung — the splash at
 * `1` and the wipe at `2` must be able to cover a control — and of those, `0` is the one that needs no new rung:
 * the ring is HUD furniture and it should sit on the same plane as the rest of it.
 */
const STICK_DISPLAY_ORDER = 0;

/**
 * The `ScreenGui` the movement stick's ring, thumb and movement zone mount into: the same find-or-create, and
 * **inset on the touch client it is used on, because a touch is reported in the inset region's space.**
 *
 * **Three objects, one GUI, and that is the point.** The ring, the dot inside it and the pad that sinks the zone
 * are three answers to one question — *where is this touch?* — so they are in one coordinate space and one
 * `ScreenGui`, and the only ordering they need is `ZIndex` among siblings, which is a mechanism that works exactly
 * in that case and not across two GUIs. See `TouchJoystickController` for what the space is used for; the summary is
 * that `InputObject.Position` is used untouched, everywhere.
 *
 * **The gate is asked, and on the client that uses this GUI its answer *is* the coordinate requirement rather
 * than a preference** — the whole of what {@link STICK_GUI_NAME} argues. Both branches below write the same read,
 * for the reason {@link edgeAnchoredInsets} gives.
 */
export function getStickScreenGui(): ScreenGui {
	const playerGui = Players.LocalPlayer.WaitForChild("PlayerGui") as PlayerGui;

	// The same one read as the HUD's, and on the client that uses this GUI it resolves to `CoreUISafeInsets`. On a
	// desktop it would resolve to `None` — unobservable, because nothing there makes this GUI at all. See
	// `STICK_GUI_NAME` for why the value must not move while the ring is mounted.
	const insets = edgeAnchoredInsets();

	const existing = playerGui.FindFirstChild(STICK_GUI_NAME);
	if (existing?.IsA("ScreenGui")) {
		existing.ResetOnSpawn = false;
		reportDrift(existing, insets);
		existing.ScreenInsets = insets;
		existing.DisplayOrder = STICK_DISPLAY_ORDER;
		return existing;
	}

	const gui = new Instance("ScreenGui");
	gui.Name = STICK_GUI_NAME;
	gui.ResetOnSpawn = false;
	gui.ScreenInsets = insets;
	gui.DisplayOrder = STICK_DISPLAY_ORDER;
	gui.Parent = playerGui;

	reportCreated(gui, `the device gate — ${deviceSentence()}`);

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
 * moving into this file's column. **A `ScreenGui` of its own earns its name only when a thing has to draw where
 * the HUD's contents must not** — the two covers, which must paint Roblox's chrome rather than respect it, the
 * aim sight, whose position is a screen number, and the stick, whose touch arrives in the safe region's space.
 * Those four are why four GUIs exist beside the shared one, and each of them is argued at its own accessor.
 * **It is never the way to reposition one of the HUD's own panels.**
 */
