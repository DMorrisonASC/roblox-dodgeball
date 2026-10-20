import { Players, Workspace } from "@rbxts/services";
import { BALL_NAME, BALL_TAGGED_TEAM_ATTRIBUTE, TEAM_ATTRIBUTE } from "shared/constants";
import { styleSplashText } from "./ui/actionSplash";

/** Prints that the prompt is up, and every ball it decides about. */
const DEBUG = false; // off for frame time — see shared/config/debug.config.ts

/** What the prompt is called, on the ball's `BillboardGui` and as the name a stray one is found by. */
const PROMPT_NAME = "CatchPrompt";

/**
 * The words, in one place because they are a promise rather than a label: a body this ball has hit can still be
 * saved by whoever catches it, and this is the only thing in the game that says so.
 */
const PROMPT_TEXT = "CATCH IT!";

/**
 * The prompt's box, in **pixels**, and the one pair of numbers to move if it reads wrong. **Placeholder.**
 *
 * **Pixels rather than studs**, which is the difference between a `BillboardGui` and a part: `Size` here is a
 * screen-space box that does not shrink with distance the way the ball does, so the prompt stays legible from
 * across the arena — which is the whole point, because the catch has to be made by somebody the ball is not
 * currently touching. `TextScaled` then fills whatever box this is.
 */
const PROMPT_WIDTH = 80;
const PROMPT_HEIGHT = 26;

/**
 * How far above the ball the box floats, in **studs, in world space**. **Placeholder.**
 *
 * A ball is a stud across, so an offset smaller than its own radius puts the word through the ball. Three and a
 * half studs clears it at any camera angle while keeping the word clearly attached to *that* ball rather than
 * floating between two of them — a MultiBall throw can put five in the air at once.
 */
const PROMPT_STUDS_OFFSET = 3.5;

/**
 * How thick the outline is, in pixels. **Placeholder — 2.**
 *
 * **The one thing the shared style cannot default for two callers**, which is why `styleSplashText` takes it as
 * an argument: an outline is a proportion of the word rather than a distance. The splash's own number
 * (`SPLASH_STROKE_THICKNESS` in `ui/actionSplash.ts`) is 4 for a word 150 pixels tall; this box is 26, so the
 * outline has to be thinner or it closes up the counters of the letters. Two is the same proportion at this size.
 */
const PROMPT_STROKE_THICKNESS = 2;

/**
 * **The `CATCH IT!` prompt: a piece of text that hangs over a live ball which has hit somebody on the local
 * player's side, and over nothing else.**
 *
 * **What it is for, in one sentence.** A ball that has bounced off a teammate is still in the air and still owes
 * that teammate a death; catching it before it lands releases every tag and turns the throw against the thrower.
 * That is a *second* chance, offered in a window of perhaps half a second, and until this module nothing on
 * screen said it existed — the victim saw an effect on their own body and the ball flew away.
 *
 * **Read from one attribute on the ball, and from nothing else.** `BallComponent` writes
 * {@link BALL_TAGGED_TEAM_ATTRIBUTE} at the moment of the tag and clears it on every path the tag can end — the
 * world resolution, a catch, and a re-arm — so "the attribute holds a side" *is* "this ball owes somebody on
 * that side a death, right now". There is no event, no remote and no per-throw state here: each client watches
 * the balls in `Workspace` and answers the same question for itself.
 *
 * **Only the tagged side sees it, and that is a rule about information rather than about loyalty.** The victim
 * and their teammates are the only people who can make the save, so they are the only people the prompt is
 * addressed to. The thrower's side sees nothing at all, which is also why this is an attribute on the ball
 * rather than anything sent to "everybody": a client with no matching `TEAM_ATTRIBUTE` never builds a box.
 *
 * **Not a splash and deliberately not animated.** The letters are styled by `styleSplashText` in
 * `ui/actionSplash.ts` — the same white-on-outline look as the `HIT!` caption — but it is the *style* that is
 * shared, never the animation: that one is a caption that flashes and leaves, and this is a label that stays
 * while its cause is true. Nothing here tweens, pops or fades. It is not that the pop was forgotten —
 * `createActionSplash` exists for a caller that wants one — it is that a prompt appearing with a flourish would
 * be announcing an event, and there is no event: the ball is simply still in the air.
 *
 * **Built in code rather than cloned from a template.** Unlike `hitVfx`'s effects, this is a piece of UI with one
 * string in it and no authoring left to do: a `BillboardGui`, a `TextLabel` and a `UIStroke`, all of which the
 * theme already describes. A template would be a second place to keep the colour and the font in step.
 */
