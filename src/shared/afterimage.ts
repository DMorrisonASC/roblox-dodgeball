/**
 * The afterimage trail: ghost copies of a body, left at the positions it has been in, fading out behind it.
 *
 * **Roblox has no per-object blur, and that is the whole reason this is a trail rather than a property.**
 * `BlurEffect` is a `PostEffect`, parented to `Lighting`, and it blurs the entire screen at once — there is
 * no way to blur one character, and no per-model switch that makes a single body smear. **So any
 * per-character blur in this engine is faked, and the fake is this file**: copies of the body placed along
 * the path it moved, each fainter than the one before. Do not go looking for a blur property that does not
 * exist, and do not reach for `BlurEffect` to replace this — it would blur the arena, the HUD's world
 * backdrop and everybody else along with the one character that moved.
 *
 * **The other two things this deliberately is not.** The first version of this cue faded the body's own
 * parts, which was rejected because it renders the *inside* of a character: every part becomes see-through,
 * so a dodging player shows the arena through their torso and reads as a rendering fault rather than as
 * motion. A `Highlight` was the second candidate and was rejected as the wrong look — an outline says "this
 * object is special", and what a dodge needs to say is "this object moved".
 *
 * **What a ghost is.** A fresh `Model` holding anchored copies of the body's *visible* parts, parented to
 * this side's own folder — `Workspace.Afterimages` on the server, `Workspace.AfterimagesLocal` on a client,
 * see {@link ghostFolder} for why the two names differ — and never inside the character, because a ghost is
 * scenery and the character is still standing there. Nothing is welded and nothing needs to be: every part
 * is anchored where it was, so a ghost is a statue of one instant and has no joints to hold together.
 *
 * **Two emitters, one implementation, and that is the arrangement this file is now written for.** A ghost of
 * the *local player's own body* is built on that player's client; a ghost of *everybody else* is built on
 * the server. The server path is what puts your trail on other people's screens, which is the whole of what
 * the cue is for; the client path is what puts it on yours, in the right place. **The server cannot do the
 * second one, and that is a measurement rather than an opinion.** {@link spawnGhost} clones the body's parts
 * in place, so a ghost is a copy of the copy of the body that the machine building it can see — and on the
 * server that copy lags the client's authoritative one by the round trip. A body at 75 studs/s is 2–9 studs
 * further along than the server's copy of it, and the emission window closes a hop before the body actually
 * stops. The measured form of it, on a dash of the full {@link DODGE_CONFIG.DISTANCE}: the server printed
 * `dashed 5.6 of 15.0 studs` — its own travel measurement of a dash the client completed in full, because
 * that measurement and these ghosts are made from the same delayed copy. Locally a ghost is placed from the
 * same interpolated body this client is already drawing, so it cannot be anywhere else.
 *
 * **Which is `TeamRingController`'s finding, arriving here from the other side.** That ring was a server part
 * first, "placed from the server's delayed view and replicated back out, trailing the player by two trips'
 * worth of travel", and it is drawn locally for exactly that reason. The difference is that a trail has to
 * keep a server path as well: the ring has no server version because nothing but the client ever needed one,
 * and a ghost has one because every *other* client is looking at it. What the client adds is a second
 * emitter, never a second rule — the interval, lifetime, transparency, clone filter and movement gate are
 * the ones in `ACTION_CONFIG`, and there is no second set of values that could drift.
 *
 * **So do not "simplify" this back to server-only.** It reads like one path that could be moved, and it is
 * two that both have to stay: delete the local emit and the smear is back where the player cannot see it,
 * delete the server emit and the cue is gone for everyone except the body that moved. The two are joined by
 * two attributes rather than by a shared clock — `AFTERIMAGE_WINDOW_ATTRIBUTE`, which is how a client learns
 * that its own body has a window open, and `AFTERIMAGE_SOURCE_ATTRIBUTE`, which is how it recognises the
 * ghosts of its own body so it can hide them. See {@link publishWindow}, {@link markSource} and
 * `AfterimageController`.
 *
 * **What a ghost is not, and this is the filter that matters.** Only `BasePart`s are copied, and of each
 * part's own children only `Decal`s survive. A cloned `Humanoid` would be a live humanoid — a second mind on
 * a body nobody is driving — and a cloned `Script` would be a script that runs, which is the same fault
 * with teeth. `Attachment`s, `Motor6D`s, `ParticleEmitter`s, `Sound`s and `Highlight`s are dropped for the
 * cheaper reason: none of them has anything to do with what a body *looks like* from a distance, and
 * leaving them in makes every ghost heavier than the thing it is imitating. `Trail`s are dropped for a
 * third reason — a trail inside a ghost would draw its own streak through the smear.
 *
 * **Idempotent, because a catching rig re-asks for its window every tick.** See `startAfterimage`.
 */

