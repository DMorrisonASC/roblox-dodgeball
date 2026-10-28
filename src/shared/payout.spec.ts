import { describe, expect, it } from "@rbxts/jest-globals";
import { ECONOMY_CONFIG } from "./config/economy.config";
import { participantsOnASide, roundPayout } from "./payout";

/**
 * **The round-end payout, tested as a decision rather than as a service.**
 *
 * **Plain data throughout, because the function is generic over its subject.** `roundPayout` is written over
 * `Subject`, so the roster, the side map, the hit map and the surrendered set here are **strings** — `"a"`,
 * `"lobby"` — and no `Player` is constructed, stubbed or cast. That is the purity contract in `payout.ts` made
 * visible: nothing in the decision can be about a `Player`, because nothing in it knows what one is.
 *
 * **No mock, anywhere, and there is nothing to mock.** The function takes no store, no clock, no `Players` and no
 * service, so `jest.mock` does not appear in this file and must not be added. A test that needed one would mean the
 * decision had not been extracted.
 *
 * **It lives in `shared/` because a spec under `src/server/services` is preloaded by Flamework and breaks boot** —
 * `ServerScriptService.TS.services.economy.payout.spec failed to preload`, in Studio, which stopped every service
 * behind it. `shared/purchase.spec.ts` is the same arrangement and predates this.
 *
 * **Every amount is read from `ECONOMY_CONFIG` rather than written as a number.** A tuned payout moves these
 * expectations with it; a test with `10` in it would fail on a balance change and teach nobody anything.
 *
 * The bug these pin is the user's own sentence: *"I still earn 10 coins for being in the lobby without joining the
 * match at least once."*
 */
describe("roundPayout", () => {
	it("a player who was on a side last round but is not in the roster is not paid", () => {
		// `"lobby"` is on side A — the stale side a previous round left on them — and is the winning side here.
		// They are not in the roster because they never picked a side for *this* round.
		const payout = roundPayout<string>(
			["a"],
			"A",
			new Map<string, string>([
				["a", "A"],
				["lobby", "A"],
			]),
			new Map<string, number>([["a", 2]]),
			new Set<string>(),
		);

		expect(payout.has("lobby")).toBe(false);
		expect(payout.get("a")).toBeDefined();
	});

	it("a player in the roster is paid base coins", () => {
		const payout = roundPayout<string>(
			["a"],
			undefined,
			new Map<string, string>([["a", "A"]]),
			new Map<string, number>(),
			new Set<string>(),
		);

		expect(payout.get("a")).toBe(ECONOMY_CONFIG.MATCH_BASE_COINS);
	});

	it("the win bonus follows the roster, not the side map", () => {
		const payout = roundPayout<string>(
			["winner"],
			"A",
			new Map<string, string>([
				["winner", "A"],
				["lobby", "A"],
			]),
			new Map<string, number>(),
			new Set<string>(),
		);

		expect(payout.get("winner")).toBe(ECONOMY_CONFIG.MATCH_BASE_COINS + ECONOMY_CONFIG.MATCH_WIN_BONUS);
		expect(payout.has("lobby")).toBe(false);
	});

	it("a draw pays the base and no win bonus", () => {
		const payout = roundPayout<string>(
			["a"],
			undefined,
			new Map<string, string>([["a", "A"]]),
			new Map<string, number>(),
			new Set<string>(),
		);

		expect(payout.get("a")).toBe(ECONOMY_CONFIG.MATCH_BASE_COINS);
	});

	it("the performance term is one coin per hit, capped", () => {
		// More hits than the cap can pay for, so the cap is what the expectation reads.
		const payout = roundPayout<string>(
			["a"],
			undefined,
			new Map<string, string>([["a", "A"]]),
			new Map<string, number>([["a", ECONOMY_CONFIG.PERFORMANCE_COIN_CAP + 5]]),
			new Set<string>(),
		);

		expect(payout.get("a")).toBe(ECONOMY_CONFIG.MATCH_BASE_COINS + ECONOMY_CONFIG.PERFORMANCE_COIN_CAP);
	});

	it("a surrendered player is paid half, floored", () => {
		// Base plus the win plus one hit is an odd number, which is what makes the flooring visible.
		const payout = roundPayout<string>(
			["a"],
			"A",
			new Map<string, string>([["a", "A"]]),
			new Map<string, number>([["a", 1]]),
			new Set<string>(["a"]),
		);

		const full = ECONOMY_CONFIG.MATCH_BASE_COINS + ECONOMY_CONFIG.MATCH_WIN_BONUS + ECONOMY_CONFIG.PERFORMANCE_COINS_PER_HIT;

		expect(payout.get("a")).toBe(math.floor(full / 2));
	});

	it("never pays more than the match cap to one player", () => {
		const payout = roundPayout<string>(
			["a"],
			"A",
			new Map<string, string>([["a", "A"]]),
			new Map<string, number>([["a", ECONOMY_CONFIG.PERFORMANCE_COIN_CAP + 10]]),
			new Set<string>(),
		);

		expect(payout.get("a")).toBe(ECONOMY_CONFIG.MATCH_COIN_CAP);
	});

	it("pays nobody for an empty roster", () => {
		expect(
			roundPayout<string>([], "B", new Map<string, string>(), new Map<string, number>(), new Set<string>())
				.size(),
		).toBe(0);
	});
});

describe("participantsOnASide", () => {
	it("is the side map's keys, in insertion order", () => {
		expect(
			participantsOnASide<string>(
				new Map<string, string>([
					["first", "A"],
					["second", "B"],
				]),
			),
		).toEqual(["first", "second"]);
	});

	it("excludes a player with no side, which is the lobby case", () => {
		const roster = participantsOnASide<string>(new Map<string, string>([["a", "A"]]));

		expect(roster.size()).toBe(1);
		expect(roster[0]).toBe("a");
	});
});
