import { OnStart, Service } from "@flamework/core";
import { Players, ReplicatedStorage, Workspace } from "@rbxts/services";
import { SUPER_CONFIG } from "shared/config/super.config";
import {
	ROUND_STATE_ATTRIBUTE,
	ROUND_STATUS_FOLDER,
	SUPER_CHARGE_ATTRIBUTE,
	SUPER_MULTI_BALL_COUNT_ATTRIBUTE,
	SUPER_MULTI_BALL_ENDS_AT_ATTRIBUTE,
	SUPER_STREAK_ATTRIBUTE,
} from "shared/constants";

/** Prints the mount line, and every grant, spend and forfeit. */
const DEBUG = true;

/**
 * What `ROUND_STATE_ATTRIBUTE` says while a round is being played.
 *
 * A literal here rather than an import, which is what `StatsService`, `BallSpawnerService` and
 * `OutlineService` each do with the same two words — the attribute is a string on a folder and there
 * is no constant for its *values*, only for its name. Four readers agreeing on the word by writing it
 * is the arrangement that already exists; the alternative is a constant in `shared/constants.ts` that
 * none of the four is currently using.
 */
const PLAYING = "Playing";

/**
 * A MultiBall window that is running: when it closes, and how many throws it has left.
 *
 * **A row in a `Map` rather than attributes treated as the state**, which is this service's own rule:
 * the `Map` is the truth and the attributes are published for the client. A `Player` attribute is not a
 * place to keep a decision, and this one would need two of them kept in step by hand.
 *
 * **`endsAt` is on the engine's shared clock**, stamped from `Workspace:GetServerTimeNow()` and never
 * `os.clock()` — see `SUPER_MULTI_BALL_ENDS_AT_ATTRIBUTE` for why that is the difference between a HUD
 * that can count down and a HUD that cannot.
 */
interface MultiBallWindow {
	/** What `Workspace:GetServerTimeNow()` will read when the window closes. */
	endsAt: number;
	/** Throws left to pay for. See `SUPER_CONFIG.MULTI_BALL_BALL_COUNT` for what is being counted. */
	remaining: number;
}

/**
 * The streak a player is on, and the charge they are holding.
 *
 * **The rules, in one place, because they are one mechanic.** A hit is a throw that landed on an
 * enemy; six of them in a row earn one charge; a miss or a death puts the streak back to zero; a
 * charge is held until it is used and only one is held at a time. Every one of those sentences is a
 * line below rather than a rule spread across the callers that report the events.
 *
 * **What is not here is anything about abilities.** This service does not know what Pierce does, does
 * not know a ball can carry one, and never touches a ball. It answers "does this player hold a
 * charge", it is told when one is spent or forfeited, and the marking of a ball belongs to the hand
 * the ball is in — see `BallService.markHeldBall` for why that is the right side of the line.
 *
 * **Two copies of the state, and one of them is authoritative.** The `Map` and the `Set` below are
 * the truth; the two attributes are published for the client and are read by nothing on this machine.
 * The alternative — treating the attributes as the state — would mean every rule being a read of a
 * value the client can see, and a `Player` attribute is not a place to keep a decision.
 *
 * **Its own service rather than a corner of `StatsService`, which was the smaller home available.**
 * It was considered and it is the wrong fit: `StatsService` keeps a user's *career* in a `DataStore`,
 * and this is a transient mechanic whose charge is deliberately thrown away with the session. Putting
 * a run-of-hits counter into a persisted record would also mean the streak surviving a rejoin, which
 * is not what it is.
 */
@Service()
export class SuperService implements OnStart {
	/** Every player's current streak. Absent means zero — a player who has not hit anybody yet. */
	private readonly streaks = new Map<Player, number>();

	/**
	 * Who is holding a charge.
	 *
	 * A `Set` rather than a count, because the rule is "only one charge at a time": the question is
	 * yes or no, and a number that is only ever 0 or 1 is a number with a rule attached that nothing
	 * checks.
	 */
	private readonly charged = new Set<Player>();

	/**
	 * Every player with a MultiBall window open, and what is left of it.
	 *
	 * **Keyed on the `Player` and not on the character**, for the reason `ARMED_ABILITY_ATTRIBUTE` gives
	 * about the dev's arm: a window belongs to the *player*, and a respawn replaces the body it was
	 * opened in. Whether a death should close one is a separate decision, and it is made where deaths are
	 * handled rather than here — this service is told about states and never about bodies.
	 *
	 * It is also the one container here that has a *clock* attached to its rows, which is why the rows
	 * carry their own deadline rather than this service asking anything how long it has been.
	 */
	private readonly multiBalls = new Map<Player, MultiBallWindow>();

