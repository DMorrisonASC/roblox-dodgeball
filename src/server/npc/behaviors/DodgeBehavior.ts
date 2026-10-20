import { Workspace } from "@rbxts/services";
import { DODGE_CONFIG } from "shared/config/dodge.config";
import { NPC_CONFIG } from "shared/config/npc.config";
import { BALL_NAME } from "shared/constants";
import { resolveDodgeable } from "shared/dodge";
import { BEHAVIOR_DODGING, NpcBehavior } from "../Behavior";
import type { DodgeService } from "../../services/actions/DodgeService";
import type { BallService } from "../../services/ball/BallService";

/**
 * Prints one line for each decision this behavior makes, and nothing at all on a quiet turn.
 *
 * **A chance is only checkable by counting decisions**, which is why this speaks once per decision
 * rather than once per turn: "the rig decided to stand" and "the rig never saw the ball" look identical
 * from the outside — one is the design working and the other is detection failing — and the number in
 * the file comment is arithmetic that deserves to be checked against a real throw. It is affordable
 * because it only speaks while a ball is genuinely *on course*, and there is **one decision per ball
 * aimed at this rig** — see the roll in `tick` for why it is once and not once per turn, which is what
 * this doc used to assume. See `note` for the line itself.
 */
const DEBUG = false; // off for frame time — see shared/config/debug.config.ts

/**
 * The attribute that makes a ball dangerous, spelled the way its owner spells it.
 *
 * **Must match what `BallService` and `BallComponent` write** — `Armed` is the flag that means "this
 * ball belongs to a throw": it goes on when a ball is handed out or thrown and comes off when it
 * lands, which is why `BallPickupService` refuses to pick up an armed ball and why a ball lying on
 * the floor can be walked over. It is a literal in both of those files rather than a shared
 * constant, so this is one more spelling of a name several files have to agree on, and the only
 * thing that catches a typo is nobody dodging.
 */
const ARMED_ATTRIBUTE = "Armed";

/**
 * How far away a ball is worth doing the arithmetic on, in studs.
 *
 * **A pre-filter for the arithmetic rather than the threat test**, which is why it is generous: the
 * closest-approach test below is what decides, and it costs a handful of vector operations per ball
 * per turn. What the radius buys is a bound on how many of those run — every ball in the world is
 * examined for its name and its flags, and only the ones inside this get the rest.
 *
 * **60 studs, which is about half a second of the fastest throw this game makes.** The probe output
 * puts a full-speed throw at 125 studs/s, so a ball beyond this cannot be on the rig in less than
 * the time it takes the rig to notice — and a ball further away than that is one to react to on a
 * later turn, when it is closer, rather than one to predict from across the arena.
 *
 * **Placeholder.**
 */
const THREAT_RADIUS = 60;

/**
 * How close the ball's path has to come to the rig to count as a hit, in studs.
 *
 * **The ball's radius plus a body's**, both of which are facts rather than tuning: the ball is
 * `BALL_SIZE` across, and a torso is a couple of studs wide. It is deliberately not tight, because
 * the two errors are not symmetrical — a test that is one stud generous dodges a ball that would
 * have grazed, and a test that is one stud tight stands still for a ball that hits.
 *
 * **Placeholder.**
 */
const THREAT_HIT_RADIUS = 4;

/**
 * How far above or below the rig's own centre a ball can be and still count, in studs.
 *
 * **The height is a snapshot and the flat position is a prediction, and that is not laziness.** A
 * ball's path curves only in the vertical — gravity has no horizontal component — so the flat
 * closest-approach below is *exact* for a thrown ball, and where it will be in Y at that moment is
 * not knowable without re-solving the whole throw. A band on where the ball *is now* is the honest
 * substitute: a ball twenty studs up is not about to hit anybody inside half a second, and a ball at
 * chest height is.
 *
 * **What that costs, stated:** a ball descending steeply onto a rig is judged by where it is rather
 * than where it is going, so a lob that will arrive at head height from above may be read as too
 * high to be a threat for the turn or two when it could still have been dodged. The error is
 * one-sided — it produces a rig that is hit rather than a rig that flinches — which is the direction
 * to be wrong in.
 *
 * **Placeholder.**
 */
const THREAT_HEIGHT_BAND = 5;

/**
 * **The dodge chance lives in `NPC_CONFIG.DODGE_CHANCE_PER_BALL` now, not here.**
 *
 * It moved when this file was split into two variants: the chance is the *gated* variant's knob, and
 * the always variant has no chance at all — so the value belongs beside the other tuning numbers
 * rather than inside the file that serves both. The essay that argued the value's *shape* — why it is
 * per ball rather than per second, and what that reversal cost — moved with it; see the config entry.
 */

