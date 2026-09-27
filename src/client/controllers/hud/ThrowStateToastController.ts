import { Controller, OnStart } from "@flamework/core";
import { Alert } from "@rbxts/big-ui";
import type { AlertSeverity } from "@rbxts/big-ui";
import Fusion from "@rbxts/fusion-3.0";
import { Players } from "@rbxts/services";
import { THROW_ENABLED } from "shared/constants";
import { getHudScreenGui } from "../../ui/screenGui";
import { addViewportConstraint } from "../../ui/viewportConstraint";

/** Prints on mount — the line that says the controller ran at all. */
const DEBUG = true;

/** How long the *enabled* confirmation stays up, in seconds. The disabled alert never expires. */
const SUCCESS_SECONDS = 5;

/**
 * How far the toast sits above the bottom of the screen.
 *
 * Measured against the two things already down there rather than guessed at. The spectator label
 * is anchored `(0.5, 1)` at a 12px inset and is about 21px tall, so it occupies y∈[687, 708] on a
 * 720px screen; the tallest this toast gets is one title line plus one message line plus the
 * alert's own padding, about 61px, so at this offset it occupies y∈[579, 640]. That is 47px of
 * clear air between them — needed, because the assumption that they cannot co-occur is **false**:
 * the spectator label shows while `Spectating` is true and this toast shows while `ThrowEnabled`
 * is false, and a player who is out of the round with throwing switched off is both at once.
 *
 * Sideways it is clear too: at 1280px the toast spans x∈[480, 800], while the cooldown bars are
 * pinned to the bottom-*left* (anchor `(0, 1)`, 12px in, ~144px wide) and reach nowhere near it.
 */
const BOTTOM_OFFSET = 10;

/** The toast's width. `Alert` is built at scale-1 width, so this is the width of its wrapper. */
const TOAST_WIDTH = 320;

const DISABLED_TITLE = "Throwing disabled";
const DISABLED_BODY = "Press 2 to enable";

const ENABLED_TITLE = "Throwing enabled";
const ENABLED_BODY = "Press 2 to disable";

/**
 * What the throw toggle currently says, as a toast in the bottom-centre of the screen.
 *
 * **Two states, so two pre-built alerts — not one alert rebuilt on every press.** big-ui's `Alert`
 * takes `title` and `message` as plain strings and reads them once, while it is being built
 * (`node_modules/@rbxts/big-ui/out/components/Alert.luau`: `Text = props.title`, and `severity`
 * picks the palette and the icon in the same pass). None of the three is a `Fusion.UsedAs`, so an
 * `Alert` cannot be told to change its mind later — its content *is* its construction. The two
 * things it can ever say are constants, so the honest reading of that API is to build each one
 * once and let a computed `Visible` decide which is on screen. Rebuilding instead would re-derive
 * two fixed strings on every keypress, and would have to destroy a live subtree to do it.
 *
 * The consequence to know about: there are two alert frames alive, and **exactly one of them is
 * ever visible**, because the two predicates below are mutually exclusive — the disabled one shows
 * on `!throwEnabled`, the confirmation on `throwEnabled && visible`. So "one toast" holds where it
 * is observable. See {@link visible} for why the second condition is needed at all.
 *
 * **It reads the attribute and never writes it.** The toggle is `ActionController`'s and the
 * server's; this file has no opinion about whether throwing should be on, only about saying so.
 */
@Controller()
export class ThrowStateToastController implements OnStart {
	public onStart(): void {
		// Spawned rather than done inline, matching the other HUDs: mounting waits for `PlayerGui`.
		task.spawn(() => this.mount());
	}

