import { Controller, OnStart } from "@flamework/core";
import Fusion from "@rbxts/fusion-3.0";
import {
	ContextActionService,
	ContentProvider,
	Players,
	ReplicatedStorage,
	RunService,
	SoundService,
	UserInputService,
	Workspace,
} from "@rbxts/services";
import { AimGuide } from "shared/AimGuide";
import { AUDIO_CONFIG } from "shared/config/audio.config";
import { BALL_CONFIG } from "shared/config/ball.config";
import { DEBUG_CONFIG } from "shared/config/debug.config";
import { BALL_NAME, BALL_SIZE } from "shared/constants";
import { REMOTES } from "shared/remotes";
import { abilityOn } from "shared/ability";
import { ChargeRequest, getThrowMuzzle, planChargedThrow } from "shared/throw";
import { Trajectory } from "shared/Trajectory";
import { aiming, predictedTargets } from "../../aiming";
import { shakeCamera } from "../../cameraShake";
import { chargeStartedAt } from "../../throwing";

const ACTION_NAME = "ThrowDodgeball";
const CURVE_ACTION_NAME = "BendThrow";

/**
 * Console diagnostics: which throw was fired, and the marker-jitter report — that one is rate limited so
 * it will not flood the output, and sits behind `DEBUG_CONFIG.VERBOSE_LOGS` as well. Flip this to `true`
 * when chasing a charging or a landing problem.
 */
const DEBUG = true;

/**
 * **The charge has no smoothing constant, and the one that used to sit here is worth understanding before
 * another is added back.**
 *
 * An aim *point* used to be read every frame and eased toward the live one on a clock, because the solve
 * turned a point into a landing mark: a stud of jitter in the point was a stud of jitter in the marker, and
 * the raycast that produced the point could switch between two nearby surfaces from one frame to the next,
 * so a player standing perfectly still watched the marker twitch. That constant, its filter, its state and
 * its whole apparatus are gone.
 *
 * **The direction does not have the problem the point had.** A charged throw aims with the *vector* from the
 * camera through the mouse, and a mouse that is not moving gives the same vector every frame — there is no
 * cast to land somewhere different and no triangulation to flip. While charging, the marker moves because
 * the charge is growing, which is the one motion that is supposed to be there. So nothing here is filtered,
 * and a filter added back "for safety" would reintroduce exactly the ratchet the old comment was written
 * about: a point held a little behind the cursor, thrown at, and landing where the player had already moved
 * off.
 *
 * **What can still jitter is still watched** — the launch point rides the body's own animation, and the path
 * is a per-frame simulation — and both of those are the subject of {@link reportMarkerJitter}, which is
 * where the question "what moved the arc" lives now.
 */

/**
 * The body a part belongs to, or nothing.
 *
 * **The whole of what counts as a body, and the reason it is one function.** The nearest `Model` above
 * the part says "this is a body rather than scenery"; the `Humanoid` inside it says the body is a
 * character rather than a prop that happens to be assembled as a model. A part that fails either half
 * is not a body — a tree, a wall, the floor, the sky — which is the case that used to light a model
 * through a trunk.
 *
 * **Two questions are asked of this one test, and they must not come apart**: the sweep asks whether to
 * fly *through* a part (see {@link passesThroughBodies}), and the glow asks which body to light. Being
 * the same call, a part the arc refuses to stop on is always a part whose body the glow is willing to
 * light — the guide cannot promise something the glow disagrees with, which two expressions of the test
 * would give it two chances to do.
 */
function bodyOf(part: BasePart | undefined): Model | undefined {
	if (!part) return undefined;

	const model = part.FindFirstAncestorWhichIsA("Model");
	if (!model || !model.FindFirstChildWhichIsA("Humanoid")) return undefined;

	return model;
}

/**
 * Whether a planned throw should fly *through* `part` rather than stopping at it.
 *
 * **The client's half of the server's Pierce rule, and deliberately the same rule: every body.** A part
 * passes if it belongs to a body at all — see {@link bodyOf}, which is that test and the only place it
 * is written — and that is the set `BallService.pierceBodies` enumerates on the other side (every
 * player's character, every rig wearing the `NPC` tag, both of which have a humanoid inside them).
 * Scenery assembled as a model has no humanoid, so a tree still stops the drawn arc exactly as it stops
 * the ball.
 *
 * The server builds its set by walking rosters and tags, which this side cannot do for rigs without
 * trusting its own copy of the tag; the ancestor test asks the same question about the part the sweep
 * actually found, so there is nothing here to disagree about — and nothing it can get wrong about the
 * case that matters, which is the bodies a player is aiming at.
 *
 * A wrapper rather than the test itself, because this is the shape `Trajectory` wants: a predicate it
 * can be handed. A throw that is not a Pierce one passes `undefined` instead, so the option is free.
 */
function passesThroughBodies(part: BasePart): boolean {
	return bodyOf(part) !== undefined;
}

/**
 * The playback speed that makes `sound` last exactly as long as a full charge, in seconds.
 *
 * **Derived from the clip's own length, because `PlaybackSpeed` scales the *rate* and nothing else.** A sound
 * lasts `TimeLength / PlaybackSpeed` seconds, so `TimeLength / CHARGE_SECONDS` is the one speed that puts the
 * end of the clip — the click — at the instant the charge completes, and it does so for any clip and any
 * charge time. That is the whole reason this is arithmetic rather than a number: a literal would be right for
 * exactly one pair of values, and `CHARGE_SECONDS` is a `**Placeholder.**` that is expected to move. The day
 * somebody shortens the charge, a written-down speed would have the click landing after the ball had already
 * gone; derived, the two cannot come apart.
 *
 * **`0` is the one input this cannot use, and it is not an edge case to shrug at.** `TimeLength` reads `0`
 * until the clip has loaded — it is the engine's way of saying "no idea yet" rather than "instant" — and
 * dividing by it would be a `nan` speed, which is a `Sound` that plays at the engine's mercy rather than at
 * ours. The fallback is `1`: the identity, the one value that needs no knowledge of the file at all, so a
 * charge that beats the load plays the clip as its artist made it rather than at an invented rate of a length
 * nobody has. It is a degraded case and it is reported as one — see `playChargeSound`, which prints that the
 * clip was not loaded. `ContentProvider.PreloadAsync` at startup is what keeps the case from happening: the
 * clip cannot be asked for before the player is holding a ball in a round, and the load begins at client boot.
 *
 * Module-level rather than a method because two callers want the same arithmetic: the press that plays the
 * sound, and the preload's report, which prints the ratio the moment the length is known so the real numbers
 * are in the log without anybody having to charge a throw to find them.
 */
