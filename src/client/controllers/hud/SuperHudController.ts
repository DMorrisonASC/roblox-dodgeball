import { Controller, OnStart } from "@flamework/core";
import Fusion from "@rbxts/fusion-3.0";
import { Players, RunService } from "@rbxts/services";
import { isAbilityKind } from "shared/ability";
import { CHARACTER_CONFIG } from "shared/config/character.config";
import { IMAGES_CONFIG } from "shared/config/images.config";
import { ARMED_ABILITY_ATTRIBUTE, STAMINA_ATTRIBUTE } from "shared/constants";
import { sessionHudVisible } from "../../panels";
import { addInset } from "../../ui/elevation";
import { HudTheme, hudTheme } from "../../ui/hudTheme";
import { getHudScreenGui } from "../../ui/screenGui";
import { addViewportConstraint } from "../../ui/viewportConstraint";

/** Prints once, when the stack is up — the line that says the controller ran at all. */
const DEBUG = true;

/**
 * How far up from the bottom of the screen the stack's *bottom edge* sits, in pixels.
 *
 * **The same inset the rest of the bottom furniture uses**, and that is the point: `CooldownHudController`'s
 * card and `DockController`'s buttons each sit 12px off their corner, and this stack sits 12px off the
 * bottom *edge* — so the three read as one row of furniture across the screen rather than as three things
 * at three heights.
 *
 * **This number used to be derived from the toast column, and the direction has reversed.** The stack was
 * lifted clear of the toasts, which put it most of the way up the screen — the wrong place for a readout a
 * player looks at continuously. The permanent thing owns the bottom edge and the transient alerts stack
 * above it, so the number that moved is the *toasts'*, in `hudToast.ts`, whose doc now carries the
 * arithmetic. **If the icon's slot grows, that number is what has to be re-read** — this constant stays 12.
 *
 * **The one thing it now shares a band with is the spectator label**, anchored at the same bottom centre
 * 12px in. They cannot be up at once — the label shows while spectating and this stack hides then, by the
 * same predicate — so nothing has to be arranged around it.
 */
const STACK_BOTTOM_OFFSET = 12;

/**
 * The stack's `ZIndex`, explicit rather than left at the default.
 *
 * **Between the HUDs and the furniture.** `DockController` documents the dock at 5 and the panels at 10,
 * and describes everything else as "every toast and HUD label (1)" — this is a HUD label, so it takes 1,
 * which puts it under the dock and the panels without either of those numbers having to know about this
 * one. Nothing overlaps in either direction today: the dock shows during an intermission and this shows
 * only while a player can act, and the toasts are above this rather than over it. The ordering is there for
 * the day somebody opens a panel mid-round with a toast up.
 */
const STACK_Z_INDEX = 1;

/** The power icon's slot: square, and big enough to read a glyph in at a glance. */
const ICON_SIZE = 56;

/**
 * What the slot's background is drawn at when nothing is armed — the empty state, and the only state it has
 * that is not the art.
 *
 * **A dimmed well rather than no well.** The frame is always there so the stack never moves when an arm is
 * set or spent, and this is what stops that empty frame reading as a *filled* slot whose image failed to
 * load: at full opacity it is a solid block of trough colour, which looks like a broken icon rather than an
 * empty one. At 0.8 it reads as a recess — something waiting for something. The armed state is fully
 * opaque, so the box filling in is the second half of the same signal, and the two states are told apart
 * by the recess rather than by the picture.
 *
 * **Placeholder.** A starting guess, and the sort of number that is tuned by looking at it on a screen.
 */
const EMPTY_SLOT_TRANSPARENCY = 0.8;

/** The corner on the icon's slot and on every stamina segment. One radius, so the stack looks like one thing. */
const CORNER_RADIUS = 4;

/**
 * How many segments the stamina pool is drawn in.
 *
 * **Three, and each one is exactly one second of sprint at today's config** —
 * `CHARACTER_CONFIG.STAMINA_MAX_SECONDS` is 3, so a segment is a third of the pool and a third of three
 * seconds is one. That coincidence is why the number reads the way it does: a player sees three lights and
 * can learn "one light, one second" without anybody writing it down, which is the whole reason a
 * segmented readout is worth having over a bar.
 *
 * **The arithmetic is still thirds rather than seconds**, and the difference matters the day the pool
 * changes: at six seconds this gives six half-second lights rather than three two-second ones and three
 * that belong to nothing. A display that partitions the value it is showing stays honest when the config
 * moves under it; a display that hard-codes the config it was written against does not.
 */
