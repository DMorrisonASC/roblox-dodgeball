import { Controller, OnStart } from "@flamework/core";
import Fusion from "@rbxts/fusion-3.0";
import { CollectionService, Players, ReplicatedStorage, Workspace } from "@rbxts/services";
import { UI_FONT } from "../../ui/hudTheme";
import { BADGES_ATTRIBUTE, NPC_TAG, ROUND_STATE_ATTRIBUTE, ROUND_STATUS_FOLDER } from "shared/constants";
import { BADGE_COLOURS, Badge, badgeById, decodeBadges } from "shared/badges";
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

/** The badge list inside that billboard, and the name of each row in it. */
const BADGE_LIST_NAME = "Badges";
const BADGE_ROW_NAME = "Badge";

/**
 * The two type sizes in a badge row, in pixels — **the name at the badge size and the description close under
 * it.**
 *
 * **Both came down on 2026-10-27, and the reason is the whole lesson of this file's last three passes.** The
 * sizes were `16` and `12` while the strip was the only thing above a head. Once a `BillboardGui` is drawn
 * *in the world*, its apparent size is a function of how close the camera is to that body — so the fix for "it
 * takes up too much space" is to make the text smaller rather than to make the box smaller, because the box is
 * not what anyone is looking at. `14` and `11` still read at conversational distance and cut roughly an
 * eighth off every row.
 *
 * **A ratio rather than two numbers.** A description is subordinate to its name: it is the same badge said
 * plainly, for somebody who could not decode the name, and it should read as one block with the name on top
 * rather than as two competing lines.
 */
const BADGE_NAME_SIZE = 14;
const BADGE_DESCRIPTION_SIZE = 11;

/** The gap between a badge's two lines, and between two badges, in pixels. **Placeholder.** */
const BADGE_LINE_GAP = 0;
const BADGE_ROW_GAP = 3;

/**
 * How much of the name's colour the description keeps, **as one number rather than a second palette.**
 *
 * **The contrast ratio, and it is a ratio on purpose.** The description is the same tone as its name — a rib
 * badge's explanation is not a different kind of rib badge — so it is the name's colour *dimmed*, and this is
 * how much of it survives: sixty-two per cent of each channel, which is about a third less luminance. Enough
 * that the two lines read as one badge and the eye goes to the name first; not so little that the sentence
 * disappears against a floor. **Placeholder** — chosen against a grey arena floor at the two sizes above.
 */
const BADGE_DESCRIPTION_CONTRAST = 0.62;

/**
 * The canvas above a head, in pixels — **a width for the text and nothing else.**
 *
 * **The width is the truncation width, which is all it has ever been.** Nothing here draws a background (see
 * `mountBadges` for why the opaque card is gone), so a billboard wider than its own line costs nothing while a
 * narrower one cuts the end off the longest description — a fifty-character sentence at
 * `BADGE_DESCRIPTION_SIZE`. `300` is that sentence at the smaller type with a little room.
 *
 * **The height is not a layout number and never was.** The strip is anchored to the canvas centre and drawn
 * *outside* this box on purpose — `ClipsDescendants` is `false`, see `makeBillboard` — so a taller canvas only
 * moves the anchor, and the anchor is the canvas' centre, which does not move at all. It stays at `40` because
 * it is the box nothing is drawn in.
 */
const BILLBOARD_SIZE = UDim2.fromOffset(300, 40);

/** How far above the head the canvas floats, in studs, and how far away it is still drawn. **Placeholder.** */
const BILLBOARD_OFFSET_Y = 2.5;
const BILLBOARD_MAX_DISTANCE = 100;

