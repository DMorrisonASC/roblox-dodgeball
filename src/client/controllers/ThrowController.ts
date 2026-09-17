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
import { BALL_NAME, BALL_SIZE, PREDICTION_VERTICAL_BIAS } from "shared/constants";
import { REMOTES } from "shared/remotes";
import { getThrowMuzzle, planPlayerThrow } from "shared/throw";
import { Trajectory } from "shared/Trajectory";

const ACTION_NAME = "ThrowDodgeball";
const AIM_DISTANCE = 500; // how far to project the aim ray when nothing is hit

/**
 * Console diagnostics: which throw was fired, and a per-frame report on aim
 * stability. Flip to `true` when chasing an aiming or landing problem — the
 * jitter report is rate limited so it won't flood the output.
 */
const DEBUG = false;

/**
 * Aim changes smaller than this, in studs, are ignored.
 *
 * Measured in world space rather than mouse pixels on purpose: pixel-level
 * noise is what we want to reject, but a player walking past a wall produces
 * large legitimate changes in where the ray lands, and those must still come
 * through. Gating on distance keeps both behaviours.
 */
const AIM_DEADZONE = 0.25;

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
	private nextReport = 0;

	/** Last accepted aim point — see {@link AIM_DEADZONE}. */
	private steadyTarget: Vector3 | undefined;

	onStart() {
		this.throwRemote = this.getThrowRemote();

		ContextActionService.BindAction(
			ACTION_NAME,
			(_actionName, inputState) => {
				if (inputState !== Enum.UserInputState.Begin) return Enum.ContextActionResult.Pass;

				// Holding a ball is the only thing that makes a click meaningful.
				const character = this.player.Character;
				if (!character?.FindFirstChild(BALL_NAME)) {
					return Enum.ContextActionResult.Pass;
				}

				const target = this.getSteadyAimTarget(character);
				if (DEBUG) print(`[Throw] throwing at ${target}`);
				this.throwRemote?.FireServer(target);
				return Enum.ContextActionResult.Sink;
			},
			false,
			Enum.UserInputType.MouseButton1,
		);

		RunService.RenderStepped.Connect(() => this.updateGuide());
	}

	/**
	 * Redraws the predicted arc every frame while a ball is in hand, so you can
	 * see exactly where the throw is going before committing to it.
	 */
	private updateGuide() {
		const character = this.player.Character;
		const ball = character?.FindFirstChild(BALL_NAME);
		if (!character || !ball || !ball.IsA("BasePart")) {
			this.guide.hide();
			this.steadyTarget = undefined; // next ball starts aiming fresh
			return;
		}

		// This is not an approximation of the arc — it is the same plan the
		// server will run when the click arrives, from the same origin.
		const target = this.getSteadyAimTarget(character);
		const plan = planPlayerThrow(character, target);
		// The guide itself is ignored as well as the thrower. Its own parts sit
		// right along this arc, and an arc that can hit the line drawn to
		// represent it will chase itself around the world.
		//
		// The radius matters: the ball bounces when its edge touches a surface, a
		// full half-diameter before its centre gets there. Tracing the centre
		// alone always marked the impact too far along.
		// The engine flies the ball a touch lower than the solve predicts, so the
		// drawn arc carries the same deficit — the guide should describe the throw
		// you are going to get, not an idealised one. The real throw is unaffected;
		// this only changes what is drawn. See PREDICTION_VERTICAL_BIAS.
		const predicted = plan.velocity.sub(new Vector3(0, PREDICTION_VERTICAL_BIAS, 0));
		const arc = new Trajectory(plan.origin, predicted, {
			ignore: [character, this.guide.instance],
			radius: BALL_SIZE / 2,
		});

		if (DEBUG) this.reportJitter(target, getThrowMuzzle(character), arc);

		this.guide.update(arc.points, { position: arc.contact ?? arc.landing, normal: arc.normal });
	}

	/**
	 * Scaffolding for tracking down jittery aim. Only fires when the mouse is
	 * still, so anything it reports is genuine jitter rather than you aiming.
	 *
	 * Read it as a bisection. `target` moving means the aim raycast is landing
	 * somewhere different each frame. A steady target with a moving `muzzle`
	 * means the launch point is drifting underneath it. Steady target *and*
	 * muzzle means the arc simulation itself is at fault — and then `points` and
	 * `hit` matter, because an arc that never collides runs to `maxTime` and
	 * reports a point in mid-air as its landing.
	 */
	private reportJitter(target: Vector3, muzzle: Vector3, arc: Trajectory) {
		const mouse = UserInputService.GetMouseLocation();
		const still = this.lastMouse !== undefined && mouse.sub(this.lastMouse).Magnitude < 0.5;

		// Rate limited. This fires every frame the landing moves, and printing
		// thousands of lines a second costs real frame time in Studio — which
		// would make the very stutter it is trying to measure worse.
		const now = os.clock();
		if (still && this.lastTarget && this.lastMuzzle && this.lastLanding && now >= this.nextReport) {
			const landingJump = arc.landing.sub(this.lastLanding).Magnitude;
			if (landingJump > 0.5) {
				this.nextReport = now + 0.5;
				print(
					`[Aim] landing +${landingJump} | target +${target.sub(this.lastTarget).Magnitude}` +
						` | muzzle +${muzzle.sub(this.lastMuzzle).Magnitude} | points ${arc.points.size()}` +
						` | hit ${ThrowController.describeHit(arc)}`,
				);
			}
		}

		this.lastMouse = mouse;
		this.lastTarget = target;
		this.lastMuzzle = muzzle;
		this.lastLanding = arc.landing;
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
