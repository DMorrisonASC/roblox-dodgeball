import { OnStart, Service } from "@flamework/core";
import { Players, ReplicatedStorage, RunService, Workspace } from "@rbxts/services";
import { AbilityKind } from "shared/ability";
import { POWER_ROSTER } from "shared/config/economy.config";
import { MYSTERY_CONFIG } from "shared/config/mystery.config";
import { MYSTERY_SPAWN_TAG, ROUND_STATE_ATTRIBUTE, ROUND_STATUS_FOLDER } from "shared/constants";
import { taggedPartsInWorkspace } from "shared/taggedParts";
import { EconomyService } from "../economy/EconomyService";
import { SuperService } from "../super/SuperService";
import { insideZoneAt } from "../zone/PracticeZoneService";

/** Prints every box raised, every collection and every sweep. */
const DEBUG = true;

/**
 * What `ROUND_STATE_ATTRIBUTE` says while a round is being played.
 *
 * A literal here rather than an import, which is what `StatsService`, `BallSpawnerService`, `DodgeService`
 * and `OutlineService` each do with the same two words — see `SuperService`'s copy for the full argument.
 */
const PLAYING = "Playing";

/**
 * What a box part is called. **Nothing looks it up by this name, and that is the point of saying so.**
 *
 * The boxes are held in {@link MysteryBoxService.boxes}, keyed by the spawn point that made them, so no
 * part of the game ever has to find one by walking `Workspace` for a string. The name exists so a box is
 * identifiable in Studio's explorer and in an error, and a reader who finds it should not assume a lookup
 * somewhere is depending on it — `LobbySpawn`'s afternoon is the standing lesson on names that get read
 * back.
 */
const BOX_NAME = "MysteryBox";

/**
 * A box that is out, and the thing that produced it.
 *
 * **Keyed by the spawn point rather than by the box**, because the spawn point is the fixed thing: it is
 * what the tick iterates, what "does this point already have a box" is asked about, and what a collection
 * names when it schedules the next one. The box is found from it, never the other way round — which is why
 * the `Touched` handler below is closed over the *spawn* and looks the row up by it.
 */
interface LiveBox {
	spawn: BasePart;
	box: BasePart;
	/** Whether this box is on a practice floor, which decides when it is taken *and* what sweeps it. */
	inZone: boolean;
	/**
	 * The box's resting pose: the spawn point's own orientation, `HOVER_HEIGHT` studs above it.
	 *
	 * **Captured once and kept, rather than recomputed from the spawn point every frame.** The spawn point
	 * does not move, so re-deriving this sixty times a second would be a lookup for a value that is already
	 * fixed — and the animation has to compose *on top of* a pose rather than accumulate into one, which
	 * is the second and larger reason: a rotation added to the previous frame's `CFrame` drifts further out
	 * of step with the clock every time a frame runs long, where multiplying a fixed pose by an angle taken
	 * from the clock cannot.
	 */
	base: CFrame;
}

