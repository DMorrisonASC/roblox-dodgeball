import { Controller, OnStart } from "@flamework/core";
import { GuiService, Players, RunService, UserInputService, Workspace } from "@rbxts/services";
import { isMobile } from "../../platform";
import { PREMIUM, premiumHudTheme } from "../../ui/premiumTheme";
import { getStickScreenGui } from "../../ui/screenGui";

/** Prints the mount line, the engine-stick probe, and one line per grab and per release. */
const DEBUG = false; // off for frame time — see shared/config/debug.config.ts

/**
 * **The mobile joystick: a ring this project draws, over the engine's own stick rather than instead of it.**
 *
 * **Why the engine's stick could not simply be made bigger.** Its size is not this project's to set: a `Size` write
 * is reverted by the ControlModule on its next layout pass, which runs on every viewport change. A `UIScale` does
 * stick, and it does change what is *drawn* — but it changes nothing about the number a reading is a fraction of,
 * and the previous pass proved those are two different things: a `1.5×` scale left the walk plateau at exactly the
 * `0.68` it had been, and dividing the sprint's thresholds by the measured ratio then made ordinary walks sprint.
 * **So the drawn size can be ours while the usable size stays the engine's, and this file takes exactly that deal**:
 * the ring is what a player sees and what says where their thumb is, while the engine's own stick is hidden —
 * drawing only, by a `UIScale` the module cannot revert (see {@link ENGINE_STICK_SCALE}) — and left listening
 * underneath it, which is why a touch that lands on its region and not on the ring still walks the character.
 *
 * **And the ring is drawn where the thumb is, not where the corner is — which is the shape this file's second
 * pass was asked for in the user's own words: *"My custom joystick is stuck on left bottom. Can we make it
 * dynamic?"*** The first cut parked the ring in the corner and made the player find it, which is a fixed stick with
 * our paint on it. What a *dynamic* stick does is the engine's own description of its `DynamicThumbstick` (quoted
 * with the mode list below) — the base appears where the finger landed, so the travel runs from wherever the thumb
 * already was and **the reading is exactly `0` at the moment of the grab**. Three things make that work here:
 *
 * - **A movement zone that accepts a touch that never came near the ring**
 *   ({@link MOVEMENT_ZONE_WIDTH_SCALE} and {@link MOVEMENT_ZONE_HEIGHT_SCALE}), because "the base appears under the
 *   thumb" is a lie if the thumb has to touch the base first. The zone is the lower-left of the screen, which is
 *   where a left thumb rests and where nothing else in this client is drawn.
 * - **A `TextButton` of its own covering that zone** ({@link PAD_NAME}), and this is the part that is not optional:
 *   the engine's touch camera rotates the view on a drag that is not over a control, so a stick that grabbed a
 *   finger hanging in open space would spin the camera on every push. The pad is the sink for the whole region, and
 *   the ring stays a sink for its own circle.
 * - **The base returning to the corner on release**, so the base is in one known place whenever no finger is on the
 *   screen. **The corner is not drawn** — see the paragraph after this list — and the write is kept because the
 *   ring's own *circle* is the second grab test: a base left where the last thumb ended would leave that circle in
 *   the wrong place for the next touch, which is the one case where that test is the load-bearing one.
 *
 * **And the stick is only on the screen while it is being used, which this paragraph exists for.** The ask was the
 * user's, in as many words — *"I want my joystick to 'disappear' when not actively being used"* — and it is the
 * engine's own behaviour rather than a new invention: the reference's description of `DynamicThumbstick`, quoted
 * below, is "a virtual thumbstick that **appears** when they touch the lower portion of the screen", and this file
 * is a drawing of that stick rather than an alternative to it, so the resting state is now the same kind of absence
 * on both. The ring and the thumb are drawn from the grab that accepts a touch until the release that ends it, and
 * not one frame either side. **The cost is the affordance, and it is real**: the ring in the corner was how a
 * player could see that a stick existed and where it would appear, and with it gone the only answer to "where do I
 * push" is the movement zone — a *region* rather than a target, which is what makes it usable without a picture of
 * it, and which is why {@link MOVEMENT_ZONE_WIDTH_SCALE} and {@link MOVEMENT_ZONE_HEIGHT_SCALE} are the numbers to
 * reach for if the stick ever proves hard to find. **What the hiding does not change is any of the input**: both
 * grab tests are this file's own arithmetic rather than the engine's hit-test, so they read the same either way,
 * and the pad that sinks those touches is invisible by `BackgroundTransparency` rather than by `Visible` precisely
 * so that hiding a ring can never open a hole in it.
 *
 * **And where a touch is measured from is the single most expensive thing this file has ever got wrong — and the
 * fix was to stop having two possible answers rather than to pick the right one.**
 *
 * A touch arrives as an `InputObject.Position`, and **that number is expressed in the space of the safe region**:
 * the screen minus Roblox's topbar and the device's cutouts, which is the region a `CoreUISafeInsets` `ScreenGui`
 * uses and is the mobile client's default. Two engine statements bear on it and neither is decisive alone —
 * `InputObject.Position`'s page says the inset *"is accounted for in the position"*, which reads as "already added"
 * to one person and "expressed in that space" to the next, and `GuiObject.MouseMoved`'s sample reconciles its own
 * arguments with `GetGuiInset()` in the opposite direction from its `AbsolutePosition`. **Four passes went by on that
 * ambiguity, and each reading produced a build that looked finished.**
 *
 * **What settled it is a player looking at their own screen**, which is the only evidence here that cannot be argued
 * with. *"Above and left of my thumb"*, with the base and the dot offset by the same constant, is what *"reported in
 * the inset's space, drawn in the screen's"* looks like as a picture — and the five cluster buttons firing when the
 * cursor is over them gave the other half: those GUIs' drawing is self-consistent, so the difference was on the
 * *input's* side. **Every log line this file printed had been telling the truth; the two numbers simply came from
 * different origins.**
 *
 * **So the ring moved house.** It used to be drawn in `getScreenSpaceGui()` — `ScreenInsets.None`, i.e. the screen's
 * own origin — which made a conversion mandatory somewhere, and four passes went into arguing about which direction
 * and which object. **The ring, the thumb and the movement zone now all mount into `getStickScreenGui()`, a
 * `ScreenGui` at `CoreUISafeInsets`**, which is the region a touch is reported in — so a touch position, the ring's
 * `Position` and the pad's `AbsolutePosition` are one kind of number, and the conversion is *deleted rather than
 * corrected*. See the note where that conversion used to be defined for what would bring it back.
 *
 * **Why the engine's own picking hides this from everyone.** `MobileControlsController` presses its five buttons
 * accurately while being handed input numbers from another space, so the obvious reading — that the two spaces are
 * one space — looks proven by that alone. It is not, and the reason is that **the engine does its own picking per
 * GUI**: it converts an input into each `ScreenGui`'s layout space before deciding which element was hit, so a
 * button answers to the cursor over it no matter which space the *number handed to scripts* is in. **What breaks is
 * only the comparison a script makes for itself**, which is why this file and not the cluster was the one that spent
 * four passes on it.
 *
 * **And the two input APIs really are in different spaces, which is the other half of the story.**
 * `GetMouseLocation()` is documented as screen-relative, so the aim sight belongs in `getScreenSpaceGui()` and stays
 * there; a touch is reported in the safe region's space, so the stick belongs in a GUI that insets. That is why there
 * are now two GUIs answering two different questions, rather than one shared GUI pretending they are the same
 * question.
 *
 * **The false positive that cost a session is worth keeping, because it is the shape of one.** A live log showed two
 * touches of one session landing on the ring's own middle *after* `GetGuiInset()` was added to them and 80–90 pixels
 * outside it without — arithmetic that reads like proof and is not: the player was testing a *dynamic* stick, so
 * touching near the ring is what a player does with or without an offset, and two samples of a habit cannot outvote
 * a statement about coordinate spaces. **The lesson is about the order of the evidence: read what the reference
 * says, measure it in-engine when an API allows, and when the reference itself is ambiguous, break the tie with a
 * question about the screen rather than with more arithmetic against a log.**
 *
 * **What *instead of it* would have cost is the jump button**, and that is the whole reason this is a deal rather
 * than a replacement: `Scriptable` is the mode that removes the engine's touch controls outright, and the jump goes
 * with them. See `main.server.ts`, which tried that mode, reverted it, and carries both logs.
 *
 * **The switch is `Player.DevTouchMovementMode`, and neither this file nor the server throws it — a decision with
 * three sessions' logs behind it rather than a shortfall.** The reference's own words for the members that matter:
 * `Scriptable` is *"The player's character will not respond to default controls; any character movement must be
 * defined in custom scripts"*, and `DynamicThumbstick` is *"a virtual thumbstick that appears when they touch the
 * lower portion of the screen"* — and the place file is on `UserChoice`, *"Allows players to choose their desired
 * control scheme from the in-experience menu… the default movement mode"*. **A client cannot set the property at
 * all**: a `LocalScript` write is refused with *"The current thread cannot set 'DevTouchMovementMode' (lacking
 * capability `RobloxScript`)"*, and `RobloxScript` is a capability of the **thread** rather than of the peer, so a
 * server script has no more claim on it — the attempt this file used to make produced Studio's *"Insufficent
 * permissions to set DevTouchMovementMode"* every session until it was deleted. **The server's attempt works and was
 * reverted anyway**: `Scriptable` takes the engine's jump button with it, and `Thumbstick` draws a second stick in
 * this ring's own corner — both logs are in `main.server.ts`, which now sets nothing so that the mode stays the
 * player's. **Because the setting is not ours, all this file can do about the engine's stick is draw and hide** — it
 * draws the ring unconditionally and hides whichever stick frame the engine puts in the tree — and the mount's mode
 * line is what says which state a session is in.
 *
 * **The movement path is `Humanoid:Move`, which is the engine's own** — the call the default control scripts
 * make, not a replacement for it. That is what keeps everything downstream working: the humanoid really walks,
 * so its animations, its `MoveDirection` and the `GetMoveVelocity()` the sprint reads are all produced by the
 * engine exactly as they were. **What this file replaces is the *input*, not the movement.**
 *
 * **And the ring is a `TextButton` rather than a `Frame`, for one reason that is not about its look: it has to
 * sink the touch.** The engine's touch camera rotates the view on a drag anywhere that is not over a control,
 * so a stick that let its own finger through would spin the camera every time a player pushed forward. A
 * `GuiButton` is the form of sinking this codebase already relies on (`MobileControlsController`'s buttons), and
 * it is why `gameProcessedEvent` is **deliberately not tested** below — our own ring is what sets it. **The
 * dynamic pass made that two sinks rather than one**: the ring still sinks its own circle, and {@link PAD_NAME}
 * sinks the rest of the movement zone, because a base that appears under a thumb necessarily leaves the finger
 * hanging in the open for the first frame of every push.
 *
 * **What this is not:** not a replacement for the engine's stick, which is the deal the first paragraph strikes and
 * which gives this file its one standing cost — **the engine's stick is still live underneath**, writing movement
 * from the same finger, so a character that walks is not evidence about this ring (see {@link hideEngineStick}, and
 * the mount's mode line, which exists to say what the engine is doing on this client). It is also not a
 * `PlayerModule` fork: nothing here reaches into the module, and the only engine object it touches is the property
 * the reference publishes for exactly this purpose. And on a non-touch client it does nothing at all.
 */
@Controller()
export class TouchJoystickController implements OnStart {
	public onStart(): void {
		// Spawned for the reason every controller in this project does it: the mount creates instances and waits
		// on the engine's own GUI, and none of that is something the rest of the client's boot should sit behind.
		task.spawn(() => this.mount());
	}

