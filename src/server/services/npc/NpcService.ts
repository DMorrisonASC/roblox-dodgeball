import { OnStart, Service } from "@flamework/core";
import { CollectionService, HttpService, Workspace } from "@rbxts/services";
import {
	NPC_ANIM_FROZEN_ATTRIBUTE,
	NPC_ANIM_GROUNDED_ATTRIBUTE,
	NPC_ANIM_MOVING_ATTRIBUTE,
	NPC_ANIM_SPRINTING_ATTRIBUTE,
	NPC_ANIM_THROWING_ATTRIBUTE,
	THROWER_TOKEN,
} from "shared/constants";
import { NPC_CONFIG } from "shared/config/npc.config";
import { DEBUG_CONFIG } from "shared/config/debug.config";
import { COSMETICS } from "shared/config/economy.config";
import { EQUIPPED_TRAIL_ATTRIBUTE } from "shared/constants";
import { resolveDodgeable } from "shared/dodge";
import { NPC_TAG, NpcBehavior } from "../../npc/Behavior";
import { createAlwaysCatchBehavior } from "../../npc/behaviors/AlwaysCatchBehavior";
import { createAlwaysDodgeBehavior } from "../../npc/behaviors/AlwaysDodgeBehavior";
import { createAlwaysSeekBehavior } from "../../npc/behaviors/AlwaysSeekingBehavior";
import { createAlwaysThrowBehavior } from "../../npc/behaviors/AlwaysThrowBehavior";
import { createCatchBehavior } from "../../npc/behaviors/CatchBehavior";
import { createDodgeBehavior } from "../../npc/behaviors/DodgeBehavior";
import { createPickupBehavior } from "../../npc/behaviors/PickupBehavior";
import { createRespawnBehavior } from "../../npc/behaviors/RespawnBehavior";
import { createRoundSeekBehavior } from "../../npc/behaviors/SeekBehavior";
import { createThrowBehavior } from "../../npc/behaviors/ThrowBehavior";
import { createWalkToJoinPadBehavior } from "../../npc/behaviors/WalkToJoinPadBehavior";
import { BallPickupService } from "../ball/BallPickupService";
import { BallService } from "../ball/BallService";
import { CatchService } from "../actions/CatchService";
import { DodgeService } from "../actions/DodgeService";
import { FreezeService } from "../actions/FreezeService";
import { WalkSpeedService } from "../character/WalkSpeedService";
import { MysteryBoxService } from "../mystery/MysteryBoxService";
import { SuperService } from "../super/SuperService";

/** Prints each model as it is picked up. A print per tick would flood the output. */
const DEBUG = true;

/** How often the loop turns when no behavior is registered: idle, rather than spin. */
const IDLE_PERIOD = 0.5;

/**
 * A running loop, and the flag that ends it.
 *
 * A flag rather than a cancel, because `task.wait` cannot be interrupted from
 * outside: the loop notices at its next turn, which is one period at most.
 */
interface NpcLoop {
	stopped: boolean;

	/**
	 * When this rig's network ownership was last re-asserted, on the engine's clock.
	 *
	 * **Per rig, and kept here rather than in a map of its own**, because this object is already one
	 * per rig and already dies with the rig — a second map keyed by the same models would be the same
	 * bookkeeping twice, with two lifetimes to keep in step. See
	 * `NPC_CONFIG.NETWORK_OWNERSHIP_RECHECK_SECONDS` for why ownership is re-asserted at all.
	 */
	ownershipCheckedAt: number;

	/**
	 * The last speed `Humanoid.Running` reported for this rig, in studs per second.
	 *
	 * **Recorded as it arrives rather than sampled, because the engine already owns this question and answers
	 * it on an edge.** `Humanoid.Running` fires when the running speed changes and fires `0` when the body
	 * stops, so the loop keeps the answer and `publishAnimation` compares it against
	 * `NPC_CONFIG.RIG_MOVING_SPEED` — no per-turn velocity read and nothing to band. Kept on the loop for
	 * `ownershipCheckedAt`'s reason: this object is already one per rig and already dies with the rig.
	 */
	runningSpeed: number;

	/**
	 * The `Running` subscription, **held so {@link forget} can drop it with the loop**.
	 *
	 * A connection outlives the loop that made it unless somebody disconnects it, and a loop that has ended is
	 * a loop nobody is publishing from — so this is the one thing a loop owns that has to be hung up rather
	 * than left to be collected.
	 */
	running?: RBXScriptConnection;
}

/**
 * Runs tagged humanoid rigs, so an NPC can do anything a player can.
 *
 * The tag is the whole interface: a model wearing `NPC` is tracked, and each
 * behavior tag on it is a mechanic it can perform. That is why nothing here
 * knows what catching or throwing *are* — it watches tags, runs loops, and hands
 * each behavior a model and a humanoid when its interval comes up. The mechanics
 * live in the services the behaviors call, so an NPC and a player share one
 * implementation of every rule rather than two that have to be kept in step.
 *
 * Tagging a rig by hand in Studio is therefore a complete way to make an NPC:
 * the added-signal starts the loop, and nothing has to be written or spawned.
 *
 * **A rig is managed only while it is in `Workspace`, and that is the second half of the interface.**
 * The tag says what a model *is*; it says nothing about where the model is, and `CollectionService`
 * answers about the whole DataModel — so a rig inside an arena template parked in `ServerStorage`
 * wears `NPC` exactly as the rigs standing in the arena do, and this service could not tell them
 * apart. See `run` for the gate that does, and for what simulating those rigs cost.
 */
@Service()
export class NpcService implements OnStart {
	/**
	 * Every behavior in the game.
	 *
	 * **This list is the only thing that changes when a mechanic is added** — one
	 * factory here, plus that mechanic's own behavior file. Adding an entry gives
	 * every NPC wearing the matching tag the mechanic, and gives a model wearing
	 * only `NPC` nothing.
	 */
	private readonly behaviors: NpcBehavior[];

	/** One live loop per model. Losing the `NPC` tag ends it at the next turn. */
	private readonly loops = new Map<Model, NpcLoop>();

