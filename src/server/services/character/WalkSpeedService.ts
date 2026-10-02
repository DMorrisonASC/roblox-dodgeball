import { OnStart, Service } from "@flamework/core";
import { Players, RunService } from "@rbxts/services";
import { STAMINA_ATTRIBUTE } from "shared/constants";
import { CHARACTER_CONFIG } from "shared/config/character.config";
import { events } from "shared/networking";

/**
 * The key a model's *base* speed is stored under.
 *
 * A named key rather than a single number per model, because that is the design: the base is not
 * privileged — it can be replaced and removed like any other contribution — it is only the one every
 * entry is *created* with. That second half is load-bearing rather than tidy. The sum is what the
 * Humanoid is handed, so an entry with nothing in it is a character that cannot move at all, which
 * is never wanted and is not something a speed effect should be able to reach by accident. See
 * {@link WalkSpeedService.entryFor}.
 */
const BASE_KEY = "Base";

/**
 * Prints every write to a model's walk speed, with the contributions it was summed from.
 *
 * On by default, unlike the per-frame diagnostics elsewhere, because this is not a per-frame log: it
 * fires on a spawn, a death, and each end of a sprint — a handful of lines a round. It is also the
 * only thing that can answer "why is this character not moving" from the output, and that question
 * has already cost a session with nothing to look at: a written speed of `0` is a frozen character,
 * and the numbers in brackets say whether a base was there to be summed or whether the entry was
 * empty.
 */
const DEBUG = true;

/**
 * The name sprint's contribution is stored under.
 *
 * A named contribution rather than a bare number, because that map *is* the speed: `"Sprint": 15`
 * alongside `"Base": 20` is the whole of how sprint changes anything, and ending the sprint is the
 * removal of this key. One key is enough because there is only ever one sprint per body — a second
 * key would be for a second, independent reason for the same bonus.
 */
const SPRINT_KEY = "Sprint";

/**
 * How often the stamina pool is written to {@link STAMINA_ATTRIBUTE}, in seconds.
 *
 * Ten writes a second, which is the rate the HUD's bar was built to read: a three-second pool in ten
 * a second steps is thirty steps of a hundred-and-twenty-pixel bar, so the movement reads as movement
 * rather than as a staircase, and a fifth of a pixel is finer than the bar can draw.
 *
 * **A throttle rather than a write per frame, and the reason is that nothing else is watching.** The
 * attribute exists for one HUD on the local client; sixty writes a second would put the same number
 * on the wire sixty times to move a bar a fraction of a pixel, and every one of them would be a
 * replication. The pool still *drains* per frame — only the publishing is coarse — so the value the
 * server acts on is exact and only the value the client displays is sampled.
 */
const PUBLISH_INTERVAL_SECONDS = 1 / 10;

/** One player's sprint, as the server holds it. */
interface SprintState {
    /** Seconds of sprinting left. Starts at {@link CHARACTER_CONFIG.STAMINA_MAX_SECONDS}. */
    stamina: number;

    /** Whether the client last said the key was down. See {@link WalkSpeedService.setSprinting}. */
    active: boolean;

    /**
     * Whether the speed bonus is applied to the current character.
     *
     * The *decision*, not the application: a player can be sprinting with no character to sprint
     * with, which is what it means to hold the key through a death. Kept so the modifier is touched
     * only when the answer changes rather than on all sixty ticks a second, and so a body arriving
     * later knows whether it should have the bonus. See {@link WalkSpeedService.trackPlayer}.
     */
    sprinting: boolean;

    /**
     * `os.clock` seconds at the last tick that actually drained the pool.
     *
     * **The recovery pause is measured from this, and that is a real distinction.** Not from the last
     * time the key was seen, and not from the last tick: a tick in which nothing drained is not a
     * tick in which the player was sprinting, so letting it reset the pause would mean the pause never
     * elapses while the pool sits at zero. See {@link WalkSpeedService.step} for what measuring from
     * the last drain actually produces there.
     */
    lastDrainAt: number;

