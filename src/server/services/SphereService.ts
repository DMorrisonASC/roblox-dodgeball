import { Service } from "@flamework/core";
import { Workspace } from "@rbxts/services";
import { TrailEffect, TrailOptions } from "shared/TrailEffect";

/** Everything you can customise when asking for a sphere. */
export interface SphereOptions {
    /** Defaults to a random BrickColor. */
    color?: BrickColor;
    /** Trail settings. Defaults to purple; pass `false` for a bare sphere. */
    trail?: TrailOptions | false;
}

@Service()
export class SphereService {
    /**
     * Creates an unanchored, unparented sphere part.
     * Used both for held balls (welded to the hand) and for thrown projectiles.
     *
     * A purple trail is attached by default — pass `{ trail: false }` to opt out.
     */
    public createBall(size = 4, options: SphereOptions = {}): Part {
        const ball = new Instance("Part");
        ball.Shape = Enum.PartType.Ball;
        ball.Size = new Vector3(size, size, size);
        ball.Material = Enum.Material.SmoothPlastic;
        ball.Anchored = false;
        ball.BrickColor = options.color ?? BrickColor.random();

        if (options.trail !== false) {
            this.addTrail(ball, options.trail);
        }

        return ball;
    }

    /**
     * Attaches a trail to any part. Thin re-export of {@link TrailEffect} so
     * callers holding a `SphereService` don't need to import it themselves.
     */
    public addTrail(part: BasePart, options: TrailOptions = {}): TrailEffect {
        return TrailEffect.apply(part, options);
    }

    public spawnAt(position: Vector3, name?: string): Part {
        // Scenery spheres never move, so a trail would never draw on them.
        const sphere = this.createBall(4, { trail: false });
        sphere.Position = position;
        sphere.Anchored = true;
        sphere.Name = name ?? "Sphere";
        sphere.Parent = Workspace;
        return sphere;
    }
}