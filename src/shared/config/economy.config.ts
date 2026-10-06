import type { AbilityKind } from "shared/ability";

/**
 * The economy's numbers, in one place for the reason every other config exists: they are the part
 * that gets tuned, and tuning is one edit here rather than a hunt through a service.
 *
 * **All of these are starting guesses, not truths.** The one that matters most is
 * {@link CHEST_COST} against the earn rates below it — together they decide how many matches the
 * first Power Chest takes, and that is the first number to change after watching real players.
 */
export const ECONOMY_CONFIG = {
	/**
	 * The DataStore the whole economy lives in: coins, owned powers, owned cosmetics, and the
	 * milestone counters. One store rather than three, because one record is one round trip and one
	 * shape to keep in step — a solo developer's economy is small enough to be one table.
	 */
	DATASTORE_NAME: "Economy",

	/** How often changed records are written, in seconds. A match is longer than this, so it never races. */
	AUTOSAVE_INTERVAL: 180,

	/** How many coins one Power Chest costs. **Placeholder — 50 is the ask, sized for ~4-5 matches.** */
	CHEST_COST: 50,

	/** Coins for finishing a match, win or lose. The base the whole economy stands on. */
	MATCH_BASE_COINS: 10,

	/** Extra coins for the winning side. ~40% over base: enough to care, not enough to snowball. */
	MATCH_WIN_BONUS: 4,

	/** Coins per hit contributed in the round, counted against {@link PERFORMANCE_COIN_CAP}. */
	PERFORMANCE_COINS_PER_HIT: 1,

	/** The most coins individual performance can add in one match. The anti-runaway device. */
	PERFORMANCE_COIN_CAP: 3,

	/** The hard ceiling on one match, however well it was played. Base + win + performance never exceed it. */
	MATCH_COIN_CAP: 17,
} as const;

/**
 * The powers a Power Chest can grant, in the order the roster is drawn.
 *
 * **The vocabulary is {@link AbilityKind}'s; this is the *pool*.** The chest pulls a random unowned
 * member of this list, so the list is also the order the collection is shown in. Adding a power to the
 * game means adding it to `AbilityKind`, to `ABILITY_NAMES`, to `BALL_ABILITIES` in `shared/ability`
 * — and then here, where it becomes a thing a chest can hand out.
 *
 * **Three members is a tutorial, not a progression system**, and the design says so. The chest's
 * lifespan is exactly this list's length; it is kept as its own constant rather than derived from
 * `AbilityKind` so that "what the chest can grant" stays a deliberate choice — a power can exist in
 * the game without being in the pool.
 */
export const POWER_ROSTER: readonly AbilityKind[] = ["Pierce", "MultiBall", "Freeze"];

/**
 * The counters a milestone can be read from.
 *
 * `"crown"` is not a counter — it is the crown attribute flipping on, and its threshold is always `1`.
 */
export type MilestoneStat = "matches" | "wins" | "hits" | "crown";

/** One permanent achievement: a counter reaching a threshold grants one earnable cosmetic. */
export interface MilestoneDef {
	/** Stable id, persisted nowhere but used in logs. */
	id: string;
	/** Which counter is compared to {@link threshold}. */
	stat: MilestoneStat;
	/** The value the counter must reach. `1` for the crown. */
	threshold: number;
	/** What the player is told they earned. */
	name: string;
	/** The earnable cosmetic this grants. */
	cosmeticId: string;
}

/**
 * The launch milestone table — six achievements, deliberately few.
 *
 * **Permanent and countable**, each reading a number that already exists or a flag the game already
 * writes: matches and wins are this economy's own counters, hits are `StatsService`'s lifetime count,
 * and the crown is `CROWN_ATTRIBUTE`. Nothing here invents a new stat to track.
 *
 * **Not a ladder.** The items are a few well-spaced "I earned this" moments, not a tier list to climb.
 * The top item — the founder trail at 100 matches — should feel rare for a while, which is what keeps
 * the set meaningful rather than a checklist to burn through.
 */
export const MILESTONES: readonly MilestoneDef[] = [
	{ id: "wins.1", stat: "wins", threshold: 1, name: "First Win", cosmeticId: "trail.victor" },
	{ id: "crown.1", stat: "crown", threshold: 1, name: "Crowned", cosmeticId: "trail.crowned" },
	{ id: "hits.50", stat: "hits", threshold: 50, name: "50 Hits", cosmeticId: "elim.striker" },
	{ id: "matches.25", stat: "matches", threshold: 25, name: "Veteran", cosmeticId: "trail.veteran" },
	{ id: "wins.25", stat: "wins", threshold: 25, name: "25 Wins", cosmeticId: "trail.champion" },
	{ id: "hits.250", stat: "hits", threshold: 250, name: "250 Hits", cosmeticId: "elim.sharp" },
	{ id: "matches.100", stat: "matches", threshold: 100, name: "Founder", cosmeticId: "trail.founder" },
];

/** Where a cosmetic is seen, which is what decides what a future render hook must touch. */
export type CosmeticSlot = "trail" | "elimination";

