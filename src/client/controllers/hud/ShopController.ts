import { Controller, OnStart } from "@flamework/core";
import Net from "@rbxts/net";
import { Button, Text } from "@rbxts/big-ui";
import Fusion from "@rbxts/fusion-3.0";
import { Players } from "@rbxts/services";
import { ABILITY_NAMES, isAbilityKind } from "shared/ability";
import type { AbilityKind } from "shared/ability";
import { COINS_ATTRIBUTE, OWNED_COSMETICS_ATTRIBUTE, OWNED_POWERS_ATTRIBUTE } from "shared/constants";
import {
	COSMETICS,
	ECONOMY_CONFIG,
	MILESTONES,
	POWER_ROSTER,
	PREMIUM_COSMETICS,
} from "shared/config/economy.config";
import type { CosmeticDef, MilestoneDef } from "shared/config/economy.config";
import { ownedCosmeticIdsOf, ownsPower } from "shared/economy";
import { events } from "shared/networking";
import { INTERMISSION, roundPhase, shopOpen } from "../../panels";
import { hudTheme } from "../../ui/hudTheme";
import type { HudTheme } from "../../ui/hudTheme";
import { getHudScreenGui } from "../../ui/screenGui";
import {
	addContentBand,
	addFooterBand,
	addGlyph,
	addGrid,
	addHeaderBand,
	addMessageLine,
	addPane,
	addPanelFrame,
	addPill,
	addTabStrip,
	addTile,
	PANEL_Z_INDEX,
	raiseZIndex,
	withCommas,
	wrapLabels,
} from "../../ui/panelChrome";

/** Prints the mount line, every tab change, every chest request, and every answer. */
const DEBUG = true;

/** How many tiles sit across a shelf. Three, because the widest shelf here holds seven. */
const COLUMNS = 3;

/**
 * The panel's three views, in the order they are worth looking at.
 *
 * **These replace the mock's five tabs, and the replacement is a mapping rather than a rewrite of the
 * idea.** The tab strip was the part of this panel that was right — a small number of named views,
 * one at a time, over a shelf of tiles — and what was wrong was what the tabs named: `Effects`,
 * `Emotes`, `Radios` and `Pets` are four things the economy has no concept of at all, and the fifth
 * (`Powers`) is a real one. So the strip keeps its structure and loses the four tabs with nothing
 * behind them, and `Powers` gains the two views the economy *does* have that the mock never did.
 *
 * **The order is the value ladder and should read that way:** what coins buy, then what playing gives,
 * then what is meant to cost Robux. See {@link addPremiumPane} for why the last of the three is a
 * catalogue with no way to buy from it yet.
 *
 * A tab carries a colour *job* rather than a colour, so the theme stays the only place a colour is
 * chosen from — `theme.colors[tab.colour]` is the whole lookup, and a tab wanting a different one
 * names a different job.
 */
const TABS = [
	{ name: "Powers", colour: "accent" },
	{ name: "Earned", colour: "success" },
	{ name: "Premium", colour: "coin" },
] as const;

type TabName = (typeof TABS)[number]["name"];

/** The client halves of the two remotes, as the declarations build them. */
type ClientRemotes = Net.Util.GetClientRemotes<Net.Util.GetDeclarationDefinitions<typeof events>>;

/**
 * What a player has to do to earn `milestone`, in one line.
 *
 * **The goal is written from `stat` and `threshold`, which is the whole of what the client can know.**
 * Nothing here is a progress figure and nothing here *can* be: see {@link addEarnedPane} for the
 * counters the server does not publish, and why this panel shows two states rather than a bar over a
 * number this machine would have to invent.
 *
 * The `crown` case reads "Wear the crown" rather than "Crown 1 time" because its threshold is not a
 * count of anything — it is the boolean being true — and a phrase with a `1` in it invites the reader
 * to look for a way to do it twice.
 */
