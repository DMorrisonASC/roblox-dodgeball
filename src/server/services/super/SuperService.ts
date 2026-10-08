import { OnStart, Service } from "@flamework/core";
import { Players, ReplicatedStorage, Workspace } from "@rbxts/services";
import { AbilityKind } from "shared/ability";
import { SUPER_CONFIG } from "shared/config/super.config";
import {
	ARMED_ABILITY_ATTRIBUTE,
	CROWN_ATTRIBUTE,
	MYSTERY_POWER_ATTRIBUTE,
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
 * The mystery-box prize a player is holding: which power it is, and nothing else.
 *
 * **One field, and the field that used to be here is the change.** The row was `{ kind, endsAt }` and the
 * window closed on a clock; it is a *prize* now, held until the player uses it, dies, or the round ends. So
 * there is no deadline to keep, no `task.delay` to schedule, and no `MYSTERY_POWER_ENDS_AT_ATTRIBUTE` to
 * publish — a countdown needs a clock, and there is deliberately no longer one to count.
 *
 * **The kind is on the row, and that is the one thing this has that a MultiBall window does not.** A
 * MultiBall window always grants MultiBall, so its row has no reason to say so; a box rolls a power at the
 * moment it is collected, and "which one" is the answer to the question the player asked by taking the box.
 * Keeping it here is what lets {@link publish} put it on the player — which is what the power slot reads —
 * and what lets a second box arriving be refused without anybody having to remember what the first one was.
 *
 * **A row rather than a bare `AbilityKind` in the map, which is the smaller shape available.** It is one
 * value today, and a `Map<Player, AbilityKind>` would say exactly the same thing — but it would say it in a
 * shape that has to be rewritten the first time this prize grows a second fact, and the container beside it
 * is already a map of rows. Named so that the two containers read as siblings.
 */
interface MysteryPrize {
	/** What the box rolled. See `shared/ability.ts` — the same union the mark remote speaks. */
	kind: AbilityKind;
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
	 * Every player holding a mystery-box prize, and what it rolled.
	 *
	 * **A second `Map` rather than another field on the rows of the first one**, because the two are
	 * different things that happen to be shaped alike. This one is bought with a box rather than with a
	 * charge, and it is asked about by the *charge test* rather than by the throw handler — see
	 * `BallService.markHeldBall` and `BallService.activateMultiBall`, which both ask "may this player do
	 * this" of two sources now. One container with two kinds of row in it would make every reader of
	 * either decide which of the two it was holding.
	 *
	 * **Keyed on the `Player`**, for the reason above: a prize is a state of the player, and a respawn
	 * replaces the body it was collected in. It is also cleaned up on `PlayerRemoving` with the others,
	 * since a row for somebody who has left is a row nothing will ever clear.
	 *
	 * **And unlike its sibling, this container has no clock in it at all.** A MultiBall window is a length
	 * of time and has to be asked how much of it is left; a prize is held until something takes it away, so
	 * the row's *presence* is the whole of the state — which is why there is no `endsAt` to compare and
	 * nothing scheduled to close it.
	 */
	private readonly mystery = new Map<Player, MysteryPrize>();

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

			// **And the box's prize goes with them, by the same argument, and with no tidy-up left behind.**
			// This is the reason the row was deleted rather than released: a release would publish to a
			// player who is no longer in the game, and no `task.delay` is waiting on this row any more, so
			// there is nothing the deletion could strand. That last part is what changed when the window
			// became a prize — the timer a live window used to schedule is gone, so the only thing that
			// could ever have been left running for this player is a row, and the row is what this deletes.
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

		// **A death loses the box's prize, and this method closes no MultiBall one.** Read the body
		// above: it resets the streak and recomputes the crown, and nothing else. `clearMultiBall` is
		// called from its own timer and from two places in `RoundService`, and a death reaches neither —
		// so a player who dies with a MultiBall window open keeps it, despite that window's own comment
		// saying a death closes one. Whether MultiBall should be closed here is its author's question and
		// not this one's; for a prize the answer is that it goes, because a fresh body in a fresh position
		// is not the player who collected it. Divergence reported rather than copied either way.
		//
		// **"Lose it" is what this half of use-it-or-lose-it means**, and it is the reason the prize has no
		// clock: without one, the only way to lose it is to be killed, which is a thing the game is already
		// about. See {@link releaseMysteryPrize} for the other endings.
		this.releaseMysteryPrize(player, "died");

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
	 *
	 * **The box's prize is the one thing that does not follow this rule, and the difference is deliberate.**
	 * A charge and a prize are both spent by a *thrown* marked ball — see {@link spendMysteryPrize}, which
	 * is called at the same two sites — but only the charge is forfeited when the ball is *dropped*. A charge
	 * is permission to place a power, so putting the ball down is the only way to lose it; a prize *is* the
	 * power, the dropped ball delivered nothing, and the player is still holding what they walked into a box
	 * for. **It is a real divergence and not an oversight:** a player can mark, put the ball down, and mark
	 * again without spending anything. Nothing is delivered by that, which is why it is left as it is — but
	 * if the box should be as strict as a charge, the line belongs beside the `forfeitCharge` call in
	 * `BallService.dropBall`.
	 */
	public spendCharge(player: Player): void {
		if (!this.charged.delete(player)) return;

		this.publish(player);

		if (DEBUG) print(`[Super] ${player.Name}: charge spent`);
	}

	/**
	 * Clears the streak for a round that is opening. **The charge is left alone, and so is the prize.**
	 *
	 * The two halves of this service have different lifetimes on purpose: a streak is a run *within* a
	 * round, so it goes when the round does, and a charge is held until it is used, so it is carried
	 * into the next round by a player who earned it and never spent it.
	 *
	 * **The prize is lost at the round's *end* rather than here, which is why it is not in this method.**
	 * It is a round-scoped thing like the streak, but not a thing a new round clears: a player who collects
	 * a box and then watches the round end has lost it in the moment the round ended, and the sweep for
	 * that lives in `RoundService` beside the `clearMultiBall` one. Clearing it here as well would work and
	 * would be a second place for the same rule — this runs when the *next* round opens, which is later than
	 * the loss the line above describes.
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
	 * **The window's count is written as `0` when there is none**, which is the empty case rather than an
	 * absent attribute — see `SUPER_MULTI_BALL_COUNT_ATTRIBUTE`. Its deadline is written the same way, and
	 * that pair is the *only* place a countdown is published: the box's prize has no deadline to write, so
	 * where this method used to write two mystery attributes it now writes one.
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

		// **The box's one, written the same way and for the same reason.** The power slot reads it to know
		// what to draw and when to run a reveal, so it goes out with the rest of the readout, as `""` in the
		// empty case rather than as an absent attribute. A client's watcher fires on a removal exactly as it
		// fires on a change, so "absent" and "empty" would be two spellings of one state that the client
		// would have to handle twice.
		//
		// **There used to be a second one beside it** — the deadline of the window this prize replaced —
		// and it is gone with the clock it described. A held prize has no end to publish.
		player.SetAttribute(MYSTERY_POWER_ATTRIBUTE, this.mystery.get(player)?.kind ?? "");
	}

	/**
	 * Puts a prize in `player`'s hands, or refuses because they are already holding one.
	 *
	 * **The caller decides the power**, and that is not this method being lazy: what a box rolls is a
	 * question about a player's *roster* — `EconomyService` owns it and answers `ownsPower` — and this
	 * service has no business knowing that exists. It is handed a kind and it remembers it, which is the
	 * same division that lets {@link activateMultiBall} be about MultiBall while never touching a ball.
	 *
	 * **It used to take a duration and run a clock, and the prize is the better rule.** A window measured in
	 * seconds made the box a *timed* thing: a player who collected one and then spent eight of their ten
	 * seconds walking back to a ball had bought nothing, and the power could expire in their hand while they
	 * were looking for something to spend it on. Held until used, the box is a decision the player gets to
	 * make when they are ready — "use it or lose it" is then a real choice about *when*, and the loss is the
	 * two ways it can genuinely be lost: dying, and the round ending.
	 *
	 * **Refused while one is already held, rather than replaced or queued.** A second box collected by a
	 * player who already holds one is a box whose power they have not used yet; replacing would let a player
	 * walk over two boxes and keep the better roll, which is a reroll rather than a pickup, and a queue would
	 * need a second container to hold prizes nobody is using. "You already have one" is the answer the mark
	 * handler gives a second mark, and it is the same answer here.
	 *
	 * **The box is consumed by the caller either way**, this refusal included. It was picked up, the roll
	 * happened, and nothing in the game gives a collected box back.
	 *
	 * **A prize displaces a dev's armed ability, and never the other way round.** The two are one slot in a
	 * player's hands — both say "the power my next press uses" — so they cannot both be held. What decides
	 * which one gives way is that a *pickup* costs something and a *key press* does not: a box is consumed
	 * the moment it is walked into, so refusing to hold its prize would throw the power away, while an arm
	 * can be asked for again a second later. So the arm is cleared here, and `BallService.markHeldBall`
	 * refuses to arm while a prize is held — the same rule read from the cheap end.
	 */
	public holdMysteryPrize(player: Player, kind: AbilityKind): boolean {
		if (this.isMysteryActive(player)) return false;

		this.mystery.set(player, { kind });

		// **The arm goes with it.** Written here rather than in `BallService` because this is where the
		// collision happens, and a player who collected a box has just chosen what their next press does.
		// Clearing it is the *permissive* half of the choice: a bare refusal would leave a dev with an arm
		// set and a prize held, and the next press spending one of them without saying which.
		player.SetAttribute(ARMED_ABILITY_ATTRIBUTE, "");

		this.publish(player);

		if (DEBUG) print(`[Super] ${player.Name}: mystery prize held — ${kind}, until it is used`);

		return true;
	}

	/**
	 * Spends the prize because the power it was paying for has just been used.
	 *
	 * **Handed the kind that was used, and that argument is the fix rather than decoration.** A prize is not
	 * a charge: a charge pays for whatever the player presses, while a box's prize pays for *the power the
	 * box rolled*. So the question here is not "is a power being used" but "is the power the box gave being
	 * used", and a press for a different kind leaves the prize alone. That distinction is invisible to an
	 * ordinary player, whose one key always uses the kind it just read from here; it exists for the dev
	 * keys, where a press for Freeze must not burn a box's Pierce.
	 *
	 * **A dev is not exempt, and that is the one place this parts company with the charge.** The dev bypass
	 * exists because a dev holds no charge to spend — there is nothing of theirs to pay with. A box's prize
	 * is not that: it is real state a player gets by walking into a box, and a dev gets it the same way. So
	 * the prize pays for a dev's press exactly as it pays for anybody's, which is also what stops the box's
	 * power being used over and over by the person most likely to notice it can be.
	 *
	 * **Called before the charge is spent, and that ordering is the rule for a player holding both.** A
	 * charge pays for the press first, so the prize steps aside: with a charge held this returns before
	 * touching the prize, and the call site then spends the charge. Called after, it would read "no charge"
	 * and eat the prize on a press the charge had already paid for.
	 *
	 * **Nothing grants a charge today**, so that branch is dead — written anyway, because the alternative is
	 * a rule that is right only while another feature is switched off.
	 *
	 * **A refused press never reaches here**, which is the other half of "use it or lose it": a press with no
	 * ball in hand, or outside a round, returns before the charge is spent, so it returns before the prize is
	 * too. Both call sites are written that way — see `BallService.throwForPlayer` and
	 * `BallService.activateMultiBall`.
	 */
	public spendMysteryPrize(player: Player, kind: AbilityKind): void {
		if (this.charged.has(player)) return;
		if (this.mystery.get(player)?.kind !== kind) return;

		this.releaseMysteryPrize(player, `the power was used — ${kind}`);
	}

	/**
	 * Whether `player` is holding a box's prize right now.
	 *
	 * **Presence is the rule, where a clock used to be.** This asked whether a deadline had passed; there is
	 * no deadline, so it asks whether the row exists. That is not a simplification of the same rule — it is
	 * the different rule this feature now has: a prize ends when it is *used* or lost, never because time
	 * went by, so nothing here has to be compared against `Workspace:GetServerTimeNow()` and no timer has to
	 * be scheduled to make the answer come out right.
	 *
	 * **This is one of the two answers to "may this player use a power", and the charge is the other.** The
	 * two call sites are `BallService.markHeldBall` and `BallService.activateMultiBall`, and each asks
	 * `hasCharge(player) || isMysteryActive(player)`. That is the whole of what a box does to the game: it
	 * does not grant a charge, it *stands in for one* until the power is used. Ownership and the round gate
	 * are untouched by it, which is what stops a box being a way to spend a power outside a round.
	 */
	public isMysteryActive(player: Player): boolean {
		return this.mystery.has(player);
	}

	/**
	 * Which power the box gave, or `undefined` when no prize is held.
	 *
	 * **The authority for "what may this prize pay for", and the reason the key that uses a box sends no
	 * argument.** A player presses one key for whatever the box rolled, and the server answers *which* one
	 * that is from here — so the kind never travels from a client, and a stale copy of
	 * `MYSTERY_POWER_ATTRIBUTE` on somebody's machine can never buy a power they were not given. See
	 * `BallService.useMysteryPower`, the one caller.
	 *
	 * It asks {@link isMysteryActive} rather than reading the row directly, which now costs a second lookup
	 * for no difference in answer — kept because it is the same *rule* read from one place, and the day the
	 * row's presence stops being the whole of the state this line follows it for free.
	 */
	public mysteryPowerOf(player: Player): AbilityKind | undefined {
		if (!this.isMysteryActive(player)) return undefined;

		return this.mystery.get(player)?.kind;
	}

	/**
	 * Takes `player`'s prize away and puts the attribute back to its empty value.
	 *
	 * **Silent when there is no prize**, like {@link clearMultiBall}: four things can take one away — using
	 * it, a death, the round ending, a player leaving — and any of them can arrive first. That is what makes
	 * the round-end sweep safe to write unconditionally over every player, and what makes a death on the
	 * last ball of a round cost one release rather than two.
	 *
	 * **`reason` is for the log**, and it is not decoration: the endings are indistinguishable from the
	 * outside, and the one explanation that used to be available — the window running out — no longer
	 * exists. A line reading "released" with no more to it would send a reader looking for a timer that is
	 * not there.
	 *
	 * **"Stops giving and never takes back", which is MultiBall's rule and not a coincidence.** A mark
	 * already on a ball stays on it; a MultiBall window opened while this prize was held keeps running on its
	 * own clock. Nothing is revoked when a prize is released, because nothing here lent anything out — the
	 * prize *was* the permission, and it is gone.
	 */
	public releaseMysteryPrize(player: Player, reason: string): void {
		if (!this.mystery.delete(player)) return;

		this.publish(player);

		if (DEBUG) print(`[Super] ${player.Name}: mystery prize released — ${reason}`);
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
