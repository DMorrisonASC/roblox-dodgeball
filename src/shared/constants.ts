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
 * Attribute on a **`Player`** holding how much sprint stamina they have left, in seconds.
 *
 * On the player for the same reason as {@link DODGE_READY_AT}: the pool outlives the character, so
 * dying does not hand out a fresh one. Written by `WalkSpeedService` at a throttled rate rather than
 * on every change — see the note below — and read by `CooldownHudController`, which draws it as a
 * third bar beside the two cooldowns.
 *
 * **A level, where the two instants above are deadlines, and the difference is deliberate.** A
 * deadline has to be converted into a fraction against a clock the reader does not share exactly,
 * which is why {@link DODGE_READY_AT} is an instant and why its comment argues against sending a
 * duration. A stamina pool has no clock in it at all: the reader draws the value it is given, so
 * there is nothing to convert and nothing to go stale. The price is that this is a sample rather
 * than a prediction — up to one write interval behind — which on a three-second pool at ten writes
 * a second is a few per cent of a bar, and is the same order as the bar's own pixel width.
 *
 * The alternative, an instant like the two above, cannot describe the recovery pause: "refilling,
 * reaching full at T" is one value, and "stopped for another 0.3s and then refilling" is not — so
 * encoding that as a deadline needs a second attribute to say which of the two states the pool is
 * in. A level says both with one number, and the pause is simply the value not moving.
 */
export const STAMINA_ATTRIBUTE = "Stamina";

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
 * Attribute on {@link ROUND_STATUS_FOLDER}: which mode the round is being played as.
 *
 * The mode's **id** — a `GameModeId`, such as `"DodgeAndSeek"` — and not its display name, which
 * is what this used to carry. The id is the stable key: it is what a reader looks a mode *up* by,
 * and both the name shown on screen and the names of its two sides come from tables keyed by it
 * (`GAME_MODE_NAMES` and `MODE_SIDE_NAMES`, both in `shared/gameMode.ts`). Publishing the display
 * name instead would put the presentation on the wire and leave a client unable to look up
 * anything else about the mode it is being told about.
 *
 * Written when a vote **closes**, not when the round starts, and that is the useful moment: the
 * intermission following the vote is exactly when a player wants to know what they are about to
 * play, and a value written at the opening whistle would tell them a second too late. A reader
 * must therefore not assume it describes the round in progress — between the vote closing and the
 * round beginning it describes the round to come. It is also what a client uses to know which
 * mode's side names to ink a result with, so a stale value would mislabel a winner.
 */
export const ROUND_MODE_ATTRIBUTE = "Mode";

/**
 * Attribute on {@link ROUND_STATUS_FOLDER}: whether the vote is open right now.
 *
 * A boolean rather than a deadline on the shared clock, because the vote does not run on the
 * shared clock — it runs on the *intermission*'s, and that clock stops when a dev pauses rounds.
 * A reader given an instant it could subtract would draw a countdown that kept running while the
 * round it belongs to was held up.
 *
 * The HUD's whole reason for showing the buttons, and the only thing it needs: the options come
 * from {@link ROUND_VOTE_OPTIONS_ATTRIBUTE}.
 */
export const ROUND_VOTE_OPEN_ATTRIBUTE = "VoteOpen";

/**
 * Attribute on {@link ROUND_STATUS_FOLDER}: the modes the open vote is offering.
 *
 * The ids, comma-joined — see `encodeModeIds` in `shared/gameMode.ts` for why a string rather than
 * a list, and for the pair of helpers that keep the two sides of the encoding together.
 *
 * Published by the server from its own registry, which is what makes the client a renderer of
 * whatever the server can actually run: a mode that has been designed but not written is simply
 * absent from this string, so the button for it does not exist rather than existing and doing
 * nothing.
 */
export const ROUND_VOTE_OPTIONS_ATTRIBUTE = "VoteOptions";

/**
 * The stem of the attribute holding **how many votes one mode has** — the whole name is this plus
 * the mode's id; see {@link voteCountAttribute}.
 *
 * **One attribute per option rather than one holding them all**, which is the opposite of what
 * {@link ROUND_VOTE_OPTIONS_ATTRIBUTE} does with the same modes. The option list is one fact that
 * changes once a window, so it travels as one string; a count is one number per option and changes
 * on every vote, so each is its own key. What that buys is that the client can watch the option it
 * is drawing and nothing else — a vote for one mode repaints one label rather than all three — and
 * that a count stays a number instead of a digit inside a string somebody has to split.
 *
 * **Written for every option, zeros included.** "Nobody has voted for this yet" is then a number the
 * client reads rather than the absence of an attribute it has to learn to interpret — the same
 * reason {@link ROUND_VOTE_OPEN_ATTRIBUTE} is seeded shut rather than published late.
 */
export const ROUND_VOTE_COUNT_PREFIX = "VoteCount";

/**
 * The attribute name holding `id`'s vote count. See {@link ROUND_VOTE_COUNT_PREFIX}.
 *
 * **A function so that the name is built in one place.** The server writes these and the client
 * asks for them, and two concatenations of the same prefix are two places for a typo to sit and
 * still compile: a publisher writing `VoteCountDodgeAndSeek` against a reader asking for
 * `VoteCountsDodgeAndSeek` is a count that stays at zero for ever, silently.
 *
 * Takes a plain `string` rather than a `GameModeId`: this builds a *key*, and the id handed to it
 * has already been through `isGameModeId` or `decodeModeIds` by the time anyone does.
 */
export function voteCountAttribute(id: string): string {
	return `${ROUND_VOTE_COUNT_PREFIX}${id}`;
}

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

/**
 * Attribute on a **`Player`** holding how many times they have hit somebody with a throw.
 *
 * Written by `StatsService` when a record is loaded and again after every hit, and read by the
 * client's stats billboard — which is why it is on the **player** and not the character: the record
 * outlives every body it was earned in.
 *
 * **A round's count, not a session's.** Only a hit thrown while a round is being played reaches the
 * record — see `StatsService.isRoundActive` — so this figure and {@link STAT_OUTS} are counted under
 * one rule and can be read against each other.
 *
 * An attribute rather than a remote, for the reason the round's state is one: it replicates on its
 * own, so the HUD needs no remote, no reply to wait for, and no reference to the service that owns
 * the numbers.
 */
export const STAT_HITS = "StatHits";

/** How many times a player has been eliminated. See {@link STAT_HITS}. */
export const STAT_OUTS = "StatOuts";

/**
 * Hits over hits and outs together, from `0` to `1`, published beside the two counts by
 * `StatsService`.
 *
 * **Derived here and sent, rather than worked out by each reader.** Two readers dividing the same
 * two numbers is two chances to disagree about a player's own record, and a player with neither
 * figure has to read as `0` rather than as a division by zero — one rule, stated once.
 */
export const STAT_RATIO = "StatRatio";

/** Diameter of the ball, in studs. */
export const BALL_SIZE = 1.5;

