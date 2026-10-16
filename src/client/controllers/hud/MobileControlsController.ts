import { Controller, OnStart } from "@flamework/core";
import { Text } from "@rbxts/big-ui";
import Fusion from "@rbxts/fusion-3.0";
import { Players, RunService, Workspace } from "@rbxts/services";
import { isMobile } from "../../platform";
import { HudTheme, hudTheme } from "../../ui/hudTheme";
import { getScreenSpaceGui } from "../../ui/screenGui";
import { ActionController } from "../input/ActionController";
import { CatchController } from "../input/CatchController";
import { DodgeController } from "../input/DodgeController";
import { SprintController } from "../input/SprintController";
import { ThrowController } from "../input/ThrowController";

/** Prints the mount line, every press and every release, and the stick's own resolution. */
const DEBUG = true;

/**
 * **Whether the paw can be dragged around the screen by hand — on, so the layout can be found rather than
 * guessed.** **Placeholder — a dev tool: set it to `false` to play, and the block it guards is deletable.**
 *
 * **Why it exists.** Where the toes sit is *derived*: the arc's radius comes from the toes' own size, the bearings
 * from the radius, and the whole shape from the engine's button. So every attempt to move the cluster is
 * arithmetic in this file and a rebuild, and nobody can feel where it should sit from a screenshot — including
 * whoever wrote it, twice. **This flag turns the five toes into handles**: press one and drag, and the whole paw
 * follows the finger. Nothing about the *shape* changes — still one curve at one radius, still {@link TOE_GAP}
 * apart — so what this finds is the paw's **position**, which is the one part of it with no arithmetic behind it.
 *
 * **While it is on the toes do not act.** A press is a grab and no control fires — deliberately, because the
 * alternative is guessing whether a gesture is a tap or a drag, and a wrong guess throws the ball across the arena
 * while somebody is trying to move a button. **Off is the game**: the five are buttons again and a drag does
 * nothing at all.
 *
 * **The answer comes out in the output**, in reference pixels, on the frame the finger is lifted:
 *
 * ```
 * [HUD] arrange — (37, -54)px from the pad's centre = (37.0, -54.0) reference px on a 393x852 viewport
 * ```
 *
 * Paste that pair into {@link PAW_OFFSET} and set this to `false`: that is the whole loop, one round trip instead
 * of five.
 */
const ARRANGE = true;

/**
 * One toe's size, in pixels. **Placeholder — 52, up from 44.**
 *
 * **A thumb, not a mouse, and the thumb sets the floor.** The legend's chips are measured against a pointer that
 * is one pixel wide; this is measured against a fingertip, which is roughly twenty pixels across and needs a
 * target several times that to be hit without looking. `44` was that guideline floor and it was chosen *because
 * it had to be* — see below. `52` is the size the shape actually wants, and it is still comfortably above the
 * floor.
 *
 * **Why it was 44, and why that reason is gone.** The toes must be smaller than the pad, because that is what
 * makes this a paw rather than five buttons near a sixth: the reference this is drawn from has toes at roughly
 * two thirds of its pad. The previous pass believed the pad was ~54px, an estimate read off a landscape
 * screenshot; 44 against 54 was already nearly a match, so the toes went to the smallest size a thumb is allowed
 * and the whole shape was built there. **The log settled it: the same code draws that button at 120px on one
 * device and 70px on another** — the ControlModule scales its own touch controls to the viewport, so the pad's
 * size is a property of the phone rather than a constant. **Shrinking the pad is what lets the toes grow**: 52
 * against a 72px pad is 72%, which is the reference's proportion, where 52 against a 120px pad would have been
 * five buttons beside a beach ball. See {@link PAD_SIZE} for the shrink and for why it is derived rather than a
 * fixed scale.
 *
 * **The height of the circle is also the width of the cell**, because `UICorner` at `UDim(1, 0)` makes it a
 * circle rather than a rounded square: one number, two axes, and no way for the two to disagree.
 */
const BUTTON_SIZE = 72;

/**
 * The throw's size, in pixels, and **the one toe in the paw that is not the same size as the others.**
 * **Placeholder — 60, up from 52.**
 *
 * **The primary action is bigger, and that is the whole of the design.** The throw is what a round is played
 * with, it is the one control a player holds for a length of time, and it is the one whose *timing* matters —
 * so it gets a target that a thumb finds without looking, and the four one-tap toes around it are sized to be
 * pressed rather than to be hunted. The size difference is also the only hierarchy this cluster has: there is no
 * colour that says "this one matters", because colour is saying which buttons are *down*.
 *
 * **Why it moved with the toes, and by the same step.** It went to `52` only because the toes had gone to `44`
 * against a pad nobody had measured — the whole cluster was at the smallest sizes the shape would allow. With the
 * pad measured and shrunk (see {@link PAD_SIZE}) the pair move together: `52` toes and a `60` throw. **`60` is
 * still below the pad**, which is the constraint that decides it: the thing a thumb rests on should be the largest
 * target in the cluster, and the throw is the largest of the ones that are *pressed*. It is also what keeps the
 * arc short — every extra pixel of the throw's diameter widens the two steps either side of it, and those are the
 * widest steps in the arc. See {@link ARC_WINDOW}.
 */
const THROW_SIZE = 78;

/**
 * How much of the circle an icon gets, as a fraction of its diameter. **Placeholder.**
 *
 * **Reserved, not filled.** No icon is loaded here — the art is coming later — so every button today is an empty
 * circle with a word under it, and this is the box the picture will go in when it exists: centred, square, and
 * six tenths of the button across, which leaves a ring of the button's own colour visible all the way round.
 * That ring is what makes the icon read as *sitting in* something rather than as floating on the screen, and it
 * is the reason the reservation is smaller than the circle rather than the circle itself.
 *
 * **The day the art arrives, this file changes in one place**: `buildCell` puts an id onto the `ImageLabel`
 * it already builds, and nothing about the sizes or the layout moves.
 */
const ICON_RATIO = 0.6;

/**
 * The size the engine's jump button is shrunk to, in pixels. **Placeholder — 72.**
 *
 * **The pad is the engine's, at whatever size the engine drew it, and this is the one number that disagrees with
 * it.** The button arrives at **120px** on the device in the first log and **70px** on the device in the second:
 * the ControlModule scales its own touch controls to the viewport, so the pad's size is a property of the phone
 * rather than a constant, and every estimate made about it from a screenshot has been wrong. `72` is the size
 * this paw is designed around — the toes are 52 and the throw 60, so a 72px pad keeps the pad the largest target
 * in the cluster and puts the toes at the reference's two-thirds proportion.
 *
 * **It is applied as a `UIScale`, and the scale is *derived* rather than fixed.** A constant scale — the `0.6`
 * this task started from — renders 72px on the 120px device and **42px on the 70px one**, where the toes would be
 * bigger than the pad they curl around. So the scale is `min(1, PAD_SIZE ÷ the engine's own size)`: the pad comes
 * down to 72 wherever it is bigger than that, and is left exactly as the engine drew it wherever it is not.
 * **Shrink, never enlarge** — that button was sized for a thumb on *that* device, and a few pixels is not worth
 * arguing with it about.
 *
 * **`UIScale` and not a `Size` write, which is the other half of why this is safe.** The reference states it
 * plainly: *"A `UIScale` object simply contains a number that is used to multiply the `AbsoluteSize` of the parent
 * UI element"*, and its `Scale` example turns `{0, 200}` into `{0, 100}` at `0.5`. **So `AbsoluteSize` reports the
 * shrunk size**, and every number in {@link mount} — the pad's radius, its centre, the toes' floor — follows the
 * visual pad with no arithmetic of ours and nothing to keep in step. **And it is the one property of that button
 * the engine's module has never been seen to write**: the module sets `Size` and `Position` on every viewport
 * change (that is exactly what the per-device differences in those two logs *are*), while the discovery probe
 * reads `0 child(ren)` on a fresh button, so it ships no `UIScale` of its own to collide with. See
 * {@link restyleEngineJump}, which is where it is added.
 */
const PAD_SIZE = 72;

/**
 * The gap between two adjacent toes, in pixels. **Placeholder — 5, and it replaces a 20.**
 *
 * **The whole of this task is in this number.** The cluster's job is to read as *one object* rather than as five
 * circles that happen to be near each other, and the reference this shape is drawn from has its toes almost in
 * contact — a few pixels at most. `5` is the middle of the range asked for (4–6) and deliberately at the *tight*
 * end of it: a gap a little too small reads as a deliberate paw with touching toes, and a gap a little too big
 * reads as the scatter this replaces. It is the number to move first if the buttons look crowded on a device.
 *
 * **Why 20 was right before and is wrong now — the argument reversed rather than retuned.** The previous pass set
 * this to `20` because it was doing two jobs: it was the gap between the buttons *and* the space a label hangs in.
 * A cell is a circle plus a `LABEL_GAP` plus a `caption` line, and on a ring centred on the pad the upper toes'
 * words point straight *back at the pad*, so a gap smaller than a label printed those words on top of the engine's
 * own disc. **That is still true, and it is why this number no longer solves it.** The paw derives its radius from
 * the toes' own size ({@link ARC_WINDOW}), which is far enough out that every label sits in open air between the
 * pad and the arc. The label's height has moved out of *this* constant and into the radius, and what is left here
 * is the one job the word "gap" describes: how close two toes are.
 */
const TOE_GAP = 10;

/**
 * **How far the whole paw sits from the pad's centre, in reference pixels.** **Placeholder — `(0, 0)`.**
 *
 * **It exists because the paw otherwise has no position of its own.** The toes are placed *around the engine's
 * button* — which is what makes them a paw rather than a floating row — so where they land is the pad's centre
 * plus a bearing and a radius, and there was no way to say "a little up and to the left of that". This is that
 * way: one vector, added after the multiplier, so it scales with the buttons like every other reference number in
 * this file.
 *
 * **It is also what {@link ARRANGE} writes its answer into**, and it is the only number in the shape that is not
 * derived from anything — because where a paw should sit on a phone screen is a judgement about a thumb rather
 * than a measurement of one. See {@link mount} for where it lands in the placement.
 */
const PAW_OFFSET = new Vector2(0, 0);

/**
 * Where the paw's lowest toe points, in degrees off the pad's centre. **Placeholder — 177.**
 *
 * **The convention, stated once because two of them are in play**: these are `math.cos`/`math.sin` bearings on a
 * screen, so `0` is to the *right* of the pad, `90` is *below* it and `270` is *above* it — a screen's `+Y`
 * points down. **The `135°` in the brief is the same direction in the other convention** — the up-and-left
 * diagonal, measured anticlockwise from east in a maths frame — and it is `225` here.
 *
 * **Why `177` rather than `225`: the arc is not centred on the diagonal, it *spans* it.** The pad sits in the
 * corner of the screen, so the arc's two ends are the two places it can run out of room — the lowest toe's
 * *label* is the lowest thing in the cluster, and the highest toe's disc is the rightmost. **The tighter of the
 * two logged devices is what sets it**: that pad's top-left is `{1, -95}, {1, -90}` at 70px, so its centre is 60px
 * from the right edge and 55px from the bottom. At `177` the lowest toe (`Drop`, 177°) hangs its word 52.6px
 * below that centre, which is 2.4px inside the bottom edge, and the highest (`Curve`, 285°) reaches 59.2px to the
 * right of it, which is 0.8px inside the right edge. **Both are inside, and those two margins are the numbers to
 * spend if a device ever disagrees**: the arc is about 108° long (see {@link ARC_WINDOW} and the step derivation
 * in {@link mount}), and moving this bearing *up* trades the bottom margin for the right one — so `176.5` is the
 * balanced value if a run clips at the top instead.
 *
 * **It is the one fixed number in the shape while everything else is derived, and that is deliberate.** The
 * radius, the steps and the toes' sizes all come from measurements the client takes at runtime; this cannot,
 * because it encodes *where a phone is allowed to put the pad* — a fact this project has two data points for and
 * no formula. `177` is chosen so the measured geometry lands inside both edges on the tighter of those two, and
 * the mount line prints the bearings it produces, so a run that disagrees says so in one number.
 */
