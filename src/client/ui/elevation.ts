import Fusion from "@rbxts/fusion-3.0";
import { SoundService, TweenService } from "@rbxts/services";
import { AUDIO_CONFIG } from "shared/config/audio.config";
import { HudTheme } from "./hudTheme";

/**
 * Depth, in one place: the numbers that make a surface look raised, and the wiring that makes a button
 * look pressed.
 *
 * **Why this is not `panelChrome.ts`, and why it is not the theme.** big-ui has no depth concept at all —
 * `ThemeOverrides` is `palette | transparency | shape | typography | zIndex`, and the only thing in the
 * library that sounds like elevation is `Card`'s `elevation` prop, which is a **`UIStroke`** of
 * `Thickness = elevation` in `Palette.common.black` at `Transparency.divider`. That is a border, not a
 * shadow, and it is already applied to every `Card` the game builds. So the treatment is external — and
 * it cannot live in `panelChrome.ts`, because the three things that need it (a modal panel, a dock button,
 * the power slot) are not all panel chrome: the dock builds its own buttons and the Super HUD builds its
 * own frames, which is exactly what the brief's context section warns about. One module that all three
 * import is the same "one place" argument the chrome module already makes for itself, applied to the
 * elements that do not go through it.
 *
 * **A shadow is the primary cue and the other two are not replacements for it.** A scale alone reads as a
 * shrink and a colour alone reads as a state change; a shadow appearing and vanishing under the surface is
 * what says the surface has moved towards the screen. See {@link wirePress}.
 */

/**
 * How deep each raised surface is.
 *
 * **Depth is relative, and the hierarchy is the whole point of having numbers rather than one.** A panel
 * floats over the game world, a card sits *on* a panel, and a button sits on whatever holds it — so the
 * blur and the offset both shrink as you descend, and a button with a panel's shadow would read as a
 * floating panel rather than as a thing to press.
 *
 * **Blur is tuned above what a design tool's number would suggest**, deliberately: Roblox's blur is
 * weaker than a browser's or Figma's at the same radius, so a ported `8` reads as a hairline and has to
 * come up before it reads as depth. These are guesses in that direction rather than conversions.
 *
 * `Offset` is `UDim2` and `BlurRadius`/`Spread` are `UDim`, which is the engine's shape rather than a
 * choice — see the typings for `UIShadow`. The offset is straight down because the light in every other
 * part of this UI comes from above.
 *
 * **`Placeholder.`** All four sets. Nothing here has been looked at on a screen.
 */
export const ELEVATION = {
	/** The modal panel: the highest thing in the client, over the world and over every other HUD. */
	PANEL: { blur: 28, offsetY: 10, transparency: 0.55 },
	/** A card or tile on a panel. Subtler than the panel's, because it is raised less far. */
	CARD: { blur: 16, offsetY: 5, transparency: 0.65 },
	/** A button: enough to say "press me", not enough to leave the surface it is on. */
	BUTTON: { blur: 12, offsetY: 4, transparency: 0.5 },
	/** A well's inner shade. Negative offset, because the light is still from above. */
	WELL: { blur: 8, offsetY: 3, transparency: 0.7 },
} as const;

export type ElevationLevel = keyof typeof ELEVATION;

/** How long the button takes to go down, and to come back. See {@link wirePress} for why they differ. */
const PRESS_SECONDS = 0.08;
const RELEASE_SECONDS = 0.15;

/**
 * How far a pressed button shrinks, and how far a hovered one grows.
 *
 * **Equidistant from the resting scale, and that is the whole of the arithmetic.** 0.97 down and 1.03 up
 * are the same 3% of travel in opposite directions, so a press and a hover read as the same *kind* of event
 * — the surface moving — rather than as two unrelated effects that happen to be applied to the same object.
 * They are not equal to each other, either: a hover that grew as far as a press shrinks would leave the
 * resting state looking like a third, unlabelled state, and the button would seem to be settling back to
 * something rather than being released.
 */
const PRESSED_SCALE = 0.97;
const HOVERED_SCALE = 1.03;

