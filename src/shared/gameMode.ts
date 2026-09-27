/**
 * The vocabulary of game modes, shared by the server that runs them and the client that shows
 * them.
 *
 * **Ids and names only.** What a mode *does* is a server-side interface —
 * `src/server/services/round/modes/GameMode.ts` — and deliberately not here, because the client
 * has no business deciding anything about a round. All the client needs is a stable id to send
 * back and a name to put on a button, and both of those are strings.
 *
 * A mode that is named here is not necessarily a mode that can be *played*: the union lists every
 * mode the game intends to have so the names exist for the HUD and the wire, while the server's
 * registry decides which of them are built. See `modes/registry.ts`.
 */

/**
 * Every mode the game has.
 *
 * **The union names modes; the server's registry decides which can be played.** Those are two
 * different questions, and keeping them apart is what lets a mode be named here — for the HUD, for
 * the wire, for a hand-written vote — while the options a vote actually offers come from the
 * registry. All three members have an implementation behind them today; a fourth could be named
 * here and left unplayable until its class is written, and it would simply not appear in a vote.
 */
export type GameModeId = "TeamElimination" | "ScoreRush" | "DodgeAndSeek";

/**
 * What each mode is called on screen.
 *
 * The one place a mode is named, so a button, a print and the HUD all say the same words. A
 * `Record<GameModeId, string>` rather than a list of pairs, so adding a member to the union without
 * naming it is a compile error rather than a button that says `nil`.
 */
export const GAME_MODE_NAMES: Record<GameModeId, string> = {
	TeamElimination: "Team Elimination",
	ScoreRush: "Score Rush",
	DodgeAndSeek: "Dodge and Seek",
};

/**
 * The separator between ids in the wire form. See {@link encodeModeIds}.
 *
 * A comma, and it is safe for the same reason the encoding exists at all: the ids are a closed set
 * of `PascalCase` words, so no id can contain the separator and no escaping is needed.
 */
const SEPARATOR = ",";

/**
 * Whether `value` is a mode this build knows the *name* of.
 *
 * Says nothing about whether the mode can be played — a client may legitimately send an id that
 * names a mode nobody has written yet, and the vote refuses it. This is only the check that turns
 * a string off the wire into a `GameModeId` at all, which is what stops an arbitrary string
 * reaching a lookup table.
 */
export function isGameModeId(value: string): value is GameModeId {
	return GAME_MODE_NAMES[value as GameModeId] !== undefined;
}

/**
 * The ids as one string, for putting in an attribute.
 *
 * **Because attributes hold primitives and a list is not one.** The server publishes the options a
 * vote is offering, and the client has to read them from somewhere; a comma-joined string is the
 * smallest thing that fits in the channel the rest of the round already uses, and it keeps the
 * server the single source of truth about what can be voted for — the client renders whatever it
 * is handed rather than carrying its own list that could disagree.
 *
 * The encoding is here, beside the decoding, so the two cannot drift apart.
 */
export function encodeModeIds(ids: readonly GameModeId[]): string {
	let encoded = "";

	for (const id of ids) {
		encoded = encoded === "" ? id : `${encoded}${SEPARATOR}${id}`;
	}

	return encoded;
}

/**
 * {@link encodeModeIds} read back, dropping anything that is not a mode this build names.
 *
 * Forgiving on purpose: an attribute is written by the server and read by a client that may be a
 * version behind, so a token this build does not recognise is a button that cannot exist rather
 * than a reason to render nothing. An empty string is an empty list, which is what "the vote has
 * offered nothing yet" looks like.
 */
export function decodeModeIds(encoded: string): GameModeId[] {
	const ids: GameModeId[] = [];
	if (encoded === "") return ids;

	for (const part of string.split(encoded, SEPARATOR)) {
		if (isGameModeId(part)) ids.push(part);
	}

	return ids;
}
