/**
 * Name of the ball part that gets welded to a player's hand and then thrown.
 *
 * Shared so the client can tell whether the local player is currently holding
 * a ball (and therefore whether a click should throw one).
 */
export const BALL_NAME = "DodgeballBall";

/** Diameter of the ball, in studs. */
export const BALL_SIZE = 3;

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
 * Speed the ball leaves the hand at, in studs per second.
 *
 * Shared because the client's aim guide has to predict the same arc the server
 * is actually going to throw. Change this and both sides move together.
 */
export const THROW_SPEED = 100;
