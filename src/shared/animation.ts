import { AnimationState, BODY_ANIMATION } from "./config/animation.config";
import { CHARACTER_CONFIG } from "./config/character.config";
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
 * The speed at or below which a body counts as standing still, in studs per second.
 *
 * **The engine's own figure rather than a second opinion about it.** It is the number Roblox's own
 * animation script draws this line at — `speed > 0.01` in its `onRunning` — and this module is
 * making the same decision from the same measurement, so it draws it in the same place. It lived in
 * `LocomotionAnimationController` until the rule became shared, and it moved here because the rule
 * did: a caller that has to know this number is a caller that is making half of this decision.
 */
export const STANDING_SPEED = 0.01;

/**
 * How coarsely a rig's speed is rounded before it is published, in studs per second.
 *
 * **A band, because the alternative is an attribute write per frame.** The published state is
 * written on change and not per frame — that is the whole economics of the architecture — so a
 * state carrying a *measurement* would publish continuously: a body's speed never stops wobbling,
 * and a rig walking a straight line would write its speed several times a second for a distinction
 * nothing downstream can see.
 *
 * **5 studs, because the two thresholds this module compares against are 0.01 and 25.** A body
 * walks at 20 and sprints at 35, so bands of 5 put a walking body and a sprinting body in different
 * buckets and neither of them near a boundary: the walking bucket is 20–24, the sprinting one is
 * 35–39, and the gap between them is where `CHARACTER_CONFIG.RUN_ANIMATION_SPEED` sits. A walking
 * body therefore publishes once, when it starts walking, and then says nothing at all until it
 * stops or sprints — which is the behaviour the whole arrangement is for.
 *
 * **Placeholder.**
 */
export const ANIMATION_SPEED_BAND = 5;

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
 * **Frozen outranks everything below it.** A held body is being held rather than choosing where to go, and
 * the honest answer for its legs is to stop playing one. Only a rig ever reaches this branch today: a
 * player's freeze is a walk-speed key and an anchored root, which arrive at the caller as "no speed and no
 * ground" and are answered by the branches below.
 *
 * **Off the ground outranks speed.** A body in the air wears the jump clip whatever it is doing and however
 * fast it is travelling, because the alternative is a falling body whose legs are walking.
 *
 * **Walk and run are decided by the measurement, and that is a reversal worth recording.** The player's
 * controller used to decide between them from *whether the sprint key was held*, on the argument that the key
 * is the player's intent and that a measured speed dips when a sprint turns a corner. That argument does not
 * survive being shared with a rig, which has no key — and the cost it knowingly accepted (a sprint the server
 * refused, worn as a sprint at walking pace, "running on the spot in the sense that matters") was the
 * animation disagreeing with the server. Speed is the fact both bodies have, so speed is what decides, and
 * the disagreement is gone: a refused sprint now looks like walking, which is what it was.
 *
 * **A body carrying a ball may walk, run or stand exactly as if it were not.** There used to be a fourth
 * parameter here — `throwing`, "this body has a ball and its next act is to throw it" — which stood a rig
 * still in a hold pose while it carried one. It is gone: a ball in a hand is not an animation state, and a
 * rig wearing a hold pose while the player beside it walked normally with a ball was the two bodies
 * disagreeing about the same thing. See `BodyState` for the rule.
 */
export function animationFor(speed: number, grounded: boolean, frozen: boolean): AnimationClip | undefined {
	if (frozen) return undefined;
	if (!grounded) return "jump";

	// At or above the sprint's own line, which is a number about *clips* rather than about speed:
	// see `CHARACTER_CONFIG.RUN_ANIMATION_SPEED` for why it is not simply the base walk speed.
	if (speed >= CHARACTER_CONFIG.RUN_ANIMATION_SPEED) return "run";

	return speed > STANDING_SPEED ? "walk" : "idle";
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
 * a moment later: the throw at `throwBall` (where a ball leaves a hand) and the catch at `catchBall` (where
 * one arrives in it). Neither is a state a body is *in* for a while, which is why they are not conditions
 * with attributes republished on change (that is what `NPC_ANIM_*` is for) and why they have to be read as
 * "is this happening right now".
 */
export type BodyAction = "throw" | "catch";

/**
 * Everything a body's clip is decided from, in one value.
 *
 * **The seam between the two machines, and the reason this is a value rather than a set of parameters.** Who
 * *knows* these facts differs between the bodies — a rig's are published by the server and read off the rig,
 * a player's own body is measured by the client that owns it — and who *decides* from them must not. So the
 * facts are gathered by the caller and handed over, and this module stays a pure function of them: no
 * `Humanoid`, no `Players`, no attribute read, nothing that would make one body's answer depend on which
 * machine was asking.
 */
export interface BodyState {
	/** Ground speed in studs per second — the measurement `animationFor` bands. */
	readonly speed: number;

	/** Whether the body is standing on something. Off the ground outranks everything but an event. */
	readonly grounded: boolean;

	/** Whether the body is held. Only a rig publishes this: a player's freeze arrives as no speed at all. */
	readonly frozen: boolean;

	/** The direction of a dash in flight, or nothing. Outranks every state below it. */
	readonly dodge: DodgeDirection | undefined;

	/** A throw or a catch happening **now**, or nothing. Outranks every state below it. */
	readonly action: BodyAction | undefined;
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
 * catch — see `BallService.catchBall`, which drops a standing throw mark the moment a catch is confirmed, so
 * that the *newer* action is the one that owns the limbs in the case that can actually be arranged.
 *
 * **`holding` is deliberately not a member of {@link BodyState}.** A ball in a hand is not an animation
 * state: a rig holding one is standing still and waiting to throw, a player carrying one is usually running,
 * and a pose that changed for it would be the rig and the player disagreeing about what carrying a ball looks
 * like — which is the complaint this unification is answering. The `holdBallIdle` row stays in the table for
 * the day that changes; nothing reaches it today.
 */
export function bodyClipFor(state: BodyState): AnimationState {
	if (state.action === "throw") return "throw";
	if (state.dodge !== undefined) return DODGE_STATES[state.dodge];

	if (state.action === "catch") return "catch";

	return animationFor(state.speed, state.grounded, state.frozen) ?? RESTING_STATE;
}