function chargePlaybackSpeed(sound: Sound): number {
	const length = sound.TimeLength;
	if (length <= 0) return 1;

	return length / BALL_CONFIG.CHARGE_SECONDS;
}

@Controller()
export class ThrowController implements OnStart {
	private readonly player = Players.LocalPlayer;
	private throwRemote?: RemoteEvent;
	private readonly guide = new AimGuide();

	// Scaffolding for tracking down a marker that moves when it should not — see `reportMarkerJitter`.
	private lastMouse: Vector2 | undefined;
	private lastMuzzle: Vector3 | undefined;
	private lastLanding: Vector3 | undefined;
	private lastMid: Vector3 | undefined;
	private nextReport = 0;

	/** The last arc report, so only a change at either end of it is printed. See {@link reportArc}. */
	private lastArcReport = "";

	// **The charge's own state is not here, and that is a consequence of the catch key cancelling a throw.**
	// It lives in `client/throwing.ts` — a module, so that `CatchController` can clear it without this
	// controller being reached into — and every use of it below reads or writes that value. See that file for
	// the argument, and for the one case that decided its shape: a press of `E` and a release of the mouse can
	// land inside a single frame, so the cancellation has to be a write the release handler can already see
	// rather than a request something consumes later.

	/**
	 * The charge the preview drew with on the most recent frame.
	 *
	 * **A record rather than an input**, and it exists because the two moments the charge matters fall at
	 * different times: the drawing happens in the frame loop, and the sending happens in the release handler,
	 * which lands between two frames. {@link releaseThrow} recomputes from the clock rather than reading
	 * this, and prints both, so the one-frame gap between what was drawn and what was thrown is a number in
	 * the log rather than something assumed away.
	 */
	private lastCharge = 0;

	/**
	 * The charge's sound: **one instance, made once at startup and reused for every hold.**
	 *
	 * **On the controller rather than in a module beside `elevation.ts`'s two tones**, and what separates the
	 * two cases is *when* the sound is needed rather than what it is. Those two are created lazily because a
	 * hover tone is asked for by a pointer that may never arrive on a shelf that may never be opened, so
	 * building them up front is paying for nothing. This one is wanted the instant the throw button goes down —
	 * which can be the first second of the first round, with no warning at all — and a clip that only began
	 * loading at that moment arrives after the thing it is describing. So it is built with the controller and
	 * preloaded, which is exactly the trade `ShopController` makes for the chest's award sound and for the same
	 * reason. The cost is the same one it accepted: a single `Sound` in `SoundService` for every client, whether
	 * or not they ever charge a throw.
	 *
	 * **`SoundService` rather than `PlayerGui`**, which is `MusicController`'s and `elevation.ts`'s decision
	 * written out in both places: a `Sound` is positional only when it hangs off a `BasePart` or an
	 * `Attachment`, and is heard at one volume from anywhere otherwise — which is what a sound the player makes
	 * with their own hand is — while `PlayerGui` is torn down and rebuilt on a respawn, which an instance made
	 * once for the session must not be sitting inside. **Client-side by construction and not by convention**:
	 * this instance exists in this client's `SoundService` and nowhere else, so nobody hears anybody else's
	 * charge, and nothing is sent to the server to make that true.
	 *
	 * **`Looped = false`, stated rather than left to the default.** The click is the *end* of this sound, so a
	 * loop would replay the click as a stutter at the exact moment the clip has finished saying something. The
	 * default is already `false`; this is the line that stops a reader having to go and find that out.
	 */
	private chargeSound?: Sound;

	/**
	 * Whether the ball bends — `V`, and the only lateral choice a charged throw has.
	 *
	 * **Starts off, and the server's own default is the same answer**: `BallService` treats anything that is
	 * not a literal `true` as a plain throw. That agreement is the same one the old arc default needed, for
	 * the same reason — a client that never pressed the key and a server that never heard one have to arrive
	 * at the same throw without having discussed it, and the value that does that is the one a fresh client
	 * holds.
	 */
	private curve = false;

