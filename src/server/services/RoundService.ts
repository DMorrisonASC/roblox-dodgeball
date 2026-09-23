import { Service, OnStart } from "@flamework/core";
import { Players, Workspace } from "@rbxts/services";
import { ARENA_CONFIG } from "shared/config/arena.config";
import { TEAM_ATTRIBUTE } from "shared/constants";
import { DevService } from "../dev/DevService";

enum RoundState {
    Intermission,
    Playing,
}

/** The two sides. The labels are what `TEAM_ATTRIBUTE` holds and what `teams` maps to. */
const TEAM_A = "A";
const TEAM_B = "B";

/** What a round reports when neither side has won it. */
const DRAW = "draw";

/**
 * A side's label — what `TEAM_ATTRIBUTE` holds, and what `teams` maps a player to.
 *
 * Named a *label* and not a `Team`, which is a Roblox class: this file may well want team
 * objects later (per-team spawns are the obvious next thing), and a type alias shadowing that
 * name would have to be undone first.
 */
type TeamLabel = typeof TEAM_A | typeof TEAM_B;

/** Who won a round — a side, or nobody. `undefined` means the round is still on. */
type RoundOutcome = TeamLabel | typeof DRAW;

@Service()
export class RoundService implements OnStart {
    private state = RoundState.Intermission;
    private timeRemaining = 0;
    private readonly activePlayers = new Set<Player>();

    /**
     * Who is on which team this round.
     *
     * A table *beside* the attribute rather than instead of it, and both written in the one
     * place, `assignTeams`. The attribute is what other systems read — a HUD, a per-team
     * spawn — and this is what the countdown reads once a second, without going through the
     * instance tree to ask the same question eighty times a round.
     */
    private readonly teams = new Map<Player, TeamLabel>();

    constructor(private readonly dev: DevService) {}

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

    /**
     * Splits the server into two sides, as evenly as they go, and puts the labels on them.
     *
     * **Assigned at the start of every round, never on join.** A player arriving mid-round
     * cannot shift the balance of a round already under way, and nobody carries a team into
     * the next one — which is both fairer and the reason this clears the table rather than
     * topping it up.
     *
     * The split is by *position* in a shuffled list, because there is nothing to balance on
     * yet and a shuffle is the honest form of "evenly": anything else would be a claim about
     * who should be together. `ceil` rather than `floor` is what puts the odd player on A, so
     * the two sides are the ceiling and the floor of half the server.
     */
    private assignTeams(): void {
        const players = Players.GetPlayers();

        // Fisher-Yates, in place, over the array `GetPlayers` just handed back.
        for (let index = players.size() - 1; index > 0; index--) {
            const other = math.random(0, index);
            const swap = players[index];

            players[index] = players[other];
            players[other] = swap;
        }

        const split = math.ceil(players.size() / 2);

        this.teams.clear();

        for (let index = 0; index < players.size(); index++) {
            const player = players[index];
            const team: TeamLabel = index < split ? TEAM_A : TEAM_B;

            this.teams.set(player, team);
            player.SetAttribute(TEAM_ATTRIBUTE, team);
        }
    }

    /**
     * Who has won, if anybody has, or `undefined` if the round is still on.
     *
     * Two ways to win, and the first outranks the clock: **eliminating the other side**, and
     * otherwise **having more players left when the time runs out**. Nobody left on either
     * side is a draw however much time remains — there is nothing left to win with, and that
     * same case is what stops an empty server from sitting inside a round forever.
     *
     * Counted by walking the living, not by keeping a tally: `activePlayers` is the one place
     * that knows who is still in the round, and a per-team count kept beside it would be a
     * second answer to the same question, free to disagree with the first.
     */
    private roundOutcome(): RoundOutcome | undefined {
        let standingA = 0;
        let standingB = 0;

        for (const player of this.activePlayers) {
            const team = this.teams.get(player);
            if (team === TEAM_A) standingA++;
            else if (team === TEAM_B) standingB++;
        }

        if (standingA === 0 && standingB === 0) return DRAW;
        if (standingA === 0) return TEAM_B;
        if (standingB === 0) return TEAM_A;

        if (this.timeRemaining > 0) return undefined;
        if (standingA > standingB) return TEAM_A;
        if (standingB > standingA) return TEAM_B;

        return DRAW;
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
            const humanoid = character.WaitForChild("Humanoid") as Humanoid;
            humanoid.Died.Connect(() => {
                this.activePlayers.delete(player);
            });

            const root = character.WaitForChild("HumanoidRootPart") as BasePart;

            // Route based on whether they're still in the round, and — for a round — on which
            // side they are on. A player who died is out of `activePlayers` by the time this
            // runs, so they land in the lobby like any other spectator, which is the existing
            // behaviour and not a team's side.
            const inRound = this.state === RoundState.Playing && this.activePlayers.has(player);

            character.PivotTo(inRound ? this.arenaSpawnFor(player) : this.getSpawn(ARENA_CONFIG.LOBBY_SPAWN_NAME));
        });
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

    private async gameLoop() {
        while (true) {
            // --- Intermission ---
            this.state = RoundState.Intermission;
            this.activePlayers.clear();
            print("Intermission started");
            this.teleportAll(ARENA_CONFIG.LOBBY_SPAWN_NAME);

            this.timeRemaining = ARENA_CONFIG.INTERMISSION_SECONDS;
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
            }

            await this.waitWhilePaused();

            // --- Playing ---
            this.state = RoundState.Playing;
            this.assignTeams();

            for (const player of Players.GetPlayers()) {
                this.activePlayers.add(player);
            }
            print("Round started");
            this.teleportTeamsToArena();

            this.timeRemaining = ARENA_CONFIG.ROUND_SECONDS;
            while (this.timeRemaining > 0) {
                if (this.isRoundsPaused()) {
                    task.wait(1);
                    continue;
                }

                task.wait(1);
                this.timeRemaining--;

                // Checked after the clock moves, so a round ends on the tick its last second
                // runs out rather than a tick later. A side being wiped out is checked on
                // every tick, which is what makes a round end the moment the last player on a
                // team goes down — with whatever time was left unspent.
                const outcome = this.roundOutcome();
                if (outcome !== undefined) {
                    // Built before it is printed: a nested template inside an interpolated
                    // string is one more thing for a reader to unpick, and the message is the
                    // part worth reading.
                    const result = outcome === DRAW ? "a draw" : `Team ${outcome} won`;

                    print(`[Round] ${result}`);
                    break;
                }
            }

            await this.waitWhilePaused();
        }
    }
}