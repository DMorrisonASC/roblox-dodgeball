import { ContextActionService, Players, ReplicatedStorage, UserInputService } from "@rbxts/services";
import { IN_ROUND_ATTRIBUTE, ROUND_STATE_ATTRIBUTE, ROUND_STATUS_FOLDER } from "shared/constants";
import { events } from "shared/networking";
import { logDebug } from "shared/logger";
import { applyGlow } from "./ui/glow";
import { PREMIUM } from "./ui/premiumTheme";
import { getHudScreenGui } from "./ui/screenGui";

/** The action name, and also what an `UnbindAction` would be given if this ever unmounted. */
const ACTION_NAME = "ReturnToLobby";

/**
 * The key that arms the prompt and, pressed again, leaves the round.
 *
 * **A letter rather than a chord**, because it has to be reachable while the other hand is on the mouse, and
 * `L` is the one key in the WASD neighbourhood that no movement or action binding already owns. The letter is
 * drawn on the prompt itself — see `mount` — so the binding and the label cannot drift apart.
 */
const KEY = Enum.KeyCode.L;

/** The round phase in which leaving is a thing to do. Anything else hides the prompt entirely. */
const PLAYING = "Playing";

/**
 * **The pill's paint is the game HUD's palette**, read from `ui/premiumTheme.ts` at each use rather than copied into
 * four constants here. It used to be four `Color3` literals — a near-black panel, a grey border, an off-white label
 * and a dark red for the armed state — which was right while this pill was the only dark furniture in the HUD. Now
 * that every in-game surface shares one direction, the four jobs are the palette's own: the panel, the gold
 * hairline, the near-white, and the crimson accent for "this will end your round".
 */

/** How far from the bottom-left corner the pill sits, in pixels. */
const EDGE_X = 16;
const EDGE_Y = 16;

/**
 * **The "Return to Lobby" prompt: one key, one confirmation, and no way to do it by accident.**
 *
 * **A plain module started from the boot rather than a Flamework controller**, which is `hitVfx`,
 * `catchPrompt` and `chargeEffect`'s shape and for their reason — it owns no lifecycle and injects nothing. It
 * is *state and functions* rather than a class on purpose: Flamework's transformer records an exported class in
 * `flamework.build` whether or not it carries a decorator, and a file of functions is what keeps a module that
 * is not a provider out of that manifest.
 *
 * **Two presses, and the second one is what crosses the wire.** The first arms the pill — the words change to
 * "Are you sure?" and the key box stays, so the affordance does not move under the cursor — and the second
 * sends `surrender`. Nothing else sends it anywhere in the client: a stray `L` while reaching for `W` cannot
 * end a round for anybody.
 *
 * **Any other key disarms it, and the input is not swallowed.** That is the whole of the cancel rule, and the
 * "not swallowed" half is what makes it usable: the cancel is read from `UserInputService.InputBegan`, which
 * *observes* input rather than claiming it, so the press that cancels the prompt is the same press the movement
 * code acts on — a player who presses `W` to walk away keeps walking. A `ContextActionService` binding for the
 * cancel would have to return `Sink` to see the key first, and sinking `W` would stop the very movement that
 * makes walking away the obvious way to say no. Only `KEY` itself goes through `ContextActionService`, so the
 * chat box keeps priority over it exactly as it does over every other game action.
 *
 * **The mouse is deliberately not a cancel.** Moving the camera or clicking is how a player looks around while
 * deciding, and treating either as "no" would make the prompt impossible to keep open for the second it takes to
 * read. A click is also how the world is used, so a cancel on click would fire on a throw already committed.
 *
 * **Visible only while the player is in the round, which is not the same as being on a side.** The phase says a
 * round is being played; `IN_ROUND_ATTRIBUTE` says it has this player in it. **That second half used to be
 * `TEAM_ATTRIBUTE`, and it was the bug this file shipped with**: a surrender deliberately keeps the side on the
 * `Player` — `teams` keeps the roster entry so the round's outcome still counts them — so after returning to the
 * lobby the pill went on advertising a round the server would refuse to let them leave. An eliminated player was
 * the same fault with no request behind it. Both are told apart now by the attribute the round writes for that
 * exact question, at the four places membership changes, so nothing here has to infer it.
 *
 * **Hidden on a touch-only client, which is the mobile answer rather than an offset.** The bottom-left corner is
 * `TouchJoystickController`'s movement zone on a phone, and a key prompt there is both unreadable and unusable —
 * there is no `L` on a touchscreen. A device with a keyboard keeps it whatever else it has, which is the case a
 * tablet in a keyboard cover falls into.
 */

