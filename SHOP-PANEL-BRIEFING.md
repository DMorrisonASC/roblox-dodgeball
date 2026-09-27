# Shop panel renders almost empty — briefing for a visual-capable model

You are debugging a Roblox UI that **renders a dark panel with almost nothing inside it**. Two
screenshots exist: one of the current (broken) render, one of the target design. If you can see
images, ask for both — the open question is largely *"which parts are actually on screen"*, and that
is a visual question.

Repo: `roblox-dodgeball` (roblox-ts). Everything below is verified against this repo's source or its
installed dependencies, not recalled.

---

## 1. Symptom

A shop panel opens correctly (dark, rounded, centred, ~80% of the viewport). Inside it:

**Visible:**
- the `X` close button, top-left of the panel
- a very faint thin horizontal line near the top
- `OPEN BOX` text near the bottom
- a row of saturated coloured bars near the bottom (cyan ×3, orange ×1)

**Not visible:**
- the `Shop` title
- both currency counter pills (coin, gem) and the `+` button
- the five tab tiles
- the box picture, the box name bar, all five rarity rows
- the item grid: card backgrounds, card image placeholders, `OWNED` badges, item names

**A very strong hint:** the two things that DO render (`X`, `OPEN BOX`) are both big-ui `Button`s.
Nearly everything missing is a big-ui `Text` label or a raw `Frame`/`ImageLabel` placeholder. The
coloured bars that do render are the item cards' name-bar `Frame`s (rarity-coloured fills).

### Aspect ratios (may matter a lot)
- Broken screenshot: roughly **1282 × 380 (≈3.37:1)**
- Target screenshot: roughly **1172 × 761 (≈1.54:1)**

The panel root is `Size = UDim2(0.8, 0, 0.8, 0)`, so a full-viewport screenshot of it should have the
**viewport's** aspect ratio. If the broken shot is a genuine uncropped capture, the viewport is
extraordinarily short — and see §7, the layout provably collapses below ~700px of viewport height.
If it is a crop, ignore the ratio. **Establish which it is before theorising.**

In the broken shot the panel appears to span ~98% of the image width with only ~12px margins. At
`0.8` scale, a full-width capture would show ~10% margins (~128px each side). That mismatch is worth
a direct look: either the capture is cropped tight to the panel, or `PANEL_SIZE` is not what it says.

---

## 2. Exact element colours (to identify things in a screenshot)

Panel chrome:
| Token | RGB | Used for |
|---|---|---|
| `PANEL` | 26, 26, 32 | the panel background |
| `SURFACE` | 44, 44, 54 | counter pills, box name bar, card backgrounds |
| `BORDER` | 72, 72, 90 | the panel's `UIStroke` |
| `TEXT` | 244, 244, 248 | body text |
| `TEXT_MUTED` | 166, 166, 182 | the "coming soon" line |
| `PLACEHOLDER` | 62, 62, 78 | every empty image slot |
| `OWNED` | 126, 220, 126 | the OWNED badge |
| `COIN` | 255, 202, 92 | coin icon slot + amount |
| `GEM` | 92, 220, 200 | gem icon slot + amount |
| `ACCENT_TEXT` | 24, 24, 30 | text drawn on saturated fills |

Tab colours: Effects `240,132,60` (orange) · Powers `236,200,72` (yellow) · Emotes `112,200,112`
(green) · Radios `92,160,236` (blue) · Pets `236,132,190` (pink).

Rarity colours: Common `220,220,220` · Uncommon `105,210,231` · Rare `167,219,216` · Legendary
`250,105,0` · ????? `160,100,220`.

Note `PLACEHOLDER (62,62,78)` vs `PANEL (26,26,32)` vs `SURFACE (44,44,54)` — all three are dark and
close together. If the placeholders and cards are rendering but simply read as "dark", they will be
nearly invisible in a dark screenshot. **This is a plausible false lead: the content may be drawing
and just not discernible.** Consider asking for a build with `PLACEHOLDER` temporarily set to
magenta to settle "not drawn" vs "drawn but dark" in one frame.

---

## 3. Stack

