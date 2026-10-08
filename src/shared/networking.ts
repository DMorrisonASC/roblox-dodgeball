import Net from "@rbxts/net";

/**
 * Every remote in the game, declared once here and used by both sides.
 *
 * The declarations are evaluated on both machines and the library builds the
 * matching instances on the server and waits for them on the client, so this
 * file is the whole contract: add an entry, and both sides can see it typed.
 *
 * (The throw's remote is still the older hand-rolled `ReplicatedStorage.Remotes`
 * event — see `shared/remotes.ts`. Left alone deliberately; it works.)
 */
/**
 * One line of the round-result board: whose row it is, and the two figures the round counted for them.
 *
 * **A name rather than a `Player`.** The board is drawn between rounds, and the round's roster is
 * emptied before the intermission begins — so the thing the label needs is something to *print*,
 * and that is what travels. A `Player` on the wire would be a reference the client would then have
 * to resolve against a list it may no longer contain.
 *
 * **The id is for the face, and it is a number because a face is looked up by one.** Every client
 * has to draw a picture for a name it cannot otherwise resolve — a player who has since left is not
 * in `Players` on this machine — so the id travels with the name rather than being looked up here.
 *
 * **Both figures are the round's, not lifetime ones.** `StatsService` keeps career counts and they
 * are deliberately not these: a board about the round that just ended is not the place for a total,
 * and the two sets of numbers have different lifetimes for that reason. See `RoundService.roundHits`
 * and `RoundService.roundOuts`.
 */
export interface RoundResultRow {
	readonly userId: number;
	readonly name: string;
	readonly hits: number;
	readonly outs: number;
}

