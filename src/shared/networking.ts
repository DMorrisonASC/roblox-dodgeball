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
});
