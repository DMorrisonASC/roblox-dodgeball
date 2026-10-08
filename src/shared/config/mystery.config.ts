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
	 * How long the power a box grants may be used for, in seconds. **Placeholder — 10.**
	 *
	 * **The same length as `SUPER_CONFIG.MULTI_BALL_DURATION_SECONDS`, and it is a second number rather than
	 * a reference to that one.** The two are equal today because both are "long enough to do something with
	 * and short enough to be a moment", and they are separately tunable because they are answers to different
	 * questions: MultiBall's ten seconds is what a *charge* buys, and this is what a box buys. A shared
	 * constant would make tuning one silently move the other.
	 *
	 * **Ten seconds is roughly one throw and one decision.** A window shorter than the reload between throws
	 * would be a box that grants nothing; much longer and the box stops being a moment and starts being a
	 * mode, which is what the caps above are protecting the field from.
	 */
	WINDOW_SECONDS: 10,

	/**
	 * The box's edge length in studs. **Placeholder — 3.**
	 *
	 * **Big enough to notice and to aim at, small enough not to be scenery.** A player has to be able to see
	 * it across an arena and walk into it deliberately, and it must not read as an obstacle — which it cannot
	 * be, because it is `CanCollide = false`; the size is about legibility rather than about space.
	 */
	SIZE: 3,

	/**
	 * How far above the spawn point's own centre the box floats, in studs. **Placeholder — 2.**
	 *
	 * **A fixed height, and there is deliberately no bob.** A box that moves is a box whose `CFrame` is
	 * written every frame — the property replicates every time it changes, so a gentle float costs sixty
	 * writes a second per box across every client on the server, for something no player will ever aim at
	 * more accurately for it. The box is anchored at this height when it is made and it stays there; what
	 * moves is its *colour*, which is one write every third of a second and is the stronger signal anyway.
	 * A `HingeConstraint` rig would float it for free, and that is the right tool and a far larger one: it
	 * is not worth an assembly, two attachments and a constraint to move a cube two studs up and down.
	 */
	HOVER_HEIGHT: 2,

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
	 * **Nothing here invents an id.** A `Decal` with a made-up `rbxassetid://` is not a placeholder — it is a
	 * broken image that fails at runtime, in a place where nothing will tell you why, and which a later reader
	 * has no way to distinguish from an id that was mistyped. The empty string is the honest form of "this
	 * face has no art yet", and it is checked before a decal is made rather than after, so the box simply has
	 * no faces until there is something to put on them.
	 *
	 * **Cell shading is not here either, and cannot be.** It is a texture or a shader, and the nearest a part
	 * can get without one is `Neon` — which is not cell shading, it is a different look with a different cost.
	 * Claiming otherwise in a comment would be worse than the gap. See the service for what is drawn instead.
	 */
	FACE_DECAL_ID: "",
} as const;
