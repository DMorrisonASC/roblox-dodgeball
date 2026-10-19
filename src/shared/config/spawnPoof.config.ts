/**
 * The poof a body leaves behind whenever it appears, disappears or is moved without walking.
 *
 * **One switch, because the effect has one lifetime and one look.** The template owns how long the particles
 * live; `EFFECT_LIFETIME` in `server/vfx/spawnPoof.ts` owns how long the clone is kept, which is a backstop
 * rather than a tuning knob. What is left here is the only question a reviewer actually asks — whether a
 * boundary is allowed to make the burst at all.
 */
export const SPAWN_POOF_CONFIG = {
	/**
	 * Whether a body spawns a `SpawnPoof` clone at all. **Placeholder — creation switch.**
	 *
	 * **Off means no clone is made** — not one made and hidden — which is `BALL_CONFIG.TRAIL_ENABLED`'s
	 * reading and the reason the switch can be used to rule the feature out entirely. With it off, a boundary
	 * is exactly the boundary that existed before the effect: every body moved in one server frame, with the
	 * round's wipe as the only cover, and joins and leaves as instant as they used to be.
	 */
	ENABLED: true,

	/**
	 * Whether the clone's carrier is **drawn** as a bright cube instead of hidden. **Placeholder — diagnostic,
	 * on for one run and then off.**
	 *
	 * **This exists because "I see nothing" has two completely different causes and no way to tell them apart
	 * from a log.** Either the clone is not where the player is looking — wrong time, wrong place, behind the
	 * round's wipe — or the clone is there and the *template* draws nothing (a particle `Size` of zero, a
	 * `Transparency` sequence that is `1` at both ends, a texture that is not an image). The first is this
	 * file's bug, the second is a Studio fix, and until something marks the position both look identical: a
	 * still frame with no effect in it.
	 *
	 * **With this on, a red neon cube appears wherever a poof fires.** If it appears and the particles do not,
	 * the code path, the position and the timing are all correct and the template is the fault. If no cube
	 * appears, the effect is firing somewhere the player cannot see and the question becomes a place and a
	 * moment rather than a property.
	 *
	 * **Turn this off before shipping.** It draws a box on every body at every boundary, which is exactly the
	 * thing `Transparency = 1` exists to prevent.
	 */
	DEBUG_SHOW_PART: false,
} as const;
