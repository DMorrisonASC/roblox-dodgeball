import { TweenService } from "@rbxts/services";
import { placeAbove } from "./ui/aboveStack";
import { applyTextGlow } from "./ui/glow";
import { PREMIUM, premiumHudTheme } from "./ui/premiumTheme";
import { getHudScreenGui } from "./ui/screenGui";

/**
 * **The HUD's one-line messages: a short sentence that appears above the power column and takes itself away.**
 *
 * **A plain module rather than a Flamework controller**, which is `afk`, `hitVfx`, `returnToLobby` and `killCam`'s
 * shape and their reason: it owns no lifecycle, injects nothing, and exposes a single function. **A class would be
 * recorded in `flamework.build` for nothing** — Flamework's transformer lists every exported class it sees, decorated
 * or not — and "one line of text appeared" needs no boot of its own: the first caller pays for the frame, and a client
 * that never pushes a notification never makes one.
 *
 * **It is built lazily for that reason.** Nothing mounts at boot, so there is no invisible frame sitting in the HUD of
 * every client that never toggles the camera, and no second thing to keep in step with the column it sits above.
 *
 * **Where it sits is the column's business, and this file only says how far away.** `placeAbove` reads `SuperHud`'s
 * own geometry, so the stack is the last thing after the power readouts and cannot be knocked out of place by an
 * `AutomaticSize` change under it. **The AFK prompt shares that edge** (`client/afk.ts`, same helper, same gap) and the
 * two cannot be on screen together: a notification is pushed by a key press, a press is input, and input cancels the
 * AFK countdown — so the card needs fifteen seconds of *nothing* to appear, and this stack is gone in three.
 *
 * **Newest nearest the column.** The stack is bottom-anchored and sized to its children, so a push grows it upward:
 * the new toast takes the bottom place and everything above it moves up one step. `LayoutOrder` ascending is what puts
 * the newest last, and it is also the order {@link MAX_VISIBLE} trims from the other end.
 *
 * **Everything a toast does is a fade, and there is no slide.** A `UIListLayout` owns its children's `Position`, so a
 * slide would be a number written over the layout's own and clamped back on the next pass — the fade is the one
 * property an animation can hold. It is two tweens, the letters and the halo `applyTextGlow` puts round them, brought
 * to their resting values together so the toast arrives as one thing rather than as text inside a glow.
 */

/** The stack's name in the HUD GUI. Only this file reads it. */
const STACK_NAME = "NotificationStack";

/**
 * How wide one toast is, in pixels — **a definite width rather than `AutomaticSize.X`, because the text has to
 * wrap.** A label that grows sideways to fit its sentence would run off a phone screen at the first long message.
 */
const TOAST_WIDTH = 300;

/** The gap between two toasts, in pixels. */
const TOAST_GAP = 4;

/** **How many toasts may be up at once.** The fourth push destroys the oldest rather than growing the stack. */
const MAX_VISIBLE = 3;

/** How long a toast is readable before it starts to go, in seconds. */
const HOLD_SECONDS = 3;

/** How long the fade in and the fade out each take, in seconds. */
const FADE_SECONDS = 0.25;

/** **The stack's rung**, one above the AFK prompt's `10` — see that file's `CARD_Z_INDEX` for the ladder. */
const STACK_Z_INDEX = 11;

/** The gap between the stack's bottom edge and the top of the power column, in pixels. */
const STACK_BOTTOM_GAP = 8;

/**
 * **Where the stack starts before the column exists**, in pixels from the bottom of the HUD region.
 *
 * A fallback and only a fallback: `placeAbove` writes the real position the moment it finds `SuperHud`, and a client
 * whose column mounts later is re-placed by that helper's `ChildAdded` retry. The number is clear of the column's
 * usual height so a notification shown in that window does not sit on the readouts.
 */
const FALLBACK_BOTTOM = 120;

/** One toast: the letters, the halo round them, and the glow's own resting transparency to fade back to. */
interface Toast {
	label: TextLabel;
	glow: UIStroke;
	glowTransparency: number;
}

/** The stack frame, once the first notification has needed it. */
let stack: Frame | undefined;

/** The toasts currently up, oldest first — which is the order {@link MAX_VISIBLE} trims. */
const showing = new Array<Toast>();

/** The next `LayoutOrder`, so a push always lands below the toasts already up. */
let nextOrder = 1;

/**
 * **Pushes one message onto the stack.** The whole API: text in, a toast appears, and three seconds later it takes
 * itself away.
 *
 * **Called by whoever has something to say, and it decides nothing for them.** There is no queue, no priority and no
 * dedupe: a caller that pushes the same sentence twice gets two toasts, because "the camera was unlocked" is a thing
 * that can happen twice and the player's evidence for it is two separate arrivals.
 */
