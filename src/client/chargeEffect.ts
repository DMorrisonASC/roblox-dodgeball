import Fusion from "@rbxts/fusion-3.0";
import { CollectionService, Players, ReplicatedStorage, RunService, Workspace } from "@rbxts/services";
import { BALL_CONFIG } from "shared/config/ball.config";
import { CHARGING_ATTRIBUTE, NPC_TAG, THROW_ANIMATION_ATTRIBUTE } from "shared/constants";
import { chargeStartedAt } from "./throwing";
import { playWindBurst } from "./windBurst";

/** Prints one line per effect edge, and one per template that is not there. */
const DEBUG = false; // off for frame time — see shared/config/debug.config.ts

/**
 * The template's name in `ReplicatedStorage`, and **the whole of the contract with it.**
 *
 * **Found by name, never by path**, which is `catchShockwave.ts`'s rule and its reason: the user rearranges a
 * template, adds emitters to it and re-parents its parts, and every one of those is free because nothing below
 * this line knows where anything is. The name may be on the carrier part *or* on the emitter under it — both
 * are "this is the effect" to a person building it, and `findTemplate` resolves either end to the same carrier.
 *
 * **One name rather than two, which is where this parts company with the catch effect.** That one has a cause
 * to tell apart (white for the attempt, green for the catch) and therefore two templates; a charge has no such
 * distinction — the effect means "this is being held" on a player and on a rig alike, so one template plays in
 * both places, and a rig's windup and a player's hold are the same pixels.
 */
const TEMPLATE_NAME = "ChargeHand";

/**
 * The hand that throws, by rig type: **the same two names `BallFactory.getRightHand` uses.**
 *
 * **Duplicated rather than shared, and that is a fact about the machines rather than a preference.** That
 * helper lives in `src/server/services/ball/BallFactory.ts` — a client cannot require a module under
 * `src/server` at all — and it yields (`WaitForChild(name, 10)`), which a client cannot do on the frame a
 * charge begins. So the *rule* is copied and the mechanism is not: the rig type picks the name, and the
 * fallback below covers the two cases the server's version never meets, because it is asking about a rig the
 * server built while this is asking about a rig that has replicated.
 *
 * **The fallback is not tidiness.** `Humanoid.RigType` reads `R6` for a rig whose parts are R15 whenever the
 * template's humanoid was never told otherwise, and a rig whose `Humanoid` has not replicated yet has no
 * rig type at all. Both cases would pick the wrong name and report "no hand" on a body that is holding a ball,
 * so the other name is tried before giving up. The cost is one child lookup on a body that has already failed
 * the first one.
 */
const HAND_R15 = "RightHand";
const HAND_R6 = "Right Arm";

/**
 * The second template's name: **the fire ball that overlays the hand's charge once the hold is nearly full.**
 *
 * **A second name rather than a second effect over the first**, which is the user's rule as stated: *overlay,
 * not replace*. Above the threshold both templates are cloned and welded to the same hand, and the two are
 * authored to sit on top of one another — see {@link FULL_CHARGE_THRESHOLD} for who crosses it and
 * {@link setFireBall} for the two clones' separate lifetimes.
 */
const FIRE_TEMPLATE_NAME = "ChargeFire";

/**
 * The charge at or above which a throw counts as a **full-power** one, as a fraction of a hold.
 * **Placeholder — 0.9. One number for two effects**, deliberately: the fire ball overlays the hand while a hold
 * is above it, and the wind burst plays around the body when a throw made above it happens.
 *
 * **0.9 rather than 0.8 or 1.0, and the reason is the same for both. It has to be a state a person can aim at.**
 * Lower and nearly every throw qualifies, which makes it noise; at exactly 1.0 it could only be reached on the
 * frame a hold caps, which is a flash rather than a state — **and a rig's solved charge *does* sit exactly at
 * 1.0 for the whole of a long throw**, so a literal 1.0 would have had the two bodies disagree about what
 * counts. A tenth under the top is the nearest value a player can hold to on purpose.
 *
 * **The user's rule, given twice, and the second time was what settled it.** The first version of the wind burst
 * played on *every* release whatever the charge — this file's reading of "plays on release, on every body that
 * throws" — and the user reported it twice before it was taken as a decision rather than a fault. **So both
 * effects are gated on this one number now**, and the pair reads as a single signature: a big throw is a gust
 * around the body and fire on the hand.
 *
 * **The rule is shared and the curve is not, which is the one place the two bodies still look different.**
 * A player's charge *rises* through this value on a clock, so they cross it and watch the hand light up part-way
 * through the hold. A rig's charge is **solved, not measured** — `chargeForRange` answers a distance with one
 * number at the instant it decides — so a rig is either above the threshold for the whole of its windup or
 * never, and its fire ball appears with the hold rather than during it. Nothing is broken by that; a rig is
 * simply not holding a button.
 */
const FULL_CHARGE_THRESHOLD = 0.9;

/**
 * The clone playing on each body, so a charge that ends can take it down.
 *
 * **Keyed on the body**, which is the question being asked — "is this body already wearing one" — and it is
 * what makes {@link startChargeEffect} idempotent. A rig's attribute fires `AttributeChanged` once per write,
 * but a player's charge is read from a `Fusion.Value` whose edge can arrive on a frame where the effect is
 * already up (a respawn mid-hold, a character swap), and a second clone welded to the same hand is two looping
 * effects on one wrist.
 *
 * Entries are removed when this module destroys a clone, and **are not** pruned when a body leaves the world:
 * that is the same trade `catchShockwave.ts`'s own table makes and the same one every per-body table in this
 * codebase makes.
 */
