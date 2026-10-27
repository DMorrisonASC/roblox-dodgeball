import { Controller, OnStart } from "@flamework/core";
import Fusion from "@rbxts/fusion-3.0";
import {
	CollectionService,
	ContextActionService,
	Players,
	ReplicatedStorage,
	RunService,
	StarterGui,
	UserInputService,
	Workspace,
} from "@rbxts/services";
import { AIM_CONFIG } from "shared/config/aim.config";
import { DEBUG_CONFIG } from "shared/config/debug.config";
import { SHIFT_LOCK_CONFIG } from "shared/config/shiftLock.config";
import { TRANSITION_CONFIG, TRANSITION_COVER_SECONDS } from "shared/config/transition.config";
import {
	IN_ROUND_ATTRIBUTE,
	PRACTICE_ZONE_TAG,
	ROUND_STATE_ATTRIBUTE,
	ROUND_STATUS_FOLDER,
	TEAM_ATTRIBUTE,
} from "shared/constants";
import { taggedParts } from "shared/taggedParts";
import { DEBUG_LOGGING, logDebug, logInfo, logWarn } from "shared/logger";
import { latchedTarget } from "../../aimAssist";
import { pushNotification } from "../../notifications";
import { isMobile } from "../../platform";
import { getScreenSpaceGui } from "../../ui/screenGui";
import { inTaggedZone, isParticipant } from "../../roundZone";
import { chargeStartedAt } from "../../throwing";

/** What `ROUND_STATE_ATTRIBUTE` says while a round is being played. */
const PLAYING = "Playing";

/** What it says between rounds — the only phase the lobby zone is allowed to decide anything in. */
const INTERMISSION = "Intermission";

/** The `ContextActionService` action the player's release key is bound to. Named so an unbind could find it. */
const RELEASE_ACTION_NAME = "ShiftLockRelease";

/**
 * **The crosshair's size, in pixels — the one number that sizes the sight, on every platform. `44`.**
 *
 * **This is the lever, and it did not used to be.** While a desktop wore `UserInputService.MouseIcon` as its
 * crosshair, this constant reached only the phone — a mouse icon has no size property to set (`MouseIcon`,
 * `MouseIconContent` and `MouseIconEnabled` are the whole of what the service offers), so on a keyboard client a
 * bigger or smaller number here changed nothing at all. The sight is now drawn as an `ImageLabel` on every platform
 * and the engine's pointer is hidden while the lock is on, so **this is the only thing to edit** to make the
 * crosshair bigger or smaller. See {@link applySight}.
 *
 * **Pixels rather than a fraction of the viewport**, deliberately: the middle of the view is where the throw goes, so
 * the mark that says so should be the same mark on a phone, a tablet and an ultrawide — one image of one size, not a
 * thing that grows with the window. Forty-four is big enough to read at arm's length and small enough not to cover
 * the body being aimed at.
 */
const SIGHT_SIZE = 44;

/**
 * **How see-through the sight is — `0.5`, half, and it is the only alpha this project puts on the crosshair.**
 *
 * **A property of the drawn sight, not of the art, which is the reversal this constant is.** The PNG was the
 * whole of the sight's alpha while a desktop wore `UserInputService.MouseIcon`: a mouse icon cannot be faded
 * either, so the only way to soften a crosshair was to edit the file, and `SHIFT_LOCK_CONFIG.LOCKED_CURSOR`
 * documents that as the rule. The sight has been an `ImageLabel` on every platform since 2026-10-22 — see
 * {@link applySight} — so the label carries an `ImageTransparency` and this is where it is set.
 *
 * **One number for both pictures.** The label swaps `LOCKED_CURSOR` for `HOLDING_CURSOR` on the frame the hand
 * changes, and `ImageTransparency` is not part of that swap: it is written once when the label is built, so an
 * empty hand and a full one fade identically. A per-state alpha would be a second thing to keep in step with two
 * ids, and the two pictures are the same sight saying one more thing rather than a different sight.
 *
 * **`0.5` because the mark was competing with the thing it marks.** A full-strength crosshair sits in the middle
 * of the screen — where a target is — and a solid white shape over a body reads as part of the body. Half is the
 * value that leaves it legible against both the sky and a torso without ever being mistaken for one. `1` would
 * fade it out entirely, which is the wrong lever for "less obtrusive": the sight says where the ball will go, and
 * a player who cannot find it has lost the aim. **The threshold is an eye judgement on a real screen**, so this is
 * the number to move if it is still too loud or now too faint — nothing else has to change with it.
 */
const SIGHT_TRANSPARENCY = 0.5;

/**
 * The scope the exported `Value` below lives in — **module state, so module scope.**
 *
 * The same shape `client/aiming.ts` and `client/throwing.ts` use for the facts they publish, and for the same
 * reason: a controller's scope is created in its own boot and a value exported for another controller to write
 * cannot be owned by one of them.
 */
const cursorScope = Fusion.scoped();

/**
 * **Whether the local player is holding a ball — the one fact the cursor draws, written by `ThrowController`.**
 *
 * **A `Value` rather than a method on this controller**, because the fact has one writer and the *drawing* of it
 * belongs to the thing being drawn: the sight's `Image` is a `Computed` over this, so Fusion repaints it on the frame
 * the hand changes and does nothing at all in between. A `setCrosshair(id)` method would have put that decision at the
 * call site — the throw controller choosing the crosshair — and the caller would have had to reach this controller to
 * make it.
 *
 * **It had two readers until 2026-10-22**, when the desktop's `MouseIcon` was retired as the crosshair in favour of the
 * drawn sight (see `applySight`); the `Observer` that kept the icon in step went with it, so what is left is one label
 * and one `Computed` — on every platform.
 *
 * **Written by `ThrowController.updateGuide` and nobody else**, which is the rule `aiming` and
 * `aimSessionStartedAt` already keep: that method reads the hand every frame, and a second place asking "is there a
 * ball" would be a second answer to one question. It is written every frame, which is free — a `Value` given the
 * value it already holds does nothing, exactly as `aiming.set(charging)` beside it relies on.
 *
 * **Read here and nowhere else**, which is why it is exported from this file rather than from `throwing.ts`: the
 * cursor is the only consumer, and the two ids it chooses between are the ones this controller writes.
 */
export const holdingBall = Fusion.Value(cursorScope, false);

/**
 * **Whether the camera diagnostics are on. `false` — this is a switch for one session, and it costs a log line
 * a frame while it is on.**
 *
 * **Its own constant rather than `DEBUG_CONFIG.VERBOSE_LOGS`, and that is deliberate.** Turning the verbose
 * gate on would also turn on `ThrowProbe`, which builds a whole `Trajectory` per throw, and `ThrowController`'s
 * marker-jitter report — so the session that measures the camera would be a session where the throw path is
 * doing work it does not do in a real game. `DEBUG_CONFIG.PROFILE` would be the other candidate and is the
 * wrong shape too: those are named MicroProfiler bands, and a camera *feel* question is answered from a text
 * log rather than from a flame chart. This switch turns on four lines of this file's own measuring and nothing
 * else, which is what makes the numbers comparable to a session with it off.
 *
 * **The four lines are specified in {@link ShiftLock.reportCamera}, with what each one distinguishes.** What a
 * reader brings back is a five-second recording taken in a practice zone with the lock on, while walking and
 * turning — and the summary lines are the ones that decide the shape of the fault.
 *
 * Turn it on by editing this line, take the session, and put it back.
 */
const CAMERA_DIAGNOSTICS = false;

/** How long the diagnostic rollup accumulates before printing, in seconds. One second, so the lines pair. */
const CAMERA_DIAGNOSTIC_PERIOD = 1;

/** The phase the round folder is publishing, or nothing while it has not published one yet. */
function phaseOf(status: Instance): string | undefined {
	const value = status.GetAttribute(ROUND_STATE_ATTRIBUTE);

	return typeIs(value, "string") ? value : undefined;
}

/** Whether `value` is the engine's camera settings object, rather than the error that replaced it. */
function isCameraSettings(value: unknown): value is UserGameSettings {
	return typeIs(value, "Instance") && value.IsA("UserGameSettings");
}

/**
 * The engine's camera settings, reached whichever way this client exposes them, or nothing.
 *
 * **Two routes, because the typings can prove the *type* exists and not how to get at it.** The API dump
 * declares `UserSettings.UserGameSettings` as a child of class `UserGameSettings` tagged `Service`, and
 * the typings type it as reachable through `GetService` — the call every custom shift lock makes. But
 * whether it is a service or a plain child is a runtime fact this repository cannot read out of the
 * typings, and the two are reached by different calls; so both are tried, and only a failure of *both* is
 * reported, with both errors in the line — between them they name whatever is actually wrong.
 *
 * The value is proved rather than asserted on the way out, and that is not tidiness: `pcall`'s return
 * type is a union of a success and a failure and destructuring it loses which branch was taken, so what
 * comes back is `unknown`. See {@link isCameraSettings}.
 */
function cameraSettings(): UserGameSettings | undefined {
	const [serviceOk, service] = pcall(() => UserSettings().GetService("UserGameSettings"));
	if (serviceOk && isCameraSettings(service)) return service;

	const [childOk, child] = pcall(() => UserSettings().FindFirstChildWhichIsA("UserGameSettings"));
	if (childOk && isCameraSettings(child)) return child;

	logWarn(
		`[ShiftLock] no UserGameSettings — the character will not turn with the view.` +
			` GetService: ${tostring(service)} | FindFirstChild: ${tostring(child)}`,
	);

	return undefined;
}

