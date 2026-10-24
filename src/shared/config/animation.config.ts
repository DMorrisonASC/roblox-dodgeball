import { BALL_CONFIG } from "./ball.config";
import { CATCH_CONFIG } from "./catch.config";
import { CHARACTER_CONFIG } from "./character.config";
import { DODGE_ANIMATION } from "./dodge.config";
import { DUCK_CONFIG } from "./duck.config";

/**
 * **Every state this game owns an animation for, and the clip each rig type wears in it — for *every* body
 * in the game, a player and a rig alike.**
 *
 * **This was `rigAnimation.config.ts` and it was the rigs' table. It is neither any more.** A player's body
 * and a rig draw from this one vocabulary through one mechanism, and the body is the only difference between
 * them — so a file named for one body, read by the other, would be a name that keeps the two apart in the
 * head of everybody who reads it. The rule, in one line: **a player and a rig play the same clip for the same
 * state.**
 *
 * **Nothing here is spelled twice.** `idle`, `walk`, `run` and `jump` are borrowed from `CHARACTER_CONFIG`,
 * which owns them because they are also the four names Roblox's `Animate` script looks its own sets up by;
 * `throw` and `catch` are borrowed from the configs that own those motions; the four dodges from
 * `dodge.config.ts`. One row per state, one id per row: a body cannot wear a different animation from the
 * body beside it for the same thing, because there is only one string for the two of them to wear.
 *
 * **Two columns, because a clip is authored for a rig type.** An R6 animation does not load onto an R15 rig
 * and the reverse, and the engine says so rather than approximating — the id resolves to nothing and the body
 * plays no clip at all. Which column applies is a fact about the *body* (`Humanoid.RigType`) and is answered
 * in exactly one place, `shared/animation.ts`'s `clipIdFor`.
 *
 * **No row is empty.** An empty id is the off switch, and a state that is off for one rig type is a body left
 * in its bind pose rather than one wearing something nearly right — a fault and not a state, which is why the
 * rows were filled in and why this is stated rather than left to be noticed.
 *
 * **What this file is not:** not the decision (that is `shared/animation.ts`), not the renderer (that is
 * `client/controllers/character/BodyAnimator.ts`), and not a statement about who publishes a state's facts —
 * a rig's arrive from the server, and a player's own body is asked directly by the client that owns it. Three
 * separate questions, and the table answers none of them.
 */

/**
 * A state the game can dress a body in, as the code names it.
 *
 * **The whole vocabulary, and the states it does not name are the answer to "what Roblox still supplies".**
 * Fall, swim, climb, sit, the emotes and the tool animations are Roblox's `Animate` script's and are left
 * exactly as it made them: a player keeps that script's sets for them, and a rig — which has no script — is
 * never in one of them, because nothing in this game puts a rig in the air, in water or in a seat.
 *
 * **The four locomotion words are Roblox's own set names**, not this project's choice: `idle`, `walk`, `run`
 * and `jump` are what its animation script looks its sets up by, so the shared decision can name them and both
 * the script and this game's renderer understand the answer.
 *
 * **`holdBallIdle` is the user's `idle-throw` / `hold-ball-idle` under one name, and it is a rig's state.**
 * The fact behind it is `NPC_ANIM_THROWING_ATTRIBUTE`, which only a rig publishes: a rig holding a ball is
 * standing still and about to throw, while a player carrying one is usually running. **No clip is layered for
 * it** — a body in this state wears one clip, exactly like every other state in this table, and that is now true
 * of every state without exception. There was briefly a table here for an upper-body-only clip to draw over a
 * walk, and it was removed when the decision was made not to author one: **one track per state is the pipeline**,
 * on both bodies. See `client/bodyAnimation.ts` for the renderer that holds exactly that.
 *
 * **`throw`, `catch` and the four dodges are events**, not conditions: facts written at the moment they happen
 * and cleared shortly after, so a one-shot clip has a window to play in. The throw's mark is written by
 * `BallService.throwBall` and the catch's by `BallService.catchBall` — each the single funnel a player's
 * remote and a rig's behaviour both arrive through, so each is written **for every body that throws or
 * catches**. A dash publishes its direction for its own length (`DodgeService`), which is the same shape with
 * a direction in it.
 *
 * **`duck` is the one state with no consumer**, marked `**Placeholder.**` at its row: nothing publishes a
 * fact that means it, so nothing plays it. A rig does not press a key, so the state would have to come from
 * the AI — a behaviour and a flag that do not exist — and a player's duck would need its own input and a state
 * the body could wear. A second decision, and not this one.
 */
