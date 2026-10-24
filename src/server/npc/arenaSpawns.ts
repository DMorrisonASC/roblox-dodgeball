import { Workspace } from "@rbxts/services";
import { ARENA_CONFIG } from "shared/config/arena.config";
import { findFolder } from "shared/find";
import { TEAM_B, TeamLabel } from "../services/round/team";

/**
 * **Where a rig that belongs to `team` should stand in the arena — one answer, for a caller that is not
 * the round.**
 *
 * **The round already knows this, and it is not the round asking.** `RoundService.arenaSpawnFor` is the
 * authority for everything the round moves: the opening whistle, a rig's arrival, a player's respawn. This
 * module exists for the one mover that cannot ask it — `RespawnBehavior`, which rebuilds a dead rig and has
 * no service to call: it is constructed by `NpcService`, and reaching back into `RoundService` (or into
 * `LobbyRigService`, which owns the rest of a rig's placement) would be a cycle at run time for a lookup of
 * six lines. The alternative considered and rejected was teaching the behaviour a *list* of spawn parts at
 * boot: the arena is a permanent part of the place and its spawns are one Studio edit away from being
 * replaced, so a cached list is the last round's spawns — which is why `RoundService` re-reads them on every
 * call and is the reason this does too.
 *
 * **The lookup is the arena's contract, not a path.** `ArenaSpawns` with an `A` and a `B` inside it is part
 * of what a playable arena *is* — `ARENA_CONFIG` names both levels, `RoundService.arenaProblem` reports a
 * missing one before a round can open, and `shared/find.ts` states why the search is a search: somebody who
 * tidies the folders into grouping folders of their own has broken nothing. Only **direct** `BasePart`
 * children count, the same rule the round keeps, so "is this a spawn?" stays a question about one folder's
 * children in both places.
 *
 * **The three-stud lift, because this answer is a *root* CFrame.** Every rig placement in this project
 * writes `HumanoidRootPart.CFrame` (`RespawnBehavior`, `RoundService.teleportTeamsToArena`,
 * `LobbyRigService.placeParked`), and a spawn part's own CFrame is the floor it stands on — so the lift is
 * part of the answer rather than the caller's business, and a caller that forgot it would bury the rig.
 *
 * **Nothing, rather than a fallback**, when the arena or the folder or the parts are missing. A caller has a
 * better answer in that case than a made-up point: `RespawnBehavior` falls back to where the rig was put,
 * which is exactly what it did before this existed. An origin here would put a rig at the centre of the
 * world with nothing to say why.
 */

/** The name of `team`'s spawn folder inside the arena. The labels are the folder names. */
function teamFolderName(team: TeamLabel): string {
	return team === TEAM_B ? ARENA_CONFIG.ARENA_TEAM_FOLDER_B : ARENA_CONFIG.ARENA_TEAM_FOLDER_A;
}

/** One of `team`'s arena spawns, lifted to where a rig's root belongs, or nothing. */
export function arenaSpawnForRig(team: TeamLabel): CFrame | undefined {
	// **A direct child of `Workspace`, and the only lookup here that pins a location** — for
	// `RoundService.findArena`'s reason: the arena sits at the root of the world and `ARENA_NAME` says why
	// that is worth stating rather than searching for. Everything below it is searched.
	const arena = Workspace.FindFirstChild(ARENA_CONFIG.ARENA_NAME);
	if (arena === undefined) return undefined;

	const spawns = findFolder(arena, ARENA_CONFIG.ARENA_SPAWNS_FOLDER);
	if (spawns === undefined) return undefined;

	const folder = findFolder(spawns, teamFolderName(team));
	if (folder === undefined) return undefined;

	const parts: BasePart[] = [];

	for (const child of folder.GetChildren()) {
		if (child.IsA("BasePart")) parts.push(child);
	}

	if (parts.size() === 0) return undefined;

	return parts[math.random(0, parts.size() - 1)].CFrame.add(new Vector3(0, 3, 0));
}