	constructor(
		private readonly catches: CatchService,
		private readonly balls: BallService,
		private readonly pickups: BallPickupService,
		private readonly freezes: FreezeService,
		private readonly dodges: DodgeService,
		private readonly speeds: WalkSpeedService,
		private readonly mystery: MysteryBoxService,
		private readonly abilities: SuperService,
	) {
		this.behaviors = [
			// **Both catchers come before the dodge, and the order is not cosmetic.** The behaviors share
			// facts that are written by *services* — a held ball, a chase, a dash — so almost nothing here
			// depends on the order at all. This one case does: a catching rig's window is opened by the
			// catcher's own tick, so on a rig's *first* turn a dodge ticked before the catcher would find no
			// window open yet and could fire. Behind it, the window is already open on the turn it matters,
			// which is what makes a catch win the turn it starts on.
			//
			// **Which catcher is first matters only if a rig wore both tags**, which nothing does — the two
			// tags are alternatives, and a rig carries one of them. The always-on catcher is listed first
			// because it predates the gated one; the gated catcher's own decision is what gives a sibling
			// dodge its gaps, so it has to be ahead of the dodge for the reason above.
			createAlwaysCatchBehavior(catches, balls),
			createCatchBehavior(catches, balls),
			// **Both dodgers, on the far side of both catchers for the reason above.** They are
			// alternatives — a rig wears one of the two tags — so their order relative to each other is
			// free; what is not free is that both sit *behind* the catchers, so a catching rig's window is
			// already open on the turn the dodge asks about it.
			createDodgeBehavior(dodges, balls),
			createAlwaysDodgeBehavior(dodges, balls),
			createAlwaysThrowBehavior(balls),
			// **The gated throw, which is the one that needs a target.** It is listed after its
			// always-on sibling because the pair are alternatives rather than a sequence; a rig carries
			// one of the two tags.
			createThrowBehavior(balls),
			createPickupBehavior(pickups, balls),
			// The pair to the line above, and the difference between a rig that collects and a rig
			// that only takes what rolls into its reach: this one walks to the nearest loose ball,
			// and that one takes it. A rig needs both tags for the mechanic — either alone is a rig
			// that stands beside a ball it will never pick up, or one that never goes anywhere.
			//
			// **Two entries since 2026-10-13, because a rig fetches from one region and there are two
			// regions.** `createRoundSeekBehavior` reads the side boxes — a rig on A fetches inside
			// `SideKeepOutA` and nowhere else — and `createAlwaysSeekBehavior` reads `practiceZone`, so a rig
			// painted for the practice area never leaves it for a ball. Both are one call to the factory in
			// `SeekBehavior.ts` and differ in their tag and their region, which is the whole of the split.
			//
			// **Which one a rig wears is what its tags say, and nothing here consults the side.** A round rig
			// wears the first because `LobbyRigService` put it there, and the practice rigs wear the second
			// because a person painted it — so a practice tag on a side-bearing rig would be honoured rather
			// than corrected, and that is the same rule every behaviour tag has always had.
			// **Both seek behaviours, and both take the speed service since 2026-10-13.** A rig's walk now
			// contributes to its speed like a player's does — a run for a distant ball, on the same named
			// contribution a player's sprint is — so the service that keeps the sum is handed to the behaviour
			// that walks. See `SeekBehavior` for what a rig does with it and for what it costs (a rig has a
			// speed sum now, where before this only the pad walk's direct write ever touched one).
			//
			// **And both take the mystery service since 2026-10-14**, because a box became a fetch target and
			// the seek is what walks to it — the walk to a box and the walk to a ball are one tick, ranked
			// there, and the box's source is asked of the service that owns the boxes. See
			// `SeekBehavior.nearestBox`.
			createRoundSeekBehavior(speeds, pickups, balls, mystery),
			createAlwaysSeekBehavior(speeds, pickups, balls, mystery),
			// The one behavior that needs something no other one does: the ball the rig was
			// holding, so it can be taken out of the copy this makes. It re-enters this service
			// the way any other rig does — by putting `NPC` on a model and letting the
			// added-signal start its loop — so there is no callback and no hole in the registry.
			createRespawnBehavior(balls),
			// **Last, and the speed service it is handed is why that is now an ordering rather than an
			// absence.** It used to react to nothing: it moved a rig to a point written on the rig and then
			// stopped, so its only interaction was with a rig that also wears `Behavior_Seeking` — two
			// walkers, whichever ticks last each turn winning. **It takes the speed service now**
			// (`createWalkToJoinPadBehavior(speeds)`), because a rig's run to its pad is a named contribution
			// on `WalkSpeedService` exactly as a seek's run for a ball is, so the two move tags share a speed
			// sum as well as a `MoveTo` — one more reason they are alternatives rather than a pair. That
			// combination is documented in `WalkToJoinPadBehavior` rather than ordered around here, because
			// the two tags are alternatives in every use this game has — a placeholder rig wears this one and
			// nothing else. **Both seek tags are named since the 2026-10-13 split**, because the walker's
			// interaction is with "a behaviour that moves the rig to a point" and there are now two of
			// those: the round seek reads the rig's own half and the practice seek reads the practice zone.
			createWalkToJoinPadBehavior(speeds),
		];
	}

	public onStart() {
		// Rigs tagged before this service started — including everything tagged in
		// Studio before Play — never fire the added-signal, so they are scanned for
		// rather than waited on.
		//
		// **Deliberately world-blind, and that is the point of the gate in `run` rather than here.** Every
		// rig wearing the tag is given a loop, and the gate is what declines to act on one that is out of
		// the world. That costs an idle loop per parked rig and buys the one case a filter *here* would
		// have thrown away for good: a rig that is put into the world later — a template dragged out of
		// `ServerStorage` to test with — starts working on its own next turn, because being parented fires
		// no tag signal and this scan is the only moment it could have been noticed at all.
		//
		// **What this scan does not cover is a clone, and that is worth being exact about rather than
		// letting it read as "maps work".** A rig that arrives inside a copied model has no loop: the
		// copy's rigs are new instances, their tags came with the copy rather than being applied to it, and
		// nothing here ever sees them — which is the case `RespawnBehavior`'s strip-and-re-add exists
		// around (see its comment for the project's reading of what `Clone` does and does not fire). The
		// only code that ever cloned a whole model like that was the map rotation, which is parked while
		// the arena is permanent and never runs; so there is no live case today, and this paragraph is
		// here so that bringing the rotation back does not silently reintroduce it.
		for (const instance of CollectionService.GetTagged(NPC_TAG)) {
			if (instance.IsA("Model")) this.start(instance);
		}

		CollectionService.GetInstanceAddedSignal(NPC_TAG).Connect((instance) => {
			if (instance.IsA("Model")) this.start(instance);
		});

		CollectionService.GetInstanceRemovedSignal(NPC_TAG).Connect((instance) => {
			if (instance.IsA("Model")) this.stop(instance);
		});
	}

