import { Controller, OnStart } from "@flamework/core";
import { Card, Text } from "@rbxts/big-ui";
import type { TypographyVariant } from "@rbxts/big-ui";
import Fusion from "@rbxts/fusion-3.0";
import { teamColourOf } from "shared/gameMode";
import { events, HitDirection } from "shared/networking";
import { PLAYING, roundPhase } from "../../panels";
import { raiseZIndex } from "../../ui/panelChrome";
import { getHudScreenGui } from "../../ui/screenGui";
import { HudTheme, hudTheme } from "../../ui/hudTheme";
import { addViewportConstraint } from "../../ui/viewportConstraint";

/** Prints on mount, and one line per hit that lands in the feed. */
const DEBUG = true;

/**
 * # Every size this element draws at, in one place
 *
 * **The whole of what to change to make the cards bigger or smaller is in this block.** The values below
 * are the only numbers that decide how large anything here is; the two that are *not* here are the padding
 * inside a card and the corner radius, which come from big-ui through `hudTheme` — see `addCard` for the
 * first and the size map in the report for both.
 *
 * **The two lifetimes are here too, because "how big" and "how long" are the same kind of question for a
 * feed**: `ROW_COUNT` decides how many rows can be up at once and `ROW_LIFETIME_SECONDS` decides how long
 * each one has, and the two together are the whole of what a reader sees.
 *
 * **What is deliberately *not* here is a scale multiplier.** There is no `UIScale` on this element and that
 * is a decision rather than an omission: `ArenaFreezeCountdownController` scales its card with one, but
 * that card has a **fixed** size and no layout — its children are positioned by hand — so a scale over it
 * is a single multiplication of a box that is already a known size. This element is the opposite: a stack
 * of cards whose heights are `AutomaticSize`, laid out by a `UIListLayout`, and a `UIScale` over automatic
 * sizing is the arrangement where the layout is computed in unscaled units and then drawn scaled, which is
 * how a card ends up drawn on top of its neighbour. So the size knob here is the text variant plus these
 * pixels, which is two kinds of one-line edit rather than one number that risks the layout. See
 * {@link NAME_VARIANT}.
 */

/**
 * The `ZIndex` of the whole element, and of every descendant — see {@link raiseZIndex}, which levels the
 * tree after it is built.
 *
 * **`1`, which is the ladder's own value for "an ordinary HUD label".** The rungs above are the arena
 * countdown's `2`, the dock's `5`, the panels' `10`, the result panel's `20` and the loading overlay's
 * `30`, and `ArenaFreezeCountdownController` is where that ladder is written down in one place. Nothing at
 * this rung is anywhere near the top-left corner, so `1` is the rule being followed rather than a choice
 * made.
 */
const HIT_LOG_Z_INDEX = 1;

/**
 * The most rows the feed can hold at once. **From the brief: five.**
 *
 * **A cap and a clock, and they are two different ways a row leaves.** This one is about *space*: a sixth
 * hit pushes the oldest row off the back, so a loud round shows the most recent five whatever their age.
 * {@link ROW_LIFETIME_SECONDS} is about *time* and retires a row nobody has displaced. Either can win, and
 * neither is a fallback for the other — see the class doc.
 *
 * It is also the size of the element's instance pool, which is built once for exactly this many rows.
 */
const ROW_COUNT = 5;

/**
 * How long one row stays on screen, in seconds. **From the brief: ten.**
 *
 * **This is what makes the element a feed rather than a scoreboard.** The server keeps the round's hits for
 * as long as it likes — its own log is a record, and the result panel reads it — but a *hit* is momentary:
 * ten seconds later it is a fight nobody is in any more, and a list that kept it would be a growing pile
 * of old news over the one corner of the screen a player is watching for incoming balls.
 *
 * **It is a floor rather than an exact figure, and the sweep is why.** A row's age is accumulated by
 * {@link SWEEP_SECONDS} steps, so a row is removed on the first sweep *after* it passes ten seconds — it
 * is therefore on screen for at least ten and at most ten and a quarter. The one direction it cannot err
 * in is the one that matters, which is leaving early.
 */
const ROW_LIFETIME_SECONDS = 10;

/**
 * How often the rows are aged, in seconds. **Placeholder.**
 *
 * **Four times a second, which is a wake-up per 250ms that costs one comparison while the feed is empty**
 * and a walk over at most five entries while it is not. The alternative — one `task.delay` per row, each
 * removing the one it was scheduled for — is one timer per hit and a second piece of bookkeeping to keep
 * the entry and its timer in step; a sweep has no per-row state beyond the age it already carries, and
 * cannot leave a timer behind for a row that has already gone.
 *
 * **It also decides the granularity of {@link ROW_LIFETIME_SECONDS}**, which is the reason it is a named
 * number rather than a literal inside the loop: the two are one decision about how precisely a row's life
 * is measured.
 */
