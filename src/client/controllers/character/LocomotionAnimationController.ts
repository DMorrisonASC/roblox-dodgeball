import { Controller, OnStart } from "@flamework/core";
import Fusion from "@rbxts/fusion-3.0";
import { Players } from "@rbxts/services";
import { AnimationClip, clipIdFor } from "shared/animation";
import { BALL_CONFIG } from "shared/config/ball.config";
import { DEBUG_LOGGING, logDebug, logInfo, logWarn } from "shared/logger";
import { BodyRender, applyBodyRender, bodyRenderPlays, destroyBodyRender, startBodyRender } from "../../bodyAnimation";
import { sprinting } from "../../sprinting";
import { chargeStartedAt, releasedCharge } from "../../throwing";

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
 * The clips this controller claims on a body, in the order the engine's script is asked for them.
 *
 * **Names rather than ids, because the ids are `shared/animation.ts`'s now.** These are that file's
 * `AnimationClip` vocabulary — the same four words `animationFor` returns and the same four Roblox's
 * animation script looks its own sets up by — and the id one of them means *on this rig* comes from
 * `clipFor`, which is where the two ids per clip and the rig-type choice both live. Nothing here
 * spells an asset id, and that is the point: this controller hands the script four sets *and* plays
 * two of the clips itself, so the clip a set holds and the clip a track plays must be the same clip,
 * and the only way to be certain of that is for one function to answer for both. See `clipFor`.
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
const ANIMATED_SETS: AnimationClip[] = ["idle", "walk", "run", "jump"];

/**
 * **The humanoid states this game has a clip for — the list that decides when the game defers to Roblox.**
 *
 * **The question is "does the game have a clip for this state", and not "is the character on the floor".** The
 * body's own state is what says whether its legs are doing something this game has a picture of, and floor
 * contact cannot answer it — which is the mistake this list was written to end, and it cost two visible faults.
 * A character *seated* on a bench is welded to it rather than standing on it, so `FloorMaterial` reads `Air`,
 * the body was read as falling, and the jump clip looped at `Movement` over Roblox's own `sit` animation. And a
 * body that has been knocked over (`FallingDown`) rolls with its contact flickering, so the same measurement
 * alternated tick by tick and the legs flipped between idle and jump at the poll rate.
 *
 * **These five are the states the four clips describe**, which is why the list is this and not something else:
 * `Running` and `RunningNoPhysics` are the on-the-ground states in which `idle`/`walk`/`run` are decided (from
 * speed, by `animationFor`), and `Jumping`/`Freefall`/`Landed` are the airborne ones the `jump` clip covers.
 * **Everything else defers** — `Seated`, `FallingDown`, `Climbing`, `Swimming`, `Dead`, `PlatformStanding`,
 * `Physics`, `GettingUp`, `Ragdoll`, `Flying` — because Roblox's `Animate` script has clips for those and this game
 * has none: it owns the four sets in {@link ANIMATED_SETS} and leaves the script's other sets exactly as Roblox
 * wrote them, so deferring is what lets `sit`, `climb` and `swim` be Roblox's own.
 *
 * **This list is the only place the question is answered.** The renderer is handed the answer and never the
 * state's name (see `BodyConditions.deferToDefault`), and an event still outranks it: a body knocked over
 * mid-throw still throws, because the events rank above the deferral in `bodyClipFor`.
 */
const OWNED_STATES: ReadonlyArray<Enum.HumanoidStateType> = [
	Enum.HumanoidStateType.Running,
	Enum.HumanoidStateType.RunningNoPhysics,
	Enum.HumanoidStateType.Jumping,
	Enum.HumanoidStateType.Freefall,
	Enum.HumanoidStateType.Landed,
];

/**
 * How often the body is re-dressed, in seconds.
 *
 * **A poll rather than an event, and twenty times a second.** The things being watched — the body's state, the
 * direction it is being walked in and the sprint key — change for reasons that do not announce themselves to
 * this file: a sprint ends when the pool empties, a jump interrupts a run, a dodge finishes. Fifty milliseconds
 * is short enough that none of those reads as late, and the work is three reads, a comparison and (almost
 * always) nothing else.
 *
 * **The events do not need the poll**, and that is worth knowing when reading a log: a throw, a catch and a
 * dodge are attributes on the body, and the renderer reads them on every call — so a tick that finds one up
 * plays its clip at the next tick, up to fifty milliseconds after the mark was written. That is the cost of
 * one clock for a body whose request cannot be published to it; a rig has no such clock, because every fact it
 * needs arrives as an attribute change instead. See `client/bodyAnimation.ts`.
 */
