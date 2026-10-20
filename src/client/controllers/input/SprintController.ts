import { Controller, OnStart } from "@flamework/core";
import Net from "@rbxts/net";
import { Players, ReplicatedStorage, RunService, UserInputService } from "@rbxts/services";
import { isMobile } from "../../platform";
import { events } from "shared/networking";
import { sprinting } from "../../sprinting";

/** Prints the bind once, every edge of the action, and every call that reports a change to the server. */
const DEBUG = false; // off for frame time — see shared/config/debug.config.ts

/**
 * The keys that sprint — either of them.
 *
 * **Two, and the pair is the whole of this arrangement.** The right hand that drives with
 * `U`/`H`/`J`/`K` should not have to cross the keyboard for the sprint, and the left hand that is
 * already on WASD is the one that owns `LeftShift` — the left little finger, and the one key on that
 * side of the board that nothing else in this game uses. Neither key is *the* sprint key: they are
 * two spellings of one input, and every decision below is about the pair rather than about either of
 * them.
 *
 * **`LeftShift`, and the key before it was `LeftAlt`.** The old binding worked, and it also took the
 * player's movement with it: holding a direction, holding `LeftAlt`, and letting go of `LeftAlt`
 * stopped the body dead with the direction key still down, and it would not move again until a fresh
 * press. **The cause is outside the game — Alt is the one key Windows itself acts on.** Tapping it
 * hands the window's focus to the system menu and back, which fires `WindowFocusReleased`; three
 * controllers here clear the keys they believe are held on that event — this one among them, and
 * correctly — and the engine's own default controls do the same with *their* held keys, so the
 * movement was dropped and only a new press could restore it. Recorded because it read as a gameplay
 * bug and was chased as one: the server reporting `[Walk] 20 (Base:20)` on the release, and the body's
 * own measured speed at `0.0` inside the next 80 milliseconds. **A key the operating system has an
 * opinion about is not a key to bind a hold to**, which is the lesson `RightAlt` taught from the other
 * end of the keyboard.
 *
 * **Shift is only free because the engine's own use of it is switched off.** Roblox's default shift
 * lock is a `LeftShift` toggle, and it is disabled in the place file — see `ShiftLock`, which says so,
 * and which is the reason this game has a shift lock of its own at all. If that setting is ever turned
 * back on, this binding starts toggling the engine's mouse lock as well and the two shift locks will
 * fight over the camera. **That hazard belongs to the shift key rather than to the left one**, which is
 * why the second key below adds no new way to trip it: whichever shift the engine listens for, the pair
 * already contains it, and the place file's switch remains the one fact both bindings depend on.
 *
 * **`RightShift`, and before it `M`.** `M` was picked because it was the nearest unbound key on that
 * side of the board, on the failure of the Alt below; it is replaced at the user's request, and what
 * that buys is that the pair is now **one shift per hand** — which is what the first paragraph of this
 * block has been describing all along. Everything below is about the pair rather than about either key,
 * so nothing else moves with it.
 *
 * **The right-hand key was `RightAlt` before `M`, and that history is kept deliberately.** `RightAlt` is
 * the obvious right-hand answer — it is the key beside the arrow cluster — and it was bound and tried.
 * **It did not sprint.** The cause was not chased, deliberately: a key that does nothing is a key to
 * replace. What that binding turned out to have in common with `LeftAlt` is the rule the `LeftAlt`
 * paragraph above states: on a layout with `AltGr`, the right-hand Alt is the operating system's
 * character-composition key, and whether it is delivered as `RightAlt` at all is the OS's decision
 * rather than the engine's. Neither Alt key survives in this list, for that reason — and **`RightShift`
 * is not an Alt, which is the whole of why it is a better answer to the same question than either of
 * them was.**
 *
 * Annotated rather than inferred, for the reason the movement controller's key list is: a bare array
 * of two key codes is narrowed to those two literals, and the loop that builds this action's bindings
 * would then be a loop over a two-member tuple rather than over a list. The pair is also what the bind
 * line prints and what the action is built from, so there is one place where the keys are written down
 * — which is the property that made `RightAlt`'s removal a one-line change.
 */
const SPRINT_KEYS: Array<Enum.KeyCode> = [Enum.KeyCode.LeftShift, Enum.KeyCode.RightShift];

/**
 * **The action, the context it hangs from, and the context's priority — three names for one mechanism, said
 * once so that a log line and the tree agree.**
 *
 * `Sprint` is the action's name and it is the name a player would use; `SprintInput` is the context's, because
 * the folder it lives in (`ReplicatedStorage.Inputs`) holds this project's other context too and two instances
 * cannot share a name. **The priority is the number this project's own movement context already uses**, and its
 * argument carries over unchanged: the published value the Input Action System's documentation gives for "high
 * enough to sink its bound inputs before the default `PlayerScripts` contexts process them" is `2000`. Nothing
 * here sinks — see {@link buildAction} — so this ladder is not what makes a key work; it is where a reader of the
 * tree would expect to find a context that means to be read.
 */
const ACTION_NAME = "Sprint";
const CONTEXT_NAME = "SprintInput";
const CONTEXT_PRIORITY = 2000;

