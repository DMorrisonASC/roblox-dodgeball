import { Controller, OnStart } from "@flamework/core";
import { Text } from "@rbxts/big-ui";
import Fusion from "@rbxts/fusion-3.0";
import { Players, RunService, SoundService, TweenService } from "@rbxts/services";
import { AbilityKind, isAbilityKind } from "shared/ability";
import { AUDIO_CONFIG } from "shared/config/audio.config";
import { CHARACTER_CONFIG } from "shared/config/character.config";
import { IMAGES_CONFIG } from "shared/config/images.config";
import {
	ARMED_ABILITY_ATTRIBUTE,
	MYSTERY_POWER_ATTRIBUTE,
	POWER_READY_ATTRIBUTE,
	STAMINA_ATTRIBUTE,
	SUPER_MULTI_BALL_COUNT_ATTRIBUTE,
} from "shared/constants";
import { sessionHudVisible } from "../../panels";
import { HudTheme, hudTheme, UI_FONT } from "../../ui/hudTheme";
import { getHudScreenGui } from "../../ui/screenGui";
import { addViewportConstraint } from "../../ui/viewportConstraint";
import { SuperAbility } from "../input/SuperAbility";

/** Prints once, when the stack is up — the line that says the controller ran at all. */
const DEBUG = true;

/**
 * How far up from the bottom of the screen the stack's *bottom edge* sits, in pixels.
 *
 * **The same inset the rest of the bottom furniture uses**, and that is the point: `DockController`'s buttons
 * sit 12px off their corner and the touch client's joystick ring leaves the same kind of gap in the corner it
 * owns, while this stack sits 12px off the bottom *edge* — so the furniture along the bottom of the screen
 * reads at one height rather than at three.
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
 * one. Nothing overlaps in either direction today: the dock shows whenever this player is *not* in a
 * round and this shows
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
 * floating with nothing to anchor it. It is now a faint plate that never changes: at 0.8 it says "this is
 * where the slot is" without ever claiming to be *filled*, and **the arrival of the art is the whole of the
 * answer** rather than one half of a pair.
 *
 * **So the empty state has no signal of its own, deliberately.** One constant background and one fewer state
 * for a player to notice is the trade this number makes — not an oversight. An arm being set, held, spent or
 * lost all look the same on the plate, which is the point of a background: it is furniture, and what changes
 * is the picture standing on it.
 *
 * **The glow is the one thing that has changed about that, and it changed *around* the plate rather than on
 * it.** A power waiting to be spent now draws a ring in the theme's accent — see {@link GLOW_THICKNESS} — and
 * the ring is a `UIStroke` on the plate's edge, so the fill is still one colour at one opacity in every state
 * and the paragraph above is still exactly true. What the ring adds is a signal about the *player's* situation
 * rather than about the picture: it says "a press here would do something", which is a fact the picture alone
 * cannot carry, because a MultiBall window draws a picture too and a press spends nothing of it.
 *
 * **At 0.8 the world is visible through it**, which is worth knowing when reading the icon's own comment
 * below: the plate is a tint rather than a backdrop, so the pixels the icon is drawn on are, for practical
 * purposes, whatever is behind the player.
 */
const SLOT_TRANSPARENCY = 0.8;

/**
 * How much the slot grows when a power arrives or is spent, and how long the settle takes.
 * **Placeholder — 1.15 / 0.22.**
 *
 * **The pop is a result rather than an acknowledgement, and the number is sized by that.** It plays at the two
 * moments this client can honestly say something *happened*: when the reel lands on a new prize — the arrival is
 * the punchline of the shuffle, and without it the strip simply stops, which reads as the animation being cut
 * off — and when a power that was waiting goes away (the box's prize spent, or a dev's arm taken up by a ball).
 * A press that is refused changes nothing and pops nothing, which is the useful half of the same signal.
 * `15%` is enough to read as a hit at arm's length without the icon leaving its slot, and a fifth of a second is
 * long enough to see and short enough that a second press can follow it.
 *
 * **One number for both edges on purpose**: an arrival and a spend are the same fact about the slot — its
 * picture changed because of something the player did — so they get the same size of acknowledgement. A louder
 * arrival would be the slot claiming the pickup was more important than the use, which is the opposite of what
 * the animation is for.
 *
 * **The snap is instant and the settle is the tween**, which is what makes it read as a pop rather than as a
 * grow: the scale is written to {@link POP_SCALE} in one property write and tweened back to `1` with a `Back`
 * easing, so the eye gets an arrival and a bounce rather than a ramp up and a ramp down. The alternative — a
 * tween up and a second tween down — is two animations and a completion callback for the same pixels.
 */
const POP_SCALE = 1.15;
const POP_SECONDS = 0.22;

/**
 * The glow: how thick the ring around the plate is, and how solid it is while a power is waiting.
 * **Placeholder — 3 / 0.25.**
 *
 * **A `UIStroke` rather than an effect, because a stroke is the only *light* this client has.** A halo would
 * want an image asset or a gradient, and there is none; what the HUD already knows how to do is draw a ring
 * (`ScoreHudController`'s discs wear one in the plate's own colour, `addTile`'s chips wear a hairline), so the
 * slot lit up is that same vocabulary turned up: a thicker ring, in the theme's accent, at a quarter of its
 * opacity left. It is a *state* and not an animation — it is on for exactly as long as a press would do
 * something — which is why nothing here eases.
 */
const GLOW_THICKNESS = 3;
const GLOW_TRANSPARENCY = 0.25;

/**
 * **How long the shuffle runs when a box is collected, in seconds. Placeholder — 1.6.**
 *
 * **Shorter than the three seconds this spent flashing, and the *motion* is why the number could come down.** The
 * old reveal stepped one icon every 0.15 seconds at a constant rate and then simply showed the answer: twenty
 * sharp changes of a picture, and a reader had to count them to know something was happening. A reel that
 * *decelerates* into its answer does not need twenty steps to be legible — the slowing is the signal, and by the
 * time the eye has worked out that the picture is still moving, it is stopping. A third less time, and more of it
 * is spent at the end where a player is actually watching.
 *
 * **What the number has to satisfy is "long enough that the landing feels earned"**, and that is a question for a
 * screen. Too short and the reel is a glitch; much longer inside a 56-pixel slot and it is a thing the player is
 * waiting out, which is the trap the old constant was in.
 */
