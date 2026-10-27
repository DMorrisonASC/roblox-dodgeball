/**
 * What an NPC behavior is, and the tags that switch one on.
 *
 * A behavior is a **thin caller**: it decides *when* to act and asks a service
 * to do it. Cooldowns, windows and every other timing rule stay in the service
 * that owns them, so an NPC obeys exactly the rules a player does and the two
 * cannot drift apart.
 *
 * Behaviors compose by tagging, so a model wearing `NPC` and two behavior tags
 * runs both. Adding a mechanic is therefore one new file plus one entry in
 * `NpcService`'s registry — nothing else in the system knows what a behavior
 * does, so nothing else has to change.
 */

/**
 * Marks a model as managed by `NpcService`. The entry point, not a behavior.
 *
 * **Declared in `shared/constants.ts` and re-exported here, since the tag became something a client
 * reads too** — the rig animation renderer finds the rigs it dresses by it, and a client cannot
 * require a module that lives under `src/server`. This file stays the name every server reader already
 * imports it from, so nothing else moved. See that constant for the whole of the argument.
 */
export { NPC_TAG } from "shared/constants";

/**
 * Enables the **gated** catching behavior: the rig catches part of the time, not always.
 *
 * **A catch window is open only while a per-window decision says so**, so a rig wearing this *and*
 * `BEHAVIOR_DODGING` can actually do both — the window is closed often enough for a dodge to fire in
 * the gaps, which the always-on variant below does not leave. See `CatchBehavior`, which owns the
 * decision and its cadence. **The tag string is unchanged but the meaning is not**: a rig that used to
 * catch continuously now catches by decision, so a place-file rig still wearing `Behavior_Catching`
 * is dispatched to the new code. `TAGS.md` records the change.
 */
export const BEHAVIOR_CATCHING = "Behavior_Catching";

/**
 * Enables the **gated** throwing behavior: the rig turns to face an enemy and throws at it.
 *
 * It never issues itself a ball — it throws what `BEHAVIOR_SEEKING` and `BEHAVIOR_PICKUP` put in its
 * hand, and does nothing while the hand is empty — and it acts only during a round, at a target in
 * front of it and in range. **The tag string is unchanged but the meaning is not**; see
 * `ThrowBehavior` and `TAGS.md`.
 */
export const BEHAVIOR_THROWING = "Behavior_Throwing";

/**
 * Enables the **always-on** catching behavior: the rig holds its catch window open continuously.
 *
 * **The variant that was `BEHAVIOR_CATCHING` before the split**, preserved for a rig meant to be a
 * catcher and nothing else. Its price is the one that made the split worth making: because the window
 * never closes, a rig wearing this and `BEHAVIOR_DODGING` can never dodge. See `AlwaysCatchBehavior`.
 *
 * **Placeholder string**, chosen to match the file name. The camel-case matches the original two, so
 * the four tags read as one family; the originals' lack of an underscore is left as it was rather than
 * renamed, because a rename of a painted tag is a place-file edit no build can catch.
 */
export const BEHAVIOR_ALWAYS_CATCHING = "Behavior_AlwaysCatching";

/**
 * Enables the **always-on** throwing behavior: the rig is issued a ball and throws straight ahead on a
 * timer, whether or not anybody is there.
 *
 * **The variant that was `BEHAVIOR_THROWING` before the split**, preserved for a practice dummy. This
 * is the one that still calls `prepare`; see `AlwaysThrowBehavior`.
 *
 * **Placeholder string**, as above.
 */
export const BEHAVIOR_ALWAYS_THROWING = "Behavior_AlwaysThrowing";

/** Enables the pickup behavior. */
export const BEHAVIOR_PICKUP = "Behavior_Pickup";

