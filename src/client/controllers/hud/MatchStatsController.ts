import Fusion from "@rbxts/fusion-3.0";
import Net from "@rbxts/net";
import { ContextActionService, ReplicatedStorage } from "@rbxts/services";
import { ROUND_MODE_ATTRIBUTE, ROUND_SCORE_A_ATTRIBUTE, ROUND_SCORE_B_ATTRIBUTE, ROUND_STATUS_FOLDER } from "shared/constants";
import { SHOP_CONFIG } from "shared/config/shop.config";
import { isGameModeId, sideNameOf, teamColourOf } from "shared/gameMode";
import type { GameModeId } from "shared/gameMode";
import type { MatchStatsRow } from "shared/matchStats";
import { events } from "shared/networking";
import { LOGGING_ENABLED, logInfo, logWarn } from "shared/logger";
import { Controller, OnStart } from "@flamework/core";
import {
	addContentBand,
	addFooterBand,
	addHeaderBand,
	addPanelFrame,
	mountPanel,
	PANEL_Z_INDEX,
	panelSheet,
	raiseZIndex,
	withCommas,
} from "../../ui/panelChrome";
import { lightPanelTheme } from "../../ui/lightPanelTheme";
import type { HudTheme } from "../../ui/hudTheme";
import { getHudScreenGui } from "../../ui/screenGui";

/** The typed client side of the remote, named the way `ShopController` names its own. */
type ClientRemotes = Net.Util.GetClientRemotes<Net.Util.GetDeclarationDefinitions<typeof events>>;

/** Whatever the OS reports for the key labelled `Tab`. */
const KEY = Enum.KeyCode.Tab;

/** The action name, so the binding is findable by the same name `ContextActionService` holds. */
const ACTION_NAME = "MatchStatsBoard";

/**
 * The column headers, and the width each one takes — **the whole of the table's geometry in one place.**
 *
 * **Fractions rather than pixels, which is `panelChrome`'s rule for the same reason**: the panel's own width is
 * a fraction of the viewport, so a pixel column would be right on one screen and wrong on the next. The name
 * gets the largest share because names are the only column whose contents have no fixed length; the five
 * numbers share the rest evenly, which is what makes two rows comparable at a glance.
 *
 * They are written as one table rather than as six constants so that a column cannot be added to the headings
 * and forgotten in the row.
 */
const COLUMNS: ReadonlyArray<{ readonly heading: string; readonly width: number; readonly left: boolean }> = [
	{ heading: "NAME", width: 0.3, left: true },
	{ heading: "POINTS", width: 0.16, left: false },
	{ heading: "HITS", width: 0.135, left: false },
	{ heading: "THROWS", width: 0.135, left: false },
	{ heading: "CATCHES", width: 0.135, left: false },
	{ heading: "DODGES", width: 0.135, left: false },
];

/** One row's height in pixels, and the vertical gap between rows. **Placeholder.** */
const ROW_HEIGHT = 26;
const ROW_GAP = 2;

/**
 * **The two sentences an empty board can say, and they are different sentences on purpose.**
 *
 * A board with no rows is one of two states that look identical and have nothing in common: **the server has
 * not answered yet**, or **the server answered and nobody is on a side**. The first is a round trip, the second
 * is an intermission that has not filled, and only one of them is a fault. The first version of this panel had
 * one sentence for both, which is why four sessions of *"the board is empty"* could not say which state the
 * player was looking at — the panel knew, and did not say.
 *
 * **So the waiting line means "no answer yet" and only that**, and it is replaced the moment any answer lands.
 * A player who sees the second sentence knows the panel works and the round has not started; a player who sees
 * the first for more than a moment is looking at a board that is not being answered, which is a different
 * report and a different file.
 */
const WAITING_TEXT = "Waiting for players…";
const NOBODY_TEXT = "Nobody is on a side yet.";

/**
 * **What a side's heading shows where its score should be, when the round has not published one** — an em-dash,
 * and it is a third empty state rather than a variant of the other two.
 *
 * `WAITING_TEXT` and `NOBODY_TEXT` are about *rows*; this is about one number on a heading that is drawn whether or
 * not there are rows. The three arrive from different places — a round trip that has not landed, an answer that
 * says the lobby is empty, and a `RoundStatus` folder whose `ScoreA`/`ScoreB` is absent or not a number — so a
 * reader who sees one of them knows which file to open. See `headingText`, which is where this is spent, and
 * `scoreOn`, which is what distinguishes it from a real `0`.
 */
const NO_SCORE_TEXT = "—";

/** How tall one side's heading is, in pixels. **Placeholder.** */
const SIDE_HEADING_HEIGHT = 22;

/**
 * **Three 4-pixel bars in primary colours, one inside each frame the board can disappear in, and their whole
 * purpose is to be found or not found by a person looking at the screen.**
 *
 * A number in the output cannot answer "is this drawn where you are looking" — the session that produced
 * `panel 664×398, content 664×314, rows frame 644×270 (visible yes)` and `drew 8 of 8` had every size it needed
 * and no way to know whether those pixels were on the player's screen, behind another `ScreenGui`, or under an
 * opaque sibling. **Red at the top of the panel, green at the top of the content band, blue at the top of the
 * scrolling area** is a question a person can answer by looking, and the answer says which depth is wrong:
 *
 * - **none of them** — the panel is not on screen at all, and the `geometry` line's `AbsolutePosition`, parent
 *   class and `DisplayOrder` say why;
 * - **red only** — the panel draws and the content band inside it does not;
 * - **red and green, no blue** — the rows frame specifically is the one with nothing in it;
 * - **all three, no rows** — the rows exist and their ink or their height does not;
 * - **all three and rows** — the board was never broken and every report was about the moment before an answer.
 *
 * **`LayoutOrder = -1`, so each bar is the first thing its layout stacks** — the frames they live in are all
 * managed by a `UIListLayout`, which *positions* its children and overrides `Position`. First is the top, which
 * is where a 4-pixel marker is least in the way and most visible. `ZIndex = 100` puts each above the panel's own
 * furniture (`PANEL_Z_INDEX` is 10), so nothing a panel draws can hide it.
 *
 * **Diagnostic, and switched off — see {@link SHOW_MARKERS} for the answer they produced and for why they are
 * kept rather than deleted.** They also left one fact behind that outlived them: each bar is a `(1, 0, 0, 4)`
 * child of a frame with a list layout, and each one shifted its siblings down by four pixels, which is the
 * working proof that this panel cannot host a full-size decorative child. {@link paintSheet} rests on it.
 */
const MARKER_PANEL = "_MarkerPanel";
const MARKER_CONTENT = "_MarkerContent";
const MARKER_ROWS = "_MarkerRows";
const MARKER_HEIGHT = 4;
const MARKER_Z_INDEX = 100;

/**
 * **The tiled backdrop for this panel, as an uploaded image id — `undefined` until somebody draws the art.**
 *
 * `addPanelFrame` takes this as its optional `pattern`, and the moment it is a real `rbxassetid://…` the sheet
 * gains an `ImageLabel` at `ScaleType.Tile`, `TileSize` 16×16, `ImageTransparency = 0.85`, sitting between the
 * sheet's fill and everything written on it. **`undefined` is a supported state rather than a gap**: the panel
 * then wears the gradient from {@link paintSheet} and nothing else, which is what it does today.
 *
 * **What the art has to be, because getting it wrong is silent.** A **16×16 PNG**, dots on a **transparent
 * background**, uploaded and referenced by its `rbxassetid://…`. Three traps, all of them measured in this project
 * already:
 *
 * - **Keep the alpha channel.** `images.config.ts` records that a flattened export (`Format24bppRgb`) drew a white
 *   box around every ability icon on a surface that was otherwise empty; the same export here is a solid white
 *   tile, i.e. a panel with no pattern at all.
 * - **Alpha-bleed it.** Roblox sets *fully transparent* pixels to **black** on upload, and this layer is drawn at
 *   `ImageTransparency = 0.85` — so an un-bled tile lays a uniform 15% black veil over the sheet. A "dirty grey
 *   panel" is that bug, not a taste verdict.
 * - **16×16 exactly.** `TileSize` is `PATTERN_TILE` in `panelChrome`, so art of any other size is stretched to the
 *   tile and the dots come out oval.
 *
 * **Deliberately not a constant in `shared/config/images.config.ts`**, where the other ids live: that file's record
 * is keyed by feature and documents each id's provenance, and this one does not exist yet. It moves there with the
 * id when it does, beside `LOADING_LOGO`.
 */
const PATTERN_TEXTURE: string | undefined = undefined;

