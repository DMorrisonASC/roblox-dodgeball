import { CollectionService, Players, Workspace } from "@rbxts/services";
import { BALL_CONFIG } from "shared/config/ball.config";
import { PRACTICE_BAY_TAG, PRACTICE_THROW_TAG } from "shared/constants";
import { taggedPartsInWorkspace } from "shared/taggedParts";
import { logInfo, logWarn } from "shared/logger";

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
	/** **Hand height on the body, not the root** — see {@link playerInBay} for the charge this used to cost. */
	readonly at: Vector3;
	readonly bay: BasePart;
}

/**
 * **The person a drill should throw at, or `undefined` when nobody is in a bay — the whole of the gate and the aim,
 * in one call.**
 *
 * ## The rule: **one bay per rig, and only that bay arms it**
 *
 * **A drill's zone is a bay, and each drill owns exactly one.** The player has to be standing in *that* bay; a player
 * in somebody else's box is not this rig's business, and a report of two drills throwing at one person from opposite
 * sides of the practice floor is exactly what the rule this replaced produced.
 *
 * **What that rule was, and why it is gone.** The version before this had three passes — the rig's own bay, then an
 * overlapping one, then **every other bay by distance** — with the last of the three there because the feature's first
 * place file had one bay and one rig that was not standing on it. That made the rule fire in a layout where it could
 * otherwise never fire, and it was the right answer to that layout. **With two bays and two rigs it is the wrong
 * answer**: the rig beside box B has an empty own bay, so the third pass hands it whoever is standing in box A, and
 * both drills fire at the same person. A fallback that lets a rig shoot into another rig's box is not a fallback, it
 * is a second rule with a worse name.
 *
 * **So a rig is bound to one bay, and which one is decided by geography rather than by who is available:**
 *
 * 1. **the bay it is standing in** (`bayOf`), which is the ordinary case and the one a person painting a box around a
 *    drill is describing;
 * 2. **the bay nearest it**, for a rig planted *beside* its box rather than on it. This is the concession that keeps
 *    the old layout working, and it cannot cross into somebody else's zone the way the old third pass could — a rig
 *    beside box B is nearest box B whoever happens to be standing where;
 * 3. **no bay at all means no throws.** A drill with no ground of its own has nothing to defend, and the stand-down
 *    line says so in as many words.
 *
 * **The cost of (3) is stated rather than hidden**: a drill whose bay was deleted, or which was moved away from every
 * box, goes quiet instead of shooting at whoever is nearest. That is a *diagnosable* silence — `rigBayGap` prints the
 * bay it is bound to and where the person is — where the old rule's failure was two rigs firing at one player for no
 * visible reason. A misplaced rig wants moving, not a licence to shoot into somebody else's box.
 */
export function targetFor(rig: Model): DrillTarget | undefined {
	const own = bayOf(rig) ?? nearestBayTo(rig);

	// **No bay anywhere, or none this rig can be bound to**, which is the same answer and the same silence. See this
	// function's own note on (3): it is a fixture with nowhere to practise in front of it, not an error.
	if (own === undefined) return undefined;

	const occupant = playerInBay(own);

	return occupant === undefined ? undefined : { ...occupant, bay: own };
}

/**
 * **The bay whose footprint is nearest `rig`'s root, or `undefined` when there are no bays or the rig has no body.**
 *
 * **The half of {@link targetFor}'s binding that has nothing to do with players.** Measuring to the *footprint* rather
 * than the centre is what makes "beside the box" and "over the box" the same answer wherever the box is wide — see
 * {@link gapToFootprint} for why a centre-to-centre figure is actively misleading at this size. A rig standing over a
 * bay never reaches this: `bayOf` has already answered for it, and this is the fallback for a fixture planted off the
 * edge.
 *
 * **A tie goes to whichever the tag lists first**, which is not meaningful order and is stated rather than fixed: two
 * drills equidistant from two boxes is a layout nobody can paint by accident, and a claim system for it would be a
 * service for a case this project does not have.
 */
