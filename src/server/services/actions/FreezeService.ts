import { Service } from "@flamework/core";
import { Debris, ReplicatedStorage, Workspace } from "@rbxts/services";
import { findTemplate } from "shared/find";
import { FROZEN_ATTRIBUTE } from "shared/constants";
import { SUPER_CONFIG } from "shared/config/super.config";
import { DEBUG_LOGGING, logDebug, logInfo, logWarn } from "shared/logger";
import { WalkSpeedService } from "../character/WalkSpeedService";
import { overrideOutlineColour } from "../visual/OutlineService";

/**
 * The named contribution a freeze makes to a body's walk speed.
 *
 * A key rather than a write, because `WalkSpeedService` is the only owner of that number — the sprint
 * adds its own contribution to the same sum, and a direct `Humanoid.WalkSpeed = 0` here would be a
 * second owner of a figure the sprint is already moving. See that service's doc for the sum.
 */
const FROZEN_SPEED_KEY = "Frozen";

/**
 * What that contribution is worth, in studs per second.
 *
 * **A large negative number rather than `0`, and the reason is the sum.** A body's walk speed is its
 * base plus everything added to it — `Base: 20, Sprint: 15 -> 35` — so a contribution of zero would
 * leave somebody mid-sprint sprinting while frozen. This is far below any total the game can produce,
 * and `WalkSpeedService` clamps the sum at zero, so the result is exactly "cannot walk" without this
 * file having to know what the base is or what else happens to be on the body.
 */
const FROZEN_SPEED = -1000;

/**
 * What the block of ice is called, so a leftover can be found and attributed.
 *
 * The same reasoning `BallService` gives its grip and emitter names: the block is an anonymous part in
 * `Workspace` with nothing else to identify it by, and one name per thing is what makes "no ice left
 * in the world" a statement about freezes rather than about parts in general.
 */
const ICE_BLOCK_NAME = "FreezeBlock";

/** What the part a splash's burst hangs off is called, for {@link ICE_BLOCK_NAME}'s reason. */
const BURST_ANCHOR_NAME = "FreezeBurst";

/**
 * What a held Freeze ball's aura is called, for {@link ICE_BLOCK_NAME}'s reason — and this name is doing
 * more work than a name usually does, because it is also the guard. Marking is a key that can be pressed
 * twice, and a ball can gain and lose the ability over its life, so {@link attachAura} looks for an
 * emitter already wearing this name before it makes another. One aura per ball, which is `BallTrail`'s
 * arrangement for its ribbons and for the same reason: a second one is a second effect drawn over the
 * first, not a stronger version of it.
 */
const AURA_NAME = "FreezeAura";

/**
 * What a marked ball's activation flash is called, for {@link AURA_NAME}'s reason and with the same second
 * job: as well as a name it is the guard, because {@link FreezeService.flashActivation} looks for a light
 * already wearing it before it makes another. One flash per ball, for the reason one aura per ball — a
 * second light on a ball already flashing is a second light.
 */
const FLASH_NAME = "FreezeFlash";

/**
 * What the authored splash template is called, and **the whole of the contract with it**.
 *
 * **A name and nothing else**, which is `HANDOFF.md` §17 and `shared/find.ts`'s rule: the template is found by
 * walking `ReplicatedStorage` for a `Model` or a `BasePart` with this name, so where a person puts it — a `VFX`
 * folder, an `Effects` folder, no folder at all — is not a fact this file may depend on. The same lookup, by
 * the same helper, as the Pierce trail in `BallService`.
 *
 * **`FreezeSplash` rather than `FreezeBurst`**, deliberately and despite the code-built burst next door: that
 * one is not a template at all, so the two names cannot collide, and the word *splash* is the one the rest of
 * this ability already uses for one impact (see `freezeInRadius`'s report). A person building the effect in
 * Studio is looking for the thing that happens *at the impact*, which is what the name says.
 */
const FREEZE_SPLASH_NAME = "FreezeSplash";

/**
 * How long past the last particle's expiry the burst's anchor part is kept alive, in seconds.
 *
 * The part carries the emitter and nothing else, so it has to outlive the particles it fires and not
 * much longer: destroyed on the exact frame the last shard expires, that shard is cut off a frame
 * early, and left for a whole second it is an invisible part sitting in `Workspace` that nothing can
 * see, nothing will collect, and nothing needs.
 */
const BURST_CLEANUP_MARGIN = 0.25;

/**
 * How long past the last particle's expiry a `FreezeSplash` clone is kept alive, in seconds.
 *
 * **{@link BURST_CLEANUP_MARGIN}'s argument, in one more place.** A splash clone is removed after the longest
 * particle lifetime it contains, and destroying it on that exact frame would cut the last particles of the
 * effect a frame short — a flaw nobody would attribute to a quarter of a second. It is a separate constant
 * rather than that one borrowed because the two are attached to different things: the burst's margin is about
 * a part this file built and knows the lifetime of, this one is about a template somebody else authored,
 * where the particle lifetime is read back out of the clone.
 */
const SPLASH_CLEANUP_MARGIN = 0.25;

/**
 * Whether the missing-template warning has been said already.
 *
 * **Once per server, not once per splash.** A splash fires on every Freeze ball, several times a round, and a
 * warning per impact would be forty identical lines and no more information than the first — the same
 * argument `BallService.reportedMissingTemplates` makes for the Pierce trail, and the same shape, done with a
 * boolean because this file looks for exactly one name.
 */
let splashTemplateMissingReported = false;

/**
 * Every `BasePart` inside a splash clone, **including the clone itself when it is one**.
 *
 * **`GetDescendants` and not `/PrimaryPart`**, which is the opposite of what `BallService.effectPartOf` does
 * and for a reason that only exists here: a welded effect follows one part, so one part is the right thing to
 * take hold of, while a splash is *scaled*, and scaling only the carrier of a two-part effect leaves the
 * second part at its authored size in the middle of a 16-stud sphere. A splash's parts are only ever moved
 * together, so the honest answer to "what is this effect made of" is all of them.
 *
 * **The clone's own part is added by hand** because `GetDescendants` on a `BasePart` answers with its
 * descendants and never with itself — which is the shape a template with no `Model` wrapper has, and the most
 * likely one for a single sphere.
 */
function splashPartsOf(effect: Instance): Array<BasePart> {
	const parts = new Array<BasePart>();

	if (effect.IsA("BasePart")) parts.push(effect);

	for (const descendant of effect.GetDescendants()) {
		if (descendant.IsA("BasePart")) parts.push(descendant);
	}

	return parts;
}

/**
 * How wide `part` is **in the plane its own shape treats as its radius**, in studs — the number a splash has to
 * divide the target diameter by.
 *
 * **Three shapes, because `Part.Shape` changes which axes mean what.** A `Ball` is a sphere, so all three axes
 * are the diameter and any of them will do. A `Cylinder` is not: in Roblox the cylinder's flat circular caps
 * face `±X`, so `X` is the length along the cylinder's axis and `Y`/`Z` *are* the diameter across it — reading
 * `X` for a cylinder is the mistake this function exists to avoid, because it would scale a disc by its
 * thickness. Everything else (a `Block`, a `Wedge`, a `CornerWedge`, a `MeshPart`) is read by its footprint in
 * `X`/`Z`, which is the plane a splash is seen in and the one a freeze radius describes when it is drawn on
 * the floor.
 *
 * **`max` rather than one axis, even for a block**, so that a template authored slightly elongated — a ring
 * authored `8 × 0.2 × 8.4` because the modeler nudged it — is scaled until its *widest* span is the diameter
 * rather than until one hand-picked axis is. A splash that is a stud too wide on one side is invisible; one
 * that is 5% too small on the axis somebody measured is not.
 *
 * **The value returned is a size and not a radius.** `Size` is a full extent, so a `Ball` of `Size.X = 1` is a
 * one-stud sphere; the caller divides the target *diameter* by this, which is why the doc says diameter
 * everywhere and the arithmetic stays a single division.
 */
