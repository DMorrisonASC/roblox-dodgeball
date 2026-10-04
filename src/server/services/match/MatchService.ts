import { OnStart, Service } from "@flamework/core";
import { Players, ReplicatedStorage } from "@rbxts/services";
import { MATCH_JOIN_A_TAG, MATCH_JOIN_B_TAG, ROUND_STATE_ATTRIBUTE, ROUND_STATUS_FOLDER } from "shared/constants";
import { taggedParts } from "shared/taggedParts";
import {
	MATCH_MAX_PER_TEAM,
	MATCH_MIN_PLAYERS,
	MATCH_SIGN_MAX_DISTANCE,
	MATCH_SIGN_OFFSET_Y,
	MATCH_SIGN_SIZE,
	MATCH_SIGN_TEXT_SIZE,
	MATCH_TOUCH_DEBOUNCE_SECONDS,
} from "../../config/match.config";
import { TEAM_A, TEAM_B, TeamLabel } from "../round/team";

/** Prints every opt-in, refusal and opt-out. The sign is player-facing; this is the record. */
const DEBUG = true;

/** What `ROUND_STATE_ATTRIBUTE` says while a match is being played. A word between two files. */
const PLAYING = "Playing";

/**
 * The two join parts, and the side each one asks for.
 *
 * **A table rather than two code paths at each end**, because "this tag means this side" is asked in
 * three places — finding the parts, binding each `Touched` to its side, and the sign above it — and one
 * list is the single place a Roblox tag string and a `TeamLabel` are said to be the same thing. A third
 * side would be a third line here and nothing else.
 */
const JOIN_PARTS: ReadonlyArray<{ readonly tag: string; readonly team: TeamLabel }> = [
	{ tag: MATCH_JOIN_A_TAG, team: TEAM_A },
	{ tag: MATCH_JOIN_B_TAG, team: TEAM_B },
];

/** The sign's name in the tree, and the one under it. Named so the Explorer says what they are. */
const SIGN_NAME = "MatchJoinCounts";
const SIGN_LABEL_NAME = "Counts";

/**
 * The tag put on a character that has just used a join part, for the debounce.
 *
 * **A tag rather than a table or a timer**, which is this codebase's own answer to "this thing is in
 * this state right now": `BallSpawnerService` marks a ball `RoundBall` and takes the tag off as it lets
 * go, `NpcService` gates a behaviour on `HasTag`, and `RespawnBehavior` strips and re-adds tags as it
 * rebuilds a rig. The property that matters here is that the tag lives on the *character* — so a body
 * that dies mid-debounce takes the mark with it and nothing has to remember to tidy up.
 *
 * **One tag for both parts, and that is a tag being a name rather than a part.** The mark suppresses
 * touches of *either* sign, which is the behaviour that was asked for: brushing the `A` sign and then
 * the `B` one inside the window is one event rather than two, so a side switch is a deliberate step
 * rather than something a fast walk through both signs can do by accident. The cost is the mirror of it
 * and worth stating: a player who genuinely walks straight from one sign to the other inside
 * `MATCH_TOUCH_DEBOUNCE_SECONDS` is ignored, and has to come back for the second touch to land.
 */
const DEBOUNCE_TAG = "MatchJoinTouched";

/** How many players are on each side. A sign's whole content, and half of `canStart`. */
export interface MatchCounts {
	readonly a: number;
	readonly b: number;
}

/**
 * How many of `counts` are on `team`.
 *
 * **The one place a side is read out of the pair**, so the three readers that need it — `hasRoom`,
 * `sideText` and `describeCounts` — cannot disagree about which field `A` is.
 */
function sideCount(team: TeamLabel, counts: MatchCounts): number {
	return team === TEAM_A ? counts.a : counts.b;
}

