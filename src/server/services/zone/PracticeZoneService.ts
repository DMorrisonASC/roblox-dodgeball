import { OnStart, Service } from "@flamework/core";
import { CollectionService, Players, Workspace } from "@rbxts/services";
import { PRACTICE_BALL_TAG, PRACTICE_SPAWN_TAG, PRACTICE_ZONE_ATTRIBUTE, PRACTICE_ZONE_TAG } from "shared/constants";
import { taggedPartsInWorkspace } from "shared/taggedParts";
import { LOGGING_ENABLED, logInfo, logWarn } from "shared/logger";
import { setPracticePlayer } from "../../collision/CollisionGroups";
import { BallSpawnerService } from "../ball/BallSpawnerService";
import { BallService } from "../ball/BallService";

/**
 * How often every player is tested against the zone, in seconds.
 *
 * **Placeholder.** Ten times a second is the default this was built around, and the reasoning is the
 * whole of the choice: it bounds the transition latency at one interval, so a camera lock, a collision
 * group or a dodge gate is at most 100 ms behind the body that walked in — which is under the
 * threshold at which any of them reads as a delay, and well under the time it takes to aim a throw.
 *
 * **Nothing here is event-driven, and that is deliberate.** There is no event that says "somebody
 * walked into a box": the alternatives are a `Touched` listener, which carries an edge-case set a
 * query does not (one event per part of a body, a `TouchEnded` that never arrives because the body
 * died, and a part that fires while the character is still being replicated), or a
 * `.Changed`/magnitude heuristic, which needs its own step size and a fudge factor. A query has none
 * of that, is exact, and costs nothing at this rate.
 *
 * **The cost is one bounds query per player per tick, whatever is asking**, which is the property that
 * makes the whole design work: five rules read one fact rather than running five queries. The same
 * arrangement, and the same rate, as `ShiftLock.checkZone` on the client — see `client/roundZone.ts`,
 * which is this function's twin on the other side of the wire.
 */
const ZONE_TICK_INTERVAL = 0.1;

/**
 * How long after a zone loses its ball a replacement is put out, in seconds. **Placeholder — 1.**
 *
 * **A beat rather than an instant, and the beat is the point.** The ball leaves the zone the moment somebody
 * picks it up, and a ball that reappears on that frame would look like the pickup did nothing — the player
 * would turn round with a ball in their hand and see the floor already stocked. One second is long enough to
 * read as *"somebody took that, here is another"* and short enough that walking back for a second throw does
 * not find an empty floor.
 *
 * **It is also the window in which the replacement can be cancelled**, which is why it is worth a name: a
 * ball thrown straight back into its own zone inside this second cancels the spawn rather than racing it.
 */
const PRACTICE_BALL_RESPAWN_SECONDS = 1;

/**
 * Whether `instance` overlaps any part tagged {@link PRACTICE_ZONE_TAG}.
 *
 * **The same test the client runs**, deliberately, line for line: the part's own `CFrame` and `Size` are
 * the zone, and the instance is the only thing *included* so the answer is about *it* rather than about
 * whatever else the lobby is holding. `roundZone.ts` carries the argument for that, and for why the filter
 * is set with `IncludeInstances` rather than the deprecated `FilterType` pair — written once there because
 * the two files' whole point is that this is one test; it is not repeated here.
 *
 * **Exported, and it takes an `Instance` rather than a `Model`, because it has two callers that ask about
 * different kinds of thing.** This service asks it about a *character* on every tick, which is what
 * {@link PRACTICE_ZONE_ATTRIBUTE} is built from. `MysteryBoxService` asks it about a *spawn point* — a
 * loose part in the world — to decide whether that point is on a practice floor and therefore stocked
 * differently.
 *
 * **Two callers, asking two different questions, and the second question is why there is a second function
 * below.** This one hands an *instance* to the engine and asks whether its bounds overlap a zone, which is
 * the right question for a character — the whole body is the thing standing somewhere. `MysteryBoxService`
 * asks about a `mysterySpawnPrize` *marker*, and a marker is a point in the floor: see {@link insideZoneAt},
 * which answers that without a query, because a query cannot answer it at all.
 *
 * What stays in one place is the *rule* — the tag, the zone part being its own box, and a zone outside
 * `Workspace` not being a zone. A second copy of that living in the mystery box would be a second answer to
 * the question this module exists to be an answer to, which is the failure the whole arrangement avoids.
 * What differs between callers is *what they do* with the answer, and that lives with each of them.
 */
