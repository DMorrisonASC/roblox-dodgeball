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
import { events, HitDirection, RoundResultRow } from "shared/networking";
import {
    PRACTICE_ZONE_ATTRIBUTE,
    ROUND_MODE_ATTRIBUTE,
    ROUND_STATE_ATTRIBUTE,
    ROUND_TIME_ATTRIBUTE,
    ROUND_TRANSITION_ATTRIBUTE,
    ROUND_WINNER_ATTRIBUTE,
    TEAM_ATTRIBUTE,
    THROWER_TOKEN,
} from "shared/constants";
// A second import from the same module rather than folding these into the block above, which is what the
// next tidy-up should do: the block is long and alphabetically grouped, and adding two names to it means
// re-reading it to find the right slot. Flagged rather than left silent.
import { ROUND_SCORE_A_ATTRIBUTE, ROUND_SCORE_B_ATTRIBUTE } from "shared/constants";
import { MATCH_JOIN_POLL_SECONDS, MATCH_MIN_PLAYERS } from "../../config/match.config";
import { DevService } from "../../dev/DevService";
import { NPC_TAG } from "../../npc/Behavior";
import { lobbySpawnPartsFor } from "../../npc/lobbySpawns";
import { rigCounts, rigsOnASide, sideOfRig } from "../../npc/rigs";
import { playSpawnPoof } from "../../vfx/spawnPoof";
import { applyBarrierGroups } from "../../collision/CollisionGroups";
import { RespawnService } from "../character/RespawnService";
import { shieldCharacter } from "../character/SpawnShield";
import { BallService } from "../ball/BallService";
import { FreezeService } from "../actions/FreezeService";
import { WalkSpeedService } from "../character/WalkSpeedService";
import { NpcService } from "../npc/NpcService";
import { MatchService } from "../match/MatchService";
import { StatsService } from "../stats/StatsService";
import { EconomyService } from "../economy/EconomyService";
import { SuperService } from "../super/SuperService";
import { GameMode, RoundParticipant, RoundView } from "./modes/GameMode";
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
 * How long after a landed hit a death is still attributed to it, in seconds. **Placeholder — 0.5.**
 *
 * **Sized against a chain that is ordinarily zero frames apart.** `registerHit` runs immediately before
 * `landHit`, whose `TakeDamage` is what fires `Died` — so the real gap is under a millisecond and this number
 * only decides how much slack the engine's own delivery of `Died` gets. It must be short enough that a later
 * death cannot be credited to a hit aimed at somebody else; the victim compare in {@link announceWipe} is the
 * primary guard for that, and this is the second.
 */
const WIPE_ATTRIBUTION_SECONDS = 0.5;

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
 * How many entries the round's hit log keeps. **Placeholder.**
 *
 * Five is a number nobody has asked for yet, and it is deliberately a named constant rather than a
 * literal inside the trim so that the first reader with an opinion — the HUD that does not exist yet —
 * can move one line rather than edit a method. There is no measured reason for five over four or eight.
 *
 * **The cap counts *entries*, and an entry is one landed hit.** So the log holds the last five hits of
 * the round, oldest dropping off the back — not "the last few minutes", and not five per player.
 */
const HIT_LOG_CAP = 5;

/**
 * **`HitDirection` was declared here and now lives in `shared/networking.ts`**, immediately above the
 * `roundHit` event that carries it — the home and the argument `RoundResultRow` already had. The two
 * names it holds are a shared vocabulary rather than a server-side detail now that a client reads one
 * and paints two colours from it, and the reason it is a *value on the wire* at all is written there.
 */

/**
 * One landed hit, as the round that counted it knows it: **who landed it, who took it, and which way
 * it went.**
 *
 * **Both ends are `Player`s, and that is the filter.** A thrower token that resolves to nobody — a
 * rig's GUID — names no person, so a rig is on neither end of an entry, and a thrower with no side has
 * no direction to give. See {@link RoundService.logHit}, which is the one place either rule is applied.
 *
 * **`Player` references rather than names**, unlike `RoundResultRow`, and the difference is the
 * lifetime: that row travels to a client after the roster is gone, so it has to be self-contained;
 * this log never leaves the server and the people in it are still connected while the round is being
 * read. A name here would be a copy of something `Players` will answer for as long as the entry can
 * be read. **The names a client sees are written at the send**, in {@link RoundService.logHit}, which
 * is the one place the entry is turned into something that can travel.
 *
 * **The entry is the record; the `roundHit` event is the same fact told to the two people in it.** Both
 * are written from `logHit`, so neither can happen without the other. **The HUD does not read this log**,
 * and that is worth knowing before anyone tries to make it: the cap above is a window over *the round's*
 * last five hits, and "the last five players **I** hit" is not a slice of that — in a busy round a
 * player's own entries are pushed out by other people's within a hit or two. So the display keeps its own
 * per-player windows from the event stream, and this list stays what it was asked to be: the round's
 * record of who hit whom. See {@link RoundService.hitLog} for the reader.
 */
