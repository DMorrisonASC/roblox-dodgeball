import { Debris, ReplicatedStorage, Workspace } from "@rbxts/services";

/** Prints one line per release, and one per template that is not there. */
const DEBUG = true;

/**
 * The template's name in `ReplicatedStorage`, and **the whole of the contract with it.**
 *
 * **Found by name, never by path** — `catchShockwave.ts`'s rule and its reason: the user rearranges a template,
 * adds emitters to it and re-parents its parts, and every one of those is free because nothing below this line
 * knows where anything is. The name may be on the carrier part *or* on the emitter under it; `findTemplate`
 * resolves either end to the same carrier.
 *
 * **A name of its own rather than a share of the server's gust**, and the two are not the same effect: this one
 * is a shell of air around a *body*, and `WindBurst.ts`'s is a puff at the *ball* the instant it was given
 * velocity. Both play on one throw — see the file comment for the duplication this makes, and the one line that
 * turns the other one off.
 */
const TEMPLATE_NAME = "WindBurst";

/**
 * The two feet, by rig type: **R15 wears `RightFoot`/`LeftFoot`, R6 `Right Leg`/`Left Leg`.**
 *
 * **`HumanoidRootPart` was the first answer and it is the thing that was wrong.** The root is what every other
 * body effect in this codebase welds to — the catch shockwave and the hit impacts both do, and both argue for it
 * as the body's own centre — but that centre is the *hips*, so a gust anchored there reads as coming out of the
 * middle of a body rather than off the ground. The user's words after seeing it: **"the wind is coming out in an
 * awkward place. Let's use the feet instead."**
 *
 * **The feet rather than one foot, which is the second half of that correction, and it is arithmetic rather than
 * another report**: one foot is half a stance off centre, so the gust leaves from one leg and a walking body
 * carries it through the stride with it. Both feet give the point *under* the body. See {@link anchorOf} for how
 * the two are combined, and why the answer is a position rather than a part.
 *
 * **A pair of names per rig, because this is the hand's problem a second time.** R6 calls the leg `Right Leg` and
 * R15 calls the foot `RightFoot`, and which pair a body wears is a fact about its rig type — the same rule, and
 * the same two traps, as `chargeEffect.handOf`: `Humanoid.RigType` reads `R6` for a rig whose parts are R15
 * whenever the template's humanoid was never told otherwise, and a body whose `Humanoid` has not replicated at all
 * has no rig type to read. Both pairs are looked for, so both traps come out the same way.
 */
const FEET_R15 = ["RightFoot", "LeftFoot"];
const FEET_R6 = ["Right Leg", "Left Leg"];

/**
 * The part that *holds* the gust, and the placement it falls back to on a body with no foot in sight — **which is
 * where this effect used to sit.**
 *
 * **The root holds it and the feet place it, and the split is not arbitrary.** A `WeldConstraint` preserves the
 * offset two parts have when it is made, so what it should hold is the part that does not move relative to the
 * body: the root is that part, the animation does not drive it around, and every body has exactly one. A foot is
 * the better answer to *where* and the worse answer to *what* — it moves through a stride, so a gust welded to
 * one is dragged along the leg. {@link anchorOf} is where the two questions are separated.
 *
 * **And it is the fallback position on a body whose feet have not replicated**, which is the old placement rather
 * than no effect: a limb that is a frame late is not worth losing a release over, and the log names what was used
 * so the fallback is a fact rather than an inference. **The root is required**, which is exactly the requirement
 * this effect has always had — it used to *be* the anchor — so nothing is lost by keeping it.
 */
const FALLBACK_PART = "HumanoidRootPart";

/**
 * How many particles each emitter in the template is asked for, per throw. **Placeholder.**
 *
 * **`:Emit(N)` rather than a `Rate`, which is the opposite of the server gust and correct here for a reason
 * worth writing down.** `WindBurst.ts` documents at length that a *server-built* emitter fired with `Emit` is
 * invisible to everybody but the server — an emission is an event and what replicates is the emitter's
 * *properties* — and that is why that file uses a rate. **This module runs on the client that is drawing the
 * particles**, so its `Emit` is the local simulation asking for a burst on the machine that will render it:
 * the same call, and the opposite problem. A rate here would be a stream that the carrier's lifetime has to
 * cut off; a count is one throw's worth and nothing else.
 *
 * **Thirty, matching `catchShockwave.ts`'s burst** rather than the twelve the server gust spends: this one is
 * spread over the whole body rather than a point in the air, so it reads thinner at the same count. It is per
 * *emitter*, so a template with two emitters fires sixty for this number.
 */
