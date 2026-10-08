import { OnStart, Service } from "@flamework/core";
import { Players, ReplicatedStorage, Workspace } from "@rbxts/services";
import { AbilityKind } from "shared/ability";
import { POWER_ROSTER } from "shared/config/economy.config";
import { MYSTERY_CONFIG } from "shared/config/mystery.config";
import { MYSTERY_SPAWN_TAG, ROUND_STATE_ATTRIBUTE, ROUND_STATUS_FOLDER } from "shared/constants";
import { taggedPartsInWorkspace } from "shared/taggedParts";
import { EconomyService } from "../economy/EconomyService";
import { SuperService } from "../super/SuperService";
import { insideZone } from "../zone/PracticeZoneService";

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
	/** Whether this box is on a practice floor, which decides what happens when it is taken. */
	inZone: boolean;
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
 * **"Inside a practice zone" is asked of the zone itself**, through `insideZone` in
 * `PracticeZoneService` — the one function in the game that answers the question, which this service
 * imports rather than reimplements. So a spawn point tagged `mysterySpawnPrize` and dropped inside a
 * `practiceZone` part is a fixture, and the same part anywhere else is a lottery; nothing about the part
 * or the tag differs. **If a spawn point is in a zone inside the arena, the practice rule wins**, which
 * follows from the question being about *where the part is* rather than about which map it belongs to.
 *
 * **What it does not do.** It does not know what Pierce, MultiBall or Freeze do — it rolls one of the
 * names in `shared/ability.ts` and hands it over. It does not touch a ball. It does not decide who owns a
 * power: {@link roll} asks `EconomyService.ownsPower` about each member of the roster, so the economy keeps
 * the roster and this file only asks. And it does not remove a box from a player's way when the round ends
 * — it takes the supply away, like every other window in the game: see {@link clearAll}, which is called
 * on the way out of `Playing` and never mid-round.
 *
 * **The look is generated, and the two things an artist owns are named rather than faked.** The colour is
 * a `Color3` walked around the hue wheel three times a second — one property write per box, no per-frame
 * work, and the strongest signal available for the cost. A `Highlight` outlines it through geometry. The
 * six `?` faces need a decal id that does not exist yet ({@link MYSTERY_CONFIG.FACE_DECAL_ID} is empty and
 * is checked before a decal is made) and cell shading needs a texture or a shader, which cannot be
 * approximated by a material and is not pretended here.
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

		// Two loops with different periods, rather than one with a counter. The spawn tick is ten seconds
		// and the colour step is a third of one, and a single loop would need an accumulator to tell them
		// apart — `PracticeZoneService.watch` is the precedent for a permanent loop in a service, and two
		// of them that each say what they wait for are easier to read than one that says two things.
		task.spawn(() => this.watchSpawns());
		task.spawn(() => this.cycleColours());
	}

	/**
	 * The line that says what this service found, in `BallSpawnerService.report`'s shape.
	 *
	 * **It counts the zones, because that is the number that tells you why nothing is happening.** A place
	 * with tagged spawn points and no boxes is either unlucky or entirely on practice floors, and this is
	 * the line that distinguishes the two without anybody having to open the map.
	 */
	private report(): void {
		const spawns = taggedPartsInWorkspace(MYSTERY_SPAWN_TAG);

		let zoned = 0;
		for (const spawn of spawns) if (insideZone(spawn)) zoned += 1;

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
	 * **On the way out every box goes**, whatever made it. A box is only meaningful while a round is being
	 * played — that is the gate the whole feature lives behind — so leaving them standing into the
	 * intermission would leave prizes nobody can use, on a floor about to be cleared.
	 */
	private onPhase(): void {
		if (this.inRound()) {
			this.tick();
			return;
		}

		this.clearAll("the round ended");
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
	 * **The order of the two branches is the whole of the two-rate design.** A point already holding a box
	 * is skipped whatever kind it is; a zoned point is stocked unconditionally; anything else is rolled for
	 * and then checked against the cap. A zoned point sitting after the cap has been reached still gets its
	 * box, which is the exemption `MYSTERY_CONFIG.MAX_TOTAL` documents — `continue` rather than `break` is
	 * what makes it one.
	 */
	private tick(): void {
		this.forgetLostSpawns();

		if (!this.inRound()) return;

		let rolled = this.countRolled();

		for (const spawn of taggedPartsInWorkspace(MYSTERY_SPAWN_TAG)) {
			if (this.boxes.has(spawn)) continue;

			if (insideZone(spawn)) {
				this.place(spawn, true);
				continue;
			}

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
	 * **Anchored at a fixed height, with no bob.** See `MYSTERY_CONFIG.HOVER_HEIGHT` for the arithmetic
	 * that decided against moving it — a floating box whose `CFrame` is written every frame replicates
	 * every frame on every client, which is a great deal of traffic for a cube that nothing aims at.
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
		box.CFrame = spawn.CFrame.add(new Vector3(0, MYSTERY_CONFIG.HOVER_HEIGHT, 0));
		box.Parent = Workspace;

		const highlight = new Instance("Highlight");
		highlight.FillTransparency = 1;
		highlight.OutlineColor = Color3.fromRGB(255, 255, 255);
		highlight.OutlineTransparency = 0.35;
		highlight.DepthMode = Enum.HighlightDepthMode.AlwaysOnTop;
		highlight.Parent = box;

		// **The artist's seam, guarded rather than assumed.** An empty id means no decal is made at all,
		// which is the honest rendering of "this face has no art yet": a `Decal` with an invented id would
		// be a broken image nothing reports, and one with an id that does not resolve is indistinguishable
		// from a typo. The day an id exists it appears on all six faces with no code change.
		if (MYSTERY_CONFIG.FACE_DECAL_ID !== "") {
			// **Six decals rather than one with six faces.** `Decal.Faces` is not a property of the class any
			// more — a `Decal` takes a single `Face`, so a `?` on every side of the cube is a decal per side.
			// It costs nothing today: the loop only runs on the day an id exists.
			for (const face of Enum.NormalId.GetEnumItems()) {
				const decal = new Instance("Decal");
				decal.Name = `Face_${face.Name}`;
				decal.Texture = MYSTERY_CONFIG.FACE_DECAL_ID;
				decal.Face = face;
				decal.Parent = box;
			}
		}

		this.boxes.set(spawn, { spawn, box, inZone });

		// Closed over the spawn point, because the row is keyed by it — see {@link LiveBox}.
		box.Touched.Connect((otherPart) => this.collect(spawn, otherPart));

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
	 * Every guard here is a state the player could have caused in the two seconds they were given: the
	 * round can end, somebody else can take the box this scheduled, and the map can be rebuilt.
	 */
	private scheduleRestock(spawn: BasePart): void {
		task.delay(MYSTERY_CONFIG.ZONE_RESPAWN_DELAY, () => {
			if (!this.inRound()) return;
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
	 * Every box goes: the round ended, or the server is shutting down.
	 *
	 * **`clear` then destroy, rather than a delete per row**, which is the same set of writes without the
	 * question of whether a `Map` may be modified while it is being walked. The `Highlight` and any decal
	 * go with the part, because they are its children.
	 */
	private clearAll(reason: string): void {
		const count = this.boxes.size();
		if (count === 0) return;

		this.boxes.forEach((live) => {
			live.box.Destroy();
		});
		this.boxes.clear();

		if (DEBUG) print(`[Mystery] ${count} box(es) swept — ${reason}`);
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
}
