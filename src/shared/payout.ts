import { ECONOMY_CONFIG } from "./config/economy.config";

/**
 * **Who a finished round pays, and how much — as a pure function of the round's facts.**
 *
 * **In `shared/` rather than beside the service that calls it, and the reason is not tidiness.** `Flamework.addPaths`
 * preloads *every* module under `src/server/services`, which is right for services and fatal for a spec: a
 * `payout.spec.ts` left there was required at boot, required `@rbxts/jest-globals`, threw, and took the whole
 * service preload with it — `ServerScriptService.TS.services.economy.payout.spec failed to preload` in Studio, and
 * every service behind it never started. The module and its spec moved together, to the one place this project
 * already keeps a tested pure decision: `shared/purchase.ts` and `shared/purchase.spec.ts` are the same shape, for
 * the same reason.
 *
 * **The purity contract.** Nothing here touches a `DataStore`, a `@Service()`, `sessionLock`, `Players` at runtime,
 * or a clock. Every input is a value the caller already holds and every output is a table built from those inputs, so
 * the decision can be *tested* — see `payout.spec.ts` — without a fixture, a mock or a place file. That is the whole
 * point: the bug this module was extracted for lived in a loop that read `Players.GetPlayers()` from inside a
 * service, which is untestable, and it paid **everybody in the server** rather than the players who played.
 *
 * **It is generic over the subject, and that is the contract made structural.** The decision is about *identities* —
 * who was on the roster, what side they were on, how many hits they landed — and not about anything a `Player`
 * instance can do. Writing it over `Subject` means the function cannot reach for a `Player` method even by accident,
 * and it means the test can hand it strings. `Player` is what the service instantiates it with; nothing in here knows
 * that.
 *
 * **The winner is a plain string or `undefined`, rather than the round's own outcome vocabulary.** A side label is
 * `"A"` or `"B"` and a draw is *nobody*, so the caller passes the winner it has and `undefined` when there was none.
 * That keeps this module free of `RoundService`'s vocabulary — which lives on the server — without losing anything:
 * the only thing this function ever does with a side is compare it to the one the player is on.
 *
 * **The roster is the participants of the round just played, and it is an argument rather than something derived
 * here.** The service passes the players who were on a side for the round (see `participantsOnASide`), and the loop
 * below visits *only* those. A body standing in the lobby — including one whose `TEAM_ATTRIBUTE` from a previous
 * round is still set, which is a fact about the last whistle rather than this one — is not on this roster, so it is
 * not paid, and it cannot be paid by any arrangement of the side map either: the map is read to decide the win
 * bonus, never to decide who is owed one.
 *
 * **The amounts, kept exactly as the service computed them before the extraction** — `MATCH_BASE_COINS`, plus
 * `MATCH_WIN_BONUS` when there is a winner and it matches, plus one coin per hit up to `PERFORMANCE_COIN_CAP`, then
 * the whole thing clamped to `MATCH_COIN_CAP`, then halved — floored — for a player who is still surrendered at the
 * end of the round. **Every number comes from `shared/config/economy.config.ts`**, which the test reads too, so a
 * tuned amount moves the test's expectation with it rather than breaking it.
 *
 * **It returns the amount as well as the membership, and that is a deliberate widening of "who is paid".** The
 * membership is `payout.keys()`; the arithmetic is decided in the same three lines that decide eligibility, so
 * splitting it would leave half the decision in the service and untestable — which is the mistake this file is
 * correcting.
 */
export function roundPayout<Subject extends defined>(
	roster: ReadonlyArray<Subject>,
	winner: string | undefined,
	sides: ReadonlyMap<Subject, string>,
	hits: ReadonlyMap<Subject, number>,
	surrendered: ReadonlySet<Subject>,
): Map<Subject, number> {
	const payout = new Map<Subject, number>();

	for (const subject of roster) {
		let coins: number = ECONOMY_CONFIG.MATCH_BASE_COINS;

		if (winner !== undefined && sides.get(subject) === winner) {
			coins += ECONOMY_CONFIG.MATCH_WIN_BONUS;
		}

		// One coin per hit, up to the cap — the reward for *contributing*, kept small and bounded so a dominant
		// player cannot convert one good round into a wallet ahead of everyone else.
		const landed = math.min(
			(hits.get(subject) ?? 0) * ECONOMY_CONFIG.PERFORMANCE_COINS_PER_HIT,
			ECONOMY_CONFIG.PERFORMANCE_COIN_CAP,
		);

		coins += landed;
		coins = math.min(coins, ECONOMY_CONFIG.MATCH_COIN_CAP);

		// **Half for a player who walked out of the round**, floored so the halving can never round *up* into a
		// reward for leaving. See `EconomyService.onRoundEnded` for the promise this penalty is half of.
		if (surrendered.has(subject)) coins = math.floor(coins / 2);

		payout.set(subject, coins);
	}

	return payout;
}

/**
 * **The round's roster: the players who were on a side for it.**
 *
 * **The side map *is* the participant list, and that is not an assumption about `TEAM_ATTRIBUTE`** — it is what
 * `RoundService` builds at the opening whistle: `assignTeams` clears the map and fills it from the players who picked
 * a side, which is the same set it then copies into `activePlayers`. What the map keeps and `activePlayers` does not
 * is the **eliminated**: `eliminate` deletes from the active set as a body goes down, so a roster read from there
 * would be missing exactly the players whose `outs` went up — and they played the round.
 *
 * **So this is one line of real meaning rather than a convenience**: the map holds side-less lobby players out (they
 * never picked one) and holds knocked-out players in (they keep their side until the next whistle), which is exactly
 * the shape a payout wants. See `payout.spec.ts` for the case that pins it.
 */
export function participantsOnASide<Subject extends defined>(sides: ReadonlyMap<Subject, string>): Subject[] {
	const roster: Subject[] = [];

	for (const [subject] of sides) roster.push(subject);

	return roster;
}
