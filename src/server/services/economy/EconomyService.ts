import { OnStart, Service } from "@flamework/core";
import { DataStoreService, HttpService, Players } from "@rbxts/services";
import { AbilityKind } from "shared/ability";
import {
	COINS_ATTRIBUTE,
	CROWN_ATTRIBUTE,
	OWNED_COSMETICS_ATTRIBUTE,
	OWNED_POWERS_ATTRIBUTE,
	STAT_HITS,
} from "shared/constants";
import {
	ECONOMY_CONFIG,
	MILESTONES,
	POWER_ROSTER,
	COSMETICS,
	CosmeticDef,
	MilestoneDef,
} from "shared/config/economy.config";
import {
	EconomyRecord,
	blankEconomyRecord,
	toEconomyRecord,
	toSavedEconomy,
	joinPowers,
	joinCosmeticIds,
	EQUIPPED_ATTRIBUTE,
} from "shared/economy";
import { events } from "shared/networking";
import { DevService } from "../../dev/DevService";
import { DRAW, RoundOutcome, TeamLabel } from "../round/team";

/** Prints one line per grant, chest, milestone and round-end payout. */
const DEBUG = true;

/**
 * The economy: one coin, one chest, a roster of owned powers, a set of owned cosmetics, and the two
 * milestone counters. All of it persists under one DataStore key per player.
 *
 * **Why one service holds the whole wallet.** The design is deliberately small — coins buy Powers and
 * nothing else, milestones award a fixed set of cosmetics, and Robux buys the premium catalog — so a
 * single record per player is the whole economy. Splitting it into a coin service, a power service and
 * a cosmetic service would be three DataStores, three loaders and three chances for one of them to be
 * out of step with the other two.
 *
 * **Coins are a wallet, not a score.** They are written here and nowhere else, they persist, and they
 * are clamped to at least nought on every write — the one number in the game that must never read as a
 * debt. The earn rules (base, win bonus, performance cap) live in {@link ECONOMY_CONFIG} and are applied
 * by {@link onRoundEnded}, which `RoundService` calls exactly once per finished round.
 *
 * **Powers and cosmetics are owned sets, packed into attributes.** What is owned is permanent and is
 * published on the player as two `|`-joined strings — see `OWNED_POWERS_ATTRIBUTE` — so the client
 * reads them with no remote, and the server is the only writer. A power a player does not own is a word
 * absent from the string, and that is the whole of the lock: `BallService` asks {@link ownsPower} before
 * it honours a key.
 *
 * **Milestones are checked, not tracked separately.** The counters here are `matches` and `wins`; hits
 * come from `StatsService`'s lifetime `STAT_HITS`, and the crown milestone reads `CROWN_ATTRIBUTE`. One
 * method — {@link checkMilestones} — runs after a load, after every round, and when the crown flips on,
 * and grants whatever has been newly reached. There is deliberately no per-milestone state to save.
 */
@Service()
export class EconomyService implements OnStart {
	/** The live records; a player is absent while their record is still loading (or after they leave). */
	private readonly records = new Map<Player, EconomyRecord>();

	/** The last value written for each player, serialized, so an unchanged record is never written twice. */
	private readonly saved = new Map<Player, string>();

	private cachedStore?: DataStore;

	constructor(private readonly dev: DevService) {}

	public onStart(): void {
		Players.PlayerAdded.Connect((player) => this.load(player));
		Players.PlayerRemoving.Connect((player) => this.saveAndForget(player));
		for (const player of Players.GetPlayers()) this.load(player);

		// The one save that is waited for: everything else is a periodic or leaver write.
		game.BindToClose(() => this.saveAll());

		task.spawn(() => this.autosaveLoop());

		// The crown is the one milestone whose trigger is a flag, not a count — so it is watched here
		// rather than read from a counter at round end. A crown earned before the record loaded is caught
		// by the check that follows the load.
		Players.PlayerAdded.Connect((player) => {
			player.GetAttributeChangedSignal(CROWN_ATTRIBUTE).Connect(() => this.checkMilestones(player));
		});

		// The two things a client can ask the economy to do: open a chest, and wear something. Both are
		// requests rather than values — see `equipCosmetic` for why the client never gets to say what it
		// owns, and `openChest` for why the chest is the one that needs a reply.
		events.Server.OnEvent("openPowerChest", (player) => this.openChest(player));
		events.Server.OnEvent("equipCosmetic", (player, slot, id) => this.equipCosmetic(player, slot, id));

		// Dev shortcuts, so the loop can be exercised from a standing start.
		this.dev.onCommand("coins", (player) => {
			this.addCoins(player, 1000);
			print(`[Economy] ${player.Name}: +1000 coins (dev)`);
		});
		this.dev.onCommand("powers", (player) => {
			for (const kind of POWER_ROSTER) this.grantPower(player, kind);
			print(`[Economy] ${player.Name}: granted the full roster (dev)`);
		});

		if (DEBUG) {
			print(
				`[Economy] up — ${POWER_ROSTER.size()} powers, ${MILESTONES.size()} milestones, ` +
					`chest ${ECONOMY_CONFIG.CHEST_COST} coins`,
			);
		}
	}

