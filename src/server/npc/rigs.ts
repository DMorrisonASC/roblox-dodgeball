import { CollectionService, Workspace } from "@rbxts/services";
import { TEAM_ATTRIBUTE } from "shared/constants";
import { MATCH_MAX_PER_TEAM } from "../config/match.config";
import { TEAM_A, TEAM_B, TeamLabel } from "../services/round/team";
import { NPC_TAG } from "./Behavior";

/**
 * One question about rigs, answered once for the two services that both need it: **which rigs are
 * standing on a side.**
 *
 * **This module exists so that "a rig with a `Team` attribute is a body on that side" is one sentence,
 * not two.** `RoundService` needs the list for the round itself — who is a participant, who to teleport,
 * who to count in the outcome — and `MatchService` needs the same list to say whether a match can start.
 * The two cannot share through either service: `MatchService` importing `RoundService` would be a require
 * cycle (the round constructs the match service, and its own class doc records why the match service
 * reads the phase from a folder instead of asking the round). A neutral module is the third home the two
 * already have for the side labels themselves — `team.ts` — and this is the same arrangement one step
 * out: a fact about rigs, imported by whoever asks.
 *
 * **The side is the whole of the opt-in, for a rig.** A player walks into a join part and `MatchService`
 * writes them down; a rig has no join part, so its side is the `TEAM_ATTRIBUTE` painted on it in Studio.
 * That is what makes the feature opt-in per rig: a rig with no `Team` attribute is in neither of these
 * lists, and every practice dummy and spawned rig in the place behaves exactly as it did before. It is
 * the same attribute the round publishes for players, read off a model here rather than off a `Player`.
 */

/**
 * The side a rig is painted with, or nothing — **the validated read of `TEAM_ATTRIBUTE` on a rig.**
 *
 * The attribute is a string anybody can put anything into, so a value that is not one of the two labels
 * reads as "no side" rather than being passed on as a side. That matters more for a rig than for a
 * player: a player's attribute is written by `RoundService`, from a map that only ever holds the two
 * labels, while a rig's is written by hand in the Explorer.
 */
export function sideOfRig(rig: Model): TeamLabel | undefined {
	const label = rig.GetAttribute(TEAM_ATTRIBUTE);

	if (label === TEAM_A || label === TEAM_B) return label;

	return undefined;
}

/**
 * Every rig holding a side: **the `NPC`-tagged models in the world whose `TEAM_ATTRIBUTE` is a label.**
 *
 * **The pair is returned rather than the model alone**, because the callers want different things from
 * the same walk: the round wants the models (to teleport and to count), and `MatchService.canStart`
 * wants the side of each (to count how many stand on each). A list of models would make the second
 * caller re-read the attribute it has just been filtered by, and a list of sides would leave the first
 * re-walking the tag. Both needs are one walk, so both answers are handed over together.
 *
 * **The conditions are the same ones `RoundService.roundParticipants` applies to a rig**, which is
 * deliberate rather than a coincidence: `IsA("Model")` because a tag is a string anybody can put on
 * anything; `IsDescendantOf(Workspace)` because `CollectionService` answers about the whole DataModel,
 * so a rig inside a template parked in `ServerStorage` wears `NPC` exactly as one in the arena does —
 * and `RespawnBehavior` builds its replacement outside the world, which is a rig standing nowhere. This
 * module is the one place those two tests and the side test are written, so the round and the match
 * service cannot come to two answers about whether a given rig counts.
 *
 * **Not phase-gated, and the caller is why.** `RoundService.rigsInRound` adds the `Playing` gate because
 * its answer is "who is in *this round*", and between rounds a side means nothing. `MatchService.canStart`
 * asks during an intermission, when the answer it wants is "who would play the next round", and a rig
 * painted with a side is that whether or not a round is running. One list, two gates, and the gates live
 * with the callers that mean them.
 */
export function rigsOnASide(): ReadonlyArray<{ readonly rig: Model; readonly team: TeamLabel }> {
	const rigs: Array<{ rig: Model; team: TeamLabel }> = [];

	for (const instance of CollectionService.GetTagged(NPC_TAG)) {
		if (!instance.IsA("Model")) continue;
		if (!instance.IsDescendantOf(Workspace)) continue;

		const team = sideOfRig(instance);
		if (team === undefined) continue;

		rigs.push({ rig: instance, team });
	}

	return rigs;
}

/**
 * How many rigs hold each side — a count over {@link rigsOnASide}.
 *
 * **A view over the list rather than a second derivation.** The list is the source; this is the shape
 * the "may a round start" callers want, and it is computed from the same walk, so a count and a list
 * can never disagree about the same rig. It is what `MatchService.canStart`, `RoundService.belowMinimum`
 * and the round's own start line each read, instead of each filtering the list by side on its own.
 */
export function rigCounts(): { readonly a: number; readonly b: number } {
	let a = 0;
	let b = 0;

	for (const { team } of rigsOnASide()) {
		if (team === TEAM_A) a++;
		else b++;
	}

	return { a: a, b: b };
}

/**
 * **The side a rig actually takes on arrival, given the one it was sent to.**
 *
 * `WalkToJoinPadBehavior` writes `TEAM_ATTRIBUTE` when a rig reaches its pad, and what it writes is this
 * rather than the side the pad was painted for. **The pad is a preference, not an instruction**: four
 * bodies is a side, and a fifth rig walking onto the same sign is a fifth body on that side — which the
 * round counts, teleports and scores against. The user's rule is that the overflow goes to the other pad
 * rather than being turned back, so the lobby fills instead of piling up.
 *
 * **The count is the rigs on a side and nothing else**, which is the number `LobbyRigService` seats to and
 * the number a rig's arrival can change. Players are `MatchService`'s roster and are balanced there, on
 * their own cap — the two counters are deliberately separate, because a rig does not take a player's
 * quota (`MatchService.canStart` argues that at length).
 *
 * **Both sides full returns the side it was sent to**, rather than nothing. A rig with no side is a body
 * nothing manages: it wears no walk tag after this branch, so `LobbyRigService` would never move it again
 * and it would stand in the lobby for the session. Taking the preferred side overfills by one, which is a
 * state `LobbyRigService.releaseRigs` already knows how to trim, and an overfull side is a fault that
 * repairs itself where an orphan is one that does not.
 */
export function sideWithRoom(preferred: TeamLabel): TeamLabel {
	const other = preferred === TEAM_A ? TEAM_B : TEAM_A;

	let preferredCount = 0;
	let otherCount = 0;

	for (const { team } of rigsOnASide()) {
		if (team === preferred) preferredCount++;
		else otherCount++;
	}

	if (preferredCount < MATCH_MAX_PER_TEAM) return preferred;
	if (otherCount < MATCH_MAX_PER_TEAM) return other;

	return preferred;
}
