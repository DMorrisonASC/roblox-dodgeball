/**
 * Destroys `ball` once `timeoutSeconds` have passed, unless it has been taken into a hand.
 *
 * The one place a ball's lifetime is decided, so that every ball in the game is on the same
 * clock: a thrown ball, a dropped ball and a ball the round owns are all this function with a
 * different number. The guard is the part that matters — a ball that has been caught since it
 * was thrown belongs to whoever is holding it, and how long it lives is theirs to decide, so
 * the timer checks rather than assumes.
 *
 * **`math.huge` means "not on a clock at all", and it is skipped rather than passed on.** A ball
 * the round owns during a round must still be there when a player goes back for it, and the
 * round's own cleanup is what ends it. Whether `task.delay` copes with an infinite delay is not
 * worth finding out — the honest reading of "never" is that there is no timer to make, and this
 * way there is no scheduler entry, no question about how the engine rounds an infinity, and
 * nothing to remember if the behaviour ever changes. The function was asked to schedule nothing,
 * and it schedules nothing.
 *
 * A destroyed ball is not an error: the caller may have been beaten to it by the round's cleanup,
 * and a ball that is already gone needs no timer to take it away.
 */
export function scheduleBallExpiry(
	ball: BasePart,
	timeoutSeconds: number,
	isHeld: (ball: BasePart) => boolean,
): void {
	if (timeoutSeconds === math.huge) return;

	task.delay(timeoutSeconds, () => {
		if (ball.Parent === undefined) return;
		if (isHeld(ball)) return;

		ball.Destroy();
	});
}
