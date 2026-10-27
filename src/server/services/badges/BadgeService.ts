import { Service } from "@flamework/core";
import { CollectionService, Players } from "@rbxts/services";
import { BADGES_ATTRIBUTE, CROWN_ATTRIBUTE, NPC_TAG } from "shared/constants";
import { Badge, badgeById, encodeBadges } from "shared/badges";
import { logInfo } from "shared/logger";
import { DRAW, RoundOutcome, TeamLabel } from "../round/team";
import type { RoundParticipant } from "../round/modes/GameMode";

/**
 * **The round's badges: derived once, at `finishRound`, and gone within fifteen seconds.**
 *
 * **What this is for.** The end of a round used to be a scoreboard — `RoundResultController`, a panel with
 * a row per player and their hits and outs. It was information dressed as a ceremony, shown to people who
 * already knew who won from the HUD, and it is deleted. What replaced it is this: every body in the round
 * gets a short strip of badges above its head, and the strip says **what kind of round it was** rather than
 * who beat whom. The ceremony stays; the ledger goes.
 *
 * **The whole lifetime is `[publish, min(+15 s, Playing)]`.** Nothing is derived during play, nothing
 * is published during play, and the attribute is cleared at the fifteen-second mark *and* at the next
 * round's opening — the first is the window, the second is the guarantee, and they are two boundaries
 * because the intermission can be longer than fifteen seconds and a server with rounds switched off may
 * never reach the second one at all. **The clock starts at the write and not at the derivation**, because
 * the boundary between the two is a transition the strip has no part in — see {@link BadgeService.publish}.
 *
 * **Nothing here is read by `EconomyService` or `StatsService`, and that is a rule rather than a
 * consequence.** A badge costs nothing, earns nothing and is recorded nowhere: the counters below live on
 * this service and are cleared at both boundaries, so the moment the window closes there is no trace of the
 * round anywhere in the game's records. See `shared/badges.ts` for the three design rules, which are the
 * system's constitution rather than its documentation.
 *
 * **Why a service rather than a module beside `npc/ballClaims.ts`.** The counters are written from six
 * services on six different events, they are read once, and the whole thing has to survive a round boundary
 * and clear itself. That is a lifecycle, and `HANDOFF.md` §0's rule is that a derivation two callers need
 * does not deserve one — this needs six writers, one reader and a timer.
 */

/**
 * How long the badges stay published, in seconds. **Placeholder — 15.**
 *
 * **Sized against the intermission rather than against the eye.** A badge is a thing to read once, and the
 * window has to be long enough that somebody gets to see it and short enough that it is gone before the next
 * round's roster is assigned. Fifteen seconds is half a thirty-second intermission.
 *
 * **The alternative is "until the phase changes", and it is what this would be without the timer.** It is
 * worse in the one case that matters: a held intermission — no lobby, or a roster that cannot start a
 * match — can last minutes, and a badge that outlived its round by a minute stops being a caption and
 * becomes a label somebody is wearing. The timer is the rule; the `Playing` edge is the backstop.
 */
const BADGE_WINDOW_SECONDS = 15;

/**
 * What one body did in the round, **as the numbers the badges are derived from — and, since the stats board,
 * as the numbers the board is drawn from too.**
 *
 * **Seven counters and no more, and each one is here because a badge names it.** `hits` and `outs` are the
 * two the old result panel showed; `hitsTaken` is the other end of a hit; the last four are the mechanics
 * that had no tally at all before this (a catch, a dodge, a throw, a pickup) and that three of the ribbons
 * are about. Nothing is stored that no badge reads — a field kept "in case" would be a number somebody
 * would eventually draw.
 *
 * **The board is the second reader, and it did not add a field.** `MatchStatsService` reads `hits`, `throws`,
 * `catches` and `dodges` through {@link BadgeService.tally} rather than counting them again: every one of those
 * four is already incremented at exactly the call site where the fact becomes true, so a second tally would be
 * a second chance to miss a call site rather than a second source of truth. **That is the reason this
 * paragraph changed rather than the reason the sentence above stopped being true** — nothing here exists for
 * the board alone; the board is drawn from what the badges already needed.
 *
 * **A player and a rig are counted the same way**, and the difference is only in where the body's key comes
 * from. A rig cannot be *eliminated* — the round has no concept of it — so `outs` is nought for a rig all
 * round; see {@link BadgeService.recordOut}.
 */
