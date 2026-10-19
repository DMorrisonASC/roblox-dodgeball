/**
 * Everything about the duck: **how long the body is out of the way, and how long it waits before it can
 * do it again.**
 *
 * **On the shared side of the line, and that is the whole reason this file exists.** The duck is the first
 * action in this game whose *clip* has to match its *state*: the head and arms are exempt for exactly
 * `DURATION_SECONDS`, and a crouch that finishes early — or is cut half way — is a body the game says is
 * ducking while it looks like it is standing up. So the number is read by two machines, `DuckService` on
 * the server (which owns the exemption) and `client/bodyAnimation.ts` (which owns the clip), and a number
 * two machines read cannot live inside one of them. It was a constant in `DuckService` until this file
 * existed, which is why the duck played for half a second and animated for however long the artist
 * happened to make the clip.
 *
 * **`STATE_CLIP_SECONDS` in `animation.config.ts` is the other half.** It names the states whose clip is
 * *stretched* to fill the state, and the duck is the one entry — so this value drives the exemption **and**
 * the playback speed, and there is one number to change rather than two to keep in step.
 *
 * Imports nothing, like `dodge.config.ts` and `catch.config.ts` beside it: the two values below are numbers
 * and nothing here reads another config.
 */
export const DUCK_CONFIG = {
	/**
	 * How long a duck lasts, in seconds. **Placeholder — `1`.**
	 *
	 * **Raised from half a second, and the argument for the half is kept rather than deleted because it is
	 * still true and was overruled.** Half a second is what makes a duck a *read* rather than a *shield*: the
	 * head and arms are out of the way for that long and then they are not, and a ball crosses the arena in
	 * about a second — so half a second is a window a throw has to arrive inside, which is the mechanic
	 * working. What the duration is matched to now is the **animation** instead: the clip is authored a
	 * second long, and a state shorter than its own clip was a crouch the server ended while the body was
	 * still going down.
	 *
	 * **A second is also the point at which the question changes**, so it is worth watching rather than
	 * assuming: the body cannot be hit above the waist for the whole of this window, and see
	 * {@link DUCK_CONFIG.COOLDOWN_SECONDS} for the fraction of a round that works out to.
	 */
	DURATION_SECONDS: 1,

	/**
	 * How long a body must wait after a duck ends before it can duck again, in seconds.
	 * **Placeholder — `1.5`, and deliberately unchanged when the duration doubled.**
	 *
	 * **Measured from the end**, like `ACTION_CONFIG.ACTION_LOCKOUT_SECONDS` and for its reason: the stance
	 * is the duck's own length and this is the recovery, so timing it from the start would make the recovery
	 * shorter the longer the duck was.
	 *
	 * **The pair is the balance, and the arithmetic is the point.** The cycle is
	 * `DURATION_SECONDS + COOLDOWN_SECONDS` — **2.5 seconds** — and the exemption is `DURATION_SECONDS` of
	 * it, so a body that ducks at every opportunity is out of the way **40 % of the time**. At the half-second
	 * this used to be it was 25 %.
	 *
	 * **That is the number to watch, and this is the lever that does not cost anything else.** Raising this
	 * is a pure balance change. Lowering the duration instead would put the state and the clip back out of
	 * step, which is the fault this file exists to have fixed — so if the duck reads as too strong in play,
	 * **move this**, not the duration.
	 */
	COOLDOWN_SECONDS: 1.5,
} as const;
