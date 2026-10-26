import { CollectionService, Players, Workspace } from "@rbxts/services";
import { PRACTICE_BAY_TAG, PRACTICE_THROW_TAG } from "shared/constants";
import { taggedPartsInWorkspace } from "shared/taggedParts";

/**
 * **A practice bay: which box a rig owns, and who is standing in it.**
 *
 * **A module rather than a service, and it was a service first.** `PracticeZoneService` answers *"is this body in
 * the practice area"* for five rules — ragdoll, dodge, catch, the shop's hide and the collision group — and every
 * one of those wants the whole area as one answer. This answers a different question with a different shape:
 * *which* bay a rig is in, and whether anybody is in **that** one. Folding it into that class would give one
 * service two tags and two unrelated lifetimes; a module with three exported functions and no state has neither,
 * and it is read by one behaviour's tick and one settle loop rather than by anything on a frame.
 *
 * **Nothing here caches.** `taggedPartsInWorkspace` walks the tag on every call, which is the rule that helper
 * documents: a person adding, moving or untagging a bay mid-session is what the next question sees, and there is
 * no cache to go stale because there is no cache. What that costs is a tag walk per drill rig per
 * `THROW_TICK_SECONDS` and per marked ball per settle turn — a tenth of a second each, not a frame.
 */

/**
 * **Whether `point` is over `bay`'s footprint — and a bay is a footprint, not a box.**
 *
 * **Height is deliberately not tested, and this is the correction a live report bought.** The first version of
 * this feature handed the bay's own `CFrame`/`Size` to `Workspace.GetPartBoundsInBox`, which is a
 * *three-dimensional* test — and a bay painted on a floor is a slab an inch thick, so:
 *
 * - a rig's `HumanoidRootPart` sits about three studs up and **did not intersect the slab at all**, so the rig was
 *   not recognised as being in its bay and never became a drill;
 * - a player's root did not intersect it either, so even a rig that had found its bay would have found it empty;
 * - and a ball leaving the hand at head height was outside the box the instant it was thrown, so the
 *   out-of-bounds rule destroyed it **at the muzzle** — a throw that never arrives.
 *
 * **All three symptoms, one mistake: treating height as part of a bay.** What a bay means is the *ground area* one
 * rig owns, so the honest shape is a vertical prism over the part's footprint — which is what a person painting a
 * box on a floor is drawing anyway. The part's own thickness is ignored entirely, and a bay is as tall as the
 * world. **Every question in this file goes through this one function** so the three symptoms cannot come back one
 * at a time.
 *
 * **Rotated, because a bay may be turned.** `PointToObjectSpace` moves the point into the part's own frame, so the
 * comparison is against the half-extents and a rotated bay is a rotated rectangle rather than its bounding box.
 */
function overFootprint(bay: BasePart, point: Vector3): boolean {
	// **`offset` and not `local`** — that identifier is reserved in Luau and roblox-ts refuses it, the same family
	// as `type`, `and`, `nil` and `self`.
	const offset = bay.CFrame.PointToObjectSpace(point);
	const half = bay.Size.mul(0.5);

	return math.abs(offset.X) <= half.X && math.abs(offset.Z) <= half.Z;
}

/**
 * **The bay `rig` is standing in, or `undefined` — which is the ordinary answer for any rig that is not a drill.**
 *
 * **By the root rather than by the model**, because a model spans several parts and the root is the body's own
 * centre — the same part the throwing behaviours already resolve for their aim. **A rig with no root answers
 * `undefined` rather than guessing**, which is the state of a rig mid-spawn and the reason a caller does not have
 * to check.
 *
 * **The first match, when a rig is over more than one.** Nothing reads the *identity* of the bay except
 * {@link playerInBay}, which asks the same question of the same part, so an overlapping pair behaves as their
 * union — which is what a person painting two boxes next to each other means.
 */
