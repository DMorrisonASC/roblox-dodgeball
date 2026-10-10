import { Controller, OnStart } from "@flamework/core";
import { Card, Text } from "@rbxts/big-ui";
import type { TypographyVariant } from "@rbxts/big-ui";
import Fusion from "@rbxts/fusion-3.0";
import { Players } from "@rbxts/services";
import { teamColourOf } from "shared/gameMode";
import { events, HitDirection } from "shared/networking";
import { PLAYING, roundPhase } from "../../panels";
import { raiseZIndex } from "../../ui/panelChrome";
import { getHudScreenGui } from "../../ui/screenGui";
import { HudTheme, hudTheme } from "../../ui/hudTheme";
import { addViewportConstraint } from "../../ui/viewportConstraint";

/** Prints on mount — the line that says the controller ran at all. */
const DEBUG = true;

/**
 * # Every size this element draws at, in one place
 *
 * **The whole of what to change to make the cards bigger or smaller is in this block.** The values below
 * are the only numbers that decide how large anything here is; the two that are *not* here are the
 * padding inside a card and the two radii, which come from big-ui through `hudTheme` — see
 * `addCard` for the first and the size map in the report for all of them.
 *
 * **What is deliberately *not* here is a scale multiplier.** There is no `UIScale` on this element and
 * that is a decision rather than an omission: `ArenaFreezeCountdownController` scales its card with one,
 * but that card has a **fixed** size and no layout — its children are positioned by hand — so a scale
 * over it is a single multiplication of a box that is already a known size. This element is the opposite:
 * a stack of cards whose heights are `AutomaticSize`, laid out by a `UIListLayout`, and a `UIScale` over
 * automatic sizing is the arrangement where the layout is computed in unscaled units and then drawn
 * scaled, which is how a card ends up drawn on top of its neighbour. So the size knob here is the text
 * variant plus these pixels, which is two kinds of one-line edit rather than one number that risks the
 * layout. See {@link NAME_VARIANT}.
 */

/**
 * The `ZIndex` of the whole element, and of every descendant — see {@link raiseZIndex}, which levels the
 * tree after it is built.
 *
 * **`1`, which is the ladder's own value for "an ordinary HUD label".** The rungs above are the arena
 * countdown's `2`, the dock's `5`, the panels' `10`, the result panel's `20` and the loading overlay's
 * `30`, and `ArenaFreezeCountdownController` is where that ladder is written down in one place. Nothing
 * at this rung is anywhere near the top-left corner, so `1` is the rule being followed rather than a
 * choice made.
 */
const HIT_LOG_Z_INDEX = 1;

/** How many cards each list holds. **From the brief: the last five.** */
const ROW_COUNT = 5;

/**
 * The width of the element, and therefore of **every card in it**, in pixels. **Placeholder.**
 *
 * 280 at `body1` fits two twenty-character usernames and the arrow on one line with room to spare, which
 * is the widest a card can be asked to be. It is one number rather than one per card on purpose: the
 * cards are a vertical stack, and a width that changed with the longest name in it would make the column
 * twitch on every hit. **Change this and every card changes width**, because each card fills the stack
 * (`Size = (1, 0, …)`) rather than carrying the number itself.
 */
const CARD_WIDTH = 280;

/**
 * The gap between two cards in a stack, and between a stack's heading and its first card, in pixels.
 * **Placeholder.** Set as the stack layout's `Padding`, so it is the *same* gap above and below a card
 * — the heading is a child of the same layout rather than a thing floating above it.
 */
const CARD_GAP = 4;

/**
 * The gap between the two names and the arrow inside a card, in pixels. **Placeholder.** Set as the
 * card's inner row layout's `Padding`, and the only horizontal spacing inside a card: the names are
 * sized by their own text, so this is the whole of what separates them.
 */
const INLINE_GAP = 6;

/** The gap between the two stacks, in pixels. **Placeholder.** Deliberately larger than {@link CARD_GAP} — see the class doc on how the two lists are told apart. */
const STACK_GAP = 10;

/**
 * How heavy a card's edge is, as big-ui's `Card.elevation` — **`1`, which is one pixel of its own
 * hairline.**
 *
 * **A number here rather than a `true`/`false` because that is what it is**: `Card` draws a `UIStroke` of
 * `Thickness = elevation` in black at its divider transparency (`0.88`, so about one eighth opaque) and
 * draws nothing at all at `0`. `2` or `3` would be a visibly darker outline — the prop's whole range — so
 * this one number is the edge's weight, and the class doc argues why it is not `0`.
 */
