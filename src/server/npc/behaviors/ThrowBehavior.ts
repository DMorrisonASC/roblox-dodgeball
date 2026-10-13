import { ThrowArc } from "shared/Trajectory";
import { NPC_CONFIG } from "shared/config/npc.config";
import { resolveDodgeable } from "shared/dodge";
import { BEHAVIOR_THROWING, NpcBehavior } from "../Behavior";
import { detectEnemy } from "../detect";
import type { BallService } from "../../services/ball/BallService";

/**
 * Which arc this behaviour throws. Straight is the plain default; a real aim is what would choose.
 *
 * **A rig is the only thing in the game that still names an arc.** A player's throw is charged — a heading
 * and a hold, with no point in it at all — so `overhead`, `straight` and `curve` survive here, where there
 * really is a target and a choice of how to reach it. This constant is therefore the whole of what selects
 * between them, which makes it the line to change if a rig should arc a ball instead of driving it.
 */
const THROW_ARC: ThrowArc = "straight";

/**
 * How often this behaviour looks for something to throw at, in seconds.
 *
 * **Fast, because the rig has to *turn* before it throws and the turn is watched from here.** The
 * interval is not a throw rate — a throw needs a ball in the hand, and this behaviour never hands
 * itself one, so the rate is set by how often `Behavior_Seeking` and `Behavior_Pickup` fetch another.
 * What the interval paces is the reaction: how soon the rig notices an enemy, and how often it
 * re-checks that it has finished turning. A tenth of a second is the same cadence the catcher and the
 * dodger ask for, which keeps `NpcService`'s one-loop-per-rig turn rate unchanged for a rig wearing
 * any of them.
 *
 * This is deliberately *not* the old throw's five seconds. That number paced a rig that refilled its
 * own hand and threw on a metronome; with the refill gone (see the file comment), a slow tick would
 * only delay the turn.
 */
const THROW_TICK_SECONDS = 0.1;

/** The name on the attachment the aim constraint hangs from, so a stray one can be found. */
const AIM_ATTACHMENT_NAME = "NpcAimAttachment";

/** The name on the aim constraint itself, for the same reason. */
const AIM_CONSTRAINT_NAME = "NpcAimBalance";

/**
 * How hard the aim constraint may torque the rig, and how quickly it answers.
 *
 * **`AlignOrientation` rather than a per-tick `CFrame` write, and the codebase already made this
 * choice once**: `DodgeService.startDash` turns a dashing body with the same constraint, at the same
 * torque and responsiveness, for the same reason — a constraint turns the body *and* what the engine
 * thinks the body is doing, where a `CFrame` write on a physics-simulated root fights the solver and
 * reads as a snap. The numbers are copied from there deliberately so a rig turning to throw and a rig
 * dashing look like the same engine doing the same thing. They are not tuning values and so are not
 * in the config beside the range and the angle: they are the mechanism, and a rig that turns at a
 * different speed to a dodge is a different complaint to file.
 */
const AIM_MAX_TORQUE = 1e6;
const AIM_RESPONSIVENESS = 50;

/** Below this a target is too close to have a horizontal heading worth turning to. */
const AIM_FLAT_EPSILON = 0.001;

/**
 * One rig's aim: the constraint that is turning it, and what the humanoid's rotation was before.
 *
 * **State rather than locals, because the constraint has to outlive the tick that built it.** An
 * `AlignOrientation` turns a body over *time* — that is what makes the turn smooth — so it cannot be
 * created, used and destroyed inside one `tick`. It is kept per rig and reused until the aim ends.
 */
interface Aim {
	readonly attachment: Attachment;
	readonly balance: AlignOrientation;

	/** The rig's humanoid, if it has one, so its own rotation can be handed back. */
	readonly humanoid?: Humanoid;

	/** What `Humanoid.AutoRotate` was before this file switched it off. */
	readonly autoRotate: boolean;
}

/**
 * A deliberate miss: how far off this throw is aimed, which way, and the point that produces.
 *
 * **Precomputed into a target rather than left as a vector and a description**, because the two readers of
 * it want different things — `throwBall` wants the point to solve to, and the log line wants the studs and
 * the side in the words a person reads — and deriving either from the other at the call site is how the
 * line and the ball would come to disagree about the same throw.
 */
interface Miss {
	/** How far off the aim is, in studs. Never zero — see `THROW_MISS_STUDS_MIN`. */
	readonly studs: number;

	/** Which way, in the rig's own terms: `1` is its right, `-1` its left. */
	readonly side: number;

