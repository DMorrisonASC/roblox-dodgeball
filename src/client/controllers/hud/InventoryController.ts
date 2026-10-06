import { Controller, OnStart } from "@flamework/core";
import Fusion from "@rbxts/fusion-3.0";
import { Text } from "@rbxts/big-ui";
import Net from "@rbxts/net";
import { Players } from "@rbxts/services";
import { OWNED_COSMETICS_ATTRIBUTE } from "shared/constants";
import { COSMETICS, MILESTONES } from "shared/config/economy.config";
import type { CosmeticDef } from "shared/config/economy.config";
import { EQUIPPED_ATTRIBUTE, equippedIdOf, ownedCosmeticIdsOf } from "shared/economy";
import { events } from "shared/networking";
import { INTERMISSION, inventoryOpen, roundPhase } from "../../panels";
import { getHudScreenGui } from "../../ui/screenGui";
import { hudTheme } from "../../ui/hudTheme";
import type { HudTheme } from "../../ui/hudTheme";
import {
	addCentredMessage,
	addColumnHeading,
	addColumns,
	addContentBand,
	addFillColumn,
	addFixedColumn,
	addFooterBand,
	addGlyph,
	addHeaderBand,
	addMessageLine,
	addPanelFrame,
	addPane,
	addPill,
	addShelf,
	addShowcase,
	addTabStrip,
	addTile,
	PANEL_Z_INDEX,
	raiseZIndex,
	wrapLabels,
} from "../../ui/panelChrome";
import type { TabColour } from "../../ui/panelChrome";

/** Prints the mount line, each tab change and each equip request. */
const DEBUG = true;

/** The client half of the equip remote, as the declaration builds it. */
type ClientRemotes = Net.Util.GetClientRemotes<Net.Util.GetDeclarationDefinitions<typeof events>>;

/**
 * What a slot is called, and which colour job its tab is offered in.
 *
 * **Presentation only — the slots themselves are read off the catalogue.** A slot with no entry here
 * still gets a tab and a shelf, named after the slot; this table exists so `trail` and `elimination` read
 * as English rather than so the list of slots is written down twice. See {@link catalogueSlots}.
 */
const SLOT_PRESENTATION: Record<string, { tab: string; colour: TabColour; heading: string }> = {
	trail: { tab: "Trails", colour: "accent", heading: "Your Trails" },
	elimination: { tab: "Eliminations", colour: "coin", heading: "Your Eliminations" },
};

/**
 * The slot that is stored and equipped but drawn nowhere.
 *
 * **A named exception rather than a rule, and it is named because there is exactly one of them.** The
 * elimination slot behaves like any other everywhere else — the record holds it, the equip command accepts
 * it, the attribute publishes it — and the only thing it cannot do is be shown, because no
 * `CosmeticDef` carries an asset id and there is no elimination render hook in the game. So its pane gets a
 * sentence instead of the two columns. A second slot with no render path would need its own line here, and
 * that is honest: "which slots can be drawn" is a fact about the renderer, not about the catalogue.
 */
const UNRENDERED_SLOT = "elimination";

/** What the unrendered slot says in place of its columns. */
const COMING_SOON = "Coming Soon";

/** The shelf entry that means "nothing equipped". Not a `COSMETICS` key — see {@link addDefaultTile}. */
const DEFAULT_NAME = "Default";

/** How wide the equipped column is, as a fraction of the band, and the pixel bounds it may not leave. */
const EQUIPPED_COLUMN_SCALE = 0.34;
const EQUIPPED_COLUMN_MIN = 110;
const EQUIPPED_COLUMN_MAX = 200;

/**
 * The slots this build dresses, derived from the catalogue rather than listed.
 *
 * **Read off `COSMETICS`, because a hand-written list is a second place to keep in step with it.** Every
 * def carries a `slot`, so the slots that exist are exactly the distinct `slot` values in the catalogue;
 * adding a cosmetic in a new slot grows this list on its own. The order is catalogue order, which is
 * declaration order — so the tab you get first is the one whose items were written first, which is what a
 * person reading `economy.config.ts` would expect.
 *
 * Called once, from `mount`, and the result kept on the controller: a module-level `const` that called it
 * would run before this function's body existed in the emitted Luau, which is the trap
 * `ThemeController.derive` documents.
 */
function catalogueSlots(): string[] {
	const slots: string[] = [];

	for (const [, def] of pairs(COSMETICS)) {
		if (!slots.includes(def.slot)) slots.push(def.slot);
	}

	return slots;
}

