import { Flamework } from "@flamework/core";
import { Players } from "@rbxts/services";
import { ARENA_CONFIG } from "shared/config/arena.config";
import { startCollisionGroups } from "./collision/CollisionGroups";
import { startSpawnShield } from "./services/character/SpawnShield";

print("[main] igniting");

// **Before `ignite()`, and the ordering is the point rather than the tidiness.** A service's
// `onStart` runs inside `Flamework.ignite()`, and `RoundService` is one of them — it puts the arena's
// `CharacterBarrier` parts into the `Barrier` group at the round boundary, which is the first thing
// that reads the group. Registering after the ignite would be registering after that had already run.
startCollisionGroups();

Flamework.addPaths("src/server/services");
Flamework.addPaths("src/server/components");
Flamework.addPaths("src/server/dev");
Flamework.ignite();

// **The engine no longer gives anybody a character, and that is the whole of this line.** The two respawn
// rules this project wants cannot both belong to the engine: a death outside a round wants a body *now*, and
// the way to ask for that is `RespawnTime = 0` — while a death inside one wants a three-second wait.
// `RespawnTime` is one number for every death and the engine does not know a round exists, so with auto-load
// on the setting that makes the lobby instant makes the round instant too, and the in-round delay cannot
// exist beside it. So it is off, and `RespawnService` is the only thing in the project that loads a
// character: a join, a death outside a round, an elimination, and the in-round respawn the arena's own delay
// schedules.
//
// **A missed load site under this regime is a player with no body and nothing in the output**, which is the
// risk the whole arrangement is built around — see `RespawnService`'s class doc, which is where the discipline
// is written down: one method calls the engine's load, and every path that needs a body goes through it.
//
// `Players.RespawnTime` is deliberately *not* set. With the engine off it governs nothing, and a line here
// would read as though it did — the delay that matters is the one `RoundService` asks `RespawnService` for.
Players.CharacterAutoLoads = false;

print(
	`[main] respawn — CharacterAutoLoads false,` +
		` ${ARENA_CONFIG.RESPAWN_DELAY_SECONDS}s in-round delay`,
);

// **After the ignite, deliberately, and the difference from the call above is the point.** Nothing
// reads a `ForceField` while services are starting, so this has no ordering to respect — and a
// starter that had to be hoisted would be one more thing to remember when a service next grows a
// dependency on a shield. It is here rather than inside a service because a `ForceField` outliving
// or predeceasing the round is a fact about bodies, not about rounds.
startSpawnShield();

print("[main] ignited");