const ARC_START_BEARING = 177;

/**
 * **How many degrees of arc a phone actually has in that corner — the constant the radius is derived from.**
 * **Placeholder — 112.**
 *
 * **What it is: a budget, not a measurement.** Five toes have to lie on one curve around the pad, and the curve
 * has to fit the wedge of screen between the bottom edge and the right edge — the pad is in the corner, so those
 * two edges are what the arc runs into. `112` is the angular room in that wedge at the radius the toes end up at,
 * and **everything else follows from it**:
 *
 * - the *radius* is the smallest one at which the widest neighbouring pair — the throw and a toe — spans
 *   `ARC_WINDOW / 4` degrees, so five toes fit the wedge with the widest pair paid for;
 * - the *bearings* are then each pair's own chord at that radius, so the small toes sit slightly closer together
 *   than the throw's neighbours do and every gap comes out as {@link TOE_GAP}.
 *
 * **And this is the constant that says "hug the pad" cannot be combined with "toes touching", in one line of
 * arithmetic.** A radius of "the jump button plus a small gap" is `36 + 26 + 5 = 67` pixels against the 72px pad
 * of {@link PAD_SIZE} and a 52px toe. At *that* radius, one step between neighbouring toes is
 * `2·asin(57/134) ≈ 50°`, so five toes span about **200°** — more than half a circle, which is more than a screen
 * corner has and more than the joystick hand's side of the screen can give up. **The toes cannot both hug the pad
 * and touch each other**, and this constant chooses the touching, because that is the shape being asked for and
 * the whole of what was wrong with the scatter it replaces. The cost is that the toes sit on a ~126px arc rather
 * than a 67px one, which is a longer thumb reach — reported as a deviation rather than hidden.
 *
 * **The numbers in the paragraph above are the pad's and the toes', so they move when those move.** They were
 * `216°` and `100px` while the pad was believed to be 54px and the toes were 44. The arithmetic is one line either
 * way; what changed is the *pad*, because a smaller pad is what lets the toes grow without the arc running off the
 * screen. See {@link BUTTON_SIZE} and {@link PAD_SIZE}.
 *
 * **It is also where the old outer boundary went.** The previous pass had no equivalent: its ring wrapped the pad
 * at a radius of `pad + toe + 20 ≈ 83`, which is *inside* what five touching toes need, which is exactly why its
 * fifth slot had to be placed below the pad and off the bottom of the screen.
 */
const ARC_WINDOW = 170;

/**
 * The jump button's word. **`Jump` rather than a symbol**, because this HUD's rule is that a button says what
 * it does and there is no icon for it yet — the same reason every other word here is one.
 *
 * **Drawn inside the engine's button rather than in this controller's own tree**, which is the whole of what the
 * restyle does with it: a label is a *child* of the button, so it follows the button wherever the engine puts
 * it and survives every re-layout the module does. See {@link restyleEngineJump}.
 */
const JUMP_LABEL = "Jump";

/**
 * The viewport this HUD's numbers were drawn against: **393 × 852, portrait — the short axis being 393.**
 *
 * Every size in this file is written in *reference* pixels and every toe is multiplied by one `UIScale` derived
 * from this — see {@link buildScale}. This pair of numbers is what decides how big a button is on somebody else's
 * phone; nothing else in the file knows the screen exists. **The arc's radius is the one number that is not in this
 * language** and it says so: one term of it is half the engine's own button, which is not scaled, and the other is
 * reference pixels times the scale.
 *
 * **Both axes, and the second one is not decoration.** The obvious version measures the *short* axis alone, on
 * the argument that it reads 393 in portrait and 393 in landscape and therefore gives one phone one answer.
 * That is true and it is not sufficient: **the paw is about 210 reference pixels across** — a ~126px arc plus the
 * toes at either end — and a phone held sideways has a viewport 393 tall, so a multiplier of 1 leaves the far toe
 * over the top edge and the pad's own corner crowded. Fitting *both* axes against the reference viewport is the
 * same rule with the height added, and it is what makes "393 × 852 portrait as the primary target, in scale, so
 * it works in landscape too" true rather than hopeful.
 */
const REFERENCE_VIEWPORT = new Vector2(393, 852);

/**
 * How far that scale is allowed to go, either way.
 *
 * **A clamp rather than arithmetic that happens to be bounded.** The scale is the largest fraction of
 * {@link REFERENCE_VIEWPORT} the viewport can hold — `1` on the reference phone, `0.9` on a slightly smaller
 * one, about `1.2` on a tablet — and the caps do the two ends of that: a portrait tablet's short axis is 768
 * and would otherwise scale the toes to twice their size, turning five thumb targets into five dinner plates,
 * while a very short viewport (a phone held sideways, where the fit above is about `0.46`) would shrink them to
 * buttons nobody can hit. **A slightly-too-large button on a small screen is the better failure**, which is what
 * the floor is choosing — and it is the *floor* that matters most here, because a phone held sideways is the case
 * a player is most likely to be in.
 */
const SCALE_MIN = 0.85;
const SCALE_MAX = 1.15;

/**
 * **That scale, as a function of the viewport** — pulled out of {@link buildScale} the day something else needed
 * the same figure, which is the arrange hook: a drag arrives in *screen* pixels and {@link PAW_OFFSET} is written
 * in reference ones, so the hook has to divide by exactly the number the cluster is multiplied by. **Two copies
 * of this expression would be two answers to one question**, and the one that went stale would be the one nobody
 * was looking at.
 */
function scaleFor(viewport: Vector2): number {
	return math.clamp(
		math.min(viewport.X / REFERENCE_VIEWPORT.X, viewport.Y / REFERENCE_VIEWPORT.Y),
		SCALE_MIN,
		SCALE_MAX,
	);
}

/**
 * How far the movement stick has to be pushed to start and to stop sprinting. **Placeholder.**
 *
 * **Two numbers rather than one, and that is the whole of the design.** A single threshold is a line the stick
 * sits *on* when a thumb holds it there: the engine's thumbstick jitters by a little at rest and by more under a
 * thumb, so one `>= 0.85` test would start and stop the sprint several times a second while the player is doing
 * one thing — and every flip is a `setSprinting` request to the server, which is the expensive half. **The gap
 * between the two is the hysteresis**: it takes a deliberate push to start and a deliberate easing-off to stop,
 * and the `0.15` between them is the room the thumb's own noise lives in.
 *
 * **Where the numbers come from: a thumbstick's own range.** The magnitude is `0` at rest and about `1` at the
 * rim, so `0.85` reads as "pushed nearly all the way" and `0.7` as "eased off, but not back to a walk" — which is
 * what sprinting should feel like on a phone: not a mode the player switches, but what happens when they push the
 * stick to the edge. Both are guesses to be moved once a real thumb has been on them; see {@link watchStick} for
 * the loop that reads them, and for the honest statement of what cannot be known about the number until it does.
 */
const SPRINT_START_MAGNITUDE = 0.85;
const SPRINT_STOP_MAGNITUDE = 0.7;

/**
 * How long {@link findStick} waits for the engine's own control module before giving up on the sprint, in seconds.
 *
 * **Not a tuning value, which is why it is not marked as one.** It is the patience of a lookup, and the only thing
 * it affects is how long this controller holds a task open at mount. Ten seconds is generous for something the
 * engine's own scripts create during boot — the point is that the wait *ends*, and that a client whose module
 * never arrives gets one log line and no sprint rather than a task that lives as long as the session does.
 */
const STICK_WAIT_SECONDS = 10;

/** The gap between a button and the word under it. */
const LABEL_GAP = 4;

/**
 * The two states of a button, and **the only thing on this HUD that changes**.
 *
 * **Idle: the theme's dark, at `0.6`.** `trough` is the theme's near-black — the same colour a tile's name bar
 * and a progress well are made of — so an idle button is the one dark object in a corner of a light HUD, which
 * is what makes it read as a control rather than as a card. At `0.6` the game is visible through it, which is
 * the point: a control over the world should not black it out.
 *
 * **Down: the theme's accent, at `0`.** `accent` is the theme's own name for "the thing to press" (its doc
 * lists keys first) and it is the colour the legend's key chips and the tabs' selection already use, so a held
 * button is the same statement in the same vocabulary. Fully opaque, because this is the state that has to be
 * unmistakable at a glance — and because the two states need to differ in more than one property to read as two
 * states rather than as one colour that moved.
 *
 * **What this is not: a light/dark pair of the same colour.** The alternative was `panel` for the down state —
 * the paper colour, which is "light" in the most literal sense — and it was refused because a near-white circle
 * on a light, bright arena is the *quieter* of the two: the idle state would shout and the pressed state would
 * whisper. The accent is the more contrasty of the pair against both the trough and the world.
 */
const IDLE_TRANSPARENCY = 0.6;
const HELD_TRANSPARENCY = 0;

/**
 * One button: what it says, how big it is, and what it does.
 *
 * **The cluster is a table of these, which is what makes the arrangement one edit.** Nothing in the layout code
 * knows what a catch is or that a throw is held — it places circles and words — so moving a control to a different
 * place on the arc, adding one, or changing a size is a change to the table rather than to any of the drawing.
 *
 * **`size` rather than a `primary` flag.** The hierarchy on this HUD is exactly one thing — how big the circle
 * is — and there are two values of it, so a boolean would have had to be read as "which of the sizes", which is a
 * number wearing a costume. A number says what it means, and the constant it is written as says why.
 *
 * **`up` being optional is the whole difference between a tap and a hold**, and **the throw is the last one
 * standing**: the sprint was the other, and a sprint is no longer a button on this HUD at all — it is the
 * movement stick's own magnitude, which is a thing the player's other thumb is already on. Nothing here decides
 * which control is which — the controller behind the button does, and what this table records is only whether
 * there is a second call to make.
 */
interface TouchControl {
	/** The word under the button, which on this HUD is the whole of the legend. */
	readonly label: string;

	/** The circle's diameter, in reference pixels. See {@link REFERENCE_VIEWPORT} for what that means. */
	readonly size: number;

	/** What the press does. Called once per press, and never twice without a release between them. */
	readonly down: () => void;

	/** What the release does, for the control that is held rather than tapped. */
	readonly up?: () => void;
}

/**
 * **What arrange mode asks a toe for: two calls, and no knowledge of what a drag *is*.** See {@link ARRANGE}.
 *
 * **A hook rather than the flag read inside `buildCell`**, so a cell stays what it has always been — a circle, a
 * word and a press — and the only thing that knows about moving the paw is the method that places it. When
 * arrange mode is off the hook is `undefined` and every line of it is dead: the buttons behave exactly as they did
 * before this existed.
 *
 * **Declared as function-typed *properties* rather than as methods**, which is this codebase's own trap recorded
 * twice: roblox-ts refuses an arrow function where an interface declares a method, and compiles a method call to a
 * colon call — right for the engine's Lua tables, wrong for a table this file builds itself.
 */
interface ArrangeHook {
	/** The finger moved this far since the last report, in screen pixels. */
	move: (delta: Vector2) => void;

	/** The finger came off, which is when the numbers are worth printing. */
	done: () => void;
}

