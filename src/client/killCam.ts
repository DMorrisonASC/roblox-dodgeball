import { CollectionService, Players, RunService, Workspace } from "@rbxts/services";
import { KILL_CAM_CONFIG } from "shared/config/killCam.config";
import {
	IN_ROUND_ATTRIBUTE,
	LAST_HIT_BY_POSITION_ATTRIBUTE,
	LAST_HIT_BY_TOKEN_ATTRIBUTE,
	NPC_TAG,
	RESPAWN_AT_ATTRIBUTE,
	THROWER_TOKEN,
} from "shared/constants";
import { hideEnemyView, showEnemyView } from "./enemyView";
import { killCamActive } from "./panels";

/**
 * **The spectator kill cam: while the local player is waiting for a body, the camera watches the body that
 * took them out.**
 *
 * **A plain module started from the boot rather than a Flamework controller**, which is `hitVfx`,
 * `catchPrompt`, `chargeEffect` and `returnToLobby`'s shape and for their reason: it owns no lifecycle and
 * injects nothing. It is *functions and module state* rather than a class on purpose — Flamework's transformer
 * records an exported class in `flamework.build` whether or not it carries a decorator, and a file of functions
 * is what keeps a module that is not a provider out of that manifest.
 *
 * **It is the second thing in this client that writes `Camera.CFrame`, and the only one that takes the camera
 * away from Roblox's scripts.** `ShiftLock` writes `Humanoid.CameraOffset` and leaves the placement to them;
 * its aim assist writes a `CFrame` after them, conditionally. This one sets `CameraType = Scriptable`, which
 * *stops* the scripts placing the camera at all, and then places it every frame. That is the whole of how the
 * shot is held still: **there is nothing to fight**, because the thing that would otherwise move the camera has
 * been told to stand down, and there is likewise no way for the player to rotate it — mouse movement reaches the
 * scripts, and the scripts do not run.
 *
 * **Three facts decide whether a body gets a shot, and all three are replicated attributes:**
 *
 * 1. **`IN_ROUND_ATTRIBUTE`** — the death has to be one inside a round. A reset in the lobby, a fall in the
 *    practice area and a death while spectating are all Roblox's own death camera, which is the honest answer:
 *    there is no round for anybody to have killed you in.
 * 2. **`RESPAWN_AT_ATTRIBUTE`** — the wait has to be real. This is the *only* duration used, and it is the
 *    server's own number rather than a constant here: a respawn's delay is the round's to choose and a second
 *    copy in this file would be free to disagree with the one that decides it.
 * 3. **`LAST_HIT_BY_TOKEN_ATTRIBUTE`** — who to watch, as a token rather than a name, resolved to a `Model` by
 *    {@link bodyFor}. A death with nothing behind it — a fall, a reset, a dev command — has no token and falls
 *    back to Roblox's camera, which is the `undefined` branch of {@link begin}.
 *
 * **The killer may stop existing mid-shot, and that is a supported state rather than an error.** A rig is
 * destroyed and re-cloned by its own respawn behaviour and can be removed while it is being watched, and a
 * player's killer can die too. {@link pointOfKiller} answers with the last place the killer stood in that case,
 * so the shot holds on the spot where the fight happened instead of snapping to the origin or erroring — and a
 * killer that has never been seen at all ends the shot through Roblox's own camera, because there is nothing to
 * hold on.
 */

/** The render step's name. The one that has to be unbound, so it is spelled once. */
const STEP_NAME = "KillCam";

/**
 * **After the camera scripts, and after the aim assist's follow.**
 *
 * `RenderPriority.Camera` is where Roblox's own scripts place the camera, and `ShiftLock`'s follow runs at
 * `Camera.Value + 1` — one step after them — so `+ 2` is the first step that runs after both. It matters here
 * only in the one case the two can overlap: a mobile client who is holding a throw at a latched body *and* has
 * just died. The lock's follow is conditional and this is unconditional, so ordering it last means the shot is
 * the shot rather than a frame of somebody else's rotation underneath it.
 */
const PRIORITY = Enum.RenderPriority.Camera.Value + 2;

/** Whether the camera is being held right now. */
let running = false;

/**
 * The body that died — **the corpse, held so the new body can be told apart from it.**
 *
 * This is the hand-back's whole test. At the instant of death the player still *has* a character, and it stays
 * there until `LoadCharacterAsync` replaces it, so "the local player has a character" is true for the entire
 * wait and cannot answer "has my body come back". Identity can: a different model is a different life.
 */
let corpse: Model | undefined;

/** The body being watched, while it is still in the world. */
let killer: Model | undefined;

