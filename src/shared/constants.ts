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
 * Tag marking an arena part as a barrier that stops **characters** and lets everything else through.
 *
 * **A name a person sets in Studio and code has to agree with**, which is what puts it next to
 * `BALL_NAME` rather than among the tags below it — this is not a label code puts on something, it
 * is a label somebody paints on a part in the place file. It is read in exactly one place
 * (`collision/CollisionGroups.ts`, as the map is placed) and that is a reason to keep its rules
 * here in its own comment, not to keep the constant private to that file.
 *
 * **`CanTouch` and `CanQuery` are load-bearing, and both are the counter-intuitive pair.** A ball
 * crossing this wall must not report a world contact — a `Touched` event would disarm it mid-flight
 * and score the throw as a miss — so the part is **`CanTouch = false`**. And the aim guide walks the
 * world with a spherecast, so **`CanQuery = false`** is what lets the preview pass through the wall
 * and go on telling the truth about where a throw will land. Turning either one back on to "make the
 * wall more solid" reintroduces both bugs: a wall the ball bounces off mid-arena, and a guide that
 * stops at the centre line. See `SoundEmitter`'s note on the same two flags, kept for the same
 * reason — and see `collision/CollisionGroups.ts` for this wall beside the other one.
 *
 * **This is not the arena's edge.** An edge wall is a `Default` part with all three of `CanCollide`,
 * `CanTouch` and `CanQuery` true and **no tag at all**: `Default` collides with `Default`, which is
 * exactly what stopping characters *and* balls means. Tagging one would invite a reader to route it
 * through this wall's code and silently take the balls out of it.
 */
export const CHARACTER_BARRIER_TAG = "CharacterBarrier";

/**
 * A lobby part that turns the custom shift lock on while a player stands inside it.
 *
 * **A label somebody paints on a part in the place file**, exactly like {@link CHARACTER_BARRIER_TAG}
 * above and for the same reason: the box is level design rather than a number, and moving it is a
 * Studio edit. Read in one place — `client/controllers/camera/ShiftLock.ts`, which checks it in every
 * phase, so a zone is a zone whenever a player is standing in one.
 *
 * **The part's dimensions *are* the zone.** There is no separate radius or extent: the check asks
 * whether any part of the local player's body overlaps the part's own box, so it is whatever size and
 * rotation the builder gave it. Any number of them may exist; a player inside any one of them is
 * inside the zone.
 *
 * **Anywhere in `Workspace`, and only in `Workspace`.** The check walks the whole tag with no path,
 * name or model assumed — loose at the top level, in a folder, inside a model, all of them count
 * equally, and nothing is expected to be called "Lobby". What it does *not* count is a part that is
 * outside the world: a tagged part in an arena that has been loaded but not yet placed is still
 * returned by `GetTagged` (a `Clone` copies its tags — the same fact `BallSpawnerService` had to guard
 * against), and its box would be evaluated at those coordinates anyway. So the part has to be a
 * descendant of `Workspace`, exactly as the spawners require. A box that is not in the world is not
 * somewhere a player can walk.
 *
 * **`CanTouch = false`, and that is not what stops the detection.** It is tempting to read it as
 * "this part is inert, so nothing will find the player in it" — the opposite is true. Nothing here
 * uses `Touched` at all: the check is a box overlap, which needs neither touch events nor collisions,
 * and `CanTouch = false` is there to stop the part generating touch events *at all* — an invisible box
 * that reported touches would be handing `Touched` to every ball, rig and character passing through it
 * for no reason. **`CanQuery = false`** is the other half, on the same reasoning as the barrier's: the
 * aim guide walks the world with a spherecast, and a zone would otherwise be something the preview
 * stopped on. Neither flag affects the overlap check.
 *
 * **No collision group**, unlike the barrier: this part is not meant to affect anything, and a group
 * would be a statement that it does.
 *
 * **A rename, and not an alias.** This was `SHIFT_LOCK_ZONE_TAG = "ShiftLockZone"` until the
 * practice-zone work. The old string is deliberately **not** accepted alongside the new one: a reader
 * that matched either would keep a half-repainted place file working for exactly as long as it took
 * somebody to notice, and what that hides is the failure this whole file exists to warn about — a tag
 * that stops matching goes quiet in the same way a working path does. So the value changed, the
 * constant's name changed with it, and a part still wearing the old string reads as **no zone at all**.
 * `[ShiftLock] up — N practiceZone part(s)` is the line that says which of the two you have.
 */
