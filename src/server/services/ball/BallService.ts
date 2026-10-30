import { Service, OnStart } from "@flamework/core";
import { CollectionService, Players, ReplicatedStorage, RunService, Workspace } from "@rbxts/services";
import {
	ARMED_ABILITY_ATTRIBUTE,
	BALL_ABILITY_ATTRIBUTE,
	BALL_BARRIER_TAG,
	BALL_DESPAWN_ON_LAND_ATTRIBUTE,
	BALL_SIZE,
	BALL_THROWER_SIDE_ATTRIBUTE,
	CATCH_ANIMATION_ATTRIBUTE,
	CatchCause,
	DUCKING_ATTRIBUTE,
	PICKUP_COUNT_ATTRIBUTE,
	PICKUP_LOCKED_UNTIL,
	PRACTICE_THROW_TAG,
	TEAM_ATTRIBUTE,
	THROWN_FROM_BAY_ATTRIBUTE,
	THROWER_TOKEN,
	THROW_ANIMATION_ATTRIBUTE,
} from "shared/constants";
import { NPC_TAG } from "../../npc/Behavior";
import { insideAnyBay } from "../../npc/practiceBay";
import { NPC_CONFIG } from "shared/config/npc.config";
import { playSpawnPoof } from "../../vfx/spawnPoof";
import { BALL_CONFIG } from "shared/config/ball.config";
import { throwAnimationWindowSeconds } from "shared/animation";
import { CATCH_CONFIG } from "shared/config/catch.config";
import { DEBUG_CONFIG } from "shared/config/debug.config";
import { SOUND_CONFIG } from "shared/config/sound.config";
import { abilityOn, isBallAbility, pendingAbilityOn, AbilityKind } from "shared/ability";
import { CollisionIgnore } from "shared/CollisionIgnore";
import { findTemplate } from "shared/find";
import { resolveDodgeable } from "shared/dodge";
import { REMOTES } from "shared/remotes";
import { taggedPartsInWorkspace } from "shared/taggedParts";
import { events } from "shared/networking";
import {
	describeMuzzle,
	getThrowMuzzle,
	planAimedThrow,
	planChargedThrow,
	ThrowRequest,
} from "shared/throw";
import { LaunchPlan, leftAxis } from "shared/Trajectory";
import { DEBUG_LOGGING, logDebug, logInfo, logWarn } from "shared/logger";
import { hasSide } from "shared/roundMembership";
import { scheduleBallExpiry } from "./ballExpiry";
import { BallTrail } from "./BallTrail";
import { emitSound } from "./SoundEmitter";
import { DevService } from "../../dev/DevService";
import { SuperService } from "../super/SuperService";
import { TEAM_A, TEAM_B, TeamLabel } from "../round/team";
import { roundCelebrating, roundPlaying } from "../round/roundStatus";
import { isPractising } from "../zone/practiceZoneMembership";
import { holdSeconds, noteCharging } from "../character/chargeClock";
import { EconomyService } from "../economy/EconomyService";
import { FreezeService } from "../actions/FreezeService";
import { BadgeService } from "../badges/BadgeService";
import { BallFactory } from "./BallFactory";
import { watchThrow } from "./ThrowProbe";

/**
 * TEMPORARY — **the bay-despawn half of the catch trace**, kept as its own flag so it can be turned off without
 * touching `BallComponent`'s or `CatchService`'s. Set to `false` once the log has been read.
 */
const TRACE_BAY_DESPAWN = true;

/**
 * **The throw and catch clips are no longer played here, and this note is what stands in for the three
 * functions that did.**
 *
 * This service used to load a track for a player's throw and a player's catch (`throwAnimationId`,
 * `catchAnimationId`, `playActionAnimation`), on the argument that a player's body is animated on that
 * player's own client and a server-started track was therefore what made the other players see it. The
 * argument was sound and the arrangement was still wrong: the *rigs* were drawn from a published mark by
 * every client, so the game had two ways of playing one clip — and a state added for one body did nothing
 * for the other, which is the split this was all for.
 *
 * **What replaced it is one renderer for both bodies.** The mark written below is the whole of this
 * service's part, and `client/controllers/character/BodyAnimator.ts` plays the clip from it — for a rig on
 * every client, for a player's own body on the client that owns it. The clips themselves are
 * `BODY_ANIMATION`'s rows, so both bodies wear the same asset, and the fact that a client-started track on
 * a player's own character replicates is what makes a throw seen by everybody rather than by its thrower.
 */

/**
 * How far a client's claimed launch point may sit from the thrower's hand as the
 * server sees it before that claim is thrown away, in studs.
 *
 * Normally the claim is good to well under a stud — it is the difference between
 * two copies of the same character, not a disagreement about the game. This is
 * the bound for "that is not a stale character, that is a client inventing a
 * launch point".
 */
const MUZZLE_TOLERANCE = 10;

/**
 * Where a held ball sits relative to the hand.
 *
 * Lived in `BallFactory` for one revision, and came back with the line that uses it: putting a ball
 * at the grip is part of *holding* a ball, and holding is this file's — see `attachToHand` for why
 * that is not merely a matter of taste.
 */
const GRIP_OFFSET = new CFrame();

/** Name of the weld that holds a ball in a hand, so it can be found again. */
const GRIP_NAME = "DodgeballGrip";

/**
 * **What the constraint that pulls a caught ball into a hand is called, and what its attachment is called.**
 *
 * Named for the same reason {@link GRIP_NAME} and `CATCH_EMITTER_NAME` are: these are the only handles a leftover
 * check has, and one name per job is what makes "no pull constraints remain" a statement about pulls. Both are
 * parented to the **ball**, so a ball's destruction takes them with it — which is the property that makes the whole
 * mechanism safe, and the reason the entry in `pulling` is only ever a bookkeeping concern rather than a lifetime one.
 */
const PULL_ALIGN_NAME = "DodgeballPull";
const PULL_ATTACHMENT_NAME = "DodgeballPullAt";

/**
 * **One ball on its way into a hand** — the record {@link BallService.pumping} keeps while the constraint is alive.
 *
 * **`kind` rather than a callback**, because the two routes differ only in what they say *after* the weld: a catch
 * prints, plays a sound and marks the animation, and a pickup prints and moves a counter. A stored closure would be
 * the same information with a lifetime of its own to get wrong.
 */
/**
 * **One ball's journey into a hand**, from the frame the catch is decided to the frame it is welded.
 *
 * The fields are exactly the two things a pull has to be able to finish or abandon itself with: the constraint and its
 * attachment, so they can be *destroyed* rather than orphaned, and the hand, so the target and the arrival test have an
 * answer every frame. `catcher` and `kind` are what the report after the weld needs — a catch prints a sound and a
 * reach, a pickup moves a counter — and `startedAt` is the timeout that keeps a ball stuck on geometry from pulling
 * forever. See {@link BallService.pulling} for the whole of why this exists.
 */
interface Pull {
	readonly kind: "catch" | "pickup";
	readonly catcher: Model;
	readonly hand: BasePart;
	readonly align: AlignPosition;
	readonly attachment: Attachment;
	readonly startedAt: number;
}

/**
 * The tag every ball carries.
 *
 * Must match the `tag` in `BallComponent`'s decorator, which is what turns a ball into
 * a component — and it is also how the settle check finds the balls in the world
 * without keeping a list of them. A list would have to be added to on every throw and
 * subtracted from on every catch, pickup and destroy, and one missed subtraction would
 * leave a destroyed ball in it for the session. The engine maintains this one.
 */
const BALL_TAG = "Ball";

/**
 * The tag a ball wears when **the arena's stocking** put it out, copied from
 * `BallSpawnerService.ROUND_BALL_TAG` — which is the source of truth and cannot be imported without dragging
 * the whole spawner in behind it. The same copy-not-import rule `BALL_TAG` above is under, and the same one
 * `BallFactory`, `BallPickupService` and `CollisionGroups` all keep for their own strings.
 *
 * **What it means here, and it is the second meaning the tag has had to carry.** The spawner writes it so the
 * round's sweep can say what the arena stocked; this file reads it for the opposite end of the same idea — **a
 * ball the arena stocked is not litter and does not expire.** See {@link BallService.lifetimeOf} for the report
 * that made that necessary: with the round's ball supply fixed at one per spawner part (`HANDOFF.md` §15 item
 * 137), a ten-second clock on the arena's own balls emptied the floor of a match nobody had finished.
 *
 * **It is no longer the whole of that answer, and the tag's doc in `BallSpawnerService` says the same.** The
 * second report — still "the balls are disappearing during rounds" — proved the tag was answering a narrower
 * question than the one being asked: a hand-out ball is in a round and wears nothing. So the phase decides
 * whether a ball is on a clock and this tag is only the fast path that skips the folder read for the balls that
 * were never going to expire anyway. Nothing about the tag's *first* meaning changed — the sweep still strips it
 * to say what the arena put out.
 *
 * **A practice ball never wears it** — `BallSpawnerService.spawn(point, false)` is the arm the zone uses — so a
 * practice floor keeps its own clock rules untouched.
 */
const ARENA_BALL_TAG = "RoundBall";

/**
 * What a catch sound's emitter is called.
 *
 * The counterpart to `BallComponent`'s `IMPACT_EMITTER_NAME`, and separate for the reason given
 * there: the emitter is an anonymous part in `Workspace`, so its name is the only handle a leftover
 * check has, and one name per event is what makes "no catch emitters remain" a statement about
 * catches rather than about sounds in general. `SoundEmitter.emitSound` takes the name as an argument
 * precisely so that this can be the caller's decision.
 */
const CATCH_EMITTER_NAME = "CatchEmitter";

/**
 * What a throw sound's emitter is called. See {@link CATCH_EMITTER_NAME}.
 *
 * **A second name in this one file rather than a shared one, because a leftover has to be
 * attributable.** Two events play sounds from here now — a catch and a throw — and "no emitters
 * remain" is only a useful statement if searching for a name says *which* event leaked. One name for
 * both would make it a true answer about the wrong thing, which is the whole reason the helper takes
 * the name as an argument.
 */
const THROW_EMITTER_NAME = "ThrowEmitter";

/**
 * The name of the Pierce effect template — **the whole of the contract with the place file, and the name
 * every copy of it wears on a ball.**
 *
 * **Found by name, recursively, and never by path.** `ReplicatedStorage.VFX.PierceTrail` is what this used
 * to look up, and it was wrong for the reason `HANDOFF.md` §17 gives about the body effects: the contract
 * with an authored template is *its name and nothing else* — a folder is something a person renames from
 * `VFX` to `Effects`, a wrapper `Model` is something they add or drop, and either one would silently break a
 * lookup that encoded it. {@link findTemplate} walks all of `ReplicatedStorage` instead, so
 * `ReplicatedStorage.VFX.PierceTrail`, `ReplicatedStorage.Effects.PierceTrail` and a loose
 * `ReplicatedStorage.PierceTrail` are the same template to this file.
 *
 * **One name for both jobs.** A clone keeps its template's name, so the lookup that finds the template and
 * the lookup that takes a spent effect off a ball are the same `FindFirstChild` — which is what makes "is
 * there a stray effect on this ball" a question anybody can ask of the instance tree. See
 * {@link BallService.detachPierceEffect} for the three places that ask it.
 *
 * **The effect itself is never built here.** The trail is a `BasePart` carrying an `Attachment` and a
 * `ParticleEmitter`, authored in Studio; this file clones it and welds the clone to the ball and has no
 * opinion about rate, colour or lifetime, so the effect can be retuned without a build.
 */
const PIERCE_EFFECT_NAME = "PierceTrail";

/**
 * What the weld holding the effect to the ball is called.
 *
 * Named rather than left as `WeldConstraint` for the reason the emitter names are: the effect's whole
 * arrangement is "a child of the ball, held by one weld", and a reader looking at a ball in the Explorer
 * — or a leftover check grepping for a weld that outlived its part — has no other handle on it. The
 * weld is a child of the effect part, so it cannot outlive it; the name is for the reader.
 */
const PIERCE_WELD_NAME = "PierceEffectWeld";

/**
 * The template names this file has already warned about, so a missing one is reported **once per name**
 * rather than once per throw.
 *
 * **A `Set` of names rather than a boolean, which is the clients' own pattern** — `hitVfx`, `windBurst`,
 * `chargeEffect` and `catchShockwave` each keep a `warnedTemplates` set for exactly this — and the reason it
 * is a set even with one name in it today is that "one missing template swallows the warning for the other"
 * is the failure a boolean has. A second effect added to this file gets its own line for free.
 *
 * **One shot rather than every throw**, because the fault is the same fault every time: a Pierce ball is
 * thrown about once a second in a busy round, and a warn per throw would bury every other line in the log
 * inside a minute. What that costs is named in the client copies' docs and applies here too: a warning that
 * fires once and then goes quiet is indistinguishable, from the seat, from code that never ran — which is
 * why the missing-template line is a `warn` and not a `print` behind `DEBUG_LOGGING`.
 */
const reportedMissingTemplates = new Set<string>();

/**
 * How often a loose ball is checked for having stopped, in seconds.
 *
 * Short enough that the creep below {@link BALL_CONFIG.MIN_SPEED} is not something
 * anyone sees: at that speed a ball covers a fraction of a stud between two checks, and
 * a check is a length comparison plus, at most, one short ray.
 */
const SETTLE_PERIOD = 0.1;

/**
 * How long the settle loop waits when nothing is loose, in seconds.
 *
 * The idle turn is the common one — most of a session has no ball lying on the floor —
 * so it is taken far less often than the busy one. It is one tagged-instance query and
 * a walk out again.
 */
const SETTLE_IDLE_PERIOD = 0.5;

/**
 * How far below its centre a ball is probed for ground, in studs.
 *
 * The ball's own radius reaches whatever it is resting on; the slack covers the
 * fraction of a stud an engine contact lets a settled part sit inside its surface by, so
 * a ball at rest cannot read as airborne and slip past the freeze.
 */
const GROUND_PROBE = BALL_SIZE / 2 + 0.1;

/**
 * How much room a dropped ball leaves, in studs: how far in front of whatever the drop ray
 * finds it is placed, and how far in front of the dropper it is placed when something is
 * closer than that.
 *
 * One number doing both jobs because it is one requirement seen twice — the ball has a
 * radius, so it must not be placed touching a wall *or* inside the body it came out of —
 * and it is that radius with half a stud of slack, the same shape as {@link GROUND_PROBE}
 * above. `BallService.dropReach` is the only reader.
 */
const DROP_CLEARANCE = BALL_SIZE / 2 + 0.5;

/** A ball currently welded into somebody's hand, plus its (disarmed) trail. */
interface HeldBall {
	/**
	 * A `BasePart` rather than a `Part`: a caught ball arrives as whatever the
	 * component's instance is, and it is the same object either way.
	 */
	ball: BasePart;
	/**
	 * Absent when the trail is switched off in config, because
	 * {@link BALL_CONFIG.TRAIL_ENABLED} is a *creation* switch — nothing is built rather
	 * than built and hidden. It is the same set of ribbons the ball flew with last time it
	 * was thrown: the trail belongs to the ball, not to the hold.
	 */
	trail?: BallTrail;
}

/**
 * The band a physics rate is trusted inside, in steps per second.
 *
 * `Workspace:GetRealPhysicsFPS()` is a *measurement* rather than a setting, and a measurement can be
 * wrong in ways that turn this sum into nonsense:
 *
 * - **Zero.** Before the server's first physics step, and on a server with nothing to simulate, it
 *   reports 0. That divides into an unbounded upward velocity and would launch the ball into orbit.
 * - **Throttled.** Under load the engine slows its stepping rather than losing time, so a low value
 *   is sometimes the truth about what physics is doing. That belongs in the sum — but past a point
 *   it stops meaning "stepping slowly" and starts meaning "this server is in trouble", and a throw
 *   made then wants the ordinary boost rather than a share of the panic.
 * - **Absurd.** Nothing in the engine should report above a few hundred, and a value that did would
 *   divide the boost down to nothing.
 *
 * 20 is below any rate the engine steps at in practice and above the only value that is genuinely
 * meaningless — the one that does not exist yet. 240 is the top of the range the engine's own
 * stepping methods work in.
 */
const MIN_PHYSICS_FPS = 20;
const MAX_PHYSICS_FPS = 240;

/**
 * The server's physics rate, in steps per second, inside {@link MIN_PHYSICS_FPS}–{@link
 * MAX_PHYSICS_FPS}.
 *
 * Clamped here rather than at the arithmetic so that everything asking about the rate — the boost,
 * and the log line printed beside it — reports the same number the boost was derived from. A log
 * that quoted the raw reading next to a boost computed from the clamped one would disagree with
 * itself exactly when the clamp mattered.
 */
function physicsRate(): number {
	return math.clamp(Workspace.GetRealPhysicsFPS(), MIN_PHYSICS_FPS, MAX_PHYSICS_FPS);
}

/**
 * The `BasePart` inside a cloned effect — the thing a weld can hold — or nothing.
 *
 * **Three shapes rather than one, because the template is somebody else's decision.** An effect built as a
 * single `BasePart` carrying its `Attachment` and emitter (which is what the Pierce trail is) is its own
 * part; one built as a `Model` is held at its `PrimaryPart`; and a `Model` whose author never set a
 * primary part — easy to leave unset, and invisible in Studio until something asks — falls back to its
 * first `BasePart` child. All three are the same question, "which part is this effect *at*", and the
 * fallback is why the caller does not have to reject a model-shaped template.
 *
 * **Not recursive on purpose.** A model that holds no `BasePart` directly is a folder of models or
 * something stranger, and picking a deep descendant would attach the weld to one piece of an effect whose
 * other pieces were never made to move with it.
 */
function effectPartOf(effect: Instance): BasePart | undefined {
	if (effect.IsA("BasePart")) return effect;
	if (effect.IsA("Model")) return effect.PrimaryPart ?? effect.FindFirstChildWhichIsA("BasePart");
	if (effect.IsA("Folder")) return effect.FindFirstChildWhichIsA("BasePart");

	return undefined;
}

/**
 * The velocity a throw needs added to its launch so the ball flies the arc it was solved for, in
 * studs per second.
 *
 * **Derived, not tuned.** The engine integrates a body by its current velocity and only then bends
 * it, so a step's worth of the pull is missing from the velocity a step acts on: the ball gains
 * `½·a·dt·t` of position along `a` on top of the arc it was solved for. One velocity cancels that for
 * every `a` at once — `−½·dt·a` — so this is written from the *pull* the ball is about to fly under.
 * Gravity is always part of that pull; the sideways acceleration a curve carries is the other part,
 * and it is the only arc where the answer is not straight up. See
 * `BALL_CONFIG.THROW_VERTICAL_BOOST_SCALE` for the derivation, for the fixed value it replaces, what
 * frame rate that value implied, and why the scale should stay at 1.
 *
 * **The second term is what the curve was missing, and the log said so before this was written.** The
 * pull's *gravity* half has been here since the throw stopped sagging; the curve's half — half a step
 * of `plan.acceleration`, aimed back along the bow — was never applied, because no arc but the curve
 * has a pull to apply it for. What that cost is a curve flying its solved arc plus `½·a·dt·t` of bow:
 * a fraction of a stud at the start of the flight and worst at the landing, where it put the ball
 * about `½·a·dt·flightTime` studs (0.76 on a 0.31 s throw) wide of the mark the guide drew, in the
 * direction of the bow. `ThrowProbe` showed it as a `launch error` that repeated unchanged across
 * samples, which is the shape of a *launch-state* term rather than a wrong force — a wrong
 * `VectorForce` grows between samples, and this did not.
 *
 * **Server-only, and deliberately not in `shared/throw.ts`.** That file exists so the client's aim
 * guide and the server's throw compute one answer; this reads the *local* machine's physics rate, so
 * a client calling it would derive its own number and the two would disagree — the one failure that
 * file is arranged to prevent. Nothing is published to the client and the guide does not change: it
 * draws the solve, and this is the server correcting the engine's own loss on top of it.
 *
 * **Read at every throw rather than cached**, because the rate is a measurement that moves — a
 * server can change how it steps while the game runs — and a correction derived once at boot would
 * be wrong for exactly the throws this exists to fix.
 */
function launchCorrection(acceleration: Vector3): Vector3 {
	// Half a physics step, once, because both terms are the same fraction of their own acceleration.
	const half = BALL_CONFIG.THROW_VERTICAL_BOOST_SCALE / (2 * physicsRate());

	// Up by half a step of gravity, and back along the throw's own pull by half a step of it. The
	// second term is exactly zero for `straight` and `overhead` — `plan.acceleration` is the zero
	// vector for both — so their launch is bit-for-bit what it was before this took a parameter.
	return new Vector3(0, half * BALL_CONFIG.BALL_GRAVITY, 0).sub(acceleration.mul(half));
}

/**
 * The `Workspace` attribute that overrides {@link BALL_CONFIG.THROW_LAUNCH_NUDGE} while it is set,
 * as a `Vector3` of `X = forward, Y = left, Z = up`.
 */
const NUDGE_ATTRIBUTE = "ThrowLaunchNudge";

/**
 * The launch nudge for this throw, in the throw's own frame — the live attribute if one is set, the
 * config's numbers otherwise.
 *
 * **Why there are two sources at all, and it is not for tidiness: a config cannot be edited into a
 * running game.** `BALL_CONFIG` is a module, and Roblox runs a module once and hands the same table
 * to every later `require` — so changing the config mid-session changes the file and the compiled
 * output and *not* the table the running server already holds. A value that has to be found by
 * watching what a throw does therefore costs a play-session restart per attempt, which is the wrong
 * shape for a dial. An attribute is read here, at the throw, so writing one moves the very next ball
 * with no restart: `Workspace` in the Explorer, or `workspace:SetAttribute("ThrowLaunchNudge",
 * Vector3.new(0, 5, 0))` from the command bar.
 *
 * **The components are the config's own three numbers in the config's own order**, `X` forward,
 * `Y` left, `Z` up, so a value found live can be written into the config unchanged.
 *
 * **The attribute is a place to find a number, not a place to keep one.** It is invisible to the
 * repository, to a code review and to the next person who runs the game — so a value that matters
 * belongs in the config and the attribute deleted. The log says which of the two a throw used.
 */
function launchNudge(): { forward: number; left: number; up: number; live: boolean } {
	const live = Workspace.GetAttribute(NUDGE_ATTRIBUTE);

	if (typeIs(live, "Vector3")) return { forward: live.X, left: live.Y, up: live.Z, live: true };

	const configured = BALL_CONFIG.THROW_LAUNCH_NUDGE;
	return { forward: configured.forward, left: configured.left, up: configured.up, live: false };
}

@Service()
export class BallService implements OnStart {
	private throwRemote?: RemoteEvent;

	/**
	 * What each model is holding, keyed on the **model** rather than the player.
	 *
	 * A catcher can be an NPC, and a caught ball has to end up in the same place a
	 * handed-out one does — otherwise it could not be thrown afterwards. So the map is
	 * keyed on the thing that holds the ball, whatever is behind it: a `Player` is
	 * resolved only where a question is genuinely about one — the marks, the window and
	 * the dev flags all arrive on the remote with a player attached.
	 */
	private readonly heldBalls = new Map<Model, HeldBall>();

	/**
	 * Which throw each model's mid-throw mark belongs to, so a newer throw is not cleared by an older
	 * timer.
	 *
	 * **The mark is written twice in quick succession in one real case**: a dev with `InfiniteBalls` — and
	 * anybody whose hand refills fast enough — can throw again inside
	 * {@link BALL_CONFIG.THROW_ANIMATION_SECONDS}, and two timers for one attribute means the first one to
	 * fire clears a mark the second throw still owns. The animation is then cut off after a fraction of a
	 * second, which looks exactly like the clip failing to load. A counter costs one map write per throw and
	 * makes the clear conditional on "no newer throw has happened".
	 *
	 * **It holds only live marks, so it cannot grow.** A mark that is superseded is replaced, not added to,
	 * and whichever throw is newest deletes its own entry when its timer fires — so the map is as large as
	 * the number of bodies mid-throw, which is at most a handful.
	 */
	private readonly throwMarks = new Map<Model, number>();

	/**
	 * Which catch each model's mid-catch mark belongs to, so a newer catch is not cleared by an older timer.
	 *
	 * **`throwMarks`' twin, and the case it covers is the one a catcher actually produces.** A body with its
	 * window held open (`AlwaysCatchBehavior`, or a dev with `InfiniteCatch`) can take a second ball inside
	 * {@link CATCH_CONFIG.CATCH_ANIMATION_SECONDS}, and two timers for one attribute means the first to fire
	 * clears a mark the second catch still owns — a clip cut off after a fraction of a second, which looks
	 * exactly like the clip failing to load. The counter makes the clear conditional on "no newer catch has
	 * happened", which is the whole of "a re-catch restarts the window rather than stacking one".
	 *
	 * It holds only live marks, so it cannot grow: a superseded mark is replaced rather than added to, and
	 * the newest catch deletes its own entry when its timer fires.
	 */
	private readonly catchMarks = new Map<Model, number>();

	/**
	 * **How to catch each live ball, keyed on the ball — the table the eight-stud radius searches.**
	 *
	 * **A callback per ball rather than a lookup through Flamework.** Everything a catch needs in order to be decided
	 * and resolved lives on `BallComponent` — whether the ball is armed, whether it is in a hand, which ability it
	 * carries, and how to release its tags when it is taken. A `CatchService` proximity pass therefore has to reach *the
	 * component on this ball*, and the two ways to do that are to ask Flamework for it (an instance-to-component lookup
	 * from outside, which the project does nowhere and which ties this feature to a framework API for a table it could
	 * own) or to let the component put its own closure here. This is the second, and it is the cheaper of the two in
	 * every sense: `CatchService` never learns what a component is.
	 *
	 * **Registered in `BallComponent.onStart` and forgotten in its `Destroying` hook**, both unconditionally. The map is
	 * keyed on the instance, so an entry left behind pins a destroyed ball in memory for the session — which is why the
	 * forget happens before the diagnostic early-returns in that hook rather than after them.
	 */
	private readonly catchHandlers = new Map<BasePart, (catcher: Model) => boolean>();

