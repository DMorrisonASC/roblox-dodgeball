import { OnStart, Service } from "@flamework/core";
import { Players, Workspace } from "@rbxts/services";
import { RESPAWN_AT_ATTRIBUTE } from "shared/constants";

/** Prints one line per load, per schedule and per cancelled wait, naming the reason. */
const DEBUG = true;

/**
 * Every character this game gives anybody, and the only place `Player.LoadCharacterAsync` is called.
 *
 * **Why one call needs a service: the engine has been switched off.** `Players.CharacterAutoLoads` is false
 * (see `main.server.ts`), because the engine and the round cannot both be in charge of a death. With it on, a
 * dead player's body arrives on the engine's own clock the moment the death is noticed — `RespawnTime`,
 * five seconds by default — and no round-scheduled delay can come first, because the engine does not know a
 * round exists. Turning it off is what makes the in-round delay real, and it moves *every* body in the game
 * into this file's hands: the one a player gets when they join, the one a dead player gets in the lobby, the
 * one an eliminated player gets, and the delayed one a round schedules.
 *
 * **What a missed load site costs, because it is not an error and it is not visible.** A path that forgets to
 * ask for a body does not warn, throw or print: it leaves a player standing on nothing, with no character, no
 * `CharacterAdded`, no HUD and no corpse, and the nearest thing to a symptom is a person who never appears.
 * So the discipline is deliberately narrow and worth stating as a rule rather than as a preference:
 * **one method calls the engine's load** — {@link loadNow} — every path that needs a body goes through it, and
 * a `LoadCharacterAsync` written anywhere else is a bug. A grep for `LoadCharacterAsync` in `src` should return
 * this file and no other.
 *
 * **The pending timer is state, so it is owned rather than promised.** One row per player, replaced on a
 * second death, cancelled when the round ends or the player leaves, and cleared by any load. Keeping it in one
 * table is what makes "a player cannot have two respawns in flight" a fact about this file rather than a rule
 * three callers have to remember.
 *
 * **No `Players.RespawnTime`, deliberately.** With `CharacterAutoLoads` off that property governs nothing at
 * all, so setting it would be a line that looks like it is doing something and is not.
 */
@Service()
export class RespawnService implements OnStart {
	/**
	 * The respawn each player is waiting for. At most one per player, which is the whole point of the table.
	 *
	 * A `thread` and not a ticket number, because `task.delay` hands back exactly the thing `task.cancel`
	 * takes — see {@link cancelPending}. It is also what makes this table necessary at all: a countdown
	 * attribute alone would tell a client when a body is due but would leave the *server* unable to stop one.
	 */
	private readonly pending = new Map<Player, thread>();

	public onStart(): void {
		// **A timer that has outlived its player.** `task.delay` holds the player in its closure and would fire
		// into `loadNow` after they are gone, so the row is dropped here and the wait cannot even be counted.
		// The attribute is cleared as well, which is the third of the three places a wait can end — and the one
		// that costs nothing to write even though the player it is written on is leaving: the client reading it
		// may still be alive for a frame, and a countdown that stops when its owner leaves is the honest answer
		// rather than a loose end.
		Players.PlayerRemoving.Connect((player) => {
			this.cancelPending(player);
			player.SetAttribute(RESPAWN_AT_ATTRIBUTE, 0);
		});
	}

	/**
	 * Gives `player` a body now, cancelling anything that was waiting to give them one.
	 *
	 * **The one entry point, and the reason it takes a `reason`.** Every load in the game is one of four
	 * things — a join, a death outside a round, an elimination, or a wait ending — and they are identical in
	 * the output otherwise. One gated line naming which one it was is what makes "why does this player have a
	 * body" answerable from a log, which is the same reason `[Round]` and `[Spawner]` print what they do.
	 *
	 * **Clearing first is what makes a second death one respawn rather than two.** The timer that was going to
	 * fire is cancelled before it can, and the attribute goes with it, so a client watching
	 * `RESPAWN_AT_ATTRIBUTE` stops counting at the moment the body arrives rather than at the moment the
	 * countdown runs out.
	 *
	 * **A player who has left is not loaded, and nothing is written on them.** The timer case can reach here
	 * after the player is gone; `LoadCharacterAsync` on a `Player` with no parent is not something to discover
	 * in Studio, and `SetAttribute` on one is a write to an instance nobody owns.
	 */
	public loadNow(player: Player, reason: string): void {
		this.cancelPending(player);

		if (player.Parent === undefined) return;

		player.SetAttribute(RESPAWN_AT_ATTRIBUTE, 0);

		// **The yielding form, and the only thing it changes is *when this thread carries on*.** The typings
		// tag both versions `Yields`, so no caller ever had a synchronous guarantee to lose — but this one is
		// documented as resuming once the character exists, which is what makes the print below a statement
		// about the body rather than about the request. The order on this side of the yield is unchanged and is
		// the part that matters: the wait is cleared and the request is issued before the thread parks, so a
		// client watching `RESPAWN_AT_ATTRIBUTE` sees the countdown end at the instant the body is asked for.
		// The print below is the only thing on the far side of the yield, which is why none of this is visible
		// to a caller.
		player.LoadCharacterAsync();

		if (DEBUG) print(`[Respawn] ${player.Name}: loaded — ${reason}`);
	}

