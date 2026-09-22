import { Flamework } from "@flamework/core";

print("[main] igniting");
Flamework.addPaths("src/server/services");
Flamework.addPaths("src/server/components");
Flamework.addPaths("src/server/dev");
Flamework.ignite();
print("[main] ignited");
