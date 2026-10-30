import { Controller, OnStart } from "@flamework/core";
import Fusion from "@rbxts/fusion-3.0";
import { CollectionService, Players, ReplicatedStorage, Workspace } from "@rbxts/services";
import { UI_FONT } from "../../ui/hudTheme";
import { lightPanelTheme } from "../../ui/lightPanelTheme";
import { ELEVATION } from "../../ui/elevation";
import { BADGES_ATTRIBUTE, NPC_TAG, ROUND_STATE_ATTRIBUTE, ROUND_STATUS_FOLDER } from "shared/constants";
import { Badge, badgeById, badgeLabel, decodeBadges } from "shared/badges";
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

/** The stack inside the canvas, and the name of each card in it. */
const BADGE_LIST_NAME = "Badges";
const BADGE_ROW_NAME = "Badge";

/**
 * The two type sizes on a badge card, in pixels — **the name larger than the description, which is the only
 * hierarchy the card has.** `14` in the project's heavy face for the name, `11` in a medium weight for the sentence
 * under it. **Placeholder.**
 *
 * **The inks are now two, and that is the shop's split rather than a change of mind about hierarchy**: the name sits
 * on a near-black band in the band's own white (`onAccent`), and the description sits on the card's paper in
 * `textSecondary`. Until this pass both lines were the same ink and size and face alone separated them — see the
 * `DESCRIPTION_FONT` note, which is where that argument lives and where it was answered.
 */
const BADGE_NAME_SIZE = 14;
const BADGE_DESCRIPTION_SIZE = 11;

/**
 * The two faces — **the project's own heavy face for a name, and one weight down for the sentence under it.**
 *
 * **`UI_FONT` is `GothamBlack`, which is right for two or three words on a band and smears at eleven pixels across
 * forty**, so the description is `GothamMedium` at `BADGE_DESCRIPTION_SIZE`.
 *
 * **The note that used to live here argued the opposite about ink, and its conclusion is worth keeping.** It said
 * *"the alternative — dimming the description's colour — was the old design and does not survive on white paper,
 * where a dimmed black is grey mush"*, and that is still true **of a dimmed `textPrimary`**: half of `#141414` on
 * `#FFFFFF` is a grey nobody chose. What this pass does instead is take the shop's own second ink —
 * `lightPanelTheme().colors.textSecondary`, `#4A4A4A`, a grey chosen *for* white paper and used for every status
 * line in the Shop and Inventory — rather than deriving one by transparency. The objection was to deriving the
 * colour, not to having one.
 */
const DESCRIPTION_FONT = Enum.Font.GothamMedium;

/** The gap between a badge's two lines, and between two cards, in pixels. **Placeholder.** */
const BADGE_LINE_GAP = 1;
const BADGE_ROW_GAP = 6;

/**
 * A badge card's inner padding, in pixels, on all four sides. **Placeholder — 6** (it was `8` while one card held
 * the whole stack).
 *
 * **A different number from {@link BADGE_ROW_GAP} because they are different spaces.** This one is the air between
 * a card's edge and its own ink; the card gap is the distance between two *cards*. One number for both would make a
 * stack whose internal air and external gaps are equal, which reads as one long panel divided by hairlines rather
 * than as a stack of separate cards — the thing this element is.
 */
const CARD_PADDING = 6;

/**
 * A card's corner radius, in pixels. **Placeholder — 6, which is the shop's own small-surface radius.**
 *
 * `panelChrome.addPill` rounds a pill at `UDim.new(0, 6)` and the sheet at a larger radius of its own; a badge card
 * is billboard-scale furniture, so it takes the pill's number rather than the sheet's. **Copied rather than
 * imported**: the constant is local to `panelChrome` and importing a whole panel module into a head billboard for
 * one number would be a coupling nobody could justify. Same value, both files, and this note is the thread between
 * them.
 */
const CARD_CORNER_RADIUS = 6;