	private mount(): void {
		const scope = Fusion.scoped();
		const player = Players.LocalPlayer;

		/**
		 * The state `THROW_ENABLED` is in, mirrored.
		 *
		 * Seeded from the attribute rather than defaulted, because it can already be `false` before
		 * this runs — a player who left the last server with throwing off, or one a dev command has
		 * switched off — and the alert is supposed to be up on the first frame, not five seconds
		 * later at the next change. Absent means enabled, which is the same reading the server uses
		 * (`BallService` only refuses on an explicit `false`).
		 */
		const throwEnabled = Fusion.Value(scope, player.GetAttribute(THROW_ENABLED) !== false);

		/**
		 * Whether the *enabled* confirmation is on screen, which is not the same question as
		 * whether throwing is enabled — that is the whole reason it exists.
		 *
		 * Throwing is enabled indefinitely; the confirmation is not. After five seconds throwing is
		 * still enabled and this goes false, which is what hides the confirmation without anything
		 * having to know that the state did not change. It starts `false` so that joining with
		 * throwing already enabled shows nothing, rather than a confirmation for a toggle the
		 * player never pressed.
		 */
		const visible = Fusion.Value(scope, false);

		// Both alerts in place from the start, each gated on the state it describes. The disabled
		// one has no other condition: while throwing is off it is up, and nothing takes it down
		// except throwing coming back on. That is also what makes the off→on→off sequence safe —
		// this alert is not gated on `visible` at all, so no stale timer can reach it.
		this.mountToast(
			scope,
			"ThrowDisabledToast",
			DISABLED_TITLE,
			DISABLED_BODY,
			"warning",
			Fusion.Computed(scope, (use) => !use(throwEnabled)),
		);

		this.mountToast(
			scope,
			"ThrowEnabledToast",
			ENABLED_TITLE,
			ENABLED_BODY,
			"success",
			Fusion.Computed(scope, (use) => use(throwEnabled) && use(visible)),
		);

		/**
		 * Bumped by every toggle, and captured by every dismissal timer.
		 *
		 * A `task.delay` already in flight cannot be cancelled, only *ignored*, so this is what
		 * "cancel the pending timer" means here: a timer only acts if the token it captured is
		 * still current. Without it, off → on → off → on inside five seconds would have the *first*
		 * confirmation's timer hide the *third* state's confirmation early — hiding a toast that
		 * was put up afterwards, on a clock that started before it existed.
		 */
		let dismissToken = 0;

		scope.push(
			player.GetAttributeChangedSignal(THROW_ENABLED).Connect(() => {
				const enabled = player.GetAttribute(THROW_ENABLED) !== false;
				throwEnabled.set(enabled);

				// Every toggle invalidates whatever timer was pending, whichever way it went —
				// switching *off* is the case the guard is for, since that is the transition that
				// would otherwise leave a running clock pointed at a toast that is no longer up.
				dismissToken += 1;

				if (!enabled) {
					// The warning is already visible as a consequence of `throwEnabled`; this only
					// clears the confirmation's own flag, so a later enable starts from a clean
					// state rather than inheriting the previous one's.
					visible.set(false);
					return;
				}

				visible.set(true);

				const token = dismissToken;
				task.delay(SUCCESS_SECONDS, () => {
					if (token !== dismissToken) return;
					visible.set(false);
				});
			}),
		);

		if (DEBUG) {
			print(`[Toast] mounted — ${THROW_ENABLED} = ${player.GetAttribute(THROW_ENABLED)}`);
		}
	}

	/**
	 * One toast: a fixed-width wrapper holding an `Alert`, both children of the shared `ScreenGui`.
	 *
	 * The wrapper is not decoration. `Alert` builds its root at `Size = UDim2.new(1, 0, 0, 0)` — a
	 * full-width frame, on the assumption it is being put inside something that knows how wide it
	 * should be — so without a parent of a fixed width there is nothing for that `1` to be a
	 * fraction *of*, and the alert would span the screen. The wrapper is that width, and it is also
	 * what carries the placement, so the alert is left alone to be an alert.
	 *
	 * `Visible` is passed in rather than assigned afterwards, because a graph object has to be part
	 * of the props a `New` is given to be tracked as a property — assigning one onto an instance
	 * that already exists is the shape that silently does nothing.
	 */
	private mountToast(
		scope: Fusion.Scope<unknown>,
		name: string,
		title: string,
		message: string,
		severity: AlertSeverity,
		visible: Fusion.UsedAs<boolean>,
	): void {
		const wrapper = Fusion.New(scope, "Frame")({
			Name: name,
			Size: new UDim2(0, TOAST_WIDTH, 0, 0),
			AutomaticSize: Enum.AutomaticSize.Y,
			Position: new UDim2(0.5, 0, 1, -BOTTOM_OFFSET),
			AnchorPoint: new Vector2(0.5, 1),
			BackgroundTransparency: 1,
			Visible: visible,
		});

		// The wrapper is already the toast's fixed width; this is the bound that stops that width
		// from exceeding the screen. It matters most here, because `TOAST_WIDTH` is the one number in
		// the HUD that has to be fixed: the `Alert` inside is built at scale-1 width and needs a
		// parent that knows how wide it is (see above), so the width cannot be made proportional and
		// a cap is the only way to let it adapt.
		addViewportConstraint(scope, wrapper);

		const alert = Alert(scope, { severity, title, message });
		// `Alert` names its root "Alert", and two of those in the Explorer say nothing about which
		// is which — the same reason the containers elsewhere are renamed off their component name.
		alert.Name = `${name}Body`;
		alert.Parent = wrapper;

		// The shared GUI, never a second one: the settings that belong to the screen rather than to
		// any one HUD — `ResetOnSpawn` above all — are decided in one place, and this toast
		// inherits them. Nothing here has to know that respawning happens, and nothing here is
		// per-character, so it survives a respawn by never having been attached to one.
		wrapper.Parent = getHudScreenGui();
	}
}
