import { OnStart, Service } from "@flamework/core";
import { events } from "shared/networking";
import { BallService } from "../ball/BallService";
import { CatchService } from "./CatchService";
import { DodgeService } from "./DodgeService";

/** Prints every manual action that arrived, and why one of them did nothing. */
const DEBUG = false; // off for frame time — see shared/config/debug.config.ts

/**
 * The key that is not aiming: dropping the ball in hand.
 *
 * **It was two, and the throw toggle has retired.** This service also carried "switch throwing off" — a
 * preference about *throwing* rather than about balls, which was one of the two reasons it is a service of
 * its own instead of a second handler in `BallService`. That reason went with it, and so did the gate the
 * other reason was about: `BallService` no longer reads a throw setting, because there is no longer one to
 * read.
 *
 * A service of its own rather than one more handler in `BallService`, because this has to ask the two
 * action services a question and `BallService` is the thing that throws. The shape is the point: a key
 * press, nothing predicted on the client, nothing sent back, and no state here that the reader does not own.
 *
 * **The handler is here and the work is not.** Dropping is `BallService.dropBall`. Nothing in this file
 * needs to know what a ball is made of.
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
}
