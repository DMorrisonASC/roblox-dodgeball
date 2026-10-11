import { Controller, OnStart } from "@flamework/core";
import { CollectionService, Workspace } from "@rbxts/services";
import { AnimationClip, animationFor, clipFor } from "shared/animation";
import {
	NPC_ANIM_FROZEN_ATTRIBUTE,
	NPC_ANIM_GROUNDED_ATTRIBUTE,
	NPC_ANIM_SPEED_ATTRIBUTE,
	NPC_ANIM_THROWING_ATTRIBUTE,
	NPC_TAG,
} from "shared/constants";

/** Prints each rig as it starts being dressed, and any rig that cannot be. */
const DEBUG = true;

/**
 * How long a rig is given to produce its `Animator`, in seconds.
 *
 * **A wait with an end rather than `WaitForChild`'s default**, and for the reason
 * `LocomotionAnimationController` gives about the same wait on a player's `Animate` script: the thing
 * being waited for is made on the *other machine* (`NpcService.ensureAnimator`), so a rig watched
 * before its animator has replicated is a rig that must not leave a thread hanging for ever. Long
 * enough for a second replication step, short enough that the line it ends in is worth reading.
 */
const ANIMATOR_TIMEOUT_SECONDS = 5;

/**
 * How long the change from one clip to the next takes, in seconds.
 *
 * **Crossfaded rather than switched.** A rig's clips were authored separately from one another — walk
 * and sprint in particular — so a hard cut between them reads as a pop rather than as a change of
 * pace. The same figure `LocomotionAnimationController` fades its own two moving clips with, because
 * it is the same pair of clips being swapped.
 */
const FADE_SECONDS = 0.2;

/**
 * The clip a rig wears when the mapping has no clip for it.
 *
 * **`undefined` means "not mine to decide" on the player's side and cannot mean that here.** A player
 * has Roblox's `Animate` script on the body holding the standing and jumping clips, so deferring to
 * it is the right answer for a state this file has no clip for. A rig has no script — a `LocalScript`
 * inside one does not run, because there is no `Player` for it to belong to — so a rig with nothing
 * playing is a rig standing in its bind pose, which is not a pose any state in this game has. The
 * standing clip is the honest reading of "held", "no state published yet" and "a clip this rig type
 * has no id for" alike, and it is what makes a frozen rig look like a rig that has stopped rather
 * than like a rig that has been switched off.
 */
const RESTING_CLIP: AnimationClip = "idle";

/**
 * One rig this client is dressing: what it is playing, and the tracks it can play.
 *
 * **State rather than locals, because a rig outlives every call that starts it**: the tracks are
 * loaded once and replayed for as long as the rig is on screen, and the row is what remembers both.
 */
interface Rig {
	/** The body's animator, once it has replicated. Nothing plays until it has. */
	animator?: Animator;

	/** The rig's own body, read for `RigType`: the id for a clip depends on which rig wears it. */
	humanoid?: Humanoid;

	/** One track per clip this rig has played, loaded on first use and reused after that. */
	tracks: Map<AnimationClip, AnimationTrack>;

	/** The clip playing right now, so a state change that names the same clip writes nothing. */
	playing?: AnimationClip;

	/** What has to be disconnected when the rig goes: its two instances signals. */
	connections: RBXScriptConnection[];
}

