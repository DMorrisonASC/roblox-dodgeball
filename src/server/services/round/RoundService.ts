import { Service, OnStart } from "@flamework/core";
import { CollectionService, Players, Workspace } from "@rbxts/services";
import { ARENA_CONFIG } from "shared/config/arena.config";
import { DEBUG_CONFIG } from "shared/config/debug.config";
import { GAME_MODE_CONFIG } from "shared/config/gameMode.config";
import {
    TRANSITION_CONFIG,
    TRANSITION_COVER_SECONDS,
    TRANSITION_OPEN_SECONDS,
} from "shared/config/transition.config";
import { GAME_MODE_NAMES, sideNameOf } from "shared/gameMode";
import { findFolder } from "shared/find";
import { events, RoundResultRow } from "shared/networking";
import {
    ROUND_MODE_ATTRIBUTE,
    ROUND_STATE_ATTRIBUTE,
    ROUND_TIME_ATTRIBUTE,
    ROUND_TRANSITION_ATTRIBUTE,
    ROUND_WINNER_ATTRIBUTE,
    SPECTATING_ATTRIBUTE,
    TEAM_ATTRIBUTE,
} from "shared/constants";
// A second import from the same module rather than folding these into the block above, which is what the
// next tidy-up should do: the block is long and alphabetically grouped, and adding two names to it means
// re-reading it to find the right slot. Flagged rather than left silent.
import { ROUND_SCORE_A_ATTRIBUTE, ROUND_SCORE_B_ATTRIBUTE } from "shared/constants";
import { MATCH_MIN_PLAYERS, MATCH_SETTLE_SECONDS } from "../../config/match.config";
import { DevService } from "../../dev/DevService";
import { NPC_TAG } from "../../npc/Behavior";
import { applyBarrierGroups } from "../../collision/CollisionGroups";
import { RespawnService } from "../character/RespawnService";
import { BallService } from "../ball/BallService";
import { FreezeService } from "../actions/FreezeService";
import { WalkSpeedService } from "../character/WalkSpeedService";
import { MatchService } from "../match/MatchService";
import { StatsService } from "../stats/StatsService";
import { EconomyService } from "../economy/EconomyService";
import { SuperService } from "../super/SuperService";
import { GameMode, RoundView } from "./modes/GameMode";
import { DEFAULT_MODE } from "./modes/registry";
import { SCORE_RUSH } from "./modes/ScoreRushMode";
import { roundStatusFolder } from "./roundStatus";
import { DRAW, RoundOutcome, TEAM_A, TEAM_B, TeamLabel } from "./team";
import { VoteService } from "./VoteService";

enum RoundState {
    Intermission,
    Playing,
}

/** The two sides, in the order a round has them. For anything that has to ask about both. */
const TEAM_LABELS: ReadonlyArray<TeamLabel> = [TEAM_A, TEAM_B];

/**
 * The name the round's opening movement hold contributes under. See {@link RoundService.holdArenaEntry}.
 *
 * **Named rather than anonymous, for the reason `WalkSpeedService` gives about the sprint's key**: the map
 * of contributions *is* the speed, and a hold under one name is one thing to take off again. It is also the
 * name that appears inside the `[Walk]` line, which is the only place this freeze is visible after the fact.
 */
const ARENA_FREEZE_KEY = "ArenaFreeze";

/**
 * What that contribution is worth, in studs per second. **A deep negative, and that is the mechanism.**
 *
 * The contributions are *summed*, so a hold is not "set the speed to zero" — the base is still in the sum, and
 * so is the sprint if the player is holding the key. A contribution of `0` would leave a character walking at
 * whatever the others add up to. What actually stops the body is the clamp in `recalculateSpeed`:
 * `max(0, 20 - 1000)` is `0`. It is the same figure and the same trick `FreezeService` uses for the ability's
 * own hold, deliberately, so that anyone who has read one of them has read both.
 */
const ARENA_FREEZE_SPEED = -1000;

/**
 * What a boundary's transition does beyond covering the screen and moving everybody.
 *
 * **An options object rather than two more positional arguments**, because both are read at the call site as
 * often as they are written, and a bare `true` in the middle of a call is the shape that goes wrong quietly:
 * see {@link RoundService.transitionAround}, which used to take the round-end flag that way.
 */
interface TransitionOptions {
    /**
     * How long to hold everybody still after the move, in seconds, **measured from the move itself**.
     *
     * **Its full length is always waited for**, whatever the cover is doing — the two clocks are separate on
     * purpose, so that a transition changed or removed does not change this number. See `transitionAround`.
     *
     * Omitted or `0` for a boundary that holds nobody — the round's end does not, which is why that is the
     * default: a hold is the exception rather than the rule.
     */
    holdEveryoneFor?: number;

    /**
     * Whether this boundary is covered at all. Defaults to yes; `false` is how the round's end is switched
     * off. See `WIPE_AT_ROUND_END` for that decision — and note that a hold still runs without a cover,
     * because the freeze is a rule about the round rather than part of the wipe.
     */
    wipe?: boolean;
}

/**
 * Lethal damage for a thrower whose ball has been caught.
 *
 * **Mirrors `BallComponent`'s `HIT_DAMAGE`, on purpose.** A catch is not a hit, but the death it
 * causes is the same death: `TakeDamage` is what fires `Died`, and `Died` is what reaches
 * `handleDeath`, so the thrower goes out through the round's own door rather than through a second
 * mechanism invented for a catch. A humanoid's health is at most a hundred; this is a number nobody
 * survives.
 */
const CATCH_DEATH_DAMAGE = 1000;

/**
 * Whether the mode vote is offered at all.
 *
 * **A named switch rather than a deletion, and the calls it guards stay exactly where they are.**
 * Matchmaking makes the mode a thing a dev asks for (`!dev match`) rather than a thing the lobby votes
 * on, so the vote is off — but `VoteService` is untouched, its three call sites remain in `gameLoop`
 * behind this flag, and turning the vote back on is this one line. Deleting the calls instead would be
 * rewriting a working feature in the middle of building another one, and it would take the
 * `ROUND_MODE_ATTRIBUTE` writer with it — see the round boundary, which writes that attribute now.
 *
 * **What switching it off also does, deliberately:** `openVote` never runs, so the client's vote row
 * never appears at all — the flag it reads is seeded `false` by `VoteService.onStart` and nothing ever
 * sets it true.
 */
const VOTE_ENABLED = false;

/**
 * The round: a clock, a roster, and the rules a mode supplies.
 *
 * **It does not declare `implements RoundView`, deliberately.** It satisfies that interface, but
 * saying so in the heritage clause makes Flamework's transformer register `RoundView` as an
 * injectable identifier — an *interface*, which has no runtime presence at all — and that entry
 * lands in the git-tracked `flamework.build` for good. The check is not lost by leaving it out:
 * every mode call below passes `this` where a `RoundView` is expected (`this.mode.outcome(this)`),
 * so the compiler enforces the same contract at each call site rather than once at the top.
 */
@Service()
export class RoundService implements OnStart {
    private state = RoundState.Intermission;
    private timeRemaining = 0;
    private readonly activePlayers = new Set<Player>();

    /**
     * The rules this round is being played by.
     *
     * **Replaced at the opening of every playing phase from the match request**, so a mode is fixed
     * for the length of a round and cannot change under one that is already running. Both start paths
     * fix it at Score Rush today, so `requested ?? SCORE_RUSH` is Score Rush either way; the vote used
     * to be the writer and is switched off. `DEFAULT_MODE` initialises the field and is overwritten
     * at the first boundary.
     */
    private mode: GameMode = DEFAULT_MODE;

    /**
     * Points per side, for a mode that keeps score. See {@link RoundView.scores}.
     *
     * Public because it *is* part of the view a mode is handed: modes read this service through
     * the `RoundView` interface, so a private field would have to be copied out per call. Cleared
     * at the opening of every round, so no score survives into the one after it.
     */
    public readonly scores = new Map<TeamLabel, number>();

    /**
     * How many times each player's throws landed on somebody **in the round that is running**.
     *
     * **The round's number, which is deliberately not the one `StatsService` keeps.** That service
     * holds a lifetime count, persisted across sessions, because a player's record is theirs; this
     * one is the round's, thrown away when the next round opens, because the result panel asks a
     * question a career total cannot answer — "who landed the hits in *that* round" is a question
     * about the last few minutes, and a lifetime figure would let a player who joined yesterday
     * outrank one who just won the round.
     *
     * **Its lifetime is `scores`' lifetime exactly**: both are written during a round, both are
     * still readable for the whole intermission that follows it, and both are cleared at the
     * opening of the next one. That is why the intermission's `activePlayers.clear()` cannot take
     * this with it — this is not the roster, and the board is read *after* the roster is gone.
     *
     * **Only a player in the round can be counted into it.** The thrower is resolved from the
     * token its ball carries, and a rig's token is a GUID, which names nobody; the victim has to be
     * a player the round knows. So a rig is on neither side of an entry, and the board is a list of
     * people by construction rather than by a filter applied when it is drawn. See `registerHit`.
     */
    private readonly roundHits = new Map<Player, number>();

    /**
     * How many times each player was **eliminated during the round that is running**.
     *
     * **The other half of the board, and a table of its own rather than a pair per player.** A hit
     * and an out are counted in two different places — a hit where a throw lands on somebody, an out
     * where the round decides a death takes a player out of it — and one map of two-field records
     * would have both places reaching into a value to increment half of it.
     *
     * **It keeps `roundHits`' lifetime exactly, and by the same means**: both are cleared where
     * `scores` is cleared, so both are readable for the whole intermission that follows the round and
     * neither survives into the next one. Nothing here needs a snapshot at the end of the round for
     * that reason — see the clearing at the round's opening.
     *
     * **Dodge and Seek never puts anything in it.** Every death in that mode converts instead of
     * eliminating, so `eliminate` is never reached and the board shows nought outs for a whole round
     * — which is the mode's answer rather than a gap in the counting. See `DodgeAndSeekMode.onDeath`.
     */
    private readonly roundOuts = new Map<Player, number>();

    /**
     * Whether the round in progress has been decided.
     *
     * **The guard that lets a round be ended from two places.** A round can finish on a tick of the
     * countdown, or from `PlayerRemoving` when somebody leaves and empties a side; both go through
     * {@link finishRound}, and this is what makes the first of them the only one that counts. Reset
     * where a round opens, so a finished round cannot make the next one unplayable.
     */
    private finished = false;

    /**
     * The mode a match is waiting to open on.
     *
     * **The request and the flag are one field on purpose.** "Has a match been asked for" and "which mode
     * was it asked for" are the same question here: the intermission waits on this being set, and the round
     * boundary consumes it. A separate `pending: boolean` beside it would be a second answer that could
     * disagree with the mode sitting next to it.
     *
     * **Two things set it, through the one method that does.** The intermission's settle window sets it for
     * a roster that has stopped changing — see `MATCH_SETTLE_SECONDS` — which is how a match normally
     * begins, and a dev's `!dev match` sets it as the manual override. Both go through {@link startMatch},
     * so there is exactly one place the field is written and exactly one line saying a match is coming.
     *
     * **Read once at the round boundary and cleared there**, which is what makes one request start exactly
     * one round — a request that outlived its match would start the next one too, and `Round started` would
     * appear twice with no request between them.
     */
    private pendingMatch?: GameMode;

    /**
     * Whether the lobby's spawns have been reported yet.
     *
     * **Once a session rather than once an intermission**, because what the line says is a property of
     * the place file rather than of the round: which folder the lobby is, and how many places there are
     * in it. A line a minute about a constant is noise, and the question it answers — "did the round
     * find the new layout at all" — is asked once, when somebody has just changed the layout. See
     * {@link lobbySpawn}.
     */
    private lobbyLogged = false;

    /**
     * Who is on which team this round.
     *
     * A table *beside* the attribute rather than instead of it, and both written in the one
     * place, `assignTeams`. The attribute is what other systems read — a HUD, a per-team
     * spawn — and this is what the countdown reads once a second, without going through the
     * instance tree to ask the same question eighty times a round.
     */
    private readonly teams = new Map<Player, TeamLabel>();

    /**
     * The folder the HUD reads: the round's phase and clock, as attributes.
     *
     * A folder in `ReplicatedStorage` rather than anything sent, because attributes replicate
     * by themselves — the client gets the HUD's two facts without a remote, and without this
     * service having to know a HUD exists. Made in `onStart`; the client waits for it.
     */
    private statusFolder!: Folder;

    constructor(
        private readonly dev: DevService,
        private readonly balls: BallService,
        private readonly votes: VoteService,
        private readonly matches: MatchService,
        private readonly stats: StatsService,
        private readonly economy: EconomyService,
        private readonly abilities: SuperService,
        private readonly freezes: FreezeService,
        private readonly speeds: WalkSpeedService,
        private readonly respawns: RespawnService,
    ) {}