/**
 * How far the movement stick has to be pushed to start and to stop sprinting. **Placeholder — `0.9` and `0.8`, and
 * for the first time placed against a walk this feature measured rather than against a guess about one.**
 *
 * **Two numbers and one time.** This pair is the *level* half: one line to start above, and a lower one to stop
 * below. On its own it is a spike filter with no spike filtering in it — a level test's whole answer is one
 * sample — so a reading that plateaus at `0.68` and throws a single frame at `1.00` engages the sprint, and no
 * placement of these two numbers can prevent that. **{@link SPRINT_RELEASE_SECONDS} is the other half and it is now
 * the only time in the mechanism**, which is what the "too sensitive" complaint was actually about; the *engage*
 * half of that answer was a hold, and it has been removed on request — see the tombstone below for the cost of its
 * absence. **The level pair's job is the smaller one**: it says *where* in the travel the player is asking for a
 * sprint, and one time decides when the asking stops.
 *
 * **What these two numbers are *not* a function of, and this is the correction this pass exists for: the stick's
 * drawn size.** A previous pass made the engine's touch stick 1.5× larger with a `UIScale` and then divided this
 * pair by the measured `AbsoluteSize` ratio — `1 ÷ 1.5 = 0.667`, `0.98 ÷ 1.5 = 0.653` — on the argument that a
 * bigger frame makes the same physical push a smaller fraction of the radius. **The next session's log says it does
 * not.** With that divided pair in force, sprint edges fired on readings of `0.71` and `0.83` during ordinary play
 * — both above a `0.667` start line, both far below anything a deliberate push reads — while readings still reached
 * `1.00`, which a divided reading could not have done. The radius in this fraction is the engine's, and the drawn
 * size is not that number. **So this pair is literal: nothing computes it, and a visual change cannot move it.**
 * See {@link STICK_SCALE} for what the resize is still allowed to be, and {@link watchStick}, whose loop compares
 * the reading against these two constants directly.
 *
 * **Where the numbers come from, and it is two logs.** The first, taken with a probe reading the same quantity this
 * file reads (`Humanoid:GetMoveVelocity() ÷ WalkSpeed`), gave the walk and the push:
 *
 * - **the walk**: `0.12 → 0.40 → 0.61 → 0.68`, and then **`0.68` held for about a full second** of continuous
 *   walking — the number this pair has to clear, and the one number nobody had measured until then.
 * - **the deliberate push**: `0.75 → 0.89 → 0.95 → 1.00`, with the pipeline answering correctly on both edges
 *   (`[Walk] prospeed1: 35 (Base:20 Sprint:15)` on the way up, `[Walk] prospeed1: 20 (Base:20)` on the way down).
 *   **The mechanism has never been in question; what a level pair cannot do is tell a push from a spike.**
 *
 * The second log is the session that found the divide, and it is what fixes the pair's *placement* — because it
 * shows a walk being sustained while readings cross a line: `1.00`, `0.00`, `0.83`, `0.54`, `0.71`, four sprints in
 * thirteen seconds of ordinary play. Against those numbers: **`0.9` is `0.22` above the plateau and `0.8` is `0.12`
 * above it**, so neither line is anywhere near a walk; the momentary `0.83` is `0.07` short of the new start line;
 * and `0.9` sits inside the push's own `0.75`–`1.00` range, which the first log shows a deliberate push
 * traversing. The gap between them is `0.10` — see {@link SPRINT_RELEASE_SECONDS} for what that gap does once the
 * time is behind it.
 *
 * **The six pairs this line has carried, in order, because the sequence is the argument.** `0.75` and `0.6` (the
 * first, from the stick's radius and the word "far"), `0.9` and `0.75` (the pair the first log was recorded with —
 * a number in a log is only ever what was synced when it ran, which is why the line quotes the constants instead of
 * spelling them out), `0.9` and `0.8`, `0.95` and `0.85` (the first raise with a measurement behind it, on the
 * plateau above), `1` and `0.98` (set by hand after that session: it stopped the misfires by demanding a reading at
 * the *clamp*, which a device whose stick tops out at `0.97` could never reach), and **the divided pair this pass
 * deletes**. **Two lessons are in that list.** A level pair on its own cannot separate a deliberate push from a
 * spike, which is what the two times are for. And **a pair whose value is *computed* from something the sensor does
 * not depend on moves the line without anybody deciding to move it** — which is what happened here, and why the
 * numbers below are written out rather than derived.
 *
 * **Every number in this block is an emulator number until a phone says otherwise**, and the plateau most of all,
 * since it is the one the pair is placed against. Both stay **Placeholders**, and the reading line in
 * {@link watchStick} is the instrument that re-measures them — with the caveat that its cap is per session, so the
 * plateau is visible in a session's first minutes rather than throughout it.
 *
 * **And as of the joystick pass the fraction is one this project can state rather than one it has to discover.**
 * `TouchJoystickController` replaces the engine's stick on a touch client, so the radius a reading is a fraction
 * of is *its* ring: a named constant of the viewport's short axis (`STICK_DIAMETER_SCALE`) rather than whatever
 * the ControlModule drew for this device in this movement mode. **That is the benefit the custom stick was built
 * for, and it does not re-tune anything by itself** — `0.9` and `0.8` are still the pair the *engine's* stick was
 * measured against, so they are hypotheses for a ring until a session reads them again. **The line that reads
 * them is the joystick's own release line**, which prints the peak push of each grab: bounded by how often a
 * player lets go of a stick rather than by a per-session cap, and the exact number "can a deliberate push reach
 * the start line" asks for. {@link watchStick}'s reading lines remain the other half of that instrument.
 *
 * **And what the number meant *on the engine's stick* depended on the device's touch movement mode, which is a
 * fact about Roblox's own code and not about this file — which is the second thing the custom stick answers.**
 * The modes compute the move vector differently, and only one of them produces a fraction these thresholds can be
 * applied to honestly: the fixed thumbstick is analog out to the rim (the mode this design assumes); the dynamic
 * thumbstick saturates after roughly 20px of finger travel, so any firm push reads `1` and the sprint becomes
 * "moving"; and the thumbpad and DPad end their arithmetic in `.Unit()`, so the fraction is `1` whenever the pad
 * is off centre at any pressure. **That last case is the one worth naming for whoever reads the log**: on those
 * modes this design's honest reading was "sprint while moving", which is a player-facing decision and not
 * something these two constants can fake. `DevTouchMovementMode = UserChoice` is what this project's client
 * *used* to report — it now reports `Scriptable` on a touch client, so **on a phone the three behaviours below
 * describe a control that is no longer in the player's hands**. The analysis stays for two reasons: it is what
 * the pair was placed against, and it is the family {@link STICK_FRAME_NAMES} still looks for on the chance that
 * an engine stick is somehow still on screen.
 *
 * **Which mode the first session was in is answerable from its log, and the answer is what made a threshold the
 * right lever at all.** The reading climbed through eight distinct levels (`0.12 → 0.40 → 0.61 → 0.68 → 0.75 →
 * 0.89 → 0.95 → 1.00`) across about a second and a half of thumb travel — a fraction that grows with distance from
 * the centre over the whole radius, which is the fixed thumbstick's signature. A saturating mode would have pinned
 * at `1` within about 20px of travel and printed no ramp; a pad mode would have jumped from `0` to `1` in one step.
 * **So the fix is the pair and not the design** — a distinction that would not have been available in either of the
 * other two cases.
 */
const SPRINT_START_MAGNITUDE = 1;
const SPRINT_STOP_MAGNITUDE = 0.9;

/**
 * **There was a hold here — `SPRINT_HOLD_SECONDS = 0.2` — and there is not one any more. This is the record of why
 * it existed and what removing it costs, because the argument it answered has not gone away.**
 *
 * It was the *time* half of the engage: crossing {@link SPRINT_START_MAGNITUDE} only became a sprint once the
 * reading had *stayed* up for a fifth of a second. The reason it existed is the one in the pair above — a level
 * test's whole answer is one sample, so a walking thumb that throws a single frame at the top of the range would
 * engage a sprint nobody asked for, and measured `0.95`–`1.00`-for-half-a-second pushes against one-or-two-frame
 * excursions is what sized it. **It was removed on the user's instruction — *"Remove the 0.2 delay for
 * sprinting"* — and an instruction is the reason, not a measurement**, so the cost is named rather than argued
 * away: **a one-frame excursion to `1.00` now engages the sprint**, which is precisely the case the hold was
 * built to swallow, and the reading lines in {@link watchStick} are the instrument that says how often it
 * happens. The level pair above is the only lever left if it turns out to matter, which is part of why it sits at
 * the clamp rather than lower down the travel.
 *
 * **What deliberately did not go with it: {@link SPRINT_RELEASE_SECONDS}.** The two times used to be asymmetric,
 * and that asymmetry was the argument for shortening the release; with one time left, the release is judged on its
 * own terms instead — see its own doc, which now says so rather than comparing itself to a number that no longer
 * exists.
 *
 * **The clock it used is the clock the release still uses**, and it is worth keeping the reasoning because it is
 * not the obvious choice: the time is game time accumulated frame by frame (`Heartbeat`'s own `deltaTime`), not a
 * timestamp. `RoundTransitionController` holds the same idiom (`held += delta; if (held < HOLD_SECONDS) return;`)
 * and it is the one to follow, because the loop then has no clock in it at all and the threshold is frame-rate
 * independent by construction. **The obvious alternative is `os.clock()` — which this project's client frame loops
 * do use, `chargeEffect` among them — and it is the wrong clock for a duration threshold**: this build's own
 * typings describe it as "the number of seconds of CPU time for the program", and `services/ball/ThrowProbe.ts`
 * records what that costs, having read a `32ms` lag out of it that looked exactly like a physics fault. See
 * {@link SPRINT_DELTA_LIMIT} for the one thing that has to be done to a delta before it counts as evidence.
 */