/**
 * Matchmaking: who has asked to play, and the part they ask with.
 *
 * **Opt-in rather than auto-join, and that is the whole of this service's reason to exist.** A player in
 * the lobby is not in a match: they are not on a side, they are not in the round's roster, and the only
 * way in is to walk into one of the two tagged join parts. The alternative — putting everybody in the
 * lobby on a team at the opening whistle, which is exactly what the round used to do — makes the lobby a
 * waiting room people are drafted out of rather than a place they choose to leave, and it cannot express
 * "I am only practising" at all. Everything below follows from that one decision: the roster is a map
 * this service owns, the round reads it instead of the player list, and the signs exist so that roster
 * is visible before a match starts rather than only when it has.
 *
 * **The player picks the side, and can change their mind until the whistle.** Touching the `A` part asks
 * for `A` and touching the `B` part asks for `B`; somebody already placed is *moved* by touching the
 * other part, and the only two refusals are a full side and a match already under way. That is the
 * change from the single join part, which placed whoever touched it on whichever side was emptier — the
 * old rule was this service choosing, and the thing a player actually wants to say ("I want to be on
 * Sam's side") had no way to be said. It also means the sides may be lopsided on purpose, which is
 * correct: the roster is what the players asked for, `canStart` is still the only thing that says
 * whether a match may begin, and the counts on the two signs let a dev see a 4v1 and ask somebody to
 * move.
 *
 * **A match starts when the sides are ready and have stopped moving, and the waiting is the round's.**
 * `canStart()` answers "could a match begin"; nothing here acts on the answer, because starting a match
 * is the round's business and this service does not know what a round is — `RoundService` samples
 * `canStart` and {@link rosterRevision} once an intermission tick and asks for a match once the roster
 * has held still for `MATCH_SETTLE_SECONDS`. See the loop in `RoundService` for the window, and
 * `RoundService.requestMatch` for the door a dev uses when they would rather not wait.
 *
 * **That delay is not timidity — it is what keeps the paragraph above true.** A match that began the
 * instant the second player touched a pad would end the picking at the moment it first became possible:
 * the player who had just chosen a side could never change it, and the last person to arrive would be
 * deciding for everybody. The settle window buys back exactly the walk it takes to cross from one pad to
 * the other, and no more.
 *
 * **It does not know what a round is.** The phase it reads comes off the status folder in
 * `ReplicatedStorage` — the same attribute the HUD reads — so nothing here calls `RoundService` and no
 * constructor of either service points at the other. That is the arrangement `BallSpawnerService`
 * already has, and for the same reason: a service that asked the round directly would be a
 * construction-order dependency, and "both parts are inert while a match is on" is a fact about the game
 * rather than about boot order.
 *
 * **The round does the starting and the leaving.** This service answers who may play and how the sides
 * stand; `RoundService` decides when a match is, reads {@link roster} to fill its teams, and calls
 * {@link clear} when the match is over. Nothing here moves a player or knows where the lobby is.
 */
@Service()
export class MatchService implements OnStart {
	/**
	 * Who has opted in, and the side they are on.
	 *
	 * **One map rather than two lists**, because "which side is this player on" and "is this player
	 * waiting for a match" are the same question — a player in here is on a side, and a player not in
	 * here is not playing — so a second structure would be a second answer that could disagree with the
	 * first.
	 *
	 * **The side is no longer fixed by the first touch, and the map absorbs that without changing
	 * shape.** While this service was choosing sides, the entry was written once and read thereafter;
	 * now touching the other part rewrites it, and that rewrite *is* the side switch. A move is one
	 * `set`, so `countsFor`, `roster` and `clear` are all still correct without knowing a move can
	 * happen — which is the reason to keep one map rather than splitting "who is playing" from "which
	 * side" and having to keep two structures in step.
	 */
	private readonly opted = new Map<Player, TeamLabel>();

	/**
	 * How many times the roster has changed over the session.
	 *
	 * **A counter, because the counts cannot answer the question it exists for.** `RoundService` wants to
	 * know whether the roster it is looking at is the same roster it looked at a second ago, so that it can
	 * start a match once the sides have *stopped* changing — and `countsFor` answers that wrongly, because
	 * the change that matters most, a player crossing from `A` to `B`, leaves the counts identical. A number
	 * that only ever goes up is the smallest thing that cannot be fooled that way, and it needs no clock on
	 * either side: the round samples it and remembers what it saw.
	 *
	 * **Every mutation bumps it** — a placement, a move, a removal, a clearing — because the settle window
	 * is waiting for the picking to be over, not for the counts to look a particular way.
	 */
	private revision = 0;

