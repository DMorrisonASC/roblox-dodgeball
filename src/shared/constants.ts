/**
 * The ball's identity: the name the part carries, the attribute a thrower is
 * stamped with, and the size it is made at.
 *
 * Everything a person would change to alter how the game *feels* lives in
 * `shared/config/` instead — the ball and its throws in `ball.config.ts`, the
 * dash in `dodge.config.ts`, the catch in `catch.config.ts`, the round in
 * `arena.config.ts`.
 *
 * What is left here is what code has to *agree* on rather than choose: a part name
 * several files match against, and an attribute key. Those are not tuning
 * choices. `BALL_SIZE` is the one number of the three, and it is here because it
 * is what the ball *is* rather than how it behaves — the aim guide's spherecast
 * radius and the solve's aim offset are both derived from it.
 */

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

/**
 * Attribute on a **`Player`** saying whether their clicks may throw.
 *
 * Read by the throw handler in `BallService` and written by the `2` key. On the player
 * rather than the character because it is a *preference*: a character is replaced on every
 * death, and a setting that switched itself back on when you respawned would be worse than
 * not having one — you would die, click, and throw while still looking for the ball.
 *
 * **Only an explicit `false` blocks.** A player who has never pressed the key has no
 * attribute and throws as before, so there is no default to write anywhere and no state
 * that can get stuck in a value nobody chose.
 */
export const THROW_ENABLED = "ThrowEnabled";

/**
 * Attribute on a **`Player`** naming the team they are on for the round in progress.
 *
 * Written by `RoundService` at the start of every playing phase, and read by anything that
 * needs to know who is on which side — a HUD, a per-team spawn. An attribute rather than a
 * service field for that reason: the answer is visible to the client without a remote, and it
 * survives the player's character being replaced, which a character attribute would not.
 *
 * The value is a team label, and the two are `"A"` and `"B"`. A player between rounds — or
 * one who joined while a round was already under way — has no attribute at all, which is how
 * a reader tells "not playing" from "playing for somebody".
 */
export const TEAM_ATTRIBUTE = "Team";

/**
 * Attribute on a **ball** holding the `os.clock` time before which nobody may pick it up.
 *
 * Written by `BallService.dropBall`, read by `BallPickupService`. On the ball rather than
 * on the player who dropped it, because it is the *ball* that needs the beat — it is in
 * the air and has not settled — so somebody else walking over it inside the window is
 * blocked by it too. A per-player table would have said the opposite of what the window
 * is for.
 */
export const PICKUP_LOCKED_UNTIL = "PickupLockedUntil";

/** Diameter of the ball, in studs. */
export const BALL_SIZE = 1;

