import Fusion from "@rbxts/fusion-3.0";
import Net from "@rbxts/net";
import { ContextActionService, ReplicatedStorage } from "@rbxts/services";
import { ROUND_MODE_ATTRIBUTE, ROUND_STATUS_FOLDER } from "shared/constants";
import { SHOP_CONFIG } from "shared/config/shop.config";
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

/**
 * **The two sentences an empty board can say, and they are different sentences on purpose.**
 *
 * A board with no rows is one of two states that look identical and have nothing in common: **the server has
 * not answered yet**, or **the server answered and nobody is on a side**. The first is a round trip, the second
 * is an intermission that has not filled, and only one of them is a fault. The first version of this panel had
 * one sentence for both, which is why four sessions of *"the board is empty"* could not say which state the
 * player was looking at — the panel knew, and did not say.
 *
 * **So the waiting line means "no answer yet" and only that**, and it is replaced the moment any answer lands.
 * A player who sees the second sentence knows the panel works and the round has not started; a player who sees
 * the first for more than a moment is looking at a board that is not being answered, which is a different
 * report and a different file.
 */
const WAITING_TEXT = "Waiting for players…";
const NOBODY_TEXT = "Nobody is on a side yet.";

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
	 * The two remotes, resolved once at mount rather than on the first press.
	 *
	 * **`Get` yields** until the server's remote exists, and a yield inside a key handler is a frame of nothing
	 * happening after a press — the trap `ShopController.watchChest` names. Resolved from the spawned mount
	 * thread, which is already the thread that may wait. **Both** are resolved, not just the one that is sent:
	 * the answer's connection is made here too, so a press before the listener was up cannot lose its reply.
	 */
	private request?: ClientRemotes["matchStats"];

	/** The server's answer. See {@link request} for why both halves are resolved at mount. */
	private answer?: ClientRemotes["matchStatsBoard"];

	/** Where the rows go. Everything the board draws lives inside it, including the "nobody" line. */
	private rows?: ScrollingFrame;

	/**
	 * **The empty state, and it is a sibling of the list rather than a child of it** — which is the correction
	 * a report bought.
	 *
	 * It used to be a label appended to the scrolling frame, so that one clearing loop emptied the panel of
	 * rows *and* of the line explaining there were none. The reasoning was sound and the placement was not: a
	 * `ScrollingFrame` in a flex row has no height of its own until the layout gives it one, so a label inside
	 * it inherits that frame's size — and a board that drew nothing had nothing on screen to say why, which is
	 * indistinguishable from a board that never got an answer at all. **The empty state is the one thing on this
	 * panel that must be visible when the rest of it is not**, so it lives beside the list, in the content band,
	 * where nothing about the scrolling arrangement can hide it.
	 */
	private empty?: TextLabel;

	/**
	 * **Whether any answer has ever arrived**, which is the only difference between the panel's two empty states.
	 *
	 * See {@link WAITING_TEXT}: a board that has never been answered and a board answered with nought are the
	 * same pixels and different faults, and this flag is what lets the sentence say which. It is written by
	 * `receive` and read by `render`, so a panel opened before the first answer and re-opened after it says two
	 * different things without a single extra instance.
	 */
	private answered = false;

	/** The last answer, so a re-open draws instantly rather than emptying while the round trip runs. */
	private last: ReadonlyArray<MatchStatsRow> = [];

	/**
	 * Whether the one-line layout report has been printed — **once per session, and it is the line this panel has
	 * been missing for three sessions.**
	 *
	 * Every report so far could say the server had answered and nothing about what the client did with it. A
	 * board that was told `8 row(s)` and drew none is a *different* fault from one whose request was refused, and
	 * neither the server's line nor a screenshot of an empty table can tell them apart — the shape of an empty
	 * panel is identical either way. So the first answer of a session prints the row count *and the size of the
	 * frame the rows were put in*, after a frame has passed so the layouts have run. **A rows frame of
	 * `612×0 px` is the whole diagnosis**, and it is the one number that was never in any output.
	 *
	 * Once per session rather than per press, because it is an instrument and not a log: a player who opens the
	 * board twenty times should not read twenty copies of it.
	 */
	private reported = false;

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
		this.empty = this.addEmptyState(theme, content);

		this.addFooter(theme, panel);

		raiseZIndex(panel, PANEL_Z_INDEX);

		// **`wrapLabels` is deliberately not called here, and it is the one departure from the Shop's mount.**
		// That helper turns wrapping on for every label that is neither `TITLE_NAME` nor `TextScaled` nor inside
		// an auto-sizing parent — right for a panel of sentences, wrong for a table. A row cell is a *column*:
		// it has a fixed height and a width shared with every other row, so a wrapped name would be clipped by
		// the row, and `TextWrapped` also switches off the `TextTruncate` that gives a long name its ellipsis
		// instead. Every label this panel makes is one line by construction, so there is nothing here for it to
		// wrap — see {@link fillCells}, which is where the two properties are set instead.
		//
		// **This is the last *tree* statement in this method, and the two below it are the reason it is worded
		// that way.** `getHudScreenGui()` is resolved and the panel is parented here, after every band, row and
		// footer exists — a panel that went up half-built would be a frame that resizes under the player. What
		// follows touches nothing in that tree: the remote (which yields) and the key binding (which does not).
		panel.Parent = getHudScreenGui();

		this.request = events.Client.Get("matchStats");
		this.answer = events.Client.Get("matchStatsBoard");

		this.answer.Connect((rows) => this.receive(rows));

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
	 * **Asks the server, and lets the answer draw itself.** The previous answer is drawn first, so a second hold
	 * shows the last round's numbers for a frame rather than an empty panel — the wait only reads as a wait on
	 * the very first open, where there is nothing to show and nothing has been lost.
	 *
	 * **A send and not a call**, which is the change this panel needed: the answer arrives on `receive`, wired
	 * once at mount. Nothing here can fail in a way this method has to handle — a `SendToServer` on a remote that
	 * exists either goes out or the whole client is broken — where the promise this used to await could reject on
	 * a timeout, and a timeout is indistinguishable from a server that never answered. See `networking.ts` on
	 * `matchStats` for why the pair of events replaced the async function.
	 */
	private refresh(): void {
		this.render(this.last);

		this.request?.SendToServer();
	}

	/**
	 * **The server's answer, all of it** — validated, remembered, and drawn if anybody is looking.
	 *
	 * **A payload that is not a table is turned into the empty state rather than trusted.** A remote can deliver
	 * nothing, and `this.last = rows` followed by a `render` that indexes it threw inside whatever called this —
	 * which is the event's own handler, where a throw is a silent dead connection. The empty state is a sentence
	 * a player can see; a throw is not.
	 *
	 * **Remembered even when the panel is closed**, so the next open starts from the truth rather than from an
	 * empty table. The re-read of `open` after the fact is `Fusion.peek`'s own rule: a reply may land after the key
	 * has been released, and the value — not a capture taken before the round trip — is the one fact that says
	 * whether anybody is looking.
	 */
	private receive(rows: ReadonlyArray<MatchStatsRow>): void {
		this.answered = true;
		this.last = typeIs(rows, "table") ? rows : [];

		if (Fusion.peek(this.open)) this.render(this.last);

		this.reportOnce(this.last.size());

		if (DEBUG) print(`[Stats] board answered — ${this.last.size()} row(s)`);
	}

	/**
	 * **Prints what the answer was and how much room it was drawn into**, once per session — see
	 * {@link reported}.
	 *
	 * The frame's size is read a frame later rather than on the spot, because a `UIListLayout` and a
	 * `ScrollingFrame`'s automatic canvas are resolved by the engine's own layout pass: read in the same
	 * resumption the answer arrives on, every size here would be the one it had *before* the rows were added,
	 * and the number would be a lie in the direction that matters.
	 *
	 * `spawn`ed rather than awaited, so the promise this sits inside is not held open by a diagnostic.
	 */
	private reportOnce(rowCount: number): void {
		if (this.reported) return;
		this.reported = true;

		const list = this.rows;
		if (list === undefined) return;

		task.spawn(() => {
			task.wait();

			const drawn = list.GetChildren().filter(
				(child) => !child.IsA("UIListLayout") && !child.IsA("UIFlexItem"),
			).size();

			print(
				`[Stats] board answered — ${rowCount} row(s), ${drawn} drawn into a frame ` +
					`${string.format("%.0f", list.AbsoluteSize.X)}×${string.format("%.0f", list.AbsoluteSize.Y)} px ` +
					`(visible ${list.Visible ? "yes" : "no"})`,
			);
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
	 *
	 * **The height is arithmetic, and it used to be a `UIFlexItem` — which is the bug behind an empty board that
	 * answered `8 row(s)` on the server.** The first version copied `addShelf`'s "take the rest" verbatim: a
	 * zero size plus `UIFlexItem{FlexMode = Fill}`, on `addColumns`' argument that this is how a `UIListLayout`
	 * spells `flex: 1`. It is — for a plain `Frame`, which is what the content band and the fill column are. **A
	 * `ScrollingFrame` is not resized by a flex item here**, so this frame stayed at the height it was given,
	 * which was nought: the headings above it drew, eight rows were built and parented into it every press, and
	 * none of them had anywhere to be. A screenshot of the panel shows exactly that — the column headings and
	 * then nothing — and its own empty-state label was invisible for the same reason, which is why the board
	 * looked identical whether the server had answered or not.
	 *
	 * **So the height is written out: everything the band has, less the heading strip and the two gaps.** The
	 * band's own height is the panel's remainder (`addContentBand`), its `UIPadding` takes `PAD_Y` off the top
	 * and the bottom, and this list is the last item in the band's stack after a `ROW_HEIGHT` strip and one
	 * `ROW_GAP`. Subtracting the padding as well as the two gaps is deliberate: **it is right in both readings**
	 * of `UIPadding` — a scale child that is measured against the padded area lands exactly, and one measured
	 * against the raw frame lands sixteen pixels short, which is a small gap at the bottom of a list that
	 * scrolls. Erring long would instead have cut the last row in half.
	 */
	private addRowList(content: Frame): ScrollingFrame {
		const list = new Instance("ScrollingFrame");
		list.Name = "Rows";
		list.Size = new UDim2(1, 0, 1, -(ROW_HEIGHT + ROW_GAP + 2 * SHOP_CONFIG.PAD_Y));
		list.LayoutOrder = 1;
		list.BackgroundTransparency = 1;
		list.BorderSizePixel = 0;
		list.ScrollBarThickness = 4;
		list.ScrollBarImageTransparency = 0.4;
		list.CanvasSize = UDim2.fromOffset(0, 0);
		list.AutomaticCanvasSize = Enum.AutomaticSize.Y;
		list.ElasticBehavior = Enum.ElasticBehavior.Never;
		list.Parent = content;

		const layout = new Instance("UIListLayout");
		layout.Name = "RowLayout";
		layout.FillDirection = Enum.FillDirection.Vertical;
		layout.SortOrder = Enum.SortOrder.LayoutOrder;
		layout.Padding = new UDim(0, ROW_GAP);
		layout.Parent = list;

		return list;
	}

	/**
	 * **The "nobody yet" line, built once and switched by `Visible`** — a sibling of the row list, in the
	 * content band, on `addColumns`' rule that a thing which must be seen is not put inside the thing that
	 * scrolls.
	 *
	 * Built once rather than rebuilt per press, because it is one label whose *existence* does not depend on the
	 * answer: a press with rows hides it and a press without shows it, and neither case destroys an instance.
	 * That is the opposite of the rows, which are rebuilt — see {@link render} for why the two differ.
	 *
	 * **`LayoutOrder` above the footer and below the list**, which is where a sentence explaining an empty table
	 * belongs. `UIListLayout` skips a `Visible = false` child entirely, so the list and this label share the
	 * band without either reserving space for the other — which is what makes the swap a property write rather
	 * than a re-layout. `AutomaticSize.Y` and a wrapped sentence, because this is the one label here that is
	 * prose rather than a column: a phone narrow enough to wrap it should grow the line rather than clip it.
	 */
	private addEmptyState(theme: HudTheme, content: Frame): TextLabel {
		const message = new Instance("TextLabel");
		message.Name = "Empty";
		message.Size = new UDim2(1, 0, 0, ROW_HEIGHT * 2);
		message.AutomaticSize = Enum.AutomaticSize.Y;
		message.BackgroundTransparency = 1;
		message.Font = theme.typography.body.font;
		message.TextSize = theme.typography.body.size;
		message.TextColor3 = theme.colors.textSecondary;
		message.TextXAlignment = Enum.TextXAlignment.Center;
		message.TextYAlignment = Enum.TextYAlignment.Center;
		message.TextWrapped = true;
		message.Text = WAITING_TEXT;
		message.LayoutOrder = 2;
		message.Visible = false;
		message.Parent = content;

		return message;
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
	 * **A tie keeps the order the server sent**, which is players then rigs, so repeated holds do not shuffle two
	 * bodies on equal points. `table.sort` is not stable, so the comparison is written to be total: equal
	 * points fall back to the name.
	 *
	 * **The rows and the empty state are drawn by different means, and the difference is what each one is for.**
	 * A row is transient — a different set on every press, and destroyed and rebuilt each time — while the line
	 * that explains an empty table is permanent: one label, built at mount, that this method shows or hides.
	 * **That split is the fix for a board that was blank with nothing to say why**: the "nobody yet" text used
	 * to be a row like any other, appended to the scrolling frame, and a frame that has no height of its own
	 * cannot show a label inside it. `drawn === 0` now hides the list and shows the label — which is also the
	 * arrangement that makes the two mutually exclusive by construction rather than by convention.
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

		// **One of the two is always visible, and neither is ever both.** An empty table is a sentence, and a
		// sentence needs to be somewhere the flex cannot collapse it; a populated one needs the scroller. Hiding
		// the list also takes it out of the band's list layout, so the sentence is not pushed to the bottom of a
		// frame sized for rows that are not there. See `addEmptyState`.
		//
		// **And the sentence is chosen by `answered`, not by the row count.** *"Waiting for players…"* is a round
		// trip that has not landed; *"Nobody is on a side yet."* is an answer that says the intermission has not
		// filled. Same pixels, different faults — see {@link WAITING_TEXT} for the four sessions that cost.
		list.Visible = drawn > 0;

		const empty = this.empty;
		if (empty !== undefined) {
			empty.Text = this.answered ? NOBODY_TEXT : WAITING_TEXT;
			empty.Visible = drawn === 0;
		}

		if (DEBUG) print(`[Stats] board drew — ${drawn} row(s)`);
	}

	/**
	 * **One body's line** — six cells, the name left-aligned and the rest centred.
	 *
	 * **A "body" rather than a player, and that is the whole of what the row can tell a rig from a person
	 * apart: nothing.** `row.name` is a plain string the server took from `Player.Name` or `Model.Name`, and
	 * every other field is a number, so this method has no branch and needs none — a rig's line is built by
	 * exactly the code that builds a player's. **What it deliberately does not do:** look the name up on
	 * `Players`, request a headshot, or draw an avatar. A board that resolved a row through `Players` would
	 * have to answer "what is this?" for a name that is not there, and the answer would be a column of blank
	 * heads for the eight bodies that actually played. The name is the identity the server chose, and the
	 * card's job is to print it.
	 */
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
