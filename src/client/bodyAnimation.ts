import { AnimationState, CYCLE_STATES, STATE_CLIP_SECONDS } from "shared/config/animation.config";
import { THROW_CHARGE_HOLD_SECONDS } from "shared/config/animation.config";
import { playCatchShockwave } from "./catchShockwave";
import { BodyAction, animationFor, bodyClipFor, clipIdFor, throwAnimationWindowSeconds } from "shared/animation";
import {
	CATCH_ANIMATION_ATTRIBUTE,
	CatchCause,
	DODGE_DIRECTION_ATTRIBUTE,
	DUCKING_ATTRIBUTE,
	THROW_ANIMATION_ATTRIBUTE,
} from "shared/constants";
import { DodgeDirection } from "shared/dodge";
import { DEBUG_LOGGING, logDebug, logInfo, logWarn } from "shared/logger";

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

	/**
	 * **The states this body has tried to load and could not** — the memory that used to be `playing`.
	 *
	 * **A separate set, because the old arrangement recorded a failure as a *success* and that is the freeze.**
	 * `playing` was assigned the new state before its track was looked for, so a clip whose asset would not load
	 * — a moderated id, one this place does not own, an empty row — left `playing` naming a clip with no track
	 * behind it. The guard at the top of {@link applyBodyRender} then read "the clip is already this one" on
	 * every later call and returned, so the body never tried again and never played anything: it stood in its
	 * bind pose, arms at its sides, for the rest of its life. Every other clip was unreachable too, because
	 * reaching one first requires passing that same guard with a *different* name — which the next throw does, so
	 * the symptom was a body that looked fine, then froze mid-session and stayed frozen.
	 *
	 * **What the old comment was right about is worth keeping**: a clip that cannot be loaded must not be retried
	 * on every change, because `loadTrack` warns and a body that changes state ten times a second would print ten
	 * warnings. Remembering the *attempt* is the idea; remembering it in the field that means "this is on screen"
	 * was the mistake. This set is the same idea with nothing else riding on it.
	 */
	readonly unplayable: Set<AnimationState>;

	/** The clip playing right now, so a state change that names the same clip writes nothing. */
	playing?: AnimationState;

	/**
	 * **The last charge level this body was seen holding**, kept because the level is only published *while*
	 * the charge is live and the speed has to be applied on the frame it ends.
	 *
	 * A renderer cannot ask a body "how hard was that throw" after the fact: the level is a number the client
	 * computes while the button is down (or, for a rig, an attribute the server clears the instant the windup
	 * ends), and the release is exactly the moment it stops being available. Remembering it is one number and
	 * one line; the alternative is an event carrying the charge level into the renderer, which is a second
	 * path for a fact the renderer already receives every frame.
	 *
	 * `undefined` until the body first charges, and never cleared: a throw always follows its own charge, and
	 * a stale value can only be read by a release that had none — which cannot happen, because a release is
	 * the *end* of a charge.
	 */
	charge?: number;

	/**
	 * **Whether the throw clip is currently being held at the wind-up rather than playing.** The flag that
	 * makes the release an edge rather than a thing re-applied every call.
	 *
	 * **Needed because the clip's name does not change when the charge ends.** Both the hold and the release
	 * are `"throw"`, so `playing` cannot tell them apart — and `applyBodyRender` returns early on an unchanged
	 * clip, which is precisely the call the release arrives on. This is the one bit of state that separates
	 * the two phases, and it is set from `conditions.charge` rather than from a timer.
	 */
	throwHeld?: boolean;

	/**
	 * **The `os.clock` instant a released throw's clip may stop being worn**, or nothing when no release is
	 * in flight — the latch that keeps the throw pose on a player's body while the server's mark is in transit.
	 *
	 * **A round trip is not optional here and it is not short.** A player's release is reported to the server,
	 * which writes `THROW_ANIMATION_ATTRIBUTE`; until that attribute arrives the body's own facts say "nobody
	 * is throwing", and without this the pose would drop to idle and then start again half a clip in — on
	 * every single throw. The deadline is the same window the server will use for the mark (one function,
	 * `throwAnimationWindowSeconds`, so the two cannot disagree), which means the clip lands on the mark and
	 * off it at the same moment from the player's point of view.
	 *
	 * **Nothing has to clear it.** It is compared against `os.clock` rather than counted down, so a stale value
	 * is a value in the past, and a body that was cancelled mid-charge never sets it at all.
	 */
	throwPlayingUntil?: number;
}

