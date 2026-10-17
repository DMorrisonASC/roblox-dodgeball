import { HttpService, Workspace } from "@rbxts/services";

/**
 * **The session lock: the two fields a saved record carries to say which server owns it, and the test that
 * says whether anybody else still does.**
 *
 * **Why this exists, in the shape the platform's own reference gives it.** Both of this project's DataStore
 * services load a player's record into memory on join and write the whole thing back later, which is
 * `create.roblox.com`'s recommended shape ("load a player's data at the start of a session and keep a
 * server-local copy for gameplay"). That shape has one precondition the docs state plainly: *"it is
 * imperative that no more than one server is able to load a player's data into memory from the DataStore at
 * the same time."* Nothing enforced it here, so the failure the docs describe was available in full:
 *
 * > "if server A saves its newer data after server B loads the out-of-date data, server B would overwrite
 * > that newer data during its next save."
 *
 * Roblox only connects a client to one server at a time, and that is not enough, because the *save* is not
 * instantaneous — the docs list four ways A can still be holding data when B loads it, and two of them are
 * ordinary here: a failed write that retries, and a throttled write sitting in the engine's request queue
 * (`error-codes-and-limits`: *"The called function continues to yield as long as its request is still
 * queued"*). A player who leaves for another server inside that window is the whole bug.
 *
 * **The lock is a field on the saved value, not on the key's metadata, and that is a deliberate departure
 * from the reference implementation.** Roblox's sample stores a `LockId` in the key's *metadata* and returns
 * it as the third value of the `UpdateAsync` transform. This project's records are read by shape-checked
 * parsers that ignore unknown fields (`shared/economy.ts`, `StatsService.toStats`), so two plain fields in
 * the value are *free*: an old record parses exactly as it did, an old record with no lock is claimable, and
 * nothing in either service has to learn a second storage mechanism. The metadata route would have needed a
 * `DataStoreKeyInfo` in every transform and a second place to keep the shape honest, and it buys the same
 * protection.
 *
 * **What this module deliberately is not:** a queue, a retrying wrapper, or a session registry. Roblox's
 * sample wraps those in a `DataStoreWrapper` because it handles every request through one object; here the
 * only shared decision is "may this write happen", and the rest of each write is the service's own business.
 * It lives outside `src/server/services/` so that Flamework's `addPaths("src/server/services")` does not
 * register it in `flamework.build` — the same reason `npc/rigPool.ts` does.
 */

/** The field holding the id of the server that owns the record. Absent means "unlocked". */
export const SESSION_FIELD = "SessionId";

/**
 * The field holding the server-time instant the owning server last wrote it, in
 * `Workspace:GetServerTimeNow()` seconds.
 *
 * **The shared clock rather than `os.clock()` or `os.time()`**, for the reason `RESPAWN_AT_ATTRIBUTE` and
 * `WALK_TO_JOIN_PAD_AT_ATTRIBUTE` use it: this number is compared across machines, and a monotonic
 * per-machine clock is not comparable across machines at all. `GetServerTimeNow()` is synchronised across
 * servers, which is the one property a lock expiry needs.
 */
export const UPDATED_FIELD = "LastUpdated";

/**
 * How long a lock survives without being refreshed, in seconds. **Placeholder — 300.**
 *
 * **It has to be longer than the autosave interval and short enough that a crashed server does not lock a
 * player out.** Both services write a record every `AUTOSAVE_INTERVAL = 180` s, and every write refreshes
 * this stamp, so 300 s survives one missed sweep plus a slow one and expires after two — which is exactly
 * the reading the platform's best-practice page asks for (*"choose a periodic save interval that ... is
 * shorter than any session-lock expiration"*).
 *
 * **Five minutes rather than the reference implementation's longer window**, because a session here is
 * short: a round is 150 s and an intermission 16 s, so a server that dies holding a lock costs a player at
 * most one session of waiting rather than half an hour. The floor is the autosave interval; below that every
 * ordinary session would expire its own lock between sweeps.
 */
export const LOCK_EXPIRY_SECONDS = 300;

let cachedSessionId: string | undefined;