	private mount(): void {
		// **The gate, and it is the whole of this file's behaviour on a desktop client.** `isMobile()` is
		// `TouchEnabled && !KeyboardEnabled`, so a touchscreen laptop with a keyboard in front of it keeps the
		// engine's controls and the keyboard, and nothing here runs.
		if (!isMobile()) {
			if (DEBUG) print("[Joystick] not a touch client — the engine's own controls are left alone");

			return;
		}

		const player = Players.LocalPlayer;
		const playerGui = player.WaitForChild("PlayerGui") as PlayerGui;

		/**
		 * **The engine's movement mode, read once and reported — and deliberately not written, which is a settled
		 * decision rather than an omission.**
		 *
		 * **This file tried that write and cannot have it.** `player.DevTouchMovementMode = …` throws
		 * `"The current thread cannot set 'DevTouchMovementMode' (lacking capability RobloxScript)"`, with Studio's
		 * own line above it reading *"Insufficent permissions to set DevTouchMovementMode"* — and `RobloxScript` is a
		 * property of the *thread* rather than of the peer, so no script on either side has it. The attempt ran every
		 * session and was refused every session; it is gone, and the error line it produced is gone with it.
		 * **But that is not permission to set it from the server either, and that was tried twice in one day.**
		 * `Scriptable` works — a session printed `[main] engine touch movement — prospeed1: UserChoice ->
		 * Scriptable` — and takes the engine's jump button with it. `Thumbstick` works too, and puts a second circle
		 * in the ring's own corner. **So `main.server.ts` sets nothing now and carries both logs**, and **the mode is
		 * the player's**, which is what the place file's `UserChoice` means in the reference's own words.
		 *
		 * **Which leaves this file two things it can do about the engine's stick, and it does both:** the ring is
		 * drawn on every touch client with no gate at all (see the note where the stand-down used to be), and
		 * whichever stick frame the engine draws is hidden — see {@link hideEngineStick}, and
		 * {@link ENGINE_STICK_FRAME_NAMES} for the list that shipped without the fixed stick's name and therefore hid
		 * nothing on the one client it was written for. **What is left for this read to do is report**, in the words
		 * the modes actually need — see {@link modeNote}, which is where the cost of each one is written down.
		 */
		const engineMode = player.DevTouchMovementMode;

		if (DEBUG) print(`[Joystick] engine touch movement: ${engineMode.Name}${modeNote(engineMode)}`);

		/**
		 * **And the property is watched rather than read once, because the server's write may arrive a frame after
		 * this file starts.**
		 *
		 * A `PlayerAdded` handler on the server and this file's `onStart` are two scripts starting at the same join,
		 * and **the order between them is not promised** — so a one-off read can catch the place file's `UserChoice`
		 * and leave a session's log describing a mode the client was not actually in. That is a wrong conclusion
		 * about the *setting* rather than a wrong-looking ring, and it is four lines to remove.
		 *
		 * **A report and not a switch.** Nothing here re-mounts the ring or changes the mode: the ring is drawn
		 * whatever this property says, and the mode is the server's to set. The one thing that does react to it is
		 * {@link hideEngineStick}, and it reacts to the *first* read rather than to this signal — a mode changed
		 * mid-session is a server decision, and re-laying anything out for it is not this file's business.
		 */
		if (DEBUG) {
			player.GetPropertyChangedSignal("DevTouchMovementMode").Connect(() => {
				print(`[Joystick] engine touch movement changed to ${player.DevTouchMovementMode.Name}`);
			});
		}

		// **The engine's stick is hidden in whatever mode it appears, because the ring is the only stick this project
		// wants drawn.** It used to be hidden in `Thumbstick` alone, on the argument that a *dynamic* stick follows the
		// finger and a hidden one is a control nobody can see that still moves the character. **Two things changed
		// that.** The first is the fixed mode's own failure: it draws a second circle in the corner the ring already
		// occupies, and the hide missed it entirely — `ClassicThumbstickFrame` was not in
		// {@link ENGINE_STICK_FRAME_NAMES}, so a session showed both sticks with nothing in the log to say the hiding
		// had been attempted. The second is that **the mode is the player's now** (`main.server.ts` sets none), so
		// which frame appears is not something this file can plan for; all it can do is hide what it finds.
		// **The cost is unchanged and deliberate**: a hidden dynamic stick still writes movement, so a touch on the
		// lower screen that misses the ring can still walk the character with nothing under the finger.
		task.spawn(() => this.hideEngineStick(playerGui));

		// **And the ring is drawn on every touch client, with no gate on the mode at all — which replaces a stand-down
		// that cost a session's worth of looking for nothing.** It used to refuse to draw unless the mode was
		// `Scriptable`, on the argument that two writers on one humanoid is worse than either alone. **The argument is
		// still true; it was simply not this file's to act on.** The mode is the server's to set (see
		// `main.server.ts`), so a client that cannot change it bought the player no ring and no alternative — and two
		// writers is a state to fix at the setting rather than a state to hide from by not drawing. **What the gate
		// knew that this does not: with the engine's stick live, a character that walks is not evidence about this
		// ring** — it is evidence about the pair. That is what the mode line above is for.

		// **Answered from the game palette**, so the ring, its rim and the thumb are the same plum-and-gold as the
		// rest of the HUD — see `premiumHudTheme`. **The two "bright" colours below are written from `PREMIUM`
		// directly rather than through this record**, because `onAccent` on this palette is the ink for a *gold*
		// surface and the ring's lit state is white: one is a name that inverts and the other is not.
		const theme = premiumHudTheme();

		/**
		 * **The movement zone: an invisible `TextButton` over the lower-left of the screen, which is what makes a
		 * touch that never came near the ring count as a push.**
		 *
		 * A `TextButton` rather than the `Frame` it looks like it wants to be, for the ring's own reason (see the
		 * class doc): it has to **sink** the touch, or the engine's touch camera rotates the view for the whole of
		 * every push. That matters more here than it does for the ring, because this is the region a dynamic stick
		 * grabs a finger in and a finger there is over *nothing* — there is no circle to hide behind.
		 *
		 * **It lives in the stick GUI with the ring, and the `ZIndex` that makes it harmless is a mechanism that works
		 * only there.** The pad has to lose every input contest it can be in — the cluster's buttons are bottom-right
		 * and the round-result panel is centred, and both are reachable places for a thumb — and a `GuiObject` at
		 * `ZIndex = 0` **can never win a contest against a sibling subtree at the default `1`**, because
		 * `ZIndexBehavior`'s default (`Sibling`) compares whole subtrees by their root's `ZIndex`. **That trick only
		 * works *inside* one `ScreenGui`**, which is itself an argument for the ring and the pad sharing a GUI: they
		 * have a contest to settle with each other — the pad under the ring — and siblings are the only mechanism
		 * there is for settling one.
		 *
		 * **What the shared GUI does *not* settle is the pad against the cluster**, which lives in
		 * `getScreenSpaceGui()`. Those are two `ScreenGui`s at the same `DisplayOrder`, so the order between them is
		 * their place in `PlayerGui` rather than anything this file says. **That is not a new risk**: the pad sat in
		 * `getHudScreenGui()` before this pass, a third GUI at the same rung, with the same question unanswered. It is
		 * bounded by geometry rather than by luck — the zone is the left 35% of the width and the cluster's left edge
		 * is at about 37% on every device this project has measured (see {@link MOVEMENT_ZONE_WIDTH_SCALE}).
		 * **If they ever do meet, the lever is that width, not the layering.**
		 *
		 * **Pure `Scale`, and no geometry of its own to recompute.** The zone is read back from the pad's own
		 * `AbsolutePosition`/`AbsoluteSize` when a touch arrives (see {@link grabZone}) rather than derived a second
		 * time from the viewport, so the numbers this file tests against are *the rect that sinks the touch* — which
		 * also means the engine's own re-layout on a rotation is all the maintenance the pad needs. That is the
		 * opposite of the ring, whose size cannot be a scale fraction (see {@link STICK_DIAMETER_SCALE}).
		 *
		 * **The cost, stated rather than discovered:** everything in this rectangle that is not a HUD button goes to
		 * the pad rather than to the game — a tap on the world in the lower-left does nothing. Nothing is drawn
		 * there and no other control wants those pixels (the cooldown readout, which did, was deleted on request),
		 * so the region is a fair price for a movement stick that sinks its own touches.
		 */
		const pad = new Instance("TextButton");
		pad.Name = PAD_NAME;
		pad.Text = "";
		pad.AutoButtonColor = false;
		pad.BackgroundTransparency = 1;
		pad.ZIndex = PAD_Z_INDEX;
		pad.AnchorPoint = new Vector2(0, 1);
		pad.Position = UDim2.fromScale(0, 1);
		pad.Size = new UDim2(MOVEMENT_ZONE_WIDTH_SCALE, 0, MOVEMENT_ZONE_HEIGHT_SCALE, 0);
		pad.Parent = getStickScreenGui();

		/**
		 * **The ring, which is the touch target and the input sink.** A `TextButton` with no text and no button
		 * colouring: everything it does here is a side effect of being a `GuiButton` (see the class doc), and the
		 * look is drawn with its own `BackgroundColor3` and a `UIStroke` rim.
		 */
		const ring = new Instance("TextButton");
		ring.Name = RING_NAME;
		ring.Text = "";
		ring.AutoButtonColor = false;
		ring.BackgroundColor3 = theme.colors.trough;
		ring.BackgroundTransparency = RING_FILL_TRANSPARENCY;
		// **And it is built hidden, which is the whole of "the joystick disappears when it is not being used".** A
		// resting stick is nothing on the screen now: the ring, and the thumb inside it, are drawn from the grab
		// that accepts a touch until the release that ends it, and not one frame either side. The class doc carries
		// the argument and the cost; the short version is that the engine's own dynamic stick behaves this way too,
		// and that the grab is decided by this file's own arithmetic rather than by the engine's hit-test, so hiding
		// the ring takes nothing away from the input. **`Visible` rather than a transparency**: an invisible
		// `GuiObject` is skipped for drawing *and* for input, and {@link PAD_NAME} is the sink for these touches
		// either way — which is the reason it is a `BackgroundTransparency = 1` button rather than a hidden one.
		ring.Visible = false;
		// **An offset position in screen pixels rather than the scale corner this used to be, because the ring's
		// place is now a *point* rather than a corner of the screen.** `placeBase` is its one writer and writes the
		// top-left of a circle whose centre is known, and the home position it returns to is derived in
		// `applyGeometry` from the viewport — so the one thing a rotation has to redo is the same thing a size
		// change redoes, and it is done in one place. See `placeBase` for why nothing is clamped to the screen.
		ring.AnchorPoint = new Vector2(0, 0);
		ring.Position = new UDim2();
		ring.Parent = getStickScreenGui();

		const corner = new Instance("UICorner");
		corner.CornerRadius = new UDim(1, 0);
		corner.Parent = ring;

		const rim = new Instance("UIStroke");
		rim.Color = theme.colors.accent;
		rim.Thickness = RING_RIM_THICKNESS;
		rim.Transparency = RING_RIM_TRANSPARENCY;
		rim.Parent = ring;

		/**
		 * **The thumb: the part the player watches.** A child of the ring, so it is positioned in the ring's own
		 * space and moves with it for free, and the only instance in this file written while a finger is down.
		 */
		const thumb = new Instance("Frame");
		thumb.Name = THUMB_NAME;
		thumb.AnchorPoint = new Vector2(0.5, 0.5);
		thumb.Position = new UDim2(0.5, 0, 0.5, 0);
		thumb.BackgroundColor3 = theme.colors.accent;
		thumb.BackgroundTransparency = THUMB_TRANSPARENCY;
		thumb.Parent = ring;

		const thumbCorner = new Instance("UICorner");
		thumbCorner.CornerRadius = new UDim(1, 0);
		thumbCorner.Parent = thumb;

		/**
		 * **The ring's radius in pixels, which is the denominator of every reading this file produces.**
		 *
		 * Written only by {@link applyGeometry} and read by the touch handlers and the render step, so the one
		 * number that decides what "fully pushed" means has one writer. It is in *pixels* rather than as a
		 * fraction because the thing being divided is a touch position in pixels.
		 */
		let radius = 0;

		/**
		 * **Whether the ring has ever been given its size, which is the flag the sizing line and the mount line
		 * both report on.**
		 *
		 * It exists because the geometry is derived *late* on a normal client — see the mount print's own note —
		 * so "did this work" is a question about a function that has not run yet by the time the mount is built. It
		 * sits beside {@link radius} rather than after the function because it is the same kind of thing: state
		 * that {@link applyGeometry} writes and that nothing else does.
		 */
		let sized = false;

		/**
		 * **Where the base is: the *centre* of the ring, in screen pixels, and the one place the ring's position is
		 * decided.**
		 *
		 * Kept here rather than read back out of `ring.AbsolutePosition` for the reason the geometry's own doc
		 * records about `AbsoluteSize`: an absolute read is a product of the layout pass, so a value written in this
		 * frame can read back as the *old* one — and every reading this file produces is a subtraction from this
		 * point, so a stale copy of it is a stick that reports the last frame's push. **The number written here is
		 * the number the reading is measured against**, which is what makes {@link placeBase}'s promise ("the
		 * reading is `0` at the grab") true by construction rather than by arithmetic that happens to agree.
		 */
		let centreX = 0;
		let centreY = 0;

		/**
		 * **The centre the base returns to when no finger is down.** Written only by {@link applyGeometry}, because
		 * it is a fact about the viewport and not about the touch, and read by the mount, by a new viewport, and by
		 * every release.
		 */
		let homeX = 0;
		let homeY = 0;

		/**
		 * **The one writer of the ring's position: put the base's centre at a screen point.**
		 *
		 * Called on three occasions and all three are deliberate: the mount and a new viewport send it {@link homeX}
		 * / {@link homeY} (the derived corner, see {@link STICK_EDGE_INSET_SCALE}), a grab sends it the touch — which
		 * is a screen point already, with no conversion anywhere in between — and a release sends it home again.
		 * **That is the whole of the dynamic behaviour** — the ring does not follow the thumb during a push, which is
		 * the difference between a stick and a cursor: the base is placed once where the finger started and the thumb
		 * moves inside it, and a base that followed the finger would be a stick whose reading is always zero.
		 *
		 * **Nothing here is clamped to the screen, and that is a decision about the first frame of a push rather
		 * than about tidiness.** Clamping a base against the screen's edge *moves the centre away from the finger* —
		 * and since the reading is the distance from the centre to the finger, a clamped base starts the push at
		 * whatever that distance happens to be, which on a touch at the very corner is a full push the player never
		 * asked for. Letting the base hang over the edge instead costs a sliver of a decorative circle being
		 * clipped, and keeps "the base is under the finger and the reading starts at `0`" true in every case.
		 */
		const placeBase = (x: number, y: number): void => {
			centreX = x;
			centreY = y;
			ring.Position = UDim2.fromOffset(x - radius, y - radius);
		};

		/**
		 * **The GUI inset: the two corners of the usable region, read from the engine and kept in one place.**
		 *
		 * `GetGuiInset()`'s first value is where the region starts, measured from the screen's top-left; the second
		 * is how far the region stops short of the screen's bottom-right. **This file uses them for two things and no
		 * more**: the *size* of the usable region, which the base's home is a fraction of (`applyGeometry`), and the
		 * numbers that print beside it. **Neither is a conversion for a touch** — the ring is drawn in a GUI whose
		 * origin already is this region's corner, so a touch needs no arithmetic at all. See the note where the
		 * conversion used to be defined.
		 *
		 * **Guarded, and the fallback is deliberately the behaviour of a build that draws its stick in the wrong
		 * place**: `(0, 0)` for both corners means "the input space is the screen space", which is exactly the
		 * assumption that put the whole stick a topbar up from the thumb on the one device whose inset is not zero.
		 * That is a better failure than no stick at all, and it is why the print below names the values rather than
		 * only the fact that they were read. The reason for the `pcall` is the lesson `ShiftLock` records about
		 * `UserSettings`: **an unguarded mount-time API call that throws takes the whole controller with it**, and
		 * this one is on the path of `applyGeometry`, which runs at the mount — so a failure would be a client with no
		 * ring, no movement and no error line, which is the worst shape a fault can have. A plain read that refuses is
		 * a client whose home is in the wrong place, which is visible and debuggable.
		 *
		 * **Refreshed rather than read per touch** (the handlers would otherwise pay a `pcall` per frame), and the
		 * refresh is hung on the same signal as the geometry: a rotation is the only thing that moves a cutout, and
		 * that is the event `applyGeometry` is already listening for.
		 */
		let insetNear = new Vector2();
		let insetFar = new Vector2();

		const readInsets = (): void => {
			const [ok, nearX, nearY, farX, farY] = pcall(() => {
				const [near, far] = GuiService.GetGuiInset();

				return $tuple(near.X, near.Y, far.X, far.Y);
			});

			if (!ok) {
				insetNear = new Vector2();
				insetFar = new Vector2();

				if (DEBUG) {
					print(
						"[Joystick] GuiService:GetGuiInset refused — assuming no GUI inset, which puts a touch back " +
							"in the screen's space; the ring will sit a whole inset away from the thumb if that is wrong",
					);
				}

				return;
			}

			insetNear = new Vector2(nearX, nearY);
			insetFar = new Vector2(farX, farY);
		};

		readInsets();

		/**
		 * **There is deliberately no function here that shifts a touch — the absence *is* the fix.**
		 *
		 * Every earlier version of this file had one (`padPointOf`, then `screenPointOf`, then both), because the
		 * ring was drawn in `getScreenSpaceGui()`, whose `ScreenInsets.None` means its coordinates start at the
		 * screen's own corner, while a touch is reported from the **inset region's** corner — the top bar and the
		 * device's cutouts are the difference. Two spaces one inset apart, so something had to reconcile them, and
		 * four passes went into arguing about which direction to shift and which object was in which space.
		 *
		 * **The answer was to stop having two spaces.** The ring, the thumb and the movement zone now all mount into
		 * `getStickScreenGui()`, a `ScreenGui` at `CoreUISafeInsets` — the region a touch is reported in — so a touch
		 * position, the ring's `Position` and the pad's `AbsolutePosition` are the same kind of number, and
		 * `InputObject.Position` is used **untouched** in the four places that need it: the two grab tests, the
		 * base's placement, and the reading measured from that placement.
		 *
		 * **What would bring the conversion back is a `ScreenInsets.None` GUI.** If any of those three objects is
		 * ever moved back into `getScreenSpaceGui()`, every touch it is compared against needs the inset added — and
		 * the honest reading of that sentence is that it should not be moved back. The two input APIs are the other
		 * half of this and they really are in different spaces: `UserInputService:GetMouseLocation()` is documented
		 * as screen-relative, which is why the aim sight belongs in the screen-space GUI and a touch does not.
		 */

		/**
		 * **The touch this stick is following, by the `InputObject` itself.**
		 *
		 * Identity rather than position is what makes multi-touch safe: a second finger on the cluster's buttons
		 * sends its own `TouchMoved` events to the same connection, and following the wrong finger would walk the
		 * character towards wherever the player is holding a throw button. **The assumption in it, stated because
		 * it is the one thing here that cannot be read out of the typings**: the engine hands the *same*
		 * `InputObject` to `TouchStarted`, every `TouchMoved` and the `TouchEnded` of one touch. If it does not,
		 * the symptom is a stick that grabs and never moves — visible in one Studio session, and the fix is to
		 * match on the position instead.
		 *
		 * **Declared up here with the base rather than beside the handlers below**, where the rest of the touch
		 * state lives, for one reason: {@link applyGeometry} asks whether a touch is live before it moves the base
		 * home, and a `const` in this file is in scope only after its own line — a rotation on the first frame would
		 * be a `nil` read.
		 */
		let touch: InputObject | undefined;

		/**
		 * **The geometry, recomputed on the two occasions it changes: the mount and a new viewport.**
		 *
		 * The diameter is a fraction of the **smaller axis of the viewport**, which `UDim2.fromScale` cannot
		 * express — a scale size is per-axis, and a ring that used it would be an ellipse on anything that is not
		 * square. The *position* below is in scale for the opposite reason: the engine re-lays out a scale
		 * position by itself on a rotation, so the only thing that has to be written when the screen changes is
		 * the size.
		 *
		 * **Read from `Camera.ViewportSize` and not from the frame's own `AbsoluteSize`**, deliberately: the
		 * viewport is the value whose change is the signal being reacted to, so the two cannot disagree, where a
		 * frame's `AbsoluteSize` is a product of the layout pass and reads as the *old* size in the frame a write
		 * lands — the round trip `SprintController.scaleStickFrame` documents with a `task.wait()` in it.
		 */
		const applyGeometry = (): void => {
			// **The insets are refreshed first, before either early return can skip them.** They do not depend on the
			// camera at all, and a rotation is the one event that moves a cutout — so this is the function whose
			// *every* path should leave them current. See {@link readInsets} for the guard and for the fallback.
			readInsets();

			const viewport = Workspace.CurrentCamera?.ViewportSize;
			if (viewport === undefined) return;

			const shortAxis = math.min(viewport.X, viewport.Y);

			// **A viewport has to be a screen, and `(1, 1)` is not one.** The first live session of this line
			// printed `[Joystick] ring sized — 0px from a 1px short axis (1 x 1)`: the camera existed but had not
			// been given its size yet, so the one sizing that ran produced a **0.3px ring**, and that made two
			// things wrong at once. The line reported `0px` as though it were the answer, and the latch behind it
			// (see {@link sized}) swallowed the real sizing a moment later — so the one number a reader wants
			// never printed. **This guard is the fix for both**, and the cost of it is a frame or two of a ring
			// that is not sized yet: below this the viewport is a camera waiting to be sized rather than a small
			// screen, nothing is written, and the same `ViewportSize` signal that would have corrected it brings
			// the real value. `0.3px` is also not a harmless intermediate: every reading is a division by the
			// radius, so a sub-pixel ring is a control whose white state means nothing.
			if (shortAxis < MIN_VIEWPORT_AXIS) return;

			const diameter = shortAxis * STICK_DIAMETER_SCALE;
			radius = diameter / 2;

			ring.Size = UDim2.fromOffset(diameter, diameter);
			thumb.Size = UDim2.fromOffset(diameter * THUMB_RADIUS_RATIO, diameter * THUMB_RADIUS_RATIO);

			// **The one line that says the ring has its size, and it exists because the mount's own line cannot.**
			// At the mount there is usually no camera yet, so this function returns without a number and the ring is
			// left at `0 × 0` until the camera arrives — which is one frame of nothing on most clients and every
			// frame of nothing on a client that never got this far. Printing *here* rather than at the mount is what
			// makes "the ring is ready" a fact in a log rather than an inference from a size that reads as `0` — and
			// **a size is all the mount can be asked about now that the ring is not drawn until a finger is on it**:
			// "was it drawn" is the grab line's question, not this one's. Once
			// only, because a rotation re-derives the same number and would otherwise print on every layout pass.
			if (DEBUG && !sized) {
				sized = true;

				print(
					`[Joystick] ring sized — ${string.format("%.0f", diameter)}px from a ${
						string.format("%.0f", shortAxis)
					}px short axis (${string.format("%.0f", viewport.X)} x ${string.format("%.0f", viewport.Y)})`,
				);

				// **And the inset, which is the pair of numbers to read first when the *home* looks wrong.** It is not a
				// conversion for touches — a touch arrives in this region's space and the ring is drawn in a GUI aligned
				// to it, so nothing is converted anywhere in this file (see the class doc) — it is the region the home is
				// a fraction of, and the area the movement zone is a fraction of.
				//
				// **It prints here, with the size, rather than at the mount, and a live session is what says why:
				// `GetGuiInset()` answers `0, 0` at the mount.** The client has not been given its insets yet at that
				// point, so the mount's own copy of this line read `the GUI inset is 0, 0 … (1 x 1 usable)` — the
				// shape of "no inset at all" — while the first grab in the same session showed a real **58-pixel**
				// one. **A diagnostic that lies once per session is worse than no diagnostic**, and this is the moment
				// the numbers are both fresh (read at the top of this function) and meaningful (the ring has just been
				// given the size those fractions are of).
				print(
					`[Joystick] inset — ${string.format("%.0f", insetNear.X)}, ` +
						`${string.format("%.0f", insetNear.Y)} in from the top-left and ` +
						`${string.format("%.0f", insetFar.X)}, ${string.format("%.0f", insetFar.Y)} in from the ` +
						`bottom-right, in a ${string.format("%.0f", viewport.X)} x ${string.format("%.0f", viewport.Y)} ` +
						`viewport; the ring and the movement zone are drawn in a GUI aligned to that region, so this is the ` +
						`region the home is a fraction of — and a touch needs no arithmetic to match it`,
				);
			}

			// **And the base's home, which is the corner this ring used to be pinned to.** The derivation is the one
			// the very first cut wrote as a scale `Position` with an `AnchorPoint` of `(0, 1)`, read back as a
			// *centre*: the inset of each axis plus the hand's nudge on the left and bottom, then half a ring inwards
			// from each edge because a centre is what {@link placeBase} takes. A screen's Y grows downwards, so the
			// bottom edge is `1` minus the inset and the centre is a radius *above* it.
			//
			// **Measured inside the *usable* region rather than inside the screen, which is the second thing this
			// pass takes from `GetGuiInset()`.** Its two return values are the region's two corners, so the home is a
			// fraction of what is left between them. On a phone with no cutout that is the same number to within a
			// pixel — the topbar inset only moves the 3% fraction, and the home is anchored to the bottom — but on a
			// device with a notch or a home indicator it is the difference between a stick in the corner and a stick
			// lying under the dead strip at the edge of the screen.
			//
			// **The *size* above deliberately still comes from the screen** (see {@link STICK_DIAMETER_SCALE}): a size
			// is what a hand judges the control by, and shrinking it because somebody's phone has a notch in the
			// corner would be answering a question nobody asked. **And the insets were re-read at the top of this
			// function**, which is where the mount and every rotation leave them current.
			const usableX = viewport.X - insetNear.X - insetFar.X;
			const usableY = viewport.Y - insetNear.Y - insetFar.Y;

			// **And the inset is deliberately *not* added back, which is the arithmetic this pass deletes.** The ring
			// is drawn in `getStickScreenGui()`, whose origin already *is* the usable region's corner — so in the
			// coordinates this number is written in, the region starts at `(0, 0)` and fills the GUI. Adding
			// `insetNear` here would put the home one inset down and to the right of the corner it is a fraction
			// *of*, which is the same mistake as the old touch conversion made, approached from the other side. The
			// insets stay in this function because the usable *size* is what the fractions are of, and that size is
			// genuinely the viewport's minus both insets.
			homeX = usableX * STICK_EDGE_INSET_SCALE + STICK_NUDGE.X + radius;
			homeY = usableY * (1 - STICK_EDGE_INSET_SCALE) + STICK_NUDGE.Y - radius;

			// **Home only when no finger is down.** A rotation mid-push is the one case where these two disagree:
			// the size has changed and the base is under a thumb that has not moved, and yanking it to the corner
			// would change the reading under a player who is doing nothing but turning their phone. Leaving it where
			// the finger put it keeps the push continuous, and the *new* home is where the next release sends it.
			// **This write is invisible now** — the ring is not drawn while no finger is down, so a rotation on an
			// idle screen moves a circle nobody can see — **and it is kept because the home is the centre that
			// `onRing` measures a corner touch against**, which is the one grab test that works in a frame where the
			// pad has not been laid out yet. See `placeBase` and `release`.
			if (touch === undefined) placeBase(homeX, homeY);
		};

		applyGeometry();

		// **The one place the geometry is re-derived, and the read is cheap because it is a signal and not a
		// frame.** A rotation and a window being dragged are the two ways this changes, and both fire it —
		// `ui/screenGui.ts` and `MobileControlsController` watch this same property for the same class of reason.
		const camera = Workspace.CurrentCamera;
		if (camera !== undefined) {
			camera.GetPropertyChangedSignal("ViewportSize").Connect(() => applyGeometry());
		}

		// **And the same re-derivation for the camera itself, which is the one way this ring can be invisible
		// rather than merely misplaced.** `applyGeometry` has nothing to measure without a camera, so a mount that
		// happens first leaves a ring at `0 × 0`: parented, drawn, holding no pixels, and reported by nothing —
		// every diagnostic in this file prints a *size*, and `0` reads as an honest answer. A client that ignites
		// before its camera exists is not hypothetical (the HUD's own scale falls back to a reference viewport for
		// exactly that reason), and one subscription is a better answer than a fallback number: the camera arriving
		// is the event that makes the geometry knowable.
		Workspace.GetPropertyChangedSignal("CurrentCamera").Connect(() => applyGeometry());

		/** The thumb's offset from the ring's centre, in pixels, clamped to the radius. Also the reading's length. */
		let pushX = 0;
		let pushY = 0;

		/** The push's direction as a unit vector, kept so the reading and the drawing share one set of numbers. */
		let unitX = 0;
		let unitY = 0;

		/** The reading: the push as a fraction of the radius, deadzoned. **This is the number `Move` is called with.** */
		let reading = 0;

		/**
		 * **The largest reading of the current grab.** Not the live one, and not a diagnostic for this file's
		 * sake: the sprint's thresholds (`0.9`/`0.8`) were placed against the *engine's* stick, and the number
		 * that decides whether they are still right on this one is the **peak a deliberate push reaches** — which
		 * is exactly what this is. It is printed on release, so one session of play answers the question the
		 * thresholds are waiting on, and it is bounded by how often a person lets go of a stick rather than by a
		 * frame count. See `SprintController`'s `SPRINT_START_MAGNITUDE` for the pair and its provenance.
		 */
		let peak = 0;

		/** Puts the thumb back at the ring's centre. The reading is set by {@link release}. */
		const centreThumb = (): void => {
			pushX = 0;
			pushY = 0;
			unitX = 0;
			unitY = 0;
			thumb.Position = new UDim2(0.5, 0, 0.5, 0);
		};

		/**
		 * **The two paints, and the latch that keeps them off the per-frame path.**
		 *
		 * See {@link RING_MAX_LINE} for what the white means and why the line is the rim. **The latch is the
		 * reason this is a function rather than two branches at the call site**: `TouchMoved` fires as often as the
		 * finger moves, which on a phone is a per-frame event, so an unguarded write here would set four properties
		 * and print a line sixty times a second in the middle of a push. `bright` is seeded `false` because the ring
		 * is *built* dark (the same `trough` and `RING_FILL_TRANSPARENCY` this writes), so the drawing and the state
		 * cannot disagree at the mount.
		 *
		 * **The print is evidence rather than commentary, and the session that proved it is worth quoting.** The
		 * first log with these lines in it read `[Joystick] grabbed at 20, 245 — ring 114px`, then
		 * `[Joystick] the ring went white — the thumb is at the rim` and `[Joystick] the ring went dark` on the way
		 * back — so the ring is drawn, the grab test accepts a touch inside it, and the two paints fire on the edges.
		 * It pairs with the sprint's own lines (`[Sprint] pressed — stick 1.00 (over start)`, then
		 * `[Walk] prospeed1: 35 (Base:20 Sprint:15)`), and that pair is how the one disagreement worth knowing about
		 * was found: **the white says the *thumb* is at the rim, while the sprint's reading is the body's
		 * last-written `Move` — a number a second writer can move.** See the mount's mode line.
		 */
		let bright = false;
		const setMaxLook = (on: boolean): void => {
			if (on === bright) return;

			bright = on;
			// **White, not `onAccent`.** The lit state used to be written from the theme's `onAccent` — which is
			// white on the light palette and is the palette's *plum* on this one, so the ring's "the thumb is at the
			// rim" signal would have been the same colour as the ring itself. The two states are the palette's white
			// and its plum, which is the pair every other surface in this direction is drawn with.
			ring.BackgroundColor3 = on ? PREMIUM.text : theme.colors.trough;
			ring.BackgroundTransparency = on ? RING_MAX_FILL_TRANSPARENCY : RING_FILL_TRANSPARENCY;
			rim.Color = on ? PREMIUM.text : theme.colors.accent;
			rim.Transparency = on ? RING_MAX_RIM_TRANSPARENCY : RING_RIM_TRANSPARENCY;

			if (DEBUG) print(`[Joystick] the ring went ${on ? "white — the thumb is at the rim" : "dark"}`);
		};

		/**
		 * **A touch's offset from the base's centre, and how far out it is — one set of numbers for both the
		 * drawing and the reading.**
		 *
		 * Everything in it is in the stick GUI's own coordinates: the centre is the point {@link placeBase} was last
		 * given, and a touch arrives in exactly those coordinates — the class doc says why, and its short version is
		 * that this is the whole reason the ring has a `ScreenGui` of its own. **Nothing here is converted, and
		 * nothing at a call site is either**, which is what makes the reading and the drawing agree by construction
		 * rather than by two pieces of arithmetic that happen to match.
		 *
		 * **This function is the one that says what a push *is*.** A wrong belief about the space reads as a *drift*
		 * rather than as a fault — the base was still placed on every touch and the reading still went white at the
		 * rim, so it looked like a control that wanted tuning rather than one measuring from the wrong corner. That is
		 * how four passes went by; see the class doc for the two answers that ended it.
		 *
		 * **The centre comes from this file's own state rather than from `ring.AbsolutePosition`**, which is what it
		 * used to read, and the reason is the layout pass: an absolute read can answer with the position a frame
		 * *behind* the write — a subtle wrongness while the base only ever moved with a resize, and a real one now
		 * that the base is moved on every grab. A centre we wrote is a centre we know.
		 */
		const reachOf = (position: Vector3): { x: number; y: number; distance: number } => {
			const x = position.X - centreX;
			const y = position.Y - centreY;

			return { x, y, distance: math.sqrt(x * x + y * y) };
		};

		/**
		 * **Whether a touch began inside the movement zone — the question the dynamic pass added, and the one the
		 * pad exists to answer.**
		 *
		 * The rectangle is read back off the pad rather than derived from the viewport a second time, so the test
		 * and the thing that sinks the touch can never disagree: `AbsolutePosition` and `AbsoluteSize` are screen
		 * measurements whatever the owning GUI's insets do, and the pad's `Size` is pure scale, so the engine's own
		 * re-layout on a rotation keeps this correct with nothing written here. **Read at the touch and not cached**,
		 * for the reason given above `placeBase`: a layout-pass product read in the frame it was written is stale,
		 * and a touch arrives long after any write.
		 *
		 * **And the point it takes is the raw touch, because the pad is in the same GUI as the ring** — an inset one,
		 * whose `AbsolutePosition` is measured from the inset region's corner, which is the corner a touch is reported
		 * from. **The test that is right here is the one where nothing moves**: an earlier version shifted the touch
		 * and compared it against this rectangle, and it was wrong by a whole inset in the direction that still usually
		 * answered "inside" — against a zone this tall, a touch anywhere in the region passed either way, so the zone
		 * test was quietly forgiving and quietly wrong at the same time.
		 */
		const grabZone = (padPoint: Vector3): boolean => {
			const origin = pad.AbsolutePosition;
			const size = pad.AbsoluteSize;

			return (
				padPoint.X >= origin.X &&
				padPoint.X <= origin.X + size.X &&
				padPoint.Y >= origin.Y &&
				padPoint.Y <= origin.Y + size.Y
			);
		};

		/**
		 * **Follows the finger: the thumb's place, the direction, and the reading.**
		 *
		 * Takes a touch position rather than the `InputObject` itself — the type is the reminder that nothing in here
		 * ever needed the object, and the reading, the direction and the thumb's place are all differences from the
		 * base's centre, so they are right in whatever space the touch and the centre agree in. **They agree in the
		 * stick GUI's**, which is why every call site hands this `input.Position` untouched: a touch arriving in some
		 * other space is not a bug to fix at a call site, it is the whole point of which `ScreenGui` the ring lives
		 * in. See the class doc.
		 */
		const track = (point: Vector3): void => {
			const reach = reachOf(point);

			// **The thumb is drawn where the finger is, with no clamp at all — and this is the reversal of what stood
			// here, kept because the argument for the clamp is the obvious one and would be made again.** It read:
			// *"**The clamp is on the offset, so the thumb and the reading cannot disagree.** A finger past the rim
			// keeps the direction it went out at and sits on the rim, which is what every stick on every platform
			// does."* **That is true of a console stick and wrong for this control, and the session that settled it
			// never left the rim**: every push in it read `1.00` within 300ms and stayed there, so the drawn thumb sat
			// pinned on the rim for the whole of every push while the player's own thumb was further out —
			// *"the thumb is not at the exact place as my thumb"*, in their words. **The paragraph at the bottom of
			// this function had already promised the opposite** (*"the thumb follows the finger exactly … the reading
			// is the one that has an opinion; the drawing does not"*) while the code multiplied by this clamp, so the
			// two are back in agreement rather than newly changed.
			//
			// **What is deliberately *not* unclamped is the reading below**: `raw` is still a division by the radius
			// and still stops at `1`, which is what keeps the movement finite, keeps the rim meaning "full throttle",
			// and keeps the white paint where it is. So a finger past the rim now draws its thumb *outside* the circle
			// and moves the body at exactly the speed it did before — **the circle stops being a cage and becomes a
			// scale**, which is the thing the white state was already saying in colour.
			pushX = reach.x;
			pushY = reach.y;

			// A touch exactly on the centre has no direction to report, and `0/0` is a `nan` that would reach
			// `Humanoid:Move` — so the unit vector is left at the last one and multiplied by a reading of `0`.
			const normalised = reach.distance > 0 ? 1 / reach.distance : 0;
			unitX = reach.x * normalised;
			unitY = reach.y * normalised;

			// **The reading: the push as a fraction of the radius, then the deadzone as a floor rather than a
			// scale.** A scale — subtracting the deadzone and dividing by what is left — would put "fully pushed"
			// at the rim either way and only change the numbers in between; a floor says "below this, the player is
			// not asking for anything", which is the honest reading of a thumb resting on the stick.
			const raw = math.clamp(reach.distance / radius, 0, 1);
			reading = raw < DEADZONE ? 0 : raw;

			peak = math.max(peak, reading);

			// **The white, decided by the same reading that drives the body**, so there is no second copy of "how far
			// is this pushed" and nothing to keep in step. Written here rather than in the render step below: that
			// loop runs per frame and this is a fact about the finger, which is what this handler exists to report.
			// See {@link RING_MAX_LINE} — and note that a thumb resting *exactly* on the rim can flicker between the
			// two paints, which is a property of any level test at a boundary and is what the player's own hand
			// settles by pushing past it.
			setMaxLook(reading >= RING_MAX_LINE);

			// The thumb follows the finger *exactly*, deadzone and all, because the thumb is where the finger is
			// rather than a readout of what the game is doing about it. The reading above is the one that has an
			// opinion; the drawing does not. **That sentence is now what the code does** — see the note at the top of
			// this function for the clamp that used to contradict it — and **the ring does not clip its children**
			// (`ClipsDescendants` is left at its default `false`), which is what lets a thumb past the rim be drawn
			// outside the circle rather than vanishing at its edge.
			thumb.Position = new UDim2(0.5, pushX, 0.5, pushY);
		};

		/** The local player's live humanoid, or nothing while there is no body to move. */
		let humanoid = humanoidOf(player.Character);

		/**
		 * **Stops driving the body, takes the stick off the screen, returns the thumb, and reports the grab.**
		 *
		 * The zero write is here rather than left to the render step below, and it is the one write in this file
		 * that is not a repeat of the last one: with no touch tracked the render step writes nothing at all, so
		 * without this line a release would leave the last direction in force until something else moved the
		 * character. It is also a *single* write rather than a per-frame zero — see the render step's own argument
		 * for why a zero call is the one thing that must not repeat.
		 */
		const release = (): void => {
			// **Nothing held, nothing to release** — and the guard is load-bearing rather than tidy: the focus
			// signal below fires whether or not this stick is being held, and without this line an unrelated
			// focus change would write one frame of zero movement on a client where nothing else is writing.
			if (touch === undefined) return;

			touch = undefined;
			centreThumb();
			reading = 0;

			// **And the base goes back to the corner**, which is the other half of the dynamic deal: the base is
			// under the thumb for the length of a push and in one known place the rest of the time. Left where the
			// thumb ended it would be a control that wandered — and, because a grab takes the base to the finger
			// rather than the finger to the base, one whose next corner touch would be measured against a circle in
			// the wrong place. **The corner itself is not drawn any more** — the ring is hidden on the line below —
			// so the write's justification is the grab test rather than the picture. See `placeBase`.
			placeBase(homeX, homeY);

			// **And the stick comes off the screen in the same frame the finger left it**, which is the other half
			// of what the user asked for: *"I want my joystick to 'disappear' when not actively being used"*. The
			// thumb goes with it, being a child of the ring, so one `Visible` covers both. It belongs beside the
			// base's return rather than in the render step: that step writes nothing at all while no touch is
			// tracked, and this is the function that knows the gesture ended.
			ring.Visible = false;

			// **And the ring goes back to dark with the thumb**, which is the same paint the mount wrote — so a
			// release can never leave a white ring behind on a hand that is no longer on the stick. The latch inside
			// makes this free when the state was already dark, which is every release but the ones from a full push.
			setMaxLook(false);

			if (DEBUG) {
				print(
					`[Joystick] released — the push peaked at ${string.format("%.2f", peak)} this grab; the base is ` +
						`back at ${string.format("%.0f", homeX)}, ${string.format("%.0f", homeY)}; the ring is off the ` +
						`screen again`,
				);
			}

			peak = 0;

			if (humanoid === undefined) humanoid = humanoidOf(player.Character);
			humanoid?.Move(Vector3.zero, true);
		};

		/**
		 * **The movement writer: one call per frame while a finger is down, and nothing at all when none is.**
		 *
		 * `BindToRenderStep` at `Enum.RenderPriority.Character` (300), which is `AlternativeMovementController`'s
		 * slot and its argument: the default control scripts write the character's movement at priorities 100 and
		 * 200, `Heartbeat` runs after the physics step (so a call there is a frame late and overwritten), and 300
		 * is the rung the enum reserves for character-response work. With `Scriptable` set there is a second reason
		 * for the same slot and it is the better one: the camera script still updates at 200, and
		 * `relativeToCamera` below is resolved against *this* frame's camera rather than last frame's.
		 *
		 * **The per-frame write is deliberate, and `Humanoid:Move` would hold its direction on its own.** A single
		 * call would be enough while nothing else writes, but the body's movement is cleared by things this file
		 * cannot see — a state change, a dodge's `PlatformStand`, a caught ball — and a stick that went dead until
		 * the player lifted a finger and put it back would be a fault nobody could describe. Writing every frame
		 * makes the stick the authority for exactly as long as it is being held. **The cost of that is the one
		 * `AlternativeMovementController` records**: a zero-vector call cancels whatever the default controls
		 * asked for that frame, so this must never write while no finger is down — which is why the first line
		 * below is a `return` and why the release above is a single write rather than a loop.
		 */
		RunService.BindToRenderStep(RENDER_BINDING_NAME, MOVE_PRIORITY, () => {
			if (touch === undefined) return;

			// The re-resolve on a frame with no body, for the race both sibling controllers record at length:
			// `CharacterAdded` hands over the model before its children have replicated, so a miss in the handler
			// is permanent — the event does not fire again for the same character.
			if (humanoid === undefined) humanoid = humanoidOf(player.Character);
			if (humanoid === undefined) return;

			// **Screen space to camera space, and the two signs are the whole of it.** A screen's Y grows
			// *downwards* and camera-forward is `-Z`, so a finger pushed away from the player (up the screen, a
			// negative Y here) is a negative Z — no flip. **`AlternativeMovementController` writes the mirror of
			// this line with a flip in it**, and both are right: its vector comes from an `InputAction`, whose Y
			// is *up*-positive, where this one comes from a touch position, whose Y is *down*-positive.
			//
			// A reading of `0` is written rather than skipped, and that is a decision: a finger down but inside
			// the deadzone is the player saying *stop*, so the stick says stop. Writing nothing would leave the
			// body walking from the last frame that had a direction.
			humanoid.Move(new Vector3(unitX * reading, 0, unitY * reading), true);
		});

		// **The humanoid is re-resolved per body; the connections are not.** One subscription serves every
		// character, and `CharacterRemoving` clears the reference because a destroyed humanoid is not something to
		// call a method on. **The touch is deliberately not cancelled here**: a touch ends when its own
		// `TouchEnded` arrives, so cutting it here would be this file inventing an ending for a gesture the player
		// is still making — and a finger still on the ring when the next body loads is a player asking to walk.
		player.CharacterAdded.Connect((character) => {
			humanoid = humanoidOf(character);
		});

		player.CharacterRemoving.Connect(() => {
			humanoid = undefined;
		});

		// **The release that never arrives, on the rule three other input controllers in this project follow.**
		// A touch that ends while the window is elsewhere is not delivered here, and a stick stuck at its last
		// reading is a character that walks until the player touches the screen again. `SprintController` clears
		// its held keys on this signal for the same reason.
		UserInputService.WindowFocusReleased.Connect(() => release());

		// **The grab.** One touch at a time, and it has to begin inside one of the two places a thumb is allowed to
		// start a push: a stick that grabbed whichever finger moved first would be a stick the player could not avoid
		// touching.
		UserInputService.TouchStarted.Connect((input) => {
			if (touch !== undefined) return;

			// **And `radius <= 0` is a refusal rather than an edge to reason about.** It means the geometry has
			// never run — a client with no camera — and every reading below is a division by that number: a
			// `0/0` there is a `nan`, and a `nan` handed to `Humanoid:Move` is a body that does nothing at all
			// with no error anywhere. It comes first for the same reason: the zone below would otherwise answer
			// about a pad nobody has sized.
			if (radius <= 0) return;
			// **The ring's own circle, which is the original grab and is still a *circle* rather than the button's
			// rectangle.** A `GuiObject`'s bounds are a rectangle, and the corners of this one's are outside the
			// ring the player can see — so a corner touch neither grabs the stick nor counts as one. (It still
			// sinks, being a `GuiButton`: the corners are a few pixels of screen the camera cannot use. That is the
			// price of the sink, and it is the cheaper side of it.)
			//
			// **And the zone, which is what makes the stick dynamic** — the touch never has to come near the ring
			// at all, because the base is about to be *placed under it*. **Both are checked rather than only the
			// zone**, and that still matters for a reason the space does not touch: the pad's rectangle is a
			// layout-pass product, so a frame in which it has not been laid out yet reads as `0 x 0` and would
			// refuse *every* touch, while the ring's own circle keeps the stick usable in that frame.
			//
			// **The touch is used exactly as it arrives, and there is no conversion anywhere below** — see the
			// class doc: the ring, the thumb and the pad all live in the one GUI whose insets are the region a
			// touch is reported from, so a touch position and a ring position are the same kind of number.
			const onRing = reachOf(input.Position).distance <= radius;
			const inZone = grabZone(input.Position);
			if (!onRing && !inZone) return;

			touch = input;
			peak = 0;

			// **And the ring goes up here, at the finger** — this write and the release's own are the whole of the
			// disappearing stick. It is written *before* `placeBase` so that the first frame the ring can be seen in
			// is one at the thumb rather than one still down in the corner. Note what it does *not* affect: the grab
			// tests above are this file's own arithmetic, not the engine's hit-test, so a hidden ring was still the
			// circle a corner touch was measured against.
			ring.Visible = true;

			// **The base moves to the finger before anything is read from it**, and the order is the whole of the
			// dynamic behaviour: `reachOf` measures from this new centre, so the first `track` below reports a push
			// of exactly `0` — the player's travel starts from wherever their thumb already was, which is the one
			// promise a stick that appears under the finger has to keep.
			placeBase(input.Position.X, input.Position.Y);
			track(input.Position);

			if (DEBUG) {
				// **And the second opinion on where the pointer is, which is a cross-check on the coordinate story
				// itself rather than a fix for it.** `UserInputService:GetMouseLocation()` is documented as *"the
				// current screen location of the player's Mouse… relative to the top-left corner of the screen"* —
				// the *screen's* corner, while a touch is reported from the inset region's — so the two are
				// **expected to differ by exactly `GetGuiInset()` here, and printing both is how that stops being a
				// belief**: agreement means this device's inset is zero, so the two spaces cannot be told apart at
				// all; a gap of about the inset means the ring's GUI is the right home for a touch; and any other
				// size means neither story is right.
				const pointer = UserInputService.GetMouseLocation();
				const dx = input.Position.X - pointer.X;
				const dy = input.Position.Y - pointer.Y;
				const agreement =
					math.abs(dx) < 0.5 && math.abs(dy) < 0.5
						? "GetMouseLocation agrees with it, so this device's inset is zero"
						: `GetMouseLocation is ${string.format("%.0f", dx)}, ${string.format("%.0f", dy)} away (the inset should be about that)`;
				print(
					`[Joystick] grabbed at ${string.format("%.0f", input.Position.X)}, ` +
						`${string.format("%.0f", input.Position.Y)} — ring ${string.format("%.0f", radius * 2)}px, ` +
						`base placed there and the ring is up (the touch began ${
							inZone ? "in the movement zone" : "on the ring"
						}); ` +
						agreement,
				);
			}
		});

		// **The follow, and the identity test is what keeps a second finger out of it.** `TouchMoved` fires for
		// every finger on the screen, so the cluster's buttons and the engine's own controls send events here too.
		UserInputService.TouchMoved.Connect((input) => {
			if (input !== touch) return;

			// No conversion, and none to make: the touch arrives in the same space the ring and its base are drawn
			// in, because that is now the whole point of the GUI the ring lives in. See the class doc.
			track(input.Position);
		});

		// **The release, taken however it arrives.** A finger that slides off the screen still ends the touch it
		// began, and `TouchEnded` is where that is announced for the touch this stick is holding.
		UserInputService.TouchEnded.Connect((input) => {
			if (input !== touch) return;

			release();
		});

		// **Whether the switch did what it says, asked once and reported rather than assumed.** Two questions are
		// open on a client nobody has run this on: whether `Scriptable` leaves the engine's movement frame drawn
		// (this file cannot hide it — see the report), and whether the engine's jump button survives — which
		// matters more than it looks like, because `MobileControlsController` draws its whole cluster only once
		// that button has been found, so a jump button that went away with the movement mode would take the five
		// battle buttons with it. One line, after the GUI exists, naming the children of the engine's own control
		// frame and the button's presence: that is the reading the next session starts from.
		if (DEBUG) {
			task.spawn(() => {
				const touchGui = playerGui.WaitForChild("TouchGui", TOUCH_GUI_WAIT_SECONDS);

				if (touchGui === undefined) {
					print(
						`[Joystick] no TouchGui after ${TOUCH_GUI_WAIT_SECONDS}s — either this client has no ` +
							`engine touch controls or the switch took them away`,
					);

					return;
				}

				const control = touchGui.FindFirstChild("TouchControlFrame");
				const names =
					control === undefined
						? "no TouchControlFrame"
						: `${control.GetChildren().size()} child(ren): ${control
								.GetChildren()
								.map((child) => child.Name)
								.join(", ")}`;
				const jump = touchGui.FindFirstChild("JumpButton", true);

				// **The class test before the visibility read, and it is not ceremony.** `FindFirstChild` answers
				// with whatever class wears that name, so the test is what stops a decoy from making this line
				// read as "the button is there" — and `Visible` only exists on a `GuiObject`, so the compiler
				// refuses the read without it. The question this probe asks is exactly that pair: is the thing
				// there, and is it a control.
				const jumpLine =
					jump === undefined || !jump.IsA("GuiObject")
						? "no JumpButton"
						: `JumpButton ${jump.Visible ? "visible" : "HIDDEN"}`;

				print(`[Joystick] engine touch GUI — ${names}; ${jumpLine}`);
			});
		}

		if (DEBUG) {
			// **The size, or the honest absence of one.** This line runs at the mount, and on a normal client the
			// mount happens *before* `Workspace.CurrentCamera` exists — so `applyGeometry` has nothing to measure and
			// leaves the radius at `0`, which the first version of this print reported as `ring 0px`: a number that
			// reads as a broken control rather than as the order two things happen in. **The line that reports the
			// size is inside `applyGeometry`** (`[Joystick] ring sized — …`), because that is where the number is
			// known; this one says which of the two cases the mount was in and nothing more.
			const size =
				radius > 0
					? `ring ${string.format("%.0f", radius * 2)}px`
					: "ring not sized yet — no camera at the mount, so it is derived when one arrives";

			print(
				`[Joystick] up — ${size} at ${formatPercent(STICK_DIAMETER_SCALE)} of the short axis, thumb ratio ` +
					`${formatPercent(THUMB_RADIUS_RATIO)}, deadzone ${formatPercent(DEADZONE)}, inset ` +
					`${formatPercent(STICK_EDGE_INSET_SCALE)} of each axis nudged ` +
					`(${string.format("%.0f", STICK_NUDGE.X)}, ${string.format("%.0f", STICK_NUDGE.Y)})px; ` +
					`dynamic — the base is placed under the touch, and any touch in the lower ` +
					`${formatPercent(MOVEMENT_ZONE_HEIGHT_SCALE)} × left ${formatPercent(MOVEMENT_ZONE_WIDTH_SCALE)} ` +
					`of the screen counts as a push (zone empty means no pad); bound to the render step at ` +
					`${MOVE_PRIORITY}`,
			);
		}
	}

