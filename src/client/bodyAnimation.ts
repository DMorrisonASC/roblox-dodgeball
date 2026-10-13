import { AnimationState, CYCLE_STATES, STATE_CLIP_SECONDS } from "shared/config/animation.config";
import { BodyAction, bodyClipFor, clipIdFor } from "shared/animation";
import {
	CATCH_ANIMATION_ATTRIBUTE,
	DODGE_DIRECTION_ATTRIBUTE,
	DUCKING_ATTRIBUTE,
	THROW_ANIMATION_ATTRIBUTE,
} from "shared/constants";
import { DodgeDirection } from "shared/dodge";

/** Prints every clip a body changes into, with the rung it plays on. Silent while the clip stays the same. */
const DEBUG = true;

/**
 * How long the change from one **cycle** to the next takes, in seconds.
 *
 * **Crossfaded rather than switched**, because the clips were authored separately from one another — walk
 * and sprint in particular — so a hard cut between them reads as a pop rather than as a change of pace.
 *
 * **This is the fade for a cycle, and {@link fadeFor} is the whole of who uses it.** An action does not
 * crossfade: see that function, where the arithmetic that makes a 0.2 s fade into a 0.2 s dash is written
 * out.
 */
const FADE_SECONDS = 0.2;

/**
 * The four words a dodge direction is published as, spelled once so an attribute value can be checked against
 * them without a cast.
 *
 * **A loop rather than an index into a mapping with `as`**, which would be the one-liner and would accept
 * anything: the point of validating a value off an attribute is that the four words are a closed set, and a
 * cast is a promise that whatever arrived is one of them.
 */
const DIRECTIONS: ReadonlyArray<DodgeDirection> = ["forward", "backward", "left", "right"];

/**
 * One body being rendered: what it is playing, the tracks it can play, and who is drawing it.
 *
 * **A table of functions' state, not a class**, which is the shape every other client-shared module in this
 * project uses (`aiming.ts`, `roundZone.ts`, `sprinting.ts`). It is also the shape this needs to be: a class
 * here would be registered as a *singleton* by the Flamework macro — every exported class is, for the
 * modding API's benefit — and a renderer that exists once per body on screen is the last thing that should
 * look like a machine-wide singleton.
 */
export interface BodyRender {
	readonly body: Model;
	readonly humanoid: Humanoid;
	readonly animator: Animator;

	/** The prefix its lines are printed with — `Rig` or `Animate`, the only thing that differs between callers. */
	readonly logTag: string;

	/** One track per state this body has played, loaded on first use and reused after that. */
	readonly tracks: Map<AnimationState, AnimationTrack>;

	/** The clip playing right now, so a state change that names the same clip writes nothing. */
	playing?: AnimationState;
}

/**
 * The facts a caller measures, because a body cannot read them for itself.
 *
 * **Four of `BodyState`'s six, and the split is the point of the type.** A body cannot measure its own
 * ground speed, tell whether it is held, or say whether the game has a clip for what it is doing — for a rig,
 * the machine that *is* the body (the server) measures and publishes those facts; for a player's own body, the
 * client that owns it measures them directly. Both then hand the same four facts to {@link applyBodyRender},
 * which adds the two any body can always answer for itself, because those are the events it carries as
 * attributes.
 */
export interface BodyConditions {
	/** Ground speed in studs per second. */
	readonly speed: number;

	/** Whether the body is standing on something. */
	readonly grounded: boolean;

	/** Whether the body is held. A player passes `false` — see `LocomotionAnimationController`. */
	readonly frozen: boolean;

	/**
	 * **Whether the game has a clip for what this body is doing** — the same fact as `BodyState.deferToDefault`,
	 * one layer down, and the renderer passes it straight through.
	 *
	 * A caller that cannot answer says `false`, which is "keep playing our clips": the safe direction, because
	 * the alternative on a body with no `Animate` script to fall back to — a rig — is a body that plays nothing
	 * at all and stands in its bind pose.
	 */
	readonly deferToDefault: boolean;
}

