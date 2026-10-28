import { Players, ReplicatedStorage } from "@rbxts/services";
import { IN_ROUND_ATTRIBUTE, ROUND_STATE_ATTRIBUTE, ROUND_STATUS_FOLDER, TEAM_ATTRIBUTE } from "shared/constants";

/**
 * **The three questions the game asks about a body's relationship to the round, asked in one place.**
 *
 * Every rule in this project that says "in the round", "playing" or "opted in" is one of three facts, and before
 * this file there were four private copies of the first one (`SuperService`, `StatsService`, `OutlineService` and
 * `MysteryBoxService` each spelled the folder lookup and the `"Playing"` literal out for themselves), two copies of
 * the third (`client/roundZone.isParticipant` and the inline pair in `OutlineService`), and no single answer to the
 * second. The copies did not disagree — that is the point of consolidating them rather than a hunt for a bug — but
 * each one was a place a rename or a new exception could land alone, and one of them already had.
 *
 * **These read published attributes and the status folder, and nothing else.** No service, no private table, no
 * caching, no healing: the round publishes its state on a folder and its membership on each `Player`, and these
 * three functions read exactly what every caller could already read for itself. A caller that answers the same
 * question from private state (`RoundService.activePlayers`, `RoundService.teams`) is not in this file's population
 * and must not be pulled into it — a private table is a fact about *this server's* bookkeeping and a replicated
 * attribute is a fact about the *game*, and the two are only equal while somebody keeps them so.
 *
 * **`shared/` rather than `server/`, because the client asks the first and third of these too** — the dodge's
 * `inRoundOrZone`, the shift lock, the dock, the aim assist. The server-side `roundStatus.ts` cannot be imported
 * from `src/client/`, so this file does its own `FindFirstChild`; that is the same three lines those copies had.
 */

/** What `ROUND_STATE_ATTRIBUTE` says while a round is being played. A word between files, spelled once now. */
const PLAYING = "Playing";

/** What `TEAM_ATTRIBUTE` holds for each side. Two literals between two files, spelled the same way. */
const SIDE_A = "A";
const SIDE_B = "B";

/**
 * Whether a round is being played, as the round folder publishes it.
 *
 * **The weakest of the three questions, and the one most often mistaken for a stronger one.** The phase is a fact
 * about the *server*: it is true for every player watching from the lobby, for a player who opted out, for a player
 * who surrendered out of the round, and for one standing on a practice floor. Anything that means "may *this body*
 * act" wants {@link isParticipant} — or {@link isParticipant} or a zone — and a caller that reads this where it
 * meant that is asking about the game rather than about the body.
 *
 * **A folder that is not there yet is not a round**, which is the right answer for the first moments of a server's
 * life and for a client that has not been told what the round is doing. `FindFirstChild` rather than
 * `WaitForChild` throughout: this is read from inside throws, catches and per-frame HUD code, and a yield there
 * would be the whole machine waiting on a folder.
 */
export function isPlaying(): boolean {
	const folder = ReplicatedStorage.FindFirstChild(ROUND_STATUS_FOLDER);
	if (folder === undefined) return false;

	return folder.GetAttribute(ROUND_STATE_ATTRIBUTE) === PLAYING;
}

/**
 * Whether `body` is wearing a side label — **which is not the same question as being in the round**, and this
 * function's name says what it actually answers rather than what a caller might wish it said.
 *
 * **The lifecycle, because the distinction is entirely a lifecycle question.** `TEAM_ATTRIBUTE` is written by
 * `RoundService.assignTeams` from the opt-in roster and cleared by the same method at the *next* whistle — nothing
 * clears it at the end of a round, at an elimination, or on a surrender (both of which keep it on purpose, so the
 * side's head count survives a body walking out). So through a whole intermission and the celebration that opens it,
 * every player who played the round still carries a side, and a player who only *opted in* — who touched a join part
 * and is waiting for the next whistle — carries none. **"Has a side" therefore means "this round put me on one"**,
 * not "I am currently in the round" and not "I asked to play".
 *
 * **That is exactly what the celebration gate wants and exactly what a participant check cannot give it**: while a
 * round is being celebrated the phase is already `Intermission` and `IN_ROUND_ATTRIBUTE` has been cleared for
 * everybody, so {@link isParticipant} is false for every body in the arena and a gate built on it would refuse
 * nobody. See `BallService.throwForPlayer`, which is the caller that had to learn this.
 *
 * **The label is validated rather than merely read**, which is `client/roundZone.sideOf`'s rule and `npc/rigs.ts`'s:
 * an attribute is a string anybody may write, so `Team = "Red"` is a colour rather than a side. What this returns is
 * the yes/no; a caller that needs *which* side asks `roundZone.sideOfBody`, which is the validating read with the
 * label attached.
 *
 * **A `Model` or a `Player`, and the two branches are not symmetric.** A player's character model does not carry
 * the label — it is on the `Player`, because a character is replaced on every death and the side is not — so a
 * reader that asked the model would read every player as side-less. A rig carries its own, painted in Studio or
 * written by its pad walk, which is why the model arm is not merely a fallback for something gone wrong.
 */
export function hasSide(body: Model | Player): boolean {
	if (body.IsA("Player")) return isSideLabel(body.GetAttribute(TEAM_ATTRIBUTE));

	const player = Players.GetPlayerFromCharacter(body);

	return isSideLabel((player ?? body).GetAttribute(TEAM_ATTRIBUTE));
}

function isSideLabel(label: unknown): boolean {
	return label === SIDE_A || label === SIDE_B;
}

/**
 * **Whether this player is in the round being played** — the round says it has them *and* a round is being played.
 *
 * Both conditions, and the two halves fail in opposite directions. `IN_ROUND_ATTRIBUTE` is the round's own answer
 * to "is this player mine": written by `admitWithCover` and by the mid-round admission, cleared by `eliminate`, by
 * the round's end and by `assignTeams`. Read alone it is a frame stale at a boundary; read with the phase it is
 * exact. The phase alone, meanwhile, is true for every spectator in the lobby, which is the report that made this
 * the dodge's rule in the first place (`client/roundZone.inRoundOrZone`) and the shift lock's before it.
 *
 * **`IN_ROUND_ATTRIBUTE` replaced "on a side" here on 2026-10-20, and a surrender broke the old answer.**
 * `RoundService.surrender` deliberately leaves a player in `teams` — the side's head count has to survive somebody
 * walking out — so `TEAM_ATTRIBUTE` stays on them while they stand in the lobby, and "has a side" went on reporting
 * them as a participant. The visible result was a shift lock staying on over an empty lobby. There is no phase or
 * side combination that answers this; the round had to publish membership, and did.
 *
 * **The phase is part of this function rather than a separate predicate**, deliberately: every caller that wants
 * "is this player in the round" wants both terms, and the compositions that want only one of them are named
 * separately — {@link isPlaying} for the game, {@link hasSide} for the body's label. A caller that composed the
 * phase back on would be writing a term this already has.
 */
export function isParticipant(player: Player): boolean {
	return isPlaying() && player.GetAttribute(IN_ROUND_ATTRIBUTE) === true;
}