	/**
	 * The server clock at which each ball was first seen outside every practice bay, for the despawn grace period.
	 *
	 * **A `Map` rather than an attribute on the ball, and that is the whole of the choice.** An attribute replicates to
	 * every client, and how long a ball has been outside a bay is a fact about a rule the client does not run — the
	 * death is the server's, and a client given a number it never reads is a number being paid for in bandwidth ten
	 * times a second. Nothing here is observable; the ball vanishing is the only thing a player sees.
	 *
	 * **`os.clock` and not `Workspace:GetServerTimeNow`**, which is the one place this deliberately differs from the
	 * idea that produced the feature. `GetServerTimeNow` exists because a deadline crossing the wire needs a clock both
	 * machines share; this deadline never leaves the server, and the sweep it lives in already runs on `os.clock`. Two
	 * clocks in one function is how one of them ends up compared against the other.
	 */
	private readonly leftBayAt = new Map<BasePart, number>();

	/**
	 * **Balls currently being pulled into a hand, keyed on the ball.**
	 *
	 * **Why a ball is not welded the instant it is caught, which is the whole of this field.** `attachToHand` writes
	 * the ball's `CFrame` to the grip and welds it there, so a catch used to move the ball from wherever it was to the
	 * catcher's hand in a single frame — from the player's seat, a ball that vanished and reappeared. The pull replaces
	 * that with a short physics journey and welds on arrival; the weld is still the only way into a hand.
	 *
	 * **The decision does not wait for the journey.** Everything authoritative happens on the frame the catch is
	 * decided — the window is spent, the tags are released, the thrower dies — because those are facts about the
	 * *throw*, and a pull is a presentation of the ball. A catch that resolved when the ball physically arrived would
	 * let a drill live for another fifth of a second, and would make the outcome depend on geometry the decision had
	 * already stopped caring about.
	 *
	 * **A map rather than a set, because a pull has to be finished or abandoned and both need to know what it was
	 * for.** The entry carries the constraint and its attachment (so they can be destroyed rather than orphaned), the
	 * hand (so the target and the arrival test have an answer), the start time (the timeout) and which of the two
	 * routes — catch or pickup — owns the report that follows the weld.
	 *
	 * **Entry lifetime is exactly the constraint's**, and the one place that can go wrong is a pull whose ball or hand
	 * leaves the world: both are checked every frame by {@link pumpPulls}, which abandons rather than completing in
	 * that case. An orphaned `AlignPosition` on a re-parented ball is the classic "invisible force" bug — the ball
	 * dragged by nothing toward a hand that no longer exists.
	 */
	private readonly pulling = new Map<BasePart, Pull>();

	/**
	 * **Every ball wall in the world, which is the whole of what the per-frame check walks.**
	 *
	 * **A registry rather than a tag walk per frame, and rather than a `Heartbeat` per wall.** Both of the
	 * alternatives are worse in a way this file has already argued about once: `pumpPulls` is one loop over a map
	 * because a thread per catch is a thread with its own cancellation problem, and the same reasoning says a
	 * connection per wall is a connection per wall. The tag walk is the other extreme — `taggedPartsInWorkspace`
	 * allocates an array every call, and sixty of those a second to find the same two parts is the kind of cost that
	 * never appears in a profile until there are a hundred walls.
	 *
	 * **Kept in step by the tag's own two signals**, so a wall painted mid-session is swept on the next frame and a
	 * destroyed one costs nothing. Rebuilt with those signals rather than by walking the tag on a tick.
	 */
	private readonly ballWalls = new Set<BasePart>();

	/** The overlap query's parameters, **made once because a fresh `OverlapParams` per wall per frame is garbage**. */
	private readonly wallOverlap = new OverlapParams();

	constructor(
		private readonly factory: BallFactory,
		private readonly dev: DevService,
		private readonly abilities: SuperService,
		private readonly freezes: FreezeService,
		private readonly economy: EconomyService,
		private readonly badges: BadgeService,
	) {
		// **Switching `InfiniteBalls` on hands the dev a ball, if their hand is empty.**
		//
		// The refill at the end of a throw is not enough on its own. A dev whose hand is
		// empty has nothing to throw, so a flag that only applies *at the end of a throw*
		// can never take effect on one — and an empty hand is exactly the state a dev is
		// in when they reach for this flag, having thrown the ball they had and wanting
		// another. So the flag answers on the spot, through the same call the hand-out
		// uses. Switching it off does nothing: the ball already in the hand is theirs to
		// throw either way.
		this.dev.onFlagChanged("InfiniteBalls", (player, on) => {
			logDebug(`[Ball] ${player.Name}: InfiniteBalls ${on ? "on" : "off"}`);

			if (!on) return;

			const character = player.Character;
			if (!character || this.getHeldBall(character)) return;

			this.giveBall(character);

			logDebug(`[Ball] ${character.Name}: handed a ball by InfiniteBalls`);
		});
	}

	onStart() {
		this.throwRemote = this.createThrowRemote();
		this.throwRemote.OnServerEvent.Connect((player, heading, charge, curve, claim, aim) => {
			// **The heading: a vector, and otherwise any vector at all.** This is the one argument that
			// cannot be *wrong*, because a player may aim wherever they like and the solve answers a heading by
			// flattening it and taking its compass direction — a lexicographic "valid range" here would be a
			// second copy of that rule, in the file least able to keep it in step. What is checked is the
			// *type*, because the wire is untyped: a string or a table would reach the solve as a non-vector
			// and throw inside it. A heading with no horizontal part is not refused either — `planChargedThrow`
			// has a fallback for it, which is the same fallback the client's own preview just used.
			if (!typeIs(heading, "Vector3")) return;

			// **The charge, and this is the argument that *is* range-checked: it is the whole mechanic.** A
			// client claiming past full would be given reach the game does not publish, and one claiming `NaN`
			// would put `NaN` into a velocity and take the ball out of the world — both reachable by anybody
			// with an executor, so this is a gate rather than a formality. There is no clamp here on purpose:
			// out of range is refused, and the clamp inside `planChargedThrow` is what keeps that function
			// total for the callers the wire never sees.
			//
			// **`!(charge >= 0)` rather than `charge < 0`, and the difference is `NaN`** — it compares false
			// against every bound, so the naive pair of comparisons waves it through. The same idiom
			// `EconomyService.devSetMoney` uses on its amount, for the same reason.
			if (!typeIs(charge, "number") || !(charge >= 0) || charge > 1) {
				logWarn(`[Ball] ${player.Name}: throw refused — charge ${tostring(charge)} is not within 0..1`);
				return;
			}

			// **The bend, and anything that is not a literal `true` is the plain throw.** That is the same
			// answer a client that has never pressed the key gives, and the same shape the arc whitelist used
			// to take: a value this side cannot read has to fall back to the throw the player's own guide is
			// drawing, and `false` is what an untouched client holds. It is deliberately not a warning —
			// `false`, `nil` and a missing argument are one question rather than three, and a bent ball carries
			// no advantage worth lying about, so there is nothing here for a reader to chase.
			const bending = curve === true;

			this.throwForPlayer(
				player,
				{
					kind: "charged",
					heading,
					charge,
					curve: bending,
					// **The point the player's cursor was on, and the one argument here that needs no range
					// check.** It is turned into a *cap* on the charge the client also sent — see
					// `planChargedThrow` and `reachTo` — so every length it can ask for is bounded by a hold
					// this player was already entitled to. An untrue point therefore aims a throw they could
					// have made rather than granting reach they could not.
					//
					// **The type check is for the solve's sake rather than the game's.** A `Vector3` holding
					// `NaN` survives every comparison and would put `NaN` into a velocity, taking the ball out
					// of the world; `reachTo` is what actually refuses those, and this is the cheap gate in
					// front of it. Anything that is not a vector is the same case as a player pointing at the
					// sky, which is a state the throw already answers.
					aim: typeIs(aim, "Vector3") ? aim : undefined,
				},
				typeIs(claim, "Vector3") ? claim : undefined,
			);
		});

		// **The ability key, and the whole of its server half.** Both of the questions this handler asks
		// are this service's: where the *ball* is (it owns hands) and what this player *may* do (it holds
		// the dev flags). The service that counts the charge is told the outcome and never asked to find a
		// ball — see {@link markHeldBall} for the line between the two.
		events.Server.OnEvent("markHeldBall", (player, kind) => this.markHeldBall(player, kind));

		// **The dev's MultiBall key, and the other thing a press can mean.** It marks nothing: it buys a
		// *window* on the player, which is a fact with no ball to ride and therefore no kind to carry. See
		// {@link activateMultiBall}, which is the whole of the handler — and note that it is here rather
		// than in `SuperService` for the same split the mark handler above documents: this service owns
		// hands and dev flags, that one counts charges and never touches a ball.
		events.Server.OnEvent("multiBall", (player) => this.activateMultiBall(player));

		// **And the one key that is not a dev's.** Every player uses whatever power a mystery box gave
		// them with a single press, so this is the general way in and the two above are the shortcuts. It
		// decides nothing either — it asks the window which power it is paying for and hands the request to
		// whichever of the two handlers that names. See {@link useMysteryPower}, which is short because
		// both of its destinations already exist.
		events.Server.OnEvent("useMysteryPower", (player) => this.useMysteryPower(player));

		Players.PlayerRemoving.Connect((player) => {
			const character = player.Character;
			if (character) this.heldBalls.delete(character);
		});

		// The settle check — the only thing in the game that watches a ball *after* it has
		// landed. Started here rather than on the first throw because it has no starting
		// condition: it looks at the world rather than at this service's lists, so a ball
		// left on the floor in Studio is covered by the same loop as a thrown one.
		task.spawn(() => this.settleLooseBalls());

		// **The pull loop, started with the settle loop and for its reason.** It has no starting condition either —
		// `pumpPulls` looks at its own map rather than at anything in the world, so an empty map is the whole of the
		// idle cost and a pull that began on any frame is picked up on the next. See `pulling`.
		RunService.Heartbeat.Connect(() => this.pumpPulls());

		// **And the ball walls, on the same clock and for the same reason.** One loop over a registry rather than a
		// connection per wall; see {@link ballWalls}.
		this.watchBallWalls();
		RunService.Heartbeat.Connect(() => this.pumpBallWalls());
	}

	/**
	 * **Keeps {@link ballWalls} in step with the tag, so the per-frame check walks a small set rather than the world.**
	 *
	 * **Three sources, and each covers a way a wall can arrive or leave.** The boot walk catches a wall painted into
	 * the place file — it is already tagged by the time this service starts, and the added-signal for it fired before
	 * anything was listening. The added-signal catches a wall tagged while the server runs, which is the case a
	 * person testing this feature produces: tag a part in Studio's Tag Editor and walk into it. The removed-signal,
	 * and a re-parent out of `Workspace`, catch the wall going away again.
	 *
	 * **`IsDescendantOf(Workspace)`, so a wall parked in `ServerStorage` is not a wall** — the same rule
	 * `taggedPartsInWorkspace` applies to every other tag in this project, and the reason a template cannot be
	 * swept.
	 *
	 * **Nothing here reads the world per frame.** The `removed` signal is not the only cleanup: `pumpBallWalls`
	 * skips a wall that has left the world and forgets it, so a wall destroyed without the signal cannot make the
	 * loop query a dead part for ever.
	 */
	private watchBallWalls(): void {
		for (const part of taggedPartsInWorkspace(BALL_BARRIER_TAG)) this.ballWalls.add(part);

		CollectionService.GetInstanceAddedSignal(BALL_BARRIER_TAG).Connect((instance) => {
			if (instance.IsA("BasePart") && instance.IsDescendantOf(Workspace)) this.ballWalls.add(instance);
		});

		CollectionService.GetInstanceRemovedSignal(BALL_BARRIER_TAG).Connect((instance) => {
			if (instance.IsA("BasePart")) this.ballWalls.delete(instance);
		});
	}

	/**
	 * **The held-ball half of a ball wall: a body inside one loses the ball in its hand, with the poof.**
	 *
	 * ## Why there are two mechanisms for one wall, and what breaks if either replaces the other
	 *
	 * **A loose ball and a held ball are not the same kind of thing, so they cannot be caught the same way.**
	 *
	 * - **A loose ball is a physics body**, and the wall collides with it: `CollisionGroups` leaves `BallWall`
	 *   against `Ball` collidable, so the engine bounces it. **That is the whole of the loose-ball rule and there is
	 *   no code for it**, which is why this method does not look for loose balls at all — a spatial check here would
	 *   be a second answer to a question the solver has already answered, and the day the two disagreed the ball
	 *   would either bounce twice or vanish on a bounce that should have been a bounce.
	 * - **A held ball is not a physics body at all.** It is welded into a hand, `CanCollide = false`, and its pair
	 *   with the wall is non-collidable by group — so no contact happens, no event fires, and nothing the engine does
	 *   could notice it. Only geometry can: *is this ball inside that box.*
	 *
	 * **The reverse would break both.** Make the loose ball a query and it stops bouncing on the frame the query
	 * misses — a ball crossing a thin wall in one frame is exactly what a query cannot see and a solver cannot miss.
	 * Make the held ball a physics matter and it needs `CanCollide = true` on a welded ball, which is the held-ball
	 * shove bug `attachToHand` exists to prevent.
	 *
	 * **`Touched` was tried first and is withdrawn, and the reason is worth keeping written down.** The first version
	 * connected each wall's `Touched` and read the body off the contact, on the argument that a collision group
	 * suppresses *collision* rather than contact. Whatever the engine's truth is there, **a wall deliberately made
	 * non-collidable with every body is the worst possible place to build a rule on a contact event**, and the report
	 * — *"nothing happens when I tag a part"* — is what a contact that never fires looks like. Geometry does not
	 * depend on that question having an answer.
	 *
	 * ## The query
	 *
	 * **One `GetPartBoundsInBox` per wall per frame, against a registry that is normally empty.** With no
	 * `BALL_BARRIER_TAG` part in the world the whole loop is `size === 0` and returns, so a place file that never
	 * paints one pays nothing for the feature existing. `OverlapParams` is built once on the instance rather than per
	 * call, because one table per wall per frame is garbage for a result that is the same shape every time.
	 *
	 * **A `Humanoid` test rather than an `isHeld`-on-every-hit test, and the order matters.** The box returns every
	 * part of every body standing in it — a dozen per character — so the cheap question is asked first: resolve the
	 * ancestor `Model`, drop anything without a `Humanoid`, and only then ask whether this service knows it holds a
	 * ball. A body with no ball is the ordinary case and costs one map miss.
	 *
	 * **`heldBalls.has` rather than `isHeld`, which is the decision the prompt asked about.** `isHeld` takes a
	 * **ball** and walks the whole map looking for it; this has a *character* and wants the entry — so the keyed
	 * lookup is both the right question and the cheaper one. `isHeld` stays as it is for `cleanupRoundBalls`, which
	 * genuinely has a ball.
	 *
	 * ## The destruction
	 *
	 * **The poof is anchored at the ball**, through `playSpawnPoof`'s position argument: the ball vanishing is the
	 * event, and that function's first parameter is a `Model | undefined` whose anchor it finds by walking for a
	 * torso — a ball is a `BasePart` and has neither, so `undefined` plus the ball's own `CFrame` is the only shape
	 * that puts the burst where the thing disappeared.
	 *
	 * **`removeBall` is the whole of the removal**: the map entry, the ball and everything parented to it — the grip
	 * weld, the trail, any `CollisionIgnore` — and the holder's armed power. A second teardown here would be a second
	 * answer to "what does a hand losing its ball mean".
	 *
	 * **Destroyed rather than dropped**, deliberately. A dropped ball would land on the far side of the wall, be
	 * picked up, and be carried straight back in — and the wall would become a way to hand a ball to somebody
	 * standing behind it.
	 *
	 * ## What this deliberately cannot do
	 *
	 * **A ball can squeak past a corner or a gap**, because the wall is only where somebody painted it. That is a
	 * geometry fact rather than a fault in this loop: a wall with a hole in it lets balls through the hole. The fix
	 * is a wider wall, never a bigger box here — a box inflated past the part would destroy balls that bounced off
	 * the visible edge and never crossed anything.
	 */
	private pumpBallWalls(): void {
		if (this.ballWalls.size() === 0) return;

		// **Collected before anything is removed**, because `removeBall` deletes from the map this is iterating. The
		// same shape `pumpPulls` uses, and for the same reason: Lua permits deleting the current key during `pairs`
		// and this project has been bitten by assuming more than that.
		const caught = new Array<[Model, BasePart, BasePart]>();

		for (const wall of this.ballWalls) {
			// **A wall that left the world is forgotten rather than queried.** A destroyed part answers a bounds
			// query with nothing, so this would be harmless for one frame — but "harmless for one frame" per wall per
			// frame is a query that never stops, so the entry goes the moment it is not a wall any more.
			if (!wall.IsDescendantOf(Workspace)) {
				this.ballWalls.delete(wall);

				continue;
			}

			for (const part of Workspace.GetPartBoundsInBox(wall.CFrame, wall.Size, this.wallOverlap)) {
				const body = part.FindFirstAncestorWhichIsA("Model");
				if (body === undefined) continue;
				if (body.FindFirstChildWhichIsA("Humanoid") === undefined) continue;

				const held = this.heldBalls.get(body);
				if (held === undefined) continue;

				caught.push([body, held.ball, wall]);
			}
		}

		for (const [body, ball, wall] of caught) {
			playSpawnPoof(undefined, ball.CFrame);
			this.removeBall(body);

			logDebug(`[Ball] ${body.Name}: ball lost to the wall "${wall.Name}"`);
		}
	}

	/**
	 * Puts a ball in `model`'s hand.
	 *
	 * The public door for a hand-out, and the only one of the three that *makes* a ball: a catch and
	 * a pickup take one that already exists — see {@link catchBall} and {@link pickupBall} — while
	 * this is the game handing one out.
	 *
	 * **Its callers, because "who gets handed a ball" is the question this method keeps being asked.**
	 * An NPC's throwing behavior hands one to a rig, and a player is supplied by two things they earn:
	 * the MultiBall window and the `InfiniteBalls` dev flag. All three are answers to a throw or to
	 * something bought. **Nothing hands a player a ball on arrival** — a spawning body is armed by
	 * picking one up off the floor, which is what `JoinService` used to do and deliberately no longer
	 * does. Two populations arriving at one door is the point: they get the same ball, so "in a hand"
	 * stays one state rather than two.
	 *
	 * Keyed on the **model**, like everything else here. What differs between a player and an NPC is
	 * only the token on the model, which this does not touch and should not have to: whoever knows who
	 * is being handed a ball stamps it, and the ball reads it back at release.
	 *
	 * This deliberately does NOT use a Tool. A Tool's handle is gripped by the engine, and in this
	 * project that grip never actually forms (the character ends up with no `RightGrip`), so the
	 * unanchored ball falls straight out of the world. Welding the ball to the hand ourselves is
	 * deterministic.
	 */
	public giveBall(model: Model): void {
		// A model with no hand simply gets nothing, and gets it without a ball being built and thrown
		// away again. `BallFactory` is the only place a ball is made, so the making is its business and
		// none of it is repeated here.
		const ball = this.factory.createInHand(model);
		if (!ball) return;

		// The weld, the grip, the entry in `heldBalls` — everything "in a hand" means, for this ball
		// and for the two that arrive from the world.
		if (!this.attachToHand(model, ball)) return;

		// Armed *after* the attach, not by the factory: a hand-out is the one case where the ball is
		// live from the moment it exists, and attaching is what creates the component whose defaults
		// would write over anything set before it.
		ball.SetAttribute("Armed", true);
	}

	/**
	 * Pulls `ball` into `model`'s hand as a **catch**: a ball taken out of the air.
	 *
	 * Named for the intent rather than the mechanism, which is
	 * {@link attachToHand}'s. The two are one line apart today and are kept apart
	 * on purpose: the moment a catch grows something a pickup does not — an
	 * animation, a grace frame, its own telemetry — the seam is already there, and
	 * until then it costs nothing.
	 *
	 * **The answer is "a ball has been caught", and it is given on the frame of the decision rather than on the frame
	 * of the weld.** That is the whole contract `BallComponent.tryCatch` depends on: it spends the catch window,
	 * credits the badge and resolves the thrower behind this `true`, and every one of those is a fact about the
	 * *throw*. Waiting for the ball to arrive would let a drill live for another fifth of a second and would make an
	 * outcome depend on geometry the decision had already stopped caring about. The one case that does not return
	 * here is a catcher with no right hand, which falls straight through to `attachToHand`, is refused there, and
	 * answers `false` — so "refused" still means "nothing happened", exactly as before.
	 *
	 * **`instant` is "this catch must not travel"**, and it is passed by the *contact* door rather than derived here:
	 * `BallComponent.tryCatch` knows which door it came through and this does not. A ball caught on the body has no
	 * journey to show and a pull from zero studs is the yo-yo in its purest form — see {@link beginPull}.
	 */
	public catchBall(model: Model, ball: BasePart, instant: boolean): boolean {
		return this.beginPull(model, ball, "catch", instant);
	}

	/**
	 * **Starts the journey of a ball into a hand, and answers whether one has begun.**
	 *
	 * This is phase two of three: the catch has already been *decided* by the caller (`BallComponent.tryCatch` spends
	 * the window, releases the tags and resolves the thrower before this returns), and the *weld* is phase three, in
	 * {@link completePull}. See {@link pulling} for why the three are separated.
	 *
	 * **A body with no right hand falls straight through to `attachToHand`**, which warns and destroys the ball and
	 * answers `false`. That is the pre-existing refusal and it is kept exact rather than re-implemented: the caller's
	 * contract is "did a catch happen", and a hand-less catch has never been one. It also means the deferred path only
	 * ever runs when there is a hand to reach, so the weld cannot fail after the catch has already been reported.
	 *
	 * **Two ways in weld on the spot instead: `instant`, and a ball already inside `PULL_INSTANT_STUDS` of the hand.**
	 * They are one branch because they are one rule — *there is no journey here to draw* — and the distance half is
	 * not redundant, because a proximity catch at six studs is close enough to look wrong and too far for the contact
	 * door to have refused it. `PULL_INSTANT_STUDS` is where the whole of that argument lives.
	 *
	 * **The ball is stopped dead before the constraint takes over, and that is the fix for the yo-yo rather than a
	 * tidy-up.** The first version let the ball keep its velocity and asked a force to beat it, which cannot be done
	 * inside a frame: the pull sets `CanCollide = false`, so a ball caught at ninety studs a second carried straight
	 * *through* the catcher and was then reeled back out from behind them. Zeroing the velocity is the honest
	 * statement — the ball has been caught, so it is not travelling anywhere — and it makes the pull identical from
	 * every catch: a ball at rest, dragged to the hand. It is also why `PULL_MAX_FORCE` could come down by half.
	 *
	 * **`Armed` goes off here, at the start of the pull**, and that is what stops the ball being caught twice. The
	 * window has been spent for the catcher, but a *second* player with an open window could otherwise take a ball that
	 * is already on its way into somebody's hand — `canCatch` asks `Armed`, so clearing it closes both doors at once
	 * rather than adding a rule to each. It also means the ball stops tagging people while it travels, which is the
	 * only sensible reading of a ball that has been caught.
	 */
	private beginPull(
		model: Model,
		ball: BasePart,
		kind: "catch" | "pickup",
		instant: boolean,
	): boolean {
		// A ball already on its way somewhere else is not available — the same answer `attachToHand` gives a hand that
		// is already full. Asked before the hand is looked up, so a second request for a ball mid-flight cannot fall
		// through the refusal below into a synchronous attach.
		if (this.pulling.has(ball)) return false;

		const hand = this.factory.getRightHand(model);
		if (hand === undefined) return this.attachToHand(model, ball);

		// **The trail the ball flew in on stops where it was caught, and this is the frame that has to happen on.**
		// One line here rather than one at the catch site because this is the single funnel both catch doors pass
		// through *and* the last moment before anything moves the ball — an instant weld teleports it on this very
		// frame, and a pull starts dragging it on the next. A trail still on the ball would draw that journey, so the
		// arc into the hand would appear and then vanish when `attachToHand` disarmed the ribbon. See
		// `BallTrail.freeze`, which is also where the argument for moving the ribbons rather than copying them lives.
		//
		// **Not for a pickup**, and that is the difference between the two kinds rather than an omission: a ball taken
		// off the floor has been lying still with its ribbons disarmed since it landed, so there is no arc to preserve
		// and freezing one would park a part in `Workspace` to draw nothing.
		if (kind === "catch") BallTrail.freeze(ball);

		// The target, refreshed every frame while the pull lasts. See `pumpPulls`.
		const target = hand.CFrame.mul(GRIP_OFFSET).Position;

		if (instant || ball.Position.sub(target).Magnitude <= BALL_CONFIG.PULL_INSTANT_STUDS) {
			return this.attachToHand(model, ball);
		}

		// **An `Attachment` at the ball's own origin, created here and destroyed with the pull.** A ball is a sphere, so
		// its origin is near enough its centre of mass that a force applied there moves it without spinning it — and
		// zero means the constraint's target and the arrival test below are both about `ball.Position`, one number
		// rather than two that could disagree by the length of an offset.
		const attachment = new Instance("Attachment");
		attachment.Name = PULL_ATTACHMENT_NAME;
		attachment.Position = Vector3.zero;
		attachment.Parent = ball;

		// **`OneAttachment` with a written `Position`, not `TwoAttachment` with one on the hand.** The second shape
		// needs a second instance parented to a body part that can be destroyed mid-pull — a character dying during a
		// catch is exactly the leak this feature has to avoid — and it buys nothing, because the arrival test already
		// needs the hand's position every frame. One instance on the ball, dying with the ball.
		const align = new Instance("AlignPosition");
		align.Name = PULL_ALIGN_NAME;
		align.Mode = Enum.PositionAlignmentMode.OneAttachment;
		align.Attachment0 = attachment;
		align.Position = target;
		// A force rather than a teleport, which is the entire difference between a pull and the snap it replaces.
		align.RigidityEnabled = false;
		align.MaxVelocity = BALL_CONFIG.PULL_MAX_VELOCITY;
		align.Responsiveness = BALL_CONFIG.PULL_RESPONSIVENESS;
		align.MaxForce = BALL_CONFIG.PULL_MAX_FORCE;
		align.Parent = ball;

		// **The ball stops being scenery on the way in.** A ball that collided with its own catcher during the pull
		// would bounce off the body it is being pulled into, and the constraint would spend the pull fighting the
		// contact solver. The two flags are put back by `attachToHand`'s own configuration one frame later, and by
		// `dropBall`/`throwBall` for any ball that ends up loose.
		ball.CanCollide = false;
		ball.SetAttribute("Armed", false);

		// **And it stops dead, which is the half that fixes the yo-yo.** See this method's own note: a force cannot
		// arrest a ball at ninety studs a second inside a frame, and a non-colliding ball would carry through the
		// catcher and be dragged back out from behind them. Starting from rest makes every pull the same shape.
		ball.AssemblyLinearVelocity = Vector3.zero;
		ball.AssemblyAngularVelocity = Vector3.zero;

		this.pulling.set(ball, { kind, catcher: model, hand, align, attachment, startedAt: os.clock() });

		return true;
	}

