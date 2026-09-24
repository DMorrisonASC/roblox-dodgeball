import { Players, Workspace } from "@rbxts/services";

/** The player behind `model`, if there is one. An NPC has no HUD, so it needs no attribute. */
function hudOwner(model: Model): Player | undefined {
	return Players.GetPlayerFromCharacter(model);
}

/**
 * Publishes the server-time instant at which a model's action counts as ready again.
 *
 * The one place a cooldown reaches the client, for the same reason `actionLock.ts` is the one
 * place the lockout is *timed*: the rule is a single sentence — take a duration this machine
 * measures and turn it into an instant both machines share — and every writer has to apply it
 * the same way, or two readouts disagree about what "ready" means.
 *
 * `Workspace.GetServerTimeNow()` and **never `os.clock()`.** The clocks the game is *timed* with
 * are per-machine and unsyncable by construction, which is fine as long as nothing but this
 * machine ever reads them; this one is synced by the engine, which is what lets another machine
 * subtract its own reading of the same clock and get a remaining time that is actually right.
 *
 * Nothing is published for a model with no player behind it. An NPC dodges and catches like
 * anybody else, but it has no HUD, and an attribute written for it would be state nobody reads.
 */
export function publishReadyAt(model: Model, attribute: string, seconds: number): void {
	const player = hudOwner(model);
	if (player) player.SetAttribute(attribute, Workspace.GetServerTimeNow() + seconds);
}

/**
 * The same, except that it can only ever *lengthen* the wait: the later of the two instants wins.
 *
 * The difference between "this action is ready at X" and "nothing here is ready before X". Two
 * writers publish onto one attribute — a catch cycle and the dodge that may be shutting it — and
 * whichever finishes last is the one the readout is about. Taking the newer value instead would
 * let a short wait cut a long one short, and the bar would go light while the pair was still shut.
 */
export function extendReadyAt(model: Model, attribute: string, seconds: number): void {
	const player = hudOwner(model);
	if (!player) return;

	const readyAt = Workspace.GetServerTimeNow() + seconds;

	const current = player.GetAttribute(attribute);
	if (typeIs(current, "number") && current > readyAt) return;

	player.SetAttribute(attribute, readyAt);
}
