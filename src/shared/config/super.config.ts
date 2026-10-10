/**
 * The numbers behind the charged abilities.
 *
 * A config file rather than constants inside `SuperService`, for the reason every other config
 * exists: the mechanic is a handful of numbers, they are the part that gets tuned, and they belong
 * where tuning is one edit rather than a hunt through a service. It is also the file a designer can
 * read to find out what the rule is without following `Map`s and `Set`s.
 */
export const SUPER_CONFIG = {
	/**
	 * Hits a player needs to wear a crown on their own, without being compared to anybody.
	 *
	 * **Placeholder.** Three is a first guess, and it is the number to move when the crown turns up too
	 * early or too late. It is half of the rule — a player at or above this is crowned whatever their
	 * side is doing, and a player below it can still be crowned by being the highest on their side. See
	 * `SuperService.refreshCrowns` for the pair and for why a tie crowns both.
	 *
	 * **It is not a target, and nothing is earned at it.** The number that stood here was
	 * `STREAK_REQUIRED`, the run of hits that bought a super charge. That grant is gone — see
	 * `SuperService.noteHit` for what it was and why — and this is what replaced it: the same count, read
	 * as a threshold for something *visible* rather than something spendable.
	 */
	CROWN_STREAK_THRESHOLD: 3,

	/**
	 * How many throws a MultiBall window pays for. **Placeholder — 5 is the ask.**
	 *
	 * **A count of *throws*, not of balls on the field.** The window replaces the ball a player throws
	 * until this many have gone, and then it stops replacing them: the last throw of the window is not
	 * answered, so spending the final one leaves the hand empty. The ball a player is already holding
	 * when the window opens is therefore *on top* of this number rather than inside it — which is also
	 * why a window opened on an empty hand hands over its first ball without charging for it. See
	 * `BallService.refillFromBuff`, where "answer this throw" and "fill this hand" are one rule.
	 *
	 * **This is now the whole of the window, and that is the change.** `MULTI_BALL_DURATION_SECONDS` used
	 * to sit above it and the window closed on whichever ran out first; the clock is gone and **the count
	 * is the only limit.** Spending the fifth throw is what closes the window — see
	 * `SuperService.consumeMultiBallBall`, which is where the row is dropped — and there is no deadline
	 * left to publish, no attribute carrying one, and no timer scheduled to clear the row afterwards.
	 *
	 * **What that buys, and what it costs.** It buys a promise the old version could not make: the
	 * ability can no longer expire in a player's hand, so five throws are five throws whether they are
	 * taken in four seconds or spaced out across a round. **It costs the ability its shape** — MultiBall
	 * is a *stock* now rather than a burst, and a player who opens a window early and dribbles it out
	 * holds a super for most of the round. That is the honest description of "no timer, count only".
	 * **If a burst is wanted after all, the middle is a long duration rather than this number** — a
	 * minute, say, which keeps the throws counting down and puts back an upper bound without making the
	 * window something a player can lose by walking to a ball. The ten seconds that used to be here is
	 * not that middle: it was short enough to expire mid-decision, which is why it was removed.
	 */
	MULTI_BALL_BALL_COUNT: 5,

	/**
	 * How long a Freeze bite lasts, in seconds. **Placeholder — 3 is the guess.**
	 *
	 * **Long enough to be worth a charge, short enough that it is a moment rather than a round.** Three
	 * seconds is about the time it takes somebody to be reached by whoever the freeze was bought for,
	 * which is the whole use of it: it does not win anything on its own, it makes the next few seconds
	 * unavoidable for everybody standing near where the ball landed.
	 *
	 * The number to move first if the ability reads as unfair, and the one to move up if it reads as
	 * pointless. Nothing else changes with it: the clock is per body, so a body frozen late in the
	 * effect's window is held for the full duration rather than whatever was left.
	 */
	FREEZE_DURATION_SECONDS: 3,

	/**
	 * How far the freeze reaches from the body part a Freeze ball struck, in studs. **Placeholder.**
	 *
	 * **The hit radius and the miss radius are two numbers because they are two different promises.**
	 * Hitting somebody is what the ability is aimed at, so it pays a radius wide enough to catch the
	 * people standing with them; a ball that hits the world is the ability going wrong, so it pays a
	 * smaller one — enough that a shot which lands at somebody's feet still does something, not enough
	 * that a wild throw freezes a room.
	 *
	 * Eight studs is a little more than two bodies across, which is the shape to check in Studio: too
	 * small and the splash is a slower Pierce with no splash at all, too large and one throw in a
	 * group freezes everybody in it.
	 */
	FREEZE_HIT_RADIUS: 8,

	/**
	 * How far the freeze reaches from where a Freeze ball stopped, in studs, when it tagged nobody.
	 * **Placeholder.**
	 *
	 * Smaller than {@link FREEZE_HIT_RADIUS} on purpose — see that comment for why the two are not one
	 * number. Five studs is about one body's reach, so a ball that clips a wall beside somebody freezes
	 * them and a ball that hits the wall across the arena freezes nobody.
	 */
	FREEZE_MISS_RADIUS: 5,

	/**
	 * The colour a frozen body's outline is drawn in. **Placeholder — and the one non-number here.**
	 *
	 * **Blue, and deliberately nothing like a side's colour.** The outline a body already wears is doing
	 * a job: it is black for a rig and a side's colour for a player who is in a round. So a freeze has to
	 * read as a *state* rather than be mistaken for a team, and a saturated blue is on nobody's side in
	 * this game.
	 *
	 * It is written onto the `Highlight` the body already has rather than by adding a second one — the
	 * engine draws one outline per model and its choice between two is undefined. See
	 * `OutlineService.overrideOutlineColour`, which is the only writer, and `FreezeService.unfreeze`,
	 * which puts back whatever was there before.
	 */
	FREEZE_OUTLINE_COLOR: Color3.fromRGB(80, 160, 255),

	/**
	 * Whether a frozen body is given a block of ice to stand in. **Placeholder — creation switch.**
	 *
	 * **A creation switch rather than a visibility one**, which is the shape `BALL_CONFIG.TRAIL_ENABLED`
	 * documents: with this off nothing is built at all, rather than something being built and hidden, so
	 * "off" costs nothing and leaves no part in the world to be found later. It is here for the one
	 * question a look like this cannot be reviewed without — turning it off has to leave the freeze
	 * itself exactly as it was, and this is how that is checked.
	 */
	FREEZE_BLOCK_ENABLED: true,

	/**
	 * How see-through the ice is — 0 as solid as the engine draws a part, 1 as invisible.
	 * **Placeholder — 0.5 is the guess.**
	 *
	 * **The whole of the look is this number.** Too solid and the body inside cannot be read at all,
	 * which is the wrong shape for a freeze: the person is held, not hidden, and the round still has to
	 * be playable around them. Too thin and the block stops being a shape and becomes a tint over
	 * whatever happens to be behind it.
	 */
	FREEZE_BLOCK_TRANSPARENCY: 0.5,

	/**
	 * The colour the ice is tinted. **Placeholder.**
	 *
	 * Pale blue, and deliberately lighter than {@link FREEZE_OUTLINE_COLOR} rather than the same value:
	 * the block is a volume of water in front of the body and the outline is a line drawn on the body
	 * itself, and an edge painted the same colour as the fill it is seen through reads as neither. The
	 * outline keeps the saturated blue, because it is the layer that has to survive being looked at
	 * through ice.
	 */
	FREEZE_BLOCK_COLOR: Color3.fromRGB(150, 200, 255),

	/**
	 * How much clear ice stands off each face of the body inside it, in studs. **Placeholder.**
	 *
	 * Added to *each dimension* — twice this number per axis — so the box is the body's own bounds grown
	 * by this much on every side.
	 *
	 * Small enough that the ice reads as fitted to the body rather than as a crate around it, and large
	 * enough that a limb does not stand proud of a face as the body is held mid-animation. Zero is legal
	 * and would put the block exactly on the bounds; the reason not to is the fraction of a stud the
	 * engine leaves a settled assembly inside the surface it rests on, which is enough to leave a foot
	 * outside its own ice.
	 */
	FREEZE_BLOCK_PADDING: 0.5,

	/**
	 * Whether a Freeze splash fires a burst of particles where the ball struck.
	 * **Placeholder — creation switch.**
	 *
	 * A peer to {@link FREEZE_BLOCK_ENABLED} rather than the same flag, for that one's reason: the block
	 * says which *body* is held and the burst says *where the ball hit*, and an argument about one of
	 * those looks should not be able to switch off the other. Off means nothing is built — not a part
	 * built and left, and not an emitter firing into nothing.
	 */
	FREEZE_BURST_ENABLED: true,

	/**
	 * The image the ice shards are drawn as. **THE USER UPLOADS THIS — replace `rbxassetid://0`.**
	 *
	 * **Nothing on disk produces this texture.** A particle is a quad with an image on it, and the engine
	 * ships no ice shard: a real `rbxassetid://…` has to be uploaded to the account this game runs on and
	 * pasted here. A zero id is a placeholder in the sense that it is not a shard — what a given id
	 * renders as is engine behaviour, and the honest statement about this one is that the effect will not
	 * look like ice until the real figure is in. It is not a crash and not a silent failure, just a burst
	 * of the wrong thing.
	 *
	 * **The prefix is required and the value is a string**, which is the house rule for every asset id in
	 * this repository — see `sound.config.ts` for the pattern, and `images.config.ts`, which documents the
	 * same replace-the-placeholder step for the loading logo.
	 */
	FREEZE_BURST_TEXTURE: "rbxassetid://0",

	/**
	 * How many particles one burst fires. **Placeholder — 40 is the ask.**
	 *
	 * The count in a single one-shot emission rather than a rate: see {@link FREEZE_BURST_LIFETIME} for
	 * why this effect is a burst and not a spray. Enough to read as a shatter at the range a throw is
	 * watched from, and few enough that one splash does not wash out the frozen bodies it just made.
	 */
	FREEZE_BURST_COUNT: 40,

	/**
	 * How long a particle lives, in seconds. **Placeholder — 0.6 is the ask.**
	 *
	 * **A number here and a `NumberRange` in the code**, like {@link FREEZE_BURST_SPEED} and
	 * {@link FREEZE_BURST_SPREAD_ANGLE}: the emitter wants ranges so it can vary each particle, and a
	 * single figure is what somebody tuning this actually has an opinion about. `buildBurst` does the
	 * wrapping.
	 *
	 * This is also the effect's whole lifetime. The burst is over in a fraction of a second and the
	 * ability's own freeze lasts seconds — the two are deliberately unrelated, which is why the burst is
	 * not stored on any frozen body and does not care when a freeze ends.
	 */
	FREEZE_BURST_LIFETIME: 0.6,

	/**
	 * How fast the shards leave the impact, in studs per second. **Placeholder — 18 is the ask.**
	 *
	 * **Most of what makes it read as an impact rather than a puff.** A body is about five studs tall, so
	 * at this speed a shard crosses a body's height in the time it lives — fast enough to look thrown,
	 * slow enough to still be a shard when the burst ends. Too slow and it is a cloud, too fast and the
	 * particles are gone before the eye has found the impact.
	 */
	FREEZE_BURST_SPEED: 18,

	/**
	 * How wide the cone the shards fly out in is, in degrees. **Placeholder — 60 is the ask.**
	 *
	 * Measured from the emitter's own forward direction, which `buildBurst` points straight up out of the
	 * impact — so this is a cone standing on the ground, and the shards come out of it in every direction
	 * rather than the flat fan the disc-and-spikes version had.
	 *
	 * **A `Vector2` in the code and one number here**, because the emitter takes a horizontal and a
	 * vertical spread separately and this effect has no reason to want them different. Zero would be a
	 * single line of particles, which is a beam.
	 */
	FREEZE_BURST_SPREAD_ANGLE: 60,

	/**
	 * How big a shard is over its life, as a `NumberSequence` keyed on lifetime 0 to 1.
	 * **Placeholder.**
	 *
	 * **Growing then shrinking, which is what makes it read as a shard rather than a dot.** A particle
	 * that appears at full size and vanishes is a sprite; one that snaps out to size and then thins as it
	 * dies reads as something that came apart. The values here are studs, and they are the only size in
	 * this effect — nothing else about the burst is measured in studs except this and the speed.
	 */
	FREEZE_BURST_SIZE: new NumberSequence([
		new NumberSequenceKeypoint(0, 0.4),
		new NumberSequenceKeypoint(0.15, 1.6),
		new NumberSequenceKeypoint(1, 0.2),
	]),

	/**
	 * How see-through a shard is over its life, as a `NumberSequence` keyed on lifetime 0 to 1.
	 * **Placeholder.**
	 *
	 * **Invisible at birth and gone at death, with the solid part in between**, which is a different
	 * curve from the size one on purpose: a particle that pops in at full opacity reads as a texture
	 * appearing, where one that fades up reads as a shard catching the light as it turns. The tail end is
	 * the long half, because the shards are falling apart by then.
	 */
	FREEZE_BURST_TRANSPARENCY: new NumberSequence([
		new NumberSequenceKeypoint(0, 1),
		new NumberSequenceKeypoint(0.15, 0.3),
		new NumberSequenceKeypoint(0.7, 0.6),
		new NumberSequenceKeypoint(1, 1),
	]),

	/**
	 * The colour the shards are tinted. **Placeholder — the block's blue, deliberately.**
	 *
	 * A `Color3` here and a `ColorSequence` in the code, for {@link FREEZE_BURST_LIFETIME}'s reason: one
	 * colour is what the effect is, and the emitter wants the sequence form. See
	 * `FREEZE_BLOCK_COLOR` — the same tint is the point, so an ice burst and the body it froze read as
	 * one material.
	 */
	FREEZE_BURST_COLOR: Color3.fromRGB(150, 200, 255),

	/**
	 * How much the shards light their surroundings. **Placeholder — 0.5 is the ask.**
	 *
	 * **The one property here that is about being seen rather than about looking right.** A freeze lands
	 * at the far end of an arena as often as it lands beside you, and at that distance a translucent blue
	 * burst against a blue-ish floor is close to invisible; a little emission is what makes the impact
	 * legible from the other side of the map. Zero is flat and honest, 1 is neon.
	 */
	FREEZE_BURST_LIGHT_EMISSION: 0.5,

	/**
	 * What fraction of the world's gravity pulls the shards back down. **Placeholder — 1 is the ask.**
	 *
	 * **1 means the shards arc and fall like anything else**, 0 means they fly in a straight line for
	 * their whole life and vanish still travelling — which reads as a spray of light rather than as
	 * pieces of something. Above 1 they drop like gravel, which is the knob to reach for if the burst
	 * looks floaty.
	 *
	 * A scale rather than a figure in studs per second squared because the interesting question is
	 * whether it respects the world it is in: turn `Workspace.Gravity` down for a moon map and the shards
	 * should come down with it rather than carrying a number that no longer means anything.
	 */
	FREEZE_BURST_GRAVITY_SCALE: 1,

	/**
	 * Whether a Freeze ball wears an aura while it is being held. **Placeholder — creation switch.**
	 *
	 * The third of the three, and a peer of the other two for their reason: this one is about a *ball
	 * being loaded*, which is neither the block's question (which body is held) nor the burst's (where
	 * the ball struck). Off means the emitter is never built — not built and hidden.
	 */
	FREEZE_AURA_ENABLED: true,

	/**
	 * The image an aura particle is drawn as. **THE USER UPLOADS THIS — replace `rbxassetid://0`.**
	 *
	 * **Rounder reads better here than the burst's shard**, which is worth saying because the two could
	 * otherwise share one id and it would look wrong on one of them: the burst is something breaking, so
	 * its particles are sharp and momentary, while an aura is a glow that persists, where a hard-edged
	 * shard turns into visible confetti drifting around a ball that is being carried. A soft dot, a
	 * snowflake, a small cloud.
	 *
	 * A zero id is a placeholder — see `FREEZE_BURST_TEXTURE` for what that means and why nothing on
	 * disk can stand in for it.
	 */
	FREEZE_AURA_TEXTURE: "rbxassetid://0",

	/**
	 * How many particles the aura emits per second. **Placeholder — 15 is the ask.**
	 *
	 * **Continuous, and that is the one property that separates this emitter from the burst's.** The
	 * burst sets `Rate = 0` and fires a count in one call; this one has no `Emit` call anywhere and the
	 * count is a *rate*. What that works out to around the ball at rest is this multiplied by the
	 * lifetime — about twelve particles at the values here — which is the number to think in when tuning:
	 * too few and the ball looks briefly dusty, too many and it looks like fog with a ball hidden in it,
	 * and the aim guide has to stay readable through the middle of it.
	 */
	FREEZE_AURA_RATE: 15,

	/**
	 * How long an aura particle lives, in seconds. **Placeholder — 0.8 is the ask.**
	 *
	 * The other half of the count above, and the one to shorten first if the aura reads as fog: halving
	 * this halves how much ice is around the ball at any moment, and it does so without making the
	 * emission any less smooth. Long enough that a particle is still drifting when the next batch
	 * arrives, which is what makes it read as a cloud rather than as a spray.
	 */
	FREEZE_AURA_LIFETIME: 0.8,

	/**
	 * How fast an aura particle leaves the ball, in studs per second. **Placeholder — 2 is the ask.**
	 *
	 * **Deliberately almost nothing.** A ball is a small object being carried around, and this is not a
	 * thing that throws sparks: the particles should appear at the surface and hang there while they
	 * fade, so the impression is a cold shell rather than a jet. Raise it and the aura becomes a stream
	 * the ball is dragging behind it, which is what the ball's own trail already does and is why the two
	 * must not look alike.
	 */
	FREEZE_AURA_SPEED: 2,

	/**
	 * How wide the aura's emission cone is, in degrees. **Placeholder — 180, which is all around it.**
	 *
	 * **The one number here that is a shape rather than a size.** A ball has no front, so an aura with a
	 * direction is a spray coming off one side of it; a full sphere is the only cone that reads as a ball
	 * being wrapped in something. Anything below 180 is a deliberate decision to have the ice favour one
	 * side, which nothing about this wants. A `Vector2` in the code and one number here, for the reason
	 * `FREEZE_BURST_SPREAD_ANGLE` gives.
	 */
	FREEZE_AURA_SPREAD_ANGLE: 180,

	/**
	 * How big an aura particle is over its life, as a `NumberSequence` keyed on lifetime 0 to 1.
	 * **Placeholder.**
	 *
	 * **Starting at nothing and ending at nothing**, which is the whole difference between a cloud and a
	 * flicker: a particle that appears at full size reads as a texture popping in, and one that grows
	 * out of the ball's surface and shrinks back into the air reads as something forming and melting.
	 * The largest value here is the aura's actual size on screen — everything else about this effect is
	 * about *how many* there are.
	 */
	FREEZE_AURA_SIZE: new NumberSequence([
		new NumberSequenceKeypoint(0, 0.05),
		new NumberSequenceKeypoint(0.4, 0.7),
		new NumberSequenceKeypoint(1, 0.05),
	]),

	/**
	 * How see-through an aura particle is over its life, as a `NumberSequence` keyed on lifetime 0 to 1.
	 * **Placeholder.**
	 *
	 * **More transparent than the burst, on purpose.** This one is on screen for as long as the player
	 * holds the ball — minutes, potentially — and it is between the thrower's eye and their own aim
	 * guide, so it has to be readable as a hint of ice rather than as ice. The peak is brief so that the
	 * density never builds up, and the ends are invisible in both directions.
	 */
	FREEZE_AURA_TRANSPARENCY: new NumberSequence([
		new NumberSequenceKeypoint(0, 1),
		new NumberSequenceKeypoint(0.35, 0.45),
		new NumberSequenceKeypoint(1, 1),
	]),

	/**
	 * The colour an aura particle is tinted. **Placeholder — the block's blue, deliberately.**
	 *
	 * See `FREEZE_BLOCK_COLOR`: one ability, one tint, so a loaded ball, the body it freezes and the ice
	 * at the impact all read as the same material. A `Color3` here and a `ColorSequence` in the code, for
	 * `FREEZE_BURST_LIFETIME`'s reason.
	 */
	FREEZE_AURA_COLOR: Color3.fromRGB(150, 200, 255),

	/**
	 * How much an aura particle lights its surroundings. **Placeholder — 0.5 is the ask.**
	 *
	 * The same value and the same argument as the burst's: a loaded ball should be legible across an
	 * arena, and a translucent blue haze against an arena floor is not. Being carried, this one has the
	 * extra job of reading against the character holding it, who is often wearing something dark.
	 */
	FREEZE_AURA_LIGHT_EMISSION: 0.5,

	/**
	 * Whether marking a ball Freeze flashes the ball itself. **Placeholder — creation switch.**
	 *
	 * **The fourth and last of these, and the only one that is about the *player* rather than about a body
	 * or a ball.** The other three say where a freeze happened — the block on the body it holds, the burst
	 * where it struck, the aura on the ball that is loaded. This one says when it *started*: the moment the
	 * power is activated, which nothing else in the effect marks at all. Off means the ball simply takes its
	 * aura and nothing else changes, which is a state the rest of the ability works in.
	 */
	FREEZE_FLASH_ENABLED: true,

	/**
	 * The colour of the flash of light. **Placeholder — white.**
	 *
	 * **The colour of a *light*, not of the ball**, which is the whole of the correction this block carries:
	 * the ball is not repainted at any point. White because a flash is white, and because the ability's own
	 * tint is already being said by the aura around the ball — the glint itself is the one part of this that
	 * should be colourless.
	 */
	FREEZE_FLASH_COLOR: Color3.fromRGB(255, 255, 255),

	/**
	 * How long the light is on, in seconds. **Placeholder — 0.8, which is inside the "1 or less" asked for.**
	 *
	 * **On and then off, not a fade.** A `PointLight` has a `Brightness` and no way to ramp it without
	 * stepping it by hand, and at under a second a hard cut is what a flash already looks like. This is also
	 * the only duration here: the two-step sequence this used to be part of is gone.
	 */
	FREEZE_FLASH_SECONDS: 0.8,

	/**
	 * How bright the light is. **Placeholder — 5, against a documented default of 1.**
	 *
	 * The number that makes this a flash rather than a lamp. At the default a `PointLight` on a ball reads as
	 * an odd little glow; it wants to be high enough that the ball and the ground under it both visibly jump
	 * for the moment it is on. The engine draws only a limited number of lights, so *bright and brief* is
	 * also what keeps this from competing with the arena's own lighting.
	 */
	FREEZE_FLASH_BRIGHTNESS: 5,

	/**
	 * How far the light reaches, in studs. **Placeholder — 14, a little over two ball widths.**
	 *
	 * **Deliberately local.** A light that reaches across the arena is a change to the arena's lighting; a
	 * light that reaches the hand, the floor below it and whoever is standing next to the thrower is a ball
	 * having something happen to it. Enough that somebody near the thrower sees they are loaded.
	 */
	FREEZE_FLASH_RANGE: 14,

	/**
	 * Whether the ball is also briefly set to `Neon`. **Placeholder — on.**
	 *
	 * **Because a `PointLight` does not light the part it is inside of.** A light at the centre of a sphere
	 * has every face of that sphere turned away from it, so the surroundings flash and the ball itself stays
	 * exactly as dull as it was — which is the opposite of a glint. `Neon` is how a part is made to look
	 * self-lit, and it keeps the ball's own colour: it is the ball *shining*, not the ball being painted.
	 * Turn this off for a flash that only lights the scene.
	 */
	FREEZE_FLASH_GLOW_MATERIAL: true,
} as const;