import { Players, RunService, TweenService, Workspace } from "@rbxts/services";
import { ACTION_CONFIG } from "shared/config/action.config";
import { AFTERIMAGE_SOURCE_ATTRIBUTE, AFTERIMAGE_WINDOW_ATTRIBUTE } from "shared/constants";

/** Prints one line per trail, saying what a ghost of this body cost. Nothing else. */
const DEBUG = true;

/**
 * Which side this copy of the module is on.
 *
 * **One branch, taken at load, for the three things the sides do differently**: where the ghosts are
 * parented, whether the window is published, and whether a ghost is marked with the body it came from.
 * Everything else is the same code, which is the point — the two emitters have to agree about the spacing,
 * the fade and the gate, and the only way to know they do is to have one of each.
 *
 * **Shared rather than forked is possible because of what this file touches**: `Workspace` and a `Tween`,
 * both of which exist on both sides. Nothing here reads a service that is server-only.
 */
const IS_SERVER = RunService.IsServer();

/**
 * The folder the **server's** ghosts live in. Named, so a leftover can be found and attributed.
 *
 * Exported because the client has to be able to *find* it: the server's ghosts of the local body arrive on
 * that player's client too, and the client hides them. See `AfterimageController`.
 */
export const SERVER_FOLDER_NAME = "Afterimages";

/**
 * The folder **this client's own** ghosts live in, on the client only.
 *
 * **The names have to differ, and it is not tidiness.** {@link ghostFolder} looks its folder up *by name*, so
 * a client that shared the server's name would find the server's folder and drop this client's private
 * ghosts into the folder it is busy hiding — one folder holding both the trail the player should see and the
 * trail they must not. Separate names also keep the two paths legible in the explorer, where a ghost under
 * `AfterimagesLocal` is one that only this client has ever seen.
 */
const LOCAL_FOLDER_NAME = "AfterimagesLocal";

/** The folder this side's ghosts go in. See {@link ghostFolder} for why the name is picked here. */
const FOLDER_NAME = IS_SERVER ? SERVER_FOLDER_NAME : LOCAL_FOLDER_NAME;

/**
 * Publishes that the server has a window open on this body, or that it has closed one.
 *
 * **Server only, and that guard is load-bearing rather than an optimisation.** This attribute is the whole of
 * how a client knows when to emit: a window is opened and closed by `DodgeService` and `CatchService` on the
 * server, and neither sends the client anything about it. So a client writing here would be answering its own
 * question with its own echo — the entry the *server* had not closed would read as closed until the server
 * next changed it, and the local trail would stop early and stay stopped.
 *
 * **Only for a body a player owns**, which is the case for a character and never true for a rig. Either
 * reason is enough on its own: a rig has no client watching it, and a catching rig opens a window every tick,
 * so the attribute would be churn on the busiest thing in the place. A body no player owns carries no
 * attribute at all, which is how a client tells "not mine" from "mine, and open".
 */
function publishWindow(model: Model, open: boolean): void {
	if (!IS_SERVER) return;

	const player = Players.GetPlayerFromCharacter(model);
	if (player === undefined) return;

	model.SetAttribute(AFTERIMAGE_WINDOW_ATTRIBUTE, open);
}

