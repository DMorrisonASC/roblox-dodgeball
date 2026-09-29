import { Controller, OnStart } from "@flamework/core";
import {
	ContextActionService,
	Players,
	ReplicatedStorage,
	RunService,
	UserInputService,
	Workspace,
} from "@rbxts/services";
import { AimGuide } from "shared/AimGuide";
import { DEBUG_CONFIG } from "shared/config/debug.config";
import { BALL_NAME, BALL_SIZE } from "shared/constants";
import { REMOTES } from "shared/remotes";
import { getThrowMuzzle, planPlayerThrow } from "shared/throw";
import { LaunchPlan, Trajectory, ThrowArc } from "shared/Trajectory";
import { aiming, predictedTarget } from "../../aiming";

const ACTION_NAME = "ThrowDodgeball";
const ARC_ACTION_NAME = "SelectThrowArc";
const AIM_DISTANCE = 500; // how far to project the aim ray when nothing is hit

/**
 * Console diagnostics: which throw was fired, and a per-frame report on aim
 * stability. Flip to `true` when chasing an aiming or landing problem — the
 * jitter report is rate limited so it won't flood the output.
 */
const DEBUG = true;

/**
 * How long the aim point takes to close most of the distance to the live mouse
 * position — an exponential time constant in seconds, not a threshold and not a
 * duration.
 *
 * Each frame takes `1 - e^(-dt / tau)` of what is left, so the aim point
 * converges on the cursor rather than stopping near it. That is the whole of the
 * difference between this and the ratchet that used to sit here. The old
 * constant (`AIM_DEADZONE`, 0.50 studs) held a target until the live one drifted
 * that far away and then jumped to it, and it never converged: after any aim
 * movement the point sat wherever the last jump had left it, up to half a stud
 * from where the mouse actually pointed, *in whichever direction the mouse had
 * last moved* — near on the way out, far on the way in. Because the guide and
 * the throw both read that same held point they agreed with each other while
 * both being wrong, so a ratchet fault could only ever be seen as a landing
 * problem and never as a preview disagreeing with a ball.
 *
 * **Why frame-rate independent.** `dt` comes from the clock, so `alpha` shrinks
 * as frames shorten and the per-second rate stays put at 30, 60 or 240 Hz. A
 * fixed fraction *per frame* would smooth four times as much on a 240 Hz client
 * as on a 60 Hz one — the class of bug that only one machine can reproduce.
 *
 * **Why 0.08 s.** At 60 Hz that is `alpha ≈ 0.19`: about a fifth of the
 * remaining gap per frame, which is a trailing flick rather than a rubber band.
 * A step is 63% closed in one time constant, 95% in three (0.24 s) and 99% in
 * five (0.4 s), so the point is visually settled well inside the time it takes
 * to aim and click. The failure on the other side is worse: a time constant
 * anywhere near human reaction time would reintroduce the ratchet's symptom by a
 * different route, with the throw reading a point the player had already moved
 * off. 0.06 passes noticeably more jitter through, 0.10 trails more; 0.08 sits
 * between them. The jitter figure is checkable arithmetic rather than a
 * measurement — a first-order filter scales a noisy input's *variance* by
 * `alpha / (2 - alpha)`, which at 60 Hz is about 0.10, so roughly a third of the
 * amplitude survives.
 *
 * **Why world space, and what that costs.** The throw consumes a world point, so
 * that is the quantity worth smoothing; and the pixel-to-world mapping is not
 * linear, so smoothing screen pixels would move the world target by a different
 * amount depending on where on the screen the mouse was — worst near the horizon,
 * where one pixel is the most studs and where the jitter this exists to suppress
 * is at its largest.
 *
 * The cost is that the residual is a world-space *distance*, about `tau ×` how
 * fast the aim point is travelling. For a given rate of pointing that speed rises
 * with the distance to the aim point, so a given time constant costs a bigger lag
 * in studs — and therefore a bigger landing error — the further away the aim is.
 * The offset the *player sees* between cursor and marker does not grow the same
 * way: the pixels-per-stud scale falls at roughly the rate the lag rises, so on a
 * surface facing the camera the two cancel and the visible lag is set by `tau`
 * alone. Where they stop cancelling is near the horizon, where the surface turns
 * tangent and the mapping stops being linear. That is the trade this file makes:
 * smooth the quantity the throw actually uses, and let the lag be largest where
 * the points are furthest apart.
 */
