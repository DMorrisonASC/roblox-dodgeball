import { Debris, Workspace } from "@rbxts/services";
import type { AbilityKind } from "shared/ability";

/**
 * **The mystery box's look, as four layers that are built once and then only recoloured.**
 *
 * **What this replaces, and why it needed replacing.** A box used to be a plain `Part` whose only claims on the eye
 * were a `Color3` walked around the hue wheel and a `Highlight` outline — a coloured cube, floating. That is enough
 * to answer *what is that* and nowhere near enough to answer *should I cross the arena for it*, which is the whole
 * job of a prize that spawns at 5% per point per ten seconds. A box nobody notices is a box nobody collects, and the
 * mechanic then reads as absent rather than as rare.
 *
 * **Four layers, each doing a different job, and each one can be removed without touching the others:**
 *
 * 1. **The aura** — a slow upward drift of sparkles on the box itself. Says *this is alive*, at every distance.
 * 2. **The pillar** — a vertical light shaft rising out of the box. Says *over here*, across the arena, which is the
 *    one sentence the others cannot say at range.
 * 3. **The spawn burst** — a one-shot radial pop when it appears. Says *it just arrived*, for the player who happens
 *    to be looking.
 * 4. **The collection burst** — the same pop, coloured by the prize. Says *you got the Freeze one*, before the HUD
 *    has drawn anything.
 *
 * **There was a fifth, and it was removed on sight.** Two crossed `Neon` bars at the box's equator, meant to read as an
 * orbital band; the report was *"remove the sticks poking out"*, which is exactly what they were. **The lesson is worth
 * keeping rather than the code**: a solid ring round a box has to be wider than the box, so its silhouette is two
 * nubs from every angle a player can stand at, and two *straight* bars are the worst version of that — they end
 * abruptly in mid-air with nothing connecting them. A ring that reads as a ring needs a torus, which is a mesh, which
 * is an upload this feature is not allowed to need. **What is left is the honest set of layers that work without
 * geometry**, and the equator is simply not marked.
 *
 * **Everything that is left is a child of the box**, and that is the design rather than an accident: a part's children
 * are destroyed with it, so `MysteryBoxService`'s three teardown paths — `remove`, `sweepField`, `forgetLostSpawns` —
 * need no work at all for the aura, the pillar or the light. The alternative, a registry of effect instances keyed by
 * box, would have been a fourth thing to keep in step with a map that already has three ways to lose a row, and one
 * forgotten entry is a beam left standing over an empty spawn point forever. **The two bursts are the only effects that
 * outlive their box**, because they have to be drawn at a box that is being destroyed in the same frame; they are
 * parented to `Workspace` and handed to `Debris`.
 *
 * **No `TweenService`, and no per-effect loop of this module's own.** The motion is `MysteryBoxService.stepMotion`,
 * which already runs once a frame while a box is out and already computes a clock; this module takes that clock as an
 * argument. Two loops animating one object is two rates to keep in step, and the box's float is the thing the other
 * layers have to agree with.
 *
 * **What is deliberately not here.** No change to the `Highlight` or to the six `?` faces (both still built in
 * `place`, both still the box's own furniture), no geometry change to the box, no external asset ids beyond Roblox's
 * own sparkle, and no new tag — the layers are found through the handle `mountMysteryBoxVfx` answers, not through a
 * second registry.
 */

/**
 * **The stock Roblox sparkle.** A soft four-point star, which is the shape everybody already reads as *prize*.
 *
 * **`rbxasset://` rather than an uploaded id**, because this has to work in a place file nobody has edited: an
 * `rbxassetid://` would be a dependency on an upload that does not exist yet, and the prompt's rule — no external
 * assets — is the right one for a feature that should look finished before an artist touches it.
 *
 * **If it ever fails to resolve, the escape hatch is to delete this line.** A `ParticleEmitter` with no `Texture`
 * draws a plain square, and at `AURA_SIZE` with a fade in and out that still reads as a mote of light — worse than a
 * star, far better than nothing. That is said here so the fallback is a decision somebody can take in five seconds
 * rather than a hunt for what broke.
 */
const SPARKLE_TEXTURE = "rbxasset://textures/particles/sparkles_main.dds";

