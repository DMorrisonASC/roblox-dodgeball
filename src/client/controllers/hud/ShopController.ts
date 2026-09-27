import { Controller, OnStart } from "@flamework/core";
import Fusion from "@rbxts/fusion-3.0";
import { Button, Text } from "@rbxts/big-ui";
import { getHudScreenGui } from "../../ui/screenGui";
import type { BoxContents, BoxDef, BoxKind, RarityName } from "shared/config/shop.config";
import { SHOP_CONFIG } from "shared/config/shop.config";

const { COLORS, TABS, RARITIES, CONTENTS, BOX_KINDS, BOXES } = SHOP_CONFIG;

/** The `selectedBox` value that means "no box is open" — the Effects landing page. */
const NO_BOX = "";

function withCommas(value: number): string {
    let digits = string.format("%d", math.floor(math.abs(value)));
    let grouped = "";
    let count = 0;

    // Peeled off the right, one character at a time, because that is the only end that is fixed:
    // grouping from the left gives `192,01` for a five-digit number.
    while (digits !== "") {
        grouped = string.sub(digits, -1) + grouped;
        digits = string.sub(digits, 1, -2);
        count += 1;
        if (count % 3 === 0 && digits !== "") grouped = "," + grouped;
    }

    return value < 0 ? "-" + grouped : grouped;
}

function rarityColorOf(name: RarityName): Color3 {
    for (const rarity of RARITIES) {
        if (rarity.name === name) return rarity.color;
    }

    return COLORS.TEXT;
}

/** The box a name refers to, or `undefined` for `NO_BOX` and anything unknown. */
function boxOf(name: string): BoxDef | undefined {
    for (const box of BOXES) {
        if (box.name === name) return box;
    }

    return undefined;
}

