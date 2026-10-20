import { Debris, ReplicatedStorage, Workspace } from "@rbxts/services";
import { CatchCause } from "shared/constants";
import { CATCH_CONFIG } from "shared/config/catch.config";

/** Prints one line per effect played, and one per template that is not there. */
const DEBUG = false; // off for frame time — see shared/config/debug.config.ts

/**
 * The two template names in `ReplicatedStorage`, and **the whole of the contract with them.**
 *
 * **The effect is found by name, not by path** — a template's structure is a moving target and the only contract
 * is its name. The user rearranges it, adds emitters to it and re-parents its parts, and every one of those is
 * free because nothing below this line knows where anything is: a template is found by a walk of
 * `ReplicatedStorage`, its parts by walking the clone, and its emitters by *class* rather than by the name
 * `Shockwave1`. That last one is the point — an emitter renamed in Studio is not a broken effect, and a name the
 * code reads is a name a person can no longer change.
 *
 * **The one thing a name does not pin down is which end of the effect it is written on**, and that is deliberate:
 * it may be the carrier part, or the emitter itself. Both are the same thing to a person building it — *this* is
 * the effect — and the place file arrived that way for the shockwave, with the name on the emitter under a
 * carrier part still called `Part`. `findTemplate` resolves either to the same carrier, so renaming an emitter
 * remains free, and so does naming one.
 *
 * **Two names for one attribute, and which one plays is the whole of what the cause decides.** White for the
 * attempt and green for the catch, both authored in Studio and neither tinted here: the colour lives in the
 * emitters, and a `Color3` written in this file would be a second colour authority beside the one a person
 * authored — with the emitter's own sequence, `LIGHT_EMISSION` and texture all multiplying into the pixel, none
 * of it knowable from code. See `CATCH_ANIMATION_ATTRIBUTE` in `shared/constants.ts` for the two values and why
 * there are two rather than a flag.
 */
const ATTEMPT_TEMPLATE_NAME = "CatchAttempt";
const SHOCKWAVE_TEMPLATE_NAME = "CatchShockwave";

/**
 * The part on the body the effect is welded to.
 *
 * **`HumanoidRootPart` rather than the head, and the reason is the catch pose.** The head is what the
 * animation moves — it bobs and turns through the reach — so an effect anchored to it would drift and
 * rotate with the flourish, while the root is the body's own centre and holds still for the whole of the
 * clip. It is also what every other whole-body effect in this codebase reaches for, and every body has
 * one: a player's character and a rig are the same call here, which is why there is no second path below.
 *
 * **One constant, deliberately, because `Head` is the alternative a person may prefer** — an effect that
 * sits at the catch pose rather than at the body's centre is a different look rather than a better one.
 * Changing this line is the whole of that decision.
 */
const ANCHOR_PART = "HumanoidRootPart";

/**
 * How many particles each emitter in the template is asked for, per catch. **Placeholder.**
 *
 * **`:Emit(N)` rather than turning `Enabled` on**, because a shockwave is a burst and not a stream: an
 * emitter left enabled would spray until the clone is destroyed, and the count is the one number that
 * says "one hit" rather than "one fountain". Thirty is the number this is guessed at — small enough to
 * read as a single impact at a few studs, large enough to be unmistakable — and it is per *emitter*, so a
 * template with two emitters fires sixty particles for this number.
 */
const EMIT_COUNT = 30;

/**
 * How long a clone is kept beyond the catch animation, in seconds. **Placeholder.**
 *
 * **The margin exists because the particles outlive the pose**, and it is a *time* rather than a check on
 * the emitter: `Debris` is already a timer, and asking a particle emitter whether it has finished is a
 * question with no clean answer — the engine keeps drawing a particle after its own lifetime only in
 * ways nothing can enumerate. Destroying the clone stops nothing already in flight, so this is only how
 * long the carrier part is left in the world before the engine takes it away. Four tenths is longer than
 * any one particle's fade at these counts.
 */
const FADE_MARGIN_SECONDS = 0.4;

