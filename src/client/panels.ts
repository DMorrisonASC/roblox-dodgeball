import Fusion from "@rbxts/fusion-3.0";

/**
 * The facts the client's HUDs have to agree on: which panel is open, what phase the round is in, and
 * whether the local player is in a practice zone.
 *
 * **A module rather than a wire between controllers.** The dock's buttons open the panels and the
 * panels read whether they are open, so if either held the other there would be a construction-order
 * dependency between two controllers — which is precisely what `aiming.ts` argues against at length,
 * and the same shape `client/ui/screenGui.ts` uses so that two HUDs can share one `ScreenGui` without
 * either of them owning it. Here it is several controllers and three values, so the state lives in
 * nobody's file.
 *
 * **Each value has exactly one writer, which is the rule that keeps this from being a dumping ground.**
 * `roundPhase` is written by `DockController` and read by both panels; `inPracticeZone` is written by
 * `DockController` too, because it was already watching that attribute for its own visibility. Each of
 * them is a connection that had to exist anyway, moved so that its answer can be *read* rather than
 * recomputed. The alternative — each HUD holding its own connection to the same attribute — is one
 * subscription per reader for one fact, which is the thing this module exists to prevent.
 *
 * **There used to be a fourth value here, `spectating`, and its removal is the spectator removal on
 * this side of the wire.** It was a mirror of `SPECTATING_ATTRIBUTE`, written by `SpectatorController`
 * and read by every HUD that hid itself for a player who was out of the round. There is no spectator
 * state any more, so there is nothing to mirror and nothing to hide for — see
 * {@link sessionHudVisible}, which is where the consequence is written down rather than merely
 * applied.
 *
 * **The file is now "the facts the HUDs share" wearing the name of the two panels it started with.** It
 * began as the dock and the panels agreeing about modals, and it grew the phase and the zone flag as more
 * than one HUD needed them. That is a fair description of a *session state* module, and if a fourth fact
 * arrives this should be renamed rather than stretched further — the name is currently a reader's first
 * wrong idea about what belongs here.
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
 * Whether the round's own HUDs should be on screen: **in a round, or in a practice zone.**
 *
 * **One expression, in one place, because four elements have to agree about it.** The Super HUD, its
 * stamina segments and the cooldown readout hide and show together, and a copy of this rule in each of
 * them is how they would come to disagree — the same argument `hudToast.ts` makes for owning the toast
 * column's numbers.
 *
 * **The two halves of the term are the two ways a player can act.** A round is the game, and a
 * practice zone is the place the game has decided a player may practise in — the zone's own rules are
 * what `PracticeZoneService` publishes, and the *dock* hides in exactly the place these HUDs appear.
 * The two conditions are deliberately not "not an intermission": a client that has not yet heard a phase
 * would then be showing a readout for a round that may not exist, which is the mistake `roundPhase`'s
 * seeding note says is the safe one for a *dock* and the wrong one for a player's own readouts.
 *
 * **There used to be a third term, `!spectating`, and removing it is the one place this removal is
 * visible rather than merely tidy.** The predicate asked "can this player act", and being out of the
 * round is the one way to be *in* a round and unable to act — so with the spectator flag gone the
 * predicate is now "a round is on, or a zone is", which is a question about the *world* rather than
 * about the player. Two kinds of player are affected, and both are the accepted cost of removing the
 * state rather than a surprise:
 *
 * - **A player who dies inside a round** — Score Rush respawns, so they are out for
 *   `ARENA_CONFIG.RESPAWN_DELAY_SECONDS` and then back. For those seconds the ability readouts are up
 *   over a body that does not exist yet. The respawn countdown is the readout that is true about them
 *   by then, and it is drawn in the middle of the screen rather than at the bottom, so the two do not
 *   collide — it just means a dead player sees a stack of readouts they cannot use for three seconds.
 * - **A player who joined mid-round**, who is not on a side and cannot opt in while the phase is
 *   `Playing`. They see the same stack, in the lobby, with nothing armed and nothing to arm.
 *
 * **What replaced it is not a flag and deliberately is not one.** The honest predicate would be "am I
 * in the round", and nothing on the client publishes that any more — `activePlayers` is the server's
 * and has never been replicated. Re-publishing it as an attribute is exactly the state that was
 * removed, so it is not re-added here; a client-side rule that could tell the two apart would need a
 * new fact, and inventing one was not part of this change.
 *
 * **A `Computed` factory rather than a `Value`**, because there is nothing to write: the answer is a
 * function of two values, and a third `Value` kept in step by a third connection would be a way to get
 * it wrong. It is per-scope rather than module-level because a `Computed` belongs to whoever will
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