	/**
	 * **Hides the engine's own movement stick — its drawing, not its input — in every mode the engine can draw one.**
	 *
	 * See {@link ENGINE_STICK_SCALE} for the tool (`UIScale`, which the module cannot revert) and why a `Size` write
	 * is not it. **What this is for is the corner.** The engine draws its stick where a player expects a stick, and
	 * so does this file, so with both visible a player sees two circles in one place and no way to tell which one
	 * their thumb is on. Hiding the engine's leaves **one stick on screen and two input paths over the same pixels**,
	 * which is the harmless version of that overlap — a touch that lands on the engine's region and not on the ring
	 * still walks the character, and the ring is the only thing either of them is told about.
	 *
	 * **Every mode, now, and the trade is stated rather than argued away.** A *dynamic* frame follows the finger, so a
	 * hidden one is a control the player cannot see that still moves them *anywhere* on the lower screen — worse than
	 * showing it, and that is why this ran in the fixed mode alone. **What reversed it is the mode being the
	 * player's**: `main.server.ts` sets none, so both frames are reachable on the same build, and a rule that hides
	 * one and not the other produces exactly the state a session hit — the engine's classic circle *and* the ring, in
	 * the same corner, with the hide silently doing nothing because the frame's name was not in the list. Hiding both
	 * leaves one stick *visible*, which is the property the ring exists for. `Scriptable` needs nothing here: the
	 * engine draws no controls at all in that mode, **including the jump button**, which is why the mode is not wanted
	 * either.
	 *
	 * **Bounded and reported, on the pattern `MobileControlsController` uses for the same GUI.** The engine builds
	 * `TouchGui` during boot — one of this project's logs puts it about a second and a half after the client ignites —
	 * so the wait is the price of not missing it, and **every silent ending here prints**, because "nothing was
	 * hidden" and "the hiding never ran" look identical to a reader otherwise. Spawned from the mount so that nothing
	 * about the ring waits on somebody else's GUI.
	 */
	private hideEngineStick(playerGui: PlayerGui): void {
		const touchGui = playerGui.WaitForChild("TouchGui", TOUCH_GUI_WAIT_SECONDS);

		if (touchGui === undefined) {
			if (DEBUG) {
				print(
					`[Joystick] no TouchGui after ${TOUCH_GUI_WAIT_SECONDS}s — there is no engine stick to hide on ` +
						"this client (which is what a `Scriptable` one looks like), so the ring is the only stick " +
						"on screen",
				);
			}

			return;
		}

		const control = touchGui.FindFirstChild("TouchControlFrame");
		if (control === undefined) {
			if (DEBUG) print("[Joystick] the engine's TouchGui holds no TouchControlFrame — nothing to hide");

			return;
		}

		// **By name from the mode list, and class-checked**, exactly as `MobileControlsController` finds the jump
		// button: `FindFirstChild` answers with whatever class wears the name, so the class test is what stops a
		// decoy from making this read as "the engine moved its stick".
		for (const name of ENGINE_STICK_FRAME_NAMES) {
			const frame = control.FindFirstChild(name);
			if (frame === undefined || !frame.IsA("GuiObject")) continue;

			// **Two mechanisms, because they fail differently, and the first session with them both says which one
			// was doing the work.**
			//
			// **`Visible = false` is the load-bearing one, and the reference says exactly why**: *"determines whether
			// the `GuiObject` **and its descendants** will be rendered"*. That is the property for "this subtree is
			// not on screen", it needs no interpretation, and it is the answer to a question a live log raised —
			// `11 instance(s) scaled in total`, i.e. **the engine's dynamic stick is a frame with ten `GuiObject`s
			// inside it**, which a `UIScale` on the frame alone may or may not carry (a `UIScale` is documented as
			// multiplying "the `AbsoluteSize` of the parent UI element", which says nothing about a child the engine
			// positioned with pixel offsets of its own). **A surviving child would be a grey circle at a fixed offset
			// from the finger — a "thumb" that no work on this file's own dot could ever move**, and four passes were
			// spent on that dot. Hiding the frame outright removes the whole question.
			//
			// **The watcher is there because the ControlModule owns this frame while a finger is down**: it fades
			// the dynamic stick in and out and may well assert `Visible` back. So every attempt to show it is
			// answered, and **the count of those answers is the evidence** — a session that logs `re-shown 3 time(s)`
			// is a session where the module really was fighting this, and one that logs none is a stick that was
			// never drawn again. The prints are capped for the reason `SprintController.STICK_REPORT_LIMIT` is: a
			// per-event line in a game loop is a log nobody can read.
			//
			// **And the scale stays, on the frame, as the thing this project already knows works** — see
			// {@link ENGINE_STICK_SCALE}, whose argument is `MobileControlsController`'s 120px button rendered at
			// 61px. It is the belt to `Visible`'s braces, one instance, and it is what keeps the engine's *layout*
			// intact while its drawing is gone.
			const scale = new Instance("UIScale");
			scale.Name = ENGINE_STICK_SCALE_NAME;
			scale.Scale = ENGINE_STICK_SCALE;
			scale.Parent = frame;

			frame.Visible = false;

			let reshown = 0;
			frame.GetPropertyChangedSignal("Visible").Connect(() => {
				if (!frame.Visible) return;

				reshown++;
				frame.Visible = false;

				if (DEBUG && reshown <= ENGINE_STICK_REPORT_LIMIT) {
					print(
						`[Joystick] the engine's stick was shown again (${reshown}) — hidden again, so the ring is ` +
							`still the only stick on screen`,
					);
				}
			});

			if (DEBUG) {
				// **The children by name, once, because this is the list that says what there was to hide** — and
				// because a stray one is the one kind of fault this file cannot see from its own side.
				const children = frame
					.GetDescendants()
					.map((child) => child.Name)
					.join(", ");

				print(
					`[Joystick] the engine's stick is hidden — ${frame.GetFullName()} at scale ` +
						`${ENGINE_STICK_SCALE} and \`Visible = false\`, ${frame.GetDescendants().size()} ` +
						`descendant(s): ${children === "" ? "none" : children}; the ring is the only stick a ` +
						`player sees, and any re-showing is answered`,
				);
			}

			return;
		}

		if (DEBUG) {
			print(
				`[Joystick] no engine stick frame under ${control.GetFullName()} — looked for ` +
					`${ENGINE_STICK_FRAME_NAMES.join(", ")}, and the ring is on screen beside whatever it drew`,
			);
		}
	}
}