    onStart() {
        Players.PlayerAdded.Connect((player) => this.handlePlayerJoined(player));
        Players.PlayerRemoving.Connect((player) => {
            this.activePlayers.delete(player);
            this.teams.delete(player);

            // **A leaver can end the round, and does it here rather than a tick later.** Taking
            // somebody out of a side can empty it, and an empty side is a decided round in every
            // mode that counts heads — so the outcome is asked for the moment the roster changes
            // rather than on the loop's next tick. That difference is up to a second of a round
            // that is already over, with the clock still running and no winner written yet.
            //
            // **This is not "a player leaving ends the round".** `roundOutcome` is the *mode's*
            // answer, so the question asked here is the same one the loop asks, asked sooner: a
            // mode that does not end on an empty side — Score Rush, which ends on its target or the
            // clock, and Dodge and Seek, which ends on dodgers — answers `undefined` here exactly as
            // it does on a tick, and nothing happens.
            if (this.state === RoundState.Playing) {
                const outcome = this.roundOutcome();

                if (outcome !== undefined) this.finishRound(outcome);
            }
        });

        // **A watcher on the one part this file depends on and cannot account for.**
        //
        // The lobby spawn has gone missing between two intermissions inside one running session, and
        // nothing in this project can remove it — see `lobbySpawn` for what was checked, and
        // `waitForLobby` for what the consequence looks like from the player's seat. Inferring the
        // moment afterwards, from the gap between two intermissions, is guesswork; this catches it
        // instead. What it answers is *when*, and that is the half that names a suspect: the line
        // lands beside whichever `[Round]` or `[NPC]` line was doing something at that instant, so
        // whatever reconstructs this later has a timestamp instead of a theory.
        //
        // **The name test is what makes it a watcher rather than a log.** `DescendantRemoving` fires
        // for every removal anywhere in `Workspace` — every ball destroyed, every emitter cleaned up,
        // every rebuilt rig — and this compares one string and returns. The connection is permanent
        // and cheap, and it is scaffolding rather than a rule: worth deleting once the part is traced.
        Workspace.DescendantRemoving.Connect((descendant) => {
            if (descendant.Name !== ARENA_CONFIG.LOBBY_SPAWN_NAME) return;

            const parent = descendant.Parent;
            const tags = descendant.GetTags();

            // Where it was, and whether it was free to fall, for the case this turned out to be: an
            // unanchored part walks off the bottom of the world, and the *engine* destroys it at
            // `Workspace.FallenPartsDestroyHeight`. That removal has no Lua on the stack at all —
            // which is exactly what the traceback below showed, and the reason this line exists —
            // so position and `Anchored` are what tell it apart from a removal somebody made. Both
            // are still readable here: the instance exists until the handler returns.
            const where = descendant.IsA("BasePart")
                ? ` — last seen at y ${math.floor(descendant.Position.Y)}, Anchored ${descendant.Anchored}`
                : "";

            // The tags are named rather than counted because they were the leading suspect: this
            // project destroys exactly two things it did not create, both by tag — `RespawnBehavior`
            // takes the model it manages, and `BallSpawnerService` takes anything wearing the round's
            // ball tag. `carrying no tags` rules both out in the same line.
            print(
                `[Round] ${ARENA_CONFIG.LOBBY_SPAWN_NAME} (${descendant.ClassName}) was removed from ` +
                    `${parent !== undefined ? parent.GetFullName() : "a parent that was already detached"}` +
                    `${tags.size() > 0 ? `, carrying the tag(s) ${tags.join(", ")}` : ", carrying no tags"}` +
                    where,
            );

            // **The half that names a culprit rather than a moment.** A signal fires synchronously
            // from inside whatever removed the instance, so a removal made by this project's own code
            // leaves that code's frames on the stack — a `Destroy()` in `RespawnBehavior` or the
            // spawner's round cleanup both appear here by file and line. A stack that is nothing but
            // the signal dispatch is its own answer, and the interesting one: the remover is not
            // project code, and the place is where to look.
            //
            // **The list of suspects got shorter with the permanent arena**, which is worth knowing
            // before reading a traceback: `MapService.unloadCurrent` was the third name here — it
            // destroyed the arena once a round, and would have taken the lobby with it had the lobby
            // ever been authored inside one — and nothing tears anything down per round any more. What
            // is left is this project's two tag-driven destroys, neither of which can reach a part that
            // is not wearing its tag.
            print(`[Round] ${ARENA_CONFIG.LOBBY_SPAWN_NAME} removal traceback:\n${debug.traceback()}`);
        });

        // Handle players already in game (Studio playtest)
        for (const player of Players.GetPlayers()) {
            this.handlePlayerJoined(player);
        }

        // The HUD's channel, opened before the loop starts so the client has something to find:
        // the phase, and a clock at zero because no phase is running yet. Made by `roundStatus.ts`
        // rather than in here, because `VoteService` writes on the same folder and both services
        // have to open it from their own `onStart` without either waiting for the other.
        this.statusFolder = roundStatusFolder();
        this.statusFolder.SetAttribute(ROUND_STATE_ATTRIBUTE, "Intermission");
        this.statusFolder.SetAttribute(ROUND_TIME_ATTRIBUTE, 0);
        // Seeded empty rather than left unset: the first intermission follows no round at all, and
        // a reader should be told "nobody has won" rather than handed the absence of an answer.
        this.statusFolder.SetAttribute(ROUND_WINNER_ATTRIBUTE, "");

        // **The dev command that starts a match, registered where both halves of it are visible.** The
        // handler lives here rather than in `DevService` because the two things it needs — the round's own
        // state and the roster — belong to this service and to `MatchService`, and asking `DevService` to
        // hold both would make its dependency on this file a cycle. See `DevService.onCommand`.
        this.dev.onCommand("match", (player) => this.requestMatch(player));

        task.spawn(() => this.gameLoop());
    }

    // ---- Public API (for HUD later) ----
    public getState(): RoundState {
        return this.state;
    }

    public getTimeRemaining(): number {
        return this.timeRemaining;
    }

    /**
     * Asks for a match to open on `mode`, at the next round boundary.
     *
     * **The only thing that sets {@link pendingMatch}, and it has two callers.** The intermission's settle
     * window is the normal one — it asks for a roster that has stopped changing, see
     * `MATCH_SETTLE_SECONDS` — and {@link requestMatch} is the manual override behind a dev's `!dev match`.
     * Both arrive here because the boundary below wants the same
     * thing from either of them: one mode, consumed once, and a `Round started` with a line above it saying
     * which of the two it was.
     *
     * **It checks nothing, and the callers are why.** Whether a match is already running and whether there
     * are players to put in one have two different answers to print, and {@link requestMatch} is the place
     * that prints them; the settle window asks its own question before calling, and only ever fires on a
     * roster `canStart` has already accepted. Each caller checks in the way its own situation calls for, and
     * this method stays the single place the request is made — so the two can never disagree about what
     * "asked for" means.
     */
    public startMatch(mode: GameMode): void {
        this.pendingMatch = mode;

        print(`[Round] match requested — ${GAME_MODE_NAMES[mode.id]}`);
    }

    /**
     * `!dev match`: the two questions a request has to get past, then the request.
     *
     * **Both refusals name which condition failed**, because they are different faults with different
     * fixes: a request during a match is somebody who should wait, and a request with an empty roster is
     * somebody who has to recruit. One message saying "cannot start" would leave the dev to work out which
     * of the two they are looking at.
     *
     * **This is where the state check lives**, rather than in `startMatch` — see that method's note. The
     * phase is read from `state` rather than from the published attribute, because this side of the wire
     * is the one that owns it.
     */
    private requestMatch(player: Player): void {
        if (this.state !== RoundState.Intermission) {
            print(`[Round] ${player.Name} asked for a match — one is already being played`);

            return;
        }

        if (!this.matches.canStart()) {
            const counts = this.matches.countsFor();

            print(
                `[Round] ${player.Name} asked for a match — refused, needs ${MATCH_MIN_PLAYERS} player(s) with` +
                    ` one a side, and the roster is A ${counts.a}, B ${counts.b}`,
            );

            return;
        }

        this.startMatch(SCORE_RUSH);
    }

    // ---- Internals ----

    // ---- The round, as a mode is allowed to see it (`RoundView`) ----

    /**
     * Everyone still in the round.
     *
     * The one place that knows who is playing is `activePlayers`, and a mode reads it through
     * this rather than being handed the set itself — a mode able to `delete` from it would be a
     * mode able to eliminate somebody, and that is a decision for the round.
     *
     * Built fresh on each read rather than kept in step beside the set: the only reader is the
     * outcome check, once a second, and a second collection maintained in parallel would be a
     * second answer to the same question.
     *
     * A method and not a getter because **roblox-ts does not support getters** — see `RoundView`.
     */
    public playersInRound(): ReadonlyArray<Player> {
        const players: Player[] = [];

        for (const player of this.activePlayers) {
            players.push(player);
        }

        return players;
    }

    /** Which side a player is on, or nothing if they are not in this round. */
    public teamOf(player: Player): TeamLabel | undefined {
        return this.teams.get(player);
    }

    /**
     * Puts the match's players on the sides they chose.
     *
     * **Assigned at the start of every match, from the opt-in roster.** A player in the lobby who has not
     * asked to play is not on a side, and nobody carries a side from the last match into this one — which
     * is both fairer and the reason this clears the table rather than topping it up.
     *
     * **The mode is no longer asked, and that is the change matchmaking made here.** This used to hand
     * `Players.GetPlayers()` to `GameMode.assign` and let `splitEvenly` do the even shuffle; the sides are
     * decided by the players themselves now, by walking into the join part for the side they want, and
     * `MatchService` does no balancing at all — the counts on the two signs are whatever the players asked
     * for. A mode that re-split the roster would throw that away — two friends who picked the same side
     * would be put on opposite ones — so `GameMode.assign` is unused on this path. See
     * `MatchService.optIn` for the rule that replaced it.
     *
     * What is still the round's rather than anybody else's is the two things below: the table the round
     * counts from, and the attribute that publishes a side to everything outside this service. The roster
     * says who is playing and which side they are on; the round is what makes that true.
     */
    private assignTeams(): void {
        this.teams.clear();

        const assigned = this.matches.roster();

        for (const [player, team] of assigned) {
            this.teams.set(player, team);
            player.SetAttribute(TEAM_ATTRIBUTE, team);
        }

        // **And the crown is recomputed, because this is the one moment who-is-on-whose-side changes for
        // everybody at once.** The crown compares players against their own side, so a roster arriving
        // changes every comparison in the game — and it covers the case that matters most: a round opening
        // gives everybody a side and no hits, which is what takes last round's crowns off. See
        // `SuperService.refreshCrowns`.
        this.abilities.refreshCrowns();
    }

    /**
     * Who has won, if anybody has, or `undefined` if the round is still on.
     *
     * **Asked in two parts, and the roster goes first.** Before the mode is consulted at all, the
     * *server roster* is counted: if one side has nobody left connected, the other side has won, and
     * that is the answer whatever the mode was about to say. A side that has left the game is not a
     * round state a mode has an opinion about — it is the end of there being anybody to play
     * against — so it outranks a score, a clock, or a count of who is still standing.
     *
     * `rosterOutcome` lives here rather than in each `GameMode.outcome` because it is not about a
     * mode at all: it is about the server. One place to get it right when a fourth mode is written,
     * instead of four.
     *
     * **Everything below the roster check is the mode's; the question is the round's.** All the
     * second half does is hand the mode the round to look at — see `RoundView` — and pass the answer
     * back, which is what keeps "how do you win" in one file per mode rather than in a pile of
     * branches growing here. Team Elimination's answer is last-side-standing, Score Rush's is the
     * target score or the clock, and Dodge and Seek's is whether any dodger is still un-hit.
     */
    private roundOutcome(): RoundOutcome | undefined {
        return this.rosterOutcome() ?? this.mode.outcome(this);
    }

    /**
     * Who has won, judged only by who is still **connected to the server**.
     *
     * **Counted from `Players`, not from `activePlayers`, and that distinction is the entire point.**
     * A mode counts who is still *in the round*: somebody eliminated in Team Elimination is out of the
     * round while being very much still in the game, and somebody who died in Score Rush is out of it
     * for a moment and then back. Neither of those should end anything, and neither does — they are
     * still in `Players`, so they still count for their side here.
     *
     * A player who has **left** is a different fact, and one only the server knows. They are gone from
     * `teams` the moment `PlayerRemoving` fires, so this counts them out on that same tick — which is
     * what makes a departure end a round immediately rather than at the next countdown tick, and what
     * makes it end even while a dev has rounds frozen. Leaving is not pausable.
     *
     * **Both sides empty is a draw.** The case where everybody left: it is the honest answer, and it
     * is also what stops an empty server sitting inside a round for ever — the same reason every mode
     * answers that case the same way.
     *
     * **A mid-round joiner counts for neither side.** Team assignment happens at the opening whistle,
     * so they are not in `teams` at all and are watching rather than playing — deliberate, and the
     * reason `handlePlayerJoined` marks them a spectator. One consequence worth knowing: a spectator
     * arriving cannot rescue a side that has just emptied, because they are not on a side.
     */
    private rosterOutcome(): RoundOutcome | undefined {
        let connectedA = 0;
        let connectedB = 0;

        for (const player of Players.GetPlayers()) {
            const team = this.teams.get(player);

            if (team === TEAM_A) connectedA++;
            else if (team === TEAM_B) connectedB++;
        }

        if (connectedA === 0 && connectedB === 0) return DRAW;
        if (connectedA === 0) return TEAM_B;
        if (connectedB === 0) return TEAM_A;

        return undefined;
    }

