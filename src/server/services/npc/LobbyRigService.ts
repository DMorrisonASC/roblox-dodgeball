import { OnStart, Service } from "@flamework/core";
import { CollectionService, Players, ReplicatedStorage, Workspace } from "@rbxts/services";
import {
	MATCH_JOIN_A_TAG,
	MATCH_JOIN_B_TAG,
	ROUND_STATE_ATTRIBUTE,
	ROUND_STATUS_FOLDER,
	SIDE_KEEP_OUT_A_TAG,
	SIDE_KEEP_OUT_B_TAG,
	TEAM_ATTRIBUTE,
} from "shared/constants";
import { ARENA_CONFIG } from "shared/config/arena.config";
import { NPC_CONFIG } from "shared/config/npc.config";
import { TRANSITION_CONFIG, TRANSITION_COVER_SECONDS } from "shared/config/transition.config";
import { findFolder } from "shared/find";
import { taggedPartsInWorkspace } from "shared/taggedParts";
import { MATCH_MAX_PER_TEAM } from "../../config/match.config";
import {
	BEHAVIOR_CATCHING,
	BEHAVIOR_DODGING,
	BEHAVIOR_PICKUP,
	BEHAVIOR_RESPAWN,
	BEHAVIOR_SEEKING,
	BEHAVIOR_THROWING,
	BEHAVIOR_WALK_TO_JOIN_PAD,
} from "../../npc/Behavior";
import {
	WALK_TO_JOIN_PAD_AT_ATTRIBUTE,
	WALK_TO_JOIN_PAD_ATTRIBUTE,
	WALK_TO_JOIN_PAD_LOOK_AT_ATTRIBUTE,
	WALK_TO_JOIN_PAD_SIDE_ATTRIBUTE,
} from "../../npc/behaviors/WalkToJoinPadBehavior";
import {
	RIG_NAMES,
	RIG_TEMPLATE_ATTRIBUTE,
	drawRigIdentity,
	poolModelWarnings,
	readRigPool,
	sourceOf,
} from "../../npc/rigPool";
import { rigsOnASide, sideOfRig } from "../../npc/rigs";
import { zoneCounts } from "../../npc/sideZones";
import { MatchService } from "../match/MatchService";
import { TEAM_A, TEAM_B, TeamLabel } from "../round/team";
import { NpcService } from "./NpcService";

/** The phase name `RoundService` publishes while a round is being played. A word between two files. */
const PLAYING = "Playing";

/**
 * The other phase name, and **also what an unpublished phase means**.
 *
 * Copied rather than shared for the reason `BallSpawnerService` gives about the same pair: the name is
 * published as text on an attribute and there is nothing importable to agree on. The default matters
 * more here than there — this service's first act on a missing or unreadable phase is to treat it as an
 * intermission, which is the answer that spawns rigs *in the lobby* rather than in the arena.
 */
const INTERMISSION = "Intermission";

/**
 * The two sides, for anything that has to ask about both.
 *
 * **Annotated rather than written inline, and that is not a style choice**: an unannotated
 * `[TEAM_A, TEAM_B]` infers `string[]` in this project's compiler settings, so `side` would arrive at
 * every method below as a `string` and no `TeamLabel` parameter would accept it. `RoundService` keeps a
 * `TEAM_LABELS` list of its own for the same reason.
 */
const SIDES: ReadonlyArray<TeamLabel> = [TEAM_A, TEAM_B];

/**
 * **The six behaviours a placeholder rig plays with**, and the whole of what makes it a player rather
 * than a prop standing on a sign.
 *
 * **The gated variants, not the `Always*` ones, and that is a requirement rather than a preference.**
 * `BEHAVIOR_THROWING` throws at an enemy it is facing, `BEHAVIOR_CATCHING` opens a catch window on half
 * the balls that come near it, and `BEHAVIOR_DODGING` dodges half of the balls aimed at it — so a rig
 * plays *like a person who is sometimes lucky*, which is the point of a stand-in. The `Always*` pair
 * would make a rig that catches everything and dodges everything, which is untouchable in a game about
 * hitting people with a ball, and would also mean a catch window that never closes and therefore a rig
 * that can never dodge at all — see `AlwaysCatchBehavior` for that.
 *
 * **Why these six and not fewer.** They are the whole of what an unarmed body needs to play: find a
 * ball (`SEEKING`), pick it up (`PICKUP`), throw it at somebody (`THROWING`), survive being thrown at
 * (`DODGING`, `CATCHING`), and come back after dying (`RESPAWN`). Each is a tag `NpcService` already
 * implements; this list is the only new thing, and it exists so that the set is written down once.
 *
 * **`RESPAWN` arriving with this set rather than at spawn is load-bearing, and it is not obvious.**
 * `RespawnBehavior.prepare` records the rig's *position* as the place a replacement comes back to, and it
 * records it on the first turn after the tag appears — so a rig given the tag while it stands in the lobby
 * would spend the rest of the session coming back to the lobby, including after a death mid-round. The tag
 * arriving here, at the far end of the round's cover, is what makes the recorded home the arena. **Adding
 * respawn to a lobby rig's spawn list therefore looks like the fix for a rig that stays down and is not
 * one** — see {@link retireHopelessCorpses}, which is where that case is actually repaired.
 *
 * **The pair that has to travel together.** `THROWING` never issues itself a ball — it throws the one
 * in the rig's hand — so a rig wearing it and neither `SEEKING` nor `PICKUP` spends the round empty
 * handed and silent. See `ThrowBehavior`'s file comment, which says so from the other side.
 *
 * **Annotated rather than inline, for `SIDES`' reason**: an unannotated array of constants infers the
 * element type rather than the intended one. And a plain `Array<string>` rather than a readonly one,
 * because it is handed straight to `NpcService.spawn`, which reads it and nothing else — the signature
 * wants a mutable array, and a copy made per call to satisfy a keyword would be a copy nobody needed.
 */
const GAMEPLAY_BEHAVIORS: Array<string> = [
	BEHAVIOR_CATCHING,
	BEHAVIOR_DODGING,
	BEHAVIOR_SEEKING,
	BEHAVIOR_PICKUP,
	BEHAVIOR_THROWING,
	BEHAVIOR_RESPAWN,
];

/**
 * The lobby's placeholder rigs: one per seat a match allows, spawned once at server start, each
 * walking to one side's join pad.
 *
 * **Why they exist.** A rig in this project is a placeholder for a player who has not arrived — it
 * holds a seat on a side and plays the round in their place. This service is the half of that which
 * puts them in the lobby: it draws a body and a name for it out of the pool in `ServerStorage` (see
 * `npc/rigPool.ts`, and see `spawnLobbyRig` for why the draw is per rig rather than once), stands each
 * rig at a lobby spawn, tells it which pad to walk to, and tags it with the one behaviour that walks it
 * there. The rig takes its own side when it reaches the pad — `WalkToJoinPadBehavior` writes
 * `TEAM_ATTRIBUTE` in its arrival branch — and from that moment `npc/rigs.ts` reports it as a
 * participant and the round counts it.
 *
 * **And this service is also what keeps the seats filled, which is the larger half of the job.** One
 * sentence says everything it maintains:
 *
 * > **every side accounts for `MATCH_MAX_PER_TEAM` seats, and a seat is held by a rig, by an opted-in
 * > player, or by a player a rig has just stood down for.**
 *
 * "Accounts for" is doing the work. A rig *walking* to its pad holds a seat — it has been told which side
 * it is for and nothing takes that away — while a rig that has *arrived* holds the same seat by a
 * different fact (`TEAM_ATTRIBUTE`), and the two are counted by different means so that neither is
 * counted twice. An opted-in player holds the seat their rig gave up; a player who has joined and not yet
 * touched a pad holds the seat a rig was destroyed for, which is what `pending` records.
 *
 * **Four things move a seat, and each has exactly one trigger.** A player *arrives* — a `PlayerAdded`,
 * and one rig stands down, so the lobby shows one fewer placeholder and one more person. A player
 * *chooses a side* — a roster change, read off `MatchService.rosterRevision` on a poll, with the
 * arithmetic below deciding what gives way. A player *leaves* — a `PlayerRemoving`, and the seat they
 * held comes back as a rig at once, in whichever form the phase calls for. And the *phase changes* — a
 * round starting or ending, which is when the whole picture is re-derived. All four end in the same
 * method: `rebalance`, which fills every short seat and empties every over-full one.
 *
 * **The one thing that is not a rebalance is a join, and that is deliberate.** A player walking into the
 * lobby has not chosen a side, so the arithmetic has nothing to say about which seat they will take —
 * and the requirement is that arriving *displaces somebody*, visibly, rather than leaving a ninth body in
 * a room built for eight. So `reserveSeat` destroys a rig outright, records which side it was holding,
 * and that record is then counted as a held seat until the player chooses. It is the only place in this
 * file that makes a decision the seat count cannot make for it.
 *
 * **Nothing here keeps a list of rigs, and that is the design rather than an omission.** The rigs are
 * derived on every use — the ones holding a side from `npc/rigs.ts`, the ones still walking from the walk
 * tag — so there is no collection to prune when a rig is destroyed and no stale entry to find later.
 * `Destroy()` is the whole of what removing a rig means: the body leaves the world, `NpcService` ends its
 * loop within one period (its own `model.Parent !== undefined` gate does it), and every derivation simply
 * stops returning it. What that costs is a tag walk per query where a stored list would be a lookup; at
 * eight rigs and a handful of queries a minute, it is not a price worth a second source of truth for.
 *
 * **Where a replacement appears is a phase question, and it is the visual constraint.** During an
 * intermission a rig is spawned at a lobby spawn and walks to its pad, exactly as the boot seeding does
 * it — a lobby full of rigs walking to signs is the normal state of the room, so a replacement is
 * indistinguishable from the others. During a round there is no time for a walk and no lobby to walk
 * from: the rig is spawned **in the arena, at its side's team spawn, with its side already written on
 * it**, and the round's own opening freeze is what hides the arrival. A body that appeared in the lobby at
 * the last second and ran for a pad would be a model being teleported twice, in view of everybody.
 *
 * **A rig holding a seat also has to *play*, and the six behaviours that means are the other half of the
 * phase rule.** A placeholder that merely stands on the field is a body the round counts and nobody
 * notices — which is what the log that prompted this said, plainly: eight rigs teleported into the arena,
 * standing there for a whole round, wearing the one tag that walks them to a sign. So a rig that is on a
 * side **and inside a round** wears the six gameplay behaviours (`GAMEPLAY_BEHAVIORS`: the gated catcher,
 * the gated dodger, seek, pickup, the gated thrower, and respawn), and a rig that is not wears none of
 * them. See `setGameplayBehaviors`, where the rule lives and where the timing of each edge is argued.
 *
 * **A service rather than a helper called from `main.server.ts`.** The boot seeding alone would be happy
 * as a plain function — except that a function cannot reach `NpcService.spawn`, the only thing in the
 * project that knows how to make a rig arrive under management, and `Flamework.resolve` to fetch a
 * service by hand would be a lookup dressed up as a function. What settles it is everything after the
 * seeding: four triggers, three pieces of bookkeeping and a poll, all of them about *these* rigs. That is
 * a service, and this is it.
 *
 * **The pads are found by their own tags**, through the same `taggedPartsInWorkspace` helper
 * `MatchService.mountSide` uses, so the two agree about which parts are pads by construction: the same two
 * constants and the same expansion rule. What is deliberately *not* shared is the destination — this
 * service reads a pad's position once and writes it on the rig (see `WalkToJoinPadBehavior`), so the walk
 * itself needs no opinion about tags, sides or the lobby.
 *
 * **It does read `MatchService`, for one thing: the roster.** A seat is held by a rig *or* by a player, so
 * half the arithmetic is "how many players are on this side" — and that answer lives in `opted` and is
 * published as `countsFor` and `roster`. What this service does *not* do is write to it: `opted` stays a
 * map of players, a rig's seat is never stored there, and the round's own idea of who is playing is
 * untouched by any of this. The dependency runs one way — this service reads the roster, and the roster
 * has never heard of it — which is what keeps the roster change a thing this *notices* rather than a call
 * it makes.
 *
 * **Nothing is pinned to a parent, and that is the requirement rather than a preference.** The pool
 * folder is found by name anywhere in `ServerStorage` and the lobby folder by name anywhere in
 * `Workspace`; the lookups below say what that costs and what it avoids. What it costs, stated once
 * here: a *name* is a contract with the place file, so a folder that has been renamed reads as a folder
 * that does not exist, and the boot line this service prints when it finds nothing is the only thing
 * that will tell you which name it wanted.
 *
 * **The lobby spawns are shared with the players, and neither side can reserve one.** A player joining
 * the server is placed at a random part of the same folder by `RoundService.lobbySpawn`, which knows
 * nothing about rigs — so a player and a placeholder can be sent to one part and arrive overlapping.
 * That is left in place rather than papered over: the fix belongs in the *player's* draw (skip a part a
 * rig is standing on), that draw is private to `RoundService`, and this task does not change it. What
 * the rig side can do is not make it worse, which is why the spawn loop hands out distinct parts while
 * the folder has enough of them; what remains costs two unanchored humanoids shoving each other off a
 * pad for a second, which is cosmetic.
 */
