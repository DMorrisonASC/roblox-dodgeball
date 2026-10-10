/**
 * The throw's two pieces of feedback that are neither the ball's mechanics nor its sound: the kick the
 * thrower's own camera takes, and the gust of air the throw leaves behind.
 *
 * **A third file rather than more entries in `ball.config.ts`, and the split is the one `sound.config.ts`
 * already makes.** That file is the *sound* of the game, and the throw's id lives there rather than among the
 * ball's numbers because the two are tuned by different senses. `ball.config.ts` says of itself that it is
 * "everything about the ball" — how it is made, how long it lives, how a throw at a target is solved — and
 * every number in it is read by the solve both sides run. **Nothing here is read by a solve**, which is the
 * whole reason it is not in there: the shake is read by one client that does not care where the ball goes,
 * and the burst is read by the server once the ball has already been given its velocity. Three jobs in one
 * table is how a reader ends up tuning a ballistic constant by eye.
 *
 * **Both halves are marked off from each other because they run on opposite sides of the wire.** The shake
 * entries have one reader, `client/cameraShake.ts`, on the machine that threw; the burst entries have one
 * reader, `server/services/ball/WindBurst.ts`, on the server, which is what makes the gust visible to
 * everybody. Neither side reads the other's half.
 *
 * Imports nothing, for `ball.config.ts`'s reason: a config that depended on a service would be a service, and
 * these two files are read from both sides.
 *
 * Every number below is a `**Placeholder.**` — none of it has been looked at on a screen.
 */
