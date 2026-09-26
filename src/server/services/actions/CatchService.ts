import { OnStart, Service } from "@flamework/core";
import { Players } from "@rbxts/services";
import { ACTION_CONFIG } from "shared/config/action.config";
import { CATCH_CONFIG } from "shared/config/catch.config";
import { DEBUG_CONFIG } from "shared/config/debug.config";
import { CATCH_READY_AT, DODGE_READY_AT } from "shared/constants";
import { resolveDodgeable } from "shared/dodge";
import { events } from "shared/networking";
import { lockoutElapsed } from "../actionLock";
import { DevService } from "../dev/DevService";
import { extendReadyAt, publishReadyAt } from "../readyAt";
import { BallService } from "./BallService";
import { DodgeService } from "./DodgeService";

/** Prints window openings, expiries and refusals — but not refreshes, which happen every tick. */
const DEBUG = true;

/**
 * How long a catch keeps the pair busy: the window, plus the lockout a dodge is refused for after
 * it closes.
 *
 * A sum rather than a value of its own, derived here rather than written into a config, because
 * both halves are already shared — the window is this service's own clock and the tail is the
 * pair's rule — so there is nothing left to choose and nothing to keep in step. The client adds up
 * the same two config values, which is what keeps the readout and the rule moving together.
 */
const CATCH_BUSY_SECONDS = CATCH_CONFIG.WINDOW_SECONDS + ACTION_CONFIG.ACTION_LOCKOUT_SECONDS;

/**
 * Catch windows, decided by the server.
 *
 * An attempt does not catch anything by itself — it opens a window, and the ball
 * that arrives inside that window is the one caught. That is what makes catching
 * a read of the throw rather than a state you can stand in: `BallComponent` asks
 * {@link isCatching} when a ball touches a catchable part, and {@link consume}s
 * the window so one attempt catches one ball.
 *
 * Everything is keyed on the **model**, never the player. A catcher is any living
 * humanoid — an NPC differs from a player's character in nothing but the player
 * behind it — so the player path is just the remote handler below, which hands us
 * the model, and an NPC's AI makes the very same call directly. The one thing
 * keyed on a player is the dev flag, because that is where flags live: see
 * {@link alwaysCatching}.
 */
interface CatchWindow {
	/** `os.clock` seconds at which this window stops counting. */
	expiresAt: number;

	/**
	 * Fires if the catcher dies before the window is spent.
	 *
	 * Kept rather than merely connected so that closing the window closes this too:
	 * a catching NPC asks for a window every tick, and one listener per request
	 * would pile up thousands of watches on a humanoid that only dies once.
	 */
	death: RBXScriptConnection;
}

@Service()
export class CatchService implements OnStart {
	/**
	 * Every open window, keyed on the model that is catching.
	 *
	 * An entry only exists while a window is open: it is spent by a catch, dropped
	 * when it expires, and dropped when its catcher dies or leaves.
	 */
	private readonly windows = new Map<Model, CatchWindow>();

	/**
	 * Devs catching with the window held open, keyed on the player because that is
	 * where the flag lives.
	 *
	 * Kept apart from {@link windows} on purpose: an endless window is not a long
	 * one. It has no expiry to store and no clock to compare against, so a sentinel
	 * in the time map would mean every reader of that map having to know about the
	 * sentinel. Checked first instead, and the map is then never consulted.
	 */
	private readonly alwaysCatching = new Set<Player>();

	/**
	 * When each model's last catch window stopped counting, keyed on the model.
	 *
	 * Written in **one** place, {@link consume}, which is already the only way a window is
	 * spent, dropped or found expired — so there is no path that closes a window without
	 * leaving a time here. Read by {@link getLastCatchWindowCloseTime}, which is what a dodge
	 * is gated on.
	 */
	private readonly lastCatchCloseAt = new Map<Model, number>();

	/**
	 * When each model's catch *cycle* ends, keyed on the model.
	 *
	 * **Not the window's expiry.** A window is how long a catch is possible; a cycle is the window
	 * plus the lockout that follows it, and it is what a second press is refused by — so holding
	 * the key is one attempt rather than a permanently open window, which is what "press E to
	 * catch" has to mean for a catch to be a read of the throw.
	 *
	 * A press inside the cycle changes nothing: no window opens, no window is extended, and this
	 * stamp does not move. A catch that lands still ends only the window — the cycle is what the
	 * player owes between attempts, not what the ball pays off.
	 */
	private readonly catchReadyAt = new Map<Model, number>();

