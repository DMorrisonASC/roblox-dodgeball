import { OnStart, Service } from "@flamework/core";
import { Players } from "@rbxts/services";
import { TEAM_ATTRIBUTE } from "shared/constants";
import { pointsOf } from "shared/matchStats";
import type { MatchStatsRow } from "shared/matchStats";
import { events } from "shared/networking";
import { rigsOnASide } from "../../npc/rigs";
import { BadgeService } from "../badges/BadgeService";
import type { RoundCounters } from "../badges/BadgeService";

/**
 * The in-match stats board's server half: **a read of the round's ledger, turned into rows.**
 *
 * **It counts nothing, and that is the whole of its design.** Every counter the board shows already exists and
 * is already incremented at the one place each fact becomes true — `BadgeService` keeps a per-body tally of
 * throws, catches, dodges and hits because its ribbons are derived from them, and its call sites are
 * `BallService.throwBall`, `BallComponent`'s catch branch, `DodgeService.requestDodge` and
 * `RoundService.registerHit`. So this service is a **reader with a formula**, not a second recorder: there is
 * one number per mechanic in the game, and the board cannot disagree with the badges about it.
 *
 * **Why a service at all, when it is one query.** Something has to answer the remote and something has to own
 * the points formula's application, and neither belongs in `BadgeService` — that service is named for the
 * ribbons and would be hosting a scoreboard endpoint. It is also not `RoundService`, which is the largest file
 * in the project and which already reaches `BadgeService`; a leaf that reads one service and answers one remote
 * is the smaller thing. See `HANDOFF.md` §0's "modular over monolithic" and its "a service for one method"
 * counter-argument, which this answers by *not* owning any state.
 *
 * **A leaf with one injection and no state.** `BadgeService` injects nothing, so there is no cycle to avoid —
 * unlike the dodge's view of the round, which is the reason `MatchStatsService` cannot simply read
 * `RoundService`.
 *
 * **No `onRoundEnded`, no persistence and no reset.** The ledger's lifetime is `BadgeService`'s, which already
 * clears at both round boundaries and after the badge window; a board that cleared itself too would be two
 * lifetimes to keep in step. The consequence is stated rather than hidden: **between rounds the board shows the
 * round that just finished, until the next `Playing` edge wipes it** — which is the same life the badges have,
 * and the right one for a board drawn on demand.
 */
@Service()
export class MatchStatsService implements OnStart {
	constructor(private readonly badges: BadgeService) {}

	public onStart(): void {
		// **`OnFunction` rather than a RemoteEvent pair**, because the board is asked for rather than pushed —
		// see `networking.ts` on `matchStats` for the round-trip argument and the one cost it carries.
		events.Server.OnFunction("matchStats", () => this.board());

		print("[Stats] board up — throws, hits, catches and dodges, read from the badge ledger");
	}

	/**
	 * **The board, as one row per body on a side — players and rigs alike** — sorted nowhere, because sorting
	 * is the client's.
	 *
	 * **Rigs are on the board because a rig is a body in this game, not scenery.** `BadgeService` has counted
	 * them the whole time — `keyOf` folds a character to its `Player` and leaves a rig as its own `Model` — and a
	 * round against rigs is mostly rigs, so a board that listed only people would be empty in exactly the match a
	 * player spends most of their time in. That was the report: *"I see no stats for the rigs"*, against a
	 * round that had none on the human side.
	 *
	 * **They are not marked, and that is a decision rather than an omission.** See `BadgeService` on the kill
	 * cam: a rig in this project is dressed, named and animated to be hard to tell from a person, and a marker on
	 * the scoreboard would be the one tell on the screen that says otherwise. A rig's name comes from
	 * `rigPool`'s own list, so the column reads as a roster of people — which is the fiction the whole NPC system
	 * keeps.
	 *
	 * **Two sources, because the two kinds of body keep their side in different places.** A player's is on the
	 * `Player` (written by `assignTeams`, and it outlives the character), so those are walked from
	 * `Players.GetPlayers()`. A rig's is an attribute painted on the model, and `rigsOnASide` is the one place
	 * that list is derived — world-filtered and side-validated, shared with `RoundService` and `MatchService`, so
	 * the board cannot disagree with the round about which rigs are in it.
	 *
	 * **Every connected player is a candidate even with nothing counted**, which is the difference between a
	 * board and a list of people who have succeeded: `tally` only holds a body once something has happened to it,
	 * so walking the tally instead would leave out the player who has done nothing all round — where everybody
	 * starts. `?? 0` in {@link rowFor} is what turns that absence into the nought their row should say. **Rigs
	 * come from the side list rather than from the tally for the same reason**: a rig that has not thrown
	 * anything yet is still standing on a side and still belongs on the board.
	 *
	 * **A side is required, and that is the whole filter.** A player who never touched a join pad has no side,
	 * and neither does a practice dummy or a rig nobody painted — both of which are honest reasons to leave a
	 * body off a board about the *match* rather than about the server. **The player's side is read and passed
	 * through unvalidated** while the rig's comes from `sideOfRig`'s own check, so a client groups by `"A"`/`"B"`
	 * with `teamColourOf` and a mode free to rename its sides stays true; the HUD falls back rather than erroring.
	 *
	 * **Not phase-gated, which matches `rigsOnASide`'s own note.** During a round the list is the match; during
	 * an intermission it is who is already seated for the next one, and the tallies survive a round end until
	 * `BadgeService` clears them — so a board opened between rounds shows the round that just finished. What it
	 * does not do is invent a number for anybody.
	 *
	 * **Points are computed here**, through the shared `pointsOf`, so the client receives a number it can sort
	 * on rather than a formula it would have to keep in step.
	 */
	public board(): ReadonlyArray<MatchStatsRow> {
		const tally = this.badges.tally();
		const rows = new Array<MatchStatsRow>();

		for (const player of Players.GetPlayers()) {
			const side = player.GetAttribute(TEAM_ATTRIBUTE);
			if (!typeIs(side, "string") || side === "") continue;

			rows.push(rowFor(player.Name, side, tally.get(player)));
		}

		for (const { rig, team } of rigsOnASide()) {
			rows.push(rowFor(rig.Name, team, tally.get(rig)));
		}

		return rows;
	}
}

/**
 * One body's row — **the only place the four counters become a `MatchStatsRow`.**
 *
 * A free function rather than a method, because it needs nothing from the service and both loops above call it
 * with the same three facts; a method would have made the two call sites read as two different operations. The
 * `?? 0` is the half that matters: `tally` is sparse by design (a body with nothing counted has no entry), and a
 * row is not.
 */
function rowFor(name: string, side: string, counters: Readonly<RoundCounters> | undefined): MatchStatsRow {
	const hits = counters?.hits ?? 0;
	const throws = counters?.throws ?? 0;
	const catches = counters?.catches ?? 0;
	const dodges = counters?.dodges ?? 0;

	return {
		name,
		side,
		points: pointsOf(throws, hits, catches, dodges),
		hits,
		throws,
		catches,
		dodges,
	};
}
