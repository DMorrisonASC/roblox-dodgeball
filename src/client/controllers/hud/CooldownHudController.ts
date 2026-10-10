import { Controller, OnStart } from "@flamework/core";
import { Card, Text } from "@rbxts/big-ui";
import Fusion from "@rbxts/fusion-3.0";
import { Players, RunService, Workspace } from "@rbxts/services";
import { ACTION_CONFIG } from "shared/config/action.config";
import { CATCH_CONFIG } from "shared/config/catch.config";
import { DODGE_CONFIG } from "shared/config/dodge.config";
import { CATCH_READY_AT, DODGE_READY_AT } from "shared/constants";
import { sessionHudVisible } from "../../panels";
import { HudTheme, hudTheme } from "../../ui/hudTheme";
import { getHudScreenGui } from "../../ui/screenGui";
import { addViewportConstraint } from "../../ui/viewportConstraint";

/** Prints once, when the bars are up — the line that says the controller ran at all. */
const DEBUG = true;

/** How far the whole readout sits from the bottom-left corner, and the gap between the two rows. */
const EDGE_PADDING = 12;
const ROW_SPACING = 4;

/** The gap between a row's own label and its bar. */
const LABEL_GAP = 2;

/** The bar: wide enough that a fraction of it reads, thin enough to stay a glance. */
const BAR_WIDTH = 120;
const BAR_HEIGHT = 8;
const BAR_CORNER_RADIUS = 4;

/**
 * How long each bar takes to fill, read from the same configs the server runs on.
 *
 * The dodge is one value; the catch is a *sum*, because the server's catch cycle is the window
 * plus the lockout that follows it. Both sides add the same two config values rather than sharing
 * a third number, so changing either config moves the rule and the readout together.
 *
 * The sum is only the *scale* the fraction is read against, not a promise about the wait: a dodge
 * publishes a shorter one, so the bar fills faster afterwards and still turns light at the exact
 * instant the wait ends, which is the only moment the bar is about.
 */
const DODGE_BUSY_SECONDS = DODGE_CONFIG.COOLDOWN;
const CATCH_BUSY_SECONDS = CATCH_CONFIG.WINDOW_SECONDS + ACTION_CONFIG.ACTION_LOCKOUT_SECONDS;

/**
 * How far along a cooldown a machine is, `0` for just used to `1` for ready, from a ready-at
 * instant.
 *
 * `1` for anything that is not a number, which is the state a player joins in: no attribute means
 * neither action has ever been used, and the honest reading of that is a full bar.
 *
 * Clamped rather than trusted. The instant was written on another machine, and one whose clock is
 * a moment behind would otherwise read a fraction below zero or above one — which a bar would
 * faithfully draw, hanging off its own trough.
 */
function progressOf(now: number, readyAt: unknown, duration: number): number {
	if (!typeIs(readyAt, "number")) return 1;

	const remaining = readyAt - now;
	if (remaining <= 0) return 1;

	return math.clamp(1 - remaining / duration, 0, 1);
}

/** Gives a frame the bars' rounding. `UICorner` has no other job in this readout. */
function addCorner(frame: Frame): void {
	const corner = new Instance("UICorner");
	corner.CornerRadius = new UDim(0, BAR_CORNER_RADIUS);
	corner.Parent = frame;
}

/**
 * The dodge and catch cooldowns, bottom-left: a bar each.
 *
 * **It reads nothing but the local player's attributes.** The server writes the instant each action
 * is next ready as `DodgeReadyAt` / `CatchReadyAt` on the *player* — not the character, because a bar
 * that reset on every death would be reading a cooldown that no longer exists — and a per-frame
 * subtraction turns each instant into a fraction. Nothing is sent and nothing is asked for, so the
 * readout cannot be more than a frame out of step with the rule it is showing.
 *
 * **The stamina bar used to be the third row here and is now a HUD of its own**, at the bottom centre
 * under the power icon. The extraction is not a tidy-up: a cooldown is a *deadline* that fills and a pool
 * is a *level* that drains, and the two readouts shared a card only because they were both bars. The
 * arithmetic went with it — `staminaOf` is in the file that now draws the pool — and this card lost
 * nothing but a row.
 *
 * **It is shown only while a player can act**, and that is the shared predicate in `panels.ts` rather
 * than a rule written here: in a round, or in a practice zone. The predicate being shared is the point —
 * the Super HUD and its stamina segments show and hide at exactly the same moments, and three copies of
 * the rule is how three elements come to disagree about when a player is playing.
 *
 * **It used to have a third term — "and never for a spectator" — and losing it is the one place this
 * readout changes.** A player who is out of the round but still inside one, which in Score Rush means the
 * length of the respawn delay, now sees this card over a body that is not there. See `sessionHudVisible`
 * for the whole argument, and for why re-adding the term would mean re-adding the state that was removed.
 *
 * That predicate is applied with `Hydrate` rather than in the `Card`'s own props, and it is forced rather
 * than stylistic: `Card` builds its frame and hands it back, so a reactive property *assigned* to the
 * result is never tracked as a property at all — it silently does nothing, which is the trap
 * `hudToast.ts` documents about graph values and props.
 *
 * **The one bar left is drawn the way all of them always were**, and the argument for that survives the
 * extraction because it was never about the pool. It was briefly drawn in the theme's `accent` so that a
 * pool could be told from a cooldown at rest — and `accent` is `Palette.primary.main`, the vivid blue at
 * the top of the palette, against the pale blue-green `success` resolves to. That bought
 * tellable-at-rest and paid for it with the readout's coherence: the bar became the only bright blue
 * thing on screen, so it read as belonging to a different HUD rather than as a different kind of bar. The
 * row's label already says which ability it is; the colour's job is to say how that ability is doing, and
 * that job is the same for a pool as for a cooldown — which is why the extracted segments carry the same
 * two tones as the two bars here.
 *
 * Each bar is one `Value` and one connection. The fill's width and its colour are the only things
 * derived from those values, so a change to any of the configs moves the bars without any of this
 * being touched.
 */