const CARD_ELEVATION: 0 | 1 | 2 | 3 = 1;

/**
 * The typography the two names are drawn in, and **the knob that decides the text's size.**
 *
 * **`body1` is 16px with a 24px line height**, read out of big-ui's own `Typography` (`body1.size` and
 * `body1.lineHeight` in big-ui's `ui/theme`). It was `caption` — 12px — and that is the whole of what
 * "too small" meant: this is the smallest step up that is still a step, and the two above it are
 * `subtitle1` (16px in GothamMedium, the same size in a heavier face) and `h5` (24px), which is more than
 * a two-name row can afford.
 *
 * **Naming it costs nothing and buys the whole of the size knob**: a variant is the *only* thing that
 * decides the glyph height here, so changing this line changes the names, the row heights, the card
 * heights and the whole stack's height at once. **The numbers themselves are big-ui's**, not this file's —
 * `Typography` is a mutable table that `configureTheme` writes and that `ThemeController` has already run
 * by the time anything mounts, so a project-wide type change is the place to move them and this line is
 * the place to pick one.
 */
const NAME_VARIANT: TypographyVariant = "body1";

/** The typography a stack's heading is drawn in. **`caption` — 12px — because a heading is a label rather than a row**: it names the list and gets out of the way, and it is the one thing here that should not compete with the names for size. */
const HEADING_VARIANT: TypographyVariant = "caption";

/** How far in from the left edge, in pixels. Matched to the coin readout's own inset, deliberately. */
const EDGE_INSET = 12;

/**
 * How far down from the top, in pixels — **the coin readout's bottom edge plus a gap.**
 *
 * `CurrencyHudController` draws one line at `(12, 64)` sized `160×22`, so it occupies y ∈ [64, 86] in
 * exactly the corner this element wants. 96 clears it by ten pixels. **That order is the corner's own
 * convention rather than a preference**: the coin readout is up for the whole session and this is only
 * up during a round, so the permanent thing owns the top of the column and the transient one stacks
 * under it — the arrangement `hudToast.ts` describes for the bottom of the screen, where the permanent
 * Super HUD owns the edge and the alerts stack above it. Nothing else is drawn in this corner; see the
 * class doc for what was checked.
 */
const TOP_INSET = 96;

/**
 * What sits between the two names, and **the whole of how a card says which way the hit went.**
 *
 * A bare space was the alternative and it reads as two names that happen to be next to each other rather
 * than as a direction — and the direction is the one thing this element is about: the same pair appears
 * in one list or the other depending on which end of it you are, and without the arrow the two lists
 * would be two piles of names. The colour rule already says *which teams*; the arrow says *which way*.
 */
const SEPARATOR = "→";

/** The two headings, which are also the stacks' instance names. */
const DEALT_HEADING = "Who you hit";
const TAKEN_HEADING = "Who hit you";

/** One landed hit, as it arrived: **the two names to draw, and the direction the colours come from.** */
interface HitPair {
	readonly hitter: string;
	readonly victim: string;
	readonly direction: HitDirection;
}

/** One card: the `Card` instance a pair is drawn in, and the two labels whose text is what shifts. */
interface HitCard {
	readonly card: Frame;
	readonly hitter: TextLabel;
	readonly victim: TextLabel;
}

/** One of the two lists: its frame, its five cards, and whether it has anything to show. */
interface HitStack {
	readonly frame: Frame;
	readonly cards: HitCard[];
	readonly filled: Fusion.Value<boolean>;
}

