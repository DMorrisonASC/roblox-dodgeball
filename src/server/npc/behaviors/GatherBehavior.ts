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
 * How close to a destination counts as being at it, in studs — the join pad, and the post on the court.
 *
 * **One radius for both, because it is one question**: "is this rig where it was going?" The two differ in
 * what they mean, not in how nearly a rig has to reach them. The two destinations that are *placements* — the
 * lobby spawn a rig came from and its post on the court — do not use this radius to arrive at all: a rig is put
 * exactly on them. What it is used for there is noticing, afterwards, that the rig is no longer standing where
 * it was put, which is what sends it back.
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
 * How far above the arena spawn part's own CFrame a rig is put, in studs.
 *
 * **The same lift `RoundService.getRandomTeamSpawn` puts on a player's spawn**, and for the same reason: the
 * spawn part *is* the spot, and a body placed at the part's origin is a body placed inside the floor. Three
 * studs is the distance from a rig's root to the ground beneath it, so the feet arrive on the part's surface
 * rather than through it — the same geometry that makes the number right for a character. The two numbers have
 * to agree or the rigs and the players stand at different heights on the same spots.
 *
 * **Placeholder — 3.**
 */
const ARENA_SPAWN_LIFT = 3;

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
 * **One function for both destinations that are walks, because "go there" is one thing.** The join pad and the
 * post on the court differ in what they mean and in nothing else about how a rig is sent to them: within
 * `ARRIVAL_STUDS` the rig is *told to stay where it is* — `MoveTo` at its own position is the engine's own
 * "stand here", the trick `SeekBehavior.stand` uses — and outside it the destination is re-issued, which is
 * what notices a destination the engine has forgotten or a body that has been shoved off course. The post is
 * the second of the two rather than the first only because a rig is *put* on it: this call is what keeps it
 * there, and what walks it back after a dodge or a ball has moved it.
 *
 * **Re-issued on every tick rather than once, and that is the re-aim for every destination alike.** A rig
 * that is knocked off its post, or whose `MoveTo` was replaced by another behavior's, is walked back at its
 * own next turn; the alternative is a rig that keeps a destination it took once, which is the same as a rig
 * that wanders for the rest of the round.
 *
 * **The answer is returned rather than left to the caller's own distance test, and the pad is what settles
 * that.** The pad used to spell this test out for itself — the same subtraction, the same `ARRIVAL_STUDS`, in
 * a branch of its own — and the copy drifted the way a second spelling always does: it *remembered* the answer
 * in a flag instead of re-deriving it, so "arrived" could be true of a rig that was no longer at the pad. Every
 * destination asks this function now, so the radius, the arithmetic and the meaning of "there" exist once.
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
 * **A goal and nothing else.** The rig is *placed* on it rather than walked to it — see `toCourt` for the log
 * that settled that — so there is no clock to keep, no arrival to wait out and no fallback teleport: the rig
 * is at its post on the tick it is sent.
 *
 * **What is still asked every tick is whether it is *still* there**, which is what makes a rig shoved off its
 * post walk back to it instead of standing where it was pushed. That question needs the goal and nothing else.
 */
interface ArenaWalk {
	/**
	 * Where on the court this rig stands — its side's spawn part, lifted by `ARENA_SPAWN_LIFT`, **carrying the
	 * part's own facing**.
	 *
	 * **A `CFrame` rather than the position a walk would have needed, and the rotation is the reason.** A player
	 * is moved onto exactly this value (`RoundService.getRandomTeamSpawn` hands `arenaSpawnFor` the same
	 * `part.CFrame`), so whatever way somebody turned the spawn part in Studio is the way a person faces at the
	 * start of a round. A rig placed by position alone arrives facing due north, and for a rig facing is not
	 * cosmetic: `ThrowBehavior` only notices a target inside a 240° cone in front of it.
	 */
	goal: CFrame;
}