/** The tab a slot is offered under, and the heading over its shelf. */
function tabOf(slot: string): string {
	return SLOT_PRESENTATION[slot]?.tab ?? slot;
}

/** Every cosmetic in `slot` that this player owns, in catalogue order. */
function ownedInSlot(ownedText: string, slot: string): CosmeticDef[] {
	const owned = ownedCosmeticIdsOf(ownedText);
	const found: CosmeticDef[] = [];

	for (const [, def] of pairs(COSMETICS)) {
		if (def.slot === slot && owned.has(def.id)) found.push(def);
	}

	return found;
}

/** How many cosmetics this player owns in total, counting only ids this build knows. */
function ownedTotal(ownedText: string): number {
	const owned = ownedCosmeticIdsOf(ownedText);
	let count = 0;

	for (const [, def] of pairs(COSMETICS)) {
		if (owned.has(def.id)) count += 1;
	}

	return count;
}

/** The milestone that grants `def`, or nothing for a premium cosmetic. */
function grantOf(def: CosmeticDef): string | undefined {
	for (const milestone of MILESTONES) {
		if (milestone.cosmeticId === def.id) return milestone.name;
	}

	return undefined;
}

/**
 * The inventory: what this player owns, one slot per tab, with the worn one shown larger beside the shelf.
 *
 * **This panel used to be read-only, and the argument for that is now the argument for it being editable.**
 * It was built with no affordance at all because there was nowhere to write a choice — no equip field in the
 * record, no command on `EconomyService`, no remote — and an affordance that cannot persist is a lie to a
 * player. That is still the rule; what changed is that there is now a place to write, so a tile is a
 * button. The rule to keep is the one that outlives this change: **nothing here is drawn as clickable
 * unless the server will act on it**, which is why the elimination tab offers no tiles at all rather than
 * tiles that do nothing.
 *
 * **The panel reads two attributes and writes nothing.** `OWNED_COSMETICS_ATTRIBUTE` says what is in the
 * shelf and each slot's `Equipped*` attribute says which one is on, both published by `EconomyService` and
 * both watched through a changed signal plus one opening read — the bridge `StatsBillboardController`
 * established, for its reason: an attribute read inside a `Computed` is a sample rather than a dependency.
 *
 * **What a click does is a *request*.** The panel sends "I would like to wear this" and then draws whatever
 * the attribute says a moment later; it never assumes the equip succeeded. That round trip is the whole
 * security model — see `EconomyService.equipCosmetic` — and it is also why the tile already worn is
 * re-sent rather than swallowed: this machine's copy of the attribute is a replica, and a click the client
 * decides to ignore is a click that does nothing at all if the replica is stale.
 *
 * **`Default` is a real entry in every shelf**, standing for "no cosmetic" and equipping the empty string.
 * Without it there would be no way to put a cosmetic *down*, which is a state a player can be in before
 * they have earned anything and may want back afterwards.
 */
@Controller()
export class InventoryController implements OnStart {
	private scope = Fusion.scoped();
	private mounted = false;

	/** Which tab is showing, as the tab's own name. Seeded from the first slot's tab in `mount`. */
	private currentTab = Fusion.Value(this.scope, "");

	/** The `OWNED_COSMETICS_ATTRIBUTE` string, verbatim. */
	private cosmetics = Fusion.Value(this.scope, "");

	/** One value per slot, holding that slot's equipped id or `""` for the default. */
	private readonly equipped = new Map<string, Fusion.Value<string>>();

	/** The slots, read off the catalogue once in `mount` so nothing recomputes them per frame. */
	private slots: string[] = [];

	private equipRemote?: ClientRemotes["equipCosmetic"];

	onStart(): void {
		// Spawned rather than done inline, matching the other HUDs: mounting waits for `PlayerGui`, and the
		// equip remote's `Get` yields on top of that, so a controller's `onStart` is the last place that
		// should be holding up the rest of the client's boot.
		task.spawn(() => this.mount());
	}

