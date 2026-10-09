import { BALL_CONFIG } from "shared/config/ball.config";
import { BALL_SIZE } from "shared/constants";

/** What every ribbon of the bright core is called, and how a ball that came back is recognised as already wearing one. */
const RIBBON_NAME = "FlightTrail";

/**
 * What every ribbon of the soft sheath around the core is called.
 *
 * A name of its own rather than a suffix on {@link RIBBON_NAME}, because the two are built and found
 * together and nothing ever wants one without the other: `ribbonsOf` is looking for both, and a shared
 * prefix would make a ball wearing only one of them look like a ball wearing both.
 */
const HALO_NAME = "FlightHalo";

/**
 * The shortest a trail segment may be and still be drawn, in studs.
 *
 * A ball that has landed and stopped is no longer armed — see `BallComponent`, whose world-contact
 * branch is what takes a spent ball out of play — but it is still *wearing* its ribbons, because
 * nothing disarms a trail until the ball is picked up or is thrown again. Without this it would record
 * a zero-length segment every frame for as long as it sat there, which is up to a minute. Those are
 * degenerate and draw as nothing, so this costs no visual and saves the engine the work — it is the
 * same guard as "no stray wisps while idle".
 */
const MIN_SEGMENT = 0.1;

/**
 * How much the ribbons glow, from `0` (a solid strip, blended normally) to `1` (fully
 * additive, so the colour is added to what is behind it rather than replacing it).
 *
 * Not in config, and that is the one thing worth saying about it: it is a *material* rather than a
 * setting, and the two layers share it instead of having a value each. It is what makes the trail read
 * as **light** rather than as coloured ribbon, which is the whole of the difference between a shooting
 * star and a streamer — and there is no version of that argument where the core is light and the haze
 * around it is fabric. What separates the layers is thickness and opacity, and both of those are config.
 *
 * At `1` the head saturates where the ribbons overlap, which is the effect wanted; if the trail ever
 * looks like a bright smear instead, this is the first thing to take down and it is one edit.
 *
 * **The saturation is a brightness effect and not a hue one, which is what the grey default turns on.** The
 * head of every trail washes toward white whatever colour it was asked for, so a def whose core is already
 * near white has nowhere left to show itself — the limit `economy.config.ts` keeps pointing at — while a
 * flat grey loses nothing to it, having no hue to wash out. That asymmetry is the whole reason the default
 * can sit at `1` while a cosmetic has to be saturated to read.
 */
const LIGHT_EMISSION = 1;

/**
 * The three the core is drawn in, in the direction the eye reads it.
 *
 * **The core alone, which is why it is a name rather than a shape written out twice.** Two things want
 * exactly these three and nothing more: the default the config supplies when nobody has equipped anything,
 * and {@link coreLook}, which builds the core's sequence from them. Only {@link TrailColors} has a haze.
 */
export interface CoreColors {
	leading: Color3;
	middle: Color3;
	trailing: Color3;
}

/**
 * Every colour a trail is drawn in, in the direction the eye reads it: the core's three, and the haze's pair.
 *
 * **Deliberately the shape `CosmeticDef.colors` has, field for field, which is the reason it is a named
 * interface here rather than five parameters**: `COSMETICS`' def is structurally this, so the economy can
 * hand a def's colours straight to {@link BallTrail.attach} without either file importing the other.
 *
 * **`halo` is required, and it is the field the whole interface exists for.** A cosmetic that stated only a
 * core would be drawn as a coloured ribbon inside `BALL_CONFIG`'s orange haze — and the haze is the wider
 * layer, the longer-lived one, and the one drawn *across* the core rather than behind it, so the ball would
 * go on looking like nobody's. The type refuses the half-specified cosmetic rather than letting it be
 * invisible, which is what it was until this field existed.
 */
export interface TrailColors extends CoreColors {
	/**
	 * The haze's two ends: where it leaves the ball, and where it is oldest. **There is no `middle` here and
	 * that is not an omission** — the halo's own colour sequence has two keypoints because it is a haze and
	 * not a second core, so a third colour would be one nothing ever reads. See `createRibbons`.
	 */
	halo: { leading: Color3; trailing: Color3 };
}

