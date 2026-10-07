import { Controller, OnStart } from "@flamework/core";
import Fusion from "@rbxts/fusion-3.0";
import { Text } from "@rbxts/big-ui";
import { Players, ReplicatedStorage } from "@rbxts/services";
import {
	ROUND_MODE_ATTRIBUTE,
	ROUND_SCORE_A_ATTRIBUTE,
	ROUND_SCORE_B_ATTRIBUTE,
	ROUND_STATUS_FOLDER,
} from "shared/constants";
import { isGameModeId, teamColourOf } from "shared/gameMode";
import type { GameModeId } from "shared/gameMode";
import { getHudScreenGui } from "../../ui/screenGui";
import { hudTheme } from "../../ui/hudTheme";
import type { HudTheme } from "../../ui/hudTheme";
import { raiseZIndex } from "../../ui/panelChrome";
import { addViewportConstraint } from "../../ui/viewportConstraint";

/** Prints the mount line and each mode change. */
const DEBUG = true;

/**
 * The ZIndex of the whole bar, and every descendant of it.
 *
 * **Above the other HUDs and below the panels**, which is the rung a readout belongs on: the dock is 5 and
 * a panel is 10 (`PANEL_Z_INDEX`), so a score that can be covered by a panel is correct and a score that
 * covered a panel would not be. See {@link raiseZIndex} for why every descendant has to carry this number
 * rather than only the bar: a container raised above its children paints its own background over them.
 */
const SCORE_Z_INDEX = 4;

/**
 * How far below the top of the safe region the bar sits, in pixels.
 *
 * **Above the round status band, which is the order a scoreboard is read in**: the score is the thing that
 * changes and the clock is the thing counting down under it. That swap is why `HUD_TOP_INSET` in
 * `RoundStatusController` is no longer `0` — the band moved down one row rather than the score moving into
 * its way. Four rather than nought so the plate does not touch Roblox's topbar.
 */
const SCORE_TOP_INSET = 4;

/** The circle's diameter, in pixels. Big enough to read as a side, small enough not to be a button. */
const CIRCLE_SIZE = 14;

/** The gap between the parts of the bar, in pixels. */
const PART_GAP = 6;

/** How long each arm of a corner bracket is, and how thick, in pixels. */
const BRACKET_ARM = 9;
const BRACKET_THICKNESS = 2;

/** Only this mode keeps score. The server's own answer, spelled once on the client. */
const SCORING_MODE: GameModeId = "ScoreRush";

