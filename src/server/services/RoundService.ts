import { Service, OnStart } from "@flamework/core";
import { Players, Workspace } from "@rbxts/services";

enum RoundState {
    Intermission,
    Playing,
}

@Service()
export class RoundService implements OnStart {
    private state = RoundState.Intermission;
    private timeRemaining = 0;

    private readonly INTERMISSION_TIME = 10;
    private readonly ROUND_TIME = 30;

    onStart() {
        Players.PlayerAdded.Connect((player) => this.handlePlayerJoined(player));

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
    private handlePlayerJoined(player: Player) {
        player.CharacterAdded.Connect((character) => {
            // Character needs a moment to fully assemble
            const root = character.WaitForChild("HumanoidRootPart") as BasePart;

            // Send to the right place based on current round state
            const spawn = this.state === RoundState.Playing
                ? this.getSpawn("ArenaSpawn")
                : this.getSpawn("LobbySpawn");

            character.PivotTo(spawn);
        });
    }

    private getSpawn(name: string): CFrame {
        const spawn = Workspace.FindFirstChild(name) as BasePart | undefined;
        if (!spawn) error(`Missing spawn part: ${name}`);
        return spawn.CFrame.add(new Vector3(0, 3, 0)); // lift slightly so players don't clip
    }

    private teleportAll(spawnName: string) {
        const cframe = this.getSpawn(spawnName);
        for (const player of Players.GetPlayers()) {
            const character = player.Character;
            if (character) character.PivotTo(cframe);
        }
    }

    private async gameLoop() {
        while (true) {
            // --- Intermission ---
            this.state = RoundState.Intermission;
            print("Intermission started");
            this.teleportAll("LobbySpawn");

            this.timeRemaining = this.INTERMISSION_TIME;
            while (this.timeRemaining > 0) {
                task.wait(1);
                this.timeRemaining--;
            }

            // --- Playing ---
            this.state = RoundState.Playing;
            print("Round started");
            this.teleportAll("ArenaSpawn");

            this.timeRemaining = this.ROUND_TIME;
            while (this.timeRemaining > 0) {
                task.wait(1);
                this.timeRemaining--;
            }
        }
    }
}