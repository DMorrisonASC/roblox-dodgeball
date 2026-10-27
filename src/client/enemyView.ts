import Fusion from "@rbxts/fusion-3.0";
import { Players } from "@rbxts/services";
import { LAST_HIT_BY_CAUSE_ATTRIBUTE, STAT_HITS, STAT_OUTS } from "shared/constants";
import { logDebug, logInfo } from "shared/logger";
import { killCamActive } from "./panels";
import { applyGlow, applyTextGlow } from "./ui/glow";
import { hudTheme } from "./ui/hudTheme";
import { PREMIUM } from "./ui/premiumTheme";
import { getFullScreenGui } from "./ui/screenGui";

/**
 * **The "Enemy View" overlay: who the kill cam is looking at, and how their round is going.**
 *
 * **A plain module started from the boot**, which is `killCam`, `returnToLobby`, `hitVfx` and `catchPrompt`'s
 * shape: it owns one element and no lifecycle. It is *not* a Flamework controller for their reason — an exported
 * class lands in `flamework.build` whether or not it is decorated — and it is not part of `killCam` because the
 * camera and the caption are two different jobs: the camera decides where to look, this decides what to say about
 * it, and either could change without the other.
 *
 * **It is told which body to describe rather than working it out**, which is the one thing about it worth
 * stating: `client/killCam.ts` has already resolved the killer's token to a `Model` before it starts the shot, and
 * a second resolution here would be the same lookup twice, with a second chance to pick a different body. So the
 * cam calls {@link showEnemyView} and {@link hideEnemyView} at its two edges and this file owns everything else —
 * the text, the typography, and the subscriptions that keep the numbers live.
 *
 * **The numbers are a player's, and a rig has none — which is a fact about the server rather than an omission
 * here.** `StatsService` writes `STAT_HITS` and `STAT_OUTS` on the **`Player`**, because the record outlives every
 * body it was earned in, and a rig has no player and no record: these two are read off the `Player` and nothing
 * off a rig's model. So a rig's overlay says `—` rather than `0`, which is the honest answer —
 * a nought would be a claim that it threw and missed.
 *
 * **Nothing here is drawn with a `BillboardGui` or a `ScreenGui` of its own** — it mounts into `getFullScreenGui`,
 * which is the second home this project already keeps for furniture measured from the **screen's** top edge rather
 * than from whatever region the HUD's GUI picks for the device. The round's readout column is that GUI's first tenant
 * and the reason it exists; this panel is the second, and for the same reason: it is pinned to the top of the screen,
 * so the number that places it has to mean the same thing on a phone as on a desktop.
 *
 * **What that GUI costs is stated rather than slept on: its `DisplayOrder` is `-1`, one rung *below* the HUD plane**,
 * so this draws under every HUD element rather than over them. That is acceptable here for a reason which holds by
 * construction: during a shot the HUD hides itself off `killCamActive`, and the one element that shares this GUI —
 * the readout column — hides off the same flag. **The elements that are not bound to it cannot cover the panel**:
 * the "Return to Lobby" pill is in the HUD GUI at the bottom-left, and the panels are only open for somebody who is
 * not in a round. A transition still covers this exactly as it covers everything, which is `DisplayOrder` working as
 * intended — splash `1`, wipe `2`.
 */

/**
 * How far below the top of the GUI the overlay's top edge sits, in pixels. **Placeholder — 64.**
 *
 * **A number rather than a `Scale` fraction, and one number because the GUI's top edge is the same edge on every
 * device.** `getFullScreenGui` is `ScreenInsets.None` on both, so `y = 0` here is the true top of the viewport and
 * the topbar is a fixed distance below it — which is what makes an offset the honest unit for this.
 *
 * **The HUD GUI's own `y = 0` would not have been.** `getHudScreenGui` is `CoreUISafeInsets` on a mobile client, so
 * an offset from *that* edge is added to a topbar (and a notch) already accounted for — the panel sat a second
 * chrome's height lower on a phone than on a desktop for no reason a player could see. That is the whole argument for
 * this GUI, and it is the readout column's: a number pinned to the top of the screen wants the screen's own origin.
 * 64 clears the topbar's ~36–58px and nothing else.
 */