	onStart() {
		// **The sound is made before the remote is resolved, and the order is the point.** `Get` yields until
		// the server's remote exists, and this clip should be loading from the first frame this client can
		// start loading anything — the charge it belongs to needs no remote to begin, and the throw that
		// follows it cannot be aimed until the remote has arrived anyway. So the preload gets the head start.
		const charge = new Instance("Sound");
		charge.Name = "ThrowCharge";
		charge.SoundId = AUDIO_CONFIG.THROW_CHARGE;
		charge.Volume = AUDIO_CONFIG.THROW_CHARGE_VOLUME;
		charge.Looped = false;
		charge.Parent = SoundService;

		this.chargeSound = charge;

		// **Preloaded so that `TimeLength` is known before the first charge rather than during it.** The speed
		// is derived from that length — see {@link chargePlaybackSpeed} — and the load cannot be waited for at
		// the press, because "starts on the frame the charge begins" is the whole behaviour. The window here is
		// enormous by comparison: a player has to be in a round, holding a ball, and press the button, and this
		// starts at client boot. The report below is the only place the real ratio is recorded, which is what
		// makes the pitch shift a number in the log rather than something somebody has to work out.
		ContentProvider.PreloadAsync([charge], (contentId, fetchStatus) => {
			if (fetchStatus !== Enum.AssetFetchStatus.Success) {
				warn(`[Throw] charge sound did not load — ${contentId} (${fetchStatus.Name})`);
			} else if (DEBUG) {
				print(
					`[Throw] charge sound loaded — ${string.format("%.2f", charge.TimeLength)}s clip, ` +
						`${string.format("%.2f", BALL_CONFIG.CHARGE_SECONDS)}s charge, speed ` +
						`${string.format("%.2f", chargePlaybackSpeed(charge))}`,
				);
			}
		});

		this.throwRemote = this.getThrowRemote();

		/**
		 * The throw input: **hold to charge, release to throw.**
		 *
		 * **What changed is the number of states it answers to.** This used to fire on `Begin` and nothing
		 * else — the press *was* the throw — which is why it needed no state at all, and why the aim could be
		 * read at the instant of the click. A charged throw needs both ends of the press: `Begin` starts a
		 * hold, `End` throws what the hold built, and `Cancel` — the engine's word for an input that ended
		 * without completing, which is how a window that goes away arrives here — drops it.
		 *
		 * **`Pass` is still what an empty hand gets and `Sink` is still what a throw gets**, so the button
		 * means one thing at a time and a press that did nothing has not been used up. `Begin` is the only
		 * branch that can refuse the whole gesture: once a charge has begun, a release always resolves it one
		 * way or the other, which is what stops the state machine having an exit that neither throws nor
		 * cancels.
		 *
		 * **A `Begin` that arrives while already charging is swallowed rather than restarting the hold.** One
		 * mouse button cannot produce it, and both of the answers available are wrong for a case that does not
		 * exist: restarting would quietly take the player's hold away, and treating it as a release would be
		 * two throws from one press. Swallowing it is the one answer that can do neither — and it is what the
		 * old `Begin`-only binding got for free.
		 */
		ContextActionService.BindAction(
			ACTION_NAME,
			(_actionName, inputState) => {
				if (inputState === Enum.UserInputState.Begin) {
					// **A ball in the hand is what makes a press a throw.** The click is not shared with
					// anything — `CatchController` binds `E`, `DodgeController` the right button — so this is
					// not one half of a contest over a button, just the plain test for whether there is
					// anything to throw. `Pass` rather than `Sink`, because a press that threw nothing has not
					// been used up.
					const character = this.player.Character;
					if (!character?.FindFirstChild(BALL_NAME)) return Enum.ContextActionResult.Pass;

					if (Fusion.peek(chargeStartedAt) !== undefined) return Enum.ContextActionResult.Sink;

					this.beginCharge();
					return Enum.ContextActionResult.Sink;
				}

				if (inputState === Enum.UserInputState.End) {
					if (Fusion.peek(chargeStartedAt) === undefined) return Enum.ContextActionResult.Pass;

					const character = this.player.Character;
					if (!character) {
						this.cancelCharge("the body went between the press and the release");
						return Enum.ContextActionResult.Sink;
					}

					this.releaseThrow(character);
					return Enum.ContextActionResult.Sink;
				}

				if (inputState === Enum.UserInputState.Cancel) {
					this.cancelCharge("the input was cancelled");
					return Enum.ContextActionResult.Sink;
				}

				return Enum.ContextActionResult.Pass;
			},
			false,
			Enum.UserInputType.MouseButton1,
		);

		/**
		 * **A second net under the engine's own `Cancel`.** A window that goes away mid-hold is the one way a
		 * charge could outlive the player's attention — holding the button down and alt-tabbing is the
		 * obvious way to find out what the engine does with it — and whether a lost window arrives here as
		 * `Cancel`, as `End`, or as nothing at all is not something the typings can answer. So the signal
		 * cancels too: a second cancellation of one charge is free ({@link cancelCharge} returns at once once
		 * the charge is gone), and what it buys is that the button coming back cannot complete a gesture the
		 * player walked away from. `AlternativeMovementController` watches the same signal for the same class
		 * of reason.
		 */
		UserInputService.WindowFocusReleased.Connect(() => this.cancelCharge("the window lost focus"));

		RunService.RenderStepped.Connect(() => this.updateGuide());

		/**
		 * `V`: **whether the ball bends.**
		 *
		 * **A toggle rather than one of three shapes, because two of the three are gone.** `overhead` and
		 * `straight` were vertical ways of reaching a point, which is the axis the charge now controls
		 * continuously; a curve is a *lateral* shape — a different axis — so it survives as a switch on top of
		 * the hold. `V` chose the curveball before this change and chooses it now, so this is a surviving key
		 * rather than a new binding, and `X` and `C` are gone with the shapes they chose.
		 *
		 * **It can be flipped mid-hold, deliberately.** The preview is rebuilt every frame from the current
		 * charge *and* the current curve, so a toggle during a hold is one more input that same loop reads: the
		 * arc redraws bending, there is no state to keep in step, and nothing has to be undone if the player
		 * changes their mind. What is sent is read at the release, so the shape thrown is the shape drawn on
		 * the last frame — see {@link releaseThrow}.
		 */
		ContextActionService.BindAction(
			CURVE_ACTION_NAME,
			(_actionName, inputState) => {
				if (inputState !== Enum.UserInputState.Begin) return Enum.ContextActionResult.Pass;

				this.curve = !this.curve;
				if (DEBUG) print(`[Throw] curve ${this.curve ? "on" : "off"}`);

				// Redrawn on this frame rather than the next, for the reason the press redraws: the curve is
				// half of what the drawn shape *is*, and a frame of the old shape after a key press is a frame
				// of a throw the player has already changed.
				this.updateGuide();
				return Enum.ContextActionResult.Sink;
			},
			false,
			Enum.KeyCode.V,
		);

		// The line that says this controller ran at all, in the shape every other controller here uses:
		// "nothing happens" has two causes — this never started, or it started and found nothing to do — and
		// the charge adds a third, which is whether the press bound at all. Missing, and the question is
		// whether the file is in `StarterPlayerScripts`; present, and the question moves to what the press did.
		if (DEBUG) {
			print(
				`[Throw] up — hold to charge (${BALL_CONFIG.CHARGE_SECONDS}s to full), release to throw, ` +
					`${Enum.KeyCode.V.Name} bends it (${this.curve ? "on" : "off"})`,
			);
		}
	}