/**
 * The ring's diameter as a fraction of the viewport's smaller axis. **Placeholder — 0.30, raised from 0.20 on the
 * ask that the box be larger.**
 *
 * **What `0.30` is worth, because a fraction is not a size**: **118px** of diameter on the 393-wide reference —
 * half again the 79px the first cut drew, and level with the bigger of the two sticks the engine ships (70px and
 * 120px, so that one is 0.31 of the same axis). It is still inside the corner: with the 3% inset the ring spans
 * about `x 12…130` on that phone, against the mobile cluster's box at roughly `x 145` in this project's logs — if
 * they ever do meet, the levers are {@link STICK_NUDGE} here and `BOX_NUDGE`/`BOX_EDGE_GAP` there.
 *
 * **Named for the diameter because that is what it is.** The brief for this file named the constant
 * `STICK_RADIUS_SCALE` while its own description said "ring diameter as a fraction of the viewport's smaller
 * axis", and the two cannot both be right: `0.20` of a 393px axis is a **79px** ring, which is the size the
 * reference screenshot describes, where `0.20` as a *radius* would be a 157px ring — two fifths of the screen's
 * short edge. The value is the one that was asked for, so the name follows the value. See
 * {@link THUMB_RADIUS_RATIO}, which keeps the brief's name because a ratio of radii and a ratio of diameters are
 * the same number.
 *
 * **Why the smaller axis rather than the width or the height.** The same argument `MobileControlsController`
 * makes for its box: the width alone lets a phone held sideways keep a full-size ring on a viewport half as
 * tall, and the height alone shrinks it on every wide screen. The *smaller* of the two is the one that fits, and
 * a ring is a circle, so one number has to serve both axes.
 *
 * **`0.20` of the short axis is about a quarter of it** — the proportion the reference screenshot shows, and
 * three times the engine's own stick on the larger of this project's two logged devices (120px on a 393px axis
 * is `0.31`, so this is *smaller* than that one; on the 70px device it is `0.18`, so this is four times it).
 * **The engine's size is not one number and cannot be tuned against**: its module picks 70 or 120px from a
 * `min(viewport's short axis) <= 500` test, so the same stick is a very different fraction of two phones. That
 * variance is the real argument for this file, more than either size is.
 */
