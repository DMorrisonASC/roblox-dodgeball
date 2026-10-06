import Fusion from "@rbxts/fusion-3.0";

/**
 * Which of the modals is open, and what phase the round is in — the two facts a dock button and a
 * panel have to agree on.
 *
 * **A module rather than a wire between controllers.** The dock's buttons open the panels and the
 * panels read whether they are open, so if either held the other there would be a construction-order
 * dependency between two controllers — which is precisely what `aiming.ts` argues against at length,
 * and the same shape `client/ui/screenGui.ts` uses so that two HUDs can share one `ScreenGui` without
 * either of them owning it. Here it is three controllers and two values, so the state lives in
 * nobody's file.
 *
 * **`roundPhase` is written by `DockController` and read by both panels**, which is one writer and
 * two readers rather than three connections to the same attribute. The dock owns it because the dock
 * is the thing the phase *defines* — it exists only during an intermission — so the connection that
 * watches the phase lives with the only reason to watch it.
 *
 * **The two `open` values are separate rather than one "current panel"**, even though exactly one can
 * be open at a time. A single value would have to name a panel with a string, and every reader would
 * then be doing a comparison to answer a boolean question; two booleans and one rule about them is
 * less machinery than one string and a rule at every call site.
 */
const scope = Fusion.scoped();

/** Both panels are intermission-only, and this is the string the server publishes for it. */
export const INTERMISSION = "Intermission";

/**
 * The phase the server last published, seeded to `Intermission`.
 *
 * **Seeded to the *permissive* value deliberately.** A client that has not yet heard from the server
 * is treated as being between rounds: the dock appears a frame early at worst, where seeding to
 * `Playing` would hide the dock for a whole replication after a round ended — a button that is
 * missing when a player looks for it is a worse failure than one that lingers for a frame.
 */
export const roundPhase = Fusion.Value(scope, INTERMISSION);

/** Whether the shop panel is showing. */
export const shopOpen = Fusion.Value(scope, false);

/** Whether the inventory panel is showing. */
export const inventoryOpen = Fusion.Value(scope, false);

/** The two panels a dock button can open. */
export type PanelName = "shop" | "inventory";

/**
 * Opens a panel, or closes it if it is the one already open.
 *
 * **Opening one closes the other, and that is geometry rather than taste.** Both panels are the same
 * size and in the same place — `PANEL_SIZE` at `PANEL_Z_INDEX`, centred — so two of them open at once
 * would not be two windows, it would be one window showing whichever happened to be on top, with the
 * other invisible behind it and no way to tell which button owned what. An exclusive toggle is the
 * only behaviour that makes both buttons honest.
 *
 * The close is written **only on the way in**, never on the way out: closing the shop must not close
 * anything else, or a player dismissing one panel would find a second one had gone with it.
 */
export function togglePanel(which: PanelName): void {
	// Named `opening` and not `next`, which roblox-ts refuses outright: "Cannot use identifier reserved
	// for compiler internal usage." `next` is a Lua global — the table-iteration function — and the
	// compiler protects it the same way it protects `until` and `type`, because a local shadowing one
	// would change what the emitted Luau means. The name is not the point here; the value is.
	if (which === "shop") {
		const opening = !Fusion.peek(shopOpen);
		shopOpen.set(opening);
		if (opening) inventoryOpen.set(false);
		return;
	}

	const opening = !Fusion.peek(inventoryOpen);
	inventoryOpen.set(opening);
	if (opening) shopOpen.set(false);
}
