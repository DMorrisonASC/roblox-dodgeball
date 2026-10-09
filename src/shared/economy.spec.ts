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
 * 4. **The globals must be *imported* from `@rbxts/jest-globals`.** This used to read the opposite — that
 *    `jest-roblox` injects them, and that importing them is what breaks the suite. A real run proved the
 *    first half false: with no import, `describe` is `nil` by the time the spec executes, and the suite dies
 *    with `attempt to call a nil value` on the `describe(...)` line. `injectGlobals` *is* on — it appears in
 *    the CLI's runtime payload and in the generated `jest.config.luau` — and the globals still do not
 *    arrive, so the import is what supplies them. `@rbxts/jest-globals` is a real runtime package: it ships
 *    `init.lua`, resolving to the Luau `JestGlobals` that `default.project.json` mounts at
 *    `rbxts_include/node_modules/@rbxts-js/JestGlobals`. A genuine require, not a type-only import.
 *
 *    **The type shim that hid this is deleted.** The earlier version declared the globals in
 *    `src/types/jestGlobals.d.ts`, which let a spec with no import *compile* while being dead at runtime —
 *    the one arrangement where the compiler says fine and the runner says nil. Importing them is what makes
 *    the two agree, so the declaration file is gone rather than kept as a fallback that would hide it again.
 *
 * `.each` uses table syntax rather than tagged template literals, and custom matchers take `self` as the
 * first parameter. Do not assume a JS Jest idiom works until it has run.
 */
import { describe, expect, it } from "@rbxts/jest-globals";
import {
	blankEconomyRecord,
	equippedIdOf,
	joinCosmeticIds,
	joinItems,
	ownedCosmeticIdsOf,
	ownedItemsOf,
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
		expect(record.items.size()).toBe(0);
		expect(record.cosmetics.size()).toBe(0);
		expect(record.pool.size()).toBe(0);
		expect(record.equipped.size()).toBe(0);
	});

	it("clamps a negative balance to nought and floors a fraction", () => {
		expect(toEconomyRecord({ coins: -5 }).coins).toBe(0);
		expect(toEconomyRecord({ coins: 12.9 }).coins).toBe(12);
	});

	it("reads the pre-fold `powers` field into `items`", () => {
		// **The migration case, and the one that would cost a player everything.** Every record written before
		// the fold says `powers` and has no `items` key at all — the shape a DataStore wrote before `equipped`
		// and `pool` existed, with those two simply absent as well. A parser that read only `items` would hand
		// this player an empty set, silently, on a store that has never been observed to round-trip a value.
		const legacy = {
			coins: 42,
			powers: ["Pierce", "Freeze"],
			cosmetics: ["trail.victor"],
			matches: 7,
			wins: 2,
		};

		const record = toEconomyRecord(legacy);

		// Everything else survives the fold, which is the other half of the guarantee: a player's wallet and
		// collection are not evidence that the save is old.
		expect(record.coins).toBe(42);
		expect(record.matches).toBe(7);
		expect(record.wins).toBe(2);
		expect(record.cosmetics.has("trail.victor")).toBe(true);

		// The powers come back *in `items`* — the field the old record never had a name for.
		expect(record.items.has("Pierce")).toBe(true);
		expect(record.items.has("Freeze")).toBe(true);
		expect(record.items.size()).toBe(2);

		// The two fields the old build did not write: an empty equipped map, and a pool that defaults to
		// "everything owned" — the box this player would have chosen, rather than an empty box with no
		// sentence anywhere to explain it.
		expect(record.equipped.size()).toBe(0);
		expect(record.pool.has("Pierce")).toBe(true);
		expect(record.pool.has("Freeze")).toBe(true);
	});

	it("reads an `items` record as it stands", () => {
		const record = toEconomyRecord({ coins: 5, items: ["Pierce"] });

		expect(record.items.has("Pierce")).toBe(true);
		expect(record.items.size()).toBe(1);
		expect(record.pool.has("Pierce")).toBe(true);
	});

	it("merges a record carrying both names, without duplicating", () => {
		// A record that has been through both builds: `powers` from the old one and `items` from this one. The
		// union is what the player owned all along, and an entry named in both fields is one element of a set —
		// which is why the merge is a union rather than a preference for either name.
		const record = toEconomyRecord({ items: ["Pierce", "Freeze"], powers: ["Freeze", "MultiBall"] });

		expect(record.items.size()).toBe(3);
		expect(record.items.has("Pierce")).toBe(true);
		expect(record.items.has("Freeze")).toBe(true);
		expect(record.items.has("MultiBall")).toBe(true);
	});

	it("reads a record with neither name as owning nothing, keeping everything else", () => {
		const record = toEconomyRecord({ coins: 9, cosmetics: ["trail.ember"], matches: 4, wins: 1 });

		expect(record.items.size()).toBe(0);
		expect(record.coins).toBe(9);
		expect(record.cosmetics.has("trail.ember")).toBe(true);
		expect(record.matches).toBe(4);
		expect(record.wins).toBe(1);
	});

	it("drops a corrupt equipped entry rather than a whole record", () => {
		const record = toEconomyRecord({
			coins: 5,
			items: ["Pierce"],
			equipped: { trail: "trail.aurora", bad: 42, empty: "" },
		});

		expect(record.coins).toBe(5);
		expect(record.items.has("Pierce")).toBe(true);
		expect(record.equipped.get("trail")).toBe("trail.aurora");
		expect(record.equipped.size()).toBe(1);
	});

	it("round-trips through its saved form, under the new field name", () => {
		// **The pairing test: the writer emits `items` and the parser reads it back.** It cannot fail for the
		// *wrong* key — `toSavedEconomy` returns `SavedEconomy`, whose field is `items`, so a writer still
		// emitting `powers` would not compile — which is why the legacy read is proved by the tests above and
		// not by this one.
		const record = blankEconomyRecord();
		record.coins = 10;
		record.matches = 3;
		record.wins = 1;
		record.items.add("Pierce");
		record.items.add("Freeze");
		record.pool.add("Freeze");
		record.cosmetics.add("trail.aurora");
		record.equipped.set("trail", "trail.aurora");

		const back = toEconomyRecord(toSavedEconomy(record));

		expect(back.coins).toBe(10);
		expect(back.matches).toBe(3);
		expect(back.wins).toBe(1);
		expect(back.items.has("Pierce")).toBe(true);
		expect(back.items.has("Freeze")).toBe(true);
		expect(back.items.size()).toBe(2);
		expect(back.pool.has("Freeze")).toBe(true);
		expect(back.cosmetics.has("trail.aurora")).toBe(true);
		expect(back.equipped.get("trail")).toBe("trail.aurora");
	});
});

describe("blankEconomyRecord", () => {
	it("has every field, empty", () => {
		const record = blankEconomyRecord();

		expect(record.coins).toBe(0);
		expect(record.items.size()).toBe(0);
		expect(record.pool.size()).toBe(0);
		expect(record.cosmetics.size()).toBe(0);
		expect(record.equipped.size()).toBe(0);
		expect(record.matches).toBe(0);
		expect(record.wins).toBe(0);
	});
});

describe("the string helpers", () => {
	it("parses and joins powers, ignoring unknown words and empty entries", () => {
		const parsed = ownedItemsOf("Pierce|Bogus|Freeze|");

		expect(parsed.has("Pierce")).toBe(true);
		expect(parsed.has("Freeze")).toBe(true);
		expect(parsed.size()).toBe(2);

		expect(joinItems(parsed)).toBe("Pierce|Freeze");
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
