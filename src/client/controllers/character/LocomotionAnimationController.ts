import { Controller, OnStart } from "@flamework/core";
import { Players } from "@rbxts/services";
import { CHARACTER_CONFIG } from "shared/config/character.config";

/** Prints the write once per body, and each body that was left alone and why. */
const DEBUG = true;

/** The name of the script that animates every character, and the one this controller edits. */
const ANIMATE_NAME = "Animate";

/**
 * How long to wait for a body's `Animate` script, in seconds.
 *
 * **A timeout rather than forever, because the thing being waited for is optional.** A body that
 * never produces an `Animate` script is a body with default locomotion, which is exactly what it
 * would have had without this controller — so the wait has to end in a line of output rather than
 * in a thread that never finishes. Ten seconds is generous for a script that ships *inside* the
 * character being spawned.
 */
const ANIMATE_TIMEOUT_SECONDS = 10;

/**
 * What each clip in a claimed set is called.
 *
 * **The name is the documented convention and it is kept rather than simplified.** Roblox's
 * animation script reads a set's clips by class — anything `IsA("Animation")` under the set is a
 * candidate — but every copy of that script has carried a comment naming its entries `Animation1`
 * upward, and a set that follows the convention is one that keeps working if the reading ever
 * tightens to the convention instead of the class.
 */
const CONFIG_ANIMATION_NAME = "Animation1";

/**
 * How long a clip is given to load before it counts as one this body cannot play, in seconds.
 *
 * See {@link LocomotionAnimationController.loads}: the probe is what stands between a mistyped id and
 * a character that moves with no animation at all, so it has to end in an answer rather than in a
 * wait. Long enough for a clip that is going to arrive, short enough that a body is not left wearing
 * the default walk for a visible while when it is not.
 */
const LOAD_TIMEOUT_SECONDS = 5;

/**
 * What the weight of a claimed clip is called.
 *
 * **Written even though a missing weight is read as 1.** What the script sums to pick a clip out of
 * a set is the entries' weights, and a sum of zero is a set that plays nothing — or, in a copy of
 * the script that reads the value instead of checking for it first, an error thrown while the set is
 * being built, which leaves the set half-built and silent. One clip at weight 1 is the only entry,
 * so the roll over it has exactly one answer and cannot be a division by nothing.
 */
const CONFIG_WEIGHT_NAME = "Weight";

/**
 * The animation sets this controller claims, and the ids it claims them with.
 *
 * **A list rather than four blocks of code, because they differ only in which ids they carry.** The
 * names are not this codebase's choosing: `idle`, `walk`, `run` and `jump` are the names the
 * animation script looks its own sets up by, and they are the whole of the interface between it and
 * this file. See {@link CHARACTER_CONFIG.IDLE_ANIMATION_R6} for the ids themselves and for what a
 * blank one means.
 *
 * **`run` is the sprint.** Roblox's name for the set is `run`; the game's name for the thing it
 * plays is the sprint, spelled {@link CHARACTER_CONFIG.RUN_ANIMATION_R6}. They are the same
 * decision, and the set keeps Roblox's name here because that is the string that has to match.
 *
 * **Four sets claimed together, and that is the answer to "which one plays when".** Roblox's script
 * decides that for itself — it hands one set to a body standing still, one to a body moving slowly,
 * one to a body moving quickly and one to a body off the ground, and the thresholds between them
 * are its business — so each set is claimed with this game's clip for the rig in use, and whichever
 * branch the script takes is one of ours. Nothing here reproduces that decision, and nothing here
 * would need rewriting if it moved.
 *
 * **Fall, swim and climb are not claimed, and the reason is the plain one.** No clips were supplied
 * for them, and an id is the only thing that can claim a set — see
 * {@link CHARACTER_CONFIG.IDLE_ANIMATION_R6}. The one worth watching is `fall`, because a body that
 * has just jumped is falling a moment later: it lands on Roblox's falling clip until one is
 * supplied, and that is a visible seam rather than a theoretical one.
 */
