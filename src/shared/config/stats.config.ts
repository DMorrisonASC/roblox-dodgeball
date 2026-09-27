/**
 * The lifetime throw record: where it is kept, and how it is shown.
 *
 * Read by `StatsService` for the store and the autosave, and by the client's stats billboard for the
 * two figures that decide how it is drawn. Shared rather than server-only because the billboard's
 * reach and offset are the game's look rather than one machine's business.
 */
export const STATS_CONFIG = {
	/**
	 * The DataStore the records live in, keyed by `tostring(player.UserId)`.
	 *
	 * One store rather than a versioned name, because the shape of a record is two numbers and a
	 * change to it is a change this file and `StatsService` make together. A rename here starts
	 * everybody from nothing, which is the honest way to change a record that has been outgrown.
	 */
	DATASTORE_NAME: "PlayerStats",

	/**
	 * How often every player with something new is written out, in seconds.
	 *
	 * **Not the answer to a shutdown — `BindToClose` is — but the answer to a crash**, which
	 * `BindToClose` never runs for. Three minutes is chosen against the write budget rather than the
	 * clock: the sweep skips anybody who has not thrown since the last one, so this is a floor on how
	 * often a *changed* record is written, not a rate of writes.
	 */
	AUTOSAVE_INTERVAL: 180,

	/**
	 * How far a stat billboard is drawn, in studs.
	 *
	 * The figures above every head are only worth drawing for people near enough to be in the round
	 * with you — and a billboard is drawn per viewer, so this is what keeps a full server's worth of
	 * labels from being built by every client for a lobby they cannot read.
	 */
	BILLBOARD_MAX_DISTANCE: 100,

	/** How far above a head the billboard floats, in studs. Clear of the head and of a tall hat. */
	BILLBOARD_OFFSET_Y: 2.5,
} as const;