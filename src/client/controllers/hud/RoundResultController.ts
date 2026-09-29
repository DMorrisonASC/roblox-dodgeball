import { Controller, OnStart } from "@flamework/core";
import { Button, Card, Text } from "@rbxts/big-ui";
import Fusion from "@rbxts/fusion-3.0";
import { Players, ReplicatedStorage } from "@rbxts/services";
import { ROUND_STATE_ATTRIBUTE, ROUND_STATUS_FOLDER, ROUND_TIME_ATTRIBUTE } from "shared/constants";
import { isGameModeId, sideNameOf } from "shared/gameMode";
import { events, RoundResultRow } from "shared/networking";
import { hudTheme } from "../../ui/hudTheme";
import { getHudScreenGui } from "../../ui/screenGui";
import { addViewportConstraint } from "../../ui/viewportConstraint";

/** Prints once when the panel is built, and once per result it is handed. */
const DEBUG = true;

/**
 * The phase the panel is allowed to be on screen in. A word between two files, not a setting.
 *
 * **It is not a check on whether there is a result; it is a wait for the intermission.** The result
 * is sent from `RoundService.finishRound`, which runs a moment *before* the round's phase becomes
 * `Intermission` — so without this the panel would flash up over the last frame of the round it is
 * about, next to a top bar still reading `Playing`.
 */
const INTERMISSION = "Intermission";

/** The panel's name, so a stray frame can be told from anything else on the screen. */
const PANEL_NAME = "RoundResultPanel";

/**
 * Where the panel sits in the ZIndex order: **above everything else this game draws.**
 *
 * The shop is the tallest thing in the project until now, at `SHOP_CONFIG.PANEL_Z_INDEX` (10) — and
 * a shop left open through the end of a round is not a reason to hide the result of it. Anything
 * added later that must sit above *this* has to be given a higher number, and this is the line that
 * says what the current top is.
 */
const PANEL_Z_INDEX = 20;

/** The panel's width, as a share of the screen. Its height is its own content's. */
const PANEL_WIDTH_SCALE = 0.42;

/** The widest the panel may get, in pixels — a name and a count do not need an ultrawide. */
const PANEL_MAX_WIDTH = 420;

/** The gap between the dismiss button and the title, in pixels. */
const HEADER_GAP = 8;

/** The gap between two rows of the board, in pixels. */
const ROW_GAP = 4;

/** The gap between the face, the name and the figure inside one row, in pixels. */
const ROW_ITEM_GAP = 8;

/**
 * The face's size, in pixels — square, and round once the corner is applied.
 *
 * The one element on this panel that is not laid out by the screen it is on: a thumbnail is a fixed
 * picture, so there is no proportion of anything for it to take. Everything beside it flexes around
 * this number, which is the point of giving it one.
 */
const FACE_SIZE = 36;

/**
 * The width of the figures' column, in pixels.
 *
 * **A column rather than each label hugging its own text**, so that `Hits: 9 | Outs: 1` and
 * `Hits: 14 | Outs: 0` end at the same place down the board, and the names beside them are not
 * pushed around by a count gaining a digit. Wide enough for the two figures at their longest —
 * `Hits: 999 | Outs: 999` at `body2` — and no wider.
 */
const FIGURE_WIDTH = 160;

/**
 * How much intermission is left when the panel takes itself away, in seconds.
 *
 * **A deadline rather than a wall clock, and it is the round's own clock that provides it.** The
 * panel is a thing to read during the gap between rounds, and the gap has a number counting it down
 * on the same screen — so the rule is "leave when that number has nearly run out", which needs no
 * timer of this controller's own and cannot disagree with what the player can see. It also gives
 * *both* frozen cases the right answer without naming either of them: an intermission held for a
 * missing lobby, and one frozen for want of players, do not decrement — so the panel stays, which is
 * correct, because the intermission they are in has not begun to elapse.
 *
 * **The alternative is a `task.delay` from the moment the result arrives**, and it is the one thing
 * that could not be made right: a fixed five seconds runs through a frozen intermission as happily as
 * a running one, and then dismisses a panel while the round it describes is still the last thing
 * anybody played. A server that filled up an hour later would have shown a result nobody had time to
 * read.
 *
 * The last five seconds rather than the last fifteen, because the vote closes twenty seconds into a
 * thirty-second intermission: fifteen would take the panel away with the vote still open, which is
 * the moment a player is most likely to be looking at the screen.
 */
