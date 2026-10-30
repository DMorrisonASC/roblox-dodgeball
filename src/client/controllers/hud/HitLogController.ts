import { Controller, OnStart } from "@flamework/core";
import { Card, Text } from "@rbxts/big-ui";
import type { TypographyVariant } from "@rbxts/big-ui";
import Fusion from "@rbxts/fusion-3.0";
import { Players } from "@rbxts/services";
import { events, HitDirection } from "shared/networking";
import { logDebug } from "shared/logger";
import { killCamActive, PLAYING, roundPhase } from "../../panels";
import { raiseZIndex } from "../../ui/panelChrome";
import { getHudScreenGui } from "../../ui/screenGui";
import { HudTheme } from "../../ui/hudTheme";
import { applyGlow } from "../../ui/glow";
import { PREMIUM, premiumHudTheme } from "../../ui/premiumTheme";
import { addViewportConstraint } from "../../ui/viewportConstraint";

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
 * The width of the element, and therefore of **every card in it**, in pixels.
 *
 * **210, and it is the old `280` scaled by the text change rather than re-measured.** 280 was sized for
 * `body1` — 16px — fitting two twenty-character usernames and the arrow on one line with room to spare. The
 * variant is now `caption` (12px, see {@link NAME_VARIANT}), which is three quarters of that, so
 * `280 × 12/16 = 210` keeps exactly the relationship the 280 was chosen for. A width left at 280 would have
 * been a card holding a caption line with a third of itself empty, which is the opposite of what this pass
 * is for.
 *
 * It is one number rather than one per card on purpose: the cards are a vertical stack, and a width that
 * changed with the longest name in it would make the column twitch on every hit. **Change this and every card
 * changes width**, because each card fills the stack (`Size = (1, 0, …)`) rather than carrying the number
 * itself.
 */
const CARD_WIDTH = 210;

/**
 * How see-through a card's fill is, as `Frame.BackgroundTransparency` — **`0.6`, the middle of the 0.5–0.7
 * the brief asked for.**
 *
 * **Written onto the card after it is built, because big-ui's `Card` has no transparency prop.** `CardProps`
 * is `{ children, size, padding, elevation, background, layoutOrder, childGap }` — read out of the installed
 * typings rather than remembered — and the fill is set from `background`, a `Color3`. A `Color3` has no alpha
 * in Roblox, so the half of "semi-transparent" that a colour cannot carry has to be the instance's own
 * property. That is also how every other translucent surface in this project does it:
 * `CurrencyHudController`, `DockController` and `enemyView` all write `BackgroundTransparency` on the frame
 * after building it. See {@link addCard}, which is where this is applied.
 *
 * **Why 0.6 and not the palette's `PREMIUM.transparency` (0.15).** That token is this project's "glass" for
 * panels a player *opens* and reads — a shop sheet, a dock — where the surface has to hold its own against
 * the game behind it because there is text to read on it for as long as it is open. This element is the
 * opposite: a corner readout of what just happened, up for ten seconds a row, which the brief asked to be
 * quieter than a panel. 0.15 would have been indistinguishable from the opaque card it replaces.
 *
 * **What it costs is contrast, and the ink pays for it.** Team-coloured names on a fill that lets the arena
 * through are the case the palette's brightened side colours exist for — see {@link paint}.
 */
const CARD_TRANSPARENCY = 0.6;

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
 * **`caption` — 12px — because the brief asked for a caption-sized readout, and this is the whole of what
 * that means.** The ladder was walked twice in the other direction: this element shipped at `caption`, was
 * raised to `body1` (16px) when *"too small"* was the report, and is back at `caption` now that the brief is
 * for something small. **The two reports are not in conflict** — 16px was right for an opaque card that was
 * meant to be read mid-fight, and 12px is right for a translucent corner readout that is meant to be glanced
 * at. What changed is the element's job, not anybody's eyesight.
 *
 * **`caption` is also the size every other transient line in this project is drawn at**, which is the
 * stronger reason: `notifications.ts` reads this exact variant out of `premiumHudTheme().typography` for its
 * toasts, and `HEADING_VARIANT` below has always been `caption`. A feed of hits is the same kind of thing as
 * a toast — something that happened, said once, then gone — so it is drawn at the same size rather than at a
 * size of its own.
 *
 * **Naming it still costs nothing and buys the whole of the size knob**: a variant is the *only* thing that
 * decides the glyph height here, so changing this line changes the names, the row heights, the card heights
 * and the whole stack's height at once. **The numbers themselves are big-ui's**, not this file's —
 * `Typography` is a mutable table that `configureTheme` writes and that `ThemeController` has already run
 * by the time anything mounts, so a project-wide type change is the place to move them and this line is the
 * place to pick one.
 */
