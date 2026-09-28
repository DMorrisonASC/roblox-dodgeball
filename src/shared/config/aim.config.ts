/**
 * The aim-target glow: what it fills a target with.
 *
 * Read by `AimTargetController` alone today. Shared rather than client-only because nothing in it is
 * a *client's* business to decide — the colour is the game's look, and a second client that ever
 * wanted it would want the same value.
 *
 * **The other two entries here are no longer read, and that is worth spelling out.** They configured
 * a ray the glow cast for itself. The glow no longer casts anything: it reads the arc the throw
 * guide already draws, so it has no reach of its own and nothing to throttle. Both are kept and
 * marked rather than deleted, because the numbers are the ones to start from if the glow ever has to
 * ask its own question again, and because the shape of the older design is worth being able to see.
 */
export const AIM_CONFIG = {
	/**
	 * What the glow fills a target with.
	 *
	 * **White, and that is the loud choice rather than the neutral one.** The fill reads as light
	 * falling on the body rather than paint over it, so it stands out against every colour a map, a
	 * rig or the palette can offer — which a tint of any particular hue does not. Chosen once and
	 * never made dynamic: a colour that changed with the situation would have to be read twice to be
	 * understood, and the whole point of this is to be understood at no glance at all.
	 *
	 * A cool cyan at 0.6 transparency was tried first and read as "slightly different" rather than
	 * "lit": the fill has to compete with whatever the model was already wearing, so anything short
	 * of a hard white is a suggestion instead of a signal.
	 */
	TARGET_GLOW_COLOR: Color3.fromRGB(255, 255, 255),

	/**
	 * How opaque that fill is, from `0` (a solid body) to `1` (invisible).
	 *
	 * Most of the way to solid, so the target is unmistakable rather than merely tinted. The black
	 * outline sits on top of the fill and is what keeps the silhouette readable underneath it — see
	 * `OutlineService`, which is what drew it. The transparency left in is only so the body does not
	 * vanish into one white shape: at `0` the thing being aimed at is hidden by its own highlight,
	 * which is the opposite of what an aim reference is for.
	 */
	TARGET_FILL_TRANSPARENCY: 0.35,

	/**
	 * **Placeholder, and no longer read.** How far the crosshair ray reached, in studs.
	 *
	 * The glow casts no ray — it reads the arc `ThrowController` has already drawn, whose reach is
	 * the trajectory's own time limit rather than a distance. So there is nothing left for this to
	 * bound. It was always a *ceiling* rather than a preference: long enough that the arena is
	 * covered end to end, short enough that a rig on the far side of the map is not a target through
	 * a wall of geometry. Kept as the number to start from if the glow ever casts again.
	 */
	TARGET_MAX_DISTANCE: 500,

	/**
	 * **Placeholder, and no longer read.** How many times a second the crosshair ray was cast.
	 *
	 * The ray is gone and its replacement is free: the arc is rebuilt every frame whether or not
	 * anything reads it, so the glow is now exactly as fresh as the guide that drew it, and there is
	 * no cost to throttle. The reasoning this carried is worth keeping anyway, because it is the
	 * reason the glow was ever allowed to be stale: a raycast a frame is not worth a cosmetic, and
	 * 15 Hz put the glow up to 66 ms behind the crosshair, which is less than the eye reads as a
	 * delay on something this soft.
	 */
	TARGET_UPDATE_HZ: 15,
} as const;
