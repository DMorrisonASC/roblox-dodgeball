import type Fusion from "@rbxts/fusion-3.0";
import { Typography } from "@rbxts/big-ui";
import type { TypographyVariant } from "@rbxts/big-ui";
import { TweenService } from "@rbxts/services";
import { hudTheme, UI_FONT } from "./hudTheme";
import { addViewportConstraint } from "./viewportConstraint";

/**
 * # The action splash — its style, and the one animation that belongs to it
 *
 * **Extracted from `hitConfirm`, because the look was already in two files and the next caller would have made
 * it three.** `hitConfirm` draws the round's captions (`HIT!`, `DOUBLE HIT!`, `TEAM WIPE!!`) and
 * `catchPrompt` draws `CATCH IT!` over a ball; the second file's own doc says it copies the first — *"white
 * letters, `UI_FONT`, `TextScaled`, a `UIStroke` in `Contextual` mode"*. What was copied is what lives here
 * now, and it is split deliberately into two things:
 *
 * - {@link styleSplashText} — **the style.** Font, colour, fit and outline, applied to any `TextLabel`
 *   anywhere. No `UIScale`, no tween, no frame: a label in a panel or a `BillboardGui` can take this.
 * - {@link createActionSplash} — **the style plus a pop.** A screen-space frame, a label styled by the
 *   function above, and the `UIScale` the animation needs, returned as an {@link ActionSplash} whose `show`
 *   is static and whose `pop` is the animation.
 *
 * **The animation is never attached to text by itself, and that is the request this file was written to.**
 * A word that pops says *something the player did*; a word that is simply there says *state* — a prompt, a
 * label, a countdown. So styling never animates, and even on an {@link ActionSplash} the animated path is
 * the one you have to ask for: `show(text)` puts a word up and leaves it, `pop(text)` plays the five steps.
 * **Nothing in this module starts a tween unless `pop` is called.**
 *
 * **The theme is the source of every value that is not geometry.** Both colours and the face come from
 * `hudTheme()` / `UI_FONT`, read **per call** rather than captured at module load — `hudTheme`'s own doc says
 * why (a value captured at load is big-ui's default rather than this project's configured theme). A caller
 * may hand in a {@link SplashStyle} of its own, and the rule that keeps a palette change to one file is that
 * such a style is still one the theme produced: **nothing here is a `Color3.fromRGB`**, and a caller that
 * writes one has stepped outside the seam this module is.
 */

/**
 * The three things about splash text that are the theme's rather than a caller's.
 *
 * **A bundle rather than three parameters**, because every caller that wants one wants all three, and because
 * a caller adding a fourth later should not have to change every signature that passes them. It is also the
 * only shape in which "read the theme once and use it for the label and its stroke" can be written as one
 * statement.
 */
export interface SplashStyle {
	/** The letters. `colors.onAccent` — white on the light theme. */
	readonly text: Color3;
	/** The outline around the letters. `colors.trough` — near-black on the light theme. */
	readonly outline: Color3;
	/** The face, which is `UI_FONT` for every splash this project draws. */
	readonly font: Enum.Font;
}

/** The theme's answer for splash text, read live. See this file's doc for why it is not a constant. */
export function splashStyle(): SplashStyle {
	const theme = hudTheme();

	return { text: theme.colors.onAccent, outline: theme.colors.trough, font: UI_FONT };
}

/** What {@link styleSplashText} may be told; every field has the action splash's own value as its default. */
export interface SplashTextOptions {
	/**
	 * How thick the outline is, in pixels. **The one thing that does not share a default sensibly**, because it
	 * is a proportion of the *word*: the action splash is 4 at a 150-pixel box and the catch prompt is 2 at a
	 * 26-pixel box, which is the same outline at the same relative weight. See `SPLASH_STROKE_THICKNESS`.
	 */
	readonly strokeThickness?: number;

	/** Defaults to {@link splashStyle}. Pass one only to reuse a style read once across several labels. */
	readonly style?: SplashStyle;