@Service()
export class LobbyRigService implements OnStart {
	/**
	 * The roster as this service last saw it: **who holds a player's seat, and on which side.**
	 *
	 * **Kept because one reader needs an answer that arrives too late to ask for.** A player leaving is
	 * `Players.PlayerRemoving`, and by the time that fires `MatchService` may *already* have taken them
	 * out of `opted` — both handlers are connected to the same event, and the order they run in is not
	 * something this file can know. So the seat a leaver held is read from this snapshot rather than from
	 * the roster, and the answer is the same whichever order the two handlers ran in.
	 *
	 * It is also what makes "the roster moved" a *change* rather than a state: `syncSeats` compares the
	 * revision and rebuilds this only when it has.
	 */
	private readonly seated = new Map<Player, TeamLabel>();

	/** The roster revision {@link seated} was taken at, so a tick that changed nothing costs one read. */
	private revision = -1;

	/**
	 * **The seats held for players who are present and hold no roster seat: the side, and nothing else.**
	 *
	 * A player joining the lobby displaces a rig — see `reserveSeat` — and that rig's side is written down
	 * here, because nothing else knows it: `MatchService` has never heard of a player who has not opted in,
	 * and a seat that has been given up is visible in none of the derivations. For a rig still walking,
	 * the side recorded is the one its destination was written for, which is the seat it was on its way to
	 * hold.
	 *
	 * **The other way a record is made is the roster letting go of a player who is still here** — a round
	 * ending and `MatchService.clear` emptying the roster. That path used to leave an opted-in player
	 * holding neither a roster seat nor a reservation, so the seat arithmetic spawned a rig back into the
	 * seat they were standing in; see `syncSeats`, where the carry-over lives and where the whole of that
	 * bug is written down. The two ways are one fact, and the name is the older half of it: the seat is
	 * pending *the player's choice*, which they may make whenever the pads are live — including during a
	 * round, where choosing is what puts them in it. See `RoundService.admitMidRoundJoins`.
	 *
	 * **There is no side-less entry, and that is a decision rather than an omission.** The only join that
	 * could produce one is a join with *no rig at all* to displace — a server with no rig pool or no
	 * lobby, which the boot line has already explained. Nothing was lost in that case, so there is no
	 * seat to hold: the record is simply not made, and the refill at the next boundary fills the lobby
	 * according to what is actually there. A reservation that meant "somewhere, maybe" would make
	 * {@link seatsHeld} wobble with the thing it was measuring.
	 *
	 * **A record in here counts as a held seat**, which is what stops the rebalance from spawning back the
	 * rig this player displaced a moment later. It is released the moment it stops being true: when the
	 * player appears in the roster, because they have taken a seat of their own, or when they leave.
	 */
	private readonly pending = new Map<Player, TeamLabel>();

	/** Where the next lobby rig stands, cycled over the folder's parts. Placement state, not a roster. */
	private spawnCursor = 0;

	/** The next pad of each side, cycled so a side's rigs spread across its signs. */
	private readonly padCursor = new Map<TeamLabel, number>();

	/** Faults already reported, so a refill that keeps failing says so once rather than every time. */
	private readonly reported = new Set<string>();

	/** The phase last seen, so a boundary can be told from a repeat. */
	private previousState = "";

	/** The round's status folder, held once it has been found. See `watchPhase`. */
	private statusFolder?: Folder;

	constructor(private readonly npcs: NpcService, private readonly matches: MatchService) {}

	public onStart(): void {
		// **The pool is read once, here, and no draw is made here.** The boot needs the *counts* — how many
		// names and how many models the place offers against how many rigs the match wants — while each spawn
		// draws its own, so that eight rigs come out with eight different names and eight different bodies.
		// The pool is derived from the live rigs rather than stored (see `npc/rigPool.ts`), so a snapshot kept
		// from boot would be stale by the time the first refill asked for it.
		const pool = readRigPool();
		const spawns = this.lobbySpawns();

		// **The pads, by tag, the same two the match service reads.** `taggedPartsInWorkspace` rather
		// than `taggedParts`, and the difference is the one thing that could make the two disagree: the
		// match service reads the whole DataModel, so a pad parked in `ServerStorage` is a pad it mounts
		// a sign on and this one will not stand a rig at. That direction is the safe one — a rig is only
		// ever placed at a pad somebody can walk to — and both sets are identical in a place whose pads
		// are in the world, which is the case they are for.
		const padsA = taggedPartsInWorkspace(MATCH_JOIN_A_TAG);
		const padsB = taggedPartsInWorkspace(MATCH_JOIN_B_TAG);

		// **One line, once, naming everything the place is missing.** The four faults are independent —
		// no pool folder in `ServerStorage`, no lobby spawn folder in the world, either side's pads
		// untagged — so reporting them one restart at a time would be four runs of "now do the next
		// thing". The entries are names rather than sentences, because what a reader has to do is create
		// a thing with that name. And **nothing is retried**: `RoundService.waitForLobby` holds an
		// intermission for as long as a lobby is missing, because a player with nowhere to stand is a
		// player in the wrong place, while eight absent placeholders are a lobby with no props in it.
		// Restarting after fixing the place file is the honest cost, and it is stated in the line itself.
		const missing = new Array<string>();

		// **The pool folder, when it holds no models at all — which is one fault and not two.** A folder that
		// exists but is empty is the same repair as a folder that is not there: put models in it. The names
		// are *not* in this list, deliberately: they live in this project's `rigPool.ts` and a place file
		// cannot be missing them, so a short name list is a warning after the loop starts rather than a
		// refusal to start.
		if (pool.models.size() === 0) {
			missing.push(
				`a "${NPC_CONFIG.RIG_POOL_FOLDER}" folder holding Model children inside ServerStorage`,
			);
		}

		if (spawns.size() === 0) {
			missing.push(
				`a "${ARENA_CONFIG.LOBBY_SPAWNS_FOLDER}" folder with BasePart children anywhere in Workspace`,
			);
		}

		if (padsA.size() === 0) missing.push(`a part tagged ${MATCH_JOIN_A_TAG}`);
		if (padsB.size() === 0) missing.push(`a part tagged ${MATCH_JOIN_B_TAG}`);

		if (pool.models.size() === 0 || spawns.size() === 0 || padsA.size() === 0 || padsB.size() === 0) {
			warn(
				`[Rig] no placeholder rigs — the place is missing ${missing.join(", and ")}. ` +
					`Nothing is spawned and nothing is retried; add it and restart.`,
			);

			return;
		}

		// **One rig per seat a match allows**, which is what "as many as the round can hold" means: the
		// cap is per side and the match is two sides, so the count is twice `MATCH_MAX_PER_TEAM` and
		// follows it wherever it is tuned. It is computed rather than written down — a second number
		// that agreed with the cap today is a second number that stops agreeing tomorrow.
		const count = MATCH_MAX_PER_TEAM * 2;

		// **What the pool holds, on one line, because every number in it is a question a reader is about to
		// ask.** This is the line that turns "the lobby looks half empty" into a place-file fact: a name list
		// and a folder are two independent supplies, and a reader who is told both counts beside the number of
		// rigs wanted can see which one ran out without opening a script. Nothing is retried and nothing is
		// reused, so what happens below is already decided by these two numbers.
		const poolNames = RIG_NAMES.size();
		const usableModels = pool.usableModels.size();

		// **Two model counts, because a folder and a pool are not the same size.** A model in the folder that is
		// not a rig is never drawn — see `rigPool.ts`'s `usableModels` — so the number that decides how full the
		// lobby is the *usable* one, and the folder's own count is beside it to say how many are being passed
		// over. A single count here would be the one number a reader could not check the outcome against.
		print(
			`[Rig] pool — ${poolNames} name(s), ${usableModels} usable model(s) (${pool.models.size()} in ` +
				`the folder) for ${count} rig(s)`,
		);

		// **A pool that cannot fill the lobby says so *before* it fails to, which is the only moment a line
		// about it is worth printing.** The alternative — letting the refusals in `npc/rigPool.ts` report one
		// spawn at a time — would say "no free name" eight times and never once say that the lobby is meant to
		// hold eight rigs, which is the number that makes the shortage legible. Both supplies are reported
		// because either can be the binding one, and the two have different fixes: names are edited in this
		// project's `rigPool.ts` and models are added to the place.
		//
		// **The model side counts the *usable* models**, because those are what a draw can hand out — a folder
		// of seven of which one is not a rig fills six seats, and a line claiming seven would be a number the
		// reader could watch be wrong.
		if (poolNames < count || usableModels < count) {
			const supplied =
				usableModels === pool.models.size()
					? `${pool.models.size()} model(s) available`
					: `${usableModels} model(s) usable out of ${pool.models.size()} in the folder`;

			warn(
				`[Rig] pool — ${count} rig(s) wanted, so the lobby will be short: ` +
					`${poolNames} name(s) and ${supplied}.`,
			);
		}

		// **A folder with two models of one name silently costs a model**, which is the one pool fault that is
		// invisible in the counts above: they are counted as two and only one of them can ever be drawn. The
		// source is recorded as a *name*, so the two are one source as far as a release is concerned — see
		// `RIG_TEMPLATE_ATTRIBUTE`. Reported rather than renamed, because renaming a place-file model is not
		// something this service can do and guessing which of the two was meant is not a guess worth making.
		if (pool.duplicatedNames.size() > 0) {
			warn(
				`[Rig] pool — ServerStorage."${NPC_CONFIG.RIG_POOL_FOLDER}" holds more than one model named ` +
					`"${pool.duplicatedNames.join('", "')}"; they share one source model, so only one of each ` +
					`will ever be drawn. Rename them.`,
			);
		}

		// **What the folder's models are carrying that they should not be.** A pool model is a template, not a
		// rig: anything dressed on it is inherited by every clone drawn from it, and one of those things (a
		// `ThrowerToken`) is actively wrong on a fresh body. `dressRig` runs on a rig before the world gate
		// that would ignore a parked model, so a template left in `ServerStorage` can pick up a trail it never
		// earned — which is why this reports rather than assumes. See `poolModelWarnings`.
		const inherited = poolModelWarnings(pool.models);
		if (inherited !== undefined) warn(inherited);

		for (let index = 0; index < count; index++) {
			// **Alternating, starting on A.** Rig 0 is A's, rig 1 is B's, and so on, so the two sides are
			// filled evenly as the loop goes rather than one after the other. An odd count would leave the
			// extra rig on **A**, which cannot arise at `2 × MATCH_MAX_PER_TEAM` and is written this way so
			// that a formula which could produce one already has an answer.
			//
			// **And the rig is built by the same call a replacement is**, which is the property worth
			// having: this is not a second way to make a lobby rig, it is the first eight of them. See
			// `spawnLobbyRig` for where the part comes from, why the placement is lifted, and why the walk it
			// hands over is four attributes rather than one.
			this.spawnLobbyRig(index % 2 === 0 ? TEAM_A : TEAM_B);
		}

		// **The one line that says it worked**, in the shape `[Match] up`, `[Zone] up` and `[Spawner] up`
		// already use. The counts are the diagnostic: a folder holding fewer parts than rigs is visible
		// here as a number smaller than the rig count, which is the case where two rigs share a spawn.
		//
		// **The fetch boxes are reported here and are never fatal**, which is the difference between them
		// and every other thing above: a place file is not something this service can repair, and the rigs
		// that cannot fetch are still rigs that hold a seat. **What a missing box costs changed on
		// 2026-10-13**, when the box stopped being a no-go region and became the region a side may fetch
		// from: it used to be a rig that walks at a wall and gives up, and it is now a whole side that never
		// fetches a ball — so the line is about a broken round rather than about an ugly one. They are also
		// the one part of this system a person paints on purpose — see `npc/sideZones` — so the server saying
		// whether it found them is the only way to know the painting took.
		const zones = zoneCounts();
		const missingZones = new Array<string>();

		if (zones.a === 0) missingZones.push(SIDE_KEEP_OUT_A_TAG);
		if (zones.b === 0) missingZones.push(SIDE_KEEP_OUT_B_TAG);

		if (missingZones.size() > 0) {
			warn(
				`[Rig] no part is tagged ${missingZones.join(" or ")} — a rig holding that side fetches ` +
					`nothing and stands still for the whole round. Tag one box on each side of the court, ` +
					`covering the floor a rig on that side can walk; the box is where that side may fetch from.`,
			);
		}

		print(
			`[Rig] up — ${count} placeholder rig(s), ` +
				`${spawns.size()} lobby spawn(s), pads ${padsA.size()} + ${padsB.size()}, ` +
				`fetch boxes ${zones.a} + ${zones.b}`,
		);

		// **The seat wiring, and it is behind the guard above on purpose.** With no rigs there are no seats
		// to keep and nothing a trigger could do about it; the boot line is what says why the lobby is empty.
		// Which model each rig came from is on its own spawn line rather than in this one, because there are
		// up to eight of them and they are no longer all the same model.
		//
		// **A join and a leave are engine events, and both are immediate.** `PlayerAdded` is what the
		// requirement calls "a player joins destroys a rig" — the observable is a lobby with one fewer
		// placeholder in it — and `PlayerRemoving` is "a player leaves spawns a replacement". Neither is
		// polled, because a body arriving in the lobby and a rig standing down are one moment, and a poll
		// would put a quarter of a second of a ninth body between them.
		Players.PlayerAdded.Connect((player) => this.onPlayerArrived(player));
		Players.PlayerRemoving.Connect((player) => this.onPlayerLeft(player));

		// **The phase and the roster are watched, and they are not the same kind of thing.** The phase is
		// a *boundary* — the moment a round starts or ends — so it is watched by signal, the same
		// `GetAttributeChangedSignal` `BallSpawnerService` watches. The roster is a *drift*: a player
		// touching a pad fires nothing this service can subscribe to without a constructor cycle, so it is
		// polled, and the poll costs one number read per interval. See `watchPhase` and `watchSeats`.
		//
		// Both are spawned rather than called: the status folder is made by `RoundService` and waiting for
		// it can yield, and `onStart` is the wrong place to hold the rest of the boot up.
		task.spawn(() => this.watchPhase());
		task.spawn(() => this.watchSeats());
	}

