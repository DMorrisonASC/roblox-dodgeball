import { Controller, OnStart } from "@flamework/core";
import Net from "@rbxts/net";
import { Button, Text } from "@rbxts/big-ui";
import Fusion from "@rbxts/fusion-3.0";
import { SoundService, ContentProvider, Players } from "@rbxts/services";
import { ABILITY_NAMES, isAbilityKind } from "shared/ability";
import { COINS_ATTRIBUTE, OWNED_COSMETICS_ATTRIBUTE, OWNED_ITEMS_ATTRIBUTE } from "shared/constants";
import { AUDIO_CONFIG } from "shared/config/audio.config";
import { CHEST_POOL, ECONOMY_CONFIG, POWER_ROSTER, PREMIUM_COSMETICS, PURCHASE_COSMETICS } from "shared/config/economy.config";
import type { ChestItem, CosmeticDef } from "shared/config/economy.config";
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
 * The panel's two views.
 *
 * **`Earned` is gone, and its content was deleted rather than moved.** It was a shelf of achievement tiles
 * whose whole content was "what you get" and "what you have to do for it" — and the Inventory now says both
 * of those on the tile of the cosmetic itself, as an `Unlock by …` line on the item the player is looking at.
 * Two places to read one condition are two places to keep in step, and the Inventory's is the one standing
 * next to the thing it describes. See `InventoryController.unlockText`.
 *
 * **`Premium` became `Cosmetics`, because the tab stopped being about a price tier.** It renders the premium
 * catalogue today, because that is the only buyable set that exists — but what it is *for* is "cosmetics you
 * could buy", so the day a cosmetic is bought some other way it belongs on this shelf without the tab being
 * renamed a second time. The words on the tiles are where the price is said.
 *
 * **The order puts the catalogue first and the action second, which reverses the old ladder.** The old order
 * was "what coins buy, then what playing gives, then what costs Robux"; with the middle one gone, the only
 * thing left to order is a shelf with nothing to press and a button that spends coins — and a player looking
 * for the chest should not have to read past a catalogue to find it.
 *
 * **The filled tab is the selected one, and nothing else says so.** The strip used to hand each tab a colour
 * *job* for its outline, and that is gone from the builder along with every other line on a tab: two of the
 * jobs this shop asked for are the same palette value, and a saturated colour is the wrong tool for a 2px
 * edge either way. What is left is the fill inverting, which is the one signal that reads across a row of
 * five at a glance — see `addTabStrip`.
 */
const TABS = [{ name: "Cosmetics" }, { name: "Power & Items" }] as const;

type TabName = (typeof TABS)[number]["name"];

/** The client halves of the two remotes, as the declarations build them. */
type ClientRemotes = Net.Util.GetClientRemotes<Net.Util.GetDeclarationDefinitions<typeof events>>;

/**
 * Where a cosmetic is worn, in one word — the only thing `slot` means to a player.
 *
 * **Branch by branch rather than a ternary, and that is a correction rather than a style.** This used to
 * read `def.slot === "trail" ? "Trail" : "Elimination"`, which was right for exactly as long as the union
 * had two members: the moment `"ball"` joined it, every ball cosmetic would have been labelled an
 * elimination, silently, with no compile error to catch it. Spelling each slot out means a new member
 * arrives here as a missing branch a reader can see rather than as the wrong word on a shelf.
 */