    /** `os.clock` at the last write to the attribute, for the throttle. */
    publishedAt: number;

    /** The value last written, so an unchanged pool is never written twice. Starts impossible. */
    published: number;
}

/**
 * The one authority for how fast a character can walk, and for the sprint that changes it.
 *
 * **Nothing else in the game should write `Humanoid.WalkSpeed`.** A direct write is a value, and the
 * moment two systems write one value the last one wins and the other's intent is gone — turn a
 * speed potion on and off and a naive implementation leaves the character at potion speed for ever,
 * because the potion wrote over the base rather than adding to it. So the contributions stay separate
 * and the value is derived, and removing any one of them restores the rest.
 *
 * **Sprint lives in this file rather than in a service of its own, and that is a correction rather
 * than a preference.** It was split out on the grounds that this file "does not know what a Player
 * is" — which was true, and which turned out to be a property nothing was paying for, since
 * {@link setBaseSpeed} is only ever called for a player's character. What the split actually bought
 * was **two `CharacterAdded` handlers**, one here and one there, with no way for either to know which
 * order it ran in. That is a real conflict even though only one of them ever wrote the value: a
 * sprint re-applied to a body that had just replaced another could land *before* the base was set, so
 * the entry it created had no base in it — see {@link entryFor} for what that cost. One handler that
 * does both, in one known order, is the fix.
 *
 * The cost is worth naming: this is now two things — a sum of contributions, and one stateful
 * mechanic that feeds it. It is still one *concern*, which is how fast this body moves, and the
 * alternative was two owners of that concern. If a second modifier ever arrives it should come in the
 * same way: named contributions, applied from {@link trackPlayer}, re-applied to a new body by the
 * same handler that sets the base on it.
 */
@Service()
export class WalkSpeedService implements OnStart {
    /**
     * Every tracked model, and the named contributions to its walk speed.
     *
     * Keyed by the model itself rather than by a name or a user id, so a `Player` and an NPC rig go
     * through the same path and neither needs a lookup table of its own. A model is dropped from
     * this map when its Humanoid dies or the model is destroyed — see {@link entryFor}.
     */
    private readonly speeds = new Map<Model, Map<string, number>>();

    /**
     * Every player's sprint, keyed by the player rather than by their character.
     *
     * **A pool belongs to a person, not to a body.** A character is replaced on every death, and a
     * stamina pool that reset with it would hand out a fresh sprint for dying — the same reason
     * `DODGE_READY_AT` and the throwing preference live on the player. Keying on the player is also
     * what makes the sprint survive a respawn with nothing having to notice: the pool is not touched
     * by one, and the *contribution* is put back on the new body by {@link trackPlayer}.
     */
    private readonly sprints = new Map<Player, SprintState>();

    public onStart(): void {
        // The wire is untyped, so the handler's `active: boolean` describes an intention rather than
        // a guarantee — `shared/networking.ts` says as much about `castVote`, and this is the same
        // situation. The check is in {@link setSprinting}.
        events.Server.OnEvent("setSprinting", (player, active) => this.setSprinting(player, active));

        Players.PlayerAdded.Connect((player) => this.trackPlayer(player));

        // ...and anyone already here. A player who joined before this service started would never
        // fire `PlayerAdded`, which is the normal case in Studio when the server script reloads
        // under an existing session rather than starting a fresh one.
        for (const player of Players.GetPlayers()) {
            this.trackPlayer(player);
        }

        Players.PlayerRemoving.Connect((player) => this.sprints.delete(player));

        // **A heartbeat with the engine's own delta, not a one-second loop.** A three-second pool
        // sampled once a second is three samples, and the recovery pause is a quarter of one of them
        // — the mechanic would be a different mechanic from the one the numbers describe. The delta
        // is the argument the engine hands the signal, so the drain is exact however long a frame
        // took, which is the same reason `Trajectory` integrates by step rather than assuming a rate.
        RunService.Heartbeat.Connect((dt) => this.onHeartbeat(dt));

        if (DEBUG) print(`[Sprint] up — LeftShift/M, ${CHARACTER_CONFIG.STAMINA_MAX_SECONDS}s pool`);
    }

