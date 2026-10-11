import { OnStart, Service } from "@flamework/core";
import { CollectionService, Players, Workspace } from "@rbxts/services";
import { RIG_TEMPLATE_TAG } from "shared/constants";
import { ARENA_CONFIG } from "shared/config/arena.config";
import { NPC_CONFIG } from "shared/config/npc.config";
import { BEHAVIOR_GATHERING, BEHAVIOR_RESPAWN, BEHAVIOR_THROWING } from "../../npc/Behavior";
import { lobbySpawnParts } from "../round/RoundService";
import { TEAM_A, TEAM_B, TeamLabel } from "../round/team";
import { NpcService } from "./NpcService";

/** Prints the spawn, and anything that stopped one from happening. */
const DEBUG = true;

/**
 * What a spawned rig does — the behaviour tags `NpcService.spawn` puts on every rig this service makes.
 *
 * **Three tags, and each answers a different part of "a match rig".** `Behavior_Gathering` is what moves it
 * between the three places its life is spent in: a join pad between rounds, its side's spawn on the court
 * while a round is on, and back to the lobby spawn it was placed on when the round ends (the whole of that is
 * below); `Behavior_Throwing` is what makes it fight, once a round is on and it has a side; `Behavior_Respawn`
 * is what gets it back up after it is killed, so a rig that dies mid-round is a rig the next round still has.
 * Nothing here is `Behavior_Catching`, `Behavior_Dodging`, `Behavior_Pickup` or `Behavior_Seeking` — a match
 * rig that also hoovered up loose balls or dodged would be a *different* game's NPC, and this is the one line
 * to change if one of those is wanted.
 *
 * **A list rather than a single tag per rig**, because a rig is a composition (see `Behavior.ts`): one tag
 * enables one mechanic, and "what a spawned rig is" is the set. It is passed straight to `spawn`, which
 * clears the template's own tags first, so this list *is* the rig's behaviour set and not an addition to
 * whatever the template happened to wear.
 */
const RIG_BEHAVIORS = [BEHAVIOR_GATHERING, BEHAVIOR_THROWING, BEHAVIOR_RESPAWN];

/**
 * How far above its spawn part a rig is placed, in studs.
 *
 * **The same lift `RoundService.lobbySpawn` gives a player, and for the same reason**: a body pivoted onto
 * the floor it is standing on arrives half inside it, so every spawn is a place to stand rather than a place
 * to intersect. A rig is placed by `PivotTo` exactly as a character is, so it needs exactly the same lift —
 * a number that is deliberately a copy rather than shared config, because the two are the same decision made
 * about two kinds of body and neither should move without the other.
 */
const RIG_SPAWN_LIFT = 3;

/**
 * Spawns the match's rigs, once, when the first player joins — and hands them to `NpcService`.
 *
 * **This is what makes `NpcService.spawn` live for the first time, and that is worth stating on the record.**
 * Until now every rig in the game was placed by hand in Studio, so the rig system had no opinion about where
 * a rig came from: the tag was the whole interface, `spawn` was a convenience with no caller, and
 * `RIG_TEAM_ATTRIBUTE` had exactly one writer (the gather behaviour, at a pad). A spawner changes all three
 * at once — it *decides* how many rigs exist, it *gives* them their sides through `spawn`'s fourth argument,
 * and it is the first thing in the game to depend on `spawn`'s contract (behaviour tags first, `NPC` last,
 * the side written before either). So a change to the tag order in `spawn`, or to the side write, now breaks
 * the game rather than a helper nobody called; and a rig this service makes is a rig the game plays with,
 * where before a rig only existed if a person had dragged one into the world.
 *
 * **A service rather than a method on `NpcService`, and the split is the point.** `NpcService` is a tag
 * runner that knows nothing about rounds, lobbies or matchmaking — that is the property its own doc claims,
 * and the reason a behaviour is a "thin caller". Spawning on a join, at a lobby spawn, in a number chosen
 * against `MATCH_MAX_PER_TEAM`, is *policy about the game*, and putting it in the runner would make the
 * runner know what a lobby is. This file owns the policy; `NpcService` still owns the rigs. The arrow
 * between them points one way — this one injects the runner, and the runner has never heard of this.
 *
 * **The first join is the only trigger, deliberately.** The alternative — every join adds its own rigs —
 * would mean a lobby filling with people *displaces* nothing and instead doubles the crowd, so a full server
 * would be eight rigs deep on top of eight players. Rigs are stand-ins for the people who are not there yet,
 * so the moment somebody is there is the moment the count is decided; adding more as the room fills is the
 * one thing that cannot help. The count is capped well below a full roster for the same reason — see
 * `NPC_CONFIG.RIGS_PER_TEAM`, which argues it against `MATCH_MAX_PER_TEAM`.
 *
 * **What "the return after the round" is, and why nothing here does it.** `RoundService` teleports the
 * *players* and deliberately leaves the rigs alone (its own boundary comment says a rig is the arena's
 * furniture and outlives a round), so a rig that has walked out to the court has to bring itself home — and
 * it does, through the same behaviour that took it out there: `GatherBehavior` walks a rig to its side's
 * spawn when a round opens and back to the lobby when the round ends, and the lobby spot it walks back to is
 * the spawn **this** service placed it on, recorded as the rig's home on its first turn. **The return is
 * already built and this service does not build a second one**: a `PivotTo` back to the spawn would be a
 * teleport doing the job a walk already does, and the walk is the one the gather behaviour makes anyway for
 * everything else it does. The only thing the spawner owes the return is the spawn part itself, which is why
 * a rig is placed on a real lobby spawn rather than at an arbitrary point.
 *
 * **And the return is no longer the *only* journey a rig makes**, which is worth saying here because this
 * paragraph used to describe the round start as the return: a rig now spends a round on the court and comes
 * home at the end of it. The rigs' sides, its post and the walk between the two places are all
 * `GatherBehavior`'s; what is decided here is only where a rig begins, which is what "home" then means.
 *
 * **The replacement check is not here, because there is nothing to check yet.** The task that swaps a rig
 * out for a mid-round joiner does not exist — nothing in the project reads a rig as replaceable, and no
 * attribute says one has been taken over — so *every* rig is a rig that was not replaced and every rig
 * returns. When that task arrives the seam is a per-rig flag (the obvious shape being an attribute on the
 * rig's model, set by whoever performs the swap) that `GatherBehavior` would read before walking it back;
 * until then a check here would be a condition with one branch.
 */
