import { Workspace } from "@rbxts/services";
import { resolveDodgeable } from "shared/dodge";
import { CHARACTER_CONFIG } from "shared/config/character.config";
import { NPC_CONFIG } from "shared/config/npc.config";
import { TEAM_ATTRIBUTE } from "shared/constants";
import { logInfo, logWarn } from "shared/logger";
// **A type-only import, because a behaviour must not require the service it is handed.** `SeekBehavior`
// imports its own speed service the same way and for the same reason: the value arrives as a parameter
// from `NpcService`, which already holds it, so nothing here needs the module at runtime — and a real
// import would make this file pull in a `@Service()` through a path that is not the one Flamework
// registers it on.
import type { WalkSpeedService } from "../../services/character/WalkSpeedService";
import { TEAM_A, TEAM_B } from "../../services/round/team";
import { BEHAVIOR_WALK_TO_JOIN_PAD, NpcBehavior } from "../Behavior";
import { sideWithRoom } from "../rigs";

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
 *
 * **A point drawn *on* the pad rather than the pad's centre** — `LobbyRigService.padArrivalPoint` picks it
 * inside the pad's own footprint, so a side's rigs fan out across the sign instead of all walking to one
 * coordinate and standing in a stack on it. **Nothing here needs to know that**: this file walks to whatever
 * point it is handed and the arrival radius is the whole of what says how close is close enough, which is the
 * same division of labour the paragraph above is about — the lobby knows where a pad is, this file knows how
 * to walk. The inset the draw uses is deliberately the arrival radius, so a point near the pad's edge still
 * leaves a rig that comes to rest *on* the sign; see `PAD_EDGE_MARGIN`.
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
 * The attribute carrying the **instant the rig may set off**, as a server-time `number`.
 *
 * **The delay lives here rather than in a `Map` in this file, and that is the decision this task turned
 * on.** The alternative was a per-model deadline seeded by this behaviour on the turn the tag first
 * arrives — which is the shape `SeekBehavior`'s per-rig rows take — and it is wrong for one specific
 * reason that has nothing to do with tidiness: **this behaviour cannot tell a new walk from an
 * interrupted one, and the rigs that are interrupted are the ones that need the delay reset.**
 *
 * A rig that never reaches its pad is stripped of this tag by `LobbyRigService.moveWalkersToArena` when a
 * round opens, and nothing calls `onDied` for a tag removal — a behaviour is simply no longer asked, so its
 * row stays. At the next intermission `LobbyRigService.sendRigsToTheirPads` puts the tag back, and a row
 * keyed on the model is *found* rather than made: the stale deadline is in the past by then, so the rig
 * would set off the instant it was re-tagged, with no wait at all — for exactly the rigs whose walk was
 * interrupted, which with a ten-to-fifteen second wait against a sixteen-second intermission is most of
 * the lobby. Reconciling it inside this file would mean guessing that a change of destination means a new
 * walk, and the pad is drawn on a rotation that can hand the same pad back twice, so the guess is wrong
 * sometimes and silently right the rest of the time.
 *
 * **Written by whoever decided the rig should walk, exactly like the two above it.** That is the same
 * argument the destination's own doc makes: a join pad is a fact about the *lobby*, and a spawner that
 * says "walk to this point" is the thing that knows when the instruction was given. So this behaviour
 * reads three attributes and owns none of them — and the delay survives a rebuilt rig for the same reason
 * the destination does, because a rebuilt body is handed the attributes the corpse carried.
 *
 * **An absent or unreadable value means "go now", deliberately.** A rig tagged by hand in Studio has
 * nobody to write this, and the honest reading of a walk with no stated start is that it starts — where a
 * default wait would be this file inventing an instruction, and a default of zero would be the same thing
 * spelled out. `LobbyRigService` is the only writer and it always writes one.
 *
 * **Placeholder string**, in the same family as its two siblings.
 */
export const WALK_TO_JOIN_PAD_AT_ATTRIBUTE = "WalkToJoinPadAt";

/**
 * The attribute carrying the **point the rig looks at when it stops short on the look-around route**, as a
 * `Vector3` — the *other* side's pad.
 *
 * **A point rather than a side, and that is what keeps this behaviour's own argument true.** This file's
 * class doc argues at length that the walk is *told* where to go rather than looking anything up, and that
 * a join pad is the lobby's vocabulary rather than the NPC machine's. The alternative here — reading
 * `MATCH_JOIN_A_TAG` and `MATCH_JOIN_B_TAG` and working out which of the two is the *other* one — would put
 * the two-tag fact and the "which side am I" question back in this file, which is the whole of what the
 * attribute model exists to avoid. What arrives instead is one coordinate, which is the same primitive the
 * destination is and the only kind of thing `CFrame.lookAt` wants.
 *
 * **Written by the spawner that already knows the side**, and drawn from the other side's pads the same way
 * the destination is drawn from its own — `LobbyRigService.nextPad`, so a side's rigs spread rather than
 * all turning to face one sign.
 *
 * **An absent value cancels the route rather than failing**, because a hand-tagged rig cannot have one: the
 * look-around route is drawn by this behaviour (it is a gait, not a placement), so a rig with no look-at is
 * one this file would otherwise have turning to face nothing. See `tick`, which drops the route and says so
 * once.
 *
 * **It has a second job now: it is also the point the walk keeps clear of.** A rig sent to one side's pad
 * walks over the other side's, because two signs in one lobby is all it takes and `Humanoid:MoveTo` walks a
 * straight line. The pads a walk has to avoid are pads of the same "other side" whose signs it turns to look
 * at, so one coordinate answers both questions — a second *point* attribute would be a second draw from the
 * same set of pads, and the day one was written and the other was not, a rig would look at one sign and walk
 * across another.
 *
 * **And it is drawn as the pad actually in the way, which is the correction the first version needed.** The
 * point used to come from `nextPad`'s rotation — a pad of the other side, but not necessarily the one between
 * the rig and its destination; with one pad a side that is the same pad and the two questions have one
 * answer, and with several it was a coin toss. `LobbyRigService.writePadWalk` now picks **the other side's pad
 * nearest the straight line the rig is about to walk**, so the sign the rig turns to look at is the sign it
 * has to step around — which reads better than a rotation anyway.
 *
 * **The size of the thing being avoided does not travel with the point**, because a `Vector3` cannot carry
 * one: {@link WALK_TO_JOIN_PAD_AVOID_RADIUS_ATTRIBUTE} is written beside it and is the pad's own measured
 * footprint. See `aimAroundPad` for what the pair is used for.
 *
 * **Placeholder string**, in the same family as its three siblings.
 */
