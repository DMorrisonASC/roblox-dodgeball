import { ReplicatedStorage, Workspace } from "@rbxts/services";
import { PRACTICE_ZONE_TAG, ROUND_STATE_ATTRIBUTE, ROUND_STATUS_FOLDER } from "shared/constants";
import { taggedPartsInWorkspace } from "shared/taggedParts";

/**
 * "Am I in a round, or standing in a practice zone?" — the one place that question is answered.
 *
 * **Written because two features were about to answer it separately.** The camera came first: it holds
 * itself for the length of a round and inside a tagged box, and it has read the box for itself since the
 * lock was built. The dodge input wants the same rule — a dodge is something you do in a round or in a
 * practice zone, not in the lobby — and a second copy of a rule about *where you are allowed to act* is a
 * second answer to it, which is the one thing that rule cannot survive.
 *
 * **Nothing here caches, and every caller decides how often to ask.** The camera asks on its own tick,
 * because it needs the answer on a clock; the dodge input asks on the press that completes a dodge — a
 * movement key plus the dodge button — because a press is not a frame. That is deliberately the shape
 * with the fewest moving parts while the answer still has to be computed at all — see
 * {@link inTaggedZone}, which is the body the practice-zone work replaces with a read of a fact
 * somebody else publishes.
 */

/** What `ROUND_STATE_ATTRIBUTE` says while a round is being played. A word between two files. */
const PLAYING = "Playing";

/**
 * Whether a round is being played, as the round folder publishes it.
 *
 * Read from `ReplicatedStorage` rather than asked of a service, which is how every other reader of this
 * attribute gets at it: the folder is the server's own publication of the phase, it is replicated to
 * everyone, and there is nothing a client-side feature could add to it by asking anybody else. A folder
 * that is not there yet reads as "not in a round", which is the right answer for a client that has not
 * been told what the round is doing.
 */
export function inRound(): boolean {
	const status = ReplicatedStorage.FindFirstChild(ROUND_STATUS_FOLDER);
	if (!status) return false;

	return status.GetAttribute(ROUND_STATE_ATTRIBUTE) === PLAYING;
}

/**
 * Whether `character` is standing inside a part tagged {@link PRACTICE_ZONE_TAG}.
 *
 * **This is the one place the tag is read, and the one function the practice-zone work rewrites.** The
 * tag string and the bounds test are the whole of the zone's definition today; that work moves the answer
 * to a **per-player attribute published by the server**, at which point this body collapses to a read of
 * it and every caller stays exactly as it is. Isolating the read here is what makes that a one-function
 * change rather than a hunt through the features that depend on it.
 *
 * The test is the tagged part's own `CFrame` and `Size` — **the part *is* the box**, in whatever place and
 * rotation the builder put it — and it is asked with the character as the only included instance, so the
 * answer is about this body rather than about whatever else the lobby happens to be holding. Nothing is
 * queried *for* the zone, which is why its `CanQuery = false` has no bearing on this.
 *
 * `taggedPartsInWorkspace`, so a folder of boxes tagged as a zone works like a single tagged box and a
 * zone outside the world is left alone.
 *
 * **`FilterType`/`FilterDescendantsInstances` used to be here on purpose, and the pair is gone now — the
 * argument that kept it was wrong in its premise.** It was kept while the rest of the project migrated,
 * on the reasoning that a filter the running engine did not recognise would fail *silently*: the zone
 * would stop being detected and nothing would report it. The typings do not support that reading. An
 * unset `IncludeInstances` is `nil`, which is documented as the **most permissive** filter — it includes
 * everything — so a silently-ignored assignment would not make the zone undetectable, it would make the
 * answer "something is standing in this box" for **every** instance tested. Every player in the lobby
 * would read as being on a practice floor the moment anybody's ball rolled into a zone: loud, absurd, and
 * very easy to notice. `{}` is the restrictive value, and this function never sets it.
 *
 * So the migration is one line, and it is the same one the rest of the project already made — `throw.ts`,
 * `Trajectory`, `AimGuide` and `ThrowController` all set `ExcludeInstances`, and the properties are in the
 * engine's own API dump rather than being a typings-only invention. The version that guards against a
 * silent failure is the *old* one; this is the one that fails visibly.
 */
export function inTaggedZone(character: Model | undefined): boolean {
	// A body that is not there is not inside anything. Stated rather than left to the loop, because
	// `IncludeInstances` would take the `nil` and say nothing about it.
	if (!character) return false;

	const params = new OverlapParams();
	// **`IncludeInstances` with one instance in it, so the only thing that can answer is this player's own
	// body.** An exclusion would be a standing invitation to be wrong: the lobby has loose balls, rigs and
	// other players in it, and any of them standing in the box would answer for this one. The character
	// *model* rather than its root part, so a player leaning over the edge with one arm inside the zone
	// is inside it.
	params.IncludeInstances = [character];

	for (const zone of taggedPartsInWorkspace(PRACTICE_ZONE_TAG)) {
		if (Workspace.GetPartBoundsInBox(zone.CFrame, zone.Size, params).size() > 0) return true;
	}

	return false;
}

/**
 * The rule both features are asking about: **a round is being played, or the body is in a tagged zone.**
 *
 * **`SPECTATING_ATTRIBUTE` is deliberately not read here, and that is an open question rather than a
 * decision.** The practice-zone task describes this rule as "in a round (not spectating) or in a practice
 * zone", and nothing in this codebase has ever consulted spectating for either feature: the camera holds
 * on the phase alone, and the dodge's other checks already require a living humanoid, which a spectator
 * has nothing to stand with. Folding the check in here would change what every spectator's camera does,
 * and that is a rule change rather than the shared predicate this module exists to be. Left out and
 * reported, so it is a line somebody chooses to add rather than one that arrived unnoticed.
 */
export function inRoundOrZone(character: Model | undefined): boolean {
	return inRound() || inTaggedZone(character);
}