export function insideZone(instance: Instance): boolean {
	const params = new OverlapParams();
	// **`IncludeInstances`, which is the current spelling of "only this instance may answer".** The pair it
	// replaces — `FilterType` and `FilterDescendantsInstances` — is marked deprecated in the installed
	// typings in favour of this and `ExcludeInstances`, and every other filter in the project already uses
	// them; the one-line migration is argued in `roundZone.ts`, next to the other half of this same test.
	params.IncludeInstances = [instance];

	for (const zone of taggedPartsInWorkspace(PRACTICE_ZONE_TAG)) {
		if (Workspace.GetPartBoundsInBox(zone.CFrame, zone.Size, params).size() > 0) return true;
	}

	return false;
}

/**
 * Whether `point` is inside any part tagged {@link PRACTICE_ZONE_TAG}.
 *
 * **This exists because the engine's queries cannot answer it, and the symptom of asking anyway was a
 * practice floor with no box on it.** `CanQuery` is documented as "determines whether the part is considered
 * during spatial query operations", and a `mysterySpawnPrize` marker is *required* to be non-queryable —
 * `MysteryBoxService.report` warns by name about any marker left queryable, because a queryable one is a part
 * the aim guide's cast stops at. So {@link insideZone} handed to a marker returns `false` for every marker in
 * the place, for ever, and nothing anywhere reports it: the mystery box's own line said `0 on a practice
 * floor` and read as a fact about the map.
 *
 * **The test is done by hand, and that is the whole point of it.** The zone part *is* the box — the same rule
 * {@link insideZone} follows — so a point is inside it when its position, expressed in the zone's own frame,
 * is within half the zone's `Size` on all three axes. `PointToObjectSpace` is what keeps that honest about
 * rotation: a zone an artist has turned still contains the points it visually contains.
 *
 * **The point is the marker's centre rather than its bounds.** Testing bounds by hand would mean comparing
 * two `Size`s in two rotated frames to answer a question no map should be asking — a spawn marker is a
 * *place* in the floor, and one big enough for centre-versus-bounds to matter is one whose size is doing
 * something the config does not describe.
 *
 * It walks the same tagged parts as {@link insideZone}, so a zone outside `Workspace` is not a zone here
 * either — that rule is the module's, not the query's.
 */
export function insideZoneAt(point: Vector3): boolean {
	for (const zone of taggedPartsInWorkspace(PRACTICE_ZONE_TAG)) {
		if (insideZonePart(zone, point)) return true;
	}

	return false;
}

/**
 * Whether `point` is inside **this one** zone part.
 *
 * **The same arithmetic `insideZoneAt` uses, asked of a part rather than of the tag** — and it is a
 * function rather than a second copy because there are now two questions with one answer: *is this point
 * on any practice floor* (the marker's question) and *is this point in **my** floor* (the practice ball's,
 * which needs to know which zone lost its ball rather than that some zone has one).
 *
 * **`CFrame.PointToObjectSpace` and a half-size comparison**, for {@link insideZoneAt}'s reason: a zone
 * painted at an angle is a box in its own frame, and an engine bounds query would be the per-tick cost this
 * module's doc spends a paragraph refusing. Not `Workspace.GetPartBoundsInBox` — that asks the engine where
 * a *part* is, and this asks where a *point* is.
 */
export function insideZonePart(zone: BasePart, point: Vector3): boolean {
	// Not `local`, which is what this wants to be called: that is a Luau keyword, and roblox-ts refuses to
	// emit it rather than mangling the name.
	const offset = zone.CFrame.PointToObjectSpace(point);
	const half = zone.Size.mul(0.5);

	return math.abs(offset.X) <= half.X && math.abs(offset.Y) <= half.Y && math.abs(offset.Z) <= half.Z;
}