	private mount(): void {
		if (this.mounted) return;
		this.mounted = true;

		const theme = hudTheme();

		this.slots = catalogueSlots();
		for (const slot of this.slots) this.equipped.set(slot, Fusion.Value(this.scope, ""));
		this.currentTab.set(tabOf(this.slots[0] ?? ""));

		if (DEBUG) print(`[Inventory] panel up — ${this.slots.size()} slots`);

		// Visible when it is open *and* the phase is between rounds — the same two facts the dock reads, so
		// a round starting closes what the dock opened rather than leaving a panel over the game with its
		// button gone.
		const panel = addPanelFrame(
			this.scope,
			theme,
			"InventoryPanel",
			Fusion.Computed(this.scope, (use) => use(inventoryOpen) && use(roundPhase) === INTERMISSION),
		);

		const right = addHeaderBand(this.scope, theme, panel, 1, "Inventory", () => inventoryOpen.set(false));
		this.addOwnedPill(right, theme);

		// **The tabs are the catalogue's own slots and nothing else**, so a tab that exists is a tab with a
		// shelf behind it. That is the difference from the version before this one, which offered a fixed
		// pair of tabs over two shelves that could both be empty.
		addTabStrip(
			this.scope,
			theme,
			panel,
			2,
			this.slots.map((slot) => ({ name: tabOf(slot), colour: SLOT_PRESENTATION[slot]?.colour ?? "accent" })),
			this.currentTab,
			(tab) => {
				if (DEBUG) print(`[Inventory] tab: ${tab}`);
			},
		);

		const content = addContentBand(this.scope, panel, 3);
		this.slots.forEach((slot, index) => this.addSlotPane(content, theme, slot, index + 1));

		this.addFooter(panel, theme);

		raiseZIndex(panel, PANEL_Z_INDEX);
		wrapLabels(panel);

		panel.Parent = getHudScreenGui(); // must stay the LAST statement before the watches

		this.watchPlayer();
		this.watchEquip();
	}

	/**
	 * One slot's pane: the equipped column and the shelf beside it, or a sentence where they would be.
	 *
	 * **The pane is what makes the tab a tab.** It fills the content band and is `Visible` only while its own
	 * slot is selected, so switching tabs is one value write and no tree work — the shape `addPane` was built
	 * for, and the reason nothing here is rebuilt on a click.
	 */
	private addSlotPane(content: Frame, theme: HudTheme, slot: string, order: number): void {
		const tab = tabOf(slot);
		const pane = addPane(
			this.scope,
			content,
			slot,
			order,
			Fusion.Computed(this.scope, (use) => use(this.currentTab) === tab),
		);

		// **The unrendered slot gets a sentence rather than two columns, and that is the whole of the
		// "Coming Soon" state.** No tiles, no equip affordance, no stand-in content: the state is stored and
		// the command accepts it, so what is missing is a way to *show* an elimination effect, and a grid of
		// grey boxes would be pretending otherwise. `addCentredMessage` fills the pane, which is why it is a
		// builder of its own rather than `addMessageLine` — that one is a fixed line at the bottom of a band
		// and cannot be centred in one.
		if (slot === UNRENDERED_SLOT) {
			addCentredMessage(this.scope, theme, pane, COMING_SOON, 1);
			return;
		}

		const columns = addColumns(this.scope, pane, "Columns", 1);

		// Left: what is worn, larger. A fraction of the band with pixel bounds rather than a pixel width,
		// so it is right on a phone and on an ultrawide — see `addFixedColumn`.
		const left = addFixedColumn(
			this.scope,
			columns,
			"EquippedColumn",
			1,
			EQUIPPED_COLUMN_SCALE,
			EQUIPPED_COLUMN_MIN,
			EQUIPPED_COLUMN_MAX,
		);
		addColumnHeading(this.scope, theme, left, "Equipped", 1);
		this.addEquippedShowcase(left, theme, slot, 2);

		// Right: the shelf, which takes the remainder and scrolls on its own.
		const right = addFillColumn(this.scope, columns, "ShelfColumn", 2);
		addColumnHeading(this.scope, theme, right, SLOT_PRESENTATION[slot]?.heading ?? `Your ${tab}`, 1);

		const shelf = addShelf(this.scope, right, theme, "Shelf", 2);
		this.fillShelf(shelf, theme, slot);
	}

	/**
	 * The equipped column: the current item's name, larger, with the panel's one marker on it.
	 *
	 * **A tile scaled up rather than a preview, and the difference is worth stating.** The reference for this
	 * layout shows spheres because those are renders of the items; nothing in a `CosmeticDef` can be drawn —
	 * no asset id, no model, no mesh — so a `ViewportFrame` would have to invent geometry and would render an
	 * empty box for every cosmetic in the game. The honest version is the same tile treatment at a size you
	 * can read across the panel, with the accent border the shelf also uses, so "this is the one" is one
	 * marker in two places rather than a badge in one.
	 */
	private addEquippedShowcase(column: Frame, theme: HudTheme, slot: string, order: number): void {
		const showcase = addShowcase(this.scope, column, theme, order);
		const state = this.equipped.get(slot);

		const label = Fusion.Computed(this.scope, (use) => {
			// Every `use()` first and unconditionally — a read inside a branch is a subscription that only
			// exists while that branch is taken, which is how the round-status HUD once hid its own result.
			const worn = state !== undefined ? use(state) : "";

			if (worn === "") return DEFAULT_NAME;

			const def = COSMETICS[worn];
			return def !== undefined ? def.name : DEFAULT_NAME;
		});

		Fusion.Hydrate(this.scope, showcase.nameLabel)({ Text: label });
	}

