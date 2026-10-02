/**
 * The round wipe: a grid of rectangles that covers the screen when a round begins, and again when it ends,
 * coming off a moment later each time.
 *
 * **Read by both halves of one fact**, which is why it is here rather than inside either of them:
 * `client/controllers/hud/RoundTransitionController.ts` plays the animation from it, and `RoundService`
 * holds the round's clock for `TRANSITION_SECONDS` so that the animation costs the round no time. The
 * density of the grid, the speed of the wave and the colour of the cover are the game's *look* — the
 * numbers a player would ask to have changed — and the one duration they add up to is the game's
 * *timing*, which is the server's business. One file, because separating them is how the animation and
 * the clock drift apart.
 *
 * **What the wipe is for.** Twice per round, every client's body is moved in a single server frame: to
 * the arena when the round opens (`teleportTeamsToArena`), and back to the lobby when it closes
 * (`teleportAll`). A camera that moves like that reads as a cut — the world and everything the player was
 * looking at change at once — and this is the thing that is on screen instead.
 *
 * **What it is not.** It is not a loading screen: there is nothing to *wait for* — the arena is already in
 * the world before anybody is moved onto it — and no rule of the game depends on anybody having seen the
 * wipe. What it does cost is time, and both of the round's clocks are held for exactly its length so that
 * it costs the round none of it — and the server is what *sequences* the transition, running the move
 * inside it, which is the one thing the client cannot do for itself. See `TRANSITION_SECONDS` for the
 * durations, and `RoundService.transitionAround` for the order they are waited in.
 */