const EMIT_COUNT = 30;

/**
 * How long the clone is kept before the engine takes it away, in seconds. **Placeholder — 0.5.**
 *
 * **The carrier's life, not the effect's**: destroying it stops nothing already in flight, so this is only how
 * long the part and its emitters sit in the world. Half a second is long enough for the gust to read as one
 * motion and short enough that it is over before the ball has landed at any range the game throws at.
 * `Debris` rather than a `task.delay` and a `Destroy` — the sibling effects' argument: one part per throw, and
 * the engine already owns the timer.
 *
 * **Two throws inside this window would overlap** rather than replace, and there is no state here to prevent
 * one from stacking on another. That is the deliberate shape — the prompt's one export, and nothing to store —
 * and it is unreachable in practice: a throw empties the hand, so the next one is a pickup and a re-throw away.
 */
const WIND_BURST_LIFETIME = 0.5;

/** The template name already warned about. **Once per session**, so a missing template says so once. */
const warnedTemplates = new Set<string>();

/**
 * One gust of air around the body that just threw — **the visible half of a release, for a player and a rig
 * alike.**
 *
 * **Called once per throw and has no stop.** Nothing stores the clone: `Debris` owns it, the caller owns
 * nothing, and the function returns `void` rather than the clone so that nobody is tempted to start treating
 * one as state. `WindBurst.ts` makes the same choice at the ball for the same reason.
 *
 * **Where it goes is {@link anchorOf}'s answer and the whole of it**: between the two feet at ground level, held
 * by the root so that it stays under the body while the body walks. Nothing in this function chooses a position
 * — which parts a given rig's feet are, and what to do when one is missing, are questions answered one helper
 * above, and the only thing this function does with the answer is put the carrier there.
 *
 * **A client-side effect on a server-side fact, like every other body effect here.** What makes a throw a
 * *throw* is decided on the server, and the fact this module reacts to is the one the server publishes for
 * every body that throws — see `chargeEffect.ts`, which owns the driver and hands this the body. Nothing is
 * sent from here and nothing is cloned on the server: the pixels are this client's business.
 *
 * **Every body, and that is a rule rather than an oversight.** A rig's throw reaches this the same way a
 * player's does, which is the point: the user's goal is that the two are hard to tell apart, and a burst on one
 * and not the other would be the most visible way to fail at it.
 *
 * **The caller decides *whether*, and it is not this module's question.** `chargeEffect.noteThrowMark` plays
 * this only for a throw at or above the full-charge threshold, so the gust is a **full-power** effect — the same
 * signature as the fire ball on the hand. That is the user's rule, given twice; the first version of this effect
 * played on every release at any charge and was reported as wrong. Nothing here knows about charges, which is
 * what keeps this module a burst and nothing else.
 */