export interface RoundCounters {
	hits: number;
	outs: number;
	hitsTaken: number;
	catches: number;
	dodges: number;
	throws: number;
	pickups: number;
}

/** A body the badges are derived for, with the two facts this service cannot look up for itself. */
export interface BadgeSubject {
	/** The player, or the rig's model. */
	readonly body: RoundParticipant;

	/** What a log line calls it. Read at the boundary, so a leaver cannot take a name away. */
	readonly name: string;

	/**
	 * Which side it was on.
	 *
	 * **Required, because a body with no side was not in the round.** The per-side "most" badges are
	 * comparisons *within a side*, and a participant with no side would be compared against everybody in a
	 * bucket of one. `RoundService` supplies only side-bearing bodies — `teams` for players, `rigsOnASide()`
	 * for rigs — so this is a fact rather than a filter.
	 */
	readonly side: TeamLabel;
}

/**
 * **One body's finished set, held between the derivation and the write.**
 *
 * **The two moments had to part company, and the round-end log is what says why.** A badge is derived from
 * counters that only exist while the round is still the last thing that happened — so the derivation has to
 * be at `finishRound` — but the body it is written *to* is the one thing at that instant that is not stable:
 * the boundary immediately behind `finishRound` stands every rig down, teleports every body to the lobby, and
 * — the part that was fatal — **destroys and recopies every rig that was mid-death**, which is most of them
 * after a scoring round. `RespawnBehavior` rebuilds a rig from a template taken while it was alive, so a
 * corpse is not a place to write anything that must outlive it: the write landed, and the body it landed on
 * was replaced a second later with a copy that had never heard of it. The strip was written onto eight rigs
 * and survived on three, which is what "the badges were not shown" looked like from the lobby.
 *
 * So the set waits here for {@link BadgeService.publish}, which the round calls **after the move**.
 */
interface BadgeDelivery {
	/** The player, or the rig's model — the instance the attribute goes on. */
	readonly body: Instance;

	/** What the set was derived for. Read at the boundary; used by the line that says it went missing. */
	readonly name: string;

	/** The encoded ids, exactly as `shared/badges.ts` writes them. `""` is a real value and means "none". */
	readonly value: string;
}

/** One badge, with the sentence that explains it. The reason is the *log's*; the display draws the name. */
interface Award {
	readonly badge: Badge;
	readonly reason: string;
}

/** A key: the `Player` for a person, the `Model` for a rig. See {@link BadgeService.recordHit}. */
export type BadgeKey = Player | Model;

/** A freshly cleared set of counters. */
function emptyCounters(): RoundCounters {
	return { hits: 0, outs: 0, hitsTaken: 0, catches: 0, dodges: 0, throws: 0, pickups: 0 };
}

/**
 * The key a body's counts are filed under.
 *
 * **A player's character folds to its `Player`, and that is the whole of why this function exists.** Every
 * mechanical counter in the game arrives as a *model* — a dodge request, a caught ball, a thrown ball and a
 * pickup all name the character, because that is the thing with hands and a humanoid — while the round's
 * own hit path resolves a thrower to a `Player`. Filing those under two keys would give one person two
 * halves of one round: three hits under the player and two dodges under the body, and a badge derived from
 * either would be derived from half the truth. So the body is folded to the player the moment it arrives,
 * and a rig — which has no player — stays a model.
 */
function keyOf(body: Model): BadgeKey {
	return Players.GetPlayerFromCharacter(body) ?? body;
}

/** The key of a participant the round already resolved, which may be either kind. */
function keyOfParticipant(participant: RoundParticipant): BadgeKey {
	return participant.IsA("Player") ? participant : keyOf(participant);
}

@Service()
export class BadgeService {
	/** What each body did this round. Cleared at both boundaries — see the class doc. */
	private readonly counters = new Map<BadgeKey, RoundCounters>();

