import { Controller, OnStart } from "@flamework/core";
import Fusion from "@rbxts/fusion-3.0";
import { freeLook } from "../../freeLook";
import { mountToast } from "../../ui/hudToast";

/** Prints on mount — the line that says the controller ran at all. */
const DEBUG = true;

/**
 * How long either confirmation stays up, in seconds.
 *
 * **Both of this toast's states expire, which is not true of the throw toast's.** That one keeps a
 * standing warning in one of its two — throwing disabled is on screen for as long as it is disabled —
 * and this one has nothing to stand there: the player did this to themselves, the camera is visibly
 * different, and a line about it is news rather than a status.
 */
const SHOWN_SECONDS = 4;

const UNLOCKED_TITLE = "Camera unlocked";
const UNLOCKED_BODY = "Press ~ to lock it";

const LOCKED_TITLE = "Camera locked";
const LOCKED_BODY = "Press ~ to unlock it";

/**
 * Which slot of the bottom-centre column this toast occupies, counted from the bottom.
 *
 * **Slot 1, above the throw toast, because the two can be up at once.** A player with throwing switched
 * off has that warning on screen for as long as it lasts, and is free to press `~` while it is there —
 * so this takes the slot above rather than sharing one. See `ui/hudToast.ts` for the geometry of the
 * column, and `ThrowStateToastController` for the toast below.
 */
const SLOT = 1;

/**
 * What the player's own camera release just did, as a toast in the bottom-centre of the screen.
 *
 * **Told by a publication rather than by the camera.** `ShiftLock` owns the release and writes
 * `freeLook` whenever it changes — for a press, and for a round taking it back at its start — and this
 * file reads that and says what happened. Nothing here asks the camera anything, and nothing here can
 * change its mind about the camera: the same split `ThrowStateToastController` has with the server's
 * attribute, and the same reason `aiming.ts` gives for putting a shared fact in a module rather than on
 * a wire between two controllers.
 *
 * **Two states, so two pre-built alerts — not one alert rebuilt on every press.** big-ui's `Alert`
 * takes `title` and `message` as plain strings and reads them once, while it is being built, so an
 * `Alert` cannot be told to change its mind later: its content *is* its construction. The two things
 * this can ever say are constants, so each is built once and a computed `Visible` decides which is on
 * screen — the same shape, and the same constraint, as the throw toast. The consequence to know about
 * is the same one too: two alert frames are alive at all times, and exactly one of them is ever
 * visible, because the two predicates below are mutually exclusive.
 */
@Controller()
export class CameraToastController implements OnStart {
	public onStart(): void {
		// Spawned rather than done inline, matching the other HUDs: mounting waits for `PlayerGui`.
		task.spawn(() => this.mount());
	}

	private mount(): void {
		const scope = Fusion.scoped();

		/**
		 * The state `freeLook` is in, mirrored, so the two alerts can be gated on it.
		 *
		 * Seeded from the publication rather than defaulted, for the reason the throw toast seeds from
		 * its attribute: it can already be `true` by the time this runs — the camera controller mounts
		 * on its own schedule and the player may have pressed `~` before this one finished waiting for
		 * `PlayerGui` — and a toast that guessed instead would be describing the opposite of what the
		 * camera is doing.
		 */
		const released = Fusion.Value(scope, Fusion.peek(freeLook));

		/**
		 * Whether a confirmation is on screen right now, which is not the same question as whether the
		 * camera is released — that is the whole reason it exists. It is what makes both alerts appear
		 * on a *change* and fade on their own clock, and it starts `false` so that mounting shows
		 * nothing rather than a confirmation for something the player never did.
		 */
		const shown = Fusion.Value(scope, false);

		mountToast(scope, {
			name: "CameraUnlockedToast",
			title: UNLOCKED_TITLE,
			message: UNLOCKED_BODY,
			severity: "info",
			visible: Fusion.Computed(scope, (use) => use(released) && use(shown)),
			slot: SLOT,
		});

		mountToast(scope, {
			name: "CameraLockedToast",
			title: LOCKED_TITLE,
			message: LOCKED_BODY,
			severity: "success",
			visible: Fusion.Computed(scope, (use) => !use(released) && use(shown)),
			slot: SLOT,
		});

		/**
		 * Bumped by every change, and captured by every dismissal timer.
		 *
		 * A `task.delay` already in flight cannot be cancelled, only *ignored* — the throw toast's
		 * device, and it matters at least as much here: `~` twice inside four seconds would otherwise
		 * have the first confirmation's timer hide the second one early, on a clock that started before
		 * the second change existed.
		 */
		let dismissToken = 0;

		scope.push(
			Fusion.Observer(scope, freeLook).onChange(() => {
				released.set(Fusion.peek(freeLook));
				dismissToken += 1;

				const token = dismissToken;
				shown.set(true);

				task.delay(SHOWN_SECONDS, () => {
					if (token !== dismissToken) return;
					shown.set(false);
				});
			}),
		);

		if (DEBUG) {
			print(`[Toast] camera mounted — released = ${Fusion.peek(freeLook)}`);
		}
	}
}