function goalText(milestone: MilestoneDef): string {
	switch (milestone.stat) {
		case "matches":
			return milestone.threshold === 1 ? "Play 1 match" : `Play ${milestone.threshold} matches`;
		case "wins":
			return milestone.threshold === 1 ? "Win 1 match" : `Win ${milestone.threshold} matches`;
		case "hits":
			return `Land ${milestone.threshold} hits`;
		case "crown":
			return "Wear the crown";
	}
}

/** Where a cosmetic is worn, in one word — the only thing `slot` means to a player. */
function slotLabel(def: CosmeticDef): string {
	return def.slot === "trail" ? "Trail" : "Elimination";
}

/**
 * The shop: the whole economy, in one panel with three tabs.
 *
 * **The layout is the band layout it has always had** — a header, a tab strip, a shelf, and one action
 * at the bottom — because that was never the problem. What was on the shelves was: a mystery-box shop
 * with odds and rarities, a hardcoded coin figure, a Gem counter for a currency that exists nowhere,
 * and five tabs of which four named things this game has no concept of. The fix was the *contents*.
 *
 * **The chrome now lives in `client/ui/panelChrome.ts`**, because the inventory is the second panel
 * built from it, and two copies of "how tall is a name bar" is how two shelves end up 2px apart. What
 * is left here is only what is specific to this shop: which tabs it has, what a tile's status line
 * says, and what the footer does.
 *
 * **There is no button on this panel any more.** It used to own one at the top-left; that button is now
 * one of the two in the intermission dock (`DockController`), which is the only thing that opens either
 * panel. `shopOpen` in `client/panels.ts` is this panel's half of that arrangement — a value in
 * nobody's file, so neither controller has to know the other exists.
 *
 * **The panel is visible when it is open *and* the phase is between rounds**, the same two facts the
 * dock reads. That is deliberate: a round starting closes the dock, and a panel left over the game with
 * its only button gone would be a window a player could not shut without hunting for the small `X`.
 *
 * **Everything is built once and only properties change afterwards.** big-ui components take their
 * contents at construction, so a pane that repopulated itself on a tab click would be torn down and
 * rebuilt every time. Three static shelves and a computed `Visible` each is simpler and cheaper than
 * either; what changes reactively is the text and colour of what was built, through the values
 * {@link watchPlayer} fills and the `Fusion.Computed`s the tiles hydrate.
 */
@Controller()
export class ShopController implements OnStart {
	private scope = Fusion.scoped();
	private mounted = false;

	/** Which of the three views is showing. `Powers` first, because it is the one to act on. */
	private currentTab = Fusion.Value<TabName>(this.scope, "Powers");

	/**
	 * The player's wallet, as a number.
	 *
	 * **A `Value` fed from the attribute's changed signal, rather than a `GetAttribute` inside a
	 * `Computed`.** A `Computed` derives its dependencies from the reads that actually ran, and an
	 * attribute read is a *sample* rather than a subscription — so a label built straight on
	 * `GetAttribute` draws once and never again, which for a balance is the most visible failure this
	 * panel could have. The bridge is the shape `StatsBillboardController` uses for the same reason.
	 */
	private coins = Fusion.Value(this.scope, 0);

	/** The `OWNED_POWERS_ATTRIBUTE` string, verbatim. Read through `ownsPower`. */
	private powers = Fusion.Value(this.scope, "");

	/** The `OWNED_COSMETICS_ATTRIBUTE` string, verbatim. Read through `ownedCosmeticIdsOf`. */
	private cosmetics = Fusion.Value(this.scope, "");

	/** The power the last chest granted, or `""`. */
	private chestGranted = Fusion.Value(this.scope, "");

	/**
	 * The server's own sentence for the last refusal, or `""`.
	 *
	 * **Kept verbatim and never reworded on the way to the screen.** "not enough coins", "all powers
	 * collected" and "your record is still loading" are three different situations with three different
	 * answers, and they are the strings the handler sends. A paraphrase here would be a second copy of
	 * the server's vocabulary, free to drift from the one that decides whether the chest opens — and the
	 * copy on screen is the one a player would believe.
	 */
	private chestReason = Fusion.Value(this.scope, "");

