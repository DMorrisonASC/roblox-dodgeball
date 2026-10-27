import { Debris, ReplicatedStorage, Workspace } from "@rbxts/services";
import { findTemplate } from "shared/find";
import { SPAWN_POOF_CONFIG } from "shared/config/spawnPoof.config";
import { DEBUG_LOGGING, logDebug, logInfo, logWarn } from "shared/logger";

/**
 * The name of the authored effect template, and **the whole of the contract with the place file**.
 *
 * **A name and nothing else**, which is `HANDOFF.md` §17 and `shared/find.ts`'s rule: the template is found by
 * walking `ReplicatedStorage` for a `Model` or a `BasePart` with this name, so whether somebody wraps it in a
 * `VFX` folder, an `Effects` folder or nothing at all is not a fact this file may depend on. The same lookup,
 * by the same helper, as `PierceTrail` in `BallService` and `FreezeSplash` in `FreezeService`.
 *
 * **The template this was written for is `BasePart > Attachment > ParticleEmitter`**, which is the shape
 * `findTemplate` resolves a name placed on any of the three levels to: the named part, or the part that carries
 * a named attachment or emitter. Nothing here needs to know which level was named.
 */
const TEMPLATE_NAME = "SpawnPoof";

/**
 * How many particles one poof delivers. **Placeholder — 50.**
 *
 * **The count is delivered by `Rate`, not by `Emit`, and the log that asked for this is the reason.** `Emit` is
 * a call into *one* simulation. The server has none — it has no renderer — so the particles it creates are born
 * and expire where nobody can see them, and each client only ever simulates what the replicated *properties*
 * tell it to. `Rate` is one of those properties, so the burst has to be described by it; see the emit loop.
 *
 * **The formula is `Rate × window`, and nothing else**: the rate is this count divided by the fixed
 * {@link BURST_WINDOW_SECONDS}, which keeps "how big is a poof" and "how long does it take to fire" two
 * independent questions. Dividing by the template's own `Lifetime` instead — the shape this replaced — made a
 * short-lived template fire its whole burst in a flash.
 *
 * Fifty is enough for a burst to read as one event from across the arena and few enough that sixteen bodies in a
 * lobby do not become a fog.
 */
const EMIT_COUNT = 50;

/**
 * How long the emitter is allowed to run, in seconds. **Placeholder — 0.25.**
 *
 * **A fixed window rather than the template's own `Lifetime`, and that is the difference between a poof and a
 * flash.** The count is delivered by `Rate`, so the emitter has to be running for *some* time to deliver it.
 * Taking that time from the particle lifetime couples two unrelated questions: a template authored at a tenth of
 * a second would fire its whole burst in a tenth of a second and be over before anybody read it, and one
 * authored at three seconds would trickle. A quarter of a second keeps the rate sane — a fifth of a second would
 * need a rate of 250 for the same count — while still reading as one event rather than a spray.
 *
 * **What the particles do afterwards is the template's business.** They live for whatever `Lifetime` its author
 * set, independently of this window, and the clone is kept for {@link EFFECT_LIFETIME} so there is always time
 * for them to play out.
 */
const BURST_WINDOW_SECONDS = 0.25;