const ANIMATED_SETS: Array<{ name: string; r6: string; r15: string }> = [
	{ name: "idle", r6: CHARACTER_CONFIG.IDLE_ANIMATION_R6, r15: CHARACTER_CONFIG.IDLE_ANIMATION_R15 },
	{ name: "walk", r6: CHARACTER_CONFIG.WALK_ANIMATION_R6, r15: CHARACTER_CONFIG.WALK_ANIMATION_R15 },
	{ name: "run", r6: CHARACTER_CONFIG.RUN_ANIMATION_R6, r15: CHARACTER_CONFIG.RUN_ANIMATION_R15 },
	{ name: "jump", r6: CHARACTER_CONFIG.JUMP_ANIMATION_R6, r15: CHARACTER_CONFIG.JUMP_ANIMATION_R15 },
];

/** The set name of the clip a body wears at this game's walk speed. See {@link ANIMATED_SETS}. */
const WALK_SET = "walk";

/** The set name of the clip a body wears while sprinting. See {@link WALK_SET}. */
const RUN_SET = "run";

/**
 * How often the moving clip is re-chosen, in seconds.
 *
 * **A poll rather than an event, and twenty times a second.** The two things being watched — the
 * body's state and the speed it is travelling at — change for reasons that do not announce
 * themselves to this file: a sprint ends when the pool empties, a jump interrupts a run, a dodge
 * finishes. Fifty milliseconds is short enough that none of those reads as late, and the work is a
 * state read, a comparison and (almost always) nothing else.
 */
const MOVEMENT_TICK_SECONDS = 0.05;

/**
 * How long the change from one moving clip to the other takes, in seconds.
 *
 * Crossfaded rather than switched, because this is the one seam a player is watching: they press the
 * sprint and look at the legs. Longer than the engine's own transition between its two sets, because
 * the two clips here were authored separately rather than as a pair.
 */
const MOVEMENT_FADE_SECONDS = 0.2;

/**
 * The speed at or below which a body counts as standing still, in studs per second.
 *
 * **The engine's own figure rather than a second opinion about it.** It is the number Roblox's
 * animation script draws this line at — `speed > 0.01` in its `onRunning` — and this file is making
 * the same decision from the same measurement, so it draws it in the same place.
 */
const STANDING_SPEED = 0.01;

/**
 * One body's moving playback: the two clips, and which of them is playing.
 *
 * **State rather than locals, because the loop outlives the call that starts it.** It has to
 * remember what it chose last time to know whether anything has changed at all, and it has to hold
 * the tracks so that one it fades out is one it can fade back in.
 */
interface Moving {
	humanoid: Humanoid;
	animator: Animator;

	/** The clip for this game's base walk speed. */
	walk: AnimationTrack;

	/**
	 * The id {@link Moving.walk} was loaded from.
	 *
	 * **Kept rather than read back off the track.** A track can be asked what it is holding —
	 * `AnimationTrack.Animation` — but the typings allow that to be nil, and a track whose animation
	 * cannot be read is one this file could not recognise as its own. The id it was loaded from is
	 * something this file already knows.
	 */
	walkId: string;

	/** The clip for this game's sprint. */
	run: AnimationTrack;

	/** The id {@link Moving.run} was loaded from. See {@link Moving.walkId}. */
	runId: string;

	/**
	 * The speed the humanoid last reported from its own `Running` event.
	 *
	 * **The measured speed, and it is a different question from the configured one.** This is what
	 * the engine's script animates from — how fast the body is *actually* going — and it is what
	 * tells a body walking into a wall from a body standing still.
	 */
	speed: number;

	/** Which of the two is playing, or `none` while standing still or off the ground. */
	playing: "walk" | "run" | "none";
}

/**
 * The id this game has for the `name` set on a body of this rig, or `""` where it has none.
 *
 * Read back out of {@link ANIMATED_SETS} rather than repeated, and that is the point of the function:
 * the two places that need a clip — the container handed to the animation script, and the track this
 * file plays itself — must be holding the *same* clip. Two lists of ids would be two answers to
 * "which animation is the walk", and the bug that comes out of that is a body that walks one way
 * under the script and another way under this file, depending on which of them got there first.
 */
function clipFor(name: string, isR15: boolean): string {
	for (const set of ANIMATED_SETS) {
		if (set.name === name) {
			return isR15 ? set.r15 : set.r6;
		}
	}

	return "";
}