const TOP_INSET = 64;

/** How far in from the screen's left edge the record card sits, in pixels. **Placeholder — 16.** */
const LEFT_INSET = 16;

/**
 * The record card's size and inner spacing, in pixels. **Placeholder — 132 wide, a 2-pixel gap between lines, 8 at
 * the sides and bottom and 2 at the top.**
 *
 * **It got smaller because it was too big, and the honest record of what was tried is this comment.** The first
 * shape was `150` wide with a `Stats` heading above three 15-pixel lines and `10` of padding all round; it read as a
 * panel with a title rather than as a scorecard, and it took a corner of the screen to say four short things.
 *
 * **The heading is gone rather than shrunk, and nothing is lost by it.** `Hits:`, `Outs:` and `Ratio:` already name
 * themselves — a `Stats` title above them is the same word said twice, and it was the single tallest row in the box.
 * What is left is the three figures at `RECORD_TEXT_SIZE`, which is the smallest size at which a bold label is
 * readable while the camera is moving.
 *
 * **The gap and the type both came down with it.** `2` between lines still separates them — the rows carry their own
 * line height, so this is space rather than structure — and the width is set by `Ratio: 1.00`, the longest line the
 * card can ever hold, rather than by the 150 that was chosen for a heading it no longer has.
 */
const RECORD_WIDTH = 132;
const RECORD_LINE_GAP = 2;
const RECORD_PADDING = 8;
const RECORD_TOP_PADDING = 2;
const RECORD_TEXT_SIZE = 13;

/** The panel's width in pixels; its height is its content's. **Placeholder — 260, wide enough for a long name.** */
const WIDTH = 260;

/** The panel's padding, and the gap between its three lines, in pixels. */
const PADDING = 10;
const LINE_GAP = 2;

/**
 * **The panel's paint is the game HUD's own palette, not this file's.** The colours used to be five `Color3`
 * literals written here — a dark panel, a grey border, a dim header and two shades of near-white — which was right
 * while this overlay was the only dark furniture on the screen and wrong the moment the whole in-game HUD moved to
 * the "Premium Sports" direction. See `ui/premiumTheme.ts` for the palette and for why it is a module of its own
 * rather than more entries in `hudTheme`.
 */

/**
 * **Above the other tenant of its own GUI, which is all `ZIndex` can say from here.**
 *
 * `ZIndex` orders siblings inside one tree, and this panel's only sibling in `getFullScreenGui` is the round's
 * readout column, drawn at the default rung — so `10` puts the caption over the score plate and the clock. **The two
 * are geometrically on top of each other**: both are centred against the top edge. What makes that harmless is
 * `killCamActive` — the column hides while a shot runs and this shows — so in the ordinary case only one of them is
 * ever drawn, and this rung is the belt for a frame in which both are.
 *
 * **`DisplayOrder` is the wrong tool at this level, and the GUI already uses it.** It orders whole `ScreenGui`s; this
 * panel shares one with the column, so the only ladder available to it is `ZIndex`'s. The GUI's own `DisplayOrder` of
 * `-1` — under everything the HUD draws — is a consequence of the choice rather than a decision taken here, and it
 * is written up at the top of this file.
 */
const Z_INDEX = 10;

/**
 * **The two words a caught-throw death is drawn with** — the server's cause value, and the caption that replaces the
 * stat line.
 *
 * **`CAUSE_CATCH` is a literal between two files**, which is `roundZone`'s `PLAYING` convention: the server writes
 * `"Hit"` or `"Catch"` into `LAST_HIT_BY_CAUSE_ATTRIBUTE` and this file compares against the one that changes the
 * layout. Spelled here rather than imported as a second constant, so a reader of either file sees the string being
 * compared rather than a name that hides it.
 */
const CAUSE_CATCH = "Catch";

