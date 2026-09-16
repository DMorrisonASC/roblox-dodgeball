import { Service, OnStart } from "@flamework/core";
import { Players } from "@rbxts/services";
import { SphereService } from "./SphereService";

@Service()
export class JoinService implements OnStart {
    constructor(private readonly spheres: SphereService) {}

    onStart() {
        Players.PlayerAdded.Connect((player: Player) => {
            this.spheres.spawnAt(new Vector3(0, 10, 0), `${player.Name}_Sphere`);
        });
    }
}