/**
 * Where the engine's jump button is and how big it is — **three readings off somebody else's instance, kept live.**
 *
 * **Everything the paw is positioned from comes from here**, which is why it is a record rather than the single
 * number this file's first column asked for: an arc needs a *centre* to be drawn around and the radius needs a
 * *size* to start from, where a column standing above a button wanted only its top edge. That is the same change
 * every rework since has shared: the cluster used to be placed against one edge of an object and has been placed
 * around all of it since.
 *
 * **Values rather than numbers, because the engine moves this button.** A rotation or a viewport change re-lays
 * out the engine's own touch GUI, and both readings are re-taken from the signals the restyle already watches — so
 * the toes follow the pad rather than being right at mount and wrong after the first rotation.
 *
 * **`size` is one number and not a `Vector2`**, deliberately: the pad's clearance is what the radius has to clear,
 * and the clearance from a rectangle is its larger axis. See `measure` for the `math.max` and for why a button
 * wider than it is tall must not have the toes drawn *inside* it on the short axis.
 *
 * **`found` is separate from the other two rather than a nil centre**, so that the paw can be built once and stay
 * invisible until there is something for it to wrap. See {@link mount}: the engine creates this button about a
 * second and a half after the client ignites, and a paw placed at `(0, 0)` is the top-left corner of the screen.
 */
interface JumpGeometry {
	/** The button's centre, in screen pixels from the top-left of the screen. */
	readonly centre: Fusion.Value<Vector2>;

	/**
	 * The button's larger axis **as it is rendered after the shrink** — see {@link PAD_SIZE} — in screen pixels:
	 * the radius the toes have to clear.
	 */
	readonly size: Fusion.Value<number>;

	/** Whether the button has been found at all. `false` until the engine's touch GUI exists. */
	readonly found: Fusion.Value<boolean>;
}

/**
 * The `PlayerModule`'s shape, **as far as this file uses it: one method.**
 *
 * **Written as a method rather than as a property holding a function, and that is load-bearing rather than
 * stylistic.** The module is Lua: its `GetControls` is a function whose first parameter is `self`, and roblox-ts
 * compiles a *method* call on a table to a colon call — `playerModule:GetControls()` — which passes that `self`,
 * where calling a function-typed property would hand it over without one. **This file's own notes record the
 * refusal from the other side** (an arrow function is rejected where an interface declares a method), which is the
 * same distinction caught by the compiler instead of at runtime.
 *
 * **Nothing here is verified by the compiler, and that is the honest description of it.** `GetControls`,
 * `GetMoveVector` and even `PlayerScripts` appear nowhere in `@rbxts/types` in this build — the same absence
 * `restyleEngineJump`'s doc lists for the jump button's route — so this interface is a claim about somebody else's
 * table that only a running client can confirm. See {@link findStick}, which guards every step of it by hand and
 * reports what it found.
 */
interface PlayerModuleShape {
	GetControls(): unknown;
}

/**
 * The control object `GetControls` returns, **as far as this file uses it: one method, and again a method.**
 *
 * **`GetMoveVector` is the supported way to ask where a thumbstick is pointing** and it is the reason the sprint
 * could become the stick's own magnitude at all: it returns a `Vector3` whose magnitude is how far the stick is
 * pushed, which is exactly the number a sprint threshold wants.
 *
 * **The declared return type is a claim, not a fact this project can check** — a Lua function family could return
 * `nil`, a table or a number, and the typings here are the *belief* being tested. What makes it safe to write down
 * is `.Magnitude` being the *last* thing done with the value, in {@link watchStick}: if the call returns something
 * without a magnitude, that is an error inside a `ViewportSize`-independent loop, and the log line printed at
 * resolution is what a session's output pins the blame to.
 */
interface MoveControls {
	GetMoveVector(): Vector3;
}

/**
 * The mobile controls: **a bear paw — five toes curled around the engine's jump button, on its upper-left.**
 *
 * **The paw is the fourth arrangement, and each one taught the next something.** The first was a column standing
 * above a jump button of our own; the second kept the column and stood it above the engine's button, which put the
 * cluster in the *top*-right corner and cut it in half — because `AbsolutePosition.Y` measures from the top of the
 * screen and it was being spent as a margin from the bottom, so a button a thumb's width off the floor lifted the
 * column a full screen height the other way. **A margin measured from one edge and spent against another is
 * exactly the mistake a corner anchor invites**, and the third arrangement answered it by dropping the anchor
 * altogether: buttons placed at a distance and a bearing from the *button*, so there is no screen edge anywhere in
 * the arithmetic.
 *
 * **The third was a ring, and the paw exists because a ring does not fit — which the third arrangement's own
 * report said, and this is the fix.** Five slots spread evenly around the pad need the *whole* circle, and the pad
 * is in the corner of the screen: the slot at `90` — directly below the pad — lands below the bottom edge of any
 * phone, and in portrait the one at `0` runs off the right edge too. **A ring asks for 360° of room in a corner
 * that has about a quarter of that**, and no radius fixes it: a radius big enough to keep the toes off the pad is
 * a radius that puts the rest of the circle *further* off the screen rather than nearer. So this pass keeps the
 * third arrangement's answer — bearings and a radius, no screen edges — and changes the *shape*: one arc across
 * the wedge of screen the corner actually has, spanning the diagonal instead of circling it. See {@link mount}
 * for the arc and {@link ARC_WINDOW} for the arithmetic that fixes its length.
 *
 * **Why a paw rather than three rows, in the terms a phone player would use.** A thumb on the pad does not have to
 * hunt: every toe is the same short move away, in the direction the thumb falls when it rolls off the button, and
 * the labels point into open space rather than being read one at a time. **And the cluster stops being five
 * approximations of a layout and becomes one shape** — the toes nearly touch ({@link TOE_GAP}) and sit on one
 * curve, so the group reads as a single object with the pad inside it, which is the difference between this and
 * the scatter it replaces. That is the same reason the reference's toes are drawn almost in contact.
 *
 * **It exists because a key is not a control on a device that has no keyboard.** `ControlsLegendController` is a
 * reference card — every row on it names a key — and on a phone that card is a list of things a player cannot
 * do. This is the other answer to the same question: the control *is* the button, so the label under it is not
 * decoration but the whole of what the card used to say. **The two HUDs are alternatives and never both**: the
 * legend returns early where this mounts, and this returns early everywhere else. See `client/platform.ts` for
 * the one test they share.
 *
 * **Every button drives the controller its key drives, and none of them contains a rule.** The presses land on
 * `ThrowController.beginHold`/`endHold`, `CatchController.press`, `DodgeController.press`/`push` and
 * `ActionController.drop` — the same methods the `ContextActionService` callbacks call — so there is one
 * implementation of what a press means and this file is a second *way in* rather than a second version of
 * anything. **That is also why the controllers' methods were made public rather than the calls being written
 * here**: a copy of "a ball in the hand is what makes a press a throw" would be a rule with two homes, and the
 * server would be the one to notice.
 *
 * **The sprint is the exception, and it is the one control that is not a button.** It used to be one, wedged
 * into the middle of the ring's arrangement; it is now the movement stick's own magnitude — push the stick to
 * the rim and the character runs — which is what a phone game does and what this HUD was missing. Nothing about
 * *where* that decision lives has changed: it still ends at `SprintController.holdSprint`, the same method the
 * keyboard's shift key calls, so there is still one implementation and this file is still only a way in. What
 * moved is the sensor. See {@link watchStick} for the loop and {@link SPRINT_START_MAGNITUDE} for the two
 * thresholds it uses. **The stick is not this controller's instance and the call underneath it is not typed in
 * this build**, which is the one thing in this file that is a documented risk rather than a mechanism — it is
 * argued in full at {@link watchStick} rather than glossed here.
 *
 * **The jump is the odd one out, and it is the only control here the engine runs — including its button.**
 * There is no `JumpController` in this project and there never was: the jump has always been Roblox's, from the
 * space bar to the touch button in this corner. **There was a custom jump button here for two passes and it
 * never worked** — the press arrived, the body was healthy and grounded, and the write to `Humanoid.Jump` was
 * lost, because that flag belongs to the ControlModule and the module rewrites it from the input *it* is
 * holding. So the engine's button is back, kept, and **dressed** rather than replaced: found by name in
 * `PlayerGui.TouchGui.TouchControlFrame`, given this HUD's circle, colours, icon slot and word as *children* of
 * itself, and left to the module for its size, its place and its input. See {@link restyleEngineJump}. Desktop
 * and gamepad are untouched, because they never went through the touch GUI in the first place. **The aim is the
 * other half of the same story on this platform**, and it is not in this file: see
 * `ThrowController.getThrowDirection`, which takes the camera's axis where a desktop takes the cursor, because a
 * phone has no cursor for `ShiftLock` to pin there.
 *
 * **The buttons are circles, and the circle is a `UICorner` rather than an asset.** `UDim(1, 0)` rounds a square
 * into a disc at any size, costs nothing to load and survives a resize without resampling — the same
 * construction `panelChrome.addGlyph` uses for its decorative discs, and the reason no image is needed for the
 * shape of anything here. The engine's jump button is given the same corner as a child, which is what makes it
 * read as the pad of this paw rather than as somebody else's instance that happens to be nearby — and the toes are
 * drawn on an arc around it, so the family it belongs to is now literally arranged around it.
 *
 * **Every size here is in reference pixels and every button multiplies itself by one scale.** See
 * {@link buildScale}: 393-wide portrait is the phone the numbers were drawn against, and a rotation, a wider
 * phone or a tablet is the same layout at a different multiplier. **That is why this HUD does not carry an
 * `addViewportConstraint`** like every other one — the sizes here are a function of the viewport rather than
 * values that need clamping against it, and a pixel `UISizeConstraint` under a `UIScale` would be measuring the
 * size before the multiplier, which is a cap that fires at the wrong number or never. **The engine's button is
 * outside that scale**, and the reason is now a measured one rather than a rule: the pad is shrunk by a `UIScale`
 * of its own to {@link PAD_SIZE} (see {@link restyleEngineJump}), so its radius is already a *screen* number —
 * while the toes' are reference numbers that this multiplier turns into screen ones. That is why the arc's radius
 * is a *comparison of two different kinds of number* rather than a single product. See {@link mount} for that line.
 *
 * **What is deliberately not here.** No icons (the space is reserved inside each circle and the art is a later
 * change to one line), no power button (the ability HUD's slot is what asks for the power, and the throw that
 * follows is what spends it — see `SuperHudController`), no duck and no aim (neither has a mobile equivalent
 * that is a button), **no sprint button any more** — the stick is the sprint, and a sixth circle for it would be
 * a control the player's other thumb is already holding — and no change to any desktop control: the keys, the
 * binds and the legend are exactly as they were.
 *
 * **Mounted into `getScreenSpaceGui` rather than the shared HUD `ScreenGui`, and the paw is what forces it.**
 * Every other HUD here mounts into the shared GUI, which is inset inside Roblox's topbar so that its contents sit
 * in the safe area; the toes cannot, because their frame's position is the engine's button's `AbsolutePosition` — a
 * *screen* coordinate, measured from the top-left of the screen — and an inset GUI has a different origin. The aim
 * sight needed the same thing for the same kind of reason, and that GUI's own doc is where the argument is written;
 * see `ui/screenGui.ts`. The shared GUI is still what the rest of this project's furniture mounts into, so this is
 * a second home for the one element that cannot live in the first rather than a departure from it.
 */