/**
 * **How long the reading has to stay below the stop line before the sprint releases. Placeholder — 0.15.**
 *
 * **It used to be the shorter half of a pair of times; it is now the only time in this mechanism**, which changes
 * the reasoning rather than the number. The comparison is still the point — engaging a sprint the player did not
 * ask for is a fault they notice immediately and resent, while a sprint that lingers a seventh of a second after
 * they ease off is invisible — so a *release* is the one place a delay is cheap, and it is the only delay left.
 * `0.15` is also four frames at 60fps, which is enough to swallow a single dropped frame (`0.033`) and a momentary
 * ease-off, without being long enough to read as lag.
 *
 * **What it deliberately is not is a second engage.** The engage has no delay at all any more — see the tombstone
 * above — so nothing here should be read as reusable for one: this line's job is to hold a state that is already
 * on, and holding a state that is *off* in the hope it stays off is what the removed hold did.
 */
const SPRINT_RELEASE_SECONDS = 0.15;

/**
 * **The longest frame that counts as "the input was held through it".** **A guard rather than a tuning value.**
 *
 * The time above is accumulated from `Heartbeat`'s own `deltaTime`, and a frame can be arbitrarily long: a client
 * that stutters, a device that throttles, a window that was in the background. A four-second hitch must not arrive
 * as four seconds of *evidence* that a thumb was past a line, because nothing was reading the stick through it. A
 * tenth of a second is six frames at 60fps — far longer than any real frame, far shorter than any hitch worth not
 * counting.
 */
const SPRINT_DELTA_LIMIT = 0.1;

/**
 * **How much larger the engine's movement stick was drawn, as a `UIScale` on its own frame. `1`, which is this
 * constant's off switch — set after a session showed the drawing going off the edge of the screen.**
 *
 * **Why it is off rather than `1.5`, and it is not a retreat from the idea.** The enlargement's whole purpose was
 * to make the engine's stick easier to find with a thumb, and the pass that added it had already proved it cannot
 * reach the *reading* (a `1.5×` scale left the walk plateau at the same `0.68`, which is what the divide below
 * then got wrong). What was left was a bigger drawing, and the session that ran it reported the cost this
 * comment's own last paragraph predicted for it: a `UIScale` grows a `GuiObject` from its own corner, so the
 * engine's layout plus a multiplier put the control off the screen. **Two facts make turning it off the right
 * answer rather than re-tuning it**: a drawing that cannot change what the player's push *means* is cosmetic, and
 * `TouchJoystickController` replaces this control outright wherever the touch movement mode can be given up.
 * Putting `1.5` back is one number, and the resize line in the log reports what it did either way.
 *
 * **It is a visual change and nothing else, and that is now measured rather than argued.** The reading is a
 * fraction of whatever radius the *engine* divides by, and a session with this scale applied plus the thresholds
 * divided by it fired sprint edges on readings of `0.71` and `0.83` during ordinary play — numbers that can only
 * mean the denominator had not moved while the drawing had. **So nothing computes a threshold from this constant
 * any more**: see {@link SPRINT_START_MAGNITUDE} for the log that settled it and {@link watchStick}, which compares
 * the reading against two literals.
 *
 * **And the control it was enlarging is gone, which is the rest of the same story.** `TouchJoystickController`
 * sets `DevTouchMovementMode` to `Scriptable` and draws its own ring, so a mobile client no longer uses the
 * engine's stick at all: {@link findStickFrame} is now looking for a frame the engine has stopped drawing, and on
 * a phone this constant does nothing but print that it found nothing. **The three parts of that mechanism — this
 * constant, {@link STICK_FRAME_NAMES} and {@link scaleStickFrame} — are kept rather than deleted**, because
 * removing them is a separate change of about a hundred lines and the answer is one log line away: the probe in
 * `TouchJoystickController` reports what the engine's touch GUI still contains, and the resize's own line reports
 * whether it found a movement frame. **When those two agree that the frame is gone, the mechanism should go with
 * it.**
 *
 * **What it would still be for, if a frame is ever found**: a bigger control to look at, and to find with a thumb
 * — a 70px stick drawn at 105px, a 120px one at 180px. **The cost of that is the outer third of its travel**: a
 * bigger *drawing* of an unchanged reading leaves the drawn rim further out than the point the reading calls `1`,
 * so a push out there asks for nothing a push inside it has not already asked for. **`1` turns it off** — no
 * instance is created, the frame keeps the size the engine gave it, and the resize line in the log says so.
 *
 * **And it grows *from its own corner*.** A `UIScale` multiplies the size and leaves the position alone, so on the
 * smaller of this project's two logged devices a 1.5× stick may run past the bottom-left edge of the screen — a
 * visual fault the player sees immediately, and the thing to check first on a phone.
 *
 * **Annotated `number` rather than left as the literal `1`, and that is not decoration**: `1` is one of this
 * constant's legal values — it is the off switch, and it is the value the file now holds — so the comparison which
 * reads it needs a `number` to compare against. Without the annotation the compiler narrows the type to `1` and
 * the `STICK_SCALE === 1` test, which is what skips the whole resize, is a comparison between types with no
 * overlap.
 */
const STICK_SCALE: number = 1;

/**
 * **The names the engine's movement stick has shipped under.** See {@link findStickFrame}.
 *
 * **Four, because the name is not in this repository and the mode was the player's own choice** — this project's
 * client used to report `DevTouchMovementMode = UserChoice`, which meant the *player's* setting decided which of
 * the four touch movement controls was on. **That is no longer what a mobile client reports**:
 * `TouchJoystickController` sets the property to `Scriptable` and draws its own ring, so there is no movement
 * frame here to find on a phone and this list is a lookup for the one case that would surprise us — an engine
 * stick still being drawn under a client that asked it not to. See {@link STICK_SCALE} for the whole of that
 * argument and for why this mechanism is kept rather than deleted.
 *
 * **What the four still describe is the family**, and the distinction is worth keeping because it is the reason a
 * threshold pair could not be trusted on the engine's stick at all: the two *sticks* are the modes whose reading
 * is a *fraction* of the radius; the two *pads* end their arithmetic in `.Unit()`, so their reading is `1` at any
 * pressure and a bigger frame would buy no resolution at all. The finder finds all four; {@link scaleStickFrame}
 * scales only the sticks.
 *
 * **The fixed stick's name is the one the deleted reader searched for, and that search failed on a real client.**
 * What is different here: a miss now prints the control frame's children by name and class, so the next session
 * names the instance rather than guessing at it again — and the search no longer requires the frame to be
 * `Visible`, which the old one did.
 */
const STICK_FRAME_NAMES = ["ThumbstickFrame", "DynamicThumbstickFrame", "Thumbpad", "TouchDPad"];

/**
 * **How long {@link findStickFrame} waits for the engine's touch GUI.** **Not a tuning value**: it is the patience
 * of a lookup, and it is deliberately the same ten seconds the deleted reader gave the `ModuleScript` it was
 * hunting. The engine builds this GUI during boot, so the wait is normally over before it starts.
 */
const STICK_FRAME_WAIT_SECONDS = 10;

/**
 * **How large a change in the reading has to be before {@link watchStick} prints it.** **A diagnostic step rather
 * than a tuning value**, and it is what makes the line usable: a tenth is far below the distance between the two
 * levels this design cares about (`0.68` for a walk and `0.95` for a push, in the session this pair was raised on)
 * and far above the jitter of a thumb held still, so a session prints the plateaus rather than the noise.
 */
const STICK_REPORT_STEP = 0.1;

