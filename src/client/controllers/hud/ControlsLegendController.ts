import { Controller, OnStart } from "@flamework/core";
import { Text } from "@rbxts/big-ui";
import Fusion from "@rbxts/fusion-3.0";
import { RunService, UserInputService } from "@rbxts/services";
import { isMobile } from "../../platform";
import { makePressResponse } from "../../ui/elevation";
import { HudTheme, hudTheme } from "../../ui/hudTheme";
import { getHudScreenGui } from "../../ui/screenGui";
import { addViewportConstraint } from "../../ui/viewportConstraint";

/** Prints once, when the legend is up — the line that says the controller ran at all. */
const DEBUG = true;

/** How far the legend sits from the right screen edge, and how far apart its rows are. */
const SCREEN_EDGE_GAP = 12;
const ROW_SPACING = 2;
const LABEL_GAP = 8;

/**
 * How far the legend's last row sits above the bottom of the screen, in pixels.
 *
 * **A second gap rather than a reuse of `SCREEN_EDGE_GAP`, because the two are not the same measurement.**
 * One is the card's own margin from the side of the screen; this is how far up the column stands from the
 * bottom of it. Nothing ties them together, and keeping them apart is what lets the column be nudged
 * vertically without moving it sideways.
 */
const BOTTOM_EDGE_GAP = 10;

/**
 * One line of the legend: what an ability is, and how it is asked for.
 *
 * Everything the legend draws comes from these, and nothing else in the file names an ability.
 * Adding a row — a new key, a new control — is one entry in {@link ROWS} and no other change
 * anywhere, which is the whole point of the shape: the legend is a *reading* of this list rather
 * than a set of labels that happens to look like one.
 *
 * **And every row is the same shape now, which it was not before.** A row used to be able to name a
 * player *attribute* and dim itself while that attribute said the thing it named was switched off —
 * `toggleAttribute` and `invert`, with `isOff` deciding the polarity — and the throw toggle was its only
 * user. That row is gone (see {@link ROWS}), and the machinery went with it rather than being kept warm
 * for a second user: what is left is one question per row and one answer, which is the press.
 */
interface LegendRow {
	/** The ability, named the way a player would name it. */
	label: string;

	/**
	 * The control, written the way a player would find it on their keyboard.
	 *
	 * A literal string, deliberately: this is a card telling somebody which key to press, so
	 * the key *is* the content. Nothing else in the game should be reading these — the bindings
	 * themselves live in the controllers that own the actions.
	 */
	keys: string;

	/**
	 * Whether this row's control is down **right now**.
	 *
	 * **The one fact on this card that is a copy of something, and it is a deliberate one.** {@link keys}
	 * is the string a player reads; this is the inputs that answer it, and the two describe one binding
	 * from its two ends. `sprinting.ts` argues against exactly this shape — *"not a second read of the
	 * key"* — and its reason does not reach here: that rule is about a **game rule**, where a drifted copy
	 * would make the legs disagree with the sprint the server actually granted. This is a card, and what it
	 * is drawn *as* is the key going down. The bindings still live in the controllers that own the actions;
	 * what is repeated here is the input, and the two are written on **one line each** in {@link ROWS} so
	 * that the day a binding moves, the copy that has to move with it is on the same line and in the same
	 * file rather than in another module.
	 *
	 * **Polled, not counted.** This is a question — "is it down" — rather than a stream of events, and
	 * `IsKeyDown` cannot come out of step with an event that was missed or arrived while the window was not
	 * focused. See `mount` for the one loop that reads all of them, and `makePressResponse` for what the
	 * answer does.
	 */
	held: () => boolean;
}

/**
 * The movement keys a dodge accepts — **both of the game's sets.**
 *
 * `DodgeController.COMBO_AXES` has rows for `WASD` *and* for `UHJK`, because a dodge has to be available
 * from either hand (`AlternativeMovementController` moves the body with the second set) — so a dodge that
 * came out of `U` and a right-click has to light this card's box exactly as one out of `W` does. The card
 * itself names only the default four, which is what a card is for: it is telling a player which keys to
 * try, not enumerating everything the game would accept.
 */
