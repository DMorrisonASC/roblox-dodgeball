import { Workspace } from "@rbxts/services";

/**
 * A reusable, semi-transparent line that traces a path through the world.
 *
 * Roblox has no curved line primitive (`Beam` only spans two points), so this
 * draws the path as a short chain of thin neon bricks, pooling them up front so
 * a per-frame update costs nothing but CFrame writes.
 *
 * Nothing here knows about balls or throwing — hand it any list of points.
 */
export interface AimGuideOptions {
	/** Colour of the line. Defaults to a bright violet. */
	color?: Color3;
	/** Transparency at the near end. Defaults to 0.55 (semi-transparent). */
	transparency?: number;
	/** Extra transparency added by the far end, so the line fades out. */
	fade?: number;
	/** Thickness of the line, in studs. */
	thickness?: number;
	/** How many segments to pre-build. Paths longer than this are cut short. */
	maxSegments?: number;
	/** Where to keep the segments. Defaults to `Workspace`. */
	parent?: Instance;
}

const DEFAULT_COLOR = Color3.fromRGB(160, 100, 255);
const DEFAULT_TRANSPARENCY = 0.55;
const DEFAULT_FADE = 0.4;
const DEFAULT_THICKNESS = 0.12;
const DEFAULT_MAX_SEGMENTS = 48;

/** Segments are run slightly long so the joins don't show as gaps. */
const SEGMENT_OVERLAP = 0.05;

export class AimGuide {
	/** Name of the folder holding the segments. */
	public static readonly INSTANCE_NAME = "AimGuide";

	private readonly folder: Folder;
	private readonly segments: Part[] = [];
	private readonly color: Color3;
	private readonly transparency: number;
	private readonly fade: number;
	private readonly thickness: number;

	constructor(options: AimGuideOptions = {}) {
		this.color = options.color ?? DEFAULT_COLOR;
		this.transparency = options.transparency ?? DEFAULT_TRANSPARENCY;
		this.fade = options.fade ?? DEFAULT_FADE;
		this.thickness = options.thickness ?? DEFAULT_THICKNESS;

		const count = options.maxSegments ?? DEFAULT_MAX_SEGMENTS;
		const folder = new Instance("Folder");
		folder.Name = AimGuide.INSTANCE_NAME;
		for (let i = 0; i < count; i++) {
			this.segments.push(this.createSegment(folder, i));
		}
		folder.Parent = options.parent ?? Workspace;

		this.folder = folder;
	}

	/**
	 * Draws the line along `points`. Any pooled segment the path doesn't reach
	 * is hidden, so this doubles as a clear for shorter paths.
	 */
	public update(points: ReadonlyArray<Vector3>): this {
		const available = this.segments.size();
		const wanted = math.min(points.size() - 1, available);

		for (let i = 0; i < available; i++) {
			const segment = this.segments[i];
			if (i >= wanted) {
				segment.Transparency = 1;
				continue;
			}

			const from = points[i];
			const to = points[i + 1];
			const delta = to.sub(from);
			const length = delta.Magnitude;
			if (length < 0.01) {
				segment.Transparency = 1;
				continue;
			}

			segment.Size = new Vector3(this.thickness, this.thickness, length + SEGMENT_OVERLAP);
			segment.CFrame = CFrame.lookAt(from.add(delta.mul(0.5)), to);
			segment.Transparency = math.clamp(this.transparency + (i / wanted) * this.fade, 0, 1);
		}

		return this;
	}

	/** Hides the line without destroying it. */
	public hide(): this {
		for (const segment of this.segments) {
			segment.Transparency = 1;
		}
		return this;
	}

	/** Removes the line and every segment in it. */
	public destroy(): void {
		this.folder.Destroy();
		this.segments.clear();
	}

	private createSegment(parent: Folder, index: number): Part {
		const segment = new Instance("Part");
		segment.Name = `Segment${index}`;
		segment.Anchored = true;
		segment.CanCollide = false;
		// Critical: the guide must never be the thing your aim ray hits, or the
		// predicted path would feed back into the aim point and spiral.
		segment.CanQuery = false;
		segment.CanTouch = false;
		segment.CastShadow = false;
		segment.Material = Enum.Material.Neon;
		segment.Color = this.color;
		segment.Transparency = 1;
		segment.Size = new Vector3(this.thickness, this.thickness, this.thickness);
		segment.Parent = parent;
		return segment;
	}
}
