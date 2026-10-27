import { Controller, OnStart } from "@flamework/core";
import Fusion from "@rbxts/fusion-3.0";
import { Text } from "@rbxts/big-ui";
import { Players, ReplicatedStorage } from "@rbxts/services";
import { ROUND_SCORE_A_ATTRIBUTE, ROUND_SCORE_B_ATTRIBUTE, ROUND_STATUS_FOLDER } from "shared/constants";
import { teamColourOf } from "shared/gameMode";
import { DEBUG_LOGGING, logInfo } from "shared/logger";
import { applyGlow, applyTextGlow } from "../../ui/glow";
import { PREMIUM } from "../../ui/premiumTheme";
import { getHudColumn } from "../../ui/screenGui";
import { raiseZIndex } from "../../ui/panelChrome";
import { addViewportConstraint } from "../../ui/viewportConstraint";

/**
 * The ZIndex of the whole bar, and every descendant of it.
 *
 * **Against the rest of the screen this number no longer decides anything, and that is the 2026-10-19
 * change.** The bar lives in the readout column, and the column lives in `FullScreenGui`, whose `DisplayOrder`
 * is `-1` — `ZIndex` orders siblings within one tree and says nothing across two `ScreenGui`s, so whether a
 * panel covers the score (a panel is `PANEL_Z_INDEX` = 10, in the shared HUD GUI) is now the GUI ladder's
 * answer rather than this number's. What is left for it is inside the column, where the bar and the clock do
 * not overlap at all — the `UIListLayout` places them — so its only remaining job is to be the baseline the
 * bar's own descendants are raised to. See {@link raiseZIndex} for why every descendant has to carry it rather
 * than only the bar: a container raised above its children paints its own background over them.
 */
const SCORE_Z_INDEX = 4;

/** The circle's diameter, in pixels. Big enough to read as a side, small enough not to be a button. */
const CIRCLE_SIZE = 14;

/** The gap between the parts of the bar, in pixels. */
const PART_GAP = 10;

/**
 * The width of one side's score, in pixels, and **the whole of the symmetry the row has.**
 *
 * **A fixed box rather than the number's own width, because the row has to read the same in every state.** With
 * auto-size the box was exactly as wide as the number in it, so `7 | 3` and `7 | 12` were two different rows:
 * the wider number pushed the right-hand disc outwards, and the divider — which sits between the *two numbers*
 * rather than at the bar's centre — slid left as soon as the two sides stopped having the same digit count. Even
 * at equal counts no two digits occupy the same width, so a bar that hugged its text was never quite symmetric.
 * Both labels are this wide and each number is drawn centred inside it, so every state lays out identically.
 *
 * **`44`, which is two digits at `h4` with about a pixel of slack either side. Placeholder — arithmetic rather
 * than a measurement.** `h4` is 34px with a 42px line height, read out of big-ui's own `Typography`; the *face*
 * it is drawn in is not the one that table names, because `ThemeController` writes `UI_FONT` — `GothamBlack` —
 * into all ten variants, so the widest a score can be is two of that face's figures. A geometric sans figure
 * advances about `0.6em`, so `99` is roughly `2 × 0.6 × 34 ≈ 41px` and `44` is that rounded up. **Loose rather
 * than tight on purpose**: the slack is invisible (the box has no background of its own), so the only visible
 * effect of this number is how much air sits between a score and the parts either side of it.
 *
 * **What a wrong value costs, named rather than left to be discovered.** The label does not clip: `wrap: false`
 * is passed, `TextTruncate` is at its default `None` and nothing above the label sets `ClipsDescendants`, so a
 * number wider than this box still draws *in full* and centred, spilling evenly out of both sides. A value a
 * pixel or two short therefore costs a pixel or two of symmetry on the widest score and never a digit — which is
 * why this can be reasoned about here at all instead of measured. **What a Studio look would settle is whether
 * `99` sits with visible air around it**, and that is a glance rather than a number to tune.
 *
 * **It is not reserved for three digits.** The score cannot exceed `99` (the user's own bound), and a box built
 * for a number that cannot occur would carry that extra width through every round of every match. The widest
 * state it is built for is the one to size it from.
 */
