import { Controller, OnStart } from "@flamework/core";
import Fusion from "@rbxts/fusion-3.0";
import { ReplicatedStorage, RunService } from "@rbxts/services";
import { TRANSITION_CONFIG } from "shared/config/transition.config";
import { ROUND_STATUS_FOLDER, ROUND_TRANSITION_ATTRIBUTE } from "shared/constants";
import { getTransitionScreenGui } from "../../ui/screenGui";

/** Prints when a wipe starts and when it comes off, which is how a wipe is told from a round without one. */
const DEBUG = true;

/** The grid's container, named so a leftover can be found by name in the Explorer. */
const CONTAINER_NAME = "RoundTransitionGrid";

/**
 * The `ZIndex` of the container and of every cell in it, and the two must stay equal.
 *
 * **Roblox only draws a child above its parent when the child's `ZIndex` is at least the parent's**, so
 * equal values are what put the cells over their container; and a *higher* `ZIndex` on a container
 * paints its own background over its children, which is the trap `ShopController` documents the hard
 * way. Here the container's background is transparent, so raising it would be invisible rather than
 * destructive — which is exactly why it would go unnoticed until somebody made the container opaque.
 */
const GRID_Z_INDEX = 1;

/**
 * One cell: the frame, and when it takes its turn at each end of the transition.
 *
 * **Two delays rather than one, because the two waves do not run in the same direction.** `startDelay` is
 * when the cell grows, counted outward from the centre; `revealDelay` is when it shrinks, which is counted
 * outward from the *edges* when the reveal is the growth played backwards. Neither can be derived from the
 * other at the point of use without re-deriving which direction the reveal runs in, so both are worked out
 * once when the grid is built and the loop below only reads them.
 */
interface GridCell {
	frame: Frame;
	/** Seconds after the wipe starts before this cell begins to grow. */
	startDelay: number;
	/** Seconds after the *reveal* starts before this cell begins to shrink. */
	revealDelay: number;
}

/**
 * Where a wipe is in its three phases: covering the screen, holding it, and uncovering it.
 *
 * **One value rather than three booleans**, because the three are mutually exclusive and ordered and
 * nothing reads two of them at once. A flag per phase would allow a frame that is "holding and
 * revealing", which has no meaning. A string union rather than a number so that a stage written to the
 * log, or looked at in a debugger, reads as the phase it names.
 */
type TransitionStage = "grow" | "hold" | "reveal";

/**
 * The wipe that covers the screen when a round begins.
 *
 * **What it is masking.** A round *starts* with every client's body moved to the arena
 * (`RoundService.teleportTeamsToArena`) and *ends* with every body moved back to the lobby
 * (`teleportAll`); both are a camera cut — the world and everything the player was looking at change in one
 * server frame — and this is what is on screen at each of them. It is not a loading screen and no rule of
 * the game depends on anybody having seen it, but it is not free either: `RoundService.transitionAround`
 * holds the phase's clock still for `TRANSITION_SECONDS`, so a round neither spends its opening seconds
 * behind a cover nor starts counting before its players are standing in the arena.
 *
 * **The cover closes *around* the move, and that is a correction this went through twice.** The first
 * version played the wipe after the teleport, which is not a transition at all — a curtain drawn after the
 * cut, showing the new place and *then* covering it. The second held the round's clock for the wipe's length,
 * which was better and still the same mistake: the bodies had already been moved by the time the grid closed,
 * and at the round's end the player watched themselves arrive in the lobby and then be covered over. Both
 * were fixable only on the server's side of the wire, because the move is the server's and so is the timing:
 * `transitionAround` bumps {@link ROUND_TRANSITION_ATTRIBUTE}, waits `TRANSITION_COVER_SECONDS` for the
 * clients' grids to close — plus a step of latency, since the cue reaches them a network step after it is
 * written — moves everybody while the screen is dark, and waits `TRANSITION_OPEN_SECONDS` for it to open
 * again. **The cut is now genuinely hidden**, and the clock is held for exactly as long as the screen is not
 * the world.
 *
 * **Why the grid is in its own `ScreenGui` rather than the shared one.** `ScreenInsets` belongs to the
 * GUI, not to a frame, so a child of `HudGui` inherits its safe region and *cannot* paint the strip
 * under Roblox's topbar — the grid would leave a band of the game showing along two edges. And
 * `DisplayOrder` orders whole GUIs and wins outright over any `ZIndex` inside either tree, so one value
 * on a new GUI covers the eleven HUD controllers, the shop, the result panel and the spectator label at
 * once. See `getTransitionScreenGui` for the value and for why it sits one rung above the join splash.
 *
 * **Why the cover is shrunk away rather than taken off in one frame, and why the shrink runs backwards.**
 * The first version of this destroyed the grid the moment the hold ended, and the reversal is worth
 * recording because it was a real fault rather than a preference: an instant removal is *the same cut the
 * wipe exists to hide*, moved to the other end of the transition. The arena popped into view on a single
 * frame exactly as it popped in when the body was teleported, and the wipe therefore hid the first cut and
 * introduced a second one of its own. So the cover is now undone by the same movement that made it, cell
 * by cell, with the wave reversed — see `REVEAL_REVERSES_WAVE` — and the transition reads as one thing that
 * runs out and back rather than as a cover that arrives followed by a hole that appears.
 *
 * **Why the grid is destroyed at the end rather than hidden.** Hiding would leave 241 instances parenting
 * into `PlayerGui` between rounds, and the grid is worth nothing after it has been seen. The `ScreenGui`
 * itself stays, empty, and is reused by the next round — the same thing the join splash leaves behind.
 */