/**
 * The name band's inner padding, in pixels. **Placeholder — 6 across, 2 down.**
 *
 * The band is the shop's `trough` material around the name, and its padding is what makes a two-word badge a band
 * rather than a filled rectangle that happens to be text-shaped. Wider than it is tall because a band's height is
 * already set by the type's line height.
 */
const BAND_PADDING_X = 6;
const BAND_PADDING_Y = 2;

/**
 * The hairline's thickness, in pixels. **Placeholder — 1.**
 *
 * `1` is the whole of it: this is the edge that says where a card ends on a white arena, and a second pixel would
 * be a border. The colour is the theme's `border` job, which exists for exactly this — see {@link mountBadges}.
 */
const CARD_STROKE_THICKNESS = 1;

/**
 * **The canvas the cards live on — deliberately much larger than they are, and the size is not a layout number.**
 *
 * The stack sizes itself (`AutomaticSize.XY`) and is pinned *horizontally* to the centre of this box and
 * *vertically* by its bottom edge — see {@link mountBadges} — so the canvas only ever needs to be *big enough*: it
 * never clips (`ClipsDescendants = false`) and a stack smaller than the canvas you can see is the only thing that
 * draws. **`400` is a ceiling rather than a target** — a strip of four badges is about a hundred pixels wide — and
 * stating it as a square is what lets the pin be written as `(0.5, 0.5)` in `mountBadges` rather than as two halves
 * of two different numbers.
 *
 * **The offset units are the whole of "fixed size", and this number is where that rests.** Roblox's own reference
 * for `BillboardGui` states the difference in one sentence: *"While the **offset** components work the same, the
 * **scale** components are used as stud sizes in 3D space."* So an offset canvas is a **screen-space box that does
 * not change size with distance** — the same fact `catchPrompt`'s box and `practiceCountdown`'s digits are built on
 * — and a scale one would be a sign fixed in studs that shrinks on screen as the camera pulls back. **The pair
 * matters and neither half is sufficient**: the canvas must be offset *and* no label inside it may use
 * `TextScaled`, because a scaled label would grow and shrink with the canvas's own box. This file is offset
 * everywhere and `TextScaled` nowhere, which is what makes the strip the same size at ten studs and at ninety.
 *
 * **What it costs, and this paragraph used to argue for the arrangement that produced the bug.** A `BillboardGui`'s
 * canvas is centred on the adornee, so a taller canvas does not lift the stack — and because the stack *was* centred
 * in the canvas, every card that arrived pushed half its height **downwards** as well as up. A body carrying six or
 * seven badges therefore wore the bottom three over its own chest and face: the owner's screenshot of 2026-10-28 is
 * exactly that, and the note that used to stand here — "a strip tall enough to reach the face is answered by raising
 * `BILLBOARD_OFFSET_Y`" — was answering the symptom, because raising the offset lifts the *centre* and leaves the
 * same half-hanging shape above the head.
 *
 * **The stack is now pinned by its bottom edge to the canvas's vertical centre** (`AnchorPoint (0.5, 1)` in
 * `mountBadges`), so it can only ever grow upward: the cards are entirely above the adornee point whatever the stack's
 * length, and {@link BILLBOARD_OFFSET_Y} is now the *whole* of the clearance between a head and the lowest card rather
 * than the position of a centre. The canvas's lower half goes unused; it is kept because a symmetric box is what lets
 * the pin be one scale pair, and an asymmetric one would need a pixel offset that had to agree with a stud offset —
 * the "constant that has to agree with something else" this file refuses everywhere else.
 */
const BILLBOARD_SIZE = UDim2.fromOffset(400, 400);

