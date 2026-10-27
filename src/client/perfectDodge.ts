import Fusion from "@rbxts/fusion-3.0";
import { ContentProvider, Players, SoundService } from "@rbxts/services";
import { AUDIO_CONFIG } from "shared/config/audio.config";
import { events } from "shared/networking";
import { logDebug, logWarn } from "shared/logger";
import { createActionSplash, SPLASH_TOP_FRACTION } from "./ui/actionSplash";
import { getHudScreenGui } from "./ui/screenGui";

/**
 * # The perfect dodge — a ball that missed by a ball's width, said and heard
 *
 * **A caption and a clip, and nothing else: the geometry is the server's, and it is the only machine that can
 * measure it.** Whether a dash avoided a ball is a fact about where a ball went and where a body had been
 * standing, and a client can see neither with any authority — its copy of the ball is interpolated, its copy of
 * another body is lagged, and a client that decided for itself what "close enough" meant would be deciding for
 * itself whether it had earned a caption. So `DodgeService.watchForPerfectDodge` measures the miss and this
 * module draws — and plays — the answer. See that method for what is measured and why it is measured against
 * the space the body left rather than the space it moved to.
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
 * **Not a change to the dodge.** The dash, its cooldown and the fact that a dodge avoids a ball by moving
 * rather than by being invulnerable are all untouched; this only watches.
 *
 * **And not a caption alone any more: it is the caption and the one sound that belongs to it.** The sound is
 * played by *this* machine, on the same frame the word pops, for the same reason the word is drawn here rather
 * than sent — a perfect dodge is a moment, and a server-played clip would be a round trip behind the animation
 * it is supposed to land with. See {@link makeSound} for where the instance lives and why it is made once, and
 * `AUDIO_CONFIG.PERFECT_DODGE` for why the id is in the config rather than in this file.
 */
export function startPerfectDodge(): void {
	// **Said at boot**, for the reason `hitConfirm` says its own: a module with a subscription and no Flamework
	// controller around it is started by hand from `main.client.ts`, and a caption that never fires and one
	// that was never wired print the same nothing.
	logDebug(`[HUD] perfect dodge up — "${PERFECT_TEXT}" and one clip on a ball that missed me by a ball's width`);

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

	// **One `Sound` for the session, made here and never made again**, which is the arrangement every other
	// client sound in this project uses — `MusicController`, `personalAudio`, `elevation`'s two interface tones
	// and `ShopController.awardSound`, and the last of those is the closest precedent because it is also one
	// clip played on an event rather than on a state. Built at mount for the splash's reason and one more: the
	// moment it is needed is a frame that must not also pay for instance construction.
	const sound = makeSound();

	// **Preloaded, because the first perfect dodge of a session can arrive before the clip does.** Same problem
	// `personalAudio` names: a `Sound` whose asset is still in flight when `Play` is called arrives after the
	// moment it describes, or not at all — and unlike a pointer-driven tone there is nothing the player can do
	// to wait for it. The window is only generous if the load starts at boot, which is here. The warn is the
	// same shape too, and for the same reason: a wrong id is the one fault of this feature that can only be
	// heard as silence.
	ContentProvider.PreloadAsync([sound], (contentId, fetchStatus) => {
		if (fetchStatus !== Enum.AssetFetchStatus.Success) {
			logWarn(`[Audio] perfect dodge sound did not load — ${contentId} (${fetchStatus.Name})`);
		}
	});

	events.Client.Get("perfectDodge").Connect((dodger) => {
		// **The whole trigger: this client is the dodger.** The event is addressed to one player, so this
		// comparison is a belt rather than the braces — but it is the same belt `hitImpact` and `teamWipe` wear,
		// and keeping it here means a change in how the server addresses the message cannot turn a near miss on
		// somebody else into a caption on this screen. A rig's name would never match a player's, which is the
		// second half of "rigs do not draw". **The sound is inside this same gate**, so it cannot play for
		// somebody else's dodge either — the two are one event and one answer.
		if (dodger !== Players.LocalPlayer.Name) return;

		// **The word and the sound are one announcement, written as two lines with nothing between them.**
		// Both are synchronous, so they land on the same frame: `pop` starts its first tween and `Play` starts
		// the clip on the same tick the event was handled on. Order is therefore arbitrary and this order is
		// the reading order of the sentence — the thing you see, then the thing you hear.
		splash.pop(PERFECT_TEXT);
		play(sound);

		logDebug(`[HUD] splash — ${PERFECT_TEXT}`);
	});
}