	/**
	 * Who last hit whom, **in the direction the round can never express**: victim to attacker.
	 *
	 * **The map is the reason `revenge` is derivable at all.** A hit is a one-way event — the round knows who
	 * threw and who took it, and nothing joins two hits that happen to go opposite ways. So each hit records
	 * "the victim was hit by them", and the next hit from that victim looks up whether the body it is about
	 * to hit had hit *them* first. One entry per victim, overwritten, because the badge is about the last
	 * person who hit you and not about a history.
	 */
	private readonly lastHitBy = new Map<BadgeKey, BadgeKey>();

	/** Who earned `perfectionist`, and the sentence that explains it. See {@link recordHit}. */
	private readonly perfectionistReasons = new Map<BadgeKey, string>();

	/** Who earned `revenge`, and the sentence that explains it. */
	private readonly revengeReasons = new Map<BadgeKey, string>();

	/** The round's first hit, which is `firstBlood`'s whole rule. */
	private firstBlood?: BadgeKey;

	/**
	 * Who scored the point that decided the round, if anybody did.
	 *
	 * **`clutch` is about the *winning* point and not the last one**, so this is written from the scoring gate
	 * in `RoundService.registerHit` only when the mode reports a winner on that very hit — see that call site.
	 * The first one wins: a mode cannot report a winner twice, and a second hit landing between the target and
	 * the tick that ends the round is not a second winning point.
	 */
	private winningPoint?: BadgeKey;

	/**
	 * The sets derived at the round end, **waiting for the boundary to settle before they are written.**
	 *
	 * Not a cache and not a queue to be drained later: it holds for the length of one transition and is
	 * emptied by {@link publish}, which is the very next thing that happens. See {@link BadgeDelivery} for
	 * the whole of why the write is not made where the derivation is.
	 */
	private pending: BadgeDelivery[] = [];

	/**
	 * Names the live sweep. **A token rather than `task.cancel`, and the difference is a bug that would
	 * otherwise be waiting**: a `task.delay` that has already run cannot be cancelled, so the `Playing` edge
	 * cancelling a spent timer would error on exactly the ordinary path — a `Playing` edge that arrives before
	 * the fifteen seconds are up is the *normal* case. Bumping the token makes the pending timer do nothing
	 * when it fires, which is the whole of what "cancel" needs to mean.
	 */
	private sweepToken = 0;

	/**
	 * **Someone's throw landed on somebody, inside a round** — the one event four badges are about.
	 *
	 * Called from `RoundService.registerHit`, *after* its phase gate and its victim-side test, so everything
	 * arriving here is a real cross-team hit in a round being played. It is deliberately **not** called for
	 * the damage: `registerHit` fires on the *tag*, before the ball damages anything, so every counter and
	 * every rule below is about hits landing rather than about deaths. A body in a mode that respawns can be
	 * hit four times in one round without dying once, and `perfectionist` is about exactly that body.
	 *
	 * **`hitsTaken` counts tags, and the badge's "already down three" is a tag count too** — see the note at
	 * the perfectionist check.
	 */
	public recordHit(thrower: RoundParticipant, victim: Model): void {
		const attacker = keyOfParticipant(thrower);
		const victimKey = keyOf(victim);

		const hitCounters = this.countersOf(attacker);
		hitCounters.hits += 1;

		const taken = this.countersOf(victimKey);

		// **Read before the increment, because the badge is about the state the attacker found.** "Hit a body
		// that already had three hits on it" is a fact about the world at the moment the ball left — a check
		// after the increment would award it on the *third* hit instead of the fourth, and the reason string
		// would then say "the 3rd hit on somebody already down 2", which is ordinary play rather than a joke.
		if (taken.hitsTaken >= 3 && !this.perfectionistReasons.has(attacker)) {
			this.perfectionistReasons.set(
				attacker,
				`the ${taken.hitsTaken + 1}th hit on ${victim.Name}, who was already down ${taken.hitsTaken}`,
			);
		}

		taken.hitsTaken += 1;

		// **Revenge is read the other way round from every other badge**, and that is what the map is for: this
		// looks up who last hit *the attacker* and asks whether it was the body they have just hit back. It is
		// checked before the map is written, because a body hitting itself is the one case that would otherwise
		// be a revenge (it cannot happen — nobody is hurt by their own ball — but the order costs nothing).
		if (this.lastHitBy.get(attacker) === victimKey && !this.revengeReasons.has(attacker)) {
			this.revengeReasons.set(attacker, `${victim.Name} hit them first`);
		}

		this.lastHitBy.set(victimKey, attacker);

		if (this.firstBlood === undefined) this.firstBlood = attacker;
	}

