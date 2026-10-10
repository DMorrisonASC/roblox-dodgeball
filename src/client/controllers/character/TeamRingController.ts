import { Controller, OnStart } from "@flamework/core";
import { AssetService, Players, ReplicatedStorage, RunService, Workspace } from "@rbxts/services";
import { RING_CONFIG } from "shared/config/ring.config";
import { TRANSITION_CONFIG, TRANSITION_COVER_SECONDS } from "shared/config/transition.config";
import {
	ROUND_MODE_ATTRIBUTE,
	ROUND_STATE_ATTRIBUTE,
	ROUND_STATUS_FOLDER,
	TEAM_ATTRIBUTE,
} from "shared/constants";
import { teamColourOf } from "shared/gameMode";
import { paintHalo, paintRing } from "shared/ringPattern";

/** Prints a line per ring made and per ring taken away, which is how one-per-player is confirmed. */
const DEBUG = true;

/**
 * What `ROUND_STATE_ATTRIBUTE` says while a round is being played.
 *
 * **Must match the string `RoundService` publishes**, and it is copied rather than shared for the reason
 * `StatsBillboardController` and `MusicController` both give: it is one word, and a `shared/constants` entry
 * for one word invites the impression that the phase vocabulary has two homes when it has one — the server's.
 */
const PLAYING = "Playing";

/**
 * One player's ring: every part of it, the offset each sits at relative to the ring's centre, and the parts and
 * pictures that take the side's colour.
 *
 * **`offsets` is index-paired with `plates`**, and that pairing is the price of a ring that can be turned and
 * stacked: the placement loop multiplies each part's own offset by wherever the body is this frame, so the
 * outline's segments keep the rotation they were laid out with. The version before this wrote one flat `CFrame`
 * to every part, which is why nothing but a disc could be built from it.
 *
 * **`team` is separate from `plates` because a halo is not the side's colour.** A glow is light rather than paint —
 * see {@link build} — so the painted ring's halo plate keeps `RING_CONFIG.HALO_COLOR` while its pictures and the
 * outline take the side's. The parts ring has no halo at all, so there `team` holds every part it has and the two
 * lists are the same objects; `tinted` is empty in that ring, which has no pictures either.
 */
interface RingLayers {
	readonly plates: Array<BasePart>;
	readonly offsets: Array<CFrame>;
	readonly team: Array<BasePart>;
	readonly tinted: Array<Texture>;
}

/**
 * This client's two pictures, and what each layer inked.
 *
 * **The counts travel with the images rather than being logged and forgotten**, because the line that reports them
 * is printed later — on the first ring of a round, which can be minutes after the draw — and a layer that inked
 * nothing is the fault this arrangement is likeliest to have.
 */
interface RingArtwork {
	readonly halo: Content;
	readonly band: Content;
	readonly haloPixels: number;
	readonly bandPixels: number;
	readonly patternPixels: number;
}

/**
 * The folder the rings live in, under `Workspace`.
 *
 * **Not a child of the body, which is the correction this went through.** A ring parented to a character has
 * free cleanup — it dies with the model — but it also puts the ring *inside* the thing the ring's own height
 * is measured from: the body's bounding box would have included a six-stud disc lying on the floor, so the
 * measurement the ring is placed by would have been made partly out of the ring. Measuring a body and then
 * hanging the result off that body is a loop, and this folder breaks it. What it costs is three explicit
 * cleanups instead of one free one — see `watch` and `refresh`.
 */
const FOLDER_NAME = "TeamRings";

/** The root the ring is placed under. Named because the position loop has to find it every frame. */
const ROOT_NAME = "HumanoidRootPart";

/** The plate the drawn ring's picture hangs on. Only the drawn ring has one. */
const RING_NAME = "TeamRing";

/** The halo's parts. Under the outline, and much larger than it. */
const HALO_NAME = "TeamHalo";

/** One straight piece of the outline. A ring of these is the circle. */
const SEGMENT_NAME = "TeamSegment";

/** One tooth. A wedge, pointing in at the middle. */
const TOOTH_NAME = "TeamTooth";

/**
 * The name of the picture instances on a plate. **Only the drawn ring has any** — see `partsRing` for the shape
 * that is there whether or not this client can draw one.
 */
const PICTURE_NAME = "Picture";

/**
 * The disc every player on a side wears on the floor for the length of a round, drawn on this client.
 *
 * **What it is for.** The outline says what a body is; the ring says *where* it is and whose it is, from an
 * angle the outline cannot answer — a camera looking across the arena sees the floor long before it sees a
 * silhouette, and in a mode where two sides share a floor, "whose feet are those" is the question being asked
 * constantly. The ring answers it in the same colour the outline uses.
 *
 * **Drawn by every client for every body, including its own.** This began as a server part and that was the
 * fault: a ring is positioned *from a body*, and bodies move on the machine that owns them — so a
 * server-positioned ring is placed from the server's delayed view and replicated back out, trailing the player
 * by two trips' worth of travel. Local, it is placed from the same interpolated body this client is already
 * drawing, so it cannot be anywhere else. See `ring.config.ts` for the same note from the config's side.
 *
 * **One part per player, made once and moved.** A ring rebuilt every frame would be an instance created and
 * destroyed sixty times a second, per player, per client. So it is built **once the bodies have been moved** —
 * see {@link onPhaseChanged}, because a round's phase is published before anybody is teleported and a ring made
 * on that edge is a ring standing in the lobby — repainted when the answer changes, repositioned each frame,
 * and destroyed by three routes: the phase ending, the body being replaced, and the player leaving.
 *
 * **And it is three drawn layers, not a picture with a colour on it.** A halo underneath — a radial gradient in a
 * near-white, which is the layer that makes the whole thing read as light rather than as paint — then the band, a
 * solid annulus in the side's colour, and then the rosette drawn *into* the band at a fraction of its opacity so
 * that it reads as texture rather than as the main event. Each is a painted image on an invisible plate, stacked
 * in Y, and that is forced rather than chosen: a ring is an annulus, no primitive is one, and an image is the
 * only way to a hole. See `shared/ringPattern.ts` for the figure, and {@link build} for the stacking. When the
 * pictures cannot be drawn at all the ring is one plain neon disc in the side's colour, so the failure is a
 * duller ring rather than no ring — and both outcomes are logged, see {@link describe}.
 *
 * **What it is not:** it is not welded to the body. Of the two lifetimes on offer this is **(a)** — the ring sits
 * on the floor, taking the body's `X`/`Z` every frame and the *ground's* `Y`, so a jump goes over it instead of
 * carrying it, and a ramp carries it because the ground is measured rather than assumed to be a constant.
 *
 * **Anchored, and kept in a folder of this client's own.** Anchored is what stops the physics solver having an
 * opinion about a decoration. The folder is the second correction this went through: the first version
 * parented each ring to the character, which made dying free but put the ring *inside* the thing the ring's
 * height is measured from — see {@link groundUnder} — and measuring a body partly out of the disc hanging off
 * it is a loop. So the rings live in `Workspace.TeamRings`, the three cleanups are explicit rather than free
 * (the phase ending, the body being replaced, the player leaving), and the measurement is of the body alone.
 *
 * **The height is measured from the body, not derived from its rig.** The version before this subtracted
 * `Humanoid.HipHeight` from the root and drew the ring at the **knees**, because that subtraction is only the
 * floor on an `R15` body: an `R6` body carries `HipHeight` of `0` and stands with its root three studs up, so
 * the formula answered "the root" and the ring went through the character's legs. Legs are a property of the
 * avatar, and the only thing that knows where they end is the body — see {@link groundUnder}.
 */