/** How many sparkles the aura gives up per second, per box. **Placeholder.** */
const AURA_RATE = 6;

/** How long one aura sparkle lives, in seconds. A range, so they do not all die on the same frame. **Placeholder.** */
const AURA_LIFETIME_MIN = 1.2;
const AURA_LIFETIME_MAX = 1.9;

/** How fast an aura sparkle leaves the box, in studs per second. **Placeholder.** */
const AURA_SPEED_MIN = 1.2;
const AURA_SPEED_MAX = 2.6;

/** How big an aura sparkle is at its widest, in studs — about a sixth of the box's own width. **Placeholder.** */
const AURA_SIZE = 0.45;

/** How hard the aura's sparkles are pushed upward, in studs per second squared. **Placeholder.** */
const AURA_RISE = 3;

/**
 * **The aura's colour, and it deliberately does not cycle with the box.**
 *
 * The box, the ring, the pillar and the light all take the hue; the sparkles stay a warm near-white. Two reasons, and
 * neither is laziness. **Contrast**: a sparkle the same colour as the thing it is floating off is invisible against
 * it, and the hue wheel passes through near-white yellows where a white sparkle would vanish entirely. **Cost**: the
 * emitter's `Color` is a `ColorSequence`, so cycling it means allocating one three times a second per box for a
 * difference nobody can see. A fixed warm white reads as *light* rather than as *paint*, which is the one thing on
 * this list that should not be the box's colour.
 */
const AURA_COLOUR = Color3.fromRGB(255, 244, 214);

/** How far above the box's own top face the pillar reaches, in studs. **Placeholder.** */
const PILLAR_HEIGHT = 12;

/** The pillar's width at the box, and at its top. Narrow at the source, opening upward. **Placeholder.** */
const PILLAR_WIDTH_BASE = 0.9;
const PILLAR_WIDTH_TOP = 2.2;

/** How opaque the pillar is where it leaves the box, and at its top. **Placeholder.** */
const PILLAR_ALPHA_BASE = 0.55;
const PILLAR_ALPHA_TOP = 1;

/** The point light's reach in studs, and the brightness it pulses between. **Placeholder.** */
const LIGHT_RANGE = 12;
const LIGHT_MIN = 0.45;
const LIGHT_MAX = 1.9;

/** **How long one brightness pulse takes**, in seconds. **Placeholder.** */
const LIGHT_PULSE_PERIOD = 2.6;

/** How many sparkles a spawn and a collection throw, and how long their holder part lives. **Placeholder.** */
const SPAWN_BURST = 26;
const PRIZE_BURST = 32;
const BURST_HOLDER_SECONDS = 1.4;

/** How fast a burst sparkle leaves the box, and how hard it is dragged back, in studs per second. **Placeholder.** */
const BURST_SPEED_MIN = 16;
const BURST_SPEED_MAX = 30;
const BURST_DRAG = 7;

/**
 * **What a prize looks like, for one instant, at the place the box used to be.**
 *
 * `Record<AbilityKind, Color3>` rather than a lookup table of pairs, for `ABILITY_NAMES`' reason in
 * `shared/ability.ts`: adding a member to the union without naming a colour here is a compile error rather than a
 * silent fallback to grey. The three are chosen to be told apart *at a glance from a sparkle burst* rather than to
 * match the powers' own HUD colours — a burst is 32 points of light for half a second, so the useful property is
 * distance from its neighbours on the wheel, not fidelity to a design nobody has settled.
 *
 * **Not exported, because the burst is the only reader.** A caller that wants "the colour of Freeze" is asking for a
 * second place for the palette to live; what a caller wants is {@link burstMysteryBoxPrize}.
 */
const PRIZE_COLOURS: Record<AbilityKind, Color3> = {
	Pierce: Color3.fromRGB(90, 150, 255),
	MultiBall: Color3.fromRGB(110, 235, 130),
	Freeze: Color3.fromRGB(120, 240, 255),
};