/**
 * The client's two interface tones, made once and reused.
 *
 * **Two `Sound` instances for the whole machine.** The alternative — a `Sound` per tile — is a shelf of
 * thirty instances all making the same noise, each of which has to be destroyed with the tile; and a
 * `Sound` created *per hover* is worse, because it is a new instance every few hundred milliseconds while
 * the pointer sweeps a list.
 *
 * **`SoundService` rather than `PlayerGui`**, which is where `MusicController` parents its own sounds and
 * for the same reason: a `Sound` is positional when it hangs off a `BasePart` or an `Attachment`, and
 * anywhere else it is heard at one volume from anywhere. `PlayerGui` would work for the same reason and is
 * the worse of the two, because it is torn down and rebuilt on every respawn — and an instance created once
 * must not be sitting inside something that gets replaced.
 *
 * **Created lazily, because this module is imported by builders that may never run.** `DockController`
 * requires it whether or not the dock ever mounts, so a module-level `new Instance` would put two sounds in
 * `SoundService` for a client that never sees a panel. The lazy form costs one nil check on the first
 * interaction and nothing at all afterwards.
 */
let hoverSound: Sound | undefined;
let selectSound: Sound | undefined;

/** One tone, in `SoundService`, named so it is findable in the Explorer. */
function makeUiSound(name: string, id: string, volume: number): Sound {
	const sound = new Instance("Sound");
	sound.Name = name;
	sound.SoundId = id;
	sound.Volume = volume;
	sound.Parent = SoundService;

	return sound;
}

/** Both tones, made on first use. See {@link hoverSound} for why this is not a module-level pair. */
function uiSounds(): readonly [Sound, Sound] {
	if (hoverSound === undefined) {
		hoverSound = makeUiSound("UiHover", AUDIO_CONFIG.UI_HOVER, AUDIO_CONFIG.UI_HOVER_VOLUME);
	}

	if (selectSound === undefined) {
		selectSound = makeUiSound("UiSelect", AUDIO_CONFIG.UI_SELECT, AUDIO_CONFIG.UI_SELECT_VOLUME);
	}

	return [hoverSound, selectSound];
}

/**
 * Builds a cast shadow under `parent`, and hands back the instance the press handler needs.
 *
 * **Returning the instance rather than letting a caller find it** is the whole of what makes a press
 * response possible: a shadow created once with a fixed `Transparency` cannot *drop* on press unless
 * something holds a reference to it, and a `FindFirstChild` per press is a lookup that breaks the day
 * somebody gives the shadow a different name. The caller keeps what this returns; see {@link wirePress}.
 *
 * **`behindParent` is the flag that makes a transparent surface work.** A `UIShadow` renders below its
 * parent, so under a surface that has no background — an `outlined` button, which big-ui builds with
 * `BackgroundTransparency = 1` at rest — the shadow's whole silhouette shows *through* the button and
 * reads as a dark rectangle rather than as depth. With `ShowBehindParent` off, the shadow is only drawn
 * outside the parent's own area, which is the fringe and only the fringe. Left on for opaque surfaces,
 * where the hidden middle is what makes the shadow look attached.
 */
export function addElevation(
	scope: Fusion.Scope<unknown>,
	parent: GuiObject,
	theme: HudTheme,
	level: ElevationLevel,
	behindParent = true,
): UIShadow {
	const spec = ELEVATION[level];

	return Fusion.New(scope, "UIShadow")({
		Parent: parent,
		Color: theme.colors.shadow,
		BlurRadius: new UDim(0, spec.blur),
		Offset: new UDim2(0, 0, 0, spec.offsetY),
		Spread: new UDim2(0, 0, 0, 0),
		Transparency: spec.transparency,
		ShowBehindParent: behindParent,
	});
}

