import { Controller, OnStart } from "@flamework/core";
import { CollectionService, Workspace } from "@rbxts/services";
import {
	CHARGING_ATTRIBUTE,
	NPC_ANIM_FROZEN_ATTRIBUTE,
	NPC_ANIM_GROUNDED_ATTRIBUTE,
	NPC_ANIM_MOVING_ATTRIBUTE,
	NPC_ANIM_SPRINTING_ATTRIBUTE,
	NPC_TAG,
} from "shared/constants";
import { BodyConditions, BodyRender, applyBodyRender, destroyBodyRender, startBodyRender } from "../../bodyAnimation";

/** Prints each rig as it starts being dressed, and any rig that cannot be. */
const DEBUG = false; // off for frame time — see shared/config/debug.config.ts

/**
 * How long a rig is given to produce its `Humanoid` and its `Animator`, in seconds, and how long each
 * retry turn waits as well.
 *
 * **A wait with an end rather than `WaitForChild`'s default**, and for the reason
 * `LocomotionAnimationController` gives about the same wait on a player's `Animate` script: the things
 * being waited for are made on the *other machine* (`NpcService.ensureAnimator`, and the body itself),
 * so a rig watched before its parts have replicated is a rig that must not leave a thread hanging for
 * ever. Long enough for a second replication step, short enough that the line it ends in is worth
 * reading.
 */
const ANIMATOR_TIMEOUT_SECONDS = 5;

/**
 * How many more times a rig's `Animator` is looked for, once the wait above has run out, and each of
 * those waits is the same length. **Placeholder.** Three turns is fifteen seconds of looking, which is
 * long enough for a replication step that is merely late and short enough that a rig which will never
 * have an animator stops costing a thread.
 *
 * **A retry loop is needed as well as the incremental retry in {@link RigAnimationController.apply},
 * and that is the case this file's own economics create.** `apply` runs on an attribute change, and a
 * rig standing still has nothing left to change: a client that joins a running server, waits out the
 * animator, and then watches a rig whose state was published before it arrived would never see another
 * change to re-ask on. This is the loop that covers it, and it is only ever started for a rig the wait
 * has already failed on — a rig with an animator spawns nothing.
 */
const ANIMATOR_RETRY_ATTEMPTS = 3;

/**
 * **What is *not* here any more, and where it went.**
 *
 * This file used to own the whole mechanism: the clip vocabulary, the fade, the rung each clip plays on, the
 * mapping from a dodge direction to one of four clips, the track cache, and the branch order that ranks an
 * event over a condition. Every one of those is now shared with the player's own body, because a second copy
 * of them is the second copy that made a state work on one body and do nothing on the other:
 *
 *   - **the vocabulary** — `shared/config/animation.config.ts`, one table for both bodies;
 *   - **the decision** — `shared/animation.ts`'s `bodyClipFor` (which clip) and `clipIdFor` (which id for
 *     this rig type);
 *   - **the rendering** — `client/controllers/character/BodyAnimation.ts`, used by this file and by
 *     `LocomotionAnimationController` alike, which is where the fade, the two rungs, the event attributes
 *     and the track cache live.
 *
 * What is left here is the one thing that is a *rig's* problem rather than a body's: **finding the rigs and
 * reading the state the server publishes for them.**
 */

/**
 * One rig this client is dressing: the two objects a body is animated through, and its renderer.
 *
 * **State rather than locals, because a rig outlives every call that starts it.** The row is what remembers the
 * animator once it has replicated, and what has to be disconnected when the rig goes.
 */
interface Rig {
	/** The body's animator, once it has replicated. Nothing plays until it has. */
	animator?: Animator;

	/** The rig's own body — read for `RigType`, and handed to the renderer it is animated through. */
	humanoid?: Humanoid;

	/**
	 * The shared renderer, once the animator is known.
	 *
	 * **This field being set *is* "this rig is being dressed"**, which is why the retry loop and the wait below
	 * both test it rather than testing the animator: the animator arriving and a renderer existing differ by
	 * exactly one line, and a row that had one but not the other would be a body this client is watching and
	 * not drawing.
	 */
	body?: BodyRender;

