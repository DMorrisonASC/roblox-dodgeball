import { Controller, OnStart } from "@flamework/core";
import { Button } from "@rbxts/big-ui";
import Fusion from "@rbxts/fusion-3.0";
import { Players, ReplicatedStorage } from "@rbxts/services";
import { PRACTICE_ZONE_ATTRIBUTE, ROUND_STATE_ATTRIBUTE, ROUND_STATUS_FOLDER } from "shared/constants";
import { INTERMISSION, roundPhase, togglePanel } from "../../panels";
import { hudTheme } from "../../ui/hudTheme";
import { getHudScreenGui } from "../../ui/screenGui";
import { addViewportConstraint } from "../../ui/viewportConstraint";

/** Prints once, with the phase the dock is reading — the line that says it mounted and what it saw. */
const DEBUG = true;

/**
 * The dock's ZIndex.
 *
 * **Explicitly below the panels' `PANEL_Z_INDEX` (10) and above every toast and HUD label (1).** A
 * dock is furniture: it is under anything a player opened deliberately, and over the messages the game
 * puts on the screen by itself. The gap is what makes "opening a panel covers nothing the player was
 * looking at, except the dock" true without either number being derived from the other.
 */
const DOCK_Z_INDEX = 5;

/** How far the dock sits above the bottom of the screen, in pixels. */
const DOCK_BOTTOM_INSET = 12;

/** Both buttons are at least this wide, so two labels of different lengths still line up. */
const BUTTON_MIN_WIDTH = 150;

/**
 * The widest the dock may be, in pixels — the ultrawide cap — and vertically a fraction, because the
 * dock's height is what has an opinion about the screen. See `addViewportConstraint` for the pair.
 */
const DOCK_MAX_WIDTH = 320;

/** The gap between the two buttons, in pixels. */
const DOCK_GAP = 8;

/**
 * The intermission dock: the Shop and Inventory buttons, stacked at the bottom centre.
 *
 * **It exists only between rounds, and that is the whole of its definition.** The panels behind it are
 * things a player does *instead of* playing — reading a catalogue, looking at what they own — and the
 * moment a round starts they are in the way of the game. Gating the dock on the phase is therefore one
 * rule rather than two: the buttons go away, and (see the panels) anything they opened goes with them.
 *
 * **It is also hidden inside a practice zone, and that is a second rule rather than a refinement of the
 * first.** A practice zone is for practising — throwing, dodging, catching — and a shop is the opposite
 * of that: a player who is fiddling with a catalogue is not practising, and a player who opens one from
 * inside a zone has to leave the zone to use what they bought. The zone is a place the game has already
 * decided the *round's* rules do not apply in, and the dock is the one piece of the intermission the
 * zone takes away instead of granting.
 *
 * **The whole dock hides, not the two buttons**, which is the same statement today: the frame's
 * `Visible` is the only visibility any of it has, and the two buttons are all it holds. Written down
 * because a third button is expected — see below — and the answer has to be chosen before there is one
 * to choose about.
 *
 * **A player who joins mid-round sees no dock until the round ends**, which is correct and is worth
 * stating because it is the case that looks like a bug from the inside: `ROUND_STATE_ATTRIBUTE` reads
 * `"Playing"` when they arrive, so there is nothing to show until the server publishes `Intermission`
 * — and the attribute is subscribed *and* seeded, so the dock appears on that write rather than on the
 * next round. Nothing else is needed for the joiner: the phase is published to the whole server.
 *
 * **`roundPhase` in `client/panels.ts` is written here and nowhere else.** The dock owns the
 * connection because the dock is the thing the phase defines, so the fact that watches the phase
 * lives with the only reason to watch it; the panels read it rather than each holding a connection to
 * the same attribute. See that module for why the state lives in neither controller.
 *
 * **The frame is a `UIListLayout`, not two placed buttons.** A third button — an in-game dock with
 * cooldowns is the obvious next one — is one more child and no layout work at all, because the frame
 * sizes itself to what it holds on both axes. That is the reason for `AutomaticSize` here rather than
 * any opinion about how tall a dock should be.
 */
@Controller()
export class DockController implements OnStart {
	private scope = Fusion.scoped();
	private mounted = false;

	onStart(): void {
		// Spawned rather than done inline, matching every other HUD: mounting waits for `PlayerGui`
		// and for the round-status folder, and a controller's `onStart` is the wrong place to hold up
		// the rest of the client's boot.
		task.spawn(() => this.mount());
	}

	private mount(): void {
		if (this.mounted) return;
		this.mounted = true;

		this.watchPhase();
		this.addDock();

		if (DEBUG) {
			print(
				`[Dock] up — Shop and Inventory, shown while the phase is ${INTERMISSION}` +
					` (${Fusion.peek(roundPhase)} right now)`,
			);
		}
	}

	/**
	 * Keeps `roundPhase` in step with the server's own attribute.
	 *
	 * Subscribed *before* seeding, which is the order `RoundStatusController` uses and for its reason:
	 * a change landing between the two is not lost, because the seed then reads the newer value and
	 * wins. The seed matters here more than usual — a client that mounted mid-round would otherwise sit
	 * on the module's own `Intermission` default and show a dock during a round until the next boundary.
	 */
	private watchPhase(): void {
		const status = ReplicatedStorage.WaitForChild(ROUND_STATUS_FOLDER);

		this.scope.push(
			status.GetAttributeChangedSignal(ROUND_STATE_ATTRIBUTE).Connect(() => {
				const value = status.GetAttribute(ROUND_STATE_ATTRIBUTE);
				if (typeIs(value, "string")) roundPhase.set(value);
			}),
		);

		const initial = status.GetAttribute(ROUND_STATE_ATTRIBUTE);
		if (typeIs(initial, "string")) roundPhase.set(initial);
	}