export function startCatchPrompt(): void {
	const player = Players.LocalPlayer;

	// Said at boot, for `hitVfx`'s reason: a module with a subscription and no controller around it is started by
	// hand from `main.client.ts`, and a prompt that never appears and one that was never wired print the same
	// nothing.
	if (DEBUG) print(`[HUD] catch prompt up — "${PROMPT_TEXT}" over a ball that has tagged my side`);

	/** Every live ball this module has attached a listener to, so a side change can re-answer for all of them. */
	const watched = new Set<BasePart>();

	/** The prompts currently on screen, one per ball — the record that makes showing one idempotent. */
	const shown = new Map<BasePart, BillboardGui>();

	/**
	 * This client's side, or `""` when they have none.
	 *
	 * `TEAM_ATTRIBUTE` lives on the **`Player`** and is written by the round at every whistle, cleared at every
	 * boundary — see its own doc. An empty string is therefore "not in a round", and a spectator is shown no
	 * prompt at all, which is right: they cannot catch anything.
	 */
	const myTeam = (): string => {
		const value = player.GetAttribute(TEAM_ATTRIBUTE);
		return typeIs(value, "string") ? value : "";
	};

	const clear = (ball: BasePart): void => {
		const gui = shown.get(ball);
		if (gui === undefined) return;

		shown.delete(ball);
		gui.Destroy();
	};

	/**
	 * Shows or hides the prompt for one ball — **the only place that decides**, so every trigger (the attribute
	 * changing, the side changing, a ball appearing) ends in the same answer.
	 */
	const refresh = (ball: BasePart): void => {
		const tagged = ball.GetAttribute(BALL_TAGGED_TEAM_ATTRIBUTE);
		const team = myTeam();

		// `<team> !== ""` first, because `"" === ""` would otherwise show the prompt to an untagged ball on a
		// client with no side at all.
		const wanted = team !== "" && typeIs(tagged, "string") && tagged === team;

		if (!wanted) {
			clear(ball);
			return;
		}

		// Already up: the attribute has not changed what it says — a re-arm and a re-tag inside one throw both
		// land here — so the box is left alone rather than rebuilt.
		if (shown.has(ball)) return;

		shown.set(ball, build(ball));
	};

	/** Attaches the two listeners to one ball, and answers for it immediately. */
	const watch = (instance: Instance): void => {
		// **By name, because that is what a ball is called and there is no shared tag for one.** `BALL_NAME` is
		// the shared constant every ball carries — `BallFactory` sets it — and the server's own `isBall` accepts
		// it too. A non-ball `BasePart` never reaches the attribute listener, which is what keeps this cheap:
		// the arena's parts are all `DescendantAdded` at load.
		if (!instance.IsA("BasePart") || instance.Name !== BALL_NAME) return;
		if (watched.has(instance)) return;

		watched.add(instance);

		instance.GetAttributeChangedSignal(BALL_TAGGED_TEAM_ATTRIBUTE).Connect(() => refresh(instance));

		// **The one cleanup that cannot be forgotten.** A ball is destroyed by `Debris`, by a pickup and by a
		// round boundary — three routes, none of which this module hears about — but every one of them takes the
		// ball out of the tree first, so the ball's own `AncestryChanged` is the single hook that covers all
		// three.
		instance.AncestryChanged.Connect(() => {
			if (instance.Parent !== undefined) return;

			watched.delete(instance);
			clear(instance);
		});

		refresh(instance);
	};

	Workspace.DescendantAdded.Connect(watch);

	// Balls that already exist when this module starts. There should be none — the game stocks the arena after
	// every client is up — but a client that reloaded mid-round would otherwise be blind to the balls already in
	// the air, which is exactly when the prompt matters.
	for (const descendant of Workspace.GetDescendants()) watch(descendant);

	// **A side can change while a ball is in the air** — a round starting, or a player switching sides — and the
	// answer for a ball already on screen is no longer the old one. Re-answering for every watched ball is
	// enough: the ones that should now show are the ones this client may now catch.
	player.GetAttributeChangedSignal(TEAM_ATTRIBUTE).Connect(() => {
		for (const ball of watched) refresh(ball);
	});
}

/**
 * One prompt, hung over `ball`.
 *
 * **Parented to the ball rather than to `PlayerGui`**, and that is the second half of the cleanup: a child of the
 * ball is taken with it when the ball is destroyed, so the `AncestryChanged` hook above is a belt for a
 * suspender that already holds. `Adornee` is still set, because a `BillboardGui` is drawn at its adornee's
 * position whether or not it is parented to it.
 *
 * **The style is `ui/actionSplash.ts`'s, and this file is half the reason it was extracted.** White letters in
 * `UI_FONT`, `TextScaled` to fill the box, centred both ways, a `UIStroke` in `ApplyStrokeMode.Contextual` —
 * **`Contextual` is the load-bearing half**, because `Border` strokes the label's own rectangle, which on an
 * invisible label is a box around nothing.
 *
 * **Styling only, and `styleSplashText` is the right half of the module to call.** `createActionSplash` is the
 * one that can pop, and a prompt that popped would be claiming *something happened* about a ball that is still
 * in the air — see this file's header for why the prompt is deliberately still.
 */
function build(ball: BasePart): BillboardGui {
	const gui = new Instance("BillboardGui");
	gui.Name = PROMPT_NAME;
	gui.Adornee = ball;
	// Over the world rather than behind a wall: the prompt is a rule about a ball the player may not be able to
	// see clearly, and a word hidden by a barrier is a rule nobody hears about.
	gui.AlwaysOnTop = true;
	// Not lit by the arena, for the same reason the splash is not part of the world's palette: this is UI, and
	// the one thing it must never do is become unreadable in a dark corner.
	gui.LightInfluence = 0;
	gui.Size = UDim2.fromOffset(PROMPT_WIDTH, PROMPT_HEIGHT);
	gui.StudsOffsetWorldSpace = new Vector3(0, PROMPT_STUDS_OFFSET, 0);

	const label = new Instance("TextLabel");
	label.Name = "Word";
	label.Size = UDim2.fromScale(1, 1);
	// Font, colour, `TextScaled`, the two alignments, the transparent background and the stroke all come from
	// here — **so a palette change is one file rather than a search for every label that copied it**. The only
	// thing this call decides is the stroke's weight, because an outline is a proportion of the word rather than
	// a distance: 4 pixels around a 150-pixel caption and 2 around a 26-pixel one are the same outline.
	styleSplashText(label, { strokeThickness: PROMPT_STROKE_THICKNESS, text: PROMPT_TEXT });

	label.Parent = gui;
	gui.Parent = ball;

	return gui;
}
