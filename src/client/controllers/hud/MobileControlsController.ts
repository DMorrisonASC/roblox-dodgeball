import { Controller, OnStart } from "@flamework/core";
import { Text } from "@rbxts/big-ui";
import Fusion from "@rbxts/fusion-3.0";
import { Players, RunService, UserInputService, Workspace } from "@rbxts/services";
import { CATCH_READY_AT, DODGE_READY_AT } from "shared/constants";
import { LOGGING_ENABLED, logInfo, logWarn } from "shared/logger";
import { isMobile } from "../../platform";
import { applyGlow } from "../../ui/glow";
import { hudTheme } from "../../ui/hudTheme";
import { PREMIUM } from "../../ui/premiumTheme";
import { getScreenSpaceGui } from "../../ui/screenGui";
import { ActionController } from "../input/ActionController";
import { CatchController } from "../input/CatchController";
import { DodgeController } from "../input/DodgeController";
import { ThrowController } from "../input/ThrowController";

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
 * **Idle: the theme's near-black at `0.7`, i.e. seven tenths given back to the arena.** This was `PREMIUM.transparency`
 * (`0.15`) — the same glass every panel wears — on the argument that the cluster should read as part of the interface
 * rather than as six dark discs dropped onto the world. **That argument was written for a HUD over a dark background
 * and this one is over bright green turf**, where six near-solid discs at the bottom of the screen are the loudest
 * thing in the frame and fight the game for attention; the report was exactly that, in those words. At `0.7` the arena
 * is what a player sees and the control is a rim: an outline, a bloom (`applyGlow`) and a word, with the world running
 * through the middle of the circle.
 *
 * **The cost, stated rather than discovered: the circle itself is now barely a shape.** What holds it together is the
 * neon edge and the label under it, both of which are opaque — the buttons read as six lit rings rather than six
 * filled discs, which is the Material "outlined" variant and is the intent. Anything that later wants *fill* to carry
 * meaning here (a charge level, a selected state) has to draw it rather than assume the face is visible.
 *
 * **Down: `0.2`, and that alpha now means "almost solid white" rather than "solid red".** Near-opaque rather than
 * fully opaque, deliberately: at `0` a white circle in a bright scene is a hole punched in the screen, and the whole
 * HUD has been glass on glass since the palette arrived. A fifth of the world still showing through keeps a press in
 * that language while making the state unmistakable at a glance.
 *
 * **And the pair is an *inversion* rather than two colours**, which is the change this pass makes. It used to be a
 * hue change — plum to crimson — and before that one idea at two opacities (`trough` at `0.6`, `accent` at `0`). A
 * crimson disc is a statement borrowed from the game's own "this matters" red (the arming pill, side A's score), which
 * is fine on a dark plate and reads as an alarm over grass. **Dark face with white ink, then white face with dark
 * ink**: the press is the *negative* of the idle state, so nothing new is introduced to say "pressed" — see `paint`,
 * which writes both colours together because they are one state, and `paintJump`, which applies the same pair to the
 * engine's own jump button.
 */
const IDLE_TRANSPARENCY = 0.7;
const HELD_TRANSPARENCY = 0.2;

/**
 * **How far a finger may travel from where it landed before the press stops counting — the slop, in pixels: `10`.**
 *
 * **Roblox has no built-in drag threshold, and this is the number that replaces it.** A `GuiButton` reports
 * `InputBegan` when a finger lands on it and `InputEnded` when that finger leaves the screen — wherever it is by
 * then — and nothing in between says "this was a swipe, not a press". So a thumb dragged across the lower-right
 * corner while steering fires whatever button it happened to start on, which is the fault this number exists to
 * stop. The community answer, and what this file now does, is to remember the landing point and measure the travel:
 * past this many pixels the press is a drag and is thrown away.
 *
 * **Ten, and it is a *strict* number on purpose.** On the 393-wide phone this cluster is drawn for, the packing gives
 * every button **72 px** across (see `TAP_MIN`, which records that figure), so this is a seventh of a diameter and a
 * long way under the 36 px radius: a press that stays anywhere near the circle it landed on counts, and anything that
 * has become travel has stopped being a press. A resting thumb on glass reports a couple of pixels of jitter between
 * the press and the release, so the threshold has to clear three or four; ten is the tightest figure that does. The
 * revision before this one used fifteen and the report against it was that swipes still landed — the number moved
 * *down*, which is also the direction that makes the rule strict rather than forgiving.
 *
 * **Screen pixels, not reference pixels, and no multiplication by {@link buildScale}.** What is being measured is
 * the finger's own travel, and a thumb does not wobble further because the circle under it was drawn larger. This
 * is the one distance in this file that is a property of the hand rather than of the layout.
 */
const DRAG_THRESHOLD = 10;

/**
 * **How long a hold button waits before it starts doing anything, in seconds: `0.05`.**
 *
 * **The press is not an event, it is an interval that has to survive its first frames.** A thumb being dragged across
 * the cluster lands on a button for a frame or two on the way past, and with the action fired at `InputBegan` that
 * landing is indistinguishable from a press — which is exactly what was reported. Waiting fifty milliseconds and
 * checking again means the button has to still be under a still finger before anything happens: a drag has moved far
 * more than {@link DRAG_THRESHOLD} by then at any thumb speed, so it is already disqualified.
 *
 * **Fifty milliseconds is three frames at 60 Hz, and it is not added to the charge.** `ThrowController.beginHold` is
 * what starts the clock, so the only cost is that the clock starts 0.05 s after the finger landed — about 8% of
 * `CHARGE_SECONDS`, and invisible to a player watching the arc grow rather than the button. **A release inside this
 * window is a flick rather than a miss**: it is handled at the release instead of being dropped, because a quick tap
 * on Throw is how a mobile player throws at all. See {@link trackRelease}.
 */
const HOLD_CONFIRM_SECONDS = 0.05;

/**
 * **How long a tapped button stays lit after its action runs, in seconds: `0.12`.**
 *
 * A tap now fires at its *release*, which is the moment the finger leaves, so there is nothing left to hold the paint
 * up for. This is the flash that says the tap was accepted — short enough to read as a blink rather than as a state,
 * and deliberately not a press-time paint: a button that lights up when the finger lands is a button claiming to have
 * pressed while the press is still on probation.
 */
const TAP_FLASH_SECONDS = 0.12;

/**
 * **The colour of the progress ring: a pale violet, `#E2D8FF` — the reference's own colour.**
 *
 * **The one colour on this HUD that is not a palette step, and the reason is that the palette has no word for this
 * job.** `premiumTheme`'s five values are four near-blacks (`void`, `panel`, `raised`, `band`), one white (`text`) and
 * one cyan (`gold`/`stroke`/`glow`). A cooldown needs a colour that means *not yet* and then *ready*, and every one of
 * those is spoken for: the darks are the surfaces, the cyan is this cluster's **held** face (see `buildButton`'s
 * `paint`), and white is ink. **A dark-on-dark ring is what an earlier attempt drew and nobody could see it** — the
 * palette cannot express "this is coming back" on a near-black button, so this is a new colour rather than a shade.
 *
 * **Pale violet rather than green, because the ring now sits *beside* the button rather than on it**: it is drawn on
 * the arena floor, in the gap the shrinking button opens up, and it has to read against bright green turf, sand and
 * the red side's paint. A near-white violet does; a mid green does not. It is also what the reference image shows. If
 * a second feature ever wants it, it belongs in `premiumTheme` as a `ready` job; until then it lives here.
 */
const RING_COLOUR = Color3.fromRGB(226, 216, 255);

/** **How solid the ring is: `0.05` — effectively opaque, because it is a *line*, not a surface.** */
const RING_TRANSPARENCY = 0.05;

/**
 * **How far past the hard edge the second keypoint sits, as a fraction of the fill: `0.001`.**
 *
 * **A hard edge needs two keypoints**, because a `UIGradient` interpolates between the keys it is given and a single
 * key cannot be a step. A thousandth of the container is a fraction of a pixel on a 62 px ring, so the edge reads as a
 * line rather than as a fade — which is what makes the fill look like a gauge instead of a soft wipe, and what keeps
 * the two halves' handover invisible at the halfway point.
 */
