import { CollectionService, ReplicatedStorage, Workspace } from "@rbxts/services";
import { RIG_TEAM_ATTRIBUTE, ROUND_STATE_ATTRIBUTE, ROUND_STATUS_FOLDER } from "shared/constants";
import { ThrowArc } from "shared/Trajectory";
import { resolveDodgeable } from "shared/dodge";
import { BEHAVIOR_THROWING, NPC_TAG, NpcBehavior } from "../Behavior";
import type { BallService } from "../../services/ball/BallService";

/**
 * The phase `RoundService` publishes while a match is being played.
 *
 * **The word is written out here rather than imported, and that is the project's own convention for a
 * phase** — see `TAGS.md`'s list of the strings two files have to agree on, where `"Playing"` is spelled
 * in five server files and six client ones. `RoundState` is an enum inside `RoundService`, and a behaviour
 * that imported the service to read one member would be the dependency the status folder exists to avoid:
 * the phase is a fact on `ReplicatedStorage`, and a reader of it needs the folder and not the round.
 */
const PLAYING = "Playing";

/**
 * How far from the rig a body may be and still be considered as a target, in studs.
 *
 * **This is the *detection* radius now, not an aim distance.** The behavior used to solve a throw at a
 * point `THROW_RANGE` studs straight in front of the rig's nose, which is what "there is no target, only a
 * direction" looked like; the point in front of the nose is gone, and this is the range the rig searches
 * for somebody to throw at. It is deliberately longer than any throw needs to be — a `straight` arc on a
 * rig's arm reaches further than this — so the range is about *who the rig notices*, not about how hard it
 * can throw. See `BallService.throwBall` for the reach itself, which is the ball's business.
 *
 * **Placeholder — 60.**
 */
const THROW_RANGE = 60;

/**
 * The half-angle of the cone in front of the rig a target has to be inside to be noticed, in degrees —
 * `0` is looking straight at the target, and this is the limit either side of that.
 *
 * **±120° is 240° of coverage with a 120° blind spot directly behind the rig**, which is very wide: the rig
 * finds somebody on almost any side of it and the "look first" step is then a small rotation rather than a
 * turn. **This is the width the task specified and it is deliberately not a knob turned here** — the report
 * argues that it should be narrowed (something like ±60° would make the facing a real, readable turn and
 * stop a rig from throwing at somebody it never appeared to look at), but that is a change to ask for, not
 * one to make silently.
 */
const DETECTION_ARC_DEGREES = 120;

/**
 * How long the rig holds its aim at a body before the ball actually leaves its hand, in seconds.
 *
 * **This is the whole of the telegraph, and it exists because a turn with no pause behind it reads as
 * nothing.** The facing itself is one `CFrame` write — see the tick — so without this delay the rig would
 * be looking at its victim and throwing in the same frame, and the player on the other end would see a ball
 * appear with no warning. Holding the aim for a beat gives the turn something to be seen *as*: the rig
 * faces you, and a moment later the ball comes. It is the cheapest observable tell there is — one
 * `task.delay` and no animation, no particles and no second body — and it is exactly the kind of number
 * that wants a Studio look before it is trusted.
 *
 * **Placeholder — 0.5.**
 */
const AIM_DELAY_SECONDS = 0.5;

/**
 * Which arc an NPC throws. Straight is the plain default; a real aim is what would choose.
 *
 * **A rig is the only thing in the game that still names an arc.** A player's throw is charged — a heading
 * and a hold, with no point in it at all — so `overhead`, `straight` and `curve` survive here, where there
 * really is a target and a choice of how to reach it. This constant is therefore the whole of what selects
 * between them, which makes it the line to change if a rig should arc a ball instead of driving it.
 */
const THROW_ARC: ThrowArc = "straight";

/** The round's status folder, or nothing before `RoundService` has made it. */
function statusFolder(): Instance | undefined {
	return ReplicatedStorage.FindFirstChild(ROUND_STATUS_FOLDER);
}

/**
 * Whether a match is being played.
 *
 * **The round gate, and the check that did not exist before this change.** The behavior used to run
 * whenever its tag was on the rig and the rig was in the world — which meant a rig threw balls around the
 * lobby between rounds and inside a practice zone, wherever one happened to be standing. Asking the phase
 * is the whole fix, and it is asked of the status folder rather than of `RoundService` for the reason the
 * constant above gives: nothing here needs the round, only what the round is publishing.
 */
