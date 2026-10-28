import { Players, Workspace } from "@rbxts/services";
import { events } from "shared/networking";
import { DEBUG_LOGGING, logDebug } from "shared/logger";

/**
 * **The hit-disagreement probe: two lines, printed at the only two moments that can decide whether a hit
 * that landed behind a body was lag, a sweep, or a picture.**
 *
 * ## The problem it exists to answer, stated the way the report stated it
 *
 * A ball is simulated by the server and a player's body is simulated by that player's client. Nothing
 * reconciles the two: no remote carries a player's position, no rewind runs at the tag. Three mechanisms
 * follow from that, and this file cannot tell them apart on its own — it needs four numbers, printed at the
 * instant the server decides a contact was a hit.
 *
 * ## What it prints, and where the two calls sit
 *
 * - `tagged` — from `BallComponent.handleTouch`, immediately after `hitModels.set(character, struck)`. **The
 *   tag is the frame the hit was *decided***; the death is not until the ball lands, which is `resolved`.
 * - `resolved` — from `BallComponent.resolveTags`, immediately before `registerHit`. This is where a tag
 *   becomes damage, a `hitImpact` and a death.
 *
 * Both print one line each, both are behind `DEBUG_LOGGING` (`DEBUG_CONFIG.VERBOSE_LOGS`, which ships off),
 * and **neither changes a value, a return or an order**. With the flag off the whole cost of this file is one
 * `Map` allocation and two calls that return on their first line.
 *
 * ## The four numbers, and how to read them
 *
 * | pattern | verdict |
 * |---|---|
 * | `|client−body|` ≈ 2.5–5 studs **and** `|ball−body|` ≤ 2.75, `owner=nil` | **candidate 1** — replication lag, nothing else |
 * | `|ball−body|` > 2.75, the ball already ahead of the body along its velocity | **candidate 4** — a swept `Touched` |
 * | `|client−body|` ≈ 0 while the ball the client *drew* is still short of the body | **candidate 5** — the picture, not the physics (this pass cannot produce that line; see below) |
 * | `owner` is a `UserId` at the tag | **candidate 3** — a client-owned ball in flight, which the source says cannot happen |
 * | `resolved`'s body far from `tagged`'s body, with `|ball−body|` ≤ 2.75 at the tag | **candidate 7a** — tagged there, killed here |
 *
 * **`|client−body|` is the new instrument and the only one that needed a client half.**
 * `client/positionEcho` reports the local body's `HumanoidRootPart.Position` ten times a second on this same
 * clock, so a sample has an *age*; `≈ 2.5–5 studs` is what a body at `DODGE_SPEED` (75 studs/s) covers in
 * one to two replication steps. The body half of the comparison is `struck.Position` — the part the engine
 * reported — because that is the part whose position decided the tag.
 *
 * **What this cannot print, and why it is deliberate.** The *drawn* ball's position is a client render fact:
 * it would need the ball's own local `CFrame` echoed the same way, and the ball is a server-owned instance
 * whose client-side interpolation is the thing in question. That is the next pass's job if candidate 5 is
 * live; this file reports what it can prove rather than guessing at the rest.
 *
 * **A rig has no echo and cannot have one** — the server owns a rig's body outright, so its position is not
 * in dispute. The line prints `n/a` for both client columns when the victim has no `Player`, which is itself
 * the diagnosis for a rig hit: what is left is `|ball−body|`, and that is candidate 4's number alone.
 */

/** One client sample: where its own body was, and the server clock it read at the time. */
interface EchoSample {
	position: Vector3;
	sampledAt: number;
}

/** One tag: when it was decided, and the part that decided it. */
interface TagRecord {
	at: number;
	part: BasePart;
}

/**
 * The last sample from each player.
 *
 * Keyed on the `Player` rather than on the character, because a character is replaced on every death and a
 * sample that outlived its body would be a position from a previous life. The character is only read through
 * the player at print time, so a stale sample for a body that has already been replaced is caught by the
 * comparison itself — the two positions would be metres apart and the line would say so.
 */
const echoes = new Map<Player, EchoSample>();

/**
 * Every tag still owed a resolution, by ball and then by body.
 *
 * **Two levels rather than one, which is the one place this deviates from the obvious shape.** A `Map` keyed
 * on the ball alone would hold one timestamp for a throw that tagged two bodies — and a Pierce ball tagging
 * three does exactly that — so `tagAge` would report the *last* tag's age for every body in the list. The
 * inner map is per body, which is what a tag actually is.
 */
const tagTimes = new Map<BasePart, Map<Model, TagRecord>>();

/**
 * The balls this probe has already hung its cleanup on.
 *
 * **One connection per ball, not one per throw.** A ball is a long-lived instance — `scheduleBallExpiry` gives
 * it ten seconds and a caught one is somebody's — so it can be tagged, resolved and tagged again, and a
 * `Destroying`/`AncestryChanged` pair connected on each of those would accumulate for as long as the ball did.
 * The entry is dropped with the ball's tags.
 */
const watched = new Set<BasePart>();

/** `(x, y, z)` to one decimal, which is the resolution a stud needs to be read at all. */
function where(position: Vector3): string {
	return (
		`(${string.format("%.1f", position.X)}, ${string.format("%.1f", position.Y)}, ` +
		`${string.format("%.1f", position.Z)})`
	);
}