/**
 * **Where on a body the burst is centred: the chest, and the fallbacks in the order a body should be asked.**
 *
 * **This replaced a fixed offset below the root, because that offset put the effect in the floor.** The old
 * placement was `root.CFrame` minus two and a half studs — which its own doc called "below the chest for an R15
 * humanoid and just above the ground", and which is exactly right for the *reason* it was written (a burst
 * centred on a root starts inside the torso) and exactly wrong for what it produced: a five-by-five particle
 * burst whose lower half is inside the terrain. What a player sees is a hemisphere, or a puff cut off along a
 * straight line where the floor is, and the report was that the effect "gets cut off at the bottom". A height
 * tuned against a *root* cannot be right for an R6 rig, an R15 character and a custom model at once, because
 * the distance from root to floor differs between them; the torso does not have that problem, because the torso
 * is a part rather than an arithmetic assumption.
 *
 * **`UpperTorso` then `LowerTorso` then `Torso`, and the order is the rig type.** An R15 body has the first two
 * and no `Torso` at all; an R6 body — which includes most of this project's rig pool — has only `Torso`. Upper
 * before lower when both exist, because the chest is where a person reads a burst as coming from: `LowerTorso`
 * is the belly, and it is also the part nearest the floor that this could still pick by mistake if the order
 * were reversed.
 *
 * **`HumanoidRootPart` and then `PrimaryPart` are the fallbacks, and both are real rather than defensive.** A
 * rig whose joints are broken, a custom model with a `Humanoid` and no R6/R15 torso names, and a toolbox model
 * scaled into something that is not a person at all all reach this function: the root is where the body *is*, so
 * a burst at the waist of an unrecognisable body is the honest failure, and it is what every body in the game
 * got before this change. `PrimaryPart` covers the shape `NpcService.spawn` writes (it sets the root as the
 * primary part) and a model authored with one and nothing else.
 *
 * **Nothing throws and nothing is assumed about names.** `FindFirstChild` rather than a path, one `IsA` per
 * candidate, and `undefined` when the model has none of them — a body with no parts at all is a body this
 * function does not place an effect on, which the caller turns into no poof rather than an error in the middle of
 * a round boundary.
 *
 * **The torso's own `CFrame` rather than a world-space offset from it.** Rotation is carried over, which is what
 * the old root-based placement did as well: a `HumanoidRootPart` is held upright by its humanoid, so both are
 * upright for any living body, and the one case they differ on — a ragdolled corpse — is a case where an effect
 * that tilts with the body is the truthful one.
 */
function anchorOf(model: Model): BasePart | undefined {
	for (const name of ["UpperTorso", "LowerTorso", "Torso"]) {
		const part = model.FindFirstChild(name);
		if (part !== undefined && part.IsA("BasePart")) return part;
	}

	const root = model.FindFirstChild("HumanoidRootPart");
	if (root !== undefined && root.IsA("BasePart")) return root;

	return model.PrimaryPart;
}

/**
 * How long a clone is left in the world before `Debris` takes it, in seconds. **Placeholder — 2.**
 *
 * **Long enough for the emitter's whole burst, short enough that a boundary does not leave a cloud behind.**
 * The burst is emitted in the frame this runs, so this is the window the particles have to play out rather than
 * the effect's timing: the particles themselves live for whatever the template authored them to, and two
 * seconds is past any plausible one-shot while being short enough that sixteen bodies at a boundary do not
 * leave a haze in the lobby. It is the number to raise if a template with a long tail is being cut off, and the
 * one to lower if the arena is left foggy.
 */
const EFFECT_LIFETIME = 2;

/**
 * Whether the missing-template warning has been said already.
 *
 * **Once per server, not once per body.** A boundary moves every player and every rig, so a warning per body
 * would be thirty-two identical lines and no more information than the first. `BallService` keeps a `Set` for
 * this because it looks for more than one name; this file looks for exactly one, so a boolean says the same
 * thing.
 */
let templateWarned = false;

/**
 * **The reasons a body was refused, already reported — so a skip says so once rather than twice a round.**
 *
 * **This exists because the two refusals below used to `return` silently, and that silence is the exact fault
 * this whole file is written against.** "The poof did not play for a joining player" is three different faults
 * with one symptom: the effect was never asked for, the effect was asked for on a body that has nothing to
 * anchor to, or the effect played and nobody was looking at it. The first two now name themselves here; the
 * third is what `DEBUG_SHOW_PART` and the first-burst line below are for. A per-body warning would be a
 * boundary's worth of duplicate lines, so each reason is said once and the count is not kept — the reader has
 * the reason and the body that produced it, which is what a fix needs.
 */
const reportedRefusals = new Set<string>();

