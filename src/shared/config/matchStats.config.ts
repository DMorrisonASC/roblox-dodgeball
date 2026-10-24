/**
 * What the stats board is worth: **the weights that turn four counters into one number**, and nothing else.
 *
 * **Why a formula rather than a "score" the game already has.** The round's own score is a fact about a *side*
 * (`RoundService.scores`, read by the score bar); this is a ranking of *people*, and the two answer different
 * questions — a player on the losing side can have had the better round, and the board exists to say so. It is
 * also why this file is not next to `GAME_MODE_CONFIG`'s scoring: a mode owns what a hit is worth to a side, and
 * this owns what a hit is worth to a name in a list.
 *
 * **Placeholder, all four, and the ordering is the only part that is an argument.** A hit is the play the game
 * is about, so it leads by a distance; a catch is the harder half of the same exchange and is worth most of a
 * hit; a dodge is a defensive success that costs the enemy a throw; a throw is the attempt rather than the
 * achievement, so it is worth just enough to keep an active player above an idle one. **The gaps matter more
 * than the numbers**: if a throw ever approaches a hit in value, a player who throws constantly and lands
 * nothing outranks one who lands everything, which is the opposite of what the board is for.
 *
 * **The formula is applied on the server** — see `shared/matchStats.ts` — so the client sorts a number it was
 * given rather than deriving one. Changing a weight here moves every future board and needs no client edit.
 *
 * Imports nothing, on the rule every config in this folder keeps: a config that depended on a service would be
 * a service.
 */
export const MATCH_STATS_CONFIG = {
	/** **Placeholder — 100.** A ball of yours that landed on a body. */
	HIT: 100,

	/** **Placeholder — 75.** A ball of somebody else's that you took out of the air. */
	CATCH: 75,

	/** **Placeholder — 20.** A dash that moved you out of a throw's way. */
	DODGE: 20,

	/**
	 * **Placeholder — 10.** A ball that left your hand.
	 *
	 * **The one weight that could reasonably be nought**, and it is deliberately not. A throw is the attempt
	 * rather than the result, but a board where every player who has not yet landed anything reads `0` cannot
	 * tell the player who has been trying from the one who has not — and the second is the one being recruited
	 * in a lobby full of people.
	 */
	THROW: 10,
} as const;
