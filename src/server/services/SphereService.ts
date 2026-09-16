import { Service } from "@flamework/core";
import { Workspace } from "@rbxts/services";

@Service()
export class SphereService {
    public spawnAt(position: Vector3, name?: string): Part {
        const sphere = new Instance("Part");
        sphere.Shape = Enum.PartType.Ball;
        sphere.Size = new Vector3(4, 4, 4);
        sphere.Position = position;
        sphere.Anchored = true;
        sphere.BrickColor = BrickColor.random();
        sphere.Name = name ?? "Sphere";
        sphere.Parent = Workspace;
        return sphere;
    }
}