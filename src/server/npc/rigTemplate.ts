import { CollectionService, ServerStorage, Workspace } from "@rbxts/services";
import { NPC_CONFIG } from "shared/config/npc.config";
import { findFolder } from "shared/find";
import { logInfo, logWarn } from "shared/logger";

/**
 * **What is inside a rig template, said out loud at boot — because nothing else in `src/` can know.**
 *
 * **A rig template is a place-file object the code treats as a contract and cannot read.** `LobbyRigService`
 * draws a model out of `ServerStorage."NPCs"` and `NpcService.spawn` clones it, so every property of that
 * model is inherited by every rig in the session — and a toolbox import can arrive carrying a `Script`, an
 * `Animate` `LocalScript`, an applied `HumanoidDescription`, a `CollectionService` tag, a missing `Head`, a
 * nil `PrimaryPart` or parts that are anchored. **Each of those is invisible in `src/` and appears once per
 * rig**, which is why the report that prompted this read "cloning and destroying rigs is causing issues":
 * the fault is in the file the code clones, and the code being blamed is one line of `Clone`.
 *
 * **`HANDOFF.md` §15 item 17 is the shape of the argument, even though its subject is a different template**
 * — that item is about `ChargeHand`'s emitter rates and says *"nothing in `src/` knows what is inside a
 * template"*. This file is the half of that sentence that can be made false at boot: the rig templates are
 * few, they are in one place, and one walk of `ServerStorage` can describe every one of them by name.
 *
 * **What this is not.** It does not repair anything — no script deleted, no description applied, no part
 * unanchored and no tag stripped. A boot pass that mutates the place file is a worse bug than the one it
 * would be fixing (the next save writes the mutation back), and `poolModelWarnings` already argues the same
 * case for the folder. It is also **not** a second opinion about whether a model is a rig: `npc/rigPool.ts`'s
 * `rigProblem` is the structural test a *draw* refuses on, and this file reports rather than refuses — see
 * {@link RigTemplateSeverity} for how the two relate.
 *
 * **A plain module rather than a service, on `rigPool.ts`'s precedent.** It is a derivation over the tree
 * with no lifecycle, no state worth injecting and one call per boot plus one per spawn, which is the shape
 * `npc/rigs.ts`, `npc/rigPool.ts` and `npc/sideZones.ts` already have beside it — and the shape `HANDOFF.md`
 * §0 calls for. The test that this is the right home is mechanical: `main.server.ts` registers
 * `src/server/services`, `src/server/components` and `src/server/dev` with Flamework and nothing else, so a
 * file under `src/server/npc/` cannot acquire a `flamework.build` entry even by accident.
 */

/**
 * **How bad a fault is, in the only three words that change what a reader does about it.**
 *
 * - **`fatal` — the body cannot be a rig at all.** No `Humanoid`, or no `HumanoidRootPart`. Nothing further
 *   down the pipeline can work: `NpcService.run` finds no humanoid and prints its own line before forgetting
 *   the model, and a humanoid with no root has nothing to walk. **`fatal` does not refuse a spawn**, and that
 *   is deliberate rather than an omission — see {@link reportRigTemplateOnce} for the whole of it.
 * - **`warn` — the body works and is wrong.** A tag, a script, an anchored part, a missing `Head`. These are
 *   the ones that cost a *session* rather than a body, and they are the ones nobody can see by looking.
 * - **`note` — a fact to read, with no verb attached.** `RigType`, and a nil `PrimaryPart`. Nothing here is
 *   broken; something here will decide what the next report means.
 *
 * **The distinction from `rigPool`'s refusal, stated once.** `readRigPool` already keeps a model with no
 * `Humanoid` or no `HumanoidRootPart` out of the draw (`usableModels`), which is the right lever and this file
 * does not duplicate it — it *reports* the same two conditions with the offending instance's full path, which
 * the pool's one-line summary cannot do, and it reports them for models the pool never looks at (anything
 * outside the folder).
 */
export type RigTemplateSeverity = "fatal" | "warn" | "note";