/**
 * Shades `parent` as a *recess* — the inverse of {@link addElevation}.
 *
 * **`Inset` is a real property and this is the whole of the treatment.** The brief that asked for this
 * work assumed a well had to be faked with a darker `UIStroke` or an inverted `UIGradient`, because a
 * shadow was understood to run one way only; the typings say otherwise — `UIShadow.Inset: boolean`, and
 * `Mode: Enum.ApplyShadowMode` for which *part* of the parent it applies to. An inset shadow is exactly
 * what a recess is: the ink inside the top edge, where a real hole would be in shade.
 *
 * **No `Enabled` toggling and nothing returns**, unlike the raised case: a well is not pressed, so there is
 * no state for a handler to reach. It is returned anyway so a future caller that *does* want to change it
 * — a well that fills, say — does not have to go looking for it.
 */
export function addInset(scope: Fusion.Scope<unknown>, parent: GuiObject, theme: HudTheme): UIShadow {
	const spec = ELEVATION.WELL;

	return Fusion.New(scope, "UIShadow")({
		Parent: parent,
		Color: theme.colors.shadow,
		Inset: true,
		// Negative, because the parent's own top edge is where the shade belongs for an inset shadow.
		Offset: new UDim2(0, 0, 0, -spec.offsetY),
		BlurRadius: new UDim(0, spec.blur),
		Spread: new UDim2(0, 0, 0, 0),
		Transparency: spec.transparency,
	});
}

/** What an interactive element needs beyond its button. */
export interface InteractionOptions {
	/**
	 * The shadow to drop on press, when the surface could take one. See {@link addElevation}.
	 *
	 * Absent for a surface that has no shadow to drop — a shelf tile, whose depth is its `UIStroke` and
	 * whose scale is the whole of the response. The helper reads the shadow's resting `Transparency` off the
	 * instance rather than taking it separately, because a caller that had to know it could disagree with
	 * the shadow it just made.
	 */
	shadow?: UIShadow;

	/**
	 * What actually moves, when that is not the thing being clicked.
	 *
	 * **The one reason this is not always the button.** A shelf tile is a `Frame` with a transparent
	 * `TextButton` laid over it, because a `Frame` does not raise `Activated` — so the element that receives
	 * the mouse is not the element a player sees, and scaling the hit button would scale an invisible
	 * rectangle. Pass the tile here and the tile is what grows; leave it out and the button scales itself,
	 * which is what the dock's buttons want because there the button *is* the thing on screen.
	 */
	visual?: GuiObject;
}

/**
 * Makes `button` respond to a pointer: it raises on hover, drops on press, and makes both tones.
 *
 * **This is `wirePress` grown up, and the rename is the honest part of the change.** It used to wire one
 * gesture with two cues and deliberately no hover; it now wires a *state* — hovered, pressed, or neither —
 * with three cues, and a function named for the press would be a name a reader has to argue with. There is
 * one call site per element and the name says what that call site gets.
 *
 * **The state machine is the whole of the difficulty, and it is two booleans.** On press the pointer is
 * still over the element, so `MouseLeave` does not fire: a handler that wrote `0.97` on the way down and
 * left the hover handler to restore it would leave the element small for as long as the pointer stayed
 * there — the scale of a release that never came. Keeping `hovered` and `pressed` *apart* means every event
 * can recompute the whole answer rather than writing one term of it, and the three states fall out of one
 * expression:
 *
 *     pressed            → 0.97
 *     hovered, not pressed → 1.03
 *     neither            → 1.00
 *
 * **A plain closure rather than a `Computed`, and that is a deliberate choice rather than a shortcut.** A
 * `Computed` is Fusion's tool for a value something *reads*; nothing here reads this one — it is written
 * straight onto a `UIScale`, which is an instance rather than a node in the graph. A `Computed` would have
 * to be driven through an `Observer` to have any effect, which is a second mechanism for four lines that
 * already work. `MusicController` shows the other side of the line: it wants the reactive form because it is
 * reading `Value`s *into* an instance on a schedule it does not control.
 *
 * **`AutoButtonColor` is turned off rather than left alone.** big-ui already sets it false on its own
 * buttons, and `addTile`'s hit button sets it false too — but the whole point of one shared helper is that
 * the first hand-built button that forgot would have the engine darkening the surface under a scale tween,
 * which reads as the button changing colour rather than being pushed.
 *
 * **All four events are connected here, once.** `MouseLeave` is *not* connected inside `MouseEnter` — the
 * leak the brief names — and in fact `MouseEnter`'s handler does nothing but set a boolean, play a tone and
 * recompute the scale. There is no re-entrancy to guard against because there is nothing being connected.
 *
 * **One tone per entry, for free.** `MouseEnter` fires when the pointer crosses into the element's own
 * bounds, not on every mouse move within them — and nothing inside a tile or a button is itself a mouse
 * target, so moving across a tile's artwork does not re-fire on the tile underneath it. That is the
 * behaviour the tone depends on: a hover sound on every mouse move would be a machine-gun.
 *
 * **What is *not* here: a downward offset.** Every treated element in this client sits inside a `UIListLayout`
 * or a `UIGridLayout`, both of which own their children's `Position` — a press handler that wrote one would
 * be reverted on the next frame, which is worse than not doing it at all. A wrapper frame that owned the
 * layout slot and offset the element inside it would work, and is a layout change; the brief forbids layout
 * changes, so the offset is dropped and the scale carries the travel instead. 3% of a 36px button is about
 * a pixel, which is the distance the offset would have been.
 *
 * **A locked tile never reaches here.** It has no button at all — `addTile` only builds its hit overlay when
 * it is given an activation — so "this element is not pressable" is expressed by the absence of something to
 * wire rather than by a flag this function has to check. That is why there is no `enabled` parameter: a
 * check on a state would be a second way to say what the tree already says.
 */