const SEGMENT_COUNT = 3;

/** What one segment represents, in seconds. See {@link SEGMENT_COUNT} for why this is a division. */
const SECONDS_PER_SEGMENT = CHARACTER_CONFIG.STAMINA_MAX_SECONDS / SEGMENT_COUNT;

/** One segment's size, the gap between two of them, and the gap between the icon and the row. */
const SEGMENT_WIDTH = 44;
const SEGMENT_HEIGHT = 10;
const SEGMENT_GAP = 4;
const STACK_GAP = 10;

/**
 * The power slot and the stamina pool, bottom centre: an icon with three lights under it.
 *
 * **One slot, not two, and the second box in the reference is gone.** The old readout had an "ability"
 * row *and* a separate idea of what the ball was carrying; the slot now answers one question — which power
 * is **armed** — and there is nothing left for a second box to say. What a *ball* is carrying is visible on
 * the ball, which is where a mark belongs. The arm exists precisely for the state where there is no ball to
 * look at, which is the state a slot under a crosshair is for.
 *
 * **The icon is `ARMED_ABILITY_ATTRIBUTE` and nothing else.** Not the mystery window, not the owned roster:
 * the arm is the power the player is about to use, the window is announced by its own toast, and ownership
 * is the shop's business. That also means **nothing here reads the character any more** — the old strip
 * looked up the ball in hand by name on every frame, and the icon has no reason to, which removes a
 * per-frame `FindFirstChild` from one of the client's busiest loops.
 *
 * **The stamina pool is drawn here rather than in the cooldown card**, and it is the split those two were
 * always owed: a pool is a *level* and a cooldown is a *deadline*, they read in opposite directions, and
 * they shared a card only because both were bars. It is three segments now — see {@link SEGMENT_COUNT} —
 * and it sits under the icon because both are the player's own state during a round, where the cooldown
 * card is the two controls they are watching.
 *
 * **What was removed, and why each one went.** The **streak** row went because nothing buys it any more:
 * `SuperService.noteHit` no longer grants a charge at any count, so a number that changes nothing is a
 * readout of the server's bookkeeping rather than of the player's situation — and the *crown* the same
 * count decides is drawn on the player's head, which is where that answer belongs. The **charge** row went
 * with it for the same reason: with the chest unable to grant powers and the mystery box standing in for a
 * charge rather than granting one, "READY" was a row almost nobody could ever light. The **MultiBall** row
 * went last and is the one worth arguing: the window is real and it is running, but its count is not
 * actionable — five throws left and one throw left are the same decision — the window's *existence* is
 * announced by the mystery toast for the only players who get one, and a row for it would have been the
 * second box this rebuild exists to remove. **That is a deliberate loss of information rather than an
 * oversight.** If the count comes back it belongs on the toast, because the toast is already the window's
 * announcement.
 *
 * **Nothing here decides anything.** The arm is written by `BallService` on the dev shortcut and the pool
 * by `WalkSpeedService`; this file draws both, and the segment arithmetic is a division of a value the
 * server published rather than a second implementation of the rule that spends it.
 *
 * **One `RenderStepped` loop for both values**, which is `CooldownHudController`'s argument reached the
 * same way: a pool is sampled by the server at its own rate and would want a subscription, while a
 * fraction of a live clock wants a frame. One loop that reads both is one mechanism instead of two, and
 * its cost is two attribute reads per frame.
 *
 * **It is shown only while a player can act**, through the shared predicate in `panels.ts` — in a round or
 * in a practice zone, never for a spectator. See that function for why the spectator half is an honest
 * exception rather than an obvious one: a spectator can still walk and sprint, so the pool behind these
 * lights is still theirs.
 */
@Controller()
export class SuperHudController implements OnStart {
	public onStart(): void {
		// Spawned rather than done inline: mounting waits for `PlayerGui`, and a controller's `onStart`
		// is the wrong place to hold up the rest of the client's boot — as every HUD here does it.
		task.spawn(() => this.mount());
	}