const STICK_DIAMETER_SCALE = 0.35;

/**
 * **The smallest viewport this file will draw into, in pixels along its short axis: `64`. Not a Placeholder and
 * not a design number — a sanity floor.**
 *
 * The smallest short axis a Roblox client really runs at is about 320px, so 64 cannot exclude a real screen; what
 * it excludes is a **camera that exists but has not been sized**, which is the state the first live session of this
 * file caught: a `ViewportSize` of `1 × 1`, three tenths of a pixel of ring, and a log line that read
 * `ring sized — 0px` as though that were an answer. See {@link applyGeometry} for what that broke and why the guard
 * belongs there rather than in the reading.
 */
const MIN_VIEWPORT_AXIS = 64;

/**
 * The thumb's diameter as a fraction of the ring's. **Placeholder — 0.35.**
 *
 * **A ratio of radii, which is the same number as a ratio of diameters** — so the brief's name is exact and
 * needs no footnote, unlike the ring's above. Three tenths of the ring makes the thumb a dot inside a large
 * ring, which is what the reference shows: big enough to see where the finger is, small enough that the ring
 * still reads as the travel rather than as a well.
 */
const THUMB_RADIUS_RATIO = 0.35;

/**
 * The fraction of the ring's radius below which the stick says nothing at all. **Placeholder — 0.08.**
 *
 * **A floor on the reading rather than a scale on it.** Below this the reading is `0` — the stick is at rest —
 * and above it the reading is the raw fraction, unre-scaled. The alternative (subtracting the deadzone and
 * dividing by what remains) maps the rim to `1` either way and only moves the numbers in between, which is not
 * worth a second piece of arithmetic: the sprint's thresholds are placed well above this either way, and a
 * player's thumb resting on a stick is *moving* rather than hidden behind a curve.
 *
 * **Small on purpose.** Eight hundredths of a radius is about 3px on the reference phone, which is the width of
 * a fingertip's wobble rather than a control the player has to push past. A generous deadzone is a stick that
 * feels unresponsive at the start of a push, and this one is only here so that a resting thumb reads as nothing.
 */