	/** The point to aim at instead: the true target moved sideways by {@link Miss.studs}. */
	readonly target: Vector3;
}

/**
 * Rolls for this throw's aim: nothing at all when it is aimed true, or a point a few studs to one side.
 *
 * **A rig is fallible on purpose, and the miss is in the *release* rather than the posture.** The roll
 * happens here, at the moment the throw fires, and it offsets the *point the ball is solved to*: the rig
 * has already turned onto its true target and the aim constraint is already down (see the tick, which
 * calls this after `clearAim`), so the body stays pointed at the player it meant to hit and only the ball
 * goes wide. That is what reads as a misclick — a rig that turned *away* from its target instead would
 * read as one that cannot aim, which is a different and worse character. **The turn is deliberately
 * untouched by this function**: it is handed a point and returns a point, and nothing it does is visible
 * to `aimAt`.
 *
 * **The design the alternative would cost.** Every throw a rig makes is a solved shot to the target's
 * own position, so without a miss term a rig never misses at any range the angle gate passes — and a
 * round against something that cannot miss reads as an opponent rather than as a player. The user's
 * request was to "add some randomness to make them intentionally throw a few studs to the left or right,
 * to simulate real player misclicks"; this is that, and the numbers are in `NPC_CONFIG`.
 *
 * **Left and right are the rig's own.** The offset is along the flattened `RightVector`, so a rig facing
 * north that misses to its right sends the ball east. World-relative sides would have a rig facing east
 * missing "right" by throwing north, which is nobody's idea of a misclick.
 *
 * **One roll per throw, and the structure of the tick is what makes that true rather than a promise.** It
 * is called from the throw site and nowhere else, below every early return in the tick — a rig with no
 * ball, no body, no target or a target out of range never reaches it, and a rig still turning returns
 * before it — so the roll happens on exactly the tick that throws. The throw then empties the hand, so the
 * *next* tick returns at its first check and cannot roll for the same throw again. This behaviour runs ten
 * times a second; a roll per tick would be a ball that changed its mind on the way and a rig that read as
 * drunk rather than as human.
 *
 * **It does not print, and it does not know whether the throw lands.** `throwBall` answers whether a ball
 * actually left, and it refuses some attempts — a frozen body keeps its ball — so a line from in here
 * would be a line per tick for the whole of a freeze, describing throws that never happened. The caller
 * logs, once, and only for a throw that went. See the throw site.
 *
 * **The common case returns nothing**, so a rig that is not missing this time is throwing exactly what it
 * threw before any of this existed.
 */
function rollMiss(root: BasePart, aimPoint: Vector3): Miss | undefined {
	if (math.random() > NPC_CONFIG.THROW_MISS_CHANCE) return undefined;

	// The body's own right, flattened. A rig leaning on a slope has a `RightVector` with a Y component,
	// and keeping it would make the ball fly over the target rather than past it — which is a different
	// miss from the one asked for, and the only one this is not allowed to produce.
	const right = new Vector3(root.CFrame.RightVector.X, 0, root.CFrame.RightVector.Z);
	if (right.Magnitude < AIM_FLAT_EPSILON) return undefined;

	const studs =
		NPC_CONFIG.THROW_MISS_STUDS_MIN +
		math.random() * (NPC_CONFIG.THROW_MISS_STUDS_MAX - NPC_CONFIG.THROW_MISS_STUDS_MIN);

	// A coin flip for the side, so a rig is as likely to be wide one way as the other — the two-sided
	// error a person makes, rather than a habitual bias toward one shoulder.
	const side = math.random() < 0.5 ? -1 : 1;

	return { studs, side, target: aimPoint.add(right.Unit.mul(side * studs)) };
}