/** **What the panel says instead of `Hits: n | Outs: m`** — the sentence a player whose throw was caught needs. */
const CAUGHT_TEXT = "caught your shot!";

/**
 * The panel, once it has been made.
 *
 * **Made once and never destroyed**, and that is the whole of its lifecycle: the element hides and shows by the
 * `Visible` property of a `Computed` over `panels.killCamActive`, so a shot costs two label writes rather than a
 * mount. See `panels.ts`'s paragraph on why the screen is cleared by visibility rather than by teardown.
 */
let frame: Frame | undefined;

/** The three lines. Held rather than searched for, because every shot writes two of them. */
let nameLabel: TextLabel | undefined;
let statsLabel: TextLabel | undefined;

/**
 * The header, held since the catch caption hides it — the one line whose *visibility* a shot can change.
 *
 * The note in {@link mount} used to say "the header never changes", which was true while every death in the game was
 * a ball that landed. A death caused by a caught throw has no "ENEMY VIEW" to name — there is no view to describe,
 * there is one sentence to read — so the header is now held like its two neighbours. See {@link showEnemyView}.
 */
let headerLabel: TextLabel | undefined;

/**
 * **The attacker's record, in its own card on the left of the screen** — hits, outs and the ratio those make.
 *
 * **Why a second element rather than a fourth line in the centre caption.** The caption at the top centre is the
 * *narrative* of a shot: what you are looking at, who it is, and why it happened. Its stats line is a caption on a
 * name and it is read last, at `caption` size, under two larger lines. The question this panel answers is different
 * and it is asked first — **how good was the body I am watching** — so it gets its own surface, its own corner of the
 * screen, and type large enough to be read while the camera is moving.
 *
 * **On the left because the centre is taken.** The kill-cam caption is anchored `(0.5, 0)` at the top of the screen
 * and the HUD's own readout column hides itself for the length of a shot (`killCamActive`), so the top-left is the one
 * part of the screen that is empty for exactly as long as this is on it.
 *
 * **White paper with black ink, which is the one element in this file that is not plum.** The caption wears the HUD's
 * dark panel because it sits over the same arena the HUD does. This panel is deliberately the other material: it is a
 * *scorecard*, the same paper the shop and the stats board are made of, and it is the only thing on screen during a
 * shot, so a second dark panel would read as more caption rather than as a different kind of fact.
 */
let recordPanel: Frame | undefined;

/** The record's three lines, one per figure. Held because every shot rewrites all three. */
let recordHits: TextLabel | undefined;
let recordOuts: TextLabel | undefined;
let recordRatio: TextLabel | undefined;

/**
 * The connections that keep the numbers live, one per attribute.
 *
 * **Held so they can be dropped when the shot ends.** They are made on the *killer's* instance, which is a
 * different instance every death — a rig is even a different *model* most times — so a connection left behind
 * would be one per death for the life of the session, each firing into labels that have since been rebound.
 */
let live = new Array<RBXScriptConnection>();

/**
 * The boot's one line for this overlay, in the shape its neighbours use.
 *
 * **It mounts rather than waiting for the first death**, so the element exists — hidden — from the client's first
 * frame and a shot never pays for its construction. {@link showEnemyView} mounts too, guarded, so the two calls
 * cannot get out of order and leave a cam with no overlay.
 */
export function startEnemyView(): void {
	mount();
}

/**
 * Binds the overlay to `body` — the killer the cam is about to watch.
 *
 * **Called before the camera moves**, so the text is already right on the first frame of the shot rather than
 * filling in behind it. `killCam.begin` is the only caller and it has already refused every case where there is
 * no body, so this does not ask again.
 */
