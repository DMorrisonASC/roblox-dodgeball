import { ReplicatedStorage } from "@rbxts/services";
import {
	MATCH_JOIN_A_TAG,
	MATCH_JOIN_B_TAG,
	RIG_TEAM_ATTRIBUTE,
	ROUND_STATE_ATTRIBUTE,
	ROUND_STATUS_FOLDER,
} from "shared/constants";
import { resolveDodgeable } from "shared/dodge";
import { taggedPartsInWorkspace } from "shared/taggedParts";
import { TEAM_A, TEAM_B, TeamLabel } from "../../services/round/team";
import { BEHAVIOR_GATHERING, NpcBehavior } from "../Behavior";
// **A value import of the round service, which is the one arrow this file adds that the file above it did
// not have, and it is taken deliberately.** Where each side's arena spawns are is `RoundService`'s answer —
// `findArena` and `teamSpawnParts` are the two helpers the round's own teleport is built from — and a
// behaviour that looked the arena up for itself would be a second answer to "where does a round begin",
// which is the failure `shared/taggedParts.ts` exists to end. `lobbySpawnParts` is exported from the same
// module for the same reason and is read by `RigSpawnerService`; this is that pattern's second use, and it is
// what keeps the arrow one way: the round knows nothing about a rig, and a rig knows where the court is.
import { arenaSpawnParts } from "../../services/round/RoundService";
import type { MatchService } from "../../services/match/MatchService";

/**
 * The phase `RoundService` publishes while there is no round on.
 *
 * Written out here for the reason `ThrowBehavior` writes `"Playing"` out: `RoundState` is an enum inside
 * `RoundService`, the phase is a string the round publishes on `ReplicatedStorage`, and a reader of it
 * needs the folder and not the round. `TAGS.md` lists the strings two files have to agree on, and this is
 * one of them.
 */
const INTERMISSION = "Intermission";

/**
 * The phase `RoundService` publishes while a match is being played.
 *
 * The second of the two strings this file has to agree with the round about, written out here for the reason
 * {@link INTERMISSION} gives: the phase is published on a folder, and a reader needs the folder rather than
 * the round. `ThrowBehavior` spells this same word out for its own gate, and the two files asking the same
 * question have to give the same answer or a rig would walk to the arena in a round it refuses to throw in.
 */
const PLAYING = "Playing";

/**
 * How often the behavior looks at the rig, in seconds.
 *
 * **A look, not a step, and the division matters.** The walk itself is the humanoid's: one `MoveTo` sets a
 * destination and the engine walks the body there, so this interval only decides how often the rig is
 * checked for arrival and re-aimed. Half a second is the same cadence `SeekBehavior` retargets at, and for
 * the same reason — a destination that has not moved does not need to be re-issued, and re-issuing it every
 * frame is the same walk asked for sixty times a second.
 *
 * **Placeholder.**
 */
const GATHER_TICK_SECONDS = 0.5;

/**
 * How close to a destination counts as being at it, in studs — the pad, the lobby spawn, and the arena
 * spawn alike.
 *
 * **One radius for all three, because it is one question**: "is this rig where it was going?" The three
 * destinations differ in what they mean, not in how nearly a rig has to reach them.
 *
 * **An arrival radius rather than `MoveToFinished`,** which is the same choice `SeekBehavior` makes with
 * `BALL_CONFIG.PICKUP_RADIUS`: a humanoid that is *nearly* at its destination is at its destination, and a
 * signed-off `MoveTo` is a signal that can be missed or can fire for a walk that was replaced. The pad's own
 * size is not used, because what is wanted is "close enough to be standing at it" rather than "inside its
 * volume" — a rig pressed up against the edge of a pad is still at the pad.
 *
 * **Placeholder — 4.**
 */
const ARRIVAL_STUDS = 4;