function isPlaying(): boolean {
	return statusFolder()?.GetAttribute(ROUND_STATE_ATTRIBUTE) === PLAYING;
}

/**
 * The side `model` fights for, or nothing if it has none.
 *
 * **Read from the rig's own model, and deliberately not from a `Player`** — a rig has no player, which is
 * the whole reason `RIG_TEAM_ATTRIBUTE` exists. The value is validated rather than trusted: an attribute
 * set by hand in Studio's attribute editor could hold any string at all, and a typo there would otherwise
 * read as a side that matches nobody and quietly stop the rig throwing. A value that is not `A` or `B` is
 * read as "no side", which is the same answer an absent attribute gets.
 */
function sideOf(model: Model): string | undefined {
	const side = model.GetAttribute(RIG_TEAM_ATTRIBUTE);

	return side === "A" || side === "B" ? side : undefined;
}

/**
 * The nearest rig this one may throw at, or nothing.
 *
 * **"Enemy" means a rig on the other side, and only a rig.** The test is `sideOf` on the target against
 * `sideOf` on the thrower, so a rig with no side has no enemies and throws at nobody — which is the honest
 * reading of a side-less rig, and the reason the round gate alone is not enough to stop a rig throwing in
 * the lobby. A *player* is deliberately not a candidate: the rig side is `RIG_TEAM_ATTRIBUTE` and a player's
 * is `TEAM_ATTRIBUTE`, and comparing the two would mean this behaviour reading the player side too — a
 * second source of truth for one question, which is what having a rig key at all is meant to avoid. A rig
 * therefore fights rigs; a player fights everybody, by the round's own `isFriendlyFire`.
 *
 * **Two filters beyond the side, and both are the geometry of a throw rather than a rule.** The target has
 * to be inside `THROW_RANGE` — a rig does not lob a ball across the map at a body it can barely see — and
 * inside the detection cone, measured from the rig's own `HumanoidRootPart.CFrame.LookVector`. The cone is
 * what makes the rig's facing mean something: a target behind the rig is not noticed at all, and the "look
 * first" step only ever turns the rig onto somebody it could already all-but see.
 *
 * **The root part is taken through `resolveDodgeable`,** the same helper a dodge, a catch and the seeking
 * behavior ask the same question through, so "where is this rig and which way is it facing" has one answer
 * in the project rather than a name in each file.
 *
 * **The cone is a dot-product comparison and not an angle**, which is why `DETECTION_ARC_DEGREES` is turned
 * into a cosine once, outside the loop: `forward:Dot(toTarget) >= cos(arc)` is the same test as
 * `angle <= arc` and costs no `acos` per candidate. The comparison is the reason the loop skips a target
 * sitting on top of the rig as well — a body at zero distance has no direction to normalize, and that is
 * guarded for explicitly rather than left to produce a `nan` that every comparison quietly reads as false.
 */
function nearestEnemy(model: Model, root: BasePart, side: string): { readonly model: Model; readonly position: Vector3 } | undefined {
	const forward = root.CFrame.LookVector;
	// Precomputed once, rather than a `math.cos` per candidate: the threshold is the same for all of them.
	const minimumDot = math.cos(math.rad(DETECTION_ARC_DEGREES));

	let best: { model: Model; position: Vector3 } | undefined;
	let bestDistance = math.huge;

	for (const instance of CollectionService.GetTagged(NPC_TAG)) {
		if (instance === model || !instance.IsA("Model")) continue;

		// **A rig outside the world is not a target**, which is the same rule the tag rank and file keep
		// (`taggedParts`' doc collects the three bugs it was written for). A rig parked in a `ServerStorage`
		// template wears `NPC` exactly as the rigs in the arena do, and a throw at one would be a throw at
		// coordinates nobody can see.
		if (!instance.IsDescendantOf(Workspace)) continue;

		const targetSide = sideOf(instance);
		if (targetSide === undefined || targetSide === side) continue;

		const humanoid = instance.FindFirstChildWhichIsA("Humanoid");
		if (!humanoid || humanoid.Health <= 0) continue;

		const targetRoot = resolveDodgeable(instance)?.root;
		if (!targetRoot) continue;

		const position = targetRoot.Position;
		const distance = position.sub(root.Position).Magnitude;
		if (distance > THROW_RANGE || distance >= bestDistance) continue;

		const direction = position.sub(root.Position);
		if (direction.Magnitude < 0.001) continue;

		if (forward.Dot(direction.Unit) < minimumDot) continue;

		best = { model: instance, position: position };
		bestDistance = distance;
	}

	return best;
}