@Controller()
export class CooldownHudController implements OnStart {
	public onStart(): void {
		// Spawned rather than done inline: mounting waits for `PlayerGui`, and a controller's
		// `onStart` is the wrong place to hold up the rest of the client's boot.
		task.spawn(() => this.mount());
	}

	private mount(): void {
		const scope = Fusion.scoped();
		const player = Players.LocalPlayer;

		// The HUD's colours, read now rather than at module load: `configureTheme` has run by the
		// time anything mounts, and a value captured earlier would be Material's default.
		const theme = hudTheme();

		// `1` is full, and full is the state a player joins in — before either action has been
		// used there is nothing to count down, so there is no attribute to read yet.
		const dodgeProgress = Fusion.Value(scope, 1);
		const catchProgress = Fusion.Value(scope, 1);

		// The rows are built first, because `Card` takes its children at construction and parents
		// them itself — there is nothing to hand a `Parent` afterwards, and nothing above them to
		// own their placement.
		const dodgeRow = this.addRow(scope, theme, "Dodge", dodgeProgress);
		dodgeRow.LayoutOrder = 1;

		const catchRow = this.addRow(scope, theme, "Catch", catchProgress);
		catchRow.LayoutOrder = 2;

		const container = Card(scope, {
			children: [dodgeRow, catchRow],
			// The card's padding, and its own rather than a `UIPadding` beside it. The readout had
			// none before, so this is what pushes the bars in off the card's edge — the cost of the
			// panel, and cheaper than a second padding instance fighting the card's own.
			padding: theme.spacing.sm,
			childGap: ROW_SPACING,
		});

		// `Card` has no opinion about where it sits — it is a `Frame` with a background, a corner and
		// a layout, and that is all. So the pin to the bottom-left corner and the sizing to its
		// contents go on what it returns, the same way a `Text`'s default size is corrected where
		// big-ui's answer is not the wanted one. Nothing above it has a layout, which is what lets a
		// `Position` here mean something at all.
		container.AnchorPoint = new Vector2(0, 1);
		container.Position = new UDim2(0, EDGE_PADDING, 1, -EDGE_PADDING);
		container.Size = UDim2.fromOffset(0, 0);
		container.AutomaticSize = Enum.AutomaticSize.XY;
		// `Card` calls everything it makes "Card", which is no help in the Explorer once two HUDs are
		// up — so the container keeps the name it had.
		container.Name = "CooldownHud";

		// **Shown only while a player can act**, through the shared predicate rather than a rule of this
		// file's own: in a round, or in a practice zone. The "and never for a spectator" term this comment
		// used to carry is gone with the spectator state, and the class doc says what losing it costs.
		//
		// Assigned with `Hydrate` rather than in the card's own props, and that is forced rather than
		// stylistic: `Card` hands back a finished instance, so a reactive property *assigned* to the result
		// would never be tracked as one — see the class doc for the silent failure that produces.
		Fusion.Hydrate(scope, container)({ Visible: sessionHudVisible(scope) });

		// The readout's width is its content's — `BAR_WIDTH` and the labels — and it is pinned to the
		// bottom-*left*, so a viewport narrower than the bars would push it off the right edge. That
		// needs a screen under about 140px to happen, which is the point of applying the rule here
		// anyway: every HUD carries its own bound rather than each one having to justify one.
		addViewportConstraint(scope, container);

		// One connection for both bars, and the only thing here that runs per frame. The
		// alternatives are worse for the same reason: a subscription per attribute would leave the
		// fraction still until the server spoke again, so something would *still* have to tick to
		// move it in between, and then there would be two mechanisms for one movement.
		//
		// `RenderStepped` rather than a heartbeat, because the fill is a *reading* of a clock
		// rather than a state of the world: its only cost is how smoothly it is sampled. The stamina
		// segments in the Super HUD sample their pool the same way and for the same reason — a fraction
		// of a live clock is the one kind of readout that has to be drawn per frame, wherever it is
		// drawn, and two readouts that share the reason share the mechanism rather than each inventing
		// a rate.
		scope.push(
			RunService.RenderStepped.Connect(() => {
				const now = Workspace.GetServerTimeNow();

				dodgeProgress.set(progressOf(now, player.GetAttribute(DODGE_READY_AT), DODGE_BUSY_SECONDS));
				catchProgress.set(progressOf(now, player.GetAttribute(CATCH_READY_AT), CATCH_BUSY_SECONDS));
			}),
		);

		container.Parent = getHudScreenGui();

		if (DEBUG) {
			print(`[HUD] cooldowns up — ${DODGE_READY_AT} / ${CATCH_READY_AT} on the player`);
		}
	}