/**
 * The facts a caller gathers, because a body cannot answer them for itself.
 *
 * **Five of `BodyState`'s seven, and the split is the point of the type.** A body cannot say what it has been
 * asked to do, tell whether it is held, or say whether the game has a clip for what it is doing — for a rig,
 * the machine that *is* the body (the server) knows and publishes those facts; for a player's own body, the
 * client that owns it knows them directly. Both then hand the same five facts to {@link applyBodyRender},
 * which adds the two any body can always answer for itself, because those are the events it carries as
 * attributes.
 */
export interface BodyConditions {
	/**
	 * **Whether this body has been asked to move** — a request rather than a speed, and the fact the moving
	 * clips hang on. The same fact as `BodyState.moving`.
	 *
	 * **Gathered by the caller because it is a fact about the machine rather than about the body.** A player's
	 * own client is where movement keys become a `MoveDirection`; a rig's request is made by the server, which
	 * is why only the server can answer for it. That is the same seam every field here sits on, and the reason
	 * this type exists at all rather than the renderer reading a body.
	 */
	readonly moving: boolean;

	/** **Whether the moving it is asked for is the sprint** — the other half of the request. See `BodyState`. */
	readonly sprinting: boolean;

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

	/**
	 * **How far into a throw's charge this body is, `0` to `1`, or nothing when no throw is being held** — the
	 * same fact as `BodyState.charge`, and the one condition either caller can answer.
	 *
	 * **A player and a rig answer it from different places, and that is the seam this type exists for.** The
	 * client that owns a player's body measures the charge itself (`throwing.ts`'s start instant over
	 * `CHARGE_SECONDS`), because it drew the arc from that same division; a rig's windup is the server's and
	 * arrives as `CHARGING_ATTRIBUTE`. Neither caller has to know what the other does — the renderer holds and
	 * releases the clip from this number alone, so the two bodies cannot end up holding the pose for different
	 * reasons or at different points.
	 */
	readonly charge: number | undefined;

	/**
	 * **The level the throw this body has just released was charged with, or nothing when no release is pending.**
	 *
	 * **A player's release is the client's to report, because the server's answer arrives a round trip later.**
	 * `BallService` writes the throw's mark at the release, and the body has to keep its pose until that mark
	 * reaches this machine — but the charge itself is gone by then (it was measured on this client and cleared
	 * the frame the button came up), so the level has to come from the client that released it. That is
	 * `throwing.ts`'s `releasedCharge`, and this field is how it reaches the renderer.
	 *
	 * **A rig passes nothing, and that is not an omission.** A rig's windup and its mark are both the server's,
	 * written in the same frame, so there is no gap for a second fact to bridge — the renderer falls back to the
	 * level it remembered while the pose was held. See {@link BodyRender.charge}.
	 */
	readonly releasedCharge: number | undefined;
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
	return { body, humanoid, animator, logTag, tracks: new Map(), unplayable: new Set() };
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
	// **The catch's cause is handed to the effect before the clip guard rather than after it, and that ordering
	// is the whole of the change this made to this function.** Both halves of a catch play the *same* clip — an
	// attempt and a success are the same animation, a body reaching — so the clip's edge fires once, on the
	// attempt, and a catch arriving while that pose is still playing changes nothing this function compares. **The
	// cause is the only thing that distinguishes them**, so it is handed over on every call and the effect decides
	// what is new about it. An `undefined` is not "no call": it is the attribute's third state, written when the
	// mark expires, and it is what tells the effect to clear its record for this body so the *next* attempt fires
	// again.
	//
	// **The effect keeps that record rather than this function doing it**, and the reason is that this function
	// has no per-body state to keep it in: what it remembers is `render.playing`, a clip, and a second field here
	// would be a second thing to keep cleared. The module that draws the effects already keys everything on the
	// body. See `playCatchShockwave` for the guard and `catchShockwave.ts` for the two templates.
	//
	// **One attribute read per call rather than one per state**, which is worth saying because the line below
	// reads the same attribute again through `publishedAction`: two reads of a value that is already local is
	// cheaper than threading the cause through `BodyConditions`, which is a shared shape every state would then
	// carry a field for.
	playCatchShockwave(render.body, publishedCatchCause(render.body));

