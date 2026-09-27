import { GameModeId } from "shared/gameMode";
import { GameMode } from "./GameMode";
import { DODGE_AND_SEEK } from "./DodgeAndSeekMode";
import { SCORE_RUSH } from "./ScoreRushMode";
import { TEAM_ELIMINATION } from "./TeamEliminationMode";

/**
 * Every mode the server can actually run, in the order a vote lists them.
 *
 * **This list is what makes a mode votable, and the `GameModeId` union is not.** The union names
 * the modes the game has; this array holds the ones with an implementation behind them. A vote's
 * options are published from here, so a mode named in the union but not yet written is simply not
 * offered — no button exists for it, and a hand-crafted vote for it is refused. Adding a mode is
 * one line here, after the class is written.
 *
 * An explicit array rather than the keys of a lookup table, because iteration order over a Luau
 * hash part is not defined — the same modes could come out in a different order on every server,
 * and a button row that reshuffles itself between rounds is a button row people misclick. The
 * order here is also the order the buttons appear in, so moving a line moves a button.
 */
export const MODES: ReadonlyArray<GameMode> = [TEAM_ELIMINATION, SCORE_RUSH, DODGE_AND_SEEK];

/** The id each mode is filed under. Built from {@link MODES}, so the two cannot disagree. */
const BY_ID = new Map<GameModeId, GameMode>();

for (const mode of MODES) {
	BY_ID.set(mode.id, mode);
}

/**
 * The mode with this id, or `undefined` if this build has none.
 *
 * `undefined` rather than a fallback, and the caller decides. A vote that somehow offered a mode
 * this build does not have is a bug worth seeing, and quietly playing something else would hide
 * it behind a round that started with the wrong rules.
 */
export function modeFor(id: GameModeId): GameMode | undefined {
	return BY_ID.get(id);
}

/** Whether a mode can be played here — and therefore whether it can be voted for. */
export function isPlayable(id: GameModeId): boolean {
	return BY_ID.has(id);
}

/**
 * The modes a vote offers, in the order it should list them.
 *
 * A function rather than an export of `MODES` so that the list has one reader-shaped door: the
 * vote asks what it may offer, instead of every caller reaching into the array and deciding for
 * itself whether to filter it.
 */
export function playableModes(): ReadonlyArray<GameMode> {
	return MODES;
}

/**
 * The mode a round plays when no vote has chosen one.
 *
 * **The game's original mode, so that the first round of a server behaves exactly as it did before
 * any of this existed.** Both `VoteService` (as its opening selection) and `RoundService` (as the
 * mode it holds before the first vote closes) start here, from one constant rather than from two
 * copies of the same idea — the round's field and the vote's default are the same answer.
 */
export const DEFAULT_MODE: GameMode = TEAM_ELIMINATION;
