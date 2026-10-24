import Fusion from "@rbxts/fusion-3.0";
import Net from "@rbxts/net";
import { ContextActionService, ReplicatedStorage } from "@rbxts/services";
import { ROUND_MODE_ATTRIBUTE, ROUND_STATUS_FOLDER } from "shared/constants";
import { isGameModeId, sideNameOf, teamColourOf } from "shared/gameMode";
import type { GameModeId } from "shared/gameMode";
import type { MatchStatsRow } from "shared/matchStats";
import { events } from "shared/networking";
import { Controller, OnStart } from "@flamework/core";
import {
	addContentBand,
	addFooterBand,
	addHeaderBand,
	addPanelFrame,
	PANEL_Z_INDEX,
	raiseZIndex,
	withCommas,
} from "../../ui/panelChrome";
import { lightPanelTheme } from "../../ui/lightPanelTheme";
import type { HudTheme } from "../../ui/hudTheme";
import { getHudScreenGui } from "../../ui/screenGui";

/** Prints the open, the answer and any refusal. Off for frame time — see `shared/config/debug.config.ts`. */
const DEBUG = false; // off for frame time — see shared/config/debug.config.ts

/** The typed client side of the remote, named the way `ShopController` names its own. */
type ClientRemotes = Net.Util.GetClientRemotes<Net.Util.GetDeclarationDefinitions<typeof events>>;

/** Whatever the OS reports for the key labelled `Tab`. */
const KEY = Enum.KeyCode.Tab;

/** The action name, so the binding is findable by the same name `ContextActionService` holds. */
const ACTION_NAME = "MatchStatsBoard";

/**
 * The column headers, and the width each one takes — **the whole of the table's geometry in one place.**
 *
 * **Fractions rather than pixels, which is `panelChrome`'s rule for the same reason**: the panel's own width is
 * a fraction of the viewport, so a pixel column would be right on one screen and wrong on the next. The name
 * gets the largest share because names are the only column whose contents have no fixed length; the five
 * numbers share the rest evenly, which is what makes two rows comparable at a glance.
 *
 * They are written as one table rather than as six constants so that a column cannot be added to the headings
 * and forgotten in the row.
 */
const COLUMNS: ReadonlyArray<{ readonly heading: string; readonly width: number; readonly left: boolean }> = [
	{ heading: "NAME", width: 0.3, left: true },
	{ heading: "POINTS", width: 0.16, left: false },
	{ heading: "HITS", width: 0.135, left: false },
	{ heading: "THROWS", width: 0.135, left: false },
	{ heading: "CATCHES", width: 0.135, left: false },
	{ heading: "DODGES", width: 0.135, left: false },
];

/** One row's height in pixels, and the vertical gap between rows. **Placeholder.** */
const ROW_HEIGHT = 26;
const ROW_GAP = 2;

/** How tall one side's heading is, in pixels. **Placeholder.** */
const SIDE_HEADING_HEIGHT = 22;

/** The sides, in the order they are drawn — the same `A` then `B` order every other list uses. */
const SIDES: ReadonlyArray<string> = ["A", "B"];

/**
 * The in-match stats board: **who is doing what, this round, grouped by side and ranked by points.**
 *
 * **Held, not toggled, and that decision is `Tab`'s rather than this file's.** The key is a glance — the thing
 * a player presses to see the state of the match and lets go of to play again — and a toggle would need a
 * second press to get out of a panel that is covering the game, which is the interaction `ShiftLock`'s own
 * hold-to-aim avoids. It also makes the key's lifetime the panel's lifetime, so there is no state to be stuck
 * in: `InputEnded` is the close, and a released key cannot leave a panel open.
 *
 * **`ContextActionService` rather than `UserInputService`, and this is the opposite of what `returnToLobby`
 * does.** That file *observes* `L` so the same press keeps walking, because a movement key answering to two
 * readers is the whole point. `Tab` has one other claimant — **Roblox's own player-list CoreScript** — so this
 * binding is **claimed** with `Sink`, which is what makes the press this panel's and gives this file the
 * `Begin`/`End` pair a hold needs. **The first version passed instead, on the argument that the key belonged to
 * nobody else; the symptom was `Tab` opening the leaderboard.** `CoreGuiController` still removes that list
 * through both of the engine's levers, and sinking is what keeps the panel independent of whether the removal
 * took — see {@link bindKey}. A bound action also does not fire while a text box has focus, so a player typing a
 * line with a tab in it keeps their chat.
 *
 * **The style is the Shop's and the Inventory's**, because a third panel in a different idiom would be a third
 * thing to learn: `lightPanelTheme` for the paper, `addPanelFrame` for the sheet, its corner, its hairline and
 * its one shadow, and `addHeaderBand`/`addContentBand`/`addFooterBand` for the three strips. **What is not
 * shared is the shelf**: `addShelf` and `addTile` are a grid of fixed cards, and a board is rows of text whose
 * number changes every time it opens. See {@link render}, which is the one place this file builds instances
 * rather than reusing them.
 *
 * **The rows are rebuilt on every open, and that is a deliberate departure from these panels' rule.** The shop
 * builds once and only changes properties, because its contents are static and big-ui takes its props at
 * construction. A board's contents are *scores* — a different row count, order and set of numbers on every
 * press — so a property-only update would mean a Fusion value per cell for six columns of a variable roster.
 * Rebuilt into a container that is emptied first, the cost is a handful of `TextLabel`s per press on a key a
 * player holds for a moment, and nothing accumulates: see {@link render}.
 */
