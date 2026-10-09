import { CHEST_POOL, COSMETICS, MILESTONES, PURCHASE_COSMETICS } from "./config/economy.config";

/**
 * The invariants the economy's configs must hold, asserted here rather than held by a type. These are the
 * things that a hand edit can break without any compile error: an id that does not match its key, a milestone
 * pointing at a cosmetic nobody catalogued, a chest prize that is also earnable, a purchasable trail that is
 * also in the chest, a chest prize that is not a trail. Each one is a one-line typo away, and each one would
 * ship silently.
 */
describe("the cosmetic catalogue holds together", () => {
	it("every COSMETICS key agrees with its own id", () => {
		for (const [key, def] of pairs(COSMETICS)) {
			expect(def.id).toBe(key);
		}
	});

	it("every milestone's cosmetic exists", () => {
		for (const milestone of MILESTONES) {
			expect(COSMETICS[milestone.cosmeticId]).never.toBeNil();
		}
	});

	it("no chest trail is granted by a milestone", () => {
		const granted = new Set<string>();
		for (const milestone of MILESTONES) granted.add(milestone.cosmeticId);

		for (const prize of CHEST_POOL) {
			if (prize.kind === "cosmetic") {
				expect(granted.has(prize.cosmetic)).toBe(false);
			}
		}
	});

	it("no purchasable trail is also in the chest pool", () => {
		const inPool = new Set<string>();
		for (const prize of CHEST_POOL) {
			if (prize.kind === "cosmetic") inPool.add(prize.cosmetic);
		}

		for (const def of PURCHASE_COSMETICS) {
			expect(inPool.has(def.id)).toBe(false);
		}
	});

	it("every chest prize names a real trail", () => {
		for (const prize of CHEST_POOL) {
			if (prize.kind !== "cosmetic") continue;

			const def = COSMETICS[prize.cosmetic];
			expect(def).never.toBeNil();
			expect(def.slot).toBe("trail");
		}
	});

	it("every purchasable trail has a positive coin price", () => {
		expect(PURCHASE_COSMETICS.size()).toBeGreaterThan(0);

		for (const def of PURCHASE_COSMETICS) {
			expect(def.slot).toBe("trail");
			expect(def.coinPrice).never.toBeNil();
			expect(def.coinPrice! > 0).toBe(true);
		}
	});
});