/**
 * The mystery box: a prize that appears, is walked into, and pays for one use of a power.
 *
 * **What a box is.** A part placed at a `MYSTERY_SPAWN_TAG`-tagged spawn point, floating, `CanCollide =
 * false`, `CanQuery = false` and `CanTouch = true` — the same shape the join pads have, and for the same
 * reason: it must not be an obstacle, must not catch the aim guide's cast, and must still report that a
 * body went through it. Collection is a `Touched` connection and nothing polls proximity.
 *
 * **What a box does, in one sentence: it stands in for a charge for ten seconds.** It does not grant a
 * charge, does not grant ownership, and does not lift the round gate — it makes
 * `SuperService.isMysteryActive` true, and `BallService` asks `hasCharge(player) || isMysteryActive(player)`
 * at the two places a charge is spent. That is the whole of its effect on the game, which is why the
 * mechanic is one `||` in two files rather than a branch anywhere.
 *
 * **Two spawn rates, because a box means two different things.** On the field it is rolled for — 5% per
 * spawn point per ten seconds, capped by `MYSTERY_CONFIG.MAX_TOTAL` — so it stays a rare piece of luck a
 * player happens to be near. **On a practice floor there is no roll and no waiting**: one box per spawn
 * point, raised as soon as the round starts, and a new one `ZONE_RESPAWN_DELAY` seconds after each
 * collection. A practice area is a place you go *to use* a power, and a box you have to wait for there
 * makes practising slower than playing. The caps do not apply inside a zone — they are what bounds the
 * field, and they count the boxes a roll produced.
 *
 * **The practice floor is also exempt from the round, which is a correction rather than a feature.** Every
 * rule here used to sit behind `Playing`, on the reasoning that a box is only meaningful while a round is
 * being played — but a practice floor is exactly the place a player goes *without* a round: solo, between
 * rounds, or on a server where a round never starts because there is nobody to start it with. The zone's own
 * service has never been phase-gated, so the dock, the dodge and the camera lock all already worked in an
 * empty lobby while the one thing a practice floor is *for* refused to exist. A zoned box is furniture of
 * the floor rather than a prize of the round: it is stocked in every phase, it is not swept when a round
 * ends, and it comes back two seconds after it is used whatever the phase is doing. Nothing about the field
 * changed — its roll, its caps and its sweep are all still the round's.
 *
 * **"Inside a practice zone" is asked of the zone itself**, through `insideZoneAt` in
 * `PracticeZoneService` — the one module that answers the question, which this service imports rather than
 * reimplements. So a spawn point tagged `mysterySpawnPrize` and dropped inside a `practiceZone` part is a
 * fixture, and the same part anywhere else is a lottery; nothing about the part or the tag differs. **If a
 * spawn point is in a zone inside the arena, the practice rule wins**, which follows from the question being
 * about *where the part is* rather than about which map it belongs to.
 *
 * **It is `insideZoneAt` rather than that module's `insideZone`, and the difference was a real bug.** The
 * instance form asks the engine whether an instance's bounds overlap a zone, and the engine cannot answer
 * for a part with `CanQuery = false` — which every spawn marker must be, or the aim guide's cast stops at it.
 * The old line therefore reported `0 on a practice floor` for every marker in the place, in every phase, and
 * read as a fact about the map rather than as a query that could not see what it was asked about.
 *
 * **What it does not do.** It does not know what Pierce, MultiBall or Freeze do — it rolls one of the
 * names in `shared/ability.ts` and hands it over. It does not touch a ball. It does not decide who owns a
 * power: {@link roll} asks `EconomyService.ownsPower` about each member of the roster, so the economy keeps
 * the roster and this file only asks. And it does not remove a box from a player's way when the round ends
 * — it takes the *field's* supply away, like every other window in the game: see {@link sweepField}, called
 * on the way out of `Playing` and never mid-round. A practice floor's box is the floor's rather than the
 * round's, so it is not swept with them.
 *
 * **The look is generated, and the two things an artist owns are named rather than faked.** The box
 * *moves*: it floats and it turns, one `CFrame` write per box per frame, which is the cost
 * `MYSTERY_CONFIG.HOVER_HEIGHT` used to argue against and now argues for — that entry carries the
 * arithmetic and the two things that changed. The colour is a `Color3` walked around the hue wheel three
 * times a second, on a loop of its own, because three writes a second and sixty a second are the same
 * colour twenty frames out of twenty. A `Highlight` outlines it through geometry. The six `?` faces are
 * **drawn rather than textured** — a `SurfaceGui` and a `TextLabel` per face — so the box reads as a mystery
 * box with no asset behind it, and {@link MYSTERY_CONFIG.FACE_DECAL_ID} is the seam an artist replaces them
 * through: set it and the text is not built at all. Cell shading needs a texture or a shader, which cannot be
 * approximated by a material and is not pretended here.
 *
 * **No `HingeConstraint`, and that is a decision rather than an omission.** It was the tool the old
 * `HOVER_HEIGHT` entry recommended, and it is the right tool for a body that a physical joint should hold
 * up — which is not this: see that entry for what a rig would have to contain and what an unanchored box
 * would give up.
 */
@Service()
export class MysteryBoxService implements OnStart {
	/**
	 * Every box that is out, keyed by the spawn point that produced it.
	 *
	 * The single source of truth for the four questions this service asks: whether a point already has a
	 * box, how many are out, which points are zoned, and which box a `Touched` event belongs to. Nothing is
	 * looked up by scanning `Workspace`.
	 */
	private readonly boxes = new Map<BasePart, LiveBox>();

	/**
	 * The frame loop that moves the boxes, or nothing while there is nothing to move.
	 *
	 * **A connection that comes and goes rather than a permanent one.** Boxes exist only while a round is
	 * being played, so a loop that was always connected would spend the whole intermission — and the whole
	 * of the lobby — calling a Lua function sixty times a second to walk an empty map. It is created in
	 * {@link startMotion} and dropped in {@link stopMotion}, which are the two ends of the same fact.
	 */
	private motion?: RBXScriptConnection;

	constructor(
		/**
		 * Asked for two things and told one: whether a window is open, and to open one. The clock, the
		 * publication and the ten seconds are all that service's — see `openMysteryWindow`, which takes the
		 * duration from here rather than reading a config of its own, because how long a *box's* window
		 * lasts is the box's number.
		 */
		private readonly windows: SuperService,

		/** The roster, and the only thing this service asks it: whether a player owns a power. */
		private readonly economy: EconomyService,
	) {}