/**
 * How much of the arena spawn part's own CFrame the rig aims at, standing on top of it, in studs.
 *
 * **The same lift `RoundService.getRandomTeamSpawn` puts on a player's spawn**, and for the same reason: the
 * spawn part *is* the spot, and a body placed at its centre is a body placed inside the floor. A rig aimed at
 * the part's own position instead would walk up to the part, be stopped by its own collision with it and
 * count as arrived four studs short — standing beside its post rather than on it. The two numbers have to
 * agree or the rigs and the players stand at different heights on the same spots.
 *
 * **Placeholder — 3.**
 */
const ARENA_SPAWN_LIFT = 3;

/**
 * How long a rig may try to reach its arena spawn before it is placed there instead, in seconds.
 *
 * **A stuck clock, not a round clock.** The timer is reset every tick the rig is standing at its
 * destination, so what it measures is "this rig has been trying and failing for this long" rather than "this
 * round has been on for this long" — a rig that arrives, is shoved off by a dodge or a ball, and walks back
 * therefore starts a fresh count rather than inheriting the time it spent standing still.
 *
 * **Why there is a fallback at all, given that a walk is what is wanted.** A `MoveTo` is a straight line on
 * the ground: it cannot open a door, jump a gap, or climb. **Whether the lobby and the court are connected
 * for a humanoid is a property of the place file and not of this code**, and no rig has ever walked between
 * them — every walk a rig has made so far has been inside the lobby, between a spawn part and a pad. If the
 * court is not reachable on foot, the honest failure is a rig pressed against a wall for the whole round, and
 * at ten seconds a round that costs nothing to find out: the `warn` names the rig and says what to look at,
 * and the rig is put at its post so the round is still one with fighters in it. The cost of being wrong the
 * other way — teleporting on a timer that is too short — is a pop on a walk that would have worked, which is
 * why the number is generous rather than tight.
 *
 * **Placeholder — 10.**
 */
const ARENA_WALK_TIMEOUT_SECONDS = 10;

/**
 * The range the per-round rotation's phase is drawn from, in parts.
 *
 * **A phase and not a part number, and that is what makes the pick uniform without knowing the folder.**
 * Every rig of a side this round takes `parts[(phase + index) % parts.size()]` — `index` counting the rigs of
 * that side that have set off — so the rotation cannot give two rigs the same spot, and the phase is what
 * stops the arrangement being the same arrangement every round. Drawing a *part* at random instead would
 * need the count at the moment the round starts and would put both rigs of a side on the same spot one round
 * in four; see the class doc for the whole argument.
 */
const ARENA_PHASE_RANGE = 1000000;

/** The round's status folder, or nothing before `RoundService` has made it. */
function statusFolder(): Instance | undefined {
	return ReplicatedStorage.FindFirstChild(ROUND_STATUS_FOLDER);
}

/** The phase the round is publishing, or nothing while it has published none. */
function phaseNow(): string | undefined {
	const value = statusFolder()?.GetAttribute(ROUND_STATE_ATTRIBUTE);

	return typeIs(value, "string") ? value : undefined;
}

/**
 * The side `model` fights for, or nothing if it has none.
 *
 * Read the same way `ThrowBehavior` reads it — the rig's own `RIG_TEAM_ATTRIBUTE`, validated because a
 * hand-set attribute can hold any string — so the two behaviors that care about a rig's side agree to the
 * letter about what one is. It is a separate copy of four lines rather than a shared helper for the reason
 * `shared/taggedParts.ts` gives about small readers with one caller each: the expression is trivial and what
 * needs to be identical is the *rule*, which is `RIG_TEAM_ATTRIBUTE`'s doc, not the function.
 */
function sideOf(model: Model): TeamLabel | undefined {
	const side = model.GetAttribute(RIG_TEAM_ATTRIBUTE);

	return side === TEAM_A || side === TEAM_B ? side : undefined;
}