/**
 * **The token this shot started from**, kept so a killer's *new* body can be looked up without a tag scan.
 *
 * A player's token is their `UserId`, so "is the killer back" is `Players.GetPlayerByUserId` — one call, no
 * walk. A rig's token is a GUID and can only be matched by scanning the tagged models, which is a per-frame
 * walk this file does not do; a rig that is destroyed mid-shot therefore holds the place it died at. That
 * asymmetry is the same one `bodyFor` already lives with, and it is stated here because it decides what
 * {@link pointOfKiller} does.
 */
let killerToken: string | undefined;

/** The last place the killer's root was seen, held after the killer is destroyed. See {@link pointOfKiller}. */
let lastPoint: Vector3 | undefined;

/** The smoothed camera position, or nothing before the first frame of a shot. */
let cameraAt: Vector3 | undefined;

/** The camera type to hand back, captured when the shot began rather than assumed. */
let returning: Enum.CameraType | undefined;

/** The server-time instant the wait ends, from `RESPAWN_AT_ATTRIBUTE`. */
let deadline = 0;

/** Whether a death is waiting to learn whether the server scheduled a respawn. See {@link onDied}. */
let armed = false;

/** Bumped on every arm and every disarm, so a stale timeout cannot disarm a newer death. */
let armToken = 0;

/**
 * **The boot's one line for this cam**, in the shape `startHitVfx`, `startCatchPrompt` and `startKillCam`'s
 * neighbours already use: the module owns two subscriptions and no lifecycle, so whoever starts the client is
 * what starts it.
 *
 * **Nothing here runs on a client that cannot see:** the cam is driven entirely by attributes on the local
 * `Player`, which replicate to every client alike, and by a `Humanoid.Died` on the body that client is
 * simulating. There is no server half at all — the killer's identity is published for the respawn readout's
 * sake already, and this reads the machine-readable half of the same write.
 */
export function startKillCam(): void {
	if (!KILL_CAM_CONFIG.ENABLED) return;

	const player = Players.LocalPlayer;

	// **Every body, because the `Died` subscription lives on the humanoid** and a humanoid is replaced with the
	// body it belongs to. One connection per life, made here and dying with the body.
	player.CharacterAdded.Connect((character) => watchBody(character));

	const existing = player.Character;
	if (existing !== undefined) watchBody(existing);

	// **The deadline, listened for rather than read on the death frame.** See `begin` and
	// `KILL_CAM_CONFIG.PENDING_TIMEOUT_SECONDS`: the server writes this attribute a round trip *after* the death
	// this client just saw, so the death only arms the cam and this is what starts it.
	player.GetAttributeChangedSignal(RESPAWN_AT_ATTRIBUTE).Connect(() => {
		if (!armed) return;
		if (running) return;

		const at = player.GetAttribute(RESPAWN_AT_ATTRIBUTE);
		if (!typeIs(at, "number")) return;
		if (at <= Workspace.GetServerTimeNow()) return;

		armed = false;

		begin(at);
	});
}

/** Subscribes to one body's death. Per body rather than per player, for the `CharacterAdded` reason above. */
function watchBody(character: Model): void {
	const humanoid = character.FindFirstChildOfClass("Humanoid");
	if (humanoid === undefined) return;

	humanoid.Died.Connect(() => onDied(character));
}

/**
 * A death: **is this one the cam's business, and is there a wait to hold the camera for?**
 *
 * **The round test comes first, and it is what keeps a reset out of the cam.** A death outside a round has no
 * round for anybody to have killed you in, no scheduled respawn and often a stale killer on the `Player` from a
 * round that has ended — so the whole feature is refused before the attribute is even read. That is also why the
 * test is a *round* test rather than a "do I have a killer" test: the token survives until the next body, which
 * is deliberate (it is the respawn readout's name), so its presence says nothing about this death.
 *
 * **The wait is not readable yet, and the difference matters.** `Died` fires here the instant the humanoid's
 * health hits zero; `RespawnService.schedule` runs on the server a round trip later and is what writes the
 * deadline. So the death *arms* the cam and returns, and the player's `RESPAWN_AT_ATTRIBUTE` subscription starts
 * it when the number arrives — with a timeout, because an elimination never writes one.
 */