	constructor(
		private readonly dev: DevService,
		private readonly dodges: DodgeService,
		private readonly balls: BallService,
	) {
		// The dodge is gated on the catch, and this is where the catch side of that is handed
		// over: the two services are gated on each other, and Flamework errors on a circular
		// dependency, so exactly one of them can hold the other. This one holds the dodge
		// service — which is what lets {@link attemptCatch} ask it directly — and gives itself
		// back the other way, as the thing the dodge service asks about catch windows.
		//
		// In the constructor rather than `onStart` so that there is no frame in which one
		// service is running and the other has not been told about it.
		//
		// **`BallService` is held for one question, and it is not the same problem.** The dodge
		// pairing needed breaking by hand because it is mutual; the ball is an ordinary one-way
		// ask — see {@link attemptCatch} — and `BallService` knows nothing about catching, so
		// there is nothing here to untangle.
		this.dodges.watchCatchState(this);
	}

	public onStart() {
		events.Server.OnEvent("catch", (player) => {
			// The arrival line, printed before anything is decided. A press that produces
			// no output at all and a press that produces the wrong output look identical
			// from the player's seat, and this is the one line that says the event got here
			// — so its absence means the key or the wire, never the catch itself.
			if (DEBUG) print(`[Catch] ${player.Name} asked to catch`);

			const character = player.Character;
			if (!character) {
				if (DEBUG) print(`[Catch] ${player.Name}: no character to catch with`);
				return;
			}

			this.attemptCatch(character);
		});

		// A window that outlives its catcher would be a catch waiting to happen on a
		// model nobody owns any more.
		Players.PlayerRemoving.Connect((player) => {
			const character = player.Character;
			if (character) this.forget(character);
		});
	}