export const WALK_TO_JOIN_PAD_LOOK_AT_ATTRIBUTE = "WalkToJoinPadLookAt";

/**
 * The attribute carrying **how much room the pad walk must leave around the look-at point**, in studs: the
 * other side's pad's own flat circumradius, written by the spawner that can see the part.
 *
 * **Why this is measured rather than a constant, and it is a correction.** The corridor's first version kept
 * a fixed twelve studs clear of the pad's centre, which is only right for a sign about fourteen studs across
 * — and a pad is a place-file fact no file in `src` can see. A wider sign meant a rig passing twelve studs
 * from its centre walked over the end of it, and the fix looked like it had done nothing. The spawner holds
 * the part, so the measurement is taken there: `0.5 × sqrt(x² + z²)`, the radius of the disc that covers the
 * pad's footprint.
 *
 * **A number on the rig rather than a size, because the walk is flat.** The pad is a slab a body stands on,
 * so its height says nothing about where a body walking past it may go; a `Vector3` of the part's size would
 * invite a reader to use all three axes and get a corridor that dodges the pad's thickness.
 *
 * **Absent means the fallback constant**, `NPC_CONFIG.PAD_AVOID_RADIUS_STUDS` — a rig tagged by hand in
 * Studio was written by nobody and has no measurement. The corridor still runs, from the guessed radius,
 * which is the best a rig with no spawner can be given.
 *
 * **Placeholder string**, in the same family as its siblings.
 */
export const WALK_TO_JOIN_PAD_AVOID_RADIUS_ATTRIBUTE = "WalkToJoinPadAvoidRadius";

/**
 * The contribution a rig's run is added under, **deliberately the same word a player's sprint uses.**
 *
 * A byte-for-byte copy of `SeekBehavior`'s own constant, for the reason that file gives: the key is scoped
 * to a *model*, a player's character is never a rig, and the day something asks `WalkSpeedService.isSprinting`
 * it should get one answer for both kinds of body rather than a name it has to know per body kind. Two
 * copies rather than a shared constant because a constant exported from a behaviour file for another
 * behaviour is a dependency between two siblings that have nothing else to say to each other.
 */
const SPRINT_KEY = "Sprint";

/**
 * How long a rig's run survives without a turn to renew it, in seconds.
 *
 * **A watchdog, because a behaviour has no `onStopped`** — the same one `SeekBehavior` carries, at the same
 * length, for the same class of leak. A run is a contribution on the body and the body outlives the tag:
 * a rig stripped of this tag at a round boundary never ticks again, so nothing in this file can take the
 * contribution back off, and what is left is a rig walking at `base + 15` for the rest of the session,
 * with the run clip on it, and nothing in the output to say why.
 *
 * The fix is `createWindupTracker`'s: a token-guarded timer that can only *undo*, re-armed on every turn of
 * the walk, so it never fires while the behaviour is being run and always fires once it stops. Three turns
 * rather than one, on `SeekBehavior`'s arithmetic — a single interval would drop a run on one slow frame.
 */
const SPRINT_WATCHDOG_SECONDS = NPC_CONFIG.WALK_TO_PAD_TICK_SECONDS * 3;

/**
 * How long past a look's own dwell its cleanup timer waits before undoing the look, in seconds.
 *
 * **The same watchdog idea as {@link SPRINT_WATCHDOG_SECONDS}, and it is needed for a sharper fault.** A
 * look switches `Humanoid.AutoRotate` off and holds the body's facing with an `AlignOrientation`; if the
 * behaviour stops being ticked — the tag is stripped at a round boundary, which is exactly what
 * `LobbyRigService.moveWalkersToArena` does — then nothing gives the humanoid its own rotation back and
 * nothing destroys the constraint. What is left is a rig whose head is welded to a point in the *lobby*
 * for the rest of the session, walking sideways wherever the round sends it, and completely invisible in
 * the Explorer as anything but a stray `AlignOrientation` on a rig.
 *
 * **Two turns of margin, so it cannot fire while the dwell it belongs to is still running.** The stage
 * advances on this behaviour's own cadence, so a dwell of one second is two turns and the timer is armed a
 * turn past the end of it; a timer armed at exactly the dwell would race the turn that ends it, which is
 * the one thing a "can only undo" timer must not do.
 */
const LOOK_WATCHDOG_MARGIN_SECONDS = NPC_CONFIG.WALK_TO_PAD_TICK_SECONDS * 2;

/** The look's attachment and constraint, named so a stray one is attributable in the Explorer. */
const LOOK_ATTACHMENT_NAME = "WalkLookAttachment";
const LOOK_CONSTRAINT_NAME = "WalkLookBalance";

/** The same three numbers `ThrowBehavior.aimAt` builds its constraint with, and for its reasons. */
const LOOK_MAX_TORQUE = 1e6;
const LOOK_RESPONSIVENESS = 50;