export const events = Net.Definitions.Create({
	/**
	 * Client → server: this character wants to dodge in this direction.
	 *
	 * Server-bound only. The movement replicates on its own, so there is nothing
	 * to send back and no reason for a second event.
	 */
	dodge: Net.Definitions.ClientToServerEvent<[direction: Vector3]>(),

	/**
	 * Client → server: this character wants to try to catch.
	 *
	 * Carries nothing on purpose. The only thing the client knows that the server
	 * does not is that a key was pressed — and the server already knows *who*
	 * pressed it, from the `Player` the engine hands the handler, so there is
	 * nothing here worth letting a client say.
	 */
	catch: Net.Definitions.ClientToServerEvent<[]>(),

	/**
	 * Client → server: this player wants to put down the ball they are holding.
	 *
	 * Nothing on the wire, like the two above, and for a stronger reason here: the
	 * server is the only machine that knows whether there *is* a ball in that hand, so
	 * anything the client said about it would be a claim rather than a fact.
	 */
	drop: Net.Definitions.ClientToServerEvent<[]>(),

	/**
	 * Client → server: this player wants the opposite of whatever their throwing setting
	 * currently is.
	 *
	 * **A request to flip, not a value to set.** Sending the setting itself would make the
	 * wire the description of a state, and a client that lost track of it — after a
	 * respawn, say — could switch throwing on for a player who had it off. Flipping what
	 * the server holds cannot disagree with the server, whatever the client believes.
	 */
	toggleThrow: Net.Definitions.ClientToServerEvent<[]>(),

	/**
	 * Client → server: this player wants to use whatever power the mystery box gave them.
	 *
	 * **Carries nothing on purpose, and unlike `markHeldBall` that is not merely a preference.** The mark
	 * remote names an ability because the *player* is choosing it; here the box chose, and which one it
	 * chose is a fact the server is holding in its own window. A client that sent the name it read off
	 * `MYSTERY_POWER_ATTRIBUTE` would be sending a *replica* — so a window that had just closed, or a
	 * collection that landed while the attribute was still catching up, would have a player mark a ball
	 * with a power they were never given. The server answers this request out of the window it holds,
	 * which is the same argument `catch` and `drop` make in one sentence each.
	 *
	 * **A request, not an instruction.** Whether there is a window at all, whether the ball in hand can
	 * carry what it rolled, whether a round is being played and whether the window still has time on it
	 * are four questions this machine cannot answer, and the server answers all four before spending
	 * anything.
	 */
	useMysteryPower: Net.Definitions.ClientToServerEvent<[]>(),

	/**
	 * Client → server: this player is voting for this mode for the next round.
	 *
	 * Carries the mode's **id as a string**, not a `GameModeId`: the wire is not typed, so the
	 * server has to treat what arrives as an arbitrary string and check it — which is what
	 * `isGameModeId` and the registry lookup are for. Typing it here would describe an intention
	 * rather than a guarantee.
	 *
	 * A string rather than a number, deliberately. An index into the server's list would be a
	 * number whose meaning lived on the other machine, so a client a version behind would vote for
	 * whichever mode happened to have moved into that slot — silently, and for the wrong thing. An
	 * id that is not recognised is refused instead.
	 */
	castVote: Net.Definitions.ClientToServerEvent<[mode: string]>(),

	/**
	 * Client → server: whether this player is now holding the sprint key.
	 *
	 * **A level, and the only event here that sends a value the server could not work out for
	 * itself.** `toggleThrow` above argues the opposite case at length — a request to flip rather
	 * than a value to set, because the server owns the setting and a client that had lost track of
	 * it could otherwise switch throwing *on* for somebody who had it off. The reasoning there is
	 * about *authority*, not about values on the wire, and it does not reach this event: the server
	 * holds no opinion about whether a key is down, and no way to discover it. That is a fact only
	 * the client has, so the client is the only thing that can report it, and the honest shape of a
	 * held key is a boolean that stays true until it is false.
	 *
	 * Nothing is validated on the far side and nothing needs to be: an untrue `true` buys a player
	 * fifteen studs per second for as long as their stamina lasts, which is what the same player
	 * gets by holding the key, and running out stops it either way. See `WalkSpeedService`.
	 */
	setSprinting: Net.Definitions.ClientToServerEvent<[active: boolean]>(),

	/**
	 * Client → server: this player wants the ball in their hand to carry this ability.
	 *
	 * **Carries the ability's id as a string**, not an `AbilityKind`: the wire is not typed, so the
	 * server treats what arrives as an arbitrary string and checks it with `isAbilityKind` — the
	 * arrangement `castVote` describes at length, and for its reason. A client may legitimately name an
	 * ability nobody has written, and the refusal belongs where the string is turned into a value.
	 *
	 * **Nothing comes back, and that is the design rather than an omission.** Whether the mark happened
	 * is written on the *ball* — a replicated instance in this player's own hand — so the attribute
	 * appearing is the acknowledgement, and a reply event would be a second channel carrying a fact the
	 * client already has. A refusal needs no message either: an unmarked ball a moment later is the
	 * answer, and the server prints the reason where a reader can find it.
	 *
	 * **Nothing on the wire says whether the player may mark a ball.** The server holds the charge,
	 * knows the dev flags, and is the only machine that can see the ball in the hand, so a client that
	 * gated its own request would be a second copy of rules it cannot evaluate — the position
	 * `setSprinting` above argues from the opposite direction.
	 */
	markHeldBall: Net.Definitions.ClientToServerEvent<[kind: string]>(),

	/**
	 * Client → server: this player is spending their charge on a MultiBall window.
	 *
	 * **No argument, unlike {@link markHeldBall} above, and the difference is the two abilities rather
	 * than an economy.** A mark has to say *what* the ball is being marked as, because the ball is what
	 * carries the ability and there is more than one word it could be. This names one ability in the
	 * key that sent it: there is nothing for the client to choose, and therefore nothing arriving that
	 * needs checking — the server asks whether this player may have a window, not what they asked for.
	 *
	 * **Nothing comes back**, for the reason the mark gives: the answer is two attributes on the player,
	 * which replicate on their own, so a reply event would be a second channel carrying a fact this
	 * machine already has. A refusal needs no message either — an unchanged pair of attributes 
	 * a moment later is the answer, and the server prints the reason where a reader can find it.
	 */
	multiBall: Net.Definitions.ClientToServerEvent<[]>(),

	/**
	 * Server → client: the round that has just finished, as the result panel reads it.
	 *
	 * **The only entry in this file that travels the other way.** Every other declaration here is a
	 * client asking the server to do something; this is the server telling the clients what happened.
	 * There is nothing to send back, and nothing to validate on arrival beyond the shape: a client
	 * cannot fire it.
	 *
	 * **A list, therefore not an attribute.** The folder the rest of the HUD reads carries scalars —
	 * one phase, one clock, one flag, one packed option string. A board is a side's worth of rows,
	 * and the alternative that was considered — an attribute per player, read off `Players` and
	 * filtered by side on the client — puts the ranking rule on the machine that is drawing it,
	 * where the order a board is in would be decided by whoever wrote the label.
	 *
	 * **It carries the mode as well as the side label, and that is not redundancy.** The client names
	 * a side through `sideNameOf(mode, label)`, and the mode it would otherwise read off
	 * `ROUND_MODE_ATTRIBUTE` is rewritten twenty seconds into the intermission — when the vote closes
	 * and names the *next* round. A panel still on screen would have watched the winning side change
	 * its name underneath it.
	 *
	 * **Fired once, so it is the one HUD fact a late joiner does not get.** A client that connects
	 * during the intermission has no result to draw and shows no panel; it did not watch the round,
	 * and there is nothing on the folder for it to catch up from.
	 */
	roundResult: Net.Definitions.ServerToClientEvent<[mode: string, winner: string, rows: RoundResultRow[]]>(),

	/**
	 * Client → server: this player wants to spend coins on a Power Chest.
	 *
	 * **Carries nothing, for {@link multiBall}'s reason.** The chest's price, the roster and this
	 * player's wallet are all facts the server alone holds, so there is nothing a client could truthfully
	 * say here. The answer is {@link chestResult}, because a chest *does* need an answer: unlike a mark
	 * or a window, whose acknowledgement is a replicated attribute, a refusal here has to say why — "not
	 * enough coins" and "all collected" are different answers to a player, and the wallet is the one
	 * attribute that is allowed to stay unchanged by a successful action's *opposite*.
	 */
	openPowerChest: Net.Definitions.ClientToServerEvent<[]>(),

	/**
	 * Server → client: what the chest the player just opened did.
	 *
	 * **`granted` is the power's id on success and `""` on refusal**, and `reason` is the human
	 * sentence for the refusal (empty on success) — so a client draws the answer from one event rather
	 * than inferring it from which attributes changed. Sent to the one player, not broadcast.
	 */
	chestResult: Net.Definitions.ServerToClientEvent<[granted: string, reason: string]>(),

	/**
	 * Client → server: this player wants to wear this cosmetic in this slot.
	 *
	 * **Two strings, and the slot is on the wire for one reason: an empty id names no slot by itself.**
	 * `""` is the meaningful value "no cosmetic — the default" (see `EQUIPPED_TRAIL_ATTRIBUTE`), and a
	 * message carrying only that would leave the server unable to tell a trail being cleared from an
	 * elimination being cleared. So both travel, and both are checked on arrival: the slot must be one
	 * this build knows, and the id must be either empty or a catalogued cosmetic *of that slot*.
	 *
	 * **Ownership is deliberately not sayable from this end.** The client asserts what it would like to
	 * wear; whether it owns the thing is answered by the server from its own record, because a client
	 * that could tell the server what it owned would be a client that could equip anything. See
	 * `EconomyService.equipCosmetic` for the order the checks run in.
	 *
	 * **No reply event, unlike {@link openPowerChest}.** A chest needs an answer because its refusals are
	 * three different sentences a player cannot distinguish by watching nothing happen; an equip's
	 * refusals are all "that request was not valid", which a correct client never sends and which is not
	 * worth a sentence. The acknowledgement is the attribute changing, which replicates on its own — the
	 * same shape `toggleThrow` and `markHeldBall` use.
	 */
	equipCosmetic: Net.Definitions.ClientToServerEvent<[slot: string, id: string]>(),

	/**
	 * Client → server: this player wants the named power in or out of their item-box pool.
	 *
	 * **A toggle rather than a setter, on {@link toggleThrow}'s precedent and for its exact reason.** The
	 * wire carries a request to *flip* one power, not a pool to install, so a client that has lost track
	 * of what it has — which is any client that has just joined, or joined back — cannot assert a pool the
	 * server disagrees with. Flipping what the server already holds is a change the server can make
	 * correctly whatever the client believes, which is the property a setter does not have.
	 *
	 * **The pool is not ownership, and this cannot grant anything.** The named power must be one the player
	 * already owns, checked against the record — so the worst a malicious client can do is put something it
	 * owns into a pool nothing reads yet. See `EconomyService.togglePowerPool` for the order of the checks.
	 *
	 * No reply event, for the reason {@link equipCosmetic} gives: the acknowledgement is the attribute
	 * changing, which replicates on its own.
	 */
	togglePowerPool: Net.Definitions.ClientToServerEvent<[power: string]>(),
});
