/**
 * The aim-target glow: what it looks like, how far it looks, and how often.
 *
 * Read by `AimTargetController` alone today. Shared rather than client-only because nothing in it
 * is a *client's* business to decide — the colour and the reach are the game's look, and a second
 * client that ever wanted them would want the same numbers.
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
	 * How far the crosshair ray reaches, in studs.
	 *
	 * Long enough that the arena is covered end to end — see `ARENA_CONFIG` for how big it is —
	 * and short enough that a rig on the far side of the map is not a target through a wall of
	 * geometry. Nothing beyond this is ever lit.
	 */
	TARGET_MAX_DISTANCE: 500,

	/**
	 * How many times a second the crosshair ray may be cast.
	 *
	 * **A raycast per frame is not worth a cosmetic.** At this rate the glow appears up to 66ms
	 * after the crosshair arrives, which is less than the eye reads as a delay on something this
	 * soft, and it is the difference between one ray every four frames and one every frame.
	 *
	 * It throttles the *ray* and not the whole controller: whether the player is aiming is still
	 * checked every frame — that is a table read — so releasing the aim puts the glow out on the
	 * frame it happens rather than on this clock. See `AimTargetController.update`.
	 */
	TARGET_UPDATE_HZ: 15,
} as const;
