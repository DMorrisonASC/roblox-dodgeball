import { Flamework } from "@flamework/core";

print("[client] igniting");
Flamework.addPaths("src/client/controllers");
Flamework.ignite();
print("[client] ignited");