	/**
	 * The round's status folder, kept once it has been found.
	 *
	 * **Found lazily rather than waited for**, because nothing here runs at boot: the folder is made by
	 * the server's `RoundService.onStart`, and this service has no reason to yield for it — the first
	 * touch happens long after it exists. Caching it is what keeps {@link phase} free of a lookup per
	 * touch without an `onStart` that waits — the arrangement `BallSpawnerService` makes for the same
	 * folder and the same reason.
	 */
	private statusFolder?: Folder;

	/**
	 * The counts label above each tagged part, and the side that label is about.
	 *
	 * **A list rather than the single label the project's other billboards keep**, because a tag is a
	 * label somebody can put on more than one part and this is the one place that would notice: the
	 * roster is one roster, and every sign of it has to keep up.
	 *
	 * **The side travels with the label, and that pairing is what the type is for.** Since the split
	 * into two parts the signs no longer say the same thing — the `A` part's label is `A: n/4` and the
	 * `B` part's is `B: m/4` — so a bare `TextLabel[]` would leave `updateSigns` unable to tell which
	 * count a label wanted, and a side switch, which is the one event that changes *both* numbers,
	 * would repaint them with each other's.
	 */
	private readonly signs = new Array<{ readonly team: TeamLabel; readonly label: TextLabel }>();

	public onStart(): void {
		// **A leaver cannot be in the next match, and their side's count has to drop the moment they go.**
		// This is the whole of what the connection is for: the roster is the sign's content, and a sign
		// that still counted somebody who has left would be lying to everybody still standing in the lobby.
		Players.PlayerRemoving.Connect((player) => this.optOut(player, "they left"));

		this.mount();
	}

	// ---- What the round asks ----

	/**
	 * The roster: every player who has opted in, and the side they are on.
	 *
	 * **A read-only view, and that is the contract rather than a type flourish.** The round reads this to
	 * fill its own team table; a round able to *write* to it would be a second place deciding who is
	 * playing, which is the same split `RoundService.playersInRound` makes from the other side. Nothing is
	 * copied, because nothing is stored twice — this map *is* the roster.
	 */
	public roster(): ReadonlyMap<Player, TeamLabel> {
		return this.opted;
	}

	/**
	 * How many times the roster has changed, ever.
	 *
	 * **For the one reader that has to tell "the same roster" from "a new one".** `RoundService` samples
	 * this once an intermission tick to know whether the sides have stopped changing, so that a match can
	 * start on its own; see `MATCH_SETTLE_SECONDS`. Nothing else needs it, and nothing should write to it —
	 * the only thing that moves the number is a mutation of the roster itself.
	 *
	 * Read this rather than {@link countsFor} for that question. A player moving from one side to the other
	 * is a change to the roster and a no-op to the counts, and the move is the case the window is about.
	 */
	public rosterRevision(): number {
		return this.revision;
	}

	/** How many players are on each side. */
	public countsFor(): MatchCounts {
		let a = 0;
		let b = 0;

		for (const [, team] of this.opted) {
			if (team === TEAM_A) a++;
			else b++;
		}

		return { a: a, b: b };
	}

