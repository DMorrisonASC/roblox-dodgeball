import Fusion from "@rbxts/fusion-3.0";
import { CollectionService, Players, Workspace } from "@rbxts/services";
import { AIM_CONFIG } from "shared/config/aim.config";
import { NPC_TAG } from "shared/constants";
import { ChargeRequest, getThrowMuzzle, planChargedThrow } from "shared/throw";
import { aimSessionStartedAt } from "./aiming";
import { isMobile } from "./platform";
import { inTaggedZone, isParticipant, sideOfBody, SideLabel } from "./roundZone";

/**
 * **A pull toward a predicted lead point, for the client whose aim is a thumb rather than a mouse.**
 *
 * *"Mobile players find aiming hard, and the difficulty is the input surface rather than the throw model."*
 * That is the whole of what this file answers, and the sentence that keeps it small: nothing here changes the
 * throw, the solve, the cap or the wire — it moves **the one aim point** a mobile client was already computing,
 * before `planChargedThrow` reads it.
 *
 * **One aim point, and that is the constraint the design is arranged around.** `ThrowController.aimPoint`
 * casts a ray and gets a place; `ThrowController.chargeRequest` puts that place in the request both the
 * preview and the wire are built from — so the arc drawn and `ChargeRequest.aim` are the *same value* by
 * construction rather than two values that agree. This file therefore has exactly one job and one seam: take
 * the point the cast produced, and return the point the throw should use. **A second point is the failure
 * this file must not have** — a `pulledAim` kept beside an `aim`, or a preview still reading the pre-pull
 * value, would recreate the class of bug the aiming work was done to end. There is deliberately no export
 * that returns the raw and the pulled point together, because the next reader would have a choice to make.
 *
 * **What it is not: a change to where a throw can go.** The pull is a point, and `reachTo` is still the thing
 * that decides the hold from it — so the assist can change the bearing and the range the cap is measured
 * against, and it can never buy reach. A body beyond the hold's reach still lands short, along the line the
 * pull chose. See `shared/throw.ts` for the cap and for why it is "a cap and never a solve".
 *
 * ## The latch: one body per aim, and no re-pick within a hold
 *
 * **The point is latched to a *body*, not re-chosen every frame.** `ThrowController` builds a request in the
 * frame loop and again at the release, so a picker with no memory would let a body entering the cone on the
 * release frame — or two candidates trading the nearest slot — hand the throw a different target from the one
 * the player watched. The latch is keyed on the **aim session** (`AssistRequest.session`, which is
 * `aiming.ts`'s `aimSessionStartedAt`) and lives until that session ends, and **a latch that drops inside a
 * hold is dropped for the rest of that hold**: the body it named is destroyed, leaves the world, or stops
 * being eligible, and the assist turns *off* rather than choosing somebody else. What the player watched stops
 * being what they throw either way, and "no assist" is the only version of that which is not a lie.
 *
 * ## Aiming before the button — the aim session, and why the hold stopped being the unit
 *
 * **The latch used to be keyed on the charge, and that was right while the assist only ran during one.** The
 * hold was then the unit of aiming: a body was picked when the button went down and never re-picked, so the
 * arc drawn and the throw sent could not name two different bodies. It also meant the assist was invisible
 * until the player committed — they had to guess where it would take them and press to find out, which on a
 * touch screen is the whole complaint, because the press is the same finger that is aiming.
 *
 * **So the unit is now the *aim session*: the span in which the player is in the round and alive.** That last
 * clause is a correction to the first version of this section, which said "has a ball in hand": opening the
 * session on the ball made the camera wait for one, which is the opposite of an assist — the moment a player
 * wants to know where the enemy is is the moment *before* they pick a ball up. `ThrowController` opens a session
 * when the assist may act and closes it on a death or the round ending, the latch is keyed on it, and the
 * camera's follow answers for as long as it is the live one. A player who is merely looking at an enemy therefore
 * gets the target chosen and the view turned onto it, and turning onto it is the *only* thing a pre-charge assist
 * can honestly do: **on a touch client the aim point is the camera's own axis**
 * (`ThrowController.getThrowDirection`), so "pull the aim point toward the lead before the hold" and "turn the
 * camera toward the body" are the same act, and inventing a pulled point with no throw behind it would be the
 * second aim this file exists to refuse.
 *
 * **The no-re-pick rule still holds inside a hold and only inside one.** Outside a hold nothing has been drawn
 * from the target yet, so a body that dies or takes cover between one frame and the next is simply re-picked —
 * which is what any player watching an aim assist expects of it. **The player turning away is the other half of
 * that, and it is geometry rather than input plumbing**: an uncharged latch is dropped as soon as the body
 * leaves the cone, so the camera lets go the moment somebody looks elsewhere. See `stillEligible`, which owns
 * that rule and the argument for why a hold turns it off. Inside a hold the property above still applies,
 * unchanged: the first body of the hold is the body of the throw.
 *
 * **What that costs, and the throttle is the whole of it.** A session now lasts a whole round rather than a
 * hold, so the scan runs for that long — still at `AIM_CONFIG.TARGET_UPDATE_HZ`, still one
 * `GetTagged(NPC_TAG)` walk per tick and never one per frame, and still only on a mobile client that is alive and
 * in the round. The per-frame half is the latch's re-validation (`stillEligible`), which is attribute reads, one
 * angle comparison and at most one ray — the same work a charging client already did every frame. **The window
 * being a round rather than a hold is the real cost of running without a ball**, and it is named here rather than
 * discovered: a mobile client now pays the scan and the aim cast for the whole of a round instead of the stretches
 * it spent holding a ball. What it does not pay is a new *kind* of work — every item in that list was already on
 * the per-frame path before, just less of the time.
 *
 * **`latchedTarget()` is the whole of what leaves this file for the camera**, and it answers nothing unless
 * the latch belongs to the aim session running right now — see its own doc for why the *query* is where the
 * session is checked, rather than a second "the aim ended" write somewhere in this file.
 *
 * ## Desktop is untouched, verified by construction
 *
 * **The first line of {@link assistedAim} returns the caller's own value when `isMobile()` is false**, before
 * any ray, tag walk or clock read — so a desktop client cannot reach the picker at all and its aim point is
 * bit-for-bit the one `aimPoint` produced. That is acceptance criterion 2, and it is a property of the order
 * of the guards rather than of a test. **{@link watchAim} makes the same first-line refusal**, so the
 * pre-charge half is desktop-free by the same construction rather than by a second gate in the caller.
 *
 * ## The four things that have to be true for a target, and each is a separate refusal
 *
 * 1. **It has to be a body this throw could legitimately hit**, which is a *side* question in a round and a
 *    *tag* question in a practice zone — see {@link inMode}. Those are the only two places a throw is worth
 *    assisting: a round is where the opposing side is, and a practice zone is the other place the game lets
 *    you throw at a rig. **A throw is possible in the lobby too** — `ThrowController.cancelCharge` says so at
 *    length, and nothing gates a throw on the phase — but there is nobody there the assist should pull at,
 *    so the third case is deliberately "no targets" rather than a rule.
 * 2. **It has to be in the cone**, measured *horizontally* off the throw's own heading — see {@link pick}.
 * 3. **It has to be in sight**, one raycast from the muzzle that must reach the body before anything else.
 * 4. **It has to have a root**, because the prediction reads a position and a velocity off one.
 */

