import { ReplicatedStorage } from "@rbxts/services";
import { CELEBRATING_ATTRIBUTE, ROUND_STATE_ATTRIBUTE, ROUND_STATUS_FOLDER } from "shared/constants";

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

/**
 * **Whether a round is being played right now** — the phase `RoundService` publishes, asked in one place.
 *
 * **`BallService.lifetimeOf` is the reader, and it is the whole reason this exists.** Item 139 took the
 * arena's own stock off the expiry clock, keyed on `ARENA_BALL_TAG`, and the report came back unchanged:
 * *"why are the balls still disappearing during rounds"*. The tag cannot answer that question, because the
 * tag says *the spawner put this one out* and most of a round's balls are not the spawner's — a `giveBall`
 * hand-out, a MultiBall refill and a dev's `InfiniteBalls` all make a fresh ball with nothing on it, and
 * every one of those lived ten seconds after it last landed. On the floor, mid-round, in front of the player
 * reporting it. The question those balls have to be asked is about the **round** rather than about the ball:
 * *while one is being played, is anything here on a clock?* The answer is no, and the round's own sweep is
 * what ends them.
 *
 * **Here rather than in `BallService`, and for {@link roundCelebrating}'s reason.** This module is the
 * sibling read of the status folder that does not depend on `RoundService`; `BallSpawnerService` reads the
 * same attribute the same way for its own phase edge. Every *other* reader of `"Playing"` in this codebase
 * spells the literal in its own file and the load is accepted, because each of those is asking a slightly
 * different question with it. **This one does not get that latitude**: the two readers that have to agree
 * about it are asking one question — *is this the round's ball* — and a single word that decides whether a
 * ball survives is a thing a rename has to find once.
 *
 * **`=== "Playing"` and nothing else.** `Celebrating` is a flag on the same folder rather than a phase (see
 * {@link roundCelebrating}), so a round whose result is being held for a moment is not playing, and the
 * balls lying about are litter again — which is exactly the moment the sweep is entitled to take them.
 *
 * **A missing folder is not a round.** Same `FindFirstChild`-not-`WaitForChild` reasoning as above: this is
 * read from inside a throw and a drop, and no folder yet means no round has ever run.
 */
export function roundPlaying(): boolean {
	const folder = ReplicatedStorage.FindFirstChild(ROUND_STATUS_FOLDER);
	if (folder === undefined) return false;

	return folder.GetAttribute(ROUND_STATE_ATTRIBUTE) === "Playing";
}