    /**
     * Records that the round is over. **Idempotent, and that is load-bearing.**
     *
     * A round can be decided from two places — the tick that notices a side has emptied, and a
     * `PlayerRemoving` that empties one — and both can reach here for the same round. The first call
     * wins and every later one is a no-op, so the winner cannot be written twice and a re-derivation
     * cannot overwrite the decision that was actually made first. Without that, a leaver ending a
     * round would have the loop write the same answer again a moment later, and a round ended by a
     * leaver on the clock's last second could be overwritten by the time-based result.
     *
     * Everything the end of a round writes lives here rather than at either call site, which is the
     * whole reason it is a method: two places that each recorded a winner would be two places to
     * keep the attribute name, the print and the score line in step.
     */
    private finishRound(outcome: RoundOutcome): void {
        if (this.finished) return;
        this.finished = true;

        // Built before it is printed: a nested template inside an interpolated string is one more
        // thing for a reader to unpick, and the message is the part worth reading. The side's *name*
        // comes from the shared table rather than from a hard-coded "Team", because a mode is
        // allowed to call its two sides something else — see `MODE_SIDE_NAMES`.
        const result = outcome === DRAW ? "a draw" : `${sideNameOf(this.mode.id, outcome)} won`;

        // The score, for a mode that keeps one. Printed here rather than at every point that
        // changes it: a line per hit would bury the round's own output, and the number only means
        // anything next to who won.
        if (this.mode.scores) {
            const pointsA = this.scores.get(TEAM_A) ?? 0;
            const pointsB = this.scores.get(TEAM_B) ?? 0;

            print(`[Round] score — A ${pointsA}, B ${pointsB}`);
        }

        // The same word the message uses, and the vocabulary the HUD expects: a team's label, or
        // `"draw"`. Written before the round is left, because the intermission that follows is where
        // it is read.
        //
        // **Still published now that the top bar no longer reads it.** This is the round's vocabulary
        // rather than one HUD's — anything that ever wants to ask "who won" between rounds asks here
        // — and the panel that replaced that segment is told by a message instead, for the reasons
        // `events.roundResult` sets out.
        this.statusFolder.SetAttribute(ROUND_WINNER_ATTRIBUTE, outcome);

        this.sendResult(outcome);

        // **The economy is told after the board is out**, so a payout cannot be observed before the
        // result it is paying for. Everything the round knows — the winner, the rosters, each player's
        // hits — is passed here, and the service does the earning, the counters and the milestone
        // checks in one call. See `EconomyService.onRoundEnded`.
        this.economy.onRoundEnded(outcome, this.teams, this.roundHits);

        print(`[Round] ${result}`);
    }

    /**
     * Hands the finished round's board to the clients that watched it.
     *
     * **Sent from here because here is where the result is decided, once.** `finishRound` is
     * idempotent and is reached by two paths — the tick that notices a side has emptied, and a
     * `PlayerRemoving` that empties one — so a send at either of those call sites would be two sends
     * for one round. This line is inside the guard, which is what makes it one.
     *
     * **A draw sends nothing, and that is the panel's empty state.** A board belongs to a side, and a
     * round nobody won has no side to list — so the absence of a message *is* "no panel", rather
     * than a message carrying an empty list that every reader would have to interpret the same way.
     * It also keeps a word off the wire: `"draw"` is the round's own vocabulary, between this file
     * and the HUD that no longer needs it, and the client never has to know it.
     *
     * **Built from `Players.GetPlayers()` rather than from `teams`.** A player who left during the
     * round is still in `teams`, as a reference to somebody who is not here — and a board is a thing
     * to print names from, so it is built from the players who are actually here to be named. A
     * leaver is simply absent, which under the roster rule is most often the losing side anyway.
     *
     * **Ordered here rather than on the client.** The ranking is a fact about the round, and the
     * counter it reads lives on this machine: sending the rows in order is what keeps "sorted by
     * hits" from being decided once per client, each in its own way. Ties break on name, so two
     * players on the same count cannot change places between two draws of the same board.
     */
    private sendResult(outcome: RoundOutcome): void {
        if (outcome === DRAW) return;

        const rows: RoundResultRow[] = [];

        for (const player of Players.GetPlayers()) {
            if (this.teams.get(player) !== outcome) continue;

            // Four facts: what the row prints, and what it draws. The id is the one that is not
            // printed — a thumbnail is looked up by user id, and the row that needs one may name
            // somebody who has since left this server. See `RoundResultRow`.
            rows.push({
                userId: player.UserId,
                name: player.Name,
                hits: this.roundHits.get(player) ?? 0,
                outs: this.roundOuts.get(player) ?? 0,
            });
        }

        // **A `boolean` comparator, and not the number one JavaScript habits reach for.**
        // roblox-ts's `Array.sort` is an alias for Lua's `table.sort`, which is told whether the
        // first argument comes first rather than how the two compare — a `b.hits - a.hits` here
        // would be a number where a truth value was wanted, and would not compile.
        rows.sort((a, b) => (a.hits === b.hits ? a.name < b.name : a.hits > b.hits));

        events.Server.Get("roundResult").SendToAllPlayers(this.mode.id, outcome, rows);
    }

    /**
     * Whether a dev has switched rounds off.
     *
     * Asked once per tick and never cached across one: the countdown moves at a second a
     * tick, so a cache inside a frame would be a cache that never gets a second use. The flag
     * is the state — it lives on the player as an attribute — so there is nothing here to keep
     * in step with it, and `!dev r on` takes effect on the next tick rather than at the next
     * phase.
     */
    private isRoundsPaused(): boolean {
        for (const player of Players.GetPlayers()) {
            if (this.dev.isDev(player) && this.dev.getFlag(player, "RoundsDisabled")) return true;
        }

        return false;
    }

    /**
     * Whether there are too few players for a round to be worth starting.
     *
     * **Asked of `Players`, and not of `activePlayers` — that is not a style choice.**
     * `activePlayers` is who is *in the round*, and it is empty for the whole of an intermission:
     * it is cleared as the intermission opens and filled again when the round does. A check against
     * it would read zero every single time and freeze the intermission for ever, which is the trap
     * this comment exists to stop anybody walking back into.
     *
     * **Only the start of a round is gated by this.** A round that drops below the minimum mid-play
     * runs to its finish — a result that changed because somebody's connection did is not a result,
     * and the round already has its own rules for a side that empties out.
     */
    private belowMinimum(): boolean {
        return Players.GetPlayers().size() < ARENA_CONFIG.MIN_PLAYERS;
    }

    /**
     * Waits, a second at a time, until rounds are switched back on.
     *
     * The boundary between two phases is a pause point like any other tick: a phase that has
     * just finished should not hand over to the next one while the harness is off, or pausing
     * at the wrong moment would advance the round anyway.
     */
    private async waitWhilePaused() {
        while (this.isRoundsPaused()) {
            task.wait(1);
        }
    }

    /**
     * Runs one round transition: cover the screens, move everybody behind the cover, hold them where they
     * land if the boundary asks for it, and open the screens again.
     *
     * **The move is inside the cover, and that is the whole of what this file owes the animation.** An
     * earlier version of this held the clock for the wipe's length and called it a transition, which it was
     * not: the bodies were already in their new places by the time the grid closed, so the player saw the cut
     * and *then* a curtain drawn over the aftermath. Doing it the other way round is only possible on this
     * side of the wire, because the move is the server's and so is the timing.
     *
     * **And the hold begins at the move rather than after the cover**, which is the second correction this
     * went through. The first version applied the arena freeze once the transition had finished, so a round
     * opened with everybody arriving, walking about under the grid, and *then* being frozen wherever they had
     * wandered to — the freeze was a separate beat after the arrival instead of the thing that holds the
     * arrival still. It is applied on the line after `moveEveryone` now, for the same reason the move is
     * inside the cover: the hold has to be measured from the landing to mean anything.
     *
     * **Four steps, in this order, and each one is load-bearing.**
     *
     * 1. Bump {@link ROUND_TRANSITION_ATTRIBUTE}, which is the clients' cue to close their grids. A counter
     *    rather than the phase, because the phase is published early by design — see that constant — and a
     *    wipe keyed on it would have finished and gone before this ran.
     * 2. Wait `TRANSITION_COVER_SECONDS`: the clients' own closing time plus a step of latency, so that the
     *    move below lands on covered screens rather than on half-covered ones.
     * 3. `moveEveryone()` — the teleport, hidden — and {@link holdArenaEntry} on the very next line.
     * 4. Wait, and {@link releaseArenaEntry}, which is the last thing this does.
     *
     * **The hold and the cover each run their own clock, which is the correction this went through last.**
     * They shared one wait — the longer of the two — and that made the freeze depend on the transition in a
     * way that was easy to miss: a transition whose opening outlasted the hold held the players for the
     * *transition's* length, so slowing the cover down silently lengthened the freeze with it, and the freeze
     * could never be shortened below it either. The freeze is a rule about the round and the cover is a piece
     * of presentation, and neither should be able to change the other's numbers. So the hold is now waited in
     * full and released on the tick it ends, whatever the cover is doing, and only then is whatever is *left*
     * of the cover waited out.
     *
     * **The clock still waits for both**, because a clock running behind a cover is the one thing this whole
     * arrangement exists to prevent — so the round's first second is the later of the two ends. When the hold
     * is the longer of them, which is the arrangement these numbers are meant to be in, the later of the two
     * *is* the release, and the release is the last statement before the caller's clock goes. When the cover is
     * the longer, the tail of it hides players who are free to move: that is the price of the separation, and
     * `ARENA_FREEZE_SECONDS` says what to do about it.
     *
     * **The clock is what this buys.** The phase's clock is published with the phase and does not move until
     * this returns, so a round neither spends its opening seconds behind a cover nor starts counting before
     * its players are standing in the arena and able to move, and an intermission does not count down the
     * time the result is being hidden behind a grid.
     *
     * **Called from inside the loop and awaited**, like `waitWhilePaused`, so the phase is really held rather
     * than merely late in reporting. `await` rather than a bare `task.wait` because this is called from
     * `gameLoop`, which is `async` — see that function's note on why a throw from in there ends the session.
     *
     * **Not gated on the pause.** A paused or below-minimum round still teleported everybody, so the cover is
     * still the truth; what the pause holds is the *counting*, and this runs before anything counts.
     *
     * **`options` rather than more arguments**, because both of them are read at the call site as often as
     * they are written and one of them was a bare `true`: see {@link TransitionOptions}. With `wipe` off there
     * is no cover to move behind, so the move happens at once — but a hold still runs, because the freeze is a
     * rule about the round rather than part of the cover.
     */
    private async transitionAround(moveEveryone: () => void, options: TransitionOptions = {}): Promise<void> {
        const holdFor = options.holdEveryoneFor ?? 0;
        const wiping = TRANSITION_CONFIG.ENABLED && (options.wipe ?? true);

        if (wiping) {
            const current = this.statusFolder.GetAttribute(ROUND_TRANSITION_ATTRIBUTE);
            this.statusFolder.SetAttribute(
                ROUND_TRANSITION_ATTRIBUTE,
                (typeIs(current, "number") ? current : 0) + 1,
            );

            print(
                `[Round] transition — cover in ${TRANSITION_COVER_SECONDS}s, then the move, ` +
                    `then ${TRANSITION_OPEN_SECONDS}s to open`,
            );

            task.wait(TRANSITION_COVER_SECONDS);
        }

        moveEveryone();

        // **The hold, on the line after the move, which is the whole of what it is for.** Everything held is
        // held from the instant it landed.
        if (holdFor > 0) this.holdArenaEntry();

        // **The hold's own length, waited in full and released on the tick it ends** — not shared with the
        // cover's wait, so that changing the transition cannot change how long the freeze lasts. See this
        // method's doc for what that costs and why it is the right way round.
        //
        // The figure is accumulated from what `task.wait` returned rather than read from a clock, which is the
        // shape `LoadingScreenController` uses and for its reason: the number in the release line is what
        // actually happened, so a frame that ran long is visible in the log rather than rounded away. The loop
        // is for the residual — one `task.wait` on a healthy server returns the whole duration.
        let frozen = 0;
        while (frozen < holdFor) frozen += task.wait(holdFor - frozen);

        if (holdFor > 0) this.releaseArenaEntry(frozen);

        // **And then whatever is left of the cover**, measured against the hold that has already run rather
        // than against the move: when the hold is the longer of the two this is negative and nothing happens,
        // which is the ordinary case, and the line above is the last thing before the clock.
        const coverLeft = (wiping ? TRANSITION_OPEN_SECONDS : 0) - frozen;
        if (coverLeft > 0) task.wait(coverLeft);
    }

    /**
     * Holds every player still, from the instant the transition landed them there.
     *
     * **The arena-entry freeze: the round's opening beat.** A round begins by moving everybody from the lobby
     * to a spawn, and until this existed the first thing a round asked of a player was to read a new place and
     * act on it in the same second they arrived. Now they are held where they land, so the round's opening
     * seconds are for looking around rather than for already being somewhere.
     *
     * **The gate is `WalkSpeedService`, which is the whole of the mechanism.** That service is already the one
     * authority for how fast a character may walk, and it is the *server's* — so this is a hold rather than a
     * request, there is no client-side state to lie about, and a client that wrote its own `WalkSpeed` is
     * overwritten by the next recalculation. Nothing new was invented for it: a key in the existing sum, added
     * here and removed by {@link releaseArenaEntry}. The contributions are *summed*, so the hold is a deep
     * negative rather than a zero — see {@link ARENA_FREEZE_SPEED}.
     *
     * **A walk-speed hold and not the ability's freeze**, which is the nearest thing to it and the wrong
     * thing: that one anchors the root, disables jumping and draws a block of ice, because it is a *state a
     * player is put into*. This is "not walking", and the body is otherwise untouched. **Jumping is
     * deliberately not blocked with it** — a body standing on its spawn has no horizontal momentum for a jump
     * to carry, so a player who jumps on the spot is no closer to anybody. See `FreezeService` if that stops
     * being true.
     *
     * **Keyed to the *body*, which leaves one hole worth naming.** Every player in the round is held, and a
     * body that replaces one during the hold — a death, which in the opening seconds would take a thrown
     * ball — arrives wearing its own fresh base speed and can walk. Left as it is: closing it means
     * re-applying the key from `CharacterAdded` for the length of the window, which is machinery for a case
     * that needs the round to have already been played at.
     */
    private holdArenaEntry(): void {
        // **The match's players, for the reason the teleport above is theirs.** Everybody present used to be
        // held, which was the same set as the round's players until opting in existed — and now it is not, so
        // holding a lobby spectator still for five seconds while they walk about would be this change leaking
        // into a system that has nothing to do with it. The hold is a rule about *arriving* in the arena, and
        // only the players who arrived are held.
        const frozen = this.playersInRound();

        for (const player of frozen) {
            const character = player.Character;
            if (character) this.speeds.addModifier(character, ARENA_FREEZE_KEY, ARENA_FREEZE_SPEED);
        }

        print(
            `[Round] arena freeze — ${frozen.size()} player(s) held from the landing, ` +
                `${ARENA_CONFIG.ARENA_FREEZE_SECONDS}s`,
        );
    }

