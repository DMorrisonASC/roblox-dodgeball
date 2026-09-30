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
 * **One member, and that is the shape rather than the state of a plan.** The union is what the rest
 * of this feature is written against: `"MultiBall"` and `"Freeze"` become one line each when they are
 * built, and nothing here is built for them in advance. `GameModeId` makes the same point about
 * modes — the union names everything the game intends to have, while what can actually be *used* is
 * decided by the code that exists.
 */
export type AbilityKind = "Pierce";

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
