import { GameModeId } from "shared/gameMode";
import { RoundOutcome, TEAM_A, TEAM_B, TeamLabel } from "../team";

/**
 * What a landed hit tells a mode.
 *
 * The victim is a `Player` rather than the model the ball touched, because every mode that cares
 * about a hit cares about the *person*: a point, a side, a role. Resolving the model is the
 * round's job, done once, where the rest of is-this-a-player already lives — a mode has no
 * business knowing that an NPC rig is a `Model` with no `Player` behind it.
 *
 * A thrower is optional because a rig can throw. That is not an edge case to be papered over: a
 * mode that scores has to decide what an NPC's hit is worth, and the honest place for that
 * decision is the mode, not a silent default here.
 */
export interface HitEvent {
	/** The player whose throw landed, or `undefined` when a rig threw it. */
	readonly thrower?: Player;

	/** The player it landed on. */
	readonly victim: Player;
}

/**
 * What a death tells a mode.
 *
	 * **It says who, and deliberately not why.** `Humanoid.Died` reports no cause at all — a ball, a
	 * fall out of the world and the reset button are one event — and for a while this carried a
	 * `byHit` flag so that a mode could tell them apart. Nothing ever asked: Dodge and Seek's rules
	 * move a dodger to the seekers whether they were hit or reset, because both leave the dodger
	 * side, and its win condition counts that side rather than the reason anybody left it. The flag
	 * went, along with the round's bookkeeping behind it, once all three modes were written and none
	 * of them consulted it.
	 *
	 * A mode that does need the difference will have to ask for it back, and the place it would be
	 * recorded is the throw-hit path — the only moment it is observable.
	 *
	 * An object rather than a bare `Player` so that adding a field back is a change here rather than
	 * at every call site.
	 */
export interface DeathEvent {
	/** Who died. */
	readonly player: Player;
}

/**
 * Everything a mode is allowed to know about the round in progress.
 *
 * **Read-only, and narrow on purpose.** A mode is a set of decisions; the round is the thing that
 * can *do* anything. Handing a mode the round itself would let it respawn a player, end a round
 * or write an attribute, and then the rules of a game mode would be spread across the mode and
 * wherever it happened to reach — which is exactly the tangle the interface exists to prevent.
 *
 * It is also what keeps a mode free of dependencies: this is a handful of reads and no services,
 * so a mode can be reasoned about, and eventually tested, without a running game.
 */
export interface RoundView {
	/**
	 * Everyone still in the round. Nobody who has left, died out or is watching.
	 *
	 * A method rather than a property, and that is the compiler's rule rather than this interface's:
	 * **roblox-ts does not support getters** — "Getters and Setters are not supported!" — so a value
	 * computed on demand has to be written as a call. The alternative, a field kept in step beside
	 * the set it describes, would be a second answer to "who is playing", which is the exact thing
	 * this design spends its effort avoiding.
	 */
	playersInRound(): ReadonlyArray<Player>;

	/** The side a player is on, or `undefined` if they are not in the round. */
	teamOf(player: Player): TeamLabel | undefined;

	/** Points per side. Empty for a mode that does not keep score — see {@link GameMode.scores}. */
	readonly scores: ReadonlyMap<TeamLabel, number>;

	/** Whole seconds left in the playing phase. `0` means the clock has run out. */
	getTimeRemaining(): number;
}

/**
 * What should happen to a player who has died.
 *
 * A tagged union rather than a pair of booleans, so "eliminate" and "respawn" cannot both be
 * claimed and neither is a default that a mode forgets to set. The `respawn` case carries an
 * optional side because one of the three modes moves the player as well as sending them back:
 * a dodger who is hit comes back as a seeker. A mode that only sends them back omits it and they
 * keep the side they had.
 */
export type DeathDecision =
	/** Out of the round; they watch the rest of it. */
	| { readonly kind: "eliminate" }
	/** Back in it. On `team` if one is given, otherwise on the side they were already on. */
	| { readonly kind: "respawn"; readonly team?: TeamLabel };

/**
 * One way of playing a round.
 *
 * **A mode is decisions, not effects.** Every method here answers a question and the round acts on
 * the answer — so a rule like "a hit is worth a point" is readable in one place, and the mechanism
 * that awards the point (a map, a side, an attribute) exists once instead of once per mode. That
 * split is the whole shape of this interface: the round owns what a round *is* — a clock, a set of
 * people, a winner — and a mode owns what the rules *are*.
 *
 * Which also means a mode needs no constructor arguments and holds no services. There is nothing
 * for it to inject, because everything it may look at arrives as a {@link RoundView} and
 * everything it may change leaves as a return value.
 *
 * **Where a mode keeps its state, then, is the question this design answers by refusing it.** A
 * mode that accumulated its own tally would need resetting between rounds, would be able to
 * disagree with the round about who is still playing, and would hold a reference to a `Player`
 * that may have left. Instead the round holds the state and hands it over to be read: sides, and
 * the score per side.
 */
