import { OnStart, Service } from "@flamework/core";
import { CollectionService, Players } from "@rbxts/services";
import { OUTLINE_CONFIG } from "../../config/outline.config";
import { NPC_TAG } from "../../npc/Behavior";

/** Prints a line as an outline is put on. Silent about the ones that were already there. */
const DEBUG = true;

/**
 * What the outline is called, and the whole of how one is recognised again.
 *
 * A `Highlight` on its own is indistinguishable from a highlight something else made, so
 * the name is what makes {@link applyOutline} idempotent: a second pass over a rig or a
 * ball that already wears one finds this name and stops. `ObjectOutline` rather than
 * `CharacterOutline`, because it now adorns both and the ball is not a character — the
 * name should not say it is.
 */
const OUTLINE_NAME = "ObjectOutline";

/**
 * The tag a ball carries, watched so every ball is outlined the moment it is tagged.
 *
 * **Must match the `tag` in `BallComponent`'s decorator**, which is the source of truth:
 * the decorator is what turns a ball into a component, and Flamework reads that literal at
 * build time, so it cannot be imported from here. This is therefore a copy rather than a
 * shared constant — exactly as it is in `BallService` and `BallPickupService`, which are
 * the other two readers of a name that three files have to agree on.
 */
const BALL_TAG = "Ball";

/**
 * Outlines every rig and every ball in the game — players, NPCs, and the balls they throw.
 *
 * Built on the **server** so the outline is part of what replicates: every client sees
 * it on every rig and every ball without a remote and without a client script, and a
 * thing this service never touched is a thing nobody outlines. The alternative — each
 * client outlining what it can see — would be the same rendering, with a per-client hook
 * and a per-client chance to disagree about it.
 *
 * One `Highlight` does all the work, for a rig and for a ball alike. It draws the
 * adornee's own silhouette, so the accessories and anything in a character's hands are
 * covered by saying nothing about them, and there is no second copy of the mesh to keep
 * in step with the first. The whole lifecycle is therefore "put one on when a thing
 * appears" — a `Highlight` is destroyed with what it adorns, so nothing has to be taken
 * off again, and nothing has to be pooled for the ball's comings and goings.
 */
@Service()
export class OutlineService implements OnStart {
	public onStart(): void {
		Players.PlayerAdded.Connect((player) => this.watch(player));

		// A player already in the game when this service started never fires the
		// added-signal, so the ones already here are walked rather than waited for. The
		// same scan-and-subscribe `NpcService` does for its tag, for the same reason.
		for (const player of Players.GetPlayers()) this.watch(player);

		// The two tags, watched identically. A rig and a ball differ in what they are,
		// not in how they are found: both are tagged, and both arrive through the same
		// pair of mechanisms. See {@link watchTag}.
		this.watchTag(NPC_TAG);
		this.watchTag(BALL_TAG);
	}

	/**
	 * Outlines everything wearing `tag`: what is in the world now, and what arrives later.
	 *
	 * One method for both tags because there is one behaviour — a `Highlight` on the
	 * instance, once — and the only thing that differs between a rig and a ball is which
	 * tag it wears. Neither half is redundant: a rig or a ball tagged before this service
	 * started never fires the signal, and one tagged afterwards is never in the initial
	 * `GetTagged`.
	 *
	 * Balls churn through this constantly — a fresh one is welded into a hand on every
	 * throw — and that is fine. The signal fires, a highlight is created, and both go away
	 * with the ball; there is nothing to keep in step and nothing to pool.
	 */
	private watchTag(tag: string): void {
		for (const instance of CollectionService.GetTagged(tag)) applyOutline(instance);

		CollectionService.GetInstanceAddedSignal(tag).Connect((instance) => applyOutline(instance));
	}

	/**
	 * Arranges an outline for `player`: one now, if they already have a character, and
	 * one on every character they are given afterwards.
	 *
	 * Per **character** rather than per player, because a character is what the outline
	 * hangs off and characters are replaced on every death. Subscribing on `PlayerAdded`
	 * alone would leave the first character outlined and every respawn bare.
	 */
	private watch(player: Player): void {
		player.CharacterAdded.Connect((character) => applyOutline(character));

		const character = player.Character;
		if (character) applyOutline(character);
	}
}

/**
 * Puts a black outline around `target`, once.
 *
 * Takes any `Instance` because an outlined thing is not always a character: a rig is a
 * `Model` and a ball is a `BasePart`, and `Highlight.Adornee` accepts either. It draws
 * whatever silhouette the adornee has, so nothing here has to know which it was handed.
 *
 * `FillTransparency = 1` is what makes this an outline rather than a tint: the fill is
 * gone and only the edge is drawn. `Occluded` rather than `AlwaysOnTop` is the other half
 * of the look — the outline is hidden by whatever hides the thing it adorns, so a rig or a
 * ball behind a wall is one nobody can see, and nobody sees it *through* the wall either.
 * That matters at least as much for the ball as for the rig: an outline that showed
 * through geometry would be a free read on where a throw is coming from.
 *
 * Idempotent by name, and that is load-bearing twice over: `CharacterAdded` can fire for a
 * character this has already dressed, and a tag signal can deliver an instance this has
 * already seen — a second highlight would be a second edge on every silhouette.
 *
 * Nothing is taken off again. The highlight is a child of what it adorns, so it goes away
 * with it, which is what makes the ball's churn — a fresh ball welded into a hand on every
 * throw — cost one `Highlight` and nothing else.
 */
function applyOutline(target: Instance): void {
	if (!OUTLINE_CONFIG.ENABLED) return;

	const existing = target.FindFirstChild(OUTLINE_NAME);
	if (existing !== undefined && existing.IsA("Highlight")) return;

	const highlight = new Instance("Highlight");
	highlight.Name = OUTLINE_NAME;
	highlight.FillTransparency = 1;
	highlight.OutlineTransparency = 0;
	highlight.OutlineColor = OUTLINE_CONFIG.COLOR;
	highlight.DepthMode = Enum.HighlightDepthMode.Occluded;
	highlight.Adornee = target;
	highlight.Parent = target;

	if (DEBUG) print(`[Outline] ${target.Name}: outlined`);
}
