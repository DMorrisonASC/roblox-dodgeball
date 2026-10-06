import { GameModeId } from "shared/gameMode";
import { DRAW, RoundOutcome, TEAM_A, TEAM_B, TeamLabel } from "../team";
import { DeathDecision, GameMode, RoundView } from "./GameMode";

/**
 * Which side is which.
 *
 * `TEAM_ATTRIBUTE` carries the labels `"A"` and `"B"` and says nothing about what they mean, so
 * the meaning is this file's convention — stated once, here, rather than spread through the
 * methods below as bare `TEAM_A`s that each have to be re-read to find out which side they are.
 *
 * Seekers are `A` for no better reason than that the even split in `splitEvenly` gives the odd
 * player to `A`, and "the side with one player on it" is the shape a seeker side has. It does not
 * matter which way round it goes; what matters is that every method here agrees.
 */
const SEEKERS: TeamLabel = TEAM_A;
const DODGERS: TeamLabel = TEAM_B;

/**
 * Asymmetric: one seeker to begin with, everybody else a dodger, and a hit that converts rather
 * than eliminates.
 *
 * **The mode where the round never shrinks.** In Team Elimination a hit takes a player out; in
 * Score Rush it sends them back in on the same side; here it moves them to the *other* side — so
 * the roster stays the same size and the pressure only ever goes one way, every death being a gain
 * for the seekers and a loss for the dodgers.
 *
 * That is also what makes "resetting should never be a winning move" true by construction rather
 * than by a rule. A dodger who jumps off the map joins the seekers exactly as one who was hit
 * does, so the only thing a reset buys is the same thing a hit costs — and there is no branch
 * anywhere below that had to be written to make that so.
 *
 * **The whole win condition is one count.** There is no bookkeeping for "has this dodger been
 * hit", because being hit is the thing that removes a player from the dodger side: counting the
 * players still on `DODGERS` counts the un-hit dodgers, and the two ways the round can end are the
 * same number read at two moments — zero, or the clock. See {@link DodgeAndSeekMode.outcome}.
 *
 * **Friendly fire is not this mode's business, and it does not have to be.** Seekers cannot hit
 * each other because a same-side contact is refused globally, in the throw-hit path — so the
 * "seeker immunity" this mode wants is a property of the game rather than a rule stacked here on
 * top of it. What is left for this mode to say about a hit is only which side it sends the player
 * to: the opposite one.
 */
class DodgeAndSeekMode implements GameMode {
	public readonly id: GameModeId = "DodgeAndSeek";

	/** No points, no board. See {@link GameMode.scores}. */
	public readonly scores = false;

	/**
	 * One seeker picked at random, everybody else a dodger.
	 *
	 * **Nothing calls this.** The round's sides come from `MatchService`'s opt-in roster, and what a
	 * real round does with the two sides is convert a hit dodger through `onDeath` — so the opening
	 * split described below is not the one any round in play uses. See {@link GameMode.assign}.
	 *
	 * Everyone is made a dodger first and one of them is then promoted, which is what makes the two
	 * degenerate sizes fall out rather than need branches: **nobody in the round** produces an empty
	 * map, and **one player** produces a lone dodger without the promotion ever running.
	 *
	 * Random rather than first-or-last, because there is nothing to pick on and a deterministic
	 * choice would hand the role to whoever `GetPlayers` happened to return first — the same player
	 * every round, on a server that is not losing people.
	 *
	 * **A one-player round is all dodgers, deliberately.** A solo seeker has nobody to seek, and
	 * the win condition below reads zero un-hit dodgers the instant the round starts — so the round
	 * would end in the second it began, and the round loop would spin. Making the lone player a
	 * dodger instead gives the round something to be: one player, un-hit, who wins it at the clock.
	 * That the round then runs its full length with nothing happening in it is an honest reading of
	 * a one-player round rather than something this rule invents.
	 *
	 * **No ratio is kept, and the imbalance is the point.** One seeker against nine and one against
	 * one are both valid starts: the mode is asymmetric by definition, so there is no balance to
	 * strike and nothing here tries.
	 */
	public assign(players: ReadonlyArray<Player>): Map<Player, TeamLabel> {
		const teams = new Map<Player, TeamLabel>();

		for (let index = 0; index < players.size(); index++) {
			teams.set(players[index], DODGERS);
		}

		if (players.size() > 1) {
			teams.set(players[math.random(0, players.size() - 1)], SEEKERS);
		}

		return teams;
	}

