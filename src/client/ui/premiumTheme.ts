import type { HudTheme } from "./hudTheme";
import { hudTheme } from "./hudTheme";

/**
 * **The "Neon Cyberpunk" palette — five colours, and the whole of the game's paint.**
 *
 * **Where it came from, and what it replaced.** This module began as a *"Premium Sports"* palette — deep plum, gold
 * hairlines, flat and matte — and the user's verdict on it was that the dark mode felt plain. The direction is now
 * **neon**: near-black glass, one cyan light source, and a real bloom around every edge and every glyph. **The same
 * module and the same job names**, so every HUD moved by changing values rather than by changing its code — which is
 * the whole reason the palette was written as *jobs* in the first place.
 *
 * **The technique is the second rule of this file's sibling, `ui/glow.ts`**: a border here is a one-pixel core plus
 * a bloom, drawn as a native `UIShadow` where the client has one and as a fat transparent `UIStroke` where it does
 * not. **A single stroke cannot bloom** — a stroke has one width and one transparency, so thickening it to glow
 * gives a hard band, and softening it to bloom gives no edge — which is why the layered pair exists at all.
 *
 * | role | hex | what it is |
 * | --- | --- | --- |
 * | {@link PremiumTheme.panel} | `#0A0C12` | deep space — every surface, at `0.15` transparency ("glass") |
 * | {@link PremiumTheme.stroke} | `#00FFFF` | neon cyan — the one-pixel core of every edge |
 * | {@link PremiumTheme.gold} | `#00FFFF` | the same cyan, as *text* — headers and the clock |
 * | {@link PremiumTheme.glow} | `#00FFFF` | the same cyan again, as the *light* — the bloom's colour |
 * | {@link PremiumTheme.text} | `#FFFFFF` | pure white, fully opaque |
 * | {@link PremiumTheme.sideA} | `#FF3C5A` | the red side, brightened for a dark ground |
 * | {@link PremiumTheme.sideB} | `#3C8CFF` | the blue side, same |
 *
 * **A second theme module rather than more entries in `hudTheme`.** `hudTheme` maps big-ui's light palette by *job*,
 * and every panel in the game reads it — the shop's tiles, the inventory's grid, `panelChrome`'s sheets and its tab
 * strip. **This pass themes those too**, but through the bridge below rather than by widening `hudTheme`: the bridge
 * is one function whose colour record is written here, so the whole game follows this file and the light palette is
 * left as the untouched source of typography and spacing. See `premiumHudTheme`.
 *
 * **A constant rather than a function, unlike `hudTheme`.** That one is a function because big-ui's `Palette` is a
 * table `configureTheme` mutates, so it has to be read *after* configuration; there is no such table here — these are
 * literals chosen for this game, the same on every call — so a `const` is the honest shape and costs nothing.
 *
 * **What is deliberately not here.** No `success`/`warning`/`error` trio: the five elements this theme was built for
 * show a phase, a clock, two scores, a name and six buttons, and none of them has a state to colour. A state colour
 * added before something needs one is a colour that gets used for the wrong job. The mobile cluster's *held* state
 * is drawn from this palette too (gold under plum ink — the same inversion the "L" key box uses), so even that has
 * no need of a sixth value.
 */
export interface PremiumTheme {
	/** **The surface every panel is made of.** `#0C0F16` — one step above the void. */
	panel: Color3;

	/**
	 * **The bottom of the stack: what a full-screen overlay covers the game with.** `#080A0F`.
	 *
	 * Half a shade darker than {@link panel}, and that is all it needs to be: a loading screen or a transition cover
	 * is the one surface with nothing behind it, so it has to read as *further away* than the panels rather than as
	 * another panel.
	 */
	void: Color3;

	/**
	 * **One step up from a panel: the thing laid on it.** `#141922`.
	 *
	 * A shop tile's face, a card's body — the `card` job. It is a *lighter* dark than the sheet, which is the
	 * inversion a dark theme needs: on paper a card is the lighter of the two, and here the sheet is darker and a card
	 * is lit off it. **Without this step a card and its sheet are one colour and a panel loses its structure** — see
	 * `premiumHudTheme`'s doc for the pass that learned that the expensive way.
	 */
	raised: Color3;

