import { OnStart, Service } from "@flamework/core";
import { Players, Workspace } from "@rbxts/services";
import { PRACTICE_ZONE_ATTRIBUTE, PRACTICE_ZONE_TAG } from "shared/constants";
import { taggedPartsInWorkspace } from "shared/taggedParts";
import { setPracticePlayer } from "../../collision/CollisionGroups";

/** Prints each player's transitions in and out of a zone. */
const DEBUG = true;

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
 * Whether `instance` overlaps any part tagged {@link PRACTICE_ZONE_TAG}.
 *
 * **The same test the client runs**, deliberately, down to the deprecated filter pair: the part's own
 * `CFrame` and `Size` are the zone, and the instance is the only thing included so the answer is about
 * *it* rather than about whatever else the lobby is holding. `roundZone.ts` carries the argument for that;
 * it is not repeated here because the two want to stay one test.
 *
 * **Exported, and it takes an `Instance` rather than a `Model`, because it has two callers that ask about
 * different kinds of thing.** This service asks it about a *character* on every tick, which is what
 * {@link PRACTICE_ZONE_ATTRIBUTE} is built from. `MysteryBoxService` asks it about a *spawn point* — a
 * loose part in the world — to decide whether that point is on a practice floor and therefore stocked
 * differently.
 *
 * **One function rather than two, and the second caller is exactly why.** "Is this thing inside a zone" is
 * the zone's definition, and a second copy of it living in the mystery box would be a second answer to the
 * question the zone exists to be an answer to — the failure this whole module was written to avoid. What
 * differs between the callers is *what they do* with the answer, and that lives with each of them.
 *
 * It also means the box inherits the rule the zones already have: a zone part outside `Workspace` is not a
 * zone, and a spawn point near one is therefore not in a zone either.
 */
export function insideZone(instance: Instance): boolean {
	const params = new OverlapParams();
	params.FilterType = Enum.RaycastFilterType.Include;
	params.FilterDescendantsInstances = [instance];

	for (const zone of taggedPartsInWorkspace(PRACTICE_ZONE_TAG)) {
		if (Workspace.GetPartBoundsInBox(zone.CFrame, zone.Size, params).size() > 0) return true;
	}

	return false;
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
	public onStart(): void {
		// **Every player is subscribed to, and the loop below is what covers the ones already here.**
		// The same scan-and-subscribe shape `CollisionGroups.followCharacters` uses, and for its reason:
		// a body that already exists fires no `CharacterAdded`, so the seed pass and the subscription
		// are not alternatives.
		for (const player of Players.GetPlayers()) this.follow(player);

		Players.PlayerAdded.Connect((player) => this.follow(player));

		task.spawn(() => this.watch());
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

	/** Tests every player, forever. The only loop in this file. */
	private watch(): void {
		while (true) {
			task.wait(ZONE_TICK_INTERVAL);

			for (const player of Players.GetPlayers()) this.tick(player);
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

		if (DEBUG) {
			print(`[Zone] ${player.Name}: ${inside ? "entered" : "left"} a ${PRACTICE_ZONE_TAG}`);
		}

		player.SetAttribute(PRACTICE_ZONE_ATTRIBUTE, inside);

		// Only on the way out: the way in was done above, and doing it twice would be a second walk of
		// the same body in the same tick.
		if (!inside) setPracticePlayer(character, false);
	}
}
