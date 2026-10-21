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
 * `roundPhase` is written by `DockController` and read by the hit feed; `inPracticeZone` is written by
 * `DockController` too, because it was already watching that attribute for its own visibility; and
 * `participating` is written there for the same reason again — the dock is the element a round *takes
 * away*, so the connection that answers "is this round mine" belongs with it, and three other HUDs read
 * the answer instead of each holding the same two subscriptions. Each of them is a connection that had
 * to exist anyway, moved so that its answer can be *read* rather than recomputed. The alternative — each
 * HUD holding its own connection to the same attribute — is one subscription per reader for one fact,
 * which is the thing this module exists to prevent.
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
 * Whether **the local player is in the round being played** — on a side, and a round on.
 *
 * **This is the fact three HUDs were missing, and its absence is what made a round somebody else started
 * take a spectator's shop away.** The phase says what the *server* is doing; this says whether any of it
 * is about you. A player who has not opted in watching a round from the lobby is not teleported by its
 * transition, is not held by its freeze, is not counted in its outcome — and, until this existed, was
 * denied the one place they could spend the wait. See `DockController`'s visibility, both panels', and
 * {@link sessionHudVisible}.
 *
 * **The rule is `roundZone.isParticipant`'s, named once and read as a `Value` so a HUD can watch it.** That
 * function is the one place "the round has this player, and a round is on" is written, and it reads
 * `IN_ROUND_ATTRIBUTE` — see the paragraph below for why it stopped reading the side. A mid-round joiner loses the
 * dock at the moment they are admitted rather than at the next intermission.
 *
 * **A surrender is the case that forced that change, and this value moved with it.** A player who leaves a round
 * keeps `TEAM_ATTRIBUTE` on purpose — `RoundService.surrender` leaves them in `teams` so the side's head count
 * survives somebody walking out — so "I have a side" and "this round is mine" stopped being one statement the day
 * a round could be left mid-way. The visible fault was a shift lock that stayed on and a shop that stayed away for
 * somebody standing in the lobby, so `isParticipant` was moved onto the attribute the round writes for exactly
 * that question. **What follows for this value is stated rather than left to be discovered: a surrendered player
 * now gets the dock back and loses the round's readouts for the rest of that round.** The note that used to stand
 * here argued the other way — that this was a HUD decision and not a correction — and the correction that changed
 * the answer is the one above: the alternative was a player with no camera release, no shop, and no visible way
 * back into a round they had just left.
 *
 * **A `Value` rather than a `Computed`, which is the whole reason it is here at all.** The answer is an
 * attribute read, and an attribute read inside a `Computed` is a *sample* rather than a dependency — the
 * lesson `ArenaFreezeCountdownController`, `StatsBillboardController` and `RespawnHudController` each
 * record about the same engine behaviour. So the connection has to exist somewhere, and it exists once,
 * in the controller named below.
 *
 * **Seeded to `false`, which is the permissive value here as `Intermission` is for the phase.** A client
 * that has not yet heard either fact is treated as not playing, so it shows a dock rather than hiding it:
 * a button that is missing when a player looks for it is the worse failure, and it is the one this was
 * reported as.
 */
export const participating = Fusion.Value(scope, false);

/**
 * **Whether the spectator kill cam is holding the camera right now.**
 *
 * **The one fact here that is not about the round**, and it lives in this module for this module's own reason:
 * several HUDs have to agree about it and none of them may own it. **`client/killCam.ts` is the only writer** —
 * it takes the camera, and the moment it does the screen has to become a shot rather than a dashboard — and every
 * element that draws something reads it.
 *
 * **A `Value` and not an attribute, because it is this client's state.** The camera is taken on the client that is
 * looking through it; a server publishing "somebody is watching a kill cam" would be telling every other player
 * about it for nothing, and the whole feature is local by construction — the camera is placed from the body this
 * machine is simulating.
 *
 * **Seeded `false`**, for `participating`'s reason: a client that has heard nothing is not in a kill cam, so it
 * draws its HUD. A HUD element that is missing when a player looks for it is the worse failure.
 */