/**
 * **How many of the reading's lines one session may print.** See {@link watchStick}.
 *
 * **A cap rather than a tuning value**, and it is the difference between an instrument and a flood. The line it
 * bounds prints on every change of {@link STICK_REPORT_STEP} *in either direction*, so a session in which a player
 * walks for a while and then pushes to the rim prints four or five of them — the walking level, the push level,
 * and the steps between the two — which is the pair of numbers that decides where the thresholds go.
 *
 * **A reading that tops out below the start threshold is the failure this line exists for**: it never crosses
 * anything, so nothing else in the log would mention it, and "the sprint never fires on my phone" would be
 * indistinguishable from "the sensor never moved". The cap is for the pathological case it cannot rule out: a
 * reading oscillating around a step boundary would otherwise print for the rest of the session.
 */
const STICK_REPORT_LIMIT = 12;

/** The client half of the sprint remote, as the declarations build it. */
type ClientRemotes = Net.Util.GetClientRemotes<Net.Util.GetDeclarationDefinitions<typeof events>>;

/**
 * Holds a sprint and says so; decides nothing.
 *
 * **The keys arrive through the Input Action System, and that is this file's one mechanism.** `Sprint` is an
 * `InputAction` of type `Bool` with one `InputBinding` per key in {@link SPRINT_KEYS}, and the engine's own state
 * for that action is the question this controller used to keep a `Set` to answer: *is any of the pair down.* A
 * `Bool` action is *defined* by its transitions — `Pressed` "fires only when the `InputAction.Type` is set to
 * `Bool` on a state transition from `false` to `true`", and `Released` only the other way — so a held key's repeat
 * announcements, a chat box handing the key state back, and two overlapping bindings are all folded into one
 * boolean by the engine rather than by a flag here.
 *
 * **That is also the answer to the argument this file used to make for the opposite arrangement**, which is kept
 * because it was not a bad argument and is worth seeing overturned: *"`InputBegan` and `InputEnded` rather than one
 * bound action ... an action bound once fires on the way down and again on the way up, and half of those arrivals
 * are the engine re-announcing a key that never came up."* True of a `ContextActionService` action, whose callback
 * is handed the raw input. **Not true of this one**: the re-announcement is exactly what an `InputAction`'s state
 * machine deduplicates, which is the property the old comment wanted and could not get. **What changed, one line
 * each**: the `Set<Enum.KeyCode>` of held keys, its `size() > 0` test, the `heldKeysLabel` that existed to print it,
 * and the `gameProcessed` read. Nothing here overrides an engine binding or forks a Roblox module: the context is
 * `Sink = false`.
 *
 * **The text box is the one guard that has to be written by hand.** `Pressed` carries no `gameProcessed` argument —
 * the action is a statement about the device, not about the GUI — so "typing in chat does not sprint" is asked of
 * `UserInputService.GetFocusedTextBox()` instead. **What is knowingly not kept**: the old flag was true for a *menu*
 * as well, and this replacement only knows about text boxes, so a sprint key pressed while some other GUI has focus
 * will sprint. A small regression in a case nobody has reported, named here rather than discovered later — the
 * alternative, a second `UserInputService` reader beside the action, would be two mechanisms for one key.
 *
 * **The mobile half is a read and not a third binding, and that is a fact about the API rather than a preference.**
 * An `InputBinding` does have a threshold pair — `PressedThreshold` and `ReleasedThreshold`, "numerical value above
 * which to fire an `InputAction` with a `Type` of `Bool`" and its mirror — and that is exactly the shape this design
 * wants. But both are scoped to a `Bool` action fed by a *scalar* analog input (the reference's own example is a
 * gamepad trigger passing `0.5`), while a thumbstick is `Enum.InputActionType.Direction2D` and its `KeyCode` is
 * documented to match the action's type — `Thumbstick1` for `Direction2D` — with a mismatch that "will either not
 * fire the `InputAction` or the `StateChanged` event". **So the stick's magnitude is read from the body instead**,
 * in {@link watchStick}, and this action is the keys' alone. Whether the engine's *touch* thumbstick would even
 * report `Thumbstick1` to a binding is not something this project can confirm from source, which is the second
 * reason the read exists.
 *
 * **Nothing is decided here, including whether the sprint is allowed.** The pool is the server's, and a client that
 * refused to send a press because its own copy of the pool was at zero would be a second copy of a rule — the one
 * thing this codebase consistently refuses to write. So the client reports the input and the server answers by
 * changing how fast the character walks, which the player sees as the character walking faster.
 *
 * **Nothing is sent when the answer has not changed.** Two inputs can ask for one sprint, so the fold in
 * {@link holdSprint} and the guard in {@link setHolding} are what keep a stream of announcements from becoming a
 * stream of remote calls — the same property, kept, moved to the place where the two sensors meet.
 */
@Controller()
export class SprintController implements OnStart {
	private readonly player = Players.LocalPlayer;

	/** Resolved on first use: `Client.Get` waits for the server's remote. */
	private sprintRemote?: ClientRemotes["setSprinting"];

	/** The last thing the server was told. The client's own copy of what it said. */
	private holding = false;

	/**
	 * **The action's own state, mirrored — and the replacement for the set of held key codes.**
	 *
	 * One boolean rather than a `Set`, because the action is the thing that counts now: the engine folds its two
	 * bindings into one `Bool` state and reports it on transitions, so "is a sprint key down" is a fact this
	 * controller is *told* rather than a fact it keeps — including the case the set existed for, where one key comes
	 * up while the other is still held. It is read in exactly one place, {@link holdSprint}, where a stick release
	 * has to be able to say "yes, but the other hand is still holding it".
	 */
	private keysDown = false;

	/**
	 * **Whether the stick is currently being reported as pushing past the start line.**
	 *
	 * The mobile loop's own latch, and one of the two halves of what makes the pair above a hysteresis rather than a
	 * level test: the state changes on a *crossing that lasted*, never on a single sample. It is a field rather than
	 * a local so that the one thing which can end a sprint behind the loop's back — a lost window focus — can put it
	 * back in step. See {@link watchStick}.
	 */
	private stickSprinting = false;

	/**
	 * **How long, in game time, the reading has been under the stop line** — the only time in this mechanism.
	 *
	 * Accumulated frame by frame while the reading stays below {@link SPRINT_STOP_MAGNITUDE} and zeroed the moment
	 * it comes back, so a momentary ease-off leaves no trace. Measured against {@link SPRINT_RELEASE_SECONDS},
	 * which is the whole of what it is; this field used to be documented as *the mirror* of a `stickAboveSeconds`
	 * that no longer exists, and the pair are one number apart in a different sense now — there is only one of
	 * them. A field rather than a local of the loop for the reason the latch is a field: {@link bindKeys}'s focus
	 * handler has to forget what was being held, and that decision is made outside the loop.
	 */
	private stickBelowSeconds = 0;

	public onStart(): void {
		// **Resolved before any input can arrive, and out of band.** `Client.Get` waits for the
		// server's remote, and a controller's `onStart` is the wrong place to hold up the rest of the
		// client's boot — so this is the usual `task.spawn`. It matters more here than elsewhere: a
		// press and a release that each waited for the remote would be two handlers yielding in turn,
		// and a quick tap could be reported out of order.
		task.spawn(() => {
			this.getRemote();
		});

		this.bindKeys();

		// **The mobile half, and the gate is load-bearing rather than tidy.** The stick's reading is "how much of
		// its walk speed this body is being asked for", and a keyboard asks for *all* of it: on a device with a
		// keyboard the same loop would read `1.00` whenever the player walks and sprint the character for the whole
		// session. `isMobile()` is `TouchEnabled && !KeyboardEnabled` — see `client/platform.ts`, which is where the
		// question lives and which records that Studio's device emulator answers yes to it, so this half can still be
		// looked at without a phone. **Both branches print**, so a log from a phone with no sprint says which of the
		// two it was in rather than leaving the reader to guess whether the loop ran.
		if (isMobile()) {
			task.spawn(() => this.watchStick());
		} else if (DEBUG) {
			print("[Sprint] this device has a keyboard, so the stick is not read — the keys are the sprint here");
		}
	}

