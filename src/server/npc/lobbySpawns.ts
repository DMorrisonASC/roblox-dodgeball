import { ARENA_CONFIG } from "shared/config/arena.config";
import { TEAM_ATTRIBUTE } from "shared/constants";
import { findFolder } from "shared/find";
import { TEAM_B, TeamLabel } from "../services/round/team";

/**
 * **Where a rig may be put in the lobby, asked by side — the one derivation of that question, and the
 * module exists because the question has two askers that cannot share through either of them.**
 *
 * `LobbyRigService` asks it for a rig it is *creating* (`spawnLobbyRig`), and `RoundService` asks it for
 * every rig it *returns* at the end of a round (`returnRigsToLobby`). Neither can call the other: the
 * lobby service is handed `NpcService` and `MatchService` and nothing else, and the round owns the
 * boundary that moves the rigs — so the shape is `npc/rigs.ts`'s, one step out. That module is the single
 * home for "which rigs stand on a side"; this is the single home for "which spots belong to a side".
 *
 * **The 2026-10-17 report is what happens without it, and the second half of that report is what this
 * file is for.** The first half was `spawnLobbyRig` placing a rig at `lobbySpawns[spawnCursor % size]`
 * with no side in the draw at all, so a rig bound for B could appear among A's parts and walk across the
 * room — a body that has visibly "spawned on the wrong side". The fix gave that one caller a sided draw.
 * **The other caller was never touched, and it is the one that runs every round**: `RoundService.
 * returnRigsToLobby` still draws from `lobbySpawn()`, whose own doc says a lobby has no sides. So seven
 * rigs are teleported to random lobby spawns at every round end whatever side they wear, stand there for
 * the length of the cover, and only then walk to their own pads. That is the same symptom arriving by the
 * other road, which is why it was reported as happening "again".
 *
 * **Two ways to mark a half, and either is enough** — the rule `LobbyRigService.lobbySpawnsFor` documented
 * and this module now owns:
 *
 * - **A folder per side inside `LobbySpawns`**, named as `ArenaSpawns`' are, with direct `BasePart`
 *   children. This is the shape the arena already has, so it is the one to reach for.
 * - **A `Team` attribute on each part**, `"A"` or `"B"` — `TEAM_ATTRIBUTE`, the same name a rig wears, so
 *   there is one word for "which side is this" in the project. Marked parts are found anywhere inside the
 *   folder, which tolerates a grouping model between the folder and the floor.
 *
 * **An unmarked half is `[]`, and the two callers fall back differently on purpose.** `LobbyRigService`
 * warns once and uses the whole folder, because refusing to place a rig would be a worse fault than a rig
 * walking across the room. `RoundService` simply keeps the side-less draw it has always used. Neither
 * fallback is silent about itself; what must not happen is either of them treating "no marking" as "no
 * lobby".
 */

/**
 * The direct `BasePart` children of `folder`.
 *
 * **The one place "what counts as a spawn" is decided for the lobby**, shared by the sided search below
 * and the unsided one — the same split `RoundService.teamSpawnParts` makes for a side's spawns. Two
 * callers disagree about what emptiness *means*; neither should disagree about what emptiness *is*.
 *
 * Only **direct** children, deliberately: a `Model` full of parts is not a spawn and is skipped rather
 * than searched, so "is this a spawn?" stays a question about one folder's children.
 */
export function lobbySpawnPartsIn(folder: Folder): Array<BasePart> {
	const parts = new Array<BasePart>();

	for (const child of folder.GetChildren()) {
		if (child.IsA("BasePart")) parts.push(child);
	}

	return parts;
}

/**
 * `side`'s half of the lobby's spawn parts under `root`, or nothing when the place file does not say.
 *
 * **`root` rather than `Workspace` hard-coded, because the two callers look from different places and
 * both are right.** `RoundService` searches the arena it already holds (`LobbySpawns` is inside it in
 * every place file this project has), and `LobbyRigService` has no arena and searches the world — see its
 * `lobbySpawns` for why. They agree whenever there is exactly one folder of that name, which is the place
 * both are written for; passing the root in is what lets one derivation serve both without either of them
 * having to adopt the other's search.
 *
 * **Empty means "not marked", not "no lobby"** — the four cases in order: no `LobbySpawns` under `root`,
 * no side folder, an empty side folder, and no marked parts. The third falls *through* rather than
 * winning, because a folder somebody made and has not filled yet is a half-finished edit and taking it
 * would leave one side with no place to stand.
 */
export function lobbySpawnPartsFor(root: Instance, side: TeamLabel): Array<BasePart> {
	const folder = findFolder(root, ARENA_CONFIG.LOBBY_SPAWNS_FOLDER);
	if (folder === undefined) return [];

	const sided = findFolder(
		folder,
		side === TEAM_B ? ARENA_CONFIG.ARENA_TEAM_FOLDER_B : ARENA_CONFIG.ARENA_TEAM_FOLDER_A,
	);

	if (sided !== undefined) {
		const parts = lobbySpawnPartsIn(sided);

		if (parts.size() > 0) return parts;
	}

	const marked = new Array<BasePart>();

	for (const descendant of folder.GetDescendants()) {
		if (!descendant.IsA("BasePart")) continue;
		if (descendant.GetAttribute(TEAM_ATTRIBUTE) !== side) continue;

		marked.push(descendant);
	}

	return marked;
}
