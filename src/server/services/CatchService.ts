import { OnStart, Service } from "@flamework/core";
import { Players } from "@rbxts/services";
import { CATCH_WINDOW } from "shared/constants";
import { resolveDodgeable } from "shared/dodge";
import { events } from "shared/networking";

/** Prints every attempt, and every window that came up empty. */
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
 * the model, and an NPC's AI makes the very same call directly.
 */
@Service()
export class CatchService implements OnStart {
	/**
	 * When each model's window closes, in `os.clock` seconds.
	 *
	 * An entry only exists while a window is open: it is spent by a catch, dropped
	 * when it expires, and dropped when its catcher dies or leaves.
	 */
	private readonly openUntil = new Map<Model, number>();

	public onStart() {
		events.Server.OnEvent("catch", (player) => {
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
	 * Opens a catch window on `model`.
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

		// The window dies with the catcher. `Once` because a humanoid dies once.
		humanoid.Died.Once(() => this.consume(model));

		this.openUntil.set(model, os.clock() + CATCH_WINDOW);

		if (DEBUG) print(`[Catch] ${model.Name}: window open`);

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
		// Not `until`: that is a Luau keyword, and roblox-ts rejects it as an
		// identifier outright ("Invalid Luau identifier!").
		const expiresAt = this.openUntil.get(model);
		if (expiresAt === undefined) return false;

		if (os.clock() > expiresAt) {
            if (DEBUG) print(`[Catch] ${model.Name}: window expired`);
			this.openUntil.delete(model);
			return false;
		}

		return true;
	}

	/**
	 * Spends `model`'s window, so one attempt cannot catch two balls.
	 *
	 * Also how a window is dropped without being spent — on death, on leaving —
	 * because a window that was never spent simply goes away.
	 */
	public consume(model: Model): void {
		this.openUntil.delete(model);
	}
}