const SHUFFLE_SECONDS = 1;

/**
 * **How many passes of the ability list the reel travels before it stops.**
 *
 * **Eight, which is where the speed comes from rather than where the duration does.** The reel is a strip of one
 * icon per row pulled upward, and the tween's destination is the winning power's row *in the last pass* — so the
 * distance is what makes the first third a blur and the distance is set here. More passes at the same
 * {@link SHUFFLE_SECONDS} is a faster reel, not a longer one.
 *
 * **Eight rather than three or thirty**, because the reel has to go round often enough that the eye stops trying
 * to read individual icons (three powers means a reader can track each one — that is what makes a short pass look
 * like a slideshow) but not so often that the last pass arrives as a number rather than as a motion. The set is
 * per-pass rather than a row count for the reason `IMAGES_CONFIG.ABILITY_ICONS` gives about itself: a fourth
 * power should lengthen the reel, not shorten its steps.
 */
const SHUFFLE_PASSES = 8;

/**
 * The corner on the icon's plate and on every stamina segment. One radius, so the stack looks like one thing.
 */
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
 * The word above the slot while a power is armed: **`READY`, static, and the whole of what this HUD says
 * about a power that is loaded and waiting.**
 *
 * **One word and no animation, by design.** The slot already has the vocabulary for a power *arriving*
 * (the reel) and for one *going* (the pop); this is the third state either of those would be wrong for —
 * a power that is simply there, waiting for the player to throw it — and a state is what a label is for.
 * A pulse or a fade would be a fourth thing moving on a HUD whose job in this corner is to be glanced at.
 *
 * **Upper case, matching every other word this client draws at a player** (`hitConfirm`'s ladder,
 * the round's own labels), and short enough to fit over a 56-pixel slot at a readable size.
 */
const READY_TEXT = "READY";

/**
 * The label's box, in pixels. **Placeholder — the same shape of guess `ICON_SIZE` is.**
 *
 * `TextScaled` fills whatever box it is given, so this is "how big the word is" rather than a letter size:
 * 88 × 22 over a 56-pixel slot puts the word a little wider than the plate it sits above, which is what
 * makes it read as this stack's label rather than as text floating over the screen. The height is the
 * number to move first if it reads as too loud — the width only decides the letter size.
 */
const READY_WIDTH = 88;
const READY_HEIGHT = 22;

/**
 * How far above the slot's top edge the label's *bottom* sits, in pixels. **Placeholder.**
 *
 * A gap rather than an overlap, because the plate is 0.9 transparent — a word drawn across its top edge
 * would read through the plate and land on the icon underneath. The value is under the stack's own
 * `STACK_GAP` (10) and that is deliberate: this is one label attached to the slot, not a third row of
 * furniture, so it belongs closer to the thing it describes than the stamina lights do.
 */
const READY_GAP = 4;

/**
 * The outline's thickness, in pixels. **Placeholder — and smaller than `hitConfirm`'s `4` on purpose.**
 *
 * That splash is a 150-pixel box scaled by the viewport, so its `4` is roughly three per cent of the
 * letters; this label is 22 pixels tall, where `4` would eat the word and read as a blob. `2` is the same
 * proportion at this size, and the *pair* is what matters: white glyphs inside the theme's near-black
 * outline, which is the one combination that survives a bright court, a dark rig and everything between.
 */
const READY_STROKE_THICKNESS = 2;

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
 * The power slot's three halves: **the frame the column places, the pop played on the plate inside it, and the
 * shuffle that reveals a new prize.**
 *
 * **A record rather than just the frame, because both animations are something *somebody else* has to
 * trigger.** The loop in `mount` is what knows when a power arrived or was spent — it is the only thing reading
 * `MYSTERY_POWER_ATTRIBUTE` and `ARMED_ABILITY_ATTRIBUTE` — and the plate that moves is three levels down inside
 * the builder. Handing back closures rather than the instances keeps each animation's entire mechanism on one
 * side of the boundary: the caller has verbs, not a `UIScale` and a strip it has to remember to tween.
 *
 * **`spin` rather than `shuffle`, and it takes the kind rather than finding it**, because the reel has to land
 * on a *specific row* and only the caller knows which power the server granted. Everything else about the reel —
 * its length, its curve, its sound — is the slot's business and is not a parameter.
 *
 * **Three fields and not methods**, for `addTile`'s `Tile` reason: there is nothing else either piece has to do,
 * and a function-typed property is also the shape roblox-ts accepts an arrow function into — an interface
 * member declared with method syntax refuses an arrow function on the other side ("Attempted to assign
 * non-method where method was expected"), which is recorded in this project's notes as a trap that reads as a
 * type error in code that is otherwise correct.
 */
interface PowerSlot {
	/** What the stack's column places, and what the uses count is anchored to. */
	readonly frame: Frame;

	/** Plays the pop: a snap up to {@link POP_SCALE} and a settle back to rest. */
	readonly pop: () => void;

	/** Runs the shuffle: the reel, its sound and the landing, ending on the given power. */
	readonly spin: (kind: AbilityKind) => void;
}

/**
 * The power slot and the stamina pool, bottom centre: an icon with three lights under it, and — while a
 * power is armed and unspent — the word `READY` on a line above it.
 *
 * **The word is the newest of the three and the only one that is not a picture.** The icon says *which*
 * power, the lights say how much sprint is left, and `READY` says the one thing neither of them can: that
 * what you are holding is loaded and waiting, so the next throw (or the next press, for a window) is the one
 * that spends it. It is drawn from `POWER_READY_ATTRIBUTE`, which `SuperService` publishes from the two
 * things that can be armed — a mark on the ball in hand, and a MultiBall window with throws left — so this
 * file never infers a state the server has not stated. See {@link addReadyLabel}.
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
 * does. **And the moment a box is collected, the slot shuffles** — a small reel of every power in
 * `IMAGES_CONFIG.ABILITY_ICONS`, pulled upward inside the slot and decelerating onto the granted one, with a
 * sound running under it. That shuffle is the announcement the deleted `MysteryToastController` used to make in
 * words, and it is deliberately *in the slot*: this is the element a player learns to look at for their own
 * power, so the answer arriving in it is the answer arriving where they already look. Not the owned roster,
 * which stays the shop's business. That also means **nothing here reads the character any more** — the old
 * strip looked up the ball in hand by name on every frame, and the icon has no reason to, which removes a
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
 * **One `RenderStepped` loop for all three values**, which is the argument this project reaches for at every
 * frame loop: a pool is sampled by the server at its own rate and would want a subscription, while a fraction
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
	/**
	 * **The power key's client half, injected rather than reached for, because the slot is now a second way to
	 * press it.**
	 *
	 * The tap on the slot sends exactly what `3` sends — see {@link SuperAbility.usePower}, which is the whole
	 * of both paths — so this controller needs the one object that owns that request. **It is the same
	 * constructor injection the server's services use** (`DodgeService`, `BallSpawnerService`), and the direction
	 * of the dependency is the reason it works: the HUD reads the ability controller, and the ability controller
	 * neither knows nor cares that a HUD exists. **A pop pushed the other way — the input calling the HUD — would
	 * be a cycle**, which is why the pop is driven by the attribute rather than by the press. See the loop's own
	 * comment for that argument.
	 */
	constructor(private readonly abilities: SuperAbility) {}

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

		/**
		 * **Whether a power is waiting to be spent, and what the slot's two pieces of feedback are drawn from.**
		 * One `Value<boolean>` rather than two subscriptions and rather than a second read of the two attributes
		 * at the stroke: the loop already reads both of them every frame, so this is the loop's answer being
		 * handed to the one thing that needs it. See the loop for the rule.
		 */
		const glowing = Fusion.Value(scope, false);

		/**
		 * **Whether a power is armed and unspent — read straight off `POWER_READY_ATTRIBUTE` and nothing
		 * else.**
		 *
		 * Seeded from an attribute read taken before the loop starts, so a client that mounts while a power is
		 * already armed (a rejoin, a respawn, a round that started while this was loading) shows the word
		 * immediately rather than at the next edge — the same seeding `previousPrize` does for the reveal, and
		 * for the same reason.
		 *
		 * **This is a `Value` rather than a second thing the loop decides from, which is what keeps the label
		 * honest.** The loop writes it once per frame from the attribute; the label's `Visible` is bound to it;
		 * nothing else in this file reads or writes it. The server owns the answer — see `SuperService.armPower`
		 * for the two sources and the four completions — and this file never infers "ready" from a ball, a
		 * count or an arm of its own.
		 */
		const ready = Fusion.Value(scope, player.GetAttribute(POWER_READY_ATTRIBUTE) === true);

		/**
		 * **The reel's faces, and why the list is the config's rather than the player's roster.** Every power in
		 * the game is shuffled past — including the ones this player does not own — because that is what makes
		 * the reveal a tease rather than a confirmation, and `IMAGES_CONFIG.ABILITY_ICONS` is the only thing that
		 * knows the whole set. A power added there joins the reel with no code change here; the roster would be
		 * the roster of *gameplay*, and "an icon for a power you cannot use" is exactly the case a tease exists
		 * to show.
		 *
		 * **Built once, here, and never rebuilt**, for the reason the old flash gave about its own list: a list
		 * rebuilt per frame could skip or repeat an entry, and the reel's landing row is an *index into this
		 * array* — so a list that changed underneath a spin would land on the wrong power, which is the one
		 * failure this animation exists to avoid.
		 *
		 * **`pairs` and not a sequence**, because there is no sequence to have: the record is keyed by kind and
		 * the order is whatever the table gives. A reel needs a *stable* order rather than a meaningful one, and
		 * this array is the order for the life of the mount.
		 */
		const reelFaces = new Array<AbilityKind>();
		for (const [kind] of pairs(IMAGES_CONFIG.ABILITY_ICONS)) {
			reelFaces.push(kind);
		}

		const slot = this.addIconSlot(scope, theme, iconId, usesLeft, glowing, reelFaces);

		// **The READY word, over the slot rather than in the column**, and that is the layout decision: a child
		// of the column would be a fourth thing its `UIListLayout` positions, so a word that comes and goes
		// would move the icon and the stamina lights every time a power was armed and spent — the same reason
		// `PowerSlot.pop` is played on the plate inside a frame the layout owns rather than on the frame
		// itself. As a child of the slot's own frame it rides with the stack, inherits the column's
		// `Visible`, and costs the layout nothing at all.
		this.addReadyLabel(scope, theme, slot.frame, ready);

		// Built *after* the slot and given its frame as a parent, because it is anchored to that frame's left
		// edge — see {@link addCount}. The *outer* frame rather than the plate inside it, deliberately: the
		// count is drawn beside the slot and the plate is what pops, so a number anchored to the plate would
		// jump with every pop.
		this.addCount(scope, theme, slot.frame, usesLeft);

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

		slot.frame.LayoutOrder = 1;
		slot.frame.Parent = column;

		segments.LayoutOrder = 2;
		segments.Parent = column;

		// The stack is as wide as its widest child — the three segments — and pinned to the bottom centre,
		// so a viewport narrower than that row would push it off both edges at once. The bound costs
		// nothing on a screen wide enough for it, and it is the same rule every other HUD here follows:
		// the element carries its own limit rather than trusting that the screen will be big enough.
		addViewportConstraint(scope, column);

		// **Two locals, and both are the loop's memory rather than the state.** `previousPrize` is the edge
		// detector for a pickup: the box is collected on the *server*, so the only way this loop can know one
		// happened is by noticing a value that changed. It is seeded from a read taken before the loop starts, so
		// a player who is already holding a prize the first time this runs — a rejoin mid-round, or a dev grant —
		// sees the icon without a shuffle they did not earn.
		//
		// **`previousWaiting` is the second, and it is the same kind of thing as the first.** Where `previousPrize`
		// detects a power *arriving*, this detects one *going*: the shuffle celebrates the arrival and the pop
		// marks the departure, so between them the two edges are the slot's whole vocabulary of events. It is
		// seeded from the same pre-loop read for the same reason — a client that mounts while a power is already
		// waiting must not pop at the first frame, because nothing happened.
		//
		// **There was a third, and it is gone with the flash it timed.** The old spin was a clock this loop owned
		// (`flashStartedAt`, `undefined` for "not spinning") and stepped every frame; the reel is one tween with a
		// duration, owned by the slot, so the only thing left for this loop to do about it is start it. See the
		// pickup edge below.
		let previousPrize = this.prizeOf(player);
		let previousWaiting = this.armedOf(player) !== undefined || previousPrize !== undefined;

		// The one connection in this file, reading all three values. See the class doc for why this is a loop
		// rather than three subscriptions.
		scope.push(
			RunService.RenderStepped.Connect(() => {
				// **`time()` is no longer read here.** The old reveal timed itself from this loop with a
				// `flashStartedAt` clock; the reel is a tween with a duration in seconds, so the animation's state
				// lives in the slot and this loop has nothing to time and no clock to read.

				// **The arm and the prize, validated the same way** — the rule `abilityOn` applies to a ball's
				// mark, so a word this build does not name reads as *nothing* rather than as a broken image.
				const armed = this.armedOf(player);
				const prize = this.prizeOf(player);

				// **The MultiBall window, read as a count rather than as "is one open".** Since the window lost
				// its clock, a non-zero count *is* an active window — see `SuperService.isMultiBallActive` — so
				// this one read answers both questions the slot has about it: whether to draw the icon, and what
				// number goes beside it.
				const multiBall = this.multiBallLeftOf(player);

				// **Whether a press would spend anything, which is the slot's one *state* rather than its picture.**
				// The two things that answer yes are the two things `3` — or a tap on this slot — actually spends:
				// the box's prize, and the dev shortcut's arm. **A running MultiBall window is deliberately not
				// one of them**, because it is not something a press spends; the window is a supply that pays out
				// on throws of its own accord.
				//
				// It drives the two pieces of feedback and both are *states* of it: the glow is on for exactly as
				// long as a press would do something, and the pop fires on the frame the answer goes from yes to
				// no. **That direction is the honest one for a pop** — a press that the server refuses (no ball in
				// hand, no prize held, no round) changes no attribute, so it pops nothing, and what the player
				// sees is that nothing happened. The tap itself is not the trigger for a reason that is structural
				// rather than aesthetic: the ability controller would have to know this HUD exists, which is the
				// cycle the constructor's doc points at.
				const waiting = prize !== undefined || armed !== undefined;

				if (!waiting && previousWaiting) slot.pop();
				previousWaiting = waiting;
				glowing.set(waiting);

				// **The reel spins when the prize *becomes a power*, and on nothing else.** Not on a prize
				// *staying* — this loop runs at the frame rate, so a reel started from "a prize is held" rather
				// than from "the prize changed" would be a reel that never stopped — and not on a prize *leaving*,
				// because the ways a prize leaves are using it and dying, both of which the pop covers while a
				// reel spinning for a power the player just spent would be telling them about a decision they have
				// already made.
				//
				// **A change between two powers counts, which is why this is not the `undefined`-to-something
				// test it started as.** The server can replace a held prize with another one (a second box
				// collected, a dev grant), and in that case the attribute goes from one kind straight to another
				// without ever being empty — so an edge detector written as "was nothing, is something" would be
				// silent for exactly the pickup a player most wants to see announced.
				//
				// **The kind is the whole of what crosses the boundary**, which is `PowerSlot.pop`'s shape: this
				// loop owns the reading of the attribute and the slot owns the animation, so the slot never has to
				// know that `MYSTERY_POWER_ATTRIBUTE` exists and this loop never has to know how a reel is built.
				if (prize !== undefined && prize !== previousPrize) slot.spin(prize);

				previousPrize = prize;

				// **What the slot shows, in the order the three states outrank each other.** A held prize, then an
				// arm, then a running MultiBall window, then nothing. A prize outranks the arm because it is the
				// power the box paid for and the only one of the two with an ending; the arm outranks nothing
				// because it is still something the player is about to use.
				// **The window is last**, because it is the only one of the three that is a *state* rather than
				// something pending — an arm is a decision waiting on a ball, and a window is a supply that will
				// still be there in a second. It is also the only one that can be arrived at with nothing else
				// held, which is the ordinary case: using a MultiBall prize spends the prize, so the slot is
				// empty for the whole life of the window unless the player collects another box.
				//
				// **The reel is not a fourth state, and that is deliberate.** It is drawn *over* whatever this
				// list says — see `addIconSlot` — so the loop carries on answering "what power do you hold" while
				// the reel turns, and the answer is already correct underneath it when the reel stops. A reel that
				// owned the slot's state would be a second thing to unwind when a prize is spent mid-spin, which
				// is a real sequence: the player can press `3` during the animation.
				let shown = "";
				// Which power the slot settled on, kept beside the id rather than recovered from it: the id is
				// what the `ImageLabel` wants and the *kind* is what the uses count has to be matched against.
				let shownKind: AbilityKind | undefined;

				if (prize !== undefined) {
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

				// **And the one word about an armed power, off the one attribute the server publishes for it.**
				// No inference here: `SuperService` decides what "armed" means for both kinds of power (a mark
				// carried by the ball in the hand, a MultiBall window with throws left) and publishes the
				// answer, so this line is a read rather than a rule. That is also why the label cannot say
				// ready for a power the server has already spent — the attribute goes false in the same
				// publication that spends it.
				ready.set(player.GetAttribute(POWER_READY_ATTRIBUTE) === true);
			}),
		);

		column.Parent = getHudScreenGui();

		if (DEBUG) {
			print(
				`[HUD] power slot up — ${ARMED_ABILITY_ATTRIBUTE} on the player, ${SEGMENT_COUNT} stamina` +
					` segments over ${CHARACTER_CONFIG.STAMINA_MAX_SECONDS}s, shuffle over` +
					` ${reelFaces.size()} icon(s) x ${SHUFFLE_PASSES} passes`,
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
	 * Which power a dev's shortcut has waiting for the next ball this player takes up, or `undefined`.
	 *
	 * **The prize's read, one attribute over, and the two are deliberately the same three clauses.** `prizeOf`
	 * says the shape out loud — read, validate, narrow, and a word this build does not name reads as *nothing*
	 * rather than as a missing icon — and this is that shape again for the arm, which used to be written inline
	 * in the loop. It is a method now because the loop is not its only reader: the seed that stops the slot
	 * popping on the first frame reads it too, and a second copy of a three-clause test is a second chance to
	 * fix only one of them — the sentence `prizeOf`'s own doc already makes about itself.
	 *
	 * **What the arm is, for a reader who has only met the prize**: a dev-only shortcut that marks the *next*
	 * ball rather than the one in hand, written by `BallService.markHeldBall` and spent by `attachToHand`. It
	 * shares one slot with the prize — "the power my next press uses" — and the prize wins, which is why the
	 * loop's order below puts the prize first.
	 */
	private armedOf(player: Player): AbilityKind | undefined {
		const armed = player.GetAttribute(ARMED_ABILITY_ATTRIBUTE);

		return typeIs(armed, "string") && isAbilityKind(armed) ? armed : undefined;
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
	 *
	 * **It is now three frames, a ring, a reel and a tap, and each one has its own argument written where it is
	 * built.** The pair of frames is what lets the **pop** happen without the column noticing ({@link
	 * PowerSlot.pop}); the ring is the **glow**, drawn around the plate rather than on it so that the plate's own
	 * invariance above survives ({@link GLOW_THICKNESS}); the **reel** is the shuffle ({@link PowerSlot.spin}),
	 * a clipped strip of icons that is *drawn over* the slot's own icon rather than replacing it; and the
	 * transparent button over the whole slot is the **tap**, which is the mobile equivalent of the `3` key and the
	 * same request the key makes — see each one in the body below. **What did not move is the sentence the rest
	 * of this doc is about**: the plate is still one colour at one opacity in every state, and every pixel that
	 * has changed about this slot is either drawn around it or drawn on top of it.
	 *
	 * **It returns the frame, its pop and its spin rather than just the frame**, which `panelChrome.addTile`'s
	 * shape — a builder handing back the pieces its caller has to reach — because the loop is what knows when a
	 * pop or a shuffle is due, and the loop is in `mount` rather than in here.
	 *
	 * **The reel takes the face list rather than reading the config itself**, and that is the one parameter that
	 * is not an argument about this slot: `mount` builds the list once (see its own note) and this method places
	 * rows for it. A builder that read `IMAGES_CONFIG` on its own would be a second place the reel's contents are
	 * decided, and the landing index would then be an index into a list this method had built *differently* from
	 * the one `mount` used to find the winner.
	 */
	private addIconSlot(
		scope: Fusion.Scope<unknown>,
		theme: HudTheme,
		iconId: Fusion.Value<string>,
		usesLeft: Fusion.Value<number | undefined>,
		glowing: Fusion.Value<boolean>,
		reelFaces: readonly AbilityKind[],
	): PowerSlot {
		// **Two frames where there was one, and the pop is the whole reason.** The column places a `UIListLayout`
		// child, and what pops has to be something that is *not* laid out: a `UIScale` written onto the frame the
		// layout positions is a size the layout may or may not take into account — whether a `UIListLayout` reads
		// `AbsoluteSize` through a `UIScale` is not something the typings answer — and if it does, a pop would
		// push the stamina lights down the screen and pull them back, twice per press. Nested, the answer is the
		// same under either reading: the outer frame stays exactly `ICON_SIZE` and the plate inside it grows out
		// of the space it occupies, drawn over its neighbours rather than moving them, because nothing here clips.
		const frame = Fusion.New(scope, "Frame")({
			Name: "PowerSlot",
			Size: UDim2.fromOffset(ICON_SIZE, ICON_SIZE),
			// Transparent, because it is a *slot in a layout* now rather than a surface: every pixel a player
			// sees is the plate's, and the only other thing on it is the tap.
			BackgroundTransparency: 1,
		});

		const plate = Fusion.New(scope, "Frame")({
			Name: "Plate",
			Parent: frame,
			Size: new UDim2(1, 0, 1, 0),
			BackgroundColor3: theme.colors.trough,
			// One value in both states, and **not a `Computed`** — which is what makes "it stays" something
			// this code says rather than something a reader has to check two branches to confirm. **The glow did
			// not change that**: the accent ring is drawn *around* the plate, so the plate is the same plate it
			// always was in every state, which is the sentence the doc above is about.
			BackgroundTransparency: SLOT_TRANSPARENCY,
		});

		// The scale the pop is played on. Created once, here, rather than written into the loop: a frame loop
		// makes no instances, and this is the instance the one animation in this file moves.
		const scale = Fusion.New(scope, "UIScale")({ Parent: plate, Scale: 1 });

		// The corner the plate has always had, back with it: a hard-cornered square sitting above three
		// rounded lights reads as a different kind of object rather than as the top of the same stack.
		Fusion.New(scope, "UICorner")({ Parent: plate, CornerRadius: new UDim(0, CORNER_RADIUS) });

		/**
		 * **The glow: a ring in the accent, on while a power is waiting to be spent.**
		 *
		 * It hangs off the *plate* so it hugs the surface it is lighting — a `UIStroke` follows its parent's
		 * shape and corner — and it is a ring rather than a haze or a tint because a ring is the only light this
		 * client can draw without an asset. See {@link GLOW_THICKNESS} for that, and for the state it tracks.
		 *
		 * **A `Computed` over the loop's own `Value`, rather than a property the loop writes frame by frame.**
		 * The loop already knows the answer, and this is the bridge the rest of the file uses for anything that
		 * comes out of a frame — the same reason `iconId` is a `Value` rather than an id written straight onto
		 * the label. It has to be passed in the props of a `New` to be tracked at all, which is why it is a
		 * parameter rather than something this method reads: `Transparency` is a property of an instance Fusion
		 * built, and the graph must know about it from the start.
		 */
		Fusion.New(scope, "UIStroke")({
			Name: "Glow",
			Parent: plate,
			Color: theme.colors.accent,
			Thickness: GLOW_THICKNESS,
			ApplyStrokeMode: Enum.ApplyStrokeMode.Border,
			Transparency: Fusion.Computed(scope, (use) => (use(glowing) ? GLOW_TRANSPARENCY : 1)),
		});

		/**
		 * **Whether the reel is turning, and the only state the shuffle adds to this slot.**
		 *
		 * It is read by exactly two things: the reel's own `Visible`, and the resting icon's `ImageTransparency`.
		 * The second is what makes the reel an *overlay* rather than a replacement — while it turns, the icon
		 * underneath is transparent, so two pictures are never drawn in the same 56 pixels; as soon as it stops,
		 * the icon is whatever the loop currently says the slot holds.
		 *
		 * **That is also what makes a spent prize during a spin a non-event.** The player can press `3` while the
		 * reel is still turning, which empties the prize attribute; the loop keeps writing the icon it thinks is
		 * true, the reel finishes on the power that *was* granted, and then the flag drops and the slot shows the
		 * truth — which is nothing held. A reel that owned the slot's state would have to be unwound by hand for
		 * that sequence, and it would be one more thing that could leave a strip drawn over the icon forever.
		 */
		const reeling = Fusion.Value(scope, false);

		// **`BackgroundTransparency = 1` on the *image* is load-bearing, and it is the first thing to check if
		// the art ever shows up inside a rectangle of its own colour.** An `ImageLabel` is a rectangle that
		// *contains* a picture the way a `Frame` is a rectangle that contains nothing — the engine fills it
		// with `BackgroundColor3` unless this line says otherwise, which is why the property exists on every
		// `GuiObject` rather than on the ones that draw a fill. With the plate at {@link SLOT_TRANSPARENCY} the icon
		// is drawn on whatever is *behind* the player, and a fill here would put a second rectangle inside the slot
		// that no amount of work on the asset could take away.
		const icon = Fusion.New(scope, "ImageLabel")({
			Name: "Icon",
			Size: new UDim2(1, 0, 1, 0),
			BackgroundTransparency: 1,
			ScaleType: Enum.ScaleType.Fit,
			Image: iconId,
			// **Hidden while the reel turns, as well as when there is nothing to show.** See {@link reeling} for
			// why the reel overlays the icon instead of replacing it, and why that makes the two flags one.
			ImageTransparency: Fusion.Computed(scope, (use) => (use(iconId) === "" || use(reeling) ? 1 : 0)),
		});

		icon.Parent = plate;

		/**
		 * **The reel: a clipped strip of one icon per row, pulled upward through the slot by a single tween.**
		 *
		 * **It lives in the slot rather than in an overlay of its own, and that is the point of this revision.**
		 * A large screen-space cabinet was built first and read as a second GUI bolted onto the HUD; the reveal
		 * belongs in the element a player already watches for their own power, so the answer arrives exactly where
		 * they look for it. Everything below is therefore the whole of the animation: a clipping window the size
		 * of the plate, a strip of rows behind it, and one number moving.
		 *
		 * **The window is the plate's own rectangle** — `Size = (1, 0, 1, 0)` — so the reel can never be a
		 * different size from the icon it stands in for, whatever `ICON_SIZE` becomes. The one thing that costs
		 * is the glow: a `UIStroke` is drawn as part of the plate, so children cover it, and the accent ring is
		 * hidden behind the reels for the length of the shuffle. That is 1.6 seconds of a state indicator the
		 * landing brings straight back, and the alternative — insetting the reel by the stroke's thickness — would
		 * crop three pixels off every icon for the whole spin, which is the worse of the two.
		 *
		 * **Rows are flush, with no layout padding.** A reel's icons are one picture replacing another, and a gap
		 * would show as a black band crossing the slot twenty-four times; it also makes the landing arithmetic
		 * exactly one multiply, because the row pitch *is* `ICON_SIZE`.
		 *
		 * **A plain `Frame` moved by `Position.Y`, not a `ScrollingFrame` driven by `CanvasPosition`.** The strip
		 * is {@link SHUFFLE_PASSES} passes long and the landing row is near its end, which is exactly where a
		 * scroll surface's position is clamped to its canvas — a clamp would silently land one icon off, and
		 * "it revealed the wrong power" is the one failure a reveal cannot have. Below a window that clips, there
		 * is nothing to clamp: the strip goes where it is told.
		 *
		 * **The rows are created once, at mount**, because the frame a spin starts on is the one frame in this
		 * feature that must not pay for two dozen instances — the same trade `hitConfirm` makes for its caption.
		 */
		const faceCount = reelFaces.size();
		const reelRows = faceCount * SHUFFLE_PASSES;

		const reel = Fusion.New(scope, "Frame")({
			Name: "Reel",
			Parent: plate,
			Size: new UDim2(1, 0, 1, 0),
			BackgroundTransparency: 1,
			// **The clipping is the whole mechanism**: one row fills the window, and everything else is hidden
			// above and below it.
			ClipsDescendants: true,
			Visible: Fusion.Computed(scope, (use) => use(reeling)),
		});

		const strip = Fusion.New(scope, "Frame")({
			Name: "Strip",
			Parent: reel,
			Size: new UDim2(1, 0, 0, reelRows * ICON_SIZE),
			Position: new UDim2(0, 0, 0, 0),
			BackgroundTransparency: 1,
		});

		Fusion.New(scope, "UIListLayout")({
			Parent: strip,
			FillDirection: Enum.FillDirection.Vertical,
			SortOrder: Enum.SortOrder.LayoutOrder,
			Padding: new UDim(0, 0),
		});

		for (let row = 0; row < reelRows; row++) {
			// **The row index is copied into a `const` before it is closed over**, the belt-and-braces
			// `addSegments` documents: Luau's loop variables are per-iteration, but a reader thinking in Lua 5.1
			// would read the closure below as broken, and the `const` says which of the two this is relying on.
			const position = row;

			Fusion.New(scope, "ImageLabel")({
				Name: `Row${position}`,
				Parent: strip,
				Size: UDim2.fromOffset(ICON_SIZE, ICON_SIZE),
				BackgroundTransparency: 1,
				ScaleType: Enum.ScaleType.Fit,
				Image: IMAGES_CONFIG.ABILITY_ICONS[reelFaces[position % faceCount]],
				LayoutOrder: position,
			});
		}

		/**
		 * **The sound, one `Sound` in `SoundService`, looped, and stopped by hand.**
		 *
		 * `elevation.ts` makes the argument for the location and it applies unchanged: a `Sound` is positional
		 * only when it hangs off a `BasePart` or an `Attachment`, and everywhere else it is heard at one level
		 * from anywhere. `SoundService` beats `PlayerGui` because the latter is torn down and rebuilt on every
		 * respawn, and this instance is created once at mount. `MusicController` keeps its tracks here too.
		 *
		 * **`Looped`, because the clip's length has nothing to do with the spin's.** {@link SHUFFLE_SECONDS} is
		 * this file's number; the noise has to last exactly that long and then stop dead, so the loop is what
		 * makes it audible throughout and `<Sound>:Stop()` is what ends it — called from the tween's completion,
		 * and again at the top of a new spin. **The requirement that it must not outlive the landing is met in
		 * two places on purpose**, because the completion callback is the one an interrupted spin could skip.
		 *
		 * **Created through `Fusion.New` so the scope owns it**, which means a HUD that unmounts takes the sound
		 * with it rather than leaving a looping instance behind. Created at mount, which is also what starts the
		 * clip downloading — the first spin of a session may therefore begin before the asset has arrived, which
		 * is why the start is logged.
		 */
		const shuffleSound = Fusion.New(scope, "Sound")({
			Name: "PowerShuffle",
			Parent: SoundService,
			SoundId: AUDIO_CONFIG.POWER_SPIN,
			Volume: AUDIO_CONFIG.POWER_SPIN_VOLUME,
			Looped: true,
		});

		/**
		 * **The tap: the mobile equivalent of the `3` key, and the same request the key makes.**
		 *
		 * A transparent `TextButton` over the whole slot, created last so it is the topmost child — the
		 * construction `panelChrome.addTile` uses for its tiles, and for the same reason: a `Frame` does not
		 * raise `Activated`, so a tappable surface needs a button, and laying one *over* the slot leaves the
		 * plate, the ring and the icon exactly as they are drawn. The icon is an `ImageLabel` and a `GuiObject`
		 * that is not a button does not consume the press, so the whole slot is the target.
		 *
		 * **`Activated` rather than the `InputBegan`/`InputEnded` pair the cluster's buttons use**, and the
		 * difference is real rather than stylistic: there is nothing to *hold* here. The power is spent by a
		 * press, the throw that follows is what carries it, so one event — the one the engine fires for a finger,
		 * a mouse and a gamepad's select alike — is the whole of what this needs. `AutoButtonColor` is off for the
		 * reason every hand-built button in this project switches it off.
		 *
		 * **It is not gated to touch devices, deliberately.** The only thing that differs between a tap and a
		 * click is which finger did it, and a HUD element that behaved differently because of *how* it was pressed
		 * would be a second rule to keep in step; the desktop key is untouched either way. What that means in
		 * practice is that a mouse click on the power icon now asks for the power the same way `3` does — an
		 * addition rather than a change, and the one line to revisit if a desktop player should not have it.
		 *
		 * **A refused tap changes nothing, and nothing here can report one.** The server owns every reason to
		 * refuse — no prize held, no ball in hand for a mark to land on, no round and no zone — and there is no
		 * reply to wait for, which is why the slot's feedback is driven by the attribute rather than by this
		 * call. See the loop for the edge it watches.
		 */
		const hit = Fusion.New(scope, "TextButton")({
			Name: "Tap",
			Parent: frame,
			Size: new UDim2(1, 0, 1, 0),
			BackgroundTransparency: 1,
			Text: "",
			AutoButtonColor: false,
		});

		scope.push(
			hit.Activated.Connect(() => {
				if (DEBUG) print("[HUD] power slot tapped — asking to use the power");

				this.abilities.usePower();
			}),
		);

		/**
		 * The pop, as a closure the loop can call: **snap up, then settle.**
		 *
		 * The scale is written in one property write and then tweened back, which is what makes the motion read as
		 * an arrival and a bounce rather than as a grow and a shrink — see {@link POP_SCALE} for why that is the
		 * shape and what the number is sized against.
		 *
		 * **Any pop already running is cancelled first.** Two spends in quick succession should be two pops rather
		 * than two tweens fighting over one property: only the most recent tween on a property is *guaranteed* to
		 * win, and "guaranteed" is not the same as "the one I meant".
		 */
		const settle = new TweenInfo(POP_SECONDS, Enum.EasingStyle.Back, Enum.EasingDirection.Out);
		let playing: Tween | undefined;

		const pop = (): void => {
			if (playing !== undefined) playing.Cancel();

			scale.Scale = POP_SCALE;
			playing = TweenService.Create(scale, settle, { Scale: 1 });
			playing.Play();
		};

		/**
		 * **The shuffle, as a closure the loop can call: reset the strip, start the noise, pull it up, land, pop.**
		 *
		 * **The landing row is found by searching the face list for the granted kind**, because nothing upstream
		 * knows this slot's list order — the loop reads an `AbilityKind` off an attribute and has no business
		 * knowing how many faces precede it. The search is a linear scan over three entries, and it answers
		 * "which row would this power be on", which is the only question the tween needs.
		 *
		 * **The destination is that face in the *last* pass**, so the strip has to travel the whole reel to reach
		 * it — that is what {@link SHUFFLE_PASSES} is for, and why the number is passes rather than rows. Landing
		 * on the first pass would be a one-row hop, which is a flicker rather than a shuffle.
		 *
		 * **`Quint`/`Out`, and the curve is the improvement.** The old reveal stepped the icon at a constant rate
		 * and then stopped, so the only thing distinguishing "still shuffling" from "landed" was that the picture
		 * stopped changing — the eye had to notice an absence of motion. A `Quint` `Out` curve puts most of its
		 * travel in the first third and then creeps, so the reel visibly *slows down* into its answer: the
		 * deceleration itself is the signal that something is about to be decided, and the last row arrives almost
		 * still. `Back` would overshoot past the landing row and come back, which reads as a bounce — wrong for a
		 * reel that is supposed to stop.
		 *
		 * **The pop fires on the landing**, which is the one thing the old flash never did: the strip stopping is
		 * now an *arrival* rather than an animation ending. See {@link POP_SCALE}, which is one number for both
		 * edges of a power's life so neither claims to be the more important one.
		 */
		const shuffleInfo = new TweenInfo(SHUFFLE_SECONDS, Enum.EasingStyle.Quint, Enum.EasingDirection.Out);
		let spinToken = 0;
		let spinning: Tween | undefined;

		const spin = (kind: AbilityKind): void => {
			// **Nothing to spin past**, which is a config with every icon removed — a thing somebody could do, and
			// `% 0` below is a division by zero if they did.
			if (faceCount === 0) return;

			let index = -1;
			for (let face = 0; face < faceCount; face++) {
				if (reelFaces[face] === kind) {
					index = face;
					break;
				}
			}

			// **A kind with no face lands on the first row rather than erroring.** It cannot happen — the kind
			// arrives through `isAbilityKind`, so this build has a picture for it — but a reel that stops on the
			// wrong icon is a far better failure than an error on the frame a box was opened.
			if (index < 0) index = 0;

			spinToken += 1;
			const token = spinToken;

			// **Everything the previous spin was doing is stopped before this one starts**, which is the same
			// rule as the pop's: only the most recent tween on a property is guaranteed to win, and a shuffle
			// interrupted by another shuffle must not leave a strip half-way down or a noise still running.
			if (spinning !== undefined) spinning.Cancel();
			shuffleSound.Stop();

			strip.Position = new UDim2(0, 0, 0, 0);
			reeling.set(true);
			shuffleSound.Play();

			const landingRow = (SHUFFLE_PASSES - 1) * faceCount + index;
			const landing = new UDim2(0, 0, 0, -landingRow * ICON_SIZE);

			if (DEBUG) print(`[HUD] shuffle — ${reelFaces[index]} on row ${landingRow} of ${reelRows}`);

			const tween = TweenService.Create(strip, shuffleInfo, { Position: landing });
			spinning = tween;
			tween.Play();

			task.spawn(() => {
				// **`Completed` fires on a cancel too**, so the token is what decides whether this is the spin the
				// slot actually finished or one that a newer call replaced — the same pattern `ActionSplash.pop`
				// uses (`ui/actionSplash.ts`).
				tween.Completed.Wait();
				if (token !== spinToken) return;

				// **The noise stops here and nowhere later.** This is the frame the reel lands, which is the
				// moment a ticker still running would be the machine working while the answer is on the screen.
				shuffleSound.Stop();
				reeling.set(false);
				pop();
			});
		};

		return { frame: frame, pop: pop, spin: spin };
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
	 * **The word `READY` above the slot: this HUD's one statement that a power is armed and unspent.**
	 *
	 * **Static, and that is the requirement rather than a stage it is at.** The slot already has a vocabulary
	 * for a power arriving (the reel) and for one going (the pop); this is the third state, a power that is
	 * simply *there* waiting for the throw that spends it, and a state is what a label is for. A pulse, a
	 * fade or a pop here would be a fourth thing moving on a HUD whose job in this corner is to be glanced at
	 * — and it would compete with the two cues that do mean something.
	 *
	 * **Styled the same way the splash is — the pair lives in `ui/actionSplash.ts` — and the two properties
	 * that matter are the font and the stroke mode.** `UI_FONT` is the face every word in this client is drawn
	 * in; `TextScaled` is what sizes the letters within a fixed box (so the word is the same shape on a phone
	 * and on a monitor rather than one pixel size that is right on exactly one screen); and the `UIStroke` is
	 * `Contextual`, which outlines the *letters*. `Border` is the other mode and strokes the label's own
	 * invisible rectangle, which puts nothing around the word at all — see `styleSplashText`'s note, which is
	 * where this pair was worked out. **The colours are the theme's**, `onAccent` inside `trough`, which is the
	 * same white-inside-near-black pair the splash uses, and no `Color3.fromRGB` anywhere: a palette change
	 * stays one file's business. **Written inline rather than through `styleSplashText`** because this label is
	 * a `Fusion.New` props table, and the helper writes properties after construction — the same values in two
	 * shapes, and the reactive `Visible` below is what keeps this one a props table.
	 *
	 * **A plain `Instance` for the stroke**, for the reason `actionSplash.ts` gives: it is configured once and
	 * nothing ever drives it, so there is no property for the graph to track. The label's `Visible` *is*
	 * tracked — it is bound to the loop's `Value` in the props, which is what makes one attribute on the
	 * player the whole of this element's behaviour.
	 *
	 * **A child of the slot's frame rather than of the column**, and that is the layout decision: a column
	 * child would be a fourth row the `UIListLayout` positions, so a word that appears and disappears would
	 * shift the icon and the stamina lights on every arm and every spend. Anchored to the slot's own top edge
	 * it rides with the stack, inherits the column's `Visible`, and moves nothing.
	 */
	private addReadyLabel(
		scope: Fusion.Scope<unknown>,
		theme: HudTheme,
		slot: Frame,
		ready: Fusion.Value<boolean>,
	): void {
		const label = Fusion.New(scope, "TextLabel")({
			Name: "Ready",
			Parent: slot,
			// Bottom edge at the slot's top edge, less the gap; centred horizontally. Relative in x and an
			// offset in y, so neither number is derived from the slot's size — the frame is `ICON_SIZE` square
			// and this sits `READY_GAP` above it.
			AnchorPoint: new Vector2(0.5, 1),
			Position: new UDim2(0.5, 0, 0, -READY_GAP),
			Size: UDim2.fromOffset(READY_WIDTH, READY_HEIGHT),
			BackgroundTransparency: 1,
			Font: UI_FONT,
			Text: READY_TEXT,
			TextColor3: theme.colors.onAccent,
			TextScaled: true,
			TextXAlignment: Enum.TextXAlignment.Center,
			TextYAlignment: Enum.TextYAlignment.Center,
			// **The one reactive property in this method**, bound to the loop's `Value` rather than to the
			// attribute directly: `mount`'s loop is the only reader of the player's attributes in this file,
			// and a second subscription here would be a second reader of one fact.
			Visible: ready,
		});

		const stroke = new Instance("UIStroke");
		stroke.Name = "Outline";
		stroke.ApplyStrokeMode = Enum.ApplyStrokeMode.Contextual;
		stroke.Color = theme.colors.trough;
		stroke.Thickness = READY_STROKE_THICKNESS;
		stroke.Parent = label;
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
				// **The colour rule carried over from the cooldown bar this row replaces.** Still filling is the
				// busy tone and ready is the success tone, and the switch is on the reading rather than on an event,
				// so the two can never disagree about which side of ready we are on: a pool at full is success,
				// anything being spent is warning. That is the project's one rule for a fill/ready readout rather
				// than a third colour for a third kind of bar.
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
 * **A count of segments rather than a fraction of the whole pool.** The arithmetic is one division either way;
 * what this returns is a unit, because the readout is segmented rather than continuous. A *level* and not a
 * clock subtraction: `STAMINA_ATTRIBUTE` publishes the pool itself, so nothing here reads a clock and nothing
 * here can drift from one.
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
