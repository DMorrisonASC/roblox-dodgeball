import { Controller, OnStart } from "@flamework/core";
import { Card, Text } from "@rbxts/big-ui";
import Fusion from "@rbxts/fusion-3.0";
import { ReplicatedStorage } from "@rbxts/services";
import {
	ROUND_MODE_ATTRIBUTE,
	ROUND_SCORE_A_ATTRIBUTE,
	ROUND_SCORE_B_ATTRIBUTE,
	ROUND_STATE_ATTRIBUTE,
	ROUND_STATUS_FOLDER,
	ROUND_TIME_ATTRIBUTE,
} from "shared/constants";
import { GAME_MODE_NAMES, isGameModeId, sideNameOf } from "shared/gameMode";
import { DEBUG_LOGGING, logInfo } from "shared/logger";
import { mercyWarningFor } from "../../mercyWarning";
import { PLAYING } from "../../panels";
import { applyGlow, applyTextGlow } from "../../ui/glow";
import { PREMIUM } from "../../ui/premiumTheme";
import { getHudColumn } from "../../ui/screenGui";
import { addViewportConstraint } from "../../ui/viewportConstraint";

/*
 * **The band does not position itself any more, and the number that used to say where it went is gone with the
 * pair it belonged to.** It was `HUD_TOP_INSET`, and its doc argued at length that it was "half of a pair"
 * whose other half was `SCORE_TOP_INSET` in `ScoreHudController` — two offsets from the same origin in the same
 * GUI, which had to differ by the height of the score plate or the plate would be drawn across the clock. Both
 * were `14`. **What replaced them is one offset on the column the two readouts share** — see `getHudColumn` in
 * `ui/screenGui.ts`, which owns it and has the whole of that story — and the distance between the band and the
 * plate above it is now the layout's business rather than a second number to keep in step.
 *
 * **The region-versus-offset lesson that doc ended with is still worth knowing, and it is written down in that
 * file**: `ScreenInsets` chooses the region a GUI draws in, and only an offset moves something within it. It is
 * why the band is in the shared GUI rather than in one of its own — the three revisions it spent trying are
 * recorded there, next to the `ScreenInsets` value they settled on.
 */

/**
 * How wide the HUD is, and **its height is its content's**. See {@link getHudColumn} for where it sits.
 */
const HUD_WIDTH = 100;

/**
 * How opaque the board behind the line is, in every phase: the number this HUD has always used between rounds.
 *
 * **It used to be half of a pair, and the pair is what this comment is about.** The other half was
 * `BOARD_TRANSPARENCY_IN_PLAY`, whose value was `1` — the board *removed* — and the phase chose between them:
 * a card while a round was being waited for, bare text over the arena once it was under way. **The argument
 * for the removal was about what is behind the line**: during a round the screen is the arena, a player is
 * watching the pitch and this is a clock they glance at rather than read, so a cream slab pinned over that view
 * is the loudest thing on screen for the least information on it.
 *
 * **What overruled it is the pair rather than that argument.** The readout above this one is a solid plate in
 * every phase — it was the first of the two to be made permanent — so for the whole of a round the HUD was one
 * filled slab and one bare line stacked in the same column: two treatments for two halves of one fact. And the
 * switch itself lands at the one moment a player is looking at the pitch rather than at the HUD, which is where
 * a shape that changes reads as the HUD breaking rather than as something being trimmed for their sake. One
 * value, no phase in it, and nothing left to keep in step.
 *
 * **What this is not: a fade.** Both phase changes in this game happen behind the transition cover —
 * `TRANSITION_CONFIG.WIPE_AT_ROUND_END` sends one at the end of a round as well as the start — so a fade would
 * hide nothing and would leave the board *partly* there for a third of a second. Nothing here eases anything.
 *
 * **`0` since the "Premium Sports" pass — fully opaque, and the change is the rule rather than the number.** The
 * board was `0.3` of the light palette's paper, then `0.15` of plum, and both were films over the arena; the
 * direction's second look asked for a *broadcast graphic*, which is never something the game shows through. On the
 * solid plum the gold hairline and the gold clock both hold their contrast, which is the same fact from the other
 * side. The value is the theme's so every panel moves together. See `ui/premiumTheme.ts`.
 */
const BOARD_TRANSPARENCY = PREMIUM.transparency;