/** Below this the flat offset to a point has no heading to turn to — `ThrowBehavior`'s own guard. */
const LOOK_FLAT_EPSILON = 0.001;

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
	 * **One flag for three faults, because a rig can only have one of them.** A rig with no destination
	 * never reaches the arrival branch at all; a rig whose destination is fine but whose side is missing
	 * reaches it, finds nothing to complain about, and is left standing on a sign and on no side with a
	 * warning to that effect; and a rig whose look-around route finds no point to look at drops the route
	 * and says so. Each check returns or falls through before the next one can fire, so the warnings cannot
	 * co-occur for one rig, and a flag per fault would be bookkeeping for cases that cannot happen together.
	 *
	 * **There used to be an `arrived` flag here, and the tag's removal replaced it.** The arrival branch now
	 * takes this behaviour's own tag off the rig, so "has this rig arrived" stopped being a fact about this
	 * row and became a fact about the tag set — the answer every other reader of a rig already asks for. See
	 * the arrival branch for what that fixed as well as for what it means.
	 */
	reported: boolean;

	/**
	 * Whether this rig's wait is over and the walk it was sent has begun.
	 *
	 * **The line between "told to walk" and "walking"**, and the only thing that keeps the two draws below
	 * from being made on every turn. Everything before it is a rig standing where it was spawned; everything
	 * after it is a rig that has committed to a gait and a route. Cleared by {@link resetWalk}, which is what
	 * a fresh instruction does to it, and dropped with the row when the walk ends.
	 */
	started: boolean;

	/**
	 * The instant this row first saw the walk's deadline, on the *attribute's* clock, for the printed wait.
	 *
	 * **A measurement rather than the number the spawner drew, and the difference is a real one.** The delay
	 * is the writer's — it draws it and writes it as an absolute instant — so this file never sees the drawn
	 * figure at all; what it can measure is the gap between the deadline it was handed and the moment it was
	 * handed it, which is the drawn delay minus however long it took the first turn to arrive (one tick at
	 * the outside). It exists so the walk's one line can name an actual number, which is the difference
	 * between a log that says a rig waited and one that says how long.
	 */
	toldAt?: number;

	/**
	 * The exact attribute value this row is waiting on, so a **changed** instruction is told from a repeat of
	 * the one already seen.
	 *
	 * **This is what makes "a new walk" a fact rather than a guess**, and it is the one field that has to be
	 * compared rather than tested. Every sighting of a deadline is the same sighting as the last one while a
	 * rig stands waiting, and the writer draws a *fresh* number for every walk — so equality is the difference
	 * between "still waiting for the walk I was sent" and "the lobby has sent me another one", which is exactly
	 * the distinction the reset below turns on. Without it, a rig whose walk was interrupted while it was
	 * still waiting would carry the previous wait into the new one: its printed delay would be measured from a
	 * moment in the last intermission, and it would print a number larger than the window it was drawn from.
	 */
	deadline?: number;

	/** The gait drawn for this walk: `true` runs, `false` walks. Drawn once, at {@link started}. */
	run: boolean;

	/** Whether this walk takes the look-around route **and has not taken it yet**. */
	look: boolean;

	/** Where the look-around route has got to. */
	stage: WalkStage;

	/** The instant the current dwell ends, on `os.clock()`. */
	stageUntil: number;

	/**
	 * The look's constraint, and the attachment on the root it is anchored to.
	 *
	 * Held rather than looked up by name because the cleanup has to *destroy* them, and finding them again
	 * would be a name search that silently does nothing the day somebody renames one. Both are `undefined`
	 * whenever no look is live, which is how {@link clearLook} knows there is nothing to undo.
	 */
	lookAttachment?: Attachment;
	lookOrientation?: AlignOrientation;

	/**
	 * What the body's own rotation was before the look switched it off.
	 *
	 * Recorded rather than assumed `true`, for `ThrowBehavior`'s reason: the constraint is built once and
	 * may be re-aimed many times, and what has to be given back is whatever the humanoid had rather than a
	 * guess about it.
	 */
	lookAutoRotate?: boolean;

	/** The token of the live look watchdog. Only equality is ever asked of it, so one counter is enough. */
	lookToken?: number;

	/**
	 * Whether the run's contribution is on this body right now.
	 *
	 * **The decision, not the application** — the same split `SeekBehavior` keeps for its own sprint, and
	 * for the same reason: the walking turns of a short walk are ~2 a second, and `WalkSpeedService`
	 * recalculates and re-publishes on every contribution it is handed, so without this the run would be
	 * re-added twenty times over.
	 */
	running: boolean;

	/** The token of the live run watchdog. Only equality is ever asked of it. */
	runToken?: number;
}

/**
 * Where a look-around route has got to.
 *
 * **Three stages and not four, because the walk *after* the look is the same walk.** `"approach"` is a rig
 * crossing the lobby, whether it has not looked yet or has finished looking; the route is over when
 * `look` is cleared, which is the flag that says whether there is a stop short still to come. A fourth
 * "resuming" stage would be the same movement under a second name, and the two could disagree.
 */
type WalkStage = "approach" | "look-away" | "look-back";

/**
 * **Where a rig should be walking this turn: its pad, or a point beside the other side's pad when the
 * straight line would take it across it.**
 *
 * **Why this exists.** `Humanoid:MoveTo` walks a body in a straight line and knows nothing about what is in
 * it — the class doc below says so and leaves obstacles to the place file. A join pad is that problem
 * arriving: both signs stand in one lobby, every rig is spawned where a *player* spawns, and a rig sent to
 * the far pad walks over the near one. Nothing actually breaks by it — a rig takes its side from its own
 * attribute and not from the sign it walked over, so the wrong-team half of this is not reachable — but a
 * placeholder standing on the other side's pad reads as a rig that picked the wrong team, which is exactly
 * what a lobby of placeholders exists not to look like.
 *
 * **A corridor and not a plan.** Nothing here searches: each turn asks one question about the leg the body is
 * about to walk — *does it come within `radius` of the other pad?* — and answers with a point to walk at. The
 * point is the **tangent** point of that keep-clear circle seen from where the rig stands, pushed one radius
 * further along the tangent, so the leg from here is outside the circle by construction and the answer slides
 * around the pad as the rig advances. That is the same reasoning `SeekBehavior` gives for `MoveTo` over a path
 * object: a trip with one known obstacle in it is not worth a planner, it is worth one dot product and one
 * square root.
 *
 * **The radius is the pad's, not this file's.** It arrives as {@link WALK_TO_JOIN_PAD_AVOID_RADIUS_ATTRIBUTE}
 * — the other pad's own circumradius, measured off the part by the spawner — plus
 * `NPC_CONFIG.PAD_AVOID_CLEARANCE_STUDS` for the body. The first version of this used one guessed constant for
 * both, sized for a sign that turned out to be an assumption, and a rig passing twelve studs from a wider sign
 * still walked over its end. A corridor is only as good as the radius it is told: this one is told a measured
 * number wherever a spawner wrote it, and falls back to the constant only for a hand-tagged rig.
 *
 * **The thing that has to be right is that the rig keeps walking.** Aiming *at* the tangent point rather than
 * past it stalls a rig that is already level with the pad — the point it is aiming at is where it stands — so
 * the aim is the touch point plus one radius along the tangent. And the question is only asked while the pad
 * is *ahead*: once the rig has passed the pad's plane the answer is the destination again, which is what
 * stops a body circling a pad it has already walked past.
 *
 * **Three geometries have no corridor, and each is answered rather than refused.**
 *
 * - **The rig is inside the keep-clear circle** — a shove, or a spawn part placed inside it. It steps one
 *   radius straight outward, and the tangent leg takes over on the next turn. Walking on to the destination
 *   from inside the circle is the one choice that would put the body on the pad.
 * - **The rig's own pad is inside the circle too** — the two signs overlap, so there is no corridor between
 *   them and the walk is the straight line it always was. Both pads are place-file facts, and the number that
 *   decides it is the same measured radius: two pads whose discs touch cannot be walked between, and no
 *   corridor would help if they did.
 * - **No point to avoid** — a rig tagged by hand has no look-at. `tick` reads the attribute and only calls
 *   this when it is there, so such a rig walks straight, exactly as it did before.
 */
