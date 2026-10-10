import { Players, RunService } from "@rbxts/services";
import { THROW_FEEDBACK_CONFIG } from "shared/config/throwFeedback.config";

/**
 * The kick the thrower's own camera takes when the ball leaves their hand.
 *
 * **How hard the kick is, is the hold and not the ball.** `ThrowController` passes the charge — the button
 * hold as a fraction of `BALL_CONFIG.CHARGE_SECONDS`, the same number the throw puts on the wire — and it
 * scales the magnitude straight: a half hold is half a kick, a full one is `SHAKE_MAGNITUDE`, and nothing in
 * between depends on how fast the ball was thrown. **That is the property being bought**: `CHARGE_MIN_SPEED`
 * and `THROW_MAX_SPEED` are ballistic settings, and a camera that moved whenever they were retuned would tie
 * the feel of a throw to the tuning of its arc. The two are the same fraction *today* only because
 * `chargeSpeed` interpolates straight between them — the charge is taken because it does not rely on that.
 * See {@link shakeCamera}, which is where the clamp and the floor live.
 *
 * **`Humanoid.CameraOffset`, and that property belongs to `ShiftLock`.** This is the one thing to understand
 * before reading anything below, because the obvious tidy-up here is wrong in a way that only shows up in
 * play. `ShiftLock` writes that property in exactly two shapes, and both are load-bearing:
 * `ShiftLock.applyOffset` puts the shoulder offset on it while locked (`offsetForBody()`, which is
 * `SHIFT_LOCK_CONFIG.CAMERA_OFFSET` rotated into the body's frame) and writes `Vector3.zero` while unlocked.
 * **So this module borrows the property and has to give it back — and "back" means the value that was there,
 * never a zero.** A shake that ends by zeroing the offset would wipe shift lock's shoulder the instant it
 * finished, and the blame would land on the camera rather than on the throw. That is the whole reason the
 * restore below writes a captured value.
 *
 * **And `ShiftLock` does not write it rarely, which changes what "captured" has to mean.** Its
 * `watchOffset` binds a render step at `Enum.RenderPriority.Camera.Value + 1` and calls `applyOffset()`
 * **every frame while locked** — that is what keeps the shoulder camera-relative as the body turns, and it
 * is not a state change, it is the steady state of a locked player. Two consequences follow, and the second
 * is why this file does not simply capture once:
 *
 * - A value captured at the start of a shake does not *survive* shift lock for the shake's duration, it
 *   *suppresses* it: for about ten frames the shoulder stops tracking the body, because the last write of
 *   each frame is this one. That is a fraction of a stud of drift at the shake's own length and is accepted.
 * - **A capture taken once and restored at the end can be left holding the wrong value permanently**, which
 *   is not a fraction of a stud and is not acceptable. Unlock shift lock during a shake — a round boundary, a
 *   zone entry — and `ShiftLock` writes the zero, the shake finishes a few frames later and writes the
 *   *pre-shake shoulder* back over it. Nothing corrects that: while unlocked `ShiftLock` writes nothing per
 *   frame, so the camera sits shouldered with the mode off until the next lock or unlock. See the re-base in
 *   {@link step}, which is the few lines that close that, and which is worth doing here rather than later
 *   because the write is a steady state rather than a rare coincidence.
 *
 * **A module rather than a method on `ThrowController`**, for `aiming.ts`'s and `throwing.ts`'s reason: the
 * state here (a binding, a captured offset, an elapsed time) has nothing to do with what the controller is
 * about, and a second thing that wants a camera kick — a dodge, a landing — should be able to call this
 * without the throw's input handler growing a camera.
 *
 * **The binding, and why not a plain `RenderStepped` connection.** Two reasons, and they point the same way.
 * The write has to land where `ShiftLock`'s does — after the camera has placed itself for the frame, so the
 * offset is read by the *next* frame's camera, which is the one-frame lag that file documents and accepts —
 * and it has to land **after** `ShiftLock`'s own step, so the value read below is the one shift lock just
 * computed rather than the previous frame's. `Enum.RenderPriority.Camera.Value + 2` is one above
 * `ShiftLockOffset`, which makes that order a fact rather than a coincidence of registration.
 *
 * **Bound on the first kick and unbound at the end, which is the opposite of `ShiftLock`'s arrangement and
 * for the opposite reason.** That one binds once and lives forever because the lock comes and goes several
 * times a session, so the check has to be inside the step. A shake happens once and is then *over* — nothing
 * holds the camera for the rest of the session — so keeping a permanent step alive to do nothing is a per-frame
 * cost for a fraction of a second of effect per throw. The unbind happens from inside the step that is
 * running, which the engine allows.
 */