	public onStart(): void {
		// **The one leak this service can have.** Both containers are keyed on a `Player`, so a player
		// who leaves would otherwise keep their row for the life of the server. The charge is
		// deliberately not carried across a rejoin — it is earned in a session and spent in one.
		Players.PlayerRemoving.Connect((player) => {
			this.streaks.delete(player);
			this.charged.delete(player);

			// **The window goes with them, and the timer it left behind is harmless.** That timer was
			// scheduled for a player who is no longer here, and `clearMultiBall` is silent when there is
			// nothing to clear — which is also what makes it safe for a death or a round ending to close a
			// window the clock was still going to close.
			this.multiBalls.delete(player);
		});

		if (DEBUG) {
			print(`[Super] up — ${SUPER_CONFIG.STREAK_REQUIRED} hits in a row earns one charge`);
		}
	}

	/**
	 * One hit against the thrower's streak, granting the charge when it reaches the target.
	 *
	 * **A token and not a `Player`, which is forced rather than chosen.** A hit arrives from a ball,
	 * and the token stamped on it at release is the whole of what that ball knows about who threw it —
	 * the same fact `StatsService.recordHit` takes, for the same reason, so the two are deliberately
	 * the same shape. Whether the token names a person at all is answered by {@link playerOf}, and a
	 * rig's GUID falls out there rather than being special-cased here.
	 */
	public noteHit(throwerToken: unknown): void {
		const player = playerOf(throwerToken);
		if (player === undefined) return;

		// **Only a round counts.** The rule `StatsService` applies to its own figures, read from the
		// same channel — see {@link isRoundActive}. Without it, a hit in the lobby would build towards
		// an ability, which is a reward for practising while nothing is at stake.
		if (!this.isRoundActive()) return;

		const streak = (this.streaks.get(player) ?? 0) + 1;

		// **At the target the charge is granted and the streak starts over.** Reset rather than left
		// standing at the target, because a full readout on somebody who has just spent what it was
		// full of is a readout telling them the wrong thing. A player who already holds a charge and
		// reaches the target again is reset the same way: there is only one charge, so there is nothing
		// left to grant, and a streak parked at six would look like one about to be granted.
		if (streak >= SUPER_CONFIG.STREAK_REQUIRED) {
			this.streaks.set(player, 0);
			this.charged.add(player);
			this.publish(player);

			if (DEBUG) print(`[Super] ${player.Name}: charge earned at ${streak} in a row`);

			return;
		}

		this.streaks.set(player, streak);
		this.publish(player);

		if (DEBUG) print(`[Super] ${player.Name}: streak ${streak}/${SUPER_CONFIG.STREAK_REQUIRED}`);
	}

	/**
	 * A throw that landed on nobody, so the streak goes back to zero.
	 *
	 * Takes a token for {@link noteHit}'s reason: the same ball reports it, from the same throw, and
	 * the token is all that ball carries. The call site is `BallComponent.score` — the one place that
	 * knows a throw ended having tagged nobody.
	 */
	public noteMiss(throwerToken: unknown): void {
		const player = playerOf(throwerToken);
		if (player === undefined) return;

		// Guarded exactly as a hit is, so the two cannot disagree about which throws count. A miss
		// between rounds leaves the streak where the round left it, which is what the readout is
		// showing until the next round opens and clears it.
		if (!this.isRoundActive()) return;

		this.resetStreak(player, "missed");
	}

	/**
	 * A player died, so the streak goes back to zero. **The charge does not.**
	 *
	 * **A `Player` and not a token, and that is the difference between this and the two above.** A
	 * death is a fact about somebody the round has already resolved — `RoundService.handleDeath` is
	 * handed the player and nothing else — where a hit arrives from a ball that knows only who threw
	 * it. `StatsService` draws the same line between `recordHit` and `recordOut`, in its own words.
	 *
	 * **No round check here, deliberately.** The round's own guard sits upstream of the call: a death
	 * outside a playing phase returns before reaching it, and one for a player already out returns
	 * before that. A second check here would be a copy of a rule the caller has already applied, which
	 * is the thing this codebase refuses to write twice.
	 */
	public noteDeath(player: Player): void {
		this.resetStreak(player, "died");
	}