/**
 * **One thing wrong with one template, as a value rather than a sentence.**
 *
 * **A record rather than a string, and the deciding factor is the second reader.** The boot pass wants to
 * print; the spawn gate wants to ask *"is anything here fatal"* without parsing prose it did not write, and a
 * future caller (a Studio command, a dev flag that refuses) wants to filter by `at` or `kind`. A `string[]`
 * would make every one of those a substring search against wording that this file is free to reword — which
 * is the same argument `shared/badges.ts` makes for keeping a badge's id beside its label.
 *
 * **`at` is a full path and not a `Name`**, because the whole point is that the fault is in a place-file
 * object nobody can find from a log: `ServerStorage.NPCs.Marco.LeftUpperArm` is actionable and `LeftUpperArm`
 * is not — it is one of dozens of parts in one of a dozen models, and the model may be one of two with the
 * same name.
 */
export interface RigTemplateFault {
	/** What to do about it. See {@link RigTemplateSeverity}. */
	readonly severity: RigTemplateSeverity;

	/** One or two words for the kind, so a reader can scan a list of ten. */
	readonly kind: string;

	/** The full path of the offending instance — a part, a script, or the template itself. */
	readonly at: string;

	/** What is wrong *there*, in one sentence, ending in what it costs. */
	readonly detail: string;
}

/**
 * **How far apart two points that ought to be the same point may be, in studs.** **Placeholders.**
 *
 * A healthy rig keeps all three of its "where am I" answers — pivot, root, bounding-box centre — inside a stud
 * or two of each other, which is what makes these tolerances safe to be this tight. `PIVOT_TOLERANCE` compares
 * two single points (the pivot `PivotTo` moves and the `HumanoidRootPart` every reader means) and is the small
 * one; `ROOT_TOLERANCE` compares the root against the middle of the *whole model*, which shifts with every
 * accessory and with any part that is not the body, so it is given twice the room.
 */
const PIVOT_TOLERANCE = 2;
const ROOT_TOLERANCE = 4;

/**
 * **Every check this file makes, in the order a reader cares about them** — and the list is the module's
 * whole contract, so a check added here is a check the boot pass and the spawn gate both get.
 *
 * **One fault per offending instance rather than one per kind**, because the two fixes are different: a rig
 * with three anchored parts is three explorer paths to tick, and a line saying "3 anchored parts" makes
 * somebody go looking for the third.
 */