	public onStart(): void {
		this.report();
		this.watchPhase();

		// **The practice floors are stocked now rather than on the first tick.** A practice box is furniture
		// of the floor, so a player who joins an empty server — where no round will ever start — should find
		// one waiting rather than one arriving ten seconds later. The field is not rolled here by accident:
		// outside a round the roll below is not reached at all, so this call can only ever raise zoned boxes.
		this.tick();

		// Two loops with different periods, rather than one with a counter. The spawn tick is ten seconds
		// and the colour step is a third of one, and a single loop would need an accumulator to tell them
		// apart — `PracticeZoneService.watch` is the precedent for a permanent loop in a service, and two
		// of them that each say what they wait for are easier to read than one that says two things.
		//
		// **The animation is deliberately not here, unlike these two.** See {@link startMotion}: a frame
		// loop has nothing to do until a box exists, and the boxes exist for a fraction of a session.
		task.spawn(() => this.watchSpawns());
		task.spawn(() => this.cycleColours());
	}

	/**
	 * The line that says what this service found, in `BallSpawnerService.report`'s shape.
	 *
	 * **It counts the zones, because that is the number that tells you why nothing is happening.** A place
	 * with tagged spawn points and no boxes is either unlucky or entirely on practice floors, and this is
	 * the line that distinguishes the two without anybody having to open the map.
	 *
	 * **The count is a point test, not a query**, which is the difference between this line being true and
	 * being a confident zero: see `PracticeZoneService.insideZoneAt`. A `mysterySpawnPrize` marker is
	 * non-queryable by requirement, so a bounds query cannot see one and would report `0 on a practice floor`
	 * for a floor that is entirely practice.
	 */
	private report(): void {
		const spawns = taggedPartsInWorkspace(MYSTERY_SPAWN_TAG);

		let zoned = 0;
		for (const spawn of spawns) if (insideZoneAt(spawn.Position)) zoned += 1;

		print(
			`[Mystery] up — watching RoundStatus.State, ${MYSTERY_SPAWN_TAG}: ${spawns.size()} tagged thing(s),` +
				` ${zoned} on a practice floor`,
		);

		// **A queryable spawn point is reported by name, because it fails silently and somewhere else.** The
		// box is built with its own flags, so nothing here is affected by how the *marker* was painted — but
		// a marker left queryable is a part the aim guide's cast stops at, and the symptom is a player's aim
		// going wrong near a spot with nothing visibly there. Nothing is written to the part: it is the
		// painter's property and a runtime write could be saved back into the place file. It is named here so
		// somebody who did not know they had to change it can find out which part to change.
		const queryable = spawns.filter((spawn) => spawn.CanQuery);
		if (!queryable.isEmpty()) {
			warn(
				`[Mystery] ${queryable.size()} ${MYSTERY_SPAWN_TAG} part(s) still CanQuery — the aim guide will hit them: ` +
					queryable.map((spawn) => spawn.GetFullName()).join(", "),
			);
		}
	}

	/** The round boundary, listened for rather than polled, so a box is never left out of a round. */
	private watchPhase(): void {
		const folder = ReplicatedStorage.WaitForChild(ROUND_STATUS_FOLDER);

		folder.GetAttributeChangedSignal(ROUND_STATE_ATTRIBUTE).Connect(() => this.onPhase());
	}

	/**
	 * A round opened or closed.
	 *
	 * **On the way in this stocks the zones immediately**, which is the addendum's rule: a practice floor's
	 * boxes appear when the round does, not on the next tick. The same call also makes the field's first
	 * roll, which is deliberate — the phase change *is* a ten-second slot, and a round that opens without
	 * one would be the only slot in the game that never rolls.
	 *
	 * **On the way out the *field* is swept and the practice floor is left alone**, which is the one thing
	 * about this that changed. A rolled box is a prize of the round — it is meaningless the moment the round
	 * is over, and leaving it standing would leave a prize nobody can use on a floor about to be cleared —
	 * where a zoned box is the floor's own furniture, and the floor is most useful precisely when no round is
	 * running. Sweeping them together was what made a practice box vanish every time a round ended.
	 */
	private onPhase(): void {
		if (this.inRound()) {
			this.tick();
			return;
		}

		this.sweepField("the round ended");
	}

	/** Whether a round is being played, read from the same attribute every other gate in the game reads. */
	private inRound(): boolean {
		const folder = ReplicatedStorage.FindFirstChild(ROUND_STATUS_FOLDER);
		return folder?.GetAttribute(ROUND_STATE_ATTRIBUTE) === PLAYING;
	}

	/** Asks every spawn point, forever. This is the field's rate and nothing else's. */
	private watchSpawns(): void {
		while (true) {
			task.wait(MYSTERY_CONFIG.SPAWN_TICK_INTERVAL);

			this.tick();
		}
	}

