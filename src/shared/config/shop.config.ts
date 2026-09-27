export const COLORS = {
    PANEL: Color3.fromRGB(26, 26, 32),
    SURFACE: Color3.fromRGB(44, 44, 54),
    BORDER: Color3.fromRGB(126, 126, 140),
    /** The header and tab bands. Lighter than the panel, so the panel reads as layered strips. */
    STRIP: Color3.fromRGB(58, 58, 70),
    TEXT: Color3.fromRGB(244, 244, 248),
    TEXT_MUTED: Color3.fromRGB(166, 166, 182),
    PLACEHOLDER: Color3.fromRGB(62, 62, 78),
    OWNED: Color3.fromRGB(126, 220, 126),
    COIN: Color3.fromRGB(255, 202, 92),
    GEM: Color3.fromRGB(92, 220, 200),
    ACCENT_TEXT: Color3.fromRGB(24, 24, 30),
    /** The shelf a price sits on, over artwork. */
    PRICE_CHIP: Color3.fromRGB(20, 20, 26),
    /** The `OWNED`-style grey bar the reference puts under a box. */
    BOX_BAR: Color3.fromRGB(196, 196, 204),
} as const;

export type TabName = "Effects" | "Powers" | "Emotes" | "Radios" | "Pets";

export interface TabDef {
    name: TabName;
    color: Color3;
}

export const TABS: TabDef[] = [
    { name: "Effects", color: Color3.fromRGB(240, 132, 60) },
    { name: "Powers", color: Color3.fromRGB(236, 200, 72) },
    { name: "Emotes", color: Color3.fromRGB(112, 200, 112) },
    { name: "Radios", color: Color3.fromRGB(92, 160, 236) },
    { name: "Pets", color: Color3.fromRGB(236, 132, 190) },
];

export type RarityName = "Common" | "Uncommon" | "Rare" | "Legendary" | "?????";

export interface RarityDef {
    name: RarityName;
    color: Color3;
}

/** Rarity colours live here and nowhere else, so a card's bar and an odds row cannot disagree. */
export const RARITIES: RarityDef[] = [
    { name: "Common", color: Color3.fromRGB(220, 220, 220) },
    { name: "Uncommon", color: Color3.fromRGB(105, 210, 231) },
    { name: "Rare", color: Color3.fromRGB(167, 219, 216) },
    { name: "Legendary", color: Color3.fromRGB(250, 105, 0) },
    { name: "?????", color: Color3.fromRGB(160, 100, 220) },
];

/** One odds row. `odds: 0` means the chance is not published, and prints a name and no number. */
export interface OddsDef {
    name: RarityName;
    odds: number;
}

export interface ItemDef {
    name: string;
    rarity: RarityName;
    owned: boolean;
}

/**
 * What is inside one *kind* of box.
 *
 * **The shop is two levels, and this is the second one.** The Effects tab lands on a grid of boxes
 * to browse — that is the screen a player actually arrives at — and clicking one of those boxes
 * opens its contents: the odds list and the items that could come out. Contents are shared by kind
 * rather than copied per box, so "Mystery Box #1" and "Mystery Box #2" describe the same pool, which
 * is what they are, and a ninth box is one entry in `BOXES` rather than another ten items.
 */
export interface BoxContents {
    odds: OddsDef[];
    items: ItemDef[];
}

export type BoxKind = "mystery" | "knife" | "bundle";

/** Every kind, in the order the detail panes are built. */
export const BOX_KINDS: BoxKind[] = ["mystery", "knife", "bundle"];

