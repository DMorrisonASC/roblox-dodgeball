import { BALL_CONFIG } from "shared/config/ball.config";
import { BALL_SIZE } from "shared/constants";

/** What every ribbon is called, and how a ball that came back is recognised as already wearing one. */
const RIBBON_NAME = "FlightTrail";

/**
 * The shortest a trail segment may be and still be drawn, in studs.
 *
 * A ball that has landed and stopped is still armed until it is caught, and without this it
 * would record a zero-length segment every frame for as long as it sat there. Those are
 * degenerate and draw as nothing, so this costs no visual and saves the engine the work —
 * it is the same guard as "no stray wisps while idle".
 */
const MIN_SEGMENT = 0.1;

/**
 * How much the ribbons glow, from `0` (a solid strip, blended normally) to `1` (fully
 * additive, so the colour is added to what is behind it rather than replacing it).
 *
 * The one number here that is not in config, because there is nowhere better for it: it is
 * what makes the trail read as **light** rather than as coloured ribbon, which is the whole
 * of the difference between a shooting star and a streamer. At `1` the head saturates to
 * white where the ribbons overlap and the red tail stays a dull ember, which is the effect
 * wanted; if the trail ever looks like a bright smear instead, this is the first thing to
 * take down and it is one edit.
 */
const LIGHT_EMISSION = 1;

/**
 * The trail a ball leaves behind it: a set of flat ribbons arranged around the ball's own
 * axis, which together read as a tube.
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
	 * Disabling is also what clears the trail when a ball is caught. Existing segments are
	 * not dropped, they are left to expire on their own lifetime — so the trail the ball
	 * arrived on fades out where the ball was caught, over `TRAIL_LIFETIME`, with nothing
	 * having to be cleared by hand.
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
	 * must not do: the whole effect depends on there being exactly `TRAIL_COUNT` of them and
	 * on their angles being the ones the cross-section was designed around.
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

/** Every ribbon on `ball`, which is how a ball that has just been caught is recognised. */
function ribbonsOf(ball: BasePart): Trail[] {
	const ribbons: Trail[] = [];

	for (const child of ball.GetChildren()) {
		if (child.IsA("Trail") && child.Name === RIBBON_NAME) ribbons.push(child);
	}

	return ribbons;
}

/**
 * Builds the whole set on `ball`, all identical but for their angle.
 *
 * The angles are placed evenly around the ball's **local Z axis** rather than around
 * whatever axis the ball happens to be travelling along, which is a deliberate and invisible
 * simplification: the ball spins, so any local axis is as good as any other over the course
 * of a throw, and the ribbons are spread across the whole circle regardless. Picking the
 * axis from the velocity would mean rewriting every attachment's position every frame, which
 * is exactly the per-frame work this approach exists to avoid.
 *
 * One attachment of each pair sits at `+offset` and the other at `-offset` along its angle,
 * so all of them pass through the ball's centre: the pair is a diameter of the trail's
 * cross-section, and the gap between them is the ribbon's width.
 */
function createRibbons(ball: BasePart): Trail[] {
	const offset = BALL_SIZE * BALL_CONFIG.TRAIL_SPREAD;
	const ribbons: Trail[] = [];

	for (let index = 0; index < BALL_CONFIG.TRAIL_COUNT; index++) {
		const angle = (index * math.pi) / BALL_CONFIG.TRAIL_COUNT;
		const out = new Vector3(math.cos(angle), math.sin(angle), 0).mul(offset);

		const ribbon = new Instance("Trail");
		ribbon.Name = RIBBON_NAME;
		ribbon.Attachment0 = attachment(ball, index, "A", out);
		ribbon.Attachment1 = attachment(ball, index, "B", out.mul(-1));
		// Both sequences run over a segment's **age**: index 0 is the newest end, the one
		// still at the ball, and 1 is the oldest. So they are written in the direction the
		// eye reads the trail and neither is reversed — thick and opaque at the ball, thin
		// and invisible behind it. Same for the colour, which fades from the hot end to the
		// ember one on the way.
		ribbon.Color = new ColorSequence([
			new ColorSequenceKeypoint(0, BALL_CONFIG.TRAIL_COLOR_LEADING),
			new ColorSequenceKeypoint(1, BALL_CONFIG.TRAIL_COLOR_TRAILING),
		]);
		ribbon.Transparency = new NumberSequence([
			new NumberSequenceKeypoint(0, 0),
			new NumberSequenceKeypoint(1, 1),
		]);
		ribbon.WidthScale = new NumberSequence([
			new NumberSequenceKeypoint(0, BALL_CONFIG.TRAIL_WIDTH_LEADING),
			new NumberSequenceKeypoint(1, BALL_CONFIG.TRAIL_WIDTH_TRAILING),
		]);
		ribbon.Lifetime = BALL_CONFIG.TRAIL_LIFETIME;
		ribbon.MinLength = MIN_SEGMENT;
		ribbon.LightEmission = LIGHT_EMISSION;
		// Held until the throw. `FaceCamera` is left alone on purpose: the whole effect
		// depends on the ribbons always turning to face the camera.
		ribbon.Enabled = false;
		ribbon.Parent = ball;

		ribbons.push(ribbon);
	}

	return ribbons;
}

/** One end of a ribbon's cross-section, named so the pair does not collide in the Explorer. */
function attachment(ball: BasePart, index: number, side: string, position: Vector3): Attachment {
	const point = new Instance("Attachment");
	point.Name = `${RIBBON_NAME}${side}${index}`;
	point.Position = position;
	point.Visible = false;
	point.Parent = ball;

	return point;
}
