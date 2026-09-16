/**
 * Shared network constants.
 *
 * The actual RemoteEvents are created by the server (`BallService`) and
 * fetched by the client (`ThrowController`). These constants keep the two
 * sides in sync without duplicating magic strings.
 */
export const REMOTES = {
	folder: "Remotes",
	throwBall: "ThrowBall",
} as const;
