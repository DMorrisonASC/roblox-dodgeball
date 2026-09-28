/**
 * The numbers a game mode is played by, rather than the modes themselves.
 *
 * Its own config for the same reason `arena.config.ts` is: these are tuning values, and a tuning
 * value buried in the file that reads it is a value nobody finds. What a mode *decides* lives in
 * `src/server/services/round/modes/`, and what it is *called* lives in `shared/gameMode.ts`.
 */
import { ARENA_CONFIG } from "./arena.config";

/**
 * How long before the round starts the vote window closes, in seconds.
 *
 * **The gap, not the window.** The window itself is derived from it — see
 * {@link GAME_MODE_CONFIG.VOTE_SECONDS} — because the number that matters is not "how long does the
 * vote stay open" but "how long is there after it closes". The window is whatever is left of the
 * intermission once this is set aside, so changing the intermission changes the window without
 * anybody having to remember to change two numbers that have to agree.
 *
 * The ten seconds it leaves are for the thing the window deliberately cannot do: once the vote is
 * closed and the mode is known, players get a moment to read what they are about to play before the
 * arena changes under them. A window that ran to the last second would decide the mode in the same
 * breath as the round beginning.
 */
export const VOTE_CLOSING_BUFFER = 10;

/**
 * The shortest window a vote may have, in seconds.
 *
 * A floor rather than a rule, because the window is arithmetic: an intermission shorter than
 * {@link VOTE_CLOSING_BUFFER} works out to zero or negative, and a vote nobody can press is worse
 * than a short one. Three seconds is roughly the point below which a person cannot read three
 * buttons and choose one, so below it there is no point opening the window at all — but opening a
 * token one is still more honest than clamping the intermission or skipping the vote silently.
 *
 * A config that lands here is reported once at startup by `VoteService`, so it is a warning in the
 * output rather than a window nobody notices is wrong.
 */
export const VOTE_MIN_SECONDS = 3;

export const GAME_MODE_CONFIG = {
	VOTE_CLOSING_BUFFER,
	VOTE_MIN_SECONDS,

	/**
	 * How long the vote stays open, in seconds — **derived, not set**.
	 *
	 * The intermission's length minus the closing buffer, floored at the minimum. It is written as
	 * arithmetic rather than as a number so that the three values cannot drift: an intermission of
	 * 30 gives a 20-second window, one of 60 gives 50, and neither needs anybody to notice that a
	 * second number needed changing too.
	 *
	 * Measured against the intermission's own clock rather than a wall clock of its own — the round
	 * ticks it down and closes the window when this many seconds have come off, so a dev pausing
	 * rounds pauses the vote with them. Two clocks would be two answers to "how long is left".
	 *
	 * Computed once, at module load, from constants that cannot change while the game is running.
	 */
	VOTE_SECONDS: math.max(VOTE_MIN_SECONDS, ARENA_CONFIG.INTERMISSION_SECONDS - VOTE_CLOSING_BUFFER),

	/**
	 * The score that ends a Score Rush round early.
	 *
	 * Reaching it wins outright, whatever the clock says — that is what makes it a target rather
	 * than a tiebreak. Reached by counting landed hits: one point per throw that finds a body on
	 * the other side, which is what `ScoreRushMode.hitAward` returns.
	 */
	SCORE_RUSH_TARGET: 30,
} as const;