    /**
     * Set a model's base walk speed, replacing any base it already had.
     *
     * Works identically for a player's character and an NPC rig — it is the same call, and the caller
     * does not have to know which it has. Calling it twice for the same model is safe: the base is
     * overwritten, not added to.
     */
    public setBaseSpeed(model: Model, speed: number): void {
        const humanoid = model.FindFirstChildOfClass("Humanoid");

        // Graceful, and deliberately silent: a model with no Humanoid has nowhere for a walk speed
        // to go, so nothing is stored for it either — no entry, nothing to clean up later. Called on
        // a decorative prop this is a no-op rather than a leak.
        if (!humanoid) return;

        this.entryFor(model, humanoid).set(BASE_KEY, speed);
        this.recalculateSpeed(model, humanoid);
    }

    /**
     * Add or replace a named contribution to a model's speed.
     *
     * **The key is the identity, not the caller.** Two systems adding under one key are one
     * contribution and the second wins, which is the wrong shape for two independent effects and the
     * right shape for a single system that changes its mind — so a caller that can contribute twice
     * at once should use two keys. Sprint uses one key and re-adds it, because there is only ever one
     * sprint.
     *
     * A model with no `Humanoid` stores nothing at all, exactly as {@link setBaseSpeed} does. So a
     * contribution added while a character is dead is simply not there, and the caller has to add it
     * again when the body comes back — which is the honest reading of "this body is not in the
     * world", but it is a property the caller has to know about rather than a detail they can
     * ignore. See {@link trackPlayer}, which re-applies the sprint's contribution on `CharacterAdded`
     * for exactly that reason — in the same handler, and in the same order, that sets the base.
     *
     * Nothing is clamped or validated here: the clamp is in {@link recalculateSpeed}, where it
     * applies to the sum rather than to any one contribution — a single contribution cannot know
     * whether it is the one that took the total below zero.
     */
    public addModifier(model: Model, key: string, speed: number): void {
        const humanoid = model.FindFirstChildOfClass("Humanoid");
        if (!humanoid) return;

        this.entryFor(model, humanoid).set(key, speed);
        this.recalculateSpeed(model, humanoid);
    }

    /**
     * Drop a named contribution, leaving every other one exactly as it was.
     *
     * Removing a key that was never added is a no-op, and so is removing one from a model that has
     * no entry. That is deliberate rather than lenient: {@link addModifier} refuses a model with no
     * `Humanoid`, so a caller that cancels an effect has to be able to cancel one that was never
     * accepted without first working out whether it was. Without this the caller would have to
     * remember a refusal it was not told about.
     *
     * The contribution is deleted *before* the write is attempted, so a model that has lost its
     * Humanoid still stops contributing. Only the write is skipped.
     *
     * The base is not special here — it can be removed like anything else. It is not the base's job
     * to be permanent; it is only the one key every model happens to have, and a "you cannot remove
     * the base" rule would be a second kind of key for every reader to keep track of.
     */
    public removeModifier(model: Model, key: string): void {
        const existing = this.speeds.get(model);
        if (!existing) return;

        existing.delete(key);

        const humanoid = model.FindFirstChildOfClass("Humanoid");
        if (!humanoid) return;

        this.recalculateSpeed(model, humanoid);
    }

