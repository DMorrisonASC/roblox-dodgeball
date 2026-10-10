import { Controller, OnStart } from "@flamework/core";
import { Text } from "@rbxts/big-ui";
import Fusion from "@rbxts/fusion-3.0";
import { Players, RunService } from "@rbxts/services";
import { AbilityKind, isAbilityKind } from "shared/ability";
import { CHARACTER_CONFIG } from "shared/config/character.config";
import { IMAGES_CONFIG } from "shared/config/images.config";
import {
	ARMED_ABILITY_ATTRIBUTE,
	MYSTERY_POWER_ATTRIBUTE,
	STAMINA_ATTRIBUTE,
	SUPER_MULTI_BALL_COUNT_ATTRIBUTE,
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
 * **The one thing it used to share a band with was the spectator label**, anchored at the same bottom centre
 * 12px in — and the two could not be up at once, because the label showed while spectating and this stack
 * hid then, by the same predicate. **That label is gone** with the spectator state, so the bottom centre of
 * the screen is this stack's alone: nothing else the client draws is anchored there, which means there is
 * still nothing to arrange around. See `panels.ts` for the removal and for what the predicate says now.
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
 * How far left of the slot the uses count sits, in pixels. **Placeholder — `6` is the ask.**
 *
 * **A gap rather than a width, and the count is deliberately not a child of the stack's own column.** The
 * number is anchored to the slot's *left edge* and grows leftwards from there, so this is the space between
 * the two and nothing about either one's size. The alternative — a row holding the count and the icon as
 * siblings — was rejected because the column centres its children: an icon with something beside it is an
 * icon that has *moved*, sitting left of the stamina lights it is supposed to be centred over. Anchoring the
 * number outside the slot keeps the icon exactly where it has always been.
 */
const COUNT_GAP = 6;

/**
 * The one ability this file names by hand, because it is the one that has a number on it.
 *
 * **Everything else here works in ids and in whatever the server published.** The slot's icon is an id out of
 * `IMAGES_CONFIG`, the prize is a kind the server rolled, the arm is a kind the server set — none of which
 * this file has any business comparing against a name. The uses count is the exception, and the reason is
 * that **the number and the power it belongs to are published separately**: the count is the MultiBall
 * window's, and nothing on the player says *which* power that count is about. So the match has to be made
 * somewhere, and it is made here rather than by publishing a second attribute that said it twice.
 *
 * **What would change it.** If a second power ever gains a count, the honest shape is a count published
 * *with* the power it belongs to — then no client has to know which powers are countable at all. That is one
 * ability further away than today, and this comment is where to start from rather than a wrapper to write
 * now.
 */
const MULTI_BALL_KIND: AbilityKind = "MultiBall";

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
 * went last, and **it has come back — as a number beside the icon rather than as a row**, which is the
 * reversal worth reading because the argument for removing it is now the argument for having it. That
 * argument was: the window is real and it is running, but its count is not actionable, since five throws
 * left and one throw left are the same decision. **The window has no clock any more**, so its count *is* the
 * whole of the ability — it is how much of the power is left, and the only things that end it early are
 * dying and the round. It comes back attached to the icon of the power it belongs to, in
 * {@link addCount}, rather than as a fifth row in the column, which would have said the same thing twice.
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
 * in a practice zone. It used to say "never for a spectator" as well, and the loss of that term is worth a
 * sentence here because this stack is where it reads worst: **the stamina segments are the honest
 * exception**, since a player who is out of the round can still walk and sprint, so the pool behind those
 * lights is still theirs and still being spent. The stack is shown or hidden as one thing, though, and a
 * dead player seeing their own stamina for the length of the respawn delay is a smaller fault than half a
 * stack — which is the trade `sessionHudVisible` now makes.
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

		/**
		 * **The uses left in whatever the slot is showing, or nothing.** A `Value<number | undefined>` and not
		 * a number beside a boolean: `undefined` is "there is no count to draw", and that single fact is what
		 * the label's text *and* its visibility are both derived from, so the two cannot come apart. The pair
		 * this deliberately is not — a flag and a number — is the shape `client/throwing.ts` argues against for
		 * the same reason: two values for one question is two chances to disagree.
		 *
		 * It is set by the loop below, from the power the slot settled on, and `undefined` is the ordinary case
		 * — every power except a running MultiBall window.
		 */
		const usesLeft = Fusion.Value<number | undefined>(scope, undefined);

		// **The pool as one number in segments**, with the three fills computed from it rather than tracked
		// separately. One `Value` for the reading and three `Computed`s for the drawing is one source of
		// truth; three `Value`s would be three things to keep in step with one attribute, which is the
		// mistake `panels.ts` describes about its own pair of booleans.
		const staminaUnits = Fusion.Value(scope, SEGMENT_COUNT);

		const icon = this.addIconSlot(scope, theme, iconId, usesLeft);

		// Built *after* the slot and given it as a parent, because it is anchored to the slot's own left edge
		// — see {@link addCount}. No value is kept: the label is wired to `usesLeft` and needs nothing further
		// from this method, so a local holding it would be a name nothing reads.
		this.addCount(scope, theme, icon, usesLeft);

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

				// **The MultiBall window, read as a count rather than as "is one open".** Since the window lost
				// its clock, a non-zero count *is* an active window — see `SuperService.isMultiBallActive` — so
				// this one read answers both questions the slot has about it: whether to draw the icon, and what
				// number goes beside it.
				const multiBall = this.multiBallLeftOf(player);

				// **The flash starts on the edge where a prize appears, and is abandoned when one goes away.**
				// That is one rule with three cases: a prize arriving starts it, a prize staying starts nothing,
				// and a prize *leaving* clears it. The last case is the one worth naming — the ways a prize
				// leaves are using it and dying, both of which the player just did, so a spin that kept running
				// would be celebrating a pickup while the slot already showed how it ended.
				if (prize !== undefined && previousPrize === undefined) flashStartedAt = clock;
				if (prize === undefined) flashStartedAt = undefined;

				previousPrize = prize;

				// **What the slot shows, in the order the four states outrank each other.** The flash while it
				// runs, then a held prize, then an arm, then a running MultiBall window, then nothing. A prize
				// outranks the arm because it is the power the box paid for and the only one of the two with an
				// ending; the arm outranks nothing because it is still something the player is about to use.
				// **The window is last**, because it is the only one of the four that is a *state* rather than
				// something pending — an arm is a decision waiting on a ball, and a window is a supply that will
				// still be there in a second. It is also the only one that can be arrived at with nothing else
				// held, which is the ordinary case: using a MultiBall prize spends the prize, so the slot is
				// empty for the whole life of the window unless the player collects another box.
				//
				// **The non-empty guard is not decoration**: `% 0` is a division by zero, and a config with every
				// icon removed is a thing somebody could do.
				const started = flashStartedAt;

				let shown = "";
				// Which power the slot settled on, kept beside the id rather than recovered from it: the id is
				// what the `ImageLabel` wants and the *kind* is what the uses count has to be matched against,
				// and the flash deliberately sets one without the other.
				let shownKind: AbilityKind | undefined;

				if (started !== undefined && revealIcons.size() > 0 && clock - started < FLASH_SECONDS) {
					const step = math.floor((clock - started) / FLASH_STEP_SECONDS);
					shown = revealIcons[step % revealIcons.size()];
				} else if (prize !== undefined) {
					// The settle, and it is written by this branch on every frame after the spin ends — so the
					// answer is on screen from the frame the flash stops rather than at the end of a fade.
					shown = IMAGES_CONFIG.ABILITY_ICONS[prize];
					shownKind = prize;
				} else if (armed !== undefined) {
					shown = IMAGES_CONFIG.ABILITY_ICONS[armed];
					shownKind = armed;
				} else if (multiBall > 0) {
					shown = IMAGES_CONFIG.ABILITY_ICONS[MULTI_BALL_KIND];
					shownKind = MULTI_BALL_KIND;
				}

				iconId.set(shown);

				// **The number belongs to the power the slot is *showing*, not to the player**, and that is the
				// whole of the single-use decision. A power with one use has nothing to say here, so Pierce and
				// Freeze draw no number at all — rather than a permanent `1`, which is a figure that never
				// changes and would teach a player that this label is decoration. MultiBall draws its count
				// whenever it is what the slot is showing, **including on the last throw**, which is the moment
				// a player most wants to see it. And because the two are matched rather than assumed, a player
				// holding a box's Pierce while a MultiBall window runs gets the Pierce icon with no number
				// beside it, which is the honest answer to "how many pierces do you have left".
				usesLeft.set(shownKind === MULTI_BALL_KIND ? multiBall : undefined);

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
	 * How many throws the player's MultiBall window has left, or `0` when there is no window.
	 *
	 * **`0` is both "no window" and "spent", which is one empty case rather than two** — the convention the
	 * attribute itself carries, and the reason this does not return `undefined` where its sibling above does.
	 * Everything that reads it wants a number: the icon is drawn when it is above nought, and the count is
	 * drawn from it directly once the slot has settled on MultiBall.
	 *
	 * **The read is validated rather than trusted**, exactly like the arm's and the prize's beside it: the
	 * attribute comes from a server that could be a newer build with something else on it, and `0` is the
	 * answer that draws nothing rather than the answer that breaks a label.
	 *
	 * **This is the source of the count, and no new publish was needed for it.** `SuperService.publish`
	 * already wrote it as part of the readout; what changed is what it *means* — with the window's clock gone
	 * the count is the whole of the ability rather than the half that ran alongside a deadline, so a non-zero
	 * count is now the only signal that a window is running.
	 */
	private multiBallLeftOf(player: Player): number {
		const count = player.GetAttribute(SUPER_MULTI_BALL_COUNT_ATTRIBUTE);

		return typeIs(count, "number") && count > 0 ? count : 0;
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
	 *
	 * **The uses count is a child of the slot rather than a sibling in the column, and that is the layout
	 * decision.** The stack's column is a `UIListLayout` that centres its children, so a row holding the
	 * number and the icon side by side would be a row whose *centre* is the column's centre — which moves the
	 * icon to the right by half the number's width, off the line the stamina lights below it are on. Anchored
	 * to the slot's own left edge instead, the count grows leftwards into empty screen and **the icon does not
	 * move at all**. No arithmetic is involved on either side: the anchor is relative, so the number never has
	 * to know how wide the slot is and the slot never has to know how wide the number is.
	 *
	 * **It is `undefined` rather than `0` when there is nothing to count**, and that is the state the whole
	 * label is drawn from — a `Value<number | undefined>` where `undefined` means "no count", so the number
	 * and its visibility cannot disagree. See {@link addCount} for the rule that decides which powers get one.
	 */
	private addIconSlot(
		scope: Fusion.Scope<unknown>,
		theme: HudTheme,
		iconId: Fusion.Value<string>,
		usesLeft: Fusion.Value<number | undefined>,
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
	 * The number of uses left in the power the slot is showing, to the **left** of the icon.
	 *
	 * **A number and not a word, and it is only there when there is something to count.** The decision the
	 * brief leaves open is what a single-use power shows, and the answer taken is *nothing at all* — see the
	 * rule at the call site rather than a rule here, because the count is drawn from one value that is
	 * `undefined` when there is nothing to say. The two alternatives were both worse: **showing `1` for Pierce
	 * and Freeze** is a number that never changes, on the two powers the count was not added for, and it
	 * teaches a player that the number is decoration; **hiding it at exactly one** would be worse still,
	 * because it would take the number away from MultiBall on the last throw — the one moment a player most
	 * wants it.
	 *
	 * **Anchored to the slot's left edge, so it cannot move the icon.** See {@link addIconSlot} for why that
	 * is a `Position`-and-`AnchorPoint` decision rather than a row, and {@link COUNT_GAP} for the one number
	 * involved.
	 *
	 * **`AutomaticSize.XY` with a zero size**, which is `ScoreHudController.addScore`'s rule and the trap it
	 * documents: big-ui's `Text` defaults to a *scale-1* width, and a scale-1 label inside a parent that is
	 * sized by its contents is a measurement cycle Roblox resolves by making the parent huge. A zero-offset
	 * size plus `AutomaticSize` makes the label exactly as wide as the number it holds, which here also means
	 * the number grows *leftwards* from a fixed right edge as it changes from `5` to `4`.
	 *
	 * **The colour is `textPrimary` and there is no plate behind it**, which is `SLOT_TRANSPARENCY`'s
	 * consequence rather than a choice: the slot behind the icon is 80% transparent, so this number is drawn
	 * on the world. Dark text on a light arena floor is right, and if a map ever makes it disappear the lever
	 * is a `UIStroke` in `theme.colors.shadow` rather than a different colour — the theme's palette is a
	 * light-surface language and there is no darker entry to reach for.
	 */
	private addCount(
		scope: Fusion.Scope<unknown>,
		theme: HudTheme,
		slot: Frame,
		usesLeft: Fusion.Value<number | undefined>,
	): TextLabel {
		const label = Text(scope, {
			text: Fusion.Computed(scope, (use) => {
				const left = use(usesLeft);

				return left === undefined ? "" : tostring(left);
			}),
			variant: "subtitle1",
			wrap: false,
		});

		label.Name = "UsesLeft";
		label.TextColor3 = theme.colors.textPrimary;
		label.Size = UDim2.fromOffset(0, 0);
		label.AutomaticSize = Enum.AutomaticSize.XY;
		// Right edge at the slot's left edge, less the gap; vertically centred on the slot. Relative in both
		// axes, so nothing here is derived from either element's size.
		label.AnchorPoint = new Vector2(1, 0.5);
		label.Position = new UDim2(0, -COUNT_GAP, 0.5, 0);
		label.Parent = slot;

		// **`Hydrate` rather than an assignment, and that part is forced rather than stylistic.** `Text` builds
		// its label and hands it back, so a reactive value merely *assigned* to one of its properties afterwards
		// is never tracked as a property at all — the trap `BallService`'s user-facing twin records in
		// `viewportConstraint.ts` ("a graph object has to be part of a `New` to be tracked as a property") and
		// that `RoundStatusController` documents at its own card. The `text` above is computed inside the
		// `Text` call and is tracked for free; this one has nowhere to go but here.
		//
		// **The empty state is the icon's empty state, from the same `undefined`.** `Visible` is not a second
		// flag to keep in step: the count is hidden exactly when there is no count to draw, and the icon is
		// hidden exactly when `iconId` is `""` — the same situation, because one branch of the loop below sets
		// both.
		Fusion.Hydrate(scope, label)({
			Visible: Fusion.Computed(scope, (use) => use(usesLeft) !== undefined),
		});

		return label;
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
