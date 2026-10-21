import { Controller, OnStart } from "@flamework/core";
import { Text } from "@rbxts/big-ui";
import type { TypographyVariant } from "@rbxts/big-ui";
import Fusion from "@rbxts/fusion-3.0";
import { Players, RunService, Workspace } from "@rbxts/services";
import { LAST_HIT_BY_ATTRIBUTE, RESPAWN_AT_ATTRIBUTE } from "shared/constants";
import { killCamActive } from "../../panels";
import { splashStyle, styleSplashText } from "../../ui/actionSplash";
import type { SplashStyle } from "../../ui/actionSplash";
import { PREMIUM } from "../../ui/premiumTheme";
import { getHudScreenGui } from "../../ui/screenGui";
import { addViewportConstraint } from "../../ui/viewportConstraint";

/** Prints once, when the countdown is up — the line that says the controller ran at all. */
const DEBUG = false; // off for frame time — see shared/config/debug.config.ts

/**
 * The element's width, and **the bound the attacker's line is truncated to.**
 *
 * Its height comes from the two lines; this is only what they are centred in. **A width rather than
 * `AutomaticSize.X`**, because the name is whatever the server wrote: a long display name would otherwise grow
 * the element until it hit the viewport edge, and re-centre it on every hit. A name wider than this is
 * ellipsised (`TextTruncate.AtEnd`), which is one line that says "there is more" rather than a box that moves.
 */
const LABEL_WIDTH = 320;

/**
 * Where the element sits: **centred horizontally, `0.44` of the height down — under the action splash and above
 * the middle of the screen.**
 *
 * **The ordering is written down, because two things can be on screen at once and one can land on the other.**
 * Top to bottom: the action splash (`HIT!` … `WIPEOUT!`) at `SPLASH_TOP_FRACTION`'s `0.26` of the height, then
 * this element, then the aim sight at `0.5`. The splash is anchored at its own centre and capped by
 * `SPLASH_MAX_FRACTION` at 24 % of the height, so its lowest edge is `0.26 + 0.12 = 0.38` of the height at any
 * viewport; this element is two lines (about 60 px: `h4`'s 42 px line plus a `caption` line), so its top edge is
 * `0.44 − 30/height`. At 1080 tall that is 445 against 410 — 35 px of air; at a landscape phone's 600 tall it is
 * 234 against 228, which is the tightest it gets and still clear. **The `0.06` between the two was chosen from
 * that arithmetic rather than by eye**, and it is the number to raise if either element is ever made taller.
 *
 * **Above the middle rather than on it.** The countdown is drawn for a player who cannot throw, so clearing the
 * crosshair is not strictly necessary — but the aim sight is the one piece of this screen that must never be
 * covered, and there is no reason to cover it.
 */
const CENTRE = UDim2.fromScale(0.5, 0.44);

/**
 * The three type sizes in the element, and each one is a **step on big-ui's own scale rather than a pixel
 * size** — the theme is where a project-wide type change happens, and a literal here would ignore it.
 *
 * **`h4` for the whole seconds, `subtitle1` for the tenths, `caption` for the attacker's name.** The pair of
 * sizes is the numeral treatment: `h4` is the largest variant that is still a numeral rather than a headline
 * (`34px`, whose line box is `42`), and the tenths at `16px` are a little under half of it — big enough to read
 * at arm's length and small enough that the eye lands on the second first. The name is `12px`, under both,
 * because it is a caption to the number rather than a peer of it.
 */
const SECONDS_VARIANT: TypographyVariant = "h4";
const TENTHS_VARIANT: TypographyVariant = "subtitle1";
const ATTACKER_VARIANT: TypographyVariant = "caption";

/**
 * How transparent the tenths are drawn — **the "dimmer" half of the numeral treatment, as alpha rather than a
 * second colour.**
 *
 * **A colour would be a second value to keep in step with the theme**; transparency is a statement about the
 * *same* colour ("less of this ink"), which is exactly what a subordinate digit is. It also leaves the outline
 * at the style's own resting opacity, so the small digits keep the edge that makes them legible over a bright
 * court while their fill steps back. **Placeholder — `0.25`.**
 */
const TENTHS_TRANSPARENCY = 0.25;

/**
 * How thick the numerals' outlines are, in pixels — **the splash's proportion at these sizes.**
 *
 * `styleSplashText`'s own default is `4` around a 150-pixel word (about 2.7 % of its height); `h4`'s 34-pixel
 * letters want just under 1, which is this. **The same number for the tenths**, because an outline thinner than
 * a pixel does not exist — and the arena-freeze countdown reached the same value for the same reason
 * (`COUNTDOWN_STROKE_THICKNESS`). **Placeholder — `1`.**
 */
