import { AbilityKind, isAbilityKind } from "./ability";
import { EQUIPPED_ELIMINATION_ATTRIBUTE, EQUIPPED_TRAIL_ATTRIBUTE } from "./constants";

/**
 * The economy's record shape and the string↔set helpers around the two attribute-backed sets.
 *
 * **Separate from the config and the service** so that both sides of the wire and the DataStore
 * agree on one shape without any of them importing the other: the client parses the attribute with
 * {@link ownedPowersOf}, the server writes it with {@link joinPowers}, and the DataStore holds the
 * same values as plain string arrays. The delimiter is private to this file, which is the one thing
 * that stops a reader splitting on a character that happens to be in a name.
 *
 * **What is equipped is the third thing here and the odd one out**: it is keyed by *slot* rather than
 * being one value, so it is published as one attribute per slot (see
 * {@link EQUIPPED_TRAIL_ATTRIBUTE}) and is the only part of the record that does not go through
 * {@link DELIMITER} on either the wire or the DataStore. {@link equippedAttributeOf} is the one table
 * that says which name belongs to which slot, so the server's publish and the client's read cannot
 * disagree about it.
 *
 * **The pool is the fourth, and it is the one that needs nothing new here.** It is a `Set<AbilityKind>`
 * exactly like `powers`, so it reuses {@link joinPowers} and {@link ownedPowersOf} rather than growing a
 * second packing convention for a second set of the same type — the only thing it adds to this file is a
 * field and the one default that cannot be "nothing".
 */
const DELIMITER = "|";

/**
 * The attribute each slot's equipped id is published on.
 *
 * **A table rather than two call sites, because the two sides must agree and neither owns the other.**
 * `EconomyService.publish` walks it to write, the Inventory panel walks it to read, and a third slot
 * — the `"ball"` slot the appearance work is heading toward — is one line here rather than a search for
 * everywhere a slot was spelled out.
 *
 * Keyed by `CosmeticSlot`'s own words, kept as plain strings because this file deliberately imports no
 * config: it is the shape both ends must agree on, not the catalogue.
 */
export const EQUIPPED_ATTRIBUTE: Record<string, string> = {
	trail: EQUIPPED_TRAIL_ATTRIBUTE,
	elimination: EQUIPPED_ELIMINATION_ATTRIBUTE,
};

/** The attribute `slot` is published on, or nothing for a slot this build does not publish. */
export function equippedAttributeOf(slot: string): string | undefined {
	return EQUIPPED_ATTRIBUTE[slot];
}

/** One player's economy, in memory. The persisted form is {@link SavedEconomy}. */
export interface EconomyRecord {
	coins: number;
	powers: Set<AbilityKind>;
	/**
	 * The subset of {@link powers} the item box may grant: a pool, not a loadout.
	 *
	 * **A second set beside ownership rather than a flag on the first, because the two answer different
	 * questions.** `powers` is "what this player has"; this is "what the box is allowed to give them". A
	 * player owns a power forever and can take it out of the pool and put it back at will, so one set cannot
	 * be the other: the moment a power is toggled off, ownership and pool membership genuinely differ.
	 *
	 * **Empty is a real state and the honest one.** Every power turned off means the box has nothing to give,
	 * which the panel says out loud — see `POWER_POOL_ATTRIBUTE`. There is no "unset" spelling: a record
	 * always has a pool, and {@link toEconomyRecord} is what guarantees it, defaulting a record that predates
	 * the field to *everything owned* rather than to nothing.
	 *
	 * **No new packing helper is needed.** This is a `Set<AbilityKind>` like `powers`, so it travels as a
	 * `|`-joined string through the same {@link joinPowers} and {@link ownedPowersOf} — a second convention
	 * for the same data would be a second thing to keep in step.
	 */
	pool: Set<AbilityKind>;
	cosmetics: Set<string>;
	/**
	 * What is worn, keyed by slot: `"trail" -> "trail.aurora"`.
	 *
	 * **An absent key is the default, and the value `""` never appears.** One spelling for one fact, so a
	 * reader asks one question — `record.equipped.get(slot)` — and gets either an id or nothing. Storing
	 * `""` for "the default" as well would give two spellings of it and leave a reader checking both,
	 * which is the trap {@link toEconomyRecord} has to guard the *stored* form against anyway.
	 */
	equipped: Map<string, string>;
	matches: number;
	wins: number;
}

