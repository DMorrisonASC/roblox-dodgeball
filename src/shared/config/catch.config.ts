/**
 * Everything about the catch: how long an attempt stays open, the clip a catch plays, and how long that
 * clip is worth.
 *
 * Imports nothing. The window is the server's; the parts a catch can be made with are now **any part of
 * the body**, which is a rule rather than a list and so is kept where the rule is applied rather than
 * here. See `BallComponent.canCatch` and `BallComponent.struckBodyPart` — the second is what says a
 * contact is a contact with a body part at all, and it is the engine's own `Humanoid.GetLimb` that
 * answers it, for both rig types and for any rig nobody has seen yet.
 *
 * **The clip pair lives here rather than in `animation.config.ts`, and that is the throw's own
 * arrangement copied.** A catch is not a rig's: `BallService` plays the same clip for a player's catch as
 * a client draws for a rig's, so the pair belongs to the *catch* and the rig table borrows it — exactly as
 * `BODY_ANIMATION.throw` borrows `BALL_CONFIG.THROW_ANIMATION_R6`. One table means the rig's catch and the
 * player's catch cannot drift into two different animations.
 */

export const CATCH_CONFIG = {
	/**
	 * How long a catch attempt stays open, in seconds.
	 *
	 * An attempt is a *window*, not a catch: the press opens it, and the ball that
	 * arrives inside it is the one caught. Long enough to cover a read of the throw,
	 * short enough that it is a read rather than a shield — and one window catches
	 * one ball, so holding the key buys nothing.
	 *
	 * **It is a shield now, and that is the consequence of every part being catchable.** While the window
	 * is open, *any* body contact with a catchable ball is a catch — so a catcher who presses cannot be
	 * hit by an ordinary throw at all for that second, wherever it lands on them. That is the same
	 * sentence as "all parts of the body catch" read from the other end, and it is the thing to think
	 * about if a catch ever feels too strong: the answers that remain are this number, the one-ball-per-
	 * window rule in `CatchService.consume`, and the two abilities a window cannot stop (Pierce and
	 * Freeze, refused in `BallComponent.canCatch`).
	 */
	WINDOW_SECONDS: 1,

	/**
	 * **How close a ball has to pass to an open catch window to be caught, in studs — `8`.**
	 *
	 * **A second way to catch, additive to touching the ball.** Until this, catching was a `Touched` event and
	 * nothing else: the ball had to physically reach the body. That is exact, and it is also unforgiving — a ball
	 * that passes a hand's width away is a miss, and a rebound that comes back near the thrower but not *into* them
	 * is a ball nobody could have taken. This is the grace that makes a catch feel like a catch rather than like a
	 * collision.
	 *
	 * **Eight studs is a little over one body width plus an arm**, which is the physical reading: a person reaching
	 * for a ball can take one that is not quite touching them, and cannot take one across the room. It is measured
	 * from the catcher's `HumanoidRootPart` — the body's own centre, the same part every other body-relative
	 * question in this project asks about — so it is a sphere rather than a box around the feet.
	 *
	 * **The radius cannot widen what is catchable, only where it is caught.** Every proximity catch goes through
	 * `BallComponent.canCatch`, so a Pierce ball, a Freeze ball, a ball already in a hand and a ball that is not
	 * armed are all refused at eight studs exactly as they are at zero. See `CatchService`'s proximity loop.
	 *
	 * **Placeholder.**
	 */
	CATCH_RADIUS_STUDS: 6,

	/**
	 * How long a body stays marked as **mid-catch** after the ball arrives in its hand, in seconds.
	 * **Placeholder — 0.6.**
	 *
	 * **The catch's own version of `BALL_CONFIG.THROW_ANIMATION_SECONDS`, and the same trade.** `BallService`
	 * writes the mark when the catch is confirmed, clears it after this long, and the clip is played for
	 * exactly that window on every body that caught: a rig is dressed from the mark by each client, a
	 * player's track is played from the server and stopped on the same timer. Nothing here knows how long the
	 * asset actually is — the clip streams in behind the catch, so a shorter clip holds its last frame for
	 * the remainder and a longer one is cut off when the mark clears.
	 *
	 * **Longer than the throw's 0.4, and the reason is what the motion is.** A throw is the arm going out and
	 * the ball leaving; a catch is the same reach *arriving* — the ball is pulled in and the body absorbs it,
	 * which reads as a slightly larger movement in the clips supplied. It is still comfortably shorter than
	 * {@link CATCH_CONFIG.WINDOW_SECONDS}, which is the number to keep it under: the window is the attempt and
	 * this is the result, so a pose that outlived the window would have a body still catching while it was
	 * able to catch again. Raise it if catches look cut off; a value longer than the clip is visible as a body
	 * holding a pose it has finished.
	 */
	CATCH_ANIMATION_SECONDS: 0.6,

	/**
	 * The clip a **catch** plays, per rig type — the same pair for every body that catches.
	 * **Placeholder**, in the sense that the ids were supplied ahead of a consumer and are the ones to swap
	 * when a real clip is bought; they are read today, so the rows are live rather than staged.
	 *
	 * **A rig and a player catch with the same animation, and this is where that is decided.** A rig reads
	 * these through `BODY_ANIMATION.catch`, which borrows them rather than repeating the ids, and a player's
	 * catch is played from `BallService` itself — a track started on the server, so the other players see it,
	 * which is the arrangement `playActionAnimation` argues. Neither half is a copy of the other, and a rig
	 * cannot end up catching differently from a player for no visible reason.
	 *
	 * **The choice is not cosmetic.** An R6 clip never loads onto an R15 rig and the reverse, so the wrong one
	 * is a catch that silently plays nothing — see `dodge.config.ts`, which records the same trap for the four
	 * dodge clips.
	 *
	 * **An empty id is the *off* switch**, as everywhere else: the catch happens and the body keeps whatever
	 * it was wearing.
	 */
	CATCH_ANIMATION_R6: "rbxassetid://112001937610745",
	CATCH_ANIMATION_R15: "rbxassetid://140155652521630",
} as const;