	/**
	 * The chest request, resolved once at mount.
	 *
	 * `Get` **yields** until the server's remote exists, so it is resolved from `watchChest` — which
	 * runs inside `mount`'s `task.spawn` — rather than from the button's click handler, where a yield
	 * would be a frame of nothing happening after a press.
	 */
	private chestRemote?: ClientRemotes["openPowerChest"];

	onStart(): void {
		// Spawned rather than done inline, matching the other HUDs: mounting waits for `PlayerGui`, and
		// a controller's `onStart` is the wrong place to hold up the rest of the client's boot.
		task.spawn(() => this.mount());
	}

	private mount(): void {
		if (this.mounted) return;
		this.mounted = true;

		const theme = hudTheme();

		print("[Shop] panel up — Powers (coins) · Earned (milestones) · Premium (catalogue)");

		const panel = addPanelFrame(
			this.scope,
			theme,
			"ShopPanel",
			Fusion.Computed(this.scope, (use) => use(shopOpen) && use(roundPhase) === INTERMISSION),
		);

		const right = addHeaderBand(this.scope, theme, panel, 1, "Shop", () => shopOpen.set(false));
		this.addBalancePill(right, theme);

		addTabStrip(this.scope, theme, panel, 2, TABS, this.currentTab, (name) => {
			if (DEBUG) print(`[Shop] tab: ${name}`);
		});

		const content = addContentBand(this.scope, panel, 3);
		this.addPowersPane(content, theme);
		this.addEarnedPane(content, theme);
		this.addPremiumPane(content, theme);

		this.addFooter(panel, theme);

		raiseZIndex(panel, PANEL_Z_INDEX);
		wrapLabels(panel);

		panel.Parent = getHudScreenGui(); // must stay the LAST statement in this method

		// After the tree, because both of these write into values the tree is already reading. Doing it
		// first would draw a frame of "no coins, nothing owned" on every mount — a lie the player would
		// see, rather than a detail they would not.
		this.watchPlayer();
		this.watchChest();
	}

	/**
	 * The live balance: a coin and a number, from the same attribute `CurrencyHudController` draws.
	 *
	 * Both sides of it come from the theme, including the coin's own amber, so this pill and the
	 * readout under the dock say the same thing in the same colour.
	 */
	private addBalancePill(parent: Frame, theme: HudTheme): void {
		const pill = addPill(this.scope, theme, parent, 1);
		addGlyph(this.scope, theme.colors.coin, pill, 1);

		const amount = Text(this.scope, {
			text: Fusion.Computed(this.scope, (use) => withCommas(use(this.coins))),
			variant: "body2",
			wrap: false,
		});
		amount.TextColor3 = theme.colors.coin;
		amount.Size = UDim2.fromOffset(0, 0);
		amount.AutomaticSize = Enum.AutomaticSize.XY;
		amount.LayoutOrder = 2;
		amount.Parent = pill;
	}

	// ---------- tab 1: powers ----------

	/**
	 * Powers, bought with coins: the roster as a shelf, the chest in the footer.
	 *
	 * **This pane is the answer to the first question a new player asks.** `BallService` refuses an
	 * unowned power at the key, with a print on the *server* — `[Super] … not owned` — and this is the
	 * only place on the client that says so. A player pressing `3` and seeing nothing happen cannot tell
	 * "locked" from "broken", and from the outside those two look identical, so the roster is rendered
	 * in full with every entry marked.
	 */
	private addPowersPane(content: Frame, theme: HudTheme): void {
		const pane = addPane(
			this.scope,
			content,
			"Powers",
			1,
			Fusion.Computed(this.scope, (use) => use(this.currentTab) === "Powers"),
		);
		const grid = addGrid(this.scope, pane, COLUMNS, POWER_ROSTER.size());

		POWER_ROSTER.forEach((kind, index) => {
			const tile = addTile(this.scope, grid, theme, ABILITY_NAMES[kind], index, true);

			Fusion.Hydrate(this.scope, tile.statusLabel)({
				Text: Fusion.Computed(this.scope, (use) =>
					ownsPower(use(this.powers), kind) ? "Owned" : "Locked",
				),
				TextColor3: Fusion.Computed(this.scope, (use) =>
					ownsPower(use(this.powers), kind) ? theme.colors.success : theme.colors.textDisabled,
				),
			});
		});
	}

