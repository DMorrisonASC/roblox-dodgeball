import { resolveDodgeable } from "shared/dodge";
import { NPC_CONFIG } from "shared/config/npc.config";
import { TEAM_ATTRIBUTE } from "shared/constants";
import { TEAM_A, TEAM_B } from "../../services/round/team";
import { BEHAVIOR_WALK_TO_JOIN_PAD, NpcBehavior } from "../Behavior";

/**
 * The attribute a rig's destination is written to, as a `Vector3`: the world point it walks to.
 *
 * **Declared here rather than in `shared/constants.ts`, which is the exception in this project.**
 * Almost every attribute name lives there — `TEAM_ATTRIBUTE`, `PRACTICE_ZONE_ATTRIBUTE`, the four a
 * rig's animation is published through — and the reason is always the same: two files that cannot
 * import from each other have to agree on a string, and at least one of them is on the client. This
 * one is written by `LobbyRigService` and read by this file, both on the server, and no client has
 * any idea the walk exists. So the pair that has to agree is the writer and the reader, and the
 * reader is this file. The *tag* beside it is the other half of the contract, and that one lives in
 * `Behavior.ts` with the rest of them, because a tag is a thing a place file or a spawner names and
 * nothing names an attribute.
 *
 * **A `Vector3` rather than a reference to the pad**, which is also what `Humanoid.MoveTo` takes. The
 * alternative — handing the rig the pad itself — would need an attribute that can hold an `Instance`,
 * and the installed typings disagree with themselves about whether that is even allowed:
 * `SetAttributeValue` is declared as `AttributeValue | Instance` while `AttributeValue` itself has no
 * `Instance` in it. Nothing here depends on the answer. What the `Vector3` costs is named: the target
 * is a *point* rather than a reference, so a pad dragged in Studio while a rig is walking to it leaves
 * that rig walking to where the pad used to be. This is a boot-time trip across a lobby, so that is a
 * price paid once rather than a rule that has to be defended.
 */
export const WALK_TO_JOIN_PAD_ATTRIBUTE = "WalkToJoinPad";

/**
 * The attribute carrying the **side** the rig is walking to, as a `TeamLabel` — `"A"` or `"B"`.
 *
 * **A second attribute rather than a lookup, and that is a decision with a cost attached.** The walk
 * knows only a `Vector3`; the side it is walking to is a fact about the *pad*, and the pad is a
 * `BasePart` wearing one of two tags. Recovering the side at the other end could be done three ways —
 * search the tagged parts for the one at this destination, walk the pads again and match tags, or be
 * told — and only the third is exact. Both alternatives ask a question with an ambiguous answer: two
 * parts wear the same tag, and comparing floats to find "which one is this" is a lookup whose failure
 * mode is a rig silently joining the wrong side.
 *
 * **So the spawner writes both, and the pair is what makes this behaviour's destination complete.**
 * They are written in the same three lines, from the same decision, and neither is derivable from the
 * other without the ambiguity above. The cost, stated: two attributes rather than one, so a hand-tagged
 * rig has two things to remember instead of one — which the warning below is what covers.
 *
 * **Placeholder string**, in the same family as its sibling.
 */
export const WALK_TO_JOIN_PAD_SIDE_ATTRIBUTE = "WalkToJoinPadSide";

/**
 * What one rig is doing about its pad.
 *
 * Kept per rig because a behavior is **one object shared by every rig that wears its tag** — the same
 * shape `SeekBehavior` and `RespawnBehavior` keep their own per-rig rows in, and for the same reason:
 * the only place a rig's own progress can live is a map keyed by its model.
 */
interface Walk {
	/**
	 * Set the once, so a rig that is misconfigured says so once rather than on every turn.
	 *
	 * **One flag for two faults, because a rig can only have one of them.** A rig with no destination never
	 * reaches the arrival branch at all; a rig whose destination is fine but whose side is missing reaches
	 * it, finds nothing to complain about, and is left standing on a sign and on no side with a warning to
	 * that effect. The two warnings therefore cannot both fire for one rig, and a second flag would be
	 * bookkeeping for a case that cannot happen.
	 *
	 * **There used to be an `arrived` flag here, and the tag's removal replaced it.** The arrival branch now
	 * takes this behaviour's own tag off the rig, so "has this rig arrived" stopped being a fact about this
	 * row and became a fact about the tag set — the answer every other reader of a rig already asks for. See
	 * the arrival branch for what that fixed as well as for what it means.
	 */
	reported: boolean;
}