/**
 * A camera lock the game owns: the view turns the character, and the body is moved out of its own way.
 *
 * **Why the game has one at all.** Roblox's own shift lock is a LeftShift toggle — the player holds a
 * key to get it, and there is no way to force it on somebody or to take it off them. A round in which
 * everybody aims from the middle of the screen therefore cannot use it, and this is the replacement.
 * The engine's toggle is switched off in the *place file* (`StarterPlayer.EnableMouseLockOption =
 * false`, a property set in Studio — it is not reachable from code, and nothing here tries) so that
 * the two can never be on at once and fight over the same two settings.
 *
 * **Two things ask for it, and neither of them is the player.** While a round is being played the lock
 * is on for **the players who are in it** — on a side, having opted in — because the throw is aimed from
 * the centre of the screen — the camera *is* the aim, and a crosshair that followed the body instead of
 * the view would be pointing somewhere the player is not looking. **Not for the whole server**, which is
 * what it used to mean: a player watching a round from the lobby is not teleported by its transition, not
 * held by its freeze, and has nothing to aim from the middle of the screen, so the camera is theirs until
 * they join one. Outside a round it is off, and the player is free to run around and look at the lobby —
 * **except inside a zone somebody places** ({@link PRACTICE_ZONE_TAG}), where it comes back so a practice
 * throw lines up the way a real one will.
 *
 * **And a third input, which is the player's own key — restored 2026-10-22 after a spell without it.** `~` lets go
 * of the camera even in the middle of a round, and **the next click or tap takes it back** — see
 * {@link releaseCamera} and {@link reclaimOnPress}. **The argument for removing it is kept here, because it is still
 * the reason this is a *release* rather than a preference**: the camera *is* the aim, so switching it off is not
 * opting out of a comfort feature, it is switching off the mechanism the game is played through. What the removal
 * got wrong is how little the press actually costs. The lock comes back on the next press of a mouse button, so
 * what `~` buys is a look at the score, a pointer that can reach the interface, or a second without a crosshair over
 * somebody the round is about to move. It is the one input on this lock that belongs to the player rather than to
 * the round, and it can only ever **refuse** what the other two ask for — see {@link refresh}, where it is checked
 * first.
 *
 * **The key was also the backpack's, and no longer conflicts with it.** `mount` disables the backpack's core GUI
 * outright — there are no `Tool`s in this game, the ball is a part welded to a hand — so there is no window for the
 * press to open over the lock.
 *
 * **The inputs are combined rather than ordered, and the zone is checked in every phase.** The lock is
 * on while the round or the zone is asking, which is what makes the zone safe to leave armed all the
 * time: during a round it changes nothing (the round is already asking), and it can never *take away* a
 * lock the round is holding — a player who walked out of a lobby zone mid-round is still locked, which
 * is the rule the round exists to have. Gating the zone on the phase instead was tried first and is
 * worse in two ways: a player standing in a zone when a round ended lost the camera for the tenth of a
 * second the tick took to put it back, and the tick needed a second copy of the phase's rule kept in
 * step with the first. See {@link refresh}, which is where all of it is combined.
 *
 * **The engine's two user settings rather than the camera's `CFrame`.** `MouseBehavior` is what holds the
 * mouse at the centre of the screen — and *that* is what makes the aim work, because `ThrowController`
 * casts its ray from the mouse position: hold the mouse at the centre and the shot follows the view.
 * Writing the camera's own `CFrame` would be a fight with Roblox's camera scripts for the same property;
 * `MouseBehavior` is the supported seam, it is what the built-in lock writes, and it is why this does not
 * fork the `PlayerModule` — which is the other way to build this, and a permanent copy of Roblox's camera
 * code to keep in step with.
 *
 * **One exception, added 2026-10-19: `AimAssistFollow`, and it is a rotation applied *after* the camera scripts
 * rather than a fork of them.** While a mobile player charges a throw at a body the aim assist has latched
 * (`client/aimAssist.ts`), a render step at `Camera.Value + 1` turns the view a bounded number of degrees toward
 * that body's root — see {@link followTarget}. Everything above still holds: the scripts place the camera, this
 * file feeds them the same settings it always did, and the follow reads their position and only replaces the
 * orientation for as long as one specific hold is running. **What made the argument above right is still right**
 * — an unqualified `CFrame` write every frame would be a fight — and what makes this one safe is that it is
 * bounded (`AIM_ASSIST_FOLLOW_DEGREES_PER_SECOND`), directed (the root of one latched model) and conditional (a
 * mobile client, mid-hold, with a latch). It exists because on a phone **the camera is the aim**: leaving the
 * view free while the arc bends toward a lead would show the player a throw their own aim is not making.
 *
 * **`RotationType` is written to `MovementRelative` and never to `CameraRelative`, and that is a reversal.**
 * The old line asked for `CameraRelative` while locked, on the argument that a locked view should turn the
 * body with it. That made the character's facing a *consequence of the camera* rather than a fact of its
 * own: a player could not look somewhere without their body following, so the body had no heading to speak
 * of — it had whichever one the camera had. It is now `MovementRelative` in **both** states, which is the
 * setting's own default meaning: the body turns to face the direction it is walking, and standing still it
 * keeps the heading it last had. Looking around no longer turns anybody.
 *
 * **What that costs, stated plainly, because it is the whole trade.** The body no longer snaps to the view,
 * so a player who wants to change which way they are facing has to *move* — there is no key for it, and
 * adding one would be a new input binding this feature has no business introducing. It also means the
 * camera can now be pointing anywhere while the body points somewhere else, which is the point, and which
 * makes the *body's* facing the thing the throw reads rather than the camera's. See the note on
 * `shared/throw.ts`'s `forward` — that dependency is real and was checked rather than assumed.
 *
 * **And the cursor, which is the fourth thing the lock controls — by taking it away.** While the lock is on, the
 * engine's pointer is *hidden* and a crosshair is drawn in its place: the throw goes where the centre of the screen
 * is looking, and at that point the pointer has stopped being a pointer at all — `MouseBehavior.LockCenter` pins it
 * to the middle, so it cannot be pointed anywhere, and a mark that says where the shot goes is the honest thing to
 * draw. **It used to be the icon itself** — `MouseIcon` set to the crosshair — and that was given up on 2026-10-22
 * for one missing property: **an icon cannot be sized.** `MouseIcon`, `MouseIconContent` and `MouseIconEnabled` are
 * the whole of what `UserInputService` offers, so the crosshair's size was whatever the PNG happened to be, on every
 * device, with nothing in this project able to change it. See {@link applySight}, which draws the sight at
 * {@link SIGHT_SIZE}.
 *
 * **Unlike `RotationType`, the cursor does not outlive the client.** `UserInputService` is the session's
 * input state rather than the user's saved settings, so a session that ends mid-lock leaves nothing
 * behind for the next one. That is why the mount-time reset for it is a *capture* of what the client
 * arrived wearing rather than a forced default: there is nothing to undo, and the capture is what lets a
 * release hand back a cursor somebody else set instead of inventing one.
 *
 * **And what that sight is now is the whole of it, on every platform.** It began as the phone's half — a touch
 * device has no pointer at all, and its throw is aimed along the camera's own axis
 * (`ThrowController.getThrowDirection`), so nothing was drawing where that pointed — and an `ImageLabel` drew it
 * there. On 2026-10-22 the desktop moved onto that same label, for the sizing reason above, so there is now one
 * sight, one size and one picture rather than two platform halves. See {@link applySight}, which is a third call in
 * `applyState` beside {@link writeSettings} and {@link applyOffset} rather than part of either.
 *
 * **The camera offset is per *character*, and only that.** `RotationType` and `MouseBehavior` belong to
 * the user, so they are written once and hold across every respawn; the offset lives on the `Humanoid`,
 * so it has to be put back on each new body — see {@link watchCharacter}. The lock itself deliberately
 * survives a death: a player who dies inside the zone comes back locked, which is the whole point of
 * the zone.
 *
 * **Cleanup is the scope, and there is nothing on the other end of it.** Both connections are handed to
 * a Fusion scope the way the HUD controllers hand theirs over, so the file has one thing that owns them
 * — but nothing tears that scope down, because both are meant to outlive everything: the phase
 * subscription has to hear every round for the rest of the session, and the character subscription has
 * to hear every respawn. The only setting change that happens in play is the phase's — playing to
 * intermission, and every way a round can end — and a client that is going away has nothing to put
 * back, because the settings it wrote are the user's and there is no later.
 *
 * **What this is not:** it is not movement. **And it is not the aim — with one bounded exception, added
 * 2026-10-19**: while a mobile client holds a throw at a latched body, the view is turned onto that body's root
 * (see {@link followTarget}), because on a phone the camera *is* the aim and a free view beside an assisted arc
 * shows the player a throw their aim is not making. Everything else about the aim is still `ThrowController`'s:
 * the ray, the cone, the pull and the cap are all read from the camera and none of them is decided here — this
 * file moves the input, and the aim point continues to be a raycast along it rather than a value written beside
 * it. It binds no key at all any more — the one it used to bind was the player's own way out of the lock, and
 * that is gone; the class doc says why — and otherwise the whole of the effect is that the character turns with
 * the view and that the body is not in the way of it.
 */
@Controller()
export class ShiftLock implements OnStart {
	private readonly player = Players.LocalPlayer;

	/**
	 * Whether the camera is being held — or nothing, before this controller has written anything.
	 *
	 * **Optional rather than defaulted to `false`, and that difference is load-bearing.** The settings
	 * this writes belong to the *user* and persist across sessions, so a session that ended while locked
	 * — a crash, a Studio stop — leaves `CameraRelative` behind for the next one. "Nothing written yet"
	 * is therefore a state this has to be able to tell apart from "written, and the answer is no": with a
	 * `false` here the first mount would decide the camera was already released and leave whatever the
	 * last session left. See {@link mount}, which writes the known state before reading anything.
	 */
	private locked?: boolean;

	/**
	 * The cursor the client was wearing before this controller touched it, and whether it was showing.
	 *
	 * **Both halves, because the flag on its own is not the cursor.** `MouseIconEnabled` only decides
	 * whether an icon is *drawn*; the image stays in `MouseIcon` either way, so restoring the flag alone
	 * would hand back whatever image happened to be sitting in the property rather than the one the client
	 * arrived with. Captured once at {@link mount} and put back together on every release, which is also what
	 * makes the release honest: a client wearing somebody else's cursor gets *that* back rather than a default
	 * invented here. **This file only ever switches the icon off now** — the crosshair is drawn rather than worn,
	 * see {@link applySight} — so the capture exists for the restore rather than for a swap.
	 */
	private restingCursor?: string;
	private restingCursorEnabled?: boolean;