    /**
     * A model's contributions, creating — and watching — them on first use.
     *
     * The watching is here rather than in the constructor because it is the same event: the first
     * time a model is tracked is the first time there is anything to forget. A Humanoid's `Died` is
     * the common case, and `Destroying` on the model covers everything else — a character removed
     * while still alive, a player leaving, a rig despawned by a script — which would otherwise leave
     * an entry in the map for the lifetime of the server.
     */
    private entryFor(model: Model, humanoid: Humanoid): Map<string, number> {
        const existing = this.speeds.get(model);
        if (existing) return existing;

        // **The base goes in here, at creation, rather than being something a caller has to have
        // arranged first.** Without this, "the entry exists" and "the entry has a base" are two
        // different facts, and the second one used to depend on the order two `CharacterAdded`
        // handlers ran in — one in this service, one in the `SprintService` that used to sit beside
        // it. {@link setBaseSpeed} and {@link WalkSpeedService.addModifier} could both be the first
        // thing to touch a body, so a sprint applied to a body that had just replaced another could
        // create an entry containing `Sprint` and nothing else. Ending that sprint then deleted the
        // only key, summed an empty map, and wrote `WalkSpeed = 0`: a character that could not move
        // in any direction, with nothing in the output to say why, until the next respawn happened to
        // put a base back.
        //
        // That ordering is gone — both halves are one handler now, see the class comment — and this
        // stays anyway, because the invariant is worth having rather than worth checking. Any model
        // given a contribution before its base is a model whose sum is short by a base, and an empty
        // entry is a body that cannot move at all. Seeded from the same config {@link setBaseSpeed}
        // is called with, so this changes no value; `setBaseSpeed` overwrites it immediately either
        // way, which is what leaves a caller free to set a different one.
        const entry = new Map<string, number>();
        entry.set(BASE_KEY, CHARACTER_CONFIG.BASE_WALK_SPEED);
        this.speeds.set(model, entry);

        humanoid.Died.Connect(() => this.forget(model));
        model.Destroying.Connect(() => this.forget(model));

        return entry;
    }

    /**
     * Sum every contribution and write the result to the Humanoid.
     *
     * **The sum is the entire reason for the map, and it is what makes a power-up a one-line change.**
     * A model has whatever contributions have been added to it, and sprint is now the second thing
     * that has ever added one:
     *
     *     Base: 20                          ->  20
     *     Base: 20, Sprint: 15              ->  35
     *
     * ...and ending the sprint is `removeModifier(model, "Sprint")`, which leaves the base exactly as
     * it was. Neither contribution can lose the other — which is the whole difference between adding
     * to a speed and overwriting one, and the reason the sprint at the bottom of this file goes
     * through the same two calls any other modifier would rather than writing `Humanoid.WalkSpeed`
     * itself.
     *
     * **This comment changed when sprint landed, and the old wording is worth recording.** It used to
     * describe a hypothetical speed potion and to say outright that `addModifier` and `removeModifier`
     * did not exist yet, offering itself as their specification. They exist now, sprint is their
     * caller, and the figure in the example is the real base from `CHARACTER_CONFIG` rather than the
     * Roblox default it used to be — so there is nothing left here that is not true of the running
     * code, which is the only state a comment like this is allowed to be in.
     */
    private recalculateSpeed(model: Model, humanoid: Humanoid): void {
        const entry = this.speeds.get(model);
        if (!entry) return;

        let total = 0;
        entry.forEach((value) => {
            total += value;
        });

        // Clamped at zero. A pile of slow effects could sum below it, and a negative `WalkSpeed` is
        // not "not moving" — Roblox reads it as a nudge backwards, which is how a debuff ends up
        // walking a character in the wrong direction.
        humanoid.WalkSpeed = math.max(0, total);

        // What it was set to, and out of what. This is the line to read when a character will not
        // move: `0 ()` is an entry with nothing in it, which is a bug here, and `0 (Base:20)` would
        // mean the base itself had been set to nothing. Rebuilding the string rather than logging the
        // map because an attribute-shaped table prints as a pointer, which is no use in a log.
        if (DEBUG) {
            const parts: string[] = [];
            entry.forEach((value, key) => parts.push(`${key}:${value}`));

            print(`[Walk] ${model.Name}: ${humanoid.WalkSpeed} (${parts.join(" ")})`);
        }
    }

