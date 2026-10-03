import { Flamework } from "@flamework/core";
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

// **After the ignite, deliberately, and the difference from the call above is the point.** Nothing
// reads a `ForceField` while services are starting, so this has no ordering to respect — and a
// starter that had to be hoisted would be one more thing to remember when a service next grows a
// dependency on a shield. It is here rather than inside a service because a `ForceField` outliving
// or predeceasing the round is a fact about bodies, not about rounds.
startSpawnShield();

print("[main] ignited");