	/**
	 * One frame: **the charge, the preview, and the two ways a charge can end by itself.**
	 *
	 * **This is the only place the arc is built, and it now does nothing on most frames.** It used to be
	 * rebuilt every frame a ball was in hand — which is most of a round — whether or not anybody was aiming
	 * at anything. Since the button is now what puts the preview up, the solve, the sweep and the drawing all
	 * happen only during a hold, and every other frame is one `FindFirstChild` and a return. The cost of the
	 * preview went *down* with this change, not up.
	 *
	 * **It cannot be driven by a signal, and that is worth stating rather than assumed.** The thing that
	 * changes between frames while charging is *time*: the charge is a function of how long the button has
	 * been held, so there is no event to listen for and a per-frame redraw is the only shape that can show a
	 * hold lengthening. Everything else in this controller *is* signal-driven — the press, the release, the
	 * focus, the bend key — so this loop's whole job is the one part that has no signal.
	 */
	private updateGuide() {
		const character = this.player.Character;
		const ball = character?.FindFirstChild(BALL_NAME);

		// **A ball that is no longer in the hand cancels the charge, and this is the only cancellation this
		// file owns.** A drop, a death, a round boundary that destroyed the ball, and a throw made by some
		// other path all arrive here as one fact a frame later — and none of them is visible from the input
		// handler, which is why the check lives in the loop that already looks at the hand. See
		// `cancelCharge` for the rest of the list, which is the engine's own.
		if (Fusion.peek(chargeStartedAt) !== undefined && (!character || !ball || !ball.IsA("BasePart"))) {
			this.cancelCharge("the ball left the hand");
		}

		const charging = Fusion.peek(chargeStartedAt) !== undefined;

		// **The glow's flag is the guide's own visibility, published rather than worked out twice.**
		// It is set from the same expression that decides whether to draw, so the guide and the aim
		// glow cannot come to different answers about whether the player is aiming — which is the
		// whole reason it is published from here instead of `AimTargetController` deriving it for
		// itself. See `client/aiming.ts`. Set unconditionally, because a Fusion `Value` given the
		// value it already holds does nothing.
		//
		// **The flag now includes the charge, and that is a consequence rather than a preference.** What a
		// throw reaches is a function of how long the button was held, so a glow lit while nothing is being
		// charged would be naming the body a *different* throw would hit — the same disagreement between the
		// glow and the guide this file exists to prevent, with the charge as the thing that moves. It follows
		// that an idle player sees no glow; see the class doc for what that costs.
		aiming.set(charging);

		// **The charge's sound stops from the state rather than from a list of call sites, and that is the whole
		// of its stopping story.** Every way a charge can end already funnels through `chargeStartedAt`: the
		// release and the four cancellations clear it inside this file, and the `E` cancel clears it from
		// `CatchController`. Asking the state whether a charge exists therefore covers all of them — including
		// the `E` cancel, which this controller has no way of being told about, and including any sixth way that
		// is added later without anybody remembering this line exists. A second list of "places to stop the
		// sound" beside the list of "places to cancel the charge" would be two things to keep in step, which is
		// the failure mode this whole arrangement was built to avoid.
		//
		// **What it costs is one property read per frame while nothing is charged**, and the ordering above
		// matters for the same reason it is cheap: `charging` has already been read for the glow, so this is a
		// comparison against a value in hand rather than a second look at the shared state.
		//
		// **The one case it handles a frame late is the `E` cancel** — the charge is cleared in another file, and
		// this loop is what notices — so that cut lands up to a frame after the press, which at sixty frames a
		// second is inside the sound rather than beside it. Every other path stops the sound on its own frame,
		// because `releaseThrow` and `cancelCharge` both end by calling this method.
		if (!charging) this.stopChargeSound();

		if (!charging || !character || !ball || !ball.IsA("BasePart")) {
			this.guide.hide();

			// Nothing is being aimed, so nothing is predicted. Cleared rather than left alone for the
			// same reason the guide is hidden: the glow is driven by the flag those two share, and a
			// publish that stopped would leave the last answer standing for whoever read it next.
			predictedTargets.set([]);
			return;
		}

		const charge = this.currentCharge();
		this.lastCharge = charge;

		// This is not an approximation of the arc — it is the same plan the
		// server will run when the release arrives, from the same heading and
		// the same charge. See `planChargedThrow`, which both sides call.
		const plan = planChargedThrow(character, this.chargeRequest(charge));

		// **Whether this throw is a Pierce ball, which changes what the arc is allowed to stop at.**
		//
		// Read from the ball in the hand rather than from anything the server said, because the guide is
		// drawn before the throw exists: the attribute is already on the ball this client is holding, so
		// this is the same fact the server will act on rather than a copy of it that could disagree.
		const pierce = abilityOn(ball) === "Pierce";

		// The guide itself is ignored as well as the thrower. Its own parts sit
		// right along this arc, and an arc that can hit the line drawn to
		// represent it will chase itself around the world.
		//
		// The radius matters: the ball bounces when its edge touches a surface, a
		// full half-diameter before its centre gets there. Tracing the centre
		// alone always marked the impact too far along. The guide sweeps a sphere
		// the size of the ball, and the solve aimed the ball's *centre* out from
		// the surface so its *edge* is what arrives on it.
		const arc = new Trajectory(plan.origin, plan.velocity, {
			ignore: [character, this.guide.instance, ...this.looseBalls()],
			radius: BALL_SIZE / 2,
			// **The plan's own gravity, read off the plan rather than from the config.** The solve used
			// it and the ball's `VectorForce` makes it the ball's real pull — see
			// `BallFactory.applyBallGravity` — and the drawn path is only trustworthy while all three are the
			// same number. Reading a constant here is how the arc of a heavier ball got drawn: it fell faster,
			// marked the ground short of where the throw lands, and the marker moved as the aim did.
			gravity: plan.gravity,
			// **The curve's pull, from the same plan the server will apply it from.** A curve is a force
			// rather than a launch angle, so the drawn path has to be simulated under it as well as launched
			// with it, and the only reason the preview can be believed is that this vector is the same one
			// `applyAcceleration` turns into a `VectorForce`. It is zero for a throw with no bend, which is
			// how one code path covers both shapes.
			acceleration: plan.acceleration,
			// **And the one line that makes the preview honest for Pierce.** Omitted for every other throw,
			// which is what keeps an ordinary ball's arc exactly what it was — see {@link passesThroughBodies}
			// for what the predicate answers, and why it is the server's rule rather than a second one.
			passable: pierce ? passesThroughBodies : undefined,
		});

		// The marker report is the noisiest thing in the game, and it is rate limited and behind
		// `DEBUG_CONFIG.VERBOSE_LOGS` for that reason — see `shared/config/debug.config.ts`.
		if (DEBUG && DEBUG_CONFIG.VERBOSE_LOGS) this.reportMarkerJitter(arc, getThrowMuzzle(character));

		// **What the arc would reach, published for the glow.** The glow answers "what is my aim on",
		// and the honest answer is where this throw goes rather than what is under the crosshair —
		// those are two different lines and only one of them is the throw. See `AimTargetController`
		// for what the difference looked like from the player's seat.
		//
		// **Every body it would reach and not only the one it stops on, because Pierce has more than one
		// answer to that question.** The arc is this file's answer either way and is already computed
		// here every frame — see `hitTargets`, which walks the body it stops on *and* the bodies it
		// passes through — with the thrower, the guide and the loose balls excluded exactly as they are
		// for the drawn path. Computed once and used twice rather than worked out twice, which is the
		// same reason this file publishes the aiming flag.
		const arcTargets = this.hitTargets(arc);
		predictedTargets.set(arcTargets);
		this.reportArc(arc, arcTargets);

		// **Both ends of the preview, and the placement is why the marker is honest.** The path ends where
		// the ball's *centre* stopped, one radius clear of the surface; the marker lies flat on the surface
		// its edge touched. Passing the contact point is what puts the disc where the ball will actually
		// arrive rather than a radius past it — see `AimGuide.MarkerPlacement`.
		this.guide.update(arc.points, { position: arc.contact ?? arc.landing, normal: arc.normal });
	}

