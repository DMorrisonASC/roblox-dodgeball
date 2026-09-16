import { Service } from "@flamework/core";
import { Workspace } from "@rbxts/services";

@Service()
export class SphereService {
    /**
     * Creates an unanchored, unparented ball part.
     * Used both for held tools (as a handle) and for thrown projectiles.
     */
    public createBall(size = 4, color?: BrickColor): Part {
        const ball = new Instance("Part");
        ball.Shape = Enum.PartType.Ball;
        ball.Size = new Vector3(size, size, size);
        ball.Material = Enum.Material.SmoothPlastic;
        ball.Anchored = false;
        ball.BrickColor = color ?? BrickColor.random();
        return ball;
    }

    public spawnAt(position: Vector3, name?: string): Part {
        const sphere = this.createBall(4);
        sphere.Position = position;
        sphere.Anchored = true;
        sphere.Name = name ?? "Sphere";
        sphere.Parent = Workspace;
        return sphere;
    }
}