/** The binding's name, as `ShiftLockOffset` is `ShiftLock`'s. One step, one owner. */
const BINDING_NAME = "ThrowCameraShake";

/**
 * How much slower the sideways axis runs than the vertical one, as a fraction of its frequency.
 *
 * **The two axes must not be in step, and that is the difference between a shake and a bounce.** One
 * frequency on both axes traces a straight line — the camera slides up and to the side and back down the same
 * line, which reads as a bounce rather than as a hit. Half the rate on the lateral axis makes the path an
 * ellipse that also rotates, which the eye reads as a shake and cannot predict.
 */
const LATERAL_RATIO = 0.5;

/**
 * The offset the property held before this shake touched it — the value the restore writes back.
 *
 * Not `SHIFT_LOCK_CONFIG.CAMERA_OFFSET`: what is captured is whatever `ShiftLock` had actually written, which
 * is that value in the *body's* frame and is not the config's vector whenever the body is not facing the way
 * the camera looks. See {@link step} for how this is kept correct rather than captured once.
 */
let base = Vector3.zero;

/**
 * Exactly what this module last wrote into the property, or `undefined` when it is holding nothing.
 *
 * **This is what makes the re-base in {@link step} possible**, and it is deliberately the written value rather
 * than a "shaking" flag: the question the step needs answered is not *whether* the property should be ours but
 * whether it *currently is*, and the only honest test for that is comparing the property with the value that
 * was put there. A flag would answer the first question and leave the second one to be assumed.
 */
let written: Vector3 | undefined;

/** How long the shake has been running, in seconds, from the last kick. */
let elapsed = 0;

/**
 * How much of `SHAKE_MAGNITUDE` this kick gets, as the fraction of a full charge the throw was.
 *
 * **A fraction of the throw rather than of the ball**, which is the whole point of the split: see
 * {@link shakeCamera} for why the charge and not the launch speed, and why this is captured here rather than
 * looked up while the shake is running. Everything that reads it — `offsetAt` — is inside this module, so a
 * single number is enough and no second copy of the throw's power exists to drift.
 */
let scale = 1;

/** Whether the render step is currently bound. The whole of this module's cleanup state. */
let bound = false;

/**
 * Starts a shake — one kick, from now, **sized by how hard the throw was.**
 *
 * **`charge` is the hold as a fraction of a full one, and that is the input deliberately rather than the
 * speed the ball left at.** Those two are the same fraction today, because `chargeSpeed` interpolates
 * straight between `CHARGE_MIN_SPEED` and `THROW_MAX_SPEED` — and that is exactly why the charge is the one
 * to take: the speed range is a ballistic setting, and a camera that moved every time it was retuned would
 * make the feel of a throw impossible to tune apart from its ballistics. Asked for as "the same shake for
 * the same percentage", which is this and only this.
 *
 * **Clamped here rather than trusted**, at both ends and with the floor coming from the config: a public
 * function that multiplies a camera offset by whatever it is handed is one bad call away from a shake
 * several times the size of the one that was tuned, and `math.clamp` costs nothing per throw. The floor is
 * normally zero — see `SHAKE_MINIMUM_FRACTION` for what a zero-power throw gets and for why that is the
 * literal answer rather than the comfortable one.
 *
 * **A second kick during a shake replaces it rather than adding to it.** The envelope restarts at full
 * amplitude, so the second throw reads as a second jolt, which is what it is; adding instead would mean two
 * amplitudes in flight and a camera that can be pushed further the more often the player throws, and ignoring
 * the second would swallow the feedback for the throw that just happened. Replace is also the only one of the
 * three with a bounded result — and note that a *weaker* throw landing mid-shake still replaces a stronger
 * one, which is the honest reading of "a throw just happened" and is worth knowing before it is reported as a
 * bug.
 *
 * **The rest of the state is deliberately *not* reset here, and that is the subtle line in this file.** The
 * offset written by the previous frame is still in the property, so the step below must go on treating it as
 * its own — a restart that forgot {@link written} would read that value as the resting offset and bake one
 * shake's amplitude into the camera permanently. Only the clock and the scale are reset; the bookkeeping is
 * the step's.
 */
export function shakeCamera(charge: number): void {
	if (!THROW_FEEDBACK_CONFIG.SHAKE_ENABLED) return;

	scale = math.clamp(charge, THROW_FEEDBACK_CONFIG.SHAKE_MINIMUM_FRACTION, 1);
	elapsed = 0;

	if (!bound) {
		RunService.BindToRenderStep(BINDING_NAME, Enum.RenderPriority.Camera.Value + 2, step);
		bound = true;
	}
}