	// ---------- tab 2: earned ----------

	/**
	 * Milestones: free, and never for sale.
	 *
	 * **Two states rather than a progress bar, and that is a missing data source rather than a design
	 * preference.** A tile reading "4/25 wins" needs the player's *current* win count on the client, and
	 * there is no such attribute: `EconomyService` keeps `matches` and `wins` inside its private record
	 * and publishes neither, and of the four counters only `hits` exists as one (`StatsService`'s
	 * lifetime `Stat_HITS`). Drawing a fraction would mean counting wins on this machine — a second,
	 * client-side copy of a number the server owns and acts on, free to disagree with the server that
	 * actually hands the cosmetic over. So a tile shows the goal and whether it is met, and a progress
	 * figure waits for the server to publish the counters it already has.
	 *
	 * What *can* be shown honestly is ownership, because `OWNED_COSMETICS_ATTRIBUTE` is the server's own
	 * answer — and since the server grants on reaching the threshold, "owned" and "earned" are the same
	 * fact. There is no third "reached but pending" state to draw.
	 */
	private addEarnedPane(content: Frame, theme: HudTheme): void {
		const pane = addPane(
			this.scope,
			content,
			"Earned",
			2,
			Fusion.Computed(this.scope, (use) => use(this.currentTab) === "Earned"),
		);
		const grid = addGrid(this.scope, pane, COLUMNS, MILESTONES.size());

		MILESTONES.forEach((milestone, index) => {
			const cosmetic: CosmeticDef | undefined = COSMETICS[milestone.cosmeticId];
			const reward = cosmetic !== undefined ? cosmetic.name : milestone.cosmeticId;

			const tile = addTile(this.scope, grid, theme, milestone.name, index, true);

			// The name bar carries the achievement and the status line carries the reward *and* the goal,
			// so a tile says what a player gets as well as what they have to do for it.
			Fusion.Hydrate(this.scope, tile.statusLabel)({
				Text: Fusion.Computed(this.scope, (use) =>
					ownedCosmeticIdsOf(use(this.cosmetics)).has(milestone.cosmeticId)
						? `${reward} · Earned`
						: `${reward} · ${goalText(milestone)}`,
				),
				TextColor3: Fusion.Computed(this.scope, (use) =>
					ownedCosmeticIdsOf(use(this.cosmetics)).has(milestone.cosmeticId)
						? theme.colors.success
						: theme.colors.textSecondary,
				),
			});
		});
	}

	// ---------- tab 3: premium ----------