export const PRACTICE_ZONE_TAG = "practiceZone";

/**
 * Tag marking a place a mystery box appears.
 *
 * **Read by `server/services/mystery/MysteryBoxService.ts` alone**, and it is the second tag in this file
 * whose contract is "put it where you want the thing" — see {@link MATCH_SPAWNER_TAG}, which is the first.
 * The part is a *placement decision* and nothing more: the service reads where it is and puts a box there,
 * so a spawn point can be moved, regrouped or nested and it is still a spawn point.
 *
 * **`CanQuery = false` and `CanCollide = false` on the part, so a spawn point is not felt even though it is
 * somewhere players walk.** The aim guide's cast must pass through one, and nothing should be able to stand
 * on it. It needs no `CanTouch` — the *box* is what is touched, and the part itself never has to report
 * anything.
 *
 * **Inside a `practiceZone` a tagged part behaves differently, and that is a rule about where the part is
 * rather than about the part.** A spawn point in a zone is stocked continuously instead of rolled for, so
 * the same tagged part is a rare thing on the field and a fixture on a practice floor. The service does the
 * bounds test; nothing about the tag or the part changes.
 */
export const MYSTERY_SPAWN_TAG = "mysterySpawnPrize";

/**
 * Which power a collected mystery box is paying for, on the `Player`. Empty string for none.
 *
 * **Published by `SuperService`, which holds the prize, and written with the rest of that readout** — see
 * its `publish`. This is now the *whole* of the prize's publication: there is no clock behind it, because a
 * box's power is held until it is used or lost rather than for a fixed ten seconds, so this attribute is a
 * state rather than the start of a countdown. `MYSTERY_POWER_ENDS_AT_ATTRIBUTE` was the second half of the
 * pair and is gone with the timer it described.
 *
 * **A string rather than the row itself, because a client cannot read a `Map`.** The kind is one of the
 * words in `shared/ability.ts`, which is the same vocabulary the mark remote speaks — so a client that
 * already knows how to name an ability does not need to learn a second one to say what a box gave. The HUD
 * reads it for two things: what the power slot shows while a prize is held, and the moment the reveal flash
 * has to run — a change to a non-empty value is a pickup, and it is the only thing that starts one.
 */
export const MYSTERY_POWER_ATTRIBUTE = "MysteryPower";

/**
 * Marks a whitelisted dev, on the `Player`. Read as `=== true`, so an absent attribute means no.
 *
 * **The string `DevService` has always written, in the shared file so the client can read it without
 * spelling it a second time.** The client has to know *before* it binds a key, and one fact shared by two
 * machines written out twice is the copy this arrangement exists to avoid — `DevService` now imports this
 * name instead of defining its own. It is a `Player` attribute like the two above, read by anything that
 * can see the `Player`, which is the property `DevService` chose it for in the first place.
 *
 * **What a client is allowed to believe it means: which keys to listen for, and nothing else.** A key
 * bound on the strength of this attribute is a convenience for a developer. What any press actually does
 * is decided on the server, which asks `DevService.isDev` — reading this same attribute for itself — and
 * never trusts that this machine saw the flag at all.
 */
export const IS_DEV_ATTRIBUTE = "IsDev";

