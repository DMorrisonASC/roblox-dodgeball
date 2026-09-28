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
});
