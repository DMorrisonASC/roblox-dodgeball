import { Players, Workspace } from "@rbxts/services";

/**
 * The throw preview: a dashed beam along the predicted arc, ending in a marker on the ground where
 * the ball is going to land.
 *
 * **It is a prediction of this moment, not a promise.** The target has not moved yet, so all this
 * can honestly say is where the ball *would* land as things stand — which is why the hit indicator
 * is a hue shift at the same brightness and never a change in how loud the marker is. Bright reads
 * as "you win", and that is a claim a preview can never make.
 *
 * Everything here is a `workspace` instance, so a wall between you and the landing hides the
 * preview the way it would hide the ball. A `Frame` pasted over the screen draws through the wall,
 * which is exactly what this used to look like.
 *
 * **Nothing is kept between aims.** The folder is made once and named; everything else is built the
 * first time {@link AimGuide.update} is called and destroyed by {@link AimGuide.hide}, so a session
 * that never throws leaves one empty folder behind and nothing else.
 *
 * Nothing here knows about balls or throwers — hand it a list of points and somewhere to put the
 * marker.
 */

/** Where to place the marker, and which way its face points. */
export interface MarkerPlacement {
	position: Vector3;
	/** Surface normal to lie flush against. Defaults to upright. */
	normal?: Vector3;
}

/** Name of the folder the preview lives in. Also the instance the aim ray must ignore. */
const FOLDER_NAME = "AimGuide";

/**
 * The beam's width at the muzzle end and at the landing end, in studs.
 *
 * The taper is the whole difference between a trajectory and a ruler. A constant width reads as
 * something drawn *over* the world; a line that narrows toward where it is going reads as something
 * travelling through it.
 */
const WIDTH_MUZZLE = 0.55;
const WIDTH_LANDING = 0.12;

/**
 * How see-through the path is.
 *
 * High on purpose: the path is the quiet part of the preview and the landing is the loud part, so
 * the thing that tells you *where* to look is the dimmer of the two.
 */
const BEAM_TRANSPARENCY = 0.7;

/**
 * How many dashes the path is broken into, how much of each dash's slot is drawn, and how fast the
 * dashes march along it.
 *
 * A solid bar reads as a wall; dashes read as a path. The movement is what says which end is the
 * muzzle without drawing an arrow, and a preview that never moves reads as dead — but it has to stay
 * slow, or the path becomes the loudest thing on the screen.
 */
const DASH_COUNT = 12;
const DASH_DUTY = 0.55;
const DASH_SPEED = 0.5;

/** Points the path is resampled to, evenly by distance, before the dashes are laid along it. */
const PATH_SAMPLES = 48;

/**
 * Radius of the marker in studs, and its thickness.
 *
 * The radius is also the size of the "is somebody standing there" test, so the answer always matches
 * the size of the thing the player is looking at rather than a number they cannot see.
 */
const MARKER_RADIUS = 1.5;
const MARKER_THICKNESS = 0.1;

/** The marker's see-through-ness at rest, and how far either side of it the pulse swings. */
const MARKER_TRANSPARENCY = 0.3;
const MARKER_PULSE_DEPTH = 0.12;

/** Radians per second of the marker's pulse: a breath, not a blink. */
const MARKER_PULSE_SPEED = 2.2;

/**
 * The two marker colours: the same value, a different hue.
 *
 * Neutral is a desaturated blue-grey and the hit colour is a warmer grey at the same brightness, so a
 * hit changes the marker's *temperature* and nothing else. That is the whole signal, and it is
 * meant to be felt rather than seen: put side by side they are obviously different, and alone
 * neither reads as good or bad.
 */
const COLOR_NEUTRAL = Color3.fromRGB(120, 120, 130);
const COLOR_WOULD_HIT = Color3.fromRGB(140, 118, 108);

/** One dash of the path: the beam, and the two points it is stretched between. */
interface Dash {
	beam: Beam;
	from: Attachment;
	to: Attachment;
}

/** What one aim is drawn with. Absent whenever nothing is drawn. */
interface Preview {
	carriage: Part;
	marker: Part;
}

export class AimGuide {
	/**
	 * The folder everything lives in.
	 *
	 * Kept for the whole session even while nothing is drawn, because it is also what the aim ray
	 * excludes — a named, stable instance the controller can hand to every raycast it makes.
	 */
	public readonly instance: Folder;

	/** The dashes of the current aim. Empty while nothing is drawn. */
	private dashes: Dash[] = [];

	/** What the current aim is drawn with. Absent while nothing is drawn. */
	private preview?: Preview;

	/**
	 * Reused by every "is somebody standing there" query.
	 *
	 * Held rather than made per call because this asks once a frame while aiming, and the only thing
	 * that changes between calls is which body to leave out. See {@link AimGuide.wouldHit}.
	 */
	private readonly overlap = new OverlapParams();

	constructor() {
		const folder = new Instance("Folder");
		folder.Name = FOLDER_NAME;
		folder.Parent = Workspace;

		this.instance = folder;
	}