	/**
	 * **One step up again: a band on a card.** `#1E2530`.
	 *
	 * A tile's name bar, a pill, a well — the `trough` job. Three visible steps is what makes a shelf of tiles read as
	 * objects rather than as artwork floating on black.
	 */
	band: Color3;

	/**
	 * **The one-pixel core line of the neon edge.** `#00FFFF` — the palette's cyan.
	 *
	 * **This is the *inner* half of the glow, not the whole of it.** A border in this direction is two things on one
	 * frame: this hairline, and the bloom around it, which `ui/glow.ts` adds as a `UIShadow` (or a fat transparent
	 * stroke on a client without one). See that file for the technique and for why the bloom is not a second entry
	 * here.
	 */
	stroke: Color3;

	/**
	 * **The high-priority text colour: the same `#00FFFF`, as ink rather than as an edge** — the "ENEMY VIEW"
	 * header, the round's clock, the letter on the key chip.
	 *
	 * A second name for one value on purpose, which is `hudTheme`'s own convention: a border and a headline are two
	 * jobs, and the day one of them wants to move, the call sites should not have to be found first.
	 */
	gold: Color3;

	/**
	 * **The colour every bloom is made of**, defaulted by `ui/glow.ts` so a caller that just wants "the theme's
	 * glow" does not have to name a colour. Equal to {@link stroke} and {@link gold} — this palette has one accent,
	 * which is what makes the whole HUD read as one light source.
	 */
	glow: Color3;

	/**
	 * **Pure white `#FFFFFF`** — every name, number and sentence in the game HUD.
	 *
	 * Fully opaque, which is the second rule of this direction and a deliberate reversal of the previous pass's
	 * faded white: on near-black glass a bloomed white at full ink is what reads as a light source, and a `0.15`
	 * fade over a *transparent* panel is a label that disappears into the arena.
	 */
	text: Color3;

	/** **Crimson `#C02942` — the red side**, the value this theme puts on side A's score. */
	sideA: Color3;

	/** **Teal `#53777A` — the blue side**, the value this theme puts on side B's score. */
	sideB: Color3;

	/**
	 * **Near-black ink, for anything drawn on a cyan face** — the key chip, the primary dock button, a filled accent
	 * bar in the shop. The same value as {@link panel}, and named for the *job* for the reason {@link gold} is.
	 */
	onGold: Color3;

	/**
	 * **How much of the arena shows through a surface: `0.15` — "dark glass" rather than a solid void.**
	 *
	 * The direction asks for glass, and glass is the one thing a nearly-black fill can be: at `0.85` of the palette's
	 * near-black the game is a colour *behind* the panel rather than a picture in it, which is what makes the cyan
	 * edge read as something lit from within. **The trade, stated rather than hidden**: text over glass is text over
	 * whatever the arena happens to be, so this is safe only because the text is pure white at full opacity and every
	 * panel carries a bloom — see `ui/glow.ts`.
	 */
	transparency: number;

	/** **A panel's border weight, in pixels: `1`.** Crisp rather than heavy; see {@link stroke}. */
	strokeThickness: number;

	/**
	 * **A panel's corner radius, in pixels: `4`.** Sharp enough to read as sporty, rounded enough that a numeral or a
	 * cap does not sit against a cut corner.
	 */
	corner: number;

	/**
	 * **How much of the text's own ink a label gives back: `0`, i.e. none.**
	 *
	 * **The previous pass had `0.15` here and this one puts it back to zero**, which is the same reversal as
	 * {@link transparency} seen from the other end: a faded white was the right "premium" answer on a *solid* dark
	 * plate, and on glass it is a label losing the fight with the arena. Neon text is opaque by definition — the
	 * softness in this direction comes from the bloom around the glyphs (`ui/glow.ts`'s text helper), not from the
	 * ink itself.
	 */
	textTransparency: number;
}

/**
 * The palette, as above.
 *
 * **One object rather than a dozen module-level constants**, so that a reader sees the five colours side by side with
 * the three numbers that say how they are applied, and so that every consumer's diff says `PREMIUM.panel` rather than
 * `PLUM` — a name that would not say which palette it belonged to once a second theme exists.
 */
