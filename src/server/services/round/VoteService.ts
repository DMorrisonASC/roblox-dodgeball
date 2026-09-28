import { OnStart, Service } from "@flamework/core";
import { Players } from "@rbxts/services";
import { GAME_MODE_CONFIG } from "shared/config/gameMode.config";
import { encodeModeIds, GAME_MODE_NAMES, GameModeId, isGameModeId } from "shared/gameMode";
import {
	ROUND_MODE_ATTRIBUTE,
	ROUND_VOTE_OPEN_ATTRIBUTE,
	ROUND_VOTE_OPTIONS_ATTRIBUTE,
} from "shared/constants";
import { events } from "shared/networking";
import { DEFAULT_MODE, isPlayable, playableModes } from "./modes/registry";
import { roundStatusFolder } from "./roundStatus";

/**
 * The vote for the next round's mode: the window, the ballots, and the tally.
 *
 * **It owns no round logic at all.** It decides *which* mode the next round plays; `RoundService`
 * decides when a round is and asks it. That split is what keeps the interesting half — a majority
 * over a set of options, with a tiebreak — readable on its own, and it is why nothing here knows
 * what a round clock is.
 *
 * The window is opened and closed **by the round**, not by a timer of its own, so that a dev
 * pausing rounds pauses the vote with them. A `task.delay` here would have gone on counting while
 * everything else was held up, and would close a vote that had not really been open for its ten
 * seconds — see {@link GAME_MODE_CONFIG.VOTE_SECONDS}.
 */
@Service()
export class VoteService implements OnStart {
	/** The channel the client reads. Opened in `onStart`, synchronously. */
	private statusFolder!: Folder;

	/** Whether a vote is open right now. The round opens and closes it. */
	private windowOpen = false;

	/**
	 * Who voted for what.
	 *
	 * A `Map` rather than a tally, because a majority is over *voters* and one voter is one entry
	 * whatever they do — so re-voting replaces a ballot instead of adding one, and nobody can vote
	 * twice by pressing twice. Which is also the answer to "should somebody be able to change their
	 * mind": yes, and the last press is their vote, because the alternative is a player stuck with
	 * a misclick.
	 */
	private readonly ballots = new Map<Player, GameModeId>();

	/**
	 * The mode the last closed vote chose, and the one the next round will run.
	 *
	 * Starts at the game's original mode, which is what makes the first round of a server behave
	 * exactly as it did before any of this existed: there has been no vote yet, so the round plays
	 * what it always played.
	 */
	private selected: GameModeId = DEFAULT_MODE.id;

	public onStart(): void {
		this.statusFolder = roundStatusFolder();

		events.Server.OnEvent("castVote", (player, mode) => this.cast(player, mode));

		// A leaver's ballot is dropped. They are not here to play the round they voted for, and
		// letting a departed player help choose other people's next round is the kind of thing
		// that only shows up as "the vote came out odd" much later.
		Players.PlayerRemoving.Connect((player) => {
			this.ballots.delete(player);
		});

		// Seeded shut, so a client mounting between rounds finds a definite "no vote on" rather
		// than the absence of an answer — the same reason the round seeds its own attributes.
		this.statusFolder.SetAttribute(ROUND_VOTE_OPEN_ATTRIBUTE, false);
	}

	/**
	 * Open the window, offering everything this build can run.
	 *
	 * The options are published *with* the open flag rather than once at startup, because they are
	 * the server's answer to "what can be played here" and the moment they are needed is the moment
	 * they are read. A client that mounts mid-window gets both attributes in one replication.
	 */
	public openVote(): void {
		this.ballots.clear();
		this.windowOpen = true;

		this.statusFolder.SetAttribute(ROUND_VOTE_OPTIONS_ATTRIBUTE, encodeModeIds(this.options()));
		this.statusFolder.SetAttribute(ROUND_VOTE_OPEN_ATTRIBUTE, true);

		print(`[Vote] open for ${GAME_MODE_CONFIG.VOTE_SECONDS}s — ${this.optionNames()}`);
	}

	/**
	 * Close the window, count the ballots and decide.
	 *
	 * **Idempotent, and that is load-bearing.** `RoundService` closes the vote both when the window
	 * elapses and again on the boundary before the round starts, because a vote that never reached
	 * its ten seconds — a paused harness, a reload — must still produce an answer rather than leave
	 * the round with no mode. The second call is a no-op, so the boundary close cannot re-roll a
	 * tie that was already broken.
	 */
	public closeVote(): void {
		if (!this.windowOpen) return;
		this.windowOpen = false;

		this.statusFolder.SetAttribute(ROUND_VOTE_OPEN_ATTRIBUTE, false);

		const counts = this.tally();
		const voters = this.ballots.size();
		const decision = this.decide(counts);

		this.selected = decision.mode;

		// The count is printed next to the result, so "we voted for Score Rush" and "three people
		// voted" can be told apart from "one person voted and nobody else knew".
		print(`[Vote] closed — ${voters} vote(s): ${this.report(counts)}`);

		if (decision.tied.size() > 1) {
			print(`[Vote] tie between ${this.namesOf(decision.tied)} — picked one at random`);
		}

		print(`[Vote] next round: ${GAME_MODE_NAMES[this.selected]}`);

		// Written here rather than at the round's opening whistle, because the intermission that
		// follows is exactly when somebody wants to know what they are about to play. See
		// `ROUND_MODE_ATTRIBUTE` — the **id**, not the display name: it is the key every table about
		// a mode is looked up by, on both sides of the wire.
		this.statusFolder.SetAttribute(ROUND_MODE_ATTRIBUTE, this.selected);
	}