@Controller()
export class MobileControlsController implements OnStart {
	/**
	 * **The five controllers this HUD drives, injected rather than reached for.**
	 *
	 * This is the project's own mechanism — `HANDOFF.md`: *"constructor injection everywhere"*, which is how
	 * `DodgeService`, `BallSpawnerService` and every other service that needs a sibling gets one — and it is
	 * used here for the reason it is used there: a button that had to *find* its controller would be a lookup
	 * with a nil case, and the nil case is a press that silently does nothing. **A constructor parameter cannot
	 * be nil**, so "the paw is wired to the inputs" is a fact the compiler checks rather than a hope.
	 *
	 * **`sprintController` is the one that is not a button's.** Its two callers here are the stick's start and
	 * stop — see {@link watchStick} — and it stays injected for the same reason as the rest: one implementation
	 * of what "sprinting" means, reached from a second sensor rather than duplicated.
	 *
	 * **It is the first use of constructor injection on the client**, which is worth saying because the client
	 * has never needed it before: every other HUD here reads an attribute or subscribes to an event, and this is
	 * the first one whose whole job is to *call* controllers that are not its own.
	 */
	constructor(
		private readonly throwController: ThrowController,
		private readonly catchController: CatchController,
		private readonly dodgeController: DodgeController,
		private readonly sprintController: SprintController,
		private readonly actionController: ActionController,
	) {}

	public onStart(): void {
		// Spawned rather than done inline, matching every other HUD: mounting waits for `PlayerGui`, and a
		// controller's `onStart` is the wrong place to hold up the client's boot.
		task.spawn(() => this.mount());
	}

	private mount(): void {
		// **The cluster is a thumb's, so a machine with a keyboard does not get it.** `ControlsLegendController`
		// is the surface for that machine — see `client/platform.ts` for the read and for why a device with both
		// a touchscreen and a keyboard counts as a keyboard. Both controllers ask the same question and exactly
		// one of them answers yes.
		if (!isMobile()) {
			if (DEBUG) print("[HUD] mobile controls skipped — this device has a keyboard");

			return;
		}

		const scope = Fusion.scoped();

		// The HUD's colours, read now rather than at module load: `configureTheme` has run by the time anything
		// mounts, and a value captured earlier would be Material's default. **Every colour on this HUD comes from
		// here** — there is not one `Color3.fromRGB` in this file, which is the rule `hudTheme` exists to keep.
		const theme = hudTheme();

		// **The controls, each of which will be given a bearing on the arc.** That order is the arrangement — see
		// `paw` below — and this is only what each one says and does. The shape they make, with the engine's button
		// as the pad in the corner, is:
		//
		//                                  Curve
		//                            Dodge
		//                      Catch
		//                Throw
		//         Drop                  (jump)
		//
		// — a diagonal of toes rising from the pad's lower-left to its upper-right, with the pad sitting inside the
		// curve at the bottom-right. **The reference this is drawn from is the same picture with its pad in the
		// middle of the cluster rather than in a corner of the screen**, which is the difference that decides where
		// the arc can run: see {@link ARC_START_BEARING} for the two ends it has to stop at.
		//
		const curve: TouchControl = {
			label: "Curve",
			size: BUTTON_SIZE,
			down: () => this.throwController.toggleCurve(),
		};
		const throwBall: TouchControl = {
			label: "Throw",
			size: THROW_SIZE,
			// **The hold and the release, which is the same pair the mouse button produces.** `beginHold` answers
			// whether there was a ball to charge; the answer is dropped here rather than branched on, because a
			// press that threw nothing has to look exactly like any other press — the visual state of a button is
			// about the finger on it, not about what the game did with the press. See `buildCell`.
			down: () => this.throwController.beginHold(),
			up: () => this.throwController.endHold(),
		};
		const catchBall: TouchControl = {
			label: "Catch",
			size: BUTTON_SIZE,
			down: () => this.catchController.press(),
		};
		// **The dodge's direction is the stick's**, which is the one place this cluster makes a decision the
		// keyboard did not have to: there are no movement keys to read, so the body is asked where it is going.
		// See `DodgeController.push` for the read and for why a centred stick refuses rather than guesses.
		const dodge: TouchControl = { label: "Dodge", size: BUTTON_SIZE, down: () => this.dodgeController.push() };
		const drop: TouchControl = { label: "Drop", size: BUTTON_SIZE, down: () => this.actionController.drop() };

		// **The engine's jump button is restyled rather than replaced, and it is the pad the arc is drawn around.**
		// What comes back is the button's centre and its size in screen pixels — or nothing at all until it exists
		// — and every number below that places anything is derived from those two. See
		// {@link restyleEngineJump} for the hunt, the restyle and the reason the jump stopped being ours to draw.
		const jump = this.restyleEngineJump(scope, theme);

		// **The one responsive number on this HUD**, applied per cell rather than to the cluster as a whole: every
		// circle here is written in reference pixels and this multiplies it. See {@link buildScale}.
		const scale = this.buildScale(scope);

		/**
		 * **The arrangement: the paw, ordered from the pad outward.**
		 *
		 * The order *is* the layout — each entry is placed one chord further along the arc than the entry before it
		 * — so this list is where the shape is decided and `bearings` below is only the arithmetic for it. **The
		 * order is the brief's with one forced move**: `Drop` is the lowest toe rather than a fifth button tucked
		 * *between* `Throw` and the pad. It cannot go there, and the reason is arithmetic rather than preference:
		 * a circle tucked into that pocket sits where the arc's own air is only {@link TOE_GAP} wide, and the
		 * alternative radius that would open the pocket up puts its label below the bottom edge of the screen. **So
		 * the choice was the near end of the arc or the far end**, and the near end is what the reference's picture
		 * shows: its smallest button is the bottom-left end of the diagonal, below every other toe, with the pad to
		 * its right.
		 *
		 * **`Throw` is therefore the *second* toe rather than the nearest, and that is the one thing in the brief
		 * this file could not satisfy.** The brief asks for the throw to be closest to the pad because it is the
		 * primary action; here `Drop` is closest, one chord (~61px at the current sizes) further from the thumb for
		 * the throw. Swapping the first two entries of this list is the whole of the fix if the reach matters more
		 * than the shape's lower end being the least-used control — which is what this order chooses, since `Drop`
		 * is the rarest action in the cluster and `Throw` is still within a thumb's roll of the pad.
		 */
		const paw: TouchControl[] = [drop, throwBall, catchBall, dodge, curve];

		/**
		 * **The bearings, derived from the sizes rather than written down** — {@link ARC_START_BEARING} for the
		 * first toe, then one step per neighbouring pair, where a step is the angle that pair's two discs subtend
		 * at the radius the arc will actually use.
		 *
		 * **The arithmetic contains no radius, and that is the point of it.** A step is `2·asin(chord / 2r)`, and
		 * `r` is chosen so that the *widest* pair — the throw and one toe — spans exactly {@link ARC_WINDOW}
		 * divided by the number of steps. Substituting that radius cancels it out: what is left is each pair's chord
		 * as a fraction of the widest one's, times the widest one's half-angle. So **every gap in the paw comes out
		 * as {@link TOE_GAP} whatever the toes are sized at**, and the bearings depend on nothing read at runtime —
		 * not the scale, not the engine's button, not the screen. **A uniform step was the alternative and is
		 * worse**: at the radius five touching toes need, an even step leaves **9px** between two small toes while
		 * the throw's neighbours get the 5px asked for, so the four small toes would look loosely packed beside it.
		 */
		const widestChord = (THROW_SIZE + BUTTON_SIZE) / 2 + TOE_GAP;
		const stepUnit = ARC_WINDOW / (2 * (paw.size() - 1));

		/**
		 * **The radius the bearings are derived at, in reference pixels** — the smallest one at which the widest
		 * pair spans `stepUnit`, which is the arc-length term of the radius below with the scale taken out of it.
		 * **Kept as a named number rather than written twice**: the mount line prints it, so a session's log says
		 * how far out the toes were actually placed, and it makes the relationship between the bearings and the
		 * radius legible in one place instead of two.
		 */
		const spacingRadius = widestChord / (2 * math.sin(math.rad(stepUnit)));
		const stepBetween = (first: number, second: number): number => {
			const chord = (first + second) / 2 + TOE_GAP;

			return 2 * math.deg(math.asin((chord * math.sin(math.rad(stepUnit))) / widestChord));
		};

		const bearings: number[] = [];
		let bearing = ARC_START_BEARING;
		for (let index = 0; index < paw.size(); index++) {
			bearings.push(bearing);

			// **`following` and not `next`**, which is a Lua global: roblox-ts refuses the name outright with "Cannot
			// use identifier reserved for compiler internal usage". The same family as `type`, `local` and `self`.
			const following = paw[index + 1];
			if (following !== undefined) bearing += stepBetween(paw[index].size, following.size);
		}

		/**
		 * **The arc's radius, in screen pixels, and the one line in this file where two kinds of number meet.**
		 *
		 * It is the larger of two requirements, and each is measured against a different thing:
		 *
		 * - **The pad's clearance**, `jumpSize / 2 + (THROW_SIZE / 2 + LABEL_GAP + lineHeight + TOE_GAP) * m`: the
		 *   pad's radius is a *screen* number and deliberately not multiplied by anything of ours, because the pad
		 *   is already rendered at {@link PAD_SIZE} by its own `UIScale` — multiplying it by this HUD's cluster
		 *   scale as well would shrink it twice — while our own radius and the room a label needs are reference
		 *   pixels times the scale, because being scaled is the whole point of them. **The label lives in this term
		 *   and no longer in {@link TOE_GAP}**: a cell is a circle plus a `LABEL_GAP` plus a `caption` line, the toe
		 *   above the pad hangs that word *straight down onto it*, and this is the term that keeps the word in open
		 *   air.
		 *
		 *   **`THROW_SIZE` and not `BUTTON_SIZE`, which is the opposite choice to the one the last pass made in the
		 *   same place** — and the reason is that these two terms are asking opposite questions. The old term was
		 *   "how far out do the *smallest* buttons have to be so they do not touch the pad", where the small ones
		 *   are the binding case; this one is "how much room does the toe nearest the pad need for its word", and
		 *   the nearest toe is the *biggest* one, because the throw's disc reaches 4px closer to the pad than the
		 *   others at the same radius. Sizing the clearance off the throw is therefore the conservative answer for
		 *   all five, where sizing it off the toes would let the throw's label graze the pad on the one phone where
		 *   this term wins.
		 * - **The arc's own length**, `spacingRadius * m`: the smallest radius at which five nearly touching toes
		 *   fit inside {@link ARC_WINDOW}. **In the ordinary case this is the term that wins**, which is what makes
		 *   the gap between two toes exactly {@link TOE_GAP}.
		 *
		 * **A `Computed` over both readings, so the radius is re-derived whenever either moves** — a rotation
		 * changes the scale and can change the pad's own size in the same frame, and a number captured at mount
		 * would be stale after the first one. It is also why this is not a constant with a comment explaining why it
		 * is 126: on a phone with an unusually large jump button — larger than {@link PAD_SIZE}, so the pad's own
		 * shrink is the term that binds — the first term takes over and the toes move out to keep their labels clear
		 * of it, which is the right direction for that to fail in.
		 */
		const radius = Fusion.Computed(scope, (use) => {
			const jumpSize = use(jump.size);
			const multiplier = use(scale);

			return math.max(
				jumpSize / 2 +
					(THROW_SIZE / 2 + LABEL_GAP + theme.typography.caption.lineHeight + TOE_GAP) * multiplier,
				spacingRadius * multiplier,
			);
		});

		/**
		 * **The drag's offset in screen pixels, and the hook that moves it** — see {@link ARRANGE}, which is
		 * `false` in play, at which point this is two objects that nothing ever writes.
		 *
		 * **A `Value` rather than a plain number**, because the frame's position below is a `Computed` and this is
		 * the one input to it that changes while the client runs for a reason that is not a viewport change. **A
		 * local mirror beside it**, because a Fusion `Value` in this version can be *written* but not read back —
		 * the file's own note — so the running total has to live somewhere the hook owns.
		 */
		const nudge = Fusion.Value(scope, Vector2.zero);
		let dragged = Vector2.zero;

		const arrange: ArrangeHook | undefined = ARRANGE
			? {
					move: (delta: Vector2) => {
						dragged = dragged.add(delta);
						nudge.set(dragged);
					},
					done: () => {
						const camera = Workspace.CurrentCamera;
						const viewport = camera !== undefined ? camera.ViewportSize : REFERENCE_VIEWPORT;
						const multiplier = scaleFor(viewport);

						// **The line the whole flag exists for**, and it prints the answer in the unit it has to be
						// pasted back in: {@link PAW_OFFSET} is written in *reference* pixels, a drag arrives in
						// *screen* pixels, and the ratio between them is the cluster's own scale — which is printed
						// too, because a run that says the paw is in the wrong place should say which multiplier it
						// was in the wrong place under.
						print(
							`[HUD] arrange — (${string.format("%.0f", dragged.X)}, ` +
								`${string.format("%.0f", dragged.Y)})px from the pad's centre = ` +
								`(${string.format("%.1f", dragged.X / multiplier)}, ` +
								`${string.format("%.1f", dragged.Y / multiplier)}) reference px ` +
								`on a ${viewport.X}x${viewport.Y} viewport at scale ` +
								`${string.format("%.2f", multiplier)}`,
						);
					},
				}
			: undefined;

		/**
		 * The paw's frame: **a frame with no size, pinned to the engine's jump button's centre, with the toes drawn
		 * around it.**
		 *
		 * **A zero-sized frame with `AnchorPoint (0.5, 0.5)` is a point**, and a point is exactly what this needs:
		 * every child below is positioned in offsets from it, so each number in the loop is a distance and a bearing
		 * from the button's centre, and none of them is a distance from a screen edge. **That is the fix the second
		 * arrangement needed, stated as a structure**: the one that broke was a frame anchored to a corner and
		 * placed from a measurement taken from the opposite corner, and this frame has no edge to be measured from
		 * at all. The *shape* drawn inside it has changed twice since; this part has not, which is why it survives.
		 *
		 * **The centre plus {@link PAW_OFFSET} plus the drag**, and that is the whole of where the paw is. The
		 * offset is the one part of the position that is a *choice* rather than a measurement — see its own doc —
		 * and `nudge` is the same thing during a drag, in the units a finger moves in.
		 *
		 * **Invisible until the engine's button exists.** The engine creates its touch GUI about a second and a
		 * half after the client ignites and this frame's position is `(0, 0)` until then — the top-left corner of
		 * the screen — so its `Visible` is the restyle's own `found` flag. Five toes appearing *with* the jump
		 * button, in the right place, rather than a second and a half before it somewhere else, is the whole of what
		 * that buys.
		 */
		const pawFrame = Fusion.New(scope, "Frame")({
			Name: "MobileControls",
			Size: UDim2.fromOffset(0, 0),
			BackgroundTransparency: 1,
			AnchorPoint: new Vector2(0.5, 0.5),
			Position: Fusion.Computed(scope, (use) => {
				const centre = use(jump.centre);
				const multiplier = use(scale);
				const moved = use(nudge);

				return UDim2.fromOffset(
					centre.X + PAW_OFFSET.X * multiplier + moved.X,
					centre.Y + PAW_OFFSET.Y * multiplier + moved.Y,
				);
			}),
			Visible: Fusion.Computed(scope, (use) => use(jump.found)),
		});

		for (let index = 0; index < paw.size(); index++) {
			const control = paw[index];
			const radians = math.rad(bearings[index]);
			const cell = this.buildCell(scope, theme, control, arrange);

			/**
			 * **Where one toe goes: the circle's centre on the arc, and the cell hung below it.**
			 *
			 * A cell is a column — the circle, then the word — read top to bottom, so the natural anchor for it is
			 * its top-centre: `AnchorPoint (0.5, 0)` puts the cell's own origin on that point and lets the label
			 * hang underneath without moving the circle. **The vertical offset therefore subtracts the circle's own
			 * radius**, which is what puts the *circle's centre* on the arc rather than the top of the cell; it is
			 * the one place a reader has to remember that a cell is taller than its button. The horizontal needs no
			 * such correction, and that is the anchor doing it: half the cell's width is left of the anchor point,
			 * so the cell is centred on it for free.
			 *
			 * **Each cell carries its own `UIScale` rather than the frame carrying one for all five.** The
			 * alternative is one scale on the frame above — which is what this HUD used to do — and it would make
			 * every offset in this loop depend on whether `UIScale` scales its descendants' *positions* as well as
			 * their sizes. It does, but an arithmetic dependence on an engine behaviour is worth four more
			 * instances to avoid when the placement can simply be stated in screen pixels. **The consequence to
			 * know: the arc is placed in screen pixels and the buttons are in reference pixels times the scale**,
			 * which is why `radius` above adds the two kinds rather than multiplying one of them.
			 */
			Fusion.Hydrate(scope, cell)({
				AnchorPoint: new Vector2(0.5, 0),
				Position: Fusion.Computed(scope, (use) => {
					const arcRadius = use(radius);

					return UDim2.fromOffset(
						math.cos(radians) * arcRadius,
						math.sin(radians) * arcRadius - (control.size / 2) * use(scale),
					);
				}),
			});

			Fusion.New(scope, "UIScale")({ Parent: cell, Scale: scale });

			cell.Parent = pawFrame;
		}

		pawFrame.Parent = getScreenSpaceGui();

		// **The sprint, which is no longer a button on this HUD.** Spawned rather than run here because resolving
		// the module it reads can wait on the engine; see {@link watchStick}.
		task.spawn(() => this.watchStick(scope));

		// **The numbers rather than the shape, because the shape cannot be argued with from a log.** The arc's
		// radius and its two end bearings are what decide whether the toes are on the screen and whether they clear
		// the pad, and they are all derived — so printing them is what makes "the paw is off the bottom" a
		// one-number answer instead of a re-derivation. The gaps are printed too: they are the number the shape is
		// judged on, and they are exactly what the derivation promises only while the spacing term is the one that
		// wins the `max` above.
		if (DEBUG) {
			print(
				`[HUD] mobile controls up — the paw: ${paw.size()} toes, ${string.format("%.1f", bearings[0])}° to ` +
					`${string.format("%.1f", bearings[paw.size() - 1])}°, on a ` +
					`${string.format("%.0f", spacingRadius)}px arc, gaps ${TOE_GAP}px ` +
					`(toes ${BUTTON_SIZE}px, throw ${THROW_SIZE}px)`,
			);
		}

		// **Arrange mode announces itself, loudly, because the cost of not noticing is a player who cannot throw.**
		// It is a development flag that silently disables all five controls, so a session that starts with it on
		// says so in the same breath as it says the cluster is up; see {@link ARRANGE}.
		if (DEBUG && ARRANGE) {
			print(
				"[HUD] ARRANGE MODE — drag any toe to move the whole paw; the toes do not act while this is on. " +
					"Set ARRANGE = false in MobileControlsController.ts to play.",
			);
		}
	}