	// **The charge is remembered before the clip is decided**, because the frame this call is the *release*
	// frame is a frame the charge has already gone: the level arrives only while the button is down. See
	// `BodyRender.charge`.
	if (conditions.charge !== undefined) render.charge = conditions.charge;

	// **The release, decided before the clip is asked for, because the clip table cannot express it.** A charge
	// and the release that follows it are the same clip name, so `bodyClipFor` answers the same thing either
	// side of the edge — the transition is invisible to it by construction. Everything here is a comparison plus,
	// on one frame per throw, two property writes.
	//
	// **The level comes from whichever body can supply it.** A player's release is announced by the client that
	// made it (`conditions.releasedCharge`, available on the frame the button came up); a rig's is the server's
	// mark arriving on an attribute it shares a frame with, so it falls back to the level remembered from the
	// hold. A *cancelled* charge reaches this branch too and is harmless: it releases a track the clip change
	// below is about to stop, and it sets no latch, because nothing was released.
	if (render.playing === "throw" && render.throwHeld === true && conditions.charge === undefined) {
		const level = conditions.releasedCharge ?? render.charge;
		const held = render.tracks.get("throw");

		if (held !== undefined && level !== undefined) releaseThrowAtCharge(held, level);

		render.throwHeld = false;

		// **The latch, and only for a real release.** See `BodyRender.throwPlayingUntil`: without it the pose
		// would drop for the length of the player's round trip and then restart, which is a hitch on every throw.
		if (conditions.releasedCharge !== undefined && level !== undefined) {
			render.throwPlayingUntil = os.clock() + throwAnimationWindowSeconds();
		}
	}

	// Whether a released throw's clip is still owed to this body — see `BodyRender.throwPlayingUntil`.
	const lifted = render.throwPlayingUntil !== undefined && os.clock() < render.throwPlayingUntil;

	const state = {
		moving: conditions.moving,
		sprinting: conditions.sprinting,
		grounded: conditions.grounded,
		frozen: conditions.frozen,
		deferToDefault: conditions.deferToDefault,
		dodge: publishedDodge(render.body),
		action: (lifted ? "throw" : publishedAction(render.body)) as BodyAction | undefined,
		charge: conditions.charge,
	};

	const clip = bodyClipFor(state);

	// **And while the charge lasts, the pose is re-asserted rather than assumed.** Two property writes on the
	// frames a body is charging, and they earn it: `AnimationTrack.Length` reads `0` until the asset streams, so
	// the frame the hold was first applied can have been too early to place it — see `holdThrowAtWindup`, which
	// this re-enters for exactly that case. It also covers a charge that begins while a throw's own mark is
	// still up, where the clip was already `"throw"` and nothing started this frame.
	if (conditions.charge !== undefined && clip === "throw") {
		const held = render.tracks.get("throw");

		if (held !== undefined) {
			holdThrowAtWindup(held);
			render.throwHeld = true;
		}
	}

	// **One clip, and the comparison is the whole of the guard.** `playing` is the state this body was last
	// dressed in, so a call that wants the same one is a comparison and nothing else — which is what makes this
	// safe to call from an attribute change, from a per-frame tick, or from both.
	if (clip === render.playing) return;

