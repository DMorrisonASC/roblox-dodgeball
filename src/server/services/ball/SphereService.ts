import { Service } from "@flamework/core";
import { MaterialService, Workspace } from "@rbxts/services";
import { BALL_CONFIG } from "shared/config/ball.config";
import { TrailEffect, TrailOptions } from "shared/TrailEffect";

/** Everything you can customise when asking for a sphere. */
export interface SphereOptions {
    /** Defaults to {@link BALL_CONFIG.BALL_COLOR} — one red, the same for every ball. */
    color?: Color3;
    /** Trail settings. Defaults to purple; pass `false` for a bare sphere. */
    trail?: TrailOptions | false;
    /** Overrides the drawn material. Defaults to one of {@link BALL_CONFIG.BALL_MATERIALS}. */
    material?: Enum.Material;
}

/**
 * **What one ball is made of** — a material, and the name of a `MaterialVariant` when one applies.
 *
 * Two fields rather than one because they are two properties on the part (`Material` and
 * `MaterialVariant`), and the second one only means anything when the first is the variant's own base
 * material. Collapsing them into a single "surface" the caller cannot separate would hide that.
 */
interface BallSurface {
    /** The part's `Material`. */
    material: Enum.Material;
    /** The variant's own name, or nothing when this is a plain built-in material. */
    variant?: string;
}

@Service()
export class SphereService {
    /** Whether the missing-variant warning has been printed. **Once per server** — see `drawnSurface`. */
    private reportedMissingVariant = false;

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
     *
     * **The material is the opposite decision, and deliberately: one is drawn per ball.** A colour that
     * varies says something false (it looks like it belongs to somebody); a *surface* that varies says
     * only "this is one of eight balls", which is true and is what a player needs to tell two red spheres
     * apart at twenty studs. See {@link BALL_CONFIG.BALL_MATERIALS} for the list, for why every entry in it
     * is a bumpy material rather than the nearest tidy one, and for why it cannot change how a ball
     * behaves. A caller that wants a particular look — a scenery sphere, an effect carrier — passes
     * `material`.
     */
    public createBall(size = 4, options: SphereOptions = {}): Part {
        const surface = this.drawnSurface();

        const ball = new Instance("Part");
        ball.Shape = Enum.PartType.Ball;
        ball.Size = new Vector3(size, size, size);
        ball.Material = options.material ?? surface.material;
        ball.Anchored = false;
        ball.Color = options.color ?? BALL_CONFIG.BALL_COLOR;

        // **The variant only when this service chose the material.** A caller that names a material means
        // it, and the engine ignores `MaterialVariant` on a part whose material is not the variant's base —
        // so setting one there would be a line that does nothing while reading as though it did something.
        if (options.material === undefined && surface.variant !== undefined) {
            ball.MaterialVariant = surface.variant;
        }

        if (options.trail !== false) {
            this.addTrail(ball, options.trail);
        }

        return ball;
    }

    /**
     * **What one ball is made of: a `MaterialVariant` when the place file has one, otherwise a drawn
     * built-in material.**
     *
     * **The two are exclusive, and the order is not a preference.** A variant is the authored surface — a
     * normal map at a chosen `StudsPerTile`, the only way a ball gets real pips rather than grit — and
     * {@link BALL_CONFIG.BALL_MATERIALS} is the fallback for a place file that has not authored one. See
     * `BALL_CONFIG.BALL_MATERIAL_VARIANT` for how to make one, and for why the base material is *read* off
     * the variant here rather than kept as a second setting that could disagree with it.
     *
     * **A name that matches nothing warns once and falls back.** A variant is invisible in code, so a typo's
     * only symptom would be "the balls look ordinary again" — which is the same symptom as the switch being
     * empty and the same as the variant having been renamed in Studio. The line names the variant and lists
     * what `MaterialService` actually holds, because those three have three different fixes.
     *
     * **The empty-list fallback is not dead code.** `math.random(1, n)` with a nought is not a call this can
     * make, and a config emptied mid-edit would otherwise break the one path every ball in the game is made
     * through. `DiamondPlate` is the same material the list names — see the config for why that one — so an
     * emptied list costs the mechanism rather than the look.
     */
    private drawnSurface(): BallSurface {
        const wanted = BALL_CONFIG.BALL_MATERIAL_VARIANT;

        if (wanted !== "") {
            const found = MaterialService.FindFirstChild(wanted);

            if (found !== undefined && found.IsA("MaterialVariant")) {
                return { material: found.BaseMaterial, variant: found.Name };
            }

            if (!this.reportedMissingVariant) {
                this.reportedMissingVariant = true;

                const names = new Array<string>();
                for (const child of MaterialService.GetChildren()) names.push(child.Name);

                warn(
                    `[Ball] no MaterialVariant named "${wanted}" under MaterialService — the balls fall ` +
                        `back to BALL_CONFIG.BALL_MATERIALS. MaterialService holds: ` +
                        `${names.isEmpty() ? "nothing" : names.join(", ")}`,
                );
            }
        }

        const materials = BALL_CONFIG.BALL_MATERIALS;

        if (materials.size() === 0) return { material: Enum.Material.DiamondPlate };

        // `math.random(1, n)` is inclusive at both ends, so the index is the whole list and never its end.
        return { material: materials[math.random(1, materials.size()) - 1] };
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