export function pushNotification(text: string): void {
	const frame = ensureStack();
	if (frame === undefined) return;

	const caption = premiumHudTheme().typography.caption;

	const label = new Instance("TextLabel");
	label.Name = "Notification";
	label.AutomaticSize = Enum.AutomaticSize.Y;
	label.BackgroundTransparency = 1;
	label.Font = caption.font;
	label.Size = UDim2.fromOffset(TOAST_WIDTH, 0);
	label.Text = text;
	label.TextColor3 = PREMIUM.text;
	// **Starting invisible**, because the first tween is the fade in; a label built at rest would be a flicker of solid
	// text for one frame before the tween's first step.
	label.TextTransparency = 1;
	label.TextSize = caption.size;
	label.TextWrapped = true;
	label.TextXAlignment = Enum.TextXAlignment.Center;
	label.LayoutOrder = nextOrder;
	label.ZIndex = STACK_Z_INDEX;
	nextOrder += 1;
	label.Parent = frame;

	// **The halo is what makes one line of text readable over an arena**, and it is faded with the letters rather than
	// left to arrive: `applyTextGlow` returns the stroke for exactly this. Its resting transparency is read back
	// rather than guessed, so this file does not own a second copy of the glow's strength.
	const glow = applyTextGlow(label);
	const glowTransparency = glow.Transparency;
	glow.Transparency = 1;

	const toast: Toast = { label, glow, glowTransparency };
	showing.push(toast);

	trim();

	fade(toast, 0, glowTransparency, FADE_SECONDS);

	task.delay(HOLD_SECONDS, () => retire(toast));
}

/**
 * **Drops the oldest toasts until there are {@link MAX_VISIBLE} left** — immediately, with no fade.
 *
 * The one thing an overflow may not do is queue: the point of the cap is that the stack never grows past the top of
 * the screen, so a toast that has to go goes at once rather than a fade later. Its own retirement timer still fires;
 * it finds a destroyed label and does nothing (see {@link retire}).
 */
function trim(): void {
	while (showing.size() > MAX_VISIBLE) {
		const oldest = showing[0];

		showing.remove(0);

		if (oldest.label.Parent !== undefined) oldest.label.Destroy();
	}
}

/** Fades a toast out and then destroys it, and is a no-op if it has already gone — see {@link trim}. */
function retire(toast: Toast): void {
	const index = showing.indexOf(toast);
	if (index >= 0) showing.remove(index);

	// **A destroyed label is the overflow case, not an error**: `trim` removed it early and there is nothing left to
	// fade. Reading `Parent` is the test rather than a flag, because the destroy could have come from either path.
	if (toast.label.Parent === undefined) return;

	// **The completion is the letters' tween**, which is also the one that carries the halo: `fade` starts both and
	// hands back the first, so the destroy happens when the thing the player is reading has finished going.
	const out = fade(toast, 1, 1, FADE_SECONDS);
	out.Completed.Connect(() => {
		if (toast.label.Parent !== undefined) toast.label.Destroy();
	});
}

/** The two-property fade: the letters and their halo, to the same place at the same moment. */
function fade(toast: Toast, textTo: number, glowTo: number, seconds: number): Tween {
	const letters = TweenService.Create(toast.label, new TweenInfo(seconds), { TextTransparency: textTo });
	TweenService.Create(toast.glow, new TweenInfo(seconds), { Transparency: glowTo }).Play();
	letters.Play();

	return letters;
}

/**
 * Builds the stack on first use, or answers the one already built.
 *
 * **A vertical list, bottom-anchored and sized to its children**, which is the whole of "it grows upward": the frame's
 * bottom edge is pinned by `placeAbove`, so every toast added makes the frame taller in the direction the screen has
 * room for. `VerticalAlignment = Bottom` is what the layout would do anyway while the frame has no slack; it is set so
 * that the intent survives the day somebody gives this frame a fixed height.
 *
 * **The stack is not painted and carries no `ZIndex` of its own for its children to lose to.** The frame's
 * `BackgroundTransparency` is `1`, and each label is given `STACK_Z_INDEX` explicitly rather than inheriting a rung —
 * the fault `afk.ts` records, where a container raised above its own labels is what draws over them.
 */
function ensureStack(): Frame | undefined {
	if (stack !== undefined) return stack;

	const gui = getHudScreenGui();

	const frame = new Instance("Frame");
	frame.Name = STACK_NAME;
	// **Bottom-anchored, so the fallback below and the column-derived position are both the same corner** — see
	// `placeAbove`, whose arithmetic depends on this and on the element being centred horizontally.
	frame.AnchorPoint = new Vector2(0.5, 1);
	frame.Position = new UDim2(0.5, 0, 1, -FALLBACK_BOTTOM);
	frame.Size = UDim2.fromOffset(0, 0);
	frame.AutomaticSize = Enum.AutomaticSize.XY;
	frame.BackgroundTransparency = 1;
	frame.BorderSizePixel = 0;
	frame.ZIndex = STACK_Z_INDEX;
	frame.Parent = gui;

	const layout = new Instance("UIListLayout");
	layout.FillDirection = Enum.FillDirection.Vertical;
	layout.HorizontalAlignment = Enum.HorizontalAlignment.Center;
	layout.VerticalAlignment = Enum.VerticalAlignment.Bottom;
	layout.SortOrder = Enum.SortOrder.LayoutOrder;
	layout.Padding = new UDim(0, TOAST_GAP);
	layout.Parent = frame;

	placeAbove(frame, gui, STACK_BOTTOM_GAP);

	stack = frame;

	return frame;
}
