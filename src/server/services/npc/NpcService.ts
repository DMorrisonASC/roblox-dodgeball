import { OnStart, Service } from "@flamework/core";
import { CollectionService, HttpService, Workspace } from "@rbxts/services";
import { ANIMATION_SPEED_BAND } from "shared/animation";
import {
	NPC_ANIM_FROZEN_ATTRIBUTE,
	NPC_ANIM_GROUNDED_ATTRIBUTE,
	NPC_ANIM_SPEED_ATTRIBUTE,
	NPC_ANIM_THROWING_ATTRIBUTE,
	RIG_TEAM_ATTRIBUTE,
	THROWER_TOKEN,
} from "shared/constants";
import { NPC_CONFIG } from "shared/config/npc.config";
import { resolveDodgeable } from "shared/dodge";
import { NPC_TAG, NpcBehavior } from "../../npc/Behavior";
import { createCatchBehavior } from "../../npc/behaviors/CatchBehavior";
import { createDodgeBehavior } from "../../npc/behaviors/DodgeBehavior";
import { createGatherBehavior } from "../../npc/behaviors/GatherBehavior";
import { createPickupBehavior } from "../../npc/behaviors/PickupBehavior";
import { createRespawnBehavior } from "../../npc/behaviors/RespawnBehavior";
import { createSeekBehavior } from "../../npc/behaviors/SeekBehavior";
import { createThrowBehavior } from "../../npc/behaviors/ThrowBehavior";
import { BallPickupService } from "../ball/BallPickupService";
import { BallService } from "../ball/BallService";
import { CatchService } from "../actions/CatchService";
import { DodgeService } from "../actions/DodgeService";
import { FreezeService } from "../actions/FreezeService";
import { MatchService } from "../match/MatchService";
import { TeamLabel } from "../round/team";

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
		// **The pads' own service, injected for the gathering behaviour's counting rule and nothing else.** A
		// rig with no side is sent to the side with fewer occupants, and "how many players are on each side" is
		// `MatchService.countsFor` — the roster the pads actually serve. The arrow points one way
		// (`MatchService` has no reason to know an NPC exists), so there is no construction cycle.
		private readonly matches: MatchService,
	) {
		this.behaviors = [
			createCatchBehavior(catches, balls),
			// **After the catcher, and before everything else, and the order is not cosmetic.** The
			// behaviors share facts that are written by *services* — a held ball, a chase, a dash — so
			// almost nothing here depends on the order at all. This one case does: a catching rig's window
			// is opened by `Behavior_Catching`'s own tick, so on a rig's *first* turn a dodge ticked before
			// the catcher would find no window open yet and could fire. Behind it, the window is already
			// open on the turn it matters, which is what makes "a rig wearing both is a catcher that never
			// dodges" exactly true rather than true from the second turn onwards.
			createDodgeBehavior(dodges, balls),
			createThrowBehavior(balls),
			createPickupBehavior(pickups, balls),
			// The pair to the line above, and the difference between a rig that collects and a rig
			// that only takes what rolls into its reach: this one walks to the nearest loose ball,
			// and that one takes it. A rig needs both tags for the mechanic — either alone is a rig
			// that stands beside a ball it will never pick up, or one that never goes anywhere.
			createSeekBehavior(pickups, balls),
			// **The only behavior about where a rig *is* rather than what it does**, and the only one that reads a
			// phase: an intermission sends the rig to a join pad, the start of a round walks it to its side's
			// spawn on the court, and the end of the round walks it back to the lobby spawn it began on. It is
			// placed after the seeker so that on a rig wearing both the ball hunt has already had
			// its say this turn — the two both call `MoveTo` and the later call is the one that sticks — which
			// is the reading that matters in the lobby, where a seeker has nothing to fetch and the pad is the
			// destination that counts.
			createGatherBehavior(matches),
			// The one behavior that needs something no other one does: the ball the rig was
			// holding, so it can be taken out of the copy this makes. It re-enters this service
			// the way any other rig does — by putting `NPC` on a model and letting the
			// added-signal start its loop — so there is no callback and no hole in the registry.
			createRespawnBehavior(balls),
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
	 * Puts a rig in the world under this system's control — **the one way a rig the code owns comes to exist.**
	 *
	 * **What "live" means now, because this method had no caller until `RigSpawnerService` and that changes
	 * what its contract costs.** While every rig was placed by hand, the tag was the whole interface and this
	 * was a convenience: nothing depended on the tag order or on the side being written, because a person had
	 * already done both in Studio. A spawner depends on all of it — it decides how many rigs exist and what
	 * side each is on, and it does so through these four arguments — so the order below is load-bearing
	 * rather than tidy, and a rig this method builds is a rig the game plays with.
	 *
	 * The `NPC` tag goes on **last**, after the behavior tags, so the added-signal fires with the whole set
	 * already in place and the first tick can never land on a half-described model. **The side, if one is
	 * given, is written before either**, so a rig spawned onto a side can throw at the other one from its
	 * very first tick rather than from the next intermission.
	 *
	 * **The copy's own tags are cleared first, and that is what makes a template's tags harmless.** `Clone`
	 * copies tags, so a template that wears `NPC` — a rig somebody dragged into `ServerStorage` rather than
	 * stripped — would hand its copy that entry point and every behaviour beside it, and the copy would be
	 * managed before this method had added anything. It would also inherit the template's `RigTemplate` tag,
	 * which no live rig should wear. So the tag set is *decided here* rather than appended to: whatever the
	 * template wears, a spawned rig wears exactly `behaviorTags` and `NPC`. That is the same strip
	 * `RespawnBehavior.prepare` makes of its own template, for the same reason, at the other door.
	 *
	 * `team` is optional: a rig with no side is a working rig rather than a broken one — it simply fights for
	 * nobody, and `GatherBehavior` gives it a side the next time it walks to a pad. `RigSpawnerService` always
	 * names one; a rig a person spawns by hand needs no side until a match is on.
	 *
	 * Note what is deliberately **not** here: nothing that equips the rig. Whatever
	 * a behavior needs in order to run — a ball in the hand, say — that behavior
	 * asks for itself when its tag is seen. See `NpcBehavior.prepare`.
	 */
	public spawn(template: Model, cframe: CFrame, behaviorTags: string[], team?: TeamLabel): Model {
		const model = template.Clone();
		model.PivotTo(cframe);
		model.Parent = Workspace;

		// **Every tag off the copy before any goes on**, so a spawned rig's tags are exactly what this method
		// was asked for and never a description the template happened to be wearing. See the doc above for the
		// two faults that hides — a template that is itself managed, and a `RigTemplate` tag riding onto a
		// live rig.
		for (const tag of CollectionService.GetTags(model)) model.RemoveTag(tag);

		// **The side goes on before the tags**, for the reason the behavior tags go on before `NPC`: the loop
		// the entry point starts reads the rig on its first turn, and a throw on that turn needs to know whose
		// side the rig is on. See `RIG_TEAM_ATTRIBUTE` for why a rig has its own key rather than the player's.
		if (team !== undefined) model.SetAttribute(RIG_TEAM_ATTRIBUTE, team);

		for (const tag of behaviorTags) model.AddTag(tag);
		model.AddTag(NPC_TAG);

		return model;
	}

	/** Begins managing `model`: a thrower token if it has none, then one loop. */
	private start(model: Model): void {
		if (this.loops.has(model)) return;

		// A rig tagged by hand never came through `spawn`, so this is where it is
		// given something to be identified by — the same thing a player's character
		// is given when it is handed a ball, which is what lets one immunity check
		// cover both. Once only: a GUID that changed would break the ball already in
		// flight.
		if (model.GetAttribute(THROWER_TOKEN) === undefined) {
			model.SetAttribute(THROWER_TOKEN, HttpService.GenerateGUID(false));
		}

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

		const loop: NpcLoop = { stopped: false, ownershipCheckedAt: os.clock() };
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
		/** When each behavior last ran, so periods are honoured per behavior. */
		const lastRan = new Map<string, number>();
		/** Behaviors that have had their `prepare`, so it happens once and not per tick. */
		const prepared = new Set<string>();

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
				behavior.tick(model, humanoid);
			}

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
	 * written, so a rig walking in a straight line publishes its speed once and then says nothing at
	 * all — and there is no second copy of "what did I last publish" to keep in step, because the rig
	 * carries it. The speed is banded before it is written for exactly that reason: see
	 * `ANIMATION_SPEED_BAND`, which also explains why the two thresholds downstream sit where they do.
	 *
	 * **The speed is measured the way the player's own controller measures its body** —
	 * `HumanoidRootPart.AssemblyLinearVelocity`, horizontally — so both callers of `animationFor` are
	 * reading the same quantity off the same kind of part. On the server that figure is only true while
	 * the server owns the rig, which is what {@link ownForServer} is for.
	 *
	 * **Ownership is re-asserted from here, on a throttle**, because this is the one function that
	 * already runs per rig on a clock. See `NPC_CONFIG.NETWORK_OWNERSHIP_RECHECK_SECONDS` for what the
	 * re-check protects and why one call at spawn is not enough; it passes `false` for the report, so a
	 * rig that cannot be owned says so once at setup and not every few seconds.
	 */
	private publishAnimation(model: Model, humanoid: Humanoid, frozen: boolean, loop: NpcLoop, now: number): void {
		const velocity = humanoid.RootPart?.AssemblyLinearVelocity;
		const speed = velocity === undefined ? 0 : math.sqrt(velocity.X * velocity.X + velocity.Z * velocity.Z);

		this.writeAttribute(model, NPC_ANIM_SPEED_ATTRIBUTE, math.floor(speed / ANIMATION_SPEED_BAND) * ANIMATION_SPEED_BAND);
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

		for (const behavior of this.behaviors) {
			if (model.HasTag(behavior.tag)) behavior.onDied?.(model);
		}
	}

	/**
	 * Drops the record of a loop that has ended.
	 *
	 * Only if it is still *this* loop: a model can be re-tagged while its old loop
	 * is waiting out its period, and the old one must not delete the new one's
	 * entry on its way out.
	 */
	private forget(model: Model, loop: NpcLoop): void {
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