@Controller()
export class TeamRingController implements OnStart {
	/**
	 * The ring under each player, by player rather than by body.
	 *
	 * **By player, because a body is replaced on every death and the ring is not the body's.** Keyed by
	 * character, a respawn would leave the old entry pointing at destroyed plates; keyed by player, the new
	 * ring replaces the old one and the count in the log is the count of players.
	 *
	 * **A ring is a stack of plates rather than one part**, so what is held here is the stack and the two lists
	 * that go with it — see {@link RingLayers}.
	 */
	private readonly rings = new Map<Player, RingLayers>();

	/**
	 * The two pictures, drawn once for this client and then shared by every ring it draws.
	 *
	 * **Once, not per ring.** The pixels are the same for a ring in either team's colour — the ink is white and the
	 * colour arrives as a tint — so a per-player draw would be the same quarter of a million bytes computed again
	 * for each of them. See {@link artwork}.
	 */
	private drawn: RingArtwork | undefined;

	/**
	 * Whether this client has already been told it cannot draw the pictures.
	 *
	 * Separate from `drawn === undefined`, because the two mean different things: not drawn yet is a reason to
	 * draw, and *failed* is a reason to stop trying — on the next ring, for the next player, in the next round.
	 */
	private drawnFailed = false;

	/**
	 * Whether the first ring of this round has already printed its layer list.
	 *
	 * Reset when the rings are taken down, so the line appears once per round rather than once per player or once
	 * per session: the questions it answers — did the halo draw, is this the fallback — are per-round questions,
	 * and a per-ring line would bury them under ten copies of itself.
	 */
	private logged = false;

	/** The round's channel, once it exists. See {@link followRound} for why it starts undefined. */
	private status: Instance | undefined;

	/** The folder the rings live in. Made on first use; see {@link ringFolder}. */
	private folder: Folder | undefined;

	public onStart(): void {
		Players.PlayerAdded.Connect((player) => this.watch(player));
		Players.PlayerRemoving.Connect((player) => this.drop(player, "they left"));

		// The scan-and-subscribe pair this codebase uses everywhere, for the reason they all give: a player
		// already in the game never fires the added signal, and one who arrives afterwards is never in the
		// initial list.
		for (const player of Players.GetPlayers()) this.watch(player);

		// Spawned rather than done inline: mounting waits for the round's folder, which the *server* makes, and
		// a controller's `onStart` is the wrong place to hold up the rest of the client's boot.
		task.spawn(() => this.followRound());

		// **`RenderStepped`, because this writes something that is about to be drawn.** A ring that is a frame
		// behind its body is a ring that lags exactly the way the server version did, one frame at a time
		// instead of one trip at a time, so it runs before the draw rather than after it.
		RunService.RenderStepped.Connect(() => this.track());
	}

	/**
	 * Starts following the round, so that a phase changing makes the rings appear or go.
	 *
	 * **The phase and the mode are both watched, and the clock is not.** A phase decides whether there should
	 * be a ring at all; a mode change is watched because it is the moment the server assigns teams, which is the
	 * moment the labels a ring is coloured by are written. It is **not** watched for the colour itself any more —
	 * `TEAM_COLORS` is one pair for every mode, so a mode change cannot change a ring's colour — and the
	 * connection is kept for the label edge alone. `ROUND_TIME_ATTRIBUTE` changes once a second and would be a
	 * repaint per second that arrives at the colour it already had.
	 *
	 * **The two are handled apart, because only one of them has a body to wait for.** A phase needs the delay in
	 * {@link onPhaseChanged}; a mode change can only arrive while a round is on, and the rings it repaints are
	 * already in place, so it goes straight to the refresh.
	 *
	 * The refresh at the end is not redundant with {@link watch}: a player already in the game when this
	 * mounted was watched before this method could run, and at that moment there was no folder to read — so a
	 * client that mounted during a round would have no rings until the next phase change. It is deliberately
	 * *immediate* rather than delayed, on the assumption a client that mounted into a round has missed the
	 * teleport that round began with: the one case where that is wrong is a client that mounts inside the
	 * fraction of a second the cover takes to close, whose first rings are drawn in the lobby and follow their
	 * bodies to the arena a moment later.
	 */
	private followRound(): void {
		const status = ReplicatedStorage.WaitForChild(ROUND_STATUS_FOLDER);
		this.status = status;

		status.GetAttributeChangedSignal(ROUND_STATE_ATTRIBUTE).Connect(() => this.onPhaseChanged());
		status.GetAttributeChangedSignal(ROUND_MODE_ATTRIBUTE).Connect(() => this.refresh());

		this.refresh();
	}