/**
 * Enables the **round** seeking behavior: the rig walks to the nearest loose ball **inside its own half of
 * the court**, and to nothing else.
 *
 * **This is the first behavior that moves the rig, and that is the whole of its difference.**
 * The other four act where the rig already stands — catching and throwing at whatever arrives,
 * picking up what is already within `PICKUP_RADIUS`, respawning by placement — so none of them
 * ever had to ask whether a ball was reachable. A destination brings that question with it, and
 * the cheap ways to answer it do not work here, so the walk is bounded instead. See `SeekBehavior`,
 * which owns that decision and states what it costs.
 *
 * **Bounded to a *region* since 2026-10-13, which is the newer half and the more important one.** "Is that
 * ball reachable" is not something a behaviour can ask cheaply, so the place file is asked *where this rig
 * may fetch* instead: the box painted `SideKeepOutA` for a rig on A and `SideKeepOutB` for one on B, with a
 * ball anywhere else — the enemy's half, the practice court, the lobby — not a candidate at all. **The tags
 * on those boxes mean the opposite of what their names suggest**, and `shared/constants.ts` says so at the
 * tags themselves. A rig with no `Team` is in no half, so it fetches nothing; that is what the sibling tag
 * below exists for.
 *
 * **It fetches; it does not take.** A rig wearing this and not `BEHAVIOR_PICKUP` walks to a ball
 * and then stands next to it, which is the correct reading of two tags that each mean one thing —
 * the walk is this tag, the hand is that one. The pair is what produces a rig that collects.
 */
export const BEHAVIOR_SEEKING = "Behavior_Seeking";

/**
 * Enables the **practice** seeking behavior: the rig walks to the nearest loose ball **inside the practice
 * zone**, whatever side it has — which, for the rigs this is painted on, is no side at all.
 *
 * **A second tag rather than a second meaning for the first one, and the report is the argument.** A rig in
 * the practice area and a rig playing a round wore the same tag, ran the same code, and fetched from
 * anywhere: a practice rig would chase a ball out of the zone, and a round rig would chase one into the lobby.
 * The two rigs fetch from two different places, so there are two tags — this one reads `PRACTICE_ZONE_TAG`
 * and nothing else, and `Behavior_Seeking` reads the side boxes. Both are one call to the factory in
 * `SeekBehavior.ts`, differing only in the tag and the region.
 *
 * **The region is a property of the behaviour, not of where the rig stands.** A practice rig that wanders out
 * of the zone still fetches from inside it, and walks back in to do it: the tag says which region is *this
 * rig's world*, and standing outside it is not a state that changes that.
 *
 * **The name is the user's choice and it reads oddly, deliberately.** Every other `Always*` tag in this file
 * is the ungated twin of a gated one — AlwaysCatch, AlwaysDodge and AlwaysThrow each have a chance-gated
 * sibling — and seeking has no gate to remove, so `Behavior_AlwaysSeeking` beside `Behavior_AlwaysDodging`
 * invites a reader to expect a sibling that does not exist. `Behavior_PracticeSeeking` would say what it is.
 * Not renamed unilaterally: the string is painted in the place file, and the name is the user's.
 *
 * **Placeholder string**, matching the file name it is read from, as the four other `Always*` tags do.
 */
export const BEHAVIOR_ALWAYS_SEEKING = "Behavior_AlwaysSeeking";

/**
 * Enables the walk-to-join-pad behavior: the rig walks to the point its `WalkToJoinPad` attribute
 * names and stands there.
 *
 * **The one behaviour whose destination is handed to it rather than found by it.** Every other tag
 * here is a rig asking the world a question — where is a ball, is one coming at me, is one within
 * reach — while this one is told where to go by whoever spawned it. That is deliberate: a join pad
 * is a fact about the *lobby*, and the alternative would be a behaviour that knows which tag a pad
 * wears and which side it belongs to, which is the lobby's vocabulary leaking into the machine that
 * animates NPCs. See `WalkToJoinPadBehavior`, which is where the attribute is written down.
 *
 * **It is a behaviour rather than a spawner because a body that appears on a sign reads as a
 * mistake.** A rig *placed* on its pad would be a placeholder that pops into existence where a
 * person would have walked — and a lobby is exactly the room where somebody is watching.
 *
 * **Placeholder string**, matching the file name and the camel-case of the four tags above it.
 */
