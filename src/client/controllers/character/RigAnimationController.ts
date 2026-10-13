import { Controller, OnStart } from "@flamework/core";
import { CollectionService, Workspace } from "@rbxts/services";
import { animationFor, rigClipFor } from "shared/animation";
import { LOCOMOTION_CLIPS, RigAnimationClip } from "shared/config/rigAnimation.config";
import {
	DODGE_DIRECTION_ATTRIBUTE,
	NPC_ANIM_FROZEN_ATTRIBUTE,
	NPC_ANIM_GROUNDED_ATTRIBUTE,
	NPC_ANIM_SPEED_ATTRIBUTE,
	NPC_ANIM_THROWING_ATTRIBUTE,
	NPC_TAG,
	THROW_ANIMATION_ATTRIBUTE,
} from "shared/constants";
import { DodgeDirection } from "shared/dodge";

/** Prints each rig as it starts being dressed, and any rig that cannot be. */
const DEBUG = true;

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
 * How long the change from one clip to the next takes, in seconds.
 *
 * **Crossfaded rather than switched.** A rig's clips were authored separately from one another — walk
 * and sprint in particular — so a hard cut between them reads as a pop rather than as a change of
 * pace. The same figure `LocomotionAnimationController` fades its own two moving clips with, because
 * it is the same pair of clips being swapped.
 *
 * **This is the fade for a *cycle*, and {@link fadeFor} is the whole of who uses it.** An action does not
 * crossfade: see that function, where the arithmetic that makes a 0.2 s fade into a 0.2 s dash is written
 * out.
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
 *
 * **Both rigs have an id for it now, and that is a change worth recording.** The standing clip used to
 * come from the player's config, where the R6 half is deliberately blank — only the R15 render of it
 * was ever uploaded — so an R6 rig read as "a clip this rig type has no id for" and stood in its bind
 * pose for its whole life. `rigAnimation.config.ts` carries both, which is what this file reads now.
 */
const RESTING_CLIP: RigAnimationClip = "idle";

/**
 * The clip a rig wears while it has a ball in hand.
 *
 * **The one state the shared decision has no name for, so the translation is here and it is deliberate.**
 * `animationFor` answers `idle` for a body whose arms are busy — see its own argument, which is that a
 * rig holding a ball is standing still as far as its legs are concerned — and that answer is correct for
 * the *player*, who never passes that flag at all because a player carrying a ball is usually running.
 * It is also the answer a rig used to be dressed with. What the rig has that the player does not is a
 * pose for it: the config carries `holdBallIdle`, the server already publishes the flag that means it
 * (`NPC_ANIM_THROWING_ATTRIBUTE`), and so the standing-while-armed case is renamed here rather than
 * being a fifth branch inside a function shared with a body that has no such clip.
 *
 * **A rename and not a second decision.** The condition is the one `animationFor` used to reach `idle`
 * by, read from the same flag, so a rig's legs are still standing for exactly the reason they were —
 * only the clip that plays has changed. Putting `holdBallIdle` in the shared vocabulary instead would
 * have meant a name the player's own controller has no clip for and a return type it would have to
 * become aware of; see `rigAnimation.config.ts`.
 */
const HOLDING_CLIP: RigAnimationClip = "holdBallIdle";

/**
 * The clip a rig wears for the throw itself — **a whole-body motion, played once, at the moment the ball
 * leaves the hand**.
 *
 * **The other half of the pair `HOLDING_CLIP` is one of, and the more important half.** A rig's loop is
 * carry, aim, throw; the hold pose covers the first two and this covers the third, and without it a rig
 * threw its ball out of a standing pose — the one thing in a rig's life that most wants an animation was
 * the one thing with none. The state is an *event* rather than a condition (`THROW_ANIMATION_ATTRIBUTE`,
 * written by `BallService` at the release and cleared a moment later), which is exactly what a one-shot
 * clip needs: it starts when the attribute appears and is left when it goes.
 *
 * **Named rather than inlined so the two state names read side by side**, because "throwing" and "mid
 * throw" are one letter apart everywhere else in this codebase and the difference between them is the
 * difference between carrying a ball and having just thrown one.
 */