	/**
	 * Puts a rig in the world under this system's control.
	 *
	 * The `NPC` tag goes on **last**, after the behavior tags, so the
	 * added-signal fires with the whole set already in place and the first tick
	 * can never land on a half-described model.
	 *
	 * This is a convenience, not a requirement: everything a spawned NPC gets, a
	 * hand-tagged one gets too, because the added-signal runs the same `start`.
	 *
	 * Note what is deliberately **not** here: nothing that equips the rig. Whatever
	 * a behavior needs in order to run — a ball in the hand, say — that behavior
	 * asks for itself when its tag is seen. See `NpcBehavior.prepare`.
	 */
	public spawn(template: Model, cframe: CFrame, behaviorTags: string[]): Model {
		const model = template.Clone();

		// **A pooled rig comes out unanchored, because a body this project made has to be able to move.** This
		// is the token's argument one paragraph down, applied to the other property a place file can hand a
		// clone that makes it useless: a model dragged in from the toolbox is very often anchored — that is how
		// a builder keeps it still while editing — and the clone inherits it. An anchored assembly is one the
		// engine does not simulate, so `MoveTo` walks nothing and `SetNetworkOwner` **raises**, which is why
		// `ownForServer` refuses the rig with "Network Ownership API cannot be called on Anchored parts or parts
		// welded to Anchored parts". One boot of seven free-model rigs produced that line four times.
		//
		// **Every `BasePart`, not just the root, because the engine's refusal is not about the root.** It names
		// parts welded to anchored parts as well, so a single anchored limb pins the whole assembly — and which
		// part a pool model has anchored is not something this file can know, because the pool is other people's
		// models. Clearing all of them is one walk of a rig at the moment it is made, and it is where the
		// question is answerable at all.
		//
		// **Here rather than in `npc/rigPool.ts`, on the same division as the token**: the *template* is the
		// place file's business and `poolModelWarnings` names anything wrong with it, while the *clone* is a
		// body this code made and `spawn` is where a body is made. Unanchoring changes no position, so the
		// order against `PivotTo` below does not matter for correctness — it matters only in that the rig is
		// already physics' by the time it is parented, so no frame of the clone is ever fixed in place.
		for (const descendant of model.GetDescendants()) {
			if (!descendant.IsA("BasePart")) continue;

			descendant.Anchored = false;
		}

		model.PivotTo(cframe);
		model.Parent = Workspace;

		// **A clone is a new body, so it is given a new token — set rather than defaulted, which is the
		// whole difference between this line and {@link ensureToken}.**
		//
		// `Clone` copies the template's attributes, and `ThrowerToken` is an attribute like any other.
		// Left to `ensureToken`, a template that carries one therefore hands **the same token** to every
		// model cloned from it — and the token is what `BallComponent`'s immunity rule compares against
		// the token on the ball. One token standing for eight placeholder rigs makes every rig-to-rig
		// throw read as *that body's own ball*: the contact returns before anything is tagged, silently,
		// so rigs are unhurtable by each other and immortally so, while a player — who has a token of
		// their own, their `UserId` — is still killed by the same throws. That is the report this line
		// answers, and it is answered here rather than in the comparison because the comparison is
		// right: a token belongs to a *body*, and this is where a body is made.
		//
		// **Set before the tags, because `NPC` is what starts this rig**: the added-signal runs `start`,
		// which mints nothing when a token is already there — so this line is what keeps the token
		// decision in one place even for a rig that was spawned.
		//
		// **And it is not the only fix, deliberately.** A model in `NPC_CONFIG.RIG_POOL_FOLDER` should
		// carry no token at all — and no tag, since the folder is walked by name and class, see
		// `npc/rigPool.ts` — but a place file that already has one cannot be repaired from code, and this
		// is the line that makes the difference unobservable either way. `ensureToken` is the other half:
		// it refuses to write to a model that is not in the world, which is how the token got into the
		// template in the first place. **What a model in the folder *is* carrying is reported at boot
		// rather than repaired** — see `poolModelWarnings`, which is the check this sentence is the
		// reason for.
		model.SetAttribute(THROWER_TOKEN, HttpService.GenerateGUID(false));

		// **And a trail, chosen at random, which is the one cosmetic a rig wears.** See {@link dressRig}, which
		// is the same call the loop makes for a rig nobody spawned — a Studio-painted rig has no `spawn` to go
		// through, and giving it a trail only when it is cloned would make the place file the one route that
		// produces a bare body.
		this.dressRig(model);

		for (const tag of behaviorTags) model.AddTag(tag);
		model.AddTag(NPC_TAG);

		return model;
	}

	/**
	 * Gives a rig a randomly chosen trail, unless it is already wearing one.
	 *
	 * **Why a rig wears a trail at all, since it owns nothing and has no client to see it.** Three reasons and
	 * the third is the real one: a ball's trail is the most legible thing about a throw, so a rig whose ball
	 * flies the grey default is visibly the same every time while a player's is whoever they are; the user's
	 * rule is that a rig should be hard to tell from a person, and a default trail is one more tell; and
	 * **the trail is read from the body that threw**, so a rig wearing one exercises the same read a player's
	 * does rather than leaving a second path untested until the day somebody adds one.
	 *
	 * **Randomly, per rig, and drawn from the whole catalogue rather than from what a player could own.** A
	 * rig is not a player: it has no wallet, no milestones and no chest, so "what may this body wear" is the
	 * catalogue and nothing else. Randomly rather than fixed because a fixed trail would be a uniform — eight
	 * rigs flying one colour reads as a team, which is a statement, where eight rigs flying eight colours
	 * reads as eight bodies.
	 *
	 * **The id is what is written, and the colours are looked up from it.** An attribute cannot hold the
	 * `colors` object a def carries — it is an array of `Color3`s and an attribute holds no tables — so the
	 * model carries the *id* and `EconomyService.equippedTrail` resolves the def through the same `COSMETICS`
	 * lookup a player's trail goes through. That also keeps the catalogue the single source of truth: a def
	 * whose colours are retuned repaints every rig wearing it, which is what you want and the opposite of what
	 * a copied colour would do.
	 *
	 * **A record of *cosmetics* rather than of one trail, in the shape it needs to be for that to stay true.**
	 * Today a trail is the only slot with a reader — the elimination slot has an attribute and nothing that
	 * reads it (`HANDOFF.md`'s open item) — so this writes one attribute and stops. What makes it a record
	 * rather than a special case is that the name is the *same attribute name a `Player` carries a trail
	 * under*, so the next cosmetic slot is that slot's attribute written here too and no second mechanism.
	 * **What this deliberately is not:** a per-cosmetic grant system, a reader for a slot nothing wears, or a
	 * table of "what rigs are allowed to wear" — the catalogue is the whole list.
	 *
	 * **Idempotent, so it is safe to call on every turn of a loop.** A rig already wearing something is left
	 * exactly as it is, which is what makes the respawn path work without a second thought: `RespawnBehavior`
	 * clones the corpse, a `Clone` copies attributes, so the replacement arrives already wearing the dead
	 * rig's trail — the same colour, which is the right answer for a body that is meant to be the same rig.
	 */
	private dressRig(model: Model): void {
		const existing = model.GetAttribute(EQUIPPED_TRAIL_ATTRIBUTE);
		if (typeIs(existing, "string") && existing !== "") return;

		// **Every trail in the catalogue, and `pairs` rather than `Object.values`** — this build has no
		// `Object.values`, which is the same footgun `economy.config.ts` records at the top of its own file.
		const ids: string[] = [];
		for (const [, def] of pairs(COSMETICS)) {
			if (def.slot === "trail") ids.push(def.id);
		}

		// A catalogue with no trails in it is a build mid-edit rather than a state to handle; a rig wearing
		// nothing is the default grey, which is exactly what the old behaviour was.
		if (ids.size() === 0) return;

		// `math.random(1, n)` is inclusive at both ends, so the index is the whole array and never its end.
		model.SetAttribute(EQUIPPED_TRAIL_ATTRIBUTE, ids[math.random(1, ids.size()) - 1]);
	}

