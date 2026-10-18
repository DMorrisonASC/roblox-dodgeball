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
	// **Off, and it was left on for four weeks — 2026-09-30 to 2026-10-17.** It went on for one
	// diagnostic run of the throw probe (the ball landing short of the aim guide's marker), the numbers
	// were read, and the flag was never put back. What that cost is worth recording because nothing about
	// the game looked wrong: it is *diagnostics*, so the only symptom is frame time.
	//
	// A count off a 93-second playtest log, `VERBOSE_LOGS` on: **~700 lines from the throw probe alone**,
	// because `ThrowProbe.watchThrow` is not a print — it builds a whole `Trajectory` per throw (79
	// integrated steps, each a spatial query against an ignore list built by walking every child of
	// `Workspace`), then opens a `RunService.Heartbeat` connection that samples that throw for up to
	// three seconds. Every ball in flight gets one. The rest went on every catch window opening and
	// expiring, every sound, every ball's deciding body part, and the client's per-frame aim report —
	// which the note below calls the noisiest log in the game.
	//
	// **So the lesson is the one this file already argues for**: these are build-time decisions, and a
	// decision that is meant to be reversible needs somebody to reverse it. Turn it back on *for one
	// run*, read the numbers, turn it off in the same sitting.
	VERBOSE_LOGS: false,
} as const;