	/**
	 * Whether the style also decides **how the letters fit their box** — `TextScaled` and `TextWrapped`. Defaults
	 * to `true`, which is the splash's own answer because its box is the design decision.
	 *
	 * **`false` is for a caller whose size comes from somewhere else** — a big-ui typography variant plus a
	 * `UIScale`, as the arena-freeze countdown's numbers are. `TextScaled` there would re-derive the type size
	 * from the box on every resize and fight the `AutomaticSize.X` that box depends on; the letters, the colour
	 * and the outline are unaffected, because an outline is a stroke on the glyphs and does not care how they
	 * were sized.
	 */
	readonly fit?: boolean;

	/** The label's text, when the caller wants it set here rather than afterwards. Defaults to empty. */
	readonly text?: string;
}

/** The name of the outline this module makes, so a stray one is findable by the same name in the Explorer. */
export const SPLASH_STROKE_NAME = "Outline";

/**
 * **The style, applied to `label` — and the whole of why it looks like this.**
 *
 * **`TextScaled` is how the letters fit their box**, not how they animate: a pixel font size is one number that
 * is right on exactly one screen, so the box is the design decision and this is what makes the word fill it.
 * The animation, where there is one, scales the *box* — see {@link createActionSplash}. **`fit: false` leaves
 * both this and `TextWrapped` alone**, for a caller whose size comes from a typography variant instead — see
 * {@link SplashTextOptions.fit}.
 *
 * **The stroke is the legibility half, and it wraps the letters rather than the label.** `ApplyStrokeMode`
 * must be `Contextual`; `Border` is the other mode and it strokes the *element's own rectangle* — a label is a
 * box with a line of text somewhere inside it, so a `Border` stroke draws that box and puts nothing around the
 * glyphs at all. On anything meant to outline text the mode is always `Contextual`; `Border` is for panels and
 * buttons.
 *
 * **An outline rather than a shadow**, because what it has to survive is a bright court behind bright letters:
 * a shadow separates a word from a *dark* background, an outline separates it from any background at all.
 *
 * **The colour carries no meaning on purpose.** White letters and one near-black outline are the combination
 * that survives a bright court, a dark rig and everything between, and two outcomes told apart by their *words*
 * do not also have to teach a colour code. Both colours are the theme's, never a literal here.
 *
 * **`BackgroundTransparency = 1` is part of the style, not an oversight.** A splash's label is a word, not a
 * chip; a caller that wants a filled plate sets its own fill afterwards and has said so.
 *
 * Returns the stroke so a caller can fade it with the letters — that pairing is the animation's business and
 * {@link ActionSplash} keeps it, but a hand-rolled effect may want the handle.
 */
export function styleSplashText(label: TextLabel, options: SplashTextOptions = {}): UIStroke {
	const style = options.style ?? splashStyle();
	const thickness = options.strokeThickness ?? SPLASH_STROKE_THICKNESS;

	label.Font = style.font;
	label.TextColor3 = style.text;
	label.Text = options.text ?? "";
	label.BackgroundTransparency = 1;
	label.TextXAlignment = Enum.TextXAlignment.Center;
	label.TextYAlignment = Enum.TextYAlignment.Center;

	// **The half a caller is allowed to switch off**, because it is the half that decides a *box* rather than a
	// look: `TextScaled` derives the type size from the label's size, which is the wrong claim to make about a
	// label whose size comes from a typography variant and a `UIScale` — see `SplashTextOptions.fit`.
	if (options.fit ?? true) {
		label.TextScaled = true;
		label.TextWrapped = true;
	}

	// A plain `Instance` rather than `Fusion.New`, because none of these is a value the graph ever drives: the
	// stroke is configured once and then only faded by a tween, and a reactive property here would fight the
	// tween for the same number. `Fusion.New` exists to make a property reactive; this one never is.
	const stroke = new Instance("UIStroke");
	stroke.Name = SPLASH_STROKE_NAME;
	stroke.ApplyStrokeMode = Enum.ApplyStrokeMode.Contextual;
	stroke.Color = style.outline;
	stroke.Thickness = thickness;
	// **The outline's own resting opacity, applied here rather than by every caller**, so that "how strong the
	// outline is" is one number in the file that owns the look. A caller that hides its word sets `1` on the
	// way in and restores this value to show it — which is what `ActionSplash` does, and what the arena-freeze
	// countdown does per number.
	stroke.Transparency = SPLASH_STROKE_TRANSPARENCY;
	stroke.Parent = label;

	return stroke;
}

