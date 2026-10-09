/**
 * ## Jest Roblox is not JS Jest — read this before touching these files.
 *
 * The test framework runs *inside Roblox*, as Luau, and four habits from JS Jest will fail here — in ways
 * that read as test bugs rather than API differences:
 *
 * 1. **`.not` is `.never`** — `not` is a reserved word in Luau, so inversion is `expect(x).never.toBe(y)`.
 * 2. **`jest.fn()` returns two values** — `const [mock, fn] = jest.fn(...)`; the mock and a forwarding
 *    function. Calling it like JS Jest gives you a `LuaTuple` where a function was expected.
 * 3. **Only `false` and `nil` are falsy.** `0`, `""`, `{}` are all *truthy* in Luau, so a test written as
 *    `if (value)` will take the wrong branch for a zero, an empty string or an empty table.
 * 4. **The globals are *injected*, and these files must not import them.** `jest-roblox` runs with
 *    `injectGlobals` on by default, so `describe`, `it`, `expect` and `jest` are already in scope — and
 *    importing them from `@rbxts/jest-globals` is what *breaks the suite* on this toolchain rather than
 *    what makes it work. The plugin drives the run with its own embedded roblox-ts runtime, and
 *    `include/RuntimeLib.lua` errors when one module instance is loaded by a second runtime: "Invalid module
 *    access! Do you have multiple TS runtimes trying to import this?". The types come from
 *    `src/types/jestGlobals.d.ts`; see that file for the whole story.
 *
 * `.each` uses table syntax rather than tagged template literals, and custom matchers take `self` as the
 * first parameter. Do not assume a JS Jest idiom works until it has run.
 */
import {
	blankEconomyRecord,
	equippedIdOf,
	joinCosmeticIds,
	joinPowers,
	ownedCosmeticIdsOf,
	ownedPowersOf,
	ownsPower,
	toEconomyRecord,
	toSavedEconomy,
} from "./economy";

describe("toEconomyRecord", () => {
	it("reads a non-table as a blank record", () => {
		const record = toEconomyRecord("garbage");

		expect(record.coins).toBe(0);
		expect(record.matches).toBe(0);
		expect(record.wins).toBe(0);
		expect(record.powers.size()).toBe(0);
		expect(record.cosmetics.size()).toBe(0);
		expect(record.pool.size()).toBe(0);
		expect(record.equipped.size()).toBe(0);
	});

	it("clamps a negative balance to nought and floors a fraction", () => {
		expect(toEconomyRecord({ coins: -5 }).coins).toBe(0);
		expect(toEconomyRecord({ coins: 12.9 }).coins).toBe(12);
	});

	it("defaults a record saved before equipped and pool existed, keeping everything else", () => {
		// The shape a DataStore wrote before `equipped` and `pool` were fields: everything else is present,
		// and the two new keys are simply absent. The whole point of the default is that this record must
		// come back with its coins, powers and cosmetics intact — a player's wallet and collection are not
		// evidence that the save is old.
		const legacy = {
			coins: 42,
			powers: ["Pierce", "Freeze"],
			cosmetics: ["trail.victor"],
			matches: 7,
			wins: 2,
		};

		const record = toEconomyRecord(legacy);

		expect(record.coins).toBe(42);
		expect(record.matches).toBe(7);
		expect(record.wins).toBe(2);
		expect(record.powers.has("Pierce")).toBe(true);
		expect(record.powers.has("Freeze")).toBe(true);
		expect(record.cosmetics.has("trail.victor")).toBe(true);

		// The two fields the old build did not write: an empty equipped map, and a pool that defaults to
		// "everything owned" — the box this player would have chosen, rather than an empty box with no
		// sentence anywhere to explain it.
		expect(record.equipped.size()).toBe(0);
		expect(record.pool.has("Pierce")).toBe(true);
		expect(record.pool.has("Freeze")).toBe(true);
	});

	it("drops a corrupt equipped entry rather than a whole record", () => {
		const record = toEconomyRecord({
			coins: 5,
			powers: ["Pierce"],
			equipped: { trail: "trail.aurora", bad: 42, empty: "" },
		});

		expect(record.coins).toBe(5);
		expect(record.equipped.get("trail")).toBe("trail.aurora");
		expect(record.equipped.size()).toBe(1);
	});

	it("round-trips through its saved form", () => {
		const record = blankEconomyRecord();
		record.coins = 10;
		record.matches = 3;
		record.wins = 1;
		record.powers.add("Pierce");
		record.powers.add("Freeze");
		record.pool.add("Freeze");
		record.cosmetics.add("trail.aurora");
		record.equipped.set("trail", "trail.aurora");

		const back = toEconomyRecord(toSavedEconomy(record));

		expect(back.coins).toBe(10);
		expect(back.matches).toBe(3);
		expect(back.wins).toBe(1);
		expect(back.powers.has("Pierce")).toBe(true);
		expect(back.powers.has("Freeze")).toBe(true);
		expect(back.pool.has("Freeze")).toBe(true);
		expect(back.cosmetics.has("trail.aurora")).toBe(true);
		expect(back.equipped.get("trail")).toBe("trail.aurora");
	});
});

describe("blankEconomyRecord", () => {
	it("has every field, empty", () => {
		const record = blankEconomyRecord();

		expect(record.coins).toBe(0);
		expect(record.powers.size()).toBe(0);
		expect(record.pool.size()).toBe(0);
		expect(record.cosmetics.size()).toBe(0);
		expect(record.equipped.size()).toBe(0);
		expect(record.matches).toBe(0);
		expect(record.wins).toBe(0);
	});
});

describe("the string helpers", () => {
	it("parses and joins powers, ignoring unknown words and empty entries", () => {
		const parsed = ownedPowersOf("Pierce|Bogus|Freeze|");

		expect(parsed.has("Pierce")).toBe(true);
		expect(parsed.has("Freeze")).toBe(true);
		expect(parsed.size()).toBe(2);

		expect(joinPowers(parsed)).toBe("Pierce|Freeze");
	});

	it("ownsPower answers from the parsed set, and nothing from junk", () => {
		expect(ownsPower("Pierce|Freeze", "Pierce")).toBe(true);
		expect(ownsPower("Pierce|Freeze", "MultiBall")).toBe(false);
		expect(ownsPower("", "Pierce")).toBe(false);
		expect(ownsPower(42, "Pierce")).toBe(false);
	});

	it("parses cosmetic ids, keeping empty segments out", () => {
		const owned = ownedCosmeticIdsOf("trail.aurora||trail.ember|");

		expect(owned.has("trail.aurora")).toBe(true);
		expect(owned.has("trail.ember")).toBe(true);
		expect(owned.size()).toBe(2);

		expect(joinCosmeticIds(owned)).toBe("trail.aurora|trail.ember");
	});

	it("equippedIdOf reads a bare id and answers the default for anything else", () => {
		expect(equippedIdOf("trail.aurora")).toBe("trail.aurora");
		expect(equippedIdOf("")).toBe("");
		expect(equippedIdOf(undefined)).toBe("");
		expect(equippedIdOf(42)).toBe("");
	});
});