const DODGE_MOVEMENT_KEYS: Array<Enum.KeyCode> = [
	Enum.KeyCode.W,
	Enum.KeyCode.A,
	Enum.KeyCode.S,
	Enum.KeyCode.D,
	Enum.KeyCode.U,
	Enum.KeyCode.H,
	Enum.KeyCode.J,
	Enum.KeyCode.K,
];

/** Whether any of `keys` is down, as a loop so it reads as the one question it is. */
function anyDown(keys: Array<Enum.KeyCode>): boolean {
	for (const key of keys) {
		if (UserInputService.IsKeyDown(key)) return true;
	}

	return false;
}

/**
 * The legend, in the order it is drawn.
 *
 * Seven rows, and the count has moved twice. It was six; it became eight when `X` and `C` were replaced by
 * the charged throw and the card grew the two rows the throw actually needs; and it is seven now that the
 * throw *toggle* has retired, taking the `2` key, its row here, and the two toasts that announced it with
 * it. The lines here are the *only* place these strings appear — no other file names a key or an ability —
 * so this array is the legend, and everything below it is layout.
 *
 * **The power row is one key and says so, because the box rolls the power rather than the player.**
 * That is the whole reason it is one line: there is nothing about it to enumerate, and a row per
 * ability would be telling a player to press keys that do nothing for them. See `SuperAbility`, where
 * the per-ability keys do exist — bound for a dev only, and deliberately absent from this card, which
 * every player reads.
 *
 * **The throw is two rows because the input is two things, and this card was wrong about it.** It said
 * `X, C, V` — three keys choosing a shape — and that is no longer what the game does: a throw is
 * *charged*, so its arc comes from how long the button is held rather than from a key, and `X` and `C`
 * went with the shapes they named. What is left is one hold and one switch: the hold is the throw, and
 * `V` bends it sideways without touching the arc. They are two rows rather than one line with a comma in
 * it because they are not alternatives — a player who reads them as alternatives presses `X` and gets
 * nothing, which is the confusion this card exists to prevent and which it caused for a whole session
 * before anybody noticed.
 *
 * **No row mirrors a server state any more, and sprint is the one that never did.** Sprint is *held*, and
 * what it has is a pool that runs down rather than a setting that is on or off — so even while dimming
 * existed there was nothing here with two states to dim between, and the pool's level is drawn by the
 * cooldown HUD, which is where a value that moves belongs. The throw toggle was the last row that did
 * mirror one, and it has retired.
 *
 * Sprint sits between the dodge and the catch because it is the other way of moving: the two
 * movement controls read together, and the three that are about the ball follow.
 *
 * **The labels used to end in ` | `, and that pipe is gone.** It was the separator between a name and
 * its key on a *single* line, and a row is no longer a single line — the key sits in a box of its own
 * to the right, so the layout is the separator and a pipe would be a second one drawn for nothing. The
 * action and the key are the same two things they were; only the glyph between them has moved into the
 * structure.
 */
const ROWS: LegendRow[] = [
	{
		label: "Throw",
		keys: "Left Click (hold)",
		held: () => UserInputService.IsMouseButtonPressed(Enum.UserInputType.MouseButton1),
	},
	{ label: "Curve", keys: "V", held: () => UserInputService.IsKeyDown(Enum.KeyCode.V) },
	{
		label: "Dodge",
		keys: "Move + Right Click",
		// The conjunction is the rule, not a simplification of it: `DodgeController` reads the right button
		// as the *event* and the movement keys as the *direction*, so the dodge exists only when both are
		// down — and a box lit by a movement key alone would be the card claiming a dodge that walking is
		// not. See `DODGE_MOVEMENT_KEYS` for why eight keys and not four.
		held: () =>
			UserInputService.IsMouseButtonPressed(Enum.UserInputType.MouseButton2) && anyDown(DODGE_MOVEMENT_KEYS),
	},
	{
		label: "Sprint",
		keys: "Left Shift, Right Shift",
		// Both shifts, which is what `SPRINT_KEYS` binds: the key that sprints is the pair rather than
		// either of them, so the chip lights for either hand. See that list for why there are two.
		held: () =>
			UserInputService.IsKeyDown(Enum.KeyCode.LeftShift) || UserInputService.IsKeyDown(Enum.KeyCode.RightShift),
	},
	{ label: "Catch", keys: "E", held: () => UserInputService.IsKeyDown(Enum.KeyCode.E) },
	{ label: "Drop", keys: "1", held: () => UserInputService.IsKeyDown(Enum.KeyCode.One) },
	{ label: "Power", keys: "3", held: () => UserInputService.IsKeyDown(Enum.KeyCode.Three) },
];