/**
 * The core's colours when nobody has equipped anything: {@link BALL_CONFIG}'s own three.
 *
 * **A plain object of references rather than a prepared `ColorSequence`, and that is a rule about this
 * project's loading rather than a preference.** A top-level initializer that *calls a function* runs
 * before the function's body has been assigned in the emitted Luau — roblox-ts hoists a bare `local` and
 * the call is `nil`, which takes the whole module down at require time and surfaces as "nothing loads"
 * with no compile error. Three property reads off a table cannot fail that way; the sequence is built
 * inside `attach` instead. `ThemeController.derive` documents the same trap from the other side.
 *
 * **`CoreColors` and not `TrailColors`, which is what the two names are for**: this is the *core's* default,
 * and the haze's is chosen by {@link haloLook} when the call is made. One object holding both would be a
 * second place the default could be written, disagreeing with `BALL_CONFIG` the day either was tuned.
 */
const DEFAULT_CORE_COLORS: CoreColors = {
	leading: BALL_CONFIG.TRAIL_COLOR_LEADING,
	middle: BALL_CONFIG.TRAIL_COLOR_MIDDLE,
	trailing: BALL_CONFIG.TRAIL_COLOR_TRAILING,
};

/**
 * The trail a ball leaves behind it: two sets of flat ribbons arranged around the ball's own
 * axis, which together read as a lit tube with a haze around it.
 *
 * **Why more than one.** A `Trail` is the only thing in the engine that *records a path*,
 * and recording the path is what makes the trail bend with a curving throw instead of
 * snapping to wherever the ball is pointing this frame. The price of a `Trail` is that it is
 * a flat strip that always turns to face the camera, so a single one reads as a sticker on
 * the screen no matter how well it tapers. Several at a spread of angles give the eye a
 * cross-section instead of a line, and whatever the camera angle at least two are near
 * face-on: the eye stitches the composite into a form with volume. This is the standard
 * Roblox answer to "a 3D trail", and it is still not *literally* cylindrical — from exactly
 * edge-on you can pick out individual ribbons — but it bends, it tapers, and it has depth
 * from everywhere a player will actually be looking at it.
 *
 * **Why two sets of them, which is the newer half of this.** The same count again, at the same angles
 * turned half a step, with a wider gap and a softer, longer-lived, more transparent ribbon: see
 * {@link BALL_CONFIG.TRAIL_HALO_ENABLED} for the argument and the whole of the tuning. Here it is one
 * loop rather than two mechanisms — a ribbon is a ribbon with different numbers on it — and the only
 * thing the second set changes about this file is that `createRibbons` returns twice as many and
 * `setArmed` turns twice as many off.
 *
 * **What this deliberately is not: a light and a particle emitter.** Both were weighed and both are
 * refused for one shared reason — *a `Trail` draws only while its attachments move, and neither of the
 * other two has that property.* A ball that has landed has spent its throw, but it keeps its trail
 * until somebody collects it, which can be a minute; with ribbons that is invisible, because a
 * stationary ribbon draws nothing, while a `PointLight` or an emitter would be a ball glowing and
 * spitting sparks on the floor for that whole minute. **The reason this is not merely an oversight is
 * that the ball has no flag meaning "in flight"**: `Armed` reads true for a ball a rig is *carrying*,
 * so it cannot gate them either. The honest hook is the end-of-throw branch in `BallComponent`, which
 * is where a throw's death is already resolved — worth doing when something else wants it, and until
 * then two more instances that can be left on are two more instances that can be left on.
 *
 * **Why it is a class at all.** The ribbons have to be turned on and off together, and the
 * caller wants to say that in one word — see {@link setArmed}. Everything else here is
 * construction.
 *
 * There is nothing to clean up. The ribbons and their attachments are children of the ball,
 * so they are destroyed with it, and there is no frame loop anywhere: a `Trail` is driven by
 * the engine recording where its attachments have been.
 */
export class BallTrail {
	/**
	 * Whether this trail was **found on the ball** rather than built by the {@link attach} that returned it.
	 *
	 * One fact, carried out of `attach` because there is nowhere else it can be known: an adopted trail that
	 * has just been repainted is indistinguishable from a fresh one by looking at the ball, and the caller
	 * that wants to say which happened is reading a log rather than a ball. Its one reader is the gated line
	 * at `BallService.attachToHand`.
	 */
	public readonly adopted: boolean;