/**
 * The clone playing on each body, so a new catch can end the last one.
 *
 * **Keyed on the body rather than on the clone**, because the question being asked is "is this body
 * already wearing one" — and a second catch landing before the first effect has expired must *replace* it
 * rather than stack a second burst on the same spot. Two clones welded to one root is a shockwave twice
 * as bright and a second `Debris` timer for a part the first would have taken anyway.
 *
 * Entries are removed when this module destroys a clone and **are not** pruned when `Debris` takes one:
 * a body that has left the world is never asked about again, so the entry is a `Model` reference held for
 * the session. That is the same trade every per-body table in this codebase makes (see
 * `DodgeService.lastDodgeAt`), and it is one entry per body that ever caught.
 */
const playing = new Map<Model, Instance>();

/** The template names already warned about. **Once each**, so one missing template cannot hide the other. */
const warnedTemplates = new Set<string>();

/** The template names whose emitters have already been described. **Once each** — a template does not change. */
const describedTemplates = new Set<string>();

/**
 * The last cause this module acted on, per body — **the guard that replaced the clip edge.**
 *
 * **Keyed on the body, so two bodies are two effects**: two rigs attempting at the same moment have a record
 * each, and neither can suppress the other's white glow. An entry is removed when the attribute clears
 * (`undefined`, the mark expiring), which is the whole of what lets the same body attempt again after a reach
 * that came to nothing. Entries are **not** pruned for a body that leaves the world, which is the same trade
 * `playing` beside this makes and every per-body table in this codebase makes.
 */
const lastCause = new Map<Model, CatchCause>();

/**
 * Plays the catch effect on `body` — **white for the attempt, green for the catch** — and the whole of it, for a
 * player and a rig alike. A separate function per cause is what the file used to be able to afford; what it cannot
 * afford is two copies of the weld, the flags and the emitter handling, which is where the two effects would drift
 * apart. Which template plays is the *only* thing the cause decides.
 *
 * **A client-side effect on a server-side fact.** Both halves of a catch are decided by the server and published
 * as `CATCH_ANIMATION_ATTRIBUTE` on the body, which replicates; the pixels are this client's business. So nothing
 * here is sent anywhere, nothing is cloned on the server, and the only things this module shares with the game's
 * authority are the *timing* — see the `Debris` line, which is the catch's own number — and the vocabulary of the
 * cause itself.
 *
 * **Called from the shared renderer rather than from a watcher of its own, and the renderer stays the only
 * reader of the attribute.** `applyBodyRender` is already driven by every attribute change on every body both
 * animators dress, and it reads `CATCH_ANIMATION_ATTRIBUTE` — so there is **no second discovery of the bodies**
 * here, and no subscription at all: this module is handed a body and a cause, and knows nothing about how either
 * was found. That is what makes it work for a rig and a player with one call — the renderer's callers are
 * `RigAnimationController` (a `NPC_TAG` walk, driven by `AttributeChanged`) and `LocomotionAnimationController`
 * (the local player's own character, driven by the tick).
 *
 * **The guard is the *cause* changing, and it replaced a guard on the clip.** This effect used to fire when the
 * clip became `"catch"`, which was correct while both halves of a catch wrote one value: the pose *was* the
 * event, and the edge into it was the edge into the catch. **Both causes play the same clip**, so that edge fires
 * once — on the attempt — and a body that reaches and then catches never changes clip when the ball arrives:
 * **the successful catch drew nothing at all.** The cause is the only thing that distinguishes the two, so it is
 * handed over on every render and acted on when it changes. The last cause acted on is remembered per body, and
 * an `undefined` — the attribute's third state, written when the mark expires — is what clears that record, so
 * the next attempt on that body fires again.
 *
 * **A second `"attempt"` with no clear in between draws nothing, deliberately.** The value did not change, so no
 * signal reached the client at all; and this module's record agrees with it. The body is in the state the white
 * glow is already describing, and a second burst on the same spot reads as a stutter rather than as a second
 * event.
 */
