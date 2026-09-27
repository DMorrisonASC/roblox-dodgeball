import { Controller, OnStart } from "@flamework/core";
import { Button } from "@rbxts/big-ui";
import Fusion from "@rbxts/fusion-3.0";
import Net from "@rbxts/net";
import { ReplicatedStorage } from "@rbxts/services";
import {
	ROUND_STATUS_FOLDER,
	ROUND_VOTE_OPEN_ATTRIBUTE,
	ROUND_VOTE_OPTIONS_ATTRIBUTE,
} from "shared/constants";
import { decodeModeIds, GAME_MODE_NAMES, GameModeId } from "shared/gameMode";
import { events } from "shared/networking";
import { getHudScreenGui } from "../../ui/screenGui";
import { addViewportConstraint } from "../../ui/viewportConstraint";

/** Prints when the row is built and on every vote cast. */
const DEBUG = true;

/** The client half of the vote's event, as the declarations build it. */
type ClientRemotes = Net.Util.GetClientRemotes<Net.Util.GetDeclarationDefinitions<typeof events>>;

/**
 * How far below the top of the screen the row sits, in pixels.
 *
 * A fixed offset, and an intentional one: the row has to clear the round-status card, which is
 * pinned to the top-centre by a *different* controller and sizes itself to its own text. So there
 * is no layout this could join — a HUD cannot be a flex item of another HUD — and the honest
 * answer is a number with the reason written down.
 *
 * 84 is the status card's worst case plus air: one line of text at 14, wrapped to two because the
 * line also carries the mode name, plus the card's own 8px padding on each side, with the
 * remainder left as a gap. **Worth a look in Studio at a narrow width**, where the card wraps
 * first and this does not move.
 */
const TOP_INSET = 84;

/** The row's share of the screen width, before the cap below. */
const ROW_WIDTH_SCALE = 0.6;

/**
 * The widest the row may get, in pixels.
 *
 * The one number that stops three buttons spreading across an ultrawide monitor: 60% of a 3440px
 * screen is two thousand pixels of button, which is not a vote, it is a wall. Below this width the
 * row is its own 60% and the cap does nothing — it is a ceiling, not a size.
 */
const ROW_MAX_WIDTH = 720;

/** The gap between two buttons, in pixels. */
const BUTTON_GAP = 8;

/**
 * The vote: a row of buttons, one per mode, up only while the window is open.
 *
 * **It decides nothing.** Which modes are on offer, when the window opens, who won and which mode
 * the next round plays are all the server's — the client's whole job is to put the options on
 * screen and send back the one that was pressed. That is why there is no tally here and no
 * majority: a client-side count would be a second answer to a question the server has already
 * answered, and the one a player could edit.
 *
 * The options arrive as an attribute rather than being a list in this file, so a mode that has
 * been designed but not written simply is not offered. Building Dodge and Seek will put a third
 * button on this row without this file changing.
 */
@Controller()
export class ModeVoteController implements OnStart {
	private voteRemote?: ClientRemotes["castVote"];

	/** Whether the buttons have been built. See {@link buildButtons}. */
	private built = false;

	public onStart(): void {
		// Spawned rather than done inline: mounting waits for the status folder, and a controller's
		// `onStart` is the wrong place to hold up the rest of the client's boot.
		task.spawn(() => this.mount());
	}