/**
 * Plays a rig's animations, on the clients that can see it.
 *
 * **The third of three parts, and it owns the *rendering* of them.** The server owns the state —
 * `NpcService` computes what a rig is doing, because it is the only machine that can, and publishes it
 * as four attributes on the rig. `shared/animation.ts` owns the *decision* — state in, clip name out,
 * pure, so that this file and the player's own controller cannot disagree about what walking is. This
 * file owns what is left: finding the rigs, loading each clip once on each rig, playing the right one
 * when the state says so, and stopping when the rig is gone.
 *
 * **Why a client renders at all, since the server could.** A rig's `Animator` belongs to the server,
 * so a track started there replicates every CFrame change of every rig to every client: traffic for
 * rigs nobody is looking at, and stutter under latency because the animation is being driven from the
 * other end. A client-dressed rig costs each client a track on a rig it can see and nothing at all for
 * the ones it cannot.
 *
 * **Why not purely local either.** A rig is server-owned, so a client's copy of a rig is behind: the
 * body it can see is a replay of where the server put it a round-trip ago. Deciding a clip from that
 * body's own motion would play the walking clip for a rig that has already stopped, which is what the
 * published state is for — the server says what the rig is *doing*, and this machine only decides how
 * to draw it.
 *
 * **The rigs are found by tag, not by watching `Workspace`.** `CollectionService` answers about the
 * whole DataModel, which is what makes this thirty lines instead of a descendant scan plus a filter
 * for an attribute — and it is the pattern `NpcService`, `OutlineService`, `BallSpawnerService` and
 * `BallPickupService` all use for the same reason. **This is the second tag read on the client**; the
 * first is `PRACTICE_ZONE_TAG`, in `client/roundZone.ts`, and `TAGS.md` records where the tag is read
 * from.
 *
 * **Nothing on this machine's own body is touched.** The rigs are found by a tag a player's character
 * never wears, and the local body is dressed by `LocomotionAnimationController` alone — the two paths
 * do not meet, and the fact that they are two *clients'* worth of code is why the mapping between
 * them had to be shared rather than copied.
 *
 * **What this is not:** not a server-side animation replicator (the server loads no tracks on a rig),
 * not a replacement for the player's controller, and not a culler. Nothing here decides whether a rig
 * should be animated: it animates every rig it can see, and the engine's own streaming is what decides
 * how many of them that is.
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
	 * **The wait is for the `Animator`, and it is on the other machine.** The server makes one if the
	 * rig arrived without it (`NpcService.ensureAnimator`) so that every client loads onto the *same*
	 * replicated instance — a client-made animator would be a rig animated through an object no other
	 * client can see. The two facts arrive in the same replication step in practice, but nothing
	 * promises the order, and a rig watched one frame too early would be a rig that never animated and
	 * never said so, because nothing would come along to try again.
	 */
	private watch(model: Model): void {
		if (this.rigs.has(model)) return;

		const rig: Rig = { tracks: new Map(), connections: [] };
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
			const humanoid = model.FindFirstChildWhichIsA("Humanoid");
			const animator = humanoid?.WaitForChild("Animator", ANIMATOR_TIMEOUT_SECONDS);

			// **Two ways to have nothing to do, and both are ordinary.** The rig may have been
			// forgotten while this was waiting — a body that died in the same second — in which case
			// there is nothing to report at all. A rig with no `Animator` *and* still being watched is
			// the case worth a line: the server makes one, so its absence is a mistake rather than a
			// state, and `WaitForChild` matching any class means the class has to be checked here.
			if (this.rigs.get(model) !== rig) return;

			if (!humanoid || !animator || !animator.IsA("Animator")) {
				warn(`[Rig] ${model.Name}: no Animator — left in its rest pose`);
				return;
			}

			rig.humanoid = humanoid;
			rig.animator = animator;

			if (DEBUG) print(`[Rig] ${model.Name}: dressing from the published state`);

			// The rig may already have a state — the server publishes within one turn of starting to
			// manage it — and the `AttributeChanged` connection above only fires on the *next* change,
			// so the state as it stands is applied here. A rig whose attributes are all absent reads as
			// the resting clip, which is why this cannot be a wait for something to arrive.
			this.apply(model, rig);
		});
	}

	/**
	 * Reads the published state and plays the clip it names.
	 *
	 * **The whole of this file's decision-making is one call to `animationFor`.** The four attributes
	 * are the four things the mapping branches on — see `shared/constants.ts` for why the state is
	 * exactly that set and nothing more — and each is read as the type it should be rather than
	 * trusted, which is the convention `PICKUP_LOCKED_UNTIL` sets: an attribute of another type means
	 * something else wrote it, and a value that is not a number is not a speed.
	 *
	 * **Absent reads as resting, not as "wait".** A rig whose state has not arrived — one that has just
	 * replicated, or one whose replacement body is a turn away from its first publish — is a body
	 * standing still on the ground, so speed `0` and grounded `true` are the honest defaults and they
	 * land on the standing clip. The alternative, playing nothing until something arrives, is a rig in
	 * its bind pose for up to a turn, which every player would see as a different bug.
	 *
	 * **A change to a clip already playing writes nothing.** This is called on every attribute change —
	 * four attributes, so up to four times for one logical transition, and the speed changes on its own
	 * as a rig starts and stops walking — so the guard is what keeps a walk↔run swap from restarting the
	 * walk track three times.
	 */
	private apply(model: Model, rig: Rig): void {
		const humanoid = rig.humanoid;
		if (!humanoid || !rig.animator) return;

		const speed = this.numberOf(model, NPC_ANIM_SPEED_ATTRIBUTE);
		const grounded = this.flagOf(model, NPC_ANIM_GROUNDED_ATTRIBUTE, true);
		const frozen = this.flagOf(model, NPC_ANIM_FROZEN_ATTRIBUTE, false);
		const throwing = this.flagOf(model, NPC_ANIM_THROWING_ATTRIBUTE, false);

		// "No clip" is a real answer from the mapping — a held rig has no clip of its own — and it is
		// turned into the resting clip here rather than inside it, because the *player* answers the same
		// answer by deferring to the engine's script and a rig has none to defer to. See RESTING_CLIP.
		const clip = animationFor(speed, grounded, frozen, throwing) ?? RESTING_CLIP;
		if (clip === rig.playing) return;

		if (rig.playing !== undefined) rig.tracks.get(rig.playing)?.Stop(FADE_SECONDS);

		// **Recorded before the track is looked for, on purpose.** A clip this rig type has no id for —
		// an R6 rig and the standing or jumping clip, which the config leaves blank — is not a clip that
		// can be loaded, and remembering the attempt is what stops every attribute change from trying
		// again for a clip that will never exist.
		rig.playing = clip;

		this.trackFor(rig, clip)?.Play(FADE_SECONDS);
	}

	/**
	 * The track for `clip` on this rig, loading it the first time it is asked for.
	 *
	 * **One track per clip per rig, cached in the row.** A track belongs to one `Animator` — it is the
	 * loaded instance of an animation *on that body* — so it cannot be shared between rigs even though
	 * the `Animation` it was loaded from could be; what the cache buys is that a rig which walks, stops
	 * and walks again loads its walking clip once for as long as it is on screen. `LoadAnimation` is
	 * the expensive half of this file, and this is the only place it is called.
	 *
	 * `GetTrackByAnimationId` exists and could answer for the cache, but it is typed as returning a
	 * track where its own documentation says it returns nil when nothing has been loaded — so the row
	 * holds what this file loaded, and a nil is a fact it already knows.
	 *
	 * **A blank id is a legitimate answer and the off switch.** The config holds no id for the R6
	 * standing and jumping clips — only the R15 renders of those were uploaded — so an R6 rig has
	 * nothing to play when it stands. That is a gap in the clips rather than a fault in this file, and
	 * it is the one case where a rig is left in its rest pose; it is reported rather than worked around
	 * with a clip that would be wrong.
	 */
	private trackFor(rig: Rig, clip: AnimationClip): AnimationTrack | undefined {
		const cached = rig.tracks.get(clip);
		if (cached !== undefined) return cached;

		const animator = rig.animator;
		if (!animator) return undefined;

		const id = clipFor(clip, rig.humanoid?.RigType === Enum.HumanoidRigType.R15);
		if (id === "") {
			if (DEBUG) print(`[Rig] ${clip}: no id for this rig — left as it stands`);
			return undefined;
		}

		const track = this.load(id, animator);
		if (track === undefined) return undefined;

		rig.tracks.set(clip, track);

		return track;
	}

	/**
	 * Loads one clip onto one animator, or reports that it would not load.
	 *
	 * **Looped, and set explicitly rather than relied on.** The flag belongs to the *track* —
	 * `AnimationTrack.Looped`, not a property of the `Animation` asset instance it was loaded from —
	 * and the API text says what setting it does without saying what it already is. A locomotion clip
	 * that repeats is the entire expectation here, and one that plays a single cycle and stops is legs
	 * that freeze while the body keeps walking, so the flag is written rather than assumed.
	 *
	 * **`Movement` priority, which is the rung locomotion belongs on**, for that file's reason: it
	 * leaves a dodge's `Action` flourish drawing over the legs, and it is not `Core`, where an avatar
	 * pack's own animations would bury them.
	 *
	 * Raises nothing. A load is a guess about an asset — an id that is not an animation, one this place
	 * does not own, one that has been moderated — and a guess must never take a client's boot down with
	 * it; `DodgeService` and `LocomotionAnimationController` both wrap their own loads in `pcall` for
	 * this reason and in these words. A rig that cannot load one clip simply keeps the clip it has.
	 */
	private load(id: string, animator: Animator): AnimationTrack | undefined {
		let track: AnimationTrack | undefined;

		const [ok] = pcall(() => {
			const animation = new Instance("Animation");
			animation.AnimationId = id;

			// Left unparented, like the engine's own script's temporary clips: a track holds the
			// animation it was loaded from, so the instance has no other life to live.
			track = animator.LoadAnimation(animation);
		});

		if (!ok || track === undefined) {
			warn(`[Rig] clip ${id} would not load — the rig keeps what it was wearing`);
			return undefined;
		}

		track.Looped = true;
		track.Priority = Enum.AnimationPriority.Movement;

		return track;
	}

	/** Stops dressing `model`: everything it was given goes with the row. */
	private forget(model: Model): void {
		const rig = this.rigs.get(model);
		if (!rig) return;

		this.rigs.delete(model);

		for (const connection of rig.connections) connection.Disconnect();
		rig.connections = [];

		// **Destroyed rather than stopped, and guarded.** The row is dropped when the rig is on its way
		// out — a death, a respawn, a model being destroyed — so the animator the tracks were loaded on
		// may already be gone, and destroying a track whose animator has gone raises. A death is not an
		// exceptional event here, which is why `DodgeService` guards its own teardown the same way, and
		// a failed teardown must not be what stops the *next* rig from being dressed.
		pcall(() => {
			for (const [, track] of rig.tracks) track.Destroy();
		});

		rig.tracks.clear();
		rig.playing = undefined;
	}

	/** A number attribute, or `0` where it is absent or is not a number. See `apply` for the default. */
	private numberOf(model: Model, name: string): number {
		const value = model.GetAttribute(name);

		return typeIs(value, "number") ? value : 0;
	}

	/** A boolean attribute, or `fallback` where it is absent or is not a boolean. */
	private flagOf(model: Model, name: string, fallback: boolean): boolean {
		const value = model.GetAttribute(name);

		return typeIs(value, "boolean") ? value : fallback;
	}
}
