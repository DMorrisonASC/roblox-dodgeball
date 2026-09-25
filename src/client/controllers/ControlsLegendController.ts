import { Controller, OnStart } from "@flamework/core";
import { Text } from "@rbxts/big-ui";
import Fusion from "@rbxts/fusion-3.0";
import { Players } from "@rbxts/services";
import { THROW_ENABLED } from "shared/constants";
import { getHudScreenGui } from "../ui/screenGui";

/** Prints once, when the legend is up — the line that says the controller ran at all. */
const DEBUG = true;

/** How far the legend sits from the right screen edge, and how much padding inside its panel. */
const SCREEN_EDGE_GAP = 12;
const PANEL_PADDING_RL = 8;
const PANEL_PADDING_UB = 4;
const ROW_SPACING = 2;
const LABEL_GAP = 8;

/** What a switched-off row is drawn at, against the `0` of a live one. */
const DIMMED_TRANSPARENCY = 0.5;

/**
 * The two colours a row is drawn in: dimmer for what the ability is, brighter for how to use it.
 *
 * The keys are the brighter of the two on purpose. This is a card to *find a key* on, and a
 * player reads it by scanning the right-hand column for the shape they are looking for, so the
 * column the eye is hunting along is the one worth the contrast.
 */
const LABEL_COLOR = Color3.fromHSV(0, 0, 0);
const KEY_COLOR = Color3.fromHSV(0, 1, 0.75);

/**
 * U+26A1, the bolt beside the dodge's double-tap.
 *
 * A constant of its own because it is the one character in here whose drawing is not guaranteed.
 * big-ui sets its type in the Gotham family, which has no bolt in it, so whether this renders as
 * a bolt or as an empty box comes down to the engine's fallback for a glyph the font is missing.
 * It is kept because that fallback is broad on desktop and because a bolt is the clearest way to
 * say "twice, in quick succession" in a single character.
 *
 * **If it comes out as a box, or as a gap, this is the only line to change.** Read
 * {@link ROWS} as though it were not here — `WASD ×2` is still correct and costs nothing — and
 * do not swap in a second glyph, an image or a coloured frame, so that every row stays plain
 * text and the fallback is one edit rather than a different layout.
 */
const LIGHTNING = "⚡";

/**
 * One line of the legend: what an ability is, and how it is asked for.
 *
 * Everything the legend draws comes from these, and nothing else in the file names an ability.
 * Adding a row — a new key, a new control — is one entry in {@link ROWS} and no other change
 * anywhere, which is the whole point of the shape: the legend is a *reading* of this list rather
 * than a set of labels that happens to look like one.
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
	 * The player attribute whose state this row mirrors, if it mirrors one.
	 *
	 * A row without one is static. A row with one dims while the thing it names is switched off
	 * — see {@link isOff} for why that cannot be decided from the attribute alone.
	 */
	toggleAttribute?: string;

	/**
	 * Set when the attribute means "this is on" rather than "this is off".
	 *
	 * Only the polarity, never a per-row special case in the drawing code: `ThrowEnabled` is a
	 * name for a flag meaning throwing is *allowed*, so `true` is the ordinary state and the
	 * row dims on `false`. A future attribute named like `SprintDisabled` would carry nothing
	 * here and dim on `true`, which is the default.
	 */
	invert?: boolean;
}

/**
 * The legend, in the order it is drawn.
 *
 * Five abilities and the one of them that can be switched off. The lines here are the *only*
 * place these strings appear — no other file names a key or an ability — so this array is the
 * legend, and everything below it is layout.
 *
 * **Not listed:** the three throw shapes on `X`, `C` and `V`. They are real controls, and they
 * are absent because this list is what was asked for: one more entry here each puts them on the
 * card, and nothing else would have to change.
 */
const ROWS: LegendRow[] = [
	{ label: "Throw", keys: "LMB" },
	{ label: "Dodge", keys: `WASD ×2 ${LIGHTNING}` },
	{ label: "Catch", keys: "E" },
	{ label: "Drop", keys: "1" },
	{ label: "Throw Toggle", keys: "2", toggleAttribute: THROW_ENABLED, invert: true },
];

/**
 * Whether `row` should read as switched off, given its attribute's raw value.
 *
 * **The polarity is read off the attribute rather than assumed.** The plain rule is that a
 * toggle row dims while its attribute is `true`, which is right for a flag meaning "this is
 * switched off". `ThrowEnabled` is a flag meaning the opposite — `true` is throwing *allowed*,
 * the ordinary state — so its row carries `invert` and dims on `false`.
 *
 * An attribute nobody has written is **not** dimmed, whatever the row's polarity. That is the
 * state a player joins in, and it means the ability is available: the server's own rule is that
 * only an explicit `false` blocks a throw, so a legend that dimmed on "no value yet" would greet
 * every player by claiming their controls were off.
 */
function isOff(row: LegendRow, value: unknown): boolean {
	if (!typeIs(value, "boolean")) return false;

	return row.invert === true ? !value : value;
}

