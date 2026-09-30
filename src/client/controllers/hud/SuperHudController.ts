import { Controller, OnStart } from "@flamework/core";
import { Card, Text } from "@rbxts/big-ui";
import Fusion from "@rbxts/fusion-3.0";
import { Players, RunService } from "@rbxts/services";
import { abilityOn, ABILITY_NAMES, isAbilityKind } from "shared/ability";
import { SUPER_CONFIG } from "shared/config/super.config";
import {
	ARMED_ABILITY_ATTRIBUTE,
	BALL_NAME,
	SUPER_CHARGE_ATTRIBUTE,
	SUPER_STREAK_ATTRIBUTE,
} from "shared/constants";
import { HudTheme, hudTheme } from "../../ui/hudTheme";
import { getHudScreenGui } from "../../ui/screenGui";
import { addViewportConstraint } from "../../ui/viewportConstraint";

/** Prints once, when the strip is up — the line that says the controller ran at all. */
const DEBUG = true;

/** How far the strip sits in from the left edge, in pixels. Matches the cooldown readout's inset. */
const EDGE_PADDING = 12;

/**
 * How far up from the bottom edge the strip sits, in pixels.
 *
 * **A number that exists because two readouts share a corner and neither knows about the other.** The
 * cooldown card is pinned to the bottom-left and sizes itself to its contents — three rows of a label
 * and an 8px bar — so this strips sits above it rather than being laid out beside it. A fixed offset
 * is the honest version of that: the alternative is for one HUD to reach into the other for a
 * measurement, which would make the cooldown readout's contents a dependency of this file. It needs
 * changing only if the cooldown card grows a fourth row.
 */
const BOTTOM_OFFSET = 200;

/** The gap between the strip's rows. Matches the cooldown card's own spacing. */
const ROW_SPACING = 4;

/** The gap between a row's label and its value, in pixels. */
const LABEL_GAP = 8;

/**
 * What the value column reads when there is nothing to report.
 *
 * A dash rather than a blank, because a blank column is indistinguishable from a readout that has
 * failed to draw — the same reason the loading screen draws a spinner rather than nothing.
 */
const NOTHING = "—";

/**
 * The streak, the charge, and whether the ball in hand is marked.
 *
 * **A readout of two attributes and one ball, and nothing here decides anything.** The streak and the
 * charge are on the *player*, written by `SuperService`, and the mark is on the ball — so the only
 * thing this controller does is read, which is what makes it impossible for it to disagree with the
 * rule it is showing. Nothing is sent, nothing is asked for, and no reply is waited on.
 *
 * **Why `3/6` rather than six pips.** The count is the mechanic — "three more" is a number, and six
 * marks a player has to count is the same number with more drawing. It also matches what a player can
 * already read about themselves: this game prints its figures as pairs (`21H/6O`), the legend's rows
 * are label-and-text, and a pip row would be six frames and a layout saying what five characters say.
 * The denominator comes from {@link SUPER_CONFIG}, the same number the server grants at, so the
 * readout cannot drift from the rule.
 *
 * **Why one `RenderStepped` loop for three values, two of which are discrete.** The two player
 * attributes change rarely, and on their own they would want `GetAttributeChangedSignal` — that is
 * what the legend's toggle row does. The third does not: the ball in hand is a *different instance*
 * after every throw, catch and respawn, so a subscription to it would have to be rebuilt on each of
 * those, and a subscription that is rebuilt is a subscription that can be missed. One loop that reads
 * all three is one mechanism instead of two, and its cost is two attribute reads and one
 * `FindFirstChild` per frame — which is `CooldownHudController`'s argument for its own loop, reached
 * the same way.
 */
@Controller()
export class SuperHudController implements OnStart {
	public onStart(): void {
		// Spawned rather than done inline: mounting waits for `PlayerGui`, and a controller's `onStart`
		// is the wrong place to hold up the rest of the client's boot — as every HUD here does it.
		task.spawn(() => this.mount());
	}

