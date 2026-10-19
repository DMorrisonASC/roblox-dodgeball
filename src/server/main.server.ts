import { Flamework } from "@flamework/core";
import { Players } from "@rbxts/services";
import { ARENA_CONFIG } from "shared/config/arena.config";
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

print(
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

print("[main] ignited");