	/** The mode the next round should run. */
	public selection(): GameModeId {
		return this.selected;
	}

	// ---- Internals ----

	/**
	 * Take a ballot, if the window is open and the mode is one this build can run.
	 *
	 * **Every check is here rather than on the client.** The client's buttons are built from the
	 * options the server published, so a well-behaved client cannot send anything else — but the
	 * wire is not the server, and `mode` arrives as an arbitrary string from a machine that could
	 * be modified, a version behind, or simply buggy. `isGameModeId` is the check that it names a
	 * mode at all; `isPlayable` is the check that this build has one behind the name.
	 *
	 * A refusal is silent to the client and loud in the output: a client cannot do anything about
	 * it, and a round that quietly ignored a vote would be worse than one that says why.
	 */
	private cast(player: Player, mode: string): void {
		if (!this.windowOpen) {
			print(`[Vote] ${player.Name}: refused "${tostring(mode)}" — no vote is open`);
			return;
		}

		if (!isGameModeId(mode) || !isPlayable(mode)) {
			print(`[Vote] ${player.Name}: refused "${tostring(mode)}" — not a mode this build can run`);
			return;
		}

		this.ballots.set(player, mode);

		print(`[Vote] ${player.Name} → ${GAME_MODE_NAMES[mode]}`);
	}

	/** How many ballots each option holds. Options nobody voted for are simply absent. */
	private tally(): Map<GameModeId, number> {
		const counts = new Map<GameModeId, number>();

		for (const [, mode] of this.ballots) {
			counts.set(mode, (counts.get(mode) ?? 0) + 1);
		}

		return counts;
	}

	/**
	 * The winner, and who it was tied with.
	 *
	 * **Highest count wins; a tie is broken at random among the tied options.** Walked over the
	 * *options* rather than over the tally, so a mode nobody voted for is still a candidate at zero
	 * — which is what makes "nobody voted" behave: every option is tied on nothing, and the random
	 * pick among them is the honest answer, reached by the same rule as any other tie rather than
	 * by a special case for an empty vote.
	 *
	 * Non-voters are not counted at all. They are not a ballot for "no preference", and treating
	 * them as one would let a single voter outvote the rest of a silent server by accident.
	 */
	private decide(counts: Map<GameModeId, number>): { mode: GameModeId; tied: GameModeId[] } {
		let best = 0;
		let tied: GameModeId[] = [];

		for (const mode of playableModes()) {
			const count = counts.get(mode.id) ?? 0;

			if (count > best) {
				best = count;
				tied = [mode.id];
			} else if (count === best) {
				tied.push(mode.id);
			}
		}

		// No options at all, which cannot happen while the registry is non-empty — but a vote that
		// decided nothing would be a round with no mode, so it keeps the last answer instead.
		if (tied.size() === 0) return { mode: this.selected, tied: [] };

		if (tied.size() === 1) return { mode: tied[0], tied };

		return { mode: tied[math.random(0, tied.size() - 1)], tied };
	}

	/** The ids this vote may offer, in the registry's order. */
	private options(): GameModeId[] {
		const ids: GameModeId[] = [];

		for (const mode of playableModes()) {
			ids.push(mode.id);
		}

		return ids;
	}

	/** Every option and its count, as one line — including the ones nobody voted for. */
	private report(counts: Map<GameModeId, number>): string {
		let line = "";

		for (const mode of playableModes()) {
			const part = `${GAME_MODE_NAMES[mode.id]} ${counts.get(mode.id) ?? 0}`;
			line = line === "" ? part : `${line}, ${part}`;
		}

		return line;
	}

	private optionNames(): string {
		let line = "";

		for (const mode of playableModes()) {
			const name = GAME_MODE_NAMES[mode.id];
			line = line === "" ? name : `${line}, ${name}`;
		}

		return line;
	}

	private namesOf(ids: ReadonlyArray<GameModeId>): string {
		let line = "";

		for (const id of ids) {
			const name = GAME_MODE_NAMES[id];
			line = line === "" ? name : `${line}, ${name}`;
		}

		return line;
	}
}