export const BEHAVIOR_WALK_TO_JOIN_PAD = "Behavior_WalkToJoinPad";

/**
 * Enables the **gated** dodging behavior: the rig dodges a fraction of the balls aimed at it.
 *
 * **The only behavior here that reacts to something outside the rig** — the rest ask a service to do
 * something the rig wants; this one asks for something a ball has made urgent. It is chance-based on
 * purpose — a rig that dodged every ball would be untouchable, in a game about hitting people with a
 * ball — and the chance is `NPC_CONFIG.DODGE_CHANCE_PER_BALL`, decided **once per ball** aimed at the
 * rig and held for as long as that ball is on course. See `DodgeBehavior` for the decision and for the
 * conditions that can refuse a dodge the rig has already committed to — and for what a refused rig does
 * *instead* of standing, which is the newer half of that file and applies this tag as much as the other
 * — and `AlwaysDodgeBehavior` for the variant with no chance in it at all. **This tag keeps the meaning
 * it always had** — the split added a sibling beside it rather than moving it.
 *
 * **It composes with the rest by not touching them.** A dodge is a two-tenths-of-a-second override
 * of where the body is going, and a rig that is also seeking walks on from wherever the dash left
 * it, because `DodgeService` restores the humanoid and the walk target was never changed. A rig that
 * is *catching* is a different matter, and it is the existing gate rather than a new one: an open
 * catch window refuses the *dash* outright, so whether the two can both happen turns on which catcher
 * the rig wears — `Behavior_AlwaysCatching` leaves no gap for a dash, while `Behavior_Catching` does.
 * **A refused dash is no longer a standstill**, which is what makes the pairing workable at all: the
 * rig walks the escape direction it had already chosen (see `DodgeBehavior`'s `runAway`), so a
 * rig that wears the always-catcher beside this tag reads as one that runs away from balls rather
 * than one that ignores them. It is still the weaker pairing — that catcher never closes its window,
 * so a dash never gets through — and that is part of why the arena rigs wear the gated pair; see
 * `LobbyRigService`'s `GAMEPLAY_BEHAVIORS`.
 */
export const BEHAVIOR_DODGING = "Behavior_Dodging";

/**
 * Enables the **always-on** dodging behavior: the rig answers yes to every ball it can move away from.
 *
 * **The variant that did not exist before the split, and the whole reason for it.** A rig meant to
 * dodge *everything* used to be expressible only by setting the chance to `1` — a shared tuning number
 * for the rigs meant to dodge *sometimes*. `DodgeService`'s own cooldown still bounds this one, so
 * "always" means **always tries**, never "dodges at will". See `AlwaysDodgeBehavior`.
 *
 * **Placeholder string**, chosen to match the file name and the two always-variants beside the catch
 * and throw tags, so the four read as one family.
 */
export const BEHAVIOR_ALWAYS_DODGING = "Behavior_AlwaysDodging";

/**
 * Enables the respawn behavior: the rig gets up again after it is killed.
 *
 * The one behavior here that is not a mechanic of the *game* — a rig has no round to
 * come back into and no `RoundService` to decide whether it should, so this is what a
 * test rig gets instead. See `RespawnBehavior`.
 */
export const BEHAVIOR_RESPAWN = "Behavior_Respawn";

/**
 * One thing an NPC can do, asked to do it on a timer.
 *
 * The behavior's own `tag` is the tag that enables it, rather than a separate
 * registry key: one tag turns on one behavior, and that holds whether the tag
 * was put there by hand in Studio's Tag Editor or by `NpcService.spawn`.
 */
/**
 * **The two instructions a behaviour may give a rig's body — and the whole of how a rig moves.**
 *
 * **A capability handed per call rather than a reference to the loop**, because a behaviour is handed a model and a
 * humanoid and never the loop: the loop is one per rig, made here, and private to this service. Handing it out would
 * let a behaviour write any field on it, and the walking flag is the one thing in this game that has cost four passes
 * to get wrong — it should be reachable only through the two calls that also command the engine.
 *
 * **The pair is deliberately not open-ended.** There is no `moveTo(point, walking)` and no `setWalking(value)`, because
 * every spelling of that shape is a call site that can set the flag without moving the body, or move the body without
 * setting the flag — and the second of those is the whole bug this interface exists to make unrepresentable. A
 * behaviour either asks the rig to walk somewhere or tells it to stand where it is.
 */
