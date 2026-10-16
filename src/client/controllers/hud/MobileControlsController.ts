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
 * **The hand-move mode: drag anywhere on the cluster and the whole box follows your finger.** **Placeholder —
 * `false`.**
 *
 * **Turn it on, drag the cluster where you want it, and paste the two numbers it prints into {@link BOX_NUDGE}** —
 * that is the whole loop, and it is a live one: `rojo serve` is usually up, so flipping this and saving puts the
 * mode into the running game in a second or two.
 *
 * **It exists because the derivation is not something a person can nudge.** Where the box sits is computed from the
 * engine's jump button (see {@link BOX_PAD_GAP}), which is right for every device nobody has looked at and no help
 * at all for the one in front of you. The drag is how the delta gets found — one gesture, one number, one paste —
 * instead of by rebuilding with a guessed constant, and the gesture *starts from where the cluster already is*, so
 * switching the mode on never moves anything.
 *
 * **While it is on, a press on a button is a grip rather than a press**: no action fires, no colour changes, and
 * the same for all five, because the unit that moves is the *box*. That is the one thing this mode costs — the
 * cluster cannot be played while it is being placed — which is why it is a constant in the file rather than
 * something reachable at runtime.
 *
 * **The packing pass deleted this tool, and the argument that deleted it was true in one direction only.** The
 * claim was that a fixed box needs no drag tool: one number to tune, and the number is the box's size. True of the
 * *size* and false of the *place* — the place is derived from something that differs per device, so the only way
 * to disagree with it is by hand, and a tool is how a hand finds a number. See {@link BOX_NUDGE}.
 */
const ARRANGE: boolean = false;

/**
 * The gap between two buttons in the box, in reference pixels. **Placeholder — 10.**
 *
 * **A gap, not a packing rule.** The buttons sit on a grid whose cell is `size + gap`, so this is what is left
 * over between two circles once the cells are as small as they can be. `10` on a 72px button is the tightness the
 * last hand-tuning arrived at: close enough to read as one object, far enough that two half-transparent circles
 * do not look like they touch.
 */
const BOX_GAP = 10;

/**
 * The room a button's word needs under it, in pixels. **Placeholder — 20, and it is `LABEL_GAP` plus one line.**
 *
 * **A fixed band rather than a factor in the button's size**, which is the choice this file made and the one thing
 * about the packing that is not pure arithmetic: the label is 12px of text under a 4px gap, so every row of
 * buttons is really `size + 20` tall. Subtracting the band from the available height once per row is the same
 * arithmetic as making the cells taller would be, and it has the advantage of being a number that does **not** move
 * when the box does — the text is a fixed 12px in this design, so neither is the room it needs. See {@link pack},
 * which takes it as an argument for exactly that reason, and {@link mount}, which reads the live line height from
 * the theme rather than trusting this default.
 */
const LABEL_BAND = 20;

/**
 * How far the box sits from the screen's right edge, in reference pixels. **Placeholder — 12.**
 *
 * **The same 12 the rest of the furniture uses**, and it is the only screen edge this box names — the other three
 * sides come from the box's own size or from the pad below it.
 */
const BOX_EDGE_GAP = 12;

/**
 * How far the box sits *above the engine's jump button*, in reference pixels. **Placeholder — 8.**
 *
 * **A gap from the pad rather than from the bottom edge of the screen, and this is the one thing the box could not
 * take from a fixed corner offset.** The engine's button is not at a fixed height: this project's own logs put its
 * top edge **90px** and **210px** above the bottom of the screen on two different runs, because the ControlModule
 * lays its own touch controls out per device. A fixed bottom margin would therefore either overlap the pad on the
 * tighter device or float the box most of a screen height above it on the looser one. So the box's bottom edge is
 * derived from the pad and this is the one number in that derivation.
 */
const BOX_PAD_GAP = 8;

/**
 * **How far the box is moved from where the derivation puts it, in reference pixels: `X` right, `Y` down.**
 * **Placeholder — `(0, 0)`, which is exactly where the derivation puts it.**
 *
 * **This is the hand's half of the position, and it is a *nudge* rather than a corner on purpose.** The derived
 * place is right on every device — it is the pad that moves, not the layout — so a constant that *replaced* it
 * would throw that away and have to be found again on the next phone. A delta keeps it: `new Vector2(0, 40)` reads
 * as "40px lower than the derivation thinks, on whatever device this is", which is the sentence a person actually
 * has in mind when they say the buttons should be lower. See {@link BOX_PAD_GAP} for the derivation it modifies.
 *
 * **It is also the only way to move the cluster *down*.** The derivation puts the box's bottom edge just above the
 * pad's top edge, so below the cluster there is nothing but the engine's own button, and crossing that line is what
 * this constant is for. **`X` right and `Y` down, both positive in that direction**, because that is the way a
 * finger moves — a drag writes these two numbers with no sign flipped between the gesture and the file.
 *
 * **What a downward nudge costs: the cluster can end up on the jump.** The five buttons draw over whatever is under
 * the box, so a button that lands on the engine's button takes its presses. That is why the derivation exists and
 * why the pad is where it is (the module keeps it clear of the home indicator) — this constant is for overruling
 * that deliberately, not for fixing it by accident.
 *
 * **Nothing here is written back to the file**, so {@link ARRANGE} can take the box anywhere and a re-sync — or
 * simply turning the mode off — puts it back at the derivation. The number is the deliverable, not the position.
 */
const BOX_NUDGE = new Vector2(0, 40);

/**
 * The smallest a button may be laid out, in pixels. **Placeholder — 44.**
 *
 * **The tap-target floor, and it is a floor on the *clamp* rather than a target.** `pack` returns whatever size
 * the box permits; below this one the buttons are grown to it anyway and the pack says so in the log, because two
 * buttons that overlap are bad and a button a thumb cannot hit is worse — the overflow is the cheaper failure.
 * **On the 393-wide phone this file is drawn against the buttons come out at 72px**, so this is a guard for small
 * screens and short viewports rather than a number anything normal touches.
 */
const TAP_MIN = 44;

/**
 * How much of the circle an icon gets, as a fraction of its diameter. **Placeholder — 0.6.**
 *
 * **Reserved, not filled.** No icon is loaded here — the art is coming later — so every button today is an empty
 * circle with a word under it, and this is the box the picture goes in when it exists: centred, square, and six
 * tenths of the button across, which leaves a ring of the button's own colour visible all the way round. That ring
 * is what makes an icon read as *sitting in* something rather than as floating on the screen.
 *
 * **The day the art arrives this file changes in one place**: {@link buildButton} puts an id onto the `ImageLabel`
 * it already builds, and nothing about the sizes or the layout moves.
 */
const ICON_RATIO = 0.6;

/**
 * The size the engine's jump button is drawn at by this HUD, **in reference pixels. Placeholder — 72.**
 *
 * **The pad is the engine's, at whatever size the engine drew it, and this is the one number that disagrees with
 * it.** The button arrives at **120px** on the device in the first log and **70px** on the device in the second —
 * and those two are not a measure of how generous each phone is. They are a two-step rule in the module's own
 * source, `min(viewport's short axis) <= 500 ? 70 : 120`, and that is a fact worth having in front of you: **the
 * pad does not scale with the screen at all.** It is 70px on everything from a phone held sideways to a small
 * tablet and 120px on everything above that, for the life of the session. A box that scales beside a pad that
 * cannot is a cluster that comes apart on exactly the devices nobody tests on, which is what the second factor
 * below is for.
 *
 * **Applied as a `UIScale` made of two factors, and both are derived rather than chosen.** A constant scale — the
 * `0.6` that was tried first — renders 72px on the 120px device and **42px on the 70px one**. So the first factor
 * is `min(1, PAD_SIZE ÷ the engine's own size)`: the pad comes down to 72 wherever the engine drew it bigger and
 * is left exactly as the engine drew it wherever it is not — **shrink, never enlarge**. The second is
 * {@link scaleFor}'s viewport multiplier, the same number the box and its buttons are built from, and it is what
 * puts the pad back in step with them. See {@link restyleEngineJump} for the multiplication and `measure` there
 * for why the two factors cannot feed back on each other.
 *
 * **Why "shrink, never enlarge" is still the rule for the first factor, now that the pad is allowed to grow.** The
 * rule was written against a *fixed* target: at a fixed 72 the second log's 70px pad would have been left alone
 * while a 42px one would have been blown up to 72, i.e. a constant that quietly disagreed with half the fleet.
 * The target is not fixed any more — it is the reference size times the viewport, which is the same thing the
 * buttons get — so a *small* pad on a small screen is still left alone, and a small pad on a small screen is the
 * case the rule is about.
 *
 * **`UIScale` because the reference says its `Scale` "is used to multiply the `AbsoluteSize` of the parent UI
 * element"** — so `AbsoluteSize` reports the shrunk size and nothing else has to know about it. It is also the one
 * property of that button the module never writes: its `TouchJump` module sets `Size`, `Position`, `Image` and
 * `Visible` when it creates the button, and the discovery probe reads `0 child(ren)` on a fresh one. See
 * {@link restyleEngineJump}, which is where it is added.
 *
 * **The cluster uses the pad's size for two things and no more**: the box's bottom edge is derived from the pad's
 * top edge, and the pad's rendered size is the number a person compares the buttons against by eye. Nothing is
 * positioned *from* that size — see `measure` — which is the whole of the coupling that survived the arc being
 * deleted.
 */
const PAD_SIZE = 72;

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
 * Every size in this file is written in *reference* pixels and multiplied by one multiplier derived from this —
 * see {@link buildScale}. This pair of numbers is what decides how big a button is on somebody else's phone;
 * nothing else in the file knows the screen exists. **It is also the arithmetic behind {@link BOX_FRACTION}**,
 * which is the box's size divided by this pair, and that is the closest thing this corner has to a specification.
 *
 * **Both axes, and the second one is not decoration.** The obvious version measures the *short* axis alone, on
 * the argument that it reads 393 in portrait and 393 in landscape and therefore gives one phone one answer.
 * That is true and it is not sufficient: **the cluster is a rectangle with an aspect of its own**, and a phone
 * held sideways has a viewport 393 tall. A multiplier taken from the width alone would ask for a box
 * `0.6005 × 852 = 512px` wide on a screen whose whole height is 393 — and `pack`, handed a 512 × 90 box, would
 * answer with `(90 − 10)/2 − 20 = 20px` buttons: below its own tap floor, so raised to 44 and then overlapping
 * each other inside a rectangle that no longer fits on the screen. Fitting *both* axes against the reference
 * viewport is the same rule with the height added, and it is what makes "393 × 852 portrait as the primary
 * target, in scale, so it works in landscape too" true rather than hopeful.
 */