	/**
	 * **`player` was eliminated** — the only source of an out.
	 *
	 * Called from `RoundService.eliminate`, which is where the round decides a death takes somebody out of
	 * it. **It is a player-only hook, and that is the round's shape rather than this file's**: a rig is
	 * rebuilt by `RespawnBehavior` whatever the mode says, and nothing anywhere asks whether a rig was ever
	 * taken out of a round. So a rig's `outs` stays nought all round, which makes `untouchable` mean "landed
	 * a hit and was never recorded as out" for a rig — true, if vacuous, and the honest reading of a fact the
	 * round does not hold. `oneAndDone`, `sittingDuck` and `safeHands` all *require* an out and therefore
	 * cannot fire on a rig at all.
	 */
	public recordOut(player: Player): void {
		this.countersOf(player).outs += 1;
	}

	/** A caught ball. Called from `BallComponent`'s catch branch, on the branch that actually caught one. */
	public recordCatch(body: Model): void {
		this.countersOf(keyOf(body)).catches += 1;
	}

	/** A dash that started. Called from `DodgeService.requestDodge`, on the path that returned `true`. */
	public recordDodge(body: Model): void {
		this.countersOf(keyOf(body)).dodges += 1;
	}

	/** A ball that left a hand. Called from `BallService.throwBall`, only when one actually went. */
	public recordThrow(body: Model): void {
		this.countersOf(keyOf(body)).throws += 1;
	}

	/** A ball taken off the floor. Called from `BallPickupService.pickupNearest`, on success. */
	public recordPickup(body: Model): void {
		this.countersOf(keyOf(body)).pickups += 1;
	}

	/**
	 * **`thrower` scored the point that decided the round.** Called from the scoring gate in
	 * `RoundService.registerHit`, only when the mode reports a winner immediately after this point.
	 *
	 * **First one wins.** A mode reports a winner once; a second hit landing in the sub-second gap between the
	 * target being reached and the tick that ends the round is not a second winning point, and overwriting
	 * this would credit the wrong body for the round.
	 */
	public recordWinningPoint(thrower: RoundParticipant): void {
		if (this.winningPoint !== undefined) return;

		this.winningPoint = keyOfParticipant(thrower);
	}

	/**
	 * **The round is over: derive, suppress, and hold the sets for {@link publish}.**
	 *
	 * **Nothing is written to a body here**, and that is the correction this method carries. Everything down
	 * to the suppression is a fact about the round and has to be read now; where the sets go is a question
	 * about bodies, and every body in the server is about to be moved or replaced. See {@link BadgeDelivery}.
	 *
	 * Called from `RoundService.finishRound`'s tail, beside `economy.onRoundEnded` and `stats.onRoundEnded`,
	 * and **it runs for a draw as well as for a win** — the round that ended 4–4 needs its badges more than
	 * the one that ended 10–2, and `sendResult`'s early return on a draw is not a rule about ceremonies.
	 *
	 * **`subjects` is the population, and it is supplied by the round rather than derived here.** A "who was
	 * in the round" query would need `teams` and `rigsOnASide()`, both of which live in `RoundService`, and
	 * asking it from here would be a service depending on the service that calls it. So the round hands over
	 * the list it already has, with each body's side on it — one fact, one owner.
	 */
	public onRoundEnded(outcome: RoundOutcome, subjects: ReadonlyArray<BadgeSubject>): void {
		const pending: BadgeDelivery[] = [];

		for (const subject of subjects) {
			const awards = this.derive(subject, outcome, subjects);

			this.report(subject, awards);

			// **Rule 3: a set made only of ribs is no set at all.** Applied after the log, so the reason a body
			// shows nothing is *visible* — the badges were derived, each was printed, and then one line says
			// they were withheld. The alternative order would print nothing for the body and leave "did the
			// derivation run" unanswerable from a log.
			const shown = awards.every((award) => award.badge.tone === "rib") ? [] : awards;

			if (shown.size() !== awards.size() && awards.size() > 0) {
				const ribbed = new Array<string>();
				for (const award of awards) ribbed.push(award.badge.id);

				logInfo(
					`[Badge] ${subject.name}: nothing shown — ` +
						`only rib badges (${encodeBadges(ribbed)}), and a rib alone is public shame`,
				);
			}

			// **The empty string rather than removing the attribute.** Writing `""` is a change every reader is
			// told about; removing it is a change that leaves "never had one" and "had none" indistinguishable.
			// See `shared/badges.ts`.
			const ids = new Array<string>();
			for (const award of shown) ids.push(award.badge.id);

			// Held rather than written — see {@link BadgeDelivery}. Every subject is held, including the ones
			// with nothing to show: `""` is a value, and the body it clears is the one that was cleared a
			// round ago by nobody.
			pending.push({ body: subject.body, name: subject.name, value: encodeBadges(ids) });
		}

		this.pending = pending;
	}