/**
 * Whether the first successful burst has been reported.
 *
 * **One line per server, and it is deliberately not behind `DEBUG_LOGGING`.** The line names the body, the **part** the
 * burst was anchored to and the position it landed at, which is what separates "no poof" from "a poof two
 * hundred studs from where anybody was standing" — and it costs one `print` in the life of the server, so there
 * is no reason to make somebody edit a constant to find out whether the effect works at all.
 */
let firstBurstReported = false;

/** Says `message` once for `key`, so a fault repeated per body is one line. */
function reportRefusalOnce(key: string, message: string): void {
	if (reportedRefusals.has(key)) return;

	reportedRefusals.add(key);
	logWarn(message);
}

/**
 * **The one poof: a burst left standing where a body was, played wherever a body appears, disappears or is moved
 * without walking.**
 *
 * **One function for every trigger, because they are one event seen from different sides.** A player joining, a
 * player leaving, a rig standing down for them, a rig taking their seat, a round boundary teleporting everybody,
 * a late rig snapped onto its arena spawn and a body respawning after a death are seven causes and one visible
 * fact — *a body was not there and now it is, or it was and now it is not*. Every call site says only which
 * body; this file says what that looks like. The triggers themselves live where the body changes, never here.
 *
 * **A player's character and an NPC rig are the same argument.** Both are a `Model` with a `Humanoid` and a
 * `HumanoidRootPart` — a player's body and an `NpcService` rig — so there is no `Player` in this file at all and
 * nothing to branch on. That is what lets `RoundService` (characters and rigs), `LobbyRigService` (rigs and a
 * leaving character) and `RespawnService` (characters) all call it without converting anything first.
 *
 * **It is anchored where the body was standing and deliberately *not* welded to it.** A weld makes an effect
 * follow a part, and following is the one thing this must not do: every caller that matters is about to move the
 * body — a `PivotTo` at a boundary, a rig snapped onto its arena spawn — so a welded clone would be dragged to
 * the destination and emit *there*, leaving the origin empty. **The origin is the whole point of the effect.**
 * An anchored clone stays at the position it was given, fires its burst, is not simulated, cannot be walked
 * into, and is taken by `Debris`.
 *
 * **The burst is delivered by `Rate` rather than by `Emit`, and the clone's rate is rewritten for it.** A
 * template's own rate is one particle every so many seconds — far too slow to read as an event — and `Emit` never
 * reaches a client's simulation at all. So the rate is set from a fixed window and the emitter is switched off
 * when it ends; see {@link EMIT_COUNT} and {@link BURST_WINDOW_SECONDS}.
 *
 * **The template is not trusted, and that is a rule rather than a preference.** Every visual and physical
 * property below is forced on the clone, because the failure mode of trusting the place file is a solid white
 * block standing where a player vanished. See the block in the body for what each override is protecting.
 *
 * **No player is asked about, and nothing is stored.** The clone is a child of `Workspace` owned by `Debris`;
 * this function holds no reference to the body after it reads the root, so a body destroyed in the same frame
 * — a rig standing down, a character leaving — leaves a burst that is already in the world and already
 * scheduled to clean itself up.
 */