/**
 * **Whether the three bars are drawn at all — and it is `false`, because they have done their job.**
 *
 * The session that settled the six-pass bug saw **all three**: the red bar under the title, the green bar under
 * the column headings, and the blue bar across the top of the white area — with nothing between the blue bar and
 * the footer. That is the fourth of the five answers these were built to collect, and it led straight to
 * `ZIndex`: every element `mount` creates is flattened to `10` by `raiseZIndex`, and every element a *press*
 * creates was left at the default `1` and drawn behind the panel's opaque sheet. See {@link addRow}.
 *
 * **Turned off in the session that fixed the background**, because a red, a green and a blue bar across a panel
 * are exactly what a person cannot look past when the question has become "does this look like it belongs in the
 * game". The `addMarker` bar it guards is kept — one line to bring back, and the paragraph above is the only
 * record of what each colour asks — but nothing it draws is in the panel now.
 */
const SHOW_MARKERS = false;

/** The sides, in the order they are drawn — the same `A` then `B` order every other list uses. */
const SIDES: ReadonlyArray<string> = ["A", "B"];

/**
 * The in-match stats board: **who is doing what, this round, grouped by side and ranked by points.**
 *
 * **Held, not toggled, and that decision is `Tab`'s rather than this file's.** The key is a glance — the thing
 * a player presses to see the state of the match and lets go of to play again — and a toggle would need a
 * second press to get out of a panel that is covering the game, which is the interaction `ShiftLock`'s own
 * hold-to-aim avoids. It also makes the key's lifetime the panel's lifetime, so there is no state to be stuck
 * in: `InputEnded` is the close, and a released key cannot leave a panel open.
 *
 * **`ContextActionService` rather than `UserInputService`, and this is the opposite of what `returnToLobby`
 * does.** That file *observes* `L` so the same press keeps walking, because a movement key answering to two
 * readers is the whole point. `Tab` has one other claimant — **Roblox's own player-list CoreScript** — so this
 * binding is **claimed** with `Sink`, which is what makes the press this panel's and gives this file the
 * `Begin`/`End` pair a hold needs. **The first version passed instead, on the argument that the key belonged to
 * nobody else; the symptom was `Tab` opening the leaderboard.** `CoreGuiController` still removes that list
 * through both of the engine's levers, and sinking is what keeps the panel independent of whether the removal
 * took — see {@link bindKey}. A bound action also does not fire while a text box has focus, so a player typing a
 * line with a tab in it keeps their chat.
 *
 * **The style is the Shop's and the Inventory's**, because a third panel in a different idiom would be a third
 * thing to learn: `lightPanelTheme` for the paper, `addPanelFrame` for the sheet, its corner, its hairline and
 * its one shadow, and `addHeaderBand`/`addContentBand`/`addFooterBand` for the three strips. **What is not
 * shared is the shelf**: `addShelf` and `addTile` are a grid of fixed cards, and a board is rows of text whose
 * number changes every time it opens. See {@link render}, which is the one place this file builds instances
 * rather than reusing them.
 *
 * **The rows are rebuilt on every open, and that is a deliberate departure from these panels' rule.** The shop
 * builds once and only changes properties, because its contents are static and big-ui takes its props at
 * construction. A board's contents are *scores* — a different row count, order and set of numbers on every
 * press — so a property-only update would mean a Fusion value per cell for six columns of a variable roster.
 * Rebuilt into a container that is emptied first, the cost is a handful of `TextLabel`s per press on a key a
 * player holds for a moment, and nothing accumulates: see {@link render}.
 */
@Controller()
export class MatchStatsController implements OnStart {
	private scope = Fusion.scoped();
	private mounted = false;

	/** Whether the board is on screen. Written by the key binding, read by the panel's `Visible`. */
	private open = Fusion.Value(this.scope, false);

	/**
	 * The two remotes, resolved once at mount rather than on the first press.
	 *
	 * **`Get` yields** until the server's remote exists, and a yield inside a key handler is a frame of nothing
	 * happening after a press — the trap `ShopController.watchChest` names. Resolved from the spawned mount
	 * thread, which is already the thread that may wait. **Both** are resolved, not just the one that is sent:
	 * the answer's connection is made here too, so a press before the listener was up cannot lose its reply.
	 */
	private request?: ClientRemotes["matchStats"];

	/** The server's answer. See {@link request} for why both halves are resolved at mount. */
	private answer?: ClientRemotes["matchStatsBoard"];

	/** Where the rows go. Everything the board draws lives inside it, including the "nobody" line. */
	private rows?: ScrollingFrame;

	/**
	 * **The empty state, and it is a sibling of the list rather than a child of it** — which is the correction
	 * a report bought.
	 *
	 * It used to be a label appended to the scrolling frame, so that one clearing loop emptied the panel of
	 * rows *and* of the line explaining there were none. The reasoning was sound and the placement was not: a
	 * `ScrollingFrame` in a flex row has no height of its own until the layout gives it one, so a label inside
	 * it inherits that frame's size — and a board that drew nothing had nothing on screen to say why, which is
	 * indistinguishable from a board that never got an answer at all. **The empty state is the one thing on this
	 * panel that must be visible when the rest of it is not**, so it lives beside the list, in the content band,
	 * where nothing about the scrolling arrangement can hide it.
	 */
	private empty?: TextLabel;

	/**
	 * **Whether any answer has ever arrived**, which is the only difference between the panel's two empty states.
	 *
	 * See {@link WAITING_TEXT}: a board that has never been answered and a board answered with nought are the
	 * same pixels and different faults, and this flag is what lets the sentence say which. It is written by
	 * `receive` and read by `render`, so a panel opened before the first answer and re-opened after it says two
	 * different things without a single extra instance.
	 */
	private answered = false;

	/** The last answer, so a re-open draws instantly rather than emptying while the round trip runs. */
	private last: ReadonlyArray<MatchStatsRow> = [];

	/** The panel and its content band, held **only so a diagnostic can print their sizes** — see {@link probe}. */
	private panel?: Frame;
	private content?: Frame;

	/**
	 * The request whose answer has not arrived, as the `os.clock()` it was sent at, or `0` for none — **the
	 * stamp that lets {@link refresh}'s timer tell a late answer from a lost one, and one press from the next.**
	 */
	private awaitingSince = 0;

	/** Whether {@link probeRow} has said where the first row landed. **Once per session** — it is a rectangle. */
	private rowProbed = false;

