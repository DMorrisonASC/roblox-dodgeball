import { AbilityKind } from "../ability";

export const IMAGES_CONFIG = {
	/**
	 * The loading screen logo.
	 *
	 * **Placeholder.** Untuned in the sense that the asset is not yet uploaded;
	 * replace with the real `rbxassetid://…` when it is.
	 */
	LOADING_LOGO: "rbxassetid://105758313826117",

	/**
	 * The icon for each power, keyed by its {@link AbilityKind}.
	 *
	 * **A `Record<AbilityKind, string>` rather than a list of pairs, and the shape is the point.** It is
	 * the trick {@link ABILITY_NAMES} and `isBallAbility` play, for the same reason and the same cost:
	 * adding a fourth power to the union without deciding what it looks like is a **compile error** rather
	 * than a HUD that draws an empty box and says nothing about why. A `Map` or an array of pairs would
	 * take the fourth member silently, which is exactly the failure a keyed record makes impossible.
	 *
	 * **Here rather than in `shared/ability.ts`, and the split is by machine.** That file is the
	 * *vocabulary* — what the words are, which of them a ball can carry — and it is read by the server,
	 * which has no opinion about pictures. This file is the first thing in the project that is purely a
	 * presentation fact, and it is the file the loading logo already lives in, so an image id goes with
	 * the other image ids. A fourth power therefore costs **one line in each file**, which is the smallest
	 * version of "one place a typo can be found, one place to add a power".
	 *
	 * **Not `Placeholder.` in the sense that file's other entry uses.** These are the ids the task
	 * supplied rather than guesses, so the thing that is unverified about them is not their spelling but
	 * their *art*: whether three icons at the size the HUD draws them are tellable apart at a glance, and
	 * whether each reads as its own power rather than as a colour. That is a question for a screen, not
	 * for this file.
	 */
	ABILITY_ICONS: {
		Pierce: "rbxassetid://90018903991874",
		MultiBall: "rbxassetid://100512953749470",
		Freeze: "rbxassetid://124121329693569",
	} as Record<AbilityKind, string>,
} as const;