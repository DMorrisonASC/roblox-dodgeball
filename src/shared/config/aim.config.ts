/**
 * The aim's own numbers: what colour a lit target is drawn in, what it used to be drawn as, how sensitive
 * the mouse is for this game, how hard a charging body is turned onto the aim, and how hard a mobile client's
 * aim is pulled towards the body it is nearest.
 *
 * Read by `AimTargetController` (the glow), `main.client.ts` (the sensitivity, once at boot),
 * `AimFacingController` (the responsiveness) and `client/aimAssist.ts` (the assist's strength and cone, and
 * the two search numbers it brought back) — four readers, one file, because none of the values is a *client's*
 * business to decide: the colour is the game's look, the sensitivity is the game's feel, the turn rate is the
 * game's responsiveness, and the pull is how hard the game helps a thumb. A second client that ever wanted
 * them would want the same values. **The first sentence of this doc used to name `AimTargetController` alone**,
 * and the count is worth re-reading rather than trusting — the same lesson `platform.ts` records about its own
 * caller count.
 *
 * **Two entries are read again and one is still not, and the difference is worth spelling out.**
 * {@link AIM_CONFIG.TARGET_MAX_DISTANCE} and {@link AIM_CONFIG.TARGET_UPDATE_HZ} configured a ray the glow
 * cast for itself. The glow stopped casting and they were kept as "the number to start from if the design
 * comes back" — and `client/aimAssist.ts` is that design, in the shape of a target *search*: one ceiling on
 * how far a body may be to be worth assisting towards, and one rate to rescan the bodies at. Both numbers
 * mean what they always meant, which is why they are read rather than joined by a third and a fourth.
 * {@link AIM_CONFIG.TARGET_FILL_TRANSPARENCY} is still unread — the glow paints no fill, and the landing
 * marker is read against the body's own surface — and is kept for the same reason the pair above was.
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
	 * **Placeholder, and read again — by the mobile aim assist.** How far a body may be from the throwing hand
	 * and still be a target of the assist's search, in studs.
	 *
	 * **The same meaning it always had, and it is a *ceiling* rather than a preference** — the note this
	 * carried when the glow owned it said so and it is still true: long enough that the arena is covered end to
	 * end, short enough that a rig on the far side of the map is not a target through a wall of geometry. The
	 * glow stopped casting and this went unread for a while; `client/aimAssist.ts` reads it as the outer bound
	 * of its candidate scan, where "through a wall" is answered by a raycast rather than by this number. See
	 * `consider` there for the two halves.
	 */
	TARGET_MAX_DISTANCE: 500,

	/**
	 * **Placeholder, and read again — by the mobile aim assist.** How many times a second the assist rescans the
	 * world for the bodies it may pull towards.
	 *
	 * **A rate rather than a per-frame walk, and that is the whole of why it is a number.** Finding the bodies
	 * is a `CollectionService` walk over every `NPC`-tagged model, and doing that on the aim's own per-frame
	 * clock would be sixty walks a second for a search whose answer changes when a rig moves into the cone, not
	 * when a frame passes. At this rate membership can be up to 66 ms stale, which is less than the eye reads as
	 * a delay on a pull and is stated in `client/aimAssist.ts` rather than left to be discovered — positions and
	 * velocities are read live every frame, so only "who is a candidate" is throttled.
	 *
	 * **The reasoning this carried when the glow owned it is worth keeping anyway**, because it is the same
	 * argument one reader later: a raycast a frame was not worth a cosmetic, and 15 Hz put the glow up to 66 ms
	 * behind the crosshair, which is less than the eye reads as a delay on something this soft.
	 */
	TARGET_UPDATE_HZ: 15,

	/**
	 * **Placeholder — `0.35`.** How far a mobile client's aim point is pulled from the point the aim cast
	 * produced towards the lead of the body it is nearest, as a fraction of the way there. Read by
	 * `client/aimAssist.ts` alone, and the gate around it is `isMobile()` — a desktop client never reaches the
	 * assist at all, so there is no second setting to disable it there.
	 *
	 * **A lerp and not a snap, and the reason is that the aim is the *preview's* input as well as the throw's.**
	 * The drawn arc is built from the same point, so `0` is "the game as it was" and `1` is "always land on the
	 * predicted body", and everything between is a weapon that helps a thumb without taking the throw away
	 * from the player. A snap at `1` would also make the marker jump whenever a second body took the nearest
	 * slot, which reads as the game fighting the player rather than helping them.
	 *
	 * **There is deliberately no separate lead factor.** The lead itself is a full prediction
	 * (`root + velocity × flight`) and this one number says how much of it is taken, so a second scale would
	 * be two ways to express one product — and two knobs that multiply are a tuning session with no way to
	 * tell which one did it. Move this toward `1` for a harder assist; `0` is the off switch.
	 */
	AIM_ASSIST_STRENGTH: 0.35,

	/**
	 * **Placeholder — `10`.** The **half-angle** of the cone a body has to be inside to be pulled towards,
	 * measured **horizontally** off the throw's own heading, in degrees. Read by `client/aimAssist.ts` alone.
	 *
	 * **Horizontal, because the vertical is the charge's business.** A player aiming at a body's feet is looking
	 * steeply down, and a three-dimensional cone would call that body far outside itself — the assist would
	 * refuse the commonest aim at a target rather than help it. The throw's own solve makes the same reading
	 * when it projects the heading, which is why the cone is centred on it rather than on the camera's pitch.
	 *
	 * **Ten rather than "whatever feels close", because the pull is a lerp and the cone decides what is
	 * *near*.** A wide cone reaches for bodies the player is not looking at; a narrow one only fires when the
	 * thumb is already almost right, which is the case the assist exists for. It also bounds the search before
	 * the nearest-to-the-aim-point rule does, and a body outside it is never assisted however close it is.
	 */
	AIM_ASSIST_CONE_HALF_DEGREES: 10,

	/**
	 * **Placeholder — `90`.** How fast the camera is allowed to turn onto the latched target's root while a
	 * mobile client charges at it, in degrees per second. Read by `ShiftLock.followTarget` alone.
	 *
	 * **A rate rather than a duration or an ease, and the shape is the decision.** The camera converges on the
	 * body by taking at most this much of the remaining angle each frame, so a large error is corrected at a
	 * constant speed and a small one is barely touched — which is what makes the approach settle rather than
	 * arrive. An ease would be a second smoothing on top of the rate and would give the turn two speeds to be
	 * tuned against each other; a snap would be the camera taking the player's aim off them in one frame.
	 *
	 * **90 is chosen against the cone, not against feel.** A body is only ever assisted from inside
	 * `AIM_ASSIST_CONE_HALF_DEGREES`, so the turn this has to make is small — thirty degrees in a third of a
	 * second, which reads as the view being helped rather than taken. It is also slow enough that a player
	 * dragging the screen can still win the argument with it for a moment, which is the blend rather than a
	 * setting; see `ShiftLock.followTarget` for why there is no separate blend control.
	 */
	AIM_ASSIST_FOLLOW_DEGREES_PER_SECOND: 90,

	/**
	 * **Placeholder — `1`.** The angular error below which the camera stops turning onto the latched body, in
	 * degrees. Read by `ShiftLock.followTarget` alone.
	 *
	 * **A deadzone rather than an epsilon, because a walking body's root is not still.** `HumanoidRootPart`
	 * moves by centimetres as a body walks, and at twenty studs that is a fraction of a degree — a camera with
	 * no deadzone would chase it every frame and read as a permanent tremor. One degree is about a third of a
	 * stud at that range, which is well inside a torso, so the crosshair stays on the body while the jitter
	 * below it stops moving the view.
	 */
	AIM_ASSIST_FOLLOW_DEADZONE_DEGREES: 1,

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