/** What one rig is doing about the pads and the court. Kept per rig, because a behavior is one object shared by all. */
interface Gather {
	/**
	 * The lobby spawn this rig calls home — where it is put back at the end of every round.
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
	 *
	 * **A whole `CFrame` rather than the position it used to be, because the return is a placement too.** The
	 * rig comes back to the spot it started on *facing the way it started*, which costs nothing to keep and is
	 * the same thing the court leg does with the spawn part's facing.
	 */
	home?: CFrame;

	/**
	 * The pad the rig is walking to. Present means a gather walk is in progress.
	 *
	 * **No `arrived` flag sits beside it, and that is a correction rather than an omission.** "Is this rig at
	 * its pad" is asked of its position every tick — the same `walkTo` every other destination uses — because a
	 * remembered answer stops being true the moment a player walks through the rig. The flag this replaces had
	 * exactly that failure and one more: it was a *second spelling* of the arrival rule `walkTo` already holds
	 * (the same radius, the same subtraction, two places for the arithmetic to drift), and it outlived the
	 * arrival it described — once set it was cleared only by a new walk starting, so a rig shoved off its pad
	 * stood where it was pushed for the rest of the intermission. That mattered because the round's count of
	 * who is on a pad (`rigsOnPads`) is a *bounds test* rather than a memory, so the two answers disagreed and
	 * the rig was simply not counted.
	 */
	pad?: BasePart;

	/**
	 * This round's trip to the court, or nothing when the rig is not on one.
	 *
	 * **Present means "sent this round", and that is the guard that makes the walk fire once.** It is set the
	 * moment a goal is picked — not when the rig arrives — so the pick happens on the rig's first `Playing`
	 * tick and every tick after it walks toward the same spot. Cleared when the rig is back in the lobby,
	 * which is what lets the next round pick a fresh one.
	 *
	 * **It is the return leg's own flag as well, and that second job is what keeps a rig on a pad.** While it
	 * is present the rig owes a trip home; once it is cleared the rig is free to wait. The tick used to ask
	 * "am I at home" instead, which is a question a rig standing on a pad answers *no* to — see the tick for
	 * what that cost.
	 */
	arena?: ArenaWalk;
}