	/** What has to be disconnected when the rig goes: its two instances signals. */
	connections: RBXScriptConnection[];
}

/**
 * Dresses every rig this client can see, from the state the server publishes for it — **the rig half of the one
 * mechanism.**
 *
 * **What this file owns is three things and nothing else**: finding the rigs (a tag walk), waiting for the two
 * objects a body is animated through to replicate, and asking `NpcService`'s published attributes for the state.
 * Everything after that is `BodyAnimation`'s — the same renderer the player's own body is dressed by — so a state
 * added to `animation.config.ts` plays here and there alike. This file used to own the whole mechanism while the
 * player's controller owned a different one; the note above says what moved and where it went.
 *
 * **Why a client renders a rig at all, since the server could.** A rig's `Animator` belongs to the server, so a
 * track started there replicates every CFrame change of every rig to every client: traffic for rigs nobody is
 * looking at, and stutter under latency because the animation is being driven from the other end. A
 * client-dressed rig costs each client a track on a rig it can see and nothing at all for the ones it cannot.
 * **A player's own body is rendered the same way** — by the client that owns it — which is the arrangement the
 * unification made explicit rather than a rig's privilege.
 *
 * **Why not decide from the body on screen.** A rig is server-owned, so a client's copy of it is behind: the body
 * it can see is a replay of where the server put it a round-trip ago. Deciding a clip from that body's own motion
 * would play the walking clip for a rig that has already stopped — which is exactly why the facts a body cannot
 * measure for itself are published, and why the two bodies' **sources** differ while their **decision** does not.
 * See `BodyConditions`.
 *
 * **The rigs are found by tag, not by watching `Workspace`.** `CollectionService` answers about the whole
 * DataModel, which is what makes this thirty lines instead of a descendant scan plus a filter for an attribute —
 * and it is the pattern `NpcService`, `OutlineService`, `BallSpawnerService` and `BallPickupService` all use for
 * the same reason. **This is the second tag read on the client**; the first is `PRACTICE_ZONE_TAG`, in
 * `client/roundZone.ts`, and `TAGS.md` records where the tag is read from.
 *
 * **The local player's body is not touched here**, because it never wears this tag. It is dressed by
 * `LocomotionAnimationController`, the renderer's other caller.
 *
 * **What this is not:** not a server-side animation replicator (the server loads no tracks on a rig), not a state
 * machine (the decision is `shared/animation.ts`'s), and not a culler — nothing here decides whether a rig should
 * be animated, and the engine's own streaming decides how many of them a client can see.
 */
@Controller()
export class RigAnimationController implements OnStart {
	/** Every rig being dressed right now, and the row that remembers what it is playing. */
	private readonly rigs = new Map<Model, Rig>();

	public onStart(): void {
		// **The rigs that are already here, because the added-signal will never fire for them again.**
		// A client mounting into a server that has been running has rigs standing in front of it whose
		// tags arrived with the place rather than being applied afterwards — the same blind spot
		// `NpcService.onStart` scans for, and it covers it the same way.
		for (const instance of CollectionService.GetTagged(NPC_TAG)) {
			if (instance.IsA("Model")) this.watch(instance);
		}

		CollectionService.GetInstanceAddedSignal(NPC_TAG).Connect((instance) => {
			if (instance.IsA("Model")) this.watch(instance);
		});

		// **A rig that loses the tag is forgotten, and that is the respawn path as much as the
		// retirement path.** `RespawnBehavior` builds a replacement body out of a template and puts
		// every tag back on it, so the corpse stops being a rig and the new body starts being one: this
		// pair of signals is the whole of the handover, with no respawn special case anywhere.
		CollectionService.GetInstanceRemovedSignal(NPC_TAG).Connect((instance) => {
			if (instance.IsA("Model")) this.forget(instance);
		});
	}