    /**
     * Lifts the hold {@link holdArenaEntry} put on, and reports what it lasted.
     *
     * **Every player, rather than the list that was held**, and that is safe because `removeModifier` is a
     * documented no-op for a key a model never had: anybody who arrived during the hold has no such
     * contribution and is left exactly as they are — which is also the right treatment of them, since a player
     * who joins mid-round is watching it rather than in it, and lands in the lobby.
     *
     * **The elapsed figure is passed in rather than measured here**, because what is worth reporting is the
     * length of the hold, which began at the move — not the length of this call, which is the same tick.
     *
     * **Called on the last line of `transitionAround`**, so the caller's next statement — the line that starts
     * the round's clock — runs on the same tick as the release rather than a frame or a timer later. That is
     * the "aligned by construction" half of the freeze: the hold and the clock are not two durations that were
     * made to agree, they are one moment written in two places, one line apart.
     */
    private releaseArenaEntry(held: number): void {
        for (const player of Players.GetPlayers()) {
            const character = player.Character;
            if (character) this.speeds.removeModifier(character, ARENA_FREEZE_KEY);
        }

        print(
            `[Round] arena freeze lifted — held ${string.format("%.2f", held)}s, ` +
                `${Players.GetPlayers().size()} player(s)`,
        );
    }

    private handlePlayerJoined(player: Player) {
        player.CharacterAdded.Connect((character) => {
            const humanoid = character.WaitForChild("Humanoid") as Humanoid;
            humanoid.Died.Connect(() => this.handleDeath(player));

            const root = character.WaitForChild("HumanoidRootPart") as BasePart;

            // Route based on whether they're still in the round, and — for a round — on which
            // side they are on. A player who died is out of `activePlayers` by the time this
            // runs, so they land in the lobby like any other spectator, which is the existing
            // behaviour and not a team's side.
            const inRound = this.state === RoundState.Playing && this.activePlayers.has(player);

            // **A missing lobby is not reported here, deliberately.** The intermission loop owns that
            // fault and says so once — see {@link waitForLobby} — and repeating the same sentence on
            // every join would be two lines in one log saying one thing. This path has an honest
            // fallback anyway: the character keeps the spawn the engine gave it rather than being
            // thrown by a lookup.
            if (inRound) {
                character.PivotTo(this.arenaSpawnFor(player));
            } else {
                const lobby = this.lobbySpawn();
                if (lobby !== undefined) character.PivotTo(lobby);
            }
        });

        // **A player arriving during a round is watching it, not in it.** They are not in
        // `activePlayers` and the round does not wait for them, so the HUD is told what the round
        // already believes. A joiner during an intermission gets nothing: they will be in the next
        // round's teams, and until then there is no round to be out of.
        if (this.state === RoundState.Playing && !this.activePlayers.has(player)) {
            player.SetAttribute(SPECTATING_ATTRIBUTE, true);
        }

        // **And the crown is recomputed for a joiner, which is mostly about everybody else.** A player
        // arriving has no count and no side, so they cannot be crowned by this call — what it is really
        // for is the roster they have just joined, and the case it matters for is the one that never
        // reaches this method: a player *leaving*, which `SuperService` handles on its own.
        this.abilities.refreshCrowns();
    }

    /**
     * A character died. What that means is the mode's to say.
     *
     * The three cases below are ordered by what the round already knows, and only the last one is
     * a question: outside a round there is nothing to decide, somebody already out is still out,
     * and everyone else is a decision the mode makes.
     *
     * **Nothing here asks how they died.** A death is reported as a death, because no mode tells a
     * hit apart from a reset — see `DeathEvent` for why that distinction was removed rather than
     * merely left unused.
     */
    private handleDeath(player: Player): void {
        // **What question this answers:** whether the death reached the round at all, and if it did,
        // which of the two early returns below it is about to take. Both are invisible from outside:
        // a death during an intermission writes nothing, and a death for somebody already out writes
        // nothing, and the two are the same absence of output. Printed with `active` as well as the
        // state because those are the two conditions guarding those two returns, so one line
        // separates "never got here" from "got here and stopped" — and which stop it was.
        if (DEBUG_CONFIG.VERBOSE_LOGS) {
            print(
                `[Round] ${player.Name} died — state ${RoundState[this.state]}, ` +
                    `in the round ${this.activePlayers.has(player)}`,
            );
        }

        // **And the MultiBall window closes with them, above the guards rather than beside the streak
        // below.** The streak is a fact about a *round*, which is why `noteDeath` sits under both returns
        // next to the mode's own decision — but a window is a clock on a *player*, and it does not care
        // whether a round was being played when the body died. A dev who presses `4` in the lobby and then
        // resets is the case that makes the difference visible: their window is as finished as anybody's,
        // and leaving it running would carry a super through the respawn.
        this.abilities.clearMultiBall(player);

        // **And the freeze comes off the body before anything respawns it.** The watcher in
        // `FreezeService` fires on the same `Died` signal as this handler, and this one is connected
        // first — at `CharacterAdded`, before any ball could have frozen the body. So the watcher's
        // release runs *after* the mode has decided, and whether the anchor is still clearable at that
        // point depends on the engine's own ordering: `unfreeze` skips its teardown when the model has no
        // parent left. That is harmless for a body that is going away, and it is exactly the kind of
        // latent ordering a respawn bug hides in, so the clear happens here instead — while the body is
        // unambiguously still there, rather than at some unspecified point after it has begun to go.
        //
        // **An in-round respawn no longer happens on the spot, and the race is still live.** The branch at
        // the bottom of this method now schedules its load a few seconds out rather than replacing the body
        // immediately — but the two guards above load *now*, so a death in the lobby is still a body being
        // replaced at the moment the watcher's own release is queued. The clear stays here for that case, and
        // for the rigs and dev resets that never reach this method at all.
        //
        // The watcher stays, and is not a duplicate of this: it is what clears a freeze on a body no
        // round ever hears about — a rig, which never reaches this method at all, and any death outside
        // a playing round, which returns at the guard below.
        const dying = player.Character;
        if (dying) this.freezes.unfreeze(dying);

        // A death in the lobby is not an elimination, so nothing is written outside a round — **but a body is
        // still owed, and it used to be the engine's.** With `CharacterAutoLoads` off (see `main.server.ts`)
        // nothing brings one back but this project, so the load happens before the return rather than not at
        // all. Instant, which is the rule for everything outside a round: there is no countdown to watch while
        // a match is not being played, and a player standing in the lobby has nothing at stake.
        if (this.state !== RoundState.Playing) {
            this.respawns.loadNow(player, "outside a round");

            return;
        }

        // Already out — a spectator who dies again is still a spectator. This is the case the
        // old code covered by clearing `activePlayers` unconditionally and then re-marking them.
        //
        // **And they get a body for the same reason as the guard above rather than despite being out.** An
        // eliminated player is a person in the lobby with a character to walk around in; the engine handed them
        // one on its own clock, and this is that load moved to the moment it is wanted.
        if (!this.activePlayers.has(player)) {
            player.SetAttribute(SPECTATING_ATTRIBUTE, true);

            this.respawns.loadNow(player, "outside a round");

            return;
        }

        // **A death breaks the run, and it sits here rather than in `eliminate` below.** Those are
        // different events: `eliminate` is reached only when the *mode* decides the player is out,
        // while a mode that converts its dead instead — Dodge and Seek — respawns them and eliminates
        // nobody. Both are deaths, and a run of hits that ended in one has ended either way, so the
        // notification goes above the mode's decision rather than inside one of its two answers.
        //
        // Below both guards rather than at the top of the method, so that "a death" means what this
        // method already means by it: somebody who was still in the round. A spectator dying again is
        // not a second death, and their run is already nought.
        this.abilities.noteDeath(player);

        const decision = this.mode.onDeath({ player }, this);

        if (decision.kind === "eliminate") {
            this.eliminate(player);
            return;
        }

        // Back in — on a new side if the mode asked for one, and then a body to go with it, **after the round's
        // own delay.** This is the one death in the game that does not hand the body straight back, and the wait
        // exists because the engine's own respawn had to be switched off for it to be possible at all: the
        // engine does not know a round is running, so it cannot be asked to wait three seconds. See
        // `RespawnService`, which owns the timer and is the only thing that calls the load.
        //
        // **Scheduled rather than awaited, so nothing on this stack is held.** `handleDeath` runs inside
        // `Humanoid.Died`, and a `task.wait` here would sit in that signal's handler for the length of the
        // delay; the service's timer does the same job with this code back on its way immediately.
        //
        // The load that ends the wait fires the `CharacterAdded` handler above. Because they were never taken
        // out of `activePlayers`, that handler puts them back on their own side's spawn rather than in the
        // lobby — so *where* they come back needs no code here, and the answer cannot drift from the one the
        // round's opening teleport uses.
        if (decision.team !== undefined) this.setTeam(player, decision.team);

        this.respawns.schedule(player, ARENA_CONFIG.RESPAWN_DELAY_SECONDS);
    }

    /**
     * Out of the round, watching the rest of it.
     *
     * **The record is written here because this is what "eliminated" means to the round.** Both of
     * the guards that make a death an elimination sit in {@link handleDeath} — a round is being
     * played, and the player was still in it — so a death in the lobby, a spectator dying again, and
     * a mode that respawns instead of eliminating all pass this method by. Nothing here decides
     * anything; it reports a decision the mode has already made.
     *
     * **Two records are written, and they are one fact seen over two spans of time**: the player's
     * lifetime outs, which belong to `StatsService` and outlive the session they were earned in, and
     * this round's count for the result board, which is thrown away when the next round opens. This
     * is the only place either of them is written, which is why they are written together.
     */
    private eliminate(player: Player): void {
        this.activePlayers.delete(player);
        player.SetAttribute(SPECTATING_ATTRIBUTE, true);

        this.stats.recordOut(player);
        this.roundOuts.set(player, (this.roundOuts.get(player) ?? 0) + 1);

        // **And a body, immediately — which is why this death did not gain a delay.** Elimination means *out of
        // the round*, not *out of the game*: an eliminated player is a spectator in the lobby with a character
        // to watch from, which is what the engine used to provide on its own clock and what this load provides
        // at the moment it is wanted. Every path that is not the round's own respawn takes its body now.
        this.respawns.loadNow(player, "eliminated");
    }

    /** Put `player` on `team` — in the table the round counts from, and on the player. */
    private setTeam(player: Player, team: TeamLabel): void {
        this.teams.set(player, team);
        player.SetAttribute(TEAM_ATTRIBUTE, team);

        // **And the crown follows a side change, because the players this one is compared against are
        // different ones now.** This is the Dodge-and-Seek conversion's path: a body that changes sides
        // mid-round carries the count it has already earned into a new comparison. See
        // `SuperService.refreshCrowns`.
        this.abilities.refreshCrowns();
    }

    /**
     * Whether this throw landed on the thrower's own side.
     *
     * **The one rule that turns friendly fire off, and deliberately not a mode's.** Which side
     * anybody is on is not a rule about how a round is won — it is a fact the round holds — and
     * "may a throw hurt this body at all" is a question about the game rather than about a mode.
     * Every mode answers it the same way, so it is answered once, here, rather than three times in
     * three mode files with two of them free to drift.
     *
     * Called from `BallComponent` **before the damage**, which is the contract: the caller treats a
     * `true` as "this whole contact did not happen", so nothing may be done to the body first.
     *
     * **Only during a round.** `teams` is filled at the opening whistle and is not emptied when the
     * round ends, so between rounds it still holds the sides of the round that has just finished —
     * and reading it then would make a lobby throw pass through whoever happened to be a former
     * teammate. A side only means something while a round is being played, so that is the only time
     * this says yes.
     *
     * **A throw nobody can be credited with is not friendly fire.** A rig throws with a GUID token,
     * which names no player and therefore no side; and a victim who is not a player, or not in the
     * round, has no side either. In both cases there is no side to be friendly *with*, and the
     * honest answer is to let the hit happen rather than to invent a rule for it.
     */
    public isFriendlyFire(throwerToken: string, victim: Model): boolean {
        if (this.state !== RoundState.Playing) return false;

        const thrower = playerFromToken(throwerToken);
        if (thrower === undefined) return false;

        const shooterTeam = this.teams.get(thrower);
        if (shooterTeam === undefined) return false;

        const victimPlayer = Players.GetPlayerFromCharacter(victim);
        if (victimPlayer === undefined) return false;

        return this.teams.get(victimPlayer) === shooterTeam;
    }

    /**
     * A thrown ball has landed on somebody. **The one door `BallComponent` opens into the round.**
     *
     * A token rather than a thrower, because that is the whole of what an arriving ball knows
     * about who threw it — the same reason `StatsService.recordHit` takes one. Resolving it here
     * keeps the question "was this a person?" in one place instead of in the component that
     * detects the touch.
     *
     * **Only a cross-team hit ever arrives.** `BallComponent` refuses a same-side contact outright,
     * through `isFriendlyFire`, before it damages anything — so nothing below has to ask whose side
     * anybody is on, and a mode's `hitAward` is never asked what a hit on one's own side is worth.
     * A guard here for that case would be unreachable, which is why there is not one.
     *
     * **Recorded for scoring, for the board, and for stats — and no mode is asked about hit
     * cause.** The round is told about a hit so that a mode which keeps score can award the point,
     * so that the throw reaches `StatsService`, and so that the player who landed it goes up the
     * round's own count for the result panel — three readers of one event, which is why it all
     * happens in one method. Nothing anywhere asks whether a death was a throw or a reset, which is
     * why the round keeps no *cause*: a hit arrives as a hit or it does not arrive.
     */
    public registerHit(throwerToken: string, victim: Model): void {
        if (this.state !== RoundState.Playing) return;

        const victimPlayer = Players.GetPlayerFromCharacter(victim);
        if (victimPlayer === undefined || !this.activePlayers.has(victimPlayer)) return;

        // **Resolved once, here, above the scoring gate below.** Two things below need the thrower
        // and one of them is above the gate, so the lookup cannot live inside the scoring block: the
        // board is a fact about who landed a hit, not about what a hit is worth, and it is therefore
        // kept for every mode — including the scoreless ones, which have a result panel like anybody
        // else. Under the gate, Team Elimination's board would be empty for ever.
        const thrower = playerFromToken(throwerToken);

        if (thrower !== undefined) this.roundHits.set(thrower, (this.roundHits.get(thrower) ?? 0) + 1);

        // **A mode that keeps no score is not asked what a hit is worth.** See `GameMode.scores`:
        // a scoreless mode has no hit rule to state, so asking anyway would make every mode carry a
        // method whose only correct answer is "nothing" — and would call it on every landed hit of
        // every round for no reason. The hit itself is still recorded above, because *that* is not
        // a scoring question: a mode with no points may still need to know a throw landed.
        if (!this.mode.scores) return;

        const award = this.mode.hitAward({ thrower, victim: victimPlayer }, this);
        if (award === undefined || thrower === undefined) return;

        const scoring = this.teams.get(thrower);
        if (scoring === undefined) return;

        this.scores.set(scoring, (this.scores.get(scoring) ?? 0) + award);
        this.publishScores();
    }

