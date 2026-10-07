import { Button, Text } from "@rbxts/big-ui";
import Fusion from "@rbxts/fusion-3.0";
import { SHOP_CONFIG } from "shared/config/shop.config";
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
 * `hudToast.ts` already makes for the numbers two toasts share ("One owner for the numbers two toasts
 * have to agree on. Kept here so that changing the width moves both"), and this is the same case one
 * level up.
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

/** The gap between tabs as a fraction of the row. */
export const TAB_GAP_SCALE = 0.012;

/** A tile's name bar, in pixels — the strip across the bottom of a tile that carries its name. */
const TILE_NAME_HEIGHT = 30;

/** A tile's status line, in pixels. Sits just above the name bar, over the artwork. */
const TILE_STATUS_HEIGHT = 20;

/** The colour job a tab names. Kept as a key so the theme stays the only place a colour is chosen. */
export type TabColour = keyof HudTheme["colors"];

/** One tab: what it says, and which colour job it is. */
export interface TabDef {
	readonly name: string;
	readonly colour: TabColour;
}

/** What {@link addTile} hands back: the parts a caller writes to or restyles. */
export interface Tile {
	/** The tile box itself — for a caller outside a grid, which has to say how big it is. */
	readonly frame: Frame;
	/** The name bar's label. */
	readonly nameLabel: TextLabel;
	/** The status line over the artwork — `Owned`/`Locked`, a goal, a price. */
	readonly statusLabel: TextLabel;
	/**
	 * The tile's outline.
	 *
	 * **Returned because the inventory marks the equipped item by colouring it and nothing else.** Every
	 * tile in these panels is drawn with the same hairline, so the one that is worn says so by taking the
	 * accent colour — which is a fact the border can carry for free. A badge was refused: it would cost the
	 * tile a line of its own for something the outline already says, and a shelf of badges reads as a shelf
	 * of *states* rather than as a shelf of things, which is the shop's framing and not this panel's.
	 */
	readonly stroke: UIStroke;
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
): Frame {
	const panel = Fusion.New(scope, "Frame")({
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

	Fusion.New(scope, "UICorner")({ Parent: panel, CornerRadius: new UDim(0, 10) });
	Fusion.New(scope, "UIStroke")({
		Parent: panel,
		Color: theme.colors.border,
		Thickness: 1,
		ApplyStrokeMode: Enum.ApplyStrokeMode.Border,
	});

	addViewportConstraint(scope, panel, { min: PANEL_MIN_PIXELS, max: SHOP_CONFIG.PANEL_MAX_SIZE });

	Fusion.New(scope, "UIListLayout")({
		Parent: panel,
		FillDirection: Enum.FillDirection.Vertical,
		SortOrder: Enum.SortOrder.LayoutOrder,
		HorizontalAlignment: Enum.HorizontalAlignment.Center,
		Padding: new UDim(0, 0),
	});

	return panel;
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
	tabs: ReadonlyArray<{ readonly name: T; readonly colour: TabColour }>,
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
		const button = Fusion.New(scope, "TextButton")({
			Name: `${tab.name}Tab`,
			Parent: band,
			// Width is a fraction of the row so the tabs track the panel; height is a touch target and
			// stays in pixels on purpose — see `SHOP_CONFIG.TAB_HEIGHT`.
			Size: new UDim2(width, 0, 0, SHOP_CONFIG.TAB_HEIGHT),
			BackgroundColor3: theme.colors[tab.colour],
			BackgroundTransparency: Fusion.Computed(scope, (use) => (use(current) === tab.name ? 0 : 0.35)),
			AutoButtonColor: true,
			Text: "",
			LayoutOrder: index + 1,
			[Fusion.OnEvent("Activated")]: () => {
				current.set(tab.name);
				if (onSelect !== undefined) onSelect(tab.name);
			},
		});
		Fusion.New(scope, "UICorner")({ Parent: button, CornerRadius: new UDim(0, 5) });
		Fusion.New(scope, "UIStroke")({
			Parent: button,
			Color: theme.colors.border,
			Thickness: 1,
			Transparency: 0.5,
		});

		const image = Fusion.New(scope, "ImageLabel")({
			Name: "Image",
			Parent: button,
			Position: UDim2.fromOffset(3, 3),
			Size: new UDim2(1, -6, 1, -6),
			BackgroundColor3: theme.colors.panel,
			BackgroundTransparency: 0.2,
			BorderSizePixel: 0,
		});
		Fusion.New(scope, "UICorner")({ Parent: image, CornerRadius: new UDim(0, 4) });

		const label = Text(scope, { text: tab.name, variant: "subtitle2", wrap: false });
		label.TextColor3 = theme.colors.onAccent;
		label.Size = new UDim2(1, 0, 0, 18);
		label.Position = new UDim2(0, 0, 1, -21);
		label.AutomaticSize = Enum.AutomaticSize.None;
		label.TextXAlignment = Enum.TextXAlignment.Center;
		// Scaling rather than wrapping, because the label sits in a tab whose width shrinks with the
		// panel: text that scales gets smaller, text that wraps gets a second line clipped by the tab.
		label.TextScaled = true;
		Fusion.New(scope, "UITextSizeConstraint")({ Parent: label, MinTextSize: 8, MaxTextSize: 14 });
		label.Parent = button;
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
		BackgroundColor3: theme.colors.card,
		BorderSizePixel: 0,
		LayoutOrder: order,
		Visible: visible,
	});
	Fusion.New(scope, "UICorner")({ Parent: tile, CornerRadius: new UDim(0, 6) });
	const stroke = Fusion.New(scope, "UIStroke")({
		Parent: tile,
		Color: theme.colors.border,
		Thickness: 1,
		ApplyStrokeMode: Enum.ApplyStrokeMode.Border,
	});

	// The picture slot. A `Frame` today and an `ImageLabel` the day there is art — same size, same
	// position, and nothing around it moves.
	const art = Fusion.New(scope, "Frame")({
		Name: "Art",
		Parent: tile,
		Position: UDim2.fromOffset(4, 4),
		Size: new UDim2(1, -8, 1, -(TILE_NAME_HEIGHT + 4)),
		BackgroundColor3: theme.colors.panel,
		BorderSizePixel: 0,
	});
	Fusion.New(scope, "UICorner")({ Parent: art, CornerRadius: new UDim(0, 4) });

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
		BackgroundColor3: theme.colors.accent,
		BorderSizePixel: 0,
	});
	Fusion.New(scope, "UICorner")({ Parent: nameBar, CornerRadius: new UDim(0, 6) });

	const nameLabel = Text(scope, { text: name, variant: "subtitle2", wrap: false });
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
		// rather than turning the tile into one leaves the artwork, the name bar and the border exactly as
		// the shop draws them, which is what keeps the two panels' tiles one family. `ZIndex` is left at the
		// default on purpose: `raiseZIndex` levels every descendant of a panel to the same number after the
		// build, so what decides the hit target is child order within the tile, and this is the last child.
		// `AutoButtonColor` is off because a shelf of tiles blinking under the mouse is noise on a panel
		// where the click's whole answer is the border moving.
		const hit = Fusion.New(scope, "TextButton")({
			Name: "Hit",
			Parent: tile,
			Size: new UDim2(1, 0, 1, 0),
			BackgroundTransparency: 1,
			Text: "",
			AutoButtonColor: false,
		});
		scope.push(hit.Activated.Connect(onActivate));
	}

	return { frame: tile, nameLabel, statusLabel, stroke };
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
 * `ElasticBehavior` is off because a shelf that rubber-bands away from the mouse is a shelf that moves
 * under a click.
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
 * The size is constrained rather than fixed so it can breathe with the column, and it is centred so it
 * does not drift to a corner when the constraint clamps it — the same reasoning `addGrid` gives.
 */