/**
 * Marks a ghost with the `UserId` of the player whose body it was copied from.
 *
 * **The handle a client has on the server's copy of its own trail**, and the reason the hide pass needs no
 * name matching: the value is compared against `Players.LocalPlayer.UserId`, so two bodies that happen to
 * share a name cannot be confused for one another — which matters here, where a rig called `Behavior_Catching`
 * and a player of the same name are both possible.
 *
 * Written on the ghost's **model**, which is the level the client needs it at: it decides about a ghost whole,
 * not about one part of it. **Absent means "no player's body"**, which covers every rig and covers a player's
 * ghost during the frame or two before the attribute has replicated — both cases the client treats as not its
 * own, so a mark that has not arrived yet hides nothing rather than hiding the wrong thing.
 *
 * **Set before the ghost is parented**, which is what makes a single read enough rather than a subscription:
 * an instance and its properties reach a client together and its children only after it, so a part that has
 * just appeared in the world cannot have arrived ahead of the mark on the model above it. See
 * {@link spawnGhost}, which marks before it parents a single part. `AfterimageController` reads this and
 * never watches for it.
 */
function markSource(ghost: Model, model: Model): void {
	if (!IS_SERVER) return;

	const player = Players.GetPlayerFromCharacter(model);
	if (player === undefined) return;

	ghost.SetAttribute(AFTERIMAGE_SOURCE_ATTRIBUTE, player.UserId);
}

/**
 * What one ghost is called, for {@link FOLDER_NAME}'s reason and for the count below: a ghost is
 * anonymous scenery, so its name is the only handle anything reading the world would have on it.
 */
const GHOST_NAME = "Afterimage";

/** How a ghost's layers fade. One shape for every trail — see {@link spawnGhost} for the choice. */
const GHOST_FADE = new TweenInfo(
	ACTION_CONFIG.AFTERIMAGE_LIFETIME_SECONDS,
	Enum.EasingStyle.Linear,
	Enum.EasingDirection.Out,
);

/**
 * What one trail is, for as long as the window is open.
 *
 * One field, and it is the one thing a trail has to remember: **where the last ghost was left**. The rate
 * is the loop's own `task.wait`, so there is no clock here, and the window's end is the entry leaving
 * {@link trails} — the loop's own condition.
 */
interface Trail {
	/** Where the body was when the last ghost was spawned, in world space. See {@link emitGhost}. */
	lastGhostAt: Vector3;
}

/**
 * Every open trail, keyed on the *model*.
 *
 * An entry exists only while a body is inside a dodge or catch window. **Its presence is the idempotency
 * guard**: a catching NPC asks for a window every tick, so this is called on the same body many times a
 * second, and a second entry would be a second loop emitting on top of the first.
 */
const trails = new Map<Model, Trail>();

/**
 * How many ghosts this side has alive right now.
 *
 * Counted rather than searched for: {@link ACTION_CONFIG.AFTERIMAGE_MAX_GHOSTS} has to be checked on every
 * spawn, and walking `Workspace` to count them would be the most expensive line in the file. Incremented
 * where a ghost is parented, decremented where one is destroyed — the two ends of the same ghost's life.
 *
 * **This side's, because the counter is per Lua VM** — the server and a client each have their own, which is
 * what makes the cap per machine. See {@link spawnGhost}.
 */
let alive = 0;

/**
 * Whether the one-line ghost measurement has been printed yet.
 *
 * One line per session rather than one per ghost: what it reports is a fact about the *place* — how many
 * parts a body has once its accessories are counted — and that does not change between one dodge and the
 * next. See {@link spawnGhost}.
 */
let counted = false;

/**
 * Starts leaving ghosts behind `model`, if it is not already doing so.
 *
 * **Called on the *model*, like everything else about these two windows**, which is what makes a character
 * and a rig the same case — see `DodgeService` and `CatchService`, both of which are keyed that way for the
 * same reason.
 *
 * **Idempotent, and that is a requirement rather than a nicety.** `CatchService.attemptCatch` is called by
 * a catching NPC's behaviour on every tick — asking that often is *how* a rig keeps a window open — so this
 * arrives here dozens of times a second for one body. A second trail for the same model would be a second
 * loop spawning a second set of ghosts, and the only visible difference would be a smear twice as dense as
 * the one that was asked for.
 *
 * **Returns whether *this* call is the one that started the trail**, which is the whole of what a caller
 * that also has to arm something else needs to know. `CatchService` is that caller: its window can be
 * *extended* long after the trail stopped, and it has to restart the trail and re-arm the timer that ends
 * it, without arming a second timer the times the trail never stopped. `true` here means "there was nothing
 * emitting until now"; `false` means "already running, nothing changed", which is the ordinary answer for a
 * catching rig and for every dodge after the first.
 *
 * **The window is published from here as well as the trail being started**, which makes this the server's
 * announcement and not only its own emission: a client cannot watch for a window nobody has told it about,
 * and this is the one function that knows a window has opened — so the attribute goes out from the place the
 * trail starts, rather than from each of the call sites that knows a window opens. See `publishWindow`.
 */