/** The splash's name in the GUI, so it can be found by the same name in a log or the Explorer. */
const SPLASH_NAME = "ActionSplash";

/** The word's name inside the frame, for the same reason. */
const WORD_NAME = "Word";

/**
 * The splash's box, in pixels, and **the one pair of numbers here that is a design size rather than a tuned
 * one.** `TextScaled` fills whatever box it is given, so this is "how big the word is", and the viewport cap
 * below is what turns it into "how big it may be *here*".
 *
 * **760 × 150 is a word about a seventh of a 1080p screen tall** — big enough to read without looking away
 * from the arena, small enough that it covers nothing the next throw needs. **Placeholder.**
 */
const SPLASH_WIDTH = 760;
const SPLASH_HEIGHT = 150;

/**
 * Where the splash sits, as a fraction of the region it is in — **the upper third, not the middle.**
 *
 * **The middle of the screen is where the game is being aimed at.** The aim sight is at `(0.5, 0.5)`, the throw
 * arc is read along the centre line, and the body being thrown at is on it; a word over that is a word in the
 * way of the next throw. `0.26` clears the round's own top readouts — a column starting 14 pixels below the
 * screen's top and about 90 pixels tall in the worst case, see `screenGui.ts`'s `COLUMN_TOP_INSET` — and stays
 * well above the crosshair. **Placeholder.**
 *
 * **Exported since a second splash wanted the same row**, so that "the line the hit caption draws on" is one
 * number rather than two files agreeing about `0.26`. `hitConfirm` takes the default; `perfectDodge` adds its
 * own offset to this so its smaller word sits under the big one rather than through it.
 */
export const SPLASH_TOP_FRACTION = 0.26;

/**
 * The most of the viewport the splash may take — **the phone and ultrawide cap**, handed to
 * {@link addViewportConstraint} and read there as "whichever is tighter" against the pixel box above.
 *
 * **86 % across leaves a margin**, because a label touching both edges is clipped by a pixel of rounding on a
 * narrow screen; **24 % down is a quarter of the screen's height**, which is what stops a landscape phone from
 * giving the word a box taller than the arena is drawn on. Neither binds at a desktop size, which is the point
 * of a cap rather than a size. **Placeholder.**
 */
const SPLASH_MAX_FRACTION = new Vector2(0.86, 0.24);

/**
 * How thick the word's outline is, in pixels — the action splash's own default for {@link styleSplashText}.
 * **Placeholder — 4.**
 *
 * See that function's doc for why the mode is `Contextual` and why the separation is an outline rather than a
 * shadow. This constant is only the *number*; a caller with a much smaller box passes its own, because an
 * outline is a proportion of the word rather than a distance.
 */
const SPLASH_STROKE_THICKNESS = 4;

/**
 * How opaque the outline is while the word is up — `0` is fully opaque, so this is very slightly transparent.
 * **Placeholder — 0.15.**
 *
 * **Not full strength, and the reason is taste rather than legibility.** A black outline at full opacity around
 * a 150-pixel word reads as a sticker; a breath of transparency lets the court into the edge, and the letters
 * stay the loudest thing in the frame.
 *
 * **Exported because it is the *style* rather than one screen's taste.** `styleSplashText` applies it to every
 * outline it makes, and a caller that fades its own word — the arena-freeze countdown, whose numbers come and go
 * every second — has to fade back *to* it rather than to `0`, or its outline would be the one opaque one in the
 * game.
 */
export const SPLASH_STROKE_TRANSPARENCY = 0.15;

