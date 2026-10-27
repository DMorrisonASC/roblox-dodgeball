import { Players, ReplicatedStorage } from "@rbxts/services";
import {
	CELEBRATING_ATTRIBUTE,
	ROUND_STATUS_FOLDER,
	ROUND_WINNER_ATTRIBUTE,
	TEAM_ATTRIBUTE,
} from "shared/constants";
import { styleSplashText } from "./ui/actionSplash";
import { getHudScreenGui } from "./ui/screenGui";

/**
 * **The word that tells a player how the round they just played went: `VICTORY`, `DEFEAT` or `DRAW`.**
 *
 * **Why it exists.** The celebration hold is `ARENA_CONFIG.CELEBRATION_SECONDS` of arena with nothing being thrown,
 * and until this file the only thing on screen for it was a coin toast in the bottom corner. A player knocked out
 * three seconds before the whistle — which is most of them, in every elimination mode — had no way to tell whether
 * their side won without reading a small line at the top of the screen, so the ten seconds read as the game pausing
 * rather than as a result. The one sentence a round owes every participant is whether they won it, and it is worth the
 * middle of the screen for the length of the hold.
 *
 * **A plain module rather than a Flamework controller, and the whole of `main.client.ts` is the argument.** Every
 * sibling that watches an attribute and draws a word is one of these — `perfectDodge`, `catchPrompt`,
 * `returnToLobby`, `hitConfirm` — because Flamework records an exported class in `flamework.build` whether or not it is
 * decorated, and a class here would buy nothing: there is no lifecycle to own, nothing to inject, and one subscription
 * to hold. The brief for this pass suggested a controller; this is the shape the file that would have started one is
 * made of, so the deviation is deliberate and the wiring is a single call at the bottom of that file.
 *
 * **Two attributes are read, and they answer two different questions.** `CELEBRATING_ATTRIBUTE` says *when* — the
 * round is over and the arena is being held, which is the only window this word belongs in. `ROUND_WINNER_ATTRIBUTE`
 * says *what* — the side that won, or `"draw"`. Neither can stand in for the other: the winner is written on the same
 * line the round is decided and stays on the folder for the whole intermission that follows (it is cleared at the next
 * round's *start*, not at the hold's end), so a word drawn off it alone would still be on screen while the lobby
 * transition ran. And the celebrating flag alone says nothing about who won. **One of them is the window and the other
 * is the answer**, which is why both are read and why the hide is driven by the first rather than by a timer.
 *
 * **The third read is the local player's own `TEAM_ATTRIBUTE`**, because "won" is not a fact about the round — it is a
 * fact about *this player and* the round. The same round is a victory for one side and a defeat for the other, and
 * neither the winner attribute nor the celebrating flag can express that on its own.
 *
 * **A player with no side sees nothing at all**, and that is a decision rather than an oversight. `TEAM_ATTRIBUTE` is
 * absent for somebody who never opted in and for a player whose body has not arrived, and both of those are spectators
 * rather than losers: `DEFEAT` over the screen of somebody who was watching would be the HUD inventing a result they
 * were not part of. A *surrendered* player does keep their side — the roster deliberately holds them, because a win is
 * still a win if their side won without them — so they get the word their participation earned.
 */

/**
 * **The share of the HUD region the word's box takes, in `Scale`.**
 *
 * **A box rather than a font size, because {@link styleSplashText} sets `TextScaled`**: the letters are sized from the
 * box, so this is the whole of "how big is the word" and a `TextSize` here would be ignored.
 *
 * **`Scale` rather than pixels plus a `UISizeConstraint`, which is where this differs from every other fixed-pixel HUD
 * measured in this client.** Those take pixels because their *contents* need a definite width — a big-ui panel, a
 * toasts' column — and then cap themselves against the viewport so a phone does not get a desktop-width element. A
 * centered word has no such requirement: it is one line of text whose size is derived from its box, so a proportional
 * box is the correct thing to hand it and no cap is needed or asked for. 86% across leaves a margin at both ends for
 * the outline, which is drawn *outside* the glyphs and would otherwise be clipped at the box's edge.
 *
 * **Placeholder.**
 */