/**
 * How often the behaviour looks for a ball that is coming at it, in seconds.
 *
 * **The same interval `Behavior_Catching` asks for, deliberately.** `NpcService` runs one loop per rig
 * at the *fastest* interval any behaviour asked for, and the catcher already asks for 0.1 — so
 * registering this one changes no rig's cadence at all. The reaction time it buys is the thing that
 * matters: a 125-stud/s ball crosses 12 studs in a tenth of a second, so this is the granularity of
 * "how late can the rig notice".
 *
 * **It is not an odds knob, and it never really was one.** The tick decides how *early* the rig can
 * commit, and how often the escape directions are re-tested as the ball closes; the chance above is the
 * whole of the odds.
 *
 * **Placeholder.**
 */
const DODGE_TICK_SECONDS = 0.1;

/**
 * How slowly a ball can be moving and still be worth predicting, in studs per second.
 *
 * **The guard on the division, and it earns its place twice.** A ball being carried by a running
 * player is welded to their hand and travels at their speed — which `isHeld` already refuses, but a
 * velocity of nearly zero is what a closest-approach solve divides by, and a zero there is a `nan`
 * magnitude and a threat test that answers nonsense. A ball slower than this cannot cross the rig's
 * own width quickly enough to matter anyway.
 */
const MIN_THREAT_SPEED = 5;

/**
 * How far above the rig's own soles the block cast is made, in studs.
 *
 * **A quarter stud, and it is there to keep the floor out of the answer.** The box that test casts is
 * the rig's own bounding box, so its underside *is* the soles of its feet, which rest exactly on the
 * floor: a cast whose shape starts touching the floor is one whose first hit may be the floor it is
 * standing on, and every dodge would then read as blocked. Lifting it by a quarter of a stud makes that
 * impossible rather than unlikely, and the price is an obstruction under a quarter of a stud high —
 * which is a step nothing can walk over either, so it is the cheap end of the trade.
 *
 * **Not a tuning value**, which is why it is not in the config beside `DODGE_CONFIG`: it is the gap
 * between a body and the ground, not a property of the game.
 */
const CAST_LIFT = 0.25;