/**
 * **Every `PracticeSpawn` marker that belongs to `zone`, in a stable order.**
 *
 * **`taggedPartsInWorkspace` rather than `zone.GetDescendants()`, and the difference is a place-file shape
 * this project has already chosen.** Every painted marker here — `MatchSpawner`, `LobbySpawns`, `ArenaSpawns`,
 * `mysterySpawnPrize`, `practiceBay` — is found through the tag walk, and a marker in a folder *beside* the
 * zone (both parented under the arena's model, say) is still a marker for it. Reading descendants would make
 * the answer depend on how somebody happened to organise the explorer, which is the one thing a painted
 * marker must not do.
 *
 * **The membership test is the footprint, not the ancestry** — {@link insideZonePart} on the marker's
 * `Position`, the same test a practice ball is held to. So a marker whose *centre* is over the floor belongs
 * to the zone, and one clipped by the zone's edge with its centre outside does not. That is stated in
 * {@link PRACTICE_SPAWN_TAG}'s doc because it is the tag's one boundary decision.
 *
 * **Sorted by name, then by full name, because a zone with two markers must stock them in the same order
 * every boot.** Nothing downstream depends on the order — each marker is stocked independently — but a log
 * whose lines come out in a different order each session is a log nobody can diff, and `GetTagged`'s order is
 * not promised.
 */
export function spawnPointsFor(zone: BasePart): BasePart[] {
	const markers: BasePart[] = [];

	for (const marker of taggedPartsInWorkspace(PRACTICE_SPAWN_TAG)) {
		if (!insideZonePart(zone, marker.Position)) continue;

		markers.push(marker);
	}

	markers.sort((left, right) => {
		if (left.Name !== right.Name) return left.Name < right.Name;

		return left.GetFullName() < right.GetFullName();
	});

	return markers;
}

/**
 * **Which of `spawnPoints` a ball at `point` belongs to: the nearest one.**
 *
 * **This exists because a zone's floor is shared and its markers are not.** A ball is placed on a marker and then
 * lives on the floor — it rolls, it is thrown, it is kicked back — so *"is there a ball on this floor"* is not a
 * question that can be asked per marker: every marker in a zone sees the same floor, so the first one to be
 * checked claims every ball and the rest are permanently short. That was the bug this fixes, and the symptom was
 * exactly one ball for three markers: `seed` stocked the first, and the second and third found that ball on the
 * floor and skipped themselves.
 *
 * **Nearest rather than a radius or an attribute, and both alternatives are worse here.** A radius ("within N
 * studs of my marker") makes a ball that has rolled ten studs the marker's *lost* ball, so it spawns a
 * replacement and the floor slowly fills; an attribute naming the marker travels with the ball, so a ball thrown
 * across the floor leaves its marker owed a ball for ever and the count only ever climbs. Nearest is a
 * partition — every ball belongs to exactly one marker, so the stock is *one per point covering one ball each* —
 * it needs no state, and it self-corrects the first time a replacement lands where it was asked for.
 *
 * **The cost, stated rather than discovered: a ball thrown from one marker's side to another's leaves the first
 * short and the second holding two.** The first spawns a replacement, so a floor whose balls are being kicked
 * about settles at a few more than the number of markers. That is a practice floor with spare balls on it, which
 * is the harmless direction, and it is what "the zone should have a ball at each of its points" means when the
 * balls move.
 *
 * **Ties go to the first in the list**, and the list is `spawnPointsFor`'s sorted output, so two markers at the
 * same spot still answer the same way every boot.
 */
export function nearestSpawnPoint(point: Vector3, spawnPoints: BasePart[]): BasePart | undefined {
	let nearest: BasePart | undefined;
	let best = math.huge;

	for (const candidate of spawnPoints) {
		const distance = candidate.Position.sub(point).Magnitude;
		if (distance >= best) continue;

		best = distance;
		nearest = candidate;
	}

	return nearest;
}

/**
 * The practice zone, as the server sees it — and the one thing that decides who is in it.
 *
 * **This service owns zone membership.** It is the only thing that runs the bounds test on this side,
 * it publishes the answer as {@link PRACTICE_ZONE_ATTRIBUTE}, and every other rule — the dodge gate,
 * the dock, a ball's contact handler, the Freeze splash — reads that attribute rather than asking the
 * question again. That is what makes five rules cost one query, and it is what stops two of them
 * coming to different answers about the same body.
 *
 * **Why a service and not a check wherever it is needed.** The alternative was a bounds query at each
 * point of use, and the thing that rules it out is the dodge gate: a dodge is a *request*, so a zone
 * check there would run a walk over every tagged part on every keypress — the one place in the game
 * where the query rate is set by how fast somebody can mash a key. The client is allowed to be wrong
 * about this for a frame; the server is not allowed to be expensive.
 *
 * **Two side effects per transition**, and they are the reason the tick is not merely a publisher:
 * the attribute goes out, and the body's parts are moved in and out of `PracticePlayer` — see
 * {@link setPracticePlayer} for what that group means. The group is re-applied on **every** tick while
 * a body is inside rather than once on entry, because `CollisionGroups.follow` paints every part that
 * arrives on a character `Character` — a hat, a tool, an accessory a moment after the body spawns —
 * and one arriving after the entry assignment would otherwise be a part the balls can hit.
 */
