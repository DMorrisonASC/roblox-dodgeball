/**
 * How far in the camera pulls while sprinting, and while a dodge is in flight.
 *
 * **A file of its own beside `throwFeedback.config.ts`, and for that file's own reason**: both are camera
 * feedback on the machine that asked for it, and neither is read by the server or by any solve. The camera
 * effects now have three numbers in two files — a shake's magnitude and a zoom's two depths — and they are
 * kept apart because they are triggered by different things and tuned by different senses: the shake is the
 * *throw's* kick, and this is the movement's.
 *
 * **The two depths are degrees off the resting field of view, not absolute field-of-view values.** Nothing
 * here knows what FOV the place file asks for, and that is deliberate rather than tidy: `StarterPlayer` can
 * set one, this file cannot see it, and an absolute `62` would be a second opinion about the camera that
 * silently wins. Stated as "how much narrower", the effect is the same size on any FOV and the resting value
 * stays whoever's it was. See `CameraZoomController.step`, which re-reads it.
 *
 * **Degrees rather than a stud offset towards the body.** Pulling `Humanoid.CameraOffset` in is a *dolly*: the
 * body grows and the world does not narrow, so it reads as the camera being nudged rather than as a change of
 * what the player can see. Only the field of view is a zoom.
 *
 * **The two sources are read differently, and each follows the rule its own subsystem already keeps.** Sprint
 * is the *key* — `client/sprinting.ts`, the same fact the running animation follows — so "the zoom goes back
 * when the key comes up" is exactly what this file's sprint numbers mean. A dodge is the *server's* window,
 * published on the body, so a press the server refuses zooms nothing. See `CameraZoomController` for both
 * arguments.
 *
 * **What the two do together is the deeper of them, not the sum** — a dodge while sprinting does not stack to
 * `SPRINT_DEGREES + DODGE_DEGREES`. Stacking would be a third strength that nobody chose, and it would arrive
 * exactly when the player is already moving fastest; the max is what makes 6 mean 6.
 *
 * Imports nothing, for `throwFeedback.config.ts`'s reason: a config that depended on a service would be a
 * service. Every number below is a `**Placeholder.**` — none of it has been looked at on a screen.
 */
export const CAMERA_ZOOM_CONFIG = {
	/**
	 * How much narrower the field of view goes **while a sprint key is held**, in degrees. **Placeholder.**
	 *
	 * Small on purpose: this is a sustained state rather than an event, so it is held for as long as the
	 * player holds the key and a large number would be a permanent change to how the game looks rather than a
	 * cue. Six degrees off seventy is a narrowing the eye notices at the edges of the frame and does not
	 * notice as a change of view.
	 */
	SPRINT_DEGREES: 6,

	/**
	 * How much narrower the field of view goes **while a dodge window is open**, in degrees. **Placeholder.**
	 *
	 * Less than the sprint's, and the difference is the two shapes rather than a preference: a dodge lasts
	 * `DODGE_CONFIG.DURATION` — two tenths of a second — so the same depth in a tenth of the time reads as a
	 * much bigger move. A shorter, shallower pull is what makes a burst land as a punch rather than as a lurch.
	 */
	DODGE_DEGREES: 4,

	/**
	 * How long the pull **in** takes. **Placeholder.**
	 *
	 * **A time constant rather than an exact duration**: the camera closes the remaining gap exponentially, so
	 * it covers about two thirds of the distance to the target in this many seconds and the last third over the
	 * seconds after that. That is the right shape for something with no end state to hit — there is no frame at
	 * which the zoom is "arrived" — and it means the number is read the same way as {@link RELEASE_SECONDS}.
	 *
	 * Fast, because the shortest thing it has to serve is a 0.2-second dodge: an attack slower than the dash
	 * would arrive after the move it is describing, which reads as the camera reacting to something that has
	 * already finished. A sprint's arrival is the same speed, so the two do not differ in how quickly the zoom
	 * shows up — only in how deep it goes.
	 */
	ATTACK_SECONDS: 0.12,

	/**
	 * How long the **return** takes, on the same exponential reading as {@link ATTACK_SECONDS}. **Placeholder.**
	 *
	 * Slower than the attack, deliberately, and it is the same asymmetry a game camera usually has: arriving is
	 * an event and should be felt, while leaving is the effect getting out of the way and is smoother for being
	 * unhurried. It also keeps the camera from snapping back the instant a key comes up, which on a held key
	 * tapped repeatedly would be a flicker per tap.
	 */
	RELEASE_SECONDS: 0.35,
} as const;