	/**
	 * **Phase three: the ball has arrived, or has run out of time — weld it and say what happened.**
	 *
	 * **`attachToHand` is still the only way into a hand**, so everything a held ball means — the weld, the grip offset,
	 * massless, no queries, the cleared ability — arrives exactly as it did before this feature. The pull has only
	 * changed *where the ball is when that runs*.
	 */
	private completePull(ball: BasePart, pull: Pull): void {
		this.clearPull(ball, pull);

		if (!this.attachToHand(pull.catcher, ball)) return;

		if (pull.kind === "catch") {
			logInfo(`[Ball] ${pull.catcher.Name} caught a dodgeball`);

			// **The sound is not here, and it moved for a playtest reason.** It used to be emitted at this moment —
			// the frame the ball reaches the hand — on the argument that the sound *is* the ball landing. Standing in
			// the game, that reads as a delay: the catch is decided when the ball is taken out of the air, and a
			// catcher who hears it a fraction later hears it *after* the thing they did. It is now emitted by
			// `BallComponent.tryCatch` on the decide frame, at the ball's position where the catch actually happened.
			// See {@link emitCatchSound}.

			// **The body is marked as mid-catch, and this is now slightly late rather than early.** The mark drives the
			// reach, and a reach that began when the ball arrived would be a body grabbing at something already in its
			// hand. It is left here rather than moved to `beginPull` because this is the frame the ball is *held*, which
			// is what the clip is of; the delay is the pull, which is at most a fifth of a second and reads as the
			// reach following the ball in.
			this.markCatchAnimation(pull.catcher, "catch");

			return;
		}

		logInfo(`[Ball] ${pull.catcher.Name} picked up a dodgeball`);

		// **Written only on a pickup that happened.** `attachToHand` above is the refusal, and a refused pickup is
		// nothing to announce, so the count cannot be moved by an attempt. See {@link PICKUP_COUNT_ATTRIBUTE}.
		const collected = pull.catcher.GetAttribute(PICKUP_COUNT_ATTRIBUTE);
		const previous = typeIs(collected, "number") ? collected : 0;

		pull.catcher.SetAttribute(PICKUP_COUNT_ATTRIBUTE, previous + 1);
	}

	/**
	 * **Gives up on a pull without welding: the ball stays in the world, and the constraint goes.**
	 *
	 * The two ways in are a ball that left the world and a hand that did. **The ball is not destroyed**, because nothing
	 * about the failure is the ball's fault — it is left loose where it is, unarmed, which is a ball somebody can pick
	 * up again. What must not be left behind is the constraint: an `AlignPosition` is parented to the ball and would
	 * survive a re-parent, dragging it toward a hand that no longer exists.
	 */
	private abandonPull(ball: BasePart, pull: Pull, why: string): void {
		this.clearPull(ball, pull);

		if (!ball.IsDescendantOf(Workspace)) return;

		ball.CanCollide = true;
		ball.CanQuery = true;

		logInfo(`[Ball] ${pull.catcher.Name}: pull abandoned — ${why}`);
	}

	/** Destroys the constraint and its attachment and forgets the entry. The one teardown, shared by both exits. */
	private clearPull(ball: BasePart, pull: Pull): void {
		this.pulling.delete(ball);
		pull.align.Destroy();
		pull.attachment.Destroy();
	}

	/**
	 * **The one loop that drives every pull — arrival, timeout, and the two ways it can go wrong.**
	 *
	 * **One `Heartbeat` over the map rather than a `task.spawn` per catch**, for `CatchService`'s proximity loop's
	 * reason: a thread per catch is a thread per catch with its own cancellation problem, and the empty-map check is
	 * the entire cost of having no pulls in flight.
	 *
	 * **Completions are collected and applied after the iteration**, because both exits delete from the map being
	 * walked. Lua permits deleting the current key during a `pairs` loop and this project has been bitten by assuming
	 * more than that, so the safe shape is used rather than the clever one.
	 *
	 * **The order of the checks is the order of likelihood**: a pull ends by arriving, and every other exit is a fault.
	 */
	private pumpPulls(): void {
		if (this.pulling.size() === 0) return;

		const now = os.clock();
		const arrived = new Array<[BasePart, Pull]>();
		const abandoned = new Array<[BasePart, Pull, string]>();

		for (const [ball, pull] of this.pulling) {
			// **The ball leaving the world ends the pull silently.** It was destroyed, or caught by something else, or
			// parked — and its constraints went with it, so there is nothing to destroy.
			if (!ball.IsDescendantOf(Workspace)) {
				abandoned.push([ball, pull, "the ball left the world"]);

				continue;
			}

			// **A hand that has left the world is a catcer who died mid-pull**, and it is the leak this feature has to
			// survive: the constraint would otherwise drag the ball toward a part nobody can see.
			if (!pull.hand.IsDescendantOf(Workspace)) {
				abandoned.push([ball, pull, "the hand is gone"]);

				continue;
			}

			const target = pull.hand.CFrame.mul(GRIP_OFFSET).Position;

			// **Rewritten every frame, because the hand moves.** A catcher walking, or one whose idle animation moves
			// the arm, is a target that shifts under a constraint that was told where to aim once.
			pull.align.Position = target;

			const close = ball.Position.sub(target).Magnitude <= BALL_CONFIG.PULL_ARRIVAL_STUDS;
			const late = now - pull.startedAt >= BALL_CONFIG.PULL_TIMEOUT_SECONDS;

			if (close || late) arrived.push([ball, pull]);
		}

		for (const [ball, pull, why] of abandoned) this.abandonPull(ball, pull, why);
		for (const [ball, pull] of arrived) this.completePull(ball, pull);
	}

	/**
	 * Marks `model` as mid-catch — **the one writer of `CATCH_ANIMATION_ATTRIBUTE`, called by both halves of
	 * catching.**
	 *
	 * **A catch and an attempt are the same animation, so they are the same mark.** This method is reached when
	 * the ball actually arrives in a hand ({@link catchBall}) and when an attempt is *accepted* with no ball in
	 * sight (`CatchService.attemptCatch`) — because the body is doing the same thing either way: reaching. A
	 * catch that never comes has to be visible as much as one that does; it is the only feedback a press has.
	 *
	 * **One writer rather than two, and that is the whole reason this is public at all.** The mark's lifetime is
	 * a counter plus a timer, and two services each holding their own copy would leave two timers racing over
	 * one attribute: an older one fires, finds an attribute a newer mark still owns, and clears it early —
	 * cutting the clip off after a fraction of a second, which reads exactly like a clip that failed to load.
	 * So the machinery lives beside the catch it belongs to, and the catch *window* asks for it.
	 *
	 * **A throw's mark still standing is dropped first, and that is the one guard the two actions need between
	 * them.** A body can throw and catch inside `CATCH_ANIMATION_SECONDS` — the thrown ball is gone, the hand is
	 * free, and a second ball arriving is an ordinary catch — and without this the renderer would be holding the
	 * catch branch *behind* the throw branch (`bodyClipFor` ranks the throw first) and would replay the catch
	 * clip the moment the throw's own mark expired: a catch pose a fifth of a second after the catch. Dropping
	 * the older mark says the honest thing instead — the newer action owns the limbs — and the throw's own timer
	 * is already written to notice that its mark is gone and leave the attribute alone. **The other order needs
	 * nothing**: a throw inside a catch window takes the limbs because the throw outranks the catch, and the
	 * catch mark expires behind it without ever being played again.
	 *
	 * **A mark on a body already marked restarts the window rather than stacking one**, which is the counter
	 * below and the timer at the end of this method working together: the newer mark owns the attribute, and the
	 * older timer finds it does not and leaves it alone. This is the case a catcher actually produces — a press
	 * after a press, or the same body catching twice inside half a second.
	 *
	 * **`cause` is the value rather than a note about it, and that is a change of job rather than of wording.**
	 * It used to be for the log and nothing else — the two callers differed only in what the output said. It is
	 * now what the attribute *carries*, because a catch written over an attempt has to be a **second observable
	 * event** on the client: both halves play the same clip, so the clip cannot tell them apart, and an
	 * attribute rewritten with the value it already holds fires nothing. `true` for both was one event where
	 * there are two. The reader that acts on it is `client/catchShockwave.ts`, which draws the white attempt and
	 * the green catch.
	 */
	public markCatchAnimation(model: Model, cause: CatchCause): void {
		this.clearAnimationMark(model, THROW_ANIMATION_ATTRIBUTE, this.throwMarks);

		const catchMark = (this.catchMarks.get(model) ?? 0) + 1;
		this.catchMarks.set(model, catchMark);
		model.SetAttribute(CATCH_ANIMATION_ATTRIBUTE, cause);

		// **One line per mark.** The clip itself is drawn by the client that owns the body — every client for a
		// rig, its own for a player — and each of those prints its own line when it changes clip
		// (`[Animate] <name>: catch — Action`, `[Rig] <name>: catch — Action`). This line is the *server's*
		// half, and it says the fact was published, which is the one thing a client's silence cannot tell you.
		if (DEBUG_LOGGING) {
			logInfo(
				`[Ball] ${model.Name}: catch animation mark — ${cause}, ` +
					`${CATCH_CONFIG.CATCH_ANIMATION_SECONDS}s`,
			);
		}

		task.delay(CATCH_CONFIG.CATCH_ANIMATION_SECONDS, () => {
			// A newer mark owns the attribute by now; its own timer is the one that clears it, so this leaves it
			// alone rather than cutting a later reach short.
			if (this.catchMarks.get(model) !== catchMark) return;

			this.catchMarks.delete(model);
			model.SetAttribute(CATCH_ANIMATION_ATTRIBUTE, undefined);
		});
	}

	/**
	 * Drops an action mark on `model` if one is up — **the whole of how one action supersedes another.**
	 *
	 * Nothing is stopped and nothing is scheduled here: the mark's owner has a timer of its own, and every
	 * one of those timers is written to check whether it still owns the mark before clearing anything. So
	 * removing the entry *is* the supersede — the older timer finds somebody else's mark (or none) and leaves
	 * the attribute and its track where the newer action put them.
	 *
	 * The map is a parameter rather than this being two methods, because the rule is about the marks and not
	 * about which action owns them: a third action clip would call this with its own map and need nothing
	 * else.
	 */
	private clearAnimationMark(model: Model, attribute: string, marks: Map<Model, number>): void {
		if (!marks.has(model)) return;

		marks.delete(model);
		model.SetAttribute(attribute, undefined);
	}

	/**
	 * Pulls `ball` into `model`'s hand as a **pickup**: a ball collected off the
	 * ground.
	 *
	 * The same hand either way, which is the point: a picked-up ball is thrown by
	 * the same call as a caught one, because by the time it is in the hand there is
	 * nothing left to tell the two apart.
	 *
	 * **It begins a pull rather than welding** ({@link beginPull}), so the answer means "a journey into the hand has
	 * started". That is still the fact the caller needs — the ball is spoken for the instant this returns `true` — and
	 * the pickup count below is written when the ball actually arrives, because a count of things in a hand should not
	 * be moved by one that is still in the air.
	 *
	 * **And it is the one entry point in the game that is *only* a pickup**, which is what makes it the place to
	 * publish that fact. Four routes put a ball in a hand — this one, a catch, a round's hand-out and a
	 * MultiBall refill — and all four end in `attachToHand`, so `attachToHand` knows everything a held ball
	 * needs and nothing about which route it took. Nothing downstream needs to know either, *except* the
	 * picker's own client, which plays a sound for a pickup and must stay silent for the other three. It
	 * cannot tell them apart by watching the ball arrive, so this call is the answer it cannot work out for
	 * itself. See {@link PICKUP_COUNT_ATTRIBUTE} for why it is a counter rather than a flag, and
	 * `client/personalAudio` for the reader.
	 *
	 * **A rig's pickups are counted too**, for the reason the count is on the body rather than on a
	 * `Player`: this method is handed a body and needs no owner type to say so. A rig's client does not
	 * exist, so nothing reads its copy, and if a rig ever grew one a body-level counter already says the
	 * right thing.
	 */
	public pickupBall(model: Model, ball: BasePart): boolean {
		return this.beginPull(model, ball, "pickup", false);
	}

	/**
	 * **Plays the catch sound where the catch was decided, which is the frame the catcher pressed and the place the ball
	 * was taken out of the air.**
	 *
	 * **A one-line method rather than an `emitSound` call at the catch site, and the reason is the emitter's name.** The
	 * catch is reported from the ball — `BallComponent.tryCatch`, which is the one place both catch doors meet — and the
	 * emitter name that makes "no catch emitters remain" a statement about catches lives here, beside the sound it names.
	 * A public command with an intent-shaped name keeps that pairing in one file without exporting the constant to a
	 * component that has no other business with it.
	 *
	 * **The position is the ball's, not the hand's, and that is the difference between this and where it used to be.**
	 * A catch can happen up to eight studs from the catcher — a proximity catch at the edge of the radius is a ball
	 * nowhere near a hand — and a sound emitted at the hand would be a sound from a place where nothing happened. This is
	 * the same reasoning `BallComponent` already applies to an impact: the noise belongs where the ball was.
	 */
	public emitCatchSound(model: Model, at: CFrame): void {
		emitSound(at, model.Name, SOUND_CONFIG.CATCH, CATCH_EMITTER_NAME);
	}

	/**
	 * Lets go of whatever `model` is holding, leaving the ball in the world.
	 *
	 * Keyed on the **model**, like every other hand operation here, so any model
	 * that can hold a ball can drop one. The ball leaves the hand limp — unarmed,
	 * and non-colliding with the model it came out of — because a dropped ball is
	 * scenery, not a projectile.
	 *
	 * It lands *in front of* the model rather than at its feet, and cannot be picked up
	 * again for a moment — see `BALL_CONFIG.DROP_DISTANCE`, `DROP_HEIGHT` and
	 * `DROP_PICKUP_LOCKOUT`. Both of those are the same requirement seen twice: a ball put
	 * down inside the dropper's own reach would be collected again as soon as its lockout
	 * expired, which is the same as the key doing nothing.
	 *
	 * In front, and **short of whatever is in front**: the drop is cast first, so facing a
	 * wall puts the ball down in front of the wall instead of inside it, or through it. See
	 * {@link dropReach}.
	 *
	 * Returns whether there was anything to drop.
	 */
	public dropBall(model: Model): boolean {
		const held = this.heldBalls.get(model);
		if (!held) return false;

		const ball = held.ball;

		// The mark, read once. This method asks two questions about it — whether there is one, and whether
		// the ball carrying it is the round's — and `abilityOn` is a `GetAttribute` through a string, which
		// is not a thing to do twice in one call for the sake of a shorter line.
		const marked = abilityOn(ball);

		// **A marked ball is not put down — it is destroyed, and the charge goes with it.**
		//
		// An ability sitting on a ball in the open is an ability anybody can walk over and take, which
		// is not what a charge is: it was earned by the player who marked the ball, and it is theirs to
		// throw or to lose. So putting a marked ball down destroys it, and `SuperService` is told the
		// charge is *forfeited* rather than spent — the difference between putting an ability down and
		// having used one.
		//
		// **Returning from here rather than falling through is load-bearing.** Everything below is about
		// a ball that has to end up somewhere: a position clear of the dropper, a pickup lockout, an
		// expiry on the ordinary clock. A destroyed ball has none of that business.
		//
		// **But a round's ball is not destroyed, and this is the one case where the two rules in this method
		// disagree.** Item 139 took the round's stock off the expiry clock on the argument that *the round's
		// sweep is what ends it*; a forfeit that destroys the same ball is the same disappearance through a
		// different door, and it is the only destroyer left in this file that fires from inside a round. The
		// report — *"why are the balls still disappearing during rounds"* — arrived with this branch still
		// here: a rig marks its hand-held ball from a mystery box and forfeits nothing when it dies, a player
		// marks one and presses drop, and either way the ball is gone for the rest of the round even though
		// the *ability* is the thing being forfeited. So the ball is spared and the mark is not, which is
		// what the block below this one does. `lifetimeOf` is the predicate that already means "this ball is
		// the round's and the round's sweep ends it", so the two paths cannot disagree about which balls
		// those are.
		if (marked !== undefined && this.lifetimeOf(ball) !== math.huge) {
			// **The entry goes before the instance**, for `removeBall`'s reason: `isHeld` answers from
			// this map, and a destroyed ball still answering `true` is a ball two other systems can
			// still see and act on.
			this.heldBalls.delete(model);

			// The dropper, when there is one. A rig can now mark a ball — its next throw after a mystery box
			// applies the pending ability — but it still forfeits nothing here: a rig holds no charge, and its
			// pending slot is the *throw's* to clear, not this path's. So the guard stays the ordinary path:
			// an NPC dropping a marked ball destroys it exactly as a player's does **outside a round**, and
			// `forfeitCharge` is the one thing a rig skips, because there is nothing of its own on the ball to
			// forfeit. Inside a round neither is destroyed — see the branch below, which is the whole of why
			// this condition is not simply `marked !== undefined` any more.
			const player = Players.GetPlayerFromCharacter(model);
			if (player) this.abilities.forfeitCharge(player);

			ball.Destroy();

			// **`logInfo` rather than `logDebug`, against this file's habit, and the habit is the reason.** Every
			// destroyer of a ball used to be silent at `logInfo`, so *"the balls are disappearing"* has been
			// unanswerable from a log three times running — a round's worth of ball events and no line saying
			// one of them ended. This one names the ball's owner and the reason, and there are only a handful
			// of these per round, so it costs nothing to have it always on.
			logInfo(`[Ball] ${model.Name} dropped a marked dodgeball — it is destroyed`);

			// **And an open MultiBall window fills the hand the marker emptied.** These two rules are
			// deliberately different and must not be made consistent: the *mark* is the ball's, so losing
			// the ball forfeits the charge above; the *window* is the player's, so losing a ball does not
			// touch it. A player holding both — a Pierce mark on the ball and a window running — keeps the
			// window and loses the mark, which is what it means for one ability to live on a thing and the
			// other to live on a person. Free rather than paid, because nothing was thrown: see
			// {@link refillFromBuff}.
			this.refillFromBuff(model, false);

			// **A dropped mark is a power the player has lost**, so the HUD stops saying ready — the ball that
			// carried it is a destroyed instance and can never be thrown. See `syncArmedPower`.
			this.syncArmedPower(model);

			return true;
		}

		// **And the same forfeit with the ball kept, which is the branch above's other half.** The charge goes
		// exactly as it does there — a charge belongs to a *player*, and putting the ball down is putting the
		// ability down whether the ball survives or not — and then the ball stops being the marked one and
		// carries on to the ordinary drop below. A rig has nothing to forfeit and takes the same path, which is
		// why the `forfeitCharge` guard is the same one the destroy branch uses rather than a second rule.
		if (marked !== undefined) {
			const player = Players.GetPlayerFromCharacter(model);
			if (player) this.abilities.forfeitCharge(player);

			// **The mark comes off before the ball reaches the floor, and that is what keeps this from being a
			// way to hand an ability away.** A mark is only ever put on in a hand — `markHeldBall` — and
			// `attachToHandBody` clears it again on the way into the next one, so a ball that lay on the floor
			// still carrying Pierce or Freeze would be a mark that survived a forfeit. `setBallAbility` is the
			// one writer of the attribute and of the aura that says it out loud, and `detachPierceEffect` is the
			// Pierce trail's other half, for `attachToHandBody`'s reason: it is a child of the ball, so it
			// outlives the attribute that justified it unless something takes it away.
			this.setBallAbility(ball, "");
			this.detachPierceEffect(ball);

			// **And the HUD stops saying ready here rather than at the tail.** The tail only reaches
			// `syncArmedPower` by way of a MultiBall refill putting a ball back in the hand, and this is the one
			// drop that leaves the ball in the world: without this line a player who puts a marked ball down
			// keeps a `READY` plate for a power that is already forfeited, on a ball that no longer carries it.
			this.syncArmedPower(model);

			logInfo(
				`[Ball] ${model.Name} put down a marked dodgeball — the ${marked} is forfeited, the ball is not: ` +
					`this one is the round's, and only the round's sweep ends it`,
			);
		}

		// Out of the hand first, so the weld is not fighting the reparent below.
		ball.FindFirstChild(GRIP_NAME)?.Destroy();

		// Nobody's ball now: unarmed, because an armed ball is a live projectile and
		// would hurt whoever walked into it lying there.
		ball.SetAttribute("Armed", false);
		ball.Parent = Workspace;
		// **Frees its weight along with its mass** — see `BallFactory.setHeld`, which will not write one
		// without the other, and which is why this is not a bare `Massless = false` any more.
		this.factory.setHeld(ball, false);
		ball.CanCollide = true;
		// **And answers queries again, which is the pair to the hand's `CanQuery = false`.** The ball is in
		// the world now, so the aim preview is entitled to stop on it — and would, if it were not for the
		// guide's own decision to pass through balls (see `ThrowController.looseBalls`). See
		// `attachToHand` for the whole of why a held ball is the one the preview must not see.
		ball.CanQuery = true;

		// In front of the model and above it, so the ball falls onto a clear patch of floor
		// rather than being placed into the character or the ground — see
		// `BALL_CONFIG.DROP_DISTANCE` and `DROP_HEIGHT`. Placed from the root part, which is
		// what every rig has, rather than from the hand it came out of: where a *hand* is
		// depends on the rig type and on whatever it is doing with its arms.
		const root = model.FindFirstChild("HumanoidRootPart");
		if (root && root.IsA("BasePart")) {
			const direction = root.CFrame.LookVector;
			const reach = this.dropReach(model, ball, root.Position, direction);

			ball.Position = root.Position.add(direction.mul(reach)).add(new Vector3(0, BALL_CONFIG.DROP_HEIGHT, 0));
		}

		// And nobody may have it back for a moment: it is still in the air, and then still
		// rolling. On the ball rather than remembered here, because what needs the beat is the
		// ball and not the hand it left — see `PICKUP_LOCKED_UNTIL`.
		ball.SetAttribute(PICKUP_LOCKED_UNTIL, os.clock() + BALL_CONFIG.DROP_PICKUP_LOCKOUT);

		// It becomes solid close to the model, and the engine settles whatever overlap is left
		// by shoving whichever body is lighter. Without this, the old thrower-push bug comes
		// back wearing a different hat.
		CollisionIgnore.between(ball, model);

		// The server takes the ball back. It was welded into a hand, so it belonged to that
		// character's client's physics, and a ball lying on the ground is one everybody can walk
		// up to — the machine that happened to drop it should not be the one simulating it. The
		// same call, for the same reason, as the one at release.
		ball.SetNetworkOwner();

		this.heldBalls.delete(model);

		// Loose balls are cleaned up on whatever clock they are on — which since item 139 is **not** one clock
		// for every ball: the arena's own stocking is never on a clock at all. A catching NPC drops every ball
		// it takes, so without a clock the map collects scenery for the rest of the session; the `isHeld` guard
		// inside leaves a ball that has since been caught to its new owner. See {@link lifetimeOf}.
		scheduleBallExpiry(ball, this.lifetimeOf(ball), (expiring) => this.isHeld(expiring));

		logDebug(`[Ball] ${model.Name} dropped a dodgeball`);

		// **And the hand is filled again if a MultiBall window is open**, which is the whole of the bug
		// this ability exposed: putting a ball down used to mean losing the super move with it, because
		// the ability lived on the ball. This one lives on the player, so the ball is left where it lands
		// and the window hands over the next one. **Free rather than paid** — nothing was thrown, so there
		// is no throw to answer and the count does not move. See {@link refillFromBuff}.
		this.refillFromBuff(model, false);

		return true;
	}