const SCORE_WIDTH = 44;

/**
 * The two sides' scores, in the round status band's own column.
 *
 * **Reads the pair the round publishes and nothing else.** `ROUND_SCORE_A_ATTRIBUTE` and
 * `ROUND_SCORE_B_ATTRIBUTE` are written by `RoundService.publishScores` on every hit, every catch, at the
 * opening of a round and as one ends, so this is a reader of one fact and not a second copy of the scoring
 * rule. It reads **no phase and no mode**: see below for why that stopped being necessary.
 *
 * **A controller of its own rather than more code in `RoundStatusController`, and the reason is the
 * attributes rather than taste.** The risk that argument warns about is two controllers reading the *same*
 * attribute and drifting — this reads two attributes that nothing else on the client reads at all, so there
 * is no second reader to drift from. What it would cost to fold in instead is real: that controller's band
 * is a fixed-width strip holding the phase, the clock and the mode name, so adding to it means reflowing a
 * HUD that currently works in order to hang two numbers off it. This sits below that band and touches
 * nothing. **This paragraph used to list a player count among the band's contents**, which the band has not
 * had since that third face was removed — corrected here rather than left as a claim about another file.
 *
 * **Always up, in every phase and every mode, and that reverses what this file argued.** It used to be drawn
 * only while `ROUND_MODE_ATTRIBUTE` was `ScoreRush`, on the argument that a bar reading `0 – 0` in a mode that
 * keeps no score states something invented rather than something absent. **That is still true of the
 * sentence** — the two sides' points really are nothing to nothing in a mode that has none — and it was wrong
 * about *permanence*: a readout that comes and goes leaves a hole where a readout was, and the hole is the
 * louder of the two facts. It appeared for the whole of a server's first intermission (the mode is only
 * published when a round opens, and the vote that could publish it earlier is switched off) and in every
 * phase of a mode that does not score, so what a player would learn to read is the bar's *absence* — which is
 * the opposite of what a scoreboard is for. The decision is that it is always up; **the cost, named rather
 * than hidden, is a `0 – 0` on screen in a mode that keeps no score.** No mode that is reachable today
 * scores nothing, so nothing observable changes until one is.
 *
 * **It reads `0 – 0` between rounds, and that is the server's doing rather than this file's.** `scores` is
 * cleared as a round *ends* — with the round-end transition cover over the screen while it happens — so the
 * intermission and the freshly opened round after it both read nothing to nothing. Nothing here holds,
 * freezes or resets anything: the two attributes are the whole of the state.
 */
@Controller()
export class ScoreHudController implements OnStart {
	private scope = Fusion.scoped();
	private mounted = false;

	onStart(): void {
		// Spawned rather than inline, matching every other HUD: mounting waits for `PlayerGui` and for the
		// round's status folder, and a controller's `onStart` is the wrong place to hold up the client's boot.
		task.spawn(() => this.mount());
	}

	private mount(): void {
		if (this.mounted) return;
		this.mounted = true;

		const folder = ReplicatedStorage.WaitForChild(ROUND_STATUS_FOLDER) as Folder;

		// Two numbers, each a `Value` fed from its own changed-signal. **A `Value` rather than a `GetAttribute`
		// inside a `Computed`**, because an attribute read is a sample rather than a subscription — the bridge
		// `StatsBillboardController` and `RoundStatusController` both use, for the reason they give. This is
		// also why nothing here polls: the signal fires when the server writes.
		//
		// **There is no third `Value` for the mode any more**, which is what the bar's visibility used to
		// hang off. See the class doc: the bar is always up, so the mode is a fact this file has no use for
		// and no longer subscribes to.
		const scoreA = Fusion.Value(this.scope, scoreOf(folder, ROUND_SCORE_A_ATTRIBUTE));
		const scoreB = Fusion.Value(this.scope, scoreOf(folder, ROUND_SCORE_B_ATTRIBUTE));

		this.scope.push(
			folder.GetAttributeChangedSignal(ROUND_SCORE_A_ATTRIBUTE).Connect(() => scoreA.set(scoreOf(folder, ROUND_SCORE_A_ATTRIBUTE))),
		);
		this.scope.push(
			folder.GetAttributeChangedSignal(ROUND_SCORE_B_ATTRIBUTE).Connect(() => scoreB.set(scoreOf(folder, ROUND_SCORE_B_ATTRIBUTE))),
		);

		const bar = this.buildBar(scoreA, scoreB);

		if (DEBUG_LOGGING) {
			logInfo(`[HUD] score bar up — ${ROUND_SCORE_A_ATTRIBUTE}/${ROUND_SCORE_B_ATTRIBUTE} on RoundStatus, every phase`);
		}

		bar.Parent = getHudColumn(); // must stay the LAST statement
	}