	/**
	 * The sight the lock draws — the crosshair, on every platform — or nothing before the first lock.
	 *
	 * **A scope of its own, because this element's life is not the file's.** Everything else here is a
	 * subscription made once at {@link mount} and handed to the mount's scope; the sight cannot be, because it
	 * is created on the first lock rather than at mount (see {@link applySight}) — so it is made inside
	 * `sightScope`, which exists for exactly one element and is never torn down. The alternative was to build it
	 * at mount unconditionally, which would put an invisible `ImageLabel` in the GUI of every client that never
	 * locks — a lobby, or a practice zone nobody has walked into.
	 */
	private readonly sightScope = Fusion.scoped();
	private sight?: ImageLabel;

	/**
	 * What the round says: **the local player is in the round being played** — on a side, and a round on.
	 * **Both halves, and this is a narrowing of what it used to mean.** The field was `phaseLocked`, set
	 * from the phase alone, so the camera was held for *everybody* in the server while a round ran —
	 * including a player in the lobby who had never opted in and was not in the round, not teleported by
	 * its transition and not held by its freeze. The user's rule is "you need to opt in and a round to be
	 * playing", and `roundZone.ts`'s `isParticipant` is that rule stated once for both this and the wipe.
	 *
	 * **The two halves arrive by different routes, which is why there are two subscriptions below.** A
	 * phase change says "the round started or ended"; a change to this player's own `TEAM_ATTRIBUTE` says
	 * "the roster decided something about me" — and the second can happen with no phase change at all,
	 * because a player who walks onto a pad while a round is being played is admitted to it mid-flight.
	 * That player is a participant and gets the camera; see `RoundService.admitMidRoundJoins`.
	 */
	private roundLocked = false;

	/** What the zone says: the local player's body is inside a tagged box right now. */
	private inZone = false;

	/**
	 * **Whether the player has let go of the camera with `~`, and it outranks both of the fields above.**
	 *
	 * A veto rather than a third ask: while this is set, {@link refresh} releases the camera whatever the round and
	 * the zone are saying, which is the only way to get the ordinary camera back in the middle of a round. Cleared by
	 * the next click or tap ({@link reclaimOnPress}), by the same key again ({@link releaseCamera}), and by a round
	 * starting ({@link applyRound}) — and by nothing else, so a player who lets go mid-round keeps the camera until
	 * one of those three happens. **Moving the mouse does not clear it**, deliberately: the release exists to give the
	 * pointer back, and a pointer that reclaims the camera five pixels into its journey can never reach a control.
	 */
	private released = false;

	/**
	 * The local player's body, held so the camera offset can be put on the next one.
	 *
	 * **Held because the offset is the one part of this that is per-character** — see the class doc. A
	 * reference to a body that has since been destroyed is harmless: writing an offset to it does
	 * nothing, and the next `CharacterAdded` replaces it.
	 */
	private humanoid?: Humanoid;

	/**
	 * How many zone parts this controller has already reported, or `undefined` before the first report.
	 *
	 * **The memory is the whole of the fix rather than bookkeeping for its own sake**: the count is
	 * reported *when it changes*, so something has to remember what was said last. See
	 * {@link reportZoneParts} for the log that made a one-time count untenable.
	 */
	private reportedZoneParts?: number;

	/**
	 * Whether {@link followTarget} turned the view on the previous frame — **the edge the follow's log prints on.**
	 *
	 * A field rather than a per-frame line, for the reason `AimTargetController.lastAiming` is one: this runs once
	 * a frame for the length of every assisted hold, and a line a frame buries the one line that says the camera
	 * is following at all. The edge is per *hold*, because a hold is what a latch lives for.
	 */
	private following = false;

	/** The camera's view direction last frame, for the rotational delta {@link reportCamera} measures. */
	private lastLook?: Vector3;

	/** Frames sampled in the current diagnostic second, its mean, its mean of squares, and its worst frame. */
	private sampleFrames = 0;
	private sampleSum = 0;
	private sampleSquares = 0;
	private sampleMax = 0;

	/** Seconds accumulated toward the next `[Camera] summary` line. See {@link CAMERA_DIAGNOSTIC_PERIOD}. */
	private sampleSeconds = 0;

	public onStart(): void {
		// **The first line is printed here, before anything else below it can fail, and that is not
		// decoration.** "Nothing happens" has two causes that look identical from the outside — the module
		// never reached the client, or it ran and died before it printed anything — and this line is what
		// tells them apart. Missing, and nothing below it ran: the question is then whether the file is in
		// `StarterPlayerScripts` at all. Present, and the next line is missing: the question is which call
		// in {@link mount} failed. The HUD controllers print that they are up for the same reason; this
		// one is one step earlier, because what can go wrong here is at the very top.
		logDebug(`[ShiftLock] onStart — mounting`);

		// Spawned rather than done inline: the round folder is made by the *server's*
		// `RoundService.onStart`, so waiting for it can yield — and a controller's `onStart` is the wrong
		// place to hold up the rest of the client's boot for something that is not there yet. The same
		// reason, and the same shape, as the HUD controllers' mounts.
		task.spawn(() => this.mount());
	}

	/** Wires the round, the zone and the player's own key up, once the round folder exists. */
	private mount(): void {
		const status = ReplicatedStorage.WaitForChild(ROUND_STATUS_FOLDER);
		const scope = Fusion.scoped();

		// **The cursor is remembered before anything is allowed to put it back.** It is the one piece of
		// state this file *restores* rather than merely clears, because it is not this file's to own: a
		// client can arrive wearing a cursor somebody else set, and a release that turned the icon off
		// without putting the image back would hand that player a different one. Captured here, once, and
		// used by every release after it — including the reset below, which is what makes a session that
		// ended mid-lock come back with its own cursor.
		this.restingCursor = UserInputService.MouseIcon;
		this.restingCursorEnabled = UserInputService.MouseIconEnabled;

		// **The camera is put back before anything is allowed to decide anything, and that is the order's
		// whole point.** `UserGameSettings` is the user's own store and outlives the session, so this is
		// the line that stops a session starting in the state the last one ended in. It is also the first
		// thing that prints, which makes it the line that says this controller ran at all.
		this.unlock("mounting");

		// Subscribed *before* seeding, so a change landing between the two is not lost — the seed then
		// reads the newer value and wins, which is the order that cannot go wrong either way.
		//
		// **A change is answered late, and that delay is the whole of what this subscription does about
		// it.** `RoundService` publishes the new phase and *then* runs the transition: the grid closes over
		// `TRANSITION_COVER_SECONDS`, the teleport happens once it is shut, and the hold runs from the
		// landing. So the phase is true a fraction of a second before the world it describes is — and a
		// camera that believed it immediately snapped into the shoulder lock and the crosshair while its
		// player was still standing in the lobby, under a grid, waiting to be moved. Answering at the cover's
		// length puts the change on the tick the body actually moves: the lock arrives *with* the teleport
		// rather than before it, and the release at the round's end arrives with the move back to the lobby
		// instead of while the player is still standing in the arena. See {@link phaseDelay}.
		//
		// **Nothing but the folder is captured**, so a timer that fires after the phase has moved on reads
		// the *current* attribute rather than the one that scheduled it — and two timers that fire in an
		// unexpected order cannot disagree, because `applyState` does nothing when the state is already the
		// one asked for. That is what makes this safe without a dismissal token: a late timer in a HUD would
		// *hide* a message; here it recomputes the same answer.
		scope.push(
			status.GetAttributeChangedSignal(ROUND_STATE_ATTRIBUTE).Connect(() => {
				task.delay(this.phaseDelay(phaseOf(status)), () => this.applyRound());
			}),
		);

		// **And the other half of the rule: this player's own side.** `TEAM_ATTRIBUTE` is written at each
		// whistle from the roster and cleared for everybody who is not in it, and written again by
		// `RoundService.setTeam` when a player is admitted to a round that is already being played — so it
		// is the one per-player fact that says "the round is about *me*". Without this subscription the
		// camera would need a phase change to notice, and a mid-round join has none: they would be
		// teleported into the arena with their ordinary camera and stay that way until the next boundary.
		//
		// **The delay is zero for a change made inside a live round, and the ordinary cover's length
		// otherwise.** The phase subscription above waits because the server publishes a phase and *then*
		// moves everybody behind a closing grid — the delay is what lines the camera up with that move.
		// There is no such move here: a mid-round join is teleported straight into the arena, uncovered, so
		// the camera has nothing to wait for and arrives with the body. A side written while the phase is
		// still `Intermission` is the round-*start* write — `assignTeams` runs before the phase is published
		// — and that one takes the transition's own delay, which is what keeps the lock from snapping on
		// while the player is still standing in the lobby under the grid. See `applyRound`, which reads the
		// attribute again when the timer fires rather than trusting the values captured here.
		//
		// **One closure for both subscriptions below**, so a side change and a membership change cannot come to
		// different answers about *when* the camera is allowed to change.
		const applySoon = () => {
			const phase = phaseOf(status);
			const delay = phase === PLAYING ? 0 : this.phaseDelay(phase);

			task.delay(delay, () => this.applyRound());
		};

		scope.push(this.player.GetAttributeChangedSignal(TEAM_ATTRIBUTE).Connect(applySoon));

		// **And membership, which is the half that was missing and is what left the lock stuck in the lobby.** A
		// surrendered player keeps `TEAM_ATTRIBUTE` — the round keeps their seat so the side's head count survives
		// them leaving — so the side subscription never fired and the camera stayed locked, with a crosshair over
		// somebody who had gone back to the lobby. `IN_ROUND_ATTRIBUTE` is cleared in `eliminate`, which is the one
		// method a live round loses a body through, so this is the edge that releases the camera. See
		// `roundZone.isParticipant`, which is the rule both of these end up asking.
		scope.push(this.player.GetAttributeChangedSignal(IN_ROUND_ATTRIBUTE).Connect(applySoon));

		// The seed, and it is the case that matters for a client joining a round already in progress: the
		// folder is there with `Playing` on it and there may be no change left to hear.
		//
		// **Straight through, with no delay at all, and the difference from the subscription above is the
		// point.** A client that has just mounted is not watching for a teleport: the move is either long
		// behind it or arriving with the body it is spawning. There is no moment to line up with, so waiting
		// would be a second of the wrong camera for somebody who has done nothing.
		this.applyRound();

		scope.push(this.player.CharacterAdded.Connect((character) => this.watchCharacter(character)));

		const character = this.player.Character;
		if (character) this.watchCharacter(character);

		// **The backpack's window stays shut, and its reason has changed rather than gone.** It used to be
		// that `~` was the backpack's toggle and this file wanted the key: every press that asked for the
		// camera back would have opened the player's inventory window over the top of it. Nothing binds
		// `~` any more, so the key is free — and the window still goes, because there is nothing to put
		// in it.
		//
		// **The GUI is disabled rather than the CoreScripts' action being unbound**, and that is the
		// difference between a fix and a guess. Unbinding means knowing what the CoreScripts called
		// their action and what priority they bound it at — neither of which is in these typings, both of
		// which can change under the game, and either of which would leave the key working again with
		// nothing to say why. `SetCoreGuiEnabled` is one documented call that is independent of all of
		// it, and it works whatever the CoreScripts do with the key underneath, because there is no
		// window left for them to open. It also does not care *when* they bind: a sweep for the action
		// has to be run after the CoreScripts have started, which is a race this cannot lose.
		//
		// **Safe here because this game has nothing to put in a backpack.** There is no `Tool` anywhere
		// in it — the ball is a part welded to a hand rather than a tool, which `BallService` states as
		// a decision — and the shop sells abilities rather than equipment. What is *not* touched is the
		// container: `Player.Backpack` still exists and a `Tool` in it would still equip, so what is
		// gone is the window rather than any machinery. If tools are ever added, this is the line to
		// revisit — the alternatives are unbinding whatever action owns the key (a sweep of
		// `ContextActionService.GetAllBoundActionInfo`) or moving the backpack to a different key with
		// that same sweep's help.
		StarterGui.SetCoreGuiEnabled(Enum.CoreGuiType.Backpack, false);

		// **The read-back is the point of this line rather than a flourish on it.** `SetCoreGuiEnabled`
		// is a request to Roblox's own CoreScripts rather than a property write, so the only thing worth
		// printing is whether it took: `false` is the evidence, and a `true` here would say the key is
		// still opening an inventory and send the search somewhere else entirely.
		if (DEBUG_LOGGING) {
			logInfo(
				`[ShiftLock] backpack GUI disabled — enabled reads ` +
					`${StarterGui.GetCoreGuiEnabled(Enum.CoreGuiType.Backpack)}`,
			);
		}

		// **Started here rather than on the first lock, so the offset is camera-relative from the first
		// frame of it.** A static vector would be right for one frame and then wrong for as long as the
		// body faced anywhere but the camera — and "wrong" here means swinging the whole frame around the
		// character, which is the thing this exists to stop.
		this.watchOffset();

		// **And the assist's follow, bound once with the lock's own step** — it is a client-lifetime binding too,
		// gated inside rather than re-bound when a hold starts. See `watchFollow`.
		this.watchFollow();

		// **The player's key, bound once for the client's life.** Through `ContextActionService` rather than
		// `UserInputService.InputBegan`, because that is what makes the chat box win: an action does not fire while a
		// text box has focus, so a player typing a line with a `~` in it does not lose their camera. **Two `KeyCode`s
		// for one key**, because the same physical press reports `Backquote` unshifted and `Tilde` with shift — and on
		// some layouts the pair is the other way round — so binding both is what makes the label on the key and the
		// binding the same thing whatever the keyboard says.
		ContextActionService.BindAction(
			RELEASE_ACTION_NAME,
			(_name, state) => {
				if (state !== Enum.UserInputState.Begin) return Enum.ContextActionResult.Pass;

				this.releaseCamera();

				return Enum.ContextActionResult.Pass;
			},
			false,
			Enum.KeyCode.Backquote,
			Enum.KeyCode.Tilde,
		);

		// **And the way back, which is a press rather than the key.** Bound once and gated inside, for the reason
		// `watchOffset` gives about its own render step: the release comes and goes several times a session and a
		// binding re-made on each of them would be a second thing to keep in step with the field.
		scope.push(UserInputService.InputBegan.Connect((input) => this.reclaimOnPress(input)));

		task.spawn(() => this.watchZones());

		// **The count is subscribed to before it is taken, so a tag that lands between the two is not
		// missed.** The signals are the tag's own, which is the point: a part joining or leaving the tag is
		// precisely the event that changes the answer, so this costs nothing between times and needs no
		// poll. Counting on the zone's own tick was the alternative, and ten `GetTagged` walks a second for
		// the life of the session to notice something that happens once is the cost {@link checkZone}
		// refuses when it explains why the zone test reads a published attribute rather than a walk.
		scope.push(
			CollectionService.GetInstanceAddedSignal(PRACTICE_ZONE_TAG).Connect(() => this.reportZoneParts()),
		);
		scope.push(
			CollectionService.GetInstanceRemovedSignal(PRACTICE_ZONE_TAG).Connect(() => this.reportZoneParts()),
		);

		this.reportZoneParts();
	}

