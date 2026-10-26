import { Button, Text } from "@rbxts/big-ui";
import Fusion from "@rbxts/fusion-3.0";
import { BALL_CONFIG } from "shared/config/ball.config";
import { SHOP_CONFIG } from "shared/config/shop.config";
import { addElevation, wireInteraction } from "./elevation";
import type { HudTheme } from "./hudTheme";
import { addViewportConstraint } from "./viewportConstraint";

/**
 * The chrome the modal panels are made of: one panel frame, one band, one tab strip, one grid, one
 * tile.
 *
 * **This module exists because there are two panels and they have to look like siblings.** The shop
 * and the inventory are the same panel with different contents, and every number that makes them the
 * same — the corner radius, how far a band insets its contents, how tall a name bar is, how a grid
 * derives its cell size — has to be *the same number* in both or the two drift. That is the argument
 * `notifications.ts` makes for the width, the gap and the cap its stack shares ("one owner for the numbers
 * two toasts have to agree on"), and `screenGui.ts` makes for the GUI every HUD hangs from, and this is the
 * same case one level up.
 *
 * **What this deliberately is not: a panel framework.** There is no panel type, no options object, no
 * registry and no interface with one implementation — there are nine builders that each do exactly
 * what the shop's own private method did before, and a caller that wants something else is expected to
 * build it rather than to configure this. The moment a builder here needs a flag to serve a second
 * caller differently, that caller should stop using it.
 *
 * **The geometry comes from `SHOP_CONFIG`, which is the one thing here worth knowing about.** That
 * file already owns these numbers and derives two cell scales from its own gap; the alternative was
 * declaring a second copy of `PAD_X`, `TAB_HEIGHT` and `GRID_GAP_SCALE` in here, which is how two
 * panels end up 2px apart. The cost is that the inventory reads its geometry from a file named after
 * the shop — a naming wart, not a sharing one, and renaming that block to `panel.config.ts` is a
 * separate change rather than one to smuggle into a UI task.
 */

/** The one label `wrapLabels` never touches regardless of its parent — see that function. */
export const TITLE_NAME = "Title";

/**
 * The smallest a panel may be drawn, in pixels.
 *
 * **Smaller than `SHOP_CONFIG.PANEL_MIN_SIZE`, and deliberately.** That value is 520 pixels wide, and
 * a panel's width is also a fraction of the viewport — so on any screen narrower than about 840px the
 * minimum wins, the panel is wider than the screen, and its two side bands sit off the glass. A pixel
 * minimum is only safe when the pixels are smaller than the screen they land on, and nothing at this
 * call site knows how wide the screen is. This floor says "never so small that a tile cannot be read"
 * and stays under 92% of even a 320px viewport, which is what `addViewportConstraint` caps against.
 */
export const PANEL_MIN_PIXELS = new Vector2(280, 260);

/**
 * The ZIndex every panel is drawn at.
 *
 * Re-exported rather than left inside {@link addPanelFrame} because a panel has to call
 * {@link raiseZIndex} with the same number *after* its bands exist — see that function for why the
 * descendants need it too — and two numbers that must be equal are one number with two names.
 */
export const PANEL_Z_INDEX = SHOP_CONFIG.PANEL_Z_INDEX;

/**
 * The confirmation dialog's rung — see {@link SHOP_CONFIG.MODAL_Z_INDEX} for why it is a rung of its own.
 *
 * Re-exported beside the panel's for the reason `PANEL_Z_INDEX` is: a caller that mounts over the panel should not have
 * to reach into the config for the number, and the two being neighbours here is what makes the ladder visible.
 */
export const MODAL_Z_INDEX = SHOP_CONFIG.MODAL_Z_INDEX;

/** The gap between tabs as a fraction of the row. */
export const TAB_GAP_SCALE = 0.012;

/**
 * **A panel's corner radius, in pixels, and it is one number with two names only because two frames need it.**
 *
 * The sheet wears it, and so does the pattern layer — the sheet does not clip, so a square backdrop under a rounded
 * panel shows four corners sticking out. It was a literal `10` inside {@link addPanelFrame} until the pattern layer
 * arrived; the alternative was the same literal twice, which is how the two come to disagree.
 */
const PANEL_CORNER_RADIUS = 10;

/**
 * The name of the frame inside a sheet that the bands are stacked in, and it is exported because a diagnostic
 * somewhere may want to find it by name rather than by walking parents.
 */
export const PANEL_CONTENT_NAME = "Content";

/**
 * **The size of one tile of a panel's pattern, in pixels — 16, matching the art a caller is expected to supply.**
 *
 * `TileSize` is set from this rather than from the image's own dimensions, because a `ScaleType.Tile` image with no
 * `TileSize` is drawn at its *native* size in pixels, and a 16×16 dot tile at native size is a 16-pixel dot in a
 * 664-pixel panel — which is right, but only by coincidence. Naming it makes the caller's contract one number: **the
 * art must be 16×16 or the dots are not square in one direction.**
 */
const PATTERN_TILE = 16;

/** A tile's name bar, in pixels — the strip across the bottom of a tile that carries its name. */
const TILE_NAME_HEIGHT = 30;

/** A tile's status line, in pixels. Sits just above the name bar, over the artwork. */
const TILE_STATUS_HEIGHT = 20;

/**
 * The top of a tile's status line, in pixels, measured up from the tile's bottom edge.
 *
 * **A tile's face covers the whole tile — including the strips the name bar and the status line are drawn over
 * — so a picture laid on that face has to be able to say where *its* part of it ends.** This is that answer for
 * a tile that writes a status line: the name bar, the gap above it, and the line itself. It is read by
 * {@link addIcon} and by nothing else, and the `6` is `addTile`'s own gap rather than a fact of its own — it is
 * summed here only because a picture needs one number where the bands needed three.
 *
 * **The tile that writes no status line reserves the name bar and nothing else**, which is the other half of
 * the same answer and is passed rather than derived: see {@link addIcon}'s `statusLine`.
 */
const TILE_STATUS_TOP = TILE_NAME_HEIGHT + 6 + TILE_STATUS_HEIGHT;

/**
 * How far a picture stands off the edges of the face it is drawn on, in pixels. **Placeholder.**
 *
 * **A margin at all, because a picture against the tile's edge reads as a picture that has been cut.** The
 * shelf tile's face is 92 pixels tall with a 30-pixel name bar across the bottom of it and a 20-pixel status
 * line above that, so a picture sized to the space it is allowed and then drawn flush fills that space exactly
 * — which on the smallest face either panel draws is an icon whose top row of pixels is the tile's top row.
 * Nothing is being clipped; it only looks it.
 */
const ICON_MARGIN = 6;

/**
 * One tab: what it says.
 *
 * **It used to carry a colour *job* as well, and that is gone — not deprecated, removed.** The job existed
 * so a strip could tint its selected tab per slot, and it failed at the one thing it was for: two of the
 * jobs it was handed (`coin` and `warning`) are the *same* palette value, so half the strip never had an
 * identity to lose, and a saturated colour chosen to dress a shelf is not a colour that reads as a 2px line
 * on a light tab. What is left is the signal that was always doing the work: **the fill inverts** — the
 * selected tab is the light one — and a fill is visible at a glance where a hairline is not.
 *
 * A per-slot identity can come back the day there is art to put in a tab's picture slot, which is what that
 * slot is waiting for; it cannot come back as a line.
 */
export interface TabDef {
	readonly name: string;
}

/** What {@link addTile} hands back: the parts a caller writes to or restyles. */
export interface Tile {
	/** The tile box itself — for a caller outside a grid, which has to say how big it is. */
	readonly frame: Frame;
	/**
	 * The tile's face — the picture slot the name bar is drawn over.
	 *
	 * **Handed back because a caller with art finally has somewhere to put it**, which is what this slot has
	 * been waiting for since the tiles were built: `addTile` fills it with the tile's own card colour and
	 * paints nothing onto it. The art goes *inside* this rather than replacing it — see the note beside its
	 * creation for why turning it into an `ImageLabel` would bring the mat back — so a caller adds a child
	 * sized to it and changes nothing else. There are two such callers, and they are the two kinds of art this
	 * project has: {@link addIcon} for a power, {@link addTrailStrip} for a trail.
	 */
	readonly art: Frame;
	/** The name bar's label. */
	readonly nameLabel: TextLabel;
	/** The status line over the artwork — `Owned`/`Locked`, a goal, a price. */
	readonly statusLabel: TextLabel;
	/**
	 * The name bar along the bottom of the tile.
	 *
	 * **Returned because the inventory marks state by *filling* it, which is where the marker went when the
	 * tile's outline was removed.** A tile has no border any more — see {@link addTile} — so the only solid
	 * field of colour on one is its name bar, and state is a fill rather than an outline. That is also the
	 * language the tab strip already speaks, where the selected tab is told apart by its fill and nothing is
	 * drawn round it. The accent still means one thing and still appears on one tile at a time: `addTile` draws
	 * every bar in `trough`, and a caller that wants to mark a tile writes the accent into this.
	 */
	readonly nameBar: Frame;
}

/**
 * `19201` as `19,201`.
 *
 * Peeled off the right, one character at a time, because that is the only end that is fixed: grouping
 * from the left gives `192,01` for a five-digit number, which is how a coin balance ends up looking
 * like a typo.
 */
export function withCommas(value: number): string {
	let digits = string.format("%d", math.floor(math.abs(value)));
	let grouped = "";
	let count = 0;

	while (digits !== "") {
		grouped = string.sub(digits, -1) + grouped;
		digits = string.sub(digits, 1, -2);
		count += 1;
		if (count % 3 === 0 && digits !== "") grouped = "," + grouped;
	}

	return value < 0 ? "-" + grouped : grouped;
}

/**
 * Push `z` onto every `GuiObject` beneath `root`.
 *
 * **Not optional, and not tidiness.** Roblox sorts `GuiObject`s by `ZIndex` and only draws a child
 * above its parent when the child's `ZIndex` is at least the parent's — so raising the panel to
 * `PANEL_Z_INDEX` to lift it over the other HUDs also paints its own opaque background *over* every
 * child. Every descendant has to carry the same number; then draw order falls back to the hierarchy
 * and children sit on top of their own parent again.
 *
 * Called by the panel *after* its bands are built, because it walks what exists.
 */
export function raiseZIndex(root: Instance, z: number): void {
	for (const descendant of root.GetDescendants()) {
		if (descendant.IsA("GuiObject")) descendant.ZIndex = z;
	}
}

