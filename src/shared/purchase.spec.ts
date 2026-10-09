import { COSMETICS } from "./config/economy.config";
import type { CosmeticDef } from "./config/economy.config";
import { blankEconomyRecord } from "./economy";
import { validatePurchase } from "./purchase";
import type { PurchaseDecision } from "./purchase";

/**
 * A two-entry catalogue, so the branches below do not depend on the real prices or names. One entry is
 * coin-priced, one is Robux-priced with no `coinPrice` — the two halves of "not for sale".
 */
const catalogue: Record<string, CosmeticDef> = {
	"trail.ruby": {
		id: "trail.ruby",
		name: "Ruby Trail",
		slot: "trail",
		gamepassId: 0,
		priceRobux: 0,
		coinPrice: 300,
	},
	"trail.aurora": {
		id: "trail.aurora",
		name: "Aurora Trail",
		slot: "trail",
		gamepassId: 0,
		priceRobux: 99,
	},
};

/** Asserts a refusal, and reads the reason through the one branch the union allows. */
function expectRefusal(decision: PurchaseDecision, reason: string): void {
	expect(decision.ok).toBe(false);
	if (!decision.ok) expect(decision.reason).toBe(reason);
}

describe("validatePurchase", () => {
	it("refuses anything that is not a string", () => {
		expectRefusal(validatePurchase(blankEconomyRecord(), 42, catalogue), "no cosmetic by that name");
		expectRefusal(validatePurchase(blankEconomyRecord(), undefined, catalogue), "no cosmetic by that name");
	});

	it("refuses an id the catalogue does not know", () => {
		expectRefusal(validatePurchase(blankEconomyRecord(), "trail.missing", catalogue), "no cosmetic by that name");
	});

	it("refuses a cosmetic with no coin price", () => {
		const record = blankEconomyRecord();
		record.coins = 1000;

		expectRefusal(validatePurchase(record, "trail.aurora", catalogue), "that trail isn't for sale");
		expect(record.coins).toBe(1000);
	});

	it("refuses a real chest trail too, since the chest owns it and not the shelf", () => {
		const record = blankEconomyRecord();
		record.coins = 1000;

		expectRefusal(validatePurchase(record, "trail.verdant", COSMETICS), "that trail isn't for sale");
	});

	it("refuses an already-owned cosmetic and deducts nothing", () => {
		const record = blankEconomyRecord();
		record.coins = 1000;
		record.cosmetics.add("trail.ruby");

		expectRefusal(validatePurchase(record, "trail.ruby", catalogue), "you already own that trail");
		expect(record.coins).toBe(1000);
	});

	it("refuses when the wallet is short and grants nothing", () => {
		const record = blankEconomyRecord();
		record.coins = 299;

		expectRefusal(validatePurchase(record, "trail.ruby", catalogue), "not enough coins for that one");
		expect(record.coins).toBe(299);
		expect(record.cosmetics.size()).toBe(0);
	});

	it("refuses an unloaded record with its own sentence", () => {
		expectRefusal(validatePurchase(undefined, "trail.ruby", catalogue), "still loading your wallet");
	});

	it("succeeds with the catalogue's price and name", () => {
		const record = blankEconomyRecord();
		record.coins = 1000;

		const decision = validatePurchase(record, "trail.ruby", catalogue);

		expect(decision.ok).toBe(true);
		if (decision.ok) {
			expect(decision.id).toBe("trail.ruby");
			expect(decision.name).toBe("Ruby Trail");
			expect(decision.price).toBe(300);
		}
	});

	it("treats the price as the boundary: exactly it succeeds, one short and zero refuse", () => {
		const exact = blankEconomyRecord();
		exact.coins = 300;
		expect(validatePurchase(exact, "trail.ruby", catalogue).ok).toBe(true);

		const oneShort = blankEconomyRecord();
		oneShort.coins = 299;
		expectRefusal(validatePurchase(oneShort, "trail.ruby", catalogue), "not enough coins for that one");

		const broke = blankEconomyRecord();
		broke.coins = 0;
		expectRefusal(validatePurchase(broke, "trail.ruby", catalogue), "not enough coins for that one");
	});
});
