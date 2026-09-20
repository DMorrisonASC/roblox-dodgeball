/**
 * The vocabulary of dodging, shared by both sides.
 *
 * Nothing here knows about `Player` or `Humanoid` being present — a dodge is a
 * *model* moving, and a player's character is just the most common model that
 * happens to have a humanoid. Keeping the resolution and the liveness check here
 * means the server can dodge an NPC rig or a bare model through the same entry
 * point it uses for a character.
 */

/** A model that can be dodged, with the part that does the moving. */
export interface Dodgeable {
	model: Model;
	/** The part whose position is the model's position. */
	root: BasePart;
	/** Absent for bare models and rigs without a humanoid. */
	humanoid?: Humanoid;
}

/**
 * Resolves a model to something dodgeable, or `undefined` if it has no part to
 * move.
 *
 * The root is looked for in the order that gives the best answer first:
 * `HumanoidRootPart` (the rig's true centre, and the part a character's
 * replication follows), then the model's declared `PrimaryPart`, then the first
 * `BasePart` child — which is all a bare model has to offer.
 */
export function resolveDodgeable(model: Model): Dodgeable | undefined {
	const root = findRoot(model);
	if (!root) return undefined;

	return { model, root, humanoid: model.FindFirstChildWhichIsA("Humanoid") };
}

/**
 * Whether this entity is in a state to dodge: no humanoid means nothing to kill,
 * so it always can; a humanoid has to still be alive.
 */
export function canDodge(entity: Dodgeable): boolean {
	return entity.humanoid === undefined || entity.humanoid.Health > 0;
}

/** Below this, a direction has no horizontal part worth normalizing. */
const FLAT_EPSILON = 0.001;

/**
 * The horizontal part of `direction`, normalized — or `undefined` if it has none.
 *
 * A dodge is a ground move, so the vertical component is *dropped* rather than
 * scaled: a camera aimed at the floor still dodges along the floor. Dropping it
 * can leave nothing at all — a request straight up or straight down — and there
 * is no direction to normalize there, so it is refused rather than allowed to
 * become a zero vector and a `Unit` of `nan`.
 *
 * Shared so both sides agree on what a direction means: the client flattens the
 * camera's heading with this, and the server flattens what arrived with the same
 * function.
 */
export function flattenToGround(direction: Vector3): Vector3 | undefined {
	const flat = new Vector3(direction.X, 0, direction.Z);

	return flat.Magnitude < FLAT_EPSILON ? undefined : flat.Unit;
}

function findRoot(model: Model): BasePart | undefined {
	const humanoidRoot = model.FindFirstChild("HumanoidRootPart");
	if (humanoidRoot && humanoidRoot.IsA("BasePart")) return humanoidRoot;

	const primary = model.PrimaryPart;
	if (primary) return primary;

	for (const child of model.GetChildren()) {
		if (child.IsA("BasePart")) return child;
	}

	return undefined;
}