    /**
     * Publishes both sides' points, so the client can draw a scoreboard.
     *
     * **One writer, called wherever `scores` moves**, and that is the whole reason this is a method rather than
     * a `SetAttribute` at each site: the map changes in three places — a hit award, a catch point, and the
     * clear at the opening of a round — and two attributes written in three places is six chances for one side
     * to be published without the other. A reader would then draw a scoreboard whose halves disagree, which is
     * worse than drawing none.
     *
     * **Both sides are written on every change, including changes that move only one.** Writing an unchanged
     * value is cheap and fires no changed-signal, so the redundant write costs nothing and buys the guarantee
     * that the pair is never observable half-updated.
     *
     * **It is not gated on the mode**, deliberately. The two scoring paths are already guarded by
     * `mode.scores`, so a scoreless mode never reaches them; the clear at a round's opening does reach here,
     * and writes `0` for a mode that keeps no score — which is the truthful answer rather than a missing one,
     * and it is what stops the previous round's numbers lingering into a mode that has none.
     */
    private publishScores(): void {
        this.statusFolder.SetAttribute(ROUND_SCORE_A_ATTRIBUTE, this.scores.get(TEAM_A) ?? 0);
        this.statusFolder.SetAttribute(ROUND_SCORE_B_ATTRIBUTE, this.scores.get(TEAM_B) ?? 0);
    }

    /**
     * The thrower of a caught ball is out, and — where the mode keeps score — the catcher's side
     * scores a point.
     *
     * **One door for the whole catch resolution, and it is the round's rather than the ball's.** The
     * ball's own resolution lives in `BallComponent` — it is the thing that knows a throw is over and
     * which bodies were tagged. But punishing a thrower is a question about *sides*, and sides are the
     * round's: who the thrower is, whether the catcher is their enemy, and whether a round is even
     * being played are all facts the round already holds, so the ball would have to be handed them one
     * at a time to do this itself.
     *
     * **Only an enemy catch arrives, by contract.** `BallComponent` refuses a friendly catch through
     * `isFriendlyFire` before it calls here, exactly as the hit path refuses a friendly hit — one
     * rule, applied in the ball, for "may this contact do anything". So there is deliberately no
     * same-side branch here; a guard for it would be unreachable, and `isFriendlyFire` is the method
     * that owns the rule.
     *
     * **The kill comes before the point, and only the point is gated on score.** Team Elimination has
     * no points, but the thrower's death *is* its reward — so the kill happens in every mode and the
     * award only where `mode.scores` is true. `registerHit` carries the same gate, for the same
     * reason, and the two read the same flag.
     *
     * **An NPC's throw, caught, punishes nobody and scores nothing.** `playerFromToken` answers
     * `undefined` for a GUID, which is the entire rule: a thrower with no player has no side, and a
     * point nobody can be credited with is not awarded — the same fall-out a rig's hit has in
     * `registerHit`.
     */
    public resolveCaughtThrower(throwerToken: string, catcher: Model): void {
        // No round, no sides, nothing to resolve: between rounds a catch is just a catch.
        if (this.state !== RoundState.Playing) return;

        if (this.isFriendlyFire(throwerToken, catcher)) return;

        const thrower = playerFromToken(throwerToken);
        if (thrower === undefined) return;

        // The death goes through `Died → handleDeath`, the same chain a landed hit takes: the mode
        // decides what the death means, and this file does not decide it here twice.
        const humanoid = thrower.Character?.FindFirstChildWhichIsA("Humanoid");
        if (humanoid && humanoid.Health > 0) humanoid.TakeDamage(CATCH_DEATH_DAMAGE);

        if (!this.mode.scores) return;

        const catcherPlayer = Players.GetPlayerFromCharacter(catcher);
        if (catcherPlayer === undefined) return;

        const team = this.teams.get(catcherPlayer);
        if (team === undefined) return;

        this.scores.set(team, (this.scores.get(team) ?? 0) + GAME_MODE_CONFIG.CATCH_POINTS);
        this.publishScores();
    }

    /**
     * One of the arena's lobby spawns, picked uniformly at random, or nothing if there is nowhere to put
     * anybody.
     *
     * **The lobby is a folder of parts inside the arena now, which is the shape a side's spawns already
     * had.** `LobbySpawns` is looked for with `findFolder` rather than pinned by name, only direct
     * `BasePart` children count, and the pick is `math.random` over however many there are — exactly
     * `getRandomTeamSpawn`, one level simpler because a lobby has no sides. It used to find a single part
     * called `LobbySpawn` anywhere in `Workspace`, which was one place to stand for a whole lobby.
     *
     * **What the old version taught is why the new one is shaped this way, and both lessons still
     * apply.** A lookup by name alone answers with the first instance *of that name whatever it is*, so
     * the type has to be part of the question rather than a check applied to an answer already chosen;
     * and a lookup that is too shallow finds nothing while the thing it wants sits a few studs away,
     * which is exactly what "the lobby is inside the arena" would have looked like to a walk of the
     * root. The folder search and the `IsA("BasePart")` test are those two rules, written once each.
     *
     * **`undefined` for every way this can fail, and saying which is somebody else's job.** No arena, no
     * folder, and a folder holding no parts all read the same here on purpose: this answers "where can I
     * put somebody" rather than "why not". {@link waitForLobby} is the one place that holds an
     * intermission while the answer is no, and {@link describeLobbyCandidates} is the one place that says
     * which of the three it was — so there is no second copy of that sentence to keep in step.
     *
     * **Nothing is cached and the draw is per call**, for the reason `getRandomTeamSpawn` gives: the parts
     * are one Studio edit away from being replaced, so a list held here would be the last intermission's,
     * and two players moved in the same frame should not land on each other.
     *
     * **And one line, once a session, when this first succeeds.** See {@link lobbyLogged}.
     */
    private lobbySpawn(): CFrame | undefined {
        const arena = findArena();
        if (arena === undefined) return undefined;

        const folder = lobbySpawnFolder(arena);
        if (folder === undefined) return undefined;

        const parts = basePartsIn(folder);
        if (parts.size() === 0) return undefined;

        if (!this.lobbyLogged) {
            this.lobbyLogged = true;

            print(`[Round] lobby spawns resolved — ${folder.GetFullName()}, ${parts.size()} candidates`);
        }

        // The same lift `getRandomTeamSpawn` uses, and for the same reason: a body pivoted onto the floor
        // it is standing on arrives half inside it, so every spawn is a place to stand rather than a place
        // to intersect.
        return parts[math.random(0, parts.size() - 1)].CFrame.add(new Vector3(0, 3, 0));
    }

    /**
     * What the world has to say about the lobby it cannot find, as one sentence.
     *
     * **The distinction this exists to draw is between "absent" and "present but unusable"**, because
     * those two read identically from the warning alone and have completely different fixes: one is a
     * folder to add, the other is parts to put in it. It is worth two extra lookups for that, and they
     * are only taken when {@link lobbySpawn} has already failed — once per hold, not per frame.
     *
     * **It walks the same path the search walks, in the same order**, so the sentence names the step
     * that is missing rather than the whole route: no arena, then no `LobbySpawns` inside it, then
     * nothing in that folder a player can stand on. The parts come from the same helper the search uses
     * for the same reason — "what counts as a spawn" is one rule, and a description that counted them
     * differently from the way they are picked would be a second one, disagreeing in the one case
     * somebody is reading the sentence to diagnose.
     *
     * The last branch is the case that should be impossible: the search would have found a part and the
     * description just did. Said out loud rather than left out, because the alternative is a sentence
     * that reads like a place-file fault when the fault is here.
     */
    private describeLobbyCandidates(): string {
        const arena = findArena();
        if (arena === undefined) return `nothing in Workspace is a Model named "${ARENA_CONFIG.ARENA_NAME}".`;

        const folder = lobbySpawnFolder(arena);
        if (folder === undefined) {
            return `"${arena.GetFullName()}" has no folder called "${ARENA_CONFIG.LOBBY_SPAWNS_FOLDER}".`;
        }

        const parts = basePartsIn(folder);
        if (parts.size() === 0) return `"${folder.GetFullName()}" holds no BasePart children.`;

        return (
            `"${folder.GetFullName()}" holds ${parts.size()} BasePart(s), which the search should have taken` +
            ` one of — so that points at the lookup rather than at the place file.`
        );
    }

    /**
     * The lobby spawn, waiting for the place to have one.
     *
     * **Prints once when it starts waiting and once when it stops, rather than per turn of the loop.**
     * The fault is a static one — either the part is in the place or it is not — so one sentence
     * describes it, and a line a second would bury that sentence in its own repetition. The recovery
     * line matters as much as the warning: somebody adding the part in Studio mid-session needs to
     * see the round system notice, or the silence afterwards is indistinguishable from a session that
     * was broken from the start.
     *
     * **Deliberately uncapped.** The fix is in Studio and takes as long as it takes; a loop that gave
     * up after a minute would be a round system that stayed dead for the rest of the session, which is
     * the outcome this whole arrangement exists to remove. A lookup a second costs nothing next to
     * that.
     *
     * **Nothing is destroyed while this waits, and that is the newest reason it is safe to wait.** The
     * hold used to sit in front of the map swap, so going on without a lobby would have dropped
     * everybody into an arena that was about to be torn down around them; the arena is permanent now,
     * so nobody is in the way of anything. What it still costs is the intermission itself: held at its
     * full length, saying so, until the spawns turn up.
     */
    private async waitForLobby(): Promise<CFrame> {
        let waiting = false;

        while (true) {
            const lobby = this.lobbySpawn();

            if (lobby !== undefined) {
                if (waiting) print(`[Round] ${ARENA_CONFIG.LOBBY_SPAWNS_FOLDER} found — the intermission can run`);
                return lobby;
            }

            if (!waiting) {
                waiting = true;

                warn(
                    `[Round] no usable lobby in "${ARENA_CONFIG.ARENA_NAME}" — holding the intermission until ` +
                        `there is one. Everybody is standing in the arena, and there is nowhere else to put ` +
                        `them until "${ARENA_CONFIG.LOBBY_SPAWNS_FOLDER}" has parts in it. ` +
                        this.describeLobbyCandidates(),
                );
            }

            task.wait(1);
        }
    }

    /**
     * The arena spawn for `player`'s side — one of that side's spawn parts, picked at random.
     *
     * **The one place the side-to-spawn mapping lives**, so a round's opening teleport and a
     * respawn mid-round cannot send the same player to different ends of the arena. A player
     * with no team — somebody who joined while a round was already under way — is treated as
     * A's, here and at the round start alike; they are not in `activePlayers`, so this is the
     * only moment it ever matters for them.
     *
     * **The pick is made here rather than at either call site**, which is what makes a respawn land
     * as spread out as the opening whistle: both go through this method, so there is no second place
     * for the two to disagree — the same reason the side mapping is here. It follows that the draw
     * is per *call*, so a returning player is not sent back to the spot they died on.
     */
    private arenaSpawnFor(player: Player): CFrame {
        return this.getRandomTeamSpawn(findArena(), this.teams.get(player) === TEAM_B ? TEAM_B : TEAM_A);
    }

    /**
     * One of `team`'s spawn parts, picked uniformly at random.
     *
     * **A folder of parts inside the permanent arena**, one per place a player may stand, rather than
     * a spread around a point. A spread could not know how big the platform underneath it was, so it
     * could walk people off the edge — and the answer to that would have been a radius small enough
     * to defeat the point. A part is a spot somebody has looked at and decided is a fine place to
     * begin; the randomness is then only *which* of those spots, a choice with no geometry in it.
     *
     * **The arena is asked for its spawns at the moment they are needed, and the answer is not kept.**
     * Nothing caches the parts or the folder: the arena is a permanent part of the world, so a
     * reference into it would not go stale the way one into a destroyed map would — but the parts
     * inside it are one Studio edit away from being replaced, and a cached list would be the last
     * round's spawns. It is also why the arena arrives as an argument rather than being looked up
     * here: this is reached both by a respawn and by the opening teleport, and both want the arena as
     * it is *now*.
     *
     * **Every failure here is an error, and that is the enforcement.** These are only reachable if the
     * round boundary's own check was skipped — no arena at all, or an arena with no spawns on a side —
     * and both mean a round cannot start. A round that began with everybody in the lobby would look
     * like a hang; an error names what is wrong. See `arenaProblem`, which is what turns the same
     * emptiness into the sentence a person reads before this is ever reached.
     *
     * Only **direct** `BasePart` children count. A `Model` full of parts is not a spawn and is
     * skipped rather than searched, so there is one rule about what a spawn is and the errors above
     * describe it exactly.
     */
    private getRandomTeamSpawn(arena: Instance | undefined, team: TeamLabel): CFrame {
        if (arena === undefined) {
            error(`[Round] no "${ARENA_CONFIG.ARENA_NAME}" in Workspace — cannot resolve team ${team} spawns`);
        }

        const parts = teamSpawnParts(arena, team);

        // Still an error, even though the round boundary refuses an arena like this before it gets
        // here. This is the enforcement the round leans on: a caller that skipped the boundary, or
        // an arena that lost its spawns mid-round, finds out here rather than placing somebody in the
        // void. `arenaProblem` is what turns the same emptiness into the sentence a person reads.
        if (parts.size() === 0) {
            error(`[Round] no spawn parts at ${arena.Name}.${ARENA_CONFIG.ARENA_SPAWNS_FOLDER}.${teamFolderName(team)}`);
        }

        return parts[math.random(0, parts.size() - 1)].CFrame.add(new Vector3(0, 3, 0));
    }