/** `nil` for the server, or the `UserId` that owns the ball — the answer candidate 3 turns on. */
function ownerOf(ball: BasePart): string {
	const owner = ball.GetNetworkOwner();

	return owner !== undefined ? tostring(owner.UserId) : "nil";
}

/**
 * Opens the client half of the measurement: the echo receiver, and the sample map behind it.
 *
 * Called from `main.server.ts` beside `startSpawnShield`, and returns immediately when the logs are not
 * verbose — which is the shipped state, so in a published game this function does nothing at all.
 */
export function startHitDisagreementProbe(): void {
	if (!DEBUG_LOGGING) return;

	events.Server.OnEvent("positionEcho", (player, position, sampledAt) => {
		// **Typed on arrival, because the wire is not.** A client can send anything, and a value that is not a
		// `Vector3` reaching the subtraction below would be an error inside a diagnostic — the one failure
		// mode a probe must not have, since it would look like the hit path had broken.
		if (!typeIs(position, "Vector3") || !typeIs(sampledAt, "number")) return;

		echoes.set(player, { position, sampledAt });
	});

	Players.PlayerRemoving.Connect((player) => echoes.delete(player));

	logDebug(`[HitProbe] up — four numbers per tag, printed only while the logs are verbose`);
}

/**
 * Records one tag and prints where everything was when the server decided it.
 *
 * Called from `BallComponent.handleTouch` immediately after `hitModels.set`. See the file's own table for
 * what the printed numbers mean; nothing here decides anything.
 */
export function tagged(victim: Model, part: BasePart, ball: BasePart): void {
	if (!DEBUG_LOGGING) return;

	const now = Workspace.GetServerTimeNow();

	let tags = tagTimes.get(ball);
	if (tags === undefined) {
		tags = new Map();
		tagTimes.set(ball, tags);
		watchBall(ball);
	}

	tags.set(victim, { at: now, part });

	const player = Players.GetPlayerFromCharacter(victim);
	const echo = player !== undefined ? echoes.get(player) : undefined;

	const clientDistance = echo !== undefined ? `${string.format("%.1f", echo.position.sub(part.Position).Magnitude)} studs` : "n/a";
	const clientAge = echo !== undefined ? `${string.format("%.2f", now - echo.sampledAt)}s` : "n/a";
	const ballGap = string.format("%.1f", ball.Position.sub(part.Position).Magnitude);

	logDebug(
		`[HitProbe] ${victim.Name}: tag t=${string.format("%.2f", now)} body=${where(part.Position)} ` +
			`ball=${where(ball.Position)} |ball-body|=${ballGap} |client-body|=${clientDistance} ` +
			`clientAge=${clientAge} owner=${ownerOf(ball)} ` +
			`speed=${string.format("%.1f", ball.AssemblyLinearVelocity.Magnitude)} studs/s`,
	);
}

/**
 * Prints where the body and the ball were when the tag became a death, and drops the record.
 *
 * Called from `BallComponent.resolveTags` immediately before `registerHit`. **This is the line that answers
 * candidate 7a**: the tag's `body=` is where the contact happened, and this one's is where the body is now.
 * They are the same position for a ball that landed on the frame it tagged, and they are a dash apart for a
 * ball that bounced off and flew for a second — which is exactly the case a player describes as *"it hit me
 * after I had already moved"*.
 */
export function resolved(victim: Model, ball: BasePart): void {
	if (!DEBUG_LOGGING) return;

	const now = Workspace.GetServerTimeNow();

	const tags = tagTimes.get(ball);
	const record = tags?.get(victim);

	const tagAge = record !== undefined ? `${string.format("%.2f", now - record.at)}s` : "n/a";
	const body = record !== undefined ? record.part.Position : ball.Position;

	logDebug(
		`[HitProbe] ${victim.Name}: resolve t=${string.format("%.2f", now)} body=${where(body)} ` +
			`ball=${where(ball.Position)} tagAge=${tagAge}`,
	);

	if (tags === undefined) return;

	tags.delete(victim);
	if (tags.isEmpty()) tagTimes.delete(ball);
}

/**
 * Drops a ball's tags when the throw stops being one.
 *
 * **Both signals, because "this throw is over" has two shapes and neither covers the other.** A destroyed
 * ball fires `Destroying`; a ball that was *caught* is re-parented into the catcher's hand and its tags are
 * released rather than resolved — `BallComponent` clears the list and nothing calls `resolved` — so an entry
 * would sit on the ball until it was thrown and tagged again, and would then print an age from a previous
 * throw. A ball reaching `Workspace` in the other direction is a ball being handed out, which is the start of
 * a throw rather than the end of one, and it carries nothing.
 */
function watchBall(ball: BasePart): void {
	if (watched.has(ball)) return;

	watched.add(ball);

	const forgetTags = () => tagTimes.delete(ball);

	// **The connections outlive a throw and die with the ball**, which is why only this one drops the ball from
	// `watched`: a ball that has left the world cannot be tagged again, and its connections go with it.
	ball.Destroying.Connect(() => {
		forgetTags();
		watched.delete(ball);
	});

	ball.AncestryChanged.Connect(() => {
		if (!ball.IsDescendantOf(Workspace)) forgetTags();
	});
}
