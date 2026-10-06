import { Palette, Spacing, Typography } from "@rbxts/big-ui";
import type { TypographySpec } from "@rbxts/big-ui";

/**
 * The colours the hand-built HUD draws with, by the job each one does rather than by where it
 * comes from.
 *
 * These are the *only* names the HUD knows. Nothing under `controllers/` imports big-ui's theme
 * tables, so if that palette is ever reshaped, renamed or replaced, this file is the single seam
 * that has to change and the three HUDs are untouched. That is the whole reason this module
 * exists rather than each HUD reading `Palette` where it needs a value.
 */
export interface HudTheme {
	colors: {
		/** Ordinary text on a light surface. */
		textPrimary: Color3;
		/** Supporting text that should sit back from the primary. */
		textSecondary: Color3;
		/** Text for something unavailable — including a control that has been switched off. */
		textDisabled: Color3;
		/** The colour that draws attention: keys, highlights, the thing to look at. */
		accent: Color3;
		/** Ready, available, good. */
		success: Color3;
		/** Busy, counting down, not yet. */
		warning: Color3;
		/** Failure and elimination. */
		error: Color3;
		/** The empty well a progress fill sits in. See {@link hudTheme} for why this reads oddly. */
		trough: Color3;
		/**
		 * The screen itself: what the game is drawn on, and what a full-screen overlay covers it with.
		 *
		 * **The one entry here that is a surface rather than a foreground.** Everything above it is
		 * something drawn *on* the page — text, an accent, a state — and until the loading screen
		 * there was nothing in the client that covered the page. The alternative was for that one
		 * controller to reach into big-ui's `Palette` for a background, which is exactly the import
		 * this module exists to prevent, so the colour is named here instead.
		 *
		 * `surface` rather than `background`, because `trough` is the other use of that word in this
		 * interface and it means a well *inside* something.
		 */
		surface: Color3;
		/**
		 * A raised page: the background a panel of content sits *on top of* the screen.
		 *
		 * **Distinct from {@link surface} on purpose, and the pair is the whole trick.** The theme is
		 * light, so a panel that used `surface` would be a panel the same colour as what is behind it
		 * — a border and nothing else. The palette has two surfaces for exactly this reason: one is
		 * the page and one is the paper laid on it, so naming both lets a panel and its cards read as
		 * a stack of two materials rather than as one flat field.
		 */
		panel: Color3;
		/**
		 * A card inside a panel: the first surface *inside* {@link panel}, for one item or one fact.
		 *
		 * The inverse of the pair rather than a third colour — a card is the page colour showing
		 * through a hole in the paper, which is what makes an inset well read as inset. Chosen this
		 * way round deliberately: the panel is the thing that covers the game, so it is the one that
		 * has to be opaque and paper-like, and a card can afford to be the subtler of the two.
		 */
		card: Color3;
		/**
		 * A hairline: the edge of a panel, a card, or a divider between two of them.
		 *
		 * Named for the job rather than for a shade, because what a border *is* depends on what it
		 * separates — the same value is used for a panel's outline against the game and for a card's
		 * outline against a panel, and both want "a line, one pixel, that is not a colour of its own".
		 */
		border: Color3;
		/**
		 * The colour of money, and the one colour in the economy that means *a number you have*.
		 *
		 * Deliberately not {@link warning} even though it maps to the same palette value today: a
		 * warning is a state something is *in*, and a coin is a thing something *is*. Reading the
		 * balance of an account through the name "warning" is the kind of semantic drift that ends
		 * with a caution colour on a success message, so the job gets its own name and the mapping
		 * stays in one place if the palette ever grows a better amber.
		 */
		coin: Color3;
		/**
		 * Text drawn *on* an accent surface — a filled button, a coloured name bar.
		 *
		 * **A separate name from {@link textPrimary} rather than the same value, because the two are a
		 * pair that has to stay legible.** The shop's tiles draw a saturated bar under each item and
		 * put the name on it; the moment that bar's colour changes, the text on it stops being
		 * ordinary text and becomes a contrast problem. Naming the job is what lets this be revisited
		 * when the accent colour is.
		 */
		onAccent: Color3;
	};