    /** Everyone to one place. The lobby's business: no side is on the lobby's side. */
    private teleportAll(to: CFrame) {
        for (const player of Players.GetPlayers()) {
            const character = player.Character;
            if (character) character.PivotTo(to);
        }
    }

    /**
     * Each side to its own spawn, for the start of a round.
     *
     * Resolved through {@link arenaSpawnFor} per player, and that is what makes a bad place
     * file safe: a missing part raises on the *first* lookup, before the first character has
     * been moved, so nothing ends up half-sent to a side that does not exist.
     *
     * **The match's players only, which is what leaves everybody else in the lobby.** This used to move
     * every player in the server, and with opt-in that would be the whole feature undone in one line: a
     * spectator standing in the lobby would be teleported into the arena and asked to play a match they
     * never joined. `activePlayers` is exactly the roster at this point — filled a few lines above and
     * emptied at every intermission — so this is the roster by construction rather than by a second filter
     * that could disagree with it.
     */
    private teleportTeamsToArena() {
        for (const player of this.playersInRound()) {
            const character = player.Character;
            if (character) character.PivotTo(this.arenaSpawnFor(player));
        }
    }

    /**
     * Takes the ball out of every hand, at the end of the intermission.
     *
     * **Destroyed, not dropped — and that is what lets this sit here rather than after the
     * teleport.** A dropped ball lands where its dropper is standing, so a drop has to be sequenced
     * against the move to the arena: done before it, every ball is left behind in the lobby. A ball
     * that is destroyed has no position to get wrong, so this can sit on the boundary itself and
     * needs to know nothing about where the arena is or which side anybody is on.
     *
     * **At the end of the intermission, not the start of the round.** The hands are empty a moment
     * before the round is on, which is what "a round starts empty" has to mean: by the time
     * `Playing` is published there is nothing left that could be thrown in the same frame the phase
     * changes. Placed after {@link waitWhilePaused} for the same reason — a paused harness must not
     * strip balls off players while the round is being held up, because nothing is about to start.
     *
     * **The arena stocks itself.** What is destroyed here is what players were carrying, and the
     * count that matters is the one `BallSpawnerService` keeps beside each spawner, which it puts
     * out as the round runs. The other way a ball leaves a hand is `BallService.dropBall`, which is
     * the one to reach for when a ball should stay in play rather than stop existing.
     *
     * Asked of every player on the server rather than of `activePlayers`, which is empty at this
     * point: it is filled from `GetPlayers`, below this, and a player who joined mid-round was in
     * neither.
     */
    private clearHeldBalls() {
        for (const player of Players.GetPlayers()) {
            const character = player.Character;
            if (character) this.balls.removeBall(character);
        }
    }

    /**
     * Takes the ball out of every hand the round that has just ended could have filled.
     *
     * **The round-end companion to {@link clearHeldBalls}, and the two are not the same job.** That
     * one empties hands *before* a round so nobody carries a ball into it; this one empties them
     * *after* one, and the difference is who it is about — a ball that was part of the round just
     * finished, in the hand of somebody being moved back to the lobby.
     *
     * **Destroyed rather than dropped.** The hand it is in is on its way to the lobby, and a dropped
     * ball would land on the arena floor and stay there — the arena is permanent now and nothing walks
     * it, so the next round would be played around the last round's litter. A ball that is destroyed
     * has no position to be wrong about, which is the same argument {@link clearHeldBalls} makes for
     * the same call.
     *
     * **The roster is taken as it stands, and that is forced rather than chosen.** `activePlayers` is
     * cleared on the line above this in the loop — that clear is part of entering an intermission — so
     * there is no round roster left to read here. Every player in the server is the honest answer:
     * whoever was in the round is still in the server, since the only way out of a round mid-flight is
     * out of the server, and the ones who joined during it are the spectators the round-start clear
     * already treats the same way. See {@link roundParticipants} for the rigs.
     *
     * **Every player, not every character — the ball belongs to the hand.** A player with no character
     * (mid-respawn, or on their way out) is holding nothing, because a ball in a hand is welded to a
     * part of that character and dies with it. There is deliberately no `PlayerRemoving` counterpart:
     * a leaver's character is destroyed with them, so their ball is already gone by the time anybody
     * could ask, and a second attempt to remove it would just be a lookup that finds nothing.
     *
     * **Held balls are a hand's business, so they are cleaned up here rather than by a sweep of the
     * arena.** A ball in a hand is welded to a *character*, and a character is not a descendant of the
     * arena — so a cleanup that walked the arena would not find one however hard it looked. The loose
     * balls are the spawner's, and they are swept by tag rather than by position for the same reason:
     * see `BallSpawnerService.cleanupRoundBalls`, which skips anything held.
     */
    private clearEndedRoundHeldBalls() {
        let cleared = 0;

        for (const participant of roundParticipants()) {
            // The return value is the count, which is why this does not have to ask first: `removeBall`
            // answers `false` for a model with an empty hand, which is the ordinary case for a player
            // who had already dropped their ball or lost it in a catch.
            if (this.balls.removeBall(participant)) cleared++;
        }

        // **One line for the whole round, and only when there was something to say.** A ball left in
        // a hand when the round ends is worth a line, so this is not hidden behind `DEBUG`; an
        // intermission that cleared nothing prints nothing, so the line appearing at all is the
        // evidence that the cleanup had work to do.
        if (cleared > 0) print(`[Round] cleared ${cleared} held balls`);
    }