	/**
	 * **The sprint, asked for by whichever sensor noticed it — and the one place the two of them are folded
	 * together.**
	 *
	 * Called with `true` when a sprint key goes down or the stick is pushed past its start threshold, and `false`
	 * when that key comes up or the stick is eased back below the lower one. **The fold is one `||`, and it is what
	 * stops the two inputs cancelling each other**: a stick release while a shift key is still down must not end the
	 * sprint, and neither must a key release while the stick is still pushed. Both sensors are in this file now —
	 * see {@link bindKeys} and {@link watchStick} — so the method is no longer anybody else's way in; it stays
	 * public and stays this small because a third sensor, if there is ever one, should arrive here and nowhere
	 * else.
	 *
	 * **It was written when the two inputs could not both be live, and the gate for that has moved to each
	 * sensor rather than living here.** The mobile read only starts on a device `isMobile()` calls mobile, so on
	 * any device that can press a shift key it never runs — but the fold stays, because the alternative is a
	 * platform rule written into a method that has no business knowing one, and because a keyboard attached to a
	 * phone mid-session would otherwise make the stick's release end a sprint somebody is still holding with a key.
	 *
	 * **`setHolding` and not the remote, not `sprinting` and not the server.** Everything that actually changes
	 * happens behind it, once, so this method is the smallest possible surface for a sensor to arrive through —
	 * which is why it is the method `MobileControlsController` used to call and the one this file's replacement
	 * calls instead.
	 */
	public holdSprint(active: boolean): void {
		this.setHolding(active || this.keysDown);
	}

	/**
	 * Reports the state if that is news; publishes it and tells the server.
	 *
	 * The guard is not tidiness: it is what stops a repeat announcement from becoming a stream of remote calls, and
	 * it is also what makes the trailing `false` on a focus loss harmless when nothing was being held.
	 */
	private setHolding(active: boolean): void {
		if (this.holding === active) return;

		this.holding = active;

		// **And the client's own half of the same fact, which goes out to nothing.** The remote tells the
		// *server* what to do with the input; this tells the rest of the client what the input is, because one
		// reader needs to know: the moving clip cannot tell a sprint from a walk by looking at the body — both are
		// simply "moving" — so it asks the input. See `client/sprinting.ts`.
		//
		// Written inside the guard, so the published state changes exactly when the server is told that it has,
		// and a repeat announcement cannot become a stream of writes either.
		sprinting.set(active);

		// **The line per call, and it is the one to look for in a log.** It sits immediately above the send rather
		// than at either call site, so a session that prints "pressed" and nothing after it is a session where the
		// state did not actually change — the de-duplication working, rather than a dropped input. `sprinting.ts`
		// is the published value and `getRemote()` is the wire; this line is the only evidence that both were
		// reached, and it is why it is printed inside the guard rather than before it.
		if (DEBUG) print(`[Sprint] ${active ? "held" : "released"} — published and sent to the server`);

		this.getRemote().SendToServer(active);
	}

	/**
	 * **The action, and the bindings on it.** See the class doc for the whole of why; this is the wiring.
	 *
	 * **`pcall`, because these are the only instances here that a client might not be able to create.**
	 * `InputAction` and `InputBinding` are declared in this build's typings — `InputAction` is in
	 * `CreatableInstances`, so `new Instance("InputAction")` compiles — and the Input Action System is already used
	 * twice in this project: `IasTest`, whose recorded verdict is *"WASD seen: no, IJKL seen: yes"*, i.e. that the
	 * system binds and reports keys on a real client, and `AlternativeMovementController`, which walks a body with
	 * it. **So a failure is not expected, and it
	 * is caught anyway** because the alternative is a controller that throws inside `onStart` and takes the rest of
	 * the sprint down with it: a sprint that does not work is a far smaller loss than a boot that fails.
	 *
	 * **Both edges print, and the text box check lives in the handlers rather than here** — see the class doc for
	 * why that check is the one guard the action cannot make for itself.
	 */
	private bindKeys(): void {
		const [ok, built] = pcall(() => this.buildAction());

		if (!ok) {
			// **The one failure that has no other symptom.** A client that cannot create the instances cannot bind
			// anything and cannot report anything else, so this line is the whole of what a session would have to
			// say about it. Printed unconditionally, because it is not a diagnostic — it is a fault.
			print(`[Sprint] the Input Action System would not build the action: ${tostring(built)}`);

			return;
		}

		const action = built as InputAction;

		action.Pressed.Connect(() => {
			// **The guard the action cannot make for us.** `Pressed` carries no `gameProcessed` — the action is a
			// statement about a device, not about the GUI — so the "not while typing" rule is asked of the focused
			// text box directly. The release below is taken regardless, because a key-up is unambiguous and one
			// delivered while a box has focus is still a key-up.
			if (UserInputService.GetFocusedTextBox() !== undefined) return;

			this.keysDown = true;

			if (DEBUG) print("[Sprint] pressed — a shift key");
			this.holdSprint(true);
		});

		action.Released.Connect(() => {
			this.keysDown = false;

			if (DEBUG) print("[Sprint] released — a shift key");
			this.holdSprint(false);
		});

		// **Losing focus releases the keys, because the action is not guaranteed to see the key-up.** The window
		// that took focus receives it, so without this the sprint would continue for the rest of the session: the
		// client would never send `false`, and the server — which is told the state rather than asking for it —
		// would go on believing it. `DodgeController` clears its held keys on this same signal for the same reason.
		//
		// **And both pieces of the stick's state go with it**, which is the correction the times forced and which
		// still holds with one time left. The latch is the obvious half: the sprint is being released here, so the
		// loop's own account of what it asked for has to be made to say so. **The counter is the half that is easy
		// to miss**: a `stickBelowSeconds` that was 140ms old when the app went to the background would release a
		// sprint on the first frame after it came back, and the release is the one edge this mechanism still delays.
		// The engage hold's removal changed only the other direction — a thumb still on the stick no longer has to
		// re-earn a sprint over a fifth of a second; it re-earns it on the next frame that reads past the start
		// line, which is what "no delay" means.
		UserInputService.WindowFocusReleased.Connect(() => {
			this.keysDown = false;

			this.stickSprinting = false;
			this.stickBelowSeconds = 0;

			this.setHolding(false);
		});

		// Printed once at startup, for the reason the catch prints its bind: "the key does nothing" has two
		// completely different causes — the bind never happened, or the press never arrived — and this is the line
		// that tells them apart. Both keys are named, read from the list itself so that the line cannot fall out of
		// step with what is actually bound.
		if (DEBUG) {
			print(
				`[Sprint] IAS bound — ${SPRINT_KEYS.map((key) => key.Name).join(" + ")} on the "${ACTION_NAME}" ` +
					`action; the stick, where there is one, is read from the humanoid`,
			);
		}
	}

