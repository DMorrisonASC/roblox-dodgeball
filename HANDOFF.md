# Handoff — roblox-dodgeball

A guide for a fresh session. Written 2026-09-28 against a green build (`npm run build` → exit 0);
**brought up to date 2026-10-06** against a green build at commit `5bcc374` with the economy work
sitting uncommitted (see §15).

**Read this file, then read the actual source.** This document describes *where* things are and *why*
the shape is what it is; it deliberately does not reproduce code, because code copied into prose
goes stale silently. Every claim here that was verified by a live Studio log says so; everything
else is "built and type-checked, not run".

**§0 and §2 are the operating contract** — the working style and the comment style. They were not
trimmed or rewritten in the update; §0 has been *extended* with a design-principles block that was
missing from the document entirely.

---

## 0. How to work with this user

Almost every request arrives as a **detailed spec with acceptance criteria**, ending with words like
*"Build must stay green. Flag anything you can't verify without Studio."* Treat that as the contract:

- **Verify APIs against the installed typings before writing code.** Not from memory of Roblox or of
  roblox-ts. Several hours were spent on failures that were one typed signature away.
- **`npm run build` must pass before you report.** It is fast and it catches roblox-ts's non-obvious
  restrictions (see §3).
- **Say plainly what you could not verify.** These logs are real; the user runs this in Studio and
  brings back output. Claiming a runtime behaviour you did not observe is the one thing that
  reliably costs trust here.
- **When a spec's stated cause is wrong, say so.** This has happened repeatedly and the user has
  always preferred the correction to the compliance. Examples in §10.
- **Do not "tidy" the comments.** See §2. This is not a normal codebase in that respect and a fresh
  model's first instinct — shortening the prose — is the wrong one.
- The user changes their mind and says so explicitly ("the previous decision is overridden"). Honour
  the newest instruction and update the comment that argued for the old one; a stale justification
  is worse than none.

### Design principles

These are the shape of the codebase as much as §2's comment style is, and they were not written
down anywhere before this revision of the handoff.

- **Loose coupling, strict ownership.** Each subsystem owns its state and exposes narrow,
  intent-named queries and commands — `hasCharge(player)`, not `getStreakMap()`. Direct calls
  between services are fine when the call is small; the rule is **no *unnecessary* direct calls**,
  not "no calls". See `SuperService.isRoundActive`, which is deliberately *lent out* to `BallService`
  rather than copied, with the argument for the loan in its doc.
- **One service per domain.** A domain owns everything about its state. The sprint merge proved what
  happens otherwise: `SprintService` and `WalkSpeedService` both wrote one property, and the fix was
  to make one service own the speed as a *sum of named contributions* (`Base`, `Sprint`, `Frozen`,
  `ArenaFreeze`). A new contributor is a name and a number, not a second writer.
- **Modular over monolithic.** A helper for two lines that two files need beats a service for two
  lines that one file needs. When a spec asks for ceremony — an interface with one implementation, a
  service for one method, a helper for two lines — say so. A smaller solution with a named trade-off
  is preferred to a framework for a problem this project does not have.
- **The user is a web developer, primarily React.** Three consequences:
  - **Fusion is SolidJS, not React.** Fine-grained reactivity, no virtual DOM, no re-render. A
    `Computed`'s dependencies are the `use()` calls that actually ran (see §10's HUD story), and a
    `Value` is read with `Fusion.peek` or a `use` callback — there is no `.get()`.
  - **big-ui is Bootstrap, not a framework.** Components take their props at construction, so
    changing a component's contents means building a new one; `Text`/`Button` return plain
    instances with a theme applied.
  - **Roblox UI has no CSS.** No flexbox, no margin, no `calc()`, no media queries. `Scale` refers
    to the *parent's* size, not the viewport, unless the chain goes up to a `ScreenGui`.
- **They iterate in Studio and bring back logs.** Treat a log line as ground truth. Do not dismiss
  a log's evidence because the code "should" work — see the aim-preview bug in §10, where the log
  was right and the reasoning about the code was wrong.
- **The game's differentiator is the aiming model.** Click-to-land with a trajectory preview — a
  MOBA skillshot rather than a traditional throw — plus manual ball pickup. The preview must be
  honest: if it does not draw the actual path, the mechanic is broken. The hit indicator is a
  *hint*, not a verdict. Balls persist through rounds; the spawner stocks the arena and players
  fetch rather than being handed a ball.

---

## 1. Stack and commands

| Thing | Version / note |
|---|---|
| roblox-ts | 3.0.0 (^3.0.0) |
| TypeScript | 5.5.3 |
| Flamework | 1.3.2 (`@flamework/core`, `@flamework/components`, transformer 1.3.2) |
| Rojo | `default.project.json` — `out/server` → `ServerScriptService.TS`, `out/shared` → `ReplicatedStorage.TS`, `out/client` → `StarterPlayerScripts.TS` |
| Fusion | `@rbxts/fusion-3.0` ^0.1.0 — **this is Fusion 3**; `Fusion.scoped()`, `Fusion.Value`, `Fusion.New`, `Fusion.peek` |
| big-ui | `@rbxts/big-ui` ^1.1.3 — theme is **LIGHT** |
| net | `@rbxts/net` ^3.0.10 — `events.Server.OnEvent`, `events.Server.Get(...).SendToPlayer / SendToAllPlayers`, `events.Client.Get(...).SendToServer` |
| types | `@rbxts/types` ^1.0.953, `@rbxts/compiler-types` ^3.0.0-types.0 |
| lint / format | eslint ^10 with `eslint-plugin-roblox-ts` ^1.4.1, prettier ^3.9.6, `.eslintrc` + `.prettierrc` at the root |

```
npm run build     # rbxtsc — one-shot; also regenerates flamework.build
npm run watch     # rbxtsc -w
```

**Environment gotchas**

- The `rojo serve` terminal in this workspace has exited with code 1 every time it has been observed.
  The cause was never established. Builds and Studio tests both work regardless, so **do not assume
  `rojo serve` is what feeds Studio** and do not burn time "fixing" it without asking.
- PowerShell 5.1: `Select-String` has **no `-Recurse`**. Use
  `Get-ChildItem -Recurse -Filter *.ts | Select-String …`.
- `tsconfig.json`: `baseUrl: "src"`, `rootDir: "src"`, `outDir: "out"`, `strict: true`,
  **`noLib: true`**, `typeRoots: ["node_modules/@rbxts", "node_modules/@flamework"]`,
  `experimentalDecorators: true`. Imports use the `baseUrl`, e.g. `shared/config/arena.config`.
- **The repo is its own git remote's clone** (`github.com/DMorrisonASC/roblox-dodgeball`), and the
  only tracked documents are `HANDOFF.md`, `README.md`, `TAGS.md` and `SHOP-PANEL-BRIEFING.md`.
  `README.md` is upstream boilerplate and says nothing about this project.

---

## 2. House style — read this before editing anything

The codebase has an unusually heavy, deliberate comment style. Match it; do not trim it.

- **Every non-obvious decision carries a paragraph explaining why it is that way and what the
  alternative would have cost.** Comments frequently name the bug they prevent.
- The voice is essayistic and specific: `**A missing map is a warning, not an error.**` followed by
  a prose justification. Bold lead sentence, then reasoning, then often a "**What this is not:**".
- Comments reference other files and methods by name in backticks (`{@link}` for TSDoc links), and
  they are expected to be **kept in step with the code**. Renaming a method means finding the
  comments that describe it.
- Config files carry the same treatment: every tuning value explains itself and marks itself
  `**Placeholder.**` if nothing reads it yet.
- Files are generally ordered: imports, constants with docs, the class/function, module-level
  helpers at the bottom.

