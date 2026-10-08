import { Controller, OnStart } from "@flamework/core";
import Fusion from "@rbxts/fusion-3.0";
import { Players, RunService } from "@rbxts/services";
import { AbilityKind, isAbilityKind } from "shared/ability";
import { CHARACTER_CONFIG } from "shared/config/character.config";
import { IMAGES_CONFIG } from "shared/config/images.config";
import {
	ARMED_ABILITY_ATTRIBUTE,
	MYSTERY_POWER_ATTRIBUTE,
	STAMINA_ATTRIBUTE,
} from "shared/constants";
import { sessionHudVisible } from "../../panels";
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
 * What the slot's background is drawn at. **Placeholder — 0.9.**
 *
 * **One value for both states, and that is the third arrangement this slot has had.** It began as a
 * trough-coloured square whose *opacity* was the signal — dimmed to 0.8 when nothing was armed, fully opaque
 * when something was — which is an opaque black square behind a transparent icon, and an opaque black square
 * is what a broken image looks like. It then carried no background at all, which fixed that and left the icon
 * floating with nothing to anchor it. It is now a faint plate that never changes: at 0.9 it says "this is
 * where the slot is" without ever claiming to be *filled*, and **the arrival of the art is the whole of the
 * answer** rather than one half of a pair.
 *
 * **So the empty state has no signal of its own, deliberately.** One constant background and one fewer state
 * for a player to notice is the trade this number makes — not an oversight. An arm being set, held, spent or
 * lost all look the same on the plate, which is the point of a background: it is furniture, and what changes
 * is the picture standing on it.
 *
 * **At 0.9 the world is visible through it**, which is worth knowing when reading the icon's own comment
 * below: the plate is a tint rather than a backdrop, so the pixels the icon is drawn on are, for practical
 * purposes, whatever is behind the player.
 */
const SLOT_TRANSPARENCY = 0.8;

/**
 * How long the *reveal* runs after a mystery box is collected, in seconds. **Placeholder — 3.**
 *
 * **The tease has to be shorter than the attention it asks for.** This is not the length of anything the
 * game does — the prize is held until it is used — it is the length of the animation that says a box was
 * collected, and it is spent spinning the slot through every power in the game before settling on the one
 * that was granted. Long enough that the eye can follow the spin, short enough that a player who wanted the
 * power yesterday is not waiting for their own HUD: three seconds is about two breaths.
 *
 * **Placeholder in the `SLOT_TRANSPARENCY` sense** — a tuned-by-looking number, not a value with an
 * argument behind it. What the number has to satisfy is that the spin reads as *deliberate* rather than as
 * a slot that has lost its image, and that is a question for a screen.
 */
const FLASH_SECONDS = 3;

/**
 * How long each icon in the reveal is shown, in seconds. **Placeholder — 0.15.**
 *
 * **Six or seven times a second, which is fast enough to read as a shuffle and slow enough to see.** At
 * `FLASH_SECONDS`/`FLASH_STEP_SECONDS` the reveal is twenty steps, so a three-icon build cycles just under
 * seven times: enough repetition that the eye stops trying to read each one and waits for it to stop, which
 * is what makes the settle legible as an *answer* rather than as the end of a list.
 *
 * **Stepped by elapsed time rather than by frame count.** A per-frame step would make the spin twice as fast
 * on a 144Hz client as on a 60Hz one, so the speed of the animation would be a fact about the player's
 * monitor — and the slot would be reading the machine rather than the game.
 */
const FLASH_STEP_SECONDS = 0.15;