/**
 * The hit log: **who you hit and who hit you, as the last five of each**, at the top left of the screen
 * while a round is being played. One card per entry, opaque, two names to a card.
 *
 * **Two lists rather than one, because the two questions are different and only one of them is about
 * winning.** "Who did I land on" is your own round; "who landed on me" is what to do about it — and a
 * single mixed list answers neither, because a name in it would not say which way the exchange went.
 * **The two lists are still two stacks of cards, in two fixed places**, rather than one stream in time
 * order: the original ask was two lists, and a hit's meaning depends on which end of it you were, so a
 * single stream would need every card to say which way it went *and* which list it would have been in.
 * Each hit therefore lands in exactly one stack, decided by which end of it the local player is, and the
 * pair is drawn the same way round in both (`hitter → victim`).
 *
 * **What tells the two stacks apart is the heading, and only the heading.** They are the same size, the
 * same shape and the same fill — swapping the *card* for a colour or a different edge would put a third
 * colour in the corner, and the whole point of the two team colours is that they are the only colours
 * here that mean anything. Order cannot do it either: a card says `hitter → victim` in both stacks, so
 * the arrow would have to point one way in one stack and the other way in the other, which is one rule
 * written twice. A word above each stack costs one label and reads without being learned.
 *
 * **Every card is two names in two different colours, and that is a guarantee rather than a hope.**
 * Friendly fire is refused globally, before any damage, by `RoundService.isFriendlyFire` — `BallComponent`
 * calls it ahead of the tag, so a same-side contact is not merely undamaging but *absent*: no bounce, no
 * tag, no hit and therefore no log entry. So **every logged hit has one end on each side**, and a card can
 * never be one colour. That single fact is what makes the whole rendering rule work: the colours follow
 * from the `direction` alone, so no colour has to travel, and the two names in a card cannot collide.
 *
 * **The colours are the teams' and nothing else is.** `teamColourOf` reads the one pair `TEAM_COLORS`
 * holds — the same table the character outline, the team rings and the score bar's two circles paint
 * from — so a name in this element is the same red or blue as the body it names. **No side is named in
 * words**, which is the rule the score HUD's circles were built on: the colour is the identity, and a
 * label saying which team it is would be a second vocabulary for a fact already on the screen.
 *
 * **The cards are opaque, and the fill is the theme's paper — which is what makes both team colours
 * readable.** This reverses what was here first, and the reversal is worth reading because the old
 * argument was not silly, it was about the wrong thing. It said: the theme is light, so an opaque card is
 * a cream slab pinned over the arena, which is the loudest thing on screen for the least information on
 * it, and `RoundStatusController` drops its own card's fill for exactly that reason during a round. All
 * true — and it made legibility the thing that paid for the quiet. **A transparent card shows whatever is
 * behind it through the one part of the element that has to be read**, and the two names are mid-dark team
 * colours chosen to survive being an *outline* on a body, not text on an arbitrary background: against a
 * bright sky, or the pale floor of the arena, both colours lose most of their contrast and the card
 * becomes a suggestion of two names. The fill is what fixes that, and the numbers are worth stating
 * because they are the whole of the decision. Team red is `(158, 58, 52)` and team blue is
 * `(56, 92, 152)`; their relative luminances are `0.105` and `0.108`, so against the theme's paper
 * `(255, 255, 255)` they come out at **6.8:1 and 6.7:1** — comfortably past the 4.5:1 a normal text
 * contrast wants — while against a black fill they would be **3.1:1**, which fails it. A light fill is
 * what these colours need, and the light theme is what the rest of the HUD is already drawn on. **The
 * cost is the loudness, and it is paid deliberately**: ten white cards in the corner are unmissable,
 * which is the point of a readout that has to be *read* mid-fight rather than glanced at, and the element
 * is only up during a round and only when there is an entry to show.
 *
 * **The fill is `hudTheme`'s `panel`, which is big-ui's `background.paper`** — the raised surface, the
 * colour big-ui's own `Card` fills itself with. `theme.colors.card` is the other candidate and is
 * `background.default`, the page colour, which exists to be the hole a card sits in; a card floating over
 * the game has no panel above it to cut into, so the paper is the honest one. **No colour was added to
 * `hudTheme` for this**, and none is needed: the theme's own doc says a panel is made of `panel` and a
 * card takes the page colour back, and adding a third near-white for the same job is the semantic drift
 * its `coin` entry argues against.
 *
 * **`elevation: 1`, so each card carries the one-pixel hairline big-ui draws at its own divider
 * transparency.** That is not decoration either: a *white* card over a bright sky has no edge of its own,
 * and a stack of them with no edge reads as one ragged white mass. `elevation: 0` would take the stroke
 * away — which is right for a card that is *transparent*, because an outline around nothing is a floating
 * rectangle, and wrong for an opaque one. The alternative was a cast shadow from `ui/elevation.ts`, and
 * that is refused on purpose: that helper is the *furniture* hierarchy, for the dock's buttons and the
 * shop's panels — things a player presses and opens — and a readout that looks pressable is a readout
 * that invites a click.
 *
 * **It is shown during a playing phase and not in a practice zone**, which is deliberately *not* the
 * shared `sessionHudVisible` predicate. That one is "a round is on, or you are in a practice zone", and
 * the zone half is there because the ability readouts are useful where a player is practising — a dodge
 * cooldown is worth watching while dodging. **A practice zone has no round, no sides and no score**, so
 * there is nothing this element could report in one: `logHit` refuses a hitter with no side, and a zone
 * is not a round for anything to be logged against. Showing an element that is guaranteed to be empty
 * everywhere a player might be reading it is worse than not showing it.
 *
 * **The update is text writes rather than a rebuild, and the cards are the reason it still works.** There
 * are **five cards per stack, ten in all, made once and never destroyed**, and they are *slots*: the
 * card in position *n* shows entry *n*, and `paint` writes the two names and their two colours into it.
 * A hit therefore costs **no instances at all** — no card is created, destroyed or reparented — and the
 * writes are five per card, so twenty-six per stack and fifty-two for the element at its worst, when both
 * lists are full and every card has to be written. **What that costs is said rather than discovered**: the
 * ten cards exist from the frame the element mounts, so an element that is hidden for most of its life
 * still holds a little over a hundred instances (the count is on `addCard`), and a card that falls off the
 * end of a list is hidden rather than removed, so its text is one hit stale until `paint` next writes over
 * it. Both are paid once per round; a rebuild would put the garbage collector and a layout pass on the
 * frames where several hits land in the same second, which is the worst possible moment for either.
 *
 * **A hidden card costs the layout nothing, and that is checked rather than hoped for.** The engine's own
 * `GuiObject.Visible` documentation says an invisible element "will be ignored by layout structures such
 * as `UIListLayout`… the space that the element would otherwise occupy in the layout is used by other
 * elements instead" — so five cards per stack collapse to whatever is actually in the list without any of
 * them being unparented, and the stack's automatic height follows. **That fact is what makes hiding a card
 * the empty state rather than a gap**, and it is why nothing here needs a "collapse this" branch.
 *
 * **The windows are the client's, and `RoundService`'s log is deliberately not read here.** The two look
 * like the same thing and are not: that log is *the round's* last five hits, so in a busy round a player's
 * own entries are pushed out of it by other people's — "the last five **I** hit" is not a slice of it, and
 * no client could reconstruct it after the fact. A per-player window is five entries the server would have
 * to keep *per player*, or (what this does) five entries each client keeps for itself from the stream it is
 * already being sent. The log keeps its own job as the round's record; see its entry doc.
 *
 * **The empty state is to hide, and that also answers the mid-round joiner.** A hit log with nothing in
 * it has nothing to say, so the element is hidden while both stacks are empty and a stack is hidden while
 * its own list is — but the same rule covers a case that needs no rule of its own: **a player who joins
 * during a round cannot appear in a logged hit at all.** They have no side, so `logHit` refuses them as a
 * hitter (a hit with no side has no direction); they are not in `activePlayers`, so `registerHit` refuses
 * them as a victim. The server therefore never sends them one, their lists stay empty, and the element
 * stays hidden — an empty list is exactly what "not in this round" looks like from here. **That is why
 * there is no "am I on a side" term**: it would be a second answer to a question the first one already
 * covers, and it would need a second connection to `TEAM_ATTRIBUTE` for a fact nothing can contradict.
 *
 * **What was checked in that corner, since a collision was suspected.** The coin readout is at `(12, 64)`
 * and is the only neighbour; nothing else is near it. The score bar and the round-status line are both
 * *top centre* (`AnchorPoint` `(0.5, 0)`, insets `4` and `44`), the dock is bottom centre, the cooldown
 * card is bottom left and the Super HUD and the toasts own the bottom centre — see `hudToast.ts`, whose
 * geometry is all about the bottom of the screen. `TOP_INSET` is written as the coin readout's bottom edge
 * plus a gap rather than as a number of its own.
 */
