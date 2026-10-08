/**
 * The mystery box: how often one appears, how many may be out, and how long its power lasts.
 *
 * **Read by `server/services/mystery/MysteryBoxService.ts` alone today, and in `shared/config/` anyway** —
 * the arrangement `shiftLock.config.ts` documents, and for the same reason. Nothing in here is a *server's*
 * business to decide: these are the numbers a person tuning the game would ask to have changed, which is
 * exactly what a config file is for.
 *
 * **Two rates rather than one, because the box means two different things in two different places.** On the
 * field it is a rare piece of luck — something a player notices, chases and occasionally gets — so it is
 * rationed by a roll and by caps. On a practice floor it is equipment: a player is there *to* use it, and a
 * box they have to wait for is a box that makes practising slower than playing. See
 * {@link MYSTERY_CONFIG.ZONE_RESPAWN_DELAY} for the second rate and the reasoning.
 */
export const MYSTERY_CONFIG = {
	/**
	 * How often the spawners are asked, in seconds. **Placeholder.**
	 *
	 * **Ten seconds is the interval the roll is defined against**, so this and
	 * {@link MYSTERY_CONFIG.SPAWN_CHANCE} are one number expressed twice: 5% every ten seconds is the rate
	 * the game is actually tuned to, and splitting them is what lets the roll be reasoned about at all — a
	 * single "one per three minutes" figure would be the same rate and would hide that the game checks ten
	 * times more often than it gives.
	 *
	 * **Not the zone's rate.** A spawn point inside a practice zone ignores both of these and is instead
	 * kept stocked continuously; see {@link MYSTERY_CONFIG.ZONE_RESPAWN_DELAY}.
	 */
	SPAWN_TICK_INTERVAL: 10,

	/**
	 * The chance, per spawn point, that a tick produces a box. **Placeholder — 5%.**
	 *
	 * **A roll rather than a guaranteed spawn, and the reason is what the field is like to play on.** A box
	 * that appears on a fixed clock is furniture: players learn when it comes and stand next to it, and the
	 * thing stops being an event. A roll makes it something somebody happens to be near, which is the whole
	 * of why it is worth crossing a dodgeball court for.
	 *
	 * **The caps below are what actually bound the field, not this.** A roll alone would still occasionally
	 * put three boxes out at once on a lucky tick, so {@link MYSTERY_CONFIG.MAX_TOTAL} is the knob that keeps
	 * the arena readable; this one only decides how often the question is asked. Tune this to change how
	 * often a player sees a box, and the caps to change how many they can see at once.
	 *
	 * At 5% a tick, a spawn point produces a box roughly once every 200 seconds — a bit over three minutes —
	 * which is a handful per round on an arena with several spawn points.
	 */
	SPAWN_CHANCE: 0.05,

	/**
	 * How long after a collection a practice zone's spawn point is restocked, in seconds. **Placeholder.**
	 *
	 * **Two seconds, and it is a completely different rule from the two above rather than a faster version
	 * of them.** Inside a practice zone there is no roll and no waiting for a tick: the point is kept
	 * stocked, and a player who collects a box gets another one two seconds later. The number is chosen to
	 * be long enough that the new box is visibly *a new box* — it appears while the player is still looking
	 * at where the last one was, so the rule reads as "these come back" rather than as a box that was never
	 * taken — and short enough that a practice session is not spent waiting.
	 *
	 * **Why the delay exists at all**, rather than the box reappearing in the same frame: collecting would
	 * then be a permanently open window, and the 10 seconds would restart before the player had used any of
	 * it. The gap is what makes a collection an event with a consequence.
	 */
	ZONE_RESPAWN_DELAY: 2,

	/**
	 * How many boxes one spawn point may have out at once. **Placeholder — 1.**
	 *
	 * **The cap exists because the roll is per tick and the tick repeats.** Without it a run of lucky rolls
	 * stacks boxes on one pad, which is both ugly and meaningless: nothing about two boxes in the same stud
	 * is better than one, and the second is a duplicate the player cannot tell from the first.
	 *
	 * **It does not apply inside a practice zone**, and that is not an exemption so much as a consequence —
	 * a zoned spawn point is *defined* to hold exactly one box, so a cap of one is already its rule. See
	 * {@link MYSTERY_CONFIG.MAX_TOTAL} for the cap that is genuinely switched off there.
	 */
	MAX_PER_SPAWNER: 1,

	/**
	 * How many boxes may be out in the whole world at once. **Placeholder — 3.**
	 *
	 * **The cap that keeps the arena a place with a rare thing in it.** Without a total limit, N spawn points
	 * each rolling independently put N boxes on the field together eventually, and the box stops reading as
	 * an event at all — which is the one quality the roll above exists to preserve. Three is enough that two
	 * separate spawn points can be lucky at once and a player can see one in two places, and few enough that
	 * a fourth is not.
	 *
	 * **Switched off inside a practice zone**, deliberately. A practice floor is a sandbox: the boxes there
	 * are not competing for a scarce slot with the ones on the field, nothing is being rationed, and a cap
	 * could only stop the guarantee — a player on a practice floor with three boxes already out would find a
	 * zoned spawn point that had silently stopped stocking itself. The zones are counted separately from the
	 * field by construction: this cap counts the boxes a *roll* produced.
	 */
	MAX_TOTAL: 3,

	/**
	 * The box's edge length in studs. **Placeholder — 3.**
	 *
	 * **Big enough to notice and to aim at, small enough not to be scenery.** A player has to be able to see
	 * it across an arena and walk into it deliberately, and it must not read as an obstacle — which it cannot
	 * be, because it is `CanCollide = false`; the size is about legibility rather than about space.
	 */
	SIZE: 3,

	/**
	 * Where the float bottoms out: how far above the spawn point's own centre the box sits, in studs.
	 * **Placeholder — 2.**
	 *
	 * **The low end of the float, not its middle.** The box is raised to this height and then rises from it
	 * by {@link MYSTERY_CONFIG.HOVER_BOB_HEIGHT}, so a marker sitting in the floor puts the box's lowest
	 * point two studs clear of it. That is what "floating" has to mean: a box that dips to the marker's own
	 * centre reads as something bolted to the ground that is twitching.
	 *
	 * **This entry used to argue against moving the box at all, and it was overruled rather than
	 * forgotten.** The old case was the right one as far as it went — the `CFrame` of a moving part
	 * replicates on every client each time it is written, so a float is sixty writes a second per box, for
	 * a cube nothing aims at — and it pointed at a `HingeConstraint` as the tool that would float it for
	 * free. Two things changed under it:
	 *
	 * - **The box is now looked at.** Its motion is not decoration on a cube; a turning box with the `?`
	 *   face coming round is the thing that says *prize* from across an arena, and "a cube nothing aims at"
	 *   stopped being a description of it.
	 * - **The hinge is not actually free.** A constraint holds a box up only if something holds the
	 *   constraint, so it needs an invisible anchored part for the other end, two attachments, an assembly
	 *   and a collision story — and it gives up `Anchored`, which is what makes the box's position this
	 *   service's to decide at all. An unanchored box is a box players can nudge, that the physics step
	 *   owns, and that a bug can send to `FallenPartsDestroyHeight`; the `CFrame` write keeps every one of
	 *   those answers unchanged.
	 *
	 * **The cost, stated as a number rather than as a principle.** The map caps the field at
	 * `MAX_TOTAL` (3) rolled boxes, so a full field is three `CFrame` writes per frame — 180 a second at
	 * 60 Hz, about 9 KB a second of replication — plus one per *zoned* spawn point, which no cap bounds and
	 * which is a practice floor's own furniture. That is the whole bill, and it is affordable for the only
	 * thing in the arena that is meant to be noticed from the other side of it.
	 */
	HOVER_HEIGHT: 2,

	/**
	 * How far the float rises above {@link MYSTERY_CONFIG.HOVER_HEIGHT}, in studs. **Placeholder — 0.5.**
	 *
	 * **Half a stud, measured against the box rather than against the world.** A box is `SIZE` (3) studs
	 * on a side, so this is a sixth of its own height: enough that the movement is legible from the range a
	 * player decides whether to walk over, and small enough that the box never looks thrown. The range it
	 * produces is **2.0 to 2.5 studs above the floor** — the two ends, not a centre and a radius.
	 */
	HOVER_BOB_HEIGHT: 0.5,

	/**
	 * One full float cycle, in seconds. **Placeholder — 3.**
	 *
	 * **Slow enough to read as drifting rather than as vibrating, which is the only thing this number
	 * decides.** Peak vertical speed is `HOVER_BOB_HEIGHT / 2 * 2π / period`, which with these values is
	 * about half a stud a second — roughly a thirtieth of a walking pace. A player walking past sees
	 * something hanging in the air and moving, and cannot catch the instant it turns around. One second is
	 * that same displacement three times as fast, which is a piston; ten is slow enough to read as a
	 * rendering wobble rather than as a float.
	 *
	 * **A cosine, so the box starts at the bottom.** It is *placed* at `HOVER_HEIGHT` and rises from there,
	 * so the pose a box is born in is the pose it returns to — and a cosine's endpoints are its extremes,
	 * which is why the float settles at the top and the bottom of each cycle instead of reversing abruptly
	 * at both.
	 */
	HOVER_BOB_PERIOD: 3,

	/**
	 * One full turn of the box, in seconds. **Placeholder — 12.**
	 *
	 * **Thirty degrees a second: continuous, and deliberately unhurried.** A pickup that spins quickly
	 * reads as a coin in a platformer and pulls the eye off the ball. The job here is smaller than that —
	 * a box a player is already walking towards should look alive on the way in — and twelve seconds is
	 * also chosen against the `?`: six faces means a face comes round every two seconds, which is
	 * roughly how long a player spends crossing the last stretch of floor to it.
	 *
	 * **About the box's own up, so the horizon stays level.** A turn about a horizontal axis makes the box
	 * tumble, and a tumbling box reads as *falling*, which is the one thing a floating one must not look
	 * like. Its own up rather than the world's, because a box's base pose is its spawn point's own
	 * orientation — so a marker an artist has turned turns what it holds.
	 */
	HOVER_SPIN_PERIOD: 12,

	/**
	 * How many colours the rainbow cycle runs through, and how long the whole cycle takes.
	 *
	 * **The colour is generated rather than authored**, which is the one part of this box's appearance that
	 * needs no artist: `Hue` walked around the wheel and read as a `Color3`. It costs three lines and it is
	 * the difference between a cube and a thing that is plainly a prize.
	 */
	RAINBOW_COLOUR_COUNT: 12,
	RAINBOW_PERIOD: 4,

	/**
	 * The asset id for the `?` that belongs on each of the box's faces. **Empty, and it must stay empty until
	 * an artist makes one.**
	 *
	 * **Nothing here invents an id, and empty no longer means blank.** A `Decal` with a made-up
	 * `rbxassetid://` is not a placeholder — it is a broken image that fails at runtime, in a place where
	 * nothing will tell you why, and which a later reader has no way to distinguish from an id that was
	 * mistyped. So the empty string stays the honest form of "no texture yet" — and the box draws its `?` as
	 * *text* on each face until an id arrives, because "no art yet" was never meant to mean "no `?` yet". Set
	 * this and the text is not built at all; leaving it empty is what keeps the box a mystery box rather than
	 * a plain cube in the meantime.
	 *
	 * **Cell shading is not here either, and cannot be.** It is a texture or a shader, and the nearest a part
	 * can get without one is `Neon` — which is not cell shading, it is a different look with a different cost.
	 * Claiming otherwise in a comment would be worse than the gap. See the service for what is drawn instead.
	 */
	FACE_DECAL_ID: "",
} as const;
