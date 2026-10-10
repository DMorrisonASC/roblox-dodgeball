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
 * What each mode calls its two sides, for anything that has to write a sentence about one.
 *
 * **On the client's side of the line, deliberately.** The server publishes a winner as the raw
 * label — `"A"`, `"B"` or `"draw"` — and nothing more, because that is the whole of what anything
 * server-side needs in order to match a side against a player. How a side reads to a person is a
 * *label's* business, and labels are the client's, so this table lives here where the HUD can
 * reach it rather than as a method on a mode object the client cannot see.
 *
 * **A `Record` rather than a method, because the answer depends only on which mode it is.** A
 * mode's two sides are fixed the moment the mode is written; asking a mode instance at runtime
 * would be a table lookup with an object in front of it — and an answer only the server could
 * give, which is precisely the problem this solves.
 *
 * The keys are `A` and `B` because those are literally the values `TEAM_ATTRIBUTE` holds and what
 * `ROUND_WINNER_ATTRIBUTE` publishes. A mode whose sides are not symmetric still uses them; the
 * labels are positional, and this is what makes them mean something to a reader.
 */
export const MODE_SIDE_NAMES: Record<GameModeId, { readonly A: string; readonly B: string }> = {
	TeamElimination: { A: "Team A", B: "Team B" },
	ScoreRush: { A: "Team A", B: "Team B" },
	DodgeAndSeek: { A: "Seekers", B: "Dodgers" },
};

/**
 * What `mode` calls the side that `label` refers to — the sentence form of {@link MODE_SIDE_NAMES}.
 *
 * Takes the label as a plain `string` rather than as a `TeamLabel`, because that is how it arrives:
 * read off an attribute, published by a server that may be a version away from this client. A label
 * this build does not recognise falls back to `"Team X"` rather than erroring — a HUD halfway
 * through drawing itself is the wrong place to find out that two builds disagree.
 */
export function sideNameOf(mode: GameModeId, label: string): string {
	const names = MODE_SIDE_NAMES[mode];

	if (label === "A") return names.A;
	if (label === "B") return names.B;

	return `Team ${label}`;
}

/**
 * The colour each side is drawn in, and there is **one pair for the whole game**.
 *
 * **A is red and B is blue, because the arena is red and blue.** That is the whole of the argument, and it
 * is the rule everything else here follows: a side's colour is not a property of a mode, it is a property
 * of the *place* the mode is played in. The map has a red half and a blue half, so a side drawn in any
 * third colour is a side the map disagrees with — and the modes are all played on that same map.
 *
 * **This was per mode, and the argument it replaces is kept here because it is worth knowing what it
 * missed.** `MODE_TEAM_COLORS` held a pair per mode — green against purple for Score Rush, orange against
 * teal for Dodge and Seek — on the reasoning that a side's colour is part of how a *mode* reads, so the
 * same side should not look like a different mode. True as far as it goes, and it looked at the wrong
 * thing: what a player compares the colour against is not the last round's palette, it is the floor they
 * are standing on and the spawn they came out of, and those are red and blue in every mode. Read that way
 * the old table was not four modes that each looked like themselves, it was *three* modes whose colour
 * contradicted the map. **The name went with the change** — `MODE_TEAM_COLORS` described a table keyed by
 * mode, which is not what a team colour is; the pair below is keyed by team, and
 * `TEAM_COLORS` is what it is.
 *
 * **The names are still per mode, and the two are not inconsistent.** See {@link MODE_SIDE_NAMES}: a mode
 * calls its sides whatever it likes, because a name is read in a sentence — the round-result line — where
 * the mode is the whole context. A colour is read against the arena, where the mode is not. So a Dodge and
 * Seek round is still fought by Seekers and Dodgers in red and blue, which is the mode's words on the
 * map's colours.
 *
 * **Dark and desaturated, deliberately.** These are *edges* — see `OUTLINE_CONFIG` — not fills, so
 * each one is drawn as a line around a silhouette rather than over it, and a saturated colour at
 * that weight reads as neon rather than as a team. These are values chosen to survive being an
 * outline, and the pair is the one Team Elimination already shipped, kept verbatim rather than
 * re-picked in a change that was about *which* colours, not about their weight.
 *
 * The keys are `A` and `B` because those are literally the values `TEAM_ATTRIBUTE` holds, and which
 * key gets which colour is now the only thing about a team's appearance that is a convention of this
 * file rather than of the map.
 */
export const TEAM_COLORS: { readonly A: Color3; readonly B: Color3 } = {
	A: Color3.fromRGB(158, 58, 52),
	B: Color3.fromRGB(56, 92, 152),
};

/**
 * The colour the side `label` is drawn in, or `undefined` if there is no such side.
 *
 * The counterpart to {@link sideNameOf}, and loose in the same way for the same reason: `label`
 * arrives as a plain string off an attribute, so an unrecognised one answers `undefined` rather
 * than throwing. The caller decides what "no side" should look like — for the outline it is the
 * default colour, which is also what the lobby is drawn in.
 *
 * **No mode, which is the difference from the version before this.** It took one and looked the
 * colour up per mode; the colour is now the same in every mode, so a parameter that is ignored at
 * every call site would be a lie told at three of them. Callers still read the mode for their own
 * reasons — the score bar hides itself outside a scoring mode — but not for this.
 */
export function teamColourOf(label: string): Color3 | undefined {
	if (label === "A") return TEAM_COLORS.A;
	if (label === "B") return TEAM_COLORS.B;

	return undefined;
}

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