	/**
	 * Makes the rings follow the phase, **waiting out the transition so that they appear where the bodies are.**
	 *
	 * **The delay is the whole of this method, and it is the correction the rings needed.** `RoundService`
	 * publishes `Playing` *before* it moves anybody — the phase goes out first so that the HUD and the wipe have
	 * something to read, and the teleport happens afterwards, behind the cover. A ring made on the phase edge is
	 * therefore made while its body is still standing in the lobby, and it is visible there for as long as the
	 * grid takes to close.
	 *
	 * **What is waited is the server's own number for that same moment.** `TRANSITION_COVER_SECONDS` is how long
	 * the server holds between announcing the transition and moving everybody, and this waits the same figure
	 * from the same event — the phase going out, which is the frame the transition is announced in. One duration
	 * measured by both sides rather than two that agree, which is the arrangement `transitionAround` and the
	 * arena freeze already use. With the transition switched off the server moves at once, so this waits nothing
	 * and the rings arrive with the phase.
	 *
	 * **Leaving `Playing` is not delayed**, and that is not symmetry for its own sake: a ring describes a body
	 * that is in a round, so the moment the round stops being played is the moment every ring is wrong.
	 */
	private onPhaseChanged(): void {
		if (!this.isPlaying()) {
			this.dropAll("the phase ended");

			return;
		}

		// Resolved here rather than written as one expression, because the two branches mean different things:
		// a covered boundary is waited out, and an uncovered one has nothing to wait for.
		const delay = TRANSITION_CONFIG.ENABLED ? TRANSITION_COVER_SECONDS : 0;

		// The refresh re-checks the phase itself, which is what makes a round that ends inside this delay a
		// drop rather than a build — see `refresh`.
		task.delay(delay, () => this.refresh());
	}

	/**
	 * Makes the rings on screen match the phase: everybody has one while a round is on, nobody has one
	 * otherwise.
	 *
	 * **Idempotent by construction, and that is what lets it be called from anywhere.** {@link make} repaints a
	 * ring that is already there rather than replacing it, so a mode change costs a colour write per player and a
	 * phase that is still `Playing` costs nothing at all.
	 *
	 * **Called only after the phase's own delay has passed** — see {@link onPhaseChanged}, which is the only
	 * caller on the phase edge — but it re-checks the phase rather than trusting that: a round that ended inside
	 * the delay lands here as a drop, which is the answer it should have arrived at anyway.
	 */
	private refresh(): void {
		if (!this.isPlaying()) {
			this.dropAll("the phase ended");

			return;
		}

		for (const player of Players.GetPlayers()) this.make(player);
	}

	/** Arranges a ring for `player`: one now if they are in a round, and one on every body after that. */
	private watch(player: Player): void {
		// Per **character** rather than per player, because a character is what the ring hangs off and
		// characters are replaced on every death: subscribed on `PlayerAdded` alone, the first body would wear
		// a ring and every respawn after it would be bare.
		player.CharacterAdded.Connect(() => this.make(player));

		// **And the other half, which parenting used to do for free.** A ring is no longer a child of the body
		// it belongs to, so a body being replaced does not take its ring with it — this is what does, before the
		// `CharacterAdded` above makes the new one. A body that merely *dies* keeps its ring, which is right:
		// the ring is on the floor, and where somebody fell is worth seeing until they come back.
		player.CharacterRemoving.Connect(() => this.drop(player, "the body was replaced"));

		if (player.Character) this.make(player);
	}

	/**
	 * The folder the rings live in, made on first use.
	 *
	 * Nothing ever removes it — the only things this client creates are the rings inside it — so the handle is
	 * cached rather than re-found, and an empty folder between rounds is the whole of what is left behind.
	 */
	private ringFolder(): Folder {
		if (this.folder !== undefined) return this.folder;

		const folder = new Instance("Folder");
		folder.Name = FOLDER_NAME;
		folder.Parent = Workspace;
		this.folder = folder;

		return folder;
	}

	/**
	 * Puts a ring under `player`, or repaints the one they already have.
	 *
	 * **The whole of the lifetime rule is in the first two lines**: no ring unless a round is on, and none for
	 * a body with no side — a spectator, a rig on nobody's team, a player whose label this build does not
	 * recognise. `teamColourOf` answering `undefined` is the same answer the outline falls back to the default
	 * colour on, and here it is "no ring", because a ring is a claim about which side somebody is on and there
	 * is no honest colour to draw that claim in.
	 *
	 * **Idempotent by repaint, not by replacement**, which is the rule this file exists to keep: a ring already
	 * under this body is left where it is and given the colour the answer has now — which is what happens when
	 * a mode changes under a round, and what makes a second call for the same body cost nothing. The guard that
	 * decides that was asking about the ring's *parent* until this was fixed, and the parent is the folder — see
	 * the note on the line itself for what that cost.
	 */
	private make(player: Player): void {
		if (!RING_CONFIG.ENABLED) return;
		if (!this.isPlaying()) return;

		const side = this.sideOf(player);
		if (side === undefined) return;

		const character = player.Character;
		if (!character) return;

		const root = rootOf(character);
		if (root === undefined) return;

		// **"Already has a ring" means a ring that is still in the world, not one still parented to the body.**
		// The rings live in `Workspace.TeamRings`, so the old test — is the parent this character — was a
		// question with one answer, and every call rebuilt the ring, repainted nothing, and *left the previous
		// one in the folder for good*. Those strays are invisible to `dropAll`, which can only destroy what the
		// map holds, so they sat where their body last stood, in the colour of a round that had ended. A
		// `Parent` of nothing is what a destroyed instance looks like here.
		const existing = this.rings.get(player);
		if (existing !== undefined && existing.plates.size() > 0) {
			// **A repaint goes through `applyColour`, which writes the plates and the pictures together.** Doing
			// half of it here is how a ring ends up in two colours, which is the state the texture-era version
			// kept finding itself in.
			this.applyColour(existing, side.colour);

			return;
		}

		// **Built, then stacked, then parented.** `build` touches no world position and no parent, so there is no
		// moment at which a plate exists at the origin or under the wrong body — and `place` is the same call the
		// per-frame loop makes, so a ring's first frame and its thousandth go through one piece of arithmetic.
		const layers = this.build(side.colour);
		const ground = groundUnder(character) ?? root.Position.Y - RING_CONFIG.FALLBACK_DROP;

		this.place(layers, root.Position.X, root.Position.Z, ground);

		for (const plate of layers.plates) plate.Parent = this.ringFolder();

		this.rings.set(player, layers);

		// **Once per round, on the first ring of it.** See `logged` for why it is not per ring: the layers are
		// drawn once for the client and shared, so a line per ring would repeat one answer ten times.
		if (DEBUG && !this.logged) {
			this.logged = true;

			print(
				`[Ring] ${player.Name}: ${side.label} ${side.colour.ToHex()} — ${this.describe(layers)} ` +
					`| ${this.inkSummary()} | ${this.rings.size()} up`,
			);
		}
	}