export function showEnemyView(body: Model): void {
	mount();

	unbind();

	const player = Players.GetPlayerFromCharacter(body);

	// **The side of the wire the numbers live on.** A player's stats are on the `Player`; a rig has none at all,
	// which {@link describeStats} draws as an em dash. `body` is what is being watched and `source` is what is
	// asked — the two are the same instance for a rig and differ for a player.
	const source: Instance = player !== undefined ? player : body;

	if (nameLabel !== undefined) nameLabel.Text = nameOf(body);

	// **Why this death happened, asked of the local player's own copy of the attribute.** A caught throw kills its
	// thrower, and the server writes that into the same four attributes a landed hit writes — on the player who died,
	// whose client is this one — with the **catcher** as the name, the token and the position. `killCam` has already
	// resolved that token to `body`, so the three facts come from one write and cannot describe different people.
	//
	// **One read and no subscription, deliberately.** The four writes are one server tick, so what is read here is
	// what was written alongside the token the cam just resolved. A subscription would be able to see a *later* write
	// arrive — the token can be a frame stale at a death, which `killCam` documents and cannot fix — and would then
	// caption a body the camera is following for an older reason.
	const caught = Players.LocalPlayer.GetAttribute(LAST_HIT_BY_CAUSE_ATTRIBUTE) === CAUSE_CATCH;

	// **The header goes rather than being rewritten.** "CAUGHT!" over "caught your shot!" is one sentence said twice,
	// and a `UIListLayout` leaves an invisible child out of the layout entirely, so hiding this line closes the gap
	// rather than leaving a hole where a word used to be.
	if (headerLabel !== undefined) headerLabel.Visible = !caught;

	if (statsLabel !== undefined) statsLabel.Text = caught ? CAUGHT_TEXT : describeStats(source);

	// **The card is written whether or not the death was a catch**, which is the one place its content and the caption's
	// diverge on purpose: a caught throw's caption is an explanation and has no numbers in it, but the body being
	// watched is still the catcher, and *their* record is exactly what a player wants to know next to a caption that
	// says they caught the ball.
	writeRecord(source);

	// **The numbers are live only for a hit.** A catch's line is a fixed sentence, so a stat write arriving under it a
	// frame later would replace the explanation with `Hits: 4 | Outs: 1` — the exact thing this case exists to stop
	// saying. **The card is live either way**: it is a record rather than a caption, and a catch is when the record
	// changes, so gating it on the death's cause would freeze it exactly when it was about to matter.
	//
	// **Live, because the overlay says "how are they doing" and the answer can change while it is being read.**
	// Two signals rather than a poll, and one connection per attribute rather than one per number: a `Value` and
	// a `Computed` would be the Fusion way to do the same thing, but an attribute read inside a `Computed` is a
	// *sample* rather than a dependency — the lesson `RespawnHudController` records — so the subscription has to
	// exist somewhere and here is where it belongs.
	for (const attribute of [STAT_HITS, STAT_OUTS]) {
		live.push(
			source.GetAttributeChangedSignal(attribute).Connect(() => {
				writeRecord(source);

				if (!caught && statsLabel !== undefined) statsLabel.Text = describeStats(source);
			}),
		);
	}

	logDebug(`[EnemyView] watching ${body.GetFullName()}${caught ? " — a caught throw" : ""}`);
}
/**
 * Drops the bindings. **The panel's visibility is not touched here**, and that is deliberate: it follows
 * `panels.killCamActive`, which the cam writes on its own edges, so there is one writer for "is a shot happening"
 * and no way for the caption to outlive the camera.
 */
export function hideEnemyView(): void {
	unbind();

	logDebug("[EnemyView] released");
}