export function playWindBurst(body: Model): void {
	// **Where it goes and what holds it there are two questions with two answers** — see {@link anchorOf}: the
	// position is between the feet at ground level and the weld is to the root, so the gust stays centred under
	// the body instead of riding a leg. A body with nothing to weld to is reported and skipped.
	const anchor = anchorOf(body);
	if (anchor === undefined) {
		if (DEBUG) print(`[VFX] ${body.Name}: wind burst wanted, but no ${FALLBACK_PART} to weld it to`);

		return;
	}

	const template = findTemplate(TEMPLATE_NAME);
	if (template === undefined) {
		if (!warnedTemplates.has(TEMPLATE_NAME)) {
			warnedTemplates.add(TEMPLATE_NAME);
			warn(`[VFX] no ${TEMPLATE_NAME} in ReplicatedStorage — the wind burst will not play`);

			// **And then what it can see**, because "no template" is the half of the answer nobody can act on:
			// not there, and there under another name in another container, look identical from one line.
			for (const line of nearMissReport()) warn(`[VFX] ${line}`);
		}

		if (DEBUG) print(`[VFX] ${body.Name}: wind burst wanted, but no ${TEMPLATE_NAME} template to clone`);
		return;
	}

	const clone = template.Clone();

	// **Every part, walked rather than named, and the same seven flags the other effects set.** They are copied
	// deliberately — see `catchShockwave.ts` for the argument in full — and the one that is a *bug* rather than a
	// look is `Massless`: a welded part contributes its mass to the body's assembly, so without it the thrower
	// gets heavier for the length of the burst, which is a change in how the game feels caused by a part nobody
	// can see. `Transparency` and `CastShadow` are here because the carrier is not the effect — the emitter
	// inside it is — and a template that arrives with the default opaque part would put a grey box on the body.
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

	const declared = clone.IsA("Model") ? clone.PrimaryPart : undefined;
	const carrier = declared ?? first;
	if (carrier === undefined) {
		if (DEBUG) print(`[VFX] ${body.Name}: the ${TEMPLATE_NAME} template has no parts to weld`);
		return;
	}

	clone.Parent = Workspace;

	// **Put *on* the body before it is welded there**, which is the correction the catch effect paid for: a
	// `WeldConstraint` holds the offset two parts *already have* at the moment it is made, so a clone straight
	// out of `ReplicatedStorage` would be welded at whatever distance the template sits from the world origin and
	// then dragged around at that distance for the whole of the burst.
	//
	// **The position comes from the anchor and the rotation from the part that holds it, deliberately.** The
	// position is between the feet, at ground level; the rotation is the body's own facing, because a foot's
	// frame is tilted and on R15 rotated with the ankle — a template that emits along the carrier's axes would be
	// blowing into the floor on one frame and at the sky on the next.
	carrier.CFrame = new CFrame(anchor.position).mul(anchor.weld.CFrame.Rotation);

	// Parented to the clone, so the weld dies with the thing it holds and no cleanup is anybody's job.
	const weld = new Instance("WeldConstraint");
	weld.Part0 = anchor.weld;
	weld.Part1 = carrier;
	weld.Parent = carrier;

	// **By class, and every one of them** — a template with two emitters is a person having a second idea about
	// the shape, and firing one of them would be this code choosing which idea was better.
	const emitters = templateEmitters(clone);

	// **`LockedToPart`, so the gust rides the body** — the sibling effects' choice for the same reason: unlocked,
	// particles are born *into the world* at the point they were emitted, and the body carries on without them.
	// For a burst this is the closer call of the two — a shell of displaced air left where it happened is
	// arguably the more physical reading — and it is settled this way for consistency: every body effect in this
	// codebase rides the body it is on, and one that did not would be the odd one to explain.
	for (const emitter of emitters) emitter.LockedToPart = true;

	// **And every emitter fires once**, which is the whole of this effect: a burst is one instant and the clone's
	// own lifetime is the only thing that ends it. `Enabled` is deliberately left as the author set it — a
	// template authored with a rate is a person asking for a stream, and this call adds one throw's worth on top
	// rather than overruling them. See {@link EMIT_COUNT} for why `Emit` is the right call on this side of the
	// wire even though it is the wrong one on the other.
	for (const emitter of emitters) emitter.Emit(EMIT_COUNT);

	Debris.AddItem(clone, WIND_BURST_LIFETIME);

	// **The parts are on the line, and that is the whole reason it is worth printing.** "The gust is in an awkward
	// place" is a report about *where* it went and *what is holding it there*, and the ways of getting it wrong —
	// a rig type read wrong, one foot missing, no foot at all so the root took over — look identical on screen. A
	// line naming the feet the position came from, and the part that holds it, turns the next report into a
	// diagnosis instead of a second guess.
	if (DEBUG) print(`[VFX] ${body.Name}: wind burst on release — ${anchor.label}, welded to ${anchor.weld.Name}`);
}

/**
 * Where the gust goes and what holds it there — **two answers, because the two want different parts.**
 *
 * - `position` is the midpoint of the two feet at the height they meet the ground: centred under the body, so
 *   the gust does not come off one side, and low, so it comes off the ground rather than out of the waist.
 * - `weld` is the root, because what a `WeldConstraint` holds is an *offset* — the thing to hold is the part
 *   that does not move relative to the body. A foot is the better answer to "where" and the worse to "what".
 * - `label` is what the log line says, so which parts were used is a fact rather than an inference.
 */
interface Anchor {
	position: Vector3;
	weld: BasePart;
	label: string;
}