	/**
	 * The context and the action, made once.
	 *
	 * `ReplicatedStorage.Inputs` is where the engine's own documentation puts input contexts, and it is where this
	 * project's second one already lives — see `AlternativeMovementController.buildAction`. The folder is therefore
	 * shared and made idempotently rather than assumed, because the two controllers have no start order between
	 * them.
	 *
	 * **`Sink` is off**, exactly as it is on the movement context: sinking is what would let this context consume
	 * the shift keys and stop them reaching anything else, which is right for a context that means to *replace* a
	 * control and wrong for one that only wants to know whether it is being held. **The priority is the same `2000`
	 * the movement context uses**, for the reason recorded at that constant: it is the value the Input Action
	 * System's own documentation names as "high enough to sink its bound inputs before the default `PlayerScripts`
	 * contexts process them". A ladder nothing here climbs — the node is only read — but the same rung as its
	 * neighbour.
	 *
	 * **One binding per key rather than one binding holding both**, which is the arrangement the action is built
	 * for: bindings are ORed into the action's `Bool` state, so the pair is one input with two spellings and the
	 * overlap case (hold one, press the other, release the first) needs no code at all.
	 *
	 * **`Type` is left at `Automatic`**, which is hardware input — the alternative, `Scriptable`, is for a binding
	 * that is driven by `InputBinding:Fire()` and would never see a key.
	 */
	private buildAction(): InputAction {
		let inputs = ReplicatedStorage.FindFirstChild("Inputs");

		if (inputs === undefined || !inputs.IsA("Folder")) {
			const folder = new Instance("Folder");
			folder.Name = "Inputs";
			folder.Parent = ReplicatedStorage;

			inputs = folder;
		}

		const context = new Instance("InputContext");
		context.Name = CONTEXT_NAME;
		context.Enabled = true;
		context.Sink = false;
		context.Priority = CONTEXT_PRIORITY;
		context.Parent = inputs;

		const action = new Instance("InputAction");
		action.Name = ACTION_NAME;
		action.Type = Enum.InputActionType.Bool;
		action.Enabled = true;
		action.Parent = context;

		for (const key of SPRINT_KEYS) {
			const binding = new Instance("InputBinding");
			binding.Name = key.Name;
			binding.Type = Enum.InputBindingType.Automatic;
			binding.KeyCode = key;
			binding.Parent = action;
		}

		return action;
	}

	/**
	 * **The mobile sprint: the body's own move velocity, read once a frame, against two levels and two times.**
	 *
	 * **Why this is not a third lookup, which is what this feature's history demands an answer to.** Two previous
	 * passes read the stick from Roblox's own control module (`GetMoveVector`, through a `require` of a
	 * `ModuleScript` found by name) and then from the touch GUI (`TouchGui` → `ThumbstickFrame` → `StickImage`,
	 * measured geometrically). **Both failed on a real client, silently, and for the same reason**: each asked
	 * somebody else's tree for something *by name* — a module name, a child name, an instance that has to be
	 * `Visible` — and on this client neither name is there to find, so both readers returned nothing at all. A
	 * third read of that kind would be a third coin toss.
	 *
	 * **This one asks an object this project already holds, by a method the typings declare.** `Humanoid` is the
	 * character's own class and `GetMoveVelocity` is a real member of it (`include/generated/None.d.ts`), and the
	 * reference documents what it returns as *"the product of `WalkSpeed`, the intended movement direction, and the
	 * current percent walk speed"*. Dividing its horizontal magnitude by `WalkSpeed` therefore gives back **that
	 * last factor** — which is what "how far is the stick pushed" means on a client whose movement is analog. It
	 * needs no module, no `require`, no GUI, no instance name, and no assumption about which layout of Roblox's
	 * scripts is installed. See {@link stickMagnitude} for the arithmetic.
	 *
	 * **Two caveats, named rather than hidden.** **The first**: this project has already measured this method
	 * reading `0` — `NpcService` records it for rigs, which are driven by `Humanoid:MoveTo()` and have no input to
	 * report, which is why rig animation asks `Humanoid.Running` instead. That is consistent with this use rather
	 * than against it: a *player's* body is exactly the body that has input. **The second**: on a device whose touch
	 * movement mode is the thumbpad or the DPad the fraction is `1` whenever the pad is off centre, so the start
	 * threshold is met by any push — see {@link SPRINT_START_MAGNITUDE}. Both are things the lines below can show
	 * and neither can be settled from this repository.
	 *
	 * **`Heartbeat` and not `RenderStepped`**, which is the argument the deleted reader made and which still holds:
	 * the reading is a fact about *input*, nothing on screen is derived from it, and `RenderStepped` would put it in
	 * the frame budget of every phone for a value that changes at thumb speed. **Polled rather than subscribed**
	 * because there is no signal for it. `Humanoid.Running` is the plausible alternative and it is refused for a
	 * reason that is visible in its own documentation: it fires on the speed's *edges* and reports the running
	 * speed, not the fraction of the walk speed, so a threshold on it would divide by the same number this does
	 * while also depending on when the engine chooses to fire. One read a frame is the cheaper uncertainty.
	 *
	 * **The diagnostics are part of the loop rather than an extra**, and there are six: the line saying the loop
	 * started, with the two thresholds it is using; the resize's own line from {@link scaleStickFrame}; the reading
	 * line; the rejected-crossing line; and one line per edge. **A session with
	 * no sprint in it should be readable from its log alone**, because two sessions were not — and the case this
	 * pass exists for produces no edge at all, so the rejection line is the only proof that it happened.
	 *
	 * **The reading line reports a *change* rather than a peak, and that is a correction bought by the same log the
	 * thresholds came from.** It used to print only when the reading rose a tenth above the highest it had ever
	 * been — which is monotone, and therefore blind by construction to the one number this design needs most: the
	 * level a walk *holds*. A session that walked at `0.68` and pushed to `1.00` printed one line, about the push,
	 * and nothing at all about the walk the pair was supposed to clear. It now prints on any change of
	 * {@link STICK_REPORT_STEP} in either direction, so both plateaus appear — and the peak framing went with it,
	 * because a line that reports falls has no peak to name. That log is where `0.95`/`0.85` came from; this is the
	 * instrument that makes them checkable on a phone.
	 *
	 * **The resize still runs first, and it no longer feeds the pair.** {@link scaleStickFrame} is called here so
	 * that one session says, once, what the engine's stick was found to be and what the `UIScale` did to its drawn
	 * size; **the two thresholds this loop compares against are literals**, because the previous pass's divide by
	 * that measured ratio is exactly what put a start line at `0.667`, underneath a walk. See
	 * {@link SPRINT_START_MAGNITUDE} for the log that settled it.
	 */
	private watchStick(): void {
		let humanoid = this.humanoidOf(this.player.Character);

		// **The event and the re-resolve, for the race the movement controller records at length**: `CharacterAdded`
		// hands over the model, the model's children replicate separately, and the event does not fire a second time
		// for the same character — so a miss here is permanent and silent.
		this.player.CharacterAdded.Connect((character) => {
			humanoid = this.humanoidOf(character);
		});

		this.player.CharacterRemoving.Connect(() => {
			humanoid = undefined;
		});

		// **The resize before the loop, so that this session reports what it found before it starts reading.** See
		// {@link scaleStickFrame}, which waits on the engine's touch GUI — which is why this whole method is spawned
		// rather than run inline. It reports; it decides nothing.
		this.scaleStickFrame();

		if (DEBUG) {
			print(
				`[Sprint] mobile — reading the stick from Humanoid:GetMoveVelocity() ÷ WalkSpeed; start ` +
					`${SPRINT_START_MAGNITUDE}, stop ${SPRINT_STOP_MAGNITUDE} (literals — the drawn size of the ` +
					`stick does not move them); press on the crossing, release ${SPRINT_RELEASE_SECONDS}s`,
			);
		}

		/**
		 * The last reading this line reported, and how many times it has reported. **The last *reported* value
		 * rather than the largest one seen**, which is the whole of the change: a peak cannot show the level a walk
		 * holds, and that is the number the two thresholds are placed against. See the print below.
		 */
		let reported = 0;
		let reports = 0;

		// **Nothing here is disconnected, and that is the controller's own lifetime rather than an oversight**: a
		// Flamework controller is started once and lives as long as the client does, so a connection made in
		// `onStart` has nothing to be cleaned up against. The deleted version used a Fusion scope because it was
		// handed one; this loop owns nothing that needs one.
		//
		// **And the callback takes the frame's own duration, which is this feature's clock** — `Heartbeat` hands
		// every listener the time since the last one, so the one time below is measured in the engine's own game
		// time and no clock has to be read. See {@link SPRINT_RELEASE_SECONDS}.
		RunService.Heartbeat.Connect((delta) => {
			if (humanoid === undefined) humanoid = this.humanoidOf(this.player.Character);

			const magnitude = this.stickMagnitude(humanoid);

			// **Nothing is derived here, and that is the point of this pass.** The two thresholds are the constants
			// themselves: they used to be divided by whatever scale {@link scaleStickFrame} had measured on the
			// drawn stick, which put the start line at `0.667` — underneath the `0.68` a walk holds — and made a walk
			// sprint. See {@link SPRINT_START_MAGNITUDE}.

			// **The level, printed when it *changes* — and that is a correction rather than a tic.** This line used
			// to fire only when the reading rose a tenth above every reading before it, which made it a record of
			// pushes and nothing else: the plateau a walk *holds* is the number that decides where the thresholds
			// go, and a monotone line cannot show it. It now prints on any change of {@link STICK_REPORT_STEP} in
			// either direction, so a session in which a player walks and then pushes prints the walking level, the
			// push level, and the steps between them. See {@link STICK_REPORT_LIMIT} for the cap.
			//
			// **The suffix names which side of the start line the reading is on**, because that is the one thing
			// the number cannot say for itself: `0.45` and `0.63` are both "the stick is pushed", and only the
			// comparison says whether either of them is a sprint.
			if (DEBUG && reports < STICK_REPORT_LIMIT && math.abs(magnitude - reported) >= STICK_REPORT_STEP) {
				reported = magnitude;
				reports += 1;

				print(
					`[Sprint] mobile — the reading ${string.format("%.2f", magnitude)}` +
						(magnitude >= SPRINT_START_MAGNITUDE ? " (past the start line)" : ""),
				);
			}

			// **The frame's own duration, clamped — and this is the clock the whole mechanism runs on.** The reason
			// it is `Heartbeat`'s delta rather than `os.clock()` is in the tombstone above
			// {@link SPRINT_RELEASE_SECONDS}, and {@link SPRINT_DELTA_LIMIT} is the one thing the delta needs done
			// to it.
			const step = math.min(delta, SPRINT_DELTA_LIMIT);

			// **Two tests, where there used to be three.** The levels say *where* the player is asking, and the one
			// time left says when the asking stops. The *engage* test used to be a third — a crossing only counted
			// once it had survived `SPRINT_HOLD_SECONDS` — and there was a log line for a crossing that did not, so
			// both went together. See that constant's tombstone for what the absence costs.
			//
			// **And the state is a latch, so `holdSprint` is only ever called on an edge** — not once per frame with
			// a value the other side merely de-duplicates. Two guards, deliberately: this latch is the loop's own
			// account of what it last asked for, and `setHolding` has one of its own. The line before each call is
			// what makes the edge visible in a log, which is the whole of what was missing when this feature first
			// failed. **With the hold gone the latch is doing more work than it was**: it is now the only thing
			// standing between a reading that sits on the start line and a call every frame, because `magnitude >=
			// SPRINT_START_MAGNITUDE` is true on *every* frame of a sustained push rather than on the last frame of
			// a 0.2s window.
			if (!this.stickSprinting) {
				if (magnitude >= SPRINT_START_MAGNITUDE) {
					this.stickSprinting = true;
					this.stickBelowSeconds = 0;

					if (DEBUG) print(`[Sprint] pressed — stick ${string.format("%.2f", magnitude)} (over start)`);

					this.holdSprint(true);
				}
			} else if (magnitude < SPRINT_STOP_MAGNITUDE) {
				this.stickBelowSeconds += step;

				if (this.stickBelowSeconds >= SPRINT_RELEASE_SECONDS) {
					this.stickSprinting = false;

					if (DEBUG) print(`[Sprint] released — stick ${string.format("%.2f", magnitude)} (under stop)`);

					this.holdSprint(false);
				}
			} else if (this.stickBelowSeconds > 0) {
				// **A dip that came back before the release time: the sprint was never in doubt.** It used to be the
				// mirror of a rejection line — the engage hold's, for a push that rose past the start line and came
				// back before the hold expired — and that line is gone with the hold. It is still deliberately *not*
				// printed on its own account: a line for every momentary ease-off would double the log for a case no
				// player has reported, and the release edge line is the record of the one that mattered.
				this.stickBelowSeconds = 0;
			}
		});
	}

