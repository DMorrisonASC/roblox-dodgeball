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
 * measured along the direction the torso is facing.
 *
 * This is the one number to change to move the launch point. It is read in
 * exactly one place — `shared/throw.ts` → `getThrowMuzzle` — which both the
 * server (real throw) and the client (aim guide) call, so tuning it moves both
 * together and the guide keeps telling the truth.
 */
export const THROW_MUZZLE_DISTANCE = 5;

/**
 * Speed the ball leaves the hand at, in studs per second, for any target within
 * reach. Maximum range at this speed is `v² / g`, about 51 studs.
 *
 * This is the *base* speed, not the final one — a throw that needs to reach
 * further is wound up automatically, up to {@link THROW_MAX_SPEED}.
 */
export const THROW_SPEED = 100;

/**
 * Ceiling on that automatic wind-up, in studs per second. Maximum range at this
 * speed is about 204 studs.
 *
 * Past that a throw can't reach, and the ball falls short — which the aim
 * guide's landing marker shows you before you commit to it.
 */
export const THROW_MAX_SPEED = 200;