const AUTO_DISMISS_SECONDS = 5;

/**
 * The result of the round that has just finished, over the middle of the screen.
 *
 * **This is the top bar's winner segment, moved and given room.** It used to be appended to the
 * status line as `… | Team A won`, which is a sentence with nowhere to put the rest of what a result
 * is: the figures the round was decided by. Here the side that won gets a heading, and the players
 * who were in it get a line each with the round's own hits and outs beside their name — a shape a
 * line of text cannot take — and the status line goes back to being about the phase, the clock and
 * the mode.
 *
 * **Who is on the board is the server's decision, not this file's.** The rows arrive already
 * filtered to the winning side and already ordered, because the counter they come from is the
 * server's and the ranking is a fact about the round. So the only membership rule stated here is
 * that the list *is* the message: a round with no winner is a round with no message, which is the
 * panel's empty state, and this file never has to know the word the server uses for a draw.
 * A leaver is absent from the board — see `RoundService.sendResult` for why the rows are built from
 * the players who are still here rather than from the round's own roster, and note that under the
 * roster rule the side that *left* is the side that lost.
 *
 * **Dismissal is local, and nothing about it is sent anywhere.** The button and the clock both
 * write one `Value` on this machine, so a player who has read the board can put it away while the
 * rest of the server is still looking at theirs. That is the whole of the client's authority here:
 * it decides what is on *its* screen, and has no opinion about the round, the result, or who was on
 * the board.
 *
 * One panel for the whole session, built once and hidden rather than destroyed, so nothing here is
 * rebuilt between rounds — except the rows, which big-ui leaves no choice about. See
 * {@link fillBoard}.
 */
@Controller()
export class RoundResultController implements OnStart {
	private readonly scope = Fusion.scoped();

	/** Whether a result has arrived, and the panel is allowed to be on screen. */
	private readonly hasResult = Fusion.Value(this.scope, false);

	/** Whether *this* result has been dismissed — by the button, or by the clock running down. */
	private readonly dismissed = Fusion.Value(this.scope, false);

	/** The heading: the side that won, in the words the mode uses for sides. */
	private readonly title = Fusion.Value(this.scope, "");

	/** The round's phase, so the panel can wait for the intermission its result belongs to. */
	private readonly phase = Fusion.Value(this.scope, "");

	/**
	 * Where the rows go.
	 *
	 * Assigned in `mount` before anything can arrive, which is why it is a definite field rather
	 * than one the reader has to check — the same shape, and the same reasoning, as
	 * `RoundService.statusFolder`.
	 */
	private board!: Frame;

	public onStart(): void {
		// Spawned rather than done inline, matching every other HUD: mounting waits for a folder the
		// *server* makes, and a controller's `onStart` is the wrong place to hold up the rest of the
		// client's boot for something that is not there yet.
		task.spawn(() => this.mount());
	}

	private mount(): void {
		const folder = ReplicatedStorage.WaitForChild(ROUND_STATUS_FOLDER);

		// Subscribed *before* seeding, so a change landing between the two is not lost — the seed
		// then reads the newer value and wins, which is the order that cannot go wrong either way.
		// The same pair, and the same reason, as `RoundStatusController`.
		this.scope.push(
			folder.GetAttributeChangedSignal(ROUND_STATE_ATTRIBUTE).Connect(() => this.readPhase(folder)),
		);

		this.readPhase(folder);

		this.board = this.buildPanel();

		this.watchClock(folder);
		this.subscribe();

		if (DEBUG) print("[HUD] round result panel up");
	}

	/** The phase, off the folder. A folder that has not said is not an intermission. */
	private readPhase(folder: Instance): void {
		const value = folder.GetAttribute(ROUND_STATE_ATTRIBUTE);

		if (typeIs(value, "string")) this.phase.set(value);
	}