const NAME_VARIANT: TypographyVariant = "caption";

/**
 * The typography the heading is drawn in. **`caption` — 12px — because a heading is a label rather than a row**:
 * it names the list and gets out of the way.
 *
 * **It is no longer a size below the rows, and that is a consequence worth stating rather than hiding.** While
 * the names were `body1` this was the smaller of the two, which is what made "does not compete with the names"
 * true. Both are `caption` now, so **the heading is held back by its two other differences instead**: it is one
 * short line against rows of two coloured names, and it is the only label in the element that is never team
 * coloured. Size is no longer the mechanism; the ink is.
 */
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
 * the arrangement `notifications.ts` and `SuperHudController` describe for the bottom of the screen, where
 * the permanent power column owns the edge and the notifications stack above it. Nothing else is drawn in
 * this corner; see the class doc for what was checked.
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
	/**
	 * **Which way the hit went, or `undefined` when there is no side to say.**
	 *
	 * `"AtoB"` / `"BtoA"` come from `roundHit`, whose payload carries the direction because the server derived
	 * it from the two people's teams. A row built from `hitImpact` has no direction at all: that event is about
	 * a *body being hit*, its ends may be rigs, and it deliberately carries no sides. See the class doc's
	 * "which hits reach this list" section — the two cases are drawn differently on purpose, and `undefined`
	 * is how a row says it does not know rather than guessing a side.
	 */
	readonly direction: HitDirection | undefined;
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
 * **Whether `name` is a person's** — asked of the names in the game, and the test `hitImpact`'s rows are
 * filtered with.
 *
 * **A name comparison rather than an instance lookup, because a name is all the event carries.** `hitImpact`
 * sends the victim's and thrower's *model* names, and a player's character is named after the player, so the
 * two are the same string for every body a person is behind — which is the same identity
 * `Players.GetPlayerFromCharacter` walks to, spelled the way the wire spells it.
 *
 * **A rig is not in this set**, which is the whole point: a pooled rig is named from the spawn pool
 * (`GiantDiva`) and a hand-built one is named by whoever built it, so a rig-vs-rig or player-vs-rig hit is
 * recognised as one that `roundHit` will never announce. See the class doc's "which hits reach this list".
 *
 * **Linear over the roster rather than a `Set`**, deliberately: this is asked at most twice per landed hit, on
 * a roster of at most a handful of players, and a cached set would have to be invalidated on every join and
 * leave — a subscription for a lookup this cheap.
 */
function isPlayerName(name: string): boolean {
	for (const player of Players.GetPlayers()) {
		if (player.Name === name) return true;
	}

	return false;
}

