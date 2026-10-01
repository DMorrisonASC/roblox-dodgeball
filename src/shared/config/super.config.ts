/**
 * The numbers behind the charged abilities.
 *
 * A config file rather than constants inside `SuperService`, for the reason every other config
 * exists: the mechanic is a handful of numbers, they are the part that gets tuned, and they belong
 * where tuning is one edit rather than a hunt through a service. It is also the file a designer can
 * read to find out what the rule is without following `Map`s and `Set`s.
 */
export const SUPER_CONFIG = {
	/**
	 * Hits in a row that earn one charge.
	 *
	 * **Placeholder.** Six is a first guess at "a long enough run to feel earned" rather than a
	 * measured number, and it is the one to move when a charge turns out to arrive too often or too
	 * rarely. Nothing else has to change with it: the streak counts up to this, the charge is granted
	 * at it, and the HUD reads it as the denominator of its readout rather than carrying its own copy.
	 *
	 * What it is not is a limit on how many charges can be earned over a round. A charge is spent or
	 * forfeited and the streak starts again, so six more hits earn the next one — this number is the
	 * length of a run, not a budget.
	 */
	STREAK_REQUIRED: 6,

	/**
	 * How long a MultiBall window lasts, in seconds. **Placeholder — 10 is the ask.**
	 *
	 * **The window is a clock rather than a count of throws, and that is the whole shape of the
	 * ability.** A charge buys a stretch of *time* in which throwing is answered; how the player spends
	 * it is theirs, and throwing nothing is a legal way to spend it. That is also why the charge goes
	 * at the press for this ability and at the throw for Pierce — see `SuperService.activateMultiBall`.
	 *
	 * Ten seconds is a guess at "long enough for a handful of throws, short enough that it is over
	 * before the round moves on" rather than a measured number, and it is the one to move when the
	 * window turns out to be too generous or too brief. Nothing else has to change with it: the count
	 * below is spent by throwing, and this is only how long the chance lasts.
	 */
	MULTI_BALL_DURATION_SECONDS: 10,

	/**
	 * How many throws a MultiBall window pays for. **Placeholder — 5 is the ask.**
	 *
	 * **A count of *throws*, not of balls on the field.** The window replaces the ball a player throws
	 * until this many have gone, and then it stops replacing them: the last throw of the window is not
	 * answered, so spending the final one leaves the hand empty. The ball a player is already holding
	 * when the window opens is therefore *on top* of this number rather than inside it — which is also
	 * why a window opened on an empty hand hands over its first ball without charging for it. See
	 * `BallService.refillFromBuff`, where "answer this throw" and "fill this hand" are one rule.
	 *
	 * **Running out does not close the window.** With the count at nought the clock runs on and the
	 * player can still fetch a ball off the floor and throw it; the ability stops supplying balls, and
	 * nothing about it stops the player playing.
	 */
	MULTI_BALL_BALL_COUNT: 5,
} as const;