	/**
	 * One plate: a thin disc of `radius` studs, ready to carry a picture.
	 *
	 * **Invisible, and that is the design rather than a shortcut.** A ring is an annulus and no part is one, so the
	 * shape lives in the picture on the plate; a visible plate would fill the ring's own hole with a solid disc,
	 * which is the one thing the ring must not be. See `RING_CONFIG.PLATE_TRANSPARENCY`.
	 *
	 * **A `Cylinder`'s axis is its `X`**, which is the one thing about this shape that has to be known before it is
	 * written: a disc lying flat is thin on `X` and wide on `Y`/`Z`, and `ringCFrame` supplies the quarter turn that
	 * stands that thin axis up. Without it this is a wheel on its edge.
	 */
	private plate(name: string, radius: number, transparency: number): BasePart {
		const plate = new Instance("Part");

		plate.Name = name;
		plate.Shape = Enum.PartType.Cylinder;
		plate.Size = new Vector3(RING_CONFIG.PLATE_THICKNESS, radius * 2, radius * 2);
		plate.Material = Enum.Material.Neon;
		plate.Transparency = transparency;
		decorate(plate);

		return plate;
	}

	/**
	 * Hangs one picture on both flat faces of `plate`, at `transparency`, and answers the instances it made.
	 *
	 * **Both faces, because only one of them is the one being looked at.** The top is what a camera sees; the
	 * bottom is what shows on the day a ring ends up above the floor instead of on it, and an instance is cheaper
	 * than finding out. The underside shows the picture mirrored, which is not worth correcting for a ring.
	 *
	 * **The faces are the plate's `Right` and `Left` after `ringCFrame`'s quarter turn.** A `Cylinder`'s flat ends
	 * are its `+/-X` faces and that turn stands the axis up, so `Right` is the top of the plate and `Left` is its
	 * underside. Get this wrong and the picture is painted on the plate's rim, where nobody can see it.
	 *
	 * **One picture across the plate rather than a tiled one.** A `Texture` repeats once per stud by default, so a
	 * six-stud plate would show the picture six times in each direction and a gradient would read as a grid.
	 * Setting both axes to the plate's own width makes the picture span it exactly once.
	 *
	 * **The plate's own transparency is not this number.** `BasePart.Transparency` fades the plate and
	 * `Texture.Transparency` fades the picture laid over it, independently of each other — which is exactly the
	 * pair that produced a white ring once, see `applyColour`.
	 */
	private dress(plate: BasePart, picture: Content, transparency: number): Array<Texture> {
		const faces = new Array<Texture>();

		for (const face of [Enum.NormalId.Right, Enum.NormalId.Left]) {
			const texture = new Instance("Texture");
			texture.Name = PICTURE_NAME;
			texture.TextureContent = picture;
			texture.Transparency = transparency;
			texture.StudsPerTileU = plate.Size.Y;
			texture.StudsPerTileV = plate.Size.Z;
			texture.Face = face;
			texture.Parent = plate;

			faces.push(texture);
		}

		return faces;
	}

	/**
	 * Puts `colour` on `layers`: on every part that carries the side's answer, and on the pictures if there are any.
	 *
	 * **Writes both halves because it is one decision.** Every path that changes a ring's colour comes through here
	 * — built, and repainted when a mode changes the answer — so there is no state in which a ring is half
	 * repainted. The halo is not among them: see {@link build} for why a glow is not the side's colour.
	 *
	 * **The rule this replaced is worth keeping, because it looked right and was not.** The colour used to go on the
	 * pictures only, with the plate left at `1,1,1` so that nothing would "multiply the tint twice". Nothing
	 * multiplies: a picture's transparency *blends* it towards what is behind it, so a white plate showed through
	 * every gap in the figure — and the figure's own transparent middle is most of a ring's area. The result was a
	 * white ring with the colour set correctly the whole time.
	 */
	private applyColour(layers: RingLayers, colour: Color3): void {
		for (const plate of layers.team) plate.Color = colour;

		for (const face of layers.tinted) face.Color3 = colour;
	}

