import { Controller, OnStart } from "@flamework/core";
import { Text } from "@rbxts/big-ui";
import Fusion from "@rbxts/fusion-3.0";
import { Players, RunService, Workspace } from "@rbxts/services";
import { isMobile } from "../../platform";
import { applyGlow } from "../../ui/glow";
import { hudTheme } from "../../ui/hudTheme";
import { PREMIUM } from "../../ui/premiumTheme";
import { getScreenSpaceGui } from "../../ui/screenGui";
import { ActionController } from "../input/ActionController";
import { CatchController } from "../input/CatchController";
import { DodgeController } from "../input/DodgeController";
import { ThrowController } from "../input/ThrowController";

/** Prints the mount line, every press and every release, and the stick's own resolution. */
const DEBUG = true; // off for frame time — see shared/config/debug.config.ts

/**
 * **The hand-move mode: drag anywhere on the cluster and the whole box follows your finger.** **Placeholder —
 * `false`.**
 *
 * **Turn it on, drag the cluster where you want it, and paste the two numbers it prints into {@link BOX_NUDGE}** —
 * that is the whole loop, and it is a live one: `rojo serve` is usually up, so flipping this and saving puts the
 * mode into the running game in a second or two.
 *
 * **It exists because a corner gap is a guess about somebody else's thumb.** Where the box sits is
 * {@link BOX_EDGE_GAP} in from two screen edges — right for every device nobody has looked at, and no help at all
 * for the one in front of you, where a home indicator, a case or a slightly different grip moves where the thumb
 * lands. The drag is how the delta gets found — one gesture, one number, one paste — instead of by rebuilding with a
 * guessed constant, and the gesture *starts from where the cluster already is*, so switching the mode on never moves
 * anything.
 *
 * **While it is on, a press on a button is a grip rather than a press**: no action fires, no colour changes, and
 * the same for all six, because the unit that moves is the *box*. That is the one thing this mode costs — the
 * cluster cannot be played while it is being placed — which is why it is a constant in the file rather than
 * something reachable at runtime.
 *
 * **The packing pass deleted this tool, and the argument that deleted it was true in one direction only.** The
 * claim was that a fixed box needs no drag tool: one number to tune, and the number is the box's size. True of the
 * *size* and false of the *place* — the place is two constants and a screen edge now, the same on every device,
 * but where a thumb *wants* it is not, so the only way to disagree with it is by hand, and a tool is how a hand
 * finds a number. See {@link BOX_NUDGE}.
 */
const ARRANGE: boolean = false;

/**
 * **Whether the engine's own jump button is hidden now that this cluster draws one.** **Placeholder — `true`.**
 *
 * **The one switch to flip if the custom jump ever stops working on a device**, and it is here rather than in a
 * config because it is a *fallback for a bug*, not a preference: the engine's button is the control this project
 * shipped for two years and it is driven by the `PlayerModule`, so it cannot be broken by anything this file
 * does. Setting this to `false` puts it back on screen within a second of `rojo serve` — hidden rather than
 * destroyed either way, so nothing else in the file changes. See {@link requestJump} for what the custom button
 * does and why it needs a switch at all.
 *
 * **It hides the *appearance* only, and with the cluster anchored to the corner that now has a cost worth naming.**
 * The engine's button is laid out in the bottom-right corner too — under the cluster's own bottom row — so flipping
 * this to `false` puts the engine's circle *behind* three of ours rather than beside them. The cluster's buttons take
 * the presses there, and the way to see the engine's control work as a fallback is to lift the cluster with a
 * negative `Y` in {@link BOX_NUDGE} first.
 */
const HIDE_ENGINE_JUMP: boolean = true;

/**
 * **How long one press may keep asking the body to jump, in seconds.** **Placeholder — 0.25.**
 *
 * The custom jump writes `Humanoid.Jump` **every frame** while the button is held, because a single write is lost
 * (see {@link requestJump}). A hold therefore has to end on something other than the finger: `InputEnded` is the
 * normal stop, and this is the cap for a release that never arrives — a touch that ends off the button, a window
 * that loses focus mid-press, a client whose input event was dropped. **A quarter of a second is a jump and never
 * a held one**: the engine's own button repeats a jump on landing while held, and repeating that here would be a
 * player who cannot stand still on a phone with a sticky digitizer.
 */
const JUMP_HOLD_SECONDS = 0.25;

/**
 * The render step's name, which **is** its handle — `BindToRenderStep` hands nothing back to cancel with, so the
 * string is what {@link endJump} unbinds and why it is spelled once here.
 */
const JUMP_STEP_NAME = "MobileControlsJump";

/**
 * The gap between two buttons in the box, in reference pixels. **Placeholder — 10.**
 *
 * **A gap, not a packing rule.** The buttons sit on a grid whose cell is `size + gap`, so this is what is left
 * over between two circles once the cells are as small as they can be. `10` on a 72px button is the tightness the
 * last hand-tuning arrived at: close enough to read as one object, far enough that two half-transparent circles
 * do not look like they touch.
 */
const BOX_GAP = 15;

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
 * How far the box sits from the screen's right edge **and from its bottom edge**, in reference pixels.
 * **Placeholder — 12.**
 *
 * **The same 12 the rest of the furniture uses, on both axes.** These are the only two screen edges this box names —
 * the other two sides come from the box's own size — and naming them is the whole of the position: the box is
 * anchored bottom-right, so this pair *is* where the cluster sits.
 *
 * **On the screen's edge rather than the safe area's**, because the box is mounted into `getScreenSpaceGui`, whose
 * insets are `None`. That is deliberate: "the bottom-right of the screen" is what a thumb expects, and an inset
 * GUI moves that edge up by the home indicator on a phone and by nothing on a desktop, i.e. the same code would put
 * the cluster at two different heights. **12px off a device's true bottom can be close to the home indicator**, which
 * is what {@link BOX_NUDGE} is for — a negative `Y` there lifts the whole cluster for the device that needs it
 * without touching this number.
 */
const BOX_EDGE_GAP = 12;

/**
 * **How big each button is, relative to the others — one factor per cell, in {@link mount}'s control order.**
 * **Placeholder — Throw and Jump at `1.4`, the four utilities at `0.9`.**
 *
 * **The reason a layout instance cannot do this job.** `UIGridLayout.CellSize` is one `UDim2` for every cell, so a
 * grid can only ever draw six identical squares — and Throw and Jump are the primary actions, the two a right thumb
 * reaches for without looking. A cluster that draws them the same diameter as Drop is a cluster that says all six
 * matter equally.
 *
 * **Nested `UIListLayout`s were the other candidate, and they fail in the other direction.** A list draws its
 * children at the sizes it was given and does not shrink them to fit; a row that overflows its box overflows it
 * silently, off the edge of the screen. Sizing rows by hand so that they fit *is* the arithmetic below, written once
 * per row instead of once for the cluster — which is the third arrangement this file tried and the one that produced
 * "a correct derivation of a shape that could not fit a phone".
 *
 * **So the packing formula is kept with one more degree of freedom**: every diameter is `factor × unit` for a single
 * `unit`, and `unit` is the largest value that lets every row fit both ways. The cluster therefore always fits the
 * box it is given, at any aspect ratio, **by construction** — which is the property the three earlier arrangements
 * did not have and the only reason this file has arithmetic in it at all.
 *
 * **`0.9` and `1.4` rather than `1` and `1.3`, and what that actually changes is smaller utilities — not bigger
 * primaries.** The tallest circle in a row is **always** `rowHeight − labelBand`, whatever its weight is, because
 * the weight is what *sets* the unit that fits it: at `1.3` the arithmetic gives `unit = 72 ÷ 1.3 = 55.4`, so the
 * primaries come out at `55.4 × 1.3 = 72px`; at `1.4` it gives `unit = 72 ÷ 1.4 = 51.4` and they come out at
 * `51.4 × 1.4 = 72px` again. **The primary diameter is pinned by the row and cannot grow from here** — the only
 * thing a wider ratio can do is take width away from its neighbours, which is exactly the hierarchy being asked
 * for, and it is what the numbers below say rather than what a first reading of "make them 1.4" suggests.
 *
 * **So the utilities go from `55.4` reference px to `46.3`**, a fifth smaller, and the ratio between the two
 * classes goes from `1.3` to `1.56`. `46.3` is still comfortably over {@link TAP_MIN} (44) — which is the bound
 * that matters, and the one this array is nearly at: **the crossover is a ratio of `72 ÷ 44 ≈ 1.64`**, so at
 * `0.9`/`1.4` the margin is about eight tenths of a pixel of reference size. Push the utilities much below `0.85`
 * and `minimumBox` starts growing the whole box instead, which is the failure the previous paragraph of this file's
 * history records (`TAP_MIN` applied per button, overlapping clusters). `1.56` reads as "primary" at arm's length;
 * it is also far enough from `1.64` to be safe on the sizes this project has logs for.
 *
 * **The row that binds is the bottom one, and *which side of it* binds changes with the screen.** Row two is
 * `1.4 + 1.4 = 2.8` wide, so its width gives `(box.X − gap) ÷ 2.8` and its circle room gives
 * `(rowHeight − labelBand) ÷ 1.4`. At the reference box with `BOX_GAP` at `15` those are `78.9` and `49.6`, so a
 * phone is **height**-bound and `unit` is set by the row's circle. **On a tablet it is width-bound**, because the
 * gap and the box both multiply by the device tier while the label band does not — the band is fixed text, so the
 * circle room grows faster than the row's width as the multiplier rises. On the 10th-gen iPad at `2.216` the two
 * bounds are `123.4` and `127.4`: the row's *width* is the smaller one, and the utilities come out at `111px`
 * rather than the `114` the circle room alone would allow. **Nothing needs doing about it** — the packing takes the
 * smaller bound whichever it is — but the sentence that used to stand here ("it still binds on height at every
 * scale this design is drawn at") was true only of the phones, and of `BOX_GAP = 10`. **`BOX_FRACTION.X` is still
 * untouched**: both bounds are properties of the box this design chose, and the tablet crossing over asks it for a
 * different *size*, which is the tier's job, not a different *shape*.
 *
 * **The order is `mount`'s fill order** — Drop, Catch, Curve, Dodge, Throw, Jump — which is the order the cells fill,
 * so `[0]` is Drop, `[4]` is Throw and `[5]` is Jump. **This array is indexed by position, not by control**, so
 * moving a control in that list means moving its weight here too; the two are one fact written in two places and
 * that is the cost of a layout that reads its inputs in order. A weight missing from the end of this array reads as
 * `1`, so shortening it does not break the layout; the count is checked at mount all the same, because a *misordered*
 * array is a silent design bug rather than a crash.
 */
