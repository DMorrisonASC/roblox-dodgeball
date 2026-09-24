import { Controller, OnStart } from "@flamework/core";
import { Text } from "@rbxts/big-ui";
import Fusion from "@rbxts/fusion-3.0";
import { Players, RunService, Workspace } from "@rbxts/services";
import { ACTION_CONFIG } from "shared/config/action.config";
import { CATCH_CONFIG } from "shared/config/catch.config";
import { DODGE_CONFIG } from "shared/config/dodge.config";
import { CATCH_READY_AT, DODGE_READY_AT } from "shared/constants";
import { getHudScreenGui } from "../ui/screenGui";

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

/** The trough a fill sits in, and the only two colours the fill itself can be. */
const BAR_BACKGROUND = Color3.fromRGB(25, 25, 25);
const FILL_DEPLETED = Color3.fromRGB(70, 70, 70);
const FILL_READY = Color3.fromRGB(200, 200, 200);

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
 * The two cooldowns, bottom-left: a bar each for the dodge and the catch.
 *
 * **It reads nothing but the local player's attributes.** The server writes the instant each
 * action is next ready as `DodgeReadyAt` / `CatchReadyAt` on the *player* — not the character,
 * because a bar that reset on every death would be reading a cooldown that no longer exists — and
 * a per-frame subtraction turns each instant into a fraction. Nothing is sent and nothing is asked
 * for, so the readout cannot be more than a frame out of step with the rule it is showing.
 *
 * Both bars are one `Value` each and one connection. The fill's width and its colour are the only
 * things derived from those values, so a change to either config moves the bars without any of
 * this being touched.
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

		// `1` is full, and full is the state a player joins in — before either action has been
		// used there is nothing to count down, so there is no attribute to read yet.
		const dodgeProgress = Fusion.Value(scope, 1);
		const catchProgress = Fusion.Value(scope, 1);

		const container = Fusion.New(scope, "Frame")({
			Name: "CooldownHud",
			AnchorPoint: new Vector2(0, 1),
			Position: new UDim2(0, EDGE_PADDING, 1, -EDGE_PADDING),
			AutomaticSize: Enum.AutomaticSize.XY,
			BackgroundTransparency: 1,
		});

		// The container's layout owns the *rows*, which is what a layout is for. Nothing above the
		// container has one, and that matters: a layout over an object's ancestor decides where
		// that object goes and makes its own `Position` a lie, which is the one thing that would
		// stop this readout being pinned to the corner.
		const layout = new Instance("UIListLayout");
		layout.FillDirection = Enum.FillDirection.Vertical;
		layout.SortOrder = Enum.SortOrder.LayoutOrder;
		layout.Padding = new UDim(0, ROW_SPACING);
		layout.Parent = container;

		const dodgeRow = this.addRow(scope, "Dodge", dodgeProgress);
		dodgeRow.LayoutOrder = 1;
		dodgeRow.Parent = container;

		const catchRow = this.addRow(scope, "Catch", catchProgress);
		catchRow.LayoutOrder = 2;
		catchRow.Parent = container;

		// One connection for both bars, and the only thing here that runs per frame. The
		// alternatives are worse for the same reason: a subscription per attribute would leave the
		// fraction still until the server spoke again, so something would *still* have to tick to
		// move it in between, and then there would be two mechanisms for one movement.
		//
		// `RenderStepped` rather than a heartbeat, because the fill is a *reading* of a clock
		// rather than a state of the world: its only cost is how smoothly it is sampled.
		scope.push(
			RunService.RenderStepped.Connect(() => {
				const now = Workspace.GetServerTimeNow();

				dodgeProgress.set(progressOf(now, player.GetAttribute(DODGE_READY_AT), DODGE_BUSY_SECONDS));
				catchProgress.set(progressOf(now, player.GetAttribute(CATCH_READY_AT), CATCH_BUSY_SECONDS));
			}),
		);

		container.Parent = getHudScreenGui();

		if (DEBUG) print(`[HUD] cooldowns up — ${DODGE_READY_AT} / ${CATCH_READY_AT} on the player`);
	}

	/**
	 * One labelled bar: the ability's name, and a trough with a fill that follows `progress`.
	 *
	 * Hand-rolled from two frames rather than taken from big-ui's progress component, because the
	 * readout is not only a length: the colour is part of the answer — dark gray while the clock
	 * runs, light gray when it is ready — and a bar that changes colour is plainer to write than to
	 * configure.
	 */
	private addRow(scope: Fusion.Scope<unknown>, name: string, progress: Fusion.Value<number>): Frame {
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

		const label = Text(scope, { text: name, variant: "caption" });
		label.LayoutOrder = 1;
		label.Parent = row;

		const bar = Fusion.New(scope, "Frame")({
			Name: "Bar",
			Size: new UDim2(0, BAR_WIDTH, 0, BAR_HEIGHT),
			BackgroundColor3: BAR_BACKGROUND,
			LayoutOrder: 2,
		});

		const fill = Fusion.New(scope, "Frame")({
			Name: "Fill",
			// A whole `UDim2` rather than the `Size.X.Scale` inside one: Fusion holds a *property*,
			// and the scale on its own is not one — so the computed value is the size, one full unit
			// wide when the action is ready.
			Size: Fusion.Computed(scope, (use) => new UDim2(use(progress), 0, 1, 0)),
			// The colour is the second half of the same answer: still filling is dark, ready is
			// light, and the switch happens on the fraction rather than on the instant so the two
			// can never disagree about which side of ready we are on.
			BackgroundColor3: Fusion.Computed(scope, (use) => (use(progress) >= 1 ? FILL_READY : FILL_DEPLETED)),
		});

		addCorner(bar);
		addCorner(fill);

		fill.Parent = bar;
		bar.Parent = row;

		return row;
	}
}
