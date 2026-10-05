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
 * At `1` the head saturates to white where the ribbons overlap and the red tail stays a dull ember,
 * which is the effect wanted; if the trail ever looks like a bright smear instead, this is the first
 * thing to take down and it is one edit.
 */
const LIGHT_EMISSION = 1;

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
	private constructor(private readonly ribbons: Trail[]) {}

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
	 * Returns nothing when the trail is switched off, which is the whole of what
	 * {@link BALL_CONFIG.TRAIL_ENABLED} does: no ribbon is built, so "off" means the
	 * instances are not there rather than that they are idle.
	 */
	public static attach(ball: BasePart): BallTrail | undefined {
		if (!BALL_CONFIG.TRAIL_ENABLED) return undefined;

		const existing = ribbonsOf(ball);
		if (existing.size() > 0) {
			const trail = new BallTrail(existing);
			trail.setArmed(false);
			return trail;
		}

		return new BallTrail(createRibbons(ball));
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
 * which cools from the hot end to the ember one on the way. The halo obeys the same rule, so its numbers
 * read backwards in exactly the same way.
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
 */
function createRibbons(ball: BasePart): Trail[] {
	const ribbons: Trail[] = [];
	const step = math.pi / BALL_CONFIG.TRAIL_COUNT;

	for (let index = 0; index < BALL_CONFIG.TRAIL_COUNT; index++) {
		ribbons.push(
			buildRibbon(ball, RIBBON_NAME, index, index * step, BALL_SIZE * BALL_CONFIG.TRAIL_SPREAD, {
				color: new ColorSequence([
					new ColorSequenceKeypoint(0, BALL_CONFIG.TRAIL_COLOR_LEADING),
					new ColorSequenceKeypoint(BALL_CONFIG.TRAIL_COLOR_MIDDLE_AT, BALL_CONFIG.TRAIL_COLOR_MIDDLE),
					new ColorSequenceKeypoint(1, BALL_CONFIG.TRAIL_COLOR_TRAILING),
				]),
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
					color: new ColorSequence([
						new ColorSequenceKeypoint(0, BALL_CONFIG.TRAIL_HALO_COLOR_LEADING),
						new ColorSequenceKeypoint(1, BALL_CONFIG.TRAIL_HALO_COLOR_TRAILING),
					]),
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