	/**
	 * Every part of one ring: the drawn version when this client has its pictures, the parts version when it does
	 * not.
	 *
	 * **The parts version is the one that always exists**, which is why it is the fallback rather than a plain disc.
	 * A drawn ring is one instance per layer and looks exactly like the preview, but it depends on `EditableImage`,
	 * and a client where that is unavailable has to get a ring rather than nothing. See {@link partsRing}.
	 *
	 * **The halo is tinted with `HALO_COLOR` and never with the side's colour**, in both versions — a glow is light
	 * rather than paint, and a halo in the side's own colour reads as a second, softer copy of the ring instead of as
	 * the light coming off it.
	 */
	private build(colour: Color3): RingLayers {
		// **The pictures are only asked for when they are wanted**, which is not the same as asking and ignoring the
		// answer: painting the ring is the expensive half of this file, and a config that says the ring is made of
		// parts should not be paying for an image every round in order to throw it away.
		const pictures = RING_CONFIG.DRAWN_RING ? this.pictures() : undefined;

		if (pictures === undefined) return this.partsRing(colour);

		const plates = new Array<BasePart>();
		const offsets = new Array<CFrame>();
		const team = new Array<BasePart>();
		const tinted = new Array<Texture>();

		// The drawn ring is two discs at the radii the parts version also uses, one `LAYER_GAP` above the other and
		// both flat — `ringCFrame` is what stands a `Cylinder` up on its face.
		const halo = this.plate(HALO_NAME, RING_CONFIG.HALO_RADIUS, RING_CONFIG.PLATE_TRANSPARENCY);
		this.dress(halo, pictures.halo, RING_CONFIG.HALO_TRANSPARENCY);
		for (const face of this.facesOf(halo)) face.Color3 = RING_CONFIG.HALO_COLOR;
		plates.push(halo);
		offsets.push(ringCFrame(Vector3.zero));

		const band = this.plate(RING_NAME, RING_CONFIG.RING_RADIUS, RING_CONFIG.PLATE_TRANSPARENCY);
		for (const face of this.dress(band, pictures.band, RING_CONFIG.RING_TRANSPARENCY)) tinted.push(face);
		plates.push(band);
		offsets.push(ringCFrame(new Vector3(0, RING_CONFIG.LAYER_GAP, 0)));

		const layers: RingLayers = { plates: plates, offsets: offsets, team: team, tinted: tinted };

		this.applyColour(layers, colour);

		return layers;
	}

	/**
	 * Puts every plate of `layers` on the floor at `x`/`z`, stacked upward from `ground`.
	 *
	 * **One implementation for the first frame and every frame after it.** A ring is placed once when it is built
	 * and then sixty times a second, and two copies of this arithmetic is how a stack ends up spaced differently
	 * from the one beside it. See {@link track}.
	 */
	private place(layers: RingLayers, x: number, z: number, ground: number): void {
		// **The ring's own frame first, then each part's offset from it.** Every offset is expressed in the ring's
		// frame — flat on the floor, `+Y` up — and multiplying rather than assigning is what lets a segment keep the
		// angle it was laid out at from wherever the body happens to be this frame. Note that the offsets carry
		// whatever turn each part needs and `centre` carries none: the quarter turn that stands a `Cylinder` on its
		// face is baked into the discs' own offsets, not applied to everything here, and the outline's pieces
		// deliberately do not have it. See {@link partsRing}.
		const centre = new CFrame(new Vector3(x, ground + RING_CONFIG.FLOOR_LIFT, z));

		for (let index = 0; index < layers.plates.size(); index++) {
			layers.plates[index].CFrame = centre.mul(layers.offsets[index]);
		}
	}

	/** The pictures on one plate, so that a colour can be written to every one of them. */
	private facesOf(plate: BasePart): Array<Texture> {
		const found = new Array<Texture>();

		for (const child of plate.GetChildren()) {
			if (child.IsA("Texture") && child.Name === PICTURE_NAME) found.push(child);
		}

		return found;
	}

	/** What the ring is made of, for the once-a-round line: how many parts, and what they are. */
	private describe(layers: RingLayers): string {
		const halo = layers.plates.size() - layers.team.size();

		return (
			`${layers.plates.size()} parts — halo ${halo}, outline+teeth ${layers.team.size()}` +
			`, circle r${RING_CONFIG.RING_RADIUS}/${RING_CONFIG.RING_THICKNESS} thick` +
			`, teeth ${RING_CONFIG.TRIANGLES}×${RING_CONFIG.TRIANGLE_DEPTH}` +
			`, ${layers.tinted.size()} picture face(s)`
		);
	}

	/**
	 * What the pictures hold — or the sentence that says there are none, which is the more useful of the two.
	 *
	 * **The counts are the point of the line.** A layer that drew nothing is the likeliest fault the drawn ring has
	 * — the painter's own history is one of those — and `0 px` says so without anybody having to look at the ring.
	 * And when there are no pictures at all this is where the log admits it, rather than leaving a reader to infer
	 * it from the shape of what they are looking at.
	 */
	private inkSummary(): string {
		const drawn = this.drawn;

		if (drawn === undefined) return "no pictures — the parts ring, which is the one that always draws";

		return `halo ${drawn.haloPixels} px, outline ${drawn.bandPixels} px, figure ${drawn.patternPixels} px`;
	}