/**
 * The two sides' scores, in the round status band's own column.
 *
 * **Reads the pair the round publishes and nothing else.** `ROUND_SCORE_A_ATTRIBUTE` and
 * `ROUND_SCORE_B_ATTRIBUTE` are written by `RoundService.publishScores` on every hit, every catch and at
 * the opening of a round, so this is a reader of one fact and not a second copy of the scoring rule.
 *
 * **A controller of its own rather than more code in `RoundStatusController`, and the reason is the
 * attributes rather than taste.** The risk that argument warns about is two controllers reading the *same*
 * attribute and drifting — this reads two attributes that nothing else on the client reads at all, so there
 * is no second reader to drift from. What it would cost to fold in instead is real: that controller's band
 * is a fixed-width strip holding the phase, the clock, the mode name and a player count, and the clock is
 * out of scope, so adding to it means reflowing a HUD that currently works in order to hang two numbers off
 * it. This sits below that band and touches nothing.
 *
 * **Hidden in every other mode, rather than drawn zeroed.** A box reading `0 – 0` states a score, and "this
 * mode keeps no score" is a different fact from "the score is nothing to nothing" — the first is true and
 * the second would be invented. So the whole bar is `Visible` only while the mode is
 * {@link SCORING_MODE}. **In practice today that is always**, because both round start paths pass
 * `SCORE_RUSH` literally — Team Elimination and Dodge and Seek are implemented and unreachable, so the rule
 * has no observable effect in play yet. It is written for the day one of them is reachable, which is the
 * only day it can be wrong.
 *
 * **It stays up through the intermission, and that is the server's doing rather than this file's.**
 * `scores` is cleared at the *opening* of the next round, not at the end of the last one, so the final
 * score of a round is readable for the whole intermission that follows — the same lifetime `roundResult`
 * relies on. Nothing here has to hold or freeze anything.
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

		const theme = hudTheme();
		const folder = ReplicatedStorage.WaitForChild(ROUND_STATUS_FOLDER) as Folder;

		// Two numbers and a mode, each a `Value` fed from its own changed-signal. **A `Value` rather than a
		// `GetAttribute` inside a `Computed`**, because an attribute read is a sample rather than a
		// subscription — the bridge `StatsBillboardController` and `RoundStatusController` both use, for the
		// reason they give. This is also why nothing here polls: the signal fires when the server writes.
		const scoreA = Fusion.Value(this.scope, scoreOf(folder, ROUND_SCORE_A_ATTRIBUTE));
		const scoreB = Fusion.Value(this.scope, scoreOf(folder, ROUND_SCORE_B_ATTRIBUTE));
		const mode = Fusion.Value(this.scope, modeOf(folder));

		this.scope.push(
			folder.GetAttributeChangedSignal(ROUND_SCORE_A_ATTRIBUTE).Connect(() => scoreA.set(scoreOf(folder, ROUND_SCORE_A_ATTRIBUTE))),
		);
		this.scope.push(
			folder.GetAttributeChangedSignal(ROUND_SCORE_B_ATTRIBUTE).Connect(() => scoreB.set(scoreOf(folder, ROUND_SCORE_B_ATTRIBUTE))),
		);
		this.scope.push(folder.GetAttributeChangedSignal(ROUND_MODE_ATTRIBUTE).Connect(() => mode.set(modeOf(folder))));

		const bar = this.buildBar(theme, mode, scoreA, scoreB);

		if (DEBUG) {
			print(`[HUD] score bar up — ${ROUND_SCORE_A_ATTRIBUTE}/${ROUND_SCORE_B_ATTRIBUTE} on RoundStatus, ${SCORING_MODE} only`);
		}

		bar.Parent = getHudScreenGui(); // must stay the LAST statement
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
	private buildBar(
		theme: HudTheme,
		mode: Fusion.Value<string>,
		scoreA: Fusion.Value<number>,
		scoreB: Fusion.Value<number>,
	): Frame {
		const bar = Fusion.New(this.scope, "Frame")({
			Name: "ScoreBar",
			// No size of its own: the list layout and `AutomaticSize` make it exactly as big as its contents.
			Size: new UDim2(0, 0, 0, 0),
			AutomaticSize: Enum.AutomaticSize.XY,
			AnchorPoint: new Vector2(0.5, 0),
			Position: new UDim2(0.5, 0, 0, SCORE_TOP_INSET),
			BackgroundColor3: theme.colors.panel,
			BackgroundTransparency: 0,
			BorderSizePixel: 0,
			// The one reactive property on the plate: hidden unless this mode keeps score.
			Visible: Fusion.Computed(this.scope, (use) => use(mode) === SCORING_MODE),
		});

		Fusion.New(this.scope, "UICorner")({ Parent: bar, CornerRadius: new UDim(0, 10) });
		Fusion.New(this.scope, "UIStroke")({
			Parent: bar,
			Color: theme.colors.textDisabled,
			Thickness: 2,
			ApplyStrokeMode: Enum.ApplyStrokeMode.Border,
		});
		// **The padding is on the row rather than on the plate, and the brackets are the reason.** `UIPadding`
		// moves the origin its children are positioned against, so a bracket anchored at `(0, 0)` on a padded
		// plate lands on the *padded* corner — which is exactly where the row begins, and its vertical arm
		// would then be drawn straight across the first disc. Unpadded, the plate's corner is its own edge and
		// the brackets have the gutter to themselves.
		addViewportConstraint(this.scope, bar, { min: new Vector2(150, 0), max: new Vector2(420, 80) });

		// **The row is a child of the plate rather than the plate itself, and that is forced by the brackets.**
		// A `UIListLayout` positions every `GuiObject` child it has, so the four corner accents could not be
		// children of a frame that owns the layout — they would be swept into the row and stacked after the
		// second score. One level of nesting buys a background that lays out nothing and a row that lays out
		// only what belongs in it.
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
		// Wide enough that the brackets sit in empty plate rather than on the first and last discs.
		Fusion.New(this.scope, "UIPadding")({
			Parent: row,
			PaddingTop: new UDim(0, 12),
			PaddingBottom: new UDim(0, 12),
			PaddingLeft: new UDim(0, 24),
			PaddingRight: new UDim(0, 24),
		});

		this.addCircle(row, 1, theme, mode, "A");
		this.addScore(row, 2, theme, scoreA);
		this.addSeparator(row, 3, theme);
		this.addScore(row, 4, theme, scoreB);
		this.addCircle(row, 5, theme, mode, "B");

		// The brackets, on the plate's own corners and outside the row.
		this.addBracket(bar, theme, 0, 0);
		this.addBracket(bar, theme, 1, 0);
		this.addBracket(bar, theme, 0, 1);
		this.addBracket(bar, theme, 1, 1);

		// **After the parts, because it walks what exists.** Every descendant carries the bar's ZIndex, which
		// is the only way an opaque plate can hold children that are drawn on top of it.
		raiseZIndex(bar, SCORE_Z_INDEX);

		return bar;
	}

	/**
	 * One corner accent: two thin bars meeting at a corner.
	 *
	 * **The one piece of the reference's shape language this HUD borrows**, and the reason the bar stopped
	 * reading as a blank pill: a plate with four corner marks has a frame rather than an outline, which is the
	 * difference between a box and a *display*.
	 *
	 * **Two rectangles rather than a nine-slice image**, for the reason the circle is a `UICorner` — a raw
	 * instance costs no asset, takes any size without resampling, and cannot drift from the theme. An
	 * `ImageLabel` bracket would need art, a slice scale, and a colour that no longer followed
	 * `theme.colors`.
	 *
	 * **Positioned by `AnchorPoint` at the corner it belongs to**, so four brackets are one helper called with
	 * four pairs of numbers rather than four pieces of arithmetic against a width the plate does not know yet:
	 * it is sized by its contents, so any computed offset would be a guess. See {@link BRACKET_ARM}.
	 */
	private addBracket(parent: Frame, theme: HudTheme, ax: number, ay: number): void {
		const bars: ReadonlyArray<readonly [number, number]> = [
			[BRACKET_ARM, BRACKET_THICKNESS],
			[BRACKET_THICKNESS, BRACKET_ARM],
		];

		for (const [width, height] of bars) {
			Fusion.New(this.scope, "Frame")({
				Name: "Bracket",
				Parent: parent,
				AnchorPoint: new Vector2(ax, ay),
				Position: UDim2.fromScale(ax, ay),
				Size: UDim2.fromOffset(width, height),
				BackgroundColor3: theme.colors.textSecondary,
				BackgroundTransparency: 0,
				BorderSizePixel: 0,
			});
		}
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
	 * **A square `Frame` with a `UICorner` at `UDim(1, 0)`, not an `ImageLabel`.** The corner radius is a raw
	 * instance that costs no asset, scales to any diameter without resampling, and survives the planned PNG
	 * swap untouched; an image would need art for a shape the engine draws exactly.
	 *
	 * **Its colour is the one place this HUD leaves the theme, deliberately.** `teamColourOf` is a *world*
	 * colour: the same value paints the team ring and the outline on a body in the arena, so a player reads
	 * their side off the scoreboard and off their own character as the same colour. The theme's palette is a
	 * UI language and has no vocabulary for sides, and inventing one here would be a second answer to a
	 * question the game has already answered.
	 */
	private addCircle(
		parent: Frame,
		order: number,
		theme: HudTheme,
		mode: Fusion.Value<string>,
		label: "A" | "B",
	): void {
		const circle = Fusion.New(this.scope, "Frame")({
			Name: `Side${label}`,
			Parent: parent,
			Size: UDim2.fromOffset(CIRCLE_SIZE, CIRCLE_SIZE),
			LayoutOrder: order,
			BackgroundTransparency: 0,
			BorderSizePixel: 0,
		});
		Fusion.New(this.scope, "UICorner")({ Parent: circle, CornerRadius: new UDim(1, 0) });
		// A ring in the plate's own colour, so the disc reads as a disc rather than as a hole in the plate. It is
		// the same trick the tiles use to separate a card from the surface behind it.
		Fusion.New(this.scope, "UIStroke")({
			Parent: circle,
			Color: theme.colors.panel,
			Thickness: 2,
			ApplyStrokeMode: Enum.ApplyStrokeMode.Border,
		});

		// **Resolved from the mode at the moment it draws rather than captured once**, so a mode change
		// repaints the circles. `teamColourOf` answers nothing for a mode with no colour pair, and the
		// fallback is the theme's own border colour rather than a guess at a side.
		Fusion.Hydrate(this.scope, circle)({
			BackgroundColor3: Fusion.Computed(this.scope, (use) => {
				const current = use(mode);
				// The theme's own hairline is the fallback rather than a guessed side colour: a mode with no colour
				// pair leaves an outline-coloured dot, which reads as "no side" rather than as somebody's.
				if (!isGameModeId(current)) return theme.colors.border;
				return teamColourOf(current, label) ?? theme.colors.border;
			}),
		});
	}

	/** One side's number. */
	private addScore(parent: Frame, order: number, theme: HudTheme, score: Fusion.Value<number>): void {
		const label = Text(this.scope, {
			text: Fusion.Computed(this.scope, (use) => tostring(use(score))),
			variant: "subtitle1",
			wrap: false,
		});
		label.Name = "Score";
		label.TextColor3 = theme.colors.textPrimary;
		// **This override is the whole fix for a bar that drew as a full-width banner.** big-ui's `Text`
		// defaults to `Size = (1, 0, lineHeight)` — a *scale-1* width — and this bar's plate is sized by its
		// contents. A scale-1 child inside a content-sized row is a measurement cycle: the label asks the plate
		// how wide it is, the plate asks the label, and what Roblox resolves it to is a plate hundreds of pixels
		// wide with two small numbers stranded in the middle of it. A zero-offset size plus `AutomaticSize.XY`
		// makes the label exactly as wide as the number it holds, which is what lets the plate hug its row.
		//
		// Every other `Text` in this project overrides its size for some version of this reason — `addTile`
		// scales its labels to a fixed box, `addNoteLine` lets one grow downwards, the header pill hugs. This
		// is the same rule read from the other end: a label in a row that sizes itself must not claim a
		// fraction of it.
		label.Size = UDim2.fromOffset(0, 0);
		label.AutomaticSize = Enum.AutomaticSize.XY;
		label.LayoutOrder = order;
		label.Parent = parent;
	}

	/**
	 * The separator between the two scores: a rule, not a word.
	 *
	 * A single dash or a `/` would be a character at the mercy of the font's advance width; a two-pixel frame
	 * in the theme's hairline colour is exactly the divider the panels use and reads the same way at any size.
	 */
	private addSeparator(parent: Frame, order: number, theme: HudTheme): void {
		const rule = Fusion.New(this.scope, "Frame")({
			Name: "Separator",
			Parent: parent,
			Size: UDim2.fromOffset(2, CIRCLE_SIZE),
			BackgroundColor3: theme.colors.textSecondary,
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

/** The mode the round is publishing, or `""` while it has not said. */
function modeOf(folder: Instance): string {
	const value = folder.GetAttribute(ROUND_MODE_ATTRIBUTE);

	return typeIs(value, "string") ? value : "";
}