function radialExtentOf(part: BasePart): number {
	if (part.IsA("Part")) {
		if (part.Shape === Enum.PartType.Ball) return part.Size.X;
		if (part.Shape === Enum.PartType.Cylinder) return math.max(part.Size.Y, part.Size.Z);
	}

	return math.max(part.Size.X, part.Size.Z);
}

/**
 * How long a splash clone has to live, in seconds: **the longest particle lifetime in the template plus the
 * cleanup margin**, or {@link SUPER_CONFIG.FREEZE_SPLASH_LIFETIME} when the template states no lifetime at all.
 *
 * **Read from the clone rather than configured, and that is the whole point of the template being somebody
 * else's.** A particle emitter's `Lifetime` is authored in Studio, and it is the only number that knows how
 * long the effect is: a splash whose particles live 1.6 seconds would be cut off at 1.25 by a configured
 * lifetime, and one whose particles live 0.2 seconds would leave an empty part standing for a second for no
 * reason. So the clone is asked, by walking it for emitters and taking the largest `Lifetime.Max` — the
 * `Max` half of the range because the last particle to *appear* is the one that expires last, and the slowest
 * of them sets the tail.
 *
 * **The fallback is not dead code.** A splash built only of parts — a ring, a decal, a glowing sphere — holds
 * no emitter at all, and one whose emitter was left at a lifetime of zero holds no real number either. Both
 * are legal templates, and both would otherwise be handed to `Debris` with a lifetime of `0 + margin`, which
 * is a quarter of a second and would snuff the effect out before it was read.
 */
function splashLifetimeOf(splash: Instance): number {
	let longest = 0;

	for (const descendant of splash.GetDescendants()) {
		if (!descendant.IsA("ParticleEmitter")) continue;

		longest = math.max(longest, descendant.Lifetime.Max);
	}

	if (longest <= 0) return SUPER_CONFIG.FREEZE_SPLASH_LIFETIME;

	return longest + SPLASH_CLEANUP_MARGIN;
}

/**
 * What this service remembers about one frozen body, so that the release can undo exactly what the
 * freeze did.
 *
 * **The two recorded facts are the ones that cannot be read back at release time.** A body is not
 * "unanchored" when the freeze ends — it is returned to what it was, and a root that was already
 * anchored for some other reason (a builder's rig, a script's platform) must stay anchored. The same
 * goes for the jump state, which has a getter but only tells the truth *before* this service touches
 * it.
 */
interface FrozenBody {
	/** The root that was anchored, kept so the release does not have to find it again. */
	root: BasePart;
	/** What `root.Anchored` was before this service set it. */
	rootWasAnchored: boolean;
	/** Whether the humanoid was allowed to enter the jumping state before this service said no. */
	jumpingWasEnabled: boolean;
	/**
	 * The colour the body's outline was wearing, or nothing if it had no outline to repaint.
	 *
	 * **The third thing that cannot be read back at release time, for the same reason as the other two:**
	 * by then the outline is blue because *this* service is what made it blue, so a release that read the
	 * body instead of this would leave a team-coloured character wearing the freeze's colour for good.
	 * See `OutlineService.overrideOutlineColour`, which is the read-and-write this records.
	 */
	outlineColour: Color3 | undefined;
	/**
	 * The block of ice drawn around the body, or nothing when {@link SUPER_CONFIG.FREEZE_BLOCK_ENABLED}
	 * is off.
	 *
	 * **Recorded on the entry rather than looked up again at release, for `root`'s reason.** The block
	 * is deliberately *not* a child of the model — see {@link buildBlock} for why — so it does not go
	 * when the body does, and after the freeze this field is the only handle on it.
	 */
	block: BasePart | undefined;
}

/**
 * What a ball was wearing when it was marked, so that its flash can put it back.
 *
 * **One field, and it is the material.** Nothing about the ball's *colour* is touched by the flash — a
 * light is a light — so this exists only because
 * {@link SUPER_CONFIG.FREEZE_FLASH_GLOW_MATERIAL} briefly makes the ball `Neon`, and a ball left `Neon`
 * after its flash is a ball wearing a permanent glow that says "loaded" when it is not. Recorded rather
 * than assumed to be `SmoothPlastic` because a ball's material belongs to whatever made the ball, and
 * this file is not that.
 */
interface FlashedBall {
	/** The material the ball was made with, put back when the light goes off. */
	material: Enum.Material;
}

/**
 * How many bodies a splash's report names before it stops listing them.
 *
 * **Eight, because the interesting number is small.** A splash holds whatever is standing around one
 * impact, which in this game is under a dozen bodies; the cap exists so that a splash in a corner of the
 * map with a hundred parts in range cannot push one log line to a screenful. What it must not do is hide
 * the case the line was written for — and that case is about four bodies.
 */
const MAX_REPORTED_BODIES = 8;

/**
 * The bodies one splash found, **each with the one-word reason it was or was not held**, as the tail of a
 * log line.
 *
 * **The counts alone could not answer the report that made this necessary.** `found 2 bod(ies), spared 0,
 * caught 0` says a splash reached two models and held neither, and says nothing about *which* two — so the
 * two readings that matter, "the sphere only reached scenery" and "the sphere reached the rigs and refused
 * them", print identically. The log from 2026-10-18 carried four of those inside a minute, and the answer
 * (a practice area's own parts, with the nearest rig just outside the radius) was recoverable only by
 * working backwards from coordinates.
 *
 * So every body travels with its reason — `held`, `spared` (the caller's rule refused it, see
 * `BallComponent.splashSpares`), `no humanoid` (scenery, or a model with parts and nothing alive in it) and
 * `no root, or dead` (a body `freeze` could not take hold of). **The reason is recorded where the decision
 * is made** rather than worked out here from the model afterwards, because the branch that skipped the body
 * is the only thing that knows why.
 */
function describeFound(notes: Array<string>): string {
	if (notes.isEmpty()) return "nothing in range";

	// **A counted loop rather than `slice`**, because the array methods this project compiles against are
	// the `noLib` shims and `slice` is not one of them: `Property 'slice' does not exist on type 'string[]'`
	// — the same family as `isEmpty` for `is_empty` and `size()` for `length`. See `super.config.ts`'s
	// neighbours for the other places a Lua-flavoured collection surprises a TypeScript habit.
	const shown = new Array<string>();

	for (const note of notes) {
		if (shown.size() >= MAX_REPORTED_BODIES) break;
		shown.push(note);
	}

	if (shown.size() === notes.size()) return shown.join(", ");

	return `${shown.join(", ")} and ${notes.size() - shown.size()} more`;
}

/**
 * Holds bodies exactly where they are for a few seconds: the third super ability's effect, and the
 * only mechanic in this game that stops somebody moving.
 *
 * **Keyed on the `Model`, which is what makes it work for a rig as well as a player.** This is not a
 * preference; it is the arrangement two services already reached for the same reason — `BallService`
 * keeps hands by model ("a catcher can be an NPC… the only thing that genuinely needs a `Player` is the
 * throw remote's handler") and `WalkSpeedService` keeps speeds by model ("so a `Player` and an NPC rig
 * go through the same path and neither needs a lookup table of its own"). A freeze is a fact about a
 * *body*, and a body is a model with a humanoid in it — that is the whole definition, and it is the
 * same definition `BallComponent` uses to decide a contact was a body. A second map keyed on `Player`
 * would be a second answer to "who is frozen", free to disagree with the first.
 *
 * **A freeze is an anchored root, and that is the mechanism.** `WalkSpeed = 0` cannot hold a falling
 * body: it governs the humanoid's own mover, which only ever pushes along the ground, and gravity is
 * the physics solver's business rather than the humanoid's. So the three parts of a freeze are a
 * walk-speed contribution of nothing (through {@link WalkSpeedService}), the jumping state disabled,
 * and **the root part anchored** — and it is the anchor that does the work, because an anchored
 * assembly is not simulated at all. It cannot walk, cannot be pushed, cannot fall, and it keeps the
 * pose it was in, which is exactly "held mid-air, not ragdolled". It is also the cheapest thing to
 * undo: one property, back to what it was.
 *
 * **The fourth part is the only one that is presentation: the body's own outline, recoloured.** A blue
 * edge is what says "this body is not moving *because of something*" rather than "this body has
 * stopped", and it is written onto the `Highlight` the body already wears rather than by adding one —
 * the engine draws one outline per model and its choice between two is undefined. See
 * `OutlineService.overrideOutlineColour` for the write, and {@link unfreeze} for the restore.
 *
 * **`PlatformStand` is deliberately not used**, and it fails both halves of the requirement rather
 * than being merely unfashionable: a humanoid in `PlatformStanding` still falls (the state stops its
 * mover, not gravity) and it goes limp, which is a ragdoll.
 *
 * **Every freeze has a clock, and that is the only thing that removes a body from the map.** A body
 * whose owner disconnects, whose rig is respawned, or whose humanoid dies before the timer fires leaves
 * an entry that the timer still clears — `unfreeze` is written to be safe for a body that is already
 * gone. So there is no path by which an entry can outlive the duration it was given.
 */