    /** Drop a model's contributions. */
    private forget(model: Model): void {
        this.speeds.delete(model);
    }

    /**
     * Everything that has to happen when a player's body appears: the base, and the sprint over it.
     *
     * **A character is a new model each time**, so neither can be done once: the Humanoid tuned a
     * moment ago is destroyed with the body it belonged to. Hence the signal rather than a single
     * call, and hence the immediate check as well — a player who joined before this service started
     * already has a character that will never fire `CharacterAdded` again.
     *
     * **Both halves are one handler, in one order, and that is the point of the arrangement rather
     * than a style preference.** The base is set first and the sprint is applied on top of it second,
     * so the sum is never briefly short by a base. That is the bug the old two-service layout could
     * produce; see the class comment for it.
     *
     * The sprint is re-applied whether or not the pool has anything in it. A player holding the key
     * through a death asked to sprint, and {@link step} takes it off them on the next tick if the pool
     * says no — deciding it here as well would be the same question answered in two places.
     */
    private trackPlayer(player: Player): void {
        // Guarded because the pool is *state* and this is not idempotent in the way the rest of the
        // method is: a second call must not hand a player a fresh pool. The character work below
        // would be harmless twice over; this would not.
        if (!this.sprints.has(player)) {
            this.sprints.set(player, {
                stamina: CHARACTER_CONFIG.STAMINA_MAX_SECONDS,
                active: false,
                sprinting: false,
                // Zero rather than a reading of the clock. It is only ever compared as "how long
                // since", and the pool starts full, so a recovery interval that has not elapsed
                // cannot be observed: refilling a full pool is a no-op whatever this says.
                lastDrainAt: 0,
                publishedAt: 0,
                published: -1,
            });

            // Published here rather than waiting for the first tick, so the HUD has an answer from
            // the moment the player exists rather than a missing attribute for a frame.
            player.SetAttribute(STAMINA_ATTRIBUTE, CHARACTER_CONFIG.STAMINA_MAX_SECONDS);
        }

        // One closure for both paths — the signal and the player who is already here — so a body is
        // prepared the same way whichever route it arrived by. Two copies of this would be two orders
        // to keep in step, which is the mistake this file has already made once.
        const prepare = (character: Model) => {
            this.setBaseSpeed(character, CHARACTER_CONFIG.BASE_WALK_SPEED);

            const state = this.sprints.get(player);
            if (state?.sprinting) this.applySprint(player, true);
        };

        player.CharacterAdded.Connect(prepare);

        const current = player.Character;
        if (current) prepare(current);
    }

    /** One tick of every tracked player's pool. */
    private onHeartbeat(dt: number): void {
        const now = os.clock();

        // Iterated rather than keyed by character, because the pool belongs to the *player* and must
        // keep draining or recovering whether or not that player currently has a body.
        for (const [player, state] of this.sprints) {
            this.step(player, state, dt, now);
        }
    }

