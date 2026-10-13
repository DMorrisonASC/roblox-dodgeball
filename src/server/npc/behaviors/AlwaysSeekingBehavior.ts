import { PRACTICE_ZONE_TAG } from "shared/constants";
import { taggedPartsInWorkspace } from "shared/taggedParts";
import { BEHAVIOR_ALWAYS_SEEKING, NpcBehavior } from "../Behavior";
import { createSeekBehavior } from "./SeekBehavior";
import type { SeekRegion } from "./SeekBehavior";
import type { BallPickupService } from "../../services/ball/BallPickupService";
import type { BallService } from "../../services/ball/BallService";

/**
 * Walking to a ball inside the practice zone, for a practice rig — **the practice half of the seek split.**
 *
 * **Why this is a tag of its own rather than a mode of `Behavior_Seeking`.** The two kinds of rig fetch from
 * two different places, and until 2026-10-13 they wore one tag and ran one behaviour that fetched from
 * *everywhere*: a rig in the practice area would walk out of it for a loose ball, and a rig playing a round
 * would walk into the practice court or the lobby for one. Two regions cannot be one tag — the tag is what a
 * person paints on a rig and what `NpcService` dispatches on — so the tag that reads the side boxes is
 * `Behavior_Seeking` and this is the one that reads the zone.
 *
 * **The region is the practice zone, read the way the zone is read everywhere else.** The parts come from
 * `taggedPartsInWorkspace(PRACTICE_ZONE_TAG)` — the same call `PracticeZoneService.insideZoneAt` makes per
 * point, and the same arithmetic tests the answer, because `sideZones.insideZone` and that function are the
 * same box test written for a list and for a point. Nothing here walks the tree by name or asks a service
 * where the zone is: the tag is the interface, and the zone part exists whether or not a player is standing
 * in it.
 *
 * **The region is a property of the behaviour and not of where the rig stands.** A practice rig that steps
 * out of the zone still fetches from inside it and walks back in to do it. Stated as a choice because the
 * alternative — "fetch inside the zone *while you are in it*" — would leave a rig that has wandered out with
 * nothing to do at all, which is how a rig ends up standing in the lobby for a round: the exact shape of the
 * bug that produced the round variant of this behaviour.
 *
 * **The name is the user's and it reads oddly: see `Behavior.ts`.** Every other `Always*` tag is an ungated
 * twin, and seeking has no gate to remove; `Behavior_PracticeSeeking` would say what this is. Not renamed
 * here, because the string is painted in the place file.
 *
 * **What this is not:** not a radius (there is none, and the zone is a box), not a second seek (the whole
 * behaviour is the factory in `SeekBehavior.ts`, and this file is its tag, its region and its doc), and not a
 * rule about the pickup — `Behavior_Pickup`'s reach is `BALL_CONFIG.PICKUP_RADIUS` from wherever the rig
 * stands, so a ball just outside the zone beside the rig can still be taken, which is the picker's rule and
 * not the fetch's.
 */

/**
 * The practice zone as a region: **the parts tagged `practiceZone`, in the shape `SeekRegion` asks for.**
 *
 * A function rather than a list, because `SeekBehavior` reads the region once per choice and the parts are
 * painted — a dev moves them between runs and sometimes during one. One tag walk per choice, not one per
 * candidate ball: that is why the region is a list of parts rather than a point-at-a-time predicate.
 */
const practiceZone: SeekRegion = {
	label: "the practice zone",
	parts: () => taggedPartsInWorkspace(PRACTICE_ZONE_TAG),
};

/** The practice variant: one call to the shared factory, with the tag and the region that make it this one. */
export function createAlwaysSeekBehavior(pickups: BallPickupService, balls: BallService): NpcBehavior {
	return createSeekBehavior(pickups, balls, BEHAVIOR_ALWAYS_SEEKING, practiceZone);
}