export function playSpawnPoof(model: Model | undefined, fallbackAt?: CFrame): void {
	if (!SPAWN_POOF_CONFIG.ENABLED) return;

	// **The anchor, and the one caller that has to survive a body already being taken away.**
	//
	// `LobbyRigService.onPlayerLeft` poofs a leaving player, and `PlayerRemoving` is the one signal where the
	// engine is already dismantling the body: the model can arrive here already out of the world, or in the
	// world with its parts gone. Either way there is no torso to read, and the old version of this function
	// returned in silence — which is why a join poofed and a departure did not, for a caller that is provably
	// reached. A caller that watched the body while it existed can hand its **last position** in as
	// `fallbackAt`; every other caller passes nothing and keeps the refusal warnings below, which is the right
	// answer for a body that was never anywhere.
	//
	// **`fallbackAt` is a position and not a part**, deliberately: by the time it is needed the part is what is
	// missing, and a `CFrame` cannot be destroyed out from under the caller between the read and the call.
	//
	// **`model` itself may be nothing, for the same reason**, and that is the departure case in full: by
	// `PlayerRemoving` a player can have no character at all. A caller in that position has only a position to
	// offer, so the body is optional here and the label below is what the log lines name instead.
	const label = model === undefined ? "a body that has already gone" : model.Name;

	let anchor: BasePart | undefined;
	let at: CFrame | undefined;

	if (model === undefined || model.Parent === undefined) {
		if (fallbackAt === undefined) {
			reportRefusalOnce(
				"outside the world",
				`[VFX] ${TEMPLATE_NAME} skipped for ${label} — there is no body in the world to stand it on, ` +
					`and the caller passed no last-known position. Said once; see the caller.`,
			);

			return;
		}

		at = fallbackAt;
	} else {
		// **A body with nothing to stand the effect on gets no effect**, and this guard is before the template
		// lookup so that a body whose parts have not arrived yet costs one walk and no clone. `anchorOf` answers
		// with the chest when there is one and the root or primary part when there is not — see its doc for the
		// order and for why the chest replaced a fixed offset from the root.
		anchor = anchorOf(model);

		if (anchor !== undefined) {
			at = anchor.CFrame;
		} else if (fallbackAt !== undefined) {
			at = fallbackAt;
		} else {
			reportRefusalOnce(
				"nothing to anchor to",
				`[VFX] ${TEMPLATE_NAME} skipped for ${label} — it has no upper torso, torso, ` +
					`HumanoidRootPart or PrimaryPart, so the burst has nowhere to sit. Said once; a player's ` +
					`body whose parts have not arrived yet reaches this line.`,
			);

			return;
		}
	}

	const template = findTemplate(ReplicatedStorage, TEMPLATE_NAME);

	// **Said once, with everything needed to fix it.** A missing name, a misspelt name and a template never
	// published are three different fixes and one indistinguishable symptom, so the line lists what
	// `ReplicatedStorage` actually holds. Nothing else happens: a body with no poof still appears, and every
	// other effect and rule in the game is untouched.
	if (template === undefined) {
		if (!templateWarned) {
			templateWarned = true;

			logWarn(`[VFX] no ${TEMPLATE_NAME} in ReplicatedStorage — bodies will appear and vanish without a poof`);

			const top: string[] = [];
			for (const child of ReplicatedStorage.GetChildren()) top.push(`${child.Name} (${child.ClassName})`);

			logWarn(
				`[VFX] ReplicatedStorage holds: ${top.isEmpty() ? "nothing" : top.join(", ")} — ` +
					`a poof template is a Model or a BasePart named ${TEMPLATE_NAME}, ` +
					`and it is found by name wherever it sits.`,
			);
		}

		return;
	}

	const effect = template.Clone();
	const parts = partsOf(effect);

	// A template with no part in it has nowhere to stand the effect, and cloning one per boundary only to throw it
	// away is a leak with a warning attached.
	if (parts.isEmpty()) {
		if (!templateWarned) {
			templateWarned = true;

			logWarn(
				`[VFX] ${TEMPLATE_NAME} holds no BasePart — bodies will appear and vanish without a poof. ` +
					"The clone is placed by its part.",
			);
		}

		effect.Destroy();

		return;
	}

	for (const part of parts) {
		// **Invisible, because a carrier is not a picture.** The template is a `BasePart` carrying an
		// `Attachment` and a `ParticleEmitter`; if its author left it opaque, the effect is a white block on the
		// body and the burst inside it is hidden behind its own carrier. `Transparency` is not one of the three
		// flags below — they govern interaction, not drawing — which is why it is forced separately here.
		//
		// **`DEBUG_SHOW_PART` replaces that with a red neon cube, and it is the bisect for a report of "I see
		// nothing".** A drawn marker answers the question the log cannot: whether the clone is anywhere near the
		// player at the moment they are looking. See that switch's doc — the cube is four studs on every axis
		// rather than the template's own size, because a marker has to be visible from across a lobby and the
		// template may be authored at any size at all.
		if (SPAWN_POOF_CONFIG.DEBUG_SHOW_PART) {
			part.Transparency = 0.3;
			part.Material = Enum.Material.Neon;
			part.Color = new Color3(1, 0, 0);
			part.Size = new Vector3(5, 5, 5);
		} else {
			part.Transparency = 1;
		}

		// **Anchored, so the burst stays where the body was.** This is the property that makes the effect an
		// origin rather than a passenger: the body is moved by the caller on the next line or the next frame, and
		// an unanchored clone — welded or not — would go with it or fall out of the sky. An anchored part is not
		// simulated at all, which is also what keeps it out of the body's physics: there is no assembly to join,
		// so plenty of the flags below stop mattering for gameplay and start mattering for queries.
		part.Anchored = true;

		// **Massless is kept even though an anchored part is not simulated**, so that the same template run
		// through a future caller that wants a moving copy behaves the same way. It costs nothing here.
		part.Massless = true;

		// **And no interaction of any kind**, for `FreezeService.buildBurst`'s reason: this must not be something
		// a ball can hit, a touch can fire on, or the aim guide's ray can stop against.
		part.CanCollide = false;
		part.CanTouch = false;
		part.CanQuery = false;

		// **At the chest, which is where the burst belongs and where it stops being cut in half by the floor.**
		// The anchor is the body's own torso when it has one — see {@link anchorOf} for the order and for the
		// offset-from-the-root placement this replaced — so the effect is centred on the part a person reads as
		// "the body", at whatever height that part happens to be for the rig type in front of us. A world-space
		// offset was the old answer and it could not be right for an R6 rig, an R15 character and a custom model
		// at once, because the distance from a root to the floor differs between them.
		part.CFrame = at;
	}

	// **Parented to `Workspace` rather than to the body**, which is what lets the burst outlive the body: a rig
	// standing down and a character leaving both destroy the model in the same frame as this call, and a child of
	// that model would go with it before the particles had been drawn once.
	effect.Parent = Workspace;

	// **The burst is carried by `Rate` over a fixed window, and both halves of that were learned the hard way.**
	// `Emit` is a call into one simulation: the server has no renderer, so the particles it creates exist where
	// no player can see them, and a client simulates only what the replicated *properties* describe. The
	// template's own `Rate` is 3 — one particle every third of a second — which is exactly the "the effect
	// showed up late" that was reported: the brick appeared in the frame it was made and the particles trickled
	// in afterwards.
	//
	// **So the rate is rewritten for the clone**, as {@link EMIT_COUNT} over {@link BURST_WINDOW_SECONDS}. The
	// window is a constant rather than the particle's own lifetime on purpose: the lifetime belongs to the
	// template and this does not, so a template authored at a tenth of a second still gets a full quarter-second
	// burst instead of a flash.
	//
	// **`Emit` is kept anyway**, because it is free, and because a template authored as a one-shot (`Rate = 0`)
	// would otherwise have nothing to emit from on the server's copy. It is not what makes the effect visible.
	//
	// **`Enabled` is forced on**, for the same reason `Transparency` and `Anchored` are: a template left with
	// its emitter switched off is a poof that produces nothing, and that is a Studio state this file cannot
	// check from inside the game.
	let emitters = 0;
	let texture: string | undefined;

	for (const descendant of effect.GetDescendants()) {
		if (!descendant.IsA("ParticleEmitter")) continue;

		emitters += 1;
		if (texture === undefined) texture = descendant.Texture;

		descendant.Rate = EMIT_COUNT / BURST_WINDOW_SECONDS;
		descendant.Enabled = true;
		descendant.Emit(EMIT_COUNT);

		// **Switched off when the window ends, so this is a burst and not a cloud that grows.** A rate left on
		// for the clone's whole life keeps emitting after the first generation has expired, which reads as a puff
		// that thickens instead of dissipating. The window delivers the count and then stops; the particles live
		// out their own authored lifetimes afterwards, and `Debris` takes the clone after them.
		task.delay(BURST_WINDOW_SECONDS, () => {
			if (descendant.Parent !== undefined) descendant.Enabled = false;
		});

		// Printed *after* the overrides, so the numbers in the log are the ones the client will simulate rather
		// than what Studio holds — the difference is the whole point of this block.
		logDebug(`[VFX] emitter ${descendant.Name}: ${describeEmitter(descendant)}`);
	}

	// **The line that says the effect exists at all — once per server, and deliberately not behind `DEBUG_LOGGING`.**
	// It names the body, the part the burst was anchored to, and where that part was: three facts that separate
	// "nothing played" from "something played somewhere nobody was standing", which are the same sentence from a
	// seat. It costs one print in the life of the server, so nobody has to edit a constant to find out whether
	// the effect works.
	if (!firstBurstReported) {
		firstBurstReported = true;

		logInfo(
			`[VFX] ${TEMPLATE_NAME} first burst — ${label} on ` +
				`${anchor === undefined ? "the position the caller passed" : anchor.Name} at ${at.Position} ` +
				`(${parts.size()} part(s), ${emitters} emitter(s), texture ${texture ?? "none"})`,
		);
	}

	Debris.AddItem(effect, EFFECT_LIFETIME);

	// **The line that separates "never spawned" from "spawned and was invisible", and the second is the state
	// this effect was reported in.** A clone in the world still shows nothing if the template carries no emitter
	// whose texture is a real image (`rbxassetid://0` draws nothing and raises nothing), if its particle size or
	// transparency sequence is degenerate, or if it was never fired. The first cannot be checked from here; it
	// *can* be reported, and one line per spawn turns the next screenshot into a diagnosis rather than a guess.
	if (DEBUG_LOGGING) {
		logInfo(
			`[VFX] ${TEMPLATE_NAME} at ${label} — ${at.Position} ` +
				`(${parts.size()} part(s), ${emitters} emitter(s), ` +
				`texture ${texture ?? "none"}, ${string.format("%.2f", EFFECT_LIFETIME)}s)`,
		);
	}
}