/** Whether the second press is armed. The whole of the confirm state. */
let armed = false;

/** The pill and its label, so a state change is two property writes. */
let frame: Frame | undefined;
let label: TextLabel | undefined;

/**
 * **The boot's one line for this prompt**, in the shape `startHitVfx`, `startCatchPrompt` and
 * `startChargeEffects` already use: the module owns a subscription and no lifecycle, so whoever starts the client
 * is what starts it.
 */
export function startReturnToLobbyPrompt(): void {
	// **A touch-only client has no key to press**, so nothing is built and no binding is made: a hidden frame
	// and a dead binding would both be state nobody can reach.
	if (UserInputService.TouchEnabled && !UserInputService.KeyboardEnabled) {
		logDebug("[Surrender] prompt off — a touch-only client has no L key");

		return;
	}

	mount();

	ContextActionService.BindAction(ACTION_NAME, (_name, state) => {
		// **Activated only, and `Pass` on everything else.** `Begin` is the press; answering it with `Pass`
		// leaves the key unclaimed for anything else that might want it. The prompt is usable only while it is
		// on screen, and it is on screen only in a round on a side, so no phase check is needed beyond that.
		if (state !== Enum.UserInputState.Begin) return Enum.ContextActionResult.Pass;
		if (!visible()) return Enum.ContextActionResult.Pass;

		press();

		return Enum.ContextActionResult.Pass;
	}, false, KEY);

	// **The cancel, and the reason it is not a second `ContextActionService` binding.** See the doc above:
	// observing the key rather than claiming it is what lets the same press keep walking. `gameProcessed` is not
	// consulted because a processed key *cancels*, which is what a player typing in chat expects to happen to
	// the prompt behind the chat box.
	UserInputService.InputBegan.Connect((input) => {
		if (!armed) return;
		if (input.UserInputType !== Enum.UserInputType.Keyboard) return;
		if (input.KeyCode === KEY) return;

		disarm();
	});

	// **And the visibility is re-read from the two attributes the server publishes**, so this costs two
	// subscriptions rather than a poll. `CharacterAdded` is kept as a third look because both facts move
	// with a body — an elimination writes the membership off and loads a new character in the same breath,
	// and a rejoin after a surrender does it in the other direction — so re-reading once the body has landed
	// is what stops the pill holding a value from the frame before.
	const player = Players.LocalPlayer;
	const folder = ReplicatedStorage.WaitForChild(ROUND_STATUS_FOLDER);

	folder.GetAttributeChangedSignal(ROUND_STATE_ATTRIBUTE).Connect(() => refresh());
	player.CharacterAdded.Connect(() => refresh());
	player.GetAttributeChangedSignal(IN_ROUND_ATTRIBUTE).Connect(() => refresh());

	refresh();

	logDebug("[Surrender] prompt up — L once to arm, again to leave");
}

