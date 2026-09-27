/**
 * The two sides, and the words a round uses to say that one of them won.
 *
 * **Its own module rather than a corner of `RoundService`, and that is a Luau constraint rather
 * than a tidiness one.** A mode has to be able to name a side — `TeamEliminationMode` counts them,
 * `DodgeAndSeekMode` will name them "Seekers" and "Dodgers" — so a mode and the round both need
 * these values. If they lived in `RoundService`, then `RoundService` would require the modes and
 * the modes would require `RoundService`: in Luau a require cycle hands one of them a partially
 * built module, and which one depends on which side was required first. A third module that
 * neither owns is what breaks it, and it is why these three constants are not private any more.
 */

/** One side. Two of them, and the labels are what `TEAM_ATTRIBUTE` holds. */
export const TEAM_A = "A";

/** The other side. See {@link TEAM_A}. */
export const TEAM_B = "B";

/**
 * A side's label — what `TEAM_ATTRIBUTE` holds, and what a round maps a player to.
 *
 * Named a *label* and not a `Team`, which is a Roblox class: this game may well want team objects
 * later (per-team spawns are the obvious next thing), and a type alias shadowing that name would
 * have to be undone first.
 */
export type TeamLabel = typeof TEAM_A | typeof TEAM_B;

/** What a round reports when neither side has won it. */
export const DRAW = "draw";

/**
 * Who won a round — a side, or nobody. `undefined` means the round is still on.
 *
 * The same two-part vocabulary whether or not the two sides are symmetric: Dodge and Seek's
 * "seekers" and "dodgers" are still two sides, still labelled `A` and `B` on the player, and a
 * mode that wants to name them differently does it through `GameMode.sideName` rather than by
 * inventing a third kind of outcome.
 */
export type RoundOutcome = TeamLabel | typeof DRAW;