	// **The track is resolved before anything is stopped, and that ordering is the fix for a body that froze in
	// its rest pose.** The first version recorded the new clip here — `render.playing = clip` — and only then
	// looked for its track, so a clip that would not load was remembered as *playing it* and the guard above
	// suppressed every later attempt. Resolving first means a state this body cannot dress costs it nothing: the
	// clip it is already wearing keeps running and the next call tries again, or `trackFor` has remembered the
	// failure and the body simply keeps what it has. See {@link BodyRender.unplayable} for the whole of that
	// fault and for what the old comment was right about.
	const actionTrack = clip === undefined ? undefined : trackFor(render, clip);

	// **The fallback, and it is the second half of the freeze fix rather than a politeness.** Resolving before
	// committing already stops a failed load from *destroying* what was playing — but it does nothing for the body
	// that had nothing playing yet, which is the whole of the cold case: the first state a rig is ever dressed in
	// is one clip, and if that one asset will not load the body has no track, no history, and nothing to fall back
	// on. Standing in a bind pose with its arms at its sides is exactly what that looks like, and it never recovers
	// because every later call wants a different state and `unplayable` refuses them one at a time.
	//
	// **So the locomotion answer is the floor.** `animationFor` is the same pure rule `bodyClipFor` ends on, so this
	// asks for the clip a body with no action on it would have worn anyway — idle, walk, run or jump — and it is
	// only consulted when the wanted clip cannot be dressed *and* nothing at all is playing. A body that is
	// already wearing something keeps it, which is the direction this whole function has to err in: an outdated
	// clip is a body slightly behind its state, and no clip is a body that looks broken.
	let worn = clip;
	let wornTrack = actionTrack;

	if (wornTrack === undefined && render.playing === undefined) {
		const base = animationFor(state.moving, state.sprinting, state.grounded, state.frozen);

		if (base !== undefined) {
			const baseTrack = trackFor(render, base);

			if (baseTrack !== undefined) {
				worn = base;
				wornTrack = baseTrack;
			}
		}
	}

	// A clip this body cannot play is not a clip it stops for. `undefined` here means the asset refused to load
	// and no floor could be found either, and the body keeps whatever it was wearing — which is the honest
	// answer, and the one that cannot leave it standing in a bind pose with no track at all.
	if (worn !== undefined && wornTrack === undefined) return;

	if (render.playing !== undefined) render.tracks.get(render.playing)?.Stop(fadeFor(render.playing));

	// **Recorded after the track is in hand**, which is the whole correction described above.
	render.playing = worn;

	// **What is deliberately *not* here** is any effect that belongs to the clip rather than to the attribute: the
	// catch's effect fires at the top of this function, and the track lookup above is the clip's own business.

	// **And `undefined` is the release: the stop above has already happened and no track is started here, which
	// is the whole of "play nothing".** The body is left to whoever else is animating it — for a player that is
	// Roblox's own `Animate` script, whose `sit`, `climb` and `swim` sets this game never claimed and whose four
	// claimed sets are the only tracks `LocomotionAnimationController.suppressScript` stops. The record is
	// `undefined` rather than the clip that was playing, so the next *owned* state is a change again and the
	// body resumes rather than sitting in a stale track. See `BodyState.deferToDefault`.
	if (worn === undefined || wornTrack === undefined) return;

	const stretched = STATE_CLIP_SECONDS[worn];
	if (stretched !== undefined) {
		wornTrack.AdjustSpeed(wornTrack.Length > 0 ? stretched / wornTrack.Length : 1);
	}

	// **`1` for the speed, explicitly, and that argument is a bug fix rather than a default spelled out.**
	// `Play(fadeTime, weight, speed)` keeps the track's own speed when the third argument is omitted, and these
	// tracks are *reused* for the life of the body — so a windup that was cancelled (a rig's
	// `windup cancelled — the turns stopped`, a player letting go of the key) left the throw track at
	// `AdjustSpeed(0)` from the hold, and the next throw replayed it frozen on its cocked pose. Nothing reset it:
	// the release path only ran for a throw that *was* released. Passing `1` here is the reset, and it is the one
	// place a stale speed can be cleared, because it runs on every start.
	wornTrack.Play(fadeFor(worn), 1, 1);

