import { CollectionService, Players, ReplicatedStorage, Workspace } from "@rbxts/services";
import { BALL_NAME, ROUND_STATE_ATTRIBUTE, ROUND_STATUS_FOLDER, TEAM_ATTRIBUTE } from "shared/constants";
import { NPC_CONFIG } from "shared/config/npc.config";
import { resolveDodgeable } from "shared/dodge";
import type { BallService } from "../services/ball/BallService";
import { NPC_TAG } from "./Behavior";

/**
 * The two questions a rig asks about the world around it: **where is my enemy**, and **is a ball
 * coming at me**. Both are answered here rather than inside a behaviour, because neither is about
 * throwing or catching — the user's own framing is that facing is a *prerequisite* of an action, not
 * a part of one, and the same is true of "is there a ball in my radius". A behaviour that wants
 * either asks this module; nothing here knows what the caller intends to do with the answer.
 *
 * **What this deliberately is not: a behaviour, or a tag.** There is no `Behavior_Detect`, nothing
 * wears a tag to switch it on, and `NpcService` does not know this file exists. It is a plain
 * function over a model, in the same spirit as `resolveDodgeable` — a question with one answer,
 * shared so two callers cannot come to two answers about the same rig.
 *
 * **Read on the server alone.** It reads `Players`, `CollectionService` and the round's published
 * phase, none of which a rig has a client-side reason to know. See `RigAnimationController` for the
 * one thing a client does with a rig, which is animate it from the attributes `NpcService` publishes.
 */

/**
 * The phase name a round is played under.
 *
 * A word between two files, kept local for the reason every other reader of this attribute keeps
 * its own copy: the *name* is published as text and there is nothing importable to agree on. It is
 * the same literal `BallSpawnerService`, `MatchService` and `DodgeService` each spell for
 * themselves, and `roundStatus.ts` is where the round writes it.
 */
const PLAYING = "Playing";

/**
 * The attribute that makes a ball dangerous.
 *
 * **Spelled the way its owner spells it.** `BallService` and `BallComponent` write `"Armed"` as a
 * literal rather than importing it, so this is one more copy of a name several files have to agree
 * on — the same copy, for the same reason, that `DodgeBehavior` keeps. A ball is a threat only while
 * this is `true`: it goes on when a ball is handed out or thrown and comes off when it lands, which
 * is why a ball rolling across the floor can be walked over.
 */
const ARMED_ATTRIBUTE = "Armed";

/** Below this, a horizontal direction has no heading worth an angle. */
const FLAT_EPSILON = 0.001;

/**
 * What {@link detectEnemy} found: the opposing model, how far off the rig's nose it is, and where a
 * throw at it would aim.
 *
 * **The angle is the whole point of the type, and the `aimPoint` is here so a caller does not have
 * to resolve the same model twice.** A caller deciding whether to throw wants to know *in front of
 * me?* before it wants a position; a caller that has decided wants a point to land on. Both are
 * computed from data this function already has in hand — the model's root — so returning them
 * together saves the second lookup and, more importantly, keeps the angle and the point describing
 * the *same instant* of the same body.
 */
export interface EnemySighting {
	/** The opposing model this sighting is about. Never the rig that asked. */
	readonly model: Model;

	/**
	 * Signed horizontal angle from the rig's forward direction to the sighting, in **radians**:
	 * `0` is dead ahead, negative is to the rig's left, positive to its right.
	 *
	 * **Horizontal only, and that is the requirement rather than a simplification.** Both positions
	 * are projected onto the ground plane before the angle is taken, so a model on a hill in front of
	 * the rig reads as straight ahead and not as tilted away. Facing is about which way a body is
	 * turned; a body has no pitch to speak of, so neither does this number.
	 */
	readonly angle: number;

	/** Horizontal distance to the sighting, in studs. Equal to the length of the flat offset. */
	readonly distance: number;

	/** The sighting's root position — the point a throw aimed at this model should land on. */
	readonly aimPoint: Vector3;
}

