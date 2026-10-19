import { CollectionService, ServerStorage, Workspace } from "@rbxts/services";
import { NPC_CONFIG } from "shared/config/npc.config";
import { EQUIPPED_TRAIL_ATTRIBUTE, THROWER_TOKEN } from "shared/constants";
import { findFolder } from "shared/find";
import { NPC_TAG } from "./Behavior";

/**
 * **The pool the placeholder rigs are drawn from: a name from a fixed list, a body from a folder, and
 * neither one held by two live rigs at once.**
 *
 * **Silent reuse is the fault this file exists to prevent.** A lobby of placeholders is pretending to be a
 * room full of people, and the two cheapest tells are two bodies wearing one name and two bodies wearing one
 * face — a player who sees `ToxicMuffin` twice stops reading them as people at all. So both draws are made
 * from what is *free*, and both are given back the moment a rig stops being live.
 *
 * **Live uniqueness is the whole of the rule, and it is why nothing here is stored** — see
 * {@link readRigPool}. There is no ledger of who has held what, no per-server history and no rule about how
 * recently a name was used; a name is either on a body the server can find right now or it is in the pool.
 *
 * **A module rather than a service, and rather than a private method on `LobbyRigService`.** It is a
 * derivation over the live tree with no lifecycle, no state and no injected dependency, which is the shape
 * `npc/rigs.ts` and `npc/sideZones.ts` already have beside it — and the shape `HANDOFF.md` §0 calls for: a
 * service here would be Flamework ceremony and an entry in `flamework.build` for two queries that one file
 * asks. The cost of the shape not picked, stated: a private method would keep the twenty-name list inside
 * a service file that is already the longest in the repository, and would put a rule about *rigs* in the file
 * that counts their *seats*.
 */

/**
 * **The names a placeholder rig may wear, and the whole list — nothing here generates one.**
 *
 * **Written out rather than composed from parts, deliberately.** A generator would be a shorter file and a
 * worse feature: these are meant to read as the handles people give themselves, they are the user's own list,
 * and a list is the only form in which "is this one already in use" is a question about a *fixed set* rather
 * than about arithmetic. It is also the only form in which a person can read the file and know every name the
 * lobby can produce.
 *
 * **Not tuning, so no `Placeholder` marker** — the count is a *ceiling* rather than a knob, and the boot line
 * prints it beside the model count so that the ceiling is a fact in the log. **The list is the user's and its
 * length is theirs to change**; what this file owes in exchange is the refusal in {@link drawRigIdentity},
 * which is what stops a raised rig cap from quietly producing two `NinjaWaffle`s.
 *
 * **What this is not:** not a naming *convention* — these are aliases, not identifiers. Nothing parses them,
 * nothing sorts by them, and no code anywhere may treat a rig's `Name` as meaningful beyond being the string
 * a player reads. That rule matters more here than it usually would: the pool's own identity for a rig's
 * *body* is a separate attribute, precisely so that nothing is ever tempted to decode the name.
 */
export const RIG_NAMES: ReadonlyArray<string> = [
	"ShadowVex7",
	"GiantDiva",
	"PixelPhantom23",
	"FrostByte99",
	"NeonBandit",
	"CosmicChaos12",
	"TurboNovaX",
	"VelvetVenom8",
	"RogueComet47",
	"MysticAce",
	"ChaosKit21",
	"LunarLegend3",
	"ToxicMuffin",
	"ThunderPix64",
	"GoldenGoblin",
	"AstroFreak17",
	"NinjaWaffle",
	"GlitchKing09",
	"SolarRebel5",
	"TinyTitan42",
];