	/**
	 * **The sets are written now, onto bodies that are standing where the round left them.**
	 *
	 * Called by `RoundService` **after the round-end transition** — after the players are teleported and after
	 * {@link RoundService.returnRigsToLobby}, which is the first moment in the boundary at which the write has
	 * somewhere to land. It is deliberately not called from {@link onRoundEnded}: the round owns its boundary
	 * and knows when the move is done; this service owns the sets and knows what to write. The alternative —
	 * a timer here — would be a second opinion about how long a transition takes, and the first time somebody
	 * changed `TRANSITION_CONFIG` the badges would go back to landing on corpses.
	 *
	 * **And it starts the one clock.** The window is fifteen seconds *of the strip being up*, so it is
	 * measured from the write rather than from the derivation; starting it at `finishRound` would spend the
	 * round-end transition on the clock and leave the lobby a shorter window than the constant says.
	 *
	 * **A body that is gone is skipped and counted.** A rig retired inside the boundary took its set with it,
	 * which is correct — the round ended with that body — and the count is how a reader tells "the write ran
	 * and found two bodies missing" from "the write never ran at all".
	 */
	public publish(): void {
		if (this.pending.size() === 0) return;

		let written = 0;
		let wearing = 0;
		let gone = 0;

		for (const delivery of this.pending) {
			if (delivery.body.Parent === undefined) {
				gone++;
				continue;
			}

			delivery.body.SetAttribute(BADGES_ATTRIBUTE, delivery.value);
			written++;

			if (delivery.value !== "") wearing++;
		}

		this.pending = [];

		logInfo(
			`[Badge] published — ${written} bod(ies), ${wearing} wearing something` +
				(gone > 0 ? `, ${gone} gone before the write` : ""),
		);

		// **One timer for the whole server, and it can only ever clear.** Tokened rather than cancelled: the
		// `Playing` edge bumps the token, so a timer that has already fired is not an error to live with and a
		// timer still pending does nothing when it arrives. Nothing in here runs on a frame, and nothing runs
		// at all between this line and one of the two boundaries.
		this.sweepToken += 1;
		const token = this.sweepToken;

		task.delay(BADGE_WINDOW_SECONDS, () => {
			if (this.sweepToken !== token) return;

			logInfo(`[Badge] window closed — ${BADGE_WINDOW_SECONDS}s`);
			this.clearAll();
		});
	}

	/**
	 * **The next round is starting: the window is over, whatever the clock says.**
	 *
	 * Called from `RoundService`'s `Playing` edge, before the roster is assigned. It bumps the sweep token —
	 * which is how the pending fifteen-second timer is retired without `task.cancel` — and clears every
	 * attribute and every counter. Idempotent, because the ordinary case is that the sweep already ran and
	 * this is clearing a set that is already empty.
	 *
	 * **The rigs are cleared by a tag walk, which this paragraph used to argue against.** The argument was
	 * that the bodies holding the attribute are exactly the ones this service wrote it to, so a list would do
	 * — and that stopped being true when a rebuild started carrying the value onto a copy. See
	 * {@link clearAll}, which is where the walk and the reasoning now live.
	 */
	public onPlayingStart(): void {
		this.sweepToken += 1;
		this.clearAll();
	}