	/**
	 * One pass over every tagged spawn point: tidy up, then decide whether each one gets a box.
	 *
	 * **The order of the branches is the whole of the two-rate design.** A point already holding a box is
	 * skipped whatever kind it is; a zoned point is stocked unconditionally; anything else is rolled for and
	 * then checked against the cap. A zoned point sitting after the cap has been reached still gets its box,
	 * which is the exemption `MYSTERY_CONFIG.MAX_TOTAL` documents — `continue` rather than `break` is what
	 * makes it one.
	 *
	 * **The round gate is now inside the loop rather than above it, and that is the fix for a practice floor
	 * with no box on it.** Every branch used to sit behind `if (!this.inRound()) return`, so a server running
	 * with one player — where a round never opens — raised nothing at all, practice floor included. The gate
	 * belongs to the *roll*: a rolled box is a round's prize and only means anything during one. A zoned box
	 * is the floor's furniture and a practice floor is exactly where a player goes when there is no round to
	 * play. The zone's own service has never been phase-gated — the dock, the dodge and the camera lock all
	 * work in an empty lobby — so this is the last thing in the game that was refusing to.
	 */
	private tick(): void {
		this.forgetLostSpawns();

		const inRound = this.inRound();
		let rolled = inRound ? this.countRolled() : 0;

		for (const spawn of taggedPartsInWorkspace(MYSTERY_SPAWN_TAG)) {
			if (this.boxes.has(spawn)) continue;

			if (insideZoneAt(spawn.Position)) {
				this.place(spawn, true);
				continue;
			}

			if (!inRound) continue;

			if (rolled >= MYSTERY_CONFIG.MAX_TOTAL) continue;

			// `math.random()` with no arguments is the half-open [0, 1) interval, which is what makes the
			// chance the value in the config rather than that value minus one in a million.
			if (math.random() >= MYSTERY_CONFIG.SPAWN_CHANCE) continue;

			this.place(spawn, false);
			rolled += 1;
		}
	}

	/** How many boxes the *roll* has put out, which is the number the total cap is about. */
	private countRolled(): number {
		let count = 0;

		// **`forEach` rather than `.values()`, which roblox-ts's `Map` does not provide.** These are the
		// `noLib` collection shims, and of the ES6 iteration helpers only plain `for...of` over the map
		// itself exists — so every walk of this container in this file is a `forEach`, and a `.values()` or
		// `.keys()` call added anywhere in it is a compile error rather than a surprise at runtime.
		this.boxes.forEach((live) => {
			if (!live.inZone) count += 1;
		});

		return count;
	}

	/**
	 * Drops the row for any spawn point that has left the world, and the box with it.
	 *
	 * **A spawn point can legitimately disappear mid-round** — a map swap, somebody moving the map model in
	 * Studio, a map being rebuilt between rounds — and a row for a part that is gone would be a box nothing
	 * can collect and a point the tick will never stock again, because the lookup is by instance. The test
	 * is `IsDescendantOf(Workspace)` rather than `Parent !== undefined`, the same guard
	 * `BallSpawnerService` and `BallPickupService` use: a part moved into `ServerStorage` is not in play and
	 * must not be written to.
	 */
	private forgetLostSpawns(): void {
		for (const [spawn, live] of this.boxes) {
			if (spawn.IsDescendantOf(Workspace)) continue;

			this.boxes.delete(spawn);
			live.box.Destroy();

			if (DEBUG) print(`[Mystery] a ${MYSTERY_SPAWN_TAG} part left the world — its box went with it`);
		}
	}