	/**
	 * Prints how many `practiceZone` parts this client can see — **and prints it again whenever that
	 * number changes, rather than once.**
	 *
	 * **The failure this fixes is one a session's log shows, not one imagined.** The boot line read `0
	 * practiceZone part(s)` while the *server's* own `[Zone] up` line read `1 tagged part(s)` in the same
	 * second — and the lock then engaged on that zone four seconds later, so the parts were there all
	 * along and the zero was a fact about replication rather than about the tag. A client mounts when the
	 * GUI does and the map streams in behind it; a count taken at that moment reads `0` for "nothing is
	 * tagged" and for "nothing has arrived yet" alike, and it is the second of those the reader used to be
	 * sent looking for in the place file. **A line that cannot tell those two apart is worse than no
	 * line.**
	 *
	 * **The first line keeps its wording exactly**, so it stays the line to grep for a controller that
	 * mounted at all; what arrives later is a second line in its own words rather than a rewrite of the
	 * first — and a removal says so too, because a tag taken off the box in Studio is the same fact
	 * arriving from the other side.
	 *
	 * **`taggedParts` rather than a count of the raw tag members**, so the number matches what the zone
	 * rules actually read: the tag may go on the box or on a folder holding it, and this is the helper
	 * that says those two are the same parts. See `shared/taggedParts.ts`.
	 */
	private reportZoneParts(): void {
		const count = taggedParts(PRACTICE_ZONE_TAG).size();
		if (count === this.reportedZoneParts) return;

		const first = this.reportedZoneParts === undefined;
		this.reportedZoneParts = count;

		if (!DEBUG_LOGGING) return;

		if (first) {
			logInfo(
				`[ShiftLock] up — ${count} ${PRACTICE_ZONE_TAG} part(s), ` +
					`watching during ${INTERMISSION}, no key bound`,
			);
		} else {
			logInfo(`[ShiftLock] ${PRACTICE_ZONE_TAG}: now ${count} part(s)`);
		}
	}

	/**
	 * How long to wait before believing a phase change, in seconds.
	 *
	 * **The server's own figure for the moment the world changes**, rather than a second duration kept in
	 * step with it: `RoundService` publishes the new phase, waits `TRANSITION_COVER_SECONDS` behind the
	 * closing grid, and only then moves everybody. Waiting the same number from the same event — the
	 * attribute going out, which is the frame the transition is announced in — is what puts this camera's
	 * change on the tick the bodies move. That is the arrangement `transitionAround` and the arena freeze
	 * already use, and the one `TeamRingController` makes for the same reason.
	 *
	 * **The two boundaries are armed separately, because they are not equally covered.** A round always
	 * wipes — the round-start call says nothing about `wipe`, and the default is yes — so entering `Playing`
	 * always waits the cover out. Leaving it waits out the *round-end* cover, which `WIPE_AT_ROUND_END` can
	 * switch off; with it off the server moves everybody in the same frame the phase goes out, and a delay
	 * there would be the camera lagging a player who has already been moved.
	 *
	 * **Zero when the transition is off altogether**, which is the switch's own reading: no cover means the
	 * move is immediate, and there is nothing left to line up with.
	 */
	private phaseDelay(phase: string | undefined): number {
		if (!TRANSITION_CONFIG.ENABLED) return 0;
		if (phase === PLAYING) return TRANSITION_COVER_SECONDS;
		if (!TRANSITION_CONFIG.WIPE_AT_ROUND_END) return 0;

		return TRANSITION_COVER_SECONDS;
	}

	/**
	 * Reports whether this player is in the round, and lets {@link refresh} work out what that means.
	 *
	 * **It asks `isParticipant`, which reads both facts itself rather than being handed a phase.** That is
	 * what lets one method answer both subscriptions in {@link mount}: a phase change and a change to this
	 * player's own side are two different events, and "am I in the round" is the same question at either
	 * one. It is also what makes a delayed call safe — the second paragraph of the subscription's comment
	 * counts on a late timer reporting the *current* world, and a method that re-reads both attributes
	 * cannot report any other.
	 *
	 * **No parameter, where it used to take the phase.** It recorded `phase === PLAYING`; the phase is now
	 * one half of a question that is not about the phase alone, and the half that a caller could have passed
	 * in without going stale is the half the caller is not there to report.
	 *
	 * **When it runs is still the caller's business, not its own.** It is called straight through with the
	 * seed, a cover's length late with a phase change, and immediately or a cover late with a side change —
	 * see {@link mount} and {@link phaseDelay} for why those differ — and it deliberately holds no opinion
	 * about which it is. So `roundLocked` describes the world as of the last time this was called, which
	 * during a transition is a roster the server wrote a fraction of a second earlier.
	 *
	 * **The phase is one input rather than the rule.** It used to release the lock outright on
	 * entering the intermission and hand the camera to the zone check; now it only reports whether a
	 * round is being played, and the lock is held while the round or the zone asks for it. The visible
	 * difference is one case, and it is a fix: a player standing in a zone when a round ends keeps the
	 * camera, instead of losing it for the tenth of a second the zone tick takes to put it back.
	 *
	 * **It does one thing more: it takes the player's release back, on a round *starting*.** See the edge test in the
	 * body — a round beginning is a new ask and the release belonged to the old one, while a later publication of
	 * `Playing` (a mid-round rejoin, a membership write) must not clear a release the player made during the round.
	 * That was this method's job before the key was removed and it is its job again now the key is back
	 * (2026-10-22).
	 */
	private applyRound(): void {
		const wasLocked = this.roundLocked;

		this.roundLocked = isParticipant(this.player);

		// **The edge rather than the state, and the difference is one press.** `applyRound` runs on every phase change
		// and every membership write, so clearing whenever `roundLocked` is true would take the release back on a
		// mid-round rejoining write, a second after the player made it.
		if (!wasLocked && this.roundLocked) this.released = false;

		this.refresh();
	}

