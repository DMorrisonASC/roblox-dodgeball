import { Flamework } from "@flamework/core";
import { Players } from "@rbxts/services";
import { ARENA_CONFIG } from "shared/config/arena.config";
import { logInfo } from "shared/logger";
import { startCollisionGroups } from "./collision/CollisionGroups";
import { auditRigTemplates } from "./npc/rigTemplate";
import { startSpawnShield } from "./services/character/SpawnShield";
import { startHitDisagreementProbe } from "./dev/HitDisagreementProbe";

logInfo("[main] igniting");

/**
 * **The one line that says the logger is alive, and it is deliberately the first thing the server prints.**
 *
 * Every diagnostic in this game now goes through `shared/logger.ts`, and the failure mode of a logging pass is
 * silence: if the gate were wrong in the *other* direction — `IS_STUDIO` reading false in a playtest, a bad import, a
 * typo in the flag — the game would look and play exactly as it should and simply say nothing about it. A player would
 * not notice, a round would still complete, and the next diagnosis would start from an empty Output panel with no way
 * to tell "nothing happened" from "nothing is being printed".
 *
 * **It says *in Studio* because that is the scope of the claim.** `logInfo` is silent on a live server by design, so
 * this line cannot appear there — which is the correct behaviour and not a defect. What it confirms is the half that
 * is meant to talk: the Output panel in a playtest. `logError` is the half that survives production, and its
 * persistence call sites are what confirm that side.
 */
logInfo("[Boot] Logging active — running in Studio");

// **Before `ignite()`, and the ordering is the point rather than the tidiness.** A service's
// `onStart` runs inside `Flamework.ignite()`, and `RoundService` is one of them — it puts the arena's
// `CharacterBarrier` parts into the `Barrier` group at the round boundary, which is the first thing
// that reads the group. Registering after the ignite would be registering after that had already run.
startCollisionGroups();

// **The rig templates, read here rather than by a service, and before the ignite on purpose.**
//
// **What it is for.** A rig template is a place-file object this code treats as a contract and cannot read:
// `LobbyRigService` draws one out of `ServerStorage."NPCs"` and `NpcService.spawn` clones it, so a script, a
// tag, an anchored part or a missing `Head` inside that model is inherited by every rig in the session while
// `src/` says nothing about it. This prints what is in the file, one line per fault, naming the offending
// instance's full path. See `npc/rigTemplate.ts` for the checks and for why it repairs nothing.
//
// **Before the ignite rather than after, and the difference is which file it describes.** Every service's
// start-up runs inside `ignite()`, and the world-blind scan in `NpcService.onStart` hands a loop to a
// **tagged** model wherever it sits — a template in `ServerStorage` included — whose first turn calls
// `dressRig` and writes a trail onto the place file's model. So a pass after the ignite would report a
// template that the runtime had already begun decorating, and one *before* it reports the place file as it
// was saved, which is the question this is asked. Nothing in the pass needs a service: it reads
// `ServerStorage`, `CollectionService` and the tree.
//
// **And it sits beside `startCollisionGroups` for the same reason that call is here**: both are boot facts
// that something later depends on, and neither is a round, a body or a HUD, so neither belongs in a service
// whose own doc would then have to explain why it walks the whole of `ServerStorage`.
auditRigTemplates();

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

logInfo(
	`[main] respawn — CharacterAutoLoads false,` +
		` ${ARENA_CONFIG.RESPAWN_DELAY_SECONDS}s in-round delay`,
);