@Controller()
export class MatchStatsController implements OnStart {
	private scope = Fusion.scoped();
	private mounted = false;

	/** Whether the board is on screen. Written by the key binding, read by the panel's `Visible`. */
	private open = Fusion.Value(this.scope, false);

	/**
	 * The remote, resolved once at mount rather than on the first press.
	 *
	 * **`Get` yields** until the server's remote exists, and a yield inside a key handler is a frame of nothing
	 * happening after a press — the trap `ShopController.watchChest` names. Resolved from the spawned mount
	 * thread, which is already the thread that may wait.
	 */
	private remote?: ClientRemotes["matchStats"];

	/** Where the rows go. Everything the board draws lives inside it, including the "nobody" line. */
	private rows?: ScrollingFrame;

	/** The last answer, so a re-open draws instantly rather than emptying while the round trip runs. */
	private last: ReadonlyArray<MatchStatsRow> = [];

	onStart(): void {
		// Spawned rather than inline, matching every other HUD: mounting waits for `PlayerGui`, and a
		// controller's `onStart` is the wrong place to hold up the rest of the client's boot.
		task.spawn(() => this.mount());
	}

	private mount(): void {
		if (this.mounted) return;
		this.mounted = true;

		// **The light palette, which is the pop-ups' and not the HUD's.** A panel read like a page of print —
		// names, numbers, a ranking — gets white paper and black ink, the same call `ShopController` makes and
		// for the same reason: `hudTheme()` is the HUD's palette and can be moved by the big-ui configuration.
		const theme = lightPanelTheme();

		print("[Stats] board up — hold Tab to read the round");

		const panel = addPanelFrame(this.scope, theme, "MatchStatsPanel", this.open);

		addHeaderBand(this.scope, theme, panel, 1, "Match Stats", () => this.open.set(false));

		const content = addContentBand(this.scope, panel, 3);

		// **A stack inside the content band, added here because this panel is the first with more than one
		// child in it.** The Shop's band holds two panes that both fill it and are switched by `Visible`, so it
		// needs no layout at all — this one holds a heading strip *above* a scrolling list, and without a layout
		// the two would both sit at the band's origin. `LayoutOrder` then does the stacking, which is the same
		// arrangement the panel's own bands use one level up.
		Fusion.New(this.scope, "UIListLayout")({
			Parent: content,
			FillDirection: Enum.FillDirection.Vertical,
			SortOrder: Enum.SortOrder.LayoutOrder,
			HorizontalAlignment: Enum.HorizontalAlignment.Center,
			Padding: new UDim(0, ROW_GAP),
		});

		this.addHeadings(theme, content);
		this.rows = this.addRowList(content);

		this.addFooter(theme, panel);

		raiseZIndex(panel, PANEL_Z_INDEX);

		// **`wrapLabels` is deliberately not called here, and it is the one departure from the Shop's mount.**
		// That helper turns wrapping on for every label that is neither `TITLE_NAME` nor `TextScaled` nor inside
		// an auto-sizing parent — right for a panel of sentences, wrong for a table. A row cell is a *column*:
		// it has a fixed height and a width shared with every other row, so a wrapped name would be clipped by
		// the row, and `TextWrapped` also switches off the `TextTruncate` that gives a long name its ellipsis
		// instead. Every label this panel makes is one line by construction, so there is nothing here for it to
		// wrap — see {@link fillCells}, which is where the two properties are set instead.
		panel.Parent = getHudScreenGui(); // must stay the LAST statement in this method

		this.remote = events.Client.Get("matchStats");

		this.bindKey();
	}