	/**
	 * Begins managing `model`: a thrower token if it has none, then one loop.
	 *
	 * **The token is settled by {@link ensureToken}, which refuses a model that is not in the world** —
	 * that refusal is the point rather than a detail, see it.
	 */
	private start(model: Model): void {
		if (this.loops.has(model)) return;

		// A rig tagged by hand never came through `spawn`, so this is where it is
		// given something to be identified by — the same thing a player's character
		// is given when it is handed a ball, which is what lets one immunity check
		// cover both. Once only: a GUID that changed would break the ball already in
		// flight.
		//
		// **And this used to be the line that wrote into a place file.** The scan above is world-blind
		// on purpose — a rig wearing `NPC` inside a parked template is handed a loop so that dragging it
		// into the world later just works — and a rig with a loop arrives here, so a token *was* written
		// to the **template**: every model cloned from it shared that one token (which is the rigs that
		// could not hurt each other), and the template carried the attribute into the place file the next
		// time it was saved, which is how a fault that began at runtime came back after a restart.
		// `ensureToken` therefore asks the world first, and `run` settles the token on the first turn a
		// parked rig is in it.
		this.ensureToken(model);

		// **What a rig has to be given before anything can move or animate it**, and this is the one
		// site for both. They are properties of the *body* rather than of this loop, and a replacement
		// body still gets them: `RespawnBehavior` puts `NPC` back on a new rig and lets the added-signal
		// start it, which is what makes this the funnel for spawned rigs and hand-tagged ones alike.
		//
		// **The animator goes first because it cannot be refused.** Ownership can be — see
		// `ownForServer` — and a rig that can never be owned by the server still has to be animatable.
		//
		// **And both are guarded, because a rig's setup must not be able to take the rigs after it down
		// with it.** That is not hypothetical: `SetNetworkOwner` *raises* on a rig whose assembly is
		// anchored, `onStart` calls this once per rig *inside its scan loop*, and one anchored rig
		// therefore aborted the whole scan — no loops, no behaviors, no `[NPC]` lines, and nothing in
		// the output naming the rig it happened on. A rig whose setup fails is a rig that does nothing,
		// because the loop is what runs it; the least this can do is fail alone and say so.
		const [prepared, err] = pcall(() => {
			this.ensureAnimator(model);
			this.ownForServer(model, true);
		});

		if (!prepared) warn(`[NPC] ${model.Name}: setup failed — ${tostring(err)}`);

		const loop: NpcLoop = { stopped: false, ownershipCheckedAt: os.clock(), runningSpeed: 0 };
		this.loops.set(model, loop);

		task.spawn(() => this.run(model, loop));

		if (DEBUG) {
			// **Which of the two states it is in, said out loud.** "This rig is managed" and "this rig is
			// managed and doing nothing" are identical from anywhere but here — and the second one is the
			// whole of "there are balls coming from somewhere and I cannot see who is throwing them", a
			// question this file should answer in one line rather than leave to be inferred. A rig outside
			// the world names itself here instead of only being skipped quietly by the gate in `run`.
			const idle = model.IsDescendantOf(Workspace) ? "" : " — not in the world, so idle until it is placed";
			print(`[NPC] ${model.Name}: managed — ${this.describeBehaviors(model)}${idle}`);
		}
	}

	/** Ends `model`'s loop at its next turn. */
	private stop(model: Model): void {
		const loop = this.loops.get(model);
		if (loop) loop.stopped = true;
	}

	/**
	 * Gives `model` its thrower token, if it has none **and it is in the world**.
	 *
	 * **The one *defaulting* writer of the attribute the immunity rule reads** — `spawn` is the other
	 * writer, and it *sets* one because a clone is a new body. `BallComponent` compares the token a ball
	 * carries against the token on the body it touches, and that single comparison is the whole of
	 * "nobody is hurt by their own ball", for a player (whose token is their `UserId` text, stamped by
	 * `JoinService`) and for a rig alike. So a token is not bookkeeping: a body without one can hit
	 * itself, and two bodies sharing one cannot hit each other.
	 *
	 * **In the world, or not at all, and that is the load-bearing half.** A model that is not in the
	 * world is a template, and a token written to a template is inherited by everything cloned from it
	 * (`Clone` copies attributes) and saved into the place file with it. So this refuses a parked model
	 * outright, and {@link run} calls it on the first turn a parked rig *is* in the world — the same
	 * promise, made at the same place, as the world gate that keeps a parked rig's behaviors idle.
	 *
	 * **Idempotent rather than once**: the loop asks every turn, and every ask after the first is one
	 * `GetAttribute` on a body whose attributes are already being read and written on that turn.
	 */
	private ensureToken(model: Model): void {
		if (!model.IsDescendantOf(Workspace)) return;
		if (model.GetAttribute(THROWER_TOKEN) !== undefined) return;

		model.SetAttribute(THROWER_TOKEN, HttpService.GenerateGUID(false));
	}

