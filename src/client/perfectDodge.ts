import Fusion from "@rbxts/fusion-3.0";
import { Players } from "@rbxts/services";
import { events } from "shared/networking";
import { createActionSplash, SPLASH_TOP_FRACTION } from "./ui/actionSplash";
import { getHudScreenGui } from "./ui/screenGui";

/** Prints one line per caption. */
const DEBUG = false; // off for frame time — see shared/config/debug.config.ts

/**
 * # The perfect dodge — a ball that missed by a ball's width, said out loud
 *
 * **A caption and nothing else: the geometry is the server's, and it is the only machine that can measure
 * it.** Whether a dash avoided a ball is a fact about where a ball went and where a body had been standing,
 * and a client can see neither with any authority — its copy of the ball is interpolated, its copy of another
 * body is lagged, and a client that decided for itself what "close enough" meant would be deciding for itself
 * whether it had earned a caption. So `DodgeService.watchForPerfectDodge` measures the miss and this module
 * draws the answer. See that method for what is measured and why it is measured against the space the body
 * left rather than the space it moved to.
 *
 * **An event rather than an attribute, and the difference from the rest of the HUD is what the fact is.**
 * Everything a body *is* travels as an attribute (`CATCH_ANIMATION_ATTRIBUTE`, `DODGE_DIRECTION_ATTRIBUTE`,
 * the `Anim*` marks), because something else may need to read it: a renderer, a billboard, another client.
 * A perfect dodge is a **moment** — nothing about the body changes, no state is entered or left, and the
 * ball is already past by the time anybody could look. An attribute would have to be written and then cleared
 * by the same client that read it, which is a handshake with nothing on the far end of it; an event is the
 * shape `hitImpact` and `teamWipe` already have for exactly this kind of fact. See `networking.ts` on
 * `perfectDodge`.
 *
 * **The word is the splash's, on purpose.** `HIT!` is the game's sentence for *a thing I did that worked*, and
 * a perfect dodge is the same kind of sentence about the other half of the exchange — so it wears the same
 * letters (white, `UI_FONT`, a near-black `Contextual` outline), sits in the same column, and pops with the
 * same five steps. A second look for the second kind of success would be a second thing to learn, and
 * `ui/actionSplash.ts` exists precisely so that the look has one home.
 *
 * **It is a smaller word than the hit caption, and that is the `h6` in the request rather than a second
 * design.** The hit caption is a set piece — `TextScaled` into a `760 × 150` box, a word about a seventh of
 * the screen tall. A perfect dodge is a *second line*: it can happen while a throw of your own is being
 * captioned, so it is drawn in a typography variant (`h6`, 20 pixels) and placed one row under the big word
 * rather than through it. `createActionSplash` grew a `variant` option for it — see `ActionSplashOptions` for
 * why `TextScaled` and a variant cannot both be the answer.
 *
 * **What this is not:**
 *
 * - **Not a stat.** Nothing here counts dodges, and the round's own count is `BadgeService.recordDodge`'s,
 *   taken when a dodge *happens* rather than when one was perfect. A perfect dodge is the same dodge with a
 *   finer measurement, not a second one, and the match-stats board is a later piece of work.
 * - **Not drawn for a rig, and not because a rig cannot earn one.** `DodgeService` measures a rig's dash
 *   through the same code and prints the same line — the rule is uniform — but a rig has no screen, and the
 *   only client that could draw for it is one watching a body it is not playing. The server does not send the
 *   event for a rig at all, so there is nothing here to filter out.
 * - **Not a change to the dodge.** The dash, its cooldown and the fact that a dodge avoids a ball by moving
 *   rather than by being invulnerable are all untouched; this only watches.
 */
