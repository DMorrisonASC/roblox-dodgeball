import { GameModeId } from "shared/gameMode";
import { DRAW, RoundOutcome, TEAM_A, TEAM_B, TeamLabel } from "../team";
import { DeathDecision, GameMode, RoundView, splitEvenly } from "./GameMode";

/**
 * Two fixed sides, no respawn, last side standing wins. The game's original round.
 *
 * **A faithful port rather than a rewrite.** Everything this class decides is what `RoundService`
 * used to decide inline, moved without a change of rule — because a mode system whose first mode
 * behaves differently from the game it replaced is a mode system nobody can trust to be
 * behaviour-preserving when the *second* one arrives. The three decisions are the even split, the
 * elimination, and the two ways to win.
 *
 * Worth reading as the reference for the interface: it is the simplest of the three, it uses no
 * clock-dependent state beyond the outcome, and it is the only one that never returns anything but
 * `eliminate` from a death.
 */
class TeamEliminationMode implements GameMode {
	public readonly id: GameModeId = "TeamElimination";

	/** No points, no board. See {@link GameMode.scores}. */
	public readonly scores = false;

	/** Half the server each, shuffled — see {@link splitEvenly}. */
	public assign(players: ReadonlyArray<Player>): Map<Player, TeamLabel> {
		return splitEvenly(players);
	}

	/**
	 * Nothing. A hit here kills, and killing people *is* this mode's score — writing points down
	 * as well would be two ways of counting one side's progress, free to disagree.
	 */
	public hitAward(): number | undefined {
		return undefined;
	}

	/** A death is the elimination. It is the whole of what this mode is. */
	public onDeath(): DeathDecision {
		return { kind: "eliminate" };
	}

	/**
	 * Last side standing, or — failing that — the side with more players when the clock runs out.
	 *
	 * Two ways to win, and the first outranks the clock. **Both sides empty is a draw however much
	 * time remains**: there is nothing left to win with, and that same case is what stops an empty
	 * server from sitting inside a round until the clock runs out.
	 *
	 * Counted by walking the living rather than by keeping a tally. `inRound` is the one place that
	 * knows who is still playing, and a per-side count kept beside it would be a second answer to
	 * the same question, free to disagree with the first.
	 */
	public outcome(view: RoundView): RoundOutcome | undefined {
		let standingA = 0;
		let standingB = 0;

		for (const player of view.playersInRound()) {
			const team = view.teamOf(player);

			if (team === TEAM_A) standingA++;
			else if (team === TEAM_B) standingB++;
		}

		if (standingA === 0 && standingB === 0) return DRAW;
		if (standingA === 0) return TEAM_B;
		if (standingB === 0) return TEAM_A;

		if (view.getTimeRemaining() > 0) return undefined;

		if (standingA > standingB) return TEAM_A;
		if (standingB > standingA) return TEAM_B;

		return DRAW;
	}
}

/**
 * The one instance. A mode holds nothing, so there is nothing for a second one to be for — and a
 * single shared object is what lets `RoundService` compare modes by identity if it ever wants to.
 */
export const TEAM_ELIMINATION: GameMode = new TeamEliminationMode();