	/**
	 * Builds the panel, and returns the frame the rows are to be hung in.
	 *
	 * **Three facts decide whether it is on screen, and all three are read before anything is
	 * decided.** Fusion derives a `Computed`'s dependencies from the `use` calls that actually run,
	 * so a read placed inside an `if` is a subscription that exists only while that branch is taken —
	 * the trap `RoundStatusController` records having lost a HUD to. There is no branching here at
	 * all: the three values are read, and the answer is one expression.
	 */
	private buildPanel(): Frame {
		const visible = Fusion.Computed(this.scope, (use) => {
			const has = use(this.hasResult);
			const gone = use(this.dismissed);
			const phase = use(this.phase);

			return has && !gone && phase === INTERMISSION;
		});

		const wrapper = Fusion.New(this.scope, "Frame")({
			Name: PANEL_NAME,
			// Proportional across, and as tall as its own card. The `UISizeConstraint` below is what
			// stops a share of an ultrawide becoming a letterbox.
			Size: new UDim2(PANEL_WIDTH_SCALE, 0, 0, 0),
			AutomaticSize: Enum.AutomaticSize.Y,
			AnchorPoint: new Vector2(0.5, 0.5),
			Position: UDim2.fromScale(0.5, 0.5),
			BackgroundTransparency: 1,
			Visible: visible,
			ZIndex: PANEL_Z_INDEX,
		});

		addViewportConstraint(this.scope, wrapper, { max: new Vector2(PANEL_MAX_WIDTH, math.huge) });

		const board = this.buildBoard();

		// **No `size` on the `Card`, and that is the whole trick** — big-ui sizes a card's *height*
		// to its contents only when it has been given no size at all, which is what lets the panel
		// grow with a board of any length. The card also brings the theme's own surface, corner and
		// padding with it, which is the reason to use it rather than a bare frame: the LIGHT palette
		// has no surface darker than paper, so a hand-built panel would need a colour invented for it
		// — the position `ShopController` is in, and one this panel does not have to be.
		const card = Card(this.scope, { children: [this.buildHeader(), board] });
		card.Parent = wrapper;

		// **Every descendant at the panel's own ZIndex, and this is not tidiness.** Roblox only draws
		// a child above its parent when the child's `ZIndex` is at least the parent's, so lifting the
		// panel over the other HUDs and leaving its contents alone would paint the card's own
		// background *over* everything inside it. See `raiseZIndex`.
		raiseZIndex(wrapper, PANEL_Z_INDEX);

		wrapper.Parent = getHudScreenGui();

		return board;
	}

	/**
	 * The heading band: the dismiss button first, then the title.
	 *
	 * The button leads the row, and the row is horizontal, so "the top-left of the panel" is a
	 * consequence of the order rather than a position anybody chose — the standard's flexbox, and the
	 * same header shape `ShopController` uses.
	 */
	private buildHeader(): Frame {
		const header = Fusion.New(this.scope, "Frame")({
			Name: "Header",
			Size: new UDim2(1, 0, 0, 0),
			AutomaticSize: Enum.AutomaticSize.Y,
			BackgroundTransparency: 1,
		});

		Fusion.New(this.scope, "UIListLayout")({
			Parent: header,
			FillDirection: Enum.FillDirection.Horizontal,
			SortOrder: Enum.SortOrder.LayoutOrder,
			VerticalAlignment: Enum.VerticalAlignment.Center,
			Padding: new UDim(0, HEADER_GAP),
		});

		const dismiss = Button(this.scope, {
			label: "X",
			size: "small",
			color: "error",
			layoutOrder: 1,
			onActivate: () => this.dismiss(),
		});
		dismiss.Parent = header;

		// The title observes the `Value` directly — a big-ui label takes a `UsedAs<string>`, so a
		// `Value` is already the right shape and a `Computed` wrapping one would be a graph built to
		// do nothing. The heading is the one label here whose text changes, which is why it is fed
		// rather than written at construction like the rows are.
		Text(this.scope, { text: this.title, variant: "h5", layoutOrder: 2 }).Parent = header;

		return header;
	}

	/**
	 * The band the rows live in.
	 *
	 * A frame of its own, rather than the card's own layout doing the work, because the rows are
	 * replaced wholesale while the header is not — and because a list that owns its own gap is the
	 * one place the spacing between two players is decided. See {@link fillBoard} for the second half
	 * of that: the rows are children of this, not of the card.
	 */
	private buildBoard(): Frame {
		const board = Fusion.New(this.scope, "Frame")({
			Name: "Board",
			Size: new UDim2(1, 0, 0, 0),
			AutomaticSize: Enum.AutomaticSize.Y,
			BackgroundTransparency: 1,
		});

		Fusion.New(this.scope, "UIListLayout")({
			Parent: board,
			FillDirection: Enum.FillDirection.Vertical,
			SortOrder: Enum.SortOrder.LayoutOrder,
			Padding: new UDim(0, ROW_GAP),
		});

		return board;
	}