	/**
	 * **The sprint, which is the movement stick's own magnitude rather than a button.**
	 *
	 * **Why this exists at all.** A sprint button was the sixth circle on this HUD, and it asked a player to do with
	 * a second finger what their first one was already doing: push the stick. Every phone game that has a sprint at
	 * all puts it on the stick's rim — the gesture *is* the mode — and this HUD was spending one of its thumb
	 * targets on a control the hand was already holding. So the button is gone and the magnitude is the sensor, and
	 * it still ends at `SprintController.holdSprint`, which is the same place the shift key ends. See
	 * {@link SPRINT_START_MAGNITUDE} for the two thresholds and for what the gap between them is for.
	 *
	 * **The read goes through the `PlayerModule`, which is the one door this codebase refuses everywhere else — so
	 * here is the argument rather than a summary of it.** The stick itself is the engine's `DynamicThumbstick`,
	 * inside `PlayerGui.TouchGui.TouchControlFrame`, and it is deliberately not addressed here: its *child*
	 * structure is the ControlModule's own business (the frame that actually moves under the thumb is not
	 * something this project can name without depending on that module's layout), and the supported way to ask
	 * where a touch stick points is the control module's `GetMoveVector`. `GetControls`, `GetMoveVector` and
	 * `PlayerScripts` all appear **nowhere** in `@rbxts/types` in this build — the same three-way absence
	 * `restyleEngineJump` lists for the jump button's route — so this is an untyped call at both ends, made once,
	 * wrapped in `pcall`, and reported at both ends. **It is *not* a `PlayerModule` fork**: nothing is overridden,
	 * nothing is replaced, and the module is asked a question it exists to answer.
	 *
	 * **What this means for whoever reads it: this is the only part of the cluster whose failure mode is "no
	 * sprint" rather than "a circle a few pixels off".** If the module's shape differs in this build, one log line
	 * says so and nothing else changes — no error, no partial state, no silently wrong input. That tolerance is
	 * what makes the door worth opening, because the alternatives are worse: a fabricated vector from
	 * `Humanoid.MoveDirection` would read about `1` **always** (the engine normalises it, which is the whole of why
	 * it is called `MoveDirection` and not `MoveVector`), so the fallback would sprint permanently and look like a
	 * different bug entirely.
	 *
	 * **`Heartbeat` and not `RenderStepped`.** The stick's vector is a fact about *input*: nothing on screen is
	 * derived from it, the frame it is read on does not matter, and `RenderStepped` would put this in the frame
	 * budget of every phone in the game for a value that changes at thumb speed. **Polled rather than subscribed**
	 * for the same class of reason: the module exposes a getter and not a signal, and the input action underneath
	 * it is one this file does not own and cannot name.
	 *
	 * **A latch, so the loop never repeats itself.** `SprintController.setHolding` already ignores a request that
	 * does not change the state, so the latch is not what protects the network — it is what makes the *hysteresis*
	 * legible: `sprinting` is the thing the two thresholds are edges of, and it is also why this loop allocates
	 * nothing per frame (no closures, no tables, one vector read).
	 */
	private watchStick(scope: Fusion.Scope<unknown>): void {
		const read = this.findStick();
		if (read === undefined) return;

		// **The calibration line, and it is evidence rather than decoration.** It prints the magnitude *now* — at
		// mount, with nobody touching the screen — so a session that sprints in place has the number that explains
		// it, and so does a session where the stick reads `0.5` at rest. See {@link MoveControls} for why this is
		// the reading a running client has to confirm rather than the typings.
		if (DEBUG) {
			print(
				`[HUD] sprint is the stick's own magnitude — it reads ${string.format("%.3f", read())} at rest, ` +
					`so the sprint starts at ${SPRINT_START_MAGNITUDE} and stops at ${SPRINT_STOP_MAGNITUDE}`,
			);
		}

		let sprinting = false;

		scope.push(
			RunService.Heartbeat.Connect(() => {
				const magnitude = read();

				// **Two tests and not one**, which is the hysteresis: the stick has to be pushed past the start
				// threshold to begin and eased back below the (lower) stop threshold to end, so a thumb resting near
				// one line cannot flip the state every frame. See {@link SPRINT_START_MAGNITUDE}.
				if (!sprinting && magnitude >= SPRINT_START_MAGNITUDE) {
					sprinting = true;
					this.sprintController.holdSprint(true);
				} else if (sprinting && magnitude < SPRINT_STOP_MAGNITUDE) {
					sprinting = false;
					this.sprintController.holdSprint(false);
				}
			}),
		);
	}