	/**
	 * Puts a box at `spawn`.
	 *
	 * **`CanCollide = false`, `CanQuery = false`, `CanTouch = true`, and all three are load-bearing.** It
	 * must not be an obstacle for a body to bump into on the way past; it must not stop the aim guide's
	 * cast or a throw probe, which treat a `CanQuery` part as the world; and it must still fire `Touched`,
	 * which is the entire detection mechanism — the case `BallService` records as the reason `CanTouch`
	 * exists as a property separate from collision. Being non-colliding also means **no collision group
	 * applies**, so there is nothing to register for a box in `CollisionGroups`: the engine never considers
	 * a contact for a part that cannot collide. It is kept out of the ball systems by *not wearing the
	 * `Ball` tag*, which is what those services go by.
	 *
	 * **Anchored, and then moved by hand rather than by the simulation.** `Anchored = true` is what makes
	 * the box's position this service's to decide. An unanchored box would fall, and a rig to hold it up is
	 * what {@link MYSTERY_CONFIG.HOVER_HEIGHT} used to recommend and now argues against: a constraint needs
	 * something to be attached *to*, so it is an invisible anchored part, two attachments, an assembly and
	 * a collision story — and it gives up the anchored box, which is the box players cannot nudge, the
	 * physics step does not own, and nothing can send to `FallenPartsDestroyHeight`.
	 *
	 * **The pose written here is the bottom of the float, and the animation takes it from there.** A box is
	 * always born at rest and is in phase with every other box one frame later, which is invisible because
	 * being born is the one moment a player has no expectation of where the box should be.
	 */
	private place(spawn: BasePart, inZone: boolean): void {
		const box = new Instance("Part");
		box.Name = BOX_NAME;
		box.Shape = Enum.PartType.Block;
		box.Size = Vector3.one.mul(MYSTERY_CONFIG.SIZE);
		box.Anchored = true;
		box.CanCollide = false;
		box.CanQuery = false;
		box.CanTouch = true;
		box.Material = Enum.Material.SmoothPlastic;
		box.Color = Color3.fromHSV(0, 0.65, 1);
		const base = spawn.CFrame.add(new Vector3(0, MYSTERY_CONFIG.HOVER_HEIGHT, 0));
		box.CFrame = base;
		box.Parent = Workspace;

		const highlight = new Instance("Highlight");
		highlight.FillTransparency = 1;
		highlight.OutlineColor = Color3.fromRGB(255, 255, 255);
		highlight.OutlineTransparency = 0.35;
		highlight.DepthMode = Enum.HighlightDepthMode.AlwaysOnTop;
		highlight.Parent = box;

		// **The artist's seam, guarded rather than assumed, with a stand-in on the other side of the guard.**
		// An empty id still means no decal is made — a `Decal` with an invented id is a broken image nothing
		// reports, and one with an id that does not resolve is indistinguishable from a typo — but "no art
		// yet" is not the same as "no `?` yet". The glyph is *drawn* instead, as text on each face, so the box
		// reads as a mystery box today and an uploaded texture replaces it without this file changing. The two
		// branches are exclusive, and the id one wins.
		if (MYSTERY_CONFIG.FACE_DECAL_ID !== "") {
			// **Six decals rather than one with six faces.** `Decal.Faces` is not a property of the class any
			// more — a `Decal` takes a single `Face`, so a `?` on every side of the cube is a decal per side.
			for (const face of Enum.NormalId.GetEnumItems()) {
				const decal = new Instance("Decal");
				decal.Name = `Face_${face.Name}`;
				decal.Texture = MYSTERY_CONFIG.FACE_DECAL_ID;
				decal.Face = face;
				decal.Parent = box;
			}
		} else {
			// **Six `SurfaceGui`s, one per face, for the same reason the decals are six.** A `SurfaceGui` takes
			// a single `Face` too, and one parented to the part draws on that side of it and turns with the box
			// — which is what makes the glyph come round as the box spins.
			//
			// **Text rather than a texture, and that is the whole of the difference.** It costs no asset id and
			// no artist, it stays crisp at any size because it is drawn from a font rather than sampled from an
			// image, and it is what makes this the stand-in rather than the shape of the feature: the branch
			// above takes over the moment an id exists and none of this runs.
			//
			// **The font is left at the default on purpose.** The bold faces of `Enum.Font` are either
			// deprecated in the installed typings or reachable only through the `Font` datatype, and a stand-in
			// is the wrong place to take either on. The default renders the character plainly; the art is where
			// the look gets decided.
			for (const face of Enum.NormalId.GetEnumItems()) {
				const surface = new Instance("SurfaceGui");
				surface.Name = `Face_${face.Name}`;
				surface.Face = face;
				surface.SizingMode = Enum.SurfaceGuiSizingMode.PixelsPerStud;
				surface.PixelsPerStud = 50;
				// **Unlit, so the glyph is the same white on the shaded faces as on the lit one.** White is also
				// what the `Highlight`'s outline is made of, so the two read as one object rather than as a
				// label somebody stuck on the side of a box.
				surface.LightInfluence = 0;
				// `AlwaysOnTop` is left off, and that is what keeps each glyph on its own face: switched on,
				// all six would show through the box from every direction at once.
				surface.Parent = box;

				const glyph = new Instance("TextLabel");
				glyph.Name = "Question";
				// **Inset to 72% of the face, which is not padding for its own sake.** A glyph that reached the
				// edge would meet the `Highlight`'s outline there and the two would fight over the same pixels;
				// the margin is what keeps the `?` clear of its own outline from every angle.
				glyph.Size = new UDim2(0.72, 0, 0.72, 0);
				glyph.Position = new UDim2(0.14, 0, 0.14, 0);
				glyph.BackgroundTransparency = 1;
				glyph.Text = "?";
				glyph.TextScaled = true;
				glyph.TextColor3 = Color3.fromRGB(255, 255, 255);
				glyph.Parent = surface;
			}
		}

		this.boxes.set(spawn, { spawn, box, inZone, base });

		// Closed over the spawn point, because the row is keyed by it — see {@link LiveBox}.
		box.Touched.Connect((otherPart) => this.collect(spawn, otherPart));

		// **The animation starts here, which is the only place a box can appear.** Both of `place`'s callers
		// — the tick and a zoned restock — are the same event as far as this is concerned, so the check for
		// "is the loop already running" belongs in the one function they share rather than at each of them.
		this.startMotion();

		if (DEBUG) {
			print(`[Mystery] box up at ${spawn.GetFullName()}${inZone ? " (practice floor)" : ""}`);
		}
	}

