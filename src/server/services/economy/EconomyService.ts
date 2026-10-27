import { OnStart, Service } from "@flamework/core";
import { DataStoreService, HttpService, Players } from "@rbxts/services";
import { AbilityKind, isAbilityKind } from "shared/ability";
import {
	COINS_ATTRIBUTE,
	CROWN_ATTRIBUTE,
	OWNED_COSMETICS_ATTRIBUTE,
	OWNED_ITEMS_ATTRIBUTE,
	POWER_POOL_ATTRIBUTE,
	ROUND_EARNED_COINS_ATTRIBUTE,
	STAT_HITS,
} from "shared/constants";
import {
	ECONOMY_CONFIG,
	CHEST_POOL,
	MILESTONES,
	POWER_ROSTER,
	COSMETICS,
	CosmeticDef,
	ChestItem,
	MilestoneDef,
} from "shared/config/economy.config";
import {
	EconomyRecord,
	blankEconomyRecord,
	toEconomyRecord,
	toSavedEconomy,
	joinItems,
	joinCosmeticIds,
	EQUIPPED_ATTRIBUTE,
} from "shared/economy";
import { events } from "shared/networking";
import { validatePurchase } from "shared/purchase";
import { LOGGING_ENABLED, logError, logInfo } from "shared/logger";
import { DevService } from "../../dev/DevService";
import {
	LOCK_EXPIRY_SECONDS,
	heldByAnother,
	serverNow,
	serverSessionId,
	stamped,
} from "../../persistence/sessionLock";
import { BIND_TO_CLOSE_SECONDS, WRITE_DEADLINE_SECONDS, runWithin } from "../../persistence/shutdown";
import { DRAW, RoundOutcome, TeamLabel } from "../round/team";

/**
 * What a write attempt did. **Three answers rather than a boolean, because the caller reacts to each
 * differently** Ã¢â‚¬â€ `written` retires the dirty mark, `failed` leaves it for the next sweep, and `refused`
 * means this session must stop writing this record altogether. The same three as `StatsService`'s, kept as
 * this file's own type because the two are answers about different records and either could gain a fourth.
 */
type WriteOutcome = "written" | "failed" | "refused";

/** What reading Ã¢â‚¬â€ and locking Ã¢â‚¬â€ a record answered. See {@link claim}. */
type ClaimOutcome =
	| { readonly ok: true; readonly record: EconomyRecord }
	| { readonly ok: false; readonly reason: string };

/**
 * The economy: one coin, one chest, a roster of owned powers, a set of owned cosmetics, and the two
 * milestone counters. All of it persists under one DataStore key per player.
 *
 * **Why one service holds the whole wallet.** The design is deliberately small Ã¢â‚¬â€ coins buy Powers and
 * nothing else, milestones award a fixed set of cosmetics, and Robux buys the premium catalog Ã¢â‚¬â€ so a
 * single record per player is the whole economy. Splitting it into a coin service, a power service and
 * a cosmetic service would be three DataStores, three loaders and three chances for one of them to be
 * out of step with the other two.
 *
 * **Coins are a wallet, not a score.** They are written here and nowhere else, they persist, and they
 * are clamped to at least nought on every write Ã¢â‚¬â€ the one number in the game that must never read as a
 * debt. The earn rules (base, win bonus, performance cap) live in {@link ECONOMY_CONFIG} and are applied
 * by {@link onRoundEnded}, which `RoundService` calls exactly once per finished round.
 *
 * **What a player owns is two sets, packed into two attributes.** `items` Ã¢â‚¬â€ the three powers today, and
 * whatever else gameplay-affecting arrives Ã¢â‚¬â€ and `cosmetics`, each published as one `|`-joined string (see
 * `OWNED_ITEMS_ATTRIBUTE`), so the client reads them with no remote and the server is the only writer. A
 * power a player does not own is a word absent from the string, and that is the whole of the lock:
 * `BallService` asks {@link ownsPower} before it honours a key.
 *
 * **Milestones are checked, not tracked separately.** The counters here are `matches` and `wins`; hits
 * come from `StatsService`'s lifetime `STAT_HITS`, and the crown milestone reads `CROWN_ATTRIBUTE`. One
 * method Ã¢â‚¬â€ {@link checkMilestones} Ã¢â‚¬â€ runs after a load, after every round, and when the crown flips on,
 * and grants whatever has been newly reached. There is deliberately no per-milestone state to save.
 */
@Service()
export class EconomyService implements OnStart {
	/** The live records; a player is absent while their record is still loading (or after they leave). */
	private readonly records = new Map<Player, EconomyRecord>();

	/** The last value written for each player, serialized, so an unchanged record is never written twice. */
	private readonly saved = new Map<Player, string>();

	/**
	 * **The players whose record this session must never write.**
	 *
	 * Two roads lead here and they end in the same place, which is why it is one set rather than two flags:
	 *
	 * - **The record could not be loaded.** The player then plays on a blank wallet Ã¢â‚¬â€ the platform recommends
	 *   that over kicking (*"we recommend letting the player play with default data ... rather than removing
	 *   them from the game"*) Ã¢â‚¬â€ but a blank wallet written back over a real one is a wipe, and the same page
	 *   warns about it by name: *"Take special care to ensure that fallback data doesn't later overwrite
	 *   'real' data."*
	 * - **Another server holds the lock.** Roblox's own sample marks such a profile `errored` and refuses to
	 *   write it, and the refusal has to last the whole session: the *moment* the other server releases, a
	 *   write from here would succeed Ã¢â‚¬â€ and it would carry the copy this server read before the other one
	 *   changed it.
	 *
	 * An entry is removed when the player leaves, so a rejoin starts clean.
	 */
	private readonly unsaveable = new Set<Player>();

	private cachedStore?: DataStore;

	constructor(private readonly dev: DevService) {}

	public onStart(): void {
		Players.PlayerAdded.Connect((player) => this.load(player));
		Players.PlayerRemoving.Connect((player) => this.saveAndForget(player));
		for (const player of Players.GetPlayers()) this.load(player);

		// The one save that is waited for: everything else is a periodic, boundary or leaver write. It waits
		// for a *bounded* time Ã¢â‚¬â€ see `saveAll`, which spends the shared `BindToClose` window rather than the
		// engine's whole one.
		game.BindToClose(() => this.saveAll());

		task.spawn(() => this.autosaveLoop());

		// The crown is the one milestone whose trigger is a flag, not a count Ã¢â‚¬â€ so it is watched here
		// rather than read from a counter at round end. A crown earned before the record loaded is caught
		// by the check that follows the load.
		Players.PlayerAdded.Connect((player) => {
			player.GetAttributeChangedSignal(CROWN_ATTRIBUTE).Connect(() => this.checkMilestones(player));
		});

		// The three things a client can ask the economy to do: open a chest, wear something, and move a power in
		// or out of the box's pool. All three are *requests* rather than values Ã¢â‚¬â€ see `equipCosmetic` and
		// `togglePowerPool` for why the client never gets to say what it owns, and `openChest` for why the chest
		// is the one that needs a reply.
		events.Server.OnEvent("openPowerChest", (player) => this.openChest(player));
		events.Server.OnEvent("equipCosmetic", (player, slot, id) => this.equipCosmetic(player, slot, id));
		events.Server.OnEvent("togglePowerPool", (player, power) => this.togglePowerPool(player, power));
		events.Server.OnEvent("purchaseCosmetic", (player, id) => this.purchaseCosmetic(player, id));

		// Dev shortcuts, so the loop can be exercised from a standing start.
		this.dev.onCommand("coins", (player) => {
			this.addCoins(player, 1000);
			logInfo(`[Economy] ${player.Name}: +1000 coins (dev)`);
		});
		this.dev.onCommand("powers", (player) => {
			for (const kind of POWER_ROSTER) this.grantPower(player, kind);
			logInfo(`[Economy] ${player.Name}: granted the full roster (dev)`);
		});

		// **`setMoney` is a second command rather than a replacement, and the two are different verbs.** `coins`
		// above is the one-keystroke "+1000" a dev reaches for on the way to testing something else; this exists
		// for the tests where the number *is* the subject Ã¢â‚¬â€ a chest costs 50, so 49 is how its refusal is reached,
		// and "add 1000" cannot express that. `coins` keeps its name and its behaviour.
		//
		// The handler is a method where the other two are closures, because this is the one command with arguments
		// to parse and the parsing is a paragraph of its own Ã¢â‚¬â€ see `devSetMoney`.
		this.dev.onCommand("setmoney", (player, args) => this.devSetMoney(player, args));

		if (LOGGING_ENABLED) {
			logInfo(
				`[Economy] up Ã¢â‚¬â€ ${POWER_ROSTER.size()} powers, ${MILESTONES.size()} milestones, ` +
					`chest ${ECONOMY_CONFIG.CHEST_COST} coins`,
			);
		}
	}