/**
 * Tags marking the two parts a player walks into to pick a side for the next match.
 *
 * **One tag per side, and the split is the whole rule: the part you touch is the side you ask for.**
 * There used to be one `MatchJoin` part, and the service placed whoever touched it on whichever side
 * was emptier — the player said "I would like to play" and `MatchService` chose the team. These two say
 * what the one part could not: **the player chooses**, by walking up to the sign they want, and
 * touching the *other* part moves them again until the match starts. A choice made by walking is one
 * visible in the lobby and needs no menu, which is why this is two parts rather than one part and a
 * prompt.
 *
 * **A label somebody paints on a part in the place file**, exactly like {@link CHARACTER_BARRIER_TAG}
 * and {@link PRACTICE_ZONE_TAG} above, and read in one place — `services/match/MatchService.ts`,
 * which decorates the part, connects its `Touched` and puts that side's counts sign above it.
 *
 * **`CanTouch = true` on both, and that is the exception rather than an oversight.** The barrier and
 * the zone are deliberately `CanTouch = false`, so that an invisible box does not hand touch events to
 * every ball that crosses it; these parts' whole job *is* the touch, so they are the case the other two
 * are the rule against. `CanQuery = false` for the reason both of them have it — the aim guide casts
 * through the world, and a lobby prop must not be what the preview stops on. `CanCollide = false`,
 * because a lobby is somewhere people walk.
 *
 * **And `Anchored = true`, which the old lobby spawn was not.** That part walked off the bottom of the
 * world and the engine destroyed it at `FallenPartsDestroyHeight`, with no Lua on the stack and nothing
 * in the output — the failure these parts must not repeat. `MatchService` sets all four from code and
 * warns when it has had to, so the trap is a line in the log rather than an afternoon.
 *
 * **A side's own part, and nothing else.** These say *which side*, not *which match*: the roster is
 * still cleared at the end of every match, so a player picks again next time, and both tags are read
 * by the server only — nothing on the client needs to know which part is which side.
 */
export const MATCH_JOIN_A_TAG = "MatchJoinA";

/** The other side's part. See {@link MATCH_JOIN_A_TAG}. */
export const MATCH_JOIN_B_TAG = "MatchJoinB";

/**
 * Tag marking a piece of arena that keeps match balls beside it.
 *
 * **A marker, and the only thing read from it is where it is.** `BallSpawnerService` puts one ball
 * beside each tagged part while a match is running, so a spawner is a *placement decision* — where the
 * balls should be — and placing one is done in Studio by tagging a part, with nothing to write and
 * nothing to register. Several are independent, and the tag is how the loop finds them all without
 * being told about any of them. It reads the part's `Position` and `Size` and nothing else, so the
 * part needs to be somewhere a ball can lie rather than shaped in any particular way.
 *
 * **Named for the match, and that is the whole reason for the name.** The tag used to be
 * `BallSpawner`, which said nothing about *which* game wanted the balls — and a practice court wants
 * its own floor stocked without a match running, so that service needs a tag of its own. Naming this
 * one for the context it belongs to is what leaves room for the second, and it had to be done before
 * the second existed rather than after: a rename once two services read the tag is a rename with a
 * broken half in the middle.
 *
 * **A label somebody paints on a part in the place file**, exactly like {@link CHARACTER_BARRIER_TAG}
 * and {@link PRACTICE_ZONE_TAG} above — and, like the join tags below, it may equally be put on a
 * folder, because every reader goes through `taggedPartsInWorkspace`, which expands a container into
 * the parts inside it.
 *
 * **`Anchored = true`, which the old lobby spawn was not, and the three flags off.** That part walked
 * off the bottom of the world and the engine destroyed it at `FallenPartsDestroyHeight`, with nothing
 * in the output — the failure a spawner must not repeat, because a part that has fallen is a part with
 * no balls beside it and no evidence that anything went wrong. `CanCollide`, `CanTouch` and `CanQuery`
 * are all `false` so that a floor marker is not something to walk into, is not handed touch events it
 * has no use for, and is not what the aim guide's spherecast stops on.
 *
 * **Nothing sets any of that from code**, unlike the join parts — the spawner only reads the part — so
 * these are the flags to give it in the place file.
 */