	/**
	 * Somebody walked into a box.
	 *
	 * **A `Touched` connection and no proximity poll**, because a non-colliding part still reports touches
	 * — the property was added for exactly this. There is no debounce, and none is needed: the first call
	 * removes the row, so the arm, the leg and the torso that all passed through in the same frame find
	 * nothing on the second call, and the handler is silent rather than a second prize.
	 *
	 * **A dead body collects nothing**, and the test is on the `Humanoid` rather than on the round: a body
	 * at nought health is one whose round is over, and a prize handed to it would be spent on the ten
	 * seconds after the respawn.
	 */
	private collect(spawn: BasePart, otherPart: BasePart): void {
		const live = this.boxes.get(spawn);
		if (!live) return;

		const character = otherPart.FindFirstAncestorOfClass("Model");
		if (!character) return;

		// Not a character check by name or by class — `GetPlayerFromCharacter` is the engine's own answer,
		// and it returns nothing for the arena, a barrier or an NPC rig.
		const player = Players.GetPlayerFromCharacter(character);
		if (!player) return;

		const humanoid = character.FindFirstChildOfClass("Humanoid");
		if (!humanoid || humanoid.Health <= 0) return;

		// **Consumed before the roll**, so a collection that grants nothing still costs the box. The box
		// was picked up; nothing in the game gives one back.
		this.remove(spawn);

		const kind = this.roll(player);
		if (kind === undefined) {
			if (DEBUG) print(`[Mystery] ${player.Name}: collected a box owning no powers — nothing to grant`);

			return;
		}

		// **The one call that changes the game**, and its refusal is not an error: a second box collected
		// during a live window is a box whose power the player already has. See `openMysteryWindow`.
		const opened = this.windows.openMysteryWindow(player, kind, MYSTERY_CONFIG.WINDOW_SECONDS);

		// **A practice floor's box comes back when it is *used*, not when it is *touched*.** Only a
		// collection that actually paid for something restocks the point, and the thing that forces this is a
		// loop: a box floats two studs above its spawn point, which is exactly where a standing player's
		// torso is, so somebody standing on the spot overlaps the box the instant it is raised and collects it
		// in the same frame. Restocking on every collection there would spend the session handing them boxes
		// whose power they already have — one every two seconds, none of them usable, and a box visibly
		// flickering in and out of existence beside them.
		//
		// **It is also why the two rates are not enough by themselves.** The ten-second tick below stocks a
		// zoned point unconditionally, so a refused collection costs at most one tick and the point is never
		// left empty; what this line avoids is a *fast* loop on top of a rule that is already correct at the
		// slow one. A player whose window has closed gets their next box from the tick, which is the field's
		// rate and the right one for a point nobody useful is standing in.
		if (live.inZone && opened) this.scheduleRestock(spawn);

		if (DEBUG) {
			print(
				opened
					? `[Mystery] ${player.Name}: ${kind}, free for ${MYSTERY_CONFIG.WINDOW_SECONDS}s`
					: `[Mystery] ${player.Name}: rolled ${kind} with a window already open — the box was spent`,
			);
		}
	}

	/**
	 * Puts a practice floor's box back a couple of seconds after one was **used**.
	 *
	 * **A delayed raise rather than a shorter tick**, because the two rates are different rules: the tick is
	 * "how often is the field asked", and this is "how long after *this* collection does *this* point
	 * restock". A tick short enough to serve a zone would be rolling for the whole arena four times a
	 * second.
	 *
	 * **Called only for a collection that paid for something** — see the call site for the loop that would
	 * otherwise be built in, and for why the tick makes that safe rather than a gap.
	 *
	 * **The phase is not one of the guards**, and dropping it is part of the same fix as the round gate in
	 * {@link tick}: a practice floor's box is due back two seconds after it is used, whatever the round is
	 * doing — including on a server where no round will ever start. The guards that remain are the states the
	 * player could have caused in those two seconds: somebody else took the box this scheduled, or the map
	 * was rebuilt under it.
	 */
	private scheduleRestock(spawn: BasePart): void {
		task.delay(MYSTERY_CONFIG.ZONE_RESPAWN_DELAY, () => {
			if (this.boxes.has(spawn)) return;
			if (!spawn.IsDescendantOf(Workspace)) return;

			this.place(spawn, true);
		});
	}