	/**
	 * The bar: plate, then the five parts in a row.
	 *
	 * **The layout is a horizontal `UIListLayout` over `AutomaticSize.XY`**, so the bar is exactly as wide as
	 * the six things in it and there is no computed position anywhere — the standard's first rule, and the one
	 * that matters most here because the scores change width as they grow from `4` to `40`. A bar with a fixed
	 * width would have to reserve room for the widest number and would look empty at the start of every round.
	 *
	 * **`addViewportConstraint` is what stops that hugging becoming a leak on a phone**, where
	 * `AutomaticSize` would happily grow the bar past the screen edge: the constraint floors it at a readable
	 * size and caps it, so it neither collapses to nothing nor runs off the glass.
	 */
	private buildBar(scoreA: Fusion.Value<number>, scoreB: Fusion.Value<number>): Frame {
		const bar = Fusion.New(this.scope, "Frame")({
			Name: "ScoreBar",
			// No size of its own: the list layout and `AutomaticSize` make it exactly as big as its contents.
			Size: new UDim2(0, 0, 0, 0),
			AutomaticSize: Enum.AutomaticSize.XY,
			// **The bar does not put itself anywhere.** It is a child of the shared readout column, which owns
			// the offset from the top of the safe region and places its children one under the other — so the
			// `Position` and `AnchorPoint` that used to be here are gone rather than left to be overwritten.
			// **The anchor is now load-bearing in the other direction**: a `UIListLayout` writes a child's
			// `Position` but does not know about its `AnchorPoint`, so a bar still anchored at `(0.5, 0)` would
			// be drawn half its own width to the left of the slot the layout gave it. Zero is the value that
			// means "where the layout put me".
			AnchorPoint: Vector2.zero,
			// The column's contract: `1` is the scores, `2` is the clock. See `getHudColumn`.
			LayoutOrder: 1,
			// **The theme's plum at the theme's transparency**, which is the whole of what this pass changes about
			// the plate. It was the light palette's paper at full opacity — a cream slab, which is a fine thing to
			// put over a light HUD and the loudest object on a bright arena. Plum at `0.15` is a surface with the
			// game still visible through it, and it is the same fill the clock, the Enemy View and the pill wear.
			BackgroundColor3: PREMIUM.panel,
			BackgroundTransparency: PREMIUM.transparency,
			BorderSizePixel: 0,
		});

		// **A four-pixel corner rather than the plate's old ten**, from the theme: sporty rather than soft, and the
		// same corner every other surface in this direction wears.
		Fusion.New(this.scope, "UICorner")({ Parent: bar, CornerRadius: new UDim(0, PREMIUM.corner) });
		// **The plate's neon edge**, core plus bloom — see `ui/glow.ts`. The bar is the first thing a player's eye
		// lands on in a round, so it is the one panel where the bloom is doing real work: it separates the readout
		// from a dark arena without a heavy fill.
		applyGlow(bar);
		// **The padding is on the row rather than on the plate.** The plate is the *surface* and the row is the
		// *content*, so the gutter belongs to the thing that holds contents; the plate keeps its corner radius
		// and its stroke to itself and lays nothing out beyond placing the one child it has. **The corner
		// accents used to be the reason this was forced** — `UIPadding` moves the origin its children are
		// positioned against, so an accent anchored at `(0, 0)` on a padded plate landed on the *padded* corner
		// instead of the plate's own. Those accents have gone, and the split outlives them because it is the
		// right way round rather than because it is needed.
		addViewportConstraint(this.scope, bar, { min: new Vector2(150, 0), max: new Vector2(420, 80) });

		// **The row is a child of the plate rather than the plate itself.** A `UIListLayout` positions every
		// `GuiObject` child it has, so putting it on the plate would make the plate a thing that lays out its
		// own contents; one level of nesting keeps the surface and the content separate, and it is what the
		// four corner accents used to require outright — they could not have been children of a frame that owns
		// the layout, or they would have been swept into the row and stacked after the second score. **With
		// those accents gone the nesting is no longer forced**, and it is kept deliberately: it draws exactly
		// the same pixels, and unwinding it in the same pass as a visual change would make a Studio run that
		// comes back wrong impossible to read.
		const row = Fusion.New(this.scope, "Frame")({
			Name: "Row",
			Parent: bar,
			Size: new UDim2(0, 0, 0, 0),
			AutomaticSize: Enum.AutomaticSize.XY,
			BackgroundTransparency: 1,
		});
		Fusion.New(this.scope, "UIListLayout")({
			Parent: row,
			FillDirection: Enum.FillDirection.Horizontal,
			SortOrder: Enum.SortOrder.LayoutOrder,
			VerticalAlignment: Enum.VerticalAlignment.Center,
			Padding: new UDim(0, PART_GAP),
		});
		// The gutter between the plate's edge and the first and last parts of the row.
		Fusion.New(this.scope, "UIPadding")({
			Parent: row,
			PaddingTop: new UDim(0, 6),
			PaddingBottom: new UDim(0, 6),
			PaddingLeft: new UDim(0, 4),
			PaddingRight: new UDim(0, 4),
		});

		// **The numbers take the theme's two side colours, and the discs keep the world's.** That split is the one
		// judgement in this bar: `teamColourOf` is the colour that paints a body's ring and outline in the arena, so
		// a disc in it is how a player knows which score is whose — repainting the discs crimson and teal would cut
		// that link for the sake of a neater palette. The digits sit directly beside their disc, so tinting *them*
		// from the same five colours reads as one side at a glance without costing the identification.
		this.addCircle(row, 1, "A");
		this.addScore(row, 2, PREMIUM.sideA, scoreA);
		this.addSeparator(row, 3);
		this.addScore(row, 4, PREMIUM.sideB, scoreB);
		this.addCircle(row, 5, "B");

		// **After the parts, because it walks what exists.** Every descendant carries the bar's ZIndex, which
		// is the only way an opaque plate can hold children that are drawn on top of it.
		raiseZIndex(bar, SCORE_Z_INDEX);

		return bar;
	}