export const TRANSITION_CONFIG = {
	/**
	 * Whether the wipe plays at all. **Placeholder — on.**
	 *
	 * **Off means the controller never builds anything**, rather than building a grid and hiding it:
	 * nothing is created, nothing is scheduled, and no frame is spent on it. That is the reading
	 * `BALL_CONFIG.TRAIL_ENABLED` gets, and for the same reason — a switch that leaves all the work in
	 * place and only hides the result is a switch that cannot be used to rule the feature out.
	 */
	ENABLED: true,

	/**
	 * Whether a wipe also plays at the *end* of a round, on the way into the intermission.
	 * **Placeholder — on, because the round end is the same event as the round start.**
	 *
	 * **Both boundaries move every body in the world**, and that is the whole of the argument: a round
	 * begins with everyone teleported from the lobby to the arena, and it ends with everyone teleported
	 * back (`RoundService.teleportAll`). Two cuts, one shape of cover, so there is one controller and two
	 * edges rather than a second effect for the return trip.
	 *
	 * **This flag is read by the server and not by the client**, which is the one place where it *is* the
	 * server's business: it is handed to `RoundService.transitionAround`, and with it off that boundary does
	 * no covering and no waiting at all. The client wipes whenever the server says a transition has begun and
	 * has no opinion about which boundary it is, so the two cannot disagree about what is covered.
	 *
	 * **Off means the round's end is a bare teleport again** — a lobby arriving in one frame, and an
	 * intermission whose clock starts moving immediately. That is the honest way to switch one end off. What
	 * it is not is a way to keep the cover and drop the hold: the hold is what makes the cover worth having.
	 */
	WIPE_AT_ROUND_END: true,

	/**
	 * How many rows and columns the grid has. **Placeholder — 12 × 20.**
	 *
	 * **The pair that multiplies everything else.** Every cell is a `Frame` that is rewritten once per
	 * frame while it grows, so the grid costs `ROWS × COLS` property writes a frame at the peak of the
	 * wave — 240 here, which is nothing for one round every minute or so, and would not be nothing at
	 * three times this. Density is also how the effect *reads*: cells much smaller than a tenth of the
	 * screen stop reading as cells and start reading as a texture, which is the direction to move in if
	 * the wave ever looks too busy.
	 *
	 * **Not the same number on both axes, deliberately.** A screen is wider than it is tall, so equal
	 * counts give cells visibly taller than they are wide — and the wave then reaches the top and bottom
	 * edges before its own corners are half way across.
	 */
	ROWS: 12,
	COLS: 20,

	/**
	 * How long one cell takes to grow from nothing to its full cell, in seconds. **Placeholder — 5.**
	 *
	 * **Every cell takes exactly this long**, and that is what makes the wave a stagger of *starts*
	 * rather than a stagger of speeds: a cell by the centre and a cell in the corner grow identically,
	 * and the only thing that differs between them is when they begin. Cells growing at different rates
	 * is the version that reads as the grid wobbling rather than as a sweep.
	 */
	GROW_SECONDS: 0.5,

	/**
	 * How much later a cell starts than one that is a single cell closer to the centre, in seconds.
	 * **Placeholder — 0.015.**
	 *
	 * **The wave's speed, and it is measured in cells rather than as a total spread**, which is the thing
	 * to understand before tuning it: a cell's delay is its *distance from the centre in cells*
	 * multiplied by this. On a 12 × 20 grid the centre is at (9.5, 5.5) and the far corner is 10.98 cells
	 * away, so the last cell starts 0.165s after the first and the screen is fully covered at
	 * 0.165 + `GROW_SECONDS`.
	 *
	 * **Those two are added, so the wave only reads as a wave while this is large enough next to
	 * `GROW_SECONDS`.** At a 0.4s growth the screen closes in 0.565s and the stagger is most of what is
	 * happening; at a 5s growth every cell is still halfway through growing when the wave has finished
	 * crossing, so the grid reads as one expanding mass rather than as a sweep. Lengthening the growth
	 * means lengthening this with it.
	 *
	 * **The consequence worth knowing:** changing `ROWS`/`COLS` changes the length of the wave, because
	 * the same distance *in cells* is a different distance *across the screen*. Raise the counts and the
	 * wave takes longer unless this comes down with them.
	 */
	DELAY_PER_CELL: 0.015,

	/**
	 * How long the screen stays covered after the last cell has finished, in seconds. **Placeholder — 0.3.**
	 *
	 * **The hold is the whole of why the arena looks finished when the cover comes off.** The teleport
	 * lands before the cover is up — see the controller's note on ordering — so the world behind the grid
	 * is already the arena, but the client has had it for a fraction of a second and its map, its sky and
	 * its other players are still arriving. Holding is what lets all of that settle while nobody can see
	 * it, so the reveal shows a *place* rather than a place assembling itself.
	 */
	HOLD_SECONDS: 2,

	/**
	 * How long one cell takes to shrink from its full cell back to nothing, in seconds.
	 * **Placeholder — 0.4, the same as the growth.**
	 *
	 * **The reverse of the wipe, and it is the same number because it is the same movement.** A cell grows
	 * from `0` to one cell over `GROW_SECONDS` and shrinks from one cell back to `0` over this, so setting
	 * them equal makes the second half of the transition the first half run backwards — which is what it
	 * is. It is a separate number rather than a reuse of `GROW_SECONDS` because the two halves are allowed
	 * to want different pacings: a cover that closes slowly and opens quickly is a common shape, and there
	 * is no reason to make that a change to both halves at once.
	 */
	REVEAL_SECONDS: 0.5,

	/**
	 * Which end of the grid the reveal starts from. **Placeholder — on, which is the true reverse.**
	 *
	 * **On means the grid is uncovered in the reverse of the order it was covered in**: the corners — the
	 * cells that finished last — are the first to shrink, and the centre is the last thing to go, so the
	 * whole transition reads as one movement that runs out and back. **Off is the other reading of the same
	 * idea**, the middle opening first like an iris, which is a different effect: that one looks like a hole
	 * being made rather than like something being taken away.
	 *
	 * Either way a cell's delay is `DELAY_PER_CELL` per cell of distance; only the direction of the
	 * arithmetic flips. If it is not obvious which is wanted on screen, this is the one line to flip.
	 */
	REVEAL_REVERSES_WAVE: true,

	/**
	 * How long the server waits *past* the moment its own cover countdown ends before it moves anybody, in
	 * seconds. **Placeholder — 0.2.**
	 *
	 * **Not part of the look, and the one number here that exists because two machines are involved.** The
	 * server starts its countdown the instant it bumps the transition counter, but the client does not begin
	 * its wipe until that write has replicated — a network step the server cannot measure from where it is.
	 * Without this, the move lands a step *early*, while the grid is still opening, and the cut shows through
	 * exactly the way it did before any of this existed. With it, the move happens after the client's own
	 * cover has closed, inside the hold, where nothing can be seen.
	 *
	 * **It is a guess at a latency, so it should be generous rather than tight.** It costs only time under a
	 * cover nobody is counting — the hold absorbs it — whereas being short by one step costs the whole
	 * effect. Raise it if a Studio run still shows a flash of the old place before the grid closes.
	 */
	LATENCY_GRACE_SECONDS: 0.2,

	/**
	 * The colour of the cover. **Placeholder — a near-black navy.**
	 *
	 * **Dark rather than white, and the reason is not taste.** A full-screen white is a *flash*, and this
	 * project already spends white on exactly one event — the Freeze activation flare on a ball
	 * (`super.config.ts`, `FREEZE_FLASH_COLOR`). Two unrelated things that look the same are one thing
	 * with two meanings, so the round boundary takes the other end of the range. A dark cover also hides
	 * whatever is behind it more completely than a bright one, which is the whole job here.
	 */
	COLOR: Color3.fromRGB(12, 16, 28),
} as const;