const NUMBER_STROKE = 1;

/** The gap between the two lines, in pixels. **Placeholder — 2**, which is a hairline rather than a space. */
const LINE_GAP = 2;

/** The gap between the whole seconds and their tenths, in pixels. **Placeholder — 2.** */
const TENTH_GAP = 2;

/** What the attacker's line starts with, so the name is a sentence rather than a bare word. */
const HIT_BY_PREFIX = "Hit by ";

/**
 * How long the local player has left to wait for a body, in whole tenths, or `0` for "not waiting".
 *
 * **Fractions of a second rather than whole ones, because the wait is only a few seconds long.** A
 * three-second timer read in whole seconds spends most of its life looking stuck; a tenth is the
 * resolution at which a wait that short feels like it is moving.
 *
 * **Read against `Workspace:GetServerTimeNow`, which is the clock the server wrote with.** The
 * attribute is an *instant* — `RESPAWN_AT_ATTRIBUTE` holds the moment the body is due, on the engine's
 * shared clock — so this is one subtraction and needs no remote, no local timer, and no second
 * implementation of "how long is the wait". A client counting down on its own would be exactly that:
 * a second answer, free to disagree with the one the server is actually going to keep.
 *
 * `0` for anything that is not a number, which is the state a player joins in and the state
 * `RespawnService` writes the moment a body is loaded — so "no attribute" and "the wait is over" are
 * the same answer here, and there is no third case to get wrong.
 */
function remainingOf(at: unknown, now: number): number {
	if (!typeIs(at, "number")) return 0;
	if (at <= now) return 0;

	return at - now;
}

/**
 * The name of the body that last hit this player, or `""` — **the empty string rather than `undefined`, so the
 * label has one thing to test.**
 *
 * **The attribute is already a display string.** The server decides what a name looks like at the one moment it
 * can: `RoundService.registerHit` writes a `Player`'s `DisplayName` and a rig's `Name`, so this file never asks
 * *what kind of body* the attacker was — it draws what it was given, and a rig and a player are drawn the same
 * way on purpose (see `LAST_HIT_BY_ATTRIBUTE`). **Nothing here resolves a token or looks a model up.**
 */
function attackerOf(player: Player): string {
	const value = player.GetAttribute(LAST_HIT_BY_ATTRIBUTE);

	return typeIs(value, "string") ? value : "";
}

/**
 * The respawn countdown: **two lines — how long, and who — above centre, shown only while the local player is
 * waiting for a body.**
 *
 * **It exists because the wait is now real.** A death inside a round no longer hands the body straight
 * back — the engine's own respawn was switched off (see `main.server.ts`) so that `RoundService` can
 * delay it — which means there is a gap a player has to be told about. Without this label that gap is
 * a dead screen with no explanation, and the honest reading of a dead screen is "the game has broken".
 *
 * **It reads two attributes and nothing else**: `RespawnService` writes the instant the next body is due on
 * the *player* — not the character, because the character is precisely what is missing — and
 * `RoundService.registerHit` writes the name of the body that last hit them. So there is no remote here, no
 * service, and no knowledge of why the wait was scheduled. Everything shown is derived from those two values,
 * so the readout cannot disagree with the timer that will actually fire.
 *
 * **The name is the second line because the countdown was the one part of a death that said *how long* and not
 * *what happened*.** `HitLogController` already shows who hit whom, but it does that in the corner for the
 * whole round and it drops a row after ten seconds; a player looking at a dead screen wants the one fact this
 * death was — and it is the same fact, drawn where they are already looking. It sits *under* the number rather
 * than beside it: a name of unknown length beside a centred numeral would move the numeral off the screen's
 * centre line, and the number is the half that must not move. That is the same argument `hitConfirm` makes for
 * refusing to lay its caption out around a victim's name.
 *
 * **This is now the only readout that says anything about a player who is out of the round**, which is the
 * half of its job that used to be shared with someone else. `SpectatorController` said "you're out —
 * spectating" for the whole time a player was out of a round; that controller and its attribute are gone,
 * so being out of a round is now visible here or not at all.
 *
 * **The two were never the same fact, and this one never covered the other.** This is about being *between
 * bodies*: `RESPAWN_AT_ATTRIBUTE` is cleared the moment the body arrives, and a death inside a round hands
 * one back after `ARENA_CONFIG.RESPAWN_DELAY_SECONDS`, so the wait is short and ends on its own. What has
 * changed is the other case — an elimination that lasts the rest of the round — which no longer has a
 * label, because the label that covered it was the state that was removed. Team Elimination is the only
 * mode that reaches that case and it is unreachable today; see `RoundService.eliminate`. **An elimination
 * therefore shows no attacker line at all**, and that is the honest answer rather than a gap: the element
 * that was being dressed is the countdown, and an instant respawn has no countdown.
 */
