import { ACTION_CONFIG } from "shared/config/action.config";

/**
 * How long ago an action ended, if that is still inside the lockout — `undefined` when the
 * lockout has run out.
 *
 * **The one place the *timing* half of the action lockout is written.** Three systems ask
 * it now: `DodgeService` before a dash, `CatchService` before a window, and
 * `BallPickupService` before a pickup. Each of them supplies its own facts and asks this
 * whether those facts are recent enough to still be in the way — a deliberate split,
 * because *which* actions hold a given one shut is a rule about the game and every caller
 * knows its own, while *how long* a finished action keeps holding anything shut is one
 * number and belongs in exactly one place.
 *
 * The elapsed time comes back rather than a boolean because the callers print it: a
 * refusal that says how far past the action it happened turns "not allowed" into a
 * measurement. Handing back the number is also the reason this is not a second read of the
 * clock at the call site, which would be the duplication it exists to remove.
 */
export function lockoutElapsed(at: number | undefined): number | undefined {
	if (at === undefined) return undefined;

	const since = os.clock() - at;
	return since < ACTION_CONFIG.ACTION_LOCKOUT_SECONDS ? since : undefined;
}
