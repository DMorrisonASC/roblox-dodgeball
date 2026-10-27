import { RunService } from "@rbxts/services";
import { DEBUG_CONFIG } from "shared/config/debug.config";

/**
 * **The four functions every diagnostic line in this game now goes through, and the reason is that a live server is
 * not a Studio playtest.**
 *
 * **Roblox does not strip `print` or `warn` from a published place.** A `print` in Studio is a line in the Output
 * panel; the same `print` on a live server is a line written into that server's log stream, and the engine formats and
 * emits it whether or not anybody will ever read it. Nothing in the build removes it and nothing in the engine
 * compiles it away, so a line that costs a tenth of a millisecond in a playtest costs the same tenth on every server
 * of every running copy of the game — for output that has no reader, because a published server's Output is not
 * connected to anything a player can see. Multiply that by the number of lines this codebase prints, and the cost is
 * paid by the frame budget of a live game for the benefit of nobody.
 *
 * **So the split is by *audience* rather than by severity.** A diagnostic that only helps somebody sitting in Studio
 * should only run in Studio; that is `logInfo` and `logWarn`. A failure that a live server's operator has to act on —
 * a DataStore that would not answer, a record that could not be claimed — must survive, because silencing it would
 * trade one kind of blindness for another; that is `logError`. And the third audience is the one the codebase already
 * had: the per-frame and per-tick measurements, which were behind 77 separate `const DEBUG` flags before this file
 * existed. Those are `logDebug`.
 *
 * **Why a runtime check rather than a build-time flag.** `RunService.IsStudio()` is one call, made once, into a
 * module-level boolean — every call site then reads a field and branches. The alternative, deleting the strings from
 * the compiled Luau, needs a transformer in the build (`rbxts-transform-env` and its relatives), which is a
 * dependency, a second source of truth for what "production" means, and a build that cannot be inspected by reading
 * `out/`. That remains worth doing later — see the note at the bottom of this file — but a boolean is the change that
 * can be made, understood and reverted in one sitting.
 *
 * **What this deliberately does not do.** It does not tag lines with a severity prefix, does not add timestamps, does
 * not forward anywhere, and does not keep a level per module. Every log line in this game is already a hand-written
 * sentence with a bracketed subsystem in it — `[Round]`, `[Ball]`, `[Rig]` — and that convention is the searchable
 * one. This file only decides *whether* a line is emitted, never what it looks like.
 */

/**
 * **Whether this session is a Studio playtest — the single answer every function below is built on.**
 *
 * **It exists because Roblox does not strip prints in a published game.** That is the whole of the argument and it is
 * worth stating flatly, because the opposite belief is the natural one to hold: a `print` feels like a development
 * artefact and development artefacts are usually removed by a build. In this engine they are not. A published server
 * runs every `print` and every `warn` in the place file, formats the string, and writes it to a log stream that no
 * player reads — and this game, by its own count before this file existed, had several hundred of them on paths that
 * run every round and a few thousand on paths that run every frame. That is the lag. Not the game's simulation: its
 * own diary.
 *
 * **Read once at module load, and that is correct rather than a shortcut.** `RunService.IsStudio()` answers a fact
 * about the *place the code is running in*, which cannot change during the life of a script — a server does not
 * become a Studio session. Caching it means every call site pays a field read and a branch rather than a method call,
 * which matters precisely because these are the hot paths this file exists to make cheap.
 */
const IS_STUDIO = RunService.IsStudio();

/**
 * **Whether diagnostics are being emitted at all — `true` in Studio, `false` on a live server.**
 *
 * **Exported because a few sites cannot use the functions below, and they are the ones that matter most.** The
 * functions in this file decide whether to *emit*, but a call's arguments are evaluated before the call is made — so
 * `logDebug(\`[Dodge] ${model.GetFullName()} …\`)` still walks the instance tree and builds the string on a live
 * server, and only then discovers it has nothing to print. For the handful of sites that compute their message from a
 * physics query or a `GetFullName`, this flag is the early return the old `const DEBUG` used to provide:
 *
 * ```ts
 * const note = (…): void => {
 * 	if (!LOGGING_ENABLED) return;   // nothing below here runs on a live server
 * 	…
 * };
 * ```
 *
 * **Prefer the functions.** This flag exists for laziness, not as a second convention — a call site that uses it to
 * decide whether to call `print` itself is doing this file's job badly. Its two legitimate shapes are an early return
 * at the top of a function whose whole body is a diagnostic, and a block whose message is expensive to build; the
 * verbose-gated equivalent of the second is {@link DEBUG_LOGGING}, and `logDebug` names the reason.
 */
export const LOGGING_ENABLED = IS_STUDIO;

/**
 * **Whether the *verbose* tier is on — Studio, with `DEBUG_CONFIG.VERBOSE_LOGS` flipped.**
 *
 * **A second flag rather than one, because the codebase already has both questions and they have different answers.**
 * `IS_STUDIO` asks "is anyone reading this?"; `VERBOSE_LOGS` asks "is this a run where I am watching one specific
 * thing?" The per-frame and per-tick measurements — the ones behind the 77 `const DEBUG` flags this file replaces —
 * are worth reading only in the second case, and `debug.config.ts` records what happens when they are left on: ~700
 * lines from the throw probe alone in a 93-second playtest, costing the very frame time they were measuring.
 *
 * **So `logDebug` is gated on both.** It is off by default even in Studio, which is not a limitation but the point:
 * the files this tier replaces were 74 flags set to `false` for exactly this reason, and a single switch that brings
 * the noisy tier back is better than editing 74 files to bring back the same lines.
 *
 * **Also read by the multi-statement blocks**, which is why it is exported rather than kept private to `logDebug`:
 * a site that computes its message before printing guards with this flag so that the computation does not run on a
 * live server, where the print inside would be discarded anyway.
 */