	/**
	 * Takes the panel away when the intermission is nearly over.
	 *
	 * **The phase is asked first, because the same attribute counts a round down as well.** Without
	 * that check the last five seconds of *play* would take the panel away — and it would do it
	 * before the round they belong to had finished, since the result is sent before the phase
	 * changes.
	 *
	 * Nothing here is undone by the next intermission: the flag this writes is released by the next
	 * result rather than by a timer, so a panel dismissed in one gap is back for the ending that
	 * follows the next round. See {@link AUTO_DISMISS_SECONDS} for why the clock is the right
	 * deadline and a `task.delay` is not.
	 */
	private watchClock(folder: Instance): void {
		this.scope.push(
			folder.GetAttributeChangedSignal(ROUND_TIME_ATTRIBUTE).Connect(() => {
				const phase = folder.GetAttribute(ROUND_STATE_ATTRIBUTE);
				if (phase !== INTERMISSION) return;

				const left = folder.GetAttribute(ROUND_TIME_ATTRIBUTE);
				if (!typeIs(left, "number") || left > AUTO_DISMISS_SECONDS) return;

				this.dismissed.set(true);
			}),
		);
	}

	/**
	 * Takes the result when the server sends one.
	 *
	 * **`Get` rather than `OnEvent`**, because this is wired exactly once for the life of the client
	 * and there is no per-call helper for anything to save — it yields until the remote exists, which
	 * is the reason the whole of this runs from `onStart`'s spawn rather than inline.
	 *
	 * **The shape is checked even though a client cannot forge it.** What arrives is typed by the
	 * declaration and *not* by the wire, so a server a version ahead — or a row this build has no
	 * business drawing — has to be a panel that shows less rather than a client that errors in the
	 * middle of an intermission. See `readRows`.
	 */
	private subscribe(): void {
		this.scope.push(
			events.Client.Get("roundResult").Connect((mode, winner, rows) => {
				if (!typeIs(mode, "string") || !typeIs(winner, "string")) return;

				const board = readRows(rows);

				this.title.set(describeWinner(mode, winner));
				this.fillBoard(this.board, board);

				// The latch is released by the *next* result rather than by the phase coming round
				// again, so a result dismissed early in one intermission is not what greets the next
				// round's ending.
				this.dismissed.set(false);
				this.hasResult.set(true);

				// **The line that separates "nothing arrived" from "nothing drew".** The heading is
				// set from the same message, so a title with no board under it means the rows were
				// rejected here rather than never sent — and `typeOf` is printed because a server a
				// version away sending something that is not a table at all is the other way this
				// looks.
				if (DEBUG) {
					print(`[HUD] round result — ${this.title}, rows ${typeOf(rows)} → ${board.size()} usable`);
				}
			}),
		);
	}

	/** Client-local, and the whole of what the button does. See the class comment. */
	private dismiss(): void {
		this.dismissed.set(true);

		if (DEBUG) print("[HUD] round result dismissed");
	}

	/**
	 * Replaces the board's rows with `rows`.
	 *
	 * **Rebuilt rather than updated, because a component's contents are taken at construction.** A
	 * big-ui label cannot be told to say something else afterwards — the same constraint
	 * `ShopController` documents for its panes and `ModeVoteController` for its buttons — so a board
	 * that follows the data is a board whose rows are thrown away and built again. It is a side's
	 * worth of rows, once a round, so the cost of building it twice is a handful of instances.
	 */
	private fillBoard(board: Frame, rows: RoundResultRow[]): void {
		for (const child of board.GetChildren()) {
			// **Only the rows.** The board's own `UIListLayout` is a child like any other, and
			// destroying it would leave every row stacked at the top-left of the frame.
			if (child.IsA("GuiObject")) child.Destroy();
		}

		for (let index = 0; index < rows.size(); index++) {
			const item = this.buildRow(rows[index], index);

			// **The whole row is raised, not just the row.** A row is a container: its face, its name
			// and its figure are children of it, and a parent is drawn over its own children unless
			// the children carry at least the parent's `ZIndex` — so raising the row alone would put
			// its own background on top of its own contents. The same trap `raiseZIndex` describes
			// for the panel, one level down, which is why the helper is applied to the row rather
			// than a number being assigned to it.
			raiseZIndex(item, PANEL_Z_INDEX);
			item.Parent = board;
		}
	}