	/**
	 * One side's indicator: a circle in that side's colour, and **nothing written in it**.
	 *
	 * **A circle cannot hold a word, and that is the design rather than a limitation.** The reference layout
	 * uses labelled squares; a circle is too small for `Red` and too round to read a word against, so the
	 * colour has to carry the side on its own — which is what it was already doing next to the word. The
	 * word was the redundant half. No team-name label was added beside it: the two circles are the two ends
	 * of one short row, one of them sits next to each score, and `MODE_SIDE_NAMES` gives those sides names
	 * that change per mode — a label would be pinned to the wrong ones the moment a second mode is reachable.
	 *
	 * **These two discs are now the only thing saying which score is which side**, which is worth stating
	 * because it is what the pass that removed the corner accents left behind. The accents were the bar's one
	 * pure decoration — two thin bars meeting at each of the plate's four corners — and the reason they went is
	 * that they carried no information: a plate with four corner marks reads as a *viewfinder*, which is a
	 * shape that says "something is being targeted" rather than "this is the score". Anything the bar draws
	 * from here on should be read against that: the plate, the two discs, the two numbers and the divider are
	 * the whole of it.
	 *
	 * **A square `Frame` with a `UICorner` at `UDim(1, 0)`, not an `ImageLabel`.** The corner radius is a raw
	 * instance that costs no asset, scales to any diameter without resampling, and survives the planned PNG
	 * swap untouched; an image would need art for a shape the engine draws exactly.
	 *
	 * **Its colour is the one place this HUD leaves the theme, deliberately.** `teamColourOf` is a *world*
	 * colour: the same value paints the team ring and the outline on a body in the arena, so a player reads
	 * their side off the scoreboard and off their own character as the same colour. The theme's palette is a
	 * UI language and has no vocabulary for sides, and inventing one here would be a second answer to a
	 * question the game has already answered.
	 *
	 * **Painted once rather than recomputed, which is what the colour change bought.** This used to be a
	 * `Computed` over the mode, because the same label was a different colour in a different mode and a mode
	 * change had to repaint both discs. The colour is now the same in every mode, so the only thing left that
	 * could change it is the label — and a circle is built with one and never re-labelled. **The fallback has
	 * become a type guard rather than a live case**: the two labels here are literals, so `teamColourOf` cannot
	 * answer nothing, and `?? theme.colors.border` exists to turn its `Color3 | undefined` into a `Color3`. The
	 * two world readers still have the live version of that case — their labels come off an attribute — and
	 * they keep the same fallback for it.
	 */
	private addCircle(parent: Frame, order: number, label: "A" | "B"): void {
		const circle = Fusion.New(this.scope, "Frame")({
			Name: `Side${label}`,
			Parent: parent,
			Size: UDim2.fromOffset(CIRCLE_SIZE, CIRCLE_SIZE),
			LayoutOrder: order,
			BackgroundColor3: teamColourOf(label) ?? PREMIUM.stroke,
			BackgroundTransparency: 0,
			BorderSizePixel: 0,
		});
		Fusion.New(this.scope, "UICorner")({ Parent: circle, CornerRadius: new UDim(1, 0) });
		// A ring in the plate's own colour, so the disc reads as a disc rather than as a hole in the plate. It is
		// the same trick the tiles use to separate a card from the surface behind it — and it has to follow the
		// plate, which is why it is the theme's plum now rather than the palette's paper.
		Fusion.New(this.scope, "UIStroke")({
			Parent: circle,
			Color: PREMIUM.panel,
			Thickness: 2,
			ApplyStrokeMode: Enum.ApplyStrokeMode.Border,
		});
	}