const AIM_SMOOTHING_SECONDS = 0.03;

@Controller()
export class ThrowController implements OnStart {
	private readonly player = Players.LocalPlayer;
	private throwRemote?: RemoteEvent;
	private readonly guide = new AimGuide();

	// Scaffolding for tracking down jittery aim — see `reportJitter`.
	private lastMouse: Vector2 | undefined;
	private lastTarget: Vector3 | undefined;
	private lastMuzzle: Vector3 | undefined;
	private lastLanding: Vector3 | undefined;
	private lastMid: Vector3 | undefined;
	private nextReport = 0;

	/** The last arc report, so only a change at either end of it is printed. See {@link reportArc}. */
	private lastArcReport = "";

	/**
	 * The last `selected -> effective` arc pair. See {@link reportArcChoice} — this is the one
	 * diagnostic that distinguishes "the player changed throw" from "the game changed throw".
	 */
	private lastPlanArc = "";

	/**
	 * The smoothed aim point, and the clock reading it was last advanced from.
	 *
	 * The pair is the whole state of the smoothing: an exponential moving average
	 * needs the time since its previous sample in order to pick the step it takes
	 * now, and an absent {@link steadyTarget} is what says "there is nothing to
	 * average yet, snap". See {@link AIM_SMOOTHING_SECONDS}.
	 */
	private steadyTarget: Vector3 | undefined;
	private lastAimSample = 0;

	/**
	 * Which of the three throws the next click uses.
	 *
	 * X is the arcing throw: lofted off the hand and dropped onto the mark.
	 * C is the straight one: barely thrown at all, with gravity alone curving it
	 * down onto the same mark. V is the curveball: a straight throw with a
	 * sideways force on it, so it bows out to the left and swings back onto the
	 * same mark again. Different shapes, different flight times, same landing.
	 *
	 * **Starts on `straight`, and the server's fallback starts on the same word.** The guide is drawn
	 * from this on the first frame a ball is in the hand, before any arc key has been pressed, so a
	 * default that disagreed with the shape the throw would actually take would be a guide drawing a
	 * line the ball does not fly. The two are one decision in two places, and are kept in step by hand
	 * because they are on opposite sides of the wire.
	 */
	private arc: ThrowArc = "straight";

	onStart() {
		this.throwRemote = this.getThrowRemote();

		ContextActionService.BindAction(
			ACTION_NAME,
			(_actionName, inputState) => {
				if (inputState !== Enum.UserInputState.Begin) return Enum.ContextActionResult.Pass;

				// **A ball in the hand is what makes a click a throw.** The click is not shared with
				// anything any more — `CatchController` is `E` only — so this is no longer one half of a
				// contest over a button, just the plain test for whether there is anything to throw.
				// `Pass` rather than `Sink`, because a click that threw nothing has not been used up.
				const character = this.player.Character;
				if (!character?.FindFirstChild(BALL_NAME)) {
					return Enum.ContextActionResult.Pass;
				}

				const target = this.getSteadyAimTarget(character);
				if (DEBUG) print(`[Throw] throwing at ${target}`);
				// The launch point goes with the throw. The server's copy of the
				// character is a replication interval behind ours, and a plan solved
				// from a different launch point is a different curve — it still lands
				// on the mark, but it is not the line this client just drew.
				this.throwRemote?.FireServer(target, this.arc, getThrowMuzzle(character));
				return Enum.ContextActionResult.Sink;
			},
			false,
			Enum.UserInputType.MouseButton1,
		);

		RunService.RenderStepped.Connect(() => this.updateGuide());

		// X for the arcing throw, C for the straight one, V for the curveball. The
		// guide redraws with the new shape immediately, which is the only feedback
		// needed — the landing marker deliberately does not move.
		ContextActionService.BindAction(
			ARC_ACTION_NAME,
			(_actionName, inputState, input) => {
				if (inputState !== Enum.UserInputState.Begin) return Enum.ContextActionResult.Pass;

				const key = input.KeyCode;
				if (key === Enum.KeyCode.C) {
					this.arc = "straight";
				} else if (key === Enum.KeyCode.V) {
					this.arc = "curve";
				} else {
					this.arc = "overhead";
				}

				if (DEBUG) print(`[Throw] arc: ${this.arc}`);
				return Enum.ContextActionResult.Sink;
			},
			false,
			Enum.KeyCode.X,
			Enum.KeyCode.C,
			Enum.KeyCode.V,
		);
	}