	private constructor(private readonly ribbons: Trail[], adopted: boolean) {
		this.adopted = adopted;
	}

	/**
	 * Restates the trail's colours, both layers, or puts them back to the default when given nothing.
	 *
	 * **The second of the two moments a ball's colours are decided, and the later one.** {@link attach}
	 * states them when a ball changes hands; this states them when it leaves one. They are separate moments
	 * rather than one rule asked twice because a player can equip a trail *while already holding a ball*: the
	 * hand-off that read the record happened before the choice did, so a throw that trusted what `attach`
	 * stored would fly the colours the ball was picked up with. `BallService.throwBall` is the one caller, and
	 * that is the one reason.
	 *
	 * **A repaint of the ribbons already on the ball, never a rebuild, which is what makes it safe to call
	 * mid-throw.** That is not a nicety: the two layers' angles, their attachments and their count are one
	 * construction, and building it again would double every ribbon rather than replace it — the failure
	 * `attach`'s adopt branch exists to avoid. It is the same two writes that branch makes, through the same
	 * {@link recolourLayer}.
	 *
	 * **Both layers, and the haze is the half that has to be right.** Painting the core alone is what this
	 * method's own history is: the haze is wider, lives longer and is drawn *across* the core, so a recoloured
	 * core inside `BALL_CONFIG`'s orange haze reads as the default ball — which is what an equipped trail
	 * looked like until the defs carried a pair. Passing nothing is how a ball is *stripped* of somebody's
	 * colours when it arrives in the hands of a body with no cosmetic, so the default travels the same path as
	 * an override rather than being a special case.
	 */
	public setColors(colors?: TrailColors): void {
		recolourLayer(this.ribbons, RIBBON_NAME, coreLook(colors ?? DEFAULT_CORE_COLORS));
		recolourLayer(this.ribbons, HALO_NAME, haloLook(colors));
	}

	/**
	 * Arms or disarms the whole set: the `Armed` transition, in the ball's own terms.
	 *
	 * Every ribbon this ball is wearing, from both layers, which is the whole reason the returned object
	 * exists rather than the caller walking the ball's children.
	 *
	 * Disabling is also what clears the trail when a ball is caught. Existing segments are
	 * not dropped, they are left to expire on their own lifetime — so the trail the ball
	 * arrived on fades out where the ball was caught, over each layer's own lifetime rather than over
	 * one shared figure, which is what makes the haze outlive the streak here exactly as it does in the
	 * air — with nothing having to be cleared by hand.
	 */
	public setArmed(armed: boolean): void {
		for (const ribbon of this.ribbons) ribbon.Enabled = armed;
	}