	/**
	 * Whether a match could start right now: enough players, and a side that is not over its cap.
	 *
	 * **Three questions, and each of them is a different refusal to explain.** The total is
	 * {@link MATCH_MIN_PLAYERS}, then one player a side — because a match with one side in it is not a
	 * match — and then the cap, which cannot currently be exceeded (a side refuses a player rather than
	 * growing) and is checked anyway because this is the method a caller asks "may a match start", and an
	 * answer that assumed its own caller's bookkeeping would be the wrong place to save a comparison.
	 *
	 * **Two callers, and they want different things from the same answer.** `RoundService.requestMatch`
	 * asks it in order to refuse a dev with a sentence naming what was missing, and the intermission's
	 * settle window asks it once a tick to decide whether the roster is ready to start a match on its own.
	 * Neither is told *why* the answer was no, which is deliberate: the refusal a player reads is written
	 * by the caller that has a player to name.
	 */
	public canStart(): boolean {
		const counts = this.countsFor();

		if (counts.a + counts.b < MATCH_MIN_PLAYERS) return false;
		if (counts.a < 1 || counts.b < 1) return false;

		return counts.a <= MATCH_MAX_PER_TEAM && counts.b <= MATCH_MAX_PER_TEAM;
	}

	/**
	 * Puts `player` on the side they asked for, moves them if they asked for the other one, or refuses.
	 *
	 * **The player picks the side; this only decides whether the pick is allowed.** `side` is the part
	 * they walked into, so there is no balancing here at all — no smaller side first, no fallback to the
	 * other side. That was the single-part rule, where the service had to choose because the touch said
	 * nothing about a team; now the touch says everything, and a service that quietly redirected somebody
	 * to the emptier side would be overruling the one piece of information the player gave it. The sides
	 * are therefore allowed to be lopsided, and `canStart` is what says whether a match may begin.
	 *
	 * **The refusals and the no-op, in the order they are asked.**
	 *
	 * 1. **The match has started** — `RoundStatus.State` is `Playing`, so both parts are inert and the
	 *    roster is locked. This is refused *before the roster is read*, so a mid-match touch cannot even
	 *    see who is on a side, let alone move them. The line is printed rather than swallowed because a
	 *    part that does nothing reads as a broken part, and the moment a player is most likely to try is
	 *    the moment they are watching a match they are not in.
	 * 2. **Already on the requested side** — a no-op with no print. They are where they asked to be, and a
	 *    line saying so would be noise on every brush past the part.
	 * 3. **The requested side has room** — placed, or *moved* if they were standing on the other side.
	 *    A move is one `set`: the side they left loses a player and the side they joined gains one, and
	 *    both signs are repainted by {@link updateSigns} because the switch changed both numbers.
	 * 4. **The requested side is full** — refused with a line naming the side, and **nothing moves**: a
	 *    player already on the other side stays there, and a player with no side stays with none.
	 *    Falling back to the other side would be the old balancing rule wearing a new hat, and it would
	 *    put somebody on a side they did not ask for.
	 *
	 * The returned side is the one they are on after the call — the requested side on every path except
	 * a refusal — so a caller never has to ask again.
	 */
	public optIn(player: Player, side: TeamLabel): TeamLabel | undefined {
		// **The lock, and the reason it is asked first.** A switch is allowed only while sides are still
		// being picked, and this service learns that from the phase the round publishes rather than by
		// asking the round — see the class doc. Nothing below runs on this path, deliberately: no read of
		// the roster, no print about counts, no chance of a half-made move.
		if (this.phase() === PLAYING) {
			if (DEBUG) print(`[Match] ${player.Name}: the match has started — the roster is locked`);

			return undefined;
		}

		const existing = this.opted.get(player);
		if (existing === side) return existing;

		const counts = this.countsFor();

		if (!this.hasRoom(side, counts)) {
			if (DEBUG) print(`[Match] ${player.Name}: side ${side} is full — try the other part`);

			return undefined;
		}

		this.opted.set(player, side);
		this.revision++;
		this.updateSigns();

		if (DEBUG) {
			const now = this.describeCounts();

			// Two sentences rather than one, because "in" on a second touch would be a lie: the log is the
			// record of the roster, and a move is a different fact from an arrival.
			if (existing === undefined) print(`[Match] ${player.Name}: in — side ${side}, ${now}`);
			else print(`[Match] ${player.Name}: moved to side ${side}, ${now}`);
		}

		return side;
	}