export const MATCH_SPAWNER_TAG = "MatchSpawner";

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
 * Attributes on the **`RoundStatus` folder** holding each side's points, as numbers.
 *
 * **The one thing about a Score Rush round the client was never told.** `RoundService.scores` has been a
 * server-side `Map<TeamLabel, number>` since the mode was written — written on every hit and every catch,
 * read only to `print` a line and by the mode itself, and never published. There was no scoreboard because
 * there was nothing to draw one from.
 *
 * **Two attributes rather than one joined string or a folder of two children.** `ROUND_TIME_ATTRIBUTE` and
 * `COINS_ATTRIBUTE` are both bare numbers, and a reader of this wants a number rather than a string to split;
 * a folder would be a second instance to create, hold and clean up for two integers. The pair is written
 * together on every change — see `RoundService.publishScores` — so no reader sees one side newer than the
 * other.
 *
 * **`A` and `B` rather than a team name, because the sides are not teams.** A round is two arbitrary sides
 * whose *names* change per mode (`MODE_SIDE_NAMES`) and whose colours do not (`TEAM_COLORS`: A is red and B is
 * blue in every mode); `TEAM_A`/`TEAM_B` are the stable labels underneath both, and these names use them for
 * the same reason the server's own map is keyed by them.
 */
export const ROUND_SCORE_A_ATTRIBUTE = "ScoreA";

/** The other side's points. See {@link ROUND_SCORE_A_ATTRIBUTE}. */
export const ROUND_SCORE_B_ATTRIBUTE = "ScoreB";

/**
 * Attribute on {@link ROUND_STATUS_FOLDER}: **a count of the transitions the server has started**, bumped
 * the instant before it moves everybody.
 *
 * **A counter of its own rather than the phase, and the reason is the whole point of it.** The phase is
 * published *early* on purpose: an intermission announces itself before the lobby is even looked up, because
 * a phase that is held must not read as the previous one (`RoundService` says so at length). The teleport
 * then happens later — after the lobby resolves, after the held balls and the map are dealt with — so a wipe
 * keyed on the phase would play and finish inside that gap and cover nothing at all. This is written
 * immediately before the move instead, which is what lets the client's cover close *around* the cut rather
 * than after it.
 *
 * A number rather than a boolean because the count is the useful part: **any change is a transition**, so a
 * client needs no notion of which phase it is moving between, and a client that mounts mid-transition simply
 * reads a value and waits for the next one.
 */
export const ROUND_TRANSITION_ATTRIBUTE = "Transition";

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
 * There used to be a `SPECTATING_ATTRIBUTE` here — "`Spectating`", on the `Player` — and it is worth a
 * line of its own to say why there is not one now, because its absence is a decision rather than a gap.
 *
 * **Spectating was removed, not renamed or moved.** `RoundService` set it for a player whose character
 * died during a round and for one who joined while a round was already under way, and the client's only
 * use of it was to hide the ability readouts and show "You're out — spectating". Score Rush respawns, so
 * a dead player re-enters rather than sitting the round out, and the flag was the reason a player could
 * idle instead of play. The two remaining facts it stood for are both already published elsewhere and
 * neither needs an attribute: *who is in the round* is `RoundService`'s `activePlayers` (server-side,
 * never replicated) and *a round is being played* is `ROUND_STATE_ATTRIBUTE` on the status folder.
 *
 * **So a client can no longer tell "a round is on" from "I am in it", and that is the accepted cost.**
 * See `panels.ts`'s `sessionHudVisible`, which now gates on the phase or a practice zone and nothing
 * else, and says what that means for a player who is out of the round.
 */

