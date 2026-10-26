import { Button, Text } from "@rbxts/big-ui";
import Fusion from "@rbxts/fusion-3.0";
import { SHOP_CONFIG } from "shared/config/shop.config";
import { addElevation } from "./elevation";
import type { HudTheme } from "./hudTheme";
import { raiseZIndex } from "./panelChrome";

/**
 * **How much of the screen a modal's backdrop hides, as `BackgroundTransparency` — `0.45`.**
 *
 * The value has one job and two failure modes, so it is worth a number rather than a taste. Too opaque and the panel
 * underneath stops being readable, which makes the dialog read as a *new page* rather than as a question about the page
 * behind it — the player loses the item they are deciding about. Too transparent and the shop still looks live, and a
 * dim that nobody notices is a dim that does not say "this is blocked".
 *
 * **Placeholder.**
 */
const BACKDROP_TRANSPARENCY = 0.45;

/**
 * **The modal's width, as a fraction of the screen — `0.3`.**
 *
 * **Scale rather than pixels, because a dialog is one line of text and two buttons**, and the project's UI standard
 * (§9) is that a box with no fixed content should size itself to the viewport rather than to a hand-computed number.
 * Three tenths of a phone's width is still wide enough for "Open a Power Chest for 50 coins?" on one line at the
 * `body2` size, and on an ultrawide it stops being a banner.
 *
 * **`AutomaticSize.Y` does the height**, so the box is as tall as the words in it and no height constant exists to keep
 * in step with a sentence that changes.
 *
 * **Placeholder.**
 */
const DIALOG_WIDTH_SCALE = 0.3;

/**
 * **One dialog, reused, over the whole screen — "are you sure?", and two buttons.**
 *
 * ## Why a module rather than a controller, and why not `addPanelFrame`
 *
 * A controller would be a lifecycle for a thing with no lifecycle: the modal is built once, lives as long as the shop
 * does, and does one thing. So it is a factory, made by whoever owns the action it is asking about, exactly as
 * `panelChrome`'s builders are.
 *
 * **`addPanelFrame` was considered and is the wrong tool**, and the reason is its size. It hardcodes
 * `SHOP_CONFIG.PANEL_SIZE` — 62 % by 72 % of the screen — because it exists to be *the* panel; a confirmation dialog at
 * two thirds of the screen would look like a second shop rather than like a question. What is reused from it is
 * everything that is not the size: `addElevation` for the sheet's shadow, `raiseZIndex` for the layering, and the same
 * theme, so the dialog is unmistakably a sibling of the panel it sits over.
 *
 * ## The layering, which is the part that has bitten this project before
 *
 * **`raiseZIndex(overlay, z)` is called once, after the tree is built, and it is not optional.** Roblox compares
 * `ZIndex` flattened across the `ScreenGui`, and **a child below its parent's number draws *behind* it** — so raising
 * the overlay to a high `z` without raising its descendants paints its own opaque dialog *underneath* the panels that
 * were already at `PANEL_Z_INDEX`. That is precisely the bug §15 item 63 records for the stats board's rows, one
 * generation on: an element built into a raised tree has to carry the same number.
 *
 * **Nothing in this dialog is created after `raiseZIndex` runs**, which is what keeps that call sufficient rather than a
 * one-off. The title and the message are `Text` labels whose *text* changes reactively and whose instances never do; the
 * two buttons are built here. A future element built on a click would have to be given the number itself — see item 63.
 *
 * **The overlay is a sibling of the shop in `HudGui`, not a child of it**, so it can cover the panel's full extent
 * rather than being clipped to it, and so `ClipsDescendants` on the shop's content band cannot eat it.
 *
 * ## Clicking outside cancels, and clicking the dialog does not
 *
 * The backdrop is a full-screen `TextButton` — a button rather than a frame, because only a `GuiButton` *consumes* input
 * and a frame would let the click fall through to the shop's tiles underneath while the player believes the dialog is
 * blocking them.
 *
 * **The dialog itself is a `TextButton` for the same reason, with no action attached.** A `Frame` does not consume input
 * either, so a click on the dialog's own face would reach the backdrop behind it and cancel the question the player was
 * in the middle of reading. `AutoButtonColor = false` keeps it looking like a sheet rather than a giant button.
 */
export interface ConfirmModal {
	/**
	 * Puts the dialog on screen asking `message`, and arms `onConfirm` for the Confirm button.
	 *
	 * **A callback rather than a stored action**, because the two callers in the shop already hold their payloads — a
	 * chest request has none and a cosmetic has a `CosmeticDef` — and a modal that modelled those two shapes would be a
	 * second copy of the shop's own idea of what can be bought. It closes over what it needs, and this stays a dialog.
	 */
	ask(message: string, onConfirm: () => void): void;

	/** Takes the dialog off screen and forgets the armed callback. */
	hide(): void;
}