export function bayOf(rig: Model): BasePart | undefined {
	const root = rig.FindFirstChild("HumanoidRootPart");
	if (root === undefined || !root.IsA("BasePart")) return undefined;

	for (const bay of taggedPartsInWorkspace(PRACTICE_BAY_TAG)) {
		if (overFootprint(bay, root.Position)) return bay;
	}

	return undefined;
}

/** What a drill is aiming at: the person, where to aim, and the bay they are standing in. */
export interface DrillTarget {
	readonly player: Player;
	readonly at: Vector3;
	readonly bay: BasePart;
}

/**
 * **The person a drill should throw at, or `undefined` when nobody is in a bay — the whole of the gate and the aim,
 * in one call.**
 *
 * ## The rule this answers, and the one it deliberately stopped asking
 *
 * **The requirement is "a player standing in a bay, and nobody else".** The first version of this feature also
 * required **the rig** to be standing in that same bay, and a live session proved that rule can never fire in this
 * place file: the rig sits at `(52.1, 93.8, 542.0)` — verified in Studio — and was inside its bay's footprint on the
 * first tick and outside it four seconds later with the rig provably having not moved. **A rule that depends on the
 * rig and the box being co-located is a rule that depends on a coincidence**, and it was the wrong half to make
 * strict: the *box* is what a person painted to practise in, and the rig is a fixture beside it.
 *
 * So the strict test is on the **player**, which is exactly what was asked for, and the rig's own bay is a
 * **preference rather than a requirement**:
 *
 * 1. **the rig's own bay first** (`bayOf`), so a layout that does co-locate them scopes each drill to its own box —
 *    two drills, two boxes, two people, and each rig takes its own;
 * 2. **then every other bay**, so a rig standing beside the box rather than in it still works. This is what makes this
 *    place file work, and it is the difference between a feature and a puzzle;
 * 3. **nobody in any bay, nothing happens** — which is the whole of the requirement and is now the only thing that can
 *    silence a drill.
 *
 * **What this is not is the fallback that was rejected before.** That one armed a rig on the *`practiceZone`* — one box
 * around the entire practice floor — so every drill in the area fired at whoever was anywhere on it. A bay is a small
 * painted rectangle; a person outside every one of them is not being thrown at by anything.
 *
 * **Order, not distance, for the preference.** A rig in its own bay aims at the person in *that* bay even when a
 * different bay is closer, because the pair of tags is a statement about which ground belongs to which rig. Only the
 * second sweep is about the person, and there the nearest bay to the rig wins so that a row of drills beside one box
 * does not all pick it by list order.
 */
export function targetFor(rig: Model): DrillTarget | undefined {
	const bays = taggedPartsInWorkspace(PRACTICE_BAY_TAG);
	if (bays.size() === 0) return undefined;

	const own = bayOf(rig);

	// **Three passes, cheapest first, and the first that finds anybody wins.** The rig's own bay; then a bay overlapping
	// it (an overlapping pair is their union, see `bayOf`); then the rest by distance from the rig.
	if (own !== undefined) {
		const occupant = playerInBay(own);
		if (occupant !== undefined) return { ...occupant, bay: own };
	}

	const reach = rig.FindFirstChild("HumanoidRootPart");
	const origin = reach !== undefined && reach.IsA("BasePart") ? reach.Position : undefined;

	const rest = bays.filter((bay) => bay !== own);
	if (origin === undefined) {
		for (const bay of rest) {
			const occupant = playerInBay(bay);
			if (occupant !== undefined) return { ...occupant, bay: bay };
		}

		return undefined;
	}

	let best: DrillTarget | undefined;
	let bestDistance = math.huge;

	for (const bay of rest) {
		const occupant = playerInBay(bay);
		if (occupant === undefined) continue;

		const flat = new Vector3(occupant.at.X - origin.X, 0, occupant.at.Z - origin.Z);
		const distance = flat.Magnitude;
		if (distance >= bestDistance) continue;

		best = { ...occupant, bay: bay };
		bestDistance = distance;
	}

	return best;
}