@Service()
export class PracticeZoneService implements OnStart {
	/**
	 * **When each spawn point is owed a ball, keyed on the marker.** An entry exists only while that point is
	 * short of one.
	 *
	 * **The key is the marker rather than the zone, and that is this pass's whole correction.** A zone's stock
	 * is *one ball per `PracticeSpawn` part*, so the thing that can be short of a ball is a marker; keying on
	 * the zone could only express "this floor is short", which is a different and smaller rule. On a zone with
	 * no marker the key is the zone part itself, because that is the spawn point the fallback uses — see
	 * {@link stockPointsFor}.
	 *
	 * **This map is the whole of the coupling, and it is deliberately the zone's.** The rule being enforced is
	 * *"this place should have a ball"*, which is a fact about a place; how a ball is built is
	 * `BallSpawnerService`'s, and how long a thrown one lives is `BallService`'s. So the zone owns the clock
	 * and the spawner owns the construction, and the seam between them is one call —
	 * {@link stockAt} → `BallSpawnerService.spawn(spawnPoint, false)`.
	 *
	 * **What that avoids, named because both are the obvious way to write this.** A `task.spawn` or a second
	 * `Heartbeat` per pickup would be a second clock in a service that already has one, with a lifetime to
	 * cancel on a respawn, a round boundary and a zone that was deleted; and a per-ball expiry scheduled here
	 * would be a *second* expiry clock on a ball whose first one `BallService` already owns — the two would
	 * disagree the first time either changed. The map is read by the existing tick, which is where a fact
	 * about a place already gets noticed.
	 */
	private readonly pendingSpawnAt = new Map<BasePart, number>();
	constructor(
		private readonly spawner: BallSpawnerService,
		private readonly balls: BallService,
	) {}

	public onStart(): void {
		this.report();

		// **Every player is subscribed to, and the loop below is what covers the ones already here.**
		// The same scan-and-subscribe shape `CollisionGroups.followCharacters` uses, and for its reason:
		// a body that already exists fires no `CharacterAdded`, so the seed pass and the subscription
		// are not alternatives.
		for (const player of Players.GetPlayers()) this.follow(player);

		Players.PlayerAdded.Connect((player) => this.follow(player));

		// **The floor is stocked before the loop starts**, so a player who joins in the first tenth of a
		// second sees the ball rather than watching it appear. Same reasoning as the player seed above.
		this.seed();

		task.spawn(() => this.watch());
	}

	/**
	 * **The spawn points this zone is stocked at, and the fallback in one place.**
	 *
	 * A zone's markers when it has any, and the zone part itself when it has none — so every caller works in
	 * one currency and the fallback is a branch rather than a second code path. **The fallback exists for the
	 * place file that has not been repainted**, which is where every place file starts: a ball at the zone's
	 * centre is the pre-marker behaviour, not a fault, which is why `seed` says so with a `logInfo` naming the
	 * zone rather than a `warn`. A floor that is silently empty because somebody forgot a marker is the worse
	 * failure, and this is the arrangement that cannot produce it.
	 */
	private stockPointsFor(zone: BasePart): BasePart[] {
		const markers = spawnPointsFor(zone);

		return markers.isEmpty() ? [zone] : markers;
	}