export const PREMIUM: PremiumTheme = {
	// **Deep space.** Four steps of near-black, and every one of them is used: `void` behind a full-screen cover,
	// `panel` for a sheet, `raised` for a card or a tile face, `band` for a name bar or a well. They are close enough
	// to read as one material and far enough apart to draw the structure the light theme got from paper-on-paper.
	panel: Color3.fromRGB(12, 15, 22),
	void: Color3.fromRGB(8, 10, 15),
	raised: Color3.fromRGB(20, 25, 34),
	band: Color3.fromRGB(30, 37, 48),
	// **Neon cyan `#00FFFF`**, the palette's one light source: every edge, every header and every bloom.
	stroke: Color3.fromRGB(0, 255, 255),
	gold: Color3.fromRGB(0, 255, 255),
	glow: Color3.fromRGB(0, 255, 255),
	// **Pure white at full ink.**
	text: Color3.fromRGB(255, 255, 255),
	// The two sides keep their warm/cool identities and simply brightened for the dark ground: a red that holds
	// against blue-black, and a blue that does not vanish into it.
	sideA: Color3.fromRGB(255, 60, 90),
	sideB: Color3.fromRGB(60, 140, 255),
	// **Near-black ink, for anything drawn on a cyan face** — the key chip, the primary dock button.
	onGold: Color3.fromRGB(10, 12, 18),
	transparency: 0.15,
	strokeThickness: 1,
	corner: 4,
	textTransparency: 0,
};

/**
 * **`hudTheme()` with every colour job answered from this palette — the bridge the rest of the HUD reads.**
 *
 * **Why a bridge rather than a second vocabulary.** Every HUD in this project asks for colour by *job*
 * (`theme.colors.panel`, `theme.colors.textSecondary`, …) — that indirection is `hudTheme`'s whole reason for
 * existing — so the cheapest honest way to move one to this palette is to answer the same jobs from these five
 * colours. A HUD then changes by one line (`hudTheme()` → `premiumHudTheme()`) and every one of its labels, panels
 * and dividers follows, with no second naming scheme to learn and no chance of a file being half-migrated.
 *
 * **The typography and the spacing are passed straight through** from `hudTheme`, because they are big-ui's and this
 * palette has no opinion about them. Only the `colors` record is replaced.
 *
 * **Three of the mappings are choices rather than tautologies, and each is the only in-palette answer:**
 *
 * - `textDisabled` → **the blue side `#3C8CFF`**. The palette has no grey, and a disabled control has to be quieter
 *   than a live one. The blue is the palette's one *muted* member, so it reads as "present but switched off" rather
 *   than as a second accent — which is why `accent` is cyan and this is not.
 * - `onAccent` → **deep space `#0A0C12`**, because the job is "ink on a filled accent" and the accent is cyan now.
 *   Dark-on-cyan is also the only legible pair the palette has for a filled chip.
 * - `surface`, `panel`, `card` and `trough` → **four *different* darks**, and this is the correction that matters:
 *   the first version of this bridge answered all four with one near-black, which deleted every surface boundary in
 *   the game. A shop tile is a `card` face with a `trough` name bar on it; with both the same colour the bar
 *   disappeared and the panel read as artwork floating on a void. **Four steps, ascending by lightness**, is what
 *   gives a dark theme the structure the light one got for free from paper-on-paper: the sheet, the thing on the
 *   sheet, the band on the thing, and (via `accent`) the mark on the band.
 */
export function premiumHudTheme(): HudTheme {
	const base = hudTheme();

	return {
		colors: {
			textPrimary: PREMIUM.text,
			textSecondary: PREMIUM.text,
			textDisabled: PREMIUM.sideB,
			accent: PREMIUM.gold,
			success: PREMIUM.gold,
			warning: PREMIUM.gold,
			error: PREMIUM.sideA,
			errorDark: PREMIUM.sideA,
			// **The four surfaces, darkest first.** Each is used for a different *level* of the same stack, and keeping
			// them distinct is what a dark theme needs in place of the light one's paper-on-paper. See this function's
			// doc for the bug that came from collapsing them into one value.
			surface: PREMIUM.void,
			panel: PREMIUM.panel,
			card: PREMIUM.raised,
			trough: PREMIUM.band,
			border: PREMIUM.stroke,
			coin: PREMIUM.gold,
			onAccent: PREMIUM.onGold,
			shadow: PREMIUM.onGold,
		},
		spacing: base.spacing,
		typography: base.typography,
	};
}