export const DEBUG_LOGGING = IS_STUDIO && DEBUG_CONFIG.VERBOSE_LOGS;

/**
 * **A line for somebody in Studio: lifecycle, a decision, a count.** Silent on a live server.
 *
 * **This is where the ~600 raw `print` calls in this codebase went**, and the classification is the one
 * `debug.config.ts` had already made by hand: the round's boundaries and eliminations, match opt-ins, the lobby rigs'
 * seat arithmetic, the spawner's line a round, the NPC lifecycle and dev commands. All of them are worth reading
 * while developing and worth nothing to a running server.
 *
 * **`...args` rather than a single message**, because `print` takes varargs and every call site in this codebase was
 * written against that: `logInfo("[Round] transition —", cover)` has to stay a two-argument call rather than becoming
 * a `tostring` concatenation at the call site, which would change the emitted text for the sake of a signature.
 *
 * **`Array<unknown>` and not `defined[]`**: this is the parameter type `print` itself is declared with in
 * `@rbxts/types` (`declare function print(...params: Array<unknown>): void`), so anything that could be printed to a
 * `print` can be passed here with no cast and no narrowing at the call site.
 */
export function logInfo(...args: Array<unknown>): void {
	if (!IS_STUDIO) return;

	print(...args);
}

/**
 * **A line for somebody in Studio about something that looks wrong: a template that is not there, a rig with no
 * Humanoid, a geometry report that came out the wrong size.** Silent on a live server.
 *
 * **Warnings are debugging aids and are treated as such**, which is a decision worth stating because the opposite one
 * is defensible. A warning reads as "somebody should look at this", and on a live server there is nobody to look —
 * the log stream has no reader. So a warning that stays silent in production is not information being thrown away, it
 * is information that was never being read. **The exception is a failure with a consequence** — a record that could
 * not be saved, a store that would not open — and those call {@link logError} instead, deliberately and one at a time.
 *
 * `warn` rather than `print` in Studio, so the Output panel's own colour does the sorting: a session's problems stand
 * out from its narration without a prefix being added to the text.
 */
export function logWarn(...args: Array<unknown>): void {
	if (!IS_STUDIO) return;

	warn(...args);
}

/**
 * **A line for whoever runs the game: something that failed and has a consequence.** Emitted in Studio *and* on a
 * live server, and that is the one place this file breaks its own rule.
 *
 * **Why the exception exists.** Every other function here is silent in production on the argument that a server's log
 * has no reader. That argument is only true for diagnostics. It is false for the events that make a published server
 * need an operator at all: a DataStore that will not open, a read that failed, a write that failed, a record another
 * server has claimed, a shutdown that ran out of time with unsaved records. **Those are data loss**, they are
 * invisible from inside the game — the player simply plays on blank figures — and silencing them would mean the only
 * record of them is a session that happened to be running in Studio, which is to say no record at all.
 *
 * **`warn` rather than `error`**, because Roblox has no `error` channel: `warn` is what the Output panel colours and
 * what the server log marks, and `error` throws. A function called `logError` that threw would be a trap for the next
 * person to paste a call site into a `pcall`.
 *
 * **Called deliberately, never as a default.** There are around a dozen call sites, all of them persistence, and a
 * reader can grep `logError` to see the complete list of things this game considers worth waking somebody for. If
 * that list starts growing beyond persistence, the argument above has stopped being the reason.
 */
export function logError(...args: Array<unknown>): void {
	warn(...args);
}

/**
 * **A measurement: the per-frame and per-tick tier.** Emitted only in Studio *with* `DEBUG_CONFIG.VERBOSE_LOGS` on —
 * silent on a live server, and silent by default in a playtest too.
 *
 * **This is the tier the 74 `const DEBUG` flags used to be.** Each was a per-file switch, turned on for one diagnosis
 * and then — in the case `debug.config.ts` records at length — left on for four weeks while the only symptom was
 * frame time. One shared switch replaces all of them, and the difference is not tidiness: `grep -rn "const DEBUG =
 * true" src/` used to be how you found out what was still talking, which is a command somebody has to remember to
 * run. A config value is read by every one of these sites at once, so there is no state to forget.
 *
 * **`print` rather than `warn`**, because these are measurements rather than problems: a line per dodge is not a
 * complaint about the dodge. **And `DEBUG_LOGGING` rather than `IS_STUDIO` alone**, for the reason written on that
 * constant — the whole point of separating this tier from {@link logInfo} is that it stays off unless asked for.
 *
 * **Two shapes at the call sites, and which one to use is decided by the message.** A single expression is
 * `logDebug(…)`. A site that has to *compute* its message — hoisting a `string.format` out of a template, walking a
 * model for a name, packing a layout to report its geometry — guards a block with {@link DEBUG_LOGGING} and calls
 * {@link logInfo} inside it, because the arguments would otherwise be built on a live server and thrown away. That is
 * the same reason {@link LOGGING_ENABLED} exists for a function that returns early; the two differ only in scope.
 */
export function logDebug(...args: Array<unknown>): void {
	if (!DEBUG_LOGGING) return;

	print(...args);
}