/**
 * Dodging, for an NPC — **and the two ways to ask for it.**
 *
 * **The rig dodges the ball that will hit it, not the ball that is merely near it.** That is the
 * whole design and the first thing this behaviour had to decide. The alternative — "a ball inside N
 * studs moving vaguely toward me" — is a third of the code and produces a rig that flinches at every
 * ball that passes on its way somewhere else, which reads as a bug rather than as an evasion. A dodge
 * is not free: it is a 15-stud commitment over `DODGE_CONFIG.DURATION` with a
 * `DODGE_CONFIG.COOLDOWN` behind it, so a wasted one is a rig that cannot dodge the next ball
 * because it was busy dodging a miss. See `threatAgainst` for the test itself.
 *
 * **Two tags, one body, and the whole difference is one question: may this rig dodge this ball?**
 *
 * - **`Behavior_Dodging`** answers with the coin-flip in `NPC_CONFIG.DODGE_CHANCE_PER_BALL`, which is
 *   what that tag has always done, and it is the tag this file is named for. **Adding the sibling did
 *   not change what this tag means** — a place-file rig already wearing it dodges exactly as often as
 *   it did — and that is stated because the catch/throw split next door *did* change what a stable
 *   string meant.
 * - **`Behavior_AlwaysDodging`** answers *yes* to every ball it can move away from — the rig that
 *   dodges everything, for a dummy meant to be evasive. `DodgeService` still bounds it: a dodge is
 *   refused inside `DODGE_CONFIG.COOLDOWN`, so "always" means "always tries", never "dodges five
 *   times a second". It is the thin one, in `AlwaysDodgeBehavior.ts`.
 *
 * **Why one tick body and two factories — and why the body is in *this* file.** The variants differ in
 * exactly one expression — the value of `dodging` on a fresh decision — and everything around it (the
 * anchored and movement guards, the threat test, the escape-direction search, the cooldown pre-check,
 * the per-ball bookkeeping) is identical. Two copies would be two places to fix the next time one of
 * those gates moves. So the body is one function, parameterised by a `shouldDodge` predicate, and each
 * tag is a factory that supplies its own answer. {@link makeDodgeBehavior} is the internal factory; the
 * two `create*` functions are the only things `NpcService` should see.
 *
 * **The body lives in the file named for the tag that is *not* the special case, and that is a
 * reversal.** It used to live in `AlwaysDodgeBehavior.ts`, with the gated tag as a one-line wrapper in
 * this file — which meant that the file named for the common case was the one with nothing to read in
 * it, and the file holding everything was named for the exception. **The rule, so the next pair does not
 * have to argue it again: the base file holds the body, and the `Always*` file is the wrapper that
 * extends it.** So {@link makeDodgeBehavior} is here, `createDodgeBehavior` is here beside it, and
 * `AlwaysDodgeBehavior.ts` imports this file and supplies nothing but `() => true`.
 *
 * **The decision is made once per ball and held — the shape a rate-per-second could not survive.**
 * A rig that sees a ball coming decides about *that ball*, stores the answer in `pledged`, and every
 * later turn the same ball is on course reads the stored answer rather than asking again. A different
 * ball is a new question. So the chance means "how often a rig gets out of the way", which is what a
 * number called a chance ought to mean — and the log that forced that reading is worth keeping: the
 * chance used to be a rate *per second* scaled by the tick into a chance *per turn*, and six charged
 * throws at one rig produced **fourteen turns with the ball on course and three dodges**. Nothing was
 * broken and nothing a player could see was right — the knob was measuring *exposure* while everyone
 * read it as a percentage, so a ball on course for 0.2 s and one on course for 0.7 s were not treated
 * alike. See `NPC_CONFIG.DODGE_CHANCE_PER_BALL` for the value and the rest of that argument.
 *
 * **What the dodge does and does not do.** It is *pure movement* — a `LinearVelocity` on the root
 * held for the duration, plus a `PlatformStand` so the humanoid's own walk controller does not fight
 * it — and there is no immunity anywhere behind it: nothing in `DodgeService` marks the body as
 * untouchable, and nothing in `BallComponent` vetoes a contact because the body is dodging. So a
 * dodge evades by *being where the ball is not*, which has a consequence this behaviour has to take
 * seriously: a dodge that does not actually move the rig has achieved nothing at all, and two of the
 * gates below exist for exactly that reason.
 *
 * Three things still refuse a dodge the rig has already committed to, and all three are deliberate. A
 * direction with something solid in both ways is not dodged at all — though the *decision* survives that
 * turn and is acted on as soon as there is room, because the ball is still coming. The 1.5 s cooldown
 * means one dodge per `DODGE_CONFIG.COOLDOWN`, however many balls arrive inside it. And a rig the engine
 * will not simulate cannot dodge at all, which is answered before the decision is even made.
 *
 * **Two of those three now *run* instead of standing, and the distinction is worth keeping straight: a
 * refused dash is not a refused movement.** A rig on cooldown, or one whose request the service turned
 * down because a catch window was open, still holds an escape direction it has already proved clear — so
 * it walks it, which is strictly better than being a stationary target in the path of a ball. The other
 * two cases still stand, because there is nothing else they can do: a rig with both ways blocked has no
 * clear direction to walk, and a rig the engine will not simulate has no movement at all. See `runAway`
 * below for what that walk is, what it costs, and the one case it deliberately does not cover (a roll the
 * gated variant *declined*, which is a decision rather than an unavailability).
 *
 * **Both variants get this, and the file names no longer hide it.** `Behavior_Dodging` is what the arena
 * rigs wear and `Behavior_AlwaysDodging` is the practice dummy's tag, and the body both of them share is
 * *this* function — so a change here is a change in both places, which is the whole reason the body sits
 * in the file a reader opens first.
 *
 * **It fetches nothing and takes nothing.** A rig holding a ball dodges exactly like an empty-handed
 * one: a ball in the hand is not a shield, and the game's own rules say so — a catcher may not catch
 * while holding, and nothing stops a holder being hit.
 */
