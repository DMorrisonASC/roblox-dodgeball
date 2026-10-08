import { Controller, OnStart } from "@flamework/core";
import Fusion from "@rbxts/fusion-3.0";
import { Players } from "@rbxts/services";
import { THROW_ENABLED } from "shared/constants";
import { mountToast } from "../../ui/hudToast";

/** Prints on mount — the line that says the controller ran at all. */
const DEBUG = true;

/** How long the *enabled* confirmation stays up, in seconds. The disabled alert never expires. */
const SUCCESS_SECONDS = 5;

/**
 * Which slot of the bottom-centre column this toast occupies, counted from the bottom.
 *
 * **Slot 0, and slot 1 is the mystery box's.** It used to be the camera toast's, and that controller is
 * gone — both of its toasts *were* the `~` release, which no longer exists — so the slot was free until
 * `MysteryToastController` took it. These two can be up at once — a player with throwing switched off is
 * free to collect a box — so they stack rather than share. See `ui/hudToast.ts`, which owns the width, the
 * gap from the screen edge and the height that stack is built from: those are facts about the column
 * rather than about this toast, and they used to live here.
 */
const SLOT = 0;

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
		mountToast(scope, {
			name: "ThrowDisabledToast",
			title: DISABLED_TITLE,
			message: DISABLED_BODY,
			severity: "warning",
			visible: Fusion.Computed(scope, (use) => !use(throwEnabled)),
			slot: SLOT,
		});

		mountToast(scope, {
			name: "ThrowEnabledToast",
			title: ENABLED_TITLE,
			message: ENABLED_BODY,
			severity: "success",
			visible: Fusion.Computed(scope, (use) => use(throwEnabled) && use(visible)),
			slot: SLOT,
		});

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
}
