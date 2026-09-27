/**
 * The numbers a game mode is played by, rather than the modes themselves.
 *
 * Its own config for the same reason `arena.config.ts` is: these are tuning values, and a tuning
 * value buried in the file that reads it is a value nobody finds. What a mode *decides* lives in
 * `src/server/services/round/modes/`, and what it is *called* lives in `shared/gameMode.ts`.
 */

export const GAME_MODE_CONFIG = {
	/**
	 * How long the vote stays open at the start of an intermission, in seconds.
	 *
	 * Measured against the intermission's own clock rather than a wall clock of its own — the round
	 * ticks it down and closes the window when this many seconds have come off, so a dev pausing
	 * rounds pauses the vote with them. Two clocks would be two answers to "how long is left".
	 *
	 * Fits inside {@link ARENA_CONFIG.INTERMISSION_SECONDS} with room to spare, which it has to:
	 * the window opens when the intermission does, and a vote still running when the round starts
	 * would be a vote about a round that has already begun.
	 */
	VOTE_SECONDS: 10,

	/**
	 * The score that ends a Score Rush round early.
	 *
	 * Reaching it wins outright, whatever the clock says — that is what makes it a target rather
	 * than a tiebreak. Reached by counting landed hits: one point per throw that finds a body on
	 * the other side, which is what `ScoreRushMode.hitAward` returns.
	 */
	SCORE_RUSH_TARGET: 30,
} as const;
