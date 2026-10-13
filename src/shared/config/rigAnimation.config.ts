import { BALL_CONFIG } from "./ball.config";
import { CHARACTER_CONFIG } from "./character.config";
import { DODGE_ANIMATION } from "./dodge.config";

/**
 * The clips this game dresses a **rig** in, per state, per rig type — the NPC half of
 * `CHARACTER_CONFIG`'s animation block.
 *
 * **Two tables rather than one, because a clip is authored for a rig.** An R6 animation does not load
 * onto an R15 rig and the reverse, and the engine says so rather than approximating: the id resolves to
 * nothing and the body plays no clip at all. So every state below is a pair, and which half of the pair
 * applies is a fact about the *body* — `Humanoid.RigType` — rather than about the state. That is the
 * same pair `CHARACTER_CONFIG` keeps for the player's four locomotion sets and `dodge.config.ts` keeps
 * for the dodge flourish, arrived at for the same reason; see {@link RIG_ANIMATION}.
 *
 * **Both rigs in one file, because they are one decision.** A state's R6 clip and its R15 clip are the
 * answer to one question — "what does a body dodging left wear" — and the two answers are only correct
 * *relative to each other*: a rig type whose column is filled in for dodge and empty for duck is a
 * shape nobody can see by reading one of the two tables. Two files would also make the dispatch a
 * decision about imports rather than a lookup by rig type, which is the one thing `rigClipFor` is for.
 *
 * **The R6 ids were authored "for all models"** — that is what the animation editor calls an R6 export
 * — which is why the R6 column here is the one a hand-tagged R6 placeholder and a hand-built R6 prop
 * rig both wear. It says nothing about *players*: a player's clips are `CHARACTER_CONFIG`'s, and the
 * two sets are deliberately separate even where a rig and a player wear the same clip today. See the
 * note on `walk` and `run` below for the one place the two tables touch.
 */

/**
 * A state a rig can be dressed in, as the code names it.
 *
 * **Two vocabularies, not one, and this is the line between them.** `shared/animation.ts` owns the
 * player's four locomotion words — `idle`, `walk`, `run`, `jump` — because those are also the names
 * Roblox's `Animate` script looks its own sets up by, so they are a published interface rather than
 * this project's choice. A rig has no script and no sets: it plays tracks directly, and it has states a
 * player does not have at all (a ball in hand, a dash in flight). So the rig's vocabulary is a
 * superset — the same four words, spelled the same way, so the shared decision still feeds it, plus the
 * states that exist only here.
 *
 * **`holdBallIdle` is the user's `idle-throw` / `hold-ball-idle`, under one name.** That state arrived
 * with two names for one thing, and the code keeps the one that describes it: the flag the server
 * publishes is `NPC_ANIM_THROWING_ATTRIBUTE`, which is "this body is holding a ball and its next act is
 * to throw it" — a *held* pose, not a throw in progress. There is therefore no separate "idle throw"
 * state below, and a reader looking for one should read this name as it.
 *
 * **`throw` and `catch` are the motions, and they are a different shape of state from the rest.**
 * Every other name here is a *condition* the pipeline can read at any instant. A throw and a catch are
 * events — a ball leaving the hand, a window opening for a fraction of a second — so they need a fact
 * that is written *at* the moment and cleared shortly after, rather than one that is true for a while.
 * `throw` has one: `NPC_ANIM_THROW_ATTRIBUTE`, written by `BallService` at the instant the ball leaves
 * the hand and cleared a moment later. `catch` still does not. See {@link RIG_ANIMATION}.
 *
 * **Two of the twelve are configured ahead of a consumer, and they are marked `**Placeholder.**` at
 * their rows below.** `duck` and `catch` have no reader in this build, so nothing plays them: the rig
 * renderer reads the published state for every clip it picks, and no fact published today means either
 * one. What would consume each, in one line apiece:
 *
 *   - `duck` — a **behaviour** that decides when a rig ducks, plus a tag to gate it on, and a published
 *     flag for the renderer to read. A rig does not press a key, so the state has to come from the AI;
 *     neither the behaviour nor the flag exists. (A player's duck would need its own input and a state
 *     the body could wear, which is a second decision and not this one.)
 *   - `catch` — the same shape from `CatchService`: its window is measurable and unread on the client
 *     (the renderer would need a published fact, not the ready-at clock the HUD reads).
 *
 * **The throw *is* wired, and it was the state most obviously missing.** A rig that throws its ball is
 * doing the one thing its whole loop exists for, and it was playing the standing clip through it. The
 * attribute is written where the ball is released — `BallService.throwBall`, the single funnel both a
 * player's click and a rig's behaviour arrive through — so the clip is wired for every body that
 * throws rather than for rigs alone.
 *
 * **The four dodges are *not* placeholders, and that is a change from how they were specified.**
 * `DodgeService` publishes the direction of a dash while one is in flight — see
 * `DODGE_DIRECTION_ATTRIBUTE` — and `RigAnimationController` picks one of the four from it, so these
 * rows have a reader and a value that is actually seen.
 *
 * **The four locomotion rows are borrowed from `CHARACTER_CONFIG` rather than typed out here**, and that
 * is not tidiness: *every* body in the game wears those four clips, a player and a rig alike, so a second
 * copy would be a rig walking with a different animation from the player beside it the moment one of the
 * two was edited. `idle`, `walk`, `run` and `jump` are therefore one source, and `duck`/`dodge`/`throw`
 * below are the states a player has no clip for at all.
 */