	/**
	 * Watches the lobby zone for as long as the client is running, in **every** phase.
	 *
	 * **A loop rather than a connection, and the interval is the whole of it.** `BallPickupService` runs
	 * the same shape for the same reason: there is no event that says "somebody walked into a box", so
	 * the choice is between asking on a clock and listening to every contact inside it — and a `Touched`
	 * listener carries edge cases a query does not: a `TouchEnded` that never arrives because the
	 * character died, one event per part of a body, and a part that fired while the character was still
	 * being replicated.
	 *
	 * **Not gated on the phase, which is what leaves the zone a zone.** A tick that finds the player in a
	 * box during a round changes nothing — the round is already asking for the same lock — and a tick that
	 * finds them outside one cannot take a lock away from the round either, because the round's answer is
	 * one of the two inputs the lock is worked out from rather than something this loop can overwrite.
	 * Between those two, the check is free to run always, which is one rule fewer to keep in step.
	 */
	private watchZones(): void {
		while (true) {
			task.wait(SHIFT_LOCK_CONFIG.ZONE_TICK_INTERVAL);

			this.checkZone();
		}
	}

	/**
	 * Reports what the zone says, and lets {@link refresh} work out what that means.
	 */
	private checkZone(): void {
		const character = this.player.Character;

		// **A body that is not there is not an answer either way.** A player between bodies — dead and
		// waiting, or still spawning — has nothing to stand in a zone with, so what the zone last said is
		// left exactly as it is: the lock survives the death rather than flickering off and on, and the
		// tick after the respawn corrects it if they came back somewhere else.
		if (!character) return;

		const wasInside = this.inZone;

		// **The box itself is asked about somewhere else now.** The tag, the bounds test and the note that
		// the part *is* the box all live in `client/roundZone.ts`, because the dodge input needs the same
		// answer and a rule about where you may act does not survive two copies of itself. What stays here
		// is what is the camera's own: the tick, and the change detection below.
		//
		// **The split is worth having because of the rates.** This runs ten times a second and is the whole
		// reason a zone is noticed at all; the dodge asks once per press — a movement key plus a right-click —
		// which is a handful of times a second at most. Neither of them caches, and both are reading the same
		// function.
		this.inZone = inTaggedZone(character);

		// Only when the answer changed, which is what keeps the loop's ten-a-second silence: nothing here
		// needs working out twice, and `refresh` would otherwise be asked to re-derive a state it already
		// has.
		if (this.inZone !== wasInside) this.refresh();
	}

	/**
	 * Tracks the local player's body, so the offset can be put on the next one.
	 *
	 * **A death does not disturb the lock.** `RotationType` and `MouseBehavior` are the *user's* settings
	 * and do not care about characters at all, so a player killed inside the zone respawns still locked;
	 * the offset is the one part that lives on a body, and putting it back on a fresh one is the whole of
	 * this method.
	 */
	private watchCharacter(character: Model): void {
		// Waited on rather than looked for once: a client can be handed a character whose `Humanoid` has
		// not replicated into it yet — the note in `AlternativeMovementController` records exactly that
		// case — and a body with no humanoid in it has nothing to offset.
		const humanoid = character.WaitForChild("Humanoid");
		if (!humanoid.IsA("Humanoid")) return;

		this.humanoid = humanoid;
		this.applyOffset();
	}

	/** Whether the camera is being held. The one query the rest of this file asks. */
	private isLocked(): boolean {
		return this.locked === true;
	}

	/** Holds the camera, and says why in the log. */
	private lock(reason: string): void {
		this.applyState(true, reason);
	}

	/** Releases the camera, and says why in the log. */
	private unlock(reason: string): void {
		this.applyState(false, reason);
	}

	/**
	 * **The player's `~` press: let go of the camera, or take it back — whichever way the switch is pointing.**
	 *
	 * **A veto rather than a third ask**, which is the distinction the class doc works out: the round and the zone
	 * ask for the lock, and this only ever refuses to honour them. That is what lets it work in the middle of a round
	 * without a second set of conditions in {@link refresh} — the release is checked first and, while it is set,
	 * nothing below it gets a say.
	 *
	 * **Both directions, because a key that only works one way is a key a player presses twice.** A click or a tap is
	 * how the camera normally comes back ({@link reclaimOnPress}), so pressing `~` again is the second way to do the
	 * same thing and costs one branch here rather than a second binding.
	 *
	 * **Silent when there is nothing to let go of.** A press in the lobby changes no state, so it says nothing: a
	 * notification reading "Camera Unlocked" over a camera the round never held would be the one message this feature
	 * must not send. The notification is pushed on the *transition* and nowhere else, so the string always describes
	 * something that happened.
	 *
	 * **Two presses in one second push two notifications**, which is deliberate — the stack caps itself at three and
	 * a switch flipped twice is two facts — rather than a dedupe this file would have to keep.
	 */
	private releaseCamera(): void {
		if (this.released) {
			this.released = false;
			this.refresh();
			pushNotification("Camera Locked");

			return;
		}

		if (!this.isLocked()) return;

		this.released = true;
		this.refresh();
		pushNotification("Camera Unlocked");
	}

	/**
	 * **The way back: any click, or a tap.** Pressing a mouse button while the camera is released puts the lock back
	 * on — all three buttons, because "any click" is the rule and a middle-click is a click.
	 *
	 * **A press rather than the pointer moving, and the first version of this got that wrong in a way worth
	 * recording.** It re-locked when a single `InputChanged` delta crossed five pixels, on the reasoning that a
	 * deliberate look is tens of pixels and a resting hand is one or two. What that missed is what the release is
	 * *for*: with the pointer free, reaching any control — the dock, a panel, the score — is hundreds of pixels of
	 * movement, so the camera came back five pixels into the journey and the pointer could never arrive. The
	 * threshold was measuring the thing the release exists to allow. **A click is the moment the player is going
	 * back to playing**, and it is a single unambiguous event rather than a distance.
	 *
	 * **`InputBegan` and not a claim**, so the click still does its own job: `MouseButton1` is the throw and
	 * `MouseButton2` the dodge, both bound elsewhere, and this observes the press rather than sinking it — which
	 * means the shot a player fires to get their camera back is a shot, not a swallowed input.
	 *
	 * **`Touch` is accepted for the same reason it was before**: a tablet with a keyboard attached can reach `~`
	 * and its screen is also a button. A touch-only client cannot enter the released state at all, because `~` is
	 * the only way in and there is no key to press.
	 *
	 * **The release is cleared before `refresh`, never after**, so the lock's own state machine is the only thing
	 * that decides what the camera does; this method's whole job is to flip one field and report it.
	 */
	private reclaimOnPress(input: InputObject): void {
		if (!this.released) return;

		if (
			input.UserInputType !== Enum.UserInputType.MouseButton1 &&
			input.UserInputType !== Enum.UserInputType.MouseButton2 &&
			input.UserInputType !== Enum.UserInputType.MouseButton3 &&
			input.UserInputType !== Enum.UserInputType.Touch
		) {
			return;
		}

		this.released = false;
		this.refresh();
		pushNotification("Camera Locked");
	}

	/**
	 * Works out whether the camera should be held, from the two things that can ask for it.
	 *
	 * **The round and the zone are added, and neither can undo the other.** A player who is *in* the round
	 * is held for the whole of it and stays held whatever they do with their feet; a zone asks for the same
	 * lock outside a round. That is what makes the zone safe to check at all times: it can *add* the lock,
	 * but it can never take away one the round is holding — so a player who walks out of a lobby zone
	 * mid-round is still locked, which is the rule the round exists to have.
	 *
	 * **The first input is "in the round", not "a round is on", and that narrowing is the user's rule.** It
	 * used to be the phase alone, which held the camera for a player in the lobby who had opted into nothing
	 * and was in nothing; see the field's own comment. What is unchanged is the reading order below, so the
	 * line still names the round when the round is why.
	 *
	 * **There is a third input and it is the player's own key, restored 2026-10-22, and it outranks both of these.**
	 * See {@link releaseCamera}: it is a *veto* rather than an ask, so it can never hold a lock nothing asked for, and
	 * it is the only way to get the ordinary camera back in the middle of a round. It is checked first and returns
	 * early, because that is the only thing "outranks" can mean while the two terms below stay as they are.
	 *
	 * **The reason printed names which input is saying something**, so the log reads the way the rule does:
	 * `locked — the round`, `locked — the zone`, `unlocked — nothing is asking for it`, and
	 * `unlocked — the player let go of it`. The last is the only one that names a person, and the only one that can
	 * print while a round is still being played.
	 */
	private refresh(): void {
		// **The veto, checked before anything else can ask.** Nothing below this line runs while the player has the
		// camera, which is why neither the round nor the zone needs a second condition added to it.
		if (this.released) {
			this.unlock("the player let go of it");

			return;
		}

		const asking = this.roundLocked ? "the round" : this.inZone ? "the zone" : "nothing is asking for it";

		if (this.roundLocked || this.inZone) {
			this.lock(asking);
		} else {
			this.unlock(asking);
		}
	}

	/**
	 * Writes the state out: the two user settings, the offset, and a line if anything changed.
	 *
	 * **Nothing happens when the state is already the one asked for**, which is what makes the callers
	 * above safe to call as often as they like — the zone tick asks for the same answer ten times a
	 * second and only the transitions cost anything or print.
	 */
	private applyState(on: boolean, reason: string): void {
		if (this.locked === on) return;

		this.locked = on;

		// **Printed before the settings are written rather than after, and that ordering is the whole of
		// what this file learned the hard way.** The write is the one step here that can fail — it is the
		// step that talks to a service whose availability the typings cannot vouch for — and a print placed
		// after it is absent in exactly the case worth diagnosing, where "the line is missing" reads as
		// "the state never changed" and sends the search in the wrong direction entirely. Printed first,
		// the log shows the decision and then whatever became of it.
		if (DEBUG_LOGGING) {
			logInfo(`[ShiftLock] ${on ? "locked" : "unlocked"} — ${reason}`);
		}

		this.writeSettings(on);
		this.applySight(on);
		this.applyOffset();
	}

