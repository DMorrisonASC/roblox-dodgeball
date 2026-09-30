import { Controller, OnStart } from "@flamework/core";
import Fusion from "@rbxts/fusion-3.0";
import { CollectionService, Players, ReplicatedStorage, UserInputService, Workspace } from "@rbxts/services";
import { DEBUG_CONFIG } from "shared/config/debug.config";
import { SHIFT_LOCK_CONFIG } from "shared/config/shiftLock.config";
import { ROUND_STATE_ATTRIBUTE, ROUND_STATUS_FOLDER, SHIFT_LOCK_ZONE_TAG } from "shared/constants";

/** What `ROUND_STATE_ATTRIBUTE` says while a round is being played. */
const PLAYING = "Playing";

/** What it says between rounds — the only phase the lobby zone is allowed to decide anything in. */
const INTERMISSION = "Intermission";

/** Prints the lock's transitions. See `shared/config/debug.config.ts` — they are behind the gate too. */
const DEBUG = true;

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

	warn(
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
 * **Two things ask for it, and either one is enough: the round, and a zone.** While a round is being
 * played the lock is on for everyone and no player can switch it off — the throw is aimed from the
 * centre of the screen, so the camera *is* the aim, and a crosshair that followed the body instead of
 * the view would be pointing somewhere the player is not looking. Outside a round it is off, and the
 * player is free to run around and look at the lobby — **except inside a zone somebody places**
 * ({@link SHIFT_LOCK_ZONE_TAG}), where it comes back so a practice throw lines up the way a real one
 * will.
 *
 * **The two are combined rather than ordered, and the zone is checked in every phase.** The lock is on
 * while *either* input is asking for it, which is what makes the zone safe to leave armed all the time:
 * during a round it changes nothing (the round is already asking), and it can never *release* a lock the
 * round is holding — a player who walked out of a lobby zone mid-round is still locked, which is the
 * rule the round exists to have. Gating the zone on the phase instead was tried first and is worse in
 * two ways: a player standing in a zone when a round ended lost the camera for the tenth of a second the
 * tick took to put it back, and the tick needed a second copy of the phase's rule kept in step with the
 * first. See {@link refresh}, which is where the two are combined.
 *
 * **The engine's two user settings rather than the camera's `CFrame`.** `RotationType` is what makes the
 * character face where the camera looks instead of where it walks, and `MouseBehavior` is what holds the
 * mouse at the centre of the screen — and the second is what makes the aim *work*, because
 * `ThrowController` casts its ray from the mouse position: hold the mouse at the centre and the shot
 * follows the view. Writing the camera's own `CFrame` would be a fight with Roblox's camera scripts for
 * the same property; these two settings are the supported seam, they are what the built-in lock writes,
 * and they are why this does not fork the `PlayerModule` — which is the other way to build this, and a
 * permanent copy of Roblox's camera code to keep in step with.
 *
 * **And the cursor, which is the fourth thing the lock controls.** While it is on, the mouse is a
 * crosshair — which is the point of the whole feature stated as a picture, since the throw goes where
 * the centre of the screen is looking and the cursor stops being a pointer and becomes a sight. It is
 * the *whole* of the cursor: nothing here tints it, scales it or fades it, and **a mouse icon has no
 * transparency property to set**, so the PNG's alpha is the cursor's alpha. A crosshair whose middle is
 * faint is a crosshair whose middle is faint in the artwork — see
 * {@link SHIFT_LOCK_CONFIG.LOCKED_CURSOR}, which is where the file lives.
 *
 * **Unlike `RotationType`, the cursor does not outlive the client.** `UserInputService` is the session's
 * input state rather than the user's saved settings, so a session that ends mid-lock leaves nothing
 * behind for the next one. That is why the mount-time reset for it is a *capture* of what the client
 * arrived wearing rather than a forced default: there is nothing to undo, and the capture is what lets a
 * release hand back a cursor somebody else set instead of inventing one.
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
 * to hear every respawn. The release that actually happens in play is the phase's — playing to
 * intermission, and every way a round can end — and a client that is going away has nothing to release,
 * because the settings it wrote are the user's and there is no later.
 *
 * **What this is not:** it is not movement, and it is not aim. Nothing here binds a key, and the whole
 * of the effect is that the character turns with the view and that the body is not in the way of it.
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
	 * would leave the crosshair sitting in the property and bring it straight back the moment anything
	 * enabled the icon again — this file included, on the next lock. Captured once at {@link mount} and
	 * put back together on every release, which is also what makes the release honest: a client that
	 * arrived wearing somebody else's cursor gets *that* back rather than a default invented here.
	 */
	private restingCursor?: string;
	private restingCursorEnabled?: boolean;

	/** What the round says: a round is being played, so the camera is held for everybody. */
	private phaseLocked = false;

	/** What the zone says: the local player's body is inside a tagged box right now. */
	private inZone = false;

	/**
	 * The local player's body, held so the camera offset can be put on the next one.
	 *
	 * **Held because the offset is the one part of this that is per-character** — see the class doc. A
	 * reference to a body that has since been destroyed is harmless: writing an offset to it does
	 * nothing, and the next `CharacterAdded` replaces it.
	 */
	private humanoid?: Humanoid;

	public onStart(): void {
		// **The first line is printed here, before anything else below it can fail, and that is not
		// decoration.** "Nothing happens" has two causes that look identical from the outside — the module
		// never reached the client, or it ran and died before it printed anything — and this line is what
		// tells them apart. Missing, and nothing below it ran: the question is then whether the file is in
		// `StarterPlayerScripts` at all. Present, and the next line is missing: the question is which call
		// in {@link mount} failed. The HUD controllers print that they are up for the same reason; this
		// one is one step earlier, because what can go wrong here is at the very top.
		if (DEBUG) print(`[ShiftLock] onStart — mounting`);

		// Spawned rather than done inline: the round folder is made by the *server's*
		// `RoundService.onStart`, so waiting for it can yield — and a controller's `onStart` is the wrong
		// place to hold up the rest of the client's boot for something that is not there yet. The same
		// reason, and the same shape, as the HUD controllers' mounts.
		task.spawn(() => this.mount());
	}

	/** Wires the two drivers up, once the round folder exists. */
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
		scope.push(
			status.GetAttributeChangedSignal(ROUND_STATE_ATTRIBUTE).Connect(() => this.applyPhase(phaseOf(status))),
		);

		// The seed, and it is the case that matters for a client joining a round already in progress: the
		// folder is there with `Playing` on it and there may be no change left to hear.
		this.applyPhase(phaseOf(status));

		scope.push(this.player.CharacterAdded.Connect((character) => this.watchCharacter(character)));

		const character = this.player.Character;
		if (character) this.watchCharacter(character);

		task.spawn(() => this.watchZones());

		// **The count is the answer to "is the tag there at all", and it is printed rather than worked out
		// later.** Tags replicate, so a part tagged in the place file is visible from here — which makes a
		// zero, or a tagged thing that is not a part, the difference between "the box is in the wrong place"
		// and "nothing is tagged". `NpcService` prints the same kind of line at startup for the same reason,
		// and it is the first thing to grep for when a tag-driven feature does nothing.
		const tagged = CollectionService.GetTagged(SHIFT_LOCK_ZONE_TAG);
		const parts = tagged.filter((zone) => zone.IsA("BasePart"));

		if (DEBUG) {
			print(`[ShiftLock] up — ${parts.size()} ${SHIFT_LOCK_ZONE_TAG} part(s), watching during ${INTERMISSION}`);
		}

		// The trap this names is the one worth naming: a tag put on the *model* that wraps the box rather
		// than on the box, which reads as "the zone is tagged" everywhere except here.
		if (parts.size() < tagged.size()) {
			warn(
				`[ShiftLock] ${SHIFT_LOCK_ZONE_TAG} is on ${tagged.size() - parts.size()} thing(s) that are not` +
					` parts — the tag belongs on the part itself, not on a model around it`,
			);
		}
	}

	/**
	 * Reports what the phase says, and lets {@link refresh} work out what that means.
	 *
	 * **The phase is one input now rather than the rule.** It used to release the lock outright on
	 * entering the intermission and hand the camera to the zone check; now it only reports whether a
	 * round is being played, and the lock is held while either input asks for it. The visible difference
	 * is one case, and it is a fix: a player standing in a zone when a round ends keeps the camera,
	 * instead of losing it for the tenth of a second the zone tick takes to put it back.
	 */
	private applyPhase(phase: string | undefined): void {
		this.phaseLocked = phase === PLAYING;

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

		const params = new OverlapParams();
		// **`Include` with one instance in it, so the only thing that can answer is this player's own
		// body.** `Exclude` would be a standing invitation to be wrong: the lobby has loose balls, rigs
		// and other players in it, and any of them standing in the box would lock *this* player's camera
		// for them. The character model rather than its root part, so a player leaning over the edge with
		// one arm inside the zone is inside it.
		params.FilterType = Enum.RaycastFilterType.Include;
		params.FilterDescendantsInstances = [character];

		const wasInside = this.inZone;
		this.inZone = false;

		// The part *is* the box — its own `CFrame` and `Size`, in whatever place and rotation the builder
		// put it. Nothing is queried for the zone itself, which is why its `CanQuery = false` (see
		// `SHIFT_LOCK_ZONE_TAG`) has no bearing on this check.
		for (const zone of CollectionService.GetTagged(SHIFT_LOCK_ZONE_TAG)) {
			if (!zone.IsA("BasePart")) continue;

			// **Only a zone that is in the world is a zone.** `GetTagged` returns tagged instances wherever
			// they live and a `Clone` copies its tags — the fact `BallSpawnerService` had to guard against
			// when the arena is loaded a round early. A part's `CFrame` is world-space regardless of its
			// parent, so without this line a zone inside an unplaced arena would still be evaluated, at
			// those coordinates, from inside the lobby. A box that is not in the world is not somewhere a
			// player can walk into.
			if (!zone.IsDescendantOf(Workspace)) continue;

			if (Workspace.GetPartBoundsInBox(zone.CFrame, zone.Size, params).size() > 0) {
				this.inZone = true;
				break;
			}
		}

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
	 * Works out whether the camera should be held, from the two things that can ask for it.
	 *
	 * **Either input is enough, and the round is the stronger one on purpose.** A round being played holds
	 * the camera for everybody and keeps holding it whatever the player does with their feet; a zone asks
	 * for the same lock outside a round. Combining them is what makes the zone safe to check at all times:
	 * neither input can switch the other off, so a zone can *add* the lock but can never remove one the
	 * round is holding. Two inputs and one derived state is also the whole reason this method exists — the
	 * callers each report what they can see, and the rule lives in one place rather than in both of them.
	 *
	 * **The reason printed is the input that is holding it**, so the log reads the way the rule does:
	 * `locked — the round`, `locked — the zone`, `unlocked — nothing is asking for it`. `locked — the zone`
	 * during a round is therefore impossible, and an unlock line is proof that neither input was asking.
	 */
	private refresh(): void {
		const reason = this.phaseLocked ? "the round" : this.inZone ? "the zone" : "nothing is asking for it";

		if (this.phaseLocked || this.inZone) {
			this.lock(reason);
		} else {
			this.unlock(reason);
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
		if (DEBUG && DEBUG_CONFIG.VERBOSE_LOGS) {
			print(`[ShiftLock] ${on ? "locked" : "unlocked"} — ${reason}`);
		}

		this.writeSettings(on);
		this.applyOffset();
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
	 * the cursor saying so — and a client that can do two of them should do the two and report which one
	 * is missing.
	 *
	 * See the class doc for why the camera's `CFrame` is not the seam to use instead, and
	 * {@link SHIFT_LOCK_CONFIG.LOCKED_CURSOR} for why there is no transparency to set on the cursor.
	 */
	private writeSettings(on: boolean): void {
		const settings = cameraSettings();

		if (settings) {
			const [ok, problem] = pcall(() => {
				settings.RotationType = on ? Enum.RotationType.CameraRelative : Enum.RotationType.MovementRelative;
			});

			if (!ok) warn(`[ShiftLock] RotationType refused: ${tostring(problem)}`);
		}

		const [mouseOk, mouseProblem] = pcall(() => {
			UserInputService.MouseBehavior = on ? Enum.MouseBehavior.LockCenter : Enum.MouseBehavior.Default;
		});

		if (!mouseOk) warn(`[ShiftLock] MouseBehavior refused: ${tostring(mouseProblem)}`);

		// **The cursor, which is the one of the three that fails visibly.** The icon is *set* rather than
		// assumed on the way in: it is the part of this something outside the game could have turned off,
		// and a crosshair that never appears because a flag was already false would look exactly like a
		// broken asset id. On the way out both halves go back together — the image is cleared as well as
		// the flag, so that anything which enables the icon later, this file on its next lock included,
		// gets the engine's cursor rather than a crosshair left behind in the property.
		const [cursorOk, cursorProblem] = pcall(() => {
			if (on) {
				UserInputService.MouseIcon = SHIFT_LOCK_CONFIG.LOCKED_CURSOR;
				UserInputService.MouseIconEnabled = true;
			} else {
				UserInputService.MouseIcon = this.restingCursor ?? "";
				UserInputService.MouseIconEnabled = this.restingCursorEnabled ?? false;
			}
		});

		if (!cursorOk) warn(`[ShiftLock] the cursor refused to change: ${tostring(cursorProblem)}`);
	}

	/**
	 * Puts the camera offset on the body, or takes it off, according to the current state.
	 *
	 * Safe to call with no body — a player who has not spawned yet has nothing to offset, and their
	 * state is deliberately kept across the gap. See {@link watchCharacter}.
	 */
	private applyOffset(): void {
		const humanoid = this.humanoid;
		if (!humanoid) return;

		humanoid.CameraOffset = this.isLocked() ? SHIFT_LOCK_CONFIG.CAMERA_OFFSET : Vector3.zero;
	}
}