	/**
	 * The trail `ball` should fly with: built now, or adopted from the last time it flew.
	 *
	 * A ball outlives a single hold — it is thrown, caught, thrown again — and its ribbons
	 * stay on it throughout, so this looks for the ones already there before making more. A
	 * second set would be a second trail drawn over the first, which is the one thing this
	 * must not do: the effect depends on there being exactly one ribbon at each layer's own angle and
	 * spread, and a second set would double the density of both while putting the halo's ribs back on
	 * top of the core's — the seam the half-step in `createRibbons` exists to avoid. `ribbonsOf` answers
	 * "already wearing a trail" from the ball itself rather than this assuming it.
	 *
	 * **`colors` is the trail the *holder* brings, and it is applied on both branches.** That second half
	 * is the part that is easy to get half-right and impossible to notice: a recolour that ran only where
	 * ribbons are *built* would work exactly once per ball and then stop, because every later hand the ball
	 * passed through would take the adopt branch and find the previous holder's colours still on it — a
	 * ball that goes on wearing a trail belonging to somebody who let go of it. So the adopt branch repaints
	 * the core too, and that is also the argument for taking the parameter rather than leaving the colours
	 * to construction: this method is *the* moment a ball changes hands, and a ball's appearance has to be
	 * restated at that moment rather than set once when the ribbon was made. It is why the default is
	 * applied through the same path — a ball picked up by a player wearing nothing has to *lose* the last
	 * holder's colours, which only happens if the default is written as deliberately as an override is.
	 *
	 * **And this is the first of two moments rather than the only one.** The colours are stated again at the
	 * throw, when the holder may have equipped something since the ball came into their hand — see
	 * {@link setColors}, which is this rule asked a second time rather than a second rule.
	 *
	 * **What recolours is both layers, and the haze is the one that decides what a trail looks like.** A def's
	 * `colors.halo` drives the haze's two ends and its `leading`/`middle`/`trailing` drive the core's, so an
	 * equipped trail is that cosmetic's own effect rather than a coloured ribbon inside the default ball's
	 * orange glow — which is what it was while the haze came only from config, and why an equipped trail used
	 * to look like nobody's. **Deriving the haze from the core is still refused**, and for exactly the reason
	 * it was refused before a def could carry one: a computed haze would replace `BALL_CONFIG`'s own tuning on
	 * every ball in the game, including the ones nobody has equipped anything on, which is a change to every
	 * default ball's look bought with a cosmetic. So the pair is *stated* per def instead — required by
	 * {@link TrailColors}, so a def that omits it is a compile error rather than an invisible cosmetic.
	 *
	 * Returns nothing when the trail is switched off, which is the whole of what
	 * {@link BALL_CONFIG.TRAIL_ENABLED} does: no ribbon is built, so "off" means the
	 * instances are not there rather than that they are idle.
	 */
	public static attach(ball: BasePart, colors?: TrailColors): BallTrail | undefined {
		if (!BALL_CONFIG.TRAIL_ENABLED) return undefined;

		const core = coreLook(colors ?? DEFAULT_CORE_COLORS);
		const halo = haloLook(colors);

		const existing = ribbonsOf(ball);
		if (existing.size() > 0) {
			const trail = new BallTrail(existing, true);
			trail.setColors(colors);
			trail.setArmed(false);
			return trail;
		}

		return new BallTrail(createRibbons(ball, core, halo), false);
	}
}

/** The core's colour sequence for `colors`, at the same keypoint the default uses. */
function coreLook(colors: CoreColors): ColorSequence {
	return new ColorSequence([
		new ColorSequenceKeypoint(0, colors.leading),
		new ColorSequenceKeypoint(BALL_CONFIG.TRAIL_COLOR_MIDDLE_AT, colors.middle),
		new ColorSequenceKeypoint(1, colors.trailing),
	]);
}

/**
 * The haze's colour sequence for `colors`, or `BALL_CONFIG`'s own pair when nobody has equipped anything.
 *
 * **Two keypoints rather than the core's three**, because the haze is a haze and not a second core: it is
 * never anything but a fade from the colour at the ball to the colour it dies as, and a middle keypoint
 * would be one `createRibbons` never reads. `TrailColors.halo` is shaped to match.
 *
 * **The fallback is read here rather than kept in a prepared constant**, which is `DEFAULT_CORE_COLORS`'s
 * rule seen from the other side: it has to be chosen when the call is made rather than when the module
 * loads, because a top-level initializer naming a config field is the trap that doc describes.
 */
function haloLook(colors?: TrailColors): ColorSequence {
	return new ColorSequence([
		new ColorSequenceKeypoint(0, colors?.halo.leading ?? BALL_CONFIG.TRAIL_HALO_COLOR_LEADING),
		new ColorSequenceKeypoint(1, colors?.halo.trailing ?? BALL_CONFIG.TRAIL_HALO_COLOR_TRAILING),
	]);
}

/**
 * Repaints one layer of a trail that is already built: every ribbon named `name`.
 *
 * **By name rather than by position**, because `createRibbons` builds the two layers interleaved and a
 * count would have to be kept in step with it; {@link RIBBON_NAME} and {@link HALO_NAME} already answer
 * "which layer is this" for `ribbonsOf`, and this is the same question. The name is a parameter rather than
 * two near-identical functions because which layer is meant is the only thing that ever differs between the
 * callers — and two copies of one loop is how one of them comes to be fixed and the other not.
 */
function recolourLayer(ribbons: Trail[], name: string, color: ColorSequence): void {
	for (const ribbon of ribbons) {
		if (ribbon.Name === name) ribbon.Color = color;
	}
}

