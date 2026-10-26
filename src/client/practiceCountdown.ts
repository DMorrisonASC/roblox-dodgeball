import { CollectionService, RunService, Workspace } from "@rbxts/services";
import { NEXT_THROW_AT_ATTRIBUTE, PRACTICE_THROW_TAG } from "shared/constants";
import { styleSplashText } from "./ui/actionSplash";

/**
 * Prints each rig it starts drawing for. Off for frame time, for the reason every other client module gives.
 */
const DEBUG = false; // off for frame time — see shared/config/debug.config.ts

/** What the countdown's `BillboardGui` is called, and how a stray one is found. */
const BOARD_NAME = "PracticeCountdown";

/**
 * **How far ahead of a throw the digits appear, in seconds — 3, so the countdown reads `3 2 1`.**
 *
 * **A render window rather than a fact about the rig.** The server publishes the instant the next ball is expected
 * and nothing else; *when to start drawing a number* is a question about a person reading a screen, and it is
 * answered here so that the behaviour's own config does not have to carry a client's opinion. Three seconds is the
 * longest countdown a person counts without losing their place, and it is short enough that a `3` appearing means a
 * throw rather than a mood.
 *
 * **Placeholder.**
 */
const MAX_COUNTDOWN_SECONDS = 3;

/**
 * **How far above the rig's head the digits sit, in studs — 4.**
 *
 * Above a humanoid's head rather than on it: the rig's own animation, its `Highlight` and its name all already
 * occupy that space, and a number painted over a body is a number nobody reads. Four studs clears an R15 head with a
 * little air, in the same spirit as `catchPrompt`'s offset over a ball.
 *
 * **Placeholder.**
 */
const COUNTDOWN_OFFSET_STUDS = 4;

/**
 * The digits' box, **in pixels**, which is the difference between a `BillboardGui` and a part.
 *
 * Wide enough for one digit at the size the style gives it and no wider, because `BillboardGui.Size` is offset on
 * both axes unless told otherwise and a narrow box is what keeps the number centred over the rig's head rather than
 * over its shadow.
 */
const BOARD_WIDTH = 60;
const BOARD_HEIGHT = 60;

/**
 * The outline's weight in pixels, in `catchPrompt`'s own figure and for its reason: an outline is a proportion of the
 * word rather than a distance, so a number drawn at this size and the prompt drawn at its size want the same weight.
 */
const COUNTDOWN_STROKE_THICKNESS = 2;

/** One rig the countdown is drawing for: the box it built, and the part the box hangs off. */
interface Row {
	readonly board: BillboardGui;
	readonly label: TextLabel;
	readonly anchor: BasePart;
}

/**
 * **A `3 2 1` countdown over every drill rig, driven by the deadline the server publishes.**
 *
 * ## What it reads, and why that is the shape it is
 *
 * One attribute: `NEXT_THROW_AT_ATTRIBUTE`, an **instant** in `Workspace.GetServerTimeNow()` on a rig that is
 * armed, and absent on one that is not. The whole of this module is the subtraction `at - GetServerTimeNow()`,
 * rounded up. That is deliberate rather than lazy: an instant survives the wire, and a duration does not — a
 * message saying "three seconds" is already wrong by the time it renders, by an amount this machine cannot measure.
 *
 * **A second telegraph rather than a replacement for the charge.** `CHARGING_ATTRIBUTE` is drawn by
 * `client/chargeEffect.ts` on the rig's *hand*, and it covers the hold — the last half second or so. This covers the
 * whole cycle, which is mostly a wait. A person watching a drill sees a number counting down, then a hand lighting
 * up, then a ball.
 *
 * ## Why the frame loop, and why the tag is the thing it watches
 *
 * **The digits roll once a second inside a window that does not change size, so there is no edge to observe.** The
 * only signal an attribute offers is "the deadline moved", which happens three times a cycle and says nothing about
 * `3` becoming `2`. `chargeEffect`'s fireball made the same call for the same reason — a threshold inside a hold is
 * not an event — so this is a `Heartbeat` with one subtraction per visible rig.
 *
 * **What makes that affordable is the tag it subscribes to.** A `practiceThrow` rig is the only body in the game
 * this draws over, so `PRACTICE_THROW_TAG`'s two signals are the whole of the bookkeeping and the loop walks only
 * the rigs in its own map. **An ordinary rig — including one wearing `Behavior_AlwaysThrowing`, which throws with no
 * bay and no countdown — is never walked and never read.** Gating on `NPC_TAG` instead would have walked every rig
 * in the game to discover that all but three of them have no attribute.
 *
 * ## Every rig, and not the ones near you
 *
 * There is no distance filter, and that is a decision. A countdown is a telegraph of the *rig's own clock*: it is
 * true whether or not this client is close enough to care, and a rig whose number appeared and disappeared as you
 * walked would be a rig whose cycle seemed to change when it had not. The cost is a handful of `BillboardGui`s and
 * one subtraction each per frame on a floor a person can see all of at once.
 *
 * ## What it is not
 *
 * **It never writes anything.** No attribute, no remote, no request. The digits are a reading of a published fact,
 * and the moment this module needed to tell the server something it would be a mechanic rather than a display.
 *
 * **It does not decide when a rig throws.** It draws a window and hides itself outside it; the drill's own pace, its
 * gate and its hold are `PracticeThrowBehavior`'s and this cannot reach them.
 */
