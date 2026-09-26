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
			textSecondary: Palette.text.secondary,
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