	/**
	 * How much of a charge the current hold has built, from `0` to `1`.
	 *
	 * **One division off the clock, and therefore the same number for the preview and for the send.** That is
	 * the whole reason this is a method rather than a value kept up to date: the frame that draws and the
	 * release that sends ask the same question of the same clock, so they agree by construction instead of
	 * being two things to keep aligned. `ChargeRequest.charge` is where that matters.
	 *
	 * **`os.clock` is the clock this file already timed with** — the aim smoothing this replaces used it for
	 * the same job, and `CatchService`, `DodgeService` and `WalkSpeedService` all time their windows with it
	 * on the other side. A hold measured against something else would be the one duration in the game that
	 * disagreed about how long a second is.
	 *
	 * A hold still running when the ceiling is reached stays there — the value clamps, so holding past full
	 * is a full charge and nothing else. **Nothing auto-throws**, deliberately: the player decides when the
	 * ball leaves, and the alternative would take a throw away from somebody who was still aiming it.
	 */
	private currentCharge(): number {
		const began = Fusion.peek(chargeStartedAt);
		if (began === undefined) return 0;

		return math.clamp((os.clock() - began) / BALL_CONFIG.CHARGE_SECONDS, 0, 1);
	}

	/**
	 * **The request the preview and the throw are both built from** — one object, so the two cannot be handed
	 * different inputs by accident.
	 *
	 * It is built here rather than at each call site for exactly that reason: the frame loop builds one per
	 * frame to draw with, and the release builds one to send, and if those two constructions were written
	 * out separately a change to one of the three fields would reach the preview and not the wire — which is
	 * the one class of bug this whole arrangement exists to make impossible.
	 */
	private chargeRequest(charge: number): ChargeRequest {
		return { heading: this.getThrowDirection(), charge: charge, curve: this.curve };
	}

	/**
	 * Starts a charge: **the press.**
	 *
	 * **The clock starts and the arc appears on this frame, not the next.** The arc matters: a player who
	 * taps to lob would otherwise throw before they had seen any preview at all, and the touchiest part of
	 * this mechanic — judging the hold — is judged from a drawing that a one-frame delay would have withheld
	 * from exactly the shortest throws.
	 *
	 * **The sound starts here too, and only here**, which is the half of its life that cannot be derived from
	 * the charge's state: at full charge the clip has already ended, so "nothing is playing" is not evidence
	 * that nothing is being charged, and a `Play` keyed off the state would restart the clip on every frame
	 * after the click. Starting it as a *transition* and stopping it as a *state* — see {@link updateGuide} for
	 * the other half — is what makes a hold past full silence until the next press, which is the intent: the
	 * sound is the build-up to being ready, and once it has said so there is nothing left to say.
	 *
	 * Nothing else is set up: there is no timer, no accumulator and no state beyond the instant, because the
	 * charge is derived from elapsed time whenever it is asked for. See {@link currentCharge}.
	 */
	private beginCharge(): void {
		chargeStartedAt.set(os.clock());
		this.lastCharge = 0;
		this.playChargeSound();

		if (DEBUG) {
			print(`[Throw] charging — ${BALL_CONFIG.CHARGE_SECONDS}s to full${this.curve ? ", bending" : ""}`);
		}

		this.updateGuide();
	}

	/**
	 * Starts the charge's sound: **the build-up, sped to fit the hold, with its click landing on full charge.**
	 *
	 * **The speed is derived from the clip rather than written down**, which is the point of the whole entry:
	 * `PlaybackSpeed` scales the playback *rate*, so the sound lasts `TimeLength / PlaybackSpeed` seconds, and
	 * `TimeLength / CHARGE_SECONDS` is therefore the one speed that puts the end of the clip exactly where the
	 * charge completes — for any clip, and for any value of `CHARGE_SECONDS`. See
	 * {@link chargePlaybackSpeed}, which is that arithmetic and its argument; the short version is that
	 * `CHARGE_SECONDS` is a `**Placeholder.**` and a written-down speed would drift out of step with it the
	 * moment it is tuned, leaving a click that lands after the ball has gone.
	 *
	 * **The price of the derivation is pitch, and it is stated rather than discovered.** Faster playback is
	 * higher pitch — that is what resampling is — so a clip twice as long as the charge plays an octave up, and
	 * the click a player hears is not quite the click in the file. The alternative was to leave the speed at
	 * `1×` and start the sound at `TimeLength − CHARGE_SECONDS`, which preserves pitch exactly because nothing
	 * is resampled, and it was rejected: that keeps only the *end* of the clip, and the end of a build-up is
	 * the payoff with nothing leading into it. A charge sound is a rise and a click, the rise is the part that
	 * tells the player the throw is getting stronger, and a fragment of the ending arriving from nowhere is not
	 * that. So the build-up is kept whole and the pitch is the price — and the price is visible in the log,
	 * printed below as the ratio it actually is. **If the shifted click stops sounding like a click, the fix
	 * is on the file and not in this method**: a re-export pitched for the speed it plays at, or a clip cut to
	 * `CHARGE_SECONDS` long, which needs no resampling at all.
	 *
	 * **`TimePosition` is reset explicitly rather than assumed.** This one instance is deliberately allowed to
	 * run to its natural end when a player holds to full, so the next charge starts from a `Sound` sitting at
	 * the end of its clip rather than at the beginning of one. Rewinding is a property write that costs
	 * nothing, and relying on `Play()` to imply it would be relying on behaviour the typings do not state.
	 *
	 * **Not looped, and that is a property of the instance** — see {@link chargeSound} for why the click being
	 * the end of the sound makes a loop the wrong answer.
	 */
	private playChargeSound(): void {
		const sound = this.chargeSound;
		if (sound === undefined) return;

		const speed = chargePlaybackSpeed(sound);
		const loaded = sound.TimeLength > 0;

		sound.PlaybackSpeed = speed;
		sound.TimePosition = 0;
		sound.Play();

		if (DEBUG) {
			print(
				`[Throw] charge sound — ${string.format("%.2f", sound.TimeLength)}s clip at speed ` +
					`${string.format("%.2f", speed)}` +
					(loaded ? "" : " (clip not loaded — playing at 1×, so the click will not land on time)"),
			);
		}
	}