export function wireInteraction(
	scope: Fusion.Scope<unknown>,
	button: GuiButton,
	options: InteractionOptions = {},
): void {
	button.AutoButtonColor = false;

	const visual = options.visual ?? button;
	const shadow = options.shadow;
	const rest = shadow !== undefined ? shadow.Transparency : 0;
	const [hoverTone, selectTone] = uiSounds();

	const scale = Fusion.New(scope, "UIScale")({ Parent: visual, Scale: 1 });

	// **The two booleans the whole of this rests on**, and the function that reads both of them. See the doc
	// above for the bug their independence exists to prevent.
	let hovered = false;
	let pressed = false;

	const wanted = (): number => (pressed ? PRESSED_SCALE : hovered ? HOVERED_SCALE : 1);

	const settle = (info: TweenInfo, transparency: number): void => {
		TweenService.Create(scale, info, { Scale: wanted() }).Play();

		if (shadow !== undefined) {
			TweenService.Create(shadow, info, { Transparency: transparency }).Play();
		}
	};

	const down = new TweenInfo(PRESS_SECONDS, Enum.EasingStyle.Quad, Enum.EasingDirection.Out);
	const up = new TweenInfo(RELEASE_SECONDS, Enum.EasingStyle.Quad, Enum.EasingDirection.Out);

	scope.push(
		button.MouseEnter.Connect(() => {
			hovered = true;
			hoverTone.Play();
			// The slow of the two timings: arriving is not an event the way a press is, and a raise that
			// snapped would pull the eye to a tile the player was only passing over.
			settle(up, rest);
		}),
	);

	scope.push(
		button.MouseLeave.Connect(() => {
			// **Both flags, because leaving mid-press is the same state as releasing off the element.** The
			// button is no longer under the pointer at all, so it is neither hovered nor pressed, and a
			// release that arrives later is a no-op on a state that already says so.
			hovered = false;
			pressed = false;
			settle(up, rest);
		}),
	);

	scope.push(
		button.MouseButton1Down.Connect(() => {
			pressed = true;
			selectTone.Play();
			settle(down, 1);
		}),
	);

	scope.push(
		button.MouseButton1Up.Connect(() => {
			pressed = false;
			// `wanted()` reads the hover flag, so a release with the pointer still over the element returns it
			// to 1.03 rather than to rest — which is the case the brief asks for and the one a naive handler
			// gets wrong in the other direction.
			settle(up, rest);
		}),
	);
}