const MOVEMENT_TICK_SECONDS = 0.05;

/**
 * One body this client owns, and everything needed to keep its animation in step with it.
 *
 * **State rather than locals, because the loop outlives the call that starts it** — it runs for the rest of
 * the body's life. What it holds is the body, the two objects a body is animated through, and the ids this
 * game has claimed from the engine's own script: see {@link LocomotionAnimationController.suppressScript} for
 * why the last of those is needed on every tick.
 */
interface OwnedBody {
	humanoid: Humanoid;
	animator: Animator;

	/** The shared renderer — the same one a rig is dressed by, which is the point of this file's rewrite. */
	body: BodyRender;

	/** The four set ids claimed for this body's rig type. See {@link LocomotionAnimationController.dress}. */
	claimed: string[];

	/**
	 * Whether the last tick deferred to Roblox's own animation script, so the log line is an edge.
	 *
	 * **On the row rather than re-read from the humanoid, because it is the *previous* answer that matters.** The
	 * transition into and out of a deferral is the event worth a line, and the state itself is on the body and is
	 * asked again every tick — a `deferToDefault` recomputed from the body each time cannot tell "still sitting"
	 * from "just sat down", which is the whole of what this field is for. See `step`.
	 */
	deferring: boolean;
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
 * hand the same way. See {@link CHARACTER_CONFIG.IDLE_ANIMATION_R6} for the pair of columns: every
 * row is filled in for both rig types, so which of the two a body wears is the only question left.
 *
 * **The choice between the walk and the sprint is this file's, not the script's.** Roblox's script
 * picks between its two moving sets by how fast the body is going, and its threshold does not fall
 * between this game's two speeds: at the base walk speed it was already choosing the same set it
 * chooses while sprinting, so one of the two clips was never seen at all. The moving clip is
 * therefore played here — on the local body, at `Movement` priority, with the script's own attempt
 * stopped — and the decision is made **by `animationFor` in `shared/animation.ts`**, from the two
 * facts this file is the only one able to gather: **whether the body has been asked to move at all,
 * and whether the sprint key is down.** The measured speed is deliberately not consulted — see that
 * function for the record of why, and for what the measurement cost while it was here. The sprint is
 * the *key* rather than the sprint the server granted, which is the cost that function names and
 * this file accepts; `client/sprinting.ts` is where the key is read, by the two files that need it.
 * `animationFor` being shared rather than written here is the other half of this paragraph: an NPC
 * rig's clips are played by a client renderer with no `Humanoid` of its own, and the two must not
 * answer the same question differently. The claimed sets stay, and they are load-bearing rather than
 * left over: they are what the script plays in the moment before this file has chosen, and they are
 * how the script's own attempt is recognised when it makes one.
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
			logWarn(`[Animate] ${character.Name}: dressing failed — ${err}`);
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
			logDebug(`[Animate] ${character.Name}: no ${ANIMATE_NAME} script — left alone`);
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
			logDebug(`[Animate] ${character.Name}: no Animator — left alone`);
			return;
		}

		const isR15 = humanoid.RigType === Enum.HumanoidRigType.R15;

		// **The rig is printed, because it is the answer to "which of the eight ids was this body
		// supposed to wear".** Whether a body's clips are the ones configured for it or Roblox's own
		// is decided here and nowhere else, so a body that came out with no custom animation is
		// usually a question about this line rather than about the ids: the wrong column read, or a
		// clip uploaded for the other rig. Named with the body, so a test with two rigs in it can be
		// read off the output instead of remembered.
		logDebug(`[Animate] ${character.Name}: ${isR15 ? "R15" : "R6"} body`);

		for (const set of ANIMATED_SETS) {
			this.claimSet(animate, animator, set, clipIdFor(set, isR15));
		}

		// **And then the two moving clips are chosen here rather than left to the script** — see
		// {@link LocomotionAnimationController.startMoving}. Nothing plays until the body actually
		// moves, so this costs two track loads at spawn and nothing else.
		this.startBody(character, humanoid, animator, isR15);
	}

	/**
	 * Builds this body's renderer, remembers the ids this game has claimed, and starts the loop that keeps
	 * the body in step with it.
	 *
	 * **This is where the two bodies meet, and it is the whole of the rewrite.** The renderer is `BodyAnimation`
	 * — the same object a rig is dressed by, deciding from the same table through the same `bodyClipFor` — so a
	 * state added to `animation.config.ts` is played on this body and on a rig alike. What is left here is the
	 * two things that are a *player's*: the facts, which this client measures rather than receives, and the
	 * engine's own animation script, which only a player has. Both are argued at {@link step} and
	 * {@link suppressScript}.
	 *
	 * **The claimed ids are the four the script has sets for**, read out of the shared table rather than listed
	 * here, because "which clips the script could be playing" is a question about the vocabulary and not about
	 * this file. A blank id stays on the list on purpose: it is the off switch for one state, so it claims
	 * nothing and matches nothing below.
	 */
	private startBody(character: Model, humanoid: Humanoid, animator: Animator, isR15: boolean): void {
		const owned: OwnedBody = {
			humanoid,
			animator,
			body: startBodyRender(character, humanoid, animator, "Animate"),
			claimed: ANIMATED_SETS.map((set) => clipIdFor(set, isR15)),
			// **False, and the first tick is what says otherwise.** A body arrives standing, so the first tick
			// finds owning already true and prints nothing — which is what keeps the log to the transitions the
			// line is for. See `OwnedBody.deferring`.
			deferring: false,
		};

		// Spawned, because the loop is the rest of this body's life and `dress` is a handler on the
		// way in. A body that never moves runs this loop idle for as long as it exists, which is the
		// cost of asking the question at all.
		task.spawn(() => this.follow(character, owned));
	}

	/**
	 * Keeps the body's clip in step with what the body is doing, until the body is gone.
	 *
	 * **Death and despawn are the same exit**, because both end the body: `Health` at zero is a
	 * corpse this file has no opinion about, and a character whose parent is nil has been replaced.
	 * Either way the loop is over, and a track left playing on a body that has died is a corpse
	 * still walking.
	 *
	 * **The tick is a poll because a player's facts are measured rather than published**, which is the one
	 * asymmetry left between the two bodies: a rig's state arrives as attributes and its renderer runs on the
	 * changes, while a body's *speed* is a quantity this client reads from its own physics and there is nothing
	 * to be told about. Twenty times a second is short enough that no change of clip reads as late, and a tick
	 * that agrees with the last one costs a state read — see `step` and the renderer's own guard.
	 */
	private follow(character: Model, owned: OwnedBody): void {
		// **Reported once and then not again, because a tick that fails fails twenty times a second.**
		// The first failure is the one worth reading; twenty lines a second would bury it and the
		// output with it.
		let reported = false;

		while (character.Parent !== undefined && owned.humanoid.Health > 0) {
			// **Guarded, because a tick can race a body that is on its way out.** The character can
			// be destroyed between the check above and the track this tick touches — a respawn, a
			// death — and an error raised here would end the loop *without* ending the body, which is
			// a body that never walks with an animation again rather than one that stops walking. A
			// failed tick is retried on the next one; only the last one before the body goes matters.
			const [ok, err] = pcall(() => this.step(owned));

			if (!ok && !reported) {
				reported = true;
				logWarn(`[Animate] tick failed — ${err}`);
			}

			task.wait(MOVEMENT_TICK_SECONDS);
		}

		destroyBodyRender(owned.body);
	}

	/**
	 * Puts the body into the clip its own state says, or writes nothing at all while the answer has not moved.
	 *
	 * **The guard that makes a twenty-times-a-second poll affordable is the renderer's now**, which is the whole
	 * of what this method has to know about it: a call that arrives at the clip already playing is a comparison
	 * and nothing else.
	 *
	 * **The engine's own script is stopped first, on every tick rather than on a change.** The script re-decides
	 * for itself — it has its own thresholds, its own `Running` handler and no idea which clips this game has
	 * asked for — so a set it starts a frame after this file last looked is a second track on the same limbs. It
	 * plays *our* clip (the sets are claimed with our ids, see {@link claimSet}), so the blend is invisible; what
	 * is not invisible is it choosing a *different* set from ours, which is what this line prevents. See
	 * {@link suppressScript}.
	 *
	 * **The facts are gathered here and nowhere else, because they are the facts only this client can answer
	 * for.** What this body has been asked to do, whether it is standing on something, and which of the
	 * humanoid's states the game has a clip for — none of which a renderer holding a body could work out for
	 * itself. The **events** the renderer needs — a throw, a catch, a dash — are attributes on the body, written
	 * by the server, and the renderer reads those for itself.
	 *
	 * **And the two facts gathered here are the *request*, not the body's traffic.** `moving` and `sprinting`
	 * are read fresh on every tick — the humanoid's own `MoveDirection`, the walk speed it has been given, and
	 * the sprint key — and neither needs a clock, a history or a threshold, because a request either stands or
	 * it does not. See `animationFor`: there is nothing here left to smooth.
	 *
	 * **`frozen` is passed `false`, and that is a reading rather than an omission.** A player's freeze is a
	 * walk-speed key and an anchored root (`FreezeService`), and the *key* is where this file already sees it: a
	 * pinned body is not a body anyone has asked to walk, so `moving` is false and its legs stop. Publishing a
	 * flag for it as well would be a second answer to a question this one has answered, and the two could
	 * disagree. A *rig* has no such key and is published a flag instead — see `BodyState.moving`.
	 *
	 * **And the state is read here too, because it is the one fact this file has that the renderer must not
	 * learn.** `OWNED_STATES` answers it, the answer travels as `deferToDefault`, and the humanoid's own
	 * vocabulary stops at this line — which is why `BodyConditions` carries the boolean rather than the enum.
	 * The transition is printed and the state itself is not, for the reason a per-tick print is never the right
	 * one: a body sitting on a bench is asked twenty times a second and answers the same thing.
	 */
	private step(owned: OwnedBody): void {
		this.suppressScript(owned);

		// **The deferral, decided here and nowhere else.** `FloorMaterial` is what this file used to answer with
		// and it is the wrong question — see `OWNED_STATES` for the two faults that came of it. Read once per
		// tick because the state can change between ticks, and compares against the row rather than against the
		// last read so that the line below is an edge.
		const state = owned.humanoid.GetState();
		const deferring = !OWNED_STATES.includes(state);

		if (deferring !== owned.deferring) {
			owned.deferring = deferring;
			logInfo(
				`[Animate] ${owned.body.body.Name}: ${deferring ? "deferring to Roblox" : "owning"} — ` +
					`state ${state.Name}`,
			);
		}

		// **The request, and the whole of it: is this body being walked, and is the sprint key down.** A
		// `MoveDirection` is the direction the last writer of the frame asked for — Roblox's own control module,
		// and this game's `AlternativeMovementController` while the `UHJK` keys are held — so it is exactly
		// "somebody asked this body to move", and it is stable in the way a velocity is not: a body pressed
		// against a barrier keeps asking, and a body that has stopped stops asking on the frame its keys come up.
		//
		// **And the walk speed is folded in, which is the one judgement in this line.** A frozen player — a
		// round's freeze, a duck, a hold — is still *pressing* keys, so `MoveDirection` alone would put a pinned
		// body into the walking clip. The freeze is a walk-speed key and an anchored root; the key is what says
		// the game has taken the legs away, and that is a different thing from a wall being in the way, which is
		// why only the former stops the request.
		const humanoid = owned.humanoid;
		const moving = humanoid.MoveDirection.Magnitude > 0 && humanoid.WalkSpeed > 0;

		// **The charge, measured here the way the arc is measured one file over.** `chargeStartedAt` is the
		// instant the hold began — the one fact `ThrowController` and `CatchController` share — and dividing by
		// `CHARGE_SECONDS` is the division `ThrowController.currentCharge` makes for the throw itself. Doing it
		// again here rather than exporting a getter is deliberate: it is one clamp, and a getter would be a
		// second place the charge could be answered from, which is the pair of numbers that must not drift.
		//
		// **`undefined` while nothing is held**, which is what tells the renderer to release the throw pose
		// rather than hold it. See `BodyConditions.charge`.
		const began = Fusion.peek(chargeStartedAt);
		const charge =
			began !== undefined ? math.clamp((os.clock() - began) / BALL_CONFIG.CHARGE_SECONDS, 0, 1) : undefined;

		applyBodyRender(owned.body, {
			moving,
			sprinting: Fusion.peek(sprinting),
			grounded: humanoid.FloorMaterial !== Enum.Material.Air,
			frozen: false,
			deferToDefault: deferring,
			charge,
			// **The release, which this client knows and the server will not tell it about for a round trip.**
			// Set by `ThrowController.releaseThrow` on the frame the button comes up and cleared at the next
			// charge or any cancellation, so a cancelled charge cannot hold a pose for a throw nobody made.
			releasedCharge: Fusion.peek(releasedCharge),
		});
	}

	/**
	 * **The speed that used to be measured here, and why it is gone.**
	 *
	 * This method read `RootPart.AssemblyLinearVelocity` — horizontally, never the fall speed — and the decision
	 * took its magnitude. It was written to replace the humanoid's `Running` event, and the argument still reads
	 * well: the event fires when the running speed *changes*, so between two of them a listener holds a number
	 * that was true when it was written. **What replaced the event is exactly what the event was criticised for,
	 * one layer down.** A velocity read on a tick is a *sample*, so a body that is barely moving crosses any line
	 * drawn near zero several times a second — the walk speed is 20 and the measured figure for a body walking is
	 * 20.3, which is the whole of the reason a line at 25 had to be invented — and the two faults this method's
	 * old doc recorded ("a body standing still wearing the walk clip", "a body travelling at twenty studs wearing
	 * no moving clip at all") were the two ends of one threshold that could not be drawn anywhere good.
	 *
	 * **So the body is asked instead of measured.** `Humanoid.MoveDirection` is what the last writer of the frame
	 * requested — an *intent*, with no line in it — and `step` turns it and the walk speed into the two facts the
	 * decision takes. Nothing in this file reads a velocity any more.
	 */

	/**
	 * Stops the engine's animation script from playing a clip this game has claimed.
	 *
	 * **This file used to play two clips of its own and let the script play the other two, and that is the half
	 * of the old design that is gone.** The renderer plays every state now — idle, walk, run, jump, the throw,
	 * the catch, the dodges — so the only question left about the script is how to keep it off the four sets
	 * this game has taken. It is answered by *claiming* the sets (see {@link claimSet}, which hands the script
	 * our ids) **and** by stopping its tracks here: the claiming makes any track it starts wear our clip, and
	 * this makes it stop doing so for a set our own decision has since moved off. Neither half is enough alone
	 * — claiming alone leaves the script choosing between sets on *its* thresholds, and stopping alone would
	 * leave a moment in which it plays Roblox's own walk over ours.
	 *
	 * **Identified by what the track is playing, not by who started it.** A track cannot be asked who created
	 * it, but it can be asked which animation it is holding — `AnimationTrack.Animation` — so the filter is "a
	 * track wearing one of our claimed ids that is not one of the renderer's own" (`BodyAnimation.plays`). Every
	 * other animation on the body is left untouched: an emote, a tool animation or a fall clip is a different
	 * id, and stopping one of those would be this file eating an animation it never claimed.
	 *
	 * Called on every tick rather than on a change, because the script decides on its own clock and a set it
	 * starts a frame after this file last looked is a second track on the same limbs.
	 */
	private suppressScript(owned: OwnedBody): void {
		for (const track of owned.animator.GetPlayingAnimationTracks()) {
			if (bodyRenderPlays(owned.body, track)) continue;

			const animation = track.Animation;
			if (animation !== undefined && owned.claimed.includes(animation.AnimationId)) {
				track.Stop();
			}
		}
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
			logDebug(`[Animate] ${name}: no id set — left as Roblox's`);
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
			// said out loud, and it is `logWarn` rather than a debug print because it is a mistake
			// rather than a note: it ignores `DEBUG_LOGGING` and appears in every playtest, which is
			// what "loud" means here. Like every other diagnostic it is silent on a live server — the
			// tier that survives production is `logError`, and a clip that will not load is a content
			// problem somebody has to see in Studio rather than a data loss to page somebody about.
			logWarn(`[Animate] ${name}: ${animationId} did not load — Roblox's set left in place`);
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

		logDebug(`[Animate] ${name} -> ${animationId}`);
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