/**
 * Attribute on a **`Player`** saying their body is standing inside a practice zone right now.
 *
 * Written by `PracticeZoneService`, which is the zone's owner on this side: it is the only thing that
 * runs the bounds test, and every rule that cares about the zone reads this rather than asking the
 * question again. **A fact rather than a query** is the whole point — the dodge gate can then afford
 * to check it, the dock can watch it, and a ball's contact handler can consult it without any of them
 * paying for a `GetPartBoundsInBox` walk on their own hot path.
 *
 * On the player rather than the character, for the reason every other player attribute is: a character
 * is replaced on respawn, and standing in a zone outlives the body that happened to be standing there.
 * The service re-detects and re-publishes on `CharacterAdded`, so a body that respawns inside the zone
 * keeps the fact rather than waiting for the next tick to relearn it.
 *
 * The client reads it too — `DockController` for the dock, and it is what `roundZone.ts` is expected to
 * become the source for. The client's own bounds test lives on because the camera needs an answer on
 * its own tick rather than at replication's, and the two can differ by at most the tracker's interval.
 */
export const PRACTICE_ZONE_ATTRIBUTE = "PracticeZone";

/**
 * Attribute on a **`Player`** holding the instant their next body arrives, on the engine's shared clock.
 *
 * **An instant rather than a countdown, and on the player rather than on a folder**, which is the shape the
 * action cooldowns already use: `RespawnService` writes `Workspace:GetServerTimeNow() + the delay`, and the
 * client subtracts the same clock per frame — so the readout is smooth, needs no remote, and cannot drift
 * from the timer it is describing. `0` is the empty case, which every reader treats as "no body is on its
 * way" rather than as a countdown of zero.
 *
 * **Written and cleared by one service**, so the three moments a wait can end — the timer firing, the round
 * ending, the player leaving — are three lines in `RespawnService` rather than a rule each caller keeps.
 */
export const RESPAWN_AT_ATTRIBUTE = "RespawnAt";

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
 * Attribute on a **ball** naming the super ability it is carrying, or `""` for an ordinary ball.
 *
 * Written in two places and read in three, which is the whole of its life:
 *
 * - **Written** by `BallService.markHeldBall`, when the player holding the ball presses the ability
 *   key — and by `BallService.attachToHand`, which *clears* it. That clear is the load-bearing half:
 *   a ball arriving in a hand is an ordinary ball again, whether it arrived by catch, by pickup or by
 *   a hand-out, so a mark cannot survive into a throw nobody asked for.
 * - **Read** by `abilityOn`, which is the only reader that decides anything; by `BallService`'s drop
 *   and throw paths, which are the two ways a marked ball can leave a hand and therefore the two that
 *   decide what the mark cost — the throw spends, the drop forfeits — and they are also why a box's
 *   prize is spent on the *throw* and not on the press: `SuperService.spendMysteryPrize` is called from
 *   the throw path, for a dev's throw as much as anybody's; and by the HUD, which says which ability is
 *   loaded.
 *
 * **On the ball rather than on the player, because the ability belongs to the *throw* and not to the
 * thrower.** A player can hold a charge and an ordinary ball at the same time, and the ball is the
 * thing that flies. It is also what makes the forfeit rule survivable: a marked ball that is dropped
 * is destroyed, so a mark cannot be carried over to the next ball by accident.
 *
 * `""` rather than removing the attribute, which is the convention `ThrowerId` already uses — an
 * empty string is one case for a reader to handle, where an absent attribute is two.
 */
export const BALL_ABILITY_ATTRIBUTE = "BallAbility";

/**
 * Attribute on a **`Player`** saying an ability is armed and waiting for a ball to carry it, or `""`.
 *
 * **The dev shortcut's state, and the reason it is on the player rather than the character.** A dev in
 * Studio has no ball to mark and often no round to mark one in, so the ability is armed *before* there
 * is anything to put it on — and an arm on the character would be thrown away by the first death,
 * which is precisely the moment somebody testing something is most likely to hit. On the player it
 * survives a respawn, and it survives a round ending: it is cleared by the ball that takes it up and
 * by nothing else. See `BallService.attachToHand` for where it moves onto a ball, and `markHeldBall`
 * for where it is set.
 *
 * **One string, so one arm at a time, and that is deliberate rather than incidental.** Arming Pierce
 * and then arming something else *replaces* it rather than queueing behind it: an arm means "this is
 * what the next ball will be", and the next ball can only be one thing. A list would be a claim that
 * a ball can carry several abilities at once, which nothing here implements.
 *
 * `""` for no arm, the convention {@link BALL_ABILITY_ATTRIBUTE} uses, so every reader has one empty
 * case instead of two.
 */