	/**
	 * Gives `player` a body in `seconds`, and publishes when.
	 *
	 * **The instant and not the countdown, so the client subtracts against the same clock the server wrote
	 * with.** `RESPAWN_AT_ATTRIBUTE` is `Workspace:GetServerTimeNow() + seconds` — the engine's shared clock,
	 * not this machine's — which is what lets the client draw a smooth countdown with no remote and no second
	 * timer of its own. It is the arrangement the two action cooldowns already use, and it is used here for the
	 * same reason: a client that ran its own countdown would be a second implementation of "how long is the
	 * wait", free to disagree with the one that decides it. **A MultiBall window used to be the third example
	 * here and is deliberately no longer one** — it has no deadline to publish since the count became the whole
	 * of the window, so the example is gone with the attribute rather than left as a reference to something a
	 * reader cannot find.
	 *
	 * **Cancel first, always.** A player who dies again inside the wait gets the *second* death's delay and one
	 * body, which is the only reading of "died again" that does not hand somebody two respawns at once.
	 */
	public schedule(player: Player, seconds: number): void {
		this.cancelPending(player);

		player.SetAttribute(RESPAWN_AT_ATTRIBUTE, Workspace.GetServerTimeNow() + seconds);

		this.pending.set(
			player,
			task.delay(seconds, () => {
				// **The row goes before the load, because the row is this thread.** `loadNow` opens by
				// cancelling whatever is pending, and this timer is still in the table when it fires — so left
				// alone it would `task.cancel` the thread currently running, immediately before that thread
				// yields inside `LoadCharacterAsync`. Whether a thread cancelled from inside itself resumes is a
				// question about the engine's scheduler that this file should not be asking; dropping the row
				// first makes `cancelPending` inside `loadNow` find nothing, which is the truth as well as the
				// safe answer — this wait is over the moment it fires.
				//
				// A row here can only be this one: `schedule` cancels the timer it replaces, so a superseded
				// callback never runs at all.
				this.pending.delete(player);

				this.loadNow(player, "the wait ended");
			}),
		);

		if (DEBUG) print(`[Respawn] ${player.Name}: respawning in ${seconds}s`);
	}

	/**
	 * Stops a wait, and gives the body now if there was one.
	 *
	 * **The flag means "do not strand a waiting player", not "always load."** The round *ending* passes `true`
	 * because a player who was counting down has no character at all, the intermission is about to teleport
	 * everybody into the lobby, and a teleport moves characters rather than creating them — so cancelling their
	 * timer without loading would leave them invisible for the whole intermission, looking exactly like a break
	 * in the join path. That is the whole of what the flag is for, which is why it cannot be read as a request
	 * to load unconditionally: the caller walks every player in the server, and a player who was not waiting has
	 * a body already.
	 *
	 * **A player with nothing pending is left alone, even when the flag is `true`** — see the guard below. What
	 * the flag decides is what happens to somebody who *was* counting down; for everybody else this method is a
	 * no-op, which is what stops a round boundary rebuilding every character in the game.
	 *
	 * **`false` is dead in practice and is kept deliberately.** No caller passes it — the round's is the only
	 * call site and it passes `true` — and the branch stays because it is the half of the flag that says what
	 * the parameter is *for*: cancelling without loading is the one combination that leaves a waiting player
	 * bodiless, so it is a thing a caller has to mean rather than a thing that can happen by accident.
	 */
	public cancel(player: Player, loadImmediately: boolean): void {
		// **A player with a body is left alone, and that is the whole of this guard.** The caller walks *every*
		// player in the server at a round boundary, so a load here reached people who were not waiting for
		// anything: their character was destroyed and rebuilt on the spot, which dropped whatever they were
		// holding, reset the camera and the HUD and re-applied the spawn shield — all for somebody standing in
		// the lobby with a body the teleport had already moved. Nothing pending means nothing is owed, so this
		// returns before anything is written or loaded. See the doc above for what the flag now means.
		const wasWaiting = this.cancelPending(player);
		if (!wasWaiting) return;

		player.SetAttribute(RESPAWN_AT_ATTRIBUTE, 0);

		if (!loadImmediately) {
			if (DEBUG) print(`[Respawn] ${player.Name}: pending respawn cancelled`);

			return;
		}

		this.loadNow(player, "the round ended");
	}

	/** Drops `player`'s pending row, cancelling its timer. Answers whether there was one. */
	private cancelPending(player: Player): boolean {
		const timer = this.pending.get(player);
		if (timer === undefined) return false;

		this.pending.delete(player);
		task.cancel(timer);

		return true;
	}
}