	/**
	 * **The sight: the crosshair, drawn on the screen itself — on every platform, and it is the whole of the cursor.**
	 *
	 * **It used to be the phone's half. It is the crosshair everywhere as of 2026-10-22**, and the reason is a
	 * property that does not exist: **a mouse icon cannot be sized.** `UserInputService` offers `MouseIcon`,
	 * `MouseIconContent` and `MouseIconEnabled` and nothing else, so while a desktop wore the cursor its crosshair was
	 * whatever size that PNG happened to be, on every device, with no number in this project able to change it. From a
	 * seat in front of one, `SIGHT_SIZE` looked like a constant that was not connected to anything.
	 *
	 * **So the icon is *hidden* while the lock is on and this marks the same pixel instead.** Nothing is given up by
	 * hiding it: `MouseBehavior.LockCenter` has already pinned the pointer to the middle of the screen — see
	 * {@link writeSettings} — so a locked client's icon was a pointer that could not be pointed anywhere. What it drew
	 * is now drawn by an `ImageLabel` of a size this project chooses, and the cursor the client arrived wearing is put
	 * back, image and flag together, on every release.
	 *
	 * **The same two ids the cursor used**, because they are the art of the sight rather than of one platform: the
	 * lock's crosshair, and the lock's crosshair while a ball is in hand. One `Computed` over `holdingBall` swaps them,
	 * so the swap costs one property on the frame the hand changes and nothing at all in between.
	 *
	 * **It is a sibling of the HUD rather than part of one.** The lock is not a HUD: it is a camera rule that
	 * three readouts happen to move with, and it is on for players who have no HUD element in mind at all. So the
	 * aim marker belongs to the thing that owns the aim, and any HUD that ever wants to draw over it can — the
	 * rung is below the dock's.
	 */
	private applySight(on: boolean): void {
		if (this.sight === undefined) {
			// Built on the first lock rather than at mount, so a client that never locks never makes an instance.
			// **Into its own GUI**, and that is what makes the position below two scale numbers rather than
			// arithmetic: a `ScreenGui` with `None` insets has the screen for its coordinate space, so
			// `(0.5, 0.5)` *is* the middle of the screen — and the middle of the screen is where the throw goes on
			// both platforms: a phone aims along the camera's own axis, and a locked desktop's pointer has been
			// pinned to that same pixel. See `getScreenSpaceGui` for why the shared HUD GUI cannot do this job.
			const sight = Fusion.New(this.sightScope, "ImageLabel")({
				Name: "AimSight",
				// **Bound to the hand rather than fixed to one id.** The sight has two pictures now — the lock's, and
				// the lock's while a ball is in hand — and a `Computed` is what makes the swap one property on the
				// frame the hand changes and nothing at all on the frames in between. Fusion re-evaluates it only
				// when `holdingBall` is set to a different value, which is what stops this being a per-frame write
				// to an `Image` (a content id, and therefore an asset lookup, not a cheap property).
				Image: Fusion.Computed(this.sightScope, (use) =>
					use(holdingBall) ? SHIFT_LOCK_CONFIG.HOLDING_CURSOR : SHIFT_LOCK_CONFIG.LOCKED_CURSOR,
				),
				BackgroundTransparency: 1,
				// **The sight's own alpha, and it is the label's rather than the file's.** Half, one number for both
				// pictures — see {@link SIGHT_TRANSPARENCY}, which is the lever and states the reversal. This is the
				// property a reader looks for when a crosshair is too loud, and it is written here rather than in the
				// `Computed` above because the two ids fade identically.
				ImageTransparency: SIGHT_TRANSPARENCY,
				// **`SIGHT_SIZE`, and it is now the only number that sizes a crosshair in this project** — the one
				// thing a reader changes to make the sight bigger or smaller. Pixels rather than a fraction of the
				// viewport, so it is the same mark on a phone, a tablet and an ultrawide: the middle of the view is
				// where the throw goes, and the thing that says so should not grow with the window.
				Size: UDim2.fromOffset(SIGHT_SIZE, SIGHT_SIZE),
				AnchorPoint: new Vector2(0.5, 0.5),
				Position: UDim2.fromScale(0.5, 0.5),
				// **`Visible` is not a `Computed` and has no `Value` behind it**, because this controller *is* the
				// state: `applyState` is the only writer of the lock and it hands the answer in on its way past.
			});

			sight.Parent = getScreenSpaceGui();
			this.sight = sight;
		}

		this.sight.Visible = on;
		logDebug(`[ShiftLock] sight ${on ? "up" : "down"}`);
	}

	/**
	 * Writes the engine's camera settings for this state, reporting rather than throwing.
	 *
	 * **Guarded, and reported, because this is the one part of this file the typings cannot vouch for.**
	 * The types are declared, the properties are declared writable, and whether any of that is true on a
	 * given client is a *runtime* fact — so an unguarded call that failed took the rest of {@link mount}
	 * down with it and left no line at all, which is indistinguishable from the controller never having
	 * run. That is the failure this shape exists to make impossible: every write here either happens or
	 * says so.
	 *
	 * **The three are written independently, so one failing does not cost the others.** They are three
	 * parts of one effect — the character turning with the view, the mouse being held at its centre, and
	 * the engine's own cursor getting out of the way of the drawn sight — and a client that can do two of
	 * them should do the two and report which one is missing.
	 *
	 * See the class doc for why the camera's `CFrame` is not the seam to use instead, and {@link applySight}
	 * for the crosshair that replaces the hidden cursor.
	 */
	private writeSettings(on: boolean): void {
		const settings = cameraSettings();

		if (settings) {
			const [ok, problem] = pcall(() => {
				settings.RotationType = Enum.RotationType.MovementRelative;
			});

			if (!ok) logWarn(`[ShiftLock] RotationType refused: ${tostring(problem)}`);
		}

		const [mouseOk, mouseProblem] = pcall(() => {
			UserInputService.MouseBehavior = on ? Enum.MouseBehavior.LockCenter : Enum.MouseBehavior.Default;
		});

		if (!mouseOk) logWarn(`[ShiftLock] MouseBehavior refused: ${tostring(mouseProblem)}`);

		// **The engine's cursor is *hidden* while locked, because the sight is the crosshair now.** The write above has
		// already pinned the pointer to the middle of the screen (`LockCenter`), so the icon it would draw is a pointer
		// that cannot be pointed anywhere — and it cannot be sized or tinted either, which is why `SIGHT_SIZE` used to
		// reach only a phone. The drawn sight marks exactly the same pixel at a size this project decides.
		//
		// **Both halves still go back on the way out**, image and flag, for the reason the resting capture exists: a
		// client that arrived wearing somebody else's cursor gets *that* back, and leaving a crosshair in the property
		// would bring it straight back the moment anything re-enabled the icon.
		const [cursorOk, cursorProblem] = pcall(() => {
			if (on) {
				UserInputService.MouseIconEnabled = false;
			} else {
				UserInputService.MouseIcon = this.restingCursor ?? "";
				UserInputService.MouseIconEnabled = this.restingCursorEnabled ?? false;
			}
		});

		if (!cursorOk) logWarn(`[ShiftLock] the cursor refused to change: ${tostring(cursorProblem)}`);
	}

	/**
	 * Puts the camera offset on the body, or takes it off, according to the current state.
	 *
	 * Safe to call with no body — a player who has not spawned yet has nothing to offset, and their
	 * state is deliberately kept across the gap. See {@link watchCharacter}.
	 *
	 * **What it writes is not `CAMERA_OFFSET` itself**, and the difference is the whole of
	 * {@link offsetForBody}. Called on every state change *and* once a frame while locked — see
	 * {@link watchOffset}, which is the half that keeps the shoulder on one side of the screen.
	 *
	 * **It is exact, and there is no easing here any more.** An exponential ease lived on this method for one
	 * revision, chasing the recomputed value, and it was the wrong medicine: the fault was never that the
	 * value moved too far in a frame, it was that the value was **applied in a different body frame from the
	 * one it was computed in**, which turns the body's own turn into camera motion. An ease blurs a 180° whip
	 * into a sway and leaves the flaw in place — which is exactly what it did. The cause is fixed in
	 * {@link watchOffset} by writing one step before the camera reads, where the conversion cancels exactly;
	 * with nothing left to damp, a smoothing constant would be a lag with no job.
	 */
	private applyOffset(): void {
		const humanoid = this.humanoid;
		if (!humanoid) return;

		humanoid.CameraOffset = this.isLocked() ? this.offsetForBody() : Vector3.zero;
	}

	/**
	 * `SHIFT_LOCK_CONFIG.CAMERA_OFFSET` — an offset meant in **camera** space, converted into the frame
	 * `Humanoid.CameraOffset` is actually applied in, which is the body's.
	 *
	 * **The conversion, and why it is a no-op most of the time.** The property is body-relative — the
	 * config entry carries the elimination that shows it, since there is no documentation to quote — so a
	 * static value rotates with the player while the screen does not: turn to face the camera and the
	 * shoulder the view sits over changes sides. Rotating the intended camera-space vector into the body's
	 * frame first, every frame, makes the *world* result the camera-relative one. So the body keeps the
	 * same side of the screen however it is pointing, which is what the config value always meant to say.
	 *
	 * **When the body already faces the way the camera looks — the ordinary case, and the only one a
	 * static offset ever got right — the two frames agree and this returns the config's vector
	 * unchanged.** That is the property worth holding on to: the shoulder a player is used to is exactly
	 * where it was, and the change is visible only in the poses that used to be wrong.
	 *
	 * **The conversion is only valid in the frame it was computed in, and that is what {@link watchOffset}'s
	 * binding order buys.** Written down as algebra, because the whole of the wobble is in it: this returns
	 * `R⁻¹ · (C · intent)` for the body's rotation `R` and the camera's `C`, and the engine applies the result
	 * in `R` — so the world offset is `C · intent`, the intent rotated into camera space, with `R` cancelling.
	 * **That cancellation only happens while both `R`s are the same frame's.** Bound after the camera, they
	 * are not — the value is computed against one body orientation and applied against the next — and what
	 * survives is the body's own turning, which is a 180° swing every time the player reverses direction.
	 *
	 * Falls back to the raw vector when either frame is missing — no body, or no camera yet — because an
	 * unconverted offset is simply the old behaviour, which is the better failure: a shoulder in the wrong
	 * place for a frame, rather than a `nil` written into a property.
	 */
	private offsetForBody(): Vector3 {
		const intent = SHIFT_LOCK_CONFIG.CAMERA_OFFSET;

		const root = this.humanoid?.RootPart;
		const camera = Workspace.CurrentCamera;
		if (!root || !camera) return intent;

		return root.CFrame.VectorToObjectSpace(camera.CFrame.VectorToWorldSpace(intent));
	}