	/**
	 * Makes the server the owner of this rig's root part.
	 *
	 * **The line that keeps a rig's movement on the machine driving it.** `MoveTo` and `WalkSpeed` are
	 * inputs to the engine's mover, and the mover runs where the assembly's *network ownership* is —
	 * which the engine assigns by proximity. So a rig standing next to a player can have its physics
	 * handed to that player's client, and what that looks like is a rig that jitters while it walks
	 * and a destination that stops being reached. It is also what would make the published speed wrong:
	 * the speed this service reads is the *server's* copy of the assembly, and a body simulated on
	 * somebody else's machine does not move this one.
	 *
	 * **Asked before it is called, because the call *raises* rather than refusing.** The engine's own
	 * message is "Network Ownership API cannot be called on Anchored parts or parts welded to Anchored
	 * parts", and it arrives as an error thrown into whatever called it — so an unguarded call is not
	 * a rig that quietly keeps auto ownership, it is an error in the middle of `start`. That is what
	 * this did, and what it cost is written down in `start`: one anchored rig stopped every rig on the
	 * server from being managed at all.
	 *
	 * **`CanSetNetworkOwnership` is the question `SetNetworkOwner` cannot answer for itself**, and its
	 * own documentation says exactly that: it reports whether ownership can be *modified or read*, and
	 * gives the reason. `BallService` asks it about a ball for the same reason. The read below is behind
	 * this gate because the gate covers reading too, so a rig that cannot be owned is never asked.
	 *
	 * **What a rig that cannot be owned means, because it is more than bookkeeping.** An anchored
	 * assembly is one the engine does not simulate, so a rig with an anchored root — or one welded to
	 * anything anchored — **cannot be walked by `MoveTo` either**, and its published speed will say
	 * "standing" for ever. That is the animation telling the truth about a rig that cannot move, which
	 * is the whole design; the fix is on the rig, not in this file.
	 *
	 * **No argument, and that is what "the server" means here.** `SetNetworkOwner(playerInstance?)`
	 * reads as "the player this belongs to", and the engine's convention for handing it back is to pass
	 * none — the same call `BallService` makes on a ball it has just thrown, which is where this
	 * project's precedent for it lives. `SetNetworkOwnershipAuto` and `GetNetworkOwnershipAuto` are the
	 * pair that says the engine may decide for itself, which is why this is called again on a re-check
	 * rather than once: see `NPC_CONFIG.NETWORK_OWNERSHIP_RECHECK_SECONDS`.
	 *
	 * **The root part is looked up by the helper everything else uses**, so the part given an owner is
	 * the part a dodge, a catch and the seeking behavior all call the rig's position. A rig with no part
	 * to own is a rig with nothing to move, and is left alone rather than reported: `run` is where a
	 * model with no humanoid is named.
	 */
	private ownForServer(model: Model, report: boolean): void {
		const root = resolveDodgeable(model)?.root;
		if (!root) return;

		const [canSet, reason] = root.CanSetNetworkOwnership();
		if (!canSet) {
			// **Said once per rig, at setup, and never again.** This is not a note — it names a rig that
			// will not walk and whose animation will therefore never say anything but "standing" — but
			// the re-check below runs every few seconds and passes `false`, because a line repeated for
			// ever is a line nobody reads.
			if (report) {
				warn(`[NPC] ${model.Name}: the server cannot own it — ${reason ?? "no reason given"}`);
			}

			return;
		}

		// **The server already has it, which is the ordinary answer on a re-check.** Nothing is written;
		// the cost of the whole check is two reads. `nil` is the server here — the API's own words —
		// which is the one place that reads oddly next to a call whose argument `nil` *means* the
		// server.
		if (root.GetNetworkOwner() === undefined) return;

		root.SetNetworkOwner();
	}

	/**
	 * Gives the rig an `Animator` if it has none — **on the server**, which is the load-bearing half.
	 *
	 * **The renderer cannot make one for itself.** An animation is loaded onto an `Animator`, so the
	 * instance every client loads onto has to be one every client has: a client that created one would
	 * be animating a body through an object nobody else can see, and each client would be doing it
	 * through a different one. Created here, it is part of the rig that replicates. **And creating it
	 * is not playing anything** — this service never loads a track on a rig, which is the rule the
	 * whole arrangement rests on. See `RigAnimationController` for the side that does play them.
	 *
	 * **Nothing guarantees a rig arrives with one.** `Humanoid:LoadAnimation` is deprecated on the
	 * engine's own note that "the `Animator` may be created while editing or at runtime", which is the
	 * engine saying it is not its job; `LocomotionAnimationController` says the same from the other
	 * side — "a player character arrives with one; a bare rig may not" — and `DodgeService` builds one
	 * when it is missing for exactly this reason. A rig that already has one is left untouched, which
	 * is the ordinary case for a rig made in Studio's animation editor.
	 */
	private ensureAnimator(model: Model): void {
		const humanoid = model.FindFirstChildWhichIsA("Humanoid");
		if (!humanoid || humanoid.FindFirstChildOfClass("Animator")) return;

		const animator = new Instance("Animator");
		animator.Parent = humanoid;
	}