const DEADZONE = 0.08;

/**
 * How far the ring sits from the **usable region's** left and bottom edges, as a fraction of *each* axis.
 * **Placeholder — 0.03.**
 *
 * **A fraction rather than a pixel count, and that is the one thing about this number that is not taste.** The
 * section of the screen it is measured in is the *usable region* — the whole of the GUI the ring is drawn in, which
 * excludes the topbar and any cutout — so a pixel inset would be *right* there too; the reason it is a fraction is
 * that the ring's *size* already is one (see {@link STICK_DIAMETER_SCALE}), and one unit for the whole corner is
 * what keeps the gap the same proportion of the screen as the ring is. **It is converted to pixels in
 * `applyGeometry` and not written as a scale `Position`, which is a change the dynamic pass made**: the ring's
 * place is a *point* now rather than a corner of the screen (see `placeBase`), so the fraction is what the home
 * derivation starts from rather than what the property holds.
 *
 * **And it is measured against the *usable* region rather than the whole screen, which the offset pass changed.**
 * The derivation takes `GuiService:GetGuiInset()`'s two corners and fractions what is between them, so the gap is a
 * gap from something usable — the notch and the home indicator are not screen a stick can live in, and on a phone
 * with neither the two derivations agree to within a pixel. See `applyGeometry`, which is where the two are
 * subtracted.
 *
 * **`0.03` is about 12px on the reference phone and a little more on a big one**, which is the same kind of gap
 * the rest of this project's furniture leaves. **The bottom-left corner used to be shared, and the collision
 * that was real when this number was chosen is worth recording rather than deleting**: the cooldown readout sat
 * on exactly these pixels (12px inset, two 120px bars), so on a 393 × 852 screen the ring's lower third covered
 * it — reported at the time rather than papered over, because the two ways out were a bigger inset, which lifts
 * the stick into the middle of the left edge where a thumb does not rest, or moving somebody else's bars. **It
 * is not a problem any more and it is not the reason for anything here**: the cooldown readout has since been
 * deleted at the user's request (*“it's not needed anymore and it's distracting”*), so this ring has the corner
 * to itself and the number below is a gap and nothing more.
 */
