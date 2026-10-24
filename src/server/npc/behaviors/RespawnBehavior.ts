import { CollectionService, ReplicatedStorage, Workspace } from "@rbxts/services";
import {
	BADGES_ATTRIBUTE,
	BALL_NAME,
	ROUND_STATE_ATTRIBUTE,
	ROUND_STATUS_FOLDER,
	TEAM_ATTRIBUTE,
} from "shared/constants";
import { NPC_CONFIG } from "shared/config/npc.config";
import { DEBUG_CONFIG } from "shared/config/debug.config";
import { TEAM_A, TEAM_B } from "../../services/round/team";
import { arenaSpawnForRig } from "../arenaSpawns";
import { BEHAVIOR_RESPAWN, NPC_TAG, NpcBehavior } from "../Behavior";
import { ragdoll } from "../ragdoll";
import {
	WALK_TO_JOIN_PAD_AT_ATTRIBUTE,
	WALK_TO_JOIN_PAD_ATTRIBUTE,
	WALK_TO_JOIN_PAD_LOOK_AT_ATTRIBUTE,
	WALK_TO_JOIN_PAD_SIDE_ATTRIBUTE,
} from "./WalkToJoinPadBehavior";
import type { BallService } from "../../services/ball/BallService";

const DEBUG = false; // off for frame time — see shared/config/debug.config.ts

/**
 * Respawning, for an NPC.
 *
 * A rig wearing this tag comes back after it is killed, which is the one thing a
 * test rig wants that a player gets from `RespawnService`: a dummy that has been
 * knocked down stays knocked down otherwise, and re-tagging one by hand between
 * attempts is most of what testing a throw is.
 *
 * **A dead rig cannot be brought back. The rig that comes back is copied from a
 * live one, before anything kills it.** Two attempts at reviving what was
 * already there both ended with the rig lying on the floor, limp:
 *
 *   - Writing `Health` back and asking for `HumanoidStateType.GettingUp` left the
 *     body exactly where it lay. `Dead` is defined as the state a Humanoid enters
 *     *to* die, and `GettingUp` as the recovery from `FallingDown` or `Ragdoll` —
 *     not from `Dead` — so nothing in the state machine was ever going to lift it.
 *   - Copying the corpse and reviving *the copy* left it limp too, and the state
 *     printed off that corpse (`Dead`, platform stand **false**, state machine
 *     **enabled**) is what ruled out the obvious flags: nothing was switched off.
 *     **A copy of a corpse is a copy of a dead rig**, whichever of its properties
 *     the engine happens to record that in — and a corpse has also fallen over, so
 *     a copy of one is a copy of the direction it fell in.
 *
 * So the copy is taken from the rig **while it is still alive and on its feet**,
 * when this behavior first sees it, and is kept out of the world until it is
 * needed. What comes back is the shape a player's own respawn takes: a rig that
 * has never been dead, at full health, standing where it was put. The corpse is
 * only ever read from — for its name and its tags — before it is destroyed.
 *
 * `tickInterval` is infinite, which is how a behavior says it wants no turns:
 * what this one waits for is a death, and a death is not an interval.
 */

/**
 * The phase name `RoundService` publishes while a round is being played, and the read of it.
 *
 * **A deliberate copy of a read nine other server files make** — `npc/detect.ts`, `DodgeService`,
 * `MysteryBoxService`, `StatsService`, `BallSpawnerService`, `LobbyRigService`, `MatchService`,
 * `OutlineService` and `SuperService` each have their own three lines, on `BallSpawnerService`'s stated
 * reason: the phase is published as *text on an attribute* and there is nothing importable to agree on.
 * A behaviour cannot reach a service to ask — it is constructed by `NpcService`, and `RoundService` and
 * `LobbyRigService` both construct *that* — so the choice here is this copy or a fourth parameter on the
 * factory, and a factory that takes a phase reader to answer one question per death is the heavier of the
 * two.
 *
 * **The default is the intermission, which is the conservative answer here.** An unreadable phase means
 * this behaviour places a rebuilt rig at its recorded home — the behaviour it had before any of this — and
 * the next boundary overwrites the home anyway. Guessing "playing" instead would put a rig into an arena
 * for a round that may not exist.
 */