export function addShowcase(
	scope: Fusion.Scope<unknown>,
	parent: Frame,
	theme: HudTheme,
	order: number,
): { readonly holder: Frame; readonly nameLabel: TextLabel } {
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

	const tile = Fusion.New(scope, "Frame")({
		Name: "Showcase",
		Parent: holder,
		AnchorPoint: new Vector2(0.5, 0.5),
		Position: UDim2.fromScale(0.5, 0.5),
		Size: UDim2.fromScale(1, 1),
		BackgroundColor3: theme.colors.card,
		BorderSizePixel: 0,
	});
	Fusion.New(scope, "UISizeConstraint")({
		Parent: tile,
		MinSize: new Vector2(96, 96),
		MaxSize: new Vector2(260, 260),
	});
	Fusion.New(scope, "UICorner")({ Parent: tile, CornerRadius: new UDim(0, 8) });
	Fusion.New(scope, "UIStroke")({
		Parent: tile,
		Color: theme.colors.border,
		Thickness: 1,
		ApplyStrokeMode: Enum.ApplyStrokeMode.Border,
	});

	// The picture slot, exactly as `addTile` has it — a `Frame` today, an `ImageLabel` the day there is
	// art, and nothing around it moves when that happens.
	Fusion.New(scope, "Frame")({
		Name: "Art",
		Parent: tile,
		Position: UDim2.fromOffset(6, 6),
		Size: new UDim2(1, -12, 1, -(TILE_NAME_HEIGHT * 2 + 6)),
		BackgroundColor3: theme.colors.panel,
		BorderSizePixel: 0,
	});
	Fusion.New(scope, "UICorner")({ Parent: tile, CornerRadius: new UDim(0, 6) });

	const nameBar = Fusion.New(scope, "Frame")({
		Name: "NameBar",
		Parent: tile,
		Position: new UDim2(0, 0, 1, -TILE_NAME_HEIGHT * 2),
		Size: new UDim2(1, 0, 0, TILE_NAME_HEIGHT * 2),
		BackgroundColor3: theme.colors.accent,
		BorderSizePixel: 0,
	});
	Fusion.New(scope, "UICorner")({ Parent: nameBar, CornerRadius: new UDim(0, 8) });

	const nameLabel = Text(scope, { text: "", variant: "subtitle1", wrap: false });
	nameLabel.TextColor3 = theme.colors.onAccent;
	nameLabel.Size = new UDim2(1, -12, 1, 0);
	nameLabel.Position = UDim2.fromOffset(6, 0);
	nameLabel.AutomaticSize = Enum.AutomaticSize.None;
	nameLabel.TextXAlignment = Enum.TextXAlignment.Center;
	nameLabel.TextYAlignment = Enum.TextYAlignment.Center;
	nameLabel.TextScaled = true;
	Fusion.New(scope, "UITextSizeConstraint")({ Parent: nameLabel, MinTextSize: 9, MaxTextSize: 20 });
	nameLabel.Parent = nameBar;

	return { holder, nameLabel };
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