	/**
	 * Never called, and loud if it ever is.
	 *
	 * `RoundService` only asks a mode what a hit is worth when that mode keeps score — see
	 * {@link GameMode.scores} — so a scoreless mode has no hit rule to state and this has no job
	 * left to do. It warns rather than returning quietly because the only way to reach it is a
	 * change to that rule, and a round that started awarding points nobody designed is easier to
	 * hear about than to notice.
	 *
	 * **What this is not:** it is not where a hit converts a dodger. That is {@link onDeath}, below,
	 * because a conversion is a consequence of the player dying — and in this mode a death and a
	 * conversion are the same event, so they are one method rather than two.
	 */
	public hitAward(): number | undefined {
		warn("[Mode] DodgeAndSeek.hitAward was called — this mode keeps no score");

		return undefined;
	}

	/**
	 * Every in-round death sends the player to the seekers — and back into the round.
	 *
	 * **One answer for every cause, which is the whole point.** The mode does not distinguish a
	 * dodger who was hit from one who reset, because both leave the dodger side and join the
	 * seekers, and the win condition counts the dodger side. A rule that told them apart would be a
	 * rule about *how* somebody died that changed nothing about the game, and it would need the
	 * round to remember hits separately from deaths — bookkeeping kept in step with a count that
	 * already answers the question.
	 *
	 * **A seeker dying is a no-op, and it is not a special case.** They are already on `SEEKERS`;
	 * this returns the side they are already on, and the round writes a value that is already there.
	 * There is deliberately no branch below asking which side they came from, because asking is what
	 * would let a self-inflicted death behave differently on one side than the other — which is
	 * exactly the asymmetry a player would find and use.
	 *
	 * Respawn rather than eliminate, so the roster only ever changes *sides*: a converting seeker is
	 * still playing, and the round never gets smaller except by somebody leaving the server.
	 */
	public onDeath(): DeathDecision {
		return { kind: "respawn", team: SEEKERS };
	}

	/**
	 * Zero un-hit dodgers, or the clock.
	 *
	 * **One count answers both halves.** Anyone still on `DODGERS` is un-hit — a hit is precisely
	 * what moves a player off that side — so "how many dodgers are left" and "how many un-hit
	 * dodgers are left" are the same number, and this needs no second collection to keep in step
	 * with the sides. That is what collapses every path into one rule: a dodger converted by a hit,
	 * converted by a reset, or gone from the server all leave the same count behind, and the last
	 * of them taking it to zero is a seeker win with no case written for it.
	 *
	 * Read in this order because the early win outranks the clock, as in the other two modes: a
	 * round whose last dodger converts on the final second is a seeker win rather than a draw.
	 *
	 * **Nobody left at all is a draw**, matching the other two modes — an empty server must not sit
	 * inside a round until the clock runs out. It is checked *first* because the count below would
	 * otherwise read an empty round as "zero dodgers", which is a seeker win: true only if there was
	 * a round to win.
	 *
	 * **Dodgers win only at the clock**, even if every seeker has left. That is the rule as written,
	 * and it is also the safe reading: a dodger win-on-absence would end the round the moment the
	 * last seeker disconnected, which is not a thing that happened in the game.
	 */
	public outcome(view: RoundView): RoundOutcome | undefined {
		const inRound = view.playersInRound();

		if (inRound.size() === 0) return DRAW;

		let dodgers = 0;

		for (const player of inRound) {
			if (view.teamOf(player) === DODGERS) dodgers++;
		}

		if (dodgers === 0) return SEEKERS;

		if (view.getTimeRemaining() > 0) return undefined;

		return DODGERS;
	}
}

/** The one instance. See `TeamEliminationMode` for why a mode is a singleton. */
export const DODGE_AND_SEEK: GameMode = new DodgeAndSeekMode();