	/**
	 * The ring made of ordinary parts: an outline of straight pieces, and teeth pointing in.
	 *
	 * **This is the version that cannot fail to appear.** No image, no content id, no editable-image feature,
	 * nothing that can be unavailable on a client or switched off in a place — just `Part`s in a folder. What it
	 * costs is instance count, `SEGMENTS + TRIANGLES` of them per ring per player, which is why the config's counts
	 * are as low as they are. What it buys is a shape that is *geometry*: the thickness of the circle and the size
	 * of its teeth are numbers that take effect on the next build, rather than an image that has to be redrawn and
	 * re-uploaded.
	 *
	 * **There is no halo here, and its absence is the second correction this layer has needed.** This version had
	 * a stepped halo — `HALO_RINGS` discs, largest and faintest lowest — and on the floor it read as a big white
	 * circle with a ring lying on top of it, which is the one thing a glow must never look like. The reason is in
	 * the geometry: **a part cannot hold a gradient**, so a part-built halo is a few flat discs, and two or three
	 * flat discs six studs wide do not read as light falling off at its rim — they read as a disc. The painted ring
	 * still has a real gradient and still has its halo, and {@link RING_CONFIG.DRAWN_RING} is how you get to it. A
	 * glow is bloom over the outline's `Neon`; that costs no parts at all and has no edge to give itself away.
	 *
	 * **The outline is a polygon, and that is the one thing to know about it.** `SEGMENTS` straight pieces laid
	 * around `RING_RADIUS`, each cut slightly longer than its share of the circumference so the corners meet rather
	 * than leaving slivers of floor between them. `RING_THICKNESS` is a piece's radial extent, so that is what
	 * thickens and slims the circle.
	 *
	 * **The teeth are wedges behind the outline**, bases on the outline's inner edge and points toward the middle,
	 * each `TRIANGLE_DEPTH` long and `TRIANGLE_SPREAD` of the gap between neighbours wide. A wedge's slope is a
	 * *right* triangle rather than a symmetric one, so a tooth leans — a sawtooth rather than a compass rose — and
	 * `TOOTH_FLIP` is what turns them the right way round if the engine's slope runs the other way from this.
	 */
	private partsRing(colour: Color3): RingLayers {
		const plates = new Array<BasePart>();
		const offsets = new Array<CFrame>();
		const team = new Array<BasePart>();

		// **Everything here is at one height, so nothing is lifted.** This was a stack while the halo was the bottom
		// of it, and a lift applied to the outline is now a number that spaces it from something that is not there:
		// it would raise the whole ring off the floor by one `LAYER_GAP` per former halo disc and buy nothing.
		const above = 0;

		// **The outline.** Blocks rather than discs: the circle is the *arrangement* of these, and each one is long
		// along its own tangent and `RING_THICKNESS` along its own radius.
		//
		// **The base frame is a bare one here, not `ringCFrame`.** That helper carries the quarter turn that stands
		// a *cylinder* on its flat face — correct for the discs the painted ring uses, and wrong here: applied to a
		// block it turns the piece's length from tangent to vertical and the ring becomes a row of spikes. So the
		// offsets below start from a plain upright frame, which is what the placement step expects of one anyway.
		const step = (2 * math.pi) / RING_CONFIG.SEGMENTS;
		const chord = 2 * RING_CONFIG.RING_RADIUS * math.sin(step / 2);

		for (let index = 0; index < RING_CONFIG.SEGMENTS; index++) {
			const angle = index * step;
			const segment = new Instance("Part");

			segment.Name = SEGMENT_NAME;
			segment.Size = new Vector3(chord * 1.08, RING_CONFIG.PLATE_THICKNESS, RING_CONFIG.RING_THICKNESS);
			segment.Material = Enum.Material.Neon;
			segment.Transparency = RING_CONFIG.RING_TRANSPARENCY;
			decorate(segment);

			plates.push(segment);
			offsets.push(
				new CFrame(new Vector3(0, above, 0))
					.mul(CFrame.Angles(0, angle, 0))
					.mul(new CFrame(new Vector3(0, 0, RING_CONFIG.RING_RADIUS))),
			);
			team.push(segment);
		}

		// **The teeth**, bases on the outline's inner edge and points `TRIANGLE_DEPTH` further in.
		if (RING_CONFIG.TRIANGLES > 0) {
			const toothStep = (2 * math.pi) / RING_CONFIG.TRIANGLES;
			const inner = RING_CONFIG.RING_RADIUS - RING_CONFIG.RING_THICKNESS;
			const width = toothStep * inner * RING_CONFIG.TRIANGLE_SPREAD;
			const flip = RING_CONFIG.TOOTH_FLIP ? CFrame.Angles(0, math.pi, 0) : CFrame.identity;

			for (let index = 0; index < RING_CONFIG.TRIANGLES; index++) {
				const angle = index * toothStep;
				const tooth = new Instance("WedgePart");

				tooth.Name = TOOTH_NAME;
				tooth.Size = new Vector3(width, RING_CONFIG.PLATE_THICKNESS, RING_CONFIG.TRIANGLE_DEPTH);
				tooth.Material = Enum.Material.Neon;
				tooth.Transparency = RING_CONFIG.RING_TRANSPARENCY;
				decorate(tooth);

				plates.push(tooth);
				offsets.push(
					new CFrame(new Vector3(0, above, 0))
						.mul(CFrame.Angles(0, angle, 0))
						.mul(flip)
						.mul(new CFrame(new Vector3(0, 0, inner - RING_CONFIG.TRIANGLE_DEPTH / 2))),
				);
				team.push(tooth);
			}
		}

		const layers: RingLayers = {
			plates: plates,
			offsets: offsets,
			team: team,
			tinted: new Array<Texture>(),
		};

		this.applyColour(layers, colour);

		return layers;
	}

	/**
	 * This client's two pictures, drawn on first use and kept — or nothing, when it cannot draw them.
	 *
	 * **Once for the client, not once per ring.** The pixels are the same for a ring in either team's colour — the
	 * ink is white and the colour arrives as a tint — so a per-player draw would be the same quarter of a million
	 * bytes computed again for every player on screen.
	 *
	 * **Everything is inside the `pcall`.** Two things can be missing here and neither can be checked for first:
	 * this place may have editable images switched off, and the device may be out of editable memory, which
	 * `CreateEditableImage` documents as answering nothing rather than raising. A ring with no pictures is a plain
	 * disc in the side's colour, which is a deliberate thing to draw, so a failure is not worth a second attempt:
	 * it is remembered, and every ring after it goes straight to the fallback.
	 *
	 * **The warning names the fault, and there are two of them.** "No editable image" is the engine refusing to
	 * give this client somewhere to draw; "the halo drew no pixels" is the painter failing after it was given one.
	 * They have nothing in common but the fallback, and a message that blurred them would send the next reader to
	 * the wrong file. See `shared/ringPattern.ts`.
	 */
	private pictures(): RingArtwork | undefined {
		if (this.drawn !== undefined) return this.drawn;
		if (this.drawnFailed) return undefined;

		let drawn: RingArtwork | undefined;

		const [ok, problem] = pcall(() => {
			drawn = drawLayers();
		});

		if (!ok || drawn === undefined) {
			this.drawnFailed = true;

			warn(`[Ring] no pictures — ${tostring(problem)}; rings fall back to a plain neon disc`);

			return undefined;
		}

		this.drawn = drawn;

		return drawn;
	}

