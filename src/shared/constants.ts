/**
 * Name of the ball part that gets welded to a player's hand and then thrown.
 *
 * Shared so the client can tell whether the local player is currently holding
 * a ball (and therefore whether a click should throw one).
 */
export const BALL_NAME = "DodgeballBall";

/**
 * Attribute naming whoever a ball belongs to, carried on the **thrower's model**.
 *
 * The value is a string token rather than a `UserId`, because a thrower is not
 * always a player: a player's token is their `UserId` as text and an NPC's is a
 * GUID. The ball's own `ThrowerId` attribute is a copy of whichever one threw
 * it, so the immunity check can be a single string comparison that never has to
 * ask what kind of thing the thrower was. See `BallService.tokenOf` and
 * `BallComponent`.
 */
export const THROWER_TOKEN = "ThrowerToken";

/** Diameter of the ball, in studs. */
export const BALL_SIZE = 1;

/**
 * How far a model can reach to pick a loose ball up, in studs.
 *
 * Measured from the model's own position to the ball's, so this is a *reach and
 * a half step* rather than a walk: a picker does not travel to the ball, it takes
 * one that is already within this of it. Widen it and a picker starts collecting
 * balls it never appeared to touch; narrow it and it has to be walked onto them.
 *
 * Read as the default for `BallPickupService.pickupNearest`, which takes its own
 * radius — so a mechanic that wants a longer arm passes one rather than changing
 * everyone's reach.
 */
export const PICKUP_RADIUS = 8;

/**
 * How far in front of the thrower's torso the ball starts its flight, in studs,
 * measured along the direction the body is facing.
 *
 * Read this as a **lever arm**: it is the radius the launch point swings on when
 * the character moves or turns, so every stud of offset multiplies body motion
 * into the aim guide at a 1:1 ratio. A large value here makes the guide appear
 * to wobble as you walk; it does not make the throw safer, because
 * `CollisionIgnore` already guarantees the ball cannot hit its thrower.
 *
 * This is the one number to change to move the launch point. It is read in
 * exactly one place — `shared/throw.ts` → `getThrowMuzzle` — which both the
 * server (real throw) and the client (aim guide) call, so tuning it moves both
 * together and the guide keeps telling the truth.
 */
export const THROW_MUZZLE_DISTANCE = 2;

/**
 * Speed the ball leaves the hand at, in studs per second, for any target within
 * reach. Maximum range at this speed is `v² / g`, so reach grows with the square
 * of it.
 *
 * This is the *base* speed, not the final one — a throw that needs to reach
 * further is wound up automatically, up to {@link THROW_MAX_SPEED}.
 */
export const THROW_SPEED = 100;

/**
 * How much faster than the bare minimum the arcing throw is launched, as a
 * multiplier.
 *
 * The throw is solved by picking between the quadratic's two roots, and at
 * exactly the minimum speed those roots coincide — one arc, not two. This is
 * how far above that minimum it is thrown, so it sets how flat the arcing throw
 * sits: the two roots meet at 45° when the speed is exactly the minimum, and
 * raising this pulls the flatter of the two down from there.
 *
 * **It also keeps the solve off a numerical knife edge.** At exactly 1.0x the
 * discriminant is zero and the target sits precisely at the arc's limit, so the
 * whole answer swings on floating-point noise in the launch point. That was a
 * real bug here: the landing marker wandered on long throws and sat still on
 * short ones. Do not take this below about 1.05.
 *
 * It does not affect the straight throw at all — that one is barely thrown and
 * gets its speed from the fall instead. See `flatLaunchSpeed`.
 *
 * A side effect worth knowing: the furthest reachable target is
 * `(THROW_MAX_SPEED / THROW_ARC_SPREAD)² / gravity`, so raising this eats into
 * range unless {@link THROW_MAX_SPEED} comes up with it.
 */
export const THROW_ARC_SPREAD = 1.4;

/**
 * Ceiling on the automatic wind-up, in studs per second.
 *
 * Note this is the *pre-spread* figure. After {@link THROW_ARC_SPREAD}, the
 * furthest reachable target is `(THROW_MAX_SPEED / THROW_ARC_SPREAD)² / gravity`
 * — past that a throw falls short and the aim guide's landing marker shows you
 * exactly where.
 */
export const THROW_MAX_SPEED = 280;