export function inspectRigTemplate(model: Model): RigTemplateFault[] {
	const faults: RigTemplateFault[] = [];

	const path = model.GetFullName();

	// **1. A `Model` with a `Humanoid`, or nothing downstream works.** `NpcService.run` says so in its own
	// words ("no humanoid, so there is nothing to run behaviors on") and then forgets the model — which is a
	// rig that holds a seat, never moves and never fights. `FindFirstChildWhichIsA` rather than a name,
	// because the class is the contract and the name is not; the same read `rigProblem` makes.
	const humanoid = model.FindFirstChildWhichIsA("Humanoid");

	// **1b. A rig one level *down*, which is a wrapper rather than a broken rig — and the one case that used
	// to print three false statements at once.** `ServerStorage.NPCs.Historia Reiss` is a `Model` holding a
	// `Model` called `Historia Reiss.` holding the actual R15 rig, and the log of 2026-10-19 said "there is no
	// Humanoid in the subtree … no BasePart named HumanoidRootPart … no BasePart named Head" about a body that
	// has all three. Each line was true of *direct children* and false of the model, and the reader of such a
	// log is being told to add parts to a wrapper that already contains them — which is a repair that cannot
	// be made, on a model that is not the problem.
	//
	// **So the wrapper is named once, by the path of the rig inside it, and the checks below are skipped.**
	// Root, head and anchors all belong to the inner model; reported against the outer one they are three
	// more places to look for something that is already there. Once the wrapper is dissolved the next boot
	// audits the inner model as a template in its own right, so nothing is lost — one repair at a time is the
	// point.
	const buried = humanoid === undefined ? model.FindFirstChildWhichIsA("Humanoid", true) : undefined;
	const inner =
		buried !== undefined && buried.Parent !== undefined && buried.Parent.IsA("Model") ? buried.Parent : undefined;

	if (inner !== undefined) {
		faults.push({
			severity: "fatal",
			kind: "wrapper",
			at: inner.GetFullName(),
			detail:
				"the only Humanoid is inside this child model, and every reader here asks the template's own children (`rigPool.rigProblem`, `NpcService.run`), so the model above it is a wrapper around a rig and nothing can draw it — move this child up so it is itself a Model child of ServerStorage.\"" +
				NPC_CONFIG.RIG_POOL_FOLDER +
				"\", or drag its contents out and delete the wrapper",
		});

		return faults;
	}

	if (humanoid === undefined) {
		faults.push({
			severity: "fatal",
			kind: "no humanoid",
			at: path,
			detail: "there is no Humanoid among its direct children, nor anywhere below it, so a clone is a prop that never walks — NpcService.run says so once and forgets it",
		});
	}

	// **2. A template must not be in the world.** Every scan in this project is world-blind on purpose
	// (`NpcService.onStart` hands a `NPC`-tagged model a loop wherever it is, so that dragging one out of
	// `ServerStorage` to test it just works), which means a template parked in `Workspace` is driven as if it
	// were a live rig: it is dressed by `dressRig` on its first turn, and every clone inherits what happened.
	// **A model found by the boot audit cannot fail this** — the audit only reads `ServerStorage` — so this
	// check exists for the *spawn* gate, where a model dragged into the world and then cloned is exactly the
	// case. Reported rather than moved: moving somebody's model is not this file's business.
	if (model.IsDescendantOf(Workspace)) {
		faults.push({
			severity: "warn",
			kind: "in the world",
			at: path,
			detail: "it is a descendant of Workspace, so the world-blind scans drive it as a live rig — it gets a loop, and the first turn of that loop dresses it",
		});
	}

	// **3. A `HumanoidRootPart`, which is what "where this rig is" means everywhere in this project.**
	// `resolveDodgeable` falls back to `PrimaryPart` and then to *any* `BasePart`, so a body without one does
	// not fail — it silently resolves to the wrong part, and `Humanoid.MoveTo` has no assembly to walk. That
	// is the "hops on the spot" body `rigProblem` describes, and it is fatal here for the same reason: no
	// amount of runtime repair makes it walk.
	const root = model.FindFirstChild("HumanoidRootPart");

	if (root === undefined || !root.IsA("BasePart")) {
		faults.push({
			severity: "fatal",
			kind: "no root",
			at: path,
			detail: "there is no BasePart named HumanoidRootPart among its direct children, so nothing has an assembly to walk, every reader of \"where is this rig\" falls back to the wrong part, and rigPool refuses the model — one face the lobby never shows; the repair is a part of that name between the hips, welded to both legs",
		});
	}

	// **4. Every `CollectionService` tag, by name — the fault this project has already paid for twice.**
	// `TAGS.md`'s `NPC` row records the session: a template wearing `NPC` was handed a loop, its first turn
	// wrote a `ThrowerToken` onto it, every clone inherited that one token, and every rig-to-rig throw became
	// unhurtable for the rest of the session. `NpcService.ensureToken` closes the *token* half — it refuses to
	// write to a model that is not in the world — but nothing refuses a *tagged* template, and a tag is what
	// starts the loop in the first place. So this lists the tags rather than a boolean, because `Animate`-style
	// debugging ("which one?") starts with knowing which.
	for (const tag of CollectionService.GetTags(model)) {
		faults.push({
			severity: "warn",
			kind: "tag",
			at: path,
			detail:
				'it wears the tag "' +
				tag +
				'", which every clone inherits — a tagged template is a model the world-blind scan hands a loop, and that is the session TAGS.md records',
		});
	}

	// **5. `Script` and `LocalScript` anywhere in the subtree — the toolbox-import fault.** A rig pulled from
	// the toolbox can arrive with its own behaviour attached, and `Clone` carries it into every rig in the
	// session, where it runs eight times over. `ModuleScript` is deliberately not in this list: it does not
	// run unless something requires it, so it is inert weight rather than a fault, and reporting it would put
	// noise in a list whose value is that every line is actionable.
	//
	// **`Animate` is named separately below even though it is a case of this**, because it is the one a person
	// recognises and the one with a different fix: the engine's own `Animate` `LocalScript` drives a humanoid
	// from a player's input, and on a rig it is a second thing writing to the same body the client's
	// `RigAnimationController` is dressing — see the client controller's doc for the two-writer rule. Deleting
	// it is a place-file edit and does not need the animation editor opened; deleting a random `Script` does.
	let animate: Instance | undefined;

	for (const descendant of model.GetDescendants()) {
		if (!descendant.IsA("Script") && !descendant.IsA("LocalScript")) continue;

		if (descendant.IsA("LocalScript") && descendant.Name === "Animate") {
			animate = descendant;
		}

		faults.push({
			severity: "warn",
			kind: descendant.IsA("Script") ? "script" : "local script",
			at: descendant.GetFullName(),
			detail: "a script inside a template is cloned with every rig that comes out of it, so it runs once per rig rather than once",
		});
	}

	if (animate !== undefined) {
		faults.push({
			severity: "warn",
			kind: "animate",
			at: animate.GetFullName(),
			detail: "this is the engine's own Animate LocalScript — on a rig it is a second writer of the humanoid the client's RigAnimationController already dresses, and the fix is to delete it in the Explorer rather than to script around it",
		});
	}

	// **6. Anchored parts, each by path.** `NpcService.spawn` clears `Anchored` on every `BasePart` of every
	// clone, so this costs *spawned* rigs nothing — but it is not a harmless place-file habit: a template
	// dragged into the world by hand (a practice rig, or a model being tested) keeps its anchors, and an
	// anchored assembly is one the engine does not simulate. The line it produces is `Network Ownership API
	// cannot be called on Anchored parts or parts welded to Anchored parts`, thrown out of `SetNetworkOwner`,
	// and the rig then stands there while every client animates it walking. Reported because a template's
	// anchors are usually the author holding it still while editing and nobody ever meant to ship them.
	for (const descendant of model.GetDescendants()) {
		if (!descendant.IsA("BasePart")) continue;
		if (!descendant.Anchored) continue;

		faults.push({
			severity: "warn",
			kind: "anchored",
			at: descendant.GetFullName(),
			detail: "it is anchored — spawn clears this on every clone, but a copy dragged into the world by hand keeps it and cannot be simulated or network-owned",
		});
	}

	// **7. `PrimaryPart`: a note when it is nil, a fault when it dangles.** The nil case is *not* fatal, and
	// that is a correction to the obvious reading: `spawn` places a rig with `Model.PivotTo`, which works with
	// no primary part at all (a model without one pivots at the centre of its bounding box), and
	// `ownForServer` asks `resolveDodgeable` for the root rather than `PrimaryPart`. So a nil `PrimaryPart`
	// costs *precision* — the pivot is the bounding-box centre rather than the root, which is why a
	// mis-centred rig arrives a little off its spawn — rather than a body.
	const primary = model.PrimaryPart;

	if (primary === undefined) {
		faults.push({
			severity: "note",
			kind: "no primary part",
			at: path,
			detail: "PrimaryPart is nil, so PivotTo uses the bounding-box centre — it works, and the rig can arrive a stud or two off the spawn it was aimed at",
		});
	} else if (!primary.IsDescendantOf(model)) {
		faults.push({
			severity: "warn",
			kind: "foreign primary part",
			at: primary.GetFullName(),
			detail: "PrimaryPart points at a part outside this model, which is a reference that cannot survive a clone",
		});
	}

	// **7b. Where `PivotTo` will actually put this model, measured against the part everything else calls the
	// body.** `PivotTo` moves a model until its *pivot* reaches the target, and the pivot is `PrimaryPart`
	// when there is one and `WorldPivot` when there is not — while `resolveDodgeable`, the humanoid's own
	// assembly and every reader in this project mean the `HumanoidRootPart`. **On 2026-10-19 that difference
	// was 41.5 studs on this folder's `Skxz_ixi`, which put every clone of it inside the lobby floor while its
	// seven neighbours stood on theirs** — and the log said so without saying why, because `playSpawnPoof`
	// prints the root and nothing prints the pivot.
	//
	// **This is the place file being told, not a fault the body suffers**: `NpcService.spawn` now sets the
	// clone's `PrimaryPart` to its root before pivoting, so a spawned rig lands on its spawn point either way.
	// What the line is for is the model that a *Studio* drag, a future caller or a hand placement will still
	// move by the wrong point — and for the fact that a folder this size should not contain one.
	if (root !== undefined && root.IsA("BasePart")) {
		const pivot = model.GetPivot();
		const pivotGap = pivot.Position.sub(root.Position).Magnitude;

		if (pivotGap > PIVOT_TOLERANCE) {
			faults.push({
				severity: "warn",
				kind: "pivot",
				at: path,
				detail:
					string.format("%.1f", pivotGap) +
					" studs between the pivot `PivotTo` moves and HumanoidRootPart" +
					(primary === undefined
						? " (PrimaryPart is nil, so the pivot is the model's own WorldPivot)"
						: primary === root
							? ""
							: " (PrimaryPart is " + primary.GetFullName() + ")") +
					" — the model's pivot is not on its body, so anything that moves it by the pivot moves the wrong point; set PrimaryPart to HumanoidRootPart and put the pivot on it",
			});
		}

		// **And the other half of the same question: a root that is not inside its own body.** The check above
		// catches a pivot away from the root; this one catches a root away from the *model*, which is the case
		// where setting `PrimaryPart` cannot help — a stray `HumanoidRootPart` placed below or beside the body
		// gives the humanoid an assembly nothing is welded to and makes every placement measure from it. The
		// bounding box is the model's own answer to "where is the body", so one comparison covers a part
		// floating away, a body hanging off one side, and an import that arrived in pieces.
		const [centre] = model.GetBoundingBox();
		const bodyGap = centre.Position.sub(root.Position).Magnitude;

		if (bodyGap > ROOT_TOLERANCE) {
			faults.push({
				severity: "warn",
				kind: "stray root",
				at: root.GetFullName(),
				detail:
					string.format("%.1f", bodyGap) +
					" studs between HumanoidRootPart and the middle of this model's bounding box — a rig's root sits at hip height inside its body, so this one is a part away from the body it belongs to: the humanoid has no assembly to stand on and every placement is measured from the wrong point",
			});
		}
	}

	// **8. A `Head`, because the client hangs the badge strip on one.** **The cost of this fault changed twice and
	// the history is the reason it is still on the list**: `StatsBillboardController` used to wait for the head with
	// no timeout, from the single thread that walked every tagged rig — so one rig with no `Head` stopped that walk
	// for the whole session and silently took every later rig's strip with it, and the fault was worth a warning
	// precisely because its damage was somewhere else. It now waits `HEAD_WAIT_SECONDS` and mounts each body on its
	// own thread, so the damage is local and small: **no strip above this body, one `[HUD] … no Head` warning per
	// client, and five seconds of a thread nothing joins on.** Reported anyway, and not fatal: the *rig* walks,
	// fights and dies, and a lobby of working rigs beats a refused spawn.
	const head = model.FindFirstChild("Head");

	if (head === undefined || !head.IsA("BasePart")) {
		faults.push({
			severity: "warn",
			kind: "no head",
			at: path,
			detail: "there is no BasePart named Head, so the client waits five seconds for one and then skips this body — no badge strip above it, for its whole life",
		});
	}

	// **9. A `HumanoidDescription` in the subtree, which is the residue of a dressed avatar.** A toolbox rig
	// often arrives as somebody's character, description included; every clone inherits the outfit, and
	// nothing in this project applies a description at spawn (there is no `ApplyDescription` call anywhere in
	// `src/`) so it cannot be repainted from code. **`Humanoid.GetAppliedDescription()` is deliberately not
	// the test**: it returns a copy of the *cached* description and answers whether or not one was ever
	// applied, so it would fire on every model in the folder and mean nothing. A `HumanoidDescription`
	// *instance* is residue that can be pointed at.
	for (const descendant of model.GetDescendants()) {
		if (!descendant.IsA("HumanoidDescription")) continue;

		faults.push({
			severity: "warn",
			kind: "description",
			at: descendant.GetFullName(),
			detail: "it carries a HumanoidDescription, so every clone arrives wearing somebody's avatar and nothing in src/ applies one to repaint it",
		});
	}

	// **10. `RigType`, which is a report line rather than a fault.** The client's clip tables are keyed on it
	// (`RigAnimationController`, `animation.config.ts`) and `HANDOFF.md` §10 records that only the R15 path
	// has ever been exercised — so a folder of R6 models is not broken, it is *untested*, and that is exactly
	// the kind of fact worth having in a boot line. Two members, which is the assumption `BallFactory.handName`
	// already states on the same read.
	if (humanoid !== undefined) {
		faults.push({
			severity: "note",
			kind: "rig type",
			at: path,
			detail:
				humanoid.RigType === Enum.HumanoidRigType.R15
					? "R15 — the path every rig in this project has actually been run on"
					: "R6 — the clip tables have an R6 column and no session in this repository has exercised it",
		});
	}

	return faults;
}

