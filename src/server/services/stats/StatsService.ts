import { OnStart, Service } from "@flamework/core";
import { DataStoreService, Players, ReplicatedStorage } from "@rbxts/services";
import { STATS_CONFIG } from "shared/config/stats.config";
import {
	LOCK_EXPIRY_SECONDS,
	heldByAnother,
	serverNow,
	serverSessionId,
	stamped,
} from "../../persistence/sessionLock";
import { BIND_TO_CLOSE_SECONDS, WRITE_DEADLINE_SECONDS, runWithin } from "../../persistence/shutdown";
import {
	ROUND_STATE_ATTRIBUTE,
	ROUND_STATUS_FOLDER,
	STAT_HITS,
	STAT_OUTS,
	STAT_RATIO,
} from "shared/constants";
import { DEBUG_LOGGING, logDebug, logError, logInfo } from "shared/logger";

/** The phase name that counts as competitive play. A word between two files, not a setting. */
const PLAYING = "Playing";

/**
 * How many times a DataStore call is attempted before it is given up on.
 *
 * Two, which is one retry: a call that fails twice is a DataStore that is down rather than a call
 * that arrived badly, and a third attempt only delays the answer that matters Ã¢â‚¬â€ whether this player
 * gets to play.
 */
const ATTEMPTS = 2;

/**
 * How long to wait between those attempts, in seconds. **Placeholder Ã¢â‚¬â€ 1.**
 *
 * **There was no pause at all, and that was a real fault rather than a tidiness.** Two calls issued in the
 * same frame is the shape that turns one throttled write into two, and the platform's best-practice page
 * asks for backoff with jitter on exactly this path (*"retry transient failures with exponential backoff ...
 * cap the delay and number of attempts"*). This is the smallest honest version of that: one pause, no jitter,
 * one second Ã¢â‚¬â€ the base delay the reference sample starts from. The full version would double it per attempt
 * and add `math.random()` to the delay; with two attempts there is only one gap to place, so doubling and
 * jittering would be ceremony around a single number.
 */
const RETRY_SLEEP_SECONDS = 1;

/**
 * What a write attempt did. **Three answers rather than a boolean, because the caller reacts to each
 * differently** Ã¢â‚¬â€ `written` retires the dirty mark, `failed` leaves it for the next sweep, and `refused`
 * means this session must stop writing this record altogether. The shape is `RigDraw`'s, for its reason: a
 * decision that only said "no" would leave the caller inventing why, and the three "no"s here want three
 * different things done about them.
 */
type WriteOutcome = "written" | "failed" | "refused";

/** What reading Ã¢â‚¬â€ and locking Ã¢â‚¬â€ a record answered. See `claim`. */
type ClaimOutcome =
	| { readonly ok: true; readonly stats: PlayerStats }
	| { readonly ok: false; readonly reason: string };

/** The stored form of a record: the two figures, plus the session fields `sessionLock` stamps on a write. */
interface SavedStats {
	hits: number;
	outs: number;
}

/** A player's lifetime record. The shape of what the store holds, and of what is in memory. */
export interface PlayerStats {
	/** Throws that landed on a body. */
	hits: number;

	/** Times a round took them out of it. */
	outs: number;
}