function roundIsPlaying(): boolean {
	const folder = ReplicatedStorage.FindFirstChild(ROUND_STATUS_FOLDER);

	return folder?.GetAttribute(ROUND_STATE_ATTRIBUTE) === "Playing";
}
export function createRespawnBehavior(balls: BallService): NpcBehavior {
	/**
	 * A live copy of each rig, taken before anything can kill it.
	 *
	 * Unparented on purpose: out of the world it is not simulated, nothing can touch
	 * it and nothing can find it. It is never parented either — every respawn clones
	 * *this*, so one rig's template serves every death it has.
	 */
	const templates = new Map<Model, Model>();

	/**
	 * Where each rig stands, as the CFrame of its own **root part**.
	 *
	 * The root and not the model's pivot, because a model pivot carries no
	 * orientation of its own — see the placement in `onDied` for what moving a rig by
	 * one does to a rig that is not already upright. Read when a rig is first seen and
	 * carried to its replacement: a rig that has been knocked down has been knocked down
	 * *somewhere*, and the point of a respawn is to come back where it was put, not
	 * where its body happened to fall.
	 *
	 * **And written again every time the game puts the rig somewhere else**, which is `onPlaced` and is a
	 * repair rather than a refinement. Read once, "where it was put" is only true until something puts it
	 * somewhere else, and this game does exactly that twice a round: a placeholder rig is born on a *lobby*
	 * spawn, walks to a join pad, and is teleported onto an arena spawn at the whistle. So the home read at
	 * the first turn was a lobby spawn, and every rig killed in a round came back standing in the lobby —
	 * out of the game, holding a side, with nothing left that would move it in. See `onPlaced`.
	 */
	const homes = new Map<Model, CFrame>();

	/**
	 * The parent each rig is *filed* under, taken the first time this behavior saw the rig alive.
	 *
	 * **Taken while the rig is alive, for the same reason the template is.** A corpse cannot be asked
	 * where it used to live: by the time `onDied` runs the rig has been knocked down, the ball it was
	 * carrying has been dropped, and the only thing that knows the answer is what was written down at
	 * the start of the life. Carried to the replacement exactly like `homes` and `templates` — one rig's
	 * file serves every death it has, because a replacement arrives with its file carried over.
	 *
	 * **A parent, not a path, and that is the point.** The map's own rigs live in a folder inside the
	 * arena — `Workspace.ArenaV2.PracticeArea.NPCs` in the place this was written for — while a rig
	 * `NpcService.spawn` made lives directly in `Workspace`. Whichever it was, the replacement belongs
	 * in the same place: a respawned rig that lands at `Workspace` root instead is two kinds of rig
	 * where there is one kind of thing, and every name in the log that describes the folder is then
	 * describing a rig that is no longer in it.
	 *
	 * **`undefined` is recorded as `undefined` rather than skipped**, because a rig that was unparented
	 * when it was first seen has no file to go back to, and the placement in `onDied` has a fallback for
	 * it — the same one a destroyed folder gets.
	 */
	const folders = new Map<Model, Instance | undefined>();

	return {
		tag: BEHAVIOR_RESPAWN,
		tickInterval: math.huge,

		prepare(model) {
			const humanoid = model.FindFirstChildWhichIsA("Humanoid");
			const root = model.FindFirstChild("HumanoidRootPart");
			if (!humanoid || !root || !root.IsA("BasePart")) return;

			// **The joints are kept, and `onDied` turns them into sockets — the third position on this line, and
			// the two before it are worth keeping because each was a real attempt.**
			//
			// - `= false` from 2026-09-22 (commit `c267524`, "NPC spawns after killed"), on the argument that
			//   the corpse had to stay whole "for the one thing this behavior still needs a corpse for: its name
			//   and its tags". The body then *fell over like a plank*: never limp, and the user's complaint
			//   months later — *"the rigs stopped ragdolling"* — was this line.
			// - `= true` on 2026-10-19, which is the engine's own ragdoll and is **not** one: it destroys every
			//   `Motor6D` at the moment of death, so the rig comes *apart* — limbs as separate bodies, scattered
			//   a few studs, impossible to read as a death. The user's answer to that was immediate: *"the rigs
			//   are breaking apart instead of rag dolling."*
			// - `= false` again, **paired with `ragdoll()` in `onDied`** — the only one of the three that is a
			//   ragdoll: the joints are left intact here so that there is something to swap, and the swap
			//   replaces each `Motor6D` with a `BallSocketConstraint` at the same offset, so the limb stays
			//   attached and stops being driven. See `npc/ragdoll.ts` for the mechanism and for why the offsets
			//   and the limits are the whole of what makes it read correctly.
			//
			// **The corpse is still whole, which means the original argument is satisfied as well.** A socketed
			// corpse keeps its `Name`, its children, its attributes and its `CollectionService` tags, and this
			// file's template was taken while the rig was **alive and on its feet**, so nothing here has ever
			// read a corpse's shape. **Nothing clones a corpse either** — see `rigPool.ts`, which records the
			// same fact for the same reason.
			humanoid.BreakJointsOnDeath = false;

			// A rig that has already been replaced arrives with its home *and* its template
			// carried over from the rig it replaced — including a template that was taken while
			// that rig was clean, which is worth more than one taken from a rig that is by now
			// holding a ball.
			if (homes.get(model) !== undefined) return;

			homes.set(model, root.CFrame);

			// **And where it is filed, taken at the same moment and for the same reason.** The corpse
			// cannot be asked this later, and a rig moved between folders during its life should come back
			// where it was first filed rather than where it happened to end up. See `folders`.
			folders.set(model, model.Parent);

			// Taken now: alive, standing, and usually empty-handed. This is the only moment at
			// which a copy of a rig is a copy of a rig that works.
			const template = model.Clone();

			// Not what the rig was holding. While a ball is held it is a child of the model under
			// the name the hand-out gives it, with its weld inside it, so removing it takes the
			// weld too. Left in, the template would come back clutching a duplicate of the ball
			// the corpse is still holding, and the new rig's throwing behavior would weld a
			// second ball into that same hand.
			template.FindFirstChild(BALL_NAME)?.Destroy();

			// And out of the tag scheme, because a rig wearing `NPC` is a rig that reads as
			// managed, and this one is not in the world at all. The tags the replacement wears
			// are read off the corpse when it is needed, so nothing is lost by clearing them.
			for (const tag of CollectionService.GetTags(template)) template.RemoveTag(tag);

			templates.set(model, template);
		},

		// Nothing to do on a timer — see `tickInterval`. This behavior does its work in
		// `onDied`, because that is the only moment it has anything to say.
		tick() {},

		/**
		 * **The rig has been moved by somebody else, and where it stands now is where it belongs.**
		 *
		 * A home is a fact about where a rig was *put*, and this game puts a rig in more than one place.
		 * `prepare` reads it on the first turn, which is the right moment for a rig born where it plays and
		 * the wrong one for every rig this game actually makes: a placeholder rig is spawned on a lobby spawn,
		 * walks to a join pad, and is teleported onto an arena spawn when the round starts. So the home written
		 * at that first turn is a *lobby* spawn — and a rig killed in the arena came back in the lobby, kept
		 * its side, and could not rejoin, because nothing moves a side-bearing rig into the arena except the
		 * round's own teleport, which is a round away. The same fault runs the other way at the end of a round,
		 * where `RoundService.returnRigsToLobby` puts a rig back in the lobby while its home still points at
		 * the arena. See `NpcBehavior.onPlaced` for why a teleport is the only thing that has to be announced.
		 *
		 * **Only for a rig this behavior already knows**, and that guard is what keeps the two moments in the
		 * right order. `prepare` records a home and takes a template *together*, and it reads a known home as
		 * "this rig is a replacement, with all of that already carried over" — so a home written for a rig
		 * that has not been prepared would make `prepare` return early and leave that rig with no template at
		 * all, which is a rig that dies and never comes back. A rig placed before its first turn loses nothing
		 * either way: `prepare` reads where it stands then, which is where it was just put.
		 */
		onPlaced(model) {
			if (homes.get(model) === undefined) return;

			const root = model.FindFirstChild("HumanoidRootPart");
			if (!root || !root.IsA("BasePart")) return;

			homes.set(model, root.CFrame);

			// **Where, as well as that.** A rig that comes back in the wrong room reads exactly like a rig
			// that never came back, and nothing in the output said which room it had been put in until this
			// line — so the position is the whole of what this print is for. Only the movers reach here, and
			// only for a rig this behavior knows, so it costs a boundary rather than a turn.
			if (DEBUG) {
				const at = root.Position;

				print(`[NPC] ${model.Name}: placed — ${string.format("%.0f, %.0f, %.0f", at.X, at.Y, at.Z)}`);
			}
		},

		onDied(model) {
			// **The corpse goes limp here, synchronously, and the rebuild does not wait for it.** The conversion
			// has to happen on the frame of the death: a rig whose joints are still driving it for the
			// three-second delay would stand in its death pose until it was replaced, and the sockets would then
			// be applied to a body already on its way out. `ragdoll` is idempotent — it converts whatever
			// `Motor6D`s are left and answers nought the second time — so the line is safe even if a death were
			// ever reported twice.
			//
			// **The count is printed, because it is the one thing that distinguishes "the ragdoll did not
			// happen" from "the ragdoll happened and the limits are wrong".** A body that falls over stiffly has
			// either no sockets or sockets with a cone of nought; the number answers which, per rig, at the
			// moment it matters. **Nought is printed too**, which is the line that says a rig had no `Motor6D`s
			// to convert at all — a welded or static template rather than a jointed one — and without it that
			// case would look exactly like a ragdoll with bad limits.
			const joints = ragdoll(model);
			if (DEBUG) print(`[NPC] ${model.Name}: ragdolled — ${joints} socket(s)`);

			task.spawn(() => {
				const name = model.Name;

				task.wait(NPC_CONFIG.RESPAWN_DELAY_SECONDS);

				const home = homes.get(model);
				const template = templates.get(model);
				if (!home || !template) return;

				// Gone from the world: there is nothing left to take a name or tags from.
				if (model.Parent === undefined) return;

				const humanoid = model.FindFirstChildWhichIsA("Humanoid");

				// Already alive — put back by hand while the delay ran. Health above zero is what
				// "alive" means, and it is the only check that covers both "no humanoid to
				// replace" and "nothing to replace".
				if (!humanoid || humanoid.Health > 0) return;

				if (DEBUG) print(`[NPC] ${name}: died`);

				// The ball goes before the corpse does, or it would leave the world welded into a
				// rig that is about to be destroyed — and the entry saying whose hand it is in
				// would outlive it, pointing at a destroyed rig for the rest of the session.
				// Dropped rather than deleted, so what the rig was carrying is still in play:
				// loose scenery, cleaned up on the clock thrown balls are.
				balls.dropBall(model);

				// Read off the corpse before it goes. The replacement has to be *told* what it is,
				// tags included, because its template was taken at the start of a life that may
				// since have had tags added to it.
				const tags = CollectionService.GetTags(model);

				// **Read off the corpse beside the tags, and for the same reason: this is the last moment
				// it can be read at all.** The corpse's own parent is the *fallback* rather than the first
				// choice — a rig that was unparented when it was first seen has no file to go back to, and
				// that is the same case the placement below falls back for. See `folders`.
				const filed = folders.get(model) ?? model.Parent;

				// **And its side, read here for exactly the same reason as the two above — a corpse is the
				// only place this fact exists, and the corpse is destroyed a few lines down.** A rig's `Team` is
				// what makes it a participant: `npc/rigs.ts` reads that attribute and nothing else, so a
				// replacement without it is a body the round does not count, never teleports, and — the
				// part that is worse than absent, because it is *wrong* — one whose `detectEnemy` side reads
				// `undefined`, which makes every rig on the field an enemy and every player a friend. That
				// is a rig that comes back and shoots its own side.
				//
				// **`Team` alone, not every attribute, and the others are named rather than ignored.** The
				// walk-pad pair is lobby baggage: this rig died in a round, so a destination pointing at a
				// sign is stale, and copying it would have the replacement walk back out of the arena. The
				// thrower token is re-issued by `NpcService.start` the moment a rig has none. The four
				// animation attributes are republished from scratch on the replacement's first turn. What
				// is left is the one attribute that is part of *being in the round* rather than part of a
				// moment, and it is validated rather than trusted for `sideOfRig`'s reason: an attribute
				// anybody can write is not a side until it reads as one.
				const label = model.GetAttribute(TEAM_ATTRIBUTE);
				const team = label === TEAM_A || label === TEAM_B ? label : undefined;

				// **And the strip the round gave it, read off the corpse for the same reason as the three above
				// — this is the last moment it can be read at all.** A badge is a sentence about the *round the
				// rig has just played*, and the body wearing it is a copy of a template taken while that rig was
				// alive, which is to say before the round said anything about it. So without this line the strip
				// dies with the corpse: a rig killed in the last seconds of a round came back blank a second
				// after earning it, and a lobby full of blank heads was reported as "the badges were not
				// shown". The write itself now happens after the boundary (see `BadgeService.publish`), and this
				// is the other half: a rebuild *anywhere* inside the fifteen-second window carries the strip
				// across rather than dropping it.
				//
				// **`""` is deliberately not carried.** An empty value means "this round said nothing about this
				// body", and the replacement already says nothing about it — copying it would be writing a fact
				// that is already true, on a body that is not yet in the world.
				const worn = model.GetAttribute(BADGES_ATTRIBUTE);

				// Scope: Npc.Respawn.clone — the one expensive statement in the rebuild, on its own band
				// because it is the only part of this thread whose cost is not a handful of writes.
				if (DEBUG_CONFIG.PROFILE) debug.profilebegin("Npc.Respawn.clone");
				const rig = template.Clone();
				if (DEBUG_CONFIG.PROFILE) debug.profileend();

				const fresh = rig.FindFirstChildWhichIsA("Humanoid");
				const root = rig.FindFirstChild("HumanoidRootPart");
				if (!fresh || !root || !root.IsA("BasePart")) return;

				// Scope: Npc.Respawn.onDied — the rebuild after the copy, from health to the entry-point
				// tag that restarts the rig's loop.
				//
				// **It opens here, after the last early return, and that is the whole of why it is not at
				// the top of the thread.** Everything above this line is a guard — no home, no template,
				// parented out of the world, already alive, a copy with no humanoid — and every one of them
				// leaves the function. A `profilebegin` above them would need an `end` on each of five exits
				// to balance, and the one that got missed would not fail loudly: it would silently attribute
				// the rest of the frame's work to a respawn that never happened. Below this line there is no
				// early return left, so one pair is enough.
				//
				// **And it does not span the wait.** `task.wait(NPC_CONFIG.RESPAWN_DELAY_SECONDS)` is above
				// this method's own scope on purpose: a rig's respawn delay is two seconds of *not working*,
				// and a band that included it would report the delay as server cost. Two consequences worth
				// knowing before reading the recording: `Npc.Respawn.onDied` is the rebuild and nothing else,
				// and the `task.spawn` at the top of the method — the only thing `onDied` itself does
				// synchronously — is a creation, not a cost, and is deliberately left outside every band.
				if (DEBUG_CONFIG.PROFILE) debug.profilebegin("Npc.Respawn.onDied");

				// Full health, which is not the same as the template's: a rig that had been hurt
				// before it was killed would otherwise come back carrying the damage it never
				// died of.
				fresh.Health = fresh.MaxHealth;

				model.Destroy();
				homes.delete(model);
				templates.delete(model);
				folders.delete(model);

				// **A rig that holds a side comes back where its side is standing, not where its body was put.**
				//
				// A home is a *recorded* placement, so it is only as right as the last mover was: a rig
				// refilled mid-round onto a lobby pad, or one whose restore took the lobby branch by mistake,
				// carried a lobby home into a live round — and this is the line that then put a body in the
				// lobby, on its side, in front of a match it could not rejoin, with nothing in the output
				// saying which room it had been rebuilt in. That is the report this answers.
				//
				// **If the round is playing and the corpse had a side, the arena's own spawn for that side is
				// the answer**, and it is a fresh read of the place file rather than a remembered point — see
				// `npc/arenaSpawns.ts` for why the lookup lives beside the behaviours rather than being asked
				// of the round, which does not construct them. Everything else keeps the home: a rig with no
				// side is a lobby walker between rounds, a practice dummy, or a body nobody has painted, and
				// for all three the place it was put is the place it belongs.
				//
				// **The chosen point becomes the home**, so the next death decides from the same rule rather
				// than from a stale one, and the movers that follow — `returnRigsToLobby` at the round's end,
				// `teleportTeamsToArena` at the next whistle — go on overwriting it as they always did.
				const destination = (team !== undefined && roundIsPlaying()
					? arenaSpawnForRig(team)
					: undefined) ?? home;

				// **Placed by its root part, not by `PivotTo`.** A model pivot has no orientation of
				// its own — it is a point — so moving a model by one moves it without turning it,
				// which is how a rig ends up standing *at* the right spot while lying on its back
				// there. A root part's CFrame carries both, and the joints carry the rest of the
				// rig along with it.
				root.CFrame = destination;

				// Every tag off the copy and back on again, rather than trusting `Clone` to have
				// carried them: `NpcService` starts a loop when the entry point *arrives* on a
				// model, and a tag that is already there cannot arrive. The behaviors go back first
				// and `NPC` last, so the rig is finished by the time the loop it starts looks at
				// it — the same order `spawn` uses, for the same reason.
				for (const tag of tags) rig.RemoveTag(tag);

				// Handed on before the entry point arrives: they belong to the rig that is here now,
				// and the loop about to start will ask for them on its first turn.
				homes.set(rig, destination);
				templates.set(rig, template);
				folders.set(rig, filed);

				// **Back into the file it came from, not into `Workspace`.** A rig that lands at `Workspace`
				// root while the map's own rigs sit in a folder is two kinds of rig where there is one kind
				// of thing, and everything that names the folder afterwards — a log line, a lookup, a person
				// reading the Explorer — is naming a rig that is no longer in it. The world gate in
				// `NpcService.run` asks `IsDescendantOf(Workspace)`, so a rig in a folder inside the arena is
				// exactly as live as one at the root: the folder is where the rig belongs, not where it has
				// to be for the loop to run.
				//
				// **A file that is gone is the fallback's problem, and it says so out loud.** A folder
				// destroyed mid-round takes its contents with it, so the rig is headed for `Workspace` — but
				// only after a line naming the folder, because a rig that silently moves house is the same
				// fault in miniature as the one this placement exists to end.
				if (filed !== undefined && filed.Parent !== undefined) {
					rig.Parent = filed;
				} else {
					if (filed !== undefined) {
						warn(`[NPC] ${name}: ${filed.Name} is gone — the rig is going to Workspace instead`);
					}

					rig.Parent = Workspace;
				}

				// **The strip goes back on before the tags do**, so a rig that is rebuilt inside the badge window
				// is never briefly a rig with no badges: the client mounts a billboard when `NPC_TAG` arrives and
				// reads the attribute at that moment, so a value written after the tag would be a visible flicker
				// rather than a missing line — and a value written *only* on the attribute signal would be no
				// line at all for a client that had not been told about the old body.
				//
				// **Copied rather than re-derived**, because nothing in this file knows what a badge is: the
				// value is one string the server wrote, and moving it from one instance to another is the whole
				// of what a rebuild owes it. See `BADGES_ATTRIBUTE` in `shared/constants.ts`.
				if (typeIs(worn, "string") && worn !== "") rig.SetAttribute(BADGES_ATTRIBUTE, worn);

				// **Written before the entry point arrives, exactly like the tags two lines down**, so the
				// loop that starts on `NPC` finds a body that already has its side rather than one that
				// becomes a participant a turn later. A corpse with no side of its own — a rig that was
				// never in a round — writes nothing, and comes back exactly as side-less as it was.
				//
				// **And a rebuilt rig that holds a side is a round body, not a lobby walker**, so the
				// destination it was once given goes the moment the side is written. The *tag* is already
				// absent by then — `WalkToJoinPadBehavior` takes it off when the rig arrives, which is the fix
				// for the bug that produced this guard — but the walk's *attributes* travel with the template,
				// because `prepare` strips tags from the copy it takes and not attributes. So a rebuilt rig
				// stands there with a stale lobby pad in its pocket, and the four are all of one instruction:
				// "wait, then walk to this point, and look at that one on the way". A round body should carry
				// none of them — the two halves of the instruction that are read by name are cleared here, and
				// `WALK_TO_JOIN_PAD_AT_ATTRIBUTE` and `WALK_TO_JOIN_PAD_LOOK_AT_ATTRIBUTE` with them rather
				// than left as unread leftovers, because a comment that said "neither" over two of four would
				// be the next reader's trap. **A corpse with no side is the other case and keeps all four** — a
				// lobby walker that dies and comes back still knows where its pad is and that it has already
				// waited, and nothing else would tell it again.
				if (team !== undefined) {
					rig.SetAttribute(TEAM_ATTRIBUTE, team);
					rig.SetAttribute(WALK_TO_JOIN_PAD_ATTRIBUTE, undefined);
					rig.SetAttribute(WALK_TO_JOIN_PAD_SIDE_ATTRIBUTE, undefined);
					rig.SetAttribute(WALK_TO_JOIN_PAD_AT_ATTRIBUTE, undefined);
					rig.SetAttribute(WALK_TO_JOIN_PAD_LOOK_AT_ATTRIBUTE, undefined);
				}

				for (const tag of tags) {
					if (tag !== NPC_TAG) rig.AddTag(tag);
				}

				rig.AddTag(NPC_TAG);

				// The state is on this line because it is the thing that was wrong every time this
				// went wrong: a rig that is standing and limp prints a state that is not a live one,
				// and a rig that prints a live state while still looking wrong is wrong somewhere
				// else entirely. **The side is on it for a different reason**: whether the replacement
				// is a participant is the one fact about this respawn that is not visible in the
				// Explorer twice over (the tag set looks identical either way), and this is the line
				// the next log will be read for.
				//
				// **And where it came back, which is the third fact of that kind.** A replacement put in
				// the wrong *room* is not visible in the Explorer either — the tag set and the side read
				// identically — and it is the one thing that made a respawn into the lobby look like a rig
				// that never came back at all. Printed from the point this decided on rather than from the
				// rig's position a frame later, because that point is what the rebuild placed.
				if (DEBUG) {
					const sideLabel = team === undefined ? "no side" : `side ${team}`;
					const at = destination.Position;

					print(
						`[NPC] ${name}: back — health ${fresh.Health}, state ${fresh.GetState()}, ${sideLabel}, ` +
							`at ${string.format("%.0f, %.0f, %.0f", at.X, at.Y, at.Z)}`,
					);
				}

				// The other half of `Npc.Respawn.onDied`, which opened after this thread's last early
				// return. Nothing between the two can yield — `Destroy`, the attribute writes, the reparent
				// and the tag writes are all synchronous — so the pair is closed in the same resumption it
				// was opened in, which is what makes a `debug.profileend` here mean anything.
				if (DEBUG_CONFIG.PROFILE) debug.profileend();
			});
		},
	};
}
