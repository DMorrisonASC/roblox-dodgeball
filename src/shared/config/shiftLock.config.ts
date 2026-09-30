/**
 * The custom shift lock: how often a zone is looked at, and where the camera sits while the lock is on.
 *
 * **Read by `client/controllers/camera/ShiftLock.ts` alone today, and in `shared/config/` anyway** —
 * the arrangement `aim.config.ts` documents for the aim glow, and for the same reason. Nothing in here
 * is a *client's* business to decide: the offset is the game's look and the rate is the game's
 * responsiveness. What lives here is the two numbers a player would ask to have changed, which is
 * exactly what a config file is for.
 */
export const SHIFT_LOCK_CONFIG = {
	/**
	 * How often the zone is checked, in seconds.
	 *
	 * **The figure `BALL_CONFIG.PICKUP_TICK_INTERVAL` chose, and for the same reason.** At walking
	 * speed a player crosses a zone edge in a small fraction of a second, so anything in this range
	 * reads as the lock happening where the floor says it does — and a check is one box query against
	 * one character, so the floor it is compared against is nearly nothing.
	 *
	 * **The check runs in every phase, and that is a decision rather than an oversight.** During a round
	 * it changes nothing — the round is already asking for the same lock — and it cannot take the lock
	 * away from the round either, because the round's answer is one of the two inputs the lock is worked
	 * out from rather than something this check can overwrite. So there is nothing for a phase gate to
	 * protect, and a gate would be a second copy of the phase's rule to keep in step with the first.
	 */
	ZONE_TICK_INTERVAL: 0.3,

	/**
	 * Where the camera sits relative to the body while the lock is on, in **camera space**.
	 *
	 * **The axis is the camera's, not the world's**, and that is the whole of what is easy to get
	 * wrong here. `Humanoid.CameraOffset` is applied in the frame of the camera the player is looking
	 * through, so `+X` is the camera's *right* — and `+Z` is **backwards**, because `CFrame.LookVector`
	 * is `-Z`. A `(0, 0, 2)` offset therefore moves the view back along the throw line rather than off
	 * the shoulder, which looks like a zoom that will not hold still rather than like a shift lock.
	 *
	 * The body goes to the player's right so that it stops covering the middle of the screen — and that
	 * middle is where the throw goes, because the aim ray is cast from the centre. The **sign is a taste
	 * call**: flipping it puts the body on the other shoulder and changes nothing else, so it is the one
	 * thing to try in Studio if the view reads better the other way.
	 *
	 * **Placeholder: 2 studs is a guess.** It has to clear a stand-in torso — an `R6` torso is about two
	 * studs across — without pushing the camera so far that aiming feels like it is happening to
	 * somebody else.
	 */
	CAMERA_OFFSET: new Vector3(2, 2, 0),

	/**
	 * The cursor shown while the lock is on.
	 *
	 * **The image is the whole of the cursor, and nothing here adjusts it.** No tint, no scale, and above
	 * all **no transparency** — a mouse icon has no transparency property to set, so the alpha the PNG
	 * carries *is* the cursor's alpha. A crosshair with a faint middle is a crosshair with a faint middle
	 * in the artwork, and the thing to change is the file rather than this line. That cuts the other way
	 * too, and it is worth knowing before the artwork is redrawn: **this line is how the lock feels**, so
	 * a new PNG is a change to the game rather than to its looks.
	 *
	 * The value is a `ContentId`, which the typings define as a plain `string`. The empty string means
	 * "no custom icon", which is what the release path writes — see `ShiftLock.restingCursor`, which
	 * remembers what the client was wearing so that letting go puts *that* back instead of a guess.
	 */
	LOCKED_CURSOR: "rbxassetid://88266069771631",
} as const;
