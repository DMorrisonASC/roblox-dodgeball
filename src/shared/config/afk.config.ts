/**
 * How long a player may sit still before the game asks whether they are still there.
 *
 * **Two numbers and no code**, because the two sides need the same one for different reasons: the client runs
 * both clocks (`client/afk.ts`) and the server names the idle figure in the line it prints when a player is
 * returned to the lobby. A literal in each place would be two numbers to keep in step by hand, which is the same
 * drift `NPC_CONFIG.CATCH_DECISION_SECONDS` flags about the catch window it duplicates — see its note on being
 * "written as a literal rather than as `CATCH_CONFIG.WINDOW_SECONDS`, because this file imports nothing".
 * **That is the trade being refused here**: this file is its own module, so both sides can import it and the
 * figure is written once.
 *
 * **Not `CHARACTER_CONFIG` and not `ARENA_CONFIG`**, because neither owns it: a stamina figure is about a body
 * and a round figure is about the match, while this is about a *person at a keyboard*. It is read by a client
 * module and by one print, and by nothing that decides whether a round can start or end.
 *
 * Imports nothing, for `sound.config.ts`'s reason: a config that depended on a service would be a service.
 */
export const AFK_CONFIG = {
	/**
	 * **How long a player may go with no input at all before the countdown appears**, in seconds.
	 *
	 * **Twenty, and the number is sized against the two things it must not interrupt.** It has to be longer than
	 * the longest legitimate stillness in this game — a charge is under a second, a catch window is the same, and
	 * a player watching where a ball is going is a few seconds — and it has to be short enough that a round is
	 * not held up by somebody who has already left the keyboard. Twenty is roughly four times the longest hold a
	 * player can make and a fifth of an intermission, which puts it in the gap between "waiting" and "gone".
	 *
	 * **Only counted while the window is focused, the player is in a round, and the round has more time left on its
	 * clock than this figure** — see `client/afk.ts`, where all three are gates on the clock rather than conditions
	 * inside it. The third arrived 2026-10-22: an idle window that lands on the round's own last seconds produces a
	 * request the server has to refuse, so the clock is paused for the whole of them. It also means this number is
	 * the round's own "no opinion" margin — the last `IDLE_SECONDS` of a round are never an AFK window. **Of the first
	 * two gates, the focus one is the older argument and it still holds**: a player alt-tabbed is not idle, they are
	 * not there to see a prompt, and returning them to the lobby for backgrounding the game is a worse bug than
	 * the one this feature fixes.
	 *
	 * **Placeholder.** It has not been tuned against a real round; it is the number to move if the prompt arrives
	 * while somebody is reading the scoreboard.
	 */
	IDLE_SECONDS: 15,

	/**
	 * **How long the countdown runs before the player is returned to the lobby**, in seconds, and therefore how
	 * long they have to prove they are still there.
	 *
	 * **Five, counted in whole seconds on screen**, because the prompt says its own number out loud
	 * (`Returning to lobby in 4…`) and a count that is not whole cannot be read. That is also why the countdown
	 * is a clock compared against rather than a number decremented per frame: a decrement on a frame loop is a
	 * number that depends on the frame rate, and the sentence it draws would be a second wrong on a slow client.
	 *
	 * **Any input at all cancels it**, including input the interface consumed — see `client/afk.ts` on the
	 * difference between "the game acted on it" and "somebody is there".
	 */
	COUNTDOWN_SECONDS: 5,
} as const;