@Service()
export class FreezeService {
	/** Every body currently held, and what it will take to let it go. */
	private readonly frozen = new Map<Model, FrozenBody>();

	/**
	 * Every ball whose activation flash is still running, and the material it has to go back to.
	 *
	 * **This is the guard and the record at once.** A ball can be marked, thrown, collected and marked
	 * again, and the second mark is only legal once the ability has been cleared — which happens on the
	 * way into a hand, so the whole cycle can complete inside the flash's own second on a fast throw.
	 * Without an entry per ball, the second flash would capture `Neon` as the material to restore and
	 * leave the ball glowing for good. The entry is written before the light goes on and removed by the
	 * cleanup, so "is a flash running" and "what does it restore" are one question with one answer.
	 */
	private readonly flashes = new Map<BasePart, FlashedBall>();

	constructor(private readonly speeds: WalkSpeedService) {}

	/** Whether `model` is frozen right now. The question every action asks before acting. */
	public isFrozen(model: Model): boolean {
		return this.frozen.has(model);
	}

	/**
	 * Holds `model` in place for `seconds`, and answers whether it took hold.
	 *
	 * **A second freeze on a body that is already held moves the clock and nothing else.** The
	 * mechanism is applied idempotently — one contribution under one key, one anchored root, the
	 * jumping state already off — but what the *first* freeze recorded about the body is what the
	 * release has to restore, which is why the previous entry is read rather than the body. Reading the
	 * body would record "this root was anchored", because this service is the thing that anchored it,
	 * and the release would leave somebody hanging in the air.
	 *
	 * Returns `false` for a model with no living humanoid, for `WalkSpeedService.addModifier`'s reason:
	 * there is nowhere for a freeze to go, so nothing is stored either — and `freezeInRadius` uses that
	 * answer rather than filtering twice.
	 */
	public freeze(model: Model, seconds: number): boolean {
		const humanoid = model.FindFirstChildWhichIsA("Humanoid");
		const root = humanoid?.RootPart;
		if (!humanoid || !root || humanoid.Health <= 0) return false;

		const previous = this.frozen.get(model);

		// **Read before anything is applied**, because anchoring the root is what is being recorded. The
		// same rule covers the outline below: a body that is already blue must not record blue as "what it
		// was", or its release would leave a team-coloured character wearing the freeze's colour for good.
		// `previous` short-circuits the whole of that line, including the write, which is right — a body
		// already frozen is already wearing the colour it would be painted.
		const rootWasAnchored = previous ? previous.rootWasAnchored : root.Anchored;
		const jumpingWasEnabled = previous
			? previous.jumpingWasEnabled
			: humanoid.GetStateEnabled(Enum.HumanoidStateType.Jumping);
		const outlineColour = previous
			? previous.outlineColour
			: overrideOutlineColour(model, SUPER_CONFIG.FREEZE_OUTLINE_COLOR);

		this.speeds.addModifier(model, FROZEN_SPEED_KEY, FROZEN_SPEED);
		humanoid.SetStateEnabled(Enum.HumanoidStateType.Jumping, false);
		// And the jump that was already in flight is dropped, so a body frozen on the way up does not
		// finish the jump the instant it thaws. The state being disabled is what stops a *new* one.
		humanoid.Jump = false;
		root.Anchored = true;

		// **Built after the anchor, so the box is the body's *held* bounds** rather than a pose it was
		// passing through on the way in — and reused rather than rebuilt when this body was already
		// frozen: a second block would sit inside the first, and the body has not moved for the two of
		// them to have anything to differ about. See `buildBlock` for the box itself.
		const block = previous ? previous.block : this.buildBlock(model);

		// **A fresh entry rather than a mutated one, so a timer can tell whether it is still the freeze
		// it was scheduled for.** A later splash replaces this object, and the earlier timer then finds
		// somebody else's entry here and leaves the body alone — which is what stops the first splash of
		// two cutting the second one short.
		const entry: FrozenBody = { root, rootWasAnchored, jumpingWasEnabled, outlineColour, block };
		this.frozen.set(model, entry);

		// **And the same fact published, because one reader of it is a client.** The map above is the
		// authority and stays the authority — this is the copy that lets `client/dashPrediction` refuse to
		// move a frozen body, which it has to know *before* the press rather than a round trip later. Written
		// on every freeze rather than only on the first: a re-freeze is a body that is still frozen, and
		// writing `true` over `true` is not an event anybody can observe twice. See `FROZEN_ATTRIBUTE`, which
		// carries the argument for a flag rather than an instant and for the server being the only writer.
		model.SetAttribute(FROZEN_ATTRIBUTE, true);

		if (previous) {
			logDebug(`[Freeze] ${model.Name}: still frozen — the clock restarted`);
		} else {
			// **One watcher per body, and both are the rule rather than a tidy-up.** A freeze is defined
			// to clear when its body dies, and a body that leaves the world cannot be thawed by anything —
			// so both are the same call, and neither fires twice for one freeze because they are connected
			// once. Connections on an instance die with it, so there is nothing to disconnect.
			humanoid.Died.Connect(() => this.unfreeze(model));
			model.Destroying.Connect(() => this.unfreeze(model));

			logDebug(`[Freeze] ${model.Name}: frozen for ${string.format("%.2f", seconds)}s`);
		}

		task.delay(seconds, () => {
			// Superseded by a later freeze: that one owns the release now, and its own timer will do it.
			if (this.frozen.get(model) !== entry) return;

			this.unfreeze(model);
		});

		return true;
	}