	/**
	 * Opens a catch window on `model`, or extends one already open.
	 *
	 * Returns whether one opened, which is the same question as whether `model` can
	 * catch at all: a catcher is a living humanoid, exactly what a dodge needs — so
	 * the model is resolved and checked with the same helper, and the two rules
	 * cannot drift apart.
	 *
	 * The public entry point for both paths. A player reaches it through the remote
	 * above; an NPC's AI calls this directly.
	 */
	public attemptCatch(model: Model): boolean {
		const humanoid = resolveDodgeable(model)?.humanoid;
		if (!humanoid || humanoid.Health <= 0) {
			if (DEBUG) print(`[Catch] ${model.Name}: no living humanoid to catch with`);
			return false;
		}

		// **A free hand is what catches, and this is where that is decided.** The client refuses
		// the same press for the same reason and never fires — see `CatchController` — which is the
		// responsive half and saves the round trip. But a prediction is not a rule: a remote can be
		// fired by hand, and this is the half that a crafted call meets.
		//
		// Keyed on the **model**, like every other hand rule in the game, so an NPC is held to it
		// without a line of its own — `CatchBehavior` asks through this same call, and a rig holding
		// a ball is refused here exactly as a character is. That is a decision and not an accident: a
		// catch does not join the ball already in the hand, it *replaces* it — see
		// `BallService.attachToHand` — so a rig allowed to catch while armed would be trading the ball
		// it was issued for the one it caught.
		//
		// **`InfiniteCatch` does not lift this, and it is checked above the dev's window for exactly
		// that reason.** That flag moves the window's *clock* — one press, an endless window instead of
		// `CATCH_CONFIG.WINDOW_SECONDS` — and a free hand is not a clock: it is a state the dev can be
		// in or not, the same way a player can. A dev testing a catch empties their hand with `1` first,
		// which keeps the test honest rather than exempting the tester from the rule under test.
		// The lockouts below hold for a dev too, for the same reason.
		//
		// Ahead of {@link blocksCatch} rather than behind it because this is the refusal most presses
		// now want — everybody is handed a ball on join, so an armed hand is the common case — and
		// because it is the one that cannot be waited out: a lockout expires on its own, and a ball in
		// the hand does not.
		const held = this.balls.getHeldBall(model);
		if (held) {
			// Named, and with its `Armed` flag, because those two facts are the whole diagnosis when a
			// rig will not catch. **Only `giveBall` arms a ball**, and for a rig the only thing that
			// calls it is `ThrowBehavior` — so an armed ball stuck in a catcher's hand means something
			// issued it a ball, whether or not that rig was meant to have a throwing tag. An inert ball
			// is the other case entirely: a catch or a pickup that has not been dropped yet, and which
			// `CatchBehavior` takes out of the hand on its next tick.
			if (DEBUG) {
				print(
					`[Catch] ${model.Name}: refused — ${held.Name} is already in hand` +
						` (Armed ${held.GetAttribute("Armed")})`,
				);
			}

			return false;
		}

		// Before anything opens, and before the dev's endless window: this gates the *entry*
		// into catching, so it holds for a dev exactly as it holds for anybody else — the dev
		// flags move each action's own clock, and this is not one of those. See
		// {@link lockoutElapsed}.
		if (this.blocksCatch(model)) return false;

		// A dev testing a catch does not need good timing: with the flag on, one press
		// is a window that stays open until a ball arrives.
		if (this.holdOpenForDev(model)) return true;

		const now = os.clock();
		const player = Players.GetPlayerFromCharacter(model);

		// **The cycle gates a key press, and only a key press.** It exists to make a second press
		// inside the window a press that does nothing, so it belongs to the model somebody is
		// holding the key for. An NPC has no key: its AI asks on a timer of its own
		// (`CatchBehavior`), and asking that often is *how* it keeps a window open — each attempt
		// re-stamps the window, so the rig is a catcher continuously rather than a catcher only
		// while a cycle happens to be open. Gated here, an NPC would spend most of its time in the
		// gap between cycles, and whether it caught the ball would come down to when the ball
		// arrived.
		if (player !== undefined) {
			const readyAt = this.catchReadyAt.get(model);
			if (readyAt !== undefined && now < readyAt) {
				if (DEBUG) print(`[Catch] ${model.Name}: still in the catch cycle`);
				return false;
			}

			// The cycle starts here, where the attempt has been accepted and nothing below can
			// refuse it, and it is published from the same value — so the client's bar and this
			// guard cannot be talking about two different waits.
			this.catchReadyAt.set(model, now + CATCH_BUSY_SECONDS);
			publishReadyAt(model, CATCH_READY_AT, CATCH_BUSY_SECONDS);

			// The mirror of the dodge's own write. A catch cycle shuts *dodging* for as long as it
			// runs, so the dodge bar is told the same wait the catch bar is, and the two readouts
			// cannot disagree about whether the pair is busy.
			//
			// "At least" rather than outright, because the wait behind that bar can be longer than
			// this one — a catch must never bring a longer cooldown forward.
			//
			// Reached only where the cycle really opened: a press refused by a dodge returns above,
			// and so does a dev's endless window, which is not a cycle at all.
			extendReadyAt(model, DODGE_READY_AT, CATCH_BUSY_SECONDS);
		}

		const open = this.windows.get(model);

		// Already catching: the window is *extended*, not replaced. Nothing else
		// changes, and in particular the death watch is not registered again — a
		// catching NPC asks for this every tick, so one watch per request would leave
		// it holding thousands of listeners for a death that happens once.
		if (open) {
			open.expiresAt = now + CATCH_CONFIG.WINDOW_SECONDS;
			return true;
		}

		// The window dies with the catcher. `Once` because a humanoid dies once.
		this.windows.set(model, {
			expiresAt: now + CATCH_CONFIG.WINDOW_SECONDS,
			death: humanoid.Died.Once(() => this.forget(model)),
		});

		if (DEBUG && DEBUG_CONFIG.VERBOSE_LOGS) print(`[Catch] ${model.Name}: window open`);

		return true;
	}

	/**
	 * Opens an endless window for a dev, if this is one and the flag is on.
	 *
	 * Player characters only, and not by choice: the flag lives on a `Player`, so an
	 * NPC never has one. That is the entire difference between a dev's catch and
	 * anybody else's here.
	 *
	 * Reached on every attempt, so the state is re-established each time the key is
	 * pressed — there is nothing to keep in step.
	 */
	private holdOpenForDev(model: Model): boolean {
		const player = Players.GetPlayerFromCharacter(model);
		if (!player || !this.dev.getFlag(player, "InfiniteCatch")) return false;

		this.alwaysCatching.add(player);

		// An endless window is not a length, so there is nothing to count down: the readout is told
		// the wait is over rather than left showing the remains of whatever window came before it.
		publishReadyAt(model, CATCH_READY_AT, 0);

		if (DEBUG) print(`[Catch] ${model.Name}: endless window open (dev)`);

		return true;
	}