	/**
	 * The payout at the end of a round, for everyone who was there.
	 *
	 * **Called once per finished round by `RoundService.finishRound`**, after the winner is decided and
	 * the result board is out Ã¢â‚¬â€ so the numbers it reads are the round's final ones, not a moving count.
	 * It grants the base to everyone, the win bonus to the winning side, and a capped performance bonus
	 * from the round's hits; then it counts the match and the win, and checks the milestone table.
	 *
	 * **A draw grants the base and the performance bonus but no win.** There is nothing to win, but a
	 * match was played and hits were thrown, and both are still worth something.
	 *
	 * **A player whose record has not loaded is skipped rather than guessed at.** The alternative Ã¢â‚¬â€
	 * holding a grant in a queue and replaying it when the record arrives Ã¢â‚¬â€ is the kind of machinery a
	 * solo economy should not carry; a DataStore that has not answered inside a round is already the
	 * worse failure, and dropping one round's coins is the honest, small loss next to it.
	 */
	public onRoundEnded(
		outcome: RoundOutcome,
		teams: ReadonlyMap<Player, TeamLabel>,
		roundHits: ReadonlyMap<Player, number>,
		surrendered: ReadonlySet<Player>,
	): void {
		// **The round end is a save boundary, and the coins a round pays are the reason.** Every figure this
		// record holds moves here and on a purchase; before this the store heard about either only when the
		// player left or three minutes went by, so a crash or a shutdown in between lost the round's earnings
		// Ã¢â‚¬â€ the "critical checkpoints such as purchase processing" the platform's best-practice page asks for.
		// Collected rather than written inline, so the payouts below stay one synchronous pass, and flushed
		// after it so the writes carry the milestones the pass may have granted.
		const played: Player[] = [];

		for (const player of Players.GetPlayers()) {
			const record = this.records.get(player);
			if (record === undefined) continue;

			let coins: number = ECONOMY_CONFIG.MATCH_BASE_COINS;

			if (outcome !== DRAW && teams.get(player) === outcome) {
				coins += ECONOMY_CONFIG.MATCH_WIN_BONUS;
			}

			// One coin per hit, up to the cap Ã¢â‚¬â€ the reward for *contributing*, kept small and bounded so
			// a dominant player cannot convert one good round into a wallet ahead of everyone else.
			coins += math.min(roundHits.get(player) ?? 0, ECONOMY_CONFIG.PERFORMANCE_COIN_CAP);
			coins = math.min(coins, ECONOMY_CONFIG.MATCH_COIN_CAP);

			// **A player who walked out of the round is paid half, and the promise is the other half of this.**
			// Leaving mid-round is allowed, so it has to cost something or a side can be emptied on purpose the
			// moment a round turns; but a player who walks back onto their pad and finishes the same match is
			// back in the fight, and `RoundService.setTeam` drops them from the surrendered set the moment that
			// happens. So this line is read at the *end* of the round and the answer is therefore the true one:
			// still surrendered means they stayed in the lobby for the rest, and half is what that earns.
			//
			// **`math.floor`, so the halving can never round *up* into a reward for leaving.** A three-coin
			// payout becomes one rather than two; the alternative is a player on a round with almost nothing in
			// it losing no coins at all for walking out, which is the case the penalty exists for.
			//
			// **Nothing else moves.** The round still counts as played (`record.matches`), a win is still a win
			// if their side won without them, and the badges are untouched Ã¢â‚¬â€ `BadgeService` reads its own
			// subjects, and a surrendered player is still a body in the server when the round finishes.
			if (surrendered.has(player)) coins = math.floor(coins / 2);

			record.coins += coins;
			record.matches += 1;
			if (outcome !== DRAW && teams.get(player) === outcome) record.wins += 1;

			this.publish(player);

			// **And what this round was worth to them, published beside the wallet it was added to.** Two
			// attributes rather than one, because they answer two questions Ã¢â‚¬â€ "what do I have" and "what did
			// this just pay" Ã¢â‚¬â€ and the second is what the client's reward toast says out loud. Written from
			// the same local `coins` the balance was just increased by, so the ledger and the line item cannot
			// disagree about what the round was worth.
			//
			// **The client's change signal on this attribute *is* the notification**, which is why it is cleared
			// ten seconds later by `RoundService.holdCelebration` rather than left standing: a second round
			// paying the same number would write no change and fire no signal, and a toast that never appeared
			// would look like a round that never paid. The consequence to know about is that this value is *not*
			// readable after the celebration, so anything that wants the last round's figure long-term is asking
			// the wrong attribute. See `ROUND_EARNED_COINS_ATTRIBUTE`.
			player.SetAttribute(ROUND_EARNED_COINS_ATTRIBUTE, coins);

			logInfo(`[Economy] ${player.Name}: +${coins} coins (${record.coins})`);

			this.checkMilestones(player);

			played.push(player);
		}

		// Spawned, so `RoundService.finishRound` is not held for a write per player before the intermission
		// that follows Ã¢â‚¬â€ and so one slow record cannot delay the others. The dirty test in `flush` is what
		// keeps this from being a request per player per round.
		task.spawn(() => {
			for (const player of played) this.flush(player, "the round end");
		});
	}

	/**
	 * Whether `owner` owns `kind` Ã¢â‚¬â€ the one fact `BallService` asks before honouring a key.
	 *
	 * **A rig owns everything, and the rule lands here rather than at either call site.** The user's rule is
	 * "rigs own every item", and the way that stays one rule is that it is answered by the query that already
	 * exists: anything that is not a `Player` owns every X. A rig has no `Player`, no record and no wallet Ã¢â‚¬â€
	 * it is not a participant in the economy at all Ã¢â‚¬â€ so "does it own this power" has exactly one sensible
	 * answer, and every rig-side caller gets it without knowing anything about rigs.
	 *
	 * **What is deliberately not here, because each was the tempting shape and each is worse.** A rig-only
	 * method (`ownsPowerForRig`) would be a second query beside this one, so a caller would have to know which
	 * kind of body it was holding Ã¢â‚¬â€ the exact knowledge this signature removes. A bypass at `BallService`'s
	 * two call sites would put the rule in two places, one per call site, free to drift. A grant method that
	 * walked a rig's tags would be an economy write for a body with no record to write to. And a fake `Player`
	 * would put a body into `records` that can never be saved, keyed by a `UserId` that does not exist.
	 *
	 * **The *name* stays `ownsPower` now that the record's field is `items`, and that is the point of keeping
	 * two vocabularies.** This answers a question about a *power*; where ownership is stored is `items`, which
	 * holds powers and nothing else today. Calling this `ownsItem` would say less about what it checks in
	 * exchange for repeating the field name, and the cascade through `BallService` and `SuperService` would
	 * leave no reader better off.
	 *
	 * **The widening is honest about what it does today, which is nothing yet.** No rig asks this question
	 * while a rig's ability path does not exist Ã¢â‚¬â€ see the report on this task Ã¢â‚¬â€ so this is a *rule* that a
	 * rig's first caller will find already true rather than a behaviour that changed under anybody's feet.
	 * The player half is untouched to the letter: a player without the power is refused in the same words,
	 * from the same record.
	 */
	public ownsPower(owner: Player | Model, kind: AbilityKind): boolean {
		// **`IsA` rather than `typeIs`, because `typeIs` cannot name a `Player`** Ã¢â‚¬â€ its class-name overload
		// is limited to `keyof CheckableTypes`, and this build's `CheckableTypes` has no `Player` in it, so
		// `typeIs(owner, "Player")` is a compile error rather than a narrower check. `Instance.IsA` is
		// declared for every class name and is what narrows this union; it is also the check the rest of the
		// project already writes by hand for the same question.
		if (!owner.IsA("Player")) return true;

		return this.records.get(owner)?.items.has(kind) ?? false;
	}