export function startAfterimage(model: Model): boolean {
	if (trails.has(model)) return false;

	const trail: Trail = { lastGhostAt: model.GetPivot().Position };
	trails.set(model, trail);

	// The announcement, before the first ghost: a client that hears about the window can begin its own trail
	// against the same instant. See `publishWindow` for why this side only.
	publishWindow(model, true);

	// A thread per open window, which is one per body doing something: a handful. It ends by itself when the
	// entry goes — see `emitGhost` — so nothing has to be cancelled or kept.
	task.spawn(() => emitGhost(model, trail));

	return true;
}

/**
 * Stops leaving ghosts behind `model`. Whatever is already in the world finishes fading on its own.
 *
 * **Called on every way the window can close**, which is what makes the trail follow the window rather than
 * the cooldown: `DodgeService.endDash` is the single exit from a dash, and `CatchService.consume` is the
 * single exit from a catch window.
 *
 * Safe on a body that never had a trail, for the reason `CatchService.consume` gives about its own map: most
 * calls are the catch asking after a body that is not catching.
 *
 * **Closing the window is announced from here**, the pair of `startAfterimage`'s announcement, so the two
 * cannot get out of step: a client hears about exactly the windows this side opened and closed. See
 * `publishWindow`.
 */
export function stopAfterimage(model: Model): void {
	const wasOpen = trails.delete(model);

	// **Only a window that was open can close.** The ordinary call here is the catch asking about a body that
	// is not catching, and publishing `false` for a window that never opened would be a write per tick per
	// body for no reader.
	//
	// **The attribute deliberately flaps with the trail rather than with the window**, because that is what
	// the trail itself does: `CatchService.armAfterimageTimer` stops the emission when its timer expires and
	// `attemptCatch` asks again on the next tick, so a window held open across many timers is a trail that
	// stops and restarts. Publishing each end of that leaves a client's own trail doing what the server's is
	// doing, which is the requirement — a client that kept emitting through the gap would be the one place
	// the two disagreed.
	if (wasOpen) publishWindow(model, false);
}

/**
 * One trail's loop: a ghost at the instant the window opens, then one every
 * {@link ACTION_CONFIG.AFTERIMAGE_INTERVAL_SECONDS} until the window closes.
 *
 * **The loop's condition is the trail entry itself**, which is what makes `stopAfterimage` enough to end it:
 * the entry is deleted, the next turn of the loop finds a different entry (or none) and returns. There is no
 * flag to set, no thread to cancel, and no way for two windows to leave a loop behind. **That covers being
 * stopped before the first wait has even finished**: `stopAfterimage` between the first ghost and the first
 * wake leaves the thread sleeping on a trail that is gone, and its next turn of the loop is its last, with
 * nothing emitted in between.
 *
 * **The first ghost comes before the first wait, and that is a reversal.** The version before this waited
 * first, on the argument that a ghost laid down at the instant the window opened would be a copy sitting on
 * top of the body that is still there — true, and beside the point: *that position is the one the eye
 * expects to see*. A dash that then travels its 15 studs leaves a trail whose earliest copy is a whole
 * interval of travel along, which reads as a smear that starts late. The opening position costs one ghost
 * that is hidden inside the body for the first few milliseconds and anchors the smear after that.
 *
 * **The first ghost deliberately does not go through the movement gate.** There is nothing to measure it
 * against — no ghost has been left yet — and its position *is* the seed {@link Trail.lastGhostAt} was taken
 * from, so the gate as written would compare that position with itself, find no movement at all, and refuse
 * to emit anything. The gate's question is "is this ghost worth having *on top of the last one*", and that
 * is not a question that can be asked about the first. See {@link leaveGhost}.
 *
 * **The destroyed-model guard is the other half of the loop.** A body can leave the world mid-window —
 * dying is the ordinary way — and both services stop the trail on death, but neither is asked if the
 * character is destroyed without its humanoid dying. A loop that kept running would emit ghosts of a model
 * that no longer exists, forever, at a position that can no longer change: `model.Parent` is the check, the
 * same one `SpawnShield` makes before it touches a body that may be long gone.
 */