/**
 * **The attribute naming the model a rig was cloned from** — the source model's `Name` inside
 * `NPC_CONFIG.RIG_POOL_FOLDER`, as a string.
 *
 * **An attribute rather than a side-table, and the deciding factor is the respawn.** `RespawnBehavior`
 * rebuilds a rig from a **template cloned while that rig was alive and on its feet** — not from the corpse,
 * which is never cloned at all (and is in pieces by the time the rebuild happens, since
 * `BreakJointsOnDeath` is the engine default again) — so anything written on the rig travels to the
 * replacement for free: `Clone` copies `Name` and the attributes of the body it was taken from, and the
 * corpse contributes its tags and its `Team` by being *read*, not by being copied. A `Map<Model, Model>`
 * keyed on the rig would need `RespawnBehavior` to know about the pool, which it otherwise has no business
 * knowing. The same property is what makes a *release* automatic: a destroyed rig is not found by the walk in
 * {@link readRigPool}, so it cannot be holding anything.
 *
 * **A name rather than a reference, because an attribute cannot hold an `Instance`.** The typings disagree
 * with themselves about whether `SetAttributeValue` accepts one — `AttributeValue` has no `Instance` in it
 * while the method is declared as taking `AttributeValue | Instance` — and the same trade is already recorded
 * on `WALK_TO_JOIN_PAD_ATTRIBUTE`, which stores a `Vector3` point for exactly this reason. **What the name
 * costs is ambiguity**: two models in the folder with one name are indistinguishable, so
 * {@link readRigPool} refuses to draw either of them and `LobbyRigService` says so at boot. A duplicate name
 * is a folder fault that this file cannot repair and must not paper over.
 *
 * **Declared here rather than in `shared/constants.ts`, on the precedent of the four walk attributes**: the
 * pair that has to agree is the writer and the reader, both are on the server, and no client has any idea a
 * pool exists — so `shared/constants.ts`'s reason for existing (two machines that cannot import from each
 * other) does not apply. Unlike a *tag*, nothing in a place file names an attribute.
 */
export const RIG_TEMPLATE_ATTRIBUTE = "RigTemplate";

/**
 * What the pool looks like right now, **derived from the folder and from the live rigs and stored nowhere.**
 *
 * **Every field is a derivation, and that is the design rather than an implementation detail.** The
 * alternative shape is a module-level map of who holds what, maintained by the spawn and destroy paths — and
 * its failure mode is the one this project keeps re-learning: a `Destroy` that forgets to delete its row
 * leaks a name and a body for the rest of the session, and the symptom is a lobby that slowly runs out of
 * names with nothing in the output to say why. The project's own answer to that class of bug is written at
 * `applyBarrierGroups` and in `TAGS.md`: **re-derive from the live tree, because a cache cannot be trusted
 * to have been told about every edit.** Here the payoff is exact — a rig destroyed by a path that has never
 * heard of this file is released *because it stopped being findable*, which is a property no ledger can have.
 *
 * **What the derivation costs, named.** A `CollectionService` tag query, a walk of `ServerStorage` for the
 * folder, and a handful of attribute reads, once per spawn — and a spawn is a rig being made, which is a
 * handful a minute at most. The lobby is eight rigs; the walk is free at that size and would not be at a
 * thousand.
 */
export interface RigPool {
	/**
	 * The folder's `Model` children, in tree order — **including any that cannot be drawn.**
	 *
	 * Kept whole rather than pre-filtered because three readers want different things from the same walk: this
	 * is what the boot line counts and what the fault check inspects, {@link RigPool.usableModels} is which of
	 * them are rigs at all, and {@link RigPool.freeModels} is what a draw may use.
	 */
	readonly models: ReadonlyArray<Model>;

	/**
	 * The folder's models that are **structurally a rig** — a `Humanoid` and a `HumanoidRootPart`.
	 *
	 * **A model that is nothing like a rig must not take a seat, and that is the whole of why this exists.**
	 * The two children are not decoration: `Humanoid.MoveTo` needs a humanoid, and every reader of "where is
	 * this rig" — `resolveDodgeable`, `NpcService.ownForServer`, `WalkToJoinPadBehavior.tick` — addresses the
	 * body through its root. A free model dropped into the folder can easily be neither (a prop, a mesh, a rig
	 * whose root somebody renamed), and drawing it costs **a name, a seat and a body that will never move** —
	 * while the next real player to arrive destroys *some* rig to make room, and may well pick a working one.
	 *
	 * **Reported as well as excluded**, because the two faults are different: the boot line names the models
	 * through {@link poolModelWarnings}, and the draw refuses the surplus. See {@link rigProblem}, which is the
	 * one test both use so they cannot drift apart.
	 */
	readonly usableModels: ReadonlyArray<Model>;