	/**
	 * **The one untyped call in this file: the control module's `GetMoveVector`, or `undefined`.**
	 *
	 * Returns a *reader* rather than the object it found, and that is the whole of how the untypedness is contained:
	 * everything below the guard is `unknown` and every step of it is checked by hand, so what leaves this method
	 * is a `() => number` with no `any` in its type and no cast at the call site. {@link watchStick} cannot tell
	 * that any of this is somebody else's table.
	 *
	 * **Every failure returns `undefined` rather than throwing, and each one prints a line that names itself.** A
	 * missing module, a module whose `require` fails, a controls table with no `GetMoveVector` on it — three
	 * different faults with three different fixes, and a single "no sprint" would make a session's log useless for
	 * telling them apart. That is the same rule this codebase applies to its own probes: print the fact being
	 * doubted.
	 *
	 * **`pcall` around the `require` and the `GetControls` call**, because past that point the code being run is
	 * not this project's: `require` executes the module's own body, and a failure inside it would otherwise take
	 * this controller — which has already mounted the paw by now — down with it. A sprint that does not work is a
	 * far smaller loss than a controller that throws on start-up.
	 */
	private findStick(): (() => number) | undefined {
		// **Waited for with a timeout rather than yielded on forever.** Both instances are created by the engine's
		// own scripts during boot, so they are usually there already; the timeout is what stops a client that
		// somehow lacks them from leaving a task alive for the session. `WaitForChild` with a timeout returns
		// `Instance | undefined`, which is the shape this whole method is written in.
		const playerScripts = Players.LocalPlayer.WaitForChild("PlayerScripts", STICK_WAIT_SECONDS);
		if (playerScripts === undefined) {
			if (DEBUG) print("[HUD] no PlayerScripts — the stick cannot be read, so this client has no sprint");

			return undefined;
		}

		const moduleScript = playerScripts.WaitForChild("PlayerModule", STICK_WAIT_SECONDS);
		if (moduleScript === undefined || !moduleScript.IsA("ModuleScript")) {
			if (DEBUG) print("[HUD] no PlayerModule — the stick cannot be read, so this client has no sprint");

			return undefined;
		}

		// **The whole chain inside one `pcall`, because everything past the `require` is somebody else's code.**
		// `require` runs the module's own body, and the call after it is made on a table this build has no typings
		// for — so a module that fails to load, a `GetControls` that has been renamed and a `GetControls` that
		// throws all arrive here as the same shape: a failure with a message. The message is what gets printed,
		// which is what keeps the three of them apart in a session's log. A sprint that does not work is a far
		// smaller loss than a controller that throws on start-up.
		//
		// **The `type(x.GetControls) === "function"` guard that was here first is *not* writable, and that is a
		// fact about the compiler worth recording**: roblox-ts refuses to read a member declared as a method
		// ("Cannot index a method without calling it"), because a method only exists as a colon call in Lua. So the
		// guard could not be written against {@link PlayerModuleShape} at all — the compiler had already answered
		// the question the guard was asking, and answered it the strict way. `pcall` is the runtime equivalent and
		// it is better here anyway: it also catches a body that throws.
		const [ok, controls] = pcall(() => {
			const playerModule = require(moduleScript) as PlayerModuleShape;

			return playerModule.GetControls();
		});

		if (!ok) {
			if (DEBUG) {
				print(
					"[HUD] the PlayerModule would not hand over its controls — " +
						`${tostring(controls)}; no sprint on this client`,
				);
			}

			return undefined;
		}

		// **Checked against a *property* view of the same table, which is the one place the method/property
		// distinction shows up as two casts.** Reading `controls.GetMoveVector` off {@link MoveControls} is refused
		// for the reason above; reading it off a table whose member is declared as a function-typed property is
		// allowed, and that is exactly what a runtime existence check is. The table is then cast *back* to the
		// method view to be called, because the call is the thing that has to pass `self`.
		if (type((controls as { GetMoveVector?: unknown }).GetMoveVector) !== "function") {
			if (DEBUG) print("[HUD] the control module has no GetMoveVector — no sprint on this client");

			return undefined;
		}

		// **Bound to the object it came from, not lifted off it.** `GetMoveVector` is a method: called on the table
		// it receives `self` and finds its own state, and called as a bare function it would receive nothing — which
		// is why the interface declares it as a method (see {@link MoveControls}) and why this closure keeps the
		// table alive rather than storing the function.
		const stick = controls as MoveControls;

		return () => stick.GetMoveVector().Magnitude;
	}

	/**
	 * One button and its word: **the circle, the space reserved inside it, and the label underneath.**
	 *
	 * **Three things in a column, which is the whole of the button's structure.** A `TextButton` rounded into a
	 * disc, an `ImageLabel` inside it that is empty today and will hold an icon later, and a `TextLabel` below
	 * the disc saying what the button does — because on this HUD the word *is* the legend, which is the one thing
	 * that separates this cluster from the keyboard's card.
	 *
	 * **The label is below the button rather than inside it**, deliberately: a word inside a 44px circle would
	 * have to be tiny or wrapped, and a control whose label competes with its own icon is a control that has to be
	 * read. Under it, the circle stays the whole target and the word annotates it — and on this shape the word also
	 * has somewhere to go, because the arc's radius is derived so that a toe's label hangs in open space rather
	 * than onto the pad. See {@link mount}.
	 *
	 * **The icon's box is a `ImageLabel` with no image, not a `Frame`.** Both reserve the same space, and the one
	 * that is already the right *class* is the one the art goes into: the day there is an id, this file gains one
	 * property instead of swapping an instance. Its `BackgroundTransparency` is `1` for the reason
	 * `SuperHudController.addIconSlot` records at its own icon — an `ImageLabel` is a rectangle that *contains* a
	 * picture, and a fill here would put a second rectangle inside the button that no asset could take away.
	 *
	 * **The press is `InputBegan`/`InputEnded` on the button itself, which is one pair for both kinds of input.**
	 * `MouseButton1Down`/`Up` are the mouse's half of that and are never fired by a finger, and a touch device's
	 * equivalent arrives as `InputBegan` with a `Touch` user input — so the `GuiObject` pair is what covers the
	 * platform this HUD exists for *and* the emulator it will be looked at in. `AutoButtonColor` is off for the
	 * reason every other hand-built button in this project switches it off: the engine's own darkening fights the
	 * state this file is about to write, and the two together read as a flicker rather than as a press.
	 *
	 * **The state is two property writes, not a tween and not a `Computed`.** It is a *state* — a button is held
	 * or it is not — and there is nothing in between to animate; a fade would also leave the colour somewhere
	 * between the two states at exactly the moment the player wants to know which one they are in. And it is
	 * written straight onto the instance rather than through the graph for `wireInteraction`'s reason: what moves
	 * is an instance property, nothing reads it, and a `Computed` here would need an `Observer` to have any
	 * effect at all.
	 *
	 * **And the same press is a *grab* while arrange mode is on**, which is the one branch in here that is not
	 * about a control at all: {@link mount} hands the hook in only when {@link ARRANGE} is true, the press then
	 * starts a drag instead of an action, and `InputChanged` — an event this file had no use for until now — is
	 * what reports where the finger went. Nothing about the button changes except which of two things one finger
	 * does; see {@link ArrangeHook}.
	 */
	private buildCell(
		scope: Fusion.Scope<unknown>,
		theme: HudTheme,
		control: TouchControl,
		arrange?: ArrangeHook,
	): Frame {
		const size = control.size;

		const cell = Fusion.New(scope, "Frame")({
			Name: `${control.label}Cell`,
			Size: UDim2.fromOffset(0, 0),
			AutomaticSize: Enum.AutomaticSize.XY,
			BackgroundTransparency: 1,
		});

		Fusion.New(scope, "UIListLayout")({
			Parent: cell,
			FillDirection: Enum.FillDirection.Vertical,
			SortOrder: Enum.SortOrder.LayoutOrder,
			HorizontalAlignment: Enum.HorizontalAlignment.Center,
			Padding: new UDim(0, LABEL_GAP),
		});

		const button = Fusion.New(scope, "TextButton")({
			Name: control.label,
			Size: UDim2.fromOffset(size, size),
			// **The idle state, and the two properties are the whole of the difference between the states.** See
			// {@link IDLE_TRANSPARENCY} for the colour and the opacity and for what the alternative was.
			BackgroundColor3: theme.colors.trough,
			BackgroundTransparency: IDLE_TRANSPARENCY,
			BorderSizePixel: 0,
			AutoButtonColor: false,
			// A button whose text is its label would draw the word in the circle; the word is a sibling below it.
			Text: "",
			LayoutOrder: 1,
		});

		// `UDim(1, 0)` — all of it — which is a circle at any size. See the class doc for why the shape is drawn
		// rather than loaded.
		Fusion.New(scope, "UICorner")({ Parent: button, CornerRadius: new UDim(1, 0) });

		// The icon's space, centred and empty. `ScaleType.Fit` so the art that arrives is never squashed into the
		// square — `SuperHudController`'s rule at its own icon, and for the same reason: two icons from whoever
		// draws them will not both be square.
		Fusion.New(scope, "ImageLabel")({
			Name: "Icon",
			Parent: button,
			AnchorPoint: new Vector2(0.5, 0.5),
			Position: UDim2.fromScale(0.5, 0.5),
			Size: UDim2.fromScale(ICON_RATIO, ICON_RATIO),
			BackgroundTransparency: 1,
			ScaleType: Enum.ScaleType.Fit,
		});

		// **One press per finger, whatever the engine announces.** `InputBegan` does not mean "the player pressed
		// this once" — it is re-sent for an input that never ended, when the window regains focus — and every
		// other input controller in this project keeps the same latch for the same reason. Without it a held
		// throw would restart its charge on each announcement, and a held sprint would send a stream of requests.
		let held = false;

		// **The grab's own latch, and where the finger was the last time it moved** — see `arrange`. A screen
		// position rather than a running delta, so a lost frame costs nothing: the next report is measured from
		// wherever the finger actually is rather than from where a previous frame *assumed* it would be.
		let grabbed = false;
		let grabLast = Vector2.zero;

		const paint = (down: boolean): void => {
			button.BackgroundColor3 = down ? theme.colors.accent : theme.colors.trough;
			button.BackgroundTransparency = down ? HELD_TRANSPARENCY : IDLE_TRANSPARENCY;
		};

		scope.push(
			button.InputBegan.Connect((input) => {
				// A button is a `GuiObject` and this event fires for hovers on a desktop pointer as well, so the
				// input type is what says whether something was actually pressed. `Touch` and `MouseButton1` are
				// the two the cluster is built for — see this method's doc for why the mouse's own pair of events
				// is not used alongside.
				const kind = input.UserInputType;
				if (kind !== Enum.UserInputType.Touch && kind !== Enum.UserInputType.MouseButton1) return;

				// **In arrange mode the press grabs instead of acting, and the action does not run at all.** That
				// is deliberate: the alternative is guessing whether a gesture is a tap or a drag, and a wrong
				// guess throws the ball while somebody is trying to move a button. See {@link ARRANGE}.
				if (arrange !== undefined) {
					grabbed = true;
					grabLast = new Vector2(input.Position.X, input.Position.Y);
					paint(true);

					return;
				}

				if (held) return;
				held = true;

				// **The press itself, printed once per press.** Every action this cluster drives already has a log
				// line of its own inside the controller that owns it — except the jump, whose whole effect is one
				// property write — so without this a press that reached nothing at all and a press that reached
				// the wrong thing look the same from the outside. It is also what separates the two halves of "a
				// button does nothing": this line missing means the *input* never arrived here, and this line
				// followed by nothing means the action itself refused.
				if (DEBUG) print(`[HUD] ${control.label} down`);

				paint(true);
				control.down();
			}),
		);

		// **Where the drag is reported, and the one event this file did not use before.** `InputChanged` is where
		// an input that is already down says that it moved, and for a touch that is the only place the movement
		// exists — `InputBegan` happens once and `InputEnded` arrives when it is over. **`Position` rather than
		// `Delta`**, with the previous position kept beside it: the delta the engine reports is per-frame, and a
		// frame that arrives twice or not at all would make the paw drift away from the finger; two positions and
		// a subtraction cannot.
		scope.push(
			button.InputChanged.Connect((input) => {
				if (!grabbed || arrange === undefined) return;
				if (
					input.UserInputType !== Enum.UserInputType.Touch &&
					input.UserInputType !== Enum.UserInputType.MouseMovement
				) {
					return;
				}

				const here = new Vector2(input.Position.X, input.Position.Y);
				arrange.move(here.sub(grabLast));
				grabLast = here;
			}),
		);

		scope.push(
			button.InputEnded.Connect(() => {
				// **The release is taken however it arrives**, which is the rule `DodgeController` and
				// `SprintController` both follow for their own releases: an ending is unambiguous, and a finger
				// that slides off the button still has to end the hold it began. A release with no hold is a
				// no-op, so nothing here needs to ask which kind of input ended.
				if (grabbed) {
					grabbed = false;
					paint(false);

					// **And the moment the numbers are worth having**: the finger has stopped, so the paw is
					// wherever it is going to be and the offset is the answer. See {@link ARRANGE}.
					arrange?.done();

					return;
				}

				if (!held) return;
				held = false;

				paint(false);
				if (control.up !== undefined) control.up();
			}),
		);

		const label = this.buildLabel(scope, theme, control.label);
		label.LayoutOrder = 2;
		label.Parent = cell;

		button.Parent = cell;

		return cell;
	}