/**
 * Every player's lifetime record: how many times they have hit somebody, and how many times they
 * have been eliminated.
 *
 * **Two figures about the two directions of one exchange**, which is what makes their ratio worth
 * reading: a throw that lands on a body is a hit, and being taken out of a round is an out. Neither
 * is a count of throws Ã¢â‚¬â€ a throw that lands on the floor is counted nowhere Ã¢â‚¬â€ so this is a record of
 * outcomes rather than of activity, and a player who throws all round and hits nobody has a record no
 * fuller than one who never threw at all.
 *
 * **The store is the record; this is its cache.** A player's numbers are read once when they join,
 * and written back at four boundaries and nowhere else: when they leave, when a round ends, on a
 * three-minute sweep, and when the server shuts down. A hit during a round costs a table lookup
 * rather than a round trip, and a DataStore that is briefly unreachable costs a session's worth of
 * counting rather than the game. Nothing on the hit path writes anything Ã¢â‚¬â€ the coalescing rule the
 * autosave was built with still holds.
 *
 * **The join-time read also takes a session lock on the record, and every write is refused while
 * another server holds it.** Two servers can hold the same player for as long as a hop takes, and
 * without the lock the older server's next write silently undoes the newer one's. See
 * {@link claim}, {@link write} and `persistence/sessionLock`; a player whose record is locked is
 * added to {@link unsaveable} rather than being kicked. The same page of the platform's guidance
 * that asks for the lock asks for the round-end checkpoint, and both are here for the same reason:
 * a record's whole value is the figure it held when the round stopped.
 *
 * **It does not know the round exists.** Which phase is running is read off the same status folder
 * the HUD and `BallSpawnerService` read, so this is a sibling of `RoundService` rather than a
 * dependent of it Ã¢â‚¬â€ and "only competitive play counts" becomes a line in here instead of an
 * injection. See {@link isRoundActive}. `RoundService` calls {@link recordOut} the other way, and
 * that direction is not the same thing: what the round hands over is a decision it has already made,
 * not a question it is asking about itself.
 *
 * **Only players are scored, and no rig is ever asked about.** A hit arrives as the token the ball
 * was stamped with at release Ã¢â‚¬â€ a `UserId` as text for a player, a GUID for a rig Ã¢â‚¬â€ and a GUID is not
 * a number, so a rig's hits fall out of {@link playerOf} without this file having an opinion about
 * what a rig is. An out arrives as a `Player`, because a rig is never in a round to be taken out of
 * one.
 */
@Service()
export class StatsService implements OnStart {
	/** Each player's record, once it has been read. Absent means "still loading, or already gone". */
	private readonly stats = new Map<Player, PlayerStats>();

	/**
	 * What was last written to the store, per player.
	 *
	 * Kept only so the autosave can skip a player with nothing new. Writing the same two numbers back
	 * every few minutes is a write that can fail for no reason, and a DataStore budget spent on
	 * saying nothing.
	 */
	private readonly saved = new Map<Player, PlayerStats>();

	/** The store, fetched once. See {@link store}. */
	private cachedStore?: DataStore;

	/** Whether the store has already been reported as missing, so the warning is printed once. */
	private storeReported = false;

	/**
	 * **The players whose record this session must never write.**
	 *
	 * Two different roads lead here and they end in the same place, which is why it is one set rather than two
	 * flags:
	 *
	 * - **The record could not be loaded.** The player then plays on a blank record Ã¢â‚¬â€ the platform recommends
	 *   that over kicking (*"we recommend letting the player play with default data and clear messaging ...
	 *   rather than removing them from the game"*) Ã¢â‚¬â€ but a blank record written back over a real one is a
	 *   wipe, and the same page warns about it by name: *"Take special care to ensure that fallback data
	 *   doesn't later overwrite 'real' data."*
	 * - **Another server holds the lock.** Roblox's own sample marks a profile `errored` for exactly this and
	 *   refuses to write it; and the reason the refusal has to be permanent for the session is subtle: the
	 *   *moment the other server releases*, a write from here would succeed Ã¢â‚¬â€ and it would carry the copy this
	 *   server loaded before the other one changed it. Refusing once is not enough; the stale copy has to stop
	 *   being written at all.
	 *
	 * An entry is removed when the player leaves, so a rejoin starts clean.
	 */
	private readonly unsaveable = new Set<Player>();

	public onStart(): void {
		Players.PlayerAdded.Connect((player) => this.load(player));
		Players.PlayerRemoving.Connect((player) => this.saveAndForget(player));

		// A player already in the game when this service started never fires the added-signal, so the
		// ones already here are walked rather than waited for Ã¢â‚¬â€ the scan-and-subscribe `JoinService`
		// and `OutlineService` both do, for the same reason.
		for (const player of Players.GetPlayers()) this.load(player);

		// **The one save that is waited for, and only for as long as the window allows.** Every other
		// write is fired and forgotten so that a player's exit is never held up by a DataStore; a
		// server that is shutting down has nobody left to hold up, and returning from this without
		// waiting is a session's counting lost. Returning late is the same loss from the other side Ã¢â‚¬â€
		// the engine gives `BindToClose` thirty seconds and kills the server after that, so `saveAll`
		// gives each write a slice of a per-service window and says what it dropped. See
		// {@link saveAll} and {@link writeWithin}.
		game.BindToClose(() => this.saveAll());

		task.spawn(() => this.autosaveLoop());

		logDebug(`[Stats] up Ã¢â‚¬â€ ${STATS_CONFIG.DATASTORE_NAME}, autosave every ${STATS_CONFIG.AUTOSAVE_INTERVAL}s`);
	}

