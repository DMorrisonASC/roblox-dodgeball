import { Service } from "@flamework/core";
import { Workspace } from "@rbxts/services";
import { BALL_CONFIG } from "shared/config/ball.config";
import { TrailEffect, TrailOptions } from "shared/TrailEffect";

/** Everything you can customise when asking for a sphere. */
export interface SphereOptions {
    /** Defaults to {@link BALL_CONFIG.BALL_COLOR} — one red, the same for every ball. */
    color?: Color3;
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
     *
     * **The colour is one red unless the caller names another, and that is a reversal.** This used to
     * be `BrickColor.random()`, which made a ball's colour different on every spawn and meaningless
     * everywhere — see {@link BALL_CONFIG.BALL_COLOR} for what replaced it and why. Nothing in the
     * game passes a colour today, so every ball is that red.
     */
    public createBall(size = 4, options: SphereOptions = {}): Part {
        const ball = new Instance("Part");
        ball.Shape = Enum.PartType.Ball;
        ball.Size = new Vector3(size, size, size);
        ball.Material = Enum.Material.SmoothPlastic;
        ball.Anchored = false;
        ball.Color = options.color ?? BALL_CONFIG.BALL_COLOR;

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