export function playCatchShockwave(body: Model, cause: CatchCause | undefined): void {
	// **The guard first, because it is the cheapest thing here and it is all that most calls do.** An `undefined`
	// is not "no call" — it is the mark expiring, and forgetting the body is the whole of the work.
	if (cause === undefined) {
		lastCause.delete(body);
		return;
	}

	// **And a cause that has not changed is not an event.** A rig's renderer runs on every attribute change of
	// that rig, and a player's runs twenty times a second, so this is what stops either of them drawing on a
	// tick.
	if (lastCause.get(body) === cause) return;
	lastCause.set(body, cause);

	const templateName = cause === "attempt" ? ATTEMPT_TEMPLATE_NAME : SHOCKWAVE_TEMPLATE_NAME;
	const template = findTemplate(templateName);
	if (template === undefined) {
		// **Warned about once *per template name*, and *printed* on every attempt.** Once per name because there
		// are two templates here and a missing `CatchAttempt` must not swallow the warning for a missing
		// `CatchShockwave` — the whole point of the line is to say which of the two is not there. Printed every
		// time for the reason the first version of this file records at length: a warning that fires once and then
		// goes quiet is indistinguishable, from the seat, from code that never ran.
		if (!warnedTemplates.has(templateName)) {
			warnedTemplates.add(templateName);
			warn(`[VFX] no ${templateName} in ReplicatedStorage — that catch effect will not play`);

			// **And then what it can see**, because "no template" is the half of the answer nobody can act on: the
			// two ways to get here — the thing is not there, and the thing is there under another name or in
			// another container — look identical from one line of prose. The report below distinguishes them, and
			// it runs once per name, which is what pays for the walk inside it.
			for (const line of nearMissReport()) warn(`[VFX] ${line}`);
		}

		if (DEBUG) print(`[VFX] ${body.Name}: ${cause}, but no ${templateName} template to clone`);
		return;
	}

	const root = body.FindFirstChild(ANCHOR_PART);
	if (root === undefined || !root.IsA("BasePart")) {
		if (DEBUG) print(`[VFX] ${body.Name}: ${cause}, but no ${ANCHOR_PART} to attach it to`);
		return;
	}

	// **The previous one goes first**, so a body never wears two — see `playing`. **That is the replacement rule
	// and it runs both ways round**: a catch destroys the attempt that preceded it, and an attempt that follows a
	// catch takes the green down as well. The rule is not "the catch wins", it is that the *newer* cause owns the
	// body, which is the same rule the mark itself has on the server and the same one the clip had. Destroyed
	// rather than left to `Debris`, because the point is that the new effect is the one on screen; a body with
	// nothing on it is the ordinary case and `?.` is the whole of that.
	playing.get(body)?.Destroy();

	const clone = template.Clone();

	// **Every part, walked rather than named, and seven flags are set on each — which is the whole of what
	// "a carrier part" means here.**
	//
	// The first four are facts about physics and picking, and none of them can be wanted the other way: a
	// carrier that can collide, be touched or be queried is a part the game can react to, and an anchored one
	// would pin the body it is welded to.
	//
	// **`Massless = true` is the one of the three below that is a bug rather than a look.** A welded part
	// contributes its mass to the character's assembly, and `Anchored = false` does not cover that — the
	// carrier is joined to the body either way, so without this the body is heavier for the length of the
	// effect: a change in how it moves, caused by a part nobody can see. For half a second of catch that is
	// a subtle wrongness in the feel of the game, which is the hardest kind to attribute to anything.
	//
	// **`Transparency = 1` and `CastShadow = false`, and the first reverses a decision this file used to
	// argue for.** The old argument was that the carrier is invisible because the *author* made it so, and
	// that a part meant to be seen is a thing somebody may add to the template — so transparency was left
	// alone. **That is overridden**: the carrier is not the effect, the emitter inside it is, and a template
	// that arrives with the default opaque part produces a grey box flashing on the body. A carrier this file
	// makes and a carrier a person made are the same thing here, and neither is meant to be looked at. The
	// shadow goes with the transparency for the same reason — an invisible part still casts one, and a moving
	// rectangle of shadow under a head is exactly the fault that is noticed a week later.
	//
	// **What is deliberately not set**: `CollisionGroup`, because the four flags above are already what stops
	// collisions; `Velocity`, `AssemblyLinearVelocity` and `CustomPhysicalProperties`, because a welded part's
	// motion is its assembly's; and anything on the attachment, which is a position and nothing more.
	let first: BasePart | undefined;
	for (const part of templateParts(clone)) {
		part.Anchored = false;
		part.CanCollide = false;
		part.CanTouch = false;
		part.CanQuery = false;
		part.Massless = true;
		part.Transparency = 1;
		part.CastShadow = false;

		if (first === undefined) first = part;
	}

	// **The model's own `PrimaryPart` if it declares one, and the first part found otherwise.** The
	// declaration is the model's answer to "what is this thing centred on" and it is a fact a person set; the
	// fallback is for a template nobody has finished setting up, where the first part is at least *a* part of
	// it rather than a refusal — and for a template that *is* a part, where the first part is the whole thing.
	const declared = clone.IsA("Model") ? clone.PrimaryPart : undefined;
	const anchor = declared ?? first;
	if (anchor === undefined) {
		if (DEBUG) print(`[VFX] ${body.Name}: the ${templateName} template has no parts to weld`);
		return;
	}

	clone.Parent = Workspace;

	// **And it is put *on* the body before it is welded there, which is the whole of "where the catch
	// happened".** A `WeldConstraint` holds the offset the two parts *already have* at the moment it is made
	// — it does not pull one onto the other — so a clone straight out of `ReplicatedStorage` is welded to the
	// root at whatever distance the template happens to sit from the world origin, and then dragged around at
	// that distance for the whole of the catch. That is exactly what it did: bursts scattered across the
	// arena, one per rig, none of them where the catch was. `BallService` records this same lesson about a
	// held ball — *"a weld holds the offset the parts already had and a ball caught across the body would
	// stay across it"* — and this is that lesson wearing a different hat: the ball's frame is set to the grip
	// before its weld for the same reason, and a part nobody positioned at all is the worse case.
	//
	// **`root.CFrame` and not an offset from it**, because the anchor is the *carrier*: the emitter's own
	// placement inside it is the authoring side of this (see the note on the attachment in `carrierOf`), and
	// a second offset written here would be a placement decision made in code, in a file that cannot see the
	// effect it is placing.
	anchor.CFrame = root.CFrame;

	// **A `WeldConstraint` rather than an `Attachment` and a second weld.** The stated alternative — an
	// `Attachment` made by this code, parented to the root, with the clone's part welded to that — is more
	// machinery for the same result: the constraint holds two parts' relative `CFrame`, the relative offset
	// above is zero, and an attachment would exist only to be a part of a chain with two ends instead of one.
	// **Parented to the clone** rather than to the root, which is `CollisionIgnore`'s trick and its reason:
	// the weld dies with the thing it holds, and no cleanup is anybody's job.
	const weld = new Instance("WeldConstraint");
	weld.Part0 = root;
	weld.Part1 = anchor;
	weld.Parent = anchor;

	// **By class, and every one of them.** A template with two emitters is a person having a second idea
	// about the shape, and firing one of them would be this code choosing which idea was better.
	const emitters = templateEmitters(clone);

	// **Once per session, and before the `Enabled` handling below touches anything** — so what this reports
	// is what the template actually holds rather than what this file just did to it. It is here because
	// every line above can read as success while the emitter itself is set up in a way that produces no
	// pixels: `Rate` and `Lifetime` decide whether anything is emitted, `Size` and `Transparency` whether
	// it can be seen. None of that is visible from the code, and all of it is one print.
	if (DEBUG && !describedTemplates.has(templateName)) {
		describedTemplates.add(templateName);

		if (emitters.isEmpty()) {
			print(`[VFX] the ${templateName} template holds no ParticleEmitter — there is nothing to fire`);
		}

		for (const emitter of emitters) print(`[VFX] emitter ${emitter.Name}: ${describeEmitter(emitter)}`);
	}

	// **And every emitter is locked to the carrier** — the one property in this file that is set on an emitter
	// rather than on a part. Unlocked, particles are born *into the world* at the point they were emitted: the
	// carrier keeps up with the body and they do not, so a body moving through its own effect leaves the burst
	// behind it. Locked, they ride the part, which is what an effect welded to a body is asking for.
	//
	// **Set on the clone rather than read from the template**, so a template authored either way behaves the
	// same, and the original in `ReplicatedStorage` is untouched.
	for (const emitter of emitters) emitter.LockedToPart = true;

	// **The `Enabled` question, which the installed typings do not answer.** `ParticleEmitter:Emit` is
	// documented there as "emits a given number of particles" and nothing more, so whether a template parked
	// with `Enabled = false` — the usual way to leave one sitting in `ReplicatedStorage` — is *gated* by that
	// property is unknown from here, and this code must not be written as though it were known. So an emitter
	// that is off is opened for exactly one frame: long enough that the `Emit` below is not gated by it
	// whichever way the engine behaves, short enough that a template with a non-zero `Rate` cannot spray for
	// the clone's whole second — see `EMIT_COUNT`, where a burst and not a stream is the design.
	//
	// **An emitter authored on is left exactly as it is, and `Rate` is never touched.** That is the
	// author's, and one second of their own emitter is what they asked for; the alternative — forcing
	// `Rate` to zero so the burst is the only thing that can happen — would quietly overrule a look
	// decision to remove a doubt about the engine, which is the wrong trade.
	for (const emitter of emitters) {
		if (emitter.Enabled) continue;

		emitter.Enabled = true;
		task.defer(() => (emitter.Enabled = false));
	}

	for (const emitter of emitters) emitter.Emit(EMIT_COUNT);

	playing.set(body, clone);

	// **The catch's own duration plus the margin**, read from the config rather than written here so the
	// effect cannot outlive a shorter catch animation or be cut off by a longer one. `Debris` rather than a
	// `task.delay` and a `Destroy`: this is one part per catch, the timer is the engine's, and a pooled
	// effect would be machinery for a thing that happens a few times a round.
	Debris.AddItem(clone, CATCH_CONFIG.CATCH_ANIMATION_SECONDS + FADE_MARGIN_SECONDS);

	// **The count is on the line, and it is the difference between two silent faults.** Every step above
	// prints nothing of its own, so "found the template and fired nothing" and "fired a burst that cannot be
	// seen" arrive as the same line without it. **And the cause and the template are on it because that is the
	// question this log exists to answer**: two effects fire from one attribute, so a line naming neither would
	// leave "did the catch draw the green" to be inferred from colours on a screen.
	if (DEBUG) {
		print(
			`[VFX] ${body.Name}: ${cause} — ${templateName} on ${ANCHOR_PART} — ` +
				`${emitters.size()} emitter(s) x ${EMIT_COUNT}`,
		);
	}
}

