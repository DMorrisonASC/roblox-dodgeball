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

/** Enables the pickup behavior. */
export const BEHAVIOR_PICKUP = "Behavior_Pickup";

/**
 * Enables the respawn behavior: the rig gets up again after it is killed.
 *
 * The one behavior here that is not a mechanic of the *game* — a player is
 * respawned by the engine and an NPC has no such thing, so this is what a test
 * rig gets instead. See `RespawnBehavior`.
 */
export const BEHAVIOR_RESPAWN = "Behavior_Respawn";

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

	/**
	 * Optional: this model's humanoid has died.
	 *
	 * The one event a behavior cannot see for itself. A behavior is only ever run
	 * while its NPC is alive — the interval it is asked on stops when the health
	 * does — so a behavior that has something to do *about* a death has to be told
	 * about it from outside.
	 *
	 * Every behavior the model still wears is told, not only the one that has a use
	 * for it: a death is a fact about the model, and what to make of it is the
	 * hook's business.
	 *
	 * Called only when the health ran out. An NPC that stopped for any other reason
	 * — its tag was taken off, or it left the world — is being switched off rather
	 * than interrupted, and there is nothing for a behavior to react to.
	 *
	 * The loop that ran the behaviors has already finished by the time this is
	 * called, so a behavior that brings the model back has to see that a *new* loop
	 * starts. See `RespawnBehavior`, which does it by putting the model's tags back
	 * on a new rig — the same arrival `NpcService` already watches for.
	 *
	 * A method for the same reason `tick` is.
	 */
	onDied?(model: Model): void;
}
