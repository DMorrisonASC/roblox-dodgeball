/**
 * **When each player's current charge began, on this machine's clock — the one fact the throw cap needs and the
 * only one the server can obtain without trusting the client for it.**
 *
 * A charge is measured on the *client*: `ThrowController.currentCharge` derives it from `os.clock` and a local
 * instant, and the server never sees the button. What the server does see is `setCharging`, a boolean the client
 * reports on the edge of every hold — it exists so `WalkSpeedService` can cap a body standing in the aiming stance
 * — and **the instant that message arrives is a fact about this server**, which is exactly what a cap on the hold
 * has to be built from. So this module holds that instant, and nothing else.
 *
 * **A plain module rather than a field on either service, for `practiceZoneMembership`'s reason.** The writer is
 * `WalkSpeedService` and the reader is `BallService`, and neither owns the other: a service-to-service edge here
 * would be one more arrow in the reflection graph for a `Map` and two functions. It is *state* rather than a
 * predicate, which is the one thing this module has that `practiceZoneMembership` does not — and it is keyed on
 * `Player` rather than on a body for the reason every hold is: a player holds the button, not a character, so a
 * death mid-hold does not move the clock to a different body.
 *
 * **`os.clock` and not `Workspace:GetServerTimeNow`, which is the opposite choice to `readyAt.ts`'s.** That
 * function publishes an instant to *another machine*, so it has to be on the clock both machines share. Nothing
 * here crosses the wire: the stamp is taken here and read here, one comparison later, and a per-machine clock is
 * the correct instrument for a duration measured on one machine. The project's rule is already this one — every
 * window the server times alone (`CatchService`'s catch cycle, `DodgeService`'s cooldown) is `os.clock`.
 *
 * ## What a forged report can and cannot do, stated here because the module is the whole of the trust surface
 *
 * **A client that never reports a hold has no hold to cap.** `setCharging` is the client's own statement, and a
 * modified client can omit it, report `true` late, or report it at the instant of the release. **No server-side
 * cap built on a client-reported edge can stop that**, and this module does not pretend to: what it closes is the
 * honest case — a client that reports its hold and then holds for longer than it was given, whether from a stale
 * timer, a modified build that keeps the normal path, or a lag spike that swallowed the release. Closing the
 * dishonest case would need the server to own the charge, which is a different feature and is not this one.
 */

/** The instant each player's current charge began, as `os.clock` seconds on this server. */
const startedAt = new Map<Player, number>();

/**
 * Records that `player` has just picked the throw button up (`true`) or put it down (`false`).
 *
 * **A rising edge is stamped and a falling edge is deliberately *not* cleared.** The two messages a release
 * produces — this one and the throw itself — travel on different remotes, and nothing promises the order they
 * arrive in: `ThrowController.releaseThrow` clears the charge and redraws *before* it fires the throw, so the
 * `false` is sent first and could easily land first. Clearing here would therefore delete the instant a
 * millisecond before the throw that needs it, and every throw in the game would be uncapped or refused depending
 * on which way the ordering fell.
 *
 * A stale entry is harmless instead: the next press overwrites it, and the only window in which it can be read is
 * a throw, which cannot happen without a press. Entries are dropped when the player leaves and when a body is
 * replaced — see {@link forgetCharging}.
 */
export function noteCharging(player: Player, active: boolean): void {
	if (!active) return;

	startedAt.set(player, os.clock());
}

/**
 * How long `player`'s current charge has been running, in seconds, or `undefined` if this server never heard one
 * begin.
 *
 * **`undefined` is a real answer and every caller has to decide what it means.** It is what a client that does not
 * report its hold looks like, and — because `setCharging` is a reliable ordered event sent from the frame the
 * button went down — it is also what a *fabricated* throw looks like. `BallService.throwForPlayer` treats it as a
 * hold starting now and says so in the log rather than refusing the throw, because a lockout for a player whose
 * report was somehow missed is worse than one uncapped hold.
 */
export function holdSeconds(player: Player): number | undefined {
	const began = startedAt.get(player);
	if (began === undefined) return undefined;

	return os.clock() - began;
}

/** Drops `player`'s entry: they left, or their body was replaced under a hold. */
export function forgetCharging(player: Player): void {
	startedAt.delete(player);
}