	// ---- The seat arithmetic ----

	/**
	 * **Every rig holding a seat on `side`, in the order that side should give them up.**
	 *
	 * Two derivations, deliberately, and the pair is the whole of "accounts for". First the rigs that have
	 * *arrived*: `npc/rigs.ts`'s list, which is a `TEAM_ATTRIBUTE` read and therefore only ever answers
	 * with a rig standing on a pad. Then the rigs still *walking*, which that read cannot see at all — a
	 * walker has no side on it yet, so its side is the one the spawner wrote beside its destination, and
	 * the check below drops anything that already has a `TEAM_ATTRIBUTE` so that an arrived rig is never
	 * counted in both.
	 *
	 * **The arrived ones come first because that is the order a seat should be given up in.** A rig
	 * standing on a sign is the placeholder a player can see; a rig still crossing the lobby is one nobody
	 * has been watching. When a side has to lose a seat, the body that goes is the visible one.
	 */
	private seatHolders(side: TeamLabel): Array<Model> {
		const holders = new Array<Model>();

		for (const entry of rigsOnASide()) {
			if (entry.team === side) holders.push(entry.rig);
		}

		for (const instance of CollectionService.GetTagged(BEHAVIOR_WALK_TO_JOIN_PAD)) {
			if (!instance.IsA("Model")) continue;
			if (!instance.IsDescendantOf(Workspace)) continue;
			if (sideOfRig(instance) !== undefined) continue;
			if (this.walkingSide(instance) !== side) continue;

			holders.push(instance);
		}

		return holders;
	}

	/**
	 * The side a rig is *walking* to, read from the attribute the spawner wrote beside its destination.
	 *
	 * Validated rather than trusted, for the reason `sideOfRig` validates its own read: this is a string
	 * on an instance, and anything can be on an instance.
	 */
	private walkingSide(rig: Model): TeamLabel | undefined {
		const label = rig.GetAttribute(WALK_TO_JOIN_PAD_SIDE_ATTRIBUTE);

		if (label === TEAM_A || label === TEAM_B) return label;

		return undefined;
	}

	/** How many players have opted into `side`, straight from the roster. */
	private playersOn(side: TeamLabel): number {
		const counts = this.matches.countsFor();

		return side === TEAM_A ? counts.a : counts.b;
	}

	/**
	 * The seats held for players who have not chosen a side yet, on `side`.
	 *
	 * **Every reservation names a side**, so there is no case that counts toward neither and no tie-break
	 * to argue about: see the field for why a join with nothing to displace records no seat at all rather
	 * than a side-less one. What that buys is a count that cannot wobble — the seat a joining player is
	 * holding is either this side's, or it does not exist.
	 */
	private pendingOn(side: TeamLabel): number {
		let count = 0;

		for (const [, reserved] of this.pending) {
			if (reserved === side) count++;
		}

		return count;
	}

	/**
	 * **The seat count: what a side accounts for. This is the predicate the whole file maintains.**
	 *
	 * A seat is held by a rig — arrived or walking — by an opted-in player, or by a player the lobby is
	 * holding a seat for (see `pending`, whose two ways of being written are one fact). The invariant the
	 * lobby keeps true is
	 *
	 * > `seatsHeld(side) === MATCH_MAX_PER_TEAM`, for both sides, whenever nothing is mid-flight.
	 *
	 * and the honest part of that sentence is *mid-flight*. A join destroys a rig in one frame and the
	 * player may take a minute to choose: for that minute one side's count includes a seat nobody is
	 * standing on, which is exactly what `pending` is for. Without it this query would read that side as
	 * short and hand the seat to a rig — and then the player would arrive on a side that was already full.
	 *
	 * **And the figure a person actually counts is the same invariant with the players subtracted.** A seat
	 * is a body and every body is either a person or a placeholder, so the lobby shows
	 * `MATCH_MAX_PER_TEAM × 2 − (everybody connected)`: eight seats and one player is seven rigs, eight
	 * seats and two players is six, and it does not matter *where* those players are standing — in the
	 * lobby, next to a join pad, or in a practice zone. That last one is worth stating because it is the
	 * case a reader expects to be an exception: a practice-zone player is still a person in the server, so
	 * they still cost the lobby a rig (counted here as an opted-in player if they opted in, and as a held
	 * seat if they never did), *and* they are still left out of the round by `RoundService`. The two rules
	 * are not in tension: a placeholder fills the seat of somebody who is not using it, and a practice-zone
	 * player is somebody who is not using it.
	 *
	 * **What it costs.** Two tag walks plus a few attribute reads per call, and one roster read. That is
	 * why it is not on a tick: it runs when the roster moves, when a phase changes and when a player
	 * leaves — a handful of times a minute — while the tick it *is* on reads one number.
	 */
	private seatsHeld(side: TeamLabel): number {
		return this.seatHolders(side).size() + this.playersOn(side) + this.pendingOn(side);
	}

	/**
	 * **A rig that is on a side over its cap moves to the side that is short, rather than being destroyed so
	 * that a replacement can be made for the other side.**
	 *
	 * **The two counts are the whole of the case.** A side holds `MATCH_MAX_PER_TEAM` seats and a rig holds
	 * one, so five rigs on A and three on B is not a full lobby with a body loose in it — it is a *body on the
	 * wrong side*, and the arithmetic that noticed is the same one that can put it right. Without this the
	 * repair is `releaseRigs` on the over-full side and a spawn on the short one: a rig destroyed, a model
	 * taken out of the pool, and a name spent, to move one body nine feet. With it, nothing is created and
	 * nothing is destroyed — the rig is told the other side and walks there.
	 *
	 * **Why a rig can be on the wrong side at all, since nothing here writes a side it was not told.** Every
	 * writer of `TEAM_ATTRIBUTE` on a rig uses the side its walk was given: the arrival branch in
	 * `WalkToJoinPadBehavior` reads its own `WalkToJoinPadSide`, and `spawnArenaRig` and
	 * `moveWalkersToArena` write their own loop variable. **A join pad cannot assign one either** —
	 * `MatchService.touched` returns before `optIn` for a body with no player, so a rig walking over the
	 * other sign does nothing at all. What is left is everything outside this repository's control: a flung
	 * body, a shove, or an attribute painted by hand in Studio. This method is the answer to those, and it is
	 * deliberately cheap enough to be an answer to them rather than a theory about them.
	 *
	 * **A move, not a swap, and the difference matters at the boundary.** The rig is stripped of its side and
	 * given the other side's walk, so it becomes a *walker bound for `short`* — which is exactly what
	 * {@link seatHolders} counts it as, so the next read of {@link seatsHeld} sees the repair. Sending it with
	 * its old side still on it would leave it counted on the side it just left until it arrived, and the next
	 * rebalance — a quarter of a second later — would move it back. That flap is the reason the side comes off
	 * first rather than at the end.
	 *
	 * **Intermission only**, and the caller is what decides that. During a round a rig's side is the round's
	 * business: the bodies are already on the field, the round has counted them, and walking one out of the
	 * arena to the other side's lobby pad would be a participant leaving mid-round. A side that is over its
	 * cap *during* a round is `releaseRigs`' case, which is a player having taken a seat — the one thing this
	 * cannot repair by moving somebody.
	 */
	private moveSurplusToTheShortSide(): void {
		// **One move per iteration, and the counts re-read each time**, because a move changes both numbers
		// and the case this fixes can be two bodies deep. `MATCH_MAX_PER_TEAM` is the bound rather than `while
		// (true)`: the largest surplus two sides can produce is one side's whole cap, and a loop that cannot
		// outrun its own arithmetic is worth more than a comment saying it terminates.
		for (let moved = 0; moved < MATCH_MAX_PER_TEAM; moved++) {
			const heldA = this.seatsHeld(TEAM_A);
			const heldB = this.seatsHeld(TEAM_B);

			if (heldA <= MATCH_MAX_PER_TEAM && heldB <= MATCH_MAX_PER_TEAM) return;

			const over = heldA > MATCH_MAX_PER_TEAM ? TEAM_A : TEAM_B;
			const short = over === TEAM_A ? TEAM_B : TEAM_A;

			// **Nothing to move to.** Both sides over their cap is the case this cannot help with: there is no
			// seat to walk to, so the surplus is `releaseRigs`' and the round's.
			if (this.seatsHeld(short) >= MATCH_MAX_PER_TEAM) return;

			// **The side's pads are the precondition, and a missing one is left to the boot line.** A rig
			// given a side and no destination would stand in the lobby wearing the wrong colour with nothing
			// telling anybody why, which is worse than the over-full side it started on.
			if (this.padsFor(short).size() === 0) return;

			const rig = this.surplusHolder(over);
			if (rig === undefined) return;

			rig.SetAttribute(TEAM_ATTRIBUTE, undefined);

			this.writePadWalk(rig, short);
			rig.AddTag(BEHAVIOR_WALK_TO_JOIN_PAD);

			print(`[Rig] ${rig.Name}: side ${over} is full — sent to ${short} instead`);
		}
	}

	/**
	 * **One rig to move off an over-full side: arrived, alive, and holding a side.**
	 *
	 * Which one is arbitrary and deliberately so. Every rig {@link seatHolders} reports for the side is a body
	 * the side is over capacity *because of*, so any of them is the right body to move — and unlike
	 * {@link releaseRigs}, which also has to pick one, nothing is destroyed by the choice, so there is no
	 * "giving up the wrong seat" to get wrong. It is taken from `rigsOnASide()` rather than from
	 * `seatHolders` so that a *walker* is never offered: a rig already on its way to a pad is not on a side
	 * yet, and sending it somewhere else would be a second instruction in the same crossing.
	 */
	private surplusHolder(side: TeamLabel): Model | undefined {
		for (const entry of rigsOnASide()) {
			if (entry.team !== side) continue;
			if (this.isDown(entry.rig)) continue;

			return entry.rig;
		}

		return undefined;
	}

	/**
	 * **The single mechanism: fill every short seat, empty every over-full one.**
	 *
	 * Everything that moves a seat ends here, and that is the point rather than a tidiness. Four triggers
	 * would otherwise be four places that each had to work out what the roster now implies, and the four
	 * would disagree the first time an event arrived twice — which they do: a player leaving bumps the
	 * roster revision *and* fires `PlayerRemoving`, and a round boundary publishes a phase *and* clears the
	 * roster. Running this arithmetic twice is a no-op the second time, which is a far cheaper property to
	 * rely on than an argument about which trigger got there first.
	 *
	 * **Over-full is the case a join cannot produce and an opt-in can.** A side holds four rigs and a
	 * player then opts into it: five bodies for four seats, so one rig stands down. That is
	 * {@link releaseRigs}, and the rig it takes is the first {@link seatHolders} offers — an arrived one,
	 * which is the placeholder actually standing on a sign.
	 *
	 * **What it deliberately does not do** is decide *which* seats. That is the invariant above, and a
	 * rebalance that started making judgement calls would be a second place the seat rules lived.
	 *
	 * **And it is where the count is allowed to change, so the rule belongs here: at a boundary, the count
	 * changes only while the cover is up.** A round start fills the short seats inside the arena's own
	 * transition — `refillAtRoundStart` waits the cover out before it runs — and a round end releases
	 * inside the intermission's. **A join and a leave are not boundaries**, and those two are deliberately
	 * uncovered: `reserveSeat` exists to make a rig stand down in the same frame a player walks in, so the
	 * lobby never holds a ninth body, and there is no cover at that moment to hide it behind. What the rule
	 * forbids is the thing the seat count used to do to itself after a round — spawn a rig at the reveal, in
	 * the open, to repair a seat nothing had actually freed. See `syncSeats` for that fix.
	 */
	private rebalance(): void {
		const playing = this.phase() === PLAYING;

		// **First, because a corpse nothing will rebuild is not a held seat — and both counts below are read
		// after it.** A body that is down counts toward its side's seats here (see `isDown`), on the grounds
		// that it is a body coming back: true of a rig wearing the rebuild behaviour, and false of one that is
		// not, which is the state a lobby rig and a rig killed across a round boundary are both in. Removing
		// the hopeless ones before the arithmetic is what makes the fill pass below see the seat as short and
		// put a live rig in it — in the same call, rather than at the next trigger. See
		// {@link retireHopelessCorpses}, and its doc for why the repair is not "leave respawn on".
		this.retireHopelessCorpses();

		// **Then the wrong-side repair, before the counts below are read — so that they read the repaired
		// lobby rather than the broken one.** A body moved here is counted as a walker bound for the other
		// side, so the fill and release passes below find nothing to do about a seat that has just been handed
		// over. Doing it after them instead would be a rig destroyed and a rig spawned in the same call, to
		// correct one number.
		//
		// **Intermission only**, for the reason `moveSurplusToTheShortSide` gives: during a round a rig's side
		// is the round's, and the bodies are already on the field.
		if (!playing) this.moveSurplusToTheShortSide();

		// **Both counts are read once, at the top, and reused.** They are what this call is *about* — the
		// one fact that decides which seats are filled and which rigs stand down — and reading them here
		// rather than twice inside the loops is what lets the refill's line below print the count that
		// *caused* the spawn rather than the repaired figure it produced.
		const heldA = this.seatsHeld(TEAM_A);
		const heldB = this.seatsHeld(TEAM_B);

		for (const side of SIDES) {
			const held = side === TEAM_A ? heldA : heldB;

			for (let seat = held; seat < MATCH_MAX_PER_TEAM; seat++) {
				const rig = playing ? this.spawnArenaRig(side) : this.spawnLobbyRig(side);

				// **A refill says so, and this is the line the file was missing.** Whether a seat was
				// filled is invisible everywhere else: `NpcService` prints a rig being *managed*, which
				// says nothing about why it exists, so a side that entered a round a body short left the
				// same trace in the output as one that did not. The figures are the ones read above, so
				// the line names the shortfall rather than the repair.
				if (rig !== undefined) {
					print(
						`[Rig] refill — ${rig.Name} to side ${side} ` +
							`(seats held before: A ${heldA}, B ${heldB})`,
					);
				} else {
					// **And a seat that stays empty says so, once per side.** This is the other half of the
					// line above, and it exists because the *absence* of that line was the only trace a
					// shortfall left: a lobby one body short looked exactly like one that had never been
					// meant to have the body, and the refusal that caused it is reported once per fault —
					// which for the pool is at boot, an intermission or two earlier. Naming the seat is what
					// ties the two lines together; the cause itself is `spawnLobbyRig`'s or `spawnArenaRig`'s
					// to state, and it has already said it somewhere above.
					this.reportOnce(
						`seat${side}`,
						`[Rig] ${side}: a seat is short and no body was made for it — the reason was ` +
							`reported once, in the line at boot or at the first attempt that failed`,
					);
				}
			}

			this.releaseRigs(side, held - MATCH_MAX_PER_TEAM);
		}
	}