- roblox-ts 3.0.0, TypeScript 5.5.3. Build: `npm run build` (= `rbxtsc`), also `npm run watch`.
- Flamework 1.3.2 (`@flamework/core`, `@flamework/components`), transformer `rbxts-transformer-flamework`.
- `@rbxts/big-ui` **1.1.3**
- `@rbxts/fusion-3.0` **0.1.0** (the package version; it is Fusion 3)
- Rojo 2.0.0. `default.project.json` maps `out/client` → `StarterPlayerScripts.TS`,
  `out/shared` → `ReplicatedStorage.TS`, `out/server` → `ServerScriptService.TS`.
- tsconfig: `baseUrl: "src"`, `rootDir: "src"`, `outDir: "out"`, `strict: true`, **`noLib: true`**,
  `typeRoots: ["node_modules/@rbxts", "node_modules/@flamework"]`.
  Imports use the `shared/...` alias (resolved via `baseUrl`), e.g. `import { SHOP_CONFIG } from "shared/config/shop.config"`.

---

## 4. Files

| Path | Lines | Role |
|---|---|---|
| `src/client/controllers/hud/ShopController.ts` | **866** | the whole shop: button + panel + all sections |
| `src/shared/config/shop.config.ts` | 135 | all geometry, colours, tabs, rarities, items |
| `src/client/ui/screenGui.ts` | 57 | the shared `ScreenGui` (see §6) |
| `src/client/ui/hudTheme.ts` | ~110 | the only seam onto big-ui's palette; HUD controllers are forbidden from importing big-ui theme tables or writing `Color3.fromRGB` |

The controller is one file by design (mirrors `CooldownHudController`), with private methods:
`mount`, `addButton`, `addPanel`, `addHeader`, `addCounter`, `addTabs`, `addTab`, `addContent`,
`addEffects`, `addBoxColumn`, `addItemColumn`, `addCell`, `addFooter`, `label`.

Module-level helpers: `countOf`, `withThousands`, `rarityColorOf`, `gridWidth`, `oddsText`.

---

## 5. Complete layout tree (exact values)