/**
 * Starts rendering `body` — **the renderer both kinds of body share.**
 *
 * **This file is what makes "one mechanism" true rather than aspirational.** It is used twice: by
 * `RigAnimationController`, which dresses every rig it can see from the state the server publishes, and by
 * `LocomotionAnimationController`, which dresses the body this client owns from facts it measures itself. Two
 * callers, one renderer, one table (`animation.config.ts`), one decision (`bodyClipFor`) — so a state added
 * there plays on both bodies, which is the property every animation change before this one had to buy twice.
 *
 * **Server owns the fact, every client renders it — and a player's own body is no exception.** For a rig that
 * is forced: the rig's `Animator` belongs to the server, so a track started there would replicate every rig's
 * every frame to every client. For a player it is a choice, and it is the same choice: the facts arrive as
 * attributes on the body (`THROW_ANIMATION_ATTRIBUTE`, `CATCH_ANIMATION_ATTRIBUTE`, `DODGE_DIRECTION_ATTRIBUTE`
 * — all written for a player's character exactly as for a rig), and the client that owns the body plays the
 * clip. **A player's animation used to be played from the server** (`BallService.playActionAnimation`,
 * `DodgeService.playDodgeAnimation`) and is not any more: two ways of playing one clip is exactly the split
 * this file exists to end, and a client-started track on a player's own character replicates the same way the
 * default `Animate` script's does.
 *
 * **Nothing here decides *which* clip**: that is `bodyClipFor`, a pure function in `shared/animation.ts`, so
 * both callers and both bodies agree by construction. Nothing here decides which *set* the engine's own script
 * may play either — see `LocomotionAnimationController`, whose claiming of the four sets is the other half of
 * the override, and is a player's problem because only a player has that script.
 *
 * **Nothing here finds the body.** A caller hands it a body, its humanoid and its animator, and calls
 * {@link applyBodyRender} whenever the state it knows has moved. That is deliberate: finding a rig (a tag
 * walk) and knowing when a player's own body is ready (a character spawn) are different problems, and the two
 * callers solve them differently. What is shared is everything after that.
 */
export function startBodyRender(
	body: Model,
	humanoid: Humanoid,
	animator: Animator,
	logTag: string,
): BodyRender {
	return { body, humanoid, animator, logTag, tracks: new Map() };
}

/**
 * Plays whatever clip the body's conditions and its own events come to — **the whole of the interface.**
 *
 * Called on a change rather than on a clock: a rig's caller is driven by the body's attributes, a player's by
 * the tick that measures its speed. A call that arrives at the same clip as the last one is a comparison and
 * nothing else, which is what makes it safe to call as often as a caller likes.
 *
 * **And it is also the place the game lets go.** A caller that has decided the game has no clip for what the
 * body is doing passes `deferToDefault`, `bodyClipFor` answers nothing, and the two lines below stop what is
 * playing and start nothing in its place — the release, in the same shape as a state whose id is blank.
 */
export function applyBodyRender(render: BodyRender, conditions: BodyConditions): void {
	const clip = bodyClipFor({
		speed: conditions.speed,
		grounded: conditions.grounded,
		frozen: conditions.frozen,
		deferToDefault: conditions.deferToDefault,
		dodge: publishedDodge(render.body),
		action: publishedAction(render.body),
	});

	if (clip === render.playing) return;

	if (render.playing !== undefined) render.tracks.get(render.playing)?.Stop(fadeFor(render.playing));

	// **Recorded before the track is looked for, on purpose.** A clip this body has no id for — a config row
	// left empty, which is how a state opts out — is not a clip that can be loaded, and remembering the attempt
	// is what stops every change from trying again for a clip that will never exist.
	render.playing = clip;

	// **And `undefined` is the release: the stop above has already happened and no track is started here, which
	// is the whole of "play nothing".** The body is left to whoever else is animating it — for a player that is
	// Roblox's own `Animate` script, whose `sit`, `climb` and `swim` sets this game never claimed and whose four
	// claimed sets are the only tracks `LocomotionAnimationController.suppressScript` stops. The record is
	// `undefined` rather than the clip that was playing, so the next *owned* state is a change again and the
	// body resumes rather than sitting in a stale track. See `BodyState.deferToDefault`.
	if (clip === undefined) return;

	const track = trackFor(render, clip);
	if (track === undefined) return;

	// **The clip is stretched to fill the state it is describing, for the states that name a duration.** See
	// `STATE_CLIP_SECONDS` for which states those are and why the duck is one: its state *is* the animation,
	// because the head and arms are out of a ball's way for exactly as long as the state lasts — so a crouch
	// that ends early, or is cut in half, is a body the game says is ducking while it looks like it is
	// standing up. The speed is *derived* from the track's own `Length` rather than written down, which is
	// `chargePlaybackSpeed`'s trick on the charge sound and for its reason: `Length` is a fact about the asset
	// and not about this game, so the duck's duration stays the one number to change.
	//
	// **Asked on every play rather than once when the track was loaded, and that is the load-bearing half.**
	// `Length` reads `0` until the animation has streamed, and a track is cached for the life of the body — so
	// a one-time read would settle on `1×` for the whole session the first time a client ducked before the
	// asset arrived, silently, with nothing anywhere saying why. Asked here, the next duck picks the real
	// length up. The `1×` branch is that same case answered rather than derived, which is the honest answer
	// and the same one the charge sound gives.
	const stretched = STATE_CLIP_SECONDS[clip];
	if (stretched !== undefined) {
		track.AdjustSpeed(track.Length > 0 ? stretched / track.Length : 1);
	}

	track.Play(fadeFor(clip));

	// **Printed at the edge, and the rung is on the line because it is half of the answer.** The same shape for
	// both bodies — the caller's tag, the body's name, the state, the priority — so a player's line and a rig's
	// can be read side by side, which is how "do the two bodies do the same thing" is answered from a log. A
	// clip that will not load prints its own line instead (see {@link trackFor}), so this one means the body is
	// actually wearing the state.
	if (DEBUG) {
		const rung = isCycle(clip) ? "Movement" : "Action";
		print(`[${render.logTag}] ${render.body.Name}: ${clip} — ${rung}`);
	}
}

