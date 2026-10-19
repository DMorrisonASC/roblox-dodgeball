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

/**
 * Marks a model as managed by `NpcService`. The entry point, not a behavior.
 *
 * **Declared in `shared/constants.ts` and re-exported here, since the tag became something a client
 * reads too** — the rig animation renderer finds the rigs it dresses by it, and a client cannot
 * require a module that lives under `src/server`. This file stays the name every server reader already
 * imports it from, so nothing else moved. See that constant for the whole of the argument.
 */
export { NPC_TAG } from "shared/constants";

/** Enables the catching behavior. */
export const BEHAVIOR_CATCHING = "Behavior_Catching";

/** Enables the throwing behavior. */
export const BEHAVIOR_THROWING = "Behavior_Throwing";

/** Enables the pickup behavior. */
export const BEHAVIOR_PICKUP = "Behavior_Pickup";

/**
 * Enables the seeking behavior: the rig walks to the nearest loose ball.
 *
 * **This is the first behavior that moves the rig, and that is the whole of its difference.**
 * The other four act where the rig already stands — catching and throwing at whatever arrives,
 * picking up what is already within `PICKUP_RADIUS`, respawning by placement — so none of them
 * ever had to ask whether a ball was reachable. A destination brings that question with it, and
 * the cheap ways to answer it do not work here, so the walk is bounded instead. See `SeekBehavior`,
 * which owns that decision and states what it costs.
 *
 * **It fetches; it does not take.** A rig wearing this and not `BEHAVIOR_PICKUP` walks to a ball
 * and then stands next to it, which is the correct reading of two tags that each mean one thing —
 * the walk is this tag, the hand is that one. The pair is what produces a rig that collects.
 */
export const BEHAVIOR_SEEKING = "Behavior_Seeking";

/**
 * Enables the dodging behavior: the rig steps out of the way of a ball that is going to hit it.
 *
 * **The only behavior here that reacts to something outside the rig**, and the only one with a
 * chance in it. The other five ask a service to do something the rig wants; this one asks for
 * something a ball has made urgent. It is chance-based on purpose — a rig that always dodged would
 * be untouchable, in a game about hitting people with a ball — and see `DodgeBehavior` for the chance
 * itself, which is rolled **once per ball** aimed at the rig, and for the conditions that can refuse a
 * dodge the rig has already decided to make.
 *
 * **It composes with the rest by not touching them.** A dodge is a two-tenths-of-a-second override
 * of where the body is going, and a rig that is also seeking walks on from wherever the dash left
 * it, because `DodgeService` restores the humanoid and the walk target was never changed. A rig that
 * is *catching* is a different matter, and it is the existing gate rather than a new one: an open
 * catch window refuses a dodge outright, so a rig wearing both tags is a catcher that never dodges.
 */
export const BEHAVIOR_DODGING = "Behavior_Dodging";

/**
 * Enables the respawn behavior: the rig gets up again after it is killed.
 *
 * The one behavior here that is not a mechanic of the *game* — a rig has no round to
 * come back into and no `RoundService` to decide whether it should, so this is what a
 * test rig gets instead. See `RespawnBehavior`.
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