const playing = new Map<Model, Instance>();

/**
 * The fire ball playing on each body, separately from {@link playing} — **two clones, two tables, because only
 * one of them is conditional.**
 *
 * **The overlay is a second clone and not a swap**, which is the whole of what the two tables are for: the hand's
 * charge goes up when a hold begins and comes down when it ends, while the fire ball goes up and down *inside*
 * that window as the charge crosses {@link FULL_CHARGE_THRESHOLD}. One table holding both would have to answer
 * "which of my two things is absent" on every read, and a body below the threshold would be a row with a hole in
 * it rather than a body with no fire ball.
 *
 * **A crossing is destroy-then-clone, so a second crossing cannot leak.** The row is deleted and the clone
 * destroyed together, which is the same order `stopChargeEffect` uses, and a later crossing finds no row and
 * makes a fresh clone — one clone per crossing and never two alive, whatever the charge does on the way.
 */
const fireBalls = new Map<Model, Instance>();

/**
 * The last throw mark this module acted on, per body — **the record that makes one throw one gust.**
 *
 * **Without it, one throw fires four to five gusts over a third of a second**, which is what a first version of
 * this did. `AttributeChanged` fires for *every* attribute on a body — speed, grounded, frozen, the charge itself
 * — and `THROW_ANIMATION_ATTRIBUTE` stays `true` for `THROW_ANIMATION_SECONDS`, so testing the mark's *value* on
 * every attribute write re-fires on the windup that follows, on the next speed band, and on the release of a
 * later throw. What the mark means is an *edge*, and an edge needs the previous answer.
 *
 * **A second table rather than a second attribute read, and `catchShockwave.ts` is the precedent**: that module
 * keeps `lastCause` for exactly this reason — the same attribute signal fires for several attributes per
 * transition, and the effect it drives must fire once. The module's other conditional effect,
 * `setFireBall`, keeps its answer in {@link fireBalls} and gets the same property for free.
 *
 * Never cleared, like every per-body table in this file: a destroyed body is never asked about again.
 */
const throwSeen = new Map<Model, boolean>();

/**
 * The last charge this client saw on each body — **the value a throw is judged by, remembered because the
 * charge itself is gone before the throw arrives.**
 *
 * **The ordering is the whole reason this table exists.** Both charges are cleared at the *release*: a
 * player's `chargeStartedAt` goes `undefined` in the same frame the throw is sent, and a rig's
 * `CHARGING_ATTRIBUTE` is cleared by the behaviour's `endWindup`. The throw mark that says a throw *happened*
 * replicates a round trip later. So a reader that asked "what is this body's charge" when the mark lands
 * would always be told "none" — **the value has to be kept, and the only honest place to keep it is where it
 * was last read.**
 *
 * **Written by both roads, and it is exact on both.** A rig's number is constant for the whole of its hold
 * (`chargeForRange` solves it once), so the last value read is the value thrown. A player's is the level of the
 * frame before the release, which is the drawn charge — the release recomputes a fraction of a frame later and
 * prints both, and the two differ by about a hundredth of a hold, so **a hold released within a hundredth of
 * the threshold may be judged a hundredth low**. That is the boundary of a threshold that is itself a
 * placeholder, and the alternative is a server-published charge on the throw mark.
 */
const lastCharge = new Map<Model, number>();

/** The template name already warned about. **Once per session**, so a missing template says so once. */
const warnedTemplates = new Set<string>();

/** The template whose emitters have already been described. **Once**, because a template does not change. */
const describedTemplates = new Set<string>();

/** The connection that reads a rig's charging attribute, per rig this client is watching. */
const watched = new Map<Model, RBXScriptConnection[]>();

/**
 * **This module makes no Fusion scope, and that is a change.** It used to create one to hang an `Observer` on the
 * player's charge; see `startChargeEffects` for why that observer is a frame loop now, and with it gone there is
 * nothing to scope. Every Fusion call left here is a `peek`, which builds no graph edge and so cannot outlive
 * anything — the same position `aiming.ts` and `throwing.ts` describe for their own readers.
 */

/**
 * Starts the effect on `body`'s throwing hand: a clone of {@link TEMPLATE_NAME}, welded there, looping until
 * {@link stopChargeEffect} takes it down.
 *
 * **A client-side effect on a server-side fact, for a rig — and on a client-side fact for a player.** Both
 * roads end here: a rig's charge is published as {@link CHARGING_ATTRIBUTE} and read by the watcher at the
 * bottom of this file, while a player's own hold is read from `chargeStartedAt`, which is this client's. The
 * effect itself does not care which, and that is why there is one function rather than two — the difference
 * between a player and a rig is *who tells this module*, and nothing after that point can tell them apart.
 *
 * **Idempotent.** A body already wearing a clone is left alone rather than given a second one; see
 * {@link playing} for the two ways a duplicate call can arrive.
 *
 * **Every silent exit prints**, which is `catchShockwave.ts`'s rule and the reason it exists: "found no
 * template and drew nothing" and "drew nothing because there is no hand" are the same absence on screen and
 * two different problems in the log.
 */
