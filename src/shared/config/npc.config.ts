/**
 * Everything about the NPCs: the rigs the game drives itself, rather than the
 * ones a player controls.
 *
 * Imports nothing. Read on the server alone — nothing an NPC does is visible to
 * the client before it happens, because an NPC has no client to tell.
 */
export const NPC_CONFIG = {
	/**
	 * How long a rig with the respawn behavior stays down before it gets up, in
	 * seconds.
	 *
	 * Read by `RespawnBehavior` alone, and the delay is the whole reason that
	 * behavior has a timer in it: a rig that stood up on the frame it was killed
	 * would be a rig that never appeared to die, and there is nothing to learn from
	 * a target that cannot be knocked down. Long enough to read as a death, short
	 * enough that a test is not waiting on it.
	 */
	RESPAWN_DELAY_SECONDS: 3,

	/**
	 * How often a rig's network ownership is re-asserted, in seconds.
	 *
	 * **Ownership is the one thing about a rig that something other than this project can change.**
	 * `SetNetworkOwner` with no argument makes the server the owner, which is what a rig needs — the
	 * server is the machine driving every `MoveTo` a rig makes, and the one measuring the speed its
	 * animation is chosen from — but the engine also *assigns* ownership automatically by proximity.
	 * A rig that has had it taken is a rig whose physics is being simulated by whichever client is
	 * nearest, and the symptoms are a rig that jitters underfoot and a `MoveTo` that stops arriving:
	 * exactly when a player is close enough to be watching. `GetNetworkOwnershipAuto` is the engine's
	 * own statement that the decision can be automatic, which is why this is a re-check rather than
	 * one call at spawn.
	 *
	 * **Five seconds, and it is cheap enough not to be clever about.** The check is one
	 * `GetNetworkOwner` per rig per interval, inside a loop that already runs several times a second
	 * per rig, and what it is protecting is a walk and a destination.
	 *
	 * **Placeholder.**
	 */
	NETWORK_OWNERSHIP_RECHECK_SECONDS: 5,

	/**
	 * How many rigs `RigSpawnerService` puts on **each side**, so a spawn is this many a side and
	 * `RIGS_PER_TEAM × 2` rigs in total. **Placeholder — 2.**
	 *
	 * **The number a rig count has to be argued against is `MATCH_MAX_PER_TEAM` (4), because a rig is
	 * standing in for a player rather than beside one.** A match is up to 4v4, so eight rigs would fill
	 * both sides completely — and a side that already *looks* full is the opposite of what a stand-in is
	 * for. The whole point of a rig is to make an empty lobby look alive and then get out of the way when
	 * a person arrives, so the count has to leave visible room. **Two a side leaves two human slots a
	 * side**: enough for a match to grow into, small enough that the first player to join is clearly
	 * outnumbered by a side rather than lost in one, and enough rigs facing each other that the aimed
	 * throw has somebody to throw at.
	 *
	 * **A count per side rather than a total**, because the spawner gives each rig its side outright —
	 * `NpcService.spawn` takes a team — so "how many a side" is the number that is actually being chosen.
	 * A total would leave the split to the gather behaviour's alternation, which is a rule about filling
	 * pads rather than a decision about team sizes.
	 */
	RIGS_PER_TEAM: 2,
} as const;
