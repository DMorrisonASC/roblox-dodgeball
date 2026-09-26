import { Controller, OnStart } from "@flamework/core";
import { Card, Text } from "@rbxts/big-ui";
import Fusion from "@rbxts/fusion-3.0";
import { ReplicatedStorage } from "@rbxts/services";
import { ROUND_STATE_ATTRIBUTE, ROUND_STATUS_FOLDER, ROUND_TIME_ATTRIBUTE, ROUND_WINNER_ATTRIBUTE } from "shared/constants";
import { getHudScreenGui } from "../../ui/screenGui";

/** Prints once, when the HUD is up — the line that says the controller ran at all. */
const DEBUG = true;

/** How wide the HUD is, and how far below the top of the screen it sits. Its height is its content's. */
const HUD_WIDTH = 360;
const HUD_TOP_INSET = 0.5;

/**
 * What the server calls a round nobody won.
 *
 * A convention between this file and `RoundService` rather than a shared constant, like the phase
 * names: it is the HUD's half of two files agreeing on a word, and the word is not a setting.
 */
const DRAW = "draw";

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
		const winner = Fusion.Value(scope, "");

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

		scope.push(
			status.GetAttributeChangedSignal(ROUND_WINNER_ATTRIBUTE).Connect(() => {
				const value = status.GetAttribute(ROUND_WINNER_ATTRIBUTE);
				if (typeIs(value, "string")) winner.set(value);
			}),
		);

		// Seeded from what the server has already said, because the folder exists before this
		// runs: without it the HUD would sit on its defaults until the next change, and on a
		// countdown that is a whole second of a number nobody set.
		const initialState = status.GetAttribute(ROUND_STATE_ATTRIBUTE);
		if (typeIs(initialState, "string")) state.set(initialState);

		const initialTime = status.GetAttribute(ROUND_TIME_ATTRIBUTE);
		if (typeIs(initialTime, "number")) time.set(initialTime);

		const initialWinner = status.GetAttribute(ROUND_WINNER_ATTRIBUTE);
		if (typeIs(initialWinner, "string")) winner.set(initialWinner);

		// The HUD's entire content, derived rather than assembled: it re-reads all three values
		// whenever any of them changes, and never has to be told that it should.
		//
		// The phase is checked as well as the winner, so a result can only ever appear against the
		// intermission it belongs to: whatever the folder happens to be holding, a playing phase
		// reads as a playing phase.
		const text = Fusion.Computed(scope, (use) => {
			const line = `${use(state)} — ${use(time)}s`;
			const result = use(winner);

			if (use(state) !== "Intermission" || result === "") return line;

			// Built before it is used, and **never nested inside the line's own template**:
			// roblox-ts compiles each template literal to a Luau interpolated string, so nesting
			// one puts backticks inside backticks — which parses, and quietly renders as nothing.
			// The line above shows the failure exactly: `Intermission — 47s |` and no result.
			const outcome = result === DRAW ? "Draw" : `Team ${result} won`;

			return `${line} | ${outcome}`;
		});

		const wrapper = Fusion.New(scope, "Frame")({
			Name: "Wrapper",
			Size: new UDim2(0, HUD_WIDTH, 0, 0),
			AutomaticSize: Enum.AutomaticSize.Y,
			Position: new UDim2(0.5, 0, 0, HUD_TOP_INSET),
			AnchorPoint: new Vector2(0.5, 0),
			BackgroundTransparency: 1,
		});

		// **No `size` on the card, and that is the whole trick.** big-ui's `Card` auto-sizes its
		// height only when it is given no size at all — pass one and it pins the box and turns that
		// off, which is what a second line of text then falls out of. So the card is as tall as its
		// line, and the wrapper follows it, and no amount of text can be clipped by a box that was
		// sized before the text existed.
		const card = Card(scope, {
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