	/**
	 * The payout at the end of a round, for everyone who was there.
	 *
	 * **Called once per finished round by `RoundService.finishRound`**, after the winner is decided and
	 * the result board is out — so the numbers it reads are the round's final ones, not a moving count.
	 * It grants the base to everyone, the win bonus to the winning side, and a capped performance bonus
	 * from the round's hits; then it counts the match and the win, and checks the milestone table.
	 *
	 * **A draw grants the base and the performance bonus but no win.** There is nothing to win, but a
	 * match was played and hits were thrown, and both are still worth something.
	 *
	 * **A player whose record has not loaded is skipped rather than guessed at.** The alternative —
	 * holding a grant in a queue and replaying it when the record arrives — is the kind of machinery a
	 * solo economy should not carry; a DataStore that has not answered inside a round is already the
	 * worse failure, and dropping one round's coins is the honest, small loss next to it.
	 */
	public onRoundEnded(
		outcome: RoundOutcome,
		teams: ReadonlyMap<Player, TeamLabel>,
		roundHits: ReadonlyMap<Player, number>,
	): void {
		for (const player of Players.GetPlayers()) {
			const record = this.records.get(player);
			if (record === undefined) continue;

			let coins: number = ECONOMY_CONFIG.MATCH_BASE_COINS;

			if (outcome !== DRAW && teams.get(player) === outcome) {
				coins += ECONOMY_CONFIG.MATCH_WIN_BONUS;
			}

			// One coin per hit, up to the cap — the reward for *contributing*, kept small and bounded so
			// a dominant player cannot convert one good round into a wallet ahead of everyone else.
			coins += math.min(roundHits.get(player) ?? 0, ECONOMY_CONFIG.PERFORMANCE_COIN_CAP);
			coins = math.min(coins, ECONOMY_CONFIG.MATCH_COIN_CAP);

			record.coins += coins;
			record.matches += 1;
			if (outcome !== DRAW && teams.get(player) === outcome) record.wins += 1;

			this.publish(player);

			if (DEBUG) print(`[Economy] ${player.Name}: +${coins} coins (${record.coins})`);

			this.checkMilestones(player);
		}
	}

	/** Whether `player` owns `kind`, the one fact `BallService` asks before honouring a key. */
	public ownsPower(player: Player, kind: AbilityKind): boolean {
		return this.records.get(player)?.powers.has(kind) ?? false;
	}

	/**
	 * Wears `id` in `slot`, or clears the slot back to the default when `id` is empty.
	 *
	 * **Everything is checked here, and nothing is taken from the caller's word.** This is reached
	 * straight from an untyped wire, so the order below is the whole of the security rather than a
	 * formality — and the order is deliberately *structural first, expensive second*:
	 *
	 * 1. **`slot` must be a string, and one this build publishes** — `EQUIPPED_ATTRIBUTE`'s own keys. It is
	 *    first because it is the cheapest check and because every check after it is a lookup keyed by the
	 *    slot.
	 * 2. **`id` must be a string.** Anything else is dropped without a reply.
	 * 3. **The record must be loaded.** A player whose `GetAsync` has not answered has no record to write,
	 *    and the request is dropped rather than queued — the same call `onRoundEnded` makes for the same
	 *    reason: a store that has not answered is already the worse failure, and a queue is machinery a
	 *    solo economy should not carry.
	 * 4. **An empty `id` is valid and means the default.** It clears the slot and stops there, because
	 *    there is no catalogue entry to check it against — see `EQUIPPED_TRAIL_ATTRIBUTE` for why `""`
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
	 * **Silent on refusal, on purpose.** All five refusals are "that request was not valid" — a correct
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

		if (DEBUG) print(`[Economy] ${player.Name}: ${slot} equipped ${id === "" ? "(default)" : id}`);
	}

	/**
	 * The trail colours `player` has equipped, or nothing for the default red.
	 *
	 * **The server answering a question the server asked.** `BallService.attachToHand` calls this on the
	 * way to `BallTrail.attach`, and it reads the *record* rather than the attribute for
	 * {@link equipCosmetic}'s reason: the attribute is a rendering copy, and a ball's appearance is not
	 * something a client gets to assert.
	 *
	 * **`undefined` is the common answer and three different situations give it** — no player at all (an
	 * NPC rig, or a body with no `Player` behind it), nothing equipped in the slot, and an equipped id
	 * this build no longer catalogues. All three mean "the default", so they are deliberately not told
	 * apart: the caller has one question and wants one answer.
	 *
	 * **It returns the def's own `colors`, which is `undefined` for every elimination cosmetic and for
	 * every cosmetic with no colours at all** — so equipping one changes nothing yet, which is honest
	 * rather than broken. See `COSMETICS` and the note there on the render hook.
	 */
	public equippedTrailColors(player: Player | undefined): CosmeticDef["colors"] {
		if (player === undefined) return undefined;

		const id = this.records.get(player)?.equipped.get("trail");
		if (id === undefined) return undefined;

		const def = COSMETICS[id];
		if (def === undefined || def.slot !== "trail") return undefined;

		return def.colors;
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
	 * last remaining power is therefore a guarantee — the anticlimax the design accepts in exchange for
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

		const unowned = POWER_ROSTER.filter((kind) => !record.powers.has(kind));
		if (unowned.size() === 0) {
			this.sendChestResult(player, "", "all powers collected");
			return;
		}

		const granted = unowned[math.random(unowned.size()) - 1];

		record.coins -= ECONOMY_CONFIG.CHEST_COST;
		record.powers.add(granted);
		this.publish(player);

		if (DEBUG) {
			print(`[Economy] ${player.Name}: chest granted ${granted} — ${record.coins} coins left`);
		}

		this.sendChestResult(player, granted, "");
	}