	/**
	 * **Whether a rig is down: a corpse waiting for `RespawnBehavior`, or a body with no health to lose.**
	 *
	 * **A down rig still holds its seat, and that is why this exists at all.** Every test this file counts a
	 * seat by says yes about a killed rig: it is an `NPC`-tagged `Model` in `World` wearing a `Team`, so
	 * `npc/rigs.ts` reports it and {@link seatsHeld} counts it — and it *should*, because the seat is not free:
	 * `RespawnBehavior` is about to put a body back in it. What must not happen is a *destruction* choosing
	 * that body, and it is the first thing {@link seatHolders} offers.
	 *
	 * **What destroying a corpse costs, because it is not "a seat freed".** `RespawnBehavior.onDied` waits out
	 * `RESPAWN_DELAY_SECONDS` and then refuses to rebuild a rig whose `Parent` is gone — the corpse is where it
	 * reads the replacement's name and tags from. So destroying a down rig does not recycle a seat, it ends
	 * that rig for the rest of the session, and from a seat that reads as *"rigs die once and then stop
	 * fighting"*. The fix is here rather than in the count: the count is right, and the two callers that
	 * choose a body to destroy are what were wrong.
	 *
	 * **A rig with no humanoid counts as down**, because it can never be a participant and destroying it is
	 * how this file would otherwise have to notice.
	 */
	private isDown(rig: Model): boolean {
		const humanoid = rig.FindFirstChildWhichIsA("Humanoid");

		return humanoid === undefined || humanoid.Health <= 0;
	}

	/**
	 * **Retires every rig that is down with nothing left to stand it up, so the seat it is holding can be
	 * filled.**
	 *
	 * **The rule it repairs is `isDown`'s, one step further on.** A corpse counts toward its side's seats
	 * because a seat is not free while a body is coming back — `RespawnBehavior` waits
	 * `NPC_CONFIG.RESPAWN_DELAY_SECONDS` and rebuilds it. That argument is conditional, and the condition is
	 * the **tag**: `NpcService` dispatches `onDied` only to the behaviours a model wears, so a corpse
	 * without `BEHAVIOR_RESPAWN` has no rebuild scheduled and never will have one. It then holds its seat
	 * for the rest of the session — the refill never fires, because the seat reads as taken — and the body
	 * itself stays where it fell, in pieces if it never met `RespawnBehavior.prepare`, which is the one
	 * thing that sets `BreakJointsOnDeath` to `false`. The report this comes from is exactly that: a rig
	 * left permanently down, visible from the lobby, in pieces.
	 *
	 * **Two rigs are in that state and both are ordinary.** A **lobby** rig wears the walk tag and nothing
	 * else — see `spawnLobbyRig` — so it has no rebuild behaviour at any point in the intermission; and any
	 * side-bearing rig is in that state in the moment after a round boundary, because
	 * `setGameplayBehaviors(false)` takes the whole set off, rebuild behaviour included. A ball thrown out
	 * of the arena reaches both: the arena is inside the lobby, and a throw's range is wider than either.
	 *
	 * **Why the corpse is destroyed rather than left where it is.** Its *seat* is the reason it is here, and
	 * a body nothing will ever move is litter in a room people are standing in. Destroying it also tells the
	 * arithmetic the truth: the holder list stops returning it, so `rebalance`'s own fill pass puts a live
	 * rig in that seat in the same call, and `NpcService` ends the dead rig's loop on its next turn, since
	 * the loop's condition includes `model.Parent !== undefined`.
	 *
	 * **Why not simply leave `RESPAWN` on every rig instead — the obvious fix, and it is wrong.**
	 * `RespawnBehavior.prepare` records the rig's **position** as the place a replacement comes back to, and
	 * it records it on the rig's first turn wearing the tag. A rig given that tag in the *lobby* therefore
	 * spends the rest of the session coming home to a lobby spawn — including after a death mid-round, which
	 * is the exact fault `GAMEPLAY_BEHAVIORS` describes. The set arriving at the far end of the round's cover
	 * is what keeps that home in the arena, and recycling a hopeless corpse costs nothing that matters: the
	 * replacement is made at the moment it is wanted, in the form the phase calls for.
	 *
	 * **What this does not cover, stated rather than left to be found.** Only `rigsOnASide()` is walked, so a
	 * rig with **no side** — a hand-tagged practice rig — is outside this file entirely, and one of those
	 * without `Behavior_Respawn` is still a body that stays down. That is a tag to paint; see `TAGS.md`.
	 *
	 * **Idempotent, and it removes nothing that is standing.** A rig it has already retired is gone from
	 * `rigsOnASide()` on the next call, and the tag test is the whole of the decision — so a rig that *is*
	 * coming back is never touched, however long it lies there.
	 */
	private retireHopelessCorpses(): void {
		for (const { rig } of rigsOnASide()) {
			if (!this.isDown(rig)) continue;

			// **Wearing the rebuild behaviour: the body is coming back.** Taking the corpse away here is what
			// would cancel that, and it is the one thing this method must not do. See `isDown`.
			if (rig.HasTag(BEHAVIOR_RESPAWN)) continue;

			// **Said out loud, because a rig being retired is a rig the lobby has stopped counting.** The seat
			// is refilled in the same call, so the visible effect is one body replaced by another — and the
			// line is what says why the body that left could not have come back, rather than leaving a reader
			// to wonder whether a respawn was cancelled by something. `retireRig` prints it, since it is also
			// where the pool release is reported; the summary count this method used to print is gone with it,
			// because the lines now name the rigs and a count of them says strictly less.
			this.retireRig(rig, "retired — nothing was going to stand it up");
		}
	}

	/** Gives up `count` of `side`'s seats, beginning with the rigs standing on a pad. */
	private releaseRigs(side: TeamLabel, count: number): void {
		if (count <= 0) return;

		// **A body that is coming back is not a seat to take away.** See `isDown` for the whole of why: the
		// corpse is the first holder offered and was therefore the first one destroyed, and destroying it does
		// not free a seat — it cancels that rig's respawn permanently. This caller is the rarer of the two
		// that had the bug, because the seat arithmetic usually keeps a side at its cap; the one that fires in
		// an ordinary session is `victimForArrival`, where a player joining during an intermission stands down
		// "the first settled rig of the busiest side" — which is a corpse whenever a rig died in the last
		// seconds of the round that just finished.
		const holders = this.seatHolders(side).filter((rig) => !this.isDown(rig));
		let index = 0;

		while (index < count && index < holders.size()) {
			this.retireRig(holders[index], `released — side ${side} is over its cap`);

			index++;
		}
	}

	/**
	 * **The one place a rig leaves this service: destroys it, and says what went back into the pool.**
	 *
	 * **One helper for all three destroy sites, and that is the point rather than tidiness.** `releaseRigs`,
	 * `retireHopelessCorpses` and `reserveSeat` are three different reasons for a body to go, and the pool
	 * does not care which one it was: a rig ceases to hold its name and its model because it stopped being
	 * findable by the walk in `npc/rigPool.ts`, which is a property of being destroyed rather than of being
	 * destroyed *by a particular caller*. So the release itself needs nothing — and what is left is the
	 * **report**, which is the half a reader needs and the half that a fourth path would otherwise forget.
	 * Naming the rig and its source on one line per release is also what makes a lobby that has run short of
	 * names distinguishable from one that never had them: the draws are in the log beside the releases.
	 *
	 * **Both facts are read *before* the destroy**, on `reserveSeat`'s rule: an attribute does survive the
	 * `Destroy` in the same Lua frame, but reading a fact off a body on its way out is an order nobody should
	 * have to reason about. The name is read for the same reason rather than because it is at risk.
	 *
	 * **`what` is the caller's sentence and the pool's half is appended here**, so a caller cannot describe a
	 * release without also saying what it released — which is the failure mode a per-caller print would have.
	 */
	private retireRig(rig: Model, what: string): void {
		const name = rig.Name;
		const source = sourceOf(rig);

		rig.Destroy();

		print(
			`[Rig] ${name}: ${what} — ` +
				(source === undefined ? "no source model recorded" : `"${source}" back in the pool`),
		);
	}

	/**
	 * A player has arrived. **One rig stands down, and the seat it held is theirs until they choose.**
	 *
	 * **Nothing happens during a round**, and the reason is narrower than it used to be. A player arriving
	 * mid-round has not chosen a side, so there is nothing for a rig to stand down *for*: killing one would
	 * take a seat out of a round that is being played, and the player might spend the whole round in the
	 * lobby. **They are not locked out of that round, though** — the pads are live, and the moment they walk
	 * onto one they appear in the roster, which is the change this service polls for and which stands a rig
	 * down for them in the arena. So the seat is taken when the player *chooses*, not when they arrive, and
	 * before the pads were live during a round the second half of that never happened at all: a mid-round
	 * joiner was a spectator holding a seat with no rig left to fill it.
	 */
	private onPlayerArrived(player: Player): void {
		if (this.phase() === PLAYING) return;

		this.reserveSeat(player);
	}

	/**
	 * **Destroys one rig to make room for a player who has just arrived, and records the seat.**
	 *
	 * This is the one rule the seat arithmetic cannot derive, and it cannot be derived because the player
	 * has not chosen a side: "four seats a side" says nothing about which seat a new person will want. So
	 * the only honest reading of "a rig is a placeholder for a player who has not arrived" is that a
	 * placeholder makes way on arrival and the person then takes whichever seat they choose.
	 *
	 * **Which rig goes does not matter** — the user's answer, not this file's. What is left is to make the
	 * choice explicable and stable: a rig on the side holding the most settled bodies, preferring one that
	 * has *arrived* over one still walking. The busier side keeps the lobby balanced, and the body that
	 * vanishes is one standing on a sign rather than one crossing the floor.
	 *
	 * **A rig still walking still has a side to write down, and that is a correction to the prompt's own
	 * framing.** It has no `Team` — that is what "mid-walk is inert" means — but it does have the side its
	 * *destination* was written for, so the seat it was on its way to fill is exactly the seat it frees
	 * when it is destroyed. Recording that keeps the reservation side-bearing, which is what makes the
	 * side-ambiguous case collapse into nothing: see the field for why a join with no rig to displace
	 * records no seat at all.
	 */
	private reserveSeat(player: Player): void {
		const victim = this.victimForArrival();

		if (victim === undefined) {
			// Nothing to displace, because no rig exists at all — which the boot line already explains.
			// No rig was destroyed, so no seat was given up, so no seat is held: see the field.
			return;
		}

		// **Read before the destroy.** The attribute outlives the instance in the same Lua frame, but
		// reading a side off a body on its way out is an order nobody should have to reason about — and this
		// read is the reason the sentence is written down twice, here and on `retireRig`.
		const side = sideOfRig(victim) ?? this.walkingSide(victim);

		this.retireRig(victim, `${player.Name} arrived — stood down (${side ?? "no side known"})`);

		if (side !== undefined) {
			this.pending.set(player, side);
		}
	}

	/**
	 * The rig a player takes the seat of: **the busiest side's, and one that is standing on a pad.**
	 *
	 * A walking rig is the fallback rather than the first choice, because a walker holds no side yet — so
	 * taking its seat leaves nothing to write down (see `reserveSeat`) and the round boundary has to repair
	 * the side rather than the count. It is still better than nothing: the requirement is that arriving
	 * displaces a placeholder, and a rig crossing the lobby is one.
	 */
	private victimForArrival(): Model | undefined {
		const settled = rigsOnASide();

		let busiest: TeamLabel | undefined;
		let most = -1;

		for (const side of SIDES) {
			let count = 0;
			for (const entry of settled) {
				if (entry.team === side) count++;
			}

			if (count > most) {
				most = count;
				busiest = side;
			}
		}

		if (busiest !== undefined) {
			for (const entry of settled) {
				// **Never a down rig, and never the walker either.** A corpse is the first holder this list
				// offers, and destroying one does not free a seat — it cancels the respawn that was going to
				// put a body back in it. See `isDown`. A walking rig is the fallback below rather than the
				// first choice only because a body that has arrived is the more orderly thing to stand down;
				// the reason to prefer a live one over a dead one is the same reason in both lists.
				if (entry.team === busiest && !this.isDown(entry.rig)) return entry.rig;
			}
		}

		for (const instance of CollectionService.GetTagged(BEHAVIOR_WALK_TO_JOIN_PAD)) {
			if (!instance.IsA("Model")) continue;
			if (!instance.IsDescendantOf(Workspace)) continue;

			return instance;
		}

		return undefined;
	}