```
PlayerGui
└── HudGui                    ScreenGui  ResetOnSpawn = false, ScreenInsets = None
    ├── ShopButton            big-ui Button → TextButton, 120×44
    │                         AutomaticSize cleared to None, Position (0,12,0,12), AnchorPoint (0,0)
    └── ShopPanel             Frame   Visible = isOpen (Fusion.Value(false)); ZIndex = 10
        │                     Size = (0.8, 0, 0.8, 0)
        │                     AnchorPoint (0.5, 0.5), Position (0.5, 0, 0.5, 0)
        │                     BackgroundColor3 = PANEL, BackgroundTransparency = 0
        │                     + UICorner 8
        │                     + UIStroke BORDER, thickness 2, ApplyStrokeMode = Border
        │                     + UIPadding top/bottom/left/right = 14
        │
        ├── Header            Frame  Size (1,0,0,46)  Position (0,0,0,0)  BgTransparency 1
        │   ├── Left          Frame  Size (0,0,1,0)  AutomaticSize.X  BgTransparency 1
        │   │                 + UIListLayout Horizontal, VerticalAlignment Center,
        │   │                   SortOrder LayoutOrder, Padding 10
        │   │   ├── CloseButton    big-ui Button  label "X", size small, color error   LayoutOrder 1
        │   │   └── title          big-ui Text "Shop" h4, wrap:false, TextColor3 = TEXT
        │   │                      then Size (0,0,0,0) + AutomaticSize XY          LayoutOrder 2
        │   └── Right         Frame  Size (0,0,0,0)  AutomaticSize.XY
        │                     AnchorPoint (1, 0.5)  Position (1, 0, 0.5, 0)  BgTransparency 1
        │                     + UIListLayout Horizontal, VerticalAlignment Center, Padding 8
        │       ├── CoinsCounter   Frame 108×30  BackgroundColor3 = SURFACE  LayoutOrder 1
        │       │                  + UICorner (1, 0)   [pill]
        │       │   ├── Icon       ImageLabel 16×16  BackgroundColor3 = COIN
        │       │   │              Position (0,8,0.5,0) AnchorPoint (0,0.5) + pill corner
        │       │   └── Amount     big-ui Text body2, TextColor3 = COIN
        │       │                  Position (0,30,0,0)  Size (1,-38,1,0)
        │       │                  AutomaticSize None, XAlign Left, YAlign Center
        │       ├── GemsCounter    identical, LayoutOrder 2, GEM colours, value from gems
        │       └── AddCurrencyButton  big-ui Button "+", size small, color success  LayoutOrder 3
        │
        ├── TabRow            Frame  Size (1,0,0,66)  Position (0,0,0,56)  BgTransparency 1
        │                     + UIListLayout Horizontal, SortOrder LayoutOrder, Padding 10
        │   └── ×5 EffectTab/PowersTab/…   TextButton 108×66
        │                     BackgroundColor3 = category colour
        │                     BackgroundTransparency = Computed(selected ? 0 : 0.3)
        │                     AutoButtonColor = true,  Text = "",  + UICorner 4
        │       ├── Image     ImageLabel  Size (1,-12,0,30)  Position (0.5,0,0,8) AnchorPoint (0.5,0)
        │       │             BackgroundColor3 = PLACEHOLDER, BackgroundTransparency 0.25, + UICorner 4
        │       └── label     big-ui Text caption, wrap:false, TextColor3 = ACCENT_TEXT
        │                     Size (1,0,0,16)  Position (0,0,1,-20)  XAlign Center
        │
        ├── Content           Frame  Size (1,0,1,-186)  Position (0,0,0,132)  BgTransparency 1
        │   ├── Effects       Frame  Size (1,0,1,0)  BgTransparency 1
        │   │                 Visible = Computed(currentTab === "Effects")
        │   │   ├── BoxColumn     Frame  Size (0.32,0,1,0)  BgTransparency 1
        │   │   │                 + UIListLayout Vertical, HorizontalAlignment Center,
        │   │   │                   SortOrder LayoutOrder, Padding 6
        │   │   │   ├── BoxImage  ImageLabel 200×200  BackgroundColor3 = PLACEHOLDER + UICorner 8    LayoutOrder 1
        │   │   │   ├── BoxName   Frame 200×28  BackgroundColor3 = SURFACE + UICorner 4            LayoutOrder 2
        │   │   │   │   └── big-ui Text "Mystery Box #2" subtitle2, TEXT, Size (1,0,1,0),
        │   │   │   │       AutomaticSize None, XAlign Center, YAlign Center
        │   │   │   └── ×5 odds rows   big-ui Text body2, wrap:false,
        │   │   │         TextColor3 = rarity colour, XAlign Left                LayoutOrder 3..7
        │   │   └── ItemColumn    Frame  Position (0.32,10,0,0)  Size (0.68,-10,1,0)  BgTransparency 1
        │   │       ├── Heading   big-ui Text "You will receive a random chance at…" h6,
        │   │       │             wrap:false, TextColor3 = TEXT
        │   │       │             Size (1,0,0,28), AutomaticSize None, XAlign Center
        │   │       └── ItemGrid  Frame  AnchorPoint (0.5,0)  Position (0.5,0,0,36)
        │   │                     Size (0,632,0,0)  + AutomaticSize.Y  BgTransparency 1
        │   │                     + UIGridLayout  CellSize (120,140), CellPadding (8,8),
        │   │                       SortOrder LayoutOrder
        │   │           └── ×10 Cell   Frame 120×140  BackgroundColor3 = SURFACE + UICorner 4
        │   │               ├── Image       ImageLabel  Size (1,0,1,-26)
        │   │               │               BackgroundColor3 = PLACEHOLDER + UICorner 4
        │   │               ├── OwnedBadge  big-ui Text "OWNED" caption, wrap:false, TextColor3 = OWNED
        │   │               │               (only when owned)   AnchorPoint (0.5,0)
        │   │               │               Position (0.5,0,0,6)  Size (1,0,0,14)  XAlign Center
        │   │               └── NameBar     Frame  Position (0,0,1,-26)  Size (1,0,0,26)
        │   │                               BackgroundColor3 = rarity colour + UICorner 4
        │   │                   └── big-ui Text (item name) caption, wrap:false,
        │   │                       TextColor3 = ACCENT_TEXT   Size (1,-8,1,0)
        │   │                       Position (0,4,0,0)  XAlign Center, YAlign Center
        │   └── ComingSoon    big-ui Text  text = Computed(`${currentTab} — coming soon`), h6,
        │                     wrap:false, TextColor3 = TEXT_MUTED
        │                     Size (1,0,1,0), AutomaticSize None, XAlign Center, YAlign Center
        │                     Visible via Fusion.Hydrate = Computed(currentTab !== "Effects")
        │
        └── Footer            Frame  Size (1,0,0,44)  Position (0,0,1,-44)  BgTransparency 1
            └── OpenBoxButton big-ui Button  label "OPEN BOX", variant contained,
                              color primary, size large, fullWidth: true
```