const WORD_WIDTH_FRACTION = 0.86;
const WORD_HEIGHT_FRACTION = 0.26;

/**
 * **The rung this word sits on**, and it is the top of the HUD plane rather than a number picked to be safely large.
 *
 * The ladder inside `HudGui` is: the hit log and the power stack at `1`, the arena countdown at `2`, the score plate at
 * `4`, the dock at `5`, the AFK card at `10` and the notification stack at `11`. **`12` is one above the highest of
 * those**, which is the only claim worth making: nothing transient may draw over the result of a round. Above it is
 * `MatchStatsController`'s marker at `100` — an annotation on a *body* in the world, which belongs on top.
 */
const CELEBRATION_Z_INDEX = 12;

/**
 * **The outline's thickness, which is not the splash's `4`.**
 *
 * `styleSplashText`'s default is set for the action splash's 150-pixel box. This one is 240, so the same *relative*
 * weight is about six pixels — the same reasoning `actionSplash` gives for the catch prompt's `2` at a 26-pixel box.
 * Getting this wrong is not subtle: an outline tuned for a smaller word reads as a dark halo on a large one.
 * **Placeholder.**
 */
const WORD_STROKE_THICKNESS = 6;

/**
 * **The label `ROUND_WINNER_ATTRIBUTE` carries when neither side won.**
 *
 * **Written out rather than imported, and the duplication is forced rather than sloppy.** The authority is `DRAW` in
 * `server/services/round/team.ts`, which the client cannot reach: it is server code, it compiles into the server's
 * script tree, and a client require of it would fail at run time rather than at compile time. `shared/gameMode.ts`
 * already records that the winner label is `"A"`, `"B"` or `"draw"` and that turning one into a sentence is the
 * client's side of the line — this constant is that sentence's edge, and it is the one place the client spells the
 * word. A rename on the server is a rename here; the two name each other in their comments so the pair is findable.
 */
const DRAW_LABEL = "draw";

/** Where the word currently is, once it has been built. `undefined` until the first celebration needs it. */
let shown: { readonly frame: Frame; readonly label: TextLabel } | undefined;

/**
 * **What this player should be told about `winner`, or `undefined` for "say nothing".**
 *
 * **The draw is tested first, and the order is load-bearing.** `"draw"` is a value `ROUND_WINNER_ATTRIBUTE` holds and
 * is not equal to either side's label, so a check written the other way round — "does the winner match my side" first
 * — would tell **both** teams they lost a drawn round. Draw first, then the comparison, then defeat.
 *
 * **An empty string is "no result", not a loss.** The attribute is cleared at the start of every round, so a client
 * that mounts mid-round or reads the folder in a stale window sees it; treating that as a defeat would put `DEFEAT`
 * over somebody during a round they are still playing.
 */
function wordFor(winner: string, side: string | undefined): string | undefined {
	if (side === undefined) return undefined;
	if (winner === "") return undefined;
	if (winner === DRAW_LABEL) return "DRAW";

	return winner === side ? "VICTORY" : "DEFEAT";
}

/**
 * **Builds the label once, on the first celebration that needs it, and answers it.**
 *
 * **Lazily, for the reason `notifications.ts` gives for its own stack**: a client that never finishes a round — a
 * server running one match all evening under a player who is practising — should not carry an invisible 900×240 frame
 * around for the session. The first celebration pays for the frame, and every one after it writes a `Text` and a
 * `Visible`.
 *
 * **It is never destroyed**, and it does not need to be: {@link styleSplashText} draws no background, so the resting
 * state is a label with an empty `Text` inside a frame that is not visible. `Visible = false` is what keeps it out of a
 * screenshot and out of a reader's way.
 *
 * **The frame is centred on the safe region rather than the screen**, which is `getHudScreenGui`'s region on purpose —
 * this is a HUD element and not a cover, so it belongs under Roblox's chrome rather than over it. The transition wipe
 * is the cover in this game's vocabulary and it has a `ScreenGui` of its own for exactly that difference.
 */