/**
 * One fault as the body of a log line — **`severity/kind` first, then the offending path, then the sentence.**
 *
 * **The path comes before the sentence rather than after it**, because a log is scanned rather than read: the
 * column of paths is what a reader is matching against the Explorer, and a sentence first would push it to a
 * different column on every line. **The severity and the kind share one token** (`warn/anchored`), so the
 * line stays one line and the thing a reader filters on is still a word — the caller supplies the
 * `[RigTemplate]` prefix, and the audit indents its per-fault lines behind it.
 */
function lineFor(fault: RigTemplateFault): string {
	return `${fault.severity}/${fault.kind} — ${fault.at}: ${fault.detail}`;
}

/**
 * **What is wrong with `model`, printed — and printed once per template.**
 *
 * **Once per template rather than once per spawn, because a rig is spawned a handful of times a minute and
 * the fault does not change.** The dedupe is a `Set<Model>` rather than a name: a template is long-lived and
 * its path can be reused by a different model, while the model itself is the thing the answer is about. The
 * set is never trimmed, which at this project's scale (a dozen templates) is a dozen references for a session.
 *
 * **Nothing is refused, and the argument is the lobby.** `spawn` returns a `Model` and its two callers
 * (`LobbyRigService.spawnLobbyRig`, `spawnArenaRig`) build a seat out of that return — so a refusal is not a
 * line of this file, it is a signature change in the one path every rig takes into the world. The trade
 * against that cost is what a refusal buys: **an empty lobby is worse than a strange rig.** A script in a
 * template, an anchored part and a missing `Head` all produce a body that walks, fights and dies — badly, or
 * without a strip — where a refusal produces a side one body short and a round that opens three against
 * three. **The two structural faults are already refused where refusing is free**: `rigPool.readRigPool`'s
 * `usableModels` excludes a model with no `Humanoid` or no `HumanoidRootPart` from the *draw*, so a pool
 * model that cannot walk is never handed to `spawn` in the first place. What is left for this line to do is
 * (a) make the fault readable by path, and (b) catch a model that got past the draw — a hand-placed rig, or a
 * pool model whose fault was introduced since boot.
 *
 * **`askedBy` is in the line** because the same fault arriving at boot and at a spawn are two different
 * readings: at boot it is the place file as saved, and at a spawn it is a template that is *being cloned
 * right now*, which is the moment the cost is real.
 */
