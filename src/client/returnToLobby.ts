import { ContextActionService, Players, ReplicatedStorage, UserInputService } from "@rbxts/services";
import { IN_ROUND_ATTRIBUTE, ROUND_STATE_ATTRIBUTE, ROUND_STATUS_FOLDER } from "shared/constants";
import { events } from "shared/networking";
import { getHudScreenGui } from "./ui/screenGui";

/** Prints the mount line and one line per state change. */
const DEBUG = false;

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

/** The pill's colours, taken from the HUD's own dark-panel-and-light-label pair. */
const BACKGROUND = new Color3(0.11, 0.12, 0.15);
const BORDER = new Color3(0.33, 0.35, 0.42);
const LABEL = new Color3(0.93, 0.94, 0.97);
const ARMED_BACKGROUND = new Color3(0.35, 0.11, 0.13);

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
		if (DEBUG) print("[Surrender] prompt off — a touch-only client has no L key");

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

	if (DEBUG) print("[Surrender] prompt up — L once to arm, again to leave");
}

/** Builds the pill: a rounded frame, the words, and a box holding the key. */
function mount(): void {
	const gui = getHudScreenGui();

	const pill = new Instance("Frame");
	pill.Name = "ReturnToLobby";
	pill.AnchorPoint = new Vector2(0, 1);
	pill.AutomaticSize = Enum.AutomaticSize.XY;
	pill.BackgroundColor3 = BACKGROUND;
	pill.BackgroundTransparency = 0.1;
	pill.BorderSizePixel = 0;
	pill.Visible = false;
	pill.Parent = gui;

	// **Laid out from the corner rather than by a `Scale` fraction**, because a `Scale` position is a fraction
	// of the GUI's own area and the HUD GUI's origin is not the screen's — see `screenGui.ts` on insets. An
	// offset against a `(0, 1)` anchor is the bottom-left of the region the GUI actually occupies, which is the
	// corner a player means by "bottom left".
	pill.Position = UDim2.fromOffset(EDGE_X, gui.AbsoluteSize.Y - EDGE_Y);

	// **The rounded outline, made the way the rest of this HUD makes one** — a `UICorner` plus a `UIStroke`,
	// rather than a `Frame`'s own border, which cannot be rounded.
	const corner = new Instance("UICorner");
	corner.CornerRadius = new UDim(0, 8);
	corner.Parent = pill;

	const stroke = new Instance("UIStroke");
	stroke.Color = BORDER;
	stroke.Thickness = 1;
	stroke.Parent = pill;

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
	words.TextColor3 = LABEL;
	words.TextSize = 14;
	words.LayoutOrder = 1;
	words.Parent = pill;

	// **The key box, and it stays put when the words change.** Its whole job is to say which key got you here,
	// so replacing it when the prompt arms would hide the answer at the moment the player needs it.
	const box = new Instance("Frame");
	box.Name = "Key";
	box.AutomaticSize = Enum.AutomaticSize.XY;
	box.BackgroundColor3 = new Color3(0.22, 0.24, 0.3);
	box.BorderSizePixel = 0;
	box.LayoutOrder = 2;
	box.Parent = pill;

	const boxCorner = new Instance("UICorner");
	boxCorner.CornerRadius = new UDim(0, 5);
	boxCorner.Parent = box;

	const boxPadding = new Instance("UIPadding");
	boxPadding.PaddingLeft = new UDim(0, 6);
	boxPadding.PaddingRight = new UDim(0, 6);
	boxPadding.PaddingTop = new UDim(0, 2);
	boxPadding.PaddingBottom = new UDim(0, 2);
	boxPadding.Parent = box;

	const key = new Instance("TextLabel");
	key.AutomaticSize = Enum.AutomaticSize.X;
	key.BackgroundTransparency = 1;
	key.Font = Enum.Font.GothamBold;
	key.Text = "L";
	key.TextColor3 = LABEL;
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

		if (DEBUG) print("[Surrender] left the round — a rig takes the seat");

		return;
	}

	armed = true;

	if (label !== undefined) label.Text = "Are you sure?";
	if (frame !== undefined) frame.BackgroundColor3 = ARMED_BACKGROUND;

	if (DEBUG) print("[Surrender] armed — any other key cancels");
}

/** Back to the idle state: on the cancel, on a second press, and when the pill goes away. */
function disarm(): void {
	armed = false;

	if (label !== undefined) label.Text = "Return to Lobby";
	if (frame !== undefined) frame.BackgroundColor3 = BACKGROUND;
}