const STICK_EDGE_INSET_SCALE = 0.03;

/**
 * **How far the ring is moved from where that inset puts it, in screen pixels: `X` right, `Y` down.**
 * **Placeholder — `(0, 0)`, which is exactly where the derivation puts it.**
 *
 * **The same shape as `MobileControlsController`'s `BOX_NUDGE`, and for the same reason.** The derived place is
 * right on every device — it is a fraction of the screen, so it cannot land off it — but "right" is not the same
 * question as "where a thumb wants it", and a hand is the only instrument that can answer the second one. A
 * *delta* rather than a corner keeps the derivation: `new Vector2(0, -60)` reads as "60px higher than the
 * derivation thinks, on whatever device this is", which is the sentence a person actually has in mind when they
 * say the stick should be higher.
 *
 * **In screen pixels rather than a fraction, which is the one place this differs from the cluster's box.** That
 * box is described in reference pixels because every number in that HUD is multiplied by a viewport fit; this ring
 * is not — its *size* is already a fraction of the screen (see {@link STICK_DIAMETER_SCALE}) — so the only thing
 * left to move it by is a distance. **`X` right and `Y` down, positive in those directions**, because that is the
 * way a finger moves and there is then no sign to flip between the intent and the file.
 *
 * **What this lever deliberately does not do: stop at the edge.** The ring's bottom edge is the inset above the
 * bottom of the *usable* region, so a positive `Y` walks it off that region — a legitimate thing to discover with a
 * thumb and a bad thing to ship. **Nothing here is clamped**, for `BOX_NUDGE`'s own reason: a nudge that silently
 * stopped would be a number this file disagrees with, and the line that reports the geometry would be lying about
 * where the ring is. What keeps the *derived* place safe is that it is a fraction; what keeps the nudged place
 * honest is that a person typed it.
 */
const STICK_NUDGE = new Vector2(0, 0);

/**
 * **The movement zone: how much of each axis a touch may begin in and still start a push. Placeholder — `0.35` of
 * the width and `0.75` of the height, which is the lower-left of the screen.**
 *
 * **A dynamic stick needs a region rather than a target**, and this is the whole of what that region is for: the
 * base is placed *under* a finger, so the finger cannot be required to start on the base. Anything in this
 * rectangle that the HUD is not using is a push.
 *
 * **The width is the constrained number, and it is constrained from the right.** Two other things on this screen
 * want a thumb and both live on the right — the five-button cluster and the engine's jump button — and the cluster
 * is the nearer one: its box is `BOX_SIZE.X = 236` reference pixels abandoned at a 12px gap from the right edge, so
 * on the 393-wide reference phone its left edge is at **`0.37` of the width**, and on a 320px phone at the minimum
 * `0.85` fit it is at **`0.34`** — the tightest case this arithmetic can produce. `0.35` is therefore the widest
 * zone that stays clear of it on the devices this project has measured, and it is a *Placeholder* in the sense that
 * it belongs to the cluster's geometry as much as to the ring's.
 *
 * **An overlap would not steal a button press, and that is why the number is taste rather than a hard requirement.**
 * The pad is at {@link PAD_Z_INDEX}, below every element of the GUI it lives in, so a touch on a cluster button is
 * the button's whatever this rectangle says. The cost of overlapping would be the *other* direction: the base would
 * move to a thumb that was pressing a button, so the ring would appear over the cluster during somebody else's
 * press. Kept clear rather than argued about.
 *
 * **The height is not constrained, and it is bigger than it needs to be on purpose.** The base is never clamped into
 * this rectangle (see `placeBase`), so the zone does not have to contain the ring — it only has to be somewhere a
 * thumb can reach. What it must not do is reach the topbar furniture: a quarter of the screen is left above it,
 * which on the reference phone is below the shop button and the whole of the top readout column.
 */
const MOVEMENT_ZONE_WIDTH_SCALE = 0.35;
const MOVEMENT_ZONE_HEIGHT_SCALE = 0.75;

/**
 * The ring's fill, as a transparency rather than a colour. **Placeholder — 0.85.**
 *
 * **Almost nothing, so the game shows through** — which is the only honest way to draw a control that covers the
 * screen's most-played region. The colour it is a transparency *of* is `theme.colors.trough`, the same near-black
 * the cluster's idle buttons use at 0.6, so the ring reads as the same furniture as the buttons beside it
 * without being as solid as they are. **A fill rather than nothing at all** because a ring drawn only as a rim
 * is invisible over a bright sky, and because the fill is the one part of this control that says "this region is
 * the stick" before the player has touched it.
 */
const RING_FILL_TRANSPARENCY = 0.85;

/**
 * The ring's rim: its thickness in pixels and its opacity. **Placeholder — 3px at 0.20, thickened and darkened on
 * the same ask that made the ring bigger.**
 *
 * **This outline is the whole point of drawing our own control, and that is a player's sentence rather than a
 * designer's.** The classic thumbstick is liked because *“you can visibly see the outer circle that shows that you
 * are hitting max (1.0) on movement”* — the engine's fixed stick draws a disc with a rim, and the dynamic one draws
 * nothing until a finger lands and then has no rim at all, so the same push reads the same number with no way to
 * see it. **A rim at a fixed radius is the only thing that can say `1.0` before the player gets there**, which is
 * why it is drawn thicker and more solidly than the first cut's hairline.
 *
 * **The rim is the ring.** A stick's travel is a radius, and a circle drawn as a hairline is the only form that
 * states it without a fill heavy enough to hide the game. It is drawn in `theme.colors.accent` — the same colour
 * as the thumb and as the cluster's pressed buttons — which is the vocabulary this HUD already uses for "the
 * thing to look at".
 */