/** Prints when a hold latches a target and when a latch drops. Never a line per frame. */
const DEBUG = false; // off for frame time — see shared/config/debug.config.ts

/**
 * What the caller has, handed over once so this file cannot read the same facts a frame apart.
 *
 * **An options object rather than six positional arguments**, for the reason `RoundService`'s
 * `TransitionOptions` gives: several of these are `Model`/`Vector3`/`boolean` and two of them could be
 * swapped without the compiler saying a word. The fields are the throw's own inputs rather than anything
 * this file invents — `charge`, `curve` and `heading` are here only so the probe plan below is built from
 * the *same* request shape the real throw is, which is what makes its flight time the throw's own.
 */
export interface AssistRequest {
	/** The body doing the throwing. Excluded from the search and used for the muzzle. */
	readonly character: Model;
	/**
	 * **The point the aim cast produced — the pre-pull point**, or nothing when the cast hit nothing.
	 *
	 * The name says *raw* rather than *unassisted* deliberately: what comes back from
	 * {@link assistedAim} is a different point and it is the only one anybody downstream should see.
	 */
	readonly raw: Vector3 | undefined;
	/** The throw's heading, unflattened, exactly as `getThrowDirection` returned it. */
	readonly heading: Vector3;
	/** The hold as a fraction, for the probe plan's flight time. */
	readonly charge: number;
	/**
	 * **The instant this hold began, or nothing when the player is aiming without holding the button** — as
	 * `client/throwing.ts`'s `chargeStartedAt` stood when the request was built.
	 *
	 * **It is no longer the latch's key; {@link session} is.** What this still decides is the *no-re-pick
	 * window*: a latch that drops while this is a number stays dropped until the hold ends, and a latch that
	 * drops while it is `undefined` is re-picked on the next frame because nothing has been drawn from it yet.
	 * See the file doc's "Aiming before the button". The value itself is not compared to anything — only its
	 * presence matters — and this doc used to describe it as a key, which is what the split changed.
	 *
	 * **It has to be passed rather than read from that value here, and the release is why.**
	 * `ThrowController.releaseThrow` clears `chargeStartedAt` *before* it builds the request it sends, so a read
	 * at this end would see "no hold" on the one frame the no-re-pick rule matters most and would let the
	 * release re-pick a target — the defect this field exists to close.
	 */
	readonly hold: number | undefined;
	/**
	 * **The aim session this request belongs to — `aiming.ts`'s `aimSessionStartedAt` — and the key the latch
	 * is held under.**
	 *
	 * Carried in the request rather than peeked inside this file for the reason every other field is: the request
	 * is one value describing one aim, built once by `ThrowController.assistInputs` for all three callers, and a
	 * lookup at read time would be a second reading of a fact the caller already had. **The release always sees
	 * it live** — the session now lasts a whole round rather than a hand — so nothing here depends on an
	 * ordering trick the way {@link AssistRequest.hold} does; it is passed because that is the one construction,
	 * not because of a race.
	 *
	 * A session that does not match the latch's is a different aim, and the latch is replaced rather than
	 * inherited. `undefined` is the honest state of a caller with no aim session open — dead, in the lobby, out
	 * of the round — and it gets no assist at all; see `assistedAim`.
	 */
	readonly session: number | undefined;
	/** Whether the ball bends, for the same reason. */
	readonly curve: boolean;
	/**
	 * **Everything the aim's own raycasts ignore: the thrower, the guide, and every loose ball.**
	 *
	 * Handed in rather than rebuilt, and it has to be the *same list* rather than an equal one: the guide's
	 * parts sit along the arc between the hand and the aim, so the sight test below would read the player's own
	 * preview as cover and refuse every body it was drawn towards. `ThrowController.aimExclusions` is the one
	 * place the list is written; this is its second reader.
	 */
	readonly ignore: ReadonlyArray<Instance>;
}

/**
 * The bodies worth pulling towards, as of {@link scan}, and when that scan last ran.
 *
 * **A list and a timestamp rather than a subscription, and the cost is the reason.** `CollectionService`
 * answers about the whole DataModel, so the set of rigs is a walk; doing that walk on the aim's own per-frame
 * clock would be a `GetTagged(NPC_TAG)` sixty times a second for the length of every hold, which is the shape
 * `HANDOFF.md` §15 item 19 suspects of the client's boot cost. The walk happens at
 * `AIM_CONFIG.TARGET_UPDATE_HZ` instead — the constant that was kept as "the number to start from if the
 * design comes back" — and *only while the aim session is open*, because the two callers (`assistedAim` and
 * `watchAim`) are both reached from `ThrowController`'s frame loop under that condition and neither runs
 * otherwise. That condition is "alive and in the round" since 2026-10-21; it used to be "holding a ball", which
 * is why the section above had to grow a paragraph about it. Nothing here runs at boot.
 *
 * **The window has now been narrow twice and wide once.** It began as "while a mobile client is charging a
 * throw" — a fraction of a second at a time — then became "while a ball is in the hand", and is now the round.
 * What has never moved is the *rate*: the tick is the throttle, and widening the window changes how long it runs
 * for and not how often.
 *
 * **What the staleness costs, stated rather than hidden.** Membership can be up to one refresh behind: a rig
 * that is spawned or comes into sight mid-aim is assisted from the next tick, and one that dies or takes
 * cover stops being assisted from the next tick. Positions and velocities are *not* cached — they are read
 * off the body every frame — so the lead point is never stale; only the answer to "who is a candidate".
 */
let targets = new Array<Model>();
let scannedAt = -math.huge;

