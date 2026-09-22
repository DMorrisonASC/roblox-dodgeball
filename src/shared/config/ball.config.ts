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
	ROLL_RESISTANCE: 40,

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
	GROUND_FRICTION: 2,

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
	ELASTICITY: 0.01,

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
	LIFETIME_SECONDS: 15,

	// ---------------------------------------------------------------- spawner

	/**
	 * **Placeholder.** Balls wanted in the world per player. Fractional on
	 * purpose: the count is rounded, so this reads as a rate rather than a
	 * headcount and a full server gets proportionally more.
	 *
	 * No spawner exists yet — balls arrive from the join hand-out, a pickup, a
	 * catch, or an NPC that throws.
	 */
	BALLS_PER_PLAYER: 1.2,

	/** **Placeholder.** Floor on the wanted count, so an empty server still has balls. */
	MIN_BALLS: 4,

	/** **Placeholder.** Ceiling on the wanted count, so a full one does not litter. */
	MAX_BALLS: 40,

	/** **Placeholder.** Seconds to wait after a ball goes before replacing it. */
	RESPAWN_DELAY: 2,

	/** **Placeholder.** How often the wanted count is compared against the world, in seconds. */
	SPAWN_TICK_INTERVAL: 1,

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
	 * Read this as a **lever arm**: it is the radius the launch point swings on when
	 * the character moves or turns, so every stud of offset multiplies body motion
	 * into the aim guide at a 1:1 ratio. A large value here makes the guide appear
	 * to wobble as you walk; it does not make the throw safer, because
	 * `CollisionIgnore` already guarantees the ball cannot hit its thrower.
	 *
	 * This is the one number to change to move the launch point. It is read in
	 * exactly one place — `shared/throw.ts` → `getThrowMuzzle` — which both the
	 * server (real throw) and the client (aim guide) call, so tuning it moves both
	 * together and the guide keeps telling the truth.
	 */
	THROW_MUZZLE_DISTANCE: 2,

	/**
	 * Speed the ball leaves the hand at, in studs per second, for any target within
	 * reach. Maximum range at this speed is `v² / g`, so reach grows with the square
	 * of it.
	 *
	 * This is the *base* speed, not the final one — a throw that needs to reach
	 * further is wound up automatically, up to {@link BALL_CONFIG.THROW_MAX_SPEED}.
	 */
	THROW_SPEED: 100,

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
	 */
	THROW_MAX_SPEED: 280,

	/**
	 * Extra upward velocity added to every throw, in studs per second.
	 *
	 * A correction for the engine, not a design choice. Measured on the server: the
	 * ball flies as though it left the hand slower vertically than the velocity that
	 * was written to it, and stays that much behind for the whole flight — so the
	 * shortfall in position grows as `boost·t`, and the longer the throw the further
	 * the ball sits below the line it was solved for. The drawn arc is the solved
	 * one, so what that looks like from the player's seat is a trajectory running
	 * *above* the ball.
	 *
	 * **Tune it against the ball, not with arithmetic.** The loss comes from how the
	 * engine integrates (roughly `½·g·dt` per step), so this figure is frame-rate
	 * dependent and the right value for it moves with the server's step size.
	 * `BallService`'s DEBUG print shows the commanded velocity, and `ThrowProbe`
	 * reports how far the ball drifts from the plan's own curve — that drift is the
	 * number to drive to zero.
	 *
	 * **The correction belongs on the ball, not on the drawing.** Subtracting the
	 * same figure from the guide's launch was tried (`PREDICTION_VERTICAL_BIAS`) and
	 * removed: it moves the landing *marker* by `2·v_h·boost/g`, and `v_h` differs by
	 * mode, so it dragged the three modes' marks apart by a different amount each.
	 * Correcting the throw instead leaves every marker where it was and simply makes
	 * the ball fly the line they came from.
	 *
	 * 0 restores pure ballistics and the shortfall with it.
	 */
	THROW_VERTICAL_BOOST: 2.5,

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
	BOUNCE_FACTOR: 0.7,

	/**
	 * How many bodies one throw can take out before the ball goes dead, counted per throw.
	 * Read by `BallComponent`.
	 *
	 * The cap is what keeps a chain a *good throw* rather than a won round — without it the
	 * only limit is how many players are standing in the way. It counts per throw, because
	 * the ball forgets who it has hit the moment it is armed again.
	 *
	 * The ball is disarmed *after* the bounce that brings the count up, so the last player a
	 * throw takes out still throws the ball off them instead of catching it on the chest.
	 */
	MAX_CHAIN_HITS: 3,
} as const;