/**
 * The template, found by name in `ReplicatedStorage`, **as a `Model`, a `BasePart`, or an emitter that
 * the name was put on instead.**
 *
 * **Three shapes, and the third one is not a guess — it is the shape the place file actually has.** The
 * intent was always "find the effect", and the effect *is* the emitter: a person builds one, names the
 * thing that matters, and the carrier part under it goes on being called `Part`. The first version took
 * the name to be the carrier's, insisted on a `Model`, and so reported nothing found on every catch in
 * every session while the effect sat there complete; the second accepted a `Part` and still reported
 * nothing, because `CatchShockwave` was one level further down, inside the `Main` attachment. So the name
 * is now read as naming *either end of the same thing* — the carrier, or the emitter it carries — and
 * both resolve to the same carrier.
 *
 * **Two classes on the carrier end, and this is the one place a class is not part of the question.**
 * Everywhere else in this codebase a lookup that accepts "anything called this" is a bug waiting for a
 * decoy — see the `LobbySpawn` folder that was shadowed by a part of the same name. Here the question is
 * not *what* the template is but *what it holds*: parts and particle emitters. Whether a person wrapped
 * those in a `Model` or left the carrier part loose is a packaging choice with no behaviour attached to
 * it, and both are handled identically below.
 *
 * **Still not "anything by that name".** A `Folder`, an `Attachment` or a `Sound` called `CatchAttempt` is not a
 * template, and returning one would push the failure down to "no parts to weld" where it is harder to read.
 * Returning `undefined` puts it where the operator can see it — and the near-miss report that follows names the
 * instance and its class, which is how this call was diagnosed.
 *
 * **A walk of `ReplicatedStorage` rather than a path**, for the reason `find.ts` gives at length: the template's
 * place in the tree is a thing a person moves, and the only contract is the name. **Takes the name as an
 * argument rather than closing over a constant**, because there are two of these now — the white attempt and the
 * green catch — and one lookup answering for both is what keeps the two effects from drifting apart in the one
 * place they could: how the place file is read.
 */