export type AnimationState =
	| "idle"
	| "walk"
	| "run"
	| "jump"
	| "holdBallIdle"
	| "throw"
	| "catch"
	| "duck"
	| "forwardDodge"
	| "backwardDodge"
	| "leftDodge"
	| "rightDodge";

/**
 * Every clip, by state and by rig type — **the one table both bodies are dressed from.**
 *
 * **Read through `clipIdFor`, never indexed directly.** One reader is the whole point: the rig type has to be
 * turned into the right column in exactly one place, or the two places that do it will one day disagree, and
 * the failure of that disagreement is a clip that silently does not load on one body and not the other.
 *
 * **An empty id is the *off* switch, and a caller that reads one leaves the clip alone** rather than playing
 * something almost right. No row below is empty — see the file comment.
 *
 * **The dodge rows are borrowed from `dodge.config.ts` for the same reason the locomotion rows are borrowed
 * from `CHARACTER_CONFIG`'s**: a dodge is the same move whoever takes it, and both bodies are drawn from this
 * one row set — a player's body by the client that owns it, a rig by every client that can see it.
 *
 * **Every id is `rbxassetid://`-prefixed, and a bare number is not the same thing.** The loader treats a
 * bare number as an animation *name* and finds nothing, which is the trap `dodge.config.ts` records at
 * length. A typo here is silent in the same way: the clip does not load, the body keeps whatever it was
 * wearing, and the symptom looks like a code fault rather than a string one.
 */
export const BODY_ANIMATION: {
	readonly R6: Record<AnimationState, string>;
	readonly R15: Record<AnimationState, string>;
} = {
	R6: {
		idle: CHARACTER_CONFIG.IDLE_ANIMATION_R6,
		walk: CHARACTER_CONFIG.WALK_ANIMATION_R6,
		run: CHARACTER_CONFIG.RUN_ANIMATION_R6,
		jump: CHARACTER_CONFIG.JUMP_ANIMATION_R6,
		holdBallIdle: "rbxassetid://133309984794937",
		throw: BALL_CONFIG.THROW_ANIMATION_R6,
		catch: CATCH_CONFIG.CATCH_ANIMATION_R6,
		duck: "rbxassetid://73323184243118", // **Placeholder.** No consumer; see the states block above.
		forwardDodge: DODGE_ANIMATION.R6.forward,
		backwardDodge: DODGE_ANIMATION.R6.backward,
		leftDodge: DODGE_ANIMATION.R6.left,
		rightDodge: DODGE_ANIMATION.R6.right,
	},

	R15: {
		idle: CHARACTER_CONFIG.IDLE_ANIMATION_R15,
		walk: CHARACTER_CONFIG.WALK_ANIMATION_R15,
		run: CHARACTER_CONFIG.RUN_ANIMATION_R15,
		jump: CHARACTER_CONFIG.JUMP_ANIMATION_R15,
		holdBallIdle: "rbxassetid://110150965056824",
		throw: BALL_CONFIG.THROW_ANIMATION_R15,
		catch: CATCH_CONFIG.CATCH_ANIMATION_R15,
		duck: "rbxassetid://99124458758551", // **Placeholder.** No consumer; see the states block above.
		forwardDodge: DODGE_ANIMATION.R15.forward,
		backwardDodge: DODGE_ANIMATION.R15.backward,
		leftDodge: DODGE_ANIMATION.R15.left,
		rightDodge: DODGE_ANIMATION.R15.right,
	},
};

/**
 * The states above that are **cycles**, and therefore the only ones a body loops.
 *
 * **A property of the clip set rather than a per-state flag**, because it is the same question for every
 * state and the answer is not a matter of taste: a body that is walking is doing something it continues
 * to do, and a body that is dodging is doing something it does once. Everything not named here is an
 * *action* — the four dodges, the throw, the catch and the duck — and an action played on a loop is a
 * clip that keeps swinging after the move it describes has finished. Both bodies read this one list: the
 * renderer in `client/controllers/character/BodyAnimator.ts` asks it for `Looped` and for the rung a clip
 * plays on, so a player's walk and a rig's walk loop and fade identically.
 *
 * **`holdBallIdle` is in the list and that is the one entry worth a second read.** The name says "idle",
 * and idle is a cycle: a body holding a ball and waiting is waiting for as long as it waits. A looped
 * one-shot here would be a body that threw a pose and then held it frozen, which is not what "holding a
 * ball" looks like.
 *
 * **The list is not exhaustive over the type, and the three absences are the rule rather than an omission**:
 * `throw`, `catch` and `duck` are actions, so they are not cycles. **All three have a consumer now** — the
 * duck's was the last to arrive, and this sentence used to record that it had none. See the states block
 * above.
 */
