import type { DodgeDirection } from "../dodge";

/**
 * Everything about the dodge: how far it goes, how long it takes, and how often it
 * can be used.
 *
 * **One type-only import, and it is the direction vocabulary** — the four words a dodge is named by,
 * which `shared/dodge.ts` owns and this file keys its clip table by. Nothing else is imported, and
 * nothing here reads another config: the distances and clocks below are numbers, and the clip ids are
 * strings.
 *
 * **Read by `DodgeService` and, through the rig clip table, by the rig renderer.** That second reader is
 * newer than the first, and it is why the ids below moved here: a dodge clip is played by two different
 * machines for two different kinds of body — a player's flourish is started by the server, a rig's clip is
 * played by each client from the published direction — and both of them must be looking at one table.
 * See `BODY_ANIMATION`, which borrows these four rows the way it borrows walk and run from
 * `CHARACTER_CONFIG`.
 *
 * The server never sees a key press, and there is no client-side timing to configure here: a dodge is a
 * movement key plus a right-click, which is a combination rather than a rhythm, so nothing left in this
 * file is measured in taps.
 *
 * **`DOUBLE_TAP_WINDOW` and `GESTURE_WINDOW_MS` used to live here and are deleted
 * rather than left standing.** They were the whole of the old binding — how long a
 * second tap had to follow the first, and how long two keys landing together still
 * counted as one press — and when the binding became a combination the only reader
 * of either one went away. A config value with no reader is a value that lies about
 * what the game does, so they are gone.
 */
export const DODGE_CONFIG = {
	/**
	 * How far a dodge moves the model, in studs.
	 *
	 * Applied by the server, which is the only machine that can move a model; the
	 * client only says *which way*, because it is the only machine that can see the
	 * keys. So this is the one place the size of a dodge is decided.
	 *
	 * Read together with {@link DODGE_CONFIG.DURATION}: a dodge is specified as a
	 * distance covered in a time, because the distance is the thing you can see on
	 * the field and a speed is not. The speed the physics is actually handed is
	 * derived from the pair — see {@link DODGE_SPEED}.
	 */
	DISTANCE: 15,

	/**
	 * How long a dodge takes, in seconds.
	 *
	 * Read with {@link DODGE_CONFIG.DISTANCE}: the distance is what the move is
	 * measured by, so this sets how *fast* the dash covers it rather than how far it
	 * goes. Long enough to read as a committed step, short enough that nothing can
	 * steer through it.
	 */
	DURATION: 0.2,

	/** How long a model must wait before it can dodge again, in seconds. */
	COOLDOWN: 1.5,

	/**
	 * The four dodge clips live below this object, as {@link DODGE_ANIMATION}, rather than in here — the
	 * reason is mechanical and worth one line: this object is `as const`, so a member of it cannot carry a
	 * `Record<…>` annotation, and the table wants one so that a missing direction is a compile error.
	 */
} as const;

/**
 * The four dodge clips, per rig type — **one table for every body that dodges.**
 *
 * **A dodge is the same move whoever takes it, so it is the same four clips.** These are worn by a
 * player's character and by an NPC rig, and the two paths differ only in *who plays them*: a player's
 * flourish is started by `DodgeService` on the server (so the other players see it — a client-started
 * track would be that client's private flourish), and a rig's clip is played by every client that can
 * see the rig, from the direction the server publishes. Both read the id from here, which is what makes
 * "swap the dodge clip" one edit.
 *
 * **The R6 column was authored "for all models"**, which is the animation editor's own phrase for an R6
 * export, and that is why one table covers a player and a placeholder alike. It says nothing about which
 * *body* wears which column: that is `Humanoid.RigType`, and an R6 clip never loads onto an R15 rig — so
 * the wrong column is a dodge that silently plays nothing rather than one that looks slightly off.
 *
 * **Keyed by direction, and the direction is `shared/dodge.ts`'s four words.** Which word a heading gets
 * is `dodgeDirectionOf`, which is also where the frame those words are measured in is argued; a fifth
 * direction would be a compile error here rather than a dodge that quietly plays nothing.
 *
 * **An empty id is the *off* switch**, as it is for every clip in this codebase: the reader leaves the
 * body alone and says so rather than playing something almost right. No row below is empty, and one that
 * becomes empty is a fault rather than a state — `DodgeService` warns about it with the direction and the
 * rig type, because a dodge with no clip looks exactly like a code bug.
 */
export const DODGE_ANIMATION: {
	readonly R6: Record<DodgeDirection, string>;
	readonly R15: Record<DodgeDirection, string>;
} = {
	R6: {
		forward: "rbxassetid://105768755953870",
		backward: "rbxassetid://117214883548929",
		left: "rbxassetid://78281915750764",
		right: "rbxassetid://94964163326879",
	},

	R15: {
		forward: "rbxassetid://102865243606683",
		backward: "rbxassetid://80267851274003",
		left: "rbxassetid://107415624086531",
		right: "rbxassetid://129772201965757",
	},
};

/**
 * Speed the dash is driven at, in studs per second.
 *
 * Derived, not tuned: {@link DODGE_CONFIG.DISTANCE} over
 * {@link DODGE_CONFIG.DURATION}. Change either of those and this follows, which is
 * why the figure is never written by hand.
 *
 * It is a velocity because it is applied as one — a `LinearVelocity` constraint on
 * the root part, held for the duration and then destroyed — rather than a `PivotTo`
 * that puts the model somewhere new in a single step. A model that has been *moved*
 * is still trying to walk wherever the humanoid was taking it and walks back; a
 * model that is *moving* has nothing to walk back from.
 */
export const DODGE_SPEED = DODGE_CONFIG.DISTANCE / DODGE_CONFIG.DURATION;