export const CONTENTS: Record<BoxKind, BoxContents> = {
    mystery: {
        odds: [
            { name: "Common", odds: 70 },
            { name: "Uncommon", odds: 15 },
            { name: "Rare", odds: 10 },
            { name: "Legendary", odds: 5 },
            { name: "?????", odds: 0 },
        ],
        items: [
            { name: "Clown", rarity: "Common", owned: true },
            { name: "Shaded", rarity: "Common", owned: true },
            { name: "Lovely", rarity: "Common", owned: true },
            { name: "Leaf", rarity: "Common", owned: true },
            { name: "Biogun", rarity: "Uncommon", owned: false },
            { name: "Graffiti", rarity: "Uncommon", owned: true },
            { name: "High Tech", rarity: "Uncommon", owned: true },
            { name: "Nightfire", rarity: "Rare", owned: true },
            { name: "Deep Sea", rarity: "Rare", owned: false },
            { name: "Splash", rarity: "Legendary", owned: false },
        ],
    },
    knife: {
        odds: [
            { name: "Common", odds: 55 },
            { name: "Uncommon", odds: 28 },
            { name: "Rare", odds: 13 },
            { name: "Legendary", odds: 4 },
            { name: "?????", odds: 0 },
        ],
        items: [
            { name: "Prism", rarity: "Common", owned: true },
            { name: "Carbon", rarity: "Common", owned: true },
            { name: "Rust", rarity: "Common", owned: false },
            { name: "Amber", rarity: "Uncommon", owned: true },
            { name: "Frostbite", rarity: "Uncommon", owned: false },
            { name: "Toxic", rarity: "Uncommon", owned: true },
            { name: "Neon Dusk", rarity: "Rare", owned: false },
            { name: "Sakura", rarity: "Rare", owned: true },
            { name: "Obsidian", rarity: "Legendary", owned: false },
            { name: "Chroma", rarity: "Legendary", owned: false },
        ],
    },
    bundle: {
        odds: [
            { name: "Uncommon", odds: 76 },
            { name: "Rare", odds: 20 },
            { name: "Legendary", odds: 4 },
        ],
        items: [
            { name: "Beach Ball", rarity: "Uncommon", owned: true },
            { name: "Sun Hat", rarity: "Uncommon", owned: false },
            { name: "Flip Flops", rarity: "Rare", owned: false },
            { name: "Ice Cream", rarity: "Rare", owned: true },
            { name: "Surf Board", rarity: "Rare", owned: false },
            { name: "Golden Bucket", rarity: "Legendary", owned: false },
        ],
    },
};

export interface BoxDef {
    name: string;
    price: number;
    /** The colour of the bar under the box, the way the reference tints bundle vs crate rows. */
    color: Color3;
    kind: BoxKind;
}

/** The Effects landing page, in the order it is drawn. 8 entries = two rows of four. */
export const BOXES: BoxDef[] = [
    { name: "Beach Bundle", price: 3399, color: Color3.fromRGB(236, 96, 190), kind: "bundle" },
    { name: "Retro Bundle", price: 799, color: Color3.fromRGB(236, 200, 72), kind: "bundle" },
    { name: "Beachy", price: 1699, color: Color3.fromRGB(236, 96, 190), kind: "bundle" },
    { name: "Sands", price: 1699, color: Color3.fromRGB(236, 96, 190), kind: "bundle" },
    { name: "Mystery Box #1", price: 499, color: Color3.fromRGB(196, 196, 204), kind: "mystery" },
    { name: "Mystery Box #2", price: 799, color: Color3.fromRGB(196, 196, 204), kind: "mystery" },
    { name: "Knife Box #1", price: 999, color: Color3.fromRGB(196, 196, 204), kind: "knife" },
    { name: "Knife Box #2", price: 1299, color: Color3.fromRGB(196, 196, 204), kind: "knife" },
];

/**
 * The shop's geometry.
 *
 * The chrome heights are the one part that cannot flex, so they come straight off the top of the
 * space the content lives in: `content = 0.8 * screenHeight - (header + tabs + footer)`. At the
 * original 46/66/44 that fixed cost was 156px and the content spilled past the panel's bottom edge;
 * the two sizes that made up the rest of the overshoot are proportional now rather than pixel-locked.
 */