/**
 * How long the pop takes, in seconds. **Placeholder — 0.15.**
 *
 * **Short enough to be a snap rather than a grow.** A scale animation reads as *something happening* until
 * about a fifth of a second; past that it reads as an element arriving, which is a different feeling. This is
 * the one number to lengthen if a hit ever reads as twitchy, and shortening it past about a tenth loses the
 * overshoot entirely — at that point the eye sees only the final size.
 */
const SPLASH_IN_SECONDS = 0.15;

/** The rebound from the overshoot back to rest, in seconds. **Placeholder — 0.1.** */
const SPLASH_SETTLE_SECONDS = 0.1;

/**
 * How far past full size the pop goes, as a scale. **Placeholder — 1.15.**
 *
 * **A small overshoot, because the easing already overshoots.** `Back`/`Out` travels past its destination and
 * returns to it, so the visible peak is this number plus the curve's own excursion. Larger and the word reads
 * as a punch-in on a combat hit rather than as a confirmation; smaller and the overshoot is invisible beside
 * the easing's own.
 */
const SPLASH_OVERSHOOT = 1.15;

/** How long the word rests at full size before fading, in seconds. **Placeholder — 0.5.** */
const SPLASH_HOLD_SECONDS = 0.5;

/** How long the fade takes, in seconds. **Placeholder — 0.2.** */
const SPLASH_OUT_SECONDS = 0.2;

/**
 * **The easing the pop uses — the number that decides whether this reads as arcade or as UI.**
 *
 * **`Back`/`Out`, and `Elastic` was considered and refused.** `Elastic` is the more literally "Wii Sports" curve,
 * and it is too bouncy for the frequency: a caption can land several times a round and a MultiBall window can
 * land three inside two seconds, so a curve that wobbles for half a second is a curve that is *still wobbling*
 * when the next one arrives — the splashes would overlap into one vibrating word. `Back` overshoots once and
 * stops, which is the arcade feel with a shape that survives being played every few seconds.
 *
 * **Placeholder**, in the sense that it is the value to change if the splash reads wrong: `Quad` is the calm
 * alternative and `Quint` the sharper one. It is a *constant* rather than a literal inside the tween because
 * the settle and the fade have styles beside it, and three `Enum.EasingStyle` literals in one function is how a
 * person ends up editing the wrong one.
 */
const SPLASH_EASING: Enum.EasingStyle = Enum.EasingStyle.Back;

/**
 * The easing the rebound uses. **`Quad` rather than `Back`, deliberately.**
 *
 * **One overshoot reads as impact; two read as a wobble.** The pop already carries the overshoot, so running
 * the settle on `Back` as well would add a second, smaller bounce *after* the word had arrived — which is the
 * `Elastic` problem in miniature. `Quad`/`Out` closes the last fifteen per cent smoothly.
 */
const SPLASH_SETTLE_EASING: Enum.EasingStyle = Enum.EasingStyle.Quad;

/**
 * The easing the fade uses — `Quad`/`In`, so the word leaves slowly and then is gone rather than dropping at
 * once. **Placeholder.**
 */
const SPLASH_OUT_EASING: Enum.EasingStyle = Enum.EasingStyle.Quad;

/** What {@link createActionSplash} may be told; every field defaults to the action splash's own value. */
export interface ActionSplashOptions {
	/** The box `TextScaled` fills. Defaults to `760 × 150`. */
	readonly size?: UDim2;

	/** Where it sits. Defaults to centred horizontally, `SPLASH_TOP_FRACTION` down. */
	readonly position?: UDim2;

	/** The point it scales and positions about. Defaults to the centre. */
	readonly anchor?: Vector2;

	/**
	 * The phone and ultrawide cap, as {@link addViewportConstraint} reads it.
	 *
	 * **`undefined` means "no cap" rather than "the default cap"** — which is why the default value here is the
	 * action splash's own fraction and the *absence* of a cap is spelled by passing `false`. A caller drawing
	 * something already bounded by its parent wants that, and `addViewportConstraint` cannot express it: it
	 * applies `DEFAULT_MAX_FRACTION` when handed nothing.
	 */
	readonly maxFraction?: Vector2 | false;