/** Builds the panel, once. Idempotent, so both entry points can call it without agreeing about who goes first. */
function mount(): void {
	if (frame !== undefined) return;

	const scope = Fusion.scoped();

	const panel = Fusion.New(scope, "Frame")({
		Name: "EnemyView",
		AnchorPoint: new Vector2(0.5, 0),
		Position: new UDim2(0.5, 0, 0, TOP_INSET),
		Size: new UDim2(0, WIDTH, 0, 0),
		AutomaticSize: Enum.AutomaticSize.Y,
		// **The theme's plum at the theme's transparency**, which is what makes this panel and the score plate above
		// it one material. It was an almost-opaque near-black at `0.1` — right for a dark HUD, and now the one surface
		// in the row that would look pasted on.
		BackgroundColor3: PREMIUM.panel,
		BackgroundTransparency: PREMIUM.transparency,
		BorderSizePixel: 0,
		ZIndex: Z_INDEX,

		// **The visibility, in one place, read from the state the cam writes.** It is a `Computed` rather than two
		// writes inside `show`/`hide` for the same reason the HUD's hiding is: one source of truth means an abort
		// that forgot to call `hideEnemyView` cannot leave a caption over a live camera.
		Visible: Fusion.Computed(scope, (use) => use(killCamActive)),
	});

	// The same two decorations the "Return to Lobby" pill wears, so the cinematic furniture and the way out of a
	// round read as one family rather than as two HUDs that happened to ship in the same week. **Both read the
	// theme now**, which is what makes that sentence true rather than historical: a gold hairline on a four-pixel
	// corner, in the same two numbers the pill and the score plate use.
	Fusion.New(scope, "UICorner")({ Parent: panel, CornerRadius: new UDim(0, PREMIUM.corner) });
	// **The neon edge: a one-pixel core plus a bloom**, which is `ui/glow.ts`'s whole job. The helper is handed the
	// frame rather than this file making a `UIStroke`, so the two layers that make an edge look *lit* are one call
	// and every panel in the game is lit the same way.
	applyGlow(panel);
	Fusion.New(scope, "UIPadding")({
		Parent: panel,
		PaddingTop: new UDim(0, PADDING),
		PaddingBottom: new UDim(0, PADDING),
		PaddingLeft: new UDim(0, PADDING),
		PaddingRight: new UDim(0, PADDING),
	});
	Fusion.New(scope, "UIListLayout")({
		Parent: panel,
		FillDirection: Enum.FillDirection.Vertical,
		SortOrder: Enum.SortOrder.LayoutOrder,
		HorizontalAlignment: Enum.HorizontalAlignment.Center,
		Padding: new UDim(0, LINE_GAP),
	});

	// **Three lines, three sizes, one face-family** — a bold label for what the element is, a bold one for the name
	// because the name is the subject, and a medium one for the numbers because they are a caption on the name.
	// **The header is built last and given `LayoutOrder` 1**, so the list draws it first without the code having to
	// build things in the order they appear — the same contract the round readout column writes down for its two
	// children.
	//
	// **The header is the theme's gold and the other two lines are its near-white**, which is the whole of how the
	// direction reads here: one gold thing says what you are looking at, and everything you actually want to read is
	// white on plum. The header also takes `GothamBlack` — the heaviest of the two faces the theme allows — because
	// it is the one line drawn entirely in capitals, and a cap-height row in the same weight as the name under it
	// reads as a second name rather than as a label.
	//
	// **All three are held now, and the note that used to say "the header never changes" is retired with its
	// reason.** The header *is* the one line a shot can hide — a death caused by a caught throw has no "view" to
	// describe — and holding it is what lets `showEnemyView` close the line rather than blank it and leave a hole
	// where a word used to be.
	nameLabel = line(scope, panel, "Name", "", Enum.Font.GothamBold, 20, PREMIUM.text, 2);
	statsLabel = line(scope, panel, "Stats", "", Enum.Font.GothamMedium, 14, PREMIUM.text, 3);
	headerLabel = line(scope, panel, "Header", "ENEMY VIEW", Enum.Font.GothamBlack, 12, PREMIUM.gold, 1);

	// **Into the full-screen GUI rather than the HUD's**, because this is furniture pinned to the screen's own top
	// edge: `None` insets on both devices, so `TOP_INSET` means the same distance everywhere. See the two notes at the
	// top of this file for what that buys and what it costs — the cost being a `DisplayOrder` below the HUD plane,
	// which the caption can afford because the only thing up there with it is hidden by the same flag.
	panel.Parent = getFullScreenGui();

	frame = panel;

	// **And the record card, in the same GUI for the same reason**: it is furniture pinned to the screen's own edges,
	// and it must be visible for exactly the length of a shot, which is when the HUD plane hides itself. See
	// {@link recordPanel} for why it is the left and why it is paper rather than plum.
	const record = Fusion.New(scope, "Frame")({
		Name: "EnemyRecord",
		AnchorPoint: Vector2.zero,
		Position: UDim2.fromOffset(LEFT_INSET, TOP_INSET),
		Size: new UDim2(0, RECORD_WIDTH, 0, 0),
		AutomaticSize: Enum.AutomaticSize.Y,
		BackgroundColor3: hudTheme().colors.panel,
		BackgroundTransparency: 0,
		BorderSizePixel: 0,
		ZIndex: Z_INDEX,
		Visible: Fusion.Computed(scope, (use) => use(killCamActive)),
	});

	Fusion.New(scope, "UICorner")({ Parent: record, CornerRadius: new UDim(0, PREMIUM.corner) });
	Fusion.New(scope, "UIPadding")({
		Parent: record,
		PaddingTop: new UDim(0, RECORD_TOP_PADDING),
		PaddingBottom: new UDim(0, RECORD_PADDING),
		PaddingLeft: new UDim(0, RECORD_PADDING),
		PaddingRight: new UDim(0, RECORD_PADDING),
	});
	Fusion.New(scope, "UIListLayout")({
		Parent: record,
		FillDirection: Enum.FillDirection.Vertical,
		SortOrder: Enum.SortOrder.LayoutOrder,
		HorizontalAlignment: Enum.HorizontalAlignment.Left,
		Padding: new UDim(0, RECORD_LINE_GAP),
	});

	recordHits = recordLine(scope, record, "Hits", "Hits: —", RECORD_TEXT_SIZE, Enum.Font.GothamBold, 1);
	recordOuts = recordLine(scope, record, "Outs", "Outs: —", RECORD_TEXT_SIZE, Enum.Font.GothamBold, 2);
	recordRatio = recordLine(scope, record, "Ratio", "Ratio: —", RECORD_TEXT_SIZE, Enum.Font.GothamBold, 3);

	record.Parent = getFullScreenGui();

	recordPanel = record;

	logInfo("[HUD] enemy view up — hidden until a kill cam describes somebody");
}