	/**
	 * Puts every ring back under its body, once a frame per client.
	 *
	 * **`X` and `Z` follow the body always, and `Y` follows the *ground* — which is not the same as following
	 * the body.** The ground is measured from the body's own box, so the ring tracks ramps, steps and platforms
	 * for free; while the body is in the air there is no ground to measure, so the ring keeps the height it last
	 * had on the floor and the player jumps over it. That is the choice this file made about where a ring lives
	 * — on the floor, like a marking — and it is only possible because the two axes are computed differently.
	 *
	 * A ring whose body has gone is skipped for the frame or two before its entry is dropped: the body is
	 * replaced by `CharacterRemoving`, which is where the cleanup lives, and a check here to catch the gap would
	 * be a second answer to the same question.
	 */
	private track(): void {
		if (this.rings.size() === 0) return;

		for (const [player, layers] of this.rings) {
			const character = player.Character;
			const root = rootOf(character);
			if (character === undefined || root === undefined) continue;

			const ground = groundUnder(character);
			const position = root.Position;

			// **In the air, a ring keeps the floor it last had** — which is the bottom plate's height with the
			// lift taken back off it, so a jump goes over the ring rather than carrying it. See the doc above.
			const y = ground === undefined ? layers.plates[0].Position.Y - RING_CONFIG.FLOOR_LIFT : ground;

			this.place(layers, position.X, position.Z, y);
		}
	}

	/** Takes `player`'s ring away, and drops the entry whatever happens to the plates. */
	private drop(player: Player, reason: string): void {
		const layers = this.rings.get(player);
		if (layers === undefined) return;

		this.rings.delete(player);

		for (const plate of layers.plates) plate.Destroy();

		if (DEBUG) print(`[Ring] ${player.Name}: ring down — ${reason}, ${this.rings.size()} up`);
	}

	/**
	 * Takes every ring away. See {@link refresh} for the one case that calls it.
	 *
	 * **The folder is swept as well as the map, and that is the belt for the guard fixed in {@link make}.** The
	 * map can only ever hold one ring per player, so a ring that was built and then forgotten — which is what
	 * happened on every call before that fix, and what any future mistake of the same shape would do — is a ring
	 * no map knows about and no `drop` will ever reach. The folder is this client's alone, so clearing it
	 * wholesale is exact rather than approximate, and it means a session that has already collected strays
	 * clears them at the end of the round rather than carrying them to the end of the game.
	 */
	private dropAll(reason: string): void {
		const folder = this.folder;
		const tracked = this.rings.size();

		for (const [, layers] of this.rings) {
			for (const plate of layers.plates) plate.Destroy();
		}

		this.rings.clear();

		// Whatever is still in the folder was never in the map — see the doc above — and this is what makes the
		// folder empty rather than nearly empty.
		const strays = folder !== undefined ? folder.GetChildren() : [];

		for (const stray of strays) stray.Destroy();

		// **A round that has ended has no first ring in it any more**, so the next round prints its layer list
		// again. Nothing else resets `logged`, which is what keeps the line to one per round.
		this.logged = false;

		if (DEBUG && tracked + strays.size() > 0) {
			print(`[Ring] all down — ${tracked + strays.size()} destroyed (${reason})`);
		}
	}

	/** Whether a round is being played right now. */
	private isPlaying(): boolean {
		return this.status?.GetAttribute(ROUND_STATE_ATTRIBUTE) === PLAYING;
	}

	/**
	 * The side `player` is on, as the label to log and the colour to draw — or nothing when there is no honest
	 * answer.
	 *
	 * **Both facts in one place because they come from one reading**, and because the two have to agree: a ring
	 * is drawn in the colour of a side, and a colour whose label this build cannot name is exactly the case
	 * that must produce no ring rather than a default-coloured one.
	 *
	 * **The label is read live rather than remembered**, which is what makes a reassignment repaint correctly:
	 * the colour comes from the shared `TEAM_COLORS` — the same one the outline paints from, so a player's ring
	 * and their outline cannot be two different colours. **The mode is not read here at all**, which is the
	 * change from the version before this: the colour is the same in every mode now. A round starting still
	 * repaints, through the `ROUND_MODE_ATTRIBUTE` connection in `followRound` — and that is the edge that
	 * matters, because it is the moment the labels are written.
	 */
	private sideOf(player: Player): { label: string; colour: Color3 } | undefined {
		const label = player.GetAttribute(TEAM_ATTRIBUTE);

		// Read off an attribute written by a server that may be a version away, so it is checked rather than
		// trusted — the same looseness `teamColourOf` and `sideNameOf` allow for.
		if (!typeIs(label, "string")) return undefined;

		const colour = teamColourOf(label);
		if (colour === undefined) return undefined;

		return { label, colour };
	}
}

/**
 * Draws both pictures, and answers them along with what each layer inked.
 *
 * **Every number here comes from the config**, which is the point of the exercise: the only arithmetic in this
 * function is the one conversion studs cannot avoid — the band's inner edge as a fraction of the radius the picture
 * is inscribed in. Nothing below is a magic number except `255`, which is what "opaque" means in a byte.
 *
 * **It throws rather than returning nothing.** There is one thing to do about any failure here — fall back to a
 * plain disc — so the caller is told *which* failure it was, and a layer that inked nothing counts as one: an empty
 * image is a ring with no picture on it and no error anywhere. See `shared/ringPattern.ts` for the day that
 * happened.
 */
