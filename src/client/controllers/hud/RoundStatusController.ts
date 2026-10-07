import { Controller, OnStart } from "@flamework/core";
import { Card, Text } from "@rbxts/big-ui";
import Fusion from "@rbxts/fusion-3.0";
import { Players, ReplicatedStorage } from "@rbxts/services";
import { ARENA_CONFIG } from "shared/config/arena.config";
import { ROUND_MODE_ATTRIBUTE, ROUND_STATE_ATTRIBUTE, ROUND_STATUS_FOLDER, ROUND_TIME_ATTRIBUTE } from "shared/constants";
import { GAME_MODE_NAMES, isGameModeId } from "shared/gameMode";
import { getHudScreenGui } from "../../ui/screenGui";
import { addViewportConstraint } from "../../ui/viewportConstraint";

/** Prints once, when the HUD is up — the line that says the controller ran at all. */
const DEBUG = true;

/** How wide the HUD is, and how far below the top of the screen it sits. Its height is its content's. */
const HUD_WIDTH = 360;
/*
 * **No longer `0`, because the score bar now occupies the top row.** The score is pinned at inset 4 and this
 * band sits below it, which is the order a scoreboard is read in — the score changes, the clock counts down
 * underneath it. This is the band's offset and nothing else: its width, its contents and its behaviour are
 * untouched, and the clock itself did not move inside it.
 */