	/**
	 * The cluster's one responsive number: **how much of the reference viewport this screen is, clamped.**
	 *
	 * **A `UIScale` on each cell rather than sizes in `Scale`**, and the difference is what the layouts in this
	 * file can survive. Every cell here is `AutomaticSize`, and a `UDim2.fromScale` size inside an auto-sized
	 * parent is the measurement cycle this codebase has met three times — the label asks the cell how wide it is
	 * and the cell asks the label. One multiplier applied *after* the layout is one number to read instead of
	 * eleven that have to agree, and the numbers above keep meaning what they look like: a 44px toe is 44px
	 * on the phone this was drawn against, and the scale is how much bigger or smaller that phone is. That is
	 * `ArenaFreezeCountdownController`'s `NUMBER_SCALE` argument with the factor derived from the screen instead
	 * of chosen by hand.
	 *
	 * **It is also one of the two numbers the arc's radius is made of**, which is why it is returned rather than
	 * parented here: the placement in {@link mount} needs the multiplier as a *value* — the engine's button is
	 * measured in screen pixels and our toes in reference ones, so the two kinds have to be compared after one of
	 * them has been multiplied. See `radius` for that comparison and for why it is not a constant.
	 *
	 * **The smaller of the two axes fits**, rather than one axis or the other. The width alone would let a phone
	 * held sideways keep full-size buttons on a viewport half as tall; the height alone would shrink the buttons
	 * on every wide screen, including the portrait phone they were drawn for. The *smaller* of the two is the one
	 * that fits, which is what "as big as will fit" means for a group of circles that has to stay on the screen.
	 * See {@link REFERENCE_VIEWPORT} for the pair being divided by.
	 *
	 * **Read once and then subscribed to, rather than read per frame.** The screen changes size for two reasons
	 * — a rotation and a window being dragged — and both fire a signal, so a per-frame read would spend sixty
	 * reads a second to notice something that happens twice a session. This is `getHudColumn`'s shape in
	 * `ui/screenGui.ts`, which watches the same property for the same class of reason.
	 *
	 * **A missing camera is not an error**: there is no viewport before one exists, and the reference size is
	 * the honest answer for the one frame it can happen on — the size the numbers were drawn at.
	 *
	 * **The arithmetic itself is {@link scaleFor}**, which is a function of the viewport and nothing else; this
	 * method's whole job is to be the thing that watches for a new viewport and hands it over.
	 */
	private buildScale(scope: Fusion.Scope<unknown>): Fusion.UsedAs<number> {
		const camera = Workspace.CurrentCamera;
		const size = Fusion.Value(scope, camera !== undefined ? camera.ViewportSize : REFERENCE_VIEWPORT);

		if (camera !== undefined) {
			scope.push(camera.GetPropertyChangedSignal("ViewportSize").Connect(() => size.set(camera.ViewportSize)));
		}

		return Fusion.Computed(scope, (use) => scaleFor(use(size)));
	}