	// ---- Reading a record ----

	/** `player`'s record, or nothing while it is still being read (or after they have left). */
	public getStats(player: Player): PlayerStats | undefined {
		return this.stats.get(player);
	}

	/**
	 * Hits over hits and outs together, from `0` to `1` Ã¢â‚¬â€ or nothing when there is no record to
	 * divide.
	 *
	 * **A player with neither figure reads as `0`, not as nothing.** "Nothing has happened yet" and
	 * "everything that has happened went against them" are the same answer to the question this is
	 * asked, and a caller handed `nil` would have to invent that same rule for itself.
	 */
	public getRatio(player: Player): number | undefined {
		const stats = this.stats.get(player);

		return stats === undefined ? undefined : ratioOf(stats);
	}

	/**
	 * Throws `player`'s record away and starts them from nothing.
	 *
	 * Here for a dev to call Ã¢â‚¬â€ from the command bar, or from whatever command reaches it later. It is
	 * **not** wired to the `!dev` chat parser: that parser switches boolean flags, and a reset is an
	 * action rather than a state, so folding it in would mean teaching the parser a second kind of
	 * thing to save one line here.
	 */
	public resetStats(player: Player): void {
		const stats = blankStats();

		this.stats.set(player, stats);
		this.publish(player);

		logDebug(`[Stats] ${player.Name}: record reset`);
	}

	// ---- Recording a figure ----

	/**
	 * Counts a throw as having landed on a body.
	 *
	 * Takes the token and not the thrower, because the token is the *whole* of what an arriving ball
	 * knows about who threw it Ã¢â‚¬â€ see {@link playerOf}. Narrower than a model, and it keeps every
	 * question about who counts out of `BallComponent`.
	 */
	public recordHit(throwerToken: string): void {
		const player = playerOf(throwerToken);
		if (player === undefined) return;

		this.count(player, "hit");
	}

	/**
	 * Counts `player` as having been eliminated.
	 *
	 * **A player and not a token, and that is the difference between the two figures.** A hit arrives
	 * from a ball that knows only who threw it; an elimination is a fact about somebody the round has
	 * just taken out, and by the time it reaches here the round has already decided it Ã¢â‚¬â€ see
	 * `RoundService.eliminate` for the guards that make that decision the round's rather than this
	 * method's.
	 */
	public recordOut(player: Player): void {
		this.count(player, "out");
	}

	/**
	 * Adds one to `what` for `player` Ã¢â‚¬â€ or does nothing, which is most of what this method is.
	 *
	 * **Both figures are counted through here so that neither can be counted without the round being
	 * checked first.** "Only competitive play counts" is the rule for both of them, and two public
	 * methods each carrying their own copy of that guard would be two places for a future caller to
	 * get it wrong.
	 */
	private count(player: Player, what: "hit" | "out"): void {
		// **Only competitive play counts.** A hit in the lobby or an elimination between rounds is
		// practice, and a record that included it would be a record of how much somebody has played
		// rather than of how they played. Asked here rather than by the caller, so no future caller can
		// forget it.
		if (!this.isRoundActive()) return;

		const stats = this.stats.get(player);

		// No record yet: the load has not come back. Counted into the table that is about to be
		// replaced would be counted and then thrown away, so the honest thing is to lose the count
		// rather than to lose the player's history with it.
		if (stats === undefined) return;

		if (what === "hit") stats.hits++;
		else stats.outs++;

		this.publish(player);

		if (DEBUG_LOGGING) {
			logInfo(`[Stats] ${player.Name}: ${what} Ã¢â€ â€™ ${stats.hits}H/${stats.outs}O`);
		}
	}

	// ---- The round, and the channel to the client ----