	/**
	 * **Every `(zone, spawn point)` pair the service stocks, walked once, deduplicated.**
	 *
	 * **One walk for both callers**, because `seed` and the tick must agree about what the stock *is*: if boot
	 * seeded from one list and the tick checked another, a marker one of them missed would respawn for ever.
	 *
	 * **The dedupe is for overlapping zones.** Two zones whose floors overlap can both claim one marker — the
	 * membership test is a footprint, and a footprint is shared where the zones are — and without this the
	 * marker would be ticked twice per pass, take two entries under one key, and be stocked twice. The `Set`
	 * makes the first zone in the walk the owner and is the whole of the rule; the walk's order is
	 * `GetTagged`'s, which is not promised, but which zone owns a *shared* marker is not a fact anybody can
	 * observe — the ball lands at the same point either way.
	 */
	private forEachStockPoint(
		visit: (zone: BasePart, spawnPoint: BasePart, siblings: BasePart[], fallback: boolean) => void,
	): void {
		const seen = new Set<BasePart>();

		for (const zone of taggedPartsInWorkspace(PRACTICE_ZONE_TAG)) {
			const markers = spawnPointsFor(zone);

			if (markers.isEmpty()) {
				if (seen.has(zone)) continue;
				seen.add(zone);
				visit(zone, zone, [zone], true);

				continue;
			}

			for (const marker of markers) {
				if (seen.has(marker)) continue;
				seen.add(marker);
				visit(zone, marker, markers, false);
			}
		}
	}

	/**
	 * Puts one ball on every spawn point at boot, and says how many — and says which zones are on the
	 * fallback.
	 *
	 * **A zero is a diagnostic rather than an error**, which is this file's own convention for `report`'s
	 * line: a place file with no practice zone is a valid place, and a line reading `0 zone(s), 0 ball(s)`
	 * is what tells a reader that the feature did nothing *because there is nothing to stock* rather than
	 * because it failed. No warning is printed for it.
	 *
	 * **The marker count is on the line beside the ball count, and it is the number that diagnoses "I painted
	 * three and got one".** Two failures look identical from the player's seat — a marker that did not keep its
	 * tag when it was duplicated, and a marker that the zone's footprint does not cover — and they part company
	 * here: `3 marker(s), 3 ball(s)` is a working floor, `1 marker(s), 1 ball(s)` is three parts of which two are
	 * not tagged, and `3 marker(s), 1 ball(s)` was this service claiming the whole floor for one point.
	 *
	 * **A spawn point that already has a ball is skipped**, which cannot happen at boot today — nothing else
	 * makes a practice ball — but is the same test the tick makes, so a dev who pastes a second boot of this
	 * service into a live session does not carpet the floor.
	 */
	private seed(): void {
		const zones = taggedPartsInWorkspace(PRACTICE_ZONE_TAG);
		let markers = 0;
		let seeded = 0;

		this.forEachStockPoint((zone, spawnPoint, siblings, fallback) => {
			markers++;

			if (fallback) {
				logInfo(`[PracticeBall] ${zone.Name}: no ${PRACTICE_SPAWN_TAG} — using the zone's centre`);
			}

			if (this.looseBallNear(zone, spawnPoint, siblings) !== undefined) return;

			this.stockAt(spawnPoint);
			seeded++;
		});

		logInfo(
			`[PracticeBall] up — ${zones.size()} zone(s), ${markers} stock point(s), ${seeded} ball(s) seeded`,
		);
	}

	/**
	 * **The one place a practice ball is made**, and the seam the class doc describes.
	 *
	 * Three things happen and the order is load-bearing: the spawner builds it (which leaves it loose,
	 * unarmed, in `Workspace` and **on no clock** — `BallFactory.createLoose` then `scheduleBallExpiry(…,
	 * math.huge)`), the practice-ball tag goes on after that, and nothing else is written.
	 *
	 * **`false` is the flag that keeps the arena's budget out of it.** The ball is not a `RoundBall`, so
	 * `roundBallCount` does not see it and `MATCH_BALL_COUNT` is not spent — see `BallSpawnerService.spawn`.
	 *
	 * **Nothing here sets `Armed`, `ThrowerId` or any `BALL_TAGGED_*` attribute, and that is not an
	 * omission.** A fresh ball already has the state this ball wants: `makeInert` writes `Armed = false` and
	 * `ThrowerId = ""`, and the tag it wears is what makes it inert on contact — `BallComponent.handleTouch`
	 * returns on its first line for a ball whose `Armed` is not `true`, so a practice ball that has never
	 * been thrown is a ball that walks past bodies without hurting them. Writing any of those here would be
	 * this file deciding what a ball is, which it is not.
	 *
	 * **And there is no expiry call, because there is nothing to schedule.** The spawner's `math.huge` is
	 * `ballExpiry`'s own spelling of "not on a clock at all" — no timer, no row — so the ball sits there
	 * until somebody picks it up. The clock starts when it is *thrown*: `BallService.throwBallBody` schedules
	 * `BALL_CONFIG.LIFETIME_SECONDS` on every ball it launches, so the practice ball inherits the ordinary
	 * ten seconds at the throw with nothing added here.
	 *
	 * **The placement is the spawn point's too, and that is the point of the marker.** The part handed to
	 * `BallSpawnerService.spawn` is the `PracticeSpawn` marker — or the zone itself on the fallback — and
	 * `spawn` places the ball from that part: its `Position`, half its `Size.Y`, plus one, jittered, with
	 * gravity settling it. A marker is a thin part on the floor, so that rule puts the ball a stud above the
	 * floor it was painted on. **A second placement rule in this file would be a second answer to "where does a
	 * ball go"**, which is why the fallback is a different *part* rather than a different calculation.
	 */
	private stockAt(spawnPoint: BasePart): BasePart {
		const ball = this.spawner.spawn(spawnPoint, false);
		ball.AddTag(PRACTICE_BALL_TAG);

		return ball;
	}

