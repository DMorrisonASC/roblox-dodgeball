import { GameModeId } from "shared/gameMode";
import { GameMode } from "./GameMode";
import { DODGE_AND_SEEK } from "./DodgeAndSeekMode";
import { SCORE_RUSH } from "./ScoreRushMode";
import { TEAM_ELIMINATION } from "./TeamEliminationMode";

/**
 * Every mode the server can actually run, in the order the vote would list them.
 *
 * **This list is what makes a mode *playable*, and the `GameModeId` union is not.** The union names
 * the modes the game has; this array holds the ones with an implementation behind them. A mode named
 * in the union but not yet written is simply absent from this list, so `modeFor` answers `undefined`
 * for it and `isPlayable` says no. Adding a mode is one line here, after the class is written.
 *
 * **The ordering rationale is the vote's, and the vote is switched off** — see `VOTE_ENABLED` in
 * `RoundService`. Nothing reads this array in order today and no buttons appear, and it is kept as
 * written because the order means something again the moment the vote comes back: an explicit array
 * rather than the keys of a lookup table, because iteration order over a Luau hash part is not
 * defined, and a button row that reshuffles itself between rounds is a button row people misclick.
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
 * **Nothing calls it today** — the round takes its mode from the match request, and the vote that
 * would have resolved an id is switched off. The shape is the one to keep for when it comes back:
 * `undefined` rather than a fallback, and the caller decides, because a vote that offered a mode this
 * build does not have is a bug worth seeing and quietly playing something else would hide it behind a
 * round that started with the wrong rules.
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
 * The mode `RoundService`'s field and `VoteService`'s selection are both initialised to.
 *
 * **A starting value, not what a round plays.** What a round plays is the match request's mode, which
 * both start paths fix at Score Rush — so a server's first round is Score Rush, and this is
 * overwritten at the first boundary. It is one constant rather than two copies of the same idea, and
 * it is the game's original mode because the field has to hold *something* before a match is asked
 * for.
 */
export const DEFAULT_MODE: GameMode = TEAM_ELIMINATION;
