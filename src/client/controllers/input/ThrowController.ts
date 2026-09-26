import { Controller, OnStart } from "@flamework/core";
import {
	ContextActionService,
	Players,
	ReplicatedStorage,
	RunService,
	UserInputService,
	Workspace,
} from "@rbxts/services";
import { AimGuide } from "shared/AimGuide";
import { DEBUG_CONFIG } from "shared/config/debug.config";
import { BALL_NAME, BALL_SIZE } from "shared/constants";
import { REMOTES } from "shared/remotes";
import { getThrowMuzzle, planPlayerThrow } from "shared/throw";
import { Trajectory, ThrowArc } from "shared/Trajectory";
import { aiming } from "../../aiming";

const ACTION_NAME = "ThrowDodgeball";
const ARC_ACTION_NAME = "SelectThrowArc";
const AIM_DISTANCE = 500; // how far to project the aim ray when nothing is hit

/**
 * Console diagnostics: which throw was fired, and a per-frame report on aim
 * stability. Flip to `true` when chasing an aiming or landing problem — the
 * jitter report is rate limited so it won't flood the output.
 */
const DEBUG = true;

/**
 * Aim changes smaller than this, in studs, are ignored.
 *
 * Measured in world space rather than mouse pixels on purpose: pixel-level
 * noise is what we want to reject, but a player walking past a wall produces
 * large legitimate changes in where the ray lands, and those must still come
 * through. Gating on distance keeps both behaviours.
 */
const AIM_DEADZONE = 0.50;

@Controller()
export class ThrowController implements OnStart {
	private readonly player = Players.LocalPlayer;
	private throwRemote?: RemoteEvent;
	private readonly guide = new AimGuide();

	// Scaffolding for tracking down jittery aim — see `reportJitter`.
	private lastMouse: Vector2 | undefined;
	private lastTarget: Vector3 | undefined;
	private lastMuzzle: Vector3 | undefined;
	private lastLanding: Vector3 | undefined;
	private lastMid: Vector3 | undefined;
	private nextReport = 0;

	/** Last accepted aim point — see {@link AIM_DEADZONE}. */
	private steadyTarget: Vector3 | undefined;

	/**
	 * Which of the three throws the next click uses.
	 *
	 * X is the arcing throw: lofted off the hand and dropped onto the mark.
	 * C is the straight one: barely thrown at all, with gravity alone curving it
	 * down onto the same mark. V is the curveball: a straight throw with a
	 * sideways force on it, so it bows out to the left and swings back onto the
	 * same mark again. Different shapes, different flight times, same landing.
	 *
	 * **Starts on `straight`, and the server's fallback starts on the same word.** The guide is drawn
	 * from this on the first frame a ball is in the hand, before any arc key has been pressed, so a
	 * default that disagreed with the shape the throw would actually take would be a guide drawing a
	 * line the ball does not fly. The two are one decision in two places, and are kept in step by hand
	 * because they are on opposite sides of the wire.
	 */
	private arc: ThrowArc = "straight";

	onStart() {
		this.throwRemote = this.getThrowRemote();

		ContextActionService.BindAction(
			ACTION_NAME,
			(_actionName, inputState) => {
				if (inputState !== Enum.UserInputState.Begin) return Enum.ContextActionResult.Pass;

				// **A ball in the hand is what makes a click a throw**, and the absence of one is what makes
				// it the catch's: `CatchController` asks this same question and lets go of the opposite
				// case. Two actions, one bound button, and neither has to know where the other's bind
				// sits — which matters because `ContextActionService` decides that by bind order, and bind
				// order here is controller load order.
				const character = this.player.Character;
				if (!character?.FindFirstChild(BALL_NAME)) {
					return Enum.ContextActionResult.Pass;
				}

				const target = this.getSteadyAimTarget(character);
				if (DEBUG) print(`[Throw] throwing at ${target}`);
				// The launch point goes with the throw. The server's copy of the
				// character is a replication interval behind ours, and a plan solved
				// from a different launch point is a different curve — it still lands
				// on the mark, but it is not the line this client just drew.
				this.throwRemote?.FireServer(target, this.arc, getThrowMuzzle(character));
				return Enum.ContextActionResult.Sink;
			},
			false,
			Enum.UserInputType.MouseButton1,
		);

		RunService.RenderStepped.Connect(() => this.updateGuide());

		// X for the arcing throw, C for the straight one, V for the curveball. The
		// guide redraws with the new shape immediately, which is the only feedback
		// needed — the landing marker deliberately does not move.
		ContextActionService.BindAction(
			ARC_ACTION_NAME,
			(_actionName, inputState, input) => {
				if (inputState !== Enum.UserInputState.Begin) return Enum.ContextActionResult.Pass;

				const key = input.KeyCode;
				if (key === Enum.KeyCode.C) {
					this.arc = "straight";
				} else if (key === Enum.KeyCode.V) {
					this.arc = "curve";
				} else {
					this.arc = "overhead";
				}

				if (DEBUG) print(`[Throw] arc: ${this.arc}`);
				return Enum.ContextActionResult.Sink;
			},
			false,
			Enum.KeyCode.X,
			Enum.KeyCode.C,
			Enum.KeyCode.V,
		);
	}