const SWEEP_EDGE = 0.001;

/**
 * **How thick the ring is, as a fraction of the button's diameter: `0.08` — about 5 px on a 62 px button.**
 *
 * **A Material-style progress indicator is a *hairline* around the control, not a disc**, which is the whole of what
 * the reference shows and the thing every previous attempt here got wrong. The two halves fill a disc; this is how
 * much of that disc the hole leaves showing at its edge. The value is the hole's inset **on each side**, so the hole
 * is sized `1 - 2 × RING_WIDTH` and the visible band is this fraction of the diameter — five pixels of a 62 px ring.
 * That is the weight a control under a thumb wants: thick enough to read at arm's length through the finger covering
 * it, thin enough to look drawn rather than filled.
 */
const RING_WIDTH = 0.08;

/**
 * **How far the button shrinks while its cooldown runs: `0.85`, i.e. 15% of its diameter.**
 *
 * **This number is what makes the ring visible at all, and that is the trick the whole component is built on.** The
 * ring is a sibling *behind* the button at the button's full size, so while the button is at `1` the ring is
 * completely covered by it — and when the button shrinks, the 7.5% of the radius it gives up on every side is exactly
 * the band the ring is drawn in. Nothing about the ring changes between ready and cooling except whether it exists;
 * the *button* is what moves. See {@link COOLDOWN_SHRINK_SECONDS} for the motion and `trackCooldowns` for the three
 * lines that drive it.
 */
const COOLDOWN_SHRINK = 0.85;

/**
 * **How long the shrink and the grow-back take, in seconds: `0.1`.**
 *
 * **Short enough to read as a consequence of the press rather than as an animation about it**, which is Material's own
 * answer for a state change this small: the indicator arrives *with* the action, and a player who presses Catch twice
 * in a second should never see the button mid-move. It is also inside {@link TAP_FLASH_SECONDS}'s neighbourhood, so
 * the press flash and the shrink overlap rather than queue.
 */
const COOLDOWN_SHRINK_SECONDS = 0.1;

/**
 * **The ring's `ZIndex`: `0`, i.e. *behind* the button rather than on it.**
 *
 * **The ladder is the component.** The ring is a sibling of the button inside the same box, one rung below it, at the
 * button's full size: covered while idle, revealed as the button shrinks. Putting it above the button would make it a
 * line drawn across the control's face, which is the thing the reference does **not** show.
 */
const COOLDOWN_Z_INDEX = 0;

/**
 * **The hole's `ZIndex`: `1`, one rung above the fills it has to cover.** See {@link RING_WIDTH} for why the hole
 * exists and {@link COOLDOWN_Z_INDEX} for the ladder it sits on.
 */
const COOLDOWN_HOLE_Z_INDEX = 1;

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

	/**
	 * **What the press does** — once per press, and never twice without a release between them.
	 *
	 * **When it is called depends on which kind of control this is.** A *held* control (the throw, the jump) fires
	 * `HOLD_CONFIRM_SECONDS` after the press, once the finger has proved it is staying put — a charge that waited for
	 * the release would not be a charge, and one that fired at the landing would fire for a thumb passing over the
	 * button. A *tapped* one fires at the **release**, because a tap cannot be told from the first half of a swipe
	 * until the finger has either moved or left. A press that travels past `DRAG_THRESHOLD` calls this not at all, on
	 * either kind. See {@link beginPress} and {@link trackRelease}.
	 */
	readonly down: () => void;

	/** What the release does, for the control that is held rather than tapped. */
	readonly up?: () => void;

	/**
	 * **The attribute that says when this control is ready again — and the whole of whether it gets a cooldown arc.**
	 *
	 * Two controls have one (`Catch`, `Dodge`). The other four do not, and the four are not an oversight:
	 *
	 * - **`Throw` has no cooldown anywhere in this game.** There is no `THROW_READY_AT`, no attribute and no timer on
	 *   either side — `readyAt.ts` has exactly three writers, and they are the catch's, the dodge's and the duck's.
	 *   A throw is gated by having a ball in the hand, which is a *state* rather than a deadline, so there is nothing
	 *   for an arc to count down and **it deliberately has none**. A charge meter was tried on this button and removed
	 *   at the player's request: it is a different fact wearing the same clothes, and one clock on this HUD that means
	 *   something other than "when am I allowed to press this" is worse than none.
	 * - **`Jump` waits on the body landing**, which is a physical fact rather than a window the server opens, and
	 *   `Humanoid.Jump` refuses itself while airborne. An arc would be a second, disagreeing answer.
	 * - **`Drop` and `Curve` are instant.** Dropping is a state change on the hand and the curve is a preference
	 *   toggled between throws; neither has a window that shuts, so neither has anything to show.
	 *
	 * **Saying so here rather than in a list beside `buildButton`** is the same decision the rest of this interface
	 * makes — the table is the description of the cluster, so "this one has a cooldown" belongs in it and a second
	 * table of names would be a second place to forget a control. A control that later grows a clock adds one field
	 * here and gets its arc, its tracker entry and its debug lines from the code that already exists; nothing outside
	 * this interface needs to learn about it.
	 */
	readonly cooldown?: string;
}

/**
 * **One press in flight, as the cluster's global tracker sees it — the record that replaces a button's own events.**
 *
 * **Why a record rather than two locals in `buildButton`, and this is the whole of the rewrite.** A `GuiButton`'s
 * `InputEnded` is only reliable while the finger is *on* the button: drag a thumb off the circle and the pair of
 * events that a press was built out of stops describing the same gesture — the begin happened on the button and the
 * end happens somewhere else, or arrives from an input the button never saw begin. The one thing the engine does
 * report exactly, for the life of the touch and wherever the finger goes, is `UserInputService.InputChanged` /
 * `InputEnded` on the `InputObject` itself. So the button's events are used only to learn **which** input landed on
 * it, and everything after that is measured against the global streams.
 *
 * **`pressed` is not the same question as "is the record live".** A hold waits {@link HOLD_CONFIRM_SECONDS} before
 * calling `control.down()`, so there is a window in which the record exists and nothing has been pressed — and a
 * cancel inside that window has no `up` to make. Liveness is the record's presence in {@link presses}; `pressed` is
 * whether an action is owed a release.
 */
interface Press {
	/** The button this press landed on, kept so a second finger on the same button is refused. */
	readonly button: TextButton;

	/** What the press will call, and — for a hold — the release it owes. */
	readonly control: TouchControl;

	/** **The engine's own input, matched by identity.** Two fingers are two `InputObject`s, not two positions. */
	readonly input: InputObject;

	/** Where the finger landed, in screen pixels. */
	readonly start: Vector2;

	/** Whether `control.down()` has been called and therefore whether a cancel owes `control.up()`. */
	pressed: boolean;

	/** The button's own paint, so a press can light and unlight it without the tracker knowing the theme. */
	readonly paint: (down: boolean) => void;
}

/**
 * **Every press in flight, one per button.** The cluster is the only thing that reads it, and it holds at most six
 * records — two thumbs cannot press more than two buttons at once, and the per-button latch refuses a second finger
 * on one button.
 */
const presses = new Array<Press>();

/** The engine's input point as this file's 2D point. `InputObject.Position` carries a Z that nothing here uses. */
function pointOf(input: InputObject): Vector2 {
	return new Vector2(input.Position.X, input.Position.Y);
}

/** How far a finger has travelled, which is the only thing {@link DRAG_THRESHOLD} is compared against. */
function travel(from: Vector2, to: Vector2): number {
	return from.sub(to).Magnitude;
}

/**
 * **The press on one button, or nothing — the latch that makes one press one press.** `InputBegan` is re-sent for an
 * input that never ended when the window regains focus, so a button that trusted the event would start a second press
 * inside the first.
 */
function pressFor(button: TextButton): Press | undefined {
	for (const press of presses) {
		if (press.button === button) return press;
	}

	return undefined;
}

/** Whether a record is still the live one — presence in the registry is the whole of that question. */
function isLive(press: Press): boolean {
	return presses.indexOf(press) >= 0;
}

