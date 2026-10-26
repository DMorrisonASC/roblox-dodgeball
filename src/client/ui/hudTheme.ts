import { Palette, Spacing, Typography } from "@rbxts/big-ui";
import type { TypographySpec } from "@rbxts/big-ui";

/**
 * The colours the hand-built HUD draws with, by the job each one does rather than by where it
 * comes from.
 *
 * These are the *only* names the HUD knows. Nothing under `controllers/` imports big-ui's theme
 * tables, so if that palette is ever reshaped, renamed or replaced, this file is the single seam
 * that has to change and the three HUDs are untouched. That is the whole reason this module
 * exists rather than each HUD reading `Palette` where it needs a value.
 */
export interface HudTheme {
	colors: {
		/** Ordinary text on a light surface. */
		textPrimary: Color3;
		/**
		 * The text colour for a light surface — and the pair of {@link onAccent}, which is its inverse.
		 *
		 * **The rule the HUD follows, in one place: a light surface takes this, a dark surface takes
		 * `onAccent`.** Every label in a panel sits on one or the other — a name bar is near-black so its
		 * text is `onAccent`, a tile's face and the panel behind it are light so their text is this — and
		 * naming the rule here is what stops the next label from picking a colour by eye and landing on the
		 * wrong side of it. **It reads the same as {@link textPrimary} today**, because the panels are one
		 * flat light surface and these two jobs differ by *where* the text sits rather than by how loud it
		 * is. It used to be `Palette.error.dark`, which put a red on that surface — see the mapping below.
		 */
		textSecondary: Color3;
		/** Text for something unavailable — including a control that has been switched off. */
		textDisabled: Color3;
		/** The colour that draws attention: keys, highlights, the thing to look at. */
		accent: Color3;
		/** Ready, available, good. */
		success: Color3;
		/** Busy, counting down, not yet. */
		warning: Color3;
		/** Failure and elimination. */
		error: Color3;
		errorDark: Color3;
		/** The empty well a progress fill sits in. See {@link hudTheme} for why this reads oddly. */
		trough: Color3;
		/**
		 * The screen itself: what the game is drawn on, and what a full-screen overlay covers it with.
		 *
		 * **The one entry here that is a surface rather than a foreground.** Everything above it is
		 * something drawn *on* the page — text, an accent, a state — and until the loading screen
		 * there was nothing in the client that covered the page. The alternative was for that one
		 * controller to reach into big-ui's `Palette` for a background, which is exactly the import
		 * this module exists to prevent, so the colour is named here instead.
		 *
		 * `surface` rather than `background`, because `trough` is the other use of that word in this
		 * interface and it means a well *inside* something.
		 */
		surface: Color3;
		/**
		 * A raised page: the background a panel of content sits *on top of* the screen.
		 *
		 * **Distinct from {@link surface} on purpose, and the pair is the whole trick.** The theme is
		 * light, so a panel that used `surface` would be a panel the same colour as what is behind it
		 * — a border and nothing else. The palette has two surfaces for exactly this reason: one is
		 * the page and one is the paper laid on it, so naming both lets a panel and its cards read as
		 * a stack of two materials rather than as one flat field.
		 */
		panel: Color3;
		/**
		 * A card inside a panel: the first surface *inside* {@link panel}, for one item or one fact.
		 *
		 * The inverse of the pair rather than a third colour — a card is the page colour showing
		 * through a hole in the paper, which is what makes an inset well read as inset. Chosen this
		 * way round deliberately: the panel is the thing that covers the game, so it is the one that
		 * has to be opaque and paper-like, and a card can afford to be the subtler of the two.
		 */
		card: Color3;
		/**
		 * A hairline: the edge of a panel, a card, or a divider between two of them.
		 *
		 * Named for the job rather than for a shade, because what a border *is* depends on what it
		 * separates — the same value is used for a panel's outline against the game and for a card's
		 * outline against a panel, and both want "a line, one pixel, that is not a colour of its own".
		 */
		border: Color3;
		/**
		 * The colour of money, and the one colour in the economy that means *a number you have*.
		 *
		 * Deliberately not {@link warning} even though it maps to the same palette value today: a
		 * warning is a state something is *in*, and a coin is a thing something *is*. Reading the
		 * balance of an account through the name "warning" is the kind of semantic drift that ends
		 * with a caution colour on a success message, so the job gets its own name and the mapping
		 * stays in one place if the palette ever grows a better amber.
		 */
		coin: Color3;
		/**
		 * Text drawn *on* an accent surface — a filled button, a coloured name bar.
		 *
		 * **A separate name from {@link textPrimary} rather than the same value, because the two are a
		 * pair that has to stay legible.** The shop's tiles draw a saturated bar under each item and
		 * put the name on it; the moment that bar's colour changes, the text on it stops being
		 * ordinary text and becomes a contrast problem. Naming the job is what lets this be revisited
		 * when the accent colour is.
		 */
		onAccent: Color3;
		/**
		 * What a cast shadow is made of — the colour under a raised surface, and the tint at the top of a
		 * recessed one.
		 *
		 * **The one colour here that is drawn *behind* something rather than on it**, which is why it gets
		 * its own name rather than borrowing `trough`: a trough is a well and a shadow is the absence of
		 * light, and the two want different opacities even where they want the same colour. The theme is
		 * light, so this is black — softness comes from the `UIShadow`'s own `Transparency` and
		 * `BlurRadius` rather than from an alpha channel, because a `Color3` does not have one.
		 */
		shadow: Color3;
	};

