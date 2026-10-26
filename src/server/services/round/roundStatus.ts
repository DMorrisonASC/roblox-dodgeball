import { ReplicatedStorage } from "@rbxts/services";
import { CELEBRATING_ATTRIBUTE, ROUND_STATUS_FOLDER } from "shared/constants";

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

/**
 * **Whether the round that has just ended is still holding the arena** — see `CELEBRATING_ATTRIBUTE`.
 *
 * **One function with three readers, because a word between files is what this codebase keeps paying for.**
 * `BallService.throwBallBody`, `CatchService.blocksCatch` and `BallComponent.landHit` each need this same
 * yes/no, and each of those files already carries its own copy of the literal `"Playing"` for the phase — five
 * files, five strings, and every one of them is a place a rename goes wrong. That load is accepted for the
 * phase because each reader is asking a slightly different question with it; this one is the same question
 * three times, so it is asked once.
 *
 * **`true` only when the answer is a real boolean `true`.** The attribute is cleared by writing `undefined`
 * (`RoundService.holdCelebration`), and an attribute that has never been written reads `undefined` too — so a
 * truthiness test would work and a `=== true` test says what it means without relying on that.
 *
 * **A missing folder is not a celebration.** The lookup is a `FindFirstChild` rather than a
 * `WaitForChild`, for `roundStatusFolder`'s reason: this is read from inside a throw and a catch, and a
 * yield there would be the whole server waiting on a folder. No folder yet means no round has ever run,
 * which means nothing is celebrating.
 */
export function roundCelebrating(): boolean {
	const folder = ReplicatedStorage.FindFirstChild(ROUND_STATUS_FOLDER);
	if (folder === undefined) return false;

	return folder.GetAttribute(CELEBRATING_ATTRIBUTE) === true;
}
