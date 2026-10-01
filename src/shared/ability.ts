import { BALL_ABILITY_ATTRIBUTE } from "./constants";

/**
 * The vocabulary of super abilities, shared by the server that hands them out and the client that
 * shows which one is loaded.
 *
 * **Ids and names only, for the reason `shared/gameMode.ts` gives about modes.** What an ability
 * *does* is a server-side question — `BallComponent` is where the one that exists is implemented —
 * and the client has no business deciding anything about it. All the client needs is a stable id to
 * read back and a name to print, and both of those are strings.
 *
 * **Three members, and they do not all live in the same place — which is why this file cannot say where
 * any of them is stored.** `"Pierce"` and `"Freeze"` are properties of a *ball*: the mark rides the
 * throw and decides what that ball does. `"MultiBall"` is a property of a *player*: a timed window that
 * supplies balls to a hand, and nothing about a thrown ball carries it at all. What the union names is
 * the vocabulary, and what an ability *is* — a mark, a buff, or something neither of those words fits —
 * is decided by the code that implements it.
 *
 * **A fourth becomes one line here when it is built**, and nothing is built for it in advance —
 * `GameModeId` makes the same point about modes, while what can actually be *used* is decided by the
 * code that exists. Two files will refuse to compile until it is placed: {@link ABILITY_NAMES} wants a
 * name for it, and `BALL_ABILITIES` wants an answer to whether a ball can carry it.
 */
export type AbilityKind = "Pierce" | "MultiBall" | "Freeze";

/**
 * What each ability is called on screen.
 *
 * The one place an ability is named, so a HUD, a print and a refusal all say the same word. A
 * `Record<AbilityKind, string>` rather than a list of pairs, so adding a member to the union without
 * naming it is a compile error rather than a label that reads `nil` — the choice `GAME_MODE_NAMES`
 * makes, for the same reason.
 */
export const ABILITY_NAMES: Record<AbilityKind, string> = {
	Pierce: "Pierce",
	MultiBall: "MultiBall",
	Freeze: "Freeze",
};

/**
 * Whether `value` is an ability this build knows the *name* of.
 *
 * Says nothing about whether the ability can be used — this is only the check that turns a string off
 * the wire into an `AbilityKind` at all, which is what stops an arbitrary string being written onto a
 * ball. The shape of `isGameModeId`, for its reason: a client may legitimately name an ability nobody
 * has written yet, and the refusal belongs at the reader rather than at the sender.
 */
export function isAbilityKind(value: string): value is AbilityKind {
	return ABILITY_NAMES[value as AbilityKind] !== undefined;
}

/**
 * Which abilities a ball can carry.
 *
 * **Not the same list as the abilities that exist, and the distinction is now load-bearing.** The
 * mark remote takes an arbitrary string and writes it onto a *ball*, so with more than one ability in
 * the vocabulary that remote has to be able to answer "is this the kind of ability a ball can hold"
 * as well as "is this an ability" — otherwise a client can send the word for a player-level buff and
 * have it written onto a ball as though a ball could be one. See `BallService.markHeldBall`, which is
 * the only reader that hands out consequences.
 *
 * **A `Record<AbilityKind, boolean>` rather than a list of the true ones**, so that adding a member
 * to the union without saying where it lives is a compile error rather than an ability nobody can
 * place. The trick {@link ABILITY_NAMES} plays for the label, for the same reason and the same cost.
 */
const BALL_ABILITIES: Record<AbilityKind, boolean> = {
	Pierce: true,
	MultiBall: false,
	Freeze: true,
};

/**
 * Whether `value` names an ability a ball can carry.
 *
 * The check made of what arrives on the mark remote, where {@link isAbilityKind} is not enough on its
 * own: naming an ability and being allowed to put it on a ball are two questions, and the wire can
 * only be trusted for the first.
 */
export function isBallAbility(value: string): value is AbilityKind {
	return isAbilityKind(value) && BALL_ABILITIES[value];
}

/**
 * The ability `ball` is carrying, or nothing.
 *
 * **The one reader of the attribute, so the empty case is decided in one place.** A ball with no
 * ability carries `""` — the convention `ThrowerId` already uses, and what `BallService` writes when
 * a ball comes back into a hand — and a ball that is not there at all is the same answer as a ball
 * carrying nothing. That is exactly what every caller wants to ask: "is this a Pierce ball, or is it
 * an ordinary one".
 *
 * Answers `undefined` for a string this build does not name, which is the safe direction to be wrong
 * in: a ball carrying a word from a newer build flies as an ordinary ball rather than as something
 * this build would have to guess at implementing.
 */
export function abilityOn(ball: Instance | undefined): AbilityKind | undefined {
	const value = ball?.GetAttribute(BALL_ABILITY_ATTRIBUTE);
	if (!typeIs(value, "string") || value === "") return undefined;

	return isAbilityKind(value) ? value : undefined;
}