	/**
	 * Redraws the predicted arc every frame while a ball is in hand, so you can
	 * see exactly where the throw is going before committing to it.
	 */
	private updateGuide() {
		const character = this.player.Character;
		const ball = character?.FindFirstChild(BALL_NAME);
		const isAiming = character !== undefined && ball !== undefined && ball.IsA("BasePart");

		// **The glow's flag is the guide's own visibility, published rather than worked out twice.**
		// It is set from the same expression that decides whether to draw, so the guide and the aim
		// glow cannot come to different answers about whether the player is aiming — which is the
		// whole reason it is published from here instead of `AimTargetController` deriving it for
		// itself. See `client/aiming.ts`. Set unconditionally, because a Fusion `Value` given the
		// value it already holds does nothing.
		aiming.set(isAiming);

		if (!character || !ball || !ball.IsA("BasePart")) {
			this.guide.hide();
			this.steadyTarget = undefined; // next ball starts aiming fresh

			// Nothing is being aimed, so nothing is predicted. Cleared rather than left alone for the
			// same reason the guide is hidden: the glow is driven by the flag those two share, and a
			// publish that stopped would leave the last answer standing for whoever read it next.
			predictedTarget.set(undefined);
			return;
		}

		// This is not an approximation of the arc — it is the same plan the
		// server will run when the click arrives, from the same origin.
		const target = this.getSteadyAimTarget(character);
		const plan = planPlayerThrow(character, target, this.arc);

		// Printed here rather than beside the landing report, because this is a fact about the plan
		// and nothing below it can change it. See `reportArcChoice` — a fallback is the whole of the
		// "the curve changed shape while I was aiming" fault.
		this.reportArcChoice(plan);

		// The guide itself is ignored as well as the thrower. Its own parts sit
		// right along this arc, and an arc that can hit the line drawn to
		// represent it will chase itself around the world.
		//
		// The radius matters: the ball bounces when its edge touches a surface, a
		// full half-diameter before its centre gets there. Tracing the centre
		// alone always marked the impact too far along.
		// The radius matters twice over: the guide sweeps a sphere the size of the
		// ball, and the solve above aimed the ball's *centre* a radius out so its
		// *surface* is what arrives on the mark.
		const arc = new Trajectory(plan.origin, plan.velocity, {
			ignore: [character, this.guide.instance, ...this.looseBalls()],
			radius: BALL_SIZE / 2,
			// The curve is a force, not a launch angle, so it has to be simulated
			// as well as applied. Same vector as the server's, taken from the same
			// plan, which is the only reason the drawn path can be trusted.
			acceleration: plan.acceleration,
		});

		// The jitter report is the noisiest thing in the game: it is built to fire whenever the drawn
		// path moves, and while somebody is aiming that is every frame. See
		// `shared/config/debug.config.ts`.
		if (DEBUG && DEBUG_CONFIG.VERBOSE_LOGS) this.reportJitter(target, getThrowMuzzle(character), arc);

		// **What the arc would hit, published for the glow.** The glow answers "what is my aim on",
		// and the honest answer is where this throw lands rather than what is under the crosshair —
		// those are two different lines and only one of them is the throw. See `AimTargetController`
		// for what the difference looked like from the player's seat.
		//
		// `arc.hit` is that answer, already computed here every frame: the first thing the ball's own
		// swept sphere meets, with the thrower, the guide and the loose balls excluded exactly as they
		// are for the drawn path. Computed once and used twice rather than worked out twice, which is
		// the same reason this file publishes the aiming flag.
		const arcTarget = this.hitModel(arc);
		predictedTarget.set(arcTarget);
		this.reportArc(arc, arcTarget);

		this.guide.update(arc.points, { position: arc.contact ?? arc.landing, normal: arc.normal });
	}