/**
 * **What is above a head between rounds**: the round's badges, drawn as letters over the world.
 *
 * **The badges are the whole of it, and the record used to be the other half.** A body's
 * `Hits: n | Outs: n | Ratio: n` line lived in this same billboard and was removed on 2026-10-27: the
 * numbers are on the kill cam's own card during a shot (`client/enemyView.ts`) and were, above a head, a
 * second copy nobody asked for. What is left is the thing no other surface carries — **what the round decided
 * about a body**.
 *
 * **No panel behind them, and this file spent three passes learning that.** Items 109–111 of `HANDOFF.md` put
 * an opaque white card behind this text twice, first behind the record and then behind the badges, and both
 * were withdrawn: a `BillboardGui` is drawn *in the world*, so a background's size is judged against a body
 * that is a different distance away from every viewer, and the card read as a slab with the text at its
 * bottom edge. **Letters and a halo are the right material for something drawn over an arena** — the size is
 * the type size, which is the one number this file can reason about — and `BADGE_COLOURS` exists to be legible
 * against a floor rather than against paper.
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
	 * **The badge rows** — one construction, shared by a player's head and a rig's.
	 *
	 * **No background, and the two passes that added one are the reason this paragraph exists.** Handoff items
	 * 109 and 110 put an opaque white card behind this list, first behind the record and then behind the badges.
	 * Both were asked for as a fix for legibility and both made something worse: **the card was a pale slab with
	 * the badge text bunched at its bottom edge and empty panel above it**, because the list measures its own
	 * height for its *rows* and the anchor pins its bottom to the canvas centre — so any space the layout
	 * reserved above the rows showed as blank card. A background drawn over a body is a surface whose size the
	 * viewer re-derives from their distance to that body; text drawn over a body is just text. Letters, a halo
	 * effect from the tone's colour and a screen-space card for anything that must be read like a scoreboard —
	 * that is the split this file now keeps.
	 *
	 * **Imperative rather than Fusion-hydrated, and this is the one place in the HUD that is.** A badge strip
	 * is a *list*: its length is whatever the server derived, from nought to twenty, and it changes at most
	 * twice a round. Fusion's job here would be a `For` over a `Value`, and the same result comes out of
	 * destroying the old rows and building new ones on the attribute's own signal. What that costs is that
	 * the rows are built with plain `Instance.new` rather than big-ui's `Text`: a `Text` is hydrated into a
	 * scope and cannot be un-hydrated, so rebuilding the list would collect one dead hydration per badge per
	 * change for the life of the session.
	 *
	 * ---
	 *
	 * **There is no per-row height in this file any more, and the arithmetic that used to be here is why it
	 * went.** A badge row was one line and the billboard was resized on every change — `rows × height + pad`,
	 * written by hand because a `BillboardGui` is a `LayerCollector` and has no `AutomaticSize`. A row is now
	 * **two** lines of different sizes, and the second line's height is the engine's answer to a font rather
	 * than a number this file can add up: the same sentence in two fonts is two heights, and a table of
	 * constants would be a guess that goes stale the day `UI_FONT` or a badge's wording changes.
	 *
	 * **So the layout measures itself and the billboard stopped resizing.** A row is a `Frame` with
	 * `AutomaticSize = Y` holding two `TextLabel`s that also size to their own text, stacked by a
	 * `UIListLayout`; the list is another `AutomaticSize` frame, anchored to its own bottom-centre and placed
	 * at the *centre* of the canvas, so it grows **upward** from the anchor instead of down over the body.
	 * The canvas itself stays at `BILLBOARD_SIZE` and the list draws outside it — `ClipsDescendants` is
	 * `false`, which is the property that allows exactly this and is set explicitly in `makeBillboard` rather
	 * than relied on as a default.
	 *
	 * **Growing upward is the other half of the fix, and it is not cosmetic.** The billboard is centred on its
	 * adornee, so a box that grows holds its centre and hangs half of its new height *below* the anchor —
	 * which for a six-badge strip is a label over the body it belongs to. Anchor the list's own bottom to the
	 * canvas centre and every row a body earns pushes the strip further **up**, never down.
	 *
	 * **What a wrapped description would have cost, which is why the lines truncate instead.** If a
	 * description wrapped to fit the width, a badge's height would depend on its wording — and then the
	 * strip's total height would depend on *which* badges fired, so the same body would be six tall rows one
	 * round and four short ones the next. One line each, truncated with an ellipsis at the right edge, keeps
	 * every row the same two lines and the strip's height a function of the count alone.
	 *
	 * **`source` is the instance the attribute lives on**, which is the `Player` for a player and the `Model`
	 * for a rig.
	 */
	private mountBadges(billboard: BillboardGui, source: Instance, scope: Fusion.Scope<unknown>): void {
		const list = new Instance("Frame");
		list.Name = BADGE_LIST_NAME;
		list.BackgroundTransparency = 1;
		list.BorderSizePixel = 0;
		// **Sized by its contents, and pinned by its bottom edge to the middle of the canvas.** The anchor is
		// what turns "grows" into "grows upward"; see this method's doc for why that matters more than it
		// looks.
		//
		// **The width is pixels rather than a scale of the canvas, and that is deliberate.** A `BillboardGui` is
		// a `LayerCollector`, not a `GuiObject`, and a child sized `1, 0` against one is asking the layout to
		// resolve a scale against a canvas that is not a frame — the rows would depend on that answer for their
		// width, and a wrong answer is invisible text rather than a broken build. One number, the canvas's own
		// width, keeps the strip exactly as wide as the box above it.
		list.AutomaticSize = Enum.AutomaticSize.Y;
		list.AnchorPoint = new Vector2(0.5, 1);
		list.Position = UDim2.fromScale(0.5, 0.5);
		list.Size = new UDim2(0, BILLBOARD_SIZE.X.Offset, 0, 0);
		list.Parent = billboard;

		const layout = new Instance("UIListLayout");
		layout.FillDirection = Enum.FillDirection.Vertical;
		layout.SortOrder = Enum.SortOrder.LayoutOrder;
		layout.HorizontalAlignment = Enum.HorizontalAlignment.Center;
		layout.VerticalAlignment = Enum.VerticalAlignment.Bottom;
		layout.Padding = new UDim(0, BADGE_ROW_GAP);
		layout.Parent = list;

		let rows: Frame[] = [];

		// **The whole of the display, and it no longer touches the billboard.** Everything the old version did
		// with arithmetic — how tall the box is, where the rows sit in it — is now the layout engine's, which
		// is the only thing that knows how tall a line of GothamBlack at two different sizes actually is.
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

			list.Visible = hasBadges;
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
 * **One badge as two lines: the name, and beneath it the sentence that explains it.**
 *
 * **A `Frame` per badge rather than two labels in the list**, so the `UIListLayout` stacks *badges* rather
 * than lines: two lists are impossible to keep in step, and one flat list of four labels for two badges would
 * have no idea which pair belonged together. The row is a transparent `Frame` with `AutomaticSize = Y` and its
 * own layout, which makes it exactly as tall as its two lines and the gap between them — the measurement the
 * old fixed row height was standing in for.
 *
 * **The description is the name's tone at `BADGE_DESCRIPTION_CONTRAST` of it.** Same hue, less of it: a rib
 * badge's explanation is not a different kind of rib badge, and a second palette for one field would be a
 * second thing to keep in step with the first.
 *
 * **Both lines truncate rather than wrap.** See `mountBadges` for what wrapping would have cost; the short
 * version is that a wrapped line makes a row's height depend on the sentence in it.
 */
function makeBadgeRow(badge: Badge): Frame {
	const row = new Instance("Frame");
	row.Name = BADGE_ROW_NAME;
	row.BackgroundTransparency = 1;
	row.AutomaticSize = Enum.AutomaticSize.Y;
	row.Size = new UDim2(1, 0, 0, 0);

	const layout = new Instance("UIListLayout");
	layout.FillDirection = Enum.FillDirection.Vertical;
	layout.SortOrder = Enum.SortOrder.LayoutOrder;
	layout.HorizontalAlignment = Enum.HorizontalAlignment.Center;
	layout.Padding = new UDim(0, BADGE_LINE_GAP);
	layout.Parent = row;

	const colour = BADGE_COLOURS[badge.tone];
	const dimmed = new Color3(
		colour.R * BADGE_DESCRIPTION_CONTRAST,
		colour.G * BADGE_DESCRIPTION_CONTRAST,
		colour.B * BADGE_DESCRIPTION_CONTRAST,
	);

	const name = makeBadgeLine("Name", badge.name, BADGE_NAME_SIZE, colour, 1);
	name.Parent = row;

	const description = makeBadgeLine("Description", badge.description, BADGE_DESCRIPTION_SIZE, dimmed, 2);
	description.Parent = row;

	return row;
}

/** One line of a badge row: centred, one line, truncated at the right edge, and as tall as its own text. */
function makeBadgeLine(name: string, text: string, size: number, colour: Color3, order: number): TextLabel {
	const label = new Instance("TextLabel");
	label.Name = name;
	label.BackgroundTransparency = 1;
	// **The height is the text's**, which is what makes a row two measured lines rather than a constant.
	label.AutomaticSize = Enum.AutomaticSize.Y;
	label.Size = new UDim2(1, 0, 0, 0);
	label.Font = UI_FONT;
	label.TextSize = size;
	label.Text = text;
	label.TextColor3 = colour;
	label.TextXAlignment = Enum.TextXAlignment.Center;
	label.TextYAlignment = Enum.TextYAlignment.Center;
	label.TextWrapped = false;
	label.TextTruncate = Enum.TextTruncate.AtEnd;
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
 * nothing has a `BillboardGui` with a hidden list in it, which is one transparent instance rather than a
 * second visibility rule on one head.
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
	// **The canvas is a fixed box and the content is allowed to leave it, which is what lets the badge strip
	// grow without the billboard being resized.** `ClipsDescendants` on a `BillboardGui` is the switch for
	// exactly this — "whether portions of GuiObjects that fall outside the canvas borders will be drawn" —
	// and it is written here rather than left to its default because the whole layout depends on it: a strip
	// anchored to the canvas centre grows upward, out of a box that stays one line tall.
	billboard.ClipsDescendants = false;
	billboard.Parent = head;

	Fusion.Hydrate(scope, billboard)({
		Enabled: Fusion.Computed(scope, (use) => use(state) === INTERMISSION),
	});

	return billboard;
}