	/**
	 * Names the folder uses twice or more — **ambiguous, so the two cannot be told apart as sources.**
	 *
	 * A rig records its source by *name*, so two same-named models are one source as far as a release is
	 * concerned. That is no longer a reason to refuse them — the draw repeats a face when it has to — but it is
	 * a reason to say so, because the boot line's model count will overstate how many different faces the
	 * folder can show and nothing else would explain the gap.
	 */
	readonly duplicatedNames: ReadonlyArray<string>;

	/** The names from {@link RIG_NAMES} that no live rig wears. */
	readonly freeNames: ReadonlyArray<string>;

	/**
	 * The folder's models that are neither ambiguous nor named by a live rig's {@link RIG_TEMPLATE_ATTRIBUTE}.
	 *
	 * **A preference rather than a limit**, and that distinction is the whole of the lobby's size rule: a
	 * model is drawn from here while one is free, and a face is *repeated* once none are, because a seat left
	 * empty to keep two rigs looking different is a match played a body short. See {@link drawRigIdentity}.
	 */
	readonly freeModels: ReadonlyArray<Model>;

	/**
	 * The folder's models **worn by the fewest live rigs** — the faces a draw spends once every one is taken.
	 *
	 * **The repeats are the same, and which faces carry them is what this changes.** A folder with fewer
	 * usable models than seats *must* show some body twice, so "do not repeat" is not available; what is
	 * available is *spread the repeats thinly*, and that is the difference a player sees. Drawing uniformly
	 * from the whole usable set — which is what this was — can put the same face on three or four rigs while
	 * a second model sits on one, and the report that produced this field is exactly that: a rig appearing
	 * beside another wearing an identical body when the folder held a face nobody was using twice.
	 *
	 * **A minimum, not a count**, because that is all the draw needs: the set of faces tied for fewest uses is
	 * the set a repeat should come from, and drawing from it makes the usage counts converge rather than
	 * drift. It costs one extra pass over the folder, per spawn, in a file that already walks the folder.
	 *
	 * **Ambiguous names are left out**, for {@link RigPool.freeModels}' reason: two models with one name are
	 * one source as far as a rig's recorded origin is concerned, so the pair cannot be told apart and the
	 * boot line has already asked for a rename.
	 */
	readonly leastWornModels: ReadonlyArray<Model>;
}

/**
 * The draw, or the reason there is none.
 *
 * **`ok` carries the two facts the caller needs** — the name to write on the rig and the model to clone —
 * so the spawn does not read the pool a second time to find them. This is `PurchaseDecision`'s shape, for its
 * reason: a decision that said only "yes" would leave the caller doing the same lookup this file already did,
 * and a decision that said only "no" would leave the caller inventing the sentence a person has to act on.
 */
export type RigDraw =
	| {
			readonly ok: true;
			readonly name: string;
			readonly template: Model;

			/**
			 * **Whether this face is already on a live rig** — true exactly when the draw had no free model to
			 * spend, so every body in the folder was worn when this rig was made.
			 *
			 * **Carried rather than left to the caller to work out**, because working it out means reading the
			 * pool a second time, and because a repeated face is otherwise *invisible*: two bodies wearing one
			 * model look like a folder holding one model, and nothing in the output says which it is. The two
			 * spawn lines in `LobbyRigService` append a sentence when this is true.
			 */
			readonly repeatedFace: boolean;
	  }
	| { readonly ok: false; readonly reason: string };

/**
 * The model a rig was cloned from, or nothing — **the validated read of {@link RIG_TEMPLATE_ATTRIBUTE}.**
 *
 * Validated rather than trusted for `sideOfRig`'s reason: an attribute is a string anybody can write, and a
 * rig wearing `RigTemplate: true` is a rig whose source is unknown rather than one cloned from a model called
 * "true".
 *
 * **Read *before* a rig is destroyed, never after.** The attribute does survive the `Destroy` in the same Lua
 * frame, but reading a fact off a body on its way out is an order nobody should have to reason about — which
 * is the same sentence `LobbyRigService.reserveSeat` records for the side it reads before its own destroy.
 */
