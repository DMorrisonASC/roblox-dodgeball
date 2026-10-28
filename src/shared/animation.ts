import { AnimationState, BODY_ANIMATION, CYCLE_STATES, THROW_CHARGE_HOLD_SECONDS, THROW_CLIP_SECONDS } from "./config/animation.config";
import { DodgeDirection } from "./dodge";

/**
 * The state a body is in, turned into the clip it should wear — **one decision, for every body in the game.**
 *
 * **One vocabulary, one table, one decision, two bodies.** A player's body and a rig draw their clips from
 * `animation.config.ts` through this module: there is no second list of clips and no second rule about which
 * one applies, so a state added there is a state **both** bodies wear. That is the property this module
 * exists to make true, and it is the answer to the fault it replaces — a state wired for one body and
 * silently doing nothing for the other, with every animation feature written twice in two styles.
 *
 * **Pure, therefore usable by both, and the purity is load-bearing rather than tidy.** It takes a
 * {@link BodyState} — a value the caller gathers — and answers with a name. There is no `Players`, no
 * `RunService`, no `Humanoid` and no attribute read in here, because those are exactly the things that differ
 * between the two callers: a rig's facts are published by the server and read off the rig, a player's own
 * body is measured by the client that owns it, and a decision that reached for either would fit one body and
 * need a copy for the other. Gathering is the caller's job, deciding is this module's, rendering is
 * `BodyAnimator`'s.
 *
 * **A name rather than an id, and the resolution is `clipIdFor`'s.** Every clip is two ids, one per rig type,
 * and which column applies is a fact about the *body* rather than about the state — so it is answered where
 * the body is, and never threaded through this decision.
 */

/**
 * A clip Roblox's own `Animate` script has a *set* for — Roblox's own four names.
 *
 * **A subset of `AnimationState` rather than a parallel vocabulary**, and spelled the same way on purpose:
 * these are the sets the script looks its own animations up by, which is why the controller that claims them
 * and the shared table that holds the ids agree by construction. The other eight states in
 * `AnimationState` are ones that script has no concept of at all.
 */
export type AnimationClip = "idle" | "walk" | "run" | "jump";

/**
 * **There was a speed line here, and there is not one any more** — this is the record of why, because the
 * argument for it was a good one and what it bought was not.
 *
 * **It was `STANDING_SPEED`, and everything downstream of it came from the same place.** The line was Roblox's
 * own animation script's (`speed > 0.01` in its `onRunning`) drawn in the same place here, which was right as
 * far as it went — and what it went on to cost is a family of faults with one cause: **a threshold on a
 * measurement is a decision that changes its mind for reasons the game never asked for.** A player's body is
 * asked twenty times a second from a *sample*, so a number that dips for a single tick changed the clip, and a
 * clip change is a crossfade — so a body walked with neither clip fully worn. Smoothing that needed a grace,
 * and the grace bought its own fault the other way: a walk that outlived its stop. The same line on a rig
 * needed the published speed *banded* so the attribute would not be rewritten every frame — and the band
 * floored to zero, so every rig moving slower than five studs a second published "standing". And the last
 * straw: a body's velocity is not what it was asked to do — `WalkSpeed` 20 with a measured 20.3 is what the
 * animation output showed — so a walking body sat a hair away from the running clip.
 *
 * **What replaced it is not a better threshold but a different fact: whether the body has been *asked* to
 * move.** For a player's own body that is `MoveDirection`, which the client's own input writes — a request with
 * no line to sit on, so there is no jitter to smooth, no band, no grace, and no threshold to tune. **A rig has
 * no request to give**: its body is driven by `Humanoid:MoveTo()` and its half of this fact is the humanoid's
 * own running speed, which *is* a measurement — taken from an edge rather than sampled per turn, and *ended* by
 * `Humanoid.MoveToFinished`, which is the only one of the two the engine promises to fire at a stop. Its
 * reasoning and its cost are written out in `NpcService.publishAnimation` and in `NPC_ANIM_MOVING_ATTRIBUTE`.
 * See {@link animationFor} for the rule the two facts make together.
 *
 * **What this is not:** not a claim that measurement is useless. It is what `WalkSpeedService`,
 * `SeekBehavior`'s distance gates and every physics question in this game are about. It is simply not what a
 * *clip* is chosen from — a body's legs answer to what it was told to do.
 */