/**
 * Let every label that has a definite width wrap, minus the exceptions below.
 *
 * **A rule rather than a list of names.** The rule is about the label's *parent*, not the label:
 *
 *   A wrapped label needs a definite width to wrap against. If its parent sizes itself to its
 *   contents, the two are each waiting on the other — a measurement cycle that Roblox resolves by
 *   collapsing the label to zero width. That is how the `Shop` title once rendered as nothing at all,
 *   sitting as it does in a header group with an automatic width.
 *
 * Having a parent whose *width* is automatic *is* that condition, so it is read directly and every
 * label in the tree is classified correctly by construction. Excluding labels by name was the earlier
 * shape of this and it does not survive a second panel: the header's balance figure sits in a group
 * that sizes itself to its contents, and would have collapsed to nothing the moment it was wrapped.
 *
 * **`AutomaticSize` is one value, not a pair of axes**, so "the width is automatic" is `X` or `XY` and
 * not a read of a `.X` field — the height being automatic is beside the point.
 *
 * **A label that scales to fit its box is skipped too, and that is the same rule read the other way.**
 * Every label on a tile carries `TextScaled`, because a tile is a fixed box whose width comes from the
 * grid — the tiles are the one place in these panels where a name cannot be given the room it wants.
 * Text that scales and text that wraps are two answers to one problem, and they cannot both be on: a
 * wrapping label inside a fixed-height bar is a clipped label.
 */
export function wrapLabels(root: Instance): void {
	for (const descendant of root.GetDescendants()) {
		if (!descendant.IsA("TextLabel")) continue;
		if (descendant.Name === TITLE_NAME) continue;
		if (descendant.TextScaled) continue;

		const parent = descendant.Parent;
		if (parent !== undefined && parent.IsA("GuiObject")) {
			const automatic = parent.AutomaticSize;
			if (automatic === Enum.AutomaticSize.X || automatic === Enum.AutomaticSize.XY) continue;
		}

		descendant.TextWrapped = true;
	}
}

/**
 * The panel itself: the surface, its border, its responsive bounds, and the vertical band list.
 *
 * **The bands stack themselves and the shelf takes the remainder** — this is what replaces a
 * `CONTENT_TOP` / `CONTENT_HEIGHT_OFFSET` pair, which has to be recomputed by hand by anyone who
 * changes a band. `Padding` is zero because the bands run edge to edge; each one insets its own
 * contents instead. `Center` is the cross-axis equivalent of `align-items: stretch`.
 *
 * The responsive bounds come from `addViewportConstraint`, the shared helper, so the phone cap is a
 * fraction of the viewport rather than a pixel count — see {@link PANEL_MIN_PIXELS} for the bug that
 * distinction exists to prevent.
 */
export function addPanelFrame(
	scope: Fusion.Scope<unknown>,
	theme: HudTheme,
	name: string,
	visible: Fusion.UsedAs<boolean>,
	pattern?: string,
): Frame {
	const sheet = Fusion.New(scope, "Frame")({
		Name: name,
		Size: SHOP_CONFIG.PANEL_SIZE,
		AnchorPoint: new Vector2(0.5, 0.5),
		Position: UDim2.fromScale(0.5, 0.5),
		BackgroundColor3: theme.colors.panel,
		BackgroundTransparency: 0,
		BorderSizePixel: 0,
		Visible: visible,
		ZIndex: SHOP_CONFIG.PANEL_Z_INDEX,
	});

	Fusion.New(scope, "UICorner")({ Parent: sheet, CornerRadius: new UDim(0, PANEL_CORNER_RADIUS) });
	Fusion.New(scope, "UIStroke")({
		Parent: sheet,
		Color: theme.colors.border,
		Thickness: 1,
		ApplyStrokeMode: Enum.ApplyStrokeMode.Border,
	});

	// **The panel is the highest thing in the client, so it takes the deepest shadow.** It floats over
	// the game world *and* over every HUD, including the toast column it covers when a player opens it —
	// which is the job the shadow is doing rather than decoration: a panel with no shadow reads as
	// another layer of the interface rather than as something laid on top of it.
	//
	// **One shadow per panel, not one per tile**, and that is the answer to "how many instances is this"
	// that the brief asks for: `addTile` is called once per item in the shop, so a shadow there would be
	// dozens of instances in a grid, most of them behind a scrolled-out row and all of them in the tree
	// whether the panel is visible or not. The tiles carry no depth of their own at all — **not even an
	// outline**, see `addTile` — so this is the only thing raised inside a panel.
	addElevation(scope, sheet, theme, "PANEL");

	addViewportConstraint(scope, sheet, { min: PANEL_MIN_PIXELS, max: SHOP_CONFIG.PANEL_MAX_SIZE });

	// **The decoration layer, and the reason this function builds two frames instead of one.** A
	// full-rectangle `GuiObject` child of a frame that owns a `UIListLayout` is *laid out*: the list
	// positions it and reserves its height, so a background sized `(1, 1)` consumes the whole panel and
	// pushes every band off the bottom. That is measured rather than assumed — three 4-pixel diagnostic
	// bars in `MatchStatsController` each shifted their siblings down by exactly four pixels — and it is
	// the reason a panel could not have a tiled backdrop until now.
	//
	// **So the fill stays on the sheet, and everything that is *stacked* moves into a `Content` frame.**
	// The sheet keeps the corner, the hairline, the shadow and the viewport constraint, because those are
	// properties of the visible rectangle; the list layout moves down one level, where its only children
	// are the bands. A decorated layer between them is then simply another child of the sheet, which no
	// layout touches.
	//
	// **`pattern` is a texture id and nothing else**, so the shape a caller has to know is one string: a
	// **16×16 PNG uploaded as a `Decal`/`Image`**, dots on a transparent background. `TileSize` matches
	// the art so one dot is one dot, and `ImageTransparency` is high because this is a backdrop rather
	// than something to read. **Transparent pixels are uploaded as black**, so the art needs its alpha
	// kept *and* an alpha-bleed pass — see `images.config.ts`, which records that the same mistake drew a
	// white box around every ability icon.
	if (pattern !== undefined) {
		const dots = Fusion.New(scope, "ImageLabel")({
			Name: "Pattern",
			Parent: sheet,
			Size: UDim2.fromScale(1, 1),
			BackgroundTransparency: 1,
			Image: pattern,
			ImageTransparency: 0.85,
			ScaleType: Enum.ScaleType.Tile,
			TileSize: UDim2.fromOffset(PATTERN_TILE, PATTERN_TILE),
			// **The same level as the sheet, so the tree decides** — see `panelSheet` for the whole of that
			// rule. Below `PANEL_Z_INDEX` it would be drawn behind the sheet's own opaque fill and vanish.
			ZIndex: SHOP_CONFIG.PANEL_Z_INDEX,
		});

		// Because the sheet does not clip: a rounded panel with a square backdrop would show four corners.
		Fusion.New(scope, "UICorner")({ Parent: dots, CornerRadius: new UDim(0, PANEL_CORNER_RADIUS) });
	}

	const content = Fusion.New(scope, "Frame")({
		Name: PANEL_CONTENT_NAME,
		Parent: sheet,
		Size: UDim2.fromScale(1, 1),
		BackgroundTransparency: 1,
		ZIndex: SHOP_CONFIG.PANEL_Z_INDEX,
	});

	Fusion.New(scope, "UIListLayout")({
		Parent: content,
		FillDirection: Enum.FillDirection.Vertical,
		SortOrder: Enum.SortOrder.LayoutOrder,
		HorizontalAlignment: Enum.HorizontalAlignment.Center,
		Padding: new UDim(0, 0),
	});

	return content;
}

/**
 * **The visible rectangle a panel's content frame belongs to** — the sheet, which is the content's parent.
 *
 * A panel is two frames now (see {@link addPanelFrame}), and the two pieces of code that need the outer one are
 * the two below: `mountPanel`, which has to put the *sheet* on the screen, and a caller that wants to paint the
 * paper, since a `UIGradient` on a frame with `BackgroundTransparency = 1` paints nothing. **A function rather
 * than a field on the content frame**, because the content frame is a plain `Frame` that the bands and the
 * `UIListLayout` both live in, and hanging a back-reference off it would be a second thing holding the tree
 * together.
 */
export function panelSheet(content: Frame): Frame | undefined {
	const parent = content.Parent;

	return parent !== undefined && parent.IsA("Frame") ? parent : undefined;
}

/**
 * **Puts a panel on the screen** — the sheet, given the content frame every band was parented to.
 *
 * **This is a helper rather than `panel.Parent = gui` at each call site for one reason: that line stopped being
 * the right one.** With a single frame, "the thing I hold" and "the thing that becomes a child of the `ScreenGui`"
 * were the same object; with two, the content frame is what a caller holds and the sheet is what must be
 * parented. Writing `content.Parent = gui` at three call sites would have *moved the content out of the panel and
 * left the panel nowhere* — a panel that is built correctly and never appears, which is the worst shape of this
 * class of bug. See {@link panelSheet}.
 *
 * **Still the last statement in each caller's mount**, and `content`'s own children are already complete by the
 * time it is called, which is the property those comments were protecting.
 */
export function mountPanel(content: Frame, into: Instance): void {
	const sheet = panelSheet(content);

	if (sheet !== undefined) sheet.Parent = into;
}

/**
 * One horizontal band of a panel, insetting its own contents.
 *
 * Horizontally a scale inset — `SHOP_CONFIG.PAD_X` — so the side margins track the panel's width.
 * Vertically a pixel one, and that is forced rather than chosen: a scale inset on a band that is
 * sizing itself to its contents would be a fraction of the height it is helping to determine, which
 * is a cycle.
 */
export function addBand(scope: Fusion.Scope<unknown>, parent: Frame, order: number): Frame {
	const band = Fusion.New(scope, "Frame")({
		Name: "Band",
		Parent: parent,
		// Width from the panel, height from its own contents — there is no band height constant.
		Size: new UDim2(1, 0, 0, 0),
		AutomaticSize: Enum.AutomaticSize.Y,
		LayoutOrder: order,
		BackgroundTransparency: 1,
	});
	Fusion.New(scope, "UIPadding")({
		Parent: band,
		PaddingTop: new UDim(0, SHOP_CONFIG.PAD_Y),
		PaddingBottom: new UDim(0, SHOP_CONFIG.PAD_Y),
		PaddingLeft: new UDim(SHOP_CONFIG.PAD_X, 0),
		PaddingRight: new UDim(SHOP_CONFIG.PAD_X, 0),
	});

	return band;
}

/**
 * The header band: the close control and the panel's title on the left, and a group for whatever the
 * panel puts on the right.
 *
 * Returns that right-hand group — the caller adds its own pill to it — because that is the only part
 * of a header the two panels disagree about. The title is named {@link TITLE_NAME} so `wrapLabels`
 * can find it, and it is the one label here given `wrap: false`: its parent sizes itself to its
 * contents, which is the measurement cycle a wrapped label cannot survive.
 */
