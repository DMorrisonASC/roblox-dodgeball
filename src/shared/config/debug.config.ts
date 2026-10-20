/**
 * **Every module's own `DEBUG` const is off as well, and this is where that is written down.**
 *
 * Each file that prints diagnostics keeps a `const DEBUG = ...` at the top of it, and on 2026-10-19 they
 * were all set to `false`: the Output panel — and, in a Studio playtest, the replication of the server's
 * lines to every client — was costing frame time on top of everything {@link DEBUG_CONFIG} already
 * describes. **Flipping one file's const back to `true` is how that file's lines come back**, and
 * `grep -rn "const DEBUG = true" src/` is the list of whatever is still talking, so nothing has to be
 * remembered. This is the same trade the two flags below make: a diagnostic that is on is a lie about
 * the frame budget, and the lines worth reading by default are the ones that are *not* behind a flag.
 *
 * What stays on is deliberate and small: the round's boundaries and eliminations, match opt-ins, the
 * lobby rigs' seat arithmetic, the spawner's one line a round, the NPC lifecycle, and dev commands.
 * What went is everything that prints on the cadence of play — throws, catches, dodges, pickups, coins,
 * every HUD mount, every VFX template, and the client's per-frame reports.
 */

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

	/**
	 * Whether the server's hot paths announce themselves to the MicroProfiler.
	 * **Placeholder — `false`. Set it to `true` for one recording session, then put it back.**
	 *
	 * **What it buys.** Without a `debug.profilebegin` the MicroProfiler's server view shows one
	 * undifferentiated "Script" bar, so a 12 ms frame cost can be attributed to *nothing* — which is how a
	 * fix gets chosen from arithmetic and makes the NPCs dumber while the real stall sits untouched. Every
	 * scope is a named band in that bar, and the recording then says which one is wide.
	 *
	 * **What it costs, and why it is a build-time constant rather than a dev flag.** Each site is one
	 * `if (DEBUG_CONFIG.PROFILE)` — a table read and a branch — and nothing else when this is off. With it
	 * on, every scope is also a MicroProfiler label, which is measurable overhead in its own right: a
	 * recording is a *diagnostic* frame cost, not the frame cost of the game, and the two must never be
	 * compared to each other. That is the same argument `VERBOSE_LOGS` above makes, and the same failure
	 * mode: a diagnostic left on is a lie about the frame budget.
	 *
	 * **Why `false` and not a per-session toggle at runtime.** This file's whole premise is that these are
	 * decided *before* a playtest rather than during one, because the cost is paid per tick, and a flag
	 * that could be flipped mid-session would make two halves of one recording incomparable.
	 *
	 * **The scope names are string literals at their sites**, so a MicroProfiler screenshot reads without
	 * a legend, and `grep -rn "debug.profilebegin" src/` is the whole list — there is no registry of them
	 * anywhere else to fall out of step. `@rbxts/types` types this as
	 * `debug.profilebegin(profileName: string): void` (`include/lua.d.ts:231`), so the typing accepts either
	 * form. **One family of names is built rather than written**: `NpcService` passes a precomputed label per
	 * behaviour so the rig loop reads `Npc.tick.Catching`, `Npc.tick.Throwing`, `Npc.tick.Seeking`,
	 * `Npc.tick.Pickup`, `Npc.tick.Dodging`, `Npc.tick.Respawn` and `Npc.tick.WalkToJoinPad` — built once
	 * per rig loop out of `behavior.tag`, not per turn, because a label made inside the dispatch would be an
	 * allocation on the path it is measuring.
	 */
	PROFILE: false,
} as const;