/**
 * One row's live half: the question, and the thing that answers it.
 *
 * **The pair rather than a `Value`**, because the two are not independent and neither is worth publishing.
 * `held` is a plain predicate — see {@link LegendRow.held} for why the card reads the keys itself — and
 * `respond` is the *setter* `makePressResponse` hands back for that row's chip. They are held together so
 * that `mount` has one list to walk: the answers are all the same question asked about different inputs, so
 * one loop over eight of them is one place to read rather than eight connections to find.
 */
interface KeyState {
	/** Whether this row's control is down right now. */
	readonly held: () => boolean;

	/** Hand the answer in; nothing happens unless it changed. See `makePressResponse`. */
	readonly respond: (down: boolean) => void;
}

/**
 * The controls legend, standing in the bottom-right corner of the screen.
 *
 * A reference card rather than a readout: it says what the keys *do*. **Each action is a box of its own** —
 * the name on the left and the key in a chip beside it — so the card reads as a column of rows rather than
 * as one list of lines.
 *
 * **One thing on it moves now, and it used to be two.** A key that is currently down presses its own chip,
 * which is about the player's hands at this moment; the other movement was a row dimming while a server
 * attribute said its control was switched off, and that row was the throw toggle's, so it went with the
 * toggle. **What is still not here is whether an ability is *ready*** — the cooldown bars own that, in the
 * bottom-left, and a second copy of it would be two answers to one question. A key being down is not an
 * answer to it: a player can hold a key all round.
 *
 * **The press is the dock's press, borrowed rather than reimplemented.** A chip goes down and *stays* down
 * for as long as its control is held, then comes back — see `makePressResponse` in `ui/elevation.ts`, which
 * is the animation `wireInteraction` plays for the Shop button with the pointer replaced by a state. Nothing
 * is clicked here; the thing with a duration is the control being held. The chips carry **no shadow of their
 * own** — see `buildKeyBox` — so the travel is what says a key is down.
 *
 * **Bottom-right, and the corner is what makes the margin a fixed number.** What is placed is the column's
 * own bottom-right corner, so its distance from the bottom of the screen is `BOTTOM_EDGE_GAP` pixels
 * whatever the column's height turns out to be. It used to hang from a *fraction* of the screen height
 * instead, and that is the bug this replaced: the fraction was a position for the column's middle, eight rows
 * of boxes grew past it, and the last row was drawn off the bottom of the screen — never seen at all.
 *
 * Mounted into the shared GUI from `getHudScreenGui`, so hiding that GUI hides this with it and
 * the legend survives a respawn along with everything else the HUD draws.
 */
@Controller()
export class ControlsLegendController implements OnStart {
	public onStart(): void {
		// Spawned rather than done inline: mounting waits for `PlayerGui`, and a controller's
		// `onStart` is the wrong place to hold up the rest of the client's boot.
		task.spawn(() => this.mount());
	}