    private async gameLoop() {
        while (true) {
            // --- Intermission ---
            this.state = RoundState.Intermission;
            this.activePlayers.clear();
            print("Intermission started");

            // **The phase goes out here, before anything that can hold, and that is a reversal.**
            //
            // These three lines used to sit below the map swap, on the reasoning that an intermission
            // had not really started until the arena was on its way in. What that cost is the whole of
            // the next paragraph: `waitForLobby` can hold indefinitely, and while it held, the folder
            // still said whatever the *previous* phase had published — `Playing`, with the finished
            // round's last clock value. A held intermission therefore read as a round that had frozen
            // mid-count, which is a confident lie about the state of the game, and it is exactly the
            // report this was fixed from.
            //
            // The number published with it is the honest one: a full `INTERMISSION_SECONDS`, not
            // counting. A held intermission is not running, so a clock that had been left to tick
            // would be the second lie.
            this.timeRemaining = ARENA_CONFIG.INTERMISSION_SECONDS;

            // The phase goes out as its own name, which is the HUD's entire vocabulary. Those two
            // words are `RoundState`'s members by convention rather than by construction, so
            // renaming a member means renaming the string here.
            this.statusFolder.SetAttribute(ROUND_STATE_ATTRIBUTE, "Intermission");
            // Published with the clock rather than only after the first second comes off it, so
            // the HUD never shows the *previous* phase's final number under the new phase's name.
            this.statusFolder.SetAttribute(ROUND_TIME_ATTRIBUTE, this.timeRemaining);

            // **The lobby next, and it is the one fault this loop answers by waiting.**
            //
            // The comment at the round boundary below explains at length why a throw from inside this
            // loop ends the *session* rather than the round. This was the same hazard one step
            // earlier, and it was the one still open: `teleportAll` reached `getSpawn`, which
            // `error()`ed, so a place file with no `LobbySpawn` took the loop down on its very first
            // turn — with one rejection line and nothing after it.
            //
            // **Waiting is the only safe answer here, not a fallback position.** Everybody is standing
            // in the arena, and the next lines move them out of it — so going on without somewhere to
            // put them would leave the whole server standing where the round ended, which is precisely
            // the "everyone in the wrong place" that `LOBBY_SPAWN_NAME`'s note says a missing lobby
            // must never cause. (This sentence used to say "the next lines destroy it", from when the
            // arena was unloaded at the end of a round; the arena is permanent now, so the teleport is
            // the whole of the move.)
            // Nothing below this point has run yet, so there is nothing to undo: the loop simply comes
            // back when the part exists.
            //
            // **The phase is already published above, which is what makes a hold visible.** With the
            // publish below this line, a held intermission was indistinguishable from a frozen round
            // — see the note above for what that looked like. See `waitForLobby` for the two lines it
            // prints around one, which is the other half of the same answer.
            //
            // **The lookup comes out here and the move goes into the transition, and they had to part
            // company for the cover to work.** This was one line — `teleportAll(await waitForLobby())` —
            // and the two halves want opposite things: the wait can hold for as long as the lobby is
            // missing, so it has to happen with the screens clear, while the move has to happen with them
            // covered. Finding the lobby first gives both. See `transitionAround`.
            const lobby = await this.waitForLobby();

            // **No hold at this boundary**, and the absence is the point: the round is over, so there is
            // nothing to hold anybody for — the only thing being covered here is the move back to the lobby.
            await this.transitionAround(() => this.teleportAll(lobby), {
                wipe: TRANSITION_CONFIG.WIPE_AT_ROUND_END,
            });

            // **The cleanup that has to happen here, and the ordering that used to matter.** The held
            // balls go first, and the reason is structural rather than a preference: a ball in a hand is
            // welded to a *character*, so it is not a descendant of the arena and a sweep of the arena
            // cannot see it however hard it looks. The other half of this pair used to be the arena
            // itself — unloading the map took the loose balls, the corpses and everything else the round
            // had left lying in it — and that call is gone now that the arena is permanent. The round
            // boundary below carries the full account of what each of those things belongs to instead;
            // what survives here is the half only this loop can do.
            this.clearEndedRoundHeldBalls();

            // **And the roster goes with them, which is what sends everybody back to the join part.** The
            // teleport above has already put every player in the lobby — opted in or not, that is where an
            // intermission moves everybody — so this is the other half of "one match, then ask again": the
            // sides are forgotten, the sign goes back to nought, and the next match is made of whoever walks
            // into the part. See `MatchService.clear`, which is also what repaints the sign.
            this.matches.clear();

            // **And every ability window, for the reason those held balls go.** A super bought in one
            // round must not be carried into the next, and a window measured in seconds would otherwise
            // survive the whole intermission and be spent in a round that had nothing to do with it.
            // Every player rather than the round's participants, because the window is the *player's*: a
            // spectator who opened one is as finished with it as anybody, and the two are one list to
            // write over once a minute.
            //
            // **And every wait for a body, in the same loop because it is the same kind of thing.** A player
            // who died inside the round and was still counting down when it was decided has *no character at
            // all* — and the teleport to the lobby above moves bodies rather than making them, so a timer left
            // to fire on its own would leave them invisible for the whole intermission and looking exactly like
            // a break in the join path. `cancel(player, true)` drops the wait and loads in the same call: the
            // intermission is a place with nothing at stake, so the body is wanted now rather than in three
            // seconds. See `RespawnService.cancel`, whose flag exists for precisely this caller.
            for (const player of Players.GetPlayers()) {
                this.abilities.clearMultiBall(player);
                this.respawns.cancel(player, true);
            }

            // **And every freeze, for the same reason and from the same moment.** A body held in place by
            // an ability belongs to the round the ability was spent in, and a round boundary is the one
            // point in the game where nothing carries over. Every body rather than the round's
            // participants, because a freeze is a fact about a body: a spectator caught in a splash is as
            // frozen as a player caught in one, and a rig has no side to be a participant of.
            //
            // This is the *only* thing that ends a freeze early. The other two are its own clock and its
            // body's death, and both live in `FreezeService` — where they are one watcher per frozen body
            // rather than a call from here, because a rig's death never reaches this file at all.
            this.freezes.unfreezeAll();

            // **No map to swap, and this line is where the swap used to be.** The arena is a permanent
            // part of the place — `ArenaV2` at the root of `Workspace`, with the lobby's spawn parts
            // inside it — so an intermission now has nothing to clone, nothing to place and nothing to
            // destroy. What
            // stood here was `unloadCurrent` and `loadMap`: the first tore down the arena the round had
            // just been played in, and that is also what made the second safe to pay for, because a
            // `Clone` is the expensive half of a swap and an intermission is where there is time to pay
            // it.
            //
            // **Both of those jobs have an owner, and neither of them is a line here.** Clearing the
            // world of the round that has just ended is what the two cleanups above and the spawner's
            // own sweep are for — the round boundary below carries the full account of what the unload
            // covered and who covers it now. Paying for a clone is not a cost anybody has to schedule
            // any more, because nothing is cloned.

            // The clock is published above the lobby wait now — see the note there for why the phase
            // goes out before anything that can hold. Counting starts here, which is what leaves a
            // held intermission sitting at its full length rather than ticking against nothing.

            // Counted beside the clock rather than derived from it, because the two stop for the
            // same reason and at the same moment: a frozen tick `continue`s below without touching
            // either, so this measures *running* seconds. A window timed off the wall clock would
            // close while a round was still being held up.
            // **The intermission no longer counts down to a round: it waits for one.**
            //
            // The clock it used to run was the only thing that started a round, which made every round
            // something the server decided on its own — and with matchmaking that is the wrong shape twice
            // over: a match has players who *chose* to be in it and sides somebody picked, and neither of
            // those exists just because a timer ran out. So this is the same loop with a different question
            // at the top: it turns until `pendingMatch` is set. Two things set it — the settle window
            // further down, which is how a match normally begins, and a dev's `!dev match` as the manual
            // override.
            //
            // **The clock still runs, and wraps rather than reaching zero.** The number on the HUD is the
            // honest sign that the server is alive, and freezing it for a wait with no promised end would
            // read as a hung server — the same lie the held intermission used to tell. So the countdown
            // restarts at its full length each time it reaches zero: the clock says the server is running by
            // moving rather than by stopping, and a wrap is not a round boundary.
            let elapsed = 0;

            // **The settle window's two numbers, counted on the clock's own ticks.**
            //
            // `settledFor` is how many ticks the roster has been startable and unchanged, and `roster` is
            // the roster that count was last measured against. Both are declared out here rather than inside
            // the loop because both have to survive a wrap: the countdown going round again is a fact about
            // the clock, not about the sides, and a grace period that reset itself every sixteen seconds
            // would be a match that never started.
            let settledFor = 0;
            let roster = this.matches.rosterRevision();

            while (this.pendingMatch === undefined) {
                // A paused tick does nothing at all: no second off the clock, no change of
                // state, no teleport. The phase resumes from whatever the clock said when it
                // was switched off, which is the whole difference between pausing and ending.
                //
                // **A server below the minimum freezes in exactly the same way**, and for the same
                // reason: there is nobody to start a match for. This single line is where "freeze,
                // don't skip" lives — and it is the *only* thing that stops the clock, which is the
                // honest reading of it: with one player in the server the clock stands still because no
                // match could be started anyway.
                //
                // **And the settle count goes with the clock.** A paused or half-empty server is not
                // accumulating a start: the sides may well still be startable from before, and a match that
                // began the instant the population came back would open while nobody was there to see it.
                if (this.isRoundsPaused() || this.belowMinimum()) {
                    settledFor = 0;
                    task.wait(1);
                    continue;
                }

                // The vote opens on the intermission's **first running second**, which is not the
                // same moment as the intermission *starting*: a server below the minimum is frozen
                // above, so its intermission has not really begun and the window should not be open
                // while nobody is there to vote. Opening it here rather than once before the loop
                // is also what lets a server that fills up thirty seconds later still get this vote.
                //
                // **Switched off, and left standing.** See `VOTE_ENABLED` — the vote is not offered any
                // more, and the call stays where it is so that turning it back on is that one line.
                if (VOTE_ENABLED && elapsed === 0) this.votes.openVote();

                task.wait(1);
                this.timeRemaining--;
                elapsed++;

                // **The wrap.** Reaching zero is not the end of anything now, it is the clock going round
                // again — and `elapsed` goes round with it, so a wrapped intermission behaves like a fresh
                // one to anything counting running seconds, the vote window above included.
                if (this.timeRemaining <= 0) {
                    this.timeRemaining = ARENA_CONFIG.INTERMISSION_SECONDS;
                    elapsed = 0;
                }

                this.statusFolder.SetAttribute(ROUND_TIME_ATTRIBUTE, this.timeRemaining);

                if (VOTE_ENABLED && elapsed === GAME_MODE_CONFIG.VOTE_SECONDS) this.votes.closeVote();

                // **The normal start: a roster that is ready and has stopped moving.**
                //
                // **Nobody has to ask for a match for one to happen, and that is the design rather than a
                // fallback.** A server whose sides are full and have stopped moving keeps opening rounds by
                // itself; `!dev match` is the override beside it, for a dev who does not want to wait out
                // the window. Both arrive at the same door — see {@link startMatch} — so nothing below cares
                // which of the two this is.
                //
                // **Read against the revision rather than the counts, and a side switch is why.** `countsFor`
                // cannot see the change that matters most here — a player crossing from `A` to `B` leaves it
                // identical — and that crossing is exactly the move this window exists to wait out. Any
                // touch, move, departure or clearing moves the number, so comparing it is the question "is
                // this the same roster I was looking at a second ago".
                //
                // **A roster that is not startable resets the count rather than pausing it**, so one player
                // waiting alone on a pad does not carry a half-elapsed window into the instant somebody joins
                // them: the match then starts a full `MATCH_SETTLE_SECONDS` after the sides were complete,
                // which is the window the last arrival is owed.
                const current = this.matches.rosterRevision();

                if (current !== roster) {
                    roster = current;
                    settledFor = 0;
                } else if (this.matches.canStart()) {
                    settledFor++;

                    if (settledFor >= MATCH_SETTLE_SECONDS) {
                        // **Two lines, because two places know the two facts.** `startMatch` says what is
                        // coming and in which mode; this says the request came from the roster rather than
                        // from a dev, which is the normal path and the one worth being able to tell apart
                        // in the output from somebody having typed `!dev match`.
                        const counts = this.matches.countsFor();

                        print(
                            `[Round] starting on its own — the sides held still for ${MATCH_SETTLE_SECONDS}s` +
                                ` (A: ${counts.a}, B: ${counts.b})`,
                        );

                        // The same door the dev command uses, so the field still has exactly one writer — and
                        // a request that arrived a moment earlier still wins, because this branch is only
                        // reached while it is unset.
                        this.startMatch(SCORE_RUSH);
                    }
                } else {
                    settledFor = 0;
                }
            }

            await this.waitWhilePaused();

            // **The request has arrived, and everything below is the boundary it asked for.** The `await`
            // above is the existing pause point and keeps its meaning: a match requested while a dev has
            // rounds held up waits for them, the same rule every other boundary follows.

            // Closed again on the boundary, which is the call that matters when the window never
            // elapsed — a harness paused through the intermission, or a round cut short. It is a
            // no-op if the first close already ran, so this cannot re-roll a tie that has been
            // broken already.
            if (VOTE_ENABLED) this.votes.closeVote();

            // The intermission's last act: nobody carries a ball into a round. See
            // `clearHeldBalls` for why it is destroyed here rather than dropped after the teleport.
            this.clearHeldBalls();

            // --- Playing ---

            // **The request is taken here, before anything can refuse it, and that ordering is the whole of
            // why it sits above the arena check.** A request cleared only on the successful path would
            // survive a refused start — and since the intermission now waits on `pendingMatch` being set,
            // the loop would come straight back to this line with the request still in flight and spin:
            // no clock, no pause, no teleport, just `cannot start` a frame apart for as long as the place
            // file is broken. Taken here, a refused start drops the request and the intermission goes back
            // to waiting for somebody to ask again.
            const requested = this.pendingMatch;
            this.pendingMatch = undefined;

            // **A round whose arena cannot host it does not start.**
            //
            // This check exists because of what happens without it, which is worth spelling out
            // because it is not obvious from the code below: `getRandomTeamSpawn` raises when there is
            // no arena, or when a side's spawn folder is missing or empty, which is the right thing for
            // *it* to do — but it is called from inside this loop, and `gameLoop` is an `async`
            // function. roblox-ts turns that into a promise, and a throw inside it rejects the promise
            // instead of unwinding a coroutine. Nothing handles the rejection, so the loop simply stops
            // — for the rest of the server's life.
            //
            // What the player sees is not an error message but a *frozen HUD*: the throw happens
            // before `ROUND_STATE_ATTRIBUTE` is set to `"Playing"`, so the folder still says
            // "Intermission" and the clock still says whatever the last intermission tick left it at.
            // `Intermission — 0s`, for ever, with nothing in the output after the one rejection.
            //
            // Checking here instead costs one intermission rather than the session, and it is
            // checked **before anything is half-started**: no sides are assigned, nobody is marked
            // as playing, no clock is set. The loop goes round, the arena is looked for again, and
            // repairing the place while the server is running works on the next cycle with no restart
            // — the same bargain `waitForLobby` makes for the lobby, one step earlier.
            //
            // **The arena is resolved here and handed down, which is where `MapService` used to be
            // asked four times.** The map was loaded, checked against, placed, and then read again
            // during the round for its spawns — four questions with one answer that could not change,
            // which is what made them all go through that service. The arena is a permanent part of
            // the place, so there is nothing to load or to place, and one lookup answers every question
            // the round has about it.
            const arena = findArena();
            const problem = arenaProblem(arena);

            // **`arena === undefined` is in this test to narrow the type, not to report anything
            // extra.** `arenaProblem` answers with the missing-arena sentence in exactly that case, so
            // `problem` is never `undefined` here while the arena is — which means one message and one
            // `continue` cover both halves, and the compiler is told what the reader can already see.
            if (arena === undefined || problem !== undefined) {
                print(`[Round] cannot start — ${problem}. Waiting for another match.`);

                continue;
            }

            // **The arena's barriers are put in their collision group here, and this is a side effect
            // that had to be replaced rather than a new rule.** `MapService.placeCurrent` ran
            // `applyBarrierGroups` over the clone as it entered the world, and that was the only place
            // the `CharacterBarrier` tag was ever read — so with nothing placed per round, a tagged wall
            // in the permanent arena would keep whatever group the place file gave it and stop **balls
            // as well as characters**, which is the exact opposite of what the tag means. See
            // `applyBarrierGroups` and `CHARACTER_BARRIER_TAG`.
            //
            // **Every round rather than once at boot**, because this project's place files are edited
            // while a server is running: a wall added, tagged or moved after boot would otherwise stay
            // in the wrong group until the next restart. The pass is idempotent and touches only tagged
            // parts, once a round, which is what makes that affordable.
            //
            // **No argument and no class check, and that is the correction the first real place file
            // forced.** This used to hand the arena over and skip the pass unless the arena was a
            // `Model` — which in a place whose arena is a `Folder` meant the wall was never assigned at
            // all, with one warning a round as the only evidence that it had not been. The pass finds
            // its parts by tag now, so neither where the arena sits nor what class it is can matter.
            // `findArena` still cares about both, because the *spawn folders* are looked up inside it.
            applyBarrierGroups();

            // **What the unload used to do, and who does it now.** Tearing the arena down at the end
            // of every round was also the one sweep that cleared whatever the round had left lying in
            // it, and that call is gone — so this is the account of where each of those things goes
            // instead. Loose balls: `BallSpawnerService.cleanupRoundBalls`, on the same Playing →
            // Intermission edge this loop is standing on, which destroys every ball wearing the round's
            // tag and deliberately leaves a held one alone. Held balls: the two cleanups above, one at
            // each boundary. Corpses: `RespawnService`, which replaces one on the spot for a death in the
            // lobby or an elimination and after the delay inside a round — and the body it loads is routed
            // by `handlePlayerJoined`, so an eliminated player comes back as a spectator in the lobby
            // through the same branch a joiner takes. Ability debris: its own lifetime, plus
            // `freezeAll`'s opposite above. Rigs: the `NPC` tag and `NpcService`, which own a rig for as
            // long as it is tagged — note that rigs now *outlive a round*, where a destroyed arena used
            // to take them with it, and that is left alone deliberately: a rig is furniture of the
            // arena rather than of a round.
            //
            // **Nothing is added here on purpose.** A new sweep of this arena would be a second owner
            // for things that already have one, and the first thing it would get wrong is the balls: a
            // ball in somebody's hand is not the arena's litter, and a walk over the arena cannot tell
            // one from a ball on the floor. `clearEndedRoundHeldBalls` and the spawner's sweep exist in
            // that order for exactly that reason.

            // **And what the arena is, in one line, before anybody is moved onto it.** The paths are the
            // point: the arena and its two spawn folders are the three things a round cannot start
            // without, so printing them turns "the round started in the wrong place" into a place-file
            // question with a name in it. Printed after the checks above rather than before, so that the
            // failing case is reported by the `cannot start` line instead of by a line that reads as
            // though everything were fine.
            const spawnsA = spawnFolderFor(arena, TEAM_A);
            const spawnsB = spawnFolderFor(arena, TEAM_B);

            print(
                `[Round] arena resolved — ${arena.GetFullName()}; ` +
                    `spawns ${spawnsA !== undefined ? spawnsA.GetFullName() : "missing"} and ` +
                    `${spawnsB !== undefined ? spawnsB.GetFullName() : "missing"}`,
            );

            this.state = RoundState.Playing;

            // **The mode is the one that was asked for, and everything else plays Score Rush.** Resolved once,
            // here, rather than read live: a mode is fixed for the length of the round it opened, so a round
            // cannot change its own rules underneath itself. The vote used to decide this — see
            // `VOTE_ENABLED` — and with it switched off the fallback is the mode this whole change exists to
            // play. `DEFAULT_MODE` still initialises the field, which is what keeps a server that has never
            // opened a match behaving as it always did.
            this.mode = requested ?? SCORE_RUSH;

            // **And the mode is published here, because the vote is no longer the one that publishes it.**
            // `VoteService.closeVote` was the only writer of this attribute, and a vote that never opens
            // never writes it — so without this line every reader (the top bar's name, the rings, the
            // outlines) would be holding the last vote of the session, or nothing at all. Written *before*
            // the sides are, which is the order the colour readers need: the outline repaints on both
            // attributes, and the mode has to be true before the sides it paints are.
            this.statusFolder.SetAttribute(ROUND_MODE_ATTRIBUTE, this.mode.id);

            // A fresh scoreboard for a fresh round: a round that inherited one would be starting
            // in the middle of somebody else's game. The round is also un-finished here — it is
            // exactly the flag's lifetime — so a round ended early by a leaver cannot leave the next
            // one unable to finish at all.
            this.scores.clear();
            this.publishScores();

            // **Both boards go with the scoreboard, and here rather than where the round ends.**
            // Cleared at `finishRound` they would empty the panel that reads them one frame before
            // the intermission they are meant to fill: a board is the round's *record*, so it has to
            // outlive the round by exactly as long as the intermission does, and clearing it at the
            // next round's opening is what gives it that lifetime. See `roundHits` and `roundOuts`.
            this.roundHits.clear();
            this.roundOuts.clear();

            this.finished = false;

            this.assignTeams();

            // **The round is the roster, and everybody else is watching it.** Only the players `MatchService`
            // has put on a side go into `activePlayers`; somebody standing in the lobby who never touched the
            // join part is not in the match and not on a side, and this is the line that says so to everything
            // outside this service. The teleport below covers the match's players only, and a spectator who
            // dies and respawns is sent back to the lobby by the same branch a joiner takes — see
            // `handlePlayerJoined`.
            //
            // **The streak is cleared for everybody, spectator or not**, and that is the one thing in here
            // that is not about the roster: a run of hits is a fact about the round that has just ended, and
            // somebody who sat this one out did not earn the one they were carrying.
            for (const player of Players.GetPlayers()) {
                // **A run of hits belongs to a round, and this is where a round begins.** Beside the
                // score board and the two boards cleared above, and for their reason: a streak is a fact
                // about the round that has just ended, so it is cleared where the next one opens rather
                // than at the intermission — which is what lets the readout still show it for as long as
                // the result panel is up.
                //
                // The *charge* is deliberately not touched. It is held until it is used, so a player who
                // earned one and never spent it carries it into this round.
                this.abilities.resetForRound(player);

                // **In the round, therefore not spectating.** This is where last round's eliminated players
                // come back, and where an opt-in that arrived while the boundary was working becomes a
                // participant — written only for the players the round actually has, which is what makes the
                // attribute mean "in the match" rather than "in the server".
                if (!this.teams.has(player)) {
                    player.SetAttribute(SPECTATING_ATTRIBUTE, true);
                    continue;
                }

                this.activePlayers.add(player);
                player.SetAttribute(SPECTATING_ATTRIBUTE, false);
            }

            // **And one crown recomputation for the whole server, rather than one per player in the loop
            // above.** Every count on the server has just gone to nought, so there is a single answer to
            // work out and it is the same answer for everybody — which is why this is one call after the
            // loop instead of a line inside it. See `SuperService.resetForRound`, which explains why the
            // reset itself does not do this.
            this.abilities.refreshCrowns();

            print(`Round started — ${GAME_MODE_NAMES[this.mode.id]}`);

            this.timeRemaining = ARENA_CONFIG.ROUND_SECONDS;
            this.statusFolder.SetAttribute(ROUND_STATE_ATTRIBUTE, "Playing");
            this.statusFolder.SetAttribute(ROUND_TIME_ATTRIBUTE, this.timeRemaining);
            // Cleared where the *playing* phase opens, not where an intermission does. The
            // intermission that follows a round is precisely the one that should still be showing
            // what that round decided, so clearing at the intermission's own start would wipe
            // every winner a frame after it was set.
            this.statusFolder.SetAttribute(ROUND_WINNER_ATTRIBUTE, "");

            // **The move goes inside the transition, and the hold begins where the players land.** The phase
            // and its clock are published first — that is what the HUD reads, and it is what names the round —
            // and then the transition covers the screens, moves everybody to their side's spawn, and keeps
            // them there for `ARENA_FREEZE_SECONDS` measured *from that move*. The clock published at its full
            // length above does not move until this returns, which is the tick the hold lifts: see
            // `transitionAround`, whose last act is the release, and `releaseArenaEntry` for why that and the
            // round's first second are one moment rather than two timers that agree.
            await this.transitionAround(() => this.teleportTeamsToArena(), {
                holdEveryoneFor: ARENA_CONFIG.ARENA_FREEZE_SECONDS,
            });

            while (this.timeRemaining > 0) {
                // **The round may already be over**, decided from outside this loop: a player leaving
                // can empty a side, and `PlayerRemoving` records that the moment it happens rather
                // than waiting for a tick — see the note there. There is nothing left to count down
                // to, so the round is left here.
                //
                // Checked *before* the pause below on purpose: a round whose side has emptied is
                // over, and a dev holding rounds up should not be holding up a result that is
                // already decided. The pause is for rounds that are still being played.
                if (this.finished) break;

                if (this.isRoundsPaused()) {
                    task.wait(1);
                    continue;
                }

                task.wait(1);
                this.timeRemaining--;
                this.statusFolder.SetAttribute(ROUND_TIME_ATTRIBUTE, this.timeRemaining);

                // Checked after the clock moves, so a round ends on the tick its last second
                // runs out rather than a tick later. Both questions are asked on every tick — the
                // roster (has a side left the server?) and then the mode's own rules — which is what
                // makes a round end the moment the last player on a team goes down, and the moment a
                // team's last player disconnects, with whatever time was left unspent.
                const outcome = this.roundOutcome();
                if (outcome !== undefined) {
                    this.finishRound(outcome);
                    break;
                }
            }

            await this.waitWhilePaused();
        }
    }
}