    /**
     * One tick of one player's pool: drain it, refill it, or leave it exactly where it is.
     *
     * **Three outcomes and not two, which is the whole mechanic.** Sprinting drains. Having stopped
     * drains nothing *and* refills nothing until
     * {@link CHARACTER_CONFIG.STAMINA_RECOVERY_DELAY_SECONDS} has passed since the last drain — the
     * pool is frozen, which is what the HUD shows and what stops a tap of the key refilling the pool
     * while a player is still running.
     *
     * **What the pure pool does when the key is held as it empties, stated plainly because it is the
     * one place this mechanic surprises.** Draining to zero does not end the sprint — the player is
     * still holding the key, so `active` is still true, and sprinting resumes the moment `stamina` is
     * above zero again. The pool therefore refills during the pause, comes back a hair above zero, is
     * spent in that same frame, and resets the pause: a one-frame burst of sprint speed roughly every
     * recovery pause, for as long as the key is held. That is the literal reading of "sprint is
     * available whenever stamina is above zero" plus a pause measured from the last drain, and it is
     * left as specified rather than papered over with a resume threshold — a threshold is a lockout,
     * and lockouts were explicitly ruled out. **The fix, if the stutter turns out to matter, is one
     * line**: require a fresh key press after a refusal, which keeps the pool as the only gate for
     * every press while removing the re-arming the player cannot see.
     */
    private step(player: Player, state: SprintState, dt: number, now: number): void {
        const sprinting = state.active && state.stamina > 0;

        if (sprinting) {
            state.stamina = math.max(0, state.stamina - CHARACTER_CONFIG.STAMINA_DRAIN_PER_SECOND * dt);
            state.lastDrainAt = now;
        } else if (now - state.lastDrainAt >= CHARACTER_CONFIG.STAMINA_RECOVERY_DELAY_SECONDS) {
            state.stamina = math.min(
                CHARACTER_CONFIG.STAMINA_MAX_SECONDS,
                state.stamina + CHARACTER_CONFIG.STAMINA_RECOVERY_PER_SECOND * dt,
            );
        }

        // Only when the answer changes. The modifier's addition is a map write and a property write,
        // and doing that sixty times a second to say the same thing is the kind of cost that shows up
        // as a mystery later rather than as a bug now.
        if (sprinting !== state.sprinting) {
            state.sprinting = sprinting;
            this.applySprint(player, sprinting);

            if (DEBUG) print(`[Sprint] ${player.Name}: ${sprinting ? "sprinting" : "walking"}`);
        }

        this.publish(player, state, now);
    }

    /**
     * Puts the sprint's contribution on the player's current character, or takes it off.
     *
     * **The only thing in this file that changes a speed for a reason other than a caller asking**,
     * and it changes none directly: both branches go through the contribution map, which is what
     * keeps the base. A `Humanoid.WalkSpeed =` here would be the second writer the class comment is
     * about, and it would be the one that lost.
     *
     * No character is not an error: it means a dead player, and the decision is recorded without
     * being applied. {@link trackPlayer} puts it on the body that replaces this one.
     */
    private applySprint(player: Player, sprinting: boolean): void {
        const character = player.Character;
        if (!character) return;

        if (sprinting) {
            this.addModifier(character, SPRINT_KEY, CHARACTER_CONFIG.SPRINT_SPEED_BONUS);
        } else {
            this.removeModifier(character, SPRINT_KEY);
        }
    }

    /**
     * Writes the pool out, at most {@link PUBLISH_INTERVAL_SECONDS} apart and never unchanged.
     *
     * The unchanged check is not an optimisation for its own sake: a pool sitting full is the state a
     * player spends most of their time in, and without it the throttle alone would still write the
     * same `3` ten times a second for the whole session, for a bar that has not moved.
     *
     * There is deliberately no special case for reaching empty or full. An edge is a value, the value
     * is written within a tenth of a second of changing, and a tenth of a second of a three-second
     * bar is a third of a pixel. An extra rule to write the same number sooner would be a second path
     * to one truth.
     */
    private publish(player: Player, state: SprintState, now: number): void {
        if (now - state.publishedAt < PUBLISH_INTERVAL_SECONDS) return;
        if (state.published === state.stamina) return;

        state.publishedAt = now;
        state.published = state.stamina;
        player.SetAttribute(STAMINA_ATTRIBUTE, state.stamina);
    }

    /** Whether this player is asking to sprint, and with how much pool. */
    private setSprinting(player: Player, active: unknown): void {
        const state = this.sprints.get(player);
        if (!state) return;

        // Refused rather than coerced. `active` is typed by the declaration and untyped on the wire,
        // so anything that is not a boolean is a client that is not this one — and the honest
        // response to a value nobody meant to send is to ignore it, not to pick a truthiness for it.
        if (!typeIs(active, "boolean")) return;

        state.active = active;

        if (DEBUG) print(`[Sprint] ${player.Name}: key ${active ? "down" : "up"}`);
    }
}