	private mount(): void {
		// **The card is a keyboard's, so a machine without one does not get it.** Every row below names a key,
		// and on a phone or a tablet that is a card explaining a control the player does not have — the chip
		// for `E` would light for nobody, because `IsKeyDown` is asking about hardware that is not there.
		// `MobileControlsController` is what mounts instead: a cluster of buttons that are their own labels,
		// wired to the same controllers the keys drive. **The two are alternatives and never both**, and the
		// test they share is `isMobile()` — see `client/platform.ts` for the read and for why `KeyboardEnabled`
		// is half of it.
		if (isMobile()) {
			if (DEBUG) print("[HUD] controls legend skipped — no keyboard on this device");

			return;
		}

		const scope = Fusion.scoped();

		// The HUD's colours, read now rather than at module load: `configureTheme` has run by the
		// time anything mounts, and a value captured earlier would be Material's default.
		const theme = hudTheme();

		// **The column, and it is a plain transparent frame rather than a card — that is the change.**
		// The legend used to be one `Card` with the rows stacked invisibly inside it, so the whole legend
		// was a single surface and a row was just two labels somewhere on it. The reference is the other
		// way round: each action is *its own box*, and the column behind the boxes carries no paint at
		// all. So the container is a frame with one vertical `UIListLayout` and nothing drawn on it, and
		// every surface in the legend belongs to a row — see `buildRow`.
		const container = Fusion.New(scope, "Frame")({
			Name: "ControlsLegend",
			// Sized by the rows it holds, on both axes: a column of boxes that size themselves has no
			// width or height of its own to write down.
			Size: UDim2.fromOffset(0, 0),
			AutomaticSize: Enum.AutomaticSize.XY,
			BackgroundTransparency: 1,
		});

		Fusion.New(scope, "UIListLayout")({
			Parent: container,
			FillDirection: Enum.FillDirection.Vertical,
			SortOrder: Enum.SortOrder.LayoutOrder,
			// **Right-packed, and the paragraph that used to be here argued the other way.** Left-packing
			// was chosen when the rows became boxes, on the argument that a box is as wide as its content, so
			// packing right would line the boxes' right edges up and strand their left edges — which is true,
			// and turned out to be the wrong trade. The thing a player scans this card *for* is the **key**,
			// and the key is the last thing in its row: packing right puts every chip against the column's
			// right edge within a pixel of each other — one straight line down the only column anybody is
			// looking at — and leaves the ragged edge on the action names, where a ragged edge costs nothing
			// at all. The key column lining up is what this card had before the rows were boxes, and it is
			// what it has again.
			HorizontalAlignment: Enum.HorizontalAlignment.Right,
			Padding: new UDim(0, ROW_SPACING),
		});

		// Numbered rather than left to the defaults, because the sort is by `LayoutOrder` and the fallback
		// is by name — and these rows are named after the abilities they show, so an unnumbered list would
		// come out alphabetical and the column would read nothing like the order above it.
		//
		// **`keys` is the card's other half**, and it is filled by the rows as they are built: each one pushes
		// the question about its own control and the setter that presses its own chip. The loop below is what
		// actually asks — see `KeyState` for why the two travel together.
		const keys: KeyState[] = [];
		let order = 0;
		for (const row of ROWS) {
			const drawn = this.buildRow(scope, theme, row, keys);
			drawn.LayoutOrder = order;
			drawn.Parent = container;
			order++;
		}

		// **One `Heartbeat` for the whole column, and this is the reason the responders are setters rather
		// than each row's own connection.** Every row is asking the same question — "is this down" — about a
		// different input, so it is asked once per frame in one place, and a row whose answer has not changed
		// costs a comparison and nothing else. The animation itself, and that comparison, live in
		// `makePressResponse`; what lives here is only *when* the question is asked.
		scope.push(
			RunService.Heartbeat.Connect(() => {
				// **A player typing is not a player playing, and this line is the whole of that difference.**
				// `IsKeyDown` is a raw read of the keyboard with no notion of focus, so somebody typing
				// "sprint" into the chat box would light four of these boxes — while the controls themselves go
				// through `ContextActionService`, which is the mechanism that *does* respect the chat box and
				// would fire nothing at all. Asking about focus is what keeps the card agreeing with the game
				// rather than contradicting it, and the short circuit means not one key is read while something
				// has it.
				const typing = UserInputService.GetFocusedTextBox() !== undefined;

				for (const entry of keys) {
					entry.respond(!typing && entry.held());
				}
			}),
		);

		// The pin to the bottom-right corner, on the container itself: nothing above it has a layout, which is
		// what lets a `Position` here mean something at all.
		//
		// **The corner and not a fraction, and this is the fix rather than the shape it always had.** An
		// `AnchorPoint` names the *point on the thing being placed*, so `(1, 1)` places the column's own
		// bottom-right corner — and the two offsets are then real margins: `SCREEN_EDGE_GAP` from the right
		// edge of the screen, `BOTTOM_EDGE_GAP` from the bottom of it. The card used to be anchored at
		// `(1, 0.5)`, which places the column's *middle*, so its vertical position was a fraction of the screen
		// height that a taller column simply grew past — eight rows of boxes did exactly that, and the last of
		// them was drawn below the bottom edge and never seen at all. A corner has no such property: a margin
		// is a margin at any height, and on any device.
		//
		// **The cost is that the overflow would now happen at the top**, on a viewport too short for the column
		// — the mirror of the bug just fixed, left alone because nothing has met it. The vertical half of
		// `addViewportConstraint` below is the number that would have to move if it ever does.
		container.AnchorPoint = new Vector2(1, 1);
		container.Position = new UDim2(1, -SCREEN_EDGE_GAP, 1, -BOTTOM_EDGE_GAP);

		// **The bound the legend has always had, and it still fits the new shape.** The column is as wide
		// as its widest row, and a row cannot wrap (see `buildText` for why wrapping is off), so on a narrow
		// screen the column would simply keep going — and being right-anchored, it would run off the *left*
		// edge rather than the right one. A box per action makes the column taller than it was and no wider,
		// so the cap engages at the same width it always did.
		addViewportConstraint(scope, container);

		container.Parent = getHudScreenGui();

		if (DEBUG) print(`[HUD] controls legend up — ${ROWS.size()} rows`);
	}