	private mount(): void {
		const scope = Fusion.scoped();
		const player = Players.LocalPlayer;

		// The HUD's colours, read now rather than at module load: `configureTheme` has run by the time
		// anything mounts, and a value captured earlier would be Material's default.
		const theme = hudTheme();

		// **The icon's id, and the empty string is the empty state.** A `Value<string>` rather than a
		// `Value<AbilityKind | undefined>`: what the `ImageLabel` wants is an id, the power-to-id mapping
		// lives in `IMAGES_CONFIG`, and resolving it in the loop means the label's props carry one string
		// rather than a closure that re-derives the lookup on every render. See the loop for the
		// validation — a word this build does not name reads as *nothing armed* rather than as a broken
		// image, which is the safe direction to be wrong in.
		const iconId = Fusion.Value(scope, "");

		// **The pool as one number in segments**, with the three fills computed from it rather than tracked
		// separately. One `Value` for the reading and three `Computed`s for the drawing is one source of
		// truth; three `Value`s would be three things to keep in step with one attribute, which is the
		// mistake `panels.ts` describes about its own pair of booleans.
		const staminaUnits = Fusion.Value(scope, SEGMENT_COUNT);

		const icon = this.addIconSlot(scope, theme, iconId);
		const segments = this.addSegments(scope, theme, staminaUnits);

		const column = Fusion.New(scope, "Frame")({
			Name: "SuperHud",
			// No size of its own: the vertical layout plus `AutomaticSize` is what makes the stack exactly
			// as tall and as wide as the two things it holds — so resizing the icon's slot moves the row
			// under it without anything here being touched.
			Size: new UDim2(0, 0, 0, 0),
			AutomaticSize: Enum.AutomaticSize.XY,
			BackgroundTransparency: 1,
			AnchorPoint: new Vector2(0.5, 1),
			Position: new UDim2(0.5, 0, 1, -STACK_BOTTOM_OFFSET),
			// Explicit, because this stack's ordering against the dock and the panels is a decision rather
			// than whatever the engine happens to do with equal values. See {@link STACK_Z_INDEX}.
			ZIndex: STACK_Z_INDEX,
			// **The visibility rule, shared rather than written here.** See `panels.ts`: three elements
			// show and hide together, and this is the one expression all of them read.
			Visible: sessionHudVisible(scope),
		});

		// The column's layout owns its children's positions, so the order they are *created* in is not
		// the order they appear in — `LayoutOrder` is, which is why both are numbered. Icon first: the
		// slot is what a player looks at, and the pool is what they glance at.
		const layout = new Instance("UIListLayout");
		layout.FillDirection = Enum.FillDirection.Vertical;
		layout.SortOrder = Enum.SortOrder.LayoutOrder;
		layout.HorizontalAlignment = Enum.HorizontalAlignment.Center;
		layout.Padding = new UDim(0, STACK_GAP);
		layout.Parent = column;

		icon.LayoutOrder = 1;
		icon.Parent = column;

		segments.LayoutOrder = 2;
		segments.Parent = column;

		// The stack is as wide as its widest child — the three segments — and pinned to the bottom centre,
		// so a viewport narrower than that row would push it off both edges at once. The bound costs
		// nothing on a screen wide enough for it, and it is the same rule every other HUD here follows:
		// the element carries its own limit rather than trusting that the screen will be big enough.
		addViewportConstraint(scope, column);

		// The one connection in this file, reading both attributes. See the class doc for why this is a
		// loop rather than two subscriptions.
		scope.push(
			RunService.RenderStepped.Connect(() => {
				// **The icon is the arm and the arm only.** The word off the attribute is validated as a
				// kind before it is turned into a picture — the same rule `abilityOn` applies to a ball's
				// mark — so an attribute from a newer build draws an empty slot rather than an empty frame.
				const arm = player.GetAttribute(ARMED_ABILITY_ATTRIBUTE);
				const armed = typeIs(arm, "string") && isAbilityKind(arm) ? arm : undefined;

				iconId.set(armed === undefined ? "" : IMAGES_CONFIG.ABILITY_ICONS[armed]);

				staminaUnits.set(staminaOf(player.GetAttribute(STAMINA_ATTRIBUTE)));
			}),
		);

		column.Parent = getHudScreenGui();

		if (DEBUG) {
			print(
				`[HUD] power slot up — ${ARMED_ABILITY_ATTRIBUTE} on the player, ${SEGMENT_COUNT} stamina` +
					` segments over ${CHARACTER_CONFIG.STAMINA_MAX_SECONDS}s`,
			);
		}
	}