	/**
	 * Whether a round is running, asked of the status folder rather than of `RoundService`.
	 *
	 * **The same channel the HUD and `BallSpawnerService` read**, which is what makes this a sibling
	 * of the round rather than a dependent of it: nothing here has to be told when a round starts or
	 * ends, and the round needs no reference to stats. A folder that does not exist yet Ã¢â‚¬â€ the first
	 * moments of a server's life Ã¢â‚¬â€ is not a round either.
	 */
	private isRoundActive(): boolean {
		const folder = ReplicatedStorage.FindFirstChild(ROUND_STATUS_FOLDER);

		return folder?.GetAttribute(ROUND_STATE_ATTRIBUTE) === PLAYING;
	}

	/**
	 * Puts `player`'s record on the player, where the client can read it.
	 *
	 * Attributes rather than a remote, for the reason the round's are: they replicate on their own,
	 * so a label above somebody's head needs no request, no reply to wait for, and no reference to
	 * this service. All three go out together every time Ã¢â‚¬â€ including the ratio, which is derived Ã¢â‚¬â€
	 * because a reader that had to divide them itself would be a second place the rule is stated.
	 */
	private publish(player: Player): void {
		const stats = this.stats.get(player);
		if (stats === undefined) return;

		player.SetAttribute(STAT_HITS, stats.hits);
		player.SetAttribute(STAT_OUTS, stats.outs);
		player.SetAttribute(STAT_RATIO, ratioOf(stats));
	}

	// ---- The store ----

	/**
	 * The store, fetched once and held.
	 *
	 * Held because `GetDataStore` is the one DataStore call that is not cheap. Wrapped in `pcall`
	 * like the rest, and the failure is remembered: a server with DataStores switched off Ã¢â‚¬â€ which is
	 * every Studio session until somebody enables them Ã¢â‚¬â€ throws here rather than returning nothing,
	 * and a stat system that printed a warning per throw would be its own kind of broken.
	 */
	private store(): DataStore | undefined {
		if (this.cachedStore !== undefined) return this.cachedStore;

		const [success, result] = pcall(() => DataStoreService.GetDataStore(STATS_CONFIG.DATASTORE_NAME));
		if (!success) {
			if (!this.storeReported) {
				this.storeReported = true;
				logError(`[Stats] ${STATS_CONFIG.DATASTORE_NAME} unavailable, records will not persist: ${result}`);
			}

			return undefined;
		}

		this.cachedStore = result;

		return this.cachedStore;
	}

	/**
	 * **Reads `player`'s record and takes the session lock on it, in one `UpdateAsync`.**
	 *
	 * **The claim and the read have to be the same call.** `GetAsync` followed by a write would leave a
	 * window in which two servers both read the same record and both believe they own it Ã¢â‚¬â€ which is the bug
	 * the lock exists to close, re-opened by the read itself. The platform's reference implementation makes
	 * the same move: *"when a player's DataStore key is first read by the server, the server atomically
	 * writes a lock to the key's metadata inside the same `UpdateAsync()` call."*
	 *
	 * **The transform cannot yield**, and that is a documented constraint rather than a style note: *"The
	 * callback function you pass into UpdateAsync() does not have permission to yield. It can't contain any
	 * yielding functions like task.wait()."* Everything in it is a table read, a clock read and a compare,
	 * and the clock is `GetServerTimeNow()`, which does not wait.
	 *
	 * **A claimed record is written back stamped, with its gameplay fields untouched**, so claiming costs
	 * nothing to the player and gives this server the ownership it needs. A value that is absent or is not a
	 * table is replaced by a blank record Ã¢â‚¬â€ which is also the migration step for every record written before
	 * this change: an old record has no session fields, reads as unlocked, and is upgraded in place by the
	 * first claim, keeping its figures because the extra fields were never part of them.
	 */
	private claim(player: Player): ClaimOutcome {
		const store = this.store();
		if (store === undefined) return { ok: false, reason: "the store is not available" };

		const key = tostring(player.UserId);
		const session = serverSessionId();

		for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
			const [success, result] = pcall(() =>
				store.UpdateAsync(key, (oldValue: unknown) => {
					const now = serverNow();

					// **Held by somebody else and not expired: cancel the write by returning nothing.** That is
					// the documented way to refuse Ã¢â‚¬â€ *"If the callback returns nil, the write operation is
					// cancelled"* Ã¢â‚¬â€ and it costs no request beyond the one already spent.
					if (heldByAnother(oldValue, session, now, LOCK_EXPIRY_SECONDS) !== undefined) {
						return $tuple(undefined);
					}

					const base: object = typeIs(oldValue, "table") ? oldValue : (blankStats() as object);

					return $tuple(stamped(base, session, serverNow()));
				}),
			);

			if (!success) {
				logError(`[Stats] claim failed for ${player.Name} (${key}, attempt ${attempt}/${ATTEMPTS}): ${tostring(result)}`);

				if (attempt < ATTEMPTS) task.wait(RETRY_SLEEP_SECONDS);

				continue;
			}

			// **Nothing means the other server still holds it**: our transform returned nothing, so there was
			// no value for `UpdateAsync` to answer with. A record with no lock, or one with our own, always
			// comes back with something.
			if (result === undefined) return { ok: false, reason: "another server holds this record" };

			return { ok: true, stats: toStats(result) };
		}