	/**
	 * One NPC's loop, for as long as it is a living NPC.
	 *
	 * The period is the **fastest** interval any behavior asked for, so none is
	 * ever late; each behavior is then gated on its own interval, so a slow one is
	 * not run fast merely because a fast one is present.
	 */
	private run(model: Model, loop: NpcLoop): void {
		const humanoid = model.FindFirstChildWhichIsA("Humanoid");
		if (!humanoid) {
			warn(`[NPC] ${model.Name}: no humanoid, so there is nothing to run behaviors on`);
			this.forget(model, loop);
			return;
		}

		const period = this.fastestInterval();

		// **A rig nobody spawned gets its trail here, once, on the turn it starts being run.** `spawn` dresses
		// a rig it makes, which is every rig `LobbyRigService` puts in the lobby and everything else that goes
		// through that door — but a rig painted by hand in Studio, or one dragged out of `ServerStorage` while
		// the server is running, never went through it. This is the same call at the same place the rest of a
		// rig's setup happens, and it is idempotent, so the spawned route pays one attribute read for it.
		this.dressRig(model);

		// **The walking fact is subscribed to, and this is its third shape.** `Humanoid.MoveDirection` read zero
		// for every rig in the game, and so did `Humanoid:GetMoveVelocity()` when it replaced it: they are the
		// *input*-driven pair, and a behaviour has no input — it has a `MoveTo`. What the engine does publish
		// about a `MoveTo` body is its running speed, and `Humanoid.Running` is the documented way to tell a
		// walking humanoid from a standing one, because there is no idle *state* to ask about. It fires on the
		// edge — the speed changes, or the body stops and it fires `0` — so the loop holds the answer and the
		// publisher never reads a velocity per turn. See `publishAnimation` for the whole of the reasoning.
		loop.running = humanoid.Running.Connect((speed) => {
			loop.runningSpeed = speed;
		});

		/** When each behavior last ran, so periods are honoured per behavior. */
		const lastRan = new Map<string, number>();
		/** Behaviors that have had their `prepare`, so it happens once and not per tick. */
		const prepared = new Set<string>();

		// **The MicroProfiler labels for this rig's behaviours, built once per loop rather than per turn.**
		// A turn is 10 a second per rig, so a label built inside the dispatch below would be an allocation
		// on the very path it is measuring. `behavior.tag` is the behaviour's own identity, and dropping
		// its nine-character prefix is what turns `Behavior_Seeking` into a band called `Npc.tick.Seeking`
		// — a recording read without a legend. `string.sub` rather than `.replace`, which roblox-ts's
		// string shim does not provide; the prefix is fixed width, so a slice is exact where a pattern is
		// not. See `DEBUG_CONFIG.PROFILE`, which decides whether any of it is emitted.
		const profileScopes = new Map<string, string>();
		for (const behavior of this.behaviors) {
			profileScopes.set(behavior.tag, `Npc.tick.${string.sub(behavior.tag, 10)}`);
		}

		while (!loop.stopped && model.HasTag(NPC_TAG) && model.Parent !== undefined && humanoid.Health > 0) {
			// **A rig that is not in the world does nothing, and this is the first of the two gates every
			// behavior passes through.** The tag says a model is an NPC; it does not say the model is
			// anywhere. `CollectionService` answers about the whole DataModel, so a rig inside an arena
			// template parked in `ServerStorage` wears `NPC` exactly as the rigs in the live arena do — and
			// before this line, every one of them was simulated.
			//
			// **What that cost, because nothing about the code says it out loud.** A rig out of the world
			// still ran its behaviors, `ThrowBehavior.prepare` still handed it a ball, and every throw it
			// made still parented that ball to `Workspace` — which is where a thrown ball goes, because a
			// ball's business is to be in the world. So an unused map sitting in `ServerStorage` put balls
			// into the world out of nowhere, at whatever coordinates its rigs had been saved at, and the
			// only true thing to say about them from the player's seat was that they had no source.
			//
			// **Inside the loop rather than in its condition**, for the reason the freeze gate below gives
			// at length: a condition ends the loop and nothing brings a loop back. A rig put into the world
			// later — somebody dragging one out of `ServerStorage` to test it, say — starts working on its
			// own next turn, with no re-tagging behind it and no second mechanism.
			//
			// **This is the rule the rest of the project already keeps, and it was only missing here.**
			// `RoundService.roundParticipants` filters this same tag this same way, `taggedPartsInWorkspace`
			// is the `BasePart` half of it, and `TAGS.md` is where the rule is written down along with why
			// it is needed (a `Clone` copies its tags, so anything copied arrives wearing them). Kept inline
			// rather than shared for the reason `roundParticipants` keeps its own: the test is one call, and
			// what needs writing down is the reason rather than the expression.
			if (!model.IsDescendantOf(Workspace)) {
				task.wait(period);
				continue;
			}

			// **And the first thing a rig is owed once it is in the world: a token.** A rig the boot scan
			// found parked in `ServerStorage` was given a loop and deliberately no token — `ensureToken`
			// refuses a model that is not in the world, because a token written to a template is inherited
			// by every clone of it and saved into the place file. This is where the promise is kept: the
			// first turn it is in the world is both the earliest moment a token means anything and the turn
			// its behaviors start running on. See `ensureToken` for the whole rule.
			this.ensureToken(model);

			// **A frozen rig does nothing, and this is the second gate every behavior passes through.** A check
			// inside each behavior would be one guard per mechanic and a silent omission in the next one
			// anybody adds; here it cannot be forgotten, and it stops throwing, catching and picking a ball up
			// in one line.
			//
			// **And it is answered once per turn, above the publish, because the published state needs it.**
			// Whether a rig is frozen is part of what a client is told — a held rig's legs stop — so the answer
			// is taken here and handed to both readers, rather than asked twice with the chance of the two
			// disagreeing. **The publish is above the gate on purpose**: a rig that had just been frozen would
			// otherwise never publish that it had been, because everything below this line is skipped until it
			// thaws.
			const now = os.clock();
			const frozen = this.freezes.isFrozen(model);

			this.publishAnimation(model, humanoid, frozen, loop, now);

			// **Inside the loop rather than in its condition, and that move is a bug fix rather than a
			// preference.** This first went into the `while` above — which meant a frozen rig *left the loop*,
			// and a loop is not a thing that comes back: `start` is called from the tag's added-signal and
			// from the scan at startup, and a rig already wearing its tag never fires either again. So the
			// freeze would have been permanent, and worse, the line after this loop is what reports a
			// death: a rig killed while frozen left through the freeze rather than through its health,
			// `announceDeath` was never called, and `RespawnBehavior` — which learns about deaths from that
			// call and from nothing else — never brought it back. That is the whole of "the enemy falls down
			// and never re-spawns", and it only happened to rigs that were frozen when they died.
			if (frozen) {
				task.wait(period);
				continue;
			}

			// **Scope: `Npc.turn` — one rig's work for one turn.** It opens after the two gates above, because
			// both of them `continue` to the `task.wait` and a scope that skipped its own end would unbalance
			// the MicroProfiler's stack; and it closes before the `task.wait` at the bottom of this block,
			// because **a scope must never span a yield** — the wait is not work, and including it would
			// report the rig's idle period as frame cost. What is inside is every behaviour that is actually
			// due this turn, which is the part that scales with how many rigs are playing.
			//
			// **`publishAnimation` is deliberately outside it, and that is worth knowing before reading a
			// recording.** It is called above, before the frozen gate, because a rig's published animation
			// state has to be true whether or not its behaviors are allowed to run — so it is not a part of
			// "the turn" and folding it in here would make the two bands disagree for frozen rigs. It has a
			// band of its own (`Npc.publishAnimation`) for that reason, and **`Npc.turn` + `Npc.publishAnimation`
			// is the per-rig cost** rather than `Npc.turn` alone.
			if (DEBUG_CONFIG.PROFILE) debug.profilebegin("Npc.turn");

			for (const behavior of this.behaviors) {
				// Untagged: this behavior is not on for this model, so it is skipped
				// without ever being run.
				if (!model.HasTag(behavior.tag)) continue;

				// Wearing the tag, and never prepared: the behavior collects whatever it
				// needs. Done here rather than once at startup so that a tag added later
				// counts too, and it runs before the due check so the first `prepare`
				// lands ahead of the first `tick`.
				if (!prepared.has(behavior.tag)) {
					prepared.add(behavior.tag);
					behavior.prepare?.(model);
				}

				// Not due yet: the interval is measured against this behavior's own last
				// run, so behaviors with different periods can share one loop.
				if (now - (lastRan.get(behavior.tag) ?? 0) < behavior.tickInterval) continue;

				lastRan.set(behavior.tag, now);

				// **Scope: one band per behaviour**, so the recording says *which* per-rig mechanic is wide
				// rather than blaming "the NPC tick" wholesale. The pair is written around a single statement
				// with nothing between it that can return or yield, which is what makes it safe to leave
				// un-nested: `try`/`finally` would compile to an `xpcall` here and change both the frame cost
				// and how an error inside a behaviour unwinds, which instrumentation is not allowed to do.
				const scope = profileScopes.get(behavior.tag);
				if (scope !== undefined && DEBUG_CONFIG.PROFILE) debug.profilebegin(scope);
				behavior.tick(model, humanoid);
				if (scope !== undefined && DEBUG_CONFIG.PROFILE) debug.profileend();
			}

			if (DEBUG_CONFIG.PROFILE) debug.profileend();

			task.wait(period);
		}

		this.forget(model, loop);

		// A death is the one event a behavior cannot see for itself: a behavior is only ever run
		// while its NPC is alive, and the loop ends on exactly the fact a death-reactive behavior
		// would have to tick on. So it is passed on from here — and deliberately after `forget`,
		// because a behavior that brings the model back starts a *new* loop, which must not be
		// mistaken for this one on its way out.
		if (humanoid.Health <= 0) this.announceDeath(model);
	}

