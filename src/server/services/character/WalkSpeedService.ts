import { OnStart, Service } from "@flamework/core";
import { Players, RunService } from "@rbxts/services";
import { DODGE_DIRECTION_ATTRIBUTE, DUCKING_ATTRIBUTE, STAMINA_ATTRIBUTE } from "shared/constants";
import { CHARACTER_CONFIG } from "shared/config/character.config";
import { events } from "shared/networking";
import type { CatchState } from "../actions/DodgeService";

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

    /**
     * Whether the pool is being **held** this tick, because the body is in the middle of an action. See
     * {@link WalkSpeedService.heldAction} for what counts and `step` for what holding does.
     *
     * **Only here to edge-detect the log line**, and `undefined` is the initial value on purpose: a pool
     * that has never been held has never printed that it stopped, so the first tick of a duck is a change
     * from `undefined` and is reported, and every tick after it is not. Nothing decides anything with this
     * field — the pool's own arithmetic is what holds it — which is why it is a record rather than a gate.
     */
    held?: boolean;
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
 * alternative was two owners of that concern.
 *
 * **Two more modifiers have arrived since, and they did not come in the way the paragraph here used
 * to prescribe.** `FreezeService` adds `Frozen` and `RoundService` adds `ArenaFreeze`, and each calls
 * `addModifier` on the body it is affecting rather than routing through {@link trackPlayer} — because
 * each already knows which body it means and neither wants a hook deciding for it. What held was the
 * part that mattered: a *name*, so any of the four can be taken off again without disturbing the rest.
 */
/**
 * An action that stops the pool, and **which half of it** the action stops.
 *
 * A record rather than a bare name because the two halves are genuinely different rules, and the difference
 * is not cosmetic: see {@link PoolHold.holdsDrain}.
 *
 * **Declared out here rather than inside the class, which is where it was first written** — an `interface`
 * may not sit in a class body in this compiler, and the fault it produced was not the one it looked like:
 * every method below the insertion point stopped being a member of the class, so the first errors named
 * `setSprinting` and `applySprint` as missing properties of the service they are declared on.
 */
interface PoolHold {
    /** What to call it on the `[Sprint]` line. */
    readonly action: string;