const REFERENCE_VIEWPORT = new Vector2(393, 852);

/**
 * **The box as a fraction of the viewport**: `0.6005` of its width and `0.2277` of its height. **Placeholder.**
 *
 * **This is what makes the cluster the same shape on every phone.** A fraction rather than a pixel count is the
 * only thing that behaves, because it is the only form in which "this much of the screen" survives a screen
 * change: divided by {@link REFERENCE_VIEWPORT} and multiplied back out by the fit, the box covers the same part
 * of every viewport, and {@link pack} turns that into a proportionally bigger or smaller button. See
 * {@link BOX_SIZE} for what the box *is* and {@link scaleFor} for the multiplication.
 *
 * **Where the two numbers come from: `236 ÷ 393` and `194 ÷ 852`** — the reference box, expressed in the only
 * language that scales. They are a **Placeholder** in the sense every first number is, and the thing to tune: a
 * bigger fraction is a bigger cluster, and it is the *only* number that does that. What it cannot fix is the
 * screen: see {@link SCALE_MIN}, where a sideways phone is held at a floor rather than allowed to shrink.
 *
 * **One fraction per axis, and one multiplier for both** — the two are not multiplied together here. A per-axis
 * `UDim2.fromScale` box was the obvious reading of this constant and it is refused for the reason
 * {@link REFERENCE_VIEWPORT} does the arithmetic for: a landscape phone would get a 512 × 90 box and 20px
 * buttons. The box's aspect is a property of the design, so one number scales both axes and this pair only says
 * what the box is at the reference screen.
 */
const BOX_FRACTION = new Vector2(0.6005, 0.2277);

/**
 * The box the five buttons are packed into, at the reference viewport. **Placeholder — `(236, 194)`, which is
 * {@link BOX_FRACTION} written out.**
 *
 * **This is the only number that decides how big the buttons are**, which is the whole point of this shape: a
 * rectangle in the corner, and `pack` derives one button size from it. Bigger box, bigger buttons; nothing else to
 * change. See {@link pack}.
 *
 * **Where the two numbers come from: they are exactly the size at which five buttons come out at 72px** — the size
 * the cluster's toes were last tuned to by hand, so this starts from the size the game had rather than from a
 * guess. `3` across at 72px with a {@link BOX_GAP} of 10 is `3*72 + 2*10 = 236`; two rows of a 72px circle plus a
 * 20px label band is `2*92 + 10 = 194`. What makes them *these* numbers is that derivation; what makes a
 * different box a different button size is that this is the only input.
 *
 * **In reference pixels**, like every size in this file, so the packing stays scale-free: the box is multiplied by
 * the viewport's own fit and `pack` works in whatever unit it is handed. See {@link scaleFor}.
 *
 * **Declared down here rather than up with the other sizes because it is *derived* from
 * {@link REFERENCE_VIEWPORT}** — {@link BOX_FRACTION} times the reference screen. A module-level `const` that
 * reads one declared below it would read `nil` and take the whole controller down at require time, which is the
 * trap this codebase has recorded from the other direction (`HANDOFF.md`'s hoisted-initializer note); file order
 * is the only thing that fixes it, so the derivation lives beside its input. The two constants are one fact
 * written twice and the fraction is the live copy — this one exists so that `pack`, the debug line and the log a
 * person reads are all in the same units as the design's own numbers.
 */
const BOX_SIZE = new Vector2(
	REFERENCE_VIEWPORT.X * BOX_FRACTION.X,
	REFERENCE_VIEWPORT.Y * BOX_FRACTION.Y,
);

/**
 * The smallest the cluster is ever *drawn*, as a fraction of the reference layout. **Placeholder — 0.85.**
 *
 * **A floor and no ceiling, and losing the ceiling is this pass's change.** The cap that used to be here (`1.15`)
 * belonged to the old shape: five toes on an arc are a fixed figure at a fixed radius, so a tablet's 2×
 * multiplier turned them into five dinner plates and the cap was the only thing between the design and a
 * nonsensical screen. **A box packed as a fraction of the viewport has no such failure** — a bigger screen gets a
 * bigger box and proportionally bigger buttons, which is the definition of the thing being asked for — so the
 * cluster now keeps scaling on the screens it used to stop on. Where it used to stop is worth stating plainly,
 * because it is the only place this constant's cap ever did anything: the fit is above `1.15` only past roughly
 * **452 × 980**, so every phone was already proportional and only a tablet was capped.
 *
 * **The floor is still needed, and it is not {@link TAP_MIN} under another name.** The multiplier is the *fit* —
 * the smaller of the two axis ratios against {@link REFERENCE_VIEWPORT} — and a phone held sideways fits at about
 * `0.46`, which is a 33px button: below the tap floor, so `pack` would raise it to 44 and the two rows would then
 * overlap each other *and* spill out of the bottom of the box. Holding the layout at `0.85` keeps a sideways
 * phone at 58px buttons that still fit, which is the cheaper failure by a wide margin.
 *
 * **Where `0.85` comes from: it is comfortably above the point where the packing stops fitting**, and that point
 * is arithmetic rather than taste. A row of buttons has `(194m − 10m)/2 − 20` pixels each, which reaches
 * `TAP_MIN`'s `44` only at `m ≈ 0.7` — below that `pack` is no longer fitting anything and the rows overlap the
 * box. `0.85` is the first round number above that edge.
 */
const SCALE_MIN = 0.85;

/**
 * **That scale, as a function of the viewport** — pulled out of {@link buildScale} so the cluster's own arithmetic
 * and the thing that watches for a new viewport ask the same question. **Two copies of this expression would be
 * two answers to one question**, and the one that went stale would be the one nobody was looking at.
 *
 * It is what turns {@link BOX_SIZE} and {@link PAD_SIZE} from reference pixels into the pixels this screen
 * actually has — so the box's size, every button's size and the pad's size all come from this one number, which is
 * the whole of why a bigger phone gets a bigger cluster rather than the same cluster with more empty screen around
 * it. See {@link pack} for everything that follows from the box, and {@link restyleEngineJump} for the pad.
 *
 * **Clamped at the bottom only** — {@link SCALE_MIN} — which is why this is a `math.max` around the fit rather
 * than the `math.clamp` it used to be: there is no longer a ceiling to express. See that constant for why the
 * floor is not optional, and for the arithmetic that says where the packing stops fitting without it.
 */
function scaleFor(viewport: Vector2): number {
	return math.max(
		math.min(viewport.X / REFERENCE_VIEWPORT.X, viewport.Y / REFERENCE_VIEWPORT.Y),
		SCALE_MIN,
	);
}

/**
 * **One button size from one box: the whole of this cluster's layout, as a pure function.**
 *
 * Handed the *row counts* — `[3, 2]` today, and `[5]` or `[1, 1, 1, 1, 1]` are the same call — plus the box it has
 * to fit, the gap between buttons and the band each row's label needs, and it returns where every button goes and
 * how big it is. **Nothing here reads the screen, the engine's button or the scale**, which is why it can be
 * reasoned about on paper — and why the box is the only knob: a bigger box means bigger buttons, because this is
 * the only line that decides.
 *
 * **The size is the smaller of the two bounds the box imposes**: how much width a full row has per button, and how
 * much height a row has per button once every row's label band is taken out. **Every button gets the same size,
 * including the throw** — and that is this arrangement's whole trade, deliberately: four passes of making the
 * primary action bigger produced arcs that had to stretch to survive it. **The pattern is the shape here, not the
 * sizes.**
 *
 * **The short row is centred by construction** rather than by a special case: a row with fewer buttons than the
 * widest one starts half of the difference in, so `[3, 2]` puts its two buttons under the *gaps* of the row above
 * — the pattern the brief drew — and `[5]` simply centres against nothing. That is the reason the pattern is an
 * array of row counts rather than a flag: changing `[3, 2]` to `[5]` is one number, and every formula below reads
 * that array rather than assuming it.
 *
 * `x` and `y` are each button's **centre**, in the box's own coordinates from its top-left. See {@link mount} for
 * where the box is, and {@link TAP_MIN} for what happens when the answer is too small to tap.
 */
function pack(
	rows: number[],
	box: Vector2,
	gap: number,
	labelBand: number,
): Array<{ x: number; y: number; size: number }> {
	let columns = 0;
	for (const count of rows) columns = math.max(columns, count);

	const across = (box.X - (columns - 1) * gap) / columns;
	const down = (box.Y - (rows.size() - 1) * gap) / rows.size() - labelBand;

	// **The floor is applied here rather than checked here.** A box too small for a thumb target is a box the
	// layout grows out of — see {@link TAP_MIN} — and what the caller gets is a size that is always tappable and
	// positions that are always the same gap apart, which is the pair of properties worth keeping.
	const size = math.max(math.min(across, down), TAP_MIN);

	const cells: Array<{ x: number; y: number; size: number }> = [];

	for (let row = 0; row < rows.size(); row++) {
		const count = rows[row];
		const inset = ((columns - count) * (size + gap)) / 2;

		for (let column = 0; column < count; column++) {
			cells.push({
				x: inset + column * (size + gap) + size / 2,
				// The pitch is the circle *plus its label* plus the gap, because the label hangs inside the row.
				y: row * (size + gap + labelBand) + size / 2,
				size,
			});
		}
	}

	return cells;
}

