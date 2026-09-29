import { Players } from "@rbxts/services";
import { CHARACTER_CONFIG } from "shared/config/character.config";

/**
 * Spawn protection: one `ForceField` on every new player body, gone after a second.
 *
 * **A `ForceField` is the whole mechanism, because the engine is what refuses the damage.**
 * `Humanoid:TakeDamage` is documented as lowering the health "if it is not protected by a
 * `ForceField`", and that call is the only way anything in this game hurts anybody —
 * `BallComponent`'s landed hits and `RoundService`'s caught thrower both go through it. So one
 * instance protects a player from every damage path that exists, and no damage path has to know this
 * module is here. The alternative — an attribute plus a check in each place that deals damage —
 * would be the same rule written once per way of being hit, and the next way added would forget it.
 *
 * **What this is not:** it is not immunity and it is not a mechanic. A second is a spawn grace —
 * enough to cover a body appearing before its owner can see where they are, not enough to hold as a
 * tactic.
 *
 * **The engine's own `ForceField` has to be taken away, and that is the fault this fixes.** A
 * `SpawnLocation` with a non-zero `Duration` inserts a `ForceField` into a character that spawns on
 * it, and it lasts for that `Duration` — so whether a freshly spawned player was protected at all
 * depended on *which* spawn the engine happened to pick, which is place-file state this code can
 * neither read nor keep in step. That is what "sometimes they spawn with no forcefield" is: not a
 * missing feature, but a choice made somewhere this code cannot see. The shield below is the only
 * one the game wants, so everything else on the body is stripped and what is left is destroyed on a
 * timer this module owns.
 *
 * **Players only.** A rig is cloned rather than spawned at a `SpawnLocation`, so it arrives with no
 * shield to take away and none is added — see `NpcService.spawn`. A rig that ever needed one would
 * be a change here and nowhere else.
 *
 * Started from `main.server.ts`. Unlike the collision groups next door it has no ordering constraint
 * with `Flamework.ignite()`: nothing reads a `ForceField` while services are starting.
 */

/** Prints one line per spawned body, saying what was removed and what was applied. */
const DEBUG = true;

/**
 * Arms spawn protection for everybody, now and for the rest of the session.
 *
 * The scan is not redundant with the subscription: a player already in the game when this started
 * never fires `PlayerAdded`. It is the same pair of mechanisms `OutlineService` and
 * `CollisionGroups` each use, and for the same reason. There is in practice nobody to find — this is
 * called from `main.server.ts`, before anybody can have joined — and it is here so that "started
 * late" is not a state this module has to be correct about.
 */
export function startSpawnShield(): void {
    for (const player of Players.GetPlayers()) watch(player);

    Players.PlayerAdded.Connect((player) => watch(player));
}

/**
 * Protects every body `player` is given, from now on, and does nothing else for the rest of the
 * session.
 *
 * **Per character rather than per player**, because a character is what wears a shield and
 * characters are replaced on every death — which is the moment this exists for. Death is followed by
 * a new body in every mode: a mode may respawn the player itself (`ScoreRushMode`,
 * `DodgeAndSeekMode`) or leave them for the engine's own timer (Team Elimination), and both arrive
 * here as `CharacterAdded`. So there is no mode-specific path to remember and nothing that has to be
 * kept in step with the round — "the player died" and "a shield is applied" are one event seen from
 * two sides.
 *
 * The connection is deliberately never disconnected: it lives on the `Player`, dies with it, and is
 * one per player rather than one per life. `OutlineService` hooks the same signal the same way.
 */
function watch(player: Player): void {
    player.CharacterAdded.Connect((character) => protect(character));
}

/**
 * Gives `character` a shield for {@link CHARACTER_CONFIG.SPAWN_SHIELD_SECONDS} seconds, and only
 * that long.
 *
 * **Two removals and one addition.** Everything already on the body goes first — that is the
 * engine's `SpawnLocation` shield, if the spawn it chose had one — then ours is added and destroyed
 * on a timer. The second removal is a *window* rather than a line, and it exists because of the one
 * thing here that cannot be read out of the place file or reasoned about from the documentation:
 * whether the engine inserts its `ForceField` before or after `CharacterAdded` fires.
 *
 * - If before, the strip below has already dealt with it.
 * - If after, the connection deals with it. Without that branch a shield of some other length would
 *   arrive *after* ours and outlive it, which is the same fault in a quieter form — the body would
 *   be protected for a length nobody chose rather than for none at all.
 *
 * Setting `Duration` to zero on the place's `SpawnLocation`s makes both paths redundant; it does not
 * make them wrong, and it cannot be relied on from here, which is why they are not conditional on
 * it. The window closes when ours does, so nothing is watching a living character afterwards for a
 * connection nobody needs.
 */
function protect(character: Model): void {
    const stripped = stripShields(character);

    const shield = new Instance("ForceField");
    shield.Parent = character;

    // **Recognised by identity rather than by name.** Every `ForceField` is called `ForceField`, so a
    // name test would either delete our own or keep the engine's — and it would do the wrong one
    // silently, since both are the same instance type with the same name.
    const late = character.DescendantAdded.Connect((descendant) => {
        if (descendant === shield) return;
        if (!descendant.IsA("ForceField")) return;

        descendant.Destroy();
        if (DEBUG) print(`[Shield] ${character.Name}: a late forcefield arrived and was removed`);
    });

    if (DEBUG) {
        print(
            `[Shield] ${character.Name}: ${stripped} removed, ` +
                `${CHARACTER_CONFIG.SPAWN_SHIELD_SECONDS}s applied`,
        );
    }

    task.delay(CHARACTER_CONFIG.SPAWN_SHIELD_SECONDS, () => {
        late.Disconnect();

        // A body that died inside its own shield took the instance with it, and destroying something
        // already destroyed is a second fault to explain rather than a state worth reporting. The
        // check is also what makes the timer safe to fire at a character that is long gone.
        if (shield.Parent !== undefined) shield.Destroy();
    });
}

/**
 * Removes every `ForceField` on `character`, and answers how many there were.
 *
 * The count is returned rather than logged because it is the one number that says whether the
 * engine's spawn machinery had a say in this body at all — so the line above reports it, and a
 * session where it is always zero is a session where the place's `SpawnLocation`s are already
 * configured the way this module assumes.
 *
 * `GetChildren` rather than a descendant walk, because a `ForceField` protects a character by being
 * *in* the character and nothing puts one deeper than that.
 */
function stripShields(character: Model): number {
    let removed = 0;

    for (const child of character.GetChildren()) {
        if (!child.IsA("ForceField")) continue;

        child.Destroy();
        removed += 1;
    }

    return removed;
}