/**
 * Whether `track` is one of the tracks this renderer plays.
 *
 * **The one thing a caller has to be able to ask, and it is asked by the player's controller.** A player's
 * body also carries the engine's own animation script, whose tracks have to be stopped when they belong to a
 * set this game has claimed — and *not* stopped when they are this renderer's, which is the same clip on the
 * same limbs. A track cannot be asked who created it, so the only way to tell the two apart is to be told, and
 * this is that answer.
 */
export function bodyRenderPlays(render: BodyRender, track: AnimationTrack): boolean {
	for (const [, ours] of render.tracks) {
		if (ours === track) return true;
	}

	return false;
}

/**
 * Everything this body was given goes with it: the tracks are destroyed and the table is emptied.
 *
 * **Destroyed rather than stopped, and guarded.** This is called when the body is on its way out — a rig
 * removed from the world, a character dying — so the animator the tracks were loaded on may already be gone,
 * and destroying a track whose animator has gone raises. A death is not an exceptional event here, so a failed
 * teardown must not be what stops the *next* body from being dressed.
 */
export function destroyBodyRender(render: BodyRender): void {
	pcall(() => {
		for (const [, track] of render.tracks) track.Destroy();
	});

	render.tracks.clear();
	render.playing = undefined;
}

/**
 * The direction of a dash in flight, read off the body, or nothing.
 *
 * **Validated rather than trusted**, which is the convention every attribute read in this codebase keeps: an
 * attribute is a value anything can write, so a value that is not one of the four words means something else
 * wrote it and this machine has no clip for it. Absent is the ordinary answer — a body that is not dashing —
 * and it is the same answer as an unrecognised one, which is the safe direction to be wrong in: the body falls
 * back to its locomotion clip rather than to a clip nothing published.
 */
function publishedDodge(body: Model): DodgeDirection | undefined {
	const value = body.GetAttribute(DODGE_DIRECTION_ATTRIBUTE);
	if (!typeIs(value, "string")) return undefined;

	for (const direction of DIRECTIONS) {
		if (direction === value) return direction;
	}

	return undefined;
}

/**
 * The throw or the catch happening on this body **right now**, or nothing.
 *
 * **Two marks, ranked, because a body can hold both at once** — the throw's own window is open for a fraction
 * of a second after a throw, and a second ball caught inside it is an ordinary catch. The throw is asked first,
 * and that is not a preference: it is the newer event in the case where both are up and the one that took the
 * limbs, which is what `BallService.catchBall` arranges from its end by dropping a standing throw mark when a
 * catch is confirmed.
 */
function publishedAction(body: Model): BodyAction | undefined {
	if (body.GetAttribute(THROW_ANIMATION_ATTRIBUTE) === true) return "throw";
	if (body.GetAttribute(CATCH_ANIMATION_ATTRIBUTE) === true) return "catch";

	// **The duck is the third mark and the only one that lasts**, which is why it is read last and why it
	// still sits above locomotion in `bodyClipFor` rather than being a condition. It is written by
	// `DuckService` on the body for a player and a rig alike, so both are dressed by this one line — the
	// same property every other row of the table has, and the reason nothing about the duck had to be
	// added to either animator. See `shared/duck.ts` for what the clip is *for*: the animation is what the
	// player sees, and the exemption is what the game agrees to, and the two are deliberately different
	// mechanisms reading the same one attribute.
	if (body.GetAttribute(DUCKING_ATTRIBUTE) === true) return "duck";

	return undefined;
}

/**
 * The track for `clip` on this body, loading it the first time it is asked for.
 *
 * **One track per clip per body, cached in the render.** A track belongs to one `Animator` — it is the loaded
 * instance of an animation *on that body* — so it cannot be shared between bodies even though the `Animation`
 * it was loaded from could be; what the cache buys is that a body which walks, stops and walks again loads its
 * walking clip once for as long as it exists. `LoadAnimation` is the expensive half of this file, and this is
 * the only place it is called.
 *
 * `GetTrackByAnimationId` exists and could answer for the cache, but it is typed as returning a track where
 * its own documentation says it returns nil when nothing has been loaded — so this holds what it loaded, and a
 * nil is a fact it already knows.
 *
 * **A blank id is a legitimate answer and the off switch**, and this is where it is honoured: a caller that
 * reads one leaves the body wearing whatever it has rather than playing a clip that is presumably wrong. No row
 * of the shared table is blank today.
 */