A comment that argues for a design and a comment that argues against it cannot both be left behind.
If you reverse a decision, update its justification.

---

## 3. roblox-ts / Flamework footguns (all hit for real in this repo)

| Footgun | Symptom | Fix |
|---|---|---|
| Getters / setters are not supported | `TS roblox-ts: Getters and Setters are not supported!` | Use methods — e.g. `playersInRound()`, `getTimeRemaining()` |
| `implements <yourInterface>` on a `@Service()` / `@Controller()` | A bogus identifier such as `GameMode@RoundView` appended to the **git-tracked** `flamework.build`, permanently | Drop the heritage clause. Structural checking at call sites (`this.mode.outcome(this)`) enforces the same contract |
| A plain class under an added path | Registered too (e.g. `ScoreRushMode@ScoreRushMode`) — inert, points at real modules | Expected; harmless |
| `new Instance("X", { Parent })` | Does not compile | Construct then assign `.Parent` |
| `next`, `end` | Reserved words — `end` in particular is the compiler's own | Rename |
| Unary `+` | Unsupported | Use `-(-x)` or a different formulation |
| `Set.size()` / `Map.size()` | Not a property in Luau | Call them |
| Nested template literals | Compiles to backticks-inside-backticks; parses and renders **empty** | Build the inner string into a `const` first, never nest |
| `async` methods in a loop | roblox-ts turns `async` into a promise chain. **A throw inside becomes an unhandled promise rejection and the loop stops permanently** — no error, no retry | Guard before you can throw. This exact bug cost a whole debugging session; see §10 |
| **No `Object.values` / `Object.keys`** | `'Object' only refers to a type, but is being used as a value here.` | `for (const [k, v] of pairs(table))` — the idiom `economy.config.ts` and `DevService` use |
| **`Map` has no `.keys()` in roblox-ts's type** | `Property 'keys' does not exist on type 'Map<…>'` | Iterate with `for (const [k, v] of map)` or `map.forEach((value, key) => …)` |
| **`JSONEncode` is not a global** | `Cannot find name 'JSONEncode'` | `HttpService.JSONEncode` — import `HttpService` from `@rbxts/services` |
| **Literal-type inference on `const` from a config** | `Type 'number' is not assignable to type '10'.` | Annotate: `let coins: number = ECONOMY_CONFIG.MATCH_BASE_COINS` |
| **`Player.LoadCharacter` is deprecated** | `@deprecated LoadCharacterAsync` in `@rbxts/types` | Use `LoadCharacterAsync`. Both are tagged `Yields`; only one address, `RespawnService.loadNow` |
| **`task.cancel` on the running thread** | The timer's own callback is still in the pending map when it fires, so `cancelPending` cancels *itself*; whether the thread resumes is engine behaviour | Delete the row **before** calling the load — see `RespawnService.schedule` |
| **`CharacterAutoLoads` and `RespawnTime` are mutually exclusive** | With auto-load on, the setting that makes an out-of-round respawn instant (`RespawnTime = 0`) also makes an in-round death instant, so the delay cannot exist | `CharacterAutoLoads = false`, and one service owns every load — see §12 |
| **`PivotTo` on an anchored part** | Moves nothing useful | `dodge.config.ts` records the alternative in its own comment |

**`flamework.build` hygiene:** the file is tracked in git and only ever *adds* identifiers. Before
reporting, run `git diff --stat flamework.build` — it should be silent unless you deliberately added
a service or controller. If it gained junk:

```powershell
Remove-Item out -Recurse -Force; Remove-Item flamework.build -Force; npm run build
```

**Injection:** constructor injection everywhere. `@Dependency` is exported but unused in this
codebase — match the existing style.

---

## 4. Source map — who owns what

```
src/shared/                      runs on both sides
  constants.ts                   attribute + folder + tag names — the HUD's vocabulary
                                 (ROUND_STATE_ATTRIBUTE, TEAM_ATTRIBUTE, SPECTATING_ATTRIBUTE,
                                 RESPAWN_AT_ATTRIBUTE, COINS_ATTRIBUTE, OWNED_ITEMS_ATTRIBUTE,
                                 CROWN_ATTRIBUTE, STAT_HITS, MATCH_JOIN_A_TAG, MATCH_SPAWNER_TAG,
                                 CHARACTER_BARRIER_TAG, SHIFT_LOCK_ZONE_TAG, …)
  ability.ts                     AbilityKind (Pierce | MultiBall | Freeze), ABILITY_NAMES,
                                 isAbilityKind, isBallAbility, abilityOn(ball)
  economy.ts                     EconomyRecord / SavedEconomy, blank + shape-check, and the
                                 string <-> Set helpers for the two attribute-backed sets
  gameMode.ts                    GameModeId, GAME_MODE_NAMES, MODE_SIDE_NAMES, sideNameOf,
                                 MODE_TEAM_COLORS, teamColourOf, encodeModeIds/decodeModeIds, isGameModeId
  networking.ts / remotes.ts     @rbxts/net event declarations; the throw RemoteEvent's names
  taggedParts.ts                 taggedParts / taggedPartsInWorkspace — a tag on a container
                                 expands to its BasePart descendants
  find.ts                        findFolder — whole-subtree walk with the class as part of the
                                 question
  throw.ts / dodge.ts / module.ts
  Trajectory.ts / AimGuide.ts / TrailEffect.ts / CollisionIgnore.ts
  ringPattern.ts                 the white RGBA halo/band/rosette maths for the team rings
  config/*.ts                    arena, ball, catch, dodge, gameMode, npc, action, aim,
                                 character, debug, economy, images, ring, shiftLock, shop, sound,
                                 stats, super, transition, ui

src/server/
  main.server.ts                 boot: collision groups, ignite, CharacterAutoLoads = false, shield
  collision/CollisionGroups.ts   PhysicsService + Workspace groups; applyBarrierGroups()
  services/round/                RoundService, VoteService (dormant), roundStatus.ts, team.ts,
                                 modes/{GameMode,TeamEliminationMode,ScoreRushMode,DodgeAndSeekMode,registry}
  services/match/MatchService.ts opt-in roster, the two join parts, the counts signs
  services/economy/EconomyService.ts  coins, powers, cosmetics, milestones, the chest
  services/character/            RespawnService, WalkSpeedService, SpawnShield
  services/ball/                 BallService, BallFactory, BallSpawnerService, BallPickupService,
                                 BallTrail, ballExpiry, SphereService, ThrowProbe, SoundEmitter
  services/actions/              ActionService, CatchService, DodgeService, FreezeService,
                                 actionLock, readyAt
  services/super/SuperService.ts streak, charge (dev-only), MultiBall window, crowns
  services/stats/StatsService.ts hits + outs, DataStore "PlayerStats", autosave
  services/visual/OutlineService.ts   per-body Highlight, team colours, freeze override
  services/npc/NpcService.ts     + npc/Behavior.ts, npc/behaviors/*
  components/BallComponent.ts    the throw -> hit path (friendly-fire guard, tag deferral, splash)
  dev/                           DevService + dev.config (chat commands and flags)
  config/                        match.config.ts, outline.config.ts

src/client/
  main.client.ts
  aiming.ts / freeLook.ts / sprinting.ts   tiny Fusion Values shared between two controllers
  IasTest.ts                     finished input test, DEBUG = false, meant to be deleted
  ui/                            screenGui.ts (HudGui / SplashGui / TransitionGui), hudTheme.ts,
                                 viewportConstraint.ts, hudToast.ts
  controllers/hud/               RoundStatus, RoundResult, RoundTransition, LoadingScreen,
                                 RespawnHud, CurrencyHud, SuperHud, StatsBillboard, Spectator,
                                 CooldownHud, ThrowStateToast, ControlsLegend, ModeVote,
                                 CameraToast, Theme, Shop (still the mock — see §11)
  controllers/input/             Action, Catch, Dodge, Throw, AimTarget, SuperAbility,
                                 AlternativeMovement, Sprint
  controllers/camera/ShiftLock.ts
  controllers/character/         LocomotionAnimationController, TeamRingController
  controllers/audio/MusicController.ts
```