/**
 * **How far above the head the canvas's centre floats, in studs — which since the stack is bottom-pinned is the
 * clearance from a head to the lowest card.** And how far away the billboard is still drawn. **Placeholder.**
 *
 * **The two numbers are no longer the same kind of thing, and the doc used to read as though they were.** The offset
 * places the canvas, and the stack's bottom edge sits at the canvas's centre (see `BILLBOARD_SIZE`), so `2.5` is the
 * air between the middle of a `Head` and the bottom of the first card: about `1.9` studs of it once the head's own
 * half-height and a hat are subtracted. A default `Head` is roughly `1.2` studs tall, so this clears a bare head and
 * clears hair; it is *not* sized for a tall accessory, and **raising this one number is now the only correct way to
 * ask for more room** — raising it moves the pin, and nothing else does.
 */
const BILLBOARD_OFFSET_Y = 2.5;
const BILLBOARD_MAX_DISTANCE = 100;

/**
 * **What is above a head between rounds**: the round's badges, one white card each.
 *
 * **The badges are the whole of it, and the record used to be the other half.** A body's
 * `Hits: n | Outs: n | Ratio: n` line lived in this same billboard and was removed on 2026-10-27: the
 * numbers are on the kill cam's caption during a shot (`client/enemyView.ts`) and were, above a head, a
 * second copy nobody asked for. What is left is the thing no other surface carries — **what the round decided
 * about a body**.
 *
 * **The card is back, and what was wrong with the first two was the layout rather than the idea.** Items 109–111
 * put white paper behind this text twice and withdrew it twice, because both attempts used a bottom-anchored,
 * self-sizing list inside a canvas whose size it did not know. The card that replaced them is the textbook one —
 * `AutomaticSize.XY` on a frame pinned to the centre of an oversized canvas, a `UIPadding`, and rows that size
 * themselves — and **the two hazards that broke the earlier attempts are written down where they bite**: in
 * `mountBadges` (no scale-width rows inside an X-auto parent) and in `makeBadgeCard` (`Top`, never `Bottom` or
 * `Center`, in a frame that sizes itself).
 *
 * **That sentence's "bottom-anchored" and item 134's bottom pin are two different mechanisms, and the distinction is
 * the whole of why one failed and the other does not.** What items 109–111 did was a `UIListLayout` with
 * `VerticalAlignment = Bottom` — a *layout pass* that needs the frame's height in order to place children while the
 * frame's height is the children, so it settled a frame late (hazard 2). What pins the strip now is the frame's own
 * `AnchorPoint.Y = 1`, which is a render transform applied after layout and reads no height at all. Same word, two
 * different stages of the frame, and only the layout one is a hazard.
 *
 * **There is one card *per badge* now, and the single card that held the stack is gone.** Until this pass a white
 * `Frame` held a `UIPadding` and a transparent list, and the badges inside it were rows on that one sheet. **The
 * user's request was "each badge in a different card instead of stacked into one", and it is a change of material
 * rather than of layout**: the stack no longer has a surface of its own, every `Badge` frame carries its own paper,
 * corner, hairline and shadow, and the space between two badges is now a gap between two objects rather than
 * padding inside one. The two numbers that make it read that way are different on purpose — {@link CARD_PADDING}
 * is the air inside a card and {@link BADGE_ROW_GAP} is the distance between cards.
 *
 * **§15 item 112 said "a card is the material for a screen-space panel", and this pass is where that sentence is
 * answered rather than ignored.** It was the right conclusion about the wrong thing: what item 112 had actually
 * found was that a card on a **stud-scaled** canvas has an apparent size that is a function of camera distance, so
 * no padding value survives it. **A card on an offset canvas has no such problem** — the canvas is a fixed pixel
 * box, the card inside it is a fixed pixel box, and the shadow and hairline are fixed pixels too. The rule is one
 * rule with two halves: **offset `Size`, and no `TextScaled` anywhere inside.** Either alone still misbehaves — a
 * scaled canvas with fixed text is a sign that shrinks, and an offset canvas with `TextScaled` text is a box that
 * stays put while its letters breathe. This file is offset throughout and `TextScaled` nowhere, and
 * `BILLBOARD_SIZE` carries the quotation from Roblox's reference that settles it.
 *
 * **This is the seventh pass at this element and it should be the last for a while.** §15 items 109–113 went around
 * it five times — a card added, moved, deleted, restored, and a `VerticalAlignment` fixed — and each pass answered
 * a complaint about the *element* with a different element. Item 125 fixed the shape (fixed-pixel cards on a
 * fixed-pixel canvas); the two after it are the ones the user asked for once the shape was right — item 126 is the
 * *words* (names title-cased and compound-split) and this pass is the *materials* (the Shop's palette). **Nothing
 * since 125 has moved the shape.**
 * **From here, a complaint about this strip should be a complaint about its content** — a card too tall, a sentence
 * too long, a gap too tight — and that is a number in this file, not another shape for the element.
 *
 * **Black on white, with no tone at all — and now the Shop's black on the Shop's white.** `BADGE_COLOURS` — the neon
 * palette written for lettering over an arena — is not read here any more: it is a table for a dark surface, and on
 * paper `neutral` (`#F2F2F2`) is nine units from the page. The tone still exists in `shared/badges.ts` and still
 * decides whether a set is published (see `BadgeService`'s rib rule); what it no longer does is choose an ink.
 *
 * **The palette is `lightPanelTheme()` rather than `hudTheme()`, and that is the last change made to this element.**
 * The Shop and Inventory are drawn from the literal printable-paper palette, and the user asked for the badges to
 * follow their art style; the badge card now uses the same jobs those panels do — `panel` sheet, `trough` band,
 * `onAccent` ink on the band, `textSecondary` sentence, `border` hairline. `hudTheme()` would have been *nearly* the
 * same colours through a table `configureTheme` can move, and "nearly, until somebody re-themes big-ui" is not what
 * consistency means. See `makeBadgeCard` for the construction and for the two places a badge card deliberately
 * differs from a shop *tile*.
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
	 * **The stack of badge cards** — one construction, shared by a player's head and a rig's.
	 *
	 * **The self-sizing element is the list, and there is no surface under it.** A `Frame` with `AutomaticSize.XY`,
	 * pinned by its **bottom edge** to the canvas's vertical centre by `AnchorPoint (0.5, 1)`, holding a vertical
	 * `UIListLayout` whose children are cards; each card sizes itself and each line inside a card sizes itself. The
	 * list is then exactly as tall as its cards and its gaps. There is no arithmetic in this function and no number
	 * that has to agree with a font.
	 *
	 * **Bottom-pinned rather than centred, and that anchor is the fix for "it is covering parts of the body".** A
	 * centred list grows in both directions from its own centre, so on a body wearing six badges the lower three sat
	 * over the chest — the canvas is fixed pixels and does not care how many cards arrive. Pinned by its bottom, a
	 * card can only lengthen the list *upward*, so the strip is always entirely above the head and its distance from
	 * the head is `BILLBOARD_OFFSET_Y` and nothing else. The frame's `AnchorPoint` is a render transform rather than a
	 * layout pass, so this costs none of the one-frame settling that hazard 2 is about.
	 *
	 * **It used to be a card with rows on it, and the difference is one `Frame`'s background.** The wrapper had
	 * paper and a `UIPadding`, so every badge was a row on one sheet and the space between two badges was padding
	 * *inside* that sheet. Both of those moved into the card: the wrapper is transparent and unpadded, and the
	 * paper, the corner, the hairline and the shadow belong to each `Badge` — see {@link makeBadgeCard}. That is
	 * what "each badge in its own card" means as code rather than as intent, and it is why {@link CARD_PADDING}
	 * and {@link BADGE_ROW_GAP} are two numbers rather than one.
	 *
	 * **Two hazards, both of which broke earlier versions of this element, and both are avoided by construction:**
	 *
	 * 1. **Nothing inside an `AutomaticSize.X` parent is sized by scale.** A card at `Size = (1, 0, 0, 0)` inside a
	 *    stack that is asking its children how wide it should be is a circular question, and the engine's answer is
	 *    a card with no width — so every card and every line here is `AutomaticSize.XY` and the list centres them.
	 *    **The cost is visible and it is the right one**: a card's width is its own longest line, so a two-word
	 *    badge is a narrow card centred on the stack rather than a column of equal widths. Equal widths need either
	 *    the scale-width child above or `TextBounds` arithmetic over three labels, and this file refuses both — a
	 *    constant that has to agree with a font is the number that goes stale the first time the face changes.
	 * 2. **Every layout in a self-sizing frame is `Top`.** `Bottom` (a previous badge card) and the default
	 *    `Center` (previous rows) both need the frame's height in order to place children, while the frame's
	 *    height is the children — so the arrangement settles a frame late. That is what made text overlap and the
	 *    last line hang past the card's edge.
	 *
	 * **Imperative rather than Fusion-hydrated, and this is the one place in the HUD that is.** A badge strip
	 * is a *list*: its length is whatever the server derived, from nought to twenty, and it changes at most
	 * twice a round. Fusion's job here would be a `For` over a `Value`, and the same result comes out of
	 * destroying the old cards and building new ones on the attribute's own signal. What that costs is that
	 * the cards are built with plain `Instance.new` rather than big-ui's `Text`: a `Text` is hydrated into a
	 * scope and cannot be un-hydrated, so rebuilding the list would collect one dead hydration per badge per
	 * change for the life of the session.
	 *
	 * **`source` is the instance the attribute lives on**, which is the `Player` for a player and the `Model`
	 * for a rig.
	 */
	private mountBadges(billboard: BillboardGui, source: Instance, scope: Fusion.Scope<unknown>): void {
		// **No surface here, and that is this pass's change rather than an omission.** The paper is on each card;
		// a background here would be a sheet behind a stack of cards, which is the arrangement that was replaced.
		const list = new Instance("Frame");
		list.Name = BADGE_LIST_NAME;
		list.BackgroundTransparency = 1;
		list.BorderSizePixel = 0;
		// **The horizontal centring the wrapper used to do, and the vertical pin that replaced its centring.** The
		// list is the element that sizes itself, so it is the one that has to be placed by its own anchor: `(0.5, 1)`
		// puts the list's **bottom** edge on the canvas's centre, which is the point `BILLBOARD_OFFSET_Y` lifts off the
		// head — so the strip grows upward and never reaches the body. See `BILLBOARD_SIZE` for what centring cost.
		list.AnchorPoint = new Vector2(0.5, 1);
		list.Position = UDim2.fromScale(0.5, 0.5);
		// **Auto-sized on both axes, and no width of its own**: the canvas shows whatever the list turns out to be,
		// so the list must be able to answer without being told. See hazard 1 in this method's doc.
		list.AutomaticSize = Enum.AutomaticSize.XY;
		list.Parent = billboard;

		const layout = new Instance("UIListLayout");
		layout.FillDirection = Enum.FillDirection.Vertical;
		layout.SortOrder = Enum.SortOrder.LayoutOrder;
		layout.HorizontalAlignment = Enum.HorizontalAlignment.Center;
		// **`Top` because this frame sizes itself** — see hazard 2. It is also what keeps the growth on one side: the
		// bottom edge is the pinned one, so children arranged from the top push the frame's *top* up by the height of
		// whatever was added, and nothing is ever laid out below the pin.
		layout.VerticalAlignment = Enum.VerticalAlignment.Top;
		// **The gap *between* cards**, which is a different space from the padding inside one. See `CARD_PADDING`.
		layout.Padding = new UDim(0, BADGE_ROW_GAP);
		layout.Parent = list;

		let cards: Frame[] = [];

		const show = (ids: string[]): void => {
			for (const card of cards) card.Destroy();

			cards = [];

			for (const id of ids) {
				const badge = badgeById(id);
				if (badge === undefined) continue;

				const card = makeBadgeCard(badge);
				card.Parent = list;

				cards.push(card);
			}

			const hasBadges = cards.size() > 0;

			// **The line that answers "the badges were not shown" without a second round trip.** Every
			// failure this feature can have looks identical from a player's chair — nothing above the head —
			// and the three candidates are "the server never wrote", "the client never heard about it" and
			// "the client heard about ids it cannot name". One line per body per change separates them: a
			// count of nought against a non-empty attribute is the third, and no line at all is the second.
			logDebug(`[HUD] ${source.Name}: ${cards.size()} of ${ids.size()} badge(s) drawn`);

			// **The list is what hides, and it is now the only thing that can.** The wrapper this replaced was
			// hidden rather than the list, because hiding a transparent list would have left an empty white box
			// above a body that earned nothing. There is no wrapper and no surface to leave behind any more — the
			// cards are the list's children, so hiding the list hides them all and shows nothing at all.
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
 * **One badge as its own card, in the Shop and Inventory's palette and materials.**
 *
 * **What the card is now, and why it changed.** Until this pass the card was the HUD's own white panel with two
 * black lines on it, and the user's note on it was that the badges would be *"more consistent if they follow the art
 * style of SHOP and INVENTORY"*. Those two panels are the game's printable-paper surfaces — `lightPanelTheme()`, the
 * palette whose doc calls itself *"a printable white sheet with black ink"* — and their unit is a **tile**: a grey
 * `card` face, a near-black `trough` name bar with white `onAccent` lettering on it, and a `textSecondary` status
 * line. So a badge card is now built from those exact jobs: white `panel` sheet, a `trough` band carrying the badge's
 * name in `onAccent`, the sentence under it in `textSecondary`, one `border` hairline around the sheet.
 *
 * **The band hugs the name rather than spanning the card, and that is a layout constraint worth stating.** A
 * shop tile's name bar is `(1, 0)` wide because the tile's width comes from the grid's cell size. A badge card has
 * no grid: it sizes itself to its own text, so a scale-width child would be asking for a fraction of an answer that
 * does not exist yet — the hazard `mountBadges` records, and what broke two earlier attempts at this element. The
 * band is therefore `AutomaticSize.XY` and centred, which reads as a printed label on the sheet rather than as a
 * bar across it. **Descriptions stay one line** (`TextWrapped` is off, see `badgeLine`), so the card is as wide as
 * its sentence; a full-width bar would need a fixed card width and a wrapped description, and
 * `shared/badges.ts` argues against wrapping a sentence.
 *
 * **Every colour is the pop-ups' palette rather than a literal, and that is the whole of "consistent".** `panel` is
 * the sheet, `trough` is the band, `onAccent` is the ink on the band, `textSecondary` is the sentence, `border` is
 * the hairline — the theme names that job *"a hairline between two light surfaces"* — and `shadow` is the cast.
 * Moving the shop's palette moves the badges with it, which is the property the two surfaces are supposed to share.
 *
 * **The two deviations from a shop tile, both because a card here has no sheet or grid behind it.** A tile carries
 * **no outline and no shadow** — the panel's own sheet owns both, one shadow per panel — while a badge card floats in
 * the world with nothing behind it, so it takes the *sheet's* hairline and a `CARD`-level shadow of its own. One
 * shadow per object is the same rule the shop states; each badge is its own object out here.
 *
 * **The shadow is built with `Instance.new` rather than with `elevation.addElevation`, and that is this file's rule
 * rather than a preference.** `addElevation` is a `Fusion.New`, which hydrates into a scope and cannot be
 * un-hydrated — so calling it from a list that is *rebuilt on every badge change* would collect one dead scope
 * entry per card per change for the life of the session, which is the exact hazard the doc on {@link mountBadges}
 * refuses for big-ui's `Text`. What is *not* duplicated is the depth itself: the blur, offset and transparency are
 * `ELEVATION.CARD` and the colour is `theme.colors.shadow`, so there is still one table that decides how raised a
 * card is.
 *
 * **The card and its band are `AutomaticSize.XY`, and neither has a `Size`.** The card is inside a stack that asks
 * its children how big it should be, so a card at `Size = (1, 0, 0, 0)` would be asking for a percentage of an
 * answer that does not exist yet — the engine resolves that as a zero-width card. Auto on both axes means the card
 * is exactly its widest line plus its padding, and the list centres the narrower cards on it.
 *
 * **`Top` at both layouts, because both frames size themselves.** `Bottom` and the default `Center` need the
 * frame's height in order to place children against it, and the height is a function of those children; the
 * arrangement then settles a frame late, which is what made the two earlier cards' text overlap and their last
 * line hang past the bottom edge.
 *
 * **The hierarchy is now material as well as type**: the name is white on near-black and the sentence is grey on
 * white, which is the shop's own contrast pair rather than two sizes of the same ink.
 */
function makeBadgeCard(badge: Badge): Frame {
	const theme = lightPanelTheme();

	const card = new Instance("Frame");
	card.Name = BADGE_ROW_NAME;
	// **The shop's sheet, and the theme's rather than a literal** — a card is now the same paper as a pop-up, which
	// is the point of the pass. `BackgroundTransparency = 0` still matters for the older reason: the arena behind a
	// head is whatever is happening in it, and text over that is unreadable at exactly the moment — the end of a
	// round — when there is something to read.
	card.BackgroundColor3 = theme.colors.panel;
	card.BackgroundTransparency = 0;
	card.BorderSizePixel = 0;
	card.AutomaticSize = Enum.AutomaticSize.XY;

	const corner = new Instance("UICorner");
	corner.CornerRadius = new UDim(0, CARD_CORNER_RADIUS);
	corner.Parent = card;

	// **The air inside the card**, as distinct from the gap between two cards. See `CARD_PADDING`.
	const padding = new Instance("UIPadding");
	padding.PaddingTop = new UDim(0, CARD_PADDING);
	padding.PaddingBottom = new UDim(0, CARD_PADDING);
	padding.PaddingLeft = new UDim(0, CARD_PADDING);
	padding.PaddingRight = new UDim(0, CARD_PADDING);
	padding.Parent = card;

	const stroke = new Instance("UIStroke");
	stroke.Color = theme.colors.border;
	stroke.Thickness = CARD_STROKE_THICKNESS;
	// **`Border` rather than `Contextual`**, which is the only place in the HUD that names this mode: `Contextual`
	// strokes a `TextLabel`'s letters and a `Frame`'s edge, which is right for one and wrong for the other. This
	// card has no letters of its own, so the two agree today — the write is here so that it still says what it
	// means if a line ever moves onto the frame.
	stroke.ApplyStrokeMode = Enum.ApplyStrokeMode.Border;
	stroke.Parent = card;

	const shadow = new Instance("UIShadow");
	shadow.Color = theme.colors.shadow;
	shadow.BlurRadius = new UDim(0, ELEVATION.CARD.blur);
	shadow.Offset = new UDim2(0, 0, 0, ELEVATION.CARD.offsetY);
	shadow.Spread = new UDim2(0, 0, 0, 0);
	shadow.Transparency = ELEVATION.CARD.transparency;
	shadow.ShowBehindParent = true;
	shadow.Parent = card;

	const layout = new Instance("UIListLayout");
	layout.FillDirection = Enum.FillDirection.Vertical;
	layout.SortOrder = Enum.SortOrder.LayoutOrder;
	layout.HorizontalAlignment = Enum.HorizontalAlignment.Center;
	layout.VerticalAlignment = Enum.VerticalAlignment.Top;
	layout.Padding = new UDim(0, BADGE_LINE_GAP);
	layout.Parent = card;

	// **The name band: the shop's `trough` material around the name.** A `trough` in this project is *"the band on a
	// tile"* — the one place that carries white ink in the light design — so the badge's name wears the same pair the
	// shop's tile names wear: near-black behind, white on it.
	const band = new Instance("Frame");
	band.Name = "Band";
	band.BackgroundColor3 = theme.colors.trough;
	band.BackgroundTransparency = 0;
	band.BorderSizePixel = 0;
	band.AutomaticSize = Enum.AutomaticSize.XY;
	band.LayoutOrder = 1;

	const bandCorner = new Instance("UICorner");
	bandCorner.CornerRadius = new UDim(0, CARD_CORNER_RADIUS);
	bandCorner.Parent = band;

	const bandPadding = new Instance("UIPadding");
	bandPadding.PaddingTop = new UDim(0, BAND_PADDING_Y);
	bandPadding.PaddingBottom = new UDim(0, BAND_PADDING_Y);
	bandPadding.PaddingLeft = new UDim(0, BAND_PADDING_X);
	bandPadding.PaddingRight = new UDim(0, BAND_PADDING_X);
	bandPadding.Parent = band;

	// A layout rather than a bare child, for the reason `addPill` uses one: it places the label without this file
	// having to know the label's own size, which is the thing an auto-sized parent is asking about.
	const bandLayout = new Instance("UIListLayout");
	bandLayout.FillDirection = Enum.FillDirection.Horizontal;
	bandLayout.SortOrder = Enum.SortOrder.LayoutOrder;
	bandLayout.HorizontalAlignment = Enum.HorizontalAlignment.Center;
	bandLayout.VerticalAlignment = Enum.VerticalAlignment.Center;
	bandLayout.Parent = band;

	band.Parent = card;

	// **`badgeLabel` rather than `badge.name`, and the words are not the display's to decide.** The rule that turns
	// `fetch dog` into `Fetch Dog` and `hat-trick` into `Hat-Trick` lives in `shared/badges.ts` beside the strings it
	// applies to — one function, so a badge added later is written the same way as the nineteen before it. What is
	// here is only where the label goes and what face it wears.
	const name = makeBadgeLine("Name", badgeLabel(badge), BADGE_NAME_SIZE, UI_FONT, theme.colors.onAccent, 1);
	name.Parent = band;

	// **The shop's second ink, on the shop's paper.** `textSecondary` is the grey the pop-ups use for every status
	// line — a grey chosen for white, not a black dimmed until it looks grey. See `DESCRIPTION_FONT`.
	const description = makeBadgeLine(
		"Description",
		badge.description,
		BADGE_DESCRIPTION_SIZE,
		DESCRIPTION_FONT,
		theme.colors.textSecondary,
		2,
	);
	description.Parent = card;

	return card;
}


/** One line of a badge card: centred, one line, and exactly as large as its own text. */
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
	// **Both axes are the text's**, for the reason `makeBadgeCard` gives: nothing inside an `AutomaticSize.X` parent
	// can be sized by scale. **`TextSize` and never `TextScaled`**: a scaled label is the second half of the pair that
	// makes a billboard grow and shrink, and this file has no scaled label in it. `TextWrapped` is off for the older
	// reason — a wrapped line would make a card's height depend on a badge's wording — and there is no
	// `TextTruncate` because an auto-sized label has no width to truncate against: the card grows to the longest
	// sentence instead, which is what a card that hugs its text means.
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
	// **The canvas is deliberately far larger than the card, and it never clips.** The card sizes itself, is centred
	// in this box horizontally and sits on its centre vertically (see `mountBadges`), so the canvas is a ceiling
	// rather than a container — the only thing that draws is the card. `ClipsDescendants` is written explicitly rather
	// than left to its default because the whole arrangement depends on that answer: a card that outgrew the canvas
	// would be cut in half by a property nobody looked at. See `BILLBOARD_SIZE`.
	billboard.ClipsDescendants = false;
	billboard.Parent = head;

	Fusion.Hydrate(scope, billboard)({
		Enabled: Fusion.Computed(scope, (use) => use(state) === INTERMISSION),
	});

	return billboard;
}