export function addHeaderBand(
	scope: Fusion.Scope<unknown>,
	theme: HudTheme,
	parent: Frame,
	order: number,
	title: string,
	onClose: () => void,
): Frame {
	const band = Fusion.New(scope, "Frame")({
		Name: "Header",
		Parent: parent,
		Size: new UDim2(1, 0, 0, 0),
		AutomaticSize: Enum.AutomaticSize.Y,
		LayoutOrder: order,
		BackgroundTransparency: 1,
	});
	Fusion.New(scope, "UIPadding")({
		Parent: band,
		PaddingTop: new UDim(0, SHOP_CONFIG.PAD_Y),
		PaddingBottom: new UDim(0, SHOP_CONFIG.PAD_Y),
		PaddingLeft: new UDim(SHOP_CONFIG.PAD_X, 0),
		PaddingRight: new UDim(SHOP_CONFIG.PAD_X, 0),
	});

	const left = Fusion.New(scope, "Frame")({
		Name: "Left",
		Parent: band,
		Size: new UDim2(0, 0, 1, 0),
		AutomaticSize: Enum.AutomaticSize.X,
		BackgroundTransparency: 1,
	});
	Fusion.New(scope, "UIListLayout")({
		Parent: left,
		FillDirection: Enum.FillDirection.Horizontal,
		VerticalAlignment: Enum.VerticalAlignment.Center,
		SortOrder: Enum.SortOrder.LayoutOrder,
		Padding: new UDim(0, SHOP_CONFIG.HEADER_GAP),
	});

	const close = Button(scope, {
		label: "X",
		size: "small",
		color: "error",
		layoutOrder: 1,
		onActivate: onClose,
	});
	close.Parent = left;

	/**
	 * **The close button, repainted from the theme it was handed.**
	 *
	 * `Button` resolves `color: "error"` against **big-ui's own palette**, which this project no longer draws with —
	 * so without this the one button in the header would be the only light-mode object left in a dark panel. Its
	 * structure is what can be relied on: the button is the surface, its label is the button's own `Text` or a child
	 * `TextLabel`, and its hairline is a `UIStroke` child. Same three writes as `DockController` makes for its two
	 * buttons, and the same reason.
	 *
	 * **The fill is the palette's red** (`error`), not the cyan accent: closing a panel is the one destructive thing
	 * in the shop, and the red is what this palette keeps for that. On a near-black sheet it reads as a warning
	 * rather than as a brand colour.
	 */
	close.BackgroundColor3 = theme.colors.error;
	close.BackgroundTransparency = 0;
	// **`onAccent` rather than `textPrimary`** — this button's face is the theme's red, so its label wants the ink
	// that is meant for a filled surface. On the light palette that is white, which is the red-button-with-white-X
	// the panel has always had; `textPrimary` here would have been near-black on red, which is a label that reads as
	// a smudge rather than as a control.
	close.TextColor3 = theme.colors.onAccent;
	close.TextTransparency = 0;

	for (const descendant of close.GetDescendants()) {
		if (!descendant.IsA("TextLabel")) continue;

		descendant.TextColor3 = theme.colors.onAccent;
		descendant.TextTransparency = 0;
	}

	const titleLabel = Text(scope, { text: title, variant: "h4", wrap: false });
	titleLabel.Name = TITLE_NAME;
	titleLabel.TextColor3 = theme.colors.textPrimary;
	// Hugs its own text rather than filling its parent — the h4 line box decides the band's height.
	titleLabel.Size = UDim2.fromOffset(0, 0);
	titleLabel.AutomaticSize = Enum.AutomaticSize.XY;
	titleLabel.LayoutOrder = 2;
	titleLabel.Parent = left;

	// The right group is pinned to the far edge by its anchor rather than placed by the row's layout,
	// which is what keeps it from fighting the title for the middle of a narrow panel.
	const right = Fusion.New(scope, "Frame")({
		Name: "Right",
		Parent: band,
		Size: UDim2.fromOffset(0, 0),
		AutomaticSize: Enum.AutomaticSize.XY,
		AnchorPoint: new Vector2(1, 0.5),
		Position: new UDim2(1, 0, 0.5, 0),
		BackgroundTransparency: 1,
	});
	Fusion.New(scope, "UIListLayout")({
		Parent: right,
		FillDirection: Enum.FillDirection.Horizontal,
		VerticalAlignment: Enum.VerticalAlignment.Center,
		SortOrder: Enum.SortOrder.LayoutOrder,
		Padding: new UDim(0, SHOP_CONFIG.HEADER_GAP),
	});

	return right;
}

/**
 * A small rounded well for one figure — the coin balance, a count of owned items.
 *
 * Hugs its contents on both axes, so it needs no width and no height from the caller; the padding is
 * equal on all four sides because there is no excess to distribute.
 */
export function addPill(scope: Fusion.Scope<unknown>, theme: HudTheme, parent: Frame, order: number): Frame {
	const pill = Fusion.New(scope, "Frame")({
		Name: "Pill",
		Parent: parent,
		Size: new UDim2(0, 0, 0, 0),
		AutomaticSize: Enum.AutomaticSize.XY,
		BackgroundColor3: theme.colors.card,
		BorderSizePixel: 0,
		LayoutOrder: order,
	});
	Fusion.New(scope, "UICorner")({ Parent: pill, CornerRadius: new UDim(0, 6) });
	Fusion.New(scope, "UIPadding")({
		Parent: pill,
		PaddingTop: new UDim(0, 4),
		PaddingBottom: new UDim(0, 4),
		PaddingLeft: new UDim(0, 8),
		PaddingRight: new UDim(0, 10),
	});
	Fusion.New(scope, "UIListLayout")({
		Parent: pill,
		FillDirection: Enum.FillDirection.Horizontal,
		VerticalAlignment: Enum.VerticalAlignment.Center,
		SortOrder: Enum.SortOrder.LayoutOrder,
		Padding: new UDim(0, 6),
	});

	return pill;
}

/**
 * A coloured disc standing in for an icon. No asset behind it.
 *
 * The leaf-swap rule applies here as much as anywhere: a `Frame` and an `ImageLabel` are both
 * `GuiObject`s, so replacing this with a picture later is a change to one class name and nothing
 * around it moves.
 */
export function addGlyph(scope: Fusion.Scope<unknown>, colour: Color3, parent: Instance, order: number): void {
	const glyph = Fusion.New(scope, "Frame")({
		Name: "Glyph",
		Parent: parent,
		Size: UDim2.fromOffset(16, 16),
		BackgroundColor3: colour,
		BorderSizePixel: 0,
		LayoutOrder: order,
	});
	Fusion.New(scope, "UICorner")({ Parent: glyph, CornerRadius: new UDim(1, 0) });
}

/**
 * The tab strip: a row of coloured buttons, one selected, sized from how many there are.
 *
 * **The width is derived from the tab count so the strip fills the row exactly.** A fixed fraction
 * would leave a two-tab strip half empty and a three-tab strip three-fifths full — which is why
 * `SHOP_CONFIG.TAB_WIDTH_SCALE` (sized for the mock's five tabs) is not used here.
 *
 * A tab is a `TextButton` rather than a big-ui `Button` because it needs an arbitrary colour and a
 * picture slot that big-ui's `Button` has no props for. That slot is kept — a placeholder rectangle
 * with no asset — because it is what gives the strip its shape, and it is a leaf: an `ImageLabel` is
 * what goes there the day there is art for one.
 *
 * Returns the band, so a caller with nothing to show can hide the whole strip.
 */
