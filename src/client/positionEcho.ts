import { Players, Workspace } from "@rbxts/services";
import { events } from "shared/networking";
import { DEBUG_LOGGING, logDebug } from "shared/logger";

/**
 * **The client's own answer to "where am I", published ten times a second, with the server's clock on it.**
 *
 * Half of a measurement and nothing else. `server/dev/HitDisagreementProbe` prints, at the instant a ball
 * tags a body, the server's three facts — where the server thinks the body is, where the ball is, and when
 * — and they are not enough to tell a lag from a `Touched` sweep from the picture on the screen. The number
 * that separates them is **the same body's position as the body's own machine sees it**, and only this
 * machine has it: the character is client-owned, so its movement is the client's answer and the server's
 * copy is whatever the last replication step said.
 *
 * **Why a remote and not an attribute.** Every other shared fact in this project is an attribute, and this
 * one cannot be: attributes replicate from the server to the client and not back —
 * `DUCKING_ATTRIBUTE` states the rule, and nothing under `src/client/` writes one. See the `positionEcho`
 * event for the full argument; the short version is that this is the one fact whose owner is the client.
 *
 * **`Workspace.GetServerTimeNow()` and never `os.clock()`**, for `readyAt.ts`'s reason: a per-machine clock
 * is unsyncable by construction, and the whole value of this sample is that the server can subtract the two
 * instants and get an age that includes the upload leg. A value taken on arrival would hide half of what
 * the probe is looking at.
 *
 * **Off unless the logs are verbose, and off before the loop exists.** `DEBUG_LOGGING` is a build-time
 * constant (`DEBUG_CONFIG.VERBOSE_LOGS` and `RunService.IsStudio`), so the early return below is the whole
 * of this module's cost in a shipped game and in a playtest that is not watching this: no thread, no
 * remote, no attribute reads. When it is on, one thread wakes every tenth of a second — **`task.spawn` with
 * `task.wait`, which is this project's shape for a plain module that is started by hand** — and reads a
 * `HumanoidRootPart` that is a part, not a rendered `CFrame`: this is the body's own position, which is the
 * only thing the server's copy is ever compared against.
 *
 * **Nothing here reads the ball.** Where the ball is *drawn* is a second question and a different
 * measurement (candidate 5 in the probe's own terms) — it would need the ball's local `CFrame` echoed the
 * same way, and it is deliberately not in this pass: the probe reports what it can prove.
 */

/** **Placeholder — 0.1.** Ten samples a second, which is the order of two replication steps. */
const ECHO_INTERVAL_SECONDS = 0.1;

export function startPositionEcho(): void {
	if (!DEBUG_LOGGING) return;

	const remote = events.Client.Get("positionEcho");

	// **Said at boot**, for the reason every other client module says its own line: a probe that never
	// prints and a probe whose echo never started look identical from the server's side, and the absent
	// sample is exactly the case the server cannot distinguish from "the client module is not running".
	logDebug(`[HitProbe] position echo up — ${string.format("%.2f", ECHO_INTERVAL_SECONDS)}s while the logs are verbose`);

	task.spawn(() => {
		while (true) {
			task.wait(ECHO_INTERVAL_SECONDS);

			const character = Players.LocalPlayer.Character;
			const root = character?.FindFirstChildWhichIsA("Humanoid")?.RootPart;

			// A dead body has no root, and a body being replaced by a respawn has one that is about to be
			// thrown away. Neither is a sample worth printing, and neither is an error.
			if (root === undefined) continue;

			remote.SendToServer(root.Position, Workspace.GetServerTimeNow());
		}
	});
}