	/** Grants a power outright — the dev command's door, and the only bypass to the chest. */
	public grantPower(player: Player, kind: AbilityKind): void {
		const record = this.records.get(player);
		if (record === undefined) return;

		record.powers.add(kind);
		this.publish(player);
	}

	/** Adds coins outright — the dev command's door. Clamped to at least nought. */
	public addCoins(player: Player, amount: number): void {
		const record = this.records.get(player);
		if (record === undefined) return;

		record.coins = math.max(0, record.coins + amount);
		this.publish(player);
	}

	/**
	 * Grants every milestone the player has newly reached, and nothing more.
	 *
	 * **The one place a milestone is decided**, so the three moments that can change an answer — the
	 * load, the end of a round, the crown flipping on — all call this and nowhere else has the rule. A
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

			if (DEBUG) {
				const cosmetic = COSMETICS[milestone.cosmeticId];
				print(`[Economy] ${player.Name}: milestone ${milestone.id} — earned ${cosmetic?.name ?? milestone.cosmeticId}`);
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
	 * `SetAttribute` calls on a change that already writes three, and the alternative — writing only the
	 * slot that moved — would leave a client that joined between two changes with no attribute to read
	 * at all.
	 *
	 * The slot table is walked rather than the two names being spelled out here and read again in the
	 * panel: {@link EQUIPPED_ATTRIBUTE} is the one place the pairing is written down, so a third slot is
	 * one line in that file and nothing here.
	 */
	private publish(player: Player): void {
		const record = this.records.get(player);
		if (record === undefined) return;

		player.SetAttribute(COINS_ATTRIBUTE, record.coins);
		player.SetAttribute(OWNED_POWERS_ATTRIBUTE, joinPowers(record.powers));
		player.SetAttribute(OWNED_COSMETICS_ATTRIBUTE, joinCosmeticIds(record.cosmetics));

		for (const [slot, attribute] of pairs(EQUIPPED_ATTRIBUTE)) {
			player.SetAttribute(attribute, record.equipped.get(slot) ?? "");
		}
	}

	/** The chest's answer, to the player who asked. */
	private sendChestResult(player: Player, granted: string, reason: string): void {
		events.Server.Get("chestResult").SendToPlayer(player, granted, reason);
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
			warn(`[Economy] could not open ${ECONOMY_CONFIG.DATASTORE_NAME}: ${tostring(result)}`);
			return undefined;
		}

		this.cachedStore = result as DataStore;
		return this.cachedStore;
	}

	/** One read; `undefined` on any failure, which the caller turns into a blank record. */
	private fetch(key: string): unknown {
		const store = this.store();
		if (store === undefined) return undefined;

		const [success, result] = pcall(() => store.GetAsync(key));
		return success ? result : undefined;
	}

	/** One write, serializing the record to its plain-table form. Answers whether it was written. */
	private write(player: Player): boolean {
		const record = this.records.get(player);
		if (record === undefined) return false;

		const store = this.store();
		if (store === undefined) return false;

		const payload = toSavedEconomy(record);
		const [success] = pcall(() => store.SetAsync(this.key(player), payload));
		if (success) this.saved.set(player, HttpService.JSONEncode(payload));

		return success;
	}

	/** Loads a record and, once it is in, publishes it and catches any milestone it has already passed. */
	private load(player: Player): void {
		task.spawn(() => {
			const record = toEconomyRecord(this.fetch(this.key(player)));
			this.records.set(player, record);
			this.publish(player);
			this.checkMilestones(player);
		});
	}

	/** A leaver's write, then the in-memory rows go. Fire-and-forget: nothing waits for a leaver. */
	private saveAndForget(player: Player): void {
		task.spawn(() => {
			this.write(player);
			this.records.delete(player);
			this.saved.delete(player);
		});
	}

	/** The periodic write: changed records only, which is what the `saved` map decides. */
	private autosaveLoop(): void {
		while (true) {
			task.wait(ECONOMY_CONFIG.AUTOSAVE_INTERVAL);

			for (const [player, record] of this.records) {
				const payload = HttpService.JSONEncode(toSavedEconomy(record));
				if (this.saved.get(player) === payload) continue;

				this.write(player);
			}
		}
	}

	/** The shutdown write, waited for by `BindToClose`. */
	private saveAll(): void {
		this.records.forEach((record, player) => this.write(player));
	}
}
