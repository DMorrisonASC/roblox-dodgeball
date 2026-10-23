# Handoff — roblox-dodgeball

A guide for a fresh session. Written 2026-09-28 against a green build (`npm run build` → exit 0);
**brought up to date 2026-10-23** against `f062372` **plus six uncommitted files from the same day** —
`controllers/hud/MobileControlsController.ts`, `ui/glow.ts`, `client/enemyView.ts`,
`services/round/RoundService.ts`, `shared/constants.ts` and `controllers/hud/LoadingScreenController.ts`
(§9, §10, §15). Earlier revisions: 2026-10-19 at `efcbc37` plus the readout column moved to
`getFullScreenGui()` — **that change is committed now, in `f062372`**; 2026-10-17 at `a73c0a7` (the
persistence pass, **since committed as `008963b`** — the paragraph below used to call it uncommitted),
2026-10-16 at `196a5b3` with the mobile input surface and the GUI region rule, 2026-10-14 at `9b47369`,
2026-10-11 at `9e2e971`, 2026-10-06 at `5bcc374`. Where this file and the source disagree, the source
wins — and the tag count in §7 is deliberately not quoted here (it is `TAGS.md`'s own table, which is the
count).

**What has landed since the 2026-10-19 revision, and all of it is uncommitted at the time of writing.**
Five things, and the first two are one component:

1. **The mobile cluster is glass, and a press is its negative.** Idle the face is `PREMIUM.void` at `0.7`
   (`IDLE_TRANSPARENCY`); held it is `PREMIUM.text` at `0.2` with `void` ink, and the word under the button
   inverts with it (`HELD_TRANSPARENCY`, `buildButton`'s `paint`). That replaced a crimson held-face, which
   read as an alarm over bright green turf. **The look needed a change underneath it**: `ui/glow.ts`'s
   `applyGlow` grew a third argument and the cluster passes `false`, so its bloom is a `Border` `UIStroke`
   rather than a `UIShadow` — a shadow is a blurred *silhouette*, so it inks the shape's interior, and
   behind a `0.7` face the glow *was* the fill. §10 has the story.
2. **Catch and Dodge have a cooldown ring, and it is a hairline revealed by the button shrinking** rather
   than a disc drawn on the button: two `UIGradient` halves clipped to a circle, clockwise from 12 o'clock,
   plus an opaque `PREMIUM.void` disc that leaves only the outer band. §10 lists the four shapes it went
   through to get there. **Throw has neither an arc nor a charge meter** — that one was removed at the
   player's request, and `ThrowController.currentCharge` is private again.
3. **A caught throw says so on the thrower's screen.** `LAST_HIT_BY_CAUSE_ATTRIBUTE` is `"Hit"` from
   `registerHit` and `"Catch"` from `resolveCaughtThrower`, written on the **thrower** — the thrower is the
   one who dies — with the catcher as the name, token and position; `client/enemyView.ts` hides its header
   and prints `caught your shot!` in place of the stat line. The `LAST_HIT_BY_*` family has a fourth member
   and it is the only one that changes a *caption* rather than a camera.
4. **Nothing arrives from a practice zone holding anything, and no power survives a round's start.**
   `admitWithCover` removes the arriving player's ball and ends their armed power before the side is written
   and before the body is moved, printing `[Round] <name>: admitted — held ball and armed power cleared`
   only when something was taken; `clearArmedPowers()` is the `SuperService` half of the intermission sweep,
   which the ball sweep alone could not do — an arm with no ball behind it is a fact about the *player*.
5. **The loading screen's `TITLE` is `No Headshots`**, against `DODGEBALL Hero`.

**What has landed since the 2026-10-17 revision** (`git log a73c0a7..efcbc37`, and it is the whole of
`196a5b3..efcbc37` that §4, §7, §10, §15 and §16 were brought in step with). Five things:

1. **The throw is aimed with the cursor, and the envelope under it is 30→54 studs** (`efcbc37`). A
   `ChargeRequest` now carries the world point under the crosshair; `reachTo` caps the hold to the hold
   that covers that distance and takes the heading from the muzzle→point line, which is what removed the
   third-person camera's parallax. A curve's lateral pull is timed to the flight to *that point* instead
   of to the ballistic hang. `CHARGE_MIN_SPEED` is 50, `THROW_MAX_SPEED` 90 and `CHARGE_PEAK_HEIGHT` 0.9,
   so every hold hangs 0.6 s. **§7 has the model; §15 items 29–33 are what it left open**, including the
   four comment blocks that still quote the old 336 / 150-stud throw.
2. **`CATCH IT!` is on screen** (`c063f37`). The server publishes the side a tagged ball owes
   (`BALL_TAGGED_TEAM_ATTRIBUTE`), and `client/catchPrompt.ts` draws one `BillboardGui` over each live
   ball whose owed side is the local player's own — the victim and their teammates, nobody on the
   thrower's side. The same commit split the lobby's seats **by side** (`npc/lobbySpawns.ts`, reading
   `LobbySpawns/A` and `/B` by `TEAM_ATTRIBUTE`), which is the fix for rigs returning to the wrong end of
   the lobby.
3. **The spawn poof is one helper for all fifteen call sites** (`4769c8f`; `server/vfx/spawnPoof.ts`).
   It is anchored where the body stood and deliberately **not** welded to it, and it delivers its burst by
   raising the emitter's `Rate` for a window rather than by `Emit` — the same server-side-emission lesson
   §10 already records for the gust, and the reason a clone left at the template's `Rate = 3` drew nothing.
   **Confirmed in Studio** (§16).
4. **The lobby's rigs are drawn from a pool and they walk to their own join pad** (`d7af44d`, merging
   `npc-playing-rounds`; the earlier attempt on `main` was reverted at `169885e` and `286ae45`).
   `npc/rigPool.ts` guarantees no two live rigs share a name or a body, and
   `behaviors/WalkToJoinPadBehavior.ts` is the walk, on `SeekBehavior`'s movement law.
5. **Walk speed is a set of contributions under a set of caps** (`3194128`, `b3a1cf3`; §17), and the HUD
   grew the hit tally with a `WIPEOUT!` caption that outranks every other line (`d69a099`). The power slot
   became one slot that a prize and a dev's arm take turns in, with one crown a side (`f699436`).

**What has landed since the 2026-10-16 revision.** One thing, and it is the first change to how the two
DataStores are written since either service was created:

1. **Persistence has a shape, and it is shared.** A session lock on both records (`SessionId` /
   `LastUpdated`, claimed inside the join read with `UpdateAsync`), a save at the **round end** in both
   services, printed write failures on the economy side, a sleep between the stats service's two
   retries, and a `BindToClose` that spends a bounded 20 s window instead of an unbounded one. The
   rules live in `src/server/persistence/` — outside `services/`, so `flamework.build` is untouched
   — and **§12b is the new section that describes them.** The one-file summary: nothing writes on a
   hit, and four boundaries now do.

**What has landed since the 2026-10-14 revision, because a reader of the older sections is missing all of
it.** Three things, and the third is the one that changed a *rule* rather than adding a feature:

1. **Mobile input is this project's own, not the engine's** (`63af8e8`, `aa3a3ad`, `0325c9a`). A ring is
   drawn in place of the engine's thumbstick — the engine's stick is hidden by a `UIScale` it cannot
   revert and left listening underneath, and its movement mode is deliberately *not* set by either peer —
   a five-button cluster is built around the engine's own jump button, the sprint is read off the body
   rather than off the stick, the cooldown readout is deleted, and touch gets an aim sight because a
   phone has no cursor. **The ring is drawn only while a finger is on it** (added 2026-10-16), so the
   lower-left corner is empty until the player pushes there. **The one test behind all of it is
   `client/platform.ts`'s `isMobile()`** — `TouchEnabled && !KeyboardEnabled` — and §9 now has the list of
   what asks it and why.
2. **The HUD's two top readouts share one column** (`2d40684`, `b74c364`). The score plate and the clock
   used to be two offsets from the same origin in the same GUI, both of them `14`, so the plate was
   drawn *across* the clock for the whole of every intermission. They are now two children of one
   `UIListLayout` made by `screenGui.ts`'s `getHudColumn()`, where the order is `LayoutOrder`'s business
   rather than two numbers that have to agree.
3. **A `ScreenGui`'s region is now decided by a written rule, and on a mobile client the HUD insets**
   (`196a5b3`, plus the fix made in this pass). `ui/screenGui.ts` holds the rule — *where does the number
   that positions it come from?* then *which device is this?* — and all four writes across the two gated
   accessors go through one `edgeAnchoredInsets()`. **The bug that fix also closes is worth knowing
   before reading any older description of the HUD: `getHudScreenGui()` created the GUI with
   `CoreUISafeInsets` and then set `None` on every later call, so the shared HUD GUI was `None` at
   runtime on *every* device.** The desktop half of the new rule is therefore what all clients already
   had, and the mobile half is a change. §9 has the rule and the five GUIs; §10 has the four-pass hunt
   that produced the coordinate-space half of it.

**What has landed since the 2026-10-11 revision, because a reader of the old sections is missing it.**
Four things, and the fourth is the one this pass added a section for:

1. **One animation pipeline for both bodies.** `shared/animation.ts` is the single table and the single
   rule (`animationFor(speed, grounded, frozen)`, `clipIdFor(state, isR15)`), and `client/bodyAnimation.ts`
   is the one renderer both a player's controller and `RigAnimationController` drive. There is no longer
   a rig clip table beside the player's.
2. **The hit effects split in two.** `roundHit` is gated to hits with a player at both ends, so a rig
   could not be drawn hitting anybody; `hitImpact` is a second server→client event from
   `RoundService.registerHit` for exactly those hits. `CATCH_ANIMATION_ATTRIBUTE` now carries
   `"attempt" | "catch"` rather than `true`, because the *value* is the cause and a rewrite of `true`
   fires no change.
3. **A throw is telegraphed, and the charge is visible.** A rig winds up for as long as a player's own
   hold at the same distance (`createWindupTracker` in `ThrowBehavior.ts`), and publishes the charge it
   is holding as `CHARGING_ATTRIBUTE` — **a number 0..1, which is a different thing from
   `SUPER_CHARGE_ATTRIBUTE`**; see §11. `client/chargeEffect.ts` draws the loop on the hand, the fire
   ball above 90 %, and the gust on release; the old server-built gust is deleted (§17).
4. **The rigs' walk stopped being a straight line** — a run for a far ball, a hop past a body, an arc
   towards what it is fetching, a bluff at an armed enemy, and no longer a dead stop when the ball
   arrives. All of it is in `SeekBehavior.ts`, all of it is config in `npc.config.ts`, and **§17 is the
   new section that describes it.**

**What "brought up to date" was checked against, so a reader can tell its scope.** Tags, constants and
attribute names, file paths, config values, the named services and methods, and the claims that
something has been deleted were checked against the source at that commit. It is **not** a claim that
every sentence was re-derived: §16's live-log lines come from Studio rather than from the source, and
anything this file describes as a place-file or Studio fact is unverifiable from here and stands as it
was.

**What *this* pass (2026-10-14) actually re-read.** The new §17, and everything it touches: `SeekBehavior`,
`AlwaysSeekingBehavior`, `NpcService`, `WalkSpeedService`, `ThrowBehavior`, `detect.ts`, `npc.config.ts`,
`shared/animation.ts` and the client's animation controller. §4, §7, §11, §15 and §16 were corrected
where this pass found them stale — the three corrections are marked in place (the deleted
`services/ball/WindBurst.ts`, the two charge attributes, and the new open items). **§5, §6, §8, §9,
§12, §13 and §14 were not re-derived this time** and stand as the 2026-10-11 revision left them.

**What the 2026-10-16 pass re-read.** Every accessor and both branches of each in `ui/screenGui.ts`;
`client/platform.ts`; `controllers/input/TouchJoystickController.ts` (the mount, the pad, the ring, the
geometry, the inset read and the grab line); `controllers/camera/ShiftLock.ts`'s `applySight` and its
caller; `ThrowController.getThrowDirection`; `controllers/hud/MobileControlsController.ts`'s class doc
and `restyleEngineJump`; `controllers/CoreGuiController.ts`'s own account of which chrome is left on;
and §4, §9 and §15 of this file. **§5, §6, §7, §8, §11, §12, §13, §14 and §16 were not re-read this
time** and stand as they were — with one exception that matters: **anything in them that describes
which region the HUD's `ScreenGui` draws in is superseded by the rule in §9.**

**What the 2026-10-17 pass re-read, and what it did not.** It re-read both services' *persistence
paths only* — every `load`, `write`, `flush`, autosave and shutdown method in `StatsService` and
`EconomyService` — plus `RoundService.finishRound`'s tail, `shared/economy.ts`'s parsers, and the two
new modules in `src/server/persistence/`. It added §12b, corrected §12's persistence bullet and §4's map,
and added §15 items 24–28. **Everything else in this file stands as the 2026-10-16 revision left it**,
including §12's economy rules, which this pass did not touch: the coin values, the chest, the milestones
and the catalog are unchanged and still unconfirmed in Studio (§15 item 1).