export const CYCLE_STATES: ReadonlyArray<AnimationState> = ["idle", "walk", "run", "jump", "holdBallIdle"];

/**
 * The states whose clip is **stretched to fill the state**, and how long that state lasts in seconds.
 *
 * **One entry, and the entry is the duck.** Every other action in this game is drawn the way the codebase
 * has always drawn one: the *state* has a tuned duration — `THROW_ANIMATION_SECONDS`,
 * `CATCH_ANIMATION_SECONDS`, `DODGE_CONFIG.DURATION` — and the clip is whatever the artist authored, so a
 * clip longer than its state is cut when the state ends and a shorter one holds its last frame for the
 * remainder. That trade is argued beside each of those numbers and it is the right one there, because the
 * state is describing a *motion* the game is timing.
 *
 * **A duck is a different kind of thing and the difference is worth being exact about.** What the player
 * sees is not a flourish drawn over a lasting state — it *is* the state: the head and arms are out of a
 * ball's way for exactly `DUCK_CONFIG.DURATION_SECONDS`, so a crouch that finishes early, or is cut half
 * way through, is a body the game says is ducking while it looks like it is standing up. The clip and the
 * state are one fact with two readers, and this table is the sentence that says so.
 *
 * **The stretch is derived and never written down**, exactly as `ThrowController.chargePlaybackSpeed`
 * derives the charge sound's rate from `TimeLength / CHARGE_SECONDS`: a playback speed is
 * `state / track.Length`, so it is right for *any* clip and for any value of the duration, and moving the
 * duration moves the animation with it. A written-down speed would be correct for one pair of numbers and
 * would drift out of step the first time either was tuned — which is the fault this table exists to
 * remove. See `client/bodyAnimation.ts`, which is the one reader.
 *
 * **`Partial`, and that is the rule rather than a shortcut**: a state not named here is drawn the ordinary
 * way, which is every state but one. Adding an entry is how a second clip gets the same treatment — and the
 * thing to check before adding one is whether that action's *state* is owned by the server or by the
 * animation, because the two answers want different shapes.
 */
export const STATE_CLIP_SECONDS: Partial<Record<AnimationState, number>> = {
	duck: DUCK_CONFIG.DURATION_SECONDS,
};

/**
 * **Placeholder — `0.17`.** Where the throw clip is held while a throw is being charged, in seconds.
 *
 * **The cocked pose, and the whole of the feature.** The throw clip is one motion authored straight through:
 * a wind-back, a release, a follow-through. A charged throw in this game is not one motion — it is a hold
 * whose length the player chooses, and then a throw — so the clip is played up to the point where the arm is
 * back (`0.17`), stopped there for as long as the button is down, and released from there at the clip's own
 * speed. See `client/bodyAnimation.ts` for the two functions that do it, and {@link THROW_CLIP_SECONDS} for
 * the length the release needs. **The hold length is the only thing the charge does to the animation**; what
 * the charge *is worth* is shown by the camera while the button is down (`client/cameraShake.ts`).
 *
 * **A number from the animation editor rather than from anything the game measures.** It is the time of one
 * keyframe in one asset, so it moves when the asset is re-cut and nothing here can detect that — the symptom
 * of a stale value is a body that holds a pose somewhere other than the top of the wind-up, which reads
 * immediately wrong and is fixed here.
 */
export const THROW_CHARGE_HOLD_SECONDS = 0.17;

/**
 * **Placeholder — `0.8`.** The authored length of the throw clip, in seconds — the second number the release's
 * arithmetic needs, and the one that has to be written down rather than read.
 *
 * **The client could ask the track**, and does not: `AnimationTrack.Length` is the right answer and only the
 * client has it, but the *server* needs the same number to know how long to keep the body marked as throwing
 * (`BALL_CONFIG.THROW_ANIMATION_SECONDS` is that window, and a clip that outlives its mark is cut off). A
 * remote to tell the server how long to draw an animation would be a second fact crossing the wire for a
 * duration, so the duration lives here where both machines can read it. The cost is this constant going
 * stale if the clip is re-cut without updating it — the same cost `THROW_CHARGE_HOLD_SECONDS` carries, and
 * the same symptom: a throw whose last frames are clipped, or a body that holds a finished pose.
 */
export const THROW_CLIP_SECONDS = 0.8;