/**
 * The round HUD: the clock and the mode while a round is being played, and the name of the phase otherwise.
 *
 * **The number is the round's, and the first sentence of this doc used to promise it in both phases.** It is
 * shown only while `Playing`, because that is the only phase with a length: an intermission is a wait whose
 * clock wraps, so a figure there would be a countdown to nothing that began again every sixteen seconds. The
 * slot it leaves is filled by the phase name, which is the one thing an intermission has to say. See the line's
 * own comment, where that decision and the two readers of the intermission's clock are written down.
 *
 * **It looks the same in both phases, and that is a change.** The board under the line used to come off for the
 * whole of a playing phase, leaving the text floating over the arena, and **that split is gone**: the card is up
 * whenever the line is, and its paint is no longer a function of the phase at all. The argument the removal was
 * made on, and what overruled it, are written where the value is — see {@link BOARD_TRANSPARENCY}.
 *
 * **It reads nothing but the folder it was pointed at.** The phase and the clock are two
 * attributes on `RoundStatus` in `ReplicatedStorage`, written by the server and replicated by
 * the engine — so this controller needs no remote, no service, and no knowledge of
 * `RoundService`, and the round needs no knowledge of this beyond the two names in
 * `shared/constants`. That is the whole reason the state is published as attributes rather
 * than sent: the channel is the state, and there is nothing to keep in step.
 *
 * Fusion holds the UI up. The attributes are pushed into `Value`s by their changed signals, a
 * `Computed` turns those into the one line of text, and big-ui's `Text` observes it — so
 * nothing here re-renders anything by hand, and the label cannot show a stale pair.
 */
@Controller()
export class RoundStatusController implements OnStart {
	public onStart(): void {
		// Spawned rather than done inline: the folder is made by the *server's* `onStart`, so
		// waiting for it can yield — and a controller's `onStart` is the wrong place to hold up
		// the rest of the client's boot for something that is not ready yet.
		task.spawn(() => this.mount());
	}