	// **And a one-shot starts from its beginning**, for the same reason and with one more: `Play` resumes from the
	// track's stored `TimePosition`, so a second throw would begin part-way through the last one's motion and a
	// short clip would appear to do nothing at all. A *cycle* is deliberately not rewound — restarting the walk on
	// every state change would be a body whose legs hitch each time it was asked to move.
	if (!isCycle(worn)) wornTrack.TimePosition = 0;

	// **A throw clip that starts while a charge is live starts *held*, and that is the only place the hold is
	// established.** The charge is what made the clip appear, so the pose has to be on the wind-up rather than
	// at the start of the clip: `Play` on a fresh track begins at `TimePosition` 0, which is the body swinging
	// back rather than already back. See `holdThrowAtWindup` for what it writes and `BodyRender.throwHeld` for
	// why the flag exists at all.
	render.throwHeld = worn === "throw" && conditions.charge !== undefined;

	if (render.throwHeld) holdThrowAtWindup(wornTrack);

	// **Printed at the edge, and the rung is on the line because it is half of the answer.** The same shape for
	// both bodies — the caller's tag, the body's name, the state, the priority — so a player's line and a rig's
	// can be read side by side, which is how "do the two bodies do the same thing" is answered from a log. A
	// clip that will not load prints its own line instead (see {@link trackFor}), so this one means the body is
	// actually wearing the state. **The state printed is `worn`, not the one that was wanted**, because the
	// locomotion floor below can answer with a different clip — and a line naming a clip the body is not wearing
	// is the one thing a diagnosis cannot survive.
	if (DEBUG_LOGGING) {
		const rung = isCycle(worn) ? "Movement" : "Action";

		logInfo(`[${render.logTag}] ${render.body.Name}: ${worn} — ${rung}`);
	}
}

/**
 * **Stops the throw clip at the cocked pose** — the wind-back, held for as long as the charge lasts.
 *
 * **Two writes, and both are needed.** `AdjustSpeed(0)` freezes the track where it stands, and
 * `TimePosition` puts it where the pose actually is: the clip is one motion authored straight through, so the
 * difference between "a body winding up" and "a body mid-throw" is one number in the track. A speed of zero
 * alone would freeze a fresh track at `0`, which is the body *starting* the wind-up rather than holding it.
 *
 * **Written every call rather than once, and the guard is not decoration.** `Length` reads `0` until the
 * animation has streamed, and a track is cached for the life of the body — so the first charge of a session
 * can run against a track that has no length yet, where setting `TimePosition` clamps to the start. The
 * caller re-asserts the pose on every update while the charge is live (see `applyBodyRender`), which costs two
 * property writes and repairs that case the moment the asset arrives. It is the same lesson
 * `STATE_CLIP_SECONDS` records one function up.
 */
function holdThrowAtWindup(track: AnimationTrack): void {
	track.AdjustSpeed(0);

	if (track.Length > 0) track.TimePosition = THROW_CHARGE_HOLD_SECONDS;
}

/**
 * **Plays the rest of the throw from the held pose, at the clip's own speed.**
 *
 * **`1×`, and it used to be the charge.** The clip's `0.63 s` of remaining motion was played at
 * `charge ×` speed so a weak throw drew itself over a longer window — and a tap producing a three-second throw
 * read as the game stalling, not as a weak throw. The clip now plays at its authored rate for every throw, and
 * **the charge is carried by the camera instead**: `cameraShake`'s tremble grows with the hold while a throw is
 * being charged, which says "how hard" *before* the release rather than by stretching the release. The
 * parameter is kept because the call site still names what released it and a future sign may want it again.
 *
 * **The pose is re-asserted before the speed, and it is the cold-asset case again.** If the hold never landed
 * — the clip streamed after the charge began — the track may still be at the start, and resuming from there
 * would replay the wind-up the player has just spent a second holding. Putting it on the hold point first
 * means the release always continues from where the pose was, whatever the track did before.
 *
 * **`AdjustSpeed` rather than `Play`**, because the track is already playing (at speed zero): changing the
 * speed resumes it from its own position, which is what makes this one continuous motion rather than a
 * second clip starting. The speed is set explicitly rather than left at zero for the next throw, and the next
 * hold re-zeroes it in `holdThrowAtWindup`.
 */