const THROW_CLIP: RigAnimationClip = "throw";

/**
 * Which clip each of the four dodge directions is, spelled once.
 *
 * **A dispatch rather than arithmetic**, because the config's names for these four are its own business:
 * a state added later could be named anything, and the mapping between the published direction and the
 * clip it means is exactly the kind of small table a reader should be able to check at a glance. Note
 * that the table is keyed by `DodgeDirection` — the published vocabulary — so a fifth direction is a
 * compile error here rather than a dodge that silently plays nothing.
 */
const DODGE_CLIPS: Record<DodgeDirection, RigAnimationClip> = {
	forward: "forwardDodge",
	backward: "backwardDodge",
	left: "leftDodge",
	right: "rightDodge",
};

/**
 * The four words the direction is published as, spelled once so an attribute value can be checked against
 * them without a cast.
 *
 * **A loop rather than an index into {@link DODGE_CLIPS} with `as`**, which would be the one-liner and
 * would accept anything: the point of validating a value off an attribute is that the four words are a
 * closed set, and a cast is a promise that whatever arrived is one of them. This is also the list the
 * mapping above is complete for — a fifth direction is a compile error there, and would have to be added
 * here to be readable.
 */
const DIRECTIONS: ReadonlyArray<DodgeDirection> = ["forward", "backward", "left", "right"];

/**
 * The dodge direction published on this body, or `undefined` for "no dash in flight".
 *
 * **Read off the attribute and validated rather than trusted**, the convention `PICKUP_LOCKED_UNTIL` sets
 * and the rest of this file keeps: an attribute is a value anything can write, so a value that is not one
 * of the four words means something else wrote it and this machine has no clip for it. Absent is the
 * ordinary answer — a body that is not dashing — and it is the same answer as an unrecognised one, which
 * is the safe direction to be wrong in: the rig falls back to its locomotion clip rather than to a clip
 * nothing published.
 *
 * **The direction rather than the clip, which is what lets the caller print the word it read.** The
 * mapping from a direction to one of the four clips is `DODGE_CLIPS`, one line from the call site, and
 * keeping this function's answer in the server's vocabulary means the log names the thing the server
 * published rather than this file's name for the clip that follows from it.
 */
function publishedDodgeDirection(model: Model): DodgeDirection | undefined {
	const value = model.GetAttribute(DODGE_DIRECTION_ATTRIBUTE);
	if (!typeIs(value, "string")) return undefined;

	for (const direction of DIRECTIONS) {
		if (direction === value) return direction;
	}

	return undefined;
}

/**
 * Whether `clip` is a cycle a rig stays in, **which decides both of the flags a track is loaded with**
 * — see {@link RigAnimationController.load}, where the two are set together because they are two
 * readings of one question: a clip that repeats is a locomotion clip, and the rung it plays on is the
 * locomotion rung.
 */
function isLocomotion(clip: RigAnimationClip): boolean {
	return LOCOMOTION_CLIPS.includes(clip);
}

/**
 * How long `clip` takes to fade in or out, in seconds — **zero for anything that is not a cycle.**
 *
 * **A one-shot has to start at full weight or it is not seen at all, and the dash's own length is the
 * arithmetic.** A dodge lasts `DODGE_CONFIG.DURATION` — a fifth of a second — and this file's fade is the
 * same fifth, so a crossfaded dodge would reach full weight on the frame the dash ended and then fade
 * straight back out: the rig would blend half-way into a pose and leave it, which reads as *no animation*
 * rather than as a short one. That is the failure this whole path exists to fix, so the action clips are
 * switched rather than crossfaded, and the locomotion pair keeps the fade it needs to stop the walk↔run
 * swap popping.
 *
 * **Nothing is lost by the hard cut on the way in**, because a dodge plays at `Action` and the legs it
 * draws over are at `Movement`: the dodge takes the limbs the instant it starts, which is what an action
 * is for. The way *out* is the same instant for the same reason, and the clip that follows it — the walk
 * or the stand — fades in on its own normal curve, so the body comes back from the dodge smoothly. Only
 * the action's own ends are hard, and both of them are hidden behind the clip that takes over.
 */
