import { Flamework } from "@flamework/core";
import { startIasTest } from "./IasTest";

print("[client] igniting");
Flamework.addPaths("src/client/controllers");
Flamework.ignite();
print("[client] ignited");

// **Temporary, and the second of the two lines that make the IAS test deletable.** The other is the
// import above. The file's own `DEBUG` flag is the off switch, so turning the test off does not
// involve editing the boot — only deleting the test does. See `IasTest` for what it decides.
startIasTest();