export function startChargeEffect(body: Model): void {
	// **The map first, before the hand is looked for**, because this is called on every frame of a hold: a body
	// already wearing one costs a lookup rather than three child searches. The order is the same thing
	// `mountEffect` checks on the other side, one line earlier than the work it saves.
	if (playing.has(body)) return;

	const hand = handOf(body);
	if (hand === undefined) {
		if (DEBUG) print(`[VFX] ${body.Name}: charge effect wanted, but no hand to put it on`);

		return;
	}

	if (!mountEffect(body, hand, TEMPLATE_NAME, playing)) return;

	// **One line per edge, and the hand is on it** — because the hand is the decision this file makes that a
	// person cannot check from the game: an effect that plays on the wrong arm is exactly "the hand is not the
	// one the animation throws from", and a line naming the part is what turns that from a guess into a report.
	if (DEBUG) print(`[VFX] ${body.Name}: charge effect on ${hand.Name}`);
}

/**
 * Clones `templateName`, welds it to `hand`, and turns every emitter in it **on** — the whole of what "a looping
 * effect on a part" is, written once for the two loops this module now runs.
 *
 * **Two callers, and they differ in three things: the template, the table, and whether there is a log line.**
 * That is the whole of the difference between the hand's charge and the fire ball that overlays it, and two
 * copies of the forty lines below would be two places for a fix to the flags, the weld or the emitter handling to
 * go missing — which is the reason the effect modules already argue about at length for their own walks.
 *
 * **Where the walk stops:** at the template. `findTemplate`, `carrierOf`, `templateParts` and `templateEmitters`
 * are this file's, and the three sibling effect modules each carry their own copy of the same four — a
 * duplication that predates this task and is deliberately not tidied here. `findTemplate` through
 * `templateEmitters` is the extraction candidate the day a fourth effect arrives.
 *
 * **Returns whether *this call* mounted one**, so the caller can print on the edge rather than on every call:
 * `false` means the body was already wearing one — see {@link playing}, where a duplicate call is a no-op rather
 * than a second clone — or that the template or the parts were not there. The failure prints are made in here,
 * where the reason is known; the caller's line is only for a mount that actually happened.
 */
function mountEffect(body: Model, hand: BasePart, templateName: string, mounted: Map<Model, Instance>): boolean {
	if (mounted.has(body)) return false;

	const template = findTemplate(templateName);
	if (template === undefined) {
		if (!warnedTemplates.has(templateName)) {
			warnedTemplates.add(templateName);
			warn(`[VFX] no ${templateName} in ReplicatedStorage — that effect will not play`);

			// **And then what it can see**, because "no template" is the half of the answer nobody can act on:
			// not there, and there under another name in another container, look identical from one line.
			for (const line of nearMissReport()) warn(`[VFX] ${line}`);
		}

		if (DEBUG) print(`[VFX] ${body.Name}: no ${templateName} template to clone`);
		return false;
	}

	const clone = template.Clone();

	// **Every part, walked rather than named, and the same seven flags the catch and hit effects set.** They are
	// copied deliberately — see `catchShockwave.ts` for the argument in full — and the one that is a *bug* rather
	// than a look is `Massless`: a welded part contributes its mass to the body's assembly, so without it the
	// thrower is heavier for as long as a charge is held, which is a change in how the game feels caused by a
	// part nobody can see. `Transparency` and `CastShadow` are here because the carrier is not the effect — the
	// emitter inside it is — and a template that arrives with the default opaque part would put a grey box on a
	// hand for the whole of a hold.
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
	const anchor = declared ?? first;
	if (anchor === undefined) {
		if (DEBUG) print(`[VFX] ${body.Name}: the ${templateName} template has no parts to weld`);
		return false;
	}

	clone.Parent = Workspace;

	// **And it is put *on* the hand before it is welded there, which is the catch effect's own correction.**
	// A `WeldConstraint` holds the offset two parts *already have* at the moment it is made — it does not pull
	// one onto the other — so a clone straight out of `ReplicatedStorage` would be welded to the hand at
	// whatever distance the template happens to sit from the world origin and then carried around at that
	// distance. That is exactly what the catch effect did before this line existed there: bursts scattered
	// across the arena, none of them where the event was.
	anchor.CFrame = hand.CFrame;

	// Parented to the clone, so the weld dies with the thing it holds and no cleanup is anybody's job.
	const weld = new Instance("WeldConstraint");
	weld.Part0 = hand;
	weld.Part1 = anchor;
	weld.Parent = anchor;

	// **By class, and every one of them** — a template with two emitters is a person having a second idea about
	// the shape, and turning one of them on would be this code choosing which idea was better.
	const emitters = templateEmitters(clone);

	// **Described once, before the `Enabled` handling below touches anything**, so what is reported is what the
	// template holds rather than what this file just did to it. `Rate` and `Lifetime` decide whether anything
	// is emitted, `Size` and `Transparency` whether it can be seen — none of it visible from code, all of it one
	// print. See `describeEmitter`.
	if (DEBUG && !describedTemplates.has(templateName)) {
		describedTemplates.add(templateName);

		if (emitters.isEmpty()) {
			print(`[VFX] the ${templateName} template holds no ParticleEmitter — there is nothing to loop`);
		}

		for (const emitter of emitters) print(`[VFX] emitter ${emitter.Name}: ${describeEmitter(emitter)}`);
	}

	// **`LockedToPart`, so the particles ride the hand.** Unlocked, they are born *into the world* where they
	// were emitted: the hand keeps up with the body and they do not, so a charge held while walking would
	// leave its own effect behind it. Set on the clone rather than read from the template, so a template
	// authored either way behaves the same and the original is untouched.
	for (const emitter of emitters) emitter.LockedToPart = true;

	// **And every emitter is turned *on*, which is the deliberate difference from the catch, hit and wind burst
	// effects.**
	//
	// **This effect loops while the charge holds; the emitters stay `Enabled` rather than being fired with
	// `Emit` because the charge is a state, not an event.** A burst is one hit at one instant, which is what
	// `catchShockwave.ts` draws with `Emit(EMIT_COUNT)` and a `Debris` timer; a charge has no instant — it lasts
	// as long as a button is held or a rig's windup runs, which is a length of time nothing on this side knows.
	// So the emitters are left running and the *stop* is the event, which is why there is no `Debris` timer here
	// at all: the clone is destroyed by the code that knows the charge ended, not by a clock.
	//
	// Set unconditionally rather than only on emitters authored off, which is the opposite of the sibling
	// module's care with `Enabled`. There the doubt was whether an `Emit` on a disabled emitter is gated, and a
	// template's own `Rate` was left alone so a burst could not become a spray. Here the template is *meant* to
	// stream, so `Rate` is the author's and `Enabled = true` is simply what a loop is.
	for (const emitter of emitters) emitter.Enabled = true;

	mounted.set(body, clone);

	return true;
}

