import { SIDE_KEEP_OUT_A_TAG, SIDE_KEEP_OUT_B_TAG } from "shared/constants";
import { taggedPartsInWorkspace } from "shared/taggedParts";
import { TEAM_A, TEAM_B } from "../services/round/team";
import { sideOfRig } from "./rigs";

/**
 * **Where a rig may not go and fetch a ball from — one painted box per side, and the test that reads it.**
 *
 * **The problem this answers is a straight line.** `Behavior_Seeking` walks with `MoveTo`, which cannot go
 * round anything (its own doc says so at length), so a ball that has been thrown across the court and left on
 * the other side of the barrier is a ball a rig will walk at for the whole of its stall budget — 1.5 s of a
 * body pressed against a wall, in view, before it gives up and picks another. That is not a bug in the
 * behaviour; it is the behaviour being asked a question it cannot answer cheaply. See its doc for why the
 * honest answers (a raycast, a path) are all worse than the bound it already keeps.
 *
 * **So the place file answers it instead.** A box on each side means a rig skips a ball on the far side
 * *before* it sets off, rather than discovering the wall and charging it. The box is authored geometry — the
 * `CFrame` and `Size` of a part — and this module is only the two questions about it: *which box applies to
 * this rig*, and *is this point inside it*.
 *
 * **A module beside `rigs.ts` rather than a service**, for `HANDOFF.md` §0's rule and for `rigs.ts`'s own
 * reason: two lines of arithmetic over a painted part, asked by a behaviour, with no lifecycle, no state and
 * nothing to keep in step. The **tag** is what a person paints; the *side* is in the tag rather than in an
 * attribute so that a server which finds only one of the pair can say which one is missing.
 *
 * **The rig's own side is not consulted for its own box** — that is the point of "opposing": a ball inside
 * the box on *its own* side is a ball it can walk to, and blocking that would refuse the ordinary case. The
 * rig's side comes from `sideOfRig`, so a mid-walk placeholder (no side yet) and a hand-tagged rig with no
 * `Team` are both unconstrained: they are not playing a round, so there is no side of the court that is not
 * theirs.
 */

/**
 * **The boxes `rig` may not fetch from: the other side's.**
 *
 * Read per call rather than cached, which is the same choice — and the same reason — `LobbyRigService.padsFor`
 * makes: the parts are painted, a dev moves them between runs and sometimes during one, and
 * `taggedPartsInWorkspace` is a `CollectionService` tag query rather than a walk of the tree, so the cost is
 * of the same order as the `looseBalls()` call the caller has already made this tick.
 *
 * An empty list is a **valid state**, not a fault: a place with no boxes is a place where every ball is worth
 * chasing, which is the behaviour every rig had before this existed. The boot line is what says whether the
 * place has them — see `LobbyRigService`, which reports the pair beside the pads and the template.
 */
export function keepOutPartsFor(rig: Model): Array<BasePart> {
	const side = sideOfRig(rig);
	if (side === undefined) return [];

	return taggedPartsInWorkspace(side === TEAM_A ? SIDE_KEEP_OUT_B_TAG : SIDE_KEEP_OUT_A_TAG);
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
 * check: a zone that was never tagged is not a fault in any file, and a rig that fetches balls from the far
 * side of the court looks exactly like a rig that is allowed to. Two numbers, printed once at server start,
 * are what turn "the rigs still chase unreachable balls" into "B has no box".
 */
export function zoneCounts(): { readonly a: number; readonly b: number } {
	return {
		a: taggedPartsInWorkspace(SIDE_KEEP_OUT_A_TAG).size(),
		b: taggedPartsInWorkspace(SIDE_KEEP_OUT_B_TAG).size(),
	};
}
