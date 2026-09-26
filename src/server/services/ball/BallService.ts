import { Service, OnStart } from "@flamework/core";
import { CollectionService, Players, ReplicatedStorage, Workspace } from "@rbxts/services";
import { BALL_SIZE, THROWER_TOKEN, THROW_ENABLED, PICKUP_LOCKED_UNTIL } from "shared/constants";
import { BALL_CONFIG } from "shared/config/ball.config";
import { DEBUG_CONFIG } from "shared/config/debug.config";
import { CollisionIgnore } from "shared/CollisionIgnore";
import { REMOTES } from "shared/remotes";
import { planPlayerThrow, getThrowMuzzle } from "shared/throw";
import { LaunchPlan, ThrowArc } from "shared/Trajectory";
import { scheduleBallExpiry } from "./ballExpiry";
import { BallTrail } from "./BallTrail";
import { DevService } from "../../dev/DevService";
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

	constructor(private readonly factory: BallFactory, private readonly dev: DevService) {
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

			// Anything unrecognised falls back to the regular throw. All three arcs
			// reach the same point, so a bad value costs the player the shape they
			// asked for and nothing else.
			//
			// The fallback is `straight`, which is what a fresh client starts on — see
			// `ThrowController.arc`. A client that has not sent a valid arc yet (a race, a
			// malformed value) then gets the shape its own aim guide is drawing rather than a
			// different one, and a client whose guide and throw disagreed would be showing the
			// player a line the ball was never going to take.
			let chosen: ThrowArc = "straight";
			if (arc === "straight") {
				chosen = "straight";
			} else if (arc === "curve") {
				chosen = "curve";
			}

			this.throwForPlayer(player, target, chosen, typeIs(claim, "Vector3") ? claim : undefined);
		});

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
	 * this is the game handing one out. `JoinService` calls it for a joining player and an NPC's
	 * throwing behavior calls it for a rig, which is what makes a hand-out the same act for both.
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
	 */
	public catchBall(model: Model, ball: BasePart): boolean {
		if (!this.attachToHand(model, ball)) return false;

		print(`[Ball] ${model.Name} caught a dodgeball`);

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

		// Out of the hand first, so the weld is not fighting the reparent below.
		ball.FindFirstChild(GRIP_NAME)?.Destroy();

		// Nobody's ball now: unarmed, because an armed ball is a live projectile and
		// would hurt whoever walked into it lying there.
		ball.SetAttribute("Armed", false);
		ball.Parent = Workspace;
		ball.Massless = false;
		ball.CanCollide = true;

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
		ball.Massless = true;
		ball.Parent = model;

		// And nobody's and nothing's — a caught ball is still armed and still named to the thrower it
		// left, which is what this clears.
		this.factory.makeInert(ball);

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
		const held = this.heldBalls.get(model);
		if (!held || held.ball.Parent !== model) return false;

		const ball = held.ball;

		// Release the ball from the hand before launching it.
		ball.FindFirstChild(GRIP_NAME)?.Destroy();
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

		// What actually goes on the ball: the solve, plus the launch boost that
		// covers the engine's own vertical loss. See BALL_CONFIG.THROW_VERTICAL_BOOST —
		// the guide draws the solve, so this is what makes the ball fly the drawn
		// line instead of sagging below it.
		const commanded = plan.velocity.add(new Vector3(0, BALL_CONFIG.THROW_VERTICAL_BOOST, 0));

		if (DEBUG) {
			print(
				`[Ball] ${model.Name}: ${plan.arc} ${this.describeThrow(plan, commanded)}, ` +
					`release ${releasePosition} -> launch ${plan.origin}` +
					` (${string.format("%.2f", launch.sub(ownLaunch).Magnitude)} studs from our own)`,
			);
		}

		// The thrower can never be hit by their own ball. Without this, a throw
		// aimed back across the body clips it, and the engine resolves that
		// overlap the only way it can — by shoving the player. Ball size and
		// muzzle distance only ever changed how hard that shove was.
		CollisionIgnore.between(ball, model);

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
		ball.Position = plan.origin;
		ball.Parent = Workspace;

		// The ball was welded into the character, so it belonged to the thrower's
		// client's physics — and that machine was the one simulating it, including
		// the frame it was released on. Called with no argument the server takes it
		// back, so the whole flight is simulated in one place.
		ball.SetNetworkOwner();

		ball.AssemblyLinearVelocity = commanded;
		ball.CanCollide = true;
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

		// A dev with `InfiniteBalls` never runs out: the throw they just made is answered
		// with another ball, by the same call the first one arrived by. This is the one
		// throw in the game that refills itself — every other thrower fetches its next
		// ball, which is what the loose balls on the floor are for. It is not the only way
		// in: switching the flag on gives an empty hand a ball too, which is what a dev who
		// has just thrown their last one actually needs. See the constructor.
		if (this.hasInfiniteBalls(model)) {
			this.giveBall(model);

			if (DEBUG) print(`[Ball] ${model.Name}: refilled by InfiniteBalls`);
		}

		return true;
	}

	/**
	 * The player path: what the throw remote's handler calls.
	 *
	 * A player is not a special kind of thrower, just the only one with a `Player`
	 * behind it — so there is nothing here but recovering the character and handing
	 * it to {@link throwBall} as the model. The refill belongs to the throw itself,
	 * which is what makes it the same refill for an NPC.
	 */
	private throwForPlayer(player: Player, target: Vector3, arc: ThrowArc, claimedLaunch?: Vector3) {
		const character = player.Character;
		if (character) this.throwBall(character, target, arc, claimedLaunch);
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
