import { Players, ReplicatedStorage, Workspace } from "@rbxts/services";
import { PRACTICE_ZONE_TAG, ROUND_STATE_ATTRIBUTE, ROUND_STATUS_FOLDER, TEAM_ATTRIBUTE } from "shared/constants";
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

/** What `TEAM_ATTRIBUTE` holds for each side. Two literals between two files, spelled the same way. */
const SIDE_A = "A";
const SIDE_B = "B";

/** One side, as a client reads it off an attribute. See {@link sideOf}. */
export type SideLabel = typeof SIDE_A | typeof SIDE_B;

/**
 * **`holder`'s own `TEAM_ATTRIBUTE` as a side, or nothing — the validated read, in one place.**
 *
 * **An attribute is a string anybody can write**, so `Team = "Red"` is not a side, it is a string that happens
 * to be a colour. The same reading `npc/rigs.ts`'s `sideOfRig` makes on the server, and the same one this file
 * already made inside {@link onASide}: a value that is not one of the two labels reads as "no side" rather than
 * being passed on as a side.
 *
 * **`Instance` rather than `Player`, because the attribute lives on two kinds of thing.** `RoundService.assignTeams`
 * writes it on the **`Player`** — the roster is player-keyed and a character is replaced on every death — while a
 * **rig** carries its own, painted in Studio or written by its pad walk and its respawn. This asks the instance it
 * is handed and nothing else, so it means "the label on this thing"; the two-branch question a *character model*
 * needs is {@link sideOfBody}.
 *
 * **Why this moved here rather than staying a copy in `AimTargetController`, which is where it was written
 * first.** That file's own doc named the moment this would be worth doing — *"if a fourth reader ever appears,
 * the change to make first is to move the labels themselves"* — and the mobile aim assist is that fourth
 * reader. Two copies of the label pair and the validation were already one more than the rule wanted; a third
 * is how two readers come to disagree about a body that is on a side.
 */
export function sideOf(holder: Instance): SideLabel | undefined {
	const label = holder.GetAttribute(TEAM_ATTRIBUTE);

	return label === SIDE_A || label === SIDE_B ? label : undefined;
}

/**
 * **Which side a *body* is on, read from wherever that side actually lives** — the client's copy of the rule
 * the server keeps in `npc/detect.ts` (`sideOf`) and `RoundService.teamOf`.
 *
 * **Two branches, because the attribute is written in two different places.** For a player's **character**
 * model the side is on the `Player`, so a reader that asked the model would read every player's character as
 * side-less — which, under an "is this my side" equality test, is the same answer as "not a teammate", the
 * exact way a rule like this one goes quietly wrong. `GetPlayerFromCharacter` is the branch that tells the two
 * apart, and its `undefined` is meaningful: it means "this model is not a player's character", i.e. a rig, and
 * then the model's own attribute is the answer.
 *
 * **A `Model | Player` rather than a `Model`**, because the local player's own side is asked of the `Player`:
 * that is the one body the client can read directly without a character, so a player with no body still has a
 * side and the answer survives a death.
 *
 * **Moved here from `AimTargetController` unchanged**, on that file's own instruction and for the reason
 * {@link sideOf} gives. Its two readers are `AimTargetController.hittable` and `client/aimAssist.ts`.
 */
export function sideOfBody(body: Model | Player): SideLabel | undefined {
	if (body.IsA("Player")) return sideOf(body);

	const player = Players.GetPlayerFromCharacter(body);

	return sideOf(player ?? body);
}

/**
 * **Whether this player is on a side — the fact the round-edged client features gate on.**
 *
 * `TEAM_ATTRIBUTE` is written by `RoundService.assignTeams` from the opt-in roster, **cleared there for
 * everybody who is not in it**, and written again by `setTeam` for a player who joins a round that is
 * already being played. So "this player has a side" and "this player is in the round the phase is talking
 * about" are one statement, replicated per player with no remote, no poll and no new state.
 *
 * **It is deliberately not "a round is on", which is {@link inRound}.** A player watching a round from the
 * lobby is not in it: they are not teleported, not held and not counted, so the things that follow the
 * round's edges must not act for them. The two predicates are composed where both are wanted — see
 * {@link isParticipant} — and used alone where only one is, which is why both are exported.
 *
 * **The label is validated rather than merely read**, which is now {@link sideOf}'s job rather than a test
 * written out here: the freeze countdown used `typeIs(label, "string")` and that is the looser test, and a
 * value that is not one of the two labels is not a side.
 */
export function onASide(player: Player): boolean {
	return sideOf(player) !== undefined;
}

/**
 * **The rule, in one place: a player is in the round when they are on a side and a round is being
 * played.** Both conditions, not either — the user's own wording — and the two halves fail in opposite
 * directions, which is why both are asked: a lobby spectator has no side while the round runs, and a
 * participant stands in the lobby while an intermission does.
 *
 * **This is what the camera asks**, and it lives here rather than inside the camera for the reason
 * `inTaggedZone` does: a second copy of a rule about where the game is being played does not survive
 * itself. The wipe asks a different question and says so — it plays for whoever is *moved*, which is
 * {@link onASide} alone, because at a round's end the phase has already left `Playing`.
 */
export function isParticipant(player: Player): boolean {
	return inRound() && onASide(player);
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
 * **A note that used to sit here named the spectator attribute as an open question, and the question has
 * been closed by removing the state rather than by answering it.** The practice-zone task described this
 * rule as "in a round (not spectating) or in a practice zone", and nothing in this codebase ever consulted
 * spectating for either feature — the camera holds on the phase alone, and the dodge's other checks already
 * require a living humanoid. So there was never a line here to delete rather than keep: the open question
 * was whether to *add* one, and there is nothing left to add, because a player who is out of a round is a
 * player the client cannot tell apart from one standing in the lobby. That is the same trade
 * `panels.ts`'s `sessionHudVisible` made for the readouts, and the fact behind it — `activePlayers`, inside
 * `RoundService` — has never been replicated to a client and is not going to be.
 *
 * **That last clause aged out on 2026-10-20, and the reason it was true is worth keeping.** `RoundService` now
 * publishes `IN_ROUND_ATTRIBUTE`: membership of `activePlayers`, written where a player is admitted to a round
 * and cleared in `eliminate`, which is the one method a live round loses a body through. So a client *can* tell
 * somebody who is out of a round — surrendered, eliminated — from a spectator who was never in it.
 *
 * **It is deliberately not folded into this function.** The camera and the dodge ask "is the game being played
 * around me", which the phase answers; the team ring and the surrender prompt ask "am I still in it", which is
 * the new attribute. Two questions, two predicates, and neither answers the other's — the ring's rule is written
 * once, in `TeamRingController.ringFor`.
 */
export function inRoundOrZone(character: Model | undefined): boolean {
	return inRound() || inTaggedZone(character);
}