export const SHOP_CONFIG = {
    COLORS,
    TABS,
    RARITIES,
    CONTENTS,
    BOX_KINDS,
    BOXES,

    // Less than the viewport is tall, because a panel that filled 80% of the height left a band of
    // empty panel under the content. The elements below are sized up to fill this instead.
    PANEL_SIZE: UDim2.fromScale(0.62, 0.72),
    PANEL_Z_INDEX: 10,

    /** `min-width` / `max-width`: a floor so it stays usable on a phone, a ceiling so it stops
     * stretching on an ultrawide. */
    PANEL_MIN_SIZE: new Vector2(520, 360),
    PANEL_MAX_SIZE: new Vector2(1440, 880),

    // --- the bands ---
    //
    // **No band heights and no top offsets, and nothing adds up.** The bands are stacked by a
    // `UIListLayout` on the panel and each is sized by its own contents; the content band carries a
    // `UIFlexItem` set to `Fill`, so it takes whatever is left over. That replaces the old
    // `CONTENT_TOP` / `CONTENT_HEIGHT_OFFSET` pair, which had to be recomputed by hand by anyone who
    // changed a band.
    /** Horizontal padding, as a fraction of the band's width, so it tracks the panel. */
    PAD_X: 0.015,
    /**
     * Vertical padding, in pixels — and it has to be pixels.
     *
     * A scale inset on a band that is sizing itself to its contents is a layout cycle: the padding
     * would be a fraction of a height that depends on the padding. Horizontal is safe because a
     * band's *width* comes from the panel, not from its contents.
     */
    PAD_Y: 8,

    /**
     * A tab's height in pixels, which is the one size here that should not scale.
     *
     * It is a touch target. A tab that shrank with the window would be unclickable on a phone, so
     * this is a floor by intent — the CSS equivalent of `min-height: 44px`.
     */
    TAB_HEIGHT: 48,
    /** Tab width as a fraction of the row, so five of them track the panel. */
    TAB_WIDTH_SCALE: 0.185,
    TAB_GAP: 8,
    HEADER_GAP: 10,

    /** The light frame around the whole panel. */
    BORDER_THICKNESS: 5,

    // --- the grids ---
    BOX_GRID_COLUMNS: 4,
    GRID_COLUMNS: 5,
    /**
     * The gap between cells, as a fraction of the grid.
     *
     * Cells must add up to exactly 1.0 along each axis. A single pixel over that total costs a whole
     * column, because the layout wraps rather than overflowing — so the gap is a scale value and the
     * cell size is derived from it below.
     */
    GRID_GAP_SCALE: 0.012,
    /** cellScale = (1 - (columns - 1) * gap) / columns, so columns + gaps = exactly 1.0. */
    BOX_CELL_SCALE: (1 - (4 - 1) * 0.012) / 4,
    ITEM_CELL_SCALE: (1 - (5 - 1) * 0.012) / 5,
    GRID_MIN_SIZE: new Vector2(240, 130),
    GRID_MAX_SIZE: new Vector2(1120, 620),

    // --- the detail view's left column ---
    /**
     * The box picture's height as a fraction of the column. It also carries a `UIFlexItem` set to
     * `Shrink`, so it is the one thing there that gives way when the panel is short — the name, the
     * odds header and the rows below it keep their size.
     */
    BOX_IMAGE_HEIGHT_SCALE: 0.34,
    COLUMN_SCALE: 0.32,
    COLUMN_GAP_SCALE: 0.012,
    COLUMN_GAP: 6,
    /**
     * One odds row, in pixels.
     *
     * Not an oversight: this is a `line-height`. A row of text needs a definite height for its two
     * labels to be split 70/30 across it, and letting the row size itself to those labels is a
     * cycle, because each label's height would then be a fraction of the row's.
     */
    ODDS_ROW_HEIGHT: 18,
    CHANCES_HEIGHT: 22,

    /** The back control's size on the detail view. */
    BACK_SIZE: UDim2.fromOffset(34, 26),
} as const;