function onDied(character: Model): void {
	if (running) return;

	const player = Players.LocalPlayer;
	if (player.GetAttribute(IN_ROUND_ATTRIBUTE) !== true) return;

	corpse = character;

	// **The already-published case**, which the subscription cannot fire for: a client that was loading when the
	// death happened mounts with the attribute already set. The same read closes the window where the server
	// writes the deadline before this handler runs rather than after.
	const at = player.GetAttribute(RESPAWN_AT_ATTRIBUTE);
	if (typeIs(at, "number") && at > Workspace.GetServerTimeNow()) {
		begin(at);

		return;
	}

	armed = true;

	const token = ++armToken;
	task.delay(KILL_CAM_CONFIG.PENDING_TIMEOUT_SECONDS, () => {
		// **Only this death may disarm itself.** A second death inside the window bumps the token, and a timeout
		// from the first must not cancel the second's wait — the same stale-timer trap the HUD controllers name.
		if (armToken === token) armed = false;
	});
}

/**
 * Starts the shot, if there is somebody to watch.
 *
 * **Everything that can refuse is here, before anything is written**, so a death that ends up being Roblox's own
 * camera never touches `CameraType` and never binds a step: no killer resolved, no killer in the world, or no
 * camera on this client are all "let the engine have it".
 */
function begin(at: number): void {
	// **A second start is a no-op, and that guard exists for {@link awaitToken}.** The retry below can fire on the
	// same death that an immediate start already handled — the attribute arriving in the same frame the death was
	// detected, say — and two starts would bind two render steps and capture the camera type twice.
	if (running) return;

	const player = Players.LocalPlayer;

	const token = player.GetAttribute(LAST_HIT_BY_TOKEN_ATTRIBUTE);
	if (!typeIs(token, "string")) {
		// **The token can be a frame behind the death, and that is the one refusal here worth retrying.**
		//
		// `Died` fires on *this* client, from the humanoid it simulates; the token is written on the server, at the
		// tag, and is replicated. The two are not ordered — so a death can be seen before the attribute that names
		// its thrower is, and refusing on this frame would be a cam that never starts for a death that was about to
		// be explainable. That is the shape the "caught a ball, then killed by a second one" report has: the catch
		// writes to the same player's attributes, so the value on screen at the death is a value from a *different*
		// throw's write, and whether it is there at all is a replication question rather than a gameplay one.
		//
		// **Bounded, and the bound is the cam's own pending timeout.** An elimination writes no deadline and a
		// practice-zone death has no killer at all, so a wait with no end would be a subscription held for the rest
		// of the session on every death outside a round.
		awaitToken(at);

		return;
	}

	const body = bodyFor(token);
	if (body === undefined) return;

	const point = rootPointOf(body);
	if (point === undefined) return;

	const camera = Workspace.CurrentCamera;
	if (camera === undefined) return;

	killer = body;
	lastPoint = point;
	cameraAt = undefined;
	deadline = at;
	returning = camera.CameraType;
	running = true;

	// **The screen becomes a shot, in the same frame the camera is taken.** Two writes and one call: the value the
	// HUD hides itself off, and the caption's binding to the body being watched. Both happen before the first frame
	// is placed, so the first frame of the shot is already the composed one rather than one with a score bar on it
	// that disappears a frame later. Nothing is destroyed — see `panels.ts` on why the HUD is hidden rather than
	// torn down, which is the whole reason a three-second camera can clear the screen without costing anything.
	killCamActive.set(true);
	showEnemyView(body);

	RunService.BindToRenderStep(STEP_NAME, PRIORITY, (delta) => step(delta));

	// **Said out loud, and it is the line the acceptance criteria are read from**: two lines per death (this one
	// and the hand-back's) are how a session answers "did the cam start, on whom, and did it let go" without the
	// Explorer. The name is the body's own, which for a rig is the alias it wears.
	print(`[KillCam] up — watching ${body.GetFullName()} for ${string.format("%.2f", at - Workspace.GetServerTimeNow())}s`);
}

/**
 * **Waits, briefly, for the killer's token to replicate — then gives up and lets the engine keep the camera.**
 *
 * One subscription, one deadline, and both are dropped on the first of them: the token's own changed-signal is the
 * fast path (the server writes it a round trip after the death), and `PENDING_TIMEOUT_SECONDS` is the slow one. The
 * connection is dropped by the handler as well as by the timer, so a start cannot run twice and a session cannot
 * collect one stale subscription per death.
 *
 * **What this cannot fix, stated rather than implied**: a token that is *stale* rather than *missing* — the value
 * from a previous hit, already replicated — is indistinguishable on the client from a fresh one without a sequence
 * number on the write. This closes the absent case, which is the one a retry can close.
 */
