import { CollectionService, Workspace } from "@rbxts/services";
import { BALL_NAME } from "shared/constants";
import { NPC_CONFIG } from "shared/config/npc.config";
import { BEHAVIOR_RESPAWN, NPC_TAG, NpcBehavior } from "../Behavior";
import type { BallService } from "../../services/BallService";

const DEBUG = true; // prints each rig that goes down and each that comes back

/**
 * Respawning, for an NPC.
 *
 * A rig wearing this tag comes back after it is killed, which is the one thing a
 * test rig wants that a player gets from the engine: a dummy that has been
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
 * needed. What comes back is what the engine gives a player who dies: a rig that
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

				rig.Parent = Workspace;

				for (const tag of tags) {
					if (tag !== NPC_TAG) rig.AddTag(tag);
				}

				rig.AddTag(NPC_TAG);

				// The state is on this line because it is the thing that was wrong every time this
				// went wrong: a rig that is standing and limp prints a state that is not a live one,
				// and a rig that prints a live state while still looking wrong is wrong somewhere
				// else entirely.
				if (DEBUG) print(`[NPC] ${name}: back — health ${fresh.Health}, state ${fresh.GetState()}`);
			});
		},
	};
}
