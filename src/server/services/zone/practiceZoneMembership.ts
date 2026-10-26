import { Players } from "@rbxts/services";
import { PRACTICE_ZONE_ATTRIBUTE } from "shared/constants";

/**
 * **The one predicate behind "a player standing in a practice zone is never killed": whether `body` is that player.**
 *
 * **A plain module rather than an export from `PracticeZoneService`, and the reason is mechanical as well as
 * architectural.** The two callers are `BallComponent.landHit` and `RoundService.resolveCaughtThrower` — a component
 * and a *service* — and importing the service file from the round made a service-to-service module edge that did not
 * exist before, which reordered Flamework's generated reflection manifest without adding an entry to it. A predicate
 * with no state does not need to live behind a decorator, and keeping it out of one keeps a generated file clean.
 *
 * **It is still the zone's rule, and it belongs beside `insideZone` / `insideZoneAt`** — the file lives in the zone's
 * own directory for that reason, even though it depends on neither of them. What it reads is the *published* answer,
 * `PRACTICE_ZONE_ATTRIBUTE`, which `PracticeZoneService` owns and which every other zone rule already consumes: the
 * dodge gate, the catch prompt, the Freeze splash, the dock. See that service's class doc for why one query per player
 * per tick is the whole point of the arrangement.
 *
 * **A `Player`, and never a rig — that is a rule rather than an oversight.** The request was about a person
 * practising. A rig inside a practice zone is still killed, inside or outside it, and `Behavior_Respawn` rebuilds it;
 * sparing rigs would quietly turn the practice floor into a haven for bodies nobody asked about. Both arms below
 * resolve to a `Player` and answer `false` for anything else, which is exactly what makes a rig victim fall through to
 * the unchanged `TakeDamage`.
 *
 * **The attribute rather than the geometry.** `insideZoneAt` takes a *point* and walks every tagged part, so using it
 * here would be a bounds walk on two of the hottest paths in the game — a ball's landing resolves once per tagged body
 * per throw, and a catch resolves once per catch — and it could disagree with the tracker's answer by one tick anyway.
 * Reading the attribute costs one `GetAttribute` and cannot disagree with the five rules beside it.
 *
 * **The one thing this must never become is a substitute for not taking damage.** The gate it feeds prevents
 * `TakeDamage` from being called at all, so the victim's `Humanoid` never enters the Dead state. Anything that instead
 * made the death *safe* — `SetStateEnabled(Enum.HumanoidStateType.Dead, false)`, a direct `Health` write, a
 * `PlatformStand` — would be a second state machine to debug and would leave `Died`, `BreakJointsOnDeath` and the
 * anchored-root anomaly all still in play. `HANDOFF.md` §15 records that refusal.
 */
export function isPractising(body: Instance): boolean {
	// **The `Player` arm is the catch path's shape.** `resolveCaughtThrower` holds a `thrower` that is a `Player` for
	// a person and a rig `Model` for an NPC, and the zone attribute lives on the *`Player`* — the roster is
	// player-keyed and a character is replaced on every death, so reading it off the character would be reading a
	// value that does not exist there.
	if (body.IsA("Player")) return body.GetAttribute(PRACTICE_ZONE_ATTRIBUTE) === true;
	if (!body.IsA("Model")) return false;

	const player = Players.GetPlayerFromCharacter(body);

	return player !== undefined && player.GetAttribute(PRACTICE_ZONE_ATTRIBUTE) === true;
}
