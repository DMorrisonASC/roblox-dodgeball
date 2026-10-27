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

	/**
	 * **The lead, in points, at which a Score Rush round is decided on the spot — the mercy rule.**
	 *
	 * **It exists because a losing side leaves before it loses.** A target of `SCORE_RUSH_TARGET` is a race, and a
	 * race that is obviously lost stops being played: the side that is twenty behind does not need the clock to tell
	 * it what happened, and what it does instead is quit, which costs the winning side an opponent and the server a
	 * body it has to refill. A lead this large *is* the result, so the round says so and moves on — the alternative
	 * is playing out the last minute of a match nobody believes in.
	 *
	 * **Below the target, deliberately.** At 20 this can fire while the leader is on 20 and the target is 30, so the
	 * rule decides rounds the target never gets to. That is the point rather than a coincidence: a lead of twenty is
	 * already a rout, and a rule that only fired at the target would never fire at all.
	 *
	 * **It is checked before the clock, not after it**, so a round that reaches the lead on its last second is a
	 * win by this rule rather than a win on time — the same ordering argument the target makes in
	 * `ScoreRushMode.outcome`, and for the same reason: `outcome`'s first answer is the one that reads as true.
	 *
	 * Read by `ScoreRushMode` (to decide the round) and by `client/mercyWarning.ts` (to stay silent once the round
	 * is about to end), so the two cannot disagree about where the line is. **Placeholder.**
	 */
	MERCY_RULE_LEAD: 20,

	/**
	 * **The lead at which the losing side is warned that the round is nearly over.**
	 *
	 * Five points before {@link MERCY_RULE_LEAD}, which is a few exchanges of play — enough to try something without
	 * the warning arriving as news that the game has already ended. **A warning rather than a second rule**: nothing
	 * here ends anything, and the notification is the client's own (see `client/mercyWarning.ts`), so this number
	 * only ever decides when one line of text appears.
	 *
	 * **Placeholder.**
	 */
	MERCY_WARNING_LEAD: 15,

	/**
	 * What a caught throw is worth to the catching team, in a mode that keeps score.
	 *
	 * **Placeholder — untuned.** The rule it serves is fixed — a caught throw puts the thrower out
	 * and scores — but the size has not been played. One point makes a catch worth exactly a hit,
	 * which is the natural starting assumption and not necessarily where it lands. Read by
	 * `RoundService` when an enemy's throw is caught; a friendly catch and a scoreless mode never
	 * reach it, so this number only ever matters in Score Rush.
	 */
	CATCH_POINTS: 1,
} as const;