/**
 * The hit feed: **every hit landed in the round, by anyone, newest first**, at the top left of the screen
 * while a round is being played. One translucent card per row, two names to a card, each row living ten
 * seconds.
 *
 * ## Which hits reach this list, and why it is two events rather than one
 *
 * **Every hit in the round, which is not the same set as `roundHit`.** That event is the *record's*: its
 * payload carries a direction so a row can be painted in two team colours, and `RoundService.logHit` sends it
 * only when **both ends are people on a side** — a rig's throw and a ball that lands on a rig therefore send
 * nothing, and in a round played against rigs those are most of the hits in it. That was the report: a round
 * of rigs produced a feed with almost nothing in it, because the feed was subscribed to an event gated on a
 * condition the game does not require.
 *
 * **So this listens to `hitImpact` as well — the event that already fires for every hit, whoever either end
 * was.** It is the same event `hitVfx` draws the burst from and `hitConfirm` the splash, and it carries the
 * two names this element needs. **The pair is not drawn twice, and the rule that prevents it is a fact rather
 * than a guess**: `hitImpact`'s two names are *resolved to players* — the victim's model name and the
 * thrower's — so a hit with a person at both ends is exactly the pair `roundHit` is about to announce, and
 * this file drops it. Anything else has at least one rig in it, `roundHit` will never mention it, and the
 * `hitImpact` row is the only chance it gets. **Neither event is filtered on the server for this, and
 * `roundHit`'s payload, its sender and the round's own record are all untouched.**
 *
 * **And a `hitImpact` row is only taken while a round is being played, which `roundHit` does not need to be
 * asked about.** The two events are gated differently on the server — `hitImpact` is deliberately sent in
 * every phase, because an impact is a fact about a body and its other two readers are cosmetic — while
 * `roundHit` is gated by `RoundService` itself. A feed is a round's, so the missing half of that gate is
 * supplied here: a ball landing on a practice dummy in the lobby is an impact, and it is not a hit in a round.
 * Without this, a lobby hit would sit in the array unseen and then appear for the first seconds of the next
 * round — the one way a stale row can reach the screen.
 *
 * **What a rig row looks like, and why its names are one ink.** Two names, the same arrow, and no team
 * colours — `hitImpact` carries no sides, and inventing them here would be a second derivation of a fact the
 * server declined to state. **The names are what the server already sends**: the victim's and thrower's model
 * names, which for a pooled rig is its short alias (`GiantDiva`, not `GiantDiva's rig clone 3`) and for a
 * person is their username, so nothing is truncated and nothing is abbreviated. A name long enough to matter
 * wraps inside the card rather than overflowing — see `addCard`'s `Wraps` note.
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
 * **Every row is two names and an arrow, and only some rows can colour them.** Friendly fire is refused
 * globally, before any damage, by `RoundService.isFriendlyFire` — `BallComponent` calls it ahead of the tag, so
 * a same-side contact is not merely undamaging but *absent*: no bounce, no tag, no hit and therefore no log
 * entry. So **every hit has one end on each side** — but the sides only reach this client on `roundHit`, whose
 * payload carries a direction. A row built from `hitImpact` has two names and no sides, because that event's
 * ends may be rigs and it deliberately carries nothing it does not need. Those rows are drawn in one ink and
 * the arrow still says which way the hit went. See "which hits reach this list" below.
 *
 * **The colours are the palette's side pair, not the world's, and that split is `ScoreHudController`'s.** The
 * score bar draws its two team *discs* in `teamColourOf` — the same value that paints a body's ring in the
 * arena, so the colour on the HUD and the colour on the character are one thing — and its two *numbers* in
 * `PREMIUM.sideA` / `PREMIUM.sideB`, the palette's brightened versions of the same two teams. This element
 * draws no world-shaped thing at all: there is no disc, no ring and no body, only two names. So it belongs on
 * the text side of that split, and it used to be on the wrong side — `teamColourOf` returns the *world*
 * values, `(158, 58, 52)` and `(56, 92, 152)`, which are muted enough to read as an outline on a character and
 * are **the wrong inks for a translucent card**: against the mid-dark a 0.6-transparent black produces over a
 * bright arena floor, the world red lands at roughly 1:1 and effectively disappears. The palette's pair is the
 * one member set that keeps the two team identities against a dark ground, which is exactly what
 * `premiumTheme.ts` says it is for.
 *
 * **No side is named in words**, which is the rule the score HUD's circles were built on: the colour is the
 * identity, and a label saying which team it is would be a second vocabulary for a fact already on the screen.
 *
 * **The cards are semi-transparent, and this is a reversal of a long argument that is worth reading rather
 * than deleting.** It said: the theme is light, so an opaque card is a cream slab pinned over the arena, which
 * is the loudest thing on screen for the least information on it — all true — and it made legibility the thing
 * that paid for the quiet, because a transparent card shows whatever is behind it through the one part of the
 * element that has to be read, and the two names are mid-dark team colours chosen to survive being an *outline*
 * on a body rather than text on an arbitrary background. The arithmetic it did (6.8:1 and 6.7:1 against
 * paper, 3.1:1 against black) was right about the colours it had. **Two things then changed underneath it**:
 * the HUD moved to the dark premium palette, so the card stopped being paper at all, and the brief for this
 * element became "semi-transparent and caption-sized" — a corner readout, not a panel. Both halves of the old
 * argument were answered rather than overruled: the inks are now the palette's *brightened* side pair
 * specifically because the fill is translucent, and the fill is `0.6` rather than a decorative `0.15` because
 * the element still has to be readable. **The cost is stated**: on a very bright backdrop the names are less
 * crisp than they were on paper, and the thing paying for it is a glow edge on the card and an ink that was
 * chosen to survive a dark ground.
 *
 * **The fill is `hudTheme`'s `panel` at {@link CARD_TRANSPARENCY}** — the raised surface, the colour big-ui's
 * own `Card` fills itself with, and in the premium palette the near-black "deep space" step. `theme.colors.card`
 * is the other candidate and is one step *up* in lightness, the face of the thing on the sheet; a card floating
 * over the game has no sheet above it to cut into, so the panel is the honest one. **No colour was added to
 * `hudTheme` for this**, and none is needed.
 *
 * **`elevation: 1`, so each card carries the one-pixel hairline big-ui draws at its own divider
 * transparency.** That is not decoration: a *translucent* card over a bright sky has even less of an edge of
 * its own than an opaque one had, and a stack of them with no edge reads as one ragged smudge. `elevation: 0`
 * would take the stroke away — right for a card that is *fully* transparent, because an outline around nothing
 * is a floating rectangle, and wrong here, where there is still a fill to bound. The alternative was a cast
 * shadow from `ui/elevation.ts`, and that is refused on purpose: that helper is the *furniture* hierarchy, for
 * the dock's buttons and the shop's panels — things a player presses and opens — and a readout that looks
 * pressable is a readout that invites a click.
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
 * has been caught by once, written up in `ThrowProbe.ts` — and the value `task.wait` returns *is* the
 * elapsed time, so there is nothing a clock would tell us more accurately. Each entry therefore carries its own `age` and the sweep adds the real wait to all of them, so
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
 * bottom left and the power column and the notifications own the bottom centre — see `notifications.ts`,
 * whose geometry is all about the bottom of the screen. `TOP_INSET` is written as the coin readout's bottom
 * edge plus a gap rather than as a number of its own.
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
		// **Answered from the game palette**, so every card's fill and every label below follows it — see
		// `premiumHudTheme`. The typography and the spacing are still `hudTheme`'s, because they are big-ui's.
		const theme = premiumHudTheme();

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
		// heading over a bright arena wants all of its ink — **and now that the card behind it is the palette's
		// deep space at 0.6, "all of its ink" is the theme's `0.15`**, which is the direction's text rule rather
		// than a per-label call. See `PREMIUM.textTransparency` and {@link CARD_TRANSPARENCY}.
		heading.TextColor3 = theme.colors.textPrimary;
		heading.TextTransparency = PREMIUM.textTransparency;

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

			// **And nothing while a kill cam is shooting.** The feed is a list of names and outcomes over the
			// left of the screen, which is the half a cinematic shot is composed on; the overlay the cam draws
			// says everything about the body in frame, which is the question a feed cannot answer. Hidden and not
			// torn down, so `anyHits` and every card are still there when it returns — see `panels.ts`.
			const watchingNow = use(killCamActive);

			return playingNow && hasHitsNow && !watchingNow;
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

		// `CARD_WIDTH` is 210px at the left edge, so a viewport narrower than that plus {@link EDGE_INSET}
		// pushes the element off the right of the screen — and a HUD in a corner has nowhere to give way but its
		// own width. The same rule as every other HUD, applied for the same reason: the element carries its own
		// bound rather than trusting the screen to be big enough. See `addViewportConstraint` for the two caps.
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

			logDebug(`[HUD] hit feed — ${hitter} → ${victim} (${feed.size()} row(s))`);
		});

		/**
		 * **The second source of rows: every hit `roundHit` cannot describe.** A rig's throw, a ball landing on
		 * a rig — the hits a round against rigs is mostly made of, and the ones the feed used to miss entirely.
		 * See the class doc's "which hits reach this list" for the whole argument; the two rules here are the
		 * short version of it.
		 *
		 * **A pair with a person at both ends is dropped, and that is what stops every hit being drawn twice.**
		 * The comparison is against the names of the players in the game, because `hitImpact`'s names are model
		 * names and a player's character is named after them — the same identity, spelled the same way, and the
		 * same fact `BallComponent`'s catch branch leans on when it asks `Players.GetPlayerFromCharacter`. A rig
		 * is named from the spawn pool or by whoever built it, so it is not in that set.
		 *
		 * **It is the *pair* rather than either end**, and the difference matters: a player's throw that lands on
		 * a rig is one name from each, which `roundHit` will never announce, so it has to get through.
		 */
		events.Client.Get("hitImpact").Connect((victim, thrower) => {
			if (Fusion.peek(roundPhase) !== PLAYING) return;

			// The same two names `roundHit` would have carried, in which case the row there is the better one:
			// it has a direction, so it can be painted in two colours.
			if (isPlayerName(thrower) && isPlayerName(victim)) return;

			feed.unshift({ hitter: thrower, victim: victim, direction: undefined, age: 0 });

			if (feed.size() > ROW_COUNT) feed.pop();

			this.paint(feed, cards, theme);
			anyHits.set(feed.size() > 0);

			logDebug(`[HUD] hit feed — ${thrower} → ${victim} (a rig was in it, ${feed.size()} row(s))`);
		});

		// The second way a row leaves, and the only one on a clock.
		this.watchLifetime(feed, cards, anyHits, theme);

		logDebug(`[HUD] hit feed up — ${ROW_COUNT} rows, ${ROW_LIFETIME_SECONDS}s each`);
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
		separator.TextTransparency = PREMIUM.textTransparency;
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
		// names take the theme's text alpha — **which is `0.15` rather than `0`**. An earlier version of this
		// comment argued that a half-transparent name would mix with a translucent fill and lose the contrast it
		// computes. That objection is answered rather than ignored, and by the two things that changed: the fill
		// is now actually translucent ({@link CARD_TRANSPARENCY}), and the names are drawn in the palette's
		// *brightened* side pair rather than the world's, which is the ink that was chosen for a dark ground —
		// see `paint`. The alpha is what every other label in this direction is drawn at, and a full-ink name
		// would be the only thing in the element shouting.
		hitter.TextTransparency = PREMIUM.textTransparency;
		victim.TextTransparency = PREMIUM.textTransparency;

		const card = Card(scope, {
			// The fill, the padding and the hairline, in that order. `background` names the theme's panel
			// rather than taking big-ui's default, because the fill is a *decision* here — it is what the two
			// names are read against — and a decision a reader can see beats one inherited from a library. In the
			// premium palette this is the deep-space step, and its see-through-ness is set on the instance below.
			// The padding is a theme token rather than one of this file's pixels: it is the same inset every card
			// in the project uses, and 8px at today's spacing scale. See the size map in the report.
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

		// **The half of "semi-transparent" that a colour cannot carry.** `CardProps.background` is a `Color3`, and
		// a `Color3` has no alpha, so the fill's see-through-ness is the instance's own property — written here
		// rather than passed, because big-ui's `Card` exposes no prop for it. See {@link CARD_TRANSPARENCY} for the
		// number and for the three other surfaces in this project that do the same thing.
		card.BackgroundTransparency = CARD_TRANSPARENCY;

		// **The neon edge, over big-ui's own hairline.** `applyGlow` takes that stroke over as the core rather than
		// adding a second one — see `ui/glow.ts` — which is what lets a card this file did not build be lit. On a
		// translucent fill it is doing more work than it was: the edge is now what separates a card from the arena
		// behind it, since the fill no longer does.
		applyGlow(card);

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
	 * **The colours come from the direction alone when there is one, and a row without one says so.**
	 * `"AtoB"` means the hitter was on A and the victim on B, so one string decides both inks and the names are
	 * only ever the *text*. That is the payoff from friendly fire being off: the two labels cannot come out the
	 * same colour, so a card is always readable as "this side hit that side" rather than as two words.
	 * **A row with no `direction` is a rig's hit**, where `hitImpact` carried no sides — see the class doc — and
	 * both names take the theme's own ink. Two names in one colour is the honest drawing of a fact the server did
	 * not state: the alternative would be to guess a side from a body the client happens to be able to resolve,
	 * which would be a second answer to a question `RoundService` answers for the hits it covers, and a different
	 * answer for the ones it does not.
	 *
	 * **The inks are `PREMIUM.sideA` / `PREMIUM.sideB` rather than `teamColourOf`**, which is `ScoreHudController`'s
	 * split and the reason this element's names are readable at all on a translucent fill — see the class doc's
	 * colour paragraph for the whole of that argument and the contrast it fixes.
	 *
	 * **`TextColor3` is written onto the returned labels rather than passed to `Text`.** big-ui's
	 * `Text.color` is a palette *vocabulary* — `"primary"`, `"errorMain"` — resolved against big-ui's own
	 * palette, so a `Color3` could not travel through it; the instance is where a `Color3` goes, which is
	 * what every other HUD here does.
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
			const direction = entry.direction;
			const hitterColour =
				direction === undefined ? theme.colors.textPrimary : direction === "AtoB" ? PREMIUM.sideA : PREMIUM.sideB;
			const victimColour =
				direction === undefined ? theme.colors.textPrimary : direction === "AtoB" ? PREMIUM.sideB : PREMIUM.sideA;

			held.card.Visible = true;
			held.hitter.Text = entry.hitter;
			held.hitter.TextColor3 = hitterColour;
			held.victim.Text = entry.victim;
			held.victim.TextColor3 = victimColour;
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

				logDebug(`[HUD] hit feed — ${feed.size()} row(s) left after ${ROW_LIFETIME_SECONDS}s`);
			}
		});
	}
}