	/**
	 * The practice ball standing on `spawnPoint`'s zone that nobody is holding, or nothing.
	 *
	 * **Three facts, and each one is the same fact `BallPickupService` asks before it will collect a ball**:
	 * it is in the world (a ball in a hand is welded into a character and is not a child of `Workspace`), it
	 * is not held, and it is unarmed — an armed ball is a live projectile in flight, which is not a ball the
	 * zone has lost but one somebody is using.
	 *
	 * **`insideZonePart` rather than `insideZoneAt`, and this is the per-zone half of the question.** The
	 * module's other helper answers "is this point on *any* practice floor", which is what a mystery marker
	 * wants to know; a zone asking whether *its* ball is home needs its own part, or two zones side by side
	 * would each count the other's ball and neither would ever respawn.
	 *
	 * **The zone is the area and the spawn point is the identity**, which is why this takes both. On the
	 * fallback they are the same part and `siblings` is that one part, so the question is exactly the one this
	 * method asked before markers existed.
	 *
	 * **On a marker the ball is the one nearest that marker, and this paragraph replaces one that argued the
	 * opposite.** The first cut asked *"is a ball anywhere on this floor"* — a zone-wide test, on the reasoning
	 * that a ball knocked off its marker is still the zone's ball and replacing it would put a second ball on a
	 * floor that is not short. **That reasoning holds for one marker and fails for three**, because the floor is
	 * shared and the markers are not: the first point stocked itself, and every other point then found *that*
	 * ball on the floor, called itself stocked, and never spawned. Three markers, one ball, and the zone-wide
	 * test was the whole of the cause. `nearestSpawnPoint` is the fix: a ball belongs to the closest marker in
	 * the same zone, so the floor's balls are partitioned across the markers instead of piled on the first.
	 *
	 * **The cost of the narrower rule is real and is the safer direction.** A ball knocked off its marker toward
	 * its neighbour now belongs to the neighbour, so the first marker spawns a replacement and the floor settles
	 * slightly over-stocked rather than under-stocked — a practice floor with a spare ball on it, against a
	 * practice floor with a marker that never stocks.
	 */
	private looseBallNear(zone: BasePart, spawnPoint: BasePart, siblings: BasePart[]): BasePart | undefined {
		for (const ball of CollectionService.GetTagged(PRACTICE_BALL_TAG)) {
			if (!ball.IsA("BasePart")) continue;
			if (ball.Parent !== Workspace) continue;
			if (this.balls.isHeld(ball)) continue;
			if (ball.GetAttribute("Armed") === true) continue;
			if (!insideZonePart(zone, ball.Position)) continue;
			if (nearestSpawnPoint(ball.Position, siblings) !== spawnPoint) continue;

			return ball;
		}

		return undefined;
	}