function findTemplate(name: string): Model | BasePart | undefined {
	for (const descendant of ReplicatedStorage.GetDescendants()) {
		if (descendant.Name !== name) continue;
		if (descendant.IsA("Model") || descendant.IsA("BasePart")) return descendant;

		// **The name was on the emitter**, which is the case a named-effect template usually arrives in —
		// so the carrier is found *upward* from it. See `carrierOf`, which is the whole of that walk.
		if (descendant.IsA("ParticleEmitter")) return carrierOf(descendant);
	}

	return undefined;
}

/**
 * What to clone, given that the name is on an emitter: **the nearest thing above it that can be welded to
 * a body.**
 *
 * **Upward, and stopping at the first part rather than at the outermost container.** A `Model` above the
 * carrier is a person tidying their `ReplicatedStorage`, not a second thing to place — climbing to it
 * would drag whatever else that model holds along with every burst, and climbing further still (to
 * `vfx-assets`, and eventually to all of `ReplicatedStorage`) is how a lookup like this ends up cloning
 * the world. The nearest `BasePart` is the part the emitter is actually attached to, and that is the
 * smallest thing that carries the effect.
 *
 * **A `Model` is accepted when there is no part between the emitter and it**, which is the other shape a
 * person can build: an emitter dropped straight into a model of loose parts. There the model *is* the
 * carrier, its parts are the clone's parts, and `PlayCatchShockwave` already knows how to pick an anchor
 * out of that — it asks for `PrimaryPart` and falls back to the first part it finds.
 *
 * **The carrier is three levels — `Part` → `Attachment` → `ParticleEmitter` — and each is doing something.**
 * The walk passes *through* the attachment without stopping at it, and that is the point of the shape: an
 * attachment has no frame of its own in the world, it is a place *inside* a part, so the thing to clone is
 * the part, and cloning it brings the attachment and the emitter along and keeps the position the author
 * gave the emitter within the carrier. An emitter dropped straight into the part emits from the part's
 * centre; one in an attachment can sit on a face, at an edge, or in a corner, and that is a decision this
 * file has no business overriding by re-parenting anything. It also means the attachment's own offset is the
 * placement knob in Studio — see the frame written in `PlayCatchShockwave`, which places the carrier on the
 * body and nothing else.
 *
 * **Stops at `ReplicatedStorage`**, so a template that is somehow not below a part at all resolves to
 * nothing and gets reported rather than resolving to something enormous.
 */