/**
 * The DataStore shape: everything {@link EconomyRecord} holds, with the two sets as string arrays.
 *
 * **`equipped` is a plain table rather than an array of pairs**, so the stored value reads as what it
 * is when a person opens the store in the dashboard — `{ trail = "trail.aurora" }` — which is worth
 * more here than a shape that round-trips without changing form.
 */
export interface SavedEconomy {
	coins: number;
	powers: string[];
	pool: string[];
	cosmetics: string[];
	equipped: Record<string, string>;
	matches: number;
	wins: number;
}

/** A fresh record, which is also what a corrupt or absent saved value decodes to. */
export function blankEconomyRecord(): EconomyRecord {
	return { coins: 0, powers: new Set(), pool: new Set(), cosmetics: new Set(), equipped: new Map(), matches: 0, wins: 0 };
}

/**
 * Turns an unknown DataStore value into a record, or a blank one.
 *
 * **Shape-checked rather than trusted**, the way `StatsService.toStats` checks its record: a store
 * from an older build, or a partial write, must read as "start from nought" rather than as a crash.
 * Strings that are not known abilities are dropped, and a non-number counter reads as zero.
 *
 * **And `equipped` is the field that makes that rule load-bearing rather than theoretical, because a
 * record written before this change does not have the key at all.** Such a record reads back with an
 * empty map — "nothing equipped" — which is precisely the state that player was already in: the
 * default ball and the default trail. **The field is defaulted, never treated as corruption**, and the
 * reason it can be is structural rather than lucky: this reader starts from
 * {@link blankEconomyRecord} and overwrites only the fields it can actually read, so coins, powers,
 * cosmetics, matches and wins come back whole and the *absence* of a new field is not evidence that the
 * rest is untrustworthy.
 *
 * **What the alternative would cost is the point of saying so.** Treating a missing `equipped` as a
 * malformed record would blank a player's wallet and their entire collection, on the first join after
 * this shipped, with nothing raised and nothing logged — a loss discovered by a player and reported as
 * "my coins are gone". The record is additive now, and it has to stay readable that way.
 *
 * A key that is not a string, a value that is not a string, or an empty value is dropped rather than
 * repaired, one entry at a time: one bad entry costs one slot rather than the map. Ids are **not**
 * checked against the catalogue here, deliberately — this file imports no config, and an id this build
 * no longer knows is the client's problem to ignore, on the precedent {@link ownedCosmeticIdsOf} sets
 * for the owned set.
 *
 * **The pool is the one field that defaults to something other than nothing, and the reason is that the
 * two candidate defaults are not equally bad.** A record written before the pool existed has no `pool`
 * key; reading it as an *empty* pool would mean a box that gives nothing to a player who owns powers,
 * with nothing on screen, in the log or in the attribute to say why — a silent feature failure that a
 * player experiences as "the box is broken". Reading it as *everything they own* is what that player
 * would have chosen anyway, because the pool only exists to let them narrow the box down. So the
 * absent field is filled from the same entries that fill ownership — one loop, one filter, one order,
 * so the two sets cannot disagree about which strings were real ability names.
 *
 * **An explicitly empty pool is respected, and that is the residual risk worth naming.** `[]` on a
 * record means the player turned every power off and must stay empty; a partial write that lost the
 * contents would be indistinguishable from that decision, and it is read as the decision. The
 * alternative — treating an empty array as damage — would make "everything off" impossible to store,
 * which is a state the panel is built to show. A corrupt value that is not a table at all takes the
 * default, because there is no decision to respect in a number.
 */