	/**
	 * Destroys whatever `model` is holding.
	 *
	 * The other way a ball leaves a hand, and the difference is where it goes afterwards:
	 * {@link dropBall} puts it on the ground and this takes it out of the world. Named for what the
	 * caller means — a ball that should *stop existing* rather than a ball that should be somewhere —
	 * because the two are one word apart at every call site and a reader has to be able to tell them
	 * apart there.
	 *
	 * **Nothing has to be undone, which is the whole reason this is short.** The grip weld, the trail's
	 * ribbons and their attachments, the pickup prompt and any `CollisionIgnore` constraints are all
	 * children of the ball — see `BallTrail` and `CollisionIgnore`, both built on exactly that — so they
	 * go with the instance. The one piece of state that is *not* on the ball is the entry in
	 * {@link heldBalls}, and that is the one line here.
	 *
	 * Returns whether there was anything to destroy.
	 */
	public removeBall(model: Model): boolean {
		const held = this.heldBalls.get(model);
		if (!held) return false;

		// **The entry goes first.** `isHeld` answers from this map, and two things ask it about a ball
		// that is on its way out: `BallSpawnerService.cleanupRoundBalls` asks whether it may take a
		// round's ball away, and `scheduleBallExpiry` asks whether a ball it was told to destroy has
		// been claimed since. A destroyed ball still answering `true` would be a ball those two can
		// still see, so it stops being one before it stops being an instance.
		this.heldBalls.delete(model);

		held.ball.Destroy();

		// **And if that ball was the armed one, the player is no longer ready.** The last of the five sites —
		// a round cleanup, a death's own removal, or anything else that takes a ball out of the world. See
		// `syncArmedPower`; the read finds an empty hand, because the entry went first.
		this.syncArmedPower(model);

		// **`logInfo`, for the reason the marked-ball destroy gives.** This is the last of the four ways a ball
		// leaves the world and it was the quietest — a wall taking a ball, a round's sweep, a death's removal and
		// an emptied hand all arrive here, and none of them said anything a log could be read for. The callers
		// that matter (the sweep) print their own counts as well; this line is what names the ball.
		logInfo(`[Ball] ${model.Name}'s ball was destroyed`);

		return true;
	}

	/**
	 * The one place a ball is put into a hand: the weld, the inert state, nobody's
	 * name on it, and an entry in `heldBalls`.
	 *
	 * Shared by the hand-out, the refill after a throw, a catch and a pickup, so all
	 * four produce the same thing in the same state: a ball welded into a hand,
	 * massless and non-colliding, with its trail switched off until it flies again.
	 *
	 * Reached through {@link catchBall} or {@link pickupBall} rather than directly,
	 * so a caller says which it meant — the hand itself does not care, which is what
	 * keeps one weld in the game instead of four.
	 *
	 * **It does not make the ball**, and it no longer configures one: `BallFactory` did all of
	 * that, including finding the hand to place it at. What is left is what only this service can
	 * do — the *holding*.
	 */
	private attachToHand(model: Model, ball: BasePart): boolean {
		// Scope: BallService.attach — every route a ball takes into a hand, four of them per rig per turn.
		if (DEBUG_CONFIG.PROFILE) debug.profilebegin("BallService.attach");
		const attached = this.attachToHandBody(model, ball);
		if (DEBUG_CONFIG.PROFILE) debug.profileend();
		return attached;
	}

	/**
	 * The body of {@link attachToHand}, split off **only** so the scope above can wrap it.
	 *
	 * **Why a second method rather than the pair written into the body.** The body returns `false` from a
	 * missing hand and a held ball's replacement, and `true` at the end; a `profileend` written at the last
	 * statement would be skipped on the first of those, leaving an open band. The split makes the pairing
	 * structural — one statement between `begin` and `end`, every exit a return into it — and the extra
	 * frame is paid whether the flag is on or off, so the recording is not measuring a different call graph
	 * from the one the game runs.
	 *
	 * **Nothing inside yields**, which is what makes the scope legal at all: there is no `task.wait`, no
	 * `Humanoid` move and no `Sound:Play()` that waits inside either half. The only yield in this file is
	 * the settle loop's `task.wait`, four hundred lines past the end of this method.
	 */
	private attachToHandBody(model: Model, ball: BasePart): boolean {
		// The same hand the ball was placed at, asked of the factory rather than looked up again
		// here: one rig-type rule, in one file, for both the placing and the welding.
		const hand = this.factory.getRightHand(model);
		if (!hand) {
			logWarn(`[Ball] ${model.Name}: could not find a right hand to hold the ball`);
			ball.Destroy();
			return false;
		}

		// Respawn safety, and catching safety: whatever this model was already
		// holding goes, so two balls can never end up sharing one hand.
		//
		// **Named in the log rather than destroyed quietly**, which it did until now. This is the one destroyer
		// of a ball that had no line at all, and it is reached by a respawn that finds the old entry still in
		// {@link heldBalls}, by a catch arriving while one is held and by a hand-out layered over one — three
		// paths with nothing in common except the symptom, which is a ball the player was holding ceasing to
		// exist. If it ever fires mid-round it is a bug worth reading about rather than a case worth tolerating
		// silently, and there is no way to tell the two apart from outside.
		const replaced = this.heldBalls.get(model);
		if (replaced) logInfo(`[Ball] ${model.Name}: the ball already in hand is replaced — ${replaced.ball.Name} is destroyed`);
		replaced?.ball.Destroy();
		this.heldBalls.delete(model);

		// A caught ball arrives mid-flight, still carrying the weld that held it in
		// its thrower's hand. One weld per ball, and this is about to be replaced.
		ball.FindFirstChild(GRIP_NAME)?.Destroy();

		// **What it means for a ball to be in a hand, applied to whatever arrived.** Every way a ball
		// can come into one passes through here — the hand-out, the refill after a throw, a catch, a
		// pickup — while only some of them come from `BallFactory`. So everything a *held* ball needs
		// is done here rather than where the ball was made, or the balls that arrive from the world
		// would miss it, and a caught ball would sit in the hand still configured as a projectile.
		//
		// Each of the four is load-bearing, and the first was a bug when it was not here: `Parent` is
		// what `throwBall` reads to decide whether there is anything in the hand at all, so a ball
		// parented anywhere else cannot be thrown; the frame is what puts it *at* the grip, because a
		// weld holds the offset the parts already had and a ball caught across the body would stay
		// across it; and the other two are what stop a solid, full-weight ball being dragged around
		// inside the holder, which was the old thrower-push bug wearing a different hat.
		ball.CFrame = hand.CFrame.mul(GRIP_OFFSET);
		ball.CanCollide = false; // don't shove the holder around while held

		// **And a ball in a hand stops answering queries, which is what keeps the aim preview from
		// stopping on it.** A `Trajectory` sweep asks a part's `CanQuery` while the thrown ball's physics
		// asks its `CanCollide` — the two questions are not the same one unless
		// `RaycastParams.RespectCanCollide` is turned on, and it is off. So a held ball, being
		// `CanCollide = false` with `CanQuery` still true, was the one thing in the world the *drawn* arc
		// stopped on while the real ball flew straight through it.
		//
		// **A throwing rig holds a ball nearly always** — the throw refills the hand immediately — so the
		// drawn path ended on the ball in the rig's hand, a couple of studs short of its body, and read as
		// a throw that would miss, while the ball passed through, hit the body, and killed it. The probe
		// said the same thing in its own words: `stopped without crossing the predicted surface — it hit
		// something else`, which is exactly what a ball does with a surface that no ball can touch.
		//
		// **The house idiom rather than an invention.** `CanQuery = false` is already how this project
		// keeps a part out of the preview's spherecast: the midline wall, the spawner parts, the lobby
		// signs, the sound emitters and the team rings all carry it for that reason, and a ball in a hand
		// is the same claim — it is not scenery, so the sweep that answers "where does this throw go" must
		// not stop on it.
		//
		// **What this is not: a physics change.** `CanQuery` is the *query* half only. The ball is still
		// `CanCollide = false` while held for the reason the line above gives, and `dropBall` and
		// `throwBall` put the query half back on the two lines that make a ball free again. Every ray in
		// the game that has business with a loose ball — the settle loop's ground probe, the drop
		// reach — keeps it, because those only ever look at balls parented to `Workspace`.
		ball.CanQuery = false;
		// **Held: massless *and* without its own gravity**, because those are one fact — see
		// `BallFactory.setHeld`. A force left on here would be lifting the character carrying the ball.
		this.factory.setHeld(ball, true);
		ball.Parent = model;

		// And nobody's and nothing's — a caught ball is still armed and still named to the thrower it
		// left, which is what this clears.
		this.factory.makeInert(ball);

		// **And an ordinary ball again, which is the other end of the ability rule.**
		//
		// A ball arriving in a hand has finished whatever it was doing: a caught one was Pierce for the
		// throw it was caught out of, a picked-up one may have been left marked by somebody else, and a
		// hand-out has never carried anything at all. All three come through this method, so the clear
		// belongs here rather than at each of them — and it is the half that makes the mark safe: one
		// that survived a catch would hand the next thrower an ability nobody chose to give them, and
		// one that survived a pickup would let a dropped mark be collected off the floor and used.
		//
		// Written as the empty string rather than removed, which is how `makeInert` above treats
		// `ThrowerId`: one empty case for a reader instead of two. It goes through `setBallAbility`
		// because a ball that arrives carrying an aura has to lose it here too — this is the moment a
		// ball stops being a throw and becomes something being held, and a held ball with no mark on it
		// is not a Freeze ball until its new holder says so.
		this.setBallAbility(ball, "");

		// **And nothing left over from the flight it just finished, which is a quieter leak than the one
		// above and a worse one.** A `NoCollisionConstraint` is parented to the ball and dies with it —
		// the right lifetime for a *part*, and the wrong one for a *throw*, because a ball outlives its
		// throws. A Pierce ball lands, lies there, gets picked up, and is thrown again as an ordinary
		// ball that is still intangible to every body the previous throw was set up against. So the whole
		// set comes off here, at the moment a ball stops being a throw and becomes something being held.
		//
		// **Everything, not just the ability's share.** The thrower and dropper ignores have exactly the
		// same problem — today a ball is permanently intangible to whoever last threw or dropped it, even
		// when somebody else is the one throwing it now — and a ball in a hand has no flight to be
		// ignoring anybody *for*. One sweep is simpler than a registry of which constraint belongs to
		// which feature, and it is the version that cannot leave one behind.
		//
		// **What this deliberately leaves alone is a ball lying loose.** Its constraints stay until it
		// expires or somebody collects it, and that window is harmless: an unarmed ball does nothing on
		// contact — `handleTouch` returns on its first line for a ball that is not `Armed` — so the only
		// visible effect would be a body clipping through a ball on the floor. Closing that too would
		// mean reaching into the contact path for a case with no symptom.
		CollisionIgnore.clear(ball);

		// **And the Pierce trail, for the same reason and with a louder symptom.** It is a child of the ball,
		// and a child of a ball survives a catch — so a caught Pierce ball would arrive in the catcher's hand
		// still wearing the trail of the throw it was caught out of: an effect that says "this ball is Pierce"
		// on a ball whose ability `setBallAbility` above has just cleared. The end-of-throw branch in
		// `BallComponent` covers the throw that lands on something; this covers the one that was caught, which
		// never touches the world at all and therefore never reaches that branch.
		this.detachPierceEffect(ball);

		// **And then the arm, if this player is carrying one — the other end of the dev shortcut.**
		//
		// An armed dev has no ball to put an ability on, so the ability waits on the *player* and moves
		// onto the first ball that arrives here. All four ways a ball can come into a hand pass through
		// this method, so this is the one place the arm has to be collected.
		//
		// **After the clear above, deliberately, so that arming wins.** A dev who arms and then catches an
		// enemy's Pierce ball gets *their* arm on it rather than the ability it arrived carrying — which is
		// what "the next ball they take up is the marked one" means, and the reverse order would let the
		// incoming ball's ability survive instead.
		//
		// The arm is spent by being taken up rather than left standing: a player armed once who picked up
		// two balls in a row would otherwise have two loaded balls, and the second pickup would load one
		// they never asked about.
		const owner = Players.GetPlayerFromCharacter(model);
		const armed = owner?.GetAttribute(ARMED_ABILITY_ATTRIBUTE);

		// **`isBallAbility`, because the arm is a ball's ability waiting to happen** — the attribute this is
		// about to write is the ball's, so the arm is held to the same narrower test the mark handler
		// applies on the wire. An arm naming a player-level buff would otherwise put that word on a ball by
		// the back door, which is the one thing the check at the mark handler exists to prevent.
		if (owner && typeIs(armed, "string") && isBallAbility(armed)) {
			// Through `setBallAbility` like every other write of this attribute, which is what makes an
			// armed Freeze ball arrive in the hand already wearing its aura rather than only after the
			// dev has thrown it once.
			this.setBallAbility(ball, armed);
			owner.SetAttribute(ARMED_ABILITY_ATTRIBUTE, "");

			logDebug(`[Super] ${owner.Name}: ${ball.Name} took up the armed ${armed}`);
		}

		// The trail stays off until the throw — otherwise it hangs off the hand every time
		// the holder walks around. A ball that is caught keeps the ribbons it flew with,
		// disarmed and hidden by the same call, rather than being given a second set: two
		// sets on one ball would be twice the density at twice the cost, and would throw off
		// the angles the cross-section is built from. Nothing is built at all when the trail
		// is switched off — see `BallTrail.attach`.
		// **And the trail the holder brings to it, which is the one thing here that is about a *body* rather
		// than about a ball.** The colours come from the record rather than from an attribute for a player, so
		// a client cannot talk its way into a trail — see `EconomyService.equippedTrailColors`. Handing
		// them in on every attach, including the adopt-existing branch, is what makes a ball picked up
		// from somebody else change its trail to its new holder's rather than keeping the last one's.
		//
		// **The model is handed over rather than the player resolved from it, and that is the change that lets
		// a rig wear one.** `owner` above is `Players.GetPlayerFromCharacter(model)` and is therefore `undefined`
		// for every rig — which is how this line used to read a rig as "nothing equipped, use the grey default".
		// The question being asked is about the *body holding the ball*, and a body is what this function has;
		// the economy works out which kind it is. See `EconomyService.equippedTrail` for the two answers.
		const trail = BallTrail.attach(ball, this.economy.equippedTrailColors(model));

		// **The one line that says which trail this ball actually got**, and its three facts are the three the
		// appearance depends on: who is holding it, what the *record* says they are wearing, and whether the
		// ribbons were built for them or adopted from the last hand the ball was in. The last is what nothing
		// else can report — an adopted trail that has just been repainted is indistinguishable from a fresh
		// one by looking at the ball — and the middle is what separates "the record had nothing equipped" from
		// "the record had a trail and the ribbons were given it". What the trail then looks like on screen is
		// the one thing no log can settle, which is where this line stops.
		//
		// Gated like the throw probe's line, and one line per attach rather than per ribbon — a ball changes
		// hands a few times a minute and wears `TRAIL_COUNT` of them per layer. `(default)` is the record's own
		// word for the empty id, and the holder falls back to the body's name so that a rig — which has no
		// `Player` and therefore never has an equipped trail — reads as itself rather than as an unnamed default.
		if (DEBUG_LOGGING) {
			const equipped = this.economy.equippedTrailId(owner);

			logInfo(
				`[Ball] ${owner?.Name ?? model.Name}: trail ` +
					`${trail === undefined ? "off" : trail.adopted ? "adopted" : "built"} — ` +
					`${equipped === "" ? "(default)" : equipped}`,
			);
		}

		this.setPromptEnabled(ball, false);

		// The weld, and the one thing about a held ball the factory deliberately left alone: it is
		// configured for the hand, but being *in* it is this service's business.
		const grip = new Instance("WeldConstraint");
		grip.Name = GRIP_NAME;
		grip.Part0 = hand;
		grip.Part1 = ball;
		grip.Parent = ball;

		this.heldBalls.set(model, { ball, trail });

		// **The hand is full again, so the armed power is whatever this ball carries** — nothing for an
		// ordinary hand-out or a caught ball (a caught mark is cleared above), and a dev's arm when the ball
		// this arrived with picked one up. See `syncArmedPower`, of which this is the site that covers both
		// of the ways a power becomes armed without a press.
		this.syncArmedPower(model);

		return true;
	}

	/**
	 * Makes `ball` a `<kind>` ball: writes the ability on it, and puts the effects that belong to that
	 * ability on or off it.
	 *
	 * **Why this exists.** The attribute is the ability's only record — every gameplay reader goes
	 * through `abilityOn` — and the aura is that same fact said out loud to the players standing nearby.
	 * They are two halves of one statement, so they are written in one place. A caller that set the
	 * attribute and forgot the aura would leave a marked ball that looks ordinary; a caller that did the
	 * reverse would leave a ball glowing with nothing behind it. Neither is a state anything downstream
	 * would catch, because both look like a working ball from inside the code and neither does from
	 * across the arena.
	 *
	 * **Only Freeze has anything to attach today**, which is why the question is a plain test and not a
	 * `switch` waiting for company: `isBallAbility` already owns the list of which abilities exist, so
	 * this reads it rather than keeping a second copy that could disagree with it. A second ball ability
	 * with an effect of its own adds one branch here and gets both of its sides — on and off — at once.
	 *
	 * `""` means "no ability", the same empty-string spelling `makeInert` gives `ThrowerId` and the one
	 * the mark handler puts on a ball for a clear.
	 */
	private setBallAbility(ball: BasePart, kind: AbilityKind | ""): void {
		ball.SetAttribute(BALL_ABILITY_ATTRIBUTE, kind);

		if (kind === "Freeze") {
			// **The flash first, then the aura, and the order is the sequence the player sees.** The flash is
			// the *moment* — the ball flaring is what says the press landed — and the aura is the *state* that
			// then persists. Reversed, the ball would already be glowing before it reacted.
			this.freezes.flashActivation(ball);
			this.freezes.attachAura(ball);
		} else {
			this.freezes.detachAura(ball);
		}
	}

	/**
	 * **Puts the authored Pierce trail on `ball`: clone the template out of `ReplicatedStorage`, hold it on
	 * the ball with a `WeldConstraint`, and let the ball's own lifetime be the effect's.**
	 *
	 * **Why a weld rather than parenting alone.** A child of a moving part does not move with it — Roblox
	 * has no transform inheritance between a part and its children — so a clone parented to the ball would
	 * sit in the air at the throw's launch point while the ball flew away, which is a surprisingly quiet
	 * failure: the effect exists, it emits, and nothing is wrong with it except that it is in the wrong
	 * place for ever. A `WeldConstraint` is the engine's own answer to "these two parts are one object":
	 * with `Part0 = ball` and `Part1 = effect` it locks the *relative* offset the two had at the moment the
	 * weld was parented, and from then on the effect follows the ball's position and rotation exactly — the
	 * solver moves one assembly, so the trail cannot lag a frame behind the ball, which is what a
	 * `RunService.Heartbeat` re-parent would do.
	 *
	 * **And it is a `WeldConstraint` rather than a `Motor6D` or a rigid `Weld`.** A `Motor6D` exists to be
	 * *animated* — it carries a `Transform` a rig's joints write — and nothing wants to move this effect
	 * relative to its ball. A `Weld` welds the *parts'* surfaces at a `C0`/`C1` offset, which means a
	 * rotation authored between them, which is one more number to get wrong in a file that has no opinion
	 * about how the effect is oriented. The constraint is the one that says only what is true here: keep
	 * these two where they are, together.
	 *
	 * **Five properties, and every one of them is about not changing how the ball flies.** An effect
	 * welded to a projectile joins the projectile's **assembly**, and an assembly is what the solver
	 * integrates — so a part that is `Anchored` would pin the ball in place, a part with mass would make the
	 * ball heavier than the plan, the aim guide and `launchCorrection` all assume it is, and a part that
	 * collides or answers queries would turn a ball that passes through people into a ball that hits them.
	 * Hence: `Anchored = false` (a template sitting in `ReplicatedStorage` is usually anchored, and the weld
	 * would be silently undone), `Massless = true`, `CanCollide = false`, `CanTouch = false` and
	 * `CanQuery = false`. **`Massless` is the one worth knowing about**: without it the throw's trajectory
	 * changes the moment a Pierce ball is thrown, and nothing in this file would be able to tell you why.
	 *
	 * **The part is moved onto the ball before the weld is made.** A `WeldConstraint` holds the offset the
	 * two parts had when it was parented, and the template's own position in `ReplicatedStorage` means
	 * nothing relative to a ball at the other end of the map — so the clone is placed at the ball's
	 * `CFrame` first, and the weld then locks *that* (a zero offset). Anything the author offset inside the
	 * template travels with the template's own hierarchy: an `Attachment`'s position, a second part welded
	 * to the first, and the emitter's `EmissionDirection` are all relative to the part, and none of them are
	 * touched here.
	 *
	 * **Parented to the ball, and that is the cleanup.** The ball is destroyed by a round ending, by
	 * `removeBall`, and by a ball expiry — three routes, one place to undo the effect, and the copy goes
	 * with the instance. A ball is *also* reused (thrown, caught, thrown again), which is why the effect is
	 * taken off explicitly when a throw ends rather than only at the ball's death; see
	 * {@link detachPierceEffect}.
	 */
	private attachPierceEffect(ball: BasePart): void {
		// **One effect per throw, so any older one goes first.** Both ordinary routes out of a throw detach
		// already, so this line is about the route nobody has thought of yet: a ball that reaches a second
		// Pierce throw still wearing the first trail's copy would be a ball with two emitters on it, which
		// is a denser effect rather than an error, and would be almost impossible to attribute to this
		// method from a screenshot.
		this.detachPierceEffect(ball);

		// **By name, through the whole of `ReplicatedStorage`** — see `PIERCE_EFFECT_NAME`, `shared/find.ts`
		// and `HANDOFF.md` §17: the contract with an authored template is its name, and where it sits (a `VFX`
		// folder, an `Effects` folder, or no folder at all) is a thing a person moves. The helper resolves a
		// name on the part, on the attachment inside it, or on the emitter inside that, to the part to clone.
		const template = findTemplate(ReplicatedStorage, PIERCE_EFFECT_NAME);

		// **Said once per name, and with everything the reader needs to fix it.** The fix is a Studio job, so
		// the line names the template, says what shape it has to be, and then lists what `ReplicatedStorage`
		// actually holds — because "no template" is true of a name that is absent, a name that is misspelt and
		// a template that was never published, which are three different fixes and one indistinguishable
		// symptom. Everything after this returns quietly: a Pierce ball with no trail still flies, still
		// passes through bodies and still tags them, so this is not a fault that should stop a throw.
		if (template === undefined) {
			if (!reportedMissingTemplates.has(PIERCE_EFFECT_NAME)) {
				reportedMissingTemplates.add(PIERCE_EFFECT_NAME);

				logWarn(`[VFX] no ${PIERCE_EFFECT_NAME} in ReplicatedStorage — the Pierce trail will not play`);

				const top: string[] = [];
				for (const child of ReplicatedStorage.GetChildren()) top.push(`${child.Name} (${child.ClassName})`);

				logWarn(
					`[VFX] ReplicatedStorage holds: ${top.isEmpty() ? "nothing" : top.join(", ")} — ` +
						`a template is a BasePart carrying an Attachment and a ParticleEmitter, ` +
						`and it is found by name wherever it sits.`,
				);
			}

			return;
		}

		const effect = template.Clone();
		const part = effectPartOf(effect);

		// A template with no part in it cannot be welded to anything, and cloning a fresh copy every throw
		// that is immediately thrown away would be a leak with a warn attached.
		if (part === undefined) {
			if (!reportedMissingTemplates.has(PIERCE_EFFECT_NAME)) {
				reportedMissingTemplates.add(PIERCE_EFFECT_NAME);

				logWarn(
					`[VFX] ${PIERCE_EFFECT_NAME} has no BasePart in it — the Pierce trail will not play. ` +
						"The template is cloned and welded by its part.",
				);
			}

			effect.Destroy();

			return;
		}

		// **Before it joins the ball's assembly, not after** — see this method's doc for what each one is
		// protecting. Set on the clone, so the template in `ReplicatedStorage` is left as its author built
		// it and the next throw starts from the same state.
		part.Anchored = false;
		part.Massless = true;
		part.CanCollide = false;
		part.CanTouch = false;
		part.CanQuery = false;

		// The effect sits on the ball, and the weld locks that in. Placed before parenting so the part is
		// never briefly somewhere else in the world — and `CFrame` rather than `Position` because the
		// template's own rotation is not a fact about the ball.
		part.CFrame = ball.CFrame;
		effect.Parent = ball;

		// **The weld last, with its parts assigned before it is parented.** A `WeldConstraint` that enters
		// the tree with a `Part0` or `Part1` still unset is a constraint on nothing, and one parented before
		// its parts are placed would lock the offset they had at that instant. Assigning both first and
		// parenting once is the order that cannot go wrong.
		const weld = new Instance("WeldConstraint");
		weld.Name = PIERCE_WELD_NAME;
		weld.Part0 = ball;
		weld.Part1 = part;
		weld.Parent = part;
	}

	/**
	 * **Takes the Pierce trail off `ball`: the one line every route out of a throw ends on.**
	 *
	 * The effect is a child of the ball, so a destroyed ball takes it with it and needs nothing. Everything
	 * else does, because **a ball outlives its throws**: it is caught, put back in a hand, and thrown again
	 * as an ordinary ball, and a trail that survived that would be a Pierce effect on a ball that carries no
	 * Pierce — the visual half of an ability the gameplay half has already cleared. There are three exits,
	 * and each is someone else's moment:
	 *
	 * - **The end of a throw** — the world-contact branch in `BallComponent`, which is where `Armed` goes
	 *   off and every tag resolves. That is the throw's death, and a trail whose throw is over is a trail
	 *   emitting on a ball lying on the floor.
	 * - **A ball arriving in a hand** — `attachToHand`, beside `CollisionIgnore.clear`: a caught ball never
	 *   touches the world, and this is the moment it stops being a throw.
	 * - **Another Pierce throw** — {@link attachPierceEffect} clears the old copy before making a new one.
	 *
	 * Public because the first of those is `BallComponent`'s to see and this service is already injected
	 * there; the other two are this file's own.
	 */
	public detachPierceEffect(ball: BasePart): void {
		ball.FindFirstChild(PIERCE_EFFECT_NAME)?.Destroy();
	}