/**
 * Puts this game's character clips on the local player's body.
 *
 * **It edits Roblox's animation script rather than replacing it, and that is the whole design.**
 * `Animate` builds each of its sets from a child instance named after the set — `idle`, `walk`,
 * `run`, `jump`, and the rest — and falls back to the ids compiled into itself only when that child
 * is missing. So the supported way to change one of its animations without taking the script apart
 * is to *hand it the child it is already looking for*: a container named `walk` holding the clip.
 * Everything the set list does not name — the emotes, the tool animations, fall and climb, and the
 * way any of them blend — stays exactly as Roblox shipped it, and there is no copy of that script
 * anywhere in this repository to re-diff when Roblox changes it, which is the cost a fork would have
 * charged forever.
 *
 * **A set is claimed by being rebuilt, not by being edited.** The container is removed and ours put
 * in its place, which is two writes the script can see — it watches its own children — and neither
 * of them depends on it watching an `AnimationId` for changes. The body's own set goes with it: a
 * set holding this game's clip *and* Roblox's would be a set the script picks from at random, which
 * is a character that walks our way most steps and Roblox's way some of them.
 *
 * **A set is only claimed once its clip has been shown to load.** The clip is probed on this body's
 * own `Animator` first — loaded, waited on, thrown away — and a clip that never arrives leaves
 * Roblox's set exactly where it was. The ordering is the point rather than politeness: a claimed set
 * *replaces* the script's own, so claiming one with an id the body cannot play is not a clip that
 * looks wrong, it is a character whose legs stop moving at every step. A character wearing Roblox's
 * walk is a much better failure than that, and the id is named in full when it happens.
 *
 * **`RigType` decides which id, and it is read rather than guessed.** The rig decides which clip
 * can load at all — an R6 clip on an R15 rig does not load, and the reverse — so the two ids are
 * not variants of one animation but the two animations, and a body is handed the one it can wear.
 * `DodgeService` picks its flourish the same way, for the same reason; `BallFactory` looks up a
 * hand the same way. See {@link CHARACTER_CONFIG.IDLE_ANIMATION_R6}, where the R6 column is filled
 * in for two of the four sets and blank for the other two.
 *
 * **The choice between the walk and the sprint is this file's, not the script's.** Roblox's script
 * picks between its two moving sets by how fast the body is going, and its threshold does not fall
 * between this game's two speeds: at the base walk speed it was already choosing the same set it
 * chooses while sprinting, so one of the two clips was never seen at all. The moving clip is
 * therefore played here — on the local body, at `Movement` priority, with the script's own attempt
 * stopped — and the decision is made from the body's ground speed against
 * {@link CHARACTER_CONFIG.BASE_WALK_SPEED}, which is the game's own statement of where the sprint
 * begins. The claimed sets stay, and they are load-bearing rather than left over: they are what the
 * script plays in the moment before this file has chosen, and they are how the script's own attempt
 * is recognised when it makes one.
 *
 * **The local player's body, and only that one.** An animation track is started by the client that
 * owns the body and replicated from its `Animator`, which is why the default script animating one
 * character shows the whole server a walking player: every client dresses the one body it owns.
 * The other bodies on screen are already being dressed by their owners, and a second copy written
 * here would be this client quietly disagreeing with them about the same character.
 *
 * **What this is not:** not a replacement for the animation script, not a second animator, and not a
 * claim on any state this game has no clip for. Fall, swim, climb, the emotes and the tool
 * animations are Roblox's, untouched, and a body with no `Animate` script at all is left as it is
 * rather than being given one.
 */
@Controller()
export class LocomotionAnimationController implements OnStart {
	private readonly player = Players.LocalPlayer;

	public onStart(): void {
		// **Both paths into the dressing go through `guard`, and that is the whole reason it exists.**
		// A controller's `onStart` is part of the client's boot: an error raised in it does not merely
		// fail this controller, it stops whichever ones were still to be ignited, and the shape of
		// that failure is a client with no HUD, no input and no aim — everything, because of an
		// animation. An animation is a *visual*, and the one thing a visual must never be able to do
		// is take the rest of the game down with it; `DodgeService` wraps its own animation load for
		// the same reason, in the same words. The failure is reported rather than swallowed, because
		// a silent one would be indistinguishable from the clips simply not being taken.
		this.player.CharacterAdded.Connect((character) => this.guard(character));

		// **The body that is already here, because `CharacterAdded` will never fire for it again.**
		// A controller's `onStart` runs on a client that has usually already spawned, and a handler
		// connected only to the future would leave this session's first life with Roblox's clips and
		// every life after it with ours — the kind of difference that reads as a bug in the clips.
		// `WalkSpeedService`, `SpawnShield` and `CollisionGroups` all cover their already-present
		// players for the same reason.
		const character = this.player.Character;
		if (character) {
			this.guard(character);
		}
	}

