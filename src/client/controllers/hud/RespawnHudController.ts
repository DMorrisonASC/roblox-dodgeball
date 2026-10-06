import { Controller, OnStart } from "@flamework/core";
import { Text } from "@rbxts/big-ui";
import Fusion from "@rbxts/fusion-3.0";
import { Players, RunService, Workspace } from "@rbxts/services";
import { RESPAWN_AT_ATTRIBUTE } from "shared/constants";
import { getHudScreenGui } from "../../ui/screenGui";
import { addViewportConstraint } from "../../ui/viewportConstraint";

/** Prints once, when the countdown is up — the line that says the controller ran at all. */
const DEBUG = true;

/** The label's width. Its height comes from the text; this is only what the line is centred in. */
const LABEL_WIDTH = 240;

/** Where the countdown sits, as a fraction of the screen — above centre, out of the crosshair's way. */
const CENTRE = UDim2.fromScale(0.5, 0.4);

/**
 * How long the local player has left to wait for a body, in whole tenths, or `0` for "not waiting".
 *
 * **Fractions of a second rather than whole ones, because the wait is only a few seconds long.** A
 * three-second timer read in whole seconds spends most of its life looking stuck; a tenth is the
 * resolution at which a wait that short feels like it is moving.
 *
 * **Read against `Workspace:GetServerTimeNow`, which is the clock the server wrote with.** The
 * attribute is an *instant* — `RESPAWN_AT_ATTRIBUTE` holds the moment the body is due, on the engine's
 * shared clock — so this is one subtraction and needs no remote, no local timer, and no second
 * implementation of "how long is the wait". A client counting down on its own would be exactly that:
 * a second answer, free to disagree with the one the server is actually going to keep.
 *
 * `0` for anything that is not a number, which is the state a player joins in and the state
 * `RespawnService` writes the moment a body is loaded — so "no attribute" and "the wait is over" are
 * the same answer here, and there is no third case to get wrong.
 */
function remainingOf(at: unknown, now: number): number {
	if (!typeIs(at, "number")) return 0;
	if (at <= now) return 0;

	return at - now;
}

/**
 * The respawn countdown: one line, above centre, shown only while the local player is waiting for a
 * body.
 *
 * **It exists because the wait is now real.** A death inside a round no longer hands the body straight
 * back — the engine's own respawn was switched off (see `main.server.ts`) so that `RoundService` can
 * delay it — which means there is a gap a player has to be told about. Without this label that gap is
 * a dead screen with no explanation, and the honest reading of a dead screen is "the game has broken".
 *
 * **It reads one attribute and nothing else**, the same shape as `SpectatorController`: `RespawnService`
 * writes the instant the next body is due on the *player* — not the character, because the character is
 * precisely what is missing — so there is no remote here, no service, and no knowledge of why the wait
 * was scheduled. Everything shown is derived from that one number, so the readout cannot disagree with
 * the timer that will actually fire.
 *
 * **`RespawnAt` is also what `SpectatorController` is not:** that label is about being out of the round,
 * this one is about being between bodies, and a player who is eliminated while waiting will have both
 * cleared and this one hidden in the same frame.
 */
@Controller()
export class RespawnHudController implements OnStart {
	public onStart(): void {
		// Spawned rather than done inline: mounting waits for `PlayerGui`, and a controller's `onStart`
		// is the wrong place to hold up the rest of the client's boot. The wait is also why this is safe
		// to mount at boot rather than on a death: `PlayerGui` outlives the character, so the label stays
		// parented across the one event it is here to describe.
		task.spawn(() => this.mount());
	}

	private mount(): void {
		const player = Players.LocalPlayer;
		const scope = Fusion.scoped();

		// Hidden is the state a player joins in — they have a body, so nothing is being waited for — so
		// nothing has to be worked out before the server has said anything.
		const waiting = Fusion.Value(scope, false);

		scope.push(
			player.GetAttributeChangedSignal(RESPAWN_AT_ATTRIBUTE).Connect(() => {
				waiting.set(remainingOf(player.GetAttribute(RESPAWN_AT_ATTRIBUTE), Workspace.GetServerTimeNow()) > 0);
			}),
		);

		// Seeded from what the server has already said, because the attribute can be set before this runs:
		// a player who died while the client was still loading is already counting down, and the label should
		// be up on the first frame rather than at the next change — which, for a wait this short, may be
		// after it has finished.
		waiting.set(remainingOf(player.GetAttribute(RESPAWN_AT_ATTRIBUTE), Workspace.GetServerTimeNow()) > 0);

		// A frame around the label rather than the label itself, because `Visible` is what is reactive and a
		// `TextLabel` built by big-ui's `Text` takes no reactive properties. One of the two has to carry the
		// state; this way the label keeps the typography. The same division as `SpectatorController`.
		const wrapper = Fusion.New(scope, "Frame")({
			Name: "RespawnCountdown",
			Size: new UDim2(0, LABEL_WIDTH, 0, 0),
			Position: CENTRE,
			AnchorPoint: new Vector2(0.5, 0.5),
			AutomaticSize: Enum.AutomaticSize.Y,
			BackgroundTransparency: 1,
			Visible: waiting,
		});

		// `LABEL_WIDTH` is 240px and the label is centred, so a viewport narrower than that clips it on both
		// sides at once. No shipping phone is that narrow, and the bound costs nothing on one that is wide
		// enough — the same rule as the other HUDs: the element carries its own limit rather than trusting
		// that the screen will be big enough.
		addViewportConstraint(scope, wrapper);

		const label = Text(scope, {
			text: "",
			variant: "subtitle1",
			align: Enum.TextXAlignment.Center,
		});

		label.Parent = wrapper;
		wrapper.Parent = getHudScreenGui();

		// **The one thing that is written imperatively rather than through a `Value`, and it is the text
		// itself.** `Visible` changes on an attribute write, so it can be reactive; the number changes every
		// frame by definition, and wrapping a per-frame value in a `Value` would be Fusion doing arithmetic
		// this loop is already doing. So the loop writes the label and nothing else, and returns immediately
		// on the frames that matter most — the ones where the player has a body.
		//
		// `Fusion.peek` rather than a subscription to `waiting`: the loop is *already* running every frame, so
		// asking Fusion for the current value costs one table lookup where a subscription would cost a
		// dependency edge and a second body of code to decide the same thing twice.
		scope.push(
			RunService.RenderStepped.Connect(() => {
				if (!Fusion.peek(waiting)) return;

				const remaining = remainingOf(player.GetAttribute(RESPAWN_AT_ATTRIBUTE), Workspace.GetServerTimeNow());

				if (remaining <= 0) {
					waiting.set(false);

					return;
				}

				// Rounded up before it is formatted: `%.1f` on a wait of 3.00 to 2.95 would print "3.0", and on
				// 0.04 would print "0.0" while the body has not arrived — a label that says zero and means "any
				// moment now". `math.ceil` to a tenth keeps the last shown figure honest at both ends.
				const tenths = math.ceil(remaining * 10) / 10;

				label.Text = `Respawning in ${string.format("%.1f", tenths)}s`;
			}),
		);

		if (DEBUG) print(`[HUD] respawn countdown up — reading ${RESPAWN_AT_ATTRIBUTE} on the player`);
	}
}