	/**
	 * Takes `player` out of the roster, if they are in it.
	 *
	 * Called from two places, with the reason named in each: a player leaving the game, and the end of a
	 * match. Nothing else removes anybody — in particular a player who dies keeps their place, because
	 * being out of *one round* and being out of the *match* are not the same thing in a mode that
	 * respawns its dead.
	 */
	public optOut(player: Player, reason: string): void {
		const team = this.opted.get(player);
		if (team === undefined) return;

		this.opted.delete(player);
		this.revision++;
		this.updateSigns();

		if (DEBUG) print(`[Match] ${player.Name}: out — ${reason} (${this.describeCounts()})`);
	}

	/**
	 * Empties the roster and repaints the signs.
	 *
	 * **The end of a match, and the reason every player has to touch the part again.** A roster that
	 * survived its match would be a match waiting to happen the moment a dev asked for the next one —
	 * with the same players, whether or not they were still in the lobby and whether or not they wanted
	 * another. Clearing it makes opting in a decision per match, which is what opt-in means.
	 */
	public clear(): void {
		if (this.opted.size() === 0) return;

		this.opted.clear();
		this.revision++;
		this.updateSigns();

		if (DEBUG) print(`[Match] roster cleared — ${this.describeCounts()}`);
	}

	// ---- The join parts ----

	/**
	 * Finds the tagged parts of both sides, makes them safe to touch, and puts a sign on each.
	 *
	 * **One pass per side, so each tag's line stands on its own.** A single pass over both tags would
	 * have to say "3 tagged things" without saying *which* part is missing, and a missing part is the
	 * failure this print exists to catch.
	 */
	private mount(): void {
		for (const { tag, team } of JOIN_PARTS) this.mountSide(tag, team);
	}

	/**
	 * One side's tag: prepare every part carrying it, and report what the tag found.
	 *
	 * **The parts come from `taggedParts`, so the tag can go on the pad or on a folder holding it.** A
	 * container wearing the tag is expanded into the parts inside it, which is the reading anyone
	 * building the lobby would expect; the warning that used to stand here — telling the reader the tag
	 * belonged on the part and not around it — is gone because the case it described now works.
	 *
	 * **The count is still printed, in the shape `ShiftLock` prints its zone count**, because one cause of
	 * "the pad does nothing" remains and it is the one a count answers: nothing is wearing the tag at all.
	 * It is the first line to grep for when a join part is silent.
	 */
	private mountSide(tag: string, team: TeamLabel): void {
		const parts = taggedParts(tag);

		for (const part of parts) this.prepare(part, team);

		if (DEBUG) print(`[Match] up — ${tag}: ${parts.size()} part(s)`);
	}

	/**
	 * Makes one part behave as a join part, and says what it had to change.
	 *
	 * **Four properties, and every one of them is a decision rather than tidiness.**
	 *
	 * - **`Anchored = true` — this is the trap the old lobby spawn fell into.** That part was unanchored,
	 *   walked off the bottom of the world, and the engine destroyed it at `FallenPartsDestroyHeight`; a
	 *   join part that drifts is a join part that stops answering, and the symptom is "touching it does
	 *   nothing to me" rather than anything about a part on the floor. Set here rather than trusted to
	 *   the place file, because the fault is silent and the fix is one property.
	 * - **`CanCollide = false`** — it is a sign, not a wall. A lobby is somewhere people walk about, and a
	 *   solid prop in the middle of it is a thing to get stuck on.
	 * - **`CanTouch = true`, which is the exception to every other lobby part's rule.** Everything else in
	 *   the lobby has touching switched off, deliberately: the shift-lock zone is `CanTouch = false` so an
	 *   invisible box does not hand touch events to every ball that passes through it, and the barriers are
	 *   off for the same reason. These parts are the opposite case — **the touch is the feature** — so they
	 *   are the only parts in the lobby that have to report them. Turning it off does not make a part
	 *   quieter; it makes it stop working.
	 * - **`CanQuery = false`** — the aim guide walks the world with a spherecast, and a lobby prop would
	 *   otherwise be something the preview stops on.
	 *
	 * The correction is reported rather than silent, in the shape `applyBarrierGroups` uses for its
	 * read-back: a part that was not set up right is worth a line, and the line names which property it
	 * was.
	 */
	private prepare(part: BasePart, team: TeamLabel): void {
		const corrected = new Array<string>();

		if (!part.Anchored) corrected.push("Anchored");
		if (part.CanCollide) corrected.push("CanCollide");
		if (!part.CanTouch) corrected.push("CanTouch");
		if (part.CanQuery) corrected.push("CanQuery");

		part.Anchored = true;
		part.CanCollide = false;
		part.CanTouch = true;
		part.CanQuery = false;

		if (corrected.size() > 0) {
			warn(`[Match] "${part.GetFullName()}" was not set up as a join part — corrected ${corrected.join(", ")}`);
		}

		// **The side is bound here, once, rather than looked up per touch.** `Touched` names the part that
		// was hit but nothing in the event says which tag is on it, and the side is a constant of this
		// part — so it goes into the closure, and every touch from here already knows what it is asking
		// for. It also means the two parts have two connections rather than one handler that has to work
		// out where it was called from.
		part.Touched.Connect((other) => this.touched(team, other));

		this.mountSign(part, team);
	}