	/**
	 * One player's line: their face, their name, and the two figures the board is about.
	 *
	 * **A row built here rather than big-ui's `ListItem`**, which is the component this shape looks
	 * like it wants. Two reasons, and the first is the one that decides it: `ListItem` puts its
	 * `primary` and `secondary` on *separate lines*, and its `trailing` — the slot a figure would go
	 * in — sits after a text column that is sized to the row's **full width**, so a trailing element
	 * is pushed past the row's edge rather than given the space that is left. Second, what is wanted
	 * here is a line of three things with a flex gap between them, which is the standard's flexbox
	 * and is exactly what `ModeVoteController`'s option row does.
	 *
	 * **The face is an `ImageLabel`, because big-ui has no headshot.** `Avatar` reads like the right
	 * component and is not: it draws a label on a colour, for initials, and takes no user id. So the
	 * one element the library cannot draw is drawn here, and filled in by {@link loadFace}.
	 *
	 * The theme is read here rather than at module load, because `ThemeController` configures the
	 * theme before any HUD mounts, and a constant evaluated on require would be read too early.
	 */
	private buildRow(row: RoundResultRow, index: number): Frame {
		const item = Fusion.New(this.scope, "Frame")({
			Name: `Result${index}`,
			Size: new UDim2(1, 0, 0, 0),
			AutomaticSize: Enum.AutomaticSize.Y,
			BackgroundTransparency: 1,
			LayoutOrder: index,
		});

		Fusion.New(this.scope, "UIListLayout")({
			Parent: item,
			FillDirection: Enum.FillDirection.Horizontal,
			SortOrder: Enum.SortOrder.LayoutOrder,
			VerticalAlignment: Enum.VerticalAlignment.Center,
			Padding: new UDim(0, ROW_ITEM_GAP),
		});

		const face = Fusion.New(this.scope, "ImageLabel")({
			Name: "Face",
			Size: UDim2.fromOffset(FACE_SIZE, FACE_SIZE),
			// The colour the picture sits on until it arrives — and it is `textDisabled` rather than
			// the `trough`, which is what it was first. A trough is deliberately the darkest surface
			// the palette has, so a row whose picture had not loaded read as a black hole where a
			// face belongs. "Unavailable" is the job this colour is named for, and that is what an
			// empty face is.
			BackgroundColor3: hudTheme().colors.textDisabled,
			LayoutOrder: 1,
		});

		// A square with a full corner is a circle, and it is the corner rather than an asset that
		// makes a headshot round — the picture itself is square.
		Fusion.New(this.scope, "UICorner")({ Parent: face, CornerRadius: new UDim(1, 0) });
		face.Parent = item;

		this.loadFace(face, row.userId);

		// The name takes whatever the two fixed columns leave: `Fill` is `flex: 1`, so no width here
		// is a number anyone chose. A big-ui `Text` given no `size` is already `(1, 0, lineHeight)`
		// with an automatic height, which is precisely what a flex item in a row wants — the flex
		// mode overrules the width and the height comes from the variant.
		const name = Text(this.scope, { text: row.name, variant: "body1", layoutOrder: 2 });
		Fusion.New(this.scope, "UIFlexItem")({ Parent: name, FlexMode: Enum.UIFlexMode.Fill });
		name.Parent = item;

		// **Both figures are named rather than left as bare numbers**, which is the rule the stat
		// billboard argues for at length: a number beside somebody's name is a small puzzle, and
		// `Hits:` and `Outs:` cost two words to remove the puzzle. Joined the same way that billboard
		// joins its own, so the two surfaces read as one record rather than two dialects of it.
		const figure = Text(this.scope, {
			text: `Hits: ${row.hits} | Outs: ${row.outs}`,
			variant: "body2",
			align: Enum.TextXAlignment.Right,
			size: UDim2.fromOffset(FIGURE_WIDTH, 0),
			layoutOrder: 3,
		});

		// **The automatic axis, put back on the height.** big-ui takes `AutomaticSize` off entirely
		// when a `Text` is given a size, so a label given a width and no height would be zero pixels
		// tall — a figure that is there and cannot be read.
		figure.AutomaticSize = Enum.AutomaticSize.Y;
		figure.Parent = item;

		return item;
	}