export function sourceOf(rig: Model): string | undefined {
	const source = rig.GetAttribute(RIG_TEMPLATE_ATTRIBUTE);

	return typeIs(source, "string") && source !== "" ? source : undefined;
}

/**
 * **Why this model cannot be a rig, or nothing if it can — the one structural test in this file.**
 *
 * **Two children, and they are the two that decide whether the body can ever do anything.** A `Humanoid` is
 * what walks, and its absence is not a cosmetic difference: `NpcService` registers the model, finds no
 * humanoid, and says "nothing to run behaviors on" — the model then holds a seat for the session and is
 * still standing there when the round starts. A `HumanoidRootPart` is what every part of this project means
 * by "where this rig is" (`resolveDodgeable` falls back to `PrimaryPart` and then *any* `BasePart`, so a
 * model without one does not fail — it silently resolves to the wrong part), and a humanoid with no root to
 * stand on has nothing to walk with.
 *
 * **What a model with no root does instead — no log line names it, and nothing fails.** `resolveDodgeable`
 * falls back to `PrimaryPart` and then to *any* `BasePart`, so every reader of "where is this rig" gets an
 * answer and none of them complains; what is missing is the assembly, so `Humanoid.MoveTo` has nothing to
 * walk, and a body with a humanoid and no assembly is one the engine's own balance correction keeps picking
 * up and putting back down. **A body that hops on the spot is what that looks like from across the room** —
 * the diagnosis is this file's, the appearance is the report's, and the boot line is the only thing that will
 * connect the two.
 *
 * **Structural only.** Nothing here is about how the body *looks* — a tag, a token, a trail — which is
 * `poolModelWarnings`' job, and nothing here is about an anchored root, which `NpcService.spawn` clears on
 * the clone so that a template authored anchored still walks.
 */
function rigProblem(model: Model): string | undefined {
	if (model.FindFirstChildWhichIsA("Humanoid") === undefined) return "no Humanoid";

	const root = model.FindFirstChild("HumanoidRootPart");
	if (root === undefined || !root.IsA("BasePart")) return "no HumanoidRootPart";

	return undefined;
}

/** The rigs the pool must treat as taken: every managed `Model` in the world, side or no side. */
function liveRigs(): Array<Model> {
	const rigs = new Array<Model>();

	for (const instance of CollectionService.GetTagged(NPC_TAG)) {
		if (!instance.IsA("Model")) continue;
		if (!instance.IsDescendantOf(Workspace)) continue;

		rigs.push(instance);
	}

	return rigs;
}

/**
 * Reads the folder and the live rigs, and answers what is free.
 *
 * **The pool is a snapshot, taken per spawn rather than cached**, so a rig appearing or disappearing between
 * two draws is seen by the next one. That is the whole of what makes the release automatic — the live walk is
 * the ledger, and it is rebuilt rather than maintained.
 *
 * **Live rigs are found by {@link NPC_TAG} *and* by being in the world.** The world gate is `TAGS.md`'s rule
 * (a `Clone` copies tags, so a parked copy wears the tag without being a rig in play) and it is what stops a
 * snapshot taken by `RespawnBehavior` — which strips the tags from its copy anyway — or anything else lying
 * in `ServerStorage` from holding a name. A model that is not in the world is not a body a player can see, so
 * a name on it is a name nobody is looking at.
 *
 * **A live rig with no readable `RigTemplate` holds no model, and its name still counts.** The name is
 * readable on any model; the source is an attribute this file writes and nothing else does, so a rig that
 * predates the pool — or one somebody tagged by hand in Studio — releases nothing but its name. That is the
 * honest reading: this file cannot know which model an untagged rig came from, and inventing one would be
 * worse than leaving a model free.
 */
