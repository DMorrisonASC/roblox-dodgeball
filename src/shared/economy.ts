import { AbilityKind, isAbilityKind } from "./ability";

/**
 * The economy's record shape and the string↔set helpers around the two attribute-backed sets.
 *
 * **Separate from the config and the service** so that both sides of the wire and the DataStore
 * agree on one shape without any of them importing the other: the client parses the attribute with
 * {@link ownedPowersOf}, the server writes it with {@link joinPowers}, and the DataStore holds the
 * same values as plain string arrays. The delimiter is private to this file, which is the one thing
 * that stops a reader splitting on a character that happens to be in a name.
 */
const DELIMITER = "|";

/** One player's economy, in memory. The persisted form is {@link SavedEconomy}. */
export interface EconomyRecord {
	coins: number;
	powers: Set<AbilityKind>;
	cosmetics: Set<string>;
	matches: number;
	wins: number;
}

/** The DataStore shape: everything {@link EconomyRecord} holds, with the two sets as string arrays. */
export interface SavedEconomy {
	coins: number;
	powers: string[];
	cosmetics: string[];
	matches: number;
	wins: number;
}

/** A fresh record, which is also what a corrupt or absent saved value decodes to. */
export function blankEconomyRecord(): EconomyRecord {
	return { coins: 0, powers: new Set(), cosmetics: new Set(), matches: 0, wins: 0 };
}

/**
 * Turns an unknown DataStore value into a record, or a blank one.
 *
 * **Shape-checked rather than trusted**, the way `StatsService.toStats` checks its record: a store
 * from an older build, or a partial write, must read as "start from nought" rather than as a crash.
 * Strings that are not known abilities are dropped, and a non-number counter reads as zero.
 */
export function toEconomyRecord(value: unknown): EconomyRecord {
	const record = blankEconomyRecord();
	if (typeOf(value) !== "table") return record;

	const saved = value as Partial<Record<keyof SavedEconomy, unknown>>;

	if (typeIs(saved.coins, "number")) record.coins = math.max(0, math.floor(saved.coins));
	if (typeIs(saved.matches, "number")) record.matches = math.max(0, math.floor(saved.matches));
	if (typeIs(saved.wins, "number")) record.wins = math.max(0, math.floor(saved.wins));

	if (typeIs(saved.powers, "table")) {
		for (const entry of saved.powers as unknown[]) {
			if (typeIs(entry, "string") && isAbilityKind(entry)) record.powers.add(entry);
		}
	}

	if (typeIs(saved.cosmetics, "table")) {
		for (const entry of saved.cosmetics as unknown[]) {
			if (typeIs(entry, "string")) record.cosmetics.add(entry);
		}
	}

	return record;
}

/** The persisted form of a record, for a `SetAsync` write. */
export function toSavedEconomy(record: EconomyRecord): SavedEconomy {
	return {
		coins: record.coins,
		powers: [...record.powers],
		cosmetics: [...record.cosmetics],
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