/** Every ribbon on `ball`, both layers, which is how a ball that has just been caught is recognised. */
function ribbonsOf(ball: BasePart): Trail[] {
	const ribbons: Trail[] = [];

	for (const child of ball.GetChildren()) {
		// Both names, because what this is for is *a ball already wearing a trail* rather than a
		// particular set of ribbons — the caller only ever wants to turn them all off. Asking by name
		// beats counting, since the count is config and the two layers are always built in one go.
		if (child.IsA("Trail") && (child.Name === RIBBON_NAME || child.Name === HALO_NAME)) ribbons.push(child);
	}

	return ribbons;
}

/**
 * Builds the whole effect on `ball`: the core ribbons, and the halo's around them.
 *
 * **Every sequence here runs over a segment's *age***, which is the one convention to hold on to when
 * reading any of them: keypoint `0` is the newest end — the one still at the ball — and `1` is the
 * oldest. So they are written in the direction the eye reads the trail and none of them is reversed:
 * wide and opaque at the ball, narrow and invisible behind it. Those are keypoints on *age* and not on
 * distance, which is why a faster throw draws a longer trail from the same numbers. Same for the colour,
 * which runs from a def's leading end to its trailing one on the way — the default's three are one grey, so
 * it carries no gradient to read in either direction. The halo obeys the same rule, so its numbers read
 * backwards in exactly the same way.
 *
 * The angles are placed evenly around the ball's **local Z axis** rather than around
 * whatever axis the ball happens to be travelling along, which is a deliberate and invisible
 * simplification: the ball spins, so any local axis is as good as any other over the course
 * of a throw, and the ribbons are spread across the whole circle regardless. Picking the
 * axis from the velocity would mean rewriting every attachment's position every frame, which
 * is exactly the per-frame work this approach exists to avoid.
 *
 * **The two layers are the same shape at different sizes, and the halo is placed between the core's
 * angles rather than on top of them.** Half a step round, which is the one fiddly thing in this file
 * and is worth the trouble: two ribbons in the same plane at the same angle are two surfaces competing
 * for the same pixels, and a narrow bright one drawn through a wide soft one is a seam. Half a step
 * makes the layers interleave — at `TRAIL_COUNT` of 4 that is core ribbons at `0°`, `45°`, `90°`, `135°`
 * and halo ribbons at `22.5°`, `67.5°`, `112.5°`, `157.5°` — so eight ribs span the circle rather than
 * four drawn twice. It is also why switching the halo off leaves a clean star rather than a shape with
 * a gap in it.
 *
 * One attachment of each pair sits at `+offset` and the other at `-offset` along its angle,
 * so all of them pass through the ball's centre: the pair is a diameter of the trail's
 * cross-section, and the gap between them is the ribbon's width.
 *
 * **`core` and `halo` are the holder's colours, resolved by the caller rather than read from config here.**
 * That is the whole of what makes an equipped trail look like itself: this function is the only place the
 * two layers' colours are set at construction, so both of them arrive as arguments. The default ball's pair
 * travels through the same two parameters — `coreLook` and `haloLook` are where `BALL_CONFIG` is read.
 */