@Controller()
export class HitLogController implements OnStart {
	public onStart(): void {
		// Spawned rather than done inline: mounting waits for `PlayerGui`, and a controller's `onStart`
		// is the wrong place to hold up the rest of the client's boot — as every HUD here does it.
		task.spawn(() => this.mount());
	}

	private mount(): void {
		const scope = Fusion.scoped();
		const player = Players.LocalPlayer;
		const theme = hudTheme();

		// **The two lists, newest first, as plain arrays rather than Fusion state.** Nothing draws from
		// them reactively: `paint` writes the cards when a hit arrives, which is once per hit rather than
		// once per frame, so there is no graph to keep in step and no `Computed` re-running over an array
		// that changed by one element. What *is* reactive is the two facts the visibility is made of — the
		// shared `roundPhase` and `anyHits` below — and both are `Value`s.
		const dealt: HitPair[] = [];
		const taken: HitPair[] = [];

		/**
		 * Whether either list has anything in it — **the third fact, and the one that is the empty state.**
		 *
		 * It is written in exactly two places, both of which just changed the lists: the event handler
		 * when a hit arrives, and the clear when the phase leaves `Playing`. That is not tidiness — it is
		 * what keeps it from being able to disagree with the lists it describes, which is the same
		 * arrangement `roundPhase` has with the attribute it mirrors.
		 */
		const anyHits = Fusion.Value(scope, false);

		const dealtStack = this.addStack(scope, theme, DEALT_HEADING, 1);
		const takenStack = this.addStack(scope, theme, TAKEN_HEADING, 2);

		/**
		 * Whether the whole element should be on screen: **a round is being played, and there is
		 * something to show.**
		 *
		 * **Both `use()` calls are hoisted to the top**, as every `use()` must be: `use(a) && use(b)`
		 * would subscribe to whichever ran first and stop watching the other the moment it said no.
		 */
		const visible = Fusion.Computed(scope, (use) => {
			const playingNow = use(roundPhase) === PLAYING;
			const hasHitsNow = use(anyHits);

			return playingNow && hasHitsNow;
		});

		const wrapper = Fusion.New(scope, "Frame")({
			Name: "HitLog",
			// **A fixed width with an automatic height, and the split is the layout.** The element is a
			// column of stacks that grows downwards, so height is the axis that has something to say and
			// width is what the two names have to fit into — the opposite of the usual HUD, and the reason
			// `CARD_WIDTH` is a number rather than something the content decides. Each stack fills this
			// width and each card fills its stack, so this one number reaches all ten cards.
			Size: new UDim2(0, CARD_WIDTH, 0, 0),
			AutomaticSize: Enum.AutomaticSize.Y,
			Position: new UDim2(0, EDGE_INSET, 0, TOP_INSET),
			BackgroundTransparency: 1,
			Visible: visible,
		});

		// The wrapper lays its two stacks out itself, because nothing above them does — it is a plain
		// frame and a `UIListLayout` is what turns two children into a column. `STACK_GAP` is its
		// padding, so the space between the lists is bigger than the space inside one: see the class doc
		// on what tells them apart.
		const wrapperLayout = new Instance("UIListLayout");
		wrapperLayout.FillDirection = Enum.FillDirection.Vertical;
		wrapperLayout.SortOrder = Enum.SortOrder.LayoutOrder;
		wrapperLayout.Padding = new UDim(0, STACK_GAP);
		wrapperLayout.Parent = wrapper;

		dealtStack.frame.Parent = wrapper;
		takenStack.frame.Parent = wrapper;

		// **Every descendant is levelled, not just the wrapper**, and that is a rule rather than tidiness:
		// Roblox draws a child above its parent only when the child's `ZIndex` is at least the parent's,
		// so a card left at the default under a frame carrying this number would be drawn behind it. This
		// is the helper the panels use for the same reason, called once the tree exists. See
		// `HIT_LOG_Z_INDEX` for the number and what it sits under.
		raiseZIndex(wrapper, HIT_LOG_Z_INDEX);

		// `CARD_WIDTH` is 280px at the left edge, so a viewport narrower than that pushes the element off
		// the right of the screen — and a HUD in a corner has nowhere to give way but its own width. The
		// same rule as every other HUD, applied for the same reason: the element carries its own bound
		// rather than trusting the screen to be big enough. See `addViewportConstraint` for the two caps.
		addViewportConstraint(scope, wrapper);

		wrapper.Parent = getHudScreenGui();

		/**
		 * **The clear: the phase leaving `Playing`.**
		 *
		 * The server clears its own log at the *opening* of a round, which is the next boundary after the
		 * hits it holds — so clearing here when the phase stops being `Playing` is the same moment seen
		 * from this side, and the difference is invisible: the element is hidden for the whole intermission
		 * (see `visible` above), so whether the lists empty when the round ends or when the next one starts
		 * is not something anybody can observe. What is observable is that a fresh round cannot open on the
		 * last round's names, and that is what this does.
		 *
		 * **An `Observer` on the shared value rather than a connection to `ROUND_STATE_ATTRIBUTE`**, and
		 * that is the one thing about this controller worth reading twice. `panels.ts` exists so that the
		 * HUDs do not each hold their own subscription to the same attribute — one subscription per reader
		 * for one fact is the thing it was written to prevent — and `roundPhase` is that module's mirror of
		 * this attribute. **A `Value` cannot be asked for an *edge*, though**: `use()` gives the current
		 * value and nothing in this Fusion version exposes "it changed" on a `Value`, which is what an
		 * `Observer` is for. So this is the *only* reader of the phase that watches the value rather than
		 * the attribute, deliberately, and the two facts it needs — the state, for visibility, and the
		 * transition, for the clear — come from one subscription instead of two.
		 *
		 * **Clearing on the way out rather than on the way in is what makes it total.** A client that
		 * watched a round end and then watched the next one start takes this path; a client that mounted
		 * during an intermission has empty lists already, and a client that joined mid-round is never sent
		 * anything to clear. There is no window in which a stale pair can reach the screen.
		 */
		Fusion.Observer(scope, roundPhase).onChange(() => {
			if (Fusion.peek(roundPhase) === PLAYING) return;

			dealt.clear();
			taken.clear();
			this.paint(dealtStack, dealt, theme);
			this.paint(takenStack, taken, theme);
			anyHits.set(false);
		});

		/**
		 * **A hit has landed, and it is one of ours.** Each client is sent only the hits it is in — see
		 * `networking.ts` on `roundHit` — so the only decision left is which stack it belongs to.
		 *
		 * **By name, not by side, and the difference matters for one unreachable case.** The direction
		 * would answer the same question while sides are locked, which they are for every mode this build
		 * can start: `MatchService.optIn` refuses a side change while the phase is `Playing`. But `setTeam`
		 * *can* be called mid-round by Dodge and Seek's conversion, and a client that had just changed
		 * sides would then file a hit at the wrong end — reading "who you hit" as "who hit you". A name
		 * cannot go stale: it is fixed for the session and unique in a server, and the server sends the
		 * same `Player.Name` the client compares against. **The direction keeps its own job** — it is what
		 * the colours come from, and the names have nothing to do with that.
		 *
		 * **The direction is checked rather than trusted**, because the wire is not typed: only two strings
		 * are meaningful, and a third means this build and the server disagree about the vocabulary. The
		 * names are checked against nothing — the only thing they are compared to is this client's own
		 * name, and a message naming neither end is one that was not meant for it.
		 */
		events.Client.Get("roundHit").Connect((hitter, victim, direction) => {
			if (direction !== "AtoB" && direction !== "BtoA") return;

			const pair: HitPair = { hitter: hitter, victim: victim, direction: direction };

			if (hitter === player.Name) this.prepend(dealt, pair);
			else if (victim === player.Name) this.prepend(taken, pair);
			else return;

			this.paint(dealtStack, dealt, theme);
			this.paint(takenStack, taken, theme);
			anyHits.set(dealt.size() > 0 || taken.size() > 0);

			if (DEBUG) {
				print(`[HUD] hit log — ${dealt.size()} dealt, ${taken.size()} taken`);
			}
		});

		if (DEBUG) print(`[HUD] hit log up — two stacks of ${ROW_COUNT}, reading roundHit`);
	}