/**
 * Takes the effect down: **the charge ended, whichever way it ended.**
 *
 * **The reason is an argument rather than something this module works out**, and that is the honest shape for
 * the two callers: a player's charge is cleared from one `Fusion.Value` with no reason in it — the release and
 * the four cancellations all write `undefined` — so the player's line says so; a rig's attribute is cleared by
 * the behaviour that owned the windup, which prints *its* reason on the server (see `ThrowBehavior`), because
 * the attribute carries the charge and not a cause, and a second attribute holding a word would be a wire for a
 * log line.
 *
 * Safe to call for a body with nothing on it, so every path that can end a charge calls it unconditionally
 * rather than each having to know whether one ever started.
 */
export function stopChargeEffect(body: Model, reason: string): void {
	// **The fire ball first, and it prints nothing.** It is an overlay *on* the hand's charge, so the line below
	// already says that this body has stopped charging, and a second line about one of the two clones would be
	// three lines for one edge. `setFireBall`'s own off-line is for the other case entirely — a crossing *inside*
	// a live hold, where nothing else in the output would mention it.
	dropFireBall(body);

	const clone = playing.get(body);
	if (clone === undefined) return;

	playing.delete(body);

	// **Destroyed rather than switched off**, which is the loop's other half: `Enabled = false` would leave the
	// carrier on the hand with its particles fading, and a body that charges again would weld a second one beside
	// it. Particles already in the world finish on their own — destroying a carrier stops nothing in flight —
	// which is why there is no fade handle to wait on.
	clone.Destroy();

	if (DEBUG) print(`[VFX] ${body.Name}: charge effect off — ${reason}`);
}

/**
 * Everything the charge's two clones should be doing at this level, in one call — **the entry point for both
 * drivers, and the whole of the overlay rule.**
 *
 * **Called on every frame of a player's hold and once per rig attribute change**, so it has to be safe to call
 * with the answer that is already true: the hand's clone is mounted only if it is missing, the fire ball is
 * cloned and destroyed only on a *crossing*, and every path that changes nothing prints nothing. That is what
 * makes a per-frame call cost a map lookup, an attribute read and a comparison.
 *
 * **The two effects are driven by one number, which is the reason this function exists at all.** The hand's
 * charge does not care what the level is; the fire ball cares about nothing else. Splitting them into two entry
 * points would put the same "is this body charging, and how much" question to two callers, and the two roads in
 * (a player's `Fusion.Value`, a rig's attribute) would each have to answer it twice.
 */
function refreshChargeEffect(body: Model, level: number): void {
	startChargeEffect(body);
	setFireBall(body, level);
}

/**
 * Starts or ends the fire ball so that it is playing exactly when `level` is at or above
 * {@link FULL_CHARGE_THRESHOLD} — **the crossing, which is the only thing this effect reacts to.**
 *
 * **The fire ball is a second clone, not a replacement — above the threshold both play.** The user's rule is
 * *overlay*, and the two effects are authored to sit on top of one another: the hand's charge is the loop that
 * means "a hold is happening", and this one is the loop that means "it is nearly full", which is a second fact
 * rather than a louder version of the first. Replacing would also throw away the effect's own state on every
 * crossing, and `ChargeHand` is the thing that says a charge exists at all.
 *
 * **A crossing upward clones; a crossing downward destroys; a level that stays on one side does nothing.** In
 * particular the *first* frame of a hold is a level near zero and not a crossing, so a charge that starts below
 * the threshold does not blink a fire ball on and off — and a charge that begins *above* it cannot happen for a
 * player, while for a rig it is the ordinary case and is handled by the same line.
 */
function setFireBall(body: Model, level: number): void {
	const existing = fireBalls.get(body);

	if (level < FULL_CHARGE_THRESHOLD) {
		if (existing === undefined) return;

		dropFireBall(body);

		if (DEBUG) print(`[VFX] ${body.Name}: fire ball off — charge ${formatCharge(level)}`);
		return;
	}

	if (existing !== undefined) return;

	const hand = handOf(body);
	if (hand === undefined) {
		if (DEBUG) print(`[VFX] ${body.Name}: fire ball wanted, but no hand to put it on`);

		return;
	}

	if (!mountEffect(body, hand, FIRE_TEMPLATE_NAME, fireBalls)) return;

	if (DEBUG) print(`[VFX] ${body.Name}: fire ball on — charge ${formatCharge(level)}`);
}