	/**
	 * **What every body has done since the last boundary** — the round's own ledger, handed out read-only.
	 *
	 * **One reader outside this service, and it is why this is public at all.** `MatchStatsService` builds the
	 * in-match stats board from these numbers rather than counting throws, catches and dodges a second time:
	 * each of those is incremented at the one call site where the fact becomes true (`BallService.throwBall`,
	 * `BallComponent`'s catch branch, `DodgeService.requestDodge`), so a parallel tally would be a second
	 * chance to miss a call site and a second number to keep in step. See `RoundCounters` for the fields and
	 * why the board did not add one.
	 *
	 * **The live map, typed read-only, rather than a copy.** The counters are written on the frame a throw
	 * leaves a hand and read on the frame a player opens the board, so a copy would allocate a row per body per
	 * press to protect against a mutation the only reader does not make. `Readonly` on both the map and the
	 * values is the compiler's half of that promise; the convention is the other half, and it is the same
	 * arrangement `RoundService.playersInRound` avoids by building fresh — there the caller is free to sort,
	 * here the caller only reads.
	 *
	 * **Keys are `Player` for a person and `Model` for a rig** — see `BadgeKey`. **Both are counted and both are
	 * read**, which is the correction a report bought: this comment used to say the board filtered to players on
	 * the argument that "nobody is looking at a list to see how a placeholder did", and that was wrong about the
	 * game it is in — a round against rigs is mostly rigs, so the board a player actually opens was the empty one.
	 * See `MatchStatsService.board`, which walks this map's two key kinds through the same `rowFor`.
	 */
	public tally(): ReadonlyMap<BadgeKey, Readonly<RoundCounters>> {
		return this.counters;
	}

	/** The counters for `key`, made on first use. */
	private countersOf(key: BadgeKey): RoundCounters {
		let counters = this.counters.get(key);
		if (counters === undefined) {
			counters = emptyCounters();
			this.counters.set(key, counters);
		}

		return counters;
	}