	/**
	 * The model a planned arc would hit, or nothing.
	 *
	 * **The rule for what counts as a target is unchanged, and only the line that finds it has.** The
	 * nearest `Model` above the hit part, with a `Humanoid` inside it: the first half says "this is a
	 * body rather than scenery", the second says the body is a character rather than a prop that
	 * happens to be assembled as a model. Both halves were the rule when the glow cast its own
	 * crosshair ray, and neither of them was why that was wrong.
	 *
	 * `FindFirstAncestorWhichIsA` starts at the *parent*, so a ball welded into somebody's hand still
	 * resolves to that model and lights them — it is their model, hanging where their body is. The
	 * arc sweeps through held balls rather than ignoring them, so a ball in front of a body is a hit
	 * on the body, which is also what the throw would do.
	 *
	 * A hit that is not a body is not a target, and that is the whole rule: a tree, a wall, the
	 * floor, the sky. This is the case that used to light a model through a trunk.
	 */
	private hitModel(arc: Trajectory): Model | undefined {
		const hit = arc.hit;
		if (!hit) return undefined;

		const model = hit.FindFirstAncestorWhichIsA("Model");
		if (!model || !model.FindFirstChildWhichIsA("Humanoid")) return undefined;

		return model;
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
	 * Diagnostic scaffolding, in the same spirit as the `[Aim] ray:` line it replaces. Delete once the
	 * glow is trusted.
	 */
	private reportArc(arc: Trajectory, target: Model | undefined): void {
		const contact = arc.contact;
		const hit =
			arc.hit && contact
				? `${arc.hit.GetFullName()} at ${math.floor(contact.sub(arc.origin).Magnitude)} studs`
				: "nil";
		const report = `${hit} -> ${target ? target.Name : "nil"}`;
		if (report === this.lastArcReport) return;

		this.lastArcReport = report;
		if (DEBUG) print(`[Aim] arc: ${report}`);
	}

	/**
	 * Reports when the plan's arc is not the arc the player selected.
	 *
	 * **The one fault in the preview that nothing on screen can show you, and the one nothing else
	 * here prints.** `straight` and `curve` both quietly become an `overhead` throw when the aim
	 * point sits above the flat launch line: `flatLaunchSpeed` has no fall to solve with, so
	 * `planPlayerThrow` swaps the entire throw rather than miss. Nothing in the guide's drawing
	 * knows — it draws whatever plan came back — so from the player's seat the curve changes shape
	 * mid-aim as though the throwing style had changed underneath them. It has, and this line is
	 * where that is visible.
	 *
	 * **Both halves of the pair, because the two fallbacks are different faults.** `straight ->
	 * overhead` is a flat throw replaced by a lob. `curve -> overhead` is worse: the curve carries
	 * its bow as an *acceleration*, and a throw that is no longer flat arrives with that left at
	 * zero, so the bend disappears as well as the shape. Printing the pair rather than the effective
	 * arc alone is what keeps those two apart in the log.
	 *
	 * On change rather than per frame: the plan is rebuilt every frame and its mode is steady across
	 * a whole sweep of the aim. Diagnostic scaffolding — delete once the fallback is fixed or
	 * trusted.
	 */
	private reportArcChoice(plan: LaunchPlan): void {
		const report = `${this.arc} -> ${plan.arc}`;
		if (report === this.lastPlanArc) return;

		this.lastPlanArc = report;
		if (DEBUG) print(`[Throw] plan: ${report}${plan.arc === this.arc ? "" : " — FELL BACK"}`);
	}

	/**
	 * Scaffolding for tracking down jittery aim. Only fires when the mouse is
	 * still, so anything it reports is genuine jitter rather than you aiming.
	 *
	 * Read it as a bisection.
	 *
	 * - `target` moving means the aim raycast is landing somewhere different each
	 *   frame. That is mouse-side, and it is what `AIM_SMOOTHING_SECONDS` exists to
	 *   absorb — note this reports the *smoothed* point, so whatever still moves
	 *   here is exactly what a throw at this instant would be aimed at.
	 * - A steady `target` with a moving `muzzle` means the launch point is
	 *   drifting underneath it. The solve absorbs that, so the landing stays put
	 *   while the arc swings — which is exactly the whole-line wobble, and why
	 *   `mid` exists: a point in the middle of the path catches a line that is
	 *   moving without its ends moving.
	 * - Steady `target` and `muzzle` with a moving `landing` means the arc
	 *   simulation itself is at fault, and then `points` and `hit` matter — an arc
	 *   that never collides runs to `maxTime` and reports mid-air as its landing.
	 */
	private reportJitter(target: Vector3, muzzle: Vector3, arc: Trajectory) {
		const mouse = UserInputService.GetMouseLocation();
		const still = this.lastMouse !== undefined && mouse.sub(this.lastMouse).Magnitude < 0.5;

		// The middle of the path: the honest test for "the whole line moved".
		const mid = arc.points[math.floor(arc.points.size() / 2)];

		// Rate limited. This fires every frame the path moves, and printing
		// thousands of lines a second costs real frame time in Studio — which
		// would make the very stutter it is trying to measure worse.
		const now = os.clock();
		if (
			still &&
			this.lastTarget &&
			this.lastMuzzle &&
			this.lastLanding &&
			this.lastMid &&
			now >= this.nextReport
		) {
			const landingJump = arc.landing.sub(this.lastLanding).Magnitude;
			const midJump = mid.sub(this.lastMid).Magnitude;
			if (math.max(landingJump, midJump) > 0.2) {
				this.nextReport = now + 0.5;
				const jump = (to: Vector3, from: Vector3) => string.format("%.2f", to.sub(from).Magnitude);
				print(
					`[Aim] landing +${jump(arc.landing, this.lastLanding)}` +
						` | mid +${jump(mid, this.lastMid)} | target +${jump(target, this.lastTarget)}` +
						` | muzzle +${jump(muzzle, this.lastMuzzle)} | points ${arc.points.size()}` +
						` | hit ${ThrowController.describeHit(arc)}`,
				);
			}
		}

		this.lastMouse = mouse;
		this.lastTarget = target;
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
	 * The aim point, smoothed toward the live one on a clock rather than held
	 * near it on a threshold.
	 *
	 * Used by both the guide and the throw itself, so what you see is what you
	 * get — if the click read a fresh raycast while the guide showed a smoothed
	 * one, the ball would land somewhere other than the marker.
	 *
	 * **The throw reads this, so its residual is a landing error.** The value kept
	 * here is the one the solve is run against, which is why
	 * {@link AIM_SMOOTHING_SECONDS} is short: whatever the point has not caught up
	 * with by the time the click arrives is thrown at, not merely drawn at.
	 *
	 * The first sample after there is nothing to average from snaps rather than
	 * easing in. `updateGuide` clears {@link steadyTarget} whenever there is no
	 * ball in hand, so this includes picking a new ball up, and starting from a
	 * guessed origin instead would show as the marker flying in from wherever the
	 * previous ball was thrown.
	 */
	private getSteadyAimTarget(character: Model | undefined): Vector3 {
		const fresh = this.getAimTarget(character);
		const held = this.steadyTarget;

		if (held === undefined) {
			this.steadyTarget = fresh;
			this.lastAimSample = os.clock();
			return fresh;
		}

		const now = os.clock();
		// The interval has to be read *before* the clock is moved on, or `dt` is
		// always zero and the filter never advances. A zero-length interval is two
		// calls inside one frame — the guide's and the click's — and gives `alpha`
		// 0, returning the point unchanged, which is the right answer: no time
		// passed, so nothing moved.
		const dt = now - this.lastAimSample;
		this.lastAimSample = now;

		const alpha = 1 - math.exp(-dt / AIM_SMOOTHING_SECONDS);
		const smoothed = held.Lerp(fresh, alpha);

		this.steadyTarget = smoothed;
		return smoothed;
	}

	private getAimTarget(character: Model | undefined): Vector3 {
		const camera = Workspace.CurrentCamera;
		if (!camera) {
			return character
				? character.GetPivot().Position.add(new Vector3(0, 0, -AIM_DISTANCE))
				: new Vector3(0, 0, -AIM_DISTANCE);
		}

		const mouse = UserInputService.GetMouseLocation();
		const ray = camera.ViewportPointToRay(mouse.X, mouse.Y);

		// Ignore the thrower, so aiming over your own body doesn't put the
		// target at your feet.
		const params = new RaycastParams();
		params.FilterType = Enum.RaycastFilterType.Exclude;
		params.FilterDescendantsInstances = character ? [character] : [];
		params.IgnoreWater = true;

		const hit = Workspace.Raycast(ray.Origin, ray.Direction.mul(AIM_DISTANCE), params);
		return hit ? hit.Position : ray.Origin.add(ray.Direction.mul(AIM_DISTANCE));
	}
}