	/**
	 * **Finds the engine's own jump button, gives it this HUD's look, and reports where it is and how big.**
	 *
	 * **Why the jump is not this controller's button, after all.** There was one: an 88px circle in this
	 * cluster whose press wrote `Humanoid.Jump = true`. It never worked, and the log said why — thirteen
	 * presses, every one reaching the method, every one on a body that read `state Running, jumping true,
	 * stand false, floor Plastic, root anchored false`, and not one jump. **`Humanoid.Jump` is not a latch the
	 * engine reads whenever it likes; it is a flag the ControlModule also owns**, and the module writes it from
	 * the jump input *it* is holding — which on a device with no engine jump button left on screen is `false`,
	 * written late in the frame, after the input callback ours ran in. Moving the write to `RunService.Stepped`
	 * put it after the module's and before physics, and that was still a fight over somebody else's flag.
	 *
	 * **So the button comes back and the input does not.** The engine's `JumpButton` is driven by the module
	 * itself, so the module never overwrites its own input and the jump works by construction — and what this
	 * function does is *dress* that button, not replace it. That is the inversion worth reading twice: the
	 * custom button was the one thing on this HUD that was **ours**, and it is the one thing that could not be
	 * made to work, because the state it wrote belongs to the PlayerModule.
	 *
	 * **Found by name, from `PlayerGui`, and the path is proven rather than assumed** — the previous pass's own
	 * log line reads `Players.prospeed1.PlayerGui.TouchGui.TouchControlFrame.JumpButton`, printed by the hide
	 * this replaces. **The `PlayerModule` route (`LocalPlayer.PlayerScripts.PlayerModule:GetControls()`) is
	 * deliberately not used**, for three reasons worth stating because it is the documented one:
	 * `PlayerScripts` is not a typed member of `Player` in this build, `GetControls` and `JumpButton` appear
	 * nowhere in the installed typings at all, so both ends of that call would be untyped, **and** this
	 * codebase already refuses to fork the `PlayerModule` twice over (`ShiftLock` for the camera, `IasTest` for
	 * the input contexts) — reaching *into* it for a child reference is the same door. The name path is one
	 * `FindFirstChild` with a class check, and it is the path the engine's own GUI is addressable by.
	 *
	 * **Found by name *and* class-checked, because a name alone can be shadowed.** `FindFirstChild("JumpButton",
	 * true)` searches the whole touch GUI — the frame it lives in is the ControlModule's business and not a path
	 * this file should hard-code — and the class check is what stops something *else* called `JumpButton` from
	 * turning this into a no-op that reads as "the engine must have moved it".
	 *
	 * **Re-applied rather than done once, and watched rather than swept once.** The engine's own GUIs are not
	 * permanent: `ui/screenGui.ts` records that its `ScreenGui`s in `PlayerGui` "may rebuild at will", and the
	 * previous log shows this button appearing a second and a half *after* the client ignited — a mount-time
	 * `FindFirstChild` alone would miss it half the time. So the GUI is watched as well as swept: `ChildAdded`
	 * on `PlayerGui` for a whole new `TouchGui`, `DescendantAdded` on the one that is there for a frame rebuilt
	 * inside it, with the re-subscription guarded by holding the instance so one GUI is never watched twice.
	 * **Nothing hides anything any more** — least of all `TouchControlFrame`, which holds the thumbstick this
	 * HUD's dodge and sprint read the movement from.
	 *
	 * **Where each half of the look lives, and why it is split that way.** The *geometry* — `Size`, `Position`,
	 * the corner it sits in — is the module's and stays the module's: it re-lays the button out on every
	 * viewport change, so a restyle that moved it would be reverted on the first rotation, and the corner it
	 * already occupies is the corner a thumb rests in. The *appearance* is ours, and it is all drawn as
	 * **children of that button and as its own background colour** — a `UICorner`, an icon slot, a label — so
	 * every pixel of the look follows the button wherever the module puts it, at whatever size, with nothing
	 * here to re-apply.
	 *
	 * **And the size is where the split has an exception, which is the `UIScale` added below.** The module owns
	 * how big that button is, but it drew it at 120px on one phone and 70px on another (see {@link PAD_SIZE}),
	 * and a pad that size builds a paw of five toes the size of dinner plates. **A `UIScale` is the one property
	 * that changes how big a `GuiObject` renders without touching `Size`** — the reference's own words are that its
	 * `Scale` "is used to multiply the `AbsoluteSize` of the parent UI element" — so the module's layout is left
	 * completely alone and only the *rendered* size changes. It is added *after* the restyle's own children, as a
	 * sibling of them, and it is created once rather than in `paintParts`: the look is re-asserted on every press
	 * and the scale is not a thing a press can change. **The one assumption in it** is that the module never
	 * writes a `UIScale` of its own — the discovery probe reads `0 child(ren)` on a fresh button, and nothing in
	 * three passes of logs has shown it adding one.
	 *
	 * **The one thing this cannot promise, stated rather than discovered.** The module owns the button's
	 * `BackgroundColor3`, `BackgroundTransparency` and `Image`, and it changes them on press to draw its own
	 * feedback. Ours is written once at discovery and again on each press and release, connected *after* the
	 * module's own handlers so ours is the later write of the two; if the module turns out to write those
	 * properties from a per-frame update instead of from its input handlers, the button will flick back to the
	 * engine's colours and the fix is a re-assert on the same signal the module uses. What the log prints at
	 * discovery is the evidence either way — see the report below.
	 *
	 * **Returns where the button is and how big it is, kept live** — see {@link JumpGeometry}, which carries the
	 * three readings and why they are three. **Nothing is returned for a client with no touch GUI** (a desktop
	 * client, an emulator without one): the values stay at `(0, 0)`, `0` and `false`, and `false` is what keeps
	 * the paw invisible rather than parked in the corner — see {@link mount}, which is where that is used.
	 *
	 * **Where the button is, is now two numbers rather than one, and that is the fix to a real bug.** This
	 * function returned the button's *top edge* to the first column, which that cluster spent as a margin from
	 * the bottom of the screen — one number measured from one edge and used against another, which put the whole
	 * cluster in the top-right corner and cut it in half in landscape. A centre and a size cannot be spent that
	 * way: they describe the button rather than a distance to it.
	 */
	private restyleEngineJump(scope: Fusion.Scope<unknown>, theme: HudTheme): JumpGeometry {
		const playerGui = Players.LocalPlayer.WaitForChild("PlayerGui") as PlayerGui;

		// **The three readings, and every one of them is written by `measure` below rather than here.** These are
		// the values {@link mount} derives the arc from, so they outlive this method and are returned to it —
		// see {@link JumpGeometry}.
		const geometry: JumpGeometry = {
			centre: Fusion.Value(scope, new Vector2(0, 0)),
			size: Fusion.Value(scope, 0),
			found: Fusion.Value(scope, false),
		};

		/** The button already dressed, so a rebuilt frame inside the same GUI is not dressed twice. */
		let dressed: GuiButton | undefined;

		/** The `TouchGui` already watched — see this method's doc for why the watch is held. */
		let watched: Instance | undefined;

		/**
		 * The appearance, and **only the appearance: no connections are made here, so this can be called again.**
		 *
		 * That is what makes it safe to re-run on every press — see `sweep`, which calls it once when the button
		 * is found and hands it to the two input connections for every press after that. **The module is the other
		 * writer of most of these properties**, and a press is the one moment it is guaranteed to touch them (its
		 * own feedback), so re-asserting here is what keeps the engine's colours from winning on the frame a player
		 * is looking at. Everything below is idempotent: the corner and the icon slot are created by name, and the
		 * rest are property writes.
		 */
		const paintParts = (button: GuiButton): void => {
			// **The engine's own picture, off.** The sprite is the one part of the look a child cannot replace — an
			// `ImageButton`'s `Image` is a property of the button itself — so it is emptied rather than covered: a
			// child drawn over it would be a *translucent* circle and the engine's white arrow would still show
			// through. `GuiButton` rather than `ImageButton` in the signature because the hunt accepts either (the
			// class check that found it is `GuiButton`, which both are) and only the image properties are narrower.
			if (button.IsA("ImageButton")) button.Image = "";

			// `AutoButtonColor` off for the reason every hand-built button in this project has it off: the engine's
			// own darkening fights the state this HUD writes.
			button.AutoButtonColor = false;

			// **Idempotent by name, because this runs again on every press.** A second `UICorner` on one button
			// would be one corner fighting another, which is the same class of mistake as two `UIListLayout`s.
			if (button.FindFirstChild("HudCorner") === undefined) {
				Fusion.New(scope, "UICorner")({
					Name: "HudCorner",
					Parent: button,
					CornerRadius: new UDim(1, 0),
				});
			}

			// **The icon's slot and the word, as children, at the cluster's own proportions.** The label hangs
			// *below* the circle — `Position` at the button's bottom edge — which is the cluster's arrangement, and
			// it is why `ClipsDescendants` is forced off: a button that clipped would cut its own label in half.
			// **Children rather than siblings is the whole trick of this restyle**: the module re-lays this button
			// out whenever the viewport changes, and everything drawn here moves with it for free.
			if (button.FindFirstChild("HudIcon") === undefined) {
				Fusion.New(scope, "ImageLabel")({
					Name: "HudIcon",
					Parent: button,
					AnchorPoint: new Vector2(0.5, 0.5),
					Position: UDim2.fromScale(0.5, 0.5),
					Size: UDim2.fromScale(ICON_RATIO, ICON_RATIO),
					BackgroundTransparency: 1,
					ScaleType: Enum.ScaleType.Fit,
				});

				const label = this.buildLabel(scope, theme, JUMP_LABEL);
				label.Name = "HudLabel";
				label.AnchorPoint = new Vector2(0.5, 0);
				label.Position = new UDim2(0.5, 0, 1, LABEL_GAP);
				label.Parent = button;
			}

			button.ClipsDescendants = false;
		};

		const dress = (button: GuiButton): void => {
			// Printed on the way in rather than on the way out, which is this codebase's rule for the one step that
			// can report a surprise: **this project cannot read the PlayerModule's source**, so what the engine had
			// set on its own button is the probe — the numbers that say what the module does with it, and whether
			// the assumptions above (an image, a background colour, a size) are the ones this build ships.
			if (DEBUG) {
				const image =
					button.IsA("ImageButton")
						? `image "${button.Image}" at ${string.format("%.2f", button.ImageTransparency)}`
						: `class ${button.ClassName}`;

				print(
					`[HUD] engine jump button — ${button.GetFullName()}, ` +
						`size ${button.Size}, pos ${button.Position}, anchor ${button.AnchorPoint}, ` +
						`bg ${button.BackgroundColor3} at ${string.format("%.2f", button.BackgroundTransparency)}, ` +
						`${image}, clips ${button.ClipsDescendants}, ${button.GetChildren().size()} child(ren)`,
				);
			}

			paintParts(button);
			this.paintJump(button, theme, false);
		};

		const sweep = (): void => {
			const touch = playerGui.FindFirstChild("TouchGui");
			if (touch === undefined) return;

			if (watched !== touch) {
				watched = touch;
				scope.push(touch.DescendantAdded.Connect(() => sweep()));
			}

			const button = touch.FindFirstChild("JumpButton", true);
			if (button === undefined || !button.IsA("GuiButton")) return;

			if (dressed === button) return;
			dressed = button;

			dress(button);

			/**
			 * **The pad's shrink: the one thing this file writes to the engine's button besides its look.**
			 *
			 * **A `UIScale`, because that is the property that changes how big a `GuiObject` renders without
			 * touching its `Size`** — the reference says its `Scale` "is used to multiply the `AbsoluteSize` of the
			 * parent UI element", and its own example turns a `{0, 200}` `AbsoluteSize` into `{0, 100}` at `0.5`. So
			 * the module's layout is left completely alone, `AbsoluteSize` reports the *shrunk* size, and every
			 * number in {@link mount} follows the visual pad with no arithmetic of ours to keep in step. See
			 * {@link PAD_SIZE} for the target size and for why the scale is derived rather than the `0.6` this
			 * started as.
			 *
			 * **Created here, once, rather than in `paintParts`.** The look is re-asserted on every press because
			 * the module repaints the button on press; the scale is not something a press can change, and a second
			 * `UIScale` on one button would be one multiplier fighting another — the same class of mistake as two
			 * `UIListLayout`s on one frame. It goes on *after* the restyle's own children, so what a reader finds in
			 * the tree is the look and then the scale.
			 *
			 * **`Scale` starts at `1` and `measure` corrects it in the same frame**, because the correction needs
			 * the button's size and the size depends on the scale — a circle `measure` closes by dividing the
			 * rendered size by the scale that produced it.
			 */
			const hudScale = Fusion.New(scope, "UIScale")({
				Name: "HudScale",
				Parent: button,
				Scale: 1,
			});

			/** What the engine's button measured at the last report, so `measure` prints news rather than frames. */
			let reportedEngineSize = -1;

			// **The two halves of the held state, on the button's own input.** Connected once, here — after the
			// module created the button and bound its own handlers — so ours is the later write of the two and the
			// state a player sees is this HUD's. `InputEnded` is taken however it arrives, which is the rule every
			// other button in this project follows: a finger that slides off still ends the press it began.
			scope.push(
				button.InputBegan.Connect(() => {
					paintParts(button);
					this.paintJump(button, theme, true);
				}),
			);
			scope.push(
				button.InputEnded.Connect(() => {
					paintParts(button);
					this.paintJump(button, theme, false);
				}),
			);

			/**
			 * **Where the button is, how big it is, and how small it has been made — kept up to date.**
			 *
			 * The engine moves and resizes its button on every viewport change, so all of it is re-taken from the
			 * same two signals rather than captured once — and the toes, which are derived from it, follow the pad
			 * instead of being right at mount and wrong after the first rotation.
			 *
			 * **The pad's own size is recovered by dividing the scale back out, and that is the subtle line here.**
			 * `AbsoluteSize` *includes* our `UIScale` — that is what a `UIScale` is — so the engine's own size is
			 * `rendered ÷ the scale currently applied`, and the scale this method then writes is
			 * `min(1, PAD_SIZE ÷ that)`. Substituted, the two cancel: what is written is what was read, so the
			 * write cannot feed itself. **That is exactly the trap a scale derived from `AbsoluteSize` alone would
			 * fall into** — each pass would multiply the pad by `PAD_SIZE ÷ its own size` and the pad would vanish
			 * in a couple of frames. See {@link PAD_SIZE}.
			 *
			 * **`min(1, …)` is the "shrink, never enlarge" rule**, which is why the second logged device — a 70px
			 * pad — keeps the size the engine gave it.
			 *
			 * **The centre rather than the corner, because the toes are placed around the pad's *centre*.** An
			 * `AnchorPoint` of `(0, 0)` means the rendered button expands from its own top-left, so that corner is
			 * where the engine left it and the centre is that corner plus half of the *visual* size. **The visual
			 * size is computed rather than re-read from `AbsoluteSize`**, so this lands on the frame the scale
			 * changes instead of one signal later.
			 *
			 * **The larger axis rather than `X`**, because the engine's own button is not guaranteed square and a
			 * clearance taken from the narrow axis would put toes *inside* a wide button. A button that is wider
			 * than it is tall therefore gets a little more room than it strictly needs, which is the harmless
			 * direction for that mistake to go in.
			 */
			const measure = (): void => {
				const rendered = math.max(button.AbsoluteSize.X, button.AbsoluteSize.Y);
				const engineSize = rendered / hudScale.Scale;
				const visualSize = math.min(engineSize, PAD_SIZE);

				hudScale.Scale = math.min(1, PAD_SIZE / engineSize);

				geometry.centre.set(button.AbsolutePosition.add(new Vector2(visualSize / 2, visualSize / 2)));
				geometry.size.set(visualSize);

				// **The line that makes the shrink answerable from a log**, and the one number a run needs if the
				// paw ever comes out at the wrong scale: what the engine drew, what it is being rendered at, and by
				// how much. Printed on the way in for this codebase's usual reason — the sizes are the fact being
				// doubted — and guarded so that a viewport change re-reports while a press does not.
				if (DEBUG && engineSize !== reportedEngineSize) {
					reportedEngineSize = engineSize;

					print(
						`[HUD] jump pad — the engine drew ${string.format("%.0f", engineSize)}px, ` +
							`rendering ${string.format("%.0f", visualSize)}px at scale ` +
							`${string.format("%.3f", hudScale.Scale)}`,
					);
				}
			};

			measure();

			// **And the paw may be shown now.** This is the flag {@link mount} builds the toes' `Visible` from, and
			// it is set here rather than at the end of the method because this is the moment the button exists and
			// its centre is therefore a real place to draw around. See {@link JumpGeometry}.
			geometry.found.set(true);

			scope.push(button.GetPropertyChangedSignal("AbsolutePosition").Connect(measure));
			scope.push(button.GetPropertyChangedSignal("AbsoluteSize").Connect(measure));
		};

		sweep();
		scope.push(playerGui.ChildAdded.Connect(() => sweep()));

		return geometry;
	}

	/**
	 * The engine's button in this HUD's two states, which are the cluster's two states.
	 *
	 * **Two property writes and no tween**, for the reason `buildCell` gives about the cluster's own buttons: a
	 * button is held or it is not, and a fade would leave the colour somewhere between the two at exactly the
	 * moment a player wants to know which one they are in. `accent` is the theme's own word for "the thing to
	 * press" and `trough` is its near-black, so the jump button is the same statement in the same vocabulary as
	 * the five beside it — see `IDLE_TRANSPARENCY`, which is the 0.6 this shares.
	 *
	 * **Kept as a method rather than inlined**, because it has three callers — the discovery, the press and the
	 * release — and one definition is what makes "the pressed state is the cluster's pressed state" a fact
	 * rather than three copies of a hope.
	 */
	private paintJump(button: GuiButton, theme: HudTheme, held: boolean): void {
		button.BackgroundColor3 = held ? theme.colors.accent : theme.colors.trough;
		button.BackgroundTransparency = held ? HELD_TRANSPARENCY : IDLE_TRANSPARENCY;
	}

	/**
	 * The word under a button: the cluster's legend, and the reason this HUD exists at all.
	 *
	 * **`caption`, and it is the one variant in this file that is a judgement rather than a measurement.** The
	 * theme's own label step — 12px, a 16px line — which is the size the legend's headings are drawn at, so the
	 * two HUDs read as the same family. **The desktop card spells its controls out** ("Left Click (hold)") and
	 * this does not: a thumb has no room for a sentence, and a button that has to be *read* rather than seen is
	 * the failure this whole HUD is an answer to. That is why the throw's label says `Throw` and not `Throw
	 * (hold)` — the hold is learned from the button moving, which is what the pressed state is for.
	 *
	 * Wrapping off with a zero size, which is the legend's rule for the same reason: a label sized to its text
	 * inside a parent sized to the label is a circle, and Roblox resolves it by guessing.
	 */
	private buildLabel(scope: Fusion.Scope<unknown>, theme: HudTheme, word: string): TextLabel {
		const label = Text(scope, { text: word, variant: "caption", wrap: false });

		label.Size = UDim2.fromOffset(0, 0);
		label.AutomaticSize = Enum.AutomaticSize.XY;
		label.TextColor3 = theme.colors.textPrimary;
		label.TextTransparency = 0;

		return label;
	}
}