export interface GameMode {
	/** Which mode this is. Matches the key it is filed under in the registry. */
	readonly id: GameModeId;

	/**
	 * Whether this mode keeps a score.
	 *
	 * Read by the HUD and by nothing else, and it exists so that a mode without points does not
	 * have to publish zeroes: a scoreboard drawn from an untouched map would show a scoreless
	 * mode as a 0–0 draw, which is a claim about the round rather than an absence of one.
	 */
	readonly scores: boolean;

	/**
	 * The sides for the opening whistle: one label per player, and every player gets one.
	 *
	 * Called with the whole server rather than with whoever is left, because it *is* the moment
	 * the round's roster is decided — a mode that wants to leave somebody out has to say so here,
	 * and there is nowhere else it could.
	 */
	assign(players: ReadonlyArray<Player>): Map<Player, TeamLabel>;

	/**
	 * What a landed hit is worth to the side that threw it, or `undefined` for nothing.
	 *
	 * The round credits the **thrower's** team, which is the only attribution that needs no
	 * explanation: the point goes to whoever landed the throw. A mode that wants something else —
	 * a hit that costs the victim's side, an NPC's throw worth half — returns a number here rather
	 * than the round holding a rule about it.
	 *
	 * The number is what is added, so a mode that wants a heavier weapon varies it here and the
	 * tally stays one line in one place.
	 *
	 * **It only ever sees a cross-team hit.** Friendly fire is refused globally in the throw-hit
	 * path — one rule for every mode, applied in `BallComponent` before any damage — so a hit on the
	 * thrower's own side never reaches here, and a same-side branch written against this method
	 * would be unreachable code wearing the costume of a rule.
	 */
	hitAward(event: HitEvent, view: RoundView): number | undefined;

	/** What to do about a player who has died. See {@link DeathDecision}. */
	onDeath(event: DeathEvent, view: RoundView): DeathDecision;

	/**
	 * Who has won, or `undefined` while the round is still on.
	 *
	 * Asked once a second, and the answer is allowed to depend on the clock — that is the whole
	 * reason `getTimeRemaining` is on the view. A mode that ends on a target ends the moment it is
	 * reached; a mode that ends on the clock reads `0` and decides.
	 *
	 * **A mode is responsible for the both-sides-empty case.** Every mode has to answer it, and
	 * each one answers it differently — a mode that respawns is not "won" by a side that happens to
	 * be the last one with a player in the server — so the round does not guess on the mode's
	 * behalf. Team Elimination's answer is that nobody wins, which is also what stops an empty
	 * server sitting inside a round until the clock runs out.
	 */
	outcome(view: RoundView): RoundOutcome | undefined;
}

/**
 * The server split into two sides, as evenly as it goes, and shuffled.
 *
 * **The two symmetric modes' opening whistle, in one place**, so "evenly" means one thing.
 * Dodge and Seek does not call this — one seeker and the rest dodgers is not an even split — but
 * it is the same kind of decision, and a mode that wanted an even split gets it without repeating
 * the shuffle.
 *
 * The split is by *position* in a shuffled list, because there is nothing to balance on yet and a
 * shuffle is the honest form of "evenly": anything else would be a claim about who should be
 * together. `ceil` rather than `floor` is what puts the odd player on A, so the two sides are the
 * ceiling and the floor of half the server.
 *
 * **The argument is copied rather than shuffled in place.** It used to be `Players.GetPlayers()`,
 * freshly built for the caller, so mutating it was invisible; a mode is handed a list it does not
 * own, and reordering somebody else's array is a bug waiting for the second caller.
 */
export function splitEvenly(players: ReadonlyArray<Player>): Map<Player, TeamLabel> {
	const order: Player[] = [];
	for (const player of players) order.push(player);

	// Fisher-Yates, over the copy.
	for (let index = order.size() - 1; index > 0; index--) {
		const other = math.random(0, index);
		const swap = order[index];

		order[index] = order[other];
		order[other] = swap;
	}

	const split = math.ceil(order.size() / 2);
	const teams = new Map<Player, TeamLabel>();

	for (let index = 0; index < order.size(); index++) {
		const player = order[index];
		teams.set(player, index < split ? TEAM_A : TEAM_B);
	}

	return teams;
}