export const ARMED_ABILITY_ATTRIBUTE = "ArmedAbility";

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

/**
 * Attribute on a **`Player`** holding how many hits in a row they are currently on.
 *
 * Written by `SuperService` on every change to the streak and read by the super HUD, which is why it
 * is on the **player**: a run of hits outlives the body it was earned in, and dying is one of the
 * things that *ends* a streak rather than something that should take the readout with it.
 *
 * **Sent even though a client could count hits itself, because it could not count *these* hits.**
 * Only a throw made during a round counts, a throw that lands on nobody breaks the run, and whether a
 * throw landed on anybody at all is something only the ball's own contact knows — so a client-side
 * count would be a second implementation of a rule, free to disagree with the one that grants the
 * charge.
 */
export const SUPER_STREAK_ATTRIBUTE = "SuperStreak";

/**
 * Attribute on a **`Player`** saying they are holding a charge — one earned ability, not yet used.
 *
 * A boolean rather than a count, because only one is ever held: reaching the target while already
 * holding one grants nothing further, and the rule that says so lives where the target is reached.
 *
 * Beside {@link SUPER_STREAK_ATTRIBUTE} and for its reasons, including the one about the pair: they
 * are two halves of one readout, and a reader that saw a new streak beside a stale charge would be
 * showing a state that never existed.
 */
export const SUPER_CHARGE_ATTRIBUTE = "SuperCharge";

/**
 * Attribute on a **`Player`** saying they are wearing the crown — three hits, or the most on their side.
 *
 * **On the player rather than on the body**, for {@link SUPER_STREAK_ATTRIBUTE}'s reason and for one
 * more: the crown is derived from a count that outlives a body, so putting it on the character would
 * mean recomputing a server-side answer in every client the moment somebody respawned. Here a respawn
 * costs nothing at all — the player keeps the attribute, and the client's only job is to hang a new
 * `BillboardGui` on the new head.
 *
 * **A boolean rather than the count**, because the count is already published beside it: a client that
 * wanted to answer the question for itself would need every other player's count *and* side, and two
 * clients could then disagree about who is hot. The server decides, and this is the decision.
 */
export const CROWN_ATTRIBUTE = "Crown";

/**
 * Attribute on a **`Player`** holding how many coins they own.
 *
 * Written by `EconomyService` when a record loads and after every change, and read by the client's
 * coin readout — which is why it is on the **player** and not the character: the wallet outlives every
 * body it was filled in. An attribute rather than a remote, for the reason `STAT_HITS` gives: it
 * replicates on its own, so the HUD needs nothing to ask and nothing to wait for.
 *
 * **A number, never negative.** Every write is clamped to at least nought, so a reader that renders
 * the raw value cannot draw a debt that does not exist.
 */
export const COINS_ATTRIBUTE = "Coins";

/**
 * Attribute on a **`Player`** holding everything they own that affects gameplay, as one `|`-joined string.
 *
 * **`OwnedPowers` until the record folded powers into items**, and that is a rename of the *fact* rather
 * than a tidy-up: this attribute has always meant "what the server says you own", and the record field it
 * is published from is now `items` — one set holding the three powers today and whatever else
 * gameplay-affecting arrives, with no new attribute and no second packed string for it.
 *
 * **Both sides ship together, so changing the wire name costs nothing worth protecting.** An older client
 * is not a case to carry: it would ask for `OwnedPowers`, find no such attribute, and read its own
 * collection as empty — which is the same answer it already gives for "not published yet".
 *
 * **A packed string rather than one attribute per item**, so adding an item costs nothing here and an
 * unowned one is simply a word that is absent. The delimiter is private to `shared/economy.ts`, which is
 * the only reader and writer; the empty case is `""` — "owns none of them" — rather than an absent
 * attribute.
 *
 * **Ownership, not loadout.** What a player *owns* is permanent and decided by the server; which one is
 * on the ball in their hand is `BALL_ABILITY_ATTRIBUTE`, a different fact on a different instance. A
 * reader that means *powers* specifically asks for one by name — `shared/economy.ts`'s `ownsPower` is that
 * question, and with this set wider than powers it is the only honest way to ask it.
 */