/**
 * One emitter's authored state as a line of prose — **the properties that decide whether a running emitter
 * produces anything a person can see.**
 *
 * **The same four `client/chargeEffect.ts` reports, for the same reason**: a template whose `Rate` is zero, whose
 * `Lifetime` is zero, whose particles are size zero or fully transparent streams happily, moves its particles and
 * never draws one — which from a seat in Studio looks exactly like an effect that never ran. `Rate` and
 * `Lifetime` are existence, `Size` and `Transparency` are visibility, and all four are in the template's
 * properties panel; this is the same information, in the log, beside the line that says this body got a poof.
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

/**
 * Every `BasePart` in a poof clone, **including the clone itself when it is one**.
 *
 * **`GetDescendants` so that a `Model`-wrapped template works unchanged**, which is `findTemplate`'s other
 * accepted shape: a person is free to wrap the carrier in a `Model` while tidying their `ReplicatedStorage`, and
 * a clone placed by one part while another sat at the template's position in `ReplicatedStorage` would be half
 * an effect at the body and half at the far end of the map. Every part is anchored at the same spot, so a
 * two-part poof stays one object.
 *
 * **The clone's own part is pushed first** because `GetDescendants` on a `BasePart` answers with its children
 * and never with itself — which is the shape a template with no `Model` wrapper has.
 */
function partsOf(effect: Instance): Array<BasePart> {
	const parts = new Array<BasePart>();

	if (effect.IsA("BasePart")) parts.push(effect);

	for (const descendant of effect.GetDescendants()) {
		if (descendant.IsA("BasePart")) parts.push(descendant);
	}

	return parts;
}
