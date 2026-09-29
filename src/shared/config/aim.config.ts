/**
 * The aim-target glow: what colour a lit target is drawn in, and what it used to be drawn as.
 *
 * Read by `AimTargetController` alone today. Shared rather than client-only because nothing in it is
 * a *client's* business to decide — the colour is the game's look, and a second client that ever
 * wanted it would want the same value.
 *
 * **Three entries here are no longer read, and that is worth spelling out.**
 * {@link AIM_CONFIG.TARGET_MAX_DISTANCE} and {@link AIM_CONFIG.TARGET_UPDATE_HZ} configured a ray the
 * glow cast for itself. The glow no longer casts anything: it reads the arc the throw guide already
 * draws, so it has no reach of its own and nothing to throttle.
 * {@link AIM_CONFIG.TARGET_FILL_TRANSPARENCY} configured a fill painted over the whole body, and is
 * gone for a different reason again — the landing marker is read against that body. All three are
 * kept and marked rather than deleted, because the numbers are the ones to start from if either design
 * comes back, and because the shape of what was there is worth being able to see.
 */
export const AIM_CONFIG = {
	/**
	 * What a lit target's **edge** is drawn in — the whole of the signal that this body is the one the
	 * throw would land on.
	 *
	 * **On the outline rather than in the fill, and that is a reversal.** The glow used to be a white
	 * fill laid over the whole body at {@link AIM_CONFIG.TARGET_FILL_TRANSPARENCY}, and the fill is
	 * what made the landing marker hard to read: the marker is drawn *on* the body, so washing that
	 * body toward white left a grey disc sitting on near-white. An edge is a contour rather than a
	 * surface, so it says "this one" without touching anything the marker is read against.
	 *
	 * **White, and that is the loud choice rather than the neutral one.** A body on nobody's side
	 * wears a black edge — see `OUTLINE_CONFIG.COLOR` — and a player in a round wears their side's
	 * colour, so white is unlike either and unlike every material a map can offer. Chosen once and
	 * never made dynamic: a colour that changed with the situation would have to be read twice to be
	 * understood, and the whole point of this is to be understood at no glance at all.
	 *
	 * A cool cyan was tried as the fill colour first and read as "slightly different" rather than
	 * "lit": the signal has to compete with whatever the model was already wearing, so anything short
	 * of a hard white is a suggestion instead of a signal. That argument was about a wash over the
	 * body and now applies to a line around it, where it is if anything stronger.
	 */
	TARGET_GLOW_COLOR: Color3.fromRGB(255, 255, 255),

	/**
	 * **No longer read, and the number to come back to.** How opaque the target's fill was made while
	 * it was lit, from `0` (a solid body) to `1` (invisible).
	 *
	 * The glow no longer paints a fill at all — see {@link AIM_CONFIG.TARGET_GLOW_COLOR} — so a lit
	 * body keeps `OutlineService`'s own `FillTransparency = 1` and its surface is never written. This
	 * was `0.35`, and what it used to say is worth keeping as the argument for the other side: that a
	 * fill most of the way to solid is what makes a target unmistakable rather than merely tinted, and
	 * that the transparency left in is only so the body does not vanish into one white shape. Both
	 * halves are true, and both were outweighed by the marker: the aim reference the glow exists to
	 * serve was the thing the fill was hiding.
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
