/**
 * Which maps exist, and where they live.
 *
 * **Adding a map is one entry in {@link MAP_CONFIG.MAP_NAMES} plus a `Model` in
 * `ServerStorage.Maps`, and no code change anywhere.** That is the whole point of the file: the
 * list of arenas is data, so a new one is content rather than a commit.
 *
 * Nothing here is read by the client. A map is a thing the server puts into `Workspace` — the
 * clone replicates on its own, the same way any other instance does — so there is no map id on the
 * wire and no client that has to know one is coming.
 */

export const MAP_CONFIG = {
	/**
	 * The folder in `ServerStorage` holding one `Model` per map.
	 *
	 * `ServerStorage` rather than `Workspace` because it does not replicate: the arenas waiting
	 * their turn are never sent to a client that cannot see them, and — the real reason — a map in
	 * `Workspace` would be loaded for the whole life of the server, which is exactly what stops a
	 * map being swappable at all.
	 */
	MAPS_FOLDER: "Maps",

	/**
	 * The maps a round may be played in, in rotation order.
	 *
	 * **The order is the rotation, not a set.** `MapService.pickNext` walks this list rather than
	 * picking from it at random, so the order two names are written in is the order they are played
	 * in — see that method for why sequential was chosen over random.
	 *
	 * Each name has to be a `Model` in `ServerStorage.<MAPS_FOLDER>`, holding its own arena geometry
	 * and its own `ArenaSpawns` folder (`ARENA_CONFIG.ARENA_SPAWNS_FOLDER`) with an `A` and a `B`
	 * inside it.
	 *
	 * **The name is an opaque key.** It is matched against the child's `Name` and means nothing else
	 * — not a file on disk, not an ordering, not a prefix. So a map already built under another name
	 * needs no renaming; put that name here instead, and the two agree. Which also means the match is
	 * **case-sensitive**, because `FindFirstChild` is: `rolivemap` and `RoLiveMap` are two different
	 * names and only one of them is on the model.
	 *
	 * **A name appears once per rotation.** This list is walked by index, so a name written twice
	 * means the same map played twice in a cycle rather than anything being merged.
	 *
	 * A name with no model behind it, or a model without usable spawns, is neither a silent fallback
	 * nor a fatal error: the round boundary refuses to start the round, says in the output exactly
	 * which path is missing, and retries on the next intermission. See `RoundService.mapProblem`.
	 */
	MAP_NAMES: ["RoLive Map"],
} as const;