	/**
	 * The premium catalogue — and **nothing on this shelf can be bought, which the panel says.**
	 *
	 * **There is no purchase path in this project at all.** No `MarketplaceService`, no prompt, no
	 * ownership check, no grant: a Buy button would take a player's Robux and hand back nothing, because
	 * no server code is listening for the answer. A half-path that charges is worse than a shelf
	 * labelled "not yet", so the tiles carry their price and their state and nothing here is clickable.
	 *
	 * **Every `gamepassId` in the config is `0` today too**, so even a prompt could not be aimed: the ids
	 * have to exist in the creator dashboard first. Those two facts together are why the status line is a
	 * statement rather than an apology.
	 */
	private addPremiumPane(content: Frame, theme: HudTheme): void {
		const pane = addPane(
			this.scope,
			content,
			"Premium",
			3,
			Fusion.Computed(this.scope, (use) => use(this.currentTab) === "Premium"),
		);
		const grid = addGrid(this.scope, pane, COLUMNS, PREMIUM_COSMETICS.size());

		PREMIUM_COSMETICS.forEach((def, index) => {
			const tile = addTile(this.scope, grid, theme, def.name, index, true);

			Fusion.Hydrate(this.scope, tile.statusLabel)({
				// Owned wins over the not-yet notice: once a grant path exists, an item a player already
				// has must stop advertising itself as unbuyable, and the attribute is already the honest
				// source for that answer.
				Text: Fusion.Computed(this.scope, (use) => {
					const price = `${slotLabel(def)} · ${withCommas(def.priceRobux)} R$`;
					return ownedCosmeticIdsOf(use(this.cosmetics)).has(def.id)
						? `${price} · Owned`
						: `${price} · Not yet purchasable`;
				}),
				TextColor3: Fusion.Computed(this.scope, (use) =>
					ownedCosmeticIdsOf(use(this.cosmetics)).has(def.id)
						? theme.colors.success
						: theme.colors.textDisabled,
				),
			});
		});
	}

	// ---------- footer ----------

	/**
	 * The one action the panel has, in the band the old layout kept for it.
	 *
	 * **The footer button is the chest, and its state is the whole of what this panel can do.** The mock
	 * put `OPEN BOX` here and showed it only when a box was open; this shows the chest while the Powers
	 * tab is up and there is still a power to win, and swaps itself for a line saying the roster is
	 * complete when there is not.
	 *
	 * **The outcome line lives here rather than on the shelf** because it is about the action, and
	 * because a shelf of fixed tiles is the one place in this panel with no room for a sentence of
	 * variable length. A grant names the power; a refusal is the server's `reason` string exactly as it
	 * arrives.
	 *
	 * `Visible` toggles rather than big-ui's `disabled` prop, and that is forced: big-ui reads its props
	 * at construction, so a `disabled` decided at build time could never react to the last chest being
	 * opened. A button that stays lit and refuses is worse than no button at all.
	 */
	private addFooter(panel: Frame, theme: HudTheme): void {
		const footer = addFooterBand(this.scope, panel, 4);

		const outcome = addMessageLine(this.scope, theme, footer, 1);
		outcome.Name = "ChestOutcome";
		Fusion.Hydrate(this.scope, outcome)({
			Text: Fusion.Computed(this.scope, (use) => {
				// Both reads first, unconditionally — a read inside a branch is a subscription that only
				// exists while that branch is taken. See `RoundStatusController`.
				const granted = use(this.chestGranted);
				const reason = use(this.chestReason);

				if (reason !== "") return reason;
				if (granted !== "" && isAbilityKind(granted)) return `You unlocked ${ABILITY_NAMES[granted]}!`;
				return "";
			}),
			TextColor3: Fusion.Computed(this.scope, (use) =>
				use(this.chestReason) !== "" ? theme.colors.warning : theme.colors.success,
			),
			Visible: Fusion.Computed(
				this.scope,
				(use) => use(this.chestGranted) !== "" || use(this.chestReason) !== "",
			),
		});

		const complete = addMessageLine(this.scope, theme, footer, 2);
		complete.Name = "ChestComplete";
		complete.Text = "All powers collected.";
		complete.TextColor3 = theme.colors.success;
		Fusion.Hydrate(this.scope, complete)({
			Visible: Fusion.Computed(
				this.scope,
				(use) => use(this.currentTab) === "Powers" && this.unownedPowers(use(this.powers)).size() === 0,
			),
		});

		const open = Button(this.scope, {
			label: `Open chest · ${withCommas(ECONOMY_CONFIG.CHEST_COST)} coins`,
			variant: "contained",
			color: "primary",
			size: "large",
			fullWidth: true,
			layoutOrder: 3,
			onActivate: () => this.requestChest(),
		});
		open.Name = "OpenChestButton";
		open.Parent = footer;
		Fusion.Hydrate(this.scope, open)({
			Visible: Fusion.Computed(
				this.scope,
				(use) => use(this.currentTab) === "Powers" && this.unownedPowers(use(this.powers)).size() > 0,
			),
		});
	}

