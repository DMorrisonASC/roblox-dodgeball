import { Controller, OnStart } from "@flamework/core";
import Fusion from "@rbxts/fusion-3.0";
import { CollectionService, Players, ReplicatedStorage, Workspace } from "@rbxts/services";
import { hudTheme, UI_FONT } from "../../ui/hudTheme";
import { BADGES_ATTRIBUTE, NPC_TAG, ROUND_STATE_ATTRIBUTE, ROUND_STATUS_FOLDER } from "shared/constants";
import { Badge, badgeById, decodeBadges } from "shared/badges";
import { logDebug, logWarn } from "shared/logger";

/** The phase a billboard is shown in. A word between two files, not a setting. */
const INTERMISSION = "Intermission";

/**
 * What the billboard is called, so a stray one can be told from anything else on a head.
 *
 * **The instance name and the class name are both historical now** — this file drew a hits/outs record
 * beside the badges until 2026-10-27 and draws only the badges since. The names are kept rather than changed
 * because they are what the class is called in `HANDOFF.md`, in five other files' comments and in the owner's
 * own words ("I still see the `StatsBillboardController` over my head"); a rename is a manifest diff and a
 * hundred comment edits that buy nothing a reader cannot get from this note.
 */
const BILLBOARD_NAME = "StatsBillboard";

/**
 * **The part a billboard hangs on, and how long anything here waits for it.**
 *
 * **A limit rather than `WaitForChild(name)`, and the log that forced it is worth reading before removing
 * it.** `WaitForChild` with no timeout yields *for ever*, and the mount path calls this file's attach methods
 * from one thread — a `for` over `CollectionService.GetTagged(NPC_TAG)`. On 2026-10-19 a server retired a rig
 * (a player joined and took its seat) a fraction of a second before the client's walk reached it, so
 * `PixelPhantom23:WaitForChild("Head")` never returned: **Studio printed `Infinite yield possible`, the walk
 * stopped there, and everything after it in `mount` never ran** — the added-signal that gives every later rig
 * a billboard, and the `[HUD] badge strips up` line itself. The visible cost was every rig spawned after
 * that moment having no billboard at all, with nothing in the output saying why. A body that a server can
 * destroy mid-walk is ordinary, so the wait must be bounded and the body skipped.
 *
 * **Five seconds, which is long enough to be a wait and short enough to be a skip.** A character's `Head` is
 * there within a frame or two of `CharacterAdded`, and a cloned rig's is there at the clone — the only bodies
 * this can time out on are ones that are not coming. **Placeholder.**
 */
const HEAD_NAME = "Head";
const HEAD_WAIT_SECONDS = 5;

/** The card, the badge list inside it, and the name of each row. */
const CARD_NAME = "Card";
const BADGE_LIST_NAME = "Badges";
const BADGE_ROW_NAME = "Badge";

/**
 * The two type sizes in a badge row, in pixels — **the name larger than the description, which is the only
 * hierarchy the card has.** Both lines are the same ink by request, so size and face are what separate the badge
 * from its explanation: `14` in the project's heavy face for the name, `11` in a medium weight for the sentence
 * under it. **Placeholder.**
 */
const BADGE_NAME_SIZE = 14;
const BADGE_DESCRIPTION_SIZE = 11;

/**
 * The two faces — **the project's own heavy face for a name, and one weight down for the sentence under it.**
 *
 * **A second face is the only hierarchy a one-colour card can offer**, and it is the difference between a badge
 * and a caption of it: `UI_FONT` is `GothamBlack`, which is right for two or three words and smears at eleven
 * pixels across forty. `GothamMedium` at `BADGE_DESCRIPTION_SIZE` stays legible and still reads as subordinate.
 * The alternative — dimming the description's colour — was the old design and does not survive on white paper,
 * where a dimmed black is grey mush and a dimmed `#F2F2F2` is invisible.
 */
const DESCRIPTION_FONT = Enum.Font.GothamMedium;

/** The gap between a badge's two lines, and between two badges, in pixels. **Placeholder.** */
const BADGE_LINE_GAP = 1;
const BADGE_ROW_GAP = 6;