function drawLayers(): RingArtwork {
	const started = os.clock();
	const size = RING_CONFIG.PATTERN.RESOLUTION;

	// The hole, as a fraction of the ring's own radius — the one place studs become picture fractions.
	const innerRadius = (RING_CONFIG.RING_RADIUS - RING_CONFIG.RING_THICKNESS) / RING_CONFIG.RING_RADIUS;

	const haloPixels = buffer.create(size * size * 4);
	const bandPixels = buffer.create(size * size * 4);

	// The teeth reach inward from the outline, so like the hole they are studs turned into picture fractions.
	const toothDepth = RING_CONFIG.TRIANGLE_DEPTH / RING_CONFIG.RING_RADIUS;

	const haloInk = paintHalo(haloPixels, { RESOLUTION: size, FALLOFF: RING_CONFIG.HALO_FALLOFF });
	const bandInk = paintRing(bandPixels, {
		RESOLUTION: size,
		INNER_RADIUS: innerRadius,
		INNER_ALPHA: RING_CONFIG.BAND_INNER_ALPHA,
		PATTERN_CONTRAST: RING_CONFIG.PATTERN_CONTRAST,
		PETALS: RING_CONFIG.PATTERN.PETALS,
		BANDS: RING_CONFIG.PATTERN.BANDS,
		CIRCLE_RATIO: RING_CONFIG.PATTERN.CIRCLE_RATIO,
		ODD_IS_INK: RING_CONFIG.PATTERN.ODD_IS_INK,
		TRIANGLES: RING_CONFIG.TRIANGLES,
		TRIANGLE_DEPTH: toothDepth,
		TRIANGLE_SPREAD: RING_CONFIG.TRIANGLE_SPREAD,
		TRIANGLE_ALPHA: RING_CONFIG.TRIANGLE_ALPHA,
	});

	if (haloInk === 0) throw "the halo drew no pixels";
	if (bandInk.band === 0) throw "the ring's outline drew no pixels";
	if (RING_CONFIG.TRIANGLES > 0 && bandInk.triangles === 0) throw "the teeth drew no pixels";

	if (DEBUG) {
		print(
			`[Ring] pictures drawn — halo ${haloInk} px, outline ${bandInk.band} px, ` +
				`figure ${bandInk.pattern} px, teeth ${bandInk.triangles} px ` +
				`of ${size}² in ${math.floor((os.clock() - started) * 1000)}ms (once per client)`,
		);
	}

	return {
		halo: toContent(haloPixels, size),
		band: toContent(bandPixels, size),
		haloPixels: haloInk,
		bandPixels: bandInk.band,
		patternPixels: bandInk.pattern,
	};
}

/** One drawn image, as the `Content` a `Texture` takes. */
function toContent(pixels: buffer, size: number): Content {
	// Documented as answering nothing when the device's editable memory is exhausted, which is why this is a check
	// the types would not have asked for on their own.
	const image: EditableImage | undefined = AssetService.CreateEditableImage({
		Size: new Vector2(size, size),
	});

	if (image === undefined) throw "no editable image (the device's editable memory is full)";

	image.WritePixelsBuffer(Vector2.zero, image.Size, pixels);

	return Content.fromObject(image);
}

/**
 * Gives one part of a ring the properties every part of a ring needs, and nothing else.
 *
 * **Three flags, all of them load-bearing, and all of them false.** `CanCollide` off is what stops a decoration
 * being a thing people walk into. `CanTouch` off is what stops it sweeping every contact in the game — the ball's
 * own hit test is `Touched`-driven, and a ring that reported a touch would disarm a throw that landed near
 * somebody's feet. `CanQuery` off is what keeps it out of every raycast, which matters twice: the aim guide casts
 * down the throw line and would otherwise hit rings instead of the arena, and there is one of these under every
 * player in the round. `CastShadow` off is because a ring throws a shadow of itself onto the floor it is lying on,
 * which reads as a dark disc underneath a bright one.
 *
 * **A free function rather than a method, because the parts ring builds plain `Part`s and `WedgePart`s beside the
 * placed discs** and all three need the same seven lines. The alternative was to repeat them at three call sites,
 * which is three chances for one of them to be missed.
 */
function decorate(part: BasePart): void {
	part.Anchored = true;
	part.CanCollide = false;
	part.CanTouch = false;
	part.CanQuery = false;
	part.CastShadow = false;
}

/**
 * The frame a ring is drawn in: flat on the ground at `position`.
 *
 * **The quarter turn about `Z` is the whole of it, and it is the thing that goes wrong quietly.** A
 * `Cylinder` stands along its `X` axis, so a part sized `(thickness, diameter, diameter)` is a wheel lying on
 * its rim until it is rotated; a quarter turn about `Z` points that thin axis straight up, which turns the
 * wheel into a disc on the floor. Rotating the part also takes its faces with it, which is why the texture in
 * {@link TeamRingController.make} goes on `Right` rather than `Top`.
 */
function ringCFrame(position: Vector3): CFrame {
	return new CFrame(position).mul(CFrame.Angles(0, 0, math.rad(90)));
}

/**
 * The height of the ground under `character`, or nothing when the body is not on any.
 *
 * **The body's own bounding box, because there is no rig-agnostic formula to use instead.** This replaced
 * `root.Position.Y - Humanoid.HipHeight`, which read as the engine's own statement of where the floor is and
 * is only true of an `R15` body: an `R6` body carries `HipHeight` of `0` and stands with its root three studs
 * up, so the formula answered "the root" and drew the ring through the character's legs — the knees, exactly
 * where a body's root is. **Legs are a property of the avatar**, and the only thing that knows where they end
 * is the body.
 *
 * The lowest point of the model's box *is* where the feet are, for a standing body, a body on a ramp and a body
 * on a crate alike — measured rather than derived, so no rig can disagree with it. `Model.GetBoundingBox` is
 * the box aligned with the model's own orientation, which for a standing body is upright and therefore has a
 * vertical `Y` to read.
 *
 * `Air` from `FloorMaterial` is the documented way to ask "is there ground at all" — the property reads `Air`
 * whenever the humanoid is standing on nothing, which includes every frame of a jump, and a body in the air
 * whose box was measured would take its ring up with it.
 */
function groundUnder(character: Model): number | undefined {
	const humanoid = character.FindFirstChildOfClass("Humanoid");
	if (humanoid === undefined) return undefined;
	if (humanoid.FloorMaterial === Enum.Material.Air) return undefined;

	const [box, size] = character.GetBoundingBox();

	return box.Position.Y - size.Y / 2;
}

/** The root of `character`, if it has one and it is a part. */
function rootOf(character: Model | undefined): BasePart | undefined {
	if (character === undefined) return undefined;

	const root = character.FindFirstChild(ROOT_NAME);

	return root !== undefined && root.IsA("BasePart") ? root : undefined;
}
