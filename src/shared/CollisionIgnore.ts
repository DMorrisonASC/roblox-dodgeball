/**
 * The name every constraint this class makes carries.
 *
 * A constant rather than a literal in one place and a second one somewhere else: {@link
 * CollisionIgnore.clear} has to recognise what {@link CollisionIgnore.link} made, and the alternative
 * is a string two files have to agree about — the arrangement `BALL_TAG` documents at length and
 * complains about in the same breath.
 */
const CONSTRAINT_NAME = "CollisionIgnore";

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

	/**
	 * Takes every ignore this class has put on `part` back off again.
	 *
	 * **The bulk counterpart to {@link CollisionIgnore.destroy}, and it exists because the lifetime
	 * above is longer than it looks.** "They die along with `part`" is true and is the right lifetime
	 * for a *part*; it is the wrong one for a **throw**, because a projectile usually outlives its
	 * flight. A ball that has landed is not destroyed — it lies where it stopped until it expires or
	 * somebody collects it — so every constraint on it is about a throw that is already over by the
	 * time anything else happens to it.
	 *
	 * So a caller that knows the ignoring is finished with calls this, and it is the caller's judgement
	 * rather than a rule here: this class cannot know that a ball is now in somebody's hand.
	 *
	 * **Filtered on the name as well as the class, on purpose.** A `NoCollisionConstraint` on this part
	 * that somebody else added for their own reason is not this class's to remove, and a bare "destroy
	 * every constraint of this type" would be a method that quietly reaches outside its own business.
	 */
	public static clear(part: BasePart): void {
		for (const child of part.GetChildren()) {
			if (child.IsA("NoCollisionConstraint") && child.Name === CONSTRAINT_NAME) child.Destroy();
		}
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
		constraint.Name = CONSTRAINT_NAME;
		constraint.Part0 = part;
		constraint.Part1 = target;
		constraint.Enabled = true;
		constraint.Parent = part;
		return constraint;
	}
}