	/**
	 * Dresses one body, and refuses to let a failure there reach the client's boot.
	 *
	 * **What this is not:** not a second `pcall` around the probe or around the ids — a clip that
	 * will not load is an expected answer rather than an error and is already handled where it is
	 * found. This is the outer net, around the whole of one body's dressing, and it is here because
	 * the cost of being wrong about the inner ones is not a missing animation but a client that
	 * never finishes starting. The `yield`s inside `dress` are not a hole in it: Luau keeps the
	 * `pcall` boundary across a resume, so an error raised after a wait is still caught here.
	 */
	private guard(character: Model): void {
		const [ok, err] = pcall(() => this.dress(character));

		if (!ok) {
			warn(`[Animate] ${character.Name}: dressing failed — ${err}`);
		}
	}

	/**
	 * Hands one body's animation script this game's moving clips.
	 *
	 * Yields on both waits, which is why the caller connects and forgets: a character arrives
	 * without all of its children, and each handler runs on its own thread, so nothing else is held
	 * up while one body's script turns up.
	 */
	private dress(character: Model): void {
		const humanoid = character.WaitForChild("Humanoid") as Humanoid;

		// With a timeout, and a miss is reported rather than thrown: see ANIMATE_TIMEOUT_SECONDS.
		const animate = character.WaitForChild(ANIMATE_NAME, ANIMATE_TIMEOUT_SECONDS);
		if (!animate) {
			if (DEBUG) print(`[Animate] ${character.Name}: no ${ANIMATE_NAME} script — left alone`);
			return;
		}

		// **A body without an `Animator` is a body with nothing to dress.** A player character
		// arrives with one; a bare rig may not. There would be nothing to probe a clip on and
		// nothing for the animation script to play it through, so the body is left as it is rather
		// than half-dressed. `DodgeService` builds one when it is missing instead, because a dodge
		// flourish has no other way to be played at all; here the default animation is already the
		// alternative, so there is nothing to gain by making one.
		const animator = humanoid.FindFirstChildOfClass("Animator");
		if (!animator) {
			if (DEBUG) print(`[Animate] ${character.Name}: no Animator — left alone`);
			return;
		}

		const isR15 = humanoid.RigType === Enum.HumanoidRigType.R15;

		// **The rig is printed, because it is the answer to "which of the eight ids was this body
		// supposed to wear".** Whether a body's clips are the ones configured for it or Roblox's own
		// is decided here and nowhere else, so a body that came out with no custom animation is
		// usually a question about this line rather than about the ids: the wrong column read, or a
		// clip uploaded for the other rig. Named with the body, so a test with two rigs in it can be
		// read off the output instead of remembered.
		if (DEBUG) print(`[Animate] ${character.Name}: ${isR15 ? "R15" : "R6"} body`);

		for (const set of ANIMATED_SETS) {
			this.claimSet(animate, animator, set.name, isR15 ? set.r15 : set.r6);
		}

		// **And then the two moving clips are chosen here rather than left to the script** — see
		// {@link LocomotionAnimationController.startMoving}. Nothing plays until the body actually
		// moves, so this costs two track loads at spawn and nothing else.
		this.startMoving(character, humanoid, animator, isR15);
	}

	/**
	 * Watches a body's speed and plays whichever of this game's two moving clips belongs to it.
	 *
	 * **Both ids or neither, and that is the same rule the blank ids carry.** The pair is one
	 * decision — which of these two clips a moving body wears — and a body with only one of them has
	 * no decision to make, so the script's own choice is left alone. Half of the choice being made
	 * here and half by the script would be a body whose walk depended on which of the two arrived
	 * first.
	 *
	 * The two tracks are loaded here and played by {@link LocomotionAnimationController.follow}. They
	 * are *not* the containers handed to the script: those hold clips the script plays, these are
	 * clips this file plays, and they are the same asset either way — see `clipFor`.
	 */
	private startMoving(character: Model, humanoid: Humanoid, animator: Animator, isR15: boolean): void {
		const walkId = clipFor(WALK_SET, isR15);
		const runId = clipFor(RUN_SET, isR15);

		if (walkId === "" || runId === "") {
			if (DEBUG) print(`[Animate] moving clips: one is unset — the script keeps the choice`);
			return;
		}

		const walk = this.loadMovingClip(walkId, animator);
		const run = this.loadMovingClip(runId, animator);
		if (!walk || !run) return;

		const moving: Moving = { humanoid, animator, walk, walkId, run, runId, speed: 0, playing: "none" };

		// **The engine's own measurement of how fast the body is going, taken from the event its
		// script reads.** `Running` is fired by the humanoid's physics on this client, so it costs
		// nothing and it reports the horizontal speed the body is actually travelling at — which is
		// the question "is this body moving", and not the same question as "what is it allowed to
		// walk at".
		const running = humanoid.Running.Connect((speed) => {
			moving.speed = speed;
		});

		// Spawned, because the loop is the rest of this body's life and `dress` is a handler on the
		// way in. A body that never moves runs this loop idle for as long as it exists, which is the
		// cost of asking the question at all.
		task.spawn(() => this.follow(character, moving, running));
	}