	/**
	 * One of the two lists: a heading and five hidden cards under it.
	 *
	 * **A frame of its own per stack rather than the cards hung straight on the wrapper**, because a list
	 * with nothing in it has to be able to disappear as a unit — heading included. Hiding the heading and
	 * five cards one at a time would be six `Visible` writes to say one thing, and the wrapper would still
	 * carry the gap they left behind.
	 *
	 * **`Visible` is the stack's own `Value`, not a `Computed`**, because there is nothing to derive:
	 * `paint` already knows whether the list is empty, and says so in the same call that writes the cards.
	 */
	private addStack(
		scope: Fusion.Scope<unknown>,
		theme: HudTheme,
		heading: string,
		order: number,
	): HitStack {
		const filled = Fusion.Value(scope, false);

		const frame = Fusion.New(scope, "Frame")({
			Name: heading,
			Size: new UDim2(1, 0, 0, 0),
			AutomaticSize: Enum.AutomaticSize.Y,
			BackgroundTransparency: 1,
			LayoutOrder: order,
			Visible: filled,
		});

		// The stack's own layout owns its children's positions, so the order they are *created* in is not
		// the order they appear in — `LayoutOrder` is, which is why the heading is numbered and the cards
		// carry theirs. The default sort is by name, and "Who hit you" would sort above "Who you hit".
		const layout = new Instance("UIListLayout");
		layout.FillDirection = Enum.FillDirection.Vertical;
		layout.SortOrder = Enum.SortOrder.LayoutOrder;
		layout.Padding = new UDim(0, CARD_GAP);
		layout.Parent = frame;

		const caption = Text(scope, { text: heading, variant: HEADING_VARIANT });
		caption.Name = "Heading";
		caption.LayoutOrder = 0;
		// Written onto the returned label rather than passed as a prop: big-ui's `Text.color` is a palette
		// *vocabulary* — `"primary"`, `"errorMain"` — resolved against big-ui's own palette, and this ink
		// is the theme's. The default would also have been drawn at `Transparency.textPrimary` (0.13);
		// a heading over a bright arena wants all of its ink.
		caption.TextColor3 = theme.colors.textPrimary;
		caption.TextTransparency = 0;
		caption.Parent = frame;

		const cards: HitCard[] = [];

		for (let index = 0; index < ROW_COUNT; index++) {
			const card = this.addCard(scope, theme, index + 1);
			cards.push(card);
			card.card.Parent = frame;
		}

		return { frame: frame, cards: cards, filled: filled };
	}

