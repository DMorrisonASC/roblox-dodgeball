import { Controller, OnStart } from "@flamework/core";
import { Text } from "@rbxts/big-ui";
import Fusion from "@rbxts/fusion-3.0";
import { CollectionService, Players, ReplicatedStorage, Workspace } from "@rbxts/services";
import { HudTheme, UI_FONT, hudTheme } from "../../ui/hudTheme";
import { STATS_CONFIG } from "shared/config/stats.config";
import { BADGES_ATTRIBUTE, NPC_TAG, ROUND_STATE_ATTRIBUTE, ROUND_STATUS_FOLDER, STAT_HITS, STAT_OUTS } from "shared/constants";
import { BADGE_COLOURS, Badge, badgeById, decodeBadges } from "shared/badges";

/** Prints once, when the billboards are up — the line that says the controller ran at all. */
const DEBUG = false; // off for frame time — see shared/config/debug.config.ts

/** The phase a billboard is shown in. A word between two files, not a setting. */
const INTERMISSION = "Intermission";

/** What the billboard is called, so a stray one can be told from anything else on a head. */
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
 * a billboard, and the `[HUD] stats billboards up` line itself. The visible cost was every rig spawned after
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
 * The two type sizes in a badge row, in pixels — **the name at the badge size and the description at three
 * quarters of it.**
 *
 * **A ratio rather than two numbers.** A description is subordinate to its name: it is the same badge said
 * plainly, for somebody who could not decode the name, and it should read as one block with the name on top
 * rather than as two competing lines. Three quarters is small enough to be visibly secondary at arm's length
 * and large enough to be legible above a body — the step down from `caption` to the size under it, which is
 * the same relationship `hudTheme` uses between a heading and its body text.
 */
const BADGE_NAME_SIZE = 16;
const BADGE_DESCRIPTION_SIZE = 12;

/** The gap between a badge's two lines, and between two badges, in pixels. **Placeholder.** */
const BADGE_LINE_GAP = 1;
const BADGE_ROW_GAP = 5;

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
 * The canvas above a head, in pixels — **one box for both contents, and its width is now the badges' rather
 * than the record's.**
 *
 * **Wide enough for the longest line either content can hold, not for a typical one.** Nothing but the text
 * is drawn — no label has a background — so a billboard wider than its own line costs a clip rectangle and
 * nothing else, while one narrower cuts the end off it. The record's line
 * (`Hits: 999 | Outs: 999 | Ratio: 1.00`) is a little over three hundred pixels at caption size; the longest
 * badge *description* is a fifty-character sentence at `BADGE_DESCRIPTION_SIZE`, which is wider still, so the
 * width is sized for the longer of the two and the record simply has room to spare.
 *
 * **The height is the record's, and the badges ignore it.** Forty pixels holds one line of caption text —
 * which is the whole of the in-play record — and the badge strip is drawn *outside* this box on purpose; see
 * `mountBadges` and `billboard.ClipsDescendants` in `makeBillboard`.
 */
const BILLBOARD_SIZE = UDim2.fromOffset(380, 40);