function createRibbons(ball: BasePart, core: ColorSequence, halo: ColorSequence): Trail[] {
	const ribbons: Trail[] = [];
	const step = math.pi / BALL_CONFIG.TRAIL_COUNT;

	for (let index = 0; index < BALL_CONFIG.TRAIL_COUNT; index++) {
		ribbons.push(
			buildRibbon(ball, RIBBON_NAME, index, index * step, BALL_SIZE * BALL_CONFIG.TRAIL_SPREAD, {
				color: core,
				transparency: new NumberSequence([
					new NumberSequenceKeypoint(0, 0),
					new NumberSequenceKeypoint(1, 1),
				]),
				width: new NumberSequence([
					new NumberSequenceKeypoint(0, BALL_CONFIG.TRAIL_WIDTH_LEADING),
					new NumberSequenceKeypoint(BALL_CONFIG.TRAIL_WIDTH_NECK_AT, BALL_CONFIG.TRAIL_WIDTH_NECK),
					new NumberSequenceKeypoint(1, BALL_CONFIG.TRAIL_WIDTH_TRAILING),
				]),
				lifetime: BALL_CONFIG.TRAIL_LIFETIME,
			}),
		);

		if (!BALL_CONFIG.TRAIL_HALO_ENABLED) continue;

		ribbons.push(
			buildRibbon(
				ball,
				HALO_NAME,
				index,
				index * step + step / 2,
				BALL_SIZE * BALL_CONFIG.TRAIL_HALO_SPREAD,
				{
					// **The caller's haze, on the same footing as the core above.** Its two ends are the half of a
					// trail cosmetic the eye actually reads — see `TrailColors` — so this line is where an equipped
					// trail stops looking like a default one.
					color: halo,
					// Never opaque at the head, and always gone at the tail. The second end is not a knob:
					// a haze with a visible edge is a ribbon again, which is what this layer is not.
					transparency: new NumberSequence([
						new NumberSequenceKeypoint(0, BALL_CONFIG.TRAIL_HALO_TRANSPARENCY_LEADING),
						new NumberSequenceKeypoint(1, 1),
					]),
					width: new NumberSequence([
						new NumberSequenceKeypoint(0, BALL_CONFIG.TRAIL_HALO_WIDTH_LEADING),
						new NumberSequenceKeypoint(1, BALL_CONFIG.TRAIL_HALO_WIDTH_TRAILING),
					]),
					lifetime: BALL_CONFIG.TRAIL_HALO_LIFETIME,
				},
			),
		);
	}

	return ribbons;
}

/**
 * Everything one ribbon needs that is not where it sits: what its two ends look like, and how long a
 * segment of it lives.
 *
 * A parameter object rather than five more positional arguments, because the call would otherwise be
 * eight long and three of the eight are sequences — a call nobody can read, and reading it is the only
 * way to check it.
 */
interface RibbonLook {
	color: ColorSequence;
	transparency: NumberSequence;
	width: NumberSequence;
	lifetime: number;
}

/**
 * Builds one ribbon and the pair of attachments it is drawn between.
 *
 * `angle` is in radians around the ball's local Z axis, and both attachments sit on that line — one at
 * `+offset` from the ball's centre and one at `-offset` — so every ribbon is a diameter of the trail's
 * cross-section rather than a chord of it. See `createRibbons` for why that matters and
 * {@link RibbonLook} for the rest.
 */
function buildRibbon(
	ball: BasePart,
	name: string,
	index: number,
	angle: number,
	offset: number,
	look: RibbonLook,
): Trail {
	const out = new Vector3(math.cos(angle), math.sin(angle), 0).mul(offset);

	const ribbon = new Instance("Trail");
	ribbon.Name = name;
	ribbon.Attachment0 = attachment(ball, name, index, "A", out);
	ribbon.Attachment1 = attachment(ball, name, index, "B", out.mul(-1));
	ribbon.Color = look.color;
	ribbon.Transparency = look.transparency;
	ribbon.WidthScale = look.width;
	ribbon.Lifetime = look.lifetime;
	ribbon.MinLength = MIN_SEGMENT;
	ribbon.LightEmission = LIGHT_EMISSION;
	// **Only when there is a texture to apply**, so a config with none leaves the engine's own defaults
	// for these three alone rather than writing an empty id over them. See `TRAIL_TEXTURE`.
	if (BALL_CONFIG.TRAIL_TEXTURE !== "") {
		ribbon.Texture = BALL_CONFIG.TRAIL_TEXTURE;
		ribbon.TextureMode = BALL_CONFIG.TRAIL_TEXTURE_MODE;
		ribbon.TextureLength = BALL_CONFIG.TRAIL_TEXTURE_LENGTH;
	}
	// Held until the throw. `FaceCamera` is left alone on purpose: the whole effect
	// depends on the ribbons always turning to face the camera.
	ribbon.Enabled = false;
	ribbon.Parent = ball;

	return ribbon;
}

/** One end of a ribbon's cross-section, named off its layer so no two of them collide in the Explorer. */
function attachment(ball: BasePart, ribbon: string, index: number, side: string, position: Vector3): Attachment {
	const point = new Instance("Attachment");
	point.Name = `${ribbon}${side}${index}`;
	point.Position = position;
	point.Visible = false;
	point.Parent = ball;

	return point;
}