const SWEEP_SECONDS = 0.25;

/**
 * The width of the element, and therefore of **every card in it**, in pixels. **Placeholder.**
 *
 * 280 at `body1` fits two twenty-character usernames and the arrow on one line with room to spare, which is
 * the widest a card can be asked to be. It is one number rather than one per card on purpose: the cards are
 * a vertical stack, and a width that changed with the longest name in it would make the column twitch on
 * every hit. **Change this and every card changes width**, because each card fills the stack
 * (`Size = (1, 0, …)`) rather than carrying the number itself.
 */
const CARD_WIDTH = 280;

/**
 * The gap between two cards, and between the heading and the first card, in pixels. **Placeholder.** Set as
 * the stack's layout `Padding`, so it is the *same* gap above and below a card — the heading is a child of
 * the same layout rather than a thing floating above it.
 */
const CARD_GAP = 4;

/**
 * The gap between the two names and the arrow inside a card, in pixels. **Placeholder.** Set as the card's
 * inner row layout's `Padding`, and the only horizontal spacing inside a card: the names are sized by their
 * own text, so this is the whole of what separates them.
 */
const INLINE_GAP = 6;

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
 * `body1.lineHeight` in big-ui's `ui/theme`). It was `caption` — 12px — and that is the whole of what "too
 * small" meant: this is the smallest step up that is still a step, and the two above it are `subtitle1`
 * (16px in GothamMedium, the same size in a heavier face) and `h5` (24px), which is more than a two-name
 * row can afford.
 *
 * **Naming it costs nothing and buys the whole of the size knob**: a variant is the *only* thing that
 * decides the glyph height here, so changing this line changes the names, the row heights, the card heights
 * and the whole stack's height at once. **The numbers themselves are big-ui's**, not this file's —
 * `Typography` is a mutable table that `configureTheme` writes and that `ThemeController` has already run
 * by the time anything mounts, so a project-wide type change is the place to move them and this line is the
 * place to pick one.
 */
const NAME_VARIANT: TypographyVariant = "body1";

/** The typography the heading is drawn in. **`caption` — 12px — because a heading is a label rather than a row**: it names the list and gets out of the way, and it is the one thing here that should not compete with the names for size. */
const HEADING_VARIANT: TypographyVariant = "caption";

/** How far in from the left edge, in pixels. Matched to the coin readout's own inset, deliberately. */
const EDGE_INSET = 12;

/**
 * How far down from the top, in pixels — **the coin readout's bottom edge plus a gap.**
 *
 * `CurrencyHudController` draws one line at `(12, 64)` sized `160×22`, so it occupies y ∈ [64, 86] in
 * exactly the corner this element wants. 96 clears it by ten pixels. **That order is the corner's own
 * convention rather than a preference**: the coin readout is up for the whole session and this is only up
 * during a round, so the permanent thing owns the top of the column and the transient one stacks under it —
 * the arrangement `hudToast.ts` describes for the bottom of the screen, where the permanent Super HUD owns
 * the edge and the alerts stack above it. Nothing else is drawn in this corner; see the class doc for what
 * was checked.
 */
const TOP_INSET = 96;

/**
 * What sits between the two names, and **the whole of how a row says which way the hit went.**
 *
 * A bare space was the alternative and it reads as two names that happen to be next to each other rather
 * than as a direction — and the direction is the one thing this element is about: a feed of pairs with no
 * arrow is a pile of names, and the reader cannot tell who did what to whom. The colour rule already says
 * *which teams*; the arrow says *which way*.
 */
const SEPARATOR = "→";

/**
 * What the feed is called on screen.
 *
 * **"Hits", not "outs", and the difference is this project's vocabulary rather than a preference.** The
 * brief for this element called them outs, which is what a player would say — but **`outs` already means
 * something specific here**: the result board's `outs` column is a player's *eliminations* (see
 * `RoundService.roundOuts`), which only `eliminate` writes, and in Score Rush — the only mode any start
 * path can pick — nobody is ever eliminated at all. What this feed shows is therefore not outs: it is every
 * landed hit, whoever landed it, most of which are deaths that respawn. A heading that said "Outs" would be
 * a word the server's own data contradicts.
 */
const FEED_HEADING = "Hits this round";