/**
 * **What is above a head between rounds**: the round's badges, or the player's own record.
 *
 * **The badge strip is the new thing here, and it owns the slot whenever it has anything to say.** The
 * server derives a set of badges at `finishRound` and publishes them on `BADGES_ATTRIBUTE`; while that set
 * is non-empty this billboard draws one row per badge, and when it is empty — at the start, and again when
 * the fifteen-second window closes — the hit-and-out record comes back for the rest of the intermission.
 * **One billboard, two contents**, because they are one slot: two `BillboardGui`s on one head would be two
 * labels in the same place at the same time, which is what "stacked" means in practice.
 *
 * **A record is something you read while nothing is happening.** During a round it would be a label
 * in the way of the thing it describes — and a ratio that moved mid-round would be a number to watch
 * instead of the ball — so the whole billboard is switched off while a round can be played and back on when
 * it ends. That is the one moment a player has to look at anybody else's numbers, and the moment they
 * are standing still in a lobby.
 *
 * **It reads attributes and computes nothing that the server could have computed.** The counts, the ratio
 * and the badges are all published server-side, so the two machines cannot disagree about what a round was;
 * this decides only how to draw it. Nothing here is sent, asked for, or reconciled.
 *
 * **A rig wears a badge strip too, and it is the half of this file that did not exist before.** A rig has no
 * stats record, so for a long time the only thing hung above a rig's head was the crown. The crown is
 * retired — `CROWN_ATTRIBUTE` is unchanged and still drives `EconomyService.checkMilestones`, but the visual
 * is replaced by the `onFire` badge — and a rig now gets the same strip a player does, read off the model
 * where a player's is read off the `Player`. The tag walk that finds the rigs is the one this file already
 * made for the crown, so no new tag is involved and `TAGS.md` is untouched.
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

		// **The HUD's colours, read once with the rest of the mount and handed to every body below.**
		// Read now rather than at module load, for the reason `hudTheme` gives: `configureTheme` has run
		// by the time anything mounts, and a value captured earlier would be Material's default. Read
		// here rather than in `attach`, even though that is where it is painted, because the theme is
		// fixed for the session — there is nothing about a respawn that would change it.
		const theme = hudTheme();

		// The phase, as a `Value` rather than read where it is needed: a `Computed` has to be able to
		// *watch* this, and `GetAttribute` inside one is a reading taken once rather than a dependency.
		const state = Fusion.Value(scope, stateOf(folder));

		scope.push(
			folder.GetAttributeChangedSignal(ROUND_STATE_ATTRIBUTE).Connect(() => state.set(stateOf(folder))),
		);

		scope.push(Players.PlayerAdded.Connect((player) => this.watch(player, state, scope, theme)));

		// A player already in the game when this mounted never fires the added-signal, so the ones
		// already here are walked rather than waited for — the scan-and-subscribe the other services
		// and HUDs do, for the same reason.
		for (const player of Players.GetPlayers()) this.watch(player, state, scope, theme);

		// **Rigs wear the badge strip the same way a player does, and this is the rig half of the same watch.**
		// The rigs are found by tag rather than by watching `Workspace`, the same read
		// `RigAnimationController` makes and for the same reason; a rig has no stats record, so its billboard
		// is badges and nothing else, and it is read off the *model* — where a player's is read off the
		// `Player`, and where `CROWN_ATTRIBUTE` used to be read for this half. Both those facts have the same
		// shape and the same reason: the attribute outlives a body.
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

		if (DEBUG) print(`[HUD] stats billboards and badge strips up — ${Players.GetPlayers().size()} players`);
	}

	/** Gives `player` a billboard above every body they get, for as long as they are in the game. */
	private watch(
		player: Player,
		state: Fusion.Value<string>,
		parent: Fusion.Scope<unknown>,
		theme: HudTheme,
	): void {
		player.CharacterAdded.Connect((character) => this.attach(character, player, state, parent, theme));
	}

	/**
	 * Mounts a stat billboard on `character`'s head.
	 *
	 * **A scope of its own for each body, torn down with it.** The two computeds below are bound to a
	 * label that is destroyed when the character is — but a computed is *not* destroyed by the
	 * instance it writes to, and a scope belonging to the controller would collect one pair per
	 * respawn for the life of the session. An inner scope is destroyed either by its owner or by the
	 * scope it came from, so a respawn takes its own down and leaves nothing behind.
	 *
	 * The `Text` is big-ui's, so this label reads the same theme as every other piece of the HUD —
	 * see `ThemeController`, which configures it before any of this mounts. The theme arrives as a
	 * parameter rather than being read here, so that the HUD reads its colours exactly once, in
	 * `mount`, and this method cannot disagree with the rest of the file about them.
	 */
	private attach(
		character: Model,
		player: Player,
		state: Fusion.Value<string>,
		parent: Fusion.Scope<unknown>,
		theme: HudTheme,
	): void {
		// Waited for rather than found: a character is announced before its parts have all arrived,
		// and a head that is not there yet is a billboard with nowhere to go. **Bounded**, because a
		// character can also be taken away before its head arrives — a death into a respawn, a leaver —
		// and an unbounded wait would hold the thread that mounts it. See `HEAD_WAIT_SECONDS`.
		if (character.Parent === undefined) {
			if (DEBUG) print(`[HUD] ${player.Name}: character gone before its billboard — skipped`);

			return;
		}

		const head = character.WaitForChild(HEAD_NAME, HEAD_WAIT_SECONDS);
		if (head === undefined || !head.IsA("BasePart")) {
			warn(`[HUD] ${player.Name}: no ${HEAD_NAME} on the character — no billboard for this body`);

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

		// The two counts as watchable states, so the line below follows them rather than sampling them
		// once. Per body, and in the body's own scope — the connections they hold belong to this head.
		const hits = watchCount(scope, player, STAT_HITS);
		const outs = watchCount(scope, player, STAT_OUTS);

		const label = Text(scope, {
			text: Fusion.Computed(scope, (use) => describe(use(hits), use(outs))),
			variant: "caption",
			align: Enum.TextXAlignment.Center,
		});

		// **The theme's colour, painted onto the instance rather than asked for as a prop.** big-ui's
		// `color` is not a `Color3` — it is its own nine-word vocabulary (`"primary" | "secondary" |
		// "disabled" | "primaryMain" | …`) which the component resolves against its own palette, so a
		// `Color3` handed to it is a type error and would be ignored at runtime in favour of the
		// default. `TextColor3` on the label that `Text` returns *is* a `Color3`, which is where a
		// colour from `hudTheme` belongs. Leaving the prop off would give the same colour, because
		// big-ui's default is `Palette.text.primary`; the assignment is here so the choice is visible
		// and so moving to another theme colour is one word rather than a discovery.
		label.TextColor3 = theme.colors.onAccent;
		label.Parent = billboard;

		// **And the badges, which take the slot whenever they have something to say.** The record is not a
		// second billboard: the two are one slot and one head, and the only thing that changes is what is
		// drawn in it. `label` is handed over so the switch can hide it.
		this.mountBadges(billboard, player, label, scope);
	}

	/**
	 * Mounts a badge strip on a rig's head, **and nothing else — a rig has no stats record to draw.**
	 *
	 * **The rig half of the same strip a player wears.** The attribute is read off the *model* (the server
	 * writes `BADGES_ATTRIBUTE` on the rig's body, where it writes it on the `Player` for a player), and the
	 * billboard is the same construction {@link makeBillboard} makes for a player. Cleaned up when the rig
	 * leaves the world — destroyed by `RespawnBehavior`, or taken out of `Workspace` — the same signal
	 * `RigAnimationController` uses for the same reason, and the same one the crown used before it.
	 *
	 * **A rig's billboard has no stats fallback**, so an intermission with no badges draws an empty
	 * `BillboardGui` above its head. That is one transparent instance for the length of a lobby, and the
	 * alternative — hiding the billboard itself — would mean two visibility rules on one head, one for the
	 * phase and one for the content, which is how a rig's strip ends up visible during a round.
	 */
	private attachRig(model: Model, state: Fusion.Value<string>, parent: Fusion.Scope<unknown>): void {
		// **A body that is already gone is skipped without waiting for anything.** This is the observed case
		// rather than a hypothetical: the tag walk returned `PixelPhantom23` after the server had already retired
		// it (a player joined and took its seat), so there was no `Head` to wait for and never would be.
		// `Destroy` clears `Parent`, so this is an exact test — and it is worth having beside the timeout,
		// because it costs nothing where the timeout costs five seconds.
		if (model.Parent === undefined) {
			if (DEBUG) print(`[HUD] ${model.Name}: gone before its billboard — skipped`);

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
			warn(`[HUD] ${model.Name}: no ${HEAD_NAME} — no badge strip for this body`);

			return;
		}

		const scope = Fusion.innerScope(parent);

		scope.push(
			model.AncestryChanged.Connect(() => {
				if (!model.IsDescendantOf(Workspace)) Fusion.doCleanup(scope);
			}),
		);

		const billboard = makeBillboard(head, state, scope);

		this.mountBadges(billboard, model, undefined, scope);
	}

	/**
	 * **The badge rows, and the switch between them and the record** — one construction, shared by a player's
	 * head and a rig's.
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
	 * for a rig. **`stats` is passed only by the player path**: it is the label to hide while badges are up,
	 * and a rig has none.
	 */
	private mountBadges(
		billboard: BillboardGui,
		source: Instance,
		stats: TextLabel | undefined,
		scope: Fusion.Scope<unknown>,
	): void {
		const list = new Instance("Frame");
		list.Name = BADGE_LIST_NAME;
		list.BackgroundTransparency = 1;
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
			if (DEBUG) print(`[HUD] ${source.Name}: ${rows.size()} of ${ids.size()} badge(s) drawn`);

			list.Visible = hasBadges;
			if (stats !== undefined) stats.Visible = !hasBadges;
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

/**
 * The record as the one line above a head.
 *
 * **Every figure is named, and the names are what make it readable from across an arena.** A row of
 * bare numbers above somebody else's head is a small puzzle to be solved while looking at it;
 * `Hits:`, `Outs:` and `Ratio:` are read without being worked out, which is the whole job of a
 * label drawn above every player in the game.
 *
 * Nothing is abbreviated and nothing is implied. The line is long for a reason, and it is the reason
 * the billboard it sits in is as wide as it is — see {@link BILLBOARD_SIZE}.
 */
function describe(hits: number, outs: number): string {
	const counted = hits + outs;
	const ratio = counted === 0 ? 0 : hits / counted;

	return `Hits: ${hits} | Outs: ${outs} | Ratio: ${string.format("%.2f", ratio)}`;
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
 * what is drawn *inside* it and nothing else, so a second construction would be a second place for the
 * "occluded, not drawn through walls" decision to be forgotten.
 *
 * **`Enabled` is the phase and only the phase.** The billboard is on screen for the whole intermission — it
 * carries the badge strip for the first fifteen seconds and the record for the rest — and off during a round.
 * The content is what changes, and `mountBadges` is what changes it.
 */
function makeBillboard(head: BasePart, state: Fusion.Value<string>, scope: Fusion.Scope<unknown>): BillboardGui {
	const billboard = new Instance("BillboardGui");
	billboard.Name = BILLBOARD_NAME;
	billboard.Adornee = head;
	billboard.Size = BILLBOARD_SIZE;
	billboard.StudsOffsetWorldSpace = new Vector3(0, STATS_CONFIG.BILLBOARD_OFFSET_Y, 0);
	// **Occluded rather than drawn through the world.** This is a label about a body standing in
	// the map, not a marker on a screen: somebody behind a wall is somebody you cannot read, and a
	// scoreboard that floated through geometry would be showing the numbers of a player who could
	// be anywhere.
	billboard.AlwaysOnTop = false;
	billboard.MaxDistance = STATS_CONFIG.BILLBOARD_MAX_DISTANCE;
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

/**
 * The phase as a `Value`, so a `Computed` can watch it.
 *
 * **The bridge between two channels.** Attributes are how the server publishes this, and a Fusion
 * state is the only thing a `Computed` can depend on — `GetAttribute` read inside one is a value
 * taken once, not a dependency, so a label built straight on it would be a label that never changed
 * after its first frame. Fed from the changed-signal, it is live.
 */
function watchCount(scope: Fusion.Scope<unknown>, player: Player, name: string): Fusion.Value<number> {
	const state = Fusion.Value(scope, countOf(player, name));

	scope.push(player.GetAttributeChangedSignal(name).Connect(() => state.set(countOf(player, name))));

	return state;
}

/** A numeric attribute, or `0` — the count a player with nothing recorded has. */
function countOf(player: Player, name: string): number {
	const value = player.GetAttribute(name);

	return typeIs(value, "number") ? value : 0;
}