/**
 * Whether a round is being played, read from the round's own published phase.
 *
 * **The round is asked, not reproduced.** `RoundService.isFriendlyFire` answers the same question by
 * reading its own private `state`; a helper has no service to ask, and *copying* the round's state
 * into this file is the one thing that must not happen — two answers to "is a round on" is the bug
 * this module exists to avoid. So it reads the channel every other round-aware reader already reads:
 * the `RoundStatus` folder in `ReplicatedStorage`, which replicates the phase as an attribute. That
 * is exactly what `SuperService.isRoundActive` and `StatsService.isRoundActive` do, and it means this
 * file needs no injection and no reference to `RoundService`.
 *
 * A folder that is not there yet — the first moments of a server's life — reads as "not a round",
 * which is the same answer every other reader gives it.
 */
function isRoundPlaying(): boolean {
	const folder = ReplicatedStorage.FindFirstChild(ROUND_STATUS_FOLDER);
	if (!folder) return false;

	return folder.GetAttribute(ROUND_STATE_ATTRIBUTE) === PLAYING;
}

/**
 * The nearest opposing model to `rig`, or `undefined`.
 *
 * **What an "enemy" is, stated plainly, because the answer is not what the name suggests.** The rule
 * is "a model that is not on the same team", read as `candidateTeam !== rigTeam`. A **rig carries no
 * team**: `RoundService.assignTeams` fills its map from `MatchService.roster()`, which is
 * `Player`-keyed, and writes `TEAM_ATTRIBUTE` on players alone — so a rig's team is `undefined`, and
 * under an equality test that is the same "team" as every other rig's and as every model outside a
 * round. The consequences fall out of that one comparison and are the whole design:
 *
 * - **A rig's enemies are the players who have a side.** A player in the round wears `"A"` or `"B"`,
 *   which is not `undefined`, so they are an enemy of the rig.
 * - **Two rigs are never enemies of each other.** Both teams are `undefined`, so they are "the same
 *   side" — which is what a game where rigs are training dummies and players are the opposition
 *   wants, and is worth knowing before anybody tries to make two rigs fight.
 * - **A model with no team is nobody's enemy.** A player in the lobby, or one who joined mid-round
 *   and has no side, is `undefined` too, and so is skipped. "Not on the same team" is only a
 *   meaningful question of a model that *has* a team.
 *
 * **Outside a round it is silent**, which is the user's own rule ("not functioning outside of a
 * round") and the reason for {@link isRoundPlaying}: with no round there are no sides, so every
 * comparison would be `undefined !== undefined` and the honest answer is that there is no enemy.
 *
 * **The candidate set is the codebase's own two lists**, exactly as `BallService.pierceBodies`
 * enumerates bodies: every player's character, and every `NPC`-tagged model. It is deliberately not
 * "everything in `Workspace` with a humanoid", because that would pick up a rig parked in a
 * `ServerStorage` template — the same out-of-world trap `TAGS.md` records for three other readers —
 * and because the two lists are what "a body that could be on a side" actually is.
 *
 * **The nearest, by flat distance.** A caller that wants a *different* one (the one in front, the one
 * with a ball) is a change to this function, and the angle it returns is the thing that makes such a
 * rule writable without a second scan.
 */