	/**
	 * One row: its name and its key, as a box with the name on the left and the chip on the right.
	 *
	 * The row is generic over the descriptor, which is what makes a new entry in {@link ROWS} a complete
	 * change: nothing here knows what "Dodge" is. **There used to be more to it than that** — a row could name
	 * a player attribute, this method built the `Value` for it and subscribed to the attribute, and both were
	 * handed to the scope so they were cleaned up with the text they fed — and that whole branch went with the
	 * throw toggle, its last user. What is left is a builder with no per-row state in it at all.
	 *
	 * The theme comes in as a parameter rather than being read here, so that a HUD reads its
	 * colours exactly once and this method cannot disagree with the rest of the file about them.
	 *
	 * `keys` is where this row's live half is deposited — the question about its control and the setter
	 * that presses its chip. It is threaded through rather than collected on the controller so that the
	 * builders stay functions of what they are given; see `KeyState`.
	 */
	private buildRow(scope: Fusion.Scope<unknown>, theme: HudTheme, row: LegendRow, keys: KeyState[]): Frame {
		// **The row is a surface of its own now, and that is the whole of this shape.** It used to be a
		// transparent frame with two labels on it; it is now a box with a background, the action's name on
		// the left, and the key in a chip of its own on the right. `panel` is the theme's raised surface —
		// the row is a small card laid over the game — and the key chip takes the theme's one colour that
		// means "the thing to press", `accent`, with `onAccent` for the text on it. See `buildKeyBox` for
		// the chip, and `hudTheme` for the four names this row draws with.
		const frame = Fusion.New(scope, "Frame")({
			Name: `${row.label}Row`,
			// Hugs its contents on both axes — the row is as wide as the name and the key together and as
			// tall as the taller of the two — so a longer action name cannot clip and no height is written
			// down. §9's `AutomaticSize` on the content axis, applied to both axes because a row has no
			// fixed axis at all.
			Size: UDim2.fromOffset(0, 0),
			AutomaticSize: Enum.AutomaticSize.XY,
			BackgroundColor3: theme.colors.panel,
			BackgroundTransparency: 0,
			BorderSizePixel: 0,
		});

		Fusion.New(scope, "UICorner")({ Parent: frame, CornerRadius: new UDim(0, 6) });

		// **Padding in pixels, from the theme's spacing scale, and here it has to be pixels.** §9 asks for
		// scale padding — and everywhere a surface has a definite width it gets it, which is why the
		// column's own distance from the screen edge is an anchor and a viewport fraction on the container.
		// But a row sizes itself to its contents, so a scale inset would be a fraction of the size it is
		// helping to decide: the cycle `addBand` and `addPill` each document at their own pads. A fixed inset
		// is the answer for an auto-sized box, and the four-to-eight pixel steps it uses are the theme's
		// rather than invented.
		Fusion.New(scope, "UIPadding")({
			Parent: frame,
			PaddingTop: new UDim(0, theme.spacing.xs),
			PaddingBottom: new UDim(0, theme.spacing.xs),
			PaddingLeft: new UDim(0, theme.spacing.sm),
			PaddingRight: new UDim(0, theme.spacing.xs),
		});

		// The name, then the key, side by side. `LABEL_GAP` is what separates them — the pipe that used to
		// do that job is gone from the labels, because the layout does it now.
		Fusion.New(scope, "UIListLayout")({
			Parent: frame,
			FillDirection: Enum.FillDirection.Horizontal,
			SortOrder: Enum.SortOrder.LayoutOrder,
			VerticalAlignment: Enum.VerticalAlignment.Center,
			Padding: new UDim(0, LABEL_GAP),
		});

		const label = this.buildText(scope, row.label, theme.colors.textPrimary);
		label.LayoutOrder = 1;
		label.Parent = frame;

		// The key, in the accent chip — see `buildKeyBox`. It is the row's second child, to the right of
		// the name, and `LayoutOrder` is what puts it there. It also deposits this row's live half into
		// `keys`, because the chip is the thing that presses.
		const keyBox = this.buildKeyBox(scope, theme, row, keys);
		keyBox.LayoutOrder = 2;
		keyBox.Parent = frame;

		return frame;
	}

