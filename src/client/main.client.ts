import { Flamework } from "@flamework/core";
import { UserInputService } from "@rbxts/services";
import { AIM_CONFIG } from "shared/config/aim.config";
import { startChargeEffects } from "./chargeEffect";
import { startReturnToLobbyPrompt } from "./returnToLobby";
import { startKillCam } from "./killCam";
import { startEnemyView } from "./enemyView";
import { startIasTest } from "./IasTest";
import { startHitConfirm } from "./hitConfirm";
import { startHitVfx } from "./hitVfx";
import { startCatchPrompt } from "./catchPrompt";
import { startAfkWatcher } from "./afk";
import { startPersonalAudio } from "./personalAudio";
import { startPerfectDodge } from "./perfectDodge";
import { startPracticeCountdown } from "./practiceCountdown";

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

// **And the "Return to Lobby" prompt, which is the same kind of module for the same reason** — it watches two
// attributes and binds one key, owns no controller lifecycle and injects nothing. See `returnToLobby` for the
// press-twice rule, for why the cancel is read rather than claimed, and for why it is a file of functions
// rather than a class (Flamework records an exported class in `flamework.build` whether or not it is decorated).
startReturnToLobbyPrompt();

// **And the same question asked automatically: the AFK watcher, which is the surrender above with the player's
// silence as the press.** It is here rather than beside the other watchers because the two share a subject — a body
// leaving a round it can no longer play — and because the one it sends is the round's own `surrender` handler, one
// door over. The clock only runs while the window is focused and the player is in a round; see `afk` for why each
// of those is a gate rather than a condition.
startAfkWatcher();

// **And the kill cam, which is the first module here that takes the camera away from Roblox's scripts.** It sets
// `CameraType = Scriptable` for the length of the local player's respawn wait and places the camera itself —
// watching the body that killed them — then hands the type back on the frame the new body exists. Same plain
// module shape for the same reason, and the same two facts drive it: the wait end (`RESPAWN_AT_ATTRIBUTE`) and
// who did it (`LAST_HIT_BY_TOKEN_ATTRIBUTE`). See `killCam` for why the hand-back is an identity test rather
// than a timer, and for why a destroyed killer is a supported state.
startKillCam();

// **And the overlay the cam explains itself with.** `killCam` binds it on every death, and the two calls can be
// in either order — `enemyView.show` mounts the element itself as a belt, so a cam that starts before this line
// has run still has something to write into. Starting it here is what makes the element exist, hidden, from the
// client's first frame rather than on the first death. See `enemyView` for why the caption is a separate module
// from the camera, and for why a rig's stats read as an em dash.
startEnemyView();

// **And the two sounds only this player hears, which is the same plain-module shape for the same reason.**
// They are `Sound`s in this client's `SoundService` and two subscriptions to attributes the server already
// publishes, so there is no lifecycle to own and nothing to inject. **Started at boot rather than on the
// first pickup**, because the clips are preloaded here and a sound whose asset is still downloading when it
// is asked for arrives after the event it describes — see `personalAudio` for both triggers, for why the
// pickup counter is the server's, and for why a MultiBall window is announced by its published count rather
// than by the key that asked for it.
startPersonalAudio();

// **And the perfect dodge, which is the third subscriber to a fact about a throw and the first one that is
// told a *measurement* rather than an outcome.** A dodge leaves nothing behind for a touch to resolve — the
// body is simply not where the ball went — so the server watches the ball for the length of the dash and sends
// the one word when it comes close. Same plain-module shape for the same reason: it owns one subscription and
// draws a word. See `perfectDodge` for why this is an event rather than an attribute, and for why a rig's
// perfect dodge exists in the output and never on a screen.
startPerfectDodge();

// **And the drills' countdown, which is the one client module here that draws over a body rather than over a
// ball or a screen.** Same plain-module shape for the same reason — one tag's two signals, one attribute read per
// rig per frame, and nothing to inject. **It is gated on `practiceThrow` and not on `NPC`**, which is what keeps
// every round's rig out of its loop: a rig with no bay has no countdown to draw, and asking it once a frame to
// discover that would be asking the whole game's rigs. See `practiceCountdown` for why a frame loop rather than
// the attribute's change signal (the digits roll *inside* a window that does not move), and for the one
// subtraction that turns a published instant into `3 2 1`.
startPracticeCountdown();
