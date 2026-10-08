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
	 *
	 * **This record is also the HUD's reveal list, and a new entry joins both at once.** When a box is
	 * collected, `SuperHudController` spins the slot through *every* value here — including powers the
	 * player does not own — before settling on the one that was granted, so the tease shows a player what
	 * they are missing. It walks this record rather than the roster, which means an entry added here is in
	 * the reveal with no code change anywhere: the same one-line-per-file cost this doc opens with, now
	 * paying for two features instead of one.
	 *
	 * **And the asset-side trap, which lives here because it is a fact about these icons.** The art is drawn
	 * at the artist's size — the sources in `assets/icons/` are 1254px square — and the slot is 56px, so an
	 * icon is resampled down by over twenty times on the way to the screen, blending every edge pixel with its
	 * neighbours. **What each pixel carries matters, and the transparent ones are not exempt from it:** Roblox
	 * documents that fully transparent pixels are *set to black* when an image is uploaded, and the RGB a file
	 * gives them is what shows wherever the platform composites rather than blends. That is how the first three
	 * files here — exported with **no alpha channel at all** (`Format24bppRgb`, 100% opaque, corners
	 * RGB(253,253,253)) — drew a white box around every icon in a slot that is otherwise empty.
	 *
	 * **The channel itself is never the problem — the upload keeps it, measured.** A converted file
	 * (`freeze-ball-AI.png`, `Format32bppArgb`, corners at alpha 0) comes back from Roblox as
	 * `Format32bppArgb` with **51% of its pixels fully transparent** and a fully transparent corner, so an
	 * icon whose *file* has alpha is drawn with alpha. What a flattened export costs is therefore the whole
	 * box, not the edges: the icon is a white rectangle the size of the slot, and no property in this client
	 * can take it away — which is what made it look like a HUD fault for a while. **Check the file first:
	 * `Format24bppRgb` on the source is the whole answer.**
	 *
	 * **The well is `theme.colors.trough`, which is `Palette.text.primary` — black — and that is the whole
	 * reason a black transparent field is invisible here.** The same art carrying the same field shows a black
	 * box on any light surface, the shop's tiles included, so "make the transparent pixels black" is a
	 * coincidence that happens to work in one place rather than a rule. What a new icon needs is a PNG that
	 * keeps its **alpha channel**, and then an **alpha-bleed pass** (which writes the nearest opaque colour
	 * into the transparent pixels) if the art will ever sit anywhere but this well — that is the version that
	 * stops depending on what is behind it, and it is what `freeze-ball-AI.png` will want the first time an
	 * icon is drawn on something light. Neither is a code change: a lighter well would be a different HUD, not
	 * a fixed icon.
	 */
	ABILITY_ICONS: {
		Pierce: "rbxassetid://123770600402345",
		MultiBall: "rbxassetid://71990881669180",
		Freeze: "rbxassetid://77366088183630",
	} as Record<AbilityKind, string>,
} as const;