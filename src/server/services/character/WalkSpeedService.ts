import { OnStart, Service } from "@flamework/core";
import { Players, RunService } from "@rbxts/services";
import { CHARGING_ATTRIBUTE, DODGE_DIRECTION_ATTRIBUTE, DUCKING_ATTRIBUTE, STAMINA_ATTRIBUTE } from "shared/constants";
import { CHARACTER_CONFIG } from "shared/config/character.config";
import { DEBUG_CONFIG } from "shared/config/debug.config";
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
 * The cap an **action stance** puts on a body — a throw being charged or a catch window — as the key it is
 * stored under.
 *
 * **A cap is not a contribution, and that is why it has a name of its own here rather than being a negative
 * addition.** A contribution is something a body *has* — a sprint adds `15` — while a cap is a ceiling on
 * whatever it ends up with, and the difference is not cosmetic: `20 + 15` minus `27` would cap a sprinting
 * catcher correctly and would do nothing at all to a frozen body already at `0`, which is the case it looks
 * like it handles. A ceiling is one `math.min` at the end of the sum, it cannot move a body up, and it composes
 * with every contribution already in the map without knowing what any of them are.
 *
 * **One key for both actions, because both are the same number.** `CHARACTER_CONFIG.AIMING_WALK_SPEED` is the
 * whole of what a stance costs, and two keys holding one value would be two entries to remove and no difference
 * to observe — the catch window and a charge cannot overlap in practice anyway (a catch needs an empty hand).
 * A second action *with a different ceiling* would add its own key, and the lower of the two would win.
 */