/** The card's inner padding, in pixels, on all four sides. **Placeholder — 8.** */
const CARD_PADDING = 8;

/**
 * **The canvas the card lives on — deliberately much larger than the card, and the size is not a layout number.**
 *
 * The card sizes itself (`AutomaticSize.XY`) and is pinned to the centre of this box by its own anchor, so the
 * canvas only ever needs to be *big enough*: it never clips (`ClipsDescendants = false`) and a card smaller than
 * the canvas you can see is the only thing that draws. **`400` is a ceiling rather than a target** — a strip of
 * four badges is about a hundred pixels wide — and stating it as a square is what lets the centre be written as
 * `(0.5, 0.5)` in `mountBadges` rather than as two halves of two different numbers.
 *
 * **What it costs**: a `BillboardGui`'s canvas is centred on the adornee, so a taller canvas does not lift the
 * card — the card is centred in it, which means the *card's* centre sits `BILLBOARD_OFFSET_Y` above the head. A
 * strip tall enough to reach the face is answered by raising {@link BILLBOARD_OFFSET_Y}, not by shifting the card
 * inside the canvas.
 */
const BILLBOARD_SIZE = UDim2.fromOffset(400, 400);

/** How far above the head the canvas floats, in studs, and how far away it is still drawn. **Placeholder.** */
const BILLBOARD_OFFSET_Y = 2.5;
const BILLBOARD_MAX_DISTANCE = 100;

/**
 * **What is above a head between rounds**: the round's badges, on a white card.
 *
 * **The badges are the whole of it, and the record used to be the other half.** A body's
 * `Hits: n | Outs: n | Ratio: n` line lived in this same billboard and was removed on 2026-10-27: the
 * numbers are on the kill cam's own card during a shot (`client/enemyView.ts`) and were, above a head, a
 * second copy nobody asked for. What is left is the thing no other surface carries — **what the round decided
 * about a body**.
 *
 * **The card is back, and what was wrong with the first two was the layout rather than the idea.** Items 109–111
 * put white paper behind this text twice and withdrew it twice, because both attempts used a bottom-anchored,
 * self-sizing list inside a canvas whose size it did not know. The card that replaced them is the textbook one —
 * `AutomaticSize.XY` on a frame pinned to the centre of an oversized canvas, a `UIPadding`, and rows that size
 * themselves — and **the two hazards that broke the earlier attempts are written down where they bite**: in
 * `mountBadges` (no scale-width rows inside an X-auto parent) and in `makeBadgeRow` (`Top`, never `Bottom` or
 * `Center`, in a frame that sizes itself).
 *
 * **Black on white, with no tone at all.** `BADGE_COLOURS` — the neon palette written for lettering over an
 * arena — is not read here any more: it is a table for a dark surface, and on paper `neutral` (`#F2F2F2`) is nine
 * units from the page. The tone still exists in `shared/badges.ts` and still decides whether a set is published
 * (see `BadgeService`'s rib rule); what it no longer does is choose an ink.
 *
 * **Badges are something you read while nothing is happening.** During a round the strip would be a label
 * in the way of the thing it describes, so the whole billboard is switched off while a round can be played and
 * back on when it ends. That is the one moment a player has to look at anybody else's round, and the moment
 * they are standing still in a lobby.
 *
 * **It reads an attribute and computes nothing that the server could have computed.** Which badges a body
 * earned is decided server-side and published as ids on `BADGES_ATTRIBUTE`, so the two machines cannot
 * disagree about what a round was; this decides only how to draw it. Nothing here is sent, asked for, or
 * reconciled.
 *
 * **A rig wears a badge strip too.** A rig has no stats record — which is why losing one cost this file
 * nothing — and it gets the same strip a player does, read off the model where a player's is read off the
 * `Player`.
 *
 * **Every scope is per body and torn down with it.** A player's billboard is mounted on `CharacterAdded` and
 * cleaned on `CharacterRemoving`; a rig's is cleaned when the model leaves `Workspace`, which is how a
 * rebuilt rig takes its old strip with it.
 */