	/**
	 * **One line, once, a second after mount, saying where every frame between the screen and a row actually
	 * is** — position as well as size, which is what the first version of this probe was missing.
	 *
	 * The board can be invisible at exactly five depths and they are indistinguishable from a screenshot: the
	 * **panel** not on screen or behind another `ScreenGui`, the **content band** with no height, the **rows
	 * frame** with no height, the **rows** with no height or no ink, and the **empty label** with no height —
	 * which the session that produced `empty 0×0` proved is a real state. `AbsoluteSize` is read rather than
	 * `Size` because every one of those but the panel is a scale of its parent: the declared sizes are all
	 * plausible and only the resolved pixels say whether anything is there.
	 *
	 * **`AbsolutePosition` is the number that was never in a log, and without it "the panel is empty" cannot be
	 * told from "the panel is off the right edge of the screen."** A size of `664×398` says the layout ran; it
	 * says nothing about whether those pixels are on a screen the player is looking at. So this prints the
	 * panel's corner, and its parent's class, name, `Enabled` and `DisplayOrder`: a `ScreenGui` that is
	 * disabled, or one rung below another full-screen GUI, draws nothing whatever its children say.
	 *
	 * **A second after mount rather than on the spot**, because the panel is parented at the end of `mount` and
	 * a layout pass has not run on the frame it arrives on — read there, every number would be the one from
	 * before the tree existed, which is the direction that lies.
	 *
	 * **Deliberately unconditional and deliberately not behind `DEBUG_LOGGING`.** It is a handful of numbers once per
	 * session, and the entire cost of the five sessions before this one was that the numbers were not in the
	 * output.
	 */
	private probe(): void {
		task.spawn(() => {
			task.wait(1);

			const panel = this.panel;
			const content = this.content;
			const list = this.rows;
			const empty = this.empty;

			// **The parent chain, read as facts rather than assumed.** `getHudScreenGui` returns `HudGui`, whose
			// `DisplayOrder` is the engine default of `0` — the rung every other HUD and the shop panel share —
			// so a panel "behind something" is not a `ZIndex` story unless a sibling inside that GUI outranks
			// it. Printing both halves is what tells those apart.
			//
			// **Two hops now, not one.** `this.panel` is the `Content` frame the bands stack in, so its parent is
			// the *sheet* — the visible rectangle — and the sheet's parent is the `ScreenGui`. Reading one hop
			// and stopping would have reported `parent Frame "MatchStatsPanel"` and quietly dropped the
			// `Enabled`/`DisplayOrder` half of the line, which is the half that answers "is this on screen".
			const sheet = panel !== undefined ? panelSheet(panel) : undefined;
			const parent = sheet?.Parent;
			const parentIsGui = parent !== undefined && parent.IsA("ScreenGui");

			logInfo(
				`[Stats] geometry — sheet at ${this.px(sheet?.AbsolutePosition.X)}` +
					`,${this.px(sheet?.AbsolutePosition.Y)} size ${this.px(sheet?.AbsoluteSize.X)}` +
					`×${this.px(sheet?.AbsoluteSize.Y)}, visible ${sheet?.Visible === true ? "yes" : "no"}` +
					`, ZIndex ${sheet?.ZIndex ?? -1}` +
					`, parent ${parent?.ClassName ?? "none"} "${parent?.Name ?? "-"}"` +
					(parent !== undefined && parent.IsA("ScreenGui")
						? ` enabled ${parent.Enabled ? "yes" : "no"} DisplayOrder ${parent.DisplayOrder}`
						: "") +
					`, content at ${this.px(content?.AbsolutePosition.X)},${this.px(content?.AbsolutePosition.Y)}` +
					` size ${this.px(content?.AbsoluteSize.X)}×${this.px(content?.AbsoluteSize.Y)}` +
					`, rows frame at ${this.px(list?.AbsolutePosition.X)},${this.px(list?.AbsolutePosition.Y)}` +
					` size ${this.px(list?.AbsoluteSize.X)}×${this.px(list?.AbsoluteSize.Y)}` +
					` (declared ${list?.Size.Y.Scale ?? -1} scale ${list?.Size.Y.Offset ?? 0} px, visible ` +
					`${list?.Visible === true ? "yes" : "no"})` +
					`, empty at ${this.px(empty?.AbsolutePosition.X)},${this.px(empty?.AbsolutePosition.Y)}` +
					` size ${this.px(empty?.AbsoluteSize.X)}×${this.px(empty?.AbsoluteSize.Y)}` +
					` (visible ${empty?.Visible === true ? "yes" : "no"}, text "${empty?.Text ?? ""}")`,
			);

			// **And the first row, which is the one thing the sizes above cannot speak for.** No row exists
			// until a press, so this half prints on the first press's answer rather than here — see
			// {@link probeRow}, called from `renderBody`.
			this.probeRow();

			// **The parent's `ScreenInsets` is the other way a tree can be laid out and never seen.** On a
			// desktop client it is the screen's own origin; on a phone it is the safe region, and a panel
			// centred in a region narrower than the device is a panel the player may not be looking at.
			if (parentIsGui) {
				const gui = parent as ScreenGui;
				logInfo(
					`[Stats] screen gui — ${gui.Name}: ScreenInsets ${tostring(gui.ScreenInsets)}` +
						`, AbsoluteSize ${gui.AbsoluteSize.X}×${gui.AbsoluteSize.Y}` +
						`, children ${gui.GetChildren().size()}`,
				);
			}
		});
	}

	/** Rounds for the log: a resolved pixel read six times to five decimal places is unreadable. */
	private px(value: number | undefined): string {
		return string.format("%.0f", value ?? -1);
	}

	/**
	 * **The sheet's paper: a soft wash from white at the top to the theme's card tone at the bottom, and the whole
	 * of why the requested *dotted* pattern is not here.**
	 *
	 * The request was a tiled `ImageLabel` — `ScaleType = Tile`, `TileSize` 16×16, a `_DotPattern` inside the
	 * panel — which is the right technique for a dot grid in Roblox and is also the one this panel cannot take.
	 * **Three reasons, in the order they matter:**
	 *
	 * - **A full-size `GuiObject` child of this panel is eaten by the panel's own `UIListLayout`.** The panel
	 *   stacks its bands with a list layout, and a list layout positions *every* `GuiObject` child and reserves
	 *   its height while doing it. A pattern sized `(1, 1)` would therefore consume the panel's entire height and
	 *   push the header, the content band and the footer off the bottom of the screen. That is not a theory: the
	 *   three diagnostic bars added in item 62 are `(1, 0, 0, 4)` children of these same frames and each of them
	 *   shifted the layout down by exactly four pixels, which is visible in the screenshot that closed that bug.
	 *   **A modifier is not a child** — `UIGradient` is a `UIComponent` like the `UIShadow` the panel already
	 *   wears, it takes part in no layout, and `raiseZIndex` does not see it.
	 * - **There is no dot texture in this repository.** `assets/` holds three ability PNGs and nothing else, no
	 *   `ScaleType.Tile` is used anywhere in `src/`, and `IMAGES_CONFIG` has the logo and the three icons. The
	 *   request's fallback — `rbxassetid://0`, with a comment saying it is a placeholder — **renders nothing at
	 *   all**, so shipping it would satisfy the shape of the change and none of its purpose: the panel would look
	 *   exactly as bland as it does now, and the next reader would have to prove that before believing it.
	 * - **A gradient cannot be made into a lattice either, and that is now checked against the typings rather than
	 *   remembered.** These typings' `UIGradient` is the modern one: `Type` is
	 *   `Linear | Radial | Conical`, `TileMode` is `Clamp | Repeat | Mirror`, and `Scale` multiplies how much of
	 *   the sequence is visible. **Every combination of those repeats in one direction**: `Linear` + `Repeat`
	 *   gives stripes, `Radial` + `Repeat` gives concentric rings about the element's centre, `Conical` + `Repeat`
	 *   gives wedges. A *dot grid* needs two directions at once, and one `UIComponent` has one direction — there is
	 *   no second gradient to multiply it with, because two `UIGradient`s on one object is one `UIGradient`.
	 *   So the honest list of ways to a dotted sheet is: a tiled image, a few dozen `Frame`s, or a stripe pattern
	 *   standing in for dots — and the first is blocked above, the second is refused below, and the third is not
	 *   what was asked for.
	 * - **A texture would need art that this project's own notes say is easy to get wrong.** `images.config.ts`
	 *   records that Roblox sets fully transparent pixels to **black** on upload, so a naive dot tile at
	 *   `ImageTransparency = 0.9` would lay a uniform 10% black veil over the whole sheet — a dirty grey panel
	 *   rather than a pattern — unless the source PNG keeps its alpha *and* gets an alpha-bleed pass. That is a
	 *   drawing job, not a code one, and it should not be disguised as a code change.
	 *
	 * **And the procedural grid was rejected on the request's own instruction, which is right.** A dot every 16
	 * pixels on a 664×398 sheet is 41 × 25 = 1,025 `Frame`s built once and never destroyed, to draw something a
	 * 16×16 PNG would draw with one instance. The count is what decides it rather than the principle: this panel
	 * already rebuilds eight rows of six labels on every press and that is affordable because it is ~50
	 * instances; a thousand is not the same decision.
	 *
	 * **What is here instead: three stops of the panel's own palette**, `panel` → `surface` → `card`, top to
	 * bottom. It is the depth the request's own fallback asked for, it needs no asset, it costs one instance, and
	 * it cannot move anything on the panel. `Rotation = 90` runs it top-to-bottom; `UIGradient` rotates
	 * clockwise, so `0` would run left-to-right and `90` is the vertical one.
	 *
	 * **`Color` multiplies the frame's `BackgroundColor3`, which is why the numbers read as the palette's.** The
	 * sheet is pure white (`theme.colors.panel`), so white × any stop is that stop exactly — the gradient is not
	 * tinting an off-white base into something else, it is the base. And because it applies to the panel's own
	 * fill rather than to its descendants, the near-black ink of the rows is untouched.
	 *
	 * **Two things that would unlock the real thing, both deliberately not done here.** A `pattern?: string`
	 * argument on `addPanelFrame` that inserts the texture *outside* the band layout would be the honest fix, and
	 * it is a change to `panelChrome.ts` — which this task forbids. The other is a mirror frame in the HUD
	 * `ScreenGui` behind the panel, with the sheet's white moved onto it so the pattern shows through; that needs
	 * a copy of the panel's anchor, size **and** its `UISizeConstraint` to stay aligned on every viewport, and a
	 * shadow that no longer sits where it was put. **Two authorities on one rectangle**, which is the shape of
	 * every layout bug this file has already had.
	 */
	private paintSheet(panel: Frame): void {
		// **The gradient goes on the sheet, not on the frame passed in, and that is the two-frame structure
		// showing through.** `addPanelFrame` returns the `Content` frame the bands stack in, and that frame's
		// `BackgroundTransparency` is `1` — a `UIGradient` on it would paint a gradient onto nothing. The visible
		// rectangle is its parent, which is why `panelSheet` exists.
		const sheet = panelSheet(panel);
		if (sheet === undefined) return;

		// **These three stops are deliberately loud, and they are the third attempt.** The first pair was
		// `#FFFFFF → #F5F5F7 → #E8EBF0` — taken from the panel's own palette, on the argument that a wash drawn
		// from the theme cannot clash with it. **The argument was right and the numbers were useless**: that is a
		// change of about 1 RGB step per 10 pixels down a 400-pixel sheet, which is below what a person can see on
		// most displays, so the report that came back was "no visible change" — a true statement about a gradient
		// that was invisible rather than about a build that was stale.
		//
		// **So this is a calibration ramp, not a design.** White at the top, a light blue-grey at the halfway
		// line, a clearly darker one at the bottom: if the panel does not visibly shade after a clean build, the
		// gradient is not running and the question becomes the build rather than the colour. **The dial to turn
		// back is these three lines** — `theme.colors.panel` → `surface` → `card` is the tasteful version, and it
		// is one edit away, or pick any pair either side of this.
		const stops = [
			new ColorSequenceKeypoint(0, Color3.fromRGB(255, 255, 255)),
			new ColorSequenceKeypoint(0.5, Color3.fromRGB(216, 220, 228)),
			new ColorSequenceKeypoint(1, Color3.fromRGB(168, 176, 188)),
		];

		Fusion.New(this.scope, "UIGradient")({
			Parent: sheet,
			Color: new ColorSequence(stops),
			Rotation: 90,
		});
	}