	/**
	 * Re-chooses the moving clip until the body is gone, and stops everything on the way out.
	 *
	 * **Death and despawn are the same exit**, because both end the body: `Health` at zero is a
	 * corpse this file has no opinion about, and a character whose parent is nil has been replaced.
	 * Either way the loop is over, and a track left playing on a body that has died is a corpse
	 * still walking. The `Running` connection goes with it — it is a connection to a humanoid that
	 * will never report again, and one per life would be a session's worth of them by the end.
	 */
	private follow(character: Model, moving: Moving, running: RBXScriptConnection): void {
		// **Reported once and then not again, because a tick that fails fails twenty times a second.**
		// The first failure is the one worth reading; twenty lines a second would bury it and the
		// output with it.
		let reported = false;

		while (character.Parent !== undefined && moving.humanoid.Health > 0) {
			// **Guarded, because a tick can race a body that is on its way out.** The character can
			// be destroyed between the check above and the track this tick touches — a respawn, a
			// death — and an error raised here would end the loop *without* ending the body, which is
			// a body that never walks with an animation again rather than one that stops walking. A
			// failed tick is retried on the next one; only the last one before the body goes matters.
			const [ok, err] = pcall(() => this.step(moving));

			if (!ok && !reported) {
				reported = true;
				warn(`[Animate] moving clip: tick failed — ${err}`);
			}

			task.wait(MOVEMENT_TICK_SECONDS);
		}

		running.Disconnect();
		moving.walk.Destroy();
		moving.run.Destroy();
	}

	/**
	 * Puts the right moving clip on, or does nothing at all while the answer has not changed.
	 *
	 * The guard is what makes a twenty-times-a-second poll affordable: the body spends almost all of
	 * its life in one answer, and the work of a tick that agrees with the last one is a state read.
	 */
	private step(moving: Moving): void {
		const wanted = this.wantedClip(moving);

		if (wanted === moving.playing) return;

		// **The script's attempt is stopped before ours starts**, and only for the two clips this
		// file owns — see {@link LocomotionAnimationController.stopScriptsAttempt}. Two tracks for
		// one pair of legs is a body blended between the clip the script chose and the clip this file
		// chose, which is worse than either answer.
		this.stopScriptsAttempt(moving);

		if (moving.playing === "walk") moving.walk.Stop(MOVEMENT_FADE_SECONDS);
		if (moving.playing === "run") moving.run.Stop(MOVEMENT_FADE_SECONDS);

		if (wanted === "walk") moving.walk.Play(MOVEMENT_FADE_SECONDS);
		if (wanted === "run") moving.run.Play(MOVEMENT_FADE_SECONDS);

		moving.playing = wanted;

		// **The choice is printed with the speed it was made at, and those two facts together are
		// the answer to "why is the sprint animation not playing".** A body whose speed never crosses
		// the base line never prints the second line at all, and a body whose two clips hold the same
		// animation prints both lines and looks identical anyway — which no amount of reading the
		// code can tell apart from the outside.
		if (DEBUG) print(`[Animate] moving clip: ${wanted} (speed ${string.format("%.1f", moving.speed)})`);
	}