function slotLabel(def: CosmeticDef): string {
	if (def.slot === "trail") return "Trail";
	if (def.slot === "elimination") return "Elimination";

	return "Ball";
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

	/**
	 * Which of the two views is showing.
	 *
	 * **`Power & Items` first, because it is the one to act on.** The old seed was `Powers` for the same
	 * reason — the tab a player opened the panel for is the one with the button, and the catalogue is
	 * something to look at rather than something to do. TABS puts the catalogue first because that is the
	 * reading order; this puts the chest up because that is the *opening* order, and the two are allowed to
	 * differ.
	 */
	private currentTab = Fusion.Value<TabName>(this.scope, "Power & Items");

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

	/**
	 * The `OWNED_ITEMS_ATTRIBUTE` string, verbatim. Read through `ownsPower`, which narrows it to the one
	 * power a chest entry names — the attribute itself holds everything owned.
	 */
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

	/**
	 * The purchase request, resolved once at mount — `chestRemote`'s sibling, and its `Get` yields for the
	 * same reason the chest's does, which is why it too is resolved from a watcher inside `mount`'s spawn.
	 */
	private purchaseRemote?: ClientRemotes["purchaseCosmetic"];

	/**
	 * The chest's award sound, one instance for the whole session.
	 *
	 * **One `Sound`, made once and reused, in `SoundService`** — the three decisions `elevation.ts` makes about
	 * the two interface tones, for the reasons written there: a `Sound` per award is an instance per press with
	 * an owner, and a `Sound` parented to a `BasePart` or an `Attachment` is *positional*, which a chest opening
	 * inside a panel is not. `PlayerGui` would be non-positional too and is the worse of the two, because it is
	 * torn down and rebuilt on every respawn — an instance made once for the session must not be sitting inside
	 * something that gets replaced.
	 *
	 * **Built with the panel rather than lazily on the first award**, which is where this deliberately differs
	 * from those two tones: hover feedback fires a few hundred milliseconds after the pointer arrives, on a shelf
	 * that may never be looked at, so lazy is right there. This one fires when a server round trip has *already*
	 * been waited for, and a clip that only began loading at that moment would arrive after the sentence it
	 * belongs to. The cost is one `Sound` in `SoundService` for every client, whether or not they open a chest.
	 */
	private awardSound?: Sound;

	onStart(): void {
		// Spawned rather than done inline, matching the other HUDs: mounting waits for `PlayerGui`, and
		// a controller's `onStart` is the wrong place to hold up the rest of the client's boot.
		task.spawn(() => this.mount());
	}

	private mount(): void {
		if (this.mounted) return;
		this.mounted = true;

		const theme = hudTheme();

		print("[Shop] panel up — Cosmetics (catalogue) · Power & Items (the chest, over the whole pool)");

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
		this.addCosmeticsPane(content, theme);
		this.addPowersPane(content, theme);

		this.addFooter(panel, theme);

		raiseZIndex(panel, PANEL_Z_INDEX);
		wrapLabels(panel);

		panel.Parent = getHudScreenGui(); // must stay the LAST statement in this method

		// After the tree, because both of these write into values the tree is already reading. Doing it
		// first would draw a frame of "no coins, nothing owned" on every mount — a lie the player would
		// see, rather than a detail they would not.
		this.watchPlayer();
		this.watchChest();
		this.watchPurchase();
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
			"PowerItems",
			2,
			Fusion.Computed(this.scope, (use) => use(this.currentTab) === "Power & Items"),
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

	// ---------- tab 1: cosmetics ----------

	/**
	 * The cosmetics catalogue — **two shelves in one grid: the coin trails, and the Robux items.**
	 *
	 * **The coin shelf is buyable and the Robux shelf is not, and the difference is the *absence* of a
	 * button rather than a label.** A coin trail gets an activation — a tap sends `purchaseCosmetic` — and a
	 * Robux item gets none, which is the whole of "no Robux path": a tile without an activation has no hit
	 * button at all (see `addTile`), so there is nothing to click and nothing to explain. The status line says
	 * the rest: `Buy · 300 coins` on one, `Trail · 99 R$ · Not yet purchasable` on the other.
	 *
	 * **The Robux half is still a shelf of statements rather than actions**, for the reason it has always been
	 * one: no `MarketplaceService`, no prompt, and every `gamepassId` is `0`, so a Buy button there would take
	 * a player's Robux and hand back nothing. The coin shelf is the opposite case and is wired end to end — a
	 * player who taps it has already spent by the time the server says no, and the refusal comes back verbatim.
	 *
	 * **One grid, two shelves, and that is deliberate.** The tiles are the same family, the reading order is
	 * the catalogue's, and the only thing that differs between a coin trail and a Robux trail is what a tap
	 * does — which is exactly what the status line and the button's presence say. Splitting them into two
	 * grids would put a seam between two items that differ only in their price's currency.
	 *
	 * **Owned entries are marked in the status line rather than by a border**, which the previous version of
	 * this pane argued at length and which is still right: the accent outline means *equipped*, a state that
	 * does not exist in a shop, so the marker is the word `Owned` in the success colour. An owned coin trail
	 * shows `Owned` and its tap is a no-op (see `requestPurchase`), an unaffordable one shows its price and its
	 * tap surfaces the server's "not enough coins" — the price is never hidden, because a greyed-out price is
	 * a price the player has to be *told* they cannot reach, and the refusal is the sentence that tells them.
	 */
	private addCosmeticsPane(content: Frame, theme: HudTheme): void {
		const pane = addPane(
			this.scope,
			content,
			"Cosmetics",
			1,
			Fusion.Computed(this.scope, (use) => use(this.currentTab) === "Cosmetics"),
		);
		const grid = addGrid(this.scope, pane, COLUMNS, PURCHASE_COSMETICS.size() + PREMIUM_COSMETICS.size());

		let order = 0;

		for (const def of PURCHASE_COSMETICS) {
			// The coin shelf, first — the things the panel can actually act on, in the same spirit the opening
			// tab puts the chest up: the clickable half comes before the one that is only there to be looked at.
			const tile = addTile(this.scope, grid, theme, def.name, order, true, () => this.requestPurchase(def));
			order += 1;

			Fusion.Hydrate(this.scope, tile.statusLabel)({
				Text: Fusion.Computed(this.scope, (use) =>
					ownedCosmeticIdsOf(use(this.cosmetics)).has(def.id)
						? "Owned"
						: `Buy · ${withCommas(def.coinPrice ?? 0)} coins`,
				),
				TextColor3: Fusion.Computed(this.scope, (use) =>
					ownedCosmeticIdsOf(use(this.cosmetics)).has(def.id)
						? theme.colors.success
						: theme.colors.textPrimary,
				),
			});
		}

		for (const def of PREMIUM_COSMETICS) {
			const tile = addTile(this.scope, grid, theme, def.name, order, true);
			order += 1;

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
		}
	}

	// ---------- footer ----------

	/**
	 * The one action the panel has, in the band the old layout kept for it.
	 *
	 * **The footer button is the chest, and its state is the whole of what this panel can do.** The mock
	 * put `OPEN BOX` here and showed it only when a box was open; this shows the chest while the Power &
	 * Items tab is up and the pool still holds something this player does not own, and swaps itself for a
	 * line saying so when it does not.
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
				if (granted === "") return "";

				// **An ability id goes through the roster's own vocabulary; anything else is already a name.** The
				// two arms of the chest's pool travel differently on purpose — see `networking.ts` on
				// `chestResult` — and this is the one line that reads both: a power arrives as `"Pierce"` and is
				// named from `ABILITY_NAMES`, a cosmetic arrives as `"Verdant Trail"` and has no map to go
				// through. The test is `isAbilityKind` rather than a bare non-empty check so that an ability id
				// this build does not know would still be drawn verbatim rather than blanked.
				return isAbilityKind(granted)
					? `You unlocked ${ABILITY_NAMES[granted]}!`
					: `You unlocked ${granted}!`;
			}),
			TextColor3: Fusion.Computed(this.scope, (use) =>
				use(this.chestReason) !== "" ? theme.colors.warning : theme.colors.success,
			),
			Visible: Fusion.Computed(
				this.scope,
				(use) => use(this.chestGranted) !== "" || use(this.chestReason) !== "",
			),
		});

		/**
		 * How much of the chest this player has left to win, as the one number the button and the line share.
		 *
		 * **One `Computed` for the pair, because they are two halves of one question.** The button is shown while
		 * this is above zero and the sentence is shown while it is at zero, so two `Computed`s would be two
		 * subscriptions deriving the same count — two things to keep in step where one will do, and the kind of pair
		 * that drifts the day one of them is changed.
		 *
		 * **Neither attribute is read after a branch.** This pair used to: `use(this.powers)` sat behind an `&&` that
		 * was false whenever the catalogue tab was up, so those subscriptions existed only while the other tab was
		 * showing. It was invisible — the footer is hidden on that tab too — and it is fixed here because a
		 * `Computed` that reads a value conditionally is the documented trap rather than a style question. See
		 * `RoundStatusController`.
		 */
		const remaining = Fusion.Computed(this.scope, (use) =>
			this.unclaimedItems(use(this.powers), use(this.cosmetics)).size(),
		);

		const complete = addMessageLine(this.scope, theme, footer, 2);
		complete.Name = "ChestComplete";
		complete.Text = "Nothing left in the chest to win.";
		complete.TextColor3 = theme.colors.success;
		Fusion.Hydrate(this.scope, complete)({
			Visible: Fusion.Computed(this.scope, (use) => {
				const onPowerTab = use(this.currentTab) === "Power & Items";
				const left = use(remaining);

				return onPowerTab && left === 0;
			}),
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
			Visible: Fusion.Computed(this.scope, (use) => {
				const onPowerTab = use(this.currentTab) === "Power & Items";
				const left = use(remaining);

				return onPowerTab && left > 0;
			}),
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

	/**
	 * Asks to buy one coin-priced cosmetic, guarded by the one fact the tile already shows.
	 *
	 * **An owned tile is a no-op rather than a round trip**, and the guard is the reactive read the tile
	 * cannot make a button out of: `addTile` builds its hit button once, from whether an activation was given,
	 * so "clickable only while unowned" cannot be a state the button enters and leaves. The guard here is the
	 * next best thing and the honest one — the tile says `Owned`, a tap on it does nothing, and the server
	 * refuses the request independently either way (`validatePurchase`'s ownership branch), so nothing about
	 * the economy trusts this check.
	 *
	 * **The refusal is not surfaced here.** A tap on an owned tile is not a mistake the panel needs to
	 * explain — the word `Owned` is on the tile the player tapped — and printing a sentence would be the panel
	 * scolding a player for something it had already told them.
	 */
	private requestPurchase(def: CosmeticDef): void {
		if (ownedCosmeticIdsOf(Fusion.peek(this.cosmetics)).has(def.id)) return;

		if (DEBUG) print(`[Shop] asked to buy ${def.id}`);

		// Cleared for `requestChest`'s reason: a reply must not be readable as the answer to an earlier ask.
		this.chestGranted.set("");
		this.chestReason.set("");

		this.purchaseRemote?.SendToServer(def.id);
	}

	/**
	 * Every chest entry this player does not have — **the whole pool, not just the powers.**
	 *
	 * **The pool rather than the roster, because the panel's question is the chest's question.** The button and
	 * the "nothing left" line are both asking the same thing the server asks before it takes the coins — "is
	 * there anything in the pool this player does not have?" — and the server answers it from `CHEST_POOL`. A gate
	 * derived from `POWER_ROSTER` alone was correct while powers were the whole pool and became wrong the moment
	 * the chest gained a second kind: it would hide the button from every player who owns three powers, which is
	 * every player, and the chest would be unreachable with nothing on screen to say why.
	 *
	 * **It is one predicate with `EconomyService.openChest`'s refusal, which is the point of keeping it.** That
	 * one filters `CHEST_POOL` through the two arms of `ownsItem` over the *record*; this filters the same list
	 * through the same two arms over the two owned *attributes*. Same list, same test — so the client cannot
	 * offer a chest the server will refuse, which is the only reason a copy of the rule is allowed here.
	 *
	 * **Derived here rather than sent.** Nothing about the answer is secret — the two owned sets are attributes
	 * this panel is already reading — and a remote reporting a count would be a second copy of a fact the client
	 * can see for itself. It is the same reasoning that keeps the pool's *odds* off the wire: the list is the same
	 * for everybody and the client owns it.
	 *
	 * The two arms are tested exactly as `EconomyService.ownsItem` tests them, from the attributes rather than
	 * from a record — `ownsPower` reads the power it is asked about out of the owned string, and
	 * `ownedCosmeticIdsOf` parses the cosmetic one, both taking the verbatim attribute text this panel already
	 * holds. **The first parameter is `OWNED_ITEMS_ATTRIBUTE`**, which holds everything owned rather than powers
	 * alone; `ownsPower` is what narrows it back to the one power being asked about.
	 */
	private unclaimedItems(items: string, cosmetics: string): ChestItem[] {
		const owned = ownedCosmeticIdsOf(cosmetics);

		return CHEST_POOL.filter((item) =>
			item.kind === "power" ? !ownsPower(items, item.power) : !owned.has(item.cosmetic),
		);
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
			const value = player.GetAttribute(OWNED_ITEMS_ATTRIBUTE);
			this.powers.set(typeIs(value, "string") ? value : "");
		};

		const readCosmetics = () => {
			const value = player.GetAttribute(OWNED_COSMETICS_ATTRIBUTE);
			this.cosmetics.set(typeIs(value, "string") ? value : "");
		};

		this.scope.push(player.GetAttributeChangedSignal(COINS_ATTRIBUTE).Connect(readCoins));
		this.scope.push(player.GetAttributeChangedSignal(OWNED_ITEMS_ATTRIBUTE).Connect(readPowers));
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

		// **The award sound, built here because this is the method that owns the event it answers.** Preloaded
		// for the reason given with the field: the moment it is needed is a reply that has already cost a round
		// trip, and the clip should not be starting then as well.
		const award = new Instance("Sound");
		award.Name = "ChestAward";
		award.SoundId = AUDIO_CONFIG.CHEST_GRANT;
		award.Volume = AUDIO_CONFIG.CHEST_GRANT_VOLUME;
		award.Parent = SoundService;

		this.awardSound = award;

		ContentProvider.PreloadAsync([award], (contentId, fetchStatus) => {
			if (fetchStatus !== Enum.AssetFetchStatus.Success) {
				warn(`[Shop] chest award sound did not load — ${contentId} (${fetchStatus.Name})`);
			}
		});

		this.scope.push(
			events.Client.Get("chestResult").Connect((granted, reason) => {
				// The wire is not typed, so what arrives is checked rather than trusted — the treatment
				// every other handler in this client gives a string off a remote.
				const grantedText = typeIs(granted, "string") ? granted : "";
				const reasonText = typeIs(reason, "string") ? reason : "";

				this.chestGranted.set(grantedText);
				this.chestReason.set(reasonText);

				/**
				 * **`granted` being non-empty is the whole of the success signal, and there is no second one to
				 * invent.** The server sends `""` for a refusal *and* `""` for a duplicate, and a name for a grant —
				 * so the same string the footer draws its sentence from is the test, and the sound cannot disagree
				 * with the words about whether anything happened. A duplicate and a refusal are the same outcome to
				 * a player; a sound on either would be the panel announcing something that did not take place. See
				 * `networking.ts` on `chestResult`.
				 *
				 * **Played after the values are written rather than before.** Both land in this frame, so this is
				 * about intent rather than latency: the line is the record of what happened and the sound is the
				 * notice that goes with it, and if the two ever *were* pulled apart the line is the one that must
				 * not wait.
				 */
				if (grantedText !== "") this.awardSound?.Play();

				if (DEBUG) {
					print(
						`[Shop] chest replied — granted "${grantedText}", reason "${reasonText}"` +
							` (coins now ${Fusion.peek(this.coins)})`,
					);
				}
			}),
		);
	}

	/**
	 * Takes the purchase's answer, on `watchChest`'s shape and the same outcome line.
	 *
	 * **A separate event and a separate watcher, but one line.** `purchaseResult` and `chestResult` carry the
	 * same two strings and land on the same footer line, because a player reads one sentence about the last
	 * economy action, not two. What separates them is the vocabulary — the purchase's reasons are its own —
	 * and the *event* that carried the sentence, which is the only thing the client needs to know which of the
	 * two actions refused. Both write the same two values, so a purchase's answer replaces a chest's the way a
	 * second chest would.
	 *
	 * **The success signal is `granted` being non-empty, exactly as it is for the chest**, and the award sound
	 * is the same reused instance for the same reason: a grant is a grant, whether the coins went into a chest
	 * or onto a shelf, and a second `Sound` for the same id and the same moment would be a second thing to
	 * keep in step. Played after the values are written, in the same frame.
	 */
	private watchPurchase(): void {
		this.purchaseRemote = events.Client.Get("purchaseCosmetic");

		this.scope.push(
			events.Client.Get("purchaseResult").Connect((granted, reason) => {
				const grantedText = typeIs(granted, "string") ? granted : "";
				const reasonText = typeIs(reason, "string") ? reason : "";

				this.chestGranted.set(grantedText);
				this.chestReason.set(reasonText);

				if (grantedText !== "") this.awardSound?.Play();

				if (DEBUG) {
					print(`[Shop] purchase replied — granted "${grantedText}", reason "${reasonText}"`);
				}
			}),
		);
	}
}
