import Fusion from "@rbxts/fusion-3.0";
import { CollectionService, Players, Workspace } from "@rbxts/services";
import { AIM_CONFIG } from "shared/config/aim.config";
import { NPC_TAG } from "shared/constants";
import { ChargeRequest, getThrowMuzzle, planChargedThrow } from "shared/throw";
import { isMobile } from "./platform";
import { inRound, inTaggedZone, sideOfBody, SideLabel } from "./roundZone";
import { chargeStartedAt } from "./throwing";

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
 * ## The latch: one body per hold, and no re-pick
 *
 * **The point is latched to a *body*, not re-chosen every frame.** `ThrowController` builds a request in the
 * frame loop and again at the release, so a picker with no memory would let a body entering the cone on the
 * release frame — or two candidates trading the nearest slot — hand the throw a different target from the one
 * the player watched. The latch is keyed on the hold's own start instant (`AssistRequest.hold`) and lives
 * until that hold ends, and **a latch that drops is dropped for the rest of the hold**: the body it named is
 * destroyed, leaves the world, or stops being eligible, and the assist turns *off* rather than choosing
 * somebody else. What the player watched stops being what they throw either way, and "no assist" is the only
 * version of that which is not a lie.
 *
 * **`latchedTarget()` is the whole of what leaves this file for the camera**, and it answers nothing unless
 * the latch belongs to the hold running right now — see its own doc for why the *query* is where the hold is
 * checked, rather than a second "the hold ended" write somewhere in this file.
 *
 * ## Desktop is untouched, verified by construction
 *
 * **The first line of {@link assistedAim} returns the caller's own value when `isMobile()` is false**, before
 * any ray, tag walk or clock read — so a desktop client cannot reach the picker at all and its aim point is
 * bit-for-bit the one `aimPoint` produced. That is acceptance criterion 2, and it is a property of the order
 * of the guards rather than of a test.
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
	 * **The instant this hold began — `client/throwing.ts`'s `chargeStartedAt` as it stood when the request was
	 * built** — and the key the latch is held under.
	 *
	 * **It has to be passed rather than read from that value here, and the release is why.**
	 * `ThrowController.releaseThrow` clears `chargeStartedAt` *before* it builds the request it sends, so a read
	 * at this end would see "no hold" on the one frame the latch matters most and hand the release a fresh pick
	 * — the defect this key exists to close. `undefined` is the honest state of a caller that cannot name its
	 * hold; see `assistedAim` for what that gets.
	 */
	readonly hold: number | undefined;
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
 * design comes back" — and *only while a mobile client is charging a throw*, because `assistedAim` is the
 * only caller and the aim point is only computed during a hold. Nothing here runs at boot.
 *
 * **What the staleness costs, stated rather than hidden.** Membership can be up to one refresh behind: a rig
 * that is spawned or comes into sight mid-hold is assisted from the next tick, and one that dies or takes
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
 * **The body this hold is pulling towards, and the hold it belongs to — the latch.**
 *
 * `hold` is `AssistRequest.hold`'s instant: a latch whose `hold` does not match the request in hand belongs to
 * a finished hold and is replaced. `model` is absent until the first eligible body is found, which is why a
 * target that walks into the cone mid-hold can still be taken — **that is a first pick, not a re-pick**, and
 * the difference is `dropped`.
 *
 * **`dropped` is the whole of "never pick again this hold".** Once a latched body stops being eligible the
 * model is cleared and this goes true, and the assist stays off until the next hold starts. Clearing the model
 * alone would let the next frame choose somebody else, which is the drawn-versus-thrown disagreement this
 * latch exists to end.
 */