@Service()
export class RigSpawnerService implements OnStart {
	/** Whether the rigs have been spawned. The first join is the only trigger, so this is the latch. */
	private spawned = false;

	/**
	 * Whether a spawn attempt is already running.
	 *
	 * **A separate flag from {@link spawned}, because the two are true at different times and the gap is
	 * where a second join lands.** `spawned` is only set once the rigs are actually in the world, and the run
	 * between the first join and that moment can take as long as the lobby takes to appear; without this, a
	 * second player joining during that wait would start a second attempt and the server would get two sets
	 * of rigs. It is cleared if the attempt gives up (a missing template), so a later join can try again once
	 * the place has one.
	 */
	private spawning = false;

	/** The three warnings, each said once — the run loop asks again every second and must not repeat itself. */
	private warnedTemplate = false;
	private warnedLobby = false;
	private warnedTemplateInWorld = false;

	constructor(private readonly npcs: NpcService) {}

	public onStart(): void {
		Players.PlayerAdded.Connect((player) => this.onJoined(player));

		// Seeded, in case a player was already in the server when this service started — the same
		// scan-and-subscribe shape `NpcService` and `OutlineService` use for the same reason.
		for (const player of Players.GetPlayers()) this.onJoined(player);
	}

	/** The first join schedules the spawn. Every later one is answered by the latch. */
	private onJoined(player: Player): void {
		if (this.spawned || this.spawning) return;

		this.spawning = true;

		if (DEBUG) print(`[RigSpawner] ${player.Name} joined — the rigs are due`);

		// **Spawned rather than done inline, because the lobby may not exist yet and this must not yield.**
		// `onStart` is called inside `Flamework.ignite()` and a `WaitForChild` in it can block boot — the same
		// rule the HUD controllers and `OutlineService.followRound` keep, and the reason the waiting lives in
		// `run` instead. See that method for what it waits for and why it is allowed to wait indefinitely.
		task.spawn(() => this.run());
	}

	/**
	 * Waits until the place can host the rigs, then spawns them.
	 *
	 * **A loop rather than a one-shot lookup, and it is `waitForLobby`'s shape deliberately.** Both of the
	 * things this needs are place-file facts a person may not have set up yet — a `RigTemplate` somewhere out
	 * of the world, and parts in the lobby — and the project's answer to a missing place-file fact on a
	 * *boot path* is to hold and say so rather than to throw (the `LobbySpawn` afternoon, and the reason
	 * `RoundService.waitForLobby` exists at all). So this asks once a second, names what is missing the first
	 * time it is missing, and proceeds the moment both have turned up — which means a template dragged into
	 * `ServerStorage` mid-session is picked up without a restart, exactly as a lobby spawn added mid-session
	 * is. The cost of the loop is two lookups a second while it is *not* satisfied, which is nothing next to
	 * the alternative of a game that silently has no rigs.
	 */
	private run(): void {
		while (true) {
			const template = this.findTemplate();
			const parts = lobbySpawnParts();

			if (template !== undefined && parts.size() > 0) {
				this.spawnRigs(template, parts);

				this.spawned = true;
				this.spawning = false;
				return;
			}

			if (template === undefined && !this.warnedTemplate) {
				this.warnedTemplate = true;

				// Hoisted, because a template literal nested inside another compiles to an empty hole.
				const tag = RIG_TEMPLATE_TAG;

				warn(
					`[RigSpawner] no rig template — tag the rig to copy with "${tag}" and park it outside ` +
						`Workspace (ServerStorage). Nothing spawns until there is one.`,
				);
			}

			if (parts.size() === 0 && !this.warnedLobby) {
				this.warnedLobby = true;

				const folder = ARENA_CONFIG.LOBBY_SPAWNS_FOLDER;

				warn(`[RigSpawner] no "${folder}" parts yet — the rigs wait for the same folder the round does.`);
			}

			task.wait(1);
		}
	}