    /**
     * Whether this action **also** stops the drain, because the body is not walking under its own power.
     *
     * **The line between the two tiers of hold, and it is a line about physics rather than about fairness.**
     * The drain is a measure of *walking*, so a body that is not walking must not pay it: a duck anchors the
     * root to the floor and a dash is the server moving the body, and in neither is it the legs doing work.
     * A catch window and a charge are the other way round — the body is on its own feet and may well be
     * running — so the drain stays, and only the *recovery* stops, because a body with its hands up or a
     * throw wound back is not resting.
     *
     * **And it is what makes the charge safe to take on trust.** The charge is the one action the server
     * cannot see for itself, so a client reports it — and because a charge does *not* hold the drain, a
     * client that lied about charging would still burn its pool while sprinting. There is nothing to be
     * gained by lying; see the `setCharging` event.
     */
    readonly holdsDrain: boolean;
}

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

    /**
     * The catch window, as this service has to see it.
     *
     * Handed over by `CatchService` itself, on `DodgeService.watchCatchState`'s terms and for one of its
     * two reasons: the pool is keyed by *player* and a window is keyed by *model*, so the state is bound to
     * a `Model` and asked about the body this service already has in hand. **The other reason is the graph** —
     * `CatchService` injects *this* service, so this one cannot inject that one back, and a handover is the
     * codebase's answer to exactly that shape.
     *
     * Unset until `CatchService` is constructed, which is during ignite. While it is unset nothing is held
     * for a catch, because a service that does not exist cannot have a window open.
     */
    private catchState?: CatchState;

    /**
     * The players **holding the throw button**, as the client last reported it. See the `setCharging` event
     * for why this is a client's word and why that is safe here.
     *
     * Keyed by `Player` rather than by character, because it is the client that reports it and a client
     * outlives the bodies it drives — and cleared when a new body arrives, because the claim describes a
     * *body* and a client that died mid-charge may never send the `false`. See {@link trackPlayer}.
     */
    private readonly charging = new Set<Player>();

    /**
     * Hands this service the catch window it has to respect. Called by `CatchService` itself.
     *
     * A handover rather than a subscription, which is `DodgeService.watchCatchState`'s shape: there is one
     * catch window and it has one owner, so whatever is passed here is what the pool is held against from
     * then on.
     */
    public watchCatchState(state: CatchState): void {
        this.catchState = state;
    }

    public onStart(): void {
        // The wire is untyped, so the handler's `active: boolean` describes an intention rather than
        // a guarantee — `shared/networking.ts` says as much about `castVote`, and this is the same
        // situation. The check is in {@link setSprinting}.
        events.Server.OnEvent("setSprinting", (player, active) => this.setSprinting(player, active));

        // And the charge, whose two questions are the same shape — is this a boolean, and is the player
        // being tracked — and are answered by `setCharging` for the same reason.
        events.Server.OnEvent("setCharging", (player, charging) => this.setCharging(player, charging));

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

        if (DEBUG) print(`[Sprint] up — LeftShift/RightShift, ${CHARACTER_CONFIG.STAMINA_MAX_SECONDS}s pool`);
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
     * **Whether this model is wearing the sprint's contribution right now** — the sprint fact, asked of the one
     * service that owns it.
     *
     * **Asked as a contribution rather than read off the walk speed**, which is the arithmetic
     * `NpcService.publishAnimation` used to do with a constant of its own: the base speed is a per-rig number
     * (16 for a rig, 20 for a player), so "is it sprinting" is not a threshold on the total but the presence of
     * a named key. This is the key the sprint was added under, and removing it is what ends a sprint — so nothing
     * here has to know what a sprint costs.
     *
     * **A rig's key is the same word.** `SeekBehavior` declares its own `SPRINT_KEY` with this spelling,
     * deliberately, so that a question like this one gets one answer for both kinds of body rather than a name
     * the caller has to know per body kind. A key is scoped to a *model* and a player's character is never a
     * rig, so the same word on two bodies is two contributions and cannot collide.
     */
    public isSprinting(model: Model): boolean {
        return this.speeds.get(model)?.has(SPRINT_KEY) === true;
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
     * A model has whatever contributions have been added to it, and sprint was the second thing ever to
     * add one — there are three more now, from two other services:
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
     * **That the names keep arriving is the argument for the shape, and it has now been made three
     * times.** `Frozen` comes from `FreezeService`, `ArenaFreeze` from `RoundService`, and each is one
     * name and one number in this map rather than a service writing speeds of its own — so this
     * comment's claim is no longer that there is one contributor but that there are four keys and one
     * sum. **The paragraph that used to sit here said "there is nothing left here that is not true of
     * the running code", and the count in it had gone stale when the second and third arrived.**
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

            // **A new body is not a charging one, and the claim is per *player*.** The state it describes is
            // per *body*, and a client that died mid-charge may never send the `false` — a pool that never
            // refilled again would be a worse fault than the one the claim exists to fix. Cleared here rather
            // than on death, so it covers every road to a new body: a respawn, a first spawn, and a rig.
            this.charging.delete(player);

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
     * **Four outcomes, and the fourth is the one that was missing.** Sprinting drains. Having stopped
     * drains nothing *and* refills nothing until
     * {@link CHARACTER_CONFIG.STAMINA_RECOVERY_DELAY_SECONDS} has passed since the last drain — the
     * pool is frozen, which is what the HUD shows and what stops a tap of the key refilling the pool
     * while a player is still running. **And an action holds the pool**: nothing recovers, whatever the
     * key is doing, and — for an action that stops the body walking — nothing drains either. See
     * {@link WalkSpeedService.poolHold} for what counts and for which half of the pool each action
     * holds.
     *
     * **What the hold fixes, in the examples it was reported with.** *"Holding sprint still uses stamina
     * when I am running"* — a player who ducks or dashes with the key down kept paying for a sprint they
     * could not take, because `active` is a *key* and the key was still down. *"I can use dodge to allow
     * me to move while I recover my stamina"* — the pool refilled during a dash, so the dash was free
     * movement bought with the recovery the player was supposed to be standing still for. And *"I should
     * not recover stamina if I am attempting a catch or HOLDING a throw"* — the same fault with two more
     * actions, both of which a body can do *while walking*, which is why they hold the recovery and not
     * the drain. **All three are one fault seen from different ends: the pool was refilling for a body
     * that was plainly not resting**, and a pool is only a *sprint's* pool if it measures resting.
     *
     * **A hold is not a stop.** `sprinting` is still computed from the key and the pool, so a player who
     * keeps the key down through a duck comes out of it still sprinting — the contribution stays on the
     * body, and the pause is neither restarted nor spent.
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

        // **The body, and a dead player has none** — which reads as `undefined` here and therefore as "not
        // held", so the pool keeps draining or recovering through a death exactly as the class comment says
        // it must. A hold is a rule about a body in the middle of an action, and a player with no body is not
        // in one.
        const character = player.Character;
        const hold = character !== undefined ? this.poolHold(character) : undefined;

        // **Two rules, and the tiers are what they are for.** A hold *always* stops the recovery, so
        // `recovers` only has to ask whether there is one. The *drain* stops only for a hold that also takes
        // the body off its own feet — `PoolHold.holdsDrain` — so a charging or a catching body is still
        // running and still pays for it. Nothing below moves `lastDrainAt` while the recovery is held, so the
        // pause neither restarts nor elapses while the body is busy, and the pool is the same number when
        // the action ends as it was when it began.
        const drains = sprinting && hold?.holdsDrain !== true;
        const recovers =
            hold === undefined &&
            !sprinting &&
            now - state.lastDrainAt >= CHARACTER_CONFIG.STAMINA_RECOVERY_DELAY_SECONDS;

        if (drains) {
            state.stamina = math.max(0, state.stamina - CHARACTER_CONFIG.STAMINA_DRAIN_PER_SECOND * dt);
            state.lastDrainAt = now;
        } else if (recovers) {
            state.stamina = math.min(
                CHARACTER_CONFIG.STAMINA_MAX_SECONDS,
                state.stamina + CHARACTER_CONFIG.STAMINA_RECOVERY_PER_SECOND * dt,
            );
        }

        // **Said once at each end of a hold, because a held pool is otherwise invisible.** The `[Sprint]`
        // line below fires only when *sprinting* changes, and a hold need not change it — a player who ducks
        // mid-sprint keeps the key down and comes out sprinting, so nothing would have been printed at all.
        // "Why did my stamina not refill" is a question this one line answers, and the reason is named on it
        // so a reader does not have to work out which action it was, or which tier of hold it took.
        const holding = hold !== undefined;
        if (holding !== (state.held === true)) {
            state.held = holding;
            if (DEBUG) {
                print(
                    holding
                        ? `[Sprint] ${player.Name}: pool held — ${hold?.action}`
                        : `[Sprint] ${player.Name}: pool running again`,
                );
            }
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
 * The action keeping this body from *resting*, named for the log, or `undefined` if it is free.
 *
 * **Recovery is what this answers, and it is the wider of the two rules**: everything named here stops the
 * pool refilling. What varies is whether it stops the *drain* as well — {@link PoolHold.holdsDrain} — which
 * is a separate question about whether the body is still moving under its own power. Two tiers, then: a
 * **duck** and a **dodge** hold both halves, and a **catch** and a **charge** hold only the recovery.
 *
 * **Why a catch and a charge are in here at all, in the words they were reported with:** *"I should not
 * recover stamina if I am attempting a catch or HOLDING a throw."* Both are things a body does *on the
 * move*, and both are therefore things it can do *instead of* resting — which is the whole fault: the pool
 * was refilling for a body that was plainly not standing still. What is deliberately **not** changed for
 * them is the drain, because draining a body that is running is the pool working correctly.
 *
 * **The catch and the charge get here by two different roads, and only one of them is visible to the
 * server.** A catch window is a server-side fact with a server-side lifetime, so `CatchService` hands this
 * service a handle to it — see {@link watchCatchState}. A charge is measured on the *client*
 * (`client/throwing.ts` owns its start time) and the server learns nothing about it until the release
 * arrives, so the client reports it as a level — see {@link charging} and the `setCharging` event.
     *
     * **Read from the body's published attributes, and that is forced rather than chosen.** The services
     * that own these states cannot be injected here: `DodgeService` depends on `FreezeService`, which
     * depends on *this* service, so an injection would be a cycle — and the codebase's answer to that is a
     * registration (`DodgeService.watchCatchState`) or a published fact. The attributes are the published
     * facts and they are already the lifetime of the thing they describe: `DodgeService` writes
     * `DODGE_DIRECTION_ATTRIBUTE` at the start of a dash and clears it when the dash ends, and
     * `DuckService` writes `DUCKING_ATTRIBUTE` for the length of a duck. So each question here is one read
     * of a fact that already exists, and **no new dependency is introduced into a service that is at the
     * bottom of this codebase's dependency graph.**
     *
     * **Presence for the dash and a `=== true` for the duck, which is not an inconsistency.** The duck's
     * attribute is a boolean and `true` is the only value that means ducking, so anything else — `false`,
     * an absent attribute, a value some other thing wrote — is correctly "not ducking". The dodge's is a
     * *direction word*, and a dash in flight is exactly "that attribute exists"; validating it against the
     * four words (as `bodyAnimation` must, because it has to pick a clip) would be answering a question
     * nobody here is asking.
     *
     * **Not asked: the freeze, and it is a known gap rather than an oversight.** A frozen body cannot walk
     * either, so a frozen sprinter's pool drains for as long as the freeze lasts. It cannot be asked from
     * here without the cycle above — `FreezeService` is on the other side of it — and the cheap version
     * available (this service's own `"Frozen"` contribution, which it stores and could read) would be one
     * service reaching into its own map for another service's fact. Named so it is a decision and not an
     * omission; it is one line if it turns out to matter.
     */
    private poolHold(model: Model): PoolHold | undefined {
        // **The two that take the body off its own feet, and they hold the drain with the recovery.** A duck
        // anchors the root and a dash moves the body by the server's own hand, so neither is walking — and
        // the drain is a measure of walking. See `PoolHold.holdsDrain`.
        if (model.GetAttribute(DUCKING_ATTRIBUTE) === true) return { action: "ducking", holdsDrain: true };
        if (model.GetAttribute(DODGE_DIRECTION_ATTRIBUTE) !== undefined) {
            return { action: "dodging", holdsDrain: true };
        }

        // **The two a body can do while walking, and they hold only the recovery.** Raising your hands for
        // a ball and winding up a throw are both things a player does *on the move* — you can run with a
        // window open and you can run while charging — so the drain stays honest for them and only the
        // recovery stops: a body doing either is not resting. The charge's half of that is also what makes
        // it safe to take the client's word for; see the `setCharging` event.
        if (this.catchState?.isCatching(model) === true) return { action: "catching", holdsDrain: false };

        const player = Players.GetPlayerFromCharacter(model);
        if (player !== undefined && this.charging.has(player)) return { action: "charging", holdsDrain: false };

        return undefined;
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

    /**
     * Records whether this player is holding the throw button, as the client last reported it.
     *
     * **The same two checks as {@link setSprinting}, for the same two reasons.** The wire is untyped, so
     * anything that is not a boolean is a client that is not this one, and is ignored rather than coerced;
     * and a player who is not being tracked is ignored rather than remembered, so this flag cannot outlive
     * the pool it describes.
     *
     * **Nothing here is a refusal and nothing here decides anything.** The flag is read by {@link poolHold},
     * which holds the recovery while it is up and deliberately leaves the drain alone — see the `setCharging`
     * event for why that asymmetry is what makes taking a client's word for this safe.
     */
    private setCharging(player: Player, charging: unknown): void {
        if (!typeIs(charging, "boolean")) return;
        if (!this.sprints.has(player)) return;

        if (charging) {
            this.charging.add(player);
        } else {
            this.charging.delete(player);
        }
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