	/**
	 * Cuts the charge's sound: **the release, and every cancellation, and the `E` cancel one frame later.**
	 *
	 * **Reached from {@link updateGuide} and nowhere else**, which is the design rather than a coincidence: the
	 * frame loop is the one place that already asks whether a charge exists, and every path that ends one —
	 * including the one `CatchController` performs without telling this file — ends with the answer being no.
	 * See that method for the argument and for the frame of latency the `E` cancel pays.
	 *
	 * **`IsPlaying` rather than a flag of this controller's own.** The engine keeps that flag, and a copy here
	 * would be a second thing to be wrong about the same question. It also answers the only case that needs an
	 * answer: a sound that has already run to its end — which is the normal state of affairs at full charge,
	 * where the click has just landed — has nothing to stop and must not be restarted, and `Stop()` on a
	 * finished `Sound` is a no-op either way.
	 *
	 * **The typings carry two spellings of that flag and this is deliberately the read-only one.** `IsPlaying`
	 * is declared `readonly`; its sibling `Playing` — the one the Creator Hub page is named after — is declared
	 * writable, which is a shape that invites a caller to believe it can start a sound by assigning to it. A
	 * property this line only ever *asks* is better off being the one that cannot be written to by mistake.
	 *
	 * **The cut is abrupt, on purpose.** A release before full charge kills the clip where it stands rather
	 * than fading it, which is the mechanic's shape rather than an oversight: the sound is a countdown to being
	 * ready, and a countdown that fades out when you stop listening to it stops meaning anything. It also
	 * means the click is only ever heard by a player who held to full, which is exactly the information the
	 * sound exists to carry.
	 */
	private stopChargeSound(): void {
		const sound = this.chargeSound;
		if (sound !== undefined && sound.IsPlaying) sound.Stop();
	}

	/**
	 * Ends a charge by throwing: **the release, and the only place a player's throw is sent.**
	 *
	 * **The charge is recomputed here rather than taken from the frame loop**, so what goes on the wire is the
	 * hold as it actually ended — a release that lands between two frames is a release that happened, and a
	 * value up to a frame old is a value the player did not let go at. What that costs is stated rather than
	 * hidden: the *drawn* arc is at most one frame behind the charge that is sent (the last frame's number is
	 * {@link lastCharge}, and this line prints both). At sixty frames a second that is 1.7% of a full hold —
	 * a couple of studs of range at the very top of the range, and the reason the preview redraws every frame
	 * rather than only when something asks it to.
	 *
	 * **The heading is asked for again for the same reason**, so a throw made mid-turn goes where the player's
	 * aim was when they let go rather than where it was on the previous frame.
	 *
	 * The launch point goes with the throw, unchanged from the click model and for the same reason: the
	 * server's copy of the character is a replication interval behind this one, and a plan solved from a
	 * different launch point is a different arc. It matters *more* now that the server has no target to solve
	 * back to — see `BallService.acceptLaunch` for what the other side does with the claim.
	 */
	private releaseThrow(character: Model): void {
		const charge = this.currentCharge();
		const drawn = this.lastCharge;
		chargeStartedAt.set(undefined);

		// Drawn once more before the send, so the log's order is the order the player lived — hold, arc,
		// release — and so the preview comes down on this frame rather than hanging over a ball that has
		// already left. With the charge cleared, this draw is the one that hides everything.
		this.updateGuide();

		// **The camera kick, on the release rather than on the reply, and sized by the hold.** The throw the
		// player made is the event being marked, and this is the frame it happened on; waiting for the server
		// would put the feedback after a round trip and, worse, would make it a fact about the server's answer
		// instead of about the player's action. What that costs is stated rather than hidden: a throw the
		// server *refuses* — a frozen body, a stale charge — kicks the camera anyway, because the client has no
		// frozen flag to read and no reply to wait for. That is the same refusal `cancelCharge`'s doc already
		// describes from the other side, one shake further along.
		//
		// **`charge` rather than the ball, and this is the number the wire is about to carry.** It is the hold
		// as a fraction of the full one, which is exactly what the shake is meant to follow: retune
		// `CHARGE_MIN_SPEED` or `THROW_MAX_SPEED` and a throw at this hold still kicks the same camera, because
		// none of them are involved. See `cameraShake.ts` for the argument.
		//
		// Nothing about the throw depends on it: the shake is `client/cameraShake.ts`'s and reaches the
		// wire not at all.
		shakeCamera(charge);

		this.throwRemote?.FireServer(
			this.getThrowDirection(),
			charge,
			this.curve,
			getThrowMuzzle(character),
		);

		if (DEBUG) {
			print(
				`[Throw] released at charge ${string.format("%.2f", charge)}` +
					` (drawn ${string.format("%.2f", drawn)})${this.curve ? " — bending" : ""}`,
			);
		}
	}

	/**
	 * Drops a charge without throwing it.
	 *
	 * **Every cancellation site reaches this one method**, and the list is the whole answer to "what could
	 * still throw after the player stopped wanting it":
	 *
	 * - **the engine's own `Cancel`** for the mouse button, which is how an input that ends without
	 *   completing — an interruption, a window that goes away — arrives at a bound action;
	 * - **`WindowFocusReleased`**, as a second net under that, because whether a lost window produces
	 *   `Cancel`, `End` or nothing is not something the typings state;
	 * - **a body that is not there between the press and the release**, which is a death mid-hold;
	 * - **the ball leaving the hand**, checked once a frame in {@link updateGuide}, which covers a drop, a
	 *   death, a round boundary that destroys held balls, and any other path that empties the hand.
	 *
	 * **What is *not* on the list is worth stating too**, because a reader would expect it: the round ending
	 * and the phase changing cancel nothing here, because nothing in this file ever gated a throw on either —
	 * a ball may be thrown in the lobby and always could be. Freeze is the other one: a frozen body's throw is
	 * refused by the server (`BallService.throwBall`) and the client has no frozen flag to read, so a frozen
	 * player's press charges, previews and releases into a refusal. That is the same throw the game already
	 * refused before this change, one refusal further along.
	 *
	 * **A cancelled charge throws nothing at all**, which is what separates it from a release at zero charge: a
	 * tap is a throw the player made, and this is one they did not.
	 *
	 * The reason is a parameter rather than each call site printing its own line, because "which one was it"
	 * is the question a log like this is read to answer.
	 */
	private cancelCharge(reason: string): void {
		if (Fusion.peek(chargeStartedAt) === undefined) return;

		chargeStartedAt.set(undefined);
		this.updateGuide();

		if (DEBUG) print(`[Throw] charge cancelled — ${reason}`);
	}