	private mount(): void {
		const status = ReplicatedStorage.WaitForChild(ROUND_STATUS_FOLDER);
		const scope = Fusion.scoped();

		const state = Fusion.Value(scope, "Intermission");
		const time = Fusion.Value(scope, 0);
		const mode = Fusion.Value(scope, "");
		const scoreA = Fusion.Value(scope, 0);
		const scoreB = Fusion.Value(scope, 0);

		// Subscribed *before* seeding, so a change landing between the two is not lost — the seed
		// then reads the newer value and wins, which is the order that cannot go wrong either way.
		//
		// Both connections are handed to the scope, which is what one-scope-per-controller buys:
		// the subscriptions are cleaned up with the UI they feed rather than outliving it.
		scope.push(
			status.GetAttributeChangedSignal(ROUND_STATE_ATTRIBUTE).Connect(() => {
				const value = status.GetAttribute(ROUND_STATE_ATTRIBUTE);
				if (typeIs(value, "string")) state.set(value);
			}),
		);

		scope.push(
			status.GetAttributeChangedSignal(ROUND_TIME_ATTRIBUTE).Connect(() => {
				const value = status.GetAttribute(ROUND_TIME_ATTRIBUTE);
				if (typeIs(value, "number")) time.set(value);
			}),
		);

		scope.push(
			status.GetAttributeChangedSignal(ROUND_MODE_ATTRIBUTE).Connect(() => {
				const value = status.GetAttribute(ROUND_MODE_ATTRIBUTE);
				if (typeIs(value, "string")) mode.set(value);
			}),
		);

		// **The two scores, read for the mercy line and for nothing else.** The clock and the mode would be the whole
		// of this controller's business if the warning were only a toast — but the lead that triggers it *stands*, and
		// a faded toast leaves a player no way back to the fact. See {@link mercyWarningFor}, which owns when that
		// warning is standing so that this line and the toast cannot disagree.
		//
		// **These are the same two attributes `ScoreHudController` reads, and that is the accepted shape rather than a
		// leak.** `mercyWarning.ts` argues it at its own length against the boot's note on `hitVfx` and `hitConfirm`:
		// two subscribers to one fact, neither knowing the other exists. What is *not* copied is the rule — the band
		// asks the same function the toast asks.
		scope.push(
			status.GetAttributeChangedSignal(ROUND_SCORE_A_ATTRIBUTE).Connect(() => {
				const value = status.GetAttribute(ROUND_SCORE_A_ATTRIBUTE);
				if (typeIs(value, "number")) scoreA.set(value);
			}),
		);

		scope.push(
			status.GetAttributeChangedSignal(ROUND_SCORE_B_ATTRIBUTE).Connect(() => {
				const value = status.GetAttribute(ROUND_SCORE_B_ATTRIBUTE);
				if (typeIs(value, "number")) scoreB.set(value);
			}),
		);

		// Seeded from what the server has already said, because the folder exists before this
		// runs: without it the HUD would sit on its defaults until the next change, and on a
		// countdown that is a whole second of a number nobody set.
		const initialState = status.GetAttribute(ROUND_STATE_ATTRIBUTE);
		if (typeIs(initialState, "string")) state.set(initialState);

		const initialTime = status.GetAttribute(ROUND_TIME_ATTRIBUTE);
		if (typeIs(initialTime, "number")) time.set(initialTime);

		// Seeded like the others, and here it matters most: the mode is written once — when a vote
		// closes — rather than every second, so a client that mounted after that write would never
		// see it if this only listened for changes.
		const initialMode = status.GetAttribute(ROUND_MODE_ATTRIBUTE);
		if (typeIs(initialMode, "string")) mode.set(initialMode);

		const initialScoreA = status.GetAttribute(ROUND_SCORE_A_ATTRIBUTE);
		if (typeIs(initialScoreA, "number")) scoreA.set(initialScoreA);

		const initialScoreB = status.GetAttribute(ROUND_SCORE_B_ATTRIBUTE);
		if (typeIs(initialScoreB, "number")) scoreB.set(initialScoreB);

		// The HUD's entire content, derived rather than assembled: it re-reads every value it needs
		// whenever any of them changes, and never has to be told that it should.
		//
		// **The wording is built here, on the client.** The server publishes a phase, a clock and a
		// mode id; turning those into a sentence is presentation, and presentation that only ever has
		// one consumer — a label — belongs on the machine drawing the label. See `GAME_MODE_NAMES`,
		// which is the one place a mode is named.
		const text = Fusion.Computed(scope, (use) => {
			// **Every value is read before any branching, and that is not tidiness.** Fusion decides
			// what a `Computed` depends on from the `use` calls that actually *run*, so a read placed
			// inside an `if` is a subscription that only exists while that branch is taken. All three
			// up front makes the subscription set fixed, whatever the line ends up saying.
			const phase = use(state);
			const seconds = use(time);
			const modeId = use(mode);

			// **The line is the clock and the mode, and the phase name stands in only where there is no clock to
			// show.** A round is a length of time and its clock is the thing a player watches; an intermission is a
			// *wait* — the server holds one until a match is asked for, and its clock therefore **wraps** rather
			// than reaching zero (`RoundService.gameLoop` restarts it at its full length each time it runs out), so
			// a figure there would be a countdown to nothing. The word `Playing` is not said at all any more: it
			// named a state nobody could be in doubt about, and leaving it out puts the figure the eye is looking
			// for at the front of the line. **This reverses what this comment used to say** — the line was the
			// phase with the clock hung off it, and `Intermission` was the label the figure sat under — and the
			// reversal is the user's call rather than a correction of that argument.
			//
			// **The intermission's clock is still published and still read; nothing else about it moves.** Its
			// figure is what `MusicController` times the intermission's fade out with, so this is one sentence
			// on one label rather than a change to the round. (It was also what `RoundResultController` measured
			// its dismissal deadline against; that panel is gone, and the badges it was replaced by are cleared
			// by `BadgeService`'s own fifteen-second clock rather than by this figure.) **And a third face used
			// to live here** — `Waiting for players — n/min`, for an intermission frozen below the minimum —
			// which went when the clock became the whole line; what stands here now is the opposite decision
			// taken in the same place.
			let line = phase === PLAYING ? `${seconds}s` : phase;

			// The mode, appended once one has been named. **Where this comment used to say it named the round *to
			// come* between the vote closing and the round beginning, and that stopped being true**:
			// `ROUND_MODE_ATTRIBUTE` is written at the round boundary (`RoundService`, where the vote that could
			// have published it earlier sits behind `VOTE_ENABLED = false`), so during an intermission the name on
			// screen is the mode of the round that has just *finished*. That is a fact about the writer rather
			// than about this line, and it is recorded at the attribute's own declaration.
			const known = isGameModeId(modeId);

			if (known) line = `${line}`;
			// if (known) line = `${line} | ${GAME_MODE_NAMES[modeId]}`;

			// **The winner used to be appended right here, and the rule it was appended under is the
			// part worth keeping.** What belongs on this line is the round's *state*: the phase, the
			// clock, and the mode it is being played by. A result is not a state — it is a thing to
			// be read, with a board of the round's hits under it, which is a shape no single line has
			// room for. It has a panel of its own now, and this line went back to being about the
			// round that has not started yet.
			return line;
		});

		/**
		 * **The mercy warning as a line that stands until the lead is closed — the toast's fact, without the fade.**
		 *
		 * **Why a second line rather than a bigger word on the first one.** The clock is the figure a player watches to
		 * know how long a rout has to be survived, so replacing it at the exact moment the round becomes a rout is the
		 * one thing this must not do. The card already sizes itself to its content — see the note on the missing
		 * `size` at its construction — so a second line costs nothing but the pixels it occupies while it exists.
		 *
		 * **Empty rather than absent, and hidden rather than empty.** The label's text is `""` when there is nothing
		 * standing, and its `Visible` follows that — because `Card`'s own `UIListLayout` charges its `childGap` (8px)
		 * between *placed* children, so a zero-height label left visible would hold open a gap under the clock for the
		 * whole match. Invisible children are not laid out, so the band is exactly the height the clock needs whenever
		 * the warning is not standing.
		 *
		 * **The lead is the standing figure, not the threshold.** `mercyWarningFor` returns the number it judged, so a
		 * lead that crossed fifteen on a catch reads `+18` rather than `+15` — the score plate a few pixels above is
		 * the thing this must not contradict.
		 *
		 * **Every value is read before any branching**, for the reason the clock's own `Computed` gives: Fusion takes a
		 * `Computed`'s dependency set from the `use` calls that actually ran, so a read inside an `if` is a
		 * subscription that only exists while that branch is taken.
		 */
		const warningLine = Fusion.Computed(scope, (use) => {
			const phase = use(state);
			const pointsA = use(scoreA);
			const pointsB = use(scoreB);
			const modeId = use(mode);

			// **The phase is checked rather than the scores alone**, because the scores outlive the round that set
			// them by however long the server takes to clear the pair — and a band left reading `Team A +15` through
			// an intermission would be describing a round nobody is in. `mercyWarningFor` owns the window; this owns
			// whether there is a round for the window to be about.
			if (phase !== PLAYING) return "";

			const warning = mercyWarningFor(pointsA, pointsB);
			if (warning === undefined) return "";

			const name = isGameModeId(modeId) ? sideNameOf(modeId, warning.leading) : `Team ${warning.leading}`;

			return `${name} +${warning.lead}`;
		});

		/**
		 * **Whether there is anything to say, as its own `Computed` rather than a function at the `Hydrate`.**
		 *
		 * `Hydrate` takes a `UsedAs<boolean>` — a value, a `Value` or a `Computed` — and not a callback, so the
		 * question "is the line non-empty" has to be a graph object in its own right. That is the better shape anyway:
		 * it is read by the label's `Visible` and could be read by anything else that wanted to know, and its
		 * dependency is `warningLine`'s rather than a second subscription to the four attributes.
		 */
		const warningVisible = Fusion.Computed(scope, (use) => use(warningLine) !== "");

		/**
		 * **The line's colour is the leading side's, and that is meaning rather than decoration.**
		 *
		 * `premiumTheme` refuses a `warning` colour on purpose — its doc says there is no success/warning/error trio
		 * because every element the game has is one of five — and inventing one here would be a ninth colour on a
		 * palette that argues for its count. The one thing this line is *about* is a side, and the palette already has
		 * that side's colour for the score plate above, so the band and the plate say "Team A" in the same colour
		 * without a word of explanation.
		 *
		 * **No glow.** The clock's cyan halo is the sign-like treatment this direction reserves for the thing to look
		 * at; a second glowing label under it would be two things shouting. This is white-adjacent ink in the team's
		 * hue, subordinate by size.
		 */
		const warningColour = Fusion.Computed(scope, (use) => {
			const phase = use(state);
			const pointsA = use(scoreA);
			const pointsB = use(scoreB);

			const warning = phase === PLAYING ? mercyWarningFor(pointsA, pointsB) : undefined;

			return warning?.leading === "B" ? PREMIUM.sideB : PREMIUM.sideA;
		});

		const wrapper = Fusion.New(scope, "Frame")({
			Name: "Wrapper",
			Size: new UDim2(0, HUD_WIDTH, 0, 0),
			AutomaticSize: Enum.AutomaticSize.Y,
			// **The band does not put itself anywhere.** It is a child of the shared readout column, which owns
			// the offset from the top of the safe region and places the score bar first and this under it — so
			// the `Position` and `AnchorPoint` that used to be here are gone rather than left to be
			// overwritten. **The anchor being zero is load-bearing**: a `UIListLayout` writes a child's
			// `Position` but does not know about its `AnchorPoint`, so a wrapper still anchored at `(0.5, 0)`
			// would be drawn half its own width to the left of the slot the layout gave it.
			AnchorPoint: Vector2.zero,
			// The column's contract: `1` is the scores, `2` is the clock. See `getHudColumn`.
			LayoutOrder: 2,
			BackgroundTransparency: 1,
		});

		// `HUD_WIDTH` is a fixed 100px, which is the width this band has worn since the clock became the whole line
		// and is what the phase names were measured to fit — `Intermission` at the clock's 14px is the longest string
		// it ever has to hold. **This paragraph said 360 for a while after the value stopped being 360**, which is the
		// drift worth naming: the number moved and the argument for it did not. The cap below still matters for the
		// reason it always did — the band is centred, so an overflow would cost it *both* edges at once rather than
		// one, and a window dragged narrower than the band has to make the band give way rather than leave.
		addViewportConstraint(scope, wrapper);

		// **No `size` on the card, and that is the whole trick.** big-ui's `Card` auto-sizes its
		// height only when it is given no size at all — pass one and it pins the box and turns that
		// off, which is what a second line of text then falls out of. So the card is as tall as its
		// line, and the wrapper follows it, and no amount of text can be clipped by a box that was
		// sized before the text existed.
		// **Both lines are built before the card so they can be repainted afterwards**, which is the one thing about
		// this construction that is not big-ui's: `Card` takes instances rather than props, so a `Text` handed to it is
		// an instance this file still holds — and the colour and the face live on that instance rather than on the
		// card. That is what lets the clock be gold with a halo and the mercy line be the leading side's colour
		// without either being rebuilt.
		const clock = Text(scope, {
			text,
			variant: "button",
			align: Enum.TextXAlignment.Center,
		});

		/**
		 * **The mercy line, built out of the library's smallest face rather than the clock's.** `overline` is 11px
		 * GothamBold against the clock's 14 — subordinate by size, which is the ordering the fact has: the clock is
		 * the round, this is a warning about how the round is going. **The size is also the width budget**: the band is
		 * `HUD_WIDTH` pixels wide and a longer string wraps, so `Team A +15` at 11px sits on one line where the same
		 * words at 14px would take two and grow the card under the clock mid-round.
		 *
		 * **Created through `Text` and then driven by `Hydrate`, and both halves are necessary.** `Text` is what gives
		 * this label big-ui's typography and the theme's own `UIStroke`-free ink; but it takes props at construction,
		 * so `Visible` and `TextColor3` — the two things that change — cannot be handed to it as reactive values.
		 * `Hydrate` is what makes them tracked, which is the rule `panelChrome.ts` states at its length and
		 * `ArenaFreezeCountdownController` uses for its card.
		 */
		const warning = Text(scope, {
			text: warningLine,
			variant: "overline",
			align: Enum.TextXAlignment.Center,
			layoutOrder: 1,
		});

		const card = Card(scope, {
			padding: 4,
			children: [clock, warning],
		});

		/**
		 * **The board's paint, and this is where the HUD stops reading big-ui's theme.** The card arrives as the light
		 * palette's paper with big-ui's own black hairline; the in-game HUD is the plum-and-gold direction now — see
		 * `ui/premiumTheme.ts` — and this is the same surface the score plate above it wears, at the same
		 * transparency.
		 *
		 * **The stroke and the corner are *repainted* rather than added**, which is the difference between a theme and
		 * a layer. `Card` already has a `UIStroke` and a `UICorner` child of its own, and a second of either would be
		 * one border drawn over another — the layered look this direction explicitly refuses (no glow, no double
		 * stroke). Repainting big-ui's own instance is what keeps "one border" true without giving up the card's
		 * padding, which is what sizes the wrapper.
		 *
		 * **The clock is the theme's gold**, which is the colour spent on the number a round is played against: gold
		 * on plum is the highest contrast the palette has, and this is the one label on the HUD that is read rather
		 * than glanced at.
		 */
		card.BackgroundColor3 = PREMIUM.panel;

		// **The bloom, over big-ui's own hairline.** `applyGlow` reuses that stroke as the core rather than adding a
		// third one — see `ui/glow.ts`, where taking the existing stroke over is the whole reason a big-ui card can be
		// lit without being rebuilt. The corner below is still big-ui's instance, repainted.
		applyGlow(card);

		const cardCorner = card.FindFirstChildWhichIsA("UICorner");
		if (cardCorner !== undefined) cardCorner.CornerRadius = new UDim(0, PREMIUM.corner);

		clock.TextColor3 = PREMIUM.gold;
		clock.TextTransparency = PREMIUM.textTransparency;
		// **And the clock is the one label in the game that gets the full neon treatment** — cyan ink with a cyan halo,
		// which is the sign-like pair this direction exists for. See `ui/glow.ts`'s text helper.
		applyTextGlow(clock);

		// **The mercy line's three changing properties, and nothing else.** `Visible` and `TextColor3` come from the
		// two `Computed`s above and the transparency from the theme, so this is the whole of what makes the line
		// appear, name a side in that side's colour, and go away again — no connection here, no re-render, no state.
		// The same four attributes that feed the clock feed this, through the one rule in `mercyWarning.ts`.
		//
		// **`Visible` doubles as the space.** See the note at its construction: an empty label left visible would hold
		// `Card`'s 8px `childGap` open under the clock for the whole match, and an invisible one is not laid out at
		// all, so the band is exactly as tall as the clock whenever there is nothing to warn about.
		Fusion.Hydrate(scope, warning)({
			Visible: warningVisible,
			TextColor3: warningColour,
			TextTransparency: PREMIUM.textTransparency,
		});

		card.Parent = wrapper;

		/**
		 * **The board is set once, and there is no phase in it any more.**
		 *
		 * It used to be a `Hydrate`d `Computed` choosing between two transparencies by phase: the card between
		 * rounds, bare text over the arena for the whole of a playing phase. **That is the decision this replaces**
		 * — the argument for the removal was that the arena is what a player is watching during a round and a slab
		 * over it is the loudest thing on screen for the least information — and the answer to it is at
		 * {@link BOARD_TRANSPARENCY}, which is also where the number comes from.
		 *
		 * **The card was never removed, only its paint, and that distinction is why this is one line.** The card is
		 * still what pads the line and what sizes the wrapper to its content — see the note on the missing `size` at
		 * its construction — so its box was the same box in both phases and the line sat on exactly the same pixels
		 * either way. Nothing about that measurement changes here; only the paint stops changing.
		 *
		 * **A plain assignment rather than `Hydrate`, and that is the same trap in reverse.** `Card` builds its
		 * frame and hands it back, so a reactive value merely *assigned* to one of its properties is never tracked
		 * as a property at all — the rule `panelChrome.ts` states at its own length — and the reason
		 * `Hydrate` was needed here. What `Hydrate` bought was the subscription; with a constant there is nothing to
		 * subscribe to, and a `Computed` that can only ever return the one value is a subscription that cannot fire.
		 *
		 * **The border was hidden along with the fill, and the block that did that is deleted rather than left
		 * holding a constant.** `Card` draws a one-pixel black `UIStroke` at big-ui's `Transparency.divider` — about
		 * a tenth opaque, which is a hairline nobody sees around a filled card and a floating rectangle around bare
		 * text — so while the board went away for the whole of a playing phase the stroke had to go with it, or the
		 * result would have been the board gone and its edge still drawn. The card is up in every phase now, so the
		 * stroke that belongs to it is up in every phase too, and it never had to be touched to get there: this is
		 * big-ui's own border on big-ui's own card, which is the value the instance has always carried between
		 * rounds. **A `Computed` left behind to answer one value forever is worse than no code at all**, because a
		 * reader has to work out that it is dead.
		 */
		card.BackgroundTransparency = BOARD_TRANSPARENCY;

		// **Into the shared readout column, which is where a HUD element belongs.** The column is in
		// `getFullScreenGui` — see `ui/screenGui.ts`, which owns both and records why the band is not in a GUI
		// of its own, and why these two readouts are in the one GUI that is *not* gated on the device: they are
		// pinned to the top edge of the screen, and on a phone the gated region starts a topbar-plus-cutout
		// lower than it does on a desktop. Its doc also carries the point this line used to make at length:
		// `ScreenInsets` chooses the region a GUI draws in, and only an offset moves something within it.
		wrapper.Parent = getHudColumn();

		if (DEBUG_LOGGING) {
			logInfo(
				`[HUD] round status up — in the shared readout column, ` +
					`reading ${ROUND_STATUS_FOLDER} in ReplicatedStorage`,
			);
		}
	}
}
