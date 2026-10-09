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
 * One thing the Power Chest can roll.
 *
 * **A tagged entry rather than a bare `AbilityKind`, because the pool holds two kinds of thing.** Powers
 * arrived first and were the only arm for a while — this comment predicted the second one before it existed,
 * which is why adding cosmetics needed no second list, no second odds rule and no second grant path: one
 * member below, one entry in {@link CHEST_POOL}, and one arm in `EconomyService.openChest`.
 *
 * **`cosmetic` is a catalogue id rather than a `CosmeticDef`, and not a `CosmeticSlot` either.** The pool
 * names one *thing* — `"trail.verdant"` — while {@link COSMETICS} is the file that says what that thing is.
 * Storing the def here would put a second copy of the same object in one module and make the pool the place a
 * colour is written; storing the slot would describe a *class* of prizes rather than an item, and the chest
 * cannot grant a slot — a slot is somewhere a cosmetic is worn.
 *
 * **The arm is generic and the pool is where the deliberate part lives.** Nothing in this type stops a ball or
 * elimination cosmetic being named; {@link CHEST_TRAILS} is the line that decides which ids the chest owns,
 * and the argument for the three that are there is written beside it.
 */
export type ChestPrize =
	| { readonly kind: "power"; readonly power: AbilityKind }
	| { readonly kind: "cosmetic"; readonly cosmetic: string };

/**
 * The trail cosmetics the chest is the only source of: **named one at a time rather than filtered out.**
 *
 * **The rule these three satisfy is "no other route to it"** — no milestone grants one, and none is for sale —
 * because the chest is one kind of source among several and a route that already exists makes the chest a
 * second path to the same item. `MILESTONES` above is the first half of that check and `priceRobux` is the
 * second: `trail.aurora` and `trail.ember` have no milestone either, and they are excluded by having a price
 * rather than by being earned.
 *
 * **A filter could produce this list and was refused, which is the decision worth recording.** A derived pool
 * — trail slot, unpriced, not in `MILESTONES` — would be one fewer place to forget. It would also make
 * *unintended* items chest prizes: the day a trail is added for a giveaway, or an unpriced cosmetic arrives for
 * any other reason, it would silently join the pool with nothing anywhere saying so. And it would put
 * membership in a rule nobody reads, where this file's own convention is that membership is deliberate — that
 * is what `POWER_ROSTER` is doing on the line below, and what its own comment says about adding a power "and
 * then here".
 *
 * **The entries are derived from this list, so the id is spelled once** and the tagged form is not a second
 * thing to keep in step. Membership is the deliberate part; the shape is mechanical.
 *
 * **Each id must be absent from `MILESTONES`, and that is a check rather than something the compiler can
 * hold.** One search per entry when one is added, and it is the whole cost of a list that cannot lie about
 * itself.
 */
const CHEST_TRAILS: readonly string[] = ["trail.verdant", "trail.rose", "trail.silver"];

/**
 * Everything the chest can roll: **one flat list, and the whole of the pool.**
 *
 * **One list rather than `{ powers, items }` in parallel, and that is the shape the odds depend on.** With a
 * single list, adding an entry re-derives every probability in the pool with no rule to write; two lists
 * would need a rule for how they are interleaved, and that rule would be the real probability model hiding
 * inside `EconomyService` where nobody would look for it.
 *
 * **The pool is not filtered to what a player does not own, and that is the mechanic rather than an
 * oversight.** The chest rolls over all of it; if it lands on something the player already has, they get
 * nothing, and *that* is the only way to get nothing. There is no miss-rate number anywhere in this file —
 * the chance of a miss is derived, and it is exactly the fraction of this list the player already owns. See
 * `EconomyService.openChest`.
 *
 * **Cosmetics joined it as a second kind of prize, and the two paragraphs above are what made that one entry
 * rather than a mechanic change.** The roll is still one uniform draw over this array's length, so a player
 * who owns the whole roster rolls on three of six, and a miss is still the fraction they already own. Nothing
 * in `openChest` needed a second odds rule; the only thing that grew is the grant.
 */
export const CHEST_POOL: readonly ChestPrize[] = [
	...POWER_ROSTER.map((power): ChestPrize => ({ kind: "power", power })),
	...CHEST_TRAILS.map((cosmetic): ChestPrize => ({ kind: "cosmetic", cosmetic })),
];

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
export type CosmeticSlot = "trail" | "elimination" | "ball";