	/** The theme's spacing scale, in pixels. `Spacing(n)` is `n` eighths. */
	spacing: {
		xs: number;
		sm: number;
		md: number;
		lg: number;
	};

	/** Type specs, for anything measuring text rather than letting big-ui do it. */
	typography: {
		caption: TypographySpec;
		body: TypographySpec;
	};
}

/**
 * The HUD's view of the active theme.
 *
 * **A function rather than a constant, and that is not a style choice.** big-ui's `Palette` is a
 * table that `configureTheme` mutates in place when `ThemeController` runs. A module-level `const`
 * here would read that table the first time *this* module was required — which can be before the
 * theme is configured, depending on load order — and would then hold Material's defaults for the
 * rest of the session. Calling it inside `mount()` makes the order explicit and impossible to get
 * wrong: by the time a HUD mounts, `configureTheme` has run.
 *
 * Reads are stable for the session, so a HUD may treat the result as fixed. Nothing is cached
 * between mounts, deliberately: the call is a handful of table lookups, and re-reading means a
 * theme reconfigured later would be picked up rather than resisted.
 *
 * Every value is a *reference into* the live palette, chosen by the job it does. Where a job has
 * no value of its own — a trough is a dark well and the theme has no dark background, only the
 * two light surfaces `background.default` and `background.paper` — the nearest thing the palette
 * does have is used and named for the job, so the HUD keeps asking for a trough and the mapping
 * stays in one place if the palette ever grows a better answer.
 */
export function hudTheme(): HudTheme {
	return {
		colors: {
			textPrimary: Palette.text.primary,
			// **`text.primary` rather than `error.dark`, and that is a correction rather than a taste.**
			// `text.secondary` is the natural name for "the text on a light surface", and it was pointing at
			// the *error* red — so the panel's column headings, every tile's status line and the footer
			// sentence were all quotation marks around an error that had not happened. The palette's own
			// secondary text is a grey and was refused for the same reason it is refused as a border: half a
			// black is a colour somebody chose, and this text is meant to be ordinary ink that happens to sit
			// on a light surface. Same value as `textPrimary`, deliberately — see the interface entry for the
			// rule that keeps them apart as names.
			textSecondary: Palette.text.primary,
			textDisabled: Palette.text.disabled,
			accent: Palette.primary.main,
			success: Palette.success.main,
			warning: Palette.warning.main,
			error: Palette.error.main,
			errorDark: Palette.error.main,
			// The one value picked by hand. The theme's backgrounds are both light — they are a
			// daytime, light-palette theme — so neither will do for the well behind a progress
			// bar, where the fill has to be the brighter of the two to read at all. The theme's
			// near-black text colour is the darkest surface it has, so that is what a trough is
			// made of until the palette grows a dark background of its own.
			trough: Palette.text.primary,
			// Not picked by hand, for once: the palette's own "behind everything" surface, which is
			// what a full-screen overlay wants and is light because the theme is.
			surface: Palette.background.default,
			// The other half of the pair, from the palette's own two surfaces for the same reason:
			// `paper` is the raised one, so it is what a panel is made of, and a card takes the page
			// colour back — see the two entries in {@link HudTheme} for why that is a stack rather
			// than a shade.
			panel: Palette.background.paper,
			card: Palette.background.default,
			// A disabled-text colour is the palette's lightest neutral, which is what a hairline is:
			// present enough to separate two surfaces, gone enough not to draw the eye. There is no
			// `divider` in the palette, and this is the nearest thing that is *not* a real colour —
			// a border that used `text.secondary` would read as a line somebody meant you to see.
			border: Palette.text.disabled,
			// Amber, which is what every currency in every game is, and `warning.main` is the
			// palette's amber. Mapped here rather than at the call site so that the day the palette
			// grows a gold, the shop does not have to be found.
			coin: Palette.warning.main,
			// The palette's own white, which is what a name bar wants on top of it. Not `surface`:
			// that is the near-white *page* colour, and a page colour used as a foreground is how a
			// label ends up reading as a slightly dirty grey rather than as white.
			onAccent: Palette.common.white,
			// **The one value here that is the absence of light rather than a colour of its own.** The
			// theme is light, so a cast shadow is black — softness comes from the `UIShadow`'s own
			// `Transparency` and `BlurRadius` rather than from an alpha channel, because a `Color3` has
			// none. Deliberately not `trough`: that is a well *inside* something and this is what is
			// behind something, and the two want different opacities even where they want the same ink —
			// the semantic drift the `coin` entry above argues against, caught before it happened.
			shadow: Palette.common.black,
		},

		spacing: {
			xs: Spacing(0.5),
			sm: Spacing(1),
			md: Spacing(2),
			lg: Spacing(3),
		},

		typography: {
			caption: Typography.caption,
			body: Typography.body1,
		},
	};
}