const BUTTON_WEIGHT: number[] = [0.9, 0.9, 0.9, 0.9, 1.4, 1.4];

/**
 * **How far the box is moved from the bottom-right corner, in reference pixels: `X` right, `Y` down.**
 * **Placeholder — `(0, 0)`, which is exactly the corner {@link BOX_EDGE_GAP} describes.**
 *
 * **A *nudge* rather than a corner on purpose.** The corner is right by construction — two scale-1 offsets from two
 * screen edges — so a constant that *replaced* it would have to be found again on the next phone. A delta keeps it:
 * `new Vector2(0, -40)` reads as "40px higher than the corner, on whatever device this is", which is the sentence a
 * person actually has in mind when a case or a home indicator is in the way of the bottom edge.
 *
 * **`Y` positive now means *down* and therefore off the screen**, which is the opposite of what it meant when the box
 * hung off the engine's jump button — there, down from the pad's top edge was *into* the screen. The sign did not
 * change; the edge it is measured from did. **The useful direction here is negative**, and a positive `Y` is only
 * ever a mistake worth recognising as one.
 *
 * **What a `Y` below the floor costs: the bottom row is partly off the screen**, and a button whose centre is past
 * the edge cannot be pressed at all — the label under it goes first, then the circle. Nothing clamps it, because a
 * clamp would make the drag lie about the number it prints; the printed `Y` and the visible result are the same fact.
 *
 * **Nothing here is written back to the file**, so {@link ARRANGE} can take the box anywhere and a re-sync — or
 * simply turning the mode off — puts it back at the corner. The number is the deliverable, not the position.
 */
const BOX_NUDGE = new Vector2(0, 0);

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
 * **The cluster takes nothing from the pad any more — not its size, not its place.** `PAD_SIZE` is this file's own
 * decision about how big *somebody else's* button renders, and the only thing it shares with the cluster is the
 * viewport multiplier both are drawn at. That is why the pad's size cannot feed back into the layout: it no longer
 * touches it.
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
 * The smallest the cluster is ever *drawn*, as a fraction of the reference layout. **Placeholder — `1.1`**, and
 * the `0.85` the paragraphs below were written for is history: the number was raised and those two mentions were
 * not, which is why they read as a floor *below* the design rather than above it.
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
 * **The floor is still needed, and its failure mode changed when the tap floor moved.** The multiplier is the *fit* —
 * the smaller of the two axis ratios against {@link REFERENCE_VIEWPORT} — and a phone held sideways fits at about
 * `0.46`. That used to mean a 33px button which the packing then raised to {@link TAP_MIN} **per button**, so the two
 * rows overlapped and spilled out of the box. It now means the *box* is grown until its smallest button is tappable
 * — see `minimumBox` — which on a sideways phone pushes a cluster of full-size buttons a long way up the screen, over
 * the engine's own corner. Holding the layout at `1.1` keeps a sideways phone at buttons that still fit where the
 * design puts them, which is the cheaper failure by a wide margin. **`1.1` rather than `0.85` also means the floor
 * is above the reference fit of `1.0`**, so a 393 × 852 phone is drawn ten per cent *larger* than the design's own
 * numbers — which is a deliberate part of the current look rather than an accident of the clamp, and it is why the
 * device tiers multiply the fit rather than replacing it: a phone's multiplier is still exactly what it was.
 *
 * **Where `1.1` comes from**, stated as what it protects rather than as a measurement: the smallest button in a row
 * is `min(weight) × unit` and `unit` falls with the box, so there is a multiplier below which `minimumBox` starts
 * doing the growing. `1.1` keeps a sideways phone inside the design's own numbers on the screens this project has
 * logs for. The exact crossover is arithmetic rather than taste, and it moves whenever {@link BUTTON_WEIGHT} does —
 * which is why it is not written down here as a formula. `minimumBox` is the one place that answers it.
 */
const SCALE_MIN = 1.1;

/**
 * **The three device tiers the cluster is drawn at, as a boost on the continuous fit — and the numbers come from
 * where a device sits in the emulator's own device list rather than from a CSS framework.**
 *
 * **What a phone and a tablet are, in the units this file has.** A viewport is measured in *pixels*, so the only
 * honest question is at what pixel count a device stops being a phone. The emulator's own set answers it: the
 * widest phone is the iPhone 16 Pro Max at **430 × 932**, and the smallest tablet is the iPad mini at
 * **744 × 1133**. Nothing in that gap is sold as either, so any threshold inside `430..744` is defensible, and
 * `600` is the middle of it — the same figure the web uses for the same breakpoint, arrived at independently.
 * `1024` is where a 12.9" iPad and the larger tablets begin, and it is likewise the web's second breakpoint.
 *
 * **Measured on the SHORT axis, and that is the load-bearing correction to a width test.** A phone held sideways
 * reports `viewport.X = 852`; a *portrait* iPad mini reports `744`. A width test therefore calls the landscape
 * phone a tablet and hands a cluster that has 393 pixels of height a `1.6` boost — in the one orientation where the
 * box is already the largest thing on the screen. The short axis does not move when a device rotates: `393` for the
 * iPhone in both orientations, `820` for the 10th-gen iPad in both, which is the property the tier is supposed to
 * have. **`GuiService.ViewportDisplaySize` cannot answer this question either** — see {@link scaleFor}.
 *
 * **A boost rather than a replacement, because the continuous fit is right about everything else.** An iPad 10th's
 * fit is `min(820/393, 1180/852) = 1.385`, and the fault is not the arithmetic but what the arithmetic is
 * averaging: 393 × 852 is a *phone's* shape, so the fit answers "how many phones fit in this rectangle" and a
 * tablet's extra inches are mostly spent along its long axis. Multiplying the fit keeps the proportional behaviour
 * that makes the box the same fraction of every screen, and adds the step that says a bigger device gets a bigger
 * *relative* control — which is what a thumb on a 10-inch display actually needs.
 *
 * **`1.3` was not enough, and the reason is physical rather than arithmetic.** At `1.385 × 1.3 = 1.80` the buttons
 * are 80% larger than the iPhone's in *pixels* — but a 10th-gen iPad is about `1.7×` a phone's diagonal at the
 * same pixel density, so 80% of the linear size lands at roughly *half* the angular size under a thumb's eye. The
 * complaint was exactly that: "79% larger still looks tiny" on a screen that is physically massive. `1.6` takes
 * the multiplier to `2.216` — a utility button of about `115 px` and a primary of about `178 px`, where they were
 * `94` and `146`. **The boost is the only knob that does this**: {@link BUTTON_WEIGHT} changes the *ratio* between
 * the two classes and cannot change either absolute size, because the tallest circle in a row is pinned at
 * `rowHeight − labelBand` whatever the weights are (see that constant's own note).
 *
 * **No boost on a phone, and that is an acceptance criterion rather than an omission.** `1` is a tier and not a
 * missing value: an iPhone must render exactly what it rendered before this existed, and that is the only thing
 * that makes a change in the boost distinguishable from a change in the fit.
 *
 * **What it costs, stated because the boost is not free: the engine's jump pad is inside this multiplier too.**
 * {@link restyleEngineJump} folds this number into the pad's `UIScale`, so a tablet now gets a pad `1.6×` larger as
 * well. That is the same rate as the buttons beside it and therefore correct, but it does mean the pad is the
 * largest it has ever been on a tablet. See {@link PAD_SIZE}, where the one-shared-rate argument is written.
 *
 * **And the other cost, measured rather than discovered: a bigger cluster reaches further left.** The box is
 * anchored to the bottom-right corner, so every pixel the multiplier adds is taken from the space between the
 * cluster and the joystick — which is on the bottom-**left**, about `0.38` of the viewport's width wide (its
 * `MOVEMENT_ZONE_WIDTH_SCALE` plus its edge inset). At these boosts the leftmost utility's left edge and the
 * movement zone's right edge come out as:
 *
 * | device | multiplier | leftmost button | zone's right edge | clear |
 * |---|---|---|---|---|
 * | iPhone 16 393 × 852 | `1.10` | 130 px | 149 px | −19 px *(unchanged by this)* |
 * | **iPad 10th 820 × 1180** | **`2.216`** | 327 px | 312 px | **+15 px** |
 * | iPad mini 744 × 1133 | `2.128` | 271 px | 283 px | −12 px |
 * | iPad Pro 12.9 1024 × 1366 | `2.886` | 376 px | 389 px | −13 px |
 *
 * **So the 10th-gen iPad — the device this was tuned for — clears, and the two tablets either side of it do
 * not**, by a sliver of a button that is itself between 110 and 155 px across. The negative rows on the phones
 * have always been there: the zone is a *movement* zone, deliberately much wider than the ring it is named after,
 * so a sliver under it is the normal case rather than a fault. If Studio shows a leftmost button refusing
 * presses, the number to move is `MOVEMENT_ZONE_WIDTH_SCALE` on the joystick side rather than this boost —
 * narrowing the zone costs a little thumb room, while lowering the boost would undo the thing this change is
 * for. **Which of the two is right is a question for a device**, and it is recorded here so that whoever finds it
 * does not start by re-deriving these four rows.
 *
 * **The two axes are separate numbers on purpose.** A `TABLET_SHORT_AXIS`/`LARGE_SHORT_AXIS` pair reads as a
 * tolerance band, which is what it is: nothing in the `600..744` range is a device anybody ships, so the exact
 * threshold cannot be wrong, only far from the edge.
 */