/**
 * Walking to a join pad, for an NPC.
 *
 * **Why this exists.** The rigs in a lobby are placeholders standing in for players who have not
 * arrived: one per seat a match allows, spawned at the round's own lobby spawns, each with a side's
 * pad to stand on. A rig *placed* on its pad would be a body that appears on the sign out of nowhere,
 * and a lobby is precisely where somebody is watching — so they spawn where a player spawns and walk
 * to the sign, which is the one part of that illusion that costs a behaviour.
 *
 * **`MoveTo` and not `PathfindingService`, for the reason `SeekBehavior` gives at length** — which
 * applies here with less force: this walk is a straight line across a lobby floor, and a path object
 * recomputed per rig for a trip with nothing in it would be the largest thing in this directory. What
 * that costs is the same as it costs there, and it is smaller here because the destination is
 * *authored*: a dev who puts something between the spawns and the pads will see a rig standing against
 * it, which is a place-file answer to a place-file question rather than a behaviour that has to guess.
 *
 * **It walks to a point it was handed rather than to a place it looked up.** The destination is the
 * rig's own `WalkToJoinPad` attribute, written by whoever spawned it — see
 * {@link WALK_TO_JOIN_PAD_ATTRIBUTE}. Nothing here knows what a join pad *is*, which tag it wears, or
 * that there are two sides: a rig told to walk to a point walks to that point. That is what keeps the
 * lobby's layout out of the machine that animates NPCs, and it is why a rig may be spawned into any
 * room at all by writing one attribute on it.
 *
 * **The walk is re-issued every turn, and that is the one place this differs from `SeekBehavior`.**
 * That behaviour issues a `MoveTo` only when its target has moved, and it can afford to: it re-aims at
 * a moving ball anyway, so a walk the body has dropped comes back on the next retarget as a matter of
 * course. This destination never changes, so a walk the humanoid has dropped would never be re-issued
 * at all — the engine stops a body that cannot make progress, and a shove stops one that can — and the
 * rig would stand wherever it was left with nothing in the output to say why. Repeating the same point
 * is not a second walk, it is the same request again, and at this behaviour's cadence it is twice a
 * second per rig.
 *
 * **Arriving is the end of it: the rig stands on the pad and this behavior does nothing more.** No
 * patrol, no second trip, and no walking back if the body is later shoved off. That last one is
 * deliberate rather than overlooked — what these rigs are for is standing in the lobby as
 * placeholders, and a body that picks itself up and returns would read as a body *deciding* to, which
 * is a claim about the rig's intent that nothing here backs up. `SeekBehavior` states its own limits
 * for the same reason and in the same place.
 *
 * **Reaching a pad is where the rig takes its side, and that is a reversal of what this file used to
 * say.** It used to end with "reaching a pad does not put the rig on a side" — true, and it left the rig
 * inert: `npc/rigs.ts` reads `Team` and nothing else, so a walked rig was a placeholder standing on a
 * sign that the round ignored completely. The arrival branch in `tick` now writes `TEAM_ATTRIBUTE` from
 * `WalkToJoinPadSide`, and what that buys is the whole point of the rig system: the body becomes a
 * participant the instant it is standing where it was told to stand.
 *
 * **A rig mid-walk still has no side, and that is load-bearing rather than incidental.** The write is in
 * the arrival branch and nowhere else, so a rig on its way to a pad is a body holding no seat — which is
 * what lets `LobbyRigService` count a walker as a seat without double-counting it once it arrives, and
 * what keeps the round's own derivation (`rigs.ts`) from seeing a placeholder before it has taken its
 * post.
 *
 * **What this still does not do.** No patrol, no re-walk if the body is shoved off, no second trip, and
 * no behaviour set: a rig that has arrived stands on its pad and does nothing else, because a placeholder
 * holds a *seat* — giving it a throwing or dodging set is a separate decision with its own tags. See the
 * arrival branch for what is written and `LobbyRigService` for who reads it.
 *
 * **The tag comes off the rig the moment it arrives**, so "has this rig arrived" is answered by the rig's own
 * tag set rather than by a flag inside this file. That is what makes a *rebuilt* rig behave: `RespawnBehavior`
 * hands the replacement the corpse's tags, and a corpse that still wore this tag meant a rig that stood up in
 * the arena and walked off towards the lobby. See the arrival branch for the whole of that.
 *
 * **And wearing this beside `Behavior_Seeking` is two walkers on one body.** Both issue `MoveTo`, and
 * whichever ticks later each turn wins, so a rig wearing both walks to a ball and then back to its pad.
 * Nothing is refused here, because the two tags are independent strings and this is the same class of
 * interaction the catch/dodge pair has: real, worth knowing, and not a runtime rule's business to
 * police.
 */
