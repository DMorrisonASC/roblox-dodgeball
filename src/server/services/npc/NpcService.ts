import { OnStart, Service } from "@flamework/core";
import { CollectionService, HttpService, Workspace } from "@rbxts/services";
import { THROWER_TOKEN } from "shared/constants";
import { NPC_TAG, NpcBehavior } from "../../npc/Behavior";
import { createCatchBehavior } from "../../npc/behaviors/CatchBehavior";
import { createPickupBehavior } from "../../npc/behaviors/PickupBehavior";
import { createRespawnBehavior } from "../../npc/behaviors/RespawnBehavior";
import { createThrowBehavior } from "../../npc/behaviors/ThrowBehavior";
import { BallPickupService } from "../ball/BallPickupService";
import { BallService } from "../ball/BallService";
import { CatchService } from "../actions/CatchService";
import { FreezeService } from "../actions/FreezeService";

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
	) {
		this.behaviors = [
			createCatchBehavior(catches, balls),
			createThrowBehavior(balls),
			createPickupBehavior(pickups, balls),
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
		model.PivotTo(cframe);
		model.Parent = Workspace;

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

		const loop: NpcLoop = { stopped: false };
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
			// **Inside the loop rather than in its condition, and that move is a bug fix rather than a
			// preference.** This first went into the `while` above — which meant a frozen rig *left the loop*,
			// and a loop is not a thing that comes back: `start` is called from the tag's added-signal and
			// from the scan at startup, and a rig already wearing its tag never fires either again. So the
			// freeze would have been permanent, and worse, the line after this loop is what reports a
			// death: a rig killed while frozen left through the freeze rather than through its health,
			// `announceDeath` was never called, and `RespawnBehavior` — which learns about deaths from that
			// call and from nothing else — never brought it back. That is the whole of "the enemy falls down
			// and never re-spawns", and it only happened to rigs that were frozen when they died.
			if (this.freezes.isFrozen(model)) {
				task.wait(period);
				continue;
			}

			const now = os.clock();

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