/**
 * The face every piece of text in the game is drawn in — **the one value that decides font style and
 * weight for the whole client.**
 *
 * **`GothamMedium`, which is the heaviest non-bold face `Enum.Font` has.** The Gotham family in this enum
 * is four faces — `Gotham` (regular), `GothamMedium`, `GothamBold` and `GothamBlack` — and
 * `GothamSemibold` is a *deprecated alias of `GothamMedium`* rather than a fifth weight, so there is
 * genuinely nothing between Medium and Bold to reach for. (The whole family is also an alias now: the
 * engine maps every `Gotham*` face onto Montserrat, which is what actually renders. See the note on weight
 * below.)
 *
 * **Weight and style travel in this one name, and that is forced rather than chosen.** big-ui's
 * `TypographySpec.font` is typed `Enum.Font`, so a face is the only thing its typography table can carry —
 * there is no separate weight field to set, and no way to express a heavier-but-still-not-bold weight
 * (Montserrat's 600, say) through it. That would take the newer `Font` data type, which means a `FontFace`
 * written onto every label after construction instead of a theme value; the family asset and the weight
 * would then be a genuine pair of variables. Named here so the limit is a decision on the record rather
 * than something to rediscover.
 *
 * **It is read in exactly two places**, and they are the two halves of the same job: `ThemeController`
 * writes it into all ten typography variants — which is every label big-ui builds, including its `Button`
 * captions — and {@link applyUiFont} corrects the components that hard-code a face of their own.
 */
export const UI_FONT: Enum.Font = Enum.Font.GothamBlack;

/**
 * Gives `root` and everything under it {@link UI_FONT}.
 *
 * **For the one thing the theme cannot reach.** Nearly every label in the game is built by a component that
 * reads a typography variant, so writing `UI_FONT` into the theme is enough for them. big-ui's `Alert` was
 * the exception: it hard-codes `GothamBold` for its title and `Gotham` for its message rather than reading
 * the table (`out/components/Alert.luau`), and it takes no font prop, so the only way to bring it in line
 * was to write the font onto the labels it made.
 *
 * **It has no caller at all now, and that is recorded rather than tidied away.** Its one call site was
 * `ui/hudToast.ts`'s `mountToast`, which was the last `Alert` in the game and was deleted on 2026-10-26
 * once the notification stack in `notifications.ts` had replaced it. What is left is a correct answer to a
 * question nobody is currently asking — kept, not deleted, because it is the only piece of this theme that
 * documents a *library's* shape and the next component that hard-codes a face will want exactly this. The
 * day that happens, this doc is right again; the day big-ui lets a component take a font, delete the file's
 * function with the note below.
 *
 * **A subtree rather than a label, for the same reason the walk has to be written carefully.** big-ui's
 * `Alert` builds those two labels *inside* the frame it returns, so the frame is the thing a caller has;
 * and `GetDescendants()` does not include the instance it was called on, so a walk-only version would miss
 * a label handed in directly — which is how this would be used the day a second hard-coded component turns
 * up. The root is therefore styled explicitly *and* the descendants walked.
 *
 * **This is the one piece of the theme that exists because of a library's shape rather than the game's**, so
 * it is the first thing to delete if big-ui ever lets a component take a font.
 */
export function applyUiFont(root: Instance): void {
	applyFontTo(root);

	for (const descendant of root.GetDescendants()) applyFontTo(descendant);
}

/** The font applied to one instance, if it is the kind of instance that has text. */
function applyFontTo(instance: Instance): void {
	// Three guards rather than one union test: each narrows `Instance` to a concrete class that carries
	// `Font`. `panelChrome.wrapLabels` narrows the same way.
	if (instance.IsA("TextLabel")) instance.Font = UI_FONT;
	else if (instance.IsA("TextButton")) instance.Font = UI_FONT;
	else if (instance.IsA("TextBox")) instance.Font = UI_FONT;
}
