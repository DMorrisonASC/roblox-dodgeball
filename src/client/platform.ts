import { UserInputService } from "@rbxts/services";

/**
 * What kind of machine this client is running on, in the one place that decides it.
 *
 * **Two controllers are alternatives rather than partners, and this is the question they are told to ask.**
 * `ControlsLegendController` is a reference card for a keyboard — every row on it names a key — and
 * `MobileControlsController` is a cluster of buttons that *are* their own labels, because a card telling a
 * player to press `E` is meaningless on a phone. Exactly one of them mounts, and this is the test both of
 * them run: the legend returns early on mobile, the cluster returns early everywhere else.
 *
 * **`TouchEnabled && !KeyboardEnabled`, and the second half is the load-bearing one.** `TouchEnabled` alone
 * asks "could this machine be touched", which is true of every phone, every tablet *and* every touchscreen
 * laptop — and on a laptop with a keyboard in front of it the legend is the right surface and a corner full
 * of thumb buttons is furniture nothing needs. Roblox answers `KeyboardEnabled` from the hardware it can
 * see, so a device with a keyboard is a device with a keyboard whatever else it can also do.
 *
 * **Studio's device emulator is the one case that reads as mobile**, because it takes the keyboard away with
 * the rest of the desktop. That is a feature rather than a fault — it is the only way to see the cluster
 * without a phone — and it is also why the cluster's own numbers (its sizes and its distance from the bottom
 * of the screen) need one look in that emulator before they can be called tuned.
 *
 * **Read per call rather than cached in a constant at module load.** The two reads are cheap,
 * `UserInputService` is a singleton whose properties never change during a session, and a module-level
 * `const` would be a value captured whenever this file happened to be required — the trap `hudTheme`
 * documents about big-ui's palette, arrived at from the other side. Nothing here is a subscription for the
 * same reason: a client does not change platform mid-session.
 *
 * **What this is not: a capability test for the game, and not a gate on a rule.** Nothing in the game
 * refuses a control on a platform, and every binding, remote and rule behind the buttons is the same one the
 * keyboard drives — the keys are simply not there to press. **Nine callers ask it now, and no two of them are
 * asking the same kind of question.** Two HUDs ask it to decide which of them is the useful thing to draw;
 * `ShiftLock` asks it because a phone has no mouse to lock; `SprintController` asks it because a keyboard asks
 * for the *whole* of its walk speed where a thumbstick asks for part of it; `ThrowController` asks it because a
 * phone has no cursor to aim with, so the throw follows the camera's axis; and `TouchJoystickController` asks it
 * because the engine's own touch movement is something only a touch device needs switched off — **the first
 * caller to gate a *replacement***, and the one whose cost of getting the answer wrong is a character with no
 * way to walk at all. **`ui/screenGui` is the newest and the one asking about something other than a control**:
 * it wants to know which *region* a HUD's `ScreenGui` should be placed in — the same safe area a touch is
 * measured from, asked as a layout question rather than as an input one, and the one caller here whose answer
 * changes where something is **drawn** rather than whether it exists. See that file for the rule it is half of,
 * and for why the answer is read at every call rather than latched into a constant. **`AimFacingController` is
 * the newest, and it asks the question `ThrowController` already asks one layer down**: a phone aims along the
 * camera's axis because it has no cursor, so the body is turned onto that axis while a throw is being charged,
 * while a desktop is turned onto the point the arc lands on. Two answers to one question, and the platform is
 * what picks between them — see that controller for the whole of it. **`client/aimAssist.ts` is the ninth and
 * the narrowest**: it asks only to decide whether to help a thumb at all, so its answer is the gate on a whole
 * feature rather than on a control surface, and it is asked *first* in its own path — before any ray or tag walk
 * — so that a desktop client cannot reach the assist's machinery at all. See that file for the argument.
 * **This paragraph used to
 * say three**, and the count is worth re-reading rather than trusting: `ThrowController` had been asking for a
 * while before anyone counted it, and that is what a number in a comment is worth. `SprintController` remains
 * the caller that gates a **sensor** rather than a surface, and the one whose cost of getting the answer wrong
 * is a sprint that never ends — see that controller for the argument.
 */
export function isMobile(): boolean {
	return UserInputService.TouchEnabled && !UserInputService.KeyboardEnabled;
}