export const THROW_FEEDBACK_CONFIG = {
	// ------------------------------------------------------------- the shake

	/**
	 * Whether the thrower's camera is kicked at all. **Creation switch.**
	 *
	 * A flag rather than a magnitude of zero, which is `super.config.ts`'s pattern for the freeze burst and
	 * its stated reason: a zero is a number somebody has to decide is deliberate, and this one is turned off
	 * as often to *test* the rest of a throw as to remove it.
	 */
	SHAKE_ENABLED: true,

	/**
	 * How far the camera is pushed **at full charge**, in studs. **Placeholder.**
	 *
	 * **A top value rather than a fixed kick, and what scales it is the *charge* rather than the ball's
	 * speed.** A throw is a hold of some fraction of `BALL_CONFIG.CHARGE_SECONDS`, and that fraction
	 * multiplies this figure — so a half hold is half the shake, and the shake for a given hold is the same
	 * number whether `CHARGE_MIN_SPEED` and `THROW_MAX_SPEED` are wide apart or narrow. Feeding the ball's
	 * speed in instead would tie a camera setting to the ballistic tuning, and the day the speed range is
	 * retuned every kick would move with it. See `cameraShake.ts`, which takes the charge and nothing else.
	 * The one equivalence worth knowing: `chargeSpeed` is a straight interpolation between the two speeds, so
	 * "the charge" and "how far up the speed range this throw sits" are the same fraction *today* — the charge
	 * is used because it does not depend on that staying true.
	 *
	 * **Deliberately a fraction of a stud, which is what "mild" means here.** The whole offset a player's
	 * camera already carries while shift-locked is `SHIFT_LOCK_CONFIG.CAMERA_OFFSET` = `(2, 2, 0)`, about 2.8
	 * studs, so this is a fifth of the offset the camera is sitting at — a nudge the thrower feels rather than
	 * a camera position that has moved. Raising it past about a stud stops being a shake and starts being a
	 * second camera mode.
	 */
	SHAKE_MAGNITUDE: 0.6,

	/**
	 * How much of the shake **a throw with no hold at all** gets, as a fraction of {@link SHAKE_MAGNITUDE}.
	 * **Placeholder — `0` is the ask.**
	 *
	 * **Zero, and that is pure proportionality rather than an oversight**, which is what "the shake follows the
	 * power" means taken at its word: hold the button for nothing and the camera is not touched at all.
	 *
	 * **The cost, stated so it can be judged in play rather than discovered: the ball still goes somewhere.**
	 * `CHARGE_MIN_SPEED` is a floor on the *throw* and not on anything here, so a tapped throw is a real throw
	 * a long way down the field with no kick behind it — the one case where the shake and the ball disagree
	 * about how much happened. If that reads as the feedback being broken, **this is the number to raise**
	 * rather than the magnitude above: at `0.25` a tap gets a quarter of the shake and a full hold is
	 * unchanged, which keeps the proportionality and drops the dead spot.
	 */
	SHAKE_MINIMUM_FRACTION: 0,

	/**
	 * How long the shake lasts, in seconds. **Placeholder — 0.16 is the ask.**
	 *
	 * Short on purpose, and the number that decides whether this reads as an *impulse* rather than as an
	 * effect. A throw is a single event: the ball leaves the hand once, and a camera still moving half a
	 * second later is the camera disagreeing with what just happened. It is also about ten frames at sixty a
	 * second, which is long enough for the oscillation below to complete a couple of cycles rather than
	 * looking like a single one-frame jump.
	 */
	SHAKE_SECONDS: 0.3,

	/**
	 * How fast the shake oscillates, in hertz. **Placeholder — 18 is the ask.**
	 *
	 * **What separates a jolt from a drift.** Without oscillation a decaying offset is a camera that slides
	 * away and returns, which reads as a soft push; two or three cycles of a decaying sine read as a *hit*.
	 * At `SHAKE_SECONDS` this is roughly three cycles, which is the fewest that still reads as a spring rather
	 * than as a wobble. Much higher and it is a buzz with no shape at the frame rate this runs at.
	 */
	SHAKE_FREQUENCY: 18,

	/**
	 * How much of the shake goes sideways rather than up, as a fraction of the magnitude. **Placeholder.**
	 *
	 * **The up axis carries the kick and this decides how much of a wiggle it has along the body's own left**
	 * — see `cameraShake.ts` for why those two and not three: `Humanoid.CameraOffset` is applied in the
	 * *body's* frame, so a Z component would push the camera along the thrower's own forward and read as a
	 * dolly, which is a zoom rather than a shake. Zero here is a purely vertical bob, which is legible for the
	 * first throw and mechanical by the tenth.
	 */
	SHAKE_SIDE_FRACTION: 0.35,

	// -------------------------------------------------------- the wind burst

	/**
	 * Whether the gust is built at all. **Creation switch.**
	 *
	 * Off means nothing is constructed — not built and left, and not an emitter firing into nothing, which is
	 * what `FREEZE_BURST_ENABLED` states about itself too.
	 */
	WIND_BURST_ENABLED: true,

	/**
	 * The image the gust is drawn as: **an engine built-in, so there is nothing to upload.** Verified on disk
	 * in this machine's Roblox install, `content/textures/particles/smoke_main.dds`, alongside the rest of the
	 * engine's particle set.
	 *
	 * **This is deliberately not the `rbxassetid://0` the two freeze textures use, and the difference is
	 * worth knowing.** Those are placeholders waiting on an upload: a real id has to be put there by the
	 * account this game runs on before the shards look like ice. A `rbxasset://` path is engine content that
	 * already ships with the client, so the gust looks like a gust the first time it fires — and it is not an
	 * invented id, which is the other thing this could have been.
	 *
	 * **A soft smoke puff rather than a sparkle or a shard**, because air is what this is: the effect reads as
	 * *displaced*, not as something thrown, which is the same reason the colour below is a pale grey-blue
	 * rather than a tint with a hue to it.
	 */
	WIND_BURST_TEXTURE: "rbxasset://textures/particles/smoke_main.dds",

	/**
	 * How many particles one gust fires. **Placeholder — 70, tuned up from 45 for legibility.**
	 *
	 * A shell of them around the launch point, so the count is what makes it a burst rather than a sputter.
	 * Well above the freeze burst's 40 on purpose: that one is a shatter with individual pieces worth reading,
	 * while this is one mass of air where the individual particles are not the point. Raised because the shell
	 * is a *sphere* (see {@link WIND_BURST_SPREAD_ANGLE}) rather than a cone, so the same count spread over
	 * twice the directions is half as dense where it matters.
	 */
	WIND_BURST_COUNT: 70,

	/**
	 * How long a particle lives, in seconds. **Placeholder — 0.6, up from 0.45.**
	 *
	 * **Short, and that is what makes the gust dramatic rather than lingering.** A puff of air that stays on
	 * screen stops being a gust and becomes weather. This is also the effect's entire lifetime: the anchor is
	 * destroyed a margin after it, and nothing stores the burst anywhere — so the timer in `WindBurst.ts` is
	 * `LIFETIME + 0.25` and follows this number wherever it goes.
	 *
	 * Raised with the speed below: the two together decide how far the shell gets, and at the old pair it was
	 * still contracting visibly into a fade rather than having crossed anything.
	 */
	WIND_BURST_LIFETIME: 0.6,

	/**
	 * How fast the particles leave, in studs per second. **Placeholder — 45, up from 32.**
	 *
	 * **The single number most responsible for "dramatic".** Paired with the drag below it decides how far the
	 * shell actually gets: at these two values a particle crosses roughly **fifteen studs** — about three
	 * character heights — before it fades, so the gust is still visibly travelling when it dies rather than
	 * having stopped a stud from the hand. That distance is the effect: air leaving the thrower in every
	 * direction and *reaching* something.
	 */
	WIND_BURST_SPEED: 45,

	/**
	 * How wide the cone is, in degrees, measured from the emitter's own forward. **Placeholder — 360.**
	 *
	 * **360 in both axes, which is the whole sphere — and it was 180 until this revision, which is not.**
	 * Roblox states the rule on the property itself: *"Setting one axis to 360 will cause particles to emit in
	 * all direction in a circle. Setting both to 360 will cause particles to emit in all directions in a
	 * sphere."* So the old 180 was a **hemisphere**, and because the anchor is aimed at the sky it was a
	 * **fountain arcing upward over the thrower** — half the directions, none of them downward, and nothing
	 * wrapping the body. That is the opposite of "air displaced", which is what this effect is for.
	 *
	 * **A sphere has no forward to get wrong**, which is why the anchor's aim below matters less here than the
	 * freeze burst's does; it is set anyway so the axes are up and down by decision rather than by default.
	 * The number is a `Vector2` of two identical values because the emitter takes the horizontal and vertical
	 * spreads separately and this effect has no reason to want them different.
	 */
	WIND_BURST_SPREAD_ANGLE: 360,

	/**
	 * How hard the particles are slowed, as the emitter's own `Drag`. **Placeholder — 3, down from 7.**
	 *
	 * **Read the units before tuning this one, because this comment had them wrong and the number was wrong
	 * with them.** `Drag` is a **half-life rate**, in Roblox's words *"the rate at which particles will lose
	 * half their speed through exponential decay"* — so it is not a gentle drag but a *halving* that is applied
	 * `Drag` times a second. At the old `7` the speed halved every 0.143 s, which put the whole gust's travel
	 * at about six studs and had the particles hanging almost still for the last two thirds of a life whose
	 * transparency was at its faintest — a puff that had stopped moving *and* could not be seen. Setting it to
	 * `3` gives a half-life of a third of a second, which is short enough to read as air being displaced rather
	 * than as a projectile, and long enough that the shell is still expanding when it goes.
	 *
	 * It is the partner of the speed above: that one decides how violently the gust starts, this one how
	 * quickly it gives up. Zero here would be a spray of dots that never slows; far above the speed it is a
	 * puff that never goes anywhere.
	 */
	WIND_BURST_DRAG: 3,

	/**
	 * How big a particle is over its life, as a `NumberSequence` keyed on lifetime 0 to 1. **Placeholder.**
	 *
	 * **Growing, and unlike the freeze burst's it never comes back down.** Those shards snap out to size and
	 * thin as they die, because a piece of ice that is still big at the end has not broken. Air does the
	 * opposite: a puff is small when it leaves and spreads, so this rises the whole way and the last frame is
	 * the widest — which is also what puts the gust across the whole body rather than around the hand. Values
	 * are studs.
	 *
	 * **Raised at both ends, and the start is the part that matters.** The old curve began at 0.8 studs, which
	 * at the moment the particle was at its most opaque was still under two — so the *visible* phase was a
	 * small ball near the hand and the *big* phase was the faint one. Starting at 1.6 and reaching 5.5 by 30%
	 * of the life lines the two up: solid while it grows, and still large while it fades.
	 */
	WIND_BURST_SIZE: new NumberSequence([
		new NumberSequenceKeypoint(0, 1.6),
		new NumberSequenceKeypoint(0.3, 5.5),
		new NumberSequenceKeypoint(1, 10),
	]),

	/**
	 * How see-through a particle is over its life, as a `NumberSequence` keyed on lifetime 0 to 1.
	 * **Placeholder.**
	 *
	 * **Invisible at birth, most solid immediately after, and gone at the end** — a fade *up* into the burst
	 * and a long fade out of it. The first key is there rather than starting at 0.5 because a particle that
	 * appears already solid pops, and a gust that arrives as a set of visible circles is a set of visible
	 * circles; the short ramp is what makes them read as one mass. The tail is the long half because that is
	 * the part the eye is following.
	 *
	 * **The peak is `0.15` — eighty-five per cent opaque — and it was `0.55` until this revision, which is the
	 * change this effect most needed.** A smoke texture has soft edges, so its *effective* coverage is well
	 * below whatever this number says, and the old peak of 45% was reached for about three frames before the
	 * tail settled at 20% — a white haze of a fifth opacity against a room, which is not a burst, it is a
	 * rumour of one. The freeze burst this was modelled on peaks at 70% and reads; this now peaks above it,
	 * because a gust is a *volume* of air rather than a set of readable pieces and has nothing else to be
	 * legible with.
	 */
	WIND_BURST_TRANSPARENCY: new NumberSequence([
		new NumberSequenceKeypoint(0, 1),
		new NumberSequenceKeypoint(0.1, 0.15),
		new NumberSequenceKeypoint(0.55, 0.45),
		new NumberSequenceKeypoint(1, 1),
	]),

	/**
	 * The colour the gust is tinted. **Placeholder — a cold pale blue, moved off near-white.**
	 *
	 * **Near-white was the wrong direction for the one background a smoke effect has to survive.** The old
	 * value was `(222, 232, 240)` — within a few per cent of the arena floor's own brightness whatever that
	 * floor is, which is a particle that is invisible when it is faint and unremarkable when it is not. This
	 * keeps the *cold* half of the idea — it is air, not an ability, so it must not carry a hue that reads as
	 * one — and puts real distance between the particle and a washed-out background by going *darker and
	 * bluer* than the floor is likely to be.
	 *
	 * It is paired with the emission below: at that level the particle is largely **additive**, so what this
	 * colour actually contributes is *light of this colour*, which is legible against a dark floor as a glow
	 * and against a bright one as a blue cast. Between the two, the particle has something to say on any
	 * background — which is the property the old near-white did not have on either.
	 */
	WIND_BURST_COLOR: Color3.fromRGB(205, 225, 245),

	/**
	 * How much the particles light their surroundings. **Placeholder — 0.8, up from 0.15.**
	 *
	 * **This is the second of the two numbers that make the effect visible, and the one the old value got
	 * backwards.** `LightEmission` blends the texture additively rather than normally: at 0 the particle is
	 * blended like a decal and can only ever be as bright as its colour, and at 1 it is pure additive and
	 * *adds* its light to whatever is behind it. At `0.15` this effect was almost entirely normal-blended —
	 * so a pale grey puff on a light floor was pale grey on pale grey, with nothing to separate them.
	 *
	 * 0.8 rather than 1 rather than 0.5: the freeze burst's 0.5 was argued for an ability that has to be
	 * legible from the far side of an arena, and this is at the thrower's own hand where the alternative to
	 * being seen is being reported as missing. Not quite 1, because a fully additive white *bleaches* on a
	 * bright background and a gust should still read as something with a colour.
	 */
	WIND_BURST_LIGHT_EMISSION: 0.8,

	/**
	 * What fraction of the world's gravity pulls the particles down. **Placeholder — 0.05.**
	 *
	 * **Nearly weightless, because air is.** 1 would arc the particles like the freeze shards and make the
	 * gust fall out of the sky; this is just enough to keep them from hanging perfectly still, where a shell
	 * that neither falls nor slows reads as a texture rather than as material. A scale rather than a figure in
	 * studs per second squared, for the reason `FREEZE_BURST_GRAVITY_SCALE` gives: a map that has turned the
	 * world's gravity down should take this with it.
	 */
	WIND_BURST_GRAVITY_SCALE: 0.05,
} as const;