---

## 5. The round lifecycle — the most important section

`RoundService.gameLoop()` is one `async` method containing two nested loops, and it no longer runs a
round on a timer. **The intermission waits for a match to be asked for** — the loop's condition is
`while (this.pendingMatch === undefined)`.

### Intermission entry (top of `gameLoop`)

1. `state = Intermission`, `activePlayers.clear()` — **after this point the round roster is gone**;
   anything that needs "who was just playing" must use `Players.GetPlayers()` instead.
2. Print, then publish `ROUND_STATE_ATTRIBUTE = "Intermission"` and `ROUND_TIME_ATTRIBUTE` at the
   **full** `ARENA_CONFIG.INTERMISSION_SECONDS` (16) — published *before* anything that can hold,
   so a held intermission cannot read as a frozen round.
3. `await this.waitForLobby()` — holds indefinitely if the arena has no `LobbySpawns` parts, and
   prints once on the way into the wait and once on the way out.
4. `await this.transitionAround(() => this.teleportAll(lobby), { wipe: WIPE_AT_ROUND_END })`.
5. `this.clearEndedRoundHeldBalls()` — strips held balls from all players + rigs in `Workspace`.
6. `this.matches.clear()` — the roster is forgotten, so everybody picks a side again.
7. Per player: `this.abilities.clearMultiBall(player)` and `this.respawns.cancel(player, true)`.
8. `this.freezes.unfreezeAll()`.
9. **No map swap.** The arena is permanent; nothing is cloned, placed or destroyed (§6).
10. Seed `elapsed = 0`, `settledFor = 0`, `roster = this.matches.rosterRevision()`.

### Intermission loop — `while (this.pendingMatch === undefined)`

- **Freeze, never skip:** `if (this.isRoundsPaused() || this.belowMinimum()) { settledFor = 0;
  task.wait(1); continue; }`. A dev's `RoundsDisabled` flag or fewer than
  `ARENA_CONFIG.MIN_PLAYERS` (2) stops the clock. Nothing is decremented, so a server that fills up
  later resumes the same intermission. **The settle count goes with the clock** — a half-empty
  server is not accumulating a start.
- **The vote is switched off** — `const VOTE_ENABLED = false;`. The `openVote`/`closeVote` calls
  stay exactly where they are so turning it back on is one line. `ModeVoteController` therefore has
  nothing to show and the vote row never appears.
- The clock ticks and **wraps** rather than reaching zero: `if (this.timeRemaining <= 0) {
  this.timeRemaining = ARENA_CONFIG.INTERMISSION_SECONDS; elapsed = 0; }`. Reaching zero is not a
  boundary any more; the countdown is the honest sign that the server is alive.
- **The normal start — the settle window.** This is how a round begins on a live server: the sides
  fill up, hold still, and the match opens by itself. `!dev match` is the manual override for
  testing, not the other way round. Read against
  `matches.rosterRevision()` rather than the counts, because a side switch leaves the counts
  identical and that crossing is exactly what this window exists to wait out. Revision changed →
  `settledFor = 0`. Revision unchanged and `matches.canStart()` → `settledFor++`, and at
  `>= MATCH_SETTLE_SECONDS` (5) it prints `[Round] starting on its own — the sides held still for 5s`
  and calls `startMatch(SCORE_RUSH)`.

**Two things can start a match, and both go through `startMatch`**, so `pendingMatch` has one
writer: the settle window above, which is the normal path, and a dev's `!dev match` (`requestMatch`,
which prints its own refusals) as the manual override. A dev request that arrives a moment earlier
wins, because the settle branch is only reachable while `pendingMatch` is unset.

### Round boundary

1. `await this.waitWhilePaused()`.
2. `if (VOTE_ENABLED) this.votes.closeVote();` (a no-op when the window never opened).
3. `this.clearHeldBalls()` — nobody carries a ball into a round.
4. **The request is consumed here, above the arena check, and that ordering is deliberate.** A
   request cleared only on the successful path would survive a refused start and the loop would come
   straight back to this line with the request still in flight and spin — no clock, no pause, no
   teleport, just `cannot start` a frame apart. So `const requested = this.pendingMatch;
   this.pendingMatch = undefined;` comes first.
5. **The arena guard.** `const arena = findArena(); const problem = arenaProblem(arena);` — on
   failure, `print("[Round] cannot start — … Waiting for another match.")` and `continue`. This
   exists because of the `async` footgun in §3: `getRandomTeamSpawn` raises when a side's spawn
   folder is missing, and a throw inside this loop stops the loop for the life of the server.
6. `applyBarrierGroups()` — **every round**, idempotent, by tag. `MapService.placeCurrent` used to do
   this as a side effect of placing the clone; with nothing placed, the pass has to be called, and
   once a round rather than once at boot because place files are edited while a server is running.
7. `state = Playing`, `mode = requested ?? SCORE_RUSH`, publish `ROUND_MODE_ATTRIBUTE`.
8. `scores.clear()`, `roundHits.clear()`, `roundOuts.clear()`, `finished = false`.
9. `assignTeams()` from `matches.roster()` — writes `teams` and `TEAM_ATTRIBUTE`, then
   `refreshCrowns()`. Then per player: `abilities.resetForRound(player)`, spectators get
   `SPECTATING_ATTRIBUTE = true`, participants go into `activePlayers`.
10. Print `[Round] started`/arena-resolved, set `timeRemaining = ROUND_SECONDS` (150), publish
    `"Playing"` + the clock, clear `ROUND_WINNER_ATTRIBUTE`.
11. `await this.transitionAround(() => this.teleportTeamsToArena(), { holdEveryoneFor:
    ARENA_CONFIG.ARENA_FREEZE_SECONDS })` — the arena-entry hold, which is why the round's clock and
    the hold are one moment written twice rather than two durations kept in step.

### Playing loop — `while (this.timeRemaining > 0)`

1. `if (this.finished) break;` — checked **before** the pause: a round whose side has emptied is over
   even while a dev holds rounds up.
2. `if (this.isRoundsPaused()) { task.wait(1); continue; }`
3. Tick the clock, publish it, then `const outcome = this.roundOutcome(); if (outcome !== undefined)
   { this.finishRound(outcome); break; }`.

Then `await this.waitWhilePaused();` and back to the intermission.

### Ending a round

- `roundOutcome()` = `this.rosterOutcome() ?? this.mode.outcome(this)`. **The roster is checked first
  and outranks the mode**: if one side has nobody left *connected to the server*, the other side has
  won. Both sides empty → `DRAW`.
- `rosterOutcome()` counts `Players.GetPlayers()` against `teams`. A mid-round joiner is in `teams`
  for neither side, so a spectator cannot rescue a side that just emptied.
- **A departing player can end a round** and does so from the `PlayerRemoving` handler the moment
  they leave rather than on the next tick — measured in a live log at **27 ms** from disconnect to
  `[Round] Team A won`.
- `finishRound(outcome)` is **idempotent** via `this.finished`. In order: print the score for scoring
  modes, write `ROUND_WINNER_ATTRIBUTE`, `sendResult(outcome)`, **`this.economy.onRoundEnded(outcome,
  this.teams, this.roundHits)`**, print `[Round] <result>`. Two callers reach it (the tick and
  `PlayerRemoving`) and the first wins.
