import { Controller, OnStart } from "@flamework/core";
import { Card, Text } from "@rbxts/big-ui";
import Fusion from "@rbxts/fusion-3.0";
import { ReplicatedStorage } from "@rbxts/services";
import { ROUND_STATE_ATTRIBUTE, ROUND_STATUS_FOLDER, ROUND_TIME_ATTRIBUTE } from "shared/constants";
import { getHudScreenGui } from "../ui/screenGui";

/** Prints once, when the HUD is up — the line that says the controller ran at all. */
const DEBUG = true;

/** How much of the top of the screen the HUD takes, and how far below the edge it sits. */
const HUD_SIZE = UDim2.fromOffset(240, 56);

/** Measured from the top of the screen, which is the real top because the GUI opts out of the inset. */
const HUD_TOP_INSET = 0.5;

/**
 * The round HUD: which phase the round is in, and how long is left of it.
 *
 * **It reads nothing but the folder it was pointed at.** The phase and the clock are two
 * attributes on `RoundStatus` in `ReplicatedStorage`, written by the server and replicated by
 * the engine — so this controller needs no remote, no service, and no knowledge of
 * `RoundService`, and the round needs no knowledge of this beyond the two names in
 * `shared/constants`. That is the whole reason the state is published as attributes rather
 * than sent: the channel is the state, and there is nothing to keep in step.
 *
 * Fusion holds the UI up. The attributes are pushed into `Value`s by their changed signals, a
 * `Computed` turns those into the one line of text, and big-ui's `Text` observes it — so
 * nothing here re-renders anything by hand, and the label cannot show a stale pair.
 */
@Controller()
export class RoundStatusController implements OnStart {
	public onStart(): void {
		// Spawned rather than done inline: the folder is made by the *server's* `onStart`, so
		// waiting for it can yield — and a controller's `onStart` is the wrong place to hold up
		// the rest of the client's boot for something that is not ready yet.
		task.spawn(() => this.mount());
	}

	private mount(): void {
		const status = ReplicatedStorage.WaitForChild(ROUND_STATUS_FOLDER);
		const scope = Fusion.scoped();

		const state = Fusion.Value(scope, "Intermission");
		const time = Fusion.Value(scope, 0);

		// Subscribed *before* seeding, so a change landing between the two is not lost — the seed
		// then reads the newer value and wins, which is the order that cannot go wrong either way.
		//
		// Both connections are handed to the scope, which is what one-scope-per-controller buys:
		// the subscriptions are cleaned up with the UI they feed rather than outliving it.
		scope.push(
			status.GetAttributeChangedSignal(ROUND_STATE_ATTRIBUTE).Connect(() => {
				const value = status.GetAttribute(ROUND_STATE_ATTRIBUTE);
				if (typeIs(value, "string")) state.set(value);
			}),
		);

		scope.push(
			status.GetAttributeChangedSignal(ROUND_TIME_ATTRIBUTE).Connect(() => {
				const value = status.GetAttribute(ROUND_TIME_ATTRIBUTE);
				if (typeIs(value, "number")) time.set(value);
			}),
		);

		// Seeded from what the server has already said, because the folder exists before this
		// runs: without it the HUD would sit on its defaults until the next change, and on a
		// countdown that is a whole second of a number nobody set.
		const initialState = status.GetAttribute(ROUND_STATE_ATTRIBUTE);
		if (typeIs(initialState, "string")) state.set(initialState);

		const initialTime = status.GetAttribute(ROUND_TIME_ATTRIBUTE);
		if (typeIs(initialTime, "number")) time.set(initialTime);

		// The HUD's entire content, derived rather than assembled: it re-reads both values
		// whenever either changes, and never has to be told that it should.
		const text = Fusion.Computed(scope, (use) => `${use(state)} — ${use(time)}s`);

		const wrapper = Fusion.New(scope, "Frame")({
			Name: "Wrapper",
			Size: HUD_SIZE,
			Position: new UDim2(0.5, 0, 0, HUD_TOP_INSET),
			AnchorPoint: new Vector2(0.5, 0),
			BackgroundTransparency: 1,
		});

		// The card is sized to the wrapper rather than left to its own content, so the HUD is the
		// size it says it is: left alone it grows to its padding plus a line of text, which is a
		// few pixels taller than the frame it is supposed to be filling.
		const card = Card(scope, {
			size: UDim2.fromScale(1, 1),
			children: [
				Text(scope, {
					text,
					variant: "h6",
					align: Enum.TextXAlignment.Center,
				}),
			],
		});

		card.Parent = wrapper;
		// Shared with any other HUD, so `PlayerGui` does not collect a `ScreenGui` per feature — and
		// so the settings that are about the screen rather than about this HUD are decided once.
		// See `ui/screenGui.ts`.
		wrapper.Parent = getHudScreenGui();

		if (DEBUG) print(`[HUD] round status up — reading ${ROUND_STATUS_FOLDER} in ReplicatedStorage`);
	}
}
