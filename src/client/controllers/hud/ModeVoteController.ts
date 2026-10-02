import { Controller, OnStart } from "@flamework/core";
import { Button, Text } from "@rbxts/big-ui";
import Fusion from "@rbxts/fusion-3.0";
import Net from "@rbxts/net";
import { ReplicatedStorage } from "@rbxts/services";
import {
	ROUND_STATUS_FOLDER,
	ROUND_VOTE_OPEN_ATTRIBUTE,
	ROUND_VOTE_OPTIONS_ATTRIBUTE,
	voteCountAttribute,
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

/** The gap between a button and the count beside it, in pixels. */
const COUNT_GAP = 8;

/**
 * The width of the count column, in pixels.
 *
 * **A definite width, so that the button does not move every time a count gains a digit.** The count
 * sits to the right of the label, so a column that hugged its own text would narrow the button the
 * moment somebody voted a second time — a row that shuffles under the cursor that is clicking it.
 * Wide enough for the counts a vote can reach on a server that exists, and no wider.
 */
const COUNT_WIDTH = 28;

/**
 * The vote: a row of buttons, one per mode, up only while the window is open **and only until this
 * player has answered it**.
 *
 * **It decides nothing, and it counts nothing either.** Which modes are on offer, when the window
 * opens, who won, which mode the next round plays and how many votes each option has are all the
 * server's — the client's whole job is to put the options on screen, put the count it was handed
 * beside each one, and send back the one that was pressed. The figure next to a label is read off
 * the folder like everything else here, which is the point: a count worked out on this machine would
 * be a second tally, and the one a player could edit.
 *
 * **And it takes itself away once that has happened**, because a window that is still open for
 * everybody else has nothing left to ask of somebody who has already answered, and a row of buttons
 * across the top of the screen is not a thing to leave up out of politeness. See {@link voted} for
 * the state and {@link confirmVote} for what sets it.
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

	/** The scope {@link voted} lives in. See its note for why it is not the mount's. */
	private readonly voteScope = Fusion.scoped();

	/**
	 * Whether *this* player's vote has been counted, which is what takes the row away.
	 *
	 * **A field rather than a local in `mount`, because two methods need it**: the row's visibility is
	 * built in `mount` and the vote that sets it is sent from `cast`. It gets a scope of its own rather than
	 * the mount's for the same reason — it outlives no part of the mount, but it does have to be reachable
	 * from a closure that the mount does not own.
	 *
	 * **A second state rather than a third condition on the window**, because the two answer different
	 * questions: the window is the server's, and this is this client's own business. The row is up only while
	 * both say yes.
	 *
	 * **Cleared when the window closes**, so the next vote is offered like the first: the row comes back on
	 * the next intermission because the window closed in between, and nothing has to remember which round it
	 * was.
	 */
	private readonly voted = Fusion.Value(this.voteScope, false);

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
				const nowOpen = status.GetAttribute(ROUND_VOTE_OPEN_ATTRIBUTE) === true;

				// **A closed window forgets the answer**, which is what makes the next one offer the row
				// again — the only place this is cleared, so there is nowhere else for it to be missed.
				if (!nowOpen) this.voted.set(false);

				open.set(nowOpen);
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
			// **Both questions, and the row goes when either says so.** The server's window, and this
			// client's own answer to it — see `voted`, and `confirmVote` for what sets that: the count going
			// up, which is the server saying the vote landed, rather than the click.
			Visible: Fusion.Computed(scope, (use) => use(open) && !use(this.voted)),
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

			// **A slot per option, because the count has to sit beside the label and a big-ui button
			// cannot be taught to change one.** `Button.label` is a plain string taken at
			// construction — unlike `Text.text`, which takes a `UsedAs<string>` — so a live count
			// cannot go into the button's own label without rebuilding the button on every vote.
			// It goes next to it instead: the slot is the row's flex item, and the button and the
			// count are laid out inside it.
			const slot = Fusion.New(scope, "Frame")({
				Name: `VoteSlot${id}`,
				Size: new UDim2(0, 0, 0, 0),
				AutomaticSize: Enum.AutomaticSize.Y,
				BackgroundTransparency: 1,
			});

			// `Fill` is `flex: 1` — every slot takes an equal share of the row, which is what makes the
			// widths a consequence of the count of options rather than a number anyone chose.
			Fusion.New(scope, "UIFlexItem")({
				Parent: slot,
				FlexMode: Enum.UIFlexMode.Fill,
			});

			Fusion.New(scope, "UIListLayout")({
				Parent: slot,
				FillDirection: Enum.FillDirection.Horizontal,
				SortOrder: Enum.SortOrder.LayoutOrder,
				VerticalAlignment: Enum.VerticalAlignment.Center,
				Padding: new UDim(0, COUNT_GAP),
			});

			const button = Button(scope, {
				label: GAME_MODE_NAMES[id],
				variant: "contained",
				layoutOrder: 1,
				onActivate: () => this.cast(id, status),
			});

			// big-ui ships the button hugging its own label — `AutomaticSize = X` — and an automatic
			// axis wins over a size, so it fights the flex item below for control of the width. The
			// axis has to be released first; without this the buttons would all be as wide as their
			// own text and `Fill` would have nothing to divide.
			button.AutomaticSize = Enum.AutomaticSize.None;

			// `Fill` inside the slot: the button takes what is left once the count has taken its
			// column, so the two never fight over the same pixels.
			Fusion.New(scope, "UIFlexItem")({
				Parent: button,
				FlexMode: Enum.UIFlexMode.Fill,
			});

			button.Parent = slot;

			// The count, read off the folder rather than counted here — see the class comment.
			const votes = watchCount(scope, status, id);

			// **A bare number, and the label beside it is what names it.** The stat billboard spells
			// its figures out because it is read from across an arena at somebody else's head; this
			// is a number on a button the player is already looking at, on a row whose whole subject
			// is the vote — `Dodge and Seek   3` needs no `votes:` to be read.
			const count = Text(scope, {
				text: Fusion.Computed(scope, (use) => tostring(use(votes))),
				variant: "button",
				align: Enum.TextXAlignment.Center,
				size: UDim2.fromOffset(COUNT_WIDTH, 0),
				layoutOrder: 2,
			});

			// **The automatic axis, put back on the height.** big-ui takes `AutomaticSize` off
			// entirely when a `Text` is given a size, so a label given a width and no height would be
			// zero pixels tall — a count that is there and cannot be read. Releasing the height is
			// what lets the definite width above stand without costing the label its line.
			count.AutomaticSize = Enum.AutomaticSize.Y;
			count.Parent = slot;

			slot.LayoutOrder = index;
			slot.Parent = row;
		}

		if (DEBUG) print(`[Vote] ${options.size()} option(s) offered`);
	}

	/**
	 * Send a vote, and arrange for the row to go away once the server has counted it.
	 *
	 * **Nothing is predicted here, and that is what shapes the hiding rather than the sending.** The button
	 * does not mark itself and the row does not vanish on the click, because the server is the only thing that
	 * knows whether the vote was counted: a window that had just closed, and a mode this build cannot run, are
	 * both refusals only it can make — and a row that hid on a refusal would have taken away the chance to
	 * answer at all. So the click sends, and {@link confirmVote} waits for the count.
	 *
	 * **This is where the row's feedback landed.** The note here used to say that feedback was deliberately
	 * absent; it is now the disappearance of the row, on the server's own evidence — the same fact the print
	 * below reports, and the only one available on this side of the wire.
	 */
	private cast(mode: GameModeId, status: Instance): void {
		if (DEBUG) print(`[Vote] voted for ${GAME_MODE_NAMES[mode]}`);

		this.getVoteRemote().SendToServer(mode);
		this.confirmVote(status, mode);
	}

	/**
	 * Takes the row away when this option's count goes up — the server saying the vote landed.
	 *
	 * **On the count rather than on the click**, for the reason {@link cast} gives: a refusal looks exactly
	 * like a vote until the count moves, and only one of the two should take the row away. The count arrives
	 * on the channel the figures beside the buttons are already reading, so this costs one connection and no
	 * new server behaviour.
	 *
	 * **One connection per click, and it lets go of itself.** `before` is captured so that an earlier count
	 * cannot hide the row, and the connection is disconnected the moment it has done its job — by hand rather
	 * than through a scope, because this is not tied to the life of any instance.
	 *
	 * **The race worth naming:** a count that rises because somebody *else* voted for the same option in the
	 * same instant would hide this row with this player's own vote possibly refused. Closing that needs a
	 * per-player acknowledgement from the server, which does not exist — the counts are the only answer the
	 * folder carries, and they are not attributed.
	 */
	private confirmVote(status: Instance, mode: GameModeId): void {
		const name = voteCountAttribute(mode);
		const before = countOf(status, name);

		const connection = status.GetAttributeChangedSignal(name).Connect(() => {
			if (countOf(status, name) <= before) return;

			connection.Disconnect();
			this.voted.set(true);
		});
	}

	private getVoteRemote(): ClientRemotes["castVote"] {
		if (!this.voteRemote) {
			this.voteRemote = events.Client.Get("castVote");
		}

		return this.voteRemote;
	}
}

/**
 * How many votes `id` has, as a `Value` a label can observe.
 *
 * **The same bridge the stat billboard uses**, and for the same reason: an attribute is how the
 * server publishes this and a Fusion state is the only thing a `Computed` can depend on —
 * `GetAttribute` read inside one is a reading taken once, not a dependency, so a label built
 * straight on it would be a label that never changed after its first frame. Seeded from the
 * attribute and kept live by its changed signal, the count follows the vote.
 *
 * The connection is handed to the scope, so it is cleaned up with the button it feeds rather than
 * outliving the row.
 */
function watchCount(scope: Fusion.Scope<unknown>, status: Instance, id: GameModeId): Fusion.Value<number> {
	const name = voteCountAttribute(id);
	const votes = Fusion.Value(scope, countOf(status, name));

	scope.push(status.GetAttributeChangedSignal(name).Connect(() => votes.set(countOf(status, name))));

	return votes;
}

/** A numeric attribute, or `0` — the count an option nobody has voted for has. */
function countOf(status: Instance, name: string): number {
	const raw = status.GetAttribute(name);

	return typeIs(raw, "number") ? raw : 0;
}