export function addTabStrip<T extends string>(
	scope: Fusion.Scope<unknown>,
	theme: HudTheme,
	parent: Frame,
	order: number,
	tabs: ReadonlyArray<{ readonly name: T }>,
	current: Fusion.Value<T>,
	onSelect?: (name: T) => void,
): Frame {
	const band = Fusion.New(scope, "Frame")({
		Name: "TabRow",
		Parent: parent,
		// Sized by the tabs it holds — each is a fixed touch height — so there is no band height
		// constant, and `LayoutOrder` is what puts it after the header.
		Size: new UDim2(1, 0, 0, 0),
		AutomaticSize: Enum.AutomaticSize.Y,
		LayoutOrder: order,
		BackgroundColor3: theme.colors.card,
		BorderSizePixel: 0,
	});
	Fusion.New(scope, "UIPadding")({
		Parent: band,
		PaddingTop: new UDim(0, SHOP_CONFIG.PAD_Y),
		PaddingBottom: new UDim(0, SHOP_CONFIG.PAD_Y),
		PaddingLeft: new UDim(SHOP_CONFIG.PAD_X, 0),
		PaddingRight: new UDim(SHOP_CONFIG.PAD_X, 0),
	});
	Fusion.New(scope, "UIListLayout")({
		Parent: band,
		FillDirection: Enum.FillDirection.Horizontal,
		VerticalAlignment: Enum.VerticalAlignment.Center,
		SortOrder: Enum.SortOrder.LayoutOrder,
		Padding: new UDim(0, SHOP_CONFIG.TAB_GAP),
	});

	const width = (1 - (tabs.size() - 1) * TAB_GAP_SCALE) / tabs.size();

	tabs.forEach((tab, index) => {
		// **The selected tab is the light one and the rest are dark, which is the whole of the treatment.**
		// Every tab used to be its own hue at full strength, with the selected one merely *less transparent*
		// than the others — a 0.35 difference on four similar light colours, which is not a difference anybody
		// can see. An inversion is the one signal that survives a glance at a strip of five, and it is what the
		// reference does.
		//
		// **Light for selected rather than dark**, decided on what the strip sits on: the band behind it and the
		// panel under that are both light surfaces, so a dark selected tab would be a hole in a light page while
		// the light one reads as the tab being *raised* out of the row — the same direction the tiles' elevation
		// runs in.
		//
		// **Two theme colours, both already there**: `panel` is the paper the panel is made of, and `trough` is
		// the theme's near-black, already used for the tile name bars and the progress wells. No new colour was
		// needed for the inversion, which is the point — a light theme has both ends of the scale in it already.
		const selected = Fusion.Computed(scope, (use) => use(current) === tab.name);

		const button = Fusion.New(scope, "TextButton")({
			Name: `${tab.name}Tab`,
			Parent: band,
			// Width is a fraction of the row so the tabs track the panel; height is a touch target and
			// stays in pixels on purpose — see `SHOP_CONFIG.TAB_HEIGHT`.
			Size: new UDim2(width, 0, 0, SHOP_CONFIG.TAB_HEIGHT),
			BackgroundColor3: Fusion.Computed(scope, (use) => (use(selected) ? theme.colors.panel : theme.colors.trough)),
			// The transparency step is gone: an inversion does not need to be softened as well, and leaving the
			// old 0.35 on the unselected tabs would make them a dark *grey* on a dark page rather than a tab.
			BackgroundTransparency: 0,
			// **Off, and this is a real bug rather than tidiness.** These are hand-built `TextButton`s, not
			// big-ui's, so the engine's own hover-and-press darkening was still on — and it fights the scale
			// tween below over the same pixels, which reads as the tab flickering rather than as being pressed.
			// The brief's context says `AutoButtonColor` is already false everywhere; that is true of big-ui's
			// buttons and was not true here.
			AutoButtonColor: false,
			Text: "",
			LayoutOrder: index + 1,
			[Fusion.OnEvent("Activated")]: () => {
				current.set(tab.name);
				if (onSelect !== undefined) onSelect(tab.name);
			},
		});
		Fusion.New(scope, "UICorner")({ Parent: button, CornerRadius: new UDim(0, 5) });

		// **One hairline for every tab, selected or not, and the selection is the fill.** The selected tab used
		// to carry a 2px line in its slot's colour on top of the inversion, and that line was doing two jobs
		// badly: it was the selection signal *and* the slot's identity, and the colours asked to be both were
		// hard to see against the fills they sat on — `coin` and `warning` are the same amber, and two of the
		// four tabs therefore had no identity to signal with. The inversion is the signal (a light tab among
		// dark ones is unmissable at a glance) and the line is back to being what a line is for: an edge.
		Fusion.New(scope, "UIStroke")({
			Parent: button,
			Color: theme.colors.border,
			Thickness: 1,
			Transparency: 0.5,
		});

		// The picture slot, kept for its shape rather than its content — see the doc above. **It dims on the
		// unselected tabs**, because a bright box on a near-black tab is the loudest thing in the strip and it
		// would be competing with the one tab that is supposed to stand out.
		//
		// **The fill *is* the placeholder, and the day there is art it has to go.** This rectangle is what the
		// slot is while nothing is in it — the light plate between the tab's edge and its label — so the colour
		// and the two transparencies are the design rather than a leftover. But art dropped into this
		// `ImageLabel` would sit *on top* of that plate, and a bright fill behind a picture is a box drawn
		// around it. When an id arrives, this line becomes `BackgroundTransparency: 1` and the tab carries the
		// picture alone; if the plate is still wanted behind it, it becomes a `Frame` underneath instead.
		const image = Fusion.New(scope, "ImageLabel")({
			Name: "Image",
			Parent: button,
			Position: UDim2.fromOffset(3, 3),
			Size: new UDim2(1, -6, 1, -6),
			BackgroundColor3: theme.colors.card,
			BackgroundTransparency: Fusion.Computed(scope, (use) => (use(selected) ? 0.2 : 0.8)),
			BorderSizePixel: 0,
		});
		Fusion.New(scope, "UICorner")({ Parent: image, CornerRadius: new UDim(0, 4) });

		const label = Text(scope, { text: tab.name, variant: "subtitle2", wrap: false });
		label.Size = new UDim2(1, 0, 0, 18);
		label.Position = new UDim2(0, 0, 1, -21);
		label.AutomaticSize = Enum.AutomaticSize.None;
		label.TextXAlignment = Enum.TextXAlignment.Center;
		// Scaling rather than wrapping, because the label sits in a tab whose width shrinks with the
		// panel: text that scales gets smaller, text that wraps gets a second line clipped by the tab.
		label.TextScaled = true;
		Fusion.New(scope, "UITextSizeConstraint")({ Parent: label, MinTextSize: 8, MaxTextSize: 14 });
		label.Parent = button;

		// **The text inverts with the fill, and it has to be reactive rather than set once.** `textSecondary` is
		// the text colour for a light surface — which the selected tab is — and `onAccent` is its inverse, which
		// is what the near-black unselected tabs take. The two are the theme's rule read straight across; see the
		// pair's docs in `hudTheme`. Written through `Hydrate` because a `Text` built by big-ui reads its props at
		// construction.
		Fusion.Hydrate(scope, label)({
			TextColor3: Fusion.Computed(scope, (use) =>
				use(selected) ? theme.colors.textSecondary : theme.colors.onAccent,
			),
		});

		// **The tabs get the same response as everything else pressable**, which is what makes one shared helper
		// worth having: the strip is a row of `TextButton`s that this module built, so it is exactly the case the
		// helper's `AutoButtonColor` line exists for. `visual` is left out deliberately — the tab *is* the thing
		// that is drawn and the thing that is clicked, so the button scales itself.
		wireInteraction(scope, button);
	});

	return band;
}

/**
 * The content band and one pane of it.
 *
 * All the panes are built at mount and only `Visible` changes, which is the arrangement these panels
 * have always used and the reason they stay cheap: big-ui components take their contents at
 * construction, so a pane that repopulated itself on a tab click would be torn down and rebuilt every
 * time. Static shelves and a computed `Visible` each is simpler and cheaper than either.
 */
export function addContentBand(scope: Fusion.Scope<unknown>, parent: Frame, order: number): Frame {
	const content = Fusion.New(scope, "Frame")({
		Name: "Content",
		Parent: parent,
		// No height and no position of its own: the panel's list layout stacks it after the bands, and
		// the flex item below hands it whatever is left.
		Size: new UDim2(1, 0, 0, 0),
		LayoutOrder: order,
		BackgroundTransparency: 1,
		// A backstop. The bands are opaque strips stacked above one another, so anything that escapes
		// this band does not just look wrong — the next band is drawn over it.
		ClipsDescendants: true,
	});
	Fusion.New(scope, "UIFlexItem")({
		Parent: content,
		// `flex: 1`: grow into the remaining space, and nothing else on a panel flexes.
		FlexMode: Enum.UIFlexMode.Fill,
	});
	Fusion.New(scope, "UIPadding")({
		Parent: content,
		PaddingTop: new UDim(0, SHOP_CONFIG.PAD_Y),
		PaddingBottom: new UDim(0, SHOP_CONFIG.PAD_Y),
		PaddingLeft: new UDim(SHOP_CONFIG.PAD_X, 0),
		PaddingRight: new UDim(SHOP_CONFIG.PAD_X, 0),
	});

	return content;
}

/**
 * One pane of a content band: a shelf filling it, visible only while its tab is the one selected.
 *
 * The `Visible` passed in reads the caller's own tab value and nothing else, so switching tabs is one
 * value write and no tree work at all.
 */
export function addPane(
	scope: Fusion.Scope<unknown>,
	content: Frame,
	name: string,
	order: number,
	visible: Fusion.UsedAs<boolean>,
): Frame {
	return Fusion.New(scope, "Frame")({
		Name: name,
		Parent: content,
		Size: new UDim2(1, 0, 1, 0),
		BackgroundTransparency: 1,
		LayoutOrder: order,
		Visible: visible,
	});
}

/**
 * The grid a shelf lives in: anchored centre, capped by the config's minimum and maximum, and filled
 * by whatever tiles the caller adds.
 *
 * **The cell size is derived from the row count, and it is the one piece of arithmetic in these
 * panels — deliberately.** A `UIGridLayout` takes a fixed `CellSize`, so a grid of content-sized
 * tiles would need a cell height worked out from the tallest tile's text: a number that changes with
 * the window and with every string, and the reason tiles have fixed contents. Deriving it from how
 * many rows there are instead needs to know nothing about the contents, and it is scale arithmetic
 * rather than a position — cells and gaps come to exactly 1.0, so the layout can never wrap and
 * silently cost a column.
 */
export function addGrid(scope: Fusion.Scope<unknown>, pane: Frame, columns: number, count: number): Frame {
	const grid = Fusion.New(scope, "Frame")({
		Name: "Grid",
		Parent: pane,
		// Centred, which only becomes visible once the size constraint below clamps it on a wide
		// screen — otherwise a `Size` of 1,0 already fills the band.
		AnchorPoint: new Vector2(0.5, 0.5),
		Position: UDim2.fromScale(0.5, 0.5),
		Size: new UDim2(1, 0, 1, 0),
		BackgroundTransparency: 1,
	});
	Fusion.New(scope, "UISizeConstraint")({
		Parent: grid,
		MinSize: SHOP_CONFIG.GRID_MIN_SIZE,
		MaxSize: SHOP_CONFIG.GRID_MAX_SIZE,
	});

	const rows = math.max(1, math.ceil(count / columns));
	const cellScale = (1 - (columns - 1) * SHOP_CONFIG.GRID_GAP_SCALE) / columns;

	Fusion.New(scope, "UIGridLayout")({
		Parent: grid,
		CellSize: UDim2.fromScale(cellScale, (1 - (rows - 1) * SHOP_CONFIG.GRID_GAP_SCALE) / rows),
		CellPadding: UDim2.fromScale(SHOP_CONFIG.GRID_GAP_SCALE, SHOP_CONFIG.GRID_GAP_SCALE),
		SortOrder: Enum.SortOrder.LayoutOrder,
	});

	// The grid's own `AutomaticSize` is left alone deliberately: a `UIGridLayout` sizes its cells, not
	// itself, and asking this frame to hug its contents as well would be two answers to how tall a
	// shelf is.
	return grid;
}

/**
 * One tile: artwork, a status line, and a name bar across the bottom.
 *
 * **Tiles are fixed boxes, and that is the trade a shelf makes.** Inside a grid a tile's width comes
 * from its cell, so its contents cannot decide their own size — which is why the two labels on it
 * scale to fit rather than wrapping, and why every position here is a scale or an anchor against the
 * cell rather than a sum of what is above it. The alternative is a single column of content-sized
 * cards, and that is a different panel: it reads as a list of facts rather than as a shelf of things,
 * and this is a shop.
 *
 * Returns the status label, which is the one piece a caller writes to. The chrome is identical on
 * every shelf of every panel, which is what makes them read as one family.
 *
 * `visible` is passed in rather than assigned afterwards for the reason the whole codebase gives: a
 * graph object has to be part of the props a `New` is given to be tracked as a property, and
 * assigning one onto an instance that already exists is the shape that silently does nothing. The
 * inventory drives it from ownership, so half a shelf can be hidden without rebuilding the shelf.
 */