	/**
	 * One card: **a `Card` holding the two names with the arrow between them.**
	 *
	 * **This is where the instance count is decided, so here it is.** A card that is up and empty of
	 * ideas is ten instances: `Card` builds its own frame, corner, padding, list layout and — at
	 * `elevation: 1` — its `UIStroke` (five), this method adds the row frame and the row's horizontal
	 * layout (two, because `Card`'s own layout is vertical and the row is the thing that is not), and
	 * three text labels go in the row (three). Five per stack is fifty, two stacks are **one hundred**,
	 * and the element is a hundred and eight with the wrapper, the two stacks, their two layouts and the
	 * two headings added. **All of it is made once** at mount and nothing below this line is ever
	 * destroyed; see the class doc for why the cards are slots rather than one per hit.
	 *
	 * **Hidden until it has something to say**, which is the empty state at the card's own level: a fresh
	 * round is ten invisible cards under two hidden headings, and the first hit makes one of them real.
	 *
	 * **Card's `size` is deliberately not passed**, which is the same trick `RoundStatusController` uses
	 * and for the same reason: `Card` auto-sizes its height *only* when it is given no size at all, and
	 * passing one pins the box and turns that off — so the card is as tall as its row, and no amount of
	 * text can be clipped by a box that was sized before the text existed. Its width comes from the fill
	 * below.
	 */
	private addCard(scope: Fusion.Scope<unknown>, theme: HudTheme, order: number): HitCard {
		const row = Fusion.New(scope, "Frame")({
			Name: "Row",
			// Full width of the card's content area, zero height, and the height comes from the labels:
			// `AutomaticSize.Y` on a frame full of content-sized labels is what makes a one-line row a
			// one-line row.
			Size: new UDim2(1, 0, 0, 0),
			AutomaticSize: Enum.AutomaticSize.Y,
			BackgroundTransparency: 1,
		});

		const rowLayout = new Instance("UIListLayout");
		rowLayout.FillDirection = Enum.FillDirection.Horizontal;
		rowLayout.SortOrder = Enum.SortOrder.LayoutOrder;
		rowLayout.Padding = new UDim(0, INLINE_GAP);
		// **The row wraps rather than overflowing, and that is a fixed-width card's only honest answer.**
		// The two names are sized by their own text, so nothing here can promise that a pair of long
		// usernames fits across `CARD_WIDTH` on one line — and a row that overflowed would draw its second
		// name outside the card, over the arena, clipped by nothing (a `Card` does not clip). `Wraps` makes
		// the layout break the line instead: the row gets a second line, the card grows taller, the stack
		// shifts down, and the text stays inside the fill. **This is the layout's own mechanism and not a
		// measurement**, which is why it costs no instances and no arithmetic — the alternative was a
		// `UISizeConstraint` per name (`+20` instances) to clamp the labels and let them wrap themselves.
		// It does turn the layout into a flex one, which is a documented extra pass over three children.
		rowLayout.Wraps = true;
		rowLayout.Parent = row;

		const hitter = Text(scope, { text: "", variant: NAME_VARIANT });
		hitter.Name = "Hitter";
		hitter.LayoutOrder = 1;
		hitter.Parent = row;

		const separator = Text(scope, { text: SEPARATOR, variant: NAME_VARIANT });
		separator.Name = "Separator";
		separator.LayoutOrder = 2;
		separator.TextColor3 = theme.colors.textPrimary;
		separator.TextTransparency = 0;
		separator.Parent = row;

		const victim = Text(scope, { text: "", variant: NAME_VARIANT });
		victim.Name = "Victim";
		victim.LayoutOrder = 3;
		victim.Parent = row;

		// **Every label in a row is sized by its own text, and that is forced rather than tidy.** big-ui's
		// `Text` defaults to a *scale-1* width — `Size = (1, 0, lineHeight)` — and a scale-1 child inside a
		// row that is sizing itself is a measurement cycle rather than a layout: the label asks the row how
		// wide it is and the row asks the label. A zero-offset size plus `AutomaticSize.XY` is the answer,
		// and it is the same two lines every content-sized `Text` in this project writes — see
		// `ScoreHudController`, which states the rule and the failure it prevents. It is also why there is
		// no row height to tune: a row is one line of `NAME_VARIANT`, whatever that variant's line height is.
		for (const label of [hitter, separator, victim]) {
			label.Size = UDim2.fromOffset(0, 0);
			label.AutomaticSize = Enum.AutomaticSize.XY;
		}

		// The names' colours are not set here: they change with every pair, and `paint` is the one place
		// they are written. What is fixed for the card's whole life is the arrow's ink and the fact that
		// the names are fully opaque — a half-transparent name would mix with the fill and the contrast
		// the class doc computes would no longer be the contrast on screen.
		hitter.TextTransparency = 0;
		victim.TextTransparency = 0;

		const card = Card(scope, {
			// The fill, the padding and the hairline, in that order. `background` names the theme's paper
			// rather than taking big-ui's default, because the fill is a *decision* here — it is what buys
			// the contrast — and a decision a reader can see beats one inherited from a library. The
			// padding is a theme token rather than one of this file's pixels: it is the same inset every
			// card in the project uses, and 8px at today's spacing scale. See the size map in the report.
			background: theme.colors.panel,
			padding: theme.spacing.sm,
			elevation: CARD_ELEVATION,
			// One child, so the vertical list layout `Card` always adds has nothing to arrange — the card's
			// automatic *height* is the whole of what it is doing here.
			children: [row],
		});

		card.Name = `Card${order}`;
		card.LayoutOrder = order;
		card.Visible = false;

		return { card: card, hitter: hitter, victim: victim };
	}