/**
 * **One line of the record card: left-aligned, black, and as tall as its own text.**
 *
 * **No halo, and that is the difference from {@link line}.** The caption's letters are lit because they sit on the
 * HUD's dark plum and the glow is what makes it read as neon; this card is white paper, and a stroke around black ink
 * on paper is the one thing that would make it look wrong rather than lit. The two styles are separate functions
 * rather than one with a flag because the *material* is the difference, not a property of any one line.
 */
function recordLine(
	scope: Fusion.Scope<unknown>,
	parent: Frame,
	name: string,
	text: string,
	textSize: number,
	font: Enum.Font,
	order: number,
): TextLabel {
	return Fusion.New(scope, "TextLabel")({
		Name: name,
		Parent: parent,
		BackgroundTransparency: 1,
		Font: font,
		Text: text,
		TextColor3: hudTheme().colors.textPrimary,
		TextSize: textSize,
		TextXAlignment: Enum.TextXAlignment.Left,
		AutomaticSize: Enum.AutomaticSize.XY,
		LayoutOrder: order,
		ZIndex: Z_INDEX,
	});
}

/**
 * **The three figures, from whichever instance the numbers live on** — the `Player` for a player, and the body itself
 * for a rig, which has no record and answers with em dashes. The same rule {@link describeStats} states, split into
 * lines because the card draws them one per row.
 */
function recordOf(source: Instance): { hits: string; outs: string; ratio: string } {
	const hits = source.GetAttribute(STAT_HITS);
	const outs = source.GetAttribute(STAT_OUTS);

	if (!typeIs(hits, "number") || !typeIs(outs, "number")) {
		return { hits: "Hits: —", outs: "Outs: —", ratio: "Ratio: —" };
	}

	const counted = hits + outs;

	return {
		hits: `Hits: ${hits}`,
		outs: `Outs: ${outs}`,
		ratio: `Ratio: ${counted === 0 ? "—" : string.format("%.2f", hits / counted)}`,
	};
}