	/**
	 * Draws the preview along `points`, with the marker at `placement`.
	 *
	 * Called every frame while aiming, so the instances are built on the first call and moved in
	 * place from then on. `placement` puts the marker somewhere other than the end of the path, which
	 * is what a projectile with size needs: the path ends where the ball's *centre* stopped, while
	 * the marker belongs flat against the surface its edge touched.
	 */
	public update(points: ReadonlyArray<Vector3>, placement?: MarkerPlacement): this {
		const path = resample(points);
		if (path.size() < 2) {
			this.hide();
			return this;
		}

		if (this.preview === undefined) this.preview = this.build();
		const preview = this.preview;

		const now = os.clock();

		// The dashes march by a whole slot per cycle and wrap at the muzzle end, so the path stays a
		// single line the eye follows toward the landing rather than a set of separate marks.
		const phase = (now * DASH_SPEED) % 1;
		const slot = 1 / this.dashes.size();

		for (let index = 0; index < this.dashes.size(); index++) {
			const dash = this.dashes[index];
			const start = ((index + phase) * slot) % 1;
			const finish = math.min(start + slot * DASH_DUTY, 1);

			const from = pointAt(path, start);
			const to = pointAt(path, finish);

			dash.from.WorldPosition = from;
			dash.to.WorldPosition = to;
			dash.beam.Width0 = widthAt(start);
			dash.beam.Width1 = widthAt(finish);

			// A dash squeezed to nothing — the tail of a wrap, or a path with a kink in it — draws as
			// a flicker rather than a mark, so it is switched off instead.
			dash.beam.Enabled = to.sub(from).Magnitude > 0.02;
		}

		const at = placement ? placement.position : path[path.size() - 1];
		const normal = placement && placement.normal ? placement.normal : new Vector3(0, 1, 0);

		preview.marker.CFrame = AimGuide.discCFrame(at, normal);
		// The pulse is a sine on the clock rather than a tween: it never ends, needs no callback, and
		// cannot be left half-applied by the aim moving underneath it.
		preview.marker.Transparency =
			MARKER_TRANSPARENCY + math.sin(now * MARKER_PULSE_SPEED) * MARKER_PULSE_DEPTH;
		preview.marker.Color = this.wouldHit(at) ? COLOR_WOULD_HIT : COLOR_NEUTRAL;

		return this;
	}

	/** Hides the preview, destroying what it was drawn with. The folder stays. */
	public hide(): this {
		if (this.preview) {
			// One destroy: the carriage holds the attachments and the beams.
			this.preview.carriage.Destroy();
			this.preview.marker.Destroy();
			this.preview = undefined;
			this.dashes = [];
		}

		return this;
	}

	/** Removes the preview and its folder. The instance is not usable afterwards. */
	public destroy(): void {
		this.hide();
		this.instance.Destroy();
	}

	/**
	 * Whether anybody is standing where the ball is going to land.
	 *
	 * **Current position only.** The target has not moved yet, and extrapolating its velocity would
	 * turn a prediction of the shot into a guess about the player — a different claim, which the
	 * marker would then be lying about.
	 */
	private wouldHit(at: Vector3): boolean {
		const filter: Instance[] = [this.instance];

		// Your own body is not a target: aiming at your feet would otherwise light the marker up
		// every time, and nobody is threatening themselves.
		const character = Players.LocalPlayer.Character;
		if (character) filter.push(character);

		this.overlap.FilterType = Enum.RaycastFilterType.Exclude;
		this.overlap.FilterDescendantsInstances = filter;

		for (const part of Workspace.GetPartBoundsInRadius(at, MARKER_RADIUS, this.overlap)) {
			const humanoid = part.FindFirstAncestorWhichIsA("Model")?.FindFirstChildWhichIsA("Humanoid");

			// A body on the floor is not something a throw is threatening.
			if (humanoid && humanoid.Health > 0) return true;
		}

		return false;
	}

	/**
	 * Builds one aim's worth of instances: the carriage, the dash beams, and the marker.
	 *
	 * The attachments live in a part of their own rather than in the marker, because an attachment
	 * is positioned *relative* to its parent part — and the marker moves every frame, which would
	 * drag both ends of every dash along with it.
	 */
	private build(): Preview {
		const carriage = new Instance("Part");
		carriage.Name = "Carriage";
		carriage.Anchored = true;
		carriage.CanCollide = false;
		// Never drawn, and never in the way of the aim ray that produced the path.
		carriage.Transparency = 1;
		carriage.CanQuery = false;
		carriage.CanTouch = false;
		carriage.CastShadow = false;
		carriage.Size = new Vector3(1, 1, 1);
		carriage.Parent = this.instance;

		this.dashes = [];
		for (let index = 0; index < DASH_COUNT; index++) {
			const from = new Instance("Attachment");
			from.Name = `From${index}`;
			from.Parent = carriage;

			const to = new Instance("Attachment");
			to.Name = `To${index}`;
			to.Parent = carriage;

			const beam = new Instance("Beam");
			beam.Name = `Dash${index}`;
			beam.Attachment0 = from;
			beam.Attachment1 = to;
			// Nothing glows. A beam that emits its own light reads as a line drawn over the world
			// instead of one in it, and the marker is supposed to be the bright end of the preview.
			beam.LightEmission = 0;
			beam.LightInfluence = 1;
			// A flat quad turns into a hairline seen edge-on; this keeps it readable from anywhere.
			beam.FaceCamera = true;
			beam.Transparency = new NumberSequence(BEAM_TRANSPARENCY);
			beam.Enabled = false;
			beam.Parent = carriage;

			this.dashes.push({ beam, from, to });
		}

		return { carriage, marker: this.createMarker(this.instance) };
	}

