/**
 * Everything about the NPCs: the rigs the game drives itself, rather than the
 * ones a player controls.
 *
 * Imports nothing. Read on the server alone — nothing an NPC does is visible to
 * the client before it happens, because an NPC has no client to tell.
 */
export const NPC_CONFIG = {
	/**
	 * How long a rig with the respawn behavior stays down before it gets up, in
	 * seconds.
	 *
	 * Read by `RespawnBehavior` alone, and the delay is the whole reason that
	 * behavior has a timer in it: a rig that stood up on the frame it was killed
	 * would be a rig that never appeared to die, and there is nothing to learn from
	 * a target that cannot be knocked down. Long enough to read as a death, short
	 * enough that a test is not waiting on it.
	 */
	RESPAWN_DELAY_SECONDS: 3,

	/**
	 * How often a rig's network ownership is re-asserted, in seconds.
	 *
	 * **Ownership is the one thing about a rig that something other than this project can change.**
	 * `SetNetworkOwner` with no argument makes the server the owner, which is what a rig needs — the
	 * server is the machine driving every `MoveTo` a rig makes, and the one measuring the speed its
	 * animation is chosen from — but the engine also *assigns* ownership automatically by proximity.
	 * A rig that has had it taken is a rig whose physics is being simulated by whichever client is
	 * nearest, and the symptoms are a rig that jitters underfoot and a `MoveTo` that stops arriving:
	 * exactly when a player is close enough to be watching. `GetNetworkOwnershipAuto` is the engine's
	 * own statement that the decision can be automatic, which is why this is a re-check rather than
	 * one call at spawn.
	 *
	 * **Five seconds, and it is cheap enough not to be clever about.** The check is one
	 * `GetNetworkOwner` per rig per interval, inside a loop that already runs several times a second
	 * per rig, and what it is protecting is a walk and a destination.
	 *
	 * **Placeholder.**
	 */
	NETWORK_OWNERSHIP_RECHECK_SECONDS: 5,

	/**
	 * The chance that a gated catcher decides it *is* a catcher for one decision.
	 *
	 * **Read once per decision, not once per tick, and that is the whole point of it.** A 50 % roll at
	 * the catcher's ten-a-second cadence would not be a 50 % catcher: it would be a catch window that
	 * is open almost all of the time, because every winning roll would refresh the window and a losing
	 * one would simply be tried again a tenth of a second later. The same mistake — a chance read as a
	 * rate — was paid for once already, in `DodgeBehavior`; see `CatchBehavior` for the arithmetic.
	 *
	 * **Placeholder.** 0.5 is where a value has to start, and it is a *tuning* number rather than a
	 * design one: the design is the cadence below, and this is what fraction of the cadences the rig
	 * decides to catch. If it reads as "rarely catches", move it up; if as "usually catches", down.
	 */
	CATCH_CHANCE: 0.5,

	/**
	 * How long a gated catcher's decision lasts, in seconds — the cadence the chance above is rolled on.
	 *
	 * **One `CATCH_CONFIG.WINDOW_SECONDS`, which is why `1` and not a tuned number.** A `willCatch`
	 * decision asks exactly once, which opens a window one window long; so a decision that lasts one
	 * window is a decision whose window spans it, and a run of losing decisions leaves a closed window
	 * of the same length. Rolled twice, that is one window open and one shut — **the time-share equals
	 * `CATCH_CHANCE`**, which is the property that makes the two numbers mean anything together.
	 *
	 * **The value has to be no longer than the window, and shorter is worse in the other direction.**
	 * Longer, and a `willCatch` decision would open only a window-long slice of itself and then stand
	 * idle; shorter, and the rig would roll more often than it can act, which is the per-tick problem
	 * in slower clothing. It is written as a literal rather than as `CATCH_CONFIG.WINDOW_SECONDS`
	 * because this file imports nothing, deliberately — see the file comment — so if that window
	 * moves, this number moves with it and the two must be kept in step by hand. Flagged, not silent.
	 *
	 * **Placeholder.**
	 */
	CATCH_DECISION_SECONDS: 1,

	/**
	 * How far a rig notices a ball, in studs — the radius behind "is a ball in my detection radius".
	 *
	 * **A proximity gate, not a threat test.** This is the distance at which a gated catcher will
	 * bother raising its hands at all, and the distance at which a rig counts as reacting to a ball.
	 * It is deliberately generous: the question is "*is something happening near me*", and a ball that
	 * turns out to miss is still worth being ready for. The sharper question — "*will this ball hit
	 * me*" — is `DodgeBehavior`'s closest-approach solve and stays where it is.
	 *
	 * **Placeholder.** Sixty studs is about half a second of the fastest throw the game makes, which
	 * is the same figure `DodgeBehavior`'s own `THREAT_RADIUS` was chosen at.
	 */
	DETECTION_RADIUS: 60,

	/**
	 * How far a gated thrower will throw at a target, in studs.
	 *
	 * **The gated behaviour's answer to the old `THROW_RANGE`.** That constant was the distance ahead
	 * of itself a rig threw when it had no target — a stand-in for aim. This one is a real range: the
	 * farthest an enemy can be and still be thrown at. Beyond it the rig simply does not throw, rather
	 * than lobbing a ball at somebody across the arena.
	 *
	 * **Placeholder.** Sixty studs, the same span the old stand-in used.
	 */
	THROW_RANGE_STUDS: 60,

	/**
	 * How far off a gated thrower's nose a target may be, in degrees, and still be thrown at.
	 *
	 * **Horizontal, and inclusive at the edge.** The rig turns toward its target and throws once the
	 * target is inside this window; a target behind the rig is never thrown at however close it is,
	 * which is the "a body has to face what it throws at" rule the user asked for. The angle is taken
	 * on the ground plane — see `detectEnemy` — so a target above or below the rig is judged by which
	 * way it lies, not by its height.
	 *
	 * **Placeholder.** 45° each way is a wide cone — a quarter of the compass either side of the nose
	 * — chosen so a rig is not fussy about how squarely it is facing; it is the number to tighten if a
	 * rig's throws read as too casual about aim.
	 */
	THROW_ANGLE_DEGREES: 45,

	/**
	 * The chance that the **gated** dodger commits to dodging **a ball that is coming at it**.
	 *
	 * **Per ball, and that is a reversal recorded rather than tidied away.** This was a *rate* — a
	 * chance per second, scaled by the tick into a chance per turn — on the argument that a rate
	 * survives a change of tick and a change of throw speed. What it did not survive is being *read*:
	 * "set it to 1" plainly means "always dodges", and a rate of 1 meant a ball on course for half a
	 * second was dodged a little over 40 % of the time, because a half-second flight is only five
	 * turns. The knob was measuring *exposure* while everybody — including whoever wrote it — read it
	 * as a percentage. **The number is now the number**: one roll per ball, held for as long as that
	 * ball is on course. See `AlwaysDodgeBehavior` for the bookkeeping that makes that true, and
	 * `DodgeBehavior` for the tag that reads this.
	 *
	 * **`Behavior_AlwaysDodging` does not read this at all** — that is the whole point of the split.
	 * This is the *gated* dodger's knob, and a rig meant to dodge everything is a tag now rather than
	 * this number turned up to `1`. The two kinds of rig no longer share one number.
	 *
	 * **1 means the gated rig gets out of the way of every ball it can move away from**, which is a rig
	 * players cannot hit; **0.5 is half the throws aimed at it**, and is where this sits. What it still
	 * cannot do is dodge with something in the way, or dodge twice inside `DODGE_CONFIG.COOLDOWN`.
	 *
	 * **What the reading costs, stated:** a lob in the air for a second and a drive that arrives in two
	 * tenths now get the same chance, where the rate gave the lob more of one. What it buys is that the
	 * rig commits the moment it sees the ball, so it is out of the way *before* the ball arrives rather
	 * than a step ahead of it. **And what the old rate bought, recorded because the trade is real:** a
	 * ball in the air for a second used to be likelier to be dodged than one arriving in two tenths.
	 * That is arguably the more *physical* rule; it made the number mean something nobody could guess,
	 * and the person tuning it did not guess it either — which is the whole of the argument for the
	 * simpler one.
	 *
	 * **Placeholder.**
	 */
	DODGE_CHANCE_PER_BALL: 0.5,
} as const;