/**
 * The perfect dodge's `Sound`: **one instance for the session, in `SoundService`, with every property applied
 * in code.**
 *
 * **`SoundService` and not `PlayerGui`**, and this is the parent question the three other client-audio files
 * answer the same way: a `Sound` is positional only when it hangs off a `BasePart` or an `Attachment`, so
 * anywhere else is 2D — but `PlayerGui` is torn down and rebuilt on every respawn, and an instance made once
 * for the session must not be sitting inside a container that does not outlive it. A `SoundGroup` would be a
 * shared volume multiplier, and there is nothing here it should be multiplied by: this is one clip at one
 * level, and `AUDIO_CONFIG.PERFECT_DODGE_VOLUME` is the whole of how loud it is.
 *
 * **Made once and restarted, not made per caption.** A `Sound` per perfect dodge would be an instance per
 * event with an owner, constructed on the frame the word pops — the one frame that should not also be paying
 * for an instance — and, worse, a *fresh* instance has not been preloaded, so the first one of a session would
 * arrive late or not at all. That is the trade `ShopController.awardSound` and `personalAudio` both record.
 *
 * **`Looped = false` and `PlaybackSpeed = 1` are stated rather than left to the default**, as `personalAudio`'s
 * twin of this function does: the loop is the one that would be a bug rather than a preference (a caption
 * sound that looped would keep going after the word had faded), and the speed is written because the charge
 * sound is the one client clip that derives its speed from the mechanic — this one is played as uploaded.
 *
 * **A fourth copy of these six lines, and that is named rather than hidden.** `MusicController` has a private
 * `makeSound`, `personalAudio` has this same function, and `elevation`, `ShopController`, `ThrowController` and
 * `ArenaFreezeCountdownController` each build their `Sound` inline. Consolidating all six into one helper is a
 * pass of its own — it touches five files this feature does not, for no change a player could hear — so this
 * one is written to match them. If that pass ever happens, this is the file to start from.
 */
function makeSound(): Sound {
	const sound = new Instance("Sound");
	sound.Name = "PerfectDodge";
	sound.SoundId = AUDIO_CONFIG.PERFECT_DODGE;
	sound.Looped = false;
	sound.PlaybackSpeed = 1;
	sound.Volume = AUDIO_CONFIG.PERFECT_DODGE_VOLUME;
	sound.Parent = SoundService;

	return sound;
}

/**
 * Plays the caption's clip from the beginning, whatever it was doing.
 *
 * **`Stop` before `Play`, and the order is the whole of it.** `Sound:Play()` on a clip that is already playing
 * does nothing — it is not a restart — so a second perfect dodge inside the first clip's length would be
 * *silent*, which is the worst possible answer: the sound would be reliably present only when the dodges were
 * far apart. `Stop` rewinds and silences, `Play` starts from there. `personalAudio.play` argues the same line
 * for the same reason; `ShopController` gets away with a bare `Play()` because chests are minutes apart, and
 * this is not.
 *
 * **No `Ended` cleanup, and the absence is deliberate.** The instance is one for the session and belongs to
 * `SoundService` for as long as the client lives — destroying it after each play would mean building a new,
 * unpreloaded one for the next, which is the late-clip fault {@link makeSound} exists to avoid. There is
 * nothing here that accumulates: one `Sound`, one subscription, both made once at boot.
 */
function play(sound: Sound): void {
	sound.Stop();
	sound.Play();
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
