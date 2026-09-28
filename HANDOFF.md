# Handoff — roblox-dodgeball

A guide for a fresh session. Written 2026-09-28 against a green build (`npm run build` → exit 0).

**Read this file, then read the actual source.** This document describes *where* things are and *why*
the shape is what it is; it deliberately does not reproduce code, because code copied into prose
goes stale silently. Every claim here that was verified by a live Studio log says so; everything
else is "built and type-checked, not run".

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

---

## 1. Stack and commands

| Thing | Version / note |
|---|---|
| roblox-ts | 3.0.0 |
| TypeScript | 5.5.3 |
| Flamework | 1.3.2 (`@flamework/core`, `@flamework/components`, transformer 1.3.2) |
| Rojo | `default.project.json` — `out/server` → `ServerScriptService.TS`, `out/shared` → `ReplicatedStorage.TS`, `out/client` → `StarterPlayerScripts.TS` |
| Fusion | `@rbxts/fusion-3.0` ^0.1.0 |
| big-ui | `@rbxts/big-ui` ^1.1.3 — theme is **LIGHT** |
| net | `@rbxts/net` for remotes |

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
| `next`, `end` | Reserved words | Rename |
| Unary `+` | Unsupported | Use `-(-x)` or a different formulation |
| `Set.size()` / `Map.size()` | Not a property in Luau | Call them |
| Nested template literals | Compiles to backticks-inside-backticks; parses and renders **empty** | Build the inner string into a `const` first, never nest |
| `async` methods in a loop | roblox-ts turns `async` into a promise chain. **A throw inside becomes an unhandled promise rejection and the loop stops permanently** — no error, no retry | Guard before you can throw. This exact bug cost a whole debugging session; see §10 |

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
  constants.ts                   attribute + folder names (ROUND_STATE_ATTRIBUTE, TEAM_ATTRIBUTE,
                                 SPECTATING_ATTRIBUTE, ROUND_STATUS_FOLDER, …) — the HUD's vocabulary
  gameMode.ts                    GameModeId, GAME_MODE_NAMES, MODE_SIDE_NAMES, sideNameOf,
                                 MODE_TEAM_COLORS, teamColourOf, encodeModeIds/decodeModeIds, isGameModeId
  networking.ts / remotes.ts     @rbxts/net event declarations
  throw.ts / dodge.ts / module.ts
  Trajectory.ts / AimGuide.ts / TrailEffect.ts / CollisionIgnore.ts
  config/*.ts                    arena, ball, catch, dodge, gameMode, map, npc, action, aim,
                                 character, debug, shop, stats

src/server/
  main.server.ts                 boot
  services/round/                RoundService, VoteService, roundStatus.ts, team.ts,
                                 modes/{GameMode,TeamEliminationMode,ScoreRushMode,DodgeAndSeekMode,registry}
  services/MapService.ts         clone / place / unload one arena at a time
  services/ball/                 BallService, BallFactory, BallSpawnerService, BallPickupService,
                                 BallTrail, ballExpiry, SphereService, ThrowProbe
  services/actions/              ActionService, CatchService, DodgeService, actionLock, readyAt
  services/character/            WalkSpeedService
  services/round/JoinService.ts
  services/stats/StatsService.ts
  services/visual/OutlineService.ts
  services/npc/NpcService.ts     + npc/Behavior.ts, npc/behaviors/*
  components/BallComponent.ts    the throw→hit path (friendly-fire guard lives here)
  dev/                           DevService + dev.config (chat commands, e.g. `!dev r on` freezes rounds)

src/client/
  main.client.ts
  ui/                            screenGui.ts, hudTheme.ts, viewportConstraint.ts
  controllers/hud/               RoundStatus, CooldownHud, ModeVote, Spectator, ThrowStateToast,
                                 ControlsLegend, StatsBillboard, Shop, Theme
  controllers/input/             Action, Catch, Dodge, Throw, AimTarget
  aiming.ts
```

---

## 5. The round lifecycle — the most important section

`RoundService.gameLoop()` is one `async` method containing two nested loops. Order matters
everywhere; it was reviewed line by line more than once.

### Intermission entry (top of `gameLoop`)

1. `state = Intermission`, `activePlayers.clear()` — **after this point the round roster is gone**;
   anything that needs "who was just playing" must use `Players.GetPlayers()` instead.
2. `print("Intermission started")`
3. `teleportAll(LOBBY_SPAWN_NAME)` — everyone to the lobby, which lives at `Workspace` root and
   belongs to no map.
4. `clearEndedRoundHeldBalls()` — strips held balls from **all players + NPC rigs in `Workspace`**
   (see §7).
5. `maps.unloadCurrent()` then `maps.loadMap(maps.pickNext())` — the old clone is destroyed, the next
   one is **cloned but not placed**. See §6.
6. Publish `ROUND_STATE_ATTRIBUTE = "Intermission"` and `ROUND_TIME_ATTRIBUTE`.

### Intermission loop (one tick per second)

- **Freeze:** `if (isRoundsPaused() || belowMinimum()) { task.wait(1); continue; }` — **freeze, never
  skip.** Nothing is decremented, so a server that fills up later resumes the *same* intermission,
  vote window intact. `belowMinimum()` reads `Players.GetPlayers().size() < MIN_PLAYERS` (2).
- `if (elapsed === 0) votes.openVote()` — the vote opens on the intermission's first **running**
  second, not at the intermission's start.
- `if (elapsed === GAME_MODE_CONFIG.VOTE_SECONDS) votes.closeVote()` — 20 s with a 30 s intermission
  (`INTERMISSION_SECONDS - VOTE_CLOSING_BUFFER`, floored at `VOTE_MIN_SECONDS = 3`).
- `elapsed` is counted beside the clock, so it measures *running* seconds and a paused intermission
  does not close its own vote.

### Round boundary

1. `await waitWhilePaused()`, then `votes.closeVote()` again (no-op if already closed — this is the
   call that matters when the window never elapsed).
2. `clearHeldBalls()` — **round-start** clear, players only, destroyed not dropped, so nobody carries
   a ball into a round. Note: largely a no-op now that the round-end clear also exists; kept because a
   player can pick a ball up *during* an intermission.
3. `const problem = mapProblem(maps.getCurrent())` — if defined: `print("[Round] cannot start — …")`
   and `continue`. **This guard exists because of the `async` footgun in §3.**
4. `maps.placeCurrent()` — the arena enters `Workspace` here, after the check and before any teleport.
5. `state = Playing`, `mode = modeFor(votes.selection()) ?? DEFAULT_MODE`, `scores.clear()`,
   `finished = false`, `assignTeams()`.
6. Every player → `activePlayers`, `SPECTATING_ATTRIBUTE = false`; `print("Round started — <mode>")`;
   `teleportTeamsToArena()`.
7. `timeRemaining = ROUND_SECONDS` (150), publish `"Playing"`, publish the clock, clear
   `ROUND_WINNER_ATTRIBUTE`.

### Playing loop (one tick per second)

1. `if (this.finished) break;` — checked **before** the pause, because a round whose side has emptied
   is over and a dev holding rounds up should not hold up a result that is already decided.
2. `isRoundsPaused()` → `task.wait(1); continue`.
3. Tick the clock, publish it, then `roundOutcome()`; on a result, `finishRound(outcome); break`.

### Ending a round

- `roundOutcome()` = `rosterOutcome() ?? mode.outcome(this)`. **The roster is checked first and
  outranks the mode**: if one side has nobody left *connected to the server*, the other side has won,
  whatever the mode was about to say. Both sides empty → `DRAW`.
- `rosterOutcome()` counts `Players.GetPlayers()` against `teams`. A mid-round joiner is in `teams`
  for neither side, so a spectator cannot rescue a side that just emptied.
- **A departing player can end a round**, and does so from the `PlayerRemoving` handler the moment
  they leave rather than on the next tick — up to a second earlier, and it works even while rounds
  are paused. Measured in a live log: **27 ms** from disconnect to `[Round] Team A won`.
- `finishRound(outcome)` is **idempotent** via `this.finished`. It prints the score for scoring modes,
  writes `ROUND_WINNER_ATTRIBUTE`, prints `[Round] <result>`. Two callers reach it (the tick and
  `PlayerRemoving`) and the first wins.
- Modes play no part in the roster rule — it lives in `RoundService` because it is a fact about the
  server, not about a mode.

### `DeathEvent` has no cause field

`{ player }` only. There is deliberately no `byHit`. No mode distinguishes a hit from a reset, and
the code says so in several places. Do not reintroduce it.

---

## 6. Maps

- One arena at a time, cloned from `ServerStorage.<MAP_CONFIG.MAPS_FOLDER>` (`"Maps"`).
  `MAP_CONFIG.MAP_NAMES = ["RoLive Map"]` — **a space in the name, and it matches the model**, which
  a live log confirmed (`[Map] loaded "RoLive Map"`). `FindFirstChild` is exact and case-sensitive.
  A map is `Maps/<name>/` with `ArenaSpawns/{A,B}` folders of `BasePart`s inside it.
- **The template is never played in.** The clone is what gets destroyed; the template stays pristine,
  so editing it in Studio takes effect on the next cycle without a restart.
- **`pickNext()` rotates sequentially, not randomly** — deliberately, so a two-map list is guaranteed
  to show you both.
- **Cloning and placing are two steps** (changed 2026-09-28):
  - `loadMap(name)` — unload, `Clone()`, store in `this.current`, **does not parent**. Called at
    intermission entry.
  - `placeCurrent()` — idempotent; parents `this.current` into `Workspace`. Called at the round
    boundary.
  - `unloadCurrent()` — `Destroy()`, whether placed or not.
  - `getCurrent()` — answers while the map is still out of the world, deliberately: the boundary
    checks the map *before* placing it. A part's `CFrame` is world-space regardless of parent, so the
    spawn lookups work on an unplaced map.
  - Why: the arena used to sit in `Workspace` for the whole intermission, visible to every client
    (this is what the user reported). The `Clone()` cost is still paid while nothing is happening.
  - **`Clone()` copies `CollectionService` tags**, so the new clone's spawners are findable while out
    of the world — hence the `IsDescendantOf(Workspace)` guard in `BallSpawnerService.tick()`. Without
    it, spawners of an invisible arena get topped up and balls fall through empty space.
- `mapProblem(map)` returns a **sentence** naming the missing path, or `undefined`. It is what turns
  "the spawn list is empty" into something a person can act on, and both sides are always checked.

---

## 7. Balls

- `BallService` owns everything about a ball in a hand: `heldBalls: Map<Model, HeldBall>`. All four
  ways a ball enters a hand pass through one private `attachToHand`.
- `dropBall(model): boolean` — puts it **in the world** (cast forward, lockout, armed=false,
  network owner released, expiry scheduled).
- `removeBall(model): boolean` — **destroys** it and removes the map entry. The entry is deleted
  *before* `Destroy()`, deliberately: `isHeld` answers from that map and both `scheduleBallExpiry`
  and the spawner's cleanup ask about a ball on its way out.
- **Two held-ball clearups, two different jobs:**
  - Round **start** — `RoundService.clearHeldBalls()`, players only, at the end of the intermission.
  - Round **end** — `RoundService.clearEndedRoundHeldBalls()`, at intermission entry, before the map
    unload. Uses `roundParticipants()` (module-level in `RoundService.ts`): every player's character
    plus every `NPC_TAG`-tagged `Model` that `IsDescendantOf(Workspace)`. Prints one line, and only
    when something was cleared: `[Round] cleared N held balls`.
  - Both **destroy** rather than drop: a dropped ball lands where the dropper stands, which is the
    wrong place at either boundary.
  - Neither runs on `PlayerRemoving` — a leaver's character is destroyed with them, and `BallService`
    already has its own `PlayerRemoving` handler that prunes the `heldBalls` entry.
- **Tags:** `"Ball"` on every ball (must match `BallComponent`'s decorator literal — Flamework reads it
  at build time, so it is a copy, not an import); `"RoundBall"` only on balls the spawner created.
  `removeTag` before `destroy` in the sweep.
- `BallSpawnerService` — tagged `"BallSpawner"` parts inside the arena; `BALLS_PER_SPAWNER = 3`,
  `SPAWN_RADIUS = 8`, `SPAWN_TICK_INTERVAL = 1 s`, `LIFETIME_SECONDS = 60`. It reads the round only
  through `RoundStatus.State` (a sibling of `RoundService`, not a dependent), sweeps `ROUND_BALL_TAG`
  on the `Playing → Intermission` **edge**, and since 2026-09-28 also tops up on the `Playing` edge so
  the arena is stocked the moment the round opens rather than a tick later.
- Note: with the new placement guard, spawners only exist in the world while a round is on, so the
  `state === PLAYING ? math.huge : LIFETIME_SECONDS` else-branch in `spawn()` is now effectively dead
  code. Left in place deliberately; removing it is an open decision.
- The throw→hit path is `BallComponent.handleTouch`. **Friendly fire is refused there, globally,
  before any damage** — via `RoundService.isFriendlyFire(throwerToken, victim)`, which is a fact about
  the round, not a mode method. Every mode, no exceptions. It only answers `true` while a round is
  actually playing.

---

## 8. Game modes

`src/server/services/round/modes/GameMode.ts` defines the interface, `RoundView` (what a mode may see
of the round), `DeathDecision`, `DeathEvent`. `registry.ts` maps ids to instances; `team.ts` holds
`TEAM_A`, `TEAM_B`, `DRAW`, `TeamLabel`, `RoundOutcome`. Names/colours/side-names live in
`shared/gameMode.ts`, so the **client can format the HUD without a mode table of its own**.

Three modes:

- **Team Elimination** — symmetric, hit eliminates, last side standing.
- **Score Rush** — TDM, respawns, first to `SCORE_RUSH_TARGET` (30) or the clock; the only mode with
  `scores = true`, so it is the only one `hitAward` is ever called on.
- **Dodge and Seek** — asymmetric. `SEEKERS = TEAM_A` (the side `splitEvenly` gives the odd player to),
  `DODGERS = TEAM_B`. One seeker picked at random unless there is only one player (then everybody is a
  dodger, so the round has something to be). `onDeath` always returns
  `{ kind: "respawn", team: SEEKERS }` — a hit *converts* rather than eliminates, so a reset is never a
  winning move **by construction**, not by a rule. `outcome` reads one number: zero dodgers → seekers
  win; clock at zero with ≥1 dodger → dodgers win; nobody in the round → `DRAW` (checked first,
  because an empty round would otherwise read as "zero dodgers").

Modes are **not** aware of friendly fire, of the roster rule, or of the map. Voting: 10 s closing
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
HUDs. Theme is **LIGHT** big-ui; `hudTheme.ts` centralises it. A fresh HUD controller should read
`RoundStatusController.ts` and `ShopController.ts` as the reference implementations.

---

## 10. Recent work, and the two debugging stories worth knowing

### The `async` game-loop death (important)

Symptom: HUD frozen at `Intermission — 0s`, for ever, with nothing after one rejection in the output.
Cause: `getRandomTeamSpawn` called `error()` inside `gameLoop`, which is `async` → the throw rejected a
promise nobody handled → **the loop stopped permanently**. The throw fired *before*
`ROUND_STATE_ATTRIBUTE` was set to `"Playing"`, which is why the HUD looked stale rather than broken.
Fix: the `mapProblem()` guard at the round boundary, before anything is half-started.

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

### Completed this session

- Full game-mode system: interface, three modes, registry, `VoteService`, HUD mode display, vote UI.
- Friendly fire: global veto in `BallComponent.handleTouch`, *not* a `GameMode` method.
- `MIN_PLAYERS = 2` freeze (not skip).
- Team-coloured outlines (`OutlineService`), black in the lobby — phase is checked first.
- Random-part spawn selection from `ArenaSpawns/{A,B}`.
- Multi-map support: `MapService`, rotation, round-boundary map guard, load/place split.
- Round-end held-ball cleanup (§7), round-start held-ball cleanup.
- Roster rule: "all of one team left the server", mode-agnostic, fires from `PlayerRemoving`.
- HUD winner/waiting fix, and the Fusion dependency fix.
- Shop GUI, throw-state toast, WalkSpeedService, responsive-UI pass over five HUDs.

### Uncommitted at handoff

`git status --short` shows exactly three modified files — the map load/place split:

```
 M src/server/services/MapService.ts
 M src/server/services/ball/BallSpawnerService.ts
 M src/server/services/round/RoundService.ts
```

`git diff --stat flamework.build` is silent. Build exit 0.

---

## 11. Open items and flags

Carried over, roughly in priority order:

1. **The map placement change is unverified at runtime.** Built and the emitted Luau order checked
   (`unloadCurrent` → `loadMap` → `placeCurrent` → teleport → publish `"Playing"`), but no Studio run.
   What to check: `Workspace` has **no map during an intermission**; `ServerStorage.Maps` always has
   the template; the new `[Map] placed "…"` line appears at the round start; the arena is stocked when
   the round opens.
2. **The spawner guard may have changed NPC behaviour between rounds.** Nothing is put out during an
   intermission now. The log shows the NPC `Thrower` throwing on a ~10.1 s cadence through the whole
   intermission, with matching `[Outline] DodgeballBall: outlined` lines on the same cadence — which
   looks like a spawner replacing a ball the rig picked up. If the rig relied on the arena's
   intermission stock it will now be quiet between rounds. Not traced; flagged to the user.
3. **`BallSpawnerService.spawn()`'s non-playing lifetime branch is now dead code** (§7).
4. **`MapService`'s class comment** had a sentence that read as arguing against the design it argued
   for ("Broken arena geometry stays broken for the rest of the server, and the fix is to edit the
   template rather than to restart"). Flagged to the user; not rewritten.
5. **The `+3` stud lift** in `RoundService.getRandomTeamSpawn` (and in `getSpawn`) was kept against the
   user's own snippet and is still unconfirmed as wanted.
6. **Loose (non-`RoundBall`) balls are parented to `Workspace`, not into the map.** The spawner's sweep
   handles tagged ones; a ball a player dropped is `"Ball"`-tagged only and may survive a map swap.
   `BallFactory.createLoose`'s parenting was never traced to confirm.
7. **Windows:** the HUD is a single big-ui `Text` inside a `Card`, so the winner is text on a line
   rather than a distinct element. The user was offered a separate, coloured label and has not chosen.
   Three segments may wrap on the 360 px card — untested at that length.
8. **`rojo serve` exits 1** (§1). Cause unknown, not investigated.

---

## 12. What a live log has actually confirmed

Treat everything else as unverified. These were observed in the user's Studio output:

- Vote window 20 s: opened 23:04:00.983 → closed 23:04:21.352.
- Roster rule fired **27 ms** after a disconnect, and `[Round] Team A won` was published correctly.
- Zero-vote case resolved as a three-way tie broken at random.
- Map unload → load on intermission, in that order, 8 ms apart.
- `MIN_PLAYERS` freeze: intermission started 23:03:52.880, vote opened 23:04:00.983 when Player 2 joined.
- `[Map] loaded "RoLive Map"` — so `MAP_CONFIG.MAP_NAMES` and the model name agree despite the space.
- `[Round] cleared 1 held balls` at server start (an NPC rig was holding one from the place file).
- `[Ball] Player1's ball was destroyed` / `Player2's` immediately before `Round started` — the
  round-start clear.
- The `BallSpawnerService` sweep on the round-end edge, and `[Outline]` repaints.

And one uncorrected hypothesis from the user that is worth re-checking before it is believed: they
believed `TEAM_ATTRIBUTE` is not reassigned when a Dodge-and-Seek conversion happens. It **is** —
`RoundService.handleDeath` → `setTeam` writes both `teams` and the attribute. The outcome is still
right, but for a different reason than was stated.