	/**
	 * Starts dressing `model`, and waits briefly for the part of it that plays anything.
	 *
	 * **Both waits are for things made on the other machine, and both are on a timeout.** The server
	 * creates the rig's `Animator` (`NpcService.ensureAnimator`) so that every client loads onto the
	 * *same* replicated instance — a client-made animator would be a rig animated through an object no
	 * other client can see. The two facts arrive in the same replication step in practice, but nothing
	 * promises it, and a rig watched one frame too early used to be a rig that never animated at all.
	 */
	private watch(model: Model): void {
		if (this.rigs.has(model)) return;

		const rig: Rig = { connections: [] };
		this.rigs.set(model, rig);

		rig.connections.push(model.AttributeChanged.Connect(() => this.apply(model, rig)));

		// **Leaving the world is the cleanup, and it is asked of the model rather than of its parent.**
		// `AncestryChanged` fires for the instance and for everything under it, so this covers a rig
		// destroyed outright, a rig whose ancestor was destroyed, and a rig taken back out of
		// `Workspace` — the three ways a rig stops being something a client should be spending tracks
		// on. `IsDescendantOf(Workspace)` is the same test the server's own gate makes, for the same
		// reason.
		rig.connections.push(
			model.AncestryChanged.Connect(() => {
				if (!model.IsDescendantOf(Workspace)) this.forget(model);
			}),
		);

		task.spawn(() => {
			// **The humanoid is waited for as well, and that is a correction rather than symmetry.** It
			// used to be read once, with `FindFirstChildWhichIsA`, while the animator below got five
			// seconds — so a rig whose `Humanoid` had not replicated yet failed instantly and said
			// "no Animator", which is a line pointing at the wrong object. A client mounting into a
			// running server sees rigs whose tags and children arrive from a place file, a clone or a
			// respawn, and nothing promises the model is whole on the frame its tag is seen.
			const humanoid = model.WaitForChild("Humanoid", ANIMATOR_TIMEOUT_SECONDS);
			const animator = humanoid?.WaitForChild("Animator", ANIMATOR_TIMEOUT_SECONDS);

			// **Two ways to have nothing to do, and both are ordinary.** The rig may have been
			// forgotten while this was waiting — a body that died in the same second — in which case
			// there is nothing to report at all.
			if (this.rigs.get(model) !== rig) return;

			// **And then the two failures are told apart, because they are different bugs.** A rig with
			// no `Humanoid` is a model somebody tagged by hand that is not a rig at all — nothing here
			// can do anything about it and no clip is involved — while a rig with a humanoid and no
			// `Animator` is a rig the server failed to prepare (`NpcService.ensureAnimator`, which runs
			// for every model it manages) or one whose animator has not replicated *yet*, and *that* one
			// is recoverable: see `apply`, which keeps looking. One message for both sent the reader
			// after an animator that was never the missing object.
			if (!humanoid || !humanoid.IsA("Humanoid")) {
				warn(`[Rig] ${model.Name}: no Humanoid — nothing to animate, and nothing will be`);
				return;
			}

			if (!animator || !animator.IsA("Animator")) {
				warn(`[Rig] ${model.Name}: no Animator yet — looking again for a moment`);
				rig.humanoid = humanoid;

				// **And it goes on looking, because a rig standing still will not change its state again.**
				// The retry inside `apply` covers a rig whose state moves — which is every rig in play —
				// and this covers the one it cannot: a body whose whole state was published before this
				// client arrived and which has no reason to publish anything else. See the constant.
				task.spawn(() => this.keepLooking(model, rig));
				return;
			}

			this.dress(model, rig, humanoid, animator);
		});
	}

	/**
	 * Builds `model`'s renderer, and gives it the state the rig is in right now.
	 *
	 * **One place, called from the two places the animator can turn up.** That is the whole reason this exists
	 * rather than a line inside `watch`: a rig whose animator has not replicated is looked for again on every
	 * attribute change (see `keepLooking` and `apply`), and both of those paths have to end in exactly this —
	 * one renderer per body, built once, handed the state. A second copy of these three lines is a second
	 * renderer per rig, which is two sets of tracks fighting over the same limbs.
	 *
	 * The state is applied at once rather than waited for, because a rig that is already standing in front of
	 * this client has already been published: a body whose attributes are all absent reads as the resting state,
	 * which is why this cannot be a wait for something to arrive.
	 */
	private dress(model: Model, rig: Rig, humanoid: Humanoid, animator: Animator): void {
		rig.humanoid = humanoid;
		rig.animator = animator;
		rig.body = startBodyRender(model, humanoid, animator, "Rig");

		if (DEBUG) print(`[Rig] ${model.Name}: dressing from the state the server publishes`);

		this.apply(model, rig);
	}

