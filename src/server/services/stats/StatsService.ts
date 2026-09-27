import { OnStart, Service } from "@flamework/core";
import { DataStoreService, Players, ReplicatedStorage } from "@rbxts/services";
import { STATS_CONFIG } from "shared/config/stats.config";
import {
	ROUND_STATE_ATTRIBUTE,
	ROUND_STATUS_FOLDER,
	STAT_HITS,
	STAT_MISSES,
	STAT_RATIO,
} from "shared/constants";

/** Prints each load, each write, and each counted throw. Silent about the ordinary refusals. */
const DEBUG = true;

/** The phase name that counts as competitive play. A word between two files, not a setting. */
const PLAYING = "Playing";

/**
 * How many times a DataStore call is attempted before it is given up on.
 *
 * Two, which is one retry: a call that fails twice is a DataStore that is down rather than a call
 * that arrived badly, and a third attempt only delays the answer that matters — whether this player
 * gets to play.
 */
const ATTEMPTS = 2;

/** A player's lifetime throw record. The shape of what the store holds, and of what is in memory. */
export interface PlayerStats {
	/** Throws that landed on a body. */
	hits: number;

	/** Throws that landed on anything else — a floor, a wall, a ball. */
	misses: number;
}

/**
 * Every player's lifetime throw record: how many of their throws have landed on somebody, and how
 * many have landed on everything else.
 *
 * **The store is the record; this is its cache.** A player's numbers are read once when they join
 * and written back when they leave, so a hit during a round costs a table lookup rather than a round
 * trip, and a DataStore that is briefly unreachable costs a session's worth of counting rather than
 * the game.
 *
 * **It does not know the round exists.** Which phase is running is read off the same status folder
 * the HUD and `BallSpawnerService` read, so this is a sibling of `RoundService` rather than a
 * dependent of it — and "only competitive play counts" becomes a line in here instead of an
 * injection. See {@link isRoundActive}.
 *
 * **Only players are scored, and no rig is ever asked about.** A thrower reaches this as the token
 * its ball was stamped with at release — a `UserId` as text for a player, a GUID for a rig — and a
 * GUID is not a number, so a rig's throws fall out of {@link playerOf} without this file having an
 * opinion about what a rig is.
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

	public onStart(): void {
		Players.PlayerAdded.Connect((player) => this.load(player));
		Players.PlayerRemoving.Connect((player) => this.saveAndForget(player));

		// A player already in the game when this service started never fires the added-signal, so the
		// ones already here are walked rather than waited for — the scan-and-subscribe `JoinService`
		// and `OutlineService` both do, for the same reason.
		for (const player of Players.GetPlayers()) this.load(player);

		// **The one save that is waited for.** Every other write is fired and forgotten so that a
		// player's exit is never held up by a DataStore; a server that is shutting down has nobody
		// left to hold up, and returning from this without waiting is a session's counting lost. See
		// {@link saveAll}.
		game.BindToClose(() => this.saveAll());

		task.spawn(() => this.autosaveLoop());

		if (DEBUG) print(`[Stats] up — ${STATS_CONFIG.DATASTORE_NAME}, autosave every ${STATS_CONFIG.AUTOSAVE_INTERVAL}s`);
	}

	// ---- Reading a record ----

	/** `player`'s record, or nothing while it is still being read (or after they have left). */
	public getStats(player: Player): PlayerStats | undefined {
		return this.stats.get(player);
	}

	/**
	 * Hits over throws, from `0` to `1` — or nothing when there is no record to divide.
	 *
	 * **A player who has thrown nothing reads as `0`, not as nothing.** "No throws yet" and "every
	 * throw missed" are the same answer to the question this is asked, and a caller handed `nil`
	 * would have to invent that same rule for itself.
	 */
	public getRatio(player: Player): number | undefined {
		const stats = this.stats.get(player);

		return stats === undefined ? undefined : ratioOf(stats);
	}

	/**
	 * Throws `player`'s record away and starts them from nothing.
	 *
	 * Here for a dev to call — from the command bar, or from whatever command reaches it later. It is
	 * **not** wired to the `!dev` chat parser: that parser switches boolean flags, and a reset is an
	 * action rather than a state, so folding it in would mean teaching the parser a second kind of
	 * thing to save one line here.
	 */
	public resetStats(player: Player): void {
		const stats = blankStats();

		this.stats.set(player, stats);
		this.publish(player);

		if (DEBUG) print(`[Stats] ${player.Name}: record reset`);
	}

	// ---- Recording a throw ----

	/**
	 * Counts a throw as having landed on a body.
	 *
	 * Takes the token and not the thrower, because the token is the *whole* of what an arriving ball
	 * knows about who threw it — see {@link playerOf}. Narrower than a model, and it keeps every
	 * question about who counts out of `BallComponent`.
	 */
	public recordHit(throwerToken: string): void {
		this.record(throwerToken, true);
	}

	/** Counts a throw as having landed on anything else. See {@link recordHit}. */
	public recordMiss(throwerToken: string): void {
		this.record(throwerToken, false);
	}

	private record(throwerToken: string, hit: boolean): void {
		// **Only competitive play counts.** A throw in the lobby or between rounds is practice, and a
		// record that included it would be a record of how much somebody has played rather than of how
		// well they throw. Asked here rather than by the caller, so no future caller can forget it.
		if (!this.isRoundActive()) return;

		const player = playerOf(throwerToken);
		if (player === undefined) return;

		const stats = this.stats.get(player);

		// No record yet: the load has not come back. Counted into the table that is about to be
		// replaced would be counted and then thrown away, so the honest thing is to lose the hit
		// rather than to lose the player's history with it.
		if (stats === undefined) return;

		if (hit) stats.hits++;
		else stats.misses++;

		this.publish(player);

		if (DEBUG) {
			print(`[Stats] ${player.Name}: ${hit ? "hit" : "miss"} → ${stats.hits}H/${stats.misses}M`);
		}
	}

	// ---- The round, and the channel to the client ----

	/**
	 * Whether a round is running, asked of the status folder rather than of `RoundService`.
	 *
	 * **The same channel the HUD and `BallSpawnerService` read**, which is what makes this a sibling
	 * of the round rather than a dependent of it: nothing here has to be told when a round starts or
	 * ends, and the round needs no reference to stats. A folder that does not exist yet — the first
	 * moments of a server's life — is not a round either.
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
	 * this service. All three go out together every time — including the ratio, which is derived —
	 * because a reader that had to divide them itself would be a second place the rule is stated.
	 */
	private publish(player: Player): void {
		const stats = this.stats.get(player);
		if (stats === undefined) return;

		player.SetAttribute(STAT_HITS, stats.hits);
		player.SetAttribute(STAT_MISSES, stats.misses);
		player.SetAttribute(STAT_RATIO, ratioOf(stats));
	}

	// ---- The store ----

	/**
	 * The store, fetched once and held.
	 *
	 * Held because `GetDataStore` is the one DataStore call that is not cheap. Wrapped in `pcall`
	 * like the rest, and the failure is remembered: a server with DataStores switched off — which is
	 * every Studio session until somebody enables them — throws here rather than returning nothing,
	 * and a stat system that printed a warning per throw would be its own kind of broken.
	 */
	private store(): DataStore | undefined {
		if (this.cachedStore !== undefined) return this.cachedStore;

		const [success, result] = pcall(() => DataStoreService.GetDataStore(STATS_CONFIG.DATASTORE_NAME));
		if (!success) {
			if (!this.storeReported) {
				this.storeReported = true;
				warn(`[Stats] ${STATS_CONFIG.DATASTORE_NAME} unavailable, records will not persist: ${result}`);
			}

			return undefined;
		}

		this.cachedStore = result;

		return this.cachedStore;
	}

	/**
	 * `key`'s record, or a blank one.
	 *
	 * **Two attempts, then a blank record.** A read that fails is either a store that is briefly
	 * unreachable or one that is never going to answer, and there is no third thing to try — so the
	 * player gets a fresh record rather than being kept out of the game by a statistic, and the
	 * warning says which it was.
	 */
	private fetch(key: string): PlayerStats {
		const store = this.store();
		if (store === undefined) return blankStats();

		for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
			const [success, result] = pcall(() => store.GetAsync(key));
			if (success) return toStats(result);

			warn(`[Stats] GetAsync failed for ${key} (attempt ${attempt}/${ATTEMPTS}): ${result}`);
		}

		return blankStats();
	}

	/** Writes `stats` for `key`, retrying once. Returns whether it landed. */
	private write(key: string, stats: PlayerStats | undefined): boolean {
		// Nothing to write is not a failure: it is a player who never got a record, or one whose
		// record has already been handed over.
		if (stats === undefined) return true;

		const store = this.store();
		if (store === undefined) return false;

		for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
			// A copy, and a fresh one per attempt: the live record can be added to while a write is
			// in flight, and a retry should send what is true now rather than what was true then.
			const payload = { hits: stats.hits, misses: stats.misses };
			const [success, err] = pcall(() => store.SetAsync(key, payload));
			if (success) return true;

			warn(`[Stats] SetAsync failed for ${key} (attempt ${attempt}/${ATTEMPTS}): ${err}`);
		}

		return false;
	}

	/**
	 * Reads `player`'s record and publishes it. Never blocks the join.
	 *
	 * Spawned, because `GetAsync` yields and this is called from a signal: the server does not hold
	 * somebody at the door while a DataStore answers, and nothing downstream depends on the record
	 * existing — a throw that lands before the read comes back is dropped rather than miscounted.
	 */
	private load(player: Player): void {
		task.spawn(() => {
			const stats = this.fetch(tostring(player.UserId));

			// Gone already: somebody who joined and left inside the round trip has nothing to publish
			// to, and keeping their record would be keeping an entry keyed on a player who is not
			// coming back to this server.
			if (!player.IsDescendantOf(Players)) return;

			this.stats.set(player, stats);
			this.saved.set(player, { hits: stats.hits, misses: stats.misses });
			this.publish(player);

			if (DEBUG) print(`[Stats] ${player.Name}: loaded ${stats.hits}H/${stats.misses}M`);
		});
	}

	/**
	 * Writes `player` out as they leave, and forgets them.
	 *
	 * **Fired and forgotten, so a leaver is never held up by a DataStore.** The entry goes either
	 * way: the record has been handed to the store, and a map keyed on a player who has left is a
	 * leak with nothing in it to read.
	 */
	private saveAndForget(player: Player): void {
		task.spawn(() => {
			this.write(tostring(player.UserId), this.stats.get(player));

			this.stats.delete(player);
			this.saved.delete(player);
		});
	}

	/**
	 * Writes out everybody with something new.
	 *
	 * Not the answer to a shutdown — {@link saveAll} is — but the answer to a *crash*, which
	 * `BindToClose` never runs for. Skipping a player with nothing new is what keeps this from being
	 * a periodic rewrite of the same numbers.
	 */
	private autosaveLoop(): void {
		while (true) {
			task.wait(STATS_CONFIG.AUTOSAVE_INTERVAL);

			for (const [player, stats] of this.stats) {
				const last = this.saved.get(player);
				if (last !== undefined && last.hits === stats.hits && last.misses === stats.misses) continue;

				// Spawned so one slow write does not hold up the rest of the sweep, and so this loop is
				// never the thing a DataStore stalls.
				task.spawn(() => {
					if (!this.write(tostring(player.UserId), stats)) return;

					this.saved.set(player, { hits: stats.hits, misses: stats.misses });
				});
			}
		}
	}

	/**
	 * Writes everybody out, and **waits for it**.
	 *
	 * The one save in this service that is not spawned, and the reason is the caller: `BindToClose` is
	 * the last thing a server runs and it has a deadline, so writes are made inline and the shutdown
	 * waits for them. Returning early from here would be a clean-looking shutdown that saved nobody.
	 */
	private saveAll(): void {
		for (const [player, stats] of this.stats) this.write(tostring(player.UserId), stats);

		if (DEBUG) print(`[Stats] saved ${this.stats.size()} players on shutdown`);
	}
}

/** A record with nothing in it. */
function blankStats(): PlayerStats {
	return { hits: 0, misses: 0 };
}

/** Hits over throws — `0` when there are none, which is the honest reading of "nothing yet". */
function ratioOf(stats: PlayerStats): number {
	const throws = stats.hits + stats.misses;

	return throws === 0 ? 0 : stats.hits / throws;
}

/**
 * The player a thrower token belongs to, or nothing.
 *
 * **The token is all a ball carries.** `BallService.throwBall` stamps the ball's `ThrowerId` with the
 * thrower model's `THROWER_TOKEN` and then lets go of the model entirely, so there is nothing to ask
 * for it — the token is the whole of what an arriving ball knows about who threw it, and resolving a
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
 * from nothing, which is recoverable, rather than reading as an error on every throw.
 */
function toStats(value: unknown): PlayerStats {
	if (typeIs(value, "table")) {
		const record = value as Record<string, unknown>;
		const hits = record["hits"];
		const misses = record["misses"];

		if (typeIs(hits, "number") && typeIs(misses, "number")) return { hits, misses };
	}

	return blankStats();
}
