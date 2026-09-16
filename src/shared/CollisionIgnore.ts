/**
 * Stops one part from colliding with another, for as long as it exists.
 *
 * Roblox only collides two parts when both are solid, so the usual way to make
 * something intangible is `CanCollide = false` — but that makes it intangible
 * to *everything*. This disables a single pairing instead, which is what a
 * projectile wants: solid against the world and everyone else, but passing
 * straight through the person who threw it.
 *
 * Each pairing needs its own `NoCollisionConstraint` — there is no way to say
 * "ignore this whole model" — so this builds one per `BasePart` for you.
 * Constraints are parented to `part`, so destroying that part cleans them up.
 */
export class CollisionIgnore {
	/**
	 * Makes `part` pass through `against` and everything inside it.
	 *
	 * The returned handle can be used to undo this early, but you don't have to
	 * keep it — the constraints die along with `part`.
	 */
	public static between(part: BasePart, against: Instance): CollisionIgnore {
		return new CollisionIgnore(part, against);
	}

	private readonly constraints: NoCollisionConstraint[] = [];

	private constructor(part: BasePart, against: Instance) {
		// `against` might be the part itself, in which case there is no subtree.
		if (against.IsA("BasePart")) {
			this.constraints.push(CollisionIgnore.link(part, against));
		}

		for (const descendant of against.GetDescendants()) {
			if (!descendant.IsA("BasePart")) continue;
			this.constraints.push(CollisionIgnore.link(part, descendant));
		}
	}

	/** Re-enables collision between the two, undoing the ignore. */
	public destroy(): void {
		for (const constraint of this.constraints) {
			constraint.Destroy();
		}
		this.constraints.clear();
	}

	private static link(part: BasePart, target: BasePart): NoCollisionConstraint {
		const constraint = new Instance("NoCollisionConstraint");
		constraint.Name = "CollisionIgnore";
		constraint.Part0 = part;
		constraint.Part1 = target;
		constraint.Enabled = true;
		constraint.Parent = part;
		return constraint;
	}
}