/** Drops a record, which is what makes it dead to the global tracker. */
function forget(press: Press): void {
	const index = presses.indexOf(press);
	if (index >= 0) presses.remove(index);
}

/**
 * **A finger landed on a button: the record is made, and — for a hold — the timer that decides whether it was a press.**
 *
 * **Nothing happens at the landing itself, for either kind of control.** A tap cannot fire until it is known to have
 * stayed put, and a hold waits {@link HOLD_CONFIRM_SECONDS} so that a thumb passing over the button on its way
 * somewhere else is gone by the time the action would run. **Nothing is painted either**: the paint is the claim that
 * something was pressed, and this is the moment before that has been decided.
 */
function beginPress(button: TextButton, control: TouchControl, input: InputObject, paint: (down: boolean) => void): void {
	const press: Press = {
		button,
		control,
		input,
		start: pointOf(input),
		pressed: false,
		paint,
	};

	presses.push(press);

	// A tap has nothing to arm: it fires at its release, or not at all. See `trackRelease`.
	if (control.up === undefined) return;

	task.delay(HOLD_CONFIRM_SECONDS, () => {
		// **The one check that has to be made again after a wait.** The record is gone if the finger lifted or slid;
		// a record that is still live here has survived both, which is exactly what "a press rather than a swipe"
		// means.
		if (!isLive(press)) return;

		press.pressed = true;
		paint(true);
		control.down();

		// **Printed here rather than at the landing**, which is the correction the log asked for: `[HUD] X down` used
		// to appear for every finger that touched a button, including the ones this file went on to refuse, so a
		// swipe and a press looked identical in the output. It now means the action ran.
		logInfo(`[HUD] ${control.label} down — still after ${HOLD_CONFIRM_SECONDS}s`);
	});
}

/**
 * **Stands a press down: the record goes, the paint goes, and a hold that had started is ended.**
 *
 * Called from {@link trackMovement} the moment a finger travels past the threshold, which is what makes a dragged
 * press cancel at the frame it becomes a drag rather than at the release that follows it.
 */
function cancelPress(press: Press): void {
	forget(press);

	press.paint(false);

	logInfo(`[HUD] ${press.control.label} press cancelled — a drag, not a tap`);

	if (!press.pressed) return;

	press.pressed = false;
	if (press.control.up !== undefined) press.control.up();
}

/**
 * **A finger moved: any press it belongs to that has travelled past the slop is cancelled.**
 *
 * **Read from `UserInputService.InputChanged` rather than from the button**, which is the point of the rewrite: the
 * global stream keeps reporting a finger that has left the button, and the button's own event does not. The input is
 * matched by **identity** (`press.input === input`), because that is the only thing the engine guarantees about a
 * multi-touch client — two fingers share a `UserInputType` and nothing else.
 *
 * **Walked backwards so a removal cannot skip a record**, which is the one trap in mutating a list while iterating it.
 */
function trackMovement(input: InputObject): void {
	for (let index = presses.size() - 1; index >= 0; index -= 1) {
		const press = presses[index];
		if (press.input !== input) continue;
		if (travel(press.start, pointOf(input)) <= DRAG_THRESHOLD) continue;

		cancelPress(press);
	}
}

/**
 * **The finger left the screen: the press fires, or it does not, and either way the record is finished here.**
 *
 * **This — not the button's `InputEnded` — is the authority on a release.** It arrives wherever the finger has got to,
 * which is the case a press that slid off its circle was losing.
 *
 * **A hold that never started is a flick, and it fires here.** Released inside {@link HOLD_CONFIRM_SECONDS} with no
 * travel, it calls `down()` and `up()` back to back: a quick tap on Throw is how this game is played on a phone, and
 * the confirm delay must not swallow it.
 *
 * **A tap fires only if it stayed put.** The distance is measured again here rather than trusted from
 * {@link trackMovement}, because a flick fast enough to begin and end inside one frame produces no change event at all
 * — and that press is measured for the first time at this line, with the same threshold.
 */
function trackRelease(input: InputObject): void {
	for (let index = presses.size() - 1; index >= 0; index -= 1) {
		const press = presses[index];
		if (press.input !== input) continue;

		const moved = travel(press.start, pointOf(input));

		forget(press);

		if (press.control.up !== undefined) {
			// **A drag that began and ended inside one frame.** Nothing was ever pressed, so nothing is ended; a hold
			// that *had* committed before the flick gets its release, which is the only way out of it.
			if (moved > DRAG_THRESHOLD) {
				press.paint(false);

				if (press.pressed && press.control.up !== undefined) press.control.up();

				continue;
			}

			// **A flick: released inside the confirm window with the finger still.** `down` and `up` back to back, and
			// the same flash a tap gets — without it the flick's paint would be the one thing in this file that nothing
			// ever took back down.
			if (!press.pressed) {
				press.control.down();
				press.control.up();

				logInfo(`[HUD] ${press.control.label} down — a flick, released inside the confirm window`);

				press.paint(true);
				task.delay(TAP_FLASH_SECONDS, () => press.paint(false));

				continue;
			}

			// **A hold that was running: unpaint, then release.** The order is the reverse of the commit's for the
			// reason the commit's is what it is — the paint is the visible claim, and it should be true for exactly as
			// long as the action is.
			press.paint(false);
			press.control.up();

			logInfo(`[HUD] ${press.control.label} up`);

			continue;
		}

		if (moved > DRAG_THRESHOLD) {
			// **A tap that is refused says so, with the distance that refused it.** This branch used to be silent, and
			// silence is the one answer a player cannot act on: "I tapped Catch and nothing happened" has two very
			// different causes — the press never reached this file at all (the finger missed the button, or something
			// took focus) and the press arrived and was measured as a drag — and only the number in this line tells
			// them apart. A tap on a 70 px button that travels `14px` is a thumb, not a swipe.
			logInfo(`[HUD] ${press.control.label} tap lost — moved ${string.format("%.0f", moved)}px`);

			continue;
		}

		press.control.down();

		// **And an accepted tap prints how far it moved**, which is the number to compare with {@link DRAG_THRESHOLD}
		// when a button feels unreliable on one device rather than another.
		logInfo(`[HUD] ${press.control.label} tap — ${string.format("%.0f", moved)}px of travel`);

		// **The only paint a tap ever gets**, and it arrives after the action rather than before it — see
		// `TAP_FLASH_SECONDS`. A second tap inside the flash simply restarts it.
		press.paint(true);
		task.delay(TAP_FLASH_SECONDS, () => press.paint(false));
	}
}

/**
 * **One button's cooldown: the ring that fills behind it, the two halves that draw it, and the value that shrinks the
 * button to reveal it.**
 *
 * **A ring around the control that only exists while the control is cooling — a Material progress indicator on a
 * FAB.** The earlier shapes this went through are worth keeping as a list, because each one failed for a reason the
 * next one had to answer: a full-button disc that *drained* was two near-blacks apart and could not be seen; a
 * full-button wedge that *filled* was correct but read as the button changing colour; a small corner dial was the right
 * idea in the wrong place, because a 21 px widget competes with the button's own label for attention and is covered by
 * the thumb that just pressed it. What is left is the shape the reference shows — **a hairline ring at the button's
 * own diameter** — and the trick that makes it legible without decorating the control: the ring sits *behind* the
 * button and the button **shrinks** to reveal it. See {@link COOLDOWN_SHRINK} and `addCooldownOverlay`.
 *
 * **Which half is which is the direction of the sweep, and it is clockwise.** The ring starts at 12 o'clock and grows
 * 12 → 3 → 6 → 9 → 12: the **right** half covers the first 180° (0 to 50% of the wait) and the **left** half covers
 * the second. See {@link rightHalfAngle} and {@link leftHalfAngle} for the two expressions, and `addArcHalf` for the
 * geometry that makes a gradient's rotation carve a wedge rather than a chord.
 *
 * **`total` is measured rather than configured, and that is the decision worth stating.** The server publishes an
 * *instant* (`CATCH_READY_AT` is `Workspace.GetServerTimeNow() + seconds`), not a duration — see `readyAt.ts`, whose
 * doc argues for exactly that — so a client wanting a fraction has two choices: re-derive the length from the same
 * config arithmetic the server used, or read it off the first frame the cooldown is visible, when the remaining time
 * *is* the total. The second is what happens here. It costs a small inaccuracy and buys one number instead of two
 * files' worth of them: `CATCH_BUSY_SECONDS` is `WINDOW + LOCKOUT` in `CatchService` and a copy of that sum here would
 * be a second place to keep it right, which is the drift this codebase refuses everywhere else.
 *
 * **What the inaccuracy is, stated.** A cooldown first seen mid-flight — the ring mounts while a catch is already
 * running, or a second press extends one — takes the *remaining* as its total, so the ring starts part-filled and
 * reaches full before the button is actually ready, then sits full for the tail. On this HUD the ring is invisible
 * until a press, and a press starts its cooldown at the same moment, so the case that can hit it is an extension.
 */