export function toEconomyRecord(value: unknown): EconomyRecord {
	const record = blankEconomyRecord();
	if (typeOf(value) !== "table") return record;

	const saved = value as Partial<Record<keyof SavedEconomy, unknown>>;

	if (typeIs(saved.coins, "number")) record.coins = math.max(0, math.floor(saved.coins));
	if (typeIs(saved.matches, "number")) record.matches = math.max(0, math.floor(saved.matches));
	if (typeIs(saved.wins, "number")) record.wins = math.max(0, math.floor(saved.wins));

	// **Read before the powers are, because the two loops are one decision.** `hasPool` says whether this
	// record has ever been written by a build that knew about the pool, and the powers loop is where the
	// default is applied — see the doc comment above for why the default is "owned" rather than "empty".
	const hasPool = typeIs(saved.pool, "table");

	if (typeIs(saved.powers, "table")) {
		for (const entry of saved.powers as unknown[]) {
			if (!typeIs(entry, "string") || !isAbilityKind(entry)) continue;

			record.powers.add(entry);
			if (!hasPool) record.pool.add(entry);
		}
	}

	if (hasPool) {
		for (const entry of saved.pool as unknown[]) {
			if (typeIs(entry, "string") && isAbilityKind(entry)) record.pool.add(entry);
		}
	}

	if (typeIs(saved.cosmetics, "table")) {
		for (const entry of saved.cosmetics as unknown[]) {
			if (typeIs(entry, "string")) record.cosmetics.add(entry);
		}
	}

	if (typeIs(saved.equipped, "table")) {
		for (const [slot, id] of pairs(saved.equipped as Record<string, unknown>)) {
			if (typeIs(slot, "string") && typeIs(id, "string") && id !== "") record.equipped.set(slot, id);
		}
	}

	return record;
}

/** The persisted form of a record, for a `SetAsync` write. */
export function toSavedEconomy(record: EconomyRecord): SavedEconomy {
	const equipped: Record<string, string> = {};
	for (const [slot, id] of record.equipped) equipped[slot] = id;

	return {
		coins: record.coins,
		powers: [...record.powers],
		pool: [...record.pool],
		cosmetics: [...record.cosmetics],
		equipped,
		matches: record.matches,
		wins: record.wins,
	};
}

/** The powers named by an `OWNED_POWERS_ATTRIBUTE` value, or none. */
export function ownedPowersOf(value: unknown): Set<AbilityKind> {
	const powers = new Set<AbilityKind>();
	if (!typeIs(value, "string") || value === "") return powers;

	for (const entry of value.split(DELIMITER)) {
		if (isAbilityKind(entry)) powers.add(entry);
	}

	return powers;
}

/** The attribute string for a set of powers. */
export function joinPowers(powers: Set<AbilityKind>): string {
	return [...powers].join(DELIMITER);
}

/** Whether an `OWNED_POWERS_ATTRIBUTE` value names `kind` — the client's read of the roster. */
export function ownsPower(value: unknown, kind: AbilityKind): boolean {
	return ownedPowersOf(value).has(kind);
}

/** The cosmetic ids named by an `OWNED_COSMETICS_ATTRIBUTE` value, or none. */
export function ownedCosmeticIdsOf(value: unknown): Set<string> {
	const ids = new Set<string>();
	if (!typeIs(value, "string") || value === "") return ids;

	for (const entry of value.split(DELIMITER)) {
		if (entry !== "") ids.add(entry);
	}

	return ids;
}

/** The attribute string for a set of cosmetic ids. */
export function joinCosmeticIds(ids: Set<string>): string {
	return [...ids].join(DELIMITER);
}

/**
 * The cosmetic id an `EQUIPPED_*_ATTRIBUTE` value names, or `""` for the default.
 *
 * **The client's whole read of what is worn**, and the mirror of {@link joinCosmeticIds}: the server
 * writes a bare id or the empty string, so anything else — an absent attribute, a number, a table —
 * reads as the default rather than as a guess. Returning `""` rather than nothing is deliberate: a
 * caller wants one question answered, and "nothing is equipped" and "nothing has been published yet"
 * are the same answer to every reader there is.
 */
export function equippedIdOf(value: unknown): string {
	return typeIs(value, "string") ? value : "";
}