	/**
	 * One side's number, **in the fixed box that makes the two sides interchangeable.**
	 *
	 * The box's width is the whole reason the row is symmetric — see {@link SCORE_WIDTH} for the number and how
	 * it was arrived at — and the argument for each of the three overrides below is written where they are set.
	 */
	private addScore(parent: Frame, order: number, colour: Color3, score: Fusion.Value<number>): void {
		const label = Text(this.scope, {
			text: Fusion.Computed(this.scope, (use) => tostring(use(score))),
			variant: "h4",
			wrap: false,
		});
		label.Name = "Score";
		// **The side's colour, handed in rather than read here**, because this method draws one of two numbers and
		// knows nothing about sides — the caller is the only place that knows which one it is drawing. The value is
		// the theme's crimson or teal; see the call site for why the *numbers* take those and the discs do not.
		//
		// **And it takes the theme's text alpha like every other label**, which is the direction's rule rather than
		// a choice: a two-digit score at `0.15` over solid plum is still the loudest thing in the bar, and the fade
		// is what stops two saturated numbers reading as a warning. See `PREMIUM.textTransparency`.
		label.TextColor3 = colour;
		label.TextTransparency = PREMIUM.textTransparency;
		// **And the halo**, so the two numbers read as lit rather than as painted. Its colour is the side's, not the
		// theme's cyan: a red number glowing cyan would be two lights doing one job.
		applyTextGlow(label, colour);
		// **A fixed width and an automatic height, and the two axes are answered differently on purpose.**
		//
		// **The width is fixed so that a one-digit score and a two-digit score occupy the same space.** Auto-size
		// on the width is what made the row move: the box was exactly as wide as the number in it, so a score of
		// `12` pushed everything to its right outwards, and the divider — centred on the pair of numbers rather
		// than on the bar — ended up off-centre the moment the two sides disagreed about digit count. A fixed box
		// with the number centred in it is the same pixels in every state.
		//
		// **The height is left automatic because a variant is not a fixed thing.** This box is only as tall as the
		// line the variant asks for, so a re-mapped `h4` — or a swap to another variant — grows the bar rather
		// than being clipped by a height that was chosen before the font was.
		//
		// **This override has a first version, and its reason is worth keeping.** big-ui's `Text` defaults to
		// `Size = (1, 0, lineHeight)` — a *scale-1* width — and this bar's plate is sized by its contents, so the
		// original fix was a zero-offset size with `AutomaticSize.XY`: a scale-1 child inside a content-sized row
		// is a measurement cycle, where the label asks the plate how wide it is, the plate asks the label, and what
		// Roblox resolves it to is a plate hundreds of pixels wide with two small numbers stranded in the middle of
		// it. **What that trap wants is not auto-size — it is a width that is not a fraction of the parent**, and a
		// fixed offset is exactly that: `SCORE_WIDTH` is a number of pixels the label knows on its own, so the
		// plate can size itself from a child that never asks it anything. The cycle is avoided by the same rule as
		// before, read from the other end.
		//
		// **`TextXAlignment`, because big-ui left-aligns and the free space is now inside the box.** Its own
		// construction sets `TextXAlignment = props.align or Enum.TextXAlignment.Left` (`out/components/Text.luau`),
		// which was invisible while the box hugged the text and is not invisible now — `44` is wider than `7`, and
		// without this the one-digit score would sit against the left edge of a box whose whole purpose is to hold
		// two different widths in the same shape. (`TextProps.align` is the same property reached by the prop
		// route; the assignment is used so that all three overrides on this label are read together.)
		//
		// Every other `Text` in this project overrides its size for some version of this reason — `addTile`
		// scales its labels to a fixed box, `addNoteLine` lets one grow downwards, the header pill hugs. This
		// is the same rule read from the other end: a label in a row that sizes itself must not claim a
		// fraction of it.
		label.Size = UDim2.fromOffset(SCORE_WIDTH, 0);
		label.AutomaticSize = Enum.AutomaticSize.Y;
		label.TextXAlignment = Enum.TextXAlignment.Center;
		label.LayoutOrder = order;
		label.Parent = parent;
	}

	/**
	 * The separator between the two scores: a rule, not a word.
	 *
	 * A single dash or a `/` would be a character at the mercy of the font's advance width; a two-pixel frame
	 * in the theme's hairline colour is exactly the divider the panels use and reads the same way at any size.
	 */
	private addSeparator(parent: Frame, order: number): void {
		const rule = Fusion.New(this.scope, "Frame")({
			Name: "Separator",
			Parent: parent,
			Size: UDim2.fromOffset(2, CIRCLE_SIZE),
			// **The theme's gold, because it is the only line this direction owns.** The old value was the light
			// palette's secondary text — near-black — which on a plum plate is not a rule but a notch. Gold reads as
			// punctuation between two numbers without competing with either of the two side colours beside it.
			BackgroundColor3: PREMIUM.gold,
			BackgroundTransparency: 0,
			BorderSizePixel: 0,
			LayoutOrder: order,
		});
		Fusion.New(this.scope, "UICorner")({ Parent: rule, CornerRadius: new UDim(1, 0) });
	}
}

/** A numeric attribute on the round's status folder, or `0`. */
function scoreOf(folder: Instance, name: string): number {
	const value = folder.GetAttribute(name);

	return typeIs(value, "number") ? value : 0;
}
