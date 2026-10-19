import { Flamework } from "@flamework/core";
import { UserInputService } from "@rbxts/services";
import { AIM_CONFIG } from "shared/config/aim.config";
import { startChargeEffects } from "./chargeEffect";
import { startIasTest } from "./IasTest";
import { startHitConfirm } from "./hitConfirm";
import { startHitVfx } from "./hitVfx";
import { startCatchPrompt } from "./catchPrompt";

print("[client] igniting");
Flamework.addPaths("src/client/controllers");
Flamework.ignite();
print("[client] ignited");

// **The game's mouse sensitivity, written once, here, and nowhere else in the project.** This is a
// *session* property rather than a saved setting, so "once at client start" is the whole of its lifecycle —
// there is nothing to persist, nothing to restore, and no path that needs to write it again. It is here
// rather than in a controller because it is not a *surface*: no controller owns it, every view on the client
// inherits it (the ordinary camera, the custom shift lock, the aim ray and the arc), and putting it in one
// controller would make that controller the owner of a setting the others depend on without being able to
// see it.
//
// **`MouseDeltaSensitivity`, deliberately, and not `UserGameSettings.MouseSensitivity`.** The first is a
// multiplier on the player's own slider; the second *is* the slider. Overwriting the slider would be taking a
// preference away from somebody who has already stated it, so the game scales it instead and leaves the
// stored value alone. See `AIM_CONFIG.MOUSE_SENSITIVITY` for the whole argument, and note that this is the
// only write to either property anywhere in `src/`.
//
// **Not gated on `isMobile()`, and the thought is worth recording because `ui/screenGui.ts` has a device gate
// a few lines of habit away.** A touch client has no mouse, so the property is inert there — writing it costs
// one property write and changes nothing. Gating it would imply that a touch device has a sensitivity to set,
// which is the opposite of true, and would put a second platform branch in a line that has no platform
// question in it.
UserInputService.MouseDeltaSensitivity = AIM_CONFIG.MOUSE_SENSITIVITY;

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

// **And the catch prompt, which is the third subscriber to a fact about a throw and the first one that watches a
// ball rather than an event.** It reads `BALL_TAGGED_TEAM_ATTRIBUTE` on every live ball and draws a word over
// the ones that owe somebody on this player's side a death — see `catchPrompt` for why that is an attribute
// rather than a message, and why the box is built in code rather than cloned.
startCatchPrompt();

// **And the charge effect, which departs from the two above in *how* it learns its fact.** Those two watch a
// server event; this one watches the local player's own hold (`chargeStartedAt`, a `Fusion.Value`) *and* the
// charge a rig publishes as an attribute, because a player's charge is measured on this machine and never sent
// while a rig's windup is the server's. One module, both drivers, and the same plain-module-because-Flamework-
// never-loads-it reasoning as the pair above. See `chargeEffect` for the two roads and the effect they share.
startChargeEffects();
