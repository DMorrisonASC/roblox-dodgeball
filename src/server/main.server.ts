import { Flamework } from "@flamework/core";

print("[main] igniting");
Flamework.addPaths("src/server/services");
Flamework.ignite();
print("[main] ignited");