/**
 * The **locomotion** clip a body in this physical state should wear, or `undefined` for "none".
 *
 * **The ordinary answer, and only the ordinary one.** Events — a throw, a catch, a dash — are not this
 * function's business: they outrank everything here and are ranked in {@link bodyClipFor}, which is the
 * function a renderer calls. This is the half that answers "how is this body moving on the ground", and it
 * is the half both bodies have always shared.
 *
 * **`undefined` is a real answer and means "no locomotion clip"**: a held body is not walking, not falling
 * and not standing, so it has no clip from here. What a caller does with it is {@link RESTING_STATE}'s
 * question, and it has one answer for both bodies now.
 *
 * **Frozen outranks everything below it.** A held body is being held rather than choosing where to go, and the
 * honest answer for its legs is to stop playing one. Only a rig reaches this branch with the flag: a player's
 * freeze is a walk-speed key and an anchored root, and the *key* is the half this rule sees — a body whose walk
 * speed has been taken away is not a body anyone asked to walk, which is why
 * `LocomotionAnimationController` folds the two together into one request. See `BodyState.moving`.
 *
 * **Off the ground outranks the request.** A body in the air wears the jump clip whatever it is being asked to
 * do, because the alternative is a falling body whose legs are walking.
 *
 * **Walk and run are decided by the request, and this rule has now been on both sides of that line.** It began
 * as the sprint key; it went to the measurement on the argument that is worth keeping (the key is intent, but a
 * measured speed dips when a sprint turns a corner, and a rig has no key at all); and it has come back to the
 * request, because the measurement turned out to be the thing that could not be shared *faithfully*. It is a
 * sample, so it jittered, and everything that followed — a grace for how long a body must read as slow, a band
 * so a rig's attribute would not be rewritten every frame, a line drawn at 25 to sit between a walk speed of 20
 * and a measured 20.3 — was a patch on the same wound. **The cost is the one that was named then, and it is
 * accepted now:** a sprint the server refuses is worn as a sprint anyway. It is smaller than it was, because
 * the client's sprint state is the key *and* the pool, so a body with nothing left in it stops asking; and it
 * buys a rule with no line in it at all, which is the property this module was rebuilt for.
 *
 * **A body carrying a ball may walk, run or stand exactly as if it were not.** There used to be a fourth
 * parameter here — `throwing`, "this body has a ball and its next act is to throw it" — which stood a rig
 * still in a hold pose while it carried one. It is gone: a ball in a hand is not an animation state, and a
 * rig wearing a hold pose while the player beside it walked normally with a ball was the two bodies
 * disagreeing about the same thing. See `BodyState` for the rule.
 *
 * **And there is no memory in this function, which is the whole of what the two facts buy.** Both are
 * *requests* — a body is asked to move, and asked to sprint — so there is no line to cross, nothing to smooth
 * and no grace: a body that is asked to walk walks on the tick the request arrives, and stops on the tick it
 * is withdrawn. The crossfade in the renderer is still there and still wanted, but it is now the only thing
 * between a key and a clip.
 */
export function animationFor(
	moving: boolean,
	sprinting: boolean,
	grounded: boolean,
	frozen: boolean,
): AnimationClip | undefined {
	if (frozen) return undefined;
	if (!grounded) return "jump";
	if (!moving) return "idle";

	// The two moving clips, and the only question left between them: was this body asked to sprint?
	return sprinting ? "run" : "walk";
}

/**
 * The id this game has for `state` on a body of this rig type, or `""` where it has none.
 *
 * **The one resolver, for both bodies.** It used to be two — `clipFor` for a player's four locomotion words
 * out of `CHARACTER_CONFIG`, `rigClipFor` for a rig's twelve out of the rig table — and that split was the
 * whole of what kept the two bodies apart: a state could exist for one and not for the other, and the failure
 * of that was a body playing no clip at all. With one table there is one lookup, so a state added to
 * `BODY_ANIMATION` is a state **both** bodies can be dressed in — which is the property the whole
 * unification exists to buy.
 *
 * **An empty id is the off switch and a legitimate answer**, exactly as it was on both sides before: a caller
 * that reads one leaves the body alone rather than playing something almost right. No row of the shared table
 * is empty today; this is the reading a blank row would get if one ever appeared.
 *
 * **Rig type is a parameter rather than a read**, because which column applies is a fact about the *body* and
 * the caller is the thing holding it. It is the same read for a player and a rig (`Humanoid.RigType`), and
 * the same trap if it is wrong: an R6 clip never loads onto an R15 rig and the reverse, so the wrong column
 * is a track that loads nothing.
 */
