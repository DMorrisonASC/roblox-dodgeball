import { Players, ReplicatedStorage, RunService, TweenService, UserInputService } from "@rbxts/services";
import { AFK_CONFIG } from "shared/config/afk.config";
import { ROUND_STATUS_FOLDER, ROUND_TIME_ATTRIBUTE } from "shared/constants";
import { events } from "shared/networking";
import { logDebug } from "shared/logger";
import { isParticipant } from "./roundZone";
import { placeAbove } from "./ui/aboveStack";
import { applyGlow } from "./ui/glow";
import { PREMIUM, premiumHudTheme } from "./ui/premiumTheme";
import { getHudScreenGui } from "./ui/screenGui";

/**
 * The card's width at rest, in pixels. **A fixed size rather than `AutomaticSize`**, because the bounce is a `Size`
 * tween and an auto-sized frame overrides one.
 *
 * **Narrower than the first version, and the type is why.** The two lines are drawn at the theme's `caption` size
 * now (see `mount`), so the only string that has to fit is `Returning to lobby in 5...` — about 150 pixels of text
 * at that size, plus the padding either side. The old 340 was sized for a 20-pixel headline over a sentence that
 * repeated it, which is what made the card read as a panel rather than as a prompt.
 */
const CARD_WIDTH = 220;

/** The padding inside the card, and the gap between its two lines, in pixels. */
const CARD_PADDING = 10;
const CARD_LINE_GAP = 4;

/**
 * **The gap between the card's bottom edge and the top of the power HUD**, in pixels.
 *
 * Small on purpose: the card is *stacked on* that column rather than floating somewhere else, so it reads as the
 * same group of readouts — the player's own status, bottom centre — with the prompt arriving above it.
 */
const CARD_BOTTOM_GAP = 8;

/**
 * **The card's `ZIndex`, and the number is chosen against the HUD's own.** The power stack it sits above is at
 * `STACK_Z_INDEX = 1`, the dock at 5 and the score plate at 4, so anything from 6 up draws over them; 10 is what
 * `enemyView` uses for its overlay and is still well under the loading screen's 30. A prompt that an armoury label
 * could draw over would be a prompt that failed at the one moment it matters.
 */
const CARD_Z_INDEX = 10;

/**
 * How much the card grows at the peak of a bounce, as a multiple of its size.
 *
 * **Six per cent, which is a breath rather than a pop.** The bounce repeats once a second for five seconds, so it
 * has to be small enough to survive being seen four times in a row: at `1.06` the card swells by about twenty
 * pixels of width and returns, which is noticed at the edge of vision without pulling the eye off the countdown it
 * is drawn beside. A larger figure is a card that appears to be *jumping at* the player, which is the wrong
 * register for a question.
 */
const BOUNCE_SCALE = 1.06;

/** How long one half of a bounce takes, in seconds — out and back is two of these. */
const BOUNCE_SECONDS = 0.16;

/**
 * **The card's height at rest, in pixels — derived in `mount` from the theme's own `caption` metrics rather than
 * written down here.**
 *
 * **Two lines at the caption's line height plus the padding and the gap**, which is the honest way to size a box
 * around text: a number typed here would be right for one font size and wrong the day the theme's caption moves,
 * and the failure is a card that clips its own second line. See `mount`, which is also where the labels are told to
 * measure themselves in **both** axes — the fault that put the two sentences on top of each other is a label that
 * measured only its width, so it had no height for the layout to space.
 */
let cardHeight = 0;