const TABLET_SHORT_AXIS = 600;
const LARGE_SHORT_AXIS = 1024;
const TABLET_SCALE_BOOST = 1.6;
const LARGE_SCALE_BOOST = 1.8;

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
 *
 * **And a device tier on top of it, which is the newest input here.** The fit alone is a *proportion*, and a
 * proportion is the wrong shape of answer for a table: a 10-inch display is not a phone scaled up, it is a phone
 * with more inches, and the arithmetic above spends most of them on the long axis. See the tier constants for the
 * thresholds and the short-axis argument — this function's part in it is one multiplication and one comparison.
 *
 * **`GuiService.ViewportDisplaySize` was researched and is the wrong tool, which is worth recording because it is
 * the documented one.** The API reference defines `Enum.DisplaySize.Small` as *"most tablet/mobile/handheld
 * devices"* — **the same value a phone and an iPad report** — with `Medium` for laptops and monitors and `Large`
 * for TVs. So the engine's own categorisation is a *device class* answer where this file needs a *size* answer; a
 * tablet and a phone are one class to it, and a tier built on it could not separate them. It is also
 * `Read|NotReplicated|ReadParallel` on `GuiService`, i.e. another service to inject into a controller whose only
 * other input is the camera's viewport — and `buildScale` already watches exactly one signal
 * (`ViewportSize`) that changes on precisely the events this cares about (rotation, window resize, device change).
 * **Two sources of truth for one number is the pattern this file has spent four passes deleting**, so the
 * viewport stays the only input.
 */
function scaleFor(viewport: Vector2): number {
	const fit = math.min(viewport.X / REFERENCE_VIEWPORT.X, viewport.Y / REFERENCE_VIEWPORT.Y);

	// **The tier, measured on the short axis** — see the constants above for why it is not `viewport.X`. `>=` at
	// both steps so the classes are exhaustive and a device sitting exactly on a breakpoint lands in the larger
	// one, which is the "give the bigger screen the benefit" direction.
	const short = math.min(viewport.X, viewport.Y);
	const boost =
		short >= LARGE_SHORT_AXIS ? LARGE_SCALE_BOOST : short >= TABLET_SHORT_AXIS ? TABLET_SCALE_BOOST : 1;

	// **The boost is applied before the floor, and the order is what keeps a phone unchanged.** A phone's
	// multiplier is `1`, so this is the expression that was here before it existed; on a tablet the product clears
	// {@link SCALE_MIN} long before the floor is reached, so the floor only decides the sideways-phone case it was
	// written for. `math.max(fit * boost, SCALE_MIN)` with `boost = 1` is `math.max(fit, SCALE_MIN)` — the old line,
	// exactly.
	return math.max(fit * boost, SCALE_MIN);
}

/**
 * **One layout for the whole cluster, as a pure function — and it is a function because a layout instance cannot do
 * this job.**
 *
 * **A `UIGridLayout` forces every cell to the same size**, which is the one thing this cluster cannot have: see
 * {@link BUTTON_WEIGHT} for why Throw and Jump are bigger and why nested `UIListLayout`s are worse rather than
 * better. What is kept from the previous arrangement is the property that made it work at all — **the cluster fits
 * the box it is given, on any aspect ratio, by construction** — with one more degree of freedom: a weight per cell.
 *
 * **Every diameter is `weight × unit` for a single `unit`, and `unit` is the largest value that lets *every* row fit
 * both ways**: across, its circles plus its gaps must fit the box's width; down, its tallest circle and the row's
 * label band must fit an even share of the box's height. The smaller bound wins, so nothing is ever drawn outside
 * the box and no row is ever given more room than another.
 *
 * **A row's buttons are bottom-aligned on a common baseline**, not centred. With one size that distinction did not
 * exist; with mixed sizes it decides whether the six words under the buttons sit on one line or at six different
 * heights. The baseline is the top of the label band, so a small button's circle simply starts lower and its word
 * lands beside the big one's.
 *
 * **A row narrower than the box is still centred by construction**, which is what keeps the pattern a plain array of
 * row counts: `[3, 3]` today, and `[5]` or `[1, 1, 1, 1, 1]` are the same call.
 *
 * **There is no tap floor here any more.** The smallest button is `min(weights) × unit`, so a floor on a button is
 * really a floor on the *box* — and it lives there now, in `boxSize`, where growing the box makes the cluster bigger
 * instead of making the buttons spill out of it. See {@link minimumBox}.
 *
 * `x` is each button's **centre** across the box, `bottom` its **bottom edge** down the box (which is where its label
 * starts, {@link LABEL_GAP} lower), and `size` its diameter. See {@link mount} for where the box is.
 *
 * **Debt, recorded where the code that owes it lives: this file should eventually be migrated to `UIListLayout` +
 * `UIFlexItem(GrowRatio)` per `HANDOFF.md` §9** ("Flexbox over math", "Grids over pixels"). It was deferred because
 * rewriting the layout math alongside the custom jump physics was too high a risk to do blind: the jump shares this
 * box, and a flex layout's exact semantics — how `GrowRatio` distributes free space against each button's base size,
 * and what happens to a row that cannot fit — cannot be confirmed without a device in front of somebody. **The
 * deviation is a decision with an owner, not an oversight**: the extension here is what makes the primary actions
 * bigger than the utilities, and `UIGridLayout` cannot express that at all. The migration should be its own pass,
 * with the emulator open, and it should move the weights onto `GrowRatio` and the floor onto the row's own sizing.
 */
function pack(
	rows: number[],
	weights: number[],
	box: Vector2,
	gap: number,
	labelBand: number,
): Array<{ x: number; bottom: number; size: number }> {
	// **The rows are measured before a single `unit` is chosen**, because the answer is the smallest bound over all
	// of them — measuring and placing in one pass would place the first row at a unit the last row then reduced.
	const rowHeight = (box.Y - (rows.size() - 1) * gap) / rows.size();

	const measured = new Array<{ factors: number[]; sum: number; largest: number }>();
	let cell = 0;
	let unit = math.huge;

	for (const count of rows) {
		const factors = new Array<number>();
		let sum = 0;
		let largest = 0;

		for (let column = 0; column < count; column++) {
			const weight = weights[cell] ?? 1;

			factors.push(weight);
			sum += weight;
			largest = math.max(largest, weight);

			cell++;
		}

		measured.push({ factors, sum, largest });

		unit = math.min(unit, (box.X - (count - 1) * gap) / sum, (rowHeight - labelBand) / largest);
	}

	// **A box too small to hold anything reads as a unit of nought or less.** The caller's floor is what stops that
	// happening; this clamp is so a box that somehow gets past it produces a small cluster rather than NaNs in every
	// button's `Position`.
	unit = math.max(unit, 0);

	const cells = new Array<{ x: number; bottom: number; size: number }>();

	for (let row = 0; row < measured.size(); row++) {
		const here = measured[row];
		const sizes = here.factors.map((weight) => weight * unit);

		let total = (sizes.size() - 1) * gap;
		for (const size of sizes) total += size;

		// **Centred, and the baseline is the band's top edge**, so every word in the row hangs from one line.
		let across = (box.X - total) / 2;
		const bottom = row * (rowHeight + gap) + rowHeight - labelBand;

		for (const size of sizes) {
			cells.push({ x: across + size / 2, bottom, size });

			across += size + gap;
		}
	}

	return cells;
}