/**
 * **Which rule the last scan ran under: a round's sides, a practice zone's rigs, or neither.**
 *
 * **Stored rather than derived at each question, because two different readers ask it at two different times.**
 * `scan` fills it; `inMode` — which both the scan and the latch's per-frame validation go through — reads it.
 * The alternatives were to pass it down as an argument through three functions, or to re-ask `inRound` and
 * `inTaggedZone` per frame, and the second is the one that matters: `inTaggedZone` walks a tag, so asking it
 * on the aim's clock is exactly the cost this file's throttled scan exists to avoid.
 *
 * `{ kind: "round", mine }` carries the local player's side because "an opponent" is a comparison, not a
 * lookup — see `inMode`.
 */
type AssistMode =
	| { readonly kind: "round"; readonly mine: SideLabel }
	| { readonly kind: "zone" }
	| { readonly kind: "none" };
let mode: AssistMode = { kind: "none" };

/**
 * **The body this aim is pulling towards, the aim it belongs to, and the two pieces of state a lead needs —
 * the latch.**
 *
 * `session` is `AssistRequest.session`'s value: a latch whose session does not match the request in hand
 * belongs to an aim that is over and is replaced, which is the whole of what ends an aim. `model` is absent
 * until the first eligible body is found, which is why a target that walks into the cone mid-aim can still be
 * taken — **that is a first pick, not a re-pick**, and the difference is `dropped`.
 *
 * **`dropped` is the whole of "never pick again this hold".** Once a latched body stops being eligible the
 * model is cleared and this goes true, and the assist stays off until the hold ends or the aim does. Clearing the
 * model alone would let the next frame choose somebody else, which is the drawn-versus-thrown disagreement this
 * latch exists to end. **The hold is not stored here**, because it is not a property of the latch: whether one is
 * running is `AssistRequest.hold` on the call in hand, and storing a copy would be a second thing to keep in step
 * with it — the mistake `ShiftLock`'s docs make a principle of.
 *
 * **`velocity` and `velocityAt` are the smoothed velocity a player target's lead is computed from**, and they
 * live here rather than in a table keyed by model for the one reason that matters: only the latched body is
 * ever led, so a map would be state for bodies nothing reads. `velocityAt` is `os.clock` of the last sample and
 * is what makes the filter frame-rate independent — see `leadVelocity`.
 */
interface Latch {
	readonly session: number;
	model?: Model;
	dropped: boolean;
	velocity?: Vector3;
	velocityAt: number;
}
let latch: Latch | undefined;

/**
 * The last thing printed, so a report is an edge rather than a stream.
 *
 * The same shape `AimTargetController.lastAiming` uses and for the same reason: this runs on every frame of
 * every hold on every mobile client, and a line a frame buries the one line a Studio session is looking for.
 */
let lastReport = "";

/**
 * The aim point the throw should use: **the point the cast produced, pulled towards the lead of a body.**
 *
 * Returns the caller's own value on a desktop client, on a client whose cast hit nothing, on a mobile client
 * with no eligible target, and on a mobile client whose latched body dropped earlier in the same hold — so
 * "no assist" is always the *unchanged* point rather than a substitute one, and every one of those cases falls
 * back to exactly the throw the game had before this file existed.
 *
 * **The prediction is two passes of a fixed point, and the second one is exact — not a better approximation.**
 * The lead is `root + velocity × flight`, and the flight is the throw's own —
 * `planChargedThrow(...).flightTime`, which is `reachTo`'s answer for the point handed in. **The pull moves the
 * point, so it moves the flight, so it moves the lead**, and one pass therefore leads from a flight the throw
 * will not have:
 *
 * 1. flight to the *raw* point → lead → pull;
 * 2. flight to the *pulled* point → lead → pull again, and that second pull is the answer.
 *
 * **Why pass two is the last one, from the code rather than from a tolerance.** The lead's `Y` is the body's
 * root whichever pass computed it, because `leadVelocity` drops the vertical component of the velocity and
 * `root.Position.add(velocity.mul(t))` therefore has `root.Y` for any `t`. So the pulled point's height is
 * `raw.Y + strength · (root.Y − raw.Y)`, which **does not depend on the flight at all** — it settles on the
 * first pull and never moves again. And the flight depends only on that height (`chargedFlight` reads
 * `delta.Y` and nothing else). So pass two is handed the flight the final point really has, and a third pass
 * would read the same number back and return the same point. **Two is the number of passes the shape needs**,
 * which is a better reason than "two is cheap".
 *
 * **What pass one was wrong about, and the prompt for this change named the wrong mechanism.** It said the
 * pull changes the *distance*, so the flight moves with it. It does not: `reachTo` divides no distance by a
 * speed, it solves `v_y·t − ½·g·t² = rise` for the **height** difference between the muzzle and the point. The
 * error pass one carried is therefore a height error — with `BALL_GRAVITY` at `50` and the peak at `0.5`, a
 * cursor resting on the floor about four and a half studs below the hand is led by `~0.59 s`, while the time to
 * reach a body's root two and a half studs down is `~0.49 s`: roughly a fifth more lead than the throw needs.
 * Aiming *on* the body was already right, which is why the fault showed up as a lead that missed when the thumb
 * was past the target rather than on it.
 *
 * **The cost is one extra `planChargedThrow` per frame on a mobile client with a target.** That function is
 * arithmetic — `chargeForRange`, `peakAngle`, one `velocityAtAngle` — with no raycast in it, and it is already
 * called once a frame by the preview. Doubling it is cheaper than the `Trajectory` sweep the same frame does,
 * and it only happens when a body is actually latched.
 */