	/**
	 * **One spawn point, once a tenth of a second: is its ball here, and is one owed.**
	 *
	 * Three states, and every one of them is a transition rather than a condition — which is what keeps this
	 * from printing sixty lines a second at an empty floor:
	 *
	 * - **Ball present** → this point is stocked. A pending entry is *cancelled*, not ignored: a ball thrown
	 *   back onto its own floor inside the one-second window must not produce a second ball, and the delete
	 *   here is the whole of that rule.
	 * - **No ball, no entry** → this point has just lost it. One line, and the deadline.
	 * - **No ball, entry due** → put a ball out and clear the entry.
	 *
	 * **The marker is the subject and the zone is where it is**, which is why both are arguments. The map and
	 * every printed line are keyed on the spawn point, so a zone painted with three markers has three
	 * independent stocks that restock independently — the natural reading of a spawn-point tag, and the shape
	 * `MatchSpawner` already has one ball per part of.
	 *
	 * **A ball in a hand is a ball the zone has lost, deliberately.** A catch or a pickup takes the ball out
	 * of the world, so the floor is empty and gets restocked — the user's rule is *"a new one spawned 1 second
	 * after the first ball is picked up"*, and a ball somebody is carrying is not on the floor. If they throw
	 * it back inside the window, the ball is present again and the entry is cancelled; if they walk off with
	 * it, the zone has another for the next person.
	 *
	 * **The clock is `Workspace:GetServerTimeNow()`**, which is the same clock every other published deadline
	 * in this project is on, and the only one that survives a server that hitches: a `task.wait` would have
	 * made the beat depend on how long the frame took.
	 */
	private tickSpawnPoint(zone: BasePart, spawnPoint: BasePart, siblings: BasePart[]): void {
		const now = Workspace.GetServerTimeNow();
		const here = this.looseBallNear(zone, spawnPoint, siblings) !== undefined;
		const due = this.pendingSpawnAt.get(spawnPoint);

		// **What the line calls this point.** A marker has a name somebody gave it; the fallback is a zone, so
		// it says so — otherwise a zone's centre and a marker inside the same zone would print the same word
		// twice and a reader could not tell which of the two had lost its ball.
		const label = spawnPoint === zone ? `${zone.Name} (centre)` : spawnPoint.Name;

		if (here) {
			if (due === undefined) return;

			this.pendingSpawnAt.delete(spawnPoint);
			logInfo(`[PracticeBall] ${label}: ball is back — replacement cancelled`);

			return;
		}

		if (due === undefined) {
			this.pendingSpawnAt.set(spawnPoint, now + PRACTICE_BALL_RESPAWN_SECONDS);

			logInfo(
				`[PracticeBall] ${label}: lost its ball — replacement in ` +
					`${string.format("%.2f", PRACTICE_BALL_RESPAWN_SECONDS)}s`,
			);

			return;
		}

		if (now < due) return;

		this.pendingSpawnAt.delete(spawnPoint);
		this.stockAt(spawnPoint);
	}

	/**
	 * The line that says what this service found, in `MysteryBoxService.report`'s shape.
	 *
	 * **A zone part left queryable is an invisible wall, and the symptom lands somewhere else entirely.** A
	 * `practiceZone` is usually one large part covering a floor, so a queryable one is a surface that every
	 * cast *inside* the practice area stops at — the aim guide, the trajectory probe, a throw's own probe —
	 * and what a player sees is their aim misbehaving in a place with nothing visibly in the way. This is
	 * the same failure `MysteryBoxService.report` warns about for its own markers, and the same answer:
	 * nothing is written to the part, because it is the painter's property and a runtime write could be
	 * saved back into the place file. It is named by full path instead, so somebody who did not know it had
	 * to be changed can find out which part to change.
	 *
	 * **The count is printed for the reason `BallSpawnerService`'s is: it separates the two ways a zone
	 * feature can do nothing.** No tagged parts at all is a map that never got the tag; tagged parts with
	 * nobody inside them is a zone placed where nobody stands. Only the first is worth grepping the place
	 * file for, and a line that states the number is what tells them apart without opening the map.
	 *
	 * **`CanQuery` is worth this line and no more, because the zone's own tests do not care about it.** A
	 * character is what the bounds query is *looking for* — the zone part is the box being looked inside,
	 * never a candidate — and {@link insideZoneAt} compares numbers in a `CFrame` rather than asking the
	 * engine anything at all. So a queryable zone costs nothing here and everything to the casts that share
	 * the floor with it.
	 */
	private report(): void {
		const zones = taggedPartsInWorkspace(PRACTICE_ZONE_TAG);

		logInfo(`[Zone] up — ${PRACTICE_ZONE_TAG}: ${zones.size()} tagged part(s)`);

		const queryable = zones.filter((zone) => zone.CanQuery);
		if (!queryable.isEmpty()) {
			logWarn(
				`[Zone] ${queryable.size()} ${PRACTICE_ZONE_TAG} part(s) are CanQuery — every cast inside them ` +
					`stops at an invisible wall: ${queryable.map((zone) => zone.GetFullName()).join(", ")}`,
			);
		}
	}