	/**
	 * **The key, claimed rather than observed.** `Begin` opens and asks; anything else closes.
	 *
	 * **`Sink`, and this reverses what the first version did.** That version returned `Pass` on the argument that
	 * the panel was "not entitled to the key against anything that has a better claim to it" — which was wrong
	 * about who else wants `Tab`: **Roblox's own player-list CoreScript does**, and a `Pass` leaves the press for
	 * it. The report that proved it was simply "Tab opens the default leaderboard", and the two facts together are
	 * the whole diagnosis — an action that passes is an action that did not claim.
	 *
	 * **So this is the belt, and `CoreGuiController` is the braces.** That file turns the list off through both
	 * of the engine's levers (`SetCoreGuiEnabled` retried, and the configuration object's `Enabled`/`Open`), but a
	 * request whose result cannot be read is not something a key binding should depend on. Sinking makes the panel
	 * work whether or not the removal took — and if the removal *did* take, sinking costs nothing, because there
	 * is nothing left to steal the key from.
	 *
	 * **What it costs: `Tab` is this panel's for as long as this controller is bound**, which is the session.
	 * Nothing else in this game asks for it, and the one thing that did is the surface `CoreGuiController` is
	 * trying to remove — so the cost is the intended outcome rather than a trade.
	 *
	 * **`false` for the touch button**, on `returnToLobby`'s reasoning: a phone has no `Tab`, and a button
	 * drawn for a key that does not exist on the device would be an empty corner of the screen.
	 */
	private bindKey(): void {
		ContextActionService.BindAction(
			ACTION_NAME,
			(_name, state) => {
				// **`Begin` opens; everything else closes** — which covers `End`, the release a hold is built on,
				// and `Cancel`, sent when the window loses focus mid-press. Written as a two-way branch rather
				// than as `Begin`/`End` so a cancelled press cannot leave the panel up with no key to close it;
				// the same reasoning that makes this a hold rather than a toggle.
				if (state === Enum.UserInputState.Begin) {
					this.open.set(true);
					this.refresh();

					if (DEBUG) print("[Stats] board opened");
				} else {
					this.open.set(false);
				}

				return Enum.ContextActionResult.Sink;
			},
			false,
			KEY,
		);
	}

	/**
	 * **Asks the server, and draws when the answer lands.** The previous answer is drawn first, so a second
	 * hold shows the last round's numbers for one frame rather than an empty panel — the wait only reads as a
	 * wait on the very first open, where there is nothing to show and nothing has been lost.
	 *
	 * A refused call — a timeout, or a server that has not registered the function — leaves the old rows
	 * standing and prints, which is the same "say it out loud" the panels use for a failed fetch. The failure is
	 * cosmetic, so nothing else is done about it.
	 */
	private refresh(): void {
		const remote = this.remote;
		if (!remote) return;

		this.render(this.last);

		remote
			.CallServerAsync()
			.then((rows: ReadonlyArray<MatchStatsRow>) => {
				// **Only draw if the panel is still up.** A player who taps `Tab` and lets go inside one round
				// trip would otherwise have the rows written behind a hidden panel — harmless, but it would also
				// paint the *stale* answer over a newer one if two opens overlapped. Kept fresh either way, so
				// the next open starts from the truth.
				this.last = rows;

				// **Re-read the value rather than trusting a capture.** The promise may settle after the key
				// has been released, and `open` is the one fact that says whether anybody is looking.
				if (Fusion.peek(this.open)) this.render(rows);

				if (DEBUG) print(`[Stats] board answered — ${rows.size()} row(s)`);
			})
			.catch((err: unknown) => {
				warn(`[Stats] board request failed — ${tostring(err)}`);
			});
	}

	/**
	 * **The headings, stacked above the scrolling area rather than scrolling with it.** A column heading that
	 * scrolled away is a number with no name, which is the one thing a table cannot survive.
	 */
	private addHeadings(theme: HudTheme, content: Frame): void {
		const strip = new Instance("Frame");
		strip.Name = "Headings";
		strip.Size = new UDim2(1, 0, 0, ROW_HEIGHT);
		strip.BackgroundTransparency = 1;
		strip.LayoutOrder = 0;
		strip.Parent = content;

		this.fillCells(strip, theme, COLUMNS.map((column) => column.heading), (index) => COLUMNS[index].width, true);
	}

