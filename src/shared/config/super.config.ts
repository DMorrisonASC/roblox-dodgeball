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

	/**
	 * How long a Freeze bite lasts, in seconds. **Placeholder — 3 is the guess.**
	 *
	 * **Long enough to be worth a charge, short enough that it is a moment rather than a round.** Three
	 * seconds is about the time it takes somebody to be reached by whoever the freeze was bought for,
	 * which is the whole use of it: it does not win anything on its own, it makes the next few seconds
	 * unavoidable for everybody standing near where the ball landed.
	 *
	 * The number to move first if the ability reads as unfair, and the one to move up if it reads as
	 * pointless. Nothing else changes with it: the clock is per body, so a body frozen late in the
	 * effect's window is held for the full duration rather than whatever was left.
	 */
	FREEZE_DURATION_SECONDS: 3,

	/**
	 * How far the freeze reaches from the body part a Freeze ball struck, in studs. **Placeholder.**
	 *
	 * **The hit radius and the miss radius are two numbers because they are two different promises.**
	 * Hitting somebody is what the ability is aimed at, so it pays a radius wide enough to catch the
	 * people standing with them; a ball that hits the world is the ability going wrong, so it pays a
	 * smaller one — enough that a shot which lands at somebody's feet still does something, not enough
	 * that a wild throw freezes a room.
	 *
	 * Eight studs is a little more than two bodies across, which is the shape to check in Studio: too
	 * small and the splash is a slower Pierce with no splash at all, too large and one throw in a
	 * group freezes everybody in it.
	 */
	FREEZE_HIT_RADIUS: 8,

	/**
	 * How far the freeze reaches from where a Freeze ball stopped, in studs, when it tagged nobody.
	 * **Placeholder.**
	 *
	 * Smaller than {@link FREEZE_HIT_RADIUS} on purpose — see that comment for why the two are not one
	 * number. Five studs is about one body's reach, so a ball that clips a wall beside somebody freezes
	 * them and a ball that hits the wall across the arena freezes nobody.
	 */
	FREEZE_MISS_RADIUS: 5,

	/**
	 * The colour a frozen body's outline is drawn in. **Placeholder — and the one non-number here.**
	 *
	 * **Blue, and deliberately nothing like a side's colour.** The outline a body already wears is doing
	 * a job: it is black for a rig and a side's colour for a player who is in a round. So a freeze has to
	 * read as a *state* rather than be mistaken for a team, and a saturated blue is on nobody's side in
	 * this game.
	 *
	 * It is written onto the `Highlight` the body already has rather than by adding a second one — the
	 * engine draws one outline per model and its choice between two is undefined. See
	 * `OutlineService.overrideOutlineColour`, which is the only writer, and `FreezeService.unfreeze`,
	 * which puts back whatever was there before.
	 */
	FREEZE_OUTLINE_COLOR: Color3.fromRGB(80, 160, 255),
} as const;