**What the 2026-10-23 pass re-read, and where it stopped.** It re-read `MobileControlsController.ts` end to
end — the packing, `buildButton`, `addCooldownOverlay`/`addArcHalf`, `trackCooldowns`, the press tracker and
`paintJump` — and `ui/glow.ts` whole. **It read `client/enemyView.ts`, `RoundService.ts` and
`shared/constants.ts` as *diffs* rather than as files**: the changed hunks in each were read in full and the
rest of those three files was not re-derived, which is the distinction to keep in mind when one of their
sentences turns out to be stale. It corrected §9's inventory (two deleted controllers, one that was missing),
added §10's two stories and its completed list, and added §15 items 34–37. **§5–§8, §11–§14, §17 and §18
were not touched at all**, and **§16 gained no confirmation** — see its own note.

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
  not "no calls". See `SuperService.inRoundOrZone`, which is deliberately *lent out* to `BallService`
  rather than copied, with the argument for the loan in its doc. (The private `isRoundActive` that
  `inRoundOrZone` wraps is not shared — its own copy of the same read of the round folder also lives
  in `StatsService`, which is the one place the rule is duplicated.)
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
                                 (ROUND_STATE_ATTRIBUTE, TEAM_ATTRIBUTE,
                                 RESPAWN_AT_ATTRIBUTE, COINS_ATTRIBUTE, OWNED_ITEMS_ATTRIBUTE,
                                 CROWN_ATTRIBUTE, STAT_HITS, MATCH_JOIN_A_TAG, MATCH_SPAWNER_TAG,
                                 CHARACTER_BARRIER_TAG, PRACTICE_ZONE_TAG, MYSTERY_SPAWN_TAG, …)
  ability.ts                     AbilityKind (Pierce | MultiBall | Freeze), ABILITY_NAMES,
                                 isAbilityKind, isBallAbility, abilityOn(ball)
  economy.ts                     EconomyRecord / SavedEconomy, blank + shape-check, and the
                                 string <-> Set helpers for the two attribute-backed sets
  purchase.ts                    validatePurchase / PurchaseDecision — the pure checks behind the
                                 shop's cosmetic purchase (with `purchase.spec.ts` beside it)
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
                                 character, debug, economy, images, mystery, ring, shiftLock, shop,
                                 sound, stats, super, throwFeedback, transition, ui — plus
                                 animation, audio, cameraZoom, duck and spawnPoof