	/**
	 * **A player has left, and the seat they were holding comes back as a rig — at once.**
	 *
	 * The seat is found from this service's own records rather than from the roster, for the ordering
	 * reason {@link seated} gives. Three cases, and only two of them do anything:
	 *
	 * - **A spectator** — connected, never opted in, no seat held for them — leaves nothing behind. This
	 *   is the case the requirement names, and the one that would otherwise spawn a rig for somebody who
	 *   never played a round.
	 * - **A player holding a seat** — opted in when they left — frees the side they were on.
	 * - **A player a rig was stood down for**, who never chose, frees the side that rig was holding.
	 *
	 * and the three are told apart by whether a record exists at all, not by a truth test on its value:
	 * every record names a side, and the absence of one means the departure took no seat with it.
	 *
	 * **Why one rig is spawned here rather than a rebalance being called.** A leave frees exactly one seat
	 * and the records above say which, so the work is one spawn either way — and this is the path the
	 * requirement insists is *immediate*, which means it should not wait for the roster to catch up. A
	 * rebalance does follow a moment later, when the roster change lands: it finds the seat already
	 * filled, and does nothing.
	 */
	private onPlayerLeft(player: Player): void {
		const seat = this.seated.get(player) ?? this.pending.get(player);

		this.pending.delete(player);

		if (seat === undefined) return;

		const rig = this.phase() === PLAYING ? this.spawnArenaRig(seat) : this.spawnLobbyRig(seat);

		// **Named, because the rig count is not a thing anybody watching can see.** This path is both the
		// mid-round replacement and the lobby one, and in a round a body appearing where another left is
		// the only evidence that the seat was filled at the moment it was freed. A spawn that failed has
		// already said why, so this says that it was the seat that went without rather than repeating it.
		if (rig === undefined) {
			print(`[Rig] ${player.Name}: left — the seat on ${seat} is empty (no rig could be spawned)`);
		} else {
			print(`[Rig] ${player.Name}: left — ${rig.Name} takes the seat on ${seat}`);
		}
	}

	// ---- The phase, and the boundaries ----

	/**
	 * **Watches the phase. The two boundaries do different things, and only one of them is about timing.**
	 *
	 * `Intermission → Playing` is the boundary the requirement is specific about: the seats still short
	 * are filled **in the arena**, with the side already written on the rig, and the spawn is delayed to
	 * the cover — see {@link refillAtRoundStart} for the timing and for why a delay is the only way to
	 * reach it from this side of the boundary.
	 *
	 * `Playing → Intermission` is the reverse and needs no timing at all: a rig spawned at a lobby spawn
	 * and walking to a pad is what the lobby looks like anyway. Most of that boundary's work is not done
	 * here either — it is done a few seconds later, when `MatchService.clear` empties the roster and the
	 * poll notices, which is the moment the seats the players were holding become the lobby's again.
	 *
	 * **It is also the boundary where the rigs stop playing, and that half is one call.** Six behaviour
	 * tags come off every rig holding a side — see {@link setGameplayBehaviors} for what the set is, why
	 * it is stripped rather than left on, and why the walk tag that was taken off at the other boundary
	 * is not put back here.
	 */
	private watchPhase(): void {
		const folder = ReplicatedStorage.WaitForChild(ROUND_STATUS_FOLDER) as Folder;
		this.statusFolder = folder;

		// Seeded before subscribing, so the first change is compared against what the round was actually
		// doing rather than against an empty string — `BallSpawnerService`'s shape, for its reason.
		this.previousState = this.phase();

		folder.GetAttributeChangedSignal(ROUND_STATE_ATTRIBUTE).Connect(() => {
			const state = this.phase();
			if (state === this.previousState) return;

			this.previousState = state;

			// **Handed to its own thread rather than run here.** This fires inside whatever set the
			// attribute, which is `RoundService` mid-boundary: spawning rigs and reading rosters from
			// inside somebody else's frame is work with no business being synchronous with it, and nothing
			// here depends on being on that exact tick.
			//
			// **The round end is two statements and no timing, so it is written out rather than named.**
			// The order is the one thing worth stating: the behaviours come off *first*, so no rig is being
			// handed a fresh seat and a fresh target in the same breath as being told the round is over.
			if (state === PLAYING) {
				task.spawn(() => this.refillAtRoundStart());
			} else {
				task.spawn(() => {
					this.setGameplayBehaviors(false);
					this.rebalance();

					// **And the rigs walk to their pads, a cover's length later — because that is when the
					// round's own teleport has put them in the lobby.** `RoundService.returnRigsToLobby` moves
					// every side-bearing rig to a lobby spawn inside the intermission's transition, and
					// `transitionAround` either waits `TRANSITION_COVER_SECONDS` before moving anybody or moves
					// them at once — so a delay of exactly that length lands at or after the move in *every*
					// configuration, which is the whole property needed: issuing the walk before the move would
					// send a rig out of the arena on a straight line to a pad, through whatever is between them.
					task.delay(TRANSITION_COVER_SECONDS, () => this.sendRigsToTheirPads());
				});
			}
		});
	}

	/**
	 * **A pending seat is a seat during the intermission and nothing at all once the round starts.**
	 *
	 * The correction the seat model needed, stated as a rule because the model was right about the other
	 * half. While the lobby is open, a seat is held for a player who has just joined and has not chosen:
	 * they displaced a rig, and refilling that seat would put a ninth body in a lobby built for eight — so
	 * `pending` counts in {@link seatsHeld}, and the two agree for as long as the player might still walk
	 * onto a pad.
	 *
	 * **The round start is the moment that stops being true, and nothing tells the seat so.** The roster is
	 * taken at the whistle — `assignTeams` reads it once — so a player who has not chosen by then cannot be
	 * in the round that starts: the seat is empty of them, and a side holding it is a side one body short,
	 * which is exactly the 4-versus-3 the log showed.
	 *
	 * **And the drop is not the last word on the seat, which is the other half of the same rule.** The pads
	 * stay live during a round, so a player who did not choose before the whistle can choose during it: they
	 * appear in the roster, `syncSeats` spends the reservation, and `rebalance` stands a rig down in the
	 * arena for them — within its own quarter of a second, and on top of the round's own admission of them.
	 * So a released record is a seat the lobby has handed to a rig *for now*, not one that has been given
	 * up. See `RoundService.admitMidRoundJoins` for the other end of that.
	 *
	 * **So the records are dropped here, and the drop is what the refill then sees.** The alternative —
	 * teaching `rebalance` to ignore `pending` at round start — was rejected because the rule is not
	 * about rebalancing: `seatsHeld` is this file's definition of a held seat, and a definition that
	 * changes meaning depending on who is asking is how two callers come to disagree. What is true
	 * instead is that the *record* stops being a seat, which is a fact this method owns.
	 *
	 * **It runs inside `fill`, not on the phase change**, and that difference is visible. Dropped on the
	 * edge, the seat would read as short for the whole cover window — and `watchSeats` polls every quarter
	 * of a second, so a roster change inside that window would put a replacement body in the arena with
	 * the screens still open, which is the one thing the delay exists to prevent. Dropped here, the drop
	 * and the refill are one decision on one frame, behind the cover.
	 *
	 * **A player who did opt in is untouched**, and by construction rather than by a check: opting in puts
	 * them in the roster, `syncSeats` deletes the reservation of anyone in the roster, and the count then
	 * holds them as a player on their side — four, not three.
	 */
	private releasePendingSeats(): void {
		if (this.pending.size() === 0) return;

		const count = this.pending.size();

		this.pending.clear();

		// **Said out loud, because this is the one seat that changes meaning silently.** A reader of the
		// next log wants to know whether the round absorbed a reservation or ignored it, and the count is
		// the only place that is visible.
		print(
			`[Rig] round start — ${count} pending seat(s) released: the roster is taken at the whistle, ` +
				`so a player who has not chosen by now is holding nothing until they do`,
		);
	}

	/**
	 * **The round-start refill, timed to land behind the cover.**
	 *
	 * The requirement is exact about this one: a rig must not appear "out of nowhere right before the
	 * transition". The boundary publishes `Playing` and *then* runs `RoundService.transitionAround`, which
	 * closes the cover, moves everybody into the arena and holds them there — so the sequence reachable
	 * from here is: the phase changes, the cover takes `TRANSITION_COVER_SECONDS` to close, the bodies are
	 * moved, and the hold runs for `ARENA_FREEZE_SECONDS` measured from that move.
	 *
	 * **That is the whole of why the refill stays timed to the cover while the rigs' *playing* is timed to
	 * the freeze.** The two are not the same deadline and must not be merged into one. A body appearing is
	 * a thing to hide, and the cover is what hides it — but the cover is up for `TRANSITION_OPEN_SECONDS`
	 * (~2.7 s of these numbers) and the freeze lasts `ARENA_FREEZE_SECONDS` (5), so **the cover is gone
	 * long before the freeze is**. A spawn put at the freeze would therefore be a rig materialising in
	 * front of everybody, which is the one thing this timing exists to prevent; the sentence here used to
	 * claim the cover lasted the whole freeze, and it never did. Only the last step of the refill — the rig
	 * being handed something to do — is a *rule* rather than a picture, and it moves to the release.
	 *
	 * **Spawning on the phase change itself would put a body into the arena with the screens still open**,
	 * which is the one thing the timing exists to avoid: the lobby is *inside* the arena, so the team
	 * spawns are places a player in the lobby may well be able to see. Waiting a cover's length puts the
	 * spawn exactly where the teleport lands.
	 *
	 * **Why a delay rather than a hook.** The cover window belongs to `RoundService`, this task does not
	 * change that file, and there is no signal for "the teleport has happened". What there is, is the same
	 * number `RoundService` waits before moving anybody — `TRANSITION_COVER_SECONDS` is exported from
	 * `shared/config/transition.config.ts` for exactly this kind of reader, and it is *derived* from the
	 * grid rather than hand-copied — so waiting it out waits the same length as the round waits, from a
	 * moment one statement earlier.
	 *
	 * **Where it can lose, and what happens if it does.** These are separate timers, so the spawn can land
	 * a frame either side of the teleport. Before it: `teleportTeamsToArena` moves the new rig as well, to
	 * a random spawn of its own side — inside the arena, on the right side, behind the cover, so the
	 * outcome is identical. After it: the rig is already where it was put. Neither ordering is visible,
	 * which is why no epsilon is added: the race is real and harmless, and a fudge factor would be a second
	 * number pretending the two timers were one.
	 *
	 * **And a second wait, of a different length: the arena freeze.** The cover is not the last thing a
	 * round does before it is played. `RoundService.transitionAround` moves everybody, holds them where
	 * they land for `ARENA_CONFIG.ARENA_FREEZE_SECONDS`, and only then lets the clock go — and a rig has
	 * no share of that hold, because the hold is one named contribution in a *character's* speed sum
	 * (`WalkSpeedService`) and a rig has no such sum. Nothing the round does reaches a rig at all.
	 *
	 * **So the rig's half of the hold is here, and it is the withholding rather than a speed.** A rig with
	 * none of the six gameplay tags does nothing, which is the whole of what a held player does. That is
	 * the only mechanism that reaches it, and the reason it is *not* "write the rig's walk speed to zero"
	 * is worth keeping: a rig is not moved only by walking. `PickupBehavior` takes a ball within reach
	 * without moving, `CatchBehavior` opens a window without moving, `DodgeBehavior` dashes on a
	 * `LinearVelocity` a walk speed does not touch, and `ThrowBehavior` needs no movement at all — so a
	 * rig frozen to a standstill still picks up and throws, which is exactly the log this fixes. The other
	 * candidate, adding rigs to `holdArenaEntry`, would also mean the round holding a rig through a
	 * *speed* the rig does not have, which `holdArenaEntry`'s own doc refuses as a decision about NPCs
	 * rather than about who is in the round. See {@link setGameplayBehaviors} for the tag set and for the
	 * rest of the timing argument.
	 *
	 * **The length is read from the constant the round itself waits**, rather than asking the round when
	 * the freeze lifts. There is no signal for "the hold has ended" any more than there is one for "the
	 * teleport has happened" — see above for that argument — and `ARENA_CONFIG` is a shared module both
	 * readers already import, so this is one number in one place rather than a second timer carrying a
	 * copied duration. What it costs is what the cover's delay already costs: two timers a frame apart,
	 * harmless in either ordering, because the difference between them is a rig acting one frame before a
	 * player may move.
	 *
	 * **With transitions switched off there is no cover to hide behind**, so the cover's delay is skipped
	 * and the rigs appear when they appear — the same visibility every teleport at that boundary already
	 * has, because `transitionAround` does nothing at all in that configuration. **The freeze is not part
	 * of that, and neither is its wait**: the hold runs whether or not the wipe does — see
	 * `transitionAround`, which says a hold still runs with the cover off — so a rig is still withheld for
	 * `ARENA_FREEZE_SECONDS` in that configuration, measured from the move rather than from a cover that
	 * never closed.
	 *
	 * **And it is where a pending seat stops existing.** The first of the steps below is
	 * {@link releasePendingSeats}, which is the correction to the seat model this boundary needed: a seat
	 * held for a player who has not opted in is *not* held once the round starts. See that method for the
	 * argument; see {@link setGameplayBehaviors} for the last step.
	 */
	private refillAtRoundStart(): void {
		// **The order matters, and it is this way round deliberately.** The pending seats go first, because
		// they are what the refill is *about*; then the refill, so a seat nothing holds gets a body; then
		// the walkers, so every body holding a seat is on the field. Doing the walkers the other way round
		// would have them arrive in the arena and then be counted as held seats by the refill — the same
		// arithmetic either way, but this order means each step sees the world as the next one will.
		const fill = (): void => {
			this.releasePendingSeats();
			this.rebalance();
			this.moveWalkersToArena();
		};

		// **And the last step, which is the rig being handed something to do — after the freeze.** The three
		// above are about what the arena looks like when it opens, which is the cover's business; this one
		// is about when a rig may act, which is the *hold's*, and the two lengths are different. Measured
		// from the move, which is the same instant the round measures its own hold from, so the rig goes to
		// work on the frame the players are released rather than a wait of its own invention.
		const startPlaying = (): void => {
			fill();

			task.delay(ARENA_CONFIG.ARENA_FREEZE_SECONDS, () => this.setGameplayBehaviors(true));
		};

		if (!TRANSITION_CONFIG.ENABLED) {
			startPlaying();

			return;
		}

		task.delay(TRANSITION_COVER_SECONDS, startPlaying);
	}

