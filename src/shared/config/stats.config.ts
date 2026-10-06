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

	/**
	 * The crown, drawn above the head of a player who is hot.
	 *
	 * **An image and never an emoji glyph.** The same sigil as a character would render differently on
	 * every platform and as a hollow box on some of them, and a box above a player's head is worse than
	 * nothing at all — so this is an upload, and the whole of the crown's look is these four numbers.
	 *
	 * **Its own offset from the billboard's, because the two can be up at once.** A crowned player with a
	 * record to show wears both, and they are different sizes: the crown sits above the line of text
	 * rather than inside it.
	 *
	 * The reach is the billboard's number as a starting point rather than a shared constant, because the
	 * two are answers to the same question — how far away is a label worth drawing — asked about objects
	 * of different sizes. See `BILLBOARD_MAX_DISTANCE`.
	 */
	CROWN_IMAGE: "rbxassetid://109209442459081",

	/** How big the crown is drawn, in pixels. **Placeholder.** Scaled to fit rather than stretched. */
	CROWN_SIZE: UDim2.fromOffset(40, 40),

	/** How far above a head the crown floats, in studs. **Placeholder** — above the billboard's. */
	CROWN_OFFSET_Y: 4.5,

	/** How far the crown is drawn, in studs. **Placeholder** — see the note above. */
	CROWN_MAX_DISTANCE: 100,
} as const;