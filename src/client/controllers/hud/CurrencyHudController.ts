import { Controller, OnStart } from "@flamework/core";
import { Text } from "@rbxts/big-ui";
import Fusion from "@rbxts/fusion-3.0";
import { Players } from "@rbxts/services";
import { COINS_ATTRIBUTE } from "shared/constants";
import { getHudScreenGui } from "../../ui/screenGui";

/** Prints once, when the readout is up — the line that says the controller ran at all. */
const DEBUG = true;

/**
 * The coin readout: one line under the shop button, showing the wallet the server owns.
 *
 * **It reads one attribute and nothing else**, the same shape as the spectator label: `EconomyService`
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

		const label = Text(scope, {
			text: "",
			variant: "body1",
			align: Enum.TextXAlignment.Left,
		});

		label.Name = "CoinReadout";
		label.Position = new UDim2(0, 12, 0, 64);
		label.Size = new UDim2(0, 160, 0, 22);

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

		label.Parent = getHudScreenGui();

		if (DEBUG) print(`[HUD] coin readout up — reading ${COINS_ATTRIBUTE} on the player`);
	}
}