	/** The frame's name in the Explorer. Defaults to `ActionSplash`. */
	readonly name?: string;

	/** See {@link SplashTextOptions.strokeThickness}. */
	readonly strokeThickness?: number;

	/**
	 * Draw the word in a big-ui **typography variant** instead of filling the box, and the whole of why a
	 * second caller needed a door here.
	 *
	 * **`TextScaled` and a variant are two answers to the same question**, and the action splash's answer is
	 * the box: `760 × 150` *is* how big `HIT!` is, because a caption that has to be read without looking away
	 * from the arena is a design size rather than a type size. A caller drawing a *second, smaller* line — a
	 * quiet word under the loud one — wants the theme's type scale instead, and asking it for a 760 × 150 box
	 * would draw a 150-pixel word. Handing it a 20-pixel box instead does not work either: the box is what the
	 * pop scales and what the viewport cap measures, so the animation's pivot would become the word's own
	 * height, and the `maxFraction` cap would be measuring a box nobody designed.
	 *
	 * So the two instructions are separated rather than reconciled: **naming a variant says the type size is
	 * the theme's, and the box goes back to being only the pivot and the cap's subject.** The style, the
	 * stroke, the five steps and the position are unchanged — this is the one property of the label the
	 * caller takes over, and it is taken over here rather than by reaching into `label` after construction,
	 * because the box is this module's decision to give away.
	 *
	 * **`Typography[variant].size` and not the whole spec**, on `styleSplashText`'s rule: the face is
	 * `UI_FONT` for every splash in the game and `ThemeController` has already written it into every variant,
	 * so reading the font from the table here would be a second statement of the same thing.
	 */
	readonly variant?: TypographyVariant;

	/** Pass one to share a theme read across several splashes; defaults to {@link splashStyle}. */
	readonly style?: SplashStyle;
}

/**
 * **One splash, and the two ways to put a word on it** — which is the whole of the difference between a moment
 * and a statement, written as two methods rather than as a flag.
 *
 * **The state lives in the closure, and that is deliberate.** The animation needs a generation token and a
 * record of its running tweens; two module-level `let`s would be one splash's state shared by every splash,
 * and an object cannot capture one half and disagree with the other. A caller holds the object for as long as
 * it wants the splash to exist.
 *
 * **The three verbs are declared as function-typed *properties* rather than as methods**, which is not a style
 * choice: `rbxtsc` rejects an object literal whose member is an arrow function where the interface declared a
 * method (`Attempted to assign non-method where method was expected`). Either side of the pair has to match the
 * other, and this is the side that lets the builder return plain closures.
 */
export interface ActionSplash {
	readonly frame: Frame;
	readonly label: TextLabel;
	readonly stroke: UIStroke;
	readonly scale: UIScale;

	/**
	 * Put `text` up, at rest, and leave it there. **No tween, no overshoot, no fade** — this is the "styled text
	 * that happens to live on a screen-space frame" path, and it is what a caller that wanted only the style
	 * gets.
	 */
	show: (text: string) => void;

	/**
	 * **The five steps**, and the reason this module exists:
	 *
	 * 1. **Reset** — scale to `0`, text and stroke opaque, visible. Everything the previous pop left is
	 *    overwritten in one resumption, so a splash interrupted mid-fade does not inherit an alpha.
	 * 2. **Pop in** — scale to {@link SPLASH_OVERSHOOT} in {@link SPLASH_IN_SECONDS}, **`Back`/`Out`**, which is
	 *    the one that makes it feel like a Wii Sports caption: the curve overshoots past the target and settles
	 *    back onto it, so the word arrives *at* the viewer rather than growing toward them.
	 * 3. **Settle** — back to `1.0` in {@link SPLASH_SETTLE_SECONDS}. The overshoot in step 2 is the snap; this
	 *    is the rebound that leaves the word at its resting size, and it is `Quad` rather than `Back` so the
	 *    rebound does not add a *second* bounce.
	 * 4. **Hold** — {@link SPLASH_HOLD_SECONDS}, long enough to read a caption without becoming a message.
	 * 5. **Fade** — text and stroke to fully transparent, `Quad`/`In`, then `Visible = false`. The outline fades
	 *    with the letters rather than after them, because an outline that outlived its word would be a visible
	 *    outline of nothing.
	 *
	 * **Replace rather than queue.** A second call cuts the first short and that is the trade taken: the newest
	 * success is the one worth showing, and a caption is not a message, so nothing is lost by retiring it early.
	 * What *would* break is the interrupted sequence's own timers — they are still sleeping — so every pop
	 * carries a token, and a sequence whose token is stale returns at its next step instead of hiding or fading
	 * the pop that replaced it. The same "a timer can only be ignored" pattern the rigs' windup uses.
	 */
	pop: (text: string) => void;