function build(): { readonly frame: Frame; readonly label: TextLabel } {
	const frame = new Instance("Frame");
	frame.Name = "CelebrationWord";
	frame.AnchorPoint = new Vector2(0.5, 0.5);
	frame.Position = new UDim2(0.5, 0, 0.5, 0);
	frame.Size = UDim2.fromScale(WORD_WIDTH_FRACTION, WORD_HEIGHT_FRACTION);
	frame.BackgroundTransparency = 1;
	frame.Visible = false;
	frame.ZIndex = CELEBRATION_Z_INDEX;
	frame.Parent = getHudScreenGui();

	const label = new Instance("TextLabel");
	label.Name = "Word";
	label.Size = UDim2.fromScale(1, 1);
	label.ZIndex = CELEBRATION_Z_INDEX;
	label.Parent = frame;

	// **The project's splash style, unchanged**, which is what makes this read as the same game as the `HIT!` splash:
	// `TextScaled`, so the box is the design decision, and a contextual stroke round the glyphs so the word survives a
	// bright court behind it. The letters stay the theme's ink for the reason `actionSplash` sets out — the *word*
	// carries the meaning, not the colour, and this game already spends red on team A.
	styleSplashText(label, { strokeThickness: WORD_STROKE_THICKNESS });

	return { frame, label };
}

/** Shows `word`, building the label if this is the first time anything has been celebrated. */
function show(word: string): void {
	const target = shown ?? build();

	shown = target;

	target.label.Text = word;
	target.frame.Visible = true;
}

/** Puts the word away. Silent when there is nothing to put away, which is the ordinary case on a fresh client. */
function hide(): void {
	if (shown !== undefined) shown.frame.Visible = false;
}

/**
 * **Wires the word to the round's own two attributes. Called once, from the client's boot.**
 *
 * **The subscription comes before the seed read**, the order `RoundStatusController` uses and for its reason: a
 * celebration that began between the two lines would be lost by a seed written the other way round, and a seed that
 * runs after the subscription simply reads the newer value and wins.
 *
 * **Both attributes are subscribed, not just the phase one.** The winner and the celebrating flag are written on the
 * same frame by `finishRound`, and the order two attribute writes replicate in is not something this file should
 * have to reason about — so `refresh` is re-run on either change and derives from whatever the folder says at that
 * instant. The second subscription costs nothing on the ordinary frames where there is no celebration running.
 *
 * **Spawned rather than inline**, because the status folder is made by the *server* and waiting for it yields — and a
 * client boot is the wrong place to hold up everything behind a folder that is one replication behind.
 */
export function startCelebration(): void {
	task.spawn(() => {
		const status = ReplicatedStorage.WaitForChild(ROUND_STATUS_FOLDER);
		const player = Players.LocalPlayer;

		const refresh = () => {
			if (status.GetAttribute(CELEBRATING_ATTRIBUTE) !== true) {
				hide();

				return;
			}

			const winner = status.GetAttribute(ROUND_WINNER_ATTRIBUTE);
			const side = player.GetAttribute(TEAM_ATTRIBUTE);

			const word = wordFor(typeIs(winner, "string") ? winner : "", typeIs(side, "string") ? side : undefined);
			if (word === undefined) {
				hide();

				return;
			}

			show(word);
		};

		status.GetAttributeChangedSignal(CELEBRATING_ATTRIBUTE).Connect(refresh);
		status.GetAttributeChangedSignal(ROUND_WINNER_ATTRIBUTE).Connect(refresh);

		refresh();
	});
}