function fadeFor(clip: RigAnimationClip): number {
	return isLocomotion(clip) ? FADE_SECONDS : 0;
}

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
	tracks: Map<RigAnimationClip, AnimationTrack>;

	/** The clip playing right now, so a state change that names the same clip writes nothing. */
	playing?: RigAnimationClip;

	/** What has to be disconnected when the rig goes: its two instances signals. */
	connections: RBXScriptConnection[];
}

/**
 * Plays a rig's animations, on the clients that can see it.
 *
 * **The third of three parts, and it owns the *rendering* of them.** The server owns the state —
 * `NpcService` computes what a rig is doing, because it is the only machine that can, and publishes it
 * as four attributes on the rig (`DodgeService` publishes a fifth while a dash is in flight).
 * `shared/animation.ts` owns the *decision* — state in, clip name out, pure, so that this file and the
 * player's own controller cannot disagree about what walking is. This file owns what is left: finding
 * the rigs, loading each clip once on each rig, playing the right one when the state says so, and
 * stopping when the rig is gone. **What a clip *is* — its id, per rig type — is
 * `rigAnimation.config.ts`'s**, read through `rigClipFor`, which is the one place the rig type becomes a
 * column of that table.
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
	 * **Both waits are for things made on the other machine, and both are on a timeout.** The server
	 * creates the rig's `Animator` (`NpcService.ensureAnimator`) so that every client loads onto the
	 * *same* replicated instance — a client-made animator would be a rig animated through an object no
	 * other client can see. The two facts arrive in the same replication step in practice, but nothing
	 * promises it, and a rig watched one frame too early used to be a rig that never animated at all.
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
	 * **The whole of this file's decision-making is one call to `wantedClip`.** The four attributes are the
	 * four things the shared mapping branches on — see `shared/constants.ts` for why that set is exactly
	 * four — and each is read as the type it should be rather than trusted, which is the convention
	 * `PICKUP_LOCKED_UNTIL` sets: an attribute of another type means something else wrote it, and a value
	 * that is not a number is not a speed.
	 *
	 * **A rig whose animator had not replicated is looked at again here, rather than once at the start and
	 * never again.** The wait in {@link watch} ends — it has to, the object it waits for is made on the
	 * other machine — and the first version of this gave up for the whole life of the rig when it did: one
	 * late replication step and a rig stood motionless for ever, with one line in the output and nothing
	 * that would ever try again. This method runs on every attribute change, so asking once more on each
	 * of them costs a child lookup on a body that is already being read and turns the failure into a delay.
	 *
	 * **A change to a clip already playing writes nothing.** This is called on every attribute change —
	 * five attributes now, so up to five times for one logical transition, and the speed changes on its own
	 * as a rig starts and stops walking — so the guard is what keeps a walk↔run swap from restarting the
	 * walk track three times, and it is what makes a dodge's two writes (the direction on, the direction
	 * off) two clip changes rather than a re-issue of the clip already playing.
	 */
	private apply(model: Model, rig: Rig): void {
		const humanoid = rig.humanoid;
		if (!humanoid) return;

		if (rig.animator === undefined) {
			const animator = humanoid.FindFirstChildOfClass("Animator");
			if (animator === undefined) return;

			rig.animator = animator;

			if (DEBUG) print(`[Rig] ${model.Name}: the Animator arrived after the wait — dressing now`);
		}

		// **A dash outranks every locomotion state, so it is read first.** A dashing body is moving fast
		// across the ground, so speed alone would dress it as a sprint — legs running while the body slides
		// — and the four dodge clips exist precisely to be that instead. Reading the direction before the
		// body is looked at means a dash does not have to out-compete the locomotion answer on speed and
		// risk losing on a banding boundary.
		const dodge = publishedDodgeDirection(model);
		const clip = dodge === undefined ? this.wantedClip(model) : DODGE_CLIPS[dodge];

		if (clip === rig.playing) return;

		if (rig.playing !== undefined) rig.tracks.get(rig.playing)?.Stop(fadeFor(rig.playing));

		// **Recorded before the track is looked for, on purpose.** A clip this rig type has no id for —
		// a config row left empty, which is how a state opts out — is not a clip that can be loaded, and
		// remembering the attempt is what stops every attribute change from trying again for a clip that
		// will never exist.
		rig.playing = clip;

		const track = this.trackFor(rig, clip);

		track?.Play(fadeFor(clip));

		// **And the action is named when the rig is actually wearing it**, which is why this is after the
		// track exists rather than beside the choice: a state whose clip will not load is a *different* line
		// (`no id for this rig`, or the load failure), and printing the choice ahead of it would put two
		// lines that seem to contradict each other side by side. **Once per action rather than once per
		// tick** — the guard at the top of this method is what makes that true, since a dash changes its own
		// speed several times inside its fifth of a second. **Locomotion changes are deliberately not
		// printed**: they are the loop, and a line per band change would bury the two that matter. This is
		// the only place a rig's throw or dodge can be confirmed — the server names the direction it
		// published, and whether a client picked it up is a fact only the client has.
		if (DEBUG && track !== undefined && !isLocomotion(clip)) {
			print(`[Rig] ${model.Name}: ${dodge ?? clip} clip`);
		}
	}

	/**
	 * Looks for a rig's `Animator` a few more times, for a body whose published state will not change.
	 *
	 * **Bounded, and it ends the moment the animator arrives.** Every turn asks `apply` — which is the
	 * one place the animator is looked up and the one place the state is read, so a success here needs no
	 * second copy of either — and leaves as soon as the row has an animator, so a rig that answers on the
	 * first turn costs fifteen seconds of nothing rather than three rounds of it. A rig that never
	 * answers is a rig that has already said so in one line, and this is the loop that stops asking.
	 *
	 * **A rig that is forgotten mid-search is dropped, not chased.** A corpse, a respawn or a rig taken
	 * out of the world takes its row out of the table, and the check here is the same one `watch` makes
	 * for the same reason: a row that is not this row is a body somebody else is dressing now.
	 */
	private keepLooking(model: Model, rig: Rig): void {
		for (let attempt = 0; attempt < ANIMATOR_RETRY_ATTEMPTS; attempt++) {
			task.wait(ANIMATOR_TIMEOUT_SECONDS);

			if (this.rigs.get(model) !== rig || rig.animator !== undefined) return;

			this.apply(model, rig);

			if (rig.animator !== undefined) return;
		}
	}

	/**
	 * Which locomotion clip this rig should be wearing right now, from everything published about it.
	 *
	 * **This is the *locomotion* answer, and a dash is deliberately not its business.** The direction of a
	 * dash is read by `apply` before this is called, because the two are not equally ranked: a dash
	 * outranks every state here, so folding it in would make this function answer two different questions.
	 * What is left is the ordinary one — how a body moving on the ground is dressed.
	 *
	 * **"No clip" from the mapping is a real answer and is turned into the resting clip here rather than
	 * inside it.** `animationFor` answers `undefined` for a *frozen* body — a held rig is not walking, not
	 * falling and not standing, so it has no locomotion clip — and a rig cannot answer that the way the
	 * player does, by deferring to a script it does not have. See `RESTING_CLIP`.
	 *
	 * **Absent reads as resting, not as "wait".** A rig whose state has not arrived — one that has just
	 * replicated, or one whose replacement body is a turn away from its first publish — is a body standing
	 * still on the ground, so speed `0` and grounded `true` are the honest defaults and they land on the
	 * standing clip. The alternative, playing nothing until something arrives, is a rig in its bind pose
	 * for up to a turn, which every player would see as a different bug.
	 */
	private wantedClip(model: Model): RigAnimationClip {
		// **A throw in progress outranks every locomotion state, and it is a one-shot rather than a pose.**
		// The mark is written at the release and cleared a moment later, so this branch is entered for the
		// length of the motion and left when it is over — the pair `isLocomotion` and `fadeFor` are what make
		// the clip play as an action rather than as a cycle. Nothing about the body's speed is consulted: a
		// rig that throws while walking throws with the same clip.
		if (this.flagOf(model, THROW_ANIMATION_ATTRIBUTE, false)) return THROW_CLIP;

		const speed = this.numberOf(model, NPC_ANIM_SPEED_ATTRIBUTE);
		const grounded = this.flagOf(model, NPC_ANIM_GROUNDED_ATTRIBUTE, true);
		const frozen = this.flagOf(model, NPC_ANIM_FROZEN_ATTRIBUTE, false);
		const throwing = this.flagOf(model, NPC_ANIM_THROWING_ATTRIBUTE, false);

		const clip = animationFor(speed, grounded, frozen, throwing) ?? RESTING_CLIP;

		// **And the one state the shared decision has no name for**: a body standing still with a ball in
		// hand. `animationFor` reaches `idle` for it — correct for the player, whose arms are never "busy"
		// in that sense — and a rig has a pose of its own for it. See `HOLDING_CLIP`.
		return clip === "idle" && throwing ? HOLDING_CLIP : clip;
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
	 * **The id comes from the rig's own table, not the player's.** `rigClipFor` reads
	 * `rigAnimation.config.ts`, whose R6 column is filled in for every state — which is what closes the
	 * hole this method used to report: an R6 rig standing or jumping had no id to play, because the
	 * player's config leaves those two R6 rows blank, and a rig has no `Animate` script to fall back to.
	 *
	 * **A blank id is still a legitimate answer and the off switch**, and this is where it is honoured:
	 * a caller that reads one leaves the body wearing whatever it has rather than playing a clip that is
	 * presumably wrong. No row of the rig table is blank today.
	 */
	private trackFor(rig: Rig, clip: RigAnimationClip): AnimationTrack | undefined {
		const cached = rig.tracks.get(clip);
		if (cached !== undefined) return cached;

		const animator = rig.animator;
		if (!animator) return undefined;

		const id = rigClipFor(clip, rig.humanoid?.RigType === Enum.HumanoidRigType.R15);
		if (id === "") {
			if (DEBUG) print(`[Rig] ${clip}: no id for this rig — left as it stands`);
			return undefined;
		}

		const track = this.load(id, animator, clip);
		if (track === undefined) return undefined;

		rig.tracks.set(clip, track);

		return track;
	}

	/**
	 * Loads one clip onto one animator, with the two flags that decide how it plays.
	 *
	 * **`Looped` is set from the clip rather than to `true`.** The flag belongs to the *track* —
	 * `AnimationTrack.Looped`, not a property of the `Animation` asset instance it was loaded from —
	 * and the API text says what setting it does without saying what it already is, so it is written
	 * rather than assumed. A locomotion clip that repeats is the entire expectation here, and one that
	 * plays a single cycle and stops is legs that freeze while the body keeps walking; a *dodge* is the
	 * opposite case and is why this is not simply `true`: a dash lasts `DODGE_CONFIG.DURATION`, a clip
	 * authored for it may be longer or shorter, and one that repeats until the state changes is a body
	 * that keeps throwing itself sideways after it has stopped moving.
	 *
	 * **`Movement` for a cycle, `Action` for a one-off, and those are two different rungs for one
	 * reason.** Locomotion belongs on `Movement`: it leaves a dodge's flourish drawing over the legs and
	 * it is not `Core`, where an avatar pack's own animations would bury them. A dodge is *that*
	 * flourish — the thing that draws over the legs — and it is played on this same body by this same
	 * client, so at `Movement` the two would be blended together rather than one drawing over the other.
	 * `Action` is the rung `DodgeService` already plays its own flourish on, from the same reasoning.
	 *
	 * Raises nothing. A load is a guess about an asset — an id that is not an animation, one this place
	 * does not own, one that has been moderated — and a guess must never take a client's boot down with
	 * it; `DodgeService` and `LocomotionAnimationController` both wrap their own loads in `pcall` for
	 * this reason and in these words. A rig that cannot load one clip simply keeps the clip it has.
	 */
	private load(id: string, animator: Animator, clip: RigAnimationClip): AnimationTrack | undefined {
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

		const locomotion = isLocomotion(clip);

		track.Looped = locomotion;
		track.Priority = locomotion ? Enum.AnimationPriority.Movement : Enum.AnimationPriority.Action;

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