/**
 * Extra upward velocity added to every throw, in studs per second.
 *
 * A correction for the engine, not a design choice. Measured on the server: the
 * ball flies as though it left the hand slower vertically than the velocity that
 * was written to it, and stays that much behind for the whole flight — so the
 * shortfall in position grows as `boost·t`, and the longer the throw the further
 * the ball sits below the line it was solved for. The drawn arc is the solved
 * one, so what that looks like from the player's seat is a trajectory running
 * *above* the ball.
 *
 * **Tune it against the ball, not with arithmetic.** The loss comes from how the
 * engine integrates (roughly `½·g·dt` per step), so this figure is frame-rate
 * dependent and the right value for it moves with the server's step size.
 * `BallService`'s DEBUG print shows the commanded velocity, and `ThrowProbe`
 * reports how far the ball drifts from the plan's own curve — that drift is the
 * number to drive to zero.
 *
 * **The correction belongs on the ball, not on the drawing.** Subtracting the
 * same figure from the guide's launch was tried (`PREDICTION_VERTICAL_BIAS`) and
 * removed: it moves the landing *marker* by `2·v_h·boost/g`, and `v_h` differs by
 * mode, so it dragged the three modes' marks apart by a different amount each.
 * Correcting the throw instead leaves every marker where it was and simply makes
 * the ball fly the line they came from.
 *
 * 0 restores pure ballistics and the shortfall with it.
 */
export const THROW_VERTICAL_BOOST = 2.5;

/**
 * Launch angle of the curveball, in degrees.
 *
 * A flat launch at a fixed angle has exactly one speed that lands on a given
 * point (`v = √(g·d / sin 2θ)` on level ground), so **this is the curve's speed
 * control**: flatter means harder, and steeper is what keeps the curve the slow,
 * readable throw a curveball should be rather than the fastest thing on the
 * field.
 *
 * Steeper also buys bend per unit of pull, because the pull has a longer flight
 * to work in; it buys a slower flight for the same reason. It does **not** change
 * how far the ball bows for a given launch angle off the aim line — that
 * relationship is the same at every angle, see {@link THROW_CURVE_ACCELERATION}.
 *
 * Two side effects worth knowing:
 *
 * - The curve is deliberately never floored at {@link THROW_SPEED}. A flat throw
 *   launched faster than its solve overshoots the mark, and at a steep enough
 *   angle the solve sits under the floor for most short targets.
 * - Aiming above the launch line no longer forces a fallback to an overhead
 *   throw so easily: the line climbs `d·tan θ`, so the more this angle rises,
 *   the further the aim can rise above the hand before the flat solve gives up.
 */
export const THROW_CURVE_ANGLE = 20;

/**
 * How hard a curveball is pulled sideways, in studs per second squared, toward
 * the thrower's left.
 *
 * A curve is not a launch angle — it is a force acting for the whole flight, so
 * this is an **acceleration** (studs/s²), not a velocity. There is no "how fast
 * does it go sideways" number to eyeball, so these are the formulas.
 *
 * **The maths.** The pull is perpendicular to the throw, so it never touches the
 * in-plane flight: the flat solve runs exactly as `straight` runs it, and the
 * sideways offset rides on top of it. With the flight time `T` that
 * {@link THROW_CURVE_ANGLE} sets, the two ways to fly it are one line each:
 *
 * ```
 * compensated:    bow   = a·T² / 8
 * uncompensated:  drift = a·T² / 2       (4× as far)
 * ```
 *
 * On level ground at the curve's own {@link THROW_CURVE_ANGLE} those reduce to
 *
 * ```
 * bow ≈ a·d / 2156       drift ≈ a·d / 539       tan φ = a·tan θ / g
 * ```
 *
 * so **`a ≈ 2156·B/d` for a bend of `B` studs**, the coefficients being what
 * gravity and the launch angle make of the ratio. A bow is therefore the same
 * *fraction* of the distance travelled, and the launch leaves the aim line wide
 * by `φ` at every range — which is why a bend can be chosen once and hold
 * whether the target is near or far.
 *
 * **That launch angle is geometry, not tuning.** Written as `d·tan φ / 4`, the bow
 * and the launch's off-line angle are revealed as one quantity: with both ends of
 * the flight pinned to the mark, the only way to bow is to leave wide of it.
 * {@link THROW_CURVE_ANGLE} cannot change that — it decides how fast and how long
 * the flight is, not how far it bends. See {@link THROW_CURVE_COMPENSATED} if a
 * side-armed launch is not the look you want.
 *
 * **This number is also the curve's speed.** The sideways launch the compensation
 * needs adds to the throw rather than replacing any of it — `v_lat = ½·a·T` — so
 * a large `a` leaves the hand mostly sideways and the curve reads as the fastest
 * throw in the game rather than the slowest. That is the trap this value was
 * tuned around: the in-plane flight can be slow while the total velocity is not.
 *
 * The sign is a handedness, not a direction: positive bends left, left being
 * relative to the throw, so it stays correct whichever way you are facing — see
 * `leftAxis` in `shared/Trajectory.ts`.
 */