/**
 * **The smallest box the cluster may be drawn in, if its smallest button is to be at least {@link TAP_MIN} across.**
 *
 * **The floor used to live inside {@link pack}, and that was the bug this move fixes.** Applying it per button meant
 * a cluster whose buttons were bigger than the box that contained them: they were placed by the packing's positions
 * and drawn at the floor's size, so they overlapped each other, spilled onto the engine's pad and, on a short screen,
 * ran off the top. **A floor on a button is really a floor on the box** — a box grown until its smallest button is
 * tappable, with the packing then doing what it does for any other box.
 *
 * **Exact rather than approximate.** `unit` must be at least `TAP_MIN / smallest`, so every row's width must be at
 * least `sum × unit` plus its gaps, and the box's height `rows × (tallest × unit + band)` plus the gaps between rows
 * — the widest row and the tallest one are the two answers. All of it reads the pattern and the weights, which are
 * constants, and the gap and band, which are the caller's scaled pixels.
 */
function minimumBox(rows: number[], weights: number[], gap: number, labelBand: number): Vector2 {
	const sums = new Array<number>();
	let smallest = math.huge;
	let tallest = 0;
	let cell = 0;

	for (const count of rows) {
		let sum = 0;
		let largest = 0;

		for (let column = 0; column < count; column++) {
			const weight = weights[cell] ?? 1;

			sum += weight;
			largest = math.max(largest, weight);
			smallest = math.min(smallest, weight);

			cell++;
		}

		sums.push(sum);
		tallest = math.max(tallest, largest);
	}

	const unit = TAP_MIN / smallest;

	let across = 0;
	for (let row = 0; row < sums.size(); row++) across = math.max(across, sums[row] * unit + (rows[row] - 1) * gap);

	return new Vector2(
		across,
		rows.size() * (tallest * unit + labelBand) + (rows.size() - 1) * gap,
	);
}

/**
 * **The mobile sprint used to be read from here, and this is where it went.**
 *
 * This file carried a polled stick reader: a recursive search of `PlayerScripts` for `PlayerModule` or
 * `MasterControl`, a second search of `TouchGui` for `ThumbstickFrame.StickImage`, a `pcall`ed `require` of
 * somebody else's `ModuleScript`, and a `GetMoveVector()` call on the table that came back — plus the two
 * `interface`s (`PlayerModuleShape`, `MoveControls`) that described that table. **Two real sessions proved the
 * two primary lookups wrong**: no module anywhere under `PlayerScripts`, and no *visible* stick in the GUI
 * either, so both readers returned `undefined` and the feature was silent rather than wrong.
 *
 * **The replacement is not a fourth lookup — it is a different question, asked of a different object.** The
 * sprint is now read from the body the engine is already walking (`Humanoid:GetMoveVelocity()`, whose own
 * documentation names the quantity this design wants: "the product of `WalkSpeed`, the intended movement
 * direction, and the current percent walk speed"), which needs no module, no GUI, no instance name and no
 * `require`. It lives in `SprintController` beside the keys, because the sprint is one decision with two sensors
 * and this file is a way in rather than a rule. See `SprintController.watchStick`.
 *
 * **And the keyboard's half of it stopped being an input *reader* altogether**: both shift keys are bound through
 * the Input Action System, in that same controller, which is also where the argument is written for why the
 * stick's magnitude could not be a third binding on that action. **Nothing about the cluster changed** — the five
 * buttons, their packing and the engine's jump button are untouched by this.
 */

/** The gap between a button and the word under it. */
const LABEL_GAP = 4;

/**
 * The two states of a button, and **the only thing on this HUD that changes**.
 *
 * **Idle: the theme's plum at the theme's `0.15`.** That is the fill every panel on this HUD wears — see
 * `ui/premiumTheme.ts` — which is what makes the cluster read as part of the interface rather than as six dark
 * discs dropped onto the arena. It is dark enough that the near-white word under each circle stays legible over
 * grass, sky or sand, and thin enough that the game is still visibly behind it: a control over the world should not
 * black the world out.
 *
 * **Down: the theme's crimson, at `0`.** The palette's red is this direction's "this is happening" colour — it is
 * what the Return to Lobby pill turns when it arms, and what side A's score wears — so a held button is the same
 * statement in the same vocabulary rather than a colour invented for a press. Fully opaque, because this is the
 * state that has to be unmistakable at a glance.
 *
 * **And the pair differs in hue, which is the change this pass makes.** It used to be one idea at two opacities —
 * `trough` at `0.6` and `accent` at `0` — which worked because the light palette's accent is a strong blue against
 * a near-black. On this palette a plum "pressed harder" is the same plum, so the held state takes a *different*
 * colour from the five; a state that moves one property reads as a colour that shifted rather than as a button
 * that was pressed.
 */
const IDLE_TRANSPARENCY = PREMIUM.transparency;
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
 * standing**: the sprint was the other, and a sprint is not a button on this HUD at all any more — it is asked for
 * by the input itself, one sensor for the stick and one for the keys, both of them in `SprintController`. It used
 * to be the stick's magnitude read from here; see the note above `LABEL_GAP` for why that reader is gone. Nothing
 * here decides which control is which — the controller behind the button does, and what this table records is only
 * whether there is a second call to make.
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
 * before this existed. **One instance is shared by all six**, because the thing that moves is the box and not the
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
 * The mobile controls: **a box of five buttons packed into the bottom-right corner of the screen.**
 *
 * **The cluster is a box of five buttons in the corner, packed by one formula, and that is the fourth shape.** The
 * first three were arrangements of the *same* idea — place each button relative to the engine's jump button — and
 * each one failed in the same direction: the buttons had to be small, because the pad they were arranged around is
 * never the size anybody assumed, and the geometry that avoided overlapping it kept stretching. The paw was the
 * clearest version of that: a correct derivation of a shape that could not fit a phone.
 *
 * **So this one stops deriving and starts packing.** The six buttons live in a fixed rectangle in the bottom-right
 * corner, and `{@link pack}` sizes them from the box's dimensions — three across the top, three under it, with the
 * two primaries a factor larger than the four utilities (see {@link BUTTON_WEIGHT}). **The box's size is the only
 * thing that decides how big a button is**, so tuning is one number rather than a rebuild-and-look, which is the
 * complaint that killed the last three arrangements.
 *
 * **What the pad is no longer for.** The box used to sit above it — its bottom edge derived from the pad's top
 * edge, on the argument that the pad is where a thumb rests. **That argument was right about the thumb and wrong
 * about the number**: the pad's top edge is 90px off the floor on one of this project's logged devices and 210px on
 * another, so a cluster hung from it was drawn 90–210px too high — which is the complaint this pass answers. The
 * box's edges are the screen's own now, see {@link BOX_EDGE_GAP}; the pad is a thing this file **dresses and
 * hides** rather than a thing it *measures*, and {@link HIDE_ENGINE_JUMP} is the switch that decides whether there
 * is anything on the screen there at all. **The two are no longer neighbours in any sense the layout depends on**,
 * which is the whole of what changed: no bearings, no radius, no arc, no derived edge.
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
 * **The sprint is the exception, and it is no longer in this file at all.** It used to be a sixth circle, and then
 * a polled read of the stick's magnitude from here; it is now two sensors in `SprintController` — the shift keys
 * through the Input Action System, and the mobile stick read from the body the engine is already walking — meeting
 * at one `holdSprint`. **What that costs this file is one injected controller and one method**, and what it buys is
 * that this HUD is now only what its own doc says it is: five buttons, each of them a way into a controller the
 * keyboard already reaches. See the note above `LABEL_GAP` for the reader that was deleted and why.
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
 * **Mounted into `getScreenSpaceGui` rather than the shared HUD `ScreenGui`, and what asks for that now is the
 * corner itself.** Every other HUD here mounts into the shared GUI, which is inset inside Roblox's chrome so that
 * its contents sit in the safe area — a *good* thing for a readout, and the wrong frame for a thumb cluster whose
 * specification is "the bottom-right of the screen". `getScreenSpaceGui` is `ScreenInsets.None`, so its
 * bottom-right corner is the screen's, which is what {@link BOX_EDGE_GAP} measures from; an inset GUI on a phone has
 * its bottom edge above the home indicator, and the cluster would sit that much higher on that device than on the
 * next. **The reason this paragraph used to give — the pad's `AbsolutePosition` being a screen coordinate — is gone
 * with the derivation**, and the choice survived it because the corner is asking for the same thing the pad was.
 * The aim sight needed the same GUI for the same kind of reason, and that GUI's own doc is where the argument is
 * written; see `ui/screenGui.ts`. The shared GUI is still what the rest of this project's furniture mounts into, so
 * this is a second home for the one element that cannot live in the first rather than a departure from it.
 *
 * **Two things here superseded paragraphs above, and both are named rather than edited out of them.** The first is
 * the jump: the paragraph above says a custom jump "never worked" and that the engine's button is therefore kept.
 * It works now — the one-shot write it lost is replaced by a per-frame one with a physics fallback, and the engine's
 * button is *hidden* by default rather than kept. See {@link beginJump}, which carries the whole of why, and
 * {@link HIDE_ENGINE_JUMP}, which is the one constant that puts the old control back. The second is the shape: the
 * paragraph above describes a packing in which "every button gets the same size", and that is no longer what
 * {@link pack} does — it takes a weight per cell, so the two primary actions are drawn a factor larger than the four
 * utilities. {@link BUTTON_WEIGHT} argues why that is still a packing formula rather than a layout instance.
 */