	/**
	 * Wears `id` in `slot`, or clears the slot back to the default when `id` is empty.
	 *
	 * **Everything is checked here, and nothing is taken from the caller's word.** This is reached
	 * straight from an untyped wire, so the order below is the whole of the security rather than a
	 * formality Ã¢â‚¬â€ and the order is deliberately *structural first, expensive second*:
	 *
	 * 1. **`slot` must be a string, and one this build publishes** Ã¢â‚¬â€ `EQUIPPED_ATTRIBUTE`'s own keys. It is
	 *    first because it is the cheapest check and because every check after it is a lookup keyed by the
	 *    slot.
	 * 2. **`id` must be a string.** Anything else is dropped without a reply.
	 * 3. **The record must be loaded.** A player whose record read has not answered has no record to write,
	 *    and the request is dropped rather than queued Ã¢â‚¬â€ the same call `onRoundEnded` makes for the same
	 *    reason: a store that has not answered is already the worse failure, and a queue is machinery a
	 *    solo economy should not carry.
	 * 4. **An empty `id` is valid and means the default.** It clears the slot and stops there, because
	 *    there is no catalogue entry to check it against Ã¢â‚¬â€ see `EQUIPPED_TRAIL_ATTRIBUTE` for why `""`
	 *    rather than an absent attribute.
	 * 5. **A non-empty `id` must be a key in `COSMETICS`, and that def's `slot` must equal the slot asked
	 *    for.** The second half is not decoration: without it a trail could be equipped into the
	 *    elimination slot, and the two attributes would then describe a state the catalogue cannot
	 *    produce and no reader would have a branch for.
	 * 6. **And the player must own it, read from the record and never from an attribute.** The client's
	 *    `OWNED_COSMETICS_ATTRIBUTE` is a copy it renders from; this set is the only one that decides
	 *    anything. A client that names an id it does not own changes nothing at all, which is the whole
	 *    design: the client says *what it would like to wear*, and every other fact in the sentence is the
	 *    server's to supply.
	 *
	 * **The write is the whole of the dirty marking, and that is not a shortcut.** There is nothing to
	 * flag: `autosaveLoop` compares each record's serialized form against the last value it wrote, so
	 * changing the record *is* being dirty. A flag beside that comparison would be a second convention
	 * that could disagree with the first, which is exactly what the existing persistence avoids.
	 *
	 * **Silent on refusal, on purpose.** All five refusals are "that request was not valid" Ã¢â‚¬â€ a correct
	 * client sends none of them, and there is no sentence a player needs, unlike the chest's three
	 * distinct ones. The acknowledgement is {@link publish} writing the attribute, which replicates on
	 * its own; see `shared/networking.ts` on the event for the same call.
	 */
	public equipCosmetic(player: Player, slot: unknown, id: unknown): void {
		if (!typeIs(slot, "string")) return;
		if (EQUIPPED_ATTRIBUTE[slot] === undefined) return;
		if (!typeIs(id, "string")) return;

		const record = this.records.get(player);
		if (record === undefined) return;

		if (id === "") {
			record.equipped.delete(slot);
		} else {
			const def = COSMETICS[id];
			if (def === undefined || def.slot !== slot) return;
			if (!record.cosmetics.has(id)) return;

			record.equipped.set(slot, id);
		}

		this.publish(player);

		logInfo(`[Economy] ${player.Name}: ${slot} equipped ${id === "" ? "(default)" : id}`);
	}

	/**
	 * The trail colours `owner` is wearing, or nothing for the default grey.
	 *
	 * **The server answering a question the server asked.** `BallService.attachToHand` calls this on the
	 * way to `BallTrail.attach`, and it reads the *record* rather than the attribute for
	 * {@link equipCosmetic}'s reason: the attribute is a rendering copy, and a ball's appearance is not
	 * something a client gets to assert.
	 *
	 * **And it takes a *body* rather than a player since 2026-10-14, which is how a rig comes to wear a
	 * trail.** The caller has a `Model` in hand Ã¢â‚¬â€ that is what a ball is attached to Ã¢â‚¬â€ and the two kinds of
	 * body answer from two different places: a player's *character* answers from that player's record, and a
	 * **rig has no player behind it at all**, so its answer is an attribute on the model itself, written at
	 * spawn. One call, one read, and the caller never has to work out which kind of body it is holding; the
	 * split lives in {@link equippedTrail}, which is the only place that has to know.
	 *
	 * **`undefined` is the common answer and three different situations give it** Ã¢â‚¬â€ no body at all (a
	 * decorative prop, a corpse mid-rebuild), nothing equipped in the slot, and an equipped id this build no
	 * longer catalogues. All three mean "the default", so they are deliberately not told apart: the caller
	 * has one question and wants one answer.
	 *
	 * **It returns the def's own `colors`, which is `undefined` for every elimination cosmetic and for
	 * every cosmetic with no colours at all** Ã¢â‚¬â€ so equipping one changes nothing yet, which is honest
	 * rather than broken. See `COSMETICS` and the note there on the render hook.
	 */
	public equippedTrailColors(owner: Player | Model | undefined): CosmeticDef["colors"] {
		return this.equippedTrail(owner)?.colors;
	}

	/**
	 * The *id* of the trail `player` has equipped, or `""` for the default.
	 *
	 * **`equippedTrailColors`'s sibling, and the two exist so that one lookup cannot have two answers.**
	 * `BallService.attachToHand` prints this id beside the colours it has just handed to `BallTrail.attach`,
	 * because that log line is the only thing that can tell "the record had nothing equipped" from "the
	 * colours went on and the eye could not pick them out" Ã¢â‚¬â€ two situations with one symptom. The alternative
	 * source is `EQUIPPED_TRAIL_ATTRIBUTE`, which is the *rendering* copy and is exactly the source
	 * {@link equippedTrailColors} refuses to answer from, so the id comes off the record through the same
	 * {@link equippedTrail} question the colours do rather than from a second reading of the same fact.
	 *
	 * **`""` rather than `undefined`** for the three situations {@link equippedTrailColors} lists Ã¢â‚¬â€ no player,
	 * nothing equipped, an id this build no longer catalogues Ã¢â‚¬â€ because the empty string is already this
	 * project's word for "the default", and a caller that has to print one has no use for a second one.
	 */
	public equippedTrailId(owner: Player | Model | undefined): string {
		return this.equippedTrail(owner)?.id ?? "";
	}

	/**
	 * The trail def this *body* is wearing, or nothing for the default Ã¢â‚¬â€ the single lookup behind
	 * {@link equippedTrailColors} and {@link equippedTrailId}.
	 *
	 * Private, because "which def is this body wearing" is only ever asked in order to read one field of it,
	 * and the two callers want one field each.
	 *
	 * **Two answers in one place, and the split is the whole of what makes a rig's trail possible.** A
	 * character resolves to its player, and the record answers Ã¢â‚¬â€ the record is the only thing that may decide
	 * a *player's* appearance, which is why a client cannot talk its way into a trail. A rig resolves to
	 * nobody, so the **model's own attribute** answers instead, and that is the same attribute name a player
	 * carries a trail under (`EQUIPPED_TRAIL_ATTRIBUTE`, read through `EQUIPPED_ATTRIBUTE` so there is one
	 * place the pairing is written down). Written at spawn by `NpcService`, and read-only here.
	 *
	 * **An attribute rather than a second kind of record, and the reason is that a rig has nothing to
	 * persist.** A trail chosen at spawn is not a player's possession, it is part of the body Ã¢â‚¬â€ the same
	 * class of fact as a rig's `ThrowerToken`, which is also an attribute written where the body is made.
	 * A rig record would need a `UserId` that does not exist, a DataStore row that is never read twice, and
	 * a loader that runs on a body which has no client.
	 *
	 * **The cosmetic is read through the same `COSMETICS` lookup for both answers**, so a rig's trail and a
	 * player's trail are validated and coloured by one piece of code Ã¢â‚¬â€ including the `slot === "trail"` half,
	 * which is what stops a rig wearing an id that is not a trail at all.
	 */
	private equippedTrail(owner: Player | Model | undefined): CosmeticDef | undefined {
		if (owner === undefined) return undefined;

		// `IsA` rather than `typeIs` for `ownsPower`'s reason: this build's `CheckableTypes` cannot name a
		// `Player`, so the narrowing is done by the instance method that is declared for every class name.
		//
		// **Written as a branch rather than as one nested ternary, and the reason is that the narrowing is
		// what tells the two answers apart.** A body with a player behind it Ã¢â‚¬â€ a `Player`, or a *character*,
		// which is a `Model` whose `UserId` resolves Ã¢â‚¬â€ answers from the record; a rig has no player at all,
		// so its own attribute answers. Folding the two tests into one expression loses the narrowing that
		// makes `trailIdOn` a `Model` call, which is the compiler telling the truth rather than being fussy:
		// `GetPlayerFromCharacter` accepting a `Player` is not the same question.
		let id: string | undefined;

		if (owner.IsA("Player")) {
			id = this.records.get(owner)?.equipped.get("trail");
		} else {
			const player = Players.GetPlayerFromCharacter(owner);
			id = player !== undefined ? this.records.get(player)?.equipped.get("trail") : this.trailIdOn(owner);
		}

		if (id === undefined) return undefined;

		const def = COSMETICS[id];
		if (def === undefined || def.slot !== "trail") return undefined;

		return def;
	}