	/**
	 * **One coloured bar, at the top of the frame it marks.** `LayoutOrder = -1` and `ZIndex = 100` — see
	 * {@link MARKER_PANEL} for why both, and for what a person looking at the screen is being asked.
	 */
	private addMarker(frame: Instance | undefined, name: string, colour: Color3): void {
		if (!SHOW_MARKERS) return;
		if (frame === undefined) return;
		const marker = new Instance("Frame");
		marker.Name = name;
		marker.Size = new UDim2(1, 0, 0, MARKER_HEIGHT);
		marker.Position = UDim2.fromOffset(0, 0);
		marker.BackgroundColor3 = colour;
		marker.BackgroundTransparency = 0;
		marker.BorderSizePixel = 0;
		marker.LayoutOrder = -1;
		marker.ZIndex = MARKER_Z_INDEX;
		marker.Visible = true;
		marker.Parent = frame;
	}

	/**
	 * **The first row's resolved rectangle and its ink, printed once per session on the first press that has
	 * rows.** A row is a `Frame` of six `TextLabel`s, so both halves matter: a frame at `0×0` is a layout fault
	 * and a frame of the right size whose labels are transparent or `#FFFFFF` on a white panel is an ink fault,
	 * and they look identical from the seat.
	 */
	private probeRow(): void {
		if (this.rowProbed) return;

		const list = this.rows;
		if (list === undefined) return;

		for (const child of list.GetChildren()) {
			if (!child.IsA("Frame") || child.Name === MARKER_ROWS) continue;

			this.rowProbed = true;

			let cellReport = "no cell";

			for (const cell of child.GetChildren()) {
				if (!cell.IsA("TextLabel")) continue;

				cellReport =
					`cell "${cell.Name}" at ${this.px(cell.AbsolutePosition.X)},${this.px(cell.AbsolutePosition.Y)}` +
					` size ${this.px(cell.AbsoluteSize.X)}×${this.px(cell.AbsoluteSize.Y)}` +
					` text "${cell.Text}" ink ${tostring(cell.TextColor3)} alpha ${cell.TextTransparency}`;

				break;
			}

			logInfo(
				`[Stats] first row — "${child.Name}" at ${this.px(child.AbsolutePosition.X)}` +
					`,${this.px(child.AbsolutePosition.Y)} size ${this.px(child.AbsoluteSize.X)}` +
					`×${this.px(child.AbsoluteSize.Y)}, visible ${child.Visible ? "yes" : "no"}` +
					`, ZIndex ${child.ZIndex} (parent ZIndex ${list.ZIndex}); ${cellReport}`,
			);

			return;
		}
	}

	/**
	 * Whether the one-line layout report has been printed — **once per session, and it is the line this panel has
	 * been missing for three sessions.**
	 *
	 * Every report so far could say the server had answered and nothing about what the client did with it. A
	 * board that was told `8 row(s)` and drew none is a *different* fault from one whose request was refused, and
	 * neither the server's line nor a screenshot of an empty table can tell them apart — the shape of an empty
	 * panel is identical either way. So the first answer of a session prints the row count *and the size of the
	 * frame the rows were put in*, after a frame has passed so the layouts have run. **A rows frame of
	 * `612×0 px` is the whole diagnosis**, and it is the one number that was never in any output.
	 *
	 * Once per session rather than per press, because it is an instrument and not a log: a player who opens the
	 * board twenty times should not read twenty copies of it.
	 */
	private reported = false;

	onStart(): void {
		// Spawned rather than inline, matching every other HUD: mounting waits for `PlayerGui`, and a
		// controller's `onStart` is the wrong place to hold up the rest of the client's boot.
		task.spawn(() => this.mount());
	}

	private mount(): void {
		if (this.mounted) return;
		this.mounted = true;

		// **The light palette, which is the pop-ups' and not the HUD's.** A panel read like a page of print —
		// names, numbers, a ranking — gets white paper and black ink, the same call `ShopController` makes and
		// for the same reason: `hudTheme()` is the HUD's palette and can be moved by the big-ui configuration.
		const theme = lightPanelTheme();

		logInfo("[Stats] board up — hold Tab to read the round");

		const panel = addPanelFrame(this.scope, theme, "MatchStatsPanel", this.open, PATTERN_TEXTURE);

		// **The paper, before anything is written on it.** A modifier rather than an element — see
		// {@link paintSheet} for why this panel cannot take the tiled texture the request asked for.
		this.paintSheet(panel);

		addHeaderBand(this.scope, theme, panel, 1, "Match Stats", () => this.open.set(false));

		const content = addContentBand(this.scope, panel, 3);

		// **A stack inside the content band, added here because this panel is the first with more than one
		// child in it.** The Shop's band holds two panes that both fill it and are switched by `Visible`, so it
		// needs no layout at all — this one holds a heading strip *above* a scrolling list, and without a layout
		// the two would both sit at the band's origin. `LayoutOrder` then does the stacking, which is the same
		// arrangement the panel's own bands use one level up.
		Fusion.New(this.scope, "UIListLayout")({
			Parent: content,
			FillDirection: Enum.FillDirection.Vertical,
			SortOrder: Enum.SortOrder.LayoutOrder,
			HorizontalAlignment: Enum.HorizontalAlignment.Center,
			Padding: new UDim(0, ROW_GAP),
		});

		this.addHeadings(theme, content);
		this.rows = this.addRowList(content);
		this.empty = this.addEmptyState(theme, content);

		// **Held for the geometry probe and for nothing else.** The two frames a board can vanish inside are the
		// panel and the content band: the first decides how much room there is, the second is what the rows
		// frame's own height is a fraction of, and *neither size has ever been in a log*. See {@link probe}.
		this.panel = panel;
		this.content = content;

		this.addFooter(theme, panel);

		raiseZIndex(panel, PANEL_Z_INDEX);

		// **The three markers go in last, one per frame, before anything is parented to the screen.** See
		// {@link MARKER_PANEL} for what each colour asks and for the five answers. They are added here rather
		// than by `addPanelFrame` or `addContentBand` because this file may not change `panelChrome` — and
		// because a diagnostic that a shared helper knows about is a diagnostic that outlives its session.
		this.addMarker(panel, MARKER_PANEL, Color3.fromRGB(255, 0, 0));
		this.addMarker(content, MARKER_CONTENT, Color3.fromRGB(0, 255, 0));
		this.addMarker(this.rows, MARKER_ROWS, Color3.fromRGB(0, 0, 255));
		// **`wrapLabels` is deliberately not called here, and it is the one departure from the Shop's mount.**
		// That helper turns wrapping on for every label that is neither `TITLE_NAME` nor `TextScaled` nor inside
		// an auto-sizing parent — right for a panel of sentences, wrong for a table. A row cell is a *column*:
		// it has a fixed height and a width shared with every other row, so a wrapped name would be clipped by
		// the row, and `TextWrapped` also switches off the `TextTruncate` that gives a long name its ellipsis
		// instead. Every label this panel makes is one line by construction, so there is nothing here for it to
		// wrap — see {@link fillCells}, which is where the two properties are set instead.
		//
		// **This is the last *tree* statement in this method, and the two below it are the reason it is worded
		// that way.** `getHudScreenGui()` is resolved and the panel is parented here, after every band, row and
		// footer exists — a panel that went up half-built would be a frame that resizes under the player. What
		// follows touches nothing in that tree: the remote (which yields) and the key binding (which does not).
		//
		// **`mountPanel` and not `panel.Parent = …`, because a panel is two frames since the pattern layer
		// arrived.** `panel` here is the `Content` frame the bands stack in; the visible rectangle is its parent,
		// and that is what has to become a child of the screen. The line this replaces would have moved the
		// content frame out of the panel and left the sheet with no parent at all — a panel built correctly and
		// never drawn.
		mountPanel(panel, getHudScreenGui());

		this.request = events.Client.Get("matchStats");
		this.answer = events.Client.Get("matchStatsBoard");

		this.answer.Connect((rows) => this.receive(rows));

		this.bindKey();
		this.probe();
	}