/**
 * How far the movement stick has to be pushed to start and to stop sprinting. **Placeholder.**
 *
 * **Two numbers rather than one, and that is the whole of the design.** A single threshold is a line the stick
 * sits *on* when a thumb holds it there: the engine's thumbstick jitters by a little at rest and by more under a
 * thumb, so one `>= 0.75` test would start and stop the sprint several times a second while the player is doing
 * one thing — and every flip is a `setSprinting` request to the server, which is the expensive half. **The gap
 * between the two is the hysteresis**: it takes a deliberate push to start and a deliberate easing-off to stop,
 * and the `0.15` between them is the room the thumb's own noise lives in.
 *
 * **Where the numbers come from: a thumbstick's own range, and the word "far" rather than "at the wall".** The
 * magnitude is `0` at rest and `1` at the rim, so `0.75` is three quarters of the way out — the deliberate push the
 * requirement actually names — and `0.6` is "eased off, but not back to a walk". **`0.85` was the first value here
 * and it asks for more than "far"**: on a 70px stick that is 30px of a 35px radius, a thumb pressed against the
 * inside of the ring rather than one moved across it, and a threshold that demands the last sixth of the travel is
 * one a player can fail while believing they pushed it all the way. Both values are **Placeholders** to be moved
 * once a real thumb has been on them; see {@link watchStick} for the loop that reads them and for the line that
 * prints how far this device's stick actually reaches.
 *
 * **And what the numbers *mean* depends on the device's touch mode, which is a fact about somebody else's module.**
 * The engine's own control module computes the move vector differently per mode, and only one of the four produces
 * a number these thresholds can be applied to honestly:
 *
 * - **Thumbstick** (the engine's default): the module divides the thumb's offset by the stick's radius and scales
 *   the result from a `0.05` dead zone out to `1` at the rim. Analog, and exactly what this design assumes.
 * - **Dynamic thumbstick**: the same shape, but the scale saturates after about `20px` of finger travel — `1.0`
 *   arrives roughly a third of the way out, so `0.75` is met by any firm push and the sprint becomes "moving".
 * - **Thumbpad** and **DPad**: the module ends its arithmetic with `.Unit`. The vector is a *direction* and the
 *   magnitude is `1` whenever the pad is off centre, at any pressure, so **no threshold in this file can express
 *   "pushed to the rim"** on those modes — the honest reading of the design there is "sprint while moving", which
 *   is a decision for the player-facing design and not for these two constants to fake.
 *
 * **Which is why the loop names the crossing and the reach**: a session's log is the only thing that says which of
 * those three behaviours this client is in, and it says it without a round trip. See {@link watchStick}.
 */
const SPRINT_START_MAGNITUDE = 0.75;
const SPRINT_STOP_MAGNITUDE = 0.6;

/**
 * How long {@link findStick} waits for the engine's own control module before giving up on the sprint, in seconds.
 *
 * **Not a tuning value, which is why it is not marked as one.** It is the patience of a lookup, and the only thing
 * it affects is how long this controller holds a task open at mount. Ten seconds is generous for something the
 * engine's own scripts create during boot — the point is that the wait *ends*, and that a client whose module
 * never arrives gets one log line and no sprint rather than a task that lives as long as the session does.
 */
const STICK_WAIT_SECONDS = 10;

/**
 * **The names the engine's movement module has shipped under, newest first.** See {@link findMoveModule}.
 *
 * **Two names because there are two layouts of the same scripts, and this file was written against only one of
 * them.** The modern client puts a `ModuleScript` called `PlayerModule` directly in `PlayerScripts`; the older one
 * puts `ControlScript` and `CameraScript` there instead, with the movement code in `ControlScript.MasterControl`
 * and **no `PlayerModule` anywhere in the tree**. Both answer `GetMoveVector` — the walk, the jump and the touch
 * stick all work identically — so a client on the older layout is not broken in any way a player could see. It is
 * only a client this file's lookup used to miss, silently, with the sprint as the whole of the symptom.
 *
 * **The order is the order of likelihood, not of preference**: whichever of these exists first and is a
 * `ModuleScript` is the answer, and the search is recursive — the same rule this codebase applies to place files,
 * and for the same reason. The shape belongs to somebody else and it moves; a path is a guess, a search is not.
 */
const STICK_MODULE_NAMES = ["PlayerModule", "MasterControl"];

/**
 * **How many times the stick's growing reach may be printed in one session.** See {@link watchStick}.
 *
 * **A cap rather than a tuning value**, and it is the difference between an instrument and a flood. The line it
 * bounds prints only when the peak *rises*, a tenth at a time, so a session in which a thumb is pushed to the rim
 * and back prints five or six of them — the envelope of how far this player actually pushes the stick, which is the
 * answer to "is the threshold reachable here". The cap is for the pathological case it cannot rule out: a stick
 * whose reading creeps upward a hundredth at a time would otherwise print for the rest of the session.
 */
const STICK_PEAK_LIMIT = 12;

/**
 * **The engine's movement module, found by name anywhere under `PlayerScripts` — or `undefined`.**
 *
 * A hoisted function rather than a method, because it is a question about somebody else's tree and has nothing of
 * this controller in it: two candidate names, the first one that exists *and* is a `ModuleScript` wins, and the
 * recursive flag is the whole of the correction to this lookup's first version — see {@link STICK_MODULE_NAMES}.
 */
function findMoveModule(playerScripts: Instance): ModuleScript | undefined {
	for (const name of STICK_MODULE_NAMES) {
		const found = playerScripts.FindFirstChild(name, true);

		if (found !== undefined && found.IsA("ModuleScript")) return found;
	}

	return undefined;
}

/**
 * **The movement stick as the engine's own touch module draws it: a frame, and the thumb inside it.**
 *
 * Both names are the engine's, not this file's: the default touch movement mode creates
 * `TouchControlFrame.ThumbstickFrame` with a `StickImage` in it, and the thumb is moved to
 * `relativePosition + StickImage.AbsoluteSize/2` from the frame's top-left — which is an `AnchorPoint` of `(0, 0)`,
 * a top-left placement. See {@link stickPointReader} for the arithmetic that makes those two worth having.
 *
 * **The dynamic thumbstick and the thumbpad are deliberately not named here.** The dynamic one moves its thumb
 * against a radius it never draws (`RadiusOfMaxSpeed`, 20px, doubled on a large screen), so its GUI cannot say
 * what "all the way out" means; the thumbpad has no thumb at all — it slides the whole pad under the finger. Both
 * are left to the module route rather than guessed at, which is the difference between a fallback and a fib.
 */
const STICK_FRAME_NAME = "ThumbstickFrame";
const STICK_THUMB_NAME = "StickImage";

/**
 * **How far the stick's thumb is from the stick's centre, as a fraction of the stick's radius — the same number
 * the engine computes for `GetMoveVector`.**
 *
 * The engine's own `TouchThumbstick.DoMove` is `currentMoveVector = direction / (thumbstickSize / 2)`, where
 * `direction` is the finger's offset from the stick's centre and `thumbstickSize` is the frame's width — and the
 * thumb is then drawn at exactly that offset, clamped to the rim. So this reads the module's own input back out of
 * the two instances it drew it with, and the only thing it leaves out is the module's `0.05` dead zone, which no
 * threshold in this file ever goes near. **That is a reading, not an imitation**: nothing here re-derives the
 * gesture, it measures the picture the engine made of the gesture.
 *
 * **Why it is worth a second route at all.** The module route is one untyped `require` of somebody else's tree and
 * it *failed on a real client* — ten seconds of waiting, then no sprint at all — while the same client's jump
 * button was being read out of the same GUI by name, without complaint. Reading the stick the way the jump button
 * is read needs no module, no `require`, and no assumption about which of Roblox's two layouts is installed. See
 * {@link findStick}, which prefers this route and falls back to the module.
 *
 * **`clamp` is not decoration.** The fixed stick clamps its thumb inside the frame, so the fraction cannot exceed
 * `1` — but a frame mid-layout (a rotation, a device change) can briefly report a size of zero, and a division by
 * that would be an infinity the thresholds would read as a sprint. Zero is the honest answer for a stick with no
 * size, and it is also the answer that fails quietly.
 */
function stickPointReader(stick: GuiObject, thumb: GuiObject): () => number {
	return () => {
		const radius = stick.AbsoluteSize.X / 2;
		if (radius <= 0) return 0;

		// Both centres by hand rather than through `AbsolutePosition` alone, because both instances are placed by
		// their top-left corner: the frame's `AnchorPoint` is `(0, 0)` and the module writes the thumb as an offset
		// from it. See {@link STICK_FRAME_NAME}.
		const stickCentre = stick.AbsolutePosition.add(
			new Vector2(stick.AbsoluteSize.X / 2, stick.AbsoluteSize.Y / 2),
		);
		const thumbCentre = thumb.AbsolutePosition.add(
			new Vector2(thumb.AbsoluteSize.X / 2, thumb.AbsoluteSize.Y / 2),
		);

		return math.clamp(thumbCentre.sub(stickCentre).Magnitude / radius, 0, 1);
	};
}

/**
 * **The stick, found in the touch GUI and returned as a reader — or `undefined` if this client does not have that
 * shape of stick.** See {@link STICK_FRAME_NAME} and {@link stickPointReader}.
 *
 * **Found by waiting for `TouchGui` and then searching it, rather than by waiting for the stick itself.** The GUI
 * is created once, early, and holds every touch control the engine has; the stick inside it is created and
 * destroyed as the movement mode changes, so waiting for the *right* child is a wait that can time out on a client
 * that is working perfectly. The same reason the jump button is hunted rather than waited for.
 *
 * **Only a visible stick counts.** The control module builds the frames of all four touch modes at once and hides
 * the ones not in use (see Roblox's own `ControlScript`), so an invisible `ThumbstickFrame` parked at its rest
 * position would read as a permanently centred stick — the worst kind of wrong answer, because it looks like the
 * player never pushes the stick rather than like a failed lookup.
 *
 * **And it is looked for again rather than looked at once, because "visible" arrives after "exists".** The module's
 * `Create` builds the frame hidden and its `Enable` is what shows it, so a single look can catch a perfectly
 * healthy client in the moment between the two — the frame is there, this route rejects it for being invisible,
 * and the whole hunt falls through to a route that may be reading nothing at all. See the loop below, which is
 * where that patience lives and why it is bounded.
 */