/**
 * **The AFK watcher: ask an absent player whether they are still there, and return them to the lobby if not.**
 *
 * **A plain module started from the boot rather than a Flamework controller**, which is `returnToLobby`, `hitVfx`,
 * `killCam` and `chargeEffect`'s shape and their reason: it owns no lifecycle, injects nothing, and a file of
 * functions is what keeps a module that is not a provider out of `flamework.build`.
 *
 * **The clock only runs while three things are true, and all three are gates on the clock rather than tests inside
 * it.** The player has to be **in a round** — there is nothing to be absent from in the lobby, and returning somebody
 * to the lobby they are already standing in is a no-op that would still pop a card at them — the **window has to
 * be focused**, and **the round has to have more time left on its clock than the idle window**. That second one is
 * the whole reason this feature can exist without being a nuisance: a player who alt-tabs to read something, or to
 * answer a message, is not idle, and the game has no business deciding they have left. It also cannot be a condition
 * on the *prompt* alone, because a client that is unfocused is not drawing anything anybody can see — the countdown
 * would run invisibly and fire a surrender at somebody who was away from the keyboard for reasons the game cannot
 * see. **So an unfocused window resets the idle clock every frame**, and the player gets the full window back when
 * they return. **The third is {@link roundEnding}'s, added 2026-10-22**: an idle window plus a countdown that lands on
 * the round's own zero is a request the server has to refuse, and a card drawn over a round that is already over.
 *
 * **Typing or using the interface is activity, not idleness.** The idle clock is reset by *any* input, including
 * input the interface consumed — `InputBegan` is observed rather than claimed, so a player dragging the inventory,
 * scrolling a shelf or clicking through the Shop keeps resetting it. That is deliberately the opposite of what a
 * game-action binding would do: `ContextActionService` exists to ignore input that belongs to the UI, and this
 * module's question is not "did the game act on it" but "is somebody at the keyboard". A text box is the one case
 * that is *paused* rather than counted, because a message can take longer than twenty seconds to write and a card
 * over the chat box is worse than waiting — see {@link paused}.
 *
 * **The countdown is a deadline compared against the clock, not a number decremented per frame.** A decrement on a
 * frame loop is a count that depends on the frame rate, and the number it draws is read as whole seconds — see
 * `AFK_CONFIG.COUNTDOWN_SECONDS`.
 *
 * **Nothing here decides what "returned to the lobby" means.** The client sends `afk`; `RoundService.afkReturn`
 * holds the rules, poofs the body and surrenders on the round's own terms, so a client cannot end a round by
 * sending this any more than it could by pressing the surrender key.
 */

/** The card, once built. `undefined` until the boot has run, which is what makes a stray call harmless. */
let frame: Frame | undefined;

/** The card's sentence, so a tick is one `Text` write. */
let words: TextLabel | undefined;

/** The bounce in flight, cancelled before the next one so five of them in a row cannot compound. */
let bounce: Tween | undefined;

/** `os.clock` when something last happened. The whole of the "how long has it been" state. */
let lastActivityAt = 0;

/** `os.clock` the countdown ends at, or nothing when none is running. */
let countdownEndsAt: number | undefined;

/** The whole second the card is currently showing, so the text and the bounce fire once per second, not per frame. */
let shownSecond: number | undefined;

/** The HUD GUI the card lives in, kept so a placement can be re-taken without passing it through every call. */
let hud: ScreenGui | undefined;

/**
 * The boot's one line for this module, in the shape `startReturnToLobbyPrompt` and `startHitVfx` already use.
 */
export function startAfkWatcher(): void {
	if (frame !== undefined) return;

	mount();

	lastActivityAt = os.clock();

	// **Every press and every change of input is activity, whatever is focused.** `InputBegan` covers keys, mouse
	// buttons, touches and gamepad buttons; `InputChanged` covers camera movement, a touch being dragged and a
	// thumbstick being held over — which are the three ways a player who is present still generates input without
	// pressing anything.
	UserInputService.InputBegan.Connect(() => noteActivity());
	UserInputService.InputChanged.Connect(() => noteActivity());

	RunService.Heartbeat.Connect(() => tick());

	logDebug("[AFK] watching — a round, a focused window, and twenty seconds of nothing");
}