	/** Take it off screen now, stopping whatever `pop` is in flight. */
	hide: () => void;
}

/**
 * **A screen-space splash: a frame with a `UIScale` on it, a label styled by {@link styleSplashText}, and the
 * outline that goes with it.** Built once and reused by the caller rather than per show, because the first
 * word is the one moment that must not pay for instance construction.
 *
 * **A `UIScale` rather than a `Size` tween, and the *why* is the whole of the animation's shape.** The three
 * ways to grow a piece of text are a `Size` tween, a `UIScale`, and `TextScaled` — and `TextScaled` is not an
 * animation at all, it is how the label *fits* its box, so it is the wrong tool for the growth. A `Size` tween
 * would re-run that fitting on every frame, and the text would be re-measured and re-kerned sixty times during
 * a 0.15-second pop, which is where a "snap" starts to shimmer. **`UIScale` is a transform**: the layout size
 * is decided once (a fixed pixel box, capped by the viewport) and the scale multiplies it afterwards, so the
 * pop costs nothing per frame and the text is measured exactly once.
 *
 * **The scale is on the frame, not on the label.** A `UIScale` grows its instance about that instance's anchor
 * point, so the frame's `AnchorPoint` is what makes the word expand from its own centre rather than from a
 * corner — and the frame is the thing with the anchor.
 *
 * **The frame starts hidden and the label starts transparent**, so building one costs nothing on screen and the
 * first word does not flash at its resting size for a frame. The *frame* is what is made invisible, never the
 * label on its own: a child's visibility is a fact about the child, and a hidden parent hides it regardless.
 *
 * **The caller supplies the scope** rather than this function making one, for `addViewportConstraint`'s reason:
 * that constraint is a graph object and its cleanup belongs to whoever owns the element. A caller with no scope
 * of its own passes `Fusion.scoped()`.
 */