@Controller()
export class MobileControlsController implements OnStart {
	/**
	 * **The four controllers this HUD drives, injected rather than reached for.**
	 *
	 * This is the project's own mechanism — `HANDOFF.md`: *"constructor injection everywhere"*, which is how
	 * `DodgeService`, `BallSpawnerService` and every other service that needs a sibling gets one — and it is
	 * used here for the reason it is used there: a button that had to *find* its controller would be a lookup
	 * with a nil case, and the nil case is a press that silently does nothing. **A constructor parameter cannot
	 * be nil**, so "the paw is wired to the inputs" is a fact the compiler checks rather than a hope.
	 *
	 * **It is the first use of constructor injection on the client**, which is worth saying because the client
	 * has never needed it before: every other HUD here reads an attribute or subscribes to an event, and this is
	 * the first one whose whole job is to *call* controllers that are not its own.
	 *
	 * **Four rather than five, and the missing one is `SprintController`.** It was injected here because the
	 * stick's magnitude was read in this file, and it is not injected any more because it is not: the sprint has
	 * two sensors and both of them live in that controller. See the class doc.
	 */
	constructor(
		private readonly throwController: ThrowController,
		private readonly catchController: CatchController,
		private readonly dodgeController: DodgeController,
		private readonly actionController: ActionController,
	) {}

	/**
	 * Whether the jump step is bound right now.
	 *
	 * **A flag rather than a connection, because `BindToRenderStep` gives nothing back.** The name is the handle; this
	 * is what makes {@link endJump} idempotent and the next press safe.
	 */
	private jumping = false;

	/**
	 * **The custom jump, and the whole of why it works where the last one did not.**
	 *
	 * **The old button set `Humanoid.Jump = true` once, on the press, and the jump never happened.** That is not a
	 * suspicion: the source records the attempt in two places — this file's class doc ("there was a custom jump
	 * button here for two passes and it never worked … the write to `Humanoid.Jump` was lost") and `main.server.ts`
	 * ("a button of ours that wrote `Humanoid.Jump = true` never produced a jump: the `PlayerModule` writes that
	 * flag too, later in the frame"). **`Humanoid.Jump` is not a request, it is a level**: it is read by the
	 * humanoid's physics step, and the `PlayerModule`'s control module rewrites it **every frame** from the input
	 * *it* is holding. A single write from an `InputBegan` handler is therefore a value that is true for a fraction
	 * of a frame and false again before anything reads it — the engine's own button produces a jump precisely
	 * because it keeps that flag true for as long as the finger is down, which is the mechanism this button copies.
	 *
	 * **So this writes it every frame while held**, from a render step — which is the last thing in the frame
	 * before physics — instead of once from an input event. That is the whole bypass: no remote, no
	 * `ContextActionService` rebound action, and nothing asked of the server. The state change rides along so the
	 * *animation* is immediate rather than waiting for the velocity to be noticed, and it is gated on the body
	 * actually standing on something, because `ChangeState(Jumping)` on a body in mid-air is a state the humanoid
	 * would have to contradict a frame later.
	 *
	 * **The humanoid is read fresh on every frame, which is the respawn answer.** Nothing here holds a character:
	 * `Players.LocalPlayer.Character` is asked each time, so a body replaced by a death is jumped by the *new*
	 * humanoid with nothing to re-subscribe — and a press during the respawn gap finds no character and does
	 * nothing rather than writing to a destroyed one. This is the whole reason `CharacterAdded` is not used: a
	 * reference kept across deaths is the stale-humanoid bug, and reading the player's current body is the same fact
	 * without a lifetime to manage.
	 */
	private beginJump(): void {
		this.endJump();

		let elapsed = 0;

		this.requestJump(true);

		// **Bound at `Last` rather than on `RenderStepped`, and that rung is the point.** The flag this writes is
		// rewritten by the `PlayerModule`, and *when* it is rewritten is not something this project can read — so
		// the write is put as late in the frame as the engine allows, which is the only ordering argument available
		// without knowing where the module's own step sits. `Last` is after `Character` (where a control module's
		// per-frame update conventionally runs) and after this project's own camera steps.
		this.jumping = true;

		RunService.BindToRenderStep(JUMP_STEP_NAME, Enum.RenderPriority.Last.Value, (delta) => {
			elapsed += delta;

			if (elapsed > JUMP_HOLD_SECONDS) {
				this.endJump();

				return;
			}

			this.requestJump(false);
		});
	}

	/** Stops asking. Called by the release, by the hold cap, and by the next press. Idempotent. */
	private endJump(): void {
		if (!this.jumping) return;

		this.jumping = false;

		RunService.UnbindFromRenderStep(JUMP_STEP_NAME);
	}

	/**
	 * One frame's worth of "jump", written to whatever body the player has right now.
	 *
	 * **`FloorMaterial` is the gate rather than `Humanoid.Jump`.** The property reads what the *control module*
	 * last wrote, so asking it whether a jump is in progress answers about somebody else's input; whether the feet
	 * are on anything is a fact about the body, and it is also what stops the frame loop from re-entering the
	 * `Jumping` state for the whole hold. A body in the air therefore gets nothing, which is what makes this one
	 * jump per press instead of one per frame.
	 *
	 * **A dead body is refused**, because the loop can run for a quarter of a second and the humanoid it reads on
	 * the third frame may be one that died on the second. Writing `Jump` on a dead humanoid is harmless, but
	 * `ChangeState` on one is a state the respawn would inherit.
	 *
	 * **`first` decides whether the flag is backed up by an impulse, and that belt is what makes the button work
	 * even if the flag is lost again.** On the *first* frame only the flag and the state are written, exactly like
	 * the engine's own button. On every frame after that the body is still asked whether it left the ground — and
	 * a body that is **still standing on it a frame later did not jump**, so the impulse is applied directly to the
	 * root part's velocity. That is self-correcting in both directions: if the flag took, the second frame finds
	 * the body airborne and returns before anything else is written (no double jump, no extra height), and if it
	 * did not, the player jumps anyway. It is the one part of this that does not depend on an ordering this project
	 * cannot see.
	 */
	private requestJump(first: boolean): void {
		const character = Players.LocalPlayer.Character;
		if (character === undefined) return;

		const humanoid = character.FindFirstChildOfClass("Humanoid");
		if (humanoid === undefined || humanoid.Health <= 0) return;
		if (humanoid.FloorMaterial === Enum.Material.Air) return;

		humanoid.Jump = true;

		if (first) {
			humanoid.ChangeState(Enum.HumanoidStateType.Jumping);

			return;
		}

		// **Still grounded a frame after asking, so the flag did not survive the frame.** The speed is the
		// humanoid's own: `JumpPower` where the game uses power, and the launch speed that reaches `JumpHeight`
		// otherwise — `v = sqrt(2 * g * h)` — so a jump this makes is the height a jump this game is configured for.
		const root = humanoid.RootPart;
		if (root === undefined) return;

		const speed = humanoid.UseJumpPower
			? humanoid.JumpPower
			: math.sqrt(2 * Workspace.Gravity * humanoid.JumpHeight);

		const moving = root.AssemblyLinearVelocity;

		root.AssemblyLinearVelocity = new Vector3(moving.X, speed, moving.Z);

		if (DEBUG) print(`[HUD] jump — the flag was lost; impulse applied at ${string.format("%.1f", speed)}`);
	}

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

		// **`hudTheme()` is read here for one number now — the caption line height the label band is measured
		// with** — and that is why it is still a call rather than a constant: big-ui's tables are mutated by
		// `configureTheme`, so a module-level read could capture the defaults depending on load order.
		//
		// **The colours on this HUD come from the game palette instead**, `ui/premiumTheme.ts`, read at each use.
		// The division is the one this pass drew across the whole HUD: `hudTheme` maps big-ui's light palette and is
		// shared with the Store and the Inventory, both of which this direction deliberately leaves alone.
		const theme = hudTheme();