	/**
	 * **The key, claimed rather than observed.** `Begin` opens and asks; anything else closes.
	 *
	 * **`Sink`, and this reverses what the first version did.** That version returned `Pass` on the argument that
	 * the panel was "not entitled to the key against anything that has a better claim to it" — which was wrong
	 * about who else wants `Tab`: **Roblox's own player-list CoreScript does**, and a `Pass` leaves the press for
	 * it. The report that proved it was simply "Tab opens the default leaderboard", and the two facts together are
	 * the whole diagnosis — an action that passes is an action that did not claim.
	 *
	 * **So this is the belt, and `CoreGuiController` is the braces.** That file turns the list off through both
	 * of the engine's levers (`SetCoreGuiEnabled` retried, and the configuration object's `Enabled`/`Open`), but a
	 * request whose result cannot be read is not something a key binding should depend on. Sinking makes the panel
	 * work whether or not the removal took — and if the removal *did* take, sinking costs nothing, because there
	 * is nothing left to steal the key from.
	 *
	 * **What it costs: `Tab` is this panel's for as long as this controller is bound**, which is the session.
	 * Nothing else in this game asks for it, and the one thing that did is the surface `CoreGuiController` is
	 * trying to remove — so the cost is the intended outcome rather than a trade.
	 *
	 * **`false` for the touch button**, on `returnToLobby`'s reasoning: a phone has no `Tab`, and a button
	 * drawn for a key that does not exist on the device would be an empty corner of the screen.
	 */
	private bindKey(): void {
		ContextActionService.BindAction(
			ACTION_NAME,
			(_name, state) => {
				// **`Begin` opens; everything else closes** — which covers `End`, the release a hold is built on,
				// and `Cancel`, sent when the window loses focus mid-press. Written as a two-way branch rather
				// than as `Begin`/`End` so a cancelled press cannot leave the panel up with no key to close it;
				// the same reasoning that makes this a hold rather than a toggle.
				if (state === Enum.UserInputState.Begin) {
					this.open.set(true);
					this.refresh();

					logInfo("[Stats] board opened");
				} else {
					this.open.set(false);
				}

				return Enum.ContextActionResult.Sink;
			},
			false,
			KEY,
		);
	}

	/**
	 * **Asks the server, and lets the answer draw itself.** The previous answer is drawn first, so a second hold
	 * shows the last round's numbers for a frame rather than an empty panel — the wait only reads as a wait on
	 * the very first open, where there is nothing to show and nothing has been lost.
	 *
	 * **A send and not a call**, which is the change this panel needed: the answer arrives on `receive`, wired
	 * once at mount. Nothing here can fail in a way this method has to handle — a `SendToServer` on a remote that
	 * exists either goes out or the whole client is broken — where the promise this used to await could reject on
	 * a timeout, and a timeout is indistinguishable from a server that never answered. See `networking.ts` on
	 * `matchStats` for why the pair of events replaced the async function.
	 */
	private refresh(): void {
		this.render(this.last);

		// **Said unconditionally, and it names whether there is a remote to send on.** The two ways this press
		// does nothing visible are "the panel never asked" and "the panel asked and nothing came back", and
		// until this line existed neither was in the output. `undefined` here is a mount that did not finish —
		// the remote is resolved before the key is bound — so it is worth a line of its own rather than a
		// silent no-op.
		if (this.request === undefined) {
			logWarn("[Stats] press ignored — the request remote was never resolved (mount did not finish)");

			return;
		}

		logInfo(`[Stats] asking — ${this.last.size()} row(s) remembered from the last answer`);

		// **And a press that is never answered says so in two seconds.** Without this the panel's "waiting" line
		// is indistinguishable from a board that is broken: a request that never arrives, an answer that is never
		// delivered and a listener that was never connected all leave the same sentence on screen forever. The
		// stamp is the guard — an answer clears it, so a later press cannot be judged late by this one's timer,
		// and a superseded press cannot clear a live one's.
		const stamp = os.clock();
		this.awaitingSince = stamp;

		task.delay(2, () => {
			if (this.awaitingSince !== stamp) return;

			this.awaitingSince = 0;

			logWarn(
				"[Stats] no answer within 2s — the request did not reach MatchStatsService, or its answer did " +
					"not reach this client; see the server's '[Stats] sending …' line",
			);

			this.say("No answer from the server — see the output window.");
		});

		this.request.SendToServer();
	}

	/**
	 * **The server's answer, all of it** — validated, remembered, and drawn if anybody is looking.
	 *
	 * **A payload that is not a table is turned into the empty state rather than trusted.** A remote can deliver
	 * nothing, and `this.last = rows` followed by a `render` that indexes it threw inside whatever called this —
	 * which is the event's own handler, where a throw is a silent dead connection. The empty state is a sentence
	 * a player can see; a throw is not.
	 *
	 * **Remembered even when the panel is closed**, so the next open starts from the truth rather than from an
	 * empty table. The re-read of `open` after the fact is `Fusion.peek`'s own rule: a reply may land after the key
	 * has been released, and the value — not a capture taken before the round trip — is the one fact that says
	 * whether anybody is looking.
	 */
	private receive(rows: ReadonlyArray<MatchStatsRow>): void {
		// **The one line that was always missing from this hop.** The server's line says what it *sent*, and
		// this says what arrived — and "sent 8, arrived none" and "sent 8, arrived 8" are a transport fault and
		// a drawing fault respectively. Unconditional rather than `DEBUG_LOGGING`, because the four sessions this
		// panel has cost were all spent unable to tell those two apart.
		//
		// **The first row is on the line**, because the other thing that can empty a board is a payload whose
		// shape is not what the drawing code reads: a `side` that is not `"A"`/`"B"`, or a `points` that is not
		// a number, drops every row into a branch that draws nothing and says nothing.
		if (typeIs(rows, "table")) {
			const first = rows[0];
			const shape =
				first === undefined
					? "none"
					: `name=${tostring(first.name)} side=${tostring(first.side)} points=${tostring(first.points)}`;

			logInfo(`[Stats] received — ${rows.size()} row(s); first { ${shape} }`);
		} else {
			logWarn(`[Stats] received — not a table but a ${typeOf(rows)}; drawing the empty state`);
		}

		this.answered = true;
		this.awaitingSince = 0;
		this.last = typeIs(rows, "table") ? rows : [];

		if (Fusion.peek(this.open)) this.render(this.last);

		this.reportOnce(this.last.size());

		logInfo(`[Stats] board answered — ${this.last.size()} row(s)`);
	}

	/**
	 * **Prints what the answer was and how much room it was drawn into**, once per session — see
	 * {@link reported}.
	 *
	 * The frame's size is read a frame later rather than on the spot, because a `UIListLayout` and a
	 * `ScrollingFrame`'s automatic canvas are resolved by the engine's own layout pass: read in the same
	 * resumption the answer arrives on, every size here would be the one it had *before* the rows were added,
	 * and the number would be a lie in the direction that matters.
	 *
	 * `spawn`ed rather than awaited, so the promise this sits inside is not held open by a diagnostic.
	 */
	private reportOnce(rowCount: number): void {
		if (this.reported) return;
		this.reported = true;

		const list = this.rows;
		if (list === undefined) return;

		task.spawn(() => {
			task.wait();

			const drawn = list.GetChildren().filter(
				(child) => !child.IsA("UIListLayout") && !child.IsA("UIFlexItem"),
			).size();

			logInfo(
				`[Stats] board answered — ${rowCount} row(s), ${drawn} drawn into a frame ` +
					`${string.format("%.0f", list.AbsoluteSize.X)}×${string.format("%.0f", list.AbsoluteSize.Y)} px ` +
					`(visible ${list.Visible ? "yes" : "no"})`,
			);
		});
	}

