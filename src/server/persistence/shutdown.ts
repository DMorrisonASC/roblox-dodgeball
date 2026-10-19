/**
 * **The shutdown numbers, in one place because two services have to agree on them.**
 *
 * `StatsService` and `EconomyService` both hang a save off `BindToClose`, and the engine gives them *one*
 * window rather than one each: bound functions are *"called in parallel"* and the server **"waits 30 seconds
 * for all bound functions to stop running before it shuts down."** Two services each deciding privately how
 * much of that window to allow themselves is how a pair of saves that each look reasonable add up to a
 * shutdown that is killed mid-write — so the budget is stated once, here, and both read it.
 *
 * **This module is outside `src/server/services/` on purpose**, the same way `sessionLock` is: everything
 * under an added path gets an identifier in `flamework.build` whether or not it holds a decorator, and a
 * constants file has no business being an entry there. See `src/server/npc/rigPool.ts` for the precedent.
 */

/**
 * How much of `BindToClose`'s window one service allows itself, in seconds. **Placeholder — 20.**
 *
 * Twenty of the engine's thirty leaves ten for the other service's writes (they run *concurrently*, so the
 * two twenty-second windows overlap rather than queue) and for whatever the engine does on its way out. A
 * number below the true budget is the safe direction: running out of time is a logged, partial loss, and
 * being killed at the end of it is the same loss with no log at all.
 */
export const BIND_TO_CLOSE_SECONDS = 20;

/**
 * The most any single shutdown write may take, in seconds. **Placeholder — 5.**
 *
 * **A number of its own because one hung request is the failure this bound exists for.** The platform
 * documents the mechanism precisely: a throttled request *"is placed in a queue ... The called function
 * continues to yield as long as its request is still queued"* — so a `pcall` catches an error but cannot
 * bound a call that simply does not answer, and a save-all with no per-write limit can spend its whole
 * window on its first player. Five seconds is roughly fifty times an ordinary round trip: enough for a slow
 * but healthy store, short enough that the other seven players still get a turn.
 */
export const WRITE_DEADLINE_SECONDS = 5;

/**
 * How often {@link runWithin} looks at its own deadline, in seconds.
 *
 * **A poll rather than a signal because a yielding DataStore call cannot be cancelled.** Once `UpdateAsync`
 * has been called there is no way to withdraw it — the thread simply stays suspended inside the engine — so
 * the only thing any of this can do is *stop waiting* for it. Twenty looks a second for twenty seconds is
 * nothing next to the data it is protecting.
 */
export const BIND_TO_CLOSE_POLL_SECONDS = 0.05;

/** What {@link runWithin} answered. `ok: false` means "still running, we stopped waiting". */
export type WithinOutcome<T> = { readonly ok: true; readonly value: T } | { readonly ok: false };

/**
 * **Runs `work` on a thread of its own and waits up to `seconds` for an answer.**
 *
 * A thread and a poll, because that is the only shape available: `UpdateAsync` yields and cannot be
 * cancelled, so bounding it means bounding the *wait*, not the call. The thread that runs out of time is
 * left to finish into a server that is going away, which is the same ending it would have had if nobody had
 * waited at all — and the difference is that the next player got their turn.
 *
 * **`ok: false` must be reported by the caller, and that is the whole point of the box.** A shutdown that
 * silently drops the last few records is indistinguishable from one that saved everybody; the caller knows
 * which player it was and is the only place a name can be attached to the loss.
 *
 * The answer is handed back through a small table rather than a `let`, which is a compiler constraint rather
 * than a preference: a `let` assigned only inside a spawned closure is narrowed to its initial value at every
 * read after it, so comparing the answer against another variant fails to type-check even though it compiles
 * to the right thing.
 */
export function runWithin<T>(seconds: number, work: () => T): WithinOutcome<T> {
	const shared: { finished: boolean; value?: T } = { finished: false };

	task.spawn(() => {
		shared.value = work();
		shared.finished = true;
	});

	let waited = 0;
	while (!shared.finished && waited < seconds) waited += task.wait(BIND_TO_CLOSE_POLL_SECONDS);

	if (!shared.finished) return { ok: false };

	return { ok: true, value: shared.value as T };
}
