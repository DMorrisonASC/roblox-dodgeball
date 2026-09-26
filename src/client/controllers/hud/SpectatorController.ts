import { Controller, OnStart } from "@flamework/core";
import { Text } from "@rbxts/big-ui";
import Fusion from "@rbxts/fusion-3.0";
import { Players } from "@rbxts/services";
import { SPECTATING_ATTRIBUTE } from "shared/constants";
import { getHudScreenGui } from "../../ui/screenGui";

/** Prints once, when the label is up — the line that says the controller ran at all. */
const DEBUG = true;

/** How far the label sits above the bottom of the screen, in pixels. */
const BOTTOM_INSET = 12;

/** The label's width. Its height comes from the text; this is only what the line is centred in. */
const LABEL_WIDTH = 240;

/** What being out of the round is called, in the one place that words it. */
const TEXT = "You're out — spectating";

/**
 * The spectator label: one line, bottom-centre, shown only while the local player is out of the
 * round in progress.
 *
 * **It reads one attribute and nothing else.** `RoundService` writes `Spectating` on the
 * *player* — not the character, because a character is replaced on every death and being out of
 * a round outlives the body — so this controller needs no remote, no service, and no knowledge
 * of how a round decides who is out. Showing and hiding is one frame's `Visible` driven by the
 * attribute's own value, so there is no branch here that could disagree with the server.
 */
@Controller()
export class SpectatorController implements OnStart {
	public onStart(): void {
		// Spawned rather than done inline: mounting waits for `PlayerGui`, and a controller's
		// `onStart` is the wrong place to hold up the rest of the client's boot.
		task.spawn(() => this.mount());
	}

	private mount(): void {
		const player = Players.LocalPlayer;
		const scope = Fusion.scoped();

		// Hidden is the state a player joins in — in the round, or between rounds, either way not
		// a spectator — so nothing has to be worked out before the server has said anything.
		const spectating = Fusion.Value(scope, false);

		scope.push(
			player.GetAttributeChangedSignal(SPECTATING_ATTRIBUTE).Connect(() => {
				spectating.set(player.GetAttribute(SPECTATING_ATTRIBUTE) === true);
			}),
		);

		// Seeded from what the server has already said, because the attribute can be set before
		// this runs: a player killed while the client was still loading is out of the round, and
		// the label should say so on the first frame rather than at the next change — which, for
		// a spectator, may be a whole round away.
		spectating.set(player.GetAttribute(SPECTATING_ATTRIBUTE) === true);

		// A frame around the label rather than the label itself, because `Visible` is what is
		// reactive and a `TextLabel` built by big-ui's `Text` takes no reactive properties. One of
		// the two has to carry the state; this way the label keeps the typography.
		const wrapper = Fusion.New(scope, "Frame")({
			Name: "SpectatorLabel",
			Size: new UDim2(0, LABEL_WIDTH, 0, 0),
			Position: new UDim2(0.5, 0, 1, -BOTTOM_INSET),
			AnchorPoint: new Vector2(0.5, 1),
			AutomaticSize: Enum.AutomaticSize.Y,
			BackgroundTransparency: 1,
			Visible: spectating,
		});

		const label = Text(scope, {
			text: TEXT,
			variant: "subtitle1",
			align: Enum.TextXAlignment.Center,
		});

		label.Parent = wrapper;
		wrapper.Parent = getHudScreenGui();

		if (DEBUG) print(`[HUD] spectator label up — reading ${SPECTATING_ATTRIBUTE} on the player`);
	}
}
