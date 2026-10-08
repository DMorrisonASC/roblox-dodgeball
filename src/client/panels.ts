import Fusion from "@rbxts/fusion-3.0";

/**
 * The facts the client's HUDs have to agree on: which panel is open, what phase the round is in, and
 * whether the local player is in a practice zone or out of the round.
 *
 * **A module rather than a wire between controllers.** The dock's buttons open the panels and the
 * panels read whether they are open, so if either held the other there would be a construction-order
 * dependency between two controllers — which is precisely what `aiming.ts` argues against at length,
 * and the same shape `client/ui/screenGui.ts` uses so that two HUDs can share one `ScreenGui` without
 * either of them owning it. Here it is several controllers and four values, so the state lives in
 * nobody's file.
 *
 * **Each value has exactly one writer, which is the rule that keeps this from being a dumping ground.**
 * `roundPhase` is written by `DockController` and read by both panels; `inPracticeZone` is written by
 * `DockController` too, because it was already watching that attribute for its own visibility; and
 * `spectating` is written by `SpectatorController`, whose whole reason to exist is that attribute. Every
 * one of them is a connection that had to exist anyway, moved so that its answer can be *read* rather
 * than recomputed. The alternative — each HUD holding its own connection to the same attribute — is one
 * subscription per reader for one fact, which is the thing this module exists to prevent.
 *
 * **The file is now "the facts the HUDs share" wearing the name of the two panels it started with.** It
 * began as the dock and the panels agreeing about modals, and it grew the phase, the zone flag and the
 * spectator flag as more than one HUD needed them. That is a fair description of a *session state*
 * module, and if a fifth fact arrives this should be renamed rather than stretched further — the name is
 * currently a reader's first wrong idea about what belongs here.
 *
 * **The two `open` values are separate rather than one "current panel"**, even though exactly one can
 * be open at a time. A single value would have to name a panel with a string, and every reader would
 * then be doing a comparison to answer a boolean question; two booleans and one rule about them is
 * less machinery than one string and a rule at every call site.
 */
const scope = Fusion.scoped();

/**
 * The two phase names the client spells out, kept in one place.
 *
 * **Literals, because there is nothing to import.** The phase is published as its own *name*, and those
 * names are `RoundState`'s members by convention rather than by construction — `MusicController`,
 * `RoundStatusController` and `DockController` each say so about the same two words. Naming them here
 * means the HUDs that need the comparison import it once instead of becoming the fifth and sixth copies
 * of the string: the server keeps its single source, and this is the client's mirror of it rather than
 * one per reader.
 */
export const INTERMISSION = "Intermission";
export const PLAYING = "Playing";

/**
 * The phase the server last published, seeded to `Intermission`.
 *
 * **Seeded to the *permissive* value deliberately.** A client that has not yet heard from the server
 * is treated as being between rounds: the dock appears a frame early at worst, where seeding to
 * `Playing` would hide the dock for a whole replication after a round ended — a button that is
 * missing when a player looks for it is a worse failure than one that lingers for a frame.
 */
export const roundPhase = Fusion.Value(scope, INTERMISSION);

/**
 * Whether the local player is standing in a practice zone, as the server publishes it.
 *
 * **A replicated fact rather than the client's own check, and the difference is what makes this cheap.**
 * `client/roundZone.ts` can answer the same question with a bounds test, but a `Computed` re-runs
 * whenever its sources move — so a zone test *inside* one would be a `GetPartBoundsInBox` walk on every
 * re-render of something that has nothing to do with the zone. This is the *server's* answer, which is
 * also the one that decides whether the player is really in there.
 *
 * **Written by `DockController`**, which had the connection before this module held the value; the same
 * one-writer rule as `roundPhase` above, and the same reason it is not written here: nothing at module
 * scope can subscribe to a `Player` before the client has one.
 */
export const inPracticeZone = Fusion.Value(scope, false);

/**
 * Whether the local player is out of the round in progress, as the server publishes it.
 *
 * Written by `SpectatorController` for `inPracticeZone`'s reason — it already watches the attribute to
 * show its own label — and read by the session HUDs, which hide for a spectator. See
 * {@link sessionHudVisible}.
 */
export const spectating = Fusion.Value(scope, false);

/**
 * Whether the round's own HUDs should be on screen: **in a round or in a practice zone, and not while
 * spectating.**
 *
 * **One expression, in one place, because four elements have to agree about it.** The Super HUD, its
 * stamina segments and the cooldown readout hide and show together, and a copy of this rule in each of
 * them is how they would come to disagree — the same argument `hudToast.ts` makes for owning the toast
 * column's numbers.
 *
 * **The two halves of the first term are the two ways a player can act.** A round is the game, and a
 * practice zone is the place the game has decided a player may practise in — the zone's own rules are
 * what `PracticeZoneService` publishes, and the *dock* hides in exactly the place these HUDs appear.
 * The two conditions are deliberately not "not an intermission": a client that has not yet heard a phase
 * would then be showing a readout for a round that may not exist, which is the mistake `roundPhase`'s
 * seeding note says is the safe one for a *dock* and the wrong one for a player's own readouts.
 *
 * **A spectator sees neither HUD, and the argument is the abilities rather than the body.** Being out of
 * a round takes the powers with it — `BallService.markHeldBall` refuses without an active round — so
 * there is no armed ability to draw and no charge to hold. **The stamina segments are the honest
 * exception and the reason this is worth stating**: a spectator's body still walks and sprints, so the
 * pool behind those three lights is still theirs and still being spent. They are hidden anyway, because
 * the elements are one stack and half a stack is worse than neither — and because a player who is out is
 * being told to watch, not to read their own controls.
 *
 * **A `Computed` factory rather than a `Value`**, because there is nothing to write: the answer is a
 * function of three values, and a fourth `Value` kept in step by a fourth connection would be a way to
 * get it wrong. It is per-scope rather than module-level because a `Computed` belongs to whoever will
 * dispose it — the same reason `addViewportConstraint` builds one inside the caller's scope.
 */
export function sessionHudVisible(scope: Fusion.Scope<unknown>): Fusion.Computed<boolean> {
	return Fusion.Computed(scope, (use) => {
		// Both `use()` calls are hoisted to the top, and the rule they feed is evaluated after them.
		// `use(a) === X || use(b)` would subscribe to whichever ran, so a phase that stopped matching
		// would stop the zone flag from being watched at all — the trap `DockController`'s own comment
		// names about its own two values.
		const phase = use(roundPhase);
		const zone = use(inPracticeZone);
		const out = use(spectating);

		if (out) return false;

		return phase === PLAYING || zone;
	});
}

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