/** The corner on the icon's plate and on every stamina segment. One radius, so the stack looks like one thing. */
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
 * **The icon is the mystery prize, the arm, or nothing — read in that order.** A prize held from a box
 * outranks an armed ability because it is the newer decision and the one that can be *lost*: an arm waits
 * indefinitely for a ball, while a prize ends when it is spent, when the player dies, or when the round
 * does. **And the moment a box is collected, the slot reveals it** — spinning through every power in
 * `IMAGES_CONFIG.ABILITY_ICONS` for {@link FLASH_SECONDS} before settling on the granted one, which is the
 * announcement the deleted `MysteryToastController` used to make in words. Not the owned roster, which stays
 * the shop's business. That also means **nothing here reads the character any more** — the old strip looked
 * up the ball in hand by name on every frame, and the icon has no reason to, which removes a per-frame
 * `FindFirstChild` from one of the client's busiest loops.
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
 * actionable — five throws left and one throw left are the same decision — and a row for it would have been
 * the second box this rebuild exists to remove. **That is a deliberate loss of information rather than an
 * oversight.** If the count comes back it belongs on the reveal, which is now the only thing in the client
 * that knows a box was collected.
 *
 * **Nothing here decides anything.** The arm is written by `BallService` on the dev shortcut and the pool
 * by `WalkSpeedService`; this file draws both, and the segment arithmetic is a division of a value the
 * server published rather than a second implementation of the rule that spends it. The reveal is the same
 * kind of thing: it runs on a *change* to `MYSTERY_POWER_ATTRIBUTE` and never decides whether the prize is
 * real, because the server already answered that when it wrote the attribute.
 *
 * **One `RenderStepped` loop for all three values**, which is `CooldownHudController`'s argument reached the
 * same way: a pool is sampled by the server at its own rate and would want a subscription, while a fraction
 * of a live clock wants a frame. One loop that reads all of them is one mechanism instead of three, and its
 * cost is three attribute reads per frame.
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

		// **The reveal's list, and why it is read from the config rather than from the roster.** Every icon in
		// the game is spun through, including the ones this player does not own — that is what makes the reveal
		// a tease rather than a confirmation, and `IMAGES_CONFIG.ABILITY_ICONS` is the only thing that knows the
		// whole set. A power added there joins the reveal with no code change here; the roster would be the
		// roster of *gameplay*, and "an icon for a power this player cannot use" is exactly the case a tease
		// exists to show.
		//
		// **`pairs` and not a sequence**, because there is no sequence to have: the record is keyed by kind and
		// the spin is a shuffle. What matters is only that the list is *stable* for the life of the mount,
		// which it is — one rebuilt per frame could skip or repeat an entry, and that reads as a stutter
		// rather than as a spin.
		const revealIcons = new Array<string>();
		for (const [kind] of pairs(IMAGES_CONFIG.ABILITY_ICONS)) {
			revealIcons.push(IMAGES_CONFIG.ABILITY_ICONS[kind]);
		}

		// **Two locals, and both are the loop's memory rather than the state.** `previousPrize` is the edge
		// detector for a pickup: the box is collected on the *server*, so the only way this loop can know one
		// happened is by noticing a value that was empty and is not. It is seeded from a read taken before the
		// loop starts, so a player who is already holding a prize the first time this runs — a rejoin
		// mid-round, or a dev grant — sees the icon without a flash they did not earn.
		//
		// `flashStartedAt` is the flash's own clock, and `undefined` means "not flashing": one value for
		// "nothing is happening", rather than a boolean beside a time that could disagree with it.
		let previousPrize = this.prizeOf(player);
		let flashStartedAt: number | undefined = undefined;

		// The one connection in this file, reading all three values. See the class doc for why this is a loop
		// rather than three subscriptions.
		scope.push(
			RunService.RenderStepped.Connect(() => {
				const clock = time();

				// **The arm and the prize, validated the same way** — the rule `abilityOn` applies to a ball's
				// mark, so a word this build does not name reads as *nothing* rather than as a broken image.
				const arm = player.GetAttribute(ARMED_ABILITY_ATTRIBUTE);
				const armed = typeIs(arm, "string") && isAbilityKind(arm) ? arm : undefined;
				const prize = this.prizeOf(player);

				// **The flash starts on the edge where a prize appears, and is abandoned when one goes away.**
				// That is one rule with three cases: a prize arriving starts it, a prize staying starts nothing,
				// and a prize *leaving* clears it. The last case is the one worth naming — the ways a prize
				// leaves are using it and dying, both of which the player just did, so a spin that kept running
				// would be celebrating a pickup while the slot already showed how it ended.
				if (prize !== undefined && previousPrize === undefined) flashStartedAt = clock;
				if (prize === undefined) flashStartedAt = undefined;

				previousPrize = prize;

				// **What the slot shows, in the order the three states outrank each other.** The flash while it
				// runs, then a held prize, then an arm, then nothing. A prize outranks the arm because it is the
				// power the box paid for and the only one of the two with an ending; the arm outranks nothing
				// because it is still something the player is about to use.
				//
				// **The non-empty guard is not decoration**: `% 0` is a division by zero, and a config with every
				// icon removed is a thing somebody could do.
				const started = flashStartedAt;

				let shown = "";

				if (started !== undefined && revealIcons.size() > 0 && clock - started < FLASH_SECONDS) {
					const step = math.floor((clock - started) / FLASH_STEP_SECONDS);
					shown = revealIcons[step % revealIcons.size()];
				} else if (prize !== undefined) {
					// The settle, and it is written by this branch on every frame after the spin ends — so the
					// answer is on screen from the frame the flash stops rather than at the end of a fade.
					shown = IMAGES_CONFIG.ABILITY_ICONS[prize];
				} else if (armed !== undefined) {
					shown = IMAGES_CONFIG.ABILITY_ICONS[armed];
				}

				iconId.set(shown);

				staminaUnits.set(staminaOf(player.GetAttribute(STAMINA_ATTRIBUTE)));
			}),
		);

		column.Parent = getHudScreenGui();

		if (DEBUG) {
			print(
				`[HUD] power slot up — ${ARMED_ABILITY_ATTRIBUTE} on the player, ${SEGMENT_COUNT} stamina` +
					` segments over ${CHARACTER_CONFIG.STAMINA_MAX_SECONDS}s, reveal over` +
					` ${revealIcons.size()} icon(s)`,
			);
		}
	}

	/**
	 * Which power this player is holding from a mystery box, or `undefined` when they are holding none.
	 *
	 * **The read, the validation and the narrowing in one place**, because the loop asks twice — once for the
	 * pickup edge and once for what to draw — and two copies of a three-clause test are two chances to fix
	 * only one of them. It is the same shape the arm's read has, a few lines above it: the attribute is a
	 * string from a server that could be a newer build, so a word this one does not name reads as *nothing
	 * held* rather than as a missing icon.
	 *
	 * **This never decides whether a prize is real.** The server owns that answer — it is what
	 * `SuperService.isMysteryActive` is for — and this is a client reading what it was told, which is why
	 * there is no clock, no count and no ownership check anywhere near it.
	 */
	private prizeOf(player: Player): AbilityKind | undefined {
		const held = player.GetAttribute(MYSTERY_POWER_ATTRIBUTE);

		return typeIs(held, "string") && isAbilityKind(held) ? held : undefined;
	}

	/**
	 * The power slot: a faint plate with the current power's icon standing on it.
	 *
	 * **The plate never changes, and that is the whole of the design.** This slot has been three things: a
	 * trough-coloured square whose opacity *was* the signal (dim when empty, opaque when loaded), no
	 * background at all, and now one constant value in both states — {@link SLOT_TRANSPARENCY}. The middle
	 * one fixed the black square and left the icon unanchored; the first one is what a broken image looks
	 * like. **A background is furniture rather than a readout**: it says where the slot is and nothing about
	 * what is on it, so a player learns one picture and one place rather than a picture and a pair of states.
	 * See that constant for the trade it makes.
	 *
	 * **The frame was never about the colour anyway.** It is always there, 56px, and the first child of the
	 * stack, because a slot that vanished when nothing was armed would move the stamina lights up the screen
	 * and back every time an arm was set and then spent by a ball arriving.
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
			// One value in both states, and **not a `Computed`** — which is what makes "it stays" something
			// this code says rather than something a reader has to check two branches to confirm.
			BackgroundTransparency: SLOT_TRANSPARENCY,
		});

		// The corner the plate has always had, back with it: a hard-cornered square sitting above three
		// rounded lights reads as a different kind of object rather than as the top of the same stack.
		Fusion.New(scope, "UICorner")({ Parent: slot, CornerRadius: new UDim(0, CORNER_RADIUS) });

		// **`BackgroundTransparency = 1` on the *image* is load-bearing, and it is the first thing to check if
		// the art ever shows up inside a rectangle of its own colour.** An `ImageLabel` is a rectangle that
		// *contains* a picture the way a `Frame` is a rectangle that contains nothing — the engine fills it
		// with `BackgroundColor3` unless this line says otherwise, which is why the property exists on every
		// `GuiObject` rather than on the ones that draw a fill. With the plate at 0.9 the icon is drawn on
		// whatever is *behind* the player, and a fill here would put a second rectangle inside the slot that no
		// amount of work on the asset could take away.
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
