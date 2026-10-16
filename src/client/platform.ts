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
 * **What this is not: a capability test, and not a gate on anything but drawing.** Nothing in the game
 * branches on "can this machine touch", no control is *refused* on a platform, and every binding, remote and
 * rule behind the buttons is the same one the keyboard drives — the keys are simply not there to press. This
 * question is asked twice, by two HUDs deciding which of them is the useful thing to draw.
 */
export function isMobile(): boolean {
	return UserInputService.TouchEnabled && !UserInputService.KeyboardEnabled;
}
