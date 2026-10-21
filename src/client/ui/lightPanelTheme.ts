import type { HudTheme } from "./hudTheme";
import { hudTheme } from "./hudTheme";

/**
 * **The pop-ups' own palette: a printable white sheet with black ink, hardcoded and shared by nothing.**
 *
 * **Why this file exists rather than `hudTheme()` or `premiumHudTheme()`.** The game now has two directions in it —
 * the in-game HUD is neon on deep space, and the Shop and Inventory are read like a page of print — and the two
 * pop-ups are the only consumers of the third thing both of those got wrong: they should be *unambiguously* light.
 * `hudTheme()` maps big-ui's palette, which is light, but it is a *mapping*: every one of its values can be moved by
 * `ThemeController`'s `configureTheme` call, and a pop-up whose readability depends on ten table entries elsewhere is
 * a pop-up that can go dark without anybody touching it. `premiumHudTheme()` is the opposite extreme and by design
 * dark. **This is the literal one**: seven surfaces and four inks written here, in the file that draws nothing, so a
 * reviewer can answer "what colour is the shop" by reading nine lines.
 *
 * **The typography and the spacing are still `hudTheme()`'s**, and deliberately: they are big-ui's type scale and this
 * file has no opinion about them. Only the `colors` record is replaced — the same shape `premiumHudTheme` uses, which
 * is what lets `panelChrome` take either without knowing which it was handed.
 *
 * ## The values, and the job each one does
 *
 * | role | value | job |
 * | --- | --- | --- |
 * | `surface` | `#F5F5F7` | behind a full-screen cover |
 * | `panel` | `#FFFFFF` | the pop-up's sheet |
 * | `card` | `#E8EBF0` | a tile's face, a card's body |
 * | `trough` | `#1E2026` | the band on one — a tile's name bar, a pill, a well |
 * | `textPrimary` | `#141414` | headings, names, prices |
 * | `textSecondary` | `#4A4A4A` | status lines, footnotes |
 * | `onAccent` | `#FFFFFF` | ink on a filled surface: the name bar, the close button, a selected tab |
 * | `accent` | `#2563EB` | the marker — a selected tab, an equipped tile's bar |
 * | `border` | `#CDD2DA` | a hairline between two light surfaces |
 *
 * **`trough` is the one dark value in a light theme, and it is not a mistake.** In this project `trough` is the *band*
 * on a tile and the *well* inside a panel — the two places that carry white ink (`onAccent`) in the light design. A
 * light `trough` would put white labels on a pale bar, which is the pair this whole file exists to avoid.
 */
export function lightPanelTheme(): HudTheme {
	// Read for the type scale and the spacing, which are big-ui's and are not overridden here.
	const base = hudTheme();

	return {
		colors: {
			textPrimary: Color3.fromRGB(20, 20, 20),
			textSecondary: Color3.fromRGB(74, 74, 74),
			textDisabled: Color3.fromRGB(150, 154, 162),
			accent: Color3.fromRGB(37, 99, 235),
			success: Color3.fromRGB(22, 130, 93),
			warning: Color3.fromRGB(176, 122, 20),
			error: Color3.fromRGB(196, 45, 55),
			errorDark: Color3.fromRGB(150, 30, 40),
			trough: Color3.fromRGB(30, 32, 38),
			surface: Color3.fromRGB(245, 245, 247),
			panel: Color3.fromRGB(255, 255, 255),
			card: Color3.fromRGB(232, 235, 240),
			border: Color3.fromRGB(205, 210, 218),
			coin: Color3.fromRGB(176, 122, 20),
			onAccent: Color3.fromRGB(255, 255, 255),
			shadow: Color3.fromRGB(0, 0, 0),
		},
		spacing: base.spacing,
		typography: base.typography,
	};
}
