/**
 * How a character moves.
 *
 * A config of its own rather than a constant buried in the service, because a walk speed is the
 * kind of number that gets tuned — and because `WalkSpeedService` reads it but does not own it.
 */
export const CHARACTER_CONFIG = {
    /**
     * The base walk speed every character starts at, in studs per second.
     *
     * 16 is Roblox's own default, so this is a statement of "unchanged" rather than a new value —
     * the point is that it is now named and in one place, instead of being an implicit 16 that a
     * future `Humanoid.WalkSpeed = x` would silently replace.
     */
    BASE_WALK_SPEED: 100,
} as const;