export function clipIdFor(state: AnimationState, isR15: boolean): string {
	const ids = isR15 ? BODY_ANIMATION.R15 : BODY_ANIMATION.R6;

	return ids[state];
}

/**
 * One of the actions a body can be **in the middle of** — an event rather than a condition.
 *
 * Both are written by `BallService` at the moment they happen, on **every** body they happen to, and cleared
 * a moment later: the throw at `throwBall` (where a ball leaves a hand) and the catch at `completePull` (where
 * one arrives in it, a fraction of a second after the catch was decided). Neither is a state a body is *in* for
 * a while, which is why they are not conditions
 * with attributes republished on change (that is what `NPC_ANIM_*` is for) and why they have to be read as
 * "is this happening right now".
 *
 * **The duck is the third member and it is the one that breaks the paragraph above, which is why it is
 * written down rather than quietly added.** It *is* a state a body is in for a while — half a second,
 * `DUCK_SERVICE`'s number — so it belongs to the condition half of that distinction and not to this one.
 * It is here anyway, and for one reason: the fact it is drawn from is published by `DuckService` as an
 * attribute on the body, exactly as the throw's and the catch's marks are, and this module's job is to
 * turn *a body's published marks* into a clip. Moving it to a condition would mean threading a second
 * mechanism through `BodyState` — a field the client would gather from the same attribute — for no gain
 * a reader can see. **What it costs is the word "event"**: the duck is the one member of this union that
 * lasts, and the ranking in {@link bodyClipFor} is where that shows.
 */
export type BodyAction = "throw" | "catch" | "duck";

/**
 * Everything a body's clip is decided from, in one value.
 *
 * **The seam between the two machines, and the reason this is a value rather than a set of parameters.** Who
 * *knows* these facts differs between the bodies — a rig's are published by the server and read off the rig,
 * a player's own body is answered by the client that owns it — and who *decides* from them must not. So the
 * facts are gathered by the caller and handed over, and this module stays a pure function of them: no
 * `Humanoid`, no `Players`, no attribute read, nothing that would make one body's answer depend on which
 * machine was asking.
 */
export interface BodyState {
	/**
	 * **Whether this body has been *asked* to move** — a request rather than a measurement, and the fact the
	 * whole of the locomotion answer now turns on. A player's own body answers it from `Humanoid.MoveDirection`
	 * together with the walk speed it has been given; a rig is handed the server's answer as an attribute.
	 *
	 * **A request rather than a speed, and that is what makes the rule stateless.** A body is asked or it is
	 * not, so there is no line in the middle of a range for a sample to wander across — and therefore no
	 * jitter, no band and no grace. See `animationFor`, and the note where the speed line used to be for what
	 * the measurement cost while it was here.
	 *
	 * **Both bodies are intent, and since 2026-10-26 that is true of the rig half as well.** The rule is one
	 * sentence and it has no exceptions: **a body animates walking if and only if something told it to walk, and
	 * what the physics then does to it is not animation's business.** For a player the "something" is the input the
	 * local client writes into `MoveDirection`; for a rig it is `NpcService`'s `walkTo`, and the fact arrives here as
	 * the attribute. A shoved body of *either* kind was never asked, so it stands — which is the whole of what
	 * `NpcLoop.walking` records and the reason rigs no longer read a running speed. **If a third kind of animated
	 * model is ever added it answers this field the same way**: from whatever asked it to move, never from what it
	 * is doing.
	 */
	readonly moving: boolean;

	/**
	 * **Whether the moving it has been asked for is the sprint** — the request's other half, and the one thing
	 * `moving` cannot say: a body that has been told to move has been told *how* as well, and this is that
	 * answer. The only question left between the two moving clips.
	 *
	 * **For a player this is the key rather than the sprint the server granted**, which is a choice with a cost
	 * that `animationFor` records; for a rig it is the sprint's own contribution on the walk speed, asked of
	 * the service that keeps it.
	 */
	readonly sprinting: boolean;

	/** Whether the body is standing on something. Off the ground outranks everything but an event. */
	readonly grounded: boolean;

	/** Whether the body is held. Only a rig publishes this: a player's freeze arrives as no speed at all. */
	readonly frozen: boolean;