function releaseThrowAtCharge(track: AnimationTrack, charge: number): void {
	if (track.Length > 0 && track.TimePosition < THROW_CHARGE_HOLD_SECONDS) {
		track.TimePosition = THROW_CHARGE_HOLD_SECONDS;
	}

	// **`1×`, and the charge is no longer read here.** The speed used to be the charge level, which made a
	// weak throw take two or three seconds to finish drawing — read as a stall rather than as a weak throw.
	// The level is carried by the camera instead (`cameraShake`'s tremble during the hold), so the clip plays
	// its authored motion at its authored rate and the pose is the only thing the hold changes. The parameter
	// is kept so the call site still says what released it.
	track.AdjustSpeed(1);
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
	render.unplayable.clear();
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
 * limbs, which is what `BallService.markCatchAnimation` arranges from its end by dropping a standing throw mark
 * when a catch is published.
 */
function publishedAction(body: Model): BodyAction | undefined {
	if (body.GetAttribute(THROW_ANIMATION_ATTRIBUTE) === true) return "throw";

	// **Read through the validator below rather than tested for presence here**, so that this attribute's two
	// words are checked in exactly one place in this file — the same shape the dodge's read has, and for the same
	// reason. The clip is the same for both causes on purpose: an attempt and a success *are* the same animation,
	// and telling them apart is the effect's job rather than the animation's.
	if (publishedCatchCause(body) !== undefined) return "catch";

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
 * Which half of a catch this body is in, read off the body, or nothing.
 *
 * **Validated rather than trusted**, exactly as {@link publishedDodge} is and for the same reason: an attribute
 * is a value anything can write, so a value that is not one of the two words means something else wrote it.
 * `undefined` is the third state and the ordinary one — a body that is not catching — and an unrecognised value
 * is answered as `undefined` too rather than passed on, which is the safe direction: the effect is not drawn for
 * a cause nothing published.
 *
 * **This is the value the catch's effect fires on, and it is read here rather than inside the effect.** This
 * file is the only place that reads `CATCH_ANIMATION_ATTRIBUTE`, and the design keeps it that way: the effect
 * takes the cause as an argument and discovers nothing for itself, so the number of modules that know a body
 * exists stays at two — the two animators — rather than becoming three.
 */
function publishedCatchCause(body: Model): CatchCause | undefined {
	const value = body.GetAttribute(CATCH_ANIMATION_ATTRIBUTE);
	if (!typeIs(value, "string")) return undefined;
	if (value === "attempt" || value === "catch") return value;

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

	// **Already tried, already failed.** See {@link BodyRender.unplayable}: the memory used to live in `playing`,
	// which both suppressed the retry *and* claimed the body was wearing the clip — the body then had no track at
	// all. Kept out of the way here, so the caller can answer "this body keeps what it has" and be right.
	if (render.unplayable.has(clip)) return undefined;

	const id = clipIdFor(clip, render.humanoid.RigType === Enum.HumanoidRigType.R15);
	if (id === "") {
		logDebug(`[${render.logTag}] ${clip}: no id for this body — left as it stands`);

		render.unplayable.add(clip);

		return undefined;
	}

	const track = loadTrack(id, render.animator, clip);
	if (track === undefined) {
		render.unplayable.add(clip);

		return undefined;
	}

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
		logWarn(`[Animation] clip ${id} would not load — the body keeps what it was wearing`);
		return undefined;
	}

	const cycle = isCycle(clip);

	track.Looped = cycle;
	track.Priority = cycle ? Enum.AnimationPriority.Movement : Enum.AnimationPriority.Action;

	return track;
}
