import { ReplicatedStorage } from "@rbxts/services";
import { ROUND_STATUS_FOLDER } from "shared/constants";

/**
 * The round's status folder, found if it is there and made if it is not.
 *
 * **One function so that two services can open the same channel without racing for it.** The round
 * publishes its phase here and the vote publishes what it is offering; both need the folder before
 * either can write anything, and both do it from their own `onStart`. Creating it in whichever
 * service happened to run first would mean the other had to wait for it — and a `WaitForChild` in
 * `onStart` is exactly the yield this codebase keeps out of service startup.
 *
 * There is no race to lose: this is synchronous, and `FindFirstChild` runs first, so the second
 * caller finds what the first one made and neither can produce a duplicate. That is also why it is
 * a lookup *and* a creation rather than a creation — a folder somebody put there by hand, or a
 * second run of a script in Studio, must not end up with two of these for a reader to choose
 * between.
 *
 * The attributes are not touched here. This decides that the folder exists; what goes in it is
 * each writer's own business, and a function that seeded values would be guessing at them.
 */
export function roundStatusFolder(): Folder {
	const existing = ReplicatedStorage.FindFirstChild(ROUND_STATUS_FOLDER);
	if (existing?.IsA("Folder")) return existing;

	const folder = new Instance("Folder");
	folder.Name = ROUND_STATUS_FOLDER;
	folder.Parent = ReplicatedStorage;

	return folder;
}