export const THROW_CURVE_ACCELERATION = 300;

/**
 * Whether a curveball's launch cancels its own drift, so it lands on the mark.
 *
 * - `true` (the default): the launch leaves the aim line wide by `φ` and the pull
 *   brings it back. The ball arrives where the marker is, and the visible bend is
 *   its deviation from the straight line.
 * - `false`: the launch goes straight at the target, the pull carries the ball
 *   off it, and it lands `a·d/539` studs short of the aim point. The aim guide's
 *   marker moves with it, so the guide is still showing the truth — it is the
 *   throw that changed, not the honesty.
 *
 * Off is the natural-looking version: aimed at the target and visibly bending
 * away from it, instead of slung wide and swung back in. What it gives up is the
 * guarantee that every arc lands on the same mark — a curveball becomes a place
 * you aim off, not a place you point at.
 *
 * **Flipping this changes what {@link THROW_CURVE_ACCELERATION} looks like by
 * 4×.** To keep the same visible bend across the flip, divide it by 4 — and read
 * that constant's comment for where the factor comes from.
 */
export const THROW_CURVE_COMPENSATED = true;

/**
 * How far a dodge moves the model, in studs.
 *
 * Applied by the server, which is the only machine that can move a model; the
 * client only says *which way*, because it is the only machine that can see the
 * keys. So this is the one place the size of a dodge is decided.
 *
 * Read together with {@link DODGE_DURATION}: a dodge is specified as a distance
 * covered in a time, because the distance is the thing you can see on the field
 * and a speed is not. The speed the physics is actually handed is derived from
 * the pair — see {@link DODGE_SPEED}.
 *
 * **These comments describe relationships, not readings.** No figure here
 * restates another constant's value, so tuning one cannot leave the rest
 * contradicting the code.
 */
export const DODGE_DISTANCE = 20;

/**
 * How long a dodge takes, in seconds.
 *
 * Read with {@link DODGE_DISTANCE}: the distance is what the move is measured by,
 * so this sets how *fast* the dash covers it rather than how far it goes. Long
 * enough to read as a committed step, short enough that nothing can steer
 * through it.
 */
export const DODGE_DURATION = 0.2;

/**
 * Speed the dash is driven at, in studs per second.
 *
 * Derived, not tuned: {@link DODGE_DISTANCE} over {@link DODGE_DURATION}. Change
 * either of those and this follows, which is why the figure is never quoted in
 * prose.
 *
 * It is a velocity because it is applied as one — a `LinearVelocity` constraint
 * on the root part, held for the duration and then destroyed — rather than a
 * `PivotTo` that puts the model somewhere new in a single step. A model that has
 * been *moved* is still trying to walk wherever the humanoid was taking it and
 * walks back; a model that is *moving* has nothing to walk back from.
 */
export const DODGE_SPEED = DODGE_DISTANCE / DODGE_DURATION;

/** How long a model must wait before it can dodge again, in seconds. */
export const DODGE_COOLDOWN = 1.5;

/**
 * How long the client gives you to double-tap a movement key, in seconds.
 *
 * Client-side only, and a *timing* rather than a rule: the server never sees a
 * key press and does not care how the direction was chosen. Two taps of the same
 * key inside this window are one dodge request, sent once.
 */
export const DODGE_DOUBLE_TAP_WINDOW = 11.5;

/**
 * How long a catch attempt stays open, in seconds.
 *
 * An attempt is a *window*, not a catch: the press opens it, and the ball that
 * arrives inside it is the one caught. Long enough to cover a read of the throw,
 * short enough that it is a read rather than a shield — and one window catches
 * one ball, so holding the key buys nothing.
 */
export const CATCH_WINDOW = 0.4;
