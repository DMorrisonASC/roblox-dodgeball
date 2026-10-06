import { Service, OnStart } from "@flamework/core";
import { CollectionService, Players, ReplicatedStorage, RunService, Workspace } from "@rbxts/services";
import {
	ARMED_ABILITY_ATTRIBUTE,
	BALL_ABILITY_ATTRIBUTE,
	BALL_SIZE,
	PICKUP_LOCKED_UNTIL,
	THROWER_TOKEN,
	THROW_ENABLED,
} from "shared/constants";
import { NPC_TAG } from "../../npc/Behavior";
import { BALL_CONFIG } from "shared/config/ball.config";
import { DEBUG_CONFIG } from "shared/config/debug.config";
import { SOUND_CONFIG } from "shared/config/sound.config";
import { abilityOn, isBallAbility, AbilityKind } from "shared/ability";
import { CollisionIgnore } from "shared/CollisionIgnore";
import { REMOTES } from "shared/remotes";
import { events } from "shared/networking";
import { planPlayerThrow, getThrowMuzzle, describeMuzzle } from "shared/throw";
import { LaunchPlan, ThrowArc, leftAxis } from "shared/Trajectory";
import { scheduleBallExpiry } from "./ballExpiry";
import { BallTrail } from "./BallTrail";
import { emitSound } from "./SoundEmitter";
import { DevService } from "../../dev/DevService";
import { SuperService } from "../super/SuperService";
import { EconomyService } from "../economy/EconomyService";
import { FreezeService } from "../actions/FreezeService";
import { BallFactory } from "./BallFactory";
import { watchThrow } from "./ThrowProbe";