	private addDock(): void {
		const theme = hudTheme();

		/**
		 * **Whether the local player is standing in a practice zone — the tracker's fact, watched.**
		 *
		 * Read from the attribute `PracticeZoneService` publishes rather than from the client's own
		 * `roundZone.ts` check, and the difference matters: a `Computed` re-runs whenever its sources
		 * move, so a zone test *inside* one would be a `GetPartBoundsInBox` walk on every re-render of
		 * something that has nothing to do with the zone. The attribute is a plain replicated fact, so
		 * watching it costs a subscription and nothing per frame — and it is the *server's* answer, which
		 * is the one that decides whether the player is really in there.
		 *
		 * Seeded from the opening read, because a client that mounts while its player is already standing
		 * in a zone will never hear a change to an attribute that was already true.
		 */
		const inPracticeZone = Fusion.Value(this.scope, false);

		const player = Players.LocalPlayer;

		this.scope.push(
			player.GetAttributeChangedSignal(PRACTICE_ZONE_ATTRIBUTE).Connect(() => {
				inPracticeZone.set(player.GetAttribute(PRACTICE_ZONE_ATTRIBUTE) === true);
			}),
		);

		inPracticeZone.set(player.GetAttribute(PRACTICE_ZONE_ATTRIBUTE) === true);

		const dock = Fusion.New(this.scope, "Frame")({
			Name: "Dock",
			// No size of its own: `UIListLayout` plus `AutomaticSize` is what makes the frame exactly
			// as tall and as wide as the buttons it holds, so a third button costs nothing.
			Size: new UDim2(0, 0, 0, 0),
			AutomaticSize: Enum.AutomaticSize.XY,
			AnchorPoint: new Vector2(0.5, 1),
			Position: new UDim2(0.5, 0, 1, -DOCK_BOTTOM_INSET),
			BackgroundTransparency: 1,
			ZIndex: DOCK_Z_INDEX,
			// **Both `use` calls hoisted above the test, and that is load-bearing rather than style.** A
			// `Computed`'s dependencies are the `use` calls that actually *ran*, so `use(roundPhase) ===
			// INTERMISSION && !use(inPracticeZone)` written as one expression would drop the zone
			// dependency on every frame the phase is not `Intermission` — and the dock would then be
			// watching the zone only at the moments it is already hidden, which is the one time it does
			// not matter. Hoisted, both sources are registered on every run.
			Visible: Fusion.Computed(this.scope, (use) => {
				const phase = use(roundPhase);
				const inZone = use(inPracticeZone);

				return phase === INTERMISSION && !inZone;
			}),
		});

		Fusion.New(this.scope, "UIListLayout")({
			Parent: dock,
			FillDirection: Enum.FillDirection.Horizontal,
			HorizontalAlignment: Enum.HorizontalAlignment.Center,
			SortOrder: Enum.SortOrder.LayoutOrder,
			Padding: new UDim(0, DOCK_GAP),
		});

		// The phone cap. `BUTTON_MIN_WIDTH` keeps the dock from collapsing to an unreadable sliver, and
		// the fraction keeps it from being wider than the screen it is on — a pixel maximum cannot do
		// that job, because the number that is safe is a different number on every device.
		addViewportConstraint(this.scope, dock, {
			min: new Vector2(BUTTON_MIN_WIDTH, 0),
			max: new Vector2(DOCK_MAX_WIDTH, math.huge),
		});

		// No descendant `ZIndex` walk here, unlike a panel: the dock's own background is transparent, so
		// there is nothing for a child to be painted *under* — the trap `raiseZIndex` exists for needs an
		// opaque container. The buttons are ordinary children at the default ZIndex, over a frame that
		// draws nothing.

		this.addDockButton(dock, "Shop", "primary", "contained", 1, () => togglePanel("shop"));
		this.addDockButton(dock, "Inventory", "secondary", "outlined", 2, () => togglePanel("inventory"));

		dock.Parent = getHudScreenGui(); // must stay the LAST statement in this method
	}

	/**
	 * One dock button.
	 *
	 * **`AutomaticSize.X` is big-ui's own default here and is deliberately kept**, so a longer label
	 * than expected grows its own button rather than being clipped; the `UISizeConstraint` is what makes
	 * the two buttons the same width regardless, which is the part that matters for a stack. Setting an
	 * explicit `Size` would have to be undone per button and would fix a width the label does not know.
	 */
	private addDockButton(
		dock: Frame,
		label: string,
		color: "primary" | "secondary",
		variant: "contained" | "outlined",
		order: number,
		onActivate: () => void,
	): void {
		const button = Button(this.scope, {
			label,
			variant,
			color,
			size: "medium",
			layoutOrder: order,
			onActivate,
		});
		button.Name = `${label}Button`;
		Fusion.New(this.scope, "UISizeConstraint")({
			Parent: button,
			MinSize: new Vector2(BUTTON_MIN_WIDTH, 0),
		});
		button.Parent = dock;
	}
}