	private mount(): void {
		const scope = Fusion.scoped();
		const player = Players.LocalPlayer;

		// The HUD's colours, read now rather than at module load: `configureTheme` has run by the time
		// anything mounts, and a value captured earlier would be Material's default.
		const theme = hudTheme();

		// Both seeded empty, so a player who has never hit anybody sees a readout rather than a card
		// waiting for its first value. The attributes do not exist until `SuperService` first publishes
		// them, and `0/6` is the honest reading of "nothing written yet".
		const streakText = Fusion.Value(scope, `0/${SUPER_CONFIG.STREAK_REQUIRED}`);
		const chargeText = Fusion.Value(scope, NOTHING);
		const ballText = Fusion.Value(scope, NOTHING);

		// Rows first: `Card` takes its children at construction and parents them itself.
		const streakRow = this.addRow(scope, theme, "Streak", streakText);
		streakRow.LayoutOrder = 1;

		const chargeRow = this.addRow(scope, theme, "Charge", chargeText);
		chargeRow.LayoutOrder = 2;

		// **Labelled for the ability rather than for the ball**, because the row answers "what is loaded" —
		// and a dev with an arm and no ball has an answer to that with no ball on screen.
		const abilityRow = this.addRow(scope, theme, "Ability", ballText);
		abilityRow.LayoutOrder = 3;

		const container = Card(scope, {
			children: [streakRow, chargeRow, abilityRow],
			padding: theme.spacing.sm,
			childGap: ROW_SPACING,
		});

		// `Card` has no opinion about where it sits, so the pin and the sizing go on what it returns.
		// Anchored bottom-left like the cooldown readout, and lifted clear of it — see
		// {@link BOTTOM_OFFSET}.
		container.AnchorPoint = new Vector2(0, 1);
		container.Position = new UDim2(0, EDGE_PADDING, 1, -BOTTOM_OFFSET);
		container.Size = UDim2.fromOffset(0, 0);
		container.AutomaticSize = Enum.AutomaticSize.XY;
		// `Card` calls everything it makes "Card", which is no help once two HUDs are up.
		container.Name = "SuperHud";

		addViewportConstraint(scope, container);

		// The one connection in this file. See the class doc for why this is a read rather than a
		// subscription to either attribute or to the ball.
		scope.push(
			RunService.RenderStepped.Connect(() => {
				const streak = player.GetAttribute(SUPER_STREAK_ATTRIBUTE);
				const charged = player.GetAttribute(SUPER_CHARGE_ATTRIBUTE);

				// A non-number is a player whose streak has never been published, which reads as none.
				streakText.set(
					`${typeIs(streak, "number") ? streak : 0}/${SUPER_CONFIG.STREAK_REQUIRED}`,
				);
				chargeText.set(charged === true ? "READY" : NOTHING);

				// Found by name rather than asked of `BallService`, because the client cannot ask it:
				// the ball in somebody's hand is a direct child of that body named `BALL_NAME`, which is
				// the same thing `ThrowController` looks for when it decides a click is a throw.
				const held = player.Character?.FindFirstChild(BALL_NAME);
				const ability = abilityOn(held);

				// **Falls back to the arm, which is the dev shortcut's visible half.** An armed player has no
				// ball yet, so without reading the player's own attribute there would be nothing on screen to
				// say an ability is loaded — and the arm is exactly the state a dev needs to see, because it is
				// the one state with no ball to look at. Suffixed with a word rather than shown plainly, so an
				// arm that no ball has taken up yet cannot be read as a loaded ball.
				const arm = player.GetAttribute(ARMED_ABILITY_ATTRIBUTE);
				const armed = typeIs(arm, "string") && isAbilityKind(arm) ? arm : undefined;

				if (ability !== undefined) {
					ballText.set(ABILITY_NAMES[ability]);
				} else if (armed !== undefined) {
					ballText.set(`${ABILITY_NAMES[armed]} (armed)`);
				} else {
					ballText.set(NOTHING);
				}
			}),
		);

		container.Parent = getHudScreenGui();

		if (DEBUG) {
			print(
				`[HUD] super strip up — ${SUPER_STREAK_ATTRIBUTE} / ${SUPER_CHARGE_ATTRIBUTE} on the player, ` +
					`${BALL_NAME}'s ability on the held ball`,
			);
		}
	}

	/**
	 * One labelled row: the fact's name on the left, its value on the right.
	 *
	 * Two `Text`s in a `Frame` with a horizontal layout, which is the legend's row shape rather than the
	 * cooldown card's bar — this readout has no length to draw, so there is nothing for a trough and a
	 * fill to say that a word does not.
	 *
	 * The value is reactive and the label is not, so the label is built plainly and only the value goes
	 * through `Hydrate`. The theme arrives as a parameter so that a HUD reads its colours exactly once
	 * and this method cannot disagree with the rest of the file about them.
	 */
	private addRow(
		scope: Fusion.Scope<unknown>,
		theme: HudTheme,
		name: string,
		value: Fusion.Value<string>,
	): Frame {
		const row = Fusion.New(scope, "Frame")({
			Name: `${name}Row`,
			Size: UDim2.fromOffset(0, 0),
			AutomaticSize: Enum.AutomaticSize.XY,
			BackgroundTransparency: 1,
		});

		// The row's layout owns its children's positions, so the order they are *created* in is not the
		// order they appear in — `LayoutOrder` is, which is why both are numbered. The default sort is
		// by name, and "Value" would sort above "Label".
		const layout = new Instance("UIListLayout");
		layout.FillDirection = Enum.FillDirection.Horizontal;
		layout.SortOrder = Enum.SortOrder.LayoutOrder;
		layout.Padding = new UDim(0, LABEL_GAP);
		layout.Parent = row;

		const label = Text(scope, { text: name, variant: "body1" });
		label.LayoutOrder = 1;
		label.Parent = row;

		const readout = Text(scope, { text: NOTHING, variant: "body1" });
		readout.LayoutOrder = 2;
		readout.Parent = row;

		// Wrapping off and the size taken from the text, for the legend's reason: a row's width has to
		// come from its own text, and big-ui's default is a label the full width of its parent sized to
		// wrap inside it — a parent sized to the label and a label sized to the parent is a circle.
		label.Size = UDim2.fromOffset(0, 0);
		label.AutomaticSize = Enum.AutomaticSize.XY;
		label.TextColor3 = theme.colors.textSecondary;

		readout.Size = UDim2.fromOffset(0, 0);
		readout.AutomaticSize = Enum.AutomaticSize.XY;
		readout.TextColor3 = theme.colors.textPrimary;

		// The value colour is the one thing here that is derived rather than fixed: a charge in hand is
		// the accent, and nothing held is the muted tone. Written through `Hydrate` so it follows the
		// value rather than being set once at construction and going stale.
		Fusion.Hydrate(scope, readout)({
			TextColor3: Fusion.Computed(scope, (use) =>
				use(value) === NOTHING ? theme.colors.textDisabled : theme.colors.textPrimary,
			),
		});

		Fusion.Hydrate(scope, readout)({ Text: value });

		return row;
	}
}
