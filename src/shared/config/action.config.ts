/**
 * The two actions that cannot be taken at the same time, and how long the one that
 * has just finished keeps the other shut.
 *
 * Imports nothing. It is a file of its own rather than an entry in
 * `dodge.config.ts` or `catch.config.ts` because it belongs to neither: what it
 * describes is the *pair*, and the value has to be the same in both directions or
 * the two rules would disagree about who is allowed to act.
 */
export const ACTION_CONFIG = {
	/**
	 * How long after one action ends the other stays shut, in seconds.
	 *
	 * One value, read by both services — `DodgeService` applies it to a catch that has
	 * just closed, `CatchService` to a dodge that has just ended.
	 *
	 * Measured from the moment the first action **ended**, never from when it started:
	 * a dash and a catch window are different lengths, so a lockout timed from the
	 * start would be shorter than this for one of them and longer for the other.
	 *
	 * Deliberately short — long enough that a player cannot dodge out of a catch they
	 * have already committed to, or catch a ball they have just dodged past, and short
	 * enough that it never reads as a cooldown of its own. Nothing about it changes
	 * either action; it only decides the moment each one may begin.
	 */
	ACTION_LOCKOUT_SECONDS: 0.5,
} as const;