Order of construction inside `addPanel`: corner, stroke, padding, then
`addHeader` → `addTabs` → `addContent` → `addFooter`, and **`panel.Parent = getHudScreenGui()` is the
last statement**. So if the panel is on screen at all, every section ran to completion — unless the
panel is being rendered from a stale frame.

---

## 6. Verified third-party API contracts

These were read out of the installed packages. **Do not re-derive them; do not assume MUI-like
behaviour.** Several of the bugs in this codebase's history came from guessing here.

### big-ui 1.1.3 — `Button`

```ts
interface ButtonProps {
  label: string;                                   // REQUIRED
  variant?: "contained" | "outlined" | "text";     // no "button" variant
  color?: "primary" | "secondary" | "error" | "warning" | "info" | "success";  // 6 values only
  size?: "small" | "medium" | "large";             // height bundle 30 / 36 / 42
  disabled?: boolean;
  loading?: Fusion.UsedAs<boolean>;
  fullWidth?: boolean;
  startIcon?: IconName;                            // icon-SHEET glyph, NOT an image id
  endIcon?: IconName;
  onActivate?: () => void;
  layoutOrder?: number;
}
function Button(scope, props): TextButton          // a real TextButton → .Activated works
```

- **No `children` prop.** Anything nested must be parented onto the returned `TextButton`.
- **No arbitrary background colour** — `BackgroundColor3` is computed from `paletteFor(color)`.
- **Draws `label` in UPPERCASE** (`string.upper(props.label)`).
- **Ships `AutomaticSize = Enum.AutomaticSize.X`** (height fixed). An automatic axis **beats**
  `Size`, so `button.Size = …` alone does nothing visible — clear `AutomaticSize` first.
  `fullWidth: true` does this for you: sets `Size = (1,0,0,height)` and `AutomaticSize = None`.
- Root `Name = "Button"`; builds a child `Content` Frame with a **horizontal** `UIListLayout` and a
  child `Label` TextLabel (`Name = "Label"`).
- Label `TextTransparency = 0` unless disabled/loading → button text is always fully opaque.

### big-ui 1.1.3 — `Text`

```ts
interface TextProps {
  text: Fusion.UsedAs<string>;                     // reactive: a Computed works
  variant?: TypographyVariant;
  color?: "primary" | "secondary" | "disabled" | "primaryMain" | "errorMain"
        | "warningMain" | "successMain" | "infoMain";
  align?: Enum.TextXAlignment;
  size?: UDim2;
  wrap?: boolean;
  layoutOrder?: number;
}
function Text(scope, props): TextLabel
```

Constructed as (verbatim from `Text.luau`):

```lua
Size = props.size or UDim2.new(1, 0, 0, spec.lineHeight)
AutomaticSize = if props.size == nil then Enum.AutomaticSize.Y else Enum.AutomaticSize.None
TextColor3 = color3                 -- Palette.text.primary for the default colour
TextTransparency = transparency     -- 0.13 for the default colour
Font = spec.font
TextSize = spec.size
TextXAlignment = props.align or Enum.TextXAlignment.Left
TextYAlignment = Enum.TextYAlignment.Top
TextWrapped = props.wrap or true    -- (nil → true)
```

Critical consequences:

- **`TextWrapped` defaults to `true`.** A wrapped label is measured against its own current width, so
  inside a frame that sizes itself to its children (`AutomaticSize.X`) this is a cycle — Roblox
  breaks it by **collapsing the label to zero width**, i.e. it renders as nothing. This was a real
  bug here and has been fixed by passing `wrap: false` on every label. If you see a label vanish,
  check this first.