interface Latch {
	readonly hold: number;
	model?: Model;
	dropped: boolean;
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
 * **The prediction is one iteration of a fixed point, and it is named rather than converged.** The lead is
 * `root + velocity × flight`, and the flight is the pre-pull plan's own (`planChargedThrow` with the raw
 * point) — which is the value `reachTo` returns for that point, so it is the throw's own arithmetic rather
 * than a second estimate. The pull then changes the distance the cap is measured against, which changes the
 * hold, which changes the flight the lead should have used: a second iteration would chase that, and every
 * iteration after it. **One pass is the approximation, and what it costs is small and bounded**: the flight
 * moves by the ratio of the two distances at most, so a body moving at walking speed over a ~0.6 s hang
 * carries roughly ten studs, a 20% flight error is two studs of lead error, and the strength takes a third of
 * that — under a stud on a body this assist exists to help aim at. Converging it would buy that stud and cost
 * a second solve inside a per-frame path for a point that moves every frame anyway.
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

	// **A request that cannot name its hold gets no assist, rather than a latch keyed on nothing.** The latch is
	// per hold, and a caller that could not say which hold this is cannot be given a body that outlives one.
	// Only `releaseThrow` can reach this, and only if it were ever called with no charge running — see `hold`.
	if (request.hold === undefined) return raw;

	// **The scan runs before the latch is looked at, so the latch is validated against the world as it is now.**
	// Its own refresh is inside it; this call is the aim's clock reaching the throttled one.
	scan(request.character, request.ignore);

	// **One body for the whole hold, or none.** See the file doc and `latchFor`: this is the one place a target
	// is chosen, and it is reached only when nothing is latched yet or the latch belongs to a finished hold.
	const chosen = latchFor(request, raw);

	// **A drop reports itself, in its own words**, and this line is why the answer carries the flag: the drop
	// line and an "off — no eligible body" line a frame apart would be one event told twice, in two vocabularies,
	// and the second would be a lie about *why*.
	if (!chosen.dropped) report(chosen.model);

	const target = chosen.model;
	if (target === undefined) return raw;

	const root = rootOf(target);
	if (root === undefined) return raw;

	// **The probe plan, built from the throw's own inputs and the pre-pull point.** Its `flightTime` is
	// `reachTo`'s answer for that point when the point is worth solving for, and the ballistic hang when it is
	// not — both of which are the flight the throw would take, which is what the lead wants. See this
	// function's doc for why the number is not recomputed after the pull.
	const muzzle = getThrowMuzzle(request.character);
	const probe: ChargeRequest = {
		heading: request.heading,
		charge: request.charge,
		curve: request.curve,
		aim: raw,
	};

	const flight = planChargedThrow(request.character, probe, muzzle).flightTime;

	// **The horizontal velocity and only that**, for the reason `leadVelocity` gives at length: the lead is
	// where the body's feet will be, and the throw's own arc is what carries the ball up to it.
	const velocity = leadVelocity(root);
	const lead = root.Position.add(velocity.mul(flight));

	return raw.Lerp(lead, AIM_CONFIG.AIM_ASSIST_STRENGTH);
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
 * `CHARGE_PEAK_HEIGHT` — every hold hangs the same 0.6 s — so where the body will be *vertically* at the end
 * of the flight is not something the thrower can influence; what a lead can correct is the horizontal
 * walking. Keeping Y would also let a jumping body's zero vertical velocity at the apex drag the aim point
 * down, which is a lead point below the body the player is looking at.
 *
 * **What this is not: a prediction of a dodge.** A body that dodges during the flight moves somewhere this
 * cannot know, and a lead that pretended to would be a second guess stacked on a first. The assist is for a
 * thumb that is close but not exact, not for reading an opponent's mind.
 */