@Controller()
export class StatsBillboardController implements OnStart {
	public onStart(): void {
		// Mounted rather than built inline: the round's status folder is made by `RoundService`, and
		// waiting for it can yield — so `onStart` is the wrong place to hold the rest of the boot up
		// for something another machine has not made yet. The same shape, and the same reason, as
		// every other HUD controller here.
		task.spawn(() => this.mount());
	}

	private mount(): void {
		const folder = ReplicatedStorage.WaitForChild(ROUND_STATUS_FOLDER) as Folder;

		const scope = Fusion.scoped();

		// The phase, as a `Value` rather than read where it is needed: a `Computed` has to be able to
		// *watch* this, and `GetAttribute` inside one is a reading taken once rather than a dependency.
		const state = Fusion.Value(scope, stateOf(folder));

		scope.push(
			folder.GetAttributeChangedSignal(ROUND_STATE_ATTRIBUTE).Connect(() => state.set(stateOf(folder))),
		);

		scope.push(Players.PlayerAdded.Connect((player) => this.watch(player, state, scope)));

		// A player already in the game when this mounted never fires the added-signal, so the ones
		// already here are walked rather than waited for — the scan-and-subscribe the other services
		// and HUDs do, for the same reason.
		for (const player of Players.GetPlayers()) this.watch(player, state, scope);

		// **Rigs wear the badge strip the same way a player does, and this is the rig half of the same watch.**
		// The rigs are found by tag rather than by watching `Workspace`, the same read
		// `RigAnimationController` makes and for the same reason, and the attribute is read off the *model* —
		// where a player's is read off the `Player`, and where `CROWN_ATTRIBUTE` used to be read for this half.
		// Both those facts have the same shape and the same reason: the attribute outlives a body.
		// **Each rig is mounted on its own thread, and this is the second half of the same fix.** The walk
		// used to call `attachRig` inline, so one body that never produced a `Head` held the loop — and,
		// behind it, the tag-added connection and the line below, which is how a single retired rig cost the
		// whole session its strips. A thread per body means the worst case is one body skipped after
		// `HEAD_WAIT_SECONDS`, and the rest of the mount continues immediately.
		for (const instance of CollectionService.GetTagged(NPC_TAG)) {
			if (!instance.IsA("Model")) continue;

			task.spawn(() => this.attachRig(instance, state, scope));
		}

		scope.push(
			CollectionService.GetInstanceAddedSignal(NPC_TAG).Connect((instance) => {
				if (instance.IsA("Model")) this.attachRig(instance, state, scope);
			}),
		);

		logDebug(`[HUD] badge strips up — ${Players.GetPlayers().size()} players`);
	}

	/** Gives `player` a billboard above every body they get, for as long as they are in the game. */
	private watch(player: Player, state: Fusion.Value<string>, parent: Fusion.Scope<unknown>): void {
		player.CharacterAdded.Connect((character) => this.attach(character, player, state, parent));
	}