function findStickPoint(playerGui: PlayerGui): (() => number) | undefined {
	const touch = playerGui.WaitForChild("TouchGui", STICK_WAIT_SECONDS);
	if (touch === undefined) return undefined;

	// Ten looks a second for the same patience the module route's `WaitForChild` is given, so the whole hunt is
	// bounded by two waits rather than by one wait and one guess. **The alternative — accepting an invisible stick —
	// is the one thing this must not do**: a hidden frame sits at rest for the whole session, and a stick that reads
	// `0.00` for ever looks exactly like a player who never pushes it.
	for (let waited = 0; waited < STICK_WAIT_SECONDS * 10; waited++) {
		const stick = touch.FindFirstChild(STICK_FRAME_NAME, true);

		if (stick !== undefined && stick.IsA("GuiObject") && stick.Visible) {
			const thumb = stick.FindFirstChild(STICK_THUMB_NAME, true);

			if (thumb !== undefined && thumb.IsA("GuiObject")) return stickPointReader(stick, thumb);
		}

		task.wait(0.1);
	}

	return undefined;
}

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
 * One button: what it says and what it does. **Where it goes and how big it is are not in here at all.**
 *
 * **The cluster is a table of these, which is what makes the controls one edit.** Nothing in the layout code knows
 * what a catch is or that a throw is held — it places circles and words — so adding a control, or changing what
 * one does, is a change to the table rather than to any of the drawing.
 *
 * **Nothing here is sized, which is the fourth arrangement's central decision.** The three arc passes each gave
 * the table a `size` per control, because the geometry had to balance against whatever the engine's jump button
 * turned out to be; a table carrying sizes is a table that gets re-tuned whenever that geometry moves. `pack` now
 * gives every button the same size, computed from the box, so a size in here would be a second opinion about the
 * one number this cluster is allowed to have.
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

	/** What the press does. Called once per press, and never twice without a release between them. */
	readonly down: () => void;

	/** What the release does, for the control that is held rather than tapped. */
	readonly up?: () => void;
}

/**
 * **What a press becomes while {@link ARRANGE} is on: three calls, and the box does the moving.**
 *
 * **A hook rather than the flag read inside `buildButton`**, so a button stays what it has always been — a circle,
 * a word and a press — and the only thing that knows about dragging is the code that owns the box's position. When
 * arrange mode is off the hook is `undefined` and every line of it is dead: the buttons behave exactly as they did
 * before this existed. **One instance is shared by all five**, because the thing that moves is the box and not the
 * button the finger happened to land on. See {@link mount}, which builds it.
 *
 * **Declared as function-typed *properties* rather than as methods**, which is this codebase's own trap recorded
 * twice: roblox-ts refuses an arrow function where an interface declares a method, and it compiles a method call
 * to a colon call — right for the engine's Lua tables, wrong for a table this file builds itself.
 *
 * **Screen pixels in, reference pixels out.** The pointer arrives in screen coordinates (`InputObject.Position`)
 * and the nudge is stored in reference pixels like every other size here, so the division by the viewport
 * multiplier happens in the hook — the one place that has both units at once.
 */
interface ArrangeHook {
	/** A finger landed on this button at `screenPoint`: this is what the drag is measured from. */
	grab: (screenPoint: Vector2) => void;

	/** The finger is now at `screenPoint`, which is how far the box has been moved from where it already was. */
	move: (screenPoint: Vector2) => void;

	/** The finger came off, which is when the numbers are worth printing. */
	done: () => void;
}

/**
 * Where the engine's jump button is and how big it is — **three readings off somebody else's instance, kept live.**
 *
 * **Everything the cluster is positioned from comes from here**, which is why it is a record rather than the
 * single number this file's first column asked for: the box is placed against the pad's **top edge**, and that is
 * a corner plus half a size — where the column that started this file wanted only the edge itself. It is also
 * where the pad's *rendered* size comes from, which is the number a person compares the buttons beside it against.
 *
 * **Values rather than numbers, because the engine moves this button.** A rotation or a viewport change re-lays
 * out the engine's own touch GUI, and both readings are re-taken from the signals the restyle already watches — so
 * the box follows the pad rather than being right at mount and wrong after the first rotation.
 *
 * **`size` is one number and not a `Vector2`**, deliberately: it is a *reading for a person* rather than a
 * clearance to compute with — "the pad rendered at 78px" is a sentence and the pair of axes is not — and the one
 * place a clearance is wanted is `measure`, which takes the larger axis because the engine's button is not
 * guaranteed square. See `measure` for that `math.max` and for why nothing is placed *inside* the pad any more.
 *
 * **`found` is separate from the other two rather than a nil centre**, so that the box can be built once and stay
 * invisible until there is something for it to sit above. See {@link mount}: the engine creates this button about
 * a second and a half after the client ignites, and a box placed at `(0, 0)` is the top-left corner of the screen.
 */
interface JumpGeometry {
	/** The button's centre, in screen pixels from the top-left of the screen. */
	readonly centre: Fusion.Value<Vector2>;

	/**
	 * The button's larger axis **as it is actually rendered** — after the shrink *and* the viewport multiplier,
	 * see {@link PAD_SIZE} — in screen pixels. It is the size a person sees when they compare the pad with the
	 * buttons beside it, which is what everything reads it for; the box's derivation measures from the opposite
	 * corner and cancels this number out of its own arithmetic, so nothing here can feed back into what is drawn.
	 * See `measure` in {@link restyleEngineJump}.
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
 * The mobile controls: **a box of five buttons packed into the bottom-right corner, sitting above the engine's own
 * jump button.**
 *
 * **The cluster is a box of five buttons in the corner, packed by one formula, and that is the fourth shape.** The
 * first three were arrangements of the *same* idea — place each button relative to the engine's jump button — and
 * each one failed in the same direction: the buttons had to be small, because the pad they were arranged around is
 * never the size anybody assumed, and the geometry that avoided overlapping it kept stretching. The paw was the
 * clearest version of that: a correct derivation of a shape that could not fit a phone.
 *
 * **So this one stops deriving and starts packing.** The five buttons live in a fixed rectangle in the bottom-right
 * corner, and `{@link pack}` computes one size for all five from the box's dimensions — three across the top, two
 * centred underneath. **The box's size is the only thing that decides how big a button is**, so tuning is one
 * number rather than a rebuild-and-look, which is the complaint that killed the last three arrangements.
 *
 * **What the pad is still for, and it is exactly one thing: the box sits above it.** The engine's button is where a
 * thumb rests, so the box's bottom edge is its top edge plus a gap — see {@link BOX_PAD_GAP} for why that could not
 * be a fixed margin. Beyond that the two are neighbours rather than a system, which is the whole of what changed:
 * **no bearings, no radius, no arc, and no drag tool for finding numbers by hand.**
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
 * read as part of this cluster rather than as somebody else's instance that happens to be nearby — and since this
 * pass it is drawn at the same rate as the five beside it, so the resemblance is a size as well as a shape. See
 * {@link PAD_SIZE}.
 *
 * **Every size here is in reference pixels and everything multiplies itself by one multiplier.** See
 * {@link buildScale}: 393-wide portrait is the phone the numbers were drawn against, and a rotation, a wider
 * phone or a tablet is the same layout at a different multiplier. **That is why this HUD does not carry an
 * `addViewportConstraint`** like every other one — the sizes here are a function of the viewport rather than
 * values that need clamping against it, and a pixel `UISizeConstraint` under a `UIScale` would be measuring the
 * size before the multiplier, which is a cap that fires at the wrong number or never.
 *
 * **The engine's button is inside that multiplier now, and that is this pass's change.** It used to be the one
 * thing here outside it: its size is the module's, so it was shrunk by a `UIScale` of its own toward the fixed
 * {@link PAD_SIZE} and left there — which made a bigger screen a bigger box beside the *same* 72px pad. And the
 * pad cannot scale itself: the module draws it at 70px or 120px, two constants picked once from the screen's
 * short axis rather than a proportion. So the pad's `UIScale` carries the cluster's multiplier as well as its own
 * shrink, and the box, its buttons and the pad are now one scale with one floor. See {@link restyleEngineJump}.
 *
 * **What is deliberately not here.** No icons (the space is reserved inside each circle and the art is a later
 * change to one line), no power button (the ability HUD's slot is what asks for the power, and the throw that
 * follows is what spends it — see `SuperHudController`), no duck and no aim (neither has a mobile equivalent
 * that is a button), **no sprint button any more** — the stick is the sprint, and a sixth circle for it would be
 * a control the player's other thumb is already holding — and no change to any desktop control: the keys, the
 * binds and the legend are exactly as they were.
 *
 * **Mounted into `getScreenSpaceGui` rather than the shared HUD `ScreenGui`, and the engine's button forces
 * that.** Every other HUD here mounts into the shared GUI, which is inset inside Roblox's topbar so that its
 * contents sit in the safe area; this box cannot, because its bottom edge is derived from the engine's button's
 * `AbsolutePosition` — a *screen* coordinate, measured from the top-left of the screen — and an inset GUI has a
 * different origin. The aim
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

		// **The five controls, and this is only what each one says and does.** Where they sit is {@link pack}'s
		// business now, and this list's order is the order they fill the box — left to right, top row first, which is
		// the order the pattern below is written in:
		//
		//                          [Throw]  [Catch]  [Curve]
		//                             [Dodge]  [Drop]
		//
		// **`Throw` leads because it is the primary action** and the box's top-left is the corner a right thumb
		// reaches first. **No control carries a size any more** — one box, one derived button size, every button the
		// same — which is the simplification this arrangement exists for. See {@link pack}.
		const curve: TouchControl = { label: "Curve", down: () => this.throwController.toggleCurve() };
		const throwBall: TouchControl = {
			label: "Throw",
			// **The hold and the release, which is the same pair the mouse button produces.** `beginHold` answers
			// whether there was a ball to charge; the answer is dropped here rather than branched on, because a
			// press that threw nothing has to look exactly like any other press — the visual state of a button is
			// about the finger on it, not about what the game did with the press. See `buildButton`.
			down: () => this.throwController.beginHold(),
			up: () => this.throwController.endHold(),
		};
		const catchBall: TouchControl = { label: "Catch", down: () => this.catchController.press() };
		// **The dodge's direction is the stick's**, which is the one place this cluster makes a decision the
		// keyboard did not have to: there are no movement keys to read, so the body is asked where it is going.
		// See `DodgeController.push` for the read and for why a centred stick refuses rather than guesses.
		const dodge: TouchControl = { label: "Dodge", down: () => this.dodgeController.push() };
		const drop: TouchControl = { label: "Drop", down: () => this.actionController.drop() };

		const controls: TouchControl[] = [throwBall, catchBall, curve, dodge, drop];

		/**
		 * **The packing pattern, which is the whole description of the shape.** Three across the top and two centred
		 * underneath; `[5]` would be one row, `[1, 1, 1, 1, 1]` a column, and nothing else in this file changes.
		 *
		 * **It has to total the five controls**, and the two are checked against each other after the packing rather
		 * than trusted: `pack` counts cells from this array and knows nothing about buttons, so a pattern of `[3, 1]`
		 * would quietly leave one control unbuilt.
		 */
		const rows: number[] = [3, 2];