	/** Whether `player` is holding a charge. The whole of what the mark handler asks this service. */
	public hasCharge(player: Player): boolean {
		return this.charged.has(player);
	}

	/**
	 * Takes the charge away unused, because the ball carrying it was put down.
	 *
	 * **A forfeit and not a refund, which is the rule rather than an oversight.** A marked ball that is
	 * dropped is destroyed — it is a ball nothing can pick up as an ordinary ball and nothing should —
	 * so the charge has been given up for nothing. That is the cost of putting an ability down, and it
	 * is what stops marking a ball being free.
	 *
	 * Called from `BallService.dropBall`, which is the only place a ball can be put down.
	 */
	public forfeitCharge(player: Player): void {
		if (!this.charged.delete(player)) return;

		this.publish(player);

		if (DEBUG) print(`[Super] ${player.Name}: charge forfeited`);
	}

	/**
	 * Opens a MultiBall window for `player`, or refuses because one is already running.
	 *
	 * **A buff on the player rather than a property of a ball, and that is the whole of this ability.**
	 * Pierce marks a ball: the ability travels with the thing that flies, which is why putting a marked
	 * ball down costs the player their charge. MultiBall is a *state of the player* — a stretch of time
	 * in which throwing is answered — so there is nothing on a ball to drop, and the balls it supplies
	 * are ordinary balls in every way: catchable, taggable, pickable, with no collision rule, no flag and
	 * no immunity of their own. **Nothing in this file touches a ball**, which is what keeps that true,
	 * and the refills that do touch one are in `BallService` for exactly this reason.
	 *
	 * **The charge is spent at the press for this ability and at the throw for Pierce, and the two are
	 * not inconsistent.** A mark commits a player to nothing — the charge follows the ball, so marking
	 * one and changing your mind costs nothing — where this *is* the commitment: the window starts
	 * running the moment it is asked for, and it runs whether or not anything is thrown in it. That is
	 * what buying a mark means, and what buying ten seconds means. See `BallService.activateMultiBall`,
	 * which is the handler that spends the charge.
	 *
	 * Returns whether a window was opened, so the caller can tell an accepted press from a refused
	 * second one.
	 */
	public activateMultiBall(player: Player): boolean {
		if (this.multiBalls.has(player)) return false;

		this.multiBalls.set(player, {
			endsAt: Workspace.GetServerTimeNow() + SUPER_CONFIG.MULTI_BALL_DURATION_SECONDS,
			remaining: SUPER_CONFIG.MULTI_BALL_BALL_COUNT,
		});
		this.publish(player);

		// **The window's own end, and this timer is a convenience rather than the rule.** Whether a window
		// is open is decided by the clock in {@link isMultiBallActive}, so a callback that arrives late
		// costs a stale row in a `Map` and never an ability that outlives the time it was sold for. What
		// this does is take the row away, and it is scheduled for the exact length of the window it closes.
		task.delay(SUPER_CONFIG.MULTI_BALL_DURATION_SECONDS, () => this.clearMultiBall(player));

		if (DEBUG) {
			print(
				`[Super] ${player.Name}: MultiBall window open — ` +
					`${SUPER_CONFIG.MULTI_BALL_BALL_COUNT} throws in ${SUPER_CONFIG.MULTI_BALL_DURATION_SECONDS}s`,
			);
		}

		return true;
	}

	/**
	 * Whether `player` has a window open right now.
	 *
	 * **The clock is the rule and the `Map` is only where the row is kept**, which is the opposite of how
	 * the charge works — and deliberately. A charge is a fact with no clock attached; a window *is* a
	 * clock, so a row whose deadline has passed reads as closed even if the timer meant to remove it has
	 * not run yet, and the ability can never outlive the ten seconds it was sold for.
	 */
	public isMultiBallActive(player: Player): boolean {
		const window = this.multiBalls.get(player);
		if (!window) return false;

		return window.endsAt > Workspace.GetServerTimeNow();
	}

	/** Whether that window still has throws left in it. An absent, closed or spent window has none. */
	public hasMultiBallBalls(player: Player): boolean {
		const window = this.multiBalls.get(player);
		if (!window) return false;
		if (!this.isMultiBallActive(player)) return false;

		return window.remaining > 0;
	}