/**
 * Throwing, for an NPC.
 *
 * The ball leaves the hand through `BallService.throwBall` and nothing else, so an NPC's throw *is* a
 * throw with a different direction in it: the same weld release, the same token stamped at release and
 * the same hand of gates — with one difference worth knowing at this call site, which is that the *solve*
 * is a different function from a player's. A rig has a point to reach and asks for a throw at it; a player
 * has a heading and a hold and asks for a throw along it. Both are in `shared/throw.ts`, and the request
 * below says which one this is.
 *
 * **What the behavior does now, and what it used to do.** It used to solve a throw at a point `THROW_RANGE`
 * studs straight out in front of the rig's nose, whatever was there or not — so a rig "threw" at empty air,
 * at a wall, and at its own teammates, and the ball went wherever it went. It now looks for an enemy first.
 * If there is one, the rig **turns to face it, holds the aim for `AIM_DELAY_SECONDS`, and then throws at
 * it**; if there is not, the rig does nothing at all and keeps its ball. The turn and the pause are the
 * whole point — see `AIM_DELAY_SECONDS` — and the throw itself is unchanged, still the `aimed` kind the
 * solve has always had a branch for.
 *
 * **The face-then-throw is a `task.delay`, not a second tick or an orientation constraint.** The rig's
 * facing is written outright (`HumanoidRootPart.CFrame`), which is instant; the *observable* part is the
 * pause after it, and a `task.delay` is the smallest thing that can hold a facing for a moment without
 * handing the rig to a physics constraint and then having to take it back. The alternative — `AlignOrientation`
 * and a tweened turn — would make the rotation itself smooth, and it is the honest next step if the instant
 * turn reads as a snap; it is not taken here because it brings a constraint to create, attach, drive and
 * destroy on every throw, on a rig that may die mid-turn, for a tell a half-second hold already gives.
 *
 * **`tickInterval` is what paces the throws, and it is deliberately slower than the catching behavior's**,
 * so a rig that both catches and throws has time to be hit between its own throws. The aim delay sits
 * *inside* that interval rather than extending it: a rig whose tick has fired and whose `task.delay` is
 * pending is marked as aiming, so the next tick — five seconds later, long after the delay has resolved —
 * is not a second aim.
 */