- `sendResult(outcome)` returns immediately on `DRAW`; otherwise it builds one row per winning-side
  player from `roundHits`/`roundOuts`, sorts by hits, and sends `roundResult` to everyone.

### Death and elimination

`handleDeath(player)`:

1. Optional verbose print; `abilities.clearMultiBall(player)` and `freezes.unfreeze(dying)` — the
   freeze comes off while the body is unambiguously still there.
2. `if (this.state !== RoundState.Playing) { this.respawns.loadNow(player, "outside a round");
   return; }` — a death in the lobby is not an elimination, **but a body is still owed**.
3. `if (!this.activePlayers.has(player)) { player.SetAttribute(SPECTATING_ATTRIBUTE, true);
   this.respawns.loadNow(player, "outside a round"); return; }` — a spectator dying again.
4. `abilities.noteDeath(player)` then `const decision = this.mode.onDeath({ player }, this)`.
5. `eliminate` → `this.eliminate(player); return;` — otherwise `setTeam` if the mode named a side,
   and **`this.respawns.schedule(player, ARENA_CONFIG.RESPAWN_DELAY_SECONDS)`** — the only delayed
   respawn in the game.

`eliminate(player)`: `activePlayers.delete`, `SPECTATING_ATTRIBUTE = true`, `stats.recordOut`,
`roundOuts` += 1, and `this.respawns.loadNow(player, "eliminated")` — instant, never delayed.

### `DeathEvent` has no cause field

`{ player }` only. There is deliberately no `byHit`. No mode distinguishes a hit from a reset, and
the code says so in several places. Do not reintroduce it.

---

## 6. The arena

**There is a permanent arena and it is authored in the place file.** `ARENA_CONFIG.ARENA_NAME =
"ArenaV2"`, a direct child of `Workspace` — "the one lookup in the round that pins a location rather
than searching for one". The doc records the history: the arena used to be cloned from
`ServerStorage` into `Workspace` at the round boundary and destroyed at the end of the round, and
**`ArenaV1` was replaced wholesale by `ArenaV2`** — the version suffix is real and has already moved
once.

**The code that did the cloning is deleted, as of this revision.** `src/server/services/MapService.ts`
and `src/shared/config/map.config.ts` are gone, and `RoundService` no longer carries the injection
that pointed at the service. Nothing about the arena changed to make that possible — it had been
dead since the arena became permanent, and the deletion is the tidying that decision always implied.
The reasoning those files carried is deliberately **not** preserved anywhere: a deleted file's
comments are gone with it, and the only thing worth keeping is the one-line history here.

- **The lobby is now inside the arena.** `ARENA_CONFIG.LOBBY_SPAWNS_FOLDER = "LobbySpawns"`, a folder
  of spawn parts replacing the single `LOBBY_SPAWN_NAME = "LobbySpawn"` part. That name is still
  declared and has exactly one reader: the `DescendantRemoving` watcher in `RoundService.onStart`,
  which fires when a part of that name is removed from `Workspace` and prints its position, its tags
  and a traceback. The watcher is live scaffolding for a part that went missing mid-session (see §5),
  not a rule — **whether to delete the watcher and the constant together is a separate decision**,
  and not one this revision made.
- Team spawns live in `ArenaSpawns/{A,B}` inside the arena (`ARENA_SPAWNS_FOLDER`,
  `ARENA_TEAM_FOLDER_A/B`).
- `findArena()` and `arenaProblem(arena)` are module-level functions at the bottom of
  `RoundService.ts`. `arenaProblem` returns **a sentence naming the missing path**, which is what
  turns "the spawn list is empty" into something a person can act on.
- **The map rotation is deleted, not merely dormant.** `MapService.ts` and `map.config.ts` were the
  whole of it: a clone → hold → place → unload → rotate system whose only entry point was a
  `RoundService` constructor parameter that **nothing ever called** (`this.maps.` appears nowhere in
  the file), which is what made the removal a deletion rather than a surgery. `ArenaV1` is now named
  by nothing in `src/`; whether a `ServerStorage` template of that name is still parked in the place
  file is a place-file question, not a code one. **Rebuilding map swapping means writing it again
  against the permanent arena** — there is no dead code left to extend.
- **Barriers.** `CHARACTER_BARRIER_TAG` parts are put into the `Barrier` collision group by
  `applyBarrierGroups()`, called at every round boundary. See `CollisionGroups` and §3's note about
  the class check that a real place file forced out.
- The old map-placement open items are moot — the decision they described has been made and the code
  deleted — with one replacement: **nothing sweeps the
  arena any more.** Loose balls, corpses and ability debris each have their own lifetime — the
  account is written out at the round boundary, and it is the thing to read before adding a new
  thing that leaves something behind.

---

## 7. Balls

- `BallService` owns everything about a ball in a hand: `heldBalls: Map<Model, HeldBall>`. All four
  ways a ball enters a hand pass through one private `attachToHand` (hand-out, refill after a throw,
  catch, pickup).
- `dropBall(model): boolean` — puts it **in the world** (cast forward, lockout, armed=false, network
  owner released, expiry scheduled).
- `removeBall(model): boolean` — **destroys** it and removes the map entry. The entry is deleted
  *before* `Destroy()`, deliberately: `isHeld` answers from that map and both `scheduleBallExpiry`
  and the spawner's cleanup ask about a ball on its way out.
- **Two held-ball cleanups, two different jobs:**
  - Round **start** — `RoundService.clearHeldBalls()`, players only, at the boundary.
  - Round **end** — `RoundService.clearEndedRoundHeldBalls()`, at intermission entry, via
    `roundParticipants()` (module-level): every player's character plus every `NPC_TAG`-tagged
    `Model` that `IsDescendantOf(Workspace)`. Prints `[Round] cleared N held balls` only when it
    cleared something.
  - Both **destroy** rather than drop. Since the round-end body reload was removed (§12),
    `clearEndedRoundHeldBalls` is the **only** thing that takes a held ball away at a round
    boundary — it runs before the respawn-cancel loop for exactly that reason, so the ball is
    removed from a live character and the `heldBalls` row is cleaned up properly.
- **Tags:** `"Ball"` on every ball (must match `BallComponent`'s decorator literal — Flamework reads
  it at build time, so it is a copy, not an import); `"RoundBall"` only on balls the spawner created;
  `"MatchSpawner"` painted in Studio on the parts the spawner reads. **`TAGS.md` is the register**, and
  it is current: thirteen tags, including the four it was missing — `MatchJoinA`, `MatchJoinB`,
  `ShiftLockZone`, and the `MatchJoinTouched` debounce, which is the one tag that is state rather than
  a label.
- **`BallSpawnerService`** — still so named, but it reads `MATCH_SPAWNER_TAG`. **One ball per tagged
  part** (not the old `BALLS_PER_SPAWNER = 3`), under a total budget of `MATCH_BALL_COUNT = 8`
  counted from the `RoundBall`-tagged balls that exist each tick. It spawns **only while
  `ROUND_STATE_ATTRIBUTE === "Playing"`** and tops up on the `Playing` edge, sweeps every `RoundBall`
  on the `Playing -> Intermission` edge (leaving held balls alone), and finds its parts through
  `taggedPartsInWorkspace` so a parked template cannot be stocked. **No replenishment timer** — every
  match ball is scheduled with an infinite lifetime. `report()` prints
  `N tagged thing(s), M usable part(s)` and is the line that says whether the tag matched at all.
- **Pickup is automatic** — `BallPickupService` runs one loop that collects a nearby loose ball for
  every player (and rigs via `Behavior_Pickup`). It owns the *search*; `BallService` does the attach.
  There is no prompt UI.