@Controller()
export class RoundTransitionController implements OnStart {
	/**
	 * The controller's own scope, for the one subscription that lives as long as the client does.
	 *
	 * **The grid is deliberately not built in this scope.** A wipe builds 241 instances and throws them
	 * away, and every one of them would stay referenced here until the client left — so each play makes
	 * its own short-lived scope instead, which is cleaned at the end. See {@link play}.
	 */
	private readonly scope = Fusion.scoped();

	/** Whether a wipe is on screen right now. Its own guard, so two can never overlap. */
	private running = false;

	public onStart(): void {
		// Spawned rather than done inline, on every other HUD controller's argument: mounting waits for
		// the round folder, which the *server* creates, and a controller's `onStart` is the wrong place to
		// hold up the rest of the client's boot.
		task.spawn(() => this.mount());
	}

	private mount(): void {
		const status = ReplicatedStorage.WaitForChild(ROUND_STATUS_FOLDER);

		/**
		 * The transition counter as last seen, which is what makes this an *edge* rather than a state.
		 *
		 * **The seed fires nothing, and that is the rule a mid-round mount turns on.** A client that boots into
		 * a round that is already under way has missed the transition this would have covered and has been
		 * looking at the arena since its first frame — a wipe for it would be a cover over a world the player
		 * has already seen. Seeding from the value the server has already published means "was this client here
		 * for that transition" is answered by the server's own count rather than by a guess about time.
		 * `MusicController` seeds its phase for the same reason and says so the same way.
		 *
		 * **And the counter is why this file no longer watches the phase at all.** The phase is published early
		 * on purpose — an intermission announces itself before the lobby has been looked up, because a phase
		 * that is held must not read as the previous one — while the move happens later, once that is resolved.
		 * A wipe keyed on the phase would therefore play and finish inside that gap and cover nothing, which is
		 * exactly what happened: at the round's end the player saw the lobby and *then* a curtain over it. See
		 * `ROUND_TRANSITION_ATTRIBUTE`.
		 */
		const initial = status.GetAttribute(ROUND_TRANSITION_ATTRIBUTE);
		let last = typeIs(initial, "number") ? initial : 0;

		// Subscribed after the seed, so the seed cannot be clobbered by a change that landed mid-mount —
		// and the handler re-reads the attribute rather than trusting the signal, which carries no value.
		this.scope.push(
			status.GetAttributeChangedSignal(ROUND_TRANSITION_ATTRIBUTE).Connect(() => {
				const value = status.GetAttribute(ROUND_TRANSITION_ATTRIBUTE);
				if (!typeIs(value, "number")) return;

				// **Any change is a transition**, because the count only moves forward and only the server
				// writes it — so there is no phase to name, no direction to work out, and no way for two
				// successive transitions to look alike.
				if (value === last) return;

				last = value;
				this.play();
			}),
		);

		if (DEBUG) print(`[Transition] watching ${ROUND_TRANSITION_ATTRIBUTE} — mounted at ${last}`);
	}