export function reportRigTemplateOnce(model: Model, askedBy: string): void {
	if (reported.has(model)) return;
	reported.add(model);

	const faults = inspectRigTemplate(model);
	if (faults.size() === 0) return;

	for (const fault of faults) {
		const line = `[RigTemplate] ${askedBy} — ${lineFor(fault)}`;

		if (fault.severity === "note") {
			logInfo(line);
		} else {
			logWarn(line);
		}
	}
}

/** Templates already reported by {@link reportRigTemplateOnce}. See it for why it is keyed on the model. */
const reported = new Set<Model>();

/**
 * **The boot pass: every rig template in `ServerStorage`, described by path, once.**
 *
 * **Three rules, and the third is the one the first log taught.** The pool lives in a *folder* —
 * `ServerStorage."NPCs"`, `NPC_CONFIG.RIG_POOL_FOLDER` — so a walk of `ServerStorage`'s **direct children**
 * would find nothing at all in a place that has eight good templates, and the pass would print "no templates
 * found" next to a working lobby. So a template is **a `Model` child of the pool folder** (whether or not it
 * has a `Humanoid`: the second half is what lets this name the fault the draw refuses silently, because
 * `rigProblem` excludes such a model and the folder's one-line warning is the only trace) **or a direct
 * `Model` child of `ServerStorage` with a `Humanoid`** (which is how the parked `PlaceholderRig` is found).
 * **Everything else that merely looks like a rig is named once and not validated**, and that rule exists
 * because the first real run printed 36 faults across `ServerStorage.vfx.Auras.*` — four R6 dummy rigs used
 * as aura carriers, each with anchored parts and a `HumanoidDescription` because that is how a VFX dummy is
 * built. They are not templates and nothing clones them, and a wall of true-but-irrelevant lines is how a
 * report stops being read. Naming them is still worth a line each: a rig-shaped model outside both rules is
 * exactly the "template nobody configured" this pass is for, and silently skipping it would be the failure
 * `TAGS.md` keeps re-learning.
 *
 * **`in the folder` versus `outside` it is the distinction the pass exists to make visible, and it is a
 * place-file fact.** A draw can only clone a model that is a direct child of the pool folder, so a template
 * sitting beside that folder — `ServerStorage.PlaceholderRig` is the one this project's config still names,
 * as a record of a constant nothing reads — is a model with a full validator report and no reader. That is
 * exactly the shape of a session spent on "the rigs are wrong": somebody fixes, or fails to fix, the model
 * nothing clones.
 *
 * **If nothing is found, it says so and names what it looked for.** A pass that prints nothing is
 * indistinguishable from a pass that never ran, which is the failure `TAGS.md` keeps re-learning.
 *
 * **Once, at boot, and never on a timer.** This is a description of the place file, not a live read; a rig
 * spawned later is `reportRigTemplateOnce`'s business, and re-walking `ServerStorage` every frame to answer a
 * question whose answer cannot change would be the only cost in the file.
 */