export const killCamActive = Fusion.Value(scope, false);

/**
 * Whether the round's own HUDs should be on screen: **this player is in a round, or standing in a
 * practice zone.**
 *
 * **One expression, in one place, because four elements have to agree about it.** The Super HUD, its
 * stamina segments and the cooldown readout hide and show together, and a copy of this rule in each of
 * them is how they would come to disagree — the same argument `hudToast.ts` makes for owning the toast
 * column's numbers.
 *
 * **Both halves are about the *player*, and the phase is deliberately not one of them.** A round running
 * somewhere is not a reason to put a player's ability readouts on their screen: a spectator in the lobby
 * has nothing armed and nothing to arm, so the numbers describe abilities they cannot use. That is the
 * same correction the dock and the panels needed, and it is the reason `participating` exists — see it
 * for the fact and `roundZone.isParticipant` for the rule.
 *
 * **This used to be `phase === PLAYING || zone`, and the two cases it knowingly accepted are both gone.**
 * The first was a player who died inside a round: they kept the readouts over a body that did not exist
 * yet, for the respawn delay. They still do, and that is unchanged — a dead body keeps its
 * `TEAM_ATTRIBUTE`, so they are still *in* the round and the readouts are still theirs. The second was a
 * player who joined mid-round, who the old note said "is not on a side and cannot opt in while the phase
 * is `Playing`" — and both halves of that stopped being true: a joiner is admitted now
 * (`RoundService.admitMidRoundJoins`), and until they are, they are a spectator like any other and get
 * the dock instead of a readout for abilities they do not have.
 *
 * **A `Computed` factory rather than a `Value`**, because there is nothing to write: the answer is a
 * function of three values, and a fourth `Value` kept in step by a fourth connection would be a way to get
 * it wrong. It is per-scope rather than module-level because a `Computed` belongs to whoever will
 * dispose it — the same reason `addViewportConstraint` builds one inside the caller's scope.
 */
export function sessionHudVisible(scope: Fusion.Scope<unknown>): Fusion.Computed<boolean> {
	return Fusion.Computed(scope, (use) => {
		// Both `use()` calls are hoisted to the top, and the rule they feed is evaluated after them.
		// `use(a) === X || use(b)` would subscribe to whichever ran, so a phase that stopped matching
		// would stop the zone flag from being watched at all — the trap `DockController`'s own comment
		// names about its own two values. The third follows the same rule for the same reason.
		const inRound = use(participating);
		const zone = use(inPracticeZone);
		const watching = use(killCamActive);

		return (inRound || zone) && !watching;
	});
}

/**
 * **Why the HUD is hidden rather than torn down for the kill cam, stated once because six elements now decide it
 * and the reason must not be re-invented at each of them.**
 *
 * The cam lasts one respawn wait — three seconds — and what it covers is a tree of Fusion instances carrying live
 * bindings, pushed subscriptions and per-element state: the countdown's last-shown tenth, the hit feed's cards,
 * the shop's scroll position, the score bar's own `UIStroke`. **Every one of those is restored for free by a
 * `Visible` write and would have to be rebuilt after a `Destroy()`** — a teardown and a re-mount inside the one
 * second in which a player is waiting to be put back in the game, which is exactly the moment a stutter is least
 * forgivable and most visible. And the rebuild would not be neutral: an element re-mounted from scratch comes back
 * with its defaults, so a countdown would restart, the feed would forget the hits it was told about, and anything
 * whose state is *not* derived from an attribute would come back wrong rather than blank.
 *
 * **So the rule is a visibility state, and every hider writes `Visible` and nothing else.** The bindings keep
 * running underneath — the HUD keeps counting, the feed keeps its cards, the abilities keep their cooldowns — which
 * is why the screen clearing for three seconds changes nothing about what the HUD knows when it returns. The two
 * things that must *not* obey this are the `Return to Lobby` pill (`client/returnToLobby.ts`, which never reads
 * {@link killCamActive} and so is never hidden) and the `Enemy View` overlay, which is the opposite of clutter —
 * see `client/enemyView.ts`.
 */

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