	/**
	 * Rolls one power the player owns.
	 *
	 * **Over `POWER_ROSTER`, asked of `EconomyService.ownsPower` one member at a time** — the roster itself
	 * lives in `shared/config/economy.config.ts` and the *ownership* answer lives in `EconomyService`, and
	 * this is the join between them. The alternative, reading the player's record directly, would mean this
	 * file knowing the shape of an economy record to answer a question the economy already answers.
	 *
	 * **Nothing owned means nothing granted**, and the caller consumes the box anyway: a player who owns no
	 * powers gets no power, no window and no toast. The alternative — a fallback to the whole roster — would
	 * make a box a way to *obtain* a power rather than to use one, which is the mechanic the chest owns.
	 */
	private roll(player: Player): AbilityKind | undefined {
		const owned = new Array<AbilityKind>();

		for (const kind of POWER_ROSTER) if (this.economy.ownsPower(player, kind)) owned.push(kind);

		if (owned.size() === 0) return undefined;

		// `math.random(1, n)` is inclusive at both ends, so the index is the whole array and never its end.
		return owned[math.random(1, owned.size()) - 1];
	}

	/** Takes a box away, if it is still there. Silent when it is not, which is the ordinary second call. */
	private remove(spawn: BasePart): LiveBox | undefined {
		const live = this.boxes.get(spawn);
		if (!live) return undefined;

		this.boxes.delete(spawn);
		live.box.Destroy();

		return live;
	}

	/**
	 * Every boxed prize of the round goes: the round ended.
	 *
	 * **Only the *rolled* boxes, and the practice floors keep theirs.** A box from a roll is meaningless once
	 * the round is over — nobody can spend a window on a floor about to be cleared — where a zoned box belongs
	 * to the floor rather than to the round, and the floor is used most when no round is running. This used to
	 * destroy both and was called `clearAll`; the name changed with the behaviour because "all" was the part
	 * that was wrong.
	 *
	 * **Two passes, a collected key list and then a delete per row**, which is `clearAll`'s own preference
	 * kept: a `Map` modified while it is being walked is a question worth not answering when the alternative
	 * is one array. The array is only allocated when there is something in it to delete.
	 */
	private sweepField(reason: string): void {
		const swept: BasePart[] = [];

		this.boxes.forEach((live, spawn) => {
			if (!live.inZone) swept.push(spawn);
		});

		if (swept.size() === 0) return;

		for (const spawn of swept) {
			const live = this.boxes.get(spawn);
			if (live === undefined) continue;

			this.boxes.delete(spawn);
			live.box.Destroy();
		}

		if (DEBUG) print(`[Mystery] ${swept.size()} field box(es) swept — ${reason}`);
	}

	/**
	 * Walks the hue wheel, three steps a second, over every box that is out.
	 *
	 * **A shared colour rather than a phase per box**, because the boxes are the same prize and there is no
	 * order to them; a per-box offset would be a counter and a counter would imply a meaning nobody reads.
	 *
	 * **The step is calculated from `os.clock()` rather than accumulated**, so a long frame cannot put the
	 * cycle permanently out of step with itself, and the loop can sleep for as long as it likes between
	 * steps without drifting. One property write per box per step, which is the cheapest thing that reads
	 * as "this is not scenery".
	 *
	 * **It did not move onto the frame loop when that loop arrived, and it should not.** The cycle is
	 * twelve discrete colours over four seconds, so there is genuinely nothing to write between steps: a
	 * colour computed per frame would be the same colour for twenty consecutive frames and then change,
	 * which is sixty writes a second to arrive at three. The box's motion and its colour are also two
	 * different sentences — motion says *this is a thing*, and only the colour says *this is a prize* —
	 * so they are kept on the loops whose rates match what each is saying. The frequency is unchanged from
	 * what it always was: three steps a second.
	 */
	private cycleColours(): void {
		const step = MYSTERY_CONFIG.RAINBOW_PERIOD / MYSTERY_CONFIG.RAINBOW_COLOUR_COUNT;

		while (true) {
			task.wait(step);

			if (this.boxes.size() === 0) continue;

			const index = math.floor(os.clock() / step);
			const hue = (index % MYSTERY_CONFIG.RAINBOW_COLOUR_COUNT) / MYSTERY_CONFIG.RAINBOW_COLOUR_COUNT;
			const colour = Color3.fromHSV(hue, 0.65, 1);

			this.boxes.forEach((live) => {
				live.box.Color = colour;
			});
		}
	}

	/**
	 * Starts the animation, if it is not already running.
	 *
	 * **The only caller is {@link place}**, so the loop exists exactly while there is something to animate
	 * and there is never a window in which a box is out and nothing is moving it. The guard is here rather
	 * than at `place`'s two callers because both of them are the same event as far as this is concerned: a
	 * box appearing.
	 */
	private startMotion(): void {
		if (this.motion !== undefined) return;

		this.motion = RunService.Heartbeat.Connect(() => this.stepMotion());
	}