function emitGhost(model: Model, trail: Trail): void {
	// The opening position, once, before the loop can be told to stop: a window that opens and closes inside
	// one interval is still a body that acted, and it gets the ghost of where it acted from. This runs
	// without yielding — the thread reaches its first `task.wait` straight afterwards — so the ghost is laid
	// down in the frame the window opened rather than a frame later, at the position the body had when it
	// opened. See `startAfterimage`.
	spawnGhost(model);

	while (trails.get(model) === trail) {
		task.wait(ACTION_CONFIG.AFTERIMAGE_INTERVAL_SECONDS);

		if (model.Parent === undefined) break;

		leaveGhost(model, trail);
	}

	// The entry goes with the loop, and only if this loop still owns it: a later window may have replaced
	// it, in which case its own loop is running and this one must not delete it out from under that.
	if (trails.get(model) === trail) trails.delete(model);
}

/**
 * Leaves one ghost at the body's current position, if it has moved far enough to be worth one.
 *
 * **The movement gate, and the case it exists for is a rig that catches continuously.** A catch window is
 * held open by a rig re-asking for it every tick, which means an NPC's window can be open for as long as it
 * survives — minutes, not a second. On a rate alone, a *standing* catcher would spawn a stack of identical
 * ghosts on one spot for as long as it stood there: a solid pillar of copies, growing forever, which is both
 * the ugliest possible reading of a motion cue and the most expensive one. A ghost at the position the last
 * ghost was already at adds nothing to a smear — it is a copy of a copy — so the gate is also what keeps the
 * trail's density *even* instead of proportional to how patient a body is.
 *
 * The threshold's real effect, stated exactly rather than flatteringly: a body walking at the base speed of
 * 20 studs/s covers about a stud between two ghosts, so nothing at full pace ever trips this. A body moving
 * at **less than half that** covers less than the threshold in one interval and leaves its ghosts every
 * *other* interval instead of every one — the same trail, spaced the same way, with half as many copies in
 * it. That is the wanted direction: spacing is what makes a smear, and the gate removes copies only where
 * they would be indistinguishable from the one before them.
 */
function leaveGhost(model: Model, trail: Trail): void {
	const position = model.GetPivot().Position;

	if (position.sub(trail.lastGhostAt).Magnitude < ACTION_CONFIG.AFTERIMAGE_MIN_MOVEMENT_STUDS) return;

	trail.lastGhostAt = position;

	spawnGhost(model);
}

/**
 * Builds one ghost of `model` and starts it fading.
 *
 * **The cap is a skip, not an eviction.** Over budget, the ghost is simply not made: the trail thins out,
 * which is a quieter failure than destroying a ghost mid-fade, which would be a copy vanishing out of the
 * middle of a smear while the ones around it kept going. The cap is world-wide rather than per body on
 * purpose — the thing being protected is the world, not one trail — and the share one body can take is
 * already bounded by the interval and the lifetime behind it.
 *
 * **The cap is per *side*, and that is a consequence rather than a decision.** {@link alive} is a module-level
 * counter, and the server and the client are two Lua VMs that share nothing but this source file — so the two
 * counters are two counters, and neither can be shown the other without a remote raising a message about a
 * cosmetic budget. It is also the right answer: what the cap protects is a *renderer*, and the ghosts a client
 * builds are its own. `ACTION_CONFIG.AFTERIMAGE_MAX_GHOSTS` is therefore best read as "per machine", which is
 * what it always was — the client path did not change the server's number.
 *
 * **Parented last, with every property already set**, which is `SoundEmitter.emitSound`'s rule and is here
 * for its reason: a copy that arrives solid, colliding and queryable is one the physics solver and every
 * raycast can already see, and this is a piece of scenery that must never be touched by anything.
 */