	/**
	 * Which of the two clips the body should be wearing at this instant.
	 *
	 * **Standing still and leaving the ground are both "neither", and for one reason**: those are the
	 * states the engine's script already has the right answer for — the idle clip while the body is
	 * still, the jump and fall clips while it is in the air — and a walking clip held through them
	 * would be this file overriding decisions it did not come here to make.
	 *
	 * **The two halves of this read two different numbers, deliberately.** Whether the body is moving
	 * is the *measured* speed, because that is what the engine's script uses and it is the only figure
	 * that can tell walking into a wall from standing still. Which clip it should be wearing is the
	 * *configured* speed — {@link CHARACTER_CONFIG.BASE_WALK_SPEED}, the number every character is set
	 * to and the number the sprint adds to — because a measured speed dips when a sprint turns a
	 * corner, and a threshold read off it would flap between the two clips every time it did.
	 *
	 * **What this cannot see** is a surface that slows a body down while it sprints: the sprint's
	 * contribution is *added* to a reduced base, so the total can land under the line and read as a
	 * walk. Left as it is rather than corrected, because correcting it means a second copy of the
	 * sprint's arithmetic on the client, and the cost when it happens is the walk clip at a sprint —
	 * a cosmetic miss rather than a broken move.
	 */
	private wantedClip(moving: Moving): "walk" | "run" | "none" {
		if (moving.humanoid.GetState() !== Enum.HumanoidStateType.Running) return "none";
		if (moving.speed <= STANDING_SPEED) return "none";

		return moving.humanoid.WalkSpeed > CHARACTER_CONFIG.BASE_WALK_SPEED ? "run" : "walk";
	}

	/**
	 * Stops the animation script's own track for the two clips this file is responsible for.
	 *
	 * **Identified by what the track is playing, not by who started it.** A track cannot be asked who
	 * created it, but it can be asked which animation it is holding — `AnimationTrack.Animation` —
	 * and the two ids this file owns are the same ids the script's attempts are made of, because the
	 * containers this file handed it hold those clips. So the filter is "a track wearing one of our
	 * animations that is not one of our tracks", and every other animation on the body is left
	 * untouched: a dodge flourish and an emote are different ids, and stopping either would be this
	 * file eating somebody else's animation.
	 *
	 * Called only on the way into a clip this file is about to play, so a body it has no opinion
	 * about is a body it does not touch.
	 */
	private stopScriptsAttempt(moving: Moving): void {
		const ours = [moving.walkId, moving.runId];

		for (const track of moving.animator.GetPlayingAnimationTracks()) {
			if (track === moving.walk || track === moving.run) continue;

			const animation = track.Animation;
			if (animation !== undefined && ours.includes(animation.AnimationId)) {
				track.Stop();
			}
		}
	}

	/**
	 * The track this file plays itself, loaded and left stopped.
	 *
	 * **`Movement` priority, which is the priority locomotion belongs to.** `DodgeService` plays its
	 * flourish at `Action` so that it draws over whatever the legs are doing — that is what the
	 * flourish is for — and a moving clip played at `Action` here would bury exactly that. Played at
	 * `Core` instead it would be buried by whatever the avatar's own animation pack was authored as.
	 * `Movement` is the one rung that leaves both the dodge and the avatar where they were.
	 *
	 * Raises nothing. The id has already been proved on this body by the probe that claimed the set —
	 * this is the same id on the same animator — but a load that fails anyway is reported and leaves
	 * the choice to the script, because the one thing this must never do is take a body's legs away.
	 */
	private loadMovingClip(animationId: string, animator: Animator): AnimationTrack | undefined {
		let track: AnimationTrack | undefined;

		const [ok] = pcall(() => {
			const animation = new Instance("Animation");
			animation.Name = CONFIG_ANIMATION_NAME;
			animation.AnimationId = animationId;

			// Left unparented on purpose: a track holds the animation it was loaded from, which is
			// the same arrangement the engine's own script keeps its temporary clips in.
			track = animator.LoadAnimation(animation);
		});

		if (!ok || track === undefined) {
			warn(`[Animate] moving clip: ${animationId} would not load — the script keeps the choice`);
			return undefined;
		}

		track.Priority = Enum.AnimationPriority.Movement;

		return track;
	}