	/**
	 * One labelled bar: the ability's name, and a trough with a fill that follows `progress`.
	 *
	 * Hand-rolled from two frames rather than taken from big-ui's progress component, because the
	 * readout is not only a length: the colour is part of the answer — the warning tone while the
	 * clock runs, the success tone when it is ready — and a bar that changes colour is plainer to
	 * write than to configure.
	 *
	 * **Three bars, one colour rule.** This took a `fillColor` override for a while, for a stamina
	 * bar drawn in the theme's `accent`; it is gone, and the reason is in the fill below — a row
	 * that names its own colour is a row that has stopped being able to say how it is doing.
	 *
	 * The theme comes in as a parameter rather than being read here, so that a HUD reads its
	 * colours exactly once and this method cannot disagree with the rest of the file about them.
	 */
	private addRow(
		scope: Fusion.Scope<unknown>,
		theme: HudTheme,
		name: string,
		progress: Fusion.Value<number>,
	): Frame {
		const row = Fusion.New(scope, "Frame")({
			Name: `${name}Row`,
			Size: new UDim2(0, BAR_WIDTH, 0, 0),
			AutomaticSize: Enum.AutomaticSize.Y,
			BackgroundTransparency: 1,
		});

		// The row's layout owns its two children's positions, so the order they are *created* in is
		// not the order they appear in — `LayoutOrder` is, which is why both are numbered. The
		// default sort is by name, and "Bar" would sort above "Label".
		const layout = new Instance("UIListLayout");
		layout.FillDirection = Enum.FillDirection.Vertical;
		layout.SortOrder = Enum.SortOrder.LayoutOrder;
		layout.Padding = new UDim(0, LABEL_GAP);
		layout.Parent = row;

		const label = Text(scope, { text: name, variant: "body1" });
		label.LayoutOrder = 1;
		label.Parent = row;

		const bar = Fusion.New(scope, "Frame")({
			Name: "Bar",
			Size: new UDim2(0, BAR_WIDTH, 0, BAR_HEIGHT),
			BackgroundColor3: theme.colors.trough,
			LayoutOrder: 2,
		});

		const fill = Fusion.New(scope, "Frame")({
			Name: "Fill",
			// A whole `UDim2` rather than the `Size.X.Scale` inside one: Fusion holds a *property*,
			// and the scale on its own is not one — so the computed value is the size, one full unit
			// wide when the action is ready.
			Size: Fusion.Computed(scope, (use) => new UDim2(use(progress), 0, 1, 0)),
			// The colour is the second half of the same answer: still filling is the busy tone,
			// ready is the success tone, and the switch happens on the fraction rather than on the
			// instant so the two can never disagree about which side of ready we are on.
			//
			// **The stamina bar carries this rule too, and it used to not.** It was briefly drawn in
			// the theme's `accent` so that a pool could be told from a cooldown at rest — and
			// `accent` is `Palette.primary.main`, the vivid blue at the top of the palette, against
			// the pale blue-green `success` resolves to. That bought tellable-at-rest and paid for
			// it with the readout's coherence: the stamina bar became the only bright blue thing on
			// screen, so it read as belonging to a different HUD rather than as a different kind of
			// bar. The row's label already says which ability it is; the colour's job is to say how
			// that ability is doing, and that job is the same for a pool as for a cooldown.
			BackgroundColor3: Fusion.Computed(scope, (use) =>
				use(progress) >= 1 ? theme.colors.success : theme.colors.warning,
			),
		});

		addCorner(bar);
		addCorner(fill);

		fill.Parent = bar;
		bar.Parent = row;

		return row;
	}
}