		// **The one responsive number on this HUD, and it is built *before* the pad rather than after it**: every
		// size below is written in reference pixels and this turns them into the pixels this screen actually has —
		// and the pad needs it too, because the engine's button is now inside the cluster's multiplier rather than
		// beside it. The order is load-bearing rather than tidy: `restyleEngineJump` measures the button during its
		// own sweep, and a `const` read before its initializer has run is the nil-at-load trap this file's constant
		// block describes, one frame smaller. See {@link buildScale} for the signal it watches.
		const scale = this.buildScale(scope);

		// **The engine's jump button is restyled rather than replaced, and it is what the box sits above.** What
		// comes back is its centre and its size in screen pixels — or nothing until it exists — and the *only* thing
		// this cluster still takes *from it* is the top edge. It is also the second reader of the multiplier above,
		// which is what keeps the pad the same size as the buttons beside it. See {@link restyleEngineJump} for the
		// hunt, the restyle and the reason the jump stopped being ours to draw.
		const jump = this.restyleEngineJump(scope, theme, scale);

		/**
		 * **The hand-move state, which is dead unless {@link ARRANGE} is on — one nudge and the drag's memory.**
		 *
		 * `nudge` holds the same quantity {@link BOX_NUDGE} does, in the same unit, so a drag and a pasted constant
		 * are one number rather than two spellings of it. It starts *at* the constant and **a drag is a delta from
		 * there** — which is what makes switching the mode on a no-op: the cluster does not move until a finger does.
		 *
		 * **The two locals are the drag's own memory**: where the finger started and what the nudge was when it did.
		 * `grabbedAt` being `undefined` is what makes a `move` before a `grab` do nothing — which is what stops an
		 * `InputChanged` from a finger that never landed on a button from sliding the cluster around.
		 */
		const nudge = Fusion.Value(scope, BOX_NUDGE);
		let grabbedAt: Vector2 | undefined;
		let grabbedFrom = Fusion.peek(nudge);

		const arrange: ArrangeHook | undefined = ARRANGE
			? {
					grab: (screenPoint) => {
						grabbedAt = screenPoint;
						grabbedFrom = Fusion.peek(nudge);
					},
					// **A finger dragged 40px down adds 40 to the nudge; dragged right, the same.** That is the whole
					// of the gesture, and it is this short because the constant is signed the way a screen is: the only
					// arithmetic here is the division that turns a screen measurement into a reference one, which is
					// what keeps one drag the same distance *of layout* at every multiplier. **Nothing is clamped and
					// nothing is written back**, so the box can be taken off the screen while a finger is down and the
					// derivation puts it straight back the moment this mode is switched off. See {@link BOX_NUDGE}.
					move: (screenPoint) => {
						const from = grabbedAt;
						if (from === undefined) return;

						const multiplier = Fusion.peek(scale);
						const across = (screenPoint.X - from.X) / multiplier;
						const down = (screenPoint.Y - from.Y) / multiplier;

						nudge.set(new Vector2(grabbedFrom.X + across, grabbedFrom.Y + down));
					},
					done: () => {
						grabbedAt = undefined;

						const placed = Fusion.peek(nudge);

						// **The number is the deliverable**, so it is printed in the exact form the constant wants:
						// two numbers and the name to put them under. `%.0f` because a dragged value is a float nobody
						// wants to read or paste, and a whole reference pixel is finer than a finger has ever been.
						print(
							`[HUD] the cluster's nudge — BOX_NUDGE = new Vector2(${string.format("%.0f", placed.X)}, ` +
								`${string.format("%.0f", placed.Y)}) reference px (X right, Y down)`,
						);
					},
				}
			: undefined;

		/**
		 * **The box's size in screen pixels — the number the button size is derived from, and the only one.**
		 *
		 * {@link BOX_SIZE} times the multiplier, which is the same statement as {@link BOX_FRACTION} of the
		 * viewport: the reference box *is* that fraction, written in the pixels of the phone the design was drawn
		 * against. **So this is where the cluster's proportion comes from** — a bigger screen multiplies this up,
		 * `pack` turns it into a bigger button, and nothing else in the file has to know the screen changed.
		 *
		 * Then **capped at the room above the pad**: on a phone held sideways the pad can sit half way up a
		 * 393-tall viewport, and a box that ran off the top of the screen would put its top row where no thumb can
		 * reach. Capping the number `pack` is handed is the self-consistent way for that to fail — the buttons come
		 * out smaller — where a `UISizeConstraint` on the frame would clamp the rendered size *after* the packing
		 * had been worked out for the bigger one, and the buttons would overlap instead.
		 */
		const boxSize = Fusion.Computed(scope, (use) => {
			const multiplier = use(scale);
			const centre = use(jump.centre);
			const padSize = use(jump.size);
			const room = centre.Y - padSize / 2 - BOX_PAD_GAP * multiplier;

			return new Vector2(BOX_SIZE.X * multiplier, math.min(BOX_SIZE.Y * multiplier, room));
		});

		/**
		 * The box itself: **a plain frame in the bottom-right corner whose size is the layout.**
		 *
		 * **Its bottom edge is derived from the engine's button rather than from the screen's edge**, which is the
		 * one thing this design could not take from a corner offset: the pad sits 90px off the floor on one of this
		 * project's logged devices and 210px on another, so a fixed bottom margin either overlaps the pad or floats
		 * the box into the middle of the screen. The pad's top edge, a {@link BOX_PAD_GAP} above it, is right on both
		 * — **and that edge is a distance *down* from the screen's top, not up from its bottom**, which is why the
		 * `Position` below spells its two axes differently. See the note there for what mixing them cost.
		 *
		 * **The right edge is the one screen edge it names** ({@link BOX_EDGE_GAP}); the other two come from the
		 * size. **No layout instance goes inside it** — the buttons' positions are written by `pack` — and it has no
		 * background, because it is a footprint rather than a surface.
		 *
		 * **And {@link BOX_NUDGE} moves the whole thing by hand**, which is the only way below the pad's top edge. See
		 * that constant for what it costs and {@link ARRANGE} for finding the number with a finger.
		 */
		const box = Fusion.New(scope, "Frame")({
			Name: "MobileControls",
			Size: Fusion.Computed(scope, (use) => {
				const size = use(boxSize);

				return UDim2.fromOffset(size.X, size.Y);
			}),
			BackgroundTransparency: 1,
			AnchorPoint: new Vector2(1, 1),
			Position: Fusion.Computed(scope, (use) => {
				// **Every `use` sits above the branch, unconditionally** — a `use()` after an early return is a
				// subscription that exists only while that branch is taken, which this codebase has been bitten by
				// before (`RoundStatusController`'s winner). Branching after them costs one spare subscription while
				// the derived path is live, which is the cheaper of the two mistakes.
				const multiplier = use(scale);
				const centre = use(jump.centre);
				const padSize = use(jump.size);
				const hand = use(nudge);

				// **The pad's top edge, in the axis it actually arrives in.** `centre` is built from an
				// `AbsolutePosition`, so `centre.Y − padSize/2` is a distance *down from the screen's top edge* — and
				// the box's bottom edge goes a gap above that, which is a **scale-0 Y**: an offset from the parent's
				// *top*. `X` stays a scale-1 offset from the parent's right edge, so the two axes of this `UDim2` are
				// deliberately spelled differently. That is the whole of the position; {@link BOX_NUDGE} is added to
				// both afterwards, in reference pixels like every other size here.
				//
				// **And the bug that shape replaces is worth keeping written down, because it was invisible from the
				// code alone.** This line used to read `UDim2.new(1, -BOX_EDGE_GAP * multiplier, 1, -(padTop + gap))`
				// — the *same* pad number, spent as a scale-1 offset from the parent's **bottom** instead of a scale-0
				// offset from its top. On the reference phone the pad's top edge is 642px down an 852-tall screen, so
				// that expression put the box's bottom edge **650px above the floor**: the cluster was drawn mirrored
				// about the screen's midline, in the top-right corner, 440px from the pad it was supposed to sit above.
				// **Two different edges, one number** — the same mistake this corner made in its first version, and
				// the reason the sentence above states which edge the number is measured from.
				const padTop = centre.Y - padSize / 2;
				const bottomEdge = padTop - BOX_PAD_GAP * multiplier + hand.Y * multiplier;

				return new UDim2(1, -(BOX_EDGE_GAP - hand.X) * multiplier, 0, bottomEdge);
			}),
			// **Drawn unconditionally while the hand-move mode is on**, so the cluster can be placed on a client the
			// engine's button never appears on — a desktop emulator with no touch GUI is that case, and it is exactly
			// the client somebody would tune a layout on. Otherwise it waits for the pad, because until then the pad's
			// top edge reads `0` and the box would be drawn across the bottom of the screen. See
			// {@link restyleEngineJump}.
			Visible: Fusion.Computed(scope, (use) => ARRANGE || use(jump.found)),
		});

		box.Parent = getScreenSpaceGui();

