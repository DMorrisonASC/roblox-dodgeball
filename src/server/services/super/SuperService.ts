import { OnStart, Service } from "@flamework/core";
import { Players, ReplicatedStorage, Workspace } from "@rbxts/services";
import { AbilityKind } from "shared/ability";
import { SUPER_CONFIG } from "shared/config/super.config";
import {
	CROWN_ATTRIBUTE,
	MYSTERY_POWER_ATTRIBUTE,
	MYSTERY_POWER_ENDS_AT_ATTRIBUTE,
	ROUND_STATE_ATTRIBUTE,
	ROUND_STATUS_FOLDER,
	SUPER_CHARGE_ATTRIBUTE,
	SUPER_MULTI_BALL_COUNT_ATTRIBUTE,
	SUPER_MULTI_BALL_ENDS_AT_ATTRIBUTE,
	SUPER_STREAK_ATTRIBUTE,
	TEAM_ATTRIBUTE,
} from "shared/constants";

/** Prints the mount line, and every grant, spend and forfeit. */
const DEBUG = true;

/**
 * What `ROUND_STATE_ATTRIBUTE` says while a round is being played.
 *
 * A literal here rather than an import, which is what `StatsService`, `BallSpawnerService` and
 * `OutlineService` each do with the same two words — the attribute is a string on a folder and there
 * is no constant for its *values*, only for its name. Every file that has to test the phase writing
 * it out is the arrangement that already exists; the alternative is a constant in
 * `shared/constants.ts` that none of them is currently using.
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
 * A mystery-box window that is running: which power it pays for, and when it closes.
 *
 * **The kind is on the row, and that is the one thing this window has that a MultiBall window does not.**
 * A MultiBall window always grants MultiBall, so its row has no reason to say so; a box rolls a power at
 * the moment it is collected, and "which one" is the answer to the question the player asked by taking the
 * box. Keeping it here is what lets {@link publish} put it on the player — which is what the toast that
 * announces the box reads — and what lets a second box arriving mid-window be refused without anybody
 * having to remember what the first one was.
 *
 * **No `remaining`, and its absence is deliberate.** MultiBall rations a *number of throws*; a mystery
 * window rations *time*, and the power it pays for is spent through the paths that already exist — a mark
 * on a ball, or a MultiBall window of its own — rather than through a counter here. A count would be a
 * second way to run out, and one window with two ways to end is one more pair of states to keep in step.
 *
 * **`endsAt` on the shared clock, exactly as above and for the same reason**: a window *is* a clock, so the
 * clock is the rule and the row is only where it is kept.
 */
interface MysteryWindow {
	/** What the box rolled. See `shared/ability.ts` — the same union the mark remote speaks. */
	kind: AbilityKind;
	/** What `Workspace:GetServerTimeNow()` will read when the window closes. */
	endsAt: number;
}

