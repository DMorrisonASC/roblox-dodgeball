/**
 * Finding a named thing in a tree, **searching the whole tree rather than its first level**.
 *
 * **Nesting is the norm in this project's place files, not the exception.** Arena spawn folders sit
 * inside grouping folders inside the map's model, the barriers sit in a folder of their own, and the
 * lobby is a loose part whose name once shadowed a folder's. Anything that looks for a part, a folder
 * or a model by name therefore has to search *everything under its root* — and this is that search,
 * written once so that the rule is stated in one place instead of re-derived by each caller.
 *
 * **The class is part of the question, and that is not fussiness.** `FindFirstChild(name, true)`
 * answers with the first instance *of that name whatever it is*, so a `Folder` called `ArenaSpawns`
 * shadows the real one and the lookup reads as "this map has no spawns" with the thing it wanted a
 * few studs away. Requiring the type *while* walking means a decoy of the wrong class is passed over
 * rather than returned as the answer. `RoundService.lobbySpawn` learned this the hard way.
 *
 * **The exception is a structure the game itself requires, and it has to be justified where it is
 * used.** Some layouts are an interface rather than an accident: a playable map has to offer
 * `ArenaSpawns` with an `A` and a `B` inside it, and a lookup may rely on that. What may *not* be
 * relied on is where something happens to sit today — these place files are reorganised constantly,
 * and "it is a child of the map" is a fact that expires. Where a fixed path is kept, the reason
 * belongs in the comment beside it: the names being shared config, the shape being part of what a
 * map *is*, and a violation being reported rather than passing silently.
 *
 * **The folder lookup is the only one left in here.** A `findModel` sat beside it for the map
 * rotation and went with `MapService` when that was deleted — `RoundService` is the only remaining
 * caller, and it wants folders.
 */

/** The first descendant of `root` called `name` that is a `Folder`, or nothing. */
export function findFolder(root: Instance, name: string): Folder | undefined {
	for (const descendant of root.GetDescendants()) {
		if (descendant.Name !== name) continue;
		if (!descendant.IsA("Folder")) continue;

		return descendant;
	}

	return undefined;
}
