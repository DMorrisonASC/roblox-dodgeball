import { Controller, OnStart } from "@flamework/core";
import { Text } from "@rbxts/big-ui";
import Fusion from "@rbxts/fusion-3.0";
import { Players } from "@rbxts/services";
import { COINS_ATTRIBUTE } from "shared/constants";
import { killCamActive } from "../../panels";
import { getHudScreenGui } from "../../ui/screenGui";

/** Prints once, when the readout is up — the line that says the controller ran at all. */
const DEBUG = false; // off for frame time — see shared/config/debug.config.ts

/**
 * The coin readout: one line under the shop button, showing the wallet the server owns.
 *
 * **It reads one attribute and nothing else**, the same shape as the respawn countdown: `EconomyService`
 * writes `Coins` on the *player* — not the character, because the wallet outlives every body it was
 * filled in — so there is no remote here, no polling, and no second copy of the earn rules. The
 * readout changes when the attribute changes, which is exactly when the wallet changes.
 *
 * **Placed under the shop button rather than in it**, because the shop is a closed panel most of the
 * time and the balance is worth seeing without opening anything. The number is the whole of it —
 * there is no chest here, only the figure the chest will draw from.
 */
@Controller()
export class CurrencyHudController implements OnStart {
	public onStart(): void {
		// Spawned rather than done inline, for the reason every other HUD gives: mounting waits for
		// `PlayerGui`, and a controller's `onStart` is the wrong place to hold up the client's boot.
		task.spawn(() => this.mount());
	}

	private mount(): void {
		const scope = Fusion.scoped();
		const player = Players.LocalPlayer;

		// **A wrapper frame, because the visibility has to be reactive and a big-ui `Text` takes no reactive
		// properties** — the same division `RespawnHudController` makes for its own label, and for the same
		// reason. The wrapper carries the position and the `Visible`; the label keeps the typography and fills it.
		// The alternative was to write `label.Visible` from a subscription, which is a second writing path to
		// keep in step with the Fusion one.
		const wrapper = Fusion.New(scope, "Frame")({
			Name: "CoinReadout",
			Position: new UDim2(0, 12, 0, 64),
			Size: new UDim2(0, 160, 0, 22),
			BackgroundTransparency: 1,

			// **Hidden for the kill cam, like the rest of the HUD.** The wallet is not in question while the
			// camera is over somebody else — and because this is a `Visible` write rather than a teardown, the
			// number is still being tracked underneath and is current on the frame it returns.
			Visible: Fusion.Computed(scope, (use) => !use(killCamActive)),
		});

		const label = Text(scope, {
			text: "",
			variant: "body1",
			align: Enum.TextXAlignment.Left,
		});

		label.Name = "CoinReadoutText";
		label.Position = UDim2.fromOffset(0, 0);
		label.Size = UDim2.fromScale(1, 1);

		// The number is written imperatively rather than through a `Value`, because it changes on an
		// attribute write and nothing more — a per-frame value for a number that moves once a round would
		// be the wrong tool. A coin that is not a number reads as nought, which is the state a player
		// joins in before the server has loaded their record.
		const refresh = () => {
			const coins = player.GetAttribute(COINS_ATTRIBUTE);
			label.Text = `Coins: ${typeIs(coins, "number") ? math.floor(coins) : 0}`;
		};

		scope.push(player.GetAttributeChangedSignal(COINS_ATTRIBUTE).Connect(refresh));
		refresh();

		label.Parent = wrapper;
		wrapper.Parent = getHudScreenGui();

		if (DEBUG) print(`[HUD] coin readout up — reading ${COINS_ATTRIBUTE} on the player`);
	}
}