/** One cosmetic. A milestone grants the earnable ones, the chest grants its own, coins buy the simple tier, and premium items carry a Game Pass. */
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
	 * The coin price, for the one shelf the chest does not own. `undefined` on every other kind of cosmetic:
	 * a milestone item and a chest item are earned, and a premium item is bought with Robux. A cosmetic with
	 * this field is the coin catalogue, and `PURCHASE_COSMETICS` below is the derived list of them.
	 */
	coinPrice?: number;
	/**
	 * Every colour this trail is drawn in: the core's three, and the pair the haze around them takes.
	 * Present only on trail cosmetics, because a trail is the only slot with a ribbon to paint; `BallTrail`
	 * is what applies them, both when a ball changes hands and again at the throw.
	 *
	 * **`halo` is not optional, and that is the whole of why this is an object rather than three fields.**
	 * A def that stated only a core would be drawn as a coloured ribbon inside `BALL_CONFIG`'s orange haze
	 * — and the haze is the wider layer, the longer-lived one, and the one drawn *across* the core rather
	 * than behind it, so an equipped trail would look like the default ball rather than like somebody's.
	 * Requiring the pair makes that a compile error in the def instead of an invisible cosmetic in the game,
	 * which is exactly the bug it was.
	 *
	 * **The pair follows one rule, stated once here so that thirteen defs do not each argue it:** the halo
	 * leads with the def's own `middle` and ends on its `trailing` pushed about a third darker. That is the
	 * relationship `BALL_CONFIG` gives the default ball — a saturated head and a dark residue, never the
	 * core's own colours over again — and it is a convention rather than a computation because a def is free
	 * to tune its haze on its own, which is the entire reason the pair is written down per item.
	 */
	colors?: {
		leading: Color3;
		middle: Color3;
		trailing: Color3;
		halo: { leading: Color3; trailing: Color3 };
	};
}

/**
 * Every cosmetic, keyed by id.
 *
 * **Four kinds share one id space, and the route each came by is not written on the id.** A milestone-granted
 * item and a chest-only trail are both `gamepassId: 0` and `priceRobux: 0`; a coin trail is the same pair
 * plus a `coinPrice`; a premium item has a Robux price. What tells the first two apart is `MILESTONES` above
 * and `CHEST_TRAILS` below — the two lists that *grant* things — and what tells the sold ones apart is which
 * price field they carry. **Keeping all four kinds in one map is what lets one id space cover them**, so a
 * player's `OWNED_COSMETICS_ATTRIBUTE` says "these ids" without having to say which route each came from —
 * and the shelf works the route out for itself when it has to write a sentence about it.
 *
 * **Asset ids and Game Pass ids are placeholders.** The trail colours are real and apply today; the
 * Game Pass ids are `0` until the developer creates them in the dashboard and pastes the ids here.
 */
