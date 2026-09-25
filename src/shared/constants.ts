/**
 * The names and keys that more than one file has to agree on: what the ball is called, the
 * attributes a ball, a player and the round carry, and the folder the round's state is
 * published on.
 *
 * Everything a person would change to alter how the game *feels* lives in
 * `shared/config/` instead — the ball and its throws in `ball.config.ts`, the
 * dash in `dodge.config.ts`, the catch in `catch.config.ts`, the round in
 * `arena.config.ts`.
 *
 * What is left here is what code has to *agree* on rather than choose: a part name
 * several files match against, and an attribute key. Those are not tuning
 * choices. `BALL_SIZE` is the one number in here, and it is here because it
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
 * Attribute on a **`Player`** holding the server-time instant at which their next dodge is allowed.
 *
 * `Workspace:GetServerTimeNow()` seconds, written by `DodgeService` at the moment a dodge is
 * *accepted*. A refused dodge writes nothing — it was not charged for — so a reader watching this
 * attribute sees the bar restart only when the clock really did.
 *
 * An *instant* on the shared clock rather than a remaining time, because the reader can subtract it
 * from its own reading of that same clock. A duration would be as stale as the moment it was sent,
 * and an attribute carries no send time to correct it by.
 */
export const DODGE_READY_AT = "DodgeReadyAt";

/**
 * Attribute on a **`Player`** holding the server-time instant at which their catch counts as ready
 * again.
 *
 * Written by `CatchService` when a catch window opens or is extended, and it covers the window
 * **plus** `ACTION_CONFIG.ACTION_LOCKOUT_SECONDS` — the tail after a catch in which a dodge is
 * refused. So the bar this feeds is the span the two actions share rather than a lock on catching:
 * a catch is possible again before the instant passes, because the tail shuts the *dodge*.
 *
 * On the player for the same reason as {@link DODGE_READY_AT}: a character is replaced on every
 * death and these clocks are not.
 */
export const CATCH_READY_AT = "CatchReadyAt";

/**
 * The `ReplicatedStorage` folder the round's state is published on.
 *
 * **The HUD's whole channel.** `RoundService` writes the two attributes below on it and the
 * client reads them; nothing is ever sent, because attributes replicate on their own — so the
 * HUD needs no remote and no reference to the service that owns the round, and the round needs
 * no reference to the HUD. A folder by this name in `ReplicatedStorage` is the agreement.
 */
export const ROUND_STATUS_FOLDER = "RoundStatus";

/**
 * Attribute on {@link ROUND_STATUS_FOLDER}: which phase the round is in.
 *
 * The value is the phase's *name* as text — the one vocabulary the HUD has — so a reader can
 * print it without knowing what any of the phases mean. The names are the members of
 * `RoundState` by convention rather than by construction; they are written by hand in
 * `RoundService`.
 */
export const ROUND_STATE_ATTRIBUTE = "State";

/**
 * Attribute on {@link ROUND_STATUS_FOLDER}: whole seconds left in the phase.
 *
 * Written when the phase's clock is set and again after every second comes off it, so a reader
 * is never more than a tick behind. It does **not** move while rounds are paused — a stopped
 * countdown is the honest reading of a paused round, and nothing has to tell the client that.
 */
export const ROUND_TIME_ATTRIBUTE = "TimeRemaining";

/**
 * Attribute on {@link ROUND_STATUS_FOLDER}: who won the round that has just ended.
 *
 * A team's label, or `"draw"` — the same two words `RoundService` prints, because the round's
 * vocabulary is its own business and this is only a channel for it. Written when a round is
 * decided and left standing through the intermission that follows, which is where it is read; a
 * reader must not assume it means anything *during* a round, and the HUD does not.
 */
export const ROUND_WINNER_ATTRIBUTE = "Winner";

/**
 * Attribute on a **`Player`** saying they are out of the round in progress and watching it.
 *
 * Written by `RoundService`: set for a player whose character dies during a round, and for one
 * who joins while a round is already under way — both are spectators of a round they are not in.
 * Cleared for everybody when the next round opens and they are in it, which is what makes the
 * indicator disappear at the start of a round rather than at any moment of its own.
 *
 * On the player rather than the character for the reason every other player attribute is: a
 * character is replaced on respawn, and being out of a round outlives the body it happened to.
 */
export const SPECTATING_ATTRIBUTE = "Spectating";

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
export const BALL_SIZE = 1.5;

