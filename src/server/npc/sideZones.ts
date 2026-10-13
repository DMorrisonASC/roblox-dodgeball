import { SIDE_KEEP_OUT_A_TAG, SIDE_KEEP_OUT_B_TAG } from "shared/constants";
import { taggedPartsInWorkspace } from "shared/taggedParts";
import { TEAM_A, TEAM_B } from "../services/round/team";
import { sideOfRig } from "./rigs";

/**
 * **Where a rig *may* fetch a ball from — one painted box per side, and the test that reads it.**
 *
 * **An allow-list, and it was a deny-list until 2026-10-13.** This module used to hand `SeekBehavior` the
 * *other* side's box and the behaviour skipped whatever was inside it: one exclusion, with every remaining ball
 * in `Workspace` a candidate — the lobby, the practice court and the enemy's floor included. The report that
 * produced the change is a rig walking to the lobby for a ball it could see and not reach. The box a side reads
 * is now **its own**, and a ball outside it is not a candidate at all; `constants.ts` carries the same
 * correction beside the two tags, and the tag strings are unchanged because they are painted in the place file.
 *
 * **The problem the region answers is a straight line.** `Behavior_Seeking` walks with `MoveTo`, which cannot
 * go round anything (its own doc says so at length), so a ball that has been thrown across the court and left
 * on the other side of the barrier is a ball a rig will walk at for the whole of its stall budget — 1.5 s of a
 * body pressed against a wall, in view, before it gives up and picks another. That is not a bug in the
 * behaviour; it is the behaviour being asked a question it cannot answer cheaply. See its doc for why the
 * honest answers (a raycast, a path) are all worse than the bound it already keeps.
 *
 * **So the place file answers it instead, and answering it as a *region* rather than as an exclusion is what
 * makes the rule expressible at all.** The box is authored geometry — the `CFrame` and `Size` of a part — and
 * this module is only the two questions about it: *which box applies to this rig*, and *is this point inside
 * it*. A denylist could only ever name what is out of bounds; an allowlist names what a rig's world is.
 *
 * **A module beside `rigs.ts` rather than a service**, for `HANDOFF.md` §0's rule and for `rigs.ts`'s own
 * reason: two lines of arithmetic over a painted part, asked by a behaviour, with no lifecycle, no state and
 * nothing to keep in step. The **tag** is what a person paints; the *side* is in the tag rather than in an
 * attribute so that a server which finds only one of the pair can say which one is missing.
 *
 * **A rig with no side has no region at all**, and that is the one case where the allow-list bites: it is not
 * in a round, so there is no half of the court that is its, and the round variant of the seek therefore
 * fetches *nothing* rather than everything. That is deliberate — the same "a rig with no side is inert" the
 * rest of the project keeps — and it is why the practice rigs in the place file wear a tag of their own, one
 * that reads the practice zone instead. See `AlwaysSeekingBehavior`.
 */

/**
 * **The boxes `rig` may fetch from: its own side's.**
 *
 * Read per call rather than cached, which is the same choice — and the same reason — `LobbyRigService.padsFor`
 * makes: the parts are painted, a dev moves them between runs and sometimes during one, and
 * `taggedPartsInWorkspace` is a `CollectionService` tag query rather than a walk of the tree, so the cost is
 * of the same order as the `looseBalls()` call the caller has already made this tick.
 *
 * **An empty list now means "this rig fetches nothing", which is the opposite of what it used to mean** — the
 * old reading was "no box, so every ball is worth chasing", and the caller is what decides the difference:
 * `createRoundSeekBehavior` reads an empty region as *stand*, because a rig without a side is not playing. A
 * place file that has lost one of the two boxes is the case `LobbyRigService`'s boot warning names, and the
 * symptom there is a whole side that never fetches a ball.
 */
export function fetchRegionFor(rig: Model): Array<BasePart> {
	const side = sideOfRig(rig);
	if (side === undefined) return [];

	return taggedPartsInWorkspace(side === TEAM_A ? SIDE_KEEP_OUT_A_TAG : SIDE_KEEP_OUT_B_TAG);
}

/**
 * **Whether `point` is inside any of `parts`, as a box test in each part's own space.**
 *
 * **Object space rather than the world's axes**, so a box somebody rotated in Studio still means what it looks
 * like: `PointToObjectSpace` is the inverse of the part's `CFrame`, so the comparison below is against its own
 * half-extents and a rotated box reads exactly as a viewer sees it.
 *
 * **`Size` rather than the engine's own overlap query, and the limitation is worth stating.** This is an
 * axis-aligned test in the part's frame, which is exact for a box and *wrong* for anything else — a `Ball`
 * zone, a cylinder, a wedge. A rig's fetch region is a region a person drags and resizes, which is a box, so
 * this is the shape that gets authored; a part that is not a box wants `GetPartBoundsInBox` per part instead
 * (which is what `RoundService.rigsOnPads` does for the join pads), and a zone that is not a box should say so
 * here rather than be silently approximate.
 *
 * **The ball's centre is the point**, which is exact enough for the question — a ball is 2 studs across and the
 * box is a court half.
 */
export function insideZone(parts: Array<BasePart>, point: Vector3): boolean {
	for (const part of parts) {
		// `offset` rather than `local`, which is a reserved Luau word: this is the point in the part's own
		// frame, and the compiler's own name for that mistake is worth avoiding twice.
		const offset = part.CFrame.PointToObjectSpace(point);
		const half = part.Size.div(2);

		if (math.abs(offset.X) <= half.X && math.abs(offset.Y) <= half.Y && math.abs(offset.Z) <= half.Z) {
			return true;
		}
	}

	return false;
}

/**
 * How many boxes each side has, for the boot line.
 *
 * **The count is the whole diagnostic**, and it is the one thing about a painted part that a build cannot
 * check: a box that was never tagged is not a fault in any file, and a side with no box fetches nothing at all
 * — which looks exactly like a side whose rigs have decided to stand still. Two numbers, printed once at
 * server start, are what turn "the rigs on B never pick a ball up" into "B has no box".
 *
 * **What the count means changed with the reading.** It was a count of *exclusions*, so a missing pair meant
 * rigs that chased balls they could not reach; it is a count of *regions* now, so a missing box means a side
 * that cannot fetch. The line is the same line; the failure behind it is louder. See `LobbyRigService`.
 */
export function zoneCounts(): { readonly a: number; readonly b: number } {
	return {
		a: taggedPartsInWorkspace(SIDE_KEEP_OUT_A_TAG).size(),
		b: taggedPartsInWorkspace(SIDE_KEEP_OUT_B_TAG).size(),
	};
}