export function startPracticeCountdown(): void {
	// Said at boot, for `hitVfx`'s and `catchPrompt`'s reason: a module with a subscription and no controller around
	// it is started by hand from `main.client.ts`, and a countdown that never appears prints the same nothing as one
	// that was never wired.
	if (DEBUG) print(`[HUD] practice countdown up — ${MAX_COUNTDOWN_SECONDS}s of digits over a ${PRACTICE_THROW_TAG} rig`);

	/** Every rig this module is drawing for, by rig. See {@link Row}. */
	const rows = new Map<Model, Row>();

	/**
	 * **The rigs being watched, and the one connection each of them needs** — the ancestry cleanup.
	 *
	 * `rows` cannot answer this: it only holds rigs that have *something to draw*, and a drill with nobody in its bay
	 * is watched and has no box. Without this set, `watch` would re-subscribe every rig it saw twice and a rig that
	 * armed later would carry two cleanup connections.
	 */
	const watched = new Map<Model, RBXScriptConnection>();

	/**
	 * The part a rig's box hangs off: **the head if there is one, the root otherwise.**
	 *
	 * Resolved rather than assumed because a rig is not guaranteed to be an R15 with a `Head` — the templates are
	 * whatever a person saved — and a `BillboardGui` with no `Adornee` draws nowhere at all, which is a countdown
	 * that silently does not exist rather than one that is in the wrong place. `undefined` is the state of a rig
	 * mid-spawn, and the caller retries on the next frame rather than building a box it cannot place.
	 */
	const anchorOf = (rig: Model): BasePart | undefined => {
		for (const name of ["Head", "HumanoidRootPart"]) {
			const part = rig.FindFirstChild(name);
			if (part !== undefined && part.IsA("BasePart")) return part;
		}

		return undefined;
	};

	/**
	 * Hides every number on screen, and is called on the way out.
	 *
	 * **A `Destroy` rather than an `Enabled = false`**, because this is the path where the rig stops being a drill:
	 * the tag is gone, or the body left the world, and nothing is going to arm it again under this module's watch. The
	 * show/hide path below reuses its box for the opposite reason — a countdown toggles every cycle, and rebuilding a
	 * `BillboardGui` five times a minute is work for nothing.
	 */
	/**
	 * **Drops a rig entirely**: its box, its registry row and its cleanup connection.
	 *
	 * Two callers, and they are the two ways a rig stops being a drill — its tag was taken off, or it left the world.
	 * **The connection is disconnected here rather than in the handler that called this**, because a handler that
	 * disconnects itself is a handler somebody has to remember is doing double duty.
	 */
	const forget = (rig: Model): void => {
		const connection = watched.get(rig);
		if (connection === undefined) return;

		watched.delete(rig);
		connection.Disconnect();

		const row = rows.get(rig);
		if (row === undefined) return;

		rows.delete(rig);
		row.board.Destroy();
	};

	/** Builds one rig's box on first use. */
	const build = (anchor: BasePart): Row => {
		const board = new Instance("BillboardGui");
		board.Name = BOARD_NAME;
		board.Adornee = anchor;
		// Over the world rather than behind a wall: a number hidden by a rig's own cover is a telegraph nobody
		// receives, and the drill it describes is right there.
		board.AlwaysOnTop = true;
		// Not lit by the arena, for `catchPrompt`'s reason: this is UI, and the one thing it must never do is become
		// unreadable in a dark corner.
		board.LightInfluence = 0;
		board.Size = UDim2.fromOffset(BOARD_WIDTH, BOARD_HEIGHT);
		board.StudsOffsetWorldSpace = new Vector3(0, COUNTDOWN_OFFSET_STUDS, 0);
		// Hidden until a frame says otherwise, so a box built on the frame a rig arms does not flash an empty label.
		board.Enabled = false;

		const label = new Instance("TextLabel");
		label.Name = "Digit";
		label.Size = UDim2.fromScale(1, 1);
		// Font, colour, `TextScaled`, the two alignments, the transparent background and the stroke all come from
		// here — the same call `catchPrompt` makes, which is the whole point of it being a shared style: a palette
		// change is one file rather than a search for every label that copied it. The stroke's weight is a proportion
		// of the word, so it is the one thing each caller states.
		styleSplashText(label, { strokeThickness: COUNTDOWN_STROKE_THICKNESS });

		label.Parent = board;
		// **Parented to the part it adorns** rather than to `PlayerGui`, which is `catchPrompt`'s arrangement and the
		// same half of the cleanup: a child of the head is taken with the head when the rig is destroyed, so a rig
		// torn down without an `AncestryChanged` this module hears still leaves nothing behind.
		board.Parent = anchor;

		return { board, label, anchor };
	};

	/**
	 * **The whole of the drawing decision, for one rig, on one frame** — and the only place a box is shown or hidden.
	 *
	 * Every trigger ends here: the tag arriving, a frame passing, and the anchor being replaced. There is deliberately
	 * no second path that hides a number, which is what makes "the digits went away" and "the attribute was cleared"
	 * the same sentence.
	 */
	const draw = (rig: Model): void => {
		const value = rig.GetAttribute(NEXT_THROW_AT_ATTRIBUTE);
		const existing = rows.get(rig);

		// **Absent means not armed**, which is the ordinary state of a bay between visitors and the state a rig enters
		// the moment its player walks out. `typeIs` rather than a truthiness test because a replicated attribute can
		// arrive as any type, and `0` would be a real instant that has already passed rather than "nothing".
		if (!typeIs(value, "number")) {
			if (existing !== undefined) existing.board.Enabled = false;

			return;
		}

		// **The one subtraction.** `GetServerTimeNow` is the only clock both machines share — `os.clock` is per-machine
		// and `os.time` is whole seconds, and a countdown rounded to the second would spend most of its life a second
		// out. Read once per rig per frame rather than hoisted, because the figure is the same for all of them and
		// hoisting would be a second way to ask the clock inside one frame.
		const remaining = value - Workspace.GetServerTimeNow();

		// **`ceil`, so the digits read `3 2 1` rather than `2 1 0`.** A deadline 2.7 seconds away rounds up to `3`,
		// which is the number a person would say; the last fraction of a second is `1` and then the box goes, on the
		// same frame the server is releasing the throw.
		//
		// **Outside the window, or past the deadline, there is nothing to say** — the first because the wait is too long
		// to count (see `MAX_COUNTDOWN_SECONDS`), the second because the ball has already gone and the server clears the
		// attribute on the release anyway. Both are a hide rather than a clamp: a `0` that lingered would be a
		// countdown to nothing, which is worse than no countdown.
		const digit = math.ceil(remaining);
		if (remaining <= 0 || digit > MAX_COUNTDOWN_SECONDS) {
			if (existing !== undefined) existing.board.Enabled = false;

			return;
		}

		// **Built on the first frame that has something to show**, which is the frame a rig arms — so a drill with
		// nobody in its bay never builds a box at all. The anchor can also be gone: a rig that respawned is a new
		// model, but a rig whose `Head` was replaced mid-life is the same model with a dead `Adornee`, so the row is
		// rebuilt when its anchor is no longer in the world.
		const row =
			existing !== undefined && existing.anchor.IsDescendantOf(Workspace)
				? existing
				: ((): Row | undefined => {
						const anchor = anchorOf(rig);
						if (anchor === undefined) return undefined;

						if (existing !== undefined) existing.board.Destroy();

						const built = build(anchor);
						rows.set(rig, built);

						return built;
					})();

		if (row === undefined) return;

		row.label.Text = tostring(digit);
		row.board.Enabled = true;
	};

	/** Starts drawing for one rig, and answers for it immediately. */
	const watch = (instance: Instance): void => {
		if (!instance.IsA("Model")) return;
		if (watched.has(instance)) return;

		// **One connection per rig, and it is the destruction path.** A rig that is destroyed, taken back out of the
		// world or parked in `ServerStorage` leaves through here; a rig whose *tag* is taken off leaves through the
		// removal signal below. Both are needed: `NpcService` re-heaps tags on a rebuilt body, and the tag coming off is
		// a fact only `CollectionService` knows.
		watched.set(
			instance,
			instance.AncestryChanged.Connect(() => {
				if (instance.IsDescendantOf(Workspace)) return;

				forget(instance);
			}),
		);

		draw(instance);
	};

	// **The rigs already here**, because the added-signal never fires for them again — a client mounting into a
	// running server has drills standing in front of it whose tags arrived with the place. `chargeEffect` makes the
	// same walk for the same reason.
	for (const instance of CollectionService.GetTagged(PRACTICE_THROW_TAG)) watch(instance);

	CollectionService.GetInstanceAddedSignal(PRACTICE_THROW_TAG).Connect((instance) => watch(instance));

	// **One removal subscription for every rig**, rather than one per rig inside `watch`, because the question it
	// answers — "is this instance still a drill" — is asked of the instance rather than of a body this module knows.
	CollectionService.GetInstanceRemovedSignal(PRACTICE_THROW_TAG).Connect((instance) => {
		if (instance.IsA("Model")) forget(instance);
	});

	// The loop. **One call per drill rig, and nothing else** — see this module's header for why the tag is what makes
	// that affordable and why there is no change-listener beside it.
	//
	// **Over `watched` and not over `rows`, and that is the difference between a working countdown and none.** `rows`
	// holds rigs that have a box, and a box is built on the first frame that has a digit to put in it — so a loop over
	// `rows` would be a loop that never runs for the one rig it is waiting on. Walking every drill instead means an
	// idle rig costs one attribute read and an `undefined` comparison per frame, which is the price of noticing it arm.
	//
	// **`draw` only ever writes the entry it was handed**, which is what makes mutating either map from inside this
	// iteration safe: replacing an existing key is defined and adding one is not. A future `delete` in `draw` would
	// have to be moved out here.
	RunService.Heartbeat.Connect(() => {
		for (const [rig] of watched) draw(rig);
	});
}