	/**
	 * This side's counts, above its part: a `BillboardGui` holding one label, made once and written to
	 * after.
	 *
	 * **A `BillboardGui` rather than a `SurfaceGui`, and the precedent is this project's own stats board**
	 * — one billboard, `Adornee` set to the thing it is about, `AlwaysOnTop` off so it belongs to the world
	 * rather than being drawn over it. A `SurfaceGui` would be a sign readable only from the side it
	 * happens to face, which for a part somebody has to walk *into* is the wrong half of the lobby.
	 *
	 * **Each sign carries only its own side's number, since the split into two parts.** With one part the
	 * label had to name both sides — `A: 2/4  B: 1/4` — because there was nothing else on the board to say
	 * which team the second number was about. On two parts the board *is* the side, so `A: 2/4` on the `A`
	 * sign answers the only question the player standing in front of it has, and it does it in half the
	 * width.
	 *
	 * `Adornee` **and** `Parent`, both, matching that board: the parent is what keeps the sign alive with
	 * the part and what it moves with, and the adornee is what it is drawn against — the same pair the
	 * billboard above a head uses, and setting only one of them is the version that appears in the wrong
	 * place.
	 */
	private mountSign(part: BasePart, team: TeamLabel): void {
		const billboard = new Instance("BillboardGui");

		billboard.Name = SIGN_NAME;
		billboard.Adornee = part;
		billboard.Size = MATCH_SIGN_SIZE;
		billboard.StudsOffsetWorldSpace = new Vector3(0, MATCH_SIGN_OFFSET_Y, 0);
		// **Read from across a lobby, which is the opposite requirement to the stats board's.** That one is
		// deliberately short-ranged, because it is about a body you are standing next to; this is a sign
		// whose whole job is to be found.
		billboard.MaxDistance = MATCH_SIGN_MAX_DISTANCE;
		billboard.AlwaysOnTop = false;
		billboard.Parent = part;

		const label = new Instance("TextLabel");

		label.Name = SIGN_LABEL_NAME;
		label.Size = new UDim2(1, 0, 1, 0);
		label.BackgroundTransparency = 1;
		label.Font = Enum.Font.GothamBold;
		label.TextSize = MATCH_SIGN_TEXT_SIZE;
		label.TextColor3 = Color3.fromRGB(255, 255, 255);
		// A stroke, because the sign stands in a lit lobby rather than on a HUD: a plain white label over a
		// pale floor is a label nobody reads.
		label.TextStrokeTransparency = 0.5;
		label.Text = this.sideText(team);
		label.Parent = billboard;

		this.signs.push({ team: team, label: label });
	}

	// ---- Touching it ----