export function auditRigTemplates(): void {
	const folder = findFolder(ServerStorage, NPC_CONFIG.RIG_POOL_FOLDER);

	// **The folder the draw reads, named before the walk**, so a missing folder is one line of its own rather
	// than a mystery underneath "nothing is used". `readRigPool` reports the same absence from the other side
	// (`[Rig] pool — no "NPCs" folder …`) and both are worth having: that one is about a lobby with no bodies,
	// this one is about an audit with nothing to call used.
	if (folder === undefined) {
		logWarn(
			`[RigTemplate] audit — ServerStorage has no "${NPC_CONFIG.RIG_POOL_FOLDER}" folder, ` +
				`so nothing in it can be cloned. Every template below is therefore reported as outside it.`,
		);
	}

	const templates = new Array<Model>();

	// **Models that are shaped like a rig and are not a template.** Named once each at the end, never
	// validated: see this function's doc for the four aura carriers that produced the rule.
	const shaped = new Array<Model>();

	for (const descendant of ServerStorage.GetDescendants()) {
		if (!descendant.IsA("Model")) continue;

		const inFolder = folder !== undefined && descendant.Parent === folder;
		const besideFolder = descendant.Parent === ServerStorage;
		const rigged = descendant.FindFirstChildWhichIsA("Humanoid") !== undefined;

		// **Two ways to be a template, and the first does not ask for a `Humanoid`.** A `Humanoid` is what
		// makes a model a *rig*, but the folder's own children are *candidate* templates whether or not they
		// are rigs — a model in the folder with no `Humanoid` is precisely the fault that leaves a seat empty
		// with nothing in the log but a count, and naming it by path is the repair.
		if (inFolder || (besideFolder && rigged)) {
			templates.push(descendant);
			continue;
		}

		if (rigged) shaped.push(descendant);
	}

	if (templates.size() === 0 && shaped.size() === 0) {
		logWarn(
			`[RigTemplate] audit — no rig template was found: ServerStorage."${NPC_CONFIG.RIG_POOL_FOLDER}" ` +
				`holds no Model child, no direct Model child of ServerStorage has a Humanoid, and nothing ` +
				`anywhere under ServerStorage is shaped like a rig. Looked for all three — so there is ` +
				`nothing to clone and nothing to validate.`,
		);

		return;
	}

	logInfo(
		`[RigTemplate] audit — ${templates.size()} template(s) under ServerStorage` +
			(shaped.size() > 0 ? `, plus ${shaped.size()} rig-shaped model(s) nothing clones` : "") +
			`; the draw reads the Model children of ServerStorage."${NPC_CONFIG.RIG_POOL_FOLDER}"`,
	);

	let inFolderCount = 0;

	for (const template of templates) {
		const path = template.GetFullName();

		// **Folder membership, read from the template's own ancestry** rather than from a second walk of the
		// folder's children: one question, and it answers the same way for a model nested one folder deeper
		// than the draw can see (which is then honestly outside, because `readRigPool` reads direct children
		// only).
		const drawable = folder !== undefined && template.Parent === folder;
		if (drawable) inFolderCount++;

		const verdict = drawable
			? `IN THE FOLDER — ${path}`
			: `OUTSIDE THE FOLDER — ${path} (not a child of ServerStorage."${NPC_CONFIG.RIG_POOL_FOLDER}", so no draw can clone it)`;

		const faults = inspectRigTemplate(template);

		let fatal = 0;
		let warnCount = 0;
		let notes = 0;

		for (const fault of faults) {
			if (fault.severity === "fatal") fatal++;
			if (fault.severity === "warn") warnCount++;
			if (fault.severity === "note") notes++;
		}

		// **One summary line per template, then one line per fault**, and in that order: a reader scanning a
		// long boot log wants the count beside the path, and a reader fixing the place file wants the paths.
		// **`clean` is decided by the two actionable severities and not by the list being empty**, because a
		// template with a `Humanoid` always carries at least the `RigType` note — so "0 faults" is a summary
		// no template can produce, and a word for "nothing to do here" would otherwise never appear.
		const summary =
			fatal === 0 && warnCount === 0
				? notes === 0
					? "clean"
					: `clean — ${notes} note`
				: `${fatal} fatal, ${warnCount} warn, ${notes} note`;

		const line = `[RigTemplate] ${verdict} — ${summary}`;

		if (fatal > 0 || warnCount > 0) {
			logWarn(line);
		} else {
			logInfo(line);
		}

		for (const fault of faults) {
			const faultLine = `[RigTemplate]   ${lineFor(fault)}`;

			if (fault.severity === "note") {
				logInfo(faultLine);
			} else {
				logWarn(faultLine);
			}
		}
	}

	// **The rig-shaped models, one line each — named and not validated.** They are usually not templates at
	// all (the aura dummies are effect carriers), so a full report would be thirty-six true lines about a
	// thing nothing clones; but a model with a `Humanoid` that no rule reached is also exactly the "template
	// nobody configured" this pass exists to find, so it is named rather than dropped.
	// **"neither … nor", because the first clause used to be a lie about the one case that mattered.** This
	// line said "not in ServerStorage."NPCs" and not a direct child of ServerStorage", and `Historia Reiss.`
	// — the real rig inside the `Historia Reiss` wrapper — printed against it while being very much *in* the
	// folder, which reads as "the audit has lost its place". The distinction both rules actually share is
	// **direct children only**: a model one level deeper is invisible to the draw whatever folder it sits in,
	// so the sentence says that instead of naming a nesting level it does not check.
	for (const model of shaped) {
		logInfo(
			`[RigTemplate] RIG-SHAPED, NOT A TEMPLATE — ${model.GetFullName()} ` +
				`(neither a Model child of ServerStorage."${NPC_CONFIG.RIG_POOL_FOLDER}" nor a Model child ` +
				`of ServerStorage, so nothing clones it — not validated)`,
		);
	}

	// **The boot pass does not seed the gate's "already reported" set, and that is deliberate.** The two
	// readings are different moments: this one is the place file as saved, and the gate's is *the template
	// being cloned right now* — which is the only reading that catches a model whose fault was introduced
	// after boot, or one that was never under `ServerStorage` at all (`spawn` is handed a `Model`, not a
	// path). Seeding it here would silence exactly the two cases the gate exists for, in exchange for saving
	// one line per faulty template per session.
	logInfo(
		`[RigTemplate] audit — ${templates.size()} template(s): ${inFolderCount} inside ` +
			`ServerStorage."${NPC_CONFIG.RIG_POOL_FOLDER}" (what a draw can clone), ` +
			`${templates.size() - inFolderCount} elsewhere (nothing clones these), ` +
			`${shaped.size()} rig-shaped model(s) skipped. ` +
			`Nothing was repaired; this is a reading of the place file.`,
	);
}