	/**
	 * How far in front of `model` a dropped ball can be placed, in studs.
	 *
	 * {@link BALL_CONFIG.DROP_DISTANCE} is a **maximum**, not a promise. A character facing a
	 * wall would otherwise put its ball down inside the wall — or, through a thin one, on the
	 * far side of it — and the only thing the engine can do with a part left inside geometry
	 * is shove it somewhere nobody chose. So the same length is cast first and the ball goes
	 * short of whatever that finds. Nothing else about the drop changes: the ray can only
	 * shorten it.
	 *
	 * Two things are excluded, and they are the two the ray must not find: the dropper, whose
	 * own body is between the origin and everything else, and the ball itself — which is
	 * already out of the model and lying where the hand was, so it is a thing in front of the
	 * character like any other. Everything else in the way is the answer being looked for.
	 */
	private dropReach(model: Model, ball: BasePart, origin: Vector3, direction: Vector3): number {
		const params = new RaycastParams();
		// **`ExcludeInstances` rather than the deprecated `FilterType`/`FilterDescendantsInstances` pair**,
		// which is how every other filter in the project is written — `shared/throw.ts` carries the
		// argument, and `roundZone.ts` the one case where the old spelling was kept and why it no longer is.
		params.ExcludeInstances = [model, ball];
		params.IgnoreWater = true;

		const hit = Workspace.Raycast(origin, direction.mul(BALL_CONFIG.DROP_DISTANCE), params);
		if (!hit) return BALL_CONFIG.DROP_DISTANCE;

		// Just short of what was found, and never inside the dropper: a wall closer than the
		// clearance would otherwise put the ball back inside the body it came out of, which is
		// the one place it must not be.
		return math.max(DROP_CLEARANCE, hit.Distance - DROP_CLEARANCE);
	}

	/**
	 * Turns the ball's pickup prompt off while it is held, and back on when it is
	 * thrown.
	 *
	 * Nothing creates a prompt today — `BallPickupService` collects a ball by walking
	 * over it rather than by offering one — so this does nothing yet. The hook is here
	 * so that a ball which grows one is still only offered while it is lying on the
	 * ground.
	 */
	private setPromptEnabled(ball: BasePart, enabled: boolean): void {
		const prompt = ball.FindFirstChildWhichIsA("ProximityPrompt");
		if (prompt) prompt.Enabled = enabled;
	}

	private createThrowRemote(): RemoteEvent {
		const folder = this.findOrCreateFolder(ReplicatedStorage, REMOTES.folder);
		return this.findOrCreateRemote(folder, REMOTES.throwBall);
	}

	private findOrCreateRemote(parent: Instance, name: string): RemoteEvent {
		const existing = parent.FindFirstChild(name);
		if (existing?.IsA("RemoteEvent")) return existing;

		const remote = new Instance("RemoteEvent");
		remote.Name = name;
		remote.Parent = parent;
		return remote;
	}

	private findOrCreateFolder(parent: Instance, name: string): Folder {
		const existing = parent.FindFirstChild(name);
		if (existing?.IsA("Folder")) return existing;

		const folder = new Instance("Folder");
		folder.Name = name;
		folder.Parent = parent;
		return folder;
	}

	/**
	 * Throws whatever `model` is holding, **as `request` states it** — charged for a player, aimed at a point
	 * for a rig.
	 *
	 * Keyed on the **model**, so an NPC's throw is this function with a different model and a different
	 * request in it rather than a second copy of the throw. A `Player` is still around, but never as the
	 * thing being thrown from: the remote handlers in {@link onStart}, the charge and MultiBall
	 * bookkeeping — which belongs to a player rather than to a body — and the dev check that lets a
	 * flagged dev throw with an empty hand.
	 *
	 * **The two kinds of throw meet here and part again two lines later**, which is where the "one solve,
	 * both sides" property is easiest to check: the request is branched on at the single line that solves a
	 * plan, and each arm names the function it calls. Everything around that line — the freeze gate, the
	 * hand, the release of the ball, the correction, the nudge, the colours, the acceleration — is common to
	 * both, because those are facts about *this* thrower and *this* ball rather than about how the throw was
	 * aimed.
	 *
	 * **Throwing empties the hand.** A ball comes from a pickup, from a catch, or from
	 * a MultiBall window's refill — and, for a dev with `InfiniteBalls`, from the
	 * throw they just made. Everyone else fetches the next one, which is what the loose
	 * balls on the floor are for.
	 *
	 * Returns whether a ball went. An empty hand is not an error: a behavior may
	 * ask while there is nothing to throw.
	 */
	public throwBall(model: Model, request: ThrowRequest, claimedLaunch?: Vector3): boolean {
		// Scope: BallService.throw — the release itself, gates and trail arming included.
		if (DEBUG_CONFIG.PROFILE) debug.profilebegin("BallService.throw");
		const thrown = this.throwBallBody(model, request, claimedLaunch);
		if (DEBUG_CONFIG.PROFILE) debug.profileend();

		// **The round's badge count, and only for a throw that actually left.** `throwBallBody` answers `false`
		// for a frozen body, a ducking one and an empty hand, and a rig asks on a tenth-of-a-second timer — so
		// counting the *attempt* would give every frozen rig a throw a tick and make `sprayAndPray` fire on
		// bodies that never released anything. Here rather than inside the body because this is the one line
		// that knows the answer, and it is outside the profile band because it is one increment rather than
		// part of the release.
		if (thrown) this.badges.recordThrow(model);

		return thrown;
	}

	/**
	 * The body of {@link throwBall}, split off **only** so the scope above can wrap it.
	 *
	 * **Why a second method rather than the pair written into the body.** Three `return false` gates sit
	 * between the top of the original and any work at all — frozen, ducking, empty hand — so a `profileend`
	 * at the bottom would be reached only by a throw that actually happened, and every refused throw would
	 * leave the MicroProfiler holding an open band. The split makes the pairing structural instead of a
	 * thing to remember, and this is the method most likely to grow a fourth gate later.
	 *
	 * **The scope covers the whole release**, including `task.delay` for the throw mark and the trail arming
	 * — `task.delay` schedules and returns, so nothing here yields and the `profileend` is always reached in
	 * the same resumption. The only `task.wait` in this file is the settle loop's, far below this method.
	 *
	 * **`trajectory` work is not included**: nothing in this method computes an arc. A rig's aim is
	 * `SeekBehavior`'s and its launch point is `ThrowBehavior`'s, which is why a recording that shows a wide
	 * `BallService.throw` is pointing at the release rather than at the aiming.
	 */
	private throwBallBody(model: Model, request: ThrowRequest, claimedLaunch?: Vector3): boolean {
		// **A frozen body does not throw, and the gate is here rather than on the remote.** `throwBall` is
		// the only thing in the game that throws — a player's click and a rig's behavior both arrive here,
		// which is `ActionService`'s own note about where a throw gate belongs — so a check in the remote
		// handler would leave a frozen NPC throwing at whatever it happened to be facing.
		//
		// **That is the rule for a refusal that is a fact about a body, and the one exception is a fact about
		// the round.** The celebration's refusal — a decided round takes no throw from a player — sits on
		// `throwForPlayer` instead, because the shared path cannot tell an arena NPC from a practice bay's
		// drill and ten seconds of a stalled drill is not a price an unrelated round should cost. See it there.
		//
		// It answers `false`, which is the same answer an empty hand gets. That matters twice: a behavior
		// asking on a timer does nothing with either, and `throwForPlayer` spends the charge only when a
		// ball actually left — so a frozen player loses nothing for the throw they could not make.
		if (this.freezes.isFrozen(model)) {
			logDebug(`[Ball] ${model.Name}: throw refused — frozen`);

			return false;
		}

		// **A ducking body does not throw, and the gate is here for the freeze gate's reason above.** A duck is
		// a *committed stance* — that is the whole trade the mechanic makes — so the body that ducks has given
		// up its throw for the duration along with its walk. The gate is read off the body's published
		// attribute rather than through an injected `DuckService`, which is the same choice `BallComponent`
		// makes: the attribute is written by the one service that owns the duck, it is authorless from a
		// client's point of view, and it is the fact both halves of the exemption already read. One writer,
		// three readers, no second copy of the state.
		if (model.GetAttribute(DUCKING_ATTRIBUTE) === true) {
			logDebug(`[Ball] ${model.Name}: throw refused — ducking`);

			return false;
		}

		const held = this.heldBalls.get(model);
		if (!held || held.ball.Parent !== model) return false;

		const ball = held.ball;

		// Release the ball from the hand before launching it.
		ball.FindFirstChild(GRIP_NAME)?.Destroy();
		// **And the aura comes off with the grip, which is what makes it mean "in a hand".**
		//
		// The aura and the trail below are the two indicators, and they are for two states: the aura says
		// *loaded and held*, the trail says *in flight*. This is the one moment both change, so it is the
		// one moment both are written — the trail arms and the aura goes. A ball that kept its aura here
		// would wear two effects into the air, and the flight indicator, which is the one that bends with
		// the arc, would be the harder of the two to read.
		//
		// The ability itself is deliberately *not* cleared: it is read off the ball at the moment of
		// impact, so it has to survive the whole throw. Only the picture of it comes off.
		this.freezes.detachAura(ball);
		// Armed and attributed at the moment of release rather than when the ball
		// was made: a caught ball has been through somebody else's hand since, and
		// this throw is what decides whose ball it is now. The immunity check and
		// the catch check both read this one token.
		ball.SetAttribute("Armed", true);
		ball.SetAttribute("ThrowerId", this.tokenOf(model));

		// **And the side the thrower was on at the release**, stamped here rather than at the factory beside
		// `Armed` and `ThrowerId`, and overwritten on every throw for the reason those two are: a caught ball has
		// been through somebody else's hand since, and this throw is what decides whose ball it is now. The one
		// reader is `DodgeService.watchForPerfectDodge`, which has to tell an enemy's pass from a teammate's —
		// a friendly contact writes no tag, so the tag list cannot answer it. See
		// `BALL_THROWER_SIDE_ATTRIBUTE` for why the label is a copy on the ball rather than a read of the body.
		//
		// **`sideOfBody` rather than the attribute directly**, because a player's `TEAM_ATTRIBUTE` is on the
		// `Player` and `model` here is the character. It answers `undefined` for a body with no side, which is
		// written as `""` — the value that means "no side at the throw" rather than "unknown".
		ball.SetAttribute(BALL_THROWER_SIDE_ATTRIBUTE, this.sideOfBody(model) ?? "");

		// **And whether it came out of a practice bay, which decides where it dies.** A drill's ball is destroyed the
		// first settle turn it is outside every `practiceBay` — see `settleLooseBalls` — and the fact is written here,
		// at the release, because this is the one line in the game where a ball leaves a hand.
		//
		// **Written for *every* throw rather than only for a drill's, and the `else` is the load-bearing half.** A ball
		// is legitimate property: a player can pick a drill's ball up and throw it, and a marker that was only ever set
		// would follow that ball out of the bay and kill it in the arena. Clearing it on a throw by a body without the
		// tag is what makes the fact belong to *this throw* rather than to the ball's history — the same reason
		// `Armed` and `ThrowerId` are re-stamped two lines up rather than written once at the factory.
		//
		// **`true` rather than a bay reference**, because the question the sweep asks is only "is this ball subject to
		// the bay rule", and `insideAnyBay` answers the rest from the world it can see. Storing which bay it left would
		// be a second source of truth for geography, free to go stale the moment somebody moves a bay part.
		if (model.HasTag(PRACTICE_THROW_TAG)) ball.SetAttribute(THROWN_FROM_BAY_ATTRIBUTE, true);
		else if (ball.GetAttribute(THROWN_FROM_BAY_ATTRIBUTE) !== undefined) {
			ball.SetAttribute(THROWN_FROM_BAY_ATTRIBUTE, undefined);
		}

		// **And the body is marked as mid-throw, which is what the throw's own clip is played from.** This is
		// the moment the file already calls "the release", and it is the only place in the game a ball leaves a
		// hand — a player's click and a rig's behavior both arrive at this method — so one mark here covers every
		// body that throws. **The clip is drawn by the client that owns the body**, which is the same client for
		// a player's character and *every* client for a rig: the server writes the fact and loads no track at
		// all. It used to load one for a player, and that is gone — see the note above `THROW_ANIMATION_SECONDS`
		// in `ball.config.ts` and `client/controllers/character/BodyAnimator.ts`, which is the renderer both
		// bodies share.
		//
		// **Cleared on a timer rather than when the ball lands.** The mark means "this body is in the middle
		// of the throw *motion*", which is over long before the ball is; a mark that lasted the flight would
		// leave a rig mid-throw for a second and a half. See `THROW_ANIMATION_ATTRIBUTE` for the pair it forms
		// with the ball-in-hand state, and `BALL_CONFIG.THROW_ANIMATION_SECONDS` for the length and why it is
		// a tuned number rather than the clip's own.
		const throwMark = (this.throwMarks.get(model) ?? 0) + 1;
		this.throwMarks.set(model, throwMark);
		model.SetAttribute(THROW_ANIMATION_ATTRIBUTE, true);

		// **The window is the clip's own remaining length, and it stopped being a function of the charge.**
		// The clip was held at its wind-up for the charge and then played at `charge ×` normal speed, so the
		// motion used to need `0.63 / speed` seconds after the release. It now plays at `1×` for every throw —
		// the charge is carried by the camera while the button is held instead — so the mark lasts exactly as
		// long as the clip's motion, and `throwAnimationWindowSeconds` is the single place that says so. The
		// arithmetic still lives in `shared/animation.ts` so the client playing the clip and this mark cannot
		// disagree about it, and the `max` keeps `THROW_ANIMATION_SECONDS` as a floor for a clip that is
		// somehow shorter than the constant.
		//
		// **This is the only server-side change the hold needed, and it is not enforcement of the animation.**
		// The client still decides everything visual; what this buys is that the mark is up for as long as the
		// motion it authorises.
		const animationWindow = math.max(BALL_CONFIG.THROW_ANIMATION_SECONDS, throwAnimationWindowSeconds());

		task.delay(animationWindow, () => {
			// A newer throw owns the mark by now; its own timer is the one that clears it, so this leaves the
			// attribute alone rather than cutting a later throw's window short.
			if (this.throwMarks.get(model) !== throwMark) return;

			this.throwMarks.delete(model);
			model.SetAttribute(THROW_ANIMATION_ATTRIBUTE, undefined);
		});
		this.setPromptEnabled(ball, true);
		// Airborne now, so the rod can start drawing behind it. Absent when the trail is
		// switched off in config, which is the whole of what that flag does at runtime.
		//
		// **And the colours are read again here rather than taken from what the hand-off stored.** The attach
		// in `attachToHand` stated them when the ball arrived in this hand; a player who equips a trail *while
		// already holding a ball* chose after that moment, and a throw that trusted the stored copy would fly
		// the colours the ball was picked up with. The owner is resolved from the body because that is the only
		// way it is resolvable here: `throwForPlayer` knows the `Player` and hands this method a character, and
		// the hand's own record holds no owner. A rig answers `undefined`, which is the default, which is what
		// a rig's ball should be. A repaint of the live trail, never a rebuild — see `BallTrail.setColors`.
		held.trail?.setColors(this.economy.equippedTrailColors(model));
		held.trail?.setArmed(true);

		// The client runs this exact same plan to draw its aim guide, so the throw
		// and the predicted arc can never disagree — which only holds while both
		// sides solve from the same launch point, see `acceptLaunch` and, for the charged arm,
		// `planChargedThrow` itself.
		//
		// **The one branch in the whole throw, and it is deliberately two lines wide.** A charged throw is
		// solved from a heading and a power — which is everything the wire carries *and* everything a rig's
		// behavior builds now, so this is the arm every throw in the game takes — while the aimed one is solved
		// from a point and one of the three named arcs. See `ThrowRequest` for why the two are still tagged
		// rather than guessed at, and `shared/throw.ts` for why there are two solves at all.
		const releasePosition = ball.Position;
		const ownLaunch = getThrowMuzzle(model);
		const launch = this.acceptLaunch(ownLaunch, claimedLaunch);
		const plan =
			request.kind === "charged"
				? planChargedThrow(model, request, launch)
				: planAimedThrow(model, request.target, request.arc, launch);

		// What actually goes on the ball: the solve, plus the correction that covers the engine's own
		// loss. It is derived from this machine's gravity, physics rate and — for a curve — the pull
		// the plan gave it, rather than fixed: see `BALL_CONFIG.THROW_VERTICAL_BOOST_SCALE` for the
		// derivation, and `launchCorrection` for why it is read on every throw and why the pull is an
		// input to it. The guide draws the solve, so this is what makes the ball fly the drawn line
		// instead of sagging below it, and on a curve instead of bowing wider than it.
		const correction = launchCorrection(plan.acceleration);
		const commanded = plan.velocity.add(correction);

		// **The one tune that does not also move the aim guide.** See `THROW_LAUNCH_NUDGE`: it is applied
		// to the ball's starting point and nothing else, in the throw's own frame, because that is the
		// frame a miss is measured in — `forward` is the line the ball is thrown along, `left` is the axis a
		// curve bows on, `up` is world up. Untouched when all three are zero, so the zero case is the launch
		// the plan asked for, exactly.
		//
		// **The frame is taken from the throw rather than from a mark, and the charged throw is why.** It used
		// to be `leftAxis(origin, target)`, which needs a target; a charged throw has none, and inventing one
		// here to keep the old expression would have been a point with no meaning feeding a dial nobody has to
		// touch. The line the ball actually leaves along is the honest axis for both kinds — and for a charged
		// *curve* it is strictly better, because `left` is meant to be the axis the bend is on and the
		// slung-wide launch is where that axis really lies.
		const nudge = launchNudge();
		const nudged = nudge.forward !== 0 || nudge.left !== 0 || nudge.up !== 0;

		const line = new Vector3(plan.velocity.X, 0, plan.velocity.Z);
		const forward = line.Magnitude > 0.001 ? line.Unit : new Vector3(0, 0, -1);
		const mark = plan.origin.add(forward);

		const placement = nudged
			? plan.origin
					.add(forward.mul(nudge.forward))
					.add(leftAxis(plan.origin, mark).mul(nudge.left))
					.add(new Vector3(0, nudge.up, 0))
			: plan.origin;

		// **What the log calls this throw.** A rig's throw is named by its arc, which is still what a reader
		// greps for; a player's is named by the charge, because that *is* its shape — a charged throw has no
		// arc to name (see `LaunchPlan.arc`) and the power is the number worth comparing between two throws.
		// The angle and the speed are two fields along, in `describeThrow`.
		const label =
			request.kind === "charged"
				? `charged ${string.format("%.2f", request.charge)}${request.curve ? " bend" : ""}`
				: `${request.arc}`;

		// **Gated on `DEBUG_LOGGING`, and that gate is the fix for the log volume measured on 2026-10-17.** This
		// file's always-on lines are the *lifecycle* ones — who threw, who caught, what ended on a part — and those
		// are the ones worth having. This block is not one of them: it is a per-throw measurement of eight
		// `string.format`s, `describeThrow` and `describeMuzzle`, and `describeMuzzle` walks the model to find the
		// torso and head. With eight rigs throwing, that is two or three of these a second, forever. It used to sit
		// behind this file's own `const DEBUG`, which meant `VERBOSE_LOGS: false` did not touch a single one of them
		// because the flag was read here and set elsewhere; `DEBUG_LOGGING` is that config value *and* the Studio
		// check, so there is one switch again.
		//
		// **What is kept, because it is not diagnostic.** Everything outside this block runs regardless — the
		// collision ignore, the trail, the armed token, the network owner — so silencing the line changes what
		// the log says and nothing about what the throw does.
		//
		// **The `at N fps` number goes with it, which is a real loss and is noted rather than hidden:** it is
		// `Workspace:GetRealPhysicsFPS()`, the server's actual physics-step rate, and the 2026-10-17 log caught
		// the server at 29–46 of them during a rig-heavy stretch. Turning `DEBUG_CONFIG.VERBOSE_LOGS` back on for one
		// run is how the next frame-time reading is taken — see `debug.config.ts`.
		if (DEBUG_LOGGING) {
			// Both halves of the correction, and only the second one is ever zero for a reason: a
			// straight throw's line has no pull in it, so its log line is the one it always was.
			const curvePull = new Vector3(correction.X, 0, correction.Z).Magnitude;
			const curve = curvePull > 0.001 ? `, curve pull ${string.format("%.3f", curvePull)}` : "";

			// Only when it is doing something, and that is the exception rather than the rule here: the
			// nudge is a dial somebody turned, not a measurement that has to be distinguishable from a
			// missing one. A launch that reads `0.00/0.00/0.00` is the plan's own.
			//
			// Hoisted rather than interpolated, for `BallComponent.logTouch`'s reason — a template
			// literal nested inside another renders a hole. `(attribute)` names the source, because a
			// nudge living on the live dial is in nobody's repository and has to say so.
			const source = nudge.live ? " (attribute)" : "";
			const tuned = nudged
				? `, nudge ${string.format("%.2f", nudge.forward)}/${string.format(
						"%.2f",
						nudge.left,
					)}/${string.format("%.2f", nudge.up)}${source}`
				: "";

			logInfo(
				`[Ball] ${model.Name}: ${label} ${this.describeThrow(plan, commanded)}, ` +
					`release ${releasePosition} -> launch ${plan.origin}` +
					` (${string.format("%.2f", launch.sub(ownLaunch).Magnitude)} studs from our own)` +
					` | muzzle ${describeMuzzle(model)}` +
					` | boost ${string.format("%.3f", correction.Y)}${curve}` +
					` at ${string.format("%.0f", physicsRate())} fps${tuned}`,
			);
		}

		// The thrower can never be hit by their own ball. Without this, a throw
		// aimed back across the body clips it, and the engine resolves that
		// overlap the only way it can — by shoving the player. Ball size and
		// muzzle distance only ever changed how hard that shove was.
		CollisionIgnore.between(ball, model);

		// **And every body in the world, before this ball exists at all — which is the entire point of doing
		// it here rather than where the contact is discovered.**
		//
		// Every body, and not every *enemy*: a teammate who wandered into the line used to stop the ball,
		// and being cancelled by somebody on your own side is not a rule anybody can predict or enjoy. See
		// {@link pierceBodies}, which is where that decision and what it costs are written down.
		//
		// A Pierce ball has to go *through* the bodies it hits. The obvious place to arrange that is the
		// tag branch in `BallComponent`, where the contact is known — and that is the wrong place, for a
		// reason that is invisible in the source: **`Touched` is reported after the engine has already
		// resolved the contact.** So a `NoCollisionConstraint` created inside that handler is created
		// after the deflection it was meant to prevent has already been written to the ball's velocity.
		// It stops the *next* contact with that body, which is worth nothing, because the throw has
		// already been turned by the first one. The constraint has to be in place before the two parts
		// ever meet, and the last moment at which that is true is here.
		//
		// **`BallComponent`'s tag branch still sets one, and that is deliberate for now**: it is a
		// backstop, so that a run which still deflects can be told apart from one where this set-up
		// failed. It is redundant with the loop below and **comes out in the next change**, once this is
		// verified in Studio — two answers to one question is not a state to leave the file in.
		//
		// **What this relies on, stated because the ability is worthless without it: `Touched` has to
		// keep firing for a pair whose collision has been taken away.** That event is how `handleTouch`
		// learns the ball met this body, and therefore how the body is *tagged* — so if a constraint also
		// silenced `Touched`, a Pierce ball would sail through every enemy and tag nobody, which is a
		// different failure rather than a smaller one. Collision and touch are separate things in the
		// engine — `CanTouch` exists precisely because a non-colliding part still fires `Touched` — but
		// whether a `NoCollisionConstraint` sets both is not something this repository can read out of
		// the typings. So it is checked in the log rather than assumed here: two enemies in a line should
		// print two `was tagged by` lines.
		// **Which bodies this ball may not be stopped by — two policies, one loop.**
		//
		// A Pierce ball goes through *every* body (see {@link pierceBodies} for that argument and the cover it
		// costs); every other ball goes through the thrower's **teammates**, and only through them. The second
		// policy is the same complaint the first one answers, arriving at a smaller scale: a teammate who
		// wandered into the line used to stop the ball dead, and being cancelled by somebody on your own side
		// is not a rule a player can predict or enjoy. **An enemy still stops both**, which is what keeps this
		// from being "balls pass through people".
		//
		// **The mechanism is the one already here, so the loop is shared rather than written twice** — a
		// `NoCollisionConstraint` per part, in place before the first contact. The paragraph above says why it
		// cannot be done in the tag branch instead.
		const pierce = abilityOn(ball) === "Pierce";
		const bodies = pierce ? this.pierceBodies(model) : this.teammateBodies(model);

		for (const body of bodies) CollisionIgnore.between(ball, body);

		if (pierce) {
			// **And the trail, from the same test and at the same moment.** The two halves of a Pierce throw
			// are the same fact read once: the collision ignores are what the *contact* solver is told, and
			// this is what the *player* is told, so a branch that set one up and not the other would be a
			// throw that behaves like Pierce and looks ordinary — or, worse, a mark the shot never carried.
			// It is attached here rather than at the mark because the effect belongs to the flight: a ball
			// marked and never thrown should not be trailing particles around a hand, and a ball marked and
			// then thrown twice should wear the trail once, per throw.
			this.attachPierceEffect(ball);

			if (DEBUG_LOGGING) {
				logInfo(
					`[Ball] ${model.Name}: Pierce — set up to pass through ` +
						`${bodies.size()} ${bodies.size() === 1 ? "body" : "bodies"}`,
				);
			}
		}

		// Move the ball, hand it to this machine's solver, and arm it — all inside
		// the one frame.
		//
		// Every line of this used to be spread across `task.delay(0)`, which left
		// the ball non-colliding, massless and unforced for a physics step. That
		// step's length depends on the frame, so the ball had a window it could
		// pass through something by, and a different-sized one every throw — the
		// exact shape of "it does not land in the same place twice".
		//
		// The old reason for the delay was that a solid ball still sitting in the
		// hand got the thrower shoved. `CollisionIgnore` above settles that
		// structurally: the ball cannot collide with its thrower's body at all, so
		// being close to the hand for a frame no longer matters.
		ball.CanCollide = false;
		// `placement` rather than `plan.origin`: the same point unless `THROW_LAUNCH_NUDGE` has been
		// turned, which is the one dial downstream of the plan — see where it is computed above.
		ball.Position = placement;
		ball.Parent = Workspace;

		// The ball was welded into the character, so it belonged to the thrower's
		// client's physics — and that machine was the one simulating it, including
		// the frame it was released on. Called with no argument the server takes it
		// back, so the whole flight is simulated in one place.
		ball.SetNetworkOwner();

		// **And whether it took, asked a frame later rather than here.** See `reportOwnership`: this is
		// the only place in the project that can tell whether the flight being watched is stepped by the
		// machine that derived the boost, and no other number in the log can answer it.
		if (DEBUG_LOGGING) this.reportOwnership(ball, model);

		ball.AssemblyLinearVelocity = commanded;

		// **The ball has left the hand, so the throw sound plays at the launch point.** This is the
		// moment it is given velocity — the last instant it is in the hand and already the first instant
		// it is not — and the ball is where `placement` put it, so it is asked for its own `CFrame`
		// rather than the plan's. `plan.origin` is the intent; a turned `THROW_LAUNCH_NUDGE` moves the
		// ball and deliberately not the plan, so the ball is the honest answer of the two.
		//
		// Ungated, like the other three: `emitSound` puts its log line behind `VERBOSE_LOGS` and never
		// the sound. The emitter tidies itself away on the helper's timer, which is the whole of what
		// this call site owes it.
		emitSound(ball.CFrame, model.Name, SOUND_CONFIG.THROW, THROW_EMITTER_NAME);

		// **The gust of air that used to fire from this line is gone**, deleted with `WindBurst.ts` on
		// 2026-10-13 at the user's instruction. It was the second thing at this point — the throw *heard* above,
		// the throw *seen* here — and what replaced it is a Studio-authored template on the thrower's own body,
		// drawn by every client from the throw mark this method writes at the release. See
		// `client/windBurst.ts`, where the effect lives now, and `throwFeedback.config.ts`, which records what
		// went with it and the one lesson it cost to learn.
		//
		// **One property of this call site is worth keeping in mind**: a player's throw and a rig's both arrive
		// here, so a mark written at this point is the one road by which both bodies can be given a visible
		// release. That is why the new effect needs no per-caller flag either.

		ball.CanCollide = true;
		// **And the query half comes back with it**, which is the other end of `attachToHand`'s
		// `CanQuery = false`: from here the ball is a thing in the world, and a sweep is entitled to stop on
		// it rather than passing through it because it used to be in somebody's hand.
		ball.CanQuery = true;
		// **This is what gives the ball its own weight back**, and it has to come before `applyAcceleration`
		// for that function's own reason: both forces are `mass × something`, and a massless ball reads zero
		// and gets nothing. One call sets `Massless` and sizes the ball's gravity together.
		this.factory.setHeld(ball, false);
		this.applyAcceleration(ball, plan.acceleration, plan.flightTime);

		// How far the engine's flight actually is from the plan's, per throw.
		// Behind the verbosity gate as well: the probe watches every throw per frame, and it costs
		// the very frame time it is reporting on. See `shared/config/debug.config.ts`.
		if (DEBUG_LOGGING) watchThrow(ball, plan, model);



		this.heldBalls.delete(model);

		// A thrown ball is on the ordinary clock unless the arena stocked it — see {@link lifetimeOf}, which is
		// where that distinction lives now. The `isHeld` guard inside is what leaves a ball that has been caught
		// since to its new owner. `scheduleBallExpiry` is still the one place a ball's lifetime is decided; what
		// changed is that "the ordinary clock" is no longer the only answer it can be given.
		scheduleBallExpiry(ball, this.lifetimeOf(ball), (expiring) => this.isHeld(expiring));

		// **A ball that has just been thrown is answered by whatever supplies this thrower's next one**,
		// and the two suppliers are asked in a deliberate order: the MultiBall window first, then the dev
		// flag.
		//
		// The window goes first because it is the *player's* purchase and its count is the whole of what
		// they are watching. A dev with `InfiniteBalls` on would otherwise never see the count move, which
		// is exactly the state this ability is most likely to be tested in. The dev flag is the fallback
		// rather than an alternative, which is why it now asks whether the hand is still empty.
		//
		// A window with nothing left in it supplies nothing, and the thrower fetches their next ball off
		// the floor like anybody else: running out ends the supply, not the round.
		this.refillFromBuff(model, true);

		// **And this throw's ball is marked for cleanup unless it closed the window.**
		//
		// **The bug this answers is the arena filling with its own ammunition.** A MultiBall window is
		// `SUPER_CONFIG.MULTI_BALL_BALL_COUNT` throws (5), and before this marker every one of them stayed where
		// it landed — so one window left four spent balls scattered across the floor and the round's own sweep
		// only got them at the end. **Four of the five go; the fifth is the throw that closed the window**, and it
		// is the one a player can walk over and pick back up.
		//
		// **Asked after the refill, because that is where the spend is.** `refillFromBuff` calls
		// `consumeMultiBallBall` and then asks whether the window still holds a throw; this asks the same
		// question one line later, and the answer is "one of the first four" exactly when `isMultiBallActive` is
		// still true. The question is asked here rather than inside `refillFromBuff` because this method is the
		// one holding the ball that was thrown — the helper is handed a body and a flag, not a ball.
		//
		// **`false` is not written; the marker is removed instead.** Absence is the ordinary state and the reader
		// tests `=== true`, so a ball that never had the marker costs nothing. The `else if` is the half that
		// matters for a *re-thrown* ball: one caught and thrown again as somebody's fifth throw still carries the
		// `true` from the throw that marked it, and leaving that alone would destroy the one ball the window was
		// supposed to leave behind.
		const windowOwner = Players.GetPlayerFromCharacter(model) ?? model;

		if (this.abilities.isMultiBallActive(windowOwner)) {
			ball.SetAttribute(BALL_DESPAWN_ON_LAND_ATTRIBUTE, true);
		} else if (ball.GetAttribute(BALL_DESPAWN_ON_LAND_ATTRIBUTE) !== undefined) {
			ball.SetAttribute(BALL_DESPAWN_ON_LAND_ATTRIBUTE, undefined);
		}

		// A dev with `InfiniteBalls` never runs out: the throw they just made is answered
		// with another ball, by the same call the first one arrived by. **The other
		// self-refilling throw is a MultiBall one** — `refillFromBuff` above answers it while
		// the window has throws left — so "every other thrower fetches their next ball" was
		// true before that ability existed and is not true now. It is not the only way in
		// either: switching the flag on gives an empty hand a ball too, which is what a dev
		// who has just thrown their last one actually needs. See the constructor.
		if (this.hasInfiniteBalls(model) && !this.getHeldBall(model)) {
			this.giveBall(model);

			logDebug(`[Ball] ${model.Name}: refilled by InfiniteBalls`);
		}

		// **The throw is the done trigger for a ball-carried power**, and this is the line after the hand has
		// been emptied (and possibly refilled with an ordinary ball). The marked ball is in the air now and
		// carries its ability to whatever it hits — but the *player* is no longer holding a loaded ball, which
		// is the fact the HUD's `READY` text is drawn from. See `syncArmedPower`.
		this.syncArmedPower(model);

		return true;
	}