	/**
	 * **Every seat-holder still walking is put on its side's spawn, behind the cover.**
	 *
	 * `RoundService.teleportTeamsToArena` moves the round's players and every rig that already has a side.
	 * **A rig on its way to a pad is two cases, not one, and the difference is whether it has played a round
	 * yet.** A rig the lobby spawned fresh has no side on it, so the round's teleport cannot see it: it would
	 * carry on walking through the opening seconds, take its side somewhere in the lobby part-way into the
	 * round, and be counted for that side while standing nowhere near the game. The seat would be occupied and
	 * the participant absent — which is a correctness problem rather than a cosmetic one, because the round
	 * decides a side's fate by counting the bodies on it. **A rig `sendRigsToTheirPads` re-tagged at the last
	 * round end is the other case, and it is invisible to that argument**: it keeps the `Team` it played the
	 * previous round with, so the round's teleport *does* move it, behind the cover and to the right spawn.
	 * What it needs is not a move but a strip — the walk tag and its lobby destination would still be on it,
	 * and the rig would set off out of the arena the moment its delay elapsed. The loop below gives both cases
	 * the strip and moves only the first.
	 *
	 * **So the refill's own rule is applied to it** — the arena, the side's spawn, the side written — plus
	 * the one thing a rig that is *moving* needs and a rig being created does not: **the walk is taken off
	 * it.** The tag and its destination still point at a lobby pad, and leaving them on would have the rig
	 * walk straight back out of the arena. The tag goes rather than the destination being cleared, because
	 * a rig with a destination and no walk is a rig that stands still and means nothing — and because that
	 * tag is what makes a rig a *placeholder on its way somewhere*, not what makes it a participant.
	 *
	 * **This is beyond what the brief asks for, and it is here because the alternative is worse.** The
	 * brief's round-start refill is about *creating* a body for a seat nothing holds; this is about a seat
	 * that *is* held, by a body that will not reach the field. It costs a rig its walk and gives the round
	 * the participant it has already counted, and it happens in the same cover window as everything else
	 * at this boundary.
	 */
	private moveWalkersToArena(): void {
		for (const side of SIDES) {
			for (const rig of this.seatHolders(side)) {
				// **Arrived, so the round's own teleport is about to move it** — and moving it twice would put
				// it at a second random spawn for no reason. **Its walk still has to come off, and that is not
				// the same statement.**
				//
				// A rig that arrived through the arrival branch wears no walk tag, so this strip is a no-op for
				// it. But a rig put back on a pad by `sendRigsToTheirPads` at the last round end *keeps its
				// `Team`* — that attribute is the seat it holds, and nothing here clears it — so between the tag
				// going on and the rig reaching its pad it is **both** a seat-holder and a walker. A round
				// opening inside that window teleports it with every other side-bearing rig and leaves the walk
				// tag on it, and the rig then walks out of the arena towards a lobby pad for the whole round with
				// nothing in the output to say why. The walk tag and its destination were only ever removed in
				// the arrival branch, so nothing else could have caught this.
				//
				// **The delay is what turns this from rare into ordinary, which is why it is fixed here rather
				// than reported.** Rigs used to set off the instant `sendRigsToTheirPads` ran and were on their
				// pads within a few seconds of a sixteen-second intermission; a ten-to-fifteen second wait means
				// a rig is still walking — or still waiting — for most of the window, so the round catching one
				// mid-walk is now the common case rather than the unlucky one.
				if (sideOfRig(rig) !== undefined) {
					rig.RemoveTag(BEHAVIOR_WALK_TO_JOIN_PAD);
					continue;
				}

				rig.RemoveTag(BEHAVIOR_WALK_TO_JOIN_PAD);
				rig.SetAttribute(TEAM_ATTRIBUTE, side);

				const parts = this.arenaSpawnParts(side);
				if (parts.size() === 0) {
					// **Named rather than skipped quietly**, and this is the one failure here that would
					// otherwise be invisible: the rig keeps its side and stays in the lobby, so the round
					// counts a participant that is not on the field and nothing in the output says why. The
					// message is `spawnArenaRig`'s, because the fault is the same one.
					this.reportOnce(
						`arena${side}`,
						`[Rig] no rigs on ${side}: "${ARENA_CONFIG.ARENA_NAME}" has no ` +
							`"${ARENA_CONFIG.ARENA_SPAWNS_FOLDER}" folder with BasePart children for ${side}`,
					);

					continue;
				}

				// **By the root part, like the round's own rig placement**, and for its reason: a model
				// with no `PrimaryPart` pivots at the centre of its bounding box, so `PivotTo` can put a
				// rig's feet in the platform.
				const root = rig.FindFirstChild("HumanoidRootPart");
				if (!root || !root.IsA("BasePart")) {
					this.reportOnce(
						`noroot${rig.Name}`,
						`[Rig] ${rig.Name}: no HumanoidRootPart, so it cannot be moved into the arena`,
					);

					continue;
				}

				root.CFrame = parts[math.random(0, parts.size() - 1)].CFrame.add(new Vector3(0, 3, 0));

				// **And the move is announced, because being put somewhere is a fact one behavior remembers
				// and cannot see.** `RespawnBehavior` read this rig's home while it stood in the lobby, and the
				// alternative to telling it is what the game did until now: a rig killed in a round came back
				// standing on its lobby spawn, off the field, with a side on it and nothing left that would
				// move it back in. See `NpcBehavior.onPlaced` and `NpcService.announcePlaced`.
				this.npcs.announcePlaced(rig);
			}
		}
	}

	/**
	 * **Every rig that holds a side walks back to a pad — the second half of `RoundService` putting it in the
	 * lobby.**
	 *
	 * `returnRigsToLobby` moves a side-bearing rig to a lobby spawn: a body in the right room, standing where a
	 * player arriving would stand. This turns that into the look the lobby is supposed to have — the rig walks
	 * to its side's join pad and stands on it — using {@link writePadWalk}, the same four writes `spawnLobbyRig`
	 * makes, plus the tag that makes the behaviour read them. One shared helper rather than a second way to make
	 * a lobby rig: the destination is what `WalkToJoinPadBehavior` reads, and the tag is what makes it read it.
	 *
	 * **The rig keeps its `Team`, deliberately rather than by omission.** The seat it holds is a fact about the
	 * side, this service counts it by that attribute, and the next round's opening whistle wants the same rigs
	 * on the same sides. So wearing a side *and* a walk is the ordinary state of a lobby rig between rounds —
	 * and it is safe, because the six behaviours that could act on the side are the ones this service has just
	 * taken off. **That pair is also the state `moveWalkersToArena` has to expect**, because a round can open
	 * while such a rig is still crossing the room; see that method for why the walk has to come off a rig that
	 * already has a side.
	 *
	 * **A pad is drawn per rig**, through `nextPad`'s rotation, so a side's rigs spread across its signs exactly
	 * as they do at boot. A rig whose side has no pads is skipped rather than left somewhere odd, and the boot
	 * line has already named that fault by then — and the skip is load-bearing here rather than tidy, because
	 * the tag below is what starts the walk and a rig wearing it with no destination spends the round warning
	 * about an attribute nobody wrote.
	 */
	private sendRigsToTheirPads(): void {
		for (const { rig, team } of rigsOnASide()) {
			if (this.padsFor(team).size() === 0) continue;

			this.writePadWalk(rig, team);

			rig.AddTag(BEHAVIOR_WALK_TO_JOIN_PAD);
		}
	}

	/**
	 * **The six gameplay behaviours, put on or taken off every rig that is holding a side.**
	 *
	 * The rule, in one sentence: **a rig on a side plays, and a rig on a side is the only thing that
	 * plays.** `npc/rigs.ts` already answers "is this rig on a side" — a model in the world whose
	 * `TEAM_ATTRIBUTE` reads `"A"` or `"B"` — and this method turns that answer into a tag set, which is
	 * the whole of `NpcService`'s interface. Nothing else about the rig changes: the six tags are the ones
	 * a place-file rig would be painted with and the behaviours behind them are registry entries
	 * `NpcService` already has. See `GAMEPLAY_BEHAVIORS` for what the set is and why it is the gated half
	 * of each pair rather than the `Always*` half.
	 *
	 * **What the set going off costs, and where it is paid: a corpse with no rebuild behaviour is a seat the
	 * lobby cannot fill.** A rig that dies while it wears none of the six — a lobby rig, which never wears
	 * them, or a rig killed in the moment after a round boundary — is a body nothing will ever stand up, so
	 * `isDown` counts it as holding its seat for the rest of the session and the refill never fires. That is
	 * what {@link retireHopelessCorpses} exists for, and it is why the answer is not to leave `RESPAWN` on
	 * permanently: see `GAMEPLAY_BEHAVIORS` for the home a replacement would inherit if it were.
	 *
	 * **Why a side is the whole test, and why the phase is not part of it.** A rig that has walked to a
	 * pad is holding a seat, and a lobby is not a game: with throw and seek on, a rig would hoof a ball
	 * around the lobby between rounds and `RespawnBehavior` would stand corpses back up. `detectEnemy` is
	 * already silent outside a round — it reads the published phase — but silence about *enemies* is not
	 * silence about everything, so the tags come off at the boundary. The one thing this does not cover is
	 * a rig that holds a side while standing in a room the arena is not: that is a side-bearing rig in the
	 * lobby, which `moveWalkersToArena` names when it happens and which no phase gate could repair.
	 *
	 * **Off is `RemoveTag` rather than a flag, and it takes effect on the rig's next turn.** `NpcService`'s
	 * loop asks `model.HasTag(behavior.tag)` for every behaviour on **every** turn — quoted in the report —
	 * so the set is read fresh each time and a tag that leaves stops being run with nothing to be told
	 * about it. This is also why the whole task is possible at all: the alternative reading (a set
	 * snapshotted when the loop started) would have made a mid-life tag change inert.
	 *
	 * **Why the tags go on after the arena freeze — not on the phase change, and not at the cover either.**
	 * Two reasons, and the second is the newer one.
	 *
	 * **The position, first.** One of the six writes down where the rig is: `RespawnBehavior.prepare`
	 * records the rig's position as the place a replacement comes back to, and it records it on the rig's
	 * first turn after the tag appears — a tenth of a second, not a cover's length. Added on the edge,
	 * every rig would record its **lobby pad** as home and then be teleported into the arena, so a rig
	 * killed mid-round would come back to the lobby as a side-bearing body the round counts and cannot
	 * find. Added here, it records the spot it is standing on when the round opens.
	 *
	 * **And the freeze, second, which is what moved this from the cover to the lift.** A rig on a side is a
	 * participant, and a participant may not act while the players are held: `RoundService` freezes every
	 * player for `ARENA_CONFIG.ARENA_FREEZE_SECONDS` from the landing, and a rig has no share of that hold
	 * — there is no speed sum for a rig to hold back — so a rig with these six on plays straight through
	 * the freeze. What it does in that window is not a small thing: the seek walks it to a loose ball the
	 * spawner has just put out, the pickup takes it, and the throw sends it at somebody while every human
	 * on the field is standing still. **Withholding the six is what stops that**, and it is the only thing
	 * that stops the rest of it too: a walk speed of zero would leave the pickup (which needs no movement),
	 * the catch, the dodge (which is a `LinearVelocity`, not a walk) and the throw all working. See
	 * {@link refillAtRoundStart} for the timing and for why the wait is read from the round's own constant
	 * rather than signalled from the round.
	 *
	 * **What the delay costs, named.** A rig is inert from the phase change until the freeze lifts, so
	 * nothing it wears in the six can run in the opening seconds — including `RespawnBehavior`, which means
	 * a rig that died inside the freeze would be a rig with nobody to bring it back. That is not reachable,
	 * and the reason is the window before it rather than a guard here: the round start follows sixteen
	 * seconds of intermission, every ball the round put out was destroyed on the intermission edge
	 * (`BallSpawnerService.cleanupRoundBalls`), and what a spawner puts out afterwards is loose and unarmed
	 * until somebody picks it up — which the six being off also prevents. Written down because the day
	 * something else can hurt a body in the opening seconds, this is the line to change.
	 *
	 * **The race that remains, stated rather than papered over.** This runs in the same frame as the
	 * round's own `moveEveryone`, and the two are unordered inside that frame; a rig whose loop happens to
	 * turn between them records the pad it is standing on rather than the arena spawn. What that costs is
	 * bounded and specific — a respawn point one room out — where the alternative is a delay invented to
	 * hide an ordering nobody can observe. What it does **not** cost is the seat: the rig holds its side
	 * from the moment the arrival branch wrote it, which is before any of this.
	 *
	 * **The state left behind is deliberate, and two rows of it are named.** A behaviour's per-rig row
	 * outlives its tag — the maps are module-level and nothing clears them — so a rig playing its second
	 * round arrives with the rows from the first. Most of that is stale but harmless: `CatchBehavior`
	 * re-decides once its window expires, `SeekBehavior` forgets a ball that has been destroyed or moved,
	 * and `RespawnBehavior` *wants* the home and template it took at the start of the life. **One is not
	 * harmless and is named rather than fixed here**: `ThrowBehavior`'s aim constraint is destroyed on a
	 * death and on losing the hand but **not** on losing the tag, so a rig killed mid-turn keeps an
	 * `AlignOrientation` on its root until its next turn with the tag back on — where an empty hand clears
	 * it.
	 *
	 * **The pad walk's own leftovers are not on that list, and both are worth naming because they were
	 * equivalent to them.** This doc used to say that `WalkToJoinPadBehavior.arrived` stayed `true` past a
	 * tag removal, which is why this method never puts the walk tag back; the flag is gone — the tag's own
	 * removal answers that question now — and the walk tag is not put back here because
	 * `sendRigsToTheirPads` owns that, a cover's length later, once the rigs are actually in the lobby.
	 * What replaced the flag is a *body* rather than a bool: a rig stopped mid-look keeps an
	 * `AlignOrientation` and a switched-off `Humanoid.AutoRotate`, and a rig mid-run keeps a `Sprint`
	 * contribution. Both are taken down by that behaviour's own watchdogs — a token-guarded timer per stage,
	 * re-armed on every turn it does get — rather than by anything here, which is the same fix
	 * `ThrowBehavior`'s windup uses for the same "nothing fires when a tag comes off" problem. **And the
	 * strip is no longer conditional on a side**: see `moveWalkersToArena` for the between-rounds rig that
	 * wears a side *and* a walk, which the start delay turned from rare into ordinary.
	 */
	private setGameplayBehaviors(on: boolean): void {
		for (const { rig } of rigsOnASide()) {
			let touched = false;

			for (const tag of GAMEPLAY_BEHAVIORS) {
				// Already in the state being asked for, which is the ordinary case for a rig the refill
				// spawned a moment ago: it was tagged at spawn, and this pass is what catches the rigs that
				// were already standing there.
				if (rig.HasTag(tag) === on) continue;

				if (on) rig.AddTag(tag);
				else rig.RemoveTag(tag);

				touched = true;
			}

			if (!touched) continue;

			// **One line per rig per boundary, and no summary line.** Two edges a round with eight rigs is
			// sixteen lines of a log that is read by a person looking for a rig that is not doing what it
			// should — so the per-rig line is the useful one, and a "N rigs" line above them would be a
			// second way to say the same thing. Not per tick, and not per tag: the transition is the event.
			print(
				`[Rig] ${rig.Name}: ${on ? "playing — six behaviours on" : "standing down — behaviours off"}`,
			);
		}
	}