	/**
	 * The power slot: a square well with the armed power's icon in it, or the well alone.
	 *
	 * **The empty state is the well, not nothing, and that is why the frame is always there.** A slot that
	 * vanished when nothing was armed would move the stamina lights up the screen and back again every time
	 * an arm was set and then spent by a ball arriving — a stack that jumps is worse than a stack with an
	 * empty box in it. So the frame never moves, and **two things** say whether it is holding anything: the
	 * *image*, which is transparent when nothing is armed, and the well's own **background transparency**,
	 * which is {@link EMPTY_SLOT_TRANSPARENCY} when it is empty and fully opaque when it is not.
	 *
	 * **Both are derived from the one id**, rather than from a second boolean saying "there is an icon". One
	 * `Value` is one thing that can be wrong; a flag beside it is a thing that has to agree with it on every
	 * frame, and the frame it would have to agree on is the one where a power is set and spent — which is
	 * exactly when a player is looking at the slot.
	 *
	 * **`ScaleType.Fit` rather than the default `Stretch`**, so the art is never squashed to the slot's
	 * square: three icons from whoever drew them will not all be square, and a stretched one is a bug that
	 * only shows on the power nobody was testing.
	 */
	private addIconSlot(
		scope: Fusion.Scope<unknown>,
		theme: HudTheme,
		iconId: Fusion.Value<string>,
	): Frame {
		const slot = Fusion.New(scope, "Frame")({
			Name: "PowerSlot",
			Size: UDim2.fromOffset(ICON_SIZE, ICON_SIZE),
			BackgroundColor3: theme.colors.trough,
			// The well dims while it is empty and fills in when a power is loaded — see the doc above for why
			// the recess is what tells the two states apart rather than the picture.
			BackgroundTransparency: Fusion.Computed(scope, (use) =>
				use(iconId) === "" ? EMPTY_SLOT_TRANSPARENCY : 0,
			),
		});

		// **The one element in this client that is *below* the surface rather than above it**, and the
		// outline of the whole elevation hierarchy: a well is where the depth runs the other way, and
		// `UIShadow.Inset` is what says so — a shadow cast on the inside of the top edge, which is where a
		// real hole would be in shade. Nothing else here needs the treatment, and the stamina segments are
		// deliberately left flat: they are 10px lights rather than surfaces, and an inner shadow on something
		// that small is a smudge. See `ui/elevation.ts` for the numbers and for why the recess is not faked
		// with a stroke or an inverted gradient.
		addInset(scope, slot, theme);

		Fusion.New(scope, "UICorner")({ Parent: slot, CornerRadius: new UDim(0, CORNER_RADIUS) });

		const icon = Fusion.New(scope, "ImageLabel")({
			Name: "Icon",
			Size: new UDim2(1, 0, 1, 0),
			BackgroundTransparency: 1,
			ScaleType: Enum.ScaleType.Fit,
			Image: iconId,
			ImageTransparency: Fusion.Computed(scope, (use) => (use(iconId) === "" ? 1 : 0)),
		});

		icon.Parent = slot;

		return slot;
	}