	/**
	 * **The scrolling area the rows are rebuilt into**, and the one place this panel departs from `addShelf`.
	 *
	 * `addShelf` is a `ScrollingFrame` whose cells come from a `UIGridLayout` — a grid of fixed cards. A board
	 * is a single column of full-width rows, so the layout is a `UIListLayout` and each row is one frame of its
	 * own; the scroll mechanics are the shelf's (`AutomaticCanvasSize.Y`, an elastic behaviour off so a row
	 * cannot slide away from the pointer) because those are properties of scrolling rather than of grids.
	 */
	private addRowList(content: Frame): ScrollingFrame {
		const list = new Instance("ScrollingFrame");
		list.Name = "Rows";
		list.Size = new UDim2(1, 0, 0, 0);
		list.LayoutOrder = 1;
		list.BackgroundTransparency = 1;
		list.BorderSizePixel = 0;
		list.ScrollBarThickness = 4;
		list.ScrollBarImageTransparency = 0.4;
		list.CanvasSize = UDim2.fromOffset(0, 0);
		list.AutomaticCanvasSize = Enum.AutomaticSize.Y;
		list.ElasticBehavior = Enum.ElasticBehavior.Never;
		list.Parent = content;

		// **A flex item rather than a computed height**, because the band's height is whatever the panel has
		// left after its header and footer — the same "take the rest" the content band itself uses.
		const flex = new Instance("UIFlexItem");
		flex.FlexMode = Enum.UIFlexMode.Fill;
		flex.Parent = list;

		const layout = new Instance("UIListLayout");
		layout.Name = "RowLayout";
		layout.FillDirection = Enum.FillDirection.Vertical;
		layout.SortOrder = Enum.SortOrder.LayoutOrder;
		layout.Padding = new UDim(0, ROW_GAP);
		layout.Parent = list;

		return list;
	}

	/** The one line of small print: what the numbers mean and how the key behaves. */
	private addFooter(theme: HudTheme, panel: Frame): void {
		const footer = addFooterBand(this.scope, panel, 4);

		const note = new Instance("TextLabel");
		note.Name = "Note";
		note.Size = new UDim2(1, 0, 0, 18);
		note.BackgroundTransparency = 1;
		note.Font = theme.typography.caption.font;
		note.TextSize = theme.typography.caption.size;
		note.TextColor3 = theme.colors.textSecondary;
		note.TextXAlignment = Enum.TextXAlignment.Center;
		note.Text = "hold Tab · points are earned this round";
		note.LayoutOrder = 0;
		note.Parent = footer;
	}

	/**
	 * **Empties the list and draws the answer into it — the only place this file builds instances.**
	 *
	 * **Nothing accumulates, and that is the property to check rather than assume.** The container is cleared of
	 * every child *except* its layout and flex item, so a session of a hundred holds leaves one layout and one
	 * set of labels — the old ones destroyed rather than hidden. A board that only hid old rows would grow by a
	 * roster per press and keep every row it had ever drawn in the tree.
	 *
	 * **Grouped by side, then ranked by points within it**, which is the whole ordering rule: a side's rows are
	 * compared with their own side because a match is two teams, and the ranking inside one is the only one that
	 * means anything. The sort is on the number the server sent rather than on the counters, so the board and
	 * the formula cannot disagree about who is ahead — see `shared/matchStats.ts`.
	 *
	 * **A tie keeps the server's order**, which is the player list's, so repeated holds do not shuffle two
	 * players on equal points. `table.sort` is not stable, so the comparison is written to be total: equal
	 * points fall back to the name.
	 */
	private render(rows: ReadonlyArray<MatchStatsRow>): void {
		const list = this.rows;
		if (!list) return;

		for (const child of list.GetChildren()) {
			if (child.IsA("UIListLayout") || child.IsA("UIFlexItem")) continue;

			child.Destroy();
		}

		const theme = lightPanelTheme();
		const mode = this.currentMode();
		let order = 0;
		let drawn = 0;

		for (const side of SIDES) {
			const onSide = rows.filter((row) => row.side === side);
			if (onSide.size() === 0) continue;

			const ranked = onSide.sort((a, b) => {
				if (a.points !== b.points) return a.points > b.points;
				if (a.name !== b.name) return a.name < b.name;

				return false;
			});

			const heading = new Instance("TextLabel");
			heading.Name = `Side-${side}`;
			heading.Size = new UDim2(1, 0, 0, SIDE_HEADING_HEIGHT);
			heading.BackgroundTransparency = 1;
			heading.Font = theme.typography.body.font;
			heading.TextSize = theme.typography.body.size;
			// **The team's colour, from the one table that holds them** — the same call `HitLogController`
			// makes about a feed's two names, so a side is one colour everywhere on screen.
			heading.TextColor3 = teamColourOf(side) ?? theme.colors.textPrimary;
			heading.TextXAlignment = Enum.TextXAlignment.Left;
			heading.Text = sideNameOf(mode, side);
			heading.LayoutOrder = order;
			heading.Parent = list;

			order += 1;

			for (const row of ranked) {
				this.addRow(list, theme, row, order);

				order += 1;
				drawn += 1;
			}
		}

		if (drawn === 0) {
			const message = new Instance("TextLabel");
			message.Name = "Empty";
			message.Size = new UDim2(1, 0, 0, ROW_HEIGHT);
			message.BackgroundTransparency = 1;
			message.Font = theme.typography.body.font;
			message.TextSize = theme.typography.body.size;
			message.TextColor3 = theme.colors.textSecondary;
			message.TextXAlignment = Enum.TextXAlignment.Center;
			message.Text = "no one is on a side yet";
			message.LayoutOrder = order;
			message.Parent = list;
		}

		if (DEBUG) print(`[Stats] board drew — ${drawn} row(s)`);
	}

