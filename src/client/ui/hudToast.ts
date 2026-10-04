import { Alert } from "@rbxts/big-ui";
import type { AlertSeverity } from "@rbxts/big-ui";
import Fusion from "@rbxts/fusion-3.0";
import { getHudScreenGui } from "./screenGui";
import { addViewportConstraint } from "./viewportConstraint";

/**
 * The bottom-centre toast column: how wide a toast is, where a slot in the column sits, and how to
 * build one.
 *
 * **One owner for the numbers two toasts have to agree on.** The throw toast and the camera toast both
 * put an `Alert` in the same column, and the second one's whole placement is "above the first" — so
 * the width, the gap from the screen edge and the height of a toast are facts about the *column*
 * rather than about either toast. Kept here so that changing the width moves both, which is the same
 * argument `screenGui.ts` makes for the `ScreenGui` both of them hang from.
 */

/** The toast's width. `Alert` is built at scale-1 width, so this is the width of its wrapper. */
export const TOAST_WIDTH = 320;

/**
 * How far the bottom toast's wrapper sits above the bottom of the screen.
 *
 * Measured against the two things already down there rather than guessed at. The spectator label
 * is anchored `(0.5, 1)` at a 12px inset and is about 21px tall, so it occupies y∈[687, 708] on a
 * 720px screen; the tallest a toast gets is {@link TOAST_HEIGHT}, about 61px, so at this offset the
 * bottom toast occupies y∈[579, 640]. That is 47px of clear air between them — needed, because the
 * assumption that they cannot co-occur is **false**: the spectator label shows while `Spectating` is
 * true and the throw toast shows while `ThrowEnabled` is false, and a player who is out of the round
 * with throwing switched off is both at once.
 *
 * Sideways it is clear too: at 1280px a toast spans x∈[480, 800], while the cooldown bars are pinned
 * to the bottom-*left* (anchor `(0, 1)`, 12px in, ~144px wide) and reach nowhere near it.
 */
export const TOAST_BOTTOM_OFFSET = 10;

/**
 * The tallest a toast gets, in pixels: one title line, one message line, and the alert's own padding.
 *
 * **A measurement rather than a setting**, and the one number here that is a fact about big-ui's type
 * scale rather than about this game — a toast that grew a third line would make this number wrong
 * rather than make anything break. It is what makes the stack work: a toast in the slot above sits
 * clear of one below it whatever the two of them say, which is the property the camera toast leans on
 * when throwing is switched off and the camera is unlocked at the same moment.
 */
export const TOAST_HEIGHT = 61;

/** The clear air between two stacked toasts, in pixels. */
export const TOAST_GAP = 8;

/**
 * Where the wrapper for `slot` sits above the bottom of the screen.
 *
 * Slot `0` is the bottom of the column and slot `1` sits directly above it. **A toast that can be up
 * at the same time as another takes a slot of its own rather than sharing one** — two toasts in the
 * same slot are two toasts drawn on top of each other, which reads as one toast with garbled text
 * rather than as two things happening at once. Toasts that can never both be up (the throw warning and
 * the throw confirmation) deliberately share a slot, which is why this is numbered rather than named.
 */
export function toastOffset(slot: number): number {
	return TOAST_BOTTOM_OFFSET + slot * (TOAST_HEIGHT + TOAST_GAP);
}

/** Everything one toast needs: what it says, and where in the column it belongs. */
export interface ToastOptions {
	/** The wrapper's name, which is also the base of the alert's own name. */
	name: string;
	title: string;
	message: string;
	severity: AlertSeverity;
	/** Whether this toast is on screen. A `UsedAs`, so a `Value` or a `Computed` can drive it. */
	visible: Fusion.UsedAs<boolean>;
	/** Which slot of the column, counted from the bottom. See {@link toastOffset}. */
	slot: number;
}

/**
 * One toast: a fixed-width wrapper holding an `Alert`, both children of the shared `ScreenGui`.
 *
 * The wrapper is not decoration. `Alert` builds its root at `Size = UDim2.new(1, 0, 0, 0)` — a
 * full-width frame, on the assumption it is being put inside something that knows how wide it
 * should be — so without a parent of a fixed width there is nothing for that `1` to be a fraction
 * *of*, and the alert would span the screen. The wrapper is that width, and it is also what carries
 * the placement, so the alert is left alone to be an alert.
 *
 * `Visible` is passed in rather than assigned afterwards, because a graph object has to be part
 * of the props a `New` is given to be tracked as a property — assigning one onto an instance
 * that already exists is the shape that silently does nothing.
 */
export function mountToast(scope: Fusion.Scope<unknown>, options: ToastOptions): void {
	const wrapper = Fusion.New(scope, "Frame")({
		Name: options.name,
		Size: new UDim2(0, TOAST_WIDTH, 0, 0),
		AutomaticSize: Enum.AutomaticSize.Y,
		Position: new UDim2(0.5, 0, 1, -toastOffset(options.slot)),
		AnchorPoint: new Vector2(0.5, 1),
		BackgroundTransparency: 1,
		Visible: options.visible,
	});

	// The wrapper is already the toast's fixed width; this is the bound that stops that width
	// from exceeding the screen. It matters most here, because `TOAST_WIDTH` is the one number in
	// the HUD that has to be fixed: the `Alert` inside is built at scale-1 width and needs a
	// parent that knows how wide it is (see above), so the width cannot be made proportional and
	// a cap is the only way to let it adapt.
	addViewportConstraint(scope, wrapper);

	const alert = Alert(scope, { severity: options.severity, title: options.title, message: options.message });
	// `Alert` names its root "Alert", and two of those in the Explorer say nothing about which
	// is which — the same reason the containers elsewhere are renamed off their component name.
	alert.Name = `${options.name}Body`;
	alert.Parent = wrapper;

	// The shared GUI, never a second one: the settings that belong to the screen rather than to
	// any one HUD — `ResetOnSpawn` above all — are decided in one place, and every toast
	// inherits them. Nothing here has to know that respawning happens, and nothing here is
	// per-character, so it survives a respawn by never having been attached to one.
	wrapper.Parent = getHudScreenGui();
}