/** One hit in the feed: **what to draw, and how long it has been on screen.** */
interface FeedEntry {
	readonly hitter: string;
	readonly victim: string;
	readonly direction: HitDirection;
	/**
	 * Seconds since this row arrived, accumulated by the sweep — see {@link HitLogController.watchLifetime}
	 * for why it is a number this file maintains rather than a timestamp off a clock.
	 */
	age: number;
}

/** One card: the `Card` instance a pair is drawn in, and the two labels whose text is what shifts. */
interface HitCard {
	readonly card: Frame;
	readonly hitter: TextLabel;
	readonly victim: TextLabel;
}

/**
 * The hit feed: **every hit landed in the round, by anyone, newest first**, at the top left of the screen
 * while a round is being played. One opaque card per row, two names to a card, each row living ten seconds.
 *
 * **One feed of the round's hits, not two personal lists — and that is a reversal.** What was here first was
 * "Who you hit" and "Who hit you": the local player's own exchanges, split by which end of them they were.
 * It read well and it was the wrong shape for what it was drawing, for two reasons that only showed up once
 * it was in use. **It answered a question about the wrong person** — a fight is something a player watches
 * as well as takes part in, and a list of your own hits says nothing about the exchange happening three
 * studs away, which is the thing a player looks at a feed for. And **it made the element silently empty**
 * in a round where the player was not landing or taking hits: it had nothing to say because nothing had
 * happened *to them*, which from the seat is indistinguishable from a broken element.
 *
 * **So this is the round's list: every hit by everybody, newest first.** The row is the pair it always was —
 * `hitter → victim`, two names in their own team's colours — and the second half of the old design is gone,
 * because a feed contains both directions of every hit anybody landed, including yours. **The whole server
 * sees the same list**, which is a transport change as much as a rendering one: a hit is now *broadcast*
 * rather than sent to the two people in it, so no per-client filtering is left anywhere — not on the
 * server, and not here, where the element no longer knows or asks whether one of the two names is its own.
 * See `networking.ts` on `roundHit` for that argument and the cost it accepted.
 *
 * **Every row is two names in two different colours, and that is a guarantee rather than a hope.** Friendly
 * fire is refused globally, before any damage, by `RoundService.isFriendlyFire` — `BallComponent` calls it
 * ahead of the tag, so a same-side contact is not merely undamaging but *absent*: no bounce, no tag, no hit
 * and therefore no log entry. So **every logged hit has one end on each side**, and a row can never be one
 * colour. That single fact is what makes the whole rendering rule work: the colours follow from the
 * `direction` alone, so no colour has to travel, and the two names in a row cannot collide.
 *
 * **The colours are the teams' and nothing else is.** `teamColourOf` reads the one pair `TEAM_COLORS` holds
 * — the same table the character outline, the team rings and the score bar's two circles paint from — so a
 * name in this element is the same red or blue as the body it names. **No side is named in words**, which is
 * the rule the score HUD's circles were built on: the colour is the identity, and a label saying which team
 * it is would be a second vocabulary for a fact already on the screen.
 *
 * **The cards are opaque, and the fill is the theme's paper — which is what makes both team colours
 * readable.** This reverses what was here first, and the reversal is worth reading because the old argument
 * was not silly, it was about the wrong thing. It said: the theme is light, so an opaque card is a cream
 * slab pinned over the arena, which is the loudest thing on screen for the least information on it, and
 * `RoundStatusController` drops its own card's fill for exactly that reason during a round. All true — and
 * it made legibility the thing that paid for the quiet. **A transparent card shows whatever is behind it
 * through the one part of the element that has to be read**, and the two names are mid-dark team colours
 * chosen to survive being an *outline* on a body, not text on an arbitrary background: against a bright sky,
 * or the pale floor of the arena, both colours lose most of their contrast and the card becomes a suggestion
 * of two names. The fill is what fixes that, and the numbers are worth stating because they are the whole of
 * the decision. Team red is `(158, 58, 52)` and team blue is `(56, 92, 152)`; their relative luminances are
 * `0.105` and `0.108`, so against the theme's paper `(255, 255, 255)` they come out at **6.8:1 and 6.7:1**
 * — comfortably past the 4.5:1 a normal text contrast wants — while against a black fill they would be
 * **3.1:1**, which fails it. A light fill is what these colours need, and the light theme is what the rest
 * of the HUD is already drawn on. **The cost is the loudness, and it is paid deliberately**: five white
 * cards in the corner are unmissable, which is the point of a readout that has to be *read* mid-fight, and
 * the element is only up during a round and only when a hit has landed.
 *
 * **The fill is `hudTheme`'s `panel`, which is big-ui's `background.paper`** — the raised surface, the
 * colour big-ui's own `Card` fills itself with. `theme.colors.card` is the other candidate and is
 * `background.default`, the page colour, which exists to be the hole a card sits in; a card floating over
 * the game has no panel above it to cut into, so the paper is the honest one. **No colour was added to
 * `hudTheme` for this**, and none is needed: the theme's own doc says a panel is made of `panel` and a card
 * takes the page colour back, and adding a third near-white for the same job is the semantic drift its
 * `coin` entry argues against.
 *
 * **`elevation: 1`, so each card carries the one-pixel hairline big-ui draws at its own divider
 * transparency.** That is not decoration either: a *white* card over a bright sky has no edge of its own,
 * and a stack of them with no edge reads as one ragged white mass. `elevation: 0` would take the stroke
 * away — which is right for a card that is *transparent*, because an outline around nothing is a floating
 * rectangle, and wrong for an opaque one. The alternative was a cast shadow from `ui/elevation.ts`, and
 * that is refused on purpose: that helper is the *furniture* hierarchy, for the dock's buttons and the
 * shop's panels — things a player presses and opens — and a readout that looks pressable is a readout that
 * invites a click.
 *
 * **It is shown during a playing phase and hidden the rest of the time, which is deliberately *not* the
 * shared `sessionHudVisible` predicate.** That one is "a round is on, or you are in a practice zone", and the
 * zone half is there because the ability readouts are useful where a player is practising — a dodge cooldown
 * is worth watching while dodging, and the zone is the one place the game has decided a player may practise.
 * **The zone half has no counterpart here, because this element holds no fact about the player at all any
 * more**: it is a question about the round, and a round plays on wherever the reader happens to be standing.
 *
 * **The consequence is that a player standing in a practice zone during a live round now sees the feed**,
 * which is new and worth stating rather than leaving to be discovered. Before the round-wide feed they could
 * not: a hit was sent to the two people in it and a player in a zone is in none, so this element had nothing
 * to draw and hid itself on the empty state — the right answer then, because the list it was drawing was
 * about *them*. What it draws now is the round, and the exchanges landing among the players still in it are
 * the thing somebody who has stepped out of the fight wants to watch. **Hiding it in a zone is a one-term
 * change if it reads as clutter there** — `inPracticeZone` is published already, and is the fact the dock
 * hides on — but the honest predicate for a round's feed is the round's phase, and the element only appears
 * at all once a hit has landed.
 *
 * **The empty state is to hide, and what "empty" means is now about the round rather than about you.** The
 * element is hidden while it has no rows, which for a feed means "no hit has landed yet in this round" — so
 * a round's opening seconds are bare, and the first hit anywhere brings the list up. **A player who joins
 * mid-round sees it**, which is the opposite of what the previous personal design did, and it is worth
 * stating because it is the case that looks like a bug from the inside: they were never in any of the
 * round's earlier hits, but the feed is not about them, so the next hit anybody lands shows them the list —
 * with no history, because the earlier hits were broadcast before they connected and there is nowhere to
 * catch up from. **That is also why there is no "am I on a side" term in the predicate**: the feed is not a
 * fact about the local player at all any more, so the element comes up whether this client can be hit or
 * not.
 *
 * **The update is text writes rather than a rebuild, and the cards are the reason it still works.** There
 * are **five cards, made once and never destroyed**, and they are *slots*: the card in position *n* shows
 * entry *n*, and `paint` writes the two names and their two colours into it. A hit therefore costs **no
 * instances at all** — no card is created, destroyed or reparented — and the writes are five per card, so
 * twenty-five for a full feed, with the one write to `anyHits` beside them. **What that costs is said
 * rather than discovered**: the five cards exist from the frame the element mounts, so an element that is
 * hidden for most of its life still holds fifty-four instances (the count is on `addCard`), and a
 * card that falls out of the feed is hidden rather than removed, so its text is stale until `paint` next
 * writes over it. Both are paid once per round; a rebuild would put the garbage collector and a layout pass
 * on the frames where several hits land in the same second, which is the worst possible moment for either.
 *
 * **A row leaves in one of two ways, and the second is a clock.** The cap is one: a sixth hit pushes the
 * oldest row off the back, so a loud round shows the most recent five whatever their age. The other is
 * {@link ROW_LIFETIME_SECONDS} — **a row is on screen for ten seconds and then goes**, whether or not
 * anything has happened since, which is what keeps a feed a feed rather than a growing scoreboard. The two
 * are independent and either can win: a row in a quiet round lives its full ten seconds, and a row in a loud
 * one is pushed out in two. Neither is a fallback for the other.
 *
 * **The clock is measured by adding up what `task.wait` returned, not by reading one**, and that is the
 * house rule rather than a preference: `os.clock` reports *CPU* time in this engine — a trap this codebase
 * has been caught by once, written up in `ThrowProbe.ts` and worked around in `LoadingScreenController` —
 * and the value `task.wait` returns *is* the elapsed time, so there is nothing a clock would tell us more
 * accurately. Each entry therefore carries its own `age` and the sweep adds the real wait to all of them, so
 * a frame that ran long ages every row by what it actually took rather than by the interval that was asked
 * for.
 *
 * **A hidden card costs the layout nothing, and that is checked rather than hoped for.** The engine's own
 * `GuiObject.Visible` documentation says an invisible element "will be ignored by layout structures such as
 * `UIListLayout`… the space that the element would otherwise occupy in the layout is used by other elements
 * instead" — so five cards collapse to whatever is actually in the feed without any of them being
 * unparented, and the stack's automatic height follows. **That fact is what makes hiding a card the empty
 * state rather than a gap**, and it is why nothing here needs a "collapse this" branch.
 *
 * **The windows are the client's, and `RoundService`'s log is still not read here.** The two look like the
 * same thing and are not: that log is *the round's* record, kept until the next round opens so the result
 * panel can be told about it, and its cap is a window over the whole round. This is a *feed* with a clock on
 * it — a row is retired after ten seconds whether or not the round has moved on — and no window the server
 * keeps can answer "what landed in the last ten seconds", because that is a question about *when* and the
 * log holds only *what*. So each client ages its own rows from the stream it is being sent, and the log
 * keeps its own job as the round's record. **That both caps happen to be five is a coincidence of the two
 * briefs and not a shared rule** — one is a space limit on a record and one is a row count on a HUD, and
 * moving either should not be read as moving the other.
 *
 * **What was checked in that corner, since a collision was suspected.** The coin readout is at `(12, 64)`
 * and is the only neighbour; nothing else is near it. The score bar and the round-status line are both *top
 * centre* (`AnchorPoint` `(0.5, 0)`, insets `4` and `44`), the dock is bottom centre, the cooldown card is
 * bottom left and the Super HUD and the toasts own the bottom centre — see `hudToast.ts`, whose geometry is
 * all about the bottom of the screen. `TOP_INSET` is written as the coin readout's bottom edge plus a gap
 * rather than as a number of its own.
 */
