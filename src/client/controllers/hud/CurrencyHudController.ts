import { Controller, OnStart } from "@flamework/core";
import { Text } from "@rbxts/big-ui";
import Fusion from "@rbxts/fusion-3.0";
import { Players } from "@rbxts/services";
import { ARENA_CONFIG } from "shared/config/arena.config";
import { COINS_ATTRIBUTE, ROUND_EARNED_COINS_ATTRIBUTE } from "shared/constants";
import { pushNotification } from "../../notifications";
import { killCamActive } from "../../panels";
import { applyGlow } from "../../ui/glow";
import { PREMIUM } from "../../ui/premiumTheme";
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
			// **A solid plate now, not a bare label over the arena.** The readout was invisible furniture — a
			// number floating in the top-left — which was right while the HUD was a light one drawn over a mostly
			// light arena and wrong on a solid-plum direction: white at `0.15` alpha over sand is unreadable, and
			// the palette's rule is that *text* is the soft thing, never the surface behind it. Same fill, gold
			// hairline and corner as every other panel; the geometry is untouched.
			BackgroundColor3: PREMIUM.panel,
			BackgroundTransparency: PREMIUM.transparency,
			BorderSizePixel: 0,

			// **Hidden for the kill cam, like the rest of the HUD.** The wallet is not in question while the
			// camera is over somebody else — and because this is a `Visible` write rather than a teardown, the
			// number is still being tracked underneath and is current on the frame it returns.
			Visible: Fusion.Computed(scope, (use) => !use(killCamActive)),
		});

		Fusion.New(scope, "UICorner")({ Parent: wrapper, CornerRadius: new UDim(0, PREMIUM.corner) });
		// **The readout's neon edge**, core plus bloom — see `ui/glow.ts`. A 160×22 plate is small enough that its
		// bloom is most of what a player sees of it, which is the point: the wallet is not furniture any more, it is a
		// small lit readout in the corner.
		applyGlow(wrapper);

		const label = Text(scope, {
			text: "",
			variant: "body1",
			align: Enum.TextXAlignment.Left,
		});

		label.Name = "CoinReadoutText";
		label.Position = UDim2.fromOffset(0, 0);
		label.Size = UDim2.fromScale(1, 1);
		// **The theme's white at the theme's text alpha.** big-ui's `Text.color` is its own palette vocabulary, so
		// the ink is written onto the instance; the alpha is the direction's rule for every label, and the plate
		// behind this one is what makes it legible at `0.15`. See `PREMIUM.textTransparency`.
		label.TextColor3 = PREMIUM.text;
		label.TextTransparency = PREMIUM.textTransparency;

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

		// **And what the round just paid, said out loud once per round — the reward toast.**
		//
		// **The attribute's change signal *is* the notification.** `EconomyService.onRoundEnded` writes
		// `ROUND_EARNED_COINS_ATTRIBUTE` in the same pass that raises the balance, and `RoundService` clears it
		// when the celebration ends — so "the value moved to a number" is exactly "this player was paid for the
		// round that just finished", with no remote, no round-state subscription and nothing to keep in step.
		// That is why the readout above and this sit in the same controller: both are the wallet speaking.
		//
		// **The clear is what makes the second round work.** An attribute written to the value it already holds
		// fires no signal, so two rounds paying fourteen coins would produce one toast and then a silence that
		// looked like the economy failing. `RoundService.holdCelebration` clears it for that reason; the
		// `typeIs` guard below is the other half, because the clear itself arrives here as a change to
		// `undefined`.
		//
		// **Held for the celebration rather than for the default three seconds**, and this is the one caller of
		// `pushNotification` that passes a duration: the toast is the reason the window exists, and a line that
		// faded while the arena was still being held would be the feature deciding it was not worth reading.
		// Both numbers are the same config value, so the toast cannot outlive the hold by accident — see
		// `ARENA_CONFIG.CELEBRATION_SECONDS`.
		scope.push(
			player.GetAttributeChangedSignal(ROUND_EARNED_COINS_ATTRIBUTE).Connect(() => {
				const earned = player.GetAttribute(ROUND_EARNED_COINS_ATTRIBUTE);
				if (!typeIs(earned, "number")) return;

				// **Nothing to say about a nought**, which is reachable: a surrender pays `math.floor` of a
				// halved payout, and a round with the base at nought would too. A `+0 Coins!` is worse than the
				// silence — it reads as a bug rather than as a small round. Guarded on the *rounded* figure
				// because that is the number the line would print.
				const coins = math.floor(earned);
				if (coins <= 0) return;

				pushNotification(`+${coins} Coin${coins === 1 ? "" : "s"}!`, ARENA_CONFIG.CELEBRATION_SECONDS);
			}),
		);

		label.Parent = wrapper;
		wrapper.Parent = getHudScreenGui();

		if (DEBUG) print(`[HUD] coin readout up — reading ${COINS_ATTRIBUTE} on the player`);
	}
}