	/**
	 * The rig to copy — the first `RigTemplate`-tagged `Model` **that is not in `Workspace`**.
	 *
	 * **The world is inverted here, and that is the whole test.** Every other tag reader in this project
	 * filters *to* the world, because a tag on something that cannot be walked into or touched is a claim the
	 * world cannot honour. A template is the opposite case: it must be somewhere no player can see it, and a
	 * `RigTemplate` tag on a rig standing in the world is a mistake with a specific symptom — the rig would be
	 * copied *and* left standing, which is two rigs from one. So a tagged model inside `Workspace` is reported
	 * once by name and passed over rather than used.
	 *
	 * **Any tagged model will do, and the first is taken.** The class is checked (a tag is a string anybody
	 * can put on anything) but nothing else is: which `ServerStorage` folder it sits in is a person's choice,
	 * and the tag is the whole contract — the same reading `MATCH_SPAWNER_TAG` and `PRACTICE_ZONE_TAG` get.
	 */
	private findTemplate(): Model | undefined {
		let inWorld: Model | undefined;

		for (const instance of CollectionService.GetTagged(RIG_TEMPLATE_TAG)) {
			if (!instance.IsA("Model")) continue;

			// A template lives out of the world. This is the positive answer, so it returns immediately.
			if (!instance.IsDescendantOf(Workspace)) return instance;

			// Remembered so the mistake can be named once, without stopping the search for a real one.
			if (inWorld === undefined) inWorld = instance;
		}

		if (inWorld !== undefined && !this.warnedTemplateInWorld) {
			this.warnedTemplateInWorld = true;

			const tag = RIG_TEMPLATE_TAG;
			const name = inWorld.GetFullName();

			warn(
				`[RigSpawner] "${name}" wears ${tag} but is inside Workspace — a template must be out of the ` +
					`world, so it is being ignored. Move it to ServerStorage.`,
			);
		}

		return undefined;
	}

	/**
	 * Puts one rig on each lobby spawn part, up to `RIGS_PER_TEAM × 2`, half on each side.
	 *
	 * **One rig per part, and the parts are taken in order rather than at random.** `RoundService.lobbySpawn`
	 * picks a part at random *for a player*, because two players moved in the same frame must not land on
	 * each other; a rig is placed once, at a known moment, so the random pick has nothing to buy here and a
	 * deterministic walk keeps the spawn readable — rig *n* on part *n*. That also gives the two edge cases
	 * their shape for free: **fewer parts than rigs** spawns one rig per part and stops (fewer rigs, never two
	 * on a part), and **more parts than rigs** uses the first `RIGS_PER_TEAM × 2` and leaves the rest empty
	 * for players.
	 *
	 * **The sides alternate down the list**, so `A`, `B`, `A`, `B`… The order is the folder's own child
	 * order, which makes each side's two rigs land on neighbouring parts rather than all of one side at one
	 * end — the split that looks like two teams standing together rather than two queues. `spawn` writes the
	 * side itself, so a rig knows whose it is before its first tick and the gather behaviour walks it to the
	 * matching pad without having to choose.
	 *
	 * **A rig does not reserve its spawn part.** `RoundService.lobbySpawn` picks from *every* part with no
	 * occupancy test, so a player may be sent to a part a rig is already standing on; the two share it and
	 * the collision is accepted. Reserving would mean teaching the round's teleport which parts are taken,
	 * and that is a change to `RoundService`'s player teleport — out of scope here, and a bigger decision
	 * than a rig count should drag in.
	 */
	private spawnRigs(template: Model, parts: BasePart[]): void {
		const total = NPC_CONFIG.RIGS_PER_TEAM * 2;
		const count = math.min(parts.size(), total);

		for (let index = 0; index < count; index++) {
			const part = parts[index];
			if (part === undefined) continue;

			const team: TeamLabel = index % 2 === 0 ? TEAM_A : TEAM_B;
			const cframe = part.CFrame.add(new Vector3(0, RIG_SPAWN_LIFT, 0));
			const rig = this.npcs.spawn(template, cframe, RIG_BEHAVIORS, team);

			if (DEBUG) print(`[RigSpawner] ${rig.Name}: side ${team}, at ${part.GetFullName()}`);
		}

		// Said out loud rather than passed over, because "fewer rigs than expected" is exactly the thing a
		// person cannot tell from the seat: the rigs look fine, there are simply not as many of them. The
		// count of parts is the number they can act on.
		if (count < total) {
			const have = parts.size();
			const wanted = total;
			const made = count;

			warn(`[RigSpawner] ${have} lobby spawn(s) for ${wanted} rigs — spawned ${made}, one per spawn.`);
		}
	}
}