	/**
	 * CFrame laying a disc flat against a surface.
	 *
	 * A `Cylinder` part's flat faces are perpendicular to its local X axis, so X
	 * is what has to line up with the surface normal. Built from matrix axes
	 * rather than `CFrame.lookAt`, because looking straight up or down is
	 * degenerate for `lookAt` and a flat landing is the common case.
	 */
	private static discCFrame(position: Vector3, normal: Vector3): CFrame {
		const reference = math.abs(normal.Y) > 0.9 ? new Vector3(1, 0, 0) : new Vector3(0, 1, 0);
		const perpendicular = normal.Cross(reference).Unit;
		return CFrame.fromMatrix(position, normal, perpendicular);
	}

	private createMarker(parent: Folder): Part {
		const marker = new Instance("Part");
		marker.Name = "LandingMarker";
		// A cylinder with a thin axis reads as a flat disc, which suits a landing
		// zone better than a sphere half-buried in the surface.
		marker.Shape = Enum.PartType.Cylinder;
		marker.Anchored = true;
		marker.CanCollide = false;
		// Critical: the marker must never be the thing your aim ray hits, or the mark
		// would feed back into the aim point that produced it.
		marker.CanQuery = false;
		marker.CanTouch = false;
		marker.CastShadow = false;
		// Smooth plastic, not Neon: the marker is the bright end of the preview by being the most
		// solid thing in it, not by glowing at the world. A glow would read as "you win" on its own,
		// before the colour had said anything.
		marker.Material = Enum.Material.SmoothPlastic;
		marker.Color = COLOR_NEUTRAL;
		marker.Transparency = MARKER_TRANSPARENCY;
		marker.Size = new Vector3(MARKER_THICKNESS, MARKER_RADIUS * 2, MARKER_RADIUS * 2);
		marker.Parent = parent;
		return marker;
	}
}

/**
 * The same path, resampled to a fixed number of points spaced evenly *by distance*.
 *
 * The simulator's points are one per step of a fixed interval, so they bunch up wherever the ball is
 * moving slowly and spread out where it is moving fast. Laying dashes along those directly would
 * give short dashes at the top of an arc and long ones at its ends; equal distance is what makes a
 * dashed line look drawn rather than computed.
 *
 * The *shape* is untouched — this only moves where the points are along it — so the curve the
 * preview draws is still the curve the ball will fly. It also caps what the preview costs: however
 * fine the simulation gets, the number of dashes on screen is the same.
 */
function resample(points: ReadonlyArray<Vector3>): Vector3[] {
	if (points.size() < 2) return [];

	const lengths: number[] = [0];
	let total = 0;

	for (let index = 1; index < points.size(); index++) {
		total += points[index].sub(points[index - 1]).Magnitude;
		lengths.push(total);
	}

	if (total < 0.01) return [];

	const sampled: Vector3[] = [];
	for (let step = 0; step < PATH_SAMPLES; step++) {
		sampled.push(atDistance(points, lengths, (step / (PATH_SAMPLES - 1)) * total));
	}

	return sampled;
}

/** The point `t` of the way along a resampled path: `0` at the muzzle, `1` at the landing. */
function pointAt(path: ReadonlyArray<Vector3>, t: number): Vector3 {
	const scaled = math.clamp(t, 0, 1) * (path.size() - 1);
	const index = math.min(math.floor(scaled), path.size() - 2);
	const part = scaled - index;

	return path[index].add(path[index + 1].sub(path[index]).mul(part));
}

/** The point `distance` along a path, interpolating across the step it falls inside. */
function atDistance(points: ReadonlyArray<Vector3>, lengths: number[], distance: number): Vector3 {
	let index = 1;
	while (index < lengths.size() - 1 && lengths[index] < distance) index++;

	const previous = lengths[index - 1];
	const span = lengths[index] - previous;
	const part = span > 0 ? (distance - previous) / span : 0;

	return points[index - 1].add(points[index].sub(points[index - 1]).mul(part));
}

/** The beam's width at `t` along the path: the taper, from the muzzle down to the landing. */
function widthAt(t: number): number {
	return WIDTH_MUZZLE + (WIDTH_LANDING - WIDTH_MUZZLE) * math.clamp(t, 0, 1);
}