export const OWNED_ITEMS_ATTRIBUTE = "OwnedItems";

/**
 * Attribute on a **`Player`** holding the subset of their powers the item box may grant, as one
 * `|`-joined string.
 *
 * **The same shape as {@link OWNED_ITEMS_ATTRIBUTE}, and deliberately not the same attribute.** What a
 * player *owns* is permanent and decided by the server; what the *box may give them* is a choice they
 * make and can change — the distinction `OWNED_ITEMS_ATTRIBUTE` already draws between ownership and the
 * ball in somebody's hand, applied to a second question. It is separate because the two facts have
 * different lifetimes and different authors: ownership only ever grows and only the server writes it,
 * while a pool shrinks and grows again and the player is the one deciding.
 *
 * **The empty string is a real value and means "the box has nothing to give".** Unlike the equipped
 * attributes, where `""` means "no cosmetic", there is no default to fall back to here: the pool *is*
 * the player's decision, and turning every power off is one of the states it can be in. The server always
 * writes it from the record, so `""` on a player who has loaded is never "not published yet" — see
 * `EconomyService.publish`.
 *
 * Joined with the same helper the owned set uses, `joinItems` in `shared/economy.ts`, because this is
 * the same *kind* of value: a set of `AbilityKind` packed into one attribute. A second packing convention
 * for the same data would be a second thing to keep in step for no gain.
 */
export const POWER_POOL_ATTRIBUTE = "PowerPool";

/**
 * Attribute on a **`Player`** holding the cosmetic ids they own, as one `|`-joined string.
 *
 * The same shape as {@link OWNED_ITEMS_ATTRIBUTE} and for its reason: one packed string means a new
 * cosmetic costs no new attribute, and the empty case is `""`. Earnable and premium items share the
 * one id space, so this says *which ids* without saying how each was obtained.
 */
export const OWNED_COSMETICS_ATTRIBUTE = "OwnedCosmetics";

/**
 * Attribute on a **`Player`** holding the trail cosmetic they have equipped, or `""` for the default.
 *
 * **One attribute per slot rather than one packed string, which is the opposite of the call
 * {@link OWNED_COSMETICS_ATTRIBUTE} makes — and the difference is what the value *is*.** Ownership is a
 * *set*: several ids at once, so packing them into one string is the only way to keep them in one
 * attribute. Equipped is a *choice*, one id per slot, so a packed string would have to carry the slot as
 * well as the id — a second delimiter and a second convention inside `shared/economy.ts`, which is the
 * file whose whole job is to be the one place a shape is agreed. An attribute whose *name* is the slot
 * and whose *value* is the id needs neither.
 *
 * **`""` is a real value here rather than an absent attribute.** It means "no cosmetic — the default",
 * and it is written rather than removed so that `EquippedTrail = ""` and no such attribute at all are
 * not two spellings of one fact. That is the empty-string convention `BALL_ABILITY_ATTRIBUTE` and a
 * ball's `ThrowerId` already use.
 *
 * **Published by `EconomyService`, read by the Inventory panel, written by nobody else.** The server is
 * the only writer for the reason `OWNED_ITEMS_ATTRIBUTE` gives: what a player wears is decided by the
 * record the client cannot reach.
 */
export const EQUIPPED_TRAIL_ATTRIBUTE = "EquippedTrail";