function nearestBayTo(rig: Model): BasePart | undefined {
	const bays = taggedPartsInWorkspace(PRACTICE_BAY_TAG);
	if (bays.size() === 0) return undefined;

	const root = rig.FindFirstChild("HumanoidRootPart");
	if (root === undefined || !root.IsA("BasePart")) return undefined;

	let best: BasePart | undefined;
	let bestGap = math.huge;

	for (const bay of bays) {
		const gap = gapToFootprint(bay, root.Position);
		if (gap >= bestGap) continue;

		best = bay;
		bestGap = gap;
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
 * **The point to aim at is the body's own root *raised to the height a ball leaves a hand* — and the raise is the
 * whole of a bug this comment used to argue for.** It said the root, "which is what a ball leaving at head height
 * arrives *down* onto", and that was true of the lob this game threw before the charged throw. A charged throw is
 * flat — `CHARGE_PEAK_HEIGHT` is half a stud, so the arc peaks where it started and every stud of range is bought
 * with speed rather than with hang time — and a flat throw aimed two and a half studs *below* its own muzzle is
 * solved as *the slowest ball that still drops that far over that distance*. Under 41 studs that answer is the
 * minimum speed in the game, so every drill throw inside its bay came out at `charge 0.00–0.01`: the softest ball
 * the mechanic has, a windup of twelve milliseconds, and a log line that reads like a broken calculation. See
 * `chargeForRange`, whose rise argument is exactly this quantity, and `BALL_CONFIG.THROW_MUZZLE_HEIGHT`, which is
 * the height `getThrowMuzzle` adds to a root — so on level ground the rise here is now **zero**, which is what a
 * flat throw wants: `chargeForRange` then asks for the speed that covers the distance and nothing else.
 *
 * **It also stays a point on the *body* rather than a direction**, which is what `Windup.miss` needs: the offset is
 * re-applied to whatever this answers on the release turn, so a drill still tracks a walking player exactly as it did.
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

		best = { player: player, at: aimHeightOf(root.Position) };
		bestDistance = distance;
	}

	return best;
}

/**
 * **Where a drill aims on a body: the point a ball would meet it at if thrown flat from a hand.**
 *
 * A one-line helper rather than an expression at the call site because the figure is `THROW_MUZZLE_HEIGHT` — the same
 * constant `getThrowMuzzle` adds to a thrower's root — and stating it as "the target's root, raised by the height the
 * throw leaves from" is the only way this reads as a rule rather than as a magic 2.5. On level ground the rise a
 * `chargeForRange` solve then sees is exactly zero, which is what makes the charge describe the *distance* instead of
 * the *drop*. See {@link playerInBay} for the bug that was.
 */
