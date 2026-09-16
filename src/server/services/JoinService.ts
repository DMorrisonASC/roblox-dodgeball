import { Service, OnStart } from "@flamework/core";
import { Players } from "@rbxts/services";
import { BallService } from "./BallService";

@Service()
export class JoinService implements OnStart {
    constructor(private readonly balls: BallService) {}

    onStart() {
        Players.PlayerAdded.Connect((player) => {
            this.balls.giveBall(player);
        });

        // Catch players who joined before this service started
        for (const player of Players.GetPlayers()) {
            this.balls.giveBall(player);
        }
    }
}