/**
 * The controls legend, right edge of the screen and vertically centred.
 *
 * A reference card rather than a readout: it says what the keys *do*, and the only thing on it
 * that moves is the one row whose control can be switched off. Nothing here shows whether an
 * ability is *ready* — the cooldown bars own that, in the bottom-left, and a second copy of it
 * would be two answers to one question.
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
		const scope = Fusion.scoped();
		const player = Players.LocalPlayer;

		const container = Fusion.New(scope, "Frame")({
			Name: "ControlsLegend",
			// Pinned by its right edge, halfway down, and sized to its contents: a card that
			// floats against the edge rather than a panel.
			AnchorPoint: new Vector2(1, 0.5),
			Position: new UDim2(1, -SCREEN_EDGE_GAP, 0.8, 0),
			AutomaticSize: Enum.AutomaticSize.XY,
			BackgroundTransparency: 1,
		});

		// The container's layout owns the *rows*. Right-aligning them is what makes the keys
		// column flush without any width being written down: a row is exactly as wide as its own
		// text, and packing every row to the right edge means they all *end* in the same place.
		//
		// Nothing above the container has a layout, and that is load-bearing — the container's
		// own `Position` is how it is pinned to the middle of the screen, and a layout over an
		// object's ancestor decides where that object goes instead.
    
		const layout = new Instance("UIListLayout");
		layout.FillDirection = Enum.FillDirection.Vertical;
		layout.SortOrder = Enum.SortOrder.LayoutOrder;
		layout.Padding = new UDim(0, ROW_SPACING);
		layout.HorizontalAlignment = Enum.HorizontalAlignment.Right;
		layout.Parent = container;

        const padding = new Instance("UIPadding");
        padding.PaddingLeft = new UDim(0, PANEL_PADDING_RL);
        padding.PaddingRight = new UDim(0, PANEL_PADDING_RL);
        padding.PaddingTop = new UDim(0, PANEL_PADDING_UB);
        padding.PaddingBottom = new UDim(0, PANEL_PADDING_UB);
        padding.Parent = container;

		let order = 0;
		for (const row of ROWS) {
			const drawn = this.buildRow(scope, player, row);

			// Numbered rather than left to the defaults, because the default sort is by name and
			// these rows are named after the abilities they show — so the list would come out
			// alphabetical and the card would read nothing like the order above.
			drawn.LayoutOrder = order;
			order++;
			drawn.Parent = container;
		}

		container.Parent = getHudScreenGui();

		if (DEBUG) print(`[HUD] controls legend up — ${ROWS.size()} rows`);
	}

	/**
	 * One row: its label, its keys, and — if it mirrors an attribute — the state they are drawn in.
	 *
	 * The row is generic over the descriptor, which is what makes a new entry in {@link ROWS} a
	 * complete change: nothing here knows what "Throw Toggle" is. The one `Value` a toggle row
	 * needs is made here from the attribute the descriptor names, and the value and its
	 * subscription are both handed to the scope, so they are cleaned up with the text they feed
	 * rather than outliving it.
	 */
	private buildRow(scope: Fusion.Scope<unknown>, player: Player, row: LegendRow): Frame {
		const frame = Fusion.New(scope, "Frame")({
			Name: `${row.label}Row`,
			AutomaticSize: Enum.AutomaticSize.XY,
			BackgroundTransparency: 1,
		});

		const layout = new Instance("UIListLayout");
		layout.FillDirection = Enum.FillDirection.Horizontal;
		layout.SortOrder = Enum.SortOrder.LayoutOrder;
		layout.Padding = new UDim(0, LABEL_GAP);
		layout.VerticalAlignment = Enum.VerticalAlignment.Center;
		layout.Parent = frame;

		let off: Fusion.Value<boolean> | undefined;
		const attribute = row.toggleAttribute;

		if (attribute !== undefined) {
			// Seeded from the attribute as it already stands, because the player may have pressed
			// `2` before this ever mounted — the server writes it on the *player*, which outlives
			// the character, so the state is already there waiting the first time a legend reads
			// it. Without the seed the row would sit at its default until the next press.
			const value = Fusion.Value(scope, isOff(row, player.GetAttribute(attribute)));
			off = value;

			scope.push(
				player.GetAttributeChangedSignal(attribute).Connect(() => {
					value.set(isOff(row, player.GetAttribute(attribute)));
				}),
			);
		}

		const label = this.buildText(scope, row.label, LABEL_COLOR, off);
		label.LayoutOrder = 1;
		label.Parent = frame;

		const keys = this.buildText(scope, row.keys, KEY_COLOR, off);
		keys.LayoutOrder = 2;
		keys.Parent = frame;

		return frame;
	}

	/**
	 * One piece of a row, in the HUD's own type.
	 *
	 * big-ui's `Text` supplies the font, the size and the line height, so the legend's type is the
	 * same as the rest of the HUD's and a change to the theme moves both. What it does not do is
	 * take a colour from outside its palette or bind anything reactively — it picks its colours
	 * from the theme and hands back a plain `TextLabel` — so the two things it cannot do are done
	 * here: the colour is written once, and the transparency is bound through a `Computed` when
	 * the row is a toggle and set flat when it is not.
	 */
	private buildText(
		scope: Fusion.Scope<unknown>,
		text: string,
		color: Color3,
		off: Fusion.Value<boolean> | undefined,
	): TextLabel {
		// Wrapping off, and the size below is why: a row's width has to come from its own text,
		// and big-ui's default is a label the full width of its parent sized to wrap inside it.
		// A parent sized to the label and a label sized to the parent is a circle, and Roblox
		// resolves it by guessing.
		const label = Text(scope, { text, variant: "caption", wrap: false });

		label.Size = UDim2.fromOffset(0, 0);
		label.AutomaticSize = Enum.AutomaticSize.XY;
		label.TextColor3 = color;

		if (off === undefined) {
			label.TextTransparency = 0;
			return label;
		}

		Fusion.Hydrate(scope, label)({
			TextTransparency: Fusion.Computed(scope, (use) => (use(off) ? DIMMED_TRANSPARENCY : 0)),
		});

		return label;
	}
}