	/**
	 * The key in its own chip: the second half of a row, and the reason a row reads as a row.
	 *
	 * **A chip rather than a second label**, because the key is the thing the card exists to help a player
	 * *find* — the eye scans the right-hand column for it — and a colour behind it is what makes that column
	 * a column. Two theme colours, both already there: `accent` is the theme's own name for "the thing to
	 * press" (its doc lists keys first), and `onAccent` is the name for text drawn on an accent surface. No
	 * new colour was needed, which is the point.
	 *
	 * **`panel`/`card` was the other candidate for a chip and it is the wrong pair here.** Those two are the
	 * pair a *panel* and its cards are made of — a light surface on a lighter one — and a key is not a card,
	 * it is the one field of colour on the row. The accent is what the theme keeps for exactly this.
	 *
	 * The chip hugs its key, so a one-letter key is a small box and a key like `Left Shift, Right Shift` is a wide one.
	 * A `UISizeConstraint` floor stops a very short key collapsing the chip to nothing — §9's constraint rule,
	 * and the same shape `addViewportConstraint` uses one level up.
	 *
	 * **Not raised, and that was tried and undone.** The chip wore an `ELEVATION.BUTTON` shadow for one
	 * round — the argument being that a flat colour says *this is where the key is written* while a raised
	 * surface says *this is the thing you press* — and a shadow this small, at this offset, over a surface
	 * this small reads as a smudge under the chip rather than as depth. The accent fill is already the
	 * theme's own word for "the thing to press", so the shadow was making no claim the colour had not
	 * already made.
	 *
	 * **It presses instead, driven by the key rather than by a pointer** — the whole of the difference
	 * between this chip and a button. The setter goes into `keys` and is called from `mount`'s one loop with
	 * no shadow to drop, so the scale is all of the motion: see `makePressResponse`, and {@link LegendRow.held}
	 * for why this card reads the keys at all.
	 */
	private buildKeyBox(scope: Fusion.Scope<unknown>, theme: HudTheme, row: LegendRow, keys: KeyState[]): Frame {
		const box = Fusion.New(scope, "Frame")({
			Name: "Key",
			Size: UDim2.fromOffset(0, 0),
			AutomaticSize: Enum.AutomaticSize.XY,
			BackgroundColor3: theme.colors.accent,
			BackgroundTransparency: 0,
			BorderSizePixel: 0,
		});

		Fusion.New(scope, "UICorner")({ Parent: box, CornerRadius: new UDim(0, 4) });

		Fusion.New(scope, "UIPadding")({
			Parent: box,
			PaddingTop: new UDim(0, theme.spacing.xs),
			PaddingBottom: new UDim(0, theme.spacing.xs),
			PaddingLeft: new UDim(0, theme.spacing.sm),
			PaddingRight: new UDim(0, theme.spacing.sm),
		});

		// A floor on the width only: the height comes from the key's own line box, so the floor that matters
		// is the one that keeps a single letter from being a chip two pixels wide.
		Fusion.New(scope, "UISizeConstraint")({
			Parent: box,
			MinSize: new Vector2(theme.spacing.lg, 0),
		});

		// A layout even for one child, which is `addPill`'s shape and here for the same reason: it puts the
		// key inside the padding box on both axes without the box having to guess where a lone child sits.
		Fusion.New(scope, "UIListLayout")({
			Parent: box,
			FillDirection: Enum.FillDirection.Horizontal,
			SortOrder: Enum.SortOrder.LayoutOrder,
			HorizontalAlignment: Enum.HorizontalAlignment.Center,
			VerticalAlignment: Enum.VerticalAlignment.Center,
			Padding: new UDim(0, 0),
		});

		// The press itself, and the row's half of `mount`'s one loop. Nothing is connected here: the state of
		// a key is not an event this file can see, so it is handed in from the frame loop that reads them.
		//
		// **No shadow is passed, and that is `makePressResponse`'s supported mode rather than a gap** — the
		// same way `wireInteraction` is called with none for a shelf tile. What is left of the press is the
		// scale alone, which on a chip this size is under a pixel of travel: see the note in this method's
		// own doc for why the shadow went.
		keys.push({ held: row.held, respond: makePressResponse(scope, box) });

		const text = this.buildText(scope, row.keys, theme.colors.onAccent);
		text.Parent = box;

		return box;
	}