const HUD_TOP_INSET = 44;

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
		const mode = Fusion.Value(scope, "");

		/**
		 * How many players are in the server, for the "waiting for players" line.
		 *
		 * **Counted here rather than published by the server.** The client already has the whole
		 * `Players` list, so a copy of that number on an attribute would be a second answer to a
		 * question the engine is already answering — and the client's copy is the one that matches
		 * what the player can actually see on the scoreboard. This is display only: whether a round
		 * may *start* is the server's decision, and this reads the count to explain a clock that has
		 * stopped moving.
		 */
		const playerCount = Fusion.Value(scope, Players.GetPlayers().size());

		const recount = () => playerCount.set(Players.GetPlayers().size());

		scope.push(Players.PlayerAdded.Connect(recount));

		// **Deferred, because `PlayerRemoving` fires *before* the player leaves `GetPlayers`.** A
		// direct count in the handler reads one too many, and the label would sit at `2/2` — or keep
		// counting a round as viable — after the second player had already gone.
		scope.push(Players.PlayerRemoving.Connect(() => task.defer(recount)));

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
			status.GetAttributeChangedSignal(ROUND_MODE_ATTRIBUTE).Connect(() => {
				const value = status.GetAttribute(ROUND_MODE_ATTRIBUTE);
				if (typeIs(value, "string")) mode.set(value);
			}),
		);

		// Seeded from what the server has already said, because the folder exists before this
		// runs: without it the HUD would sit on its defaults until the next change, and on a
		// countdown that is a whole second of a number nobody set.
		const initialState = status.GetAttribute(ROUND_STATE_ATTRIBUTE);
		if (typeIs(initialState, "string")) state.set(initialState);

		const initialTime = status.GetAttribute(ROUND_TIME_ATTRIBUTE);
		if (typeIs(initialTime, "number")) time.set(initialTime);

		// Seeded like the others, and here it matters most: the mode is written once — when a vote
		// closes — rather than every second, so a client that mounted after that write would never
		// see it if this only listened for changes.
		const initialMode = status.GetAttribute(ROUND_MODE_ATTRIBUTE);
		if (typeIs(initialMode, "string")) mode.set(initialMode);

		// The HUD's entire content, derived rather than assembled: it re-reads all four values
		// whenever any of them changes, and never has to be told that it should.
		//
		// **The wording is built here, on the client.** The server publishes a phase, a clock and a
		// mode id; turning those into a sentence is presentation, and presentation that only ever has
		// one consumer — a label — belongs on the machine drawing the label. See `GAME_MODE_NAMES`,
		// which is the one place a mode is named.
		const text = Fusion.Computed(scope, (use) => {
			// **Every value is read before any branching, and that is not tidiness.** Fusion decides
			// what a `Computed` depends on from the `use` calls that actually *run*, so a read placed
			// inside an `if` is a subscription that only exists while that branch is taken. Reading
			// the clock inside the non-waiting branch — as this used to — meant the label stopped
			// watching it for as long as it was saying "waiting for players", and was only rescued
			// because the player count changing re-runs the whole thing. All four up front makes the
			// subscription set fixed, whatever the line ends up saying.
			const phase = use(state);
			const players = use(playerCount);
			const seconds = use(time);
			const modeId = use(mode);

			// **Below the minimum, the countdown is not the interesting number.** The intermission is
			// frozen and will not move until somebody else arrives, so `Intermission — 30s` would be a
			// clock that has stopped for a reason the reader cannot see. The count is the reason.
			//
			// **It replaces the clock and nothing else, and the winner is no longer one of the things
			// it has to leave room for.** This used to `return` early, which silently dropped both
			// the mode and the winner: the commonest way a server drops below the minimum is a
			// leaver deciding the round, so the line was at its least informative exactly when there
			// was most to say. The winner has since moved off this line altogether — see
			// `RoundResultController` — which leaves the mode as the only segment the shape below now
			// protects. The shape stays anyway: a face with segments appended is what makes the next
			// one of them a line rather than a rewrite.
			const waiting = phase === "Intermission" && players < ARENA_CONFIG.MIN_PLAYERS;

			const face = waiting
				? `Waiting for players — ${players}/${ARENA_CONFIG.MIN_PLAYERS}`
				: `${phase} — ${seconds}s`;

			let line = face;

			// The mode, once a vote has named one. Between the vote closing and the round beginning
			// this names the round *to come*, which is exactly when a player wants to read it. The
			// attribute carries an **id**, so the name on screen is looked up from it here — see
			// `ROUND_MODE_ATTRIBUTE` for why the id is what travels rather than the sentence.
			const known = isGameModeId(modeId);

			if (known) line = `${line} | ${GAME_MODE_NAMES[modeId]}`;

			// **The winner used to be appended right here, and the rule it was appended under is the
			// part worth keeping.** What belongs on this line is the round's *state*: the phase, the
			// clock, and the mode it is being played by. A result is not a state — it is a thing to
			// be read, with a board of the round's hits under it, which is a shape no single line has
			// room for. It has a panel of its own now, and this line went back to being about the
			// round that has not started yet.
			return line;
		});

		const wrapper = Fusion.New(scope, "Frame")({
			Name: "Wrapper",
			Size: new UDim2(0, HUD_WIDTH, 0, 0),
			AutomaticSize: Enum.AutomaticSize.Y,
			Position: new UDim2(0.5, 0, 0, HUD_TOP_INSET),
			AnchorPoint: new Vector2(0.5, 0),
			BackgroundTransparency: 1,
		});

		// `HUD_WIDTH` is a fixed 360px, which is right for a desktop and wider than the whole screen
		// on a narrow phone — and because this HUD is centred, an overflow costs it *both* edges at
		// once rather than one. The cap is what makes the fixed width safe: above the fraction the
		// card behaves exactly as it did, and below it the card gives way instead of leaving.
		addViewportConstraint(scope, wrapper);

		// **No `size` on the card, and that is the whole trick.** big-ui's `Card` auto-sizes its
		// height only when it is given no size at all — pass one and it pins the box and turns that
		// off, which is what a second line of text then falls out of. So the card is as tall as its
		// line, and the wrapper follows it, and no amount of text can be clipped by a box that was
		// sized before the text existed.
		const card = Card(scope, {
			padding: 4,
			children: [
				Text(scope, {
					text,
					variant: "button",
					align: Enum.TextXAlignment.Center,
				}),
			],
		});

		card.Parent = wrapper;
		card.BackgroundTransparency = 0.3;
		// Shared with any other HUD, so `PlayerGui` does not collect a `ScreenGui` per feature — and
		// so the settings that are about the screen rather than about this HUD are decided once.
		// See `ui/screenGui.ts`.
		wrapper.Parent = getHudScreenGui();

		if (DEBUG) print(`[HUD] round status up — reading ${ROUND_STATUS_FOLDER} in ReplicatedStorage`);
	}
}
