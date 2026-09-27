import Fusion from "@rbxts/fusion-3.0";
import { Workspace } from "@rbxts/services";

/**
 * How much of the screen an element is allowed to take.
 *
 * The two caps answer two different questions, which is why there are two of them.
 *
 * `max` is the **ultrawide** question. A panel sized in `Scale` keeps growing as the screen widens,
 * and at some point a thing designed to sit in a corner is an absurdity across three feet of
 * monitor.
 *
 * `maxFraction` is the **phone** question. A HUD laid out in pixels is comfortably narrow on a
 * desktop and can be *wider than the entire screen* on a phone — and no pixel maximum can catch
 * that, because the number that is safe is a different number on every device. Only the viewport
 * itself knows it.
 *
 * A bound given in both units is read as "whichever is tighter", so an element can be capped at
 * 360 pixels *and* at 92% of the viewport without either number having to know about the other.
 */
export interface ViewportBounds {
	/** The smallest the element may be, in pixels — `min-width` / `min-height`. */
	min?: Vector2;

	/** The largest it may be in pixels. The ultrawide cap. */
	max?: Vector2;

	/** The largest it may be as a fraction of the viewport. The phone cap. */
	maxFraction?: Vector2;
}

/**
 * The fraction of the screen a HUD may fill before it is clamped.
 *
 * 92% across and 90% down, which leaves a margin on every side — and the margin is not decoration:
 * most of these HUDs are pinned to an *edge*, so an element that filled 100% of the viewport would
 * have one edge exactly on the screen edge, and one pixel of rounding would put it over. The
 * fraction is what turns "as wide as the screen" into "as wide as the screen, minus a gap".
 *
 * Vertical is the looser of the two because a HUD that is tall is scrolling content or a stack of
 * rows, and clipping it is worse than clipping a width. Neither is expected to bind at a normal
 * size — they exist for the sizes that are not normal.
 */
const DEFAULT_MAX_FRACTION = new Vector2(0.92, 0.9);

/**
 * The tighter of a pixel cap and a viewport-fraction cap, either of which may be absent.
 *
 * Absent means "this direction is uncapped", which is `math.huge` rather than a guessed number:
 * the point of the helper is that the bounds it applies are the bounds the caller asked for, and
 * a default the caller did not ask for is exactly the kind of invention that makes a cap fire at
 * a size nobody predicted.
 */
function tighterOf(pixels: number | undefined, fraction: number | undefined): number {
	if (pixels === undefined) return fraction ?? math.huge;
	if (fraction === undefined) return pixels;
	return math.min(pixels, fraction);
}

/**
 * Hold `instance` inside `bounds`, and keep holding it there as the screen changes size.
 *
 * **This is `min-width` / `max-width` / `min-height` / `max-height` for a HUD**, and it is the one
 * piece of the responsive standard that a Roblox layout cannot express on its own. `UISizeConstraint`
 * takes plain `Vector2` pixels — there is no `Scale` form of it — so a cap written as "92% of the
 * screen" has to be evaluated against a screen, and re-evaluated whenever that screen is a
 * different size. Which happens more often than it sounds: a phone rotated sideways, a desktop
 * window dragged narrower, a tablet with a split view.
 *
 * So the viewport is read once into a `Value`, bridged from its own changed signal, and the maximum
 * is *derived* from it. The alternative — computing the number at mount and leaving it — describes
 * the screen the HUD was built on rather than the screen it is on, which is the same class of bug
 * as a `Position` captured from a viewport that has since changed.
 *
 * The constraint is parented to `instance` and handed to `scope`, so it is cleaned up with the
 * element it bounds rather than outliving it.
 *
 * **A missing camera is not an error.** There is no viewport to read before one exists, so there is
 * nothing to constrain against, and the element keeps whatever size it was given. That is the
 * graceful answer for the one moment it can happen — mounting is already deferred for
 * `PlayerGui` — rather than a reason to fail the mount.
 */
export function addViewportConstraint(
	scope: Fusion.Scope<unknown>,
	instance: GuiObject,
	bounds?: ViewportBounds,
): UISizeConstraint | undefined {
	const camera = Workspace.CurrentCamera;
	if (!camera) return undefined;

	const settings = bounds ?? {};
	const pixelMax = settings.max;
	const fraction = settings.maxFraction ?? DEFAULT_MAX_FRACTION;

	const viewport = Fusion.Value(scope, camera.ViewportSize);

	scope.push(
		camera.GetPropertyChangedSignal("ViewportSize").Connect(() => {
			viewport.set(camera.ViewportSize);
		}),
	);

	const maxSize = Fusion.Computed(scope, (use) => {
		const size = use(viewport);

		return new Vector2(
			tighterOf(pixelMax?.X, size.X * fraction.X),
			tighterOf(pixelMax?.Y, size.Y * fraction.Y),
		);
	});

	// `MaxSize` is passed in the props table rather than assigned afterwards, because a graph object
	// has to be part of a `New` to be tracked as a property — assigning one onto an instance that
	// already exists is the shape that silently does nothing. `MinSize` is a plain value, so it could
	// go either way; it is here so that both bounds read as one statement.
	return Fusion.New(scope, "UISizeConstraint")({
		Parent: instance,
		MinSize: settings.min ?? new Vector2(0, 0),
		MaxSize: maxSize,
	});
}