	/**
	 * The block of ice drawn around a frozen body, or nothing when the look is switched off.
	 *
	 * **One part, sized from the body's own bounds, parented to the world and not welded to the model.**
	 * Each of those is a decision rather than a detail:
	 *
	 * - **Not welded, and not a child of the model.** A freeze anchors the *root*; the joints keep
	 *   running, so a body held mid-stride still swings its arms inside the block. A welded block would
	 *   be dragged around by whatever the torso did and would read as the ice being shoved rather than as
	 *   the body being held — and, being a child, it would also be destroyed with the model, which is the
	 *   one outcome {@link unfreeze} has to be able to guarantee by hand.
	 * - **`GetBoundingBox` rather than `GetPivot`.** The two answers are not close: a character's pivot
	 *   is its root, at hip height, while this box is centred on the body's bounds, nearer the chest, so
	 *   a block placed at the pivot has a head through its roof. The same call answers with the size, and
	 *   its CFrame carries the model's own orientation — so a body frozen lying on the ground gets ice
	 *   that lies down with it.
	 * - **`CanTouch = false` is mandatory, not cosmetic.** `Touched` fires on *overlap* rather than on
	 *   collision, so a touchable block around a body is a surface every ball in the arena can hit: the
	 *   ball reports a contact on somebody who never touched it and is handled for it — sounded, tagged,
	 *   disarmed — on a body it passed a stud away from. The same class of bug as the `CharacterBarrier`
	 *   in `shared/constants.ts`, which carries the same flag for the same reason.
	 * - **`CanQuery = false` is mandatory for the same reason, aimed at the rays instead of the physics.**
	 *   The aim guide walks the world with a sphere sweep, so a queryable block stops the preview at the
	 *   frozen body and the guide then promises a landing short of the one the ball will make — a lying
	 *   guide, produced by a decoration.
	 *
	 * **Every property is set before the part is parented**, which is `SoundEmitter`'s rule and is
	 * load-bearing here for its reason: a part that arrives in the world touchable and is made untouchable
	 * on the following line is one the solver has already seen.
	 *
	 * **Two properties are here for the look rather than for the physics.** `CastShadow` is off because
	 * the body already casts its own shadow inside the block and a second one, tinted by a
	 * semi-transparent part, is a blue rectangle on the floor that reads as a fault. And the top and
	 * bottom surfaces are smoothed because a `Part` arrives with studs and an inlet on them, and a
	 * translucent block shows them rather than hiding them — ice does not have studs.
	 */
	private buildBlock(model: Model): BasePart | undefined {
		if (!SUPER_CONFIG.FREEZE_BLOCK_ENABLED) return undefined;

		const [centre, size] = model.GetBoundingBox();
		const grow = SUPER_CONFIG.FREEZE_BLOCK_PADDING * 2;

		const block = new Instance("Part");
		block.Name = ICE_BLOCK_NAME;
		// The box's own frame, so the ice is aligned to the body rather than to the world's axes.
		block.CFrame = centre;
		block.Size = size.add(new Vector3(grow, grow, grow));
		block.Anchored = true;
		block.CanCollide = false;
		block.CanTouch = false;
		block.CanQuery = false;
		block.Massless = true;
		block.CastShadow = false;
		block.TopSurface = Enum.SurfaceType.Smooth;
		block.BottomSurface = Enum.SurfaceType.Smooth;
		block.Material = Enum.Material.Ice;
		block.Color = SUPER_CONFIG.FREEZE_BLOCK_COLOR;
		block.Transparency = SUPER_CONFIG.FREEZE_BLOCK_TRANSPARENCY;

		// Parented last, with every property already set — see the note above.
		block.Parent = Workspace;

		return block;
	}

	/**
	 * The shards a Freeze impact throws: one `ParticleEmitter` on a throwaway part, fired once.
	 *
	 * **A burst, and the parts this replaces were built and rejected rather than never tried.** The
	 * ground effect used to be twenty-three parts — a disc and a cluster of wedge shards — arranged,
	 * tilted and sized by seventeen constants, and the look never converged: it read as a pile of
	 * geometry, and each round of tuning cost a rebuild and a Studio run. What the effect is trying to
	 * say is that *something happened here*, and an impact happens once. The engine's own answer to that
	 * is a particle burst: one instance instead of twenty-three, no orientation to get wrong, nothing
	 * that a ball can hit, nothing a player can walk into, and therefore no collision group and no query
	 * flag needed to keep the rest of the game away from it.
	 *
	 * **Nothing about it is stored, and it touches no freeze state.** It has no entry in {@link frozen},
	 * no owner and no connection to the bodies it froze: it is over in a fraction of a second while a
	 * freeze lasts seconds, so the two lifetimes are deliberately unrelated and `unfreeze` has no
	 * business with it. Its own timer is the whole of its lifecycle — `SoundEmitter`'s arrangement for a
	 * one-shot instance, and the reason there is nothing here for a round boundary to sweep.
	 *
	 * **`Rate = 0` and then `Emit`, which is the difference between a burst and a spray.** A continuous
	 * emitter at the impact point would keep firing for as long as the part lived, which is a fountain
	 * rather than an impact. The emission comes after the parenting, because an emitter that is not in
	 * the world is not emitting anything.
	 *
	 * **The part is aimed at the sky, and the spread is measured from its own forward.** What the emitter
	 * has is `EmissionDirection`, a *face*, and the typings do not state which face a fresh emitter
	 * points down — so both are set here: `Front`, with the part's `LookVector` pointing up. The cone in
	 * `FREEZE_BURST_SPREAD_ANGLE` is then the cone that was configured, rather than whatever the default
	 * happened to be.
	 *
	 * Returns nothing, deliberately: no caller may hold, move or clean this up, and a return value would
	 * be an invitation to start treating it as state.
	 */
	private buildBurst(origin: Vector3): void {
		if (!SUPER_CONFIG.FREEZE_BURST_ENABLED) return;

		const anchor = new Instance("Part");
		anchor.Name = BURST_ANCHOR_NAME;
		// Forward is up, so the emitter's own direction is the direction the shards fly — see the note
		// above about why the face is set rather than left to a default.
		anchor.CFrame = CFrame.lookAt(origin, origin.add(new Vector3(0, 1, 0)));
		anchor.Size = new Vector3(0.1, 0.1, 0.1);
		anchor.Anchored = true;
		anchor.CanCollide = false;
		anchor.CanTouch = false;
		anchor.CanQuery = false;
		anchor.Massless = true;
		anchor.CastShadow = false;
		// Invisible, and that is not tidiness: the part exists to carry the emitter, and a visible one
		// would be a small blue box sitting in the middle of the burst. The emitter is its child so that
		// a single `Destroy` takes both.
		anchor.Transparency = 1;

		const emitter = new Instance("ParticleEmitter");
		emitter.Texture = SUPER_CONFIG.FREEZE_BURST_TEXTURE;
		// A one-shot: no continuous emission at all, and the count passed to `Emit` below is the whole
		// effect. See the note above.
		emitter.Rate = 0;
		emitter.EmissionDirection = Enum.NormalId.Front;
		emitter.Lifetime = new NumberRange(SUPER_CONFIG.FREEZE_BURST_LIFETIME);
		emitter.Speed = new NumberRange(SUPER_CONFIG.FREEZE_BURST_SPEED);

		// One number in the config, two here: the emitter takes a horizontal and a vertical spread
		// separately, and this effect has no reason to want them different.
		const spread = SUPER_CONFIG.FREEZE_BURST_SPREAD_ANGLE;
		emitter.SpreadAngle = new Vector2(spread, spread);

		emitter.Size = SUPER_CONFIG.FREEZE_BURST_SIZE;
		emitter.Transparency = SUPER_CONFIG.FREEZE_BURST_TRANSPARENCY;
		// A `Color3` in the config and a sequence here, for the same reason the shape curves are
		// sequences: one colour is what the effect is, and the emitter wants the lifetimed form.
		emitter.Color = new ColorSequence(SUPER_CONFIG.FREEZE_BURST_COLOR);
		emitter.LightEmission = SUPER_CONFIG.FREEZE_BURST_LIGHT_EMISSION;
		// Whether the shards fall, and how hard — a scale on the world's own gravity so a map that has
		// turned it down gets shards that come down with it.
		emitter.Acceleration = new Vector3(0, -Workspace.Gravity * SUPER_CONFIG.FREEZE_BURST_GRAVITY_SCALE, 0);
		emitter.Parent = anchor;

		// Parented last, with every property already set — `SoundEmitter`'s rule, and here it also means
		// the part reaches the world carrying an emitter that will not fire on its own.
		anchor.Parent = Workspace;

		// The burst itself. One call, once — this is the whole effect.
		emitter.Emit(SUPER_CONFIG.FREEZE_BURST_COUNT);

		// **One timer, and it is the effect's entire lifetime.** A particle lives at most
		// `FREEZE_BURST_LIFETIME` and starts at the emission above, so the part is kept past that and no
		// longer: destroyed on the exact frame the last shard expires, that shard is cut off a frame
		// early. Destroying the anchor takes the emitter with it — one call rather than two, and no way
		// for the emitter to be left behind.
		task.delay(SUPER_CONFIG.FREEZE_BURST_LIFETIME + BURST_CLEANUP_MARGIN, () => anchor.Destroy());
	}