	/**
	 * **The headings, stacked above the scrolling area rather than scrolling with it.** A column heading that
	 * scrolled away is a number with no name, which is the one thing a table cannot survive.
	 */
	private addHeadings(theme: HudTheme, content: Frame): void {
		const strip = new Instance("Frame");
		strip.Name = "Headings";
		strip.Size = new UDim2(1, 0, 0, ROW_HEIGHT);
		strip.BackgroundTransparency = 1;
		strip.LayoutOrder = 0;
		strip.Parent = content;

		this.fillCells(strip, theme, COLUMNS.map((column) => column.heading), (index) => COLUMNS[index].width, true);
	}

	/**
	 * **The scrolling area the rows are rebuilt into**, and the one place this panel departs from `addShelf`.
	 *
	 * `addShelf` is a `ScrollingFrame` whose cells come from a `UIGridLayout` — a grid of fixed cards. A board
	 * is a single column of full-width rows, so the layout is a `UIListLayout` and each row is one frame of its
	 * own; the scroll mechanics are the shelf's (`AutomaticCanvasSize.Y`, an elastic behaviour off so a row
	 * cannot slide away from the pointer) because those are properties of scrolling rather than of grids.
	 *
	 * **The height is arithmetic, and it used to be a `UIFlexItem` — which is the bug behind an empty board that
	 * answered `8 row(s)` on the server.** The first version copied `addShelf`'s "take the rest" verbatim: a
	 * zero size plus `UIFlexItem{FlexMode = Fill}`, on `addColumns`' argument that this is how a `UIListLayout`
	 * spells `flex: 1`. It is — for a plain `Frame`, which is what the content band and the fill column are. **A
	 * `ScrollingFrame` is not resized by a flex item here**, so this frame stayed at the height it was given,
	 * which was nought: the headings above it drew, eight rows were built and parented into it every press, and
	 * none of them had anywhere to be. A screenshot of the panel shows exactly that — the column headings and
	 * then nothing — and its own empty-state label was invisible for the same reason, which is why the board
	 * looked identical whether the server had answered or not.
	 *
	 * **So the height is written out: everything the band has, less the heading strip and the two gaps.** The
	 * band's own height is the panel's remainder (`addContentBand`), its `UIPadding` takes `PAD_Y` off the top
	 * and the bottom, and this list is the last item in the band's stack after a `ROW_HEIGHT` strip and one
	 * `ROW_GAP`. Subtracting the padding as well as the two gaps is deliberate: **it is right in both readings**
	 * of `UIPadding` — a scale child that is measured against the padded area lands exactly, and one measured
	 * against the raw frame lands sixteen pixels short, which is a small gap at the bottom of a list that
	 * scrolls. Erring long would instead have cut the last row in half.
	 */
	private addRowList(content: Frame): ScrollingFrame {
		const list = new Instance("ScrollingFrame");
		list.Name = "Rows";
		list.Size = new UDim2(1, 0, 1, -(ROW_HEIGHT + ROW_GAP + 2 * SHOP_CONFIG.PAD_Y));
		list.LayoutOrder = 1;
		list.BackgroundTransparency = 1;
		list.BorderSizePixel = 0;
		list.ScrollBarThickness = 4;
		list.ScrollBarImageTransparency = 0.4;
		list.CanvasSize = UDim2.fromOffset(0, 0);
		list.AutomaticCanvasSize = Enum.AutomaticSize.Y;
		list.ElasticBehavior = Enum.ElasticBehavior.Never;
		list.Parent = content;

		// **A flex fill on it as well, and the pair is deliberate rather than belt-and-braces for its own
		// sake.** `addShelf` gives a `ScrollingFrame` a zero size and a `UIFlexItem{FlexMode = Fill}` and the
		// shop's grid fills its pane, which is the working proof in this codebase that a `ScrollingFrame` *is*
		// resized by a flex item — so the arithmetic above assumes a height that the layout would have supplied
		// anyway. **What makes both worth having is the direction each one fails in**: if the flex applies, it
		// wins and the frame is exactly the band's leftover; if it does not, the frame keeps its declared
		// arithmetic, which is the leftover less the padding. Neither answer is nought, which is the only
		// outcome this panel cannot survive — and nought is what a *scale* of a zero-height band would produce
		// on its own, because `1, -44` of nothing is a negative number that Roblox clamps up to nothing.
		Fusion.New(this.scope, "UIFlexItem")({ Parent: list, FlexMode: Enum.UIFlexMode.Fill });

		const layout = new Instance("UIListLayout");
		layout.Name = "RowLayout";
		layout.FillDirection = Enum.FillDirection.Vertical;
		layout.SortOrder = Enum.SortOrder.LayoutOrder;
		layout.Padding = new UDim(0, ROW_GAP);
		layout.Parent = list;

		return list;
	}

	/**
	 * **The "nobody yet" line, built once and switched by `Visible`** — a sibling of the row list, in the
	 * content band, on `addColumns`' rule that a thing which must be seen is not put inside the thing that
	 * scrolls.
	 *
	 * Built once rather than rebuilt per press, because it is one label whose *existence* does not depend on the
	 * answer: a press with rows hides it and a press without shows it, and neither case destroys an instance.
	 * That is the opposite of the rows, which are rebuilt — see {@link render} for why the two differ.
	 *
	 * **`LayoutOrder` above the footer and below the list**, which is where a sentence explaining an empty table
	 * belongs. `UIListLayout` skips a `Visible = false` child entirely, so the list and this label share the
	 * band without either reserving space for the other — which is what makes the swap a property write rather
	 * than a re-layout. `AutomaticSize.Y` and a wrapped sentence, because this is the one label here that is
	 * prose rather than a column: a phone narrow enough to wrap it should grow the line rather than clip it.
	 */
	private addEmptyState(theme: HudTheme, content: Frame): TextLabel {
		const message = new Instance("TextLabel");
		message.Name = "Empty";
		// **A fixed height, and `AutomaticSize.Y` was removed because a live log proved it resolves to `0×0`.**
		// The geometry line printed `empty 0×0 (visible no)` on a label declared `(1, 0, 0, 52)` and set to
		// `AutomaticSize.Y`, which is the one state this label exists to avoid: it is the *only* thing on the
		// panel that has something to say when the board has nothing to show, and it was measuring itself at
		// nothing. The wrapped-sentence argument above is still true and still costs nothing here — the panel is
		// this wide whatever the text does, and two row-heights is room for three lines of it.
		message.Size = new UDim2(1, 0, 0, ROW_HEIGHT * 2);
		message.BackgroundTransparency = 1;
		message.Font = theme.typography.body.font;
		message.TextSize = theme.typography.body.size;
		message.TextColor3 = theme.colors.textSecondary;
		message.TextXAlignment = Enum.TextXAlignment.Center;
		message.TextYAlignment = Enum.TextYAlignment.Center;
		message.TextWrapped = true;
		message.Text = WAITING_TEXT;
		message.LayoutOrder = 2;
		message.Visible = false;
		message.Parent = content;

		return message;
	}

	/** The one line of small print: what the numbers mean and how the key behaves. */
	private addFooter(theme: HudTheme, panel: Frame): void {
		const footer = addFooterBand(this.scope, panel, 4);

		const note = new Instance("TextLabel");
		note.Name = "Note";
		note.Size = new UDim2(1, 0, 0, 18);
		note.BackgroundTransparency = 1;
		note.Font = theme.typography.caption.font;
		note.TextSize = theme.typography.caption.size;
		note.TextColor3 = theme.colors.textSecondary;
		note.TextXAlignment = Enum.TextXAlignment.Center;
		note.Text = "hold Tab · points are earned this round";
		note.LayoutOrder = 0;
		note.Parent = footer;
	}

