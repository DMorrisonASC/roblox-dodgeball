/**
 * The vocabulary of dodging, shared by both sides.
 *
 * Nothing here knows about `Player` — a dodge is a *model* moving, and a player's
 * character is just the most common model that happens to have a humanoid.
 * Keeping the resolution and the liveness check here means the server can dodge
 * an NPC through the same entry point it uses for a character.
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
 * Whether this entity is in a state to dodge: a dodge is a humanoid's move, so a
 * model without one cannot dodge, and one whose humanoid has died cannot either.
 */
export function canDodge(entity: Dodgeable): boolean {
	if (!entity.humanoid) return false;
	return entity.humanoid.Health > 0;
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

/**
 * Which way a dash went, **relative to the body that took it** — the four words the dodge clips are
 * named by.
 *
 * **This is the vocabulary of the dodge animation, and it is here because both machines need the same
 * four strings.** The server decides which way a dash went and publishes it; the renderer reads that
 * and picks a clip. Two spellings of these four words would be a dodge that plays the wrong direction
 * for no reason anybody could see in the code, so they are spelled once, in the file that already owns
 * "what a dodge is" (`canDodge`, `flattenToGround`, `resolveDodgeable`).
 *
 * **The rule: the direction is classified in the frame the decision was made in, and `reference` is that
 * frame's forward.** For a player the direction is *input* — a key, read through the camera — so the
 * reference is the camera's heading and the key decides: `W` is a forward dodge, `S` a backward one, `A`
 * left, `D` right, wherever the body happens to be pointing. For a rig the direction is *motion*, chosen
 * by its AI against the thing it is dodging, so the reference is the rig's own facing and the clip matches
 * the step the body actually takes.
 *
 * **The player's half of that is a reversal, and the reason is that the body does not hold still.** The
 * earlier version classified a player's dodge against the *body's* facing, on the argument that a step
 * should read relative to the body taking it. That argument assumes the facing is something the player
 * set, and it is not: `UserGameSettings.RotationType` is `MovementRelative`, so the body continuously
 * turns to face wherever it is moving. Pressing `S` therefore *starts a turn*, and by the time the dodge
 * is asked for the body may already be facing the way it is about to move — which classifies as
 * `forward`. A player pressed the key for a backward dodge and got the forward clip, and — worse — got a
 * different clip depending on how long they held the key before clicking. Measuring in the camera's frame
 * instead means the answer is the key's own meaning, which is the one thing a player can predict: the
 * same press is the same clip every time, and it stays the same clip while the body turns under it.
 *
 * **World space in, and the reference is a direction rather than a frame.** `reference` is that frame's
 * forward — for a player, where the camera is looking; for a rig, where the body is looking — so the
 * caller needs nothing but a direction it can already read, and a *client* can hand its own over without
 * reconstructing a matrix for the server to rotate a vector by. The arithmetic below is that rotation,
 * written out: `right` is the frame's right axis and `along` its forward amount, and for a forward of
 * `-Z` the pair is `(direction · right, -direction · forward)`, which is exactly what
 * `CFrame.VectorToObjectSpace` returns for the equivalent frame.
 *
 * **`-Z` is forward, which is Roblox's own convention and not a choice made here.** A `CFrame`'s
 * `LookVector` is its negative `Z` axis and its `RightVector` is its positive `X` — declared as
 * `readonly LookVector: Vector3` and `readonly RightVector: Vector3` in the engine's own typings — and
 * the right axis is `LookVector × up`, which for `(0, 0, -1) × (0, 1, 0)` is `(1, 0, 0)`: the same
 * `RightVector` the engine reports for that frame. So a dodge along the reference lands on a negative
 * `along`, one against it on a positive `along`, and the sign of the sideways part is left or right.
 *
 * **Horizontal wins, and that is the rule rather than a tie-break.** A direction with any *dominant*
 * sideways part takes the left or right clip — `S+D` is a right dodge and `W+A` is a left one — and only
 * a direction whose forward/backward part dominates takes the forward or backward clip. The comparison is
 * `>=`, so the exactly-diagonal case (45°, which is what a two-key diagonal lands on) resolves
 * horizontally as well. That is the user's `S+D` case, and it is the case this rule was written for.
 *
 * **The threshold is the dominant axis and not "any sideways part at all", and the log is why.** These
 * directions come off a keyboard through a camera, and they are not clean: the log shows a press of
 * nothing but `S` arriving as `(0.0094, 0, -0.99996)`, because the camera had drifted a fraction off the
 * body's axis. Under "any `X` means sideways" that dodge — a plain backward dodge, on screen and in the
 * player's hands — would play the *right* clip. Under the dominant-axis rule the 0.0094 is compared
 * against 0.99996 and loses, and a real diagonal wins by construction: `W+D` puts the same weight on both
 * axes and takes the side. A lopsided diagonal that is mostly forward stays forward, which is also the
 * honest reading of a player who pressed `W` and clipped `D` on the way.
 *
 * **Either argument having no horizontal part has no direction to name**, and `forward` is the one answer
 * here that is invented rather than measured. A direction always has one by the time this is called — both
 * callers flatten it and refuse it otherwise (see `flattenToGround`, and the second guard in
 * `DodgeService.startDash`) — so the direction half of that is unreachable. The reference half is not: a
 * body looking straight up a wall has no horizontal facing, and the fallback keeps this function total
 * rather than making every caller guard a case it cannot describe either. Forward is the reference's own
 * axis, which reads as "along the frame" rather than as a side the frame is not on.
 *
 * **For a rig, the reference has to be read before the dash turns the body, and that is the caller's
 * contract.** A dash aligns the body to face the direction it travels — see `DodgeService.startDash` — so
 * a rig's facing read *after* that turn classifies every dash as `forward`: a function that looks like it
 * decides and never does. A player's reference is the camera, which the dash does not touch, so that half
 * of the contract is the rig's alone.
 */
export function dodgeDirectionOf(direction: Vector3, reference: Vector3): DodgeDirection {
	// Named `front` rather than the shorter thing a reader expects: `local` is a reserved word in Luau,
	// so it is a hard error here rather than a style choice.
	const front = flattenToGround(reference);
	if (front === undefined) return "forward";

	// The frame's right axis, built from its forward rather than crossed from the direction — the
	// direction is the thing being measured, so it cannot also be the thing measuring. `forward × up` is
	// the axis the engine reports as `RightVector`; see the doc above for the worked case.
	const right = front.Cross(Vector3.yAxis);

	const sideways = direction.Dot(right);
	const along = -direction.Dot(front);

	if (sideways === 0 && along === 0) return "forward";

	if (math.abs(sideways) >= math.abs(along)) return sideways >= 0 ? "right" : "left";

	return along < 0 ? "forward" : "backward";
}

/** Which way a dashing body went, from that body's own point of view. See {@link dodgeDirectionOf}. */
export type DodgeDirection = "forward" | "backward" | "left" | "right";