/**
 * **Whether the clock should be stopped rather than run down**, and the two reasons are different faults.
 *
 * **An unfocused window** is the one this feature is not allowed to punish: the player is somewhere else, and a
 * countdown that ran while nobody could see it would be the game acting on information nobody was given. Roblox
 * reports this as `UserInputService.WindowFocused`, which is a property — read here rather than cached from the
 * `WindowFocusReleased` pair, because a property cannot go stale if a transition is missed and there is more than
 * one way to lose focus (another window, a modal, the engine's own menu). The signal pair exists for modules that
 * need the *edge*; this one needs the state, every frame.
 *
 * **A focused text box** is the softer case and is paused rather than merely counted: a player typing is plainly
 * present, and the card must not appear over the chat box. `GetFocusedTextBox` is the same read
 * `ControlsLegendController` uses to stop its key chips lighting up while somebody types.
 */
function paused(): boolean {
	if (!UserInputService.WindowFocused) return true;

	return UserInputService.GetFocusedTextBox() !== undefined;
}

/**
 * **Whether the round is ending sooner than the idle window — the gate that keeps this prompt off a round boundary.**
 *
 * **The race it prevents, spelled out, because it is a race and not a preference.** This feature is a fifteen-second
 * idle clock followed by a five-second countdown, and both are the *client's*; nothing in the module has ever looked
 * at how much round was left. A player who goes idle with eighteen seconds on the clock is asked "are you AFK?",
 * answers nothing, and has the countdown reach zero at about the moment the round's own clock does. The request then
 * arrives as the boundary closes and the server refuses it — a round that is ending is not `Playing` and a body
 * already on its way out is not in `activePlayers`, so `RoundService.afkReturn` returns without a word. What the
 * player saw was still wrong: a card counting down over a round that had already finished, and in the worst case a
 * transition cover for a move the round was about to make anyway, which is two fades for one teleport and a screen
 * that reads as a kick.
 *
 * **The rule is the simplest one that closes it: if there is no more round left than the idle window, there is no
 * round left for this feature to have an opinion about.** The clock is *paused* rather than merely stopped —
 * `lastActivityAt` is reset on every frame the gate holds — so a round whose clock is held (a paused round, a freeze)
 * does not accumulate a debt that fires the instant the clock moves again; the player gets the whole window back.
 *
 * **`ROUND_TIME_ATTRIBUTE` is the *phase's* clock, not the round's**, which is why this is only read behind
 * {@link tick}'s participation gate: during an intermission the same attribute counts down to the next whistle. The
 * `typeIs` guard is the folder that has not published a clock yet — a client that mounted mid-boot reads `nil`, which
 * is "no opinion" rather than "the round is ending", so the feature behaves exactly as it did before this gate.
 */
function roundEnding(): boolean {
	const status = ReplicatedStorage.FindFirstChild(ROUND_STATUS_FOLDER);
	if (!status) return false;

	const remaining = status.GetAttribute(ROUND_TIME_ATTRIBUTE);

	return typeIs(remaining, "number") && remaining <= AFK_CONFIG.IDLE_SECONDS;
}

/** Something happened: the idle clock starts again and any countdown is called off. */
function noteActivity(): void {
	lastActivityAt = os.clock();

	if (countdownEndsAt === undefined) return;

	cancelCountdown();
}

/** Puts the card away and forgets the countdown, without touching the idle clock. */
function cancelCountdown(): void {
	countdownEndsAt = undefined;
	shownSecond = undefined;

	if (bounce !== undefined) {
		bounce.Cancel();
		bounce = undefined;
	}

	if (frame !== undefined) frame.Visible = false;

	logDebug("[AFK] countdown cancelled");
}

/**
 * One frame: catch up the idle clock, run the countdown, or start one.
 *
 * **Ordered so that every "no" leaves the module in the same state** — card hidden, clock reset — which is what
 * makes standing in the lobby, alt-tabbing and dying mid-countdown all behave identically rather than each needing
 * its own tidy-up.
 */