- **Default `Size` has `X.Scale = 1`** and `TextYAlignment = Top`. Both have to be overwritten for
  anything that should hug its text or sit vertically centred.
- **`TextColor3` is a plain value, not reactive** — so `label.TextColor3 = x` after construction
  *does* stick. (This was hypothesised as the bug and disproved.)
- Root `Name = "Text_{variant}"`, so every `h4` label in the UI is named `Text_h4`. Names collide
  everywhere; don't use child names to identify elements.

### big-ui 1.1.3 — `Card`

```ts
interface CardProps {
  children: Array<Instance | undefined>;   // REQUIRED
  size?: UDim2; padding?: number; elevation?: 0|1|2|3;
  background?: Color3; layoutOrder?: number; childGap?: number;
}
function Card(scope, props): Frame
```

- **No `AnchorPoint` / `Position` / `AutomaticSize` / `Visible` props** — set them on the returned Frame.
- Builds its own `UICorner` (`Shape.radiusLarge`), `UIPadding`, a **vertical** `UIListLayout`, and a
  `UIStroke` at the default `elevation: 1`.
- Default `Size = (1,0,0,0)` + `AutomaticSize = Y`; passing `size` turns `AutomaticSize` off.
- Hardcodes `Name = "Card"`. Children are parented via Fusion `Children` — do not also set `.Parent`.
- **It has no `Activated`** — it cannot be a click target.

### big-ui 1.1.3 — other

- `Alert(scope, {severity, message, title?, onClose?, layoutOrder?}) → Frame`. `severity` and
  `message` are **required**; `title`/`message` are plain strings read **once at construction**, not
  `UsedAs` — an Alert cannot be reactive in its content. Root is `Size = (1,0,0,0)`, so it needs a
  fixed-width parent.
- Theme exports: `Palette`, `Transparency`, `Shape`, `Spacing(n)`, `Typography`, `ZIndex`,
  `paletteFor(color)`.
- `TypographyVariant = "h4"|"h5"|"h6"|"subtitle1"|"subtitle2"|"body1"|"body2"|"button"|"caption"|"overline"`.
- **The active theme is LIGHT.** `Palette.background` is only `{default, paper}` — both light. There
  is **no dark surface anywhere in the palette**, which is why every colour in this shop is
  hardcoded in `SHOP_CONFIG.COLORS` instead of read from the theme.
- `ZIndex = {hud, drawer, modalBackdrop, modal, tooltip}` is used as **`DisplayOrder`** (a different
  property) and only by `Modal`, `Drawer`, `Dropdown`, `PopoverMenu`. **No big-ui component sets
  `ZIndex`**, so a parent's `ZIndex` is not fought by any child.

### Fusion 3.0

- `Fusion.scoped()`, `Fusion.Value(scope, init)` + `:set(v)`, `Fusion.peek(state)`,
  `Fusion.Computed(scope, (use) => …)`, `Fusion.New(scope, "ClassName")({ props })`,
  `Fusion.Hydrate(scope, instance)({ props })`, `Fusion.doCleanup(scope)`.
- **A graph object must be in the props table given to `New` to be tracked.** Assigning one after
  construction is a **compile error**, not a silent no-op:
  `Type 'Computed<boolean>' is not assignable to type 'boolean'`.
  For an instance you did not create with `New` (e.g. a big-ui `Text` label that needs a reactive
  `Visible`), use `Fusion.Hydrate(scope, instance)({ Visible: computed })`.
- `Fusion.doCleanup(scope)` **destroys every `Instance` placed in that scope** (`New` does
  `table.insert(scope, instance)`; `doCleanup` destroys `Instance` tasks). A scope may be cleaned
  only once.

### roblox-ts / Roblox facts

- **`UIGridLayout` has no column count.** It fits as many `CellSize` cells as the container is wide
  enough to hold. To get exactly 5 columns the container's **width** is pinned to
  `columns * cellX + (columns-1) * padX` = `5*120 + 4*8 = 632`, with `AutomaticSize.Y` so rows grow.
  (Otherwise a 1920px viewport shows 8 across where 1280px shows 5.)
