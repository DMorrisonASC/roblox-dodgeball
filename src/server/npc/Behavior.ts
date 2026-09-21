/**
 * What an NPC behavior is, and the tags that switch one on.
 *
 * A behavior is a **thin caller**: it decides *when* to act and asks a service
 * to do it. Cooldowns, windows and every other timing rule stay in the service
 * that owns them, so an NPC obeys exactly the rules a player does and the two
 * cannot drift apart.
 *
 * Behaviors compose by tagging, so a model wearing `NPC` and two behavior tags
 * runs both. Adding a mechanic is therefore one new file plus one entry in
 * `NpcService`'s registry — nothing else in the system knows what a behavior
 * does, so nothing else has to change.
 */

/** Marks a model as managed by `NpcService`. The entry point, not a behavior. */
export const NPC_TAG = "NPC";

/** Enables the catching behavior. */
export const BEHAVIOR_CATCHING = "Behavior_Catching";

/** Enables the throwing behavior. */
export const BEHAVIOR_THROWING = "Behavior_Throwing";

/**
 * One thing an NPC can do, asked to do it on a timer.
 *
 * The behavior's own `tag` is the tag that enables it, rather than a separate
 * registry key: one tag turns on one behavior, and that holds whether the tag
 * was put there by hand in Studio's Tag Editor or by `NpcService.spawn`.
 */
export interface NpcBehavior {
	/** The tag that enables this behavior on a model. */
	readonly tag: string;

	/**
	 * How often `tick` wants to be called, in seconds.
	 *
	 * A *request*, not a promise. `NpcService` runs one loop per NPC at the
	 * fastest interval any behavior asked for, and each behavior is then gated on
	 * its own interval — so this is honoured per behavior even though the loop
	 * that drives them is shared.
	 */
	readonly tickInterval: number;

	/**
	 * Do the thing, if it can be done at all.
	 *
	 * Declared as a **method** rather than a function property, which means an
	 * implementation has to be written as a method too: an object literal using
	 * `tick: () => ...` is rejected with "Attempted to assign non-method where
	 * method was expected", and `rbxtsc` is the only thing that reports it.
	 */
	tick(model: Model, humanoid: Humanoid): void;

	/**
	 * Optional: collect whatever this behavior needs before it can run at all.
	 *
	 * Called once per behavior, the first time this model is seen wearing its tag
	 * and **before** that behavior's first tick. This is where a behavior that needs
	 * something in hand asks for it — `ThrowBehavior` asks `BallService` for a ball
	 * here — which is what keeps `NpcService` from having to know that throwing
	 * wants a ball, or that balls exist.
	 *
	 * It also keeps the *rig* free of the answer: a second throwing mechanic writes
	 * the same three lines in its own file, and neither `NpcService` nor `spawn`
	 * changes. A behavior that needs nothing simply does not write this, which is
	 * why it is optional.
	 *
	 * A method for the same reason `tick` is.
	 */
	prepare?(model: Model): void;
}