/**
 * How long one wave takes to cross the grid — the spread between the first cell's start and the last one's.
 *
 * **The same arithmetic the controller does per cell, worked once for the whole grid**: the far corner is
 * `maxDistance` cells from the centre and every cell of distance is `DELAY_PER_CELL` of delay. It is a
 * function rather than a value because it depends on `ROWS` and `COLS`, which are read here rather than
 * copied. **It is declared above the constant that calls it**, which is the order roblox-ts needs and the
 * order that is easy to get backwards: a module-level initializer that runs before the function body is
 * assigned calls `nil`, and the throw happens while the module is being required.
 */
function waveSeconds(): number {
	const centreCol = (TRANSITION_CONFIG.COLS - 1) / 2;
	const centreRow = (TRANSITION_CONFIG.ROWS - 1) / 2;

	return math.sqrt(centreCol * centreCol + centreRow * centreRow) * TRANSITION_CONFIG.DELAY_PER_CELL;
}

/**
 * How long the server waits before it may move anybody: the time the clients' grid takes to close, plus
 * {@link TRANSITION_CONFIG.LATENCY_GRACE_SECONDS} for the write that starts it to arrive.
 *
 * **The two halves exist because the move has to happen *inside* the cover**, and that is the correction
 * the wipe needed: covering the screen after the teleport is not a transition at all, it is a curtain drawn
 * after the cut. So the server announces the transition, waits out this half — by which point every client's
 * grid is closed — and only then moves the bodies, with `TRANSITION_OPEN_SECONDS` of covered screen left to
 * open again afterwards.
 */
export const TRANSITION_COVER_SECONDS =
	TRANSITION_CONFIG.GROW_SECONDS + waveSeconds() + TRANSITION_CONFIG.LATENCY_GRACE_SECONDS;

/**
 * How long the server waits after the move before the phase's clock may move: the hold, the reveal, and the
 * wave crossing the grid a second time.
 *
 * Measured from the move rather than from the start, because that is what the client's own timeline does —
 * its reveal begins `HOLD_SECONDS` after its grid closes, and its grid closes when the move lands.
 */
export const TRANSITION_OPEN_SECONDS =
	TRANSITION_CONFIG.HOLD_SECONDS + TRANSITION_CONFIG.REVEAL_SECONDS + waveSeconds();

/**
 * How long one whole transition lasts, in seconds — **and the number `RoundService` holds the phase clock
 * still for.**
 *
 * **One number with two consumers, which is the whole reason it is here rather than inside the client.**
 * The wipe is a client animation and the round's clock belongs to the server, so the only way the clock can
 * stand still for exactly as long as the cover is up — no longer, and no shorter — is for both to be
 * measured from the same value. A server holding a duration of its own would drift from the animation the
 * first time anybody changed `GROW_SECONDS`, and the symptom would be a clock that either starts ticking
 * behind a cover or sits still after the cover has gone; neither points at this file.
 *
 * It is the two halves summed rather than a third duration to keep in step — the cover and the opening —
 * because those are what the server actually waits for, and a total that is written down
 * separately is a total that can disagree with them. See `TRANSITION_COVER_SECONDS` for why there are two.
 */
export const TRANSITION_SECONDS = TRANSITION_COVER_SECONDS + TRANSITION_OPEN_SECONDS;