- **`ZIndex` is NOT a parent/child rule — this cost a whole debugging round.** Roblox sorts
  `GuiObject`s by `ZIndex`, and a child is only drawn above its parent when the child's `ZIndex` is
  **at least** the parent's. Giving a container a *higher* `ZIndex` than its children therefore
  paints its own opaque background **over** them. Setting `ZIndex = 10` on a panel to lift it above
  other HUDs hides everything inside it. Either raise every descendant to the same value (walk
  `GetDescendants()` and set each `GuiObject`), or do not raise the container at all.
  - This is why the first symptom was so confusing: the only contents visible were the ones
    overflowing *past* the container's edge, where its background was not above them.
- **`ScreenGui.ScreenInsets`**: `None` = true screen top-left · `CoreUISafeInsets` = below the topbar ·
  `TopbarSafeInsets` = topbar inset only · `DeviceSafeInsets` = notches/cutouts. This project's
  `getHudScreenGui()` sets **`None`**, so `y = 0` is the *true* screen top and the topbar overlaps
  anything within roughly its height (`GuiService.TopbarInset`) of it.
- `UIPadding` insets the parent's content area; a child's `Position` **scale** is relative to the
  *padded* region, not the full parent.
- `string.len` **does not exist** in the typings (use `string.sub` / `string.format` / `.size()`).
- `next` is a **reserved identifier** — `const next = …` fails to compile
  ("Cannot use identifier reserved for compiler internal usage").
- `Set.size()` / `Map.size()` are **methods**. Unary `+` is unsupported. `end` is reserved.
  `new Instance("X", { Parent })` does not compile.

---

## 7. The arithmetic that makes this fragile

Panel = `0.8 × viewport`; inner = panel − 28 (14px padding each side).

Fixed vertical chrome inside the panel:

```
HEADER_HEIGHT       46
SECTION_GAP         10
TAB_HEIGHT          66
SECTION_GAP         10
                 -----
CONTENT_TOP        132
FOOTER_HEIGHT       44
SECTION_GAP         10
                 -----
CONTENT_HEIGHT_OFFSET = -(46 + 66 + 44 + 30) = -186
```

So `Content` is `Size = (1, 0, 1, -186)` at `Position = (0,0,0,132)`.

What the content must hold:
- left column: `200` (box image) + `6` + `28` (name bar) + `6` + 5 rows × (~16 line + 6 gap) ≈ **350**
- right column: `28` (heading) + `36` + grid `2*140 + 8 = 288` → ends at **324**

| viewport height | panel | inner | content height | fits? |
|---|---|---|---|---|
| 1080 | 864 | 836 | 650 | yes |
| 720 | 576 | 548 | **362** | yes (350 / 324) |
| 700 | 560 | 532 | 346 | **left column overflows** |
| 600 | 480 | 452 | 266 | **no** (grid needs 288) |
| 500 | 400 | 372 | 186 | **no** |

**Below roughly 700px of viewport height the content band is too short for its own contents**, and
because nothing clips, children spill past the panel's bottom edge and over the footer. If the
broken screenshot is genuinely a short viewport, this alone explains the mess — and would also
explain why the coloured name bars appear at the very bottom of the frame.

---

## 8. Ruled out — with evidence. Please don't re-tread these.

1. **`TextColor3` override being reverted.** `Text.luau` sets `TextColor3 = color3` as a plain value
   inside the props table; it is not reactive. Post-construction assignment sticks.
2. **Text transparency making labels invisible.** `Transparency.textPrimary = 0.13` → 87% opaque.
3. **Panel root props wrong.** The emitted Luau was inspected:
   `Size = SHOP_CONFIG.PANEL_SIZE`, `AnchorPoint = Vector2.new(0.5, 0.5)`,
   `Position = UDim2.new(0.5, 0, 0.5, 0)`, `Visible = isOpen`, `ZIndex = PANEL_Z_INDEX` — all correct.
4. **The build.** `npm run build` (`rbxtsc`) exits 0. The controller is registered in
   `flamework.build` at `out/client/controllers/hud/ShopController@ShopController`, and the emitted
   `.luau` contains the panel, the `UIGridLayout`, the `Hydrate` call and every label.
5. **`ZIndex = 10` on the panel hiding its children.** Contradicted by observation: the `X` button
   and `OPEN BOX` are both children of the panel and both render.