export function assistedAim(request: AssistRequest): Vector3 | undefined {
	// **The desktop guarantee, first, before anything is read.** See this file's doc: a client that is not
	// mobile cannot reach the picker, so its aim is the value the cast produced, unchanged.
	if (!isMobile()) return request.raw;

	// **A cast that hit nothing has no distance to be pulled from**, and inventing one (the camera's focus, a
	// point along the ray) would be a second aim point. The throw already has an answer for it: no aim at all,
	// which `planChargedThrow` reads as "use the held charge and the camera's bearing".
	const raw = request.raw;
	if (raw === undefined) return raw;

	// **A request that cannot name its aim gets no assist, rather than a latch keyed on nothing.** The latch is
	// per aim session, and a caller that could not say which aim this is cannot be given a body that outlives
	// one. Only `releaseThrow` can reach this, and only if it were ever called with no session open — see
	// `session`.
	if (request.session === undefined) return raw;

	// **The scan runs before the latch is looked at, so the latch is validated against the world as it is now.**
	// Its own refresh is inside it; this call is the aim's clock reaching the throttled one.
	scan(request.character, request.ignore);

	// **One body for the whole hold, or none.** See the file doc and `latchFor`: this is the one place a target
	// is chosen, and it is reached only when nothing is latched yet or the latch belongs to a finished aim.
	const chosen = latchFor(request, raw);

	// **A drop reports itself, in its own words**, and this line is why the answer carries the flag: the drop
	// line and an "off — no eligible body" line a frame apart would be one event told twice, in two vocabularies,
	// and the second would be a lie about *why*.
	if (!chosen.dropped) report(chosen.model);

	const target = chosen.model;
	if (target === undefined) return raw;

	const root = rootOf(target);
	if (root === undefined) return raw;

	const muzzle = getThrowMuzzle(request.character);

	// **The horizontal velocity and only that**, for the reason `leadVelocity` gives at length: the lead is
	// where the body's feet will be, and the throw's own arc is what carries the ball up to it.
	const velocity = leadVelocity(root, target);

	// **The first pass, from the flight to the point the player actually aimed at.** See this function's doc.
	const firstFlight = flightToPoint(request, muzzle, raw);
	const firstLead = root.Position.add(velocity.mul(firstFlight));
	const firstPull = raw.Lerp(firstLead, AIM_CONFIG.AIM_ASSIST_STRENGTH);

	// **And the second, from the flight to the point the first pass produced** — the one ask the previous
	// version of this function named as an approximation and then declined to make.
	const secondFlight = flightToPoint(request, muzzle, firstPull);
	const secondLead = root.Position.add(velocity.mul(secondFlight));

	return raw.Lerp(secondLead, AIM_CONFIG.AIM_ASSIST_STRENGTH);
}

/**
 * **The flight time the throw would really take to arrive at `aim`** — the throw's own arithmetic, asked of the
 * same solve the throw uses rather than estimated here.
 *
 * A function so that {@link assistedAim}'s two passes cannot be two different questions: both build the same
 * {@link ChargeRequest} the wire will carry, change only the point, and read `flightTime` off the plan. Nothing
 * else about the plan is used, and nothing is cached — the number depends on the point, which moves every frame.
 *
 * **`request.charge` and not the capped charge**, because the cap is what `planChargedThrow` computes *from*
 * the point: handing it the held charge is exactly what the real throw does, and reading the capped value out
 * of the first pass to feed the second would be this file deciding the cap instead of `reachTo`.
 */
function flightToPoint(request: AssistRequest, muzzle: Vector3, aim: Vector3): number {
	const probe: ChargeRequest = {
		heading: request.heading,
		charge: request.charge,
		curve: request.curve,
		aim,
	};

	return planChargedThrow(request.character, probe, muzzle).flightTime;
}

/**
 * The velocity a lead is computed from, **flattened to the ground plane.**
 *
 * **`AssemblyLinearVelocity` rather than `Humanoid.MoveDirection × WalkSpeed`, and the two bodies are why.**
 * `MoveDirection` is a *request*: for a player it is the input the humanoid is being asked to walk in, and for
 * a rig it is whatever a behaviour last handed `MoveTo` — neither of which includes a dodge's `LinearVelocity`,
 * a knockback, a conveyor, or the fact that a rig on a curve is aimed off its own line. `AssemblyLinearVelocity`
 * is the engine's answer to "where is this assembly going", which is the question a lead asks, and it covers
 * both kinds of body without a branch: a rig moved by `MoveTo` and a player moved by input are both moved by the
 * humanoid in the end, and the physics assembly reports what actually happened.
 *
 * **Y is dropped deliberately, and it is not a shortcut.** The throw's vertical is decided by
 * `CHARGE_PEAK_HEIGHT` — `v_y = sqrt(2·g·h)` is the same at every charge, so every throw hangs for the same
 * `2·v_y/g` (about 0.28 s back to the hand's own height at the shipped `g = 50`, `h = 0.5`, and about 0.49 s to
 * a body's root below it; the two are unrelated to `CHARGE_SECONDS`, which only decides how fast the ball goes
 * horizontally) — so where the body will be *vertically* at the end of the flight is not something the thrower
 * can influence; what a lead can correct is the horizontal walking. Keeping Y would also let a jumping body's
 * zero vertical velocity at the apex drag the aim point down, which is a lead point below the body the player
 * is looking at.
 *
 * **What this is not: a prediction of a dodge.** A body that dodges during the flight moves somewhere this
 * cannot know, and a lead that pretended to would be a second guess stacked on a first. The assist is for a
 * thumb that is close but not exact, not for reading an opponent's mind.
 *
 * **A player's velocity is smoothed and a rig's is not, and the difference is who simulates the body.**
 * `AssemblyLinearVelocity` is the right *quantity* for both — the argument above is unchanged — but it is a
 * different *kind of number* for the two, and the prompt that asked for this had it right: a rig's assembly is
 * owned and stepped by the server, so what arrives here is the velocity the game actually moved it with; a
 * player's assembly is owned by that player's client, so what arrives here is that machine's physics after a
 * replication delay and whatever correction the server applied to it. On a target walking in a dead straight
 * line the second one jitters by a stud or two per frame, and a lead computed from it shakes — which reads, to
 * the player, as an assist that cannot make up its mind.
 *
 * **The filter is on the sample, not on the body.** One exponential average per latched body, weighted by
 * `1 − e^(−dt/τ)` so the smoothing is the same 0.12 s of memory at 30 fps and at 240 — see
 * `AIM_CONFIG.AIM_ASSIST_VELOCITY_SMOOTHING_SECONDS` for the constant and its cost. It does not predict a
 * dodge, does not know about walls, and does not smooth a rig at all: `Players.GetPlayerFromCharacter` is the
 * branch, and it is the same test `inMode` uses to tell a rig from a person.
 *
 * **Two alternatives were considered and rejected, both on purpose.** `Humanoid.MoveDirection × WalkSpeed` is
 * the obvious "smoother" source and is the wrong *quantity*: it is the walk the humanoid was asked for, so it
 * is zero during a dodge (which is a `LinearVelocity`), zero during a knockback, and wrong on a conveyor —
 * every case where the target is moving the way a lead matters. A fixed blend factor instead of a time
 * constant would smooth twice as hard on a client running twice as fast, which is a filter tuned by the
 * hardware. The state lives on the latch rather than in a table keyed by model because only the latched body
 * is led, so a table would be state for bodies nothing reads.
 */
