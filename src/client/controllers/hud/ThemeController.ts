import { Controller, OnStart } from "@flamework/core";
import { configureTheme } from "@rbxts/big-ui";

/**
 * The five colours the whole theme is built from, and the only hexes in the game's UI.
 *
 * Every other colour below is one of these with its saturation or its brightness moved — never a
 * new hue — so changing a hex here moves every component that reads from it and nothing has to be
 * hunted down. They come from a single ColourLovers palette, which is why they sit together like
 * this rather than sorted by what they are used for: they are the source, and the roles they play
 * are decided at the bottom of the file.
 */

/** aoi, `#69D2E7` — the palette's blue, and the theme's `primary`. */
const AOI = Color3.fromRGB(105, 210, 231);

/** Clean Pondwater, `#A7DBD8` — the palette's second blue-green, and the theme's `secondary`. */
const PONDWATER = Color3.fromRGB(167, 219, 216);

/** beach storm, `#E0E4CC` — the palette's cream, and the colour every surface is made of. */
const BEACH_STORM = Color3.fromRGB(224, 228, 204);

/** Giant Goldfish, `#F38630` — the palette's orange, and the theme's `warning`. */
const GOLDFISH = Color3.fromRGB(243, 134, 48);

/** unreal food pills, `#FA6900` — the palette's hot orange, and the theme's `error`. */
const FOOD_PILLS = Color3.fromRGB(250, 105, 0);

/**
 * The two ends of the scale, which the theme needs named but which are not really colours.
 *
 * White is also the text scale's light end — see {@link TEXT_INVERSE} — so nothing below needs a
 * second white, and the two names refer to one value deliberately.
 */
const BLACK = Color3.fromRGB(0, 0, 0);
const WHITE = Color3.fromRGB(255, 255, 255);

/**
 * Moves a colour's saturation or brightness without touching its hue.
 *
 * Both shifts are **offsets on the 0-to-1 HSV numbers, not multipliers**, which is what makes the
 * two directions symmetric — one tenth brighter is as much as one tenth darker — and what lets a
 * tone be reasoned about as "this much brighter" rather than "this much of the way to white". A
 * shift that would leave the range is clamped, so a colour already near the top simply lands at
 * the top instead of wrapping around into a different colour.
 *
 * The hue is not a parameter, and that is the point: every tone in this file is reachable only by
 * desaturating or dimming one of the five, so no stray hue can get into the theme through here.
 *
 * **This sits above the constants that call it, and has to stay there.** TypeScript hoists a
 * `function` declaration, so calling one above where it is written is legal and reads fine — but
 * roblox-ts compiles the body *where it is written* and forwards a bare `local derive` to the top
 * of the file. A top-level initializer that runs before the body is assigned therefore calls
 * `nil`, which happens while the module is being required and takes the whole module down with
 * it. That is a rule about this file's layout rather than a style preference, so the temptation to
 * tidy the helper down with the other odds and ends should be resisted.
 */
function derive(base: Color3, opts: { value?: number; saturation?: number }): Color3 {
	const [hue, saturation, value] = base.ToHSV();

	return Color3.fromHSV(
		hue,
		math.clamp(saturation + (opts.saturation ?? 0), 0, 1),
		math.clamp(value + (opts.value ?? 0), 0, 1),
	);
}

/**
 * Aoi's two other tones.
 *
 * Shared deliberately: `info` and `primary` are the same blue in this palette, so they are the
 * same three blues. Two copies of the same derivation would be two things to keep in step.
 */
const AOI_LIGHT = derive(AOI, { value: 0.15 });
const AOI_DARK = derive(AOI, { value: -0.2 });

/** Clean Pondwater's two other tones, shared by `secondary` and `success`. See {@link AOI_LIGHT}. */
const PONDWATER_LIGHT = derive(PONDWATER, { value: 0.1 });
const PONDWATER_DARK = derive(PONDWATER, { value: -0.2 });

/** Giant Goldfish's two other tones. */
const GOLDFISH_LIGHT = derive(GOLDFISH, { value: 0.1 });
const GOLDFISH_DARK = derive(GOLDFISH, { value: -0.2 });

/** unreal food pills' two other tones. */
const FOOD_PILLS_LIGHT = derive(FOOD_PILLS, { value: 0.1 });
const FOOD_PILLS_DARK = derive(FOOD_PILLS, { value: -0.2 });

/**
 * The one text colour, in three weights.
 *
 * **All three are dark, and that is what the theme is rather than a choice made per component.**
 * The game is played in daylight and every surface is light, so dark text is simply what the panels
 * want. That is why no colour group below carries a different `contrast` from its neighbours and
 * why there is no helper that decides one: a theme that worked out its own contrast would be one
 * that expected to need light text somewhere.
 *
 * **{@link TEXT_INVERSE} is where that expectation is answered, and it is the only light text
 * colour in the file.** Not because a surface in the game is dark — none is — but because the
 * trough behind a cooldown bar is this very colour at near-black, so anything drawn on one is drawn
 * on the text colour itself. It is named here rather than left to a call site so that the pairing
 * is on the record: a component that swaps one for the other is inverting its text, not recolouring
 * it.
 *
 * These are beach storm's own hue family, not greys: near-black with the cream's warm
 * yellow-green left in it. Pure grey next to this palette reads as a different, colder surface
 * laid on top — the tint is what makes the text look like it belongs to the panels it sits on.
 * The three are written out rather than derived because they are the palette's *tone*, hand-set
 * so that the steps between them are even; the derivation is the same one either way, keep the
 * hue, take the saturation up and the brightness well down.
 */
