import { CHARACTER_CONFIG } from "./config/character.config";

/**
 * The state a body is in, turned into the clip it should wear.
 *
 * **One decision, shared by the two machines that have to make it**, and that is the whole of the
 * reason this module exists:
 *
 *   - the **local player's controller**, which has a `Humanoid`, a camera and a sprint key, and
 *     dresses the body this client owns;
 *   - a **client renderer for NPC rigs**, which has none of those things — a rig is a server-owned
 *     model whose owner is somewhere else — and dresses it from the state the server publishes
 *     (see `RigAnimationController`).
 *
 * **Pure, therefore usable by both.** It takes numbers and booleans and returns a name. There is no
 * `Players`, no `RunService`, no `Humanoid` and no read of anything on this machine: every fact it
 * needs is handed to it by a caller that already had it. That is what a version taking a `Humanoid`
 * would give up — it would fit the player's side only, and the rig's side would need a second copy,
 * and the second copy is where two answers to "which clip is walking" start to drift apart.
 *
 * **A name rather than an id, and the resolution is `clipFor`'s.** Every clip here is two ids, one
 * per rig type, and which pair applies is a fact about the *body* rather than about the state — so
 * it is answered where the body is, by `clipFor`, and never threaded through this decision. The
 * names are Roblox's own set names (`idle`, `walk`, `run`, `jump`), which is not a coincidence:
 * they are also what the player's `Animate` script looks its sets up by, so the same four words are
 * the vocabulary on both sides of this function.
 */

/** A clip a locomotion state can name. Roblox's own set names, see the file comment. */
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
 * The clip a body in this state should wear, or `undefined` for "no locomotion clip".
 *
 * **`undefined` means the same thing on both sides and is answered differently by each**, which is
 * worth stating because it is the one place the two callers diverge:
 *
 *   - the **player's controller** takes it as "not mine to decide" and leaves the body to Roblox's
 *     `Animate` script, which is already playing the right idle or jump clip;
 *   - the **rig renderer** takes it as "wear the standing clip", because a rig has no script to
 *     defer to — a rig with nothing playing is a rig in its bind pose, which is not a pose any
 *     state in this game has.
 *
 * **Frozen outranks everything.** A held body is not walking, not falling and not standing: it is
 * being held, and the honest answer for the legs of a body that cannot choose where it goes is to
 * stop playing one. For the player this never triggers — the player's own freeze is a walk-speed
 * key and an anchored root, which arrive here as "no speed and no ground" — so it exists for rigs,
 * where a freeze is a fact only the server holds.
 *
 * **Off the ground outranks the arms.** A body in the air wears the jump clip whether it is holding
 * a ball or not, because the alternative is a falling body whose legs are standing still — the one
 * combination nothing else in this project can produce.
 *
 * **A body whose arms are busy stands.** `throwing` is "this body is holding a ball, and its next
 * act is to throw it" — which is what a rig with a ball in hand is *always* about to do, and what a
 * player is never: a player carries a ball while running, and its charge is an input this module
 * has no business knowing about (see the file comment on what is player-only). So for a player the
 * flag is passed as `false`, always, and for a rig the publisher passes what `BallService` already
 * knows. The legs of a body about to throw are the standing clip, which is also what the rig's
 * movement agrees with: `SeekBehavior` stops walking the moment a ball is in hand.
 *
 * **Walk and run are decided by the measurement, and that is a reversal worth recording.** The
 * player's controller used to decide between them from *whether the sprint key was held*, on the
 * argument that the key is the player's intent and that a measured speed dips when a sprint turns a
 * corner. That argument does not survive being shared with a rig, which has no key — and the cost
 * it knowingly accepted (a sprint the server refused, worn as a sprint at walking pace, "running on
 * the spot in the sense that matters") was the animation disagreeing with the server. Speed is the
 * fact both bodies have, so speed is what decides, and the disagreement is gone: a refused sprint
 * now looks like walking, which is what it was.
 */
export function animationFor(
	speed: number,
	grounded: boolean,
	frozen: boolean,
	throwing: boolean,
): AnimationClip | undefined {
	if (frozen) return undefined;
	if (!grounded) return "jump";
	if (throwing) return "idle";

	// At or above the sprint's own line, which is a number about *clips* rather than about speed:
	// see `CHARACTER_CONFIG.RUN_ANIMATION_SPEED` for why it is not simply the base walk speed.
	if (speed >= CHARACTER_CONFIG.RUN_ANIMATION_SPEED) return "run";

	return speed > STANDING_SPEED ? "walk" : "idle";
}

/**
 * Which two config ids each clip is read from.
 *
 * **One table rather than a `switch`, because the two callers both need every row.** The player's
 * controller needs all four — it hands them to the `Animate` script as sets *and* plays two of them
 * itself — and the rig renderer needs all four as well. A table is also what stops an id being
 * written out a second time anywhere: `clipFor` is the only reader, and `CHARACTER_CONFIG` is the
 * only place an id is spelled.
 */
const CLIP_IDS: Record<AnimationClip, { r6: string; r15: string }> = {
	idle: { r6: CHARACTER_CONFIG.IDLE_ANIMATION_R6, r15: CHARACTER_CONFIG.IDLE_ANIMATION_R15 },
	walk: { r6: CHARACTER_CONFIG.WALK_ANIMATION_R6, r15: CHARACTER_CONFIG.WALK_ANIMATION_R15 },
	run: { r6: CHARACTER_CONFIG.RUN_ANIMATION_R6, r15: CHARACTER_CONFIG.RUN_ANIMATION_R15 },
	jump: { r6: CHARACTER_CONFIG.JUMP_ANIMATION_R6, r15: CHARACTER_CONFIG.JUMP_ANIMATION_R15 },
};

/**
 * The id this game has for `clip` on a body of this rig, or `""` where it has none.
 *
 * **An empty id is the off switch and a legitimate answer** — the config holds blanks for the two
 * sets only one rig type was rendered for, and a caller is expected to leave that clip alone rather
 * than to play something almost right. See `CHARACTER_CONFIG`: an R6 body keeps Roblox's standing
 * and jumping animations and wears this game's walk and sprint.
 *
 * **Rig type is a parameter rather than a read**, for the file's reason turned around: this function
 * is the half of the decision that *is* about the body, so it is the half that takes the body's
 * facts as arguments. `Humanoid.RigType` is read by the caller that has one, and it is the same
 * read on both sides — an R6 clip never loads onto an R15 rig, and the reverse.
 *
 * It lived in `LocomotionAnimationController` as a private function until rigs needed it. The move
 * is the point: two copies of this lookup would be two answers to "which animation is the walk",
 * and the bug that comes out of that is one body dressed with two different clips depending on
 * which reader got there first.
 */
export function clipFor(clip: AnimationClip, isR15: boolean): string {
	const ids = CLIP_IDS[clip];
	return isR15 ? ids.r15 : ids.r6;
}