export function addTile(
	scope: Fusion.Scope<unknown>,
	grid: GuiObject,
	theme: HudTheme,
	name: string,
	order: number,
	visible: Fusion.UsedAs<boolean>,
	onActivate?: () => void,
): Tile {
	const tile = Fusion.New(scope, "Frame")({
		Name: name,
		Parent: grid,
		// **The tile is a box with no decoration of its own: no outline, no rounded corner, and no colour that
		// shows.** It used to be a rounded `panel`-coloured sheet wearing a 1px `border` hairline with the
		// artwork inset inside it — three nested rectangles for one item, which reads as a framed picture rather
		// than as a thing on a shelf. The face of a tile is now the artwork slot below, the name bar is drawn
		// over its bottom edge, and nothing is drawn around either.
		//
		// **The body is `card` so that it agrees with the artwork rather than peeking out from behind it.** The
		// child covers it completely, so this line is only insurance against a seam at a fractional pixel — but a
		// body colour that differed here would show as a bright edge exactly on the tile's boundary, which is the
		// mat that was removed.
		BackgroundColor3: theme.colors.card,
		BorderSizePixel: 0,
		LayoutOrder: order,
		Visible: visible,
	});

	// The picture slot, and **it is still a `Frame` now that there is art** — the sentence this comment used to
	// carry ("an `ImageLabel` the day there is art") was the wrong prediction, for the reason three lines down:
	// the fill here *is* the tile's face, so the picture is a child of it rather than a replacement for it. See
	// {@link addIcon} for a power's, and {@link addTrailStrip} for a trail's.
	//
	// **It covers the whole tile, and that is what "the grey reaches the edges" means.** It used to be inset by
	// 4px on three sides, which left the tile's own lighter colour showing as a mat around the artwork — the
	// frame that was removed. There is no inset and no corner radius now: the slot *is* the tile's face, and the
	// name bar is simply drawn over its bottom edge.
	//
	// **And the art goes *on top* of this rather than turning this into the art.** The fill here is the tile's
	// face — the thing the flattening pass exists to give every tile — so making this an `ImageLabel` with
	// `BackgroundTransparency = 1` would delete the grey the tiles were built around and bring the mat back as a
	// hole. A picture is a child of this frame, sized to it, transparent of its own.
	const art = Fusion.New(scope, "Frame")({
		Name: "Art",
		Parent: tile,
		Position: UDim2.fromOffset(0, 0),
		Size: new UDim2(1, 0, 1, 0),
		BackgroundColor3: theme.colors.card,
		BorderSizePixel: 0,
	});

	// The status line, sitting just above the name bar and over the artwork's lower edge — where the
	// mock this replaces put its price chip.
	const status = Fusion.New(scope, "Frame")({
		Name: "Status",
		Parent: tile,
		AnchorPoint: new Vector2(0, 1),
		Position: new UDim2(0, 8, 1, -(TILE_NAME_HEIGHT + 6)),
		Size: new UDim2(1, -16, 0, TILE_STATUS_HEIGHT),
		BackgroundTransparency: 1,
	});
	const statusLabel = Text(scope, { text: "", variant: "caption", wrap: false });
	statusLabel.TextColor3 = theme.colors.textSecondary;
	statusLabel.Size = new UDim2(1, 0, 1, 0);
	statusLabel.AutomaticSize = Enum.AutomaticSize.None;
	statusLabel.TextXAlignment = Enum.TextXAlignment.Center;
	statusLabel.TextYAlignment = Enum.TextYAlignment.Center;
	statusLabel.TextScaled = true;
	Fusion.New(scope, "UITextSizeConstraint")({ Parent: statusLabel, MinTextSize: 7, MaxTextSize: 12 });
	statusLabel.Parent = status;

	const nameBar = Fusion.New(scope, "Frame")({
		Name: "NameBar",
		Parent: tile,
		Position: new UDim2(0, 0, 1, -TILE_NAME_HEIGHT),
		Size: new UDim2(1, 0, 0, TILE_NAME_HEIGHT),
		// **The deepest step of the family, and the change that removes a hue from every shelf in the game.**
		// This bar was `theme.colors.accent` — the vivid blue at the top of the palette — over a grey body, so
		// every tile was two unrelated colours stacked, and a full shelf was a wall of blue on grey on white. The
		// bar is the theme's own near-black now, the grey above it is the artwork slot, and there is nothing else
		// on the tile at all — no outline, no mat, no radius.
		//
		// **The accent is not lost, it is *moved*: it is the marker, and this bar is what carries it.** A caller
		// that wants to mark a tile writes the accent into this frame's `BackgroundColor3` (see the `Tile`
		// interface), so the colour the bar is given here is the *unmarked* state. A colour used on every tile
		// cannot also say "this one", and one that only ever appears on the marked tile can.
		BackgroundColor3: theme.colors.trough,
		BorderSizePixel: 0,
	});
	// **No corner radius on the bar either.** A rounded bar sitting on a square grey face leaves a sliver of grey
	// in each bottom corner — the same mat the artwork's radius produced at the top — and a tile of rounded
	// pieces inside a square outline reads as a stack of cards rather than as one object.

	const nameLabel = Text(scope, { text: name, variant: "subtitle2", wrap: false });
	// **One ink for both states, which the light palette allows and the dark one did not.** The bar is the theme's
	// near-black and the marker is a mid blue, so `onAccent` — white — reads on both. The version of this line that
	// tracked the bar's fill was written for the neon panel, where the marker is bright cyan and no single ink works;
	// with the panels back on the light sheet there is nothing to track.
	nameLabel.TextColor3 = theme.colors.onAccent;
	nameLabel.Size = new UDim2(1, -8, 1, 0);
	nameLabel.Position = UDim2.fromOffset(4, 0);
	nameLabel.AutomaticSize = Enum.AutomaticSize.None;
	nameLabel.TextXAlignment = Enum.TextXAlignment.Center;
	nameLabel.TextYAlignment = Enum.TextYAlignment.Center;
	nameLabel.TextScaled = true;
	Fusion.New(scope, "UITextSizeConstraint")({ Parent: nameLabel, MinTextSize: 8, MaxTextSize: 14 });
	nameLabel.Parent = nameBar;

	if (onActivate !== undefined) {
		// **A transparent button over the whole tile, created last so it is the topmost child.** A `Frame`
		// does not raise `Activated`, so a clickable tile needs a button — and laying it *over* the tile
		// rather than turning the tile into one leaves the artwork and the name bar exactly as the shop draws
		// them, which is what keeps the two panels' tiles one family. `ZIndex` is left at the
		// default on purpose: `raiseZIndex` levels every descendant of a panel to the same number after the
		// build, so what decides the hit target is child order within the tile, and this is the last child.
		// `AutoButtonColor` is off because a shelf of tiles blinking under the mouse is noise on a panel
		// where the click's whole answer is the tile's name bar changing colour.
		const hit = Fusion.New(scope, "TextButton")({
			Name: "Hit",
			Parent: tile,
			Size: new UDim2(1, 0, 1, 0),
			BackgroundTransparency: 1,
			Text: "",
			AutoButtonColor: false,
		});
		scope.push(hit.Activated.Connect(onActivate));

		// **The tile is what moves, not the button**, which is the whole reason `visual` exists on the
		// interaction options: the `Hit` overlay is invisible, so a `UIScale` on it would scale a rectangle
		// nobody can see. The events still come from the button, because the button is the only instance here
		// that receives them.
		//
		// **No shadow, deliberately**, and that is the answer the brief's cost section asks for. A tile's depth
		// is its outline; a cast shadow per tile would be dozens of instances in a grid — every one of them in
		// the tree whether its row is scrolled into view or not — and the panel they sit on already floats above
		// the game world with the deepest shadow in the client. The scale and the two tones are a complete
		// response without one.
		//
		// **A locked tile never reaches this line**, because there is no `hit` button unless the caller gave an
		// activation. That is how "this cannot be pressed" is said: by the absence of a thing to wire, rather
		// than by a flag the helper has to check.
		wireInteraction(scope, hit, { visual: tile });
	}

	return { frame: tile, art, nameLabel, statusLabel, nameBar };
}

/** The last band: whatever one panel has to say, above nothing else. */
export function addFooterBand(scope: Fusion.Scope<unknown>, parent: Frame, order: number): Frame {
	const footer = Fusion.New(scope, "Frame")({
		Name: "Footer",
		Parent: parent,
		// Hugs what it holds rather than a footer height constant; `LayoutOrder` puts the band last.
		Size: new UDim2(1, 0, 0, 0),
		AutomaticSize: Enum.AutomaticSize.Y,
		LayoutOrder: order,
		BackgroundTransparency: 1,
	});
	Fusion.New(scope, "UIPadding")({
		Parent: footer,
		PaddingTop: new UDim(0, SHOP_CONFIG.PAD_Y),
		PaddingBottom: new UDim(0, SHOP_CONFIG.PAD_Y),
		PaddingLeft: new UDim(SHOP_CONFIG.PAD_X, 0),
		PaddingRight: new UDim(SHOP_CONFIG.PAD_X, 0),
	});
	Fusion.New(scope, "UIListLayout")({
		Parent: footer,
		FillDirection: Enum.FillDirection.Vertical,
		SortOrder: Enum.SortOrder.LayoutOrder,
		Padding: new UDim(0, SHOP_CONFIG.PAD_Y),
	});

	return footer;
}

/**
 * One line of centred text in a band, for a message that comes and goes.
 *
 * A fixed line height rather than an automatic one, because a band whose height changes when a
 * sentence appears is a band that moves the button under it — and `Visible` is the caller's business,
 * since an empty label still occupies its line box.
 */
export function addMessageLine(
	scope: Fusion.Scope<unknown>,
	theme: HudTheme,
	parent: Frame,
	order: number,
): TextLabel {
	const label = Text(scope, { text: "", variant: "body2", wrap: false });
	label.Size = new UDim2(1, 0, 0, 20);
	label.AutomaticSize = Enum.AutomaticSize.None;
	label.TextColor3 = theme.colors.textSecondary;
	label.TextXAlignment = Enum.TextXAlignment.Center;
	label.LayoutOrder = order;
	label.Parent = parent;

	return label;
}

/** The gap between the two columns of a two-column panel, in pixels. */
const COLUMN_GAP_PIXELS = 10;

/** A column heading's height, in pixels — fixed, so the shelf below it starts at a known offset. */
const COLUMN_HEADING_HEIGHT = 22;

/** A column's inner padding, in pixels. Pixel rather than scale, because a column sizes itself. */
const COLUMN_PAD = 4;

/** A shelf tile's size, in pixels — the one place these panels use a fixed box, and see `addShelf`. */
const SHELF_TILE_WIDTH = 104;
const SHELF_TILE_HEIGHT = 92;

/** The gap between shelf tiles, in pixels. Matches the cell padding of a non-scrolling grid. */
const SHELF_TILE_GAP = 8;