export function createActionSplash(
	scope: Fusion.Scope<unknown>,
	parent: Instance,
	options: ActionSplashOptions = {},
): ActionSplash {
	const style = options.style ?? splashStyle();
	const anchor = options.anchor ?? new Vector2(0.5, 0.5);

	const frame = new Instance("Frame");
	frame.Name = options.name ?? SPLASH_NAME;
	frame.AnchorPoint = anchor;
	frame.Position = options.position ?? new UDim2(0.5, 0, SPLASH_TOP_FRACTION, 0);
	frame.Size = options.size ?? UDim2.fromOffset(SPLASH_WIDTH, SPLASH_HEIGHT);
	frame.BackgroundTransparency = 1;
	frame.Visible = false;

	const label = new Instance("TextLabel");
	label.Name = WORD_NAME;
	label.Size = UDim2.fromScale(1, 1);
	label.TextTransparency = 1;
	label.Parent = frame;

	const stroke = styleSplashText(label, {
		strokeThickness: options.strokeThickness,
		style,
		fit: options.variant === undefined,
	});
	stroke.Transparency = 1;

	// **The variant's own type size, applied where the fit was switched off above.** The two are one decision
	// seen twice — see `ActionSplashOptions.variant` — and they are next to each other so that a reader cannot
	// find one without the other. `TextWrapped` is left off by `fit: false`, which is right for a word: a
	// caption that wraps is two captions.
	if (options.variant !== undefined) label.TextSize = Typography[options.variant].size;

	const scale = new Instance("UIScale");
	scale.Name = "Pop";
	scale.Scale = 1;
	scale.Parent = frame;

	// **The cap is skipped rather than defaulted when it is switched off**, because `addViewportConstraint`
	// applies its own `0.92 × 0.9` when handed no bounds — a default that is right for a panel and wrong for a
	// word this module already sizes. See `ActionSplashOptions.maxFraction`.
	const cap = options.maxFraction ?? SPLASH_MAX_FRACTION;
	if (cap !== false) addViewportConstraint(scope, frame, { maxFraction: cap });

	frame.Parent = parent;

	/**
	 * Bumped by every `show`, `pop` and `hide`, and captured by every step of a running sequence.
	 *
	 * **The house pattern for a run of timers that cannot be cancelled.** A tween already playing and a
	 * `task.wait` already sleeping can only be *ignored*, so each step acts only while the token it captured is
	 * still current — which is what makes "replace" work.
	 */
	let token = 0;

	/**
	 * Every tween this splash has started and not yet finished — **the list that lets a replacement stop the
	 * last one mid-flight.**
	 *
	 * **The token alone is not enough, which is why this exists beside it.** A token stops a *sequence* from
	 * taking its next step; a tween that is already playing goes on writing its property until it finishes, and
	 * a fade cancelled only politically would keep the word invisible under a splash that had just made it
	 * opaque. `Tween.Cancel()` is the only thing that stops one. Rebuilt rather than trimmed: the list holds at
	 * most three tweens and is thrown away by the next word.
	 */
	let activeTweens = new Array<Tween>();

	const stopTweens = () => {
		for (const running of activeTweens) running.Cancel();

		activeTweens = new Array<Tween>();
	};

	const show = (text: string) => {
		token += 1;
		stopTweens();

		label.Text = text;
		label.TextTransparency = 0;
		stroke.Transparency = SPLASH_STROKE_TRANSPARENCY;
		// Back to rest, because a pop interrupted at scale 0 would otherwise leave the next static word invisible.
		scale.Scale = 1;
		frame.Visible = true;
	};

	const hide = () => {
		token += 1;
		stopTweens();

		label.TextTransparency = 1;
		stroke.Transparency = 1;
		frame.Visible = false;
	};

	const pop = (text: string) => {
		show(text);

		const mine = token;
		scale.Scale = 0;

		task.spawn(() => {
			const popIn = TweenService.Create(
				scale,
				new TweenInfo(SPLASH_IN_SECONDS, SPLASH_EASING, Enum.EasingDirection.Out),
				{ Scale: SPLASH_OVERSHOOT },
			);
			activeTweens.push(popIn);
			popIn.Play();
			popIn.Completed.Wait();
			if (mine !== token) return;

			const settle = TweenService.Create(
				scale,
				new TweenInfo(SPLASH_SETTLE_SECONDS, SPLASH_SETTLE_EASING, Enum.EasingDirection.Out),
				{ Scale: 1 },
			);
			activeTweens.push(settle);
			settle.Play();
			settle.Completed.Wait();
			if (mine !== token) return;

			task.wait(SPLASH_HOLD_SECONDS);
			if (mine !== token) return;

			const fadeInfo = new TweenInfo(SPLASH_OUT_SECONDS, SPLASH_OUT_EASING, Enum.EasingDirection.In);
			const fadeText = TweenService.Create(label, fadeInfo, { TextTransparency: 1 });
			const fadeStroke = TweenService.Create(stroke, fadeInfo, { Transparency: 1 });
			activeTweens.push(fadeText);
			activeTweens.push(fadeStroke);
			fadeText.Play();
			fadeStroke.Play();
			fadeText.Completed.Wait();
			if (mine !== token) return;

			frame.Visible = false;
		});
	};

	return { frame: frame, label: label, stroke: stroke, scale: scale, show: show, pop: pop, hide: hide };
}