/**
 * The pad tagged for `side`, or nothing if the place has none.
 *
 * **The tag is the only route to a pad, and that is why this is a lookup and not a read of `MatchService`.**
 * `MatchService` owns the pads and does expose this side-to-tag mapping — but only as `JOIN_PARTS`, a
 * module-private `const` inside that service, so what is public about a pad is the tag a person painted on
 * it and nothing else. Reading the tag is therefore not a workaround; it is the interface, and it is the
 * same one `BallSpawnerService` and `PracticeZoneService` use for the parts they act on.
 *
 * **`taggedPartsInWorkspace` rather than `taggedParts`**, which is the one place this differs from
 * `MatchService`'s own lookup. That service *prepares* a pad wherever it is found — it is dressing the part,
 * and a pad about to be parented should still be dressed. This behavior *walks a rig to* the part, which is
 * acting on it, and the rule for a reader that acts is the world filter: a pad parked in `ServerStorage` is
 * not somewhere a rig can stand. The expansion is `taggedParts`' own, so a tag on a folder of pads counts.
 */
function padFor(side: TeamLabel): BasePart | undefined {
	const parts = taggedPartsInWorkspace(side === TEAM_A ? MATCH_JOIN_A_TAG : MATCH_JOIN_B_TAG);

	return parts[0];
}

/**
 * Walks `root`'s rig toward `goal`, and answers whether it is standing there.
 *
 * **One function for all three destinations, because "go there" is one thing.** The pad, the lobby spawn and
 * the arena spawn differ in what they mean and in nothing else about how a rig is sent to them: within
 * `ARRIVAL_STUDS` the rig is *told to stay where it is* — `MoveTo` at its own position is the engine's own
 * "stand here", the trick `SeekBehavior.stand` uses — and outside it the destination is re-issued, which is
 * what notices a destination the engine has forgotten or a body that has been shoved off course.
 *
 * **Re-issued on every tick rather than once, and that is the re-aim for every destination alike.** A rig
 * that is knocked off its post, or whose `MoveTo` was replaced by another behavior's, is walked back at its
 * own next turn; the alternative is a rig that keeps a destination it took once, which is the same as a rig
 * that wanders for the rest of the round.
 *
 * The answer is returned rather than left to the caller's own distance test for the reason the same test
 * appears in three call sites: a second spelling of `root.Position.sub(goal).Magnitude <= ARRIVAL_STUDS`
 * is a second place for the radius and the arithmetic to drift.
 */
function walkTo(humanoid: Humanoid, root: BasePart, goal: Vector3): boolean {
	if (root.Position.sub(goal).Magnitude > ARRIVAL_STUDS) {
		humanoid.MoveTo(goal);

		return false;
	}

	humanoid.MoveTo(root.Position);

	return true;
}

/**
 * One round's trip to the court, for one rig.
 *
 * **A goal and a stuck clock, and no `arrived` flag.** Whether the rig is at its post is asked of its
 * position on every tick rather than remembered, which is what makes a rig shoved off its post walk back to
 * it instead of standing where it was pushed — and what makes the clock mean "trying and failing" rather
 * than "this has been going on a while".
 */
interface ArenaWalk {
	/** Where on the court this rig is headed — a spawn part's position, lifted by `ARENA_SPAWN_LIFT`. */
	goal: Vector3;

	/**
	 * `os.clock()` at the last tick the rig was *not* at its goal, so the age of this number is how long the
	 * rig has been trying to get there without arriving. See `ARENA_WALK_TIMEOUT_SECONDS`.
	 */
	since: number;
}

/** What one rig is doing about the pads and the court. Kept per rig, because a behavior is one object shared by all. */
interface Gather {
	/**
	 * The lobby spawn this rig calls home — where it is walked back to at the end of every round.
	 *
	 * **Recorded on the model's first turn and never rewritten**, which is a change from what this was.
	 * The old rule wrote it at the start of every gather walk and threw the whole row away once the rig had
	 * made it home, so `home` was really "where I was when I last set off" — a value that was correct only
	 * because the only walk there was began and ended in the lobby. Now that a rig spends a round on the
	 * court, "where I was when I last set off" is the *court* for a rig whose first turn was mid-round (a
	 * `RespawnBehavior` replacement is exactly that), and a rig that recorded the court as its home would
	 * never come back to the lobby again. The first turn is a moment this model has one of and cannot get
	 * wrong: a spawned rig's first turn is on the lobby spawn `RigSpawnerService` put it on, and a
	 * replacement's is on the spawn `RespawnBehavior` rebuilt it at.
	 */
	home?: Vector3;