/**
 * The inset a clipping container gives its contents, in pixels — the shelf's own frame and the showcase's
 * holder.
 *
 * **It is deliberately the same number as `SHELF_TILE_GAP`, and that is the whole argument for it.** A
 * tile's distance from the edge of the box it sits in should be its distance from the tile beside it: the
 * boundary of a shelf is not a special case, it is one more gap. That is also why this is a *pixel* inset
 * rather than the scale one `SHOP_CONFIG.PAD_X` uses for the bands — a shelf's interior is made of pixel
 * gaps, so a boundary inset in scale would drift out of line with them as the panel widens.
 *
 * **It goes on the `ScrollingFrame` itself, and it has to, because the padding and the grid layout must be on
 * the same object — the object the tiles are parented to.** The first attempt at this put the inset on a holder
 * frame inside the shelf so that the canvas would measure it, and it **deleted every item in every shelf**: a
 * tile's box comes from its `CellSize` and `addTile` sets no `Size` of its own, so a tile whose parent has no
 * `UIGridLayout` is a zero-by-zero frame at the corner. Moving the layout onto a holder therefore requires
 * moving the *tiles* onto it too, which means `addShelf` handing back the holder rather than the scroller and
 * every caller's `ScrollingFrame` parameter changing with it — a bigger change than an inset is entitled to
 * make.
 *
 * **The cost of insetting the frame instead is at the far end of the scroll**: the canvas is measured from the
 * frame's children, and the padding moves them without being one of them, so the bottom of the inset may not
 * be reserved by the automatic canvas. A short-travelled 8px at the bottom of a shelf is affordable; a shelf
 * whose first row is cut is not, and the top of the inset is where the padding acts.
 */
const TILE_INSET = SHELF_TILE_GAP;

/**
 * The horizontal band a two-column panel lays out in: a fixed column on the left, a shelf on the right.
 *
 * **A second layout rather than a second content band, and for the reason the vertical one already has:**
 * the columns size themselves, so nothing here needs to know how wide the panel is. The left column takes
 * a fraction of this band with a pixel floor and ceiling, and the right takes the remainder through
 * `UIFlexItem` — the horizontal spelling of exactly what {@link addContentBand} does on the panel's own
 * axis.
 *
 * It is a sibling of the panes rather than a replacement for them: a tabbed panel shows one *set* of
 * columns at a time, so each tab's columns are laid out inside a pane that is `Visible` for that tab, and
 * switching tabs is still one value write and no tree work.
 */
export function addColumns(scope: Fusion.Scope<unknown>, content: Frame, name: string, order: number): Frame {
	const columns = Fusion.New(scope, "Frame")({
		Name: name,
		Parent: content,
		Size: new UDim2(1, 0, 1, 0),
		LayoutOrder: order,
		BackgroundTransparency: 1,
	});
	Fusion.New(scope, "UIListLayout")({
		Parent: columns,
		FillDirection: Enum.FillDirection.Horizontal,
		SortOrder: Enum.SortOrder.LayoutOrder,
		VerticalAlignment: Enum.VerticalAlignment.Top,
		Padding: new UDim(0, COLUMN_GAP_PIXELS),
	});

	return columns;
}

/** One column of a {@link addColumns} band: a vertical list, so a heading and its shelf stack themselves. */
function addColumn(
	scope: Fusion.Scope<unknown>,
	columns: Frame,
	name: string,
	order: number,
	size: UDim2,
): Frame {
	const column = Fusion.New(scope, "Frame")({
		Name: name,
		Parent: columns,
		Size: size,
		LayoutOrder: order,
		BackgroundTransparency: 1,
	});
	Fusion.New(scope, "UIListLayout")({
		Parent: column,
		FillDirection: Enum.FillDirection.Vertical,
		SortOrder: Enum.SortOrder.LayoutOrder,
		HorizontalAlignment: Enum.HorizontalAlignment.Center,
		Padding: new UDim(0, COLUMN_PAD),
	});
	Fusion.New(scope, "UIPadding")({
		Parent: column,
		PaddingTop: new UDim(0, COLUMN_PAD),
		PaddingBottom: new UDim(0, COLUMN_PAD),
		PaddingLeft: new UDim(0, COLUMN_PAD),
		PaddingRight: new UDim(0, COLUMN_PAD),
	});

	return column;
}

/**
 * The left column: a fixed *fraction* of the band, floored and ceilinged in pixels.
 *
 * **A fraction with a constraint rather than a pixel width, and this is the standard's own argument.**
 * The panel's width is itself a fraction of the viewport, so a pixel column would be correct on one screen
 * and wrong on every other; a scale column with a `UISizeConstraint` is correct on all of them, and the
 * floor is what stops the preview becoming a sliver on a phone — the shape `addPanelFrame` uses for the
 * panel, one level down.
 */
export function addFixedColumn(
	scope: Fusion.Scope<unknown>,
	columns: Frame,
	name: string,
	order: number,
	scale: number,
	minWidth: number,
	maxWidth: number,
): Frame {
	const column = addColumn(scope, columns, name, order, UDim2.fromScale(scale, 1));

	Fusion.New(scope, "UISizeConstraint")({
		Parent: column,
		MinSize: new Vector2(minWidth, 0),
		MaxSize: new Vector2(maxWidth, math.huge),
	});

	return column;
}

/**
 * The right column: whatever the fixed one leaves.
 *
 * `Size` is zero on both axes and the flex item is the whole of its width, which is how a `UIListLayout`
 * spells "take the rest" — see {@link addContentBand}, which is the vertical version of the same line.
 */
export function addFillColumn(
	scope: Fusion.Scope<unknown>,
	columns: Frame,
	name: string,
	order: number,
): Frame {
	const column = addColumn(scope, columns, name, order, new UDim2(0, 0, 1, 0));

	Fusion.New(scope, "UIFlexItem")({ Parent: column, FlexMode: Enum.UIFlexMode.Fill });

	return column;
}

/** A column's heading, centred over it. The only place a column is named. */
export function addColumnHeading(
	scope: Fusion.Scope<unknown>,
	theme: HudTheme,
	column: Frame,
	text: string,
	order: number,
): void {
	const label = Text(scope, { text, variant: "subtitle2", wrap: false });
	label.TextColor3 = theme.colors.textSecondary;
	label.Size = new UDim2(1, 0, 0, COLUMN_HEADING_HEIGHT);
	label.AutomaticSize = Enum.AutomaticSize.None;
	label.TextXAlignment = Enum.TextXAlignment.Center;
	label.TextYAlignment = Enum.TextYAlignment.Center;
	label.TextScaled = true;
	Fusion.New(scope, "UITextSizeConstraint")({ Parent: label, MinTextSize: 9, MaxTextSize: 16 });
	label.LayoutOrder = order;
	label.Parent = column;
}

/**
 * The scrolling shelf one column of items lives on.
 *
 * **A `ScrollingFrame` whose cells are a fixed pixel size, which is the one place in these panels that is
 * true and the exception the standard has to be argued for rather than waved through.** A scrolling canvas
 * has no scale to divide: its size is what it is *because* of its contents, so a scale cell size would be
 * a fraction of the thing the fraction was meant to determine. Fixed cells also buy the responsive
 * behaviour back for free — a `UIGridLayout` fits as many fixed cells across as the width allows and wraps
 * the rest, so the column count follows the screen on its own instead of being a number anybody chose.
 *
 * `AutomaticCanvasSize` is on the vertical axis only, so the canvas grows downwards with the grid and the
 * scrollbar appears when it has to; `CanvasSize` is zero because the automatic size is what sets it, and
 * `ElasticBehavior` is off because a shelf that rubber-bands away from the mouse is a shelf that moves under
 * a click.
 *
 * **The inset and the layout are on the same frame, and that is forced rather than tidy.** A shelf clips — it
 * has to, it scrolls — so a tile standing on the canvas's own corner is a tile with its outline, its corner and
 * its hover overscale cut off by the frame's edge, which is what "sitting flush against the shelf" is. The
 * inset therefore has to be inside that clip; but a tile's box comes from its `CellSize`, so the layout that
 * gives it one has to be on the same object as the padding, which is the object the *tiles* are parented to.
 * That rules out an inner holder frame and it rules out the tile growing its own margin; see
 * {@link TILE_INSET}, which also records what went wrong when this was attempted with a holder.
 */
export function addShelf(
	scope: Fusion.Scope<unknown>,
	column: Frame,
	theme: HudTheme,
	name: string,
	order: number,
): ScrollingFrame {
	const shelf = Fusion.New(scope, "ScrollingFrame")({
		Name: name,
		Parent: column,
		Size: new UDim2(1, 0, 0, 0),
		LayoutOrder: order,
		BackgroundTransparency: 1,
		BorderSizePixel: 0,
		ScrollBarThickness: 6,
		ScrollBarImageColor3: theme.colors.border,
		ScrollingDirection: Enum.ScrollingDirection.Y,
		CanvasSize: UDim2.fromOffset(0, 0),
		AutomaticCanvasSize: Enum.AutomaticSize.Y,
		ElasticBehavior: Enum.ElasticBehavior.Never,
	});
	Fusion.New(scope, "UIFlexItem")({ Parent: shelf, FlexMode: Enum.UIFlexMode.Fill });

	// **The inset, on this frame, because this is the frame the tiles are parented to and the grid layout below
	// is what gives them a size.** Nothing here is a wrapper: a holder would take the layout with it and leave
	// every tile a zero-by-zero frame, which is the failure {@link TILE_INSET} records. The padding moves the
	// cells in from the clip on all four sides, and the wrap width follows it — a tile can no longer start on
	// the boundary in either axis.
	Fusion.New(scope, "UIPadding")({
		Parent: shelf,
		PaddingTop: new UDim(0, TILE_INSET),
		PaddingBottom: new UDim(0, TILE_INSET),
		PaddingLeft: new UDim(0, TILE_INSET),
		PaddingRight: new UDim(0, TILE_INSET),
	});
	Fusion.New(scope, "UIGridLayout")({
		Parent: shelf,
		CellSize: UDim2.fromOffset(SHELF_TILE_WIDTH, SHELF_TILE_HEIGHT),
		CellPadding: UDim2.fromOffset(SHELF_TILE_GAP, SHELF_TILE_GAP),
		SortOrder: Enum.SortOrder.LayoutOrder,
	});

	return shelf;
}

/**
 * The larger preview of one item, for the column that shows what is being worn.
 *
 * **It is a tile, scaled up — not a render, and not a viewport.** The reference art shows spheres because
 * those are renders of the items; there is no 3D anything in a `CosmeticDef` (no asset id, no model, no
 * mesh) and no viewport in this panel, so the honest way to draw "this is the current one" is the same
 * tile treatment at a size a person can read across the panel. A `ViewportFrame` was refused rather than
 * attempted: it would have to invent geometry for a cosmetic whose def has none, and an empty viewport is
 * a worse lie than a big tile.
 *
 * **It has no name bar, and that follows from what the marker became.** The preview is the same tile the
 * shelf draws, minus the band: the item it is previewing is identified down in the shelf, where that item's
 * bar carries the accent. Saying the name twice cost the preview a third of its height to repeat an answer
 * the shelf had already given.
 *
 * The size is constrained rather than fixed so it can breathe with the column, and it is centred so it
 * does not drift to a corner when the constraint clamps it — the same reasoning `addGrid` gives.
 *
 * Returns the holder, which is what a caller would write to if the preview ever had contents of its own.
 */
