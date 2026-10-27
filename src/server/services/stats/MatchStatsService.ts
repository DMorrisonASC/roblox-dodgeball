import { OnStart, Service } from "@flamework/core";
import { Players } from "@rbxts/services";
import { TEAM_ATTRIBUTE } from "shared/constants";
import { pointsOf } from "shared/matchStats";
import type { MatchStatsRow } from "shared/matchStats";
import { events } from "shared/networking";
import { logInfo, logWarn } from "shared/logger";
import { rigsOnASide } from "../../npc/rigs";
import { TEAM_A } from "../round/team";
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
		// **A request event and an answer event, rather than an async function** — see `networking.ts` on
		// `matchStats` for the reversal and the report behind it. Both are resolved here, at boot, for the reason
		// every other sender in this project resolves its remote once: `Get` creates the instance, and doing it
		// inside the handler would build a remote on the first press — when the client that wants to *listen* on
		// it has already mounted and found nothing.
		const answer = events.Server.Get("matchStatsBoard");

		events.Server.OnEvent("matchStats", (player) => {
			// **The row count is printed at the send rather than only inside `answer`**, because the two are
			// different facts: `answer` says what the board *contained*, and this says that the payload was
			// handed to the remote. A throw in `SendToPlayer` — a payload the serializer refuses, an event
			// whose declared type does not match what is being sent — is invisible without this pair, and it
			// looks from the client exactly like a board that was never asked for.
			const rows = this.answer(player);

			logInfo(`[Stats] sending ${rows.size()} row(s) to ${player.Name}`);

			const [ok, failure] = pcall(() => answer.SendToPlayer(player, rows));

			if (!ok) logWarn(`[Stats] the send to ${player.Name} threw — ${tostring(failure)}`);
		});

		logInfo("[Stats] board up — throws, hits, catches and dodges, read from the badge ledger");
	}

	/**
	 * **The remote's whole server side, and it says out loud what it answers** — the one line that separates
	 * the three ways this panel can be empty.
	 *
	 * The report is the fix for a report. A player came back with *"the board is completely empty"*, and every
	 * part of the chain had been written and none of it had ever been seen to work: `MatchStatsService` was
	 * constructed and printed its boot line, the client mounted and printed its own, the panel appeared — and
	 * whether the server had answered "eight rows" or "no rows" or nothing at all was not in the output
	 * anywhere. **Three faults share that symptom and this line is what tells them apart**: *no line at all* is
	 * a call that never arrived (the remote, the key binding, the request), *`0 rows`* is a server that
	 * answered and had nothing to say — which is a filter or a side, not a client — and *`N rows`* with an
	 * empty panel is a client that received the answer and drew it nowhere. Each of those is a different file.
	 *
	 * **One line per press, and that is affordable for exactly the reason a per-turn line would not be.** The
	 * board is asked for on a `Begin` and never polled — see `MatchStatsController.refresh`, which asks once
	 * per hold — so this is one `print` per player per press, on a service that owns no state and runs no loop.
	 * It names the asker, because a board the *server* is filling and a board somebody is *looking at* are
	 * different questions and a name on the line answers both.
	 *
	 * **The counts are derived from the rows themselves, so they cannot disagree with what is sent.** The side
	 * split is the client's own grouping (`"A"` then `"B"`, `SIDES` on the far side), and `scored` is how many
	 * of those bodies have earned anything — which is the one number that says whether the *formula* had
	 * something to read. A board of eight rows whose points are all nought is a board where nobody has thrown
	 * anything yet; eight rows and eight scored is a board with a match in it. Those two are identical on screen
	 * and one word apart here.
	 *
	 * **`scored` rather than the ledger's own size, and that is a Luau fact rather than a preference.**
	 * `BadgeService.tally()` is *typed* `ReadonlyMap` but compiles to a plain table — `new Map()` is `{}` and
	 * `get` is an index — so `tally.size()` emits a generic `for` over a table, which raises. Counting the rows
	 * is the same number of bodies by a route that cannot fail.
	 *
	 * **The `pcall` is because a throw inside an `OnServerEvent` handler is the silence this whole method is
	 * about.** The engine prints the traceback, but it prints it as a server error with no mention of the board,
	 * and the client is left waiting on a promise that will not resolve until its sixty-second timeout — so a
	 * thrown board looks exactly like a board that was never asked for. Caught here, the player gets an empty
	 * board and the output says why.
	 */
	private answer(player: Player): ReadonlyArray<MatchStatsRow> {
		const [ok, result] = pcall(() => this.board());

		if (!ok) {
			logWarn(`[Stats] the board threw for ${player.Name} — ${tostring(result)}`);

			return [];
		}

		const rows = result as ReadonlyArray<MatchStatsRow>;

		if (rows.size() === 0) {
			logWarn(
				`[Stats] board for ${player.Name} — 0 rows: nobody is on a side ` +
					`(${Players.GetPlayers().size()} player(s) connected)`,
			);

			return rows;
		}

		let a = 0;
		let scored = 0;

		for (const row of rows) {
			if (row.side === TEAM_A) a += 1;
			if (row.points > 0) scored += 1;
		}

		logInfo(
			`[Stats] board for ${player.Name} — ${rows.size()} row(s), A ${a} / B ${rows.size() - a}` +
				`, ${scored} with points`,
		);

		return rows;
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
	 * **`Player.Name` and `Model.Name`, and nothing else, is the identity that travels.** Both loops pass a
	 * plain string to {@link rowFor}, so a row carries no `Player`, no `Model`, no `UserId` and no `DisplayName`
	 * — which is what makes a rig a first-class row rather than a special case on the far side. The client
	 * prints that string and looks nothing up, so there is no avatar to fail to load and no headshot to request
	 * for a body that has none. See `MatchStatsRow.name`, which is why the *name* and not the display name.
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