const RING_RIM_THICKNESS = 3;
const RING_RIM_TRANSPARENCY = 0.2;

/**
 * The thumb's opacity. **Placeholder — 0.**
 *
 * **Opaque, and the one solid pixel of this control** — the reference screenshot's own reading, and the reason
 * it works: the thumb is the only part of the stick that *changes*, so it has to be the part that reads first.
 * Under a thumb is also the one place on a touch screen where nothing needs to be seen.
 */
const THUMB_TRANSPARENCY = 0.5;

/**
 * **The ring's second look — the white one — and the line at which it is drawn. Copied from another game rather
 * than invented here, and the ask is the user's, in their own words:**
 *
 * > *“The classic controllers works well because I can visibly see the outer circle that shows that you are hitting
 * > max (1.0) on movement. … I need a box I can see for both, and its to be larger”*, then two screenshots of a
 * > football game and *“it turn white when sprint is activated / full throttle of joystick. It dark when throttle is
 * > not at max. This is a different game I am copying.”*
 *
 * **So the ring has two states and no gradient**: {@link RING_FILL_TRANSPARENCY}'s dark well while the thumb is
 * anywhere inside the circle, and a white disc with a solid rim once it is at the rim. That makes it a **stick
 * readout rather than a status light** — it says where the thumb is, which is a thing the player can check against
 * their own hand at any moment — and it is the direct answer to the complaint that opened this work: the engine's
 * dynamic thumbstick draws nothing at all, so the same push produced the same reading with nothing on screen to
 * confirm it.
 *
 * **`RING_MAX_LINE` is `1` and it is deliberately not a tuning value.** The reading is the push as a fraction of the
 * ring's *own* radius (see {@link STICK_DIAMETER_SCALE}) clamped at `1`, so **the line *is* the rim**: the state
 * changes when the thumb reaches the edge of the circle drawn on screen, not at some fraction of it that could drift
 * away from what the player can see. Any other number would put the white somewhere the ring draws no line at all.
 *
 * **It coincides with the sprint, and that is by construction rather than by upkeep.** `SprintController`'s start
 * line is `SPRINT_START_MAGNITUDE = 1` — a reading *at the clamp* — so one full push turns the ring white and
 * engages the sprint from a single number. **The two used to be a fifth of a second apart** — the white arrived
 * first, with the sprint's own engage hold behind it — and that hold has since been removed on request, so both
 * now land on the same frame of the same push. **The ring is deliberately not driven by `sprinting`
 * itself**: that value is the client's *want* rather than the server's grant, so a player whose stamina pool has run
 * dry would be shown a white ring over a body that is not running — a control lying about the one thing it exists to
 * show. What the ring is allowed to be wrong about is nothing at all: it reports a finger.
 *
 * **And it is not a bar.** No second threshold has to be kept in step with the sprint pair, and if that pair is ever
 * moved the white stays where the rim is — see {@link setMaxLook}, which is the only place the two paints live.
 *
 * **Both are Placeholders**: how solid the white disc is over grass and over a goal net, and how solid its edge is.
 * `theme.colors.onAccent` is `Palette.common.white`, the theme's own brightest value, so none of this needs a
 * `Color3.fromRGB` and it cannot drift away from the HUD's vocabulary.
 */
const RING_MAX_LINE = 1;
const RING_MAX_FILL_TRANSPARENCY = 0.25;
const RING_MAX_RIM_TRANSPARENCY = 0;

/**
 * The priority the movement write takes on the render step: `Enum.RenderPriority.Character`, i.e. `300`.
 *
 * **The same rung `AlternativeMovementController` binds at**, and for the argument recorded there: the default
 * control scripts write the character's movement at 100 and 200, the camera updates at 200, and this enum member
 * is documented as what a character-response callback is for. **`Heartbeat` is refused for the reference's own
 * reason** — it runs after the physics step, so anything written there is a frame late and belongs to a frame
 * nobody is looking at.
 *
 * **A name rather than a number**, because `BindToRenderStep` takes a number and the intent is a rung: the
 * `.Value` is read here once so no call site has to know what `Character` is worth.
 */
const MOVE_PRIORITY = Enum.RenderPriority.Character.Value;

/**
 * **The name this writer is bound under.** `BindToRenderStep` keys every binding by name, so this is what an
 * `UnbindFromRenderStep` would take — nothing calls one, because a controller lives as long as the client does
 * and a binding that outlives its controller is exactly what this controller *is*.
 */
const RENDER_BINDING_NAME = "TouchJoystick";

/**
 * The three instances' names. **Named rather than anonymous** because both this file's diagnostics and a Studio
 * `Explore` are read by people: a touch control found by name is one that can be inspected in a running client,
 * and the `Thumb` says what it is.
 */
const RING_NAME = "TouchJoystick";
const THUMB_NAME = "Thumb";
const PAD_NAME = "MovementZone";

/**
 * **The rung the movement zone's pad sits on: `0`, which is below every HUD element in the same `ScreenGui`.**
 *
 * **`ZIndex` is not a preference here, it is the mechanism that stops this feature from breaking the cluster.** A
 * GuiObject's default `ZIndex` is `1`, and `ZIndexBehavior`'s default compares *whole sibling subtrees* by their
 * root's rung — so a pad at `0` loses every contest it can be in, including against a five-button cluster nested
 * three levels inside its own box and against a round-result panel at `20`. That is what lets the zone be a big
 * invisible button in the lower-left without ever swallowing a button press. **It only works inside one
 * `ScreenGui`**: two `ScreenGui`s at the same `DisplayOrder` are ordered by their place in `PlayerGui` instead, so
 * the pad is mounted with the ring, in the `ScreenGui` both of them need for the same coordinate-space reason — see
 * the pad's own note in the mount, which is where that argument is made in full.
 *
 * **And it deliberately does not stop the *drawing* from being above the pad either**, though nothing is drawn on
 * the pad at all: the ring is in the other GUI, at the screen's own origin, which is where its coordinates come
 * from (see `reachOf`).
 */
const PAD_Z_INDEX = 0;

/**
 * **How much of the engine's own stick is drawn: `0`, i.e. none of it.**
 *
 * **A `UIScale`, and that is the whole trick — the same one `MobileControlsController.restyleEngineJump` uses on the
 * engine's jump button** (its log line reads `the engine drew 120px, rendering 61px at scale 0.510`). The
 * ControlModule owns that frame's `Size` and `Position` and re-lays them out on every viewport change, so writing
 * either is a fight this project has already lost — a `1.5×` `Size` write is reverted by the module's own layout
 * pass. A `UIScale` is an instance *we* add, the module never touches it, and the reference's own words are that
 * its `Scale` *"is used to multiply the `AbsoluteSize` of the parent UI element"*: the module's layout stays exactly
 * where it put it and only what is *rendered* changes. **A number rather than a boolean so the same constant could
 * resize the engine's stick instead of hiding it** — which is the experiment this project ran and abandoned, since
 * the drawn size is not the size a reading is a fraction of (see `SprintController.STICK_SCALE` for the log that
 * settled it).
 *
 * **The engine's movement input is deliberately left alone.** Hiding the drawing leaves the ControlModule's stick
 * listening over the same corner our ring is drawn in, and that is the arrangement we want: the ring is what the
 * player sees and what the white state reports, and a touch that lands on the engine's region instead still walks
 * the character. **Zero is used in every mode, and the cost is real rather than argued away** — a *dynamic* engine
 * stick that is hidden still writes movement from wherever it was touched, so a push on the lower screen that never
 * comes near our ring can move the character with nothing drawn under the finger. That is the price of the mode
 * being the player's; see {@link hideEngineStick}, which records what reversed the fixed-mode-only rule.
 */
const ENGINE_STICK_SCALE = 0;

/**
 * **The names the engine's movement frame wears, one per touch movement mode — and the fact that this list was wrong
 * once is the most useful thing about it.**
 *
 * It shipped without `ClassicThumbstickFrame`, which is the name the engine actually uses for the **fixed** stick —
 * the one `Thumbstick` mode draws — so in that mode the hiding below did nothing at all and a session showed **two
 * sticks in the same corner**: the engine's classic circle and our ring. **The probe's own line is what settled it**
 * (`[Joystick] engine touch GUI — 2 child(ren): JumpButton, ClassicThumbstickFrame`), after the list had guessed.
 * **These names are somebody else's code, and the only authority on them is what the engine put in the tree**, so
 * this is a list to grow from a log rather than a list to reason about from the reference. Which of them appears is
 * now the *player's* choice — `main.server.ts` deliberately sets no mode — so this file has to expect all of them.
 *
 * **The same names `SprintController` keeps for its own, now-inert resize machinery, and deliberately not shared**:
 * that one is a *sizing* reader and this one is a *hiding* writer, and the moment they shared a list they would start
 * wanting the same behaviour out of it. See `TAGS.md`'s note on the `Ball` tag for the same argument about a literal
 * two files must agree on.
 */
const ENGINE_STICK_FRAME_NAMES = [
	"ClassicThumbstickFrame",
	"DynamicThumbstickFrame",
	"ThumbstickFrame",
	"Thumbpad",
	"TouchDPad",
];

/**
 * **The name of the `UIScale` this file adds to the engine's stick frame.** Named rather than anonymous for the
 * reason {@link RING_NAME} and {@link THUMB_NAME} are: a client's `TouchGui` is a place a person inspects in Studio,
 * and `EngineStickHidden` says what put it there and why the stick is invisible.
 */
const ENGINE_STICK_SCALE_NAME = "EngineStickHidden";

/**
 * **How many times the "the engine showed its stick again" line is allowed to print: `5`.**
 *
 * The same shape as `SprintController.STICK_REPORT_LIMIT` and for the same reason: the watched signal fires from
 * inside the engine's own per-touch handling, so an uncapped line is one that a session could print hundreds of
 * times. **The first few are the informative ones** — they say whether the module is fighting this at all — and
 * after that the count is a number nobody needs in a chat log.
 */
const ENGINE_STICK_REPORT_LIMIT = 5;

/**
 * **How long the engine-stick probe waits for `TouchGui`.** Not a tuning value: it is the patience of a lookup,
 * and it is the same ten seconds the previous reader gave the same GUI. The engine builds its touch GUI during
 * boot — one of this project's logs put it about 1.5s after the client ignited — so the wait is normally over
 * before it starts.
 */
const TOUCH_GUI_WAIT_SECONDS = 10;

/** The local player's live humanoid, or nothing while there is no body to move. */
function humanoidOf(character: Model | undefined): Humanoid | undefined {
	return character?.FindFirstChildWhichIsA("Humanoid");
}

/** A fraction as the percentage a log line reads better as. **Diagnostics only** — nothing here is game logic. */
function formatPercent(fraction: number): string {
	return `${string.format("%.1f", fraction * 100)}%`;
}

/**
 * **The mount line's note on the movement mode it found, in the words each mode actually needs.**
 *
 * A function rather than a ternary at the call site because the cases are not symmetric and each one is a different
 * fact about the session: one is the mode that draws a second stick under a thumb, one is a client whose engine
 * controls are gone entirely, and one is a pad mode this file has never seen a frame for. **Nothing here says which
 * mode is *wanted*, because this project no longer asks for one** — `main.server.ts` leaves the property to the
 * player — so the point of the line is to say what the engine is doing on this client, and which of them is the one
 * to expect if a session has to be read later.
 */
function modeNote(mode: Enum.DevTouchMovementMode): string {
	if (mode === Enum.DevTouchMovementMode.Thumbstick) {
		return " — the fixed classic stick, hidden so only the ring is drawn";
	}

	if (mode === Enum.DevTouchMovementMode.DynamicThumbstick) {
		return (
			" — the dynamic stick, which follows a thumb anywhere on the lower screen; hidden like the fixed one, " +
			"but its input still writes movement wherever it is touched"
		);
	}

	if (mode === Enum.DevTouchMovementMode.Scriptable) {
		return " — scripted, so the engine draws no touch controls at all, the jump button included";
	}

	return " — the player's own choice; whatever stick the engine draws for it is hidden the same way";
}