/** What {@link addShowcase} hands back: the column's flex item, and the face inside it. */
export interface Showcase {
	/** The holder — the flex item that fills whatever the column leaves it, and that clips the preview. */
	readonly holder: Frame;
	/** The preview's face, and where a caller with art puts it. Full bleed, exactly as a tile's is. */
	readonly art: Frame;
}

export function addShowcase(
	scope: Fusion.Scope<unknown>,
	parent: Frame,
	theme: HudTheme,
	order: number,
): Showcase {
	const holder = Fusion.New(scope, "Frame")({
		Name: "ShowcaseHolder",
		Parent: parent,
		Size: new UDim2(1, 0, 0, 0),
		LayoutOrder: order,
		BackgroundTransparency: 1,
		// **Clipped, because the tile inside is clamped to a minimum size and the holder may be smaller
		// than it.** The size constraint is what keeps the preview readable on a wide panel; on a short one
		// the scale size falls under the floor, the constraint wins, and without this the tile would spill
		// out of its column and over the shelf beside it. A held-back pixel is the cheaper failure.
		ClipsDescendants: true,
	});
	Fusion.New(scope, "UIFlexItem")({ Parent: holder, FlexMode: Enum.UIFlexMode.Fill });

	// **The inset is inside the clip, which is the whole point of putting it here rather than on the tile.**
	// The tile below is a full-scale child of this frame, so its edges *are* the clip boundary — which is why a
	// preview reads as jammed against the bottom of its slot, and why the tile's hover overscale has nowhere to
	// go. Padding on the holder moves the boundary outwards from the tile instead of shrinking the tile within
	// it, so the tile still fills what it is given and has room around it.
	//
	// **Symmetric, because nothing about the clip is one-sided.** The tile is centred in this frame, so all
	// four of its edges meet the boundary at once — there is no axis where it is cut at one end and clear at
	// the other, so an asymmetric inset would be a guess dressed as a measurement.
	Fusion.New(scope, "UIPadding")({
		Parent: holder,
		PaddingTop: new UDim(0, TILE_INSET),
		PaddingBottom: new UDim(0, TILE_INSET),
		PaddingLeft: new UDim(0, TILE_INSET),
		PaddingRight: new UDim(0, TILE_INSET),
	});

	const tile = Fusion.New(scope, "Frame")({
		Name: "Showcase",
		Parent: holder,
		AnchorPoint: new Vector2(0.5, 0.5),
		Position: UDim2.fromScale(0.5, 0.5),
		Size: UDim2.fromScale(1, 1),
		// **The same family as `addTile`, which now means the same absence of decoration.** The showcase is a
		// shelf tile at a larger size — grey face, near-black band, nothing drawn round either — so the equipped
		// item and the items beside it read as one piece of furniture rather than as a preview and a shelf that
		// happen to be adjacent.
		BackgroundColor3: theme.colors.card,
		BorderSizePixel: 0,
	});
	Fusion.New(scope, "UISizeConstraint")({
		Parent: tile,
		MinSize: new Vector2(96, 96),
		// **The `MaxSize` of 260 is gone, and it was the whole reason the preview sat in a small box in a
		// large column.** The holder above is a flex item that fills whatever the panel leaves it, and this
		// tile is a full-scale child of it — but a ceiling in pixels meant that on any panel wider than that
		// the preview simply stopped growing and floated in the middle of its own column with a gap on all
		// four sides. The floor stays: it is what keeps the preview readable on a narrow panel, and it is the
		// case the holder's `ClipsDescendants` is there for.
	});
	// The picture slot, exactly as `addTile` has it — a `Frame`, and it stays one now that there is art: the
	// fill here is the preview's face, so a picture is a child of it. **Full bleed, like the shelf's**, and here
	// it is the whole of the preview: with no name bar over it, the face is all there is to look at.
	const art = Fusion.New(scope, "Frame")({
		Name: "Art",
		Parent: tile,
		Position: UDim2.fromOffset(0, 0),
		Size: new UDim2(1, 0, 1, 0),
		BackgroundColor3: theme.colors.card,
		BorderSizePixel: 0,
	});

	// **And there is no name bar, which is the one place the showcase deliberately departs from `addTile`.** The
	// bar's job on a shelf tile is to say *which* item the tile is; a preview has no need of it, because the item
	// it is previewing is the one wearing the accent fill down in the shelf, and the column heading above already
	// says the column is about the equipped one. What the bar cost was height — a third of the tile, on the one
	// tile in the panel whose whole purpose is to be looked at — so it is gone and the face fills that space.

	return { holder, art };
}

/**
 * The three colours one trail's ribbon is drawn in, in the direction the eye reads it — **the core, and only
 * the core.**
 *
 * Declared here rather than imported from the catalogue, which is the trick `BallTrail.CoreColors` plays for
 * the same reason: a trail def is structurally this, so the economy hands its colours to a UI builder without
 * either file importing the other, and the two cannot drift apart without the compiler saying so at the call
 * site. This module has no opinion about ids, slots or prices.
 *
 * **A def's `halo` pair is deliberately not here.** The haze is a *soft edge* around a bright one — two
 * ribbons at two spreads — and its whole job is to soften a silhouette. A strip has no silhouette any more
 * (see {@link addTrailStrip}), so a second colour over the same rectangle would be a haze drawn on a haze.
 * The pair is still read by the server, which draws both ribbons; what is not read is what nothing paints.
 */
export interface TrailStripColors {
	readonly leading: Color3;
	readonly middle: Color3;
	readonly trailing: Color3;
}

/**
 * The core's colours when nobody has equipped anything: `BALL_CONFIG`'s own three, which is what the ball a
 * player flies with no cosmetic on it is drawn in.
 *
 * **A plain object of references rather than a prepared `ColorSequence`, and that is a rule about this
 * project's loading rather than a preference** — `BallTrail.DEFAULT_CORE_COLORS` says why at length: a
 * top-level initializer that *calls a function* runs before that function's body has been assigned in the
 * emitted Luau, so a sequence built here would be `nil` and take the module down. Three property reads off a
 * table cannot fail that way, and the sequence is built inside {@link coreRamp}, which runs long after both
 * modules have loaded.
 */
const DEFAULT_CORE_COLORS: TrailStripColors = {
	leading: BALL_CONFIG.TRAIL_COLOR_LEADING,
	middle: BALL_CONFIG.TRAIL_COLOR_MIDDLE,
	trailing: BALL_CONFIG.TRAIL_COLOR_TRAILING,
};

/**
 * The core's transparency where it leaves the ball, at keypoint `0` of its segment.
 *
 * **The one number in this file that restates the server's construction rather than reading config**, and it
 * is named rather than inlined so it can be found: `BallTrail.createRibbons` writes the core's transparency
 * as the literal `0 → 1`, and neither end is a `BALL_CONFIG` entry. It is the same weight of duplication
 * {@link TrailStripColors} accepts: a fact about the shape of a trail, restated on this side of the wire
 * because the server's module is not reachable from the client's half of the tree.
 */
const CORE_HEAD_TRANSPARENCY = 0;

/**
 * How much of the wake a strip shows, as a fraction of the core's own lifetime. **Placeholder.**
 *
 * **The crop is what makes a strip read as the effect rather than as a swatch of it.** The core's colour ramp
 * has one break in it, at `TRAIL_COLOR_MIDDLE_AT`, and a rectangle showing the whole wake would put that break
 * near its left edge with the rest of the colour run packed against the far right — a picture of a wake a
 * hundred studs long, which is not a thing a shelf tile can be. Half of it is the stretch that carries the
 * information: the colour the ball is at launch, the break, and the first run of what it settles into.
 *
 * **A share of a lifetime rather than a stud count**, which is what keeps it honest on a ball of any speed:
 * the strip is not claiming a length, it is claiming an *age*, and it is the same age for every trail because
 * every trail lives `TRAIL_LIFETIME`. That is also why nothing divides by a second lifetime here any more —
 * the haze, which lives longer, is not drawn.
 */
const STRIP_WAKE = 0.5;

/**
 * The share of a strip's own length spent fading to nothing at its right edge. **Placeholder.**
 *
 * **The crop cuts the wake at an age where the effect is still half visible, so the cut has to be hidden.** A
 * gradient that simply stopped would leave a hard vertical edge at the strip's end — three times as
 * conspicuous as the trail beside it. The last fifth therefore falls to fully transparent, which is a fade
 * the *effect* does not have, over a stretch of wake the effect does not end at. It is the one place the
 * strip draws something the ball never does, and it is the price of ending the picture inside the wake
 * instead of at a real edge of one.
 */
const STRIP_EDGE_FADE = 0.18;

/**
 * The strip's fade: opaque at the ball, at whatever transparency the effect has run out to by the crop, then
 * nothing.
 *
 * **The middle keypoint is the effect's own value at the crop point rather than a chosen one.** A `Trail`'s
 * ramps run linearly in age and {@link STRIP_WAKE} is an age, so the effect's ramp read at that age is the
 * whole of the arithmetic — and it is the fade that makes the rectangle read as a wake rather than as a
 * coloured panel, because the colour alone would end at a hard vertical edge. The last keypoint is
 * {@link STRIP_EDGE_FADE}'s and belongs to the strip rather than to the effect.
 */
function stripFade(): NumberSequence {
	const atCut = CORE_HEAD_TRANSPARENCY + (1 - CORE_HEAD_TRANSPARENCY) * STRIP_WAKE;

	return new NumberSequence([
		new NumberSequenceKeypoint(0, CORE_HEAD_TRANSPARENCY),
		new NumberSequenceKeypoint(1 - STRIP_EDGE_FADE, atCut),
		new NumberSequenceKeypoint(1, 1),
	]);
}

/**
 * The core's colour ramp, moved into the crop's own coordinates.
 *
 * **Three keypoints, exactly as `BallTrail.coreLook` builds them** — the def's `leading`, its `middle` at
 * `TRAIL_COLOR_MIDDLE_AT`, its `trailing` — with only the *positions* changed: the strip spans ages `0` to
 * {@link STRIP_WAKE}, so the middle keypoint stands at `MIDDLE_AT / STRIP_WAKE` of the strip's width. **The
 * positions are the second copy of that ramp, and the one thing here that has to be kept in step with the
 * server**; the middle keypoint is dropped rather than clamped if the crop is ever retuned shorter than the
 * break, which is the only way a sequence built here could come out out of order.
 */
function coreRamp(colors?: TrailStripColors): ColorSequence {
	const look = colors ?? DEFAULT_CORE_COLORS;
	const points = [new ColorSequenceKeypoint(0, look.leading)];

	if (BALL_CONFIG.TRAIL_COLOR_MIDDLE_AT < STRIP_WAKE) {
		points.push(new ColorSequenceKeypoint(BALL_CONFIG.TRAIL_COLOR_MIDDLE_AT / STRIP_WAKE, look.middle));
	}

	points.push(new ColorSequenceKeypoint(1, look.trailing));

	return new ColorSequence(points);
}