	/**
	 * Keeps the offset camera-relative for as long as the client is running, from the render step.
	 *
	 * **Bound *before* `RenderPriority.Camera` — two steps before, with `cameraShake` between — and that
	 * reversal is the fix for "moving back and forward wobbles the camera".**
	 *
	 * The whole of it is a frame ordering that looks harmless and is not. `Humanoid.CameraOffset` is applied in
	 * the *body's* frame, and the value written here is computed by converting the camera-space intent into
	 * that frame — so **the conversion is only exact if the body frame used to write is the body frame used to
	 * apply**. Bound after the camera, it is not: the camera reads the property before this file writes it, so
	 * frame N's value is applied in frame N+1's body, and the world result is rotated by however far the body
	 * turned in between. **The body turns on its own** — `RotationType` is `MovementRelative`, so it faces the
	 * way it is walking — and walking backwards turns it through 180°. The shoulder therefore swings round the
	 * character every time the player reverses direction, which is the reported symptom exactly, and the
	 * reason it shows up on *movement* rather than on turning the view.
	 *
	 * **Writing before the camera takes the body out of the sum entirely.** The camera applies the property
	 * moments later in the same frame, in the same body frame this file read to compute it: `R⁻¹ · (C · intent)`
	 * applied in `R` is `C · intent`, with `R` gone. What is left is that `C` is the previous frame's camera
	 * rotation, so the offset trails the view by one mouse movement — a degree or two, a couple of hundredths
	 * of a stud, and not something an eye can find.
	 *
	 * **The old argument is kept because it was half right, and the half it missed is the interesting part.**
	 * This was bound at `Camera.Value + 1` on the reasoning that the yaw read would then be the current
	 * frame's, and that "a shoulder a frame behind a mouse that moved a pixel in the meantime is not something
	 * an eye can find". Both clauses are true. What the reasoning did not weigh is that the *other* one-frame
	 * lag — the one on the body's rotation — is 180° when a player reverses, not a pixel. It is also why a
	 * smoothing pass over the written value improved this without fixing it: **an ease blurs a whip into a
	 * sway**, and cannot remove a rotation that is applied in a frame the value was not computed in. That ease
	 * has been taken back out; see {@link applyOffset}.
	 *
	 * **`cameraShake` moved with it**, to `Camera.Value - 1`. It composes on this file's value, so it has to
	 * run after this write and before the camera reads — which also means it now adds its kick to *this*
	 * frame's shoulder rather than to the previous one's. See its own doc, where the ordering argument is
	 * rewritten on the same finding.
	 *
	 * **Bound once and never unbound**, with the lock checked inside it. The lock comes and goes several
	 * times a session — a round, a zone — and a binding re-established on each of those would be a second
	 * piece of state to keep in step with {@link isLocked}.
	 *
	 * **This is not the camera fork the class doc argues against, and the distinction is the point.**
	 * Nothing *in this method* writes `Camera.CFrame` or takes the camera over: Roblox's own scripts still decide
	 * where the camera is, and this only feeds them a correct input instead of a static one. What is being
	 * replaced is a value that was only ever right in the pose where the body and the camera agree. **The file's
	 * one `CFrame` write is the assist's follow** — {@link watchFollow}, added 2026-10-19 and documented as the
	 * class doc's single exception; it is not this, it runs after the scripts rather than instead of them, and it
	 * is conditional on a mobile client holding a throw at a latched body.
	 */
	private watchOffset(): void {
		// **The two mount-time diagnostic lines, printed before the binding is made** — see
		// `reportCameraSources`, which is where the reading of the source is written down and why it is
		// printed rather than argued.
		if (CAMERA_DIAGNOSTICS) this.reportCameraSources();

		// **`Camera.Value - 2`, with `cameraShake` at `- 1` and the camera itself at `0`.** This file writes
		// the shoulder, the shake adds its kick on top, and then the camera reads the sum — which is what
		// makes the body frame the same one on both sides of the conversion. See the doc above.
		RunService.BindToRenderStep("ShiftLockOffset", Enum.RenderPriority.Camera.Value - 2, (delta) => {
			if (this.isLocked()) this.applyOffset();

			// **The measurement still runs here**, and reading the view one frame before the camera sees this
			// value costs nothing: what it measures is how far the *camera* rotated between frames, which is a
			// property of the camera rather than of this write. See {@link reportCamera}.
			if (CAMERA_DIAGNOSTICS) this.reportCamera(delta);
		});
	}

	/**
	 * **Binds the assist's follow, once, for the client's life** — a second render step beside {@link watchOffset},
	 * gated inside rather than re-bound when a hold starts.
	 *
	 * **After the camera scripts, and that is the whole of the choice.** They place the camera at
	 * `RenderPriority.Camera`; a write before them would be overwritten, and a write at the same priority would be
	 * an order the engine picks at random. `Camera.Value + 1` is the first step that can change their answer and
	 * keep it.
	 *
	 * **What that costs the aim is at most one frame, and the figure is the rate limit's own.** The aim is read
	 * from `RenderStepped` (`ThrowController.updateGuide`), and the engine's exact order between that signal and
	 * the priority-ordered render steps is **not** stated in the typings — so the honest claim is "the aim sees
	 * this rotation within a frame", which at 60 fps and `AIM_ASSIST_FOLLOW_DEGREES_PER_SECOND` is 2° of a turn
	 * that is already converging. It is named rather than fixed by reordering a controller that has nothing to do
	 * with the camera. **`Humanoid.CameraOffset` trails on the same order** — {@link watchOffset} computes it two
	 * steps earlier, from the camera rotation this step last left behind — which is the lag that doc already
	 * accepts for a mouse movement.
	 *
	 * **Nothing happens on a desktop, with no ball in hand, or with nothing latched**, and the query answers the
	 * last two: `latchedTarget()` returns nothing unless the latch belongs to the *live aim session*, so a drop, a
	 * death, a round boundary that empties the hand and a throw that does not refill it all end the follow on the
	 * frame they happen — **with no "stop" write anywhere**, because not writing is stopping.
	 *
	 * **It used to say "outside a hold", and the gate was `chargeStartedAt`; the difference is the feature.** The
	 * follow now runs while the player is only *aiming* at a body, which is the whole point of the change — the
	 * query is unchanged, and what got longer-lived is the answer it reads. A release on its own therefore does
	 * **not** end the follow: the throw is gone, the aim is not, and the hand holds the next ball. That is
	 * deliberate rather than an oversight — see `followTarget` for what it costs the player.
	 *
	 * **Not gated on the lock being on, deliberately.** The lock's inputs are the round and the zone, and both are
	 * where a latched body can exist, so the two gates agree in practice — but the follow needs only its own
	 * preconditions, and gating on `isLocked()` would make this a second copy of the lock's rule. `isMobile()` *is*
	 * a gate, because the assist exists nowhere else.
	 */
	private watchFollow(): void {
		RunService.BindToRenderStep("AimAssistFollow", Enum.RenderPriority.Camera.Value + 1, (delta) =>
			this.followTarget(delta),
		);
	}

	/**
	 * One frame of the follow: turn the view toward the latched body's **root**, by at most the rate limit.
	 *
	 * **The root and not the lead, and the loop is why.** The aim point is a raycast along *this camera's*
	 * `LookVector`, so a camera turning toward the *lead* would be chasing a point decided by the flight time,
	 * which is decided by the aim point, which is decided by the camera — a fixed point across three subsystems,
	 * and the shape of an oscillation. The root depends on none of it: the camera converges on the body, the ray
	 * lands on the body, the arc leads *past* it. **Everybody is measuring something nobody is moving.**
	 *
	 * **A rate, not an ease, and there is no engage snap.** The angle to the root is measured and at most
	 * `AIM_ASSIST_FOLLOW_DEGREES_PER_SECOND × delta` of it is taken, so a large error leads to a constant-speed
	 * turn and a small one is barely touched — the approach settles rather than arriving. A snap would be the
	 * camera taking the player's aim off them in one frame; an ease on top of the rate would be a second speed to
	 * tune against the first.
	 *
	 * **The deadzone exists because a walking root is not still** — see the constant. It is measured as the same
	 * angle the rate limits, so the camera stops within `AIM_ASSIST_FOLLOW_DEADZONE_DEGREES` of the body, which at
	 * a body's range is well inside a torso: the crosshair stays on it and the jitter under it stops moving the
	 * view.
	 *
	 * **The player's own drag is blended rather than blocked, and that is a consequence rather than a setting.**
	 * Roblox's camera scripts still run first with the touch delta they were given, so a drag moves the view; this
	 * then takes back up to the rate limit's worth of it. Below the rate the drag wins, above it the follow does,
	 * and the crossover is why the number is a *rate*: the player's input is never discarded outright and there is
	 * no second blend factor to tune against the first. **What that costs, stated**: a player who deliberately
	 * swings the view away mid-hold is slowly pulled back, which is the assist working rather than a fault.
	 *
	 * **And releasing no longer stops it, which is the one cost the pre-charge change added.** The way out used to
	 * be "let go of the button", because the follow was keyed on the charge. It is now keyed on having a ball in
	 * hand — the honest answer to "could this player throw at that body" — so the ways out are to lose the ball
	 * (throw it, drop it, die) or to aim so far off a body that the latch drops. **A player who finds the pull
	 * itself unwelcome has no off switch**, and that is stated here rather than solved: the alternative is a
	 * preference, the assist is `isMobile()`-only by construction, and `AIM_CONFIG.AIM_ASSIST_STRENGTH` is the
	 * number to turn down if the answer turns out to be "less of it".
	 *
	 * **`Camera.CFrame` is written, and the class doc's one exception is this line.** Only the *orientation*
	 * changes: the position is read from what the camera scripts produced, which is what keeps
	 * `Humanoid.CameraOffset` and the rest of the shoulder intact. `CFrame.lookAt` keeps the up vector upright; a
	 * body almost straight above or below is refused, because `lookAt` has no stable up vector there and no aim is
	 * made that way.
	 */
	private followTarget(delta: number): void {
		if (!isMobile()) return;

		const target = latchedTarget();

		// **The log's off edge, and the only place the follow reports stopping.** Reached on the frame after a
		// release, a dropped latch or a cancelled charge — the same frame the player gets their camera back. See
		// `latchedTarget` for why the query is what notices.
		if (target === undefined) {
			if (this.following) {
				this.following = false;
				logDebug(`[ShiftLock] follow — off`);
			}

			return;
		}

		if (target === this.player.Character) return;

		// **Engaged as soon as there is a body to turn onto**, before any geometry: a frame that is already inside
		// the deadzone is still a frame this is following on, and the log should say so.
		if (!this.following) {
			this.following = true;
			logDebug(`[ShiftLock] follow — on ${target.Name}`);
		}

		const camera = Workspace.CurrentCamera;
		if (!camera) return;

		const root = target.FindFirstChild("HumanoidRootPart");
		if (root === undefined || !root.IsA("BasePart")) return;

		const offset = root.Position.sub(camera.CFrame.Position);
		if (offset.Magnitude <= 0.001) return;

		const want = offset.Unit;
		if (math.abs(want.Y) >= 0.99) return;

		const look = camera.CFrame.LookVector;
		const degrees = math.deg(math.acos(math.clamp(look.Dot(want), -1, 1)));
		if (degrees <= AIM_CONFIG.AIM_ASSIST_FOLLOW_DEADZONE_DEGREES) return;

		const step = math.min(degrees, this.followRate() * delta);
		if (step <= 0) return;

		const axis = look.Cross(want);
		if (axis.Magnitude <= 0.001) return;

		const turned = CFrame.fromAxisAngle(axis.Unit, math.rad(step)).VectorToWorldSpace(look);
		camera.CFrame = CFrame.lookAt(camera.CFrame.Position, camera.CFrame.Position.add(turned));
	}