6. **A `Text` label collapsing because `wrap` defaulted to `true`.** A real bug, **now fixed** — every
   label passes `wrap: false`. This is the best current explanation for the missing `Shop` title
   specifically (it is the one label whose size is `(0,0,0,0)` + `AutomaticSize.XY` inside an
   `AutomaticSize.X` parent — exactly the cycle shape).

---

## 9. Ranked hypotheses still open

**H1 — the content band is too short for the viewport (see §7).**
*Predicts:* `ShopPanel.Content.AbsoluteSize.Y` is small/zero; cards and the box picture spill below
the panel and overlap the footer; the coloured name bars sit at the bottom edge. Consistent with the
observation.

**H2 — the dark-on-dark theory: everything *is* drawing, and it simply cannot be seen.**
*Predicts:* `PLACEHOLDER (62,62,78)` and `SURFACE (44,44,54)` rectangles are present but nearly
indistinguishable from `PANEL (26,26,32)` in a compressed screenshot; the text is white on dark and
*should* be obvious, so this alone does not explain missing text. **Cheap test: temporarily set
`COLORS.PLACEHOLDER` and `COLORS.SURFACE` to magenta/green and re-capture.** One frame settles it.

**H3 — `mount()` threw partway and later sections never ran.**
*Argues against:* `panel.Parent = getHudScreenGui()` is the *last* statement of `addPanel`, so a panel
on screen implies every section ran. Unless the on-screen panel is stale.
*Predicts:* some of `Header` / `TabRow` / `Content` / `Footer` missing from the Explorer tree, and an
error in the client console.

**H4 — the panel is not actually 80% wide.** The screenshot suggests ~98% with ~12px margins.
*Predicts:* `ShopPanel.AbsoluteSize.X` ≈ `viewport width × 0.98`, i.e. `PANEL_SIZE` is not reaching
the property. Would be a Fusion/`as const` config issue worth chasing.

---

## 10. What to get from the place (in Play mode)

Explorer: `Players → <you> → PlayerGui → HudGui → ShopPanel`

1. Which children exist: `Header`, `TabRow`, `Content`, `Footer`? Any missing ⇒ H3, get the console error.
2. `ShopPanel.AbsoluteSize` and `ShopPanel.AbsolutePosition` — and the viewport resolution to compare against (tests H4).
3. `ShopPanel.Content.AbsoluteSize.Y` and `ShopPanel.Content.Effects.AbsoluteSize` (tests H1).
4. `ShopPanel.Content.Effects.BoxColumn.BoxImage.AbsoluteSize` — is the 200×200 placeholder there?
5. Pick one label, e.g. `…Content.Effects.ItemColumn.ItemGrid.ClownCell.NameBar.Text_caption`, and
   report `Visible`, `Text`, `TextColor3`, `TextTransparency`, `TextWrapped`, `AbsolutePosition`,
   `AbsoluteSize`.
6. The client console — the controller prints `[Shop] button and panel up — no purchase logic, no
   remotes` on mount, `[Shop] opened` / `[Shop] closed`, and `[Shop] tab: <name>`. If the mount line
   is absent, `mount()` never completed.

A screenshot of the Explorer tree answers 1–3 at once.

---

## 11. Constraints on any fix

- Only the **Effects** tab has content; the other four must show `"<TabName> — coming soon"`.
- **No purchase logic, no remotes, no server calls.** Every click either moves `isOpen`/`currentTab`
  or prints.
- **No assets** — every image slot is intentionally an empty `ImageLabel`. (The target screenshot has
  real knife/gun art; that is a later change requiring asset ids.)
- Reuse `getHudScreenGui()`; no second `ScreenGui`.
- Data-driven from `SHOP_CONFIG`: adding an item is one entry, adding a rarity is one entry, and an
  11th item must render a third row with no layout change.
- Movement must not be blocked while the panel is open.
- The panel must survive respawn (it is on the shared GUI, which sets `ResetOnSpawn = false`).
- Client-only.
- Target design: Murder Mystery 2's shop — one large centred panel at ~80% of the viewport, dark
  background, white text, saturated category colours. Two screenshots exist (current vs target).
