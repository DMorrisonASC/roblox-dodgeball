/**
 * Finding a named thing in a tree, **searching the whole tree rather than its first level**.
 *
 * **Nesting is the norm in this project's place files, not the exception.** Arena spawn folders sit
 * inside grouping folders inside the map's model, the barriers sit in a folder of their own, and the
 * lobby is a loose part whose name once shadowed a folder's. Anything that looks for a part, a folder
 * or a model by name therefore has to search *everything under its root* — and this is that search,
 * written once so that the rule is stated in one place instead of re-derived by each caller.
 *
 * **The class is part of the question, and that is not fussiness.** `FindFirstChild(name, true)`
 * answers with the first instance *of that name whatever it is*, so a `Folder` called `ArenaSpawns`
 * shadows the real one and the lookup reads as "this map has no spawns" with the thing it wanted a
 * few studs away. Requiring the type *while* walking means a decoy of the wrong class is passed over
 * rather than returned as the answer. `RoundService.lobbySpawn` learned this the hard way.
 *
 * **The exception is a structure the game itself requires, and it has to be justified where it is
 * used.** Some layouts are an interface rather than an accident: a playable map has to offer
 * `ArenaSpawns` with an `A` and a `B` inside it, and a lookup may rely on that. What may *not* be
 * relied on is where something happens to sit today — these place files are reorganised constantly,
 * and "it is a child of the map" is a fact that expires. Where a fixed path is kept, the reason
 * belongs in the comment beside it: the names being shared config, the shape being part of what a
 * map *is*, and a violation being reported rather than passing silently.
 *
 * **The folder lookup was the only one in here for a long time, and {@link findTemplate} is the second.**
 * A `findModel` sat beside it for the map rotation and went with `MapService` when that was deleted —
 * `RoundService` is the only remaining caller, and it wants folders. A second `findModel` was written here
 * for the catch shockwave's template and taken back out again the same day: that lookup accepts a `Model`
 * *or* a loose `BasePart`, which this file's one-class-per-helper shape could not ask at the time, so the
 * walk went to live beside each effect that needed it. **Four effects later, the shape is what was wrong** —
 * "a template" is a two-class question by definition, because whether a person wrapped the carrier in a
 * `Model` is packaging with no behaviour attached to it — so the walk is back here with that question
 * settled. The client's four copies stay where they are for now; see {@link findTemplate}'s own doc.
 */

/** The first descendant of `root` called `name` that is a `Folder`, or nothing. */
export function findFolder(root: Instance, name: string): Folder | undefined {
	for (const descendant of root.GetDescendants()) {
		if (descendant.Name !== name) continue;
		if (!descendant.IsA("Folder")) continue;

		return descendant;
	}

	return undefined;
}

/**
 * The first descendant of `root` called `name` that is **an effect template** — a `Model` or a `BasePart`,
 * or, when the name was put on the emitter or attachment inside one instead, the nearest part above it,
 * because that part is the thing a caller can clone and weld to a body.
 *
 * **This is "the contract with a template is its name and nothing else", written once.** `HANDOFF.md` §17
 * states the rule for the body effects: nothing may depend on where in `ReplicatedStorage` a template sits
 * or what it is wrapped in, because those are things a person moves. The rule was first implemented four
 * times over — `client/hitVfx.ts`, `client/windBurst.ts`, `client/chargeEffect.ts` and
 * `client/catchShockwave.ts` each carry their own copy of this walk under their own doc — and those four
 * are **deliberately left alone by this change**: they work, they are client-side, and folding them onto
 * this function would be a refactor of four effects inside a task about one lookup. What it exists for now
 * is the *server*'s copy: `BallService.attachPierceEffect`, which cannot import a client module and had
 * been looking up `ReplicatedStorage.VFX.PierceTrail` by path.
 *
 * **`root` rather than `ReplicatedStorage` hard-coded**, because "where do you look" is the caller's fact
 * and not a property of templates: the client modules all look in `ReplicatedStorage`, and a server that
 * clones an effect for its own use may want `ServerStorage`. The search is `GetDescendants`, so a template
 * wrapped in one folder or five is found identically — which is the whole point.
 *
 * **Three levels of the name, because the usual build has three.** `BasePart > Attachment > ParticleEmitter`
 * is what an authored effect looks like, and a person names the level they were looking at: the part when
 * they are thinking of the object, the emitter when they are thinking of the particles. The two lower levels
 * resolve *upward* through {@link templateCarrier} — an `Attachment` has no frame of its own in the world and
 * a `ParticleEmitter` cannot be cloned into anything weldable, so the part that carries them is the answer
 * either way.
 *
 * **Still not "anything by that name".** A `Folder`, a `Sound` or a `BillboardGui` called `PierceTrail` is not
 * a template, and returning one would push the failure down to "there is nothing to weld", where it reads as
 * a fault in the caller rather than as a missing template.
 */
export function findTemplate(root: Instance, name: string): Model | BasePart | undefined {
	for (const descendant of root.GetDescendants()) {
		if (descendant.Name !== name) continue;
		if (descendant.IsA("Model") || descendant.IsA("BasePart")) return descendant;

		// A name on the emitter or on the attachment inside the carrier. An attachment whose own name is the
		// template is the case a `BasePart > Attachment > ParticleEmitter` build produces when somebody
		// renames the middle of the three, and resolving it here rather than refusing it costs nothing and
		// saves a warning that says "missing" about a template that is plainly there.
		if (descendant.IsA("ParticleEmitter") || descendant.IsA("Attachment")) {
			const carrier = templateCarrier(descendant);
			if (carrier !== undefined) return carrier;
		}
	}

	return undefined;
}

/**
 * **The nearest thing above `effect` that can be cloned and welded: the first `BasePart`, or a `Model` with
 * no part between it and the effect.**
 *
 * Upward and stopping at the first part, which is the rule all four client copies settled on
 * independently: a `Model` *above* the carrier is somebody tidying their `ReplicatedStorage` rather than a
 * second thing to place, and climbing to it would drag whatever else that model holds along with every
 * copy of the effect. A `Model` is still accepted when there is no part between it and the emitter, which
 * is the other shape a person can build.
 *
 * **The climb passes through an `Attachment` without stopping at it**, because that is exactly the case it
 * is here for — the attachment is a place inside a part, not a thing in the world.
 *
 * Returns nothing when the name sits on an effect with no part above it at all, which is a template nobody
 * can weld to anything; the caller reports that rather than this guessing at a wrapper.
 */
function templateCarrier(effect: Instance): Model | BasePart | undefined {
	let node = effect.Parent;

	while (node !== undefined) {
		if (node.IsA("BasePart")) return node;
		if (node.IsA("Model")) return node;

		node = node.Parent;
	}

	return undefined;
}