/** Builds the pill: a rounded frame, the words, and a box holding the key. */
function mount(): void {
	const gui = getHudScreenGui();

	const pill = new Instance("Frame");
	pill.Name = "ReturnToLobby";
	pill.AnchorPoint = new Vector2(0, 1);
	pill.AutomaticSize = Enum.AutomaticSize.XY;
	pill.BackgroundColor3 = PREMIUM.panel;
	pill.BackgroundTransparency = PREMIUM.transparency;
	pill.BorderSizePixel = 0;
	pill.Visible = false;
	pill.Parent = gui;

	// **Pinned to the bottom-left corner by the region's own geometry, not by a measurement of it.** The horizontal
	// half is the pixel inset from the region's left edge; the vertical half is `Scale = 1` — *the region's bottom
	// edge, whatever it is right now* — less the same inset, with the `(0, 1)` anchor above making that edge the
	// pill's bottom rather than its top.
	//
	// **This replaces `UDim2.fromOffset(EDGE_X, gui.AbsoluteSize.Y - EDGE_Y)`, and the difference is not tidiness.**
	// An offset-only position is measured from the region's *top*, so the old line had to subtract the region's
	// height to reach the bottom — a number read once, at mount, out of a property that is a layout product. Nothing
	// kept it in step afterwards, so the pill was placed against whatever the GUI measured in that one instant (a
	// client that has not been laid out yet, or one that is resized after boot, puts it somewhere else entirely). The
	// scale form has no number in it that can go stale: it is re-resolved on every layout pass, and it needs no
	// `ViewportSize` listener. Same idiom as the power column below it (`SuperHudController`: `UDim2(0.5, 0, 1, -N)`).
	//
	// **And the inset region is the right region for it.** On a mobile client this GUI is `CoreUISafeInsets`, so
	// `Scale = 1` is the bottom of the safe area rather than the screen's last pixel — which is the same corner the
	// stamina column is anchored to, and the one that keeps a prompt out of a home indicator. (The pill is not built
	// at all on a touch-only client — see the class doc — so that corner is only ever shared with the column.)
	pill.Position = new UDim2(0, EDGE_X, 1, -EDGE_Y);

	// **The rounded outline, made the way the rest of this HUD makes one** — a `UICorner` plus a `UIStroke`,
	// rather than a `Frame`'s own border, which cannot be rounded. **The two numbers come from the theme now**, so
	// this pill and the panel a kill cam puts up are outlined by the same gold at the same weight and the same
	// corner as every other in-game surface.
	const corner = new Instance("UICorner");
	corner.CornerRadius = new UDim(0, PREMIUM.corner);
	corner.Parent = pill;

	// **The neon edge**, from `ui/glow.ts`: the pill's hairline is the core and the bloom sits behind it. The armed
	// state recolours the *fill* only, so the light around the pill stays the theme's cyan whatever it is saying.
	applyGlow(pill);

	const padding = new Instance("UIPadding");
	padding.PaddingLeft = new UDim(0, 12);
	padding.PaddingRight = new UDim(0, 8);
	padding.PaddingTop = new UDim(0, 8);
	padding.PaddingBottom = new UDim(0, 8);
	padding.Parent = pill;

	const layout = new Instance("UIListLayout");
	layout.FillDirection = Enum.FillDirection.Horizontal;
	layout.VerticalAlignment = Enum.VerticalAlignment.Center;
	layout.Padding = new UDim(0, 10);
	layout.SortOrder = Enum.SortOrder.LayoutOrder;
	layout.Parent = pill;

	const words = new Instance("TextLabel");
	words.Name = "Prompt";
	words.AutomaticSize = Enum.AutomaticSize.X;
	words.BackgroundTransparency = 1;
	words.Font = Enum.Font.GothamMedium;
	words.Text = "Return to Lobby";
	words.TextColor3 = PREMIUM.text;
	// **The direction's text alpha**, which is safe now that the pill's plum is solid — see `PREMIUM.textTransparency`.
	words.TextTransparency = PREMIUM.textTransparency;
	words.TextSize = 14;
	words.LayoutOrder = 1;
	words.Parent = pill;

	// **The key box, and it stays put when the words change.** Its whole job is to say which key got you here,
	// so replacing it when the prompt arms would hide the answer at the moment the player needs it.
	//
	// **A solid cyan face with near-black ink**, which is this palette's one "physical" surface: every panel around it
	// is near-black glass with a cyan bloom, so this box inverts the pair and the letter reads as a *keycap* rather
	// than as one more label — and it is the only opaque thing in the pill, which is what makes the eye find the key
	// before it finds the sentence.
	const box = new Instance("Frame");
	box.Name = "Key";
	box.AutomaticSize = Enum.AutomaticSize.XY;
	box.BackgroundColor3 = PREMIUM.gold;
	box.BackgroundTransparency = 0;
	box.BorderSizePixel = 0;
	box.LayoutOrder = 2;
	box.Parent = pill;

	const boxCorner = new Instance("UICorner");
	boxCorner.CornerRadius = new UDim(0, PREMIUM.corner);
	boxCorner.Parent = box;

	const boxPadding = new Instance("UIPadding");
	boxPadding.PaddingLeft = new UDim(0, 6);
	boxPadding.PaddingRight = new UDim(0, 6);
	boxPadding.PaddingTop = new UDim(0, 2);
	boxPadding.PaddingBottom = new UDim(0, 2);
	boxPadding.Parent = box;

	// **Both axes, and the `Y` is the fix rather than a tidy-up.** This label used to auto-size in `X` alone, which
	// leaves its height at the `TextLabel` default of **zero** — so the box measured `0 + padding` and stood about
	// four pixels tall while the thirteen-pixel glyph was drawn straight through it. That is the "the L is not
	// contained in its box" report, and it is why the caption is sized `XY`: the box then hugs the letter's own line
	// height, which is the only number that knows how tall the letter is.
	const key = new Instance("TextLabel");
	key.AutomaticSize = Enum.AutomaticSize.XY;
	key.BackgroundTransparency = 1;
	key.Font = Enum.Font.GothamBold;
	key.Text = "L";
	key.TextColor3 = PREMIUM.onGold;
	// **The same alpha as the sentence beside it**, which is now zero on this palette: the keycap's ink is fully
	// opaque and so is the card's. The two are one treatment in the sense that matters — a label on this HUD is
	// drawn at `PREMIUM.textTransparency`, whatever that number is — rather than two numbers maintained by hand.
	key.TextTransparency = PREMIUM.textTransparency;
	key.TextSize = 13;
	key.Parent = box;

	frame = pill;
	label = words;
}