/** Takes the fire ball down if there is one. **Silent**, because the two callers each print for themselves. */
function dropFireBall(body: Model): void {
	const clone = fireBalls.get(body);
	if (clone === undefined) return;

	fireBalls.delete(body);
	clone.Destroy();
}

/** A charge as it appears in a log line. Two decimals — the same shape the throw and the rigs print a hold in. */
function formatCharge(level: number): string {
	return string.format("%.2f", level);
}

/**
 * The hand a ball leaves from, or nothing — **`BallFactory.getRightHand`'s rule, read on this side.**
 *
 * Deliberately *not* yielding: this is called on the frame a charge begins, and a `WaitForChild` there would
 * either block the driver or return a hand a frame later, welding the effect to a body that has already moved.
 * A rig whose hand has not replicated is reported and skipped, and the rig's own attribute does not fire again
 * for it — which is the correct failure: a rig that cannot be found is a rig whose effect cannot be drawn, and
 * a line says so rather than a thread hanging.
 */
function handOf(body: Model): BasePart | undefined {
	const humanoid = body.FindFirstChildOfClass("Humanoid");
	const preferred = humanoid?.RigType === Enum.HumanoidRigType.R15 ? HAND_R15 : HAND_R6;

	for (const name of [preferred, preferred === HAND_R15 ? HAND_R6 : HAND_R15]) {
		const hand = body.FindFirstChild(name);
		if (hand !== undefined && hand.IsA("BasePart")) return hand;
	}

	return undefined;
}

/**
 * The template, found by name in `ReplicatedStorage` — **as a `Model`, a `BasePart`, or an emitter the name was
 * put on instead.**
 *
 * **A walk of `ReplicatedStorage` rather than a path**, for the reason `find.ts` gives at length: a template's
 * place in the tree is a thing a person moves, and the only contract is the name. The third shape is not a
 * guess — it is what the place file actually holds for the two sibling effects, where the name went on the
 * emitter and the carrier part under it went on being called `Part`. `carrierOf` resolves it upward.
 *
 * **Two classes, and this is the one place a class is not part of the question.** Everywhere else a lookup that
 * accepts "anything called this" is a bug waiting for a decoy; here the question is not *what* the template is
 * but *what it holds*, and whether a person wrapped it in a `Model` or left the part loose is packaging with no
 * behaviour attached to it. **Still not "anything by that name"**: a `Folder` or a `Sound` called `ChargeHand`
 * is not a template, and returning one would push the failure down to "no parts to weld", where it is harder
 * to read.
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
 * **Upward, and stopping at the first part rather than at the outermost container**, which is the sibling
 * module's rule and its reason: a `Model` above the carrier is a person tidying `ReplicatedStorage`, not a
 * second thing to place, and climbing further is how a lookup like this ends up cloning the world. The walk
 * passes *through* an `Attachment` without stopping at it — an attachment has no frame of its own in the world,
 * so the thing to clone is the part, and cloning it brings the attachment and the emitter along at the offset
 * the author gave them. **Stops at `ReplicatedStorage`**, so a template that is not below a part at all
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
 * **`GetDescendants` does not include the instance it was called on**, which is the hole this file would
 * otherwise fall into with the sibling module: a template that *is* the carrier part has no part among its
 * descendants at all, so the walk would yield nothing, the anchor would come out `undefined`, and the effect
 * would return without ever welding anything — silently, on the happy path.
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
 * Its own walk rather than the one `templateParts` does, because the two want different things from the same
 * tree and neither wants the other's answer: the parts walk starts at the clone when the clone is a part, and
 * the emitters are always strictly below it.
 */
function templateEmitters(clone: Instance): ParticleEmitter[] {
	const emitters: ParticleEmitter[] = [];
	for (const descendant of clone.GetDescendants()) {
		if (descendant.IsA("ParticleEmitter")) emitters.push(descendant);
	}

	return emitters;
}

/**
 * One emitter's authored state as a line of prose — **the properties that decide whether a running emitter
 * produces anything a person can see.**
 *
 * **`Rate` and `Lifetime` are the first pair, and for a looping effect `Rate` is the load-bearing one** — where
 * the burst effects only cared that a `Rate` of zero was normal, here a `Rate` of zero means the emitters are
 * on and emitting nothing, which is a template set up for `Emit` and asked to stream. `Lifetime` of zero is a
 * particle born dead. **`Size` and `Transparency` are the second**: a zero size or a fully transparent particle
 * is emitted, moves, expires and is never drawn, which from a seat in Studio looks exactly like an effect that
 * never ran. All four are visible in the template's properties panel; this is the same information, in the log,
 * next to the line that says the effect started.
 *
 * **`TimeScale` and `Brightness` are deliberately not here** — they change how it looks rather than whether it
 * exists, and a line that reports everything is a line nobody reads.
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

/** A `NumberSequence` as **its two ends** — `0.5→2` — because the middle is the shape and the ends are existence. */
function sequenceText(sequence: NumberSequence): string {
	const keys = sequence.Keypoints;
	if (keys.isEmpty()) return "empty";

	const first = keys[0].Value;
	const last = keys[keys.size() - 1].Value;

	return first === last ? `${first}` : `${first}→${last}`;
}