		/**
		 * **The packing, recomputed whenever the box or the scale moves.**
		 *
		 * `pack` is handed the *drawn* box, the gap in the same units, and the label band — which is **not** scaled,
		 * because the text is a fixed 12px in this design and so is the room it needs. **The line height is read
		 * from the theme rather than written down**: {@link LABEL_BAND} is only the default its own doc quotes.
		 *
		 * **A `Computed` rather than a call**, because the box's size is itself reactive: this is the value every
		 * button subscribes to, and each one reads its own entry out of the array. See `buildButton`.
		 */
		const cells = Fusion.Computed(scope, (use) => {
			const size = use(boxSize);

			return pack(rows, size, BOX_GAP * use(scale), LABEL_GAP + theme.typography.caption.lineHeight);
		});

		// **The pattern is checked against the controls before anything is built**, and the check is static: both
		// the row counts and the control list are constants, so a pattern that does not total five is a mistake to
		// report rather than a shape to draw. `pack` counts cells from `rows` and knows nothing about buttons, and a
		// pattern of `[3, 1]` would quietly leave one control unbuilt — which reads as a button that does nothing.
		let patterned = 0;
		for (const count of rows) patterned += count;

		if (patterned !== controls.size()) {
			warn(`[HUD] the pattern ${rows.join("+")} packs ${patterned} cells for ${controls.size()} controls`);
		}

		for (let index = 0; index < controls.size(); index++) {
			this.buildButton(scope, theme, controls[index], cells, index, arrange).Parent = box;
		}

		// **The hand-move mode announces itself**, because a cluster that does not answer a tap is otherwise
		// indistinguishable from a broken one — and the log is where a person looks first. See {@link ARRANGE}.
		if (DEBUG && ARRANGE) {
			print("[HUD] arrange mode is on — drag the cluster; the nudge it prints goes into BOX_NUDGE");
		}

		// **The sprint, which is not a button on this HUD and never was one of the five.** Spawned rather than run
		// here because resolving the module it reads can wait on the engine; see {@link watchStick}.
		task.spawn(() => this.watchStick(scope));

		/**
		 * **The numbers rather than the shape, because a shape cannot be argued with from a log.** The button size
		 * and the box it came out of are the two numbers this arrangement is judged on and both are derived — so
		 * printing them makes "the buttons are too small" a one-number answer instead of a re-derivation. They are
		 * printed at the **reference** box (`BOX_SIZE` at scale 1) rather than at the live one, because the box's
		 * size is a `Computed` and this line runs once: the live numbers move with the viewport, and what a log
		 * needs is the size the design produces on the phone this file is drawn against. See {@link TAP_MIN} for
		 * the size the floor would replace it with on a screen too small to hold the box.
		 *
		 * **The fraction is printed beside the reference box, because the fraction is the half that scales**: the
		 * pixel pair says what the design produces at 393 × 852, and the two fractions say what it produces
		 * anywhere — 0.6005 and 0.2277 of the screen, whatever the screen is.
		 *
		 * **And the live button size is no longer printed with them, which is a correction to the first version of
		 * this line.** It read the packing *at mount*, and at mount the engine's button has not appeared yet — so
		 * the box is handed a height that is not merely zero but negative, `pack` answers with its tap floor, and
		 * the line printed `44px on this screen` on a client whose buttons are 58px. **A log that lies about the
		 * one number it exists to report is worse than a short log**, so that figure moved to its own line below,
		 * printed when the pad exists and the number means something.
		 */
		if (DEBUG) {
			const reference = pack(rows, BOX_SIZE, BOX_GAP, LABEL_BAND)[0];

			print(
				`[HUD] mobile controls up — the pack: ${controls.size()} buttons, ` +
					`${string.format("%.0f", reference !== undefined ? reference.size : 0)}px each at the reference ` +
					`box, pattern ${rows.join("+")}, gaps ${BOX_GAP}px, ` +
					`box ${string.format("%.0fx%.0f", BOX_SIZE.X, BOX_SIZE.Y)} reference px ` +
					`(${BOX_FRACTION.X} x ${BOX_FRACTION.Y} of the screen), ` +
					`viewport x${string.format("%.3f", Fusion.peek(scale))}` +
					(reference !== undefined && reference.size <= TAP_MIN ? " — AT THE TAP FLOOR" : ""),
			);
		}

		/**
		 * **This screen's own numbers, printed once the engine's button exists — which is when they exist at all.**
		 *
		 * The box's height is capped by the room above the pad (see `boxSize`), so before the pad appears the
		 * packing is being asked to fit a rectangle that is not there yet. That is a state, not an error — the box
		 * is invisible until the pad exists for exactly this reason — and the honest report of it is "not yet"
		 * rather than a number. **Bounded rather than patient**, because a client whose pad never arrives has no
		 * cluster on screen either, and a task waiting forever for a figure nobody is looking at is the leak this
		 * file's own notes warn about; three seconds is six times longer than the one-and-a-half the engine has
		 * been measured taking.
		 *
		 * **The two lines together are the whole acceptance argument for the scaling**: the line above is what the
		 * design produces at 393 × 852, and this one is what `pack` produced for the viewport in front of you. See
		 * {@link BOX_FRACTION} and {@link scaleFor}.
		 */
		if (DEBUG) {
			task.spawn(() => {
				for (let waited = 0; waited < 30 && !Fusion.peek(jump.found); waited++) task.wait(0.1);

				if (!Fusion.peek(jump.found)) return;

				const live = Fusion.peek(cells)[0];
				const box = Fusion.peek(boxSize);

				print(
					`[HUD] the cluster on this screen — ` +
						`${string.format("%.0f", live !== undefined ? live.size : 0)}px buttons, ` +
						`box ${string.format("%.0fx%.0f", box.X, box.Y)}px, ` +
						`viewport x${string.format("%.3f", Fusion.peek(scale))}` +
						(live !== undefined && live.size <= TAP_MIN ? " — AT THE TAP FLOOR" : ""),
				);
			});
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
	 * **The read: the stick's own thumb first, the engine's movement module second — and the reversal is the
	 * interesting part.** This file's first version read `GetMoveVector` and nothing else, on the argument that the
	 * stick's *child* structure is the ControlModule's own business and that the module's getter is the supported
	 * way to ask. That argument holds right up to the point where the getter is unreachable, which is what the
	 * first real phone log shows: ten seconds of waiting and no sprint, on a client drawing the stick perfectly
	 * well. So the primary read is now the same *kind* of read as the jump button's — the engine's own instance
	 * names, found by search, **measured rather than asked** — and the module is the fallback for the two movement
	 * modes whose geometry cannot be measured. See {@link findStick}, {@link findStickPoint} and
	 * {@link findMoveModule}.
	 *
	 * **`GetControls` and `GetMoveVector` appear **nowhere** in `@rbxts/types` in this build, and `PlayerScripts`
	 * only as a *class*** — `interface PlayerScripts extends Instance` in `include/generated/None.d.ts`, with
	 * `RegisterTouchMovementMode` and its siblings on it, and no `Player.PlayerScripts` member declared beside it, so
	 * reaching the instance is untyped too. **That is a correction to this comment**: the earlier note claimed all
	 * three names were absent, which was read off a search of `include/roblox.d.ts` alone — the generated class
	 * declarations are in `None.d.ts`. So the module route is an untyped hop at every step: a property this build
	 * does not declare, a `require` of a module it has no shape for, and a call named nowhere. Made once, wrapped in
	 * `pcall`, and reported at both ends. Neither route is a `PlayerModule` fork: nothing is overridden, nothing is
	 * replaced, and nothing is asked to behave differently.
	 *
	 * **Two layouts, one question — and this is the correction the first real phone log bought.** That route was
	 * written against `PlayerScripts.PlayerModule` and it timed out: ten seconds and `no PlayerModule` on a client
	 * whose jump button was in the engine's touch GUI the whole time, which is a client running the movement code
	 * perfectly well. Roblox has shipped the same module under two trees, and the older one has no `PlayerModule`
	 * in it at all. See {@link findMoveModule}, which searches for both names rather than trusting a path.
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

		// **The loop's own line, and it is the first thing to look for in a log.** This feature has failed silently
		// twice, in the same way both times: nothing printed, so nothing said which step was missing. A line here
		// means the reader resolved and the stick is being polled; no line means it did not resolve, which is the
		// failure {@link findStick} now names for itself.
		if (DEBUG) print("[Sprint] mobile loop started — reading the stick every frame");

		// **The calibration line, and it is evidence rather than decoration.** It prints the magnitude *now* — at
		// mount, with nobody touching the screen — so a session that sprints in place has the number that explains
		// it, and so does a session where the stick reads `0.5` at rest. A stick that reads anything but `0.00` with
		// nobody touching it is one this loop should never act on, and no other line would say so.
		if (DEBUG) {
			print(
				`[Sprint] mobile — the stick reads ${string.format("%.3f", read())} at rest, ` +
					`so the sprint starts at ${SPRINT_START_MAGNITUDE} and stops at ${SPRINT_STOP_MAGNITUDE}`,
			);
		}

		let sprinting = false;

		// **The reach of the stick, printed as it grows and never as it falls.** The two edge lines below name every
		// crossing; this one answers the question that has no crossing to name — *is the start threshold reachable
		// on this device at all?* A stick that tops out at `0.60` never crosses `0.75` and would be silent
		// otherwise, which is the third way this feature can fail without a trace. Monotone, so a session prints the
		// envelope of the player's pushes — five or six lines — rather than a stream. See {@link STICK_PEAK_LIMIT}.
		let peak = 0;
		let peaks = 0;

		scope.push(
			RunService.Heartbeat.Connect(() => {
				const magnitude = read();

				if (DEBUG && peaks < STICK_PEAK_LIMIT && magnitude > peak + 0.1) {
					peak = magnitude;
					peaks += 1;

					print(`[Sprint] mobile — the stick's peak so far ${string.format("%.2f", magnitude)}`);
				}

				// **Two tests and not one**, which is the hysteresis: the stick has to be pushed past the start
				// threshold to begin and eased back below the (lower) stop threshold to end, so a thumb resting near
				// one line cannot flip the state every frame. See {@link SPRINT_START_MAGNITUDE}.
				//
				// **And the state is a latch, so `holdSprint` is only ever called on an edge** — not once per frame
				// with a value the other side merely de-duplicates. Two guards, deliberately: the latch is this
				// loop's own account of what it last asked for, and `SprintController.setHolding` has one of its
				// own. The line before each call is what makes the edge visible in a log, which is the whole of
				// what was missing when this feature first failed.
				if (!sprinting && magnitude >= SPRINT_START_MAGNITUDE) {
					sprinting = true;

					if (DEBUG) {
						print(`[Sprint] mobile — magnitude ${string.format("%.2f", magnitude)} (over start)`);
						print("[Sprint] mobile — hold true");
					}

					this.sprintController.holdSprint(true);
				} else if (sprinting && magnitude < SPRINT_STOP_MAGNITUDE) {
					sprinting = false;

					if (DEBUG) {
						print(`[Sprint] mobile — magnitude ${string.format("%.2f", magnitude)} (under stop)`);
						print("[Sprint] mobile — hold false");
					}

					this.sprintController.holdSprint(false);
				}
			}),
		);
	}