	/** Everything a body earned, derived from the round's numbers and the side it was on. */
	private derive(subject: BadgeSubject, outcome: RoundOutcome, subjects: ReadonlyArray<BadgeSubject>): Award[] {
		const key = keyOfParticipant(subject.body);
		const counters = this.countersOf(key);

		/**
		 * **What "never went down" means for this body — two different facts wearing one phrase.**
		 *
		 * A **`Player`'s** is an elimination, which is `outs` and comes from `eliminate`. A **rig's** cannot
		 * be: the round has no concept of a rig being out — `RespawnBehavior` rebuilds it whatever the mode
		 * says, and nothing anywhere counts it — so `outs` is nought for every rig that ever plays, and
		 * "never out" would be true of every rig including one that was tagged five times. The fact a rig's
		 * `untouchable` is about is therefore **never being tagged**, which is `hitsTaken`: `recordHit` writes
		 * the victim's row for any side-bearing body, and a rig is a legal victim.
		 *
		 * **A rig with no counter row reads as nought, and that is the right reading rather than "unknown".**
		 * `countersOf` is what the line above calls — it *creates* the row — so this is never `nil` here; and
		 * even if it were read directly, a rig with no row is a rig that neither landed a hit nor was tagged,
		 * which is exactly a body that has never been tagged. The distinction the badge is making is "was this
		 * body hit", and a body nothing hit is the answer `true`, not a missing value.
		 *
		 * The phrase travels with the flag because the log line has to name the branch: a rig earning
		 * `untouchable` off `hitsTaken` would otherwise read as a bug in the reason string's arithmetic.
		 */
		const isRig = !subject.body.IsA("Player");
		const neverDown = isRig ? counters.hitsTaken === 0 : counters.outs === 0;
		const neverDownWord = isRig ? "never tagged" : "never out";

		// The side's own maxima, computed per subject because the side is a property of the subject. Two sides
		// are eight bodies at most — `RoundService` caps a round at the match size — so this is forty
		// comparisons for a whole round, on one turn, once.
		const side = this.sideSubjects(subjects, subject.side);

		const mostHits = this.maxOf(side, (c) => c.hits);
		const fewestHits = this.minOf(side, (c) => c.hits);
		const mostOuts = this.maxOf(side, (c) => c.outs);
		const mostCatches = this.maxOf(side, (c) => c.catches);
		const mostDodges = this.maxOf(side, (c) => c.dodges);
		const fewestThrows = this.minOf(side, (c) => c.throws);
		const mostHitsTaken = this.maxOf(side, (c) => c.hitsTaken);

		// **"Fewest" has to mean fewer than somebody**, or a side of one would earn the rib and the ribbon
		// for the same round — `sniper` and `sprayAndPray` are the same numbers read two ways, and a body that
		// is both the best and the worst player on its side is a side of one. Reported as a deviation from the
		// table: the alternative was a praise badge and its own rib on the same head, every round, on every
		// solo side.
		const hasWorst = side.size() > 1 && fewestHits < mostHits;
		const hasFewestThrows = side.size() > 1 && fewestThrows < this.maxOf(side, (c) => c.throws);

		const awards = new Array<Award>();

		// **Looked up rather than written as a badge object**, so an id in a rule and an id in the vocabulary
		// cannot drift: a rule naming a badge `shared/badges.ts` does not have would push a `nil` into the
		// list, and this way it simply awards nothing.
		const award = (id: string, reason: string): void => {
			const badge = badgeById(id);
			if (badge === undefined) return;

			awards.push({ badge, reason });
		};

		if (counters.hits >= 1 && neverDown) award("untouchable", `${counters.hits} hits, ${neverDownWord}`);
		if (counters.hits >= 1 && counters.hits >= mostHits) award("topGun", `${counters.hits} hits, the best on ${subject.side}`);
		if (counters.hits >= 3) award("hatTrick", `${counters.hits} hits`);
		if (outcome === subject.side && counters.hits === 0 && counters.outs === 0) {
			award("carried", `0 hits, 0 outs, and ${subject.side} won`);
		}

		if (outcome !== DRAW && outcome !== subject.side && counters.hits >= 2 && counters.hits >= mostHits) {
			award("almost", `${counters.hits} hits, the best on the losing side`);
		}

		if (counters.hits >= 2 && counters.hits >= mostHits && counters.outs >= mostOuts && counters.outs >= 1) {
			award("glassCannon", `${counters.hits} hits and ${counters.outs} outs, the most of each on ${subject.side}`);
		}

		// **A lower bound the table did not have, and the only badge that needed one.** "Most outs, no hits" on
		// a side where *nobody* was out is satisfied by everybody with no hits — the whole side wearing
		// `sittingDuck` for a round nobody died in, which is the badge describing an absence rather than a
		// performance. An out is part of what the label claims, so the rule asks for one. Reported rather than
		// applied quietly.
		if (counters.outs >= 1 && counters.outs >= mostOuts && counters.hits === 0) {
			award("sittingDuck", `${counters.outs} outs and 0 hits, the most outs on ${subject.side}`);
		}

		if (counters.hits === 0 && counters.outs >= 1) award("oneAndDone", `out ${counters.outs} times with 0 hits`);
		if (counters.catches >= 2 && counters.catches >= mostCatches) award("wall", `${counters.catches} catches, the most on ${subject.side}`);
		if (counters.catches >= 3 && neverDown) award("safeHands", `${counters.catches} catches, ${neverDownWord}`);
		if (counters.dodges >= 2 && counters.dodges >= mostDodges) award("neo", `${counters.dodges} dodges, the most on ${subject.side}`);

		if (counters.throws >= 5 && hasWorst && counters.hits <= fewestHits) {
			award("sprayAndPray", `${counters.throws} throws for ${counters.hits} hits, the fewest on ${subject.side}`);
		}

		if (counters.throws >= 2 && counters.hits >= mostHits && counters.hits >= 1) {
			award("sniper", `${counters.hits} hits from ${counters.throws} throws, the best on ${subject.side}`);
		}

		if (counters.pickups >= 5 && hasFewestThrows && counters.throws <= fewestThrows) {
			award("fetchDog", `${counters.pickups} pickups for ${counters.throws} throws, the fewest on ${subject.side}`);
		}

		if (counters.hitsTaken >= 2 && counters.hitsTaken >= mostHitsTaken) {
			award("punchingBag", `hit ${counters.hitsTaken} times, the most on ${subject.side}`);
		}

		// **The four global ones, and they are global because the event was.** A first hit, a winning point and a
		// crown are facts about the round rather than about a side, and the two recorded sentences were written
		// at the moment the thing happened rather than reconstructed here.
		if (this.firstBlood === key) award("firstBlood", `the round's first hit`);
		if (this.winningPoint === key) award("clutch", `the point that won it for ${subject.side}`);

		const revenge = this.revengeReasons.get(key);
		if (revenge !== undefined) award("revenge", revenge);

		if (subject.body.GetAttribute(CROWN_ATTRIBUTE) === true) award("onFire", `wore the crown when the round ended`);

		const perfectionist = this.perfectionistReasons.get(key);
		if (perfectionist !== undefined) award("perfectionist", perfectionist);

		return awards;
	}