	/**
	 * Spends one throw of the window, and answers whether there was one to spend.
	 *
	 * **The count is a number of throws rather than of balls**, which is why the caller asks this
	 * *before* deciding whether to hand a ball over: the last throw of a window is deliberately not
	 * answered, so the caller asks again after this has answered yes. See `BallService.refillFromBuff`,
	 * which is the only caller and where that rule is written down with the reason for it.
	 */
	public consumeMultiBallBall(player: Player): boolean {
		if (!this.hasMultiBallBalls(player)) return false;

		const window = this.multiBalls.get(player);
		if (!window) return false;

		window.remaining -= 1;
		this.publish(player);

		if (DEBUG) print(`[Super] ${player.Name}: MultiBall throw spent — ${window.remaining} left`);

		return true;
	}

	/**
	 * Closes `player`'s window: the clock ran out, they died, or the round ended.
	 *
	 * **Nothing outside this service is touched, and "the ball in the hand stays" is a rule rather than
	 * an omission.** Closing a window takes the *supply* away — no more balls are handed over — and
	 * leaves whatever the player is holding exactly where it is, because a ball in a hand when the
	 * window ends was not lent to them by the window. It is the same shape as the count running out, one
	 * step further along: the ability stops giving, and never takes back.
	 *
	 * **Silent when there is no window**, which is the ordinary case for the timer: it fires for every
	 * player who ever opened one, including those who have since died, left the server, or had their
	 * window closed by the round ending. Three things can close a window and any of them can be first.
	 */
	public clearMultiBall(player: Player): void {
		if (!this.multiBalls.delete(player)) return;

		this.publish(player);

		if (DEBUG) print(`[Super] ${player.Name}: MultiBall window closed`);
	}

	/**
	 * Takes the charge away because it has been used, because the ball carrying it was thrown.
	 *
	 * **Spent on the throw and not on the press, and this is the one decision in the file worth stating
	 * at length.** Pressing the key marks a ball; it commits the player to nothing. A player who marks a
	 * ball and then changes their mind — drops it, or dies holding it — must not have paid for a throw
	 * they never made, and a charge consumed at the press would make marking a ball a decision with a
	 * price attached before anything has happened. So the charge follows the *ball*, and the two ways a
	 * marked ball can leave a hand decide between the two fates: thrown is this, dropped is
	 * {@link forfeitCharge}, and the ball's own destruction takes the charge with it.
	 *
	 * **Not called for a dev.** A dev marks a ball without a charge existing — the bypass
	 * `BallService.markHeldBall` documents — so there is nothing of theirs to spend, and this is
	 * guarded at the call site rather than here because only the caller knows who threw.
	 */
	public spendCharge(player: Player): void {
		if (!this.charged.delete(player)) return;

		this.publish(player);

		if (DEBUG) print(`[Super] ${player.Name}: charge spent`);
	}

	/**
	 * Clears the streak for a round that is opening. **The charge is left alone.**
	 *
	 * The two halves of this service have different lifetimes on purpose: a streak is a run *within* a
	 * round, so it goes when the round does, and a charge is held until it is used, so it is carried
	 * into the next round by a player who earned it and never spent it.
	 *
	 * Called from the block in `RoundService` that opens a playing phase, beside `scores.clear()` and
	 * the round's own two boards — and *not* at the intermission. The streak a round ended on is
	 * therefore still on screen for the intermission, which is the same lifetime `roundHits` and
	 * `roundOuts` were given and for the same reason: a readout that emptied itself a frame after the
	 * last hit would wipe the thing it exists to show.
	 */
	public resetForRound(player: Player): void {
		if ((this.streaks.get(player) ?? 0) === 0) return;

		this.streaks.set(player, 0);
		this.publish(player);

		if (DEBUG) print(`[Super] ${player.Name}: streak cleared for the new round`);
	}

