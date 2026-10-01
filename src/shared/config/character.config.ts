/**
 * How a character moves, and how long a fresh one cannot be hurt.
 *
 * A config of its own rather than a constant buried in the service, because a walk speed is the
 * kind of number that gets tuned — and because `WalkSpeedService` reads it but does not own it. The
 * spawn shield at the bottom is there for the same reason: it is a number somebody will want to
 * move, and it belongs to the rule rather than to the thing that applies it.
 */
export const CHARACTER_CONFIG = {
    /**
     * The base walk speed every character starts at, in studs per second.
     *
     * **This is a value, not Roblox's default, and the two are not the same number.** Roblox's own
     * default is 16; this used to be 16 as well, and the sentence that used to sit here said so —
     * that the point was a number named in one place rather than an implicit default a stray
     * `Humanoid.WalkSpeed = x` would silently replace. It was then raised to 20 on purpose, to
     * make the arena feel less like a lobby, and that sentence was not updated with it. Recorded
     * rather than quietly deleted: 20 is the base now, 16 is the default, and they stopped
     * agreeing deliberately.
     */
    BASE_WALK_SPEED: 20,

    /**
     * How much a sprint adds to the current walk speed, in studs per second.
     *
     * **Added, not multiplied and not set.** Sprint is one contribution among whatever else is
     * contributing — see `WalkSpeedService`, whose entire shape is a sum of named contributions —
     * so this composes with a future speed pad or slow effect instead of overwriting one. Set or
     * multiplied, sprint and any other modifier would fight, and the loser would be whichever
     * wrote last.
     *
     * The consequence worth knowing: sprinting on a surface that already slows you down still
     * adds 15 studs/s, not "75% of your current speed". At the base above that is 35.
     */
    SPRINT_SPEED_BONUS: 15,

    /**
     * The stamina pool a sprint spends, in seconds of sprinting.
     *
     * The unit is *seconds of sprint at the drain rate below* — not studs, and not an abstract
     * "stamina". At a drain of 1/s, a pool of 3 is three seconds of running, and that is the
     * figure anyone actually tunes. Moving the drain changes that duration without touching this;
     * the two only mean anything together. See
     * {@link CHARACTER_CONFIG.STAMINA_DRAIN_PER_SECOND}.
     */
    STAMINA_MAX_SECONDS: 3,

    /**
     * How fast the pool empties while sprinting, in seconds of stamina per second of sprinting.
     *
     * 1 makes the pool a plain stopwatch: {@link CHARACTER_CONFIG.STAMINA_MAX_SECONDS} seconds of
     * holding the key. Above 1 a sprint is shorter than the pool's size suggests and below 1 it is
     * longer, which is the knob to reach for when the pool's *duration* reads wrong but its
     * *size* — the bar's proportions — reads right.
     */
    STAMINA_DRAIN_PER_SECOND: 1,

    /**
     * How fast the pool refills once recovery has started, in seconds of stamina per second.
     *
     * Equal to the drain deliberately, and that is a decision rather than a coincidence. Faster
     * than the drain rewards a stutter of short taps over an honest run; slower turns every
     * sprint into a debt the player is still paying off a round later. Equal means the total is
     * conserved — what you spend is what you wait for — which is the version of this that is
     * easiest to hold in your head while it is being tuned.
     */
    STAMINA_RECOVERY_PER_SECOND: 1,

    /**
     * How long the pool sits still after the last drain, in seconds, before it starts refilling.
     *
     * **Frozen, not merely slow.** During this window the value does not move at all, which is
     * what lets the HUD be honest: it shows a pool that has stopped rather than one creeping back
     * while the mechanic still refuses to use it. It is also the only thing separating "just
     * stopped sprinting" from "still sprinting", because a sprint that has run the pool out has
     * not ended — the player is still holding the key. Without the pause a player could tap the
     * key and refill while still moving at sprint speed.
     *
     * Measured from the last *drain*, not from the last time the key was seen, and that is the
     * distinction `WalkSpeedService` documents at length: it is what makes a held key at an empty
     * pool behave the way it does.
     */
    STAMINA_RECOVERY_DELAY_SECONDS: 0.5,

    /**
     * How long a freshly spawned player cannot be hurt, in seconds.
     *
     * **One second, on every player, in every phase.** Short enough to read as a spawn grace rather
     * than a tactic, long enough to cover a body arriving before its owner can see where they are.
     * Applied by `SpawnShield`, whose comments carry the two facts that make it work: that
     * `Humanoid:TakeDamage` is refused outright while a `ForceField` is present, and that the engine
     * may put one of its own on the body that has to be taken away first.
     *
     * **The same number in the lobby and in a round, deliberately.** A player who died mid-round and
     * one who has just joined are given the same body by the same engine call, and a shield whose
     * length depended on which phase that happened in would make the two feel different for no
     * reason a player could ever learn.
     */
    SPAWN_SHIELD_SECONDS: 1,

    /**
     * The clips this game dresses a character in, per rig, as asset ids.
     *
     * **Four sets and two rigs, because those are the two axes the engine gives us.** The set names
     * — `idle`, `walk`, `run`, `jump` — are not this codebase's choosing: they are the names Roblox's
     * animation script looks its own sets up by, and they are the whole of the interface between it
     * and the controller that reads these. A body wears the id for its own rig, chosen by
     * `Humanoid.RigType` on the body being dressed, because an R6 clip never loads onto an R15 rig.
     * The pair is the shape `dodge.config.ts` already keeps for its flourish, arrived at for the same
     * reason.
     *
     * **"Walk" is the base speed and "run" is the sprint**, which is why these sit beside
     * {@link CHARACTER_CONFIG.BASE_WALK_SPEED} and {@link CHARACTER_CONFIG.SPRINT_SPEED_BONUS}: a
     * clip and a speed are one decision. An animation authored for 20 studs/s played at 35 reads as a
     * slide, and the reverse as a jog that never arrives. Which of the two sets is used *when* is
     * Roblox's business rather than ours — its script picks between them by how fast the body is
     * going — so both are claimed, with these ids.
     *
     * **An empty id is the *off* switch, and it is how a rig opts out of one set.** The controller
     * leaves that set exactly as Roblox made it, which is what the two blank R6 lines below are for:
     * only the R15 renders of idle and jump were uploaded, so an R6 body keeps the default standing
     * and jumping animations and still wears this game's walk and sprint. Blank rather than filled
     * with the R15 ids on purpose — the probe would refuse them on an R6 body anyway, and a config
     * that says what it means beats one that says something the loader is expected to reject.
     *
     * **Every id here was checked against Roblox's asset API, and the R15 column was replaced on
     * 2026-10-01 because of what that check found.** The ids that used to sit there were emotes —
     * asset type 61, owned by the groups `STUDIO KAMI` and `WONDER UGC` rather than by this game —
     * and an emote is not a clip that can be loaded as one, so an R15 body was left with two claimed
     * sets whose clips could never arrive: a character that moved with no animation at all, because
     * a claimed set is no longer falling back to Roblox's own. The controller probes every id on the
     * body that will wear it for exactly that reason, and its `DEBUG` output names the rig it read.
     *
     * **Quoted with the `rbxassetid://` prefix and never as a bare number.** The loader treats a
     * bare number as a name and finds nothing, which is the trap the dodge ids record at length.
     */
    IDLE_ANIMATION_R6: "",
    IDLE_ANIMATION_R15: "rbxassetid://109708134574404",

    WALK_ANIMATION_R6: "rbxassetid://71443035611308",
    WALK_ANIMATION_R15: "rbxassetid://136049554497965",

    RUN_ANIMATION_R6: "rbxassetid://138082827258827",
    RUN_ANIMATION_R15: "rbxassetid://112953741427605",

    JUMP_ANIMATION_R6: "",
    JUMP_ANIMATION_R15: "rbxassetid://108854279734771",
} as const;