function leadVelocity(root: BasePart): Vector3 {
	const velocity = root.AssemblyLinearVelocity;

	return new Vector3(velocity.X, 0, velocity.Z);
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
 * **The local player's side is read only while a round is playing**, which is `AimTargetController.hittable`'s
 * reading and `RoundService.isFriendlyFire`'s: `assignTeams` leaves the last round's label standing through
 * the intermission, so a side read outside a round would compare against a side that has stopped meaning
 * anything. Outside a round, `mine` is `undefined` and the round branch is not taken.
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
	const mine = inRound() ? sideOfBody(localPlayer) : undefined;
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
 * **The body this hold is latched to, or nothing — decided once and never re-picked.**
 *
 * **A hold is the unit, not a frame.** `ThrowController` builds a request in the frame loop and again at the
 * release, so a picker with no memory would allow a body entering the cone on the release frame — or two
 * candidates trading the nearest slot — to hand the throw a target the player never watched. The key is the
 * hold's own start instant, which survives the release because `releaseThrow` reads it *before* it clears the
 * charge; see `AssistRequest.hold`.
 *
 * **A first pick is allowed while nothing is latched, and only then.** A body that walks into the cone two
 * frames into a hold is taken, because that is the assist turning on — what it must never do is *change*
 * target. `dropped` is the difference: once a latched body stops being eligible the model is cleared and this
 * function refuses to look again until the next hold, so a death, a step behind cover or a side change turns
 * the assist **off** rather than redirecting it. What the player watched stops being what they throw either way;
 * "no assist" is the only version of that which is not a lie.
 *
 * **The drop is reported once, with the body's name**, because "the assist stopped helping" has two causes
 * that look identical from the outside — a body that left, and a latch that never took — and this is the line
 * that tells them apart in a session.
 */
function latchFor(request: AssistRequest, raw: Vector3): Chosen {
	const hold = request.hold;
	if (hold === undefined) return { dropped: false };

	let held = latch;

	if (held === undefined || held.hold !== hold) {
		held = { hold, dropped: false };
		latch = held;
	}

	if (held.model !== undefined) {
		if (stillEligible(held.model, request)) return { model: held.model, dropped: false };

		if (DEBUG) print(`[Aim] assist: dropped ${held.model.Name} — nothing else is picked this hold`);

		held.model = undefined;
		held.dropped = true;

		return { dropped: true };
	}

	if (held.dropped) return { dropped: true };

	const chosen = pick(request, raw);
	if (chosen !== undefined) held.model = chosen;

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
 */
function stillEligible(model: Model, request: AssistRequest): boolean {
	if (model.Parent === undefined) return false;
	if (!model.IsDescendantOf(Workspace)) return false;
	if (!inMode(model, request.character)) return false;

	const root = rootOf(model);
	if (root === undefined) return false;

	const muzzle = getThrowMuzzle(request.character);
	if (muzzle.sub(root.Position).Magnitude > AIM_CONFIG.TARGET_MAX_DISTANCE) return false;

	return inSight(muzzle, root, model, request.ignore);
}

/**
 * **The one query this file offers the camera: the body the current hold is pulling towards, or nothing.**
 *
 * **It answers only while the hold that latched it is still the live one**, which is what makes it safe for a
 * reader that is not in the aim's call path at all. `ShiftLock` writes the camera from a render step of its own,
 * once a frame, and the latch outlives its hold by exactly one call — `releaseThrow` builds its request after
 * `chargeStartedAt` has been cleared, and it must still get the body the drawing did. So the *query* is where the
 * hold is checked: `chargeStartedAt` is read here, and a latch from a finished hold reads as no target. That is
 * what stops the camera on the release frame **without a second "the hold ended" write anywhere**, which would be
 * a second thing to keep in step with the one the aim already does.
 *
 * **Nothing else about the assist leaves this file.** No point, no lead, no strength: a caller that wants any of
 * those would be building a second aim, and `ShiftLock` wants only to know which *body* to turn onto.
 */
export function latchedTarget(): Model | undefined {
	const held = latch;
	if (held === undefined || held.model === undefined) return undefined;
	if (Fusion.peek(chargeStartedAt) !== held.hold) return undefined;

	return held.model;
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
 * Prints the assist's edges: the body a hold has latched, and when a hold ends with nothing latched.
 *
 * **`[Aim] assist: …` and not a per-frame line**, because the three questions a Studio session has to answer
 * about this feature — is it running, which body did it pick, is it ever picking one on my own side — are all
 * answered by a line that appears when the *latch* changes. That is now once per hold on each side: the latch is
 * taken once and dropped once, so a line per frame would say the same thing sixty times.
 */
function report(target: Model | undefined): void {
	if (!DEBUG) return;

	const line = target === undefined ? "off — no eligible body in the cone" : `latched ${target.Name}`;

	if (line === lastReport) return;

	lastReport = line;
	print(`[Aim] assist: ${line}`);
}
