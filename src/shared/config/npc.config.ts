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
	 * How far a rig's joints may bend in a ragdoll, in degrees — **the one dial on the corpse's floppiness.**
	 * **Placeholder — 45.**
	 *
	 * **What it is for.** `npc/ragdoll.ts` swaps each `Motor6D` for a `BallSocketConstraint` at the moment a
	 * rig dies, so the body goes limp instead of coming apart. A ball joint with no limit is free to rotate a
	 * whole turn in every direction, and a corpse that has fallen then folds itself into shapes no skeleton
	 * makes — that reads as a broken rig rather than a limp one. This cone stops each joint where a joint
	 * stops. It is used for the cone and for both twist bounds, because two numbers here would be two dials
	 * for one impression.
	 *
	 * **What the value trades.** Smaller is a stiffer corpse — limbs that hold their angle and land like a
	 * mannequin; larger is floppier and eventually impossible, with knees bending the wrong way. Forty-five
	 * degrees is roughly a shoulder's and a knee's honest range, and the number to move is this one.
	 */
	RAGDOLL_LIMIT_DEGREES: 45,

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
	 * The running speed above which a rig counts as walking, in studs per second.
	 *
	 * **Roblox's own number, from Roblox's own animation script.** Its `onRunning` handler branches on
	 * `speed > 0.01`, against exactly the fact this reads — the speed `Humanoid.Running` reports — so this is a
	 * cited precedent rather than a tuned value, and it is deliberately *tiny*: the fault this half of the
	 * locomotion decision replaced was a **five-stud** band floor, which published every rig moving slower than
	 * that as standing, creeping rigs included.
	 *
	 * **What it is not:** not a band, and not a claim that a measurement is as good as a request. A rig is
	 * published as moving the moment it is moving at all and reads exactly zero when it is still, and it is a
	 * measurement only because a `MoveTo`-driven body has no readable request — see
	 * `NpcService.publishAnimation` for the two properties that were tried before this and why both were zero.
	 */
	RIG_MOVING_SPEED: 0.01,

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
	CATCH_CHANCE: 0.1,

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
	CATCH_DECISION_SECONDS: 2,

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
	 * **Once a throw is committed, the gate is measured against the point it is throwing at** rather than against
	 * the body — see `ThrowBehavior`, which asks the question of the aim point so that a rig deliberately aimed a
	 * few studs wide is not read as having lost its target. The decision itself still waits for the *body* to be
	 * inside this window, which is what a player watching sees.
	 *
	 * **Placeholder.** 45° each way is a wide cone — a quarter of the compass either side of the nose
	 * — chosen so a rig is not fussy about how squarely it is facing; it is the number to tighten if a
	 * rig's throws read as too casual about aim.
	 */
	THROW_ANGLE_DEGREES: 45,

	/**
	 * **The rig throw's three difficulty numbers, together, because they are one decision seen three ways.**
	 *
	 * `THROW_DECISION_SECONDS` is how long a rig hesitates before committing, `THROW_MISS_CHANCE` is how often
	 * a committed throw is deliberately wide, and `THROW_MISS_STUDS_MIN`/`_MAX` are how wide. They are grouped
	 * in this file rather than given a profile table because there is **one** profile: every rig in the game
	 * uses them, the practice dummies included (the roll lives in the windup tracker both behaviours build, so
	 * a second set of numbers would need a second table for no second population). Three values want a comment,
	 * not a framework — see `HANDOFF.md` §0's "modular over monolithic".
	 */

	/**
	 * How long a rig waits after it *can* throw before it decides to, in seconds. **Placeholder — 0.35.**
	 *
	 * **The answer to "a rig throws the instant it can", and it sits before the windup rather than between
	 * throws.** A rig's throw used to begin on the very turn the angle gate opened — and, after a catch, on the
	 * first turn after the hand filled — so a gated catcher could catch (opening a window that makes it
	 * unhittable for `CATCH_CONFIG.WINDOW_SECONDS`) and start a windup inside the same tenth of a second. The
	 * dwell is the hesitation between "there is a throw available" and "I am making it", so the rig is *seen*
	 * to consider the throw before it commits. Placing it after the windup would be a cadence limit on throws
	 * instead: the rig would still decide instantly and then stand there holding, which is a machine with a
	 * delay rather than a body making up its mind.
	 *
	 * **Armed once and not reset by a flicker.** The clock is keyed from the first turn a rig holds a ball *and*
	 * has a target in range, and it is cleared only when the hand empties or a throw is made — a target that
	 * blinks out for a turn and comes back therefore finds the clock already running rather than restarting it.
	 * That is what makes the dwell a decision rather than a debounce: the thing being waited on is the rig, not
	 * the world. Clearing it on an empty hand is what makes a *pickup* or a *catch* start a fresh hesitation
	 * rather than inherit the last one's spent clock.
	 *
	 * **A third of a second, against the tick.** Three and a half turns of `THROW_TICK_SECONDS` — long enough to
	 * be visible as a pause from a seat, short enough that a rig does not read as asleep, and comfortably longer
	 * than the one turn a frame hiccup could add. It is not a throw rate: how often a rig throws is set by how
	 * long it takes `Behavior_Seeking` and `Behavior_Pickup` to put another ball in its hand.
	 */
	THROW_DECISION_SECONDS: 0.35,

	/**
	 * How often a rig throws **deliberately wide** — the chance that a throw is aimed a few studs to one
	 * side of its target instead of at it. **Placeholder — `2 / 4`, i.e. one throw in two.**
	 *
	 * **A perfectly accurate rig is not a player, and that is the whole reason this exists.** Every throw
	 * a rig makes is a solved shot to the target's own position, so at any range where the angle gate
	 * passes the ball lands on the body: a round against rigs is a round against an opponent who cannot
	 * miss, which reads as a machine rather than as dodgeball. The user's words were "these NPCs are way
	 * too accurate and difficult for players — add some randomness to make them intentionally throw a few
	 * studs to the left or right, to simulate real player misclicks". This is that.
	 *
	 * **A miss *rate*, and deliberately not a spread — the difference is what the rig reads as.** A spread
	 * applied to every throw would make every ball slightly off, which reads as a rig that is *imprecise*: no
	 * throw is honest and the player learns to distrust the whole envelope. A rate leaves the other half of the
	 * throws exactly as accurate as they have always been, so the rig reads as *fallible* — capable, and
	 * occasionally wrong. **It is also the only version that keeps the windup worth watching**: a rig that
	 * visibly commits and then misses is a telegraph with an outcome; a rig whose every throw is a metre out is
	 * just noise, and its hold tells a player nothing they can act on. Do not turn this constant into a noise
	 * term — if the rigs still feel too accurate, move this number, not the magnitude below.
	 *
	 * **Rolled once per throw, at the decision, and never at the release.** The roll happens in
	 * `createWindupTracker.beginWindup`, so both rig behaviours inherit it and neither can be forgotten — see
	 * {@link NPC_CONFIG.THROW_MISS_STUDS_MAX} for the geometry. At the decision rather than at the release for
	 * two reasons: the hold is solved *against the point the ball will actually leave for*, so the published
	 * `CHARGING_ATTRIBUTE` describes the throw that happens; and the rig's **facing** can be turned onto that
	 * same point, so a rig about to miss visibly aims wide instead of pointing at the player while the ball goes
	 * elsewhere. A roll at the release could do neither — it would change the ball after the body had been
	 * pointed honestly.
	 *
	 * **What it does not do: touch the charge.** Lowering the charge for a miss would make the ball fall short,
	 * which reads as *weak* rather than as *inaccurate* — a different and worse character. The error is lateral,
	 * so the throw is as strong as any other and simply in the wrong place.
	 *
	 * **0 is exactly the old behaviour**, and it is the value to set when comparing two runs.
	 */
	THROW_MISS_CHANCE: 0.9,

	/**
	 * The shortest deliberate miss, in studs. **Placeholder — 5.**
	 *
	 * **The floor is what makes the log line true, and it is chosen from a body's width rather than from feel.**
	 * A player's torso is about two studs across and the ball is `BALL_SIZE` (2) studs in diameter, so a
	 * *centre* offset past roughly two studs leaves both the body and its ball-radius margin — anything from
	 * five up is a clean miss at every range a rig throws at, where a "miss" of half a stud would be a throw
	 * that landed on the body and was logged as wide. That contradiction is what this floor prevents.
	 *
	 * **Studs rather than degrees, and the units are the argument.** What a throw has to miss is a body of a
	 * fixed width, so the error has to be measured in the same units as that width. An *angular* offset would
	 * be a bigger miss the further away the target is and a smaller one up close — at arm's length a couple of
	 * degrees is a hit — which is precisely backwards for a mistake: a person's misclick is about as far off in
	 * studs whatever they are aiming at.
	 */
	THROW_MISS_STUDS_MIN: 7,

	/**
	 * The longest deliberate miss, in studs. **Placeholder — 10.**
	 *
	 * **A range rather than a fixed offset, which is the difference between a mistake and a rule.** A
	 * rig that misses by exactly ten studs every time it misses has a *tell*: the wide throws all look
	 * identical, and a player learns the shape of them instead of reading them as error. Spread across
	 * five to ten, most misses are small and a full-width one is occasional, which is what a person's
	 * misclicks actually look like.
	 *
	 * **Ten studs is a clean miss of a standing body and a near miss of a moving one**, which is the
	 * intended reading: a player's torso is about two studs wide, so an offset past one stud leaves the
	 * body's own width and anything past two is a miss even against the ball's radius — this is five times
	 * that, so a drawn miss is never a hit that the log calls wide. At a rig's forty-stud throwing distance it
	 * is also a *plausible* wide ball rather than an absurd one: about fourteen degrees off the line, which is
	 * a bad throw rather than a throw at nothing. See {@link NPC_CONFIG.THROW_MISS_CHANCE} for the rate.
	 */
	THROW_MISS_STUDS_MAX: 10,

	/**
	 * The share of a rig's throws made **on the move** — the first of the two bands a throw's shape is drawn
	 * from. **Placeholder — 0.7, the user's own "70+ of the time player moves and throws the ball".**
	 *
	 * **The three shapes, and the mix is the point rather than a compromise.** A rig that throws from a stand
	 * every time reads as a turret: `SeekBehavior`'s carry-through already has it *arrive* at a ball moving, and
	 * a throw that always stops the body has the one shape a person's cycle does not have. A rig that throws on
	 * the move every time is a different tell — a body that never sets its feet, which no player does either. A
	 * person does all three, and it is the *mixture* that leaves a watcher unable to name the rule. See
	 * {@link ThrowWalk} for what each shape actually does; these two numbers only decide how often each is drawn.
	 *
	 * **Two bands of one draw, in this order, and the remainder is the third shape.** A throw is
	 * `moveAndAim` when the roll is under this number, `moveThenPlant` when it is under the next one, and
	 * `plantNow` when it is past both — so the two values are **absolute shares of every throw** rather than a
	 * share and a conditional share, and the arrangement cannot produce a negative band. Raising both past 1 is
	 * therefore not an error: it simply stops drawing the third shape, which is the honest reading of asking for
	 * more than all of them.
	 *
	 * **Drawn once, where the rig decides to throw** — in `ThrowBehavior`'s decision turn, the same turn that
	 * solves the charge. Never per tick: a rig that re-decided during its own windup would be a body that changed
	 * its mind mid-throw, which reads as broken rather than as human, and the hold's whole value is that a
	 * watcher can see it coming (see `CHARGING_ATTRIBUTE`).
	 *
	 * **Published as {@link THROW_WALK_ATTRIBUTE}, because the two halves are two behaviours.** The thrower draws
	 * the shape and the *walker* is what has to act on it — a hold is what ends a rig's carry-through walk — so
	 * the fact travels on the model. See that attribute for why a second attribute rather than a second meaning
	 * for the charge.
	 */
	THROW_MOVE_AND_AIM_CHANCE: 0.7,

	/**
	 * The share of a rig's throws made **after its walk has finished** — the second band, and the shape that
	 * exists so "plant and throw" is a choice rather than an accident. **Placeholder — 0.2, which with the band
	 * above leaves `0.1` for the third shape.**
	 *
	 * **What this band is for, and what it is not.** Before there were three shapes, a planted throw was a throw
	 * whose *timing* happened to end the walk — the hold landed inside the carry-through window and stopped the
	 * body wherever it was. Two rigs could therefore differ only by when their target came into the angle window,
	 * which is an accident of geometry rather than a behaviour. This band is the same walk with the opposite
	 * instruction: **finish it, stand, then throw**, so the ball leaves a body that has come to a stop *and* has
	 * visibly gone somewhere first.
	 *
	 * **The release waits for the body to stop, which is the only thing that makes this a different shape at
	 * all.** The hold's own clock is unchanged, so a hold whose deadline arrives while the rig is still walking
	 * simply keeps holding until `NPC_ANIM_MOVING_ATTRIBUTE` says the body has stopped — at most one carry-through
	 * window later, which is what `ThrowBehavior` arms its expiry timer for. Without that wait the ball would
	 * leave a walking body and the shape would be indistinguishable from the band above it.
	 *
	 * **Its charge is re-solved at the release, for the band above's reason.** The body has moved since it
	 * decided — 8 studs, deliberately — so the distance it decided at is no longer the distance it is standing
	 * at. Only the third shape throws the charge it decided with, and that is exactly why it can: a hold that
	 * stops the body on the same turn it solves cannot make a throw land short.
	 *
	 * **Not a movement of its own.** Nothing new is walked: this is the carry-through the rig is already making,
	 * left alone, and the walk's own end — arrival, or `PICKUP_WALK_SECONDS` — is what plants the rig.
	 */
	THROW_CARRY_THROUGH_CHANCE: 0.2,

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
	 * **The folder in `ServerStorage` the placeholder rigs are cloned from — one model per rig, drawn at
	 * random and never drawn twice at once.**
	 *
	 * **`NPCs` is the name the folder has to be given in Studio, and that is the whole of the contract.**
	 * `npc/rigPool.ts` finds a `Folder` with this name *anywhere* under `ServerStorage` — through
	 * `shared/find.ts`'s `findFolder`, which requires the class as well as the name, so a `Model` called
	 * `NPCs` is passed over rather than mistaken for it — so where it is filed does not matter and what it
	 * is called does. Every `Model` **child** of it is one rig the pool may hand out; a model nested inside
	 * a sub-folder of `NPCs` is not one, which is the same shape the lobby's own spawn folder keeps.
	 *
	 * **And none of them wears a tag — any tag, and `NPC` in particular.** The contract is *membership of
	 * this folder*; the tags go on the **clone**, from `NpcService.spawn` (which adds `NPC` and the
	 * behaviour tags it is handed) and from `LobbyRigService` (which adds and removes the six gameplay
	 * behaviours on the rigs that are playing). A tag on a model in here is not harmless, and the shape of
	 * the harm is worth knowing because **nothing in the output names it**: `NpcService` scans for `NPC`
	 * across the whole DataModel on purpose, so a tagged model is handed a *loop* — and, before
	 * `NpcService.ensureToken` refused it, a `ThrowerToken`, which every clone of that model then
	 * inherited. One token shared by every placeholder rig makes `BallComponent`'s own-ball rule answer
	 * "this is your ball" for **every** rig-to-rig throw, so a rig hit by another rig's ball resolves to
	 * nothing and dies of it never. See `TAGS.md`'s `NPC` row for the register and `NpcService.ensureToken`
	 * for the code half of the rule — and `npc/rigPool.ts`, whose boot scan checks every model for exactly
	 * this rather than leaving it to be discovered from a lobby that behaves strangely.
	 *
	 * **A rig and not a model of some other shape.** Each model has to be something `NpcService.spawn` can
	 * hand to a behaviour: a `Model` with a `Humanoid` and a `HumanoidRootPart`. A `PrimaryPart` set to the
	 * root is worth having as well, because the spawn places a rig by its *pivot* rather than by its root —
	 * see `NpcService.spawn`. **How many of them there are is the pool's ceiling**: fewer models than seats
	 * means the surplus seats get no rig, and which models are in the folder is a place-file fact this file
	 * cannot know.
	 *
	 * **Placeholder**, in the sense that the folder does not exist yet: nothing is in `ServerStorage.NPCs`
	 * until somebody makes it, and until then the boot warning names the folder and no rigs are spawned.
	 */
	RIG_POOL_FOLDER: "NPCs",

	/**
	 * **Where a rig waits when it gives up its seat instead of being destroyed.** Made under `ServerStorage`
	 * on first use. **Placeholder as a name, not as a number.**
	 *
	 * **A parked rig is a body this game still owns and intends to use again.** A player arriving stands one
	 * placeholder down; a player opting into a full side stands one down; and the seat comes back the moment
	 * they leave or the round clears the roster. Destroying the body at the first half and cloning a fresh one
	 * at the second is what made the lobby look like it was shuffling strangers around — a burst, a different
	 * name, often a different face — so the body is kept instead: out of `Workspace` (not drawn, not
	 * simulated, not seen by any world-blind scan), with no `Team` and no behaviours, and still wearing `NPC`
	 * so that `npc/rigPool.ts` keeps its name and its model reserved for it.
	 *
	 * **Under `ServerStorage` rather than a hidden corner of `Workspace`**, because "hidden" has to mean not
	 * replicated as well as not drawn — and because the pool folder beside it is a place *templates* live,
	 * while this one holds bodies that are alive and coming back. `NpcService.run` idles a tagged model
	 * outside the world and resumes it the turn it is placed again, which is the mechanism the whole idea
	 * rests on.
	 */
	RIG_PARKING_FOLDER: "RigParking",

	/**
	 * **`PLACEHOLDER_RIG_TEMPLATE` was here, and nothing reads it any more.** Kept as a record rather than
	 * deleted, because the model it names is deliberately *still in the place file* and a reader who greps
	 * for the name should find an explanation rather than nothing.
	 *
	 * It was the name of the single model every placeholder rig was cloned from, and it is what the deleted
	 * `LobbyRigService.findTemplate` walked `ServerStorage` for. **The two went together**: `LobbyRigService`
	 * no longer has that method, and the pool above replaced it — a rig is now a clone of a *drawn* model
	 * from {@link RIG_POOL_FOLDER}, so there is no one template to name. **The rule that model was under is
	 * the reason this is kept rather than deleted outright**: a model this service clones must carry no tag
	 * and no `ThrowerToken`, and that is now a rule about every model in the folder rather than about one.
	 * {@link RIG_POOL_FOLDER} carries the whole of it.
	 *
	 * **Retiring the model itself is a separate decision and not this file's** — it is a place-file edit,
	 * and nothing breaks while it sits there. `ArenaV1` is the precedent for a template left parked after
	 * its last reader went.
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
	 * The marginal clearance the pad walk keeps outside a pad, in studs. **Placeholder — 3.**
	 *
	 * **Added to a measured radius rather than being one, and that is the whole of what this number is.**
	 * The pad's own keep-clear radius is its flat circumradius — `0.5 × sqrt(x² + z²)` of the part — which
	 * `LobbyRigService.writePadWalk` measures off the pad it is sending the rig past and writes on the rig as
	 * `WalkToJoinPadAvoidRadius`. This is the margin around that: a body's own radius plus a stud, so a rig
	 * walking the corridor misses the pad's corner by a body's width rather than by nothing.
	 *
	 * **The correction this represents.** The first version of this corridor had one guessed number for the
	 * whole thing (`PAD_AVOID_RADIUS_STUDS`, 12), and it was wrong for exactly the reason a guess is wrong:
	 * a sign wider than about fourteen studs is wider than the disc, so a rig passing twelve studs from the
	 * centre walked over the end of it and the walk looked unchanged. Measuring the pad removes the guess;
	 * what is left to tune is how much room a body wants, which is this.
	 */
	PAD_AVOID_CLEARANCE_STUDS: 6,

	/**
	 * The keep-clear radius a pad walk falls back to when the rig was not told a measured one, in studs.
	 * **Placeholder — 12.**
	 *
	 * **A fallback and not the rule, which is the correction this pair of constants represents.** A rig the
	 * lobby spawned carries `WalkToJoinPadAvoidRadius` — the actual pad's circumradius, measured from the
	 * part — and this number is only reached by a rig somewhere the lobby did not put it, which in practice
	 * means one tagged by hand in Studio. Twelve is a sign of about seventeen studs across, which is the
	 * order of the pads this lobby has; it is deliberately a little generous, because the cost of being
	 * wrong on the large side is a wider arc and the cost on the small side is a rig walking over the sign,
	 * which is the fault the whole corridor exists for.
	 *
	 * **Two pads of one side are not kept clear of**, deliberately: the destination is one of them, and
	 * walking over its own side's paint is not a mistake anybody can see.
	 *
	 * Both numbers are read by `WalkToJoinPadBehavior.aimAroundPad` and by nothing else.
	 */
	PAD_AVOID_RADIUS_STUDS: 12,

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
	 * The shortest a placeholder rig waits after being told to walk before it sets off, in seconds.
	 * **Placeholder — 2.**
	 *
	 * **A delay at all, and the reason is a drawing rather than a pause.** Every lobby rig is spawned in
	 * one loop at boot and re-sent to its pad in one loop at every intermission, so without a wait they
	 * are one body: eight rigs leaving one line in the same second, in step, which is the one thing a
	 * room of people never looks like. A draw per rig spreads the lobby out, so the room reads as
	 * individuals crossing it rather than as a formation.
	 *
	 * **It was ten, and ten against fifteen is a window that does not fit the intermission it is drawn
	 * in.** See {@link NPC_CONFIG.WALK_TO_PAD_DELAY_MAX_SECONDS}, whose own note predicted this exactly
	 * and was read as a tolerable cost rather than as the bug it is: the walk is issued
	 * `TRANSITION_COVER_SECONDS` (~0.9 s) into a 16-second intermission, so a rig drawn at fifteen set
	 * off with the clock already wrapped and one drawn at ten had three seconds to cross the room. What
	 * that looks like from the player's seat is not a staggered lobby — it is **a lobby of rigs standing
	 * still**, which is the report this revision answers ("they spawn in lobby and are still"), and it is
	 * why the two numbers are a pair.
	 *
	 * **So the spread is kept and the wait is removed.** Eight rigs over a five-second window is still
	 * visibly staggered — three quarters of a second apart on average — while leaving eleven seconds of
	 * a sixteen-second intermission for the crossing itself, which at
	 * `NPC_CONFIG.WALK_TO_PAD_SPEED` is about two seconds of walking. The formation the old window was
	 * guarding against needs the rigs to be *apart*, not to be *late*.
	 */
	WALK_TO_PAD_DELAY_MIN_SECONDS: 2,

	/**
	 * The longest a placeholder rig waits after being told to walk before it sets off, in seconds.
	 * **Placeholder — 7.**
	 *
	 * **The upper end of the same window, and it is bounded by the intermission rather than tuned.**
	 * `LobbyRigService` starts the pads' walk `TRANSITION_COVER_SECONDS` after the phase changes — the
	 * round's own cover, so the rigs move once the teleport has landed — which leaves about fifteen
	 * seconds of a sixteen-second intermission before the clock wraps.
	 *
	 * **It used to be fifteen, and the paragraph that stood here knew the answer and kept the number.**
	 * It said a rig drawn at fifteen "sets off with the intermission already over", called that "not a
	 * fault" because `moveWalkersToArena` strips a rig still walking, and left the consequence where it
	 * fell: **most rigs never walked at all**, and a lobby between rounds therefore looked like a room of
	 * statues. Being stripped is a safety net for the unlucky rig, not a licence to draw a number that
	 * makes stripping the ordinary case.
	 *
	 * **Seven leaves nine seconds of a sixteen-second intermission after the worst draw**, which is four
	 * crossings of this lobby at `WALK_TO_PAD_SPEED`, so even the rig that waits longest is seen walking
	 * and is seen arriving. The window keeps its job — spreading eight bodies out so they do not leave in
	 * one line — without spending the whole intermission doing it.
	 */
	WALK_TO_PAD_DELAY_MAX_SECONDS: 10,

	/**
	 * The chance that a rig **runs** to its pad rather than walking. **Placeholder — 0.5.**
	 *
	 * **A coin, and the coin is the point rather than a number somebody tuned.** A lobby where every rig
	 * moves at one speed is the same tell as one where every rig sets off at once: the gait is a second
	 * independent thing that makes two bodies beside each other read as two people. Half is the most
	 * mixed the room can be, and it is drawn **once per rig per walk** — a roll per turn would have a rig
	 * changing gear mid-crossing, which is a stagger rather than a choice.
	 *
	 * **What "run" means is a `Sprint` contribution on `WalkSpeedService`, not a walk speed of its own.**
	 * It adds `CHARACTER_CONFIG.SPRINT_SPEED_BONUS` (15), the same bonus a player's sprint and a seeking
	 * rig's run are, so a rig's run is the same run whoever takes it — and, because the *sprint flag* the
	 * animation is dressed from is the presence of that contribution, the run clip comes with it for
	 * nothing. See `WalkToJoinPadBehavior` for why this is a contribution and not a `Humanoid.WalkSpeed`
	 * write: a write would move the body at the right speed and leave its legs playing the walk.
	 */
	WALK_TO_PAD_RUN_CHANCE: 0.5,

	/**
	 * The chance that a rig takes the **look-around route** instead of walking straight to its pad.
	 * **Placeholder — 0.3.**
	 *
	 * **The shape of a person reading the signs.** A rig that walks straight to the pad it was given is a
	 * body being moved to a coordinate, because nothing about the walk says it chose a side. Three in ten
	 * of them stop short, turn to look at the *other* side's pad, turn back to their own, and then carry
	 * on and arrive — which is the one movement that reads as *deciding*, and it costs the rig nothing:
	 * the arrival branch is unchanged and the rig takes the same side it was always going to take.
	 *
	 * **Three in ten rather than a coin, so the route stays the exception.** Every rig doing it would make
	 * the lobby a queue of bodies all stopping at the same distance, which is a worse tell than the
	 * straight line it replaces; none would leave the walk as it is. See
	 * {@link NPC_CONFIG.WALK_TO_PAD_LOOK_STOP_STUDS} for where the stop lands, and
	 * {@link NPC_CONFIG.WALK_TO_PAD_LOOK_DWELL_SECONDS} for how long the two turns take.
	 */
	WALK_TO_PAD_LOOK_CHANCE: 0.3,

	/**
	 * How far from its pad a rig on the look-around route stops to look, in studs. **Placeholder — 30.**
	 *
	 * **Measure that against the two numbers either side of it, because it is the one that decides
	 * whether the movement reads at all.** It has to be comfortably past
	 * {@link NPC_CONFIG.WALK_TO_PAD_ARRIVAL_STUDS} (4), or the rig would arrive first and the route
	 * would never run — the arrival branch is checked before this one, and a stop distance inside four
	 * studs is a route that silently does nothing. And it has to be far enough from the pad that the rig
	 * is visibly *short* of it: at `WALK_TO_PAD_SPEED` (16) thirty studs is a little under two seconds of
	 * walking, so the pause lands mid-crossing, where a person glancing between two signs would hesitate.
	 *
	 * **The cost of it being wrong, stated:** in a lobby shorter than this the check is already true on
	 * the first walking turn, so the rig stops where it spawned — a body hesitating on the spot rather
	 * than on the way. That is a place-file distance against a config number, so this is the value to
	 * move first if the pause reads as too early or too late.
	 */
	WALK_TO_PAD_LOOK_STOP_STUDS: 30,

	/**
	 * How long a rig on the look-around route faces each pad, in seconds. **Placeholder — 1.**
	 *
	 * **One beat per turn of the head, and the number is `PANIC_SHUFFLE_SECONDS`' own.** That constant
	 * settled on a second as "long enough to read as a decision and short enough not to read as a stall",
	 * and this is the same question about the same kind of body: a rig that turned and immediately turned
	 * back would be a twitch, and one that held for three seconds would look stuck. A second covers the
	 * turn itself — the facing is an `AlignOrientation`, so it is a movement over time rather than a snap
	 * — with a moment at the end of it to stand and look.
	 *
	 * **It is a dwell per stage, so the whole route costs two of these plus the turn.** That is inside the
	 * `WALK_TO_PAD_TICK_SECONDS`-sized gap it is checked on (the behaviour's own half-second), so each
	 * stage is a whole number of turns rather than a duration the tick can step over.
	 */
	WALK_TO_PAD_LOOK_DWELL_SECONDS: 1,

	/**
	 * **How long the lobby waits, after the first player is in the server, before it puts its rigs out.**
	 * **Placeholder — 5.**
	 *
	 * **This is client replication breathing room, and it is deliberately not a readiness check.** The server
	 * can make all eight rigs on the frame it boots — `NpcService.spawn` is synchronous and `LobbyRigService`
	 * has always done exactly that — so nothing here is waiting for the *server* to be ready. What it buys is
	 * the joining client's first second: eight rigs are eight complete bodies (`Head`, `Torso`, limbs, a
	 * `Humanoid`, an `Animator`, a trail), and a client that receives them in the same frame as the map, its
	 * own character and the whole HUD spends that second building instances it is not looking at yet. The
	 * price is a lobby that is empty for the length of the player's own loading screen.
	 *
	 * **A fixed number is honest here because the fill is idempotent and self-repairing.** Nothing is
	 * *correct* only after five seconds: `LobbyRigService.rebalance` fills anything the seed missed on its
	 * next turn, a rig spawned a frame late is indistinguishable from one spawned on time, and a player who
	 * joins during the wait gets the same lobby as one who joins after it. So this is pacing rather than
	 * correctness, and a slow device gets a lobby that arrives later rather than a lobby that is wrong.
	 *
	 * **Five rather than two or ten.** It sits inside `ARENA_CONFIG.INTERMISSION_SECONDS` (16), so the first
	 * round is never held up by it. Below about three the rigs land inside the client's own join spike, which
	 * is the case this exists for; past ten the lobby is visibly empty to somebody who has already loaded and
	 * is walking around it.
	 *
	 * **Nought is an off switch, not a minimum.** At nought the fill happens on the frame the wait would have
	 * started rather than one `task.wait(0)` later — see `LobbyRigService.startLobbyFillCountdown`, which
	 * skips the yield entirely at that value.
	 */
	INITIAL_SPAWN_DELAY_SECONDS: 5,

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
	 * **How long a destroyed rig's seat stays reserved for the player who arrived before the rig comes
	 * back**, in seconds. **Placeholder — 15.**
	 *
	 * **The reservation is a loan, and this is its term.** A player joining the lobby stands one rig down
	 * (`LobbyRigService.reserveSeat`) and the seat is counted as held until they choose a side — which is
	 * what stops the lobby holding a ninth body in a room built for eight.
	 *
	 * **A round already ends that loan, and the term is what covers the wait before one.** `releasePendingSeats`
	 * clears every record inside the refill at the whistle, so a player who joined and never chose is not a
	 * seat once the round starts — the side gets its rig in the arena. What is left is the intermission
	 * itself: 16 seconds in which that pad shows one rig fewer than the match will field, and — when the
	 * round cannot open at all, because a side is empty or the server is below `MATCH_MIN_PLAYERS` — an
	 * intermission that wraps for ever, where nothing releases the seat and `rebalance` cannot repair it
	 * because the record reads as a held seat. That is the state a rig short *stays* short.
	 *
	 * **`5` is a compromise between a walk and a wander.** A lobby spawn to a join pad is about sixty studs
	 * and takes four or five seconds at walking speed, so five is roughly "they are on their way — give them
	 * the walk", the shortest term that does not pull the seat from under a player doing exactly what the pad
	 * asked. It was fifteen, which also covered the player who reads the HUD or joins mid-load; what that
	 * longer term cost is the case that actually hurts, a player who arrives and then wanders off, during
	 * which the pad shows one rig fewer than the match will field and `rebalance` cannot repair it because
	 * the record reads as a held seat. **The player the shorter term drops is covered two paragraphs down
	 * rather than by a longer clock** — a late opt-in is not refused, it stands a rig down.
	 *
	 * **Nothing is refused when the loan ends.** The pads stay live and a late opt-in still places the
	 * player; the seat simply changes hands back to a rig in the meantime.
	 */
	SEAT_RESERVATION_SECONDS: 5,

	/**
	 * **How long a rig's claim on a fetch target survives without being renewed, in seconds.**
	 * **Placeholder — 8.**
	 *
	 * **A fetch target is a loose ball or a live mystery box**, and the figure is the same for both because
	 * what it measures is the rig rather than the thing (`npc/ballClaims.ts`).
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
	 * a minute. **A box makes the second failure worse than a ball does**, because a practice floor has one
	 * box: eight seconds of a parked box is eight seconds of the whole floor ignoring it. It is not a reason
	 * to shorten the figure, and the reason is the shape of the failure — a rig renews by walking, so a box
	 * claim only survives this long if its owner is *still walking to it*, and a rig that is walking is a rig
	 * that arrives.
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

	/**
	 * How far from its ball a seeking rig has to be to *run* for it, in studs. **Placeholder — 30.**
	 *
	 * **A distance gate rather than a roll, and that is the whole shape of the rule.** A rig that sprinted at
	 * random would sprint when there was nothing to sprint for: a person runs for a ball that is *far away*,
	 * which is the same decision every time from the same fact. So a rig walks to a ball inside this distance
	 * and runs to one beyond it, and nothing else about the walk decides.
	 *
	 * **Sized so the run reads as effort rather than as a twitch.** A rig walks at {@link NPC_CONFIG.WALK_TO_PAD_SPEED}
	 * (16), so thirty studs is a little under two seconds of walking: shorter and the sprint is over before
	 * anyone has seen it start, which reads as a stumble; longer and the sprint is most of the trip, which is
	 * what makes it legible. It is also about a third of the arena across, so the ball a rig runs for is one it
	 * has to cross ground for.
	 *
	 * **The gate is re-read on every turn of the walk, so a rig slows as it arrives** — the run is for the
	 * *distance*, not for the walk, and a rig that ran the whole way and stopped on the ball would be a body
	 * changing gear for no reason a person watching could name. See `SeekBehavior`.
	 */
	SEEK_SPRINT_DISTANCE_STUDS: 5,

	/**
	 * How close a walking rig has to be to another body before it will hop, in studs. **Placeholder — 16.**
	 *
	 * **A hop is a thing a person does near somebody, so the radius is small and it is about legibility rather
	 * than about effect.** At this range the body the rig is passing is the nearest thing in the frame and the
	 * jump reads as *at* that body; at `DETECTION_RADIUS` (60) it would be a rig hopping on its own in the middle
	 * of the floor, which is the one reading that looks like a fault rather than like a person.
	 *
	 * **What it is measured against is the throw, not the dodge.** Sixteen studs is inside
	 * {@link NPC_CONFIG.THROW_RANGE_STUDS} several times over, so the body a rig hops past is one it could
	 * actually throw at — which is the reason a person would be moving like that in the first place. See
	 * `detectEnemy` for what counts as an enemy, which is a *side* question and not a distance one.
	 *
	 * **This line used to read "Placeholder — 24" while the value was `16`**, which is the same drift
	 * {@link NPC_CONFIG.SEEK_JUMP_COOLDOWN_SECONDS} records one entry below and `SEEK_SPRINT_DISTANCE_STUDS`
	 * still has (it is documented as 30 and set to 5). The number here is the one in the sentence above: the
	 * *argument* never depended on which of the two figures it was, and the prose naming "twenty-four" is what
	 * made the mismatch worth correcting rather than leaving as trivia.
	 */
	SEEK_JUMP_ENEMY_RADIUS_STUDS: 16,

	/**
	 * How long a rig waits after a hop before it will hop again, in seconds. **Placeholder — 2.**
	 *
	 * **Per rig, and that is the whole reason it is a cooldown rather than a chance.** A roll would let two rigs
	 * hopping in the same second hop again together, and a rig that failed a roll would hop at the next
	 * opportunity it was offered — so a chance ends up meaning *how often the trigger comes up*, which is already
	 * decided by where the bodies are. A clock on the rig says the thing that is meant: **this rig hops
	 * occasionally**, whatever the floor around it is doing.
	 *
	 * **Six seconds is sized against the jump itself rather than against the walk.** A hop is about a second in
	 * the air at this game's gravity, so this leaves five seconds of walking between them — long enough that a
	 * rig crossing a floor does not look like it is bouncing, short enough that two rigs meeting twice in a round
	 * are not a coincidence nobody sees. See `SEEK_SPRINT_DISTANCE_STUDS` for the walk a cooldown has to sit
	 * inside: a rig sprints thirty studs in about a second and a half, which is *faster* than this, so a hop is
	 * not a thing that happens once per walk by construction — it is rarer than that.
	 *
	 * **The value is `2`, and the paragraph above was written for `6`.** At two seconds a rig has one second of
	 * walking between hops rather than five, so a rig that has hopped reads as *bouncy* where the paragraph argues
	 * for *occasional*. It was suspected of causing the 2026-10-21 report — *"sometimes I see a rig repeatably
	 * jumping"* — and **it was raised to `6` for that and the rigs went on jumping exactly as fast, which is the
	 * evidence that settled it: they were not hopping at all.**
	 *
	 * **The fault was `Humanoid.Jump` being left standing.** It is a level the engine reads every step rather than
	 * a request it consumes, so a body holding it bounces on every landing — the same behaviour that makes a held
	 * jump button bunny-hop. `SeekBehavior.maybeJump` is the only thing in the game that sets it on a rig, it sets
	 * it once per hop, and nothing ever set it back: one hop bought a rig an unbounded run of them at the humanoid's
	 * own cadence, with no log line, because the hop's line prints per *request* and a standing request needs none.
	 * `NpcService.publishAnimationBody` clears it now, on the first turn the rig is back on the floor.
	 *
	 * **What is left here is a taste question and not a fault.** This number is the gap between hops a rig chooses
	 * to make, and the paragraph above is the case for the larger end of it. Move it without expecting the bouncing
	 * to change: the thing that bounced is fixed elsewhere, and this only decides how often a rig may ask again.
	 */
	SEEK_JUMP_COOLDOWN_SECONDS: 2,

	/**
	 * How little a rig's walk to a ball may stray from a straight line, as an angle from the line.
	 * **Placeholder — 6.**
	 *
	 * **An angle rather than a distance, and the choice does two jobs at once.** What a person walking an arc
	 * deviates by is a *direction* — they are watching the ball and the ball is over there — so an angle is the
	 * honest primitive; and because the offset it produces is `tan(angle) × distance`, a rig's detour **shrinks as
	 * it arrives**. That second half is load-bearing rather than tidy: a fixed lateral offset would leave a rig
	 * eight studs from the ball still heading two studs to one side, which is exactly the distance at which the
	 * arrival check and `BALL_CONFIG.PICKUP_RADIUS` live, and a curve is not allowed to cost the rig its ball.
	 *
	 * **This was one value of 4°, and a session's log is what showed it was too straight.** At 4° the walk swung
	 * 3.3 studs to either side of a 47-stud line and 1.4 studs of a 20-stud one, and the line every walk prints
	 * read `amplitude 4.0° (1.4 studs here)` — a body's width of drift across an arena, which at a run is a
	 * straight line to anybody watching. **The floor is now above where the old value sat**, so no walk is as
	 * straight as every walk used to be: at 6°, `tan(6°) = 0.105` is **4.9 studs** on a 47-stud walk and 2.1 on
	 * a 20-stud one.
	 *
	 * **A floor rather than a value, drawn once per walk, on `SEEK_CURVE_PERIOD_MIN_SECONDS`'s argument.** That
	 * constant argues a range beats a number because two rigs setting off in the same second must not trace the
	 * same path, and the same reason holds here in its stronger form: a period and a phase make two walks
	 * *different*, but only the amplitude makes either of them *wide*. One amplitude for every walk would give
	 * every rig the same silhouette of a detour at the very moment two of them are side by side.
	 */
	SEEK_CURVE_AMPLITUDE_MIN_DEGREES: 6,

	/**
	 * How far a rig's walk to a ball may stray from a straight line, as an angle from the line.
	 * **Placeholder — 14.**
	 *
	 * **What it means in studs, which is the half a person watching can see:** `tan(14°)` is `0.249`, so the
	 * widest walk swings **11.7 studs** to either side of a 47-stud line, 5.0 studs of a 20-stud one, and about
	 * fifteen of a sixty-stud sprint — a body taking an *angle* on the ball rather than walking to a coordinate.
	 *
	 * **Three things set the ceiling, and all three are already in the code.** *The arrival*: the offset is
	 * proportional to the distance, so at the eight studs where the pickup begins to matter this is two studs to
	 * one side of a ball the rig can take from eight — the curve cannot cost it the ball. *The stall budget*: the
	 * walk aims at the **offset point** and re-aims every `SEEK_RETARGET_SECONDS`, so the rig closes on the ball
	 * by `cos(angle)` of its speed on every turn and never spends one getting further away — a wider curve is
	 * therefore not a rig failing to reach its ball, which is the reading that would make this a fault. *The
	 * cadence it is laid over*: `MoveTo` is re-issued twice a second, so one cycle is a few straight chords
	 * rather than a smooth sine, and it is the **period** that keeps that a curve rather than a stagger — which
	 * is why {@link NPC_CONFIG.SEEK_CURVE_PERIOD_MIN_SECONDS} is deliberately not shortened to match this.
	 *
	 * **Fourteen rather than more, and the failure mode past it has a name in this file: *wandering*.** A rig
	 * that cannot be read as deciding where to go stops being a person taking a line and becomes a body with
	 * something wrong with it. Lower both ends if a session shows that; raise the floor first, because the floor
	 * is what decides how many walks are still nearly straight.
	 */
	SEEK_CURVE_AMPLITUDE_MAX_DEGREES: 14,

	/**
	 * The shortest full left-right cycle of a curving walk, in seconds. **Placeholder — 1.4.**
	 *
	 * **A period rather than a distance, because the curve is a motion and motions are measured in time.** The
	 * walk it is laid over is a different length every time, so a curve expressed in studs would be one cycle on
	 * a short walk and a third of one on a long walk, which is a different shape of detour for the same rule.
	 *
	 * **A range rather than a value, drawn once per walk** — see {@link NPC_CONFIG.SEEK_CURVE_PERIOD_MAX_SECONDS}
	 * — so that two rigs setting off in the same second do not trace the same path. At a rig's own 16 studs/s a
	 * 1.4-second cycle covers about 22 studs of walking, so a 47-stud trip is two gentle swings: enough for the
	 * shape to be *there* without the rig reading as drunk.
	 */
	SEEK_CURVE_PERIOD_MIN_SECONDS: 1.4,

	/**
	 * The longest full left-right cycle of a curving walk, in seconds. **Placeholder — 2.6.**
	 *
	 * **The other end of the draw, and the spread is the point rather than the difference.** Two rigs walking to
	 * two balls are the ordinary case in this game, and a single period would make them two bodies tracing one
	 * identical arc a moment apart — which is a *new* tell, and a worse one than the straight line this replaces.
	 * With a period drawn from this range and a phase drawn per walk (see `SeekBehavior`), two walks made at the
	 * same instant by the same rule are visibly different paths.
	 */
	SEEK_CURVE_PERIOD_MAX_SECONDS: 2.6,

	/**
	 * How close an enemy has to be for a walking rig to bother bluffing it, in studs. **Placeholder — 30.**
	 *
	 * **This is the distance at which a ball could arrive, not the distance at which a body is interesting.** The
	 * bluff exists because the rig is about to be thrown at, so the radius has to be inside an armed body's own
	 * throw: thirty studs is about half a second of flight at the slowest charged throw the game makes, which is
	 * the window in which a sidestep can plausibly be a reaction to the throw rather than a movement with no cause.
	 * Outside it, the rig would be shuffling at somebody who cannot reach it yet and the movement would read as a
	 * rig that walks badly rather than as a rig that knows what is coming.
	 *
	 * **Smaller than {@link NPC_CONFIG.SEEK_JUMP_ENEMY_RADIUS_STUDS} deliberately**, and the two are not the same
	 * question: a hop is a body being *near* the rig, which is a fact about the floor, while a shuffle is a threat
	 * that is *armed and could reach it*, which is a fact about danger. A rig therefore hops at bodies it is
	 * passing and shuffles at bodies that are about to throw, and the second circle sits inside the first.
	 */
	PANIC_ENEMY_RADIUS_STUDS: 30,

	/**
	 * The chance that a rig walking to a ball decides to bluff an armed enemy, **rolled once per walk**.
	 * **Placeholder — 0.15, the user's own number.**
	 *
	 * **Once per walk rather than per turn, and that is the whole of the design.** A 15 % roll at the seek's
	 * cadence would be a rig that shuffles on *every* walk to *every* ball, because two turns is all the larger of
	 * 1 − 0.85² = 28 %; the event would stop being occasional in the first second and the number would mean
	 * nothing. Rolled once, it is the chance of *this approach* being a cautious one, which is what the user asked
	 * for. The roll happens when the walk is chosen and the movement itself waits for an enemy to be armed and
	 * near — see `SeekBehavior`.
	 *
	 * **A rig that fails the roll does not re-roll**, which is the same fact said the other way: the roll is
	 * stored on the walk, so a rig cannot eventually shuffle by being persistent. What that costs is stated:
	 * a walk can pass an armed enemy at the exact moment the roll said no, and nothing happens — which is the
	 * honest reading of 15 %, and the alternative (a roll per turn) is a different feature wearing this number.
	 */
	PANIC_SHUFFLE_CHANCE: 0.20,

	/**
	 * How long a rig walks its sidestep before resuming the walk to the ball, in seconds. **Placeholder — 1.**
	 *
	 * **Longer than the sidestep takes, on purpose, and the extra is the point.** Eight studs at a rig's own walk
	 * of {@link NPC_CONFIG.WALK_TO_PAD_SPEED} is a little under four tenths of a second, so this leaves the rig
	 * standing at the end of the step for the rest of the window — which is what makes the movement read as
	 * *hesitation* rather than as a body that walked sideways for no reason and then thought better of it. See
	 * {@link NPC_CONFIG.PANIC_SIDESTEP_STUDS} for the distance and why one step rather than two.
	 */
	PANIC_SHUFFLE_SECONDS: 1,

	/**
	 * How far to one side a rig's sidestep takes it, in studs. **Placeholder — 8.**
	 *
	 * **One step, not two, and the distance is most of why.** Two sidesteps is a dance: it reads as a rig with a
	 * movement pattern rather than as a rig reacting to something, and a pattern is the tell this whole file is
	 * about. One step is a body half-turning away and half-turning back. Eight studs is just past a body's own width
	 * — enough that the rig has visibly *left the line* it was walking, which is what a person does when they think
	 * a ball is coming, and not so far that the rig has abandoned the ball it was fetching.
	 *
	 * **The sidestep is perpendicular to the approach, at the moment the shuffle starts**, so the rig steps out of
	 * the line rather than forwards or backwards, and the walk to the ball afterwards is short. See
	 * `SeekBehavior.maybeShuffle`.
	 */
	PANIC_SIDESTEP_STUDS: 8,

	/**
	 * How far a rig keeps walking after its hand fills, in studs. **Placeholder — 8.**
	 *
	 * **The walk does not end the instant the ball arrives, and that is the whole of this block.** A rig used to
	 * stop on the turn the pickup took its ball — not because anything about throwing wanted a still body, but
	 * because `SeekBehavior`'s first stop condition is "is a ball in hand", and a rig with a full hand has nothing
	 * left to *fetch*. From a seat that is a body that stops dead at the ball it just took and then turns, which is
	 * the one part of a rig's cycle that a player's does not have: a person arrives moving, and the throw comes out
	 * of a body that is still going somewhere.
	 *
	 * **Eight studs is a little over a body's own width, which is the size at which it reads as a carry-through
	 * rather than as a stutter.** At {@link NPC_CONFIG.WALK_TO_PAD_SPEED} it is half a second of walking — long
	 * enough to be seen, short enough that it is over by the time the rig has finished turning. Which *way* the
	 * eight studs go is the interesting half and it is not here: see
	 * {@link NPC_CONFIG.PICKUP_BACKPEDAL_CHANCE} and `SeekBehavior`'s `pickupWalk`.
	 */
	PICKUP_WALK_STUDS: 8,

	/**
	 * How long a rig keeps walking after its hand fills, in seconds. **Placeholder — 0.75.**
	 *
	 * **Longer than the distance takes, on purpose, for the reason the shuffle's window is longer than its step:**
	 * eight studs at a rig's own walk is half a second, so this leaves the walk to *arrive* at its point and then
	 * the body to stand there for a beat before the throw. A window that ended exactly on arrival would make the
	 * carry-through a movement with no end, and the point of it is that a body comes to rest somewhere and then
	 * throws.
	 *
	 * **This is also the window in which a windup may begin, and the two are the same window on purpose.** The rig
	 * turns onto its target over a few tenths of a second, so the throw usually decides *during* the
	 * carry-through — and what happens to this walk then is the whole of `THROW_MOVING_CHANCE`. A *planted* throw
	 * ends it on the same turn it decides, with a charge solved on that very turn, which is why a plant cannot make
	 * a throw land short (see `Charging` below and `SeekBehavior`). A throw *on the move* keeps it instead, and
	 * this window is what the seek keeps pushing out for the length of the hold — so this number is also how long
	 * the body carries on **after** a moving release. A window that ended exactly on arrival would make the moving
	 * branch a body that stopped mid-windup, which is why the extra beat was already here before either branch.
	 */
	PICKUP_WALK_SECONDS: 0.75,

	/**
	 * The chance that a rig's walk after a pickup is **backwards** rather than onwards. **Placeholder — 0.4.**
	 *
	 * **The user's own addition, and it is the one movement in this file that a person does and a rig did not:**
	 * backing away from the body you are about to throw at, with your face still on it. What makes it work is
	 * already in the code and was not put there for this — `ThrowBehavior`'s `AlignOrientation` holds the rig's
	 * facing on its target with `AutoRotate = false`, which is exactly what leaves the *walk* free to go somewhere
	 * else. So the two halves are the same two halves a person uses: the legs go one way and the eyes do not move.
	 *
	 * **Gated on there being a body to face**, and that gate is not this number — see `SeekBehavior.pickupWalk`,
	 * which only draws the backwards version when the enemy is inside {@link NPC_CONFIG.THROW_RANGE_STUDS}, the
	 * same distance inside which the throw is holding an aim on it. Outside that the rig is not facing anybody, and
	 * a rig walking backwards while looking where it is going is a moonwalk rather than a backpedal.
	 *
	 * **Forty per cent, which is "sometimes" rather than a coin.** Half would make the two cases a choice nobody
	 * could tell apart from a bug; a tenth would make the backpedal a rare event that a player never learns to
	 * read. At this rate a rig backs off about two pickups in five, which is often enough to be a behaviour and
	 * rare enough to still be a decision.
	 */
	PICKUP_BACKPEDAL_CHANCE: 0.4,
} as const;