/** One cosmetic. Earnable items are granted by a milestone; premium items carry a Game Pass. */
export interface CosmeticDef {
	/** Stable id, persisted in `OWNED_COSMETICS_ATTRIBUTE`. */
	id: string;
	name: string;
	slot: CosmeticSlot;
	/**
	 * The Game Pass id in the creator dashboard, for a premium item. `0` means "not assigned yet" —
	 * a placeholder the developer fills in Studio, never a value that works.
	 */
	gamepassId: number;
	/** The Robux price, for display only — the real price is on the Game Pass itself. */
	priceRobux: number;
	/**
	 * For a trail: the core ribbon colours, overriding `BALL_CONFIG`'s when the player equips it.
	 * Present only on trail cosmetics; the render hook (a later step) is what applies them.
	 */
	colors?: { leading: Color3; middle: Color3; trailing: Color3 };
}

/**
 * Every cosmetic, keyed by id.
 *
 * **Earnable entries live here too**, but they are never *priced* — `gamepassId` and `priceRobux`
 * are `0` on them, and the milestone table is the only thing that grants them. Keeping the two kinds
 * in one map is what lets one id space cover both, so a player's `OWNED_COSMETICS_ATTRIBUTE` says
 * "these ids" without having to say which half of the shop each came from.
 *
 * **Asset ids and Game Pass ids are placeholders.** The trail colours are real and apply today; the
 * Game Pass ids are `0` until the developer creates them in the dashboard and pastes the ids here.
 */
export const COSMETICS: Record<string, CosmeticDef> = {
	// --- Earnable (milestones only, never priced) ---
	"trail.victor": {
		id: "trail.victor",
		name: "Victor Trail",
		slot: "trail",
		gamepassId: 0,
		priceRobux: 0,
		colors: { leading: Color3.fromRGB(255, 240, 180), middle: Color3.fromRGB(255, 210, 80), trailing: Color3.fromRGB(140, 100, 20) },
	},
	"trail.crowned": {
		id: "trail.crowned",
		name: "Crown Trail",
		slot: "trail",
		gamepassId: 0,
		priceRobux: 0,
		colors: { leading: Color3.fromRGB(255, 255, 240), middle: Color3.fromRGB(255, 220, 80), trailing: Color3.fromRGB(180, 130, 20) },
	},
	"trail.veteran": {
		id: "trail.veteran",
		name: "Veteran Trail",
		slot: "trail",
		gamepassId: 0,
		priceRobux: 0,
		colors: { leading: Color3.fromRGB(210, 230, 255), middle: Color3.fromRGB(110, 170, 240), trailing: Color3.fromRGB(30, 70, 140) },
	},
	"trail.champion": {
		id: "trail.champion",
		name: "Champion Trail",
		slot: "trail",
		gamepassId: 0,
		priceRobux: 0,
		colors: { leading: Color3.fromRGB(255, 235, 200), middle: Color3.fromRGB(240, 160, 60), trailing: Color3.fromRGB(150, 70, 15) },
	},
	"trail.founder": {
		id: "trail.founder",
		name: "Founder Trail",
		slot: "trail",
		gamepassId: 0,
		priceRobux: 0,
		colors: { leading: Color3.fromRGB(240, 240, 255), middle: Color3.fromRGB(170, 150, 255), trailing: Color3.fromRGB(70, 40, 160) },
	},
	"elim.striker": {
		id: "elim.striker",
		name: "Striker Burst",
		slot: "elimination",
		gamepassId: 0,
		priceRobux: 0,
	},
	"elim.sharp": {
		id: "elim.sharp",
		name: "Sharpshooter Burst",
		slot: "elimination",
		gamepassId: 0,
		priceRobux: 0,
	},

	// --- Premium (Game Pass, priced in Robux) ---
	"trail.aurora": {
		id: "trail.aurora",
		name: "Aurora Trail",
		slot: "trail",
		gamepassId: 0,
		priceRobux: 99,
		colors: { leading: Color3.fromRGB(180, 255, 230), middle: Color3.fromRGB(90, 220, 190), trailing: Color3.fromRGB(20, 110, 110) },
	},
	"trail.ember": {
		id: "trail.ember",
		name: "Ember Trail",
		slot: "trail",
		gamepassId: 0,
		priceRobux: 149,
		colors: { leading: Color3.fromRGB(255, 240, 160), middle: Color3.fromRGB(255, 130, 40), trailing: Color3.fromRGB(120, 20, 10) },
	},
	"elim.bolt": {
		id: "elim.bolt",
		name: "Lightning KO",
		slot: "elimination",
		gamepassId: 0,
		priceRobux: 249,
	},
};

/**
 * The premium items, in catalog order — derived from {@link COSMETICS} so the two can never disagree.
 *
 * **The catalog is permanent**, never rotating. Order here is display order; add a premium item by
 * adding its def above and it appears.
 */
const premiumCatalog: CosmeticDef[] = [];
for (const [key, def] of pairs(COSMETICS)) {
	void key;
	if (def.priceRobux > 0) premiumCatalog.push(def);
}

export const PREMIUM_COSMETICS: readonly CosmeticDef[] = premiumCatalog;
