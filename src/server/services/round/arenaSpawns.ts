import { Workspace } from "@rbxts/services";
import { ARENA_CONFIG } from "shared/config/arena.config";
import { MATCH_SPAWNER_TAG } from "shared/constants";
import { findFolder } from "shared/find";
import { taggedPartsInWorkspace } from "shared/taggedParts";
import { logWarn } from "shared/logger";
import { TEAM_B, TeamLabel } from "./team";

/**
 * **Where a body begins a round: the nearest spot to the balls that no other body is standing on.**
 *
 * Two halves, and they only mean anything together. The **ordering** is
 * {@link spawnsNearestFirst} — a side's spawn parts sorted by how close each one sits to a
 * `MatchSpawner` — and the **claim** is {@link spawnClaims} — one part per body, so two bodies never
 * arrive inside each other. Sorting without claiming gives the first body the best spot and lets the
 * rest pile onto it; claiming without sorting gives everybody their own part and puts half of them in
 * the far corner. Neither is a round anybody wants to open.
 *
 * **The claim is keyed on the body, and that is the whole of why a rig and a player can share it.**
 * From the round's point of view the two are the same thing: a `Model` with a `Humanoid` that must not
 * arrive on top of another body. A rig has no `Player` at all, so a player-keyed map could only ever
 * describe half the arena — which is the mistake item 94 made and this file corrects. A rig is a
 * placeholder for a person in every way the arena cares about, so it fills the arena the same way: from
 * the ball spawners outwards, on a part of its own.
 *
 * **The key is the `Model` rather than the `Player`, and that is not a convenience.** A character is a
 * `Model` and a rig is a `Model`, so one key type serves both forms the round is handed — and it is
 * handed both: `admitWithCover` passes a *character* (it is what that method holds and what it pivots),
 * while the round start and the respawn pass a `Player`. Keying on the character means neither entry
 * form has to be resolved back to a `Player` first, and a rig needs no `Players.GetPlayerFromCharacter`
 * special case at all — the question "whose spot is this" simply is not asked any more.
 *
 * **The price, stated plainly: a claim dies with its body.** A character replaced by a respawn and a rig
 * rebuilt from a template are both *new* `Model`s, so neither inherits the old one's part and each must
 * free it explicitly — {@link releaseArenaSpawn} at the moment the old body stops being a body. Both
 * callers do it on the death edge and both say why: `RoundService.handleDeath` for a player's character
 * (every death, in a round or not, because a dead body holds nothing a round wants) and
 * `RespawnBehavior.onDied` for a rig, *before* the two-second rebuild rather than in it — which is what
 * covers a rig killed with no template to copy it, since that one never reaches the rebuild at all.
 * **A release that is forgotten is a part the rest of the round cannot use**, which is a slow slide
 * towards the "no free spawn" warning for a shortage that does not exist — so the release sites are named
 * here rather than left to be discovered, and `clearArenaSpawns` is the backstop for any that is missed.
 *
 * **Why this file and not `RoundService`.** `RespawnBehavior` rebuilds a dead rig and cannot ask the
 * round for a spot: it is constructed by `NpcService`, and `RoundService` is the service that injects
 * `NpcService`, so asking back would be a cycle at run time. That is the exact reason
 * `npc/arenaSpawns.ts` existed — and it existed as a *second copy* of the spawn rule, drawing at
 * random from its own walk of the same folders. Folding the claim in makes that copy the same rule
 * instead: the behaviour reaches a leaf module that the round also uses, and there is one answer to
 * "which part does this body get".
 *
 * **Not a Flamework service**, deliberately: it holds one map and no injected state, it is never
 * started, and making it a service would put a decorated class in `flamework.build` for a table.
 * `SpawnShield.ts` sits beside it for the same reason.
 */

/**
 * **The part each body was given this round.**
 *
 * **It is the round's, and it dies with the round** — see {@link clearArenaSpawns}, called from
 * `RoundService.finishRound` on the same reasoning as the `surrendered` set beside it: an intermission
 * that never ends (a server below `MATCH_MIN_PLAYERS`, a side empty) would otherwise carry the finished
 * round's reservations into the next one, and every body would be told its side had run out of parts.
 *
 * **A claim is not a position.** It says a part was handed out this round, not that the body is still
 * standing on it: a body that walks off its spawn keeps the claim until it dies or the round ends. That
 * is deliberate — a spawn part is a *starting* place, and what this prevents is two bodies arriving
 * inside each other, which is a fact about the moment of arrival only. Releasing on movement would make
 * the ordering a race between who died and who is walking.
 *
 * **Nothing prunes it.** A key whose body has been destroyed and whose claim was never released is a
 * leak only {@link clearArenaSpawns} fixes, and that is the trade this makes against scanning every key
 * for a live parent on every claim: the scan would be right about the common case and wrong about the
 * rebuild that is briefly out of the world (`RespawnBehavior` claims for a rig before parenting it), so
 * an explicit release at each body's death is both cheaper and more honest. The release sites are listed
 * in this file's own doc.
 */
