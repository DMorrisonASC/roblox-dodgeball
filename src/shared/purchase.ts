import type { CosmeticDef } from "./config/economy.config";
import type { EconomyRecord } from "./economy";

/**
 * The outcome of checking a purchase against a record and a catalogue.
 *
 * **A decision rather than a mutation, which is the whole point of this file.** The service that owns the
 * economy is a Flamework service with a DataStore behind it; testing it directly means mocking the store, and
 * a mocked DataStore is where test suites go to die. So everything that can be answered by reading a record and
 * a catalogue lives here, as a pure function of those two arguments, and the service is left with the two
 * things no test can own: the record lookup and the write.
 *
 * **`ok` carries the facts the caller needs to finish the job** — the id to write, the name to answer with and
 * the price to deduct — so the service does not re-derive any of them from the catalogue a second time. A
 * decision that said only "yes" would leave the caller doing the same lookup this file already did.
 */
export type PurchaseDecision =
	| { readonly ok: true; readonly id: string; readonly name: string; readonly price: number }
	| { readonly ok: false; readonly reason: string };

/**
 * Whether `record` may buy `id` from `catalogue`, and what it would cost if it may.
 *
 * **The checks run in the order a wire should be treated: structural first, state later.** A client can send
 * anything, so the cheapest and most structural facts come first — is it a string, does the catalogue know it —
 * and the facts that need the record come after. The order is also the *economy's* rather than the caller's:
 * a request refused for naming a fake id says "no cosmetic by that name" even when the record has not loaded,
 * because the id is wrong on any record.
 *
 * **Ownership and balance are read from `record`, never from an attribute**, which is the rule every check in
 * `EconomyService` follows: the attributes are copies the client renders from, and a client that could tell
 * the server what it owns could buy anything. A purchase that trusted an attribute would be a purchase a
 * client could talk out of.
 *
 * **Already owning it is a refusal and nothing is deducted.** The record is not written here at all — that is
 * the service's one mutation — so "no coins are taken" is a property of this file's shape rather than of a
 * branch: a refusal returns and nothing has been touched.
 *
 * **`record` is `undefined` for a player whose record has not loaded**, and that is a real branch rather than
 * a type convenience: `EconomyService` passes the result of a map read straight in, and "still loading" is a
 * refusal a player can act on, not an error the caller should have guarded.
 *
 * The reason strings are the purchase's own vocabulary. They must not collide with the chest's, because the
 * two replies surface on the same line and a player must be able to tell which of the two actions refused:
 * the chest says `you already had that one`, this says `you already own that trail`; the chest says `not
 * enough coins`, this says `not enough coins for that one`. See `networking.ts` on `purchaseResult`.
 */
export function validatePurchase(
	record: EconomyRecord | undefined,
	id: unknown,
	catalogue: Record<string, CosmeticDef>,
): PurchaseDecision {
	if (!typeIs(id, "string")) {
		return { ok: false, reason: "no cosmetic by that name" };
	}

	const def = catalogue[id];
	if (def === undefined) {
		return { ok: false, reason: "no cosmetic by that name" };
	}

	// A cosmetic without a coin price is not on this shelf — a milestone or chest item, or a Robux one. The
	// price being a positive number is checked here too rather than only at the catalogue, because the pure
	// function is the last word the service trusts: a def with `coinPrice: 0` is not a thing to sell.
	const price = def.coinPrice;
	if (price === undefined || price <= 0) {
		return { ok: false, reason: "that trail isn't for sale" };
	}

	if (record === undefined) {
		return { ok: false, reason: "still loading your wallet" };
	}

	if (record.cosmetics.has(id)) {
		return { ok: false, reason: "you already own that trail" };
	}

	if (record.coins < price) {
		return { ok: false, reason: "not enough coins for that one" };
	}

	return { ok: true, id, name: def.name, price };
}