- The trail is `BallTrail` — two interleaved layers (a bright core and a softer halo at half-step
  angles around the ball's own axis), armed only while a ball is in flight. `shared/TrailEffect.ts`
  is legacy and unused in practice.
- **Sounds** come from one shared `SoundEmitter.emitSound(cframe, name, id, emitterName)` — an
  anonymous part in `Workspace`, one emitter name per event so a leftover is attributable. Impact,
  catch, dodge, throw, freeze burst and freeze aura all use it.
- The throw -> hit path is `BallComponent.handleTouch`, and its two non-obvious rules:
  - **Friendly fire is refused globally, before any damage**, via
    `RoundService.isFriendlyFire(throwerToken, victim)` — a fact about the round, not a mode method.
    Every mode, no exceptions, and it only answers `true` while a round is actually playing.
  - **A hit is deferred to landing.** A body contact only *tags* the body; the ball carries on. The
    tagged bodies die when the ball hits something that is not a body, in the world branch
    (`resolveTags` -> `landHit` -> `TakeDamage`). A catch before then clears the tags and nobody
    dies. Other balls are scenery unless the throw already owes a tag.

---

## 8. Game modes

`src/server/services/round/modes/GameMode.ts` defines the interface, `RoundView` (what a mode may see
of the round), `DeathDecision`, `DeathEvent`. `registry.ts` maps ids to instances; `team.ts` holds
`TEAM_A`, `TEAM_B`, `DRAW`, `TeamLabel`, `RoundOutcome`. Names/colours/side-names live in
`shared/gameMode.ts`, so the **client can format the HUD without a mode table of its own**.

Three modes exist:

- **Team Elimination** — symmetric, hit eliminates, last side standing.
- **Score Rush** — TDM, respawns, first to `SCORE_RUSH_TARGET` (30) or the clock; the only mode with
  `scores = true`, so it is the only one `hitAward` is ever called on.
- **Dodge and Seek** — asymmetric. `SEEKERS = TEAM_A` (the side `splitEvenly` gives the odd player
  to), `DODGERS = TEAM_B`. One seeker picked at random unless there is only one player (then
  everybody is a dodger, so the round has something to be). `onDeath` always returns
  `{ kind: "respawn", team: SEEKERS }` — a hit *converts* rather than eliminates, so a reset is never
  a winning move **by construction**, not by a rule. `outcome` reads one number: zero dodgers ->
  seekers win; clock at zero with >=1 dodger -> dodgers win; nobody in the round -> `DRAW` (checked
  first, because an empty round would otherwise read as "zero dodgers").

**Only Score Rush is reachable in play.** `VOTE_ENABLED = false`, and both start paths pass
`SCORE_RUSH` literally (`startMatch(SCORE_RUSH)` in the settle window, `requestMatch` ->
`startMatch(SCORE_RUSH)` for `!dev match`). The other two modes are implemented and registered but
nothing in the game selects them. `mode = requested ?? SCORE_RUSH` is the line that would need to
change, and `VoteService` is intact but dormant.

Modes are **not** aware of friendly fire, of the roster rule, or of the arena. Voting: 10 s closing
buffer, majority, ties broken at random among the tied ids — the zero-vote case is a three-way tie and
falls out of that same rule. `VoteService` warns once at startup if the derived window would fall below
`VOTE_MIN_SECONDS`.

---

## 9. UI standard — mandate, not preference

> *"For ALL UI code in this project, you must follow a strict 'Responsive Web' architectural standard
> unless I explicitly tell you otherwise."*

1. **Flexbox over math** — `UIListLayout` / `UIFlexItem`, no hand-computed offsets.
2. **Grids over pixels** — `UIGridLayout` for collections.
3. **Relative padding** — `UDim2.fromScale` / `UDim` with a scale component, not raw pixels.
4. **Constraints** — `UISizeConstraint` / `UIMinSize` so nothing collapses or explodes.
5. **Automatic sizing** — `AutomaticSize` on the content axis.
6. **ZIndex safety** — explicit, documented ordering where panels can overlap.

The test to apply: **"If the screen resizes to a phone or an ultrawide monitor, will this leak or
overlap?"** `src/client/ui/viewportConstraint.ts` exports an `addViewportConstraint` helper used by the
HUDs. Theme is **LIGHT** big-ui; `hudTheme.ts` centralises it, and a HUD that has been migrated is
not allowed to write `Color3.fromRGB` itself — the shop predates that seam and still uses its own
palette from `shared/config/shop.config.ts`.

**The HUD inventory** (`src/client/controllers/hud/`), which is the list to check when the screen is
wrong:

| Controller | Shows | Reads |
|---|---|---|
| `RoundStatusController` | phase, clock, mode name, player count | `ROUND_STATE_ATTRIBUTE`, `ROUND_TIME_ATTRIBUTE`, `ROUND_MODE_ATTRIBUTE` |
| `RoundResultController` | the end-of-round board | those two + the `roundResult` event |
| `RoundTransitionController` | the grid wipe | `ROUND_TRANSITION_ATTRIBUTE` |
| `LoadingScreenController` | the join overlay | no attribute — three runtime signals |
| `RespawnHudController` | tenths countdown, above centre | `RESPAWN_AT_ATTRIBUTE` |
| `CurrencyHudController` | `Coins: N`, under the shop button | `COINS_ATTRIBUTE` |
| `SuperHudController` | streak / charge / armed ability / MultiBall window | the four `SUPER_*` attributes + the held ball's mark |
| `StatsBillboardController` | per-head hit/out record, and the crown | `STAT_HITS`, `STAT_OUTS`, `CROWN_ATTRIBUTE` |
| `SpectatorController` | "You're out — spectating" | `SPECTATING_ATTRIBUTE` |
| `CooldownHudController` | dodge / catch / stamina bars | `DODGE_READY_AT`, `CATCH_READY_AT`, `STAMINA_ATTRIBUTE` |
| `ThrowStateToastController` | throwing on/off toast | `THROW_ENABLED` |
| `ControlsLegendController` | the control legend | `THROW_ENABLED` |
| `ModeVoteController` | the vote row — **dormant**, nothing opens a vote | the `ROUND_VOTE_*` attributes |
| `CameraToastController` | "camera locked/unlocked" | the `freeLook` module |
| `ThemeController` | configures the big-ui theme | — |
| `ShopController` | **a static mock** — no remotes, no purchase logic | — |

Two shared pieces worth knowing about: `ui/hudToast.ts` (the bottom-centre toast column, used by the
throw toast and the camera toast) and the three small module-scoped Fusion values
(`freeLook.ts`, `aiming.ts`, `sprinting.ts`) that carry one fact between two controllers without
either depending on the other.

---

## 10. Recent work, and the debugging stories worth knowing

### The `async` game-loop death (still the most important story)

Symptom: HUD frozen at `Intermission — 0s`, for ever, with nothing after one rejection in the output.
Cause: `getRandomTeamSpawn` called `error()` inside `gameLoop`, which is `async` → the throw rejected a
promise nobody handled → **the loop stopped permanently**. The throw fired *before*
`ROUND_STATE_ATTRIBUTE` was set to `"Playing"`, which is why the HUD looked stale rather than broken.
Fix: the `arenaProblem()` guard at the round boundary, before anything is half-started.

Two hypotheses from the spec were wrong and were corrected in the report: that the roster rule only
fires when `timeRemaining > 0` (the loop checks every tick), and that a round could leave the loop by a
second route (there is exactly one). The user accepted both corrections.

### The HUD that hid its own result

Symptom: "it immediately showed 'Waiting for player — 1/2', it was not obvious that the other team
won." Cause: `RoundStatusController`'s `Fusion.Computed` **returned early** in the below-minimum
branch, so the mode name and the winner never got appended — and the most common way to drop below two
players is somebody leaving, which is exactly when a round has just been decided. Fixed by making the
waiting text replace only the *clock* segment.

The same fix hoisted all five `use()` calls to the top: **Fusion derives a `Computed`'s dependencies
from the `use()` calls that actually run**, so a read inside an `if` is a subscription that only exists
while that branch is taken. Watch for this in any new HUD computation.

### The log that was right about the aim preview

Symptom, from the user: "The trajectory shows that it would not hit the NPC. but it did."

The drawn arc and the thrown ball disagreed because they ask different questions of the same ball. A
physics sweep asks a part's `CanCollide`; the preview's cast asks `CanQuery`
(`RaycastParams.RespectCanCollide` is off, deliberately, because the midline wall's whole mechanism is
`CanQuery = false`). A ball in a hand is welded, massless and `CanCollide = false` — but `CanQuery`
was still true, so the *preview* stopped on the ball in a rig's hand a couple of studs short of the
body while the real ball flew through it and hit. Every throw at a rig, because a throwing rig's hand
refills immediately.

The fix is at the ball, not at the ray: `BallService.attachToHand` clears `CanQuery` for the length of
a hold. The generalisable lesson is the one §0 already states — **the log was the ground truth and the
reasoning about the code was wrong.**

### Balls appearing out of nowhere

Symptom: "ball appear out of nowhere when testplay", on a map that was not being played.

`NpcService` was the one tag reader that did not gate on `IsDescendantOf(Workspace)`, so the rigs
parked in a `ServerStorage` template were being driven — and threw balls into the world from a map
nobody could see. Fixed by the world gate, and it is the reason `taggedPartsInWorkspace` exists as a
first-class helper (§3, and `shared/taggedParts.ts`'s own doc lists the three tag-on-a-container bugs
it was written for).

### The trail that looked like a sticker

The ball trail went through two rewrites: a single ribbon (reads as a flat sticker because a `Trail`
always turns to face the camera), then several interleaved core ribbons, then the current two layers
— a bright core plus a softer, wider, longer-lived halo at half-step angles. The one that made it read
as a *lit tube* was the halo's half-step offset, and the colour step through amber rather than a
white-to-grey fade (which washed out). `BallTrail`'s class doc carries the whole argument, including
why it is deliberately not a `PointLight` or a particle emitter.

**Reversed (2026-10-08):** the *default* trail — what an un-equipped ball flies — is now flat grey
`(128, 128, 128)`, core and haze alike. The amber progression survives only inside the cosmetics, where
`coreLook` puts each def's own three colours and `haloLook` its own pair. The wash-out the amber step was
added to fix is a property of a *coloured* trail; the default's job is to read as "nobody's", and grey is
the one value the head's white-out cannot take away from it. The reasoning is in
`BALL_CONFIG.TRAIL_COLOR_LEADING`, which now argues for neutral rather than warm.

### Completed since the last handoff

Roughly in commit order (`git log` from 2026-09-28):

- Post-game board, controls-legend fixes, collision-group assignment for barriers.
- Custom aim (the aim guide removed in favour of `aiming.ts` + `AimTargetController`), left-hand
  controls, the curve-shot nudge, animation/sprint fixes.
- **Abilities: Pierce, then MultiBall, then Freeze** — R15-only, with the freeze's flash/aura/block/
  burst work (§11).
- Loading screen + intermission music.
- Round-start transition wipe (the grid).
- Ring: the arena's team rings, drawn client-side (`TeamRingController`, `shared/ringPattern.ts`),
  and the lobby moved into the arena.
- Voting switched off (`d994b15` removes the vote UI, `VOTE_ENABLED = false` in the code).
- **Collision groups rewritten** to `PhysicsService` + `Workspace` registration with `Barrier`.
- **One match mode**: the round lifecycle now waits for a match request, `MatchService` opt-in
  matchmaking, `MatchSpawner` replacing `BallSpawner`, the manual `!dev match`, new dev commands
  (§13).
- **NpcService world gate** (the fix above).
- **Ball trail rework** (the story above).
- **Respawn ownership, the streak/crown rework, and all-part catching** (`5bcc374`, §11, §12).
- **Uncommitted at the time of writing: the economy** (§11) — coins, the chest, the power lock,
  milestones, the premium catalog, `CurrencyHudController`.
- **The dead map rotation deleted.** `services/MapService.ts` and `shared/config/map.config.ts` are
  gone, the `maps` injection is out of `RoundService` (it had no call site), `flamework.build` was
  regenerated from a wiped `out`, and §6, §15 and `TAGS.md` were brought in step. See §6.
- **The comment audit — 37 stale comments across 14 files, then the counts they quoted.** Every
  comment in that pass argued for a decision the code had stopped making: a service the file no
  longer calls, a field that is no longer the reason for the line, a count that had grown. Comments
  only, no behaviour moved.
- **The counts, re-derived from the source and then either corrected or replaced.** Eight of them,
  plus `OutlineService`'s Ball tag. **Where the number moves every time a file is added it is now a
  description** — "every file that has to find a ball", "the services that care" — rather than a
  number that drifts stale again. Where the *claim* was wrong as well as the count, the claim was
  rewritten rather than renumbered: `SuperService`'s "read by nothing on this machine" was true of
  its four `SUPER_*` attributes and false of the crown, which `EconomyService` reads, and
  `BallService`'s "the remote handler below" pointed the wrong way — both handlers are above it.
- **`findModel` deleted from `shared/find.ts`.** Its only caller was `MapService.loadMap`, so the dead
  map rotation took it with it; `RoundService` is the only caller left in that file and it wants
  `findFolder`.

---

## 11. Abilities, the streak, and the crown

**The vocabulary is `shared/ability.ts`**: `AbilityKind = "Pierce" | "MultiBall" | "Freeze"`,
`ABILITY_NAMES`, `isAbilityKind` (does this build know the name), `isBallAbility` (can a *ball* carry
it), and `abilityOn(ball)` — the single reader of the ball's mark.

- **Pierce and Freeze are ball-carried** — the mark rides `BALL_ABILITY_ATTRIBUTE` on the ball.
- **MultiBall is player-carried** — a timed window on the player, and nothing about a thrown ball
  carries it. That is why `isBallAbility` exists as a *narrower* test than `isAbilityKind`: without
  it a client could send the word for a player buff and have it stamped onto a ball.

**The charge system is intact but grants nothing.** `SUPER_CHARGE_ATTRIBUTE` is a boolean on the
player, `hasCharge`/`spendCharge`/`forfeitCharge` all work, and `SuperService` still counts the
streak — but the streak no longer *pays*: "Nothing grants a charge any more except the dev bypass in
`BallService`." The number that used to buy a charge (`STREAK_REQUIRED = 6`) is gone; what stands in
its place is `CROWN_STREAK_THRESHOLD = 3`, read as a threshold for something **visible**.

**The charge is spent at different moments per ability, deliberately**: MultiBall at the press
(a window bought is a window paid for), Pierce and Freeze at the *throw* (the charge follows the
ball, so marking a ball and changing your mind costs nothing).

**MultiBall** — `SUPER_CONFIG.MULTI_BALL_DURATION_SECONDS = 10`, `MULTI_BALL_BALL_COUNT = 5`
(counted in **throws**, not balls on the field). It refills the hand at the moment the window opens
and after each throw (`BallService.refillFromBuff`), the count running out does **not** close the
window, and the ball already in hand when the window closes stays there — "the ability stops giving,
and never takes back". Closed by its own clock, by death, by the intermission and by the round end.

**Freeze** — the splash numbers are two because they are two promises: `FREEZE_HIT_RADIUS = 8` from
the body part a Freeze ball *struck*, `FREEZE_MISS_RADIUS = 5` from where a ball *stopped* having
tagged nobody. The splash excludes the thrower and their own side. The look is four separate things,
each with its own creation switch: the **flash** at the marking press (a `PointLight` plus a brief
`Neon`, not a repaint), the **aura** on the carried ball, the **burst** at the impact, and the
**block** of ice around the frozen body — plus a `Highlight` recolour on the body. A Freeze ball is
un-catchable.

**Pierce** — `CollisionIgnore.between(ball, body)` for every body, so nothing alive stops it. It is
also un-catchable, and **the aim preview knowingly lies about it** (the comment says so); it is a
recorded open item, not an oversight.

**Catching is a shield now.** `CATCHABLE_PARTS` is gone and every limb catches; the honest
consequence is written in `catch.config.ts`: while the window is open, *any* body contact with a
catchable ball is a catch, so a catcher cannot be hit by an ordinary throw for that second, wherever
it lands on them. The window, the one-ball-per-window rule in `CatchService.consume`, and the two
abilities a catch cannot stop (Pierce and Freeze, refused in `BallComponent.canCatch`) are the
remaining knobs.

**The streak and the crown.** A miss no longer breaks the run — only **death** and the **round
boundary** do, and the round's reset happens as the next round *opens*, so the count a round ended on
stays on screen through the intermission. `refreshCrowns()` crowns a player at
`count >= CROWN_STREAK_THRESHOLD` (3) **or** at `count >= 1 && count === the best on their side`, and
a tie at the top crowns both. The crown is a boolean (`CROWN_ATTRIBUTE`) on the **player**, so a
respawn costs nothing; `StatsBillboardController` draws it above the head.

**The power lock.** Pierce, MultiBall and Freeze must be **owned** before the keys do anything:
`BallService.markHeldBall` and `BallService.activateMultiBall` both ask
`this.economy.ownsPower(player, kind)` and refuse with a `[Super] … not owned` line. A dev bypasses
the lock, the round gate and the charge — that is the only way to test an ability from a standing
start, and it is why `!dev powers` exists.

---

## 12. Economy

One currency, one chest, a roster of owned powers, a set of owned cosmetics, and two counters. The
whole thing is `EconomyService` + `economy.config.ts` + `shared/economy.ts`, and it persists as **one
DataStore record per player**.

- **Coins** are earned at the end of a match: `MATCH_BASE_COINS = 10` for finishing (win or lose),
  `+ MATCH_WIN_BONUS = 4` for the winning side, `+ min(roundHits, PERFORMANCE_COIN_CAP = 3)` for
  contributing, then clamped to `MATCH_COIN_CAP = 17`. A draw pays base + performance and no win.
  Coins are clamped to >= 0 on every write — the one number in the game that must never read as a
  debt. All of these are **Placeholders**.
- **The Power Chest** costs `CHEST_COST = 50` and grants **one random power the player does not
  own** — duplicates are impossible by construction (uniform over the unowned remainder), which means
  the last one is a guarantee and the anticlimax is accepted deliberately. Three distinct refusals
  are sent back on `chestResult`: "your record is still loading", "not enough coins", "all powers
  collected". The design acknowledges the whole system is a **tutorial at three powers** — the roster
  is `POWER_ROSTER`, and its length is the chest's lifespan.
- **Milestones** grant free cosmetics and are **never purchasable**. Seven of them over `matches`,
  `wins`, `hits` (read from `StatsService`'s lifetime `STAT_HITS`) and `crown`. `checkMilestones` runs
  after a load, at every round end, and when `CROWN_ATTRIBUTE` changes; it skips what is already
  owned, so it is idempotent and there is no per-milestone state to save.
- **The premium catalog** is `PREMIUM_COSMETICS` (derived from `COSMETICS` where `priceRobux > 0`) —
  Aurora trail 99, Ember trail 149, Lightning KO 249. **Every `gamepassId` is `0`**, i.e. a
  placeholder that has never been filled in, and nothing consumes one yet. The intent is one **Game
  Pass** per catalog item and **no Developer Products** at all, because the design has no repeatable
  purchase to sell.
- **Persistence** mirrors `StatsService`: DataStore `"Economy"`, load on join, autosave every
  `AUTOSAVE_INTERVAL = 180` s writing only changed records, a write on leave, and `BindToClose` on
  shutdown. Every call is `pcall`-wrapped, and a corrupt or absent record decodes to blank rather
  than to a crash (`shared/economy.ts` shape-checks it).
- **Dev commands registered here:** `!dev coins` (+1000) and `!dev powers` (grant the full roster).
- **What is *not* wired: the shop GUI.** `ShopController` is still the static mock — no remotes, its
  own catalogue from `shared/config/shop.config.ts`, and a mount line that prints
  `[Shop] button and panel up — no purchase logic, no remotes`. The `openPowerChest` remote exists
  server-side and **nothing on the client sends it**. Cosmetic application is likewise ownership-only:
  a trail cosmetic carries `colors` in the config, and the render hook that would read
  `BallTrail.attach`'s colours is a later step. `SHOP-PANEL-BRIEFING.md` is the accompanying brief for
  the shop's rendering problem.

---

## 13. Respawn

**The project owns every character load.** `Players.CharacterAutoLoads = false` in `main.server.ts`,
and `RespawnService` is "the only place `Player.LoadCharacterAsync` is called" — its class doc states
the rule as a rule: *a `LoadCharacterAsync` written anywhere else is a bug, and a grep for it in `src`
should return this file and no other.*

- **Why**, in the code's own words: "The two respawn rules this project wants cannot both belong to
  the engine: a death outside a round wants a body *now*, and the way to ask for that is
  `RespawnTime = 0` — while a death inside one wants a three-second wait. `RespawnTime` is one number
  for every death and the engine does not know a round exists, so with auto-load on the setting that
  makes the lobby instant makes the round instant too, and the in-round delay cannot exist beside it."
  `Players.RespawnTime` is therefore **deliberately not set**.
- **What a missed load site costs** — and this is the reason the rule is written down: "A path that
  forgets to ask for a body does not warn, throw or print: it leaves a player standing on nothing,
  with no character, no `CharacterAdded`, no HUD and no corpse, and the nearest thing to a symptom is
  a person who never appears."
- **The four moments a body is owed:** a join (`JoinService.welcome`, after the thrower token is
  stamped), a death outside a round, an elimination, and the end of an in-round wait. The last is the
  only delayed one: `respawns.schedule(player, ARENA_CONFIG.RESPAWN_DELAY_SECONDS)` (3 s), applied on
  the mode's `respawn` branch alone.
- **The two bugs the delay exposed, both fixed in `5bcc374`:** the timer's own callback was cancelling
  *itself* (`loadNow` -> `cancelPending` -> `task.cancel` on the running thread, immediately before
  the load yields), fixed by deleting the pending row inside the callback before calling `loadNow`;
  and `cancel(player, true)` was loading a body for **every** player at every round boundary, which
  rebuilt the whole server's characters — fixed by returning early when nothing was pending, so the
  flag means "do not strand a waiting player", not "always load". Both are footguns in §3.
- **The pending timer is owned state**: `pending: Map<Player, thread>`, one row per player, replaced
  on a second death. `RESPAWN_AT_ATTRIBUTE` publishes the *instant* the body is due on
  `Workspace:GetServerTimeNow()`, which is what lets `RespawnHudController` draw a smooth countdown
  with no remote, no local timer and no second answer to "how long is the wait".

---

## 14. Matchmaking

Opt-in, by walking into a part. A player in the lobby is **not** in a match until they touch a join
part — and the roster is forgotten at the end of every match, so they choose again next time.

- **Two parts, one tag per side**: `MATCH_JOIN_A_TAG` ("MatchJoinA") -> `TEAM_A`,
  `MATCH_JOIN_B_TAG` ("MatchJoinB") -> `TEAM_B`, in `MatchService`'s `JOIN_PARTS` table. This replaced
  a single `MatchJoin` part that "placed whoever touched it on whichever side was emptier" — the two
  parts are what let **the player choose**, by walking up to the sign they want, and touching the
  *other* part moves them again.
- **`Touched` is debounced per character** with a `MatchJoinTouched` tag for
  `MATCH_TOUCH_DEBOUNCE_SECONDS = 0.5`, and **one window covers both parts** — the mark lives on the
  character rather than the sign, so a body crossing straight from `A` into `B` inside the window
  gets one event rather than a side switch at random.
- **The roster is locked while a round is playing**: `optIn` refuses before it reads the roster when
  the phase is `Playing`. A full side is refused at the part with "try the other part", which is
  something the player can act on where they stand.
- **`MatchService.prepare` forces the part's properties** — `Anchored = true`, `CanCollide = false`,
  `CanTouch = true`, `CanQuery = false` — and warns naming anything it had to correct, because an
  unanchored sign once walked off the bottom of the world with nothing in the output.
- **The counts sign** is a `BillboardGui` above each part (`A: n/4`), repainted on every roster change.
- **Numbers** (`src/server/config/match.config.ts`, all Placeholders): `MATCH_MIN_PLAYERS = 2`,
  `MATCH_MAX_PER_TEAM = 4` (so a match is 4v4, and the cap is enforced at the part),
  `MATCH_BALL_COUNT = 8`, `MATCH_TOUCH_DEBOUNCE_SECONDS = 0.5`, `MATCH_SETTLE_SECONDS = 5`.
- **How a match starts:** the intermission's **settle window** is the normal path — a startable roster
  that has not changed for `MATCH_SETTLE_SECONDS`, read against `rosterRevision` (not the counts,
  because a side switch leaves the counts identical). `!dev match` is the manual override. Both go
  through `startMatch`, so `pendingMatch` has exactly one writer.
- **`MatchService.clear()`** empties the roster and repaints the signs; it is called at intermission
  entry, which is what sends everybody back to the pick-a-side part.

---

## 15. Open items and flags

Carried over from the previous handoff where still live, plus what this revision found.

1. **The economy is built and type-checked but never run.** Nothing in it has a Studio confirmation:
   not the DataStore round-trip, not `!dev coins`/`!dev powers`, not the chest reply
   (`events.Server.Get("chestResult").SendToPlayer`), not the round-end payout, not the milestone
   grants. It is also **uncommitted** as of this writing.
2. **The power lock means a brand-new player has no abilities at all.** Keys `3`/`4`/`5` refuse with
   `[Super] … not owned` until a chest grants one. That is the design working, but nothing in the UI
   says so yet — `SuperHudController` shows the streak/charge strip regardless, and there is no
   "locked" state and no "you don't own this" toast.
3. **The shop GUI is still the mock** (§12), and `SHOP-PANEL-BRIEFING.md` documents it rendering
   almost empty. The mock also contradicts the economy's design: it sells random *boxes* with odds,
   which is the one thing the economy deliberately does not do.
4. **Cosmetics are ownership-only.** Nothing renders an owned trail or elimination effect. The trail
   is the cheap one (the colours are config and `BallTrail.attach` takes no parameters today, so the
   override has to be threaded through `createRibbons` *and* the adopt-existing branch).
5. **Every premium `gamepassId` is `0`.** No Game Pass exists yet, so the catalog is unbuildable as
   a purchasable thing until the developer creates them in the dashboard.
6. **The aim preview still lies about Pierce** (recorded in `BallComponent`/`ThrowController` as
   known). The held-ball `CanQuery` half of that bug is fixed; the Pierce half is not.
7. **Only Score Rush is playable** (§8) — the other two modes are unreachable, and re-enabling them
   means deciding whether the vote comes back or the mode is chosen some other way.
8. **The `+3` stud lift** in the spawn lookup was kept against the user's own snippet and is still
   unconfirmed as wanted.
9. **`IasTest.ts`** is a finished input test with `DEBUG = false`, written to be deleted.
10. **`shared/module.ts` is a stub** (`makeHello`) and `src/shared/config/ui.fon` is an empty file.
    Both are dead weight.
11. **`rojo serve` exits 1** (§1). Cause unknown, not investigated.

---

## 16. What a live log has actually confirmed

Treat everything else as unverified. These were observed in the user's Studio output. Where the
system they were observed in has since been removed, that is said explicitly — a confirmation is
only worth anything about code that still exists.

**Still true of the current build:**

- The roster rule fired **27 ms** after a disconnect, and `[Round] Team A won` was published correctly.
- `MIN_PLAYERS` freeze: intermission started 23:03:52.880, vote opened 23:04:00.983 when player 2
  joined. *(The vote itself is now switched off; the freeze is still the mechanism.)*
- `[Round] cleared 1 held balls` at server start (an NPC rig was holding one from the place file).
- `[Ball] Player1's ball was destroyed` immediately before `Round started` — the round-start clear.
- `[Outline]` repaints and the `BallSpawnerService` sweep on the round-end edge.
- The respawn work: `[Respawn] <name>: loaded — joined` on a join, and a round-boundary
  `loaded — the round ended` for a player who was waiting. *(The second is also the evidence that
  found the every-player reload bug — see §13.)*
- `[Super] up — crowning at 3 hits, or the most on a side; nothing grants a charge but the dev
  bypass`, `[Spawner] up — watching RoundStatus.State, MatchSpawner: 6 tagged thing(s), 6 usable
  part(s)`, `[Match] up — MatchJoinA: 1 part(s)`, `[Collision] Barrier registered`.
- `[Shield] <name>: 0 removed, 1s applied`, `[Walk] <name>: 20 (Base:20)`, `[Animate] <name>: R15
  body` — the per-body lines that fire when a character arrives.

**Observed, but about systems that no longer exist — do not treat as current:**

- `[Map] loaded "RoLive Map"`, and the map unload -> load order 8 ms apart. The map is no longer
  cloned, the arena is `ArenaV2` in the place file, and the `MapService`/`MAP_CONFIG` pair that
  produced those lines has since been deleted. Nothing logs a map load any more.
- The vote window opening/closing timestamps (23:04:00.983 -> 23:04:21.352). `VOTE_ENABLED = false`.

**And one uncorrected hypothesis from the user that is worth re-checking before it is believed:** they
believed `TEAM_ATTRIBUTE` is not reassigned when a Dodge-and-Seek conversion happens. It **is** —
`RoundService.handleDeath` -> `setTeam` writes both `teams` and the attribute. The outcome is still
right, but for a different reason than was stated.

---

## Appendix — the other documents, and how far to trust them

| Document | What it is | State |
|---|---|---|
| `HANDOFF.md` | this file | current as of 2026-10-06 |
| `TAGS.md` | the register of every `CollectionService` tag (thirteen), with why the strings cannot be imported from each other | current as of 2026-10-06. Its "why there are copies" section is the thing to read before touching the `Ball` tag |
| `SHOP-PANEL-BRIEFING.md` | a briefing for a visual-capable model debugging the shop panel rendering almost empty, with exact colours and the layout tree | current, and still the best description of the mock's structure. The layout tree in it is the *mock's*; the economy's shop does not exist yet |
| `README.md` | upstream roblox-ts boilerplate | says nothing about this project; ignore it |
| `tools/pattern/` | the Node renderer and PNG output used to design the ring pattern (`shared/ringPattern.ts`) | one-off design tooling, not part of the build |