const ACTION_CAP_KEY = "Action";

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
     * A catch window is the other way round — the body is on its own feet and may well be running — so the
     * drain stays, and only the *recovery* stops, because a body with its hands up is not resting.
     *
     * **A charge used to be named in that second tier and is not any more.** See {@link poolHold} for the
     * argument — a hold whose length the player chooses is a lockout rather than a measure of resting — and
     * `shared/networking.ts` for the event that used to carry it. The two tiers now hold two actions and one.
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
     * Every ceiling currently on a model, and the value of each, keyed exactly as {@link speeds} is.
     *
     * **A second map rather than a second kind of entry in the first.** The two are read at different points
     * of one calculation — the contributions are *summed*, the caps are *minimised against the sum* — and
     * mixing them would mean every reader of the sum remembering to skip cap-shaped rows. It also keeps
     * {@link forget} honest: both maps are dropped together, so a body that dies cannot leave a ceiling
     * behind to be applied to the next body that reuses the model (a character is new each death, so this is
     * belt-and-braces, but the rig pool reuses *models*).
     *
     * **Written only by {@link setCap}, cleared only by {@link clearCap} and by a model being forgotten**, so
     * there is no path that leaves a stale ceiling standing — see {@link enforceActionCaps}, which is the one
     * caller for the catch and which clears on the frame the window closes.
     */
    private readonly caps = new Map<Model, Map<string, number>>();

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
     * **The players holding the throw button, reported by their own client** — the aiming half of the action cap.
     *
     * **A `Set<Player>` filled by the `setCharging` event, and it lived here once before for a different
     * purpose.** It used to hold the stamina pool's *recovery* during a charge; that hold was removed, because a
     * hold whose length the player controls is a self-inflicted lockout rather than a rule about resting (see
     * `poolHold`), and the set went with it. **It is back for the speed cap**, which is a different argument:
     * a charge is a stance with the clip held at its windup, so the body has to be slowed while it stands in it,
     * and *that* rule ends when the button does by definition.
     *
     * **Keyed by player, and read through the model.** A charge belongs to a person — it survives a death in the
     * sense that the client is still holding the key — while the cap is applied to a body, so
     * {@link isHoldingAction} resolves the player from the model it is already holding. The alternative, keyed by
     * model, would need a handler that finds the body and a second path for a body arriving mid-hold.
     *
     * **The client's report is believed**, which is `setSprinting`'s rule and its argument: the server holds no
     * opinion about a held button and no way to discover one, and an untrue `true` costs the player their own
     * movement speed and buys nothing else.
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

        // **The charge's level, for the speed cap.** The server cannot see a hold — the start time is measured on
        // the client and the server only hears of the throw at the release — so this is the one fact on the wire
        // that only one machine has. See {@link setCharging} for what is done with it and {@link charging} for
        // why it is a set of players rather than of bodies.
        events.Server.OnEvent("setCharging", (player, active) => this.setCharging(player, active));

        // **This subscription existed once, was removed, and is back — and the sentence that used to sit here said
        // it was gone.** It first fed `poolHold`'s charge branch, and went with that branch when the stamina hold
        // was removed. What it feeds now is the speed cap, which is a different rule with a different argument:
        // see {@link isAiming}. The client's old `syncCharging` doc and `shared/networking.ts`'s declaration both
        // carry the same record, so a reader arriving at any of the three finds the reversal rather than a
        // contradiction between them.

        Players.PlayerAdded.Connect((player) => this.trackPlayer(player));

        // ...and anyone already here. A player who joined before this service started would never
        // fire `PlayerAdded`, which is the normal case in Studio when the server script reloads
        // under an existing session rather than starting a fresh one.
        for (const player of Players.GetPlayers()) {
            this.trackPlayer(player);
        }

        // **Both per-player tables go with the player**, and the charge is here for the same reason the pool is:
        // nothing will ever report `false` for a player who has left, so a row left behind would cap the next
        // body that player id is reused for and nothing would ever take it off.
        Players.PlayerRemoving.Connect((player) => {
            this.sprints.delete(player);
            this.charging.delete(player);
        });

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
     * **Put a ceiling on a model's walk speed**, under a name so any cap can be taken off again without
     * disturbing the rest.
     *
     * The value is applied to the *sum*, in {@link recalculateSpeed}, and never to a single contribution — so
     * this cannot be defeated by a bonus that happens to be added afterwards, and a sprinting catcher is
     * capped exactly as a walking one is. That is the whole of what "maximum speed while catching" means, and
     * it is why this is a map of its own rather than a modifier with a negative number in it; see
     * {@link CATCHING_CAP_KEY}.
     *
     * **Idempotent, and the unchanged case returns early.** `enforceActionCaps` calls this every frame a window
     * is open, and a `Humanoid.WalkSpeed` write per frame is sixty property writes and sixty replication
     * candidates a second to say one number that has not moved. The comparison is the same one `publish` makes
     * for the stamina attribute and for the same reason.
     *
     * A model with no `Humanoid` stores nothing, like every other writer here — the ceiling would have nowhere
     * to go.
     */
    public setCap(model: Model, key: string, speed: number): void {
        const humanoid = model.FindFirstChildOfClass("Humanoid");
        if (!humanoid) return;

        let caps = this.caps.get(model);
        if (!caps) {
            caps = new Map<string, number>();
            this.caps.set(model, caps);
        }

        if (caps.get(key) === speed) return;

        caps.set(key, speed);
        this.recalculateSpeed(model, humanoid);
    }

    /**
     * Remove a ceiling by name. Safe to call when there is none — {@link addModifier}'s own argument, and the
     * one that matters here: every path out of a catch calls it unconditionally rather than first working out
     * whether a cap was ever applied.
     */
    public clearCap(model: Model, key: string): void {
        const caps = this.caps.get(model);
        if (!caps || !caps.has(key)) return;

        caps.delete(key);

        if (caps.size() === 0) this.caps.delete(model);

        const humanoid = model.FindFirstChildOfClass("Humanoid");
        if (!humanoid) return;

        this.recalculateSpeed(model, humanoid);
    }

    /**
     * **One pass over every tracked body, holding it to `CHARACTER_CONFIG.AIMING_WALK_SPEED` while it is standing
     * in an action stance** — a throw being charged or a catch window — and letting go on the frame it is not.
     *
     * **Both kinds of body, from one loop, because the cap must be one rule.** A rig's speed is a base plus the
     * seek's own sprint and a player's is a base plus the sprint key, and neither difference survives the
     * comparison this makes: the stance is a fact about the *model* and every model the game moves has an entry
     * here — a player's from `trackPlayer`, a rig's from whichever `prepare` set its base (`SeekBehavior`, for
     * both the round and the practice variant). So the rig and the player are held by the same three lines, which
     * is the requirement rather than a convenience.
     *
     * **Asked here rather than pushed from the services that own the states, and the two reasons are different.**
     * A catch window expires *lazily* — `CatchService.isCatching` is what notices — so a cap pushed on open and
     * cleared by a callback would outlive its window by however long nothing asked about it, which for a rig that
     * stopped catching is the rest of the round; this pass asks every frame, so the window is noticed expiring on
     * the frame it lapses. A charge, by contrast, publishes itself: `ThrowBehavior` writes `CHARGING_ATTRIBUTE` for
     * the length of the hold and `endWindup` clears it, so reading the attribute needs no wiring in the behaviour
     * at all and cannot miss a teardown path — a death, a lost target, a cancelled windup and a throw all go
     * through that one clear.
     *
     * **Death needs no line here.** `entryFor` watches `Died` and `Destroying` and drops the model from both maps,
     * so a corpse's cap goes with the body it was put on — "removed on every exit path" is met by the maps being
     * dropped rather than by a fifth branch to remember.
     */
    private enforceActionCaps(): void {
        for (const [model] of this.speeds) {
            if (this.isHoldingAction(model)) {
                this.setCap(model, ACTION_CAP_KEY, CHARACTER_CONFIG.AIMING_WALK_SPEED);
            } else {
                this.clearCap(model, ACTION_CAP_KEY);
            }
        }
    }

    /** Whether `model` is in an action stance — the one question the cap is a consequence of. */
    private isHoldingAction(model: Model): boolean {
        if (this.isAiming(model)) return true;

        return this.catchState?.isCatching(model) === true;
    }

    /**
     * **Whether `model` is holding a throw.** Two sources, one per kind of body, and the split is forced rather
     * than chosen.
     *
     * - **A rig publishes it.** `ThrowBehavior`'s windup tracker writes `CHARGING_ATTRIBUTE` as a number when a
     *   hold starts and clears it in `endWindup`, so the attribute *is* the hold's lifetime — the same fact
     *   `SeekBehavior` reads to stop a rig jumping mid-windup and `client/chargeEffect.ts` reads to draw it.
     *   Presence rather than a value: a charge of `0` (a rig throwing point blank) is still a hold, and the
     *   number is a level for the effects rather than a switch for this.
     * - **A player is reported.** Nothing on the server can see a client's button, so `setCharging` carries the
     *   level and {@link charging} holds it. A player's character never wears `CHARGING_ATTRIBUTE`, so the two
     *   branches cannot contradict each other — and the check order costs nothing either way.
     */
    private isAiming(model: Model): boolean {
        if (model.GetAttribute(CHARGING_ATTRIBUTE) !== undefined) return true;

        const player = Players.GetPlayerFromCharacter(model);

        return player !== undefined && this.charging.has(player);
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

        // **The ceilings, and this is the one place they are applied.** `math.huge` when a model has none, so
        // the `min` below is a no-op rather than a branch; with two caps on one body the *lower* wins, which is
        // the correct answer for a body in two capped actions at once. See {@link setCap} for why a ceiling is
        // not a negative contribution.
        let ceiling = math.huge;
        this.caps.get(model)?.forEach((value) => {
            ceiling = math.min(ceiling, value);
        });

        // Clamped at zero. A pile of slow effects could sum below it, and a negative `WalkSpeed` is
        // not "not moving" — Roblox reads it as a nudge backwards, which is how a debuff ends up
        // walking a character in the wrong direction.
        //
        // **Capped first, then clamped**: a ceiling can only ever lower a speed, and a frozen catcher
        // (`0`) stays at `0` whatever the action cap says. The order is the reason a cap cannot resurrect a
        // body that something else has stopped.
        humanoid.WalkSpeed = math.max(0, math.min(total, ceiling));

        // What it was set to, and out of what. This is the line to read when a character will not
        // move: `0 ()` is an entry with nothing in it, which is a bug here, and `0 (Base:20)` would
        // mean the base itself had been set to nothing. Rebuilding the string rather than logging the
        // map because an attribute-shaped table prints as a pointer, which is no use in a log.
        // **Gated on the config as well as on this file's own `DEBUG`.** The doc above calls this "a handful
        // of lines a round"; a live log on 2026-10-17 had it firing roughly twice per rig per walk, because
        // every walk starts and ends a sprint and every sprint is two writes to the map. Eight rigs cycling a
        // walk every three seconds made this one of the three loudest lines in the server script. Nothing
        // below is skipped when it is off — the write to `humanoid.WalkSpeed` is above it, which is the whole
        // reason this is a print guard and not an early return.
        if (DEBUG && DEBUG_CONFIG.VERBOSE_LOGS) {
            const parts: string[] = [];
            entry.forEach((value, key) => parts.push(`${key}:${value}`));

            print(`[Walk] ${model.Name}: ${humanoid.WalkSpeed} (${parts.join(" ")})`);
        }
    }

    /** Drop a model's contributions, and any ceiling that was standing on them. */
    private forget(model: Model): void {
        this.speeds.delete(model);

        // **Both maps, together, and this is the death path the acceptance criteria ask about.** A cap left
        // behind would be applied to whatever body next answers to this key — for a character that is nothing,
        // since a body is new each death, but a rig model is reused by the pool, so a rig that died mid-catch
        // would hand its successor a walk speed of `8` for no visible reason.
        this.caps.delete(model);
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

            // **A new body starts uncharged.** The cap is read per frame, so a flag left standing would cap a
            // body the player has not held the button on — and the client re-sends on its own edge, so a player
            // who does keep the button down through a death is capped again a frame after the report arrives.
            // Clearing here is the safe half of that trade: a stale cap is a movement bug, and a missing one is
            // a speed a player gets for one frame.
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

        // **The catch cap, for every body rather than only for players, and it runs first.** It is one pass over
        // the models this service tracks and it is the only thing that notices a catch window *expiring* — see
        // {@link enforceActionCaps} — so it belongs on the frame's own clock rather than on the pool's, which
        // exists for players only.
        this.enforceActionCaps();

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
     * not recover stamina if I am attempting a catch"* — the same fault for an action a body can do *while
     * walking*, which is why it holds the recovery and not the drain. **All three are one fault seen from
     * different ends: the pool was refilling for a body that was plainly not resting**, and a pool is only
     * a *sprint's* pool if it measures resting.
     *
     * **And the charge was the fourth, and it is gone.** Named here because the paragraph above used to
     * quote it — *"…or HOLDING a throw"* — and a reader carrying that sentence will otherwise conclude the
     * rule still covers it. It does not: see {@link poolHold}, where the argument is that a hold whose
     * length the player chooses is a lockout rather than a measure of resting.
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
        // the body off its own feet — `PoolHold.holdsDrain` — so a catching body is still running and still
        // pays for it. Nothing below moves `lastDrainAt` while the recovery is held, so the pause neither
        // restarts nor elapses while the body is busy, and the pool is the same number when the action ends
        // as it was when it began.
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
 * **duck** and a **dodge** hold both halves, and a **catch** holds only the recovery.
 *
 * **Why a catch is in here at all, in the words it was reported with:** *"I should not recover stamina if I
 * am attempting a catch."* A catch is a thing a body does *on the move*, and therefore a thing it can do
 * *instead of* resting — which is the whole fault: the pool was refilling for a body that was plainly not
 * standing still. What is deliberately **not** changed for it is the drain, because draining a body that is
 * running is the pool working correctly.
 *
 * **A charge was in here beside the catch and has been taken out, and it is the one hold whose length the
 * player controls.** It arrived by a different road — a charge is measured on the *client*, so the server was
 * told about it over the `setCharging` event — and it has gone for a reason the catch does not have.
 * `currentCharge` clamps at full and **nothing auto-throws**, so a player can hold the throw button for as
 * long as they like: while they did, nothing recovered. A stance somebody can stand in for a minute is not
 * evidence that they are not resting, it is a lockout they can inflict on themselves, and it was reported as
 * exactly that — *"stamina does not replenish while aiming"*. See the note at the bottom of this method for
 * what went with it.
 *
 * **`setCharging` is on the wire again and has nothing to do with this method.** It carries the charge's level
 * for the *speed cap* — see {@link isAiming} — because a stance holds the throw clip at its windup and a body
 * that keeps walking slides. The distinction to keep: **a stance may slow a body and may not stop it resting**,
 * and the two rules are argued separately rather than sharing one flag.
 *
 * **The catch arrives the only way it can.** A catch window is a server-side fact with a server-side
 * lifetime, so `CatchService` hands this service a handle to it — see {@link watchCatchState}.
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

        // **The one a body can do while walking, and it holds only the recovery.** Raising your hands for
        // a ball is something a player does *on the move* — you can run with a window open — so the drain
        // stays honest for it and only the recovery stops: a body with its hands up is not resting. It was
        // two of these until the charge was removed below.
        if (this.catchState?.isCatching(model) === true) return { action: "catching", holdsDrain: false };

        // **A charge used to be returned here, and its removal is the point of this change.** The hold stopped
        // the pool recovering while the throw button was down, on the same "hands up is not resting" argument.
        // What that argument missed is that **this is the one hold whose length the player controls**: a
        // charge has no ceiling (`currentCharge` clamps at full and nothing auto-throws), so a player who held
        // the button — to line a shot up, to wait for a gap, or by accident — stopped their own stamina
        // recovering for as long as they kept holding it. Every other hold here is short and involuntary: a
        // duck, a dash, a catch window with a server-side lifetime. Writing a charge off as "not resting" is
        // defensible; making it a stance somebody can stand in for a minute is not, and the symptom is the
        // one this was reported as — "stamina does not replenish while aiming".
        //
        // **Charging and sprinting together still drains**, exactly as it did before: this branch never held
        // the drain. What has changed is only that standing still with the button down now refills.

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

    // **`setCharging` used to stand here, was removed, and is now further down this file.** Its first life
    // recorded whether a client was holding the throw button so that {@link poolHold} could stop the pool
    // recovering during a charge, and it went with that hold — a button that can be held indefinitely is a
    // lockout rather than a rule about resting. Its second life is the speed cap, and it is a different ask:
    // see {@link setCharging} below for what it does now and {@link isAiming} for who reads it.

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

    /**
     * **Whether this player is holding the throw button** — the client's report, believed, and acted on by the
     * cap pass rather than here.
     *
     * **Nothing is applied at this instant, deliberately.** The cap lives in {@link enforceActionCaps}, which
     * runs on the frame's heartbeat; this method only records the fact, so there is exactly one place a
     * `Humanoid.WalkSpeed` can be written for a stance and no way for a report and the catch window to cap a body
     * twice with different reasoning. The delay is one frame at most, which is inside the press.
     *
     * **Refused rather than coerced**, exactly as {@link setSprinting}: the declaration types the argument and the
     * wire does not, so a value nobody meant to send is ignored rather than given a truthiness.
     *
     * **Nothing is verified about the body.** A report with no character is recorded and simply caps nothing,
     * because a player holding the button through a death holds it — the same reason the sprint's decision is a
     * `Player` field rather than a property of the body — and `prepare` clears it when the new body arrives so a
     * stale `true` cannot cap a body the player is not holding for.
     */
    private setCharging(player: Player, active: unknown): void {
        if (!typeIs(active, "boolean")) return;

        if (active) {
            this.charging.add(player);
        } else {
            this.charging.delete(player);
        }

        if (DEBUG) print(`[Walk] ${player.Name}: ${active ? "holding a throw — capped" : "throw released — cap off"}`);
    }
}
