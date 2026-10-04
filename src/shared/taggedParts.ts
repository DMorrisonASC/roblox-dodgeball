import { CollectionService, Workspace } from "@rbxts/services";

/**
 * Every `BasePart` wearing `tag` — on the part itself, **or inside a container that wears it**.
 *
 * **The rule is one sentence: a tag on a part means that part, and a tag on anything else means the
 * parts inside it.** A folder or a model wearing the tag is expanded into its `BasePart`
 * descendants, and a part wearing it is taken as it is. Which of the two somebody did in Studio
 * therefore stops being a correctness question and becomes a matter of taste: tag the six spawner
 * parts, or tag the folder holding them, and the answer is the same six parts.
 *
 * **This exists because the other rule has cost three separate afternoons.** `CharacterBarrier` was
 * put on a folder and the barrier pass found nothing — and the first fix for it made the walk
 * *class*-based, which then broke on an arena that was a `Folder` rather than a `Model`.
 * `MatchJoin` was put on a model wrapping the pad, and the pad stopped answering. `MatchSpawner` (then
 * called `BallSpawner`) was put on the folder around the spawn parts, and the arena went unstocked with
 * nothing in the output to say why. Every one of those readings was reasonable — "tag the thing that holds the parts" is
 * how a person describes a group of parts — and every one of them was silently wrong, because
 * `GetTagged` hands back the container and the code only ever wanted parts. The lesson is not that
 * the tag should go somewhere else; it is that reading a tag is this file's job, and it should mean
 * what the person who placed it meant.
 *
 * **The class is part of the answer, and the name is not part of the question at all.** The tagged
 * instance's class is deliberately unchecked — that is the whole of the expansion — but what comes
 * back is always a `BasePart`, because every caller does a part's business with it: a position to
 * spawn beside, a `CFrame` and `Size` to test a body against, a `CollisionGroup` to assign.
 * **This is not for callers that want a `Model`.** `NpcService` and `RoundService.roundParticipants`
 * want rigs, and a rig's torso is not a rig; they read the `NPC` tag directly and check the class
 * themselves. Nor is anything here matched by name, which is the other half of the same lesson —
 * `findFolder`'s note records a `Folder` called `ArenaSpawns` shadowing the real one, and a lookup
 * that had gone by name alone would have returned it.
 *
 * **Duplicates are removed, and that is not tidiness.** A part tagged directly whose parent folder
 * is *also* tagged would otherwise come back twice, and the callers that pass the result straight
 * into per-instance work would do that work twice: `MatchService.prepare` would connect a second
 * `Touched` and mount a second sign on one pad, and `BallSpawnerService.tick` would count the same
 * part's neighbourhood twice in one tick. The `Set` below is the fix, and it is why this can be a
 * plain array on the way out — callers only ever iterate.
 *
 * **`Workspace` is not filtered here, and that is what {@link taggedPartsInWorkspace} is for.** This
 * answers "which parts wear this tag"; where they live is a second question, and not every caller asks
 * it. So the two questions are two functions rather than one function and a flag, and a caller says
 * which it means by which one it calls: this one when it has its own space rule or none, the other when
 * it is about to act on the parts in the world. Both names are the rule — `taggedParts` says "the tag",
 * `taggedPartsInWorkspace` says "the tag, in the world" — which is the whole reason there is no third
 * one and no boolean.
 *
 * **Reads only.** Several tag readers in this codebase also subscribe to `GetInstanceAddedSignal` and
 * `GetInstanceRemovedSignal` — `NpcService`, `OutlineService`, and `CollisionGroups`' character pass —
 * and a scan has no answer for a subscription. Those stay as they are; this replaces the scan.
 */
export function taggedParts(tag: string): Array<BasePart> {
	const parts = new Array<BasePart>();
	const seen = new Set<BasePart>();

	for (const instance of CollectionService.GetTagged(tag)) {
		// A part wears the tag itself. The common case, and the one the `Set` matters least for —
		// until the same part is also inside something else that is tagged.
		if (instance.IsA("BasePart")) {
			if (seen.has(instance)) continue;

			seen.add(instance);
			parts.push(instance);
			continue;
		}

		// **Anything else with the tag is a container, and a container is its parts.** A `Folder`, a
		// `Model`, a `Tool` — the class is not asked, because asking it is what made this a puzzle
		// three times over. A container holding nothing usable contributes nothing and says nothing;
		// a caller that needs to report that compares this against its own count of tagged things,
		// which is what `BallSpawnerService.report` does.
		for (const descendant of instance.GetDescendants()) {
			if (!descendant.IsA("BasePart")) continue;
			if (seen.has(descendant)) continue;

			seen.add(descendant);
			parts.push(descendant);
		}
	}

	return parts;
}

/**
 * Every `BasePart` wearing `tag` **that is in `Workspace`** — {@link taggedParts}, with the world as an
 * extra condition.
 *
 * **The filter is a rule about what a tag can mean rather than a precaution.** A part outside the world
 * is not simulated, not touchable and not visible: it is a template in `ServerStorage`, a rig
 * mid-rebuild, an arena somebody has detached while they move it about, or a `Clone` waiting to be
 * placed. Nothing can walk into it, no ball can come to rest on it, and no collision group it is in can
 * stop anything — so a tag on one is a claim the world cannot honour, and the honest reading of "where
 * are the spawners" is "not there".
 *
 * **The reasoning, gathered from the three call sites that used to write it out.** A spawner outside
 * the world is not stocking anything, and topping one up puts balls parented to `Workspace` into empty
 * space where the arena is not: the tag answers "is this a spawner", and where it is answers "is it
 * somewhere a ball can lie". A wall outside the world is not a wall — `GetTagged` answers about every
 * tagged instance in the game, including one in a template in `ServerStorage` or a model mid-rebuild.
 * And a shift-lock zone outside the world is not somewhere a player can walk into: a part's `CFrame` is
 * world-space regardless of its parent, so a zone inside an unplaced arena would be evaluated at those
 * coordinates, from inside the lobby. Three different failures, one condition — which is why it is a
 * function rather than a line each caller is trusted to remember.
 *
 * **Not for every caller, and the two that stay on {@link taggedParts} are the argument for keeping
 * both.** `MatchService` prepares a pad wherever it is, because what it does — set four properties,
 * connect `Touched`, mount a sign — is wanted by the time the pad *is* in the world, and filtering
 * would silently drop one that was about to be parented. `ShiftLock.onStart` counts the tag at boot and
 * wants the honest total, because a zero there is the difference between "the box is in the wrong
 * place" and "nothing is tagged" — and a misplaced zone is exactly the fault that line exists to
 * report. Each of those is a caller with its own space rule, or none, which is the choice
 * {@link taggedParts} leaves open.
 */
export function taggedPartsInWorkspace(tag: string): Array<BasePart> {
	return taggedParts(tag).filter((part) => part.IsDescendantOf(Workspace));
}