/**
 * The player a thrower token belongs to, or nothing.
 *
 * **The token is all a ball carries.** `BallService.throwBall` stamps the ball's `ThrowerId` with
 * the thrower model's `THROWER_TOKEN` and then lets go of the model entirely, so there is nothing
 * left to ask for it. A player's token is their `UserId` as text and a rig's is a GUID, so
 * `tonumber` is the entire rule for "was this a person": a GUID does not read as a number. That is
 * what makes NPCs fall out rather than be special-cased.
 *
 * A deliberate copy of the same four lines in `StatsService`, which keeps its own because it is
 * the only thing that file needs from a token and importing across would tie lifetime statistics
 * to the round for one function. If the rule ever changes, it changes in both — and the comment
 * here is the reminder that there are two.
 */
function playerFromToken(throwerToken: string): Player | undefined {
    const userId = tonumber(throwerToken);
    if (userId === undefined) return undefined;

    return Players.GetPlayerByUserId(userId);
}

/** The name of `team`'s spawn folder inside the arena. The labels are the folder names. */
function teamFolderName(team: TeamLabel): string {
    return team === TEAM_B ? ARENA_CONFIG.ARENA_TEAM_FOLDER_B : ARENA_CONFIG.ARENA_TEAM_FOLDER_A;
}

/**
 * `team`'s spawn folder inside `arena`, or nothing if the arena has none.
 *
 * **The two-level lookup, written once, because three callers want it.** The spawn picker wants the
 * parts inside this folder, `arenaProblem` wants to know it is there and not empty, and the round's
 * own `[Round] arena resolved` line wants its full path for the log — and all three used to write
 * their own pair of `findFolder` calls half a screen apart, which is three places for the folder's
 * name to be spelled differently.
 *
 * **Both levels are searched for rather than named as children**, so an arena author who tidies
 * `ArenaSpawns` into a grouping folder of their own has broken nothing. See `shared/find.ts` for why
 * the class has to be part of the question rather than a check on the answer.
 */
function spawnFolderFor(arena: Instance, team: TeamLabel): Folder | undefined {
    const spawns = findFolder(arena, ARENA_CONFIG.ARENA_SPAWNS_FOLDER);
    if (spawns === undefined) return undefined;

    return findFolder(spawns, teamFolderName(team));
}

/**
 * The arena's `LobbySpawns` folder, or nothing if it has none.
 *
 * **Searched for rather than named as a child**, for the reason {@link spawnFolderFor} gives about
 * `ArenaSpawns`: somebody who tidies the folder into a grouping folder of the arena's own has broken
 * nothing, and the *shape* — a folder of `BasePart`s — is the part that is a contract.
 */
function lobbySpawnFolder(arena: Instance): Folder | undefined {
    return findFolder(arena, ARENA_CONFIG.LOBBY_SPAWNS_FOLDER);
}

/**
 * The direct `BasePart` children of `folder`.
 *
 * **The one place "what counts as a spawn" is decided for the lobby**, shared by the search that picks
 * one and the sentence that explains an empty result — the same split `teamSpawnParts` makes for a
 * side's spawns, and for the same reason: two callers disagree about what emptiness *means*, and
 * neither of them should disagree about what emptiness *is*.
 *
 * Only **direct** children, deliberately: a `Model` full of parts is not a spawn and is skipped rather
 * than searched, so "is this a spawn?" stays a question about one folder's children.
 */
function basePartsIn(folder: Folder): BasePart[] {
    const parts: BasePart[] = [];

    for (const child of folder.GetChildren()) {
        if (child.IsA("BasePart")) parts.push(child);
    }

    return parts;
}

/**
 * The `BasePart` children of `arena`'s spawn folder for `team`.
 *
 * **One traversal, two callers that disagree about what emptiness means** — the round boundary
 * skips the round, the spawn picker throws — so "what counts as a spawn" is decided once and the
 * argument is about policy rather than about the place file. It answers with a list rather than a
 * reason for exactly that reason; {@link arenaProblem} is what turns the list back into words.
 *
 * **The folders are searched for; the shape they must have is a contract.** `ArenaSpawns` with an `A`
 * and a `B` inside it is part of what a playable arena *is*: the names are shared config
 * (`ARENA_CONFIG`), the round has nothing to teleport to without them, and {@link arenaProblem} names
 * the missing one rather than failing mysteriously. The *requirement* is therefore structural and
 * does not bend — while the *location* is searched. Keeping those two apart is the point: the
 * structure is an interface, the path is an accident.
 *
 * Only **direct** `BasePart` children of the team's folder count. A `Model` full of parts is not a
 * spawn and is skipped rather than searched, which keeps "is this a spawn?" a question about one
 * folder's children — deliberately, and it is the one place in this file where a level is meant
 * rather than assumed.
 */
function teamSpawnParts(arena: Instance, team: TeamLabel): BasePart[] {
    const folder = spawnFolderFor(arena, team);
    if (folder === undefined) return [];

    const parts: BasePart[] = [];

    for (const child of folder.GetChildren()) {
        if (child.IsA("BasePart")) parts.push(child);
    }

    return parts;
}

/**
 * The arena a round is played in: the permanent `Model` in `Workspace`, or nothing if there is not one.
 *
 * **One place for the lookup, and everything else in this file is handed the answer.** The round
 * boundary, the spawn pickers and the lobby all want the same instance, and the version before this
 * asked `MapService` for "the current map" at four separate points — which was the right shape while
 * a map was loaded per round and that service was the only thing holding one, and is the wrong shape
 * now that the arena is simply part of the place file.
 *
 * **A `Model`, because that is what an arena is and what the name promises.** The arenas are replaced
 * wholesale rather than edited, so the class is part of the question: a `Folder` wearing the name is
 * read as no arena at all, and the sentence the round prints names the class rather than leaving
 * somebody to work out why a thing that exists cannot be found.
 *
 * **A direct child of `Workspace`, and the only lookup here that pins a location.** Everything else
 * searches a subtree because what it wants may be nested anywhere inside something else; the arena is
 * at the root of the world, and `ARENA_CONFIG.ARENA_NAME` says why that is worth stating rather than
 * searching for.
 */
function findArena(): Model | undefined {
    const found = Workspace.FindFirstChild(ARENA_CONFIG.ARENA_NAME);
    if (found === undefined) return undefined;
    if (!found.IsA("Model")) return undefined;

    return found;
}

/**
 * Why `arena` cannot host a round, or `undefined` if it can.
 *
 * **A sentence rather than a boolean**, because this is read by somebody looking at a place file
 * rather than by code: the string names the folder that is missing or empty, which is the one
 * thing they need to know, and the same string serves the output line and the error.
 *
 * Takes `Model | undefined` rather than a `Model`, so that "there is no arena" — a place whose
 * `ARENA_CONFIG.ARENA_NAME` has been renamed, deleted, or is not a `Model` — is one of the ordinary
 * answers rather than something every caller has to check first.
 *
 * **Both sides are checked, not just a named one.** A round needs both, so an arena missing either
 * cannot host a round whatever the caller was about to do with the other, and an arena that is half
 * built should be reported as such the first time it is tried rather than at the second team's
 * teleport.
 */
function arenaProblem(arena: Model | undefined): string | undefined {
    if (arena === undefined) return `no Model named "${ARENA_CONFIG.ARENA_NAME}" in Workspace`;

    for (const team of TEAM_LABELS) {
        if (teamSpawnParts(arena, team).size() > 0) continue;

        // **The names rather than a path.** The folders are searched for anywhere inside the arena, so
        // printing `ArenaV2.ArenaSpawns.A` would assert a location the lookup no longer requires —
        // which is the mistake this rule exists to prevent, in miniature.
        return `"${ARENA_CONFIG.ARENA_SPAWNS_FOLDER}/${teamFolderName(team)}" is missing from ${arena.Name}, or has no BasePart children`;
    }

    return undefined;
}

/**
 * Every model that could be holding a ball when a round ends: the players in the server, and the
 * NPC rigs still standing in the world.
 *
 * **Rigs are found by tag rather than by searching `Workspace`.** `RespawnBehavior` tags every rig it
 * builds with `NPC_TAG`, so asking the collection answers "is this an NPC?" without this file having
 * to know how a rig is shaped, what it is named, or where `NpcService` decided to put it.
 *
 * **`IsDescendantOf(Workspace)` is the filter that makes it safe**, and it is the same condition the
 * part-side readers get from `taggedPartsInWorkspace` — this one stays a raw read because it wants
 * rigs rather than parts. A tagged rig that is
 * not in the world is one in the middle of being rebuilt — a respawn kills the old model before it
 * builds the new one — and a model outside the world is holding nothing that a round should reach for.
 * The `IsA("Model")` test is there for the tag's sake rather than the code's: a tag is a string that
 * anybody can put on anything, and this walks what it finds.
 *
 * A player's character can be missing outright — between a death and a respawn, or as somebody is
 * leaving — which is why it is read rather than assumed.
 */
function roundParticipants(): Model[] {
    const participants: Model[] = [];

    for (const player of Players.GetPlayers()) {
        const character = player.Character;
        if (character) participants.push(character);
    }

    for (const npc of CollectionService.GetTagged(NPC_TAG)) {
        if (npc.IsA("Model") && npc.IsDescendantOf(Workspace)) participants.push(npc);
    }

    return participants;
}