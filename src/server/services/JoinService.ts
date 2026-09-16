import { Service, OnStart } from "@flamework/core";
import { Players } from "@rbxts/services";
import { SphereService } from "./SphereService";

@Service()
export class JoinService implements OnStart {
    constructor(private readonly spheres: SphereService) {}

    onStart() {
        Players.PlayerAdded.Connect((player) => {
            this.spheres.spawnAt(new Vector3(0, 10, 0), `${player.Name}_Sphere`);
        });

        // Catch players who joined before this service started
        for (const player of Players.GetPlayers()) {
            this.spheres.spawnAt(new Vector3(0, 10, 0), `${player.Name}_Sphere`);
        }
    }
}