/**
 * The placement: **between the feet, on the ground, held by the root** — see {@link FEET_R15} for why the feet at
 * all, and {@link FALLBACK_PART} for why the root holds it.
 *
 * **A position rather than a part, and that is the correction of this effect's second shape.** The first version
 * welded the gust to `RightFoot`, which is half a stance off centre: a walking body carries the gust through the
 * stride on one leg. Two feet give the point *under* the body, and a point is what the effect wanted — this used
 * to hang off the root because a `WeldConstraint` can only hold a `BasePart`, not because a part was the right
 * thing to be placed. So the position is computed here and the root holds it. **An `Attachment` at the foot
 * offset was the other way to do it and it does not work**: `WeldConstraint.Part0` takes a `BasePart`, so an
 * attachment can live *inside* the carrier but nothing can be welded to it.
 *
 * **The height is the bottom of the foot rather than the middle of it**, and that is the only arithmetic here.
 * The root is the hips, which is what was wrong; a foot's own centre is still half a foot above the ground — and
 * worse, a *different* half-foot on each rig, because R6 has no foot part and `Right Leg` is the whole leg, two
 * studs tall. Taking the bottom puts both rigs on the same line, which is the point of the exercise: a gust that
 * starts at a player's ankle and at a rig's knee is the most visible way to fail at making the two hard to tell
 * apart. A foot tilted through a stride moves the estimate by a fraction of a stud, and the template's own part
 * offsets are what a person tunes anyway.
 *
 * **The *lowest* foot, not the average of the two**, which is the second half of the same argument: with a foot
 * lifted, averaging the height leaves the gust floating between the planted sole and the lifted one instead of on
 * the ground. The horizontal position *is* averaged — that is what centres it — and the height is the ground.
 *
 * **Direct children of the character, and it is worth saying why that is not the one-level search this project
 * bans.** That rule is about *place files*, where a barrier in a folder inside a map's model costs a session when
 * it is missed. A character's limbs are not that: `Humanoid`, `HumanoidRootPart`, `RightFoot` are the engine's
 * own structure — a fixed set of direct children that nobody rearranges in Studio — which is the "a structure the
 * game itself requires" exception `find.ts` documents. `chargeEffect.handOf` and `BallFactory.getRightHand` read
 * limbs exactly this way.
 *
 * **Deliberately *not* yielding**, which is `handOf`'s rule and its reason: this runs on the frame the throw mark
 * replicates, and a `WaitForChild` here would either block or hand back a part a frame later, placing the gust on
 * a body that has already moved on. **The one requirement is the root**, which is the requirement this effect has
 * always had — it used to *be* the anchor — so a body without one is reported rather than quietly given a
 * different effect.
 */
function anchorOf(body: Model): Anchor | undefined {
	const root = basePart(body, FALLBACK_PART);
	if (root === undefined) return undefined;

	const feet = feetOf(body);
	if (feet.isEmpty()) return { position: root.Position, weld: root, label: `${root.Name}, no feet in sight` };

	let x = 0;
	let z = 0;

	// **Starts above every Y the loop can produce**, so the first foot always wins the comparison and no
	// `undefined` has to be carried through for the sake of a body with no feet — which returned above.
	let y = math.huge;
	const names: string[] = [];
	for (const foot of feet) {
		x += foot.Position.X;
		z += foot.Position.Z;
		y = math.min(y, foot.Position.Y - foot.Size.Y / 2);
		names.push(foot.Name);
	}

	const count = feet.size();
	const label = count === 1 ? `${names[0]} alone` : `between ${names.join(" and ")}`;

	return { position: new Vector3(x / count, y, z / count), weld: root, label };
}

/**
 * The body's feet, **whichever pair of names its rig type wears** — see {@link FEET_R15} for why both pairs are
 * asked for rather than the one the rig type implies.
 *
 * **The implied pair first and the other pair after it**, so an ordinary body is answered by its first two
 * lookups and a rig whose `Humanoid.RigType` disagrees with its parts still gets its feet. Right-then-left on
 * both paths, so the log line reads the same way round every time.
 *
 * **A body with one foot gets one, and that is not a second case**: the caller averages whatever is here, so a
 * limb a frame late is a stud off centre rather than a lost effect.
 */
function feetOf(body: Model): BasePart[] {
	const humanoid = body.FindFirstChildOfClass("Humanoid");
	const primary = humanoid?.RigType === Enum.HumanoidRigType.R15 ? FEET_R15 : FEET_R6;
	const other = primary === FEET_R15 ? FEET_R6 : FEET_R15;

	const feet: BasePart[] = [];
	for (const names of [primary, other]) {
		for (const name of names) {
			const part = basePart(body, name);
			if (part !== undefined) feet.push(part);
		}
	}

	return feet;
}

/**
 * A named direct child that is a part — **the class is part of the question**, which is `find.ts`'s lesson: a
 * decoy of the wrong class reads as "this body has no `HumanoidRootPart`" rather than as a decoy, and the effect
 * then reports a missing anchor it is standing next to.
 */