	/**
	 * Reports who is actually simulating `ball`, from the first `Heartbeat` after it was thrown.
	 *
	 * **The question `SetNetworkOwner` cannot answer for itself, and the one every launch number in this
	 * file is written on top of.** The ball belonged to the thrower's client while it sat in their hand —
	 * it was welded to it — and the call above takes it back so that one machine steps the whole flight.
	 * Which machine matters beyond tidiness: {@link launchCorrection} is derived from *this* server's
	 * measured physics rate and written into the launch, and the loss it corrects is proportional to the
	 * step. A flight stepped by the thrower's client instead runs at a rate the correction was not
	 * computed from, and what the player sees is the ball sitting off the drawn arc by
	 * `(correction − ½·a·dt)·t` — the fault the correction exists to remove, arriving from the other
	 * end, and one that no other line in the game can tell apart from the correction being wrong.
	 *
	 * **Two reads, and the second one is the answer.** The engine applies an ownership change at a step
	 * boundary, so the first read after the request is allowed to still name the client it was taken
	 * from; only a read that *repeats* is a hand-off that did not take. When the first read is already
	 * the server's there is nothing to chase and the second never happens.
	 *
	 * **The line prints either way.** A check that speaks only when it fails cannot be told apart from
	 * one that is not running, which is `ThrowProbe`'s timeout rule as well — so "owned by the server"
	 * is an answer, not silence. `CanSetNetworkOwnership` is asked on the failing path only, and for its
	 * reason: an anchored part and a part outside the workspace are two refusals with two different
	 * fixes, and the engine is the only thing that knows which this was.
	 *
	 * One line per throw, behind `DEBUG_LOGGING`, like the launch line above it. Delete it once the hand-off is
	 * trusted.
	 */
	private reportOwnership(ball: BasePart, thrower: Model): void {
		let frame = 0;

		const connection = RunService.Heartbeat.Connect(() => {
			frame++;

			// A ball that has already gone — destroyed by a respawn, collected, expired — has no
			// ownership left to report, and the line says that rather than going quiet about it.
			if (ball.Parent === undefined) {
				connection.Disconnect();
				logInfo(`[Ball] ${thrower.Name}: flight ownership — never read, the ball was gone within a frame`);

				return;
			}

			const owner = ball.GetNetworkOwner();

			if (owner === undefined) {
				connection.Disconnect();

				const settling = frame === 1 ? "" : ` (took ${frame} frames)`;
				logInfo(`[Ball] ${thrower.Name}: flight owned by the server${settling}`);

				return;
			}

			// A client still holds it. One more read before believing it — see the doc above.
			if (frame === 1) return;

			connection.Disconnect();

			// Why the server could not take it, asked of the engine rather than guessed — the second
			// return is the engine's own sentence about the refusal, and it is empty when there is none.
			const [canSet, reason] = ball.CanSetNetworkOwnership();

			// Hoisted rather than interpolated, and deliberately: a template literal nested inside
			// another compiles to backticks inside backticks and renders a hole — the trap
			// `BallComponent.logTouch` documents at its own `subject`.
			const refusal = canSet ? "" : `: ${reason}`;

			logInfo(
				`[Ball] ${thrower.Name}: flight owned by ${owner.Name} two frames in — it is being stepped at ` +
					`that machine's rate while the boost was derived from ours (canSet ${canSet}${refusal})`,
			);
		});
	}

	/**
	 * The server half of a MultiBall request: buys `owner` a window.
	 *
	 * **The handler is here and the state is in `SuperService`**, which is {@link markHeldBall}'s split
	 * for its reason — this service owns hands and holds the dev flags, and that service counts charges
	 * and has never touched a ball. The two handlers are deliberately the same shape for a second
	 * reason: two requests that behave differently when refused would be two rules about what a press
	 * means.
	 *
	 * **Two ways in, and neither of them is spelled as a key in this file.** A dev's own MultiBall key
	 * comes straight here, and a mystery box reaches it through {@link useMysteryPower}, which asks the
	 * window which power it is paying for. A rig reaches it from `ThrowBehavior`, with the kind read off
	 * its `PENDING_ABILITY_ATTRIBUTE` slot. Naming a key here would be a second copy of a binding that
	 * lives in the controller which owns it — and a comment that says "press `4`" goes stale, silently,
	 * on the day the binding moves. This one did.
	 *
	 * **Four questions for a player, in the order that costs least to answer, and every refusal is a
	 * print** rather than a thrown error, for `markHeldBall`'s reason: a key press is not a fault, and the
	 * log is where the reason belongs. The same split {@link markHeldBall} now has applies here: the rule
	 * preconditions — a living body, a window that is not already open — run for every owner through one
	 * code path, and the access preconditions — ownership, the round-or-zone gate, a charge or a prize, the
	 * dev bypass — are the only place a `Player`/`Model` branch exists. A rig's access is the pending slot
	 * and nothing else.
	 *
	 * **What a press commits the player to is the one place the two abilities part company.** A mark
	 * waits for a ball and spends nothing; this spends the charge on the spot and starts the window, so a
	 * player who asks for a window and throws nothing has still paid for the throws they did not use. A
	 * rig's slot is spent by the throw site, so it too pays on the throw rather than on this call.
	 * See `SuperService.activateMultiBall`, where the window itself is decided.
	 */
	public activateMultiBall(owner: Player | Model): void {
		// **A living body**, the same test the mark makes and the throw makes in effect: there is no hand
		// to fill and no body to put a window on. The owner is narrowed only to find the body — a rig is its
		// own character, the `Model` the ball is a child of.
		const character = owner.IsA("Player") ? owner.Character : owner;
		const humanoid = character?.FindFirstChildWhichIsA("Humanoid");
		if (!character || !humanoid || humanoid.Health <= 0) {
			logDebug(`[Super] ${owner.Name}: MultiBall refused — no living body`);

			return;
		}

		// **The access preconditions — the only owner-type branch in this method.** A player is asked for
		// ownership, the round-or-zone gate and a charge or a prize (or the dev bypass); a rig is asked only
		// that its pending slot names MultiBall. The rule axis above — a living body — and the rule axis
		// below — a window already open — run for both bodies through one code path.
		if (owner.IsA("Player")) {
			const dev = this.dev.isDev(owner);

			// **MultiBall has to be owned too**, which is the same lock the marks carry: the window is a power
			// unlocked by the chest, and this is where an unowned one is refused. A dev bypasses it as they
			// bypass the round-or-zone gate and the charge below.
			if (!dev && !this.economy.ownsPower(owner, "MultiBall")) {
				logDebug(`[Super] ${owner.Name}: MultiBall refused — not owned`);

				return;
			}

			// **A dev is exempt from the round-or-zone gate, and that exemption is the shortcut's whole point**
			// — a standing start in Studio is usually an intermission in the lobby, where a power has nothing to
			// act on. Asked of `SuperService` rather than read from the status folder here, so the rule that
			// grants a charge and the rule that lets one be spent stay one line in one file, exactly as the mark
			// does it — and see `SuperService.inRoundOrZone` for why that one line is now a round *or a practice
			// zone* rather than a round alone.
			if (!dev && !this.abilities.inRoundOrZone(owner)) {
				logDebug(`[Super] ${owner.Name}: MultiBall refused — no round and no practice zone`);

				return;
			}

			// **The charge, a mystery prize, or the dev bypass.** A dev opens a window holding no charge of
			// their own, which is what makes this testable from a standing start — the mark handler's shortcut,
			// on the other key.
			//
			// **The second term is the whole of what the mystery box does to a game.** While a prize is held the
			// charge test is satisfied without a charge existing, so the power is paid for by the box. It is
			// one `||` rather than a branch because there is nothing else about the request that changes:
			// ownership above, and the round-or-zone gate above that, are asked exactly as they were, which is
			// what keeps a box from being a way to use a power in the lobby or without owning it. See
			// `SuperService.isMysteryActive`, and `markHeldBall` below for the mark's half of the same rule.
			//
			// **And `isMysteryActive` no longer means "the clock is still running".** It means a prize is held,
			// which is the difference between a power that is free *for ten seconds* and one that is free *until
			// it is used*: the box's power is available from the moment it is collected until the player spends
			// it, however long that takes. The spend is below.
			const charged = this.abilities.hasCharge(owner) || this.abilities.isMysteryActive(owner);
			if (!charged && !dev) {
				logDebug(`[Super] ${owner.Name}: MultiBall refused — no charge and no mystery prize`);

				return;
			}
		} else {
			// **A rig's access is the pending slot, and it is the whole of the access axis for a rig.** No
			// charge, no mystery prize, no dev bypass — the slot is what pays, and it must name MultiBall. The
			// round-or-zone gate is deliberately not asked of a rig: a rig reaches this method only from its
			// throw behaviours, which are themselves gated to a round or a practice zone by the tags they wear,
			// so a rig that is here is already somewhere a power can act.
			if (pendingAbilityOn(owner) !== "MultiBall") {
				logDebug(`[Super] ${owner.Name}: MultiBall refused — no pending MultiBall`);

				return;
			}
		}

		// **A second ask is refused rather than restarted**, and the answer is the "no" the mark handler
		// gives a second mark: the owner has asked for something they already have, and one charge does
		// not buy two windows. Returned as a boolean by the service rather than asked as a question here,
		// because opening a window and answering whether one was opened are the same act — and it is the
		// "no stacking" rule precondition, asked of both bodies through the one call.
		if (!this.abilities.activateMultiBall(owner)) {
			logDebug(`[Super] ${owner.Name}: MultiBall refused — a window is already open`);

			return;
		}

		// **A player spends the currencies that paid for the window; a rig spends nothing here**, because a
		// rig has no charge and no mystery prize to spend, and its slot is cleared by the throw site after
		// the throw — the counterpart to the spend below. Only the player's half touches `SuperService`'s
		// spend methods, which remain `Player`-keyed.
		if (owner.IsA("Player")) {
			// **A dev opens windows without earning them**, so there is nothing of theirs to spend — the same
			// bypass `throwForPlayer` applies to a mark, applied here to the same kind of press. Asked at the
			// call site rather than inside `SuperService` for the reason that one gives: only the caller knows
			// who pressed.
			//
			// **Both currencies are settled here, and only the charge is a dev's to bypass.** The box's prize is
			// real state, so a dev spends it like anybody — exempting them is what let a box's power be used
			// over and over, and the person who notices that is the person testing. See
			// `SuperService.spendMysteryPrize` for the argument.
			//
			// **The kind is passed, so a press for a power the box did not roll leaves the prize alone.** A dev
			// opening a MultiBall window while holding a Pierce does not spend the Pierce; a player using the
			// box's own key always matches, because it uses the kind it just read from `mysteryPowerOf`.
			//
			// **The prize is asked about the charge before `spendCharge` takes it away**, which is the order
			// that makes "a charge paid, so the box is kept" true. Called the other way round, the prize would
			// read "no charge" and be eaten by a press the charge had already paid for.
			this.abilities.spendMysteryPrize(owner, "MultiBall");
			if (!this.dev.isDev(owner)) this.abilities.spendCharge(owner);
		}

		// **And the hand is filled on the way in**, which is one of the two free refills: a body who opens
		// a window on an empty hand cannot use the throws they have just paid for. See {@link refillFromBuff}.
		this.refillFromBuff(character, false);
	}

	/**
	 * Uses whatever power a mystery box gave this player — the one key every player has.
	 *
	 * **A router, and the only place a box's power becomes an action.** `SuperService` knows *which* power
	 * is being paid for, asked of `mysteryPowerOf` and never sent by a client, and what "using" it means
	 * depends on the kind: a ball ability is a mark on the ball in hand, and MultiBall is a window of its
	 * own. Both of those already exist and are called exactly as the dev keys call them, so the checks that
	 * matter — ownership, the round-or-zone gate, whether there is a ball at all — are asked in the one
	 * place that already asks them rather than being repeated here. The box pays through the same
	 * `hasCharge || isMysteryActive` test it pays through at either site.
	 *
	 * **Nothing is spent when the roll cannot be used, and that is the value of routing rather than
	 * letting the client name the power.** A ball ability pressed with no ball in hand is refused by the
	 * mark handler before it touches the prize, so the player is still holding it when they pick one up —
	 * where a client-chosen kind would have spent the box on a request the server could not question. That
	 * refusal is also why the spend sites sit *after* their own guards rather than before them: a press that
	 * buys nothing must not cost anything.
	 *
	 * **And for a dev it is now true of the arm as well, which it was not.** The arm used to *replace* a
	 * held prize, so pressing this key with an empty hand could cost a player the box while they were
	 * watching the icon — and the arm that replaced it then put its own ability on the next ball, which is
	 * how the second press of this key came to be refused as "already marked". See `markHeldBall`, which
	 * refuses to arm while a prize is held.
	 */
	private useMysteryPower(player: Player): void {
		const kind = this.abilities.mysteryPowerOf(player);

		if (kind === undefined) {
			logDebug(`[Mystery] ${player.Name}: refused — no mystery prize is held`);

			return;
		}

		// **MultiBall is the one kind that is not a mark**, and this branch is the whole of the
		// difference: it is a state of the *player* rather than a property of a ball, which is why it has
		// its own handler on the dev keys. Asked by name rather than through `isBallAbility`, because the
		// question here is "which of the two doors does this go through" and `isBallAbility` answers a
		// different one — what a ball can carry.
		if (kind === "MultiBall") {
			this.activateMultiBall(player);

			return;
		}

		this.markHeldBall(player, kind);
	}

	/**
	 * Gives `model` a ball out of their MultiBall window, and answers whether it supplied one.
	 *
	 * **One rule, one parameter, because whether the count is charged depends on *why* the hand is
	 * empty.** A ball that was just thrown is replaced by the window and costs one of the five — that is
	 * what the count is for. A hand emptied any other way — the window opening over it, or a ball leaving
	 * it without being thrown — is filled for free, because there was no throw to answer. `spent` is the
	 * whole of that difference, and the callers are the two cases.
	 *
	 * **The count is a number of throws, so the last one is deliberately not replaced.** A ball is handed
	 * over only if the window still has something left *after* this spend, which is what makes `5` mean
	 * "five throws" rather than "five replacements plus the ball you were holding". The second question is
	 * asked after the spend rather than before it because that is the rule: the throw is paid for, and
	 * then the window decides whether there is another ball for the hand.
	 *
	 * **Nothing in this helper marks anything, and that is the ability rather than an omission.** The ball this
	 * hands over comes from the same `giveBall` a hand-out uses, so it is an ordinary ball in every way:
	 * catchable, taggable, pickable, and carrying no ability of its own. **The one marker a MultiBall throw does
	 * carry is written by the caller** — `throwBallBody`, `BALL_DESPAWN_ON_LAND_ATTRIBUTE` — because this method is
	 * handed a body and a flag rather than the ball that was thrown, and the decision is about that ball.
	 *
	 * **The callers, and why this is one method rather than three:** the end of a throw (paid), the
	 * activation handler (free), and both ways out of {@link dropBall} (free). Every one of them is a
	 * moment at which a hand that should have a ball might not, which is the single condition this
	 * answers.
	 */
	private refillFromBuff(model: Model, spent: boolean): boolean {
		// **The owner of the window is whoever this body is, and that is a `Player` *or* the rig itself.**
		// `GetPlayerFromCharacter` answers `undefined` for a rig, so the owner falls back to the model — which
		// is exactly how a rig's window, keyed on its `Model`, is found. This was the line that used to read a
		// rig as "no window to answer from", and the fallback is the whole of the widening.
		const owner = Players.GetPlayerFromCharacter(model) ?? model;

		// Nothing to fill. A hand holding a ball is not a hand this has any business in — which is also
		// what stops a window opened by a body who is already holding one from spending the count.
		if (this.getHeldBall(model)) return false;

		if (spent && !this.abilities.consumeMultiBallBall(owner)) return false;

		// Asked after the spend: the throw is paid for either way, and what the window still holds decides
		// whether this ball is replaced. See this method's doc for why `5` has to mean five throws.
		//
		// **`isMultiBallActive` rather than a separate "has it balls left" test**, which is the rename that
		// followed the window losing its clock: an open window and a window with a throw in it are the same
		// condition now, so the second name was one test written twice. See `SuperService.isMultiBallActive`.
		if (!this.abilities.isMultiBallActive(owner)) return false;

		this.giveBall(model);

		logDebug(`[Super] ${model.Name}: MultiBall supplied a ball`);

		return true;
	}