/**
 * **The `Player` standing in `bay` whom the drill should throw at, and where to aim — or `undefined` for an empty
 * bay.**
 *
 * **A scan over `Players.GetPlayers()` rather than a query for "any character in the box", and the difference
 * matters.** The query would answer with rigs too, and a rig standing in a bay is exactly the body asking the
 * question. Asking each *player's* root is the filter that makes the answer *"a person is here"* rather than
 * *"something is"*.
 *
 * **`Character` rather than a cached body**, for `PracticeZoneService.insideZone`'s reason: a character
 * mid-respawn is a player with nowhere to be, and a stale reference would be a rig arming a throw at a body that
 * no longer exists.
 *
 * **The nearest rather than the first, and the difference is which question this answers.** With a bay painted
 * around one rig a person expects to be alone in it, so the two agree in the common case; where they disagree is
 * two people in one bay, and there "the one in front of me" is the only reading that makes a drill predictable.
 * `Players.GetPlayers()` order is not meaningful, so the first entry would be whichever name Roblox happened to
 * list — a throw that changes target without anything having moved.
 *
 * **Horizontal distance**, for `overFootprint`'s reason: a bay is a footprint, so a player on a step or a ramp is
 * beside the rig rather than below it, and a vertical component would make the same spot on the floor arm or
 * disarm depending on the geometry underneath.
 *
 * **The point to aim at is the player's `HumanoidRootPart`, not their head** — the root is the body's own centre,
 * which is what `ThrowBehavior` measures its sighting from and what a ball leaving at head height arrives *down*
 * onto. Aiming at the head would put every drill throw high on a body that is crouching or falling.
 */
export function playerInBay(bay: BasePart): { player: Player; at: Vector3 } | undefined {
	const anchor = bay.CFrame.Position;

	let best: { player: Player; at: Vector3 } | undefined;
	let bestDistance = math.huge;

	for (const player of Players.GetPlayers()) {
		const character = player.Character;
		if (character === undefined) continue;

		const root = character.FindFirstChild("HumanoidRootPart");
		if (root === undefined || !root.IsA("BasePart")) continue;

		// **The same footprint test the rig's own bay was found with**, which is the whole of the correction: a
		// player standing on a floor-painted bay is *over* it whatever the part's thickness, and a box overlap used
		// to answer `false` for exactly that case. See `overFootprint`.
		if (!overFootprint(bay, root.Position)) continue;

		const flat = new Vector3(root.Position.X - anchor.X, 0, root.Position.Z - anchor.Z);
		const distance = flat.Magnitude;
		if (distance >= bestDistance) continue;

		best = { player: player, at: root.Position };
		bestDistance = distance;
	}

	return best;
}

/**
 * **Whether `point` is over any bay at all — the out-of-bounds test for a drill's ball.**
 *
 * **A footprint test, not a box test, and this is the one that used to destroy the ball at the muzzle.** A ball
 * leaves the hand at head height; a bay painted on the floor is a slab; so a three-dimensional test said "out of
 * bounds" on the first settle turn after every throw. See {@link overFootprint} for the whole of that.
 *
 * **No bays anywhere means nothing to be out of bounds of**, so every point answers `true` and no drill ball is
 * destroyed. That is not generosity, it is the rule being meaningless in a place file that has no bays: enforcing
 * it against an empty tag would poof every ball the instant it left a hand.
 *
 * **Cheap, which is what lets it run per marked ball per `SETTLE_PERIOD` turn**: one `PointToObjectSpace` and
 * three compares per bay, no query and no `OverlapParams`.
 */
export function insideAnyBay(point: Vector3): boolean {
	const bays = taggedPartsInWorkspace(PRACTICE_BAY_TAG);
	if (bays.size() === 0) return true;

	for (const bay of bays) {
		if (overFootprint(bay, point)) return true;
	}

	return false;
}

