import { NPC_CONFIG } from "shared/config/npc.config";

/**
 * **A rig's corpse, on sockets: the body goes limp and stays whole.**
 *
 * **What this exists for, and the two things it is a choice between.** Roblox offers exactly one ragdoll out
 * of the box: `Humanoid.BreakJointsOnDeath = true`, which *destroys* every `Motor6D` at the moment of death
 * and leaves the limbs as separate bodies. That is not a ragdoll — it is an explosion. It reads as a body
 * coming apart rather than a body falling over, the parts scatter a few studs and land where they land, and a
 * watcher's first thought is a bug rather than a death. This module is the other option: the joints are left
 * alone at death (`BreakJointsOnDeath = false`), and each `Motor6D` is then **swapped for a
 * `BallSocketConstraint` at the same offset**, so the limb stays attached and stops being driven. The
 * silhouette survives; only the pose stops being one.
 *
 * **It is a swap rather than an edit, and the offset is the whole of what makes it invisible.** A `Motor6D`
 * holds `Part1` at `Part0.CFrame * C0` relative to `Part1.CFrame * C1` — a rigid, driven joint. A
 * `BallSocketConstraint` between two `Attachment`s at exactly those `C0`/`C1` positions holds the same two
 * parts at the same relative point and lets them *rotate* about it, which is the whole mechanical difference
 * between a shoulder and a shoulder-shaped hinge. Place the attachments anywhere else and the body snaps into
 * a new pose on the frame it dies; placed at `C0`/`C1` it simply goes slack.
 *
 * **The limits are the difference between a ragdoll and a tangle.** With no limits every limb is free to
 * rotate a full turn at every joint, and a body that has fallen folds itself into shapes no skeleton makes —
 * a shin through a thigh, an arm out of the opposite shoulder. `LimitsEnabled` with a cone and a twist makes
 * each joint stop where a joint stops, which is what reads as *limp* rather than as *broken*. The number is
 * one dial: a smaller cone is a stiffer corpse, a larger one is floppier and eventually impossible.
 *
 * **What this is not.** It is not a skeleton, a bone system, or a second animation path: it runs once, at a
 * death, on a body that is about to be destroyed and rebuilt — `RespawnBehavior` takes the corpse away after
 * `RESPAWN_DELAY_SECONDS` — so nothing here is ever undone, stepped, or read again. There is no service, no
 * per-frame work and no state that could drift: the corpse *is* the state, and it dies with the model.
 *
 * **Who calls this.** `RespawnBehavior`, on the death of a rig wearing it — which is every rig that plays a
 * round or stands on a practice floor. A rig with **no** `Behavior_Respawn` (a hand-tagged body, a lobby rig
 * between rounds) keeps the engine's behaviour, because nothing is watching for its death to convert it; see
 * `LobbyRigService.retireHopelessCorpses`, which is what destroys those. Stated because it is a gap rather
 * than a design: the honest fix is a death watch on every rig, and it is not worth a listener per body while
 * the only rigs that can be shot are the ones this covers.
 */

/** What an attachment the swap made is called. Numbered per joint, so one part can host several. */
const SOCKET_ATTACHMENT_PREFIX = "RagdollSocket";

/** What the constraint is called, so a stray one in the Explorer is recognisable. */
const SOCKET_NAME = "RagdollSocket";

/**
 * Swaps `model`'s joints for sockets, **and answers how many it converted**.
 *
 * **Every `Motor6D` and nothing else.** A `Weld` is not an articulated joint — it holds a hat on, a tool in a
 * hand, an accessory to a head — and converting one would make the hats fall off, which is a different and
 * worse look than the one this is fixing. `Motor6D`s are the limbs, and they are what a player's body is
 * jointed with too.
 *
 * **A joint with a missing end is skipped rather than guessed at.** `Part0` and `Part1` are both optional in
 * the engine and can be `nil` on a joint being built or one whose part was destroyed; a socket against a
 * `nil` attachment is a constraint that does nothing and a `Destroy` that would have removed a joint nothing
 * replaced. Skipping leaves that joint rigid, which is the failure that looks like a stiff limb rather than
 * the one that looks like a bug.
 *
 * **Called once per body.** The joints are the input and the sockets are the output, so a second call finds no
 * `Motor6D` and converts nothing — which is also what makes it safe to call from any path that can observe the
 * same death twice.
 */
export function ragdoll(model: Model): number {
	let converted = 0;

	for (const descendant of model.GetDescendants()) {
		if (!descendant.IsA("Motor6D")) continue;

		const part0 = descendant.Part0;
		const part1 = descendant.Part1;
		if (part0 === undefined || part1 === undefined) continue;

		// **At the joint's own offsets**, which is what keeps the pose it died in. See the module doc.
		const from = new Instance("Attachment");
		from.Name = SOCKET_ATTACHMENT_PREFIX + converted + "A";
		from.CFrame = descendant.C0;
		from.Parent = part0;

		const to = new Instance("Attachment");
		to.Name = SOCKET_ATTACHMENT_PREFIX + converted + "B";
		to.CFrame = descendant.C1;
		to.Parent = part1;

		const socket = new Instance("BallSocketConstraint");
		socket.Name = SOCKET_NAME;
		socket.Attachment0 = from;
		socket.Attachment1 = to;
		// **Limited, for the reason the module doc gives**: an unlimited ball joint lets a corpse fold itself
		// into shapes a body cannot make. The cone is the same number as the twist, so one dial tunes both.
		socket.LimitsEnabled = true;
		socket.UpperAngle = NPC_CONFIG.RAGDOLL_LIMIT_DEGREES;
		socket.TwistLimitsEnabled = true;
		socket.TwistLowerAngle = -NPC_CONFIG.RAGDOLL_LIMIT_DEGREES;
		socket.TwistUpperAngle = NPC_CONFIG.RAGDOLL_LIMIT_DEGREES;
		socket.Parent = part0;

		// **The joint goes last, after the socket that replaces it.** Doing this first would leave a frame in
		// which the limb is held by nothing — and a frame is enough for a body already under gravity to start
		// separating from its own shoulder.
		descendant.Destroy();

		converted += 1;
	}

	return converted;
}