interface CooldownRing {
	/** The control's word, so a log line about this ring names the button rather than an attribute. */
	readonly label: string;

	/** The circular clip both halves live in — a sibling of the button, behind it, at the button's full diameter. */
	readonly container: Frame;

	/** The right half's edge — the first 180° of the sweep, 12 o'clock to 6. See {@link rightHalfAngle}. */
	readonly rightGradient: UIGradient;

	/** The left half's edge — the second 180°, 6 o'clock back round to 12. See {@link leftHalfAngle}. */
	readonly leftGradient: UIGradient;

	/** The `Player` attribute holding the instant this control is ready — `CATCH_READY_AT`, `DODGE_READY_AT`. */
	readonly attribute: string;

	/**
	 * **The value the button's size tweens toward: `1` while ready, {@link COOLDOWN_SHRINK} while cooling.**
	 *
	 * This is the ring's *other* half. The ring itself is a static drawing — it is hidden or shown, never resized — and
	 * everything that moves during a cooldown is here, on the button. That split is what keeps the indicator legible:
	 * a ring that grew while a button also grew would be two motions saying one thing.
	 */
	readonly shrinkGoal: Fusion.Value<number>;

	/** How long this cooldown lasts, taken from the first frame it was seen. See this interface's doc. */
	total: number;

	/** Whether the arc was drawn on the previous frame, so a hidden ring costs two comparisons and no writes. */
	showing: boolean;
}

/** Every ring on the cluster, one per control that carries a `cooldown`. Two today: Catch and Dodge. */
const cooldowns = new Array<CooldownRing>();

/**
 * **The `Transparency` ramp that turns a rotated gradient into a half-plane — a hard edge through the centre.**
 *
 * **A `UIGradient` is linear, so this is one straight edge and not an arc in itself.** What makes it an arc is where
 * it is *placed*: both halves use this same ramp inside a fill the size of the whole container, whose centre is the
 * container's centre, so the edge always passes through that centre — which is a **radius**, not a chord. Rotating
 * the gradient rotates the radius, and the clipped half (see `addArcHalf`) shows the wedge behind it.
 *
 * **The two keypoints at `0.5` are the whole trick, and one of them is why `SWEEP_EDGE` exists.** Transparency `0` is
 * opaque and `1` is clear, so `0 → 0` up to the midpoint and `1 → 1` from it would in principle be a step; in
 * practice a sequence with a single pair of keypoints interpolates, so the step is spelled as two keypoints a
 * thousandth apart. That is well under a pixel on a 21 px corner arc: the boundary reads as a line.
 *
 * **The opaque half is the *first* half of the ramp**, i.e. the side the gradient points away from. Which way that
 * ends up facing is entirely `Rotation`'s business — see {@link rightHalfAngle} and {@link leftHalfAngle}.
 */
function wedge(): NumberSequence {
	return new NumberSequence([
		new NumberSequenceKeypoint(0, 0),
		new NumberSequenceKeypoint(0.5, 0),
		new NumberSequenceKeypoint(0.5 + SWEEP_EDGE, 1),
		new NumberSequenceKeypoint(1, 1),
	]);
}

/**
 * **Where the right half's edge sits when the cooldown starts: `0°`, and the right half-frame shows nothing.**
 *
 * A gradient at `0` points right, so the opaque half-plane is the **left** half of the container — and the right
 * half-frame, which is the only part of it that is drawn first, therefore shows nothing. That is "empty", and it is a
 * *value* rather than a hidden instance so the arc has exactly one way to be invisible: `container.Visible`.
 */
const RIGHT_EMPTY_ROTATION = 0;

/**
 * **Where the left half's edge sits at the halfway handover: `180°`, which is the right half's *full* end.**
 *
 * A gradient at `180` points left, so the opaque half-plane is the **right** half; the right half-frame is therefore
 * drawn complete and the left half-frame shows nothing. The handover is exact — the right half has just finished at
 * `180` and the left half starts at `180` — so at 50% the arc is one unbroken semicircle with no seam.
 */
const LEFT_EMPTY_ROTATION = 180;

/**
 * **The right half: the first 180° of a clockwise sweep, in degrees, for `progress` (0 to 1) of the way back.**
 *
 * Positive rotation is clockwise (the Creator reference says so in as many words), and a gradient's edge always runs
 * through the container's centre — which is what makes this a radius sweeping 12 o'clock → 3 o'clock → 6. The value
 * is capped at `180` with a `math.min` rather than by a branch, because past the handover the right half must *stay*
 * complete while the left one takes over; a cap says that in one expression.
 */
function rightHalfAngle(progress: number): number {
	return math.min(RIGHT_EMPTY_ROTATION + 360 * progress, 180);
}

/**
 * **The left half: the second 180°, 6 o'clock → 9 o'clock → 12, for `progress` (0 to 1) of the way back.**
 *
 * It holds at `180` for the whole first half of the wait — which is the state that shows nothing, see
 * {@link LEFT_EMPTY_ROTATION} — and then sweeps to `360` (`≡ 0`), where the opaque half-plane is the left half and
 * the left frame is drawn complete. At `progress` 1 both halves are full and the next frame hides the container.
 */
function leftHalfAngle(progress: number): number {
	if (progress <= 0.5) return LEFT_EMPTY_ROTATION;

	return LEFT_EMPTY_ROTATION + 360 * (progress - 0.5);
}

/**
 * **One half of the arc: a clipped semicircle with a container-sized disc inside it, and the gradient that carves it.**
 *
 * **This is the "two half-circle" construction, and the reason it works is that a gradient's hard edge always runs
 * through the frame's centre.** The fill is the size of the *whole container* (`2, 1` inside a half that is `0.5, 1`),
 * so its centre is the container's centre; the half-frame clips the result to one side. What is left is a **wedge** —
 * a radius sweeping out from the centre — whose angle is set by the gradient's `Rotation`. That is a true radial
 * sweep, not a chord: rotating the edge about the centre is exactly rotating a radius, because the edge passes
 * through the centre at every angle.
 *
 * **The transparency sequence is the hard edge**, `{0: clear… }` — opaque for the first half of the gradient and
 * clear for the second, with {@link SWEEP_EDGE} between them so it is a line rather than a fade. Which *side* of the
 * edge is opaque is decided by the rotation, and that is the whole state this arc has.
 *
 * **`offset` is where this half starts across the container** (`0` for the left, `0.5` for the right), and the fill's
 * `Position` is derived from it rather than passed: `-2 * offset` puts the fill's left edge at the container's left
 * edge in both halves, which is what makes the two gradients measure the same axis from the same origin.
 */