export function readRigPool(): RigPool {
	const folder = findFolder(ServerStorage, NPC_CONFIG.RIG_POOL_FOLDER);

	const models = new Array<Model>();

	if (folder !== undefined) {
		for (const child of folder.GetChildren()) {
			if (child.IsA("Model")) models.push(child);
		}
	}

	// **Which of them are rigs at all**, asked once here so that the draw and the boot report cannot disagree
	// about it — see `rigProblem`. **Anchored models stay in this list**: `NpcService.spawn` unanchors the
	// clone, so an anchored template is a template that works, and excluding it would spend a seat on a fault
	// nothing else suffers from. What is excluded is a model no amount of runtime repair could make walk.
	const usableModels = new Array<Model>();

	for (const model of models) {
		if (rigProblem(model) === undefined) usableModels.push(model);
	}

	// **Counted rather than deduplicated**, so a name used three times is one entry in the report and every
	// model behind it is excluded. `Set` rather than an array because the question is membership, and this
	// build's `Set` is a `Map` shim: `has`/`add`/`forEach` are the members that exist.
	const seen = new Set<string>();
	const repeated = new Set<string>();

	for (const model of models) {
		if (seen.has(model.Name)) repeated.add(model.Name);
		seen.add(model.Name);
	}

	const duplicatedNames = new Array<string>();
	repeated.forEach((name) => duplicatedNames.push(name));

	const usedNames = new Set<string>();
	const usedSources = new Set<string>();

	// **How many live rigs name each source**, which is the number {@link RigPool.leastWornModels} minimises.
	// Counted rather than boolean because the question is no longer "is this face taken" — `usedSources`
	// answers that — but "which taken face is taken *least*", which is what a repeat should be spent on.
	const sourceUses = new Map<string, number>();

	for (const rig of liveRigs()) {
		usedNames.add(rig.Name);

		const source = sourceOf(rig);
		if (source === undefined) continue;

		usedSources.add(source);

		const worn = sourceUses.get(source);
		sourceUses.set(source, (worn === undefined ? 0 : worn) + 1);
	}

	const freeNames = new Array<string>();
	for (const name of RIG_NAMES) {
		if (!usedNames.has(name)) freeNames.push(name);
	}

	// **Drawn from the usable models, so a body that cannot walk never spends a seat** — see `usableModels`.
	// The two name tests stay as they were: a duplicate name and an unusable model are different faults with
	// different fixes, and neither implies the other.
	const freeModels = new Array<Model>();
	for (const model of usableModels) {
		if (repeated.has(model.Name)) continue;
		if (usedSources.has(model.Name)) continue;

		freeModels.push(model);
	}

	// **Which faces carry the fewest live bodies, in two passes rather than one.** The first finds the
	// minimum; the second collects the faces tied at it. A single pass would have to rebuild its list every
	// time a smaller count appeared, and this build's `Array` has no `clear` to rebuild with — see the `Map`
	// note in `MysteryBoxService` for the same class of surprise. Two walks of a folder holding a handful of
	// models, once per spawn, is the cheaper side of that trade.
	//
	// **The result is what a repeat is drawn from**, so a short folder spreads its duplicates across faces
	// instead of piling them on whichever one the dice favoured — see {@link RigPool.leastWornModels}.
	let fewestWorn = math.huge;

	for (const model of usableModels) {
		if (repeated.has(model.Name)) continue;

		const worn = sourceUses.get(model.Name) ?? 0;
		if (worn < fewestWorn) fewestWorn = worn;
	}

	const leastWornModels = new Array<Model>();

	for (const model of usableModels) {
		if (repeated.has(model.Name)) continue;
		if ((sourceUses.get(model.Name) ?? 0) !== fewestWorn) continue;

		leastWornModels.push(model);
	}

	return {
		models: models,
		usableModels: usableModels,
		duplicatedNames: duplicatedNames,
		freeNames: freeNames,
		freeModels: freeModels,
		leastWornModels: leastWornModels,
	};
}