const spawnClaims = new Map<Model, BasePart>();

/**
 * **A spawn part as the `CFrame` a body belongs at: three studs above the part, not on it.**
 *
 * A body pivoted onto the floor it is standing on arrives half inside it, so every spawn is a place to
 * stand rather than a place to intersect. **The one place that lift is written**, so a change to it is
 * one line rather than three that have to agree — this was inline at every spawn site in the round
 * before the arena's spawns learned to claim and order, which is three chances for one of them to be a
 * different number.
 *
 * Three studs is not derived from anything — it is above the tallest spawn part anybody has painted and
 * below the height at which a body drops onto one with a visible fall. **Placeholder.**
 */
export function liftOf(part: BasePart): CFrame {
	return part.CFrame.add(new Vector3(0, 3, 0));
}

/**
 * **One of `parts`, uniformly at random, lifted.** The draw for the two cases where a preference would
 * be meaningless: a lobby, where nobody is about to play, and a side whose parts are all claimed, where
 * there is nothing left to prefer.
 */
export function randomSpawn(parts: BasePart[]): CFrame {
	return liftOf(parts[math.random(0, parts.size() - 1)]);
}

/**
 * **`parts`, reordered so the ones nearest a ball spawner come first.**
 *
 * **This exists because a random spawn is a boring spawn.** The parts are one per place a body may
 * start, scattered over the arena, and a uniform draw put one body at the ball and the next in the far
 * corner — so the first throw of a round was decided by a dice roll rather than by anything anybody did.
 * Sorting by "how close is this to where the balls are" makes the opening of a round happen where the
 * round happens: the first body placed gets the best spot, the next gets the next best, and a side of
 * four is strung out from the balls back towards its own half rather than sprinkled across it.
 *
 * **The distance is to the *nearest* ball spawner, not the average of them all.** A spot is good if it
 * is close to *at least one* place balls appear; averaging would rank a part halfway between two
 * spawners above one standing beside a third, which is the opposite of what "near the action" means when
 * a spawner with no balls beside it is a spawner nobody is playing near. A minimum is also the question
 * a player asks — "how far do I have to walk for a ball" — while an average is nobody's.
 *
 * **The spawners are read through `taggedPartsInWorkspace`, and nothing is cached.** The tag is
 * `MATCH_SPAWNER_TAG`, so the same reader the ball spawner service uses answers this, and a spawner
 * moved in Studio moves this ordering with it. A sorted list kept between calls would be a function of
 * where the spawners were when it was built, and the spawners are the thing most likely to move between
 * rounds while somebody tunes the arena.
 *
 * **No spawners is not a failure, it is no order.** An arena that stocks its balls some other way — a
 * place being built, a dev arena — has nothing to sort against, so the folder's own order comes back
 * untouched rather than every part scoring `math.huge` and the sort scrambling them into a random order
 * that looks deliberate. The claim still runs, so uniqueness survives; only the preference does not.
 *
 * **`sort` is given a boolean comparator, which is what `table.sort` takes** — `a.distance < b.distance`
 * means "a first" — the same form `MatchStatsController`'s ranking uses.
 */
function spawnsNearestFirst(parts: BasePart[]): BasePart[] {
	const spawners = taggedPartsInWorkspace(MATCH_SPAWNER_TAG);

	if (spawners.size() === 0) return parts;

	const nearestTo = (part: BasePart): number => {
		let nearest = math.huge;

		for (const spawner of spawners) {
			const distance = part.Position.sub(spawner.Position).Magnitude;

			if (distance < nearest) nearest = distance;
		}

		return nearest;
	};

	const scored = parts.map((part) => ({ part, distance: nearestTo(part) }));

	scored.sort((a, b) => a.distance < b.distance);

	return scored.map((entry) => entry.part);
}

/**
 * **`body`'s starting spot on `team`, claimed: the nearest part to the balls that no other body holds,
 * or a shared one with a warning if there is none left.**
 *
 * `parts` arrives as an argument rather than being looked up here, and the reason is the two callers
 * rather than tidiness: the round has to *raise* when a side has no spawn parts at all (a round that
 * began with everybody in the lobby looks like a hang, and `arenaProblem` is what turns the same
 * emptiness into a sentence), while `RespawnBehavior` has to fall back to the rig's recorded home.
 * Those are two different answers to "there is nothing here", so the lookup's failure stays with each
 * caller and this function is never asked the question.
 *
 * **A body re-claiming is a move, not a second reservation.** The old entry goes before the free set is
 * read, so a body that comes back through here is offered its own previous spot on the same terms as
 * anybody else's — it is free, and it may well be the nearest one.
 *
 * **More bodies than parts is a warning and a placement, not an error.** Two bodies on one spawn part
 * push apart on the first tick; a round that raised instead is four players waiting for somebody to go
 * and drop another part into the folder. The line names the side and both counts, which is the whole of
 * the diagnosis: `4 spawn part(s) for 5 body(s)` is a side one part short. **The extra body claims
 * nothing**, because a part two bodies are standing on is not a reservation — recording one would let
 * whichever of them dies first free a spot the other is still on.
 */
