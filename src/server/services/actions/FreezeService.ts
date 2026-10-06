import { Service } from "@flamework/core";
import { Workspace } from "@rbxts/services";
import { SUPER_CONFIG } from "shared/config/super.config";
import { WalkSpeedService } from "../character/WalkSpeedService";
import { overrideOutlineColour } from "../visual/OutlineService";

/** Prints every freeze and every release, with what the body was doing before. */
const DEBUG = true;

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
 * How long past the last particle's expiry the burst's anchor part is kept alive, in seconds.
 *
 * The part carries the emitter and nothing else, so it has to outlive the particles it fires and not
 * much longer: destroyed on the exact frame the last shard expires, that shard is cut off a frame
 * early, and left for a whole second it is an invisible part sitting in `Workspace` that nothing can
 * see, nothing will collect, and nothing needs.
 */
const BURST_CLEANUP_MARGIN = 0.25;

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

		if (previous) {
			if (DEBUG) print(`[Freeze] ${model.Name}: still frozen — the clock restarted`);
		} else {
			// **One watcher per body, and both are the rule rather than a tidy-up.** A freeze is defined
			// to clear when its body dies, and a body that leaves the world cannot be thawed by anything —
			// so both are the same call, and neither fires twice for one freeze because they are connected
			// once. Connections on an instance die with it, so there is nothing to disconnect.
			humanoid.Died.Connect(() => this.unfreeze(model));
			model.Destroying.Connect(() => this.unfreeze(model));

			if (DEBUG) print(`[Freeze] ${model.Name}: frozen for ${string.format("%.2f", seconds)}s`);
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

		if (DEBUG) print(`[Freeze] ${model.Name}: released`);
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
	 * **A splash is one event, and this is the only place that knows it happened.** Two things come out of
	 * one: bodies held, and the burst that says where the ball struck. The burst is built here rather than
	 * inside {@link freeze} because `freeze` is called *per body* — four bodies caught is four calls —
	 * while an impact is one thing in one place, and a burst per body would be four bursts in one spot.
	 */
	public freezeInRadius(
		origin: Vector3,
		radius: number,
		isExcluded: (model: Model) => boolean,
	): Array<Model> {
		const caught: Array<Model> = [];
		const seen = new Set<Model>();

		// **First, before a single body is looked at.** The freeze is the ability and the burst is only
		// the picture of it, so this is not precedence — it is that the burst fires whether or not anybody
		// is in range, and the point of that is the splash that caught nobody: a charge spent, with
		// nothing at all to show for it, which is the one state this ability could previously reach
		// silently. The burst says where the ball landed, for the thrower and for everybody else.
		this.buildBurst(origin);

		for (const part of Workspace.GetPartBoundsInRadius(origin, radius)) {
			const model = part.FindFirstAncestorWhichIsA("Model");
			if (!model || seen.has(model)) continue;

			// Marked seen before the tests, so a body is examined once however many of its parts are in
			// the sphere — a torso, two arms and a head are four answers to one question.
			seen.add(model);

			if (isExcluded(model)) continue;
			if (!model.FindFirstChildWhichIsA("Humanoid")) continue;

			if (this.freeze(model, SUPER_CONFIG.FREEZE_DURATION_SECONDS)) caught.push(model);
		}

		if (DEBUG && caught.size() > 0) {
			print(`[Freeze] splash at ${origin} — caught ${caught.size()} bod(ies)`);
		}

		return caught;
	}
}