function basePart(body: Model, name: string): BasePart | undefined {
	const part = body.FindFirstChild(name);

	return part !== undefined && part.IsA("BasePart") ? part : undefined;
}

/**
 * The template, found by name in `ReplicatedStorage` — **as a `Model`, a `BasePart`, or an emitter the name was
 * put on instead.**
 *
 * **A walk of `ReplicatedStorage` rather than a path**, for the reason `find.ts` gives at length: a template's
 * place in the tree is a thing a person moves, and the only contract is the name. **Two classes, and this is the
 * one place a class is not part of the question** — the question is not *what* the template is but *what it
 * holds*, and whether a person wrapped it in a `Model` or left the carrier loose is packaging with no behaviour
 * attached to it. Still not "anything by that name": a `Folder` or a `Sound` called `WindBurst` is not a
 * template, and returning one would push the failure down to "no parts to weld" where it is harder to read.
 */
function findTemplate(name: string): Model | BasePart | undefined {
	for (const descendant of ReplicatedStorage.GetDescendants()) {
		if (descendant.Name !== name) continue;
		if (descendant.IsA("Model") || descendant.IsA("BasePart")) return descendant;

		if (descendant.IsA("ParticleEmitter")) return carrierOf(descendant);
	}

	return undefined;
}

/**
 * What to clone, given that the name is on an emitter: **the nearest thing above it that can be welded to a
 * body.**
 *
 * **Upward, stopping at the first part rather than at the outermost container**, which is the sibling modules'
 * rule: a `Model` above the carrier is a person tidying `ReplicatedStorage`, not a second thing to place. The
 * walk passes *through* an `Attachment` without stopping at it — an attachment has no frame of its own in the
 * world, so the thing to clone is the part, and cloning it brings the attachment and the emitter along at the
 * offset the author gave them. **Stops at `ReplicatedStorage`**, so a template that is not below a part at all
 * resolves to nothing and is reported.
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
 * **`GetDescendants` does not include the instance it was called on.** A template that *is* the carrier part has
 * no part among its descendants at all, so a walk that only looked downward would yield nothing, the carrier
 * would come out `undefined`, and the effect would return without welding anything — silently, on the happy
 * path. The part is asked for first, so "the first part" of such a template is the template.
 */
function templateParts(clone: Instance): BasePart[] {
	const parts: BasePart[] = [];
	if (clone.IsA("BasePart")) parts.push(clone);

	for (const descendant of clone.GetDescendants()) {
		if (descendant.IsA("BasePart")) parts.push(descendant);
	}

	return parts;
}

/**
 * Every emitter in the cloned template, **by class and in tree order.**
 *
 * **The direct answer to "does it matter how many emitters the template has": it does not.** This is a
 * class-based walk over the whole clone, so a template with two emitters, five or twenty takes the identical
 * path — there is no count here, no name read, and nothing to change when a person adds one. Its own walk rather
 * than the one `templateParts` does, because the two want different things from the same tree.
 */
function templateEmitters(clone: Instance): ParticleEmitter[] {
	const emitters: ParticleEmitter[] = [];
	for (const descendant of clone.GetDescendants()) {
		if (descendant.IsA("ParticleEmitter")) emitters.push(descendant);
	}

	return emitters;
}

/** How many near-miss names `nearMissReport` lists before it stops looking. Enough to see the answer. */
const MAX_NEAR_MISSES = 8;

/**
 * What this client can see that might have been meant by the template name, as lines for the log.
 *
 * **The one thing a failed lookup cannot tell you is which failure it was.** "No `WindBurst`" is true of a
 * template nobody made, one spelled `Windburst`, one sitting under a folder — which the walk *would* have found
 * — and one dragged into `Workspace` by mistake, and one line reports all four. So this says what is actually
 * there, and it names the likeliest mistake: **a template in `ServerStorage` cannot be found by any client at
 * all**, because that service does not replicate.
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
		const [wind] = string.find(lower, "wind");
		const [burst] = string.find(lower, "burst");
		if (wind === undefined && burst === undefined) continue;

		matches.push(`${descendant.GetFullName()} (${descendant.ClassName})`);
		if (matches.size() >= MAX_NEAR_MISSES) break;
	}

	lines.push(
		matches.isEmpty()
			? "nothing anywhere in the client's view has 'wind' or 'burst' in its name"
			: `close names: ${matches.join(", ")}`,
	);

	return lines;
}
