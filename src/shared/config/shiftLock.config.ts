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
	 * Where the camera sits relative to the body while the lock is on — written as **camera space**, and
	 * converted by `ShiftLock` before it is handed to Roblox. The distinction is the whole of this entry.
	 *
	 * **What the value means: how far to the player's right and how far up the camera's pivot sits.**
	 * `X` is the offset to the camera's right, `Y` is up, and `Z` is along the view — positive is
	 * *backwards*, because `CFrame.LookVector` is `-Z`, so a `Z` here behaves like a zoom rather than a
	 * shift. The pivot is what the camera orbits *and* what it looks at, so an `X` of 2 puts the body that
	 * far off the middle of the frame, leaving the aim line through the other side. **The sign is which
	 * side**, and it is the one thing to flip if the body reads better on the other shoulder.
	 *
	 * **`Humanoid.CameraOffset` is applied in the *body's* frame, not the camera's — and that is an
	 * elimination rather than a quotation, because there is nothing to quote.** The typings carry the
	 * property, its type and a link, and no prose about the frame at all. What settles it is what was
	 * seen in the running game:
	 *
	 * - A **camera**-space offset cannot change which side of the screen the body is on, because the pivot
	 *   would be fixed in the very frame the screen *is*.
	 * - A **world**-space offset cannot change sides when the body turns under a stationary camera either —
	 *   the offset is fixed in world terms, and turning the body moves nothing.
	 * - A **body**-relative offset does exactly one thing the other two cannot: it swings the pivot around
	 *   the character as the character turns. That is what happened — the body held one side of the screen
	 *   until the player turned to face the camera, and then it was on the other.
	 *
	 * **So a value here is not enough by itself, and `(2, 2, 0)` alone was the bug.** A static body-relative
	 * offset rotates with the body while the screen does not, which means the shoulder the camera sits over
	 * changes sides every time the player turns around. `ShiftLock.watchOffset` re-expresses this vector
	 * into the body's frame once a frame, so the offset is camera-relative *in effect* and the body keeps
	 * one side of the screen wherever it is pointing. Read this value as an intent, not as the number that
	 * ends up in the property.
	 *
	 * **A reversal, and the argument it replaces is kept because it is still half right.** The value was
	 * briefly `(0, 2, 0)` — no lateral offset at all — on the reasoning that an `X` pushes the body off the
	 * centre of the frame. That is true, and it is the point of the entry. What the reasoning missed is
	 * that centring the body was never the request: the request is for the body to hold **one** side, and
	 * zeroing `X` trades a body that swaps sides for a camera with no shoulder at all.
	 *
	 * **`Y` is 2.** The camera's subject is the `HumanoidRootPart`, whose centre sits at roughly hip height,
	 * so an unraised pivot looks along the body from the waist; two studs puts it at the torso's centre,
	 * which is where a shoulder-height aim reads from. It is still a guess — the number to move if the view
	 * reads too low or too high — and it is deliberately untouched by anything lateral, because a vertical
	 * pivot cannot change which side of the screen the body is on.
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