	/**
	 * **Plays the authored `FreezeSplash` template at `origin`, scaled so the effect spans `radius * 2` studs
	 * across.**
	 *
	 * **Why the scale is a runtime calculation rather than a studio one, which is the entire reason this method
	 * exists.** A template is one fixed object, and one freeze is not one fixed size: the same splash has to
	 * draw a hit, which reaches `SUPER_CONFIG.FREEZE_HIT_RADIUS` from the body part the ball struck, and a
	 * miss, which reaches `SUPER_CONFIG.FREEZE_MISS_RADIUS` from where the ball stopped. A part authored at
	 * sixteen studs would be wrong for one of them, and two templates would be two things to keep looking
	 * alike. So the template is authored at whatever size reads well in Studio and this file stretches it to
	 * the radius the freeze actually used — **the number is passed in from {@link freezeInRadius}'s own
	 * argument, never re-derived here**, so what is drawn and what is frozen can never disagree.
	 *
	 * **The radius arrives as a radius and the part is sized as a diameter**, which is the one conversion and
	 * the place to look when an effect is twice the size it should be: `GetPartBoundsInRadius` measures from a
	 * centre to a surface, while `Size` is a full extent, so a correct splash is `2r` across. `size = r` would
	 * hide half of the frozen area inside the effect.
	 *
	 * **`math` about the template's own authored size rather than an absolute assignment**, and that is what
	 * keeps the author's proportions. Every axis is multiplied by the same factor — the diameter divided by
	 * the template's own radial extent, see {@link radialExtentOf} for which axis that is per shape — so a
	 * square block becomes a square of the right width, a flat ring stays flat, and a sphere stays a sphere.
	 * Assigning `Vector3.new(d, d, d)` to every shape instead would turn a ring into a cube and a disc into a
	 * barrel; the axes that are not the radius are the author's to decide, and this multiplies them the same
	 * way. (The one shape where a straight assignment *is* right is a `Ball`, where all three axes are the
	 * diameter by definition — which is why reading the shape is still worth doing: a sphere gets one number
	 * from three axes instead of trusting that its author made all three equal.)
	 *
	 * **Every part in the clone moves, not only the carrier.** A splash is one object and it is drawn as a
	 * whole, so each part is scaled and pushed away from the pivot by the same factor; see {@link splashPartsOf}
	 * for why a one-part weld-style carrier is not enough here. The offsets between parts scale with the parts,
	 * so a template that is a sphere with a smaller sphere hovering above it keeps that relationship at any
	 * radius.
	 *
	 * **The physics flags are the same five-ish as every other effect this service builds**, for the reason
	 * `buildBurst` gives: this must not be something a ball can hit, a ray can find, or a player can stand on.
	 * `Anchored = true` because a splash hangs where it happened and the template in `ReplicatedStorage` may
	 * well be unanchored (`BallService.attachPierceEffect` has the mirror-image case), and a splash that fell
	 * out of the sky a moment after the freeze would read as an unrelated effect.
	 *
	 * **Cleanup is `Debris` and the lifetime is the template's own**, see {@link splashLifetimeOf}. Nothing is
	 * stored: this clones, plays and is forgotten — the same arrangement as the burst, and the reason a round
	 * boundary has nothing to sweep.
	 */
	private playFreezeSplash(origin: Vector3, radius: number): void {
		if (!SUPER_CONFIG.FREEZE_SPLASH_ENABLED) return;

		// **By name, through the whole of `ReplicatedStorage`** — `FREEZE_SPLASH_NAME` and `shared/find.ts`.
		const template = findTemplate(ReplicatedStorage, FREEZE_SPLASH_NAME);

		// **Said once, with everything needed to fix it**, which is `BallService.attachPierceEffect`'s argument
		// word for word: a missing name, a misspelt name and a template never published are three different
		// fixes and one indistinguishable symptom, so the line lists what `ReplicatedStorage` actually holds.
		// Nothing else happens — a Freeze ball with no splash still freezes everybody it should.
		if (template === undefined) {
			if (!splashTemplateMissingReported) {
				splashTemplateMissingReported = true;

				logWarn(`[VFX] no ${FREEZE_SPLASH_NAME} in ReplicatedStorage — the Freeze splash will not play`);

				const top: string[] = [];
				for (const child of ReplicatedStorage.GetChildren()) top.push(`${child.Name} (${child.ClassName})`);

				logWarn(
					`[VFX] ReplicatedStorage holds: ${top.isEmpty() ? "nothing" : top.join(", ")} — ` +
						`a splash template is a Model or a BasePart named ${FREEZE_SPLASH_NAME}, ` +
						`and it is found by name wherever it sits.`,
				);
			}

			return;
		}

		const splash = template.Clone();
		const parts = splashPartsOf(splash);

		// A clone of a template that holds no part at all is nothing this can scale or place, and cloning one
		// per splash only to throw it away is a leak with a warning attached.
		if (parts.isEmpty()) {
			if (!splashTemplateMissingReported) {
				splashTemplateMissingReported = true;

				logWarn(
					`[VFX] ${FREEZE_SPLASH_NAME} holds no BasePart — the Freeze splash will not play. ` +
						"The template is scaled and placed by its part(s).",
				);
			}

			splash.Destroy();

			return;
		}

		// **The radius, doubled, and read once** — see this method's doc for why the conversion lives here.
		const diameter = radius * 2;

		// The part whose authored width defines the effect: a `Model`'s primary part if the author set one (that
		// is what a primary part means — the part the model *is*), otherwise the first part in the clone, which
		// for a bare `BasePart` template is the template itself.
		const carrier = splash.IsA("Model") && splash.PrimaryPart !== undefined ? splash.PrimaryPart : parts[0];
		const authored = radialExtentOf(carrier);

		// Guarded rather than divided blind: an engine-clamped `Size` cannot be zero, but a template with a
		// degenerate part is one bad paste away, and `NaN`/`inf` here would put a part of no describable size
		// in `Workspace`. A scale of `1` at least leaves the effect readable and the fault visible.
		const scale = authored > 0 ? diameter / authored : 1;

		// **Two passes about a pivot, rather than scaling each part where it stands.** Scaling a part's `Size`
		// on its own shrinks it towards its own centre, so a multi-part effect would stay the same overall
		// width while every piece inside it moved apart — the parts have to be pushed away from a shared
		// centre by the same factor their sizes were multiplied by. For a `Model` that pivot is the centre of
		// its bounding box, which is where the effect *is*; for a single part it is the part's own position,
		// which makes the offset zero and the two passes collapse into the one obvious answer.
		const pivot = splash.IsA("Model") ? splash.GetBoundingBox()[0].Position : parts[0].Position;

		for (const part of parts) {
			const offset = part.Position.sub(pivot);
			part.Size = part.Size.mul(scale);
			part.Position = pivot.add(offset.mul(scale));

			// Set before parenting, `SoundEmitter`'s rule: a part that arrives in the world touchable and is
			// made untouchable on the line after is one the solver has already seen.
			part.Anchored = true;
			part.CanCollide = false;
			part.CanTouch = false;
			part.CanQuery = false;

			// **`Transparency` is not one of the flags above, and the difference cost a round of Studio time.**
			// Those three are about *interaction*: with them off a ball passes through the part and no query
			// finds it, and the part is still **drawn** — a solid white block over the impact, which is exactly
			// what a carrier template looks like when its author set the collision flags and nothing else.
			// A carrier exists to hold an `Attachment` and a `ParticleEmitter`, so it must not be seen at all;
			// see `SUPER_CONFIG.FREEZE_SPLASH_HIDE_PARTS` for why that is forced here, on the clone, rather
			// than trusted to the template, and for the geometry-shaped template that wants it off.
			if (SUPER_CONFIG.FREEZE_SPLASH_HIDE_PARTS) part.Transparency = 1;
		}

		// **Measured again after the scaling rather than reusing `pivot`**, because the second pass has to know
		// where the effect ended up, and for an asymmetric model the bounding-box centre is not where it
		// started. One measurement here and the shift is exact for every shape.
		const placed = splash.IsA("Model") ? splash.GetBoundingBox()[0].Position : parts[0].Position;
		const shift = origin.sub(placed);

		for (const part of parts) part.Position = part.Position.add(shift);

		// Parented last, with every property already set and the whole effect already at the impact point.
		splash.Parent = Workspace;

		// **One line per spawn, ungated**, which is the house rule for a diagnostic that has to explain a
		// screenshot somebody already has — `BallComponent`'s tag and landing lines and this service's own
		// splash report are ungated for the same reason. It names the numbers the effect was *drawn* with: the
		// impact point, the radius the freeze used, the diameter derived from it and the factor applied to the
		// template. The question it answers is "did a clone appear, and was it the size of the freeze", and
		// against a splash that looks wrong the factor is what separates a template authored at the wrong size
		// from one placed in the wrong place.
		logInfo(
			`[VFX] ${FREEZE_SPLASH_NAME} spawned at ${origin} with size ${diameter} ` +
				`(radius ${radius}, scale ${string.format("%.2f", scale)}, ${parts.size()} part(s))`,
		);

		// **An emitter authored as a one-shot emits nothing on its own**, and that is the trap a template built
		// for a `Debris` clone falls into: `Rate = 0` (or `Enabled = false`) is exactly how somebody authors
		// "fire this once when something calls `Emit`", and nothing else here calls it. So the clone is walked
		// for those emitters and fired once each — **after the parenting**, because an emitter that is not in
		// the world emits nothing. An emitter that is already running (`Rate > 0` and enabled) is left alone:
		// it starts when it enters the tree, and a second `Emit` on top of it would double the effect.
		for (const descendant of splash.GetDescendants()) {
			if (!descendant.IsA("ParticleEmitter")) continue;
			if (descendant.Rate > 0 && descendant.Enabled) continue;

			descendant.Emit();
		}

		Debris.AddItem(splash, splashLifetimeOf(splash));
	}