	/**
	 * The stamina pool as {@link SEGMENT_COUNT} lights, left to right.
	 *
	 * **Each segment is a trough with a fill, which is the cooldown card's construction reused rather than
	 * reinvented** — the same two tones, the same corner, a fill whose width is a fraction. What is new is
	 * what the fraction *is*: `staminaUnits` counts segments, so segment `i` is filled by
	 * `clamp(units - i, 0, 1)` — fully lit below the reading, dark above it, partly lit at the boundary.
	 *
	 * **Partly lit is the point, and it is what makes a segmented readout honest.** Three on/off lights
	 * would quantise a three-second pool to whole seconds, so a player who stopped sprinting would watch the
	 * first light go dark up to a second later — the readout lagging the rule by its own grain. A fractional
	 * segment keeps a bar's precision while reading as three units, which is the whole reason to draw it this
	 * way rather than as a bar.
	 *
	 * **The corner is built inline rather than through a helper**, because the cooldown card's `addCorner`
	 * is private to that file and two callers is not an argument for a third module: exporting it would mean
	 * a shared file for six lines, and this is the only other place in the client that wants one.
	 *
	 * **The index is copied into a `const` before it is closed over**, which is belt and braces rather than a
	 * live fix: Luau's loop variables are per-iteration, so a closure may capture them safely — but a reader
	 * thinking in Lua 5.1 will read the closure as broken, and the `const` is what says which of the two this
	 * code is relying on.
	 */
	private addSegments(
		scope: Fusion.Scope<unknown>,
		theme: HudTheme,
		staminaUnits: Fusion.Value<number>,
	): Frame {
		const row = Fusion.New(scope, "Frame")({
			Name: "StaminaSegments",
			Size: new UDim2(0, 0, 0, 0),
			AutomaticSize: Enum.AutomaticSize.XY,
			BackgroundTransparency: 1,
		});

		const layout = new Instance("UIListLayout");
		layout.FillDirection = Enum.FillDirection.Horizontal;
		layout.SortOrder = Enum.SortOrder.LayoutOrder;
		layout.Padding = new UDim(0, SEGMENT_GAP);
		layout.Parent = row;

		for (let index = 0; index < SEGMENT_COUNT; index++) {
			const position = index;

			const segment = Fusion.New(scope, "Frame")({
				Name: `Segment${position + 1}`,
				Size: UDim2.fromOffset(SEGMENT_WIDTH, SEGMENT_HEIGHT),
				BackgroundColor3: theme.colors.trough,
				LayoutOrder: position,
			});

			Fusion.New(scope, "UICorner")({ Parent: segment, CornerRadius: new UDim(0, CORNER_RADIUS) });

			const fill = Fusion.New(scope, "Frame")({
				Name: "Fill",
				// A whole `UDim2` rather than the `Size.X.Scale` inside one, for the cooldown card's reason:
				// Fusion holds a *property*, and the scale on its own is not one — so the computed value is
				// the size, one whole segment wide at full.
				Size: Fusion.Computed(
					scope,
					(use) => new UDim2(math.clamp(use(staminaUnits) - position, 0, 1), 0, 1, 0),
				),
				// **The colour rule the two bars used, unchanged.** Still filling is the busy tone and ready
				// is the success tone, and the switch is on the reading rather than on an event, so the two can
				// never disagree about which side of ready we are on: a pool at full is success, anything being
				// spent is warning. `CooldownHudController` carries the argument for why this is the shared
				// rule rather than a third colour for a third kind of bar.
				BackgroundColor3: Fusion.Computed(scope, (use) =>
					use(staminaUnits) >= SEGMENT_COUNT ? theme.colors.success : theme.colors.warning,
				),
			});

			Fusion.New(scope, "UICorner")({ Parent: fill, CornerRadius: new UDim(0, CORNER_RADIUS) });

			fill.Parent = segment;
			segment.Parent = row;
		}

		return row;
	}
}

/**
 * How much of the stamina pool is left, in segments — `SEGMENT_COUNT` for full, `0` for empty.
 *
 * **Moved here from `CooldownHudController`, which produced a fraction of the whole pool.** The arithmetic
 * is the same division; what changed is the unit it returns, because the readout is segmented rather than
 * continuous. A *level* and not a clock subtraction: `STAMINA_ATTRIBUTE` publishes the pool itself, so
 * nothing here reads a clock and nothing here can drift from one.
 *
 * **Frozen is displayed as frozen, for free.** During the recovery pause the server writes the same value,
 * so this returns the same number and the lights do not move — which is what the mechanic does, and what
 * the readout is supposed to show. Animating it ahead of the pool would be the readout lying about the one
 * moment the pause exists for.
 *
 * `SEGMENT_COUNT` for anything that is not a number, matching `progressOf` in the cooldown card: a player
 * has no attribute for the frame before `WalkSpeedService` writes one, and a full pool is the honest
 * reading of "nothing has been spent yet".
 *
 * Clamped for the reason the fraction was: the value was computed on another machine from a delta this one
 * did not measure, and the config that bounds it could change between the two.
 *
 * **A module-level function declared after its caller**, which is deliberate rather than convenient:
 * function declarations hoist, so this reads as the footnote to the class it serves instead of sitting
 * between the reader and the thing they opened the file for.
 */
function staminaOf(value: unknown): number {
	if (!typeIs(value, "number")) return SEGMENT_COUNT;

	return math.clamp(value / SECONDS_PER_SEGMENT, 0, SEGMENT_COUNT);
}