function awaitToken(at: number): void {
	let connection: RBXScriptConnection | undefined;

	connection = Players.LocalPlayer.GetAttributeChangedSignal(LAST_HIT_BY_TOKEN_ATTRIBUTE).Connect(() => {
		const token = Players.LocalPlayer.GetAttribute(LAST_HIT_BY_TOKEN_ATTRIBUTE);
		if (!typeIs(token, "string")) return;

		if (connection !== undefined) connection.Disconnect();
		connection = undefined;

		begin(at);
	});

	task.delay(KILL_CAM_CONFIG.PENDING_TIMEOUT_SECONDS, () => {
		if (connection === undefined) return;

		connection.Disconnect();
		connection = undefined;
	});
}

/**
 * One frame of the shot: hold the camera, follow the killer, and decide whether the shot is over.
 *
 * **The hand-back is checked before the camera is written**, so the frame that gives the camera back is a frame
 * that never places it: the last `CFrame` this file writes is on the frame before the new body exists, and the
 * first frame after it belongs to Roblox's scripts. See {@link release}.
 */
function step(delta: number): void {
	const player = Players.LocalPlayer;
	const camera = Workspace.CurrentCamera;

	if (camera === undefined) {
		release("there is no camera to hold");

		return;
	}

	const now = Workspace.GetServerTimeNow();
	const body = player.Character;

	// **Two ways the wait can end early, and both have to be seen here.** The deadline is the ordinary one; the
	// other is the wait being *cancelled* — a round ending calls `RespawnService.cancel` with `true`, which zeroes
	// this attribute and hands the body back at once. The attribute is read rather than remembered for exactly
	// that case, because a cancelled wait would otherwise leave the camera holding until a deadline nothing is
	// counting toward any more.
	const at = player.GetAttribute(RESPAWN_AT_ATTRIBUTE);
	const waiting = typeIs(at, "number") && at > 0;

	// **A body that is not the corpse is a body that came back.** See `corpse`.
	const restored = body !== undefined && body !== corpse;

	if (restored && (now >= deadline || !waiting)) {
		release("the new body is here");

		return;
	}

	if (now >= deadline + KILL_CAM_CONFIG.HAND_BACK_GRACE_SECONDS) {
		release("the wait outlived its grace and no body came");

		return;
	}

	// **`Scriptable` is re-asserted rather than set once**, and it costs one comparison per frame: it is the
	// property that makes every other statement in this file true, and a single frame in which something else
	// set it back to `Custom` would be a frame where the shot is overwritten by the scripts *and* the player's
	// mouse is live again.
	if (camera.CameraType !== Enum.CameraType.Scriptable) camera.CameraType = Enum.CameraType.Scriptable;

	const point = pointOfKiller();
	if (point === undefined) {
		release("the killer is gone and was never seen");

		return;
	}

	const desired = point.add(KILL_CAM_CONFIG.OFFSET);

	// **Exponential smoothing, not a fixed `Lerp` fraction.** `1 - exp(-rate * dt)` spends the same *time*
	// closing the gap whatever the frame rate is; a constant fraction would close it twice as fast on a client
	// running twice as many frames, which is how a follow tuned in Studio looks wrong on a phone.
	cameraAt =
		cameraAt === undefined ? desired : cameraAt.Lerp(desired, 1 - math.exp(-KILL_CAM_CONFIG.FOLLOW_RATE * delta));

	camera.CFrame = CFrame.lookAt(
		cameraAt,
		point.add(new Vector3(0, KILL_CAM_CONFIG.LOOK_HEIGHT, 0)),
	);
}

/**
 * **Gives the camera back — and the frame this runs on is the whole of the feature's risk.**
 *
 * **The hand-back is the first frame on which a body other than the corpse exists**, and not the frame the
 * deadline passes, because those are not the same instant and only one of them is visible. `RespawnService`
 * zeroes the attribute and *then* calls `LoadCharacterAsync`, which yields: the body arrives a frame or two after
 * the clock runs out. Releasing on the clock alone therefore hands Roblox's scripts a camera whose subject is a
 * **corpse**, and then the subject is replaced by the new body a frame or two later — the engine's camera jumps
 * from the dead body to the living one, in view, for as long as the load took.
 *
 * **Holding past the spawn costs the same flicker from the other side, which is why the test is an identity and
 * not a timer.** The new body is under the player's control from the frame it exists — input, physics, the
 * throw, all of it — while the camera is still framing somebody across the arena. That is not a slow hand-back,
 * it is a frame (or several) in which the player is playing blind, and it ends in the same jump when the camera
 * finally lets go. So the release is on the *arrival*, whichever frame that is: not before, because a corpse is
 * the wrong subject, and not after, because a live body is.
 *
 * **`CameraSubject` is set before the type is**, and that ordering is deliberate. Under `Scriptable` the subject
 * is inert, so the scripts have not been keeping it up to date in any way this file can rely on across a body
 * swap; writing it explicitly makes the hand-back independent of what the `PlayerModule` did or did not do
 * during the shot. Then `Custom` lets the scripts place the camera from a subject that is already right, so the
 * first frame they own is the correct frame rather than a corrective one.
 *
 * **The captured type rather than a hard-coded `Custom`**, for the reason `ShiftLock` captures the cursor: the
 * type belongs to the client, not to this file, and a client that arrived with something else set gets that
 * back. It is `Custom` in practice — nothing else in `src/client` writes `CameraType` — but "in practice" is the
 * kind of assumption that is free not to make.
 */
