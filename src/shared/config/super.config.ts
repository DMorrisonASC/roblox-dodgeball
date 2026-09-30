/**
 * The numbers behind the charged abilities.
 *
 * A config file rather than constants inside `SuperService`, for the reason every other config
 * exists: the mechanic is a handful of numbers, they are the part that gets tuned, and they belong
 * where tuning is one edit rather than a hunt through a service. It is also the file a designer can
 * read to find out what the rule is without following `Map`s and `Set`s.
 */
export const SUPER_CONFIG = {
	/**
	 * Hits in a row that earn one charge.
	 *
	 * **Placeholder.** Six is a first guess at "a long enough run to feel earned" rather than a
	 * measured number, and it is the one to move when a charge turns out to arrive too often or too
	 * rarely. Nothing else has to change with it: the streak counts up to this, the charge is granted
	 * at it, and the HUD reads it as the denominator of its readout rather than carrying its own copy.
	 *
	 * What it is not is a limit on how many charges can be earned over a round. A charge is spent or
	 * forfeited and the streak starts again, so six more hits earn the next one — this number is the
	 * length of a run, not a budget.
	 */
	STREAK_REQUIRED: 6,
} as const;