function carrierOf(emitter: ParticleEmitter): Model | BasePart | undefined {
	let node = emitter.Parent;
	while (node !== undefined && node !== ReplicatedStorage) {
		if (node.IsA("BasePart")) return node;
		if (node.IsA("Model")) return node;

		node = node.Parent;
	}

	return undefined;
}

/**
 * Every part of the cloned template, **the clone itself included if it is one.**
 *
 * **`GetDescendants` does not include the instance it was called on**, and that is not a footnote — it is
 * a hole this file fell into. A template that *is* the carrier part (see `findTemplate`) has no part
 * among its descendants at all: the part is the clone, and the only thing inside it is the emitter. So a
 * loose-part template walked this way yielded nothing, the anchor below came out `undefined`, and the
 * effect returned without ever welding anything — silently, in the version that had no print on that path.
 * The part is asked for first, so "the first part" of such a template is the template.
 */
function templateParts(clone: Instance): BasePart[] {
	const parts: BasePart[] = [];
	if (clone.IsA("BasePart")) parts.push(clone);

	for (const descendant of clone.GetDescendants()) {
		if (descendant.IsA("BasePart")) parts.push(descendant);
	}

	return parts;
}

/** How many near-miss names `nearMissReport` lists before it stops looking. Enough to see the answer. */
const MAX_NEAR_MISSES = 8;

/**
 * What this client can see that might have been meant by one of the two template names, as lines for the log.
 *
 * **The one thing a failed lookup cannot tell you is which failure it was.** "No `CatchShockwave`" is
 * true of a template nobody made, a template spelled `catchShockwave`, a template sitting under a folder
 * — which the walk *would* have found — and a template dragged into `Workspace` by mistake, and the same
 * one line reports all four. So this says what is actually there: the direct children of
 * `ReplicatedStorage`, and every instance anywhere in the client's view of the DataModel whose name
 * contains `catch` or `shock`.
 *
 * **A walk of the whole DataModel rather than of `ReplicatedStorage`, and the container is the reason.**
 * The likeliest mistake is not a typo but a wrong home — a part left in `Workspace` where it was built,
 * or in `ServerStorage` where it looked tidy. `Workspace` this finds; `ServerStorage` *nothing on a
 * client can find*, because it does not replicate, and that is worth the first line of the report saying
 * so rather than leaving an operator to conclude the code is blind.
 *
 * **Called once per session, from the missing-template branch**, which is the only thing that makes a
 * walk this wide acceptable: it is a string compare against every instance the client holds, and a
 * session that pays for it once has a template problem rather than a performance one.
 */