	/**
	 * Lets `model` go: the anchor, the outline, the ice, the jump state and the walk speed.
	 *
	 * **Safe to call for a body that is already gone, which is why three things call it** — the clock, a
	 * death, and the body being destroyed. A model that has left the world has nothing left to reverse:
	 * there is no root to unanchor and no humanoid to un-silence. The row is dropped either way, and
	 * that is the half that matters, because it is what keeps the map from growing.
	 *
	 * **The contribution is removed first and unconditionally**, because it is the one thing this
	 * service wrote into somebody else's map: `removeModifier` is a documented no-op for a body that has
	 * already been forgotten, and skipping it would be the one way this file could leave a trace behind.
	 */
	public unfreeze(model: Model): void {
		const entry = this.frozen.get(model);
		if (!entry) return;

		this.frozen.delete(model);
		this.speeds.removeModifier(model, FROZEN_SPEED_KEY);
		// **Cleared above the early return below, which is where the ice also has to go** — a model that has left
		// the world has nothing left to thaw, but an attribute still saying `true` on one is a fact outliving the
		// thing it described, and a body destroyed mid-freeze that respawns into the same model is exactly the
		// case a stale `true` would be read as "cannot dash" by a client that never saw the freeze at all.
		model.SetAttribute(FROZEN_ATTRIBUTE, undefined);

		// **The ice goes above the early return below, and that placement is the whole of this line's
		// care.** The block is not a child of the model — see {@link buildBlock} — so a body that has
		// been destroyed takes its own parts with it and leaves the ice standing in the world. Everything
		// below this point needs a body to put something back on; this is the one thing that does not.
		entry.block?.Destroy();

		if (model.Parent === undefined) return;

		entry.root.Anchored = entry.rootWasAnchored;

		// **The outline is the third thing put back, and a missing one is deliberately not an error.** A
		// body with no `Highlight` has nothing to restore, which is what the `undefined` recorded at the
		// freeze means — `OutlineService.overrideOutlineColour` creates nothing to make a restore
		// possible, because a second `Highlight` on a model is an undefined choice between two outlines
		// rather than two effects. In practice every rig and every character is dressed the moment it
		// arrives, so there is almost always a colour here.
		if (entry.outlineColour !== undefined) overrideOutlineColour(model, entry.outlineColour);

		const humanoid = model.FindFirstChildWhichIsA("Humanoid");
		if (humanoid) humanoid.SetStateEnabled(Enum.HumanoidStateType.Jumping, entry.jumpingWasEnabled);

		logDebug(`[Freeze] ${model.Name}: released`);
	}

	/**
	 * Releases every frozen body. Called when a round ends.
	 *
	 * **Everything, rather than the round's participants**, for the reason the MultiBall window is
	 * cleared the same way: a freeze is a fact about a body, and a body that is frozen when the round
	 * ends is frozen whether or not it was playing in it. A round boundary is the one moment in the game
	 * where "everybody" is the right answer, because it is the one moment when nothing carries over.
	 */
	public unfreezeAll(): void {
		// Snapshotted, because `unfreeze` deletes from the map this is walking.
		const models: Array<Model> = [];
		this.frozen.forEach((_entry, model) => models.push(model));

		for (const model of models) this.unfreeze(model);
	}

	/**
	 * Puts a Freeze ball's aura on it: the emitter that says *this ball is loaded*, while it is in
	 * somebody's hand.
	 *
	 * **Why it exists.** A marked ball and an ordinary one look identical in a hand, so the only thing a
	 * Freeze throw does — land a splash on whoever is standing there — is invisible until it has already
	 * happened. The aura is the half of the read that is missing: it is the held companion of the burst
	 * at the impact, and the same argument puts both on the server. A player telling the room they are
	 * holding a loaded ball is something everybody standing near the throw needs to be able to see, so it
	 * is built where the throw is decided and replicates from there — exactly as the freeze's own colour
	 * does on the body it holds, and unlike the aim guide, which is one player's private preview.
	 *
	 * **No anchor part, and that is the one structural difference from the burst.** The burst is fired at
	 * a point in the world, so its emitter needs a part to sit on and a timer to take that part away. An
	 * aura belongs to the ball and goes where the ball goes, so the emitter is parented to the ball itself:
	 * one instance instead of two, nothing to keep in step with a moving hand, and nothing to clean up —
	 * it is a child of the ball, so it dies with the ball exactly as the trail's ribbons do.
	 *
	 * **`Rate` is the other difference, and it is what makes this the same tool used the other way.** The
	 * burst sets `Rate = 0` and fires a count in one call; this is continuous, has no `Emit` call at all,
	 * and the amount of ice around the ball is `Rate × Lifetime` — see `FREEZE_AURA_RATE`.
	 *
	 * **Find-or-adopt, which is the whole guard against a second aura.** A ball that is already wearing
	 * one is returned as it is: the ability can be re-marked and cleared and re-marked without ever
	 * stacking two emitters on one ball, and the instance is the caller's answer to "is it already
	 * wearing one".
	 *
	 * Returns the emitter, or nothing when the effect is switched off — `BallTrail.attach`'s shape for
	 * `BALL_CONFIG.TRAIL_ENABLED`'s reason: off means the instance is not built rather than that it is
	 * idle, so a player cannot tell a switched-off aura from a ball that has none.
	 */
	public attachAura(ball: BasePart): ParticleEmitter | undefined {
		if (!SUPER_CONFIG.FREEZE_AURA_ENABLED) return undefined;

		const existing = ball.FindFirstChild(AURA_NAME);
		if (existing?.IsA("ParticleEmitter")) return existing;

		const aura = new Instance("ParticleEmitter");
		aura.Name = AURA_NAME;
		aura.Texture = SUPER_CONFIG.FREEZE_AURA_TEXTURE;
		// Continuous: nonzero rate, no `Emit` anywhere. See the note above.
		aura.Rate = SUPER_CONFIG.FREEZE_AURA_RATE;
		// Set rather than assumed. A fresh emitter's defaults are engine behaviour and not in the typings,
		// and the one that matters here is whether it is emitting at all — an aura that silently built
		// itself switched off would look exactly like an aura that is working and invisible.
		aura.Enabled = true;
		aura.Lifetime = new NumberRange(SUPER_CONFIG.FREEZE_AURA_LIFETIME);
		aura.Speed = new NumberRange(SUPER_CONFIG.FREEZE_AURA_SPEED);

		// All round: a ball has no front, and a cone would be ice coming off one side of it.
		const spread = SUPER_CONFIG.FREEZE_AURA_SPREAD_ANGLE;
		aura.SpreadAngle = new Vector2(spread, spread);

		aura.Size = SUPER_CONFIG.FREEZE_AURA_SIZE;
		aura.Transparency = SUPER_CONFIG.FREEZE_AURA_TRANSPARENCY;
		aura.Color = new ColorSequence(SUPER_CONFIG.FREEZE_AURA_COLOR);
		aura.LightEmission = SUPER_CONFIG.FREEZE_AURA_LIGHT_EMISSION;

		// **No `Acceleration`**, unlike the burst: the aura is not meant to fall, and the default is
		// nothing, which is what drifting ice wants.

		// Parented last, with every property already set — `SoundEmitter`'s rule, and here it also means
		// the ball never carries an emitter that is still being configured.
		aura.Parent = ball;

		return aura;
	}