function contentsOf(kind: BoxKind): BoxContents {
    return CONTENTS[kind];
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
 * The shop, in two levels.
 *
 * **The Effects tab is a grid of boxes to browse; a box opens to show what is inside it.** That
 * order matters — the screen a player arrives at is the shelf, not the contents of one crate on it.
 *
 * Every view is built once, at mount, and only `Visible` ever changes. That is why there is one
 * detail pane per box *kind* rather than one pane that repopulates: big-ui components take their
 * contents at construction and cannot be told to change them afterwards, so a pane that followed the
 * selection would have to be torn down and rebuilt on every click. Three panes, three static
 * layouts, and a computed `Visible` each is both simpler and cheaper. It also means the whole tree
 * is built exactly once — see the `mounted` guard.
 */
@Controller()
export class ShopController implements OnStart {
    private scope = Fusion.scoped();
    private mounted = false;

    private isOpen = Fusion.Value(this.scope, false);
    private currentTab = Fusion.Value<(typeof TABS)[number]["name"]>(this.scope, "Effects");
    /** `NO_BOX` while the Effects landing grid is up; a box's name once one has been opened. */
    private selectedBox = Fusion.Value(this.scope, NO_BOX);

    onStart(): void {
        // Spawned rather than done inline, matching the other HUDs: mounting waits for `PlayerGui`,
        // and `onStart` is the wrong place to hold up the rest of the client's boot.
        task.spawn(() => this.mount());
    }

    private mount(): void {
        if (this.mounted) return;
        this.mounted = true;

        print("[Shop] button and panel up — no purchase logic, no remotes");
        this.addButton();
        this.addPanel();
    }

    private addButton(): void {
        const button = Button(this.scope, {
            label: "Shop",
            variant: "contained",
            color: "primary",
            size: "medium",
            onActivate: () => {
                this.isOpen.set(!Fusion.peek(this.isOpen));
                print(Fusion.peek(this.isOpen) ? "[Shop] opened" : "[Shop] closed");
            },
        });

        button.AutomaticSize = Enum.AutomaticSize.None; // clear big-ui's default X-only autosize
        button.Size = UDim2.fromOffset(120, 44);
        button.Position = UDim2.fromOffset(12, 12);
        button.AnchorPoint = new Vector2(0, 0);
        button.Parent = getHudScreenGui();
    }

    private addPanel(): void {
        const panel = Fusion.New(this.scope, "Frame")({
            Name: "ShopPanel",
            Size: SHOP_CONFIG.PANEL_SIZE, // fixed proportional size — no AutomaticSize here, ever
            AnchorPoint: new Vector2(0.5, 0.5),
            Position: UDim2.fromScale(0.5, 0.5),
            BackgroundColor3: COLORS.PANEL,
            BackgroundTransparency: 0,
            BorderSizePixel: 0,
            Visible: Fusion.Computed(this.scope, (use) => use(this.isOpen)),
            ZIndex: SHOP_CONFIG.PANEL_Z_INDEX,
        });

        Fusion.New(this.scope, "UICorner")({ Parent: panel, CornerRadius: new UDim(0, 10) });
        Fusion.New(this.scope, "UIStroke")({
            Parent: panel,
            Color: COLORS.BORDER,
            Thickness: SHOP_CONFIG.BORDER_THICKNESS,
            ApplyStrokeMode: Enum.ApplyStrokeMode.Border,
        });

        // No `UIPadding` on the panel, deliberately. The bands run edge to edge so the panel reads
        // as alternating strips. Each band applies its own inner margin.

        this.addHeader(panel);
        this.addTabs(panel);
        this.addContent(panel);
        this.addFooter(panel);

        // Every descendant at the panel's own ZIndex. Without this the panel's background covers
        // everything inside it — see `raiseZIndex`.
        raiseZIndex(panel, SHOP_CONFIG.PANEL_Z_INDEX);

        panel.Parent = getHudScreenGui(); // must stay the LAST statement in this method
    }

    /** The inner margin a band applies to its own contents. */
    private padBand(band: Frame, top: number, bottom: number): void {
        Fusion.New(this.scope, "UIPadding")({
            Parent: band,
            PaddingTop: new UDim(0, top),
            PaddingBottom: new UDim(0, bottom),
            PaddingLeft: new UDim(0, SHOP_CONFIG.BAND_PADDING),
            PaddingRight: new UDim(0, SHOP_CONFIG.BAND_PADDING),
        });
    }

    // ---------- header ----------

    private addHeader(parent: Frame): void {
        const header = Fusion.New(this.scope, "Frame")({
            Name: "Header",
            Parent: parent,
            Size: new UDim2(1, 0, 0, SHOP_CONFIG.HEADER_HEIGHT),
            Position: UDim2.fromOffset(0, 0),
            BackgroundColor3: COLORS.STRIP,
            BorderSizePixel: 0,
        });
        this.padBand(header, 0, 0);

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
            Padding: new UDim(0, 10),
        });

        const closeButton = Button(this.scope, {
            label: "X",
            size: "small",
            color: "error",
            layoutOrder: 1,
            onActivate: () => this.isOpen.set(false),
        });
        closeButton.Parent = left;

        // `wrap: false` is mandatory on every label in this file. big-ui defaults `TextWrapped` to
        // true, and a wrapped label inside an `AutomaticSize.X` parent is a measurement cycle that
        // Roblox breaks by collapsing the label to zero width — the title renders as nothing.
        const title = Text(this.scope, { text: "Shop", variant: "h4", wrap: false });
        title.TextColor3 = COLORS.TEXT;
        title.Size = UDim2.fromOffset(0, 0);
        title.AutomaticSize = Enum.AutomaticSize.XY;
        title.LayoutOrder = 2;
        title.Parent = left;

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
            Padding: new UDim(0, 8),
        });

        this.addCounter(right, "CoinsCounter", COLORS.COIN, "19,201", 1);
        this.addCounter(right, "GemsCounter", COLORS.GEM, "0", 2);

        const addCurrency = Button(this.scope, {
            label: "+",
            size: "small",
            color: "success",
            layoutOrder: 3,
            onActivate: () => print("[Shop] add currency clicked — no purchase logic"),
        });
        addCurrency.Parent = right;
    }

    private addCounter(parent: Frame, name: string, color: Color3, amount: string, layoutOrder: number): void {
        const pill = Fusion.New(this.scope, "Frame")({
            Name: name,
            Parent: parent,
            Size: UDim2.fromOffset(108, 30),
            BackgroundColor3: COLORS.SURFACE,
            LayoutOrder: layoutOrder,
        });
        Fusion.New(this.scope, "UICorner")({ Parent: pill, CornerRadius: new UDim(1, 0) });

        this.addCoin(pill, color, new UDim2(0, 8, 0.5, 0), 16);

        const amountLabel = Text(this.scope, { text: amount, variant: "body2", wrap: false });
        amountLabel.TextColor3 = color;
        amountLabel.Position = UDim2.fromOffset(30, 0);
        amountLabel.Size = new UDim2(1, -38, 1, 0);
        amountLabel.AutomaticSize = Enum.AutomaticSize.None;
        amountLabel.TextXAlignment = Enum.TextXAlignment.Left;
        amountLabel.TextYAlignment = Enum.TextYAlignment.Center;
        amountLabel.Parent = pill;
    }

    /** The little coloured disc that stands in for a currency icon. No asset behind it. */
    private addCoin(parent: Instance, color: Color3, position: UDim2, size: number): void {
        const coin = Fusion.New(this.scope, "ImageLabel")({
            Name: "Coin",
            Parent: parent,
            Size: UDim2.fromOffset(size, size),
            Position: position,
            AnchorPoint: new Vector2(0, 0.5),
            BackgroundColor3: color,
            BorderSizePixel: 0,
        });
        Fusion.New(this.scope, "UICorner")({ Parent: coin, CornerRadius: new UDim(1, 0) });
    }

    // ---------- tabs ----------

    private addTabs(parent: Frame): void {
        const tabRow = Fusion.New(this.scope, "Frame")({
            Name: "TabRow",
            Parent: parent,
            Size: new UDim2(1, 0, 0, SHOP_CONFIG.TAB_HEIGHT),
            Position: new UDim2(0, 0, 0, SHOP_CONFIG.HEADER_HEIGHT),
            BackgroundColor3: COLORS.STRIP,
            BorderSizePixel: 0,
        });
        this.padBand(tabRow, 6, 6);
        Fusion.New(this.scope, "UIListLayout")({
            Parent: tabRow,
            FillDirection: Enum.FillDirection.Horizontal,
            VerticalAlignment: Enum.VerticalAlignment.Center,
            SortOrder: Enum.SortOrder.LayoutOrder,
            Padding: new UDim(0, 8),
        });

        TABS.forEach((tab, index) => this.addTab(tabRow, tab, index + 1));
    }

    private addTab(parent: Frame, tab: (typeof TABS)[number], layoutOrder: number): void {
        // Raw TextButton, not big-ui Button — needs an arbitrary category colour, which big-ui's
        // Button cannot give us (only the 6-value colour enum), and a picture slot it has no prop for.
        const button = Fusion.New(this.scope, "TextButton")({
            Name: `${tab.name}Tab`,
            Parent: parent,
            Size: new UDim2(0, SHOP_CONFIG.TAB_WIDTH, 1, 0),
            BackgroundColor3: tab.color,
            BackgroundTransparency: Fusion.Computed(this.scope, (use) =>
                use(this.currentTab) === tab.name ? 0 : 0.35,
            ),
            AutoButtonColor: true,
            Text: "",
            LayoutOrder: layoutOrder,
            [Fusion.OnEvent("Activated")]: () => {
                this.currentTab.set(tab.name);
                this.selectedBox.set(NO_BOX);
                print(`[Shop] tab: ${tab.name}`);
            },
        });
        Fusion.New(this.scope, "UICorner")({ Parent: button, CornerRadius: new UDim(0, 5) });
        Fusion.New(this.scope, "UIStroke")({
            Parent: button,
            Color: COLORS.BORDER,
            Thickness: 1,
            Transparency: 0.5,
        });

        const image = Fusion.New(this.scope, "ImageLabel")({
            Name: "Image",
            Parent: button,
            Position: UDim2.fromOffset(3, 3),
            Size: new UDim2(1, -6, 1, -6),
            BackgroundColor3: COLORS.PLACEHOLDER,
            BackgroundTransparency: 0.2,
            BorderSizePixel: 0,
        });
        Fusion.New(this.scope, "UICorner")({ Parent: image, CornerRadius: new UDim(0, 4) });

        const label = Text(this.scope, { text: tab.name, variant: "subtitle2", wrap: false });
        label.TextColor3 = COLORS.TEXT;
        label.Size = new UDim2(1, 0, 0, 18);
        label.Position = new UDim2(0, 0, 1, -21);
        label.AutomaticSize = Enum.AutomaticSize.None;
        label.TextXAlignment = Enum.TextXAlignment.Center;
        label.Parent = button;
    }

    // ---------- content ----------

    private addContent(parent: Frame): void {
        const content = Fusion.New(this.scope, "Frame")({
            Name: "Content",
            Parent: parent,
            Size: new UDim2(1, 0, 1, SHOP_CONFIG.CONTENT_HEIGHT_OFFSET),
            Position: new UDim2(0, 0, 0, SHOP_CONFIG.CONTENT_TOP),
            BackgroundTransparency: 1,
        });
        this.padBand(content, 10, 10);

        this.addEffects(content);

        const comingSoon = Text(this.scope, {
            text: Fusion.Computed(this.scope, (use) => `${use(this.currentTab)} — coming soon`),
            variant: "h6",
            wrap: false,
        });
        comingSoon.TextColor3 = COLORS.TEXT_MUTED;
        comingSoon.Size = new UDim2(1, 0, 1, 0);
        comingSoon.AutomaticSize = Enum.AutomaticSize.None;
        comingSoon.TextXAlignment = Enum.TextXAlignment.Center;
        comingSoon.TextYAlignment = Enum.TextYAlignment.Center;
        comingSoon.Parent = content;
        Fusion.Hydrate(this.scope, comingSoon)({
            Visible: Fusion.Computed(this.scope, (use) => use(this.currentTab) !== "Effects"),
        });
    }

    /** The Effects tab: the box shelf, and one detail pane behind each kind of box. */
    private addEffects(parent: Frame): void {
        const effects = Fusion.New(this.scope, "Frame")({
            Name: "Effects",
            Parent: parent,
            Size: new UDim2(1, 0, 1, 0),
            BackgroundTransparency: 1,
            Visible: Fusion.Computed(this.scope, (use) => use(this.currentTab) === "Effects"),
        });

        this.addBoxList(effects);

        for (const kind of BOX_KINDS) {
            this.addBoxDetail(effects, kind);
        }
    }

    /**
     * The landing page: every box on the shelf, four across.
     *
     * A card is a `TextButton` rather than a big-ui component because the whole tile has to be the
     * click target — picking a box is the only way into the detail view, and the picture, the price
     * and the name bar are all parts of one button.
     */
    private addBoxList(parent: Frame): void {
        const list = Fusion.New(this.scope, "Frame")({
            Name: "BoxList",
            Parent: parent,
            Size: new UDim2(1, 0, 1, 0),
            BackgroundTransparency: 1,
            Visible: Fusion.Computed(this.scope, (use) => use(this.selectedBox) === NO_BOX),
        });

        const grid = Fusion.New(this.scope, "Frame")({
            Name: "BoxGrid",
            Parent: list,
            AnchorPoint: new Vector2(0.5, 0),
            Position: new UDim2(0.5, 0, 0, 0),
            // Fixed width pins 4 columns; the height is a share of the band so the rows always fit.
            Size: new UDim2(0, SHOP_CONFIG.BOX_GRID_WIDTH, 1, 0),
            BackgroundTransparency: 1,
        });

        const rows = math.max(1, math.ceil(BOXES.size() / SHOP_CONFIG.BOX_GRID_COLUMNS));
        Fusion.New(this.scope, "UIGridLayout")({
            Parent: grid,
            CellSize: new UDim2(0, SHOP_CONFIG.BOX_CELL_WIDTH, 1 / rows, 0),
            // Zero, deliberately: any padding pushes the cell total past 1.0 and costs a column, so
            // the gap between cards is drawn as an inset inside each cell instead.
            CellPadding: UDim2.fromOffset(0, 0),
            SortOrder: Enum.SortOrder.LayoutOrder,
        });

        BOXES.forEach((box, index) => this.addBoxCard(grid, box, index));
    }

    private addBoxCard(parent: Frame, box: BoxDef, layoutOrder: number): void {
        const cell = Fusion.New(this.scope, "Frame")({
            Name: box.name,
            Parent: parent,
            BackgroundTransparency: 1,
            LayoutOrder: layoutOrder,
        });

        const card = Fusion.New(this.scope, "TextButton")({
            Name: "Card",
            Parent: cell,
            Position: UDim2.fromOffset(SHOP_CONFIG.BOX_CELL_GAP / 2, SHOP_CONFIG.BOX_CELL_GAP / 2),
            Size: new UDim2(1, -SHOP_CONFIG.BOX_CELL_GAP, 1, -SHOP_CONFIG.BOX_CELL_GAP),
            BackgroundColor3: COLORS.SURFACE,
            BorderSizePixel: 0,
            AutoButtonColor: true,
            Text: "",
            [Fusion.OnEvent("Activated")]: () => {
                this.selectedBox.set(box.name);
                print(`[Shop] opened ${box.name}`);
            },
        });
        Fusion.New(this.scope, "UICorner")({ Parent: card, CornerRadius: new UDim(0, 6) });

        const art = Fusion.New(this.scope, "ImageLabel")({
            Name: "Art",
            Parent: card,
            Position: UDim2.fromOffset(4, 4),
            Size: new UDim2(1, -8, 1, -34),
            BackgroundColor3: COLORS.PLACEHOLDER,
            BorderSizePixel: 0,
        });
        Fusion.New(this.scope, "UICorner")({ Parent: art, CornerRadius: new UDim(0, 4) });

        // The price shelf, sitting on the bottom of the artwork the way the reference has it.
        const chip = Fusion.New(this.scope, "Frame")({
            Name: "Price",
            Parent: card,
            AnchorPoint: new Vector2(0, 1),
            Position: new UDim2(0, 10, 1, -38),
            Size: UDim2.fromOffset(78, 20),
            BackgroundColor3: COLORS.PRICE_CHIP,
            BackgroundTransparency: 0.15,
            BorderSizePixel: 0,
        });
        Fusion.New(this.scope, "UICorner")({ Parent: chip, CornerRadius: new UDim(1, 0) });
        this.addCoin(chip, COLORS.COIN, new UDim2(0, 5, 0.5, 0), 12);

        const priceLabel = Text(this.scope, { text: withCommas(box.price), variant: "caption", wrap: false });
        priceLabel.TextColor3 = COLORS.TEXT;
        priceLabel.Position = UDim2.fromOffset(22, 0);
        priceLabel.Size = new UDim2(1, -28, 1, 0);
        priceLabel.AutomaticSize = Enum.AutomaticSize.None;
        priceLabel.TextXAlignment = Enum.TextXAlignment.Left;
        priceLabel.TextYAlignment = Enum.TextYAlignment.Center;
        priceLabel.Parent = chip;

        const nameBar = Fusion.New(this.scope, "Frame")({
            Name: "NameBar",
            Parent: card,
            Position: new UDim2(0, 0, 1, -30),
            Size: new UDim2(1, 0, 0, 30),
            BackgroundColor3: box.color,
            BorderSizePixel: 0,
        });
        Fusion.New(this.scope, "UICorner")({ Parent: nameBar, CornerRadius: new UDim(0, 6) });

        const nameLabel = Text(this.scope, { text: box.name, variant: "subtitle2", wrap: false });
        nameLabel.TextColor3 = COLORS.ACCENT_TEXT;
        nameLabel.Size = new UDim2(1, -8, 1, 0);
        nameLabel.Position = UDim2.fromOffset(4, 0);
        nameLabel.AutomaticSize = Enum.AutomaticSize.None;
        nameLabel.TextXAlignment = Enum.TextXAlignment.Center;
        nameLabel.TextYAlignment = Enum.TextYAlignment.Center;
        nameLabel.Parent = nameBar;
    }

    /**
     * One box's contents: what the player sees after picking a box off the shelf.
     *
     * Built once per *kind*, so a click only flips `selectedBox`. The name bar reads the selected
     * box's name through a `Computed`, which is what lets one pane serve every box of its kind
     * without being rebuilt. `Back` returns to the shelf.
     */
    private addBoxDetail(parent: Frame, kind: BoxKind): void {
        const contents = contentsOf(kind);

        const detail = Fusion.New(this.scope, "Frame")({
            Name: `${kind}Detail`,
            Parent: parent,
            Size: new UDim2(1, 0, 1, 0),
            BackgroundTransparency: 1,
            Visible: Fusion.Computed(this.scope, (use) => {
                const box = boxOf(use(this.selectedBox));
                return box !== undefined && box.kind === kind;
            }),
        });

        const back = Button(this.scope, {
            label: "<",
            size: "small",
            color: "secondary",
            onActivate: () => this.selectedBox.set(NO_BOX),
        });
        back.Name = "BackButton";
        back.Position = UDim2.fromOffset(0, 0);
        back.Parent = detail;

        const left = Fusion.New(this.scope, "Frame")({
            Name: "BoxColumn",
            Parent: detail,
            Size: new UDim2(0.3, 0, 1, 0),
            BackgroundTransparency: 1,
        });
        Fusion.New(this.scope, "UIListLayout")({
            Parent: left,
            FillDirection: Enum.FillDirection.Vertical,
            HorizontalAlignment: Enum.HorizontalAlignment.Center,
            SortOrder: Enum.SortOrder.LayoutOrder,
            Padding: new UDim(0, SHOP_CONFIG.COLUMN_GAP),
        });

        const boxImage = Fusion.New(this.scope, "ImageLabel")({
            Name: "BoxImage",
            Parent: left,
            // A share of the column, not a fixed 200px, so the picture gives way on a short screen
            // instead of pushing its own odds rows out of the bottom of the panel.
            Size: UDim2.fromScale(1, SHOP_CONFIG.BOX_IMAGE_HEIGHT_SCALE),
            BackgroundColor3: COLORS.PLACEHOLDER,
            LayoutOrder: 1,
        });
        Fusion.New(this.scope, "UICorner")({ Parent: boxImage, CornerRadius: new UDim(0, 8) });
        Fusion.New(this.scope, "UIAspectRatioConstraint")({
            Parent: boxImage,
            AspectRatio: 1,
            AspectType: Enum.AspectType.FitWithinMaxSize,
        });

        const boxName = Fusion.New(this.scope, "Frame")({
            Name: "BoxName",
            Parent: left,
            Size: new UDim2(1, 0, 0, SHOP_CONFIG.BOX_NAME_HEIGHT),
            BackgroundColor3: COLORS.SURFACE,
            LayoutOrder: 2,
        });
        Fusion.New(this.scope, "UICorner")({ Parent: boxName, CornerRadius: new UDim(0, 4) });

        // The one reactive label in the detail: whichever box of this kind is open.
        const boxNameLabel = Text(this.scope, {
            text: Fusion.Computed(this.scope, (use) => {
                const box = boxOf(use(this.selectedBox));
                return box !== undefined && box.kind === kind ? box.name : "";
            }),
            variant: "subtitle2",
            wrap: false,
        });
        boxNameLabel.TextColor3 = COLORS.TEXT;
        boxNameLabel.Size = new UDim2(1, 0, 1, 0);
        boxNameLabel.AutomaticSize = Enum.AutomaticSize.None;
        boxNameLabel.TextXAlignment = Enum.TextXAlignment.Center;
        boxNameLabel.TextYAlignment = Enum.TextYAlignment.Center;
        boxNameLabel.Parent = boxName;

        // The odds, as the reference draws them: a shaded sub-header, then a name and a percentage
        // on opposite edges of each row. Two labels per row rather than one padded string, because
        // a fixed-width string only lines up in one font at one size.
        const chancesBar = Fusion.New(this.scope, "Frame")({
            Name: "ChancesBar",
            Parent: left,
            Size: new UDim2(1, 0, 0, SHOP_CONFIG.CHANCES_HEIGHT),
            BackgroundColor3: COLORS.SURFACE,
            LayoutOrder: 3,
        });
        Fusion.New(this.scope, "UICorner")({ Parent: chancesBar, CornerRadius: new UDim(0, 4) });

        const chancesLabel = Text(this.scope, { text: "Item Chances", variant: "body2", wrap: false });
        chancesLabel.TextColor3 = COLORS.TEXT;
        chancesLabel.Size = new UDim2(1, 0, 1, 0);
        chancesLabel.AutomaticSize = Enum.AutomaticSize.None;
        chancesLabel.TextXAlignment = Enum.TextXAlignment.Center;
        chancesLabel.TextYAlignment = Enum.TextYAlignment.Center;
        chancesLabel.Parent = chancesBar;

        contents.odds.forEach((odds, index) => {
            const row = Fusion.New(this.scope, "Frame")({
                Name: `${odds.name}Odds`,
                Parent: left,
                Size: new UDim2(1, 0, 0, SHOP_CONFIG.ODDS_ROW_HEIGHT),
                BackgroundTransparency: 1,
                LayoutOrder: 4 + index,
            });

            const rowColor = rarityColorOf(odds.name);

            const nameLabel = Text(this.scope, { text: odds.name, variant: "body2", wrap: false });
            nameLabel.TextColor3 = rowColor;
            nameLabel.Size = new UDim2(0.7, 0, 1, 0);
            nameLabel.AutomaticSize = Enum.AutomaticSize.None;
            nameLabel.TextXAlignment = Enum.TextXAlignment.Left;
            nameLabel.TextYAlignment = Enum.TextYAlignment.Center;
            nameLabel.Parent = row;

            // `?` for a chance the box does not publish — not `0%`, which would be a lie.
            const pctLabel = Text(this.scope, {
                text: odds.odds > 0 ? `${odds.odds}%` : "?",
                variant: "body2",
                wrap: false,
            });
            pctLabel.TextColor3 = rowColor;
            pctLabel.Position = new UDim2(0.7, 0, 0, 0);
            pctLabel.Size = new UDim2(0.3, 0, 1, 0);
            pctLabel.AutomaticSize = Enum.AutomaticSize.None;
            pctLabel.TextXAlignment = Enum.TextXAlignment.Right;
            pctLabel.TextYAlignment = Enum.TextYAlignment.Center;
            pctLabel.Parent = row;
        });

        this.addItemColumn(detail, contents);
    }

    /** The right-hand side: the heading, and the items this box can give. */
    private addItemColumn(parent: Frame, contents: BoxContents): void {
        const column = Fusion.New(this.scope, "Frame")({
            Name: "ItemColumn",
            Parent: parent,
            Position: new UDim2(0.3, 12, 0, 0),
            Size: new UDim2(0.7, -12, 1, 0),
            BackgroundTransparency: 1,
        });

        const heading = Text(this.scope, {
            text: "You will receive a random chance at...",
            variant: "h6",
            wrap: false,
        });
        heading.TextColor3 = COLORS.TEXT;
        heading.Size = new UDim2(1, 0, 0, SHOP_CONFIG.HEADING_HEIGHT);
        heading.AutomaticSize = Enum.AutomaticSize.None;
        heading.TextXAlignment = Enum.TextXAlignment.Center;
        heading.Parent = column;

        const rows = math.max(1, math.ceil(contents.items.size() / SHOP_CONFIG.GRID_COLUMNS));

        const grid = Fusion.New(this.scope, "Frame")({
            Name: "ItemGrid",
            Parent: column,
            AnchorPoint: new Vector2(0.5, 0),
            Position: new UDim2(0.5, 0, 0, SHOP_CONFIG.GRID_TOP),
            // Width pinned in pixels — that is what fixes the column count at 5 — and height taken
            // from the column, so it shrinks on a short screen instead of overflowing the panel.
            Size: new UDim2(0, SHOP_CONFIG.GRID_WIDTH, 1, -SHOP_CONFIG.GRID_TOP),
            BackgroundTransparency: 1,
        });
        Fusion.New(this.scope, "UISizeConstraint")({
            Parent: grid,
            MaxSize: new Vector2(math.huge, SHOP_CONFIG.GRID_MAX_HEIGHT),
        });
        Fusion.New(this.scope, "UIGridLayout")({
            Parent: grid,
            // `1 / rows` of the grid, so `rows` cells stacked fill it exactly and nothing wraps.
            CellSize: new UDim2(0, SHOP_CONFIG.CELL_WIDTH, 1 / rows, 0),
            CellPadding: UDim2.fromOffset(0, 0),
            SortOrder: Enum.SortOrder.LayoutOrder,
        });

        contents.items.forEach((item, index) => this.addCell(grid, item, index));
    }

    private addCell(parent: Frame, item: (typeof CONTENTS)["mystery"]["items"][number], layoutOrder: number): void {
        const rarityColor = rarityColorOf(item.rarity);

        // Two frames per card: the grid cell, which the layout sizes and which stays transparent,
        // and the card inside it, inset by half the gap. That inset is the only reason the gap
        // exists — the layout's own `CellPadding` is zero.
        const cell = Fusion.New(this.scope, "Frame")({
            Name: item.name,
            Parent: parent,
            BackgroundTransparency: 1,
            LayoutOrder: layoutOrder,
        });

        const card = Fusion.New(this.scope, "Frame")({
            Name: "Card",
            Parent: cell,
            Position: UDim2.fromOffset(SHOP_CONFIG.CELL_GAP / 2, SHOP_CONFIG.CELL_GAP / 2),
            Size: new UDim2(1, -SHOP_CONFIG.CELL_GAP, 1, -SHOP_CONFIG.CELL_GAP),
            BackgroundColor3: COLORS.SURFACE,
        });
        Fusion.New(this.scope, "UICorner")({ Parent: card, CornerRadius: new UDim(0, 4) });

        const image = Fusion.New(this.scope, "ImageLabel")({
            Name: "Image",
            Parent: card,
            Size: new UDim2(1, 0, 1, -26),
            BackgroundColor3: COLORS.PLACEHOLDER,
        });
        Fusion.New(this.scope, "UICorner")({ Parent: image, CornerRadius: new UDim(0, 4) });

        if (item.owned) {
            const ownedBadge = Text(this.scope, { text: "OWNED", variant: "caption", wrap: false });
            ownedBadge.TextColor3 = COLORS.OWNED;
            ownedBadge.AnchorPoint = new Vector2(0.5, 0);
            ownedBadge.Position = new UDim2(0.5, 0, 0, 6);
            ownedBadge.Size = new UDim2(1, 0, 0, 14);
            ownedBadge.AutomaticSize = Enum.AutomaticSize.None;
            ownedBadge.TextXAlignment = Enum.TextXAlignment.Center;
            ownedBadge.Parent = card;
        }

        const nameBar = Fusion.New(this.scope, "Frame")({
            Name: "NameBar",
            Parent: card,
            Position: new UDim2(0, 0, 1, -26),
            Size: new UDim2(1, 0, 0, 26),
            BackgroundColor3: rarityColor,
        });
        Fusion.New(this.scope, "UICorner")({ Parent: nameBar, CornerRadius: new UDim(0, 4) });

        const nameLabel = Text(this.scope, { text: item.name, variant: "caption", wrap: false });
        nameLabel.TextColor3 = COLORS.ACCENT_TEXT;
        nameLabel.Size = new UDim2(1, -8, 1, 0);
        nameLabel.Position = UDim2.fromOffset(4, 0);
        nameLabel.AutomaticSize = Enum.AutomaticSize.None;
        nameLabel.TextXAlignment = Enum.TextXAlignment.Center;
        nameLabel.TextYAlignment = Enum.TextYAlignment.Center;
        nameLabel.Parent = nameBar;
    }

    // ---------- footer ----------

    private addFooter(parent: Frame): void {
        const footer = Fusion.New(this.scope, "Frame")({
            Name: "Footer",
            Parent: parent,
            Size: new UDim2(1, 0, 0, SHOP_CONFIG.FOOTER_HEIGHT),
            Position: new UDim2(0, 0, 1, -SHOP_CONFIG.FOOTER_HEIGHT),
            BackgroundColor3: COLORS.STRIP,
            BorderSizePixel: 0,
        });
        this.padBand(footer, 6, 6);

        // The action belongs to the box that is open, so the footer button is hidden on the shelf.
        // `Hydrate`, because big-ui's `Button` has no reactive prop this could ride on.
        const openBox = Button(this.scope, {
            label: "OPEN BOX",
            variant: "contained",
            color: "primary",
            size: "large",
            fullWidth: true,
            onActivate: () => print("[Shop] open box clicked — no purchase logic, no remotes"),
        });
        openBox.Name = "OpenBoxButton";
        openBox.Parent = footer;
        Fusion.Hydrate(this.scope, openBox)({
            Visible: Fusion.Computed(this.scope, (use) => use(this.selectedBox) !== NO_BOX),
        });
    }
}
