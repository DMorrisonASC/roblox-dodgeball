/**
 * The aim's own numbers: what colour a lit target is drawn in, what it used to be drawn as, how sensitive
 * the mouse is for this game, and how hard a charging body is turned onto the aim.
 *
 * Read by `AimTargetController` (the glow), `main.client.ts` (the sensitivity, once at boot) and
 * `AimFacingController` (the responsiveness) — three readers, one file, because none of the values is a
 * *client's* business to decide: the colour is the game's look, the sensitivity is the game's feel, and the
 * turn rate is the game's responsiveness. A second client that ever wanted them would want the same values.
 * **The first sentence of this doc used to name `AimTargetController` alone**, and the count is worth
 * re-reading rather than trusting — the same lesson `platform.ts` records about its own caller count.
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

	/**
	 * **Placeholder — `0.52`.** The mouse sensitivity this game runs at, written once at client start to
	 * `UserInputService.MouseDeltaSensitivity`.
	 *
	 * **A multiplier on the player's own slider, not a sensitivity of its own, and that is why it is allowed
	 * to exist at all.** `MouseDeltaSensitivity` scales whatever the player has chosen; it does not replace
	 * it. So a player whose slider sits at the default gets half the movement they had, and a player who has
	 * already turned theirs down gets half of *that*. The shape is the point: this game is played by turning
	 * the view, and a view that moves twice as far per inch as the player asked for is a real obstacle — but
	 * the player's preference is still theirs, and halving it respects the order they put it in rather than
	 * overruling it. **If what was wanted was an absolute number, this is the wrong property**: that is
	 * `UserGameSettings.MouseSensitivity`, the slider itself, and overwriting it is taking a setting away from
	 * somebody. It is not written anywhere in this project, deliberately.
	 *
	 * **Per session and never saved**, which is the property's own behaviour rather than an arrangement here:
	 * `UserInputService` is the session's input state, so a rejoin starts from whatever the server hands the
	 * client, and there is nothing for this file to restore. The same reason `ShiftLock`'s cursor has no
	 * cleanup path.
	 *
	 * **What it reaches, checked rather than assumed.** Roblox's own camera scripts read mouse delta through
	 * `UserInputService`, so this is upstream of everything that turns: the ordinary camera, the custom shift
	 * lock (which writes `MouseBehavior` and `RotationType` and lets Roblox place the camera, so it inherits
	 * this like any other view), the aim ray, and the arc. **Nothing in this project reads a raw delta of its
	 * own**, so there is no second reader that this would fail to reach — see `ShiftLock` for the two settings
	 * it *does* write and for why it does not take the camera over.
	 *
	 * The value is a feel decision and it is deliberately modest: it makes the view steadier for aiming at a
	 * body-sized target, which is what the game asks of it. Move it toward `1` for a faster view.
	 */
	MOUSE_SENSITIVITY: 0.52,

	/**
	 * **Placeholder — `30`.** How hard the body is turned onto the aim while a throw is being charged, in
	 * `AlignOrientation.Responsiveness` units. Read by `AimFacingController` alone.
	 *
	 * **A responsiveness and not a duration**, because the mechanism is a constraint: the body chases the aim
	 * with a torque, and this is how quickly that chase closes. Higher is snappier and, past the point where
	 * the turn outruns the eye, reads as a flick; lower is a body that visibly swims into place while the
	 * player is already holding a ball at the aim. The precedent is `ThrowBehavior.aimAt`'s rigs, which tune
	 * the same number on the same kind of constraint — and `DodgeService`, which uses `50` for a dash that
	 * has no time to be smooth. This is slower than the dash deliberately: a dash is a snap the player asked
	 * for, and a throw's aim is a pose they are holding.
	 */
	AIM_FACING_RESPONSIVENESS: 30,
} as const;