/**
 * Throwing, for an NPC — **the gated variant, worn by `Behavior_Throwing`.**
 *
 * **It throws at an enemy, and it has to be facing one to do it.** Where `Behavior_AlwaysThrowing`
 * throws straight ahead on a timer whether or not anybody is there, this rig throws at the nearest
 * opposing model — and only when that model is roughly in front of it and within range. That facing
 * rule is not a property of throwing; it is the prerequisite the user asked for, and it lives in
 * `detect.ts` so a later dodge or catch can ask the same question of the same maths.
 *
 * **It never calls `prepare`, and it never hands itself a ball.** The rig that wears this is expected
 * to be wearing `Behavior_Seeking` and `Behavior_Pickup` too: it walks to a loose ball, picks it up,
 * and throws the one it has. **An empty hand is therefore not an error but the ordinary state after a
 * throw** — the rig goes and fetches another — so the tick below returns without throwing when there
 * is nothing in the hand, which is what `BallService.throwBall` would answer anyway, without the
 * lookups this file would have spent getting there.
 *
 * **It turns, and it throws when the turn is done — `turn-then-fire`, not `fire-when-close-enough`
 * (see `aimAt`).** The angle gate is re-read every tick from the rig's *current* facing, so the rig
 * visibly rotates onto its target and the ball leaves once the target is inside the window. The
 * alternative — throw the instant the *enemy* is within ±45° of wherever the rig happens to be
 * looking — is a rig that fires sideways while still standing, which reads as a bug from the seat
 * even though the aimed solve would land the ball anyway. The turn is what makes it read as a throw.
 *
 * **What the turn is not:** a change to the throw's *arithmetic*. `BallService.throwBall` is handed
 * the target's own position, and the aimed solve flys the ball at that point from wherever the muzzle
 * is — so the rotation is presentation, and the facing window is a plausibility gate ("do not throw
 * behind you"), not a correction the solver needs. Stated because the opposite is easy to assume: the
 * ball is not thrown along `LookVector`.
 */