function spawnGhost(model: Model): void {
	if (alive >= ACTION_CONFIG.AFTERIMAGE_MAX_GHOSTS) return;

	const ghost = new Instance("Model");
	ghost.Name = GHOST_NAME;

	// Marked before a single part is parented into it, and that order is the point: the attribute is what a
	// client reads to decide whether to hide a ghost, so a ghost that reached the world unmarked would be a
	// frame of somebody's trail standing in the local player's own path. See `markSource`.
	markSource(ghost, model);

	/** Every layer that has something to fade — the parts, and the faces on them. */
	const layers: Array<BasePart | Decal> = [];

	for (const descendant of model.GetDescendants()) {
		if (!descendant.IsA("BasePart")) continue;

		// **Skipped rather than copied: a part nobody can see is not part of what a body looks like.**
		// Every character and every rig carries a `HumanoidRootPart` at `Transparency = 1` inside the torso,
		// and a ghost holding one would be a ghost with an invisible part in it — invisible, but still a part
		// in the tree, still in the count, and still tweened. This is the same part that made the fade
		// interesting, arriving from the other side.
		if (descendant.Transparency >= 1) continue;

		// **The `Archivable` guard, and it is not defensive padding — it is the documented behaviour.**
		// `Instance:Clone()` "returns a copy of the instance, or `nil` if the instance is not `Archivable`",
		// and it copies "all its descendants, **ignoring instances that are not `Archivable`**". The typing
		// says `Clone<T extends Instance>(this: T): T`, which is a promise the documentation above it does not
		// make: the nil case does not exist as far as TypeScript is concerned, so a non-`Archivable` part
		// would not be a compile error — it would be `attempt to index nil` at runtime, in the middle of a
		// dodge, on somebody else's accessory. So the guard is written against a widened type and the ghost
		// loses one part rather than the whole feature dying.
		const copy = descendant.Clone() as BasePart | undefined;
		if (copy === undefined) continue;

		stripToLooks(copy);

		copy.Anchored = true;
		copy.CanCollide = false;
		copy.CanQuery = false;
		copy.CanTouch = false;
		// Anchored is belt; this is braces. A ghost has no business appearing in a shadow map either — a
		// stack of identical silhouettes would darken the ground under the smear, which reads as dirt on the
		// arena rather than as something that moved over it.
		copy.CastShadow = false;

		// **A floor, not an assignment, for the reason the body-wide fade had one**: a layer is made faint
		// only if it was *less* faint than this already, so a ghost is never more solid than the thing it is
		// imitating. See `ACTION_CONFIG.AFTERIMAGE_START_TRANSPARENCY`.
		const faint = math.max(copy.Transparency, ACTION_CONFIG.AFTERIMAGE_START_TRANSPARENCY);

		copy.Transparency = faint;
		layers.push(copy);

		// The faces, faded with the parts under them: `BasePart.Transparency` does not touch a `Decal`, so a
		// ghost that faded its parts alone would be a body with an opaque face floating on it. `Texture`
		// extends `Decal`, so this covers both.
		for (const child of copy.GetChildren()) {
			if (!child.IsA("Decal")) continue;

			child.Transparency = math.max(child.Transparency, faint);
			layers.push(child);
		}

		copy.Parent = ghost;
	}

	// A body with nothing visible on it — every part `Transparency = 1`, which is a rig mid-despawn rather
	// than a body anybody can see — leaves an empty model, and an empty model in `Workspace` is a thing
	// nothing will ever collect.
	if (ghost.GetChildren().size() === 0) {
		ghost.Destroy();
		return;
	}

	if (DEBUG) {
		// Once per ghost at 40 Hz would be a wall of output, so this is the *first* ghost of a trail and no
		// more: what it is for is the one number nothing else in this file can know — how many parts a body in
		// *this* place actually has, accessories and all.
		if (!counted) {
			counted = true;
			print(
				`[Afterimage] a ghost is ${ghost.GetChildren().size()} part(s), up to ` +
					`${ACTION_CONFIG.AFTERIMAGE_MAX_GHOSTS} alive in the world`,
			);
		}
	}

	ghost.Parent = ghostFolder();
	alive++;

	for (const layer of layers) {
		// A tween per layer, which is the price of a real fade — see the module doc for why not a fixed
		// transparency with a lifetime. The tween is not kept: it plays to completion and is collected, and
		// nothing here needs to stop one early.
		TweenService.Create(layer, GHOST_FADE, { Transparency: 1 }).Play();
	}

	task.delay(ACTION_CONFIG.AFTERIMAGE_LIFETIME_SECONDS, () => {
		alive--;

		// **The destroy guard, which is `SpawnShield`'s line for `SpawnShield`'s reason:** "destroying
		// something already destroyed is a second fault to explain rather than a state worth reporting".
		// The check is also what makes the timer safe to fire at a ghost that has already gone — and there is
		// exactly one thing that can take a ghost away early today: a developer deleting the folder by hand
		// while the trail runs.
		if (ghost.Parent === undefined) return;

		ghost.Destroy();
	});
}

