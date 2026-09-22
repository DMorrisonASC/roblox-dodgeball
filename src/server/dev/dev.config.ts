/**
 * The dev whitelist, and the flags a dev starts with.
 *
 * Committed to the repo on purpose: it is visible in source and nowhere else. It
 * is read on the server, the list is never logged, and nothing about it reaches a
 * client — there is no remote that could carry it, and the flags a client might
 * care about live on the `Player` as plain attributes.
 *
 * Editing `userIds` here is the only change needed to change who is a dev.
 */
export const DEV_CONFIG = {
	/** Fill in by hand. Empty means nobody is a dev. */
	userIds: [41354175] as number[],

	/**
	 * What each flag is set to when a dev joins.
	 *
	 * Only the starting value — `!dev <flag> <on|off>` changes any of them at
	 * runtime, and a flag added here is one the command learns about by itself.
	 */
	defaultFlags: {
		InfiniteBalls: false,
		InfiniteCatch: false,
		NoCooldown: false,
	},
};