export function claimArenaSpawn(body: Model, team: TeamLabel, parts: BasePart[]): CFrame {
	spawnClaims.delete(body);

	// **The claims read once into a set, because the walk below asks per part** and a map keyed on bodies
	// cannot be asked "does anybody hold this part". A side has a handful of parts and a round a handful
	// of bodies, so this is a few comparisons once per spawn — and reading it here rather than inside the
	// loop means the answer cannot change underneath the walk.
	const taken = new Set<BasePart>();
	for (const [, claimed] of spawnClaims) taken.add(claimed);

	const ordered = spawnsNearestFirst(parts);

	for (const part of ordered) {
		if (taken.has(part)) continue;

		spawnClaims.set(body, part);

		return liftOf(part);
	}

	let claimedHere = 0;
	for (const part of ordered) {
		if (taken.has(part)) claimedHere++;
	}

	logWarn(
		`[Round] team ${team}: ${ordered.size()} spawn part(s) for ${claimedHere + 1} body(s) — ` +
			`${body.Name} has no free one and is sharing a spot`,
	);

	return randomSpawn(ordered);
}

/**
 * **Frees the part `body` was given. Call it at the moment the body stops being a body.**
 *
 * The two callers are the two ways a body ends, and both are on the death edge: `RoundService.handleDeath`
 * for a player's character — every death, in a round or not, because a dead body holds nothing a round
 * wants — and `RespawnBehavior.onDied` for a rig, ahead of the rebuild so that a rig with no template to
 * copy still frees its part. A body that leaves without dying (a surrender, an AFK return, a player
 * leaving the game) is released by the round's own exits, and `clearArenaSpawns` is the backstop.
 */
export function releaseArenaSpawn(body: Model): void {
	spawnClaims.delete(body);
}

/**
 * **Every claim, gone. The round's end, and only that.**
 *
 * A claim is a fact about one round's arrivals, so the next round starts with the whole side available.
 * Called from `RoundService.finishRound` rather than from where the next round is assembled, for the
 * reason the `surrendered` set gives: an intermission that never ends would otherwise carry the
 * finished round's reservations into whenever it did end.
 */
export function clearArenaSpawns(): void {
	spawnClaims.clear();
}

/** The name of `team`'s spawn folder inside the arena. The labels are the folder names. */
function teamFolderName(team: TeamLabel): string {
	return team === TEAM_B ? ARENA_CONFIG.ARENA_TEAM_FOLDER_B : ARENA_CONFIG.ARENA_TEAM_FOLDER_A;
}

/**
 * **Where the rig `rig` should stand in the arena — the same rule, for the one caller that cannot ask the
 * round.**
 *
 * **`RespawnBehavior` is that caller, and it is why this function exists at all.** The behaviour rebuilds a
 * dead rig and has no service to call: it is constructed by `NpcService`, and `RoundService` is the service
 * that injects `NpcService`, so reaching back into the round would be a cycle at run time. The alternative
 * considered and rejected was teaching the behaviour a *list* of spawn parts at boot: the arena is a
 * permanent part of the place and its spawns are one Studio edit away from being replaced, so a cached list
 * is the last round's spawns — which is why `RoundService` re-reads them on every call and is the reason
 * this does too.
 *
 * **It claims, which is the change.** It used to be a second rule — its own walk of the same folders and a
 * `math.random` at the end — so a rig that died mid-round came back on a part somebody else might be
 * standing on, drawn without regard to where the balls were. Now the position and the reservation come from
 * {@link claimArenaSpawn}, so a rebuilt rig fills the arena exactly as its first arrival did, and the rig it
 * replaced has already freed the part it held (see the release in `RespawnBehavior`).
 *
 * **The lookup is the arena's contract, not a path.** `ArenaSpawns` with an `A` and a `B` inside it is part
 * of what a playable arena *is* — `ARENA_CONFIG` names both levels, `RoundService.arenaProblem` reports a
 * missing one before a round can open, and `shared/find.ts` states why the search is a search: somebody who
 * tidies the folders into grouping folders of their own has broken nothing. Only **direct** `BasePart`
 * children count, the same rule the round keeps, so "is this a spawn?" stays a question about one folder's
 * children in both places.
 *
 * **Nothing, rather than a fallback**, when the arena or the folder or the parts are missing. A caller has a
 * better answer in that case than a made-up point: `RespawnBehavior` falls back to where the rig was put,
 * which is exactly what it did before this existed. An origin here would put a rig at the centre of the
 * world with nothing to say why.
 */
export function arenaSpawnForRig(rig: Model, team: TeamLabel): CFrame | undefined {
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

	return claimArenaSpawn(rig, team, parts);
}
