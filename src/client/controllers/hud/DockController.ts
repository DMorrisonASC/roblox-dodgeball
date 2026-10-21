import { Controller, OnStart } from "@flamework/core";
import { Button } from "@rbxts/big-ui";
import Fusion from "@rbxts/fusion-3.0";
import { Players, ReplicatedStorage } from "@rbxts/services";
import {
	IN_ROUND_ATTRIBUTE,
	PRACTICE_ZONE_ATTRIBUTE,
	ROUND_STATE_ATTRIBUTE,
	ROUND_STATUS_FOLDER,
	TEAM_ATTRIBUTE,
} from "shared/constants";
import { inPracticeZone, participating, roundPhase, togglePanel } from "../../panels";
import { isParticipant } from "../../roundZone";
import { addElevation, wireInteraction } from "../../ui/elevation";
import { hudTheme } from "../../ui/hudTheme";
import { getHudScreenGui } from "../../ui/screenGui";
import { addViewportConstraint } from "../../ui/viewportConstraint";

/** Prints once, with the phase the dock is reading — the line that says it mounted and what it saw. */
const DEBUG = false; // off for frame time — see shared/config/debug.config.ts

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
 * The docks: the Shop and Inventory buttons, stacked at the bottom centre.
 *
 * **It exists whenever this player is not in a round, and that is the whole of its definition.** The
 * panels behind it are things a player does *instead of* playing — reading a catalogue, looking at what
 * they own — so the dock goes away for as long as a round is theirs. **Whose round it is, rather than
 * whether one is on**, which is a correction: gating on the phase meant that a round somebody else had
 * started took the shop away from a player who had opted into nothing and whose body was standing in the
 * lobby. That is reported as a bug and it was one — see `participating`, which is the fact this file
 * publishes for itself and for the two panels.
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
 * **A player who joins mid-round gets the dock, and that is the other half of the correction.** The
 * phase reads `"Playing"` when they arrive, which used to mean no dock until the round ended — so a
 * joiner had nothing to do *and* nowhere to spend the wait. They are not on a side when they arrive, so
 * they are a spectator like any other and the dock is theirs; the moment they tap a pad and
 * `RoundService` admits them, `TEAM_ATTRIBUTE` changes, `participating` follows, and the dock goes. The
 * attribute is subscribed *and* seeded, so both of those happen on the write rather than on the next
 * boundary.
 *
 * **`roundPhase` and `participating` in `client/panels.ts` are written here and nowhere else.** The dock
 * owns the connections because the dock is the thing the round defines — a round takes this away and a
 * zone takes it away — so the facts that watch the round live with the only element that is entirely
 * about them; the panels and the session HUDs read them rather than each holding a connection to the
 * same attributes. See that module for why the state lives in neither controller.
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

		this.watchRound();
		this.addDock();

		if (DEBUG) {
			print(
				`[Dock] up — Shop and Inventory, shown while this player is not in a round` +
					` (phase ${Fusion.peek(roundPhase)}, in the round ${Fusion.peek(participating)})`,
			);
		}
	}

	/**
	 * Keeps `roundPhase` and `participating` in step with the server's own attributes.
	 *
	 * **Two facts and two connections, because the dock's visibility needs both.** The phase says whether
	 * a round is on; the local player's `TEAM_ATTRIBUTE` says whether it is *theirs*. Both are published,
	 * both are subscribed to here rather than by each reader, and {@link publishParticipation} is the one
	 * place they are combined — so a change to either re-derives the answer the same way.
	 *
	 * Subscribed *before* seeding, which is the order `RoundStatusController` uses and for its reason:
	 * a change landing between the two is not lost, because the seed then reads the newer value and
	 * wins. The seed matters here more than usual — a client that mounted mid-round would otherwise sit
	 * on the module's own permissive defaults and show a dock during a round until the next boundary.
	 */
	private watchRound(): void {
		const status = ReplicatedStorage.WaitForChild(ROUND_STATUS_FOLDER);
		const player = Players.LocalPlayer;

		this.scope.push(
			status.GetAttributeChangedSignal(ROUND_STATE_ATTRIBUTE).Connect(() => {
				const value = status.GetAttribute(ROUND_STATE_ATTRIBUTE);
				if (typeIs(value, "string")) roundPhase.set(value);

				this.publishParticipation();
			}),
		);

		// **The player's own side, and the reason the dock needs a second subscription at all.** A round
		// running is not the same fact as this player being in it: the roster writes this attribute at
		// every whistle and clears it for everybody who did not re-opt in, and `setTeam` writes it the
		// moment a mid-round joiner is admitted — so this is the connection that gives a spectator their
		// shop back while a round they are not in is being played.
		this.scope.push(
			player.GetAttributeChangedSignal(TEAM_ATTRIBUTE).Connect(() => this.publishParticipation()),
		);

		// **And membership, because a side is not the same fact and the dock is what a player leaves a round to
		// reach.** A surrendered player keeps `TEAM_ATTRIBUTE` on purpose, so this dock stayed hidden for them
		// while they stood in the lobby with nothing to do — the same fault the shift lock had, from the other
		// side: the camera stayed on and the shop stayed off. `IN_ROUND_ATTRIBUTE` is written where the round
		// admits somebody and cleared in `eliminate`, so one subscription answers both directions of a round
		// somebody leaves or rejoins mid-flight. See `publishParticipation`, and `roundZone.isParticipant` for the
		// rule itself.
		this.scope.push(
			player.GetAttributeChangedSignal(IN_ROUND_ATTRIBUTE).Connect(() => this.publishParticipation()),
		);

		const initial = status.GetAttribute(ROUND_STATE_ATTRIBUTE);
		if (typeIs(initial, "string")) roundPhase.set(initial);

		this.publishParticipation();
	}

	/**
	 * Publishes whether **this player is in the round being played**, which is `roundZone.isParticipant`'s
	 * rule read as a value a HUD can watch.
	 *
	 * **The rule is not restated here.** `isParticipant` is the one place "the round has this player, and a round
	 * is on" is written — it is what the shift lock works its camera from — and calling it means the dock cannot
	 * come to a different answer about a player the camera is already holding, or let go of one the camera has
	 * already released.
	 *
	 * **Read fresh rather than combined from the two subscribers**, because both of them can fire for a
	 * change the other one has not seen yet and the function re-reads both attributes anyway.
	 */
	private publishParticipation(): void {
		participating.set(isParticipant(Players.LocalPlayer));
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
		 * **The value is `panels.ts`'s and this controller writes it.** It was a local here while the dock
		 * was the only element that cared; the session HUDs now appear in the same place the dock
		 * disappears, so a local would be one subscription per reader for one fact. The dock keeps the
		 * connection because it had it first and because it is the element a zone *removes* — the same
		 * one-writer arrangement `roundPhase` has with the panels.
		 *
		 * Seeded from the opening read, because a client that mounts while its player is already standing
		 * in a zone will never hear a change to an attribute that was already true.
		 */
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
			// `Computed`'s dependencies are the `use` calls that actually *ran*, so `!use(participating) &&
			// !use(inPracticeZone)` written as one expression would drop the zone dependency on every frame
			// the player is in a round — and the dock would then be watching the zone only at the moments it
			// is already hidden, which is the one time it does not matter. Hoisted, both sources are
			// registered on every run.
			//
			// **The question is about this player, not about the phase** — see `participating`. A round that
			// somebody else is playing used to hide this dock, which is how a player who had opted into
			// nothing lost the shop for the length of a round.
			Visible: Fusion.Computed(this.scope, (use) => {
				const inRound = use(participating);
				const inZone = use(inPracticeZone);

				return !inRound && !inZone;
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

		// **The shared HUD GUI, and it used to be `getFullScreenGui`.** That call looked up the *same* name as
		// the HUD's GUI and so returned this very `ScreenGui` while writing `ScreenInsets.None` onto it — which
		// is why the import of both was here and why the whole HUD's region depended on which controller ran
		// last. `getFullScreenGui` is a GUI of its own now (and holds the round's readout column), so this line
		// has to name the GUI the dock actually wants: a HUD panel anchored to the *bottom* edge, where the safe
		// region is the thing a phone's home indicator lives outside of. `DOCK_BOTTOM_INSET` is measured from
		// that edge, on both devices, which is what it always meant.
		dock.Parent = getHudScreenGui();
	}

	/**
	 * One dock button.
	 *
	 * **`AutomaticSize.X` is big-ui's own default here and is deliberately kept**, so a longer label
	 * than expected grows its own button rather than being clipped; the `UISizeConstraint` is what makes
	 * the two buttons the same width regardless, which is the part that matters for a stack. Setting an
	 * explicit `Size` would have to be undone per button and would fix a width the label does not know.
	 *
	 * **And it is raised, which is this file's half of the elevation hierarchy.** A button with no shadow
	 * reads as a label; Material rests a contained button at roughly 6dp and drops it to nothing on press,
	 * and that is the right answer here for a concrete reason — the dock's two buttons are the only things
	 * on screen during an intermission that want pressing, so they are exactly where the affordance has to
	 * be visible before the mouse moves. See `ui/elevation.ts` for the level and for the press it wires.
	 *
	 * **`hudTheme()` is called here rather than threaded in from `addDock`**, which is a deliberate
	 * exception to the "a HUD reads its colours exactly once" convention this codebase otherwise keeps.
	 * That convention is about *capture* — a value read at module load would be Material's default rather
	 * than the configured theme — and `hudTheme()` reads the live palette on every call, so a second call
	 * cannot disagree with the first. Threading it would mean a fourth parameter on a method called twice,
	 * to buy nothing.
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

		// **`behindParent` off for the outlined variant, and it is not a preference.** big-ui builds an
		// `outlined` button with `BackgroundTransparency = 1` at rest — it is an outline and nothing else —
		// so a shadow allowed behind its parent would draw its whole dark silhouette *through* the button,
		// reading as a grey rectangle rather than as depth. With the flag off, the shadow is drawn only
		// outside the parent's own area: a fringe beneath an outline, which is the right amount of ink for
		// a surface that is mostly hole, and the second of the two treatments this hierarchy needs.
		const shadow = addElevation(this.scope, button, hudTheme(), "BUTTON", variant === "contained");

		// **The button is its own visual here**, unlike a shelf tile: big-ui builds the thing that is drawn and
		// the thing that is clicked as one instance, so there is nothing to point the scale at but the button
		// itself. The option exists for the case where those two are different — see `InteractionOptions.visual`.
		wireInteraction(this.scope, button, { shadow });

		button.Parent = dock;
	}
}