	/**
	 * Every body a planned arc would reach, in the order it meets them. Empty if it reaches none.
	 *
	 * **The rule for what counts as a body is unchanged, and only the number of them has.** It is
	 * `bodyOf` — this module's one statement of it, shared with the sweep — and not a second copy of it
	 * written here.
	 *
	 * `FindFirstAncestorWhichIsA` starts at the *parent*, so a ball welded into somebody's hand still
	 * resolves to that model and lights them — it is their model, hanging where their body is. The
	 * arc sweeps through held balls rather than ignoring them, so a ball in front of a body is a hit
	 * on the body, which is also what the throw would do.
	 *
	 * **That paragraph described what was wanted rather than what happened, until a log showed the
	 * difference.** A sweep asks a part's `CanQuery` where the thrown ball's physics asks its
	 * `CanCollide` — see `RaycastParams.RespectCanCollide`, which is off — and a held ball is
	 * `CanCollide = false` with `CanQuery` still true. So the arc *stopped* on the ball in somebody's
	 * hand, a couple of studs short of their body, while the real ball flew through it and hit the body
	 * behind: the glow named the right model and the drawn path ended in the wrong place, which from the
	 * player's seat is a trajectory that says the throw will miss and a ball that hits. A throwing rig
	 * holds a ball nearly always — the throw refills the hand — so this was every throw at a rig.
	 * `BallService.attachToHand` now clears `CanQuery` for the length of a hold, which is what makes
	 * the paragraph above the description of what happens.
	 *
	 * **One body for an ordinary throw, and several for a Pierce one.** An ordinary arc ends on the
	 * first body it meets, so this answers with one entry and the glow reads exactly as it always did.
	 * A Pierce arc goes *through* the bodies in its line — that is the ability — and ends on the world
	 * behind them, so `arc.hit` is scenery and the bodies are `arc.passedThrough`. Both are walked,
	 * because the glow's job is to describe where the throw goes rather than to name where it stops:
	 * one body was the glow going dark on the bodies beyond the first, which is exactly the shot the
	 * ability is picked for.
	 *
	 * **The stopping part is walked first and the two lists cannot overlap**, so the order here is the
	 * order of flight. Repeats are dropped by identity, which covers the sweep meeting two parts of one
	 * body — a torso and the arm held in front of it — on its way through.
	 */
	private hitTargets(arc: Trajectory): Array<Model> {
		const targets: Array<Model> = [];
		const seen = new Set<Model>();

		const consider = (part: BasePart | undefined) => {
			const model = bodyOf(part);
			if (!model || seen.has(model)) return;

			seen.add(model);
			targets.push(model);
		};

		consider(arc.hit);

		for (const part of arc.passedThrough) consider(part);

		return targets;
	}

	/**
	 * Prints what the arc hit and what that came to, when either end of the report changes.
	 *
	 * **Both halves in one line, because they fail differently.** An arc that hit nothing and an arc
	 * that hit a wall report the same target — none — and mean completely different things: the first
	 * is an aim or a filter problem, the second is geometry in the way. Printed on change rather than
	 * per frame, because the arc is rebuilt every frame and a steady aim does not change it.
	 *
	 * **This line moved here from `AimTargetController` when the glow stopped casting**, and the move
	 * is the point rather than tidying: the arc is this file's, so this is now the only place that can
	 * report on it. Read it against the drawn path — if the marker is on a tree and this says the tree,
	 * the whole preview agrees and only the throw is in question.
	 *
	 * **The right-hand side is a list now, and usually holds one name.** An ordinary throw stops on the
	 * body it reaches, so this prints exactly what it always did; a Pierce throw prints every body in
	 * its line, in order, which is the shape to read the glow against when the question is "why is that
	 * one lit as well".
	 *
	 * Diagnostic scaffolding, in the same spirit as the `[Aim] ray:` line it replaces. Delete once the
	 * glow is trusted.
	 */
	private reportArc(arc: Trajectory, targets: Array<Model>): void {
		const contact = arc.contact;
		const hit =
			arc.hit && contact
				? `${arc.hit.GetFullName()} at ${math.floor(contact.sub(arc.origin).Magnitude)} studs`
				: "nil";
		const reached = targets.size() === 0 ? "nil" : targets.map((model) => model.Name).join(", ");
		const report = `${hit} -> ${reached}`;
		if (report === this.lastArcReport) return;

		this.lastArcReport = report;
		if (DEBUG) print(`[Aim] arc: ${report}`);
	}