function tick(): void {
	const player = Players.LocalPlayer;

	// **Not in a round: nothing to be absent from.** The clock is reset rather than merely ignored, so a player who
	// leaves a round has the whole twenty seconds again when they rejoin it.
	if (!isParticipant(player)) {
		lastActivityAt = os.clock();
		if (countdownEndsAt !== undefined) cancelCountdown();

		return;
	}

	// **Paused means the clock does not run at all.** Resetting here rather than freezing a remainder is deliberate:
	// a player who alt-tabs for an hour comes back to a full window, which is the only answer that cannot surprise
	// them.
	if (paused()) {
		lastActivityAt = os.clock();
		if (countdownEndsAt !== undefined) cancelCountdown();

		return;
	}

	// **And the round's own clock, which is the third gate and the one with a race behind it.** See
	// {@link roundEnding} for the sequence it closes. The reset and the cancel are the same pair the two gates above
	// use, so a countdown already running is put away rather than left to reach zero over a round that is ending.
	//
	// **Placed above the countdown branch rather than inside it, and that ordering is the whole of the fix.** The
	// branch that sends `afk` is this method's last stop; a gate that ran after it would let the one frame that
	// straddles the two events — the clock crossing the threshold on the same frame the countdown reaches zero —
	// send the request anyway, which is exactly the request this exists to stop.
	if (roundEnding()) {
		lastActivityAt = os.clock();
		if (countdownEndsAt !== undefined) cancelCountdown();

		return;
	}

	// **The third source of activity, and the one no input event reports.** A body being pushed along a conveyor,
	// or walking with the thumbstick already held when the round began, moves without anybody touching anything —
	// so the movement the game itself is applying is read directly, exactly as the prompt for this feature asked.
	// `MoveDirection` is what the control module is asking for, which is a *request* rather than a measured speed
	// and therefore does not jitter on a collision.
	const humanoid = player.Character?.FindFirstChildWhichIsA("Humanoid");
	if (humanoid !== undefined && humanoid.MoveDirection.Magnitude > 0) noteActivity();

	const now = os.clock();

	if (countdownEndsAt === undefined) {
		if (now - lastActivityAt < AFK_CONFIG.IDLE_SECONDS) return;

		beginCountdown(now);

		return;
	}

	const remaining = countdownEndsAt - now;

	if (remaining <= 0) {
		// **Sent, then put away — in that order, and the hide is not an assumption about the answer.** The server
		// re-checks its own guards and may refuse this (a round that ended between the last tick and this one), and
		// the card is hidden regardless because the alternative is a card counting to zero and then staying on
		// screen. Every path that could make the request valid again resets the idle clock, so a refusal costs one
		// card and not a stuck one.
		events.Client.Get("afk").SendToServer();

		cancelCountdown();

		// **And the idle clock starts again, which is what stops the countdown restarting at five.** The card used
		// to vanish and immediately reappear with `5` on it: the request goes out, the server takes its own cover
		// (about a second) before it moves the player, and for that second the client is still a participant with
		// an idle clock that expired twenty seconds ago — so the next frame began a fresh countdown. Resetting the
		// clock here makes the whole episode a finished thing: the card is gone, and it stays gone until either the
		// round lets go of the player (the usual case, a second later) or another full idle window passes (a request
		// the server refused).
		lastActivityAt = os.clock();

		logDebug("[AFK] countdown reached zero — asked the server to return us to the lobby");

		return;
	}

	const second = math.ceil(remaining);
	if (second === shownSecond) return;

	shownSecond = second;
	showSecond(second);
}

/** Puts the card up and starts the clock the countdown is read from. */
function beginCountdown(now: number): void {
	countdownEndsAt = now + AFK_CONFIG.COUNTDOWN_SECONDS;
	shownSecond = undefined;

	// **Placed again on the way up, and that is the cheap guarantee rather than a second mechanism.** The column it
	// sits above is auto-sized and is mounted by another module, so placing it here means the card is right at the
	// one moment it can be seen, whatever the boot order was and whatever the icon slot has grown to since.
	if (frame !== undefined && hud !== undefined) placeAbove(frame, hud, CARD_BOTTOM_GAP);

	if (frame !== undefined) frame.Visible = true;

	// Drawn at once rather than on the next frame: the card becoming visible with its first number already on it is
	// what stops a frame of "...in 5" arriving after a frame of empty card.
	showSecond(AFK_CONFIG.COUNTDOWN_SECONDS);

	logDebug(`[AFK] no input for ${AFK_CONFIG.IDLE_SECONDS}s — counting down`);
}

