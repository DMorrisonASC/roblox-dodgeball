import { CollectionService, Players, ReplicatedStorage, Workspace } from "@rbxts/services";
import { BALL_NAME, ROUND_STATE_ATTRIBUTE, ROUND_STATUS_FOLDER, TEAM_ATTRIBUTE } from "shared/constants";
import { NPC_CONFIG } from "shared/config/npc.config";
import { resolveDodgeable } from "shared/dodge";
import type { BallService } from "../services/ball/BallService";
import { TEAM_A, TEAM_B, TeamLabel } from "../services/round/team";
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
 * **Which side a body is on, read from wherever that side actually lives.**
 *
 * A side is `TEAM_ATTRIBUTE`, and it is written in two different places depending on what the body is:
 * `RoundService.assignTeams` writes it on the **`Player`**, because the roster is player-keyed and a
 * character is replaced on every death; `LobbyRigService` writes it on the **rig**, because a rig *is*
 * the body. So a reader has to ask the right one or it is asking nobody — and the old comparison asked
 * the model in both cases, which meant every player's character read as side-less and therefore, under a
 * "not equal" test, as an enemy of every rig, teammate or not.
 *
 * **`GetPlayerFromCharacter` is the whole of the test, and it is nullable.** Verified in the installed
 * typings (`@rbxts/types/include/generated/None.d.ts`):
 * `GetPlayerFromCharacter(this: Players, character: Instance | undefined): Player | undefined` — so
 * `undefined` means "this model is not a player's character", which for this file means it is a rig, and
 * the model's own attribute is the answer.
 *
 * **One helper rather than two branches at each call site**, because it is the same question in both
 * places: the rig asking is a model and each candidate is a model, and "what side is this body on" does
 * not have two answers depending on which end of the comparison you are standing at. Writing the branch
 * twice would be two places to fix the next time a third kind of body can hold a side.
 *
 * **Validated rather than trusted**, for `sideOfRig`'s reason in `npc/rigs.ts`: a string attribute
 * anybody can write is not a side until it reads as one. The comparison's outcome is unchanged by the
 * check — an invalid label was never equal to a valid one — but what comes back is a `TeamLabel` or
 * nothing, which is a thing the caller can act on rather than a value it has to keep re-asking about.
 */
function sideOf(model: Model): TeamLabel | undefined {
	const player = Players.GetPlayerFromCharacter(model);
	const label = player !== undefined ? player.GetAttribute(TEAM_ATTRIBUTE) : model.GetAttribute(TEAM_ATTRIBUTE);

	if (label === TEAM_A || label === TEAM_B) return label;

	return undefined;
}

/**
 * The nearest opposing model to `rig`, or `undefined`.
 *
 * **What an "enemy" is, stated plainly, because the rule is one comparison and the two sides are read
 * from two different places.** A candidate is an enemy when its side is **not equal** to the rig's side —
 * a player's character's side coming from its `Player`, a rig's from the rig itself, and a body with no
 * side at all reading as `undefined`. See {@link sideOf}. The four consequences, which are the whole
 * design:
 *
 * - **A rig on a side sees players on the other side, and only those.** A rig on `A` does not throw at a
 *   player on `A`, which is the rule the game is for and which the previous comparison got wrong.
 * - **A rig on a side sees rigs on the other side**, because a rig's side is on the rig — so two
 *   placeholders on opposite sides fight each other, which is what a rig-versus-rig round is.
 * - **A body with no side is an enemy of every rig that has one**, because `undefined !== "A"` is true.
 *   That covers a player standing in the lobby who has not opted in, and a rig that lost its side. It is
 *   the comparison's honest answer rather than a rule anybody chose: "not on my side" is all this asks,
 *   and a caller that wants side-less bodies skipped is asking a *different* question — "is this a
 *   participant" — which is `npc/rigs.ts`'s question and is asked there.
 * - **A rig with no side of its own** sees every team-bearing rig as an enemy and every player as a
 *   friend, because `undefined` equals `undefined`. Nothing in this game is in that state during a round:
 *   a placeholder takes its side when it reaches its pad and keeps it, and the behaviours that call this
 *   are only ever worn by a rig that holds one.
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

	const rigTeam = sideOf(rig);

	let found: EnemySighting | undefined;
	let bestDistance = math.huge;

	const consider = (candidate: Model): void => {
		if (candidate === rig) return;

		// **The side test, before any arithmetic.** A candidate on the same side — which is a rig on the
		// same side, or a player on the same side, both resolved by `sideOf` — is not an enemy, and is
		// dropped here rather than being measured and then discarded. Everything on the other side is,
		// and a body with no side is too: see the note above for why that is the comparison's answer.
		if (sideOf(candidate) === rigTeam) return;

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
