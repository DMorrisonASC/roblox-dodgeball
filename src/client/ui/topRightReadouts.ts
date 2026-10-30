import type { TypographyVariant } from "@rbxts/big-ui";
import { isMobile } from "../platform";

/**
 * **The top-right corner's two readouts, and the facts they have to agree about.**
 *
 * `CurrencyHudController`'s coin plate and `HitLogController`'s hit feed are a column: one directly above the
 * other, both pinned to the right edge. Every number that makes that true is here rather than in either
 * controller, for `getHudColumn`'s reason read from a corner — **two offsets in two files are two literals that
 * agree only because a comment says they do**, and this is the second time this project has had a HUD stack
 * described by prose instead of by arithmetic. `screenGui.ts` documents what that costs at the top of the
 * screen: the score plate and the clock sat at `14` and `14` for a whole release, drawing one across the other,
 * each file's comment naming the other as the thing to keep in step.
 *
 * **What is shared here is only what two readers need.** The feed's own geometry — its card width, its gaps,
 * how many rows — stays in the feed, because the coin has no opinion about any of it. What is here is the right
 * edge they align on, the coin plate's box (which the feed's top is derived from), and the rule that makes a
 * phone's copy of both smaller.
 *
 * **The phone difference is a *type size*, not a scale factor, and that is a correction rather than a
 * preference.** This module shipped a `scaledPixels` that multiplied every length — widths, heights, paddings,
 * gaps and glyph sizes — by `0.8`. That is the technique `ui/viewportConstraint.ts` uses for a *cap*, and it is
 * the wrong one for a *layout*: every number had to be floored to survive `AutomaticSize`, so a card whose height
 * and whose text were rounded independently is a card that clips its own descenders on one device and not the
 * other. Multiplying a coordinate system is a thing to do once, at a container — and a `UIScale` at the container
 * is what `HitLogController`'s class doc already refuses on the record: *"a `UIScale` over automatic sizing is
 * the arrangement where the layout is computed in unscaled units and then drawn scaled, which is how a card ends
 * up drawn on top of its neighbour"*. **So the boxes are fixed and only the words change size**, which is one
 * decision per element rather than a factor threaded through eleven call sites.
 *
 * **The trade, stated rather than discovered: the type ladder is coarse and it cannot deliver "20%".** big-ui's
 * `Typography` is `h4 34 / h5 24 / h6 20 / subtitle1 16 / subtitle2 14 / body1 16 / body2 14 / button 14 /
 * caption 12 / overline 11`, read out of the installed `theme.luau`, so the step below `caption` is `overline` at
 * 11 — **8%, not 20%**, and `overline` is the smallest variant there is. `readoutVariant` is where that is made
 * visible: each caller names both ends of the step it wants, so the pair sits at the call site rather than inside
 * an arithmetic that looks more precise than the vocabulary under it. A genuinely 20%-smaller phone readout needs
 * a size the ladder does not have; the honest ways to get one are a `configureTheme` override of a variant
 * (project-wide, one place) or a per-element `TextSize` write (what this file used to do). Neither is built, and
 * this paragraph is where to start if one is wanted.
 */

/**
 * How far in from the right edge both readouts sit, in pixels.
 *
 * **One number because the two share an edge**, and it used to be two literals with a comment claiming they
 * matched. The feed's copy said *"matched to the coin readout's own inset, deliberately"* — which is a promise a
 * reader cannot check. The right edge is the one thing a column has to agree about, so it is stated once.
 *
 * **Deliberately not device-dependent.** This is the margin from the screen edge — the distance from a bezel and
 * a thumb — so a phone wants at least as much of it, not a smaller share. It is also the one number here that a
 * phone could plausibly want *larger*, because `getFullScreenGui` measures from the true screen edge and a
 * landscape cutout can reach in; 12 is what a desktop has always used and is the value to move if a real device
 * is ever seen to be under it.
 */
export const RIGHT_INSET = 12;

/** Where the coin plate's top edge sits, in pixels from the top of the screen. */
export const COIN_TOP = 64;

/**
 * The coin plate's box, in pixels — **and the height is the number the feed's top is derived from.**
 *
 * **This is the coupling worth the module.** The feed's own top inset used to be the literal `96` whose comment
 * said it was *"the coin readout's bottom edge plus a gap"* — true while the plate was always 22 high, and quietly
 * false the moment any device could draw it at another size. An offset that describes another element's height
 * has to be computed from it.
 */
export const COIN_WIDTH = 160;
export const COIN_HEIGHT = 22;

/** The gap between the coin plate and the hit feed under it, in pixels. */
const READOUT_GAP = 10;

/**
 * Where the hit feed starts, in pixels — **the coin's bottom edge plus {@link READOUT_GAP}, computed rather than
 * remembered.**
 *
 * A constant because the boxes no longer vary by device (only the words do), so the arithmetic gives one answer.
 * It is still arithmetic over the numbers above rather than a literal `96`, which is the whole point — a taller
 * plate moves the feed with it.
 */
export const BELOW_COIN = COIN_TOP + COIN_HEIGHT + READOUT_GAP;

/**
 * **Which typography variant to draw at: `desktop` everywhere but a touch device, `mobile` on one.**
 *
 * **Both ends are named at the call site, and that is the design.** The alternative — a function mapping one
 * variant to "the next one down" — reads as a general rule while being a two-entry table, and it hides the
 * consequence: the caller cannot see that the step it gets is 12→11 rather than the 20% a brief might have
 * asked for. Naming the pair makes each element's phone size one line a reader can check against the ladder
 * in this file's header.
 *
 * **`isMobile()` is read per call rather than latched**, which is that function's own rule: its two flags never
 * change during a session, but a module-level `const` would be a value captured whenever this file happened to be
 * required — and the last time this project cached a platform read it was the palette, arrived at from the other
 * side. Every call here happens at mount, so nothing is on a per-frame path.
 */
export function readoutVariant(desktop: TypographyVariant, mobile: TypographyVariant): TypographyVariant {
	return isMobile() ? mobile : desktop;
}