export const COSMETICS: Record<string, CosmeticDef> = {
	// --- Earnable (milestones only, never priced) ---

	// **Every trail below states both layers** — the core's three colours and the haze's pair. See
	// `CosmeticDef.colors` for the rule the pairs follow, and for why the haze is not optional.
	"trail.victor": {
		id: "trail.victor",
		name: "Victor Trail",
		slot: "trail",
		gamepassId: 0,
		priceRobux: 0,
		colors: {
			leading: Color3.fromRGB(255, 240, 180),
			middle: Color3.fromRGB(255, 210, 80),
			trailing: Color3.fromRGB(140, 100, 20),
			halo: { leading: Color3.fromRGB(255, 210, 80), trailing: Color3.fromRGB(90, 65, 13) },
		},
	},
	"trail.crowned": {
		id: "trail.crowned",
		name: "Crown Trail",
		slot: "trail",
		gamepassId: 0,
		priceRobux: 0,
		colors: {
			leading: Color3.fromRGB(255, 255, 240),
			middle: Color3.fromRGB(255, 220, 80),
			trailing: Color3.fromRGB(180, 130, 20),
			halo: { leading: Color3.fromRGB(255, 220, 80), trailing: Color3.fromRGB(115, 85, 13) },
		},
	},
	"trail.veteran": {
		id: "trail.veteran",
		name: "Veteran Trail",
		slot: "trail",
		gamepassId: 0,
		priceRobux: 0,
		colors: {
			leading: Color3.fromRGB(210, 230, 255),
			middle: Color3.fromRGB(110, 170, 240),
			trailing: Color3.fromRGB(30, 70, 140),
			halo: { leading: Color3.fromRGB(110, 170, 240), trailing: Color3.fromRGB(20, 45, 90) },
		},
	},
	"trail.champion": {
		id: "trail.champion",
		name: "Champion Trail",
		slot: "trail",
		gamepassId: 0,
		priceRobux: 0,
		colors: {
			leading: Color3.fromRGB(255, 235, 200),
			middle: Color3.fromRGB(240, 160, 60),
			trailing: Color3.fromRGB(150, 70, 15),
			halo: { leading: Color3.fromRGB(240, 160, 60), trailing: Color3.fromRGB(98, 46, 10) },
		},
	},
	"trail.founder": {
		id: "trail.founder",
		name: "Founder Trail",
		slot: "trail",
		gamepassId: 0,
		priceRobux: 0,
		colors: {
			leading: Color3.fromRGB(240, 240, 255),
			middle: Color3.fromRGB(170, 150, 255),
			trailing: Color3.fromRGB(70, 40, 160),
			halo: { leading: Color3.fromRGB(170, 150, 255), trailing: Color3.fromRGB(45, 25, 105) },
		},
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

	// --- Chest only (the pool's own: never priced, and no milestone grants them) ---

	// **Each of the three states its own haze as well as its own core**, which is what makes it read as
	// somebody's trail rather than as the default ball with a tint down the middle. The core is the narrow,
	// fast-fading ribbon; the haze is wider, outlives it, and is drawn *across* it — so while the haze came
	// only from `BALL_CONFIG`, equipping one of these changed almost nothing on screen. See `CosmeticDef.colors`.
	//
	// **The three cores are cool or deep on purpose.** The head of every trail saturates toward white — see
	// `LIGHT_EMISSION` in `BallTrail` — so a def whose core stays close to white has nowhere to show itself
	// however its haze is coloured. Green, pink and steel are a long way from white; the warm family
	// (Victor, Crowned, Champion, Ember) is not, and those four are the trails that still read least like
	// themselves. The default is flat grey, which is the one value a white-out cannot take anything away
	// from, and it is outside this argument entirely.
	"trail.verdant": {
		id: "trail.verdant",
		name: "Verdant Trail",
		slot: "trail",
		gamepassId: 0,
		priceRobux: 0,
		colors: {
			leading: Color3.fromRGB(205, 255, 200),
			middle: Color3.fromRGB(70, 220, 120),
			trailing: Color3.fromRGB(16, 84, 48),
			halo: { leading: Color3.fromRGB(70, 220, 120), trailing: Color3.fromRGB(10, 55, 30) },
		},
	},
	"trail.rose": {
		id: "trail.rose",
		name: "Rose Trail",
		slot: "trail",
		gamepassId: 0,
		priceRobux: 0,
		colors: {
			leading: Color3.fromRGB(255, 220, 235),
			middle: Color3.fromRGB(255, 75, 145),
			trailing: Color3.fromRGB(110, 12, 55),
			halo: { leading: Color3.fromRGB(255, 75, 145), trailing: Color3.fromRGB(70, 8, 35) },
		},
	},
	"trail.silver": {
		id: "trail.silver",
		name: "Silver Trail",
		slot: "trail",
		gamepassId: 0,
		priceRobux: 0,
		// **The one of the three that leans on its haze rather than on its head.** Its leading colour is a *cool*
		// white beside the default's warm one, which is a difference nobody will see at throw speed — the head
		// saturates white whatever it is asked to be. What separates silver is the steel-blue haze around the
		// core and the slate it fades to, neither of which the default's orange-to-ember has.
		colors: {
			leading: Color3.fromRGB(250, 253, 255),
			middle: Color3.fromRGB(175, 190, 210),
			trailing: Color3.fromRGB(55, 65, 85),
			halo: { leading: Color3.fromRGB(175, 190, 210), trailing: Color3.fromRGB(36, 42, 55) },
		},
	},

	// --- Coin shelf (bought with coins: the simple tier, distinct from the chest's own) ---

	// **Priced at a flat `300`, and the number is the chest's rather than a guess.** The expected cost of
	// landing one *specific* prize from the chest is `CHEST_COST × pool size` — 50 over six entries, 300 — so a
	// direct purchase at exactly that figure never undercuts the chest, and the chest never makes a purchase
	// look overpriced. A buyer pays what the chest would average out to, and gets it *now* instead of after six
	// rolls; a gambler pays 50 and may get it first try. Both are honest, neither is strictly better, and that
	// is what "distinct route, equal price" buys. **Placeholder** — watch how fast coins come in before trusting
	// it, and see `ECONOMY_CONFIG` for the earn rates that bound the grind.
	//
	// **The three are cool or saturated, for the same reason the chest's three are** — and they carry their own
	// hazes for the same reason too. Cyan, crimson and frost-blue are a long way from white and from the warm
	// family (Victor, Crowned, Champion, Ember), which is what a trail's colours have to be to read as
	// themselves once its head has saturated.
	"trail.cyan": {
		id: "trail.cyan",
		name: "Cyan Trail",
		slot: "trail",
		gamepassId: 0,
		priceRobux: 0,
		coinPrice: 300,
		colors: {
			leading: Color3.fromRGB(160, 240, 255),
			middle: Color3.fromRGB(40, 200, 245),
			trailing: Color3.fromRGB(10, 100, 140),
			halo: { leading: Color3.fromRGB(40, 200, 245), trailing: Color3.fromRGB(5, 65, 90) },
		},
	},
	"trail.ruby": {
		id: "trail.ruby",
		name: "Ruby Trail",
		slot: "trail",
		gamepassId: 0,
		priceRobux: 0,
		coinPrice: 300,
		colors: {
			leading: Color3.fromRGB(255, 200, 205),
			middle: Color3.fromRGB(255, 60, 85),
			trailing: Color3.fromRGB(140, 10, 30),
			halo: { leading: Color3.fromRGB(255, 60, 85), trailing: Color3.fromRGB(90, 5, 20) },
		},
	},
	"trail.frost": {
		id: "trail.frost",
		name: "Frost Trail",
		slot: "trail",
		gamepassId: 0,
		priceRobux: 0,
		coinPrice: 300,
		colors: {
			leading: Color3.fromRGB(235, 250, 255),
			middle: Color3.fromRGB(160, 210, 235),
			trailing: Color3.fromRGB(50, 90, 120),
			halo: { leading: Color3.fromRGB(160, 210, 235), trailing: Color3.fromRGB(35, 60, 80) },
		},
	},

	// --- Premium (Game Pass, priced in Robux) ---
	"trail.aurora": {
		id: "trail.aurora",
		name: "Aurora Trail",
		slot: "trail",
		gamepassId: 0,
		priceRobux: 99,
		colors: {
			leading: Color3.fromRGB(180, 255, 230),
			middle: Color3.fromRGB(90, 220, 190),
			trailing: Color3.fromRGB(20, 110, 110),
			halo: { leading: Color3.fromRGB(90, 220, 190), trailing: Color3.fromRGB(15, 70, 70) },
		},
	},
	"trail.ember": {
		id: "trail.ember",
		name: "Ember Trail",
		slot: "trail",
		gamepassId: 0,
		priceRobux: 149,
		// **Now the only warm trail in the game, and the only one that resembles the default no longer.** While
		// the default was a warm white fading to embers this haze was `BALL_CONFIG`'s own pair almost exactly,
		// so an Ember ball looked much like an un-equipped one — the honest cost of a warm palette. The flat grey
		// default removes that: Ember is the one trail still reading as heat, and the dearest item in this file
		// got markedly more distinct without a value changing. Left exactly as it was, deliberately.
		colors: {
			leading: Color3.fromRGB(255, 240, 160),
			middle: Color3.fromRGB(255, 130, 40),
			trailing: Color3.fromRGB(120, 20, 10),
			halo: { leading: Color3.fromRGB(255, 130, 40), trailing: Color3.fromRGB(80, 15, 5) },
		},
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

/**
 * The coin-priced cosmetics, in catalog order — **the same derivation as {@link PREMIUM_COSMETICS}, keyed on
 * the other price.**
 *
 * **Only the simple tier carries `coinPrice` today, and the chest's three do not**, which is the whole of the
 * separation: a coin trail is bought and a chest trail is rolled, and a player can never pay coins for
 * something the chest could have handed them. The two routes are disjoint by construction — membership here
 * and membership in `CHEST_TRAILS` are two different fields, and no def in this file holds both.
 *
 * **A def that carried both `coinPrice` and `priceRobux` would be a def with two shops and one buyer**, which
 * nothing here stops and nothing here writes. That the two sold catalogues do not overlap is asserted by the
 * test suite rather than by the type.
 */
const purchaseCatalog: CosmeticDef[] = [];
for (const [key, def] of pairs(COSMETICS)) {
	void key;
	if (def.coinPrice !== undefined) purchaseCatalog.push(def);
}

export const PURCHASE_COSMETICS: readonly CosmeticDef[] = purchaseCatalog;