/**
 * **How far `point` is horizontally from `bay`'s footprint — nought when it is over it.**
 *
 * **The measurement behind every "you are not in the bay" answer**, and it is measured to the *footprint* rather than
 * to the centre because a centre-to-centre figure is actively misleading: a bay twenty studs across has its centre ten
 * studs from its own edge, so a body standing comfortably inside it would be reported as "ten studs away". Clamping
 * the offset to the half-extents gives zero inside and the true gap outside, which is the only number worth printing.
 *
 * **Horizontal, like {@link overFootprint}** — a bay is a footprint, and a player on a step is beside it, not above it.
 */
export function gapToFootprint(bay: BasePart, point: Vector3): number {
	const offset = bay.CFrame.PointToObjectSpace(point);
	const half = bay.Size.mul(0.5);

	const dx = math.max(0, math.abs(offset.X) - half.X);
	const dz = math.max(0, math.abs(offset.Z) - half.Z);

	return math.sqrt(dx * dx + dz * dz);
}

/** The nearest bay to a point, and how far the point is outside it. See {@link gapToFootprint}. */
export interface BayGap {
	/** `math.huge` when there is nothing measurable — no bay, or no player with a body. */
	readonly gap: number;

	/** One sentence naming the bay, its geometry and the body's position, for a log line. */
	readonly text: string;
}

/**
 * **The nearest player's distance from the nearest bay, in words — the one line that answers "why is nothing
 * happening".**
 *
 * **This exists because a bay is a place, and a place is invisible in a log.** The feature's hard requirement is "a
 * player standing in a bay", so its ordinary failure is a *geometric miss*: the box was painted somewhere the person
 * does not stand, or is a size that does not reach them. From the code's point of view that is indistinguishable from
 * an empty bay, from a missing tag, and from a rig that never ticked — and two live sessions were spent on that
 * ambiguity. **So the answer is stated as three pairs of numbers: where the bay is, how big it is, and where the
 * person is.** Those three are enough to fix it without another round trip.
 *
 * **The nearest player, not the local one**, because this runs on the server and "the person who is trying" is the
 * one closest to a box. With one player — the usual case while building a drill — the distinction does not arise.
 *
 * **`math.huge` rather than a large number** when nothing can be measured, so the caller can tell "no reading" from
 * "a very long way" and print a different sentence. An absent character and an absent bay are both real states during
 * boot and must not read as "you are 1e308 studs away".
 */
export function nearestPlayerBayGap(): BayGap {
	const bays = taggedPartsInWorkspace(PRACTICE_BAY_TAG);
	if (bays.size() === 0) return { gap: math.huge, text: "and there is no practiceBay part in the world at all" };

	let best: BayGap = { gap: math.huge, text: "and no player has a body to measure" };

	for (const player of Players.GetPlayers()) {
		const character = player.Character;
		if (character === undefined) continue;

		const root = character.FindFirstChild("HumanoidRootPart");
		if (root === undefined || !root.IsA("BasePart")) continue;

		for (const bay of bays) {
			const gap = gapToFootprint(bay, root.Position);
			if (gap >= best.gap) continue;

			best = {
				gap: gap,
				text:
					`${player.Name} is ${string.format("%.1f", gap)} studs outside "${bay.Name}", which is centred at ` +
					`(${string.format("%.1f", bay.Position.X)}, ${string.format("%.1f", bay.Position.Y)}, ` +
					`${string.format("%.1f", bay.Position.Z)}) with size ${string.format("%.1f", bay.Size.X)}×` +
					`${string.format("%.1f", bay.Size.Y)}×${string.format("%.1f", bay.Size.Z)}; ${player.Name} ` +
					`is at (${string.format("%.1f", root.Position.X)}, ${string.format("%.1f", root.Position.Y)}, ` +
					`${string.format("%.1f", root.Position.Z)})`,
			};
		}
	}

	return best;
}

