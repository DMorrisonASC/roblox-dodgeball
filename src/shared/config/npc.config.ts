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
	CATCH_CHANCE: 0.3,

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
	 * **Raised from sixty, and that is the symptom it was causing.** Sixty studs is roughly a court's
	 * *width*, and two rigs placed on opposite sides of an arena are routinely further apart than that:
	 * the two sides spawn on their own halves and the ball each one is chasing drags it further apart,
	 * so a rig spent long stretches holding a ball with a live enemy forty studs out of reach and no
	 * way to say so. What that looked like from a seat was rigs that stopped throwing at each other
	 * after a while — nothing in the log, because "no target in range" is a *state* and nothing was
	 * printing it. **The figure is now generous on purpose** (a court diagonal with room to spare) and
	 * the print in `ThrowBehavior` reports the distance when a rig is blocked, so the next run says
	 * whether it is still too small rather than leaving it to be inferred.
	 *
	 * **Placeholder — 150.** A longer range does not make a throw worse: `BallService.throwBall` solves
	 * the arc to the target's own position, so a rig that throws at a body across the arena is throwing
	 * a legal throw at a body it can see, not lobbing at a guess.
	 */
	THROW_RANGE_STUDS: 150,

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
	 * How often a rig throws **deliberately wide** — the chance that a throw is aimed a few studs to one
	 * side of its target instead of at it.
	 *
	 * **A perfectly accurate rig is not a player, and that is the whole reason this exists.** Every throw
	 * a rig makes is a solved shot to the target's own position, so at any range where the angle gate
	 * passes the ball lands on the body: a round against rigs is a round against an opponent who cannot
	 * miss, which reads as a machine rather than as dodgeball. The user's words were "these NPCs are way
	 * too accurate and difficult for players — add some randomness to make them intentionally throw a few
	 * studs to the left or right, to simulate real player misclicks". This is that.
	 *
	 * **The miss is a *release* offset, not a posture one.** The rig still turns to face the body it is
	 * aiming at, and only the ball goes wide — see `ThrowBehavior`'s `aimWithMiss`, which is the one place
	 * this is applied. That is what makes it read as a misclick rather than as a rig that cannot aim, and
	 * it is why the turn is untouched by this value.
	 *
	 * **Placeholder — one in three, which lands nearer one in four once the body is accounted for.** The
	 * roll decides whether the aim is offset *at all*; whether the ball then misses depends on the offset
	 * against the width of a body (see {@link NPC_CONFIG.THROW_MISS_STUDS_MAX}). At a third and the range
	 * below, roughly a quarter to a third of throws go wide of a standing player. Raise it to make the
	 * rigs read as worse shots, lower it to tighten them; 0 is exactly the old behaviour, and it is the
	 * value to set when comparing two runs.
	 */
	THROW_MISS_CHANCE: 2 / 4,

	/**
	 * The shortest deliberate miss, in studs. **Placeholder — 0.5.**
	 *
	 * **Not zero, and the floor is doing a job rather than being tidy.** A roll can come out anywhere in
	 * this range, and a "miss" of zero studs would be a throw that was aimed straight at the body, logged
	 * as having gone wide — a line that contradicts itself. Half a stud is small enough to read as a
	 * flinch and large enough that the line about it is true.
	 */
	THROW_MISS_STUDS_MIN: 5,

	/**
	 * The longest deliberate miss, in studs — **the user's "a few 4 studs to the left or right"**.
	 *
	 * **A range rather than a fixed offset, which is the difference between a mistake and a rule.** A
	 * rig that misses by exactly four studs every time it misses has a *tell*: the wide throws all look
	 * identical, and a player learns the shape of them instead of reading them as error. Spread across
	 * this range, most misses are small and a full-width one is occasional, which is what a person's
	 * misclicks actually look like.
	 *
	 * **Four studs is a clean miss of a standing body and a near miss of a moving one**, which is the
	 * intended reading: a player's torso is about two studs wide, so an offset past one stud leaves the
	 * body's own width and anything past two is a miss even against the ball's radius. That is where the
	 * "roughly a quarter to a third of throws" estimate in {@link NPC_CONFIG.THROW_MISS_CHANCE} comes
	 * from. **Placeholder.**
	 */
	THROW_MISS_STUDS_MAX: 10,

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
	 * on course. See `DodgeBehavior` for the bookkeeping that makes that true and for the tag that reads
	 * this — the body of the pair lives in the file named for the gated tag, and the `Always*` file is the
	 * wrapper over it.
	 *
	 * **`Behavior_AlwaysDodging` does not read this at all** — that is the whole point of the split.
	 * This is the *gated* dodger's knob, and a rig meant to dodge everything is a tag now rather than
	 * this number turned up to `1`. The two kinds of rig no longer share one number.
	 *
	 * **1 means the gated rig gets out of the way of every ball it can move away from**, which is a rig
	 * players cannot hit; **0.5 is half the throws aimed at it**, and is where this sits. What it still
 * cannot do is *dash* with something in the way, or *dash* twice inside `DODGE_CONFIG.COOLDOWN` — and of
 * those, only the blocked direction still leaves the rig standing, because a rig that did commit and was
	 * turned away now runs instead (see `DodgeBehavior`'s `runAway`). **This number is the odds of the
 * rig picking a ball to get out of the way of, not the odds of it moving at all.**
 *
 * **And a *declined* roll is the one case where a rig still stands on purpose.** A roll that says "let
 * this one past" is a decision, not an unavailability — and if the rig ran for every ball it declined,
 * running would be most of what this number buys and the number would stop meaning anything. So the walk
 * answers "I could not dodge", never "I chose not to". That is the trade as it stands; this is the
 * paragraph to reverse if a round makes it read as rigs that ignore balls they could have avoided.
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

	/**
	 * The name of the model in `ServerStorage` that the lobby's placeholder rigs are cloned from.
	 *
	 * **This is the name the template has to be given in Studio, and it is the whole of the contract**
	 * — `LobbyRigService` looks for a `Model` with this name *anywhere* under `ServerStorage`, so where
	 * it is filed does not matter and what it is called does.
	 *
	 * **And it wears no tag — any tag, and `NPC` in particular.** The contract is the *name*; the tags go
	 * on the **clone**, from `NpcService.spawn` (which adds `NPC` and the behaviour tags it is handed)
	 * and from `LobbyRigService` (which adds and removes the six gameplay behaviours on the rigs that are
	 * playing). A tag on the template is not harmless, and the shape of the harm is worth knowing because
	 * **nothing in the output names it**: `NpcService` scans for `NPC` across the whole DataModel on
	 * purpose, so a tagged template is handed a *loop* — and, before `NpcService.ensureToken` refused it,
	 * a `ThrowerToken`, which every clone of that template then inherited. One token shared by every
	 * placeholder rig makes `BallComponent`'s own-ball rule answer "this is your ball" for **every**
	 * rig-to-rig throw, so a rig hit by another rig's ball resolves to nothing and dies of it never. See
	 * `TAGS.md`'s `NPC` row for the register and `NpcService.ensureToken` for the code half of the rule.
	 *
	 * **A rig and not a model of some other shape.** The thing cloned has to be something
	 * `NpcService.spawn` can hand to a behaviour: a `Model` with a `Humanoid` and a
	 * `HumanoidRootPart`. A `PrimaryPart` set to the root is worth having as well, because the spawn
	 * places a rig by its *pivot* — see `NpcService.spawn` for that, and see the report on this task
	 * for why the current placement is kept rather than a root-part one.
	 *
	 * **`PlaceholderRig` is the name for a reason rather than a word:** a rig in this project is a
	 * placeholder for a player who has not arrived, which is what the whole rig system is for. The
	 * name says what the thing *is* rather than where it is, so a second template — a heavier dummy, a
	 * testing rig — can carry a name that says what makes it different.
	 *
	 * **Placeholder.** Nothing has been modelled for this yet; the user creates the rig and gives it
	 * this name.
	 */
	PLACEHOLDER_RIG_TEMPLATE: "PlaceholderRig",

	/**
	 * How fast a placeholder rig walks to its join pad, in studs per second. **Placeholder — 16.**
	 *
	 * **Set rather than left to the template, and that is a fault-removal rather than a preference.**
	 * A rig authored as a *pose* quite reasonably carries a `WalkSpeed` of zero, and a rig whose
	 * humanoid cannot walk is a rig that agrees to be told to walk and then does not move — with
	 * nothing in the output to tell it apart from a rig that has arrived. Sixteen is the engine's own
	 * default for a humanoid, so a template that was already walkable is left exactly as it was;
	 * stated here so that the failure cannot happen. See `WalkToJoinPadBehavior.prepare`.
	 */
	WALK_TO_PAD_SPEED: 16,

	/**
	 * How close a rig has to get to its pad to count as arrived, in studs. **Placeholder — 4.**
	 *
	 * **Flat, and measured from the rig's root to the point in the middle of the pad.** Two numbers sit
	 * either side of this one and both matter: it has to be *larger* than the distance at which the
	 * engine's own `MoveTo` gives up on the last stud, or the behaviour would keep asking for a walk the
	 * body has already finished; and it has to be *smaller* than the pad, or a rig would stop short of
	 * the thing it is meant to be standing on. Four studs is about a body's width — so "arrived" means
	 * "standing on it" — and it is the number to lower if a rig reads as stopping short of its sign.
	 */
	WALK_TO_PAD_ARRIVAL_STUDS: 4,

	/**
	 * How often the walk behaviour looks at where its rig is, in seconds. **Placeholder — 0.5.**
	 *
	 * **The walk itself is not paced by this — the engine's own `MoveTo` is.** A humanoid walks to the
	 * point it was given on its own clock, so this number only decides how soon a rig that has arrived is
	 * *told* to stop, and how often the request is repeated for a rig that is still going. Half a second
	 * is the retarget interval `SeekBehavior` uses, and for the same reason: it is fast enough that
	 * nothing about the walk reads as delayed and slow enough that repeating a `MoveTo` costs nothing.
	 */
	WALK_TO_PAD_TICK_SECONDS: 0.5,

	/**
	 * How often the lobby's seat bookkeeping checks whether the roster has moved, in seconds.
	 * **Placeholder — 0.25.**
	 *
	 * **A poll of one number, and the number is the point.** `MatchService` already bumps
	 * `rosterRevision` on every opt-in, move-out and clearing, so a reader that wants to know "did the
	 * roster change" has an answer that costs one field read — and `LobbyRigService` reads it, and does
	 * the rest of its work only on the turns where it moved. What this interval therefore decides is the
	 * delay between a player touching a pad and the rig they displaced leaving the lobby: a quarter of a
	 * second is under the time it takes to step off a pad, and it costs four reads a second to have it.
	 *
	 * **Why a poll at all, rather than being told.** The other direction is a call from
	 * `MatchService.optIn` into the service that owns the rigs, and that is a constructor cycle: this
	 * service reads the roster, so the roster cannot read it back. `MatchService` could expose a second
	 * notification — a signal fired from `optIn` — but the revision *is* that notification, published
	 * once for every path that moves the roster, and a signal beside it would be two answers to "who is
	 * playing" for one event.
	 */
	SEAT_POLL_SECONDS: 0.25,

	/**
	 * How long a rig's claim on a loose ball survives without being renewed, in seconds.
	 * **Placeholder — 8.**
	 *
	 * **What it is sized against is the walk, not the seek.** A claim is renewed on every turn of a walk, so
	 * this is not "how long a walk may take" — it is how long `npc/ballClaims.ts` keeps believing a rig that
	 * has *stopped saying anything*. The shortest honest answer is therefore just past the longest pause in
	 * which a rig is still legitimately walking to a ball: `SEEK_RETARGET_SECONDS × SEEK_STALL_TICKS` is that
	 * behaviour's own give-up budget — a second and a half — and eight seconds is that with room for the walk
	 * across an arena, for a freeze that skips several turns, and for a rig being shoved off course once.
	 *
	 * **What it costs when it is wrong in either direction.** Too short and a claim lapses mid-walk, so a
	 * second rig picks the same ball and the scrum is back: visible, occasional, and self-correcting. Too
	 * long and a ball only a dead rig wanted stays parked for that long — with eight rigs and
	 * `MATCH_BALL_COUNT` balls, that is a body standing still for seconds, which is the thing the reservation
	 * exists to prevent. The second failure is the worse one, which is why the figure is seconds rather than
	 * a minute.
	 */
	CLAIM_SECONDS: 8,

	/**
	 * How far a rig runs when it cannot dodge, in studs. **Placeholder — 12.**
	 *
	 * **The distance a rig covers *along the escape direction* when a dodge is unavailable** — a catch window
	 * is open, a freeze, the cooldown, or the round refusing the request. It is a `MoveTo` target rather than a
	 * dash, so this is a walk of about three-quarters of a second at `WALK_TO_PAD_SPEED`, and it is re-issued
	 * every turn the ball is still on course, which is what makes it a run rather than a single step.
	 *
	 * **Sized against `DODGE_CONFIG`'s dash rather than picked.** A dash crosses fifteen studs in a fifth of a
	 * second; twelve studs of walking is the same *place* reached by the slow route, which is the point —
	 * the rig gets out of the line it was standing in, not out of the ball's reach. Larger would have rigs
	 * marching across the arena every time a ball came near; smaller would leave them inside the same hit
	 * radius the dash exists to escape.
	 */
	DODGE_RUN_STUDS: 12,
} as const;