	/**
	 * **Where the stick's reading comes from: two routes, one answer — the stick's own thumb, or the engine's
	 * movement module.**
	 *
	 * **Both routes return a *reader*, a `() => number`, and never the thing they found.** That is what keeps the
	 * untyped half contained: everything the module route touches below is `unknown` and checked by hand, and
	 * {@link watchStick} cannot tell which route its number came from — it polls one either way.
	 *
	 * **The GUI route was written second and is tried first, which reverses this method's original design.** The
	 * module was "the supported way to ask", and on the first real phone log this project has, that ask timed out
	 * while the same client's jump button was being read out of the same GUI by name. What a supported route is
	 * worth is what it delivers, and this one delivers a number on a client where the other delivers nothing; the
	 * module stays for the movement modes the GUI cannot describe. See {@link findStickPoint}.
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
		// **Route one: the stick's own geometry, which needs nobody's module.** It goes first because it is the only
		// route that works on a client whose `PlayerScripts` this file turns out not to be able to read — and one
		// such client exists, which is the whole reason this route does. See {@link findStickPoint}.
		const fromStick = findStickPoint(Players.LocalPlayer.WaitForChild("PlayerGui") as PlayerGui);
		if (fromStick !== undefined) {
			if (DEBUG) {
				print(
					`[Sprint] mobile — reading the stick's own thumb (${STICK_FRAME_NAME}.${STICK_THUMB_NAME}), ` +
						`which is the default touch movement mode`,
				);
			}

			return fromStick;
		}

		// **Route two: the engine's movement module**, which is what covers the movement modes the GUI cannot
		// describe — the dynamic thumbstick's undrawn radius and the thumbpad's whole-pad slide. Everything below is
		// that route.
		//
		// **Waited for with a timeout rather than yielded on forever.** Both instances are created by the engine's
		// own scripts during boot, so they are usually there already; the timeout is what stops a client that
		// somehow lacks them from leaving a task alive for the session. `WaitForChild` with a timeout returns
		// `Instance | undefined`, which is the shape this whole method is written in.
		const playerScripts = Players.LocalPlayer.WaitForChild("PlayerScripts", STICK_WAIT_SECONDS);
		if (playerScripts === undefined) {
			if (DEBUG) print("[Sprint] mobile — no PlayerScripts, so the stick cannot be read at all");

			return undefined;
		}

		// **Found by searching rather than by naming a path, and that is a correction this method needed.** The
		// first version waited on `PlayerScripts.PlayerModule` — the documented route — and the first real phone log
		// this project has shows it timing out: ten seconds, then `no PlayerModule`, on a client whose jump button
		// was sitting in `TouchGui.TouchControlFrame` the whole time. A client with the engine's touch controls up
		// is a client whose movement module is running, so the lookup was wrong and not the device. See
		// {@link findMoveModule} for the two trees Roblox has shipped the same module under.
		const moduleScript = findMoveModule(playerScripts);
		if (moduleScript === undefined) {
			if (DEBUG) {
				// **What is there instead, by name and class.** "no PlayerModule" is a message that cannot tell a
				// renamed module from a missing one and says nothing about which layout the client runs, which is
				// exactly what made the first failure unfixable from the log it printed. This prints the tree's top
				// level, so the next session names the layout rather than guessing at it.
				const held: string[] = [];
				for (const child of playerScripts.GetChildren()) held.push(`${child.Name} (${child.ClassName})`);

				print(
					`[Sprint] mobile — no ${STICK_MODULE_NAMES.join(" or ")} anywhere under PlayerScripts, and the ` +
						`GUI has no visible stick either. It holds: ${held.join(", ")}`,
				);
			}

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
					`[Sprint] mobile — ${moduleScript.GetFullName()} would not hand over its controls: ` +
						`${tostring(controls)}`,
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
			if (DEBUG) print(`[Sprint] mobile — ${moduleScript.Name} has no GetMoveVector on its controls`);

			return undefined;
		}

		// **The route it was found by, printed once, because the *which layout* question is the one that cost this
		// pass a round trip.** A path in the log also says whether the client is on the modern tree or the older one,
		// which is the first thing to know about any future difference between them.
		if (DEBUG) {
			print(
				`[Sprint] mobile — reading through ${moduleScript.GetFullName()}, which answers GetMoveVector; ` +
					`"${moduleScript.Name}" is the ${moduleScript.Name === "PlayerModule" ? "modern" : "older"} ` +
					`layout of the engine's controls`,
			);
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
	 * **Two things and no wrapper.** A `TextButton` rounded into a disc with an `ImageLabel` inside it that is empty
	 * today and will hold an icon later, and a `TextLabel` *child of the button* sitting below the disc saying what
	 * the button does — because on this HUD the word *is* the legend, which is the one thing that separates this
	 * cluster from the keyboard's card. **There is no cell frame and no layout inside the button**: the label hangs
	 * from the button's own bottom edge (`AnchorPoint (0.5, 0)`, `Position (0.5, 1)` plus {@link LABEL_GAP}), which
	 * is exactly how the engine's jump button carries its own word, and the button's position and size come from
	 * {@link pack} through `slot`. That is the same simplification the box made one level up: nothing in this
	 * cluster arranges anything at runtime any more.
	 *
	 * **The label is below the button rather than inside it**, deliberately: a word inside a 72px circle would have
	 * to be tiny or wrapped, and a control whose label competes with its own icon is a control that has to be read.
	 * Under it, the circle stays the whole target and the word annotates it — and the room for it is reserved by the
	 * packing rather than by this method. See {@link pack} and {@link LABEL_BAND}.
	 *
	 * **The icon's box is an `ImageLabel` with no image, not a `Frame`.** Both reserve the same space, and the one
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
	 * **The state is two property writes, not a tween and not a `Computed`.** It is a *state* — a button is held or
	 * it is not — and there is nothing in between to animate; a fade would also leave the colour somewhere between
	 * the two states at exactly the moment the player wants to know which one they are in. And it is written
	 * straight onto the instance rather than through the graph for `wireInteraction`'s reason: what moves is an
	 * instance property, nothing reads it, and a `Computed` here would need an `Observer` to have any effect at
	 * all.
	 *
	 * **And the press can be a grip instead of a press, which is back.** The packing pass deleted the drag tool on
	 * the argument that a fixed box needs no hand-tuning, and the second half of that argument was wrong: the box's
	 * *place* is derived from the engine's button, so moving the cluster down means stating a nudge by hand — and a
	 * hand needs a tool. While {@link ARRANGE} is on, the same press that would act on the game starts a drag of the
	 * whole box through {@link ArrangeHook}: nothing fires and nothing is painted, and the `InputChanged` connection
	 * that feeds the drag is made **only** in that mode, so the shipped path carries no dead machinery.
	 */
	private buildButton(
		scope: Fusion.Scope<unknown>,
		theme: HudTheme,
		control: TouchControl,
		slots: Fusion.UsedAs<Array<{ x: number; y: number; size: number }>>,
		index: number,
		arrange: ArrangeHook | undefined,
	): TextButton {
		/**
		 * **This button's place in the packing, read through the graph rather than handed in as numbers.** `pack`
		 * recomputes whenever the box or the scale moves, so the size and the position have to be `Computed`s of
		 * their own — a pair of numbers captured at mount would be right on the phone they were captured on and
		 * wrong after the first rotation. See {@link pack}.
		 *
		 * The fallback is unreachable while `rows` totals the controls — {@link mount} checks that — and exists so
		 * that the two `Computed`s below have a value of the right shape to read instead of a nil case each.
		 */
		const slot = Fusion.Computed(scope, (use) => {
			const packed = use(slots);

			return packed[index] ?? { x: 0, y: 0, size: TAP_MIN };
		});

		const button = Fusion.New(scope, "TextButton")({
			Name: control.label,
			// **The size from the packing, and one size for the entire cluster** — there is no per-control size any
			// more, which is what {@link pack} traded away for a shape that always fits. See {@link BOX_SIZE}.
			Size: Fusion.Computed(scope, (use) => {
				const here = use(slot);

				return UDim2.fromOffset(here.size, here.size);
			}),
			// **The position too**, in the box's own coordinates: `slot` is a button *centre*, so this anchor puts
			// the circle's middle exactly where `pack` said it goes rather than its corner.
			AnchorPoint: new Vector2(0.5, 0.5),
			Position: Fusion.Computed(scope, (use) => {
				const here = use(slot);

				return UDim2.fromOffset(here.x, here.y);
			}),
			// **The idle state, and the two properties are the whole of the difference between the states.** See
			// {@link IDLE_TRANSPARENCY} for the colour and the opacity and for what the alternative was.
			BackgroundColor3: theme.colors.trough,
			BackgroundTransparency: IDLE_TRANSPARENCY,
			BorderSizePixel: 0,
			AutoButtonColor: false,
			// A button whose text is its label would draw the word in the circle; the word is a child below it.
			Text: "",
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

				// **In hand-move mode the press is a grip**, and it takes the whole press: no latch, no paint, no
				// action. The latch matters here rather than being tidiness — a grip that set `held` would swallow
				// the release's `control.up()` for a control that never went down. See {@link ARRANGE}.
				if (arrange !== undefined) {
					// `InputObject.Position` is a `Vector3` — the engine's input points carry a Z — and everything
					// here is 2D. Dropping the axis at the one place it enters is the whole conversion.
					arrange.grab(new Vector2(input.Position.X, input.Position.Y));

					return;
				}

				if (held) return;
				held = true;

				// **The press itself, printed once per press.** Every action this cluster drives already has a log
				// line of its own inside the controller that owns it, so without this a press that reached nothing
				// at all and a press that reached the wrong thing look the same from the outside. It is also what
				// separates the two halves of "a button does nothing": this line missing means the *input* never
				// arrived here, and this line followed by nothing means the action itself refused.
				if (DEBUG) print(`[HUD] ${control.label} down`);

				paint(true);
				control.down();
			}),
		);