	/**
	 * **The engine's movement stick, drawn bigger — and a report of what the drawing actually did.**
	 *
	 * **The route is the jump button's, for the jump button's reason.** `restyleEngineJump` dresses the engine's own
	 * touch button and writes exactly one size-related thing to it: a `UIScale` child. The reference says that
	 * property's `Scale` "is used to multiply the `AbsoluteSize` of the parent UI element", so the engine's layout —
	 * which writes `Size` and `Position` and re-writes them on every viewport change — is left completely alone.
	 * **A `Size` write is the other answer and it is the one that cannot work**: the module lays the stick out per
	 * device and per mode, so a size written here is reverted by the next layout pass.
	 *
	 * **The argument this method used to *act* on is settled, in the direction the doubt was raised.** The *engine's*
	 * radius is what the reading is a fraction of, and the previous pass divided the thresholds by the ratio that
	 * measured what the `UIScale` had done to the frame — on the assumption that the engine reads the scaled
	 * `AbsoluteSize`, because a touch arrives in screen pixels. **The log says it does not**: with that divided pair
	 * in force, sprint edges fired on readings of `0.71` and `0.83` during ordinary play while readings still
	 * reached `1.00`. **So nothing here computes a threshold any more** — the pair is two literals. See
	 * {@link SPRINT_START_MAGNITUDE} and {@link STICK_SCALE}.
	 *
	 * **What the measurement is kept for is therefore the one thing it can still say: whether the resize landed.**
	 * `AbsoluteSize` is read before the scale is written and again once a frame has passed, and both numbers go to
	 * the log. A scale that does nothing — because the engine overwrote it, because the frame's size comes from a
	 * constraint, because the instance landed somewhere the renderer ignores — reads there as two equal sizes. That
	 * is a fact about what the player sees, which is all this method is for now.
	 *
	 * **Nothing is scaled on the pad modes**, and this is the whole of that decision: their reading is `1` at any
	 * pressure, so a bigger frame buys no resolution and would only change the look of a control this file has no
	 * business touching. The finder still finds them, and finding one is how the log says which mode this client is
	 * in.
	 */
	private scaleStickFrame(): void {
		if (STICK_SCALE === 1) {
			if (DEBUG) print("[Sprint] mobile — STICK_SCALE is 1, so the stick keeps the size the engine gave it");

			return;
		}

		const frame = this.findStickFrame(this.player.WaitForChild("PlayerGui") as PlayerGui);

		if (frame === undefined) {
			if (DEBUG) print("[Sprint] mobile — no stick frame, so the resize is skipped and the pair stands");

			return;
		}

		if (frame.Name === "Thumbpad" || frame.Name === "TouchDPad") {
			if (DEBUG) {
				print(
					`[Sprint] mobile — ${frame.GetFullName()} is a pad mode, whose reading is 1 at any pressure; ` +
						`the resize is skipped and the pair stands`,
				);
			}

			return;
		}

		// **The instance is made at `Scale = 1` before anything is measured**, which is what makes the measurement
		// below honest: the typing does not state a default for this property, and a scale read or written at the
		// wrong moment is either a frame collapsed to nothing or a `before` that was never the engine's own size.
		let existing = frame.FindFirstChild("StickScale");

		if (existing === undefined || !existing.IsA("UIScale")) {
			// **A separate local rather than a reassignment of `existing`**, and the compiler is the reason: that
			// variable is declared `Instance | undefined`, so a `UIScale` assigned into it loses its own members and
			// `created.Scale` would not be writable on it. The cast below is what puts the type back.
			const created = new Instance("UIScale");
			created.Name = "StickScale";
			created.Scale = 1;
			created.Parent = frame;

			existing = created;
		}

		const uiScale = existing as UIScale;
		const before = frame.AbsoluteSize;

		uiScale.Scale = STICK_SCALE;

		// **A frame for the layout pass, and a second look if the first says nothing moved.** `AbsoluteSize` is a
		// product of the layout pass rather than of the write, so reading it in the same frame as the write reports
		// the *old* size — and the whole point of measuring is to be able to tell "the scale did nothing" from "the
		// size had not caught up yet".
		task.wait();

		let after = frame.AbsoluteSize;

		if (after.X === before.X) {
			task.wait();
			after = frame.AbsoluteSize;
		}

		// **The ratio, and it is a report rather than an input.** Nothing beyond the line below reads it: the pair is
		// literal, so a resize that lands changes the drawing and not one threshold. See
		// {@link SPRINT_START_MAGNITUDE}.
		const applied = before.X > 0 ? after.X / before.X : 1;

		if (DEBUG) {
			print(
				`[Sprint] mobile — the stick is ${frame.GetFullName()} (${frame.ClassName}) at ` +
					`${string.format("%.0fx%.0f", before.X, before.Y)}px, drawn at ` +
					`${string.format("%.0fx%.0f", after.X, after.Y)}px (x${string.format("%.2f", applied)}); ` +
					`drawing only — the thresholds stay ${SPRINT_START_MAGNITUDE}/${SPRINT_STOP_MAGNITUDE}`,
			);
		}

		// **If the frame goes away, the drawing goes with it and nothing else does.** The engine builds these frames
		// per movement mode, so a mode change mid-session may take this instance away, `UIScale` and all — which is a
		// *drawing* to report rather than a threshold to move, because the pair is literal. **Re-scaling is still
		// deliberately not done**: a frame rebuilt for a mode this file has not seen is a frame to *report*, not one
		// to dress from a distance. See {@link STICK_FRAME_NAMES}.
		frame.Destroying.Connect(() => {
			if (DEBUG) print(`[Sprint] mobile — ${frame.Name} went away, so the stick is at engine size again`);
		});
	}

