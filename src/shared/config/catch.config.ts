/**
 * Everything about the catch: how long an attempt stays open — and nothing about what a catch can be
 * made with, which used to live here.
 *
 * Imports nothing. The window is the server's; the parts a catch can be made with are now **any part of
 * the body**, which is a rule rather than a list and so is kept where the rule is applied rather than
 * here. See `BallComponent.canCatch` and `BallComponent.struckBodyPart` — the second is what says a
 * contact is a contact with a body part at all, and it is the engine's own `Humanoid.GetLimb` that
 * answers it, for both rig types and for any rig nobody has seen yet.
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
} as const;