/**
 * Everything one box's look is made of, held so [the animation]{@link animateMysteryBoxVfx} and
 * [the recolour]{@link recolourMysteryBoxVfx} do not have to find it again by name.
 *
 * **Held as instances rather than rebuilt per frame**, which is the whole point of a handle: `stepMotion` runs sixty
 * times a second per box and `FindFirstChild` four times in it would be two hundred lookups a second to find things
 * that have not moved.
 *
 * **All three are children of the box, so all three die with it** — `MysteryBoxService`'s teardown paths destroy the
 * box and nothing else. That property used to be broken by the ring bars, which lived in `Workspace` and needed a
 * disposal of their own; they are gone, and this handle went back to describing only things a `box.Destroy()` takes.
 */
export interface MysteryBoxVfx {
	aura: ParticleEmitter;
	pillar: Beam;
	light: PointLight;
}

/**
 * **Builds every permanent layer onto `box` and answers the handle.**
 *
 * **`colour` is passed in rather than read off the box**, so the very first frame of a box's life is already the
 * rainbow's current colour instead of some default the cycle has not corrected yet. Without it a box appears one
 * colour for up to a third of a second and then snaps to wherever the wheel is, which reads as a glitch on the one
 * frame a player is most likely to be looking at it.
 *
 * **Nothing here is a `BasePart`, and that is the property the aim guide depends on.** The guide's cast treats a
 * `CanQuery` part as the world, so any solid geometry hung on a box would have to be `CanQuery = false` or it would put
 * a stop in the trajectory preview a few studs from the box a player is aiming past — the fault `MysteryBoxService`
 * documents for the box itself, arriving again through a decoration. An `Attachment`, a `Beam`, a `ParticleEmitter` and
 * a `PointLight` all extend `Instance` rather than `BasePart`, so the whole layer is invisible to every raycast in the
 * game by construction rather than by a flag somebody has to remember. **That is a second reason the ring bars went**:
 * they were the only part of this module that had to be a real part.
 */