/** Writes `source`'s figures into the card. Called on every shot and on every write that changes them. */
function writeRecord(source: Instance): void {
	const record = recordOf(source);

	if (recordHits !== undefined) recordHits.Text = record.hits;
	if (recordOuts !== undefined) recordOuts.Text = record.outs;
	if (recordRatio !== undefined) recordRatio.Text = record.ratio;
}

/**
 * One line of the panel: left-empty, centred, and as wide as its own text.
 *
 * **A free function rather than three copies of eight properties**, and it returns the label because two of the
 * three callers keep it to write a name and a pair of numbers into later. The `text` is a parameter rather than
 * something derived from `name`: a helper that decided its own caption from the row it happened to be building
 * would be the kind of implicit coupling that reads fine here and is a puzzle six months later.
 */
function line(
	scope: Fusion.Scope<unknown>,
	parent: Frame,
	name: string,
	text: string,
	font: Enum.Font,
	textSize: number,
	colour: Color3,
	order: number,
): TextLabel {
	const label = Fusion.New(scope, "TextLabel")({
		Name: name,
		Parent: parent,
		BackgroundTransparency: 1,
		Font: font,
		Text: text,
		TextColor3: colour,
		// **White at the direction's text alpha** — see `PREMIUM.textTransparency` for why the softness is on the
		// letters and not on the panel. Applied to the gold header too: the rule is about ink, not about colour.
		TextTransparency: PREMIUM.textTransparency,
		TextSize: textSize,
		TextXAlignment: Enum.TextXAlignment.Center,
		AutomaticSize: Enum.AutomaticSize.XY,
		LayoutOrder: order,
		ZIndex: Z_INDEX,
	});

	// **Every line gets the halo**, which is what makes the caption read as neon rather than as white text that happens
	// to be on a dark panel. It is applied here rather than at the three call sites for the reason the properties are:
	// one construction, so a fourth line would be lit without anybody remembering to light it.
	applyTextGlow(label, colour);

	return label;
}

/** `body`'s name, as a player's own screen spells it — the display name for a person, the alias for a rig. */
function nameOf(body: Model): string {
	const player = Players.GetPlayerFromCharacter(body);

	return player !== undefined ? player.DisplayName : body.Name;
}

/**
 * **`Hits: n | Outs: m`, or an em dash for a body the server keeps no record of.**
 *
 * **The em dash is the point of this function.** `StatsService` writes the two counts on the `Player` only — a
 * record outlives the bodies it was earned in, and a rig has no player — so a rig killer has no numbers to show.
 * A `0` there would be a claim (that it has thrown and missed), and a blank would look like a bug; `—` says
 * "not recorded", which is true.
 */
function describeStats(source: Instance): string {
	const hits = source.GetAttribute(STAT_HITS);
	const outs = source.GetAttribute(STAT_OUTS);

	if (!typeIs(hits, "number") || !typeIs(outs, "number")) return "Hits: — | Outs: —";

	return `Hits: ${hits} | Outs: ${outs}`;
}

/** Drops every subscription this overlay holds. Safe to call when there are none. */
function unbind(): void {
	for (const connection of live) connection.Disconnect();

	live = [];

	// **Blanked rather than left to be overwritten**, because the next shot may be a rig and a rig may render a
	// frame before `showEnemyView` writes again — an empty line is invisible where somebody else's name is a lie.
	if (nameLabel !== undefined) nameLabel.Text = "";
	if (statsLabel !== undefined) statsLabel.Text = "";

	// **And the header comes back**, because the next shot may be an ordinary hit death — the kind that does have a
	// view to name. A header left hidden by a catch would caption the next hit with a name and a stat line and no
	// heading at all, which reads as a panel that failed to draw its first line.
	if (headerLabel !== undefined) headerLabel.Visible = true;
}