	/**
	 * **The degrees per second this frame may spend, which depends on whether anybody is aiming.**
	 *
	 * **Two rates and no third behaviour between them**: a hold running means the player has pressed, so the
	 * committed figure applies; anything else means they are looking around while the assist watches, and the
	 * gentle one applies. See `AIM_CONFIG.AIM_ASSIST_FOLLOW_DEGREES_PER_SECOND` and
	 * `AIM_CONFIG.AIM_ASSIST_FOLLOW_IDLE_DEGREES_PER_SECOND`, whose docs carry the argument and the `0` case.
	 *
	 * **`chargeStartedAt` rather than a flag of the latch's own**, because "am I aiming" is already one fact with
	 * one writer (`client/throwing.ts`) and every other reader of it in the game — the arc, the charge sound, the
	 * pose, the tremble — asks the same value. A copy here would be a second thing to keep in step with it, and
	 * it would be the copy that decided how hard the camera pulled.
	 *
	 * **A frame that straddles the press is not smoothed between the two**, deliberately: the press is the
	 * instant the player wants authority over the view, so the rate is allowed to jump on it. See the config entry
	 * for why an ease is refused.
	 */
	private followRate(): number {
		const aiming = Fusion.peek(chargeStartedAt) !== undefined;

		return aiming
			? AIM_CONFIG.AIM_ASSIST_FOLLOW_DEGREES_PER_SECOND
			: AIM_CONFIG.AIM_ASSIST_FOLLOW_IDLE_DEGREES_PER_SECOND;
	}

	/**
	 * **The camera diagnostics, and what each of the four lines is for.** All of them are behind
	 * {@link CAMERA_DIAGNOSTICS}, which is off.
	 *
	 * *"The camera, when custom shift lock is on, is a little wobbly and not smooth."* That sentence had four
	 * possible causes and three different fixes, and the answer turned out to be none of the four as written:
	 * nothing in `src/client` writes `Camera.CameraType` or `Camera.CFrame` (so the camera is never taken
	 * over), the two things that write *something* — this file writing `Humanoid.CameraOffset` and
	 * `CameraZoomController` writing `Camera.FieldOfView` — write different properties on different objects
	 * and cannot fight, and there was no missing ease to add. **What there was, was a frame of ordering**:
	 * the offset is expressed in the body's frame and was written *after* the camera read it, so each value
	 * was applied against the next frame's body — which turns the body's own turning into camera motion.
	 * Every reverse of direction turned the body through 180° and swung the shoulder with it. See
	 * {@link watchOffset}, which is where that is fixed and where the whole of it is written down.
	 *
	 * **These lines stay because the fix should be verifiable rather than taken on trust.** With
	 * `CAMERA_DIAGNOSTICS` on, the same five seconds of walking back and forth should now show a `max` on the
	 * same order as its `mean`; before the reordering it did not.
	 *
	 * - **`[Camera] frame — delta N.NN° — dt N.NNms`**, once a frame while locked: how far the view rotated
	 *   in the frame, and how long the frame was. **The pair is the point** — a smooth pan has a *steady*
	 *   delta for its dt, and a wobble is the same total movement arriving unevenly.
	 * - **`[Camera] summary — N frames, mean N.NN°, max N.NN°, stddev N.NN°`**, once a second: the rollup that
	 *   decides between the two shapes a wobble can have. **`max ≫ mean` is jitter** — most frames near
	 *   still with occasional jumps — and **`max ≈ mean` with a high `stddev` is an oscillation**, which is
	 *   what a one-frame feedback path produces. Those two want different fixes, which is why neither this
	 *   file nor the report guesses at one.
	 * - **`[Camera] write — priority N — type Enum.CameraType.X`**, once on mount: this file's render
	 *   priority and the camera's actual type, so "is something else placing this camera" is answered from
	 *   the log rather than from a comment.
	 * - **`[Camera] sources — shiftLock …, zoom …`**, once on mount: which of the two camera controls in this
	 *   client touches `Camera.CFrame`. The answer is neither, and the line says what each one does touch.
	 *
	 * **What this costs while it is on, stated so it is not mistaken for the fault it is measuring**: a print
	 * per frame is sixty prints a second, which floods the output and costs frames of its own. That distortion
	 * is why the flag is off by default and why the *summary* line is the one to read — it is an aggregate
	 * over real frames, and the per-frame line is there to be spot-checked rather than read through.
	 */
	private reportCamera(delta: number): void {
		const camera = Workspace.CurrentCamera;
		if (!camera) return;

		const look = camera.CFrame.LookVector;

		// **The angle between this frame's view and the last one**, which is the camera's own rotational
		// delta and needs no input reading: whatever moved it — the mouse, the camera scripts, a constraint —
		// is in this number. `acos` of a clamped dot product is the only way to get it from two unit vectors,
		// and the clamp is not decoration: rounding can push the dot to 1.0000001 and `acos` of that is NaN.
		if (this.lastLook !== undefined) {
			const degrees = math.deg(math.acos(math.clamp(look.Dot(this.lastLook), -1, 1)));

			logInfo(
				`[Camera] frame — delta ${string.format("%.2f", degrees)}° — ` +
					`dt ${string.format("%.1f", delta * 1000)}ms`,
			);

			this.sampleFrames += 1;
			this.sampleSum += degrees;
			this.sampleSquares += degrees * degrees;
			this.sampleMax = math.max(this.sampleMax, degrees);
		}

		this.lastLook = look;
		this.sampleSeconds += delta;

		if (this.sampleSeconds >= CAMERA_DIAGNOSTIC_PERIOD) this.reportCameraSummary();
	}

	/** The once-a-second rollup {@link reportCamera} accumulates toward. See its doc for how it is read. */
	private reportCameraSummary(): void {
		const frames = this.sampleFrames;

		this.sampleSeconds = 0;
		this.sampleFrames = 0;
		this.sampleSum = 0;
		this.sampleSquares = 0;
		this.sampleMax = 0;

		// A locked player who has not moved at all produces one frame and no samples beyond it; a second with
		// nothing in it says nothing rather than printing `mean NaN`.
		if (frames === 0) return;

		const mean = this.sampleSum / frames;
		// Population stddev from the running sums, and clamped at zero because a mean and a mean of squares
		// computed in floating point can put the variance a hair below zero on a perfectly still camera.
		const variance = math.max(0, this.sampleSquares / frames - mean * mean);

		logInfo(
			`[Camera] summary — ${frames} frames, mean ${string.format("%.2f", mean)}°, ` +
				`max ${string.format("%.2f", this.sampleMax)}°, ` +
				`stddev ${string.format("%.2f", math.sqrt(variance))}°`,
		);
	}

	/**
	 * The two once-on-mount lines: what this file writes, at which priority, and what the camera's type is.
	 *
	 * **Read from the running camera rather than asserted from the source**, because the question the log has
	 * to answer is "is something else placing this camera" and the only honest answer is what the client is
	 * holding right now. A `CameraType` of `Custom` means Roblox's own scripts are placing it and this file is
	 * feeding them an offset — which is the arrangement the class doc argues for and the one that makes a
	 * `CFrame` writer elsewhere the thing to look for if the wobble is ever attributed.
	 */
	private reportCameraSources(): void {
		const camera = Workspace.CurrentCamera;

		logInfo(
			`[Camera] write — priority ${Enum.RenderPriority.Camera.Value - 2} — ` +
				`type ${camera !== undefined ? tostring(camera.CameraType) : "no camera"}`,
		);

		// **`false` for the zoom, and the qualifier is not hedging.** `CameraZoomController` writes
		// `FieldOfView` and nothing else — a different property on a different object — so it cannot fight
		// this file for the `CFrame`. **What this file writes per frame is `Humanoid.CameraOffset`**, which the
		// camera scripts then read.
		//
		// **And the file has exactly one `CFrame` write, which this line used to deny.** It is the aim assist's
		// follow, at `Camera.Value + 1` — *after* the camera scripts rather than in place of them, and only
		// while a mobile client holds a throw at a latched body. A reader chasing "something else places this
		// camera" has to know it exists, and has to know it is conditional: on a desktop, or with no latch,
		// nothing here writes a `CFrame` at all. See `watchFollow`.
		logInfo(
			`[Camera] sources — shiftLock true, zoom false — offset every frame, and a CFrame only while the ` +
				`aim assist follows`,
		);
	}
}