export function makeDodgeBehavior(
	dodges: DodgeService,
	balls: BallService,
	tag: string,
	shouldDodge: (model: Model, threat: BasePart) => boolean,
): NpcBehavior {
	/**
	 * When each rig last *succeeded* in dodging, on the engine's clock.
	 *
	 * **Stamped on success rather than on the ask, and that is what keeps the two gates in step.** A
	 * refused request has not happened — `DodgeService` refuses one for being frozen, for a catch
	 * window, for being off cooldown or for there being no round — so stamping it here would make the
	 * behaviour wait out a cooldown the service never charged. Success is the service's own answer to
	 * "the dash started", so this map is a copy of a fact rather than a second opinion about it.
	 *
	 * The number this holds is `DODGE_CONFIG.COOLDOWN`'s interval rather than a copy of the constant:
	 * the behaviour reads the same value the service charges against, so the two cannot drift.
	 */
	const lastDodgedAt = new Map<Model, number>();

	/**
	 * The decision each rig has already made about the ball it is currently facing.
	 *
	 * **One row per rig, replaced whenever the ball changes, and that is what makes the roll a per-ball
	 * event rather than a per-turn one.** The same ball is asked about on every turn it stays on course
	 * and gets the same answer every time; a different ball is a fresh question. Nothing has to clear it:
	 * a ball that has hit something is a ball no threat test will ever return again, so a stale row is
	 * simply never read, and each new ball overwrites the last.
	 *
	 * **The answer is held even when the rig cannot act on it yet.** A turn with something solid in both
	 * escape directions says so and does nothing, and the next turn — closer, and perhaps with room —
	 * consults this same answer instead of rolling again. A decision to dodge is a decision about the
	 * *ball*, not about the moment.
	 */
	const pledged = new Map<Model, { ball: BasePart; dodging: boolean }>();

	/**
	 * The ball that is genuinely on course to hit a rig standing at `origin`, or `undefined`.
	 *
	 * **A closest-approach test, and it is a few lines of arithmetic.** The ball's position relative
	 * to the rig and its velocity give the instant it is nearest — `t = dot(toRig, v) / |v|²`,
	 * positive when it is closing — and the separation at that instant is what the decision is made
	 * on. A positive `t` with a separation inside `THREAT_HIT_RADIUS` is a ball that will be *at* the
	 * rig, and nothing else is a threat.
	 *
	 * **Flat, and the flatness is exact rather than an approximation.** Gravity has no horizontal
	 * component, so a thrown ball's flat position at `t` is exactly where the arithmetic says it is,
	 * for the whole of its flight — the curve is entirely in Y. That is why the height is a separate
	 * snapshot band rather than part of the solve: see `THREAT_HEIGHT_BAND` for what that costs.
	 *
	 * **The failures it has, named.** A ball that will hit the *floor* short of the rig is predicted
	 * to pass through it, so a badly short throw is dodged as though it were on target — the two
	 * cases are indistinguishable from the thrower's line without solving the arc. A ball that
	 * bounces, or is curved by a super, is predicted from its current velocity alone and will be
	 * wrong after the moment something else changes it. Both are one-sided in the harmless direction
	 * only for the *bounce* case; a short throw is a wasted dodge, which is the price the whole test
	 * exists to reduce rather than to remove.
	 *
	 * **The scan is every ball directly in `Workspace`, filtered to almost nothing.** Balls are
	 * enumerated by name — `BALL_NAME` is shared and every ball carries it, and a thrown ball is
	 * parented to `Workspace` by the throw itself, which is why a shallow walk is enough and a
	 * `GetDescendants` over the whole arena is not. Held balls are welded into a hand and are usually
	 * not children of the world at all, and `isHeld` asks the question properly for the ones that
	 * are. What survives to the arithmetic is only armed balls within `THREAT_RADIUS`, which in play
	 * is one.
	 */
	const threatAgainst = (origin: Vector3): BasePart | undefined => {
		let threat: BasePart | undefined;
		let soonest = math.huge;

		for (const child of Workspace.GetChildren()) {
			if (child.Name !== BALL_NAME || !child.IsA("BasePart")) continue;

			// **Armed is what makes a ball dangerous** — see `ARMED_ATTRIBUTE`. A ball rolling across
			// the floor is not a threat however fast it is going, because nothing that has stopped being
			// a throw can hurt anybody.
			if (child.GetAttribute(ARMED_ATTRIBUTE) !== true) continue;

			// In somebody's hand, which a ball being carried is even while its holder runs. Asked rather
			// than inferred from the parent: `isHeld`'s own comment records what that guess costs.
			if (balls.isHeld(child)) continue;

			const toRig = origin.sub(child.Position);
			if (toRig.Magnitude > THREAT_RADIUS) continue;

			const velocity = child.AssemblyLinearVelocity;
			const planar = new Vector3(velocity.X, 0, velocity.Z);

			const speedSquared = planar.X * planar.X + planar.Z * planar.Z;
			if (speedSquared < MIN_THREAT_SPEED * MIN_THREAT_SPEED) continue;

			// **The instant of closest approach, and `t <= 0` is a ball going away.** The dot product of
			// "where the rig is" with "how the ball is moving" is positive while the ball is closing, so a
			// ball already past the rig — or thrown in the other direction — is dropped here rather than
			// being tested for a separation it will never have.
			const time = toRig.sub(new Vector3(0, toRig.Y, 0)).Dot(planar) / speedSquared;
			if (time <= 0) continue;

			// Where the rig is, less where the ball will be: the gap between them at that instant.
			const separation = toRig.sub(new Vector3(0, toRig.Y, 0)).sub(planar.mul(time)).Magnitude;
			if (separation > THREAT_HIT_RADIUS) continue;

			// The height, which is the one part of this that is a snapshot — see the constant.
			if (math.abs(child.Position.Y - origin.Y) > THREAT_HEIGHT_BAND) continue;

			if (time < soonest) {
				threat = child;
				soonest = time;
			}
		}

		return threat;
	};

	/**
	 * Whether a dodge from `box` along `direction` would run into something inside its own length.
	 *
	 * **A block cast of the rig's own body rather than a ray from its centre, and a log is why.** Two
	 * dashes in one session reported `dashed 2.0 of 15.0 studs` and `dashed 2.2 of 15.0 studs`: the rig
	 * committed, this test said the way was clear, and the rig then travelled two studs, which is a dodge
	 * that did not happen. A ray that starts at the root's centre is around three studs above the floor
	 * and infinitely thin, so a step, a kerb, a low prop or another rig's legs pass *underneath* it and
	 * are never seen; what actually stops a body is the body's width and height, not a line through the
	 * middle of it. `Model:GetBoundingBox` is that body — the smallest box its parts fit in, **in the
	 * rig's own frame** (the typings give the box an orientation, and it follows the model's primary
	 * part) — swept along the dash by `Blockcast`.
	 *
	 * **`RespectCanCollide`, and this one flag is the answer to the barrier.** The arena's midline
	 * wall is `CanQuery = false` — the flag that lets a thrown ball cross it and the aim guide go on
	 * telling the truth about where a throw lands — so a query that respects `CanQuery` passes straight
	 * through the wall and reports the way clear. Turning this on makes the query use `CanCollide`
	 * instead, and the wall *is* solid to characters: `CollisionGroups` is what keeps that true, and
	 * this reads the same two facts from the other side. So the wall is found rather than assumed, and
	 * no test against the barrier's own geometry — arena knowledge inside a behaviour, and a second
	 * reader of a tag `CollisionGroups` owns — is needed.
	 *
	 * **What it finds besides the wall is the point rather than the price.** Anything solid in the way
	 * is something a dodge into it would not get through, and a dodge that does not move the rig
	 * evades nothing — see the file comment. A body, an arena wall and a prop are all equally good
	 * reasons to go the other way. **A wider shape finds more of them**, so a rig that used to dash two
	 * studs into a step and read as dodging now reads — correctly — as having nowhere to go; expect
	 * `neither side is clear` where the old ray said clear.
	 *
	 * **The rig *and the ball it is dodging* are excluded, and with a shape this size that is no longer
	 * tidiness.** A ray left the rig's centre immediately, so leaving the rig in was merely wasteful;
	 * a box the size of the rig's own body *starts inside it*, and the same is true of the ball, which is
	 * on its way in rather than out of the way — it is in front of the rig, and the box is centred on the
	 * rig. `ExcludeInstances` rather than the deprecated pair, which is how every filter in this project
	 * is written — `shared/throw.ts` carries the argument. **Every *other* ball is still not excluded**:
	 * a second ball genuinely lying where the rig wants to go is a reason to go the other way rather than
	 * a reason to pretend it is not there, and that argument is unchanged.
	 *
	 * The shape is the rig's bounding box lifted by `CAST_LIFT`, so it clears the floor it stands on, and
	 * its sweep is exactly as long as the dash is.
	 */
	const blocked = (excluded: Instance[], box: CFrame, size: Vector3, direction: Vector3): boolean => {
		const params = new RaycastParams();
		params.ExcludeInstances = excluded;
		params.IgnoreWater = true;
		params.RespectCanCollide = true;

		return Workspace.Blockcast(box, size, direction.mul(DODGE_CONFIG.DISTANCE), params) !== undefined;
	};

	/**
	 * Which way to step, given where the ball is heading: perpendicular to it, and preferably not
	 * into something.
	 *
	 * **Perpendicular, because that is what gets out of a line.** Stepping along the ball's path —
	 * forward or back — keeps the rig in it; stepping perpendicular puts the most distance between
	 * the rig and the line in the fifteen studs a dash has, which is the whole of the evasive
	 * geometry available to a body that cannot stop or turn a ball.
	 *
	 * **Which side is random, and that is a decision rather than a shrug.** "Away from the nearest
	 * wall" is the answer a person would give, and it cannot be computed cheaply: the wall's position
	 * is not known to this file, and the two ways to learn it — the barrier's own planes, or a query
	 * the wall is invisible to — are the ones `blocked` exists to avoid needing. Random is also not
	 * much of a cost, for a reason worth stating: a ball is usually thrown *across* the arena's
	 * midline, so the perpendicular to its path runs roughly *along* the wall rather than into it. The
	 * case that does hit the wall is what the second candidate below is for — the rig simply tries the
	 * other side, which is "away from the wall" arrived at by asking rather than by knowing.
	 *
	 * `undefined` means neither side is clear, and the rig does not dodge at all: a dash that would
	 * move nowhere is worse than standing still, because it charges the cooldown for nothing.
	 */
	const escapeFrom = (subject: Model, threat: BasePart, path: Vector3): Vector3 | undefined => {
		const planar = new Vector3(path.X, 0, path.Z);
		if (planar.Magnitude < MIN_THREAT_SPEED) return undefined;

		// The perpendicular of the ball's flat heading, as a unit vector: (−z, 0, x) turned the right way,
		// which is the standard one and needs no trigonometry to get out of a 2-D heading.
		const side = new Vector3(-planar.Z, 0, planar.X).Unit;
		const first = math.random() < 0.5 ? side : side.mul(-1);

		// **One box for both candidates.** The rig has not moved between the two tests, so the body's
		// bounding box is computed once here rather than once per candidate — this is the only part of
		// the test that walks the rig's parts, and the cast itself is a single query. Lifted by
		// `CAST_LIFT` so its underside clears the floor the rig is standing on; see `blocked` for why
		// that lift is there and why the shape is a box at all.
		const [body, extent] = subject.GetBoundingBox();
		const box = body.mul(new CFrame(new Vector3(0, CAST_LIFT, 0)));
		const excluded: Instance[] = [subject, threat];

		// **One direction, then the other, and then nothing.** Two casts is the whole budget: a rig with
		// walls on both sides of a ball's line has nowhere to go, and pretending otherwise would be a
		// dodge that moves it into one of them.
		for (const candidate of [first, first.mul(-1)]) {
			if (!blocked(excluded, box, extent, candidate)) return candidate;
		}

		return undefined;
	};

	/**
	 * Says what one decision did about a threat, and says nothing at all about a turn with none in it.
	 *
	 * **The line exists because a chance can only be checked by counting**, and because "the rig rolled
	 * and lost" and "the rig never saw the ball" are identical from the outside — one is the design
	 * working and the other is the detection failing. Four outcomes are worth distinguishing and this
	 * prints the one that happened: nothing clear to dodge into, a body that cannot move, a roll that
	 * failed, and a dodge being asked for. The last one is answered by the service's own line
	 * immediately after, so the two together read as one sentence.
	 *
	 * **The rig is named by its full name, and that is not decoration.** Two models can wear this name
	 * at once — the map's own rig in its folder, and the one `RespawnBehavior` puts back — and
	 * `model.Name` cannot tell them apart, which is precisely the question when one of them decides and
	 * the other does not. A line that says `Workspace.Behavior_Dodging` is talking about the replacement;
	 * one that says `Workspace.ArenaV2.PracticeArea.NPCs.Behavior_Dodging` is talking about the rig the
	 * map came with. Until this change the two were the same three words in the output.
	 *
	 * **The ball is named too, and its name is honest about what it can and cannot say.** Every ball in
	 * the game is called `DodgeballBall`, so the name says "this is about the ball" and nothing more —
	 * what distinguishes one ball from another is the number on its component, which is private to
	 * `BallComponent` and is not reachable from here (`Instance.GetDebugId` is plugin-security, so it is
	 * not an option either). Reading two lines for one ball, if there are two, therefore means comparing
	 * their distances and their clock times rather than their text.
	 *
	 * The distance and the ball's speed ride along because they are the two figures the file comment's
	 * arithmetic is made of, and because they separate a *detection* problem from a *timing* one: a ball
	 * at 10 studs doing 125 is a rig with a tenth of a second left to act, and one at 55 studs doing 20
	 * is something else entirely.
	 */
	const note = (model: Model, root: BasePart, threat: BasePart, what: string): void => {
		if (!DEBUG) return;

		const velocity = threat.AssemblyLinearVelocity;
		const speed = math.sqrt(velocity.X * velocity.X + velocity.Z * velocity.Z);
		const distance = root.Position.sub(threat.Position).Magnitude;
		const where = model.GetFullName();

		print(
			`[Dodge] ${where}: ${what} — ${threat.Name} at ${string.format("%.1f", distance)} studs doing ` +
				`${string.format("%.1f", speed)} studs/s`,
		);
	};

	/**
	 * **Runs instead of standing: a `MoveTo` along a direction the rig has already proved is clear.**
	 *
	 * **This tag's job is not to be hit, and a dodge is only one way to do that.** `DodgeService` refuses a
	 * dash for reasons that are about the *service* rather than about the rig — a catch window open, a freeze,
	 * the cooldown, a round that is not on — and a rig wearing this beside `Behavior_Catching` spends most of a
	 * round inside the first of those, which is the state its log line reports as `refused — DodgeballBall is
	 * already in hand`. What the behaviour did until now was stand exactly where it was, which is the one thing
	 * a body in the path of a ball must not do, and from a seat it reads as a rig that has given up.
	 *
	 * **A walk, and not a dodge in disguise.** The direction is the one the dash would have taken and the rig
	 * travels the same way; what it does not get is the speed, the platform stand, the ghost, the sound or the
	 * cooldown — so it is not the dodge this behaviour is named for and does not pretend to be. A ball doing
	 * 125 studs/s is not evaded by walking; a ball that was going to *miss* now misses by more, and a rig that
	 * is moving is not the stationary target it was.
	 *
	 * **Not for a *declined* roll, deliberately.** The gated variant's `shouldDodge` answering "let this one
	 * past" is a decision rather than an unavailability — and if a rig ran for every ball it declines, the
	 * chance in `DODGE_CHANCE_PER_BALL` would stop meaning anything, because running is most of what dodging
	 * buys. Only the paths where the rig *could not* dodge call this: the cooldown below, and a refusal from
	 * the service.
	 *
	 * **`MoveTo` and not a velocity write**, for `SeekBehavior`'s reason: the engine's own mover owns the body,
	 * and this is the same request that behaviour issues.
	 *
	 * **What it fights, named.** `Behavior_Seeking` also issues `MoveTo` — at a ball, rather than away from one
	 * — so a rig doing both is two walkers taking turns and whichever ticks last each turn wins. That is the
	 * same interaction `WalkToJoinPadBehavior`'s doc records for its own pair, and it is worth its cost here: a
	 * rig running for its life and a rig fetching a ball are both doing what they were told, and the ball it
	 * wants is usually the one away from the ball coming at it.
	 */
	const runAway = (model: Model, root: BasePart, direction: Vector3): void => {
		const humanoid = model.FindFirstChildWhichIsA("Humanoid");
		if (!humanoid) return;

		humanoid.MoveTo(root.Position.add(direction.mul(NPC_CONFIG.DODGE_RUN_STUDS)));
	};

	return {
		tag,
		tickInterval: DODGE_TICK_SECONDS,

		tick(model) {
			const root = resolveDodgeable(model)?.root;
			if (!root) return;

			// **An anchored rig is not asked, because a dodge is pure movement and an anchored assembly
			// does not move.** `SetNetworkOwner` already refused this same rig at setup — see
			// `NpcService.ownForServer`, which is where the engine's own reason is printed. Rolling here
			// would spend the roll, charge the cooldown, play the sound and put the trail up, on a rig that
			// then stands exactly where it was and is hit. A rig that rolls, succeeds and does not move is
			// the worst version of this behaviour, so it is the one thing this file refuses outright.
			//
			// The test is the cheap half of the pair: `Anchored` on the root, which is what the place file
			// has. The other half — a rig whose root is free but which is *welded* to something anchored —
			// is asked below, once, and only when a roll has already succeeded.
			if (root.Anchored) return;

			// **The threat, then the direction, and only then the cooldown — and that order is the change that
			// lets a rig on cooldown run instead of standing.** The direction used to be chosen *below* the
			// gate, which was right while the only thing a rig could do with it was dash; now it is what a rig
			// does when it cannot dash, so it has to be known before the gate is asked.
			const now = os.clock();
			const threat = threatAgainst(root.Position);
			if (!threat) return;

			// **The direction is chosen before the roll, and that ordering is a fix rather than a
			// tidy-up.** It used to be the other way round — roll first, then ask where there was room —
			// which meant a turn with something solid on both sides spent its roll on a dodge that never
			// happened, silently: no line from this file, no line from `DodgeService`, nothing. In a
			// practice area with five rigs and props in it, "both sides blocked" is a common turn rather
			// than a rare one, and the rig reads as one that is ignoring the ball. One bounding box and up
			// to two casts a turn is the price, and they are only paid while a ball is genuinely on course.
			const direction = escapeFrom(model, threat, threat.AssemblyLinearVelocity);
			if (!direction) {
				note(model, root, threat, "neither side is clear");

				return;
			}

			// **The cooldown, read from the constant the service charges against.** It bounds the rate
			// regardless of rolls — at most one dodge per `DODGE_CONFIG.COOLDOWN` — and it is asked here as
			// well as inside `DodgeService` because the service's refusal is a print line: a rig rolling ten
			// times a second and asking ten times a second would fill the output with refusals.
			//
			// **And a rig on cooldown runs rather than standing.** The second and a half after a dodge is the
			// window in which a rig cannot dodge again, and standing through it is exactly what a body in the
			// path of a ball must not do — it is the turn it gets hit on. It keeps moving along the escape
			// direction it has already proved clear; see `runAway` for what that is and is not.
			const last = lastDodgedAt.get(model);
			if (last !== undefined && now - last < DODGE_CONFIG.COOLDOWN) {
				runAway(model, root, direction);

				return;
			}

			// **The movement guard, also before the roll**, for the same reason: a rig the engine will not
			// simulate cannot dodge, so a roll spent on it is a roll spent on nothing. This is the exact
			// half of the pair the `Anchored` check above is the cheap half of — see that comment — and it
			// is the same question `NpcService.ownForServer` asks about the same rigs at setup.
			const [movable] = root.CanSetNetworkOwnership();
			if (!movable) {
				note(model, root, threat, "this rig cannot move");

				return;
			}

			// **The decision — once per ball, not once per turn.** `pledged` holds the answer for the ball
			// this rig is currently facing, so a ball that stays on course for six turns is one question
			// asked once rather than six answers that each try again. A different ball is a new question,
			// and that is the whole of the bookkeeping.
			//
			// **One ball at a time, which is the same shape this had as a rate**: two balls coming at once are
			// one danger, and they share one answer, because the rig is only ever asked about the nearest.
			//
			// **The answer is `shouldDodge`'s, and that is the one expression the two variants differ in.**
			// The always variant answers `true`; the gated one flips `NPC_CONFIG.DODGE_CHANCE_PER_BALL`. Both
			// are asked *here*, once per ball, which is what makes either answer mean what it says.
			//
			// **And it is asked here rather than before the direction test, deliberately.** A rig with both
			// ways blocked has not used up its decision — the answer is stored and consulted again next turn,
			// when the ball is closer and the room may have changed. What a rig must never do is decide to
			// dodge, find no room, and then decide *again* on the next turn: that is the same ball being
			// asked about twice, which is the rate the older version of this file existed to get away from.
			let decision = pledged.get(model);

			if (decision === undefined || decision.ball !== threat) {
				decision = { ball: threat, dodging: shouldDodge(model, threat) };
				pledged.set(model, decision);

				// Said once, on the turn the rig decided — not on every turn the ball stays on course, which
				// would be the same line four or five times over.
				if (!decision.dodging) {
					note(model, root, threat, "let this one past");

					return;
				}
			} else if (!decision.dodging) {
				// The same ball, already judged and already refused: nothing to say and nothing to do.
				return;
			}

			// **The same method the player's remote handler calls**, not a second path: `requestDodge`
			// runs every gate — no living humanoid, `blocksDodge`'s freeze and catch state, the round or
			// practice zone, the cooldown, a usable direction — for a rig exactly as it does for a
			// character. Its answer is what the stamp above is set from.
			note(model, root, threat, "dodging");

			if (dodges.requestDodge(model, direction)) {
				lastDodgedAt.set(model, os.clock());
			} else {
				// **The service refused, so the rig runs instead of standing.** The common refusal for the
				// rigs that wear this tag is a catch window being open — they wear `Behavior_Catching` beside
				// it — and the others are the freeze, the zone, the round and the cooldown this file also
				// keeps. None of them is a reason to stay in the path of a ball, and the direction the dash
				// would have used is already chosen and already proved clear. See `runAway`.
				//
				// **The stamp above is left alone**, which is the point of it being stamped on success: a
				// refusal has not happened, so no cooldown is charged here — the walk is free to repeat every
				// turn the ball stays on course, and that repetition is what makes it a run rather than a step.
				runAway(model, root, direction);
			}
		},
	};
}

/**
 * The gated dodger — **the tag this file is named for, and the body above with one predicate in it.**
 *
 * A rig wearing `Behavior_Dodging` dodges `NPC_CONFIG.DODGE_CHANCE_PER_BALL` of the balls aimed at it.
 * The roll *is* the `shouldDodge` argument, so it is asked at the one place in the tick where a decision
 * is made — once per ball, held for as long as that ball is on course — and nothing else about this tag
 * differs from its sibling. See {@link makeDodgeBehavior} for the whole design, including the walk a rig
 * makes when its dash is refused, and `AlwaysDodgeBehavior.ts` for the tag that answers `true` to the
 * same question.
 *
 * **This function used to be the one-line wrapper in this file, over a body in the other one.** It is
 * the other way round now — see the body's doc for the rule and for what the old placement cost.
 */
export function createDodgeBehavior(dodges: DodgeService, balls: BallService): NpcBehavior {
	return makeDodgeBehavior(dodges, balls, BEHAVIOR_DODGING, () => math.random() < NPC_CONFIG.DODGE_CHANCE_PER_BALL);
}