export function startPerfectDodge(): void {
	// **Said at boot**, for the reason `hitConfirm` says its own: a module with a subscription and no Flamework
	// controller around it is started by hand from `main.client.ts`, and a caption that never fires and one
	// that was never wired print the same nothing.
	if (DEBUG) print(`[HUD] perfect dodge up — "${PERFECT_TEXT}" on a ball that missed me by a ball's width`);

	const scope = Fusion.scoped();

	// **Built once, at mount, rather than on the frame a ball misses.** The same trade `hitConfirm` takes and
	// for the same reason: a `Frame`, a label, a stroke and a `UIScale` are a handful of constructions, and
	// doing them inside the handler would put them in the same frame as the thing the player is watching.
	const splash = createActionSplash(scope, getHudScreenGui(), {
		name: "PerfectDodgeSplash",
		variant: PERFECT_VARIANT,
		strokeThickness: PERFECT_STROKE_THICKNESS,
		position: new UDim2(0.5, 0, SPLASH_TOP_FRACTION + PERFECT_ROW_OFFSET, 0),
	});

	events.Client.Get("perfectDodge").Connect((dodger) => {
		// **The whole trigger: this client is the dodger.** The event is addressed to one player, so this
		// comparison is a belt rather than the braces — but it is the same belt `hitImpact` and `teamWipe` wear,
		// and keeping it here means a change in how the server addresses the message cannot turn a near miss on
		// somebody else into a caption on this screen. A rig's name would never match a player's, which is the
		// second half of "rigs do not draw".
		if (dodger !== Players.LocalPlayer.Name) return;

		splash.pop(PERFECT_TEXT);

		if (DEBUG) print(`[HUD] splash — ${PERFECT_TEXT}`);
	});
}

/**
 * The word — **the one string this feature says**, and the user's own phrasing rather than the shouty family
 * it sits under. `HIT!` and `CAUGHT IT!` are exclamations because they are events in a round; this is a
 * quieter note about the same throw, and it is drawn smaller for the same reason. One English string and no
 * localisation, on `hitConfirm`'s rule: the game's text is English everywhere, and a caption is the last place
 * to start a second mechanism.
 */
const PERFECT_TEXT = "Perfect";

/**
 * The typography variant the word is drawn in — **`h6`, as the request named it, and this is the whole of what
 * "size `h6`" means here.**
 *
 * A literal through a typed parameter rather than an inline argument so that the one place the size is read is
 * named: `h6` is 20 pixels with a 28-pixel line height in big-ui's own table, and `ThemeController` writes
 * `UI_FONT` into every variant, so this is the game's one face at the theme's own size.
 * `ActionSplashOptions.variant` is where the switch from `TextScaled` to a variant is argued.
 */
const PERFECT_VARIANT = "h6";

/**
 * How thick the word's outline is, in pixels. **Placeholder — 2.**
 *
 * **An outline is a proportion of the word rather than a distance**, which is why the action splash's own
 * `4` is wrong here: that is four pixels around a 150-pixel word, and the same number around a 20-pixel one
 * would be a quarter of its height. `catchPrompt` draws `CATCH IT!` at 26 pixels with `2`, which is the same
 * relative weight and the nearest precedent at this size.
 */
const PERFECT_STROKE_THICKNESS = 2;

/**
 * How far below the hit caption this word sits, as a fraction of the region — **one row, on the hit caption's
 * own line.** **Placeholder — 0.13.**
 *
 * **The two captions can be on screen at once**, which is what this number is for: a throw of yours landing
 * and a perfect dodge are independent, and a caption that drew straight over `HIT!` would make both words
 * unreadable at the moment the game had two good things to say. The offset is measured against the hit
 * caption's box rather than guessed: that box is 150 pixels tall and centred on {@link SPLASH_TOP_FRACTION},
 * so on a 720-pixel-tall screen it spans roughly 112–262 pixels, and 0.13 of that height puts this word's
 * 28-pixel line clear of the bottom of it.
 *
 * **Down rather than up**, because the hit caption is the primary sentence and a dodge is the note under it —
 * and because the top of the screen is the round's own readout column, which the hit caption only just
 * clears. See `SPLASH_TOP_FRACTION` for that clearance.
 */
const PERFECT_ROW_OFFSET = 0.13;