	/**
	 * The shelf: `Default` first, then a tile for every cosmetic of this slot, each shown once it is owned.
	 *
	 * **A tile per catalogued item rather than per owned one**, on the argument the previous version of this
	 * panel made and which is still the right one: the shelf's geometry then comes from the catalogue, which
	 * never changes during a session, so a milestone landing mid-session flips one tile's `Visible` instead of
	 * rebuilding the shelf around a new item it had no cell for. The cost is invisible tiles in a grid, which
	 * is only correct if a `UIGridLayout` declines to lay out `Visible = false` children — the shop's locked
	 * hints already depend on that, and it is still the one thing in this panel that cannot be confirmed
	 * without Studio.
	 */
	private fillShelf(shelf: ScrollingFrame, theme: HudTheme, slot: string): void {
		// `Default` is not a catalogue id: it is the empty string, which is the value the server accepts for
		// "nothing equipped" and the value the attribute holds when nothing is. It appears first in every
		// shelf, and it is the only tile that is shown regardless of ownership — a player who owns nothing
		// still has to be able to see that wearing nothing is an option, and to get back to it.
		this.addShelfTile(shelf, theme, slot, DEFAULT_NAME, "", "No cosmetic", 1);

		let order = 2;
		for (const [, def] of pairs(COSMETICS)) {
			if (def.slot !== slot) continue;

			const granted = grantOf(def);
			this.addShelfTile(shelf, theme, slot, def.name, def.id, granted !== undefined ? `From ${granted}` : "Premium", order);
			order += 1;
		}
	}

	/**
	 * One shelf tile: a real button when it is owned, and the panel's marker when it is the one worn.
	 *
	 * **`id` is `""` for the Default tile and a catalogue key for every other**, and that single value is
	 * both halves of the tile's behaviour: what it shows (`Visible` follows ownership, and `""` is always
	 * "owned") and what a click sends. It is deliberately a plain string rather than an optional id, because
	 * the empty case is not "no answer" — it is the answer the server is waiting for.
	 */
	private addShelfTile(
		shelf: ScrollingFrame,
		theme: HudTheme,
		slot: string,
		name: string,
		id: string,
		status: string,
		order: number,
	): void {
		const owned = Fusion.Computed(this.scope, (use) =>
			id === "" ? true : ownedCosmeticIdsOf(use(this.cosmetics)).has(id),
		);

		const tile = addTile(this.scope, shelf, theme, name, order, owned, () => this.requestEquip(slot, id));
		tile.statusLabel.Text = status;
		tile.statusLabel.TextColor3 = theme.colors.textSecondary;

		// **The marker: the tile's own outline, in the accent colour.** One element, two properties, and the
		// same treatment the equipped column's showcase wears — a badge would have been a second element on a
		// tile that already has an artwork slot, a status line and a name bar, and the shelf would then read as
		// a list of states rather than as a shelf of things.
		const state = this.equipped.get(slot);
		const worn = Fusion.Computed(this.scope, (use) => (state !== undefined ? use(state) : "") === id);

		Fusion.Hydrate(this.scope, tile.stroke)({
			Color: Fusion.Computed(this.scope, (use) => (use(worn) ? theme.colors.accent : theme.colors.border)),
			Thickness: Fusion.Computed(this.scope, (use) => (use(worn) ? 2 : 1)),
		});
	}

	/** The count of what is owned, in the header — the one figure this panel has. */
	private addOwnedPill(parent: Frame, theme: HudTheme): void {
		const pill = addPill(this.scope, theme, parent, 1);
		addGlyph(this.scope, theme.colors.accent, pill, 1);

		const count = Text(this.scope, {
			text: Fusion.Computed(this.scope, (use) => `${ownedTotal(use(this.cosmetics))} owned`),
			variant: "body2",
			wrap: false,
		});
		count.TextColor3 = theme.colors.textPrimary;
		count.Size = UDim2.fromOffset(0, 0);
		count.AutomaticSize = Enum.AutomaticSize.XY;
		count.LayoutOrder = 2;
		count.Parent = pill;
	}