		return { ok: false, reason: "the store did not answer" };
	}

	/**
	 * **Writes `player`'s record through the session lock, retrying once with a pause between attempts.**
	 *
	 * **`UpdateAsync` rather than `SetAsync`, on the platform's own rule**: *"Prefer UpdateAsync() when a write
	 * depends on the current value or when multiple servers might write the same key."* This write does both Ã¢â‚¬â€
	 * the value it is about to write carries the lock, so it has to read before it writes. The cost is that
	 * `UpdateAsync` *"consumes from both the read and write request budgets"*; at two writes per player per
	 * three minutes against a server budget of `60 + numPlayers Ãƒâ€” 40`, that is not a number worth counting.
	 *
	 * **`release` is the difference between an ordinary write and the last one.** A periodic or round-end
	 * write refreshes the stamp and keeps the lock; a leaver's write and a shutdown's write *drop* it, which
	 * is the documented unlocking step Ã¢â‚¬â€ the lock *"should always happen through an instruction to unlock the
	 * key as part of the final write in `PlayerRemoving` or `BindToClose()`."* Releasing is what makes a player
	 * who hops servers land unlocked on the next one instead of waiting out the expiry.
	 *
	 * **`refused` is not a failure and must not be retried.** The other server owns the value; trying again
	 * would be asking the same question and getting the same answer, once per sweep. See `unsaveable`.
	 */
	private write(player: Player, stats: PlayerStats, release: boolean): WriteOutcome {
		const store = this.store();
		if (store === undefined) return "failed";

		const key = tostring(player.UserId);
		const session = serverSessionId();

		for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
			// **A fresh payload per attempt**: the live record can be added to while a write is in flight, so a
			// retry sends what is true now rather than what was true when the attempt was first made Ã¢â‚¬â€ which is
			// also the reordering hazard the best-practice page names (*"an older request that retries after a
			// newer request succeeds can overwrite newer data"*): reading the live record inside the transform is
			// what makes the newer `UpdateAsync` the one that wins.
			const payload: SavedStats = { hits: stats.hits, outs: stats.outs };

			const [success, result] = pcall(() =>
				store.UpdateAsync(key, (oldValue: unknown) => {
					const now = serverNow();

					if (heldByAnother(oldValue, session, now, LOCK_EXPIRY_SECONDS) !== undefined) {
						return $tuple(undefined);
					}

					return $tuple(release ? (payload as object) : stamped(payload, session, serverNow()));
				}),
			);

			if (success) return result === undefined ? "refused" : "written";

			logError(
				`[Stats] write failed for ${player.Name} (${key}, attempt ${attempt}/${ATTEMPTS}): ` +
					`${tostring(result)}`,
			);

			if (attempt < ATTEMPTS) task.wait(RETRY_SLEEP_SECONDS);
		}

		return "failed";
	}

	/**
	 * Reads `player`'s record, locks it, and publishes it. Never blocks the join.
	 *
	 * Spawned, because the claim yields and this is called from a signal: the server does not hold somebody
	 * at the door while a DataStore answers, and nothing downstream depends on the record existing Ã¢â‚¬â€ a throw
	 * that lands before the read comes back is dropped rather than miscounted.
	 *
	 * **A failed claim leaves the player playing and this session silent.** Blank figures, published so the
	 * buildboard and anything else reading them has an answer, and the player added to {@link unsaveable} so
	 * that those blanks can never be written over whatever is really in the store. The platform recommends
	 * exactly this over kicking Ã¢â‚¬â€ the player plays, and the loss is one session rather than a record.
	 */
	private load(player: Player): void {
		task.spawn(() => {
			const claim = this.claim(player);

			// Gone already: somebody who joined and left inside the round trip has nothing to publish
			// to, and keeping their record would be keeping an entry keyed on a player who is not
			// coming back to this server.
			if (!player.IsDescendantOf(Players)) return;

			if (!claim.ok) {
				this.stats.set(player, blankStats());
				this.unsaveable.add(player);
				this.publish(player);

				logError(`[Stats] ${player.Name}: ${claim.reason} Ã¢â‚¬â€ they play on blank figures and this session will not save them`);

				return;
			}

			this.stats.set(player, claim.stats);
			this.saved.set(player, { hits: claim.stats.hits, outs: claim.stats.outs });
			this.publish(player);

			logDebug(`[Stats] ${player.Name}: loaded ${claim.stats.hits}H/${claim.stats.outs}O (locked)`);
		});
	}

	/**
	 * **Retires a record for this session, and says so once.**
	 *
	 * The single door to {@link unsaveable}, so that the two roads there Ã¢â‚¬â€ a failed load and a lock held
	 * elsewhere Ã¢â‚¬â€ are one rule in one place. The warning is the first thing anybody would want when a player
	 * reports that their stats stopped counting: it names them, says which of the two happened, and says what
	 * this server is going to do about it.
	 */
	private refuse(player: Player, what: string): void {
		if (this.unsaveable.has(player)) return;

		this.unsaveable.add(player);
		logError(`[Stats] ${player.Name}: ${what} Ã¢â‚¬â€ another server holds this record, so this session stops writing it`);
	}

	/**
	 * **Writes `player` out as they leave, releasing the lock, and forgets them.**
	 *
	 * **Fired and forgotten, so a leaver is never held up by a DataStore.** The entry goes either way: the
	 * record has been handed to the store, and a map keyed on a player who has left is a leak with nothing in
	 * it to read. **The release is the point of writing at all here** Ã¢â‚¬â€ a player who hops servers in the same
	 * second must land on a record that is not still locked by a server they have left, which is the case the
	 * lock expiry alone would make them wait out.
	 */
	private saveAndForget(player: Player): void {
		task.spawn(() => {
			const stats = this.stats.get(player);

			if (stats !== undefined) {
				if (this.unsaveable.has(player)) {
					// **Not written, and the lock is deliberately left alone**: it is not ours, and a release
					// from here would clear a lock another server is relying on.
				} else {
					if (this.write(player, stats, true) === "refused") this.refuse(player, "leaving");
				}
			}

			this.stats.delete(player);
			this.saved.delete(player);
			this.unsaveable.delete(player);
		});
	}

	/**
	 * **Writes one player if their record differs from what was last written Ã¢â‚¬â€ the only path a periodic or
	 * round-end write takes, and the only place the dirty test lives.**
	 *
	 * The comparison was inline in the autosave loop; it is a method now because there are two callers. The
	 * coalescing rule is the user's own constraint: *"I don't think player hit and death ratio should be saved
	 * instantly for each"* Ã¢â‚¬â€ nothing on a hit, a throw or a death touches the store, and every write below is
	 * either a boundary or the three-minute backstop.
	 *
	 * **`why` is for the log line, and the line is what proves a boundary write happened**: a round end that
	 * wrote nothing and one that wrote eight records leave the same trace without it.
	 */
	private flush(player: Player, why: string): void {
		const stats = this.stats.get(player);
		if (stats === undefined) return;
		if (this.unsaveable.has(player)) return;

		const last = this.saved.get(player);
		if (last !== undefined && last.hits === stats.hits && last.outs === stats.outs) return;

		const outcome = this.write(player, stats, false);

		if (outcome === "written") {
			this.saved.set(player, { hits: stats.hits, outs: stats.outs });

			logDebug(`[Stats] ${player.Name}: saved ${stats.hits}H/${stats.outs}O Ã¢â‚¬â€ ${why}`);

			return;
		}

		if (outcome === "refused") this.refuse(player, `writing at ${why}`);
	}

	/**
	 * **The round boundary: writes every player with something new, and only those.**
	 *
	 * **A round end is a save boundary and it was not one.** Every figure this service keeps moves *only*
	 * inside a round Ã¢â‚¬â€ `count` refuses anything while the phase is not `Playing` Ã¢â‚¬â€ so the round's end is the
	 * exact instant the record stops changing, and until now the only things that wrote it were the
	 * three-minute sweep and the player leaving. A crash, a shutdown or a server that emptied in between lost
	 * the round. `create.roblox.com` asks for precisely this: *"save it periodically, when the player leaves,
	 * when the server shuts down, and at critical checkpoints"*.
	 *
	 * **It takes no roster, and that is deliberate rather than lazy.** The obvious caller passes
	 * `RoundService.playersInRound()`, and that list is **wrong** for this job: it is `activePlayers`, which
	 * `eliminate` deletes from *during* the round Ã¢â‚¬â€ so the round-end roster is missing precisely the players
	 * whose `outs` went up, which is the figure the save exists to keep. Every player this service holds a
	 * record for is the honest subject instead, and the dirty test in {@link flush} is what makes that cheap:
	 * a lobby spectator, a player who joined after the round ended and anybody already written are all one
	 * comparison each.
	 *
	 * **Spawned rather than awaited, because the caller is the round's own loop.** `RoundService.finishRound`
	 * is inside `gameLoop`, and holding it for eight sequential writes would delay the intermission that
	 * follows Ã¢â‚¬â€ for a save that has a shutdown path ({@link saveAll}) already waiting behind it.
	 */
	public onRoundEnded(): void {
		task.spawn(() => {
			for (const [player] of this.stats) this.flush(player, "the round end");
		});
	}

	/**
	 * Writes out everybody with something new.
	 *
	 * Not the answer to a shutdown Ã¢â‚¬â€ {@link saveAll} is Ã¢â‚¬â€ but the answer to a *crash*, which `BindToClose`
	 * never runs for. Skipping a player with nothing new is what keeps this from being a periodic rewrite of
	 * the same numbers. **And it is also the lock's heartbeat**: an expiry of `LOCK_EXPIRY_SECONDS` outlasting
	 * this interval by one sweep is what makes a live server's lock survive and a dead one's lapse.
	 */
	private autosaveLoop(): void {
		while (true) {
			task.wait(STATS_CONFIG.AUTOSAVE_INTERVAL);

			for (const [player] of this.stats) {
				// Spawned so one slow write does not hold up the rest of the sweep, and so this loop is
				// never the thing a DataStore stalls.
				task.spawn(() => this.flush(player, "the autosave"));
			}
		}
	}

	/**
	 * Writes everybody out, releases their locks, and **waits for it Ã¢â‚¬â€ inside a deadline.**
	 *
	 * **The bound is a per-write deadline taken from the window that is left, and that is one mechanism
	 * rather than two.** A budget check (`GetRequestBudgetForRequestType`) would answer a different question
	 * Ã¢â‚¬â€ *may* I write? Ã¢â‚¬â€ and the failure this is built for is a write that is *allowed* and never answers,
	 * because a throttled request sits in the engine's queue and *"the called function continues to yield as
	 * long as its request is still queued"*. So every write gets a slice, no write gets more than the window
	 * has left, and the loop stops when the window is gone.
	 *
	 * **When the deadline fires the remaining players are skipped, loudly.** That is the decision the shape
	 * turns on: a shutdown that runs out of time is a data-loss event either way, and the only choice left is
	 * whether it is one *with a log*. The count is printed so the loss is a number rather than an absence.
	 *
	 * **Every record is written, not only the changed ones, because this write also releases the lock.** A
	 * clean shutdown should leave every record unlocked for the next server; skipping an unchanged record
	 * would leave it locked until the expiry for no gain at all.
	 */
	private saveAll(): void {
		const endsAt = os.clock() + BIND_TO_CLOSE_SECONDS;

		let written = 0;
		let skipped = 0;

		for (const [player, stats] of this.stats) {
			if (this.unsaveable.has(player)) {
				skipped++;
				continue;
			}

			const left = endsAt - os.clock();
			if (left <= 0) {
				skipped++;
				continue;
			}

			if (this.writeWithin(player, stats, math.min(left, WRITE_DEADLINE_SECONDS))) written++;
			else skipped++;
		}

		if (DEBUG_LOGGING) {
			logInfo(`[Stats] shutdown Ã¢â‚¬â€ ${written} record(s) written, ${skipped} skipped, of ${this.stats.size()}`);
		}

		if (skipped > 0) {
			logError(`[Stats] shutdown ran out of its ${BIND_TO_CLOSE_SECONDS}s window Ã¢â‚¬â€ ${skipped} record(s) not saved`);
		}
	}

	/**
	 * One shutdown write, waited for at most `seconds`.
	 *
	 * A thin wrapper over `runWithin` Ã¢â‚¬â€ that function owns the thread-and-poll, because the economy's
	 * shutdown needs the same one Ã¢â‚¬â€ and what is left here is the part only this service can say: which
	 * player timed out, and that a refusal is the other server's lock rather than a fault.
	 */
	private writeWithin(player: Player, stats: PlayerStats, seconds: number): boolean {
		const outcome = runWithin(seconds, () => this.write(player, stats, true));

		if (!outcome.ok) {
			logError(
				`[Stats] ${player.Name}: the shutdown write did not answer within ` +
					`${string.format("%.1f", seconds)}s Ã¢â‚¬â€ moved on`,
			);

			return false;
		}

		if (outcome.value === "refused") this.refuse(player, "the shutdown write");

		return outcome.value === "written";
	}
}