export function mountMysteryBoxVfx(box: BasePart, colour: Color3): MysteryBoxVfx {
	// **The aura hangs off the box's own centre, so it rides the float and the spin.** An attachment on the spawn
	// point instead would leave a column of sparkles standing where the box used to be, which is a second thing on
	// screen competing with the pillar — and the pillar is the one allowed to be stationary-ish, because it is the
	// thing that says *here*.
	const auraAt = new Instance("Attachment");
	auraAt.Name = "AuraAt";
	auraAt.Parent = box;

	const aura = new Instance("ParticleEmitter");
	aura.Name = "Aura";
	aura.Texture = SPARKLE_TEXTURE;
	aura.Rate = AURA_RATE;
	aura.Lifetime = new NumberRange(AURA_LIFETIME_MIN, AURA_LIFETIME_MAX);
	aura.Speed = new NumberRange(AURA_SPEED_MIN, AURA_SPEED_MAX);
	// Widest in the middle of its life, nothing at either end: a sparkle that appears at full size is a sparkle that
	// pops, and one that vanishes at full size is a sparkle that was cut off.
	aura.Size = new NumberSequence([
		new NumberSequenceKeypoint(0, 0),
		new NumberSequenceKeypoint(0.4, AURA_SIZE),
		new NumberSequenceKeypoint(1, 0),
	]);
	aura.Transparency = new NumberSequence([
		new NumberSequenceKeypoint(0, 1),
		new NumberSequenceKeypoint(0.25, 0.15),
		new NumberSequenceKeypoint(1, 1),
	]);
	aura.Color = new ColorSequence(AURA_COLOUR);
	// **Lit by its own light rather than by the sun.** `LightInfluence = 0` stops the arena's shadow map darkening the
	// sparkles on the side away from the light — a prize that dims when the round turns is a prize that looks broken.
	aura.LightEmission = 1;
	aura.LightInfluence = 0;
	// Fully spherical, so the drift comes from `Acceleration` rather than from the emission cone: a narrow cone makes
	// a fountain, and a fountain out of a floating box reads as a leak.
	aura.SpreadAngle = new Vector2(180, 180);
	aura.Acceleration = new Vector3(0, AURA_RISE, 0);
	aura.Parent = auraAt;

	// **The pillar rises from the box's own top face, not from its centre.** A beam starting at the centre is drawn
	// through the box, so half of it is hidden and the other half appears to come out of nowhere; starting it at the
	// face is what makes it look attached. `box.Size.Y` is read rather than `MYSTERY_CONFIG.SIZE` so a box resized in
	// the config moves its pillar with it.
	const pillarBase = new Instance("Attachment");
	pillarBase.Name = "PillarBase";
	pillarBase.Position = new Vector3(0, box.Size.Y / 2, 0);
	pillarBase.Parent = box;

	const pillarTop = new Instance("Attachment");
	pillarTop.Name = "PillarTop";
	pillarTop.Position = new Vector3(0, box.Size.Y / 2 + PILLAR_HEIGHT, 0);
	pillarTop.Parent = box;

	const pillar = new Instance("Beam");
	pillar.Name = "Pillar";
	pillar.Attachment0 = pillarBase;
	pillar.Attachment1 = pillarTop;
	pillar.Width0 = PILLAR_WIDTH_BASE;
	pillar.Width1 = PILLAR_WIDTH_TOP;
	// **No texture, deliberately.** A beam with an empty `Texture` is a solid ribbon whose `Transparency` gradient
	// does all the work, which is exactly the soft shaft this layer wants — and it costs no asset, where a scrolling
	// sparkle texture would need a `TextureLength` and a `TextureSpeed` tuned to read as anything but noise.
	pillar.Transparency = new NumberSequence([
		new NumberSequenceKeypoint(0, PILLAR_ALPHA_BASE),
		new NumberSequenceKeypoint(1, PILLAR_ALPHA_TOP),
	]);
	pillar.Color = new ColorSequence(colour);
	pillar.LightEmission = 1;
	pillar.LightInfluence = 0;
	// **Face-on rather than a ribbon in world space.** A beam is drawn as a flat strip until `FaceCamera` is on, which
	// would make the pillar disappear when a player walks round to look at it edge-on — the one direction a signal
	// fire must not have a blind spot in.
	pillar.FaceCamera = true;
	pillar.Segments = 10;
	pillar.Parent = box;

	const light = new Instance("PointLight");
	light.Name = "Glow";
	light.Color = colour;
	light.Brightness = LIGHT_MAX;
	light.Range = LIGHT_RANGE;
	// **No shadows.** A moving light casting shadows re-renders the shadow map every frame for a decoration, and the
	// box is `CanCollide = false` — nothing it could plausibly occlude is near it.
	light.Shadows = false;
	light.Parent = box;

	return { aura, pillar, light };
}

/**
 * **Puts one colour on the pillar and the light — the two things that are allowed to take the hue.**
 *
 * **Called from the rainbow's own step, not from the frame loop.** The hue moves three times a second by design (see
 * `cycleColours` for the argument that sixty writes to arrive at three is waste), so the recolour inherits that rate
 * rather than adding a second one. The `ColorSequence` is rebuilt rather than mutated because the datatype is
 * immutable — one small allocation per box per step, which at three boxes and three steps a second is nine.
 *
 * **The aura is not in this list**, and it never will be: see {@link AURA_COLOUR}.
 */
export function recolourMysteryBoxVfx(vfx: MysteryBoxVfx, colour: Color3): void {
	vfx.pillar.Color = new ColorSequence(colour);
	vfx.light.Color = colour;
}

/**
 * **The frame's worth of motion: the light breathes.**
 *
 * **It was `Brightness` *and* a turning ring, and the ring is gone** — see this file's header for why it was the wrong
 * shape. What is left is one number per box per frame, which is close to free.
 *
 * **Computed from `clock` rather than accumulated**, for the reason `stepMotion` gives about the box's own float — a
 * long frame cannot put the pulse out of step with itself, and the light stays in phase with the box it decorates
 * whatever the frame rate does. `clock` is `stepMotion`'s `time()` reading, passed in rather than taken again so one
 * frame is one instant.
 *
 * **The pulse is a raised cosine**, so brightness eases at both ends of its range instead of reversing abruptly at
 * them — the same shape the box's float uses, applied to a number rather than a position.
 */
