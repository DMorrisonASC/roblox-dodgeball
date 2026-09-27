import { Service, OnStart } from "@flamework/core";
import { Players, Workspace } from "@rbxts/services";
import { ARENA_CONFIG } from "shared/config/arena.config";
import { GAME_MODE_CONFIG } from "shared/config/gameMode.config";
import { GAME_MODE_NAMES } from "shared/gameMode";
import {
    ROUND_STATE_ATTRIBUTE,
    ROUND_TIME_ATTRIBUTE,
    ROUND_WINNER_ATTRIBUTE,
    SPECTATING_ATTRIBUTE,
    TEAM_ATTRIBUTE,
} from "shared/constants";
import { DevService } from "../../dev/DevService";
import { BallService } from "../ball/BallService";
import { GameMode, RoundView } from "./modes/GameMode";
import { DEFAULT_MODE, modeFor } from "./modes/registry";
import { roundStatusFolder } from "./roundStatus";
import { DRAW, RoundOutcome, TEAM_A, TEAM_B, TeamLabel } from "./team";
import { VoteService } from "./VoteService";

enum RoundState {
    Intermission,
    Playing,
}

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
     * Who a throw has landed on since they last spawned.
     *
     * **The answer to a question `Humanoid.Died` cannot answer.** A death says nothing about its
     * cause — a ball, a fall out of the world and the reset button are one event — and Dodge and
     * Seek's rules turn on exactly that difference, because a player who is *hit* becomes a seeker
     * and counts as one, while a player who *resets* becomes a seeker and explicitly does not.
     *
     * So a hit is written here when it lands, read once when the death arrives, and dropped either
     * way — and cleared again on respawn, which is what makes it "hit this life" rather than "hit
     * at some point in this round". The second distinction only starts to matter the moment a mode
     * sends somebody back in, which is why it is already right here.
     */
    private readonly hitThisRound = new Set<Player>();

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
    ) {}

    onStart() {
        Players.PlayerAdded.Connect((player) => this.handlePlayerJoined(player));
        Players.PlayerRemoving.Connect((player) => {
            this.activePlayers.delete(player);
            this.teams.delete(player);
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
     * **The rules are the mode's; the question is the round's.** All this does is hand the mode
     * the round to look at — see `RoundView` — and pass the answer back, which is what keeps "how
     * do you win" in one file per mode rather than in a pile of branches growing here. Team
     * Elimination's answer is last-side-standing, Score Rush's is the target score or the clock,
     * and Dodge and Seek's will be whether any dodger is still un-hit.
     */
    private roundOutcome(): RoundOutcome | undefined {
        return this.mode.outcome(this);
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
            // A new life starts un-hit. Per *life* rather than per round, because the question a
            // mode asks of this record — "was this death a throw, or a reset?" — is only
            // answerable that way once a mode sends people back in. See `hitThisRound`.
            this.hitThisRound.delete(player);

            const humanoid = character.WaitForChild("Humanoid") as Humanoid;
            humanoid.Died.Connect(() => this.handleDeath(player));

            const root = character.WaitForChild("HumanoidRootPart") as BasePart;

            // Route based on whether they're still in the round, and — for a round — on which
            // side they are on. A player who died is out of `activePlayers` by the time this
            // runs, so they land in the lobby like any other spectator, which is the existing
            // behaviour and not a team's side.
            const inRound = this.state === RoundState.Playing && this.activePlayers.has(player);

            character.PivotTo(inRound ? this.arenaSpawnFor(player) : this.getSpawn(ARENA_CONFIG.LOBBY_SPAWN_NAME));
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
     */
    private handleDeath(player: Player): void {
        // Read and dropped in one go: a hit is worth at most one death, and the answer is about
        // *this* life rather than the round so far.
        const byHit = this.hitThisRound.has(player);
        this.hitThisRound.delete(player);

        // A death in the lobby is not an elimination, so nothing is written outside a round.
        if (this.state !== RoundState.Playing) return;

        // Already out — a spectator who dies again is still a spectator. This is the case the
        // old code covered by clearing `activePlayers` unconditionally and then re-marking them.
        if (!this.activePlayers.has(player)) {
            player.SetAttribute(SPECTATING_ATTRIBUTE, true);
            return;
        }

        const decision = this.mode.onDeath({ player, byHit }, this);

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

    /** Out of the round, watching the rest of it. */
    private eliminate(player: Player): void {
        this.activePlayers.delete(player);
        player.SetAttribute(SPECTATING_ATTRIBUTE, true);
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
     * Recorded even when it scores nothing: a mode that awards no points still has to know that a
     * throw landed, because the death arriving a moment later is read against it.
     */
    public registerHit(throwerToken: string, victim: Model): void {
        if (this.state !== RoundState.Playing) return;

        const victimPlayer = Players.GetPlayerFromCharacter(victim);
        if (victimPlayer === undefined || !this.activePlayers.has(victimPlayer)) return;

        this.hitThisRound.add(victimPlayer);

        // **A mode that keeps no score is not asked what a hit is worth.** See `GameMode.scores`:
        // a scoreless mode has no hit rule to state, so asking anyway would make every mode carry a
        // method whose only correct answer is "nothing" — and would call it on every landed hit of
        // every round for no reason. The hit itself is still recorded above, because *that* is not
        // a scoring question: a mode with no points may still need to know a throw landed.
        if (!this.mode.scores) return;

        const thrower = playerFromToken(throwerToken);

        const award = this.mode.hitAward({ thrower, victim: victimPlayer }, this);
        if (award === undefined || thrower === undefined) return;

        const scoring = this.teams.get(thrower);
        if (scoring === undefined) return;

        this.scores.set(scoring, (this.scores.get(scoring) ?? 0) + award);
    }

    private getSpawn(name: string): CFrame {
        const spawn = Workspace.FindFirstChild(name) as BasePart | undefined;
        if (!spawn) error(`Missing spawn part: ${name}`);
        return spawn.CFrame.add(new Vector3(0, 3, 0));
    }

    /**
     * The arena spawn for `player`'s side.
     *
     * **The one place the side-to-spawn mapping lives**, so a round's opening teleport and a
     * respawn mid-round cannot send the same player to different ends of the arena. A player
     * with no team — somebody who joined while a round was already under way — is treated as
     * A's, here and at the round start alike; they are not in `activePlayers`, so this is the
     * only moment it ever matters for them.
     */
    private arenaSpawnFor(player: Player): CFrame {
        const name =
            this.teams.get(player) === TEAM_B ? ARENA_CONFIG.ARENA_SPAWN_NAME_B : ARENA_CONFIG.ARENA_SPAWN_NAME_A;

        return this.getSpawn(name);
    }

    /** Everyone to one place. The lobby's business: no side is on the lobby's side. */
    private teleportAll(spawnName: string) {
        const cframe = this.getSpawn(spawnName);
        for (const player of Players.GetPlayers()) {
            const character = player.Character;
            if (character) character.PivotTo(cframe);
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

    private async gameLoop() {
        while (true) {
            // --- Intermission ---
            this.state = RoundState.Intermission;
            this.activePlayers.clear();
            print("Intermission started");
            this.teleportAll(ARENA_CONFIG.LOBBY_SPAWN_NAME);

            this.timeRemaining = ARENA_CONFIG.INTERMISSION_SECONDS;
            // The phase goes out as its own name, which is the HUD's entire vocabulary. Those two
            // words are `RoundState`'s members by convention rather than by construction, so
            // renaming a member means renaming the string here.
            this.statusFolder.SetAttribute(ROUND_STATE_ATTRIBUTE, "Intermission");
            // Published with the clock rather than only after the first second comes off it, so
            // the HUD never shows the *previous* phase's final number under the new phase's name.
            this.statusFolder.SetAttribute(ROUND_TIME_ATTRIBUTE, this.timeRemaining);

            // The vote opens with the intermission, so the window is exactly as long as it says
            // it is rather than as long as the remainder of the phase happens to allow.
            this.votes.openVote();

            // Counted beside the clock rather than derived from it, because the two stop for the
            // same reason and at the same moment: a paused tick `continue`s below without touching
            // either, so this measures *running* seconds. A window timed off the wall clock would
            // close while a paused round was still being held up.
            let elapsed = 0;

            while (this.timeRemaining > 0) {
                // A paused tick does nothing at all: no second off the clock, no change of
                // state, no teleport. The phase resumes from whatever the clock said when it
                // was switched off, which is the whole difference between pausing and ending.
                if (this.isRoundsPaused()) {
                    task.wait(1);
                    continue;
                }

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
            this.state = RoundState.Playing;

            // The mode for this round, from whatever the vote decided. Resolved once, here, rather
            // than read live: the vote may be opened again during the *next* intermission, and a
            // round must not be able to change its own rules underneath itself.
            this.mode = modeFor(this.votes.selection()) ?? DEFAULT_MODE;

            // A fresh scoreboard and no memory of who was hit — both are round state, and a round
            // that inherited either would be starting in the middle of somebody else's story.
            this.scores.clear();
            this.hitThisRound.clear();

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
                if (this.isRoundsPaused()) {
                    task.wait(1);
                    continue;
                }

                task.wait(1);
                this.timeRemaining--;
                this.statusFolder.SetAttribute(ROUND_TIME_ATTRIBUTE, this.timeRemaining);

                // Checked after the clock moves, so a round ends on the tick its last second
                // runs out rather than a tick later. A side being wiped out is checked on
                // every tick, which is what makes a round end the moment the last player on a
                // team goes down — with whatever time was left unspent.
                const outcome = this.roundOutcome();
                if (outcome !== undefined) {
                    // Built before it is printed: a nested template inside an interpolated
                    // string is one more thing for a reader to unpick, and the message is the
                    // part worth reading. `sideName` rather than a hard-coded "Team", because a
                    // mode is allowed to call its two sides something else — see `sideName`.
                    const result = outcome === DRAW ? "a draw" : `${this.mode.sideName(outcome)} won`;

                    // The score, for a mode that keeps one. Printed here rather than at every
                    // point that changes it: a line per hit would bury the round's own output,
                    // and the number only means anything next to who won.
                    if (this.mode.scores) {
                        const pointsA = this.scores.get(TEAM_A) ?? 0;
                        const pointsB = this.scores.get(TEAM_B) ?? 0;

                        print(`[Round] score — A ${pointsA}, B ${pointsB}`);
                    }

                    // The same word the message uses, and the vocabulary the HUD expects: a
                    // team's label, or `"draw"`. Written before the round is left, because the
                    // intermission that follows is where it is read.
                    this.statusFolder.SetAttribute(ROUND_WINNER_ATTRIBUTE, outcome);

                    print(`[Round] ${result}`);
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