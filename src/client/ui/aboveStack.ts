/**
 * **Sits a HUD element on the top edge of the power column, and keeps it there as the column changes size.**
 *
 * **One rule, two tenants, and neither of them owns the column.** `SuperHudController` builds the stack of readouts
 * at the bottom centre of the HUD and everything about it is its own business — it is `AutomaticSize`, its icon slot
 * grows when a uses-count appears beside it, and its height is therefore not a number anybody else can write down.
 * The two things that hang above it are the AFK prompt (`client/afk.ts`) and the notification stack
 * (`client/notifications.ts`), which are two unrelated features that happen to point at the same edge. This module is
 * where that edge is read, so both read it the same way and the arithmetic exists once.
 *
 * **The column's own geometry rather than a screen fraction**, and the arithmetic is exact because both frames are
 * anchored to the same corner of the same GUI: the stack is bottom-anchored, so its top edge is its own `Position`
 * minus its height, and the caller's element is bottom-anchored too — so the element's `Position` *is* that edge, less
 * the caller's gap. No inset conversion, no `AbsolutePosition` (which is screen space and not this GUI's), and nothing
 * to keep in step if the stack is moved. **The caller's `AnchorPoint` is therefore part of this function's contract:**
 * `(0.5, 1)`, so the element is horizontally centred on the column and grows upward away from it.
 *
 * **The stack's height is read, not assumed**, because it is `AutomaticSize` — a hard-coded clearance would put the
 * element through the icon on the round a player picked up a power. The `AbsoluteSize` follower below is that same
 * fact arriving later.
 *
 * **A missing column is not an error and leaves the caller's fallback standing** — i.e. whatever `Position` the caller
 * wrote when it built the element. `SuperHudController` and its tenants are all started from the boot and the order
 * between them is not this file's to decide, so the GUI's own `ChildAdded` is wired to try again: that covers a
 * column that appears after the first element did.
 *
 * **Every connection here is made once and never disconnected**, which is the licence `afk.ts` took for its own
 * three lines of this and is worth restating: a tenant is a HUD element that lives for the session, the column lives
 * for the session, and a scope to tear down would be state with nothing to tear down for.
 *
 * **The gap is the caller's**, because it is the only thing the two tenants disagree about: the AFK prompt and a
 * notification are different objects with different breathing room, and a shared constant would be one of them
 * choosing for the other.
 */

/** The frame `SuperHudController` names its column. A string between two files, spelled the same way. */
const STACK_NAME = "SuperHud";

/** An element that follows the column, and its own clearance above that column's top edge. */
interface Tenant {
	element: GuiObject;
	gap: number;
}

/**
 * **Every tenant, grouped by the GUI it lives in** — the grouping is the connection's, not ours: one `ChildAdded`
 * per GUI can re-place all of that GUI's tenants, so two elements above one column cost one subscription rather than
 * a listener each.
 */
const tenants = new Map<ScreenGui, Array<Tenant>>();

/** GUIs already wired for {@link placeAbove}'s retry, so a second tenant does not add a second listener. */
const watching = new Set<ScreenGui>();

/** Elements already wired to the column's `AbsoluteSize`, so repeated calls are free. */
const following = new Set<GuiObject>();

/**
 * Places `element` just above the power column, and wires it to stay there.
 *
 * Safe to call again on the same element — neither the follower nor the retry listener is made twice — and safe when
 * `element` has no parent, in which case the column cannot be found and nothing happens.
 */
export function placeAbove(element: GuiObject, gui: ScreenGui, gap: number): void {
	const tenant: Tenant = { element, gap };

	const existing = tenants.get(gui);
	if (existing === undefined) {
		tenants.set(gui, [tenant]);
	} else if (!existing.some((other) => other.element === element)) {
		existing.push(tenant);
	} else {
		// **A second call for an element already following moves it without re-registering it**, which is what makes
		// a caller free to place on every mount-time edge (the AFK prompt does, so the gap it arrives with is current).
		for (const other of existing) {
			if (other.element === element) other.gap = gap;
		}
	}

	if (!watching.has(gui)) {
		watching.add(gui);
		gui.ChildAdded.Connect(() => replaceIn(gui));
	}

	position(gui, tenant);
}

/** Re-places every tenant in one GUI — the retry after its contents change, and the column's own size follower. */
function replaceIn(gui: ScreenGui): void {
	const list = tenants.get(gui);
	if (list === undefined) return;

	for (const tenant of list) position(gui, tenant);
}

/** One placement: the caller's `Position` written from the column's top edge, then the follower that keeps it right. */
function position(gui: ScreenGui, tenant: Tenant): void {
	const stack = gui.FindFirstChild(STACK_NAME);
	if (stack === undefined || !stack.IsA("GuiObject")) return;

	tenant.element.Position = new UDim2(
		0.5,
		0,
		stack.Position.Y.Scale,
		stack.Position.Y.Offset - stack.AbsoluteSize.Y - tenant.gap,
	);

	if (following.has(tenant.element)) return;

	following.add(tenant.element);
	stack.GetPropertyChangedSignal("AbsoluteSize").Connect(() => replaceIn(gui));
}