	/** The pad the rig is walking to. Present means a gather walk is in progress. */
	pad?: BasePart;

	/** Whether the rig has reached {@link pad} and is now standing at it. */
	arrived: boolean;

	/**
	 * This round's trip to the court, or nothing when the rig is not on one.
	 *
	 * **Present means "sent this round", and that is the guard that makes the walk fire once.** It is set the
	 * moment a goal is picked — not when the rig arrives — so the pick happens on the rig's first `Playing`
	 * tick and every tick after it walks toward the same spot. Cleared when the rig is back in the lobby,
	 * which is what lets the next round pick a fresh one, and cleared with the pad state below for the reason
	 * given there.
	 */
	arena?: ArenaWalk;
}

/**
 * Gathering, for an NPC: **between rounds, stand at one of the matchmaking join pads; when a round starts,
 * walk to this rig's side of the court and stand at its post; when the round ends, walk back to the lobby
 * spawn it came from.**
 *
 * **The three destinations, and why a rig has to have all three.** A rig is the only thing in the game that
 * moves itself to where a round needs it — `RoundService` teleports the *players* and deliberately knows
 * nothing about a rig (see its boundary comment: a rig is the arena's furniture). So a rig with a side spends
 * its life moving between three places, and this behaviour is the whole of that: the **pad**, where it waits
 * and where the round's own minimum count can see it; its **post on the court**, where it fights; and the
 * **lobby spawn** the spawner put it on, which is where an intermission belongs.
 *
 * **What it used to do instead, because the old behaviour is exactly the bug this replaced.** The round start
 * used to walk a rig back to `home` — and `home` was the lobby spawn it had set off from, so the rigs spent
 * every round standing in the lobby, beside the spectators, carrying the balls they had been given and
 * throwing them at each other across the lobby floor. A round with rigs in it was a round with nobody on the
 * court at all. The fix is not a new destination but the realisation that *home and the court are two
 * different places*, and that "not an intermission" was never one instruction.
 *
 * **Why the pad is still part of it, now that a rig goes to the court to fight.** The pads are what
 * `MatchService` serves and what the round's minimum counts (`RoundService.rigsOnPads` asks, positionally,
 * whether a rig has come to play) — so the gathering half is not an intermission ornament: it is how a rig
 * *joins* a match, and a rig that went straight to the court from its spawn would never be counted as having
 * turned up.
 *
 * **Which court spawn a rig takes: a rotation with a per-round random phase.** Every rig of a side that sets
 * off this round takes `parts[(phase + index) % parts.size()]`, where `index` counts the rigs of that side
 * that have already set off and `phase` is drawn once when the round opens. The two halves are there for two
 * different reasons and neither is sufficient alone. **The rotation is what stops two rigs of a side standing
 * on one spot**: a plain random pick puts both of them on the same part about one round in four at the folder
 * sizes this arena has, and two bodies being pushed apart by their own collision, both facing the same way and
 * neither moving, read as a fault rather than as two fighters — while a rotation cannot collide at all until
 * a side has more rigs than it has spawns. **The phase is what stops the arrangement being the same every
 * round**, which is what a plain round-robin gets wrong: `index` alone puts the same rig on the same part
 * every time, so a person who knows the arena stops seeing the rigs arrive. Randomising the *starting point*
 * rather than the *choice* is also what lets the pick be uniform without knowing how many parts there are at
 * the moment the round opens — the modulo does that, and the count is then read from the folder only when a
 * rig is actually about to walk. **And it is per round, not per rig, for one reason above all:** a rig that is
 * killed and replaced re-enters through this same pick, so the phase is what stops a corpse's replacement
 * landing on the very spot the corpse is on.
 *
 * **What a rig does once it is at its post: nothing but stand there.** The court walk holds its position, and
 * then the rig is a *throwing* rig on a spot — `ThrowBehavior` is what looks for somebody to throw at from
 * where the rig stands, and it does not move its feet. Nothing here hunts for loose balls either, because
 * hunting is `Behavior_Seeking` and that is not one of the tags `RigSpawnerService` puts on a match rig; a rig
 * that should go and fetch a ball it cannot reach is a change to that list rather than a change here, and it
 * has its own question to answer (a seeker and this behaviour both issue `MoveTo`, and only one of them can
 * be in charge of a rig's feet at a time — see the registry's note on the order the two are placed in).
 *
 * **Why a behavior and not a new service.** The pads belong to `MatchService` and the timed work belongs to
 * a behavior, and the split has been the project's since the first behavior: a behavior is a *thin caller*
 * that decides when to act and asks a service to do it, and everything about running one — the loop, the
 * world gate, the freeze gate, the animator, network ownership, the per-behavior interval — lives in
 * `NpcService`. A `PadService` would have to scan `NPC` itself, own a loop per rig, and rebuild all of that
 * to answer one question the behavior already has answered for it. So this is one new file plus one line in
 * the registry, which is what adding a mechanic is supposed to cost; nothing in `flamework.build` changes,
 * because behaviours are plain modules and not decorated classes.
 *
 * **The counting rule, and why there is one at all.** A rig that already has a side walks to *its* side's pad
 * and nothing else is asked. A rig with no side — the case every rig placed by hand in Studio is in, since
 * nothing but `RigSpawnerService` passes a side to `NpcService.spawn` — is given one here, and the choice is
 * **not** a blind alternation:
 * alternating rigs `A, B, A, B…` on the strength of the rigs alone sends half of them to `A` even when two
 * players are already standing on `A`, so `A` ends up crowded and `B` bare, which is exactly the mechanical
 * look alternating was meant to avoid. So the side chosen is **the one with fewer occupants**, where an
 * occupant is a player on `MatchService`'s roster (read through `countsFor`) *plus* a rig this behavior has
 * already sent this intermission — and **the alternation is the tie-break**, so two rigs arriving together
 * at an empty lobby go one each rather than both to the same side. That is what "counts both" means here:
 * players are the ones the pads are *for* and rigs are the ones being placed, and a rule that counted only
 * one of the two would be wrong in exactly the case the other describes.
 *
 * **The side is written onto the rig, not merely walked to.** `assignSide` sets `RIG_TEAM_ATTRIBUTE` when it
 * picks, so the pad a rig stands at and the side it fights for are the same fact — otherwise a rig could
 * gather at `A` and then spend the round throwing at `A`'s rigs. This is the second writer of that key, and
 * a deliberate one: `NpcService.spawn` writes it for a rig a caller introduced with a side, and this writes
 * it for a rig that arrived without one. See `RIG_TEAM_ATTRIBUTE` for the representation.
 */