	/**
	 * **Empties the list and draws the answer into it — the only place this file builds instances.**
	 *
	 * **Nothing accumulates, and that is the property to check rather than assume.** The container is cleared of
	 * every child *except* its layout and flex item, so a session of a hundred holds leaves one layout and one
	 * set of labels — the old ones destroyed rather than hidden. A board that only hid old rows would grow by a
	 * roster per press and keep every row it had ever drawn in the tree.
	 *
	 * **Grouped by side, then ranked by points within it**, which is the whole ordering rule: a side's rows are
	 * compared with their own side because a match is two teams, and the ranking inside one is the only one that
	 * means anything. The sort is on the number the server sent rather than on the counters, so the board and
	 * the formula cannot disagree about who is ahead — see `shared/matchStats.ts`.
	 *
	 * **A tie keeps the order the server sent**, which is players then rigs, so repeated holds do not shuffle two
	 * bodies on equal points. `table.sort` is not stable, so the comparison is written to be total: equal
	 * points fall back to the name.
	 *
	 * **The rows and the empty state are drawn by different means, and the difference is what each one is for.**
	 * A row is transient — a different set on every press, and destroyed and rebuilt each time — while the line
	 * that explains an empty table is permanent: one label, built at mount, that this method shows or hides.
	 * **That split is the fix for a board that was blank with nothing to say why**: the "nobody yet" text used
	 * to be a row like any other, appended to the scrolling frame, and a frame that has no height of its own
	 * cannot show a label inside it. `drawn === 0` now hides the list and shows the label — which is also the
	 * arrangement that makes the two mutually exclusive by construction rather than by convention.
	 *
	 * **Everything in here runs inside a `pcall`, and a thrown row no longer takes the board with it.** An
	 * error raised in this method used to abort the rest of the loop *and* skip the two `Visible` writes at the
	 * end, which is the worst possible combination: half a table, no sentence, and nothing in the output except
	 * a traceback that never mentions the board. Now a failed row is warned about by name and skipped, and a
	 * failure of the geometry itself puts a sentence on screen instead of leaving the panel blank. **A blank
	 * panel and a broken panel have to look different**, or every report of one is answered as the other.
	 *
	 * **The sides are read from the payload rather than assumed to be `A` and `B`.** `SIDES` is still the order
	 * they are drawn in, but a row whose `side` is anything else — `""` for a body nobody has sided, or a mode
	 * that names its own — used to fall through both filters and be dropped without a word. That is a board
	 * that renders nothing while holding eight rows, which is the report this method keeps getting.
	 */
	private render(rows: ReadonlyArray<MatchStatsRow>): void {
		const [ok, failure] = pcall(() => this.renderBody(rows));

		if (!ok) {
			logWarn(`[Stats] render failed — ${tostring(failure)}`);

			this.say("Match stats could not be drawn — see the output window.");

			return;
		}
	}

	/**
	 * **Says one sentence in the panel's empty-state label and takes the list out of the way**, which is the only
	 * thing on this panel guaranteed to be visible when the rest of it is not. Used by {@link render}'s failure
	 * path; the ordinary empty and populated states are written by {@link renderBody}.
	 */
	private say(text: string): void {
		const list = this.rows;
		if (list !== undefined) list.Visible = false;

		const empty = this.empty;
		if (empty !== undefined) {
			empty.Text = text;
			empty.Visible = true;
		}
	}

	/** The body of {@link render}, split off **only** so the `pcall` above can wrap all of it. */
	private renderBody(rows: ReadonlyArray<MatchStatsRow>): void {
		const list = this.rows;
		if (!list) return;

		for (const child of list.GetChildren()) {
			if (child.IsA("UIListLayout") || child.IsA("UIFlexItem")) continue;

			// **The blue marker is not a row and is spared**, because this loop runs on every press and a marker
			// destroyed by the first one is a marker nobody ever sees. See {@link MARKER_PANEL}.
			if (child.Name === MARKER_ROWS) continue;

			child.Destroy();
		}

		const theme = lightPanelTheme();
		const mode = this.currentMode();
		let order = 0;
		let drawn = 0;

		// **`SIDES` first, then any side the payload invents, in the order the payload first mentions it.** The
		// filter below used to be `SIDES` alone, so a row with `side === ""` — which the type documents as one
		// of the three legal values — matched neither pass and vanished, and the board drew nothing while the
		// server had numbered eight rows.
		const groups = new Array<string>();

		for (const side of SIDES) groups.push(side);

		for (const row of rows) {
			let known = false;

			for (const side of groups) {
				if (side === row.side) {
					known = true;
					break;
				}
			}

			if (!known) groups.push(row.side);
		}

		for (const side of groups) {
			const onSide = rows.filter((row) => row.side === side);
			if (onSide.size() === 0) continue;

			const ranked = onSide.sort((a, b) => {
				if (a.points !== b.points) return a.points > b.points;
				if (a.name !== b.name) return a.name < b.name;

				return false;
			});

			const heading = new Instance("TextLabel");
			heading.Name = `Side-${side}`;
			heading.Size = new UDim2(1, 0, 0, SIDE_HEADING_HEIGHT);
			heading.BackgroundTransparency = 1;
			// **`ZIndex` written by hand, because this label is created on a *press* and `raiseZIndex` only ever
			// ran once at mount.** See {@link addRow} for the whole of it — the same fault, three lines apart.
			heading.ZIndex = list.ZIndex;
			heading.Font = theme.typography.body.font;
			heading.TextSize = theme.typography.body.size;
			// **The team's colour, from the one table that holds them** — the same call `HitLogController`
			// makes about a feed's two names, so a side is one colour everywhere on screen. A side the table
			// has never heard of takes the primary ink rather than throwing, which is the same "fall back
			// rather than error" `sideNameOf` applies to its own unknown labels.
			heading.TextColor3 = teamColourOf(side) ?? theme.colors.textPrimary;
			heading.TextXAlignment = Enum.TextXAlignment.Left;
			heading.Text = this.headingText(mode, side);
			heading.LayoutOrder = order;
			heading.Parent = list;

			order += 1;

			for (const row of ranked) {
				// **One row at a time, so the failure names the body it happened on.** A row is six labels and
				// a layout; the only way it can throw is a field that is not the type the payload promised, and
				// "which body" is the whole of the fix when that happens.
				const [rowOk, rowFailure] = pcall(() => this.addRow(list, theme, row, order));

				if (!rowOk) {
					logWarn(`[Stats] row for ${tostring(row.name)} could not be drawn — ${tostring(rowFailure)}`);
					continue;
				}

				order += 1;
				drawn += 1;
			}
		}

		// **One of the two is always visible, and neither is ever both.** An empty table is a sentence, and a
		// sentence needs to be somewhere the flex cannot collapse it; a populated one needs the scroller. Hiding
		// the list also takes it out of the band's list layout, so the sentence is not pushed to the bottom of a
		// frame sized for rows that are not there. See `addEmptyState`.
		//
		// **And the sentence is chosen by `answered`, not by the row count.** *"Waiting for players…"* is a round
		// trip that has not landed; *"Nobody is on a side yet."* is an answer that says the intermission has not
		// filled. Same pixels, different faults — see {@link WAITING_TEXT} for the four sessions that cost.
		list.Visible = drawn > 0;

		const empty = this.empty;
		if (empty !== undefined) {
			empty.Text = this.answered ? NOBODY_TEXT : WAITING_TEXT;
			empty.Visible = drawn === 0;
		}

		// **The numbers, every press, not once per session.** `reportOnce` prints the resolved pixels the first
		// time an answer lands; this prints what the *drawing* decided, on every hold, because a board that is
		// correct once and empty afterwards is a different fault from one that has never worked. It names the
		// payload's own shape as well — `in` beside `drawn` is what says "eight arrived and none matched a
		// side", which no other line in this project can say.
		logInfo(
			`[Stats] drew ${drawn} of ${rows.size()} row(s) into ${list.AbsoluteSize.X}×${list.AbsoluteSize.Y} px` +
				` (list ${list.Visible ? "shown" : "hidden"}, empty ` +
				`${empty !== undefined && empty.Visible ? "shown" : "hidden"})`,
		);

		// **And where the first row actually landed**, once per session. A count of eight rows says the loop
		// ran; it says nothing about a rectangle on screen. See {@link probeRow}.
		this.probeRow();
	}