src/server/
  main.server.ts                 boot: collision groups, ignite, CharacterAutoLoads = false, shield
  collision/CollisionGroups.ts   PhysicsService + Workspace groups; applyBarrierGroups()
  persistence/                   **not a service and deliberately outside `services/`** (so it never
                                 reaches `flamework.build`): sessionLock.ts — `SessionId` /
                                 `LastUpdated`, `heldByAnother`, `stamped`, `serverNow` — and
                                 shutdown.ts — the `BindToClose` budget, the per-write deadline, and
                                 `runWithin`, the thread-and-poll that enforces it. §12b
  services/round/                RoundService, JoinService, VoteService (dormant), roundStatus.ts,
                                 team.ts, modes/{GameMode,TeamEliminationMode,ScoreRushMode,DodgeAndSeekMode,registry}
  services/match/MatchService.ts opt-in roster, the two join parts, the counts signs
  services/economy/EconomyService.ts  coins, powers, cosmetics, milestones, the chest — and the
                                 `"Economy"` store, locked, written at four boundaries (§12b)
  services/character/            RespawnService, WalkSpeedService, SpawnShield
  services/ball/                 BallService, BallFactory, BallSpawnerService, BallPickupService,
                                 BallTrail, ballExpiry, SphereService, ThrowProbe, SoundEmitter
                                 — **`WindBurst.ts` was here and is deleted** (2026-10-13, with the
                                 thirteen `WIND_BURST_*` entries in `throwFeedback.config.ts`, which is
                                 the camera shake and nothing else now). The throw's gust is a client
                                 effect on the thrower's body: §17
  services/actions/              ActionService, CatchService, DodgeService, FreezeService,
                                 actionLock, readyAt
  services/super/SuperService.ts streak, charge (dev-only), MultiBall window, crowns
  services/stats/StatsService.ts hits + outs, DataStore "PlayerStats", the round-end + autosave
                                 boundaries, and `recordOut`'s caller in the round (§12b)
  services/visual/OutlineService.ts   per-body Highlight, team colours, freeze override
  services/mystery/MysteryBoxService.ts  the tagged spawn points, the box, the chest prize
  services/zone/PracticeZoneService.ts   zone membership -> PRACTICE_ZONE_ATTRIBUTE
  services/npc/NpcService.ts     + npc/Behavior.ts, npc/behaviors/*, npc/rigs.ts, npc/sideZones.ts,
                                 npc/rigPool.ts (the name and body pool every placeholder rig is drawn
                                 from — nothing is reused while a live rig wears it),
                                 npc/rigTemplate.ts (the boot audit of every rig template under
                                 `ServerStorage`, named by full path, plus the one spawn gate — it
                                 reports and repairs nothing), and
                                 npc/lobbySpawns.ts (a lobby seat *by side*: the parts under
                                 `LobbySpawns/A` and `/B` carrying `TEAM_ATTRIBUTE`, with a
                                 whole-folder fallback and one warning when the place file has not
                                 been split). `behaviors/WalkToJoinPadBehavior.ts` is the walk to a
                                 match join part, on the same movement law as `SeekBehavior`
  components/BallComponent.ts    the throw -> hit path (friendly-fire guard, tag deferral, splash)
  vfx/spawnPoof.ts               `playSpawnPoof(model)` — the one appear/disappear effect, anchored
                                 where the body stood and deliberately not welded to it (§10, §15)
  dev/                           DevService + dev.config (chat commands and flags)
  config/                        match.config.ts, outline.config.ts

src/client/
  main.client.ts
  aiming.ts / sprinting.ts / throwing.ts / cameraShake.ts   tiny Fusion Values shared between
                                 controllers; panels.ts is the same shape for session state
  roundZone.ts                   "in a round or in a practice zone" — the client's one rule
  platform.ts                    `isMobile()` — the client's one device test and the only place that
                                 decides it; a caller per question and no two asking the same one — §9
                                 is the list
  IasTest.ts                     finished input test, DEBUG = false, meant to be deleted
  bodyAnimation.ts /             **the body effects and the one animation renderer, and they are plain
  hitVfx.ts / hitConfirm.ts /    modules started by hand from `main.client.ts`** — `startHitVfx()`,
  catchShockwave.ts /            `startHitConfirm()`, `startChargeEffects()`. Flamework loads
  chargeEffect.ts / windBurst.ts `client/controllers` and nothing else, so anything that is not a
                                 controller is started by a call there. `bodyAnimation` is the single
                                 state machine both bodies are dressed by (`applyBodyRender`), and the
                                 other four are its subscribers: the two hit effects (player-on-player
                                 via `roundHit`, the rest via `hitImpact`), the catch's shockwave, and
                                 the charge — a loop on the hand, the fire ball over 90 %, and the
                                 driver for the gust at the thrower's feet. See §17
  catchPrompt.ts                 `startCatchPrompt()` — the `CATCH IT!` `BillboardGui` on a live ball
                                 that has hit somebody on this client's own side. Another plain module,
                                 started from `main.client.ts` like the others; it owns one prompt per
                                 tagged ball and reads only published attributes, so it never asks the
                                 server whether a catch is owed (§7)
  enemyView.ts                   `startEnemyView()` — the kill cam's panel: the killer's name, then
                                 either the per-head stat line or, since 2026-10-23, `caught your
                                 shot!` with the `ENEMY VIEW` header hidden, decided by
                                 `LAST_HIT_BY_CAUSE_ATTRIBUTE` read off the local player. Another plain
                                 module started from `main.client.ts` (§10, §15 item 37)
  ui/                            screenGui.ts (every `ScreenGui` in the client and the written rule for
                                 which one a thing belongs in — HudGui, FullScreenGui, SplashGui,
                                 TransitionGui, ScreenSpaceGui, StickGui, **plus `getHudColumn()`**, the
                                 one frame the score plate and the clock share; **see §9 before moving
                                 anything visual**), hudTheme.ts, viewportConstraint.ts, hudToast.ts,
                                 **actionSplash.ts** (the `HIT!` look and its one pop, extracted so a
                                 second caller can share it — `styleSplashText` styles any `TextLabel`
                                 and never animates; `createActionSplash` adds the frame and an opt-in
                                 `pop`; `catchPrompt.ts` uses the first and deliberately not the
                                 second), elevation.ts, panelChrome.ts, **glow.ts** (`applyGlow` — the
                                 two-layer bloom under every neon edge here: a hairline `GlowCore`
                                 stroke plus either a `UIShadow` or, when the caller passes
                                 `blur: false`, a `GlowBloom` `Border` stroke. The cluster passes
                                 `false`, because a shadow inks the shape's interior and its face is
                                 transparent — §10)
  controllers/                   CoreGuiController.ts (shared core-GUI wiring)
  controllers/hud/               RoundStatus, RoundTransition, LoadingScreen,
                                 RespawnHud, CurrencyHud, SuperHud, StatsBillboard, ScoreHud,
                                 ControlsLegend, MobileControls (the six-button cluster — packed by
                                 `pack()`, glass face, a cooldown ring per control with a clock; §9,
                                 §10), ModeVote, ArenaFreezeCountdown, Dock, Shop, Inventory, Theme.
                                 **`CooldownHud` and `ThrowStateToast` stood in this list and are
                                 deleted** — nothing in `src/` names either any more, and the second
                                 one took `ui/hudToast.ts`'s only caller with it (§9, §15 item 36)
  controllers/input/             Action, Catch, Dodge, Throw, AimTarget, SuperAbility,
                                 AlternativeMovement, Sprint, **TouchJoystickController** — the ring,
                                 its thumb and the movement pad, touch clients only
  controllers/camera/ShiftLock.ts
  controllers/character/         LocomotionAnimationController, TeamRingController,
                                 RigAnimationController, AfterimageController
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
8. `scores.clear()`, `roundHits.clear()`, `roundOuts.clear()`, `roundHitLog.clear()`,
   `finished = false`. **The hit log keeps the two boards' lifetime exactly** — newest first, capped
   at `HIT_LOG_CAP` (5, **placeholder**), and appended from `logHit`, which `registerHit` calls. **The
   same call tells the two people in the hit**, through the `roundHit` event — see `networking.ts`;
   the HUD builds its own per-player windows from that stream and never reads this log.
9. `assignTeams()` from `matches.roster()` — writes `teams` and `TEAM_ATTRIBUTE`, then
   `refreshCrowns()`. Then per player: `abilities.resetForRound(player)`, and everybody the roster
   has a side for goes into `activePlayers`; anybody without one is simply left out of it. **There is
   no spectator attribute any more** — nothing is published for the players left out. See the note at
   the end of this section.
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
  for neither side, so a joiner cannot rescue a side that just emptied.
- **A departing player can end a round** and does so from the `PlayerRemoving` handler the moment
  they leave rather than on the next tick — measured in a live log at **27 ms** from disconnect to
  `[Round] Team A won`.
- `finishRound(outcome)` is **idempotent** via `this.finished`. In order: print the score for scoring
  modes, write `ROUND_WINNER_ATTRIBUTE`, **`this.economy.onRoundEnded(outcome, this.teams,
  this.roundHits)`**, **`this.stats.onRoundEnded()`**, **`this.badges.onRoundEnded(outcome,
  this.badgeSubjects())`**, wipe the score, print `[Round] <result>`. Two callers reach it (the tick and
  `PlayerRemoving`) and the first wins. **A draw reaches the badges**, which is the one thing the deleted
  board never did.
- **The end-of-round board is gone (2026-10-19).** `sendResult`, its `roundResult` event and
  `RoundResultController` were deleted together — the controller was the event's only reader, so all three
  went. What a round publishes about itself now is `BADGES_ATTRIBUTE`, one comma-joined id list per body,
  for fifteen seconds or until the next `Playing` edge. Two consequences worth knowing: `roundOuts` has no
  reader left (see its field note in `RoundService`), and `roundHits` has exactly one
  (`EconomyService.onRoundEnded`'s performance bonus).
- **`BADGES_ATTRIBUTE` is written by `badges.publish()`, not by `onRoundEnded` (2026-10-19).** The sets are
  derived at `finishRound`, because the counters only live that long, and then *held* — because every body
  the write could land on is about to be moved or replaced by the boundary. `publish()` is called in the
  intermission's own section, immediately after `transitionAround(...)` has run `teleportAll` and
  `returnRigsToLobby`, and it starts the fifteen-second clock there rather than at the derivation. **The
  fault it fixes:** a write at `finishRound` landed on corpses, and `RespawnBehavior` rebuilds a rig from a
  template taken while that rig was *alive* — so a rig killed in the last seconds of a round came back blank
  a second after earning its strip. Eight strips were written and three were visible, which was reported as
  "the badges were not shown". `RespawnBehavior` now carries the attribute across a rebuild for the same
  reason, and `BadgeService.clearAll` sweeps rigs by `NPC_TAG` because a rebuilt body can hold a value this
  service never wrote to.

### Death and elimination

`handleDeath(player)`:

1. Optional verbose print; `abilities.clearMultiBall(player)` and `freezes.unfreeze(dying)` — the
   freeze comes off while the body is unambiguously still there.
2. `if (this.state !== RoundState.Playing) { this.respawns.loadNow(player, "outside a round");
   return; }` — a death in the lobby is not an elimination, **but a body is still owed**.
3. `if (!this.activePlayers.has(player)) { this.respawns.loadNow(player, "outside a round");
   return; }` — somebody already out of the round dying again. **The branch stays now that the
   spectator attribute is gone**, because the body is the reason for it: without it, Score Rush would
   *schedule* a three-second respawn for a player who is only watching, and Team Elimination would
   run `eliminate` a second time and record a second out for one death.
4. `abilities.noteDeath(player)` then `const decision = this.mode.onDeath({ player }, this)`.
5. `eliminate` → `this.eliminate(player); return;` — otherwise `setTeam` if the mode named a side,
   and **`this.respawns.schedule(player, ARENA_CONFIG.RESPAWN_DELAY_SECONDS)`** — the only delayed
   respawn in the game.

`eliminate(player)`: `activePlayers.delete`, `stats.recordOut`, `roundOuts` += 1, and
`this.respawns.loadNow(player, "eliminated")` — instant, never delayed.

### Spectating was removed

**There is no spectator state any more.** `SPECTATING_ATTRIBUTE` is gone from `shared/constants.ts`,
`SpectatorController` is deleted, and `panels.ts`'s `sessionHudVisible` has lost its third term — so
"can this player act" is now "a round is on, or you are in a practice zone". The cost is written out
there in full: a player who dies inside a round (Score Rush, `RESPAWN_DELAY_SECONDS`) and a player who
joins mid-round both see the ability readouts over a body that cannot use them.

**What did not change.** `activePlayers` is still the roster. `MatchService.optIn` still refuses to add
anybody to a side while the phase is `Playing`, so a mid-round joiner cannot join the round they
arrived in. They still spawn in the lobby (via `handlePlayerJoined`) and can still walk around in it.
The only thing they lost is being told, in words, that they are out of the round.

**Why it went.** Score Rush respawns, so a dead player re-enters rather than sitting the round out, and
the label was an invitation to idle instead of play.

**Team Elimination and Dodge and Seek.** Neither is reachable today (both start paths fix the mode at
Score Rush — see `startMatch`/`VOTE_ENABLED`). Dodge and Seek is unaffected: every death converts and
respawns, and nothing about it read the attribute. **Team Elimination needs one thing re-thought before
it is switched on**: an eliminated player is out for the rest of the round with no readout saying so,
and no HUD gate can tell them apart from anybody else — the state that did that is the one that was
removed. Fixing that means publishing a per-player "in the round" fact again, which is the same
attribute under a different name, so it is a deliberate decision rather than a patch.

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
  `"MatchSpawner"` painted in Studio on the parts the spawner reads. **`TAGS.md` is the register, and
  its table is the count.** This file deliberately quotes no number, because the last one it quoted
  (thirteen) was already stale by the time `Behavior_Seeking` and `Behavior_Dodging` landed. The
  register names the ones this file used to miss — `MatchJoinA`,
  `MatchJoinB`, `practiceZone` (renamed from `ShiftLockZone`), the `MatchJoinTouched` debounce, which
  is the one tag that is state rather than a label, and the two new `Behavior_*` tags.
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
- **The charged throw's envelope, and the cursor that now caps it.** Every body throws the same law
  (`shared/throw.ts`): `CHARGE_MIN_SPEED` **50** to `THROW_MAX_SPEED` **90**, with a vertical fixed by
  `CHARGE_PEAK_HEIGHT` at `sqrt(2·g·h)` = 6 studs/s. So every hold hangs the same **0.6 s** and the hold
  changes the *distance* only — **29.8 studs at a tap and 53.9 at a full one, on level ground.** A player's
  cursor became an input on 2026-10-19: `reachTo` raycasts the point under it, caps the charge to the hold
  that covers that distance, and takes the heading from the muzzle→point line (which is also what removed
  the third-person camera's parallax). **It is a cap and never a solve** — a point beyond the hold's reach
  lands short, along the line the player aimed. Two consequences are open items rather than settled
  behaviour: the cap bottoms out at charge 0, which is still a 30-stud throw, and a point nearer than
  `MIN_AIM_RANGE` is discarded outright (§15 items 29–30).
- **A curve's pull is timed to the flight to the point aimed at**, not to the ballistic hang.
  `reachTo` returns that flight with the charge, and `planChargedThrow` hands the same number to the
  lateral cancellation and to `plan.flightTime`, which `BallService.applyAcceleration` uses to remove the
  force. Those were two different figures, and on a target below the hand the difference left about six
  studs of residual bow at the shipped `CURVE_STRENGTH`.
- **`CATCH IT!` is a prompt, not a rule.** A ball that has tagged somebody is still in the air and still
  owes that body a death, so catching it before it lands releases every tag. The server publishes the
  tagged *side* on the ball (`BALL_TAGGED_TEAM_ATTRIBUTE`, written in the tag branch and cleared on every
  path the tag can end), and `client/catchPrompt.ts` draws one `BillboardGui` over any live ball whose
  tagged side equals the local player's own `TEAM_ATTRIBUTE` — the victim and their teammates, and
  nobody on the thrower's side. No remote, no event: the attribute *is* the answer to "is a catch owed".

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
not allowed to write `Color3.fromRGB` itself. The shop was migrated onto that seam (and onto
`ui/panelChrome.ts`) by the economy work, so it no longer keeps a palette of its own; the geometry in
`shared/config/shop.config.ts` is still the shop's.

### Which `ScreenGui` a thing mounts into — read `ui/screenGui.ts` before adding anything visual

`ui/screenGui.ts` owns every `ScreenGui` in the client *and* the rule for choosing one. The rule is two
questions **asked in this order**; the full argument, with its two counter-examples, is at the top of
that file and is worth reading rather than paraphrasing:

1. **Where does the number that positions it come from?** A *screen* coordinate — `GetMouseLocation()`, an
   `AbsolutePosition` read off something the engine owns — belongs in a `ScreenInsets.None` GUI. A *touch*
   position (`InputObject.Position`) belongs in a `CoreUISafeInsets` one, because that is the space a touch
   is reported in. **When this question answers, it wins** — and its failure is quiet, because the engine
   hit-tests each `ScreenGui` in that GUI's own space, so a misplaced control still *presses* under the
   finger and is only *drawn* wrong. **A working button is not a coordinate-space test.**
2. **Which device is this?** Where question 1 is silent — a thing placed as a fraction of the region it is
   in — the device decides: `CoreUISafeInsets` on a mobile client, `ScreenInsets.None` on a desktop. Where
   the region's inset is zero the two answers are the same origin, so the split is unobservable, not wrong.

| GUI | Region | Its tenants |
|---|---|---|
| `HudGui` — `getHudScreenGui()` | **gated**: safe on mobile, screen origin on desktop | every HUD panel, `ui/hudToast.ts`, the shop and inventory panels |
| `FullScreenGui` — `getFullScreenGui()` | `None` on both, and at `DisplayOrder -1` so the HUD's own panels cover it | the round's readout column (`getHudColumn()` — the score plate and the clock), which is the one HUD pair pinned to the **top edge of the screen** rather than to a corner of the safe region |
| `StickGui` — `getStickScreenGui()` | **gated** (mobile in practice: nothing calls it on a desktop) | the joystick's ring, thumb and movement pad |
| `ScreenSpaceGui` — `getScreenSpaceGui()` | `None` on both | the aim sight, the mobile button cluster — both placed with screen numbers |
| `SplashGui` — `getSplashScreenGui()` | `None` on both | the join overlay — a cover must reach the screen's edges |
| `TransitionGui` — `getTransitionScreenGui()` | `None` on both | the round-start wipe, for the splash's reason |

**A `ScreenGui` of its own is earned only by something that has to draw where the HUD's contents must
not** — a cover that reaches the screen's edges, an element placed with screen numbers, a control that
lives in touch space, or a readout pinned to the screen's own top. **Wanting to sit lower down the screen
is an offset, never a region; wanting the same *picture* on two devices is a region**, and that is the only
reason `FullScreenGui` exists.

**And `FullScreenGui` was quietly the HUD's GUI until 2026-10-19**, which is why it is worth reading before
trusting any older note about it: the accessor looked up the same `GUI_NAME` as `getHudScreenGui`, so it
returned `HudGui` and then wrote `None` onto it — the create/find disagreement the rule above forbids,
performed by a helper whose name promised a second GUI. The dock was its only caller, so on a mobile client
the *whole* HUD's region depended on whether the dock or a HUD controller ran last; the dock is on
`getHudScreenGui` now (it is anchored to the bottom edge, where the safe region is what a phone's home
indicator lives outside of) and the readouts are the GUI's only tenant.

**The device test is `client/platform.ts`'s `isMobile()`** and there are nine callers, no two asking the
same question: which control surface to draw (two HUDs), the shoulder lock, the sprint's share of the walk
speed, the throw's axis and the body's facing on it, the engine's own touch movement, the HUD's region, and
whether the aim assist helps at all. It is
**`TouchEnabled && !KeyboardEnabled`** — so a phone with a keyboard in front of it reads as a desktop,
which is deliberate and is the one client where the region gate does the wrong thing for a notched screen.

**Two log lines are the diagnostics for all of this.** `[screenGui] <Name> created — ScreenInsets = …, …`
prints once per GUI with the region and what decided it, plus a `[screenGui] … was found with …` line if a
GUI is ever found in the wrong region. `[Joystick] inset — …` (from `TouchJoystickController`) prints
`GetGuiInset()`'s two *measured* corners. **Read the joystick's line when you want the inset's size** —
`GetGuiInset()` answers `0, 0` at the moment a client's controllers first run, which is why the
`[screenGui]` line reports the decision and not a measurement.

**The HUD inventory** (`src/client/controllers/hud/`), which is the list to check when the screen is
wrong:

| Controller | Shows | Reads |
|---|---|---|
| `RoundStatusController` | phase, clock, mode name, player count | `ROUND_STATE_ATTRIBUTE`, `ROUND_TIME_ATTRIBUTE`, `ROUND_MODE_ATTRIBUTE` |
| `RoundTransitionController` | the grid wipe | `ROUND_TRANSITION_ATTRIBUTE` |
| `LoadingScreenController` | the join overlay | no attribute — three runtime signals |
| `RespawnHudController` | **two lines** above centre (`0.44` down): the tenths countdown as `h4` seconds + dimmer `subtitle1` tenths, and beneath it `Hit by <name>` — the splash's own styling (`ui/actionSplash.ts`) rather than a copy of it | `RESPAWN_AT_ATTRIBUTE`, `LAST_HIT_BY_ATTRIBUTE` |
| `CurrencyHudController` | `Coins: N`, under the shop button | `COINS_ATTRIBUTE` |
| `SuperHudController` | streak / charge / armed ability / MultiBall window | the four `SUPER_*` attributes + the held ball's mark |
| `StatsBillboardController` | **the round's badges, or** the per-head hit/out record — one billboard, two contents; a rig wears the badge strip alone. **The crown visual is retired** (`CROWN_ATTRIBUTE` still drives `EconomyService.checkMilestones`; the `onFire` badge is the picture now) | `BADGES_ATTRIBUTE`, `STAT_HITS`, `STAT_OUTS` |
| `HitLogController` | who you hit / who hit you, top left, during a round | the `roundHit` event |
| `ControlsLegendController` | the control legend | `THROW_ENABLED` |
| `MobileControlsController` | **the six mobile buttons** — `Drop`, `Catch`, `Curve`, `Dodge`, `Throw`, `Jump` — packed by `pack()` into the bottom-right corner of `getScreenSpaceGui()`, with a cooldown ring behind the two that have a clock and the engine's own jump button dressed or hidden (`HIDE_ENGINE_JUMP`). Glass face at `0.7`, white inverse on a press — §10 has both stories | `CATCH_READY_AT`, `DODGE_READY_AT`; `isMobile()` |
| `ModeVoteController` | the vote row — **dormant**, nothing opens a vote | the `ROUND_VOTE_*` attributes |
| `ScoreHudController` | each side's points during a scoring round | `ROUND_SCORE_A_ATTRIBUTE` / `ROUND_SCORE_B_ATTRIBUTE` |
| `ArenaFreezeCountdownController` | the arena-entry freeze countdown | `ROUND_STATE_ATTRIBUTE`, `TEAM_ATTRIBUTE` (derives its clock from `ARENA_FREEZE_SECONDS`) |
| `DockController` | the Shop / Inventory dock, shown or hidden by phase and zone | `ROUND_STATE_ATTRIBUTE`, `PRACTICE_ZONE_ATTRIBUTE` |
| `ShopController` | the economy: the chest, the power roster, the premium catalogue | `COINS_ATTRIBUTE`, `OWNED_ITEMS_ATTRIBUTE`, `OWNED_COSMETICS_ATTRIBUTE` + the `chestResult` / `purchaseResult` events |
| `InventoryController` | owned cosmetics, equip buttons, milestone conditions | `OWNED_COSMETICS_ATTRIBUTE`, `EQUIPPED_TRAIL_ATTRIBUTE`, `EQUIPPED_ELIMINATION_ATTRIBUTE` |
| `ThemeController` | configures the big-ui theme | — |

**Three rows of this table have changed since it was last reconciled, and only one of them is an
addition.** `MobileControlsController` was missing from it altogether — a strange omission for the newest
thing on the HUD, and the reason the controller's own doc has had to serve as the inventory of the cluster.
`CooldownHudController` (dodge / catch / stamina bars) and `ThrowStateToastController` (the throw's on/off
toast) are **deleted**: neither name appears anywhere in `src/` any more, and the second one took
`ui/hudToast.ts`'s only caller with it (§15 item 36). The first deletion is *why* the cluster's rings
became the only cooldown readout on a phone — see the ring story in §10.

Three shared pieces worth knowing about: `ui/hudToast.ts` (the bottom-centre toast column — **with no
caller at all as of 2026-10-23**: its one consumer was `ThrowStateToastController`, which is gone, and §15
item 36 is what that left behind), `ui/actionSplash.ts` (the `HIT!` look and its one pop — **the style and
the animation are separate calls on purpose**, see below) and the small module-scoped Fusion values
(`aiming.ts`, `sprinting.ts`, `throwing.ts`, `cameraShake.ts`) that carry one fact between two controllers
without either depending on the other.

**`ui/actionSplash.ts` is the answer to "apply the hit-confirm look somewhere else", and it is split in two.**
`styleSplashText(label, { strokeThickness, fit })` applies the theme's font, colour, centring and a `Contextual`
`UIStroke` — plus `TextScaled` + `TextWrapped` unless `fit: false` — to **any** `TextLabel`, in a panel or a
`BillboardGui`, and **starts no animation**. `createActionSplash(scope, parent)` builds a screen-space frame
with that label and returns a handle whose `show(text)` is static and whose `pop(text)` plays the five steps
(pop `Back`/`Out`, settle, hold, fade). **Styling never animates; `pop` is the only thing that tweens.** The
stroke thickness is a per-caller argument, because an outline is a proportion of the word (`hitConfirm` passes
4 for a 150-pixel box, `catchPrompt` 2 for a 26-pixel one, `ArenaFreezeCountdownController` 1 because its card
scale draws it at 6). `fit: false` is for a caller whose size comes from a typography variant and a `UIScale`
rather than from its box — the countdown is the only one. Every colour and the face come from `hudTheme()`
**read per call**, so a palette change stays one file. **Two consequences worth carrying:** `hitConfirm.ts`
keeps the caption ladder and the event wiring and nothing else; and because `UIStroke.Transparency` is
independent of `TextTransparency`, **anything that fades styled text must fade the stroke it got back** — the
countdown keeps one per label (`strokes` / `strokeOf`) and fades it on every arrival, departure and hide.
`catchPrompt.ts` uses `styleSplashText` and deliberately not `createActionSplash` — a prompt is state, not an
event.

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

### The joystick that was one inset away — four passes, and a button that worked

Symptom, from the user: *"My custom joystick is stuck on left bottom. Can we make it dynamic?"* and then,
once the base followed the finger, *"Output. Is there an offset for my thumb, wtf?"* — the base and the
dot drawn **above and left of the thumb**, by the same constant for both.

The ring and the dot were drawn in `getScreenSpaceGui()` (`ScreenInsets.None` — the screen's own origin)
while the number placing them came from a touch, and **`InputObject.Position` is reported in the *safe
region's* space** (the screen minus Roblox's topbar and the device's cutouts). Two spaces one inset apart,
so something had to reconcile them — and four passes went into arguing about which direction, on which
object.

**What settled it was the user looking at their own screen**, which is the only evidence in the story that
cannot be argued with. The reference is genuinely ambiguous — `InputObject.Position`'s page says the inset
*"is accounted for in the position"*, which one reader takes as "already added" and the next as "expressed
in that space" — and every log line the file printed had been telling the truth: the two numbers simply
came from different origins.

**The fix was to delete the degree of freedom rather than to get the arithmetic right.** The ring, its
thumb and the movement pad all mount into `getStickScreenGui()`, a `ScreenGui` at `CoreUISafeInsets` —
the region a touch is reported in — so a touch position, a ring `Position` and the pad's own
`AbsolutePosition` are one kind of number, and `InputObject.Position` is used untouched in all four places
that need it.

**Why it took four passes to see: the engine does its own picking per `ScreenGui`.** It converts an input
into each GUI's layout space before deciding what was hit, so `MobileControlsController`'s five buttons
pressed perfectly while being handed numbers from another space — and that looked like proof that the two
spaces were one space. **What breaks is only the comparison a script makes for itself.** A working button
is not a coordinate-space test; the measurement, short of the player's own eyes, is `GetMouseLocation()`
(documented screen-relative) against a touch in the same session, which is what the joystick's grab line
now prints.

**The same ambiguity had a second victim, and it was in the HUD's own doc.** `getHudScreenGui()` created
the shared GUI with `CoreUISafeInsets` and then set `None` on every later call — thirteen call sites, so
`None` always won, and the doc above it described a region no client was using. That is the class of bug a
find-or-create is one careless `if` away from at all times; the 2026-10-16 pass answered it by routing all
four writes through one function, and §9 has the rule the two of them now follow.

### The buttons that were not transparent black — a glow is a silhouette

Reported in as many words — *"The buttons are not transparent black, they should be"* — one pass after the
one that had already asked for more transparency. The face had moved from `PREMIUM.transparency` (`0.15`,
the glass every panel wears) to `0.7` — seven tenths given back to the arena — and on screen they still read
as six solid discs.

**The cause was not the face; it was the light behind it.** `ui/glow.ts`'s `applyGlow` delivered the wide
half of the bloom as a `UIShadow`, and **a shadow is a blurred silhouette** — it is inked across the
shape's whole *interior* as well as around it. Behind a `0.15` face nobody could tell, because the face was
nearly what the glow was; behind a `0.7` one the glow *was* the fill, and the transparency had nothing left
to show. Every property the file was writing was correct, which is why two passes went into the alpha
rather than into the bloom.

**The fix is a different shape of bloom, not a different colour.** `applyGlow(instance, colour, blur)` now
takes a third argument; `false` makes the wide half a `Border` `UIStroke` — the same one the helper already
fell back to on an engine without `UIShadow` — whose ink is only ever the rim. The cluster passes `false`,
every other caller keeps the soft shadow, and the default is `true` so nothing changed by silence. **What
the glow loses is softness; what it keeps is colour, weight and meaning**, and that distinction is worth
stating plainly because the request was for it to be unchanged, and literally unchanged was not available.

**The general rule, which is the part worth carrying:** an effect parented to a control that has to be seen
through must be a stroke, a child drawn inside the rim, or a sibling behind it whose own alpha *is* the
shape wanted. A blur or a drop shadow works on the silhouette, and the silhouette of a disc is a disc.

### The cooldown ring, in four shapes — and the one that needed the button to move

The request was *"a small, thin circular cooldown arc in the top-right corner of the mobile action
button"*, then a Material progress indicator. Getting there took four drawings, and each failure is worth
keeping because the next one answered it:

1. **A full-button disc that drained** — right geometry, invisible: the two states were `#080A0F` and
   `#0C0F16`, four to seven units apart on 255, on a control that was nearly that colour itself.
2. **A full-button wedge that filled** — visible, and it read as *the button changing colour*, which was
   rejected. A pie chart on the control is not a gauge beside it.
3. **A corner dial, 21 px** — the right idea in the wrong place: it competed with the button's own word for
   attention and, being in the corner, was under the thumb that had just pressed it.
4. **A hairline ring at the button's own diameter, behind the button, revealed by shrinking it** — what
   shipped. The ring is a **sibling** at the button's full size and one `ZIndex` below it, so while the
   button is at `1` the ring is entirely covered; the button shrinks to `COOLDOWN_SHRINK` (`0.85`) and the
   7.5 % of the radius it gives up on every side *is* the band the ring occupies. **Nothing about the ring
   animates** — the button moves and the ring is simply there.

**Three engine facts were learned against the thing itself rather than read, and all three are now in this
project's notes:**

- **`UIGradient.Rotation` is clockwise**, and its control points stay centred on the frame at every angle,
  so a hard edge at offset `0.5` is a **diameter** — rotating it sweeps a **radius**. That is what makes two
  clipped half-frames a sweep from 12 o'clock rather than two wipes out from the centre.
- **`ClipsDescendants` with a `UICorner` rounds its immediate children and never its grandchildren.** The
  first ring came out as a **square with a round hole in it**, because the fill two levels down was clipped
  to its *rectangle*. Each fill now carries its own `UICorner(1, 0)`: the half's rectangular clip makes the
  semicircle, the fill's own corner makes the circle, and the two clips do one job each.
- **A ring behind a transparent button has a second job.** The wedge is drawn under the *whole* control, so
  at `0.7` its lavender tinted the face for the length of the cooldown. An opaque `PREMIUM.void` disc at
  `ZIndex 1`, sized `1 − 2 × RING_WIDTH`, covers that interior and leaves only the band outside the button.
  The side effect — a cooling button looks backed, a ready one looks like glass — is deliberate, and it is
  the first thing §15 item 34 says to check if the transparency is still wrong.

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
- **The mobile input surface** (`63af8e8`, `aa3a3ad`, `0325c9a`; §9). The ring drawn in place of the
  engine's thumbstick, the five-button cluster around the engine's own jump button, the sprint read off
  the body rather than off the stick, an aim sight for a client with no cursor, and the cooldown readout
  deleted. **The one fact to carry from it: the engine's stick is hidden and still listening**, so a
  character that walks is not evidence about the ring — `TouchJoystickController`'s class doc has the
  whole arrangement and the two logs that settled the movement mode. **And the ring is drawn only while a
  finger is on it** (2026-10-16, at the user's request: *"I want my joystick to 'disappear' when not
  actively being used"*), so **the empty lower-left corner in a screenshot is the expected resting state
  rather than a missing stick**; a push anywhere in the movement zone brings it up under the thumb.
- **The better HUD layout** (`2d40684`, `b74c364`). The score plate and the clock became two children of
  one `UIListLayout` (`screenGui.ts`'s `getHudColumn()`), which is the fix for the plate being drawn
  *across* the clock in every intermission — see that function's doc for the two `14`s that did it.
- **The GUI region rule, and the create/find fix under it** (2026-10-16; §9, and the story above) —
  `ui/screenGui.ts` gained the written two-question rule, one `edgeAnchoredInsets()` for all four gated
  writes, a `[screenGui]` line per GUI created, and one clause corrected in `hitConfirm.ts`, whose comment
  had asserted that the shared GUI is always inset.

**Completed 2026-10-17 → 2026-10-19** (`git log 196a5b3..efcbc37`; §16 records the four lines the
2026-10-19 capture added to the confirmed list, and §15 items 29–33 are the five things it left open):

- **The rigs that fill the lobby, and the walk to a join pad.** `npc/rigPool.ts` draws a name and a body
  from what is *free*, so no two live rigs share either; `behaviors/WalkToJoinPadBehavior.ts` walks a rig
  to its match join part under the same movement law as `SeekBehavior`. **This landed through the
  `npc-playing-rounds` merge (`d7af44d`)**, and the earlier attempt on `main` was reverted first
  (`169885e`, `286ae45`) — read the merge, not the reverted commits.
- **`WalkSpeedService` rebuilt as contributions plus caps** (`3194128`, `b3a1cf3`). One `Base` + `Sprint`
  sum per body, with a separate `caps` map under `ACTION_CAP_KEY`, and `enforceActionCaps()` on every
  `Heartbeat` — so the aiming ceiling (`AIMING_WALK_SPEED`, 8) is decided live rather than written once
  and hoped over, which is what makes it impossible for a stale cap to stick after a stance ends.
- **The power slot, one crown a side, a held aim pose, spread-out pad walks, and the Pierce trail**
  (`f699436`). A prize now displaces a dev's armed ability in the one slot rather than beside it (§11).
- **`hitConfirm` gained the tally and the `WIPEOUT!` caption** (`d69a099`), which is the one caption the
  client cannot work out for itself and therefore outranks everything.
- **`playSpawnPoof(model)`** (`4769c8f`; `server/vfx/spawnPoof.ts`, `config/spawnPoof.config.ts`) — the
  one appear/disappear/teleport effect, called from fifteen sites across `RoundService`,
  `LobbyRigService` and `RespawnService`. **It is anchored where the body stood and deliberately not
  welded to it**, and it delivers its burst by raising `Rate` for a window rather than by `Emit` — the
  same server-side-emission lesson the deleted gust left behind (§17): what replicates is the emitter's
  **properties**, so a clone at `Rate = 3` emitted nothing anyone could see.
- **The `CATCH IT!` prompt, the sided lobby spawns, and `BALL_TAGGED_TEAM_ATTRIBUTE`** (`c063f37`; §7).
  `lobbySpawns.ts` reads `LobbySpawns/A` and `/B` by `TEAM_ATTRIBUTE` for a rig's seat, and
  `RoundService.returnRigsToLobby` was moved onto it — the side-less `lobbySpawn()` was the wrong-side
  bug. The ball now publishes the side it owes, and the client draws the prompt from that alone.
- **The cursor as the throw's aim point, the curve's timing, and the retuned envelope** (`efcbc37`;
  §7). `ChargeRequest` gained `aim`; `reachTo` caps the hold to the point under the cursor and supplies
  the heading from the muzzle; `planChargedThrow` times a curve's lateral cancellation to the flight to
  *that point* rather than to the ballistic hang. `CHARGE_MIN_SPEED` is 50 and `CHARGE_PEAK_HEIGHT` is
  0.9, which is a **30→54-stud** envelope on level ground — not the 150 studs that function's own
  comment still describes (§15 item 29).
- **The round's two readouts moved to `getFullScreenGui()`** (uncommitted at the time of writing,
  2026-10-19). The score plate and the clock are the one HUD pair pinned to the **top edge of the screen**,
  and in the gated GUI the safe region put them a topbar-plus-cutout lower on a phone than on a desktop —
  which reads as "the timer and the scoreboard are too low on mobile". `getHudColumn()` parents into
  `getFullScreenGui()` now, so `COLUMN_TOP_INSET` is a distance from the *screen's* top on both devices.
  **The accessor had to be fixed first**: it looked up `HudGui`'s name, so it returned the shared GUI and
  wrote `None` onto it, which made every earlier attempt to use it a no-op — see §9. `DockController`
  moved to `getHudScreenGui()`, because a bottom-anchored dock wants the safe region.
- **The hit-confirm look became `ui/actionSplash.ts`** (uncommitted at the time of writing, 2026-10-19),
  at the user's request — *"let's extract the style and animation… the animation will not be automatically
  added to text. But it would be great if it could be added if needed"*. The style was already copied in
  two files (`hitConfirm.ts` and `catchPrompt.ts`) and the second one's doc said so. **The split is the
  contract**: `styleSplashText(label, { strokeThickness })` styles any `TextLabel` and starts no tween;
  `createActionSplash(scope, parent)` returns `{ show, pop, hide }` where only `pop` animates. The five
  steps, the box (`760 × 150`, top `0.26`, cap `0.86 × 0.24`), the `Back` easing and the generation token
  moved with it; the caption ladder, `HIT_WINDOW_SECONDS` and the event wiring stayed in `hitConfirm.ts`,
  which now reads no theme at all — the module reads `hudTheme()` per call. **One roblox-ts trap hit here
  again**: the `ActionSplash` interface declared `show(text: string): void` methods, and `rbxtsc` refuses
  an object literal whose member is an arrow function for a declared *method* (§3) — declare them as
  function-typed properties instead.
- **The arena-freeze countdown wears the same style** (same day, same uncommitted change), at the user's
  request — *"apply this same `splashStyle()` to the countdown that plays when the round is first starting
  and the models are frozen"*. `ArenaFreezeCountdownController.addLabel` now calls
  `styleSplashText(label, { strokeThickness: 1, fit: false })`, so each number gets the splash's font,
  white and `Contextual` `trough` outline. **Two things were not a copy-paste:** `fit: false` keeps the
  `h4` variant plus the card's `NUMBER_SCALE` as the only two decisions about type size (turning
  `TextScaled` on would have made a third, and `AutomaticSize.X` would be measuring text it sized itself);
  and the stroke had to be **faded everywhere the number fades** — a crossing's departure, an arrival,
  "Start"'s fade-out and `resetLabels` — because `UIStroke.Transparency` is not part of its label's
  `TextTransparency`. Left alone, every tick would have left a black outline of a number that had gone.

**Completed 2026-10-23, and every one of these is uncommitted at the time of writing:**

- **The mobile cluster's face, its press, and its glow** — §9's inventory table has the controller in it
  now, which it did not before. Idle is `PREMIUM.void` at `IDLE_TRANSPARENCY` (`0.7`); held is
  `PREMIUM.text` at `HELD_TRANSPARENCY` (`0.2`) with `void` ink on the face *and* on the word under it;
  and `ui/glow.ts`'s `applyGlow` grew a `blur` argument so the cluster can ask for a `Border` stroke bloom
  instead of a `UIShadow`. **The story is above this list, and it is a story because those two halves look
  independent and are not** — the bloom had to change shape before the face could be see-through at all.
- **The press tracker the cluster is built on**, which is what makes a swipe not a press: the button's own
  events are used only to learn *which input landed on it*, and the gesture is measured against
  `UserInputService.InputChanged` / `InputEnded`, identity-matched on the `InputObject`, with
  `DRAG_THRESHOLD` 10 px, `HOLD_CONFIRM_SECONDS` 0.05 s and `TAP_FLASH_SECONDS` 0.12 s. A tap fires at its
  release, a hold at the confirm, a flick fires `down` + `up` back to back, and every one of those
  decisions prints a line.
- **The cooldown ring** (`addCooldownOverlay`, `trackCooldowns`, `rightHalfAngle` / `leftHalfAngle`): a
  hairline ring *behind* the button, revealed by shrinking the button to `COOLDOWN_SHRINK` (`0.85`) over
  `COOLDOWN_SHRINK_SECONDS` (`0.1`). Catch and Dodge only — the two `TouchControl`s that name a
  `cooldown` attribute, which is also the whole of what gives a control an arc. **Throw's charge meter is
  gone** and `ThrowController.currentCharge` is private again.
- **A caught throw gets its own sentence** (`LAST_HIT_BY_CAUSE_ATTRIBUTE`; `client/enemyView.ts`).
  `"Hit"` is written by `registerHit`, `"Catch"` by `resolveCaughtThrower`, and the caption becomes
  `caught your shot!` with the `ENEMY VIEW` header hidden rather than rewritten. **The catch path had no
  writer for the other three attributes at all**, so a catch death used to reach the kill cam with no
  identity or with a stale one from earlier in the same life; the four writes now come from one place.
  §15 item 37 is what is still open about it.
- **The round's admission strip and its armed-power sweep** (`RoundService.admitWithCover`,
  `clearArmedPowers`). A player arriving from a practice zone loses the ball in their hand and the power
  in their arm **before the side is written**, printing `[Round] <name>: admitted — held ball and armed
  power cleared` only when something was actually taken; and every player not in a practice zone has
  their arm ended at the round's start, which the ball sweep alone could not do (an arm with no ball
  behind it is a fact about the *player*). The new attribute is cleared exactly where its three
  neighbours are — on a body arriving, and at the `Playing` edge for the whole roster.
- **The loading screen's `TITLE` is `No Headshots`**, against `DODGEBALL Hero`.

### Completed since the 2026-10-11 revision (the four in the header, in detail)

- **One animation pipeline for players and rigs.** `shared/animation.ts` holds the table and the rule;
  `client/bodyAnimation.ts` holds `applyBodyRender`, which both `LocomotionAnimationController` and
  `RigAnimationController` call. The player's four locomotion words and the rig's twelve states are one
  table, so a state added there is a state **both** bodies can be dressed in — which is the property the
  unification exists to buy. The walk/run line is decided by **measured speed** rather than by whether a
  key is held (`CHARACTER_CONFIG.RUN_ANIMATION_SPEED`), a reversal recorded at that constant, because
  the key version had no meaning for a body without a key.
- **`hitImpact` — the second hit event.** `roundHit` is gated to hits with a player at both ends, so a
  rig's throw and a ball that lands on a rig produced no event at all and no client could draw them.
  `RoundService.registerHit` now sends `hitImpact` for the rest, and `hitVfx` reads it and nothing else
  — both events would have doubled a player-on-player hit. Attacker draws gold on the victim, victim
  draws red on their own body, a bystander draws the neutral template.
- **The catch cause.** `CATCH_ANIMATION_ATTRIBUTE` carries `"attempt" | "catch"` instead of `true`,
  because a catch written over an attempt is a *different value* and so fires a change where a boolean
  rewrite does not. `bodyAnimation` hands the cause to the effect **above** the clip guard, because both
  causes play the same clip and the clip's edge fires once, on the attempt — which is why the green
  never drew.
- **A rig's throw is telegraphed, and the charge is drawn.** `createWindupTracker` (in
  `ThrowBehavior.ts`, imported by `AlwaysThrowBehavior.ts` so the two cannot disagree about what a hold
  is) solves the charge from the distance once, publishes `CHARGING_ATTRIBUTE`, and arms a token-guarded
  expiry timer that can only cancel — the leak a removed tag would otherwise leave, since nothing fires
  on `RemoveTag`. The hold is `charge × CHARGE_SECONDS`, i.e. **the same duration a player's own hold
  would have been at that distance**, so the effect on a rig's hand means what it means on a player's.
  `AlwaysThrowBehavior` moved its cadence from a 5 s tick to a 0.1 s tick with a 5 s decision clock,
  which is why a practice rig now throws about every 5.8 s rather than every 10 — accepted rather than
  overlooked.
- **The server's gust is deleted and the client's is not.** `server/services/ball/WindBurst.ts` is gone,
  along with its call site in `BallService` (left as a note on the same line) and the thirteen
  `WIND_BURST_*` entries in `throwFeedback.config.ts`. The lesson it was deleted with is kept there as a
  tombstone: an emitter **built on the server** and fired with `Emit(N)` is invisible to every client,
  because an emission is an *event* and what replicates is the emitter's **properties**. The replacement
  runs on the client that renders it, where `Emit` is the correct call — see §17.

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

**There are two charge attributes now, and they are different words for different things — do not
read one as the other.** `SUPER_CHARGE_ATTRIBUTE` is the above: a **boolean on the `Player`**, the
ability grant that nothing currently pays out. `CHARGING_ATTRIBUTE` (since 2026-10-13) is a **number
0..1 on a *rig's* `Model`**, written by `ThrowBehavior`'s windup and read by the client's charge
effect: it is *how much of a throw's hold a rig is currently holding*, it has nothing to do with the
super system, and it is deliberately not published for players (a player's own hold is measured on
their own machine and never sent). The rig-only asymmetry is the point of it — a rig telegraphs its
charge to everybody, which is what makes a rig's throw dodgeable — and it is argued in full at the
constant, which also records the reversal from `true` to a number: a threshold cannot be asked of a
flag, and the fire ball's 90 % overlay is a threshold. Anything asking "is this body charging" wants
`CHARGING_ATTRIBUTE` if it means a throw and `SUPER_CHARGE_ATTRIBUTE` if it means an ability.

**The charge is spent at different moments per ability, deliberately**: MultiBall at the press
(a window bought is a window paid for), Pierce and Freeze at the *throw* (the charge follows the
ball, so marking a ball and changing your mind costs nothing).

**MultiBall** — `SUPER_CONFIG.MULTI_BALL_BALL_COUNT = 5` (counted in **throws**, not balls on the
field). **There is no duration any more**: `MULTI_BALL_DURATION_SECONDS` was removed and the count is
the whole limit — spending the fifth throw is what closes the window (`SuperService.consumeMultiBallBall`
drops the row). It refills the hand at the moment the window opens and after each throw
(`BallService.refillFromBuff`), and the ball already in hand when the window opens is *on top* of the
count. The window is a **stock rather than a burst** now, and the cost of that is written out in
`super.config.ts`. Closed by spending the last throw, by death, by the intermission and by the round
end.

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
- **The Power Chest** costs `CHEST_COST = 50` and rolls **over the whole of `CHEST_POOL` — unowned
  entries included** — so a duplicate is possible and is the commonest outcome, deliberately
  (`EconomyService.openChest`; the pool is the powers plus three chest-only trails). The 50 coins go
  before the outcome is known, and `chestResult` carries four outcomes, not three: "your record is
  still loading", "not enough coins", "nothing left in the chest to win", and "you already had that
  one" — the duplicate, which is the mechanic rather than an error. The design still calls the whole
  thing a **tutorial at three powers**: `POWER_ROSTER` is the powers half of the pool.
- **Milestones** grant free cosmetics and are **never purchasable**. Seven of them over `matches`,
  `wins`, `hits` (read from `StatsService`'s lifetime `STAT_HITS`) and `crown`. `checkMilestones` runs
  after a load, at every round end, and when `CROWN_ATTRIBUTE` changes; it skips what is already
  owned, so it is idempotent and there is no per-milestone state to save.
- **The premium catalog** is `PREMIUM_COSMETICS` (derived from `COSMETICS` where `priceRobux > 0`) —
  Aurora trail 99, Ember trail 149, Lightning KO 249. **Every `gamepassId` is `0`**, i.e. a
  placeholder that has never been filled in, and nothing consumes one yet. The intent is one **Game
  Pass** per catalog item and **no Developer Products** at all, because the design has no repeatable
  purchase to sell.
- **Persistence** is now the same shape in both services, and the two live in
  `src/server/persistence/` rather than in either service: `"Economy"` and `"PlayerStats"` are still
  separate stores and separate records, but the *rules* about writing them are shared. **Read
  `sessionLock.ts` and `shutdown.ts` before touching either service's write path** — §12b has the
  whole account.
- **Dev commands registered here:** `!dev coins` (+1000) and `!dev powers` (grant the full roster).
- **The shop GUI is wired now, and the briefing about its old mock is not.** `ShopController` *was*
  the static mock and is not any more: it has two tabs ("Cosmetics", "Power & Items"), sends
  `openPowerChest` and `purchaseCosmetic`, and reads `chestResult` / `purchaseResult` back; the
  inventory's equip and pool toggles go through `equipCosmetic` / `togglePowerPool`. Trail cosmetics
  **do** render — `BallService` reads `EconomyService.equippedTrailColors` / `equippedTrailId` and
  hands them to `BallTrail.attach`. Elimination cosmetics are still ownership-only (nothing reads
  `EQUIPPED_ELIMINATION_ATTRIBUTE`). `SHOP-PANEL-BRIEFING.md` still describes the retired mock; it is
  kept as a record of it, not as a description of the current panel.

---

## 12b. Persistence — the two stores, the session lock, and the bounded shutdown

Added 2026-10-17. **This section is the account §12's persistence bullet points at**; it covers both
services because the change that created it made their write rules identical in everything except the
record's contents. The two records are still separate — `"PlayerStats"` holds `hits`/`outs`,
`"Economy"` holds coins, items, cosmetics and the two counters — and they are still separate stores.
**Nothing here has been confirmed in Studio**; §16 does not gain a line from this pass.

**Where the rules live, and why not in the services.** `src/server/persistence/sessionLock.ts` owns the
two record fields, the "may this write happen" test, and the one function that stamps a payload.
`src/server/persistence/shutdown.ts` owns the shutdown window, the per-write deadline and the
thread-and-poll that enforces it. **Both sit outside `src/server/services/` on purpose**: Flamework's
`addPaths("src/server/services")` recurses, so a plain module under it gets an identifier in
`flamework.build` whether or not it holds a decorator. `npc/rigPool.ts` is the precedent. Neither
module appears in the manifest.

**A record is still loaded once into memory and written from memory**, which is the platform's
recommended shape and unchanged. What changed is *when* it is written:

| Boundary | Where | Why |
|---|---|---|
| the player leaves | `saveAndForget` | the only write that must not be lost, and the one that **releases the lock** |
| **a round ends** | `StatsService.onRoundEnded`, the tail of `EconomyService.onRoundEnded` | the instant a record stops changing; **this is the new one** |
| every `AUTOSAVE_INTERVAL = 180` s | both `autosaveLoop`s | the backstop for a crash, which `BindToClose` never runs for |
| the server shuts down | `saveAll` via `BindToClose` | the last chance, and the only one that waits |

**The coalescing rule is not weakened by the round-end write, and the user's constraint is the
reason it exists**: *"I don't think player hit and death ratio should be saved instantly for each."*
Nothing on a hit, a throw, a death or a pick-up touches the store. `flush(player, why)` is the only
path a boundary takes, and its first act is to compare the record against what was last written — so
a round end writes only the players who gained something in that round. `why` is not decoration: the
log line `[Stats] <Name>: saved NH/MO — the round end` is the only evidence that the boundary fired at
all, and without it a round end that saved nobody and one that saved eight look identical.

**`StatsService` gets no roster from the round, deliberately.** `RoundService.finishRound` calls
`this.stats.onRoundEnded()` with no arguments, and the service sweeps every record it holds. The
obvious argument — `playersInRound()` — is **wrong**, and this is the trap to know: that accessor is
`activePlayers`, and `eliminate` deletes from it *during* the round, so at the round's end it is the
survivors — exactly the players whose `outs` did *not* go up. The dirty test makes the sweep cost one
comparison per unchanged player, so the superset buys correctness for nothing.

**The session lock, in the shape it was built.**

- **Two fields on the saved value: `SessionId` and `LastUpdated`.** A deliberate departure from
  Roblox's reference implementation, which keeps its `LockId` in the key's *metadata*. Both records
  are read by shape-checked parsers that ignore unknown fields (`toStats`, `toEconomyRecord`), so two
  plain fields cost nothing: an old record parses exactly as before and simply reads as unlocked. The
  metadata route would have needed a `DataStoreKeyInfo` plumbed through every transform in two
  services and a second storage mechanism to keep honest.
- **The claim and the read are one `UpdateAsync`.** `GetAsync` followed by a write would leave the
  window the lock exists to close. The transform takes the record if it is unlocked, already ours, or
  expired; otherwise it returns `nil`, which is the documented way to *cancel* a write rather than
  perform one.
- **A failed claim does not kick anybody.** The player gets a blank record — published, so the HUD and
  every ownership gate have an answer — and joins `unsaveable`, which is the "mark it errored so it is
  never written" rule from the docs. **One set serves two roads**: a load that failed, and a lock held
  by another server. The second road is why the refusal is permanent for the session: the moment the
  other server releases, a retry would *succeed* and write the copy this server read before the hop.
  **Writing a blank record over a real one is the wipe the docs warn about by name, and it was live
  here before this pass**: the economy's `fetch` answered `undefined` on a failed read, `toEconomyRecord`
  turned that into a zero wallet, and the next sweep wrote it back.
- **Leaving releases the lock; the expiry is for crashes.** `saveAndForget` writes with `release = true`,
  which drops both fields. A player who hops servers lands unlocked; a server that dies holding a lock
  costs the next one a wait, and `LOCK_EXPIRY_SECONDS = 300` (**Placeholder**) is that wait — one
  autosave sweep of slack plus a slow one, against the reference's thirty minutes, because a round here
  is 150 s.
- **No `MessagingService`, and the cost is named.** The docs' lock is transactional, and cross-server
  messaging is best-effort. Without it a superseded server keeps trying until its next write — and that
  write is *refused by the transform*, which is the guarantee that matters. Adding it would buy a
  faster refusal in exchange for a subscription and a failure mode of its own.
- **Every write is `UpdateAsync`.** It costs read *and* write budget (documented), which at
  `60 + numPlayers × 40` writes a minute against ≤ 20 actual writes does not matter, and it is what
  makes the lock check possible at all.

**The shutdown is bounded, in one place.** `BindToClose` gets **30 s** from the engine and runs bound
functions *in parallel*, so the two services' saves stand in one window rather than two. `shutdown.ts`
states the budget once: `BIND_TO_CLOSE_SECONDS = 20` (**Placeholder**) for the whole save,
`WRITE_DEADLINE_SECONDS = 5` (**Placeholder**) for any single write. Each write is taken as
`math.min(windowLeft, 5)` and run through `runWithin`, which is a thread and a poll — **the only
available shape**, because a throttled `UpdateAsync` *"continues to yield as long as its request is
still queued"* and cannot be cancelled. When the deadline fires the player is named and skipped, the
next one gets what is left of the window, and the loop ends with `shutdown ran out of its 20s window —
N record(s) not saved`. **A shutdown that runs out of time is a data loss with a log**, and that is the
decision, not an accident.

**Failures print, on both sides.** `EconomyService.write` used to do `const [success] = pcall(...)` and
throw the error away — a wallet that stopped saving with nothing in the output. It now prints
`[Economy] write failed for <Name> (<userId>): <error>`, one line per attempt, and `StatsService` has
always printed both of its attempts. The stats retry now **sleeps** between them
(`RETRY_SLEEP_SECONDS = 1`, **Placeholder**) instead of re-issuing in the same frame, which was one
throttle turning into two writes. The economy still has **no retry** — the asymmetry is known and
deliberately not unified here (§15 item 25).

**The log lines to look for** if any of this is ever seen in Studio: `[Stats] <Name>: loaded NH/MO
(locked)`, `[Stats] <Name>: saved NH/MO — the round end`, `[Economy] <Name>: saved N coins — the round
end`, `[Stats] claim failed …` / `[Economy] write failed …`, and the two `shutdown — N record(s)
written, M skipped` summaries. `DEBUG` is `true` in both files, so all but the last two print by
default.

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
- **The countdown's second line — `Hit by <name>` — is a second attribute on the same player.**
  `LAST_HIT_BY_ATTRIBUTE` is written by `RoundService.registerHit` **at the tag** (a player's
  `DisplayName`, a rig's `Name`), from the `thrower` that method has already resolved, and cleared by
  `RoundService` when a body arrives and at the `Playing` edge. **It cannot come from `roundHit`**: that
  event is sent only with a person at *both* ends, so it can never name a rig's throw — which in a round
  against rigs is most of them.

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

1. **The economy is committed and wired but has no Studio confirmation recorded here.** Nothing in it
   is confirmed in a live log: not the DataStore round-trip, not `!dev coins`/`!dev powers`, not the
   chest reply (`events.Server.Get("chestResult").SendToPlayer`), not the round-end payout, not the
   milestone grants, not the shop's own chest/inventory buttons. (It is no longer *"uncommitted as of
   this writing"* — that line described the previous revision at `5bcc374`; the economy landed in
   `879d374` and onward.)
2. **The power lock means a brand-new player has no abilities at all.** Keys `3`/`4`/`5` refuse with
   `[Super] … not owned` until a chest grants one. **The Shop now renders the roster as `Owned` /
   `Locked`** (`ShopController`), so the state is at least visible in the panel; what is still missing
   is a reaction at the key — `SuperHudController` shows the streak/charge strip regardless, and there
   is no "you don't own this" toast when a key is refused.
3. **The shop GUI is wired, and `SHOP-PANEL-BRIEFING.md` is stale** (§12). The briefing documents the
   retired mock (five tabs, a box picture with odds) rendering almost empty; the current panel is two
   tabs and asks the server for the chest, so the briefing is a record rather than a description. Its
   §6 claim that `getHudScreenGui()` uses `None` insets **was right about the runtime and wrong about the
   source**: the create branch said `CoreUISafeInsets` and the find branch forced `None`, so `None` won
   on every device — the previous revision's note that "it uses `CoreUISafeInsets`" was the wrong
   correction, and the 2026-10-16 pass fixed the code instead. As of that pass the true answer is
   **gated** — `None` on a desktop client, `CoreUISafeInsets` on a mobile one (§9) — the briefing has been
   corrected to say so, and §7's arithmetic still rests on it: on a *desktop* client the panel's own
   offsets are measured from the true screen top and Roblox's topbar overlaps the top of them.
4. **Trails render; elimination effects do not.** `BallService` passes the equipped trail's colours to
   `BallTrail.attach`, so an owned trail is worn on the ball. Nothing reads
   `EQUIPPED_ELIMINATION_ATTRIBUTE`, so an owned elimination cosmetic is ownership-only still.
5. **Every premium `gamepassId` is `0`.** No Game Pass exists yet, so the catalog is unbuildable as
   a purchasable thing until the developer creates them in the dashboard.
6. **The Pierce preview gap is now server-side only** — this item was stale until this pass and is
   corrected here. The *client* preview no longer lies about Pierce: `ThrowController` passes
   `passable: passesThroughBodies` into `Trajectory`, which lets the drawn arc fly through bodies
   exactly as the ball does, so the arc, the landing marker and the glow agree. What is still not
   Pierce-aware is the **server-side diagnostic** `ThrowProbe`, whose own comment says so ("built with
   no `passable` predicate … the ball keeps going past the contact this predicts"). The held-ball
   `CanQuery` half was fixed earlier. The `BallComponent` comment this item used to quote as current is
   now itself stale — see item 12.
7. **Only Score Rush is playable** (§8) — the other two modes are unreachable, and re-enabling them
   means deciding whether the vote comes back or the mode is chosen some other way.
8. **The `+3` stud lift** in the spawn lookup was kept against the user's own snippet and is still
   unconfirmed as wanted.
9. **`IasTest.ts`** is a finished input test with `DEBUG = false`, written to be deleted.
10. **`shared/module.ts` is a stub** (`makeHello`) and `src/shared/config/ui.fon` is an empty file.
    Both are dead weight.
11. **`rojo serve` exits 1** (§1). Cause unknown, not investigated.
12. **Stale comments found while reconciling the docs — comments that argue for a design the code has
    stopped making.** Each is a claim the code contradicts, so a reader who trusts the comment believes
    a false thing. None is fixed here; each wants its own small pass, and they are grouped because they
    share that cause (a one-line comment correction, not a behaviour change):
    - **`src/client/ui/screenGui.ts`** — "nine HUD controllers parent into it … a decision nine files
      depend on". **Fixed in this pass, and the sentence is now a description rather than a count** (§10).
      For the record, re-derived from the source: **eleven** HUD controllers call `getHudScreenGui()`,
      plus `ui/hudToast.ts` and this file's own `getHudColumn()` — thirteen call sites, not the fourteen
      the previous pass recorded. *(As of 2026-10-19 the total is still thirteen but the members changed:
      `getHudColumn()` parents into `getFullScreenGui()` and `DockController` moved onto
      `getHudScreenGui()` — §9.)*
    - **`src/client/ui/panelChrome.ts`** — "there are nine builders that each do exactly what the shop's
      own private method did before". The file exports about twenty builders.
    - **`src/shared/config/economy.config.ts`** — "The launch milestone table — six achievements,
      deliberately few." `MILESTONES` has seven entries.
    - **`src/client/roundZone.ts`** — `inTaggedZone`'s doc says "This is the one place the tag is read".
      `ShiftLock.reportZoneParts` reads `PRACTICE_ZONE_TAG` too (for its own count), so the exclusive
      claim is false — though the *rule* is still roundZone's, and the client-side register row now says
      so in `TAGS.md`.
    - **`src/server/components/BallComponent.ts`** — "The preview lies about Pierce, and it is known to.
      That fix belongs in `Trajectory`". `Trajectory` grew the `passable` hook and the client uses it, so
      this describes a gap that is closed; see the corrected item 6.
13. **`isRoundActive` is duplicated, and it is a decision waiting rather than a bug.** `SuperService.isRoundActive`
    is `private`; the public `SuperService.inRoundOrZone` wraps it, and that is what `BallService` calls.
    `StatsService` keeps its **own** private `isRoundActive`, reading the round folder the same way. §0's
    "a query is lent out, not copied" example was corrected to name `inRoundOrZone`, so item and principle
    do not describe the same state — but the principle's *older* example (`isRoundActive`) is now a copy
    in two files. Whether to collapse them into one shared read is a decision for a later task; recorded
    here, not fixed.

**Found by this pass (2026-10-14), none of them fixed:**

14. **`HitNeutral` is not in `ReplicatedStorage`, and a live log says so.**
    `[VFX] no HitNeutral in ReplicatedStorage — that hit effect will not play`, followed by the
    near-miss list, which shows the other vfx assets present and no `HitNeutral` among them. The
    consequence is exact: **a bystander's hit draws nothing**, while the attacker's gold and the
    victim's red both draw. It is a place-file fix — make the template and name it — not a code change.
15. **`NPC_CONFIG.THROW_RANGE_STUDS` (150) promises more than the shared throw envelope delivers.**
    The rig-only gate is the distance at which a rig will *decide* to throw; the shared law every body
    throws under (`chargeForRange` / `chargeSpeed` / `peakAngle`, both bodies sending `kind: "charged"`)
    reaches about **79 studs to a body's root and 54 to level ground** at a full hold — the 79 is
    unchanged since this item was written, the level figure was **65 before the 2026-10-19 retune and is
    54 now** (§10, §15 item 29). So a rig with a target between roughly 79 and 150 studs telegraphs a
    full 1.25 s windup and then **throws short** — the most visible half of the windup doing nothing. It
    is the last rig-only number in the throw. Lowering it to about 80 would make the gate and the power
    agree; the alternative is leaving a deliberate "throws at anything it can see" and accepting the
    wasted windups.
16. **`LobbyRigService`'s doc argues from a premise that is now false.** Around line 987 it explains that
    the arena freeze cannot reach a rig because "there is no speed sum for a rig to hold back". Since
    2026-10-14 **a rig has a speed sum** (`Base` + `Sprint`, §17). The conclusion is unaffected —
    `ARENA_FREEZE_KEY` is only ever applied to a player's character, so the freeze still does not reach a
    rig — but the sentence is wrong about *why*. One-line correction, in a file that pass did not own.
17. **`ChargeHand`'s `Core1` emitter runs at a rate of 150**, against `Energy1` and `Energy2` at 20, in
    the log's own dump of the template. Either the author meant a core that fires five times as densely,
    or it is a typo that only Studio can show — nothing in `src/` knows what is inside a template.
18. **The four body effects each carry their own `findTemplate` → `carrierOf` → `templateEmitters`
    pair.** This is deliberate and precedented (`shared/find.ts` says at length why the per-effect walk
    lives beside the effect: the lookup accepts a `Model` *or* a loose `BasePart`, which that file's
    one-class-per-helper shape cannot ask) — but it is also four copies, and it is the thing to look at
    first if a template bug is ever fixed in one effect and not the others.
19. **"I can't join the game" was reported once and never diagnosed.** It followed a build that added the
    client charge effect, was not reproducible in the sessions afterwards, and no line of it was ever
    captured — so there is no evidence in either direction about whether it is still there. Recorded
    because an unexplained report is worth more than a lost one, and because the shape to suspect is
    client-side: the charge effect is a `Heartbeat` connection plus a `CollectionService` walk over every
    `NPC_TAG` model, which is the newest thing on the client that runs at boot.

**Found by the 2026-10-16 pass. None of them is a bug found in code; they are the consequences of the
region gate above, and none has been looked at in Studio.**

20. **On a desktop client the HUD's top row is now *deliberately* behind Roblox's chrome.** The gate gives
    a desktop client a `ScreenInsets.None` shared GUI (§9), so `COLUMN_TOP_INSET` = 14 measures from the
    true screen top while the topbar — which `CoreGuiController` deliberately leaves on — overlaps roughly
    the first 36 px. **No desktop element moved** (the create/find bug made the shared GUI `None` on every
    device already), so this is a decision rather than a regression; the two ways out are an offset
    measured from the safe region instead of from the screen, or a different `ScreenInsets` on a desktop.
    Which of those is wanted is the user's call.
21. **On a mobile client the whole HUD insets for the first time.** Until this pass the shared GUI was
    effectively `None` on every device, so the mobile HUD now moves down (and right) by the inset — 58 px
    down on the device this project's log measured — and its top row stops being drawn under the topbar.
    **This is the visible half of the change and it is unconfirmed**; the lines to read are the
    `[screenGui]` ones (§9) and `[Joystick] inset — …` for the measured size.
22. **`getStickScreenGui()`'s `None` on a desktop is dead code, on purpose.** Its only caller returns
    before mounting anything when `!isMobile()`, so no desktop client creates that GUI at all; it follows
    the gate so that "the GUIs placed as fractions of their region follow the device" stays one sentence.
    **The trap to know**: `TouchJoystickController.applyGeometry` derives the base's home from
    `GetGuiInset()`'s corners and then draws it from that GUI's own origin, so the two are in the same
    space only while the GUI insets — a future caller on a non-mobile client would put the ring one inset
    up and to the left of the corner its home is a fraction of. `platform.ts`'s "the platform does not
    change mid-session" is what makes that impossible today.
23. **The stamina retune is no longer an uncommitted diff; the stale comments beside it are still
    there.** `CHARACTER_CONFIG.STAMINA_MAX_SECONDS` is `6` and `STAMINA_DRAIN_PER_SECOND` is `0.5` (twice
    the pool, half the drain), which doubles the sprint's duration — committed as of 2026-10-19, where this
    item used to say the tree carried it. **What has not moved is the prose**: the doc blocks above those
    two constants still describe the old `3` / `1` pair, so read them against the numbers. Do not "fix"
    the values; the comments want their own line.

**Found by the 2026-10-17 persistence pass. None of these is a bug found in code — they are the
residue of that pass, and each is a decision left open rather than a mistake left in.**

24. **Nothing in §12b has been observed in Studio.** The session lock, the round-end write, the
    economy's failure line and the bounded shutdown are all *readings* — the code paths are there and
    the build is green, and the only two items that can actually be seen are the economy's
    `[Economy] write failed …` line (needs a failing store) and the two `— the round end` save lines
    (need one finished round). Everything else in the pass is unverified, and §16 has no new line.
25. **The economy still has no retry** — the stats service tries twice with a sleep and the economy
    tries once — and that asymmetry was deliberately left alone, because unifying it is a change to
    the economy rather than to persistence. **The missing `IsDescendantOf` load guard was closed
    incidentally**, and worth saying plainly because the task that found it was told not to fix it:
    `load` now returns if the player is gone by the time the claim answers, exactly as the stats
    service always has, because otherwise it would build a record for somebody who has left and
    publish to them. It is one line in a block that had to be rewritten anyway, not a separate change.
26. **Neither auto-save loop is jittered**, against the docs' explicit advice ("don't start recurring
    requests from every server on the same schedule"). Both sweep at `joinTime + n × 180`, and the
    round-end flush added in this pass puts a second population of writes on the round clock rather
    than the wall clock, which helps — but a fresh server still lands on the same phase as every other
    fresh server. A jitter needs a per-server seed and changes a constant a spec may read.
27. **No write happens on a purchase.** Opening a chest subtracts coins at `openChest` and buying a
    cosmetic at `purchaseCosmetic`, and neither touches the store — the spend lands on the next
    sweep, the next round end or the leaver's write. The platform lists *"purchase processing"* as a
    checkpoint, so this is the one place the economy is still short of the guidance; it is a design
    question of its own (a failed write on a player's click is the one failure that has to be answered
    *to the player*), and it is not persistence's.
28. **`BindToClose` ignores `Enum.CloseReason`.** A maintenance restart and a developer shutdown get
    the same twenty-second window. There is no case today where a different window would help — the
    note exists because the `CloseReason` argument is right there and unused, and because a `Restart`
    against a slow store is the case where knowing *why* we are shutting down would be worth having.

**Found by the 2026-10-19 throw pass. Item 29 is comments only; 30–32 are behaviour decisions left
open; 33 is the measurement that would settle the report all four came out of.**

29. **The throw's comments quote numbers the config stopped holding, and the config is right.**
    `THROW_MAX_SPEED` is `90` and `CHARGE_MIN_SPEED` is `50`, which is **29.8 → 53.9 studs** on level
    ground. The prose says otherwise in four places: `THROW_MAX_SPEED`'s own note still reads "336",
    `planChargedThrow`'s still prints a table of *"18.5 / 52.0 / 84.8 / 117.5 / 150.1"* and calls the
    full hold 150 studs, `CHARGE_PEAK_HEIGHT`'s still derives `v_y = 7.75`, a `0.77 s` hang and "about
    34 studs at a tap and 69 at a full hold" from a value that is now 0.9 (`v_y` 6, hang 0.6), and
    `peakAngle`'s still names "`CHARGE_MIN_SPEED` = 45" as the floor it is weighed against. **Nothing
    behaves wrongly** — every reader takes the config — but a reader who trusts the prose sizes the
    throw wrong by a factor of three. One pass, comments only.
30. **The shortest throw is ~30 studs, so the cursor cannot name a nearer target.** `reachTo`'s cap
    bottoms out at charge 0, and charge 0 *is* `CHARGE_MIN_SPEED`, which covers 29.8 studs. Point at a
    body 10 studs away with a full hold and the ball is fired 30 studs along that line — past it, by up
    to 24 studs. The guide draws the same overshoot, so the preview is honest; what the cap cannot do is
    the one thing a cap is for at close range. Lowering `CHARGE_MIN_SPEED` to ~20 would put the floor
    at 11 studs and leave the top of the hold untouched (`6/20 = 0.3` keeps `peakAngle` far from its
    45° clamp). A tuning decision, not a fix, which is why it is here rather than in the tree.
31. **`MIN_AIM_RANGE` discards exactly the aim a player makes at arm's length.** A point under 2 studs
    (flat) from the muzzle returns `undefined`, so the throw falls back to the **held charge and the
    camera's bearing** — a 1.00 hold becomes 54 studs past a body standing on top of the thrower. The
    capture that produced item 30 had `[Aim] arc: … at 1 studs` and `at 2 studs` immediately before two
    full-charge releases. Whether to keep the guard (the direction from the muzzle to a point at its own
    feet is centimetres of noise) or to clamp the direction instead is open. What is already established
    is that "full charge, target at arm's length" is currently the *worst* case rather than the best.
    **As of 2026-10-19 that worst case is escaped on a mobile client with a body in the aim assist's cone**:
    the pull moves the aim point out past the discard, so `reachTo` accepts it and the cap applies — which
    makes the sentence above true of desktop clients and of a mobile client with nothing eligible, and not
    of a mobile client being assisted. The guard itself is untouched; see §15 item 30 for the floor it
    leaves and `client/aimAssist.ts` for the pull.
32. **A throw that meets another ball is `carried on past it` in the code and deflected by the engine.**
    `BallComponent.handleTouch` decides a loose ball is scenery unless the throw already owes a tag — but
    balls are in the `Ball` group and `Ball` vs `Ball` is left at the engine's default, so a solid ball
    in the way *does* turn the throw. The log carries both halves: dozens of `— a ball, and this throw
    owes nobody — carried on past it`, and the two that ended on one (`#103`, `#383`). One row —
    `CollisionGroupSetCollidable(BALL_GROUP, BALL_GROUP, false)` — makes the stated rule true; the cost
    is balls sinking into each other where they pile on the floor. This is the closest thing in the code
    to "a collision knocked my throw off", so it is the first thing to try if a throw ever visibly turns.
33. **`VERBOSE_LOGS` is off, and with it every throw's commanded velocity.** The one line that can say
    whether a ball left with the speed the plan asked for —
    `[Ball] <name>: charged 1.00 … studs/s at … deg, release … -> launch … | muzzle … | boost … at N fps`
    — is behind `DEBUG_CONFIG.VERBOSE_LOGS`. In the 2026-10-19 capture it never ran, so "the ball did not
    move" and "the ball moved to the wrong place" are indistinguishable in that log. Note what is *not* a
    candidate, because the report suspected it: collision with the holder is already off at
    `BallService.throwBallBody` (`CollisionIgnore.between(ball, model)`, one constraint per part) and
    again by group in a practice zone (`Ball` vs `PracticePlayer`). One run with the flag on reads the
    launch directly.

**Found by the 2026-10-23 pass. Item 34 is a visual claim nobody has re-checked; 35 is a deliberate
divergence in one helper; 36 is a file that lost its last caller; 37 is the gap in the newest attribute
family.**

34. **The buttons are described as "transparent black" and that has only ever been *argued*, not
    measured.** The face is `PREMIUM.void` at `0.7`, with the bloom moved off the `UIShadow` so the glow
    cannot ink the interior (§10) — and the reason it was changed at all is that the user reported the
    buttons as *not* transparent once already, on the previous arrangement. **The next suspect is named
    rather than left to be found**: the cooldown ring's hole is an opaque `PREMIUM.void` disc behind the
    button, so a cooling button is backed and a ready one is not. That asymmetry is written down as
    intentional in `addCooldownOverlay`, and if it is the objection then the fix is the hole's alpha, not
    the face's. **One look answers it; nothing in this file can.**
35. **`applyGlow` has two bloom shapes now and they are not the same light.** The cluster passes
    `blur = false` and gets a `Border` `UIStroke`; every other caller (`DockController`, and anything
    that never passes the argument) still gets the `UIShadow`, whose blurred silhouette reaches further
    and softer. **The divergence is deliberate** — a shadow behind a see-through face *is* a fill — but it
    means "the theme's bloom" is two appearances on one screen, and a future caller that wants the soft
    one on a transparent surface will find out the hard way. The default is `true`, so nothing changes by
    silence. **Also unverified in-engine:** that a `UIShadow` inks a shape's interior at all is reasoning
    from what the class is, not a measurement — the cluster's own test is the one that settles it (if the
    rim bloom leaves the face see-through, the diagnosis was right). **And one comment now describes half
    the truth**: `ui/premiumTheme.ts`'s `stroke` doc still says the bloom "`ui/glow.ts` adds … as a
    `UIShadow`", which is right for every caller but the cluster — a one-line correction in a file this
    pass did not own.
36. **`ui/hudToast.ts` has no caller left, and one comment still promises it has one.** Its only
    consumer was `ThrowStateToastController`, which is gone (see §9's inventory note, corrected this
    pass), and `hitConfirm.ts`'s own note says the toast, its column slot and the two-second hold went
    with it. `mountToast` is exported and called by nothing; `ui/hudTheme.ts` still says *"`hudToast.mountToast`
    is the single call site"*. **A whole module and a comment that describes a subscriber** — the module
    either wants deleting or wants a caller, and that is a decision rather than a typo.
37. **A caught-throw death can still be captioned with the wrong killer, and the new attribute inherits
    the existing gap rather than closing it.** `enemyView.showEnemyView` reads
    `LAST_HIT_BY_CAUSE_ATTRIBUTE` **once and deliberately not live**, on the argument that the four
    writes are one server tick — but the *token* it resolves the body from can be a frame stale at a
    death, which `killCam` documents and this file cannot fix. So a catch that lands in the same frame as
    a real hit can show `caught your shot!` over the previous attacker's body. Nothing in the caption has
    been in a log either (§16); the two things to look at first are a catch death with a *stale* name and
    a header left hidden by a catch that was never restored.

---

## 16. What a live log has actually confirmed

Treat everything else as unverified. These were observed in the user's Studio output. Where the
system they were observed in has since been removed, that is said explicitly — a confirmation is
only worth anything about code that still exists.

**Nothing from the 2026-10-17 persistence pass appears below**, and that is the honest state of it:
no session lock has been claimed, no round-end save has been seen, and no failed economy write has
been printed in front of anyone. §12b says which lines would prove each one; §15 item 24 says which
two of them are reachable in a Studio session at all.

**Nothing from the 2026-10-23 pass appears below either, and it differs from persistence's in one way
worth recording: the cooldown ring was *seen working* — it was reported as correct once it was finally
drawn, which is the only confirmation that component has had — while not one of its log lines was ever
captured.** So `[HUD] cooldown started — …` / `… finished — …`, `[HUD] the cluster on this screen — …`
and every `[HUD] <label> tap — Npx of travel` line are unconfirmed as *output*, and everything the
cluster's face does (glass at `0.7`, the inverted press, the rim bloom) is a description of the code
rather than an observation. **A ring that appears is a fact about the drawing; the numbers behind it,
and what colour it sits next to, are still readings.** §15 items 34–37 are what that leaves open.

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
- `[Animate] prospeed1: jump` — the jump clip drawn from `animationFor`'s `!grounded` branch. **The rig
  half of the same rule is verified by reading, not by log**: `NpcService.publishAnimation` publishes
  `AnimGrounded` from `FloorMaterial`, and `RigAnimationController.conditionsOf` feeds the same
  `animationFor`, so both bodies cross the line in the same place.
- `[Dodge] Workspace.PlaceholderRig5: dodging — DodgeballBall at 24.5 studs` — a rig dodging, and the
  shape every per-rig line in this project has: the full name, the verdict, and the distance it was
  decided from.
- **The throw's gust, from one per throw rather than four or five.** `chargeEffect.ts` originally hung
  the gust off `AttributeChanged` and tested the mark's *value*, which stays `true` for the length of
  `THROW_ANIMATION_SECONDS` (0.4 s) — so one release fired the burst four or five times. The fix is a
  rising-edge record (`throwSeen`) seeded when the rig is first watched, and **the user's next log showed
  one gust per throw**. What that confirms is the *cadence*; the anchor has moved twice since (root →
  right foot → between the feet), so the placement is not what the log spoke to.
- `[VFX] no HitNeutral in ReplicatedStorage — that hit effect will not play` — a confirmation by
  *absence*, and the reason item 14 exists.
- **The spawn poof, at both ends of a round, and the user's own verdict on it was "this looked good".**
  `[VFX] SpawnPoof at <name> — x, y, z (1 part(s), 1 emitter(s), texture rbxassetid://…, 2.00s)` fires
  once per body at the round-end teleport, and the effect was seen. **That is the confirmation for the
  delivery described in §10**: the burst is the emitter's `Rate` raised for a window, not an `Emit`, and
  a clone left at the template's own `Rate = 3` had drawn nothing at all.
- `[Ball] <name>: flight owned by the server` on every player throw in the 2026-10-19 capture, on frame
  one and with no `(took N frames)` — so `ball.SetNetworkOwner()` at the release does hand the flight to
  the server's solver, which is the half of the launch a client-owned assembly could otherwise drag back
  to the hand.
- `[Aim] arc: <part> at N studs -> <model>` printing **on change rather than per frame** while a charge
  is held, and `[Aim] <model>: lit=true` / `out=true` following it — the target glow and the drawn arc
  agree about what the throw is aimed at, which is the point of both being computed in `updateGuide`.
- `[VFX] FreezeSplash spawned at … with size 16 (radius 8, scale 16.00, 1 part(s))` beside the ball's
  own `ended on … [Freeze]` line — the splash's proportional scaling (§10) reading as a 16-stud
  diameter for an 8-stud radius, from a template authored at one stud of radial extent.

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

## 17. The rigs' walk, the charge, and the body effects

Added 2026-10-14. Everything in it was read from the source in this pass; nothing in it has been seen
in a live log unless it says so.

### Where a rig's movement lives, and the order of the gates

**`npc/behaviors/SeekBehavior.ts` is the only behaviour that moves a rig**, and `MoveTo` is the whole of
the movement — no `PathfindingService`, deliberately, so the walk is only ever as good as the floor it
stands on. It is **one factory** (`createSeekBehavior(speeds, pickups, balls, tag, region)`) called twice:
`createRoundSeekBehavior` (tag `Behavior_Seeking`, region = the rig's own half) at the bottom of that
file, and `createAlwaysSeekBehavior` (`Behavior_AlwaysSeeking`, region = `practiceZone`) in
`AlwaysSeekingBehavior.ts`. Everything else — the candidate list, the region test, the claim, the stall
budget, the give-up record, the arc, the sprint and the hop — is shared, which is why the two cannot
drift apart.

`tick` runs its gates in this order, and **the order is the design**: a ball in hand → `pickupWalk`
(does not stop, see below); the loose-ball list; the ball it was walking to is no longer loose → `stand`;
nothing choosable → return; the claim (`claim(model, ball)`, renewed every turn); arrival inside
`BALL_CONFIG.PICKUP_RADIUS` (8) → return **without standing** (the rig keeps the claim, it is about to
take the ball); the best-distance/stall counter, where `SEEK_STALL_TICKS` (3) turns mean give up and
`stand`; then the sprint decision, the bluff, `MoveTo`, and the hop.

**Two invariants a change here must not break.** The arrival check and the stall budget both measure the
distance to the **ball**, never to the offset point the walk is aimed at — that is what lets the arc
exist at all. And `stand` is the *only* stop: `MoveTo(root.Position)` is the engine's way of saying
"stay here", so a new way to end a walk has to come through `stand` or `endWalk` rather than inventing a
second mechanism.

### The five movements, and what each one is for

| What | Config (all Placeholder) | The rule in one line |
|---|---|---|
| **Sprint** | `SEEK_SPRINT_DISTANCE_STUDS` 30 | `distance > 30` → a `Sprint` contribution, re-read every turn so the rig is already walking as it arrives. No pool. |
| **Arc** | `SEEK_CURVE_AMPLITUDE_DEGREES` 4, `SEEK_CURVE_PERIOD_MIN/MAX_SECONDS` 1.4/2.6 | The walk aims at a point offset **perpendicular** to the line to the ball, by `tan(4°) × distance × sin(2πt/T + φ)`. Amplitude as an **angle** so the detour shrinks as the rig arrives — 3.3 studs at 47, a third of a stud at 8. Period and phase drawn per walk. |
| **Hop** | `SEEK_JUMP_ENEMY_RADIUS_STUDS` 16, `SEEK_JUMP_COOLDOWN_SECONDS` 2 | `Humanoid.Jump = true` on a turn the rig is walking, when an enemy is within 16 studs. Gated on grounded (`FloorMaterial !== Air`, the same read `publishAnimation` publishes), on no `PlatformStand` (a dash swallows the jump and spends the cooldown), and on no published `CHARGING_ATTRIBUTE`. **The flag is cleared by `NpcService.publishAnimationBody` on the first turn the rig is back on the floor, and that clear is load-bearing**: `Humanoid.Jump` is a level, not a request, so a rig left holding it bounces on every landing — that was the 2026-10-21 *"a rig repeatably jumping"* report, and the cooldown was innocent of it |
| **Bluff** | `PANIC_ENEMY_RADIUS_STUDS` 30, `PANIC_SHUFFLE_CHANCE` 0.20, `PANIC_SHUFFLE_SECONDS` 1, `PANIC_SIDESTEP_STUDS` 8 | One sidestep out of the line for 1 s, when the *walk* drew the 20 % roll **and** an enemy within 30 studs **has a ball in hand**. Rolled once per walk and spent on first use. **A bluff, not a dodge**: no `DodgeService`, no invulnerability, the ball still hits. Gated on no `DODGE_DIRECTION_ATTRIBUTE`. |
| **Pickup walk** | `PICKUP_WALK_STUDS` 8, `PICKUP_WALK_SECONDS` 0.75, `PICKUP_BACKPEDAL_CHANCE` 0.4 | **A rig no longer stops dead when the ball arrives.** The walk carries on 8 studs — onwards, or on a 40 % draw *backwards away from the enemy* — and ends when the window expires or a windup begins. |

**Three cross-subsystem reads make these work, and all three are reads rather than calls:**
`CHARGING_ATTRIBUTE` is "the throw has planted" (a hold ends the pickup walk so a moving body cannot
make a charge land short); `DODGE_DIRECTION_ATTRIBUTE` is "a dash has the body" (`DodgeService` sets it
for the length of a dash and clears it at the end — `WalkSpeedService` reads it as its own gate, and the
seek's bluff reads it as its own); and `detectEnemy` is silent outside a playing round, which is why a
lobby rig never hops and a practice rig never shuffles.

**The backpedal is the one movement that depends on something in another file.** `ThrowBehavior.aimAt`
switches `Humanoid.AutoRotate = false` and holds the rig's *facing* on its target with an
`AlignOrientation` — its own doc already argues that this "leaves the walk controller alone and takes
only the facing". That is what lets the legs go one way and the eyes stay on the enemy. **Nothing in
`ThrowBehavior` was changed to make the walk work**, and a change there that takes the aim constraint
away would take the backpedal with it.

### A rig has a speed sum now

`WalkSpeedService` is still one owner and one sum, and a rig's speed is now two of its named
contributions rather than a direct write: `Base` (16, set by the seek's own `prepare` from
`NPC_CONFIG.WALK_TO_PAD_SPEED`) and `Sprint` (+15, `CHARACTER_CONFIG.SPRINT_SPEED_BONUS` — the player's
own number, because `RUN_ANIMATION_SPEED` is the line both bodies' run clip is chosen at and a second
number could disagree with it).

**The trap that made the `prepare` necessary, and it is not obvious from the service's API:** the first
thing to give a model a contribution **creates that model's entry, and an entry is created with
`CHARACTER_CONFIG.BASE_WALK_SPEED` (20)**. So a rig that only ever added `Sprint` would have silently
walked at 20 instead of 16 — a change attributed to nothing. `setBaseSpeed` is the call that avoids it,
and the same `prepare` is why the pad walk's own `WalkSpeed` write and the seek's sum cannot be allowed
to run on one rig (no rig wears both tags; both files say so).

**And a watchdog, because a behaviour has no `onStopped`.** `LobbyRigService.setGameplayBehaviors`
takes the six gameplay tags off every rig at a round boundary, so a rig whose `Behavior_Seeking` comes
off mid-run would never tick again and would keep `+15` for the rest of the session. The fix is the one
`ThrowBehavior`'s windup already uses for the same class of bug: a token-guarded timer that can only
*undo*, re-armed on every turn of the sprint, so it cannot fire during a walk and only ever catches a rig
that nothing is turning any more.

### The body effects, which are client-side modules rather than controllers

`hitVfx.ts`, `hitConfirm.ts`, `catchShockwave.ts`, `chargeEffect.ts` and `windBurst.ts` are **plain
modules started by hand** from `main.client.ts`, because Flamework loads `client/controllers` and nothing
else. Each is a subscriber to a fact the server already publishes, and each owns one effect:

- **`chargeEffect.ts`** — the visible charge, and it has three drivers in one module because the two
  bodies report differently: a `Heartbeat` loop over the local player's own `chargeStartedAt` (a
  *threshold crossing is not an edge*, so a frame loop rather than an observer), the local body's throw
  marks, and every `NPC_TAG`-tagged rig's `CHARGING_ATTRIBUTE`/`AnimThrow`. **The gust hangs off the rising
  edge of `AnimThrow`** — `AttributeChanged` fires on every write and the mark stays set for the clip, so
  a value test fired four or five times per throw — and it is gated on the same 0.9 the fire ball is.
- **`windBurst.ts`** — the gust at the thrower's feet: a Studio-authored template found **by name** in
  `ReplicatedStorage`, welded to the body, `Emit(30)` per emitter. It is placed **between the feet, at
  ground level**, and held by the root: a `WeldConstraint` holds an *offset*, so the part that holds it
  has to be the one that does not move relative to the body, while the *position* comes from the feet.
  `Emit` is the correct call here and the wrong one on the server — see §10's tombstone. The line it
  prints names the parts, so "which part did it weld to" is a fact in the log rather than an inference.
- **The contract with a template is its name and nothing else.** Nothing may depend on where in
  `ReplicatedStorage` it sits or what it is wrapped in; a missing template warns once per name and lists
  what the client *can* see, and every silent exit prints a line.

### What a fresh session should not assume

- **`SeekBehavior`'s `MoveTo` is issued on every turn now**, and that reversed the constant's own doc:
  the walk used to re-aim only when the ball had moved `SEEK_BALL_MOVED_STUDS` (4), which a curving walk
  would have frozen at the first turn's offset. That constant keeps one reader (`prune`).
- **The seek's arc is sampled at the retarget interval** (0.5 s). At a 1.8 s period the shape is drawn
  from three or four points and the humanoid's own steering smooths the corners — so shortening the
  period is a change to how the arc is *sampled*, not only to how it looks.
- **`AlwaysSeekingBehavior.ts` is not in the seek's file list for a task but has to change with it**,
  because it is the second caller of the factory.

---

## 18. The MicroProfiler scopes, and what has *not* been measured

**Nothing in this section is a finding. It is the instrument.** The lag complaint that opened this work
("it never did before, so Studio is not the problem") was answered on 2026-10-17 with arithmetic rather
than a recording, because a MicroProfiler run is a thing a person does on their own machine, not something
a session can do for them. So the cost of the per-rig game loop is **still unknown**, and the decision
that follows from it — which of the candidates to actually make cheaper — is **still open**. What changed
is that the next recording will name it.

- **One flag, off in the tree.** `DEBUG_CONFIG.PROFILE` (`shared/config/debug.config.ts`), `false`. Every
  site is `if (DEBUG_CONFIG.PROFILE) debug.profilebegin(...)` / `debug.profileend()`; when it is off each
  costs a table read and a branch, and nothing else. With it on, a recording is a *diagnostic* frame cost —
  the labels are real work — so a recording's numbers must never be compared to the game's own.
- **The scopes, and what each is asking.** `Npc.turn` (one rig's turn: gate-passed, yield-excluded) and
  `Npc.publishAnimation` are the per-rig pair; `Npc.tick.<Behaviour>` is one band per behaviour
  (`Catching`, `Throwing`, `Seeking`, `Pickup`, `Dodging`, `Respawn`, `WalkToJoinPad`) so the recording
  says *which* per-rig mechanic is wide rather than "the NPC tick"; `Npc.detect.enemy` digs into the one
  call that walks `CollectionService.GetTagged(NPC_TAG)` per rig per turn, which is the only O(rigs²)
  shape in the server; `Npc.Respawn.clone` / `Npc.Respawn.onDied` split a respawn's one expensive statement
  from the writes around it; `BallSpawner.tick` (once a second, walks every spawner part), `BallService.attach`
  (four routes into a hand, per rig per turn) and `BallService.throw` (the release); `LobbyRig.rebalance`
  (seat arithmetic, spawning included — that is the question being asked); `Outline.paint` (a respawn can
  repeat it in one frame); `Collision.applyBarrierGroups` (a handful of times a round, so if it is ever
  wide it is doing something wrong).
- **Two rules every site obeys, and a reviewer should check rather than trust.** *No scope spans a yield* —
  that is why `Npc.turn` closes before `task.wait(period)` and why `Npc.Respawn.onDied` opens *after* the
  respawn delay. And *no scope has an early `return` between its pair* — where the natural region had one,
  the body was split into a `…Body` method behind a one-statement wrapper (`detectEnemyBody`,
  `tickBody`, `rebalanceBody`, `attachToHandBody`, `throwBallBody`, `paintBody`, `applyBarrierGroupsBody`,
  `publishAnimationBody`), so the pairing is structural instead of remembered. **No `try`/`finally`
  anywhere**: roblox-ts compiles one to an `xpcall`, which would change both the cost being measured and
  how an error unwinds.
- **How to record.** Flip `PROFILE` to `true`, publish, run: (A) a round in progress, 10 s of recording —
  that is steady state; (B) a recording started ~2 s before a rig death *and* a round boundary — that is
  the event path. **`MicroProfiler` on the server view only**: a client recording says nothing about a
  server stall. Bring back the same recording twice — once as the HTML dump, once as the server's
  `Steps Per Sec` — because the dump says *where* and the step rate says *whether it matters*.
- **What is left to look at if none of it is wide.** Instance count across a full round (the leak check),
  and the two things this pass deliberately did not instrument: the `BallService` settle loop and
  `ThrowProbe` — the latter because it is off with `VERBOSE_LOGS` and the former because it is the one
  loop already known to be periodic.

---

## Appendix — the other documents, and how far to trust them

| Document | What it is | State |
|---|---|---|
| `HANDOFF.md` | this file | current as of **2026-10-23**, against `f062372` plus six uncommitted files from the same day (the mobile cluster's glass face and rim glow, the cooldown ring, the caught-throw caption, the round's admission strip, the loading screen's title). That pass brought **§4, §9, §10, §15 and §16** in step: §4's map lost two deleted controllers and gained `MobileControls`, `ui/glow.ts` and `client/enemyView.ts`; §9's inventory table was corrected the same way; §10 gained two stories and a completed list; §15 items 34–37 and §16 a note saying it confirmed nothing. **§5–§8, §11–§14, §17 and §18 stand as their own revisions left them** — §11's power-slot paragraph in particular predates the 2026-10-19 shuffle (`f699436`) and should be read against the code before it is trusted |
| `TAGS.md` | the register of every `CollectionService` tag (its table *is* the count), with why the strings cannot be imported from each other | current as of **2026-10-23**, which added one row to its "not tags, but the same trap" table: `"Hit"` / `"Catch"`, the two values of `LAST_HIT_BY_CAUSE_ATTRIBUTE` and the only pair on that list whose disagreement is a wrong *sentence* rather than a wrong lookup. Its "why there are copies" section is the thing to read before touching the `Ball` tag |
| `SHOP-PANEL-BRIEFING.md` | a briefing for a visual-capable model debugging the shop panel rendering almost empty, with exact colours and the layout tree | **a record, not a description.** It documents the retired mock (five tabs, a box picture with odds); the panel was rewritten onto the economy and `ui/panelChrome.ts`, and a caveat banner at the top now says so. Kept because **§7's arithmetic still holds** (the panel really does collapse below ~700 px of viewport height) and §8's ruled-out list is still worth not re-treading. §5 and §6 were corrected on 2026-10-16 for the shared GUI's region, which is a *device* decision now (§9) |
| `README.md` | upstream roblox-ts boilerplate — its entire content is the line `First commit` | says nothing about this project; ignore it |
| `tools/pattern/` | the Node renderer and PNG output used to design the ring pattern (`shared/ringPattern.ts`) | one-off design tooling, not part of the build |