	/**
	 * Subscribes to `player`'s bodies.
	 *
	 * **`CharacterAdded` is a latency matter rather than a correctness one**, and it is worth being
	 * precise about which. The loop would pick a respawned body up within one interval on its own — but
	 * a player who respawns *inside* the zone changes nothing about the answer, so the attribute never
	 * changes and the loop's change-detection would skip them: their new body would be re-assigned to
	 * the group on the next tick only because that re-application is unconditional while inside, and it
	 * would be a tick late. Answering the signal directly closes that window and makes the intent
	 * visible.
	 */
	private follow(player: Player): void {
		player.CharacterAdded.Connect(() => this.tick(player));

		// Seeded, because a player who is already in the game when this service starts will never fire
		// the signal again for the body they are wearing.
		this.tick(player);
	}

	/**
	 * **The zone's whole clock: every player tested, and every spawn point asked about its ball.** The only
	 * loop in this file, and both halves are on it deliberately.
	 *
	 * **The ball pass is a callback rather than a second loop**, and that is the whole reason the pending map
	 * lives on this service: a `task.spawn` or a `Heartbeat` of its own would be a second clock to cancel on a
	 * respawn, a round boundary and a deleted zone, and this loop already exists at the exact rate the restock
	 * wants — a tenth of a second against a one-second beat. The walk is over the zone tag and then over each
	 * zone's markers, so it costs one `GetTagged` per tag per tick and one bounds comparison per marker.
	 *
	 * **It walks spawn points rather than zones**, which is this pass's correction: a zone is where a ball
	 * should be, and a `PracticeSpawn` marker is *where in it*, so the thing that can be short of a ball is the
	 * marker. {@link forEachStockPoint} owns that walk so this loop and `seed` cannot disagree about what the
	 * stock is.
	 *
	 * **A zone or marker that has been deleted stops being ticked**, because the walk reads the tags rather
	 * than a list held here — the same reasoning `BallSpawnerService.tick` gives for walking its spawners, and
	 * the same free answer to "what if a dev removes the practice floor mid-session": its pending entry is
	 * simply never read again, and the map is keyed on the part, so nothing leaks that a new zone would
	 * inherit.
	 */
	private watch(): void {
		while (true) {
			task.wait(ZONE_TICK_INTERVAL);

			for (const player of Players.GetPlayers()) this.tick(player);

			this.forEachStockPoint((zone, spawnPoint, siblings) =>
				this.tickSpawnPoint(zone, spawnPoint, siblings),
			);
		}
	}

	/**
	 * Tests one player and reports the answer, publishing it if it changed.
	 *
	 * **A body that is not there is not an answer either way**, which is the same rule the client's
	 * check makes: a player between bodies has nothing to stand in a zone with, so the attribute and
	 * the group are both left exactly as they were. The tick after the respawn corrects them.
	 */
	private tick(player: Player): void {
		const character = player.Character;
		if (!character) return;

		const inside = insideZone(character);
		const wasInside = player.GetAttribute(PRACTICE_ZONE_ATTRIBUTE) === true;

		// **The group is re-applied whether or not the answer changed**, and the comment above the class
		// says why: a part that arrived on this body after the entry assignment is wearing `Character`,
		// and nothing else is watching for it. Cheap — a walk of one body's descendants, ten times a
		// second, for the handful of players standing in a zone.
		if (inside) setPracticePlayer(character, true);

		if (inside === wasInside) return;

		if (LOGGING_ENABLED) {
			logInfo(`[Zone] ${player.Name}: ${inside ? "entered" : "left"} a ${PRACTICE_ZONE_TAG}`);
		}

		player.SetAttribute(PRACTICE_ZONE_ATTRIBUTE, inside);

		// Only on the way out: the way in was done above, and doing it twice would be a second walk of
		// the same body in the same tick.
		if (!inside) setPracticePlayer(character, false);
	}
}
