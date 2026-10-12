import { CollectionService, Workspace } from "@rbxts/services";
import { BALL_NAME, TEAM_ATTRIBUTE } from "shared/constants";
import { NPC_CONFIG } from "shared/config/npc.config";
import { TEAM_A, TEAM_B } from "../../services/round/team";
import { BEHAVIOR_RESPAWN, NPC_TAG, NpcBehavior } from "../Behavior";
import { WALK_TO_JOIN_PAD_ATTRIBUTE, WALK_TO_JOIN_PAD_SIDE_ATTRIBUTE } from "./WalkToJoinPadBehavior";
import type { BallService } from "../../services/ball/BallService";

const DEBUG = true; // prints each rig that goes down and each that comes back

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
	 * one does to a rig that is not already upright. Read once per rig and carried to
	 * its replacement: a rig that has been knocked down has been knocked down
	 * *somewhere*, and the point of a respawn is to come back where it was put, not
	 * where its body happened to fall.
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

			// Kept whole when it dies, for the one thing this behavior still needs a corpse
			// for: its name and its tags. Not put back if the tag is taken off later, so it
			// belongs on a rig you tagged on purpose. What it costs a rig you did not: a death
			// that reads as a body falling over rather than as an explosion.
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

		onDied(model) {
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

				const rig = template.Clone();
				const fresh = rig.FindFirstChildWhichIsA("Humanoid");
				const root = rig.FindFirstChild("HumanoidRootPart");
				if (!fresh || !root || !root.IsA("BasePart")) return;

				// Full health, which is not the same as the template's: a rig that had been hurt
				// before it was killed would otherwise come back carrying the damage it never
				// died of.
				fresh.Health = fresh.MaxHealth;

				model.Destroy();
				homes.delete(model);
				templates.delete(model);
				folders.delete(model);

				// **Placed by its root part, not by `PivotTo`.** A model pivot has no orientation of
				// its own — it is a point — so moving a model by one moves it without turning it,
				// which is how a rig ends up standing *at* the right spot while lying on its back
				// there. A root part's CFrame carries both, and the joints carry the rest of the
				// rig along with it.
				root.CFrame = home;

				// Every tag off the copy and back on again, rather than trusting `Clone` to have
				// carried them: `NpcService` starts a loop when the entry point *arrives* on a
				// model, and a tag that is already there cannot arrive. The behaviors go back first
				// and `NPC` last, so the rig is finished by the time the loop it starts looks at
				// it — the same order `spawn` uses, for the same reason.
				for (const tag of tags) rig.RemoveTag(tag);

				// Handed on before the entry point arrives: they belong to the rig that is here now,
				// and the loop about to start will ask for them on its first turn.
				homes.set(rig, home);
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

				// **Written before the entry point arrives, exactly like the tags two lines down**, so the
				// loop that starts on `NPC` finds a body that already has its side rather than one that
				// becomes a participant a turn later. A corpse with no side of its own — a rig that was
				// never in a round — writes nothing, and comes back exactly as side-less as it was.
				//
				// **And a rebuilt rig that holds a side is a round body, not a lobby walker**, so the
				// destination it was once given goes the moment the side is written. The *tag* is already
				// absent by then — `WalkToJoinPadBehavior` takes it off when the rig arrives, which is the fix
				// for the bug that produced this guard — but the two *attributes* travel with the template,
				// because `prepare` strips tags from the copy it takes and not attributes. So a rebuilt rig
				// stands there with a stale lobby pad in its pocket, and the two are halves of one instruction:
				// "walk to this point". A round body should carry neither. **A corpse with no side is the other
				// case and keeps both** — a lobby walker that dies and comes back still knows where its pad
				// is, and nothing else would tell it again.
				if (team !== undefined) {
					rig.SetAttribute(TEAM_ATTRIBUTE, team);
					rig.SetAttribute(WALK_TO_JOIN_PAD_ATTRIBUTE, undefined);
					rig.SetAttribute(WALK_TO_JOIN_PAD_SIDE_ATTRIBUTE, undefined);
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
				if (DEBUG) {
					const sideLabel = team === undefined ? "no side" : `side ${team}`;

					print(
						`[NPC] ${name}: back — health ${fresh.Health}, state ${fresh.GetState()}, ${sideLabel}`,
					);
				}
			});
		},
	};
}
