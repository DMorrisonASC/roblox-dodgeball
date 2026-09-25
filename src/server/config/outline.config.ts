/**
 * The character outline: whether the system runs at all, and what colour it draws.
 *
 * Server-only, and read by nothing but `OutlineService` — an outline is built on the
 * server and replicates from there, so no client ever has a reason to ask about it.
 * That is why this lives under `server/` while the shared configs sit under `shared/`.
 */
export const OUTLINE_CONFIG = {
	/**
	 * The kill switch for the whole outline system.
	 *
	 * One flag rather than a condition scattered across the service, so turning the
	 * outlines off after seeing them on a real screen is a single edit here. While it
	 * is false `applyOutline` returns before it creates anything, which is what makes
	 * "off" mean *nothing exists* rather than "something invisible exists" — an
	 * invisible highlight would still be an instance on every character to explain.
	 */
	ENABLED: true,

	/**
	 * The colour the edge is drawn in.
	 *
	 * Black, so a rig reads as its own silhouette against the arena floor. Read as the
	 * *edge* only — the fill is transparent, so this never tints the character itself.
	 */
	COLOR: Color3.fromRGB(0, 0, 0),
} as const;