	/**
	 * **Whether the game has nothing to say about this body right now** — set by the caller when the body is in
	 * a state the four clips were never a description of: sitting on a bench, knocked over, climbing, swimming.
	 * When it is true the decision below answers `undefined`, which the renderer reads as *play nothing* and
	 * hands the body back to Roblox's own `Animate` script.
	 *
	 * **It outranks the locomotion answer and nothing else.** An event still wins — a dodge or a throw is a
	 * motion that has to be seen, and a body knocked over mid-throw still throws — so the deferral sits below the
	 * events and above `animationFor` in the ranking inside `bodyClipFor`. See `LocomotionAnimationController`
	 * for the list of states the game does own, which is where the question is actually answered; this field is
	 * only how the answer travels.
	 *
	 * **A rig passes `false`, and that is a reading rather than an omission.** Nothing can seat a rig, and the
	 * states a rig *can* reach are answered otherwise: a freeze is published as `frozen`, and a corpse ends the
	 * loop that dresses it. See `RigAnimationController.conditionsOf`.
	 */
	readonly deferToDefault: boolean;

	/** The direction of a dash in flight, or nothing. Outranks every state below it. */
	readonly dodge: DodgeDirection | undefined;

	/** A throw or a catch happening **now**, or nothing. Outranks every state below it. */
	readonly action: BodyAction | undefined;

	/**
	 * **How far into a throw's charge this body is, from `0` to `1`, or nothing when no throw is being held.**
	 *
	 * **A condition rather than an action, and the one condition that borrows an action's clip.** A charge is
	 * not an event: it lasts as long as somebody holds a button, which can be a second and a quarter or a
	 * frame. But the pose for it *is* the throw's own wind-up — the arm is back — so it resolves to the
	 * `"throw"` clip and the renderer holds that clip at the wind-up rather than playing it through. See
	 * `applyBodyRender`, which is where the hold and the release live, and {@link bodyClipFor} for the rank.
	 *
	 * **Two bodies answer it from two different facts.** A rig publishes it as `CHARGING_ATTRIBUTE`, a number
	 * the server writes for the length of the windup it is running. A player's charge is measured on the
	 * client that owns the body and never sent anywhere, so its number is `throwing.ts`'s clock divided by
	 * `CHARGE_SECONDS` — the same division the arc is drawn from, so the pose and the preview cannot disagree.
	 */
	readonly charge: number | undefined;
}

/**
 * Which clip each dodge direction is, spelled once — **the mapping both bodies read.**
 *
 * **A dispatch rather than arithmetic**, because the table's names for these four are its own business: a
 * state added later could be named anything, and the mapping between the published direction and the clip it
 * means is exactly the kind of small table a reader should be able to check at a glance. It is keyed by
 * `DodgeDirection` — the *published* vocabulary — so a fifth direction is a compile error here rather than a
 * dodge that silently plays nothing.
 *
 * It used to live in `RigAnimationController`, which was the only reader, because a player's dash was drawn
 * from the server. Both bodies are drawn from the published direction now, so the mapping sits on the shared
 * side of the line, beside the decision that consults it.
 */
const DODGE_STATES: Record<DodgeDirection, AnimationState> = {
	forward: "forwardDodge",
	backward: "backwardDodge",
	left: "leftDodge",
	right: "rightDodge",
};

/**
 * The state a body wears when this module has no locomotion clip for it.
 *
 * **A player and a rig used to answer "no clip" differently, and they do not any more.** `animationFor`
 * answers `undefined` for a frozen body, and the player's controller used to take that as "not mine" and
 * leave the body to Roblox's `Animate` script — which works for a player and cannot work for a rig, whose
 * body would sit in its bind pose. Since both bodies are now dressed by the same renderer from the same
 * table, the answer has to be one answer: the standing clip, which is what the script would have played for
 * the player anyway (`idle` is a set the controller claims with this game's own clip).
 */
export const RESTING_STATE: AnimationState = "idle";

/**
 * The clip a body in this state wears — **the one decision, for both bodies.**
 *
 * **Three ranks, and the order is the whole of it.** An **event** beats everything, because a throw is a
 * motion that has to be seen and it lasts a fifth of a second; a **dash** beats a throw, because a dodge is
 * the body moving and the dash is what the player asked for; and a **condition** — the ordinary locomotion
 * answer — is what is left when neither is happening. That is the rig's precedence, unchanged, now applied
 * to the player's body as well.
 *
 * **The two events are ranked, because a body can hold both marks at once.** A rig that throws and then
 * catches a second ball inside the throw's own window has both; the throw wins here because it outranks the
 * catch — see `BallService.markCatchAnimation`, which drops a standing throw mark the moment a catch is published, so
 * that the *newer* action is the one that owns the limbs in the case that can actually be arranged.
 *
 * **`undefined` is a real answer, and it means "play nothing".** It is the *caller's* answer rather than this
 * function's judgement: a body in a state the game has no clip for — seated on a bench, knocked over — is handed
 * back to Roblox's own `Animate` script, and the renderer reads `undefined` as "stop our tracks and start no
 * more of ours". Nothing in the ranking above the deferral can produce it, which is what keeps "the game has
 * nothing to say here" distinct from "the locomotion answer happens to be empty" — the latter is
 * {@link RESTING_STATE}'s job and is unchanged.
 */
