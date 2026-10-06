import { Service, OnStart } from "@flamework/core";
import { Players } from "@rbxts/services";
import { THROWER_TOKEN } from "shared/constants";
import { RespawnService } from "../character/RespawnService";

@Service()
export class JoinService implements OnStart {
    constructor(private readonly respawns: RespawnService) {}

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
     * Everything a joining player needs: **an identity, and deliberately nothing to throw.**
     *
     * The last place a `Player` is turned into a `Model` for the ball system, and it belongs here: who
     * joined, and who respawned, is a fact about players, while holding and throwing a ball is not. The
     * token is the player's `UserId` as text — the same *kind* of thing an NPC carries — so nothing
     * downstream has to care which of them threw a ball. See THROWER_TOKEN.
     *
     * **A player is handed no ball, and that is a rule rather than an omission.** This is the
     * `CharacterAdded` path, so a ball given here is one ball per *body*: it fired on every join, on
     * every respawn, and once more for the body that already existed when the server started — which
     * made dying a way to manufacture a ball, and made the arena's ball supply meaningless. The two
     * alternatives are both worse than giving none. One ball on join only is the same fault with a
     * longer fuse, because a player who has thrown theirs still gets a fresh one by dying. One ball per
     * *player* needs somewhere to keep it while the body is gone, which is a second inventory in a game
     * whose entire ball economy is the arena floor.
     *
     * So balls for players come from the arena: `BallSpawnerService` stocks the floor while a match is
     * running, and a pickup arms whoever reaches one. A player who arrives, respawns, or leaves a body
     * behind is unarmed until they fetch a ball — the same rule that already applies to them the moment
     * they throw one.
     *
     * **Rigs are the other population, and they are not this method's business.** An NPC gets its ball
     * from its own throwing behavior — see `ThrowBehavior.prepare` — which is a different call to the
     * same `BallService.giveBall`, and is untouched by any of this.
     */
    private welcome(player: Player) {
        const token = tostring(player.UserId);

        /** Identity, on every body: a model is only attributable once it carries the token. */
        const stampToken = (character: Model) => {
            character.SetAttribute(THROWER_TOKEN, token);
        };

        // Characters respawn, so the token is stamped per character, not per player.
        player.CharacterAdded.Connect(stampToken);

        const character = player.Character;
        if (character) {
            stampToken(character);
        }

        // **And then a body, which the engine no longer provides.** `Players.CharacterAutoLoads` is off — see
        // `main.server.ts` for why — so a joining player has nothing until this project loads one, and this is
        // the join half of that: the only other place a body comes from is `RoundService`, which loads after a
        // death. A player arriving and never appearing is what a missing load looks like, which is the whole
        // subject of `RespawnService`'s class doc.
        //
        // **After the connection above, never before it.** The load is what fires `CharacterAdded`, and the
        // token is stamped *by* that handler — so loading first would hand the server a body with no token on
        // it, which is a model the ball system cannot attribute to anybody: the thrower of its ball, the
        // owner of its save, and the name on its damage would all be nothing. The order is therefore load
        // *after* subscribing, and the `if` above is the same rule for a body that somehow already exists.
        this.respawns.loadNow(player, "joined");
    }
}