function release(reason: string): void {
	if (!running) return;

	running = false;

	// **The instruments come back before the camera does.** The HUD's return is a `Visible` write driven by this
	// value, so clearing it first means the first frame Roblox's scripts own is a frame with its instruments on it
	// rather than a bare one that fills in afterwards. `hideEnemyView` drops the caption's subscriptions and does
	// not touch visibility — the panel follows the same value, so this pair cannot disagree about whether a shot is
	// happening.
	killCamActive.set(false);
	hideEnemyView();

	RunService.UnbindFromRenderStep(STEP_NAME);

	const camera = Workspace.CurrentCamera;

	if (camera !== undefined) {
		const humanoid = Players.LocalPlayer.Character?.FindFirstChildOfClass("Humanoid");
		if (humanoid !== undefined) camera.CameraSubject = humanoid;

		camera.CameraType = returning ?? Enum.CameraType.Custom;
	}

	killer = undefined;
	corpse = undefined;
	lastPoint = undefined;
	cameraAt = undefined;
	returning = undefined;
	deadline = 0;

	print(`[KillCam] down — ${reason}`);
}

/**
 * **The body a token names — the client's copy of the server's `tonumber` rule.**
 *
 * A player's token is their `UserId` as text (`JoinService` stamps that on every character) and a rig's is a
 * generated GUID (`NpcService`), so **`tonumber` succeeding *is* the test for "was this a person"** — the rule
 * `RoundService.playerFromToken` and `StatsService` both state. Anything else is a rig, and a rig is found the
 * way every other rig reader in this client finds one: the `NPC` tag, matched on the same attribute.
 *
 * **A name would have been simpler and is wrong.** The display string beside this attribute is a `DisplayName`
 * for a player and an alias for a rig, and two bodies can share one; a lookup by name picks whichever it finds
 * first, which is the wrong answer exactly when it matters. See `LAST_HIT_BY_TOKEN_ATTRIBUTE`.
 */
function bodyFor(token: string): Model | undefined {
	const userId = tonumber(token);

	if (userId !== undefined) return Players.GetPlayerByUserId(userId)?.Character;

	for (const instance of CollectionService.GetTagged(NPC_TAG)) {
		if (!instance.IsA("Model")) continue;
		if (instance.GetAttribute(THROWER_TOKEN) === token) return instance;
	}

	return undefined;
}

/** The point on the killer's root, if the body is still in the world. */
function rootPointOf(body: Model): Vector3 | undefined {
	const root = body.FindFirstChild("HumanoidRootPart");
	if (root === undefined || !root.IsA("BasePart")) return undefined;

	return root.Position;
}

/**
 * **Where the camera should look this frame, and the reason a destroyed killer is not an error.**
 *
 * A rig is destroyed and re-cloned by its own respawn behaviour, and a player's killer can be killed too, so the
 * watcher going away mid-shot is ordinary rather than exceptional. Three answers, in order:
 *
 * 1. **The killer's root, while the body is in the world** — and this is also what records {@link lastPoint},
 *    so a body destroyed later has somewhere to be remembered at.
 * 2. **The last place the root was seen**, once the body is gone. The shot holds on the spot where the killer
 *    was standing, which is the honest reading of "this is where it happened" and is what the brief asks for
 *    over falling back to the corpse.
 * 3. **Nothing**, if the killer was never seen at all — the shot is then ended by `step`, which hands the
 *    camera back rather than pointing it at the origin.
 *
 * **`IsDescendantOf(Workspace)` rather than a `nil` check**, because a destroyed instance still answers property
 * reads: a `HumanoidRootPart` whose model has been destroyed is a part with a stale `Position`, and a camera
 * driven from it would drift to wherever that corpse of an instance last was rather than stay where the killer
 * actually stood.
 */
function pointOfKiller(): Vector3 | undefined {
	const body = killer;

	if (body !== undefined && body.IsDescendantOf(Workspace)) {
		const point = rootPointOf(body);

		if (point !== undefined) {
			lastPoint = point;

			return point;
		}
	}

	return lastPoint;
}