function addArcHalf(container: Frame, name: string, offset: number, rotation: number): UIGradient {
	const half = new Instance("Frame");
	half.Name = name;
	half.Size = UDim2.fromScale(0.5, 1);
	half.Position = UDim2.fromScale(offset, 0);
	half.BackgroundTransparency = 1;
	half.BorderSizePixel = 0;
	// **The first of the two clips.** Without it the fill below would cover the whole container from either half.
	half.ClipsDescendants = true;
	// **Explicit, so the ladder does not depend on which `ZIndexBehavior` this GUI happens to have**: fills `0`, halves
	// `0`, the hole `1`. Under `Sibling` the hole is above the halves because it is the later child of the container;
	// under `Global` it is above them because `1 > 0`. Both answers are the one this needs.
	half.ZIndex = COOLDOWN_Z_INDEX;
	half.Parent = container;

	const fill = new Instance("Frame");
	fill.Name = "Fill";
	fill.Size = UDim2.fromScale(2, 1);
	fill.Position = UDim2.fromScale(-2 * offset, 0);
	fill.BackgroundColor3 = RING_COLOUR;
	fill.BackgroundTransparency = RING_TRANSPARENCY;
	fill.BorderSizePixel = 0;
	// **The fill is a circle in its own right, and that is the correction a screenshot cost.** The container carries a
	// `UICorner` and clips its children, but **a clip does not carry a rounded corner down two levels**: the half below
	// is clipped to its *rectangle*, so a fill that relied on the container for its shape came out as a **square** — and
	// with the hole punched in the middle of it, the "ring" was a square frame with a round hole: exactly what was
	// reported. The fill is `2 × 1` of a `0.5 × 1` half, i.e. a square the size of the container, so one `UICorner` at
	// `(1, 0)` makes it a circle at any diameter; the half's rectangular clip then cuts that circle into a semicircle,
	// which is the shape this whole construction wants. **The two clips now do one job each** — the half's rect makes
	// the semicircle, the fill's own corner makes the circle — instead of both depending on one corner that is not
	// applied where it is needed.
	fill.ZIndex = COOLDOWN_Z_INDEX;
	fill.Parent = half;

	const fillCorner = new Instance("UICorner");
	fillCorner.CornerRadius = new UDim(1, 0);
	fillCorner.Parent = fill;

	const gradient = new Instance("UIGradient");
	gradient.Name = "Edge";
	gradient.Transparency = wedge();
	gradient.Rotation = rotation;
	gradient.Parent = fill;

	return gradient;
}

/**
 * **Builds and registers one control's progress ring.** Called from `buildButton` for the two controls whose
 * `TouchControl` names a cooldown, so the four that have none pay nothing at all — no instance, no entry in
 * {@link cooldowns}, and no per-frame work.
 *
 * **Nine instances per control**: the container, its `UICorner`, two clipped halves, two fills, two gradients and the
 * hole that turns the wedge into a ring. Built once at mount; then two rotations and one `Value` do all the work.
 *
 * **The ring is a *sibling* of the button, one `ZIndex` below it, at the button's full size — and that is the whole
 * of the reveal trick.** A child of the button could not do this: under `ZIndexBehavior.Sibling` a child always draws
 * *above* its parent, so a ring inside the button would be a line across the control's face. Sitting behind it, at
 * the same size, the ring is completely covered while the button is at its full diameter, and the moment the button
 * shrinks to {@link COOLDOWN_SHRINK} the 7.5% of the radius it gives up on every side is exactly the band the ring
 * lives in. **Nothing about the ring is animated to reveal it — the button moves and the ring is simply there.**
 *
 * **This is the Material pattern the brief describes, and it is the same idea as a `CircularProgressIndicator` inside
 * a `FloatingActionButton`.** Material's morphing FAB reveals its icon by *shrinking back to a disc*; here the control
 * shrinks and the indicator is what is left showing around it. See {@link COOLDOWN_SHRINK} for the number and
 * {@link COOLDOWN_SHRINK_SECONDS} for the motion.
 *
 * **Nothing renders unless a cooldown exists**: the container starts hidden, is shown only while the attribute is in
 * the future, and is hidden again the frame the wait ends. The button is therefore never shaded and never decorated —
 * see `trackCooldowns`, which is the only thing allowed to show it.
 *
 * **`Active` is deliberately left at its default `false`.** A `Frame` that is not `Active` does not take part in the
 * engine's GUI picking. This one is behind a button that *is* the target, so it could not steal a press in any case,
 * but the property is the statement of that intent.
 */
function addCooldownOverlay(
	scope: Fusion.Scope<unknown>,
	box: Frame,
	slots: Fusion.UsedAs<Array<{ x: number; bottom: number; size: number }>>,
	index: number,
	label: string,
	attribute: string,
	shrinkGoal: Fusion.Value<number>,
): void {
	const container = new Instance("Frame");
	container.Name = `Cooldown${label}`;
	container.AnchorPoint = new Vector2(0.5, 1);
	container.BackgroundTransparency = 1;
	container.BorderSizePixel = 0;
	// **The circle *is* the clip.** `ClipsDescendants` on a frame carrying a full `UICorner` clips its children to the
	// rounded shape, which is what turns two half-rectangles of fill into two semicircles — and what keeps the ring
	// round rather than letting its corners show.
	container.ClipsDescendants = true;
	container.Visible = false;
	container.ZIndex = COOLDOWN_Z_INDEX;
	container.Parent = box;

	// **The button's own geometry, read from the same packing slot**, so the ring follows a rotation or a resized
	// screen exactly as the button does — see `buildButton`'s `slot` for why these are `Computed`s rather than
	// numbers. **Not shrunk, deliberately**: the ring is the full-diameter reference the button shrinks *inside*, so
	// the band it occupies is whatever the shrink gives up.
	//
	// **`Hydrate` rather than assignment**, because this frame is built by hand and a `Computed` cannot be written to
	// a property — Fusion applies it, and keeps it applied, from here.
	Fusion.Hydrate(scope, container)({
		Size: Fusion.Computed(scope, (use) => {
			const here = use(slots)[index];
			const size = here !== undefined ? here.size : TAP_MIN;

			return UDim2.fromOffset(size, size);
		}),
		Position: Fusion.Computed(scope, (use) => {
			const here = use(slots)[index];
			if (here === undefined) return new UDim2(0.5, 0, 1, 0);

			return UDim2.fromOffset(here.x, here.bottom);
		}),
	});

	const circle = new Instance("UICorner");
	circle.CornerRadius = new UDim(1, 0);
	circle.Parent = container;

	// **The right half first and the left half second, which is the *order of the sweep*, not the order of drawing.**
	// Clockwise from 12 o'clock means the right half is the first 180° of the wait — see {@link rightHalfAngle}. Both
	// start at their *empty* end, so the frame between the container being shown and the first update paints nothing
	// rather than a full circle.
	const rightGradient = addArcHalf(container, "RightHalf", 0.5, RIGHT_EMPTY_ROTATION);
	const leftGradient = addArcHalf(container, "LeftHalf", 0, LEFT_EMPTY_ROTATION);

	// **The hole, and without it this is a pie chart rather than a ring.** The two halves fill a *disc*; this disc,
	// transparent and clipped by nothing, is not what draws the ring — it is what *hides* the middle of the wedge, so
	// only the outer band of {@link RING_WIDTH} is left. It is painted `PREMIUM.void` at full opacity rather than in
	// the button's glass: it sits behind the button and over the arena, so "the button's colour" is not a thing it can
	// be — a dark disc under a dark button reads as the button's own shadow, which is exactly the Material look.
	//
	// **And now that the button is glass at {@link IDLE_TRANSPARENCY} (`0.7`) the hole is doing a second job, which is
	// worth naming because it is the one thing this transparency change alters about the ring.** The wedge is drawn
	// underneath the *whole* control, so at 70% see-through its lavender would tint the button's face for the length of
	// the cooldown — the "the button changes colour" look that was already rejected once. This disc covers all of that
	// interior opaquely, so the only part of the wedge a player can see is the band outside the control, i.e. the ring
	// itself. The side effect is deliberate and readable: **a cooling button is backed and therefore looks solid, a
	// ready one looks like glass** — the two states of the control and the two states of the face now agree.
	const hole = new Instance("Frame");
	hole.Name = "Hole";
	hole.AnchorPoint = new Vector2(0.5, 0.5);
	hole.Position = UDim2.fromScale(0.5, 0.5);
	hole.Size = UDim2.fromScale(1 - 2 * RING_WIDTH, 1 - 2 * RING_WIDTH);
	hole.BackgroundColor3 = PREMIUM.void;
	hole.BackgroundTransparency = 0;
	hole.BorderSizePixel = 0;
	// **Above the two fills, which are at the default `1`.** It is a sibling of the halves rather than a child of
	// either, so one number here puts it over both.
	hole.ZIndex = COOLDOWN_HOLE_Z_INDEX;
	hole.Parent = container;

	const holeCorner = new Instance("UICorner");
	holeCorner.CornerRadius = new UDim(1, 0);
	holeCorner.Parent = hole;

	cooldowns.push({ label, container, leftGradient, rightGradient, attribute, shrinkGoal, total: 0, showing: false });
}