/**
 * **Prints the drill inventory at boot — how many rigs are drills, and how many bays there are to stand in.**
 *
 * **This exists because the feature's ordinary failure is a silence, and a silence is indistinguishable from a
 * success.** A drill with nobody in a bay stands still and clears its countdown and says nothing at all — that is the
 * *correct* behaviour for an empty box and it is also exactly what a place file with no `practiceBay` part looks like,
 * and what a rig with no `practiceThrow` tag looks like, and what a tag painted on a `Folder` looks like. Several
 * causes, one symptom, and before this line the diagnostic was "nothing happens".
 *
 * **Called once, from `NpcService.onStart`, and phrased like the boot lines a reader already knows** — `[Zone] up —
 * practiceZone: 1 tagged part(s)` and `[Spawner] up — … 6 tagged thing(s), 6 usable part(s)`. The distinction those
 * two draw is the one that matters here: **tagged *things* against usable *parts***. A person who paints the tag on a
 * folder of bay geometry gets a count in the first figure and nothing in the second, which says "wrong instance type"
 * rather than "you forgot".
 *
 * **Counts only, and the per-rig answer is the behaviour's.** Whether a *particular* rig is standing in a bay is a
 * fact that changes with the world, so it is reported where it is observed — `PracticeThrowBehavior`'s edge-triggered
 * stand-down line — rather than frozen into a boot reading that a rig moved a second later would make a lie.
 *
 * **`CollectionService.GetTagged` rather than the filtered helpers for the raw counts**, for the reason
 * `ShiftLock.reportZoneParts` gives: the whole point is to be honest about what the tag holds, including the entries the
 * rule cannot use.
 */
export function reportDrills(): void {
	const bayThings = CollectionService.GetTagged(PRACTICE_BAY_TAG).size();
	const bays = taggedPartsInWorkspace(PRACTICE_BAY_TAG).size();

	const drills = CollectionService.GetTagged(PRACTICE_THROW_TAG).filter(
		(instance) => instance.IsA("Model") && instance.IsDescendantOf(Workspace),
	).size();

	print(
		`[Drill] up — ${PRACTICE_THROW_TAG}: ${drills} rig(s), ${PRACTICE_BAY_TAG}: ${bayThings} tagged thing(s), ` +
			`${bays} usable part(s)`,
	);

	// **Where the box actually is, in the boot line, because "1 usable part" does not say whether it is anywhere
	// useful.** Two sessions were spent on a bay that existed, was a `BasePart`, and was simply not where anybody
	// stood — and nothing in the output could distinguish that from an empty box. The centre and size are the two
	// figures a person needs to compare against where they stand.
	for (const bay of taggedPartsInWorkspace(PRACTICE_BAY_TAG)) {
		print(
			`[Drill]   ${PRACTICE_BAY_TAG} "${bay.Name}" at (${string.format("%.1f", bay.Position.X)}, ` +
				`${string.format("%.1f", bay.Position.Y)}, ${string.format("%.1f", bay.Position.Z)}), ` +
				`size ${string.format("%.1f", bay.Size.X)}×${string.format("%.1f", bay.Size.Y)}×` +
				`${string.format("%.1f", bay.Size.Z)}`,
		);
	}

	// **The two sentences worth printing unprompted, because each is a fault rather than a state.** A drill tag with no
	// bay anywhere is a place file that cannot work whatever the rigs do; a bay with no drill tag is the same mistake
	// from the other end. Both are silent at runtime — the rig simply never fires — so this is the only moment anything
	// can say so.
	if (drills > 0 && bays === 0) {
		warn(
			`[Drill] ${drills} rig(s) wear ${PRACTICE_THROW_TAG} and no usable ${PRACTICE_BAY_TAG} part exists — ` +
				`every one of them will stand still. Paint the tag on the floor box each drill owns.`,
		);
	} else if (bays > 0 && drills === 0) {
		warn(
			`[Drill] ${bays} ${PRACTICE_BAY_TAG} part(s) exist and no rig wears ${PRACTICE_THROW_TAG} — nothing will ` +
				`throw at anybody. Paint ${PRACTICE_THROW_TAG} on the rig.`,
		);
	}
}