	/**
	 * Writes `entries` into a stack's five cards — **the whole update mechanism, and it is text writes
	 * rather than a rebuild.**
	 *
	 * **A dumb render of a list into fixed cards**, which is why it can be this short: the state is the
	 * two arrays, this is the only thing that reads them, and card *n* always shows entry *n*. Every entry
	 * past the end hides its card, so the same call handles "five hits", "two hits" and "no hits" without a
	 * branch between them — and since a hidden card is ignored by the layout, that *is* the collapse.
	 *
	 * **The colours come from the direction alone, and this is the whole of that rule.** `"AtoB"` means the
	 * hitter was on A and the victim on B, so one string decides both inks and the names are only ever the
	 * *text*. That is the payoff from friendly fire being off: the two labels cannot come out the same
	 * colour, so a card is always readable as "this side hit that side" rather than as two words.
	 *
	 * **`TextColor3` is written onto the returned labels rather than passed to `Text`.** big-ui's
	 * `Text.color` is a palette *vocabulary* — `"primary"`, `"errorMain"` — resolved against big-ui's own
	 * palette, so a team colour could not travel through it; the instance is where a `Color3` goes, which
	 * is what every other HUD here does. The fallback to `textPrimary` is for a label `teamColourOf` does
	 * not know, which the log cannot produce and the loose attribute reads elsewhere in this project are
	 * written to tolerate anyway.
	 */
	private paint(stack: HitStack, entries: HitPair[], theme: HudTheme): void {
		for (let index = 0; index < ROW_COUNT; index++) {
			const held = stack.cards[index];

			// The end of the list reached: the card keeps its place and loses its contents.
			if (index >= entries.size()) {
				held.card.Visible = false;
				continue;
			}

			const entry = entries[index];
			const hitterOnA = entry.direction === "AtoB";
			const hitterColour = teamColourOf(hitterOnA ? "A" : "B");
			const victimColour = teamColourOf(hitterOnA ? "B" : "A");

			held.card.Visible = true;
			held.hitter.Text = entry.hitter;
			held.hitter.TextColor3 = hitterColour ?? theme.colors.textPrimary;
			held.victim.Text = entry.victim;
			held.victim.TextColor3 = victimColour ?? theme.colors.textPrimary;
		}

		// The stack's own visibility, written here rather than derived, because this is the only place
		// that knows whether the list is empty — see `addStack`.
		stack.filled.set(entries.size() > 0);
	}

	/** Newest first, capped: the new pair goes on the front and the oldest falls off the back. */
	private prepend(list: HitPair[], pair: HitPair): void {
		list.unshift(pair);

		if (list.size() > ROW_COUNT) list.pop();
	}
}
