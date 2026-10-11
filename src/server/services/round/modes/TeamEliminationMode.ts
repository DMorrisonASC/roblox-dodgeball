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
	 * **Counted by asking the round, per side, rather than by keeping a tally.** The round is the one place that
	 * knows who is still playing, and a per-side count kept beside it would be a second answer to the same
	 * question, free to disagree with the first. **The loop that used to be here walked `playersInRound()` and
	 * counted the sides itself, and that is what made this mode rig-blind**: a rig has no `Player`, so a round of
	 * rigs counted nought on both sides and drew on its first tick. `standingFor` answers the same question with
	 * the rigs included, and the two counts are one call each rather than a walk.
	 *
	 * **What a rig cannot do is be eliminated**, which is this mode's whole rule and is worth naming rather than
	 * leaving to be discovered: a rig's death never reaches the round (`RespawnBehavior` rebuilds it in place,
	 * which is Score Rush's rule for a death), so a side of rigs cannot fall to zero and this mode would not end
	 * on elimination. Counted here all the same, because the alternative — leaving rigs out of a side count — is
	 * the version that ends the round the moment it opens.
	 */
	public outcome(view: RoundView): RoundOutcome | undefined {
		const standingA = view.standingFor(TEAM_A);
		const standingB = view.standingFor(TEAM_B);

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