	/**
	 * Publishes what this rig is doing, for the clients that animate it. **One publisher, not four.**
	 *
	 * **Why here rather than in the behaviors that know.** The facts are spread across services — "is a
	 * ball in hand" is `BallService`'s, "is it frozen" is `FreezeService`'s, "how fast is it going" is
	 * the humanoid's — so a behavior publishing for itself would publish a *fragment*, and a client
	 * would have to merge four writers and work out what their combination means. Every behavior would
	 * also have to change, which is the thing this service's registry exists to avoid: a behavior is a
	 * thin caller that knows nothing about being observed. And this loop already holds the model, the
	 * humanoid and the freeze answer, so the whole state is one call in the one place that runs per rig.
	 *
	 * **On change only, and the *instance* is the record.** Every attribute is read before it is
	 * written, so a rig asked to walk a straight line publishes its request once and then says nothing
	 * at all — and there is no second copy of "what did I last publish" to keep in step, because the
	 * rig carries it. **That guard is the whole of this arrangement's economics, and it is why every
	 * fact published here arrives on an edge.** These were chosen as *requests* because a request
	 * changes when the game changes its mind and not before, while a *measured* speed has to be banded
	 * to satisfy the guard and rarely has an edge to write on. See `NPC_ANIM_MOVING_ATTRIBUTE` for the
	 * banded speed this replaced and for what it cost — and for the one fact here that had to be a
	 * measurement anyway, taken from an engine edge rather than from a per-turn sample.
	 *
	 * **The two facts are the same two a player's own client gathers for its body** — "somebody has
	 * asked this body to walk", and "and to sprint" — so the two callers of `animationFor` answer the
	 * same question from the same kind of fact, which is the property the shared decision exists for.
	 * The sprint is asked of {@link WalkSpeedService} rather than derived from the walk speed here, because
	 * the base speed is a per-rig number and the *contribution* is the fact. A rig's own speed is only
	 * true while the server owns it, which is what {@link ownForServer} is for — and is now a fact
	 * about the walk rather than about the animation.
	 *
	 * **The walk was written as a request twice, and the engine publishes no request for a `MoveTo` body.** It
	 * read `Humanoid.MoveDirection` first — "the direction the body is walking in" — on the reading that it
	 * describes movement. It is documented as the property `Humanoid:Move()` writes, and every walk in this game
	 * is a `Humanoid:MoveTo()`, which the engine documents as setting `WalkToPoint` and `WalkToPart` and says
	 * nothing about a direction. `Humanoid:GetMoveVelocity()` replaced it and is documented verbatim as the
	 * "*input*-driven" velocity — the same family, so the same zero. Two play sessions say the same thing: no rig
	 * in the game ever prints a `walk` or a `run` line while the server prints it walking and sprinting, and every
	 * rig wore its idle clip.
	 *
	 * **What a `MoveTo` body does publish is its running speed, and `Humanoid.Running` is the engine's own answer
	 * — on an edge.** Its notes name the event as *the* way to tell a walking humanoid from a standing one ("as
	 * there is no 'idle' humanoid state"); it fires when the speed changes, and it fires `0` when the body stops,
	 * which is the edge the `writeAttribute` guard wants. `NPC_CONFIG.RIG_MOVING_SPEED` is Roblox's own `0.01` —
	 * the number its own `Animate` script branches on in `onRunning` — and the loop records each speed as it
	 * arrives, so nothing here samples a velocity per turn and there is no band to tune.
	 *
	 * **The cost, named, and this is the reversal: the rig's half of this fact is now a measurement.** A rig
	 * leaning on a wall it cannot pass reports *not moving* where a blocked player reports a walk, and a rig
	 * shoved by another body reports moving where a shoved player reports whatever its keys say. That is the right
	 * direction of error for a rig — one that cannot move is not walking anywhere — and it was accepted because
	 * the only request-shaped alternative is worse. **`WalkToPoint` against the root's position was the other
	 * candidate and is refused**: before the first `MoveTo` that property holds no position at all, so a rig
	 * nobody has ever asked to walk is indistinguishable from one asked to walk three hundred studs away — and a
	 * rig teleported into the arena with a stale target would publish *walking* through the opening freeze,
	 * exactly while the rigs are being watched line up. The size of the threshold is what makes the measurement
	 * survivable: the fault this replaced was a **five-stud** floor that published creeping rigs as standing, and
	 * `0.01` from an edge-fired source cannot reproduce it. **If `Running` should fire nothing for our rigs, the
	 * symptom is the one we already have** — an idle clip on a walking rig, because the flag then stays at the
	 * `0` it was seeded with — so this is a no-regression bet rather than a new mechanism to debug.
	 *
	 * **Ownership is re-asserted from here, on a throttle**, because this is the one function that
	 * already runs per rig on a clock. See `NPC_CONFIG.NETWORK_OWNERSHIP_RECHECK_SECONDS` for what the
	 * re-check protects and why one call at spawn is not enough; it passes `false` for the report, so a
	 * rig that cannot be owned says so once at setup and not every few seconds.
	 */
	private publishAnimation(model: Model, humanoid: Humanoid, frozen: boolean, loop: NpcLoop, now: number): void {
		// Scope: Npc.publishAnimation — five attribute reads per rig per turn, and the writes they guard.
		if (DEBUG_CONFIG.PROFILE) debug.profilebegin("Npc.publishAnimation");
		this.publishAnimationBody(model, humanoid, frozen, loop, now);
		if (DEBUG_CONFIG.PROFILE) debug.profileend();
	}