/** Writes the sentence for one second of the countdown, and bounces the card. */
function showSecond(second: number): void {
	shownSecond = second;

	if (words !== undefined) words.Text = `Returning to lobby in ${second}...`;

	bounceOnce();
}

/**
 * One bounce: swell and settle, on the card's own `Size`.
 *
 * **The second tween is chained from the first's completion rather than composed as one**, because `TweenInfo` has
 * no reversal — a single tween from the resting size to the peak and back is two `TweenInfo`s, and the easing has to
 * be different either way round: `Back` on the way out is what makes it overshoot, and a linear return would leave
 * the settle looking like a slide. The in-flight tween is cancelled first so a tick that lands inside a bounce
 * (a slow frame, a stalled heartbeat) cannot start a second one from halfway.
 */
function bounceOnce(): void {
	if (frame === undefined) return;

	const resting = UDim2.fromOffset(CARD_WIDTH, cardHeight);

	if (bounce !== undefined) bounce.Cancel();

	const swell = TweenService.Create(
		frame,
		new TweenInfo(BOUNCE_SECONDS, Enum.EasingStyle.Back, Enum.EasingDirection.Out),
		{ Size: UDim2.fromOffset(math.floor(CARD_WIDTH * BOUNCE_SCALE), math.floor(cardHeight * BOUNCE_SCALE)) },
	);

	bounce = swell;

	swell.Completed.Connect(() => {
		if (frame === undefined) return;

		swell.Cancel();

		const settle = TweenService.Create(
			frame,
			new TweenInfo(BOUNCE_SECONDS, Enum.EasingStyle.Quad, Enum.EasingDirection.InOut),
			{ Size: resting },
		);

		bounce = settle;
		settle.Play();
	});

	// **The resting size is written before the swell is played, and that line is what repairs a cancelled bounce.**
	// A tick that lands inside one cancels it (`bounce.Cancel()` above) wherever it had got to, so the card can be
	// left a few pixels larger than its own layout — and every call resets it here, which is one property write per
	// second and the only repair this needs.
	frame.Size = resting;
	swell.Play();
}

/**
 * Builds the card once: a dark glass plate, two lines of `caption`, and the neon edge the rest of the HUD wears.
 *
 * **Every measurement here comes from the theme's `caption`**, which is what makes the card a prompt rather than a
 * panel. `premiumHudTheme()`'s typography is `hudTheme()`'s, and `ThemeController` has written the game's one face
 * into all ten variants by the time a HUD mounts — so this is the same size and the same face as the labels beside
 * it, and the card cannot drift from them the next time the type scale moves.
 */