	/**
	 * The trail id written on a **rig's** model, or nothing.
	 *
	 * The `Model` half of {@link equippedTrail}, split out because it is the one place a rig's cosmetic is
	 * read and because it has to validate the attribute's *type*: an attribute is a bag of anything, and a
	 * model wearing a number or an empty string is a model wearing no trail rather than one wearing an id
	 * called `0`. Nothing else about the attribute is trusted Ã¢â‚¬â€ the catalogue lookup above is what decides
	 * whether the id means anything.
	 */
	private trailIdOn(model: Model): string | undefined {
		const id = model.GetAttribute(EQUIPPED_ATTRIBUTE.trail);

		return typeIs(id, "string") && id !== "" ? id : undefined;
	}

	/**
	 * Spends `COINS` on a chest and grants one random unowned power.
	 *
	 * **The refusal answers are three different sentences**, which is the whole reason the chest gets a
	 * reply event where a mark or a window does not: "not enough coins", "still loading" and "all
	 * collected" all leave the wallet unchanged, and a player cannot be expected to tell them apart by
	 * watching for what did *not* happen.
	 *
	 * **Uniform random over the unowned remainder**, because there is no rarity here and no reason to
	 * pretend there is: every unowned power is equally good, which is what "no duplicates" buys. The
	 * last remaining power is therefore a guarantee Ã¢â‚¬â€ the anticlimax the design accepts in exchange for
	 * the honest progression.
	 */
	public openChest(player: Player): void {
		const record = this.records.get(player);
		if (record === undefined) {
			this.sendChestResult(player, "", "your record is still loading");
			return;
		}

		if (record.coins < ECONOMY_CONFIG.CHEST_COST) {
			this.sendChestResult(player, "", "not enough coins");
			return;
		}

		// **A refusal rather than a guaranteed miss, and that is a product decision worth writing down.** If
		// every entry in the pool is already owned, spending 50 coins can only produce nothing, and the honest
		// thing is to say so before taking the money rather than after. It is also the only refusal here that
		// describes a *finished* state rather than a failure: everything the chest can give has been given.
		//
		// The wording no longer says "powers", because the pool is not powers Ã¢â‚¬â€ it is every entry the chest can
		// give, cosmetics included, and new kinds join it the day they exist. A message naming one arm of a
		// union is a message that goes stale the moment the union grows.
		//
		// **This is the same test the shop's button gate runs**, from the record here and from the two owned
		// attributes there Ã¢â‚¬â€ see `ShopController.unclaimedItems`. They agree because they are one predicate over
		// one list, which is worth knowing before either is edited: the client decides whether to *offer* the
		// chest and the server decides whether to *take* the coins, so a disagreement would be a button that
		// charges for a refusal.
		const items = CHEST_POOL.filter((item) => !this.ownsItem(record, item));
		if (items.size() === 0) {
			this.sendChestResult(player, "", "nothing left in the chest to win");
			return;
		}

		// **Rolled over the whole pool, unowned entries included, and that is the mechanic.** Filtering the
		// roll down to what the player does not have would make every chest a guaranteed grant and delete the
		// duplicate outcome entirely Ã¢â‚¬â€ the filter is not a defensive measure, it is the *only* thing that
		// makes a miss possible. There is no miss-rate number anywhere in the config: the chance of getting
		// nothing is exactly the fraction of `CHEST_POOL` this player already owns, derived on every roll.
		const item = CHEST_POOL[math.random(CHEST_POOL.size()) - 1];

		// **The coins go before the outcome is known, and the order is the mechanic rather than sloppiness.**
		// A roll that only charged on success would be a free re-roll on every duplicate, which turns the
		// duplicate from the point of the pool into a retry button.
		record.coins -= ECONOMY_CONFIG.CHEST_COST;

		// **The duplicate is the outcome, not an error case.** It is what the pool is for: a player who owns
		// most of it mostly gets nothing, which is what keeps a full collection from being worth grinding for
		// and what makes the remaining entries feel like they cost something. No pity mechanic, deliberately Ã¢â‚¬â€
		// every roll is independent of every roll before it, and a counter that improved the odds after a miss
		// would be a second, invisible rule deciding the same thing.
		//
		// The message says what happened Ã¢â‚¬â€ *you already had that* Ã¢â‚¬â€ rather than "you failed", because nothing
		// went wrong: the chest worked exactly as designed and the player got the commonest result.
		if (this.ownsItem(record, item)) {
			this.publish(player);

			if (LOGGING_ENABLED) {
				// **Named by its own id rather than by the reply's string, and the difference is the point.** The reply
				// carries a cosmetic's *display* name; this line is a log, and a reader of it wants the thing the pool
				// and the record call it Ã¢â‚¬â€ the id for one arm, the ability name for the other.
				const rolled = item.kind === "power" ? item.power : item.cosmetic;

				logInfo(
					`[Economy] ${player.Name}: chest rolled ${rolled} Ã¢â‚¬â€ already owned, ` +
						`${record.coins} coins left`,
				);
			}

			this.sendChestResult(player, "", "you already had that one");
			return;
		}

		/**
		 * **The grant, in two arms, and the reply's string is the one thing they do not share.**
		 *
		 * A power travels as its **id** Ã¢â‚¬â€ `"Pierce"` Ã¢â‚¬â€ because the client owns the map from id to the words on the
		 * tile (`ABILITY_NAMES`, which the shop already reads to name the roster). A cosmetic travels as its
		 * **display name**, `"Verdant Trail"`, because the panel has no equivalent map: its footer is one line with
		 * nowhere to look a cosmetic id up from, and the catalogue is this side of the wire. Sending the id and
		 * making the client name it would be a second copy of the catalogue's vocabulary on the client for one
		 * sentence.
		 *
		 * **The record is written with the *id* either way, because the record is what the shelf and the equip path
		 * read** Ã¢â‚¬â€ the name is for the sentence and nothing else. Those two facts are the reason this branch has two
		 * strings in it rather than one.
		 *
		 * **A pool entry naming an id this build no longer catalogues falls back to the id itself** rather than
		 * refusing the roll: the player has already paid by the time this runs, and a chest that took the coins and
		 * gave nothing would be worse than a sentence that reads as an id. The fallback is the same rule the owned
		 * set follows Ã¢â‚¬â€ an id the client cannot resolve is the client's to ignore, not a reason to drop the grant.
		 *
		 * **Only the power arm touches `record.pool`.** That set is what the *item box* may grant, and it holds
		 * ability kinds; a cosmetic joining it would be an entry the box could never use and the pool attribute
		 * could never render.
		 */
		let reply: string;

		if (item.kind === "power") {
			// Kept as its own `AbilityKind` rather than funnelled through the string below, because the record's
			// two ability-typed sets are typed on the ability and not on `string`: the reply is a sentence, the
			// record is data.
			const power = item.power;

			record.items.add(power);
			// **And the new power joins the pool, which is the difference between a setting and a broken box.**
			// Without this a player who narrows their pool and then earns a power never sees it in the box Ã¢â‚¬â€ and the
			// symptom is a box that ignores an item they demonstrably own, which reads as a bug in the box rather than
			// as a pool that is out of date.
			//
			// **Unconditionally, including into a pool the player has emptied.** The alternative Ã¢â‚¬â€ leave the pool
			// alone while it is empty Ã¢â‚¬â€ treats "everything off" as a decision about *future* powers, which is not what
			// the tab says it is: it is where you narrow what the box may hand you, and it has to be visible to the
			// player to be usable, so something just earned cannot go in invisibly. The cost is that an emptied pool
			// gains one entry back, which is a small, visible, reversible surprise; cheaper than a power that
			// silently never appears.
			record.pool.add(power);

			reply = power;
		} else {
			record.cosmetics.add(item.cosmetic);
			reply = COSMETICS[item.cosmetic]?.name ?? item.cosmetic;
		}

		this.publish(player);

		if (LOGGING_ENABLED) {
			logInfo(`[Economy] ${player.Name}: chest granted ${reply} Ã¢â‚¬â€ ${record.coins} coins left`);
		}

		this.sendChestResult(player, reply, "");
	}

