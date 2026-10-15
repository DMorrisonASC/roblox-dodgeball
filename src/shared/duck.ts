/**
 * What a duck is, for the two machines that have to agree about it: **which parts a body has moved out
 * of a ball's way, and which group they are moved into to do it.**
 *
 * **The rule, in one sentence.** A duck moves the head and the arms out of a ball's path; the torso is
 * still hit. That is the whole mechanic, and the two halves of it live here rather than in the two
 * places that act on it — `CollisionGroups` moves the parts, `BallComponent` refuses a contact on
 * them — because a list kept in two files is a list that will disagree with itself, and the failure
 * would be a ball that bounces off a head the game says it missed.
 *
 * **The collision half and the veto are one rule, not two.** A veto alone would leave the ball
 * visibly bouncing off a body the game says it missed: a thrown ball is `CanCollide` and every
 * character collides with the `Ball` group, so the engine is deflecting the ball off the body
 * whatever the contact handler does with velocities. Moving the parts into a group the ball does not
 * collide with is what makes the ball *pass*; refusing the contact that still fires is what stops it
 * being *counted*. Neither is the mechanic on its own.
 *
 * **Why the parts and not a height test.** The limb the engine reports for a part is what the
 * animation actually moves, and it answers for R6, R15 and any rig nobody has written a list for. A
 * height test would need a body line per rig type and would exempt an arm the duck cannot honestly
 * claim to have tucked. See {@link DUCK_EXEMPT_LIMBS} for the set and what it does not cover.
 */

/**
 * The collision group a ducking body's head and arms are moved into, for as long as the duck lasts.
 *
 * **A group rather than a per-ball constraint, and the practice zone is why that is knowable.** The
 * alternative — `CollisionIgnore.between(ball, part)` for every part and every ball in flight — needs
 * a registry of what is in the air, a change to the throw, and cleanup that has to hold the handles
 * it was given (`CollisionIgnore.clear` takes *every* ignore off a part, including the thrower's own
 * and a Pierce ball's, so it cannot be used here). A group is one matrix row: the engine applies it to
 * every ball in the world the instant it is written, and undoing it is writing the group back.
 *
 * **What the group is not allowed to change.** A ducking body still collides with the world, with the
 * midline wall and with props — the only row that says otherwise is the one against
 * {@link BALL_GROUP}, so a duck is a body that balls pass through the head and arms of and nothing
 * else. A ducking body's not colliding with other characters is the general character rule
 * (`Character` against `DuckUpper` and friends, in `CollisionGroups`) rather than anything this group
 * adds. See `CollisionGroups` for where the rows are set, and `PracticePlayer` for the other group
 * this codebase built for the same kind of reason.
 */
export const DUCK_GROUP = "DuckUpper";

/**
 * The group name the row is set against. Duplicated from `CollisionGroups.ts` for the same reason
 * that file duplicates `BALL_TAG`: the constant has to be readable from here without a cycle, and one
 * string two files agree about is a smaller cost than an import graph that loops.
 */
const BALL_GROUP = "Ball";

/**
 * The limbs a duck takes out of a ball's way — **and this is the whole of what a duck covers.**
 *
 * **Head and arms and nothing else, which is a reversal of what the mechanic could have been.** A
 * duck that exempted the torso would be a body that cannot be hit from the waist up, and the ball's
 * own arc is flat enough that almost every throw arrives between the hips and the chest — so that
 * version is not a dodge at all, it is a shield with a cooldown. Exempting head and arms makes the
 * duck a *narrow* read: it beats a ball thrown at the head, it loses to a ball thrown at the chest,
 * and which one is coming is the thing the player is judging.
 *
 * **What it does not cover, stated so nobody has to infer it:** `Torso` (R15's `UpperTorso` and
 * `LowerTorso` both report as `Torso`), every leg, and the `HumanoidRootPart` — which `GetLimb`
 * reports as `Unknown` and which `struckBodyPart` routes to the torso, so a ball into the hips is a
 * torso contact and is **not** exempt. A low ball still hits a ducking body, and that is the point.
 *
 * **Limbs rather than names, and the names are the thing being avoided.** R6 calls an arm `Left Arm`
 * and R15 splits it into `LeftUpperArm`, `LeftLowerArm` and `LeftHand`, so any written list would have
 * to know both and would still miss a rig nobody has seen. `Humanoid.GetLimb` answers for every rig
 * type, which is the same argument `BallComponent.isBodyPart` and `canCatch` each make in their own
 * words. **What this set resolves to, exactly:** three parts on the placeholder R6 rig — `Head`,
 * `Left Arm`, `Right Arm` — and seven on R15 — `Head`, `LeftUpperArm`, `LeftLowerArm`, `LeftHand`,
 * `RightUpperArm`, `RightLowerArm`, `RightHand`. The number is a fact about the rig rather than a list
 * anybody maintains, which is the whole reason the test is the engine's rather than a written one.
 */
