/**
 * The lifetime throw record: where it is kept and how often it is written.
 *
 * **The presentation half lives with the client now.** `BILLBOARD_OFFSET_Y` and `BILLBOARD_MAX_DISTANCE` were
 * here until 2026-10-27 and moved into `StatsBillboardController` when the only thing left above a head was the
 * badge strip: they are that billboard's own layout, and nothing on the server reads either of them.
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
	 * The crown, drawn above the head of a player who is hot.
	 *
	 * **An image and never an emoji glyph.** The same sigil as a character would render differently on
	 * every platform and as a hollow box on some of them, and a box above a player's head is worse than
	 * nothing at all — so this is an upload, and the whole of the crown's look is these four numbers.
	 *
	 * **Nothing reads these four any more, and that is recorded rather than tidied.** The crown's visual was
	 * replaced by the `onFire` badge and the billboard that drew it is deleted; `CROWN_ATTRIBUTE` is unchanged and
	 * still drives `EconomyService.checkMilestones`. They are left because they are the crown's look and the badge
	 * that replaced it is currently drawn by nothing either — the four numbers are the only description of the
	 * art that exists if that visual comes back. **Do not treat them as a knob while they are unread.**
	 */
	CROWN_IMAGE: "rbxassetid://109209442459081",

	/** How big the crown is drawn, in pixels. **Placeholder.** Scaled to fit rather than stretched. */
	CROWN_SIZE: UDim2.fromOffset(40, 40),

	/** How far above a head the crown floats, in studs. **Placeholder.** */
	CROWN_OFFSET_Y: 4.5,

	/** How far the crown is drawn, in studs. **Placeholder.** */
	CROWN_MAX_DISTANCE: 100,
} as const;