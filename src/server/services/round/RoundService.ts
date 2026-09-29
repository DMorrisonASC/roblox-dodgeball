import { Service, OnStart } from "@flamework/core";
import { CollectionService, Players, Workspace } from "@rbxts/services";
import { ARENA_CONFIG } from "shared/config/arena.config";
import { DEBUG_CONFIG } from "shared/config/debug.config";
import { GAME_MODE_CONFIG } from "shared/config/gameMode.config";
import { GAME_MODE_NAMES, sideNameOf } from "shared/gameMode";
import { events, RoundResultRow } from "shared/networking";
import {
    ROUND_STATE_ATTRIBUTE,
    ROUND_TIME_ATTRIBUTE,
    ROUND_WINNER_ATTRIBUTE,
    SPECTATING_ATTRIBUTE,
    TEAM_ATTRIBUTE,
} from "shared/constants";
import { DevService } from "../../dev/DevService";
import { NPC_TAG } from "../../npc/Behavior";
import { MapService } from "../MapService";
import { BallService } from "../ball/BallService";
import { StatsService } from "../stats/StatsService";
import { GameMode, RoundView } from "./modes/GameMode";
import { DEFAULT_MODE, modeFor } from "./modes/registry";
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
     * Replaced at the opening of every playing phase from whatever the vote chose, so a mode is
     * fixed for the length of a round and cannot change under one that is already running. It
     * starts at the game's original mode, which is what makes the very first round — before any
     * vote has been held — behave exactly as it did before modes existed.
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
        private readonly maps: MapService,
        private readonly stats: StatsService,
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
        // lands beside whichever `[Map]`, `[Round]` or `[NPC]` line was doing something at that
        // instant, so whatever reconstructs this later has a timestamp instead of a theory.
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
            // leaves that code's frames on the stack — a `Destroy()` in `RespawnBehavior`, the
            // spawner's round cleanup, or `MapService.unloadCurrent` all appear here by file and line.
            // A stack that is nothing but the signal dispatch is its own answer, and the interesting
            // one: the remover is not project code, and the place is where to look.
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

        task.spawn(() => this.gameLoop());
    }

    // ---- Public API (for HUD later) ----
    public getState(): RoundState {
        return this.state;
    }

    public getTimeRemaining(): number {
        return this.timeRemaining;
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
     * Puts the server's players on sides, the way the mode wants them.
     *
     * **Assigned at the start of every round, never on join.** A player arriving mid-round
     * cannot shift the balance of a round already under way, and nobody carries a side into
     * the next one — which is both fairer and the reason this clears the table rather than
     * topping it up.
     *
     * The split itself is the mode's — see `GameMode.assign`. Both symmetric modes want the even
     * shuffle in `splitEvenly`, and Dodge and Seek wants one seeker against everybody else. What
     * is *not* the mode's is the two things below: the table the round counts from, and the
     * attribute that publishes a side to everything outside this service. A mode says who is on
     * which side; the round is what makes that true.
     */
    private assignTeams(): void {
        this.teams.clear();

        const assigned = this.mode.assign(Players.GetPlayers());

        for (const [player, team] of assigned) {
            this.teams.set(player, team);
            player.SetAttribute(TEAM_ATTRIBUTE, team);
        }
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

        // A death in the lobby is not an elimination, so nothing is written outside a round.
        if (this.state !== RoundState.Playing) return;

        // Already out — a spectator who dies again is still a spectator. This is the case the
        // old code covered by clearing `activePlayers` unconditionally and then re-marking them.
        if (!this.activePlayers.has(player)) {
            player.SetAttribute(SPECTATING_ATTRIBUTE, true);
            return;
        }

        const decision = this.mode.onDeath({ player }, this);

        if (decision.kind === "eliminate") {
            this.eliminate(player);
            return;
        }

        // Back in — on a new side if the mode asked for one, and then a body to go with it.
        //
        // The respawn is `LoadCharacter`, which fires the `CharacterAdded` handler above. Because
        // they were never taken out of `activePlayers`, that handler puts them back on their own
        // side's spawn rather than in the lobby — so *where* they come back needs no code here,
        // and the answer cannot drift from the one the round's opening teleport uses.
        if (decision.team !== undefined) this.setTeam(player, decision.team);

        player.LoadCharacter();
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
    }

    /** Put `player` on `team` — in the table the round counts from, and on the player. */
    private setTeam(player: Player, team: TeamLabel): void {
        this.teams.set(player, team);
        player.SetAttribute(TEAM_ATTRIBUTE, team);
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
    }

    /**
     * The place's lobby spawn, or nothing if the place has none.
     *
     * **A lookup rather than a rule, and that is the whole of what changed.** This used to be
     * `getSpawn(name)`, which `error()`ed — the right *answer* to "this place has no lobby", thrown
     * from the wrong place: it is called from inside {@link gameLoop}, and a throw from there rejects
     * the loop's promise and stops the round system for the rest of the session. See
     * {@link waitForLobby} for the rule that replaced it, and the round boundary further down for the
     * same lesson already learned about the map.
     *
     * **It walks `Workspace` rather than taking the first thing of that name, and that is the second
     * bug this lookup had.** `FindFirstChild(name, true)` answers with the first instance *of that
     * name*, whatever it is — so a single Folder or Model called `LobbySpawn` anywhere in the world
     * shadows the real part and the whole lookup reads as "no lobby", with the part it wanted sitting
     * a few studs away. That is exactly what a lookup that works at start-up and stops working once a
     * map is placed looks like: the arena arrives, it holds something of that name, and the answer
     * flips. **The type has to be part of the question, not a check applied to an answer that has
     * already been chosen.**
     *
     * **Looked up anywhere in `Workspace`, not only at its root.** The lobby was once a loose part at
     * the root and a plain `FindFirstChild(name)` was written to that shape, which broke the moment
     * the part was tidied into a model — and broke *silently*, because a part present in the place
     * and missed by a too-shallow lookup is a part the loop simply sits waiting for. Anywhere in
     * `Workspace` means a lobby can be restructured as freely as a map can.
     *
     * **A map's own copy is skipped.** A map is placed in `Workspace` for the length of a round and
     * this runs at the boundary, when the outgoing map is still standing there — so a `LobbySpawn`
     * inside an arena is the one copy that must never win. The lobby is the part of the world no map
     * owns; this is where that is enforced rather than assumed.
     *
     * The walk is the whole of `Workspace`, once an intermission — or once a second while waiting for
     * one, which is a few hundred instances next to the map clone it sits beside.
     */
    private lobbySpawn(): CFrame | undefined {
        const map = this.maps.getCurrent();

        for (const descendant of Workspace.GetDescendants()) {
            if (descendant.Name !== ARENA_CONFIG.LOBBY_SPAWN_NAME) continue;
            if (!descendant.IsA("BasePart")) continue;
            if (map !== undefined && descendant.IsDescendantOf(map)) continue;

            return descendant.CFrame.add(new Vector3(0, 3, 0));
        }

        return undefined;
    }

    /**
     * What the world has to say about the lobby it is missing, as one sentence.
     *
     * **The distinction this exists to draw is between "absent" and "present but unusable"**, because
     * those two read identically from the warning alone and have completely different fixes: one is a
     * part to add, the other is a part to correct. It is worth a second walk for that, and it is only
     * taken when the lookup has already failed — once per hold, not per frame.
     *
     * Anything found is reported with its full path and its class, which is the pair somebody needs:
     * the path says where it is, and the class says why it was not good enough.
     */
    private describeLobbyCandidates(): string {
        const named: string[] = [];

        for (const descendant of Workspace.GetDescendants()) {
            if (descendant.Name !== ARENA_CONFIG.LOBBY_SPAWN_NAME) continue;

            named.push(`${descendant.GetFullName()} (${descendant.ClassName})`);
        }

        if (named.size() === 0) return `Nothing in Workspace is named "${ARENA_CONFIG.LOBBY_SPAWN_NAME}".`;

        return `Workspace has ${named.join(", ")} — and none of those is a BasePart outside a map.`;
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
     */
    private async waitForLobby(): Promise<CFrame> {
        let waiting = false;

        while (true) {
            const lobby = this.lobbySpawn();

            if (lobby !== undefined) {
                if (waiting) print(`[Round] ${ARENA_CONFIG.LOBBY_SPAWN_NAME} found — the intermission can run`);
                return lobby;
            }

            if (!waiting) {
                waiting = true;

                warn(
                    `[Round] no "${ARENA_CONFIG.LOBBY_SPAWN_NAME}" in Workspace — holding the intermission ` +
                        `until there is one. Everyone is standing in the arena, which is destroyed at the ` +
                        `end of an intermission, so there is nowhere to put them until it exists. ` +
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
        return this.getRandomTeamSpawn(this.teams.get(player) === TEAM_B ? TEAM_B : TEAM_A);
    }

    /**
     * One of `team`'s spawn parts, picked uniformly at random.
     *
     * **A folder of parts inside the loaded map**, one per place a player may stand, rather than a
     * spread around a point. A spread could not know how big the platform underneath it was, so it
     * could walk people off the edge — and the answer to that would have been a radius small enough
     * to defeat the point. A part is a spot somebody has looked at and decided is a fine place to
     * begin; the randomness is then only *which* of those spots, a choice with no geometry in it.
     *
     * **The map is asked for its spawns, by path, at the moment they are needed.** Nothing caches
     * the parts or the folder across a round: the map they belong to is destroyed at the next
     * intermission, so anything held here would be a reference into a torn-down model — the kind of
     * stale handle that works until a swap happens and then places somebody in the void.
     *
     * **Every failure here is an error, and that is the enforcement.** These are only reachable if
     * the load sequence failed earlier — no map was loaded, or the map is missing its spawns — and
     * both mean a round cannot start. A round that began with everybody in the lobby would look like
     * a hang; an error names what is wrong.
     *
     * Only **direct** `BasePart` children count. A `Model` full of parts is not a spawn and is
     * skipped rather than searched, so there is one rule about what a spawn is and the errors above
     * describe it exactly.
     */
    private getRandomTeamSpawn(team: TeamLabel): CFrame {
        const map = this.maps.getCurrent();
        if (map === undefined) error(`[Round] no map loaded — cannot resolve team ${team} spawns`);

        const parts = teamSpawnParts(map, team);

        // Still an error, even though the round boundary refuses a map like this before it gets
        // here. This is the enforcement the round leans on: a caller that skipped the boundary, or
        // a map that lost its spawns mid-round, finds out here rather than placing somebody in the
        // void. `mapProblem` is what turns the same emptiness into the sentence a person reads.
        if (parts.size() === 0) {
            error(`[Round] no spawn parts at ${map.Name}.${ARENA_CONFIG.ARENA_SPAWNS_FOLDER}.${teamFolderName(team)}`);
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
     */
    private teleportTeamsToArena() {
        for (const player of Players.GetPlayers()) {
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
     * finished, in the hand of somebody being moved out of the arena that is about to be destroyed.
     *
     * **Destroyed rather than dropped.** The hand it is in is on its way to the lobby, and a drop
     * would put the ball on the arena floor a moment before that floor stops existing. A ball that is
     * destroyed has no position to be wrong about, which is the same argument {@link clearHeldBalls}
     * makes for the same call.
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
     * **Held balls are a round concern, so they are cleaned up here rather than by the map.** A ball in
     * a hand is welded to a *character*, and a character is not a descendant of the arena — so
     * `MapService`'s cleanup, which walks the map, cannot see one however hard it looks. Two cleanups,
     * two owners: this one for what the round is carrying, the map's for what the map contains.
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
            // **Waiting is the only safe answer here, not a fallback position.** Everybody is
            // standing in the arena, and the next lines destroy it — so going on without somewhere to
            // put them would drop the whole server into the void, which is precisely the "everyone in
            // the wrong place" that `LOBBY_SPAWN_NAME`'s note says a missing lobby must never cause.
            // Nothing below this point has run yet, so there is nothing to undo: the loop simply comes
            // back when the part exists.
            //
            // **The phase is already published above, which is what makes a hold visible.** With the
            // publish below this line, a held intermission was indistinguishable from a frozen round
            // — see the note above for what that looked like. See `waitForLobby` for the two lines it
            // prints around one, which is the other half of the same answer.
            this.teleportAll(await this.waitForLobby());

            // **Two cleanups, and this is the order they belong in.** The held balls go first: a ball
            // in a hand is welded to a character, so it is not a descendant of the map and the map's
            // own cleanup can never see one. Then the map, which takes the loose balls, the corpses
            // and everything else that belongs to the arena. The other way round would leave the held
            // balls to be dealt with *after* the arena they were carried on had been destroyed — and
            // the point of doing this at all is that nothing the round owned outlives it.
            this.clearEndedRoundHeldBalls();

            // **The map swap, and this is the only moment it is safe.** Everybody has just been put
            // in the lobby, which lives in `Workspace` and belongs to no map — so there is
            // nobody standing on the arena that is about to be destroyed, and nothing left behind in
            // it. Unloading before loading is what guarantees two arenas are never in `Workspace` at
            // once; `loadMap` does it again internally, so the order is true by construction rather
            // than by this comment.
            //
            // Loading *here* rather than at the round's opening whistle is deliberate, and it is
            // about the `Clone`: that is the expensive half of a swap, and this pays for it while
            // nothing is happening. What is deliberately *not* here is putting it in the world — the
            // clone stays out of `Workspace` until `placeCurrent` runs at the round boundary, so the
            // intermission is not thirty seconds of every client looking at an arena that no round is
            // being played in, which is exactly what a map loaded here and left parented would be.
            this.maps.unloadCurrent();
            this.maps.loadMap(this.maps.pickNext());

            // The clock is published above the lobby wait now — see the note there for why the phase
            // goes out before anything that can hold. Counting starts here, which is what leaves a
            // held intermission sitting at its full length rather than ticking against nothing.

            // Counted beside the clock rather than derived from it, because the two stop for the
            // same reason and at the same moment: a frozen tick `continue`s below without touching
            // either, so this measures *running* seconds. A window timed off the wall clock would
            // close while a round was still being held up.
            let elapsed = 0;

            while (this.timeRemaining > 0) {
                // A paused tick does nothing at all: no second off the clock, no change of
                // state, no teleport. The phase resumes from whatever the clock said when it
                // was switched off, which is the whole difference between pausing and ending.
                //
                // **A server below the minimum freezes in exactly the same way**, and for the same
                // reason: there is no round to be counting down to. This single line is where
                // "freeze, don't skip" lives — the clock is not reset, so a server that fills up
                // later resumes the intermission it was already in, vote window included.
                if (this.isRoundsPaused() || this.belowMinimum()) {
                    task.wait(1);
                    continue;
                }

                // The vote opens on the intermission's **first running second**, which is not the
                // same moment as the intermission *starting*: a server below the minimum is frozen
                // above, so its intermission has not really begun and the window should not be open
                // while nobody is there to vote. Opening it here rather than once before the loop
                // is also what lets a server that fills up thirty seconds later still get this vote.
                if (elapsed === 0) this.votes.openVote();

                task.wait(1);
                this.timeRemaining--;
                elapsed++;
                this.statusFolder.SetAttribute(ROUND_TIME_ATTRIBUTE, this.timeRemaining);

                if (elapsed === GAME_MODE_CONFIG.VOTE_SECONDS) this.votes.closeVote();
            }

            await this.waitWhilePaused();

            // Closed again on the boundary, which is the call that matters when the window never
            // elapsed — a harness paused through the intermission, or a round cut short. It is a
            // no-op if the first close already ran, so this cannot re-roll a tie that has been
            // broken already.
            this.votes.closeVote();

            // The intermission's last act: nobody carries a ball into a round. See
            // `clearHeldBalls` for why it is destroyed here rather than dropped after the teleport.
            this.clearHeldBalls();

            // --- Playing ---

            // **A round whose map cannot host it does not start.**
            //
            // This check exists because of what happens without it, which is worth spelling out
            // because it is not obvious from the code below: `getRandomTeamSpawn` raises when there
            // is no map, which is the right thing for *it* to do — but it is called from inside
            // this loop, and `gameLoop` is an `async` function. roblox-ts turns that into a promise,
            // and a throw inside it rejects the promise instead of unwinding a coroutine. Nothing
            // handles the rejection, so the loop simply stops — for the rest of the server's life.
            //
            // What the player sees is not an error message but a *frozen HUD*: the throw happens
            // before `ROUND_STATE_ATTRIBUTE` is set to `"Playing"`, so the folder still says
            // "Intermission" and the clock still says whatever the last intermission tick left it at.
            // `Intermission — 0s`, for ever, with nothing in the output after the one rejection.
            //
            // Checking here instead costs one intermission rather than the session, and it is
            // checked **before anything is half-started**: no sides are assigned, nobody is marked
            // as playing, no clock is set. The loop goes round, the map is retried, and building the
            // map while the server is running works on the next cycle with no restart.
            const problem = mapProblem(this.maps.getCurrent());

            if (problem !== undefined) {
                print(`[Round] cannot start — ${problem}. Retrying next intermission.`);

                continue;
            }

            // **Now the arena goes into the world.** It was cloned at the top of the intermission so
            // that the cost was paid while nothing was happening, and it has been held out of
            // `Workspace` until here so that nobody spends the intermission looking at it. This is
            // the only ordering that works: after the check above, so a map that cannot host a round
            // is never put into the world only to be taken out again, and before the teleport below,
            // so nobody is ever moved onto an arena that is not there yet.
            this.maps.placeCurrent();

            this.state = RoundState.Playing;

            // The mode for this round, from whatever the vote decided. Resolved once, here, rather
            // than read live: the vote may be opened again during the *next* intermission, and a
            // round must not be able to change its own rules underneath itself.
            this.mode = modeFor(this.votes.selection()) ?? DEFAULT_MODE;

            // A fresh scoreboard for a fresh round: a round that inherited one would be starting
            // in the middle of somebody else's game. The round is also un-finished here — it is
            // exactly the flag's lifetime — so a round ended early by a leaver cannot leave the next
            // one unable to finish at all.
            this.scores.clear();

            // **Both boards go with the scoreboard, and here rather than where the round ends.**
            // Cleared at `finishRound` they would empty the panel that reads them one frame before
            // the intermission they are meant to fill: a board is the round's *record*, so it has to
            // outlive the round by exactly as long as the intermission does, and clearing it at the
            // next round's opening is what gives it that lifetime. See `roundHits` and `roundOuts`.
            this.roundHits.clear();
            this.roundOuts.clear();

            this.finished = false;

            this.assignTeams();

            for (const player of Players.GetPlayers()) {
                this.activePlayers.add(player);

                // In the round, therefore not spectating. This is where last round's eliminated
                // players come back, which is the whole of "the indicator goes when a round
                // starts" — written for everybody in the round rather than only for those who
                // were marked, because a mid-round joiner is marked too and is now playing.
                player.SetAttribute(SPECTATING_ATTRIBUTE, false);
            }
            print(`Round started — ${GAME_MODE_NAMES[this.mode.id]}`);
            this.teleportTeamsToArena();

            this.timeRemaining = ARENA_CONFIG.ROUND_SECONDS;
            this.statusFolder.SetAttribute(ROUND_STATE_ATTRIBUTE, "Playing");
            this.statusFolder.SetAttribute(ROUND_TIME_ATTRIBUTE, this.timeRemaining);
            // Cleared where the *playing* phase opens, not where an intermission does. The
            // intermission that follows a round is precisely the one that should still be showing
            // what that round decided, so clearing at the intermission's own start would wipe
            // every winner a frame after it was set.
            this.statusFolder.SetAttribute(ROUND_WINNER_ATTRIBUTE, "");

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

/** The name of `team`'s spawn folder inside a map. The labels are the folder names. */
function teamFolderName(team: TeamLabel): string {
    return team === TEAM_B ? ARENA_CONFIG.ARENA_TEAM_FOLDER_B : ARENA_CONFIG.ARENA_TEAM_FOLDER_A;
}

/**
 * The `BasePart` children of `map`'s spawn folder for `team`.
 *
 * **One traversal, two callers that disagree about what emptiness means** — the round boundary
 * skips the round, the spawn picker throws — so "what counts as a spawn" is decided once and the
 * argument is about policy rather than about the place file. It answers with a list rather than a
 * reason for exactly that reason; {@link mapProblem} is what turns the list back into words.
 *
 * Only **direct** `BasePart` children count. A `Model` full of parts is not a spawn and is skipped
 * rather than searched, which keeps "is this a spawn?" a question about one folder's children.
 */
function teamSpawnParts(map: Model, team: TeamLabel): BasePart[] {
    const spawns = map.FindFirstChild(ARENA_CONFIG.ARENA_SPAWNS_FOLDER);
    if (spawns === undefined) return [];

    const folder = spawns.FindFirstChild(teamFolderName(team));
    if (folder === undefined) return [];

    const parts: BasePart[] = [];

    for (const child of folder.GetChildren()) {
        if (child.IsA("BasePart")) parts.push(child);
    }

    return parts;
}

/**
 * Why `map` cannot host a round, or `undefined` if it can.
 *
 * **A sentence rather than a boolean**, because this is read by somebody looking at a place file
 * rather than by code: the string names the full path that is missing or empty, which is the one
 * thing they need to know, and the same string serves the output line and the error.
 *
 * Takes `Model | undefined` rather than a `Model`, so that "nothing is loaded" — the case that
 * actually happens when `MAP_CONFIG.MAP_NAMES` names a map nobody has built yet — is one of the
 * ordinary answers rather than something every caller has to check first.
 *
 * **Both sides are checked, not just a named one.** A round needs both, so a map missing either
 * cannot host a round whatever the caller was about to do with the other, and a map that is half
 * built should be reported as such the first time it is tried rather than at the second team's
 * teleport.
 */
function mapProblem(map: Model | undefined): string | undefined {
    if (map === undefined) return "no map is loaded";

    for (const team of TEAM_LABELS) {
        if (teamSpawnParts(map, team).size() > 0) continue;

        return `${map.Name}.${ARENA_CONFIG.ARENA_SPAWNS_FOLDER}.${teamFolderName(team)} is missing or has no BasePart children`;
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
 * **`IsDescendantOf(Workspace)` is the filter that makes it safe**, and it is the same guard
 * `BallSpawnerService` uses before it reparents a loose ball back into the map. A tagged rig that is
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