/**
 * A trail, drawn: **the def's own colours, laid across whatever it is handed.**
 *
 * **A rectangle rather than a silhouette, and that is a reversal of this function's first shape.** It was two
 * `ImageLabel`s with a gradient each — a white PNG's *alpha* carrying the flare, the neck and the taper, so a
 * tile showed the shape a `Trail` draws — and the art never existed. What stood in for it in the meantime is
 * what showed the arrangement's cost: a `UIGradient` is blended *into* the pixels underneath it, so a picture
 * carrying colour of its own can only take a def's colours down toward its own, never take them on. What is
 * exact with no art at all is the part a player is actually choosing between — the **colours**, in the order
 * and at the ratio the ribbon shows them — so the container is painted and the shape is not drawn.
 *
 * **Why nothing is rendered, in three sentences, so it does not have to be re-litigated.** `CosmeticDef`'s
 * only appearance field is `colors`, and the thirteen trail defs differ from one another in nothing else, so a
 * rendered preview could not show a player anything this gradient does not — which is what makes drawing the
 * colours *exact* here rather than a shortcut. What a `ViewportFrame` would buy is a slot with a model to turn
 * around, and no slot has one (`ball` and `elimination` have no defs at all) — and a `Trail` does not render
 * inside a `ViewportFrame` at all, which is the finding that ended that route. The general capability
 * therefore has no second caller yet and is refused until it has one: the question is open, not answered.
 *
 * **What this is not: a still of a throw.** A `Trail` records where its attachments have been, so the real
 * thing bends with a curving throw and draws *nothing* while the ball is still — neither of which a picture
 * can say, and neither of which this says either. A shelf tile is not claiming them; watching the ball is
 * what says it.
 *
 * **No camera, no frame loop, no teardown.** Nothing here moves, so a hidden panel costs exactly nothing and
 * there is nothing to unhook. `colors` is reactive because the inventory draws what is *worn*: an equip has to
 * repaint a strip that is already in the tree, which is one write to one gradient rather than a rebuild.
 */
export function addTrailStrip(
	scope: Fusion.Scope<unknown>,
	parent: GuiObject,
	colors: Fusion.UsedAs<TrailStripColors | undefined>,
): Frame {
	const frame = Fusion.New(scope, "Frame")({
		Name: "TrailStrip",
		Parent: parent,
		Size: new UDim2(1, 0, 1, 0),
		// **White, and this is the trap the image route had, one layer along.** The gradient is blended into
		// the colour of the thing it is attached to, so a def's colours reach the screen unaltered only if the
		// field beneath them is white. `Frame`'s own default is a mid grey — `163, 162, 165` — which would take
		// the top off every trail on the shelf and leave the preview a duller thing than the ball.
		BackgroundColor3: Color3.fromRGB(255, 255, 255),
		BorderSizePixel: 0,
	});

	// The gradient is a child of the strip and not of the slot the strip sits in, because a `UIGradient`
	// applies to its parent and to nothing beneath it.
	Fusion.New(scope, "UIGradient")({
		Parent: frame,
		Color: Fusion.Computed(scope, (use) => coreRamp(use(colors))),
		Transparency: stripFade(),
	});

	return frame;
}

/**
 * A picture in a tile's face: **the real thing, where {@link addGlyph}'s disc is the stand-in for it.**
 *
 * **It is handed the slot and not the tile, and `Tile.art` is that slot** — the frame `addTile` fills with the
 * tile's own card colour, so a picture is a child of the face rather than a replacement for it, exactly as
 * {@link addTrailStrip} is. The name bar and the status line are drawn *over* that face, which is what the
 * `statusLine` flag below is about.
 *
 * **The picture is a square, centred in the face above the bands, and standing off every edge by
 * {@link ICON_MARGIN}.** The art these come from is square — `IMAGES_CONFIG.ABILITY_ICONS` records that every
 * source is 1254px square — and a tile's face is not: 104 by 92 on a shelf, and however tall the grid's
 * arithmetic made this cell in a shop, which for a shelf of three is most of the band. Stretching is therefore
 * not available and neither is filling it, because a picture sized to the whole face would put its lower edge
 * under the name bar and its shape at the mercy of today's cell size.
 *
 * **`statusLine` is how much of the face the *tile* has spoken for, and it has to be passed because it is a
 * fact about the caller and not about the picture.** A tile that writes one — "Owned", "Buy · 120 coins",
 * "Unlock by playing 25 matches" — has that sentence drawn across the middle of its face, so a picture centred
 * on the whole face would have the words over its lower half. A tile that writes none is the majority of the
 * power tiles in both panels, and reserving the band anyway costs a fifth of the smallest face either panel
 * draws — 20 of the 92 pixels a shelf tile is tall, which is the difference between a 36-pixel picture and a
 * 50-pixel one. **A caller that starts writing a status line has to come back and say so**; that is the one
 * coupling this signature asks for, and it is cheaper than the alternative of every tile reserving for a
 * sentence most of them do not have.
 *
 * **A holder for that region, rather than arithmetic on the picture itself**, because "centred in the height
 * above the bands" needs something whose middle *is* that middle — and the region is the only object here that
 * knows where it is. The holder is invisible and exists for one number. `UIAspectRatioConstraint` squares the
 * picture inside it, and `ScaleType.Fit` is the belt to that braces: with a square box and a square file there
 * is nothing left to letterbox, and an id that is *not* square is fitted inside it rather than squashed.
 *
 * **A well is deliberately not painted behind it.** These ids are the art the HUD already draws, and the slot
 * there is `theme.colors.trough` — black — for the reason `IMAGES_CONFIG.ABILITY_ICONS` sets out at length:
 * the icons were authored to sit on it, and a file carrying an opaque field shows that field on any other
 * surface. A tile's face is `theme.colors.card`, so whether these three need the alpha-bleed pass that entry
 * describes is a question for a screen — and the answer is a fill on this one object rather than a change to
 * either panel.
 *
 * **Adding a fourth power needs no edit here and none in either caller.** The two panels ask
 * `IMAGES_CONFIG.ABILITY_ICONS` for the picture as they build each tile from `POWER_ROSTER`, and that record
 * is a `Record<AbilityKind, string>` — so a power that has no id is a compile error before it can be a tile
 * with an empty face.
 */
export function addIcon(
	scope: Fusion.Scope<unknown>,
	parent: GuiObject,
	image: string,
	statusLine: boolean,
): ImageLabel {
	const occupied = statusLine ? TILE_STATUS_TOP : TILE_NAME_HEIGHT;

	const area = Fusion.New(scope, "Frame")({
		Name: "IconArea",
		Parent: parent,
		Position: UDim2.fromOffset(ICON_MARGIN, ICON_MARGIN),
		Size: new UDim2(1, -2 * ICON_MARGIN, 1, -(occupied + 2 * ICON_MARGIN)),
		BackgroundTransparency: 1,
	});

	const icon = Fusion.New(scope, "ImageLabel")({
		Name: "Icon",
		Parent: area,
		Image: image,
		BackgroundTransparency: 1,
		ScaleType: Enum.ScaleType.Fit,
		AnchorPoint: new Vector2(0.5, 0.5),
		Position: UDim2.fromScale(0.5, 0.5),
		Size: new UDim2(1, 0, 1, 0),
	});
	Fusion.New(scope, "UIAspectRatioConstraint")({
		Parent: icon,
		AspectRatio: 1,
		AspectType: Enum.AspectType.FitWithinMaxSize,
	});

	return icon;
}

/**
 * A message centred in whatever it is given, for a panel with nothing to lay out.
 *
 * Distinct from {@link addMessageLine}, which is a fixed-height line at the bottom of a band and cannot be
 * centred vertically — this one fills its parent and centres on both axes, because it is the *only* thing
 * on screen when it is used.
 */
export function addCentredMessage(
	scope: Fusion.Scope<unknown>,
	theme: HudTheme,
	parent: Frame,
	text: string,
	order: number,
): Frame {
	const holder = Fusion.New(scope, "Frame")({
		Name: "Message",
		Parent: parent,
		Size: new UDim2(1, 0, 1, 0),
		LayoutOrder: order,
		BackgroundTransparency: 1,
	});

	const label = Text(scope, { text, variant: "h5", wrap: false });
	label.AnchorPoint = new Vector2(0.5, 0.5);
	label.Position = UDim2.fromScale(0.5, 0.5);
	label.Size = new UDim2(1, -24, 0, 44);
	label.AutomaticSize = Enum.AutomaticSize.None;
	label.TextColor3 = theme.colors.textSecondary;
	label.TextXAlignment = Enum.TextXAlignment.Center;
	label.TextYAlignment = Enum.TextYAlignment.Center;
	label.TextScaled = true;
	Fusion.New(scope, "UITextSizeConstraint")({ Parent: label, MinTextSize: 10, MaxTextSize: 28 });
	label.Parent = holder;

	return holder;
}

/**
 * A wrapped explanatory line: the sentence a tab needs before a shelf of switches makes sense.
 *
 * **`AutomaticSize.Y` and a relative width, so it grows into however many lines the sentence takes.**
 * That is the opposite trade from {@link addMessageLine}, and the difference is why this is a builder of
 * its own rather than a flag on that one: a footer message must *not* grow, because a band that changes
 * height when a sentence appears moves the band above it, while an explanation must not be clipped or
 * scaled down to fit — a sentence shrunk to fit a narrow column is a sentence nobody reads. Two
 * requirements pulling opposite ways on the same property is the signal the callers should stop sharing
 * the builder, which is what this is.
 *
 * Left to the theme's own caption size rather than `TextScaled`, for the same reason: scaling is an answer
 * to "this must fit", and the answer here is "this wraps".
 */
export function addNoteLine(
	scope: Fusion.Scope<unknown>,
	theme: HudTheme,
	parent: Frame,
	text: string,
	order: number,
): TextLabel {
	// No size passed, deliberately: it is what makes `Text` set `AutomaticSize.Y` and a relative width in
	// the first place, which is the whole of what this builder wants from it.
	const label = Text(scope, { text, variant: "caption" });

	label.TextColor3 = theme.colors.textSecondary;
	label.TextXAlignment = Enum.TextXAlignment.Center;
	label.TextYAlignment = Enum.TextYAlignment.Top;
	// Scale padding, so the text never touches a column's edge on a narrow screen — the same relative-inset
	// rule the bands follow, at the one size where a pixel inset would be most of the available width.
	Fusion.New(scope, "UIPadding")({
		Parent: label,
		PaddingLeft: new UDim(0.04, 0),
		PaddingRight: new UDim(0.04, 0),
	});
	label.LayoutOrder = order;
	label.Parent = parent;

	return label;
}