@Controller()
export class HitLogController implements OnStart {
	public onStart(): void {
		// Spawned rather than done inline: mounting waits for `PlayerGui`, and a controller's `onStart` is
		// the wrong place to hold up the rest of the client's boot — as every HUD here does it.
		task.spawn(() => this.mount());
	}

	private mount(): void {
		const scope = Fusion.scoped();
		const theme = hudTheme();

		// **The feed, newest first, as a plain array rather than Fusion state.** Nothing draws from it
		// reactively: `paint` writes the cards when a hit arrives or when a row ages out, which is a handful
		// of times a second at most, so there is no graph to keep in step and no `Computed` re-running over
		// an array that changed by one element. What *is* reactive is the two facts the visibility is made
		// of — the shared `roundPhase` and `anyHits` below — and both are `Value`s.
		const feed: FeedEntry[] = [];

		/**
		 * Whether the feed has anything in it — **the second half of the visibility, and the empty state.**
		 *
		 * It is written in exactly three places, all of which have just changed the feed: a hit arriving,
		 * the sweep expiring the last row, and the clear when the phase leaves `Playing`. That is not
		 * tidiness — it is what keeps it from being able to disagree with the list it describes, which is
		 * the same arrangement `roundPhase` has with the attribute it mirrors.
		 */
		const anyHits = Fusion.Value(scope, false);

		// The heading is a child of the same layout as the cards, so it is numbered with them: the default
		// sort is by name, and a card called "Card1" would sort above one called "Heading" whatever order
		// they were created in.
		const heading = Text(scope, { text: FEED_HEADING, variant: HEADING_VARIANT });
		heading.Name = "Heading";
		heading.LayoutOrder = 0;
		// Written onto the returned label rather than passed as a prop: big-ui's `Text.color` is a palette
		// *vocabulary* — `"primary"`, `"errorMain"` — resolved against big-ui's own palette, and this ink is
		// the theme's. The default would also have been drawn at `Transparency.textPrimary` (0.13); a
		// heading over a bright arena wants all of its ink.
		heading.TextColor3 = theme.colors.textPrimary;
		heading.TextTransparency = 0;

		const cards: HitCard[] = [];

		/**
		 * Whether the whole element should be on screen: **a round is being played, and a hit has landed in
		 * it.**
		 *
		 * **Both `use()` calls are hoisted to the top**, as every `use()` must be: `use(a) && use(b)` would
		 * subscribe to whichever ran first and stop watching the other the moment it said no.
		 */
		const visible = Fusion.Computed(scope, (use) => {
			const playingNow = use(roundPhase) === PLAYING;
			const hasHitsNow = use(anyHits);

			return playingNow && hasHitsNow;
		});

		const frame = Fusion.New(scope, "Frame")({
			Name: "HitLog",
			// **A fixed width with an automatic height, and the split is the layout.** The element is a
			// column of cards that grows downwards, so height is the axis that has something to say and
			// width is what the two names have to fit into — the opposite of the usual HUD, and the reason
			// `CARD_WIDTH` is a number rather than something the content decides. Each card fills this
			// width, so one number reaches all five.
			Size: new UDim2(0, CARD_WIDTH, 0, 0),
			AutomaticSize: Enum.AutomaticSize.Y,
			Position: new UDim2(0, EDGE_INSET, 0, TOP_INSET),
			BackgroundTransparency: 1,
			Visible: visible,
		});

		// **This frame lays its children out itself, and it is the only frame here that does.** It is a
		// plain frame, so a `UIListLayout` is what turns a heading and five cards into a column — the same
		// arrangement the cards' own rows make one level down, with `Card`'s layout playing the part the
		// stack's does here.
		const layout = new Instance("UIListLayout");
		layout.FillDirection = Enum.FillDirection.Vertical;
		layout.SortOrder = Enum.SortOrder.LayoutOrder;
		layout.Padding = new UDim(0, CARD_GAP);
		layout.Parent = frame;

		heading.Parent = frame;

		for (let index = 0; index < ROW_COUNT; index++) {
			const card = this.addCard(scope, theme, index + 1);
			cards.push(card);
			card.card.Parent = frame;
		}

		// **Every descendant is levelled, not just the frame**, and that is a rule rather than tidiness:
		// Roblox draws a child above its parent only when the child's `ZIndex` is at least the parent's, so
		// a card left at the default under a frame carrying this number would be drawn behind it. This is
		// the helper the panels use for the same reason, called once the tree exists. See `HIT_LOG_Z_INDEX`
		// for the number and what it sits under.
		raiseZIndex(frame, HIT_LOG_Z_INDEX);

		// `CARD_WIDTH` is 280px at the left edge, so a viewport narrower than that pushes the element off
		// the right of the screen — and a HUD in a corner has nowhere to give way but its own width. The same
		// rule as every other HUD, applied for the same reason: the element carries its own bound rather
		// than trusting the screen to be big enough. See `addViewportConstraint` for the two caps.
		addViewportConstraint(scope, frame);

		frame.Parent = getHudScreenGui();

		/**
		 * **The clear: the phase leaving `Playing`.**
		 *
		 * The server clears its own log at the *opening* of a round, which is the next boundary after the
		 * hits it holds — so clearing here when the phase stops being `Playing` is the same moment seen from
		 * this side, and the difference is invisible: the element is hidden for the whole intermission (see
		 * `visible` above), so whether the feed empties when the round ends or when the next one starts is
		 * not something anybody can observe. What is observable is that a fresh round cannot open on the last
		 * round's hits, and that is what this does. It is also the third of the three ways a row leaves: the
		 * cap, the clock, and the end of the round.
		 *
		 * **An `Observer` on the shared value rather than a connection to `ROUND_STATE_ATTRIBUTE`**, and that
		 * is the one thing about this controller worth reading twice. `panels.ts` exists so that the HUDs do
		 * not each hold their own subscription to the same attribute — one subscription per reader for one
		 * fact is the thing it was written to prevent — and `roundPhase` is that module's mirror of this
		 * attribute. **A `Value` cannot be asked for an *edge*, though**: `use()` gives the current value and
		 * nothing in this Fusion version exposes "it changed" on a `Value`, which is what an `Observer` is
		 * for. So this is the *only* reader of the phase that watches the value rather than the attribute,
		 * deliberately, and the two facts it needs — the state, for visibility, and the transition, for the
		 * clear — come from one subscription instead of two.
		 *
		 * **Clearing on the way out rather than on the way in is what makes it total.** A client that watched
		 * a round end and then watched the next one start takes this path; a client that mounted during an
		 * intermission has an empty feed already, and a client that joined mid-round has only ever been sent
		 * hits from their own join onwards. There is no window in which a stale pair can reach the screen.
		 */
		Fusion.Observer(scope, roundPhase).onChange(() => {
			if (Fusion.peek(roundPhase) === PLAYING) return;

			feed.clear();
			this.paint(feed, cards, theme);
			anyHits.set(false);
		});

		/**
		 * **A hit has landed somewhere in the round, and this is the feed.** Every client is sent every hit
		 * — see `networking.ts` on `roundHit` — so there is no decision to make about whether it concerns
		 * this player: the round's hits are the round's hits, and the list is the same on every machine.
		 * That is the whole of what changed when this stopped being two personal lists; the old version
		 * compared both names against `Players.LocalPlayer.Name` here and dropped anything that was not
		 * about the local player, and with the comparison gone this element has no idea who is playing it.
		 *
		 * **The direction is checked rather than trusted**, because the wire is not typed: only two strings
		 * are meaningful, and a third means this build and the server disagree about the vocabulary.
		 */
		events.Client.Get("roundHit").Connect((hitter, victim, direction) => {
			if (direction !== "AtoB" && direction !== "BtoA") return;

			// **Newest first, capped**, which is the whole of the record-keeping: the arrival goes on the
			// front, and a sixth row pushes the oldest off the back. The cap is the first of the two ways a
			// row leaves — see the class doc.
			feed.unshift({ hitter: hitter, victim: victim, direction: direction, age: 0 });

			if (feed.size() > ROW_COUNT) feed.pop();

			this.paint(feed, cards, theme);
			anyHits.set(feed.size() > 0);

			if (DEBUG) print(`[HUD] hit feed — ${hitter} → ${victim} (${feed.size()} row(s))`);
		});

		// The second way a row leaves, and the only one on a clock.
		this.watchLifetime(feed, cards, anyHits, theme);

		if (DEBUG) print(`[HUD] hit feed up — ${ROW_COUNT} rows, ${ROW_LIFETIME_SECONDS}s each`);
	}