	/**
	 * Spends coins on one catalogued cosmetic, if the catalogue, the record and the wallet all say yes.
	 *
	 * **The whole of the checking lives in {@link validatePurchase}, and this method is the two things no pure
	 * function can own: the record lookup and the write.** The decision is a pure function of the record and
	 * the catalogue, so it is what the test suite exercises Ã¢â‚¬â€ with no `Player`, no DataStore and no mock of
	 * either Ã¢â‚¬â€ and this stays a thin caller that reaches for the record and then performs whatever the decision
	 * said.
	 *
	 * **The record is read once and handed to the decision, then re-read for the write.** The second read is
	 * the type's price for the validation's order: the decision is what keeps the wire discipline (string,
	 * catalogue, record, ownership, balance) in one function, and a successful decision cannot be produced for
	 * an unloaded record Ã¢â‚¬â€ so the guard below is unreachable. It is written anyway rather than cast away,
	 * because a cast would be the one place in this file where a missing record was *asserted* instead of
	 * checked.
	 *
	 * **The deduction precedes the grant, and the argument is the reverse of the chest's.** The chest spends
	 * before the roll because the roll can miss, and spending first is what makes a miss a cost rather than a
	 * free re-roll. A purchase cannot miss Ã¢â‚¬â€ {@link validatePurchase} has already answered every question Ã¢â‚¬â€
	 * so the order is a choice about the one failure left, a crash between the two writes: paying without
	 * receiving is the recoverable failure (coins are cheap to restore), while receiving without paying is the
	 * one the economy cannot undo. Deduct, then grant.
	 *
	 * **Silent on refusal, but not by the equip path's rule.** `equipCosmetic`'s refusals are all "that was not
	 * a valid request" and a correct client never sends them; a purchase's are sentences a *correct* client
	 * will hit Ã¢â‚¬â€ the wallet runs out, the player already owns the thing Ã¢â‚¬â€ so each is answered with
	 * {@link sendPurchaseResult} and drawn on the panel. The strings are this event's own and never the
	 * chest's, so the two never read alike on the one line they share.
	 */
	public purchaseCosmetic(player: Player, id: unknown): void {
		const decision = validatePurchase(this.records.get(player), id, COSMETICS);

		if (!decision.ok) {
			this.sendPurchaseResult(player, "", decision.reason);
			return;
		}

		const record = this.records.get(player);
		if (record === undefined) return;

		record.coins -= decision.price;
		record.cosmetics.add(decision.id);
		this.publish(player);

		if (LOGGING_ENABLED) {
			logInfo(`[Economy] ${player.Name}: bought ${decision.id} Ã¢â‚¬â€ ${record.coins} coins left`);
		}

		this.sendPurchaseResult(player, decision.name, "");
	}

	/**
	 * Grants a power outright Ã¢â‚¬â€ the dev command's door, and the only bypass to the chest.
	 *
	 * **This is the other way a power arrives, and the pool is written here for the same reason it is written
	 * in `openChest`.** `!dev powers` walks the whole roster through this method, so covering it here is what
	 * makes the dev shortcut produce a usable pool rather than a shelf that is right and a box that is empty.
	 * The two doors are not one door, though Ã¢â‚¬â€ `openChest` adds its grant to the pool itself, because it does
	 * not come through here.
	 */
	public grantPower(player: Player, kind: AbilityKind): void {
		const record = this.records.get(player);
		if (record === undefined) return;

		record.items.add(kind);
		record.pool.add(kind);
		this.publish(player);
	}

	/**
	 * Puts `power` into the item-box pool, or takes it out.
	 *
	 * **Checked in this order, and the order is cheapest-and-most-structural first:**
	 *
	 * 1. **`power` must be a string.** It arrives from an untyped wire; nothing else is assumed about it.
	 * 2. **`isAbilityKind(power)`** Ã¢â‚¬â€ a name this build knows. Without this an arbitrary word would enter the
	 *    set, be joined into the attribute, and be read back by the panel as a power that cannot exist.
	 * 3. **The record must be loaded.** A request arriving before the record read answers is dropped rather
	 *    than queued Ã¢â‚¬â€ {@link equipCosmetic}'s call, for its reason.
	 * 4. **And the player must own it, read from `record.items` and never from an attribute.** This is the
	 *    check that makes the remote safe rather than merely tidy: the pool is a *subset of what you own*, so a
	 *    client cannot talk itself into a pool entry it has not earned. The client's `OWNED_ITEMS_ATTRIBUTE`
	 *    is a copy it renders from; the record is the only set that decides.
	 *
	 * **A toggle rather than a setter, so a stale client is harmless rather than dangerous.** The wire asks
	 * for a flip and the record performs a flip, so a client that has lost track of its own pool sends the same
	 * message it would have sent had it been right Ã¢â‚¬â€ see the declaration for why that matters more than it
	 * looks.
	 *
	 * There is nothing to mark dirty: {@link autosaveLoop} compares the serialized record against the last
	 * value it wrote, so changing the record *is* being dirty.
	 */
	public togglePowerPool(player: Player, power: unknown): void {
		if (!typeIs(power, "string")) return;
		if (!isAbilityKind(power)) return;

		const record = this.records.get(player);
		if (record === undefined) return;

		// **Ownership is `items`, which holds powers and nothing else today.** So this is the pool's subset test
		// Ã¢â‚¬â€ the pool may only offer what the player owns Ã¢â‚¬â€ and the field name says where ownership is stored
		// rather than what it holds. See `EconomyRecord.items`.
		if (!record.items.has(power)) return;

		if (record.pool.has(power)) {
			record.pool.delete(power);
		} else {
			record.pool.add(power);
		}

		this.publish(player);

		logInfo(`[Economy] ${player.Name}: ${power} pool ${record.pool.has(power) ? "on" : "off"}`);
	}

	/** Adds coins outright Ã¢â‚¬â€ the dev command's door. Clamped to at least nought. */
	public addCoins(player: Player, amount: number): void {
		const record = this.records.get(player);
		if (record === undefined) return;

		record.coins = math.max(0, record.coins + amount);
		this.publish(player);
	}

	/**
	 * Sets a wallet outright Ã¢â‚¬â€ **`!dev setMoney`'s door, and the only absolute write in this file.**
	 *
	 * **`set` rather than `add`, which is the whole of the difference from `addCoins` above.** That one moves a
	 * wallet by a delta, which is what a round's payout and `!dev coins` are; this replaces the number, which is
	 * what a test needs when the wallet *is* the thing being tested Ã¢â‚¬â€ the chest costs 50, so 49 is how the "not
	 * enough coins" refusal is reached on purpose, and no sequence of additions reliably gets you there.
	 *
	 * **The clamp and the flooring are here rather than at the command**, so that no door into this field can
	 * produce a debt or a fraction: the economy's rule is that coins are whole and never read as negative, and a
	 * rule kept at a call site is a rule the next call site can miss.
	 */
	public setCoins(player: Player, amount: number): void {
		const record = this.records.get(player);
		if (record === undefined) return;

		record.coins = math.max(0, math.floor(amount));
		this.publish(player);
	}