/**
 * One frame: **re-base if the property is no longer ours, write the shake, or put it back.**
 *
 * **The re-base is the three lines that make this survive `ShiftLock`, and it costs one comparison a frame.**
 * The property is read first, and if it does not hold what this module last wrote then something else wrote
 * it — `ShiftLock`, in every case that exists today — and *that* value is the one to restore to. So the base
 * follows shift lock rather than fighting it: a player who locks or unlocks mid-shake gets their camera put
 * back where the new state wants it, and the shake carries on adding to that. The alternative was to accept
 * it, and the paragraph in the module doc on what an unlock would leave behind is why that was not enough.
 *
 * **The shake is added to the base rather than replacing it**, which is the same care from the other side:
 * the property is not this module's to hold, so what it writes is always "whatever is already there, plus a
 * kick". Nothing here ever writes a bare shake offset.
 *
 * **The envelope decays quadratically and the axes oscillate — a damped sine, not a fade.** A linear fade of a
 * constant offset is a camera that slides away and returns, which reads as a soft push; the point of a kick is
 * that it is *fast* and then gone. The quadratic is what makes the first frames carry most of the motion, and
 * the cosine is what makes it a jolt rather than a drift — see {@link LATERAL_RATIO} for why two axes.
 *
 * **No Z component, deliberately.** `Humanoid.CameraOffset` is applied in the *body's* frame — `ShiftLock`
 * documents that at length, since it is why its own offset needs the conversion — so a Z component is a push
 * along the thrower's own forward: a dolly, which an eye reads as a change of zoom rather than as a shake.
 * Two axes are what a shake is.
 *
 * **A body that has gone ends the shake without a write.** There is nothing to restore *to*: the humanoid that
 * held the offset went with the character, and the next character starts from its own zero. This is also the
 * one path that ends a shake early, which is why it is not an error case.
 */
function step(deltaSeconds: number): void {
	const humanoid = Players.LocalPlayer.Character?.FindFirstChildWhichIsA("Humanoid");

	if (!humanoid) {
		finish();
		return;
	}

	const live = humanoid.CameraOffset;

	// Something other than this module wrote the property — `ShiftLock`, in every case that exists. Its value
	// is the new base, so the shake composes with shift lock instead of overwriting it.
	if (written === undefined || live !== written) {
		base = live;
	}

	if (elapsed >= THROW_FEEDBACK_CONFIG.SHAKE_SECONDS) {
		// **The restore, and it is the captured value rather than `Vector3.zero`.** Zero is `ShiftLock`'s to
		// write and only while the player is unlocked; writing it here would take the shoulder offset off a
		// locked player's camera for as long as nothing else happened to want it back.
		humanoid.CameraOffset = base;
		written = undefined;
		finish();
		return;
	}

	const kicked = base.add(offsetAt(elapsed / THROW_FEEDBACK_CONFIG.SHAKE_SECONDS));

	humanoid.CameraOffset = kicked;
	written = kicked;
	elapsed += deltaSeconds;
}

/** Unbinds the step. Called from the step itself on the frame the shake ends. */
function finish(): void {
	if (!bound) return;

	RunService.UnbindFromRenderStep(BINDING_NAME);
	bound = false;
}

/**
 * The shake's offset at `progress` of the way through it — **one full amplitude on the first frame and
 * exactly nothing on the last.**
 *
 * The cosine rather than a sine is what makes the first frame the peak: a sine starts at zero, so a shake
 * built on it spends its first frame at rest and its shape is a rise rather than an impact. `progress` is
 * normalised, and the frequency is converted back into seconds here because hertz against elapsed seconds is
 * the only form in which it means anything.
 *
 * **The hold scales the whole shape rather than any part of it**, so a soft throw is the same kick drawn
 * smaller: same length, same frequency, same decay, same lean to the side. Scaling the *duration* instead
 * would make a tap a shorter jolt, which reads as a different effect rather than a weaker one, and scaling
 * the frequency would make it a different speed of spring — neither is what "less power" looks like, and both
 * would need a second set of tuning numbers to say so.
 */
function offsetAt(progress: number): Vector3 {
	const decay = (1 - progress) * (1 - progress);
	const phase =
		2 * math.pi * THROW_FEEDBACK_CONFIG.SHAKE_FREQUENCY * progress * THROW_FEEDBACK_CONFIG.SHAKE_SECONDS;

	return new Vector3(
		math.cos(phase * LATERAL_RATIO) * THROW_FEEDBACK_CONFIG.SHAKE_SIDE_FRACTION,
		math.cos(phase),
		0,
	).mul(THROW_FEEDBACK_CONFIG.SHAKE_MAGNITUDE * scale * decay);
}