/**
 * Gathering, for an NPC: **between rounds, stand at one of the matchmaking join pads; when a round starts,
 * be put on this rig's side of the court and stand at its post; when the round ends, be put back on the lobby
 * spawn it came from.**
 *
 * **Two of the three are placements and one is a walk, and the place file decides which.** The pad is inside
 * the lobby and so is the spawn a rig came from, so a `MoveTo` between them is a walk inside one room and it
 * works — the log has four rigs standing on the pads, counted, on every intermission. The court and the lobby
 * are separate rooms of the arena with a `Barrier` midline between them, and **no rig has ever walked from one
 * to the other**: every round the log printed `could not walk to its A/B spawn in 10s — put there instead` for
 * all four, so the walk never worked once, and a rig that spent a round's opening seconds still in the lobby
 * was throwing from there. See `toCourt` for the whole of that argument.
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
 * **What a rig does once it is at its post: nothing but stand there.** The court tick holds its position, and
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

	/**
	 * The rig's own row, made on first use.
	 *
	 * **Empty to begin with, and that is a state rather than a placeholder**: every field is optional and each
	 * one means something is *in progress* — a home is recorded (once), a pad is being walked to, a court trip
	 * is owed — so a rig that has just been seen is doing none of those, and the first tick after this fills in
	 * the ones that apply.
	 */
	const stateOf = (model: Model): Gather => {
		let state = walking.get(model);
		if (state === undefined) {
			state = {};
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
	 * The court: a rig with a side is **put** on its post, and stands there for the round.
	 *
	 * **Placed rather than walked, and a log settled it rather than an argument.** This was a walk with a
	 * ten-second fallback teleport, on the reading that a placeholder which *runs* to its post reads as a
	 * player arriving. What the place actually does to it is in the output: every rig, on both sides, printed
	 * `could not walk to its A/B spawn in 10s — put there instead` on **every** round, so the walk never
	 * worked once — and then kept printing it every ten seconds afterwards, which says the fallback was not
	 * settling them either. The lobby and the court are two rooms of the arena
	 * (`Workspace.ArenaV2.Lobby`, `Workspace.ArenaV2.Court`), the rigs are in the `Character` collision group
	 * and the court's midline is a `Barrier` part, so a `MoveTo` from one room to the other is a walk through
	 * architecture this behaviour can neither see nor reason about. **What that costs is not a missing walk; it
	 * is a rig still standing in the lobby fifteen seconds into a round, throwing at what it can see from
	 * there** — which is exactly what the log showed, four times over.
	 *
	 * **So a rig is put where a player is put**: the same `part.CFrame`, lifted the same three studs, and the
	 * facing comes with it — which is why the goal is a whole `CFrame` and not a point. A player is moved onto
	 * that CFrame by `RoundService`, so they face whatever way the builder turned the part; a rig placed by
	 * position alone would face due north, and a rig only notices a target inside the 240° in front of it.
	 *
	 * **Sent on the rig's first `Playing` tick and never re-picked**, which is what `gather.arena` being
	 * present means: the goal is chosen once and every tick after stands the rig back on it. Re-picking per
	 * tick would put the rig on a different spawn every half second.
	 *
	 * **The placement happens under the round's own cover.** `RoundService` publishes `Playing` *before* it
	 * wipes the screens and holds everybody, so the first tick after the phase flips — and therefore this
	 * move — lands while the transition is still closing. A player never sees the rig appear, for the same
	 * reason they never see themselves appear.
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
	 * walk. It is what makes the return trip end in a *new* gather walk rather than in the wreckage of the
	 * previous one: the rig comes home holding no pad, so the tick that finds it home picks one again.
	 *
	 * **And the flag this paragraph used to argue about is out of the file entirely, which is worth saying
	 * because the paragraph was right about the trap.** It described carrying an `arrived` mark across a round
	 * as a fault — a rig that came home, decided it had already arrived *somewhere*, and stood at its spawn
	 * instead of taking up a pad, where the round's own count of who is on a pad could not see it. The trap was
	 * real; the flag was the wrong place to fix it. "Is this rig at its pad" is asked of the rig's position on
	 * every tick now, so there is no arrived-anywhere state left to carry across anything — see `Gather.pad`.
	 */
	const toCourt = (model: Model, humanoid: Humanoid, root: BasePart, gather: Gather): void => {
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

			walk = { goal: part.CFrame.add(new Vector3(0, ARENA_SPAWN_LIFT, 0)) };

			gather.arena = walk;

			// Forgotten here rather than on arrival, because the return leg has to end in a *new* walk — see
			// this method's doc.
			gather.pad = undefined;

			model.PivotTo(walk.goal);

			return;
		}

		// **And every tick after the first, the rig is asked to stay where it was put.** `walkTo` is the same
		// call the pad is made with: inside `ARRIVAL_STUDS` the rig is told to stand at its own position, and
		// outside it a *walk* back is issued — the one thing a walk is still the right tool for here, because a
		// rig shoved off its post by a dodge or a ball is on its own half of the court and can get back.
		walkTo(humanoid, root, walk.goal.Position);
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
			// why it is the first turn rather than the start of the last walk, which is what it used to be —
			// and for why it is the whole `CFrame` rather than the position: the return is a placement now, so
			// the facing it started with is free to keep.
			const home = gather.home ?? root.CFrame;
			gather.home = home;

			// ---- A round is on: to the court ----

			if (phase === PLAYING) {
				toCourt(model, humanoid, root, gather);

				return;
			}

			// ---- No round: home first, then a pad ----

			// **The return leg, and it is a leg with an end rather than a standing order to be at home.** A rig
			// that is out on the court when the round ends comes back to the spot it was put in before it takes
			// up a pad again, and the two legs are not the same journey: the pad is where it *waits*, the lobby
			// spawn is where it *lives*. Walking straight to the pad would be one leg instead of two and would
			// usually be the shorter of the two — but the rig would then never return to its spawn, so every
			// round would leave it a pace closer to the join pads and the walk back would stretch a little
			// further each time. The old behaviour had this shape for free: its walk home ran at the *round
			// start* and both ends were in the lobby, so "where I was when I set off" was always a lobby spawn.
			// It is the walk to the court that turns the return into a leg of its own rather than the same one.
			//
			// **The question asked here is "is there a court trip outstanding", not "am I at home", and that
			// distinction is the whole of the fix.** Asked the second way the answer is *no* for a rig standing
			// on a pad as well — a pad is not home — so every single tick turned the rig around and sent it back
			// to its spawn, and the tick that next found it home sent it out to the pad again. The rigs walked
			// back and forth for as long as the intermission lasted, were *at* a pad for a fraction of each
			// cycle, and never settled anywhere: which is why the round's count of them (`rigsOnPads`, a bounds
			// test asked on the round's own tick) saw four rigs on the pads on some ticks and none on others,
			// and why a round that did open read `A: 0 player(s) + 2 rig(s), B: 0 player(s) + 2 rig(s)` and then
			// drew — there was nobody on a side because nobody had stayed on a pad long enough to be counted.
			// `gather.arena` answers the first question and not the second: it is set when the rig sets off for
			// the court and cleared here, so it is present exactly while a rig is away from home *because a
			// round sent it there* — and once it is cleared the rig is free to wait on a pad for as long as the
			// intermission lasts, which is what "a rig holds a spot" has to mean.
			if (gather.arena !== undefined) {
				// **Put back rather than walked back, for the reason the court leg is a placement.** It is the
				// same two rooms with the same architecture between them, so a return that depends on a `MoveTo`
				// finding its way out of the court is a return that will not happen — and a rig that never gets
				// back is a rig that is not on a pad, which is a round that cannot start. It is placed on the
				// CFrame it was first seen on, facing the way it started.
				model.PivotTo(home);

				// **Back in the lobby, so this round's trip is over.** Forgetting the goal here rather than
				// after a walk is what stops a stale one being carried into the next round: a rig that never
				// reached its post never set off (there is no `ArenaWalk` to forget), and a rig that did reach it
				// is released from the journey on the tick it arrives home. Both are the honest reading of "the
				// rig is in the lobby with no round on" — and the tick after this one walks it to a pad, which is
				// the only journey left in this behaviour.
				gather.arena = undefined;
			}

			if (gather.pad !== undefined) {
				// A pad that has gone — the place edited under a running server — ends the walk rather than
				// being read for a position that is no longer meaningful. **The pad is forgotten rather than
				// the whole row**: the row holds the rig's home, which it took on its first turn and which
				// nothing may rewrite, so throwing it away here would re-record home at wherever the rig is
				// standing. The next tick starts a fresh walk to whatever pad the tag now names.
				if (gather.pad.Parent === undefined) {
					gather.pad = undefined;
					return;
				}

				// **One walk for every destination, because "am I there yet" is one question.** Inside
				// `ARRIVAL_STUDS` the rig is told to stand where it is, and outside it the pad is re-issued —
				// that is `walkTo`, the *same* call the court and the lobby spawn are made with, so the radius
				// and the arithmetic exist once in the file rather than once per destination.
				//
				// **It matters most here, because this is a position the round counts.** `rigsOnPads` asks
				// whether a rig's bounds overlap the pad *part*, and it is asked on the round's own tick
				// rather than read off anything this behaviour wrote — so a rig standing a stud short of its
				// pad is a rig the round cannot see, whatever this file believes about it. The `arrived` flag
				// this replaces could produce exactly that state and keep it: set once, never re-tested, so a
				// rig shoved off its pad by a player stood where it was pushed for the rest of the
				// intermission and was never counted again.
				walkTo(humanoid, root, gather.pad.Position);

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
