import { OnStart, Service } from "@flamework/core";
import { THROW_ENABLED } from "shared/constants";
import { events } from "shared/networking";
import { BallService } from "../ball/BallService";
import { CatchService } from "./CatchService";
import { DodgeService } from "./DodgeService";

/** Prints every manual action that arrived, and why one of them did nothing. */
const DEBUG = true;

/**
 * The two keys that are not aiming: dropping the ball in hand, and switching throwing off.
 *
 * A service of its own rather than two more handlers in `BallService`, because the second
 * of them is not about balls at all — it is a preference about *throwing*, kept on the
 * player — and because the first has to ask the two action services a question. What the
 * two have in common is the shape: a key press, nothing predicted on the client, nothing
 * sent back, and no state here that the reader does not own.
 *
 * **The handlers are here and the work is not.** Dropping is `BallService.dropBall`, and
 * the throw gate is read by `BallService` itself, because that is the only thing in the
 * game that throws. Nothing in this file needs to know what a ball is made of.
 */
@Service()
export class ActionService implements OnStart {
	constructor(
		private readonly balls: BallService,
		private readonly dodges: DodgeService,
		private readonly catches: CatchService,
	) {}

	public onStart() {
		events.Server.OnEvent("drop", (player) => this.drop(player));
		events.Server.OnEvent("toggleThrow", (player) => this.toggleThrow(player));
	}

	/**
	 * Drops whatever `player` is holding.
	 *
	 * Refused while a dodge is in flight or a catch window is open — **and not for the
	 * lockout that follows either of them.** That window exists so a player cannot chain
	 * one committed action into another; dropping a ball is not an action in that sense,
	 * and a ball that cannot be put down for half a second after a dodge would be a rule
	 * with nothing behind it. The keys say nothing in either direction: a press that is
	 * refused and a press with an empty hand both look the same from the player's seat,
	 * which is what `DEBUG` is for.
	 */
	private drop(player: Player): void {
		const character = player.Character;
		if (!character) {
			if (DEBUG) print(`[Action] ${player.Name}: nothing to drop`);
			return;
		}

		if (this.dodges.isDodging(character)) {
			if (DEBUG) print(`[Action] ${player.Name}: drop refused — a dodge is in flight`);
			return;
		}

		if (this.catches.isCatching(character)) {
			if (DEBUG) print(`[Action] ${player.Name}: drop refused — a catch window is open`);
			return;
		}

		// An empty hand is not an error: the key is pressed to see whether it does
		// anything, and `dropBall` is the one place that knows whether there was a ball.
		if (!this.balls.dropBall(character) && DEBUG) {
			print(`[Action] ${player.Name}: drop asked for with an empty hand`);
		}
	}

	/**
	 * Flips whether `player` may throw, and keeps the answer on the player.
	 *
	 * The write is the whole handler: nothing here decides when the toggle may happen,
	 * because nothing depends on it. It can be flipped mid-dodge, mid-catch, or dead, and
	 * none of those states care — it is a preference about the next click, not an action.
	 *
	 * "Off unless the attribute says otherwise" is the rule, and it is read as
	 * `=== false` rather than as a truthiness test so that a player who has never pressed
	 * the key — who has no attribute at all — is allowed to throw. That also means the
	 * first press is the one that switches throwing *off*, which is the state the key is
	 * for.
	 */
	private toggleThrow(player: Player): void {
		// Named `enabled` and not `next`, which roblox-ts refuses outright: "Cannot use
		// identifier reserved for compiler internal usage." `next` is a Lua global — the
		// table-iteration function — and the compiler protects the same names `until` and
		// `type` fall under, because a local shadowing one would change what the emitted
		// Luau means. The name is not the point here; the value is.
		const enabled = player.GetAttribute(THROW_ENABLED) === false;

		player.SetAttribute(THROW_ENABLED, enabled);

		if (DEBUG) print(`[Action] ${player.Name}: throwing ${enabled ? "enabled" : "disabled"}`);
	}
}