export function animateMysteryBoxVfx(vfx: MysteryBoxVfx, clock: number): void {
	const pulse = 0.5 - 0.5 * math.cos((clock / LIGHT_PULSE_PERIOD) * math.pi * 2);

	vfx.light.Brightness = LIGHT_MIN + (LIGHT_MAX - LIGHT_MIN) * pulse;
}

/**
 * **One radial pop of sparkles at `at`, in `colour`. The spawn and the collection are the same effect at two sizes.**
 *
 * **A `Workspace` part handed to `Debris`, rather than an emitter on the box**, and that is not a preference: the
 * collection burst has to be drawn at a box that is about to be destroyed, so anything parented to it would go with
 * it in the same frame. `Debris` is the cleanup for exactly this shape of object and `spawnPoof` already uses it for
 * the same reason — the box holds no reference to this afterwards, so a burst fired a frame before a server shutdown
 * leaves nothing behind and nothing to remember.
 *
 * **`Enabled = false` and `:Emit(n)` rather than `Rate`**, because this is a burst: a rate would trickle for as long
 * as the holder lived, and the holder lives `BURST_HOLDER_SECONDS` only so the frame that fired is not the frame that
 * destroys it. `Emit` is the manual burst the class exists for.
 *
 * **`Drag` rather than `Acceleration` to slow it**, so the particles decelerate together and stop near the box rather
 * than curving away like debris — the point of the effect is to mark a place, and a burst that scatters has marked
 * nothing by the time it fades.
 */
function burst(at: CFrame, colour: Color3, count: number): void {
	const holder = new Instance("Part");
	holder.Name = "MysteryBurst";
	holder.Size = Vector3.one;
	holder.Transparency = 1;
	holder.Anchored = true;
	holder.CanCollide = false;
	holder.CanQuery = false;
	holder.CanTouch = false;
	holder.CFrame = at;
	holder.Parent = Workspace;

	const burstEmitter = new Instance("ParticleEmitter");
	burstEmitter.Texture = SPARKLE_TEXTURE;
	burstEmitter.Enabled = false;
	burstEmitter.Lifetime = new NumberRange(0.35, 0.7);
	burstEmitter.Speed = new NumberRange(BURST_SPEED_MIN, BURST_SPEED_MAX);
	burstEmitter.Drag = BURST_DRAG;
	burstEmitter.Size = new NumberSequence([
		new NumberSequenceKeypoint(0, AURA_SIZE * 1.6),
		new NumberSequenceKeypoint(1, 0),
	]);
	burstEmitter.Transparency = new NumberSequence([
		new NumberSequenceKeypoint(0, 0.1),
		new NumberSequenceKeypoint(1, 1),
	]);
	burstEmitter.Color = new ColorSequence(colour);
	burstEmitter.LightEmission = 1;
	burstEmitter.LightInfluence = 0;
	// Spherical, so the pop goes everywhere rather than only upward. The upward drift belongs to the aura's
	// `Acceleration`, and `Vector3.zero` here says "this is the version that has no preferred direction".
	burstEmitter.SpreadAngle = new Vector2(180, 180);
	burstEmitter.Acceleration = Vector3.zero;
	burstEmitter.Parent = holder;

	burstEmitter.Emit(count);

	Debris.AddItem(holder, BURST_HOLDER_SECONDS);
}

/**
 * **The "it just appeared" moment**, in the box's own current colour.
 *
 * **Paired with a `playSpawnPoof` at the same point by the caller**, and the two are not redundant: the poof is the
 * effect the rest of the game already uses for a body arriving — a grid-and-dust burst every player has seen a
 * hundred times — and this adds the sparkle on top of it. Reusing the poof rather than writing a second arrival
 * effect is what keeps "something appeared here" one look across the game.
 */
export function burstMysteryBoxSpawn(at: CFrame, colour: Color3): void {
	burst(at, colour, SPAWN_BURST);
}

/**
 * **The "you got this one" moment**, coloured by what was rolled.
 *
 * It carries the `AbilityKind` rather than a `Color3` so the palette stays in this file: a caller picking a colour
 * would be a second opinion about what Freeze looks like, two files apart from the first.
 */
export function burstMysteryBoxPrize(at: CFrame, kind: AbilityKind): void {
	burst(at, PRIZE_COLOURS[kind], PRIZE_BURST);
}