/**
 * **One frame of every arc: read the clock behind it, work out the fraction, and turn the two halves.**
 *
 * **One kind of clock: the server's instant, read off the `Player`.** `CATCH_READY_AT` and `DODGE_READY_AT` are
 * written by `readyAt.ts` as *when this action is ready again*, and everything here is a division of what is left of
 * that against the total captured when the arc appeared. **Throw has no entry in this loop and no arc**, because it
 * has no such instant anywhere in the game — see {@link TouchControl.cooldown}.
 *
 * **A `RenderStepped` step rather than a `Computed` over a Fusion value**, and the reason is the shape of the input.
 * The cooldown arrives as an *attribute*, and an attribute read inside a `Computed` is a sample rather than a
 * dependency — the lesson `RespawnHudController` records — so a binding would need
 * a `Value` fed by `GetAttributeChangedSignal` *and* a second `Value` fed per frame by the clock, which is the loop
 * below written twice with a graph in the middle. One step over two records is less machinery for the same result,
 * and `RenderStepped` is the right step for a thing drawn rather than simulated.
 *
 * **A ring with nothing to show costs one attribute read and two comparisons.** Visibility and the shrink goal are
 * written only on the frames they change, and the two rotations are two arithmetic results assigned to two properties
 * — no instance is created, destroyed or re-parented per frame.
 */