/**
 * Attribute on a **`Player`** holding the elimination cosmetic they have equipped, or `""`.
 *
 * The elimination slot's own attribute, on {@link EQUIPPED_TRAIL_ATTRIBUTE}'s terms: stored and
 * published today, drawn nowhere yet, because no elimination cosmetic has a render path. See
 * `EconomyService.equipCosmetic` for why the state is still written.
 */
export const EQUIPPED_ELIMINATION_ATTRIBUTE = "EquippedElimination";

/**
 * Attribute on a **`Player`** holding the balls left in their MultiBall window, or `0` for no window.
 *
 * **`0` means "no window", which is one empty case rather than an absent attribute beside a present
 * one** — the convention `BALL_ABILITY_ATTRIBUTE` and `ARMED_ABILITY_ATTRIBUTE` already use.
 *
 * **On the player, because a MultiBall window is the player's rather than any ball's.** Nothing a ball
 * carries can say whether its thrower still has a window open, so this is the only thing a player can
 * read about the ability — and now it is the *whole* of what there is to read.
 *
 * **It used to be published beside a deadline**, `SUPER_MULTI_BALL_ENDS_AT_ATTRIBUTE`, which carried the
 * `Workspace:GetServerTimeNow()` instant the window closed so a HUD could count down to it. The window
 * has no clock any more — it lasts until the count is spent, whatever that takes — so that attribute is
 * gone and this one is no longer half of a pair. **The consequence for a reader is that a non-zero count
 * is now the only signal that a window is running**, which is why the power slot draws the MultiBall
 * icon from this number rather than from anything about a prize: see `SuperHudController`.
 */
export const SUPER_MULTI_BALL_COUNT_ATTRIBUTE = "SuperMultiBallCount";

/** Diameter of the ball, in studs. */
export const BALL_SIZE = 2;

/**
 * Attribute on a **character `Model`** saying that the server has a dodge or catch window open on it.
 *
 * **The one thing a client cannot work out for itself, which is why it is published at all.** A window is
 * opened and closed by `DodgeService` and `CatchService` — a dash's `DURATION`, a catch's window, and the
 * early exits from both — and none of it reaches a client as state. A client that wanted to know would have
 * to re-derive those rules from its own input and from the cooldown stamps, which is the second copy of a
 * server rule this project does not keep. So the server says so instead, from `afterimage.ts` — the one
 * function that already knows a window has opened. See `startAfterimage` and `publishWindow`.
 *
 * **On the character rather than on the player**, which is the opposite of `THROW_ENABLED`'s choice and for
 * the opposite reason: a throw preference has to survive a death, and a window must not. An attribute on the
 * body dies with the body it describes, so there is no state to clear on a respawn and none a new body could
 * inherit from an old one.
 *
 * **Absent means "no window", and only a body a player owns is ever given one** — a rig has no client
 * watching it, and a catching rig opens a window every tick. Written `false` when a window closes rather than
 * removed, so a reader compares against a value instead of interpreting a nil.
 */
export const AFTERIMAGE_WINDOW_ATTRIBUTE = "AfterimageWindow";

/**
 * Attribute on a **ghost `Model`** naming the player whose body it was copied from, by `UserId`.
 *
 * **How a client finds the server's copies of its own trail so it can hide them.** The trail of a player's
 * own body exists twice — built on their client for their screen, built on the server for everybody else's —
 * and both arrive on the dodger's own screen, so one of them has to be hidden there. This is the only thing a
 * ghost carries that says whose it is, and it is a `UserId` rather than a name because a rig and a player can
 * share a name. See `AfterimageController`.
 *
 * **Absent means "no player's body"**, which covers every rig's ghost and every player's ghost during the
 * frames before this has replicated — both of which read as "not mine", so no client ever hides a rig's
 * trail and a late attribute hides rather than doubles.
 */
export const AFTERIMAGE_SOURCE_ATTRIBUTE = "AfterimageSource";

