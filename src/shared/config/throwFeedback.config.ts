/**
 * The throw's one piece of feedback that is neither the ball's mechanics nor its sound: **the kick the
 * thrower's own camera takes.**
 *
 * **A third file rather than more entries in `ball.config.ts`, and the split is the one `sound.config.ts`
 * already makes.** That file is the *sound* of the game, and the throw's id lives there rather than among the
 * ball's numbers because the two are tuned by different senses. `ball.config.ts` says of itself that it is
 * "everything about the ball" — how it is made, how long it lives, how a throw at a target is solved — and
 * every number in it is read by the solve both sides run. **Nothing here is read by a solve**, which is the
 * whole reason it is not in there: the shake is read by one client that does not care where the ball goes.
 *
 * ## The wind burst used to be the other half of this file, and it is gone
 *
 * **Deleted on 2026-10-13 at the user's instruction, and deleted as a set: the effect, its module and these
 * entries.** The gust was a `Part` and a `ParticleEmitter` built in code by `server/services/ball/WindBurst.ts`
 * at the *ball's launch point*, and thirteen `WIND_BURST_*` entries described it — its texture, count,
 * emission window, lifetime, speed, spread, drag, size, transparency, colour, light emission and gravity
 * scale. What replaced it is a Studio-authored template welded to the *thrower's body*, in
 * `client/windBurst.ts`, which is now the only thing that knows anything about the effect.
 *
 * **The lesson is kept because it was paid for and the file that recorded it is gone.** That effect was
 * originally fired with a single `ParticleEmitter:Emit(N)` built on the server, and it was invisible to every
 * client for it: an emission is an *event*, and what replicates is the emitter's **properties** — which is why
 * the working version was an enabled emitter with a `Rate` over a short window. **The replacement is built on
 * the client that renders it, so `Emit` is the correct call there and the trap does not apply** — but it is the
 * reason the new module's comment has to say which side of the wire it is on before it fires anything.
 *
 * **Nothing here is read by the server any more**, and nothing about the throw is: what is left is a camera
 * offset on the machine that threw.
 *
 * Imports nothing, for `ball.config.ts`'s reason: a config that depended on a service would be a service, and
 * this one is read by one client on one side of the wire.
 *
 * Every number below is a `**Placeholder.**` — none of it has been looked at on a screen.
 */
export const THROW_FEEDBACK_CONFIG = {
	// ------------------------------------------------------------- the shake

	/**
	 * Whether the thrower's camera is kicked at all. **Creation switch.**
	 *
	 * A flag rather than a magnitude of zero, which is `super.config.ts`'s pattern for the freeze burst and
	 * its stated reason: a zero is a number somebody has to decide is deliberate, and this one is turned off
	 * as often to *test* the rest of a throw as to remove it.
	 */
	SHAKE_ENABLED: true,

	/**
	 * How far the camera is pushed **at full charge**, in studs. **Placeholder.**
	 *
	 * **A top value rather than a fixed kick, and what scales it is the *charge* rather than the ball's
	 * speed.** A throw is a hold of some fraction of `BALL_CONFIG.CHARGE_SECONDS`, and that fraction
	 * multiplies this figure — so a half hold is half the shake, and the shake for a given hold is the same
	 * number whether `CHARGE_MIN_SPEED` and `THROW_MAX_SPEED` are wide apart or narrow. Feeding the ball's
	 * speed in instead would tie a camera setting to the ballistic tuning, and the day the speed range is
	 * retuned every kick would move with it. See `cameraShake.ts`, which takes the charge and nothing else.
	 * The one equivalence worth knowing: `chargeSpeed` is a straight interpolation between the two speeds, so
	 * "the charge" and "how far up the speed range this throw sits" are the same fraction *today* — the charge
	 * is used because it does not depend on that staying true.
	 *
	 * **Deliberately a fraction of a stud, which is what "mild" means here.** The whole offset a player's
	 * camera already carries while shift-locked is `SHIFT_LOCK_CONFIG.CAMERA_OFFSET` = `(2, 2, 0)`, about 2.8
	 * studs, so this is a fifth of the offset the camera is sitting at — a nudge the thrower feels rather than
	 * a camera position that has moved. Raising it past about a stud stops being a shake and starts being a
	 * second camera mode.
	 */
	SHAKE_MAGNITUDE: 0.6,

	/**
	 * How much of the shake **a throw with no hold at all** gets, as a fraction of {@link SHAKE_MAGNITUDE}.
	 * **Placeholder — `0` is the ask.**
	 *
	 * **Zero, and that is pure proportionality rather than an oversight**, which is what "the shake follows the
	 * power" means taken at its word: hold the button for nothing and the camera is not touched at all.
	 *
	 * **The cost, stated so it can be judged in play rather than discovered: the ball still goes somewhere.**
	 * `CHARGE_MIN_SPEED` is a floor on the *throw* and not on anything here, so a tapped throw is a real throw
	 * a long way down the field with no kick behind it — the one case where the shake and the ball disagree
	 * about how much happened. If that reads as the feedback being broken, **this is the number to raise**
	 * rather than the magnitude above: at `0.25` a tap gets a quarter of the shake and a full hold is
	 * unchanged, which keeps the proportionality and drops the dead spot.
	 */
	SHAKE_MINIMUM_FRACTION: 0,

	/**
	 * How long the shake lasts, in seconds. **Placeholder — 0.16 is the ask.**
	 *
	 * Short on purpose, and the number that decides whether this reads as an *impulse* rather than as an
	 * effect. A throw is a single event: the ball leaves the hand once, and a camera still moving half a
	 * second later is the camera disagreeing with what just happened. It is also about ten frames at sixty a
	 * second, which is long enough for the oscillation below to complete a couple of cycles rather than
	 * looking like a single one-frame jump.
	 */
	SHAKE_SECONDS: 0.3,

	/**
	 * How fast the shake oscillates, in hertz. **Placeholder — 18 is the ask.**
	 *
	 * **What separates a jolt from a drift.** Without oscillation a decaying offset is a camera that slides
	 * away and returns, which reads as a soft push; two or three cycles of a decaying sine read as a *hit*.
	 * At `SHAKE_SECONDS` this is roughly three cycles, which is the fewest that still reads as a spring rather
	 * than as a wobble. Much higher and it is a buzz with no shape at the frame rate this runs at.
	 */
	SHAKE_FREQUENCY: 18,

	/**
	 * How much of the shake goes sideways rather than up, as a fraction of the magnitude. **Placeholder.**
	 *
	 * **The up axis carries the kick and this decides how much of a wiggle it has along the body's own left**
	 * — see `cameraShake.ts` for why those two and not three: `Humanoid.CameraOffset` is applied in the
	 * *body's* frame, so a Z component would push the camera along the thrower's own forward and read as a
	 * dolly, which is a zoom rather than a shake. Zero here is a purely vertical bob, which is legible for the
	 * first throw and mechanical by the tenth.
	 */
	SHAKE_SIDE_FRACTION: 0.35,
} as const;