	/**
	 * Makes `animationId` the only clip in `animate`'s `name` set — if this body can play it.
	 *
	 * A body the script has already read a set for is not a problem: the removal and the addition
	 * below are both children arriving and leaving, and the script rebuilds the set when either
	 * happens. At spawn it has usually not run yet at all, and then it reads ours as its own start.
	 */
	private claimSet(animate: Instance, animator: Animator, name: string, animationId: string): void {
		// The empty id is the *off* switch, and a legitimate one: it is what the config holds
		// between taking a placeholder out and putting a bought clip in. Claimed sets are left as
		// Roblox made them while an id is empty, because the alternative — a set with no clips in it
		// — is a character whose legs stop moving rather than one wearing the default animation.
		if (animationId === "") {
			if (DEBUG) print(`[Animate] ${name}: no id set — left as Roblox's`);
			return;
		}

		// Built and filled before anything is claimed, so that the instance the probe proves is the
		// very instance that goes into the set. A set is a container holding `Animation` objects,
		// and the `Weight` below is what the script rolls over to pick one — see CONFIG_WEIGHT_NAME.
		const animation = new Instance("Animation");
		animation.Name = CONFIG_ANIMATION_NAME;
		animation.AnimationId = animationId;

		const weight = new Instance("NumberValue");
		weight.Name = CONFIG_WEIGHT_NAME;
		weight.Value = 1;
		weight.Parent = animation;

		if (!this.loads(animation, animator)) {
			animation.Destroy();

			// **Loud, and the id in full.** A clip this body cannot play is a fact about the id
			// rather than about the body, and none of the usual causes — an id that is not an
			// animation at all, an animation this place does not own, a rig the clip was not
			// authored for — is visible from inside the game. This line is the only place the id is
			// said out loud, and it is `warn` rather than a debug print because it is a mistake
			// rather than a note, and it is on regardless of what DEBUG is set to.
			warn(`[Animate] ${name}: ${animationId} did not load — Roblox's set left in place`);
			return;
		}

		this.clearSet(animate, name);

		const config = new Instance("Folder");
		config.Name = name;

		// Attached to its container before the container is attached to the script, because a clip
		// is only a clip once its `AnimationId` is set and the container is only worth reading once
		// it holds one.
		animation.Parent = config;

		// **Parented last, and this line is the write.** The script watches its own children for a
		// set arriving; it is what turns this container from an instance nobody has looked at into
		// the set that plays. Anything built here and never parented would be a silently wasted
		// tree.
		config.Parent = animate;

		if (DEBUG) print(`[Animate] ${name} -> ${animationId}`);
	}

	/**
	 * Whether `animator` can actually play `animation`.
	 *
	 * **Asked by loading it, because that is the only way to ask.** An id the client cannot resolve
	 * is not an error to set up — `LoadAnimation` either raises or hands back a track that stays
	 * empty — and an empty track is a set that plays nothing, silently, for the rest of the round.
	 * So the track is loaded, waited on until it reports a length, and thrown away. The clip that
	 * passed is the same instance that goes into the set, by then already loaded.
	 *
	 * **The wait is bounded**, see {@link LOAD_TIMEOUT_SECONDS}, and a track that never reports a
	 * length is a clip that never arrived.
	 */
	private loads(animation: Animation, animator: Animator): boolean {
		let track: AnimationTrack | undefined;

		// `pcall`, for the reason `DodgeService` wraps its own load: this is a guess about an asset
		// — an id that is not an animation, one this place does not own, one that has been
		// moderated — and a guess must never be able to take the caller down with it.
		const [ok] = pcall(() => {
			track = animator.LoadAnimation(animation);
		});
		if (!ok || track === undefined) return false;

		const deadline = os.clock() + LOAD_TIMEOUT_SECONDS;
		while (track.Length <= 0 && os.clock() < deadline) {
			task.wait(0.1);
		}

		const loaded = track.Length > 0;

		// Thrown away rather than played: what the probe is for is the length it reported, and a
		// track left on the animator would be a second animation for the script to fight with.
		track.Destroy();

		return loaded;
	}

	/**
	 * Takes every existing `name` set off `animate`, so that the one put back is the only one.
	 *
	 * **By name, and every match, not the first.** Two children can carry one name — nothing stops
	 * them and this file would be the second — and the script's own lookup returns one of them
	 * without saying which. Leaving Roblox's set beside ours would then be a body that plays this
	 * game's clip or the default one depending on an order nobody chose, and it would look like the
	 * clips working intermittently rather than like two sets existing.
	 */
	private clearSet(animate: Instance, name: string): void {
		for (const child of animate.GetChildren()) {
			if (child.Name === name) {
				child.Destroy();
			}
		}
	}
}