		// **The six controls, and this is only what each one says and does.** Where they sit is {@link pack}'s
		// business now, and this list's order is the order they fill the box — left to right, top row first, which is
		// the order the pattern below is written in:
		//
		//                          [Drop]   [Catch]  [Curve]
		//                          [Dodge]  [Throw]  [Jump]
		//
		// **The second row is the thumb's row, and that is what the order is for.** `Throw` and `Jump` are the two
		// controls a rally is won with and they sit beside each other under the thumb's arc; `Dodge` sits just left
		// of `Throw`, because the answer to a ball that is already coming has to be reachable by the same hand that
		// is about to send the next one. **The top row is what is reached for deliberately rather than reflexively**
		// — `Catch` and `Curve` are aimed, and `Drop` gives the ball away. **No control carries a size here** — the
		// diameters come from one box and one weight per cell, see {@link BUTTON_WEIGHT} and {@link pack}.
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

		// **The jump, which is the one control here that is not a way into another controller.** There is no
		// `JumpController` and there never has been — the humanoid is the whole of it — so this pair calls into *this*
		// file's {@link beginJump}/{@link endJump}, which are the two writers of the body's own jump. See
		// {@link requestJump} for why the press does not simply set `Humanoid.Jump` once and stop.
		const jumpUp: TouchControl = {
			label: JUMP_LABEL,
			down: () => this.beginJump(),
			up: () => this.endJump(),
		};

		// **The fill order, which is the layout.** `pack` reads this array in order — left to right across the top
		// row, then the bottom one — so a reordering here *is* a rearrangement on screen, with no number to keep in
		// step anywhere else. **The weights are indexed by this same order**, so a control moved in this list needs
		// its weight moved with it: see {@link BUTTON_WEIGHT}, which is the one thing here that is not free.
		const controls: TouchControl[] = [drop, catchBall, curve, dodge, throwBall, jumpUp];

		/**
		 * **The packing pattern, which is the whole description of the shape.** Three across the top and three
		 * across the bottom; `[6]` would be one row, `[1, 1, 1, 1, 1, 1]` a column, and nothing else in this file
		 * changes.
		 *
		 * **It has to total the controls**, and the two are checked against each other after the packing rather
		 * than trusted: `pack` counts cells from this array and knows nothing about buttons, so a pattern of
		 * `[3, 1]` would quietly leave one control unbuilt.
		 *
		 * **`[3, 3]` since the jump became ours** — it was `[3, 2]` for the five that were here before, and the
		 * second row is no longer the short one. The jump takes the bottom-right cell, which is the corner a right
		 * thumb reaches without moving, and it is where the engine's own button used to be drawn.
		 */
		const rows: number[] = [3, 3];

		// **The one responsive number on this HUD, and it is built *before* the pad rather than after it**: every
		// size below is written in reference pixels and this turns them into the pixels this screen actually has —
		// and the pad needs it too, because the engine's button is now inside the cluster's multiplier rather than
		// beside it. The order is load-bearing rather than tidy: `restyleEngineJump` measures the button during its
		// own sweep, and a `const` read before its initializer has run is the nil-at-load trap this file's constant
		// block describes, one frame smaller. See {@link buildScale} for the signal it watches.
		const scale = this.buildScale(scope);

		// **The engine's jump button is restyled rather than replaced, and this file now takes nothing back from
		// it.** It used to return the pad's centre and size, because the box was hung off its top edge; the box hangs
		// off the screen's corner now, so the call is made for what it *does* — dress the button, or hide it — rather
		// than for what it reports. It is still the second reader of the multiplier above, which is what keeps a pad
		// that is left visible at the same rate as the buttons beside it. See {@link restyleEngineJump} for the hunt,
		// the restyle and the reason the jump stopped being ours to draw.
		this.restyleEngineJump(scope, scale);

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
					// corner puts it straight back the moment this mode is switched off. See {@link BOX_NUDGE}.
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
		 * **Nothing caps it any more, and the cap that used to be here is worth recording because it was a bug
		 * wearing a safeguard's clothes.** The box's height was clamped to the room above the engine's jump button,
		 * so that on a sideways phone — where a box of the design's height would run off the top — the buttons came
		 * out smaller. **The reading was another element's place rather than this one's**, so the clamp did nothing
		 * on the devices it was written for and pulled the whole cluster up on the ones where the pad sat high: the
		 * pad's top edge is 90px off the floor on one logged device and 210px on another. A box anchored to the
		 * corner needs no such cap — the only thing that could push it off the top is its own height, `0.2277` of
		 * the reference height times a multiplier floored at {@link SCALE_MIN}, which is under a quarter of every
		 * viewport this project has logs for. **A cap whose worst case cannot happen is a second source of truth
		 * about the size**, and this file has spent three passes deleting those.
		 *
		 * **And the floor, which is the box's now rather than each button's.** The smallest button in the cluster
		 * is `min(weights) × unit`, so the way to guarantee a tappable one is to grow the *box* until the packing
		 * gives it that size — see `minimumBox`. The gap and the band are the same scaled pixels the packing is
		 * given one line below.
		 */
		const boxSize = Fusion.Computed(scope, (use) => {
			const multiplier = use(scale);

			const floor = minimumBox(
				rows,
				BUTTON_WEIGHT,
				BOX_GAP * multiplier,
				LABEL_GAP + theme.typography.caption.lineHeight,
			);

			return new Vector2(
				math.max(BOX_SIZE.X * multiplier, floor.X),
				math.max(BOX_SIZE.Y * multiplier, floor.Y),
			);
		});

