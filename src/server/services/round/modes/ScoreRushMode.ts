import { GameModeId } from "shared/gameMode";
import { GAME_MODE_CONFIG } from "shared/config/gameMode.config";
import { DRAW, RoundOutcome, TEAM_A, TEAM_B, TeamLabel } from "../team";
import { DeathDecision, GameMode, RoundView, splitEvenly } from "./GameMode";

/**
 * Two fixed sides and a target score, with everybody coming back when they go down.
 *
 * **The mode that differs from Team Elimination in exactly two answers**, which is the point of
 * having written the interface first: `onDeath` respawns instead of eliminating, and `outcome`
 * reads a score instead of counting heads. Everything else — the even split, the side names, the
 * absence of a hit rule — is the same answer, and is *written* the same way so the difference
 * between the two modes is readable at a glance.
 *
 * The respawn is what makes this mode work at all. A round that ends when a side is wiped is a
 * round where a target score would usually never be reached, because the losing side stops
 * existing before it can be caught up with — so the target and the respawn are not two features
 * that happen to be here together, they are one design.
 */
class ScoreRushMode implements GameMode {
	public readonly id: GameModeId = "ScoreRush";

	/** The only mode that keeps score. See {@link GameMode.scores}. */
	public readonly scores = true;

	public assign(players: ReadonlyArray<Player>): Map<Player, TeamLabel> {
		return splitEvenly(players);
	}

	/**
	 * A landed hit is a point for the side that landed it.
	 *
	 * The round credits the thrower's team — see {@link GameMode.hitAward} — so the rule here is
	 * only *how much*, which is the one thing that would change for a heavier weapon.
	 *
	 * **A rig's throw is worth a point to the rig's side, and that is a reversal the code made necessary
	 * rather than a rule change made here.** This method still answers only *how much*; who is credited is
	 * the round's business, and the round now resolves a rig thrower to its side exactly as it resolves a
	 * player (`RoundService.throwerOf` → `teamOf`). Before that, a rig's throw could not be attributed at
	 * all — so a round played *against* rigs finished at 0-0 no matter how many players their balls knocked
	 * over, which is the shape a scoring bug takes when the missing rule is at the other end of the wire.
	 * What this mode now says is "a hit is a point", whoever landed it.
	 *
	 * **There is no same-side case here, and there cannot be one.** Friendly fire is off for every
	 * mode, refused in the throw-hit path before any damage is done — see `RoundService.isFriendlyFire`
	 * and the guard in `BallComponent`. So the only hits that arrive are cross-team ones, and a
	 * branch for the other case would be unreachable.
	 */
	public hitAward(): number | undefined {
		return 1;
	}

	/**
	 * Everyone comes back — into the match, on the side they were already on.
	 *
	 * No `team` on the decision, so `RoundService` keeps the side it has, which matters because the
	 * alternative would be a mode that had to re-derive a player's team in order to preserve it.
	 * They respawn at their own side's spawn, which the round already handles for anyone still in
	 * `inRound` — so there is nothing mode-specific about where they come back.
	 */
	public onDeath(): DeathDecision {
		return { kind: "respawn" };
	}

	/**
	 * The target, then the clock, and nothing else.
	 *
	 * Reaching the target wins **immediately**, whatever the clock says — that is what makes it a
	 * target rather than a tiebreak, and it is checked before the clock so a round that hits it on
	 * its last second is a win rather than a draw.
	 *
	 * **Nobody left at all is a draw**, matching Team Elimination's answer to the same case and for
	 * the same reason: an empty server must not sit inside a round until the clock runs out. Note
	 * that this is *not* the same as one side leaving — a side that empties does not end the round
	 * early, because the other side is still playing and will win on points if it still holds them.
	 */
	public outcome(view: RoundView): RoundOutcome | undefined {
		if (view.participantsInRound().size() === 0) return DRAW;

		const pointsA = view.scores.get(TEAM_A) ?? 0;
		const pointsB = view.scores.get(TEAM_B) ?? 0;

		if (pointsA >= GAME_MODE_CONFIG.SCORE_RUSH_TARGET) return TEAM_A;
		if (pointsB >= GAME_MODE_CONFIG.SCORE_RUSH_TARGET) return TEAM_B;

		if (view.getTimeRemaining() > 0) return undefined;

		if (pointsA > pointsB) return TEAM_A;
		if (pointsB > pointsA) return TEAM_B;

		return DRAW;
	}
}

/** The one instance. See `TeamEliminationMode` for why a mode is a singleton. */
export const SCORE_RUSH: GameMode = new ScoreRushMode();