function trackFor(render: BodyRender, clip: AnimationState): AnimationTrack | undefined {
	const cached = render.tracks.get(clip);
	if (cached !== undefined) return cached;

	const id = clipIdFor(clip, render.humanoid.RigType === Enum.HumanoidRigType.R15);
	if (id === "") {
		if (DEBUG) print(`[${render.logTag}] ${clip}: no id for this body — left as it stands`);
		return undefined;
	}

	const track = loadTrack(id, render.animator, clip);
	if (track === undefined) return undefined;

	render.tracks.set(clip, track);

	return track;
}

/**
 * Whether `clip` is a cycle a body stays in, **which decides both of the flags a track is loaded with** — see
 * {@link loadTrack}, where the two are set together because they are two readings of one question: a clip that
 * repeats is a locomotion clip, and the rung it plays on is the locomotion rung.
 */
function isCycle(clip: AnimationState): boolean {
	return CYCLE_STATES.includes(clip);
}

/**
 * How long `clip` takes to fade in or out, in seconds — **zero for anything that is not a cycle.**
 *
 * **A one-shot has to start at full weight or it is not seen at all, and the dash's own length is the
 * arithmetic.** A dodge lasts `DODGE_CONFIG.DURATION` — a fifth of a second — and this fade is the same fifth,
 * so a crossfaded dodge would reach full weight on the frame the dash ended and then fade straight back out:
 * the body would blend half-way into a pose and leave it, which reads as *no animation* rather than as a short
 * one. So the action clips are switched rather than crossfaded, and the locomotion pair keeps the fade it needs
 * to stop the walk↔run swap popping.
 *
 * **Nothing is lost by the hard cut on the way in**, because an action plays at `Action` and the legs it draws
 * over are at `Movement`: the action takes the limbs the instant it starts, which is what an action is for. The
 * way *out* is the same instant for the same reason, and the clip that follows it — the walk or the stand —
 * fades in on its own normal curve, so the body comes back from the action smoothly. Only the action's own ends
 * are hard, and both of them are hidden behind the clip that takes over.
 */
function fadeFor(clip: AnimationState): number {
	return isCycle(clip) ? FADE_SECONDS : 0;
}

/**
 * Loads one clip onto one animator, with the two flags that decide how it plays.
 *
 * **`Looped` is set from the clip rather than to `true`.** The flag belongs to the *track* —
 * `AnimationTrack.Looped`, not a property of the `Animation` asset instance it was loaded from — and the API
 * text says what setting it does without saying what it already is, so it is written rather than assumed. A
 * locomotion clip that repeats is the entire expectation here, and one that plays a single cycle and stops is
 * legs that freeze while the body keeps walking; a *dodge* is the opposite case and is why this is not simply
 * `true`: a dash lasts `DODGE_CONFIG.DURATION`, a clip authored for it may be longer or shorter, and one that
 * repeats until the state changes is a body that keeps throwing itself sideways after it has stopped moving.
 *
 * **`Movement` for a cycle, `Action` for a one-off, and those are two different rungs for one reason.**
 * Locomotion belongs on `Movement`: it leaves an action's flourish drawing over the legs and it is not `Core`,
 * where an avatar pack's own animations would bury them. An action is *that* flourish — the thing that draws
 * over the legs — and it is played on this same body by this same client, so at `Movement` the two would be
 * blended together rather than one drawing over the other. `Action` is the rung the dodge flourish has always
 * been played on, from the same reasoning. **Both bodies use both rungs, because this is the only place either
 * is set** — which is what "the priorities match" means here rather than two tables kept in step.
 *
 * Raises nothing. A load is a guess about an asset — an id that is not an animation, one this place does not
 * own, one that has been moderated — and a guess must never take a client's boot down with it; every animation
 * loader in this codebase wraps its own load in `pcall` for this reason and in these words. A body that cannot
 * load one clip simply keeps the clip it has.
 */
function loadTrack(id: string, animator: Animator, clip: AnimationState): AnimationTrack | undefined {
	let track: AnimationTrack | undefined;

	const [ok] = pcall(() => {
		const animation = new Instance("Animation");
		animation.AnimationId = id;

		// Left unparented, like the engine's own script's temporary clips: a track holds the animation it was
		// loaded from, so the instance has no other life to live.
		track = animator.LoadAnimation(animation);
	});

	if (!ok || track === undefined) {
		warn(`[Animation] clip ${id} would not load — the body keeps what it was wearing`);
		return undefined;
	}

	const cycle = isCycle(clip);

	track.Looped = cycle;
	track.Priority = cycle ? Enum.AnimationPriority.Movement : Enum.AnimationPriority.Action;

	return track;
}