export type RigAnimationClip =
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
 * Every rig clip, by state and by rig type.
 *
 * **Read through `rigClipFor`, never indexed directly.** One reader is the whole point: the rig type has
 * to be turned into the right column in exactly one place, or the two places that do it will one day
 * disagree, and the failure of that disagreement is a clip that silently does not load.
 *
 * **An empty id is the *off* switch, which is `CHARACTER_CONFIG`'s convention and is honoured here.** A
 * caller that reads `""` leaves the clip alone rather than playing something almost right. No row below
 * is empty, and that includes the two that used to be: the R6 idle and jump clips were the player's
 * blanks, and an R6 rig standing or jumping was left in its bind pose with nothing to play. The R6 half
 * has been supplied since, in the same table players read — see below.
 *
 * **The four locomotion rows are the player's ids, referenced rather than copied, and that is the point
 * of the table rather than a saving.** `idle`, `walk`, `run` and `jump` are what *every* body in the game
 * wears: a rig and a player standing beside each other are playing the same animation, and there is one
 * string per clip to change. Writing them out again here would be the second copy that makes the two
 * drift, and the drift is invisible until somebody notices two bodies moving differently — which is
 * exactly the complaint this arrangement exists to answer. **The four dodge rows are borrowed from
 * `dodge.config.ts` for the same reason**: a dodge is the same move whoever takes it, and the four clips
 * are played by a player's character (from the server, so everybody sees it) and by a rig (from every
 * client that can see it, off the published direction).
 *
 * **Every id is `rbxassetid://`-prefixed, and a bare number is not the same thing.** The loader treats a
 * bare number as an animation *name* and finds nothing, which is the trap `dodge.config.ts` records at
 * length. A typo here is silent in the same way: the clip does not load, the body keeps whatever it was
 * wearing, and the symptom looks like a code fault rather than a string one.
 */
export const RIG_ANIMATION: {
	readonly R6: Record<RigAnimationClip, string>;
	readonly R15: Record<RigAnimationClip, string>;
} = {
	R6: {
		idle: CHARACTER_CONFIG.IDLE_ANIMATION_R6,
		walk: CHARACTER_CONFIG.WALK_ANIMATION_R6,
		run: CHARACTER_CONFIG.RUN_ANIMATION_R6,
		jump: CHARACTER_CONFIG.JUMP_ANIMATION_R6,
		holdBallIdle: "rbxassetid://133309984794937",
		throw: BALL_CONFIG.THROW_ANIMATION_R6,
		catch: "rbxassetid://112001937610745", // **Placeholder.** No consumer; see the states block above.
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
		catch: "rbxassetid://140155652521630", // **Placeholder.** No consumer; see the states block above.
		duck: "rbxassetid://99124458758551", // **Placeholder.** No consumer; see the states block above.
		forwardDodge: DODGE_ANIMATION.R15.forward,
		backwardDodge: DODGE_ANIMATION.R15.backward,
		leftDodge: DODGE_ANIMATION.R15.left,
		rightDodge: DODGE_ANIMATION.R15.right,
	},
};

/**
 * The states above that are **cycles**, and therefore the only ones a rig loops.
 *
 * **A property of the clip set rather than a per-state flag**, because it is the same question for every
 * state and the answer is not a matter of taste: a body that is walking is doing something it continues
 * to do, and a body that is dodging is doing something it does once. Everything not named here is an
 * *action* — the four dodges, the throw, the catch and the duck — and an action played on a loop is a
 * clip that keeps swinging after the move it describes has finished, which is the exact failure
 * `DodgeService` guards against from the other side by stopping its own flourish when the dash ends.
 *
 * **`holdBallIdle` is in the list and that is the one entry worth a second read.** The name says "idle",
 * and idle is a cycle: a body holding a ball and waiting is waiting for as long as it waits. A looped
 * one-shot here would be a rig that threw a pose and then held it frozen, which is not what "holding a
 * ball" looks like.
 *
 * **The list has to be exhaustive over the type, and it is not: `throw`, `catch` and `duck` are absent
 * and have no consumer yet.** They are actions, so their absence is the correct reading of the rule
 * rather than an omission — see the states block above for which of these are configured ahead of a
 * consumer.
 */
export const LOCOMOTION_CLIPS: ReadonlyArray<RigAnimationClip> = ["idle", "walk", "run", "jump", "holdBallIdle"];