	/**
	 * Puts `userId`'s headshot on `face`, when one arrives.
	 *
	 * **`rbxthumb://` was tried first, and drew nothing.** It is the tempting answer — a content URL
	 * the engine resolves with no web request and no yield — but the row came out as its placeholder
	 * with an `Image` that never resolved, so the picture is asked for properly instead:
	 * `GetUserThumbnailAsync` answers with a real content URL and a flag saying whether it is ready.
	 *
	 * **Spawned, because that call yields.** A row is built inside a remote's handler, and holding
	 * that thread for a web request would hold up every row behind it — and the frame the panel is
	 * being assembled in. Spawned *per row*, so a slow thumbnail delays nothing but itself, and it
	 * does not matter which order they land in: each call writes to its own label.
	 *
	 * **`pcall`, because this is the one kind of call that fails for reasons the game has no say
	 * in**, and a board is not worth an error in the middle of an intermission. `ready` is checked
	 * rather than trusted: the API answers with a placeholder URL when it has nothing yet, and a
	 * placeholder picture is worse than the colour the label is already wearing.
	 *
	 * The last check is not defensive: rows are destroyed and rebuilt on every result, so a thumbnail
	 * that arrives late can belong to a row that no longer exists. Writing to it would be harmless
	 * and pointless, so it is skipped.
	 */
	private loadFace(face: ImageLabel, userId: number): void {
		task.spawn(() => {
			const [ok, url, ready] = pcall(() =>
				Players.GetUserThumbnailAsync(userId, Enum.ThumbnailType.HeadShot, Enum.ThumbnailSize.Size100x100),
			);

			if (!ok) {
				if (DEBUG) warn(`[HUD] no headshot for ${userId}: ${url}`);

				return;
			}

			if (!ready) return;

			if (!face.IsDescendantOf(game)) return;

			face.Image = url;
		});
	}
}

/**
 * The panel's heading: which side won, in the words that mode uses for its sides.
 *
 * Takes the mode as a plain `string`, because that is how it arrives — off a wire, from a server
 * that may be a version away. A mode this build does not know falls back to `Team X` rather than
 * erroring, the same fallback the status line used when the winner was a segment of it: "Team A won"
 * is still true even when the client cannot say what a "Team A" is called this round.
 */
function describeWinner(mode: string, winner: string): string {
	if (!isGameModeId(mode)) return `Team ${winner} won`;

	return `${sideNameOf(mode, winner)} won`;
}

/**
 * The rows as far as this build can trust them, dropping anything that is not one.
 *
 * **A client cannot forge this event, so this is not defence against a player** — it is what stops a
 * server whose shape has moved on from breaking a client that is a version behind. A row is an id, a
 * name and a count, or it is nothing: something that is not a name is not a name to print and not an
 * id to draw a face from, so the entry goes, the rest of the board stays, and the panel draws.
 *
 * The id is checked for being a number and **not** for being a real one. There is no cheap way to ask
 * whether a user id exists, and the answer does not matter here: a face that cannot be resolved draws
 * as the placeholder behind it, which is the same thing a slow thumbnail does.
 */
function readRows(value: unknown): RoundResultRow[] {
	const rows: RoundResultRow[] = [];

	if (!typeIs(value, "table")) return rows;

	for (const entry of value as Array<unknown>) {
		if (!typeIs(entry, "table")) continue;

		const record = entry as Record<string, unknown>;
		const userId = record["userId"];
		const name = record["name"];
		const hits = record["hits"];
		const outs = record["outs"];

		if (!typeIs(userId, "number") || !typeIs(name, "string")) continue;
		if (!typeIs(hits, "number") || !typeIs(outs, "number")) continue;

		rows.push({ userId, name, hits, outs });
	}

	return rows;
}

/**
 * Push `z` onto every `GuiObject` beneath `root`.
 *
 * **Not optional, and not tidiness.** Roblox sorts `GuiObject`s by `ZIndex` and only draws a child
 * above its parent when the child's `ZIndex` is at least the parent's — so raising the panel to
 * `PANEL_Z_INDEX` to lift it over the other HUDs also paints its own opaque background *over* every
 * child. Every descendant has to carry the same number; then draw order falls back to the hierarchy
 * and children sit on top of their own parent again.
 *
 * **A copy of the helper `ShopController` keeps privately.** Two controllers wanting the same
 * ten-line function is the point at which it could move into `src/client/ui/`, and it has been left
 * where it is for now because that is a change to a module three other HUDs read rather than
 * something this panel needs.
 */
function raiseZIndex(root: Instance, z: number): void {
	for (const descendant of root.GetDescendants()) {
		if (descendant.IsA("GuiObject")) descendant.ZIndex = z;
	}
}