	/**
	 * Plays one wipe: build the grid, grow it in a wave from the centre, hold the cover, and shrink it away
	 * again in reverse.
	 *
	 * **The movement is a `RenderStepped` loop rather than a `TweenService` tween**, and that is the
	 * codebase's answer rather than a preference — there is no `TweenService` anywhere in `src`, and the
	 * thing it is used for elsewhere is a *reading of a clock* written per frame
	 * (`CooldownHudController`'s bar fills), which is exactly what this is. **One loop for the whole
	 * grid**: every cell shares one `GROW_SECONDS` and one `REVEAL_SECONDS`, so the only thing that differs
	 * between them is *when* they take their turn, and 240 separate tween objects would be 240 things to
	 * keep in step with two numbers.
	 *
	 * **Both waves are delays and neither is a speed.** A cell's delay is its distance from a point in
	 * *cells*, so a cell by the middle and a cell in the corner move identically and only their starts
	 * differ — the alternative, cells moving at different rates, reads as the grid wobbling rather than as
	 * a sweep. The two waves then differ only in which point they measure from, which is what
	 * `REVEAL_REVERSES_WAVE` decides.
	 */
	private play(): void {
		if (!TRANSITION_CONFIG.ENABLED) return;

		// A round cannot start twice inside one wipe, so this is unteachable in practice and kept anyway:
		// it is the difference between "impossible" and "unobserved", and it costs one comparison.
		if (this.running) return;

		this.running = true;

		const rows = math.max(1, TRANSITION_CONFIG.ROWS);
		const cols = math.max(1, TRANSITION_CONFIG.COLS);

		// One cell's worth of the screen, which is also its full size — the grid has no gaps and no
		// padding, so `cols` of these tile 1.0 exactly. See the cell loop below for why the cells are placed
		// by hand rather than by a `UIGridLayout`.
		const cellX = 1 / cols;
		const cellY = 1 / rows;

		// The centre in cell coordinates, and the origin of the wave. Not `cols / 2`: the cells are indexed
		// from zero, so the centre of a 20-wide grid sits between cell 9 and cell 10, at 9.5.
		const centreCol = (cols - 1) / 2;
		const centreRow = (rows - 1) / 2;

		// **The farthest a cell can be from the centre, which is the whole of the revealed wave's clock.**
		// Distances are measured from the centre in cells, and a cell's distance is at most the corner's —
		// `centreCol` across and `centreRow` down, whichever way the grid's size rounds. Subtracting a
		// cell's distance from this turns the outward wave into an inward one: the corners get nothing and
		// the centre gets the whole spread, which is the growth played backwards.
		const maxDistance = math.sqrt(centreCol * centreCol + centreRow * centreRow);

		// A throwaway scope per play, cleaned at the end — every instance this builds is inserted into it.
		const grid = Fusion.scoped();
		const gui = getTransitionScreenGui();

		const container = Fusion.New(grid, "Frame")({
			Name: CONTAINER_NAME,
			Parent: gui,
			Size: UDim2.fromScale(1, 1),
			BackgroundTransparency: 1,
			BorderSizePixel: 0,
			ZIndex: GRID_Z_INDEX,
			// **No input, on the loading screen's rule.** A cover that ate a click would silently break the
			// throw for as long as it was up, and there is nothing here to click. `Modal` is not touched on
			// purpose: its default is off, and a full-screen GUI that set it would lock the player's mouse
			// to itself.
			Active: false,
			Selectable: false,
		});

		const cells = new Array<GridCell>();

		for (let row = 0; row < rows; row++) {
			for (let col = 0; col < cols; col++) {
				const dx = col - centreCol;
				const dy = row - centreRow;

				// **Distance in cells, not in pixels.** The delay is the same number of cells away in both
				// directions, so the wave is a circle on the screen only because the cells are not square —
				// which is what `ROWS`/`COLS` being different buys: an ellipse that matches the screen's
				// shape, reaching all four edges at once.
				const distance = math.sqrt(dx * dx + dy * dy);
				const startDelay = distance * TRANSITION_CONFIG.DELAY_PER_CELL;

				// **The reveal's delay, measured the other way round.** Distance from the *centre* is what
				// puts a cell early in the growth; distance from the *edges* is what puts it early in the
				// reveal, and subtracting from the far corner's distance is the same statement — a cell at
				// the corner is `0` away from the edge and starts shrinking at once, and a cell at the
				// centre waits the whole spread. Both numbers are worked out here, once, so the loop below
				// has no direction in it to get wrong.
				const revealDelay = TRANSITION_CONFIG.REVEAL_REVERSES_WAVE
					? (maxDistance - distance) * TRANSITION_CONFIG.DELAY_PER_CELL
					: distance * TRANSITION_CONFIG.DELAY_PER_CELL;

				const cell = Fusion.New(grid, "Frame")({
					Name: `Cell${row}-${col}`,
					Parent: container,
					// **Placed by hand rather than by a `UIGridLayout`.** A layout's job is to write its
					// children's `Position`, so a cell told to sit at its own cell's centre would have that
					// overwritten — and whether a layout then accounts for a child's `AnchorPoint` is not
					// stated in the typings, so "grows from its own centre" would rest on an engine behaviour
					// nothing here can check. This is one division per axis and it is exact at any aspect
					// ratio: the cell's centre is `(col + 0.5) / cols` across, and its size is `1 / cols`, so
					// the cells tile the screen with no gaps by construction. The one place the project's
					// "grids over `UIGridLayout`" rule is deliberately not followed, because there is no
					// padding here for a layout to keep in step with the size.
					Position: UDim2.fromScale((col + 0.5) / cols, (row + 0.5) / rows),
					AnchorPoint: new Vector2(0.5, 0.5),
					// Nothing at rest: the loop below is the only thing that ever sizes a cell.
					Size: UDim2.fromScale(0, 0),
					BackgroundColor3: TRANSITION_CONFIG.COLOR,
					BorderSizePixel: 0,
					ZIndex: GRID_Z_INDEX,
					Active: false,
					Selectable: false,
				});

				cells.push({ frame: cell, startDelay, revealDelay });
			}
		}

		let elapsed = 0;
		let held = 0;
		let revealElapsed = 0;
		let stage: TransitionStage = "grow";

		// **`RenderStepped` rather than `Heartbeat`**, and not for `CooldownHudController`'s reason (that
		// one reads a clock, so its only cost is how smoothly it is sampled). This one *writes* the frame
		// that is about to be drawn, so running before the draw is the point: a heartbeat would land after
		// the frame it describes and the movement would lag the camera by one frame for its whole life.
		const connection = RunService.RenderStepped.Connect((delta) => {
			if (stage === "grow") {
				elapsed += delta;

				let settled = true;

				for (const cell of cells) {
					const progress = math.clamp(
						(elapsed - cell.startDelay) / TRANSITION_CONFIG.GROW_SECONDS,
						0,
						1,
					);

					// A cell whose delay has not passed is left exactly as it was built. That is most of the
					// grid for most of the wave, and skipping it is what keeps the per-frame cost to the cells
					// actually moving rather than to all 240.
					if (progress <= 0) {
						settled = false;
						continue;
					}

					if (progress < 1) settled = false;

					cell.frame.Size = UDim2.fromScale(cellX * progress, cellY * progress);
				}

				if (!settled) return;

				stage = "hold";

				if (DEBUG) print(`[Transition] covered — ${elapsed}s`);

				return;
			}

			if (stage === "hold") {
				// The hold: the screen is covered and the arena behind it is settling. See
				// `TRANSITION_CONFIG.HOLD_SECONDS` for why this is not simply the moment the last cell lands.
				held += delta;
				if (held < TRANSITION_CONFIG.HOLD_SECONDS) return;

				stage = "reveal";

				if (DEBUG) print(`[Transition] revealing — ${elapsed + held}s`);

				return;
			}

			// The reveal: the same movement as the growth, with the wave running the other way.
			revealElapsed += delta;

			let settled = true;

			for (const cell of cells) {
				const progress = math.clamp(
					(revealElapsed - cell.revealDelay) / TRANSITION_CONFIG.REVEAL_SECONDS,
					0,
					1,
				);

				// **A cell that has not had its turn yet is left exactly as it is — at full size, still
				// covering.** That is the mirror of the growth's skip, and it is what makes the reveal read
				// as openings appearing rather than as the whole grid fading at once.
				if (progress <= 0) {
					settled = false;
					continue;
				}

				if (progress < 1) settled = false;

				// `progress` runs `0 → 1` across the shrink and the cell is drawn at what is *left*, so the
				// last size written for a finished cell is exactly zero — and a frame with no area draws
				// nothing, which is what makes the edge of the cover the edge of the cells still standing
				// rather than a rectangle with gaps appearing between them.
				const remaining = 1 - progress;
				cell.frame.Size = UDim2.fromScale(cellX * remaining, cellY * remaining);
			}

			if (!settled) return;

			// **Everything goes on the frame *after* the last cell reached zero**, so the very last frame of
			// the reveal draws an empty grid rather than a grid that is about to be destroyed. Disconnecting
			// first, so a frame landing between the two cannot write a `Size` to a destroyed cell. `Destroy`
			// on the container takes all 240 cells with it — they are its children — and `doCleanup` then
			// drops the scope's own references to the same instances, which is what keeps a round's worth of
			// frames from being held until the client leaves.
			connection.Disconnect();
			container.Destroy();
			Fusion.doCleanup(grid);

			this.running = false;

			if (DEBUG) print(`[Transition] revealed — ${elapsed + held + revealElapsed}s`);
		});
	}
}