@Controller()
export class RespawnHudController implements OnStart {
	public onStart(): void {
		// Spawned rather than done inline: mounting waits for `PlayerGui`, and a controller's `onStart`
		// is the wrong place to hold up the rest of the client's boot. The wait is also why this is safe
		// to mount at boot rather than on a death: `PlayerGui` outlives the character, so the label stays
		// parented across the one event it is here to describe.
		task.spawn(() => this.mount());
	}

	private mount(): void {
		const player = Players.LocalPlayer;
		const scope = Fusion.scoped();

		// Hidden is the state a player joins in — they have a body, so nothing is being waited for — so
		// nothing has to be worked out before the server has said anything.
		const waiting = Fusion.Value(scope, false);

		scope.push(
			player.GetAttributeChangedSignal(RESPAWN_AT_ATTRIBUTE).Connect(() => {
				waiting.set(remainingOf(player.GetAttribute(RESPAWN_AT_ATTRIBUTE), Workspace.GetServerTimeNow()) > 0);
			}),
		);

		// Seeded from what the server has already said, because the attribute can be set before this runs:
		// a player who died while the client was still loading is already counting down, and the label should
		// be up on the first frame rather than at the next change — which, for a wait this short, may be
		// after it has finished.
		waiting.set(remainingOf(player.GetAttribute(RESPAWN_AT_ATTRIBUTE), Workspace.GetServerTimeNow()) > 0);

		// A frame around the label rather than the label itself, because `Visible` is what is reactive and a
		// `TextLabel` built by big-ui's `Text` takes no reactive properties. One of the two has to carry the
		// state; this way the label keeps the typography. The division was `SpectatorController`'s first, and
		// it outlived that controller because the reason for it is a fact about big-ui rather than about the
		// label that used to be drawn there.
		const wrapper = Fusion.New(scope, "Frame")({
			Name: "RespawnCountdown",
			Size: new UDim2(0, LABEL_WIDTH, 0, 0),
			Position: CENTRE,
			AnchorPoint: new Vector2(0.5, 0.5),
			AutomaticSize: Enum.AutomaticSize.Y,
			BackgroundTransparency: 1,

			// **And off while a kill cam is shooting, which is the one hide here worth arguing about.** This is
			// the only element on the screen that is genuinely *about* the wait the cam is filling, so hiding it
			// trades information for the shot: three seconds of somebody else's fight, and a numeral counting
			// down over it is the clutter the whole change exists to remove. What makes the trade safe is that
			// nothing is torn down — `waiting` keeps being written underneath by the same subscription, so the
			// countdown is *correct* on the frame it comes back rather than restarting. See `panels.ts`'s
			// paragraph on why the HUD is hidden rather than destroyed.
			Visible: Fusion.Computed(scope, (use) => use(waiting) && !use(killCamActive)),
		});

		// `LABEL_WIDTH` is 320px and the element is centred, so a viewport narrower than that clips it on both
		// sides at once. No shipping phone is that narrow, and the bound costs nothing on one that is wide
		// enough — the same rule as the other HUDs: the element carries its own limit rather than trusting
		// that the screen will be big enough.
		addViewportConstraint(scope, wrapper);

		// **Two lines, stacked, and the wrapper's `AutomaticSize.Y` is what makes its height the sum of them.**
		// A `BillboardGui` cannot size itself and a `Frame` can, so the layout measures and the file adds up
		// nothing: `h4`'s line box and `caption`'s come from the theme, and a hand-written total would be a
		// guess that goes stale the day either variant is retuned (`StatsBillboardController` made the same
		// move for the same reason).
		const stack = new Instance("UIListLayout");
		stack.FillDirection = Enum.FillDirection.Vertical;
		stack.SortOrder = Enum.SortOrder.LayoutOrder;
		stack.HorizontalAlignment = Enum.HorizontalAlignment.Center;
		stack.VerticalAlignment = Enum.VerticalAlignment.Center;
		stack.Padding = new UDim(0, LINE_GAP);
		stack.Parent = wrapper;

		// **The theme is read once and handed to all three labels, which is what makes them one look.** The
		// style is `ui/actionSplash.ts`'s — the same `splashStyle()` the `HIT!` caption is drawn with, so the
		// face and the white are that module's values rather than copies of them. The alternative was to read
		// `hudTheme()` here and write the three values again, which is the drift the prompt is about: a copied
		// literal is right until either element is retuned.
		//
		// **One value is replaced, and it is the outline.** `splashStyle()`'s outline is the light palette's
		// near-black, which was right while the HUD was light and is now the one colour on screen that does not
		// belong: the numerals sit over the arena with no panel behind them, so the outline is the only thing
		// separating white glyphs from a bright sand pitch — and the game palette's deep plum is both darker enough
		// to do that job and the surface every panel around them is made of. **Replaced rather than re-derived**,
		// which is the point of `SplashStyle` being a value a caller may hand in: the face and the letters still
		// come from the splash module, so a change there still reaches this countdown.
		const style: SplashStyle = { ...splashStyle(), outline: PREMIUM.panel };

		// **The numeral, in two parts, because the part that changes ten times a second is not the part that
		// matters.** The whole seconds are `h4` and the tenths are a smaller, dimmer `subtitle1` beside them —
		// so the eye lands on "how many seconds" and the tenth is a detail that moves. One label at one size
		// would either make a 34-pixel numeral change width every tenth (a number that twitches) or be drawn
		// small enough to read "3.0" as one lump; this is what the arena freeze's big numerals do, without a
		// size that changes every frame. A `UIListLayout` in a row centres the pair as one object, so the
		// numerals stay on the centre line even as the digit count changes.
		const row = Fusion.New(scope, "Frame")({
			Name: "Number",
			Size: new UDim2(1, 0, 0, 0),
			AutomaticSize: Enum.AutomaticSize.Y,
			BackgroundTransparency: 1,
			LayoutOrder: 1,
		});

		const rowLayout = new Instance("UIListLayout");
		rowLayout.FillDirection = Enum.FillDirection.Horizontal;
		rowLayout.SortOrder = Enum.SortOrder.LayoutOrder;
		rowLayout.HorizontalAlignment = Enum.HorizontalAlignment.Center;
		// **Both labels sit on the same bottom edge rather than on their own centres**, which is what makes two
		// sizes read as one number: a `subtitle1` line beside an `h4` line, centred vertically, floats the small
		// digit halfway up the big one.
		rowLayout.VerticalAlignment = Enum.VerticalAlignment.Bottom;
		rowLayout.Padding = new UDim(0, TENTH_GAP);
		rowLayout.Parent = row;

		// **`fit: false` on every one of the three**, and it is the freeze countdown's reason: `TextScaled`
		// derives the type size from the label's size, and these labels take their size *from* the variant and
		// then grow to their own text (`AutomaticSize.XY`), so a scaled fit would be a third opinion about the
		// same number. The face, the colour and the outline are unaffected — `styleSplashText` writes those to
		// the instance and they do not care how the glyphs were sized.
		const seconds = Text(scope, {
			text: "",
			variant: SECONDS_VARIANT,
			align: Enum.TextXAlignment.Center,
		});

		seconds.Name = "Seconds";
		seconds.Size = UDim2.fromOffset(0, 0);
		seconds.AutomaticSize = Enum.AutomaticSize.XY;
		seconds.LayoutOrder = 1;
		styleSplashText(seconds, { fit: false, strokeThickness: NUMBER_STROKE, style });
		seconds.Parent = row;

		const tenths = Text(scope, {
			text: "",
			variant: TENTHS_VARIANT,
			align: Enum.TextXAlignment.Center,
		});

		tenths.Name = "Tenths";
		tenths.Size = UDim2.fromOffset(0, 0);
		tenths.AutomaticSize = Enum.AutomaticSize.XY;
		tenths.LayoutOrder = 2;
		styleSplashText(tenths, { fit: false, strokeThickness: NUMBER_STROKE, style });
		// Set after the style, which writes the text but never the alpha — see `TENTHS_TRANSPARENCY`.
		tenths.TextTransparency = TENTHS_TRANSPARENCY;
		tenths.Parent = row;

		// **The attacker's line, and the one label here that is a fixed width rather than a measured one.** It
		// fills the element (`1, 0`) and truncates at the end, so a long display name is an ellipsis instead of
		// a wider box: the name is the server's string and its length is not this file's to trust.
		const attacker = Text(scope, {
			text: "",
			variant: ATTACKER_VARIANT,
			align: Enum.TextXAlignment.Center,
		});

		attacker.Name = "HitBy";
		attacker.Size = new UDim2(1, 0, 0, 0);
		attacker.AutomaticSize = Enum.AutomaticSize.Y;
		attacker.LayoutOrder = 2;
		attacker.TextTruncate = Enum.TextTruncate.AtEnd;
		styleSplashText(attacker, { fit: false, strokeThickness: NUMBER_STROKE, style });
		attacker.Parent = wrapper;

		row.Parent = wrapper;
		wrapper.Parent = getHudScreenGui();

		// **The name, written on the attribute's own signal rather than sampled in the frame loop.** Unlike the
		// number it changes at most once per death, so there is nothing to poll: one connection, one write per
		// hit. `LAST_HIT_BY_ATTRIBUTE` is cleared by `RoundService` when the body arrives and at the `Playing`
		// edge, so an empty value here means "this death has no attacker to name" and the line collapses to
		// nothing — an empty `TextLabel` has no height to add to the stack.
		//
		// **Seeded, like `waiting` above**, because the attribute can be set before this runs: a player who died
		// while the client was still loading is already waiting, and the name belongs on the first frame rather
		// than at the next change — which, for a wait this short, may be after it has finished.
		const showAttacker = (name: string): void => {
			attacker.Text = name === "" ? "" : HIT_BY_PREFIX + name;
		};

		showAttacker(attackerOf(player));

		scope.push(
			player.GetAttributeChangedSignal(LAST_HIT_BY_ATTRIBUTE).Connect(() => showAttacker(attackerOf(player))),
		);

		// **The one thing that is written imperatively rather than through a `Value`, and it is the text
		// itself.** `Visible` changes on an attribute write, so it can be reactive; the number changes every
		// frame by definition, and wrapping a per-frame value in a `Value` would be Fusion doing arithmetic
		// this loop is already doing. So the loop writes the two numeral labels and nothing else, and returns
		// immediately on the frames that matter most — the ones where the player has a body.
		//
		// `Fusion.peek` rather than a subscription to `waiting`: the loop is *already* running every frame, so
		// asking Fusion for the current value costs one table lookup where a subscription would cost a
		// dependency edge and a second body of code to decide the same thing twice.
		//
		// **What is shown last, so a frame that has not crossed a tenth writes nothing.** Both labels are
		// `AutomaticSize.XY`, so every write is a text measurement and a re-centre of the row; assigning the
		// same string sixty times a second is the one cost this element does not need to pay.
		let shownWhole = -1;
		let shownTenth = "";

		scope.push(
			RunService.RenderStepped.Connect(() => {
				if (!Fusion.peek(waiting)) return;

				const remaining = remainingOf(player.GetAttribute(RESPAWN_AT_ATTRIBUTE), Workspace.GetServerTimeNow());

				if (remaining <= 0) {
					waiting.set(false);

					return;
				}

				// Rounded up before it is split: `%.1f` on a wait of 3.00 to 2.95 would print "3.0", and on
				// 0.04 would print "0.0" while the body has not arrived — a label that says zero and means "any
				// moment now". `math.ceil` to a tenth keeps the last shown figure honest at both ends.
				const tenth = math.ceil(remaining * 10) / 10;

				// **Split rather than formatted as one string, because the halves are drawn at two sizes.** The
				// tenth is already a multiple of `0.1`, so one rounding recovers the digit exactly; the `+ 0.5`
				// is there because `2.9 - 2` is `0.8999999999999999` in binary floating point, and without it the
				// label would show `.8` for a tenth of a second on some values.
				const whole = math.floor(tenth);
				const decimal = math.floor((tenth - whole) * 10 + 0.5);

				if (whole !== shownWhole) {
					shownWhole = whole;
					seconds.Text = string.format("%d", whole);
				}

				const tenthText = string.format(".%ds", decimal);

				if (tenthText !== shownTenth) {
					shownTenth = tenthText;
					tenths.Text = tenthText;
				}
			}),
		);

		if (DEBUG) {
			print(
				`[HUD] respawn countdown up — reading ${RESPAWN_AT_ATTRIBUTE} and ${LAST_HIT_BY_ATTRIBUTE} ` +
					`on the player`,
			);
		}
	}
}