export interface NpcMoves {
	/**
	 * **Walk to `position`, and record that this body has been asked to walk.**
	 *
	 * A wrapper rather than a convention, so that "issued a `MoveTo`" and "published as walking" cannot come apart.
	 * Safe to call on every turn of a walk: re-issuing the same point is the same request, and the attribute is only
	 * written when the flag changes.
	 */
	walkTo(position: Vector3): void;

	/**
	 * **Stop where the body is, and record that nobody is asking it to walk.**
	 *
	 * **The stop is a `MoveTo` at the rig's own position** — the engine's own wording for "stay here", and the idiom
	 * every behaviour already used before this pair existed. There is no separate stop call on a `Humanoid`.
	 *
	 * **Re-issued wherever a behaviour wants the body held still rather than once at the end of a walk**, which is
	 * the one piece of the old movement code that survives: a body that is shoved, or one the engine has decided
	 * cannot make progress, drops a request it is not told about again.
	 */
	standAt(): void;
}

export interface NpcBehavior {
	/** The tag that enables this behavior on a model. */
	readonly tag: string;

	/**
	 * How often `tick` wants to be called, in seconds.
	 *
	 * A *request*, not a promise. `NpcService` runs one loop per NPC at the
	 * fastest interval any behavior asked for, and each behavior is then gated on
	 * its own interval — so this is honoured per behavior even though the loop
	 * that drives them is shared.
	 */
	readonly tickInterval: number;

	/**
	 * Do the thing, if it can be done at all.
	 *
	 * Declared as a **method** rather than a function property, which means an
	 * implementation has to be written as a method too: an object literal using
	 * `tick: () => ...` is rejected with "Attempted to assign non-method where
	 * method was expected", and `rbxtsc` is the only thing that reports it.
	 *
	 * **`moves` is how a behaviour makes a rig walk, and the only way.** It carries `walkTo` and `standAt`, which
	 * set the published walking fact and issue the `MoveTo` in one call — see {@link NpcMoves} for why the pair is
	 * that narrow. A behaviour that does not move a rig (`CatchBehavior`, `ThrowBehavior`) simply does not use the
	 * parameter, and a rig nobody asks to move animates standing.
	 */
	tick(model: Model, humanoid: Humanoid, moves: NpcMoves): void;

	/**
	 * Optional: collect whatever this behavior needs before it can run at all.
	 *
	 * Called once per behavior, the first time this model is seen wearing its tag
	 * and **before** that behavior's first tick. This is where a behavior that needs
	 * something in hand asks for it — `ThrowBehavior` asks `BallService` for a ball
	 * here — which is what keeps `NpcService` from having to know that throwing
	 * wants a ball, or that balls exist.
	 *
	 * It also keeps the *rig* free of the answer: a second throwing mechanic writes
	 * the same three lines in its own file, and neither `NpcService` nor `spawn`
	 * changes. A behavior that needs nothing simply does not write this, which is
	 * why it is optional.
	 *
	 * A method for the same reason `tick` is.
	 */
	prepare?(model: Model): void;