	/** One player's line: six cells, the name left-aligned and the rest centred. */
	private addRow(parent: ScrollingFrame, theme: HudTheme, row: MatchStatsRow, order: number): void {
		const line = new Instance("Frame");
		line.Name = row.name;
		line.Size = new UDim2(1, 0, 0, ROW_HEIGHT);
		line.BackgroundTransparency = 1;
		line.LayoutOrder = order;
		line.Parent = parent;

		this.fillCells(
			line,
			theme,
			[
				row.name,
				withCommas(row.points),
				withCommas(row.hits),
				withCommas(row.throws),
				withCommas(row.catches),
				withCommas(row.dodges),
			],
			(index) => COLUMNS[index].width,
			false,
		);
	}

	/**
	 * **One row's six cells, laid out horizontally by fraction** — the one piece of geometry this file shares
	 * between the headings and the rows, so a heading cannot drift off the column it names.
	 *
	 * A `UIListLayout` with `Horizontal` fill rather than six absolute positions: the widths are scale values, so
	 * the layout is what keeps them in order and gives them the panel's gaps for free. Two switches ride on the
	 * same routine because a heading is a row whose ink differs: `left` comes from the column (the name reads as
	 * a list when it starts at the left edge, and a number centred on its own width is what makes two rows
	 * comparable), while `heading` decides the type — the caption's face and the secondary ink for the strip
	 * above, the body's face and the primary ink for the rows themselves.
	 */
	private fillCells(
		row: Frame,
		theme: HudTheme,
		texts: ReadonlyArray<string>,
		widthOf: (index: number) => number,
		heading: boolean,
	): void {
		const layout = new Instance("UIListLayout");
		layout.Name = "Cells";
		layout.FillDirection = Enum.FillDirection.Horizontal;
		layout.SortOrder = Enum.SortOrder.LayoutOrder;
		layout.VerticalAlignment = Enum.VerticalAlignment.Center;
		layout.Parent = row;

		for (let index = 0; index < texts.size(); index++) {
			const column = COLUMNS[index];

			const cell = new Instance("TextLabel");
			cell.Name = column.heading;
			cell.Size = new UDim2(widthOf(index), 0, 1, 0);
			cell.BackgroundTransparency = 1;
			cell.Font = heading ? theme.typography.caption.font : theme.typography.body.font;
			cell.TextSize = heading ? theme.typography.caption.size : theme.typography.body.size;
			cell.TextColor3 = heading ? theme.colors.textSecondary : theme.colors.textPrimary;
			cell.TextXAlignment = column.left ? Enum.TextXAlignment.Left : Enum.TextXAlignment.Center;
			cell.TextYAlignment = Enum.TextYAlignment.Center;
			cell.TextTruncate = Enum.TextTruncate.AtEnd;
			cell.Text = texts[index];
			cell.LayoutOrder = index;
			cell.Parent = row;
		}
	}

	/**
	 * **The mode id, for naming a side.** `DodgeAndSeek`'s sides are `Seekers` and `Dodgers` rather than `Team A`
	 * and `Team B`, so a board that hard-coded the pair would be wrong in one of the three modes — and
	 * `sideNameOf` is the one place those names live.
	 *
	 * Read from the folder every time rather than cached in a value, because it is written once a round and this
	 * is read once a press: a subscription for a number nobody draws between presses would be a connection kept
	 * for the two seconds a panel is up. **An unrecognised id falls back to `ScoreRush`**, whose names are the
	 * `Team A`/`Team B` pair every other mode uses — the same "fall back rather than error" `sideNameOf` itself
	 * applies to an unknown label.
	 */
	private currentMode(): GameModeId {
		const status = ReplicatedStorage.FindFirstChild(ROUND_STATUS_FOLDER);
		const value = status?.GetAttribute(ROUND_MODE_ATTRIBUTE);

		if (typeIs(value, "string") && isGameModeId(value)) return value;

		return "ScoreRush";
	}
}