export function createWalkToJoinPadBehavior(): NpcBehavior {
	/** One row per rig, made on first use. See `onDied` for the row that goes with the rig it belonged to. */
	const walking = new Map<Model, Walk>();

	/** The rig's own row, made the first time this behavior sees it. */
	const stateOf = (model: Model): Walk => {
		let walk = walking.get(model);
		if (walk === undefined) {
			walk = { reported: false };
			walking.set(model, walk);
		}

		return walk;
	};

	return {
		tag: BEHAVIOR_WALK_TO_JOIN_PAD,
		tickInterval: NPC_CONFIG.WALK_TO_PAD_TICK_SECONDS,

		/**
		 * A rig that cannot walk is a rig this behavior can do nothing with, so the speed is stated
		 * here rather than left to the template.
		 *
		 * **This is the one thing a spawner cannot check for itself.** A template authored as a *pose*
		 * quite reasonably carries a `WalkSpeed` of zero, and the symptom is a rig that is told to walk,
		 * agrees, and does not move — which looks exactly like a rig that has already arrived, so
		 * nothing in the output distinguishes the fault from the working case. See
		 * `NPC_CONFIG.WALK_TO_PAD_SPEED`, which says what the number is and why sixteen.
		 */
		prepare(model) {
			const humanoid = model.FindFirstChildWhichIsA("Humanoid");
			if (!humanoid) return;

			humanoid.WalkSpeed = NPC_CONFIG.WALK_TO_PAD_SPEED;
		},

		tick(model, humanoid) {
			const walk = stateOf(model);

			// The part this rig is judged and moved by, through the helper a seek, a dodge and a pickup
			// already ask the same question through — and it answers for a model with no humanoid too.
			const root = resolveDodgeable(model)?.root;
			if (!root) return;

			const target = model.GetAttribute(WALK_TO_JOIN_PAD_ATTRIBUTE);

			// **No destination, said once.** A rig wearing this tag with no attribute is a rig somebody
			// tagged by hand, or one whose spawner never got as far as writing it — and the symptom
			// otherwise is a body standing still, which is what an arrived rig looks like too. A line here
			// is what stops the fault hiding behind the working case; once, because a warning per turn
			// would bury it in its own repetition.
			if (!typeIs(target, "Vector3")) {
				if (!walk.reported) {
					walk.reported = true;

					warn(
						`[NPC] ${model.Name} wears ${BEHAVIOR_WALK_TO_JOIN_PAD} but has no ` +
							`${WALK_TO_JOIN_PAD_ATTRIBUTE} — it will stand where it is`,
					);
				}

				return;
			}

			// **Flat, and it is the arrival test rather than the walk.** A pad is a place on the floor,
			// so the question is "am I over it" rather than "am I at its height" — a rig standing on the
			// pad is a couple of studs below the point in the middle of it, and a three-dimensional
			// distance would have a rig walking at a pad it is already standing on for ever.
			const offset = new Vector3(target.X - root.Position.X, 0, target.Z - root.Position.Z);

			if (offset.Magnitude <= NPC_CONFIG.WALK_TO_PAD_ARRIVAL_STUDS) {
				// **The seat is taken on this line, and it is the whole of what makes a placeholder a
				// participant.** Everything downstream of a rig reads `TEAM_ATTRIBUTE` and nothing else —
				// `npc/rigs.ts` is that read — so this write is what turns a body standing on a sign into a
				// body the round will count, teleport and score against. It happens here rather than at
				// spawn because a rig that took its side at spawn would be a participant standing in the
				// lobby, which the round would then teleport into the arena from wherever it was when the
				// round opened; a rig that takes its side *on the pad* is a participant that has already
				// arrived by the time anyone asks.
				//
				// **The value is validated, and a missing one is reported once rather than guessed.** The
				// alternative — inferring the side from the destination — is what
				// `WALK_TO_JOIN_PAD_SIDE_ATTRIBUTE`'s own doc argues against: two pads wear the same tag, and
				// matching a point to a part is a lookup whose failure mode is a rig quietly joining the
				// wrong side. A rig whose side is missing stays side-less and stands where it is, which is
				// `rigs.ts`'s inert answer and an honest one.
				const side = model.GetAttribute(WALK_TO_JOIN_PAD_SIDE_ATTRIBUTE);

				if (side === TEAM_A || side === TEAM_B) {
					model.SetAttribute(TEAM_ATTRIBUTE, side);
				} else if (!walk.reported) {
					walk.reported = true;

					warn(
						`[NPC] ${model.Name} reached its pad but has no ${WALK_TO_JOIN_PAD_SIDE_ATTRIBUTE} — ` +
							`it is standing on a sign and on no side`,
					);
				}

				// **The stop is a `MoveTo` to where the rig already is**, which is the engine's own way
				// of saying "stay here" — the same call `SeekBehavior` makes, for the same reason. There
				// is no second mechanism: a humanoid walks until something tells it otherwise, and this
				// is what tells it.
				humanoid.MoveTo(root.Position);

				// **And the tag comes off, which is the end of this behaviour on this rig — and what stops a
				// rebuilt rig from walking back to the lobby.**
				//
				// The tag means "walk to the pad you were told about", and that is over. Everything this file
				// used to do with an `arrived` flag is now done by the tag's absence: a rig *wearing* this tag
				// means a rig still on its way, which is exactly how `LobbyRigService` reads it — see
				// `moveWalkersToArena`, whose whole job is rigs that have not arrived — and a rig that has
				// taken a side means a rig at its post.
				//
				// **What it fixes, because a flag could not: `RespawnBehavior` copies the corpse's tag set
				// onto the body that replaces it.** The corpse of a rig that had arrived still wore this tag,
				// because the arrival branch only ever *set a flag* — so a rig killed mid-round came back
				// wearing "walk to a pad", and `RespawnBehavior` also clones the rig's attributes along with
				// the body, which brings the destination with them. The result was a rig standing up in the
				// arena and setting off towards the lobby, and no flag could have guarded against it: `stateOf`
				// keys on the model, a rebuilt rig is a *new* model, and the new row started with nothing
				// arrived in it. Taking the tag off means there is no tag left for a corpse to carry.
				//
				// **And the row goes with the tag, which is the one thing `onDied` cannot do for it.** A rig
				// that no longer wears this tag never has `onDied` called for it again, so the row would sit
				// here holding a destroyed model for as long as the server runs — the leak `onDied`'s own
				// comment describes, arriving through the door that comment did not imagine.
				model.RemoveTag(BEHAVIOR_WALK_TO_JOIN_PAD);
				walking.delete(model);

				return;
			}

			humanoid.MoveTo(target);
		},

		/**
		 * The rig's row goes when the rig does.
		 *
		 * A row keyed by a model is a reference *to* that model, so leaving it behind would keep a
		 * corpse alive for as long as the server runs. Nothing is carried across: a replacement is a
		 * different model standing somewhere else with its own `WalkToJoinPad` written on it, and it
		 * makes its own row on its first turn — the same reasoning `SeekBehavior.onDied` gives, and the
		 * same one line.
		 */
		onDied(model) {
			walking.delete(model);
		},
	};
}