		/**
		 * The box itself: **a plain frame in the bottom-right corner whose size is the layout.**
		 *
		 * **Both of its edges are the screen's own now, and that is this pass's whole change.** The box's
		 * bottom-right corner sits {@link BOX_EDGE_GAP} in from the screen's bottom-right corner — the place a right
		 * thumb rests without moving, which is what "the bottom-right of the screen" means to the hand using it.
		 *
		 * **The arrangement this replaces hung the box off the engine's jump button**, whose top edge arrives as a
		 * distance down from the screen's *top* (an `AbsolutePosition`). That was defensible while the pad was the
		 * control; it became wrong the moment the pad was hidden, because the pad is not where a thumb rests — it is
		 * **90px off the floor on one of this project's logged devices and 210px on another**, so a cluster hung
		 * from its top edge was drawn that far too high, and the complaint was exactly "the buttons are too high".
		 * **A derived edge is only as good as the thing it is derived from**, and that thing was invisible.
		 *
		 * **Two edges rather than four, because the other two come from the size** — which keeps the box's
		 * *position* independent of its *size* instead of the two being each other's inputs. **No layout instance
		 * goes inside it** — the buttons' positions are written by `pack` — and it has no background, because it is
		 * a footprint rather than a surface.
		 *
		 * **And {@link BOX_NUDGE} moves the whole thing by hand**, which is now a correction of millimetres rather
		 * than of a derivation: a negative `Y` lifts the cluster off the bottom edge on a device whose home indicator
		 * is in the way, and that is the useful direction. See {@link ARRANGE} for finding the number with a finger.
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
				// **One expression, and the same shape on both axes** — which is the point of anchoring to the
				// corner. `AnchorPoint (1, 1)` puts the box's *bottom-right* at this position, so each axis is a
				// scale-1 offset inwards from the screen's right and bottom edges: a gap, then the hand's nudge,
				// in reference pixels and scaled like every other size here.
				//
				// **`Y` positive means *down* and therefore off the bottom edge**, which is why the shipped
				// {@link BOX_NUDGE} is `(0, 0)` and the useful direction here is negative. That reads backwards
				// against the old derivation, where the box hung from a distance measured down from the screen's
				// top and a positive `Y` was how it went lower; see that constant for the flip.
				//
				// **The trap the old shape carried is gone, and it is worth keeping the reason written down.** The
				// position used to mix axes on purpose — a scale-1 offset from the parent's bottom for `Y` beside a
				// scale-0 offset from its top for the pad's edge — and the one version that spelled the pad's top
				// edge as a scale-1 offset from the *bottom* drew the cluster mirrored about the screen's midline,
				// in the top-right corner. **One edge, one number, two spellings.** Two screen edges and no derived
				// distance has nowhere to put that mistake.
				const multiplier = use(scale);
				const hand = use(nudge);

				return new UDim2(
					1,
					-(BOX_EDGE_GAP - hand.X) * multiplier,
					1,
					-(BOX_EDGE_GAP - hand.Y) * multiplier,
				);
			}),
			// **Drawn always, and that is no longer a correction — it is now a consequence.** This used to wait for
			// the engine's jump button (`ARRANGE || jump.found`), because until that button existed the box was hung
			// off a reading that was still `0` and it was drawn across the wrong end of the screen. **The position
			// above names two screen edges and nothing else**, so there is no reading to wait for, and the gate that
			// used to be here would have hidden the entire cluster on the one client that certainly has no engine
			// jump button: a touch client whose movement mode is `Scriptable`, which is exactly what this project's
			// own joystick asks for. **The five buttons are ours and one of them cannot be made to depend on a
			// control that the same feature takes away.** See {@link restyleEngineJump} for the pad's hunt and
			// {@link BOX_EDGE_GAP} for the corner the box is anchored to.
			Visible: true,
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

			return pack(
				rows,
				BUTTON_WEIGHT,
				size,
				BOX_GAP * use(scale),
				LABEL_GAP + theme.typography.caption.lineHeight,
			);
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

		// **And the weights, which fail silently in the other direction.** A `BUTTON_WEIGHT` shorter than the cluster
		// reads as `1` for the cells it does not cover — no crash, no nil, just primary actions drawn the same size
		// as everything else, which is the one thing that array exists to prevent. `pack` cannot tell a short array
		// from a deliberately plain one, so the count is checked here beside the pattern's.
		if (BUTTON_WEIGHT.size() !== controls.size()) {
			warn(`[HUD] ${BUTTON_WEIGHT.size()} button weights for ${controls.size()} controls`);
		}

		for (let index = 0; index < controls.size(); index++) {
			this.buildButton(scope, controls[index], cells, index, arrange).Parent = box;
		}

		// **The hand-move mode announces itself**, because a cluster that does not answer a tap is otherwise
		// indistinguishable from a broken one — and the log is where a person looks first. See {@link ARRANGE}.
		if (DEBUG && ARRANGE) {
			print("[HUD] arrange mode is on — drag the cluster; the nudge it prints goes into BOX_NUDGE");
		}

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
			const reference = pack(rows, BUTTON_WEIGHT, BOX_SIZE, BOX_GAP, LABEL_BAND);
			// **The two indices are read from the fill order, not assumed.** `pack` returns one entry per cell in
			// order, so `[4]` is Throw — the first primary in `mount`'s list — and `[1]` is Catch, a utility. They
			// follow {@link BUTTON_WEIGHT}, which is why they are spelled with a comment rather than as `[0]`/`[1]`
			// as they were before the rows were rearranged.
			const primary = reference[4];
			const utility = reference[1];

			print(
				`[HUD] mobile controls up — the pack: ${controls.size()} buttons, ` +
					`${string.format("%.0f", utility !== undefined ? utility.size : 0)}px utility / ` +
					`${string.format("%.0f", primary !== undefined ? primary.size : 0)}px primary at the ` +
					`reference box, pattern ${rows.join("+")}, gaps ${BOX_GAP}px, ` +
					`box ${string.format("%.0fx%.0f", BOX_SIZE.X, BOX_SIZE.Y)} reference px ` +
					`(${BOX_FRACTION.X} x ${BOX_FRACTION.Y} of the screen), ` +
					`viewport x${string.format("%.3f", Fusion.peek(scale))}` +
					(utility !== undefined && utility.size <= TAP_MIN ? " — BELOW THE TAP FLOOR" : ""),
			);
		}

		/**
		 * **This screen's own numbers, printed at mount — nothing has to arrive first any more.**
		 *
		 * This used to wait up to three seconds for the engine's jump button, because the box's height was capped by
		 * the room above the pad and the packing was therefore being asked to fit a rectangle that did not exist
		 * yet. **The box is anchored to the screen's corner now**, so its size is the design's fraction and nothing
		 * else — see `boxSize` — and the packing is answerable on the first frame. The wait went with the cap; a
		 * `task` kept alive to report a number that is already known is the leak this file's own notes warn about.
		 *
		 * **The two lines together are the whole acceptance argument for the scaling**: the line above is what the
		 * design produces at 393 × 852, and this one is what `pack` produced for the viewport in front of you. See
		 * {@link BOX_FRACTION} and {@link scaleFor}.
		 */
		if (DEBUG) {
			const live = Fusion.peek(cells)[0];
			const box = Fusion.peek(boxSize);

			print(
				`[HUD] the cluster on this screen — ` +
					`${string.format("%.0f", live !== undefined ? live.size : 0)}px buttons, ` +
					`box ${string.format("%.0fx%.0f", box.X, box.Y)}px, ` +
					`viewport x${string.format("%.3f", Fusion.peek(scale))}` +
					(live !== undefined && live.size <= TAP_MIN ? " — AT THE TAP FLOOR" : ""),
			);
		}
	}

	// **The stick's reader — `watchStick` and `findStick`, with their two routes, their `pcall`ed `require` and
	// their `ThumbstickFrame` search — was deleted from here.** See the note above `LABEL_GAP` for why, and
	// `SprintController.watchStick` for what reads the stick now.

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
		control: TouchControl,
		slots: Fusion.UsedAs<Array<{ x: number; bottom: number; size: number }>>,
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

			return packed[index] ?? { x: 0, bottom: 0, size: TAP_MIN };
		});

		const button = Fusion.New(scope, "TextButton")({
			Name: control.label,
			// **The diameter from the packing, and it is per control now** — Throw and Jump are a factor larger than
			// the utilities, which is the whole reason `pack` was kept instead of a `UIGridLayout`. See
			// `BUTTON_WEIGHT` for the factors and `pack` for the fit.
			Size: Fusion.Computed(scope, (use) => {
				const here = use(slot);

				return UDim2.fromOffset(here.size, here.size);
			}),
			// **The position, anchored on the circle's bottom edge.** `slot.bottom` is the top of the row's label
			// band, so buttons of different diameters in one row share a baseline and their words sit on one line —
			// which is what makes a cluster of two sizes read as a layout rather than as a mistake.
			AnchorPoint: new Vector2(0.5, 1),
			Position: Fusion.Computed(scope, (use) => {
				const here = use(slot);

				return UDim2.fromOffset(here.x, here.bottom);
			}),
			// **The idle state, and the two properties are the whole of the difference between the states.** See
			// {@link IDLE_TRANSPARENCY} for the colour and the opacity and for why the held state is a different
			// hue rather than a shorter shadow of the same one.
			BackgroundColor3: PREMIUM.panel,
			BackgroundTransparency: IDLE_TRANSPARENCY,
			BorderSizePixel: 0,
			AutoButtonColor: false,
			// A button whose text is its label would draw the word in the circle; the word is a child below it.
			Text: "",
		});

		// `UDim(1, 0)` — all of it — which is a circle at any size. See the class doc for why the shape is drawn
		// rather than loaded. **The theme's four-pixel corner does not apply here and that is deliberate**: a
		// control under a thumb is a target, and a disc is the shape a thumb reads as one. Every *panel* in this
		// direction is a four-pixel rectangle; the six buttons are the one place the language is round.
		Fusion.New(scope, "UICorner")({ Parent: button, CornerRadius: new UDim(1, 0) });

		// **The theme's neon edge, and the primaries are simply brighter.** The weight half of the old pair is gone —
		// a bloom is a fixed halo, so "twice as thick" no longer distinguishes anything — and the *light* does the job
		// instead: the two primary actions get the full bloom (a `UIShadow`, see `ui/glow.ts`) while the four utilities
		// get a dimmed one, written by tinting the bloom's ink rather than by skipping it, so every button reads as lit
		// and the primaries read as *more* lit. The weight is read from `BUTTON_WEIGHT`, this file's one answer to
		// "which of these is primary", rather than from a second list.
		const primary = (BUTTON_WEIGHT[index] ?? 1) > 1;
		applyGlow(button, primary ? PREMIUM.glow : PREMIUM.sideB);

		// **And a ratio constraint, which is the belt rather than the mechanism.** `pack` already hands every button
		// a square diameter, so on every screen this cluster is measured for there is nothing for this to do. It
		// earns its place on the one case the packing cannot see: a frame in which the button's size and its position
		// disagree — a reflow between the size `Computed` and the position one — where a square that came out a
		// rectangle would be drawn as an **ellipse**, which is the one shape a round button must never be. With the
		// constraint the button stays a circle inside whatever box it is given, and `FitWithinMaxSize`/`Width` is
		// the default pair: fit inside, and let the width decide.
		Fusion.New(scope, "UIAspectRatioConstraint")({ Parent: button, AspectRatio: 1 });

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
			button.BackgroundColor3 = down ? PREMIUM.sideA : PREMIUM.panel;
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
		const label = this.buildLabel(scope, control.label);
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
	 * **It is returned rather than applied in here**, because its two readers want it in two different forms:
	 * {@link mount} multiplies sizes by it, and `restyleEngineJump` folds it into a `UIScale` on somebody else's
	 * button. **One `UIScale` over the whole cluster was the alternative and it cannot work here**: the box's size
	 * and every button's position are computed *from* the multiplier — see `boxSize` and `pack` — so a scale laid
	 * on top of computed sizes would multiply the same number twice.
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
	 * **Nothing hides anything any more** — least of all `TouchControlFrame`, which holds the engine's touch
	 * controls. **The reason it was not hidden has since expired, and the decision has not**: it used to be that
	 * this HUD's sprint read the movement stick out of that frame, and nothing reads it now — the sprint reads
	 * `Humanoid:GetMoveVelocity()` and `TouchJoystickController` replaces the stick outright on a touch client.
	 * What keeps this line here is the *jump button*, which is inside that frame and which this cluster is built
	 * around: **hiding the frame would take the jump with it**, and the jump is the one control this HUD does not
	 * own. See {@link restyleEngineJump}.
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
	 * **Nothing is reported back any more, and that is this pass's subtraction.** The three live readings this
	 * used to return — the pad's centre, its rendered size and whether it had been found — existed because the
	 * cluster's box was hung off the pad's top edge. The box hangs off the screen's corner now, so there is no
	 * consumer left, and a `Fusion.Value` nobody reads is a subscription kept alive to answer a question nobody
	 * asks. **The two facts the cluster does use are still measured here**: the shrink this writes to the pad's
	 * `UIScale`, and the printed evidence of it.
	 *
	 * **The bug the old return fixed is worth keeping written down even though the return is gone.** This
	 * function once reported the button's *top edge*, which the cluster spent as a margin from the bottom of the
	 * screen — one number measured from one edge and used against another, which put the whole cluster in the
	 * top-right corner and cut it in half in landscape. **A number that crosses a boundary has to name the edge it
	 * was measured from**, which is why the corner the box is anchored to now is two scale-1 offsets and nothing
	 * derived.
	 */
	private restyleEngineJump(scope: Fusion.Scope<unknown>, scale: Fusion.UsedAs<number>): void {
		const playerGui = Players.LocalPlayer.WaitForChild("PlayerGui") as PlayerGui;

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

			// **And the button itself goes while this cluster draws its own jump.** One jump control on the screen
			// rather than two, and the hidden one is the engine's — so a client that loses the custom button has a
			// single constant to flip rather than a control to rebuild. See {@link HIDE_ENGINE_JUMP}.
			//
			// **Four properties rather than one, and the three beside `Visible` are not decoration.** `Visible` is
			// what stops the control drawing; `ImageTransparency` is the belt for the frame in which the module has
			// put its sprite back but this pass has not yet run; `BackgroundTransparency` is the same belt for the
			// engine's grey circle; and the `Image` empty above is what stops a later `Visible` restoring the
			// sprite it still holds. **All of it re-runs whenever the module writes any of them** — see `sweep`,
			// where the connections are, and why `Visible = false` on its own was not enough.
			//
			// **This is the appearance pass, so the hidden state lives here rather than beside the connections.**
			// The alternative was two lists of properties to hide — one at find-time and one on the module's
			// rewrites — and the failure that produces is exactly the one reported: the second list missing a
			// property the first had.
			if (HIDE_ENGINE_JUMP) {
				button.Visible = false;
				button.BackgroundTransparency = 1;

				if (button.IsA("ImageButton")) button.ImageTransparency = 1;
			} else {
				button.Visible = true;
			}

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

				const label = this.buildLabel(scope, JUMP_LABEL);
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
			this.paintJump(button, false);
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
			 * **The engine's button is hidden, and staying hidden is this pair of connections rather than the
			 * write in `dress`.**
			 *
			 * **`Visible = false` once was not enough, and the log that found this is worth keeping.** The session
			 * printed `[HUD] engine jump button — … bg … at 1.00, image "rbxasset://textures/ui/Input/
			 * TouchControlsSheetV2.png" at 0.00`, and the player went on seeing the engine's **white arrow**: that
			 * line is the state *before* the restyle, and the reason the arrow outlived the restyle is that
			 * `TouchJump` owns this button. It swaps the sprite between the jump and fall images, it shows and hides
			 * the control as the body becomes able to jump, and it rewrites properties on its own schedule — so a
			 * hide written once at find-time is undone within a second of the first jump.
			 *
			 * **So the appearance pass is re-run whenever any property it owns moves.** That is why `paintParts`
			 * writes four of them rather than only `Visible`: a frame in which the module has restored the sprite and
			 * this has not yet re-hidden the button is a frame the player sees an arrow in.
			 *
			 * **`Image` and `ImageTransparency` are only watched on an `ImageButton`.** `GetPropertyChangedSignal`
			 * *raises* for a property the instance does not have, and the hunt accepts either class (`GuiButton`), so
			 * the narrow pair is a guarded connection rather than a hopeful one.
			 *
			 * **Hiding rather than moving, and the reason belongs to the module rather than to this cluster.** This
			 * button's `Position` and `Size` are written by `TouchJump` every time it re-lays the control out — on a
			 * viewport change, on a device-class change — so a position this file wrote would be reverted within a
			 * second of the first rotation, and the reader would be hiding it again by moving it again. A property
			 * the module does not own, like `Visible`, is the statement that survives those rewrites. **A
			 * `UIScale` of `0` is refused for the neighbouring reason**: that is this file's own size lever (see
			 * `hudScale`), and one property with two meanings is how a pad ends up invisible with no line of code
			 * that visibly says so.
			 */
			const rehide = (): void => {
				if (HIDE_ENGINE_JUMP) paintParts(button);
			};

			// **Watched for the module's writes, not for ours.** Setting a property to the value it already has does
			// not fire its changed signal, so the re-entry this could cause is one extra pass and then silence —
			// `paintParts` writes the same values twice and the second write is a no-op.
			scope.push(button.GetPropertyChangedSignal("Visible").Connect(rehide));

			if (button.IsA("ImageButton")) {
				scope.push(button.GetPropertyChangedSignal("Image").Connect(rehide));
				scope.push(button.GetPropertyChangedSignal("ImageTransparency").Connect(rehide));
			}

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
					this.paintJump(button, true);
				}),
			);
			scope.push(
				button.InputEnded.Connect(() => {
					paintParts(button);
					this.paintJump(button, false);
				}),
			);

			/**
			 * **How small the pad has been made — kept up to date, and nothing else.**
			 *
			 * The engine moves and resizes its button on every viewport change, so the shrink is re-taken from the
			 * same two signals rather than captured once — and this is also where the cluster's own multiplier is
			 * applied, because a viewport change is exactly the moment that changes.
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
			 * **The larger axis rather than `X`**, because the engine's own button is not guaranteed square and a
			 * size taken from the narrow axis would report — and therefore render — a pad smaller than the one on
			 * screen. A button wider than it is tall therefore reads a little bigger than it strictly is, which is
			 * the harmless direction for that mistake to go in.
			 *
			 * **A centre and a size used to be written from here too**, into the record the box was placed from.
			 * That is what this method stopped doing when the box moved to the screen's corner — see the note on
			 * this function's return — so **nothing about the layout reads it now**: it measures to keep the pad at
			 * the cluster's rate and to say so in the log, and for nothing else.
			 */
			const measure = (): void => {
				const rendered = math.max(button.AbsoluteSize.X, button.AbsoluteSize.Y);
				const engineSize = rendered / hudScale.Scale;
				const multiplier = Fusion.peek(scale);
				const visualSize = math.min(engineSize, PAD_SIZE) * multiplier;

				hudScale.Scale = math.min(1, PAD_SIZE / engineSize) * multiplier;

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

			scope.push(button.GetPropertyChangedSignal("AbsolutePosition").Connect(measure));
			scope.push(button.GetPropertyChangedSignal("AbsoluteSize").Connect(measure));
		};

		sweep();
		scope.push(playerGui.ChildAdded.Connect(() => sweep()));
	}

	/**
	 * The engine's button in this HUD's two states, which are the cluster's two states.
	 *
	 * **Two property writes and no tween**, for the reason `buildCell` gives about the cluster's own buttons: a
	 * button is held or it is not, and a fade would leave the colour somewhere between the two at exactly the
	 * moment a player wants to know which one they are in. **The pair is the cluster's own** — `PREMIUM.panel` idle
	 * and `PREMIUM.sideA` held — so the engine's button, on the clients that show it, is painted by the same two
	 * values as the six beside it rather than by a second copy of the idea. See `IDLE_TRANSPARENCY`, which is the
	 * same fill and the same alpha the cluster uses.
	 *
	 * **Kept as a method rather than inlined**, because it has three callers — the discovery, the press and the
	 * release — and one definition is what makes "the pressed state is the cluster's pressed state" a fact
	 * rather than three copies of a hope.
	 */
	private paintJump(button: GuiButton, held: boolean): void {
		button.BackgroundColor3 = held ? PREMIUM.sideA : PREMIUM.panel;
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
	private buildLabel(scope: Fusion.Scope<unknown>, word: string): TextLabel {
		const label = Text(scope, { text: word, variant: "caption", wrap: false });

		label.Size = UDim2.fromOffset(0, 0);
		label.AutomaticSize = Enum.AutomaticSize.XY;
		// **The theme's near-white rather than the light palette's ink.** The word sits under a plum disc now, so
		// the dark ink it used to take would be a label drawn *on* the background rather than on the button — this
		// is the one colour on the cluster that changed for legibility rather than for style.
		label.TextColor3 = PREMIUM.text;
		label.TextTransparency = 0;

		return label;
	}
}