	/**
	 * Redraws the predicted arc every frame while a ball is in hand, so you can
	 * see exactly where the throw is going before committing to it.
	 */
	private updateGuide() {
		const character = this.player.Character;
		const ball = character?.FindFirstChild(BALL_NAME);
		const isAiming = character !== undefined && ball !== undefined && ball.IsA("BasePart");

		// **The glow's flag is the guide's own visibility, published rather than worked out twice.**
		// It is set from the same expression that decides whether to draw, so the guide and the aim
		// glow cannot come to different answers about whether the player is aiming — which is the
		// whole reason it is published from here instead of `AimTargetController` deriving it for
		// itself. See `client/aiming.ts`. Set unconditionally, because a Fusion `Value` given the
		// value it already holds does nothing.
		aiming.set(isAiming);

		if (!character || !ball || !ball.IsA("BasePart")) {
			this.guide.hide();
			this.steadyTarget = undefined; // next ball starts aiming fresh
			return;
		}

		// This is not an approximation of the arc — it is the same plan the
		// server will run when the click arrives, from the same origin.
		const target = this.getSteadyAimTarget(character);
		const plan = planPlayerThrow(character, target, this.arc);
		// The guide itself is ignored as well as the thrower. Its own parts sit
		// right along this arc, and an arc that can hit the line drawn to
		// represent it will chase itself around the world.
		//
		// The radius matters: the ball bounces when its edge touches a surface, a
		// full half-diameter before its centre gets there. Tracing the centre
		// alone always marked the impact too far along.
		// The radius matters twice over: the guide sweeps a sphere the size of the
		// ball, and the solve above aimed the ball's *centre* a radius out so its
		// *surface* is what arrives on the mark.
		const arc = new Trajectory(plan.origin, plan.velocity, {
			ignore: [character, this.guide.instance, ...this.looseBalls()],
			radius: BALL_SIZE / 2,
			// The curve is a force, not a launch angle, so it has to be simulated
			// as well as applied. Same vector as the server's, taken from the same
			// plan, which is the only reason the drawn path can be trusted.
			acceleration: plan.acceleration,
		});

		// The jitter report is the noisiest thing in the game: it is built to fire whenever the drawn
		// path moves, and while somebody is aiming that is every frame. See
		// `shared/config/debug.config.ts`.
		if (DEBUG && DEBUG_CONFIG.VERBOSE_LOGS) this.reportJitter(target, getThrowMuzzle(character), arc);

		this.guide.update(arc.points, { position: arc.contact ?? arc.landing, normal: arc.normal });
	}

