import { Controller, OnStart } from "@flamework/core";
import Net from "@rbxts/net";
import { Button, Text } from "@rbxts/big-ui";
import Fusion from "@rbxts/fusion-3.0";
import { Players } from "@rbxts/services";
import { ABILITY_NAMES, isAbilityKind } from "shared/ability";
import type { AbilityKind } from "shared/ability";
import { COINS_ATTRIBUTE, OWNED_COSMETICS_ATTRIBUTE, OWNED_POWERS_ATTRIBUTE } from "shared/constants";
import {
	COSMETICS,
	ECONOMY_CONFIG,
	MILESTONES,
	POWER_ROSTER,
	PREMIUM_COSMETICS,
} from "shared/config/economy.config";
import type { CosmeticDef, MilestoneDef } from "shared/config/economy.config";
import { ownedCosmeticIdsOf, ownsPower } from "shared/economy";
import { events } from "shared/networking";
import { SHOP_CONFIG } from "shared/config/shop.config";
import { hudTheme } from "../../ui/hudTheme";
import type { HudTheme } from "../../ui/hudTheme";
import { getHudScreenGui } from "../../ui/screenGui";
import { addViewportConstraint } from "../../ui/viewportConstraint";

/** Prints the mount line, every tab change, every chest request, and every answer. */
const DEBUG = true;

/** The one label `wrapLabels` never touches regardless of its parent — see that function. */
const TITLE_NAME = "Title";

/**
 * The panel's three views, in the order they are worth looking at.
 *
 * **These replace the mock's five tabs, and the replacement is a mapping rather than a rewrite of the
 * idea.** The tab strip was the part of this panel that was right — a small number of named views,
 * one at a time, over a shelf of tiles — and what was wrong was what the tabs named: `Effects`,
 * `Emotes`, `Radios` and `Pets` are four things the economy has no concept of at all, and the fifth
 * (`Powers`) is a real one. So the strip keeps its structure and loses the four tabs with nothing
 * behind them, and `Powers` gains the two views the economy *does* have that the mock never did.
 *
 * **The order is the value ladder and should read that way:** what coins buy, then what playing
 * gives, then what is meant to cost Robux. See {@link addPremiumPane} for why the last of the three
 * is a catalogue with no way to buy from it yet.
 *
 * A tab carries a colour *job* rather than a colour, so the theme stays the only place a colour is
 * chosen from — `theme.colors[tab.colour]` is the whole lookup, and a tab wanting a different one
 * names a different job.
 */
const TABS = [
	{ name: "Powers", colour: "accent" },
	{ name: "Earned", colour: "success" },
	{ name: "Premium", colour: "coin" },
] as const;

type TabName = (typeof TABS)[number]["name"];

/** How many tiles sit across a shelf. Three, because the widest shelf here holds seven. */
const COLUMNS = 3;

/**
 * One cell's width as a fraction of the grid.
 *
 * Derived from the gap rather than written down, so columns and gaps sum to **exactly** 1.0 — the
 * same rule `SHOP_CONFIG` documents for its own grids and derives `BOX_CELL_SCALE` with. A single
 * pixel over the total does not overflow a `UIGridLayout`; it wraps, which silently costs a whole
 * column. Three columns rather than the config's four or five, because the tallest shelf here holds
 * seven tiles and three across keeps them legible at the sizes this panel actually is.
 */
const CELL_SCALE = (1 - (COLUMNS - 1) * SHOP_CONFIG.GRID_GAP_SCALE) / COLUMNS;

/**
 * The smallest the panel may be drawn, in pixels.
 *
 * **Smaller than `SHOP_CONFIG.PANEL_MIN_SIZE`, and deliberately.** That value is 520 pixels wide, and
 * this panel's width is also a fraction of the viewport — so on any screen narrower than about 840px
 * the minimum wins, the panel is wider than the screen, and its two side bands sit off the glass. A
 * pixel minimum is only safe when the pixels are smaller than the screen they land on, and nothing at
 * this call site knows how wide the screen is. This floor says "never so small that a tile cannot be
 * read" and stays under 92% of even a 320px viewport, which is what {@link addViewportConstraint}
 * caps against.
 */
const PANEL_MIN_PIXELS = new Vector2(280, 260);

/** The gap between tabs as a fraction of the row. */
const TAB_GAP_SCALE = 0.012;

/** A tile's name bar, in pixels — the strip across the bottom of a tile that carries its name. */
const TILE_NAME_HEIGHT = 30;

/** A tile's status line, in pixels. Sits just above the name bar, over the artwork. */
const TILE_STATUS_HEIGHT = 20;

/** What {@link ShopController.addTile} hands back: the one label a caller writes to. */
interface Tile {
	/** The status line over the artwork — `Owned`/`Locked`, the goal, or the price. */
	readonly statusLabel: TextLabel;
}

/** The client halves of the two remotes, as the declarations build them. */
type ClientRemotes = Net.Util.GetClientRemotes<Net.Util.GetDeclarationDefinitions<typeof events>>;

/**
 * `19201` as `19,201`.
 *
 * Peeled off the right, one character at a time, because that is the only end that is fixed: grouping
 * from the left gives `192,01` for a five-digit number, which is how a coin balance ends up looking
 * like a typo.
 */