export function createThrowBehavior(balls: BallService): NpcBehavior {
	/**
	 * The rigs with a throw in flight behind a face.
	 *
	 * **A set keyed by the thrower**, because the one thing that has to be known between the face and the
	 * throw is "is an aim already pending" — so a tick does not start a second one. It is also the row
	 * `onDied` clears, so a rig killed mid-aim does not leave an aim behind that the next body to wear `NPC`
	 * would inherit.
	 */
	const aiming = new Set<Model>();

	return {
		tag: BEHAVIOR_THROWING,
		tickInterval: 5.0,

		// **There is no `prepare` here, and its absence is a fix rather than an omission.** This behaviour
		// used to ask for a ball the moment its tag arrived on a rig — `balls.giveBall(model)`, the same call
		// a player's character is given one by — on the reasoning that a rig that throws needs something to
		// throw. What that produced was a rig standing on a join pad for a whole intermission **holding a
		// ball**: `[Ball] <rig>: trail built` printed at spawn, a ball in every rig's hand before any round
		// had started, and a rig that looked armed in a lobby where a player is not.
		//
		// **Nothing is lost, because the refill below already grants it — under the round gate.** `tick`
		// returns on `!isPlaying()` before it asks about the hand, so outside a round a rig never *acquires*
		// a ball; inside one, the first tick with an empty hand hands it one and the throw comes a
		// `tickInterval` later. The grant was a second door to the same room, and it was the one that could
		// not see the phase.
		//
		// **What it costs, stated rather than discovered: a rig picks its ball up on its first tick of a
		// round instead of having carried one in.** That is the same bargain a player gets — the ball is given
		// at the start of a round, not carried through an intermission, which is what
		// `RoundService.clearHeldBalls` enforces for a person — and the price is one `tickInterval` of an
		// empty hand, most of which the rig spends getting to its post anyway.
		tick(model, humanoid) {
			// **A rig only throws while a match is on**, which is the gate this behavior never had. It is
			// asked before the ball and before the search, because there is nothing to look for in an
			// intermission — no sides, no round — and a rig holding a ball in the lobby is a rig waiting, not
			// a rig that has failed to find somebody.
			if (!isPlaying()) return;

			// Empty hand: take another ball, by the same call `prepare` made the first
			// time. A throwing rig is one of the only two things in the game that is
			// never left without one — the other is a dev with `InfiniteBalls` — and this
			// is where that lives. It is a *behavior* asking, rather than the throw
			// handing a ball back to everybody who throws one.
			if (!balls.getHeldBall(model)) {
				balls.giveBall(model);
				return;
			}

			// An aim is already pending. Nothing to do — the delayed throw below owns the next move, and
			// starting a second aim would only re-face a rig that is already facing the right way.
			if (aiming.has(model)) return;

			const root = resolveDodgeable(model)?.root;
			if (!root) return;

			const side = sideOf(model);
			// **No side, no enemy, no throw.** A rig that has never been given a side — a fresh body, or one
			// standing in the lobby before it has walked to a pad — throws at nobody rather than at everybody.
			if (side === undefined) return;

			const enemy = nearestEnemy(model, root, side);
			if (!enemy) return;

			// **The turn, and it is a yaw.** The aim point is dropped to the rig's own height first, so the
			// facing is a rotation about the vertical only: looking up or down at a body on a step is not what
			// "turn to face" means, and a rig that pitched to follow a target's height would topple its own
			// hips. `CFrame.lookAt` from the root's own position keeps every other axis where the body left it.
			const aimAt = new Vector3(enemy.position.X, root.Position.Y, enemy.position.Z);
			if (aimAt.sub(root.Position).Magnitude > 0.001) root.CFrame = CFrame.lookAt(root.Position, aimAt);

			aiming.add(model);

			task.delay(AIM_DELAY_SECONDS, () => {
				aiming.delete(model);

				// **Everything is re-checked, because the delay outlives the moment it was made in.** Half a
				// second is long enough for the round to end, for the rig to be killed, for its ball to be
				// caught out of its hand, and for the target to die or leave — and every one of those ends the
				// throw rather than being allowed to fire into a world that has moved on. A throw *by* a dead
				// rig is a ball out of a corpse.
				if (!isPlaying()) return;
				if (humanoid.Health <= 0 || model.Parent === undefined) return;
				if (!balls.getHeldBall(model)) return;

				// The target is re-read rather than remembered: a body that has walked since the rig turned
				// to face it has walked, and the ball should go where it *is*. This is the whole reason the
				// pending aim keeps the body rather than a point.
				if (enemy.model.Parent === undefined) return;

				const targetRoot = resolveDodgeable(enemy.model)?.root;
				const liveRoot = resolveDodgeable(model)?.root;
				if (!targetRoot || !liveRoot) return;

				// **The `aimed` kind, which is the one a caller with a point in mind uses.** It is tagged rather
				// than inferred because `BallService.throwBall` accepts both kinds and a target handed to the
				// charged solve would be a distance — see `ThrowRequest` in `shared/throw.ts`, which is where that
				// argument lives in full.
				balls.throwBall(model, { kind: "aimed", target: targetRoot.Position, arc: THROW_ARC });
			});
		},

		/**
		 * A rig that dies mid-aim does not get to throw.
		 *
		 * The delayed callback would refuse the throw on its own — it re-checks the health — but the row
		 * itself has to go, and this is the only moment it can: after the death the model is either destroyed
		 * or replaced, and a row left in the set would keep a destroyed rig alive as a key and would be found
		 * by the next body wearing `NPC` if that body happened to be the same instance. Emptying it here is
		 * the same discipline `SeekBehavior` keeps for its per-rig row.
		 */
		onDied(model) {
			aiming.delete(model);
		},
	};
}