	// ---------- server contact ----------

	/** Asks for a chest. The whole of what this panel can ask the server to do. */
	private requestChest(): void {
		if (DEBUG) print("[Shop] asked for a Power Chest");

		// Cleared first, so a refusal cannot be read as the answer to the *previous* request while this
		// one is in flight. Nothing on the wire says which reply belongs to which press, and the only
		// thing worse than "not enough coins" is "not enough coins" left over from a minute ago.
		this.chestGranted.set("");
		this.chestReason.set("");

		this.chestRemote?.SendToServer();
	}

	/** The powers this player does not own, from an `OWNED_POWERS_ATTRIBUTE` string. */
	private unownedPowers(owned: string): AbilityKind[] {
		return POWER_ROSTER.filter((kind) => !ownsPower(owned, kind));
	}

	/**
	 * Bridges the three attributes into `Fusion` values.
	 *
	 * **A connection per attribute plus one read, which is `StatsBillboardController`'s shape and for its
	 * reason**: an attribute read inside a `Computed` is a sample rather than a dependency, so the value
	 * has to be pushed in from the changed signal for anything drawing it to update.
	 *
	 * The opening read is not redundant with the connections. A player who already has coins when this
	 * mounts — every player after their first match, and every player in Studio where the module reloads
	 * under a live session — would otherwise see zero until something *changed*, and an attribute that is
	 * already correct never fires a signal.
	 */
	private watchPlayer(): void {
		const player = Players.LocalPlayer;

		const readCoins = () => {
			const value = player.GetAttribute(COINS_ATTRIBUTE);
			this.coins.set(typeIs(value, "number") ? value : 0);
		};

		const readPowers = () => {
			const value = player.GetAttribute(OWNED_POWERS_ATTRIBUTE);
			this.powers.set(typeIs(value, "string") ? value : "");
		};

		const readCosmetics = () => {
			const value = player.GetAttribute(OWNED_COSMETICS_ATTRIBUTE);
			this.cosmetics.set(typeIs(value, "string") ? value : "");
		};

		this.scope.push(player.GetAttributeChangedSignal(COINS_ATTRIBUTE).Connect(readCoins));
		this.scope.push(player.GetAttributeChangedSignal(OWNED_POWERS_ATTRIBUTE).Connect(readPowers));
		this.scope.push(player.GetAttributeChangedSignal(OWNED_COSMETICS_ATTRIBUTE).Connect(readCosmetics));

		readCoins();
		readPowers();
		readCosmetics();
	}

	/**
	 * Takes the chest's answer, and resolves the request remote.
	 *
	 * **This is the first consumer `chestResult` has ever had.** The remote was declared, wired and
	 * compiled with nothing on the client listening, so no reply had been drawn anywhere before this —
	 * and a live log has since shown the whole round trip working (a press, then `not enough coins`
	 * verbatim), which leaves only the success branch unobserved: it needs a wallet with 50 coins in it.
	 *
	 * `Get` yields, which is why the whole of this runs from `mount`'s `task.spawn` rather than inline —
	 * the same note `RoundResultController` makes about its own subscription.
	 */
	private watchChest(): void {
		this.chestRemote = events.Client.Get("openPowerChest");

		this.scope.push(
			events.Client.Get("chestResult").Connect((granted, reason) => {
				// The wire is not typed, so what arrives is checked rather than trusted — the treatment
				// every other handler in this client gives a string off a remote.
				const grantedText = typeIs(granted, "string") ? granted : "";
				const reasonText = typeIs(reason, "string") ? reason : "";

				this.chestGranted.set(grantedText);
				this.chestReason.set(reasonText);

				if (DEBUG) {
					print(
						`[Shop] chest replied — granted "${grantedText}", reason "${reasonText}"` +
							` (coins now ${Fusion.peek(this.coins)})`,
					);
				}
			}),
		);
	}
}
