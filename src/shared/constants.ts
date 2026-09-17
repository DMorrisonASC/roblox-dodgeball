/**
 * Name of the ball part that gets welded to a player's hand and then thrown.
 *
 * Shared so the client can tell whether the local player is currently holding
 * a ball (and therefore whether a click should throw one).
 */
export const BALL_NAME = "DodgeballBall";

/** Diameter of the ball, in studs. */
export const BALL_SIZE = 1;

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
 * reach. Maximum range at this speed is `v² / g`, about 51 studs.
 *
 * This is the *base* speed, not the final one — a throw that needs to reach
 * further is wound up automatically, up to {@link THROW_MAX_SPEED}.
 */
export const THROW_SPEED = 100;

/**
 * How much faster than the bare minimum a throw is launched, as a multiplier.
 *
 * This one number does two jobs.
 *
 * **It separates the two throw modes.** For a given speed there are exactly two
 * launch angles that reach a point, and they always sum to 90°. Throwing at
 * `1.0x` the minimum collapses them into a single arc; the further above, the
 * wider they spread. At 1.4x a level target is met at roughly 23° (the straight
 * throw) and 67° (the overhead one).
 *
 * **It keeps the solve off a numerical knife edge.** At exactly 1.0x the
 * discriminant is zero and the target sits precisely at the arc's limit, so the
 * whole answer swings on floating-point noise in the launch point. That was a
 * real bug here: the landing marker wandered on long throws and sat still on
 * short ones. Do not take this below about 1.05.
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
 * furthest reachable target is about 204 studs — past that a throw falls short
 * and the aim guide's landing marker shows you exactly where.
 */
export const THROW_MAX_SPEED = 280;