function aimHeightOf(rootAt: Vector3): Vector3 {
	return rootAt.add(new Vector3(0, BALL_CONFIG.THROW_MUZZLE_HEIGHT, 0));
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
 * **The nearest player's distance from *the bay this rig owns*, in words — the one line that answers "why is nothing
 * happening".**
 *
 * **This exists because a bay is a place, and a place is invisible in a log.** The feature's hard requirement is "a
 * player standing in the rig's bay", so its ordinary failure is a *geometric miss*: the box was painted somewhere the
 * person does not stand, or is a size that does not reach them. From the code's point of view that is indistinguishable
 * from an empty bay, from a missing tag, and from a rig that never ticked — and two live sessions were spent on that
 * ambiguity. **So the answer is stated as three pairs of numbers: where the bay is, how big it is, and where the
 * person is.** Those three are enough to fix it without another round trip.
 *
 * **`rig` and not "the nearest bay", which is the correction two drills bought.** This used to measure the person
 * against whichever bay was closest *to them*, so with two bays it printed the box they were standing in and called
 * them zero studs outside — while the rig printing the line was bound to the other one. **A diagnostic that names a
 * bay the rig cannot use is worse than no diagnostic**, so it now names the bay `targetFor` will actually consult and
 * measures against that one: a player in the wrong box then reads as a real distance from the right box, which is the
 * whole answer.
 *
 * **The nearest player, not the local one**, because this runs on the server and "the person who is trying" is the one
 * closest to a box. With one player — the usual case while building a drill — the distinction does not arise.
 *
 * **`math.huge` rather than a large number** when nothing can be measured, so the caller can tell "no reading" from
 * "a very long way" and print a different sentence. An absent character, an absent bay and a rig bound to no bay are
 * all real states during boot and must not read as "you are 1e308 studs away". The last of the three has its own
 * sentence, because a rig with no ground of its own will never throw and that is worth saying out loud.
 */
export function rigBayGap(rig: Model): BayGap {
	const bays = taggedPartsInWorkspace(PRACTICE_BAY_TAG);
	if (bays.size() === 0) return { gap: math.huge, text: "and there is no practiceBay part in the world at all" };

	// **The same binding the throwing rule uses**, asked here rather than derived from the player, so this line can
	// never describe a bay the rig would not throw into. See `targetFor`.
	const own = bayOf(rig) ?? nearestBayTo(rig);
	if (own === undefined) {
		return {
			gap: math.huge,
			text:
				`and this rig is not standing on or near any of the ${bays.size()} bay(s), so it has no zone to ` +
				`defend — move it over a bay`,
		};
	}

	let best: BayGap = { gap: math.huge, text: `and no player has a body to measure against "${own.Name}"` };

	for (const player of Players.GetPlayers()) {
		const character = player.Character;
		if (character === undefined) continue;

		const root = character.FindFirstChild("HumanoidRootPart");
		if (root === undefined || !root.IsA("BasePart")) continue;

		const gap = gapToFootprint(own, root.Position);
		if (gap >= best.gap) continue;

		best = {
			gap: gap,
			text:
				`${player.Name} is ${string.format("%.1f", gap)} studs outside this rig's bay "${own.Name}", which is ` +
				`centred at (${string.format("%.1f", own.Position.X)}, ${string.format("%.1f", own.Position.Y)}, ` +
				`${string.format("%.1f", own.Position.Z)}) with size ${string.format("%.1f", own.Size.X)}×` +
				`${string.format("%.1f", own.Size.Y)}×${string.format("%.1f", own.Size.Z)}; ${player.Name} ` +
				`is at (${string.format("%.1f", root.Position.X)}, ${string.format("%.1f", root.Position.Y)}, ` +
				`${string.format("%.1f", root.Position.Z)})`,
		};
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

	logInfo(
		`[Drill] up — ${PRACTICE_THROW_TAG}: ${drills} rig(s), ${PRACTICE_BAY_TAG}: ${bayThings} tagged thing(s), ` +
			`${bays} usable part(s)`,
	);

	// **Where the box actually is, in the boot line, because "1 usable part" does not say whether it is anywhere
	// useful.** Two sessions were spent on a bay that existed, was a `BasePart`, and was simply not where anybody
	// stood — and nothing in the output could distinguish that from an empty box. The centre and size are the two
	// figures a person needs to compare against where they stand.
	for (const bay of taggedPartsInWorkspace(PRACTICE_BAY_TAG)) {
		logInfo(
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
		logWarn(
			`[Drill] ${drills} rig(s) wear ${PRACTICE_THROW_TAG} and no usable ${PRACTICE_BAY_TAG} part exists — ` +
				`every one of them will stand still. Paint the tag on the floor box each drill owns.`,
		);
	} else if (bays > 0 && drills === 0) {
		logWarn(
			`[Drill] ${bays} ${PRACTICE_BAY_TAG} part(s) exist and no rig wears ${PRACTICE_THROW_TAG} — nothing will ` +
				`throw at anybody. Paint ${PRACTICE_THROW_TAG} on the rig.`,
		);
	}
}