/**
 * Builds one, mounted into `into` at `zIndex`.
 *
 * **`zIndex` is a parameter rather than a constant here** so the caller owns the ladder it is joining: the shop passes
 * something above `PANEL_Z_INDEX`, and a future caller over a different panel passes that panel's number plus one
 * rung.
 */
export function createConfirmModal(
	scope: Fusion.Scope<unknown>,
	theme: HudTheme,
	into: Instance,
	zIndex: number,
): ConfirmModal {
	/** Whether the dialog is up. Its only reader is the `Visible` below — the state lives here, not in a boolean. */
	const shown = Fusion.Value(scope, false);

	/**
	 * The sentence under the title: *what* is about to be bought, in the shop's own words.
	 *
	 * **A separate line from the title rather than the title itself, and it is what makes the question answerable.** "Are
	 * you sure?" is the same question for a 50-coin chest and a 250-coin trail, and a player reading it has to remember
	 * which button they pressed. This line names the thing and its price, so the answer is a decision rather than a
	 * memory test.
	 */
	const message = Fusion.Value(scope, "");

	/**
	 * **The armed confirmation — `undefined` while the dialog is up and unconfirmed.**
	 *
	 * A plain field rather than a `Fusion.Value`, deliberately: nothing draws it, so a reactive wrapper would be a signal
	 * with no subscriber. What reads it is the Confirm button's own handler, on the frame it is pressed.
	 */
	let armed: (() => void) | undefined;

	/**
	 * **Whether a confirmation has already been taken, which is the double-click latch.**
	 *
	 * **Fed to big-ui's `loading` prop, which blocks activations and hides the label.** That is the honest use of an
	 * option the library already has: a `disabled` decided at construction could never react, and a plain boolean here
	 * would let two presses land before the modal's `Visible` write took effect on the same frame. It is cleared in
	 * {@link ConfirmModal.ask} rather than on close, so the next question is always answerable — the answer to "when does
	 * this re-arm" is "when there is a new question", not "sometime after a reply that may never arrive".
	 */
	const busy = Fusion.Value(scope, false);

	// ---------- the overlay ----------

	const overlay = Fusion.New(scope, "Frame")({
		Name: "ConfirmModal",
		Parent: into,
		// Full screen, and scaled rather than offset because the size of the screen is not this file's business.
		Size: UDim2.fromScale(1, 1),
		Position: UDim2.fromScale(0, 0),
		BorderSizePixel: 0,
		// The dim itself, on the overlay rather than on the backdrop button so there is one surface rather than two.
		BackgroundColor3: theme.colors.shadow,
		BackgroundTransparency: BACKDROP_TRANSPARENCY,
		Visible: shown,
		ZIndex: zIndex,
	});

	/**
	 * **The backdrop, and the click that cancels.**
	 *
	 * Transparent rather than the dim, because the overlay already carries it — two translucent surfaces stack into a
	 * darker rectangle than either was chosen for.
	 */
	const backdrop = Fusion.New(scope, "TextButton")({
		Name: "Backdrop",
		Parent: overlay,
		Size: UDim2.fromScale(1, 1),
		Text: "",
		BackgroundTransparency: 1,
		AutoButtonColor: false,
		ZIndex: zIndex,
	});

	// ---------- the dialog ----------

	const dialog = Fusion.New(scope, "TextButton")({
		Name: "Dialog",
		Parent: overlay,
		Size: new UDim2(DIALOG_WIDTH_SCALE, 0, 0, 0),
		AutomaticSize: Enum.AutomaticSize.Y,
		AnchorPoint: new Vector2(0.5, 0.5),
		Position: UDim2.fromScale(0.5, 0.5),
		Text: "",
		AutoButtonColor: false,
		BackgroundColor3: theme.colors.panel,
		BackgroundTransparency: 0,
		BorderSizePixel: 0,
		ZIndex: zIndex,
	});

	Fusion.New(scope, "UICorner")({ Parent: dialog, CornerRadius: new UDim(0, 12) });
	Fusion.New(scope, "UIStroke")({
		Parent: dialog,
		Color: theme.colors.border,
		Thickness: 1,
		ApplyStrokeMode: Enum.ApplyStrokeMode.Border,
	});
	addElevation(scope, dialog, theme, "PANEL");

	// **A vertical list, so nothing in this file adds up a height.** The padding is the panel's own scale inset for the
	// same reason `panelChrome` uses it: it tracks the box's width on a phone without a second number.
	Fusion.New(scope, "UIListLayout")({
		Parent: dialog,
		FillDirection: Enum.FillDirection.Vertical,
		HorizontalAlignment: Enum.HorizontalAlignment.Center,
		SortOrder: Enum.SortOrder.LayoutOrder,
		Padding: new UDim(0, SHOP_CONFIG.HEADER_GAP),
	});
	Fusion.New(scope, "UIPadding")({
		Parent: dialog,
		PaddingTop: new UDim(0, SHOP_CONFIG.PAD_Y * 2),
		PaddingBottom: new UDim(0, SHOP_CONFIG.PAD_Y * 2),
		PaddingLeft: new UDim(SHOP_CONFIG.PAD_X, 0),
		PaddingRight: new UDim(SHOP_CONFIG.PAD_X, 0),
	});

	const title = Text(scope, { text: "Are you sure?", variant: "h6", wrap: false, layoutOrder: 1 });
	title.TextColor3 = theme.colors.textPrimary;
	title.Size = UDim2.fromScale(1, 0);
	title.AutomaticSize = Enum.AutomaticSize.Y;
	title.Parent = dialog;

	const detail = Text(scope, { text: message, variant: "body2", wrap: true, layoutOrder: 2 });
	detail.TextColor3 = theme.colors.textSecondary;
	detail.Size = UDim2.fromScale(1, 0);
	detail.AutomaticSize = Enum.AutomaticSize.Y;
	detail.Parent = dialog;

	/**
	 * The two buttons, side by side — **Confirm in the theme's success green, Cancel in its error red.**
	 *
	 * **Confirm is green because the palette already says so**: `lightPanelTheme` carries `success` for exactly this
	 * (the shop uses it for a won item and an owned tile) and `error` for exactly the other (`addHeaderBand` paints the
	 * close button with it). A player's two answers are "spend" and "do not spend", which is the success/error pair
	 * rather than the accent blue — and blue is already the panel's *selected* state, so a blue Confirm would read as
	 * "this tab is open".
	 */
	const row = Fusion.New(scope, "Frame")({
		Name: "Buttons",
		Parent: dialog,
		Size: new UDim2(1, 0, 0, 0),
		AutomaticSize: Enum.AutomaticSize.Y,
		BackgroundTransparency: 1,
		LayoutOrder: 3,
	});
	Fusion.New(scope, "UIListLayout")({
		Parent: row,
		FillDirection: Enum.FillDirection.Horizontal,
		HorizontalAlignment: Enum.HorizontalAlignment.Center,
		SortOrder: Enum.SortOrder.LayoutOrder,
		Padding: new UDim(0, SHOP_CONFIG.HEADER_GAP),
	});

	const confirm = Button(scope, {
		label: "Confirm",
		variant: "contained",
		color: "success",
		size: "medium",
		layoutOrder: 1,
		// **`loading` rather than `disabled`, and it is the double-click latch.** Big-ui documents this prop as
		// showing a spinner *and blocking activations*, which is exactly the behaviour wanted while a request is
		// outstanding — and unlike `disabled` it is a `UsedAs<boolean>`, so it can react.
		loading: busy,
		onActivate: () => {
			// **Read once, then cleared**, so a second activation in the same frame cannot run the same purchase twice
			// even if it somehow arrives before `busy` changes anything. The latch is set *before* the action runs, so
			// the button is inert for the whole of the send.
			const action = armed;
			armed = undefined;
			busy.set(true);

			shown.set(false);

			action?.();
		},
	});
	confirm.Parent = row;

	const cancel = Button(scope, {
		label: "Cancel",
		variant: "contained",
		color: "error",
		size: "medium",
		layoutOrder: 2,
		onActivate: () => {
			armed = undefined;
			shown.set(false);
		},
	});
	cancel.Parent = row;

	// **Both buttons repainted from the theme, on `addHeaderBand`'s terms** — big-ui resolves a `PaletteColor`
	// against *its own* palette, which this project no longer draws with, so without these three writes a light panel
	// would wear two buttons in big-ui's default colours. The structure relied on is the same three the header's close
	// button relies on: the button is the surface, its label is a `TextLabel` descendant, and the ink on a filled
	// surface is `onAccent`.
	//
	// **One helper called twice rather than a loop over a table of pairs**, because a heterogeneous array of
	// `[button, colour]` tuples is the kind of thing `rbxtsc` reads differently from TypeScript and it is not worth
	// finding out in a build.
	const paint = (button: TextButton, fill: Color3): void => {
		button.BackgroundColor3 = fill;
		button.BackgroundTransparency = 0;
		button.TextColor3 = theme.colors.onAccent;
		button.TextTransparency = 0;

		for (const descendant of button.GetDescendants()) {
			if (!descendant.IsA("TextLabel")) continue;

			descendant.TextColor3 = theme.colors.onAccent;
			descendant.TextTransparency = 0;
		}
	};

	paint(confirm, theme.colors.success);
	paint(cancel, theme.colors.error);

	// **After the tree, and the whole point of doing it here** — see this file's header. Every descendant carries the
	// overlay's number, so the dialog's own children sit above the dialog by hierarchy rather than by a bigger number.
	raiseZIndex(overlay, zIndex);

	backdrop.Activated.Connect(() => {
		armed = undefined;
		shown.set(false);
	});

	return {
		ask(question: string, onConfirm: () => void) {
			// **Armed before shown**, so the frame that draws the dialog is not a frame where Confirm does nothing.
			armed = onConfirm;
			busy.set(false);
			message.set(question);
			shown.set(true);
		},

		hide() {
			armed = undefined;
			shown.set(false);
		},
	};
}
