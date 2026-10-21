/**
 * The spectator kill cam: where the camera sits while the local player is waiting for a body, and how it
 * follows the body that killed them.
 *
 * **Shared rather than client-only, for `ring.config.ts`'s reason**: it is read by one client file today, but
 * every number in it is a *feel* number that gets tuned from a session, and the project keeps those in one
 * folder so that "how long is the wait" and "how far back is the camera" can be found in the same place. The
 * camera itself is `client/killCam.ts`.
 *
 * **Nothing here is a duration of the respawn.** How long the camera holds is `RESPAWN_AT_ATTRIBUTE`, which the
 * server publishes; this file only says how long to *wait* for that number to appear and how long to give a body
 * that is late. See {@link KILL_CAM_CONFIG.HAND_BACK_GRACE_SECONDS}.
 */
export const KILL_CAM_CONFIG = {
	/**
	 * Whether the kill cam runs at all. **Placeholder — on.**
	 *
	 * Off means nothing is bound and nothing is subscribed: no render step, no camera write, and the death screen
	 * is Roblox's own. The same reading `RING_CONFIG.ENABLED` and `OUTLINE_CONFIG.ENABLED` get.
	 */
	ENABLED: true,

	/**
	 * Where the camera sits relative to the killer, **in world space rather than in the killer's own frame**.
	 * **Placeholder — 12 studs south, 6.5 up.**
	 *
	 * **A world-space offset rather than one behind the killer's back, and the choice is about rigs.** A rig turns
	 * on the spot constantly — every windup and every seek step reorients it — so a camera anchored to its *facing*
	 * swings the whole shot every time it turns to throw, which reads as the camera being yanked rather than as
	 * the killer moving. A world-space offset keeps the camera's compass position fixed and only translates it,
	 * so what moves on screen is the killer, which is the thing worth watching.
	 *
	 * **What it costs, stated rather than discovered**: the shot may be from the front or from behind depending on
	 * which way the killer happens to face, and a wall between the two can hide them. That is the price of a shot
	 * that does not swing; the alternative — orbiting, or snapping to over-the-shoulder — is a different feature
	 * and would want its own tuning.
	 *
	 * The `Y` component is the *height above the killer's root*, so it is a boom angle as well as a distance:
	 * higher reads more as a watching shot, lower puts the camera in the fight.
	 */
	OFFSET: new Vector3(0, 6.5, 12),

	/**
	 * How far above the killer's root the camera looks, in studs. **Placeholder — 2.5, i.e. about chest height.**
	 *
	 * **Looking at the root itself frames the feet.** `HumanoidRootPart` sits at the body's centre of mass, which
	 * is waist height on either rig — so a camera aimed at it puts the killer in the lower half of the screen and
	 * the arena above them. This raises the aim point to something a viewer reads as a person.
	 */
	LOOK_HEIGHT: 2.5,

	/**
	 * How fast the camera catches up to the killer, in "e-folds per second". **Placeholder — 6.**
	 *
	 * **Frame-rate independent by construction**: the step uses `1 - exp(-rate * dt)`, so a client at 30 fps and
	 * one at 144 fps travel the same fraction of the remaining gap per second rather than per frame. A plain
	 * `Lerp(0.1)` would be twice as fast on the faster machine, which is the usual way a smooth follow is tuned
	 * on one device and wrong on another.
	 *
	 * Higher is tighter — nearer a hard lock, and it shows every twitch of a killer's strafing. Lower is a lazier
	 * drift and lets the killer run to the edge of the frame. This keeps a running killer inside the shot without
	 * making the camera look welded to them.
	 */
	FOLLOW_RATE: 6,

	/**
	 * How long to wait for `RESPAWN_AT_ATTRIBUTE` to appear after the local `Humanoid.Died`, in seconds.
	 * **Placeholder — 0.5.**
	 *
	 * **The attribute is the server's and it is written a frame or two after the death.** `Died` fires on this
	 * client at the instant the humanoid's health reaches zero; `RespawnService.schedule` is called by the server
	 * a round trip later, and *that* is what publishes the deadline. So a cam that read the attribute on the death
	 * frame would find nothing and conclude there was no respawn coming — on a local server it would work and on a
	 * live one it would silently never start, which is the worst kind of difference to ship.
	 *
	 * **A window rather than a fixed wait**: the death is only a *candidate* — an elimination hands the body back
	 * with no deadline at all — so this is how long the cam stays undecided before giving the death to Roblox's
	 * own camera. Half a second is several round trips and still shorter than any wait a player would notice.
	 */
	PENDING_TIMEOUT_SECONDS: 0.5,

	/**
	 * How long the camera may hold past the deadline while no new body has arrived, in seconds.
	 * **Placeholder — 2.**
	 *
	 * **The belt for the one case the deadline cannot describe: a body that never comes.** The hand-back is
	 * written to fire on the frame the *new body exists*, not on the frame the clock runs out — see
	 * `client/killCam.ts` — so something has to be able to end the shot if the body does not arrive at all (the
	 * server's load failing, the round ending into a path that leaves the player bodiless, or a client that
	 * somehow missed the arrival). Without this the player would be left looking at somebody else's fight with no
	 * camera of their own, which is a stuck client rather than a broken shot.
	 *
	 * **It is not a respawn duration and must not become one.** At two seconds it is several times shorter than
	 * the longest wait in the game and it never fires in the ordinary case, which is the only property it needs.
	 */
	HAND_BACK_GRACE_SECONDS: 2,
};