/** A record with nothing in it. */
function blankStats(): PlayerStats {
	return { hits: 0, outs: 0 };
}

/** Hits over hits and outs Ã¢â‚¬â€ `0` when there are neither, the honest reading of "nothing yet". */
function ratioOf(stats: PlayerStats): number {
	const counted = stats.hits + stats.outs;

	return counted === 0 ? 0 : stats.hits / counted;
}

/**
 * The player a thrower token belongs to, or nothing.
 *
 * **The token is all a ball carries.** `BallService.throwBall` stamps the ball's `ThrowerId` with the
 * thrower model's `THROWER_TOKEN` and then lets go of the model entirely, so there is nothing to ask
 * for it Ã¢â‚¬â€ the token is the whole of what an arriving ball knows about who threw it, and resolving a
 * *model* from it would mean scanning every rig in the world for a matching token on every landing.
 *
 * A player's token is their `UserId` as text and a rig's is a GUID, so `tonumber` is the entire rule
 * for "was this a person": a GUID does not read as a number, and a token that does not is a throw
 * nobody is keeping score of. That is what makes NPCs fall out rather than be special-cased.
 */
function playerOf(throwerToken: string): Player | undefined {
	const userId = tonumber(throwerToken);
	if (userId === undefined) return undefined;

	return Players.GetPlayerByUserId(userId);
}

/**
 * `value` as a record, or a blank one.
 *
 * A store hands back whatever was written plus whatever somebody else wrote by hand, so the shape is
 * checked rather than trusted: a record that has been corrupted into something else starts somebody
 * from nothing, which is recoverable, rather than reading as an error on every count.
 *
 * **This is also what retires the old record.** A store written before `misses` became `outs` holds
 * `{hits, misses}` and fails the check below, so every player's figures start from nothing on the new
 * shape Ã¢â‚¬â€ rather than a `hits` count surviving next to an `outs` count that was never kept, which
 * would read as a record of somebody who has never been eliminated.
 */
function toStats(value: unknown): PlayerStats {
	if (typeIs(value, "table")) {
		const record = value as Record<string, unknown>;
		const hits = record["hits"];
		const outs = record["outs"];

		if (typeIs(hits, "number") && typeIs(outs, "number")) return { hits, outs };
	}

	return blankStats();
}