	private mount(): void {
		// Made by `RoundService` at ignite, so this normally resolves at once — and `WaitForChild`
		// rather than `FindFirstChild` because the client may outrun a slow server, which is not an
		// error, only a client that is early.
		const status = ReplicatedStorage.WaitForChild(ROUND_STATUS_FOLDER);
		const scope = Fusion.scoped();

		// Hidden is the state a client mounts in — most of a server's life is not a vote — so
		// nothing has to be worked out before the server has said anything.
		const open = Fusion.Value(scope, status.GetAttribute(ROUND_VOTE_OPEN_ATTRIBUTE) === true);

		scope.push(
			status.GetAttributeChangedSignal(ROUND_VOTE_OPEN_ATTRIBUTE).Connect(() => {
				open.set(status.GetAttribute(ROUND_VOTE_OPEN_ATTRIBUTE) === true);
			}),
		);

		const row = Fusion.New(scope, "Frame")({
			Name: "ModeVote",
			AnchorPoint: new Vector2(0.5, 0),
			Position: new UDim2(0.5, 0, 0, TOP_INSET),
			// Proportional across, and as tall as its own buttons. `AutomaticSize.Y` on a horizontal
			// list takes the height of the tallest child, so the row cannot clip a button and does
			// not need a height written down.
			Size: new UDim2(ROW_WIDTH_SCALE, 0, 0, 0),
			AutomaticSize: Enum.AutomaticSize.Y,
			BackgroundTransparency: 1,
			Visible: open,
		});

		// The standard's flexbox: a horizontal list owns the positions, so no button needs a
		// `Position` and nothing here is a running sum of pixel widths.
		Fusion.New(scope, "UIListLayout")({
			Parent: row,
			FillDirection: Enum.FillDirection.Horizontal,
			SortOrder: Enum.SortOrder.LayoutOrder,
			Padding: new UDim(0, BUTTON_GAP),
			VerticalAlignment: Enum.VerticalAlignment.Center,
		});

		// `min-width`/`max-width`: the pixel ceiling above, and the helper's own 92%-of-viewport
		// cap underneath it so a narrow phone takes what is left rather than overflowing.
		addViewportConstraint(scope, row, { max: new Vector2(ROW_MAX_WIDTH, math.huge) });

		row.Parent = getHudScreenGui();

		this.buildButtons(scope, status, row);

		// Rebuilt-on-change rather than built here, because the options are published when the
		// vote *opens* — a client that mounted between rounds has not been told them yet. The
		// builder is guarded, so the ordinary case of a second window offering the same modes does
		// not build a second row of buttons on top of the first.
		scope.push(
			status.GetAttributeChangedSignal(ROUND_VOTE_OPTIONS_ATTRIBUTE).Connect(() => {
				this.buildButtons(scope, status, row);
			}),
		);

		if (DEBUG) print("[Vote] row up");
	}

	/**
	 * One button per offered mode, once.
	 *
	 * **The options are the server's, read off the folder and decoded** — this file has no list of
	 * its own, so what can be voted for is decided in exactly one place. See `encodeModeIds` for
	 * why the list travels as a string, and `decodeModeIds` for why an id this build does not
	 * recognise is dropped rather than rendered.
	 */
	private buildButtons(scope: Fusion.Scope<unknown>, status: Instance, row: Frame): void {
		if (this.built) return;

		const raw = status.GetAttribute(ROUND_VOTE_OPTIONS_ATTRIBUTE);
		const options = typeIs(raw, "string") ? decodeModeIds(raw) : [];

		// Nothing offered yet. Not an error — this is the state before the first vote of a
		// server's life, and building nothing is the right answer to it.
		if (options.size() === 0) return;

		this.built = true;

		for (let index = 0; index < options.size(); index++) {
			const id = options[index];

			const button = Button(scope, {
				label: GAME_MODE_NAMES[id],
				variant: "contained",
				onActivate: () => this.cast(id),
			});

			// big-ui ships the button hugging its own label — `AutomaticSize = X` — and an automatic
			// axis wins over a size, so it fights the flex item below for control of the width. The
			// axis has to be released first; without this the buttons would all be as wide as their
			// own text and `Fill` would have nothing to divide.
			button.AutomaticSize = Enum.AutomaticSize.None;

			// `Fill` is `flex: 1` — every button takes an equal share of the row, which is what
			// makes the widths a consequence of the count rather than a number anyone chose.
			Fusion.New(scope, "UIFlexItem")({
				Parent: button,
				FlexMode: Enum.UIFlexMode.Fill,
			});

			button.LayoutOrder = index;
			button.Parent = row;
		}

		if (DEBUG) print(`[Vote] ${options.size()} option(s) offered`);
	}

	/**
	 * Send a vote.
	 *
	 * **Nothing is predicted here.** The button does not mark itself, because the server is the
	 * only thing that knows whether the vote was counted — a window that had just closed, or a mode
	 * this build cannot run, are both refusals only the server can make. Feedback that the vote
	 * landed is deliberately absent for now; the print says what was sent.
	 */
	private cast(mode: GameModeId): void {
		if (DEBUG) print(`[Vote] voted for ${GAME_MODE_NAMES[mode]}`);

		this.getVoteRemote().SendToServer(mode);
	}

	private getVoteRemote(): ClientRemotes["castVote"] {
		if (!this.voteRemote) {
			this.voteRemote = events.Client.Get("castVote");
		}

		return this.voteRemote;
	}
}
