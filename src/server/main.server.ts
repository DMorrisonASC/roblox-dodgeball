import { Flamework } from "@flamework/core";
import { startCollisionGroups } from "./collision/CollisionGroups";

print("[main] igniting");

// **Before `ignite()`, and the ordering is the point rather than the tidiness.** A service's
// `onStart` runs inside `Flamework.ignite()`, and `MapService` is one of them — it reads the
// `Barrier` group as it places an arena. Registering after the ignite would be registering after the
// first thing that needs it has already run.
startCollisionGroups();

Flamework.addPaths("src/server/services");
Flamework.addPaths("src/server/components");
Flamework.addPaths("src/server/dev");
Flamework.ignite();
print("[main] ignited");