	/**
	 * Mounts a badge billboard on `character`'s head.
	 *
	 * **A scope of its own for each body, torn down with it.** The computed below is bound to the
	 * billboard that is destroyed when the character is — but a computed is *not* destroyed by the
	 * instance it writes to, and a scope belonging to the controller would collect one pair per
	 * respawn for the life of the session. An inner scope is destroyed either by its owner or by the
	 * scope it came from, so a respawn takes its own down and leaves nothing behind.
	 */
	private attach(
		character: Model,
		player: Player,
		state: Fusion.Value<string>,
		parent: Fusion.Scope<unknown>,
	): void {
		// Waited for rather than found: a character is announced before its parts have all arrived,
		// and a head that is not there yet is a billboard with nowhere to go. **Bounded**, because a
		// character can also be taken away before its head arrives — a death into a respawn, a leaver —
		// and an unbounded wait would hold the thread that mounts it. See `HEAD_WAIT_SECONDS`.
		if (character.Parent === undefined) {
			logDebug(`[HUD] ${player.Name}: character gone before its billboard — skipped`);

			return;
		}

		const head = character.WaitForChild(HEAD_NAME, HEAD_WAIT_SECONDS);
		if (head === undefined || !head.IsA("BasePart")) {
			logWarn(`[HUD] ${player.Name}: no ${HEAD_NAME} on the character — no billboard for this body`);

			return;
		}

		const scope = Fusion.innerScope(parent);

		// **Pushed into the scope it tears down, which is the fix for an error this used to print on every
		// death.** The connection was made and forgotten, so it outlived the cleanup it performs: the body it
		// belonged to was gone, but the handler was still attached to the *player*, and it therefore ran again
		// on every later removal — cleaning a scope that had already been cleaned. That is Fusion's
		// `poisonedScope` followed by a stack of `destroyedTwice` lines, once per respawn, for the rest of the
		// session. A connection held by the scope is disconnected when the scope is cleaned, so the handler
		// cannot outlive the body it was made for.
		scope.push(player.CharacterRemoving.Connect(() => Fusion.doCleanup(scope)));

		const billboard = makeBillboard(head, state, scope);

		// **And the badges, which are now the whole of what is drawn.** The hits/outs record that used to share
		// this billboard is gone: the figures are on the kill cam's card during a shot, and above a head they
		// were a second copy of a number nobody was asking for. See this file's header for the two passes that
		// tried to style it and why both were withdrawn.
		this.mountBadges(billboard, player, scope);
	}

	/**
	 * Mounts a badge strip on a rig's head.
	 *
	 * **The rig half of the same strip a player wears.** The attribute is read off the *model* (the server
	 * writes `BADGES_ATTRIBUTE` on the rig's body, where it writes it on the `Player` for a player), and the
	 * billboard is the same construction {@link makeBillboard} makes for a player. Cleaned up when the rig
	 * leaves the world — destroyed by `RespawnBehavior`, or taken out of `Workspace` — the same signal
	 * `RigAnimationController` uses for the same reason, and the same one the crown used before it.
	 *
	 * **An intermission with no badges draws an empty `BillboardGui` above a rig's head.** That is one
	 * transparent instance for the length of a lobby, and the alternative — hiding the billboard itself —
	 * would mean two visibility rules on one head, one for the phase and one for the content, which is how a
	 * rig's strip ends up visible during a round.
	 */
	private attachRig(model: Model, state: Fusion.Value<string>, parent: Fusion.Scope<unknown>): void {
		// **A body that is already gone is skipped without waiting for anything.** This is the observed case
		// rather than a hypothetical: the tag walk returned `PixelPhantom23` after the server had already retired
		// it (a player joined and took its seat), so there was no `Head` to wait for and never would be.
		// `Destroy` clears `Parent`, so this is an exact test — and it is worth having beside the timeout,
		// because it costs nothing where the timeout costs five seconds.
		if (model.Parent === undefined) {
			logDebug(`[HUD] ${model.Name}: gone before its billboard — skipped`);

			return;
		}

		// **The line that hung the whole controller, and the reason this is a bounded wait.** A rig can be
		// destroyed by the server between the tag walk reading it and this line running — a player joining
		// takes a seat and `LobbyRigService` retires the rig in it — and `WaitForChild` with no timeout then
		// yields for ever. That is `Infinite yield possible on 'PixelPhantom23:WaitForChild("Head")'` in the
		// log of 2026-10-19, and it left every rig spawned afterwards without a billboard, because the thread
		// it stalled was the one that still had to connect the tag-added signal. A skipped body is a body
		// that was going away; a stalled thread is the whole feature.
		const head = model.WaitForChild(HEAD_NAME, HEAD_WAIT_SECONDS);
		if (head === undefined || !head.IsA("BasePart")) {
			logWarn(`[HUD] ${model.Name}: no ${HEAD_NAME} — no badge strip for this body`);

			return;
		}

		const scope = Fusion.innerScope(parent);

		scope.push(
			model.AncestryChanged.Connect(() => {
				if (!model.IsDescendantOf(Workspace)) Fusion.doCleanup(scope);
			}),
		);

		const billboard = makeBillboard(head, state, scope);

		this.mountBadges(billboard, model, scope);
	}