/** Whether the pill should be on screen: a round being played, and this player still in it. */
function visible(): boolean {
	const folder = ReplicatedStorage.FindFirstChild(ROUND_STATUS_FOLDER);
	const state = folder?.GetAttribute(ROUND_STATE_ATTRIBUTE);

	if (state !== PLAYING) return false;

	// **The membership fact, and not the side.** A player who surrendered or was eliminated keeps their
	// `TEAM_ATTRIBUTE` until the next whistle, so that one answers "was I on a side" — see the doc above.
	return Players.LocalPlayer.GetAttribute(IN_ROUND_ATTRIBUTE) === true;
}

/** Puts the pill up or down, and disarms it when it goes — a prompt that is not on screen is not armed. */
function refresh(): void {
	const show = visible();

	if (frame !== undefined) frame.Visible = show;

	if (!show && armed) disarm();
}

/** One press: arm, or — already armed — leave. */
function press(): void {
	if (armed) {
		disarm();

		events.Client.Get("surrender").SendToServer();

		// **And the pill goes at once, rather than when the server's answer arrives.** The request is not the
		// fact — the round clears `IN_ROUND_ATTRIBUTE` once the cover has closed, a second later — and a key
		// that appears to do nothing for that second invites a second press. Nothing is assumed by hiding it:
		// every subscription above re-reads `visible()`, so a request the server refuses (a round that ended
		// between the press and the handler) puts the pill back on the next state change.
		if (frame !== undefined) frame.Visible = false;

		logDebug("[Surrender] left the round — a rig takes the seat");

		return;
	}

	armed = true;

	if (label !== undefined) label.Text = "Are you sure?";
	// **The armed state is the palette's crimson**, which is the side colour this theme already spends on "red" —
	// so a prompt that is about to end a round is painted in the loudest colour the HUD owns rather than in a
	// second dark red invented for it. The gold hairline, the corner and the white words are untouched: the pill
	// changes what it *says* by changing its surface, not by becoming a different shape.
	if (frame !== undefined) frame.BackgroundColor3 = PREMIUM.sideA;

	logDebug("[Surrender] armed — any other key cancels");
}

/** Back to the idle state: on the cancel, on a second press, and when the pill goes away. */
function disarm(): void {
	armed = false;

	if (label !== undefined) label.Text = "Return to Lobby";
	if (frame !== undefined) frame.BackgroundColor3 = PREMIUM.panel;
}