	/**
	 * Floats and turns every box, once a frame.
	 *
	 * **`Heartbeat` rather than `RenderStepped`, and the choice is forced rather than preferred.** This is a
	 * server service and `RenderStepped` is the client's pre-render step; the installed typings do not mark
	 * it as client-only, which is why the choice is written down here instead of being left to a type error
	 * to enforce. `Heartbeat` also fires *after* the physics step, which is the right side of it for a part
	 * whose position is decided here rather than by the simulation.
	 *
	 * **Everything is computed from the clock, and nothing accumulates.** A long frame cannot put the float
	 * or the turn out of step with itself, and the loop can stop and start between boxes without a box's
	 * appearance depending on when it happened to be made. It is the argument {@link cycleColours} makes for
	 * its own step, and it has the same consequence: every box out is in phase with every other, which is
	 * correct because they are the same prize.
	 *
	 * **The clock is `time()` rather than the `os.clock()` that {@link cycleColours} uses**, and the
	 * difference is what the installed typings say about the two: `os.clock` is documented as *CPU* time —
	 * Lua's own wording for it — and `time()` as "time since the game started running". An animation paced
	 * by CPU time would speed up under load and stall when the server is idle, which is the opposite of what
	 * a float is for. The colour loop is left as it is rather than quietly aligned: its subject is the hue
	 * step, and moving its clock is a change with its own evidence to gather. Reported rather than changed.
	 *
	 * **All three parts compose into one `CFrame` write per box per frame.** `base` is the resting pose
	 * captured when the box was made; the turn is applied in that pose's own frame, so it rotates the box
	 * rather than fighting the spawn point's orientation; and the float is added in *world* space
	 * afterwards, so a box that is turning still rises straight up rather than along whatever its own up
	 * happens to be at that instant.
	 *
	 * **What it costs.** One write per box per frame, which at `MAX_TOTAL` (3) rolled boxes is 180 writes a
	 * second at 60 Hz — plus one per zoned spawn point, which is a practice floor's own count and is
	 * unbounded by the caps. See `MYSTERY_CONFIG.HOVER_HEIGHT` for the argument that accepted this.
	 */
	private stepMotion(): void {
		const clock = time();

		// A cosine rather than a sine, so a box is at `HOVER_HEIGHT` the instant it is made and eases upward
		// from there — the endpoints of a cosine are its extremes, so the float also comes to rest at the
		// top and bottom of each cycle instead of reversing abruptly at them. See `HOVER_BOB_PERIOD`.
		const float =
			(MYSTERY_CONFIG.HOVER_BOB_HEIGHT / 2) *
			(1 - math.cos((clock / MYSTERY_CONFIG.HOVER_BOB_PERIOD) * math.pi * 2));

		// The remainder is taken rather than left to grow: `os.clock()` counts seconds since the server
		// started, and the angle is fed to `CFrame.Angles`, which wants a small number of radians and would
		// otherwise be handed a value in the millions by the end of a session.
		const angle = ((clock / MYSTERY_CONFIG.HOVER_SPIN_PERIOD) * math.pi * 2) % (math.pi * 2);

		this.boxes.forEach((live, spawn) => {
			// **A box that is not in the world is never written to, and its row goes with it.** Every path
			// in this service that destroys a box deletes its row *first* — {@link remove}, {@link sweepField}
			// and {@link forgetLostSpawns} all put the map and the world in that order — so this walk cannot
			// reach a destroyed part through this service. What this covers is a box removed by something
			// *else*, and both halves are deliberate: a `CFrame` write to an instance that is gone is
			// silently dropped, and the row left behind is what would stop that spawn point ever restocking,
			// because the tick skips a point that already has a box. Removing the *current* key during a
			// walk is defined in Luau and is what `forgetLostSpawns` already relies on; `sweepField` avoids it
			// by collecting the keys it means to drop first.
			if (!live.box.IsDescendantOf(Workspace)) {
				this.boxes.delete(spawn);

				if (DEBUG) print(`[Mystery] a box was removed from the world — its row went with it`);

				return;
			}

			live.box.CFrame = live.base.mul(CFrame.Angles(0, angle, 0)).add(new Vector3(0, float, 0));
		});

		// **The loop stops itself when there is nothing left to move.** A `Heartbeat` connection that returns
		// immediately is still a Lua call every frame, and the map is empty for the whole intermission — the
		// boxes exist only while a round is being played. Disconnecting here rather than at each of the four
		// places a box can go is one rule instead of four, and the price is a single empty frame after the
		// last box of a round.
		if (this.boxes.size() === 0) this.stopMotion();
	}

	/**
	 * Stops the animation.
	 *
	 * **It is disconnected from inside its own callback in the ordinary case**, which is defined rather than
	 * lucky: `stepMotion` is what decides the map is empty, and it is the only thing that runs on the frame.
	 * The alternative — a flag the callback checks and returns on — would be a connection still being called
	 * sixty times a second in order to do nothing, which is the whole cost this arrangement exists to avoid.
	 */
	private stopMotion(): void {
		this.motion?.Disconnect();
		this.motion = undefined;
	}
}
