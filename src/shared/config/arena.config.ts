/**
 * Everything about the arena: where it is, what its spawns are called, and how
 * long a round and the gap between rounds last.
 *
 * Imports nothing, and holds no geometry of its own — the spawns are parts that
 * already exist in the place file, and these are the names the round logic looks
 * them up by. Renaming a spawn in Studio without renaming it here is a spawn
 * that can no longer be found.
 */
export const ARENA_CONFIG = {
	/**
	 * **Placeholder.** The middle of the arena, in world studs. Nothing reads it:
	 * spawn placement is done by the spawn parts named below.
	 */
	CENTER: new Vector3(0, 0, 0),

	/** **Placeholder.** How far from {@link ARENA_CONFIG.CENTER} a generated spawn ring would sit, in studs. */
	SPAWN_RADIUS: 30,

	/** **Placeholder.** How high above a generated spawn point a model would be dropped in, in studs. */
	SPAWN_HEIGHT: 40,

	/**
	 * The part a player is put on between rounds.
	 *
	 * Looked up by name in `Workspace`, so this and the part have to agree; a
	 * missing one is an error rather than a silent fallback, because a round that
	 * starts with everyone in the wrong place is worse than one that does not start.
	 */
	LOBBY_SPAWN_NAME: "LobbySpawn",

	/** The part a player is put on when a round begins. Same rules as the lobby spawn. */
	ARENA_SPAWN_NAME: "ArenaSpawn",

	/**
	 * How long the gap between rounds lasts, in seconds.
	 *
	 * Counted down a second at a time, so this is a whole number of seconds by
	 * construction and a fractional one would be rounded in the HUD rather than in
	 * the clock. Read by `RoundService`.
	 */
	INTERMISSION_SECONDS: 10,

	/**
	 * How long a round lasts, in seconds.
	 *
	 * The same shape as {@link ARENA_CONFIG.INTERMISSION_SECONDS}: a whole number
	 * of seconds, counted down one at a time.
	 */
	ROUND_SECONDS: 30,
} as const;