	/**
	 * **The card and the badge rows on it** — one construction, shared by a player's head and a rig's.
	 *
	 * **The layout is the standard self-sizing one, and saying it in three lines is the point.** A `Frame` with
	 * `AutomaticSize.XY`, pinned to the centre of the canvas by `AnchorPoint (0.5, 0.5)`, holding a `UIPadding`
	 * and a vertical list; rows and lines that size themselves; `VerticalAlignment.Top` at both levels. The card is
	 * then exactly as large as its contents plus its padding, and it grows outwards from its own centre. There is
	 * no arithmetic in this function and no number that has to agree with a font.
	 *
	 * **Two hazards, both of which broke earlier versions of this card, and both are avoided by construction:**
	 *
	 * 1. **Nothing inside an `AutomaticSize.X` parent is sized by scale.** A row at `Size = (1, 0, 0, 0)` inside a
	 *    card that is asking its children how wide it should be is a circular question, and the engine's answer is
	 *    a row with no width — so every row and every line here is `AutomaticSize.XY` and the list centres them.
	 * 2. **Every layout in a self-sizing frame is `Top`.** `Bottom` (the previous badge card) and the default
	 *    `Center` (the previous rows) both need the frame's height in order to place children, while the frame's
	 *    height is the children — so the arrangement settles a frame late. That is what made text overlap and the
	 *    last line hang past the card's edge.
	 *
	 * **Imperative rather than Fusion-hydrated, and this is the one place in the HUD that is.** A badge strip
	 * is a *list*: its length is whatever the server derived, from nought to twenty, and it changes at most
	 * twice a round. Fusion's job here would be a `For` over a `Value`, and the same result comes out of
	 * destroying the old rows and building new ones on the attribute's own signal. What that costs is that
	 * the rows are built with plain `Instance.new` rather than big-ui's `Text`: a `Text` is hydrated into a
	 * scope and cannot be un-hydrated, so rebuilding the list would collect one dead hydration per badge per
	 * change for the life of the session.
	 *
	 * **`source` is the instance the attribute lives on**, which is the `Player` for a player and the `Model`
	 * for a rig.
	 */
	private mountBadges(billboard: BillboardGui, source: Instance, scope: Fusion.Scope<unknown>): void {
		// **The one surface in this file, and the theme's paper rather than a literal** — so the card is the same
		// white as every panel in the game, and moving the palette moves it. `BackgroundTransparency = 0` is the
		// point of the element: the arena behind a head is whatever is happening in it, and text over that is
		// unreadable at exactly the moment — the end of a round — when there is something to read.
		const card = new Instance("Frame");
		card.Name = CARD_NAME;
		card.BackgroundColor3 = hudTheme().colors.panel;
		card.BackgroundTransparency = 0;
		card.BorderSizePixel = 0;
		card.AnchorPoint = new Vector2(0.5, 0.5);
		card.Position = UDim2.fromScale(0.5, 0.5);
		card.AutomaticSize = Enum.AutomaticSize.XY;
		card.Parent = billboard;

		const padding = new Instance("UIPadding");
		padding.PaddingTop = new UDim(0, CARD_PADDING);
		padding.PaddingBottom = new UDim(0, CARD_PADDING);
		padding.PaddingLeft = new UDim(0, CARD_PADDING);
		padding.PaddingRight = new UDim(0, CARD_PADDING);
		padding.Parent = card;

		const list = new Instance("Frame");
		list.Name = BADGE_LIST_NAME;
		list.BackgroundTransparency = 1;
		list.BorderSizePixel = 0;
		// **Auto-sized on both axes, and no width of its own**: the card asks the list how big it is, so the list
		// must be able to answer without being told. See hazard 1 in this method's doc.
		list.AutomaticSize = Enum.AutomaticSize.XY;
		list.Parent = card;

		const layout = new Instance("UIListLayout");
		layout.FillDirection = Enum.FillDirection.Vertical;
		layout.SortOrder = Enum.SortOrder.LayoutOrder;
		layout.HorizontalAlignment = Enum.HorizontalAlignment.Center;
		// **`Top` because this frame sizes itself** — see hazard 2. The card is what makes the strip appear to grow
		// upward: the card is centred on the canvas and the canvas on the head, so rows added at the top push the
		// card's centre up by half their height.
		layout.VerticalAlignment = Enum.VerticalAlignment.Top;
		layout.Padding = new UDim(0, BADGE_ROW_GAP);
		layout.Parent = list;

		let rows: Frame[] = [];

		const show = (ids: string[]): void => {
			for (const row of rows) row.Destroy();

			rows = [];

			for (const id of ids) {
				const badge = badgeById(id);
				if (badge === undefined) continue;

				const row = makeBadgeRow(badge);
				row.Parent = list;

				rows.push(row);
			}

			const hasBadges = rows.size() > 0;

			// **The line that answers "the badges were not shown" without a second round trip.** Every
			// failure this feature can have looks identical from a player's chair — nothing above the head —
			// and the three candidates are "the server never wrote", "the client never heard about it" and
			// "the client heard about ids it cannot name". One line per body per change separates them: a
			// count of nought against a non-empty attribute is the third, and no line at all is the second.
			logDebug(`[HUD] ${source.Name}: ${rows.size()} of ${ids.size()} badge(s) drawn`);

			// **The card is what hides, not the list.** The list is transparent, so hiding it while leaving the card
			// visible would show an empty white box above a body that earned nothing — which is the one failure this
			// feature can produce that looks worse than having no feature at all.
			card.Visible = hasBadges;
		};

		const read = (): string[] => {
			const value = source.GetAttribute(BADGES_ATTRIBUTE);

			return typeIs(value, "string") ? decodeBadges(value) : [];
		};

		show(read());

		scope.push(source.GetAttributeChangedSignal(BADGES_ATTRIBUTE).Connect(() => show(read())));
	}
}