	/**
	 * Whether `model` has a catch window open at this instant.
	 *
	 * Expiry is decided here rather than on a timer: the only moment a window
	 * matters is the moment a ball arrives to test it, and a stale entry is dropped
	 * as it is found — so a window nobody ever tests against costs nothing.
	 */
	public isCatching(model: Model): boolean {
		// The endless case first, and the flag asked afresh rather than remembered:
		// that is what makes `!dev InfiniteCatch off` take effect on the next ball
		// instead of on the next press.
		const player = Players.GetPlayerFromCharacter(model);
		if (player && this.alwaysCatching.has(player)) {
			if (this.dev.getFlag(player, "InfiniteCatch")) return true;

			// The flag has gone off, so the endless window stops counting here — a close like
			// any other, and it goes through `consume` so that it is recorded like any other.
			this.consume(model);
		}

		const window = this.windows.get(model);
		if (!window) return false;

		// Not `until`: that is a Luau keyword, and roblox-ts rejects it as an
		// identifier outright ("Invalid Luau identifier!").
		const expiresAt = window.expiresAt;

		if (os.clock() > expiresAt) {
			if (DEBUG && DEBUG_CONFIG.VERBOSE_LOGS) print(`[Catch] ${model.Name}: window expired`);

			// Closed through `consume` so the death watch goes with the window: an
			// expired window must not leave a listener behind.
			this.consume(model);
			return false;
		}

		return true;
	}

	/**
	 * `os.clock` seconds at which `model`'s catch window stopped counting, or `undefined` if
	 * it has never had one open.
	 *
	 * Public because the dodge is gated on it; handed over as part of
	 * {@link DodgeService.watchCatchState} rather than the dodge service reaching in here.
	 */
	public getLastCatchWindowCloseTime(model: Model): number | undefined {
		return this.lastCatchCloseAt.get(model);
	}

	/**
	 * Whether `model`'s dodge is in the way of a catch: in flight now, or ended within the
	 * lockout.
	 *
	 * The mirror of the check `DodgeService` makes on this service, and deliberately written
	 * the same way — ask the owner for its clock, apply the shared lockout — so the two rules
	 * cannot be read as two different rules. {@link lockoutElapsed} is that shared lockout.
	 */
	private blocksCatch(model: Model): boolean {
		if (this.dodges.isDodging(model)) {
			if (DEBUG) print(`[Catch] ${model.Name}: refused — a dodge is in flight`);
			return true;
		}

		const since = lockoutElapsed(this.dodges.getLastDodgeEndTime(model));
		if (since === undefined) return false;

		if (DEBUG) print(`[Catch] ${model.Name}: refused — a dodge ended ${string.format("%.2f", since)}s ago`);

		return true;
	}

	/**
	 * Drops everything this service holds about `model`: its window and its catch cycle.
	 *
	 * For the two moments a model stops being a catcher for good — its humanoid dying and its
	 * player leaving. Both maps are keyed on the model, so an entry that outlives it is never read
	 * again and never cleared; these are the two are dropped together because they are the whole
	 * of what this service remembers about one.
	 *
	 * **A spent window does not come through here.** A ball caught inside the window ends the
	 * window and nothing else, because the cycle is what the player owes between attempts and a
	 * good catch does not pay it off. See {@link consume}.
	 */
	private forget(model: Model): void {
		this.consume(model);
		this.catchReadyAt.delete(model);
	}

	/**
	 * Spends `model`'s window, so one attempt cannot catch two balls.
	 *
	 * Also how a window is dropped without being spent — on expiry, on death, on
	 * leaving — because a window that was never spent simply goes away. The death
	 * watch goes with it, so nothing outlives the window it belonged to.
	 */
	public consume(model: Model): void {
		const now = os.clock();

		// An endless window is spent the way any other is spent — one press is still
		// one catch — so leaving the set is part of spending it.
		const player = Players.GetPlayerFromCharacter(model);
		const endless = player !== undefined && this.alwaysCatching.delete(player);

		const window = this.windows.get(model);

		// Nothing was open: most calls are the catch asking after a ball that never came,
		// and a close that never happened must not be recorded as one.
		if (!window && !endless) return;

		if (window) {
			window.death.Disconnect();
			this.windows.delete(model);
		}

		// **When the window stopped counting**, which is not the same thing as this instant:
		// an expired window is only noticed by whoever next asks, and recording *that* moment
		// would make a window that ended a minute ago look like it had just closed — and would
		// shut the dodge for half a second for no reason. So the earlier of the two: its own
		// expiry, or the moment it was spent or dropped. An endless window has no expiry, so
		// for that one it is now.
		this.lastCatchCloseAt.set(model, window ? math.min(now, window.expiresAt) : now);
	}
}
