import { MATCH_STATS_CONFIG } from "./config/matchStats.config";

/**
 * One body's row on the in-match stats board — **the whole of what crosses the wire for it**, and the whole
 * of what the client needs to draw a line.
 *
 * **A flat record of six numbers and two strings rather than a counters object**, which is `hitImpact`'s rule
 * about the wire applied to a table instead of to an event: the payload carries what a reader draws and nothing
 * a reader would have to *decide* about. The client sorts by {@link MatchStatsRow.points} and prints the rest;
 * it does not add the four counters up, because `points` is the one number the ordering depends on and two
 * copies of an ordering rule are two orderings waiting to disagree.
 *
 * **`name` is the model/player name**, not the display name, on every other cross-service fact's convention
 * (`hitImpact`, `teamWipe`, `LAST_HIT_BY_*` all compare against `Players.LocalPlayer.Name`). **One field covers
 * both kinds of body**: a character's model name is its player's name and a rig's is its own, so a row needs no
 * flag saying which it is — and the board deliberately does not draw one. **`side` is the
 * raw `TEAM_ATTRIBUTE`** — `"A"`, `"B"` or `""` — so the client can colour and group it through
 * `teamColourOf`/`sideNameOf` without the server deciding what a side is *called*; a mode may rename its sides
 * and this payload stays true.
 */
export interface MatchStatsRow {
	readonly name: string;
	readonly side: string;

	/** The derived score. See {@link pointsOf}, which is the only thing that makes it. */
	readonly points: number;

	readonly hits: number;
	readonly throws: number;
	readonly catches: number;
	readonly dodges: number;
}

/**
 * **The board's score for one body** — the four weights in `MATCH_STATS_CONFIG` applied in one place.
 *
 * **Shared rather than server-side, and it is not duplication.** The server is the only caller today, so the
 * function could live in `MatchStatsService`; it lives here because {@link MatchStatsRow.points} is part of the
 * shared shape, and a field whose derivation lives on the far side of the wire is a field a client reader has to
 * guess at. Kept in `shared/` it sits beside the type it produces and beside the config it reads, so "what a
 * point is worth" is one file and one function.
 *
 * **Counts only, and no clamping.** Every input is a counter that starts at nought and only rises, so there is
 * nothing here to defend against — see `MatchStatsService`, which is the only thing that builds a row and does
 * its filtering before calling this.
 */
export function pointsOf(throws: number, hits: number, catches: number, dodges: number): number {
	return (
		hits * MATCH_STATS_CONFIG.HIT +
		catches * MATCH_STATS_CONFIG.CATCH +
		dodges * MATCH_STATS_CONFIG.DODGE +
		throws * MATCH_STATS_CONFIG.THROW
	);
}