	/**
	 * The body of {@link publishAnimation}, split off **only** so the scope above can wrap it.
	 *
	 * **Why a second method rather than the pair written into the body.** `publishAnimation` returns early —
	 * `if (now - loop.ownershipCheckedAt < ...) return;` — and a `profileend` written after the last
	 * statement of a function with an early `return` in front of it is a scope that never closes on the
	 * ordinary path. The split makes the pairing provable instead of argued: the wrapper has exactly one
	 * statement between its `begin` and its `end`, and every exit from the body is a return into the
	 * wrapper, which then closes the scope. Nothing else moved — this is the same code, one stack frame
	 * deeper, and the frame costs a call whether the flag is on or off.
	 */
	private publishAnimationBody(model: Model, humanoid: Humanoid, frozen: boolean, loop: NpcLoop, now: number): void {
		this.writeAttribute(model, NPC_ANIM_MOVING_ATTRIBUTE, loop.runningSpeed > NPC_CONFIG.RIG_MOVING_SPEED);
		this.writeAttribute(model, NPC_ANIM_SPRINTING_ATTRIBUTE, this.speeds.isSprinting(model));
		this.writeAttribute(model, NPC_ANIM_GROUNDED_ATTRIBUTE, humanoid.FloorMaterial !== Enum.Material.Air);
		this.writeAttribute(model, NPC_ANIM_FROZEN_ATTRIBUTE, frozen);
		this.writeAttribute(model, NPC_ANIM_THROWING_ATTRIBUTE, this.balls.getHeldBall(model) !== undefined);

		if (now - loop.ownershipCheckedAt < NPC_CONFIG.NETWORK_OWNERSHIP_RECHECK_SECONDS) return;

		loop.ownershipCheckedAt = now;
		this.ownForServer(model, false);
	}

	/**
	 * Writes an attribute only where it differs from what is already on the instance.
	 *
	 * **The comparison is the function.** An attribute write is a replication, so the state above can
	 * only afford to be recomputed every turn if a rig that is doing what it was already doing writes
	 * nothing at all. The value comes back from the instance as `AttributeValue` and is compared as it
	 * is rather than type-checked first, because this is a *write* guard: a value that is not the one
	 * this service last wrote is a value somebody else put there, which is a reason to write rather
	 * than a reason to refuse.
	 */
	private writeAttribute(model: Model, name: string, value: number | boolean): void {
		if (model.GetAttribute(name) === value) return;

		model.SetAttribute(name, value);
	}

	/**
	 * Tells the behaviors the model still wears that its humanoid has died.
	 *
	 * The tags are asked about even though the health is already known to have run out: the
	 * loop can end with both true at once — the tag taken off on the frame the model died —
	 * and in that case nothing was interrupted, so nothing gets a say.
	 *
	 * A model that has left the world is skipped as a whole. There is nothing there to react
	 * to, and the one behavior that would react would be standing up a rig that no longer
	 * exists.
	 */
	private announceDeath(model: Model): void {
		if (model.Parent === undefined) return;

		if (DEBUG) print(`[NPC] ${model.Name}: died`);

		// **A rig's run of hits dies with it, through the same reset a player's death uses.** A player's
		// death is resolved by the round and reaches `SuperService.noteDeath` from `RoundService.handleDeath`;
		// a rig's is resolved here, because a rig has no `Player` for the round's handler to be handed. The
		// call is the same either way — the streak row goes to nought and the crown is recomputed — and the
		// one difference is bookkeeping inside `noteDeath`: a rig's row is *deleted*, because the key is a
		// model that `RespawnBehavior` is about to destroy.
		this.abilities.noteDeath(model);

		for (const behavior of this.behaviors) {
			if (model.HasTag(behavior.tag)) behavior.onDied?.(model);
		}
	}

	/**
	 * Tells the behaviors the model still wears that it has been **placed**: moved by something that owns
	 * where rigs stand.
	 *
	 * **The sibling of {@link announceDeath}, and needed for the same reason.** A `CFrame` write made by
	 * another service is not a fact a behavior can see — the loop is what hands out turns, and the one
	 * behavior that remembers a position asks for none at all (`tickInterval: math.huge`) — so "this rig is
	 * where it belongs now" has to be said out loud by whoever moved it. The movers are
	 * `RoundService.teleportTeamsToArena`, `LobbyRigService.moveWalkersToArena` and
	 * `RoundService.returnRigsToLobby`. `NpcBehavior.onPlaced` states the rule that separates a *placement*
	 * from a rig that walked somewhere by itself, and why the difference matters to a home.
	 *
	 * **Public, and that is the one difference from the death announcement**: the movers are other
	 * services, where a death is announced by this service's own loop and by nothing else.
	 *
	 * Every behavior the model wears is asked and each decides — exactly as `announceDeath` does, for the
	 * same reason: a placement is a fact about the model, and what to make of it is the hook's business.
	 * A behavior with no use for one simply does not write the hook.
	 */
	public announcePlaced(model: Model): void {
		for (const behavior of this.behaviors) {
			if (model.HasTag(behavior.tag)) behavior.onPlaced?.(model);
		}
	}

	/**
	 * Drops the record of a loop that has ended, **and hangs up the subscription it was holding**.
	 *
	 * Only if it is still *this* loop: a model can be re-tagged while its old loop
	 * is waiting out its period, and the old one must not delete the new one's
	 * entry on its way out. The `Running` connection is dropped unconditionally, because it belongs to the loop
	 * rather than to the model — a loop that has ended is a loop nobody publishes from, whether or not a newer
	 * loop has already taken the rig. The early return for a humanoid that never appeared reaches this with no
	 * connection, which is what the optional field is for.
	 */
	private forget(model: Model, loop: NpcLoop): void {
		loop.running?.Disconnect();
		loop.running = undefined;

		if (this.loops.get(model) === loop) this.loops.delete(model);
	}

	/** The shortest interval any behavior asked for, which is how often the loop turns. */
	private fastestInterval(): number {
		let fastest = math.huge;
		for (const behavior of this.behaviors) fastest = math.min(fastest, behavior.tickInterval);

		return fastest === math.huge ? IDLE_PERIOD : fastest;
	}

	/** Which of `model`'s behaviors are switched on, for the startup print. */
	private describeBehaviors(model: Model): string {
		const active: string[] = [];
		for (const behavior of this.behaviors) {
			if (model.HasTag(behavior.tag)) active.push(behavior.tag);
		}

		return active.size() === 0 ? "(no behavior tags)" : active.join(", ");
	}
}
