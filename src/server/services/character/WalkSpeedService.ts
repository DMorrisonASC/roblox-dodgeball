import { OnStart, Service } from "@flamework/core";
import { Players } from "@rbxts/services";
import { CHARACTER_CONFIG } from "shared/config/character.config";

/**
 * The key a model's *base* speed is stored under.
 *
 * A named key rather than a single number per model, because that is the whole design: the base is
 * not special, it is just the first contribution. See {@link WalkSpeedService.recalculateSpeed}.
 */
const BASE_KEY = "Base";

/**
 * The one authority for how fast a character can walk.
 *
 * **Nothing else in the game should write `Humanoid.WalkSpeed`.** A direct write is a value, and the
 * moment two systems write one value the last one wins and the other's intent is gone — turn a
 * speed potion on and off and a naive implementation leaves the character at potion speed for ever,
 * because the potion wrote over the base rather than adding to it. This service keeps the
 * contributions separate and derives the value, so removing any one of them restores the rest.
 *
 * **It does not know what a Player is, and that is deliberate.** {@link setBaseSpeed} takes a
 * `Model` and looks for a `Humanoid`; a rig and a character are the same shape to it. The only
 * player-specific code in the file is {@link trackPlayer}, which exists to know *when* to call it.
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

    public onStart(): void {
        Players.PlayerAdded.Connect((player) => this.trackPlayer(player));

        // ...and anyone already here. A player who joined before this service started would never
        // fire `PlayerAdded`, which is the normal case in Studio when the server script reloads
        // under an existing session rather than starting a fresh one.
        for (const player of Players.GetPlayers()) {
            this.trackPlayer(player);
        }
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

        const entry = new Map<string, number>();
        this.speeds.set(model, entry);

        humanoid.Died.Connect(() => this.forget(model));
        model.Destroying.Connect(() => this.forget(model));

        return entry;
    }

    /**
     * Sum every contribution and write the result to the Humanoid.
     *
     * **The sum is the entire reason for the map, and it is what makes a power-up a one-line change.**
     * Today a model has exactly one key:
     *
     *     Base: 16                          ->  16
     *
     * A speed potion would add a second, without touching the first:
     *
     *     Base: 16, SpeedPotion: 8          ->  24
     *
     * ...and expiring it would be `entry.delete("SpeedPotion")` followed by a call to this method.
     * Neither of those needs anything new here, and neither can lose the base — which is the whole
     * difference between adding to a speed and overwriting one. Neither `addModifier` nor
     * `removeModifier` exists yet because nothing calls them yet; when something does, they are a
     * `set`/`delete` on the map plus this method, and this comment is the specification.
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
    }

    /** Drop a model's contributions. */
    private forget(model: Model): void {
        this.speeds.delete(model);
    }

    /**
     * Apply the base speed to a player's character, now and on every respawn.
     *
     * **A character is a new model each time**, so this cannot be set once: the Humanoid that was
     * tuned a moment ago is destroyed with the body it belonged to. Hence the signal rather than a
     * single call, and hence the immediate check as well — a player who joined before this service
     * started already has a character that will never fire `CharacterAdded` again.
     */
    private trackPlayer(player: Player): void {
        player.CharacterAdded.Connect((character) => {
            this.setBaseSpeed(character, CHARACTER_CONFIG.BASE_WALK_SPEED);
        });

        const current = player.Character;
        if (current) {
            this.setBaseSpeed(current, CHARACTER_CONFIG.BASE_WALK_SPEED);
        }
    }
}