	/**
	 * **One body's line** — six cells, the name left-aligned and the rest centred.
	 *
	 * **A "body" rather than a player, and that is the whole of what the row can tell a rig from a person
	 * apart: nothing.** `row.name` is a plain string the server took from `Player.Name` or `Model.Name`, and
	 * every other field is a number, so this method has no branch and needs none — a rig's line is built by
	 * exactly the code that builds a player's. **What it deliberately does not do:** look the name up on
	 * `Players`, request a headshot, or draw an avatar. A board that resolved a row through `Players` would
	 * have to answer "what is this?" for a name that is not there, and the answer would be a column of blank
	 * heads for the eight bodies that actually played. The name is the identity the server chose, and the
	 * card's job is to print it.
	 *
	 * **`ZIndex` is copied from the container, and that one line is the whole of a board that drew eight rows
	 * and showed none of them.** `mount` calls `raiseZIndex(panel, PANEL_Z_INDEX)` — which flattens *every
	 * descendant that exists at that moment* to `10`, including the headings strip, the content band and the
	 * scrolling frame — and that call is over before the first press. A row created afterwards kept the
	 * `ZIndex` default of `1`, and `ZIndex` is compared **flattened across the whole `ScreenGui`** rather than
	 * against a sibling: a child below its parent's number is drawn *behind* the parent, and the panel's
	 * background is opaque white. So the rows were in the tree, at the right size, at the right position,
	 * reporting `Visible = true` — and painted underneath the paper they were meant to be written on. The
	 * column headings were visible because they were built at mount; the coloured markers were visible because
	 * they are set to `100`; **everything built on a press was invisible, which is exactly the screenshot.**
	 *
	 * **Copied from the parent rather than a constant**, because the number that matters is "whatever level
	 * `raiseZIndex` put this panel's furniture on" — a literal here would be a second authority on the panel's
	 * depth, and the two would disagree the first time `PANEL_Z_INDEX` moved. At equal `ZIndex` the tree order
	 * decides, and a child after its parent's background draws on top of it.
	 */
	private addRow(parent: ScrollingFrame, theme: HudTheme, row: MatchStatsRow, order: number): void {
		const line = new Instance("Frame");
		line.Name = row.name;
		line.Size = new UDim2(1, 0, 0, ROW_HEIGHT);
		line.BackgroundTransparency = 1;
		// **Set before the cells are built**, because `fillCells` copies it onto each of them.
		line.ZIndex = parent.ZIndex;
		line.LayoutOrder = order;
		line.Parent = parent;

		this.fillCells(
			line,
			theme,
			[
				row.name,
				withCommas(row.points),
				withCommas(row.hits),
				withCommas(row.throws),
				withCommas(row.catches),
				withCommas(row.dodges),
			],
			(index) => COLUMNS[index].width,
			false,
		);
	}

	/**
	 * **One row's six cells, laid out horizontally by fraction** — the one piece of geometry this file shares
	 * between the headings and the rows, so a heading cannot drift off the column it names.
	 *
	 * A `UIListLayout` with `Horizontal` fill rather than six absolute positions: the widths are scale values, so
	 * the layout is what keeps them in order and gives them the panel's gaps for free. Two switches ride on the
	 * same routine because a heading is a row whose ink differs: `left` comes from the column (the name reads as
	 * a list when it starts at the left edge, and a number centred on its own width is what makes two rows
	 * comparable), while `heading` decides the type — the caption's face and the secondary ink for the strip
	 * above, the body's face and the primary ink for the rows themselves.
	 */
	private fillCells(
		row: Frame,
		theme: HudTheme,
		texts: ReadonlyArray<string>,
		widthOf: (index: number) => number,
		heading: boolean,
	): void {
		const layout = new Instance("UIListLayout");
		layout.Name = "Cells";
		layout.FillDirection = Enum.FillDirection.Horizontal;
		layout.SortOrder = Enum.SortOrder.LayoutOrder;
		layout.VerticalAlignment = Enum.VerticalAlignment.Center;
		layout.Parent = row;

		for (let index = 0; index < texts.size(); index++) {
			const column = COLUMNS[index];

			const cell = new Instance("TextLabel");
			cell.Name = column.heading;
			cell.Size = new UDim2(widthOf(index), 0, 1, 0);
			cell.BackgroundTransparency = 1;
			// **The row's own level, and this is the line that decides whether the text is visible at all.** A
			// label left at the `ZIndex` default is drawn behind the panel's opaque background when its row is
			// above that background — see {@link addRow}, which is where the whole fault is written down.
			cell.ZIndex = row.ZIndex;
			cell.Font = heading ? theme.typography.caption.font : theme.typography.body.font;
			cell.TextSize = heading ? theme.typography.caption.size : theme.typography.body.size;
			cell.TextColor3 = heading ? theme.colors.textSecondary : theme.colors.textPrimary;
			cell.TextXAlignment = column.left ? Enum.TextXAlignment.Left : Enum.TextXAlignment.Center;
			cell.TextYAlignment = Enum.TextYAlignment.Center;
			cell.TextTruncate = Enum.TextTruncate.AtEnd;
			cell.Text = texts[index];
			cell.LayoutOrder = index;
			cell.Parent = row;
		}
	}

	/**
	 * **The mode id, for naming a side.** `DodgeAndSeek`'s sides are `Seekers` and `Dodgers` rather than `Team A`
	 * and `Team B`, so a board that hard-coded the pair would be wrong in one of the three modes — and
	 * `sideNameOf` is the one place those names live.
	 *
	 * Read from the folder every time rather than cached in a value, because it is written once a round and this
	 * is read once a press: a subscription for a number nobody draws between presses would be a connection kept
	 * for the two seconds a panel is up. **An unrecognised id falls back to `ScoreRush`**, whose names are the
	 * `Team A`/`Team B` pair every other mode uses — the same "fall back rather than error" `sideNameOf` itself
	 * applies to an unknown label.
	 */
	private currentMode(): GameModeId {
		const status = ReplicatedStorage.FindFirstChild(ROUND_STATUS_FOLDER);
		const value = status?.GetAttribute(ROUND_MODE_ATTRIBUTE);

		if (typeIs(value, "string") && isGameModeId(value)) return value;

		return "ScoreRush";
	}

	/**
	 * **A side's heading, with its score beside its name — `Team B  ·  3`.**
	 *
	 * **The score is read here, at draw time, from the attributes the round already publishes.** It is not on
	 * `MatchStatsRow` and does not travel in `matchStatsBoard`: a row is one *body's* line for this round, while a
	 * score is the round's own fact and is already on the `RoundStatus` folder where `ScoreHudController` reads it.
	 * Putting it in the payload would be a second copy of a number the client can already see, and two copies of a
	 * number are two numbers waiting to disagree.
	 *
	 * **No subscription, because this panel has no life between presses.** `render` runs on the `Tab` press and
	 * again when an answer lands, so the value is sampled at exactly the moments it is drawn — a changed-signal per
	 * side would keep two connections alive for a panel that is closed most of the time, and would still not repaint
	 * a panel that is not on screen. See {@link scoreOn}.
	 *
	 * **The separator is `·` rather than the em-dash, and that is a deliberate deviation from the reference.** `—`
	 * is the *placeholder* for a score that has not replicated, so using it as the join as well would render an
	 * unknown score as `Team B — —`, which reads as a fault rather than as a placeholder. `·` is already this
	 * panel's separator — the footer says *"hold Tab · points are earned this round"* — so the choice is consistent
	 * as well as unambiguous.
	 *
	 * **`0` is a real score and prints as `0`.** The distinction this method exists to preserve is between *nought*
	 * and *nobody has told me yet*: an intermission board is legitimately all noughts, and a board that said `—`
	 * there would be claiming ignorance when it had an answer.
	 */
	private headingText(mode: GameModeId, side: string): string {
		const name = side === "" ? "No side yet" : sideNameOf(mode, side);
		const score = this.scoreOn(side);

		return `${name}  ·  ${score === undefined ? NO_SCORE_TEXT : tostring(score)}`;
	}

	/**
	 * **One side's score, as a number — or `undefined` when the round has not published it.**
	 *
	 * **`undefined` rather than `0`, and that is the whole reason this is not `ScoreHudController.scoreOf`.** The HUD
	 * bar wants a number to draw and nought is the right stand-in *there*; this board has a second state to render,
	 * and inflating a missing value into a real one would make "not loaded" and "level pegging" the same pixels.
	 * {@link headingText} is where the difference is spent.
	 *
	 * **`FindFirstChild` on every draw rather than a folder held at mount**, matching `currentMode` next door: this
	 * panel may mount before the round folder exists, and a captured `Instance` would have to be re-resolved anyway
	 * if `RoundService` ever rebuilt it. One child lookup and one attribute read, on a key press.
	 */
	private scoreOn(side: string): number | undefined {
		const attribute = side === "A" ? ROUND_SCORE_A_ATTRIBUTE : ROUND_SCORE_B_ATTRIBUTE;

		// A side that is neither `A` nor `B` — the `""` a body nobody has sided carries — has no score to show.
		if (side !== "A" && side !== "B") return undefined;

		const status = ReplicatedStorage.FindFirstChild(ROUND_STATUS_FOLDER);
		if (status === undefined) return undefined;

		const value = status.GetAttribute(attribute);

		return typeIs(value, "number") ? value : undefined;
	}
}
