import { OnStart, Service } from "@flamework/core";
import { Players } from "@rbxts/services";
import { CATCH_CONFIG } from "shared/config/catch.config";
import { resolveDodgeable } from "shared/dodge";
import { events } from "shared/networking";
import { lockoutElapsed } from "../actionLock";
import { DevService } from "../dev/DevService";
import { DodgeService } from "./DodgeService";

/** Prints window openings, expiries and refusals — but not refreshes, which happen every tick. */
const DEBUG = true;

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

	constructor(private readonly dev: DevService, private readonly dodges: DodgeService) {
		// The dodge is gated on the catch, and this is where the catch side of that is handed
		// over: the two services are gated on each other, and Flamework errors on a circular
		// dependency, so exactly one of them can hold the other. This one holds the dodge
		// service — which is what lets {@link attemptCatch} ask it directly — and gives itself
		// back the other way, as the thing the dodge service asks about catch windows.
		//
		// In the constructor rather than `onStart` so that there is no frame in which one
		// service is running and the other has not been told about it.
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
			if (character) this.consume(character);
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

		// Before anything opens, and before the dev's endless window: this gates the *entry*
		// into catching, so it holds for a dev exactly as it holds for anybody else — the dev
		// flags move each action's own clock, and this is not one of those. See
		// {@link lockoutElapsed}.
		if (this.blocksCatch(model)) return false;

		// A dev testing a catch does not need good timing: with the flag on, one press
		// is a window that stays open until a ball arrives.
		if (this.holdOpenForDev(model)) return true;

		const open = this.windows.get(model);

		// Already catching: the window is *extended*, not replaced. Nothing else
		// changes, and in particular the death watch is not registered again — a
		// catching NPC asks for this every tick, so one watch per request would leave
		// it holding thousands of listeners for a death that happens once.
		if (open) {
			open.expiresAt = os.clock() + CATCH_CONFIG.WINDOW_SECONDS;
			return true;
		}

		// The window dies with the catcher. `Once` because a humanoid dies once.
		this.windows.set(model, {
			expiresAt: os.clock() + CATCH_CONFIG.WINDOW_SECONDS,
			death: humanoid.Died.Once(() => this.consume(model)),
		});

		if (DEBUG) print(`[Catch] ${model.Name}: window open`);

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
			if (DEBUG) print(`[Catch] ${model.Name}: window expired`);

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