export function createGatherBehavior(matches: MatchService): NpcBehavior {
	/** One row per rig. See `onDied` for the row that goes with the rig it belonged to. */
	const walking = new Map<Model, Gather>();

	/** Rigs this behavior has sent to `A` since the intermission began. Paired with {@link sentB}. */
	let sentA = 0;

	/** Rigs this behavior has sent to `B` since the intermission began. See {@link sentA}. */
	let sentB = 0;

	/** The tie-break ticker: which side the *next* tied choice goes to. See the class doc. */
	let alternation = 0;

	/** Rigs of side `A` sent to the court since this round began. Paired with {@link arenaB}. */
	let arenaA = 0;

	/** Rigs of side `B` sent to the court since this round began. See {@link arenaA}. */
	let arenaB = 0;

	/** This round's rotation offset, drawn once when the round opens. See `ARENA_PHASE_RANGE`. */
	let arenaPhase = 0;

	/**
	 * The last phase seen, so the counters above are reset once at the top of a phase rather than
	 * accumulating across the whole session. A session-long tally would make the alternation drift against a
	 * lobby whose players had all left and come back, and the counts are only ever a fact about the phase they
	 * were gathered in.
	 *
	 * **Two edges, one guard, and they are reset at different ones because they are facts about different
	 * phases.** The gather counters belong to an intermission — they describe how full a pad was while the rigs
	 * were being placed — so they reset when an intermission opens. The court counters and the rotation's phase
	 * belong to a *round*, and the phase is drawn at the moment the round opens rather than when the first rig
	 * happens to set off, because the offset has to be one answer for every rig of that side and not a
	 * per-rig draw.
	 */
	let lastPhase: string | undefined;

	/** The rig's own row, made on first use. */
	const stateOf = (model: Model): Gather => {
		let state = walking.get(model);
		if (state === undefined) {
			state = { arrived: false };
			walking.set(model, state);
		}

		return state;
	};

	/**
	 * Which side to send the next side-less rig to: the emptier one, ties alternating.
	 *
	 * The player counts come from `MatchService.countsFor`, which is the roster the pads actually serve; the
	 * rig counts are this behavior's own, because a rig is invisible to `MatchService` — it has no `Player`,
	 * so it never opted in and never appears in the counts. Adding the two is the only way either side's real
	 * occupancy is known.
	 */
	const chooseSide = (): TeamLabel => {
		const counts = matches.countsFor();
		const a = counts.a + sentA;
		const b = counts.b + sentB;

		if (a < b) return TEAM_A;
		if (b < a) return TEAM_B;

		// Equal, so it does not matter which — and that is precisely when the alternation runs, so two rigs
		// reaching an empty lobby go one each instead of both to `A`.
		return alternation++ % 2 === 0 ? TEAM_A : TEAM_B;
	};

	/** Gives `model` a side and records it against that side's running total. See the class doc. */
	const assignSide = (model: Model): TeamLabel => {
		const side = chooseSide();

		model.SetAttribute(RIG_TEAM_ATTRIBUTE, side);
		if (side === TEAM_A) sentA++;
		else sentB++;

		return side;
	};

	/**
	 * The court walk: a rig with a side goes to its post, and stands there for the round.
	 *
	 * **Sent on the rig's first `Playing` tick and never re-picked**, which is the guard the class doc argues
	 * for: `gather.arena` being present *is* "sent this round", so the goal is chosen once and every tick
	 * after it re-issues the walk to the same spot. Picking per tick would walk the rig to a different spawn
	 * every half second, which is a rig that crosses the court in a straight line for the whole round.
	 *
	 * **A rig with no side is left where it is, and that case is now nearly unreachable.** A rig that has never
	 * been given a side throws at nobody (see `ThrowBehavior`), so it has nothing to do on a court and no court
	 * that is *its* — the pads are per side and so are the spawns, and a rig sent to `A`'s spawns while it
	 * fights for nobody would be standing in the wrong half of a match it is not in. `RigSpawnerService` always
	 * names a side, so a spawned rig never lands here; `GatherBehavior` gives a side to any rig it walks to a
	 * pad, so a hand-placed rig of this behaviour lands here only for the first round, before it has gathered
	 * once. Left as a return rather than an error because doing nothing is the correct behaviour for a rig with
	 * no side, and the missing half of the story — no rig template, no pads — is already said out loud by the
	 * service that owns each of those.
	 *
	 * **The pad is forgotten the moment the rig sets off**, which is the one line in here that is not about the
	 * walk. `arrived` is set when a rig reaches a pad and is only ever cleared by a new walk starting, so a rig
	 * that kept it across a round would come back to the lobby, decide it had already arrived somewhere, and
	 * stand at its spawn instead of taking up a pad — where the round's own minimum count could not see it, and
	 * the next round would never start. Clearing both here, at the moment the rig leaves for the court, is what
	 * makes the return trip end in a *new* gather walk rather than in the wreckage of the previous one.
	 */
	const walkToArena = (model: Model, humanoid: Humanoid, root: BasePart, gather: Gather): void => {
		const side = sideOf(model);
		if (side === undefined) return;

		let walk = gather.arena;

		if (walk === undefined) {
			const parts = arenaSpawnParts(side);

			// The arena has no spawns on this side. Nothing to walk to: the round's own boundary refuses to
			// start an arena like this (`arenaProblem` names the missing folder in the output), so a rig that
			// finds the list empty is standing in a round that could not have begun — and the honest thing is
			// to stay out of it rather than to walk somewhere arbitrary.
			if (parts.size() === 0) return;

			const index = side === TEAM_A ? arenaA++ : arenaB++;

			// **The rotation's slot, named rather than inlined, and that is not cosmetic.** Indexing a
			// roblox-ts array compiles to `parts[slot + 1]` — the compiler shifts the index, because a TS array
			// is 0-based and a Luau one is not — so an expression written inline inside the brackets lands in the
			// emitted Luau as `parts[(a + b) % n + 1]`, where correctness rests on `%` binding tighter than `+`.
			// It does, and nothing depends on it any more: the emitted line is `local slot = ...` and
			// `parts[slot + 1]`, which is the same instruction to a reader who is grepping `.luau` for a Studio
			// line number and does not want to be working out precedence to read it.
			const slot = (arenaPhase + index) % parts.size();
			const part = parts[slot];

			walk = {
				goal: part.Position.add(new Vector3(0, ARENA_SPAWN_LIFT, 0)),
				since: os.clock(),
			};

			gather.arena = walk;
			gather.pad = undefined;
			gather.arrived = false;

			humanoid.MoveTo(walk.goal);

			return;
		}

		if (walkTo(humanoid, root, walk.goal)) {
			// **Standing at the post, so the clock is not running.** Reset every tick the rig is there, which
			// is what makes the number's age mean "trying and failing" rather than "this round has been on a
			// while" — a rig that arrives and is then knocked off its post gets a fresh count to walk back,
			// rather than inheriting the time it stood still and being teleported home four studs.
			walk.since = os.clock();

			return;
		}

		if (os.clock() - walk.since < ARENA_WALK_TIMEOUT_SECONDS) return;

		// **The fallback, and it is deliberately the one teleport in this file.** See
		// `ARENA_WALK_TIMEOUT_SECONDS` for the argument; the short version is that whether the lobby connects
		// to the court on foot is a property of the place file that nothing here can know, and a rig pressed
		// against a wall for a whole round is the worse failure. Said out loud every time it happens rather
		// than once, because a walk that always fails is exactly the thing a person has to be told about —
		// and this line is the only place it is visible.
		warn(
			`[NPC] ${model.Name}: could not walk to its ${side} spawn in ${ARENA_WALK_TIMEOUT_SECONDS}s — ` +
				`put there instead. If this is every round, the court cannot be reached on foot from the lobby.`,
		);

		model.PivotTo(new CFrame(walk.goal));
		walk.since = os.clock();
	};

	return {
		tag: BEHAVIOR_GATHERING,
		tickInterval: GATHER_TICK_SECONDS,

		tick(model, humanoid) {
			// The part the rig is judged and moved by, through the helper a dodge, a catch and a throw all
			// ask the same question through, so "where is this rig" has one answer in the project.
			const root = resolveDodgeable(model)?.root;
			if (!root) return;

			const phase = phaseNow();

			// Reset the counters once, at the edge into a phase, before any rig is placed or sent. The guard
			// is `phase !== lastPhase` rather than a signal, and it is asked on every tick of every rig — the
			// first rig to tick after the phase moves does the reset, and every tick after that sees no change.
			if (phase !== lastPhase) {
				if (phase === INTERMISSION) {
					sentA = 0;
					sentB = 0;
					alternation = 0;
				}

				// **And the round's own counters where the round opens**, which is the second edge rather than
				// the same one — see `lastPhase`. The rotation's phase is drawn here rather than at the first
				// pick because it has to be one answer for the whole side: drawn per rig instead, two rigs
				// setting off in the same tick would be free to draw twice and land on two spots that were
				// meant to be one rotation apart.
				if (phase === PLAYING) {
					arenaA = 0;
					arenaB = 0;
					arenaPhase = math.random(0, ARENA_PHASE_RANGE);
				}

				lastPhase = phase;
			}

			const gather = stateOf(model);

			// **Where this rig calls home, written on its first turn and never again.** See `Gather.home` for
			// why it is the first turn rather than the start of the last walk, which is what it used to be.
			const home = gather.home ?? root.Position;
			gather.home = home;

			// ---- A round is on: to the court ----

			if (phase === PLAYING) {
				walkToArena(model, humanoid, root, gather);

				return;
			}

			// ---- No round: home first, then a pad ----

			// **Home first, and this is the return leg.** A rig that is out on the court when the round ends
			// comes back to the spot it was put in before it takes up a pad again, and the two legs are not the
			// same journey: the pad is where it *waits*, the lobby spawn is where it *lives*. Walking straight
			// to the pad would be one leg instead of two and would usually be the shorter of the two — but the
			// rig would then never return to its spawn, so every round would leave it a pace closer to the join
			// pads and the walk back would stretch a little further each time. The old behaviour had this shape
			// for free: its walk home ran at the *round start* and both ends were in the lobby, so "where I was
			// when I set off" was always a lobby spawn. It is the walk to the court that turns the return into
			// a leg of its own rather than the same one.
			if (!walkTo(humanoid, root, home)) return;

			// **Back in the lobby, so this round's trip is over.** Forgetting the goal at this end rather than
			// on arrival at the post is what stops a stale one being walked to next round: a rig that never
			// reached the court resumes its journey when the next round opens (its `ArenaWalk` survives, and
			// the goal with it), and a rig that did reach it is released from the journey here. Both are the
			// honest reading of "the rig is in the lobby with no round on".
			gather.arena = undefined;

			if (gather.pad !== undefined) {
				// A pad that has gone — the place edited under a running server — ends the walk rather than
				// being read for a position that is no longer meaningful. **The pad is forgotten rather than
				// the whole row**: the row now holds the rig's home, which it took on its first turn and which
				// nothing may rewrite, so throwing it away here would re-record home at wherever the rig is
				// standing. The next tick starts a fresh walk to whatever pad the tag now names.
				if (gather.pad.Parent === undefined) {
					gather.pad = undefined;
					gather.arrived = false;
					return;
				}

				// Arrived, and standing. `MoveTo` at its own position each tick is what keeps it there rather
				// than letting a stray destination from another behavior carry it off.
				if (gather.arrived) {
					humanoid.MoveTo(root.Position);
					return;
				}

				if (root.Position.sub(gather.pad.Position).Magnitude <= ARRIVAL_STUDS) {
					gather.arrived = true;
					humanoid.MoveTo(root.Position);
					return;
				}

				// Still walking. Re-issued rather than left alone, because this is the tick that notices a
				// destination the engine has forgotten or a body that has been shoved off course; the arrival
				// test above is what ends it.
				humanoid.MoveTo(gather.pad.Position);
				return;
			}

			// No walk yet, so start one: the rig's own side if it has one, otherwise a side chosen for it.
			const side = sideOf(model) ?? assignSide(model);
			const pad = padFor(side);

			// No pad tagged for that side. Nothing to walk to and nothing to report that a rig could act on —
			// the pad's own count line (`MatchService`'s `[Match] up — <tag>: N part(s)`) is where a missing
			// pad is said out loud, which is the same division `BallSpawnerService` makes.
			if (pad === undefined) return;

			// **And no write to `home` here, which is where it used to be written.** A walk starting is not a
			// rig arriving anywhere, and the rig's home is the lobby spawn it was put on — a fact this
			// behaviour takes once, on the model's first turn, and never revises. See `Gather.home`.
			gather.pad = pad;
			gather.arrived = false;

			humanoid.MoveTo(pad.Position);
		},

		/**
		 * The rig's row goes when the rig does.
		 *
		 * A behavior is shared, so a row keyed by a model is a reference *to* that model: a corpse that
		 * `RespawnBehavior` is about to replace would otherwise keep the rig it belonged to alive for as long
		 * as the server runs. Nothing in the row is carried across — a replacement is a different model, and
		 * it makes a fresh row on its own first turn, exactly as `SeekBehavior` explains for its own.
		 */
		onDied(model) {
			walking.delete(model);
		},
	};
}