	/**
	 * One piece of a row, in the HUD's own type.
	 *
	 * big-ui's `Text` supplies the font, the size and the line height, so the legend's type is the
	 * same as the rest of the HUD's and a change to the theme moves both. What it does not do is
	 * take a colour from outside its palette — it picks its colours from the theme and hands back a
	 * plain `TextLabel` — so that part is done here: the colour is written once.
 *

	 * **The transparency used to be the other half of this, and it went with the throw toggle.** A row that
	 * mirrored a server attribute had its `TextTransparency` bound through a `Computed` off the dimming
	 * `Value`; with no row mirroring anything, every label on the card is drawn at full strength, so the
	 * subscription is gone and the transparency is the one number it always was under the graph.
	 */
	private buildText(scope: Fusion.Scope<unknown>, text: string, color: Color3): TextLabel {
		// Wrapping off, and the size below is why: a row's width has to come from its own text,
		// and big-ui's default is a label the full width of its parent sized to wrap inside it.
		// A parent sized to the label and a label sized to the parent is a circle, and Roblox
		// resolves it by guessing.
		const label = Text(scope, { text, variant: "overline", wrap: false });

		label.Size = UDim2.fromOffset(0, 0);
		label.AutomaticSize = Enum.AutomaticSize.XY;
		label.TextColor3 = color;
		label.TextTransparency = 0;

		return label;
	}
}