	/**
	 * Puts the streak, the charge and the MultiBall window on the player, where the client reads them.
	 *
	 * **Attributes rather than a remote**, for the reason the round's are: they replicate on their own,
	 * so the HUD needs no request, no reply to wait for, and no reference to this service — and the
	 * client can read them the moment it joins, with nothing to catch up on. All of them go out together
	 * every time, because they are one readout: a reader that saw a new streak beside a stale charge, or
	 * a count beside the deadline of a window that had already closed, would be showing a state that
	 * never existed.
	 *
	 * **The window's two are written as `0` and `0` when there is none**, which is the empty case rather
	 * than an absent attribute — see `SUPER_MULTI_BALL_COUNT_ATTRIBUTE`.
	 */
	private publish(player: Player): void {
		player.SetAttribute(SUPER_STREAK_ATTRIBUTE, this.streaks.get(player) ?? 0);
		player.SetAttribute(SUPER_CHARGE_ATTRIBUTE, this.charged.has(player));

		// **"Is there a row" is not the test, and the difference is the whole point of {@link
		// isMultiBallActive}.** A row whose deadline has passed is a closed window whose timer has not run
		// yet, and publishing it would put a count on the HUD beside a deadline already in the past.
		const window = this.isMultiBallActive(player) ? this.multiBalls.get(player) : undefined;

		player.SetAttribute(SUPER_MULTI_BALL_COUNT_ATTRIBUTE, window?.remaining ?? 0);
		player.SetAttribute(SUPER_MULTI_BALL_ENDS_AT_ATTRIBUTE, window?.endsAt ?? 0);
	}

	/** Zeroes `player`'s streak and says why, unless it is already zero. */
	private resetStreak(player: Player, why: string): void {
		// Silent when there is nothing to clear: a death is not news about a streak of nought, and a
		// line per death for players who have not hit anybody would bury the ones that matter.
		if ((this.streaks.get(player) ?? 0) === 0) return;

		this.streaks.set(player, 0);
		this.publish(player);

		if (DEBUG) print(`[Super] ${player.Name}: streak reset — ${why}`);
	}

	/**
	 * Whether a round is being played, asked of the status folder rather than of `RoundService`.
	 *
	 * **The same channel `StatsService`, `BallSpawnerService` and `OutlineService` each read**, which is
	 * what makes this a sibling of the round rather than a dependent of it: nothing here has to be told
	 * when a round starts or ends, the round needs no reference to this service, and there is no
	 * ordering to get wrong at boot. A folder that does not exist yet — the first moments of a server's
	 * life — is not a round either.
	 *
	 * **Public because the mark handler needs the same answer, and two copies of this rule in two files
	 * would be two chances for a charge to be earnable in a round the ball could not be marked in.**
	 * `BallService` asks this rather than reading the folder itself, which is why that file has no
	 * `PLAYING` of its own. `SuperService` remains the only thing that decides what a *streak* does, and
	 * this is the one rule it lends out.
	 *
	 * **The Pierce set-up used to be a second caller, and is not any more.** Now that a Pierce ball
	 * passes through every body, there is no side to test at the throw — so the mark handler is the only
	 * thing outside this file that needs the answer, and the loan is smaller than it was rather than
	 * closed. (`isRoundActive` was briefly made private on the strength of the Pierce caller being gone;
	 * the build found the mark handler, which is the whole reason this note is here.)
	 */
	public isRoundActive(): boolean {
		const folder = ReplicatedStorage.FindFirstChild(ROUND_STATUS_FOLDER);

		return folder?.GetAttribute(ROUND_STATE_ATTRIBUTE) === PLAYING;
	}
}

/**
 * The player a thrower token belongs to, or nothing.
 *
 * **The token is all a ball carries.** `BallService.throwBall` stamps the ball's `ThrowerId` with the
 * thrower model's `THROWER_TOKEN` and then lets go of the model entirely, so there is nothing left to
 * ask for it — resolving a *model* would mean scanning every rig in the world for a matching token on
 * every landing. A player's token is their `UserId` as text and a rig's is a GUID, so `tonumber` is
 * the entire rule for "was this a person": a GUID does not read as a number. That is what makes NPCs
 * fall out rather than be special-cased.
 *
 * **A deliberate third copy** of the same four lines in `StatsService` and `RoundService`, each of
 * which keeps its own for the reason those two comments give — the rule is four lines, and importing
 * across would tie three unrelated lifetimes together for one function. Named here so that a change to
 * the rule is visibly a change to three files, and so that a fourth copy is the point to hoist it
 * rather than write it again.
 */
function playerOf(throwerToken: unknown): Player | undefined {
	if (!typeIs(throwerToken, "string")) return undefined;

	const userId = tonumber(throwerToken);
	if (userId === undefined) return undefined;

	return Players.GetPlayerByUserId(userId);
}