/** How many near-miss names `nearMissReport` lists before it stops looking. Enough to see the answer. */
const MAX_NEAR_MISSES = 8;

/**
 * What this client can see that might have been meant by the template name, as lines for the log.
 *
 * **The one thing a failed lookup cannot tell you is which failure it was.** "No `ChargeHand`" is true of a
 * template nobody made, one spelled `chargeHand`, one sitting under a folder — which the walk *would* have
 * found — and one dragged into `Workspace` by mistake, and one line reports all four. So this says what is
 * actually there, and it names the likelihood that matters most: **a template left in `ServerStorage` cannot be
 * found by any client at all**, because that service does not replicate, and a report that did not say so would
 * leave an operator concluding the code is blind.
 *
 * **Called once per session, from the missing-template branch**, which is the only thing that makes a walk this
 * wide acceptable.
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
		const [charged] = string.find(lower, "charge");
		const [hand] = string.find(lower, "hand");
		const [fire] = string.find(lower, "fire");
		if (charged === undefined && hand === undefined && fire === undefined) continue;

		matches.push(`${descendant.GetFullName()} (${descendant.ClassName})`);
		if (matches.size() >= MAX_NEAR_MISSES) break;
	}

	lines.push(
		matches.isEmpty()
			? "nothing anywhere in the client's view has 'charge', 'hand' or 'fire' in its name"
			: `close names: ${matches.join(", ")}`,
	);

	return lines;
}

/**
 * Starts every road into this module — **the one call the boot makes.**
 *
 * **Three drivers, and they are three because the facts arrive three different ways.** A player's *charge* is a
 * fact about this client (`chargeStartedAt`), so it is polled on the frame loop and the fire ball's threshold is
 * read off it. A player's *throw* is the server's, so it arrives as {@link THROW_ANIMATION_ATTRIBUTE} on the
 * character — a body the client replaces on every respawn. A rig's charge and a rig's throw both arrive as
 * attributes on a model that the `NPC` tag identifies, so they share one connection per rig.
 *
 * **Which models are rigs is `RigAnimationController`'s answer, deliberately reused rather than invented**: the
 * `NPC` tag is the codebase's answer to that question (`NpcService`, `OutlineService`, `BallSpawnerService` and
 * `BallPickupService` all ask it), a tag walk plus the added/removed signals is how that controller finds them,
 * and the removed signal is the cleanup for a rig that respawns into a new body or leaves the world.
 *
 * **Why a plain module started by hand rather than a controller.** It owns no lifecycle and no injected service:
 * it watches one `Value`, one attribute and a tag, and draws. The only things Flamework loads from this client
 * are `src/client/controllers`, so a module with subscriptions and no controller around it is wired from
 * `main.client.ts` — the same arrangement `hitVfx` and `hitConfirm` are in.
 */
export function startChargeEffects(): void {
	// **The body the local effect is on, remembered rather than re-read.** A charge can outlive the lookups that
	// would find it: the release handler fires between two frames and the character can change under it, so the
	// teardown has to name the *same* body the effect was started on rather than asking `Players.LocalPlayer`
	// again and coming back with a character that never charged.
	let localBody: Model | undefined;

	/**
	 * **A frame loop rather than an observer, and the threshold is the whole reason.** `chargeStartedAt` is a
	 * `Fusion.Value` with two edges — a hold began, a hold ended — and the fire ball cares about neither: its
	 * question is "has this hold passed `FULL_CHARGE_THRESHOLD`", which is a fact about *elapsed time inside a
	 * hold* and therefore has no edge to observe. The level is the same division
	 * `ThrowController.currentCharge` makes, asked here because a reader of a charge cannot be told about a
	 * crossing that is not an event.
	 *
	 * **What it costs is one peek per frame while nothing is charged** — the early return below — and, while a
	 * hold is live, one subtraction, one division, a map lookup and a comparison. The alternative shapes are all
	 * worse: an observer with a `task.delay` armed inside it is this loop wearing more state and a timer to get
	 * wrong, and reacting to the ball's own animation would be a round trip late for something this client
	 * already knows outright.
	 */
	RunService.Heartbeat.Connect(() => {
		const began = Fusion.peek(chargeStartedAt);
		const character = Players.LocalPlayer.Character;

		if (began === undefined || character === undefined) {
			// **The player's reason is one phrase for five paths, and that is the state rather than a shortcut.**
			// The charge is a single `Fusion.Value` with no reason in it — the release, the focus loss, the ball
			// leaving the hand (which is the death, drop and round-boundary path) and the `E` cancel all write
			// `undefined` — and a reason would be a second value kept in step with the first, which is exactly
			// what `throwing.ts` argues against. So the line says what is true: the charge ended, and this module
			// cannot see how. **A duck does not end a charge**, deliberately: the stance refuses the *throw* in
			// `BallService.throwBall` and leaves the hold standing, so a charging player who ducks is still
			// charging and this line is not reached.
			if (localBody !== undefined) stopChargeEffect(localBody, "the charge ended (thrown or cancelled)");
			localBody = undefined;

			return;
		}

		localBody = character;

		// **Written on every frame of the hold, so the last write is the drawn charge at the release** — the
		// value the throw that follows is judged by. See {@link lastCharge}.
		const level = chargeLevel(began);
		lastCharge.set(character, level);

		refreshChargeEffect(character, level);
	});

	/**
	 * **The wind burst's road for a player, and it is not the charge's road.** A gust belongs to the moment the
	 * ball *left*, which the charge's own two edges cannot tell apart from a cancellation — a release and an `E`
	 * cancel are the same write to the same value, and a burst on a hold that was thrown away would be wind for
	 * nothing. So this watches {@link THROW_ANIMATION_ATTRIBUTE}, the one fact the server publishes that means "a
	 * throw happened", for every body that can throw. See {@link watchThrows}.
	 *
	 * **Per body rather than once**, because the local character is replaced on every respawn: the connection is
	 * made for the body that exists and again for each one that arrives, and the old ones die with the models they
	 * were made on.
	 */
	const character = Players.LocalPlayer.Character;
	if (character !== undefined) watchThrows(character);

	Players.LocalPlayer.CharacterAdded.Connect((arrived) => watchThrows(arrived));

	// **The rigs already here**, because the added-signal will never fire for them again — a client mounting into
	// a running server has rigs standing in front of it whose tags arrived with the place.
	for (const instance of CollectionService.GetTagged(NPC_TAG)) {
		if (instance.IsA("Model")) watchRig(instance);
	}

	CollectionService.GetInstanceAddedSignal(NPC_TAG).Connect((instance) => {
		if (instance.IsA("Model")) watchRig(instance);
	});

	// **A rig that loses the tag is forgotten, and that is the respawn path as much as the retirement path.**
	// `RespawnBehavior` builds a replacement body and puts every tag back on it, so the corpse stops being a rig
	// and the new body starts being one — and a corpse wearing a charge effect would be a body with nobody's
	// windup on it.
	CollectionService.GetInstanceRemovedSignal(NPC_TAG).Connect((instance) => {
		if (instance.IsA("Model")) forgetRig(instance);
	});
}