	// ---- The roster, and the poll ----

	/**
	 * **Watches the roster, because a player choosing a side fires nothing this file can subscribe to.**
	 *
	 * `MatchService.optIn` writes the roster and bumps a revision. Calling into this service from there
	 * would be a constructor cycle — this service reads the roster, so the roster cannot read it back —
	 * and a signal beside the revision would be a second notification for a fact that already has one. So
	 * the revision is polled, and the poll is a single field read: the rest of {@link syncSeats} runs only
	 * on the turns where it moved.
	 *
	 * **It is also the only tick in the game that a *death* can be noticed on**, which is the newer half of
	 * its job. A rig killed with nothing left to rebuild it is not a roster event, so nothing else in this
	 * file would ever look at it again — see {@link retireHopelessCorpses}, which is swept on every turn of
	 * this loop for that reason, and is a humanoid read per standing rig.
	 *
	 * **The price is named: up to one interval** between a player touching a pad and the rig they displaced
	 * standing down, and up to one interval between a rig being killed with no rebuild behaviour and its seat
	 * being handed to a live one. See `NPC_CONFIG.SEAT_POLL_SECONDS` for why a quarter of a second is the
	 * figure.
	 */
	private async watchSeats(): Promise<void> {
		while (true) {
			task.wait(NPC_CONFIG.SEAT_POLL_SECONDS);

			// **The corpse sweep runs every turn, and not only when the roster moves.** It is the one thing
			// in this file that has to notice a *death* rather than a change to the roster, and a rig being
			// killed is not a roster event: a quiet round — which is most of a round — moves the revision
			// not at all, so `syncSeats` below returns on its first line and `rebalance` never runs. Without
			// this line a lobby rig shot from the arena would lie there for the rest of the round, which is
			// the report this fixes. Cheap by construction: a rig that is standing is one humanoid read, and
			// there are at most eight.
			//
			// **And it is here rather than at the top of `rebalance` alone** for the same reason — see that
			// method, which calls it too, so that a seat freed by it is filled in the same pass rather than a
			// quarter of a second later.
			this.retireHopelessCorpses();

			this.syncSeats();
		}
	}

	/**
	 * Takes the roster as it now stands and lets {@link rebalance} make the consequences true.
	 *
	 * **One read answers "did anything change", and only a change costs anything.** The revision is a
	 * number that only ever goes up and moves on every opt-in, side switch and clear — the same
	 * arrangement `RoundService`'s settle window uses for the same question.
	 *
	 * **The snapshot is rebuilt wholesale rather than diffed, and the clear is why.** Every intermission
	 * calls `MatchService.clear`, which empties the roster in one go — and the seats those players were
	 * holding are precisely the seats the lobby needs back. A diff would see "everybody left" and have to
	 * decide whether that was eight departures or one clear; a snapshot that is simply replaced makes the
	 * question disappear, because what matters to the rebalance is not who moved but how many seats each
	 * side now accounts for.
	 *
	 * **And the seats the clear takes away are carried over rather than dropped. That is the whole of the
	 * fix for the extra rig in the lobby.** `pending` used to be written in exactly one place,
	 * `reserveSeat`, which is a player *arriving* — so the record read as "a rig was destroyed for this
	 * person". A player who then opted in spent that record, correctly: the roster paid for their seat from
	 * that moment on. But when the round ended and `clear` emptied the roster they were left holding
	 * *neither* — not in the roster, and no reservation — so {@link seatsHeld} read their side as one short
	 * and spawned a rig for the seat they were standing in. **Every player who opts into a round ended it
	 * by leaving a placeholder behind**: one opted-in player in an eight-seat lobby is seven rigs before the
	 * round and eight after it, which is the report this comes from.
	 *
	 * **So a record has two ways of being made and one meaning: this player is here and holds no roster
	 * seat.** They arrive and a rig stands down for them, or the roster lets go of the side they were on.
	 * Both land in the same map, and the count cannot tell them apart — which is right, because the lobby
	 * cannot either: a player standing in it is a player standing in it whether or not they played the round
	 * that has just finished.
	 *
	 * **The alternative that was rejected: count *every connected player* instead of the roster plus these
	 * records.** It reads better as a sentence and it fails on the side arithmetic. A side's seats are
	 * filled by rigs standing at that side's pads, so a seat has to belong to a side before a rig can fill
	 * it — and a player who has not chosen one has no side for a rig to fill. Recording the seat at the
	 * moment its side is knowable (the rig they displaced) or was known (the side the roster had them on)
	 * is the same total with a side attached to every body, which is what makes `rebalance`'s per-side loop
	 * mean anything at all.
	 *
	 * **A player who has actually gone is not carried over**, and that is not bookkeeping. A record held for
	 * somebody who has left the server is a seat the lobby will never fill, so that side stays one rig short
	 * for the rest of the session. `onPlayerLeft` owns a departure — it puts a rig in the seat at once —
	 * and the connectivity test below is what stops this pass from undoing it.
	 *
	 * **A player who appears in the roster has chosen**, so any reservation held for them is spent — see
	 * `pending`. That is what makes "the player opts into the side a rig stood down from" cost nothing:
	 * the seat they take is the seat that was being counted for them a moment earlier.
	 */
	private syncSeats(): void {
		const revision = this.matches.rosterRevision();
		if (revision === this.revision) return;

		this.revision = revision;

		const roster = this.matches.roster();

		// **Read before the snapshot is replaced**, because the question this answers is what the roster
		// has *stopped* saying. A player it let go of is still standing in the lobby, so the seat they were
		// holding moves columns rather than ceasing to exist. See this method's doc for the whole of it.
		for (const [player, side] of this.seated) {
			if (roster.has(player)) continue;
			if (!player.IsDescendantOf(Players)) continue;

			this.pending.set(player, side);
		}

		this.seated.clear();

		for (const [player, side] of roster) {
			this.seated.set(player, side);
			this.pending.delete(player);
		}

		this.rebalance();
	}

	// ---- Making rigs ----

	/**
	 * **Writes a drawn identity onto a fresh rig: the name players read, and the model it came from.**
	 *
	 * **Both facts, one helper, because they are the two halves of one release and nothing else pairs them.**
	 * The name is a body's, and `npc/rigPool.ts` finds it used by reading the names of the live rigs; the
	 * source is the *recorded* half, and it is what makes the pool's model side findable, since a model is
	 * "free" exactly when no live rig names it. A caller that wrote one without the other would leak the
	 * other: a rig with a name and no source holds its model forever, and on a pool that is the whole
	 * folder's worth of models gone one spawn at a time.
	 *
	 * **Why an attribute holding a `Name` and not a reference** is argued where the attribute is declared, in
	 * `npc/rigPool.ts`: the short of it is that an attribute is the only channel that survives both a
	 * `Clone` (so a respawn keeps its identity) and a `Destroy` (so a release can be reported).
	 *
	 * **Called on the same resumption as the spawn and never later**, because there is no later moment that
	 * is obviously safe: `NpcService.spawn` starts the body's loop on the `NPC` tag it sets last, and
	 * `RespawnBehavior` snapshots the model it rebuilds from on the body's first managed turn. Whether that
	 * snapshot has already happened by the time this line runs depends on how the engine delivers
	 * `GetInstanceAddedSignal`, which nothing in this repository pins — so the write is made here, where the
	 * rig is at its youngest, rather than a resumption later where the question would be live.
	 */
	private nameRig(rig: Model, name: string, template: Model): void {
		rig.Name = name;
		rig.SetAttribute(RIG_TEMPLATE_ATTRIBUTE, template.Name);
	}

	/**
	 * **A rig for a seat, in the lobby: standing at a spawn part and walking to its side's pad.**
	 *
	 * The form a replacement takes during an intermission, and the same call the boot seeding makes — so
	 * the seeding is not a second way to build a lobby rig, it is the first eight of them. What it writes
	 * on the rig is the whole of the agreement with `WalkToJoinPadBehavior`, and it is four attributes
	 * rather than one because the walk can derive none of them from the others: the destination as a
	 * `Vector3`, the side as a `TeamLabel` (see `WALK_TO_JOIN_PAD_SIDE_ATTRIBUTE`), the other side's pad to
	 * turn to on the way, and the instant this rig may set off. All four go through {@link writePadWalk},
	 * which is the single site where they are drawn.
	 *
	 * **No `TEAM_ATTRIBUTE` is written here**, and that is what keeps a rig mid-walk out of the round: the
	 * rig takes its own side on arrival, and until then it is a body holding a seat and nothing more.
	 *
	 * **Two placements, two rules, and both are the round's own.** The spawn part is *cycled* rather than
	 * drawn, because rigs placed one after another would otherwise collide about half the time and a
	 * collision here is two bodies standing in one spot from the first frame; the pad is *cycled* per side
	 * so a side's rigs spread across its signs. The three-stud lift is `RoundService.lobbySpawn`'s, made
	 * for the round's reason: a body placed at the `CFrame` of the floor it stands on arrives half inside
	 * it, and an unanchored rig being pushed out by physics is not the standard this project holds
	 * placement to.
	 */
	private spawnLobbyRig(side: TeamLabel): Model | undefined {
		// **The draw comes before the placement, and the order is deliberate rather than convenient.** A
		// refused draw is a spawn that never happens: nothing has been placed, the spawn cursor has not moved
		// and there is no body to undo. See `npc/rigPool.ts` for why a pool short of names or bodies *refuses*
		// rather than reusing one, and for what each of its three refusals is telling a reader to go and fix.
		const draw = drawRigIdentity(readRigPool());
		if (!draw.ok) {
			this.reportOnce("pool", `[Rig] no rigs: ${draw.reason}`);

			return undefined;
		}

		const spawns = this.lobbySpawns();
		if (spawns.size() === 0) {
			this.reportOnce(
				"lobbySpawns",
				`[Rig] no rigs: no "${ARENA_CONFIG.LOBBY_SPAWNS_FOLDER}" folder with BasePart children is in Workspace`,
			);

			return undefined;
		}

		const pads = this.padsFor(side);
		if (pads.size() === 0) {
			this.reportOnce(
				`pads${side}`,
				`[Rig] no rigs on ${side}: nothing in Workspace is tagged ${this.padTag(side)}`,
			);

			return undefined;
		}

		const spawn = spawns[this.spawnCursor % spawns.size()];
		this.spawnCursor++;

		// **The walk tag and nothing else — a lobby rig wears no gameplay behaviour at all.** That is why a
		// lobby rig has no `RespawnBehavior` either, and why a lobby rig that is killed stays down as a corpse
		// until {@link retireHopelessCorpses} retires it: see `GAMEPLAY_BEHAVIORS` for why the tag cannot
		// simply be added here, which is the home a replacement would come back to.
		const rig = this.npcs.spawn(draw.template, spawn.CFrame.add(new Vector3(0, 3, 0)), [
			BEHAVIOR_WALK_TO_JOIN_PAD,
		]);

		this.nameRig(rig, draw.name, draw.template);

		// **The instructions go on after the rig exists, and that order is deliberate rather than incidental.**
		// `NpcService.spawn` starts the loop on the `NPC` tag, so the attributes are written one resumption
		// *after* the body is managed — which the behaviour tolerates by design: a rig wearing the walk tag with
		// no destination warns once and stands where it is, and this line does not yield, so the write lands
		// before anything could read that warning as a fault. The alternative — writing the attributes first —
		// would mean this service deciding how a rig comes into being, which is `NpcService`'s.
		this.writePadWalk(rig, side);

		// **One line per spawn, naming the rig, the name drawn and the model drawn** — the pattern every per-rig
		// line in this project keeps: an edge and never a tick. **It is the second line a spawn can produce**,
		// and deliberately: `rebalance`'s `refill` line and `onPlayerLeft`'s `takes the seat` line say *why* a
		// body was asked for, which is their callers' business, and this says *what* the body is, which is this
		// file's. The pair is what lets a lobby be read back — who arrived, and wearing which face.
		print(`[Rig] ${draw.name}: from "${draw.template.Name}" — lobby spawn, side ${side}`);

		return rig;
	}