	/**
	 * Scaffolding for tracking down jittery aim. Only fires when the mouse is
	 * still, so anything it reports is genuine jitter rather than you aiming.
	 *
	 * Read it as a bisection.
	 *
	 * - `target` moving means the aim raycast is landing somewhere different each
	 *   frame. That is mouse-side and the deadzone's business.
	 * - A steady `target` with a moving `muzzle` means the launch point is
	 *   drifting underneath it. The solve absorbs that, so the landing stays put
	 *   while the arc swings — which is exactly the whole-line wobble, and why
	 *   `mid` exists: a point in the middle of the path catches a line that is
	 *   moving without its ends moving.
	 * - Steady `target` and `muzzle` with a moving `landing` means the arc
	 *   simulation itself is at fault, and then `points` and `hit` matter — an arc
	 *   that never collides runs to `maxTime` and reports mid-air as its landing.
	 */
	private reportJitter(target: Vector3, muzzle: Vector3, arc: Trajectory) {
		const mouse = UserInputService.GetMouseLocation();
		const still = this.lastMouse !== undefined && mouse.sub(this.lastMouse).Magnitude < 0.5;

		// The middle of the path: the honest test for "the whole line moved".
		const mid = arc.points[math.floor(arc.points.size() / 2)];

		// Rate limited. This fires every frame the path moves, and printing
		// thousands of lines a second costs real frame time in Studio — which
		// would make the very stutter it is trying to measure worse.
		const now = os.clock();
		if (
			still &&
			this.lastTarget &&
			this.lastMuzzle &&
			this.lastLanding &&
			this.lastMid &&
			now >= this.nextReport
		) {
			const landingJump = arc.landing.sub(this.lastLanding).Magnitude;
			const midJump = mid.sub(this.lastMid).Magnitude;
			if (math.max(landingJump, midJump) > 0.2) {
				this.nextReport = now + 0.5;
				const jump = (to: Vector3, from: Vector3) => string.format("%.2f", to.sub(from).Magnitude);
				print(
					`[Aim] landing +${jump(arc.landing, this.lastLanding)}` +
						` | mid +${jump(mid, this.lastMid)} | target +${jump(target, this.lastTarget)}` +
						` | muzzle +${jump(muzzle, this.lastMuzzle)} | points ${arc.points.size()}` +
						` | hit ${ThrowController.describeHit(arc)}`,
				);
			}
		}

		this.lastMouse = mouse;
		this.lastTarget = target;
		this.lastMuzzle = muzzle;
		this.lastLanding = arc.landing;
		this.lastMid = mid;
	}

	/**
	 * Names the part the arc was stopped by, so the reported landing can be
	 * traced back to whatever is actually in the way.
	 */
	private static describeHit(arc: Trajectory): string {
		const hit = arc.hit;
		if (!hit) return "nothing";

		const parent = hit.Parent;
		return parent ? `${parent.Name}.${hit.Name}` : hit.Name;
	}

	/**
	 * Every dodgeball that has already been thrown, so the guide can pass
	 * through them.
	 *
	 * They are honest obstacles and the real ball does bounce off them — but they
	 * are small, round and scattered around the landing area, so a swept sphere
	 * that grazes one flips between touching it and missing it from frame to
	 * frame. That showed up in the probe as the arc collapsing to a two-point
	 * stub (landing +26.78, points 2) and springing back while the player stood
	 * perfectly still. The arc can only ever be a curve plus one impact; bounces
	 * are past what it can predict, so predicting them badly is worse than not
	 * predicting them.
	 */
	private looseBalls(): BasePart[] {
		const balls: BasePart[] = [];
		for (const child of Workspace.GetChildren()) {
			if (child.Name === BALL_NAME && child.IsA("BasePart")) {
				balls.push(child);
			}
		}

		return balls;
	}

	private getThrowRemote(): RemoteEvent | undefined {
		const folder = ReplicatedStorage.WaitForChild(REMOTES.folder, 10);
		if (!folder) return undefined;

		const remote = folder.WaitForChild(REMOTES.throwBall, 10);
		return remote && remote.IsA("RemoteEvent") ? remote : undefined;
	}

	/**
	 * The aim point, ignoring changes too small to be intentional.
	 *
	 * Used by both the guide and the throw itself, so what you see is what you
	 * get — if the click read a fresh raycast while the guide showed a held one,
	 * the ball would land somewhere other than the marker.
	 */
	private getSteadyAimTarget(character: Model | undefined): Vector3 {
		const fresh = this.getAimTarget(character);
		const held = this.steadyTarget;

		if (held && fresh.sub(held).Magnitude < AIM_DEADZONE) {
			return held;
		}

		this.steadyTarget = fresh;
		return fresh;
	}

	private getAimTarget(character: Model | undefined): Vector3 {
		const camera = Workspace.CurrentCamera;
		if (!camera) {
			return character
				? character.GetPivot().Position.add(new Vector3(0, 0, -AIM_DISTANCE))
				: new Vector3(0, 0, -AIM_DISTANCE);
		}

		const mouse = UserInputService.GetMouseLocation();
		const ray = camera.ViewportPointToRay(mouse.X, mouse.Y);

		// Ignore the thrower, so aiming over your own body doesn't put the
		// target at your feet.
		const params = new RaycastParams();
		params.FilterType = Enum.RaycastFilterType.Exclude;
		params.FilterDescendantsInstances = character ? [character] : [];
		params.IgnoreWater = true;

		const hit = Workspace.Raycast(ray.Origin, ray.Direction.mul(AIM_DISTANCE), params);
		return hit ? hit.Position : ray.Origin.add(ray.Direction.mul(AIM_DISTANCE));
	}
}
