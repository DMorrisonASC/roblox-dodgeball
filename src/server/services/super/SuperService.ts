import { OnStart, Service } from "@flamework/core";
// **`Workspace` was imported for one thing: `GetServerTimeNow()`, stamped into a MultiBall window's
// deadline.** The deadline is gone and so is the import — if it comes back for a clock, it comes back with
// the clock rather than sitting here unused. `ReplicatedStorage` is still the round's status folder.
import { Players, ReplicatedStorage } from "@rbxts/services";
import { AbilityKind } from "shared/ability";
import { SUPER_CONFIG } from "shared/config/super.config";
import {
	ARMED_ABILITY_ATTRIBUTE,
	CROWN_ATTRIBUTE,
	MYSTERY_POWER_ATTRIBUTE,
	POWER_READY_ATTRIBUTE,
	PRACTICE_ZONE_ATTRIBUTE,
	ROUND_STATE_ATTRIBUTE,
	ROUND_STATUS_FOLDER,
	SUPER_CHARGE_ATTRIBUTE,
	SUPER_MULTI_BALL_COUNT_ATTRIBUTE,
	SUPER_STREAK_ATTRIBUTE,
	TEAM_ATTRIBUTE,
} from "shared/constants";
import { rigsOnASide } from "../../npc/rigs";

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
 * A MultiBall window that is running, and how many throws it has left.
 *
 * **A row in a `Map` rather than attributes treated as the state**, which is this service's own rule:
 * the `Map` is the truth and the attributes are published for the client. A `Player` attribute is not a
 * place to keep a decision.
 *
 * **One field, and the field that used to be here is the change.** The row was `{ endsAt, remaining }` and
 * the window closed when either ran out; it is **the count alone** now. There is no deadline to compare
 * against `Workspace:GetServerTimeNow()`, no `task.delay` scheduled to clear the row when one passed, and
 * nothing published that a countdown could be drawn from. A window lasts until its last throw is spent,
 * wherever in a round that happens to be — see {@link consumeMultiBallBall}, which is where the final
 * throw closes it, and `SUPER_CONFIG.MULTI_BALL_BALL_COUNT` for what that makes this ability.
 */
interface MultiBallWindow {
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
	/**
	 * Every body's current streak. Absent means zero — a body that has not hit anybody yet.
	 *
	 * **Keyed on a `Player` for a player and on a `Model` for a rig, and the two keys are the two kinds of
	 * body a hit can be credited to.** A player's streak belongs to the *player* — it outlives the body, and
	 * a respawn keeps it, which is the whole reason the death reset is explicit rather than a side effect of
	 * the character going away. A rig's streak belongs to its *model* — a rig has no `Player` behind it, and
	 * its body *is* its identity, so a rig's streak dies with the body and the death reset is the *delete*
	 * that would otherwise leak. The map holds both, and {@link refreshCrowns} walks both the same way.
	 */
	private readonly streaks = new Map<Player | Model, number>();

	/**
	 * **When each body last moved its own count, as a ticket off a counter rather than a clock.**
	 *
	 * It exists for one question and is read in one place: a tie at the top of a side has to be broken, and
	 * the tie is broken by *who got there last*. See {@link refreshCrowns} for the rule and for why a tie is
	 * no longer shared.
	 *
	 * **A monotonic integer and not `os.clock()`.** Two hits in the same frame — a MultiBall throw landing on
	 * two bodies, which is an ordinary thing here — read the same clock, so a clock would leave the tie it is
	 * supposed to break unbroken and make the answer depend on the order two entries happened to be assigned
	 * in. A counter cannot tie with itself.
	 *
	 * **Deleted whenever the count goes back to nought**, by the same argument `streaks` is zeroed: a ticket
	 * describing a run that no longer exists is a number that could only be read by a bug.
	 */
	private readonly recentHits = new Map<Player | Model, number>();

	/** The ticket the next hit takes. Read and written only by {@link noteHit}. */
	private hitSequence = 0;

	/**
	 * Who is holding a charge.
	 *
	 * A `Set` rather than a count, because the rule is "only one charge at a time": the question is
	 * yes or no, and a number that is only ever 0 or 1 is a number with a rule attached that nothing
	 * checks.
	 */
	private readonly charged = new Set<Player>();