	/**
	 * The one sentence the panel has left to say.
	 *
	 * **The empty state is no longer "nothing to show" — `Default` is always in the shelf — so what is left
	 * to report is the two facts a shelf of one tile does not carry by itself**: that there is nothing earned
	 * in this slot yet, and that the unrendered slot is unrendered. The second is worth a sentence for the
	 * reason it always was: the item is genuinely owned and genuinely shown nowhere, and saying so is the
	 * difference between a feature that is coming and a feature that looks broken.
	 *
	 * Two states and a hidden third, in the order they matter. A trail player with a trail owned reads nothing
	 * at all, which is why the line is hidden when it is empty rather than left as a blank row.
	 */
	private addFooter(panel: Frame, theme: HudTheme): void {
		const footer = addFooterBand(this.scope, panel, 4);
		const message = addMessageLine(this.scope, theme, footer, 1);

		const text = Fusion.Computed(this.scope, (use) => {
			// Every `use()` first, unconditionally.
			const owned = use(this.cosmetics);
			const tab = use(this.currentTab);

			const slot = this.slots.find((candidate) => tabOf(candidate) === tab);
			if (slot === undefined) return "";

			// **The unrendered slot says nothing here, because its pane already says it.** "Coming Soon" is
			// centred in the band where the columns would be; repeating it under the panel would be the same
			// fact twice on one screen, and the second one would be the one a reader stops seeing.
			if (slot === UNRENDERED_SLOT) return "";

			if (ownedInSlot(owned, slot).size() === 0) return "Nothing earned yet — cosmetics come from milestones.";

			return "";
		});

		Fusion.Hydrate(this.scope, message)({
			Text: text,
			Visible: Fusion.Computed(this.scope, (use) => use(text) !== ""),
		});
	}

	// ---------- server contact ----------

	/**
	 * Asks to wear `id` in `slot`. The whole of what this panel can ask the server to do.
	 *
	 * **Sent even when the tile is already the one worn**, which is the half of the choice worth stating: the
	 * alternative is to compare against this machine's copy of the attribute and drop the click, and that copy
	 * is a replica of a fact the server owns. A click dropped on stale information is a click that does
	 * nothing, silently, which is the one failure a player cannot report usefully — whereas a redundant
	 * message costs one round trip and the server's answer is the same either way, because writing a value
	 * that is already written is still a write.
	 */
	private requestEquip(slot: string, id: string): void {
		if (DEBUG) print(`[Inventory] equip request: ${slot} = ${id === "" ? "(default)" : id}`);

		this.equipRemote?.SendToServer(slot, id);
	}

	/**
	 * Bridges the owned-cosmetics attribute, and each slot's equipped attribute, into `Fusion` values.
	 *
	 * The opening reads are not redundant with the connections: a player who already owns something when this
	 * mounts — which is every player after their first win — would otherwise see an empty shelf until
	 * something *changed*, and an attribute that is already correct never fires a signal.
	 *
	 * The slots are walked rather than the two attribute names spelled out here, so this file and
	 * `EconomyService.publish` cannot disagree about which attribute belongs to which slot:
	 * {@link EQUIPPED_ATTRIBUTE} is the one place that pairing is written down.
	 */
	private watchPlayer(): void {
		const player = Players.LocalPlayer;

		const readCosmetics = () => {
			const value = player.GetAttribute(OWNED_COSMETICS_ATTRIBUTE);
			this.cosmetics.set(typeIs(value, "string") ? value : "");
		};

		this.scope.push(player.GetAttributeChangedSignal(OWNED_COSMETICS_ATTRIBUTE).Connect(readCosmetics));
		readCosmetics();

		for (const slot of this.slots) {
			const attribute = EQUIPPED_ATTRIBUTE[slot];
			const state = this.equipped.get(slot);
			if (attribute === undefined || state === undefined) continue;

			const read = () => state.set(equippedIdOf(player.GetAttribute(attribute)));

			this.scope.push(player.GetAttributeChangedSignal(attribute).Connect(read));
			read();
		}
	}

	/**
	 * Resolves the request remote.
	 *
	 * `Get` yields on the client, which is why the whole of this runs from `mount`'s `task.spawn` rather than
	 * inline — the note `ShopController.watchChest` makes about its own subscription. Nothing is listened for
	 * in return: the answer to an equip is the attribute changing, which replicates on its own, so there is no
	 * reply event to connect.
	 */
	private watchEquip(): void {
		this.equipRemote = events.Client.Get("equipCosmetic");
	}
}
