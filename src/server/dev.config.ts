/**
 * The dev harness's configuration.
 *
 * One committed file, edited in place: put your UserId in `userIds` and Studio
 * marks you a dev on join. There is deliberately no separate local file to keep
 * in sync — a Roblox UserId is not a secret, and what actually stops this being a
 * cheat is {@link DevConfig.allowInLiveServers}.
 */

/** Every flag the harness knows about. A flag is a key here and nothing else. */
export interface DevFlags {
	InfiniteBalls: boolean;
	NoCooldown: boolean;
	Invincible: boolean;
	InfiniteCatch: boolean;
}

export interface DevConfig {
	/** The UserIds allowed to be devs. Empty means nobody, which is the default. */
	userIds: number[];

	/**
	 * Whether the whitelist is honoured outside Studio.
	 *
	 * False means a live server ignores `userIds` entirely — a committed UserId
	 * cannot turn into a cheat by being deployed.
	 */
	allowInLiveServers: boolean;

	/** What each flag starts as when a dev joins. */
	defaultFlags: DevFlags;
}

/**
 * What the harness runs on.
 *
 * Everything off and nobody whitelisted, so the file as committed does nothing
 * until a UserId goes in. Flags do not need it changed either: `/dev <flag>
 * <on|off>` switches them at runtime, and this is only where they *start*.
 */
export const DEV_CONFIG: DevConfig = {
	userIds: [41354175],
	allowInLiveServers: false,
	defaultFlags: {
		InfiniteBalls: false,
		NoCooldown: false,
		Invincible: false,
		InfiniteCatch: false,
	},
};