	/**
	 * **A rig for a seat, in the arena: at its side's team spawn, with its side already on it.**
	 *
	 * The form a replacement takes during a round, and the whole of the difference from a lobby rig is
	 * what is *absent*: no walk tag, so nothing ever tries to move it, and no walk destination, so there is
	 * nothing for a behaviour to read. It is a participant from its first frame — the side is written
	 * before this returns — and it stands where the round's own teleport would have put a player.
	 *
	 * **The spawn point is found the way `RoundService` finds it**: the arena, then `ArenaSpawns`, then the
	 * side's folder inside it, then the direct `BasePart` children. That is a second copy of a search that
	 * file keeps private — `spawnFolderFor` and `teamSpawnParts` are module-private to a file this task
	 * does not change — and the duplication is named in the report beside the two this service already
	 * carries (`basePartsIn`'s rule and the lobby-folder lookup).
	 */
	private spawnArenaRig(side: TeamLabel): Model | undefined {
		// The same draw, from the same pool, under the same rule: see `spawnLobbyRig` for why it comes
		// before anything is placed, and `npc/rigPool.ts` for what a refusal means.
		const draw = drawRigIdentity(readRigPool());
		if (!draw.ok) {
			this.reportOnce("pool", `[Rig] no rigs: ${draw.reason}`);

			return undefined;
		}

		const parts = this.arenaSpawnParts(side);
		if (parts.size() === 0) {
			this.reportOnce(
				`arena${side}`,
				`[Rig] no rigs on ${side}: "${ARENA_CONFIG.ARENA_NAME}" has no ` +
					`"${ARENA_CONFIG.ARENA_SPAWNS_FOLDER}" folder with BasePart children for ${side}`,
			);

			return undefined;
		}

		const part = parts[math.random(0, parts.size() - 1)];

		// **The six gameplay tags go in through `spawn`, which is the order `TAGS.md` requires**: behaviour
		// tags first and `NPC` last, so the loop that starts on that last tag finds a finished rig rather
		// than one that is about to be handed something to do. Applying them here rather than leaving them
		// to {@link setGameplayBehaviors} is what makes a *mid-round replacement* fight — that pass runs on
		// a phase edge, and this rig arrives between two of them.
		const rig = this.npcs.spawn(draw.template, part.CFrame.add(new Vector3(0, 3, 0)), GAMEPLAY_BEHAVIORS);

		this.nameRig(rig, draw.name, draw.template);
		rig.SetAttribute(TEAM_ATTRIBUTE, side);

		// **Said out loud, because a rig that appears mid-round is otherwise indistinguishable from one
		// that was always there.** This is the ordinary path rather than a fault, so it is a print and not a
		// warning; it pairs with the `[Rig] refill` line when a seat was what asked for the body.
		//
		// **And the model the body came from, folded into the same line rather than given one of its own.**
		// This sentence exists to say the thing a reader cannot see; a separate line for the source would be
		// a second line for one event, and the two facts are read together anyway.
		print(`[Rig] ${draw.name}: from "${draw.template.Name}" — six behaviours on (${side}, arena spawn)`);

		return rig;
	}

	/**
	 * The join pads of `side`, by tag — read per spawn rather than cached, on the rule that every
	 * derivation in this file is live: a pad a builder adds, moves or untags mid-session is what the next
	 * rig is sent to, and there is no cache to go stale because there is no cache.
	 */
	private padsFor(side: TeamLabel): Array<BasePart> {
		return taggedPartsInWorkspace(this.padTag(side));
	}

	/** The tag a side's pads wear. The pair lives in `shared/constants.ts`, beside the round's own. */
	private padTag(side: TeamLabel): string {
		return side === TEAM_A ? MATCH_JOIN_A_TAG : MATCH_JOIN_B_TAG;
	}

	/** The next pad of `side` in the rotation, so a side's rigs spread over its signs rather than one. */
	private nextPad(side: TeamLabel, pads: Array<BasePart>): BasePart {
		const index = this.padCursor.get(side) ?? 0;
		this.padCursor.set(side, index + 1);

		return pads[index % pads.size()];
	}

	/**
	 * **The four writes that make a rig a placeholder on its way to a pad**: where it walks, which side it
	 * is walking to, what it turns to look at on the way, and the instant it may set off.
	 *
	 * **One writer, because the four are one instruction.** The destination and the side were already a pair
	 * written from a single decision — see `WALK_TO_JOIN_PAD_ATTRIBUTE` for why the side is not derivable
	 * from the point — and the look-at and the start instant are the same kind of thing: facts about the
	 * *lobby* that the behaviour cannot work out for itself, which is what keeps the two-tag join-part layout
	 * out of the machine that animates NPCs. Written out at four sites they would be four chances for a rig
	 * to be told to look at one side's sign while walking to the other's.
	 *
	 * **The delay is drawn here, per rig, and that is the whole of the staggering.** Two rigs cloned a
	 * moment apart in the boot loop must not set off in the same second, so the draw has to be per rig rather
	 * than one number per lobby — and it is re-drawn on every walk rather than once per rig, because the
	 * intermission that sends a rig back to its pad is a *fresh* walk and a rig that already waited once has
	 * no claim on going first again. What the two ends of the window are sized against is argued at
	 * `NPC_CONFIG.WALK_TO_PAD_DELAY_MAX_SECONDS`.
	 *
	 * **The look-at is drawn from the *other* side's pads**, through the same rotation the destination uses,
	 * so a rig turns to a sign that is really there rather than to a coordinate this file made up. A side
	 * with no pads has already been named by the boot line; a rig whose look-at is missing simply walks
	 * straight, because the behaviour drops the route rather than turning to face nothing.
	 *
	 * **The tag is deliberately not written here.** `spawnLobbyRig` gets it from `NpcService.spawn` — the
	 * call that makes the rig exist — and `sendRigsToTheirPads` adds it to a rig that is already in the
	 * world. Sharing that would mean this method deciding how a rig comes into being, which is the one thing
	 * `NpcService` owns.
	 */
	private writePadWalk(rig: Model, side: TeamLabel): void {
		const pads = this.padsFor(side);
		if (pads.size() === 0) return;

		const otherSide = side === TEAM_A ? TEAM_B : TEAM_A;
		const otherPads = this.padsFor(otherSide);

		rig.SetAttribute(WALK_TO_JOIN_PAD_ATTRIBUTE, this.nextPad(side, pads).Position);
		rig.SetAttribute(WALK_TO_JOIN_PAD_SIDE_ATTRIBUTE, side);

		if (otherPads.size() > 0) {
			rig.SetAttribute(WALK_TO_JOIN_PAD_LOOK_AT_ATTRIBUTE, this.nextPad(otherSide, otherPads).Position);
		}

		// **A uniform draw across the window, not a choice between its two ends.** `math.random()` with no
		// arguments is the half-open `[0, 1)` interval — see `MysteryBoxService` for the same note beside the
		// same call — which is what makes the multiplication below land anywhere in the span. The instant is
		// written on the *server's own clock* rather than as a duration, because the behaviour compares it
		// against that clock: a duration would be as stale as the moment it was sent, which is the same
		// argument `DODGE_READY_AT` makes for being an instant.
		const span = NPC_CONFIG.WALK_TO_PAD_DELAY_MAX_SECONDS - NPC_CONFIG.WALK_TO_PAD_DELAY_MIN_SECONDS;
		const delay = NPC_CONFIG.WALK_TO_PAD_DELAY_MIN_SECONDS + math.random() * span;

		rig.SetAttribute(WALK_TO_JOIN_PAD_AT_ATTRIBUTE, Workspace.GetServerTimeNow() + delay);
	}

	/**
	 * `side`'s arena spawn parts: the direct `BasePart` children of the side's folder inside the arena's
	 * `ArenaSpawns` folder, or nothing.
	 *
	 * **The structure is an interface rather than a place.** `ArenaSpawns` with an `A` and a `B` inside it
	 * is part of what a playable arena *is* — the names are shared config and the round cannot place a
	 * side without them — while where those folders sit inside the arena is searched for, so tidying them
	 * into a grouping folder breaks nothing. `RoundService` splits the two questions the same way.
	 */
	private arenaSpawnParts(side: TeamLabel): Array<BasePart> {
		const arena = Workspace.FindFirstChild(ARENA_CONFIG.ARENA_NAME);
		if (arena === undefined || !arena.IsA("Model")) return [];

		const spawns = findFolder(arena, ARENA_CONFIG.ARENA_SPAWNS_FOLDER);
		if (spawns === undefined) return [];

		const folder = findFolder(
			spawns,
			side === TEAM_B ? ARENA_CONFIG.ARENA_TEAM_FOLDER_B : ARENA_CONFIG.ARENA_TEAM_FOLDER_A,
		);
		if (folder === undefined) return [];

		const parts = new Array<BasePart>();

		for (const child of folder.GetChildren()) {
			if (child.IsA("BasePart")) parts.push(child);
		}

		return parts;
	}

	// ---- Odds and ends ----

	/**
	 * The phase the round is publishing, or the intermission.
	 *
	 * **The default is a decision rather than a fallback.** An unreadable phase means either that the
	 * status folder has not been made yet — this service's watcher is spawned and may not have run — or
	 * that nobody has published one. Both mean "no round is being played", and the intermission answer is
	 * the safe one: it is the phase in which a rig is spawned in the *lobby*, which is where a rig belongs
	 * when nobody is sure. The alternative would put a replacement body into the arena of a round that may
	 * not exist.
	 */
	private phase(): string {
		const folder = this.statusFolder ?? ReplicatedStorage.FindFirstChild(ROUND_STATUS_FOLDER);
		const value = folder?.GetAttribute(ROUND_STATE_ATTRIBUTE);

		return typeIs(value, "string") ? value : INTERMISSION;
	}

	/** One `warn` per distinct fault, so a refill that keeps failing says so once rather than every turn. */
	private reportOnce(key: string, message: string): void {
		if (this.reported.has(key)) return;

		this.reported.add(key);
		warn(message);
	}

	/**
	 * The parts to stand the rigs at: the direct `BasePart` children of the folder named
	 * `ARENA_CONFIG.LOBBY_SPAWNS_FOLDER` anywhere in `Workspace`.
	 *
	 * **`findFolder(Workspace, ...)` rather than the arena, and the difference is worth knowing.** The
	 * folder is settled *inside* the arena in every place file this project has, and `RoundService`
	 * looks for it there — it hands `findFolder` the arena model, because the arena is the thing it
	 * already holds. This service has no arena and wants none: it is told to find a `LobbySpawns` folder
	 * by name in the world, so it searches the world. `findFolder` walks `GetDescendants` of whatever
	 * root it is given, so **the two agree whenever there is exactly one folder of that name** — which
	 * is the place both are written for. Two of them is a place-file fault, and the tie-break differs:
	 * the round takes the arena's, and this takes the first in `GetDescendants` order, which is a
	 * top-level folder before a nested one. A rig standing in the wrong lobby is how that would show up.
	 *
	 * **Only direct `BasePart` children count**, which is `RoundService.basePartsIn`'s rule and is
	 * written twice now, for the same reason the folder's search is written twice: that helper is
	 * module-private to a file this task does not change. Both readers want the same set — "what counts
	 * as a lobby spawn" — so the two lines have to stay the same shape, and the report names the
	 * duplication.
	 */
	private lobbySpawns(): Array<BasePart> {
		const folder = findFolder(Workspace, ARENA_CONFIG.LOBBY_SPAWNS_FOLDER);
		if (folder === undefined) return [];

		const parts = new Array<BasePart>();

		for (const child of folder.GetChildren()) {
			if (child.IsA("BasePart")) parts.push(child);
		}

		return parts;
	}
}