	/** The theme's spacing scale, in pixels. `Spacing(n)` is `n` eighths. */
	spacing: {
		xs: number;
		sm: number;
		md: number;
		lg: number;
	};

	/** Type specs, for anything measuring text rather than letting big-ui do it. */
	typography: {
		caption: TypographySpec;
		body: TypographySpec;
	};
}

/**
 * The HUD's view of the active theme.
 *
 * **A function rather than a constant, and that is not a style choice.** big-ui's `Palette` is a
 * table that `configureTheme` mutates in place when `ThemeController` runs. A module-level `const`
 * here would read that table the first time *this* module was required — which can be before the
 * theme is configured, depending on load order — and would then hold Material's defaults for the
 * rest of the session. Calling it inside `mount()` makes the order explicit and impossible to get
 * wrong: by the time a HUD mounts, `configureTheme` has run.
 *
 * Reads are stable for the session, so a HUD may treat the result as fixed. Nothing is cached
 * between mounts, deliberately: the call is a handful of table lookups, and re-reading means a
 * theme reconfigured later would be picked up rather than resisted.
 *
 * Every value is a *reference into* the live palette, chosen by the job it does. Where a job has
 * no value of its own — a trough is a dark well and the theme has no dark background, only the
 * two light surfaces `background.default` and `background.paper` — the nearest thing the palette
 * does have is used and named for the job, so the HUD keeps asking for a trough and the mapping
 * stays in one place if the palette ever grows a better answer.
 */
export function hudTheme(): HudTheme {
	return {
		colors: {
			textPrimary: Palette.text.primary,
			textSecondary: Palette.error.dark,
			textDisabled: Palette.text.disabled,
			accent: Palette.primary.main,
			success: Palette.success.main,
			warning: Palette.warning.main,
			error: Palette.error.main,
			// The one value picked by hand. The theme's backgrounds are both light — they are a
			// daytime, light-palette theme — so neither will do for the well behind a progress
			// bar, where the fill has to be the brighter of the two to read at all. The theme's
			// near-black text colour is the darkest surface it has, so that is what a trough is
			// made of until the palette grows a dark background of its own.
			trough: Palette.text.primary,
			// Not picked by hand, for once: the palette's own "behind everything" surface, which is
			// what a full-screen overlay wants and is light because the theme is.
			surface: Palette.background.default,
			// The other half of the pair, from the palette's own two surfaces for the same reason:
			// `paper` is the raised one, so it is what a panel is made of, and a card takes the page
			// colour back — see the two entries in {@link HudTheme} for why that is a stack rather
			// than a shade.
			panel: Palette.background.paper,
			card: Palette.background.default,
			// A disabled-text colour is the palette's lightest neutral, which is what a hairline is:
			// present enough to separate two surfaces, gone enough not to draw the eye. There is no
			// `divider` in the palette, and this is the nearest thing that is *not* a real colour —
			// a border that used `text.secondary` would read as a line somebody meant you to see.
			border: Palette.text.disabled,
			// Amber, which is what every currency in every game is, and `warning.main` is the
			// palette's amber. Mapped here rather than at the call site so that the day the palette
			// grows a gold, the shop does not have to be found.
			coin: Palette.warning.main,
			// The palette's own white, which is what a name bar wants on top of it. Not `surface`:
			// that is the near-white *page* colour, and a page colour used as a foreground is how a
			// label ends up reading as a slightly dirty grey rather than as white.
			onAccent: Palette.common.white,
		},

		spacing: {
			xs: Spacing(0.5),
			sm: Spacing(1),
			md: Spacing(2),
			lg: Spacing(3),
		},

		typography: {
			caption: Typography.caption,
			body: Typography.body1,
		},
	};
}