	/**
	 * Takes a Freeze ball's aura off it, if it has one.
	 *
	 * **Called from three places, and each of them is a change in the same fact.** When the ability is
	 * replaced with another one, when it is cleared, and — the ordinary case by far — when the ball is
	 * thrown: the aura says *loaded and in a hand*, and the trail that arms at that same moment says *in
	 * flight*. Two indicators for two states, and the whole point of both is that neither is on for the
	 * other's.
	 *
	 * **Why the throw is a removal rather than a transfer.** Something riding the ball through its flight
	 * would be a second trail, and a second trail drawn over the first is the failure this file and
	 * `BallTrail` both take trouble to avoid — the ball's own trail is the throw indicator, and it is the
	 * one that bends with the arc and says where the ball has been.
	 *
	 * A no-op for a ball with no aura, which is most balls: nothing here has to know whether one was ever
	 * attached, so a caller can say "this ball is not a Freeze ball now" without asking first.
	 */
	public detachAura(ball: BasePart): void {
		const aura = ball.FindFirstChild(AURA_NAME);
		if (aura !== undefined) aura.Destroy();
	}

	/**
	 * Flashes the ball a player has just marked Freeze: a bright light on it for a moment, and nothing else.
	 *
	 * **What it is for.** The aura says a ball is loaded, but it says it *after* the fact — the moment the
	 * key is pressed is the one part of this ability that had no answer at all, and it is the part the
	 * player who pressed it is watching. A flare of light off the ball is that answer, and it is
	 * deliberately written on the ball rather than anywhere else, because the ball is the only thing that
	 * exists at that instant: there is no target, no impact and nothing flying, so the other three parts of
	 * the effect have nothing to draw on yet.
	 *
	 * **A light, deliberately — the first version of this painted the ball instead, and that was wrong.**
	 * Writing white and then `#243E7D` onto the ball's `Color` does not read as light; it reads as the ball
	 * having been repainted, and it throws away the one thing a ball's appearance is. A ball's colour is a
	 * fact about the ball — one default red, and whatever its holder has brought to it (see
	 * `BALL_CONFIG.BALL_COLOR` and `BallTrail.attach`) — so for that fraction of a second the player is
	 * holding a ball that is not theirs. A `PointLight` is the engine's own answer to "something shiny has
	 * light on it", and it leaves the ball's colour alone because it *is* the light rather than a colour
	 * standing in for something.
	 *
	 * **Two things go on and both come off**: the light itself, and — with
	 * {@link SUPER_CONFIG.FREEZE_FLASH_GLOW_MATERIAL} — `Neon` on the ball, because a light inside a sphere
	 * lights what is around the sphere rather than the sphere. See that flag for why the two travel
	 * together.
	 *
	 * **Server-side, on `attachAura`'s argument.** Every player who can see the marked ball being carried
	 * needs to see it being loaded, so that the throw that follows is a throw they could have seen coming.
	 * A client-side flash would tell the thrower and nobody else.
	 *
	 * **One `task.delay`, and what it puts back is the material.** The entry kept in {@link flashes} is both
	 * that record and the guard against a second flash on the same ball, which is not a rare case — it is
	 * the case of a dev who throws and catches the same ball repeatedly. No `TweenService` here for the same
	 * reason as everywhere else in this file: nothing about this is interpolated, it is on and then off.
	 */
	public flashActivation(ball: BasePart): void {
		if (!SUPER_CONFIG.FREEZE_FLASH_ENABLED) return;

		// Anything can arrive here — a hand-out, a fresh throw, the first ball of a round — and a ball
		// mid-flash is already saying what this would say, in a material this would be recording.
		if (this.flashes.has(ball)) return;

		this.flashes.set(ball, { material: ball.Material });

		const light = new Instance("PointLight");
		light.Name = FLASH_NAME;
		light.Color = SUPER_CONFIG.FREEZE_FLASH_COLOR;
		light.Brightness = SUPER_CONFIG.FREEZE_FLASH_BRIGHTNESS;
		light.Range = SUPER_CONFIG.FREEZE_FLASH_RANGE;
		// Set rather than assumed, for the emitter's reason: the typings do not say what a fresh light's
		// `Enabled` is, and a light that silently built itself switched off looks like a flash that did not
		// happen.
		light.Enabled = true;
		// **Shadows off.** A light that casts shadows for eight tenths of a second does nothing but make the
		// frames it lands on darker than the ones either side of it.
		light.Shadows = false;
		// Parented last, with every property already set — see `attachAura`.
		light.Parent = ball;

		// The ball shining rather than the ball being painted: `Neon` makes the part look self-lit and
		// keeps its own colour. Off means the flash only lights the scene. See the config flag.
		if (SUPER_CONFIG.FREEZE_FLASH_GLOW_MATERIAL) ball.Material = Enum.Material.Neon;

		task.delay(SUPER_CONFIG.FREEZE_FLASH_SECONDS, () => {
			const base = this.flashes.get(ball);
			this.flashes.delete(ball);

			// The ball's child, so this goes with the ball in the ordinary case; destroying the light
			// explicitly is what makes the flash end on a ball that is still there.
			light.Destroy();

			// A ball destroyed before this fires has nothing to be put back — the round ended, or somebody
			// collected it — and `base` is nothing in exactly that case.
			if (base === undefined || ball.Parent === undefined) return;

			// **The material only.** The ball's colour is not this method's to restore, because this method
			// never wrote it: that is the whole point of the correction above.
			ball.Material = base.material;
		});
	}