	/**
	 * Optional: this model's humanoid has died.
	 *
	 * The one event a behavior cannot see for itself. A behavior is only ever run
	 * while its NPC is alive — the interval it is asked on stops when the health
	 * does — so a behavior that has something to do *about* a death has to be told
	 * about it from outside.
	 *
	 * Every behavior the model still wears is told, not only the one that has a use
	 * for it: a death is a fact about the model, and what to make of it is the
	 * hook's business.
	 *
	 * Called only when the health ran out. An NPC that stopped for any other reason
	 * — its tag was taken off, or it left the world — is being switched off rather
	 * than interrupted, so there is nothing here for a *death* to answer.
	 * **What that reading was wrong about is at {@link onStopped}**, which is where
	 * a behaviour that is switched off *with something still on the body* gets to
	 * undo it: a rig stripped of its throwing tag mid-aim kept an
	 * `AlignOrientation` and a switched-off `AutoRotate`, and walked to its join
	 * pad backwards for the rest of the intermission.
	 *
	 * The loop that ran the behaviors has already finished by the time this is
	 * called, so a behavior that brings the model back has to see that a *new* loop
	 * starts. See `RespawnBehavior`, which does it by putting the model's tags back
	 * on a new rig — the same arrival `NpcService` already watches for.
	 *
	 * A method for the same reason `tick` is.
	 */
	onDied?(model: Model): void;

	/**
	 * Optional: this behaviour has just stopped being asked for turns **because its tag was taken off a
	 * model that is still alive and going somewhere else.**
	 *
	 * **`onDied` cannot cover this, and the bug that proved it is worth naming.** A behaviour runs only
	 * while its tag is on the model, and the tags are stripped from outside at every round boundary —
	 * `LobbyRigService.setGameplayBehaviors` takes six of them off at once — so a behaviour that leaves
	 * something on the body is never called again and never gets to undo it. The report from 2026-10-18:
	 * **rigs walking *backwards* to their join pads in the intermission**, moving toward a pad while a stale
	 * `AlignOrientation` (and the switched-off `AutoRotate` that goes with it) held them facing whatever they
	 * were aiming at when the round ended. It was not every rig — only the ones that had a target in sight at
	 * that instant, which is why it read as "sometimes".
	 *
	 * **Called once per stop**, on the first turn that sees the tag gone, and **the tag going back on later
	 * prepares nothing again**: `prepare` has already run for this behaviour on this model and the behaviour
	 * resumes as it was. So anything a behaviour attached to the body comes off here, and anything it
	 * published as an attribute is cleared here, because a stopped behaviour has no next turn to notice with
	 * — waiting for a timer is the fallback for a stop nobody saw, not the answer for a stop this is told
	 * about.
	 *
	 * **Silent, and that is the contract.** The reason a behaviour stopped is the *spawner's* business
	 * (`LobbyRigService` prints which tags it wrote and why), so a second line from the behaviour would say
	 * the same thing in a different vocabulary. The exception is a line about something the spawner cannot
	 * see — a windup that was never thrown, say — which is why `ThrowBehavior` prints nothing here and lets
	 * the round-boundary line stand as the explanation.
	 *
	 * A method for the same reason `tick` is.
	 */
	onStopped?(model: Model): void;

	/**
	 * Optional: the model has been **placed** — moved by something that owns where rigs stand.
	 *
	 * The sibling of `onDied`, and told from outside for the same reason: what it reports is a write to
	 * the rig's own `CFrame` by another service, which is not a thing a behavior can observe. A behavior
	 * with a real `tickInterval` could notice it had been moved, because it is the only thing that moves
	 * itself; the one behavior that cares asks for no turns at all and would never look.
	 *
	 * **Who calls it, and why the list is short.** Every service that puts a rig at a post *it* chose:
	 * `RoundService.teleportTeamsToArena` at the whistle, `LobbyRigService.moveWalkersToArena` for a rig
	 * still walking when a round starts, and `RoundService.returnRigsToLobby` when one ends. Nothing else
	 * does, and the omission is the rule: **a rig that walked somewhere has not been placed there.** The
	 * lobby's own walk to a join pad is the case that proves it — the rig crossed that ground on its own
	 * feet, so it keeps the post it was spawned with, which is a few studs away in the same room.
	 *
	 * **Told, not due.** It arrives whenever something moves the rig, which can be mid-life or between
	 * rounds. A rig placed before its first turn is not a case this has to cover: `prepare` reads where it
	 * stands when it is first seen, which is the same answer.
	 *
	 * A method for the same reason `tick` is.
	 */
	onPlaced?(model: Model): void;
}