/**
 * **One badge as two lines inside the card: the name, and beneath it the sentence that explains it.**
 *
 * **A `Frame` per badge rather than two labels in the list**, so the `UIListLayout` stacks *badges* rather
 * than lines: two lists are impossible to keep in step, and one flat list of four labels for two badges would
 * have no idea which pair belonged together.
 *
 * **The row and its lines are all `AutomaticSize.XY`, and the row has no `Size`.** It is inside a card that asks
 * its children how big it should be, so a row at `Size = (1, 0, 0, 0)` would be asking for a percentage of an
 * answer that does not exist yet — the engine resolves that as a zero-width row. Auto on both axes means the row
 * is exactly its widest line, the card is exactly its widest row, and the list centres the shorter rows on it.
 *
 * **`Top` at both layouts, because both frames size themselves.** `Bottom` and the default `Center` need the
 * frame's height in order to place children against it, and the height is a function of those children; the
 * arrangement then settles a frame late, which is what made the two earlier cards' text overlap and their last
 * line hang past the bottom edge.
 *
 * **Both lines are the same ink and the hierarchy is size and weight**, which is the only hierarchy a one-colour
 * card has. The name is the project's heavy face at `BADGE_NAME_SIZE`; the description is the same family one
 * weight down at `BADGE_DESCRIPTION_SIZE`, so a full sentence does not smear.
 */
function makeBadgeRow(badge: Badge): Frame {
	const row = new Instance("Frame");
	row.Name = BADGE_ROW_NAME;
	row.BackgroundTransparency = 1;
	row.AutomaticSize = Enum.AutomaticSize.XY;

	const layout = new Instance("UIListLayout");
	layout.FillDirection = Enum.FillDirection.Vertical;
	layout.SortOrder = Enum.SortOrder.LayoutOrder;
	layout.HorizontalAlignment = Enum.HorizontalAlignment.Center;
	layout.VerticalAlignment = Enum.VerticalAlignment.Top;
	layout.Padding = new UDim(0, BADGE_LINE_GAP);
	layout.Parent = row;

	const ink = hudTheme().colors.textPrimary;

	const name = makeBadgeLine("Name", badge.name, BADGE_NAME_SIZE, UI_FONT, ink, 1);
	name.Parent = row;

	const description = makeBadgeLine(
		"Description",
		badge.description,
		BADGE_DESCRIPTION_SIZE,
		DESCRIPTION_FONT,
		ink,
		2,
	);
	description.Parent = row;

	return row;
}

