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
import { BALL_NAME } from "shared/constants";
import { REMOTES } from "shared/remotes";
import { planPlayerThrow } from "shared/throw";
import { Trajectory } from "shared/Trajectory";

const ACTION_NAME = "ThrowDodgeball";
const AIM_DISTANCE = 500; // how far to project the aim ray when nothing is hit
const DEBUG = true; // set false once throwing is confirmed working

@Controller()
export class ThrowController implements OnStart {
	private readonly player = Players.LocalPlayer;
	private throwRemote?: RemoteEvent;
	private readonly guide = new AimGuide();

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

				const target = this.getAimTarget(character);
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
			return;
		}

		// This is not an approximation of the arc — it is the same plan the
		// server will run when the click arrives, from the same origin.
		const target = this.getAimTarget(character);
		const plan = planPlayerThrow(character, target);
		const arc = new Trajectory(plan.origin, plan.velocity, { ignore: [character] });

		this.guide.update(arc.points);
	}

	private getThrowRemote(): RemoteEvent | undefined {
		const folder = ReplicatedStorage.WaitForChild(REMOTES.folder, 10);
		if (!folder) return undefined;

		const remote = folder.WaitForChild(REMOTES.throwBall, 10);
		return remote && remote.IsA("RemoteEvent") ? remote : undefined;
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