function mount(): void {
	const gui = getHudScreenGui();
	const caption = premiumHudTheme().typography.caption;

	// **The height the two lines need, from the metrics rather than from a guess.** Two line heights, the padding
	// above and below, and the gap between them — see `cardHeight`, which is the same number the bounce scales.
	cardHeight = 2 * caption.lineHeight + 2 * CARD_PADDING + CARD_LINE_GAP;

	const card = new Instance("Frame");
	card.Name = "AfkPrompt";
	// **Anchored on its bottom edge and stacked on the power HUD**, so the bounce grows *upward*, away from the
	// column it sits above. `placeAbove` writes the position from that column's own geometry; this is the
	// fallback for a client whose countdown begins before the stack exists.
	card.AnchorPoint = new Vector2(0.5, 1);
	card.Position = new UDim2(0.5, 0, 1, -(cardHeight + CARD_BOTTOM_GAP));
	card.Size = UDim2.fromOffset(CARD_WIDTH, cardHeight);
	card.BackgroundColor3 = PREMIUM.panel;
	card.BackgroundTransparency = PREMIUM.transparency;
	card.BorderSizePixel = 0;
	card.Visible = false;
	card.ZIndex = CARD_Z_INDEX;
	card.Parent = gui;

	// **A vertical list rather than two hand-placed labels**, which is `returnToLobby`'s shape and for its reason: the
	// two lines are different heights and the list is what keeps them apart without either one knowing the other's
	// height.
	const corner = new Instance("UICorner");
	corner.CornerRadius = new UDim(0, PREMIUM.corner);
	corner.Parent = card;

	applyGlow(card);

	const padding = new Instance("UIPadding");
	padding.PaddingLeft = new UDim(0, CARD_PADDING);
	padding.PaddingRight = new UDim(0, CARD_PADDING);
	padding.PaddingTop = new UDim(0, CARD_PADDING);
	padding.PaddingBottom = new UDim(0, CARD_PADDING);
	padding.Parent = card;

	const layout = new Instance("UIListLayout");
	layout.FillDirection = Enum.FillDirection.Vertical;
	layout.HorizontalAlignment = Enum.HorizontalAlignment.Center;
	layout.VerticalAlignment = Enum.VerticalAlignment.Center;
	layout.Padding = new UDim(0, CARD_LINE_GAP);
	layout.SortOrder = Enum.SortOrder.LayoutOrder;
	layout.Parent = card;

	// **`AutomaticSize.XY` on both labels, and the second axis is the fix for the two sentences landing on top of
	// each other.** A `TextLabel` sized in `X` alone keeps the class's default height of **zero**, so the layout had
	// nothing to space and drew both lines from the same point — the glyphs overflowed their own boxes and the card
	// read as one smear. That is the same fault `returnToLobby` records about its keycap box ("the L is not contained
	// in its box"), and the fix is the same: measure the axis the line height lives on.
	// **Both labels carry the card's own `ZIndex`, and without that number the card is what darkens them.** Roblox
	// compares a child's `ZIndex` with its parent's before it decides which is in front, so a label left at the
	// default `1` under a frame raised to `CARD_Z_INDEX` is drawn *behind* that frame's fill — a white label at full
	// ink arrives as a dark silhouette through fifteen per cent of glass. That is exactly what "the text is too
	// dark" looks like, and it is the fault the responsive-UI standard's rule 6 is written about (`panelChrome.
	// raiseZIndex` records the same thing from a panel's side: "the only visible parts of a container are the bits
	// overflowing past its edge"). **The colour was never the problem** — `PREMIUM.text` is white and
	// `PREMIUM.textTransparency` is `0` — so the fix is one number per label, not a brighter value.
	const title = new Instance("TextLabel");
	title.Name = "Title";
	title.AutomaticSize = Enum.AutomaticSize.XY;
	title.BackgroundTransparency = 1;
	title.Font = caption.font;
	title.Text = "Are you AFK?";
	title.TextColor3 = PREMIUM.text;
	title.TextTransparency = PREMIUM.textTransparency;
	title.TextSize = caption.size;
	title.LayoutOrder = 1;
	title.ZIndex = CARD_Z_INDEX;
	title.Parent = card;

	// **The sentence is the countdown alone, because the title already asks the question.** The first version repeated
	// `Are you AFK?` in both lines, which is two thirds of what made the card look cluttered however the spacing was
	// tuned; the question is asked once, in the line that does not change, and the line that changes counts.
	const sentence = new Instance("TextLabel");
	sentence.Name = "Countdown";
	sentence.AutomaticSize = Enum.AutomaticSize.XY;
	sentence.BackgroundTransparency = 1;
	sentence.Font = caption.font;
	sentence.Text = `Returning to lobby in ${AFK_CONFIG.COUNTDOWN_SECONDS}...`;
	sentence.TextColor3 = PREMIUM.gold;
	sentence.TextSize = caption.size;
	sentence.LayoutOrder = 2;
	sentence.ZIndex = CARD_Z_INDEX;
	sentence.Parent = card;

	frame = card;
	words = sentence;
	hud = gui;

	// **Placed through the shared helper, which is also what wires the retry and the follower.** `SuperHudController`
	// may mount after this module starts, and a card placed before its column exists would be sitting at the fallback
	// above; `placeAbove` watches the GUI's `ChildAdded` for that arrival and the column's `AbsoluteSize` for every
	// change after it. See that file for the arithmetic and for the other tenant of the same edge.
	placeAbove(card, gui, CARD_BOTTOM_GAP);
}