/**
 * **The engine's touch movement mode: deliberately not set here, after two attempts in one day. Read this before
 * reaching for it a third time.**
 *
 * The property is `Player.DevTouchMovementMode`, whose members the reference defines as:
 *
 * - `UserChoice` — *"Allows players to choose their desired control scheme from the in-experience menu. This is the
 *   default movement mode."* **The place file is on it and this project leaves it that way**, so the mode is the
 *   player's — which is what `UserChoice` is for.
 * - `DynamicThumbstick` — *"a virtual thumbstick that **appears when they touch the lower portion of the screen**.
 *   Jumping is controlled with a separate button."* That is what a phone resolves to by default, and it is the mode
 *   that fights `TouchJoystickController`'s ring: its stick appears under a thumb anywhere on the lower screen and
 *   writes its own movement vector every frame beside ours. A session on 2026-10-16 caught what that costs — six
 *   consecutive `a push to 1.00 lasted 29ms, under the hold of 200ms — not a sprint` lines on one sustained hold —
 *   because the sprint reads the body's last-written `Move` and the second writer keeps changing the answer. **That
 *   line no longer exists**: the sprint's engage hold, which was what it reported on, has since been removed, so the
 *   same flapping reading now shows up as repeated `[Sprint] pressed` / `released` edges rather than as rejected
 *   pushes.
 * - `Scriptable` — *"The player's character will not respond to default controls; any character movement must be
 *   defined in custom scripts."* **Tried first, and it works**: `[main] engine touch movement — prospeed1:
 *   UserChoice -> Scriptable`. **It also takes the engine's `JumpButton` with it** — the client printed
 *   `[Joystick] engine touch GUI — 0 child(ren): ; no JumpButton` — and that button is the only touch jump this
 *   project has (`MobileControlsController` dresses the engine's jump rather than owning one, because a button of
 *   ours that wrote `Humanoid.Jump = true` never produced a jump: the `PlayerModule` writes that flag too, later in
 *   the frame). So `Scriptable` buys a scripted stick and pays for it with a player who cannot jump.
 * - `Thumbstick` — a stick at a fixed place. **Tried second** (`UserChoice -> Thumbstick`, also works) and reverted
 *   the same day, because it puts a *second* circle in the corner the ring already occupies: the client's hide
 *   missed it, since the frame the engine draws in that mode is named `ClassicThumbstickFrame` and that name was not
 *   in `TouchJoystickController`'s list — the probe's own line (`2 child(ren): JumpButton, ClassicThumbstickFrame`)
 *   is what settled it. The list is fixed; the mode change is not worth its cost beside it.
 *
 * **So nothing here sets the mode, and the hiding lives entirely on the client**: a `UIScale` of `0` on whichever
 * stick frame appears, whatever mode a player is in, which is `TouchJoystickController.hideEngineStick`'s job. **The
 * cost that remains, stated: a hidden dynamic stick still writes movement** — a touch on the lower screen that misses
 * the ring can still walk the character with nothing drawn under the finger. That is the price of not overriding the
 * player's choice, and it is the one thing to revisit if a session ever reports it.
 *
 * **A client cannot set this property at all** — a `LocalScript` write is refused with *"The current thread cannot
 * set 'DevTouchMovementMode' (lacking capability `RobloxScript`)"*, and `RobloxScript` is a capability of the
 * **thread** rather than of the peer, which is why the client's own attempt was deleted from
 * `TouchJoystickController` and why the only two routes are this file and the place file. **Per player rather than a
 * place-file setting is also deliberate, if this is ever wanted again**: a `$properties` change to `StarterPlayer`
 * would be the same decision taken where nobody reading the client's code would find it.
 */

// **After the ignite, deliberately, and the difference from the call above is the point.** Nothing
// reads a `ForceField` while services are starting, so this has no ordering to respect — and a
// starter that had to be hoisted would be one more thing to remember when a service next grows a
// dependency on a shield. It is here rather than inside a service because a `ForceField` outliving
// or predeceasing the round is a fact about bodies, not about rounds.
startSpawnShield();

// **And the hit-disagreement probe, which has to be listening before the first ball is thrown rather than
// when one is.** It owns the `positionEcho` receiver and the sample map behind it, so the client's ten-hertz
// echo has somewhere to land from the session's first frame; the two lines it prints are called from
// `BallComponent`, which is why the *starter* is here and the *reporting* is not. It returns immediately when
// the logs are not verbose, which is the shipped state — see `HitDisagreementProbe` for the four numbers and
// the `VERBOSE_LOGS` gate it shares with every other measurement in the project.
startHitDisagreementProbe();

logInfo("[main] ignited");