const TEXT_PRIMARY = Color3.fromRGB(35, 40, 30);
const TEXT_SECONDARY = Color3.fromRGB(90, 95, 80);
const TEXT_DISABLED = Color3.fromRGB(160, 165, 145);

/**
 * The inverse of {@link TEXT_PRIMARY}: what the text scale's dark end becomes on a surface that
 * would otherwise hide it.
 *
 * **The scale's own white rather than a fourth hand-set hex.** Inverting a text colour is not a new
 * colour, it is the other end of the one already here — so this is a *name* for the palette's white
 * rather than a second white beside it. Two values that had to be kept equal by hand would be two
 * things to keep in step, which is the same argument the shared Aoi and Pondwater tones are made
 * with; one value, two names, each saying the job it is doing at the place it is asked for.
 *
 * **Nothing in the theme paints with it yet, and that is correct rather than unfinished.** Every
 * `contrast` below is {@link TEXT_PRIMARY}, because every surface in the game is light — there is
 * no dark group for this to be the contrast *of*. It exists because the trough does: see the note
 * on the text trio, and `hudTheme().colors.trough`, which is `TEXT_PRIMARY` itself.
 */
const TEXT_INVERSE = WHITE;

/**
 * The colour behind the panels: beach storm with its brightness taken down a third.
 *
 * The only derived tone that is not a variant of a colour group, because it has a different job.
 * `paper` is the cream at full strength and is what cards are made of; this is what sits *behind*
 * them, and a surface behind a surface has to be able to be told apart from it. Darkening the
 * cream keeps it warm and keeps it clearly lighter than anything drawn on it, so it reads as a
 * panel behind panels rather than as a shadow or a hole.
 */
const BACKGROUND_DEFAULT = derive(BEACH_STORM, { value: -0.3 });

/**
 * Puts the game's palette into big-ui, once, before anything is built.
 *
 * **This has to be the first thing that runs on the client.** big-ui's components read the theme
 * when they are *constructed* and not reactively, so a component built before this keeps the
 * Material defaults for the rest of the session and the only thing that would fix it is being
 * rebuilt. `loadOrder: -100` is what guarantees that: Flamework sorts controllers by it, so this
 * one's `onStart` runs before every other — and the others then hand their mounting to a
 * `task.spawn`, which puts their first built instance at least a task later than this.
 *
 * It is called here and nowhere else. A second call would be a second source of truth for the
 * palette, and since `configureTheme` deep-merges, what the last caller happened to mention would
 * silently decide the theme.
 *
 * Every value below is a named constant from the top of this file. Nothing is derived here and no
 * colour is written here, so this function is a description of the theme's structure rather than a
 * place any of it is decided.
 */
@Controller({ loadOrder: -100 })
export class ThemeController implements OnStart {
	public onStart(): void {
		configureTheme({
			palette: {
				common: {
					black: BLACK,
					// The scale's light end, and named here as the text scale's inverse as well: one
					// white with a job rather than two that have to be kept equal — see
					// {@link TEXT_INVERSE}. This is what big-ui itself reaches for on a dark surface,
					// and what the HUD publishes as `hudTheme().colors.onAccent`.
					white: TEXT_INVERSE,
				},
				primary: {
					main: AOI,
					light: AOI_LIGHT,
					dark: AOI_DARK,
					// `contrast`, not `contrastText`: this version of big-ui names the field
					// `contrast`, and its override type is the only thing that would have said so —
					// a wrong name here is silently ignored rather than rejected.
					contrast: TEXT_PRIMARY,
				},
				secondary: {
					main: PONDWATER,
					light: PONDWATER_LIGHT,
					dark: PONDWATER_DARK,
					contrast: TEXT_PRIMARY,
				},
				error: {
					main: FOOD_PILLS,
					light: FOOD_PILLS_LIGHT,
					dark: FOOD_PILLS_DARK,
					contrast: TEXT_PRIMARY,
				},
				warning: {
					main: GOLDFISH,
					light: GOLDFISH_LIGHT,
					dark: GOLDFISH_DARK,
					contrast: TEXT_PRIMARY,
				},
				// No green in the palette, so the theme does without one: Pondwater is the calm,
				// settled colour of the five and that is what a success state is for. Introducing a
				// green here would be the one hue the palette does not have.
				success: {
					main: PONDWATER,
					light: PONDWATER_LIGHT,
					dark: PONDWATER_DARK,
					contrast: TEXT_PRIMARY,
				},
				info: {
					main: AOI,
					light: AOI_LIGHT,
					dark: AOI_DARK,
					contrast: TEXT_PRIMARY,
				},
				text: {
					primary: TEXT_PRIMARY,
					secondary: TEXT_SECONDARY,
					disabled: TEXT_DISABLED,
				},
				// No `dark` here: big-ui's background palette is two values, `default` and `paper`,
				// and nothing on the schema takes a third. The troughs behind the cooldown bars are
				// drawn by the HUD's own frames with their own local colours, so there is nothing
				// waiting on one.
				background: {
					default: BACKGROUND_DEFAULT,
					paper: BEACH_STORM,
				},
			},
			shape: {
				radius: 6,
				radiusLarge: 12,
				radiusPill: 999,
			},
			// Typography and zIndex are deliberately absent, so big-ui's defaults stand. The type
			// scale is built for a document and every size on it is larger than a HUD wants, which
			// is why the HUD picks a small variant per label instead of the theme picking one for
			// everything. Layering is `ScreenGui.DisplayOrder`'s job here, not the theme's.
		});
	}
}
