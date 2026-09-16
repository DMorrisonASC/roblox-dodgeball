import { Controller, OnStart } from "@flamework/core";
import { ContextActionService, Players, ReplicatedStorage, UserInputService, Workspace } from "@rbxts/services";
import { BALL_NAME } from "shared/constants";
import { REMOTES } from "shared/remotes";

const ACTION_NAME = "ThrowDodgeball";
const AIM_DISTANCE = 500; // how far to project the aim ray when nothing is hit
const DEBUG = true; // set false once throwing is confirmed working

@Controller()
export class ThrowController implements OnStart {
	private readonly player = Players.LocalPlayer;
	private throwRemote?: RemoteEvent;

	onStart() {
		this.throwRemote = this.getThrowRemote();

		ContextActionService.BindAction(
			ACTION_NAME,
			(_actionName, inputState) => {
				if (inputState !== Enum.UserInputState.Begin) return Enum.ContextActionResult.Pass;

				// Holding a ball is the only thing that makes a click meaningful.
				if (!this.player.Character?.FindFirstChild(BALL_NAME)) {
					return Enum.ContextActionResult.Pass;
				}

				const target = this.getAimTarget();
				if (DEBUG) print(`[Throw] throwing at ${target}`);
				this.throwRemote?.FireServer(target);
				return Enum.ContextActionResult.Sink;
			},
			false,
			Enum.UserInputType.MouseButton1,
		);
	}

	private getThrowRemote(): RemoteEvent | undefined {
		const folder = ReplicatedStorage.WaitForChild(REMOTES.folder, 10);
		if (!folder) return undefined;

		const remote = folder.WaitForChild(REMOTES.throwBall, 10);
		return remote && remote.IsA("RemoteEvent") ? remote : undefined;
	}

	private getAimTarget(): Vector3 {
		const camera = Workspace.CurrentCamera;
		if (!camera) {
			const character = this.player.Character;
			return character
				? character.GetPivot().Position.add(new Vector3(0, 0, -AIM_DISTANCE))
				: new Vector3(0, 0, -AIM_DISTANCE);
		}

		const mouse = UserInputService.GetMouseLocation();
		const ray = camera.ViewportPointToRay(mouse.X, mouse.Y);
		const hit = Workspace.Raycast(ray.Origin, ray.Direction.mul(AIM_DISTANCE));
		return hit ? hit.Position : ray.Origin.add(ray.Direction.mul(AIM_DISTANCE));
	}
}