/**
 * Watches one rig's published charge state: **the connection, and the first read.**
 *
 * **Both signals are `RigAnimationController`'s, for that file's reasons.** `AttributeChanged` answers "did the
 * windup start or end" — up to five attributes move for one logical transition and every one of them is a
 * header-free re-read here, so the read is a comparison and nothing else. `AncestryChanged` is the cleanup, and
 * it is asked of the model rather than of its parent: a rig destroyed outright, a rig whose ancestor was
 * destroyed and a rig taken back out of `Workspace` are the three ways a rig stops being something to draw on,
 * and `IsDescendantOf(Workspace)` is the same test the animator's own connection makes.
 *
 * The first read matters for the same reason the initial tag walk does: a rig that was already winding up when
 * this client arrived has an attribute set before the connection existed, and a rig standing still will not
 * write it again.
 */
function watchRig(model: Model): void {
	if (watched.has(model)) return;

	const connections: RBXScriptConnection[] = [];
	connections.push(
		model.AttributeChanged.Connect(() => {
			readCharging(model);

			// **The same signal carries the throw, so the gust costs one more compare on a connection that
			// already exists** rather than a second subscription per rig. Two facts about one body happen to
			// arrive through one signal, and this is where both are read.
			noteThrowMark(model);
		}),
	);
	connections.push(
		model.AncestryChanged.Connect(() => {
			if (!model.IsDescendantOf(Workspace)) forgetRig(model);
		}),
	);

	watched.set(model, connections);
	readCharging(model);
	seedThrowMark(model);
}

/** Drops a rig: the connections, the record, and any effect it was wearing. */
function forgetRig(model: Model): void {
	const connections = watched.get(model);
	if (connections === undefined) return;

	watched.delete(model);

	for (const connection of connections) connection.Disconnect();

	// **The effect goes with the rig**, and the reason is stated because a stale clone is the one failure this
	// file could leave behind invisibly: a rig that respawns, or is destroyed mid-windup, would otherwise leave a
	// looping effect welded to a hand nobody will ever clear, because the attribute that would have cleared it
	// died with the body.
	stopChargeEffect(model, "the rig stopped being one");
}

/**
 * One rig's charging state, read and acted on — **the whole of the rig half's decision.**
 *
 * **The attribute carries the charge itself rather than a flag, and that is a reversal of the previous task's
 * choice, recorded rather than tidied away.** A boolean was the right answer while the only question was "is a
 * charge being held", and it stopped being one the moment the fire ball needed to know *how much*: a threshold
 * cannot be asked of a flag. The number was already in the server's hand at the instant it wrote, so publishing
 * it costs nothing and removes any need for a second attribute carrying the same event twice; see
 * {@link CHARGING_ATTRIBUTE}, where the reversal is written out.
 *
 * **A number is validated; an absence is not.** `undefined` is the ordinary third state — the windup ended — and
 * a value that is neither a number nor absent is something else's write rather than a charge, answered the same
 * way a cleared one is: nothing is drawn for it.
 */
function readCharging(model: Model): void {
	const value = model.GetAttribute(CHARGING_ATTRIBUTE);

	if (typeIs(value, "number")) {
		// **Remembered as well as acted on** — this is the value the throw that follows will be judged by, and
		// the attribute is cleared before that throw replicates. See {@link lastCharge}.
		lastCharge.set(model, value);

		refreshChargeEffect(model, value);
		return;
	}

	// Named for what this side can honestly see: the windup ended. **Why** it ended is the server's, and the
	// server prints it — see `ThrowBehavior`, which is the only thing that knows whether the ball was thrown or
	// the target was lost.
	stopChargeEffect(model, "the windup ended");
}