	/**
	 * A card, ready to be filled: **this is where the instance count is decided, so here it is.**
	 *
	 * Ten instances each: `Card` builds its own frame, corner, padding, list layout and — at
	 * `elevation: 1` — its `UIStroke` (five), this method adds the row frame and the row's horizontal layout
	 * (two, because `Card`'s own layout is vertical and the row is the thing that is not), and three text
	 * labels go in the row (three). Five cards are **fifty**, and the element is **fifty-four**: the frame, its
	 * own `UIListLayout`, the heading label and the viewport constraint are the other four. **All of it is made
	 * once** at mount and nothing below this line is ever destroyed; see the class doc for why the cards are
	 * slots rather than one per hit.
	 *
	 * **Hidden until it has something to say**, which is the empty state at the card's own level: a fresh
	 * round is five invisible cards under a heading that is itself hidden with them.
	 *
	 * **Card's `size` is deliberately not passed**, which is the same trick `RoundStatusController` uses and
	 * for the same reason: `Card` auto-sizes its height *only* when it is given no size at all, and passing
	 * one pins the box and turns that off — so the card is as tall as its row, and no amount of text can be
	 * clipped by a box that was sized before the text existed. Its width comes from the fill below.
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
		// `ScoreHudController`, which states the rule and the failure it prevents. It is also why there is no
		// row height to tune: a row is one line of `NAME_VARIANT`, whatever that variant's line height is.
		for (const label of [hitter, separator, victim]) {
			label.Size = UDim2.fromOffset(0, 0);
			label.AutomaticSize = Enum.AutomaticSize.XY;
		}

		// The names' colours are not set here: they change with every pair, and `paint` is the one place
		// they are written. What is fixed for the card's whole life is the arrow's ink and the fact that the
		// names are fully opaque — a half-transparent name would mix with the fill and the contrast the
		// class doc computes would no longer be the contrast on screen.
		hitter.TextTransparency = 0;
		victim.TextTransparency = 0;

		const card = Card(scope, {
			// The fill, the padding and the hairline, in that order. `background` names the theme's paper
			// rather than taking big-ui's default, because the fill is a *decision* here — it is what buys
			// the contrast — and a decision a reader can see beats one inherited from a library. The padding
			// is a theme token rather than one of this file's pixels: it is the same inset every card in the
			// project uses, and 8px at today's spacing scale. See the size map in the report.
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
	 * Writes `entries` into the five cards — **the whole rendering pass, and it is text writes rather than a
	 * rebuild.**
	 *
	 * **A dumb render of a list into fixed cards**, which is why it can be this short: the state is the
	 * feed, this is the only thing that reads it, and card *n* always shows entry *n*. Every entry past the
	 * end hides its card, so the same call handles "five hits", "two hits" and "no hits" without a branch
	 * between them — and since a hidden card is ignored by the layout, that *is* the collapse. It is called
	 * from three places — a hit arriving, a row ageing out, the round ending — because all three change the
	 * list and none of them should be able to draw a different list from the others.
	 *
	 * **The colours come from the direction alone, and this is the whole of that rule.** `"AtoB"` means the
	 * hitter was on A and the victim on B, so one string decides both inks and the names are only ever the
	 * *text*. That is the payoff from friendly fire being off: the two labels cannot come out the same
	 * colour, so a card is always readable as "this side hit that side" rather than as two words.
	 *
	 * **`TextColor3` is written onto the returned labels rather than passed to `Text`.** big-ui's
	 * `Text.color` is a palette *vocabulary* — `"primary"`, `"errorMain"` — resolved against big-ui's own
	 * palette, so a team colour could not travel through it; the instance is where a `Color3` goes, which is
	 * what every other HUD here does. The fallback to `textPrimary` is for a label `teamColourOf` does not
	 * know, which the log cannot produce and the loose attribute reads elsewhere in this project are written
	 * to tolerate anyway.
	 */
	private paint(entries: FeedEntry[], cards: HitCard[], theme: HudTheme): void {
		for (let index = 0; index < ROW_COUNT; index++) {
			const held = cards[index];

			// The end of the feed reached: the card keeps its place and loses its contents.
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
	}

	/**
	 * Ages every row and retires the ones past their life — **the second of the ways a row leaves, and the
	 * only one on a clock.**
	 *
	 * **A sweep rather than a timer per row**, and the trade is worth stating because the alternative is the
	 * obvious one: `FreezeService.freeze` schedules a `task.delay` per body and uses the entry object itself
	 * as the identity it checks when the timer fires, which is right there because a *freeze* has to end at
	 * a particular moment (the anchor comes off, the body can move again) and being late is a visible fault.
	 * A row of a feed has no such moment: it is gone the next time anything is drawn, so one loop ageing
	 * every row costs less bookkeeping than five timers, and — the reason it is the better shape — **it
	 * cannot leave a timer behind for a row that has already gone**, which is the bug the identity check in
	 * `freeze` exists to prevent rather than a hazard this file would have to copy.
	 *
	 * **Nothing on screen, nothing to age.** While the feed is empty the whole cost of the loop is one
	 * comparison every {@link SWEEP_SECONDS}; when it is not, it is a walk over at most {@link ROW_COUNT}
	 * entries and a repaint that only happens when something actually expired.
	 *
	 * **The oldest row is the last one**, because arrivals are unshifted onto the front and all rows age at
	 * the same rate — so "the oldest is not yet due" is a single comparison against the back of the list, and
	 * it is the common case. Once the oldest *is* due, the back of the list is walked until an unexpired row
	 * is found, which is where the sweep stops: everything in front of it arrived later and is younger.
	 *
	 * **This loop is never stopped, and it does not need to be.** A Flamework controller lives for the
	 * session and nothing here is torn down, so there is no owner to cancel it for; what it holds is one
	 * array of at most {@link ROW_COUNT} entries, and it sleeps between every look.
	 */
	private watchLifetime(
		feed: FeedEntry[],
		cards: HitCard[],
		anyHits: Fusion.Value<boolean>,
		theme: HudTheme,
	): void {
		task.spawn(() => {
			while (true) {
				// The elapsed time is what the wait *returned* rather than what it was asked for — the rule
				// the class doc gives, and the reason a hitch ages every row by what it really took.
				const waited = task.wait(SWEEP_SECONDS);

				if (feed.size() === 0) continue;

				for (const entry of feed) entry.age += waited;

				const oldest = feed[feed.size() - 1];
				if (oldest.age < ROW_LIFETIME_SECONDS) continue;

				for (let index = feed.size() - 1; index >= 0; index--) {
					if (feed[index].age < ROW_LIFETIME_SECONDS) break;

					feed.remove(index);
				}

				this.paint(feed, cards, theme);
				anyHits.set(feed.size() > 0);

				if (DEBUG) print(`[HUD] hit feed — ${feed.size()} row(s) left after ${ROW_LIFETIME_SECONDS}s`);
			}
		});
	}
}