/**
 * **Draws one identity — a free name and a free body, independently — or names the reason it cannot.**
 *
 * **The two draws are independent on purpose: any body may wear any name.** Pairing them would mean a rig's
 * face and its name were one decision, which reads as a *character* — and these are placeholders, the same
 * furniture in a different colour each time. Independence is also what keeps the two exhaustions separate
 * questions, with separate answers, which is why they have separate sentences below.
 *
 * **A free face and a free name are what the draw *prefers*, and a seat is filled whether or not either is
 * left — that is the rule, and it is the user's.** The lobby exists to be eight bodies, four a side, so that
 * a match opens full whether or not anybody opted in; distinct faces are the immersion the pool is *for*, and
 * they are the smaller of the two goods. So when every model is already worn, the draw repeats a face rather
 * than leaving a seat empty. **What it must never do is refuse to make a body because the folder is small** —
 * that is a lobby that looks half empty and a round that opens three against three, which is the failure this
 * file used to cause by design and no longer does. The boot line still prints both counts beside the number
 * of rigs wanted, so a repeated face is a fact in the log rather than something to spot in the crowd.
 *
 * **A repeat is spent on the *least-worn* face, and that is a correction rather than a detail.** Repeating at
 * all is unavoidable when a folder holds fewer models than the lobby has seats; *which* face repeats is not,
 * and drawing uniformly from the whole usable set — what this did — lets the counts drift. Reported from a
 * session: a rig spawned beside another wearing an identical body while a third face stood on one rig, which
 * is the clustering a uniform draw produces and a minimum-use draw cannot. So the middle band is
 * {@link RigPool.leastWornModels}, and a folder of two models across eight rigs now comes out four and four
 * instead of seven and one. **What it cannot do is make a small folder look large** — the count of repeats is
 * `seats − usable models` whatever this picks, and that number is a place-file fact.
 *
 * **The name side is not treated the same way, and the asymmetry is deliberate.** Twenty names for eight
 * seats means it cannot run out in an ordinary session, so a name refusal is only ever reachable by shortening
 * the list below the rig cap — a config fault in this project's own file, which a duplicate name would hide
 * for ever. The face list, by contrast, is a *place-file* supply the user is expected to keep small while the
 * lobby is expected to stay full.
 *
 * **What is still refused is a folder that holds no rig at all.** That is not a shortage of faces but the
 * absence of a body: `usableModels` is empty, nothing can be cloned, and the blame is a place-file fault the
 * boot line already named. `freeNames` being empty is likewise refused, because it cannot happen with
 * {@link RIG_NAMES} at twenty and the lobby at eight — if it ever does, the name list has been shortened
 * below the rig cap, and spawning duplicates for ever would hide that rather than fix it.
 */
export function drawRigIdentity(pool: RigPool): RigDraw {
	if (pool.models.size() === 0) {
		return {
			ok: false,
			reason:
				`no "${NPC_CONFIG.RIG_POOL_FOLDER}" folder with Model children is in ServerStorage, ` +
				`so no placeholder can be made`,
		};
	}

	if (pool.freeNames.size() === 0) {
		return {
			ok: false,
			reason:
				`all ${RIG_NAMES.size()} rig names are in use — a lobby this size has outgrown its ` +
				`name list, which is a list to lengthen rather than a fault to work around`,
		};
	}

	if (pool.usableModels.size() === 0) {
		return {
			ok: false,
			reason:
				`no model in "${NPC_CONFIG.RIG_POOL_FOLDER}" is a rig — every one is missing a Humanoid ` +
				`or a HumanoidRootPart — so no placeholder can be made at all`,
		};
	}

	// **The face is the draw's only preference, and it is spent rather than hoarded.** Three bands, in the
	// order they are worth having: a free face, so a lobby with bodies to spare looks like eight different
	// people; the **least-worn** faces once every one is taken, so a folder too small for the lobby spreads its
	// repeats instead of piling them onto one body; and the whole usable set as a last resort, reachable only
	// by a folder in which every model shares a name. **The alternative — which is what this did — was to
	// refuse**, and a refusal here is a rig missing from the lobby, which is a round that opens a body short.
	// See this function's doc for why the seat outranks the face, and {@link RigPool.leastWornModels} for the
	// report that added the middle band.
	let faces = pool.freeModels;
	if (faces.size() === 0) faces = pool.leastWornModels;
	if (faces.size() === 0) faces = pool.usableModels;

	// `math.random(a, b)` is inclusive at both ends, so the index is the whole array and never its end —
	// the same note `NpcService.dressRig` and `MysteryBoxService` carry beside the same call.
	const name = pool.freeNames[math.random(0, pool.freeNames.size() - 1)];
	const template = faces[math.random(0, faces.size() - 1)];

	// **`freeModels` being empty is the whole definition of a repeat**, and it is read here rather than
	// recomputed by a caller: a face is repeated exactly when there was no unworn model to spend.
	return { ok: true, name: name, template: template, repeatedFace: pool.freeModels.size() === 0 };
}