	/** The subjects on one side — the population a "most on side" badge is a comparison within. */
	private sideSubjects(subjects: ReadonlyArray<BadgeSubject>, side: TeamLabel): BadgeSubject[] {
		const mine = new Array<BadgeSubject>();

		for (const subject of subjects) {
			if (subject.side === side) mine.push(subject);
		}

		return mine;
	}

	/**
	 * The largest `pick` on `side`, or `0` for an empty list.
	 *
	 * **The comparison is within the side and takes the counter as an accessor, because that is what a "most
	 * on side" badge is**: one number read out of seven, compared against the same number for everybody who
	 * was on the same side. Written as two functions rather than seven pairs of loops — the alternative is a
	 * `maxHits`/`minHits`/`maxOuts`/… block that says the same thing seven times.
	 */
	private maxOf(side: ReadonlyArray<BadgeSubject>, pick: (c: RoundCounters) => number): number {
		let best = 0;

		for (const subject of side) {
			const value = pick(this.countersOf(keyOfParticipant(subject.body)));
			if (value > best) best = value;
		}

		return best;
	}

	/** The smallest `pick` on `side`, or `0` for an empty list. See {@link maxOf}. */
	private minOf(side: ReadonlyArray<BadgeSubject>, pick: (c: RoundCounters) => number): number {
		let worst: number | undefined;

		for (const subject of side) {
			const value = pick(this.countersOf(keyOfParticipant(subject.body)));

			if (worst === undefined || value < worst) worst = value;
		}

		return worst ?? 0;
	}

	/** One line per badge, which is the whole of how this system is checkable from a log. */
	private report(subject: BadgeSubject, awards: ReadonlyArray<Award>): void {
		for (const award of awards) {
			logInfo(`[Badge] ${subject.name}: ${award.badge.id} — ${award.reason}`);
		}
	}

	/**
	 * Takes every published badge off the world, and forgets the round.
	 *
	 * **Players by sweep, rigs by tag — and the rig walk is a correction rather than a preference.** This used
	 * to clear a list of the bodies it had written to, which was exact so long as a written body stayed the
	 * same instance. It does not: `RespawnBehavior` replaces a dead rig with a copy, and that copy now carries
	 * the badge attribute across the rebuild (it has to — otherwise a rig killed in the last seconds of a round
	 * loses the strip a second after earning it). So the value can be sitting on an instance this service never
	 * touched, and a list of its own writes can no longer be trusted to be the list of bodies holding one.
	 * `CollectionService.GetTagged(NPC_TAG)` is the population instead: a dozen rigs, twice a round.
	 *
	 * **The players are still a sweep**, for the reason they always were: a leaver is gone and needs nothing,
	 * and a joiner has no attribute because nothing has written one.
	 */
	private clearAll(): void {
		// **A set derived and never published is dropped here too**, so a round that ended without the
		// boundary reaching `publish` cannot leave a stale set waiting to be written over the next one.
		this.pending = [];

		for (const player of Players.GetPlayers()) player.SetAttribute(BADGES_ATTRIBUTE, "");

		for (const rig of CollectionService.GetTagged(NPC_TAG)) rig.SetAttribute(BADGES_ATTRIBUTE, "");

		this.counters.clear();
		this.lastHitBy.clear();
		this.perfectionistReasons.clear();
		this.revengeReasons.clear();
		this.firstBlood = undefined;
		this.winningPoint = undefined;
	}
}
