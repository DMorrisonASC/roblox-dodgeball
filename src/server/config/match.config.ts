/**
 * Matchmaking: how many players a match takes, how many a side may hold, and the sign's own numbers.
 *
 * **Server-side, unlike `arena.config.ts`, because nothing on the client counts.** These are the
 * server's rules about who may play; the only thing a client ever sees is the finished sentence on the
 * sign, and a client that could compute the counts itself would be a second answer to the same
 * question. The same reading `OUTLINE_CONFIG` gets — it sits in `src/server/config/` for the same
 * reason.
 *
 * Every number here is a **Placeholder**, and the two that matter are meant to be changed: the cap is
 * the size of a match, and the minimum is what the dev command refuses below.
 */

/**
 * How many players a match needs before it can start. **Placeholder — 2.**
 *
 * **A floor on the total, and the per-side rule is separate.** `MatchService.canStart` also insists on
 * at least one player a side, because a one-sided match is not a match — so at `2` the two rules say
 * the same thing and this one only bites at the margin. It is here rather than folded into the
 * per-side test because raising it is the natural thing to want later ("four before we bother"), and
 * that change should be one number in this file.
 */
export const MATCH_MIN_PLAYERS = 2;

/**
 * How many players one side may hold. **Placeholder — 4, which makes a match 4v4.**
 *
 * **The cap is per side, so this is also the size of the largest match** — and it is enforced at the
 * part rather than at the start, which is the point of choosing a side by walking: the fifth player to
 * walk into the `A` sign is refused by that sign and told to try the other part, which is something they
 * can act on where they stand rather than a check somewhere else later. The sign prints it, so raising
 * it changes the label and the rule in one edit.
 */
export const MATCH_MAX_PER_TEAM = 4;

/**
 * How many balls a match puts out, across every spawner in the arena. **Placeholder — 8.**
 *
 * **Currently equal to `MATCH_MAX_PER_TEAM × 2`, and deliberately not written that way.** Two sizes
 * that happen to agree are two sizes that will stop agreeing without anybody noticing: raising the cap
 * to five a side would quietly raise the ball count to ten, which is a change to the *arena* made by
 * an edit to a *roster rule*. They are two decisions, so they are two numbers.
 *
 * **It is the ceiling rather than the supply.** Each spawner part puts out one ball — see
 * `BallSpawnerService.tick` — so the budget only bites when there are more spawner parts than this;
 * below that the parts are the limit. It is counted from the balls that exist rather than tallied as
 * they are made, so a ball destroyed on impact is replaced and the count cannot drift.
 */
export const MATCH_BALL_COUNT = 8;

/**
 * How long a character is ignored after touching a join part, in seconds. **Placeholder — 0.5.**
 *
 * **`Touched` fires per body part, which is the whole reason this exists.** A body standing in the part
 * reports a touch for each of its parts, in the same frame and again as it moves about — so without a
 * debounce one step into the sign would be six opt-ins. Half a second is long enough that a body
 * walking through cannot beat it and short enough that stepping out and back in on purpose still works.
 *
 * **One window covering both parts, not one per part,** because the mark is a tag on the character
 * rather than on the sign it touched. A player who crosses straight from the `A` sign into the `B` one
 * inside this window therefore gets one event rather than a side switch, which is deliberate: it stops a
 * walk through both signs from picking a side at random. The price is the same walk when it is meant —
 * a switch wants a pause between the two touches.
 */
export const MATCH_TOUCH_DEBOUNCE_SECONDS = 0.5;

/**
 * How long a startable roster must sit still before the sides start the match by themselves.
 * **Placeholder — 5.**
 *
 * **A settle window rather than a trigger, and that is the whole of the rule.** A match starts when the
 * sides have been startable *and unchanged* for this long — so the clock begins the moment the second
 * player steps onto the empty side, and any further change puts it back to zero. That grace period is
 * what keeps "pick your side" alive: a player can cross from the `A` pad to the `B` one without the
 * match firing out from under them, because every touch, move and departure restarts the window.
 *
 * **Five seconds because the walk it has to cover takes about two.** A switch is a short journey across
 * a lobby, and the one this project's own logs measured — one pad at 15:02:17.1, the other at
 * 15:02:19.3 — took 2.3 seconds. The window has to be comfortably longer than that, or a player who
 * changes their mind mid-crossing is locked out by their own footsteps; doubling it also covers the
 * debounce, which swallows a second touch inside half a second.
 *
 * **It is counted on the intermission's own ticks**, so the real wait is this plus up to one tick — see
 * the loop in `RoundService`. Both ends are worth knowing: lowering it towards zero makes a match start
 * as soon as both sides have somebody (at `0`, on the very next tick), and raising it only delays every
 * match.
 */
export const MATCH_SETTLE_SECONDS = 5;

/**
 * How far the sign can be read from, in studs. **Placeholder — 500, which is further than any lobby.**
 *
 * **Set generously on purpose, and it is the opposite of the stats board's number.** That billboard is
 * deliberately short-ranged because it is a label about a body you are standing near; this is a sign
 * telling you where the part is, so it wants to be legible from across the room.
 */
export const MATCH_SIGN_MAX_DISTANCE = 500;

/** How far above the part the sign floats, in studs. **Placeholder — 8**, clear of a character. */
export const MATCH_SIGN_OFFSET_Y = 8;

/** The sign's size. **Placeholder — one line of text at two and a bit times a caption's height.** */
export const MATCH_SIGN_SIZE = new UDim2(0, 220, 0, 64);

/** The sign's type size, in pixels. **Placeholder — 30**, sized to be read across a lobby. */
export const MATCH_SIGN_TEXT_SIZE = 30;