function leadVelocity(root: BasePart, target: Model): Vector3 {
	const sampled = root.AssemblyLinearVelocity;
	const flat = new Vector3(sampled.X, 0, sampled.Z);

	// A rig, which needs no filter — see the doc above for why that is a fact about ownership rather than a
	// shortcut. The smoothing is deliberately behind this branch, so a rig never seeds the latch's state.
	if (Players.GetPlayerFromCharacter(target) === undefined) return flat;

	const tau = AIM_CONFIG.AIM_ASSIST_VELOCITY_SMOOTHING_SECONDS;
	if (tau <= 0) return flat;

	// The latch this body is held in. It is the module's own rather than a parameter because `latchFor` has
	// just decided it and a second copy passed through would be a second thing that could disagree; the guard
	// is the honest refusal for the one case it cannot be this body (a target whose root changed between the
	// pick and this line).
	const held = latch;
	if (held === undefined || held.model !== target) return flat;

	const now = os.clock();
	const previous = held.velocity;

	// **The first sample is taken whole rather than eased in from zero**, which is the one thing a filter like
	// this gets wrong most often: seeding it with nothing would under-lead a body that was already walking when
	// the latch took it, and it would take `tau` of a throw to recover.
	const elapsed = previous === undefined ? 0 : now - held.velocityAt;
	const weight = previous === undefined || elapsed <= 0 ? 1 : 1 - math.exp(-elapsed / tau);
	const smoothed = previous === undefined ? flat : previous.Lerp(flat, weight);

	held.velocity = smoothed;
	held.velocityAt = now;

	return smoothed;
}

/**
 * The one body to pull towards, or nothing — **the cone, then the nearest to the point the player aimed at.**
 *
 * **The cone is measured horizontally off the throw's own heading, and both halves of that are decisions.**
 * The heading is what `getThrowDirection` returned, so the cone is centred on the line the throw is actually
 * being sent along rather than on a second reading of the camera; and it is *flattened* because the vertical
 * is the charge's business, not the player's — a player aiming at a body's feet is looking steeply down, and a
 * three-dimensional cone would call that body hundreds of degrees away from the crosshair. This is the same
 * reading `planChargedThrow` makes when it projects the heading, and the same one `AimFacingController` makes
 * for the body's facing.
 *
 * **Nearest to the raw point rather than nearest to the player, or to the axis.** The assist exists to correct
 * a thumb that is *close*, so the body the player is aiming *near* is the one to help with: a rig across the
 * arena that happens to sit on the same bearing loses to a rig standing at the marker, which is what stops a
 * distant body dragging a short throw long. **What it does not do is bound the pull's distance** — a body
 * beyond the hold's reach still wins if it is the only candidate in the cone, and the cap then lands the ball
 * short along the bearing the pull chose. That is the same answer the game gives a cursor pointed past the
 * target, so it is accepted rather than special-cased.
 *
 * **The axis being the *throw's* heading rather than the camera's forward is a deliberate deviation from the
 * spec this was built to**, which asked for "a cone off the custom shift lock's forward ray". On a mobile
 * client the two are the same value today — `getThrowDirection` returns `camera.CFrame.LookVector` there — so
 * the deviation is invisible now and will stay invisible only while that holds. It is taken because the
 * heading is the line the ball will actually leave on: it is the vector `planChargedThrow` flattens and the one
 * `reachTo` measures its bearing from, so a cone drawn off the view would be a second opinion about which
 * bodies are in the way. **`ShiftLock.followTarget` is the reason this matters**: it turns the camera towards
 * the latched body, which moves the heading too — the cone follows the throw, and the throw follows the view,
 * rather than the two being kept in step by hand.
 */
function pick(request: AssistRequest, raw: Vector3): Model | undefined {
	if (targets.size() === 0) return undefined;

	const muzzle = getThrowMuzzle(request.character);
	const axis = flatUnit(request.heading);
	if (axis === undefined) return undefined;

	const halfAngle = math.rad(AIM_CONFIG.AIM_ASSIST_CONE_HALF_DEGREES);

	let best: Model | undefined;
	let bestDistance = math.huge;

	for (const model of targets) {
		// **A body that has left the world since the scan is skipped, not just at the scan.** Membership is up to
		// one refresh old, and a rig destroyed in between is still in the list; nothing about its last position is
		// worth pulling towards.
		if (model.Parent === undefined) continue;

		const root = rootOf(model);
		if (root === undefined) continue;

		const bearing = flatUnit(root.Position.sub(muzzle));
		if (bearing === undefined) continue;
		if (axis.Angle(bearing) > halfAngle) continue;

		const distance = root.Position.sub(raw).Magnitude;
		if (distance >= bestDistance) continue;

		best = model;
		bestDistance = distance;
	}

	return best;
}

/**
 * Rebuilds {@link targets} if the last scan is older than one refresh.
 *
 * **Two cases, and the order between them is the rule.** A round's sides are the only place "an opponent"
 * means anything, and a *practice zone* is the only other place the game expects you to throw at a rig — so a
 * participant is answered by the round and a player practising is answered by the zone. A body can only be
 * one of the two in practice (`RoundService.assignTeams` keeps a practice-zone player off a side), and where
 * both would answer, the round wins: the sides are the narrower, more deliberate statement.
 *
 * **The local player's side is read only while they are *in* the round**, which is `isParticipant` —
 * `IN_ROUND_ATTRIBUTE` **and** the phase — rather than `inRound()` alone, and the difference is the lobby. A
 * round being played is true for every spectator watching from the lobby, and `assignTeams` leaves the last
 * round's label standing through the intermission and after a surrender, so `inRound() && sideOf(...)` would
 * keep naming opponents for a player who had walked out. **That is the 2026-10-21 change on this line**: the
 * assist may now run without a ball, so it has to stop the moment the player is not in the round, and
 * `isParticipant` is the predicate `ShiftLock`'s own lock already uses — one rule, two readers. Outside a round,
 * `mine` is `undefined` and the round branch is not taken; a surrendered player in the lobby therefore has no
 * targets at all, rather than targets they cannot act on.
 *
 * **A body with no side is not a target in a round.** The spec is "a body whose `TEAM_ATTRIBUTE` differs from
 * the local player's", and a side-less rig differs from everything only because it has said nothing — so this
 * requires *two valid labels that are unequal*, which is the same "a value that is not one of the two labels
 * reads as no side" rule `npc/rigs.ts` and `roundZone` already share. A rig nobody painted is not an opponent.
 *
 * **A practice zone takes every rig in the world and no players.** That is the spec's rule, and it is the
 * honest one: a rig in a zone is a target for practice by construction, while another *player* in the lobby is
 * somebody walking about, and pulling a throw at them would be the assist inventing a game. The local
 * character is excluded in both branches and again in {@link inMode}, because "never assist at yourself" is
 * the one rule that must survive any future change to the rest.
 *
 * **Which case was taken is stored in {@link mode} rather than passed around**, and the latch is the reader that
 * made it worth storing: it has to be re-validated against the rule it was picked under on every frame, and
 * re-deriving that rule per frame would mean asking `inTaggedZone` — a tag walk — on the aim's clock. One scan,
 * one mode, one rule read by both `consider` and `stillEligible`.
 */