function withCommas(value: number): string {
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
 */
function raiseZIndex(root: Instance, z: number): void {
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
 * label in the tree is classified correctly by construction. The version this replaces excluded one
 * label by name — the title — which was right for that tree and would have been wrong for this one:
 * the balance figure sits in a group that sizes itself to its contents and would have collapsed to
 * nothing the moment it was wrapped.
 *
 * **`AutomaticSize` is one value, not a pair of axes**, so "the width is automatic" is `X` or `XY`
 * and not a read of a `.X` field — the height being automatic is beside the point.
 *
 * **A label that scales to fit its box is skipped too, and that is the same rule read the other way.**
 * Every label on a tile carries `TextScaled`, because a tile is a fixed box whose width comes from the
 * grid — the tiles are the one place in this panel where a name cannot be given the room it wants.
 * Text that scales and text that wraps are two answers to one problem, and they cannot both be on: a
 * wrapping label inside a fixed-height bar is a clipped label.
 */
function wrapLabels(root: Instance): void {
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
 * What a player has to do to earn `milestone`, in one line.
 *
 * **The goal is written from `stat` and `threshold`, which is the whole of what the client can know.**
 * Nothing here is a progress figure and nothing here *can* be: see {@link ShopController.addEarnedPane}
 * for the counters the server does not publish, and why this panel shows two states rather than a bar
 * over a number this machine would have to invent.
 *
 * The `crown` case reads "Wear the crown" rather than "Crown 1 time" because its threshold is not a
 * count of anything — it is the boolean being true — and a phrase with a `1` in it invites the reader
 * to look for a way to do it twice.
 */
function goalText(milestone: MilestoneDef): string {
	switch (milestone.stat) {
		case "matches":
			return milestone.threshold === 1 ? "Play 1 match" : `Play ${milestone.threshold} matches`;
		case "wins":
			return milestone.threshold === 1 ? "Win 1 match" : `Win ${milestone.threshold} matches`;
		case "hits":
			return `Land ${milestone.threshold} hits`;
		case "crown":
			return "Wear the crown";
	}
}

/** Where a cosmetic is worn, in one word — the only thing `slot` means to a player. */
function slotLabel(def: CosmeticDef): string {
	return def.slot === "trail" ? "Trail" : "Elimination";
}

/**
 * The shop, in the shape it has always had: a header, a row of tabs, a shelf of tiles, and one action
 * at the bottom.
 *
 * **The layout is deliberately the one this panel already had**, because it was never the problem.
 * What was on the shelves was: a mystery-box shop with odds and rarities, a hardcoded coin figure, a
 * Gem counter for a currency that exists nowhere, and five tabs of which four named things this game
 * has no concept of. The fix is the *contents*, so the bands, the tile proportions, the tab strip and
 * the full-width footer button are all restored as they were and the economy is what moves in.
 *
 * **The one structural thing the old layout had that this does not is its second level.** A box used
 * to open into a detail view — a picture, an odds table, what was inside — and there is no equivalent
 * here because there is nothing to drill into: a power, a milestone and a cosmetic are one fact each,
 * and the only action in the whole panel belongs to the chest, which the footer carries exactly as it
 * carried `OPEN BOX`. So the shelf is one level, and the footer is where the doing happens.
 *
 * **Everything is built once and only properties change afterwards**, which is the arrangement this
 * panel has always used and the reason it stays cheap. big-ui components take their contents at
 * construction, so a pane that repopulated itself on a tab click would be torn down and rebuilt every
 * time. Three static shelves and a computed `Visible` each is simpler and cheaper than either. What
 * changes reactively is the text and colour of what was built, through the values
 * {@link watchPlayer} fills and the `Fusion.Computed`s the tiles hydrate.
 */
@Controller()
export class ShopController implements OnStart {
	private scope = Fusion.scoped();
	private mounted = false;

	private isOpen = Fusion.Value(this.scope, false);

	/** Which of the three views is showing. `Powers` first, because it is the one to act on. */
	private currentTab = Fusion.Value<TabName>(this.scope, "Powers");

	/**
	 * The player's wallet, as a number.
	 *
	 * **A `Value` fed from the attribute's changed signal, rather than a `GetAttribute` inside a
	 * `Computed`.** A `Computed` derives its dependencies from the reads that actually ran, and an
	 * attribute read is a *sample* rather than a subscription — so a label built straight on
	 * `GetAttribute` draws once and never again, which for a balance is the most visible failure this
	 * panel could have. The bridge is the shape `StatsBillboardController` uses for the same reason.
	 */
	private coins = Fusion.Value(this.scope, 0);

	/** The `OWNED_POWERS_ATTRIBUTE` string, verbatim. Read through `ownsPower`. */
	private powers = Fusion.Value(this.scope, "");

	/** The `OWNED_COSMETICS_ATTRIBUTE` string, verbatim. Read through `ownedCosmeticIdsOf`. */
	private cosmetics = Fusion.Value(this.scope, "");

	/** The power the last chest granted, or `""`. */
	private chestGranted = Fusion.Value(this.scope, "");

	/**
	 * The server's own sentence for the last refusal, or `""`.
	 *
	 * **Kept verbatim and never reworded on the way to the screen.** "not enough coins", "all powers
	 * collected" and "your record is still loading" are three different situations with three
	 * different answers, and they are the strings the handler sends. A paraphrase here would be a
	 * second copy of the server's vocabulary, free to drift from the one that decides whether the
	 * chest opens — and the copy on screen is the one a player would believe.
	 */
	private chestReason = Fusion.Value(this.scope, "");

	/**
	 * The chest request, resolved once at mount.
	 *
	 * `Get` **yields** until the server's remote exists, so it is resolved from `watchChest` — which
	 * runs inside `mount`'s `task.spawn` — rather than from the button's click handler, where a yield
	 * would be a frame of nothing happening after a press.
	 */
	private chestRemote?: ClientRemotes["openPowerChest"];

	onStart(): void {
		// Spawned rather than done inline, matching the other HUDs: mounting waits for `PlayerGui`,
		// and `onStart` is the wrong place to hold up the rest of the client's boot.
		task.spawn(() => this.mount());
	}

	private mount(): void {
		if (this.mounted) return;
		this.mounted = true;

		print("[Shop] panel up — Powers (coins) · Earned (milestones) · Premium (catalogue)");

		this.addButton();
		this.addPanel();

		// After the tree, because both of these write into values the tree is already reading. Doing
		// it first would draw a frame of "no coins, nothing owned" on every mount — a lie the player
		// would see, rather than a detail they would not.
		this.watchPlayer();
		this.watchChest();
	}

	private addButton(): void {
		const button = Button(this.scope, {
			label: "Shop",
			variant: "contained",
			color: "primary",
			size: "medium",
			onActivate: () => {
				this.isOpen.set(!Fusion.peek(this.isOpen));
				if (DEBUG) print(Fusion.peek(this.isOpen) ? "[Shop] opened" : "[Shop] closed");
			},
		});

		button.AutomaticSize = Enum.AutomaticSize.None; // clear big-ui's default X-only autosize
		button.Size = UDim2.fromOffset(120, 44);
		button.Position = UDim2.fromOffset(12, 12);
		button.AnchorPoint = new Vector2(0, 0);
		button.Parent = getHudScreenGui();
	}

	private addPanel(): void {
		const theme = hudTheme();

		const panel = Fusion.New(this.scope, "Frame")({
			Name: "ShopPanel",
			Size: SHOP_CONFIG.PANEL_SIZE,
			AnchorPoint: new Vector2(0.5, 0.5),
			Position: UDim2.fromScale(0.5, 0.5),
			BackgroundColor3: theme.colors.panel,
			BackgroundTransparency: 0,
			BorderSizePixel: 0,
			Visible: Fusion.Computed(this.scope, (use) => use(this.isOpen)),
			ZIndex: SHOP_CONFIG.PANEL_Z_INDEX,
		});

		Fusion.New(this.scope, "UICorner")({ Parent: panel, CornerRadius: new UDim(0, 10) });
		Fusion.New(this.scope, "UIStroke")({
			Parent: panel,
			Color: theme.colors.border,
			Thickness: 1,
			ApplyStrokeMode: Enum.ApplyStrokeMode.Border,
		});

		// The responsive bounds, from the shared helper: this floor, the config's ultrawide ceiling,
		// and the helper's own viewport-fraction cap over the top of both. See `PANEL_MIN_PIXELS` for
		// why this floor is not the one in `SHOP_CONFIG`.
		addViewportConstraint(this.scope, panel, {
			min: PANEL_MIN_PIXELS,
			max: SHOP_CONFIG.PANEL_MAX_SIZE,
		});

		// The bands stack themselves and the shelf takes the remainder — this is what replaces
		// `CONTENT_TOP` / `CONTENT_HEIGHT_OFFSET`. `Padding` is zero because the bands run edge to
		// edge; each one insets its own contents instead. `Center` is the cross-axis equivalent of
		// `align-items: stretch` for fixed-width children.
		Fusion.New(this.scope, "UIListLayout")({
			Parent: panel,
			FillDirection: Enum.FillDirection.Vertical,
			SortOrder: Enum.SortOrder.LayoutOrder,
			HorizontalAlignment: Enum.HorizontalAlignment.Center,
			Padding: new UDim(0, 0),
		});

		this.addHeader(panel, theme);
		this.addTabs(panel, theme);
		this.addContent(panel, theme);
		this.addFooter(panel, theme);

		// Every descendant at the panel's own ZIndex. Without this the panel's background covers
		// everything inside it — see `raiseZIndex`.
		raiseZIndex(panel, SHOP_CONFIG.PANEL_Z_INDEX);

		// ...and every label with a definite width left free to wrap — see `wrapLabels`. Done last so
		// it catches labels built by every band, including all the tiles.
		wrapLabels(panel);

		panel.Parent = getHudScreenGui(); // must stay the LAST statement in this method
	}

	/**
	 * The inner margin a band applies to its own contents.
	 *
	 * Horizontally a scale inset — `SHOP_CONFIG.PAD_X` — so the side margins track the panel's width.
	 * Vertically a pixel one, and that is forced rather than chosen: a scale inset on a band that is
	 * sizing itself to its contents would be a fraction of the height it is helping to determine,
	 * which is a cycle.
	 */
	private padBand(band: Frame, top: number, bottom: number): void {
		Fusion.New(this.scope, "UIPadding")({
			Parent: band,
			PaddingTop: new UDim(0, top),
			PaddingBottom: new UDim(0, bottom),
			PaddingLeft: new UDim(SHOP_CONFIG.PAD_X, 0),
			PaddingRight: new UDim(SHOP_CONFIG.PAD_X, 0),
		});
	}

	// ---------- header ----------

	/**
	 * The close control, the title, and the balance.
	 *
	 * **Two counters became one, and the "add currency" button went with the second.** The panel used
	 * to show Coins and Gems side by side — a Gem figure that exists nowhere in the economy, on the one
	 * screen whose whole job is to say what a player has — plus a `+` button that printed
	 * `no purchase logic` when pressed. A zero that never moves reads as "you have none of this"
	 * rather than as "this is not a thing", and a button whose own label admits there is nothing
	 * behind it should not be on the screen at all.
	 */
	private addHeader(parent: Frame, theme: HudTheme): void {
		const header = Fusion.New(this.scope, "Frame")({
			Name: "Header",
			Parent: parent,
			// Width from the panel, height from its own contents — the title's line box and the
			// balance pill decide it. There is no band height constant.
			Size: new UDim2(1, 0, 0, 0),
			AutomaticSize: Enum.AutomaticSize.Y,
			LayoutOrder: 1,
			BackgroundTransparency: 1,
		});
		this.padBand(header, SHOP_CONFIG.PAD_Y, SHOP_CONFIG.PAD_Y);

		const left = Fusion.New(this.scope, "Frame")({
			Name: "Left",
			Parent: header,
			Size: new UDim2(0, 0, 1, 0),
			AutomaticSize: Enum.AutomaticSize.X,
			BackgroundTransparency: 1,
		});
		Fusion.New(this.scope, "UIListLayout")({
			Parent: left,
			FillDirection: Enum.FillDirection.Horizontal,
			VerticalAlignment: Enum.VerticalAlignment.Center,
			SortOrder: Enum.SortOrder.LayoutOrder,
			Padding: new UDim(0, SHOP_CONFIG.HEADER_GAP),
		});

		const close = Button(this.scope, {
			label: "X",
			size: "small",
			color: "error",
			layoutOrder: 1,
			onActivate: () => this.isOpen.set(false),
		});
		close.Parent = left;

		// `wrap: false` here only — this label's parent sizes itself to its contents, and a wrapped
		// label in an auto-width parent is the measurement cycle `wrapLabels` describes.
		const title = Text(this.scope, { text: "Shop", variant: "h4", wrap: false });
		title.Name = TITLE_NAME;
		title.TextColor3 = theme.colors.textPrimary;
		title.Size = UDim2.fromOffset(0, 0);
		title.AutomaticSize = Enum.AutomaticSize.XY;
		title.LayoutOrder = 2;
		title.Parent = left;

		// The balance is pinned to the far edge rather than placed by the row's layout — the same
		// arrangement this header has always used, and the reason the two groups cannot fight over the
		// middle of a narrow panel.
		const right = Fusion.New(this.scope, "Frame")({
			Name: "Right",
			Parent: header,
			Size: UDim2.fromOffset(0, 0),
			AutomaticSize: Enum.AutomaticSize.XY,
			AnchorPoint: new Vector2(1, 0.5),
			Position: new UDim2(1, 0, 0.5, 0),
			BackgroundTransparency: 1,
		});
		Fusion.New(this.scope, "UIListLayout")({
			Parent: right,
			FillDirection: Enum.FillDirection.Horizontal,
			VerticalAlignment: Enum.VerticalAlignment.Center,
			SortOrder: Enum.SortOrder.LayoutOrder,
			Padding: new UDim(0, SHOP_CONFIG.HEADER_GAP),
		});

		this.addBalancePill(right, theme);
	}

	/**
	 * The live balance: a coin and a number, from the same attribute `CurrencyHudController` draws.
	 *
	 * Both sides of it come from the theme, including the coin's own amber, so this pill and the
	 * readout under the shop button say the same thing in the same colour.
	 */
	private addBalancePill(parent: Frame, theme: HudTheme): void {
		const pill = Fusion.New(this.scope, "Frame")({
			Name: "Balance",
			Parent: parent,
			Size: new UDim2(0, 0, 0, 0),
			AutomaticSize: Enum.AutomaticSize.XY,
			BackgroundColor3: theme.colors.card,
			BorderSizePixel: 0,
			LayoutOrder: 1,
		});
		Fusion.New(this.scope, "UICorner")({ Parent: pill, CornerRadius: new UDim(0, 6) });
		Fusion.New(this.scope, "UIPadding")({
			Parent: pill,
			// Equal padding on all four sides, because the pill hugs its contents on both axes — there
			// is no excess height to distribute.
			PaddingTop: new UDim(0, 4),
			PaddingBottom: new UDim(0, 4),
			PaddingLeft: new UDim(0, 8),
			PaddingRight: new UDim(0, 10),
		});
		Fusion.New(this.scope, "UIListLayout")({
			Parent: pill,
			FillDirection: Enum.FillDirection.Horizontal,
			VerticalAlignment: Enum.VerticalAlignment.Center,
			SortOrder: Enum.SortOrder.LayoutOrder,
			Padding: new UDim(0, 6),
		});

		// The coin, as a coloured disc. No asset behind it, and the leaf-swap rule applies here as much
		// as anywhere: a `Frame` and an `ImageLabel` are both `GuiObject`s, so replacing this with a
		// picture later is a change to one class name and nothing around it.
		const glyph = Fusion.New(this.scope, "Frame")({
			Name: "Coin",
			Parent: pill,
			Size: UDim2.fromOffset(16, 16),
			BackgroundColor3: theme.colors.coin,
			BorderSizePixel: 0,
			LayoutOrder: 1,
		});
		Fusion.New(this.scope, "UICorner")({ Parent: glyph, CornerRadius: new UDim(1, 0) });

		const amount = Text(this.scope, {
			text: Fusion.Computed(this.scope, (use) => withCommas(use(this.coins))),
			variant: "body2",
			wrap: false,
		});
		amount.TextColor3 = theme.colors.coin;
		amount.Size = UDim2.fromOffset(0, 0);
		amount.AutomaticSize = Enum.AutomaticSize.XY;
		amount.LayoutOrder = 2;
		amount.Parent = pill;
	}

	// ---------- tabs ----------

	/**
	 * The tab strip.
	 *
	 * A tab is a `TextButton` rather than a big-ui `Button` — as it always was — because it needs an
	 * arbitrary colour and a picture slot that big-ui's `Button` has no props for. The picture slot is
	 * kept (a placeholder rectangle with no asset) because it is what gives the strip its shape, and it
	 * is a leaf: an `ImageLabel` is what goes there the day there is art for one.
	 */
	private addTabs(parent: Frame, theme: HudTheme): void {
		const tabRow = Fusion.New(this.scope, "Frame")({
			Name: "TabRow",
			Parent: parent,
			// Sized by the tabs it holds — each is a fixed touch height — so there is no band height
			// constant, and `LayoutOrder` is what puts it after the header.
			Size: new UDim2(1, 0, 0, 0),
			AutomaticSize: Enum.AutomaticSize.Y,
			LayoutOrder: 2,
			BackgroundColor3: theme.colors.card,
			BorderSizePixel: 0,
		});
		this.padBand(tabRow, SHOP_CONFIG.PAD_Y, SHOP_CONFIG.PAD_Y);
		Fusion.New(this.scope, "UIListLayout")({
			Parent: tabRow,
			FillDirection: Enum.FillDirection.Horizontal,
			VerticalAlignment: Enum.VerticalAlignment.Center,
			SortOrder: Enum.SortOrder.LayoutOrder,
			Padding: new UDim(0, SHOP_CONFIG.TAB_GAP),
		});

		// The width is derived from the tab count so the three of them fill the row exactly — the job
		// `SHOP_CONFIG.TAB_WIDTH_SCALE` did for the mock's five. A fixed fraction here would leave the
		// strip three-fifths full.
		const tabWidth = (1 - (TABS.size() - 1) * TAB_GAP_SCALE) / TABS.size();

		TABS.forEach((tab, index) => this.addTab(tabRow, theme, tab, tabWidth, index + 1));
	}

	private addTab(
		parent: Frame,
		theme: HudTheme,
		tab: (typeof TABS)[number],
		width: number,
		layoutOrder: number,
	): void {
		const colour = theme.colors[tab.colour];

		const button = Fusion.New(this.scope, "TextButton")({
			Name: `${tab.name}Tab`,
			Parent: parent,
			// Width is a fraction of the row so the tabs track the panel; height is a touch target and
			// stays in pixels on purpose — see `SHOP_CONFIG.TAB_HEIGHT`.
			Size: new UDim2(width, 0, 0, SHOP_CONFIG.TAB_HEIGHT),
			BackgroundColor3: colour,
			BackgroundTransparency: Fusion.Computed(this.scope, (use) =>
				use(this.currentTab) === tab.name ? 0 : 0.35,
			),
			AutoButtonColor: true,
			Text: "",
			LayoutOrder: layoutOrder,
			[Fusion.OnEvent("Activated")]: () => {
				this.currentTab.set(tab.name);
				if (DEBUG) print(`[Shop] tab: ${tab.name}`);
			},
		});
		Fusion.New(this.scope, "UICorner")({ Parent: button, CornerRadius: new UDim(0, 5) });
		Fusion.New(this.scope, "UIStroke")({
			Parent: button,
			Color: theme.colors.border,
			Thickness: 1,
			Transparency: 0.5,
		});

		const image = Fusion.New(this.scope, "ImageLabel")({
			Name: "Image",
			Parent: button,
			Position: UDim2.fromOffset(3, 3),
			Size: new UDim2(1, -6, 1, -6),
			BackgroundColor3: theme.colors.panel,
			BackgroundTransparency: 0.2,
			BorderSizePixel: 0,
		});
		Fusion.New(this.scope, "UICorner")({ Parent: image, CornerRadius: new UDim(0, 4) });

		const label = Text(this.scope, { text: tab.name, variant: "subtitle2", wrap: false });
		label.TextColor3 = theme.colors.onAccent;
		label.Size = new UDim2(1, 0, 0, 18);
		label.Position = new UDim2(0, 0, 1, -21);
		label.AutomaticSize = Enum.AutomaticSize.None;
		label.TextXAlignment = Enum.TextXAlignment.Center;
		// Scaling rather than wrapping, because the label sits in a tab whose width shrinks with the
		// panel: text that scales gets smaller, text that wraps gets a second line clipped by the tab.
		label.TextScaled = true;
		Fusion.New(this.scope, "UITextSizeConstraint")({ Parent: label, MinTextSize: 8, MaxTextSize: 14 });
		label.Parent = button;
	}

	// ---------- the shelf ----------

	/**
	 * The content band and its three panes.
	 *
	 * **All three panes are built at mount and only `Visible` changes**, which is the arrangement this
	 * panel has always used and the reason it stays cheap: big-ui components take their contents at
	 * construction, so a pane that repopulated itself on a tab click would be torn down and rebuilt
	 * every time. Three static shelves and a computed `Visible` each is both simpler and cheaper.
	 */
	private addContent(parent: Frame, theme: HudTheme): void {
		const content = Fusion.New(this.scope, "Frame")({
			Name: "Content",
			Parent: parent,
			// No height and no position of its own: the panel's list layout stacks it after the bands,
			// and the flex item below hands it whatever is left.
			Size: new UDim2(1, 0, 0, 0),
			LayoutOrder: 3,
			BackgroundTransparency: 1,
			// A backstop. The bands are opaque strips stacked above one another, so anything that
			// escapes this band does not just look wrong — the next band is drawn over it.
			ClipsDescendants: true,
		});
		Fusion.New(this.scope, "UIFlexItem")({
			Parent: content,
			// `flex: 1`: grow into the remaining space, and nothing else on the panel flexes.
			FlexMode: Enum.UIFlexMode.Fill,
		});
		this.padBand(content, SHOP_CONFIG.PAD_Y, SHOP_CONFIG.PAD_Y);

		this.addPowersPane(content, theme);
		this.addEarnedPane(content, theme);
		this.addPremiumPane(content, theme);
	}

	/**
	 * One pane: a shelf filling the content band, visible only while its tab is the one selected.
	 *
	 * The `Visible` computed reads `currentTab` and nothing else, so switching tabs is one value write
	 * and no tree work at all.
	 */
	private addPane(content: Frame, theme: HudTheme, name: TabName, order: number): Frame {
		const pane = Fusion.New(this.scope, "Frame")({
			Name: name,
			Parent: content,
			Size: new UDim2(1, 0, 1, 0),
			BackgroundTransparency: 1,
			LayoutOrder: order,
			Visible: Fusion.Computed(this.scope, (use) => use(this.currentTab) === name),
		});

		// The pane's own chrome is nothing: every tile inside it draws its own surface, and a pane
		// background would be a second panel behind a panel.
		void theme;

		return pane;
	}

	/**
	 * The grid a shelf lives in: anchored centre, capped by the config's minimum and maximum, and
	 * filled by whatever tiles the caller adds.
	 *
	 * **The cell size is derived from the row count, and it is the one piece of arithmetic in this
	 * file — deliberately.** A `UIGridLayout` takes a fixed `CellSize`, so a grid of content-sized
	 * tiles would need a cell height worked out from the tallest tile's text: a number that changes
	 * with the window and with every string, and the reason this file's tiles have fixed contents.
	 * Deriving it from how many rows there are instead is what this panel has always done, it needs to
	 * know nothing about the contents, and it is scale arithmetic rather than a position — cells and
	 * gaps come to exactly 1.0, so the layout can never wrap and silently cost a column.
	 */
	private addGrid(pane: Frame, theme: HudTheme, count: number): Frame {
		const grid = Fusion.New(this.scope, "Frame")({
			Name: "Grid",
			Parent: pane,
			// Centred, which only becomes visible once the size constraint below clamps it on a wide
			// screen — otherwise a `Size` of 1,0 already fills the band.
			AnchorPoint: new Vector2(0.5, 0.5),
			Position: UDim2.fromScale(0.5, 0.5),
			Size: new UDim2(1, 0, 1, 0),
			BackgroundTransparency: 1,
		});
		Fusion.New(this.scope, "UISizeConstraint")({
			Parent: grid,
			MinSize: SHOP_CONFIG.GRID_MIN_SIZE,
			MaxSize: SHOP_CONFIG.GRID_MAX_SIZE,
		});

		const rows = math.max(1, math.ceil(count / COLUMNS));
		Fusion.New(this.scope, "UIGridLayout")({
			Parent: grid,
			CellSize: UDim2.fromScale(CELL_SCALE, (1 - (rows - 1) * SHOP_CONFIG.GRID_GAP_SCALE) / rows),
			CellPadding: UDim2.fromScale(SHOP_CONFIG.GRID_GAP_SCALE, SHOP_CONFIG.GRID_GAP_SCALE),
			SortOrder: Enum.SortOrder.LayoutOrder,
		});

		// The grid's own `AutomaticSize` is left alone deliberately: a `UIGridLayout` sizes its cells,
		// not itself, and asking this frame to hug its contents as well would be two answers to how
		// tall a shelf is.
		void theme;

		return grid;
	}

	/**
	 * One tile: artwork, a status line, and a name bar across the bottom.
	 *
	 * **Tiles are fixed boxes, and that is the trade the shelf makes.** Inside a grid a tile's width
	 * comes from its cell, so its contents cannot decide their own size — which is why the two labels
	 * on it scale to fit rather than wrapping, and why every position here is a scale or an anchor
	 * against the cell rather than a sum of what is above it. The alternative is a single column of
	 * content-sized cards, and that is a different panel: it reads as a list of facts rather than as a
	 * shelf of things, and this is a shop.
	 *
	 * Returns the status label, which is the one piece a caller writes to. The chrome is identical on
	 * all three shelves, which is what makes them read as one panel.
	 */
	private addTile(grid: Frame, theme: HudTheme, name: string, order: number): Tile {
		const tile = Fusion.New(this.scope, "Frame")({
			Name: name,
			Parent: grid,
			BackgroundColor3: theme.colors.card,
			BorderSizePixel: 0,
			LayoutOrder: order,
		});
		Fusion.New(this.scope, "UICorner")({ Parent: tile, CornerRadius: new UDim(0, 6) });
		Fusion.New(this.scope, "UIStroke")({
			Parent: tile,
			Color: theme.colors.border,
			Thickness: 1,
			ApplyStrokeMode: Enum.ApplyStrokeMode.Border,
		});

		// The picture slot. A `Frame` today and an `ImageLabel` the day there is art — same size, same
		// position, and nothing around it moves.
		const art = Fusion.New(this.scope, "Frame")({
			Name: "Art",
			Parent: tile,
			Position: UDim2.fromOffset(4, 4),
			Size: new UDim2(1, -8, 1, -(TILE_NAME_HEIGHT + 4)),
			BackgroundColor3: theme.colors.panel,
			BorderSizePixel: 0,
		});
		Fusion.New(this.scope, "UICorner")({ Parent: art, CornerRadius: new UDim(0, 4) });

		// The status line, sitting just above the name bar and over the artwork's lower edge — where
		// the mock put its price chip.
		const status = Fusion.New(this.scope, "Frame")({
			Name: "Status",
			Parent: tile,
			AnchorPoint: new Vector2(0, 1),
			Position: new UDim2(0, 8, 1, -(TILE_NAME_HEIGHT + 6)),
			Size: new UDim2(1, -16, 0, TILE_STATUS_HEIGHT),
			BackgroundTransparency: 1,
		});
		const statusLabel = Text(this.scope, { text: "", variant: "caption", wrap: false });
		statusLabel.TextColor3 = theme.colors.textSecondary;
		statusLabel.Size = new UDim2(1, 0, 1, 0);
		statusLabel.AutomaticSize = Enum.AutomaticSize.None;
		statusLabel.TextXAlignment = Enum.TextXAlignment.Center;
		statusLabel.TextYAlignment = Enum.TextYAlignment.Center;
		statusLabel.TextScaled = true;
		Fusion.New(this.scope, "UITextSizeConstraint")({ Parent: statusLabel, MinTextSize: 7, MaxTextSize: 12 });
		statusLabel.Parent = status;

		const nameBar = Fusion.New(this.scope, "Frame")({
			Name: "NameBar",
			Parent: tile,
			Position: new UDim2(0, 0, 1, -TILE_NAME_HEIGHT),
			Size: new UDim2(1, 0, 0, TILE_NAME_HEIGHT),
			BackgroundColor3: theme.colors.accent,
			BorderSizePixel: 0,
		});
		Fusion.New(this.scope, "UICorner")({ Parent: nameBar, CornerRadius: new UDim(0, 6) });

		const nameLabel = Text(this.scope, { text: name, variant: "subtitle2", wrap: false });
		nameLabel.TextColor3 = theme.colors.onAccent;
		nameLabel.Size = new UDim2(1, -8, 1, 0);
		nameLabel.Position = UDim2.fromOffset(4, 0);
		nameLabel.AutomaticSize = Enum.AutomaticSize.None;
		nameLabel.TextXAlignment = Enum.TextXAlignment.Center;
		nameLabel.TextYAlignment = Enum.TextYAlignment.Center;
		nameLabel.TextScaled = true;
		Fusion.New(this.scope, "UITextSizeConstraint")({ Parent: nameLabel, MinTextSize: 8, MaxTextSize: 14 });
		nameLabel.Parent = nameBar;

		return { statusLabel };
	}

	// ---------- tab 1: powers ----------

	/**
	 * Powers, bought with coins: the roster as a shelf, the chest in the footer.
	 *
	 * **This pane is the answer to the first question a new player asks.** `BallService` refuses an
	 * unowned power at the key, with a print on the *server* — `[Super] … not owned` — and this is the
	 * only place on the client that says so. A player pressing `3` and seeing nothing happen cannot
	 * tell "locked" from "broken", and from the outside those two look identical, so the roster is
	 * rendered in full with every entry marked.
	 */
	private addPowersPane(content: Frame, theme: HudTheme): void {
		const pane = this.addPane(content, theme, "Powers", 1);
		const grid = this.addGrid(pane, theme, POWER_ROSTER.size());

		POWER_ROSTER.forEach((kind, index) => {
			const tile = this.addTile(grid, theme, ABILITY_NAMES[kind], index);

			Fusion.Hydrate(this.scope, tile.statusLabel)({
				Text: Fusion.Computed(this.scope, (use) =>
					ownsPower(use(this.powers), kind) ? "Owned" : "Locked",
				),
				TextColor3: Fusion.Computed(this.scope, (use) =>
					ownsPower(use(this.powers), kind) ? theme.colors.success : theme.colors.textDisabled,
				),
			});
		});
	}

	// ---------- tab 2: earned ----------

	/**
	 * Milestones: free, and never for sale.
	 *
	 * **Two states rather than a progress bar, and that is a missing data source rather than a design
	 * preference.** A tile reading "4/25 wins" needs the player's *current* win count on the client,
	 * and there is no such attribute: `EconomyService` keeps `matches` and `wins` inside its private
	 * record and publishes neither, and of the four counters only `hits` exists as one (`StatsService`'s
	 * lifetime `Stat_HITS`). Drawing a fraction would mean counting wins on this machine — a second,
	 * client-side copy of a number the server owns and acts on, free to disagree with the server that
	 * actually hands the cosmetic over. So a tile shows the goal and whether it is met, and a progress
	 * figure waits for the server to publish the counters it already has.
	 *
	 * What *can* be shown honestly is ownership, because `OWNED_COSMETICS_ATTRIBUTE` is the server's own
	 * answer — and since the server grants on reaching the threshold, "owned" and "earned" are the same
	 * fact. There is no third "reached but pending" state to draw.
	 */
	private addEarnedPane(content: Frame, theme: HudTheme): void {
		const pane = this.addPane(content, theme, "Earned", 2);
		const grid = this.addGrid(pane, theme, MILESTONES.size());

		MILESTONES.forEach((milestone, index) => {
			const cosmetic: CosmeticDef | undefined = COSMETICS[milestone.cosmeticId];
			const reward = cosmetic !== undefined ? cosmetic.name : milestone.cosmeticId;

			const tile = this.addTile(grid, theme, milestone.name, index);

			// The name bar carries the achievement and the status line carries the reward *and* the
			// goal, so a tile says what a player gets as well as what they have to do for it.
			Fusion.Hydrate(this.scope, tile.statusLabel)({
				Text: Fusion.Computed(this.scope, (use) =>
					ownedCosmeticIdsOf(use(this.cosmetics)).has(milestone.cosmeticId)
						? `${reward} · Earned`
						: `${reward} · ${goalText(milestone)}`,
				),
				TextColor3: Fusion.Computed(this.scope, (use) =>
					ownedCosmeticIdsOf(use(this.cosmetics)).has(milestone.cosmeticId)
						? theme.colors.success
						: theme.colors.textSecondary,
				),
			});
		});
	}

	// ---------- tab 3: premium ----------

	/**
	 * The premium catalogue — and **nothing on this shelf can be bought, which the panel says.**
	 *
	 * **There is no purchase path in this project at all.** No `MarketplaceService`, no prompt, no
	 * ownership check, no grant: a Buy button would take a player's Robux and hand back nothing,
	 * because no server code is listening for the answer. A half-path that charges is worse than a shelf
	 * labelled "not yet", so the tiles carry their price and their state and nothing here is clickable.
	 *
	 * **Every `gamepassId` in the config is `0` today too**, so even a prompt could not be aimed: the ids
	 * have to exist in the creator dashboard first. Those two facts together are why the status line is
	 * a statement rather than an apology.
	 */
	private addPremiumPane(content: Frame, theme: HudTheme): void {
		const pane = this.addPane(content, theme, "Premium", 3);
		const grid = this.addGrid(pane, theme, PREMIUM_COSMETICS.size());

		PREMIUM_COSMETICS.forEach((def, index) => {
			const tile = this.addTile(grid, theme, def.name, index);

			Fusion.Hydrate(this.scope, tile.statusLabel)({
				// Owned wins over the not-yet notice: once a grant path exists, an item a player
				// already has must stop advertising itself as unbuyable, and the attribute is already
				// the honest source for that answer.
				Text: Fusion.Computed(this.scope, (use) => {
					const price = `${slotLabel(def)} · ${withCommas(def.priceRobux)} R$`;
					return ownedCosmeticIdsOf(use(this.cosmetics)).has(def.id)
						? `${price} · Owned`
						: `${price} · Not yet purchasable`;
				}),
				TextColor3: Fusion.Computed(this.scope, (use) =>
					ownedCosmeticIdsOf(use(this.cosmetics)).has(def.id)
						? theme.colors.success
						: theme.colors.textDisabled,
				),
			});
		});
	}

	// ---------- footer ----------

	/**
	 * The one action the panel has, in the band the old layout kept for it.
	 *
	 * **The footer button is the chest, and its state is the whole of what this panel can do.** The mock
	 * put `OPEN BOX` here and showed it only when a box was open; this shows the chest while the Powers
	 * tab is up and there is still a power to win, and swaps itself for a line saying the roster is
	 * complete when there is not.
	 *
	 * **The outcome line lives here rather than on the shelf** because it is about the action, and
	 * because a shelf of fixed tiles is the one place in this panel with no room for a sentence of
	 * variable length. A grant names the power; a refusal is the server's `reason` string exactly as it
	 * arrives.
	 *
	 * `Visible` toggles rather than big-ui's `disabled` prop, and that is forced: big-ui reads its props
	 * at construction, so a `disabled` decided at build time could never react to the last chest being
	 * opened. A button that stays lit and refuses is worse than no button at all.
	 */
	private addFooter(parent: Frame, theme: HudTheme): void {
		const footer = Fusion.New(this.scope, "Frame")({
			Name: "Footer",
			Parent: parent,
			// Hugs what it holds rather than a footer height constant; `LayoutOrder` puts the band last.
			Size: new UDim2(1, 0, 0, 0),
			AutomaticSize: Enum.AutomaticSize.Y,
			LayoutOrder: 4,
			BackgroundTransparency: 1,
		});
		this.padBand(footer, SHOP_CONFIG.PAD_Y, SHOP_CONFIG.PAD_Y);
		Fusion.New(this.scope, "UIListLayout")({
			Parent: footer,
			FillDirection: Enum.FillDirection.Vertical,
			SortOrder: Enum.SortOrder.LayoutOrder,
			Padding: new UDim(0, SHOP_CONFIG.PAD_Y),
		});

		const outcome = Text(this.scope, { text: "", variant: "body2", wrap: false });
		outcome.Name = "ChestOutcome";
		outcome.Size = new UDim2(1, 0, 0, 20);
		outcome.AutomaticSize = Enum.AutomaticSize.None;
		outcome.TextXAlignment = Enum.TextXAlignment.Center;
		outcome.LayoutOrder = 1;
		outcome.Parent = footer;
		Fusion.Hydrate(this.scope, outcome)({
			Text: Fusion.Computed(this.scope, (use) => {
				const granted = use(this.chestGranted);
				const reason = use(this.chestReason);

				if (reason !== "") return reason;
				if (granted !== "" && isAbilityKind(granted)) return `You unlocked ${ABILITY_NAMES[granted]}!`;
				return "";
			}),
			TextColor3: Fusion.Computed(this.scope, (use) =>
				use(this.chestReason) !== "" ? theme.colors.warning : theme.colors.success,
			),
			Visible: Fusion.Computed(
				this.scope,
				(use) => use(this.chestGranted) !== "" || use(this.chestReason) !== "",
			),
		});

		const complete = Text(this.scope, { text: "All powers collected.", variant: "body2", wrap: false });
		complete.Name = "ChestComplete";
		complete.Size = new UDim2(1, 0, 0, 20);
		complete.AutomaticSize = Enum.AutomaticSize.None;
		complete.TextColor3 = theme.colors.success;
		complete.TextXAlignment = Enum.TextXAlignment.Center;
		complete.LayoutOrder = 2;
		complete.Parent = footer;
		Fusion.Hydrate(this.scope, complete)({
			Visible: Fusion.Computed(
				this.scope,
				(use) => use(this.currentTab) === "Powers" && this.unownedPowers(use(this.powers)).size() === 0,
			),
		});

		const open = Button(this.scope, {
			label: `Open chest · ${withCommas(ECONOMY_CONFIG.CHEST_COST)} coins`,
			variant: "contained",
			color: "primary",
			size: "large",
			fullWidth: true,
			layoutOrder: 3,
			onActivate: () => this.requestChest(),
		});
		open.Name = "OpenChestButton";
		open.Parent = footer;
		Fusion.Hydrate(this.scope, open)({
			Visible: Fusion.Computed(
				this.scope,
				(use) => use(this.currentTab) === "Powers" && this.unownedPowers(use(this.powers)).size() > 0,
			),
		});
	}

	// ---------- server contact ----------

	/** Asks for a chest. The whole of what this panel can ask the server to do. */
	private requestChest(): void {
		if (DEBUG) print("[Shop] asked for a Power Chest");

		// Cleared first, so a refusal cannot be read as the answer to the *previous* request while this
		// one is in flight. Nothing on the wire says which reply belongs to which press, and the only
		// thing worse than "not enough coins" is "not enough coins" left over from a minute ago.
		this.chestGranted.set("");
		this.chestReason.set("");

		this.chestRemote?.SendToServer();
	}

	/** The powers this player does not own, from an `OWNED_POWERS_ATTRIBUTE` string. */
	private unownedPowers(owned: string): AbilityKind[] {
		return POWER_ROSTER.filter((kind) => !ownsPower(owned, kind));
	}

	/**
	 * Bridges the three attributes into `Fusion` values.
	 *
	 * **A connection per attribute plus one read, which is `StatsBillboardController`'s shape and for
	 * its reason**: an attribute read inside a `Computed` is a sample rather than a dependency, so the
	 * value has to be pushed in from the changed signal for anything drawing it to update.
	 *
	 * The opening read is not redundant with the connections. A player who already has coins when this
	 * mounts — every player after their first match, and every player in Studio where the module reloads
	 * under a live session — would otherwise see zero until something *changed*, and an attribute that
	 * is already correct never fires a signal.
	 */
	private watchPlayer(): void {
		const player = Players.LocalPlayer;

		const readCoins = () => {
			const value = player.GetAttribute(COINS_ATTRIBUTE);
			this.coins.set(typeIs(value, "number") ? value : 0);
		};

		const readPowers = () => {
			const value = player.GetAttribute(OWNED_POWERS_ATTRIBUTE);
			this.powers.set(typeIs(value, "string") ? value : "");
		};

		const readCosmetics = () => {
			const value = player.GetAttribute(OWNED_COSMETICS_ATTRIBUTE);
			this.cosmetics.set(typeIs(value, "string") ? value : "");
		};

		this.scope.push(player.GetAttributeChangedSignal(COINS_ATTRIBUTE).Connect(readCoins));
		this.scope.push(player.GetAttributeChangedSignal(OWNED_POWERS_ATTRIBUTE).Connect(readPowers));
		this.scope.push(player.GetAttributeChangedSignal(OWNED_COSMETICS_ATTRIBUTE).Connect(readCosmetics));

		readCoins();
		readPowers();
		readCosmetics();
	}

	/**
	 * Takes the chest's answer, and resolves the request remote.
	 *
	 * **This is the first consumer `chestResult` has ever had.** The remote was declared, wired and
	 * compiled with nothing on the client listening, so no reply had been drawn anywhere before this —
	 * which means nothing about the path has been *observed*, only built. Since the log in hand shows
	 * the whole round trip working (a press, then `not enough coins` verbatim), what remains
	 * unconfirmed is only the success branch, which needs a wallet with 50 coins in it.
	 *
	 * `Get` yields, which is why the whole of this runs from `mount`'s `task.spawn` rather than inline —
	 * the same note `RoundResultController` makes about its own subscription.
	 */
	private watchChest(): void {
		this.chestRemote = events.Client.Get("openPowerChest");

		this.scope.push(
			events.Client.Get("chestResult").Connect((granted, reason) => {
				// The wire is not typed, so what arrives is checked rather than trusted — the treatment
				// every other handler in this client gives a string off a remote.
				const grantedText = typeIs(granted, "string") ? granted : "";
				const reasonText = typeIs(reason, "string") ? reason : "";

				this.chestGranted.set(grantedText);
				this.chestReason.set(reasonText);

				if (DEBUG) {
					print(
						`[Shop] chest replied — granted "${grantedText}", reason "${reasonText}"` +
							` (coins now ${Fusion.peek(this.coins)})`,
					);
				}
			}),
		);
	}
}