function trackCooldowns(): void {
	const player = Players.LocalPlayer;
	const now = Workspace.GetServerTimeNow();

	for (const ring of cooldowns) {
		const readyAt = player.GetAttribute(ring.attribute);
		const remaining = typeIs(readyAt, "number") ? readyAt - now : 0;

		if (remaining <= 0) {
			if (ring.showing) {
				ring.showing = false;

				// **Both halves of the indicator are put back on the same frame**: the ring disappears and the button
				// grows back to its full diameter, over {@link COOLDOWN_SHRINK_SECONDS}. The two are deliberately
				// written together rather than sequenced, because they are one fact — *this control is ready* — and a
				// ring that vanished after the button had grown, or the reverse, would read as two events.
				//
				// **Nothing is reset on the gradients.** They are recomputed from `progress` on every frame the ring is
				// visible, so the next cooldown's first frame writes both rotations before anything is drawn.
				ring.container.Visible = false;
				ring.shrinkGoal.set(1);

				logInfo(`[HUD] cooldown finished — ${ring.label}`);
			}

			continue;
		}

		// **The total is taken on the frame the ring appears**, which is the frame a press started it — see the
		// interface's doc for what that costs on an extension.
		if (!ring.showing) {
			ring.showing = true;
			ring.total = remaining;
			ring.container.Visible = true;
			ring.shrinkGoal.set(COOLDOWN_SHRINK);

			// **Said out loud, because a ring that never appears and a ring that appears invisibly look identical in a
			// screenshot.** Two lines per cooldown, at its two edges, and the pair is the whole diagnostic: a `started`
			// with no `finished` is a clock that never came back (the attribute stopped being written), and neither
			// line at all means the button never published — which for Catch and Dodge is a refused press rather than
			// a broken arc. The seconds are the wait *as the client reads it*, so they are also a check on the clock.
			if (LOGGING_ENABLED) {
				logInfo(
					`[HUD] cooldown started — ${ring.label}, ${string.format("%.1f", remaining)}s ` +
						`(arc ${string.format("%.0f", ring.container.AbsoluteSize.X)}px)`,
				);
			}
		}

		// **The fraction that has come *back*, not the fraction left.** 0 on the frame the press landed and 1 when the
		// control is ready again — the direction the arc has to grow in, and the whole reason this is `1 - remaining`.
		const progress = math.clamp(1 - remaining / math.max(ring.total, 0.001), 0, 1);

		// **Two rotations, and the ranges are the whole of the maths.** {@link rightHalfAngle} and
		// {@link leftHalfAngle} own them, so this loop says *when* they are written and those two functions say
		// *what* they are — which is the pair that has to stay continuous across the halfway handover, and the pair
		// that a reader can check against a circle without reading this file's drawing code.
		ring.rightGradient.Rotation = rightHalfAngle(progress);
		ring.leftGradient.Rotation = leftHalfAngle(progress);
	}
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

		logInfo(`[HUD] jump — the flag was lost; impulse applied at ${string.format("%.1f", speed)}`);
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
			logInfo("[HUD] mobile controls skipped — this device has a keyboard");

			return;
		}

		const scope = Fusion.scoped();

		// **The cluster's two global input streams, connected once rather than once per button.** This pair is the
		// rewrite's core: a button's own events say only *which* input landed on it, and everything after that — has it
		// moved, has it lifted, has it left the circle — is asked of `UserInputService`, which keeps reporting a finger
		// for as long as it is on the screen. A `GuiButton`'s own pair stops being a description of the gesture the
		// moment the thumb slides off it, which is the fault that made a swipe press a button.
		scope.push(UserInputService.InputChanged.Connect((input) => trackMovement(input)));
		scope.push(UserInputService.InputEnded.Connect((input) => trackRelease(input)));

		// **And the cooldown arcs' clock**, one step for every arc on the cluster — two of them today. See
		// `trackCooldowns` for why this is a render step rather than a `Computed` over the same attribute.
		scope.push(RunService.RenderStepped.Connect(() => trackCooldowns()));

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
			//
			// **And no arc, deliberately.** A throw is gated by a ball in the hand, not by a clock, so there is no
			// wait to draw — see {@link TouchControl.cooldown}.
			down: () => this.throwController.beginHold(),
			up: () => this.throwController.endHold(),
		};
		const catchBall: TouchControl = {
			label: "Catch",
			down: () => this.catchController.press(),
			// **The one cooldown on this HUD that is a window rather than a wait**: `CatchService` shuts the pair for
			// the attempt plus the lockout, and publishes the instant it ends. See `CooldownRing`.
			cooldown: CATCH_READY_AT,
		};
		// **The dodge's direction is the stick's**, which is the one place this cluster makes a decision the
		// keyboard did not have to: there are no movement keys to read, so the body is asked where it is going.
		// See `DodgeController.push` for the read and for why a centred stick refuses rather than guesses.
		const dodge: TouchControl = {
			label: "Dodge",
			down: () => this.dodgeController.push(),
			// The lockout after a dodge, published by `DodgeService` through the same `publishReadyAt` the catch uses.
			cooldown: DODGE_READY_AT,
		};
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
						logInfo(
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
			logWarn(`[HUD] the pattern ${rows.join("+")} packs ${patterned} cells for ${controls.size()} controls`);
		}

		// **And the weights, which fail silently in the other direction.** A `BUTTON_WEIGHT` shorter than the cluster
		// reads as `1` for the cells it does not cover — no crash, no nil, just primary actions drawn the same size
		// as everything else, which is the one thing that array exists to prevent. `pack` cannot tell a short array
		// from a deliberately plain one, so the count is checked here beside the pattern's.
		if (BUTTON_WEIGHT.size() !== controls.size()) {
			logWarn(`[HUD] ${BUTTON_WEIGHT.size()} button weights for ${controls.size()} controls`);
		}

		for (let index = 0; index < controls.size(); index++) {
			this.buildButton(scope, controls[index], cells, index, arrange, box);
		}

		// **The hand-move mode announces itself**, because a cluster that does not answer a tap is otherwise
		// indistinguishable from a broken one — and the log is where a person looks first. See {@link ARRANGE}.
		if (LOGGING_ENABLED && ARRANGE) {
			logInfo("[HUD] arrange mode is on — drag the cluster; the nudge it prints goes into BOX_NUDGE");
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
		if (LOGGING_ENABLED) {
			const reference = pack(rows, BUTTON_WEIGHT, BOX_SIZE, BOX_GAP, LABEL_BAND);
			// **The two indices are read from the fill order, not assumed.** `pack` returns one entry per cell in
			// order, so `[4]` is Throw — the first primary in `mount`'s list — and `[1]` is Catch, a utility. They
			// follow {@link BUTTON_WEIGHT}, which is why they are spelled with a comment rather than as `[0]`/`[1]`
			// as they were before the rows were rearranged.
			const primary = reference[4];
			const utility = reference[1];

			logInfo(
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
		if (LOGGING_ENABLED) {
			const live = Fusion.peek(cells)[0];
			const box = Fusion.peek(boxSize);

			logInfo(
				`[HUD] the cluster on this screen — ` +
					`${string.format("%.0f", live !== undefined ? live.size : 0)}px buttons, ` +
					`box ${string.format("%.0fx%.0f", box.X, box.Y)}px, ` +
					`viewport x${string.format("%.3f", Fusion.peek(scale))}` +
					(live !== undefined && live.size <= TAP_MIN ? " — AT THE TAP FLOOR" : ""),
			);
		}

		/**
		 * **Which of the six got a cooldown arc, said at build so a session does not have to be asked.** "I pressed a
		 * button and no arc appeared" is ambiguous between *the arc is broken* and *that button has no arc*, and only
		 * two of the six have one — Catch and Dodge, the two whose `TouchControl` names an attribute. This is the
		 * build's own answer, printed once, and it names the attribute each arc reads so a missing value on the player
		 * is the next thing to look at rather than a guess. **Throw, Jump, Drop and Curve have no clock of any kind** —
		 * see {@link TouchControl.cooldown} for why each. See {@link trackCooldowns}, which prints the two edges of
		 * every arc it actually shows.
		 */
		if (LOGGING_ENABLED) {
			const built = new Array<string>();

			for (const ring of cooldowns) built.push(`${ring.label} (${ring.attribute})`);

			logInfo(`[HUD] cooldown arcs — ${built.isEmpty() ? "none" : built.join(", ")}`);
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
	 * whole box through {@link ArrangeHook}: nothing fires and nothing is painted. The `InputChanged` connection that
	 * feeds that drag is the one the slop test needs as well, so it is made always now rather than only in that mode —
	 * see the connection's own comment for what that costs.
	 *
	 * **And a press has to survive being a swipe, which is the strict-tap rule.** Roblox reports `InputBegan` on the
	 * circle a finger lands on and `InputEnded` wherever that finger leaves the screen, with no notion of a drag in
	 * between — so a thumb dragged across the corner while steering used to fire whatever button it started on, and
	 * the button's own events cannot tell the difference because a finger that slides off the circle is a finger the
	 * button stops hearing about. **So the button's events are used only to learn which input landed on it**
	 * ({@link beginPress}), and the gesture itself is measured against `UserInputService`'s global streams
	 * ({@link trackMovement}, {@link trackRelease}): a press is a press only while its finger is still, inside
	 * {@link DRAG_THRESHOLD}, and still on the screen. See the two connections at the end of this method.
	 */
	private buildButton(
		scope: Fusion.Scope<unknown>,
		control: TouchControl,
		slots: Fusion.UsedAs<Array<{ x: number; bottom: number; size: number }>>,
		index: number,
		arrange: ArrangeHook | undefined,
		box: Frame,
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

		/**
		 * **The shrink that reveals the progress ring, and the reason it is a *value* rather than a tween on the
		 * button's `Size`.** `Size` is a `Computed` of the packing (see `slot`), so writing a tween onto it directly
		 * would be overwritten on the next reflow — a rotation mid-cooldown would snap the button back to full size
		 * with the ring still showing. Instead the packing stays the single source of the *full* diameter and this
		 * multiplies it: the goal is `1` when ready and {@link COOLDOWN_SHRINK} while cooling, `Fusion.Tween` does
		 * the interpolation, and the `Computed`s below read it like any other state.
		 *
		 * **`Fusion.Tween` rather than `TweenService` on the instance**, because what is being animated is a Fusion
		 * value, not a property — and because a second press inside the same second has to *retarget* a tween already
		 * in flight rather than start a second one beside it. Setting `shrinkGoal` again is exactly that: the tween
		 * re-aims from wherever it has got to.
		 */
		const shrinkGoal = Fusion.Value(scope, 1);
		const shrink = Fusion.Tween(
			scope,
			shrinkGoal,
			new TweenInfo(COOLDOWN_SHRINK_SECONDS, Enum.EasingStyle.Quad, Enum.EasingDirection.Out),
		);

		const button = Fusion.New(scope, "TextButton")({
			Name: control.label,
			// **The diameter from the packing, and it is per control now** — Throw and Jump are a factor larger than
			// the utilities, which is the whole reason `pack` was kept instead of a `UIGridLayout`. See
			// `BUTTON_WEIGHT` for the factors and `pack` for the fit.
			//
			// **Multiplied by the shrink**, which is the whole of the "the button steps back and the ring is revealed"
			// motion. On every frame but a cooldown the multiplier is exactly `1`, so this is the packing's own number
			// and nothing else — see {@link COOLDOWN_SHRINK}.
			Size: Fusion.Computed(scope, (use) => {
				const here = use(slot);
				const scale = use(shrink);
				const diameter = here.size * scale;

				return UDim2.fromOffset(diameter, diameter);
			}),
			// **The position, anchored on the circle's bottom edge.** `slot.bottom` is the top of the row's label
			// band, so buttons of different diameters in one row share a baseline and their words sit on one line —
			// which is what makes a cluster of two sizes read as a layout rather than as a mistake.
			//
			// **And raised by half of what the shrink took**, so the circle shrinks about its own *centre* rather than
			// about the bottom edge. Without this the ring would be revealed only above the button — a crescent with
			// the bottom flush against nothing — which is the one thing that would make the trick look like a glitch.
			// The half is `size·(1 − scale)/2`: the difference in radius between the full and the shrunk circle.
			AnchorPoint: new Vector2(0.5, 1),
			Position: Fusion.Computed(scope, (use) => {
				const here = use(slot);
				const scale = use(shrink);

				return UDim2.fromOffset(here.x, here.bottom - (here.size * (1 - scale)) / 2);
			}),
			// **The idle state, and the two properties are the whole of the difference between the states.** See
			// {@link IDLE_TRANSPARENCY} for the colour and the opacity and for why the held state is an inversion
			// rather than a second hue. **`PREMIUM.void` rather than `panel`**: at `0.7` the difference between the two
			// is a couple of units, but the palette's blackest value is what "transparent black" means and the idle
			// face should be the black one, not the second-from-black one that the panels wear.
			BackgroundColor3: PREMIUM.void,
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
		// instead: the two primary actions are bloomed in the theme's glow colour while the four utilities get the
		// dimmer side-B tint, written by tinting the bloom's ink rather than by skipping it, so every button reads as
		// lit and the primaries read as *more* lit. The weight is read from `BUTTON_WEIGHT`, this file's one answer to
		// "which of these is primary", rather than from a second list.
		//
		// **`false` for the bloom, and this is the one line that decides whether the buttons are see-through at all.**
		// A `UIShadow` is a blurred *silhouette*, so its ink covers the shape's whole interior as well as its halo —
		// which nobody could see behind a `0.15`-opaque face and which is the entire reason these buttons read as solid
		// once the face went to {@link IDLE_TRANSPARENCY}: the glow was the fill. Asking for the rim bloom instead keeps
		// the same light around the control (`glow.ts`'s stroke, the same one an engine without `UIShadow` gets) with
		// its ink only ever on the edge, so the arena shows through the middle of the circle and the glow stays outside
		// it. **The glow is unchanged in colour, weight and meaning** — only *where* it is allowed to be ink is.
		const primary = (BUTTON_WEIGHT[index] ?? 1) > 1;
		applyGlow(button, primary ? PREMIUM.glow : PREMIUM.sideB, false);

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

		// **The progress ring, for the controls that have a clock** — a sibling of the button rather than a child, so
		// it can sit *behind* it and be revealed by the shrink. Driven by the *table* rather than by a list here: a
		// `cooldown` names the server's instant, and a control without one has no ring at all. See
		// `addCooldownOverlay` for the two halves and the hole, and `trackCooldowns` for the values that turn them.
		if (control.cooldown !== undefined) {
			addCooldownOverlay(scope, box, slots, index, control.label, control.cooldown, shrinkGoal);
		}

		// **The word, hung off the button's own bottom edge** rather than stacked by a layout — the same
		// arrangement the engine's jump button has, and the reason there is no cell frame at all. `AnchorPoint
		// (0.5, 0)` with `Position (0.5, 1)` puts its top-centre on the circle's bottom edge, so the word is
		// centred under the disc at whatever size the packing gave it, plus {@link LABEL_GAP} of air.
		//
		// **And it is pushed back down by exactly what the shrink raised the button by**, so the word does not move
		// while the control shrinks for a cooldown. The button's own bottom edge is `size·(1 − scale)/2` higher than
		// the packing put it (see the `Position` above), and the label hangs from that edge — so the same distance is
		// added here and the two cancel. A word that crept upwards for every cooldown would be worse than the ring is
		// good, and it is the one thing this effect could break.
		//
		// **Built *before* `paint` rather than at the end of this method, and that order is load-bearing.** The pressed
		// state is an inversion — a near-white face with dark ink — so the paint has to write this label's colour as
		// well as the button's background, which means the label has to exist by the time that closure is defined. See
		// `paint` immediately below for the pair of colours and why the pairing is the whole of the state.
		const label = this.buildLabel(scope, control.label);
		label.AnchorPoint = new Vector2(0.5, 0);
		Fusion.Hydrate(scope, label)({
			Position: Fusion.Computed(scope, (use) => {
				const here = use(slot);
				const scale = use(shrink);

				return new UDim2(0.5, 0, 1, LABEL_GAP + (here.size * (1 - scale)) / 2);
			}),
		});
		label.Parent = button;

		/**
		 * **The button's own paint, and the only thing in this file that knows the theme's press colours.** It is a
		 * closure rather than a method because the press tracker lives outside this method: each record carries it, so
		 * `trackMovement` and `trackRelease` can light and unlight a button without knowing a colour or a property.
		 *
		 * **The pressed state is an *inversion*, not a hue change, and that is the whole of this version.** It used to
		 * be the palette's crimson (`PREMIUM.sideA`) at full opacity, which reads as an alarm against a game whose
		 * floor is bright green — the report was that a finger landing on a button painted a red disc onto the world.
		 * Transparent black face with white ink, then white face with dark ink: a press is the *negative* of the idle
		 * state, so nothing new is introduced to say "pressed". **The writes below are one state**, which is why they
		 * live in one closure: a white face with the label's own white ink on it is invisible, and a label that changed
		 * colour on its own would be a second thing to keep in step. See {@link IDLE_TRANSPARENCY} and
		 * {@link HELD_TRANSPARENCY} for the two alphas, and `paintJump` for the engine's button, which is this same
		 * pair applied to somebody else's instance.
		 */
		const paint = (down: boolean): void => {
			button.BackgroundColor3 = down ? PREMIUM.text : PREMIUM.void;
			button.BackgroundTransparency = down ? HELD_TRANSPARENCY : IDLE_TRANSPARENCY;
			label.TextColor3 = down ? PREMIUM.void : PREMIUM.text;
		};

		// **The button's own `InputBegan` is used for exactly one thing now: learning which input landed on it.** No
		// action, no paint and no timer starts here — the record that `beginPress` makes is what those hang off, and
		// it is measured against the global input streams from then on. That is the rewrite in one sentence: the
		// button's events only say *where a finger arrived*, and `UserInputService` says what the finger then did.
		scope.push(
			button.InputBegan.Connect((input) => {
				// A button is a `GuiObject` and this event fires for hovers on a desktop pointer as well, so the
				// input type is what says whether something was actually pressed. `Touch` and `MouseButton1` are
				// the two the cluster is built for — see this method's doc for why the mouse's own pair of events
				// is not used alongside.
				const kind = input.UserInputType;
				if (kind !== Enum.UserInputType.Touch && kind !== Enum.UserInputType.MouseButton1) return;

				// **In hand-move mode the press is a grip**, and it takes the whole press: no record, no paint, no
				// action. See {@link ARRANGE}.
				if (arrange !== undefined) {
					arrange.grab(pointOf(input));

					return;
				}

				// **One press per button, whatever the engine announces.** `InputBegan` is re-sent for an input that
				// never ended when the window regains focus, so a button that trusted the event would start a second
				// press inside the first. The registry is the latch now; it used to be a local flag.
				if (pressFor(button) !== undefined) return;

				beginPress(button, control, input, paint);
			}),
		);

		// **The button's own `InputEnded` is the grip's now, and nothing else's.** A press is released through
		// `UserInputService.InputEnded` — see `trackRelease`, which is where the release is authoritative — because the
		// button's own ending is exactly the event that goes missing when a thumb slides off the circle. Keeping this
		// connection for the grip costs one closure per button and never runs on the shipped path.
		scope.push(
			button.InputEnded.Connect(() => {
				if (arrange === undefined) return;

				arrange.done();
			}),
		);

		// **The drag's own connection, made only in hand-move mode — and this is the connection the rewrite gave
		// back.** The previous revision made one of these per button unconditionally, so that a press could watch its
		// own finger; the tracker moved to `UserInputService`, which is one pair of streams for the whole cluster
		// rather than six pairs of listeners, so what is left here is the grip and only the grip.
		//
		// **The `grab`/`move` pairing is the safety**: a `MouseMovement` that began nowhere near a button still fires
		// this, and it does nothing because {@link ArrangeHook} has no starting point to measure it from.
		if (arrange !== undefined) {
			scope.push(
				button.InputChanged.Connect((input) => {
					const kind = input.UserInputType;
					if (kind !== Enum.UserInputType.Touch && kind !== Enum.UserInputType.MouseMovement) return;

					arrange.move(pointOf(input));
				}),
			);
		}

		// **The word is built further up this method, before `paint`** — see the note there for why the order matters
		// now that the pressed state writes the label's ink as well as the button's face.

		button.Parent = box;

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
			if (LOGGING_ENABLED) {
				const image =
					button.IsA("ImageButton")
						? `image "${button.Image}" at ${string.format("%.2f", button.ImageTransparency)}`
						: `class ${button.ClassName}`;

				logInfo(
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
				if (LOGGING_ENABLED && (engineSize !== reportedEngineSize || multiplier !== reportedMultiplier)) {
					reportedEngineSize = engineSize;
					reportedMultiplier = multiplier;

					logInfo(
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
	 * **Three writes and no tween**, for the reason `buildButton` gives about the cluster's own buttons: a button is
	 * held or it is not, and a fade would leave the colour somewhere between the two at exactly the moment a player
	 * wants to know which one they are in. **The pair is the cluster's own** — `PREMIUM.panel` idle, `PREMIUM.text`
	 * held, with `PREMIUM.void` ink on the white face — so the engine's button, on the clients that show it, is
	 * painted by the same two values as the six beside it rather than by a second copy of the idea. See
	 * `IDLE_TRANSPARENCY` for the alphas and `paint` in `buildButton` for the same inversion on the cluster.
	 *
	 * **The label is looked up and guarded, which is the one thing this method has to be careful about.** `HudLabel`
	 * is created by `paintParts` during discovery, and this is called from three places — the discovery itself, the
	 * press and the release. The guards cost a `FindFirstChild` per press, which is nothing next to the state being
	 * invisible on the one client whose label has not been built yet: a white face with white ink is not a press a
	 * player can see.
	 *
	 * **Kept as a method rather than inlined**, because it has three callers — the discovery, the press and the
	 * release — and one definition is what makes "the pressed state is the cluster's pressed state" a fact
	 * rather than three copies of a hope.
	 */
	private paintJump(button: GuiButton, held: boolean): void {
		button.BackgroundColor3 = held ? PREMIUM.text : PREMIUM.void;
		button.BackgroundTransparency = held ? HELD_TRANSPARENCY : IDLE_TRANSPARENCY;

		const label = button.FindFirstChild("HudLabel");
		if (label !== undefined && label.IsA("TextLabel")) label.TextColor3 = held ? PREMIUM.void : PREMIUM.text;
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