	/**
	 * `!dev setMoney <amount> [player]` Ã¢â‚¬â€ **the wallet set outright, for a target rather than necessarily the
	 * caller.**
	 *
	 * **Positional arguments, taken from what the chat parser already split.** `DevService.handleChat` hands over
	 * the words that followed the verb, lower-cased, and this is where the command's shape is decided Ã¢â‚¬â€ here
	 * rather than in `DevService`, which owns no records and must not learn to (see `onCommand`'s note about the
	 * dependency cycle, and this service's own helper on why it is the machine that writes coins).
	 *
	 * **Every refusal prints rather than acting.** A dev command's answer belongs in the output window, beside the
	 * `[Dev] Ã¢â‚¬Â¦ <message>` line that shows the command arriving, which is where `!dev coins` confirms itself. There
	 * is no remote back to the asker and there should not be one: a refusal a dev cannot see in the log is a
	 * refusal that reads as a command that did nothing.
	 *
	 * **Four refusals, and each names the thing that was wrong**: the amount missing, the amount not being a
	 * positive whole number, a named player not in the server, and a target whose record has not loaded. The first
	 * is the only one that has to print a usage line, because a missing argument is the one case with no offending
	 * value to quote.
	 *
	 * **The record check is a refusal rather than a wait**, which is `equipCosmetic`'s and `openChest`'s call for
	 * the same reason: a waiting state would have to be resolved later by something that remembers what was asked,
	 * and a store that has not answered inside a dev command is already the worse failure. Setting a wallet on a
	 * record that lands a moment later would also be *silently* discarded, which is the worst of the options.
	 */
	private devSetMoney(asker: Player, args: readonly string[]): void {
		const raw = args[0];
		if (raw === undefined) {
			logInfo(`[Economy] ${asker.Name}: setMoney needs an amount Ã¢â‚¬â€ !dev setMoney <amount> [player]`);
			return;
		}

		// **One test for four ways of being wrong, because they are one fact**: what was typed is not a number of
		// coins. `tonumber` answers `undefined` for anything that is not a number at all; `!(amount > 0)` is the
		// nought and the negative *and* the `NaN` that comparison would otherwise let through; `>= math.huge` is
		// the two infinities, which pass the whole-number test (`math.floor(math.huge) === math.huge`); and the
		// floor test is the fraction. Written as one condition so that the message below can be one sentence.
		const amount = tonumber(raw);

		if (amount === undefined || !(amount > 0) || amount >= math.huge || math.floor(amount) !== amount) {
			logInfo(`[Economy] ${asker.Name}: setMoney refused Ã¢â‚¬â€ "${raw}" is not a positive whole number of coins`);
			return;
		}

		const wanted = args[1];
		const target = wanted === undefined ? asker : this.findPlayerByName(wanted);

		if (target === undefined) {
			logInfo(`[Economy] ${asker.Name}: setMoney refused Ã¢â‚¬â€ no player named "${wanted}" is in this server`);
			return;
		}

		if (this.records.get(target) === undefined) {
			logInfo(`[Economy] ${asker.Name}: setMoney refused Ã¢â‚¬â€ ${target.Name}'s record is still loading`);
			return;
		}

		this.setCoins(target, amount);

		logInfo(
			`[Economy] ${target.Name}: wallet set to ${amount} (dev` +
				`${target === asker ? "" : ` by ${asker.Name}`})`,
		);
	}

	/**
	 * The player whose name matches `lowered`, or nothing.
	 *
	 * **Compared lower case on both sides, because the parser lowered the argument.** `DevService` splits a
	 * message from `message.lower()` so that a command is case-insensitive, and its arguments inherit that: a
	 * player named `Morri` arrives here as `morri` (see `onCommand`, which states it as a property of the split
	 * rather than of this command). Comparing the two lowered is therefore the only comparison that can succeed,
	 * and it is safe because two accounts cannot differ by case alone Ã¢â‚¬â€ Roblox names are unique.
	 */
	private findPlayerByName(lowered: string): Player | undefined {
		for (const player of Players.GetPlayers()) {
			if (player.Name.lower() === lowered) return player;
		}

		return undefined;
	}

	/**
	 * Grants every milestone the player has newly reached, and nothing more.
	 *
	 * **The one place a milestone is decided**, so the three moments that can change an answer Ã¢â‚¬â€ the
	 * load, the end of a round, the crown flipping on Ã¢â‚¬â€ all call this and nowhere else has the rule. A
	 * cosmetic already owned is skipped, which is what makes calling this repeatedly safe and cheap.
	 */
	private checkMilestones(player: Player): void {
		const record = this.records.get(player);
		if (record === undefined) return;

		for (const milestone of MILESTONES) {
			if (record.cosmetics.has(milestone.cosmeticId)) continue;
			if (!this.reached(player, record, milestone)) continue;

			record.cosmetics.add(milestone.cosmeticId);
			this.publish(player);

			if (LOGGING_ENABLED) {
				const cosmetic = COSMETICS[milestone.cosmeticId];
				logInfo(`[Economy] ${player.Name}: milestone ${milestone.id} Ã¢â‚¬â€ earned ${cosmetic?.name ?? milestone.cosmeticId}`);
			}
		}
	}

	/** Whether `milestone`'s counter has crossed its threshold. */
	private reached(player: Player, record: EconomyRecord, milestone: MilestoneDef): boolean {
		switch (milestone.stat) {
			case "matches":
				return record.matches >= milestone.threshold;
			case "wins":
				return record.wins >= milestone.threshold;
			case "hits": {
				const hits = player.GetAttribute(STAT_HITS);
				return typeIs(hits, "number") && hits >= milestone.threshold;
			}
			case "crown":
				return player.GetAttribute(CROWN_ATTRIBUTE) === true;
		}
	}

	/**
	 * Writes the record's attributes, so the client sees one consistent snapshot.
	 *
	 * **Every slot is written on every publish, including the ones nobody is wearing**, which is what
	 * makes an absent attribute impossible: a reader never has to tell "nothing equipped" from "the
	 * economy has not published yet", because the empty string is written either way. It is a handful of
	 * `SetAttribute` calls on a change that already writes three, and the alternative Ã¢â‚¬â€ writing only the
	 * slot that moved Ã¢â‚¬â€ would leave a client that joined between two changes with no attribute to read
	 * at all.
	 *
	 * The slot table is walked rather than the two names being spelled out here and read again in the
	 * panel: {@link EQUIPPED_ATTRIBUTE} is the one place the pairing is written down, so a third slot is
	 * one line in that file and nothing here.
	 *
	 * **The pool is written on every publish like the rest, and it has to be**, because `""` is a real
	 * value for it Ã¢â‚¬â€ "the box has nothing to give" Ã¢â‚¬â€ so a reader cannot tell a pool that was never
	 * published from one that was deliberately emptied. Publishing it unconditionally is what makes the
	 * attribute the client reads always the record's own answer. See `POWER_POOL_ATTRIBUTE`.
	 */
	private publish(player: Player): void {
		const record = this.records.get(player);
		if (record === undefined) return;

		player.SetAttribute(COINS_ATTRIBUTE, record.coins);
		player.SetAttribute(OWNED_ITEMS_ATTRIBUTE, joinItems(record.items));
		player.SetAttribute(POWER_POOL_ATTRIBUTE, joinItems(record.pool));
		player.SetAttribute(OWNED_COSMETICS_ATTRIBUTE, joinCosmeticIds(record.cosmetics));

		for (const [slot, attribute] of pairs(EQUIPPED_ATTRIBUTE)) {
			player.SetAttribute(attribute, record.equipped.get(slot) ?? "");
		}
	}

	/**
	 * Whether `record` already has `item` Ã¢â‚¬â€ the only question the chest asks about a roll.
	 *
	 * **One place, asked twice, and the two asks are not the same check.** The refusal asks it of every entry
	 * in the pool to decide whether there is anything left to win; the roll asks it of the one entry that
	 * came up. Writing the membership test inline in both would be two chances for one arm of the union to be
	 * handled in one of them and forgotten in the other Ã¢â‚¬â€ which is exactly the bug the tagged {@link ChestItem}
	 * exists to prevent, and it only pays off if the test lives in one function.
	 *
	 * **Both arms read the record, and neither reads an attribute.** `record.items` and `record.cosmetics` are
	 * the two owned sets this service writes; the attributes are copies the client renders from, and a chest
	 * that trusted one would be a chest a client could talk out of its own duplicate.
	 *
	 * **The power arm asks `items`, which holds powers and nothing else today** Ã¢â‚¬â€ the same subset test
	 * `togglePowerPool` makes, read from the other direction. The method's name follows what the chest rolls;
	 * the arm below is a power check because a power is what an entry of that arm is.
	 */
	private ownsItem(record: EconomyRecord, item: ChestItem): boolean {
		return item.kind === "power" ? record.items.has(item.power) : record.cosmetics.has(item.cosmetic);
	}

