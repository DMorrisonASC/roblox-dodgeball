import { Players, ReplicatedStorage, Workspace } from "@rbxts/services";
import {
	IN_ROUND_ATTRIBUTE,
	PRACTICE_ZONE_TAG,
	ROUND_STATE_ATTRIBUTE,
	ROUND_STATUS_FOLDER,
	TEAM_ATTRIBUTE,
} from "shared/constants";
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
 * **The dodge has since narrowed its half of it and the camera has not**, which is why {@link inRoundOrZone} and
 * {@link isParticipant} are both here and both used. The camera wants "the game is being played around me", which is
 * the phase; the dodge wants "I am in this round", which is the phase *and* the round's own membership attribute. See
 * {@link inRoundOrZone} for the report that separated them.
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
 * **Whether this player is wearing a side — which is not the same question as being in the round, and stopped
 * being a usable proxy for it on 2026-10-20.**
 *
 * `TEAM_ATTRIBUTE` is written by `RoundService.assignTeams` from the opt-in roster, **cleared there for
 * everybody who is not in it**, and written again by `setTeam` for a player who joins a round that is
 * already being played. What it does *not* do is come off when somebody leaves a round mid-way:
 * `surrender` keeps the roster entry on purpose, so the side survives into the lobby along with the seat it
 * stands for. "This player has a side" and "this player is in the round" were one statement while nothing
 * could leave a round in the middle; they are two now, and the second is {@link isParticipant}.
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
 * **The rule, in one place: a player is in the round when the round says it has them and a round is being
 * played.** Both conditions, not either, and the two halves fail in opposite directions: the attribute is cleared
 * where membership is cleared rather than where the phase changes, so a boundary can leave it true for a frame
 * after the phase has moved — and a round being played is true for every spectator in the lobby.
 *
 * **"On a side" was the second condition until 2026-10-20, and a surrender broke it.** `RoundService.surrender`
 * deliberately leaves a player in `teams` — the side's head count has to survive somebody walking out — so
 * `TEAM_ATTRIBUTE` stays on them while they stand in the lobby, and this predicate went on reporting them as a
 * participant. The visible result was the shift lock staying on: mouse held to the middle of the screen and a
 * crosshair over a player who had left the round. `IN_ROUND_ATTRIBUTE` is the round's own answer to the question
 * this function is actually asking, published at the four places membership changes — see it for why it exists.
 *
 * **This is what the camera and the dock ask**, and it lives here rather than inside either for the reason
 * `inTaggedZone` does: a second copy of a rule about where the game is being played does not survive itself.
 * The wipe asks a different question and says so — it plays for whoever is *moved*, which is {@link onASide}
 * alone, because at a round's end the phase has already left `Playing`.
 */
export function isParticipant(player: Player): boolean {
	return inRound() && player.GetAttribute(IN_ROUND_ATTRIBUTE) === true;
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
 * The rule the dodge asks: **this player is in the round being played, or the body is in a tagged zone.**
 *
 * **It used to be `inRound() || inTaggedZone(character)`, and that was wrong in exactly one way: a round being
 * played is true for every spectator in the lobby.** The report was *"when the round starts I can dodge in the lobby
 * even though I am not in the match"* — and that is what the old line said, literally: the phase is a fact about the
 * *server*, not about this body, so a player who opted out, or who never joined, or who surrendered and walked back
 * to the lobby, got the whole mechanic for the length of somebody else's round.
 *
 * **So the first half is {@link isParticipant}, which is the round's own statement that it has this player** — the
 * phase *and* `IN_ROUND_ATTRIBUTE`, both of them, the same predicate the camera's shift-lock already uses. One rule,
 * two readers, rather than a second definition of "in the round" that could drift from the first.
 *
 * **The comment that used to stand here argued the opposite, and its argument was about a state that no longer
 * exists.** It said the two questions were deliberately kept apart — the camera and the dodge asking *"is the game
 * being played around me"*, the team ring and the surrender prompt asking *"am I still in it"* — on the grounds that
 * `activePlayers` had never been replicated and was not going to be. `IN_ROUND_ATTRIBUTE` is that fact, published
 * since 2026-10-20, so the distinction the paragraph was protecting is no longer a distinction between a *replicated*
 * fact and an unreplicated one: both halves are readable here now. What the dodge actually wants is the second
 * question, and the first was standing in for it because the second could not be asked.
 *
 * **`character` and not a `Player`**, because the zone half is about the body: a player standing on a practice floor
 * is inside a box their `Player` knows nothing about. The player is resolved from the body for the round half, which
 * is the same call `sideOfBody` makes for the same reason — the attribute lives on the `Player` and the box test
 * needs the model.
 *
 * **A body with no player behind it** — a rig — is not a participant, so this answers `inTaggedZone` for it. That is
 * correct rather than incidental: a rig's dodge is gated on the server by the phase, which is its membership.
 */
export function inRoundOrZone(character: Model | undefined): boolean {
	const player = character !== undefined ? Players.GetPlayerFromCharacter(character) : undefined;

	return (player !== undefined && isParticipant(player)) || inTaggedZone(character);
}