	/**
	 * Freezes every body within `radius` of `origin`, except the ones `isExcluded` answers for, and
	 * answers with the bodies it took hold of.
	 *
	 * **The exclusion is the caller's, and that is a decision rather than a layering accident.** What
	 * must not freeze is "the thrower and their own side", and half of that rule belongs to the round —
	 * `RoundService.isFriendlyFire` is the single statement of who is on whose side, and this service
	 * cannot borrow it: the round already depends on *this* one, because it clears freezes when it ends.
	 * So the caller, which holds the thrower's token and the round's answer both, passes the test in, and
	 * this method is left with the part that is only about bodies.
	 *
	 * **A radius is a sphere of *parts*.** `GetPartBoundsInRadius` answers with every part whose bounds
	 * overlap the sphere — every limb of every body, and every wall, prop and loose ball besides — so
	 * this walks each of them back to the model it belongs to, keeps the ones that are bodies, and
	 * freezes each once. The test for "is this a body" is the one `BallComponent` makes of a single
	 * contact: a model with a `Humanoid` in it. (A thrown ball is a bare part in `Workspace` with no
	 * model above it, so it falls out here without a rule of its own.)
	 *
	 * **Nothing is passed to the query as a filter**, which is worth saying because the alternative
	 * looks tidier: an `Include` list would have to be the bodies inside the radius, which is the list
	 * this method exists to work out.
	 *
	 * **One query of the world rather than `Players:GetPlayers()` plus `CollectionService:GetTagged("NPC")`.**
	 * That pair of lists would cover the same bodies today — a player's character and a rig are the two
	 * kinds of body the game has — and it is the obvious way to write this. The world query wins on three
	 * counts that matter more than the enumeration being shorter. **There is nothing to keep in step**: a
	 * rig that is spawned, pooled or retired is inside the sphere or outside it by where it is standing,
	 * with no list that could have missed it. **The position comes from the parts rather than from a
	 * root lookup**: a body's root is not necessarily where the ball passed it — a limb is — and the
	 * sphere is the shape the ability is defined in. And **it makes a player and a rig the same branch**,
	 * which is the property that stops this ability from freezing one kind of body and not the other: the
	 * test for "is this a body" is a `Model` with a `Humanoid` above the parts, which both kinds answer
	 * identically, and nothing here has ever needed to know which kind it is holding.
	 *
	 * **A splash is one event, and this is the only place that knows it happened.** Three things come out of
	 * one: bodies held, the burst that says where the ball struck, and the authored `FreezeSplash` template
	 * stretched to the same radius. Both pictures are made here rather than inside {@link freeze} because
	 * `freeze` is called *per body* — four bodies caught is four calls — while an impact is one thing in one
	 * place, and a burst per body would be four bursts in one spot.
	 *
	 * **And this is why the template splash is triggered here rather than in `BallComponent`'s two branches**,
	 * which is where the two `freezeInRadius` calls are. The radius is *this method's own argument*: it already
	 * has the number the hit branch passed and the number the miss branch passed, so the picture cannot be
	 * scaled to anything other than what was frozen. A call at each of the two call sites would be the same
	 * two constants written twice — three places that could disagree about the size of one effect, and one of
	 * them free to be forgotten when a third call site is added. There is also exactly one call per impact
	 * here by construction, which is the "fires once per ball" rule the two branches would have had to keep
	 * with a flag of their own.
	 */
	public freezeInRadius(
		origin: Vector3,
		radius: number,
		isExcluded: (model: Model) => boolean,
	): Array<Model> {
		const caught: Array<Model> = [];
		const seen = new Set<Model>();

		// Every body the sphere found, with the reason it was or was not held — see `describeFound` for why
		// the reason travels beside the counts.
		const notes: Array<string> = [];

		// **The three numbers this method is asked about when it does nothing**, kept apart rather than
		// derived, because each one names a different fault. See the report below for which is which.
		let found = 0;
		let spared = 0;

		// **First, before a single body is looked at.** The freeze is the ability and the burst is only
		// the picture of it, so this is not precedence — it is that the burst fires whether or not anybody
		// is in range, and the point of that is the splash that caught nobody: a charge spent, with
		// nothing at all to show for it, which is the one state this ability could previously reach
		// silently. The burst says where the ball landed, for the thrower and for everybody else.
		this.buildBurst(origin);

		// **And the authored splash on the same terms, from the same two arguments.** The template is the other
		// picture of the same event, and it is drawn at the radius the freeze is about to use because that is
		// the radius this method was handed — see this method's doc for why the call is here rather than at the
		// two `freezeInRadius` call sites. A clone that fails to appear (a missing template, a template with no
		// part) warns once and returns; nothing below depends on it, so a splash problem costs the picture and
		// never a freeze.
		this.playFreezeSplash(origin, radius);

		for (const part of Workspace.GetPartBoundsInRadius(origin, radius)) {
			const model = part.FindFirstAncestorWhichIsA("Model");
			if (!model || seen.has(model)) continue;

			// Marked seen before the tests, so a body is examined once however many of its parts are in
			// the sphere — a torso, two arms and a head are four answers to one question.
			seen.add(model);
			found += 1;

			if (isExcluded(model)) {
				spared += 1;
				notes.push(`${model.Name} (spared)`);
				continue;
			}

			if (!model.FindFirstChildWhichIsA("Humanoid")) {
				// **Scenery, and named as such rather than dropped silently.** This is the commonest thing a
				// splash finds — the floor it landed on, the wall behind it, the practice area's own parts —
				// and it is the answer to "found two bodies and held none" in every case where the sphere
				// reached no rig at all.
				notes.push(`${model.Name} (no humanoid)`);
				continue;
			}

			if (this.freeze(model, SUPER_CONFIG.FREEZE_DURATION_SECONDS)) {
				caught.push(model);
				notes.push(`${model.Name} (held)`);
			} else {
				// `freeze` has already established there is a humanoid, so this is the pair it refuses on: a
				// body with no root part, or one whose health has gone. A corpse is the case that matters —
				// a rig killed a heartbeat ago is still standing in the sphere.
				notes.push(`${model.Name} (no root, or dead)`);
			}
		}

		/**
		 * **The splash reports itself, always, including when it found nothing — and this line is the fix
		 * for a report that could not be answered without it.**
		 *
		 * It used to be gated twice: behind `DEBUG_LOGGING`, and behind `caught.size() > 0`. So the *only* state it
		 * ever printed was the one that needed no explanation, and the two states worth asking about were
		 * identical in the output — a splash that examined every body and refused them all, and a splash
		 * that never ran at all. Both read as "the ice power does nothing", which is exactly the report
		 * this was written for. It is the same argument `BallComponent.noteDecidedNothing` makes about a
		 * refused contact, and the reason the tag line and `landHit` are ungated: a diagnostic that has to
		 * be switched on cannot explain a log somebody already has.
		 *
		 * **Three counts rather than one, because they are the three different faults.** `found` is the
		 * bodies the sphere touched at all; `spared` is the ones the caller's predicate refused; `caught`
		 * is the ones actually held. So:
		 *
		 * - **`found 0`** — the sphere is in the wrong place or is nothing: a ball that landed away from
		 *   everybody, or a radius that reached no part. Nothing below this line can be at fault.
		 * - **`found n, spared n`** — the rule refused every body in range. That is `splashSpares`
		 *   answering for the thrower, for a teammate (`RoundService.isFriendlyFire`), or for a player
		 *   standing in a practice zone — and the last of those is by design, see that method.
		 * - **`found n, spared m, caught 0`** with `n > m` — the bodies in range had no *living* humanoid
		 *   to hold: a corpse, a piece of scenery with a humanoid in it, or a body already dead. That is
		 *   the difference `freeze` refuses on, and it is why `freeze` returns a boolean rather than
		 *   storing and answering later.
		 *
		 * The radius is named too, because a splash with the wrong radius is indistinguishable from a
		 * splash with the right one that found nobody — and the two are set in `super.config.ts`, where
		 * somebody tuning the ability will be looking. **With both radii reading `8` as of 2026-10-18, the
		 * radius no longer says whether this was a hit or a miss**, and the line immediately before it does:
		 * `ended on … 0 tag(s) [Freeze]` for a miss, `was tagged by … [Freeze]` for a hit.
		 *
		 * **And the bodies are named, each with its reason** — see `describeFound`. The counts answer "did
		 * anything happen", and the list is what answers *why not*: a splash that found scenery and a splash
		 * that found rigs it refused are the same two numbers and two completely different faults.
		 */
		logInfo(
			`[Freeze] splash at ${origin} — radius ${radius}, found ${found} bod(ies), ` +
				`spared ${spared}, caught ${caught.size()} — ${describeFound(notes)}`,
		);

		return caught;
	}
}