	/**
	 * Watches the marker for motion the charge does not explain. Diagnostic scaffolding, behind
	 * `DEBUG_CONFIG.VERBOSE_LOGS` like the report it replaces.
	 *
	 * **Read it as a bisection, and note which branch has gone.** The tool this replaces asked what moved the
	 * drawn arc while the player held still, and it had three candidates: the aim ray landing somewhere
	 * different each frame, the launch point drifting underneath it, or the simulation itself. The first is
	 * structurally gone — the direction is the mouse ray's own vector, so a mouse that is not moving is a
	 * heading that is not changing — and the other two remain.
	 *
	 * **What is new is that the arc is *supposed* to move every frame.** The charge is a clock, so the marker
	 * travels outward by design, and a tool that fired on motion would fire constantly and say nothing. So the
	 * question is no longer "did it move" but **"did it move sideways"**: the marker's travel is split against
	 * the throw's own line, the part along it is the charge and is expected, and the part across it is the
	 * fault — a wobble in the solve, a launch point sliding, or a sweep resolved differently from one frame to
	 * the next. A hold that fills fast therefore reports nothing, which is the whole point of measuring it this
	 * way.
	 *
	 * **The mouse must be still, and that gate is what makes the test mean anything.** A player steering
	 * mid-hold moves the whole arc sideways legitimately, so across-motion is only a fault when the heading
	 * was not being touched — the same premise the old tool had, kept because it is still the right one.
	 *
	 * **`muzzle` is reported rather than folded into the verdict** because a launch point that has slid
	 * *underneath* a stationary aim is one of the two remaining causes: if the marker wanders and this number
	 * is moving too, the body is what did it, and if it is steady, the simulation is.
	 *
	 * **The report that used to sit beside this one is gone with its subject.** It watched for the plan's arc
	 * differing from the arc the player selected — `straight` and `curve` quietly becoming an `overhead` throw
	 * when the aim had no fall to solve with. A charged throw has no shape to fall back from: its angle is the
	 * hold, and no input can produce a plan that disagrees with the one the preview drew. Diagnostic
	 * scaffolding — delete once a charging throw is trusted to move only when it should.
	 */
	private reportMarkerJitter(arc: Trajectory, muzzle: Vector3) {
		const mouse = UserInputService.GetMouseLocation();
		const still = this.lastMouse !== undefined && mouse.sub(this.lastMouse).Magnitude < 0.5;

		// The middle of the path: the honest test for "the whole line moved", and it catches a line that
		// swings without either of its ends moving.
		const mid = arc.points[math.floor(arc.points.size() / 2)];

		// Rate limited. This is read against a marker that is moving every frame by design, and printing
		// thousands of lines a second costs real frame time in Studio — which would make the very stutter it
		// is trying to measure worse.
		const now = os.clock();
		if (still && this.lastLanding && this.lastMid && now >= this.nextReport) {
			// The line the charge is extending along, taken from the arc rather than from the aim: it is the
			// axis the expected motion is on, and a throw that reaches nothing has none.
			const reach = new Vector3(arc.landing.X - arc.origin.X, 0, arc.landing.Z - arc.origin.Z);

			if (reach.Magnitude > 0.001) {
				const axis = reach.Unit;
				// The component of `to - from` that is not along the charge's own direction.
				const across = (from: Vector3, to: Vector3) => {
					const moved = to.sub(from);
					return moved.sub(axis.mul(moved.Dot(axis))).Magnitude;
				};

				const landingAcross = across(this.lastLanding, arc.landing);
				const midAcross = across(this.lastMid, mid);

				if (math.max(landingAcross, midAcross) > 0.2) {
					this.nextReport = now + 0.5;
					const jump = (value: number) => string.format("%.2f", value);

					print(
						`[Aim] marker sideways +${jump(landingAcross)} | mid +${jump(midAcross)}` +
							` | muzzle +${jump(muzzle.sub(this.lastMuzzle ?? muzzle).Magnitude)}` +
							` | points ${arc.points.size()} | hit ${ThrowController.describeHit(arc)}`,
					);
				}
			}
		}

		this.lastMouse = mouse;
		this.lastMuzzle = muzzle;
		this.lastLanding = arc.landing;
		this.lastMid = mid;
	}

	/**
	 * Names the part the arc was stopped by, so the reported landing can be
	 * traced back to whatever is actually in the way.
	 */
	private static describeHit(arc: Trajectory): string {
		const hit = arc.hit;
		if (!hit) return "nothing";

		const parent = hit.Parent;
		return parent ? `${parent.Name}.${hit.Name}` : hit.Name;
	}

	/**
	 * Every dodgeball that has already been thrown, so the guide can pass
	 * through them.
	 *
	 * They are honest obstacles and the real ball does bounce off them — but they
	 * are small, round and scattered around the landing area, so a swept sphere
	 * that grazes one flips between touching it and missing it from frame to
	 * frame. That showed up in the probe as the arc collapsing to a two-point
	 * stub (landing +26.78, points 2) and springing back while the player stood
	 * perfectly still. The arc can only ever be a curve plus one impact; bounces
	 * are past what it can predict, so predicting them badly is worse than not
	 * predicting them.
	 */
	private looseBalls(): BasePart[] {
		const balls: BasePart[] = [];
		for (const child of Workspace.GetChildren()) {
			if (child.Name === BALL_NAME && child.IsA("BasePart")) {
				balls.push(child);
			}
		}

		return balls;
	}

	private getThrowRemote(): RemoteEvent | undefined {
		const folder = ReplicatedStorage.WaitForChild(REMOTES.folder, 10);
		if (!folder) return undefined;

		const remote = folder.WaitForChild(REMOTES.throwBall, 10);
		return remote && remote.IsA("RemoteEvent") ? remote : undefined;
	}

	/**
	 * The aim direction: **the ray the crosshair is on**, as a vector.
	 *
	 * **The same line the old aim point came from, so where the player points has not moved** — only what is
	 * done with it. The click model cast this ray to find a *point* to land on and solved a throw that
	 * reached it; a charged throw needs the ray's direction and nothing else, so the cast is gone and the
	 * vector it was cast along is the answer. That is the whole of this method: one line, one fewer raycast
	 * per frame, and the reason there is no smoothing constant left in this file (see the note at the top).
	 *
	 * **Why the camera's ray and not the body's heading.** "Aim by turning" is the other candidate and it is
	 * refused because the camera is *already* decoupled from the body here: `ShiftLock` turns the character
	 * with the view during a round, but a player may also walk one way while looking another, and a throw
	 * that followed the *body* would go somewhere they are not looking. What the player believes they are
	 * aiming is what the crosshair — the cursor this game draws while the lock is on — is sitting on, and
	 * this is the line that goes through it.
	 *
	 * **The pitch is deliberately kept and then thrown away one layer down.** What comes back from here is
	 * the ray's own direction, unflattened, because that is the vector there is; `planChargedThrow` projects
	 * it, on both sides of the wire, so exactly one function in the game decides what "horizontal" means for
	 * a throw. A client that flattened here and a server that flattened there would be two answers to one
	 * question, which is the class of bug this whole arrangement exists to prevent.
	 *
	 * A camera that does not exist yet is not an error — there is no aim before there is one, and due north is
	 * the same fallback the solve makes for a heading with no horizontal part at all.
	 */
	private getThrowDirection(): Vector3 {
		const camera = Workspace.CurrentCamera;
		if (!camera) return new Vector3(0, 0, -1);

		const mouse = UserInputService.GetMouseLocation();

		return camera.ViewportPointToRay(mouse.X, mouse.Y).Direction;
	}
}
