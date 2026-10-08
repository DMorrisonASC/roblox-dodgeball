/** Prints every ball this file actually destroys. **This line is why the bug below was invisible.** */
const DEBUG = true;

/**
 * The clock each ball is currently on, as a token. A row exists only while a timer is pending for that
 * ball, and it is the *newest* clock's token that is in it.
 *
 * **A token rather than a `task.delay` handle, because a pending `task.delay` cannot be cancelled — only
 * ignored.** `ThrowStateToastController` says the same thing about the same problem and solves it the same
 * way: the callback compares the token it captured against the current one and gives up if they differ.
 * That comparison *is* the cancellation, and it is the whole of what was missing here.
 *
 * **The counter is global and monotonic, not per-ball.** A per-ball counter that restarted at nought could
 * hand a live token back to an older timer — the row is deleted on some paths, so "the ball's next token"
 * is not reliably "the last token plus one" — and a timer that wrongly matched would destroy a ball it had
 * no business touching. One rising number for the whole server cannot collide with itself.
 */
const clocks = new Map<BasePart, number>();

let nextToken = 0;

/**
 * Destroys `ball` once `timeoutSeconds` have passed, unless it has been taken into a hand.
 *
 * The one place a ball's lifetime is decided, so that every ball in the game is on the same clock: a thrown
 * ball, a dropped ball and a ball the round owns are all this function with a different number.
 *
 * **A ball's clock is the *last* one it was given, and holding that is the whole of this file's job.** Every
 * call supersedes the previous call, because a ball is one instance that is thrown, caught, dropped and
 * thrown again — the *same* `BasePart` goes through `throwBall` and `dropBall` over and over — so "one
 * timer per call" leaves a timer standing for every flight that ball has ever had.
 *
 * **That is not a hypothetical: it was the bug, and the shape of the symptom is worth recording.** With no
 * way to cancel, a throw from sixty seconds ago is still armed, and it destroys the ball the moment it finds
 * it *not* in a hand — which is what a ball in flight is. So a ball died a second or two after being thrown,
 * seemingly at random, once it had been in play for a minute: one stale timer per throw was by then firing
 * every few seconds, and whichever of them caught the ball loose took it. It read as "the ball disappears
 * when I throw it" and it was a clock that had nothing to do with the throw it appeared to interrupt.
 *
 * **`isHeld` is a guard, not the mechanism, and it is why nothing has to *reset* the clock on a pickup.** A
 * ball in a hand is not on the clock at all — the holder decides how long it lives, and the next release
 * starts a fresh sixty seconds — so a timer that finds the ball held gives up and takes the ball's row with
 * it. A picked-up ball is therefore spared, and the throw that follows schedules a new clock; a ball picked
 * up with one second left gets a full sixty, by those two rules rather than by a third one written on the
 * pickup path.
 *
 * **`math.huge` means "not on a clock at all", and it is skipped rather than passed on — but it still
 * supersedes.** A ball the round owns during a round must still be there when a player goes back for it,
 * and the round's own cleanup is what ends it. Whether `task.delay` copes with an infinite delay is not
 * worth finding out — the honest reading of "never" is that there is no timer to make, so there is no
 * scheduler entry, no question about how the engine rounds an infinity, and nothing to remember if the
 * behaviour ever changes. What the call *does* do is take the ball off whatever clock it was on, which is
 * what "not on a clock" has to mean: the row is dropped, so no timer that was already pending can match it
 * again, and a later call to this function gets a token that is further along.
 *
 * A destroyed ball is not an error: the caller may have been beaten to it by the round's cleanup, and a
 * ball that is already gone needs no timer to take it away.
 */
export function scheduleBallExpiry(
	ball: BasePart,
	timeoutSeconds: number,
	isHeld: (ball: BasePart) => boolean,
): void {
	// **Taken before the `math.huge` test**, so that a call which schedules nothing still supersedes. See the
	// doc above for why that is the meaning of "not on a clock at all" rather than a detail.
	nextToken += 1;

	const token = nextToken;
	clocks.set(ball, token);

	if (timeoutSeconds === math.huge) {
		// Nothing is pending for this ball, so there is no clock to compare against and no row to keep.
		clocks.delete(ball);

		return;
	}

	task.delay(timeoutSeconds, () => {
		// **Superseded, so this timer is not the ball's clock any more.** Returning without touching the row
		// is deliberate: the row belongs to the clock that replaced this one, and deleting it here would
		// disarm the ball's live timer as a side effect of an old one firing.
		if (clocks.get(ball) !== token) return;

		clocks.delete(ball);

		if (ball.Parent === undefined) return;
		if (isHeld(ball)) return;

		// **The line the bug hid behind.** A ball destroyed here used to do so in complete silence, which is
		// why a sixty-second-old timer taking a ball mid-flight looked like the ball simply vanishing. The
		// time is the ball's own lifetime and not the time it spent in the world, which is the distinction
		// that makes this readable.
		if (DEBUG) print(`[Ball] ${ball.Name} expired — ${timeoutSeconds}s since it last left a hand`);

		ball.Destroy();
	});
}