export const DUCK_EXEMPT_LIMBS: ReadonlyArray<Enum.Limb> = [
	Enum.Limb.Head,
	Enum.Limb.LeftArm,
	Enum.Limb.RightArm,
];

/**
 * Whether `part` is one of the parts a duck moves — **the question asked of a *resolved* contact.**
 *
 * **The first test is not defensive, it is `GetLimb`'s own contract.** `GetLimb` raises "Part is not a
 * child of Humanoid" for anything deeper, so a hat's `Handle` or a tool's grip would be an error
 * rather than an answer. `BallComponent.isBodyPart` guards the identical way and for the identical
 * reason, and the caller here has already been through `struckBodyPart` — so in practice this is a
 * direct child of the rig and the guard is the cheap half of a promise.
 */
export function isDuckExempt(humanoid: Humanoid, part: BasePart): boolean {
	if (part.Parent !== humanoid.Parent) return false;

	return DUCK_EXEMPT_LIMBS.includes(humanoid.GetLimb(part));
}

/**
 * Every part of `model` a duck has to move, which is the head and the arms of whatever rig it is.
 *
 * **Found by walking the rig rather than by naming the parts**, for {@link DUCK_EXEMPT_LIMBS}'s
 * reason: the caller does not know whether it is holding an R6 or an R15 body and must not have to.
 * The walk is the rig's direct children, which is where limbs live on both rig types — a part nested
 * inside an accessory is not a limb of the body and is deliberately not moved.
 *
 * **A part that does not exist is a miss and not an error**, which is what a walk gives for free: a
 * rig with no arms has fewer parts to move and the duck still works on its head.
 */
export function duckExemptParts(model: Model, humanoid: Humanoid): BasePart[] {
	const parts: BasePart[] = [];

	for (const child of model.GetChildren()) {
		if (!child.IsA("BasePart")) continue;
		if (isDuckExempt(humanoid, child)) parts.push(child);
	}

	return parts;
}

/**
 * Puts `parts` into (or out of) {@link DUCK_GROUP}, remembering what each one was in.
 *
 * **The previous group is returned rather than assumed, and the assumption is the bug this avoids.**
 * Every body part is in `Character` because `CollisionGroups.followCharacters` put it there — but that
 * is a fact about *this* codebase and not about a part, and a rig somebody has arranged differently
 * would be restored into the wrong group by a hard-coded write-back. Returning the map means the
 * caller restores exactly what it found.
 *
 * **`CollectionService` is untouched and the tag list stays honest.** This is a collision-group write
 * and nothing else: no tag is added, no tag is removed, and `TAGS.md` is unchanged by it. Stated
 * because the register counts tags and a reader who finds a new group name should know it is not one.
 */
export function setDuckGroup(parts: ReadonlyArray<BasePart>, group: string): Map<BasePart, string> {
	const previous = new Map<BasePart, string>();

	for (const part of parts) {
		previous.set(part, part.CollisionGroup);
		part.CollisionGroup = group;
	}

	return previous;
}

/**
 * The row that makes the group mean anything, as the one pair of names it is written against.
 *
 * Returned rather than applied because the group registry belongs to `CollisionGroups`, which is the
 * module `main.server.ts` calls before `Flamework.ignite()` — and a shared file that wrote a matrix
 * row would be a second place the matrix lives. This is the *statement* of the row; that file is
 * where it is set.
 */
export function duckGroupRow(): [string, string] {
	return [BALL_GROUP, DUCK_GROUP];
}

/**
 * **What this file deliberately does not do: decide anything about time.**
 *
 * There is no duration here, no cooldown and no notion of a body "being ducking". All three live in
 * `DuckService`, for the reason `shared/dodge.ts` gives about the dodge: this is the *vocabulary* —
 * which limbs, which group, which row — and the things that hold a stopwatch are the things that own a
 * state. A shared file with a timer in it would be a second opinion about when a duck has ended.
 */