	/**
	 * Reads the rig's published state and hands it to the renderer — **the whole of this file's reading, and
	 * none of its deciding.**
	 *
	 * **Every attribute is read as the type it should be rather than trusted**, which is the convention
	 * `PICKUP_LOCKED_UNTIL` sets: an attribute of another type means something else wrote it, and a value that
	 * is not a number is not a speed. A rig whose state has not arrived reads as standing still on the ground,
	 * which is the honest default — see `conditionsOf`.
	 *
	 * **A rig whose animator had not replicated is looked at again here, rather than once at the start and never
	 * again.** The wait in {@link watch} ends — it has to, the object it waits for is made on the other machine —
	 * and the first version of this gave up for the whole life of the rig when it did: one late replication step
	 * and a rig stood motionless for ever, with one line in the output and nothing that would ever try again.
	 * This method runs on every attribute change, so asking once more on each of them costs a child lookup on a
	 * body that is already being read and turns the failure into a delay.
	 *
	 * **A call that names the clip already playing writes nothing**, and that is the renderer's own guard — this
	 * method is called on every attribute change, so up to five times for one logical transition, and the speed
	 * changes on its own as a rig starts and stops walking.
	 */
	private apply(model: Model, rig: Rig): void {
		const humanoid = rig.humanoid;
		if (!humanoid) return;

		if (rig.body === undefined) {
			const animator = rig.animator ?? humanoid.FindFirstChildOfClass("Animator");
			if (animator === undefined) return;

			this.dress(model, rig, humanoid, animator);

			return;
		}

		applyBodyRender(rig.body, this.conditionsOf(model));
	}

	/**
	 * The facts a rig cannot measure for itself, as the server published them — **and the one it answers by
	 * construction.**
	 *
	 * **Absent reads as an ordinary standing body, and that is the safe direction.** A rig whose replacement
	 * body has just replicated, or one whose first publish is a turn away, is a body nobody has asked to move
	 * yet: `moving` false and grounded `true` land on the standing clip, whereas the alternative — the other
	 * default — is a rig that reads as falling for a turn, which every player would see as a different bug. The
	 * frozen flag is the one that defaults the other way, because a rig whose freeze state is unknown is a rig
	 * that has not been frozen yet.
	 *
	 * **`moving` and `sprinting` are the server's *requests*, and they stand where a banded speed used to.** That
	 * speed had to be banded so a rig walking a straight line would not rewrite the attribute every frame — and
	 * because the band was floored, every rig moving slower than five studs a second published "standing", so a
	 * rig creeping to a ball slid along in the standing clip. A request has no such seam: the server either asked
	 * the rig to walk or it did not. See `NPC_ANIM_MOVING_ATTRIBUTE` for the whole of that argument.
	 *
	 * **`deferToDefault` is `false` for a rig, and it is a fact rather than a default.** The deferral exists for
	 * a body that can be *sat on*: Roblox's own `Animate` script supplies `sit`, `climb` and `swim`, and a player
	 * is the only body here the engine runs that script for. A rig has no such script — its tracks are loaded by
	 * this client — so deferring a rig would stop our clips and put nothing in their place, which is a rig
	 * standing in its bind pose. The states a rig does reach are answered otherwise: a freeze is `frozen` below,
	 * and a corpse stops being rendered at all when `RespawnBehavior` replaces it. See
	 * `BodyConditions.deferToDefault`.
	 */
	private conditionsOf(model: Model): BodyConditions {
		return {
			moving: this.flagOf(model, NPC_ANIM_MOVING_ATTRIBUTE, false),
			sprinting: this.flagOf(model, NPC_ANIM_SPRINTING_ATTRIBUTE, false),
			grounded: this.flagOf(model, NPC_ANIM_GROUNDED_ATTRIBUTE, true),
			frozen: this.flagOf(model, NPC_ANIM_FROZEN_ATTRIBUTE, false),
			deferToDefault: false,
			charge: this.chargeOf(model),
			// **Nothing, and that is a fact rather than a gap.** A rig's windup and its throw mark are both the
			// server's and are written in one frame, so this client never sees the gap a player's round trip
			// creates — the renderer falls back to the level it remembered while the pose was held. See
			// `BodyConditions.releasedCharge`.
			releasedCharge: undefined,
		};
	}