	/** The chest's answer, to the player who asked. */
	private sendChestResult(player: Player, granted: string, reason: string): void {
		events.Server.Get("chestResult").SendToPlayer(player, granted, reason);
	}

	/** The purchase's answer, to the player who asked. */
	private sendPurchaseResult(player: Player, granted: string, reason: string): void {
		events.Server.Get("purchaseResult").SendToPlayer(player, granted, reason);
	}

	// --- persistence -------------------------------------------------------

	private key(player: Player): string {
		return tostring(player.UserId);
	}

	/** The store, fetched once and cached; `undefined` if the fetch failed. */
	private store(): DataStore | undefined {
		if (this.cachedStore !== undefined) return this.cachedStore;

		const [success, result] = pcall(() => DataStoreService.GetDataStore(ECONOMY_CONFIG.DATASTORE_NAME));
		if (!success) {
			logError(`[Economy] could not open ${ECONOMY_CONFIG.DATASTORE_NAME}: ${tostring(result)}`);
			return undefined;
		}

		this.cachedStore = result as DataStore;
		return this.cachedStore;
	}

	/**
	 * **Reads `player`'s record and takes the session lock on it, in one `UpdateAsync`.**
	 *
	 * **The claim and the read have to be the same call.** A read followed by a write would leave a window in
	 * which two servers both see the same record and both believe they own it Ã¢â‚¬â€ which is the fault the lock
	 * exists to close, re-opened by the read itself. The platform's own reference implementation makes the
	 * same move: the lock is *"atomically"* written *"inside the same `UpdateAsync()` call"* as the first read.
	 * It matters more here than it does for stats, because a wallet is money: two servers counting the same
	 * coins from the same starting balance is how a player earns a round twice.
	 *
	 * **The transform cannot yield** Ã¢â‚¬â€ *"The callback function you pass into UpdateAsync() does not have
	 * permission to yield"* Ã¢â‚¬â€ so everything in it is a table read, a compare and `GetServerTimeNow()`, which
	 * does not wait.
	 *
	 * **A claimed record is written back stamped with its fields untouched**, so claiming costs the player
	 * nothing. A value that is absent or is not a table becomes an empty table, which is also the migration
	 * path for every record written before this change: it carries no session fields, reads as unlocked, and
	 * the first claim upgrades it in place while `toEconomyRecord` reads every figure it already had from the
	 * fields it keeps. Unknown fields are ignored by that parser, which is what makes the two new ones free.
	 */
	private claim(player: Player): ClaimOutcome {
		const store = this.store();
		if (store === undefined) return { ok: false, reason: "the store is not available" };

		const key = this.key(player);
		const session = serverSessionId();

		const [success, result] = pcall(() =>
			store.UpdateAsync(key, (oldValue: unknown) => {
				const now = serverNow();

				// **Held by somebody else and not expired: cancel the write by returning nothing** Ã¢â‚¬â€ the
				// documented refusal Ã¢â‚¬â€ rather than writing over a live session's wallet.
				if (heldByAnother(oldValue, session, now, LOCK_EXPIRY_SECONDS) !== undefined) {
					return $tuple(undefined);
				}

				const base: object = typeIs(oldValue, "table") ? (oldValue as object) : {};

				return $tuple(stamped(base, session, serverNow()));
			}),
		);

		if (!success) {
			logError(`[Economy] load failed for ${player.Name} (${key}): ${tostring(result)}`);

			return { ok: false, reason: "the read failed" };
		}

		// Nothing back means our transform refused: the other server still owns the record.
		if (result === undefined) return { ok: false, reason: "another server holds this record" };

		return { ok: true, record: toEconomyRecord(result) };
	}

	/**
	 * **Writes `player`'s record through the session lock. Always `UpdateAsync`, never `SetAsync`.**
	 *
	 * **The whole of this method changed shape for a reason that is worth stating plainly**: the old version
	 * was `pcall(() => store.SetAsync(key, payload))` with `const [success] =` Ã¢â‚¬â€ the error was thrown away and
	 * a failed write was a number in a store that quietly never changed. Now the failure is printed with the
	 * player, the key and what the store said, because a wallet that stops saving is the one failure in this
	 * game a player will notice and nobody would otherwise be able to explain.
	 *
	 * **`UpdateAsync` on the platform's own rule** Ã¢â‚¬â€ *"prefer UpdateAsync() when a write depends on the current
	 * value or when multiple servers might write the same key"* Ã¢â‚¬â€ since the value written carries the lock and
	 * has to be checked against the one held. `release` is the difference between an ordinary write and the
	 * last one: a periodic or boundary write refreshes the stamp and keeps the lock, while a leaver's write and
	 * a shutdown's write *drop* it, which is the documented unlocking step (*"as part of the final write in
	 * `PlayerRemoving` or `BindToClose()`"*) and what lets a player who hops servers land unlocked.
	 *
	 * **`this.saved` holds the *unstamped* serialization**, which is not an oversight: the dirty test is a
	 * comparison between two records, and a timestamp that changed on every write would make every record look
	 * different from the last one written. The stamp exists in the store, not in memory.
	 */
	private write(player: Player, release: boolean): WriteOutcome {
		const record = this.records.get(player);
		if (record === undefined) return "failed";

		const store = this.store();
		if (store === undefined) return "failed";

		const key = this.key(player);
		const session = serverSessionId();
		const payload = toSavedEconomy(record);

		const [success, result] = pcall(() =>
			store.UpdateAsync(key, (oldValue: unknown) => {
				const now = serverNow();

				if (heldByAnother(oldValue, session, now, LOCK_EXPIRY_SECONDS) !== undefined) {
					return $tuple(undefined);
				}

				return $tuple(release ? (payload as object) : stamped(payload, session, serverNow()));
			}),
		);

		if (!success) {
			logError(`[Economy] write failed for ${player.Name} (${key}): ${tostring(result)}`);

			return "failed";
		}

		if (result === undefined) return "refused";

		this.saved.set(player, HttpService.JSONEncode(payload));

		return "written";
	}

	/**
	 * Loads a record, locks it, and Ã¢â‚¬â€ once it is in Ã¢â‚¬â€ grants the default roster, publishes it, and catches any
	 * milestone it has already passed.
	 *
	 * **A failed claim leaves the player playing on a blank wallet and this session silent.** The blank record
	 * is published so the HUD and every gate read an answer, and the player joins {@link unsaveable} so those
	 * blanks can never be written over the real thing. If the reason was a lock rather than a broken store, the
	 * same flag is what stops the stale copy in memory from being written the moment the other server unlocks.
	 */
	private load(player: Player): void {
		task.spawn(() => {
			const claim = this.claim(player);

			// Gone already: nothing to publish to, and no entry worth keeping for a player who cannot return.
			if (!player.IsDescendantOf(Players)) return;

			if (!claim.ok) {
				this.records.set(player, blankEconomyRecord());
				this.unsaveable.add(player);

				logError(`[Economy] ${player.Name}: ${claim.reason} Ã¢â‚¬â€ they play on a blank wallet and this session will not save it`);
			} else {
				this.records.set(player, claim.record);
				this.saved.set(player, HttpService.JSONEncode(toSavedEconomy(claim.record)));
			}

			this.grantDefaultRoster(player);
			this.publish(player);
			this.checkMilestones(player);
		});
	}