	/**
	 * Every body with a MultiBall window open, and what is left of it.
	 *
	 * **Keyed on the `Player` for a player, and on the `Model` for a rig**, and the two have different
	 * reasons for the same key shape. A player's window belongs to the *player* — the reason
	 * `ARMED_ABILITY_ATTRIBUTE` gives about the dev's arm — and a respawn replaces the body it was opened
	 * in; a rig's window belongs to the *model*, because a rig has no `Player` behind it and its body *is*
	 * its identity. The map holds both, and the only owner-type difference in this file is that a player's
	 * window is published to their attributes while a rig's is not — see {@link publish}, which is still
	 * `Player`-keyed. Whether a death should close one is a separate decision, and it is made where deaths
	 * are handled rather than here — this service is told about states and never about bodies.
	 *
	 * **It used to be the one container here with a *clock* on its rows, and the sentence that said so is
	 * replaced rather than deleted because the reversal is the part worth reading.** The rows carried a
	 * deadline so a window could be closed by time alone; they carry nothing but a count now, and the
	 * consequence that matters when reading the rest of this file is that **a window can outlive a round** —
	 * nothing about it is measured in seconds. That is why the two callers that close one anyway, a death and
	 * the end of a round, are load-bearing rather than tidy-up: they are now the only endings the ability has
	 * other than a body spending all five throws.
	 */
	private readonly multiBalls = new Map<Player | Model, MultiBallWindow>();

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
	 * **Neither container has a clock in it now, and this one never did.** A prize is held until something
	 * takes it away, so the row's *presence* is the whole of the state — which is why there is no `endsAt` to
	 * compare and nothing scheduled to close it. **Its sibling has since joined it**: a MultiBall window is a
	 * count of throws rather than a length of time, so neither of the two things a player can hold here
	 * expires on its own, and both are ended by something a player or a round does.
	 */
	private readonly mystery = new Map<Player, MysteryPrize>();

	/**
	 * **The power each player has armed and not yet spent** — the truth behind `POWER_READY_ATTRIBUTE`, and
	 * the only container in this file that is player-only.
	 *
	 * **Why it exists when the mark is already on the ball.** A ball-carried power is a property of the
	 * *ball* (`BALL_ABILITY_ATTRIBUTE`), and this service deliberately never touches one — so the HUD, which
	 * has one player's attributes and no ball, could not otherwise tell "my ball is loaded" from "my ball is
	 * ordinary". `BallService` is the side of that line that holds the ball, so it is the side that reports
	 * the two moments: armed when the mark lands, complete when that ball's fate changes. See
	 * {@link armPower} for the arming sites and the four completions, and {@link completePower} for why a
	 * completion names no kind.
	 *
	 * **A `Map` of kinds rather than a `Set`**, which is the shape the prompt-sized question would settle for:
	 * one boolean would answer the HUD today and have to be joined to a second attribute the first time a log
	 * line or a label wants to name the power. The kind is also what makes a late completion harmless — see
	 * `completePower`.
	 *
	 * **`Player` and not `Player | Model`, unlike both of its siblings.** A rig has no HUD, no arm and no
	 * `POWER_READY_ATTRIBUTE` to publish; its own equivalent is the pending slot on the body and the mark on
	 * the ball, both of which already exist. Widening this key would be a row nothing reads.
	 */
	private readonly armed = new Map<Player, AbilityKind>();