	/**
	 * **Every body `model` could hit, the thrower excluded — the candidate set for both throw policies.**
	 *
	 * It is still called `pierceBodies` because Pierce is what it was written for, and the name is kept rather
	 * than churned through the three files that mention it: the enumeration is exactly the list
	 * {@link teammateBodies} filters, and a rename would change nothing either caller decides. **What differs
	 * between the two is the *policy*, not the set** — see the loop in `throwBallBody`, which picks one.
	 *
	 * **Every body in the world, and the thrower is the only exception** — who is ignored by the line
	 * above, so he is skipped here rather than constrained twice.
	 *
	 * **Why not "every enemy", which is what this was first.** A Pierce ball that stops dead on a
	 * *teammate* has been cancelled by somebody on your own side, and no amount of correctness in the
	 * code makes that read as anything but a bug from the seat. So nothing alive stops a Pierce ball:
	 * the world does, and that is the whole rule.
	 *
	 * **What that costs is named rather than hidden.** A teammate no longer blocks a Pierce shot, so
	 * they cannot be used as cover either — a player standing behind one gains nothing by it. Those two
	 * cannot both hold, and the ability working is the one worth keeping.
	 *
	 * **It also deletes a compromise.** The side test that used to be here was a second expression of
	 * `RoundService.isFriendlyFire`'s rule, reading `TEAM_ATTRIBUTE` because that service already depends
	 * on this one and could not be asked back. With no side test there is nothing left to duplicate, so
	 * the veto remains the single statement of the rule — and with the side test gone, this file asks
	 * `SuperService` whether a round is running in exactly two places, the mark handler and
	 * `activateMultiBall`, where it used to ask in three.
	 *
	 * **A teammate is still not *hurt* by it.** The friendly-fire veto in `BallComponent` is untouched
	 * and has nothing to do with collision: it drops the contact, so there is no tag, no damage and no
	 * record. This method is about the ball's *path*; that rule is about what a contact is allowed to do.
	 *
	 * **NPC rigs come along with everything else**, found the way everything in this codebase finds them
	 * — the `NPC` tag, which is what `NpcService`, `OutlineService` and `CollisionGroups` each walk.
	 *
	 * **Run before the ball is parented to the world, so the enumeration is complete.**
	 * `CollisionIgnore` builds one constraint per part of the body it is handed, worked out at the
	 * moment it is called — so what it sees is whatever that rig had at that instant. At this point in
	 * a throw every rig is standing there with all of its parts, which is the best moment available to
	 * ask. (In the tag branch the same call happens *during* a contact, which is a worse place to be
	 * counting somebody's parts, and is part of why the pre-emptive version is the right one.)
	 */
	private pierceBodies(model: Model): Array<Model> {
		const bodies: Array<Model> = [];

		const consider = (body: Model) => {
			if (body === model) return;

			bodies.push(body);
		};

		for (const player of Players.GetPlayers()) {
			const character = player.Character;
			if (character) consider(character);
		}

		for (const rig of CollectionService.GetTagged(NPC_TAG)) {
			// **In the world, with `detect.ts`'s two tests**, because `pierceBodies` and `detectEnemy` are the
			// same enumeration and the doc above says so. The tag reaches into `ServerStorage`, so without this
			// a template gets a `NoCollisionConstraint` per part against a ball that can never touch it — work
			// on every piercing throw, for a body that is not on the field.
			if (!rig.IsA("Model")) continue;
			if (!rig.IsDescendantOf(Workspace)) continue;

			consider(rig);
		}

		return bodies;
	}

	/**
	 * **The bodies on `model`'s own side — what an ordinary throw is not allowed to be stopped by.**
	 *
	 * **A teammate is not a wall, and the ball is what says so.** The friendly-fire veto in `BallComponent`
	 * already means a teammate takes no damage from a same-side throw, but it runs on `Touched` — *after* the
	 * engine has resolved the contact — so before this method existed a teammate still deflected the ball,
	 * which read as "my own side blocked my shot" rather than as "I did not hurt them". A veto that arrives
	 * after the bounce is not a save, it is a miss with a footnote.
	 *
	 * **The set is `pierceBodies` filtered by side**, rather than a second enumeration: the two answer about
	 * the same bodies and a second walk is a second place to keep the `NPC` tag, the `Workspace` test and the
	 * thrower exclusion right. What that costs is stated where it belongs, in `pierceBodies`' own doc.
	 *
	 * **A team change mid-flight does not re-open the ball**, deliberately. The constraints are created once,
	 * at the throw, against the bodies that were teammates then; a body that swaps sides while the ball is in
	 * the air stays intangible to it for the rest of that flight. The alternative — asking sides again on every
	 * contact — would make the same throw hit or miss depending on the instant it arrives, which is a worse
	 * rule than "the throw was decided when it left the hand". The next throw is set up from scratch, so
	 * nothing survives into it: `CollisionIgnore.clear` sweeps the whole set when the ball arrives in a hand.
	 *
	 * **A teammate who walks into the ball after it was thrown is passed through too**, and that follows from
	 * the ignore being on the *body* rather than on the path: the sweep at throw time is what decides which
	 * bodies the ball may not touch, and it decides it once.
	 *
	 * **Outside a round this is empty.** `sideOfBody` answers nothing for a body wearing no side, and there is
	 * nothing to be friendly with — which is the same answer `RoundService.isFriendlyFire` gives for a lobby
	 * throw, arrived at from the same label rather than from a second rule.
	 */
	private teammateBodies(model: Model): Array<Model> {
		const mine = this.sideOfBody(model);
		if (mine === undefined) return [];

		const bodies = new Array<Model>();

		for (const body of this.pierceBodies(model)) {
			if (this.sideOfBody(body) === mine) bodies.push(body);
		}

		return bodies;
	}

	/**
	 * **Which side a body is on, read from wherever that side actually lives — the server's copy of the
	 * two-branch rule `client/roundZone.sideOfBody` documents.**
	 *
	 * `TEAM_ATTRIBUTE` is written on the **`Player`** by `RoundService.assignTeams`, because the roster is
	 * player-keyed and a character is replaced on every death, while a **rig** carries its own — painted in
	 * Studio or written by its pad walk and its respawn. A reader that only asked the model would therefore
	 * read *every player's character* as side-less, and under an equality test "no side" is indistinguishable
	 * from "not my side", which is the exact way this rule goes quietly wrong. `GetPlayerFromCharacter` is the
	 * branch that tells the two apart; its `undefined` means "a rig", and then the model's own attribute is
	 * the answer.
	 *
	 * **The label is validated rather than merely read.** An attribute is a string anybody can write, so
	 * `Team = "Red"` is not a side, it is a string that happens to be a colour — the same reading
	 * `npc/rigs.ts`'s `sideOfRig` and `roundZone.sideOf` make. A value that is not one of the two labels is
	 * no side, which under this file's equality test means "not a teammate" rather than "everybody's
	 * teammate".
	 *
	 * **`RoundService.isFriendlyFire` cannot be asked here**, and that is why this exists rather than a call
	 * to it: the round already depends on this service, so the dependency the other way would be a constructor
	 * cycle. `isFriendlyFire` therefore remains the single statement of the *damage* rule — `BallComponent`
	 * calls it on every contact, and this file does not restate it — while this is the *path* rule's reading of
	 * the same published label. That split is the reason `pierceBodies` stopped reading sides at all when
	 * Pierce became "every body"; it is only back because a ball that a teammate can deflect needs the answer
	 * before the contact rather than after it.
	 */
	private sideOfBody(body: Model): TeamLabel | undefined {
		const player = Players.GetPlayerFromCharacter(body);
		const label = (player ?? body).GetAttribute(TEAM_ATTRIBUTE);

		return label === TEAM_A || label === TEAM_B ? label : undefined;
	}

	/**
	 * The player path: what the throw remote's handler calls.
	 *
	 * A player is not a special kind of thrower, just the only one with a `Player`
	 * behind it — so there is nothing here but recovering the character and handing
	 * it to {@link throwBall} as the model. The refill belongs to the throw itself,
	 * which is what makes it the same refill for an NPC.
	 *
	 * **And the one place a charge is spent, because this is the one path a player's throw takes.**
	 * `throwBall` is reached by an NPC's behavior as well, and a rig holds no charge — so the spend
	 * belongs to the player path rather than to the throw. It is also deliberately the *remote
	 * handler's* path: that remote fires on `Enum.UserInputState.Begin` and on nothing else, so this
	 * runs once per click rather than once per frame, and one throw cannot spend two charges.
	 */
	private throwForPlayer(player: Player, request: ThrowRequest, claimedLaunch?: Vector3) {
		const character = player.Character;
		if (!character) return;

		// **A decided round does not take a throw from one of its own players, and this is the only place that can say
		// so without saying it to a rig.** `ARENA_CONFIG.CELEBRATION_SECONDS` keeps everybody in the arena after
		// the result — walking and jumping, which is what the window is for — and a ball leaving a hand in it
		// would be a throw at somebody who has just been told the round is over. Refused here rather than in
		// `throwBall` for a reason worth stating: that method is the shared path, so a gate there would also
		// refuse the practice bay's drills, which are rigs in a bay somebody is using and which
		// `roundCelebrating` cannot tell apart from an arena NPC. The arena's own NPCs need no gate — their
		// behaviours already stop when the phase stops being `Playing` — so the player's click is the whole of
		// what is left. See `roundCelebrating` and `CELEBRATING_ATTRIBUTE`.
		//
		// **The subject is the round's own players, and the first version of this line had it wrong.** It read
		// `roundCelebrating()` alone, which made it a refusal of *every* player's throw for ten seconds — and the
		// report was a player practising in a practice zone, with drills landing on them, unable to throw their
		// own ball because a match they were not in had finished. A celebration is about a round; the bodies it
		// has anything to say about are the ones that round put on a side.
		//
		// **`hasSide` rather than `isParticipant`, and the difference is a lifecycle fact rather than a taste.**
		// By the time anything is being celebrated the phase has left `Playing` and `IN_ROUND_ATTRIBUTE` has been
		// cleared for every player — the round's members are exactly the bodies still wearing a side, because
		// `TEAM_ATTRIBUTE` is not cleared until the next whistle. A gate built on `isParticipant` would therefore
		// refuse nobody at all, during the one window it exists for. See `shared/roundMembership.hasSide`, which
		// carries that argument in full.
		//
		// **And a practising body is exempt even if it carries a side**, which is the same carve-out `landHit`
		// makes two hundred lines of ball code away: a throw into a practice bay lands on a rig in a bay, not on
		// anybody the result concerns. A player who played the round and then walked to a practice floor to warm
		// up is the case that needs this term; a player who was in the zone at the whistle never got a side at
		// all and is already allowed by the line above.
		//
		// **It returns before the charge is even read**, so a throw the window took costs a player nothing and
		// the ball stays in the hand: the spend below happens only for a throw that actually left, and
		// `throwBall` is never reached. A lobby spectator's throw is no longer refused here at all — they are not
		// in the round the celebration belongs to, and `BallComponent.landHit` still refuses damage in the window
		// for anybody who was going to be hit by it.
		if (roundCelebrating() && hasSide(character) && !isPractising(character)) {
			logDebug(`[Ball] ${player.Name}: throw refused — the round this body played is celebrating`);

			return;
		}

		// **And a throw that arrives after the hold was up is refused, on this server's own clock.** A charge
		// clamps at `1.0` and the client releases it `FULL_CHARGE_HOLD_SECONDS` after the arc stops growing — but a
		// client is a machine somebody else runs, so the deadline is enforced here as well and **only here**: this
		// is the only path a player's throw takes, and the gate is above every effect below it (`throwBall`, the
		// MultiBall spend, the charge spend, the badge, the sound, the afterimage) because a refused throw must
		// cost nothing and leave the ball in the hand.
		//
		// **The deadline is `CHARGE_SECONDS + FULL_CHARGE_HOLD_SECONDS`, and that is exact rather than a guess.**
		// `ThrowController.currentCharge` is `(now - began) / CHARGE_SECONDS` clamped to `1`, so the charge reaches
		// full at exactly `CHARGE_SECONDS` after the press — a nearer aim point changes the *reach* the plan asks
		// for, never the rate the charge grows at. A hold is therefore `CHARGE_SECONDS + <time at full>`, and the
		// cap on the second term is the published one.
		//
		// **The instant comes from the `setCharging` report rather than from the wire's throw message, and that is
		// what makes it worth anything.** The stamp is taken by this server when the client said the button went
		// down (`WalkSpeedService.setCharging` → `chargeClock`), so the client cannot move it: the round trip
		// cancels between the press and the release, and what is measured is the hold plus jitter. The tolerance
		// on the end is `FULL_CHARGE_GRACE_SECONDS`, which exists so an on-time release is never refused for
		// arriving a frame late.
		//
		// **`undefined` is a hold this server never heard begin, and it is accepted rather than refused.** That is
		// a client whose report did not arrive — or one that chose not to send it — and the two cannot be told
		// apart, so refusing would put a lockout on a player for a message fault. It is stamped as starting *now*
		// so the next throw is capped, and the line says so: an exploit that prints a line is a report somebody
		// can act on, and one that prints nothing is next month's "it failed at random". See `chargeClock`, which
		// states plainly that a client omitting the report is not closed by this and cannot be without the server
		// owning the charge.
		const held = holdSeconds(player);
		const cap = BALL_CONFIG.CHARGE_SECONDS + BALL_CONFIG.FULL_CHARGE_HOLD_SECONDS;

		if (held === undefined) {
			noteCharging(player, true);

			logInfo(`[Throw] ${player.Name}: no charge report — the hold starts at this throw and is capped from it`);
		} else if (held > cap + BALL_CONFIG.FULL_CHARGE_GRACE_SECONDS) {
			logInfo(
				`[Throw] ${player.Name}: refused — hold exceeded ${string.format("%.2f", held)}s at full charge ` +
					`(cap ${string.format("%.2f", cap)}s + ${string.format("%.2f", BALL_CONFIG.FULL_CHARGE_GRACE_SECONDS)}s grace)`,
			);

			return;
		}

		// **Read before the throw, because the throw empties the hand.** `throwBall` deletes the entry
		// this asks for, so the marked ball has to be identified while it is still in the hand — and what
		// is kept is the *kind* rather than the bare fact that something was marked: a box's prize only
		// pays for the power the box rolled, so the spend below has to be able to name what it is spending.
		// Nothing below needs the instance; the marker rides the throw by itself.
		const markedKind = abilityOn(this.getHeldBall(character));

		// A ball that did not go — an empty hand, or a body with no hand to take it from — spends
		// nothing. `throwBall` answers whether anything left, and this is the only caller that cares.
		//
		// **The request is passed through untouched, because everything that could be checked about it was
		// checked by the handler that built it** — the charge's range, the heading's type, the bend. This
		// method's whole job is the charge bookkeeping below, and a second set of checks here would be a second
		// opinion about the same arguments with the same answer, in the one place that cannot report on it.
		if (!this.throwBall(character, request, claimedLaunch)) return;

		// **A dev marks a ball without earning it**, so there is nothing of *theirs* to spend — the bypass
		// {@link markHeldBall} documents. Asked here rather than inside `SuperService` because only the
		// caller knows who threw: that service is told the outcome and never asks who the thrower was.
		//
		// **But the dev bypass covers the charge and not the box**, which is the one asymmetry between the
		// two currencies here: a charge is earned by a streak, so a dev has none and bypasses it, while a
		// box's prize is state a dev collects exactly as a player does. So the prize is spent on a dev's
		// throw too — see `SuperService.spendMysteryPrize`, and the MultiBall call site above for why the
		// prize is asked about `spendCharge` first.
		if (markedKind !== undefined) {
			this.abilities.spendMysteryPrize(player, markedKind);
			if (!this.dev.isDev(player)) this.abilities.spendCharge(player);
		}
	}

	/**
	 * Marks the ball `owner` is holding as carrying `kind`.
	 *
	 * **The handler for the ability key, and the rig's throw path, both arrive here.** For a player this
	 * is the whole of what a press does — the questions below, asked in the order that costs least to
	 * answer, and every refusal is a print rather than a thrown error, because a key press is not a fault
	 * and the log is where the reason belongs. A rig reaches it from `ThrowBehavior` with a kind read off
	 * its `PENDING_ABILITY_ATTRIBUTE` slot, and the two bodies differ on one axis only.
	 *
	 * **Two axes, and the split is the design.** The *rule* preconditions — the kind is a ball ability, the
	 * body is alive, the held ball is unmarked — run for every owner before the owner is known, so a future
	 * rule of that shape (a "no stacking" rule is the standing example) lands on a rig and a player through
	 * one code path. The *access* preconditions are the only place a `Player`/`Model` branch exists: a
	 * player is asked for ownership, the round-or-zone gate and a charge or a prize (or the dev bypass),
	 * and a rig is asked only that its pending slot names `kind`.
	 *
	 * **Why the handler is here and not in `SuperService`.** Two of the questions are this service's: where
	 * the ball is (it owns hands, and `getHeldBall` exists for this) and what a body may do (the dev flags
	 * are already held here). Putting it there would mean `SuperService` depending on hands — the wrong
	 * direction for a service whose whole job is to count two things. As it stands that service is asked one
	 * question, `hasCharge`, and never has to find a ball.
	 *
	 * **The charge is not spent here, deliberately.** See `SuperService.spendCharge`: the charge follows
	 * the ball, so a mark that is never thrown costs nothing, and a player who marks a ball and changes
	 * their mind has not paid for a throw they did not make. A rig's slot is likewise not spent here — it is
	 * cleared by the throw site after the throw, so a refused mark cannot strand it.
	 */
	public markHeldBall(owner: Player | Model, kind: unknown): void {
		// **The wire is not typed**, so what arrives is checked rather than trusted — the same treatment
		// `WalkSpeedService.setSprinting` gives its own argument, and for its reason: a client can send
		// anything, and this is the line that turns a string into a value the rest of the code can use.
		//
		// **`isBallAbility` rather than `isAbilityKind`, which is a second question and not the same
		// one.** With MultiBall in the vocabulary there is now an ability that belongs to a *player* and
		// has nothing to mark, so "is this an ability" no longer answers what a remote whose whole job is
		// to write an ability onto a ball needs to know. Without the narrower check, a client could send
		// the word for a player-level buff and have it stamped on a ball, where the HUD would then report
		// it as a loaded ability that nothing implements.
		//
		// **A rule precondition, and the first of three that run before the owner is known.** Whether a
		// word is a ball ability is the same question for a rig as for a player, so it sits ahead of every
		// `Player`/`Model` branch — which is the whole of the split this method now has.
		if (!typeIs(kind, "string") || !isBallAbility(kind)) {
			logWarn(`[Super] ${owner.Name}: mark refused — not an ability a ball can carry (${tostring(kind)})`);
			return;
		}

		// **A living body**, which is the same test the throw makes in effect: a body with no character
		// has no hand to be holding anything in. Not a poll of the *round's* roster either — a player who is
		// out of the round has a dead body or none, and the ball is a child of the body either way, so the
		// body is the honest question and the roster would be a second answer to it. (This used to name the
		// spectator attribute to say the same thing; that state is gone and the test is unchanged.)
		//
		// **The second rule precondition, and the owner is narrowed only to *find the body*.** A rig is its
		// own character — its `Model` is the thing the ball is a child of — so `character` is the player's
		// character for a player and the rig itself for a rig, and everything after this treats the two
		// identically.
		const character = owner.IsA("Player") ? owner.Character : owner;
		const humanoid = character?.FindFirstChildWhichIsA("Humanoid");
		if (!character || !humanoid || humanoid.Health <= 0) {
			logDebug(`[Super] ${owner.Name}: mark refused — no living body`);

			return;
		}

		const ball = this.getHeldBall(character);

		// **Already carrying something, which is a second press of the same key or two presses close
		// together. Not a second ability, and the first mark is not overwritten either** — the third rule
		// precondition, "no stacking", and it runs for both bodies before any access question: a second
		// mark is refused whoever is asking, because the rule is about the *ball* and not about the owner.
		if (ball !== undefined && abilityOn(ball) !== undefined) {
			logDebug(`[Super] ${owner.Name}: mark refused — the held ball is already marked`);

			return;
		}

		// **The access preconditions — the only place this method has an owner-type branch.** What a body
		// must bring to be allowed to mark is a per-owner fact. A player brings ownership, the round-or-zone
		// gate, and a charge or a mystery prize, with the dev bypass sitting in for all three; a rig brings
		// its pending-ability slot and nothing else. The two arms substitute one access story for the other,
		// and the mark below is one line they share.
		if (owner.IsA("Player")) {
			// **A dev is exempt from the round-or-zone gate, and that exemption is the point of the shortcut.**
			// The rule the key exists for is "a dev can exercise this from a standing start", and a standing
			// start in Studio is usually an intermission in the lobby — where a power has nothing to act on,
			// which is the same reason the gate itself refuses there.
			const dev = this.dev.isDev(owner);

			// **The power has to be owned, which is the newest gate and sits before the round's.** A key that
			// marks a ball is a request to use a power the player may not have unlocked yet: the chest grants
			// powers, and this is the lock the chest opens. Asked of `EconomyService`, which owns the roster —
			// the dev bypass skips it exactly as it skips the round-or-zone gate and the charge.
			if (!dev && !this.economy.ownsPower(owner, kind)) {
				logDebug(`[Super] ${owner.Name}: mark refused — ${kind} not owned`);

				return;
			}

			// **Otherwise, only where a power can do anything: a round is being played, or this body is standing
			// in a practice zone.** Asked of `SuperService` rather than read from the status folder here, so the
			// rule that grants a charge and the rule that lets one be spent stay one line in one file — a second
			// copy could let a charge be earned in a round a ball could not be marked in. The zone half is
			// `DodgeService.requestDodge`'s rule; see `SuperService.inRoundOrZone` for why the two actions share
			// it, and for the bug that came of this one half being missing here.
			if (!dev && !this.abilities.inRoundOrZone(owner)) {
				logDebug(`[Super] ${owner.Name}: mark refused — no round and no practice zone`);

				return;
			}

			// **No ball in hand, and a dev: the arm goes on the player instead.**
			//
			// This is the whole of the shortcut. A dev in Studio usually has nothing to mark — the arena's
			// spawners only stock the floor while a round is playing, so outside one there is no ball to pick
			// up, and `InfiniteBalls` is a flag they have to find first — so "mark the held ball" is a rule
			// that cannot be exercised from a standing start. Arming the *player* moves the
			// ability one step earlier: it waits on them, and the next ball that arrives in their hand takes it
			// up. See `attachToHand`, which is where that happens, and {@link ARMED_ABILITY_ATTRIBUTE} for why
			// the arm lives on the player rather than the body.
			//
			// **A non-dev is refused here exactly as before.** The arm is not a second way to mark a ball, it is
			// the dev bypass's second shape — so the refusal below is unchanged, and the order of the two
			// branches does not matter to anybody who cannot already use the shortcut.
			//
			// **And a mystery prize outranks the arm, which stands down rather than replacing it.** Both are the
			// same slot in a player's hands — "the power my next press uses" — so they cannot both be held, and
			// the tie goes to the one that cost something: a box is consumed the moment it is walked into, so
			// destroying its prize to arm a shortcut would throw away a power the player went and collected,
			// while the arm costs nothing and can be asked for again a second later. This is also what
			// `useMysteryPower` promises for an empty hand: press the key early and the player is *still holding
			// their power* when they pick a ball up. The prize itself clears any arm already set, from the other
			// end — see `SuperService.holdMysteryPrize`.
			if (ball === undefined) {
				if (!dev) {
					logDebug(`[Super] ${owner.Name}: mark refused — no ball in hand`);

					return;
				}

				if (this.abilities.isMysteryActive(owner)) {
					if (DEBUG_LOGGING) {
						logInfo(`[Super] ${owner.Name}: mark refused — a mystery prize is waiting on a ball`);
					}

					return;
				}

				owner.SetAttribute(ARMED_ABILITY_ATTRIBUTE, kind);

				if (DEBUG_LOGGING) {
					logInfo(`[Super] ${owner.Name}: armed ${kind} — the next ball they take up will carry it`);
				}

				return;
			}

			// **The charge, a mystery prize, or the dev bypass.** A dev marks a ball holding no charge of their
			// own, which is what makes this testable without six hits in a row first.
			//
			// **Written out at both sites rather than inside `SuperService`, and the line it draws is worth the
			// repetition.** The two sites differ in what they do next (a mark, a window) and agree only on this
			// test — and this test is not the whole gate either: ownership and `inRoundOrZone` above are asked
			// before it, so a helper named for the question a caller has ("may this player use a power") would
			// read as the whole of it while being one term of it. What *is* shared is the part that is one rule
			// rather than one sentence — see `SuperService.inRoundOrZone`.
			const charged = this.abilities.hasCharge(owner) || this.abilities.isMysteryActive(owner);
			if (!charged && !dev) {
				logDebug(`[Super] ${owner.Name}: mark refused — no charge and no mystery prize`);

				return;
			}
		} else {
			// **A rig's access is the pending slot, and it is the whole of the access axis for a rig.** No
			// charge, no mystery prize, no dev bypass, no arm — the slot is what pays, and it must name the
			// same kind this call asks for. A rig reaches here only from its throw behaviours, which read the
			// slot first, so this is the same test read from the other end; it exists so that no other caller
			// can mark a rig's ball without a box behind it.
			if (ball === undefined) {
				logDebug(`[Super] ${owner.Name}: mark refused — no ball in hand`);

				return;
			}

			if (pendingAbilityOn(owner) !== kind) {
				logDebug(`[Super] ${owner.Name}: mark refused — no pending ${kind}`);

				return;
			}
		}

		this.setBallAbility(ball, kind);

		// **The power is armed as of this line, and the HUD is told.** The mark is the ball's, so this service
		// is the only thing that can say so — see `syncArmedPower`. It runs for a rig too, where it returns
		// immediately: a rig's armed state is its pending slot and nothing on the HUD reads it.
		this.syncArmedPower(character);

		// **The line says which of the two paid, and it used to name only the charge.** For a player both
		// terms of `charged` are in play, so the line that names the charge or the prize for a player is kept
		// word for word; a rig has no charge and no prize to name, so its line names the slot instead. The
		// branch here is a log line's, not a rule's — the mark itself is one code path above it.
		if (DEBUG_LOGGING) {
			if (owner.IsA("Player")) {
				const charged = this.abilities.hasCharge(owner) || this.abilities.isMysteryActive(owner);

				logInfo(
					`[Super] ${owner.Name}: ${ball.Name} marked as ${kind}` +
						`${charged ? " — paid for, and the charge or the prize will be spent" : " — dev bypass, nothing held"}`,
				);
			} else {
				logInfo(`[Super] ${owner.Name}: ${ball.Name} marked as ${kind} — the pending prize paid`);
			}
		}
	}