function nearMissReport(): string[] {
	const lines: string[] = [
		"what this client can see — ServerStorage and ServerScriptService do not replicate, so a template in either cannot be found from here:",
	];

	const top: string[] = [];
	for (const child of ReplicatedStorage.GetChildren()) top.push(`${child.Name} (${child.ClassName})`);
	lines.push(`ReplicatedStorage: ${top.isEmpty() ? "empty" : top.join(", ")}`);

	const matches: string[] = [];
	for (const descendant of game.GetDescendants()) {
		const lower = string.lower(descendant.Name);
		const [shock] = string.find(lower, "shock");
		const [caught] = string.find(lower, "catch");
		if (shock === undefined && caught === undefined) continue;

		matches.push(`${descendant.GetFullName()} (${descendant.ClassName})`);
		if (matches.size() >= MAX_NEAR_MISSES) break;
	}

	lines.push(
		matches.isEmpty()
			? "nothing anywhere in the client's view has 'catch' or 'shock' in its name"
			: `close names: ${matches.join(", ")}`,
	);

	return lines;
}

/**
 * Every emitter in the cloned template, **by class and in tree order.**
 *
 * **Its own walk rather than the one `templateParts` does**, because the two want different things from the
 * same tree and neither wants the other's answer: the parts walk starts at the clone when the clone is a
 * part, and the emitters are always strictly below it. Sharing one traversal would mean one function
 * returning two lists and explaining in its doc which of them may include the clone.
 */
function templateEmitters(clone: Instance): ParticleEmitter[] {
	const emitters: ParticleEmitter[] = [];
	for (const descendant of clone.GetDescendants()) {
		if (descendant.IsA("ParticleEmitter")) emitters.push(descendant);
	}

	return emitters;
}

/**
 * One emitter's authored state as a line of prose — **the properties that decide whether a correct `Emit`
 * produces anything a person can see.**
 *
 * **`Rate` and `Lifetime` are the first pair**: a `Rate` of zero is normal for a burst emitter and means
 * the `Emit` call is the only thing that will ever put a particle in the world, and a `Lifetime` of zero
 * means the particle is born dead. **`Size` and `Transparency` are the second**: a zero size or a fully
 * transparent particle is emitted, moves, expires, and is never drawn — which from a seat in Studio looks
 * exactly like an effect that never ran. Those four are the whole of the doubt, and they are all visible
 * in the template's properties panel; this is the same information, in the log, next to the line that says
 * the burst was fired.
 *
 * **`TimeScale` and `Brightness` are deliberately not here.** They change how the effect looks rather than
 * whether it exists, and a line that reports everything is a line nobody reads.
 */
function describeEmitter(emitter: ParticleEmitter): string {
	return (
		`enabled ${emitter.Enabled}, rate ${emitter.Rate}, ` +
		`lifetime ${rangeText(emitter.Lifetime)}, speed ${rangeText(emitter.Speed)}, ` +
		`size ${sequenceText(emitter.Size)}, transparency ${sequenceText(emitter.Transparency)}`
	);
}

/** A `NumberRange` as `3` when it is a single value and `3-5` when it is a spread between two. */
function rangeText(range: NumberRange): string {
	return range.Min === range.Max ? `${range.Min}` : `${range.Min}-${range.Max}`;
}

/**
 * A `NumberSequence` as **its two ends** — `0.5→2` — because the middle is the shape of the effect and the
 * ends are whether it exists at all.
 *
 * **`NumberSequence` and not `NumberRange`**, which is the pair worth keeping apart: `Size` and
 * `Transparency` are sequences over each particle's lifetime, so a particle that starts invisible and
 * becomes visible (or the reverse, which is the usual shockwave fade) has two ends that differ, while one
 * that is zero at both ends never draws at all.
 */
function sequenceText(sequence: NumberSequence): string {
	const keys = sequence.Keypoints;
	if (keys.isEmpty()) return "empty";

	const first = keys[0].Value;
	const last = keys[keys.size() - 1].Value;

	return first === last ? `${first}` : `${first}→${last}`;
}