const DEBUG = true; // prints the mode, speed and angle of each throw

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
	return new Vector3(0, half * Workspace.Gravity, 0).sub(acceleration.mul(half));
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
	 * handed-out one does — otherwise it could not be thrown afterwards. The only
	 * thing that genuinely needs a `Player` is the throw remote's handler, which
	 * recovers the character from it; everything else is model work.
	 */
	private readonly heldBalls = new Map<Model, HeldBall>();

	constructor(
		private readonly factory: BallFactory,
		private readonly dev: DevService,
		private readonly abilities: SuperService,
		private readonly freezes: FreezeService,
		private readonly economy: EconomyService,
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
			if (DEBUG) print(`[Ball] ${player.Name}: InfiniteBalls ${on ? "on" : "off"}`);

			if (!on) return;

			const character = player.Character;
			if (!character || this.getHeldBall(character)) return;

			this.giveBall(character);

			if (DEBUG) print(`[Ball] ${character.Name}: handed a ball by InfiniteBalls`);
		});
	}

	onStart() {
		this.throwRemote = this.createThrowRemote();
		this.throwRemote.OnServerEvent.Connect((player, target, arc, claim) => {
			// Whether this player throws at all, asked before anything else in here: a click that
			// is not meant to throw should not reach the part of this that reads a direction and
			// solves an arc. Only an explicit `false` blocks — a player who has never pressed the
			// key has no attribute and throws as before. See `THROW_ENABLED`.
			if (player.GetAttribute(THROW_ENABLED) === false) {
				if (DEBUG) print(`[Ball] ${player.Name}: throw refused — throwing is switched off`);
				return;
			}

			if (!typeIs(target, "Vector3")) return;

			// **The client's arc, whitelisted — and all three shapes have to be in this list.**
			//
			// This is where the arcing throw was being lost. `overhead` was missing, so the one arc
			// the player has a key for — X — arrived as a word this did not recognise and was quietly
			// replaced with `straight`. The reasoning this list was originally written on was that a
			// fallback costs nothing, because all three arcs reach the same point — and that half
			// holds: the ball still landed on the mark. It flew a flat line to get there instead of
			// the arc the guide was drawing, which is the single failure this whole arrangement exists
			// to prevent — `planPlayerThrow` is called by both sides so their plans cannot differ, and
			// this branch defeated it upstream of the solve. The tell was a log with `overhead` on the
			// client's line and `straight` on the server's, describing one throw.
			//
			// Anything genuinely unrecognised still falls back to `straight`, which is what a fresh
			// client starts on — see `ThrowController.arc` — so a race or a malformed value gets the
			// shape the player's own guide is already drawing, rather than one it is not.
			//
			// That case now says so instead of passing silently. A shape replaced without a word is
			// exactly how the missing branch above stayed hidden, and this is a line only this side
			// of the wire can report on: the client's own report of its arc is correct and always
			// will be, because the fault is here.
			let chosen: ThrowArc = "straight";
			if (arc === "straight") {
				chosen = "straight";
			} else if (arc === "overhead") {
				chosen = "overhead";
			} else if (arc === "curve") {
				chosen = "curve";
			} else {
				warn(`[Ball] ${player.Name}: threw with an unknown arc (${tostring(arc)}) — used ${chosen}`);
			}

			this.throwForPlayer(player, target, chosen, typeIs(claim, "Vector3") ? claim : undefined);
		});

		// **The ability key, and the whole of its server half.** Both of the questions this handler asks
		// are this service's: where the *ball* is (it owns hands) and what this player *may* do (it holds
		// the dev flags). The service that counts the charge is told the outcome and never asked to find a
		// ball — see {@link markHeldBall} for the line between the two.
		events.Server.OnEvent("markHeldBall", (player, kind) => this.markHeldBall(player, kind));

		// **The second ability key, and the other thing a press can mean.** A press of `4` marks nothing:
		// it buys a *window* on the player, which is a fact with no ball to ride and therefore no kind to
		// carry. See {@link activateMultiBall}, which is the whole of the handler — and note that it is
		// here rather than in `SuperService` for the same split the mark handler above documents: this
		// service owns hands and dev flags, that one counts charges and never touches a ball.
		events.Server.OnEvent("multiBall", (player) => this.activateMultiBall(player));

		Players.PlayerRemoving.Connect((player) => {
			const character = player.Character;
			if (character) this.heldBalls.delete(character);
		});

		// The settle check — the only thing in the game that watches a ball *after* it has
		// landed. Started here rather than on the first throw because it has no starting
		// condition: it looks at the world rather than at this service's lists, so a ball
		// left on the floor in Studio is covered by the same loop as a thrown one.
		task.spawn(() => this.settleLooseBalls());
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
	 * Welds `ball` into `model`'s hand as a **catch**: a ball taken out of the air.
	 *
	 * Named for the intent rather than the mechanism, which is
	 * {@link attachToHand}'s. The two are one line apart today and are kept apart
	 * on purpose: the moment a catch grows something a pickup does not — an
	 * animation, a grace frame, its own telemetry — the seam is already there, and
	 * until then it costs nothing.
	 *
	 * **This is where a catch is confirmed, and it is worth being exact about why, because both
	 * neighbouring candidates are wrong.** `attachToHand` is the wider door: the hand-out on join and
	 * the pickup off the floor come through it too, and it has no idea which of the four it was called
	 * for, so a sound there would play on every spawn and every ball collected. And a catch is not
	 * confirmed anywhere in `CatchService` — `attemptCatch` opens a window that most attempts never
	 * spend, and `consume`, the other plausible hook, is *also* how a window is dropped on expiry, on
	 * death and on a dev's flag going off. Neither of those is a catch.
	 *
	 * What makes this the site is the return below: everything after it is reached only when the weld
	 * succeeded, so it runs exactly once per ball that really did end up in a hand. A catch refused for
	 * a missing right hand returns before the sound, which is the behaviour worth having — the sound is
	 * a report, and there is nothing to report.
	 */
	public catchBall(model: Model, ball: BasePart): boolean {
		if (!this.attachToHand(model, ball)) return false;

		print(`[Ball] ${model.Name} caught a dodgeball`);

		// The ball's own position, which is the catcher's hand by now: `attachToHand` has just placed
		// it at the grip and welded it there. Asked of the ball rather than looked up from the hand,
		// because the ball is the instance this method already holds — no second lookup, and no way
		// for the two to be talking about different places.
		emitSound(ball.CFrame, model.Name, SOUND_CONFIG.CATCH, CATCH_EMITTER_NAME);

		return true;
	}

	/**
	 * Welds `ball` into `model`'s hand as a **pickup**: a ball collected off the
	 * ground.
	 *
	 * The same hand either way, which is the point: a picked-up ball is thrown by
	 * the same call as a caught one, because by the time it is in the hand there is
	 * nothing left to tell the two apart.
	 */
	public pickupBall(model: Model, ball: BasePart): boolean {
		if (!this.attachToHand(model, ball)) return false;

		print(`[Ball] ${model.Name} picked up a dodgeball`);

		return true;
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
		if (abilityOn(ball) !== undefined) {
			// **The entry goes before the instance**, for `removeBall`'s reason: `isHeld` answers from
			// this map, and a destroyed ball still answering `true` is a ball two other systems can
			// still see and act on.
			this.heldBalls.delete(model);

			// The dropper, when there is one. A rig can never mark a ball — it has no key to press —
			// so this is the ordinary path with a guard rather than a case being handled: an NPC
			// dropping a ball forfeits nothing because there is nothing on it to forfeit.
			const player = Players.GetPlayerFromCharacter(model);
			if (player) this.abilities.forfeitCharge(player);

			ball.Destroy();

			if (DEBUG) print(`[Ball] ${model.Name} dropped a marked dodgeball — it is destroyed`);

			// **And an open MultiBall window fills the hand the marker emptied.** These two rules are
			// deliberately different and must not be made consistent: the *mark* is the ball's, so losing
			// the ball forfeits the charge above; the *window* is the player's, so losing a ball does not
			// touch it. A player holding both — a Pierce mark on the ball and a window running — keeps the
			// window and loses the mark, which is what it means for one ability to live on a thing and the
			// other to live on a person. Free rather than paid, because nothing was thrown: see
			// {@link refillFromBuff}.
			this.refillFromBuff(model, false);

			return true;
		}

		// Out of the hand first, so the weld is not fighting the reparent below.
		ball.FindFirstChild(GRIP_NAME)?.Destroy();

		// Nobody's ball now: unarmed, because an armed ball is a live projectile and
		// would hurt whoever walked into it lying there.
		ball.SetAttribute("Armed", false);
		ball.Parent = Workspace;
		ball.Massless = false;
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

		// Loose balls are cleaned up on the clock thrown ones are. A catching NPC
		// drops every ball it takes, so without this the map collects scenery for the
		// rest of the session; the `isHeld` guard inside leaves a ball that has since been
		// caught to its new owner.
		scheduleBallExpiry(ball, BALL_CONFIG.LIFETIME_SECONDS, (expiring) => this.isHeld(expiring));

		if (DEBUG) print(`[Ball] ${model.Name} dropped a dodgeball`);

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

		if (DEBUG) print(`[Ball] ${model.Name}'s ball was destroyed`);

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
		// The same hand the ball was placed at, asked of the factory rather than looked up again
		// here: one rig-type rule, in one file, for both the placing and the welding.
		const hand = this.factory.getRightHand(model);
		if (!hand) {
			warn(`[Ball] ${model.Name}: could not find a right hand to hold the ball`);
			ball.Destroy();
			return false;
		}

		// Respawn safety, and catching safety: whatever this model was already
		// holding goes, so two balls can never end up sharing one hand.
		this.heldBalls.get(model)?.ball.Destroy();
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
		ball.Massless = true;
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

			if (DEBUG) print(`[Super] ${owner.Name}: ${ball.Name} took up the armed ${armed}`);
		}

		// The trail stays off until the throw — otherwise it hangs off the hand every time
		// the holder walks around. A ball that is caught keeps the ribbons it flew with,
		// disarmed and hidden by the same call, rather than being given a second set: two
		// sets on one ball would be twice the density at twice the cost, and would throw off
		// the angles the cross-section is built from. Nothing is built at all when the trail
		// is switched off — see `BallTrail.attach`.
		const trail = BallTrail.attach(ball);

		this.setPromptEnabled(ball, false);

		// The weld, and the one thing about a held ball the factory deliberately left alone: it is
		// configured for the hand, but being *in* it is this service's business.
		const grip = new Instance("WeldConstraint");
		grip.Name = GRIP_NAME;
		grip.Part0 = hand;
		grip.Part1 = ball;
		grip.Parent = ball;

		this.heldBalls.set(model, { ball, trail });

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
		params.FilterType = Enum.RaycastFilterType.Exclude;
		params.FilterDescendantsInstances = [model, ball];
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
	 * Nothing creates a prompt today — balls are handed out rather than picked up —
	 * so this does nothing yet. The hook is here so that a ball which grows one is
	 * still only offered while it is lying on the ground.
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
	 * Throws whatever `model` is holding, at `target`.
	 *
	 * Keyed on the **model**, so an NPC's throw is this function with a different
	 * model and target in it rather than a second copy of the throw. The only
	 * player-shaped thing left in here is the remote handler below — the one place a
	 * `Player` exists to take a character from — plus the dev check that lets a
	 * flagged dev throw with an empty hand.
	 *
	 * **Throwing empties the hand.** A ball comes from the hand-out on join, from a
	 * pickup, from a catch — or, for a dev with `InfiniteBalls`, from the throw they
	 * just made, which is the one throw in the game that answers itself. Everyone else
	 * fetches the next one, which is what the loose balls on the floor are for.
	 *
	 * Returns whether a ball went. An empty hand is not an error: a behavior may
	 * ask while there is nothing to throw.
	 */
	public throwBall(model: Model, target: Vector3, arc: ThrowArc, claimedLaunch?: Vector3): boolean {
		// **A frozen body does not throw, and the gate is here rather than on the remote.** `throwBall` is
		// the only thing in the game that throws — a player's click and a rig's behavior both arrive here,
		// which is `ActionService`'s own note about where a throw gate belongs — so a check in the remote
		// handler would leave a frozen NPC throwing at whatever it happened to be facing.
		//
		// It answers `false`, which is the same answer an empty hand gets. That matters twice: a behavior
		// asking on a timer does nothing with either, and `throwForPlayer` spends the charge only when a
		// ball actually left — so a frozen player loses nothing for the throw they could not make.
		if (this.freezes.isFrozen(model)) {
			if (DEBUG) print(`[Ball] ${model.Name}: throw refused — frozen`);

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
		this.setPromptEnabled(ball, true);
		// Airborne now, so the rod can start drawing behind it. Absent when the trail is
		// switched off in config, which is the whole of what that flag does at runtime.
		held.trail?.setArmed(true);

		// The client runs this exact same plan to draw its aim guide, so the throw
		// and the predicted arc can never disagree — which only holds while both
		// sides solve from the same launch point, see `planPlayerThrow`.
		const releasePosition = ball.Position;
		const ownLaunch = getThrowMuzzle(model);
		const launch = this.acceptLaunch(ownLaunch, claimedLaunch);
		const plan = planPlayerThrow(model, target, arc, launch);

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
		// frame a miss is measured in — `forward` is the line to the mark, `left` is the axis a curve
		// bows on, `up` is world up. Untouched when all three are zero, so the zero case is the launch
		// the plan asked for, exactly.
		const nudge = launchNudge();
		const nudged = nudge.forward !== 0 || nudge.left !== 0 || nudge.up !== 0;

		const placement = nudged
			? plan.origin
					.add(new Vector3(plan.velocity.X, 0, plan.velocity.Z).Unit.mul(nudge.forward))
					.add(leftAxis(plan.origin, target).mul(nudge.left))
					.add(new Vector3(0, nudge.up, 0))
			: plan.origin;

		if (DEBUG) {
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

			print(
				`[Ball] ${model.Name}: ${plan.arc} ${this.describeThrow(plan, commanded)}, ` +
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
		if (abilityOn(ball) === "Pierce") {
			const bodies = this.pierceBodies(model);

			for (const body of bodies) CollisionIgnore.between(ball, body);

			if (DEBUG) {
				print(
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
		if (DEBUG) this.reportOwnership(ball, model);

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

		ball.CanCollide = true;
		// **And the query half comes back with it**, which is the other end of `attachToHand`'s
		// `CanQuery = false`: from here the ball is a thing in the world, and a sweep is entitled to stop on
		// it rather than passing through it because it used to be in somebody's hand.
		ball.CanQuery = true;
		ball.Massless = false;
		// After `Massless`, never before: the force is sized from the ball's
		// mass, and a massless ball reads zero and gets nothing.
		this.applyAcceleration(ball, plan.acceleration, plan.flightTime);

		// How far the engine's flight actually is from the plan's, per throw.
		// Behind the verbosity gate as well: the probe watches every throw per frame, and it costs
		// the very frame time it is reporting on. See `shared/config/debug.config.ts`.
		if (DEBUG && DEBUG_CONFIG.VERBOSE_LOGS) watchThrow(ball, plan, model);



		this.heldBalls.delete(model);

		// A thrown ball is on the ordinary clock: it goes when nobody has picked it up in time, and
		// the guard inside is what leaves a ball that has been caught since to its new owner. See
		// `scheduleBallExpiry`, which is the one place a ball's lifetime is decided.
		scheduleBallExpiry(ball, BALL_CONFIG.LIFETIME_SECONDS, (expiring) => this.isHeld(expiring));

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

		// A dev with `InfiniteBalls` never runs out: the throw they just made is answered
		// with another ball, by the same call the first one arrived by. This is the one
		// throw in the game that refills itself — every other thrower fetches its next
		// ball, which is what the loose balls on the floor are for. It is not the only way
		// in: switching the flag on gives an empty hand a ball too, which is what a dev who
		// has just thrown their last one actually needs. See the constructor.
		if (this.hasInfiniteBalls(model) && !this.getHeldBall(model)) {
			this.giveBall(model);

			if (DEBUG) print(`[Ball] ${model.Name}: refilled by InfiniteBalls`);
		}

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
	 * One line per throw, behind `DEBUG`, like the launch line above it. Delete it once the hand-off is
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
				print(`[Ball] ${thrower.Name}: flight ownership — never read, the ball was gone within a frame`);

				return;
			}

			const owner = ball.GetNetworkOwner();

			if (owner === undefined) {
				connection.Disconnect();

				const settling = frame === 1 ? "" : ` (took ${frame} frames)`;
				print(`[Ball] ${thrower.Name}: flight owned by the server${settling}`);

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

			print(
				`[Ball] ${thrower.Name}: flight owned by ${owner.Name} two frames in — it is being stepped at ` +
					`that machine's rate while the boost was derived from ours (canSet ${canSet}${refusal})`,
			);
		});
	}

	/**
	 * The whole of the `4` key's server half: buys `player` a MultiBall window.
	 *
	 * **The handler is here and the state is in `SuperService`**, which is {@link markHeldBall}'s split
	 * for its reason — this service owns hands and holds the dev flags, and that service counts charges
	 * and has never touched a ball. The two handlers are deliberately the same shape for a second
	 * reason: two ability keys that behave differently when refused would be two rules about what a key
	 * press means.
	 *
	 * **Four questions, in the order that costs least to answer, and every refusal is a print** rather
	 * than a thrown error, for `markHeldBall`'s reason: a key press is not a fault, and the log is where
	 * the reason belongs.
	 *
	 * **What a press commits the player to is the one place the two abilities part company.** A mark
	 * waits for a ball and spends nothing; this spends the charge on the spot and starts the clock, so a
	 * player who presses `4` and throws nothing has still paid for the ten seconds they did not use. See
	 * `SuperService.activateMultiBall`, where that decision is argued.
	 */
	private activateMultiBall(player: Player): void {
		// **A living body**, the same test the mark makes and the throw makes in effect: there is no hand
		// to fill and no player to put a clock on.
		const character = player.Character;
		const humanoid = character?.FindFirstChildWhichIsA("Humanoid");
		if (!character || !humanoid || humanoid.Health <= 0) {
			if (DEBUG) print(`[Super] ${player.Name}: MultiBall refused — no living body`);

			return;
		}

		const dev = this.dev.isDev(player);

		// **MultiBall has to be owned too**, which is the same lock the marks carry: the window is a power
		// unlocked by the chest, and this is where an unowned one is refused. A dev bypasses it as they
		// bypass the round gate and the charge below.
		if (!dev && !this.economy.ownsPower(player, "MultiBall")) {
			if (DEBUG) print(`[Super] ${player.Name}: MultiBall refused — not owned`);

			return;
		}

		// **A dev is exempt from the round gate, and that exemption is the shortcut's whole point** — a
		// standing start in Studio is usually an intermission with no round running at all. Asked of
		// `SuperService` rather than read from the status folder here, so the rule that grants a charge
		// and the rule that lets one be spent stay one line in one file, exactly as the mark does it.
		if (!dev && !this.abilities.isRoundActive()) {
			if (DEBUG) print(`[Super] ${player.Name}: MultiBall refused — no round is being played`);

			return;
		}

		// **The charge, or the dev bypass.** A dev opens a window holding no charge of their own, which is
		// what makes this testable from a standing start — the mark handler's shortcut, on the other key.
		const charged = this.abilities.hasCharge(player);
		if (!charged && !dev) {
			if (DEBUG) print(`[Super] ${player.Name}: MultiBall refused — no charge`);

			return;
		}

		// **A second press is refused rather than restarted**, and the answer is the "no" the mark handler
		// gives a second mark: the player has asked for something they already have, and one charge does
		// not buy two windows. Returned as a boolean by the service rather than asked as a question here,
		// because opening a window and answering whether one was opened are the same act.
		if (!this.abilities.activateMultiBall(player)) {
			if (DEBUG) print(`[Super] ${player.Name}: MultiBall refused — a window is already open`);

			return;
		}

		// **A dev opens windows without earning them**, so there is nothing of theirs to spend — the same
		// bypass `throwForPlayer` applies to a mark, applied here to the same kind of press. Asked at the
		// call site rather than inside `SuperService` for the reason that one gives: only the caller knows
		// who pressed.
		if (!dev) this.abilities.spendCharge(player);

		// **And the hand is filled on the way in**, which is one of the two free refills: a player who
		// opens a window on an empty hand cannot use the ten seconds they have just paid for. See
		// {@link refillFromBuff}.
		this.refillFromBuff(character, false);
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
	 * **Nothing here marks anything, and that is the ability rather than an omission.** The ball this
	 * hands over comes from the same `giveBall` a hand-out uses, so it is an ordinary ball in every way:
	 * catchable, taggable, pickable, and carrying no ability of its own.
	 *
	 * **The callers, and why this is one method rather than three:** the end of a throw (paid), the
	 * activation handler (free), and both ways out of {@link dropBall} (free). Every one of them is a
	 * moment at which a hand that should have a ball might not, which is the single condition this
	 * answers.
	 */
	private refillFromBuff(model: Model, spent: boolean): boolean {
		const player = Players.GetPlayerFromCharacter(model);
		if (!player) return false;

		// Nothing to fill. A hand holding a ball is not a hand this has any business in — which is also
		// what stops a window opened by a player who is already holding one from spending the count.
		if (this.getHeldBall(model)) return false;

		if (spent && !this.abilities.consumeMultiBallBall(player)) return false;

		// Asked after the spend: the throw is paid for either way, and what the window still holds decides
		// whether this ball is replaced. See this method's doc for why `5` has to mean five throws.
		if (!this.abilities.hasMultiBallBalls(player)) return false;

		this.giveBall(model);

		if (DEBUG) print(`[Super] ${model.Name}: MultiBall supplied a ball`);

		return true;
	}

	/**
	 * Every body a Pierce ball thrown by `model` should pass through.
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
	 * the veto remains the single statement of the rule — and with the side test gone, the mark handler is
	 * the only thing in this file that still asks `SuperService` whether a round is running.
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
			if (rig.IsA("Model")) consider(rig);
		}

		return bodies;
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
	private throwForPlayer(player: Player, target: Vector3, arc: ThrowArc, claimedLaunch?: Vector3) {
		const character = player.Character;
		if (!character) return;

		// **Read before the throw, because the throw empties the hand.** `throwBall` deletes the entry
		// this asks for, so the marked ball has to be identified while it is still in the hand — and
		// only the answer is kept: the marker rides the throw by itself, so nothing below needs the
		// instance.
		const marked = abilityOn(this.getHeldBall(character)) !== undefined;

		// A ball that did not go — an empty hand, or a body with no hand to take it from — spends
		// nothing. `throwBall` answers whether anything left, and this is the only caller that cares.
		if (!this.throwBall(character, target, arc, claimedLaunch)) return;

		// **A dev marks a ball without earning it**, so there is nothing of theirs to spend — the bypass
		// {@link markHeldBall} documents. Asked here rather than inside `SuperService` because only the
		// caller knows who threw: that service is told the outcome and never asks who the thrower was.
		if (marked && !this.dev.isDev(player)) this.abilities.spendCharge(player);
	}

	/**
	 * Marks the ball `player` is holding as carrying `kind`.
	 *
	 * **The handler for the ability key, and the whole of what a press does.** Four questions, asked in
	 * the order that costs least to answer, and every refusal is a print rather than a thrown error — a
	 * key press is not a fault, and the log is where the reason belongs.
	 *
	 * **Why the handler is here and not in `SuperService`.** Two of the four questions are this
	 * service's: where the ball is (it owns hands, and `getHeldBall` exists for this) and what a player
	 * may do (the dev flags are already held here). Putting it there would mean `SuperService` depending
	 * on hands — the wrong direction for a service whose whole job is to count two things. As it stands
	 * that service is asked one question, `hasCharge`, and never has to find a ball.
	 *
	 * **The charge is not spent here, deliberately.** See `SuperService.spendCharge`: the charge follows
	 * the ball, so a mark that is never thrown costs nothing, and a player who marks a ball and changes
	 * their mind has not paid for a throw they did not make.
	 */
	private markHeldBall(player: Player, kind: unknown): void {
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
		if (!typeIs(kind, "string") || !isBallAbility(kind)) {
			warn(`[Super] ${player.Name}: mark refused — not an ability a ball can carry (${tostring(kind)})`);
			return;
		}

		// **A living body**, which is the same test the throw makes in effect: a player with no character
		// has no hand to be holding anything in. Not `SPECTATING_ATTRIBUTE` and not a health poll — a
		// spectator has a dead body or none, and the ball is a child of the body either way.
		const character = player.Character;
		const humanoid = character?.FindFirstChildWhichIsA("Humanoid");
		if (!character || !humanoid || humanoid.Health <= 0) {
			if (DEBUG) print(`[Super] ${player.Name}: mark refused — no living body`);

			return;
		}

		// **A dev is exempt from the round gate, and that exemption is the point of the shortcut.** The
		// rule the key exists for is "a dev can exercise this from a standing start", and a standing start
		// in Studio is usually an intermission with no round running at all.
		const dev = this.dev.isDev(player);

		// **The power has to be owned, which is the newest gate and sits before the round's.** A key that
		// marks a ball is a request to use a power the player may not have unlocked yet: the chest grants
		// powers, and this is the lock the chest opens. Asked of `EconomyService`, which owns the roster —
		// the dev bypass skips it exactly as it skips the round gate and the charge.
		if (!dev && !this.economy.ownsPower(player, kind)) {
			if (DEBUG) print(`[Super] ${player.Name}: mark refused — ${kind} not owned`);

			return;
		}

		// **Otherwise, only during a round.** Asked of `SuperService` rather than read from the status
		// folder here, so the rule that grants a charge and the rule that lets one be spent stay one line
		// in one file — a second copy could let a charge be earned in a round a ball could not be marked in.
		if (!dev && !this.abilities.isRoundActive()) {
			if (DEBUG) print(`[Super] ${player.Name}: mark refused — no round is being played`);

			return;
		}

		const ball = this.getHeldBall(character);

		// **No ball in hand, and a dev: the arm goes on the player instead.**
		//
		// This is the whole of the shortcut. A dev in Studio has nothing to mark — no ball is handed out
		// until a round opens, and `InfiniteBalls` is a flag they have to find first — so "mark the held
		// ball" is a rule that cannot be exercised from a standing start. Arming the *player* moves the
		// ability one step earlier: it waits on them, and the next ball that arrives in their hand takes it
		// up. See `attachToHand`, which is where that happens, and {@link ARMED_ABILITY_ATTRIBUTE} for why
		// the arm lives on the player rather than the body.
		//
		// **A non-dev is refused here exactly as before.** The arm is not a second way to mark a ball, it is
		// the dev bypass's second shape — so the refusal below is unchanged, and the order of the two
		// branches does not matter to anybody who cannot already use the shortcut.
		if (!ball) {
			if (!dev) {
				if (DEBUG) print(`[Super] ${player.Name}: mark refused — no ball in hand`);

				return;
			}

			player.SetAttribute(ARMED_ABILITY_ATTRIBUTE, kind);

			if (DEBUG) {
				print(`[Super] ${player.Name}: armed ${kind} — the next ball they take up will carry it`);
			}

			return;
		}

		// Already carrying something, which is a second press of the same key or two presses close
		// together. Not a second ability, and the first mark is not overwritten either: the player has
		// asked for the same thing twice and the answer to that is no.
		if (abilityOn(ball) !== undefined) {
			if (DEBUG) print(`[Super] ${player.Name}: mark refused — the held ball is already marked`);

			return;
		}

		// **The charge, or the dev bypass.** A dev marks a ball holding no charge of their own, which is
		// what makes this testable without six hits in a row first.
		const charged = this.abilities.hasCharge(player);
		if (!charged && !dev) {
			if (DEBUG) print(`[Super] ${player.Name}: mark refused — no charge`);

			return;
		}

		this.setBallAbility(ball, kind);

		if (DEBUG) {
			print(
				`[Super] ${player.Name}: ${ball.Name} marked as ${kind}` +
					`${charged ? " — the charge is still held" : " — dev bypass, no charge held"}`,
			);
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
	 * Whether `model` is a dev who has switched `InfiniteBalls` on.
	 *
	 * Asking about a dev is the only reason a `Player` appears in this file at all —
	 * the flags live on players, and an NPC never has one, so an NPC simply never
	 * takes this branch.
	 */
	private hasInfiniteBalls(model: Model): boolean {
		const player = Players.GetPlayerFromCharacter(model);
		return player !== undefined && this.dev.getFlag(player, "InfiniteBalls");
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
				if (DEBUG) print(`[Ball] ${ball.Name} is still held by ${model.Name}`);
				return true;
			}
		}

		return false;
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

		warn(`[Ball] ignoring a launch point ${string.format("%.1f", offset)} studs from the thrower's hand`);
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
	 * ball arrives, which is why the throw still lands on the mark the guide drew.
	 *
	 * A no-op for every other arc, and for a curve that unfurled into an overhead
	 * throw because the aim had no fall to solve with.
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
				if (instance.Parent !== Workspace) continue;

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
		params.FilterType = Enum.RaycastFilterType.Exclude;
		params.FilterDescendantsInstances = [ball];
		params.IgnoreWater = true;

		const probe = new Vector3(0, -GROUND_PROBE, 0);

		return Workspace.Raycast(ball.Position, probe, params) !== undefined;
	}
}