export function createThrowBehavior(balls: BallService): NpcBehavior {
	/** One row per rig currently turning toward a target. See {@link Aim}. */
	const aims = new Map<Model, Aim>();

	/**
	 * The rigs that have already been reported as **holding a ball with nobody to throw it at**.
	 *
	 * A `Set` rather than a flag on the aim, because it is about a state that is not an aim: a rig with no
	 * target has no aim at all (this file clears it), so the fact has nowhere else to live. Presence is the
	 * latch — a rig is reported the turn it becomes blocked and again the turn it stops being blocked, and
	 * says nothing in between. Never cleared, like every other per-rig table in this directory: a destroyed
	 * rig never ticks again, so its entry is never read again either.
	 */
	const idle = new Set<Model>();

	/**
	 * Points `model`'s body at `aimPoint`, building the constraint the first time and re-aiming it
	 * after.
	 *
	 * **The humanoid's own rotation is switched off for the duration, and handed back afterwards.**
	 * A standing humanoid steers its own facing, which would fight the constraint for the body — the
	 * same fight `DodgeService` settles with `PlatformStand`, and settled here more cheaply because a
	 * rig that is walking must not be put on platform stand. `AutoRotate = false` leaves the walk
	 * controller alone and takes only the facing, which is the one thing this wants.
	 */
	const aimAt = (model: Model, root: BasePart, aimPoint: Vector3): void => {
		let aim = aims.get(model);

		if (aim === undefined) {
			const attachment = new Instance("Attachment");
			attachment.Name = AIM_ATTACHMENT_NAME;
			attachment.Parent = root;

			const balance = new Instance("AlignOrientation");
			balance.Name = AIM_CONSTRAINT_NAME;
			balance.Attachment0 = attachment;
			balance.Mode = Enum.OrientationAlignmentMode.OneAttachment;
			balance.MaxTorque = AIM_MAX_TORQUE;
			balance.Responsiveness = AIM_RESPONSIVENESS;
			balance.RigidityEnabled = false;
			balance.Parent = root;

			const humanoid = model.FindFirstChildWhichIsA("Humanoid");
			const autoRotate = humanoid?.AutoRotate ?? true;
			if (humanoid) humanoid.AutoRotate = false;

			aim = { attachment, balance, humanoid, autoRotate };
			aims.set(model, aim);
		}

		// Flat, so the turn is a yaw and never pitches the rig into the floor — the same reasoning
		// `DodgeService` gives for the two points of its own `lookAt`. A target directly overhead has
		// no heading to turn to, and the guard leaves the last good aim standing rather than turning
		// the rig to face nothing.
		const flat = new Vector3(aimPoint.X - root.Position.X, 0, aimPoint.Z - root.Position.Z);
		if (flat.Magnitude < AIM_FLAT_EPSILON) return;

		aim.balance.CFrame = CFrame.lookAt(root.Position, root.Position.add(flat.Unit));
	};

	/**
	 * Ends an aim: destroys the constraint and gives the humanoid its own rotation back.
	 *
	 * Called on the three ways an aim can end — a throw, a lost target, and a death — and safe to call
	 * when there is no aim, so each of those paths can call it unconditionally rather than each having
	 * to know whether one was ever built.
	 */
	const clearAim = (model: Model): void => {
		const aim = aims.get(model);
		if (aim === undefined) return;

		aim.balance.Destroy();
		aim.attachment.Destroy();
		if (aim.humanoid) aim.humanoid.AutoRotate = aim.autoRotate;

		aims.delete(model);
	};

	return {
		tag: BEHAVIOR_THROWING,
		tickInterval: THROW_TICK_SECONDS,

		tick(model) {
			// Nothing to throw with: the ordinary state after a throw, and the rig is expected to go
			// and fetch another. Ending the aim is the honest thing here — a rig holding no ball is
			// not aiming at anything, and a constraint left standing would keep turning a body that
			// has nothing to do with the turn.
			if (!balls.getHeldBall(model)) {
				clearAim(model);

				return;
			}

			const rigBody = resolveDodgeable(model);
			if (!rigBody) {
				clearAim(model);

				return;
			}

			// The enemy, or nothing — and nothing also covers "no round is playing", because
			// `detectEnemy` is silent outside one. A rig with no enemy stops aiming.
			const sighting = detectEnemy(model);

			// **A rig holding a ball with nobody to throw it at says so once, and says when that ends.** This
			// is the one state this behaviour has that is invisible in every other line a server prints: a rig
			// with a ball in hand and its target out of range does *nothing*, for as long as the state lasts,
			// and looks from a seat exactly like a rig that is thinking about it. In and out, once each, is
			// what turns "the rigs stopped throwing after a while" into a distance and a range to compare —
			// which is otherwise a question about a number in a config file that nothing reports.
			if (sighting === undefined || sighting.distance > NPC_CONFIG.THROW_RANGE_STUDS) {
				clearAim(model);

				if (!idle.has(model)) {
					idle.add(model);

					const reason =
						sighting === undefined
							? "no enemy in the round"
							: `the nearest is ${math.floor(sighting.distance)} studs off, ` +
								`and the range is ${NPC_CONFIG.THROW_RANGE_STUDS}`;

					print(`[Rig] ${model.Name}: holding a ball and not throwing — ${reason}`);
				}

				return;
			}

			if (idle.has(model)) {
				idle.delete(model);

				print(`[Rig] ${model.Name}: throwing again — target ${math.floor(sighting.distance)} studs off`);
			}

			// Turn toward it. This runs whether or not the rig is already on target, because the
			// target may have moved and because re-aiming is what keeps the constraint pointing at
			// the body rather than at where it was.
			aimAt(model, rigBody.root, sighting.aimPoint);

			// Not yet facing it: keep turning, and do not throw. The angle was measured this tick from
			// the rig's current facing, so this is the *turn* being watched and not a fixed pose.
			if (math.abs(sighting.angle) > math.rad(NPC_CONFIG.THROW_ANGLE_DEGREES)) return;

			// On target: stop turning and throw at the body. The constraint comes down before the
			// throw so the ball leaves a body that has finished moving, and the aimed solve carries
			// it to the target from the muzzle the rig is now facing along.
			//
			// **And the point handed over is the only thing the miss touches.** `rollMiss` runs once,
			// here, and answers either nothing — aim at the body — or a point a few studs to the rig's
			// left or right. The rig has finished turning onto the true target by this line (see the
			// `aimAt` call above, which ran whether or not this throw was going to be a wide one), so
			// the body is aimed at the player and only the ball goes somewhere else. See that function
			// for the rule and `NPC_CONFIG` for the numbers.
			clearAim(model);
			const miss = rollMiss(rigBody.root, sighting.aimPoint);

			const thrown = balls.throwBall(model, {
				kind: "aimed",
				target: miss?.target ?? sighting.aimPoint,
				arc: THROW_ARC,
			});

			// **Logged once, and only for a throw that actually left** — which is the difference between
			// one line per wide throw and a line per tick for a rig that cannot throw at all. `throwBall`
			// answers whether a ball went, and its refusals include a frozen body: a rig frozen with a
			// ball in hand reaches this line every tenth of a second, and a print from `rollMiss` would
			// have described thirty throws that never happened for the length of one freeze.
			if (thrown && miss !== undefined) {
				print(
					`[Rig] ${model.Name}: throwing wide — ${string.format("%.1f", miss.studs)} studs to the ` +
						`${miss.side > 0 ? "right" : "left"} (missed on purpose)`,
				);
			}
		},

		// A rig killed mid-turn leaves a constraint on its root otherwise, and `RespawnBehavior`
		// replaces the whole model a moment later — so the turn would be left running on a body that
		// is about to be thrown away.
		onDied(model) {
			clearAim(model);
		},
	};
}
