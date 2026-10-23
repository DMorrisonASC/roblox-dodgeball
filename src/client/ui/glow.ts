import { PREMIUM } from "./premiumTheme";

/**
 * **The bloom: how a flat `Frame` is made to look lit.**
 *
 * **Why this file exists rather than a thicker border.** Roblox has no CSS `box-shadow` in the sense people mean — a
 * shadow that surrounds an element at its own offset — and a `UIStroke` is one width at one transparency. So the two
 * obvious single-property attempts both fail in a way you can see: a thick stroke at full ink is a **hard band**, not
 * a glow; and the same stroke softened enough to look like light has **no edge left** to say where the panel ends.
 *
 * **The answer is two layers with two jobs** — a one-pixel core at full ink (the edge), and a wide, very transparent
 * layer behind it (the light). That pair is the whole technique, and it is what gives a neon sign its look: a crisp
 * tube and the halo it throws.
 *
 * **The wide half is a `UIShadow` when the client has one**, which is the smoother answer because the engine blurs it:
 * `BlurRadius` does in one property what a stroke cannot do at all. It is created inside a `pcall` because the class is
 * new enough that a client without it exists, and **the fallback is the layered stroke** — so an old client gets a
 * slightly harder edge rather than an error, which is the same "degrade, do not fail" rule the HUD applies to every
 * engine feature it is unsure of (see `TouchJoystickController`'s inset read).
 *
 * **Idempotent, and that matters more here than usual.** A gui object in this project can be painted more than once —
 * a big-ui card rebuilt on a vote, a slot repainted on a press, a panel re-shown after a round — so `applyGlow` looks
 * for its own work by name and reuses it. **It also takes over any other stroke on the instance**: a big-ui component
 * arrives with its own hairline, and three borders on one frame is one edge drawn three times. Reusing that stroke as
 * the core (rather than adding a fourth) is what keeps "one edge" true while still letting the bloom sit behind it.
 */

/** The name the crisp one-pixel edge is given, so it can be found again rather than stacked. */
export const GLOW_CORE_NAME = "GlowCore";

/** The name the blur half is given. One of these two exists on every glowing frame. */
export const GLOW_SHADOW_NAME = "GlowShadow";

/** The name of the fallback bloom stroke, for a client whose engine has no `UIShadow`. */
export const GLOW_BLOOM_NAME = "GlowBloom";

/** How far the fallback bloom reaches, in pixels. Wide enough to read as light at arm's length. */
const BLOOM_THICKNESS = 4;

/** How much of the bloom stroke is ink: mostly air, which is what makes it a halo rather than a band. */
const BLOOM_TRANSPARENCY = 0.7;

/** The shadow's blur radius, in pixels. The engine does the smoothing this file cannot. */
const SHADOW_BLUR = 18;

/** How much of the shadow is ink — the same "mostly air" rule as the fallback stroke. */
const SHADOW_TRANSPARENCY = 0.5;

/** `UIStroke` thickness for the bloom on a text label, in pixels. Two is a halo at caption sizes. */
const TEXT_GLOW_THICKNESS = 2;

/** How much of the text halo is ink. The letters stay the solid thing. */
const TEXT_GLOW_TRANSPARENCY = 0.5;

/**
 * **Gives `instance` the theme's edge: a one-pixel core plus a bloom.**
 *
 * Safe to call again on the same instance — every piece it makes is found by name on the second call — and safe on an
 * instance that already has a `UIStroke`, whose stroke becomes the core rather than being joined by a second.
 *
 * @param instance The `GuiObject` whose edge is being lit. The object keeps its own fill and size; nothing here
 *   touches layout.
 * @param colour The light's colour. Defaults to {@link PREMIUM.glow}, which is what every caller in this project
 *   wants; the parameter exists because a bloomed element in a team colour is the obvious next request.
 * @param blur Whether the wide half may be the engine's blurred `UIShadow`. **`true` for a surface that is meant to
 *   be read as solid, `false` for one that is meant to be seen *through*** — and that distinction is not cosmetic.
 *   A shadow is a blurred **silhouette**, so it is inked across the shape's whole *interior* as well as around it;
 *   behind an opaque panel nobody can tell, and behind a `0.7`-transparent one the glow shines through the face and
 *   the "glass" reads as a lit disc. The stroke bloom is a `Border` stroke, so its ink is only ever the rim. See
 *   `MobileControlsController`, which is the caller that needs the second.
 */