		scope.push(
			button.InputEnded.Connect(() => {
				// **A grip ends the same way a press does**, and ending it is when the nudge is worth printing —
				// see {@link ArrangeHook}. Nothing to paint and no action to end, so this returns rather than
				// falling through.
				if (arrange !== undefined) {
					arrange.done();

					return;
				}

				// **The release is taken however it arrives**, which is the rule `DodgeController` and
				// `SprintController` both follow for their own releases: an ending is unambiguous, and a finger that
				// slides off the button still has to end the hold it began. A release with no hold is a no-op, so
				// nothing here needs to ask which kind of input ended.
				if (!held) return;
				held = false;

				paint(false);
				if (control.up !== undefined) control.up();
			}),
		);

		// **The drag's own connection, made only in hand-move mode.** Every other button in this project lives
		// without one — a press is a begin and an end and nothing between them is this file's business — so the
		// shipped path does not pay for a feature it is not using. **The `grab`/`move` pairing is the safety here**:
		// a `MouseMovement` that began nowhere near a button still fires this, and it does nothing because
		// {@link ArrangeHook} has no starting point to measure it from.
		if (arrange !== undefined) {
			scope.push(
				button.InputChanged.Connect((input) => {
					const kind = input.UserInputType;
					if (kind !== Enum.UserInputType.Touch && kind !== Enum.UserInputType.MouseMovement) return;

					arrange.move(new Vector2(input.Position.X, input.Position.Y));
				}),
			);
		}

		// **The word, hung off the button's own bottom edge** rather than stacked by a layout — the same
		// arrangement the engine's jump button has, and the reason there is no cell frame at all. `AnchorPoint
		// (0.5, 0)` with `Position (0.5, 1)` puts its top-centre on the circle's bottom edge, so the word is
		// centred under the disc at whatever size the packing gave it, plus {@link LABEL_GAP} of air.
		const label = this.buildLabel(scope, theme, control.label);
		label.AnchorPoint = new Vector2(0.5, 0);
		label.Position = new UDim2(0.5, 0, 1, LABEL_GAP);
		label.Parent = button;

		return button;
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
	 * and neither of those is the size of the cluster's own buttons. **A `UIScale` is the one property that changes
	 * how big a `GuiObject` renders without touching `Size`** — the reference's own words are that its `Scale` "is
	 * used to multiply the `AbsoluteSize` of the parent UI element" — so the module's layout is left completely
	 * alone and only the *rendered* size changes. It carries **two factors**: the shrink toward {@link PAD_SIZE},
	 * and the cluster's own viewport multiplier, which arrives here as the `scale` parameter. It is added *after*
	 * the restyle's own children, as a sibling of them, and it is created once rather than in `paintParts`: the
	 * look is re-asserted on every press and the scale is not a thing a press can change. **The one assumption in
	 * it** is that the module never writes a `UIScale` of its own — the discovery probe reads `0 child(ren)` on a
	 * fresh button, and the module's own `TouchJump` script writes `Size`, `Position`, `Image` and `Visible` when
	 * it creates the button and nothing else.
	 *
	 * **The one thing this cannot promise, stated rather than discovered.** The module owns the button's
	 * `BackgroundColor3`, `BackgroundTransparency` and `Image`, and it changes them on press to draw its own
	 * feedback. Ours is written once at discovery and again on each press and release, connected *after* the
	 * module's own handlers so ours is the later write of the two; if the module turns out to write those
	 * properties from a per-frame update instead of from its input handlers, the button will flick back to the
	 * engine's colours and the fix is a re-assert on the same signal the module uses. What the log prints at
	 * discovery is the evidence either way — see the report below.
	 *
	 * **The multiplier it is handed is the same one `mount` builds the box from**, and that is the whole of what
	 * this pass changes about the pad: it used to be the one element in this corner outside the cluster's scale,
	 * sized toward a fixed 72 while the box grew around it. Now the two are the same rate, so a bigger screen has a
	 * bigger pad beside bigger buttons. **Handed in rather than read here** for `scaleFor`'s own reason — a second
	 * copy of the fit would be a second answer to one question, and the copy that went stale would be the pad's.
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
	private restyleEngineJump(
		scope: Fusion.Scope<unknown>,
		theme: HudTheme,
		scale: Fusion.UsedAs<number>,
	): JumpGeometry {
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
			 * **Two factors in one number: the shrink, and the cluster's viewport multiplier.** `measure` writes
			 * their product, and that product is what puts the pad inside the same scale as the five buttons beside
			 * it — see {@link PAD_SIZE} for why the pad cannot arrive at that size by itself (the module picks
			 * 70px or 120px and stops) and the `scale` parameter for where the second factor comes from.
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

			/**
			 * What the engine's button measured at the last report, so `measure` prints news rather than frames —
			 * both of the numbers that make up the rendered size, because either can move without the other: the
			 * engine's own size changes when it rebuilds the button for a different device class, and the multiplier
			 * changes on every rotation.
			 */
			let reportedEngineSize = -1;
			let reportedMultiplier = -1;

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
			 * same two signals rather than captured once — and this is also where the cluster's own multiplier is
			 * applied, because a viewport change is exactly the moment that changes. The five buttons follow the
			 * box; the pad now follows it too, rather than sitting at a fixed size beside a moving cluster.
			 *
			 * **The pad's own size is recovered by dividing the scale back out, and that is the subtle line here.**
			 * `AbsoluteSize` *includes* our `UIScale` — that is what a `UIScale` is — so the engine's own size is
			 * `rendered ÷ the scale currently applied`, and the scale this method then writes is
			 * `min(1, PAD_SIZE ÷ that) × the viewport multiplier`. Substituted, the two cancel: what is written is
			 * what was read, so the write cannot feed itself. **That is exactly the trap a scale derived from
			 * `AbsoluteSize` alone would fall into** — each pass would multiply the pad by `PAD_SIZE ÷ its own size`
			 * and the pad would vanish in a couple of frames. See {@link PAD_SIZE}.
			 *
			 * **The multiplier is on both sides and cancels for the same reason it is outside any loop**: it is a
			 * function of the *screen*, and the screen does not read the button. That is the whole of why one
			 * `Scale` can carry two factors — the factor that looks at `AbsoluteSize` is the shrink, and the factor
			 * that does not is the viewport.
			 *
			 * **`min(1, …)` is the "shrink, never enlarge" rule**, which is why the second logged device — a 70px
			 * pad — keeps the size the engine gave it. The multiplier sits *outside* the `min`, so a big screen
			 * still grows the pad; what the rule protects is the comparison with the engine's own draw, not the
			 * final size. See {@link PAD_SIZE} for why that distinction is the one that matters.
			 *
			 * **The centre rather than the corner, because a centre is the reading both uses can be built from.** An
			 * `AnchorPoint` of `(0, 0)` means the rendered button expands from its own top-left, so that corner is
			 * where the engine left it and the centre is that corner plus half of the *visual* size. **The visual
			 * size is computed rather than re-read from `AbsoluteSize`**, so this lands on the frame the scale
			 * changes instead of one signal later — and the box asks for that top-left corner back out of the same
			 * two numbers (`centre.Y − visualSize/2`), so neither reading has to re-derive the other.
			 *
			 * **And the box's own derivation is untouched by any of it.** What the box hangs from is the pad's
			 * *top-left* — `centre.Y − visualSize/2` — and the corner is where the module put the button: the
			 * rendered size cancels out of that subtraction, so growing the pad moves its bottom edge and never the
			 * number the box is placed from. That cancellation is what lets the pad's size depend on the viewport
			 * at all without the box's size and the box's *position* becoming each other's inputs.
			 *
			 * **The larger axis rather than `X`**, because the engine's own button is not guaranteed square and a
			 * clearance taken from the narrow axis would put a neighbour *inside* a wide button. A button that is
			 * wider than it is tall therefore gets a little more room than it strictly needs, which is the harmless
			 * direction for that mistake to go in.
			 */
			const measure = (): void => {
				const rendered = math.max(button.AbsoluteSize.X, button.AbsoluteSize.Y);
				const engineSize = rendered / hudScale.Scale;
				const multiplier = Fusion.peek(scale);
				const visualSize = math.min(engineSize, PAD_SIZE) * multiplier;

				hudScale.Scale = math.min(1, PAD_SIZE / engineSize) * multiplier;

				geometry.centre.set(button.AbsolutePosition.add(new Vector2(visualSize / 2, visualSize / 2)));
				geometry.size.set(visualSize);

				// **The line that makes the shrink answerable from a log**, and the numbers a run needs if the pad
				// ever comes out at the wrong size: what the engine drew, what it is being rendered at, the scale
				// that did it, and the viewport factor inside that scale. Printed on the way in for this codebase's
				// usual reason — the sizes are the fact being doubted — and guarded on both inputs, so that a
				// rotation re-reports (it moves the multiplier) while a press does not.
				if (DEBUG && (engineSize !== reportedEngineSize || multiplier !== reportedMultiplier)) {
					reportedEngineSize = engineSize;
					reportedMultiplier = multiplier;

					print(
						`[HUD] jump pad — the engine drew ${string.format("%.0f", engineSize)}px, ` +
							`rendering ${string.format("%.0f", visualSize)}px at scale ` +
							`${string.format("%.3f", hudScale.Scale)} ` +
							`(the viewport's own multiplier is ${string.format("%.3f", multiplier)})`,
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
