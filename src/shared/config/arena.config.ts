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

	/**
	 * The one arena spawn, from before the two teams had a side each.
	 *
	 * **No longer read by the round**: a round sends each team to its own part, below. It is
	 * kept as the name a place file with a single arena spawn already has, and as the part the
	 * two of those would fall back to if that were ever the right thing to do — it is not, for
	 * the reason spelled out on the team spawns: both teams on one side is a round that begins
	 * wrong, and a round that refuses to begin is the better failure.
	 */
	ARENA_SPAWN_NAME: "ArenaSpawn",

	/**
	 * Where team A is put when a round begins.
	 *
	 * Looked up by name in `Workspace`, like the lobby spawn, and deliberately with **no
	 * fallback** to {@link ARENA_CONFIG.ARENA_SPAWN_NAME} or to each other: a missing team
	 * spawn is a setup mistake, and `getSpawn` raises it by name rather than starting a round
	 * with both sides stacked on one spot.
	 */
	ARENA_SPAWN_NAME_A: "ArenaSpawnA",

	/** Where team B is put when a round begins. Same rules as {@link ARENA_CONFIG.ARENA_SPAWN_NAME_A}. */
	ARENA_SPAWN_NAME_B: "ArenaSpawnB",

	/**
	 * How long the gap between rounds lasts, in seconds.
	 *
	 * Counted down a second at a time, so this is a whole number of seconds by
	 * construction and a fractional one would be rounded in the HUD rather than in
	 * the clock. Read by `RoundService`.
	 */
	INTERMISSION_SECONDS: 15,

	/**
	 * How long a round lasts, in seconds.
	 *
	 * The same shape as {@link ARENA_CONFIG.INTERMISSION_SECONDS}: a whole number
	 * of seconds, counted down one at a time.
	 */
	ROUND_SECONDS: 150,
} as const;