	/**
	 * Somebody walked into one of the two parts.
	 *
	 * **`Touched` fires per body part, which is why nothing below happens before the guard.** A body
	 * walking through reports a touch for each of its parts, in the same frame and again as it moves — so
	 * the character is marked for `MATCH_TOUCH_DEBOUNCE_SECONDS` and every touch while the mark is on is
	 * dropped. The mark is a tag on the *character*, so it dies with the body and a player killed
	 * mid-debounce needs no cleanup. See {@link DEBOUNCE_TAG}, which also records that a single tag is
	 * shared by both parts.
	 *
	 * **Nothing after the guards depends on which part was touched**, because `team` already says so: it
	 * was bound to this connection when the part was mounted. The mid-match refusal is not here either —
	 * it lives in {@link optIn}, ahead of the roster, so there is exactly one gate and it is the one that
	 * guards the roster rather than the one that happens to see the touch first.
	 */
	private touched(team: TeamLabel, other: BasePart): void {
		const character = other.Parent;
		if (character === undefined || !character.IsA("Model")) return;

		if (character.HasTag(DEBOUNCE_TAG)) return;

		character.AddTag(DEBOUNCE_TAG);
		task.delay(MATCH_TOUCH_DEBOUNCE_SECONDS, () => {
			// **Guarded, because the delay can outlive the body it was made for.** A character destroyed
			// inside the debounce — a death, a respawn, a player leaving — leaves this firing against an
			// instance the engine has locked, and a tag write on a destroyed model is an error thrown into a
			// coroutine that never asked for one. A body with no parent is a body that is gone.
			if (character.Parent === undefined) return;

			character.RemoveTag(DEBOUNCE_TAG);
		});

		const player = Players.GetPlayerFromCharacter(character);

		// A rig, or somebody else's body: no player, so there is nobody to put on a side. The same
		// resolution `RoundService.registerHit` makes for the same reason.
		if (player === undefined) return;

		this.optIn(player, team);
	}

	// ---- Internals ----

	/** Whether `team` has room for one more, given the counts already in hand. */
	private hasRoom(team: TeamLabel, counts: MatchCounts): boolean {
		return sideCount(team, counts) < MATCH_MAX_PER_TEAM;
	}

	/**
	 * The phase the round is publishing, or nothing while it has not published one.
	 *
	 * **Read from the status folder rather than asked of `RoundService`,** which is the whole of how this
	 * service stays out of the round's dependency graph — see the class doc. The folder is looked for
	 * lazily and kept once found, so the cost is one `FindFirstChild` for the session rather than one per
	 * touch, and nothing at boot.
	 */
	private phase(): string | undefined {
		const folder = this.statusFolder ?? ReplicatedStorage.FindFirstChild(ROUND_STATUS_FOLDER);
		if (folder === undefined || !folder.IsA("Folder")) return undefined;

		this.statusFolder = folder;

		const value = folder.GetAttribute(ROUND_STATE_ATTRIBUTE);

		return typeIs(value, "string") ? value : undefined;
	}

	/**
	 * Writes each side's own count to every sign that is about it.
	 *
	 * **Both signs are repainted on every change, and a side switch is the reason.** A move changes both
	 * numbers at once, so a pass that only updated the sign of the side that gained a player would leave
	 * the other one still counting somebody who has left it — and the counts are the only thing telling a
	 * player which part to walk to.
	 */
	private updateSigns(): void {
		for (const sign of this.signs) sign.label.Text = this.sideText(sign.team);
	}

	/** `A: 2/4` — one sign's whole content. The side is named because the sign is a lone board. */
	private sideText(team: TeamLabel): string {
		return `${team}: ${sideCount(team, this.countsFor())}/${MATCH_MAX_PER_TEAM}`;
	}

	/** `A: 2/4  B: 1/4` — both sides at once, which is the shape every log line wants. */
	private describeCounts(): string {
		const counts = this.countsFor();

		return `A: ${sideCount(TEAM_A, counts)}/${MATCH_MAX_PER_TEAM}  B: ${sideCount(TEAM_B, counts)}/${MATCH_MAX_PER_TEAM}`;
	}
}