/**
 * The streak a player is on, and the charge they are holding.
 *
 * **The rules, in one place, because they are one mechanic.** A hit is a throw that landed on an
 * enemy, and the count of them is what the crown is decided from; a *death* and the opening of the
 * next round put that count back to zero, and nothing else does; a charge is held until it is used
 * and only one is held at a time. Every one of those sentences is a line below rather than a rule
 * spread across the callers that report the events.
 *
 * **A miss used to break the run, and no longer does.** The count has become "hits since you last died"
 * — which is what it always was, minus the reset that made it a *run* — and the reason is that it no
 * longer buys anything. A threshold that grants an ability needs a way to be lost; a threshold that puts
 * a crown on your head does not, and resetting on a miss only made a hot player's crown flicker. See
 * {@link noteHit} for the note where the count is made, and {@link refreshCrowns} for what reads it.
 *
 * **What is not here is anything about abilities.** This service does not know what Pierce does, does
 * not know a ball can carry one, and never touches a ball. It answers "does this player hold a
 * charge", it is told when one is spent or forfeited, and the marking of a ball belongs to the hand
 * the ball is in — see `BallService.markHeldBall` for why that is the right side of the line.
 *
 * **Two copies of the state, and one of them is authoritative.** The `Map`s and the `Set` below are
 * the truth; the `SUPER_*` attributes that {@link publish} writes are for the client and are read by
 * nothing on this machine — the crown, which {@link refreshCrowns} works out from the same streaks,
 * is the one attribute this service writes that another server system reads. The alternative —
 * treating the attributes as the state — would mean every rule being a read of a value the client
 * can see, and a `Player` attribute is not a place to keep a decision.
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

	/**
	 * Every player with a mystery-box window open, and what it rolled.
	 *
	 * **A second `Map` rather than another field on the rows of the first one**, because the two windows
	 * are different things that happen to be shaped alike. This one is bought with a box rather than with
	 * a charge, and it is asked about by the *charge test* rather than by the throw handler — see
	 * `BallService.markHeldBall` and `BallService.activateMultiBall`, which both ask "may this player do
	 * this" of two sources now. One container with two kinds of row in it would make every reader of
	 * either decide which of the two it was holding.
	 *
	 * **Keyed on the `Player`**, for the reason above: a window is a state of the player, and a respawn
	 * replaces the body it was opened in. It is also cleaned up on `PlayerRemoving` with the others, since
	 * a row for somebody who has left is a row nothing will ever clear.
	 */
	private readonly mystery = new Map<Player, MysteryWindow>();

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

			// **And the box's window goes with them, by the same argument.** The timer a live window
			// scheduled for this player will still fire, and `clearMysteryWindow` is silent when there is
			// nothing to clear.
			this.mystery.delete(player);

			// **And the crown is recomputed, because the player who just left may have been the reason
			// somebody else was not wearing it.** A team's highest hitter leaving hands the crown to
			// whoever is next, and that is a change nobody on this server did anything to cause.
			//
			// After the deletion above rather than before it, which matters: `refreshCrowns` reads this
			// map, so a leaver whose row is already gone counts as nought — which is what they are — where
			// a refresh before the delete would leave their count holding the team's maximum for a player
			// who is no longer in the game.
			this.refreshCrowns();
		});

		if (DEBUG) {
			print(
				`[Super] up — crowning at ${SUPER_CONFIG.CROWN_STREAK_THRESHOLD} hits,` +
					` or the most on a side; nothing grants a charge but the dev bypass`,
			);
		}
	}

	/**
	 * One hit against the thrower's count — **the only thing in the game that raises it.**
	 *
	 * **What puts the count back to zero: dying, and the round ending.** There is no miss reset any more,
	 * and that is the whole of what this method's change carried: the count used to be a *run*, broken by
	 * a throw that landed on nobody, and it is now "hits since you last died". A reader who comes looking
	 * for the miss reset will find {@link noteMiss} gone with no replacement, which is deliberate rather
	 * than an omission — see the class doc for why it went with the charge.
	 *
	 * **This used to grant a charge at `STREAK_REQUIRED`, and grants nothing now.** What stood here was
	 * six hits in a row buying one super, with the count zeroed at the moment it was paid out. Nothing
	 * grants a charge any more except the dev bypass in `BallService`; the charge system itself is intact
	 * and untouched — the mark remote, the aura, `hasCharge`, `spendCharge`, `forfeitCharge` and the HUD's
	 * charge row are all still here and all still work. **Power-up boxes are the intended source**, and
	 * until they exist a charge is something only a dev can obtain.
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
		// same channel — see {@link isRoundActive}. Without it, a hit in the lobby would count towards a
		// crown, which is a reward for practising while nothing is at stake.
		if (!this.isRoundActive()) return;

		const streak = (this.streaks.get(player) ?? 0) + 1;

		this.streaks.set(player, streak);
		this.publish(player);

		// **And the crown is decided after the count, never before.** Whether this hit crowned anybody
		// depends on the count it has just made and on every other player's count and side, so the
		// recomputation has to follow the write — and it carries the other half of the rule as well: this
		// hit may have taken the crown off the player who used to be their side's highest.
		this.refreshCrowns();

		if (DEBUG) print(`[Super] ${player.Name}: hits ${streak}`);
	}

	/**
	 * A player died, so the count goes back to zero. **The charge does not.**
	 *
	 * **This is now the only thing outside the round boundary that resets the count.** A throw that
	 * landed on nobody used to reset it too, through a `noteMiss` that used to stand here; that method is
	 * gone rather than switched off, and nothing replaced it, because the count no longer buys anything
	 * that has to be defended. See `BallComponent.score`, which still refuses to record a hit for a miss
	 * and simply no longer reports one.
	 *
	 * **A `Player` and not a token, and that is the difference between this and the hit above.** A
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

		// **A death closes the box's window, and this method closes no MultiBall one.** Read the body
		// above: it resets the streak and recomputes the crown, and nothing else. `clearMultiBall` is
		// called from its own timer and from two places in `RoundService`, and a death reaches neither —
		// so a player who dies with a MultiBall window open keeps it, despite that window's own comment
		// saying a death closes one. Whether MultiBall should be closed here is its author's question and
		// not this one's; for a box the answer is that it closes, because a fresh body in a fresh position
		// is not the player who collected it. Divergence reported rather than copied either way.
		this.clearMysteryWindow(player);

		// **And a death can move a crown that is not this player's.** The count has just gone to nought,
		// which changes the maximum it was measured against — so the answer is recomputed even though the
		// player who died is certainly not wearing it any more.
		this.refreshCrowns();
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
	 *
	 * **This does not recompute the crown, and its caller does — once, after its loop.** Every count on
	 * the server has just gone to nought, so there is one answer to work out for the whole server and
	 * running the comparison per player would be the same sum done once per head. See
	 * {@link refreshCrowns}, which `RoundService` calls at the boundary for exactly this.
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

		// **The box's two, written the same way and for the same reason.** A toast announces the power the
		// moment it is granted, and the two facts it needs are which power and how long is left — so both go
		// out with the rest of the readout, as `""` and `0` in the empty case rather than as an absent
		// attribute. A client's watcher fires on a removal exactly as it fires on a change, so "absent" and
		// "empty" would be two spellings of one state that the client would have to handle twice.
		const mystery = this.isMysteryActive(player) ? this.mystery.get(player) : undefined;

		player.SetAttribute(MYSTERY_POWER_ATTRIBUTE, mystery?.kind ?? "");
		player.SetAttribute(MYSTERY_POWER_ENDS_AT_ATTRIBUTE, mystery?.endsAt ?? 0);
	}

	/**
	 * Opens a window paying for one use of `kind`, or refuses because one is already running.
	 *
	 * **The caller decides both the power and the length**, and neither is an accident of this method being
	 * lazy. What a box rolls is a question about a player's *roster* — `EconomyService` owns it and answers
	 * `ownsPower` — and how long a box's window lasts is a number in the box's own config. This service has
	 * no business knowing that either exists: it is handed a kind and a duration and it runs a clock, which
	 * is the same division that lets {@link activateMultiBall} be about MultiBall while never touching a
	 * ball.
	 *
	 * **Refused while one is already running, rather than restarted or queued.** A second box collected
	 * during a live window is a box whose power the player already has; restarting would let a row of boxes
	 * extend the window indefinitely without ever granting a second power, and a queue would need a second
	 * container to hold windows nobody is using. "You already have one" is the answer the mark handler gives
	 * a second mark, and it is the same answer here.
	 *
	 * **The box is consumed by the caller either way**, this refusal included. It was picked up, the roll
	 * happened, and nothing in the game gives a collected box back.
	 */
	public openMysteryWindow(player: Player, kind: AbilityKind, seconds: number): boolean {
		if (this.isMysteryActive(player)) return false;

		this.mystery.set(player, { kind, endsAt: Workspace.GetServerTimeNow() + seconds });
		this.publish(player);

		// **Its own end, and again a convenience rather than the rule** — {@link isMysteryActive} decides
		// from the clock, so a callback that arrives late costs a stale row and never a power that outlives
		// the window it was sold in.
		task.delay(seconds, () => this.clearMysteryWindow(player));

		if (DEBUG) print(`[Super] ${player.Name}: mystery window open — ${kind} for ${seconds}s`);

		return true;
	}

	/**
	 * Whether `player` has a box's window open right now.
	 *
	 * **The clock is the rule, exactly as {@link isMultiBallActive} has it** and for the same reason: a row
	 * whose deadline has passed reads as closed even if the timer meant to remove it has not run.
	 *
	 * **This is one of the two answers to "may this player use a power", and the charge is the other.** The
	 * two call sites are `BallService.markHeldBall` and `BallService.activateMultiBall`, and each asks
	 * `hasCharge(player) || isMysteryActive(player)`. That is the whole of what a box does to the game: it
	 * does not grant a charge, it *stands in for one* for the length of its window. Ownership and the round
	 * gate are untouched by it, which is what stops a box being a way to spend a power outside a round.
	 */
	public isMysteryActive(player: Player): boolean {
		const window = this.mystery.get(player);
		if (!window) return false;

		return window.endsAt > Workspace.GetServerTimeNow();
	}

	/**
	 * Which power the box gave, or `undefined` when no window is open.
	 *
	 * **The authority for "what may this window pay for", and the reason the key that uses a box sends no
	 * argument.** A player presses one key for whatever the box rolled, and the server answers *which* one
	 * that is from here — so the kind never travels from a client, and a stale copy of
	 * `MYSTERY_POWER_ATTRIBUTE` on somebody's machine can never buy a power they were not given. See
	 * `BallService.useMysteryPower`, the one caller.
	 *
	 * `undefined` covers both "no window" and "a row whose deadline has passed", because it asks
	 * {@link isMysteryActive} rather than reading the row: a window is a clock, and the row is only where
	 * the clock is kept.
	 */
	public mysteryPowerOf(player: Player): AbilityKind | undefined {
		if (!this.isMysteryActive(player)) return undefined;

		return this.mystery.get(player)?.kind;
	}

	/**
	 * Closes `player`'s window and puts the two attributes back to their empty values.
	 *
	 * **Silent when there is no window**, like {@link clearMultiBall}: four things can close one — the
	 * clock, a death, the intermission, the round's own boundary — and any of them can arrive first.
	 *
	 * **"Stops giving and never takes back", which is MultiBall's rule and not a coincidence.** A mark
	 * already on a ball stays on it; a MultiBall window opened while this one was running keeps running on
	 * its own clock. Nothing is revoked when a window ends, because nothing here lent anything out.
	 */
	public clearMysteryWindow(player: Player): void {
		if (!this.mystery.delete(player)) return;

		this.publish(player);

		if (DEBUG) print(`[Super] ${player.Name}: mystery window closed`);
	}

	/**
	 * Recomputes who wears the crown, and writes {@link CROWN_ATTRIBUTE} on every player.
	 *
	 * **The rule, and both halves of it.** A player is crowned if `hits >= CROWN_STREAK_THRESHOLD` — hot
	 * on their own, whatever anybody else is doing — **or** if their count equals the highest on their
	 * side and is at least `1`. The floor is the half that says a side where nobody has hit anybody
	 * crowns nobody, rather than crowning whoever happens to be sitting at nought. **A tie at the top
	 * crowns both**, because the two halves are independent tests and a tiebreak would mean inventing a
	 * reason why one of two equal players is the hot one.
	 *
	 * **Computed here rather than in the client, because "the highest on their team" is not a question
	 * one client can answer.** It needs every player's count *and* every player's side at the same
	 * instant, and a client would be reading a replica of two tables this file owns, a message behind —
	 * so two clients could disagree about who is wearing a crown, and the player being crowned would be
	 * watching a third answer. The count and the side are decided here, so the answer is decided here and
	 * sent; that is the same argument that puts the streak itself on the player rather than letting each
	 * HUD count its own hits, one step further out.
	 *
	 * **Called from every event that can change an answer, which is why it is a method rather than
	 * something worked out where the attribute is read.** A hit and a death change one row; a round
	 * opening zeroes every row; a roster assignment changes who is compared against whom; a player
	 * leaving can hand the crown to whoever was second. There is no cheaper incremental version of this
	 * that is not a second copy of the rule, and the list it walks is as long as the server's player list.
	 *
	 * **Silent when nothing changed.** This runs on every hit in the game, so the write is guarded rather
	 * than unconditional — an attribute set to the value it already holds is at best a no-op the engine
	 * has to look at, and at worst a replication of nothing to every client. The print is only for a
	 * player being crowned, since a crown coming off is the ordinary case of a count coming off.
	 */
	public refreshCrowns(): void {
		// **One pass to find each side's best, one to decide.** The two cannot be one pass: a player's
		// answer depends on a maximum that may belong to somebody further down the list, so the whole
		// comparison has to be finished before anybody is judged against it.
		const bests = new Map<string, number>();

		for (const player of Players.GetPlayers()) {
			const team = teamOf(player);
			bests.set(team, math.max(bests.get(team) ?? 0, this.streaks.get(player) ?? 0));
		}

		for (const player of Players.GetPlayers()) {
			const count = this.streaks.get(player) ?? 0;
			const crowned =
				count >= SUPER_CONFIG.CROWN_STREAK_THRESHOLD || (count >= 1 && count === bests.get(teamOf(player)));

			if (player.GetAttribute(CROWN_ATTRIBUTE) === crowned) continue;

			player.SetAttribute(CROWN_ATTRIBUTE, crowned);

			if (DEBUG && crowned) print(`[Super] ${player.Name}: crowned at ${count} hit(s)`);
		}
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

/**
 * The side `player` is on, as the label `TEAM_ATTRIBUTE` holds, or `""` when they have none.
 *
 * **Read from the attribute rather than from the round's own table**, which is the whole of the
 * dependency this service has on sides: the round publishes a side per player and this compares them,
 * and nothing here has to know what a side *is* or when it is assigned. It also means a player who is
 * not in the round — a spectator holding a stale label, a joiner yet to be given one — is compared
 * among the ones like them, which is a group with no hits in it in every case the crown can be earned
 * in, and the floor of `1` is what keeps it from crowning anybody.
 *
 * **A plain `string` and not a `TeamLabel`, deliberately.** This is an attribute read, so the honest
 * type is "whatever was written there", and the two-line body is the answer to "which of those is
 * real": `""` is not a side, and the comparison treats it as a group rather than as a third team.
 */
function teamOf(player: Player): string {
	const team = player.GetAttribute(TEAM_ATTRIBUTE);

	return typeIs(team, "string") ? team : "";
}
