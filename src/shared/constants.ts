/**
 * Name of the ball part that gets welded to a player's hand and then thrown.
 *
 * Shared so the client can tell whether the local player is currently holding
 * a ball (and therefore whether a click should throw one).
 */
export const BALL_NAME = "DodgeballBall";

/** Diameter of the ball, in studs. */
export const BALL_SIZE = 2;

/**
 * How far in front of the thrower the ball starts its flight, in studs.
 *
 * Measured along the throw direction from the thrower's head, so it clears the
 * body no matter which way you aim. Raise it if the ball still clips you.
 */
export const THROW_CLEARANCE = 3;

/**
 * Speed the ball leaves the hand at, in studs per second.
 *
 * Shared because the client's aim guide has to predict the same arc the server
 * is actually going to throw. Change this and both sides move together.
 */
export const THROW_SPEED = 100;