function scan(character: Model, ignore: ReadonlyArray<Instance>): void {
	const now = os.clock();
	if (now - scannedAt < 1 / AIM_CONFIG.TARGET_UPDATE_HZ) return;

	scannedAt = now;
	targets = [];

	// **The mode is decided every tick, latch or no latch.** The latch is re-validated against it, so a player
	// who walks out of a zone mid-hold, or whose side changes under a conversion, is a player whose latched body
	// has stopped being a target — see `stillEligible`, which asks `inMode` and therefore this.
	const localPlayer = Players.LocalPlayer;
	const mine = isParticipant(localPlayer) ? sideOfBody(localPlayer) : undefined;
	const current: AssistMode =
		mine !== undefined
			? { kind: "round", mine }
			: inTaggedZone(character)
				? { kind: "zone" }
				: { kind: "none" };

	mode = current;
	if (current.kind === "none") return;

	const muzzle = getThrowMuzzle(character);
	const rigs = rigsInWorkspace();

	// **A round's candidates are people and rigs; a practice zone's are rigs only.** Which bodies are offered is
	// the only thing this branch decides — which of them are *eligible* is `inMode`, so a side-less rig in a
	// round is offered here and refused there, in one place rather than two.
	if (current.kind === "round") {
		for (const player of Players.GetPlayers()) {
			if (player === localPlayer) continue;

			const body = player.Character;
			if (body !== undefined) consider(body, character, muzzle, ignore);
		}
	}

	for (const rig of rigs) consider(rig, character, muzzle, ignore);
}

/**
 * **The eligibility rule, in one place: is this body a target under the rule the scan is running under?**
 *
 * **One function because it has two readers on two different clocks.** `consider` asks it to build the candidate
 * list at the scan's rate, and `stillEligible` asks it every frame about the one body the latch holds — and "the
 * latch drops when the target fails any eligibility test it passed at pick time" is only a meaningful sentence if
 * picking and re-validating are the *same* test. Two expressions of "an opponent" would agree on the day they
 * were written and drift apart on the first change.
 *
 * **The local character is refused here rather than at the call sites**, because it is the rule that has to
 * survive somebody adding a fourth branch to `scan`.
 *
 * **A side-less body is not a target in a round.** "A body whose `TEAM_ATTRIBUTE` differs from the local
 * player's" needs *two valid labels that are unequal* — an unset attribute differs from everything only because
 * it has said nothing — which is the same "a value that is not one of the two labels reads as no side" rule
 * `npc/rigs.ts` and `roundZone` already share. A rig nobody painted is not an opponent.
 */
function inMode(model: Model, character: Model): boolean {
	if (model === character) return false;

	if (mode.kind === "round") {
		const side = sideOfBody(model);

		return side !== undefined && side !== mode.mine;
	}

	if (mode.kind === "zone") {
		// **A practice zone's targets are rigs and never players.** The tag is the statement that a body is there
		// to be practised on; another player in the lobby is somebody walking about, and pulling a throw at them
		// would be the assist inventing a game.
		return Players.GetPlayerFromCharacter(model) === undefined;
	}

	return false;
}

/**
 * Adds `model` to {@link targets} if it is a body this throw could actually hit.
 *
 * **Everything but the rule is here — reach and sight — and the rule itself is {@link inMode}.** The sight test is
 * a raycast, and the scan's clock is where a raycast per candidate belongs; the latch's own one-body check runs
 * on the aim's clock as `stillEligible`, which asks the same two questions of one model. **A body behind a wall
 * is not something the assist should pull towards**, because pulling the aim at it would lengthen a throw into
 * cover and *away* from whatever the player was pointing at. **The midline barrier is not cover for this test
 * and that is deliberate**: it is `CanQuery = false` so that the aim arc passes through it, and a sight test that
 * stopped on it would contradict the preview drawn through it. See {@link inSight} for what this ray is
 * deliberately stricter than.
 */
function consider(model: Model, character: Model, muzzle: Vector3, ignore: ReadonlyArray<Instance>): void {
	if (!inMode(model, character)) return;
	if (model.Parent === undefined) return;

	const root = rootOf(model);
	if (root === undefined) return;

	if (muzzle.sub(root.Position).Magnitude > AIM_CONFIG.TARGET_MAX_DISTANCE) return;

	if (!inSight(muzzle, root, model, ignore)) return;

	targets.push(model);
}

/**
 * Whether a ray from the muzzle reaches `root` before anything else does. See {@link consider}.
 *
 * **A straight line, and therefore deliberately stricter than the ball's own arc.** The throw is ballistic: it
 * lobs, and a low wall or a crate between the hand and a body is something it can clear. This asks whether the
 * *sight line* is clear, so a lob over low cover and a head above a wall are both refused — the assist declines
 * to help with throws it cannot be sure about. **Conservative by choice**, and the cost is stated: a body the
 * player could legitimately lob onto is not assisted, which is a missed convenience rather than a wrong lead.
 * The reason not to model the arc instead is that the arc's own answer (`reachTo`'s flight, then the sweep) is
 * the *pull's* output — the pull moves the point that the arc is solved to — so a cover test built on it would
 * be asking the question with its own answer. **The arc is the proof; this is the permission.**
 *
 * The barrier and the loose balls are the two things it must *not* stop on, and both are handled the same way:
 * the barrier is `CanQuery = false`, and every loose ball is in the ignore list. Nothing else in the arena is
 * excluded, so scenery is cover exactly as it is for the drawn path.
 */
function inSight(muzzle: Vector3, root: BasePart, model: Model, ignore: ReadonlyArray<Instance>): boolean {
	const params = new RaycastParams();
	params.ExcludeInstances = [...ignore];

	const hit = Workspace.Raycast(muzzle, root.Position.sub(muzzle), params);

	// Nothing in between at all: the shot is clear. Otherwise the first thing it met has to be the body
	// itself — a limb counts, because a limb's nearest `Model` ancestor is the body it belongs to.
	if (hit === undefined) return true;

	return hit.Instance.FindFirstAncestorWhichIsA("Model") === model;
}