/**
 * **This server's session id: its `JobId`, which is a UUID the engine guarantees is unique per server
 * instance.**
 *
 * **`JobId` rather than a fresh `HttpService.GenerateGUID`, because the id is useful when it is read back.**
 * A lock stamped `JobId` names the server holding a record, which is what a person looking at a stuck player
 * in the Data Stores Manager wants to know; a GUID names nothing. `JobId` is *documented as empty in Studio*
 * — `DataModel.JobId`: "Defaults to an empty string in Studio" — so a Studio session falls back to a GUID,
 * and the fallback is cached too so one session keeps one identity for its whole life.
 *
 * **Cached rather than read per call**: the value cannot change for the life of the server, and a lock that
 * changed identity between two writes would look like another server's and refuse its own record.
 */
export function serverSessionId(): string {
	if (cachedSessionId !== undefined) return cachedSessionId;

	const jobId = game.JobId;

	cachedSessionId = jobId !== "" ? jobId : `studio-${HttpService.GenerateGUID(false)}`;

	return cachedSessionId;
}

/** The lock a record carries, once both of its fields have been read and validated. */
export interface SessionStamp {
	/** The id of the server that wrote it. */
	readonly id: string;
	/** The `GetServerTimeNow()` instant it was written at. */
	readonly updatedAt: number;
}

/**
 * **The lock on a stored value, or nothing — the validated read of the two fields.**
 *
 * Validated rather than trusted, for `sideOfRig`'s reason: a DataStore value is whatever somebody last
 * wrote, including by hand in the dashboard or by an Open Cloud script. A record carrying `SessionId: true`
 * or a `LastUpdated` in the future is a record with no usable lock, and reading one as "held forever" would
 * strand a player for as long as the store keeps that value.
 */
export function stampOf(record: unknown): SessionStamp | undefined {
	if (!typeIs(record, "table")) return undefined;

	const stored = record as Record<string, unknown>;
	const id = stored[SESSION_FIELD];
	const updatedAt = stored[UPDATED_FIELD];

	if (!typeIs(id, "string") || id === "") return undefined;
	if (!typeIs(updatedAt, "number") || updatedAt !== updatedAt) return undefined;

	return { id: id, updatedAt: updatedAt };
}

/**
 * **Whether another server still holds this record — the single question every write asks before it is
 * allowed to happen.**
 *
 * Three answers, and only one of them blocks: a record with no lock is free; a record stamped by *this*
 * server is ours; a record stamped by another server is theirs **until `expirySeconds` have passed**, after
 * which it is treated as abandoned. The expiry is what a crashed server depends on, and the whole reason a
 * lock has to be refreshed by every write.
 *
 * **A stamp in the future counts as live.** `updatedAt` beyond `now` is a clock skew or a hand-written value;
 * `now - updatedAt` is then negative and compares as "less than the expiry", so it reads as held. That is
 * the safe direction — refusing a write loses nothing that is not still in memory, and taking a record from
 * a server whose clock is ahead would let two writers in. It also means a record stamped far in the future
 * stays locked until that time passes, which is the cost, and the reported shape of it would be a player
 * whose session never saves: worth knowing before writing a timestamp by hand.
 */
export function heldByAnother(
	record: unknown,
	sessionId: string,
	now: number,
	expirySeconds: number,
): SessionStamp | undefined {
	const stamp = stampOf(record);
	if (stamp === undefined) return undefined;
	if (stamp.id === sessionId) return undefined;

	return now - stamp.updatedAt < expirySeconds ? stamp : undefined;
}

/**
 * **A payload stamped as this server's, ready to be written.** A copy, so the caller's table — the one the
 * economy compares against the last write it made — is left alone.
 *
 * **The stamp is added here and nowhere else, which is what keeps the coalescing guard working.** Both
 * services decide "has this record changed" by comparing an encoding of the *gameplay* payload against the
 * last one they wrote; a timestamp in that comparison would make every record look changed on every sweep,
 * so the two fields must be added only at the moment of writing and must not reach the dirty test.
 */
export function stamped(payload: object, sessionId: string, now: number): object {
	const copy = { ...payload } as Record<string, unknown>;

	copy[SESSION_FIELD] = sessionId;
	copy[UPDATED_FIELD] = now;

	return copy;
}

/**
 * The instant to stamp and compare against — **`Workspace:GetServerTimeNow()`, read in one place** so that a
 * caller cannot accidentally pair a stamp from one clock with a comparison from another.
 *
 * Not a yielding call, which matters: every use of this is inside an `UpdateAsync` transform, and
 * `create.roblox.com` is explicit that *"the callback function you pass into UpdateAsync() does not have
 * permission to yield."*
 */
export function serverNow(): number {
	return Workspace.GetServerTimeNow();
}
