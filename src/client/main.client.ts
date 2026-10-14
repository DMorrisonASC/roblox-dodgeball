import { Flamework } from "@flamework/core";
import { startChargeEffects } from "./chargeEffect";
import { startIasTest } from "./IasTest";
import { startHitConfirm } from "./hitConfirm";
import { startHitVfx } from "./hitVfx";

print("[client] igniting");
Flamework.addPaths("src/client/controllers");
Flamework.ignite();
print("[client] ignited");

// **Temporary, and the second of the two lines that make the IAS test deletable.** The other is the
// import above. The file's own `DEBUG` flag is the off switch, so turning the test off does not
// involve editing the boot — only deleting the test does. See `IasTest` for what it decides.
startIasTest();

// **The hit impact effect, started here for the same reason the test above is.** `hitVfx` is a plain
// module rather than a Flamework controller — it owns no lifecycle and no injected service, it watches one
// event and draws — and the only things Flamework loads from this client are `src/client/controllers`. So
// a module with a subscription and no controller around it is wired from the boot, which is what the
// `startIasTest` call above is the precedent for. See `hitVfx` for what it decides.
startHitVfx();

// **And the hit confirmation, which is the same kind of module for the same reason.** It reads the same
// event as the effect above and decides something different about it — whether the hit was *mine*, which is
// a sentence rather than a burst — so it is a second subscriber rather than a call from `hitVfx`: the two
// have nothing to say to each other, and neither should have to know the other exists. See `hitConfirm`.
startHitConfirm();

// **And the charge effect, which departs from the two above in *how* it learns its fact.** Those two watch a
// server event; this one watches the local player's own hold (`chargeStartedAt`, a `Fusion.Value`) *and* the
// charge a rig publishes as an attribute, because a player's charge is measured on this machine and never sent
// while a rig's windup is the server's. One module, both drivers, and the same plain-module-because-Flamework-
// never-loads-it reasoning as the pair above. See `chargeEffect` for the two roads and the effect they share.
startChargeEffects();