	/**
	 * The thrower token of a model, or `""` when it has none.
	 *
	 * A player's is their `UserId` as text and an NPC's is a GUID — both stamped on
	 * the model itself, so a ball only ever carries a string copy of whichever one
	 * threw it. That is what makes the immunity check in `BallComponent` the same
	 * single comparison for a player and for an NPC.
	 */
	private tokenOf(model: Model): string {
		const token = model.GetAttribute(THROWER_TOKEN);
		return typeIs(token, "string") ? token : "";
	}

	/**
	 * The ball `model` is holding, if any.
	 *
	 * Public for the NPC behaviors, which have to know whether there is anything to
	 * throw. The throwing itself stays {@link throwBall}'s — this only reports.
	 */
	public getHeldBall(model: Model): BasePart | undefined {
		return this.heldBalls.get(model)?.ball;
	}

	/**
	 * **Puts a live ball into the table the proximity catch searches.** Called by `BallComponent.onStart`, which is
	 * the only thing that knows how to decide and resolve a catch for this ball. See {@link catchHandlers}.
	 */
	public registerCatchHandler(ball: BasePart, handler: (catcher: Model) => boolean): void {
		this.catchHandlers.set(ball, handler);
	}

	/** Takes a destroyed ball out of that table. Called from `BallComponent`'s `Destroying` hook, unconditionally. */
	public forgetCatchHandler(ball: BasePart): void {
		this.catchHandlers.delete(ball);
	}

	/**
	 * **Catches the nearest catchable ball within `maxStuds` of `centre`, and answers whether one was taken.**
	 *
	 * **The second way to catch, and it is additive rather than a replacement.** Touching the ball still catches it,
	 * through `handleTouch`; this is for the ball that passes close without quite reaching the body — the common shape
	 * of a rebound coming back at the thrower. See `CATCH_CONFIG.CATCH_RADIUS_STUDS` for the distance and why it exists.
	 *
	 * **The filter is distance first and eligibility second, and the order is the cost.** `Magnitude` on a `Vector3` is
	 * cheap and deciding a catch is not — it reads an attribute, asks three services and can attach a ball. So a ball
	 * outside the radius is rejected before anything asks whether it *could* be caught.
	 *
	 * **Every candidate goes through the component's own handler**, so nothing here can widen what is catchable: a
	 * Pierce ball, a Freeze ball, a ball in a hand and a ball that is not armed are all refused at eight studs exactly
	 * as they are at zero. And a handler that refuses **changes nothing** — that contract is what makes it safe to try
	 * each ball in turn until one is taken.
	 *
	 * **The loop stops at the first catch, and `consume` has already closed the window by then**, so "one ball per
	 * window" holds across both doors: a proximity catch cannot be followed by a `Touched` catch in the same second,
	 * because the window is gone.
	 *
	 * **No sort, and the first match wins.** A catcher with two balls inside eight studs takes whichever the map
	 * reaches first, which is insertion order — the older ball. Ordering by distance would be a second comparison per
	 * ball to choose between two catches that are both legitimate and both equally "the ball that happened to be there".
	 */
	public catchByProximity(character: Model, centre: Vector3, maxStuds: number): boolean {
		for (const [ball, handler] of this.catchHandlers) {
			if (!ball.IsDescendantOf(Workspace)) continue;

			// **A ball already on its way into somebody's hand is not available**, and this is not redundant with
			// `canCatch`'s `Armed` test: the window has been spent for the *catcher*, but a second player with an open
			// window would otherwise be able to take a ball that is already travelling toward the first. `Armed` going
			// off at the start of a pull closes that too, so this is the cheap half of the same rule — one map lookup
			// before the distance sum, on the loop that runs every frame.
			if (this.pulling.has(ball)) continue;

			if (ball.Position.sub(centre).Magnitude > maxStuds) continue;

			if (handler(character)) return true;
		}

		return false;
	}

	/**
	 * **Tells `SuperService` what power the body is holding, so the HUD's `READY` text follows the ball.**
	 *
	 * This service owns hands and the ball owns the mark, so this is the side of the line that can answer
	 * "is this player holding a loaded ball" — and `SuperService` deliberately never touches a ball ("nothing
	 * in this file touches a ball"), which is why the answer has to be handed over rather than asked for. It
	 * is the arm/complete pair in `SuperService` that this drives: `armPower` when there is a mark to report
	 * and `completePower` when there is not.
	 *
	 * **The answer is *derived* here on every call, rather than a kind being passed in.** Every call site is
	 * already a moment the hand's contents changed, and reading the truth at each of them is what makes a
	 * missed edge impossible to spell: a caller cannot report the wrong kind, because it reports nothing at
	 * all. The alternative — passing the kind from the site that knows it — would be a second copy of a fact
	 * the ball is holding, and the two would disagree exactly when a ball was replaced inside one of the
	 * sites rather than before or after it.
	 *
	 * **Five call sites, and every one is a moment the project already treats as "this ball's fate
	 * changed":** the mark landing ({@link markHeldBall}), a ball arriving in a hand ({@link
	 * attachToHandBody}'s tail — which is also how a dev's arm becomes a mark), the throw
	 * ({@link throwBallBody}'s tail, after any refill), the drop ({@link dropBall}), and the ball being
	 * destroyed ({@link removeBall}).
	 *
	 * **A rig is skipped.** A rig's armed state is its pending slot on the body and the mark on its ball, and
	 * it has no HUD to tell — `SuperService.armPower` and `completePower` are `Player`-keyed for that reason.
	 * Every rig path comes through these same five sites, so this guard is the whole of the difference.
	 */
	private syncArmedPower(model: Model): void {
		const player = Players.GetPlayerFromCharacter(model);
		if (player === undefined) return;

		const kind = abilityOn(this.getHeldBall(model));

		if (kind === undefined) this.abilities.completePower(player);
		else this.abilities.armPower(player, kind);
	}

	/**
	 * Whether `model` is a dev who has switched `InfiniteBalls` on.
	 *
	 * The flags live on players and an NPC never has one, so an NPC simply never takes
	 * this branch. Asking about a dev is not the only reason a `Player` shows up in
	 * this file, though — the charge and MultiBall bookkeeping asks for one as well,
	 * and for the same reason: it belongs to a player rather than to a body.
	 */
	private hasInfiniteBalls(model: Model): boolean {
		const player = Players.GetPlayerFromCharacter(model);
		return player !== undefined && this.dev.getFlag(player, "InfiniteBalls");
	}

	/**
	 * **How long `ball` lives once it has left a hand — ten seconds for litter, and no clock at all for
	 * anything a round is using.**
	 *
	 * **The report this answers arrived twice, and the second time is why the rule is about the phase rather
	 * than about the tag.** Every ball the arena stocks starts on `math.huge` — see `BallSpawnerService.spawn`
	 * — but *throwing or dropping it re-schedules the clock*, and until item 139 that clock was
	 * `BALL_CONFIG.LIFETIME_SECONDS` (ten) for every ball in the game. Before item 137 the spawner's
	 * one-second top-up replaced each expired ball, so nobody could tell; after it, the arena's fixed supply
	 * drained away, and the fix was to spare the balls wearing `ARENA_BALL_TAG`.
	 *
	 * **That was the right half of the answer keyed on the wrong question, which is what the second report
	 * proved.** The tag answers *the spawner put this one out*, and most of a round's balls are not the
	 * spawner's: `giveBall` makes one for an `AlwaysThrowing` rig, a MultiBall refill makes one, a dev's
	 * `InfiniteBalls` makes one — and none of those ever carries the tag, so every one of them lived ten
	 * seconds after it last landed. **On the floor, mid-round, in front of the player asking.** A bounce or a
	 * roll only moves the moment the clock starts; it is still a ball vanishing for no reason anybody
	 * standing there can see.
	 *
	 * **So the question is the phase, and the tag is now only the fast path.** While a round is being played,
	 * nothing loose is litter — the round's own sweep ends a round's balls, and
	 * `BallSpawnerService.cleanupRoundBalls` takes **every loose ball in the world**, not only the tagged ones,
	 * so nothing accumulates from this. Between rounds the ten seconds is back, which is what stops a practice
	 * floor collecting scenery for the rest of a session.
	 *
	 * **The cost, stated rather than hidden.** During a round the floor can hold more balls than the spawner
	 * put out, because a hand-out is no longer cleaned up while the whistle is on: the ceiling is one ball per
	 * `giveBall` that could not find one loose, and every one of them goes at the next sweep. That is bounded
	 * by a round rather than by a session, and it buys a rule a player can predict — *nothing I can see
	 * disappears mid-round* — which is the rule the tag could not describe.
	 *
	 * **`math.huge` is `scheduleBallExpiry`'s own word for "not on a clock", and it is passed rather than
	 * special-cased**; a ball the round owns must still be there when somebody goes back for it, which is the
	 * whole of a fixed supply.
	 */
	private lifetimeOf(ball: BasePart): number {
		// The fast path first: a tagged ball is on no clock whatever the phase, so the status folder is never
		// read on the throw of a ball that was never going to expire. See `roundPlaying` for why the phase is
		// the second test rather than the only one.
		if (ball.HasTag(ARENA_BALL_TAG)) return math.huge;
		if (roundPlaying()) return math.huge;

		return BALL_CONFIG.LIFETIME_SECONDS;
	}

	/**
	 * Whether `ball` is in somebody's hand right now.
	 *
	 * Public because the round's cleanup needs it: a ball the round owns that a player has picked
	 * up is no longer the arena's to take away, and that judgement lives here rather than being
	 * guessed at from the ball's parent — see `BallSpawnerService.cleanupRoundBalls`.
	 */
	public isHeld(ball: BasePart): boolean {
		for (const [model, held] of this.heldBalls) {
			if (held.ball === ball) {
				logDebug(`[Ball] ${ball.Name} is still held by ${model.Name}`);
				return true;
			}
		}

		return false;
	}

	/**
	 * **Every ball that is a live throw right now**, in the world and still armed — the answer to "what is
	 * flying", asked by anything that has to look at balls it does not own.
	 *
	 * **`Armed` is the definition and not a proxy for one.** It is set at the release
	 * ({@link throwBallBody}) and cleared when the throw dies on the world — see the branch in
	 * `BallComponent.handleTouch` that detaches the pierce trail "because this is the throw's death" — so
	 * `true` means exactly "this ball is still able to hurt somebody". `npc/detect.ts` and `DodgeBehavior`
	 * both make the same read for the same reason, and a ball lying on the floor after a landing is one whose
	 * throw is over however fast it is still rolling.
	 *
	 * **`Parent === Workspace` is the held check**, and it is the cheap half of a question `isHeld` answers
	 * properly: a ball in a hand is welded to that character and parented to it, so it is not a child of the
	 * world at all. `settleLooseBalls` filters on the same line for the same reason. A ball parented
	 * somewhere that is *not* `Workspace` and is not a hand — a template in `ServerStorage` — is likewise not
	 * flying, which is why this is a parent test rather than a `GetDescendants` of the arena.
	 *
	 * **A fresh array rather than the tag list**, because the caller iterates it per frame and must be free
	 * to filter and sort it: the tag list is `CollectionService`'s and is the whole DataModel's.
	 *
	 * **Read by `DodgeService` once a frame for the length of one dodge**, which is what `PERFECT_DISTANCE`
	 * and `PERFECT_WINDOW_SECONDS` are measured against — it is the only reader, and it is why this belongs
	 * here rather than being enumerated by the caller: "which of these is a ball" is this file's rule.
	 */
	public armedBalls(): ReadonlyArray<BasePart> {
		const flying = new Array<BasePart>();

		for (const instance of CollectionService.GetTagged(BALL_TAG)) {
			if (!instance.IsA("BasePart")) continue;
			if (instance.Parent !== Workspace) continue;
			if (instance.GetAttribute("Armed") !== true) continue;

			flying.push(instance);
		}

		return flying;
	}

	/**
	 * The launch point to plan from.
	 *
	 * Normally the thrower's own, because that is the one their aim guide was
	 * drawn from. Checked rather than trusted: a client can claim any point it
	 * likes, so a claim that does not look like a stale copy of the hand the
	 * server can see is discarded and the muzzle we can see is used instead.
	 */
	private acceptLaunch(own: Vector3, claimed: Vector3 | undefined): Vector3 {
		if (!claimed) return own;

		const offset = claimed.sub(own).Magnitude;
		if (offset <= MUZZLE_TOLERANCE) return claimed;

		logWarn(`[Ball] ignoring a launch point ${string.format("%.1f", offset)} studs from the thrower's hand`);
		return own;
	}

	/**
	 * Formats a plan's launch for the debug print: the in-plane flight, plus the
	 * sideways part of it when there is one.
	 *
	 * Reports the **commanded** velocity — the one actually written to the ball,
	 * boost included — because that is the input whose effect is worth watching.
	 * The in-plane figure is still the honest one for speed: a curve's sideways
	 * launch is not part of how fast the throw travels, it is what bends it, and
	 * printing the raw vector made a curveball read as the fastest throw in the
	 * game at 265 studs/s when the throw itself was only doing 95.
	 */
	private describeThrow(plan: LaunchPlan, commanded: Vector3): string {
		const sideways = plan.acceleration.Magnitude > 0.001 ? plan.acceleration.Unit : undefined;
		const inPlane = sideways ? commanded.sub(sideways.mul(commanded.Dot(sideways))) : commanded;

		const horizontal = new Vector3(inPlane.X, 0, inPlane.Z);
		const angle = math.deg(math.atan2(inPlane.Y, horizontal.Magnitude));
		const travel =
			`${string.format("%.1f", inPlane.Magnitude)} studs/s at ${string.format("%.1f", angle)}deg`;

		if (!sideways) return travel;

		return `${travel} + ${string.format("%.1f", math.abs(commanded.Dot(sideways)))} sideways`;
	}

	/**
	 * Applies the constant force a curveball flies under.
	 *
	 * This is the part that cannot be done with a velocity. A ball thrown in a
	 * straight line is a ball travelling in a straight line, however hard it is
	 * thrown; bending it takes a force acting *during* the flight. The plan solved
	 * the launch so the drift this force accumulates is cancelled by the time the
	 * ball arrives, which is why the throw still lands where the thrower was told it
	 * would — on the gap the guide drew, for a rig; on the marker, for a player.
	 *
	 * **A removal timed from a flight the plan states rather than one this side measures**, and the two kinds
	 * of throw state it differently: an aimed one has a distance to the target and divides it by its own
	 * along-aim speed, while a charged one has no target and uses the ballistic figure, `2·v·sin θ / g`. Both
	 * are exact over level ground and both are approximations over ground that slopes — see
	 * `planChargedThrow` for what the second one gives up and why there is nothing better available without
	 * knowing where the ground is.
	 *
	 * A no-op for a throw with no bend in it, which is every throw but a curve.
	 */
	private applyAcceleration(ball: BasePart, acceleration: Vector3, flightTime: number) {
		if (acceleration.Magnitude < 0.001) return;

		// Parented to the ball, so it can never outlive the projectile it belongs
		// to — the same trick `CollisionIgnore` uses.
		const attachment = new Instance("Attachment");
		attachment.Parent = ball;

		const force = new Instance("VectorForce");
		force.Attachment0 = attachment;
		// Without this the force is applied where the attachment sits, which is
		// not the centre of mass, and it spins the ball like an off-centre
		// thruster instead of curving it.
		force.ApplyAtCenterOfMass = true;
		force.RelativeTo = Enum.ActuatorRelativeTo.World;
		force.Force = acceleration.mul(ball.GetMass());
		force.Parent = attachment;

		// The curve belongs to the flight. Left attached once the ball has landed
		// it would keep shoving it sideways along the ground, at a constant
		// acceleration, for the rest of its lifetime.
		task.delay(flightTime + 0.1, () => force.Destroy());
	}

	/**
	 * Settles the balls lying on the floor: slows the ones that are rolling, and stops the
	 * ones that have stopped.
	 *
	 * **The engine does not slow a rolling ball down.** A ball rolling without slipping has
	 * no relative motion at the point of contact, so friction has nothing to act on and
	 * almost none of the ball's energy leaves it — measured here, and the reason raising
	 * `GROUND_FRICTION` barely changed how long a ball rolled. So the resistance is applied
	 * from outside: `ROLL_RESISTANCE` comes off every grounded ball's speed each pass, and
	 * the last studs a second are finished off with a freeze.
	 *
	 * **A ball in the air is not touched, at any speed.** The guide's arc is a promise about
	 * where the ball goes, and changing its velocity in flight would break it — see
	 * {@link isOnGround} for how the two cases are told apart.
	 *
	 * A loop rather than a `Heartbeat` connection, like the other long-lived loops in this
	 * project, and it takes the cheap turn while the floor is empty.
	 */
	private settleLooseBalls(): void {
		let last = os.clock();

		while (true) {
			const now = os.clock();
			const dT = now - last;
			last = now;

			let loose = 0;

			for (const instance of CollectionService.GetTagged(BALL_TAG)) {
				if (!instance.IsA("BasePart")) continue;

				// Held, being carried, or out of the world: all still somebody's, none of them
				// the floor's business. The parent is the same test a catch and a pickup both
				// use, for the same reason.
				if (instance.Parent !== Workspace) {
					// **And a ball that has left the world has left the bay timer behind** — caught, put in a hand, or
					// parked. The map is keyed on the instance and would otherwise pin it, and a ball that comes back
					// out of a hand starts its next flight with a fresh deadline rather than the last one's.
					this.leftBayAt.delete(instance);

					continue;
				}

				// **A ball being pulled into a hand is not a loose ball.** It has a destination, so none of this
				// applies: the bay rule would destroy it mid-flight, and the rolling resistance below would fight the
				// constraint for the same body. See `pulling`.
				if (this.pulling.has(instance)) continue;

				// **A drill's ball dies at the edge of the bay it was thrown in, and this is the only place that
				// happens.** The sweep is where it belongs rather than a listener on the ball: this loop already walks
				// every loose ball ten times a second for the rolling resistance below, so the check costs one attribute
				// read on a loop that exists — and a `Touched`-based version would miss the case that matters most, a
				// ball that leaves a bay without touching anything.
				//
				// **Before the settle, because it is a question about where the ball is rather than about how it is
				// rolling**, and because a ball about to be destroyed should not be given a frame of deceleration first.
				//
				// **`insideAnyBay` answers `true` when no bay exists anywhere**, which is the half that stops this from
				// eating every ball in a place file that has none — there is nothing for a ball to be out of bounds of.
				// And it is a *footprint* test, so a ball at head height just after the release still counts as inside;
				// a three-dimensional test here destroyed balls at the muzzle, which is the bug `npc/practiceBay.ts`
				// records at length.
				//
				// **The poof is the ordinary one, anchored to the ball's own CFrame**, because a ball is a `BasePart`
				// rather than a `Model` and has no body for `playSpawnPoof` to find a torso on. Without the anchor the
				// burst would be played at the world origin.
				if (instance.GetAttribute(THROWN_FROM_BAY_ATTRIBUTE) === true) {
					// **Inside a bay the deadline is cleared, so re-entry really does save the ball.** Writing this before
					// the destroy check rather than only where the ball is outside is what makes it a deadline rather
					// than a lifetime: a ball that comes back and leaves again starts the five seconds over.
					if (insideAnyBay(instance.Position)) {
						this.leftBayAt.delete(instance);
					} else {
						// **The grace period, and it is here because item 76 made a drill's ball catchable.** The rule
						// used to destroy the ball the instant it crossed the bay edge — the same tenth of a second in
						// which a player might have been reaching for it. See `NPC_CONFIG.BAY_DESPAWN_GRACE_SECONDS`
						// for why five seconds and `leftBayAt` for why a map rather than an attribute.
						const leftAt = this.leftBayAt.get(instance);

						if (leftAt === undefined) {
							this.leftBayAt.set(instance, now);
						} else if (now - leftAt >= NPC_CONFIG.BAY_DESPAWN_GRACE_SECONDS) {
							// TEMPORARY — remove with `practiceBay`'s trace once the log has been read. **Still the line
							// that proves a ball was destroyed mid-air**, now with the wait that preceded it.
							if (TRACE_BAY_DESPAWN) {
								logInfo(
									`[Catch] ${instance.Name}: DESTROYED ${string.format("%.1f", now - leftAt)}s after ` +
										`leaving the bay — Armed ${tostring(instance.GetAttribute("Armed"))}, ` +
										`${string.format("%.0f", instance.AssemblyLinearVelocity.Magnitude)} studs/s`,
								);
							}

							this.leftBayAt.delete(instance);
							playSpawnPoof(undefined, instance.CFrame);
							instance.Destroy();
						}

						continue;
					}
				}

				// **A MultiBall window's spent throw goes once it is on the floor**, and this is the loop that knows
				// where the floor is. The marker is written at the throw (`BALL_DESPAWN_ON_LAND_ATTRIBUTE`): four of a
				// window's five balls carry it, and the throw that closed the window does not.
				//
				// **Why the destroy is not in `BallComponent`'s world branch, which is where the throw ends.** The end
				// of a throw is not the end of the fall: a tagged throw can be finished by another *ball* — a rig
				// holding one, a spent one underfoot — so that branch can run at chest height a frame after the tag,
				// and a destroy there made the thrown ball vanish on the model it had just hit. The report was exactly
				// that: a ball tagged a rig at `17.860` and was gone by `17.877`, ended on a `DodgeballBall` in the
				// rig's hand. This sweep already walks every loose ball and already owns `isOnGround`, so the ball is
				// allowed to fall and is taken when it is resting on something — with the ordinary spawn poof, anchored
				// to the ball's own `CFrame` for the reason the bay's despawn below gives.
				//
				// **`Armed !== true` as well as on the ground**, because the marker survives the throw: a ball must not
				// be taken at the instant of a ground contact it is still armed through. A marked ball on the floor is
				// always disarmed — the world branch does that — and a marked ball still falling is skipped here and
				// counted as loose below, so the loop keeps its tenth-of-a-second turn while it is in the air.
				if (
					instance.GetAttribute(BALL_DESPAWN_ON_LAND_ATTRIBUTE) === true &&
					instance.GetAttribute("Armed") !== true &&
					this.isOnGround(instance)
				) {
					logDebug(`[Ball] ${instance.Name}: despawned on landing — a MultiBall throw with the window open`);

					// The bay timer is keyed on the instance, the same pin this loop clears for a ball that leaves
					// the world; a ball destroyed here must not leave a row behind.
					this.leftBayAt.delete(instance);
					playSpawnPoof(undefined, instance.CFrame);
					instance.Destroy();

					continue;
				}

				loose++;
				this.settleBall(instance, dT);
			}

			task.wait(loose === 0 ? SETTLE_IDLE_PERIOD : SETTLE_PERIOD);
		}
	}

	/**
	 * Settles one loose ball over `dT` seconds: the resistance while it rolls, the freeze
	 * once it has stopped.
	 *
	 * The vertical part of the velocity is left alone throughout. What a grounded ball is
	 * doing downwards is the floor's business, and what it is doing upwards is a bounce —
	 * `ELASTICITY`'s, not this function's.
	 */
	private settleBall(ball: BasePart, dT: number): void {
		if (!this.isOnGround(ball)) return;

		const velocity = ball.AssemblyLinearVelocity;
		const speed = new Vector3(velocity.X, 0, velocity.Z).Magnitude;

		// Stopped, or as good as stopped: take what is left of it, spin included. A ball that
		// is travelling nowhere can still be turning, and the contact solver walks a spinning
		// ball along the floor a frame at a time — the same twitch seen from the other end.
		if (speed < BALL_CONFIG.MIN_SPEED) {
			ball.AssemblyLinearVelocity = Vector3.zero;
			ball.AssemblyAngularVelocity = Vector3.zero;
			return;
		}

		// Rolling: the resistance is a deceleration, so this is the speed to take off it. The
		// `math.max` is what makes a slow roll stop dead instead of creeping up on the
		// threshold — the deceleration reaches zero exactly, so nothing is snapped.
		const retained = math.max(0, speed - BALL_CONFIG.ROLL_RESISTANCE * dT) / speed;

		ball.AssemblyLinearVelocity = new Vector3(velocity.X * retained, velocity.Y, velocity.Z * retained);

		// The spin comes down by the same fraction, and it has to. A ball whose rotation no
		// longer matches its travel is a ball slipping on the floor, and friction would spend
		// the next frame turning that slip back into travel — the ball would speed up again.
		ball.AssemblyAngularVelocity = ball.AssemblyAngularVelocity.mul(retained);
	}

	/**
	 * Whether `ball` is resting on something.
	 *
	 * Asked as a short ray straight down, **not** as "its vertical velocity is small".
	 * That test reads correctly on a ball sitting on a floor and is wrong everywhere the
	 * vertical velocity is only *momentarily* zero — the top of every bounce, and the
	 * apex of a throw aimed upward, where a slow-rising lob has no vertical speed either.
	 * The same test that frees a rolling ball would therefore freeze that lob in mid-air
	 * and hold it there. A ray cannot be fooled that way: at the apex there is nothing
	 * under the ball to find.
	 *
	 * Only the ball itself is excluded from the ray. The floor it is standing on is
	 * exactly what is being looked for.
	 */
	private isOnGround(ball: BasePart): boolean {
		const params = new RaycastParams();
		// **`ExcludeInstances`, as in `dropReach` above** — the pair it replaces is deprecated, and this is
		// the last of them in the project.
		params.ExcludeInstances = [ball];
		params.IgnoreWater = true;

		const probe = new Vector3(0, -GROUND_PROBE, 0);

		return Workspace.Raycast(ball.Position, probe, params) !== undefined;
	}
}
