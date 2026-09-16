/**
 * The purple used by trails when no colour is supplied: rgb(128, 0, 128).
 */
export const PURPLE = Color3.fromRGB(128, 0, 128);

/** Everything you can tune about a trail. Every field has a default. */
export interface TrailOptions {
	/** Colour at the head of the trail. Defaults to {@link PURPLE}. */
	color?: Color3;
	/** Gap between the trail's two attachment points, in studs. Defaults to the part's X size. */
	width?: number;
	/** How long (seconds) a segment lingers after the part has moved past it. */
	lifetime?: number;
	/** Segments shorter than this are never drawn — stops stray wisps while idle. */
	minLength?: number;
	/** Hard cap on the total drawn length, so fast parts can't draw forever. */
	maxLength?: number;
	/** Fade along the trail: `0` is the head (at the part), `1` is the tail. */
	transparency?: NumberSequence;
	/** Width along the trail: `0` is the head, `1` is the tail. */
	widthScale?: NumberSequence;
	/** How much the trail glows. `1` makes it read as light rather than fabric. */
	lightEmission?: number;
	/** How much scene lighting tints the trail. `0` keeps the colour pure. */
	lightInfluence?: number;
	/** Always face the camera instead of holding a fixed ribbon plane. */
	faceCamera?: boolean;
	/** Optional texture id, e.g. `"rbxassetid://..."`. */
	texture?: string;
	/** Start disabled (useful if you only want the trail while something is in flight). */
	enabled?: boolean;
}

const DEFAULTS = {
	lifetime: 0.6,
	minLength: 0.4,
	maxLength: 120,
	lightEmission: 0.35,
	lightInfluence: 0,
	faceCamera: false,
} as const;

const ATTACHMENT_0 = "TrailAttachment0";
const ATTACHMENT_1 = "TrailAttachment1";

/**
 * A self-contained trail you can attach to any `BasePart`.
 *
 * A `Trail` needs two `Attachment`s and only draws while the part is moving, so
 * this class owns all three instances and hands the caller a single object with
 * a single `destroy()`. Nothing here is tied to Flamework or to spheres — pass
 * it a ball, a sword, or a car and it behaves the same.
 *
 * ```ts
 * const trail = TrailEffect.apply(part);
 * trail.setEnabled(false);
 * ```
 */
export class TrailEffect {
	/** rgb(128, 0, 128) — the project's default trail colour. */
	public static readonly PURPLE = PURPLE;

	/** Name given to the `Trail` instance, so the effect can be found again. */
	public static readonly INSTANCE_NAME = "PartTrail";

	/** The underlying `Trail` instance, if you need to poke at it directly. */
	public readonly instance: Trail;

	private readonly attachment0: Attachment;
	private readonly attachment1: Attachment;

	constructor(part: BasePart, options: TrailOptions = {}) {
		// The ribbon is drawn between the two attachments, so their separation
		// is the ribbon's width. Matching the part's X size keeps it proportional.
		const width = options.width ?? part.Size.X;
		this.attachment0 = this.createAttachment(part, ATTACHMENT_0, new Vector3(-width / 2, 0, 0));
		this.attachment1 = this.createAttachment(part, ATTACHMENT_1, new Vector3(width / 2, 0, 0));

		const trail = new Instance("Trail");
		trail.Name = TrailEffect.INSTANCE_NAME;
		trail.Attachment0 = this.attachment0;
		trail.Attachment1 = this.attachment1;
		trail.Color = new ColorSequence(options.color ?? PURPLE);
		trail.Transparency =
			options.transparency ??
			new NumberSequence([
				new NumberSequenceKeypoint(0, 0.15),
				new NumberSequenceKeypoint(0.15, 0.35),
				new NumberSequenceKeypoint(1, 1),
			]);
		trail.WidthScale =
			options.widthScale ??
			new NumberSequence([new NumberSequenceKeypoint(0, 1), new NumberSequenceKeypoint(1, 0.35)]);
		trail.Lifetime = options.lifetime ?? DEFAULTS.lifetime;
		trail.MinLength = options.minLength ?? DEFAULTS.minLength;
		trail.MaxLength = options.maxLength ?? DEFAULTS.maxLength;
		trail.LightEmission = options.lightEmission ?? DEFAULTS.lightEmission;
		trail.LightInfluence = options.lightInfluence ?? DEFAULTS.lightInfluence;
		trail.FaceCamera = options.faceCamera ?? DEFAULTS.faceCamera;
		trail.Enabled = options.enabled ?? true;
		if (options.texture !== undefined) {
			trail.Texture = options.texture;
		}
		trail.Parent = part;

		this.instance = trail;
	}

	/** Convenience wrapper so call sites read as `apply(ball)`. */
	public static apply(part: BasePart, options: TrailOptions = {}): TrailEffect {
		return new TrailEffect(part, options);
	}

	/** Shows or hides the trail without destroying it. */
	public setEnabled(enabled: boolean): this {
		this.instance.Enabled = enabled;
		return this;
	}

	/** Recolours the trail, keeping the fade. */
	public setColor(color: Color3): this {
		this.instance.Color = new ColorSequence(color);
		return this;
	}

	/** Clears the segments already drawn (e.g. teleporting the part). */
	public clear(): this {
		this.instance.Clear();
		return this;
	}

	/** Removes the trail and both attachments. */
	public destroy(): void {
		this.instance.Destroy();
		this.attachment0.Destroy();
		this.attachment1.Destroy();
	}

	private createAttachment(part: BasePart, name: string, offset: Vector3): Attachment {
		const existing = part.FindFirstChild(name);
		if (existing?.IsA("Attachment")) {
			return existing;
		}

		const attachment = new Instance("Attachment");
		attachment.Name = name;
		attachment.CFrame = new CFrame(offset);
		attachment.Visible = false;
		attachment.Parent = part;
		return attachment;
	}
}