	/**
	 * **How far into a windup this rig is, `0` to `1`, or nothing when it is not winding up** — the rig's half
	 * of the fact `BodyConditions.charge` carries, and the one place it is read.
	 *
	 * **`CHARGING_ATTRIBUTE` and not the throw mark.** The mark (`AnimThrow`) means *a throw has happened* and
	 * is written by `BallService` at the release; the charge is the hold *before* it, published by
	 * `ThrowBehavior`'s windup tracker as a number precisely so a client can draw the arm coming back. The
	 * renderer holds the throw clip on this value and releases it when this value goes, so the two attributes
	 * are the two halves of one motion: charge up, mark over.
	 *
	 * **Absent is the ordinary answer and reads as "not charging"**, which is the safe direction — a rig whose
	 * attribute has not replicated is a rig standing normally, not one stuck in a held pose. Validated as a
	 * number rather than trusted, the convention every attribute read here keeps: something else could have
	 * written a string, and a value that is not a number is not a charge.
	 */
	private chargeOf(model: Model): number | undefined {
		const value = model.GetAttribute(CHARGING_ATTRIBUTE);
		if (!typeIs(value, "number")) return undefined;

		return math.clamp(value, 0, 1);
	}

	/**
	 * Looks for a rig's `Animator` a few more times, for a body whose published state will not change.
	 *
	 * **Bounded, and it ends the moment the body is being dressed.** Every turn asks `apply` — which is the
	 * one place the animator is looked up and the one place the state is read, so a success here needs no
	 * second copy of either — and leaves as soon as the row has a renderer, so a rig that answers on the
	 * first turn costs fifteen seconds of nothing rather than three rounds of it. A rig that never answers is
	 * a rig that has already said so in one line, and this is the loop that stops asking.
	 *
	 * **A rig that is forgotten mid-search is dropped, not chased.** A corpse, a respawn or a rig taken out of
	 * the world takes its row out of the table, and the check here is the same one `watch` makes for the same
	 * reason: a row that is not this row is a body somebody else is dressing now.
	 */
	private keepLooking(model: Model, rig: Rig): void {
		for (let attempt = 0; attempt < ANIMATOR_RETRY_ATTEMPTS; attempt++) {
			task.wait(ANIMATOR_TIMEOUT_SECONDS);

			if (this.rigs.get(model) !== rig || rig.body !== undefined) return;

			this.apply(model, rig);

			if (rig.body !== undefined) return;
		}
	}

	/**
	 * Stops dressing `model`: everything it was given goes with the row.
	 *
	 * **The renderer's teardown is its own, and it is guarded there** — see `BodyAnimation.destroy`, which
	 * destroys the tracks and swallows the case where the animator has already gone with the body. All this
	 * method has to get right is the row: drop it *first*, so a late attribute change or a signal already in
	 * flight finds nothing and cannot rebuild a renderer for a body that is leaving.
	 */
	private forget(model: Model): void {
		const rig = this.rigs.get(model);
		if (!rig) return;

		this.rigs.delete(model);

		for (const connection of rig.connections) connection.Disconnect();
		rig.connections = [];

		const body = rig.body;
		if (body !== undefined) destroyBodyRender(body);

		rig.body = undefined;
	}

	/** A boolean attribute, or `fallback` where it is absent or is not a boolean. */
	private flagOf(model: Model, name: string, fallback: boolean): boolean {
		const value = model.GetAttribute(name);

		return typeIs(value, "boolean") ? value : fallback;
	}
}