	public onStart(): void {
		// **The one leak this service can have.** Both containers are keyed on a `Player`, so a player
		// who leaves would otherwise keep their row for the life of the server. The charge is
		// deliberately not carried across a rejoin — it is earned in a session and spent in one.
		Players.PlayerRemoving.Connect((player) => {
			this.streaks.delete(player);
			this.recentHits.delete(player);
			this.charged.delete(player);

			// **The window goes with them, and nothing is left scheduled for it.** The deletion is all of it:
			// where a live window used to have a `task.delay` waiting to close it, `clearMultiBall` is only
			// ever called by a throw, a death or the round's end now — so there is no callback that could
			// arrive for a player who has gone, and no timer to be harmless about.
			this.multiBalls.delete(player);

			// **And the box's prize goes with them, by the same argument, and with no tidy-up left behind.**
			// This is the reason the row was deleted rather than released: a release would publish to a
			// player who is no longer in the game, and no `task.delay` is waiting on this row any more, so
			// there is nothing the deletion could strand. That last part is what changed when the window
			// became a prize — the timer a live window used to schedule is gone, so the only thing that
			// could ever have been left running for this player is a row, and the row is what this deletes.
			this.mystery.delete(player);

			// **And the armed row, on the same argument and with one difference worth a line.** The other two
			// are state a player *has*; this one is state a player's *ball* has, copied here for the HUD — so
			// deleting it strands nothing at all, because the mark it described left the game with the body.
			this.armed.delete(player);

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
				`[Super] up — crowning the leader of each side at ${SUPER_CONFIG.CROWN_STREAK_THRESHOLD}+ hits,` +
					` a tie going to the newest; nothing grants a charge but the dev bypass`,
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
	 * **A body and not a token, and the change is the widening that lets a rig's kill count.** The token
	 * used to arrive here and be resolved to a `Player` by {@link playerOf}, which answers nothing for a
	 * rig's GUID — so a rig's throw killed the body it landed on but never moved a run. The thrower is now
	 * resolved by the caller (`BallComponent.score`, through `RoundService.throwerOf`), and the caller is
	 * also where the round-participation gate lives: a hit reaches this method only if the thrower is a
	 * body the round is actually playing — a player in `activePlayers`, or a rig on a side during
	 * `Playing`. That gate is what keeps a practice hit out of the run, and it subsumes the old
	 * `isRoundActive` read, which this method no longer makes.
	 */
	public noteHit(thrower: Player | Model): void {
		const streak = (this.streaks.get(thrower) ?? 0) + 1;

		this.streaks.set(thrower, streak);

		// **The ticket goes on before the crown is worked out**, because the crown reads it: this hit is what
		// makes this body the newest arrival at whatever count it has just reached, so writing it after the
		// refresh would decide a tie with the previous holder's number. See {@link recentHits}.
		this.hitSequence += 1;
		this.recentHits.set(thrower, this.hitSequence);

		// A rig publishes no readout; a player's streak goes out with the rest of the HUD's state.
		if (thrower.IsA("Player")) this.publish(thrower);

		// **And the crown is decided after the count, never before.** Whether this hit crowned anybody
		// depends on the count it has just made and on every other body's count and side, so the
		// recomputation has to follow the write — and it carries the other half of the rule as well: this
		// hit may have taken the crown off the body who used to be their side's highest.
		this.refreshCrowns();

		if (DEBUG) print(`[Super] ${thrower.Name}: hits ${streak}`);
	}

	/**
	 * A body died, so the count goes back to zero. **The charge does not.**
	 *
	 * **This is now the only thing outside the round boundary that resets the count.** A throw that
	 * landed on nobody used to reset it too, through a `noteMiss` that used to stand here; that method is
	 * gone rather than switched off, and nothing replaced it, because the count no longer buys anything
	 * that has to be defended. See `BallComponent.score`, which still refuses to record a hit for a miss
	 * and simply no longer reports one.
	 *
	 * **A body rather than a token, and the widening is what makes a rig's death reset its run.** A
	 * player's death is resolved by `RoundService.handleDeath`, which hands over the `Player`; a rig's
	 * death is resolved by `NpcService`, which hands over the `Model`. Both arrive here and both end the
	 * same way — the count is nought and the crown is recomputed. The one difference is bookkeeping, not
	 * rule: a player's row is *zeroed* (the player outlives the body and the HUD reads the row), while a
	 * rig's row is *deleted* (the model is about to be destroyed, and a row keyed on it is a leak).
	 *
	 * **No round check here, deliberately.** The caller's own guard sits upstream: a player's death
	 * outside a playing phase returns before reaching it, and a rig's death is only announced for a rig
	 * that was actually in the world. A second check here would be a copy of a rule the caller has
	 * already applied, which is the thing this codebase refuses to write twice.
	 */
	public noteDeath(owner: Player | Model): void {
		if (owner.IsA("Player")) {
			this.resetStreak(owner, "died");

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
			this.releaseMysteryPrize(owner, "died");

			// **And whatever was armed goes with them**, which is the third of the three things a death ends
			// here and the only one that is not a `MultiBall` question. A marked ball in a dead player's hand is
			// about to be destroyed with the body (`RoundService` removes a dying player's ball), so the mark is
			// gone whether or not this line is here — but the *attribute* is what the HUD reads, and a body
			// looking at a `READY` text it can no longer spend is the ghost this clear exists to prevent. See
			// {@link completePower}.
			//
			// **A MultiBall window is not this method's to close, and on a death it is already closed**: the
			// round's own `handleDeath` calls `clearMultiBall` before it reaches here, and the derived `ready`
			// in `publish` follows the count rather than a row. That is why the death path needs one line here
			// and none for the window.
			this.completePower(owner);
		} else {
			// A rig's prize is its `PENDING_ABILITY_ATTRIBUTE` slot, not a row here, and its streak row dies
			// with the body it is keyed on — `RespawnBehavior` is about to destroy the model. The delete is
			// the whole of the rig half: the observable rule is the same as a player's (nought, crown off),
			// and the only difference is that a rig's key cannot be kept the way a player's can.
			//
			// **The delete's answer is the print's gate, and that makes the rig half read like the player
			// half.** `Map.delete` answers whether a row existed, which is exactly the test `resetStreak`
			// applies before its own line — so a rig that died with nothing to clear stays silent, and a
			// rig whose run actually ends says so in the same words a player's does.
			const had = this.streaks.delete(owner);

			// And its ticket, on the same argument as `resetStreak`'s — a rig's row cannot be zeroed, so
			// everything keyed on it goes.
			this.recentHits.delete(owner);

			if (DEBUG && had) print(`[Super] ${owner.Name}: streak reset — died`);
		}

		// **And a death can move a crown that is not this body's.** The count has just gone to nought,
		// which changes the maximum it was measured against — so the answer is recomputed even though the
		// body who died is certainly not wearing it any more.
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
	 * Opens a MultiBall window for `owner`, or refuses because one is already running.
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
	 * one and changing your mind costs nothing — where this *is* the commitment: the window starts the
	 * moment it is asked for, and **it runs until five throws have been spent on it, whether or not the
	 * player is doing anything with them.** That is what buying a mark means, and what buying a stock of
	 * throws means. **It used to be ten seconds and it is not a length of time at all now** — the count is
	 * the only limit — so the commitment reads differently from how it used to: a window opened and never
	 * thrown in is five throws the player never took, and it ends when they die or the round does rather
	 * than when a clock they were racing runs out. See `BallService.activateMultiBall`, which is the
	 * handler that spends the charge.
	 *
	 * Returns whether a window was opened, so the caller can tell an accepted press from a refused
	 * second one.
	 */
	public activateMultiBall(owner: Player | Model): boolean {
		if (this.multiBalls.has(owner)) return false;

		this.multiBalls.set(owner, { remaining: SUPER_CONFIG.MULTI_BALL_BALL_COUNT });

		// **A player's window is published to their attributes; a rig's is not**, because a rig has no HUD
		// to read it. The row itself is the same for both — one map, one count — and the publish is the only
		// owner-type difference here.
		if (owner.IsA("Player")) this.publish(owner);

		// **There is no timer here any more, and its absence is the change.** A `task.delay` used to be
		// scheduled for the length of the window, so the row went away when the clock did — the row was the
		// convenience and the clock in {@link isMultiBallActive} was the rule. **The count is the rule now**,
		// and what closes the window is the throw that spends the last of it: see
		// {@link consumeMultiBallBall}, which is where the row is dropped. Nothing has to run later, which
		// also means nothing can be left scheduled for a body who has since died or left the game.
		if (DEBUG) {
			print(
				`[Super] ${owner.Name}: MultiBall window open — ` +
					`${SUPER_CONFIG.MULTI_BALL_BALL_COUNT} throws, until they are spent`,
			);
		}

		return true;
	}

	/**
	 * Whether `owner` has a window open right now — **which is now the same question as whether they have a
	 * throw left.**
	 *
	 * **The count is the rule and the `Map` is only where the row is kept.** There is no clock to compare
	 * against any more: a window is open while `remaining` is above nought and closed at nought, so it can
	 * neither outlive what it was sold for nor end while throws are still on it. `Workspace:GetServerTimeNow()`
	 * is not read here at all, and that absence is the whole of the change.
	 *
	 * **That is also why this and `hasMultiBallBalls` became one method.** They asked different questions
	 * while a deadline existed — "is the window open" and "is there a throw in it" — and with the deadline gone
	 * they are one test written twice, which is the kind of pair this codebase deletes rather than keeps in
	 * step by hand. The name kept is this one, because it is what the published count now means: **a non-zero
	 * count *is* an active window**, which is what lets the HUD draw the MultiBall icon from the count alone.
	 * See `SuperHudController`.
	 */
	public isMultiBallActive(owner: Player | Model): boolean {
		const window = this.multiBalls.get(owner);
		if (!window) return false;

		return window.remaining > 0;
	}

	/**
	 * Spends one throw of the window, answers whether there was one to spend, **and closes the window when
	 * that was the last one.**
	 *
	 * **The count is a number of throws rather than of balls**, which is why the caller asks this *before*
	 * deciding whether to hand a ball over: the last throw of a window is deliberately not answered, so the
	 * caller asks again after this has answered yes. See `BallService.refillFromBuff`, which is the only
	 * caller and where that rule is written down with the reason for it.
	 *
	 * **Dropping the row on the way out is the window's new ending.** The fifth throw is spent here, so the
	 * row goes here: for a player that publishes the count as `0`, which is the empty case the HUD reads as
	 * "no window" and which stops the MultiBall icon being drawn — and it is what makes "the count is the only
	 * limit" true in one place rather than a rule the reader has to assemble from three separate tests. The
	 * order matters in one direction only: the row is deleted *after* the decrement and the publish, so the
	 * log line above is the last thing that ever sees the count at nought.
	 */
	public consumeMultiBallBall(owner: Player | Model): boolean {
		if (!this.isMultiBallActive(owner)) return false;

		const window = this.multiBalls.get(owner);
		if (!window) return false;

		window.remaining -= 1;

		// A rig's window is not published, for the reason `activateMultiBall` gives.
		if (owner.IsA("Player")) this.publish(owner);

		if (DEBUG) print(`[Super] ${owner.Name}: MultiBall throw spent — ${window.remaining} left`);

		if (window.remaining <= 0) this.clearMultiBall(owner);

		return true;
	}

	/**
	 * Closes `owner`'s window: **the last throw was spent**, they died, or the round ended.
	 *
	 * **Nothing outside this service is touched, and "the ball in the hand stays" is a rule rather than
	 * an omission.** Closing a window takes the *supply* away — no more balls are handed over — and
	 * leaves whatever the body is holding exactly where it is, because a ball in a hand when the
	 * window ends was not lent to them by the window. **The new ending makes that visible rather than
	 * theoretical**: spending the fifth throw closes the window on the same frame, and that throw still
	 * flies — the ball left the hand as the count reached nought, and nothing here takes a ball back.
	 *
	 * **Silent when there is no window**, which is the ordinary case for two of the three callers: a death
	 * and a round ending both fire for every player in the game, including the ones with no window at all.
	 * The third caller — the throw that empties one — reaches this once per window and never twice. Three
	 * things can close a window and any of them can arrive first, which is why the guard is a `delete` that
	 * reports whether it deleted rather than a test followed by a delete.
	 */
	public clearMultiBall(owner: Player | Model): void {
		if (!this.multiBalls.delete(owner)) return;

		if (owner.IsA("Player")) this.publish(owner);

		if (DEBUG) print(`[Super] ${owner.Name}: MultiBall window closed`);
	}

	/**
	 * **Records that `player` has a power armed and unspent, and publishes the fact** — one of the two
	 * moments the HUD's `READY` text is drawn from.
	 *
	 * **Every power has an arming moment and a "done" moment, they live in different files, and neither of
	 * them is this service's** — that is the whole of the pattern, and the reason it is two methods rather
	 * than a callback registry or a per-power class:
	 *
	 * - **Arming is the moment a power becomes ready to fire.** For a ball-carried power it is the mark
	 *   landing on the ball in the player's hand — `BallService.markHeldBall`, and `attachToHand` for the
	 *   case where a dev's arm is taken up by the first ball to arrive. MultiBall has nothing to record:
	 *   a window with throws left *is* an armed power, so `publish` derives it (see `ready` below) rather
	 *   than keeping a second row that could disagree with the count.
	 * - **The done trigger is whatever ends that power's life, and it is written at the site that already
	 *   knows.** A ball's four are the throw (`throwBallBody`), the drop (`dropBall`), and the two ways the
	 *   ball stops being the one in that hand (`attachToHand`'s replace, `removeBall`'s destroy); MultiBall's
	 *   is the last throw (`consumeMultiBallBall` closes the window, and the derivation follows it), a death,
	 *   and the round ending. **A future power of neither shape** — a banana placed on the floor — adds one
	 *   line at its placement site and nothing at all here, which is the property this exists for.
	 *
	 * **The alternative that was refused: a registry of per-power cleanup callbacks.** It reads as the more
	 * extensible answer, and it is the one place where the "done" condition would be *described* rather than
	 * *observed* — so a power whose ending arrives twice, or not at all, would be a bug inside this file
	 * rather than a missing line in the file that owns the condition. Every ending in this game is already an
	 * event some other service handles; this service only needs to be told, and told the same way each time.
	 *
	 * **Re-arming replaces rather than stacks**, which is all a player can do: one ball in a hand, one window
	 * at a time. A second mark inside a round is the ordinary case (mark, throw, mark again), and it is the
	 * same power or a different one — both read as "armed" and both are cleared by the same completion.
	 */
	public armPower(player: Player, kind: AbilityKind): void {
		this.armed.set(player, kind);

		this.publish(player);

		if (DEBUG) print(`[Super] ${player.Name}: ${kind} armed — the HUD says ready until it is spent`);
	}

	/**
	 * **Ends whatever power `player` had armed**, and publishes it gone.
	 *
	 * **Silent when nothing was armed**, for `clearMultiBall`'s reason: four callers fire for every player
	 * they touch (a throw, a drop, a death, a round ending) and most of them find nothing to clear, so the
	 * guard is the `delete`'s own answer rather than a test in front of it.
	 *
	 * **No kind argument, and that is a decision rather than a shortcut.** A caller knows *a* power ended
	 * but not reliably *which*: a player can mark, throw, and mark again inside a round, and a body can be
	 * disarmed by something that never knew what was armed (a ball destroyed by a round cleanup). Asking the
	 * caller to name the kind would let a completion for Freeze clear a Pierce armed a moment later, and the
	 * question every real caller is answering is "this body's armed power is over" — which is true whatever
	 * it was holding.
	 */
	public completePower(player: Player): void {
		if (!this.armed.delete(player)) return;

		this.publish(player);

		if (DEBUG) print(`[Super] ${player.Name}: armed power over — nothing is ready`);
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

		// **The ticket goes too, and this one matters more than the death's.** A run left over from one round
		// could otherwise out-ticket an earlier hit of the next, so a body that has not hit anything since the
		// round opened would win a tie it should have lost — the ticket is only meaningful inside the run it
		// was written for.
		this.recentHits.delete(player);

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
	 * absent attribute — see `SUPER_MULTI_BALL_COUNT_ATTRIBUTE`. **It is now the only thing published about a
	 * MultiBall window**, and that is worth a line because it used to be one of a pair: a deadline went out
	 * beside it so a HUD could count down to the moment the window closed, and the window has no deadline to
	 * send. The consequence for a reader is that a non-zero count is the whole of "a window is running" —
	 * which is what `SuperHudController` draws the MultiBall icon from.
	 */
	private publish(player: Player): void {
		player.SetAttribute(SUPER_STREAK_ATTRIBUTE, this.streaks.get(player) ?? 0);
		player.SetAttribute(SUPER_CHARGE_ATTRIBUTE, this.charged.has(player));

		// **"Is there a row" is still not the test, and the difference is still the point of {@link
		// isMultiBallActive}.** The test itself has changed — it is the count now, not a deadline — but the
		// reason for asking it *through* the method has not: a row can exist while the window is over, and
		// publishing that row would put a count on the HUD for an ability that has ended.
		const window = this.isMultiBallActive(player) ? this.multiBalls.get(player) : undefined;

		player.SetAttribute(SUPER_MULTI_BALL_COUNT_ATTRIBUTE, window?.remaining ?? 0);

		// **The box's one, written the same way and for the same reason.** The power slot reads it to know
		// what to draw and when to run a reveal, so it goes out with the rest of the readout, as `""` in the
		// empty case rather than as an absent attribute. A client's watcher fires on a removal exactly as it
		// fires on a change, so "absent" and "empty" would be two spellings of one state that the client
		// would have to handle twice.
		//
		// **There used to be a second one beside it** — the deadline of the window this prize replaced —
		// and it is gone with the clock it described. A held prize has no end to publish.
		player.SetAttribute(MYSTERY_POWER_ATTRIBUTE, this.mystery.get(player)?.kind ?? "");

		// **And whether anything is armed, which is the one attribute here that is *derived* rather than
		// stored.** Two things make a player ready: a power they have marked onto the ball in their hand
		// (this service's `armed` row, written by `BallService` at the two ends of that ball's fate) and a
		// MultiBall window with throws left — and the window is *asked* rather than copied, so the count and
		// the text can never disagree about whether the window is running. That is the same rule the line
		// above follows for the count itself: ask the thing that knows, publish the answer.
		//
		// **`true` rather than the kind**, because the HUD draws one word. A reader that wants which power is
		// armed has `MYSTERY_POWER_ATTRIBUTE` (a held prize), `SUPER_MULTI_BALL_COUNT_ATTRIBUTE` (a window),
		// and the ball's own `BALL_ABILITY_ATTRIBUTE`; this is the yes/no the label needs. See
		// `POWER_READY_ATTRIBUTE`.
		player.SetAttribute(POWER_READY_ATTRIBUTE, this.armed.has(player) || this.isMultiBallActive(player));
	}

	/**
	 * Whether `player` may take a prize right now — **the one statement of the rule {@link holdMysteryPrize}
	 * enforces, asked separately because the mystery box needs the answer without acting on it.**
	 *
	 * **Two reasons to say no, and they are the two things a player can be holding.** A prize already held is
	 * the original one: a second box walked into by somebody who has not spent the first is a box whose power
	 * they have not used yet. **A MultiBall window is the new one, and it is a consequence of the window losing
	 * its clock**: with no deadline a window can now last a whole round, and letting a player hold a box's
	 * power on top of one would make MultiBall a stock *and* a second ability at the same time — two powers for
	 * one price, for as long as the throws last. Refusing is the cheap half of that: the box is not consumed
	 * (see `MysteryBoxService.collect`), so the prize is still standing there for them the moment the window
	 * closes or they spend it.
	 *
	 * **`MysteryBoxService` asks this and not `holdMysteryPrize`**, because its question is "should this box be
	 * taken" and that has to be answered *before* the box is. Asking the acting method instead would mean
	 * taking a prize and then trying to hand it back. Both go through this test, so the rule is written once —
	 * which is also why `holdMysteryPrize` calls it rather than testing the two containers itself.
	 */
	public canHoldMysteryPrize(player: Player): boolean {
		if (this.isMysteryActive(player)) return false;
		if (this.multiBalls.has(player)) return false;

		return true;
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
	 * handler gives a second mark, and it is the same answer here. **The rule is
	 * {@link canHoldMysteryPrize}'s now**, which is also where "a running MultiBall window refuses a box"
	 * lives — the same refusal, one reason further along.
	 *
	 * **The box's fate is no longer this refusal's**, and that is the change. The sentence here used to read
	 * *"the box is consumed by the caller either way, this refusal included"*; a refusal now means the box
	 * stays in the world for the player to come back to. See `MysteryBoxService.collect`, which asks
	 * {@link canHoldMysteryPrize} before it rolls and takes nothing unless something was granted.
	 *
	 * **A prize displaces a dev's armed ability, and never the other way round.** The two are one slot in a
	 * player's hands — both say "the power my next press uses" — so they cannot both be held. What decides
	 * which one gives way is that a *pickup* costs something and a *key press* does not: a box is consumed
	 * the moment it is walked into, so refusing to hold its prize would throw the power away, while an arm
	 * can be asked for again a second later. So the arm is cleared here, and `BallService.markHeldBall`
	 * refuses to arm while a prize is held — the same rule read from the cheap end.
	 */
	public holdMysteryPrize(player: Player, kind: AbilityKind): boolean {
		if (!this.canHoldMysteryPrize(player)) return false;

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
	 * ball in hand, or with no round running and no practice zone to stand in, returns before the charge is
	 * spent, so it returns before the prize is too. Both call sites are written that way — see
	 * `BallService.throwForPlayer` and `BallService.activateMultiBall`.
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
	 * does not grant a charge, it *stands in for one* until the power is used. Ownership and the
	 * round-or-zone gate are untouched by it — see {@link inRoundOrZone}, which is where "may a power be
	 * used here at all" is answered — and keeping the two apart is what stops a box being a way to spend a
	 * power in the lobby.
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
	 * Recomputes who wears the crown, and writes {@link CROWN_ATTRIBUTE} on every body.
	 *
	 * **The rule.** A body wears the crown if it is **its side's leader** and its count is at least
	 * `CROWN_STREAK_THRESHOLD`. The floor is what says a side where nobody has reached three crowns nobody,
	 * rather than crowning whoever happens to be sitting at nought.
	 *
	 * **A tie is broken by recency, so one side has one crowned body.** This used to say `count === best` and
	 * crown both, on the argument that a tiebreak would be inventing a reason why one of two equal bodies is
	 * the hot one. That argument was wrong about what the crown is for: **it is a single thing a viewer reads
	 * to know who is winning the side**, and two crowns on one side read as a broken indicator rather than as
	 * a tie — the user's report of exactly that is what changed the rule. A tie still *breaks* on nothing the
	 * players did differently, but it has to break, so it breaks on the one fact a scoreboard already has an
	 * order for: **who got there last**. That is also the moment worth marking — a body that has just passed
	 * or caught up is the one with something to show for it, and the body it just tied with has been sitting
	 * there.
	 *
	 * **"Last" is a ticket, not a clock.** The order comes from {@link recentHits}, which {@link noteHit}
	 * stamps with a counter — see that field for why `os.clock()` would not do: two bodies hit in one frame by
	 * an ordinary MultiBall throw read the same time, and the tie would come back.
	 *
	 * **The crown is live, not an award.** It is recomputed on every hit and every death, so the body that
	 * was the best stops wearing it the moment another body passes them *or ties them and is newer*, and a
	 * body that drops below three — through the death reset — has the crown come off with the count.
	 *
	 * **Computed here rather than in the client, because "the leader of their side" is not a question one
	 * client can answer.** It needs every body's count *and* every body's side at the same instant, and a
	 * client would be reading a replica of two tables this file owns, a message behind — so two clients
	 * could disagree about who is wearing a crown, and the body being crowned would be watching a third
	 * answer. The count and the side are decided here, so the answer is decided here and sent.
	 *
	 * **Called from every event that can change an answer.** A hit and a death change one row; a round
	 * opening zeroes every row; a roster assignment changes who is compared against whom; a player leaving
	 * can hand the crown to whoever was second. There is no cheaper incremental version of this that is
	 * not a second copy of the rule.
	 *
	 * **Silent when nothing changed.** This runs on every hit in the game, so the write is guarded rather
	 * than unconditional — an attribute set to the value it already holds is at best a no-op the engine
	 * has to look at, and at worst a replication of nothing to every client. The print is only for a body
	 * being crowned, since a crown coming off is the ordinary case of a count coming off.
	 */
	public refreshCrowns(): void {
		// **One pass to find each side's leader, one to decide.** The two cannot be one pass: a body's answer
		// depends on a leader that may be somebody further down the list, so the whole comparison has to be
		// finished before anybody is judged against it. Two walks — the players, then the rigs — because a
		// side's leader is the leader of *both* kinds of body, and neither list knows the other.
		const leaders = new Map<string, CrownLeader>();

		/** Folds one body into its side's leader. See {@link CrownLeader} for why the ticket is kept. */
		const consider = (body: Player | Model, team: string): void => {
			const count = this.streaks.get(body) ?? 0;
			const at = this.recentHits.get(body) ?? 0;
			const current = leaders.get(team);

			// **Higher count wins, then the newer ticket** — and a body that ties the leader but is older is
			// simply not installed, which is the whole of "the crown stays where it was".
			if (current !== undefined && (count < current.count || (count === current.count && at <= current.at))) {
				return;
			}

			leaders.set(team, { body: body, count: count, at: at });
		};

		for (const player of Players.GetPlayers()) consider(player, teamOf(player));

		for (const { rig, team } of rigsOnASide()) consider(rig, team);

		for (const player of Players.GetPlayers()) this.applyCrown(player, teamOf(player), leaders);

		for (const { rig, team } of rigsOnASide()) this.applyCrown(rig, team, leaders);
	}

	/**
	 * Writes the crown onto one body — **the single place the rule is decided, for a player and a rig
	 * alike.**
	 *
	 * **One function rather than two loops carrying the comparison**, so a change to the rule cannot reach
	 * one kind of body and miss the other. The attribute is the same name on both — `CROWN_ATTRIBUTE` —
	 * which is the whole of "a rig wears the crown the way a player does": the server writes one flag, the
	 * client reads one flag, and neither asks what kind of body it is on.
	 *
	 * **Identity, not a count comparison, and that is what makes one crown per side.** Asking whether this
	 * body *is* its side's leader is a question with exactly one true answer per side; asking whether its
	 * count equals the best is the same question with no answer at all when two counts are equal, which is
	 * the fault this replaced.
	 */
	private applyCrown(body: Player | Model, team: string, leaders: ReadonlyMap<string, CrownLeader>): void {
		const leader = leaders.get(team);
		const count = this.streaks.get(body) ?? 0;
		const crowned =
			leader !== undefined && leader.body === body && leader.count >= SUPER_CONFIG.CROWN_STREAK_THRESHOLD;

		if (body.GetAttribute(CROWN_ATTRIBUTE) === crowned) return;

		body.SetAttribute(CROWN_ATTRIBUTE, crowned);

		if (DEBUG && crowned) print(`[Super] ${body.Name}: crowned at ${count} hit(s)`);
	}

	/** Zeroes `player`'s streak and says why, unless it is already zero. */
	private resetStreak(player: Player, why: string): void {
		// Silent when there is nothing to clear: a death is not news about a streak of nought, and a
		// line per death for players who have not hit anybody would bury the ones that matter.
		if ((this.streaks.get(player) ?? 0) === 0) return;

		this.streaks.set(player, 0);

		// **The ticket goes with the run it described.** A body with nought hits cannot be a side's leader,
		// so nothing reads this — which is exactly why it is cleared here rather than left to be ignored: a
		// number that outlives its meaning is the kind that gets read by the next person who touches this.
		this.recentHits.delete(player);

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
	 * **Private, and it became so when the loan grew.** `BallService` used to ask this directly, twice —
	 * once for each of the two power keys — which made it the one rule this service lent out. It now asks
	 * {@link mayUsePower}, because a press that was legal in a round and nowhere else is legal in a round
	 * **or a practice zone**, and the round half on its own was the wrong question to hand to a caller that
	 * already has the player in its hand. Nothing outside this file asks this any more; the round question
	 * has one other home, and `StatsService` keeps its own four lines for the reason its note gives.
	 *
	 * **The Pierce set-up used to be a second caller, and is not any more.** Now that a Pierce ball
	 * passes through every body, there is no side to test at the throw. (`isRoundActive` was briefly made
	 * private once before, on the strength of the Pierce caller being gone, and the build found the mark
	 * handler; this note is the record of the second time, when the mark handler moved to `mayUsePower`.)
	 */
	private isRoundActive(): boolean {
		const folder = ReplicatedStorage.FindFirstChild(ROUND_STATUS_FOLDER);

		return folder?.GetAttribute(ROUND_STATE_ATTRIBUTE) === PLAYING;
	}

	/**
	 * Whether `player` is somewhere a power may be used at all: a round is being played, **or they are
	 * standing in a practice zone**.
	 *
	 * **Named for the rule it applies rather than for the question a caller has**, which is not pedantry:
	 * a power key also has to clear ownership, a ball in the hand and a charge, and a method called
	 * `mayUsePower` would read as the whole of that test while being one line of it. `BallService` says the
	 * same thing in its own words where it keeps the charge test written out at both sites — see the note
	 * beside `charged` in `markHeldBall`. What this answers is *where you are allowed to act*, which is
	 * `client/roundZone.ts`'s question on the other side of the wire.
	 *
	 * **And this is `DodgeService.requestDodge`'s rule rather than a second one.** A dodge is allowed in a
	 * round or in a practice zone, and the comment there is where the argument lives — the zone used to be
	 * a per-press world query, and it stopped being one when `PracticeZoneService` began publishing
	 * {@link PRACTICE_ZONE_ATTRIBUTE} on the player, so what is left is an attribute read. This is the
	 * second reader of that fact and it deliberates nothing: "where am I allowed to act" is one question,
	 * and `client/roundZone.ts` exists because two answers to it is the thing that rule cannot survive.
	 *
	 * **What was wrong without it, which is the bug this was written for.** A box can be collected in a
	 * practice zone — it spawns on the practice floor by design — and the prize it leaves can be held
	 * there, drawn on the HUD and kept across a death. It just could not be *spent*: every press of the
	 * power key answered "no round is being played" while the player stood in the zone the game puts boxes
	 * in, with a ball in hand and a rig to throw at. The two halves of one mechanic disagreed about where
	 * the mechanic works, which is what a player notices as "the key does nothing".
	 *
	 * **What it does not reopen.** A box still cannot be spent in the lobby. Outside a round and outside a
	 * zone there is nothing for a power to do — no target that can be hit, no rig to freeze — and that is
	 * the whole reason the round half exists. Ownership, the charge, the ball in the hand and the freeze
	 * all still gate the press; this decides only *where*.
	 */
	public inRoundOrZone(player: Player): boolean {
		if (this.isRoundActive()) return true;

		return player.GetAttribute(PRACTICE_ZONE_ATTRIBUTE) === true;
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
 * and nothing here has to know what a side *is* or when it is assigned. It also means a player with no
 * side — a joiner yet to be given one, somebody standing in the lobby between rounds — is compared among
 * the ones like them, which is a group with no hits in it in every case the crown can be earned in, and
 * the floor of `1` is what keeps it from crowning anybody.
 *
 * **A plain `string` and not a `TeamLabel`, deliberately.** This is an attribute read, so the honest
 * type is "whatever was written there", and the two-line body is the answer to "which of those is
 * real": `""` is not a side, and the comparison treats it as a group rather than as a third team.
 */
function teamOf(player: Player): string {
	const team = player.GetAttribute(TEAM_ATTRIBUTE);

	return typeIs(team, "string") ? team : "";
}

/**
 * **One side's leader, as `refreshCrowns` found it** — the body and the two facts the crown is decided from.
 *
 * **The ticket is part of the leader rather than looked up again at the write**, and that is what makes the
 * tie rule a comparison instead of a second lookup: `applyCrown` asks only whether *this body* is the leader,
 * so the newer-of-two-equal answer has already been settled by the time anybody is judged. A lookup in
 * `applyCrown` would be a second read of a map that a hit in between could have changed, which is exactly the
 * class of fault the two-pass structure exists to avoid.
 *
 * **`count` is carried as well as the body** so the threshold is tested against the leader's count once rather
 * than against each body's — the two are the same number for the leader, and reading it from here is what makes
 * that true by construction rather than by two maps agreeing.
 */
interface CrownLeader {
	readonly body: Player | Model;
	readonly count: number;

	/** The ticket of the hit that put this body here. See `SuperService.recentHits`. */
	readonly at: number;
}