	/**
	 * **The engine's movement stick, found in the touch GUI — or `undefined` if this client's shape is not one this
	 * file knows.** See {@link STICK_FRAME_NAMES}.
	 *
	 * **Two routes, and the second exists because the first has already failed once on a real client.** The named
	 * route is the engine's own name for the frame, tried recursively because these modules have nested the frames
	 * differently over the years. **The deleted reader searched exactly this way and found nothing** — it also
	 * required the frame to be `Visible`, which this one does not, and that difference matters: a stick that exists
	 * but is hidden is not a stick the player is using, but it is still the frame whose radius a reading is a
	 * fraction of.
	 *
	 * **The structural route is what to fall back on when the names have moved**: a direct child of the control
	 * frame that is a `GuiObject` but **not** a `GuiButton` — the engine's jump button is a `TextButton`, and this
	 * must never touch it — and that contains an `ImageLabel`, which is what a thumb is drawn as. Direct children
	 * only, so the walk cannot wander into the middle of another control's internals; the named route is what covers
	 * a deeper nesting.
	 *
	 * **A miss prints the neighbours, by name and class** — the same dump the deleted reader printed when it failed,
	 * and the line that will name the frame on the next session rather than leaving it to be guessed at again.
	 */
	private findStickFrame(playerGui: PlayerGui): GuiObject | undefined {
		const touch = playerGui.WaitForChild("TouchGui", STICK_FRAME_WAIT_SECONDS);

		if (touch === undefined) {
			if (DEBUG) {
				print(
					`[Sprint] mobile — no TouchGui after ${STICK_FRAME_WAIT_SECONDS}s, so there is no stick to find`,
				);
			}

			return undefined;
		}

		const control = touch.FindFirstChild("TouchControlFrame", true);

		if (control === undefined) {
			if (DEBUG) print("[Sprint] mobile — TouchGui holds no TouchControlFrame, so there is no stick to find");

			return undefined;
		}

		for (const name of STICK_FRAME_NAMES) {
			const found = control.FindFirstChild(name, true);

			if (found !== undefined && found.IsA("GuiObject") && !found.IsA("GuiButton")) {
				if (DEBUG) print(`[Sprint] mobile — the stick's frame is ${found.GetFullName()}, found by name`);

				return found;
			}
		}

		for (const child of control.GetChildren()) {
			if (!child.IsA("GuiObject") || child.IsA("GuiButton")) continue;
			if (child.FindFirstChildWhichIsA("ImageLabel", true) === undefined) continue;

			if (DEBUG) print(`[Sprint] mobile — the stick's frame is ${child.GetFullName()}, found by its shape`);

			return child;
		}

		if (DEBUG) {
			const held: string[] = [];
			for (const child of control.GetChildren()) held.push(`${child.Name} (${child.ClassName})`);

			print(
				`[Sprint] mobile — no stick frame under TouchControlFrame, by name ` +
					`(${STICK_FRAME_NAMES.join(", ")}) or by shape. It holds: ${held.join(", ")}`,
			);
		}

		return undefined;
	}

	/**
	 * **The stick's push, as a fraction of this body's walk speed — the number the two thresholds are about.**
	 *
	 * `GetMoveVelocity` is the *intended* velocity rather than the measured one: `WalkSpeed × the intended
	 * direction × the current percent walk speed`. Dividing by `WalkSpeed` gives that last factor back, so the
	 * result is `0` at rest and `1` with the input fully applied. **Dividing by the live `WalkSpeed` and not by a
	 * constant is what makes it survive the sprint itself**: the walk speed is the pooled, server-owned number this
	 * game changes when a sprint is granted, and a reading built on a fixed base would jump by the sprint's own
	 * contribution the instant the sprint began — the sensor reporting its own effect. This way it cancels.
	 *
	 * **Horizontal only.** A body falling or being thrown reads a vertical component, and "pushed to the rim" says
	 * nothing about it: the sprint is a walk.
	 *
	 * **No body, or a body whose walk speed is zero, reads `0`** — the value that *stops* a sprint rather than
	 * holding one, so a character that dies mid-push releases it on the next frame. That is the behaviour a player
	 * expects and it is one line of arithmetic rather than a branch on health.
	 */
	private stickMagnitude(humanoid: Humanoid | undefined): number {
		if (humanoid === undefined) return 0;

		const walkSpeed = humanoid.WalkSpeed;
		if (walkSpeed <= 0) return 0;

		const velocity = humanoid.GetMoveVelocity();

		return math.clamp(new Vector3(velocity.X, 0, velocity.Z).Magnitude / walkSpeed, 0, 1);
	}

	/** The local player's live humanoid, or nothing while there is no body to read. */
	private humanoidOf(character: Model | undefined): Humanoid | undefined {
		return character?.FindFirstChildWhichIsA("Humanoid");
	}

	private getRemote(): ClientRemotes["setSprinting"] {
		if (!this.sprintRemote) {
			this.sprintRemote = events.Client.Get("setSprinting");
		}

		return this.sprintRemote;
	}
}