/**
 * **What is wrong with the models in the folder, as one sentence — or nothing if they are clean.**
 *
 * **The check exists because the fault is invisible rather than because it is likely.** A model in
 * `ServerStorage` wearing `NPC` is not a rig in play and nothing about it looks wrong; what it *is* is a model
 * the world-blind scan in `NpcService.onStart` hands a loop, and a loop calls `dressRig` on its first turn —
 * `run` does that *before* the world gate, which is the gap recorded in the reconnaissance report. From that
 * moment the model carries an `EQUIPPED_TRAIL_ATTRIBUTE`, every clone inherits it, and eight placeholders
 * wear one trail, which is the "uniform" tell `dressRig`'s own doc says it exists to avoid. The same scan is
 * what once baked a `ThrowerToken` into a single template and made every rig-to-rig throw unhurtable — the
 * session `TAGS.md` records. **Both are one tag away, on every model in this folder rather than on one.**
 *
 * **It reports and does not repair, deliberately.** Stripping the tag and the attributes in code would work
 * and would hide a folder fault behind a runtime patch — and the two halves want different homes: the tag is
 * a mistake in the place file, and the trail is an attribute the place file *saved*, which no strip at boot
 * would remove from the file. Naming the models is what lets somebody fix the folder once.
 *
 * **Five faults, in two families, and the families differ in what a session costs.** A *structural* fault —
 * no `Humanoid`, no `HumanoidRootPart` — is one this file must not paint over, so the draw excludes the model
 * and the cost is a **face the lobby does not get to show**: the seat it would have filled is filled by a
 * repeat of another model instead, because a seat is a body either way. A *decorative* fault — a tag, a token,
 * a trail — leaves a body that works and looks wrong, and it is the family nobody can see, which is why it is
 * reported at all. `rigProblem` is the test both halves use, so the exclusion and the line about it can never
 * disagree.
 *
 * **`EQUIPPED_TRAIL_ATTRIBUTE` on a *rig* is correct and on a *pool model* is not**, which is the distinction
 * the wording has to carry: a rig that has been dressed is doing exactly what it should. A model sitting in
 * the folder is not a rig, and an attribute on it can only have got there from a previous life as one.
 */
export function poolModelWarnings(models: ReadonlyArray<Model>): string | undefined {
	const faults = new Array<string>();

	for (const model of models) {
		const reasons = new Array<string>();

		// **The structural half first, because it is the half with no other symptom.** A model that is not a
		// rig is excluded from the draw, so the *only* trace it leaves is a seat that never fills — see
		// `usableModels`. Saying which child is missing is what turns that into a place-file edit.
		const structural = rigProblem(model);
		if (structural !== undefined) reasons.push(`${structural}, so it can never be walked`);

		if (model.HasTag(NPC_TAG)) reasons.push(`wears ${NPC_TAG}`);
		if (model.GetAttribute(THROWER_TOKEN) !== undefined) reasons.push(`has a ${THROWER_TOKEN}`);
		if (model.GetAttribute(EQUIPPED_TRAIL_ATTRIBUTE) !== undefined) reasons.push("has a trail written on it");

		if (reasons.size() > 0) faults.push(`${model.Name} (${reasons.join(", ")})`);
	}

	if (faults.size() === 0) return undefined;

	return (
		`[Rig] pool — ${faults.join("; ")}. A model in "${NPC_CONFIG.RIG_POOL_FOLDER}" must be a rig (a ` +
		`Humanoid and a HumanoidRootPart) carrying no tag and no rig attribute: a model that is not one is ` +
		`never drawn, a tagged one is handed a loop by the world-blind scan, and the first turn of that loop ` +
		`writes a trail onto it, which every clone then inherits. Fix these in the place file rather than here.`
	);
}