export function bodyClipFor(state: BodyState): AnimationState | undefined {
	if (state.action === "throw") return "throw";
	if (state.dodge !== undefined) return DODGE_STATES[state.dodge];

	// **The charge, ranked with the events but below the dash — and it is the same clip as the release.**
	// Above the catch and the duck because the thing being drawn is the *ball*: a body winding up is holding
	// the pose the throw comes out of, and that pose is the one fact the player most needs to see while they
	// choose how hard to throw. Below the dash because a dodge is the whole body moving and it outranks a
	// motion of one arm — the same precedence a live throw has. **That the two ranks produce the same clip is
	// deliberate and is why `applyBodyRender` has an explicit release path**: the clip's *name* does not change
	// when the charge ends, so the renderer cannot see the transition through this function at all.
	if (state.charge !== undefined) return "throw";

	if (state.action === "catch") return "catch";

	// **The duck sits below the catch and above locomotion, and the rank is the whole of the argument.**
	// It is not an event — it lasts half a second — so it has no business outranking a throw or a catch,
	// which are motions that have to be seen for a fifth of a second or not at all; and it is not
	// locomotion either, because a ducking body is planted and `animationFor`'s answer for a standing body
	// is the idle clip. So a body that ducks while catching *catches*, and a body that ducks while standing
	// ducks. See {@link BodyAction} for why the one member with a duration is in that union at all.
	if (state.action === "duck") return "duck";

	// **The deferral, below the events and above the locomotion answer.** Below, because an event outranks
	// everything — a body knocked over mid-throw still throws; above, because the whole point of it is that
	// `animationFor`'s question ("how is this body moving on the ground") is not the question to ask about a
	// body that is sitting on a bench. See `BodyState.deferToDefault`.
	if (state.deferToDefault) return undefined;

	return animationFor(state.moving, state.sprinting, state.grounded, state.frozen) ?? RESTING_STATE;
}

/**
 * **How long the throw clip needs after a release, in seconds** — the length the mark has to last for the
 * animation to be seen to its end.
 *
 * **A constant, and it was a function of the charge for one revision.** The clip used to be played at
 * `charge ×` speed so that a weak throw drew its motion over a longer window — and a throw that stretched to
 * three seconds read as the game stalling rather than as a weak throw. The clip plays at its own rate now, so
 * what is left is the asset's own length, which is the whole clip: the hold at `THROW_CHARGE_HOLD_SECONDS` plus
 * everything after it. **The charge is carried by the camera instead** — see `client/cameraShake.ts`, whose
 * tremble during the hold scales with it.
 *
 * **The second reader is the release, and it needs the number for the opposite reason.** This is the length of the
 * *mark*, and a mark that outlives the motion leaves the body wanted in a clip that has already finished — which an
 * animator draws as the engine's own idle, hands at the hips. A charged throw has only
 * `THROW_CLIP_SECONDS − THROW_CHARGE_HOLD_SECONDS` of motion left when it is released, so `bodyAnimation`'s
 * `releaseThrowAtCharge` spreads that remainder across this window instead of playing it at `1×`. **The clip and
 * its mark end together because of that one division**, not because the two constants happen to agree — and a
 * change that puts the release back on a fixed rate reintroduces the flicker on every throw.
 *
 * **The server is one of the two readers, and that is why this is arithmetic rather than a client read of the
 * track.** `BALL_CONFIG.THROW_ANIMATION_SECONDS` is the mark's length and the mark is what keeps the clip up; the
 * client knows the real length of the asset and the server does not, so the length is written down in
 * `animation.config.ts` and this function is the single expression that turns it into a duration. Callers take
 * `math.max` with `THROW_ANIMATION_SECONDS` so the old floor survives.
 */
export function throwAnimationWindowSeconds(): number {
	return THROW_CLIP_SECONDS;
}
