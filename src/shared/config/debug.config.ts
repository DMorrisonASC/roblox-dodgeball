/**
 * How much the game prints.
 *
 * A build-time decision rather than a dev flag, because it is made *before* a playtest rather
 * than during one: the logs it silences are the per-frame and per-tick ones, which are worth
 * reading only while watching one specific thing, and which cost the very frame time they are
 * reporting on.
 *
 * **Shared rather than server-side.** The noisiest of the gated logs — the aim jitter report —
 * is on the client, and anything under `src/server/` compiles to `ServerScriptService`, which a
 * client script cannot require. `src/shared/config/` is the only place both sides can read.
 */
export const DEBUG_CONFIG = {
	/**
	 * The per-frame and per-tick logs: the throw probe, the client's aim report, the catch
	 * window's opening and expiry, the ball's deciding body part, and one line per dodge.
	 *
	 * Every one of them is a *measurement* of something that usually works, printed on a
	 * cadence rather than on an event. Errors and lifecycle lines are never gated — those are
	 * what is left when this is off, and they are the ones worth reading by default.
	 */
	VERBOSE_LOGS: false,
} as const;