export function detectEnemy(rig: Model): EnemySighting | undefined {
	if (!isRoundPlaying()) return undefined;

	const rigBody = resolveDodgeable(rig);
	if (!rigBody) return undefined;

	const rigTeam = rig.GetAttribute(TEAM_ATTRIBUTE);

	let found: EnemySighting | undefined;
	let bestDistance = math.huge;

	const consider = (candidate: Model): void => {
		if (candidate === rig) return;

		// **The side test, before any arithmetic.** A candidate on the same team — which includes
		// every other rig, see the note above — is not an enemy, and is dropped here rather than
		// being measured and then discarded.
		if (candidate.GetAttribute(TEAM_ATTRIBUTE) === rigTeam) return;

		const other = resolveDodgeable(candidate);
		if (!other) return;

		// The flat offset from the rig to the candidate: the Y is dropped rather than scaled, so a
		// candidate below or above the rig is measured across the ground as a facing question must
		// be. See `EnemySighting.angle`.
		const offset = new Vector3(
			other.root.Position.X - rigBody.root.Position.X,
			0,
			other.root.Position.Z - rigBody.root.Position.Z,
		);

		const distance = offset.Magnitude;
		if (distance > bestDistance) return;

		const forward = new Vector3(rigBody.root.CFrame.LookVector.X, 0, rigBody.root.CFrame.LookVector.Z);
		if (forward.Magnitude < FLAT_EPSILON || distance < FLAT_EPSILON) return;

		// **The signed angle, from `atan2` rather than a `Cross` product.** For two vectors in the
		// `XZ` plane, `atan2(forward × offset, forward · offset)` is exact, and writing the cross
		// product's Y component by hand keeps the sign convention in one line a reader can check:
		// `forward.X * offset.Z - forward.Z * offset.X` is positive when the offset is to the rig's
		// *right*, so `0` is ahead, negative is left and positive is right with no further fiddling.
		// Neither vector is normalized — `atan2` does not care about scale, so normalizing would be
		// one more place to divide by a magnitude that the `FLAT_EPSILON` guard has already refused
		// to let be zero.
		const angle = math.atan2(
			forward.X * offset.Z - forward.Z * offset.X,
			forward.X * offset.X + forward.Z * offset.Z,
		);

		bestDistance = distance;
		found = { model: candidate, angle, distance, aimPoint: other.root.Position };
	};

	for (const player of Players.GetPlayers()) {
		const character = player.Character;
		if (character) consider(character);
	}

	for (const instance of CollectionService.GetTagged(NPC_TAG)) {
		if (instance.IsA("Model")) consider(instance);
	}

	return found;
}

/**
 * The nearest **armed, loose** ball within a rig's detection radius, or `undefined`.
 *
 * **A proximity question, deliberately not the dodge's closest-approach solve.** `DodgeBehavior`
 * asks "will this ball *hit* me", which is a piece of trajectory arithmetic and answers a question
 * about a specific incoming throw. This asks the coarser question the user described — "is a ball in
 * my radius of detection" — which is the right gate for *raising your hands*: a catcher reacts to a
 * ball being near, and a ball that is near but will miss is still worth being ready for. Keeping the
 * two questions separate is why this is a second function rather than a parameter on the first.
 *
 * **Only armed balls count.** `Armed` is what makes a ball a throw — see {@link ARMED_ATTRIBUTE} —
 * so a ball that has landed and is being walked past is not something to react to. Held balls are
 * excluded through `BallService.isHeld`, the same service call `DodgeBehavior` makes, because a ball
 * welded into somebody's hand travels with them and is not an incoming throw.
 *
 * **A ball in the world is a direct child of `Workspace`** — that is where a throw parents it — so
 * the scan is `Workspace.GetChildren()` and not a `GetDescendants` over the whole arena, which is
 * the same shallow walk `DodgeBehavior` documents and pays for the same reason. The radius is
 * {@link NPC_CONFIG.DETECTION_RADIUS}; the check is flat, so a ball directly overhead inside the
 * radius is still found.
 */
export function detectThreat(rig: Model, balls: BallService): BasePart | undefined {
	const rigBody = resolveDodgeable(rig);
	if (!rigBody) return undefined;

	const origin = rigBody.root.Position;
	const radius = NPC_CONFIG.DETECTION_RADIUS;

	let nearest: BasePart | undefined;
	let bestDistance = math.huge;

	for (const child of Workspace.GetChildren()) {
		if (child.Name !== BALL_NAME || !child.IsA("BasePart")) continue;
		if (child.GetAttribute(ARMED_ATTRIBUTE) !== true) continue;
		if (balls.isHeld(child)) continue;

		const offset = new Vector3(child.Position.X - origin.X, 0, child.Position.Z - origin.Z);
		const distance = offset.Magnitude;
		if (distance > radius || distance >= bestDistance) continue;

		bestDistance = distance;
		nearest = child;
	}

	return nearest;
}