export interface RoundHitEntry {
    readonly hitter: Player;
    readonly victim: Player;
    readonly direction: HitDirection;
}

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
     * the `RoundView` interface, so a private field would have to be copied out per call.
     *
     * **Cleared as a round ends, and published on the spot** — see `finishRound`, which has the argument
     * for why the clear left the round boundary. The boundary clears it as well, for a round that is
     * discarded rather than finished; the two are reached by different events and the second is the
     * guarantee.
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
     * Who hit whom in the round that is running, newest first, capped at {@link HIT_LOG_CAP}. **The
     * pair, which nothing in this project recorded before this field.**
     *
     * **It is a third shape beside the two maps above rather than a fourth use of them, and that is the
     * point of it.** `roundHits` counts a thrower's landings and `roundOuts` counts a victim's
     * eliminations — two counts, each about one person, and neither can say *who* the other end was. A
     * hit is a *pair*, and a pair is not a number that two one-sided maps can be read back into: from
     * `roundHits` you know A landed three and B landed one, and nothing about which of A's three landed
     * on whom. So this is its own list rather than a field added to either map.
     *
     * **An array rather than a map keyed by player**, because the log is a sequence — "newest first" is
     * the whole of what makes it readable as a feed — and the cap is a window over that sequence. A map
     * per player would need a second ordering to answer the same question and a second cap to trim it.
     *
     * **Its lifetime is `roundHits`', and by the same means**: cleared where the scoreboard and the two
     * boards are cleared, at the *opening* of a round rather than at the end of one, so the log is still
     * readable for the whole intermission that follows. See the clearing in `gameLoop`, which is the only
     * place it happens.
     *
     * **Written from `registerHit`, which is the one door a hit comes through** — so the log has exactly
     * the population `roundHits` has, by construction rather than by a second detection of the same
     * event. See {@link logHit} for the two conditions an entry has to meet to be written.
     */
    private readonly roundHitLog = new Array<RoundHitEntry>();

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
     * The roster revision this round has already admitted, so the join watch walks the roster only on the
     * turns where something changed.
     *
     * **`-1` rather than the figure at the whistle, and that is a decision rather than a default.** The
     * watch starts *after* `assignTeams` has run, so a player who opts in during the transition — after the
     * whistle and before the watch's first turn — is a roster member the round-start loop never saw. An
     * initial value of "whatever the revision is now" would treat that join as already handled and leave
     * them standing in the lobby as a spectator holding a seat. `-1` makes the watch's first turn look at
     * the roster, and `teams` is what tells it who is already in. See `watchMidRoundJoins`.
     */
    private admittedRevision = -1;

    /**
     * The players whose admission into this round is **in flight** — covered, and about to be placed.
     *
     * **A set rather than one more tick of state on the player, and the cover is why it has to exist.** An
     * admission now waits `TRANSITION_COVER_SECONDS` for that player's own grid to close before the body is
     * moved, and the loop that admits keeps running: another player opting in during that wait bumps the
     * roster revision, `admitMidRoundJoins` walks the roster again, and the player still standing under a
     * cover has **no `TEAM_ATTRIBUTE` yet** — so `teams.has(player)` says "not admitted" and they would be
     * covered, moved and printed a second time. This is the record that says "already on their way in".
     *
     * Cleared the moment the admission lands or fails, so it never outlives the second it describes.
     */
    private readonly admitting = new Set<Player>();

    /**
     * The mode a match is waiting to open on.
     *
     * **The request and the flag are one field on purpose.** "Has a match been asked for" and "which mode
     * was it asked for" are the same question here: the intermission waits on this being set, and the round
     * boundary consumes it. A separate `pending: boolean` beside it would be a second answer that could
     * disagree with the mode sitting next to it.
     *
     * **Two things set it, through the one method that does.** The intermission's clock sets it when it runs
     * out with a roster that can play — see the loop in this file — which is how a match normally
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

    /**
     * **The last hit this round heard about, and the body it landed on** — the join between a death and the
     * throw that caused it.
     *
     * **One record, not a log**, because only the most recent hit can be the cause of the death being handled
     * right now: `Died` fires out of the `TakeDamage` that `landHit` runs immediately after `registerHit`, and
     * a second hit cannot land between the two. A list would be a history nothing asks for, and the thing that
     * makes a stale entry harmless is the victim compare in {@link announceWipe} rather than the list's length.
     *
     * **Written only while a round is being played**, which is where it is read: `announceWipe` runs from
     * `eliminate`, and a lobby hit cannot eliminate anybody. It is not cleared at a boundary — the next hit of
     * the next round overwrites it, and a record older than {@link WIPE_ATTRIBUTION_SECONDS} is refused.
     *
     * **`victim` is an `Instance` rather than a `Model`**, because it is only ever compared by identity and the
     * thing it is compared against is a `Player` — two Roblox type declarations share no members but the base
     * class, and typing it as `Model` made the comparison a type error that said nothing useful.
     */
    private lastHit?: { readonly thrower: Player; readonly victim: Instance; readonly at: number };

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
        private readonly npcs: NpcService,
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
     * **The only thing that sets {@link pendingMatch}, and it has two callers.** The intermission's clock is
     * the normal one — it asks for the match the moment it reaches zero with a roster that can play — and
     * {@link requestMatch} is the manual override behind a dev's `!dev match`.
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
            const rigs = rigCounts();

            print(
                `[Round] ${player.Name} asked for a match — refused, needs ${MATCH_MIN_PLAYERS} bodies` +
                    ` with one a side (players A ${counts.a}, B ${counts.b}; rigs A ${rigs.a}, B ${rigs.b})`,
            );

            return;
        }

        this.startMatch(SCORE_RUSH);
    }

    // ---- Internals ----

    // ---- The round, as a mode is allowed to see it (`RoundView`) ----

    /**
     * The round's **players**, and only them — the narrower query.
     *
     * The one place that knows who is playing *among people* is `activePlayers`, and a caller that
     * means "a person" reads it through this rather than being handed the set itself — a caller able
     * to `delete` from it would be able to eliminate somebody, and that is a decision for the round.
     *
     * **It stopped being what a mode reads when rigs became participants**, which is why it is still
     * here and no longer on `RoundView`. Both readers left are about a *character*: holding bodies
     * still on the arena's opening beat, and {@link teleportTeamsToArena}, which pairs each player with
     * the body they walk around in. A rig has neither, so widening this one would have made both of
     * them narrow on every line; a second accessor costs one method and keeps the distinction visible
     * at the place it is made. See {@link participantsInRound} for what a mode reads.
     *
     * Built fresh on each read rather than kept in step beside the set: the readers are one loop at a
     * round boundary and one at a spawn, and a second collection maintained in parallel would be a
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

    /**
     * Everyone in the round: **the players, and the rigs standing on a side.**
     *
     * **This is the participant accessor a mode reads**, and it is assembled from facts that already
     * exist rather than from a collection of its own. The players are `activePlayers`, which
     * `assignTeams` fills at the opening whistle. The rigs are *derived* — see {@link rigsInRound} —
     * and deriving them is what keeps this honest: there is no second set to fall out of step with the
     * attribute that says which side a rig is on, so a rig cannot be in the round and side-less, or
     * side-less and counted.
     *
     * **What this is not:** not the roster the *server* is judged by, and not a list to act on
     * blindly. `rosterOutcome` asks a different question of the same bodies — whether a side still has
     * anybody *here* — and a caller that wants to move somebody or read a statistic wants one of the
     * two narrower queries rather than this one. See `RoundParticipant` for why the union is named
     * instead of spelled out at each signature.
     */
    public participantsInRound(): ReadonlyArray<RoundParticipant> {
        const participants: RoundParticipant[] = [];

        for (const player of this.activePlayers) participants.push(player);
        for (const rig of this.rigsInRound()) participants.push(rig);

        return participants;
    }

    /**
     * The rigs in this round: **every `NPC`-tagged model in the world that is standing on a side.**
     *
     * **The side is the whole of the opt-in, and it is an attribute rather than a set.** A player
     * walks into a join part and `MatchService` writes them down; a rig has no join part to walk into,
     * so what it has instead is the same `TEAM_ATTRIBUTE` the round already publishes for players,
     * painted on the rig in Studio. That is what gives this change the property it wants most: **a rig
     * with no `Team` attribute is untouched by any of it** — the practice dummies, the rigs
     * `NpcService.spawn` makes, and every rig in every place file nobody has told which side it is on —
     * so nothing about the game as it stands changes until a side is painted on a rig.
     *
     * **Derived per read rather than snapshotted at the opening whistle, and the cost is named.** The two
     * kinds of participant become participants by different routes: a rig counts from the tick its side is
     * painted — whoever paints the attribute *is* the opt-in, and there is nothing to refuse — while a
     * player comes through `MatchService`'s roster and then this file's own admission, which is the round
     * start for anybody who chose before the whistle and `admitMidRoundJoins` for anybody who chose after
     * it. **This used to say a player who arrives mid-round is not in the round at all**, on the grounds
     * that `optIn` refused to add anybody to a side while the phase was `Playing`: that lock is gone — the
     * pads are live during a round — and what survives of it is the refusal to *cross* sides mid-round.
     *
     * **The list itself comes from `rigsOnASide`, the one place the tag, the world and the side tests
     * are written.** This used to walk `NPC_TAG` here and test each rig against `TEAM_ATTRIBUTE`; that
     * walk moved out to `npc/rigs.ts` the moment `MatchService.canStart` needed the same list during an
     * intermission, where this method's own `Playing` gate would answer "nobody". What stays here is the
     * gate rather than the walk: the `Playing` gate is the rule `isFriendlyFire` states about a side —
     * **between rounds a side means nothing** — so there is nobody here to be in a round.
     *
     * **A rig that is down is still in the round.** Its death is `RespawnBehavior`'s, which brings the
     * body back, so a knocked-down rig holds its side's seat exactly as a Score Rush player does between
     * a death and their respawn, and a side whose only participant is a rig that has just been hit is a
     * side that has not lost. That is the same reading `rosterOutcome` takes of a player, and it is why
     * nothing here watches for a rig's death — there is nothing for the round to decide about it.
     */
    private rigsInRound(): ReadonlyArray<Model> {
        if (this.state !== RoundState.Playing) return [];

        const rigs: Model[] = [];

        for (const { rig } of rigsOnASide()) rigs.push(rig);

        return rigs;
    }

    /**
     * Which side a participant is on, or nothing if they are not in this round.
     *
     * **Two stores behind one question, and that is the honest shape of it.** A player's side is in
     * `teams`, the round's own table — the one `assignTeams` fills and `rosterOutcome` counts, kept
     * because it outlives a player leaving the server. A rig's side is only ever the attribute: there
     * is no roster entry for a body `MatchService` has never heard of, and inventing a second table
     * here would be the parallel collection this design spends its effort avoiding.
     *
     * **And a *character* answers with its player's side, which is a widening of this answer rather than a
     * second rule in it.** Everything the round asks this about arrives as a *model* — the victim of a
     * thrown ball, the catcher of one, whoever the ball touched — and the side of a character model is
     * not on the model: `assignTeams` writes `TEAM_ATTRIBUTE` on the `Player`, because the roster is
     * player-keyed and a character is replaced on every death. So a resolver that understood only a
     * `Player` and a rig could not answer the question the hit path asks most often, and the hit path's
     * own answer used to be `undefined` for *everybody* — which is why a rig's throw and a rig's body
     * were both outside the round's records entirely. See `registerHit`.
     */
    public teamOf(participant: RoundParticipant): TeamLabel | undefined {
        if (participant.IsA("Player")) return this.teams.get(participant);

        const player = Players.GetPlayerFromCharacter(participant);
        if (player !== undefined) return this.teams.get(player);

        return sideOfRig(participant);
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
     * counts its *players* from, and the attribute that publishes a side to everything outside this
     * service. The roster says who is playing and which side they are on; the round is what makes that
     * true.
     *
     * **Rigs are not assigned here, and their absence is the design rather than a gap.** There is no
     * roster entry for a rig to be read out of and no map to fill from one: a rig's side is painted on
     * the rig in the place file, so the opening whistle has nothing to write for it. So this method is
     * not what puts a rig in the round — {@link rigsInRound} derives that from the attribute on every
     * read — and the table below stays a table *about people*, which is what lets `MatchService`, the
     * economy and the result board go on reading it as one. See {@link participantsInRound} for the
     * list that holds both kinds of body.
     *
     * **And a player in a practice zone is skipped in the loop itself**, for the opposite reason from a
     * rig: they *do* have a roster entry, but they are unavailable, so the entry is read and refused.
     * The two skips together are the whole rule — the round's sides are the players who opted in and are
     * still available, and the rigs somebody painted a side on. Everyone else is watching.
     */
    private assignTeams(): void {
        this.teams.clear();

        // **`TEAM_ATTRIBUTE` is published from scratch, because it is the client's only view of "am I in
        // this round".** It was written at each whistle and cleared *nowhere*, so a player who played the
        // last round and did not re-opt in kept the side they had until they left the game, and every client
        // that reads the attribute (the round wipe's gate, the shift lock, the freeze countdown) went on
        // treating them as a participant for the whole of the intermission and into the next round. Clearing
        // first means the attribute says "on a side" rather than "was on a side once", which is the fact those
        // three readers need and the only per-player fact the server publishes.
        //
        // **It is also the cheaper half of the alternative.** `panels.ts` records that a client-side "am I in
        // the round" predicate was refused once, because the honest answer was `activePlayers` and
        // re-publishing it would have been inventing state; that reasoning holds and this invents nothing —
        // the attribute already exists, is already replicated, and is already read by one of the three
        // readers. What was missing was the clear.
        //
        // **Nothing observable is lost by clearing here rather than writing per frontier.** This runs before
        // the phase is published and before the transition is announced, so no frame passes in which a
        // participant reads `Playing` with no side; and a player who is *not* in the roster this round has no
        // side to lose, which is the whole point.
        for (const player of Players.GetPlayers()) {
            player.SetAttribute(TEAM_ATTRIBUTE, undefined);
        }

        const assigned = this.matches.roster();

        for (const [player, team] of assigned) {
            // **A player standing in a practice zone is not put on a side**, even if they are still on
            // the roster: they opted in before walking into the zone, or the zone swallowed them since,
            // and the whole of "undisturbed" is that this method does not make them play. Leaving them
            // out here is what keeps them out of `activePlayers` and therefore off the teleport, the
            // freeze and the outcome — the same skip `MatchService.canStart` makes on the same attribute,
            // which is how the two halves of "who plays" stay in agreement.
            if (this.isPracticePlayer(player)) continue;

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
     * **Watches the roster while a round is being played, which is what makes a pad live during one.**
     *
     * **A poll, because the roster's owner cannot call the round.** `MatchService` reads the phase out of
     * the status folder precisely so that this file can read *it* without a constructor cycle, and the
     * cost of that arrangement is that a fact about the roster can only be noticed here. It is the same
     * arrangement `LobbyRigService` uses for its seats, for the same reason, and the revision is the same
     * number: one read a turn, and the roster walked only on the turns where it moved.
     *
     * **Started after the round's own admission of the roster and stopped by the phase.** The round body
     * spawns this once per round — see `gameLoop` — and the loop ends when `this.state` leaves `Playing`,
     * which is the line entering an intermission writes. A join during an intermission is not this
     * method's business at all: `assignTeams` takes the whole roster at the next whistle, so the only
     * window this exists for is the one where a round is already under way.
     *
     * **Why a player can be in the roster and not in the round at all, stated because it is the thing
     * being repaired.** `assignTeams` gates on the phase: a player whose opt-in lands while a round is
     * being played is written to the roster and to *nothing else* — not to `teams`, not to
     * `activePlayers` — because the boundary that fills both has already passed. Before this watch the
     * result was a player holding a seat, standing in the lobby, invisible to the round and with no rig
     * left to fill the seat they were holding: the pad refused them, and the seat arithmetic had already
     * stood a placeholder down for them.
     */
    private async watchMidRoundJoins(): Promise<void> {
        while (this.state === RoundState.Playing) {
            task.wait(MATCH_JOIN_POLL_SECONDS);

            this.admitMidRoundJoins();
        }
    }

    /**
     * **Everyone in the roster who is not in this round yet is put in it, on the side they chose.**
     *
     * **All three of the round's own answers, in the order the round-start loop makes them.** `setTeam`
     * writes the side to the table the round counts from *and* to the player, so every reader of a side —
     * `teamOf`, the outlines, the signs — agrees within the same frame; `activePlayers.add` is what
     * membership means everywhere else in this file; `resetForRound` gives them the same clean streak the
     * other participants got at the whistle, since a run of hits belongs to a round.
     *
     * **And no crown call at the end, unlike the round start.** `setTeam` recomputes the crowns itself,
     * because a side change is what a crown is compared across; `assignTeams` has to do it separately only
     * because that loop writes `teams` directly rather than going through this method. Reaching for a second
     * refresh here would be a call that does nothing, five hundred times a second.
     *
     * **The body is moved and shielded, and the shield is the half that is not obvious.** They are put on
     * their side's *arena spawn* — `arenaSpawnFor`, the same call the opening teleport and a respawn both
     * make — while a thrown ball may already be in the air and every rig on the field is live. A body
     * placed into a round in progress with no protection is a body that can be hit before it has seen the
     * arena, so it gets the same `ForceField` a respawn gets. See `SpawnShield`, whose other caller is the
     * `CharacterAdded` connection — the case a *new* body is the thing being protected.
     *
     * **A player with no body yet is still admitted**, and that is deliberate rather than a gap: they go
     * into `teams` and `activePlayers` now, so the `CharacterAdded` handler that places a round player at
     * their side's spawn — see `handlePlayerJoined` — puts their body in the arena when it arrives
     * instead of in the lobby. The alternative, waiting for a body, would leave a dead player's seat
     * unfilled for as long as their respawn took.
     *
     * **A practice-zone player is skipped**, and the skip is the same one the round start makes for the
     * same reason: entering a zone is a statement that you are not playing, and `assignTeams` does not put
     * such a player on a side even when the roster holds one. What that costs is stated: they keep the
     * roster seat — the lobby's rig count still accounts for them, which is right, because they are a
     * person in the server — and they stay out of the round until the next one, because nothing re-reads
     * the zone once they leave it.
     *
     * **Nothing is done to the *seat*, and that is `LobbyRigService`'s half.** Their arriving in the
     * roster is the change that service polls for, so the rig that was holding their side's seat stands
     * down within its own quarter of a second, in the arena, and the side is left with the same number of
     * bodies it had. Two polls, two services, and neither has to know the other exists.
     */
    private admitMidRoundJoins(): void {
        // **A round that has been decided is not one to join.** `finishRound` sets this before the loop
        // exits, and the intermission that follows teleports everybody to the lobby: admitting somebody in
        // the ticks between the two would put them in the arena only to be swept out of it.
        if (this.finished) return;

        const revision = this.matches.rosterRevision();
        if (revision === this.admittedRevision) return;

        this.admittedRevision = revision;

        for (const [player, side] of this.matches.roster()) {
            if (this.teams.has(player)) continue;
            if (this.admitting.has(player)) continue;
            if (this.isPracticePlayer(player)) continue;

            // **Recorded before the spawn, because the cover is a wait and this loop is not.** For the length
            // of that wait the player has no side, so `teams` cannot answer "already on their way in" — see
            // the field. Everything else about the admission lives in `admitWithCover`.
            this.admitting.add(player);

            // **Spawned rather than awaited, so one player's cover does not hold the whole round.** This runs
            // inside the round's own loop, and awaiting the cover here would stop the countdown, everybody's
            // scoring and every other admission for the length of one grid.
            task.spawn(() => this.admitWithCover(player, side));
        }
    }

    /**
     * **Admits one player into a round already under way, behind a wipe of their own.**
     *
     * **The cover goes up before the side is written, which is the opposite order to the round-start one and
     * deliberately so.** At a whistle the roster is admitted and then moved together under one cover; here
     * there is one player and one cover, and until it closes they are still a spectator. Writing the side
     * first would make them a *participant standing in the lobby* for the length of the grid — counted by
     * `rosterOutcome`, targetable by every rig's enemy scan, and hittable by a ball thrown out of the arena —
     * which is the same fault `moveWalkersToArena` exists to prevent for a rig.
     *
     * **The cue is that player's own attribute**, through {@link bumpTransition}, so nobody else's screen
     * moves: an opt-in is one person's cut, and every other player is mid-round and looking at a court that is
     * not changing. The round's clock is not held either — `transitionAround` holds it because a *boundary*
     * must not start counting behind a cover, and there is no boundary here.
     *
     * **Checked again after the cover rather than only before it.** A cover is long enough for the player to
     * leave the server, for the round to be decided (`finishRound` sets `finished`, and the intermission behind
     * it sweeps everybody to the lobby), or for the same player to have been admitted by another route. Each of
     * those ends the admission without writing anything.
     */
    private async admitWithCover(player: Player, side: TeamLabel): Promise<void> {
        if (TRANSITION_CONFIG.ENABLED) {
            this.bumpTransition(player);

            task.wait(TRANSITION_COVER_SECONDS);
        }

        // **The in-flight record goes first**, so no guard below can leave a player who can never be admitted
        // again this round.
        this.admitting.delete(player);

        if (player.Parent === undefined) return;
        if (this.finished) return;
        if (this.teams.has(player)) return;

        this.abilities.resetForRound(player);
        this.setTeam(player, side);
        this.activePlayers.add(player);

        const character = player.Character;

        if (character) {
            character.PivotTo(this.arenaSpawnFor(character));
            shieldCharacter(character);
        }

        // **Said out loud, because this is a round changing its own sides mid-play.** The mode's outcome
        // counting, the rigs' targeting and the scoreboard all read the side this writes, so a line naming who
        // arrived and where is the only trace of why the counts moved. It now lands *after* the cover rather
        // than instantly, which is the second thing it records: the gap between this line's timestamp and the
        // wipe's is how a reader tells a covered admission from an uncovered one.
        print(
            `[Round] ${player.Name}: joined mid-round — side ${side}, ` +
                `${character ? "on the arena spawn" : "their body lands on that side's spawn when it arrives"}`,
        );
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
     * Who has won, judged only by **who is still here on a side**.
     *
     * **Counted from `Players` and the rigs, not from `activePlayers`, and that distinction is the
     * entire point.** A mode counts who is still *in the round*: somebody eliminated in Team Elimination
     * is out of the round while being very much still in the game, and somebody who died in Score Rush is
     * out of it for a moment and then back. Neither of those should end anything, and neither does — they
     * are still in `Players`, so they still count for their side here.
     *
     * A player who has **left** is a different fact, and one only the server knows. They are gone from
     * `teams` the moment `PlayerRemoving` fires, so this counts them out on that same tick — which is
     * what makes a departure end a round immediately rather than at the next countdown tick, and what
     * makes it end even while a dev has rounds frozen. Leaving is not pausable.
     *
     * **A rig counts here, and this is what "the round is its participants" means from this side.** A
     * rig never connects and never leaves, so the question asked of one is the same question asked of a
     * player in a different form: *is this side's seat still occupied?* A rig standing on A is a body on
     * A that can throw, be hit and be knocked down, so a round whose sides are two sets of rigs has two
     * occupied sides — which is the whole of why it is played rather than drawn. Before this loop the
     * count saw no players at all and answered `DRAW` on the round's first tick, about six seconds in,
     * from behind the opening freeze. See {@link rigsInRound} for what counts as a rig in the round, and
     * note that a rig that is *down* still counts: `RespawnBehavior` brings the body back on a short
     * clock, which is the same shape a Score Rush player's death has.
     *
     * **One side empty is a win for the other, and a rig only makes that rule stricter.** A place file
     * that paints a side on rigs of one team and not the other is an arena with an empty side, so the
     * round is handed to the occupied one on its first tick — the same answer a team that has all left
     * gets, by the same three lines. Worth knowing before testing: rigs on both sides or the round ends
     * before anybody has thrown anything.
     *
     * **Both sides empty is a draw.** The case where nobody is left on either side: it is the honest
     * answer, and it is also what stops an empty server sitting inside a round for ever — the same
     * reason every mode answers that case the same way.
     *
     * **A mid-round joiner counts, and can rescue a side — which is a reversal.** Team assignment happens at
     * the opening whistle, so this used to be where a player who arrived mid-round was counted out: they
     * were not in `teams` at all, and were watching rather than playing. They are admitted now, by
     * `admitMidRoundJoins` — so a player who walks onto a pad during a round is a body on that side from the
     * next count, and **their arrival can keep a side that is about to empty in the round**. That is the
     * point of joining a live round rather than an accident of it: the side they chose is their side, and
     * this count is the only place a side's fate is decided. A rig was already counted on the tick its side
     * was painted — see {@link rigsInRound} — so the two kinds of body now arrive the same way, within a
     * second of saying so.
     */
    private rosterOutcome(): RoundOutcome | undefined {
        // **Named for what both kinds of body share, which is being *here*.** A player is here while they
        // are still connected; a rig is here while it is standing in the world on a side. "Connected"
        // would be a word about players only, and this count is not only about players any more.
        let presentA = 0;
        let presentB = 0;

        for (const player of Players.GetPlayers()) {
            const team = this.teams.get(player);

            if (team === TEAM_A) presentA++;
            else if (team === TEAM_B) presentB++;
        }

        for (const rig of this.rigsInRound()) {
            const team = this.teamOf(rig);

            if (team === TEAM_A) presentA++;
            else if (team === TEAM_B) presentB++;
        }

        if (presentA === 0 && presentB === 0) return DRAW;
        if (presentA === 0) return TEAM_B;
        if (presentB === 0) return TEAM_A;

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

        // **And the lifetime figures are written now, because this is the instant they stop moving.** A
        // hit and an out are only counted while the phase is `Playing`, so a round end is the boundary a
        // record can be saved at — until this line existed the store heard about a round only when the
        // player left or three minutes went by, and a server that crashed in between lost it.
        //
        // **No roster is passed, and that is not an oversight.** `playersInRound()` is `activePlayers`, and
        // `eliminate` removes from that set *during* the round — so the list at this point is missing exactly
        // the players whose `outs` went up. The stats service sweeps every record it holds and skips the
        // unchanged ones; see `StatsService.onRoundEnded`.
        //
        // Spawned inside that call rather than awaited, so the intermission below opens on the beat it would
        // have opened on without this.
        this.stats.onRoundEnded();

        // **The scoreboard is wiped as the round ends, and that moved here from the boundary.** It used to be
        // cleared at the *opening of the next round*, on the argument that a round's final score should be
        // readable for the whole intermission that follows — the same lifetime the result panel's rows have.
        // **The client's score bar reads both of those attributes in every phase now, so that argument stopped
        // paying**: what a lingering pair of numbers buys between rounds is a board that says `4 – 2` with no
        // round in progress to have scored it, and what it costs is that the *new* round's board cannot be
        // told from the old one's until somebody scores. Cleared here, the intermission reads `0 – 0` and the
        // numbers on screen are always the current round's — which is what a scoreboard is. **Nothing is lost
        // by it:** the result of a round is the winner's attribute and the result panel, not this pair, and
        // both are written a few lines above this one.
        //
        // **The wipe happens behind the round-end transition cover**, which is why it will not read as a
        // flicker: `TRANSITION_CONFIG.WIPE_AT_ROUND_END` puts the cover up for the whole boundary, and the
        // board underneath is already `0 – 0` by the time it comes down.
        //
        // **The clear at the boundary below stays, and it is not redundant.** This one runs for every round
        // that *finishes*; that one runs for a round that is discarded without finishing — a dev command, a
        // server shut down mid-round — so the next round cannot open onto somebody else's score. The rule is
        // stated twice because the two are reached by different events, and the second one is the guarantee.
        this.scores.clear();
        this.publishScores();

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
     * Whether there are too few *available* bodies for a round to be worth starting.
     *
     * **Counts connected players who are not in a practice zone, and the rigs on a side.** Those are
     * the two kinds of body that could play the next round, and they are the whole of what "minimum"
     * can honestly mean now that a rig holds a seat and a practice zone holds a player out of the game.
     * A player standing in a practice zone is connected but unavailable — they are not teleported, not
     * frozen and not put on a side, so counting them here would let one body hold the intermission open
     * for a round it will never play. A rig is the opposite: never connected, always standing, and on a
     * side exactly when somebody has painted one on it.
     *
     * **Asked of the connected players and the rigs, and not of `activePlayers` — that is not a style
     * choice.** `activePlayers` is who is *in the round*, and it is empty for the whole of an
     * intermission: it is cleared as the intermission opens and filled again when the round does. A
     * check against it would read zero every single time and freeze the intermission for ever, which is
     * the trap this comment exists to stop anybody walking back into.
     *
     * **Only the start of a round is gated by this.** A round that drops below the minimum mid-play
     * runs to its finish — a result that changed because somebody's connection did is not a result,
     * and the round already has its own rules for a side that empties out. A server whose only humans
     * are in a practice zone, and which has no rigs, still freezes — that is the requirement rather
     * than a side effect: there is nobody available to play for.
     */
    private belowMinimum(): boolean {
        const available = this.availablePlayers() + rigsOnASide().size();

        return available < ARENA_CONFIG.MIN_PLAYERS;
    }

    /**
     * How many connected players are **available to play** — everyone who is not standing in a practice
     * zone.
     *
     * **A practice zone is a player opting out, read off the attribute rather than the geometry.**
     * `PracticeZoneService` owns the bounds test and publishes the answer, so this is an attribute read
     * like every other reader's — the same one `BallComponent`, `DodgeService` and `SuperService` each
     * make for their own rule. A *player* is counted rather than a character for the reason the old
     * minimum counted players: a player between bodies is still somebody who could walk out of the zone
     * and play, and a body is not the thing a match is made of.
     */
    private availablePlayers(): number {
        let available = 0;

        for (const player of Players.GetPlayers()) {
            if (this.isPracticePlayer(player)) continue;

            available++;
        }

        return available;
    }

    /**
     * Whether `player` is standing in a practice zone, read from the attribute `PracticeZoneService`
     * publishes.
     *
     * **The one predicate the round's own guards share.** Every place this file would otherwise touch a
     * player on the round's behalf — teleporting them, freezing them, stripping their ball, clearing a
     * streak — asks this first, so "a practice-zone player is undisturbed" is one test rather than a
     * dozen copies of it that can drift apart. It is deliberately a method rather than a module helper,
     * because the answer is only ever wanted where the round acts on a player.
     */
    private isPracticePlayer(player: Player): boolean {
        return player.GetAttribute(PRACTICE_ZONE_ATTRIBUTE) === true;
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
     * 1. Bump {@link ROUND_TRANSITION_ATTRIBUTE} **on every player this boundary covers** — the round's
     *    roster, not everybody in the server — which is each client's cue to close its grid. A counter
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
            // **One bump per player this boundary covers, and the roster is what says who that is.** `teams`
            // is the table `assignTeams` fills at the whistle and `roundOutcome` counts, and nothing clears it
            // until the next `assignTeams` — so at a round's *start* it holds the players just admitted, and
            // at its *end* it still holds the players who played it. **A player who never opted in is in
            // neither**, which is the whole of "a wipe is not for a spectator": they are moved back to the
            // lobby with everybody else and see the cut, and no grid closes over a room they were already
            // watching. See `ROUND_TRANSITION_ATTRIBUTE` for why the cue is per player at all.
            for (const [player] of this.teams) this.bumpTransition(player);

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
     * **Tells one player's client to close its grid, one step before the move they are being covered for.**
     *
     * **The unit is a player rather than a round, and that is the change this exists for.** A boundary covers
     * the round's roster — see `transitionAround`, which loops it — while a player opting into a round already
     * under way is covered *alone*: see {@link admitWithCover}, which is the reason this is a helper rather
     * than two lines inside the boundary. The alternative shape, one counter on the status folder that every
     * client reads, cannot express "this one is yours" without a second attribute saying who the bump was
     * for, and a client comparing its own name against a payload is the same judgement in a worse place.
     *
     * **A counter, and idempotent per change**: a client plays on any change, so a value that repeated would
     * be a wipe that never happens. The read is validated because an attribute is a string or a number
     * anybody may write — `onASide`'s reason, and `sideOfRig`'s.
     */
    private bumpTransition(player: Player): void {
        const current = player.GetAttribute(ROUND_TRANSITION_ATTRIBUTE);

        player.SetAttribute(ROUND_TRANSITION_ATTRIBUTE, (typeIs(current, "number") ? current : 0) + 1);
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
     *
     * **A rig is not held *here*, and the second half of that is a reversal.** This hold is one
     * contribution in a *character's* speed sum, and a rig has no such sum: `WalkSpeedService` is the
     * players' authority for how fast a body may walk, while a rig moves because its own behaviours drive
     * its humanoid. Holding one would mean reaching for the ability's freeze — which anchors a body and
     * draws a block of ice — or writing rigs into the speed service, and both of those are decisions about
     * NPCs rather than about who is in the round. So the loop above stays a loop over people, and this
     * hold is not the place a rig's freeze is kept.
     *
     * **What this doc used to say next was that a rig was free to throw during the beat they are held
     * still, and that is no longer true.** The rig's half of the freeze is kept next door, by the service
     * that owns the rigs: `LobbyRigService.refillAtRoundStart` gives a rig none of its six gameplay
     * behaviours until `ARENA_CONFIG.ARENA_FREEZE_SECONDS` after the move, so a rig has nothing that could
     * walk, pick up, catch, dodge or throw while this hold is on. That is the mechanism a rig needs rather
     * than a second copy of this one — a walk-speed hold would leave the throwing, catching and dashing
     * untouched, which is the whole of what the complaint was about. **The constant below and that delay
     * are one number read twice**, not two durations made to agree: this file's hold and the rigs'
     * withholding both begin at the move and both end at `ARENA_FREEZE_SECONDS`.
     */
    private holdArenaEntry(): void {
        // **The match's players, for the reason the teleport above is theirs.** Everybody present used to be
        // held, which was the same set as the round's players until opting in existed — and now it is not, so
        // holding a player standing in the lobby still for five seconds while they walk about would be this
        // change leaking into a system that has nothing to do with it. The hold is a rule about *arriving* in
        // the arena, and only the players who arrived are held.
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
     * contribution and is left exactly as they are — which is also the right treatment of them, because the
     * hold is measured from a landing they were not present for. **A player who joins during the freeze is
     * admitted by the join watch once this has returned**, not by anything here: `watchMidRoundJoins` is
     * spawned on the line after `transitionAround` for exactly that reason, so the freeze never has to know
     * who was standing there when it started.
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

            // **A practice-zone player is not the round's to place.** Their body arrives wherever the
            // engine spawns it and is left there — neither the arena nor the lobby is where somebody who
            // is practicing belongs, and this handler is the round's own reach into respawning. Skipping
            // the placement is the whole of what "undisturbed" asks of this path; the `Died` connection
            // above still stands, because a practice-zone player who dies still needs a body back, and
            // `handleDeath` loads one without moving it anywhere.
            if (this.isPracticePlayer(player)) return;

            const root = character.WaitForChild("HumanoidRootPart") as BasePart;

            // Route based on whether they're still in the round, and — for a round — on which
            // side they are on. A player who died is out of `activePlayers` by the time this
            // runs, so they land in the lobby like any other player who is not in the round,
            // which is the existing behaviour and not a team's side.
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

        // **A player arriving during a round is not in it, and that is now the whole of what the round
        // does about them.** They are not in `activePlayers`, the round does not wait for them, and the
        // `CharacterAdded` branch above lands them in the lobby — so the fact is already published, in
        // the only place that has ever decided it, and there is nothing here to write down for a HUD.
        //
        // **This used to set `SPECTATING_ATTRIBUTE` for exactly this case**, and removing that is part of
        // the spectator removal rather than a tidy-up: the attribute's only client-side use was to hide
        // the ability readouts and show "You're out — spectating". What a joiner loses with it is being
        // told in words that they are out of the round; what they keep is everything they actually had —
        // a body in the lobby, a round to watch, and a side waiting for them at the next boundary.
        //
        // The crown recomputation below is untouched and is why this method is still the right place for a
        // joiner's bookkeeping.

        // **And the crown is recomputed for a joiner, which is mostly about everybody else.** A player
        // arriving has no count and no side, so they cannot be crowned by this call — what it is really
        // for is the roster they have just joined, and the case it matters for is the one that never
        // reaches this method: a player *leaving*, which `SuperService` handles on its own.
        this.abilities.refreshCrowns();
    }

    /**
     * A character died. What that means is the mode's to say.
     *
     * **A rig does not come here, and the round has one thing to say about that.** A rig's death is
     * `RespawnBehavior`'s: it notices the body go down, waits `NPC_CONFIG.RESPAWN_DELAY_SECONDS` and
     * puts a live copy back where the rig was authored — which is the same shape a player's respawn has,
     * and the reason a rig can be knocked down in a round without the round losing its side's seat. That
     * behaviour is where a rig's death is *handled*, and the round's side of it is the opposite of an
     * action: a rig that is down is still in the round (see {@link rigsInRound}), so there is nothing to
     * record, nothing to eliminate, and no body to hand back to anybody. Written down here rather than
     * left to be discovered, because this is where a reader looks for a rig's death and an absence with
     * no explanation reads exactly like an oversight.
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
        // whether a round was being played when the body died. A dev who opens a MultiBall window in the lobby and then
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

        // **Already out of the round — and this branch stays after the spectator removal, because it is
        // not the spectator mechanism.** Two things lived here and only one of them was spectating:
        //
        // - **The body, which is why the branch cannot simply go.** An eliminated player is a person in
        //   the lobby with a character to walk around in, and this is that load at the moment it is
        //   wanted. Deleting the whole branch would send a second death through the code below, and
        //   neither half of what is down there fits: Score Rush would *schedule* the load through
        //   `respawns.schedule` with the round's `RESPAWN_DELAY_SECONDS`, a three-second wait for
        //   somebody who is watching rather than playing, and Team Elimination would call `eliminate`
        //   again and record a second out — `roundOuts` and `StatsService` both — for one player who
        //   died once. Neither mode is reachable today; both would be wrong the day one is switched on.
        // - **The attribute, which is gone.** It said "still spectating" about a body that had already
        //   been marked once, and the branch's own test — `activePlayers` membership — is the same fact
        //   written twice: membership is what makes a death an elimination in the first place.
        //
        // **What it still does is stop the mode being asked.** Below this line the round calls
        // `abilities.noteDeath` and then `mode.onDeath`, and neither is a question about somebody who
        // was never in this round: an out-of-round death is not a second death, and their run of hits is
        // already nought. See the note further down, which is where that reasoning is written out.
        if (!this.activePlayers.has(player)) {
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
        // method already means by it: somebody who was still in the round. Somebody already out of the
        // round dying again is not a second death, and their run is already nought.
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
     * Out of the round — the round's own record of it, and nothing else.
     *
     * **The record is written here because this is what "eliminated" means to the round.** Both of
     * the guards that make a death an elimination sit in {@link handleDeath} — a round is being
     * played, and the player was still in it — so a death in the lobby, a death for somebody already
     * out, and a mode that respawns instead of eliminating all pass this method by. Nothing here
     * decides anything; it reports a decision the mode has already made.
     *
     * **Two records are written, and they are one fact seen over two spans of time**: the player's
     * lifetime outs, which belong to `StatsService` and outlive the session they were earned in, and
     * this round's count for the result board, which is thrown away when the next round opens. This
     * is the only place either of them is written, which is why they are written together.
     *
     * **It used to publish a third thing — `SPECTATING_ATTRIBUTE` — and deleting that one line is the
     * whole of what changed here.** Being out of the round is `activePlayers`, which the statement
     * above writes; the attribute was a copy of that fact made for a single HUD label, and the label is
     * gone. Nothing else about an elimination moved: the out is still counted in both places, the body
     * still comes back at once, and the mode's decision is still the only thing being reported.
     */
    private eliminate(player: Player): void {
        this.activePlayers.delete(player);

        this.stats.recordOut(player);
        this.roundOuts.set(player, (this.roundOuts.get(player) ?? 0) + 1);

        // **And the wipe, before the body is handed back.** It has to be *here* rather than in `finishRound`,
        // because the round-end path is the loop's and up to a tick later, while the thrower's caption has to
        // say what their throw just did. See {@link announceWipe} for what it asks, and note that this changes
        // nothing about when the round actually ends — `finishRound` still runs where it always did.
        this.announceWipe(player);

        // **And a body, immediately — which is why this death did not gain a delay.** Elimination means *out of
        // the round*, not *out of the game*: an eliminated player is a player in the lobby with a character to
        // watch from, which is what the engine used to provide on its own clock and what this load provides at
        // the moment it is wanted. Every path that is not the round's own respawn takes its body now.
        this.respawns.loadNow(player, "eliminated");
    }

    /**
     * **Tells the thrower that their hit took the last body on the other side — `WIPEOUT!` is theirs.**
     *
     * **A wipe is a fact only the server has, which is the whole reason for the event.** The victim's client
     * could see its own body fall; it cannot see that it was the last one, and it cannot ask a mode what an
     * empty side means — a mode that keeps score does not care, and one that counts heads does. So the answer
     * is computed here, once, at the only moment it is knowable: the elimination that empties a side.
     *
     * **Three questions, in the order they can fail, and each is a different silence.**
     *
     * 1. **Was there a hit at all, and was it this death?** `lastHit` is written by `registerHit`, which runs
     *    immediately before `landHit` in `BallComponent.resolveTags` — so for a death caused by a ball it is
     *    this ball. A death caused by anything else (a reset, a fall, a dev command) has no hit behind it, and
     *    a death not caused by the *last* hit is refused by the victim compare. The clock is the second guard
     *    and is only there for an engine that delivers `Died` late — see {@link WIPE_ATTRIBUTION_SECONDS}.
     * 2. **Was the round decided by it?** `roundOutcome` is the round's own answer — the same one the loop
     *    asks — and a `DRAW` or an `undefined` means this elimination emptied nothing that matters (or emptied
     *    both sides), so there is no wipe to celebrate.
     * 3. **Did the *thrower* win it?** The outcome names a side, and the thrower's side has to be that one. A
     *    side can also empty because somebody left or because a rig was the last body — neither is a wipe by
     *    the thrower, and the second has no thrower to tell at all.
     *
     * **Addressed to the thrower rather than broadcast**, which is a first for this file's events: every other
     * one is a thing everybody can see, while this is a caption on one screen. **The name still travels**, so
     * the receiving client makes the same comparison it makes for `hitImpact` instead of trusting the
     * addressing — and so the line reads the same in a log either way.
     *
     * **It sends at most once a round.** The elimination that empties a side is the last one that can happen,
     * and a second one would have to find an outcome for a round already decided.
     */
    private announceWipe(victim: Player): void {
        const hit = this.lastHit;
        if (hit === undefined) return;
        if (hit.victim !== victim) return;
        if (os.clock() - hit.at > WIPE_ATTRIBUTION_SECONDS) return;

        const outcome = this.roundOutcome();
        if (outcome !== TEAM_A && outcome !== TEAM_B) return;
        if (this.teamOf(hit.thrower) !== outcome) return;

        events.Server.Get("teamWipe").SendToPlayer(hit.thrower, hit.thrower.Name);
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
     * **The body a thrower token names — a person, or a rig — or nothing if it names neither.**
     *
     * A token is the whole of what an arriving ball knows about who threw it, and the two kinds of thrower
     * carry two kinds of token: a player's is their `UserId` as text, and a rig's is a GUID that
     * `NpcService.start` issues. `playerFromToken` covers the first and by design answers nothing for the
     * second — which is the right rule for a *statistic*, because a rig has no account to file one against,
     * and the wrong rule for a *side*, because a rig holding a seat on a side has one. So the GUID is
     * matched against the rigs this round is playing with.
     *
     * **A scan, priced at the only moment it is asked.** A hit or a catch resolves a token once, when a ball
     * has already landed or been caught, so this walks `rigsInRound()`'s handful of models a handful of times
     * a round — nothing here runs per frame, and `StatsService`'s objection to resolving a model from a token
     * is about a scan on every *landing*, which is a different quantity from a scan on every *outcome*.
     * The O(1) alternative is to stamp the thrower's side on the ball at the throw, and it was rejected for
     * where it puts the fact: a side is this service's table plus an attribute, so the stamp would be written
     * by `BallService`, which knows nothing about sides, or by this service at a moment it is not told about.
     *
     * **Only rigs in the round are considered** — `rigsInRound()`'s `Playing` gate and its side test
     * together. A rig with no side has no side to be credited, so a token matching one resolves to nothing
     * and the hit is unattributed, exactly as an unknown token is.
     *
     * **Public since a rig's hit began counting toward the crown (2026-10-14).** `BallComponent.score`
     * asks this to resolve the thrower it is about to credit, so the streak's round-participation gate can
     * be asked of the resolved body — the same resolution the hit records already use, lent out rather than
     * copied.
     */
    public throwerOf(throwerToken: string): RoundParticipant | undefined {
        const player = playerFromToken(throwerToken);
        if (player !== undefined) return player;

        for (const rig of this.rigsInRound()) {
            if (rig.GetAttribute(THROWER_TOKEN) === throwerToken) return rig;
        }

        return undefined;
    }

    /**
     * Whether `participant` is in *this* round — **the round-participation gate the streak reads.**
     *
     * **The same read {@link handleDeath} makes of a dying player, asked of the whole union now.** A
     * player is a participant exactly while they are in `activePlayers` — the set `assignTeams` fills at
     * the opening whistle and `eliminate` empties — and a rig while it is in {@link rigsInRound}, which is
     * the `Playing`-gated list of side-bearing rigs. A practice player, a lobby spectator and a rig with no
     * side all answer `false`, which is the whole of the rule that keeps a hit outside a round from moving
     * a run.
     *
     * **A rig resolved by {@link throwerOf} is always in `rigsInRound` already**, so the rig half of this
     * test is about a body handed in some other way; the player half is the half that matters, because
     * `throwerOf`'s player arm does not phase-gate.
     */
    public isActive(participant: RoundParticipant): boolean {
        if (participant.IsA("Player")) return this.activePlayers.has(participant);

        for (const rig of this.rigsInRound()) {
            if (rig === participant) return true;
        }

        return false;
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
     * **A throw nobody can be credited with is not friendly fire, and neither is one on a body with no
     * side.** Both ends go through {@link teamOf} and {@link throwerOf}, so a rig sits at *both* ends of
     * this question exactly like a player does: a rig on A throwing at a rig on A is friendly fire and is
     * refused, and a rig on A is protected from a player on A. An unknown token, or a body with no side —
     * a lobby spectator, a practice player, a hand-tagged rig nobody gave a side to — still has no side to
     * be friendly with, and the honest answer there is to let the hit happen rather than to invent a rule.
     */
    public isFriendlyFire(throwerToken: string, victim: Model): boolean {
        if (this.state !== RoundState.Playing) return false;

        const thrower = this.throwerOf(throwerToken);
        if (thrower === undefined) return false;

        const shooterTeam = this.teamOf(thrower);
        if (shooterTeam === undefined) return false;

        const victimTeam = this.teamOf(victim);
        if (victimTeam === undefined) return false;

        return victimTeam === shooterTeam;
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
     * **A hit is a hit whoever is at either end, and the attribution is this file's rather than the ball's.**
     * Both ends resolve through `teamOf`, so a ball that lands on a rig reaches the round's records exactly
     * as one that lands on a player does: the thrower's side is credited. The two records that stay
     * *person-shaped* are named here rather than left to be discovered — `roundHits` and the hit log are about
     * a person's throws and about a pair of people, and a rig has neither a row on the result panel nor a
     * `UserId` for the feed to draw, so a rig's throw raises nobody's count and logs no entry. The career
     * figure is the same story from the other end: `StatsService.recordHit` is called from `BallComponent`
     * with the *thrower's* token and answers "not a person" for a GUID, because a lifetime record is keyed by
     * account. Damage is not, because damage lives in the ball and knows nothing about accounts — which is why
     * a rig's throw has always killed the player it landed on even while it scored nothing.
     *
     * **Recorded for scoring, for the board, and for the log — and no mode is asked about hit cause.**
     * The round is told about a hit so that a mode which keeps score can award the point, so that the
     * player who landed it goes up the round's own count for the result panel, and so that the *pair*
     * goes into the round's hit log — three readers of one event, which is why it all happens in one
     * method. **The career figure is deliberately not one of them**: `StatsService.recordHit` is called
     * by `BallComponent`, which owns the throw, and this method is told about a hit rather than being the
     * door every fact about one goes through. This paragraph used to list stats as a fourth reader here,
     * which was wrong about where the wire runs. Nothing anywhere asks whether a death was a throw or a
     * reset, which is why the round keeps no *cause*: a hit arrives as a hit or it does not arrive.
     *
     * **What changed on 2026-10-18: the cosmetic half is no longer the round's.** `hitImpact` — the event
     * `hitVfx` and `hitConfirm` read — is now sent before the phase gate, so an impact draws in every phase and
     * a player can watch and tune it in a practice zone. That makes one sentence above read differently:
     * **"only a cross-team hit ever arrives" is a fact about a round and not about the lobby**, because
     * `isFriendlyFire` answers `false` outside one by its own design. Nothing below the gate moves — the phase
     * test is the first line of the round's half — so a same-side contact outside a round is announced and
     * recorded nowhere, which is the honest reading of a throw with no round to be in.
     */
    public registerHit(throwerToken: string, victim: Model, ballAbility: string): void {
        // **The cosmetic half — the impact every client draws — is sent *before* the round gate, and that is
        // the whole of why this method now starts here.** `hitImpact` is read by `hitVfx` and by
        // `hitConfirm`, and both are about a *body being hit* rather than about the round: the burst on a
        // practice dummy and the splash over the thrower's own screen are wanted in the lobby, in a practice
        // zone and in the middle of a round alike. It used to be sent at the bottom, behind
        // `state !== Playing`, so a ball landing on anything outside a round drew nothing anywhere — which is
        // exactly the place a player throws freely enough to judge what a hit feels like.
        //
        // **Nothing is recorded here.** No counter, no log entry, no side check, no score: the records below
        // are still the round's alone and are still behind the gate two lines down. The two facts are told
        // apart deliberately — *a ball landed on a body* is true in every phase, and *this round has a hit in
        // it* is true only while one is being played.
        //
        // **Resolved once, above the gate, because the board and the log need the same answer below.** The
        // token is a `UserId` for a player and a GUID for a rig, and matching a rig's GUID to its rig is
        // `throwerOf`'s job; a second lookup further down would be the same scan twice.
        //
        // **An unresolved token still draws nothing, and outside a round that is every rig's throw.**
        // `throwerOf`'s player arm answers in any phase, while its rig arm walks `rigsInRound()` — a `Playing`
        // gated list — so a rig throwing in the lobby has no resolvable name and no payload with half a
        // subject is sent. A player's throw always resolves, which is the case that matters here: the splash
        // is compared against the *local player's* name.
        const thrower = this.throwerOf(throwerToken);

        // **Which power the throw was carrying, and why the ball's answer is not always the whole of it.**
        // `abilityOn` reports the mark on the ball — Pierce, Freeze — and cannot report MultiBall at all:
        // `isBallAbility` says a ball cannot carry it, because a MultiBall window is a buff on a *player* that
        // supplies ordinary balls, not a mark that rides one. So the window is asked here instead, which is the
        // one place the two halves can be joined: the splash needs one word for "was this throw a power", and
        // this is the only code that holds both the throw and the thrower.
        //
        // **The empty string rather than `undefined`**, on `BALL_ABILITY_ATTRIBUTE`'s convention — the client
        // has one value to test instead of two spellings of "none".
        let power = ballAbility;

        if (power === "" && thrower !== undefined && this.abilities.isMultiBallActive(thrower)) {
            power = "MultiBall";
        }

        if (thrower !== undefined) {
            events.Server.Get("hitImpact").SendToAllPlayers(victim.Name, thrower.Name, power);
        }

        if (this.state !== RoundState.Playing) return;

        // **The victim's side, asked of the body.** A player's character answers through its `Player` and
        // is still required to be *active* — a spectator is not in this round, and neither is a practice
        // player, whose absence from `teams` is what `teamOf` reports — while a rig answers with its own
        // attribute. One question, one answer, both kinds of body.
        const victimPlayer = Players.GetPlayerFromCharacter(victim);
        if (victimPlayer !== undefined && !this.activePlayers.has(victimPlayer)) return;

        const victimTeam = this.teamOf(victim);
        if (victimTeam === undefined) return;

        // **The hit is remembered for the length of one death, because that is the only moment a wipe can be
        // told apart.** `announceWipe` runs inside `eliminate`, and the join it needs is "which throw took
        // *this* body". The chain is `registerHit` → `landHit` → `TakeDamage` → `Died` → `handleDeath` →
        // `eliminate`, so this line and that one are one throw apart; the victim compare in `announceWipe` is
        // what stops a stale record from claiming a death it did not cause.
        //
        // **Players only.** `teamWipe` is addressed to a player and a rig has no client to caption, so a rig's
        // throw is not recorded — the record exists only for the case that can be drawn.
        if (thrower !== undefined && thrower.IsA("Player")) {
            this.lastHit = { thrower: thrower, victim: victim, at: os.clock() };
        }

        // **The thrower was resolved above the round gate, and this is what is left of the paragraph that used
        // to introduce the lookup here.** What it said still holds of everything below: the board is a fact
        // about who landed a hit and the log is a fact about *two* people, neither is a question about what a
        // hit is worth, and both are kept for every mode — a scoreless mode has a result panel like anybody
        // else, and under the scoring gate below Team Elimination's board would be empty for ever.
        //
        // **The board and the log stay records about *people*, and that is not the same gap it looked like.**
        // The result panel is drawn per person — a row, a name, a face — so a rig's throw raises nobody's
        // count and writes no entry in the feed; what a rig's throw is worth is its *side's* point, below.
        // A player's throw is counted whichever kind of body it landed on, because "how many throws landed"
        // is a fact about the thrower, and the log needs a pair of people at both ends by construction.
        if (thrower !== undefined && thrower.IsA("Player")) {
            this.roundHits.set(thrower, (this.roundHits.get(thrower) ?? 0) + 1);

            if (victimPlayer !== undefined) this.logHit(thrower, victimPlayer);
        }

        // **Was: the `hitImpact` send, here.** It has moved to the top of this method, above the round gate,
        // because an impact is a fact in every phase and a round is not — see the paragraph there. Nothing
        // else moved with it, which is why the send is not repeated for the hits that reach this far: every
        // one of them already went out two lines into the method. See `networking.ts` on `hitImpact` for the
        // two names and their order, and `hitVfx` and `hitConfirm` for the readers.

        // **A mode that keeps no score is not asked what a hit is worth.** See `GameMode.scores`:
        // a scoreless mode has no hit rule to state, so asking anyway would make every mode carry a
        // method whose only correct answer is "nothing" — and would call it on every landed hit of
        // every round for no reason. The hit itself is still recorded above, because *that* is not
        // a scoring question: a mode with no points may still need to know a throw landed.
        if (!this.mode.scores) return;

        const award = this.mode.hitAward({ thrower, victim }, this);
        if (award === undefined || thrower === undefined) return;

        // **The point goes to the thrower's side, whoever threw it** — the rule `GameMode.hitAward` states
        // and the one part of a hit this file attributes itself. A rig's throw used to be unattributable
        // here, so a round played against rigs scored nothing at all while their balls were knocking players
        // over: this line, and `throwerOf` above, are the whole of that fix.
        const scoring = this.teamOf(thrower);
        if (scoring === undefined) return;

        this.scores.set(scoring, (this.scores.get(scoring) ?? 0) + award);
        this.publishScores();
    }

    /**
     * Files one landed hit in the round's log: **who landed it, who took it, and which way it went.**
     *
     * **Two conditions, and both are the same question asked of the two ends: is this person on a side?**
     * A hit with no side at either end has no direction, and the direction is what the entry is *for* —
     * the pair alone is already in the two fields beside it. So the two lookups below are not validation
     * of the arguments, they are the content: `teams` is what turns "A hit B" into "A's throw landed on
     * B", and a thrower the round has no side for is a thrower who was not in this round.
     *
     * **That is one step further than `roundHits` goes, and the difference is deliberate.** That map
     * counts a landing for anybody whose token resolves to a player, side or no side — a mid-round joiner
     * who picked a ball up off the lobby floor can raise their own count — because "how many throws
     * landed" is a fact about that person. This log is a list of *hits*, which is a fact about two sides
     * and a direction, so that same hit is counted above and not logged here. Split rather than
     * harmonised, because the round's board and the round's log answer different questions.
     *
     * **No same-side guard, and its absence is the absence `registerHit` already has.** `BallComponent`
     * refuses a same-side contact before it damages anything, so a friendly pair cannot arrive here; a
     * check for one would be unreachable code describing a rule that lives in the ball. What this does
     * *not* do is assume the two labels differ — it derives the direction from both — so a contract that
     * ever broke would mislabel which way the hit went rather than invent a same-side case.
     *
     * **Newest first, oldest off the back.** `unshift` puts the arrival at index 0, which is what makes
     * the list readable as a feed in order without reversing it at every read; the trim is the cap, and
     * it is the only place the length is looked at.
     */
    private logHit(hitter: Player, victim: Player): void {
        const from = this.teams.get(hitter);
        const to = this.teams.get(victim);

        if (from === undefined || to === undefined) return;

        // **The direction is derived from both ends and read from one of them, and that is not a shortcut.**
        // Friendly fire is refused before a hit is recorded, so the two labels are always different — which
        // is what makes `from` alone enough to say which way the throw went, and what a client leans on when
        // it paints the two names. See `HitDirection` for that argument in full.
        const direction: HitDirection = from === TEAM_A ? "AtoB" : "BtoA";

        this.roundHitLog.unshift({
            hitter: hitter,
            victim: victim,
            direction: direction,
        });

        if (this.roundHitLog.size() > HIT_LOG_CAP) this.roundHitLog.pop();

        // **And everybody is told, on the line after the record rather than at the call site.** The
        // alternative was for `registerHit` to send after calling in here, which is the same event
        // written in two places: a hit that was logged and not sent, or sent and not logged, would be a
        // defect nobody could see in either file alone.
        //
        // **Names rather than the `Player`s themselves**, because a `Player` reference does not survive the
        // trip and a name is what a row draws — see `RoundResultRow` for the same conversion for the same
        // reason.
        //
        // **To everyone, which is the change this made when the HUD stopped being a pair of personal lists
        // and became the round's feed.** It was a `SendToPlayers` over the two of them, which read as the
        // natural shape for a fact about two people — and it was, while each client was shown only its own
        // exchanges. A feed is one list for the whole server, so sending it to the pair would leave every
        // client watching a feed that showed only the hits it was in, which is the thing the feed was
        // changed away from. See `networking.ts` on `roundHit`, which carries the cost of the broadcast.
        events.Server.Get("roundHit").SendToAllPlayers(hitter.Name, victim.Name, direction);
    }

    /**
     * The round's hit log, newest first — **the one reader of {@link roundHitLog}**.
     *
     * **A method rather than a public field, the same shape `playersInRound` has.** The list is the
     * round's, and a caller handed the array itself could trim it or reorder it; an accessor hands out
     * the entries and keeps the window's two rules — newest first and capped — in one file.
     *
     * **There is no caller yet, and that is the task rather than an oversight.** The log was asked for as
     * data with the display deferred, so this exists to make the data *readable* rather than merely
     * written: a private list nothing can get at is not a log. When the HUD arrives it will need a wire as
     * well — a `Player` reference does not survive the trip to a client, which is why `RoundResultRow`
     * carries an id and a name — and this is the shape that conversion will be written against.
     */
    public hitLog(): ReadonlyArray<RoundHitEntry> {
        return this.roundHitLog;
    }

    /**
     * Publishes both sides' points, so the client can draw a scoreboard.
     *
     * **One writer, called wherever `scores` moves**, and that is the whole reason this is a method rather than
     * a `SetAttribute` at each site: the map changes in four places — a hit award, a catch point, and the
     * clear at each end of a round's life: as it finishes and as the next one opens — and two attributes
     * written in four places is eight chances for one side to be published without the other. A reader would
     * then draw a scoreboard whose halves disagree, which is worse than drawing none.
     *
     * **Both sides are written on every change, including changes that move only one.** Writing an unchanged
     * value is cheap and fires no changed-signal, so the redundant write costs nothing and buys the guarantee
     * that the pair is never observable half-updated.
     *
     * **It is not gated on the mode**, deliberately. The two scoring paths are already guarded by
     * `mode.scores`, so a scoreless mode never reaches them; both clears do reach here, and write `0` for a
     * mode that keeps no score — which is the truthful answer rather than a missing one. **That matters more
     * than it did**, because the client's bar is drawn in every mode now: it shows `0 – 0` for a mode that
     * keeps no score, and this is the write that put it there.
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
     * **And a rig obeys this rule exactly as a player does, at both ends.** The thrower resolves through
     * {@link throwerOf}, so a caught throw that came from a rig kills that rig — the rig comes back through
     * `RespawnBehavior`, which is the same door a ball's damage sends it through — and the catcher's side is
     * credited through {@link teamOf}, so a rig's catch scores for the rig's side. Both were "nobody" before
     * this: catching a rig's throw punished nobody and scored nothing, which read as the rule being switched
     * off whenever an NPC was on the field.
     */
    public resolveCaughtThrower(throwerToken: string, catcher: Model): void {
        // No round, no sides, nothing to resolve: between rounds a catch is just a catch.
        if (this.state !== RoundState.Playing) return;

        if (this.isFriendlyFire(throwerToken, catcher)) return;

        const thrower = this.throwerOf(throwerToken);
        if (thrower === undefined) return;

        // **Neither end is punished unless both ends are *in this round*, and that is a guard the method
        // was missing rather than a refinement of one it had.** `teamOf` answers "which side are they on, or
        // nothing if they are not in this round" — so this is the round asking whether the catch happened to
        // anybody it is responsible for, before it kills anybody.
        //
        // **What its absence cost, reported from a seat:** a player practising in a zone threw at a practice
        // rig, the rig's catch window ate the ball, and this method killed the *thrower* — a player the round
        // itself had already decided was not in it (`assignTeams` deliberately leaves anybody standing in a
        // zone off a side, and the death line reads `in the round false`). The mode then correctly declined
        // to act on the death, so nothing was scored and nobody was eliminated — but the *body* was dead, so
        // `RespawnService` put a live one back at a lobby spawn, and a player who had been practising found
        // themselves teleported across the map. "When alwaysCatchNPC catches my ball, I die and then
        // teleport somewhere far away" is exactly this line, and the teleport is the respawn that follows
        // a death nobody should have taken.
        //
        // **The catcher is checked too, and that is the same rule at the other end.** A rig with no side
        // catching a participant's throw is a catch made *outside* the round — a practice dummy, a lobby rig
        // reaching a ball near the barrier — and the honest reading is the one `isFriendlyFire` gives an
        // unknown body everywhere else: the contact happened, and the round has no opinion about it. Scoring
        // it would credit a side the catcher is not on.
        //
        // **The hit path is deliberately not changed.** A side-less *victim* of a thrown ball is a different
        // case with a different answer — and a practice-zone body is never tagged at all, which the ball
        // prints as `in a practice zone — carried on past them`.
        if (this.teamOf(thrower) === undefined || this.teamOf(catcher) === undefined) {
            if (DEBUG_CONFIG.VERBOSE_LOGS) {
                print(`[Round] ${catcher.Name}: catch not resolved — the thrower is not in this round`);
            }

            return;
        }

        // **And everybody is told whose body just paid for that throw, which is the cosmetic half of the kill
        // below.** A caught throw is the one moment the *thrower* is the punished end, so the effect is drawn on
        // their body — red — and it goes out for both kinds of body and both kinds of catcher, because a rig's
        // throw being caught is the common case in a round against rigs and the thrower there has no client of
        // its own to be told privately. See `networking.ts` on `caughtThrow` for why it is an event of its own
        // rather than a flag on `hitImpact`, and `hitVfx` for the only reader.
        //
        // **Sent here rather than beside the kill, and the difference is the guards above.** Everything that
        // reaches this line is a catch the round is about to act on: both ends in this round, both ends on
        // opposite sides, and a thrower that resolved. A friendly catch, a catch between rounds and one from a
        // thrower the round cannot attribute all returned before it — so the red effect can never say "you are
        // out" about a throw nobody is out for.
        //
        // **Nothing here is a record.** No counter, no score, no feed entry — the points and the death below are
        // the record, and this is only the sentence the clients draw.
        events.Server.Get("caughtThrow").SendToAllPlayers(thrower.Name, catcher.Name);

        // The death goes through `Died → handleDeath` for a player, the same chain a landed hit takes: the
        // mode decides what the death means, and this file does not decide it here twice. **A rig has no
        // `Died → handleDeath` chain and needs none** — its `Humanoid` is killed here and `RespawnBehavior`
        // rebuilds it, which is what makes this one call correct at both ends rather than two rules.
        const humanoid = thrower.IsA("Player")
            ? thrower.Character?.FindFirstChildWhichIsA("Humanoid")
            : thrower.FindFirstChildWhichIsA("Humanoid");

        if (humanoid && humanoid.Health > 0) humanoid.TakeDamage(CATCH_DEATH_DAMAGE);

        if (!this.mode.scores) return;

        const team = this.teamOf(catcher);
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
     * **A lobby spawn on `team`'s half — the draw {@link lobbySpawn} deliberately does not make.**
     *
     * `lobbySpawn`'s own doc says a lobby has no sides, and for the *players* it moves that is true:
     * everybody waiting between rounds is put on one spawn and walks apart on their own, so which spot
     * they start from means nothing. **It stopped being true of the rigs** when the lobby learned to
     * place them by side (`LobbyRigService.lobbySpawnsFor`), because a rig does not walk apart — it
     * walks to a pad, and a pad belongs to a side. A rig returned to the lobby on the other side's half
     * is therefore a body on the wrong side to anybody watching: it stands there for the length of the
     * cover and then crosses the room.
     *
     * **The sided rule is not written here.** It is `npc/lobbySpawns.ts`, shared with `LobbyRigService`,
     * so the two callers that place a rig in the lobby cannot come to two answers about which parts
     * belong to a side — the same reason `npc/rigs.ts` exists for "which rigs stand on a side".
     *
     * **The fallback is the old behaviour, reached two ways, and neither is a new failure mode.** A
     * place file that does not mark the halves gets the side-less draw it has always had (and
     * `LobbyRigService` warns about the missing marking once a session), and a lobby that cannot be
     * resolved at all returns `undefined`, which the caller already treats as "stop moving rigs".
     * The sided answer is simply tried first.
     */
    private lobbySpawnFor(team: TeamLabel): CFrame | undefined {
        const arena = findArena();
        if (arena === undefined) return this.lobbySpawn();

        const parts = lobbySpawnPartsFor(arena, team);
        if (parts.size() === 0) return this.lobbySpawn();

        // The same three-stud lift `lobbySpawn` and `getRandomTeamSpawn` use, and for the same reason:
        // a body placed at the `CFrame` of the floor it stands on arrives half inside it.
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
     * The arena spawn for `participant`'s side — one of that side's spawn parts, picked at random.
     *
     * **The one place the side-to-spawn mapping lives**, so a round's opening teleport and a
     * respawn mid-round cannot send the same player to different ends of the arena. A participant
     * with no side — a player who joined while a round was already under way — is treated as
     * A's, here and at the round start alike; for a player that is not in `activePlayers`, so this is
     * the only moment it ever matters for them, and for a rig the case cannot arise at all: holding a
     * side is what puts it in the round.
     *
     * **It takes a participant rather than a player, and that is the whole of how a rig is spawned.**
     * The side comes from {@link teamOf}, which answers for both kinds of body, so one rule serves the
     * opening teleport, a player's respawn and a rig's placement — and a rig and a player on the same
     * side land among the same parts by construction rather than by two lookups that agree. What the
     * caller then does with the answer differs, and that difference stays in the caller: a character is
     * moved by `PivotTo`, a rig by its root part. See {@link teleportTeamsToArena}.
     *
     * **The pick is made here rather than at either call site**, which is what makes a respawn land
     * as spread out as the opening whistle: both go through this method, so there is no second place
     * for the two to disagree — the same reason the side mapping is here. It follows that the draw
     * is per *call*, so a returning player is not sent back to the spot they died on.
     */
    private arenaSpawnFor(participant: RoundParticipant): CFrame {
        const team = this.teamOf(participant);

        return this.getRandomTeamSpawn(findArena(), team === TEAM_B ? TEAM_B : TEAM_A);
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

    /**
     * Everyone to one place. The lobby's business: no side is on the lobby's side.
     *
     * **Players only — and the rigs are moved back by {@link returnRigsToLobby} on the same frame**, which is a
     * decision this paragraph used to argue the *other* way. It read: a rig's own place is the one its author
     * put it in, kept in `RespawnBehavior`'s `homes` map, which this service cannot read and should not own —
     * so a rig stayed where the last round left it. That reasoning is about a rig *authored into the arena*,
     * and it stopped being true the moment the placeholders arrived: their authored place is a **lobby** spawn
     * (they walk from there to a join pad), and a round that leaves them on the court leaves the next
     * intermission with an empty lobby and eight rigs standing in the arena. The map this method was supposed
     * to be honouring is the wrong map for them — `homes` is "where a rig was standing when it was first seen",
     * which for a placeholder is wherever the boot seeding put it, and that is exactly where returning it goes.
     *
     * **And a practice-zone player is not moved either**, for the opposite reason: they are the round's
     * business in no sense at all, and "undisturbed" begins with not being moved by a boundary they are
     * not part of. See {@link isPracticePlayer}, which is the test the loop below applies to every body.
     */
    private teleportAll(to: CFrame) {
        for (const player of Players.GetPlayers()) {
            if (this.isPracticePlayer(player)) continue;

            const character = player.Character;
            if (!character) continue;

            // **The burst that turns one assignment into a teleport, played before the move.** One call and not
            // two: the clone is welded to the root, so what it emits is emitted where the body *was* and stays
            // there — see `vfx/spawnPoof.ts` for why a welded effect survives the `PivotTo` without dragging its
            // own particles along. There is therefore nothing at the destination to draw, and nothing here
            // changes where anybody ends up: the helper reads the body and never writes to it.
            //
            // **Who actually sees this is narrower than it looks, and it is worth writing down because it is the
            // opposite of the other boundary.** `transitionAround` covers the round's *roster* (`this.teams`),
            // and this loop moves **every non-practice player** — so the spectators in the lobby are being moved
            // with no grid over their screens, and this is the only thing that turns their cut into a teleport.
            // The players who played the round see their own move behind the cover, and see nothing of this.
            playSpawnPoof(character);
            character.PivotTo(to);
        }
    }

    /**
     * **Every rig on a side goes back to a lobby spawn, one rig per spawn.**
     *
     * The other half of the boundary `teleportAll` does for players, and it is deliberately *not* that method
     * with a lower filter: a player and a rig differ in what "the lobby" means for them. Players are all put on
     * one spawn because they walk apart on their own; rigs cannot, so each is given its **own** draw from the
     * lobby spawns — the same per-rig placement `LobbyRigService.spawnLobbyRig` makes at boot and for the same
     * reason, a place where eight bodies do not arrive in one spot.
     *
     * **By the root part, not by `PivotTo`**, which is the convention this file already keeps for rigs
     * (`teleportTeamsToArena` places them the same way): a model with no `PrimaryPart` pivots at the centre of
     * its bounding box, so a pivot can put a rig's feet inside the floor it was aimed at.
     *
     * **A side is the whole of who is moved**, through `rigsOnASide` rather than `rigsInRound` — the latter is
     * gated on the round being played, and this runs at the boundary where the phase has just *stopped* being
     * `Playing`. A rig with no `Team` is left exactly where it is, which is what keeps a hand-tagged rig in a
     * practice area out of it.
     *
     * **What the rig does next is not this method's business.** It arrives in the lobby with its side still
     * written on it — the seat it holds — and `LobbyRigService` sends it to its own pad a moment later; this
     * moves a body, and where a rig *belongs* inside the lobby is a fact about pads.
     */
    private returnRigsToLobby(): void {
        for (const { rig, team } of rigsOnASide()) {
            // **The rig's own side decides which half of the lobby it lands on**, which is the correction
            // this line carries. `lobbySpawn()` has no side in it at all — by design, and correctly, for
            // players — so a rig returned to the lobby was put wherever the draw fell and then walked
            // across the room to its pad. That is a placeholder standing on the other side's end of the
            // lobby for the length of the cover, which is what "a rig spawned on the wrong side" looks
            // like. See {@link lobbySpawnFor}.
            const spawn = this.lobbySpawnFor(team);
            if (spawn === undefined) return;

            const root = rig.FindFirstChild("HumanoidRootPart");
            if (!root || !root.IsA("BasePart")) continue;

            // **The rig's own burst, before the same move the players' `teleportAll` makes.** A rig is moved here
            // rather than by `PivotTo` because `root` above is the thing being written, and the effect reads the
            // same root, so the burst fires exactly where the body was standing. The grid covers the round's
            // players and not the lobby's spectators, which is who sees this.
            playSpawnPoof(rig);
            root.CFrame = spawn.add(new Vector3(0, 3, 0));

            // **Announced, and this is the other half of the same fault.** A home read at the first turn
            // still points at an arena spawn once the rig has been in a round, so a rig killed between
            // rounds came back standing on the field instead of in the lobby. See `NpcBehavior.onPlaced`.
            this.npcs.announcePlaced(rig);
        }
    }

    /**
     * Each side to its own spawn, for the start of a round — **the players and the rigs alike.**
     *
     * Resolved through {@link arenaSpawnFor} per participant, and that is what makes a bad place
     * file safe: a missing part raises on the *first* lookup, before the first character has
     * been moved, so nothing ends up half-sent to a side that does not exist.
     *
     * **The match's players and the round's rigs, which is what still leaves everybody else in the
     * lobby.** This used to move every player in the server, and with opt-in that would be the whole
     * feature undone in one line: a player standing in the lobby would be teleported into the arena and
     * asked to play a match they never joined. `activePlayers` is exactly the player roster at this point
     * — filled a few lines above and emptied at every intermission — so this is the roster by construction
     * rather than by a second filter that could disagree with it. The rigs are the same idea one layer
     * out: `rigsInRound` is the rigs *on a side*, so a rig nobody has given a side to is standing where
     * its author put it and is not moved, exactly as a player who never touched a join part is not.
     *
     * **Two loops rather than one over `participantsInRound`, and the split is the point.** A player is
     * moved by their *character* — a body that has to be read and guarded, because a player between a
     * death and a respawn has none — while a rig *is* the body. Sharing one loop would mean narrowing a
     * union on every iteration to find that out, which is the opposite of what the named union in
     * `RoundParticipant` is for; two loops each say what they are moving, and the third line of each is
     * the only place the two bodies genuinely differ.
     *
     * **Teleported rather than walked, and this is the decision that had to be argued.** A rig that runs
     * to its post reads better than one that snaps there — but nothing in the game walks a rig to a
     * *post*: the seek behaviour walks a rig to a loose ball and the pickup takes it, so the only thing
     * that could carry a rig from the lobby to a spawn is a behaviour written for it, which means a new
     * tag, a new behaviour file and a race against `ARENA_FREEZE_SECONDS` — for rigs the freeze does not
     * even hold. A rig that arrives with the players is also a rig that exists in the arena from the
     * round's first tick, which is what makes it a participant rather than a spectator that may or may
     * not turn up. The cost, stated plainly: a rig's arrival is a cut rather than a run, and with the
     * transition's cover switched off a rig teleported across the arena is visibly teleported.
     */
    private teleportTeamsToArena() {
        for (const player of this.playersInRound()) {
            const character = player.Character;
            if (!character) continue;

            // **The opening whistle's burst, before the move.** This is the boundary whose cut the wipe exists
            // for, so the players themselves see the grid and not this — it is for the lobby, where everybody who
            // did not opt in is standing and watching eight bodies leave.
            playSpawnPoof(character);
            character.PivotTo(this.arenaSpawnFor(player));
        }

        // **By the root part rather than by `PivotTo`, and that is not a style choice.** A model's pivot
        // is its `PrimaryPart` if it has one and the centre of its bounding box otherwise. The spot this
        // aims at is `spawn.CFrame` lifted three studs, which is where a *character's* humanoid root
        // belongs: a character has a primary part, so `PivotTo` puts the root there, while a rig with
        // none would have its *centre* put there and its feet left in the platform. `RespawnBehavior`
        // places a rig by its root for the same reason and says so at length, and the root is also the
        // part `resolveDodgeable` and `detectEnemy` address a rig through — so this is the one part of a
        // rig the rest of the game already agrees on.
        //
        // **No root, no move, and nothing said about it.** A model wearing the tag with no
        // `HumanoidRootPart` is not a rig: `NpcService` will not run a body it cannot own or animate, and
        // `RespawnBehavior.prepare` returns on the same condition. There is nothing to place and nobody
        // to tell.
        for (const rig of this.rigsInRound()) {
            const root = rig.FindFirstChild("HumanoidRootPart");
            if (!root || !root.IsA("BasePart")) continue;

            // **And the rigs, on exactly the players' terms** — the same burst before the same move, reading the
            // same root part this line writes. A rig is a body in the round like any other and the lobby watches
            // it leave as it watches everything else leave.
            playSpawnPoof(rig);
            root.CFrame = this.arenaSpawnFor(rig);

            // **Announced, because the rig has just been put somewhere and one behavior remembers where.**
            // `RespawnBehavior` reads a rig's home the first time it sees it alive and — until this line —
            // never again, so a rig born in the lobby kept a lobby home for life and came back there every
            // time it died in a round. See `NpcBehavior.onPlaced` and `NpcService.announcePlaced`.
            this.npcs.announcePlaced(rig);
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
     *
     * **Asked of every player except the ones in a practice zone**, which is the one correction the
     * zone forces on this loop: a player standing in one is not on their way into a round, so their
     * ball is not the round's to destroy — the same skip `roundParticipants` makes on the other
     * boundary, and the same reason.
     */
    private clearHeldBalls() {
        for (const player of Players.GetPlayers()) {
            if (this.isPracticePlayer(player)) continue;

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
     * out of the server, and the ones who joined during it were never in the round to begin with — the
     * round-start loop leaves a player out of `activePlayers` unless the roster has a side for them. See
     * {@link roundParticipants} for the rigs.
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
            // **And the rigs move with them**, in the same closure rather than in a second transition: they are
            // the same kind of thing being sent to the same room, and the cover that hides one hides both.
            await this.transitionAround(
                () => {
                    this.teleportAll(lobby);
                    this.returnRigsToLobby();
                },
                {
                    wipe: TRANSITION_CONFIG.WIPE_AT_ROUND_END,
                },
            );

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
            // player who opened one is as finished with it as anybody, and the two are one list to
            // write over once a minute.
            //
            // **And a mystery prize, in the same loop, because it is the same kind of thing.** A box
            // collected in one round must not buy a power in the next, and unlike the window above the
            // reason is not that a clock is running: it is that the round the player collected it in is
            // over, and the boundary is where a round-scoped thing ends. This is one of the two ways a
            // prize can be lost — the other is dying — and it is the half that makes "use it or lose it"
            // mean something at the end of a round rather than a promise held indefinitely.
            //
            // Written unconditionally over every player, including ones who died into this boundary: the
            // release is silent when there is nothing to release, so a death that already took the prize
            // costs a call and no second publication. The one exception is a player in a practice zone,
            // who was never in the round and therefore holds nothing the round's end should reach for —
            // the skip in the loop below.
            //
            // **And every wait for a body, in the same loop because it is the same kind of thing.** A player
            // who died inside the round and was still counting down when it was decided has *no character at
            // all* — and the teleport to the lobby above moves bodies rather than making them, so a timer left
            // to fire on its own would leave them invisible for the whole intermission and looking exactly like
            // a break in the join path. `cancel(player, true)` drops the wait and loads in the same call: the
            // intermission is a place with nothing at stake, so the body is wanted now rather than in three
            // seconds. See `RespawnService.cancel`, whose flag exists for precisely this caller.
            for (const player of Players.GetPlayers()) {
                // **A practice-zone player is left alone.** Their windows, prizes and waits are not the
                // round's to close — a prize collected outside a round is not lost to a round it never
                // entered, and a body they are waiting for is not a body the round owes anybody.
                if (this.isPracticePlayer(player)) continue;

                this.abilities.clearMultiBall(player);
                this.abilities.releaseMysteryPrize(player, "the round ended");
                // **And nothing stays armed into the intermission**, which is the third thing this sweep takes
                // away and the only one that is not a row of state: a marked ball is a fact about the *ball*,
                // so `SuperService` is only ever told about it for the HUD's sake. Left alone, a player who
                // marked a ball and never threw it would carry a `READY` text into the lobby, where no power
                // can be used — a promise the next round would then break. `completePower` is silent when
                // there is nothing armed, which is the ordinary case in this loop.
                this.abilities.completePower(player);
                this.respawns.cancel(player, true);
            }

            // **And every freeze, for the same reason and from the same moment.** A body held in place by
            // an ability belongs to the round the ability was spent in, and a round boundary is the one
            // point in the game where nothing carries over. Every body rather than the round's
            // participants, because a freeze is a fact about a body: a player out of the round caught in a
            // splash is as frozen as one in it, and a rig has no side to be a participant of.
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
            // **The clock ends an intermission, and it is the only thing that does.** It reaches zero and
            // the round opens; the wrap survives only in the one case with no end to reach — an empty server
            // — see the expiry below. *(It used to wrap always, and the round was opened by a separate
            // five-second settle window instead, which is how one intermission came to last five seconds and
            // the next twenty-two.)*
            //
            // **No settle window and nothing to count**, so the only number the loop carries is `elapsed`,
            // which exists for the vote window alone.
            let elapsed = 0;

            // **The intermission is now measured against a clock rather than counted in iterations, and
            // this is the fix for "why was the first one longer than the second".** The old line was
            // `task.wait(1); this.timeRemaining--`, which reads as one second per tick and is not one:
            // `task.wait(1)` resumes on the first frame *after* a second, so every tick is a little over a
            // second and sixteen of them are a little over sixteen. On a busy server "a little" is a lot.
            // Measured in a live log on 2026-10-17: `Intermission started` at 21:09:42.571 and
            // `starting on its own` at 21:10:03.355 — **20.8 seconds for a 16-second intermission**, which
            // is the same class of fault as the settle window this loop used to have and reads to a player
            // as exactly the same thing: the number on the HUD is not the time they are waiting.
            //
            // **So the number is derived from time that actually passed.** `os.clock()` is monotonic and
            // unaffected by the loop's own lateness, which means a slow tick no longer costs an
            // intermission anything — it just gets counted in the next read. The `++`/`--` pair is gone;
            // the loop turns once a second, which is the *resolution* of the display, not the clock.
            let clockStarted = os.clock();

            while (this.pendingMatch === undefined) {
                // A paused tick does nothing at all: no second off the clock, no change of
                // state, no teleport. The phase resumes from whatever the clock said when it
                // was switched off, which is the whole difference between pausing and ending.
                //
                // **A server below the minimum no longer freezes with it.** The clock used to stand still
                // until there were `MIN_PLAYERS` bodies *on a side* — and at boot there are none, because
                // the lobby's rigs are still walking to their pads and take no side until they arrive. So
                // the first intermission's clock did not start for ten-odd seconds and then needed its whole
                // countdown, while every later one started ticking the instant the previous round ended. The
                // freeze was there to stop a half-empty server burning an intermission it could not use, and
                // the expiry below does that job honestly instead: an empty server counts down, fails to
                // start, and goes round again with the HUD still moving.
                if (this.isRoundsPaused()) {
                    // **A pause does not eat the clock, and with a wall clock that has to be said out loud.**
                    // The old count-then-`continue` version was immune by accident: a held tick simply never
                    // decremented. A `os.clock()` reading keeps advancing while the loop is parked, so the
                    // origin is shifted forward by however long the hold lasted — the intermission resumes
                    // from the second it was stopped at, which is what "paused" has to mean if it is not to
                    // secretly mean "skipped ahead".
                    const pausedAt = os.clock();
                    task.wait(1);
                    clockStarted += os.clock() - pausedAt;
                    continue;
                }

                // The vote opens on the intermission's **first running second**, which is not the
                // same moment as the intermission *starting*: a held server is parked above, so its
                // intermission has not really begun and the window should not be open while a dev has
                // it stopped. Opening it here rather than once before the loop is also what reopens the
                // window after a wrap — see the expiry below, which is now the only thing that wraps.
                //
                // **Switched off, and left standing.** See `VOTE_ENABLED` — the vote is not offered any
                // more, and the call stays where it is so that turning it back on is that one line.
                if (VOTE_ENABLED && elapsed === 0) this.votes.openVote();

                task.wait(1);
                elapsed++;
                this.timeRemaining = math.max(
                    0,
                    ARENA_CONFIG.INTERMISSION_SECONDS - math.floor(os.clock() - clockStarted),
                );

                // **The expiry, and the whole of the start rule.** The clock ends an intermission; there is
                // no second gate beside it and nothing to settle. Three readings of zero:
                //
                // - **a match can start** — hold at `0`, and the block below opens it on this tick;
                // - **nothing here to play for** (`belowMinimum`) — wrap, because the number moving is how
                //   the HUD says the server is alive and an empty server should not sit at `0` looking hung;
                // - **bodies here but one side empty** — hold at `0`, because a round cannot open and
                //   somebody still has to choose. Every tick re-asks, so the moment a side is picked the
                //   match opens. **This is the only case where an intermission outruns its clock**, and
                //   balancing is what keeps it rare: nobody is left stranded on a side that is full.
                if (this.timeRemaining <= 0) {
                    if (this.matches.canStart()) {
                        this.timeRemaining = 0;
                    } else if (this.belowMinimum()) {
                        this.timeRemaining = ARENA_CONFIG.INTERMISSION_SECONDS;
                        elapsed = 0;
                        // The wrap re-bases the clock as well, or the next intermission would be over the
                        // instant it started — the origin is what "16 seconds" is measured from, and this is
                        // the one branch that begins a fresh one without leaving the loop.
                        clockStarted = os.clock();
                    } else {
                        this.timeRemaining = 0;
                    }
                }

                this.statusFolder.SetAttribute(ROUND_TIME_ATTRIBUTE, this.timeRemaining);

                if (VOTE_ENABLED && elapsed === GAME_MODE_CONFIG.VOTE_SECONDS) this.votes.closeVote();

                // **The start: the clock ran out with a roster that can play.**
                //
                // **Nobody has to ask for a match for one to happen, and that is the design rather than a
                // fallback** — the intermission's own length is the request. `!dev match` is the override
                // beside it, for a dev who does not want to wait the clock out. Both arrive at the same
                // door — see {@link startMatch} — so nothing below cares which of the two this is.
                //
                // **No settle window and no revision read.** A roster still moving at the whistle is simply
                // the roster the round starts on: a last-second side switch *is* a roster change, and the
                // sides are balanced as bodies arrive rather than held still for — see `MatchService.optIn`
                // and `sideWithRoom` in `npc/rigs.ts`. Waiting for the roster to stop changing was what made
                // one intermission five seconds and the next twenty-two.
                if (this.timeRemaining !== 0) continue;

                const counts = this.matches.countsFor();
                const rigs = rigCounts();

                // **The rigs are counted separately rather than folded into the player counts**, so the line
                // names both kinds of body: `countsFor` is the players `MatchService` knows, and `rigCounts`
                // is the derivation a rig-only round starts on. A rig-only start therefore prints two zeroes
                // under "players" and two under "rigs" — the honest shape of a match with no people in it —
                // rather than a bare `A: 0, B: 0` that reads as a fault.
                print(
                    `[Round] starting on its own — the ${ARENA_CONFIG.INTERMISSION_SECONDS}s intermission ` +
                        `ran out (players A: ${counts.a}, B: ${counts.b}; rigs A: ${rigs.a}, B: ${rigs.b})`,
                );

                // The same door the dev command uses, so the field still has exactly one writer — and a
                // request that arrived a moment earlier still wins, because this branch is only reached
                // while it is unset.
                this.startMatch(SCORE_RUSH);
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
            // by `handlePlayerJoined`, so an eliminated player comes back in the lobby through the same
            // branch a joiner takes. Ability debris: its own lifetime, plus
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

            // **The scores are cleared here as well as at the round's end, and the two are not redundant.**
            // `finishRound` wipes them for every round that *finishes*, which is the normal path and the one
            // the HUD reads; this clears them for a round that is discarded without finishing — a dev command,
            // a server with rounds switched off mid-round — so a fresh round cannot open onto somebody else's
            // numbers. The round is also un-finished here — it is exactly the flag's lifetime — so a round
            // ended early by a leaver cannot leave the next one unable to finish at all.
            this.scores.clear();
            this.publishScores();

            // **Both boards go with the hit log, and here rather than where the round ends.** Cleared at
            // `finishRound` they would empty the panel that reads them one frame before the intermission they
            // are meant to fill: a board is the round's *record*, so it has to outlive the round by exactly as
            // long as the intermission does, and clearing it at the next round's opening is what gives it that
            // lifetime — which is the hit log's lifetime too, by the same argument and on the same line. See
            // `roundHits`, `roundOuts` and `roundHitLog`.
            //
            // **The scoreboard is the one that no longer goes with them, and the difference is who reads it.**
            // These three are read by the result panel, which is drawn *between* rounds and would have nothing
            // to draw if they were cleared as a round ended; the two score attributes are read by a scoreboard
            // that is on screen in every phase and is *about the round being played*, so a figure left standing
            // over an intermission is the one thing it must not show. See `finishRound` for the whole of it.
            this.roundHits.clear();
            this.roundOuts.clear();
            this.roundHitLog.clear();

            this.finished = false;

            this.assignTeams();

            // **The round is the roster, and everybody else is watching it.** Only the players `MatchService`
            // has put on a side go into `activePlayers`; somebody standing in the lobby who never touched the
            // join part is not in the match and not on a side, and the loop below is the line that says so to
            // everything outside this service. The teleport below covers the match's players only, and a
            // player who is out of the round and respawns is sent back to the lobby by the same branch a
            // joiner takes — see `handlePlayerJoined`.
            //
            // **The rigs are the one thing added to the round since, and nothing is added for them here.** A
            // rig's side is painted on the rig rather than assigned, so this boundary has nothing to write
            // for one and `activePlayers` stays a set of *people* — see `rigsInRound`, which derives the
            // round's rigs from that attribute on every read. What that buys is that this loop, and every
            // player-only reader downstream of it, goes on meaning exactly what it meant before.
            //
            // **The streak is cleared for everybody except a player in a practice zone**, and that is the
            // one thing in here that is not about the roster: a run of hits is a fact about the round that
            // has just ended, and somebody who sat this one out did not earn the one they were carrying. A
            // practice-zone player is the exception for a different reason — they are not sitting one out,
            // they are outside the round entirely, and the run they are building against the practice rigs
            // is not the round's to wipe. The skip in the loop below is that one exception made explicit.
            for (const player of Players.GetPlayers()) {
                // **A practice-zone player is not part of this boundary at all**: no streak reset, no
                // roster question, no `activePlayers`. The comment above states why their run is left
                // standing; this line is where that exception is applied.
                if (this.isPracticePlayer(player)) continue;

                // **A run of hits belongs to a round, and this is where a round begins.** Beside the
                // score board and the two boards cleared above, and for their reason: a streak is a fact
                // about the round that has just ended, so it is cleared where the next one opens rather
                // than at the intermission — which is what lets the readout still show it for as long as
                // the result panel is up.
                //
                // The *charge* is deliberately not touched. It is held until it is used, so a player who
                // earned one and never spent it carries it into this round.
                this.abilities.resetForRound(player);

                // **In the round, or not — and this is where the two are told apart.** The roster is the
                // question: `teams` was filled a few lines above by `assignTeams` from the players who
                // picked a side, so membership of it *is* participation, and being added to `activePlayers`
                // is what that means to the rest of this service.
                //
                // **"Membership is participation" is a rule about *players*, and that is now something this
                // line has to say**, because the round gained a second kind of participant. A rig is in the
                // round because `TEAM_ATTRIBUTE` says which side it is on, not because anything was written
                // down about it here — so there is no entry to test and nothing to add, and `rigsInRound` is
                // the whole of that decision. Keeping the two apart is what lets `teams` stay a map of
                // people for `MatchService`, the economy and the result board to read.
                //
                // **This used to publish the answer as `SPECTATING_ATTRIBUTE`, once per player per round,
                // and that is the write that has gone.** Both statements below are load-bearing in opposite
                // directions — the `continue` keeps a non-participant out of the round, and the `add` puts
                // everybody else in — so the branch is not a leftover: it is the roster decision itself,
                // which used to be spelled twice. Somebody in the lobby who never opted in is simply not
                // added, which is exactly what `activePlayers` means. See that field.
                if (!this.teams.has(player)) continue;

                this.activePlayers.add(player);
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

            // **And the one thing that keeps the pads live while this round is being played.** The roster
            // was taken at the whistle by `assignTeams` above, and nothing else in this file will look at
            // it again until the next one — so a player who walks into a join part now is written to the
            // roster by `MatchService` and to nothing else, which makes this the only thing that can put
            // them in the round. Spawned rather than awaited, and it ends itself when the phase leaves
            // `Playing`. See `watchMidRoundJoins` for the whole argument, including why it is a poll.
            task.spawn(() => this.watchMidRoundJoins());

            // **The round's clock is measured the same way the intermission's now is, and it is started
            // *here* rather than where `timeRemaining` was set.** The two are different moments on purpose:
            // the number is published at its full length before `transitionAround`, and the comment above is
            // explicit that it does not move until that returns — so the origin belongs at the top of the
            // loop, which is the first tick after the arena freeze lifts. Starting it a few lines higher
            // would hand the round back the five seconds the hold costs, which is the exact fault the
            // intermission's 20.8-for-16 measurement was.
            let roundStarted = os.clock();

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
                this.timeRemaining = math.max(
                    0,
                    ARENA_CONFIG.ROUND_SECONDS - math.floor(os.clock() - roundStarted),
                );
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
 *
 * **A player in a practice zone is skipped**, and the skip is the point of the phrase "could be holding
 * a ball *when a round ends*": a practice-zone player never entered the round, so nothing in their hand
 * is the round's to take — stripping it would be the round reaching into the one place it is not wanted.
 * Read off the attribute, the same way {@link RoundService.isPracticePlayer} reads it, because
 * `PracticeZoneService` is the owner of the answer and this file asks rather than re-tests the geometry.
 */
function roundParticipants(): Model[] {
    const participants: Model[] = [];

    for (const player of Players.GetPlayers()) {
        if (player.GetAttribute(PRACTICE_ZONE_ATTRIBUTE) === true) continue;

        const character = player.Character;
        if (character) participants.push(character);
    }

    for (const npc of CollectionService.GetTagged(NPC_TAG)) {
        if (npc.IsA("Model") && npc.IsDescendantOf(Workspace)) participants.push(npc);
    }

    return participants;
}