function aimAroundPad(from: Vector3, target: Vector3, pad: Vector3, radius: number): Vector3 {
	// Flat throughout: a pad is a place on the floor, and so is the leg between two of them.
	const toTarget = new Vector3(target.X - from.X, 0, target.Z - from.Z);
	const span = toTarget.Magnitude;

	// Standing on the destination — no heading to improve on. `tick`'s arrival test has usually ended the
	// walk before this is reached, so this is the guard rather than the ordinary case.
	if (span < LOOK_FLAT_EPSILON) return target;

	const toPad = new Vector3(pad.X - from.X, 0, pad.Z - from.Z);
	const reach = toPad.Magnitude;

	// **The destination inside the keep-clear disc means there is no corridor to take.** Two signs closer
	// together than this radius are two signs a rig cannot walk between, and the straight line is what is
	// left. **This test comes before the escape below, and that order is load-bearing rather than tidy:**
	// with it after, a rig walking to a destination near the other pad crossed the boundary every other turn
	// — inside, so stepped back out; outside, so walked on — and stood oscillating between two points for
	// ever. Any change to this function has to be replayed against that geometry, and against the rig
	// starting inside the circle, which is the other case the escape branch exists for.
	const toGoal = new Vector3(target.X - pad.X, 0, target.Z - pad.Z);
	if (toGoal.Magnitude <= radius + NPC_CONFIG.WALK_TO_PAD_ARRIVAL_STUDS) return target;

	// **Inside the circle: out, and only out.** A zero offset means the pad is exactly under the body, where
	// there is no outward direction and every choice crosses the pad; the destination is then the least bad
	// answer, and the next turn has a reach of its own to work with.
	//
	// **`toPad` points at the pad, so outward is its negative** — the sign is the whole of this branch, and
	// getting it wrong drives the body at the sign it is meant to be escaping.
	if (reach < radius) {
		if (reach < LOOK_FLAT_EPSILON) return target;

		const outwardX = -toPad.X / reach;
		const outwardZ = -toPad.Z / reach;

		return new Vector3(from.X + outwardX * radius, target.Y, from.Z + outwardZ * radius);
	}

	const dirX = toTarget.X / span;
	const dirZ = toTarget.Z / span;

	// **How far down the leg the pad is, and how far off it** — two projections rather than a line-distance
	// helper, because both numbers are wanted and the second is the first one taken back out again.
	const along = toPad.X * dirX + toPad.Z * dirZ;

	// Behind the rig: there is nothing to walk around, and steering would be steering backwards.
	if (along <= 0) return target;

	const lateral = math.sqrt(math.max(0, reach * reach - along * along));

	// The leg already misses it — which is also the answer at exactly one radius, where the straight line
	// grazes the circle and there is nothing left to gain by bending.
	if (lateral >= radius) return target;

	// The circle as this rig sees it: `u` points at the pad, and the two tangents leave it at `±theta`.
	const uX = toPad.X / reach;
	const uZ = toPad.Z / reach;

	const cosTheta = radius / reach;
	const sinTheta = math.sqrt(math.max(0, 1 - cosTheta * cosTheta));

	// The tangent on the side the destination is on, which is the short way round.
	const perpX = -uZ;
	const perpZ = uX;
	const side = dirX * perpX + dirZ * perpZ >= 0 ? 1 : -1;

	// **The touch point, built from the pad rather than from the rig**, because `w` — the unit vector from
	// the pad to it — is what makes the tangency checkable: the rig's own offset along `w` is one radius
	// exactly, which is the statement that the leg is tangent to the circle rather than crossing it.
	const wX = -cosTheta * uX + side * sinTheta * perpX;
	const wZ = -cosTheta * uZ + side * sinTheta * perpZ;

	const touchX = pad.X + radius * wX;
	const touchZ = pad.Z + radius * wZ;

	// **One more radius along the tangent, so the aim is somewhere to walk to rather than a place to stop.**
	// The tangent direction is `w` turned a quarter turn; of its two signs, the one leading towards the
	// destination is the one that carries the rig past the pad rather than back around it.
	let tangentX = -wZ;
	let tangentZ = wX;

	if (tangentX * dirX + tangentZ * dirZ < 0) {
		tangentX = -tangentX;
		tangentZ = -tangentZ;
	}

	const aimX = touchX + tangentX * radius;
	const aimZ = touchZ + tangentZ * radius;

	// **And never past the pad the rig is walking to.** A corridor that overshoots the destination would be
	// a body walking through its own sign and turning round; when the overshoot would land beyond it, the
	// touch point is the aim and the next turn asks the question again from there.
	const forward = (aimX - from.X) * dirX + (aimZ - from.Z) * dirZ;
	if (forward > span) return new Vector3(touchX, target.Y, touchZ);

	return new Vector3(aimX, target.Y, aimZ);
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
 * applies here with less force: this walk is across a lobby floor, and a path object recomputed per rig
 * for a trip with one known obstacle in it would be the largest thing in this directory. What that costs
 * is the same as it costs there, and it is smaller here because the destination is *authored*: a dev who
 * puts something between the spawns and the pads will see a rig standing against it, which is a place-file
 * answer to a place-file question rather than a behaviour that has to guess.
 *
 * **The one obstacle this file does know about is the other side's pad, and the walk goes around it.** It
 * used to be a straight line, and the straight line was the fault: a rig sent across the lobby walked over
 * the near sign on the way to the far one, so a placeholder ended up standing on the *other* side's pad —
 * which is the one thing a lobby of placeholders exists not to look like. The cost to this paragraph is
 * worth stating plainly, because it is a small retreat from "nothing here knows what a pad is": it still
 * does not know what a pad *is*, but it now knows one point to keep clear of — the point it already had,
 * from {@link WALK_TO_JOIN_PAD_LOOK_AT_ATTRIBUTE}, because that is the other side's sign and the look-around
 * route had already been given it. See `aimAroundPad` for the geometry and for the three geometries where no
 * corridor exists.
 *
 * **It walks to a point it was handed rather than to a place it looked up.** The destination is the
 * rig's own `WalkToJoinPad` attribute, written by whoever spawned it — see
 * {@link WALK_TO_JOIN_PAD_ATTRIBUTE}. Nothing here knows what a join pad *is*, which tag it wears, or
 * that there are two sides: a rig told to walk to a point walks to that point. That is what keeps the
 * lobby's layout out of the machine that animates NPCs, and it is why a rig may be spawned into any
 * room at all by writing one attribute on it.
 *
 * **Three draws make one lobby of rigs read as a room of people rather than as a formation, and every one
 * of them is per rig and per walk.** A **wait** of ten to fifteen seconds, written by the spawner as an
 * instant on the shared clock, so eight rigs spawned in one loop do not set off in the same second; a
 * **gait** — half walk at the rig's own speed, half run on a `Sprint` contribution, which is also what
 * puts the run clip on the fast half; and a **route**, three in ten of them stopping short to look at the
 * *other* side's pad and then at their own before carrying on. None of the three changes where a rig ends
 * up or which side it takes: the arrival branch below is the same code on both routes, and the seat
 * arithmetic in `LobbyRigService` cannot see any of them. Each one's own cost is argued at its config
 * value in `npc.config.ts`, and the two that put something *on the body* — the run and the look — are the
 * reason this file now has watchdogs, because a behaviour is never told that its tag has been taken away.
 *
 * **The walk is re-issued every turn, and that is the first of two places this differs from
 * `SeekBehavior`.**
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
export function createWalkToJoinPadBehavior(speeds: WalkSpeedService): NpcBehavior {
	/** One row per rig, made on first use. See `onDied` for the row that goes with the rig it belonged to. */
	const walking = new Map<Model, Walk>();

	/**
	 * The token the next watchdog takes.
	 *
	 * **One counter for both kinds of timer**, because a token is only ever compared for equality against the
	 * field it was stored in — `createWindupTracker`'s argument for the same shape, and a second counter
	 * would be a second thing to keep in step for a question nothing asks twice.
	 */
	let nextToken = 0;

	/** The rig's own row, made the first time this behavior sees it. */
	const stateOf = (model: Model): Walk => {
		let walk = walking.get(model);
		if (walk === undefined) {
			walk = {
				reported: false,
				started: false,
				run: false,
				look: false,
				stage: "approach",
				stageUntil: 0,
				running: false,
			};
			walking.set(model, walk);
		}

		return walk;
	};

	/**
	 * Ends this rig's run, **on every route that ends the walk** — arrival, a death, and a walk reset.
	 *
	 * Safe to call when no run is live, so each of those paths can call it unconditionally rather than each
	 * having to know whether one was ever started — the same property `ThrowBehavior.clearAim` is written
	 * for. Removing a contribution that was never added is a no-op in `WalkSpeedService` by design.
	 */
	const endRun = (model: Model, walk: Walk): void => {
		walk.runToken = undefined;

		if (!walk.running) return;

		walk.running = false;
		speeds.removeModifier(model, SPRINT_KEY);
	};

	/**
	 * Starts — or re-arms — this rig's run: the contribution the first time, and a watchdog that can only
	 * take it back off.
	 *
	 * **A contribution and not a `Humanoid.WalkSpeed` write, and the reason is the legs rather than the
	 * speed.** Both would move the body at the right number; only one also dresses it. A rig's run clip is
	 * chosen from `NPC_ANIM_SPRINTING_ATTRIBUTE`, which `NpcService.publishAnimation` fills from
	 * `WalkSpeedService.isSprinting` — the *presence of this key*, not the size of the speed — so a rig
	 * written to `31` by hand would run at a run's speed in a walk's clip. The direct write is also the
	 * second writer on one property that `WalkSpeedService` exists to remove: a rig's base is already set
	 * through this service by `SeekBehavior`, so two writers would take turns and the loser would be
	 * whichever wrote last.
	 *
	 * **Re-armed on every turn of the walk rather than only when the run begins**, which is the cost
	 * `SeekBehavior` states for its own: one `task.delay` per turn per running rig, and virtually all of
	 * them finding their token already moved on. What it buys is that a walk of any length — including the
	 * two dwells of the look-around route, which are turns on which nothing moves — keeps its run alive, and
	 * a rig whose tag is taken away mid-walk does not keep the contribution for the session.
	 */
	const startRun = (model: Model, walk: Walk): void => {
		nextToken += 1;
		const token = nextToken;
		walk.runToken = token;

		task.delay(SPRINT_WATCHDOG_SECONDS, () => {
			if (walk.runToken !== token) return;

			endRun(model, walk);
			logInfo(`[Rig] ${model.Name}: run ended — the walk it was for stopped being ticked`);
		});

		if (walk.running) return;

		walk.running = true;
		speeds.addModifier(model, SPRINT_KEY, CHARACTER_CONFIG.SPRINT_SPEED_BONUS);
	};

	/**
	 * Turns `model`'s body towards `point`, building the constraint the first time and re-aiming it after.
	 *
	 * **`ThrowBehavior.aimAt`'s construction, copied rather than shared.** A real module for it would be the
	 * right answer the day a third behaviour needs one; two is not that day, and the pair's own docs already
	 * describe the same three numbers. What is copied is the *mechanism*, and the mechanism is the point:
	 * the humanoid's own rotation is switched off and handed back afterwards, because a standing humanoid
	 * steers its own facing and would fight the constraint for the body.
	 *
	 * **An `AlignOrientation` rather than a per-turn `CFrame` write, deliberately.** A constraint turns the
	 * body over *time* — that is what makes a rig's head come round like a person's rather than snap — and a
	 * `CFrame` written per turn would also fight the walk's own replication of the root.
	 *
	 * **Flat, so the turn is a yaw and never pitches the rig into the floor.** A point directly overhead has
	 * no heading to turn to, and the guard leaves the last good aim standing rather than turning the rig to
	 * face nothing.
	 */
	const lookAt = (model: Model, root: BasePart, walk: Walk, point: Vector3): void => {
		if (walk.lookOrientation === undefined || walk.lookAttachment === undefined) {
			const attachment = new Instance("Attachment");
			attachment.Name = LOOK_ATTACHMENT_NAME;
			attachment.Parent = root;

			const balance = new Instance("AlignOrientation");
			balance.Name = LOOK_CONSTRAINT_NAME;
			balance.Attachment0 = attachment;
			balance.Mode = Enum.OrientationAlignmentMode.OneAttachment;
			balance.MaxTorque = LOOK_MAX_TORQUE;
			balance.Responsiveness = LOOK_RESPONSIVENESS;
			balance.RigidityEnabled = false;
			balance.Parent = root;

			const humanoid = model.FindFirstChildWhichIsA("Humanoid");
			walk.lookAutoRotate = humanoid?.AutoRotate ?? true;
			if (humanoid) humanoid.AutoRotate = false;

			walk.lookAttachment = attachment;
			walk.lookOrientation = balance;
		}

		const flat = new Vector3(point.X - root.Position.X, 0, point.Z - root.Position.Z);
		if (flat.Magnitude < LOOK_FLAT_EPSILON) return;

		walk.lookOrientation.CFrame = CFrame.lookAt(root.Position, root.Position.add(flat.Unit));
	};

	/**
	 * Ends a look: the constraint and its attachment are destroyed, and the humanoid gets its own rotation
	 * back.
	 *
	 * **The cleanup is load-bearing, and it is the half of this route that has no natural end.** The look is
	 * entered and left by this behaviour's own turns, so a tag taken off between two of them would leave the
	 * body's facing held by an `AlignOrientation` for the rest of the session — see
	 * {@link LOOK_WATCHDOG_MARGIN_SECONDS}, which is the timer that outlives the turns. Every ordinary route
	 * out calls this first, so it is safe to call whenever a walk ends, look or no look.
	 */
	const clearLook = (model: Model, walk: Walk): void => {
		walk.lookToken = undefined;

		const orientation = walk.lookOrientation;
		const attachment = walk.lookAttachment;

		if (orientation === undefined && attachment === undefined) return;

		if (orientation !== undefined) orientation.Destroy();
		if (attachment !== undefined) attachment.Destroy();

		const humanoid = model.FindFirstChildWhichIsA("Humanoid");
		if (humanoid !== undefined && walk.lookAutoRotate !== undefined) {
			humanoid.AutoRotate = walk.lookAutoRotate;
		}

		walk.lookOrientation = undefined;
		walk.lookAttachment = undefined;
		walk.lookAutoRotate = undefined;
	};

	/**
	 * Re-arms the timer that takes a look down if this behaviour stops being ticked.
	 *
	 * **The belt to the dwell's braces.** Each stage of the route arms this for its own dwell plus a margin,
	 * so in the ordinary case the stage advances and re-arms before it can ever fire; what it exists for is
	 * the rig that never gets another turn — the tag stripped at a round boundary, the rig destroyed mid-look
	 * — and the timer is written so it can only *undo*, which is what makes it safe to fire late.
	 */
	const armLookWatchdog = (model: Model, walk: Walk): void => {
		nextToken += 1;
		const token = nextToken;
		walk.lookToken = token;

		task.delay(NPC_CONFIG.WALK_TO_PAD_LOOK_DWELL_SECONDS + LOOK_WATCHDOG_MARGIN_SECONDS, () => {
			if (walk.lookToken !== token) return;

			clearLook(model, walk);
			logInfo(`[Rig] ${model.Name}: look cancelled — the walk it was for stopped being ticked`);
		});
	};

	/**
	 * Drops everything a walk drew about itself **without moving the body** — what a *fresh* instruction
	 * does to a rig that was part-way through the last one.
	 *
	 * **This is the shape the attribute-based delay buys, and it is the whole reason the deadline is not a
	 * row in this file.** A rig whose walk is interrupted keeps its row, because nothing here is called when
	 * a tag comes off; so when the next intermission hands it a *new* deadline it is the same row that sees
	 * it. Recognising that as "a different walk" is what makes the new wait real, the new gait a new draw,
	 * and the look's constraint — which may still be on the body if the last walk was interrupted mid-turn —
	 * something this can take back off. See {@link WALK_TO_JOIN_PAD_AT_ATTRIBUTE} for why the alternative
	 * could not be reconciled.
	 *
	 * **It does not touch the tag, the side, or either destination attribute**: this is the *draws* being
	 * reset, and every instruction about where to walk is the spawner's and is still standing.
	 */
	const resetWalk = (model: Model, walk: Walk): void => {
		clearLook(model, walk);
		endRun(model, walk);

		walk.started = false;
		walk.run = false;
		walk.look = false;
		walk.stage = "approach";
		walk.stageUntil = 0;

		// **The pending instruction goes with the draws**, so the row's memory of "what I am waiting for"
		// cannot outlive the walk it belonged to. Its only caller re-writes both immediately; they are cleared
		// here so that the claim above stays true however this is reached.
		walk.deadline = undefined;
		walk.toldAt = undefined;
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
		 *
		 * **Stated through the speed service rather than by writing `Humanoid.WalkSpeed`, and that is a
		 * reversal of what this line used to do.** Both put the same number on the same body; what the
		 * service adds is the *sum*. That matters as soon as there is a second term, which there now is —
		 * the run this behaviour contributes — because a direct write and a contribution are two writers on
		 * one property: whichever wrote last would win, and `WalkSpeedService` recalculates on every change,
		 * so the direct write would lose. See `startRun` for the other half of the argument, which is about
		 * the *legs* rather than the speed.
		 *
		 * **And it is the trap §17 records, which is why a base is set here rather than only a run.** An
		 * entry is created by the *first* contribution a model is given, seeded with
		 * `CHARACTER_CONFIG.BASE_WALK_SPEED` (20) — so a rig handed only a `Sprint` would silently walk at 20
		 * whenever it was not running, a speed nothing in the game asked for. Naming the base is
		 * `SeekBehavior.prepare`'s own fix, in the same place and for the same reason. No rig wears both this
		 * tag and a seek, and both files say so.
		 *
		 * No humanoid guard any more, deliberately: `WalkSpeedService.setBaseSpeed` refuses a model with no
		 * `Humanoid` by storing nothing at all, so the check this used to make is the service's own.
		 */
		prepare(model) {
			speeds.setBaseSpeed(model, NPC_CONFIG.WALK_TO_PAD_SPEED);
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

					logWarn(
						`[NPC] ${model.Name} wears ${BEHAVIOR_WALK_TO_JOIN_PAD} but has no ` +
							`${WALK_TO_JOIN_PAD_ATTRIBUTE} — it will stand where it is`,
					);
				}

				return;
			}

			// **The wait, and it is the writer's number rather than this file's.** `LobbyRigService` draws a
			// delay per rig and writes it as an instant; this compares it against the same clock it was
			// written on. See {@link WALK_TO_JOIN_PAD_AT_ATTRIBUTE} for why the delay is an attribute rather
			// than a deadline kept in this row — the short version being that this behaviour cannot tell a new
			// walk from an interrupted one, so a row it kept would hand the second walk the first one's clock,
			// which with a ten-to-fifteen second wait is most of the lobby on every intermission after the
			// first.
			//
			// A rig waiting here is a rig standing where it spawned, and it must not be *walked* while it
			// waits — hence the return rather than a `MoveTo` to where it already is. An absent or unreadable
			// value means "go now", which is the hand-tagged rig's case.
			const deadline = model.GetAttribute(WALK_TO_JOIN_PAD_AT_ATTRIBUTE);
			const now = os.clock();
			const serverNow = Workspace.GetServerTimeNow();

			if (typeIs(deadline, "number") && serverNow < deadline) {
				// **A deadline this row has not been given before is a new instruction**, and everything the
				// last one drew goes with it — this is where a rig whose walk was interrupted gets its draws
				// made again rather than setting off the instant it is re-tagged, and where a rig interrupted
				// while it was still *waiting* starts its measurement again rather than reporting a delay
				// longer than the window it was drawn from. See `resetWalk`, which is safe when there is
				// nothing to clean; see {@link Walk.deadline} for why equality is the right test.
				if (walk.deadline !== deadline) {
					resetWalk(model, walk);

					walk.deadline = deadline;
					walk.toldAt = serverNow;
				}

				return;
			}

			// **The obstacle and the aim, read once a turn and used twice** — by the line this walk prints when
			// it sets off, and by the `MoveTo` at the bottom. Both facts are attributes the spawner wrote: the
			// point is the other side's pad *nearest the leg* (see `LobbyRigService.padInTheWay`), and the
			// radius is that pad's own measured footprint. A rig with no point is a rig tagged by hand, and it
			// walks straight exactly as it did before the corridor existed; a rig with a point and no radius is
			// one from a build before the measurement, and the constant is the fallback. See `aimAroundPad`.
			const avoidPoint = model.GetAttribute(WALK_TO_JOIN_PAD_LOOK_AT_ATTRIBUTE);
			const measuredRadius = model.GetAttribute(WALK_TO_JOIN_PAD_AVOID_RADIUS_ATTRIBUTE);
			const avoidRadius =
				typeIs(measuredRadius, "number") && measuredRadius > 0
					? measuredRadius + NPC_CONFIG.PAD_AVOID_CLEARANCE_STUDS
					: NPC_CONFIG.PAD_AVOID_RADIUS_STUDS;

			const aim = typeIs(avoidPoint, "Vector3")
				? aimAroundPad(root.Position, target, avoidPoint, avoidRadius)
				: target;

			// **The walk begins here, once, and the two draws are the whole of what makes a lobby of rigs
			// look like a room of people.** One sets the gait and one sets the route, and both are held for
			// the walk: a roll per turn would have a rig changing gear and route mid-crossing, which is a
			// stagger rather than a choice. `math.random()` with no arguments is the half-open `[0, 1)`
			// interval, which is what makes a comparison against a chance the idiom every roll in this
			// directory uses.
			if (!walk.started) {
				walk.started = true;
				walk.run = math.random() < NPC_CONFIG.WALK_TO_PAD_RUN_CHANCE;
				walk.look = math.random() < NPC_CONFIG.WALK_TO_PAD_LOOK_CHANCE;
				walk.stage = "approach";
				walk.stageUntil = 0;

				// **The walk speed is stated here as well as in `prepare`, and the second statement is the one
				// that guarantees it.** `prepare` runs once per *loop*, and a rig's second walk — the one
				// `LobbyRigService.sendRigsToTheirPads` issues at a round end — is the same model and the same
				// loop, so `prepare` does not run for it: the tag comes off on arrival and goes back on at the
				// next boundary, and `NpcService` has already marked it prepared. Everything else this walk
				// needs it reads per turn, which is why only this one needed saying twice.
				//
				// **What it costs to leave out is the exact fault `prepare`'s doc is about**, arriving by the
				// other door: a rig whose speed sum has ended up at nothing is told to walk, agrees, and does
				// not move — indistinguishable in the output from a rig that has arrived. Writing the base is
				// idempotent, so a rig that is about to run has it overwritten with the same number and
				// `startRun` adds its contribution on top as it always did.
				speeds.setBaseSpeed(model, NPC_CONFIG.WALK_TO_PAD_SPEED);

				// **The one line this walk gets, on the edge and never per tick** — the shape every per-rig
				// line in §17 has, and for its reason: a line per tick is unreadable, and a line per nothing
				// leaves a stalled rig indistinguishable from a working one. It names the three things that
				// differ between two rigs in one lobby — how long it waited, how it moves, and whether it
				// will read the signs on the way — so a log read against a seat says which body is doing
				// which. The wait is *measured* rather than the figure the spawner drew: this file never sees
				// that number, and the gap between the deadline and the first turn that saw it is the same
				// quantity, one tick short at worst.
				//
				// **And a fourth thing, which is the only one that can be checked from the log**: whether the
				// straight line the rig was about to walk crosses the other side's pad. A corridor that is
				// not being used and one that is being used for nothing look identical in a screenshot, and
				// "does this rig's route bend?" is the question a reader of a lobby actually has.
				const waited = walk.toldAt === undefined ? 0 : serverNow - walk.toldAt;
				walk.toldAt = undefined;
				// **The wait is over, so the row carries no pending instruction** — and clearing this is what
				// makes a deadline written *later* read as a new one rather than as the one already served.
				walk.deadline = undefined;

				const routed = new Vector3(aim.X - target.X, 0, aim.Z - target.Z).Magnitude > LOOK_FLAT_EPSILON;

				logInfo(
					`[Rig] ${model.Name}: pad walk — waited ${string.format("%.1f", waited)}s, ` +
						`${walk.run ? "running" : "walking"}, ` +
						`${walk.look ? "looking around on the way" : "straight to the pad"}, ` +
						`${routed ? `routed around the other sign (${string.format("%.1f", avoidRadius)} studs)` : "clear of the other sign"}`,
				);
			}

			// **The run is re-armed on every turn of the walk**, including the turns the look-around route
			// spends standing still — see `startRun`, whose watchdog is sized against a rig that has stopped
			// being ticked, and which would take a dwell for exactly that if it were armed only at the start.
			if (walk.run) startRun(model, walk);

			// **Flat, and it is the arrival test rather than the walk.** A pad is a place on the floor,
			// so the question is "am I over it" rather than "am I at its height" — a rig standing on the
			// pad is a dozen studs below the point the walk was handed, which sits at the sign's own centre,
			// and a three-dimensional distance would have a rig walking at a pad it is already standing on
			// for ever.
			//
			// **And the point is drawn somewhere *on* the pad rather than at its centre**, so this radius is
			// now also what says how exactly a rig comes to rest: each rig stops within it of its own draw,
			// which is what lets four of them stand side by side on one sign instead of in a stack on one
			// coordinate. See `LobbyRigService.padArrivalPoint`, whose inset is this same radius precisely so
			// that a point near the pad's edge cannot have a rig settle beside the sign rather than on it.
			const offset = new Vector3(target.X - root.Position.X, 0, target.Z - root.Position.Z);

			if (offset.Magnitude <= NPC_CONFIG.WALK_TO_PAD_ARRIVAL_STUDS) {
				// **Everything the walk put on the body comes off here, on the one turn that ends it.** A run
				// is a contribution and a look is a constraint plus a humanoid rotation that was switched
				// off, and all of them outlive a behaviour that has stopped being run — so every route out of
				// this behaviour has to take them with it. This is the ordinary one, `onDied` is the second,
				// and the two watchdogs are the third, for the rig that gets neither.
				clearLook(model, walk);
				endRun(model, walk);

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
				const wanted = model.GetAttribute(WALK_TO_JOIN_PAD_SIDE_ATTRIBUTE);

				if (wanted === TEAM_A || wanted === TEAM_B) {
					// **The pad it walked to is a preference, and the side it takes is the one with room.**
					// Four bodies is a side, so a fifth rig arriving on the same sign is moved to the other
					// one rather than joining a side the round would then overfill. See `sideWithRoom`, which
					// is where the count lives — and note what it does *not* do: the rig stays where it
					// arrived, and the round's own teleport puts it on its new side's arena spawn at the
					// whistle. It is the *side* that is balanced here, not the route.
					//
					// **`model` is passed so the rig does not count itself**, and that argument is the whole
					// of the 2026-10-17 fault: a rig that plays keeps its `Team` between rounds, so it arrives
					// already holding one of the four seats it is being balanced against and its own side
					// reads full every time. See `sideWithRoom` for the log that found it.
					const side = sideWithRoom(wanted, model);

					model.SetAttribute(TEAM_ATTRIBUTE, side);

					if (side !== wanted) {
						logInfo(`[Rig] ${model.Name}: side ${wanted} was full — took ${side} instead`);
					}
				} else if (!walk.reported) {
					walk.reported = true;

					logWarn(
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

			// **The look-around route's two dwells, and this is a stage machine rather than a pause.** A rig
			// on the route stops short, turns to the *other* side's pad, turns back to its own, and then
			// carries on — so each stage is entered by a turn and left by a timer, and the rig is held still
			// in between by re-issuing the stop. Re-issued rather than issued once, for the reason the
			// approach re-issues its own walk: a body that is shoved, or one the engine has decided cannot
			// make progress, drops a movement it is not told about again.
			//
			// **`now` and the stage deadline are both local clock readings, and the mix is deliberate.** A
			// dwell is a pause on this machine and nothing outside it has an opinion about when it ends,
			// where the *start delay* is an instant a spawner wrote for a rig to compare against a shared
			// clock — which is why one is `os.clock()` and the other is `Workspace:GetServerTimeNow()`.
			if (walk.stage !== "approach") {
				humanoid.MoveTo(root.Position);

				if (now < walk.stageUntil) return;

				if (walk.stage === "look-away") {
					// The second beat: back to its own pad, which is the point it is about to walk to.
					lookAt(model, root, walk, target);
					walk.stage = "look-back";
					walk.stageUntil = now + NPC_CONFIG.WALK_TO_PAD_LOOK_DWELL_SECONDS;
					armLookWatchdog(model, walk);

					logInfo(`[Rig] ${model.Name}: looking back at its own pad`);

					return;
				}

				// **The route is over, and the look comes off the body here rather than at arrival.** The rig
				// is about to walk again, and a body still being steered by an `AlignOrientation` would not
				// turn to face where it is going — the constraint outranks the humanoid's own rotation, which
				// is the whole of why `AutoRotate` was switched off.
				clearLook(model, walk);
				walk.look = false;
				walk.stage = "approach";

				logInfo(`[Rig] ${model.Name}: look over — carrying on to the pad`);
			}

			// **The stop short, taken once per walk.** `look` is the "still to do" flag rather than a
			// description of the route, and that is what stops a rig re-entering this: the distance check is
			// true for the whole of the last thirty studs of the approach, so a flag that stayed set would be
			// a rig stopping every half-second for the rest of its walk.
			if (
				walk.look &&
				walk.stage === "approach" &&
				offset.Magnitude <= NPC_CONFIG.WALK_TO_PAD_LOOK_STOP_STUDS
			) {
				const lookAtPoint = model.GetAttribute(WALK_TO_JOIN_PAD_LOOK_AT_ATTRIBUTE);

				if (typeIs(lookAtPoint, "Vector3")) {
					humanoid.MoveTo(root.Position);
					lookAt(model, root, walk, lookAtPoint);

					walk.stage = "look-away";
					walk.stageUntil = now + NPC_CONFIG.WALK_TO_PAD_LOOK_DWELL_SECONDS;
					armLookWatchdog(model, walk);

					logInfo(`[Rig] ${model.Name}: stopped short and turned to the other side`);

					return;
				}

				// **No point to look at means a straight walk, and the route is dropped rather than walked
				// blind.** The route is drawn by this behaviour rather than painted, so a rig tagged by hand
				// has one and no look-at — a body told to turn and face nowhere, which is worse than the
				// straight line it was avoiding. Said once, for the destination warning's reason.
				walk.look = false;

				if (!walk.reported) {
					walk.reported = true;

					logWarn(
						`[NPC] ${model.Name} has no ${WALK_TO_JOIN_PAD_LOOK_AT_ATTRIBUTE} — ` +
							`its look-around route is a straight walk`,
					);
				}
			}

			// **The aim, decided above and reused here.** It is the destination unless the leg to it would cut
			// across the other side's pad, in which case it is a point beside that pad — the corridor. The
			// distance test above is against the *destination*, so a rig bending around a sign still arrives on
			// the arrival threshold rather than on some larger one.
			humanoid.MoveTo(aim);
		},

		/**
		 * The rig's row goes when the rig does — **and so does everything the walk had put on the body.**
		 *
		 * A row keyed by a model is a reference *to* that model, so leaving it behind would keep a
		 * corpse alive for as long as the server runs. Nothing is carried across: a replacement is a
		 * different model standing somewhere else with its own `WalkToJoinPad` written on it, and it
		 * makes its own row on its first turn — the same reasoning `SeekBehavior.onDied` gives.
		 *
		 * **The cleanup is more than the one line `SeekBehavior` has, because this walk can leave more on a
		 * body than a contribution.** A run is the same kind of term and comes off the same way; a look is a
		 * constraint *plus* a humanoid rotation that was switched off, and a body that kept either would be
		 * one being steered by something that no longer exists. `onDied` is the second of the three routes
		 * that take a walk down — the arrival branch is the first and the watchdogs are the third — and all
		 * three exist because a walk's footprint outlives the turns that made it.
		 */
		onDied(model) {
			const walk = walking.get(model);

			if (walk !== undefined) {
				clearLook(model, walk);
				endRun(model, walk);
			}

			walking.delete(model);
		},
	};
}