export function applyGlow(instance: GuiObject, colour: Color3 = PREMIUM.glow, blur = true): void {
	// **The core: an existing stroke if there is one, otherwise a new one.** A `UIStroke` is looked for rather than
	// assumed, because the same helper has to work on a plain `Frame` this file built and on a big-ui card that
	// arrives with a hairline of its own — and on the second kind, adding a fourth stroke is exactly the mistake
	// this branch exists to prevent.
	const existing = instance.FindFirstChildWhichIsA("UIStroke");
	const core = existing !== undefined ? existing : makeStroke(instance, GLOW_CORE_NAME);

	core.Name = GLOW_CORE_NAME;
	core.Color = colour;
	core.Thickness = PREMIUM.strokeThickness;
	core.Transparency = 0;
	core.ApplyStrokeMode = Enum.ApplyStrokeMode.Border;

	// **A caller that asked for the rim bloom retires any shadow a previous call left.** This helper is idempotent by
	// name, so "the object already has its bloom" has to mean *this kind* of bloom — a repaint that switched from a
	// shadow to a stroke would otherwise keep both, and the shadow is the one that fills the face.
	if (!blur) {
		const stale = instance.FindFirstChild(GLOW_SHADOW_NAME);
		if (stale !== undefined) stale.Destroy();

		const rim = instance.FindFirstChild(GLOW_BLOOM_NAME);

		paintBloom(rim !== undefined && rim.IsA("UIStroke") ? rim : makeStroke(instance, GLOW_BLOOM_NAME), colour);

		return;
	}

	// **The bloom, made once.** The `UIShadow` is an `Instance.new` inside a `pcall` because the class is newer than
	// some clients; a failure is not an error but a reason to use the stroke below.
	const alreadyShadow = instance.FindFirstChild(GLOW_SHADOW_NAME) !== undefined;
	const alreadyBloom = instance.FindFirstChild(GLOW_BLOOM_NAME) !== undefined;
	if (alreadyShadow || alreadyBloom) return;

	const [shadowed] = pcall(() => {
		const shadow = new Instance("UIShadow");

		shadow.Name = GLOW_SHADOW_NAME;
		shadow.Color = colour;
		shadow.Transparency = SHADOW_TRANSPARENCY;
		// **`UDim`, not a number** — the class takes its blur as a `UDim` and its spread as a `UDim2`, which is the
		// one shape difference from `UIStroke` (a plain `number` thickness). Verified against the installed typings
		// after this file was written: `BlurRadius: UDim`, `Spread: UDim2`.
		shadow.BlurRadius = new UDim(0, SHADOW_BLUR);
		shadow.Spread = UDim2.fromOffset(0, 0);
		shadow.Parent = instance;

		return shadow;
	});

	if (shadowed) return;

	// **The fallback: the same two-layer trick, with a stroke doing the blur's job.** Wider than the core and mostly
	// transparent, so what the eye reads is a soft band rather than a second border.
	paintBloom(makeStroke(instance, GLOW_BLOOM_NAME), colour);
}

/**
 * **The wide half as a `Border` stroke — ink on the rim and nowhere else.**
 *
 * One function because it has two callers now: the no-`UIShadow` fallback, and the caller that *asks* for this shape
 * of bloom because its face is transparent (see this file's `blur` note). Two copies of these four properties would
 * be two answers to "what does a rim bloom look like".
 */
function paintBloom(bloom: UIStroke, colour: Color3): void {
	bloom.Color = colour;
	bloom.Thickness = BLOOM_THICKNESS;
	bloom.Transparency = BLOOM_TRANSPARENCY;
	bloom.ApplyStrokeMode = Enum.ApplyStrokeMode.Border;
}

/**
 * **Makes a label look lit: a halo around its glyphs, with the letters kept solid.**
 *
 * `Contextual` rather than `Border`, and that is the whole of why this is a separate function: a `Border` stroke
 * outlines the *label's rectangle* — a box around a line of text, including its empty space — while `Contextual`
 * outlines the *letters* themselves, which is what a neon sign is. `ui/actionSplash.ts` works the same pair out at its
 * own length, and the respawn countdown already relies on it.
 *
 * Returns the stroke so a caller can fade it with the letters, which is the one thing an animation needs and the one
 * thing this helper cannot know about.
 */
export function applyTextGlow(label: TextLabel | TextButton, colour: Color3 = PREMIUM.glow): UIStroke {
	const stroke = makeStroke(label, GLOW_CORE_NAME);

	stroke.Color = colour;
	stroke.Thickness = TEXT_GLOW_THICKNESS;
	stroke.Transparency = TEXT_GLOW_TRANSPARENCY;
	stroke.ApplyStrokeMode = Enum.ApplyStrokeMode.Contextual;

	return stroke;
}

/** One `UIStroke` on `parent`, made and named. The three callers all create and then configure, in that order. */
function makeStroke(parent: Instance, name: string): UIStroke {
	const stroke = new Instance("UIStroke");

	stroke.Name = name;
	stroke.Parent = parent;

	return stroke;
}
