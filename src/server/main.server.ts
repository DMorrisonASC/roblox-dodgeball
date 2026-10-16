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
 * **The engine's touch movement mode: asked once, answered, and deliberately not changed. Read this before
 * reaching for it again.**
 *
 * `player.DevTouchMovementMode = Enum.DevTouchMovementMode.Scriptable` is the switch the mobile-stick design
 * wanted — the reference defines the value as *"The player's character will not respond to default controls; any
 * character movement must be defined in custom scripts"*, which is exactly what `TouchJoystickController` draws
 * for. **A client cannot throw it**: a `LocalScript` assignment is refused with *"The current thread cannot set
 * 'DevTouchMovementMode' (lacking capability `RobloxScript`)"*, because capability belongs to the *thread* rather
 * than to the peer. So a server-side, per-player write was the last route to it, and **it works** — a session on
 * 2026-10-16 printed `[main] engine touch movement — prospeed1: UserChoice -> Scriptable`, with the client reading
 * back `Scriptable` on its first mount a third of a second later.
 *
 * **And it must not be used, because it takes the jump button with it.** That same client printed
 * `[Joystick] engine touch GUI — 0 child(ren): ; no JumpButton`: with the movement mode scripted, the engine's
 * `TouchGui` still exists but its `TouchControlFrame` is **empty** and there is **no `JumpButton` anywhere in it**.
 * **That button is the only touch jump this project has.** `MobileControlsController` *dresses* the engine's jump
 * rather than replacing it, and the history for that decision is in its own doc: a button of ours whose press wrote
 * `Humanoid.Jump = true` never produced a jump, because the `PlayerModule` also writes that flag, later in the
 * frame. So `Scriptable` buys a bigger, scripted stick and pays for it with a player who cannot jump, and in a game
 * whose whole subject is movement that is not a trade to make quietly.
 *
 * **What would have to exist first**, before this comes back: a jump this project owns end to end — either a
 * control of our own that can actually make a body leave the ground (the flag-fight above says that is a real
 * question rather than a formality — see `MobileControlsController`'s `restyleEngineJump` doc for the thirteen
 * presses that answered it once), or a movement mode that leaves the jump button alone. Neither is known to work.
 * The two lines that turn it back on, for whoever answers that:
 *
 * ```ts
 * const [ok, message] = pcall(() => {
 * 	player.DevTouchMovementMode = Enum.DevTouchMovementMode.Scriptable;
 * });
 * ```
 *
 * **The joystick is unaffected by this and still draws its ring.** It wanted `Scriptable` only so the engine's own
 * stick would stop driving the body, and it wins that argument per frame anyway while a finger is on the ring: its
 * writer is bound at `Enum.RenderPriority.Character` (300), above the ControlModule's, so ours is the last write of
 * the two before physics. What is lost by not switching is that the *engine's* stick is still on screen and still
 * moves the body for a touch that starts off the ring — which is the state every session before this one ran in.
 */

// **After the ignite, deliberately, and the difference from the call above is the point.** Nothing
// reads a `ForceField` while services are starting, so this has no ordering to respect — and a
// starter that had to be hoisted would be one more thing to remember when a service next grows a
// dependency on a shield. It is here rather than inside a service because a `ForceField` outliving
// or predeceasing the round is a fact about bodies, not about rounds.
startSpawnShield();

print("[main] ignited");