/**
 * Removes everything from a cloned part that is not part of how it looks.
 *
 * **The filter, and it is a filter rather than a list of exclusions on purpose.** A cloned part brings its
 * whole subtree with it — `Motor6D`s on a rig, `Attachment`s, `ParticleEmitter`s, `Sound`s, a `Highlight`, a
 * `Trail`, a `Tool` in a hand — and asking "is this one of the things I do not want" is a list that has to be
 * kept in step with every future thing a character can carry. Asking "is this what a body looks like" has
 * one answer for ever: a `Decal` is, and nothing else on a part is.
 *
 * **Collected first and destroyed afterwards**, because `GetDescendants` walks a live tree: destroying as it
 * is walked is how half of a subtree gets skipped, silently, on the one ghost in ten that happened to have
 * two children in a row.
 */
function stripToLooks(copy: BasePart): void {
	const strip: Array<Instance> = [];

	for (const child of copy.GetDescendants()) {
		if (child.IsA("Decal")) continue;

		strip.push(child);
	}

	for (const child of strip) child.Destroy();
}

/**
 * The folder the ghosts live in, made on first use.
 *
 * **A folder rather than loose children of `Workspace`**, which is the difference between this and
 * `SoundEmitter`: an emitter is one part whose name is its handle, and a ghost is twenty parts that belong
 * to each other. Keeping them together means the several things in this project that walk `Workspace`'s
 * *direct children* — `ThrowProbe.otherBalls`, `ThrowController`'s own walk — never see a ghost at all,
 * rather than seeing one and declining it by name.
 *
 * **Found first, then made**, which is `BallService.findOrCreateFolder`'s shape and for its reason: a folder
 * of this name may already be in the place file, put there by somebody who wanted the ghosts somewhere
 * particular, and creating a second one would leave the first empty and the second unexplained.
 *
 * **Nothing sweeps it.** Checked rather than assumed: there is no `Workspace.GetDescendants()` anywhere in
 * this project, every world-wide pass is filtered by a **tag** (`taggedPartsInWorkspace`) or by a **name**,
 * and a ghost carries neither — and the ghosts are anchored, so the engine's own fall-destroy at
 * `Workspace.FallenPartsDestroyHeight` can never reach them. What empties the folder is the ghosts
 * destroying themselves; the folder stays, empty, which is the cheapest possible state for something that
 * will be used again the next time somebody dodges.
 *
 * **On a client this folder is a local instance, which is a property worth naming rather than assuming.** An
 * instance a client creates and parents under `Workspace` is not replicated to the server or to anybody else,
 * so `AfterimagesLocal` is this client's own scenery in the strongest sense: the server cannot see it, no
 * other player can see it, and it cannot be confused with the server's copy of the same idea. What it costs
 * is one `Folder` remade on every join — the same thing the server does, once.
 *
 * **The name is decided by the side, not passed in**, because the two names must differ and neither may ever
 * be the other's: a client looking up `Afterimages` would find the server's folder and parent its private
 * ghosts into the folder it is hiding. See `LOCAL_FOLDER_NAME` for that argument in full. This function is the
 * one place that can get it wrong, and it cannot get it wrong silently — `FOLDER_NAME` is resolved when the
 * module loads.
 */
function ghostFolder(): Folder {
	const existing = Workspace.FindFirstChild(FOLDER_NAME);
	if (existing?.IsA("Folder")) return existing;

	const folder = new Instance("Folder");
	folder.Name = FOLDER_NAME;
	folder.Parent = Workspace;

	return folder;
}
