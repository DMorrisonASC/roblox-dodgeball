import { Service, OnStart } from "@flamework/core";
import { Players } from "@rbxts/services";
import { THROWER_TOKEN } from "shared/constants";
import { BallService } from "../ball/BallService";

@Service()
export class JoinService implements OnStart {
    constructor(private readonly balls: BallService) {}

    onStart() {
        Players.PlayerAdded.Connect((player) => {
            this.welcome(player);
        });

        // Catch players who joined before this service started
        for (const player of Players.GetPlayers()) {
            this.welcome(player);
        }
    }

    /**
     * Everything a joining player needs: an identity, and a ball in the hand.
     *
     * The last place a `Player` is turned into a `Model` for the ball system, and
     * it belongs here: who joined, and who respawned, is a fact about players,
     * while holding and throwing a ball is not. The token is the player's `UserId`
     * as text — the same *kind* of thing an NPC carries — so nothing downstream
     * has to care which of them threw a ball. See THROWER_TOKEN.
     */
    private welcome(player: Player) {
        const token = tostring(player.UserId);

        /** Identity first, then the ball: a ball is only attributable once its holder is. */
        const handOut = (character: Model) => {
            character.SetAttribute(THROWER_TOKEN, token);
            this.balls.giveBall(character);
        };

        // Characters respawn, so the hand-out is arranged per character, not per player.
        player.CharacterAdded.Connect(handOut);

        const character = player.Character;
        if (character) {
            handOut(character);
        }
    }
}