/**
 * What {@link latchFor} answers: the body, or nothing, **and whether this call is the one that dropped it** — so
 * the caller reports a drop once instead of also reporting "no target" a line later, which would be the same
 * event told twice in two vocabularies and the second one wrong about why.
 */
interface Chosen {
	readonly model?: Model;
	readonly dropped: boolean;
}

/**
 * **The body this aim is latched to, or nothing — decided once per aim, and once per hold inside one.**
 *
 * **The aim session is the unit, not a frame.** `ThrowController` builds a request in the frame loop and again
 * at the release, so a picker with no memory would allow a body entering the cone on the release frame — or two
 * candidates trading the nearest slot — to hand the throw a target the player never watched. The key is the
 * session (`AssistRequest.session`), and a latch belonging to a different session is replaced outright: a new
 * aim is a new chance to pick.
 *
 * **A first pick is allowed while nothing is latched, and only then.** A body that walks into the cone two
 * frames into an aim is taken, because that is the assist turning on — what it must never do is *change*
 * target. `dropped` is the difference: once a latched body stops being eligible the model is cleared and this
 * function refuses to look again **for the rest of the hold**, so a death, a step behind cover or a side change
 * turns the assist **off** rather than redirecting it. What the player watched stops being what they throw
 * either way; "no assist" is the only version of that which is not a lie.
 *
 * **And outside a hold, a dropped latch is simply picked again — which is the one rule that changed.** Nothing
 * has been drawn from it yet, so there is no drawn-versus-thrown disagreement to protect, and an assist that
 * went off for the rest of a minute-long aim because one enemy stepped behind a crate would read as broken. The
 * `dropped` flag is therefore scoped to *the hold* rather than to the aim: **set when a body is lost, and
 * cleared as soon as a request arrives saying no hold is running.**
 *
 * **The drop is reported once, with the body's name**, because "the assist stopped helping" has two causes
 * that look identical from the outside — a body that left, and a latch that never took — and this is the line
 * that tells them apart in a session.
 */
function latchFor(request: AssistRequest, raw: Vector3): Chosen {
	const session = request.session;
	if (session === undefined) return { dropped: false };

	let held = latch;

	// **A different aim replaces the latch**, and that is the only unconditional reset of `dropped` there is:
	// a new session has nothing drawn from it, whatever the last one was doing.
	if (held === undefined || held.session !== session) {
		held = { session, dropped: false, velocityAt: 0 };
		latch = held;
	}

	if (held.model !== undefined) {
		if (stillEligible(held.model, request)) return { model: held.model, dropped: false };

		if (DEBUG) print(`[Aim] assist: dropped ${held.model.Name} — nothing else is picked this hold`);

		held.model = undefined;
		// The smoothing state goes with the body — the next one has its own velocity, and averaging the two
		// would lead the second target from the first one's motion for a fifth of a second.
		held.velocity = undefined;
		held.dropped = true;

		return { dropped: true };
	}

	// **`dropped` blocks a pick only while a hold is running.** Outside one, the assist picks again — see the
	// doc above for why that is the honest reading rather than a loosening.
	if (held.dropped) {
		if (request.hold !== undefined) return { dropped: true };

		held.dropped = false;
	}

	const chosen = pick(request, raw);
	if (chosen !== undefined) {
		held.model = chosen;
		held.velocity = undefined;
	}

	return { model: held.model, dropped: false };
}

/**
 * Whether the latched body is still a target, **by the same rule that chose it** — see {@link inMode}.
 *
 * **Two clocks, on purpose.** The rule, the reach and the sight test are asked every frame, because each of them
 * is either an attribute read or a single ray and each answers a case that would be visible if it lagged: a
 * body destroyed mid-hold, a body that steps behind a wall, a side that changed under it. The *zone* half of the
 * rule is not re-derived here — `inMode` reads the mode the throttled scan last worked out — because asking
 * `inTaggedZone` on the aim's clock would be the tag walk this file spends its doc refusing. **The staleness
 * that leaves is one scan at most**, and its worst case is a player who steps out of a zone mid-hold and keeps
 * the assist for 66 ms. Named rather than hidden.
 *
 * **And outside a hold, the *cone* is a condition too — the one that lets the player leave.** This is the
 * 2026-10-21 half of making the assist run without a ball: a latch is now taken while somebody is merely
 * walking around, and a rule that kept the camera on a body the player had deliberately turned away from would
 * be a camera they cannot steer. So an uncharged latch is dropped as soon as the body leaves
 * `AIM_ASSIST_CONE_HALF_DEGREES` — **the same cone that acquired it**, which is what makes the statement
 * simple: the assist only ever helps with something you are looking at. Inside a hold it is not asked, and
 * that asymmetry is deliberate rather than an oversight: a press is a commitment, and the camera winning the
 * argument with it is the behaviour the throw's own preview depends on (the heading follows the view, the throw
 * follows the heading — see `pick`'s doc). **The release is the ball, not the cone.**
 *
 * **No wider release angle has been added, and if it proves twitchy that is the knob to add** — a body walking
 * across the view at the edge of the cone would drop and re-acquire it, and a hysteresis pair (acquire at the
 * cone, release at a wider one) is the standard fix. It is not here because one angle is a rule and two is a
 * tuning session, and the cost of being wrong is a camera that lets go slightly early rather than one that will
 * not let go at all.
 */
function stillEligible(model: Model, request: AssistRequest): boolean {
	if (model.Parent === undefined) return false;
	if (!model.IsDescendantOf(Workspace)) return false;
	if (!inMode(model, request.character)) return false;

	const root = rootOf(model);
	if (root === undefined) return false;

	const muzzle = getThrowMuzzle(request.character);
	if (muzzle.sub(root.Position).Magnitude > AIM_CONFIG.TARGET_MAX_DISTANCE) return false;

	// **The cone, and only while nothing is being charged** — see this function's doc for why the hold turns it
	// off. A heading with no horizontal part is the same degenerate aim `pick` refuses, and the honest answer
	// here is to let go rather than to measure an angle off a near-vertical vector.
	if (request.hold === undefined) {
		const axis = flatUnit(request.heading);
		if (axis === undefined) return false;

		const bearing = flatUnit(root.Position.sub(muzzle));
		if (bearing === undefined) return false;
		if (axis.Angle(bearing) > math.rad(AIM_CONFIG.AIM_ASSIST_CONE_HALF_DEGREES)) return false;
	}

	return inSight(muzzle, root, model, request.ignore);
}

