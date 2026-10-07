/**
 * Everything about the ball: how it is made, how long it lives, how far a model
 * can reach to take one, and how a throw at a target is solved.
 *
 * **This is the file to tune a ball in.** Nothing here is read from anywhere
 * else, so one edit moves every ball in the game — a throw, an NPC's throw, a
 * ball lying on the floor and the aim guide a player sees before they commit,
 * because the client solves from these same numbers (see `shared/throw.ts`).
 *
 * Imports nothing on purpose: a config that depended on a service would be a
 * service, and both sides of the wire read this one.
 *
 * Entries marked **placeholder** have no reader in the codebase yet. They are
 * kept here so the shape of the system is visible in one place, and so the knob
 * exists the moment something does read it.
 */
export const BALL_CONFIG = {
	// ---------------------------------------------------------------- physics

	/*
	 * **Air drag is deliberately absent, and must stay absent.**
	 *
	 * There is no velocity decay, no drag force and no other mid-flight velocity change
	 * anywhere in this file or in the code that reads it. That is a rule rather than an
	 * oversight: the throw solver (`shared/Trajectory.ts`) and the client's aim guide both
	 * assume pure ballistics, so a ball that slowed down in the air would fly a different
	 * curve from the one the guide drew — and the guide would then be lying rather than
	 * merely approximate.
	 *
	 * Everything below acts on the ball once it has *landed*.
	 */

	/**
	 * How much speed a grounded ball loses per second, in studs per second squared.
	 * **This is the knob that stops a ball, and the first one to tune.**
	 *
	 * It has to be here because the engine does not model rolling resistance. A ball
	 * rolling without slipping has no relative motion at the point of contact, so friction
	 * has nothing to push against and almost none of the ball's energy leaves it — which is
	 * why raising {@link BALL_CONFIG.GROUND_FRICTION} barely changed how long a ball rolled.
	 * Nothing in the engine stops a roll; this does.
	 *
	 * Applied by `BallService`'s settle loop to any loose ball that is on the floor, as a
	 * **constant deceleration** rather than a proportional one, because that is what rolling
	 * resistance physically is (about `μ·g`). Two consequences worth knowing:
	 *
	 * - A ball stops in `landing speed / this` seconds, so the distance it covers first is
	 *   `v² / 2 · this` — doubling this quarters every roll.
	 * - A gently rolled ball stops almost at once and a hard one takes its time, which is
	 *   what a real ball does, rather than every roll taking the same distance.
	 *
	 * Tune it by throwing a ball along a flat floor and timing the roll. Still the wrong side
	 * of a few seconds, raise it; a ball that looks like it hit a wall of treacle the moment
	 * it lands, lower it.
	 */
	ROLL_RESISTANCE: 80,

	/**
	 * How slowly a grounded ball may be moving before it is stopped outright, in studs per
	 * second. Read by `BallService`'s settle loop.
	 *
	 * The last resort rather than the mechanism. {@link BALL_CONFIG.ROLL_RESISTANCE} takes a
	 * rolling ball's speed to zero on its own, so this is for the leftovers: a ball walked
	 * along by a slope, one nudged by another ball, or the residue a bounce leaves behind.
	 * Higher snaps those to a dead stop sooner; too high and a genuinely slow ball — a nudge,
	 * a ball rolled gently off a kerb — reads as caught on something.
	 */
	MIN_SPEED: 1.5,

	/**
	 * How hard a ball grips the floor it lands on — **which is not how long it rolls.**
	 *
	 * It decides whether a landing ball grips and rolls or slides and skids, and that
	 * difference is visible. It is *not* what stops a roll: with no slip at the contact point
	 * a rolling ball has nothing for friction to act on, and a ball that grips immediately
	 * loses *less* of its speed than one that skids, so more friction can even lengthen a
	 * roll. Measured here rather than reasoned about — see
	 * {@link BALL_CONFIG.ROLL_RESISTANCE} for the number that does the work.
	 *
	 * Read by `BallService` as the ball's `CustomPhysicalProperties.friction`, whose engine
	 * maximum this is.
	 */
	GROUND_FRICTION: 10,

	/**
	 * How much of its approach speed a ball keeps when it bounces, as a fraction. Read
	 * by `BallService` as the ball's `CustomPhysicalProperties.elasticity`.
	 *
	 * A dodgeball thuds: it arrives, and nearly all of that energy goes into the floor and
	 * into the ball's own deformation instead of back up into the ball. A high value here is
	 * what turns dodgeball into chasing a superball.
	 *
	 * **This only affects bounces.** A ball that lands and rolls never bounces, so this
	 * changes nothing about how far that ball travels — which is why taking it down to almost
	 * no bounce left the roll exactly as it was. See {@link BALL_CONFIG.ROLL_RESISTANCE}.
	 */
	ELASTICITY: 0.5,

	/**
	 * The ball's mass per unit volume, in the engine's own units — roughly the density
	 * of the material the ball is pretending to be made of. Rubber is about this.
	 * Read by `BallService` as the ball's `CustomPhysicalProperties.density`.
	 *
	 * Worth knowing how little it changes: the curve's force is sized from the ball's
	 * mass when it is applied (`applyAcceleration`), so a denser ball is not a faster
	 * one — it is a heavier one, and it hits what it lands on harder. Its visible effect
	 * is on collisions, not on the flight and not on how it rolls.
	 */
	DENSITY: 1,

	// --------------------------------------------------------------- lifetime

	/**
	 * How long a thrown ball is left in the world before it is cleaned up, in
	 * seconds.
	 *
	 * Measured from the throw, so it is the life of a *projectile* rather than of
	 * a ball: a ball that has been caught since is somebody's, and is left alone —
	 * this is what stops the map filling with the ones nobody fetched.
	 *
	 * Long enough that a ball is still there when you go back for it, short enough
	 * that a field nobody is collecting does not become a carpet.
	 */
	LIFETIME_SECONDS: 60,

	// ---------------------------------------------------------------- spawner

	/**
	 * How far from a spawner part a ball still counts as "its", in studs.
	 *
	 * This is what makes the count mean *loose balls near the spawner* rather than *balls in the
	 * game*, and it is doing two jobs at once: it stops a spawner refilling itself with balls that
	 * have been thrown across the arena and are lying somewhere else entirely, and it stops one
	 * spawner counting another's. A ball being carried past still counts while it is inside the
	 * radius, which is close enough — it is a count of what is available here, not a ledger.
	 */
	SPAWN_RADIUS: 8,

	/**
	 * How far apart a spawner's balls land, in studs, as a maximum either side of the part.
	 *
	 * Purely to stop two balls stacking on one another at the same position, where they would settle
	 * into a single pile and read as one ball. It did more work when a part kept three of them, and it
	 * is kept now because two neighbouring spawners can still land a ball on each other's spot.
	 */
	SPAWN_OFFSET_RANGE: 2,

	/**
	 * How often each spawner's count is compared against the world, in seconds.
	 *
	 * The loop that reads this is a plain `while` with a `task.wait`, so this is the period it
	 * turns at. Loose, because nothing here is a response to the player: a ball that has been
	 * thrown is noticed missing a second late and replaced a second late, which is invisible.
	 */
	SPAWN_TICK_INTERVAL: 1,

	/**
	 * **Placeholder.** Balls wanted in the world per player, as a rate rather than a headcount.
	 *
	 * No reader, and no longer a design this project is following: the spawner that now exists
	 * counts one ball per part, with `MATCH_BALL_COUNT` as the arena's budget — see
	 * `src/server/config/match.config.ts` — because a ball's *place* is what matters when deciding
	 * whether the arena has enough of them. Kept only so the shape of the alternative is still
	 * visible; nothing reads it, and nothing should.
	 */
	BALLS_PER_PLAYER: 1.2,

	/** **Placeholder.** Floor on the per-player wanted count. See {@link BALL_CONFIG.BALLS_PER_PLAYER}. */
	MIN_BALLS: 2,

	/** **Placeholder.** Ceiling on the per-player wanted count. See {@link BALL_CONFIG.BALLS_PER_PLAYER}. */
	MAX_BALLS: 40,

	/** **Placeholder.** Seconds to wait after a ball goes before replacing it. See {@link BALL_CONFIG.SPAWN_TICK_INTERVAL}. */
	RESPAWN_DELAY: 2,

	// ----------------------------------------------------------------- pickup

	/**
	 * How far a model can reach to pick a loose ball up, in studs.
	 *
	 * Measured from the model's own position to the ball's, so this is a *reach and
	 * a half step* rather than a walk: a picker does not travel to the ball, it takes
	 * one that is already within this of it. Widen it and a picker starts collecting
	 * balls it never appeared to touch; narrow it and it has to be walked onto them.
	 *
	 * Read as the default for `BallPickupService.pickupNearest`, which takes its own
	 * radius — so a mechanic that wants a longer arm passes one rather than changing
	 * everyone's reach.
	 *
	 * **Widening this past {@link BALL_CONFIG.DROP_DISTANCE} breaks the drop.** A ball put
	 * down in front of a character would then land inside that character's own reach and be
	 * collected again the moment its per-ball lockout ran out — so `1` would stop meaning
	 * "get rid of it". The two are separate numbers, tuned for separate reasons, and the
	 * inequality is the only thing that binds them.
	 */
	PICKUP_RADIUS: 8,

	/**
	 * How often loose balls are looked for, in seconds.
	 *
	 * Shared by both automatic collectors — the loop that collects for every player
	 * and the `Behavior_Pickup` tag — because they are one mechanic asked on a timer.
	 * A walking character covers about 16 studs a second, so this wants to be short
	 * enough that nobody strides past a ball inside {@link BALL_CONFIG.PICKUP_RADIUS}
	 * between two looks, and long enough that the scan — which walks every tagged
	 * ball in the game — is not the most expensive thing the server does.
	 */
	PICKUP_TICK_INTERVAL: 0.3,

	// ------------------------------------------------------------------ throw

	/**
	 * How far in front of the thrower's torso the ball starts its flight, in studs,
	 * measured along the direction the body is facing.
	 *
	 * **Horizontal only.** The launch point's height is not a number here: it is read off the thrower's
	 * head, see `shared/throw.ts` → `getThrowMuzzle`. That is deliberate, because the height is the one
	 * part of the offset that differs between rigs, and a constant would be right on one of them and
	 * wrong on the other.
	 *
	 * Read this as a **lever arm**: it is the radius the launch point swings on when
	 * the character moves or turns, so every stud of offset multiplies body motion
	 * into the aim guide at a 1:1 ratio. A large value here makes the guide appear
	 * to wobble as you walk; it does not make the throw safer, because
	 * `CollisionIgnore` already guarantees the ball cannot hit its thrower.
	 *
	 * This is the one number to change to move the launch point horizontally. It is read in
	 * exactly one place — `shared/throw.ts` → `getThrowMuzzle` — which both the
	 * server (real throw) and the client (aim guide) call, so tuning it moves both
	 * together and the guide keeps telling the truth.
	 */
	THROW_MUZZLE_DISTANCE: 2,

	/**
	 * Floor on the launch speed, in studs per second.
	 *
	 * **A floor, not the speed a ball is thrown at.** Every arc solves its own speed from the
	 * distance and its launch angle — see `flatLaunchSpeed` and
	 * {@link BALL_CONFIG.THROW_ARC_SPREAD} — and this only raises that solve when it comes out
	 * lower. So it is invisible on any throw that solves above it, and it is the whole answer on a
	 * short one.
	 *
	 * **It is 0, which is to say there is no floor, and that is deliberate.** It used to be 100, on
	 * the reasoning that a throw should always leave the hand with authority. But 100 studs per
	 * second already carries a ball nearly nine studs at the flat angle, so the floor quietly
	 * replaced the solve on every close throw: aiming two studs in front of you put the ball nine
	 * studs away, and nothing could be thrown closer than about nine studs flat, or twenty-six
	 * arcing. The solve is the honest answer at every distance — and it is what the aim guide
	 * draws, so a floor above it is what makes the drawn line a different line from the one the
	 * ball flies. Raise it again if a close throw ever wants more authority than accuracy.
	 */
	THROW_SPEED: 0,

	/**
	 * The gravity the ball falls under, in studs per second squared — **not the world's**.
	 *
	 * **Placeholder.** The ball is an ordinary unanchored `Part`, so the engine pulls it down at
	 * `Workspace.Gravity` like everything else, and Roblox has no per-part gravity property to set instead.
	 * `BallFactory` therefore cancels the *difference* with a `VectorForce` on each ball: raise this number
	 * towards the world's and the ball falls heavier, lower it and the ball hangs. The world is untouched, so
	 * characters, corpses and loose parts keep falling at the arena's own gravity.
	 *
	 * **That force is only real if it is given an `Attachment0`.** A `VectorForce` pushes on the attachment it
	 * is handed and on nothing else, so one with none is inert — no error, no warning, and the ball simply
	 * falls at the world's gravity while every solve and every prediction in the game says otherwise. It is
	 * worth knowing because the symptom is not "the ball is too heavy": it is a throw that lands short, and a
	 * log full of plans that all look correct.
	 *
	 * **Both sides read this**, and that is the point of it being here rather than inline: the throw solve in
	 * `shared/throw.ts` has to curve the ball under the same pull the engine will apply, or the aim guide draws
	 * a path the ball does not fly — a trajectory that lies, which is worse than one that misses. A number
	 * decided in two places is a number that will disagree.
	 *
	 * **Flight time is the knob, not speed.** Lowering this lengthens the ball's hang, which is what makes a
	 * throw watchable and catchable; the speed that then covers the distance is `THROW_MAX_SPEED`'s business.
	 */
	BALL_GRAVITY: 80,

	/**
	 * How much faster than the bare minimum the arcing throw is launched, as a
	 * multiplier.
	 *
	 * The throw is solved by picking between the quadratic's two roots, and at
	 * exactly the minimum speed those roots coincide — one arc, not two. This is
	 * how far above that minimum it is thrown, so it sets how flat the arcing throw
	 * sits: the two roots meet at 45° when the speed is exactly the minimum, and
	 * raising this pulls the flatter of the two down from there.
	 *
	 * **It also keeps the solve off a numerical knife edge.** At exactly 1.0x the
	 * discriminant is zero and the target sits precisely at the arc's limit, so the
	 * whole answer swings on floating-point noise in the launch point. That was a
	 * real bug here: the landing marker wandered on long throws and sat still on
	 * short ones. Do not take this below about 1.05.
	 *
	 * It does not affect the straight throw at all — that one is barely thrown and
	 * gets its speed from the fall instead. See `flatLaunchSpeed`.
	 *
	 * A side effect worth knowing: the furthest reachable target is
	 * `(THROW_MAX_SPEED / THROW_ARC_SPREAD)² / gravity`, so raising this eats into
	 * range unless {@link BALL_CONFIG.THROW_MAX_SPEED} comes up with it.
	 */
	THROW_ARC_SPREAD: 1.4,

	/**
	 * Ceiling on the automatic wind-up, in studs per second.
	 *
	 * Note this is the *pre-spread* figure. After {@link BALL_CONFIG.THROW_ARC_SPREAD},
	 * the furthest reachable target is `(THROW_MAX_SPEED / THROW_ARC_SPREAD)² / gravity`
	 * — past that a throw falls short and the aim guide's landing marker shows you
	 * exactly where.
	 *
	 * **This is the only speed figure that slows a `straight` throw down.** The flat arcs solve
	 * their own speed from the distance and their launch angle, so they routinely land well
	 * above {@link BALL_CONFIG.THROW_SPEED} — which is a *floor*, and does nothing here. At the
	 * flat angle a 60-stud throw wants about 250, so a cap below that is what decides the throw
	 * instead of the solve.
	 *
	 * The price is reach, and it is steep: at that same flat angle range goes as `v²·sin(10°)/g`,
	 * so this figure at 200 reaches roughly 35 studs where 280 reached about 70. Lowering the
	 * angle instead would slow the ball without costing range, but it would stop the throw being
	 * flat — see `MIN_THROW_ANGLE` in `shared/Trajectory.ts`.
	 */
	THROW_MAX_SPEED: 150,

	/**
	 * **A multiplier on the derived launch correction. It should stay at 1.**
	 *
	 * The correction is no longer a value anybody picks, and no longer only vertical — it is computed
	 * at every throw from the acceleration the ball is about to fly under:
	 *
	 * ```
	 * correction = -½ · dt · pull,   pull = plan.acceleration - gravity
	 * ```
	 *
	 * which for the gravity-only arcs is the figure this field was written for,
	 * `THROW_VERTICAL_BOOST_SCALE * gravity / (2 * Workspace:GetRealPhysicsFPS())`, aimed straight up. That
	 * `gravity` is now the ball's, taken from the plan, and no longer the world's.
	 *
	 * **The world's gravity in the shape this replaces is a fossil, and a telling one.** The fixed value this
	 * field used to hold — `THROW_VERTICAL_BOOST: 2.5` — works out to a boost for `196.2`, and it was measured
	 * as correct. It *was* correct: the ball's gravity force had no `Attachment0`, so it was inert and the
	 * ball really did fall at `Workspace.Gravity` — at two and a half times everything else in the game
	 * believed. A derived figure disagreeing with a hand-measured one is the finding, not the obstacle. See
	 * {@link BALL_CONFIG.BALL_GRAVITY}.
	 *
	 * **Why that shape.** The engine's integrator advances a body by its current velocity and only
	 * then bends it, so a step's worth of the pull is missing from the velocity that step acts on: the
	 * ball gains `½·a·dt·t` of position along `a` on top of the arc it was solved for. That is a
	 * *velocity*, which is why it is added to the launch rather than scaled into it — and `dt` is the
	 * physics step, so `1/dt` is the rate the server steps at and the loss is inversely proportional to
	 * it. `GetRealPhysicsFPS()` reports that rate. **The integrator does not care which way `a` points**,
	 * which is why the correction is taken from the whole pull rather than from gravity.
	 *
	 * A correction for the engine, not a design choice. Measured on the server: the ball flies as
	 * though it left the hand slower along the pull than the velocity that was written to it, and stays
	 * that much behind for the whole flight — so the shortfall in position grows as `correction·t`, and
	 * the longer the throw the further the ball sits off the line it was solved for. The drawn arc is
	 * the solved one, so what that looks like from the player's seat is a trajectory running above the
	 * ball.
	 *
	 * **Amended, because `pull` is not always gravity and only gravity's half used to be here.** For a
	 * curve the pull carries the sideways acceleration the ball flies under, and half a step of *that*
	 * was never taken off the launch — so a curve flew its solved arc plus `½·a·dt·t` of extra bow,
	 * invisible at the start of the flight and worth about `½·a·dt·flightTime` studs (0.76 on a 0.31 s
	 * throw) at the landing, in the direction of the bow. Straight and overhead throws were unaffected
	 * because they have no pull to be wrong about, which is the whole of why this read as a
	 * curve-only miss for so long. This dial scales both halves, so `0` still means pure ballistics —
	 * now on both axes — and `1` is still the only setting the derivation supports. See
	 * `BallService.launchCorrection` for the arithmetic and the log that found it.
	 *
	 * **What the fixed value this replaces was doing.** It was `THROW_VERTICAL_BOOST: 2.5`, and 2.5
	 * is the right boost for a server stepping physics at `196.2 / (2 · 2.5) ≈ 39 FPS`. The rate
	 * measured for this change was **60**, where the derivation asks for `196.2 / 120 = 1.635` — so
	 * the fixed figure was over-boosting by about 0.87 studs per second, carrying the ball *above*
	 * the drawn arc by `0.87 · flight time` studs instead of sagging below it. It was never measured
	 * against the rate the game actually runs at, which is the whole of why it is derived now.
	 *
	 * **Start at 1, and the honest test is whether it stays at 1.** A derivation that needs a fudge
	 * factor is a derivation that is wrong, and the thing to change is the formula rather than this.
	 * A consistent residual at this setting is evidence about the *shape* of the loss — read it
	 * before turning this dial, because turning it hides the evidence without explaining it.
	 *
	 * **Tune it against the ball, not with arithmetic.** `BallService`'s DEBUG print shows the
	 * commanded velocity, both halves of the correction it applied and the rate it read, and
	 * `ThrowProbe` reports how far the ball drifts from the plan's own curve — that drift is the
	 * number to drive to zero.
	 *
	 * **The correction belongs on the ball, not on the drawing.** Subtracting the same figure from the
	 * guide's launch was tried (`PREDICTION_VERTICAL_BIAS`) and removed: it moves the landing *marker*
	 * by `2·v_h·boost/g`, and `v_h` differs by mode, so it dragged the three modes' marks apart by a
	 * different amount each. Correcting the throw instead leaves every marker where it was and simply
	 * makes the ball fly the line they came from.
	 *
	 * 0 restores pure ballistics and the shortfall with it.
	 */
	THROW_VERTICAL_BOOST_SCALE: 1,

	/**
	 * A hand-tuned nudge to where the ball is put on its launch, in the throw's **own** frame, in studs.
	 *
	 * **The one place a throw can be corrected after the plan has been solved, and the only place it can
	 * be done without moving the aim guide.** Everything that shapes the flight — the muzzle, the aim
	 * point, the solve, the arc — lives in `shared/throw.ts`, which the client calls with the same
	 * inputs to draw the line the player is aiming with. A tune in there moves the marker as well as the
	 * ball, so it cannot tell you which of the two you were right about. This is downstream of all of it:
	 * the plan is already made, and this shifts where the ball starts by three fixed numbers.
	 *
	 * - `forward` — along the line to the mark. A miss *long* or *short*.
	 * - `left` — to the left of that line, which is the axis a curve bows on, because `leftAxis` is what
	 *   the bow is built from. A curve that lands wide is this number.
	 * - `up` — world up. A ball arriving high or low.
	 *
	 * **What it costs: the ball no longer starts on the drawn line.** A shift here translates the whole
	 * flight, so the landing moves by the same vector and the shape is untouched — which is what makes it
	 * usable as a dial, a measured miss being one number to subtract. `ThrowProbe` sees it as a
	 * *constant* `path` offset, never a growing one, and that is how it is told apart from a real solve
	 * error while it is in.
	 *
	 * **Zeroed, and it should stay zeroed.** A non-zero nudge is a fault in the plan being papered over.
	 * Tune with it, write down what it took, fix the cause, and put it back to zero.
	 */
	THROW_LAUNCH_NUDGE: { forward: 1, left: 0.5, up: 0 },

	/**
	 * Launch angle of the curveball, in degrees.
	 *
	 * A flat launch at a fixed angle has exactly one speed that lands on a given
	 * point (`v = √(g·d / sin 2θ)` on level ground), so **this is the curve's speed
	 * control**: flatter means harder, and steeper is what keeps the curve the slow,
	 * readable throw a curveball should be rather than the fastest thing on the
	 * field.
	 *
	 * Steeper also buys bend per unit of pull, because the pull has a longer flight
	 * to work in; it buys a slower flight for the same reason. It does **not** change
	 * how far the ball bows for a given launch angle off the aim line — that
	 * relationship is the same at every angle, see {@link BALL_CONFIG.CURVE_STRENGTH}.
	 *
	 * Two side effects worth knowing:
	 *
	 * - The curve is deliberately never floored at {@link BALL_CONFIG.THROW_SPEED}.
	 *   A flat throw launched faster than its solve overshoots the mark, and at a
	 *   steep enough angle the solve sits under the floor for most short targets.
	 * - Aiming above the launch line no longer forces a fallback to an overhead
	 *   throw so easily: the line climbs `d·tan θ`, so the more this angle rises,
	 *   the further the aim can rise above the hand before the flat solve gives up.
	 */
	THROW_CURVE_ANGLE: 20,

	/**
	 * How hard a curveball is pulled sideways, in studs per second squared, toward
	 * the thrower's left.
	 *
	 * A curve is not a launch angle — it is a force acting for the whole flight, so
	 * this is an **acceleration** (studs/s²), not a velocity. There is no "how fast
	 * does it go sideways" number to eyeball, so these are the formulas.
	 *
	 * **The maths.** The pull is perpendicular to the throw, so it never touches the
	 * in-plane flight: the flat solve runs exactly as `straight` runs it, and the
	 * sideways offset rides on top of it. With the flight time `T` that
	 * {@link BALL_CONFIG.THROW_CURVE_ANGLE} sets, the two ways to fly it are one line
	 * each:
	 *
	 * ```
	 * compensated:    bow   = a·T² / 8
	 * uncompensated:  drift = a·T² / 2       (4× as far)
	 * ```
	 *
	 * On level ground at the curve's own `THROW_CURVE_ANGLE` those reduce to
	 *
	 * ```
	 * bow ≈ a·d / 2156       drift ≈ a·d / 539       tan φ = a·tan θ / g
	 * ```
	 *
	 * so **`a ≈ 2156·B/d` for a bend of `B` studs**, the coefficients being what
	 * gravity and the launch angle make of the ratio. A bow is therefore the same
	 * *fraction* of the distance travelled, and the launch leaves the aim line wide
	 * by `φ` at every range — which is why a bend can be chosen once and hold
	 * whether the target is near or far.
	 *
	 * **That launch angle is geometry, not tuning.** Written as `d·tan φ / 4`, the bow
	 * and the launch's off-line angle are revealed as one quantity: with both ends of
	 * the flight pinned to the mark, the only way to bow is to leave wide of it.
	 * {@link BALL_CONFIG.THROW_CURVE_ANGLE} cannot change that — it decides how fast
	 * and how long the flight is, not how far it bends. See
	 * {@link BALL_CONFIG.THROW_CURVE_COMPENSATED} if a side-armed launch is not the
	 * look you want.
	 *
	 * **This number is also the curve's speed.** The sideways launch the compensation
	 * needs adds to the throw rather than replacing any of it — `v_lat = ½·a·T` — so
	 * a large `a` leaves the hand mostly sideways and the curve reads as the fastest
	 * throw in the game rather than the slowest. That is the trap this value was
	 * tuned around: the in-plane flight can be slow while the total velocity is not.
	 *
	 * The sign is a handedness, not a direction: positive bends left, left being
	 * relative to the throw, so it stays correct whichever way you are facing — see
	 * `leftAxis` in `shared/Trajectory.ts`.
	 */
	CURVE_STRENGTH: 300,

	/**
	 * Whether a curveball's launch cancels its own drift, so it lands on the mark.
	 *
	 * - `true` (the default): the launch leaves the aim line wide by `φ` and the pull
	 *   brings it back. The ball arrives where the marker is, and the visible bend is
	 *   its deviation from the straight line.
	 * - `false`: the launch goes straight at the target, the pull carries the ball
	 *   off it, and it lands `a·d/539` studs short of the aim point. The aim guide's
	 *   marker moves with it, so the guide is still showing the truth — it is the
	 *   throw that changed, not the honesty.
	 *
	 * Off is the natural-looking version: aimed at the target and visibly bending
	 * away from it, instead of slung wide and swung back in. What it gives up is the
	 * guarantee that every arc lands on the same mark — a curveball becomes a place
	 * you aim off, not a place you point at.
	 *
	 * **Flipping this changes what {@link BALL_CONFIG.CURVE_STRENGTH} looks like by
	 * 4×.** To keep the same visible bend across the flip, divide it by 4 — and read
	 * that entry's comment for where the factor comes from.
	 */
	THROW_CURVE_COMPENSATED: true,

	// ------------------------------------------------------------------ chain

	/**
	 * How much of its speed a ball keeps when it comes off a body it has just hit, as a
	 * fraction. Read by `BallComponent`. **The one number that sets bounce energy.**
	 *
	 * A body is not a wall, and the engine's own elasticity cannot tell them apart: it
	 * bounces a ball off everything at a strength set by the two materials, and there is no
	 * way to ask it for "springs off people, thuds off walls". So the bounce off a body is
	 * applied by hand — the ball's velocity reflected about the line from the part it
	 * touched to its own centre — and this scales the result. Higher carries a chain
	 * further; at 1 no energy is lost at all and one throw crosses the arena, and low
	 * enough and the ball dies in the player it hit and there is no chain to speak of.
	 */
	BOUNCE_FACTOR: 0.5,


	// -------------------------------------------------------------------- drop

	/**
	 * How far in front of the character a dropped ball is placed, in studs, measured along
	 * the direction the body is facing. Read by `BallService.dropBall`.
	 *
	 * **Must stay greater than {@link BALL_CONFIG.PICKUP_RADIUS}, and that inequality is
	 * the whole reason this is not zero.** A ball put down inside auto-pickup reach is a
	 * ball handed straight back the moment its lockout expires, so the key would do
	 * nothing for a standing player — exactly the case it exists for. It is a separate
	 * number from the reach rather than derived from it because the two are tuned for
	 * different things, how far a drop goes and how far an arm is, and neither should have
	 * to move because the other did.
	 *
	 * **A maximum, not a promise.** The drop is cast forward first and the ball is placed
	 * short of whatever that finds, so a character facing a wall puts the ball down in front
	 * of the wall rather than inside it — or, if the wall is thin, on the far side. Nothing
	 * here needs retuning for that: the ray can only shorten the drop. See
	 * `BallService.dropReach`.
	 *
	 * Forward is *the character's* facing, never the camera's: a drop is not aimed, and a
	 * key that put the ball somewhere different depending on where you happened to be
	 * looking would be worse than one that always puts it in the same place relative to
	 * the body.
	 */
	DROP_DISTANCE: 10,

	/**
	 * How far above the character's `HumanoidRootPart` a dropped ball starts, in studs.
	 *
	 * In the air on purpose, so the ball falls onto a clear patch of floor rather than
	 * being placed into the ground it is standing on: a ball put down at foot height begins
	 * its life intersecting the floor, and the only thing the engine can do with an overlap
	 * is shove it out. The fall is therefore the drop's own settling — and the reason
	 * {@link BALL_CONFIG.DROP_PICKUP_LOCKOUT} exists, since a ball in the air is not a ball
	 * anybody should be able to take yet.
	 */
	DROP_HEIGHT: 2,

	/**
	 * How long a just-dropped ball cannot be picked up by anyone, in seconds. Read by
	 * `BallPickupService`, stamped on the ball as `PICKUP_LOCKED_UNTIL`.
	 *
	 * **Per ball, not per dropper.** What needs the beat is the ball — it is still falling,
	 * and then still rolling — so the window has nothing to do with whose hand it came out
	 * of, and a different player walking over it inside the window is blocked by it as well.
	 * That is what the window is for, and it is why the time is kept on the ball.
	 *
	 * Long enough to cover the fall and the roll to a stop; short enough that a ball put
	 * down deliberately does not look like a ball nobody can ever have.
	 */
	DROP_PICKUP_LOCKOUT: 1.0,

	// ------------------------------------------------------------- appearance

	/**
	 * The ball's own colour: **one red, and the same red for every ball that has not been given
	 * something else.**
	 *
	 * **This replaces a random colour, and removing the randomness is the whole of the change.**
	 * `SphereService` used to ask for a fresh `BrickColor.random()` for every ball it made, so the
	 * colour a ball wore said nothing at all: it differed per *instance* rather than per *player*, it
	 * was different again on every spawn, and it was different again every time somebody picked up a
	 * ball that had already existed. A colour with no reader and no meaning is one that costs the only
	 * thing a ball's appearance is good for — saying whose ball this is.
	 *
	 * **What it is for now is a baseline, and the baseline is the point.** This is the colour of a loose
	 * ball in the arena and of a player who has nothing equipped, with no exceptions: every ball in the
	 * game wears this one unless a *holder* has brought something else to it, so "wearing something
	 * else" is a fact about a player rather than a fact about a spawn. The design is heading toward
	 * per-ball appearance owned by whoever is holding the ball, and a single predictable default is
	 * what that diverges from — with a random fallback there would be nothing for an equip to be a
	 * *change* from, because "no cosmetic equipped" would have to mean "whatever this one rolled".
	 *
	 * **A red, and the classic one.** A dodge ball is a red ball in every version of the cliché this
	 * game is quoting, and `196, 40, 28` is the `Color3` behind the engine's `Bright red` — the colour
	 * a person setting one in Studio arrives at, rather than a red invented here.
	 *
	 * **Deliberately not read by the trail.** `TRAIL_COLOR_*` below are the trail's own colours and are
	 * independent of this on purpose: a ball's paint and its trail are two axes, and the per-ball work
	 * that follows this is expected to move the first without touching the second. See
	 * `BallTrail.attach`, which takes the trail's colours as a parameter for exactly that reason.
	 */
	BALL_COLOR: Color3.fromRGB(196, 40, 28),

	// ------------------------------------------------------------------ trail

	/**
	 * Whether a thrown ball leaves a trail at all.
	 *
	 * The kill switch for the whole effect, and a **creation** switch rather than a
	 * visibility one: while this is false no ribbon is built, so "off" means the instances
	 * are not there rather than that they are there and idle. One edit here turns the trail
	 * off everywhere, because a player's throw and an NPC's are the same ball and the same
	 * code.
	 */
	TRAIL_ENABLED: true,

	/**
	 * How many ribbons the trail is made of, arranged evenly around the ball's own axis.
	 *
	 * **This is the whole trick behind the trail looking round.** A single `Trail` is a flat
	 * strip that always turns to face the camera, so one of them reads as a sticker on the
	 * screen however good its taper is. Several at a spread of angles give the eye a
	 * cross-section instead: whatever the camera angle, at least two are near face-on and
	 * the composite is read as a tube. This is the standard Roblox answer to "3D trail",
	 * because a `Trail` is the only thing that *records a path* and a path is what makes the
	 * trail bend with a curving throw instead of snapping to the ball's current heading.
	 *
	 * `4` gives a full star at `0°`, `45°`, `90°` and `135°`, and is the default to judge
	 * everything else by. `2` — a plain cross, `0°` and `90°` — is the cheap version and is
	 * what to drop to if a busy server starts to notice.
	 *
	 * **This count is the halo's too**, because the two layers are meant to be one tube at two
	 * thicknesses rather than two different shapes — see {@link BALL_CONFIG.TRAIL_HALO_ENABLED}. So a
	 * ball in flight now costs twice this in trails and in attachments: at `4` that is eight trails
	 * drawing and sixteen attachments riding the ball, and eight balls all in the air would be
	 * sixty-four trails. Lower it here or switch the halo off there; either one halves the same number.
	 *
	 * Three at `60°` also works and sits between the two. Any count divides the circle
	 * evenly, so this is the only number to change.
	 */
	TRAIL_COUNT: 4,

	/**
	 * How long each trail segment lives, in seconds — **which is what sets the trail's
	 * length.**
	 *
	 * A trail is a record of where the ball has been, so its length is how far the ball
	 * travelled while the oldest segment was still alive: `speed × this`. That is the whole
	 * reason a thrown ball draws a long streak and a rolled one draws almost none, and it is
	 * the number to reach for when a hard throw draws further than it should. It is a time,
	 * not a distance, so it is not the length itself — at
	 * {@link BALL_CONFIG.THROW_MAX_SPEED} this is a hundred and forty studs of drawing, and an
	 * ordinary two-hundred-stud-a-second throw leaves a wake about a hundred studs long.
	 *
	 * **Long is the point, and this went up from `0.4` for that reason.** The whole effect is a claim
	 * about where a ball came from, and the claim is only useful if it is still on screen by the time
	 * somebody looks up — so the length is what makes the throw *readable* rather than merely visible.
	 * What it costs is drawing: every second of lifetime is another sixty segments alive per ribbon, and
	 * this is the number in this block that would come down first if the arena ever looked like it was
	 * full of tubes.
	 *
	 * The halo has its own, deliberately longer — see {@link BALL_CONFIG.TRAIL_HALO_LIFETIME}.
	 */
	TRAIL_LIFETIME: 0.5,

	/**
	 * How wide each ribbon is where it leaves the ball, as a fraction of the gap between its
	 * two attachment points.
	 *
	 * A scale rather than a stud measurement because the gap is what a ribbon's width
	 * *is* — see {@link BALL_CONFIG.TRAIL_SPREAD}, which sets it. `1` is the full gap.
	 *
	 * **Above `1` on purpose, and that is the flare.** At `1` the ribbon is exactly as wide as the pair
	 * of attachments it spans, and those sit *inside* the ball — see
	 * {@link BALL_CONFIG.TRAIL_SPREAD} — so the ribbon's edges are hidden behind the ball's own
	 * silhouette and the head of the trail has no shape of its own. Above `1` the ribbon comes out past
	 * it, and the size of that overhang is `2 × TRAIL_SPREAD × this` ball diameters across: at the values
	 * here that is a ribbon about `1.69` studs wide on a ball that is `1.5`, so a little under a tenth of
	 * a stud of ribbon shows on each side of the ball. A small overhang and a large difference — the head
	 * becomes something the ball is *emerging from* rather than a line it is dragging, which is the whole
	 * of what separates a comet from a streamer.
	 *
	 * **Not much further than this, though.** Past about `1.5` the head is an opaque bar wider than the
	 * ball, and since every ribbon is opaque at that keypoint it hides the thing that is supposed to be
	 * flying — which is a real cost for a game where watching the ball is the game.
	 *
	 * This is the widest point of the whole ribbon — see {@link BALL_CONFIG.TRAIL_WIDTH_NECK} for the
	 * step down that follows it, which is the other half of the shape.
	 */
	TRAIL_WIDTH_LEADING: 1.25,

	/**
	 * How wide each ribbon is at the neck, as a fraction of the gap —
	 * {@link BALL_CONFIG.TRAIL_WIDTH_LEADING}'s scale, measured
	 * {@link BALL_CONFIG.TRAIL_WIDTH_NECK_AT} of the way along the ribbon.
	 *
	 * **The number that makes the trail read as *fast*.** A ribbon that goes from the flare straight to
	 * the tail falls away at a constant rate, and a constant rate reads as a cone: a shape, sitting
	 * there, rather than something moving. Dropping sharply just behind the flare and then easing out
	 * gives the eye a hot head with a wake, and it is the wake that says *this was going somewhere*. It
	 * is the same trick as the middle keypoint in {@link BALL_CONFIG.TRAIL_COLOR_MIDDLE}, applied to the
	 * silhouette rather than to the colour.
	 *
	 * **Just over a third of the flare, which is about where the step becomes visible.** At `1` there is
	 * no neck at all and the trail is the cone above; much under a quarter of the flare and the head is a
	 * disc on a thread, which reads as a lollipop rather than as speed.
	 */
	TRAIL_WIDTH_NECK: 0.45,

	/**
	 * How far along the ribbon the neck sits, from `0` (at the ball) to `1` (the oldest end).
	 *
	 * **Before a quarter, and that is deliberate.** This is the position the flare falls from, so it
	 * decides how much of the trail is head: later and the trail is a stubby teardrop with a thin
	 * line behind it, earlier and the flare itself has no room to be seen and the whole thing is a
	 * taper with a bump on the front.
	 */
	TRAIL_WIDTH_NECK_AT: 0.22,

	/**
	 * How wide each ribbon is at its oldest end, on the same scale as
	 * {@link BALL_CONFIG.TRAIL_WIDTH_LEADING}.
	 *
	 * Near-zero rather than zero, because a segment of no width at all is simply not drawn:
	 * this is a *point*, and that point is what makes the shape read as motion in a
	 * direction rather than as a ribbon the ball happens to be dragging.
	 */
	TRAIL_WIDTH_TRAILING: 0.05,

	/**
	 * The trail's colour where it leaves the ball.
	 *
	 * Warm white rather than pure white, so the head reads as the hot end of something
	 * rather than as a plain painted line. Paired with {@link BALL_CONFIG.TRAIL_COLOR_MIDDLE} and
	 * {@link BALL_CONFIG.TRAIL_COLOR_TRAILING} for the fade behind it — a `Trail` takes its colour as a
	 * sequence, so unlike a single part it can carry the whole gradient on its own and needs no second
	 * instance to do it. Three keypoints rather than two, for the reason the middle one gives.
	 */
	TRAIL_COLOR_LEADING: Color3.fromRGB(255, 255, 240),

	/**
	 * The colour a third of the way down the trail, and **the one that makes it fire rather than
	 * ribbon.**
	 *
	 * A `ColorSequence` interpolates between its keypoints in a straight line through the colour, and
	 * white to dull red is a straight line through *grey*: with the two ends this block used to have,
	 * the middle of every trail was a pale washed-out pink that read as a faded strip rather than as
	 * something cooling. An amber keypoint puts a saturated step in the way — the trail goes white-hot,
	 * then orange, then embers — and the eye reads that as heat rather than as a gradient. It costs one
	 * keypoint.
	 *
	 * See {@link BALL_CONFIG.TRAIL_COLOR_MIDDLE_AT} for where it sits.
	 */
	TRAIL_COLOR_MIDDLE: Color3.fromRGB(255, 166, 48),

	/**
	 * How far along the trail the middle colour sits, from `0` (at the ball) to `1` (the oldest end).
	 *
	 * **Early, and a little behind the neck.** The hot end of a thrown ball is short and the cooling tail
	 * is long, so the amber belongs near the ball where the eye is anyway; push this past the halfway
	 * point and the trail starts to look like it is on fire at the back and cold at the front, which is
	 * the one thing a cooling trail must not say. It is deliberately *not* the same figure as
	 * {@link BALL_CONFIG.TRAIL_WIDTH_NECK_AT}, though it sits close to it: a width break and a colour
	 * break at the same point read as a joint in a manufactured thing, so the silhouette gets there first
	 * and the colour follows it.
	 */
	TRAIL_COLOR_MIDDLE_AT: 0.3,

	/**
	 * The trail's colour at its oldest end, on the same scale as
	 * {@link BALL_CONFIG.TRAIL_COLOR_LEADING}.
	 *
	 * A dull red, so the trail cools as it recedes: white-hot at the ball, embers behind it,
	 * and gone. This runs alongside the transparency fade rather than instead of it, which is
	 * what stops the tail reading as a solid red rod — it is dark *and* see-through by the
	 * time the lifetime is up.
	 */
	TRAIL_COLOR_TRAILING: Color3.fromRGB(140, 41, 20),

	/**
	 * How far each ribbon's two attachment points sit from the ball's centre, as a fraction
	 * of the ball's own diameter — **which is the trail's thickness.**
	 *
	 * The distance between a ribbon's two attachments is the ribbon's width, and both of
	 * them sit on a line through the ball, so this is half of the trail's diameter. A
	 * fraction rather than a stud count so the trail stays in proportion if `BALL_SIZE` is
	 * ever changed; the exact value is not delicate, it only sets how fat the tube looks.
	 *
	 * **This is the core's thickness and the halo's is a separate, larger number** — see
	 * {@link BALL_CONFIG.TRAIL_HALO_SPREAD}. Together they are the whole reason the effect has two
	 * layers, so the relationship worth holding on to is that this one has to stay the *smaller* of the
	 * two. What the value itself means in studs: the attachments sit this fraction of a ball diameter
	 * from the ball's centre, so at `0.45` they are `0.675` studs out on a ball whose surface is at
	 * `0.75`. That is *inside* the ball, which is what hides the ribbon's edges behind the ball's own
	 * silhouette until {@link BALL_CONFIG.TRAIL_WIDTH_LEADING} flares the head out past it — the two
	 * numbers are one shape between them and only make sense together.
	 */
	TRAIL_SPREAD: 0.45,

	// ----------------------------------------------------------- trail: texture

	/**
	 * A texture for the ribbons. **THE USER UPLOADS THIS — `""` means none, which is the default.**
	 *
	 * The one upgrade left in this block that is not a number, and the honest reason it is empty: every
	 * other entry here is a shape or a colour chosen from what the engine draws natively, while a texture
	 * has to exist as an uploaded asset and nothing on disk can stand in for one — the same argument
	 * `SUPER_CONFIG.FREEZE_AURA_TEXTURE` makes about the same kind of id. Empty means every ribbon is
	 * drawn with the engine's own plain gradient, which is what this effect has always done.
	 *
	 * **What it buys.** A `Trail` with no texture is a solid ribbon whose only gradient is the ones this
	 * file draws *along* it, and its edges are hard: it has a definite outline from every angle, which is
	 * what a streamer has and a beam of light does not. A soft-edged streak — one that fades across the
	 * ribbon's width as well as along it — is most of the difference between a bright line and something
	 * that looks like it is giving off light.
	 *
	 * **Applied to both layers**, because one texture at two thicknesses keeps them reading as one
	 * object: a texture on the core and none on the halo would put the hard edge back around the middle
	 * of the effect, where it is hardest to miss.
	 */
	TRAIL_TEXTURE: "",

	/**
	 * How the texture above is laid out along a ribbon. **Ignored while
	 * {@link BALL_CONFIG.TRAIL_TEXTURE} is empty.**
	 *
	 * `Stretch` is the engine's default and the one chosen here: the image is stretched over the ribbon's
	 * whole length, so a texture that is itself a bright-to-dark gradient reads as the fade this file was
	 * already drawing, only softer — which is the safe first thing to try. `Wrap` repeats the image
	 * instead, at {@link BALL_CONFIG.TRAIL_TEXTURE_LENGTH}, and is the choice for a *tiling* streak: a
	 * dash, a chevron or a run of arrows, which is a different and much more deliberate look.
	 */
	TRAIL_TEXTURE_MODE: Enum.TextureMode.Stretch,

	/**
	 * How long one repeat of the texture is, in studs. **Ignored unless
	 * {@link BALL_CONFIG.TRAIL_TEXTURE_MODE} is `Wrap`.**
	 *
	 * Only meaningful for a repeating texture, and the number to think in is how many dashes a throw
	 * should be: a full-speed wake is about a hundred and forty studs long — see
	 * {@link BALL_CONFIG.TRAIL_LIFETIME} — so this at `8` is roughly seventeen dashes on a hard throw
	 * and two or three on a lob. Large enough to read as separate marks rather than as a flicker, small
	 * enough that the gaps do not turn the trail into a dotted line.
	 */
	TRAIL_TEXTURE_LENGTH: 8,

	// -------------------------------------------------------------- trail: halo

	/**
	 * Whether a second, wider and softer set of ribbons is drawn around the core ones. **Creation
	 * switch**, in the shape of {@link BALL_CONFIG.TRAIL_ENABLED}: false and the ribbons are never
	 * built.
	 *
	 * **Why there is a second layer at all.** One set of ribbons can only be one thickness, and the two
	 * thicknesses this effect wants are opposites: a narrow hot core that reads as a line of light, and a
	 * broad dim haze around it that reads as heat. As one ribbon you have to pick one — thin enough to
	 * be a streak and there is no glow, fat enough to glow and it is a curtain — and the picture is not a
	 * compromise between them, it is both at once. Where they overlap the translucency does the rest: a
	 * soft edge over a hard one is most of what "glowing" means.
	 *
	 * **The halo is the polish and the core is the effect**, so this is the half to switch off: with it
	 * false a ball flies exactly what this block drew before there was a halo, and a busy server gets back
	 * the other half of {@link BALL_CONFIG.TRAIL_COUNT}'s cost. The layer is drawn at angles *between*
	 * the core's, so switching it off leaves a clean star rather than a shape with a gap in it.
	 */
	TRAIL_HALO_ENABLED: true,

	/**
	 * How far the halo's attachments sit from the ball's centre, as a fraction of the ball's own
	 * diameter — {@link BALL_CONFIG.TRAIL_SPREAD}'s scale, and the halo's thickness.
	 *
	 * **Larger than the core's, and that is the whole arrangement.** At `0.9` the attachments are `1.35`
	 * studs from the ball's centre where the core's are at `0.675` — so the haze's ribbons are twice as
	 * far out, and at {@link BALL_CONFIG.TRAIL_HALO_WIDTH_LEADING} they span about `2.3` studs of a ball
	 * that is `1.5`. The ball sits *inside* the haze rather than on top of it, which is the only way the
	 * second layer can read as glow rather than as a second trail.
	 *
	 * **Bring it down to the core's value and the effect inverts**: the two layers draw at the same
	 * width, and what comes out is a brighter trail rather than a softer one. These are the two numbers
	 * in this block that have to stay in an order, and this one is deliberately the larger.
	 */
	TRAIL_HALO_SPREAD: 0.9,

	/**
	 * How long a halo segment lives, in seconds. **Deliberately longer than
	 * {@link BALL_CONFIG.TRAIL_LIFETIME}.**
	 *
	 * A hot core cools faster than the air it came through, so a haze that outlives the streak is what
	 * says the ball *had been* somewhere rather than that it is being dragged — and it is why this is not
	 * simply the core's number reused. Matched lifetimes read as one wide ribbon; this one at about half
	 * again is the size of the difference, and it is also what makes the wake outlast the throw for the
	 * moment after the ball has landed.
	 */
	TRAIL_HALO_LIFETIME: 0.75,

	/**
	 * How wide the halo is where it leaves the ball — {@link BALL_CONFIG.TRAIL_WIDTH_LEADING}'s scale,
	 * which is a fraction of the halo's **own** gap rather than of the core's, so the two are not
	 * comparable numbers.
	 *
	 * **Under `1`, where the core's is over it, and that difference is deliberate.** The flare is what
	 * gives the core a head — see that number for the arithmetic — and this layer's job is to be the
	 * light around that head rather than a second one. Under `1` the ribbon's edges stop short of its own
	 * attachments, so the haze fills the span it was built between instead of bulging past the points it
	 * was built around.
	 */
	TRAIL_HALO_WIDTH_LEADING: 0.85,

	/**
	 * How wide the halo is at its oldest end, on the same scale as
	 * {@link BALL_CONFIG.TRAIL_HALO_WIDTH_LEADING}.
	 *
	 * Tapering to almost nothing like everything else on this trail, because the one thing that must not
	 * happen here is a wide soft end: the whole silhouette of the effect has to keep pointing at where
	 * the ball has been, and a haze that ends in a broad soft blob blunts the point.
	 */
	TRAIL_HALO_WIDTH_TRAILING: 0.04,

	/**
	 * The halo's colour where it leaves the ball — {@link BALL_CONFIG.TRAIL_COLOR_LEADING}'s terms, and
	 * it sits a step further into orange on purpose.
	 *
	 * The haze is the part of the effect the eye reads as *heat* rather than as light, so it is the part
	 * that should be the least white: a halo the colour of the core would just be the core, wider. The
	 * two fades also mean the trail reads as white, then orange, then a dark red residue — see
	 * {@link BALL_CONFIG.TRAIL_COLOR_MIDDLE} for why the middle of that matters.
	 */
	TRAIL_HALO_COLOR_LEADING: Color3.fromRGB(255, 116, 20),

	/**
	 * The halo's colour at its oldest end, on the same scale as
	 * {@link BALL_CONFIG.TRAIL_HALO_COLOR_LEADING} — a dark red, cooler than the core's ember because it
	 * outlives it.
	 */
	TRAIL_HALO_COLOR_TRAILING: Color3.fromRGB(120, 24, 8),

	/**
	 * How opaque the halo is where it leaves the ball, `0` being solid and `1` invisible. **It always
	 * fades to nothing by the tail**, and that is not a knob: a haze with a visible edge is a ribbon
	 * again.
	 *
	 * **Just over half, and the first number to reach for if the effect reads as a smear.** The halo is
	 * drawn across the core and not only behind it, so this is also what decides whether the streak stays
	 * legible inside its own glow: much lower and the trail is a thin bright line inside a wide haze,
	 * much higher and the haze *is* the trail with the core as a detail inside it.
	 */
	TRAIL_HALO_TRANSPARENCY_LEADING: 0.55,
} as const;