/** One line of a badge row: centred, one line, and exactly as large as its own text. */
function makeBadgeLine(
	name: string,
	text: string,
	size: number,
	font: Enum.Font,
	colour: Color3,
	order: number,
): TextLabel {
	const label = new Instance("TextLabel");
	label.Name = name;
	label.BackgroundTransparency = 1;
	// **Both axes are the text's**, for the reason `makeBadgeRow` gives: nothing inside an `AutomaticSize.X` parent
	// can be sized by scale. `TextWrapped` is off for the older reason — a wrapped line would make a card's height
	// depend on a badge's wording — and there is no `TextTruncate` because an auto-sized label has no width to
	// truncate against: the card grows to the longest sentence instead, which is what a card that hugs its text
	// means.
	label.AutomaticSize = Enum.AutomaticSize.XY;
	label.Font = font;
	label.TextSize = size;
	label.Text = text;
	label.TextColor3 = colour;
	label.TextXAlignment = Enum.TextXAlignment.Center;
	label.TextYAlignment = Enum.TextYAlignment.Center;
	label.TextWrapped = false;
	label.LayoutOrder = order;

	return label;
}

/** The phase `folder` is publishing, or `""` while it has not said. */
function stateOf(folder: Instance): string {
	const state = folder.GetAttribute(ROUND_STATE_ATTRIBUTE);

	return typeIs(state, "string") ? state : "";
}

/**
 * **The one `BillboardGui` this file hangs on a head**, for either kind of body.
 *
 * **Built here rather than at each caller**, because a player's head and a rig's head get the same box: the
 * same name, the same offset, the same distance cut-off, and the same phase gate. The two paths differ in
 * nothing else now that the record is gone, which makes a second construction a second place for the
 * "occluded, not drawn through walls" decision to be forgotten.
 *
 * **`Enabled` is the phase and only the phase.** The billboard is on screen for the whole intermission and off
 * during a round; the *contents* are what change, and `mountBadges` is what changes them. A body that earned
 * nothing has a `BillboardGui` whose card is hidden — one instance rather than a second visibility rule on one
 * head.
 */
function makeBillboard(head: BasePart, state: Fusion.Value<string>, scope: Fusion.Scope<unknown>): BillboardGui {
	const billboard = new Instance("BillboardGui");
	billboard.Name = BILLBOARD_NAME;
	billboard.Adornee = head;
	billboard.Size = BILLBOARD_SIZE;
	billboard.StudsOffsetWorldSpace = new Vector3(0, BILLBOARD_OFFSET_Y, 0);
	// **Occluded rather than drawn through the world.** This is a label about a body standing in
	// the map, not a marker on a screen: somebody behind a wall is somebody you cannot read, and a
	// scoreboard that floated through geometry would be showing the numbers of a player who could
	// be anywhere.
	billboard.AlwaysOnTop = false;
	billboard.MaxDistance = BILLBOARD_MAX_DISTANCE;
	// **The canvas is deliberately far larger than the card, and it never clips.** The card sizes itself and is
	// centred on this box by its own anchor, so the canvas is a ceiling rather than a container — the only thing
	// that draws is the card. `ClipsDescendants` is written explicitly rather than left to its default because the
	// whole arrangement depends on that answer: a card that outgrew the canvas would be cut in half by a property
	// nobody looked at. See `BILLBOARD_SIZE`.
	billboard.ClipsDescendants = false;
	billboard.Parent = head;

	Fusion.Hydrate(scope, billboard)({
		Enabled: Fusion.Computed(scope, (use) => use(state) === INTERMISSION),
	});

	return billboard;
}