/**
 * A hold's level at this instant, from the instant it began — **the same division `ThrowController.currentCharge`
 * makes, made on this side of the wire.**
 *
 * **Duplicated rather than asked for, and there is nothing to ask.** `currentCharge` is a private method of a
 * Flamework controller, and the alternative — publishing a `Fusion.Value` of the level out of that controller —
 * would be a second home for a value that is already derivable from `chargeStartedAt` and one constant. The
 * division *is* the definition of the charge rather than an implementation of it, so two readers of the same two
 * numbers cannot disagree: `BALL_CONFIG.CHARGE_SECONDS` is the clock, and `chargeStartedAt` is `os.clock` on
 * this machine.
 *
 * **Clamped, exactly as the controller clamps it**, so a hold taken past full is a full charge here too and a
 * fire ball cannot be knocked out by an over-long hold.
 */
function chargeLevel(began: number): number {
	return math.clamp((os.clock() - began) / BALL_CONFIG.CHARGE_SECONDS, 0, 1);
}

/**
 * Plays the wind burst on `body` the moment it throws — **one connection on one attribute, for any body.**
 *
 * **`THROW_ANIMATION_ATTRIBUTE` is the fact this hangs off, and choosing it over the charge is the whole of the
 * design.** A charge's own edges cannot tell a release from a cancellation — a player's release and a player's
 * `E` cancel are the same write to the same `Fusion.Value`, and a rig's windup clears its attribute on a lost
 * target exactly as it does on a throw — so a gust driven off the charge would blow for throws that never
 * happened. This attribute is written by `BallService` at the release **for every body that throws**, which the
 * constants file states in as many words, so one rule covers a player's character and a rig with no per-caller
 * flag anywhere.
 *
 * **What it costs is a round trip, and it is stated rather than discovered.** The burst plays when the server's
 * mark replicates rather than on the frame the throw left the hand, which is the price of asking the machine that
 * decides a throw happened instead of predicting it. It is the only thing about this effect a person watching
 * closely is likely to notice.
 *
 * **Made per body, and that is why this is a function rather than a line**: a player's character is replaced on
 * every respawn, so the rigs' single connection per model has no counterpart here — see `startChargeEffects` for
 * the two places this is called from.
 *
 * **The read is inside {@link noteThrowMark} rather than here, and both roads go through it** so that the edge
 * record cannot be skipped by one of the two. See that function for what its absence cost.
 */
function watchThrows(body: Model): void {
	seedThrowMark(body);
	body.AttributeChanged.Connect(() => noteThrowMark(body));
}

/**
 * Fires the gust when a body's throw mark *becomes* `true` **and the throw was a full-power one** — the whole of
 * the rule, in one place for both roads into this module.
 *
 * ## The edge, and the four gusts it fixed
 *
 * **The record is a fix, and it is worth being exact about what it was fixing.** `AttributeChanged` is the
 * signal this hangs off for the reason {@link watchRig} gives, and it fires for **every** attribute the body
 * writes — a rig moves through speed bands, a grounded flag, a frozen flag, its own charge, several times a
 * second. Testing the mark's *value* on each of those is a test of "is a throw still being animated" rather than
 * "did a throw just happen", and because the mark lasts `THROW_ANIMATION_SECONDS` the answer is `true` for the
 * whole of it. Observed in the log: **one throw produced four gusts**, two of them in the same frame, the last a
 * third of a second after the ball had gone.
 *
 * ## The charge, and the two reports it took
 *
 * **The gust is a full-power effect, gated on the same {@link FULL_CHARGE_THRESHOLD} as the fire ball.** The
 * first version played on every release at any charge — this file's reading of the brief's *"plays on release, on
 * every body that throws"* — and the user reported it twice, the second time with a log where every gust sat on
 * a throw between `0.00` and `0.65`, before it was taken as the rule rather than as a fault. A throw below the
 * threshold now produces no gust at all.
 *
 * **The charge is not on this line because it is already on the line beside it**: a rig's
 * `[Rig] … throw — charge 0.61 at …` and a player's `[Throw] released at charge 1.00`. Nothing here has to
 * restate a number the log has already given, and the absence of a gust is the readable half anyway.
 *
 * **It cannot be read off the body, which is why {@link lastCharge} exists** — the charge is cleared at the
 * release and the mark arrives a round trip later.
 */
function noteThrowMark(body: Model): void {
	const marked = body.GetAttribute(THROW_ANIMATION_ATTRIBUTE) === true;
	if (marked === (throwSeen.get(body) ?? false)) return;

	throwSeen.set(body, marked);

	if (!marked) return;

	// **A missing charge reads as zero, which is the safe direction**: a throw this client never watched charge —
	// a body it began watching mid-flight — gets no gust rather than an unearned one.
	if ((lastCharge.get(body) ?? 0) < FULL_CHARGE_THRESHOLD) return;

	playWindBurst(body);
}

/**
 * Records the mark's value **without playing anything**, so the first write after a body starts being watched is
 * judged against what was already true.
 *
 * **The case it covers is a client that arrives mid-throw.** A rig's mark lasts `THROW_ANIMATION_SECONDS`, and a
 * client mounting into a running server can look at a rig whose mark is already set; without this, the record
 * would read `false`, and the *next* attribute write on that body — a speed band, a charge, anything — would fire
 * a gust for a ball that left before this client could see one. Seeding makes the road into a body identical to
 * the road into an effect: the first answer is the state, and only a change from it is news.
 */
function seedThrowMark(body: Model): void {
	throwSeen.set(body, body.GetAttribute(THROW_ANIMATION_ATTRIBUTE) === true);
}