	/**
	 * Gives the player every power in {@link POWER_ROSTER} they are not already carrying.
	 *
	 * **Everyone owns every power, and this is where that is decided.** A power is not a reward for playing
	 * Ã¢â‚¬â€ it is a thing the game is played *with* Ã¢â‚¬â€ and what was gating a player was never ownership. It was
	 * the **charge**: nothing in the game grants one outside the dev bypass, so `markHeldBall` and
	 * `activateMultiBall` refuse for every normal player and no power can be used in a round at all. The
	 * mystery box is the mechanic that makes a charge reachable, and this is the half of it that says a
	 * player has something for the box to open a window on.
	 *
	 * **Applied on every load rather than only to a new record, and that is the decision worth recording.**
	 * Seeding the roster into {@link blankEconomyRecord} looks cheaper and is ruled out by that function's
	 * own rule: `shared/economy.ts` deliberately imports no config, because it is the *shape* both ends
	 * agree on rather than the catalogue Ã¢â‚¬â€ and the roster is a catalogue entry. What is left is a check
	 * where the catalogue is already imported, and running it per load rather than per new record costs one
	 * loop over three strings and buys the part that matters: **an account already in the store before this
	 * shipped is granted on its next join**, so the mechanic works for every player rather than only for
	 * the ones who arrive after the change. It cannot double-grant, because the test is membership.
	 *
	 * **Through {@link grantPower} rather than by writing the set here, and the pool is the reason.** That
	 * method is the one door a power arrives through, and it also puts the power in the *pool* Ã¢â‚¬â€ which is
	 * what keeps this consistent with a record that predates the pool, since such a record is read as
	 * "everything owned". Writing `items` alone would produce a state the parser itself never writes:
	 * three powers owned, and a box that can grant none of them because its pool is empty.
	 *
	 * **Nothing is persisted here.** The autosave loop compares each record's serialized form against the
	 * last value it wrote, so a granted roster reaches the store on the next pass without this function
	 * knowing anything about storage Ã¢â‚¬â€ and a player who joins and leaves inside one autosave interval still
	 * keeps it, because {@link saveAndForget} writes on the way out.
	 */
	private grantDefaultRoster(player: Player): void {
		const record = this.records.get(player);
		if (record === undefined) return;

		const missing: AbilityKind[] = [];
		for (const kind of POWER_ROSTER) {
			if (!record.items.has(kind)) missing.push(kind);
		}

		if (missing.size() === 0) return;

		for (const kind of missing) this.grantPower(player, kind);

		// Printed only when something was actually added, so the line means "this account needed the
		// default" rather than appearing for every join for the rest of the game's life.
		logInfo(`[Economy] ${player.Name}: default roster granted Ã¢â‚¬â€ ${missing.join(", ")}`);
	}

	/**
	 * **Retires a record for this session, and says so once.**
	 *
	 * The single door to {@link unsaveable}, so both roads there Ã¢â‚¬â€ a failed load and a lock held elsewhere Ã¢â‚¬â€
	 * are one rule in one place. The warning names the player and says what happened, because a wallet that
	 * stops saving is the one thing in this game a player will ask about.
	 */
	private refuse(player: Player, what: string): void {
		if (this.unsaveable.has(player)) return;

		this.unsaveable.add(player);
		logError(`[Economy] ${player.Name}: ${what} Ã¢â‚¬â€ another server holds this record, so this session stops writing it`);
	}

	/**
	 * **Writes one player if their record differs from what was last written Ã¢â‚¬â€ the path every periodic and
	 * boundary save takes, and the only place the dirty test lives.**
	 *
	 * The comparison was inline in the autosave loop; it is a method now because there are three callers Ã¢â‚¬â€
	 * autosave, round end and leave.
	 *
	 * **A purchase still does not write on the spot, and that is unchanged rather than endorsed.** Opening a
	 * chest subtracts coins at `openChest`, and buying a cosmetic at `purchaseCosmetic`, and neither calls the
	 * store: the spend reaches it on the next sweep, the next round end or the leaver's write. The platform's
	 * guidance lists *"purchase processing"* as a checkpoint, so this is the one place the economy is still
	 * short of it Ã¢â‚¬â€ it is reported rather than fixed here, because a synchronous write on a player's click is a
	 * different design question (it is the one path where a failed write must be answered to the player, not
	 * swallowed) and this change is about boundaries that already exist.
	 *
	 * `why` is for the log line, and the line is the proof a boundary write happened: a round end that saved
	 * nobody and one that saved eight read identically without it.
	 */
	private flush(player: Player, why: string): void {
		const record = this.records.get(player);
		if (record === undefined) return;
		if (this.unsaveable.has(player)) return;

		if (this.saved.get(player) === HttpService.JSONEncode(toSavedEconomy(record))) return;

		const outcome = this.write(player, false);

		if (outcome === "written") {
			logInfo(`[Economy] ${player.Name}: saved ${record.coins} coins Ã¢â‚¬â€ ${why}`);

			return;
		}

		if (outcome === "refused") this.refuse(player, `writing at ${why}`);
	}

	/**
	 * A leaver's write, releasing their lock, then the in-memory rows go. Fire-and-forget: nothing waits.
	 *
	 * **The entry goes either way**: the record has been handed to the store, and a map keyed on a player who
	 * has left is a leak with nothing in it to read. **The release is why this writes at all** Ã¢â‚¬â€ a player who
	 * hops servers in the same second must not land on a wallet still locked by the server they left.
	 */
	private saveAndForget(player: Player): void {
		task.spawn(() => {
			if (this.records.has(player) && !this.unsaveable.has(player)) {
				if (this.write(player, true) === "refused") this.refuse(player, "leaving");
			}

			this.records.delete(player);
			this.saved.delete(player);
			this.unsaveable.delete(player);
		});
	}

	/**
	 * The periodic write: changed records only, which is what the `saved` map decides.
	 *
	 * Spawned per player so one slow record does not hold up the sweep, and Ã¢â‚¬â€ with the round-end flush Ã¢â‚¬â€ the
	 * reason a live server's lock never expires while a dead server's does: the interval is shorter than
	 * `LOCK_EXPIRY_SECONDS` by a whole sweep.
	 */
	private autosaveLoop(): void {
		while (true) {
			task.wait(ECONOMY_CONFIG.AUTOSAVE_INTERVAL);

			for (const [player] of this.records) {
				task.spawn(() => this.flush(player, "the autosave"));
			}
		}
	}

	/**
	 * Writes everybody out, releases their locks, and **waits for it Ã¢â‚¬â€ inside a deadline.**
	 *
	 * **Every record is written rather than only the changed ones, because this write also releases the
	 * lock.** A clean shutdown should leave every record unlocked for the next server; skipping an unchanged
	 * one would leave it locked until the expiry and gain nothing.
	 *
	 * **The bound is per write and taken from the window that is left**, which is one mechanism rather than
	 * two. A budget check (`GetRequestBudgetForRequestType`) would answer a different question Ã¢â‚¬â€ *may* I
	 * write? Ã¢â‚¬â€ and the failure this is built for is a write that is allowed and never answers, because a
	 * throttled request sits in the engine's queue and *"the called function continues to yield as long as its
	 * request is still queued"*. When the window does run out the rest are skipped **loudly**: a shutdown that
	 * runs out of time is a loss either way, and the choice left is whether it is a loss with a log.
	 */
	private saveAll(): void {
		const endsAt = os.clock() + BIND_TO_CLOSE_SECONDS;

		let written = 0;
		let skipped = 0;

		for (const [player] of this.records) {
			if (this.unsaveable.has(player)) {
				skipped++;
				continue;
			}

			const left = endsAt - os.clock();
			if (left <= 0) {
				skipped++;
				continue;
			}

			if (this.writeWithin(player, math.min(left, WRITE_DEADLINE_SECONDS))) written++;
			else skipped++;
		}

		if (LOGGING_ENABLED) {
			logInfo(`[Economy] shutdown Ã¢â‚¬â€ ${written} record(s) written, ${skipped} skipped, of ${this.records.size()}`);
		}

		if (skipped > 0) {
			logError(`[Economy] shutdown ran out of its ${BIND_TO_CLOSE_SECONDS}s window Ã¢â‚¬â€ ${skipped} record(s) not saved`);
		}
	}

	/**
	 * One shutdown write, waited for at most `seconds`. `runWithin` owns the thread-and-poll Ã¢â‚¬â€ the stats
	 * service's shutdown needs the same one Ã¢â‚¬â€ and what is left here is the part only this file knows: which
	 * player timed out, and that a refusal is the other server's lock rather than a fault.
	 */
	private writeWithin(player: Player, seconds: number): boolean {
		const outcome = runWithin(seconds, () => this.write(player, true));

		if (!outcome.ok) {
			logError(
				`[Economy] ${player.Name}: the shutdown write did not answer within ` +
					`${string.format("%.1f", seconds)}s Ã¢â‚¬â€ moved on`,
			);

			return false;
		}

		if (outcome.value === "refused") this.refuse(player, "the shutdown write");

		return outcome.value === "written";
	}
}