/**
 * **The one query this file offers the camera: the body the current aim is latched to, or nothing.**
 *
 * **It answers only while the aim that latched it is still the live one**, which is what makes it safe for a
 * reader that is not in the aim's call path at all. `ShiftLock` writes the camera from a render step of its own,
 * once a frame, and the latch outlives its aim by exactly one call — `releaseThrow` builds its request after the
 * session has been closed, and it must still get the body the drawing did. So the *query* is where the session is
 * checked: `aimSessionStartedAt` is read here, and a latch from a finished aim reads as no target. That is what
 * stops the camera **without a second "the aim ended" write anywhere**, which would be a second thing to keep in
 * step with the one the aim already does.
 *
 * **It used to check `chargeStartedAt`, and that is the whole of what "pre-charge aim assist" changed here.** The
 * charge was the right key while the follow only ran during a hold; now the key is the aim session, so the camera
 * turns onto a body the moment one is in the cone — whether or not the player has pressed. `ShiftLock.followTarget`
 * did not change for this: it asks the same question it always did, and the answer got longer-lived.
 *
 * **Nothing else about the assist leaves this file.** No point, no lead, no strength: a caller that wants any of
 * those would be building a second aim, and `ShiftLock` wants only to know which *body* to turn onto.
 */
export function latchedTarget(): Model | undefined {
	const held = latch;
	if (held === undefined || held.model === undefined) return undefined;
	if (Fusion.peek(aimSessionStartedAt) !== held.session) return undefined;

	return held.model;
}

/**
 * **Keeps the latch in step while the player is aiming but not holding the button** — the pre-charge half.
 *
 * **Why this exists as a second entry point rather than a call to {@link assistedAim}.** `assistedAim` answers a
 * *point*, and a point is only wanted when a throw is being drawn or sent. Before the hold there is no preview and
 * no wire, so the only consumer of an assist is the camera — and the camera wants the *latch*, not a lead. Running
 * the whole of `assistedAim` here would do two `planChargedThrow`s a frame to produce a number nobody reads, which
 * is the sort of cost this file's throttled scan exists to avoid.
 *
 * **It is not a second set of rules.** Both functions reach the same `scan` and the same `latchFor`, so "who is a
 * candidate", "which body is latched" and "when a latch drops" are one implementation with two clocks asking it.
 * What this method adds is nothing at all beyond the call: the answer is thrown away.
 *
 * **What it costs, stated rather than hidden.** The caller has to have an aim point to pick *near* — `pick`
 * measures candidates against it — so `ThrowController` casts its aim ray on every frame a mobile client holds a
 * ball, not only while charging. That is one `Workspace.Raycast` plus the exclusion list's one
 * `Workspace.GetChildren` walk per frame, on mobile only, against a preview path that used to do a full arc
 * solve and sweep every frame for everybody. **The tag walk the scan does is unchanged** and still runs at
 * `TARGET_UPDATE_HZ`; this adds no `GetTagged` call of its own.
 *
 * **Desktop is untouched by the same construction as `assistedAim`** — the first line, before any read.
 */
export function watchAim(request: AssistRequest): void {
	if (!isMobile()) return;
	if (request.session === undefined) return;

	// **A cast that hit nothing keeps the latch it has and picks nothing new**, which is `assistedAim`'s answer
	// to the same input and deliberately not a second rule: the pick is made *near the aim point*, and there is
	// no aim point to be near when the camera is on the sky. Freezing rather than clearing it matters here —
	// clearing would make the camera let go of a body every time a player looked up at nothing, and the next
	// frame would grab it back.
	const raw = request.raw;
	if (raw === undefined) return;

	scan(request.character, request.ignore);

	const chosen = latchFor(request, raw);
	if (!chosen.dropped) report(chosen.model);
}
/**
 * Every `NPC`-tagged model in the world.
 *
 * **The tag read directly rather than through `taggedPartsInWorkspace`.** That helper expands a tagged
 * container into its `BasePart`s and says so in its own doc — "this is not for callers that want a `Model`" —
 * and a rig's torso is not a rig. So this is the same read `npc/rigs.ts`'s `rigsOnASide` makes on the server,
 * with the side test left to the caller: **no player character can be in here**, because nothing but
 * `NpcService.spawn` and a person in Studio puts this tag on anything.
 */
function rigsInWorkspace(): Array<Model> {
	const rigs = new Array<Model>();

	for (const instance of CollectionService.GetTagged(NPC_TAG)) {
		if (!instance.IsA("Model")) continue;
		if (!instance.IsDescendantOf(Workspace)) continue;

		rigs.push(instance);
	}

	return rigs;
}

/**
 * The part a body's position and velocity are read from, or nothing.
 *
 * **`HumanoidRootPart` and no fallback.** A model without one cannot be predicted — it has no assembly to
 * read a velocity off and `MoveTo` has nothing to move — and a fallback to `PrimaryPart` would produce a lead
 * point measured from wherever a place-file author parked the primary part. `npc/rigPool.ts` keeps such a
 * model out of the pool for the same reason; this is the read that would have gone quietly wrong without the
 * same care.
 */
function rootOf(model: Model): BasePart | undefined {
	const root = model.FindFirstChild("HumanoidRootPart");

	return root !== undefined && root.IsA("BasePart") ? root : undefined;
}

/**
 * `vector` flattened onto the ground plane and normalised, or nothing when it has no horizontal part.
 *
 * **The `0.001` is the solve's own guard rather than a new number.** `planChargedThrow` refuses to normalise a
 * heading shorter than this because the direction of a near-vertical vector is decided by noise; the same
 * window is the right one here for the same reason, and two different thresholds would disagree about a look
 * straight down. Not exported: the two readers here are the only ones that need it, and a name in this module
 * is not the same thing as a shared rule.
 */
function flatUnit(vector: Vector3): Vector3 | undefined {
	const flat = new Vector3(vector.X, 0, vector.Z);
	if (flat.Magnitude <= 0.001) return undefined;

	return flat.Unit;
}

/**
 * Prints the assist's edges: the body an aim has latched, and when it has nothing latched.
 *
 * **`[Aim] assist: …` and not a per-frame line**, because the three questions a Studio session has to answer
 * about this feature — is it running, which body did it pick, is it ever picking one on my own side — are all
 * answered by a line that appears when the *latch* changes. That is now once per aim on each side, plus once
 * more whenever a dropped latch is picked again outside a hold, so a line per frame would say the same thing
 * sixty times.
 */
function report(target: Model | undefined): void {
	if (!DEBUG) return;

	const line = target === undefined ? "off — no eligible body in the cone" : `latched ${target.Name}`;

	if (line === lastReport) return;

	lastReport = line;
	print(`[Aim] assist: ${line}`);
}
