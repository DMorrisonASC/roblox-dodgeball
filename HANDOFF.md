# Handoff — roblox-dodgeball

A guide for a fresh session. Written 2026-09-28 against a green build (`npm run build` → exit 0);
**brought up to date 2026-10-23** against `f062372` **plus six uncommitted files from the same day** —
`controllers/hud/MobileControlsController.ts`, `ui/glow.ts`, `client/enemyView.ts`,
`services/round/RoundService.ts` and `shared/constants.ts` (§9, §10, §15) — and **§15 items 96–100 are later than
that**, covering the celebration hold, two deleted modules and the mystery box's look. Earlier revisions: 2026-10-19
at `efcbc37` plus the readout column moved to
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
  services/stats/MatchStatsService.ts  **the in-match stats board's server half, and it counts nothing** —
                                 it reads `BadgeService.tally()` (throws, hits, catches, dodges already
                                 increment at their own call sites), takes **every body on a side — players
                                 from `Players.GetPlayers()` and rigs from `rigsOnASide()`**, applies
                                 `MATCH_STATS_CONFIG` through `shared/matchStats.pointsOf`, and answers the
                                 `matchStats` function. §15 item 45
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
                                 been split), and npc/arenaSpawns.ts (one of a side's arena spawns,
                                 lifted to a rig's root — the lookup `RespawnBehavior` needs and
                                 cannot ask the round for; §15 item 50). `behaviors/WalkToJoinPadBehavior.ts` is the walk to a
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
  perfectDodge.ts                `startPerfectDodge()` — the `Perfect` caption, one row under `HIT!`, drawn
                                 when the server reports a ball that passed within a ball's width of where
                                 this player was standing when they dodged — and **the one clip that goes with
                                 it**, a single `Sound` in `SoundService` made at boot, preloaded, and
                                 restarted on each caption. Another plain module started
                                 from `main.client.ts`; one event in, one splash and one sound out, and the
                                 measurement is entirely `DodgeService`'s (§15 item 38)
  celebration.ts                 `startCelebration()` — the `VICTORY` / `DEFEAT` / `DRAW` word, centred, shown
                                 for the length of `ARENA_CONFIG.CELEBRATION_SECONDS` and hidden when it ends.
                                 **The only plain client module that draws on a *phase* rather than on an event
                                 or a body**: it reads `CELEBRATING_ATTRIBUTE` for when, `ROUND_WINNER_ATTRIBUTE`
                                 for what, and the local player's `TEAM_ATTRIBUTE` for whether that is good news.
                                 Styled by `ui/actionSplash.ts`'s `styleSplashText`, so it looks like the `HIT!`
                                 splash rather than like a second look (§15 item 100)
  ui/                            screenGui.ts (every `ScreenGui` in the client and the written rule for
                                 which one a thing belongs in — HudGui, FullScreenGui,
                                 TransitionGui, ScreenSpaceGui, StickGui, **plus `getHudColumn()`**, the
                                 one frame the score plate and the clock share; **see §9 before moving
                                 anything visual**), hudTheme.ts, viewportConstraint.ts,
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
  controllers/hud/               RoundStatus, RoundTransition,
                                 RespawnHud, CurrencyHud, SuperHud, StatsBillboard, ScoreHud,
                                 ControlsLegend, MobileControls (the six-button cluster — packed by
                                 `pack()`, glass face, a cooldown ring per control with a clock; §9,
                                 §10), ModeVote, ArenaFreezeCountdown, Dock, Shop, Inventory, Theme,
                                 **MatchStats** (hold `Tab`: a `lightPanelTheme` panel of rows grouped by
                                 side and ranked by points, rebuilt into its list on every open; §15
                                 item 43).
                                 **`CooldownHud` and `ThrowStateToast` stood in this list and are
                                 deleted** — nothing in `src/` names either any more, and the second
                                 one took `ui/hudToast.ts`'s only caller with it (§9, §15 items 36
                                 and 97 — the toast module itself has since been deleted too)
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

1. `const playedThisRound = this.playersInRound()` — **the roster is read here because the next line
   throws it away**, and it is the one list the end-of-round boundary both covers and moves. It is
   deliberately *not* `this.teams`: `surrender` keeps a surrendered player on their side (the outcome
   depends on it, §11), and that player is already standing in the lobby. Anything that needs "who was
   just playing" must use this value rather than re-deriving it after the clear.
2. `state = Intermission`, `activePlayers.clear()` — **after this point the round roster is gone**.
3. Print, then publish `ROUND_STATE_ATTRIBUTE = "Intermission"` and `ROUND_TIME_ATTRIBUTE` at the
   **full** `ARENA_CONFIG.INTERMISSION_SECONDS` (16) — published *before* anything that can hold,
   so a held intermission cannot read as a frozen round.
4. `await this.waitForLobby()` — holds indefinitely if the arena has no `LobbySpawns` parts, and
   prints once on the way into the wait and once on the way out.
5. `await this.transitionAround(playedThisRound, (roster) => { teleportAll(roster, lobby);
   returnRigsToLobby(); }, { wipe: WIPE_AT_ROUND_END })` — **one list, handed to both halves.**
   `transitionAround` no longer derives a cover list of its own: it bumps
   `ROUND_TRANSITION_ATTRIBUTE` on the roster it is given and passes that same roster into the move,
   so "who sees the grid" and "who is moved behind it" cannot disagree. The two faults this closed
   were a spectator moved with no grid and a surrendered player given a grid over a move that no
   longer included them (`teleportAll` used to walk `Players.GetPlayers()`; the cover was `this.teams`,
   which keeps surrenders on purpose).
6. `this.clearEndedRoundHeldBalls()` — strips held balls from all players + rigs in `Workspace`.
7. `this.matches.clear()` — the roster is forgotten, so everybody picks a side again.
8. Per player: `this.abilities.clearMultiBall(player)` and `this.respawns.cancel(player, true)`.
9. `this.freezes.unfreezeAll()`.
10. **No map swap.** The arena is permanent; nothing is cloned, placed or destroyed (§6).
11. Seed `elapsed = 0`, `settledFor = 0`, `roster = this.matches.rosterRevision()`.

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
   exists because of the `async` footgun in §3: `requiredTeamSpawns` raises when a side's spawn
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
| `HudGui` — `getHudScreenGui()` | **gated**: safe on mobile, screen origin on desktop | every HUD panel, `client/notifications.ts`, the shop and inventory panels |
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
| `RespawnHudController` | **two lines** above centre (`0.44` down): the tenths countdown as `h4` seconds + dimmer `subtitle1` tenths, and beneath it `Hit by <name>` — the splash's own styling (`ui/actionSplash.ts`) rather than a copy of it | `RESPAWN_AT_ATTRIBUTE`, `LAST_HIT_BY_ATTRIBUTE` |
| `CurrencyHudController` | `Coins: N`, under the shop button | `COINS_ATTRIBUTE` |
| `SuperHudController` | streak / charge / armed ability / MultiBall window | the four `SUPER_*` attributes + the held ball's mark |
| `StatsBillboardController` | **the round's badges above every head** — a white card with a padding, holding a name and a one-line description per badge in black, `14`/`11`. **The hits/outs record is gone** (deleted 2026-10-27, §15 item 112): those figures are the kill cam's card's, and two copies were one too many | `BADGES_ATTRIBUTE` |
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

**`ui/hudToast.ts` itself is gone as of 2026-10-26 (§15 item 97), and it is worth being clear that it was
never the notification HUD.** It built a big-ui `Alert` into a bottom-centre column, and after item 36 took
its last consumer it had a live competitor and no callers: `client/notifications.ts`, a plain module whose
`pushNotification(text, holdSeconds?)` draws the HUD's one-line messages and is what the AFK prompt, the
camera unlock, the return-to-lobby card and the round's reward all use. Delivered as dead code it would have
been a second toast system beside the working one; deleted, the two numbers it owned — the column's offset
and the toast height — are nobody's, and `notifications.ts` owns the stack's.

Two shared pieces worth knowing about: `ui/actionSplash.ts` (the `HIT!` look and its one pop — **the style
and the animation are separate calls on purpose**, see below) and the small module-scoped Fusion values
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
Cause: the team-spawn lookup (then `getRandomTeamSpawn`, now `requiredTeamSpawns`) called `error()` inside
`gameLoop`, which is `async` → the throw rejected a promise nobody handled → **the loop stopped permanently**.
The throw fired *before*
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
- **MultiBall is player-carried** — a window on the player (it has no duration any more), and nothing
  about a thrown ball carries *the power*; a window's spent throws carry a cleanup marker, which is not
  an ability. That is why `isBallAbility` exists as a *narrower* test than `isAbilityKind`: without
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
(`BallService.refillFromBuff`), and **the ball already in hand when the window opens is one of the
five, not a sixth**: every throw spends a throw from the window whichever ball it is, so a window is
five balls thrown and four refills supplied. The window is a **stock rather than a burst** now, and the
cost of that is written out in `super.config.ts`. Closed by spending the last throw, by death, by the
intermission and by the round end. **Four of the five spent balls are destroyed once they are on the floor** (item
116): `BallService.throwBallBody` marks the ball with `BALL_DESPAWN_ON_LAND_ATTRIBUTE` while the window still has a
throw in it, and `BallService.settleLooseBalls` destroys a marked ball that is disarmed and `isOnGround`, with the
spawn poof. The last throw — the one that closed the window — survives, and the marker is re-decided on every
throw, so a caught ball thrown again is ordinary unless its new thrower's window is open.

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
respawn costs nothing. **Nothing draws it since 2026-10-27** — the per-head billboard that did was stripped
back to badges only (`HANDOFF.md` §15 item 112); `CROWN_ATTRIBUTE` is read by `EconomyService.checkMilestones`
and by nothing on the client.

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
      `getHudScreenGui()` — §9. **And as of 2026-10-26 it is twelve**, `ui/hudToast.ts` having been
      deleted — §15 item 97 — with `client/notifications.ts` its live replacement.)*
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

    **Settled on 2026-10-26: deleted, and the caller it was offered was the wrong one.** Item 96 briefly
    proposed reviving it for the round's reward toast — that would have made it a second toast system beside
    the working `client/notifications.ts`, and the toast went to `pushNotification` instead. With no `Alert`
    left in the game the module had nothing to build for, so it went with its geometry; see item 97.
37. **A caught-throw death can still be captioned with the wrong killer, and the new attribute inherits
    the existing gap rather than closing it.** `enemyView.showEnemyView` reads
    `LAST_HIT_BY_CAUSE_ATTRIBUTE` **once and deliberately not live**, on the argument that the four
    writes are one server tick — but the *token* it resolves the body from can be a frame stale at a
    death, which `killCam` documents and this file cannot fix. So a catch that lands in the same frame as
    a real hit can show `caught your shot!` over the previous attacker's body. Nothing in the caption has
    been in a log either (§16); the two things to look at first are a catch death with a *stale* name and
    a header left hidden by a catch that was never restored.

**Found by the 2026-10-23 perfect-dodge pass, and corrected by the same day's second pass. Item 38 is what
the fix was; 39 is the one number in it that is a guess; 40 is the gap the fix deliberately leaves.**

38. **The measurement fired on a body that had already been hit, and the fault was the *clock* rather than the
    tolerance.** The 20:14–20:15 log's player report was `prospeed1 … perfect dodge — the ball missed by 3.3
    studs`, and the line above it in the same log is `20:15:30.512 prospeed1 was tagged by DodgeballBall on
    UpperTorso` — **281 ms earlier**. The watch opened when the dash started, which was *after* the tag, so it
    measured a ball leaving a body it had already struck and reported the leaving as a dodge. **The first pass's
    diagnosis ("a one-frame false positive, ~20 ms") was wrong, and wrong in the direction that matters: it
    turned a systematic fault into an edge case and then documented it instead of fixing it.** Two things were
    wrong and both are now fixed, in `DodgeService.watchForPerfectDodge`:
    - **The body's own hit state is now read**, not inferred from geometry. `BallComponent` publishes the bodies
      a throw has tagged (`BALL_TAGGED_BODIES_ATTRIBUTE`, written beside the tagged-team attribute at the same
      four moments), and the watch ends the first frame that list contains this body. A tag is the exact record
      of a contact and it survives the ball flying on, which a radius around the root cannot do.
    - **A dead body ends the watch**, checked every tick and once more where a miss is settled at the window's
      end. A tagged body is not killed at the tag — the tags resolve when the ball lands, up to a second later —
      so the tag list catches the 281 ms case and the health check catches every other death mid-dash.
    **`BODY_CONTACT_RADIUS` is deleted rather than widened.** It was a root-centred sphere standing in for "was
    this body hit"; it missed the chest, head and arms, and it could not see a contact that happened before the
    watch opened. `GetBoundingBox()` was considered and refused for a reason worth keeping: **a held ball is a
    child of the character**, so the model's own box includes it and would reach about three studs out on the
    hand's side — past `PERFECT_DISTANCE` — silently swallowing every dodge made while carrying a ball. The
    radius that survives is `PREDICTED_HIT_RADIUS`, used only by `stillOnCourse`, which asks a question about
    the *future* and so cannot be answered by a tag. **The fix is simulated rather than observed**: the tag gate
    cancels at t=0 on the log's own scenario, a death at 0.10 s cancels, and clean dodges at 0.5 and 3.0 studs
    still report while a 5-stud pass stays silent. **The caption remains unconfirmed** — switch
    `client/perfectDodge.ts`'s `DEBUG` on for one session to print `[HUD] perfect dodge up …` at boot and
    `[HUD] splash — Perfect` per caption. **Still unjudged**: whether `PERFECT_DISTANCE` = 4 fires on the dodges
    a player thinks they earned, whether an `h6` word reads under the 150-pixel `HIT!`, and — added with the
    sound — whether `AUDIO_CONFIG.PERFECT_DODGE_VOLUME` (0.6) sits right beside `HIT!` and the personal cues,
    and whether the supplied clip is short enough for a caption that is gone in under a second. **The sound is
    client-side on purpose**: it plays on the same frame the word pops, so it cannot lag the animation the way
    a server-played `SoundEmitter` clip would. The line to check if it is silent is
    `[Audio] perfect dodge sound did not load — <id> (<status>)`, which is the only way a wrong id announces
    itself.
39. **`PERFECT_WINDOW_SECONDS` is the one number in the feature that is a feel rather than an arithmetic.**
    0.6 s is three dashes, chosen because the ball a dash saves you from usually arrives *after* the dash
    ends. Given this game's throw envelope, every charge hangs for the same `2·sqrt(2·g·h)/g` — about 0.28 s
    with `BALL_GRAVITY` 50 and `CHARGE_PEAK_HEIGHT` 0.5 — so in practice the window is bounded by the ball's
    own landing rather than by this constant. **The 2026-10-23 log supports that reading and cannot prove
    it**: the confirmed dodges all arrived well inside the window, and none of them produced a line for a ball
    that had already stopped — but the window was never the thing that ended a watch, so nothing in the output
    distinguishes 0.6 from 0.3. It is the number to cut if a caption ever fires for a ball that had clearly
    stopped being one.
40. **A contact that writes no tag is invisible to the perfect dodge, and three kinds of contact write none.** A
    same-side ball is vetoed at `BallComponent.handleTouch` before any tag exists, a ball into a
    practice-zone player is not a body to a ball at all, and **an own throw returns from the self-catch branch
    before the tag** — so in all three cases a pass close enough to count is counted, and a teammate's throw, or
    your own coming back off somebody, can raise `Perfect`. **This is not a regression from the
    radius**: that test only reached 2.5 studs, so the same pass at 3.5 fired before the fix too. Making it
    exact is a *side comparison*, not a geometry change — the dodger's `TEAM_ATTRIBUTE` against the thrower's —
    and the thrower's side was not on the ball then. **`RoundService` cannot be injected to get it**:
    `RoundService` reaches `DodgeService` through `NpcService`, so the dependency would be a cycle and Flamework
    refuses those at ignite. The route was to publish the thrower's side on the ball beside `ThrowerId`, which is
    the throw path's state rather than this feature's, so it is left as a decision. **Closed by item 115**, which
    took that route and added the own-throw filter beside it; the one case still open is a drill's ball at a
    practice-zone player.

**Found by the 2026-10-23 rig-miss pass, which was asked a question rather than given a bug. Both items are
tuning decisions the code cannot settle, and both comments were corrected to describe the shipped values.**

41. **A rig is deliberately wide nine throws in ten, and that is the value rather than the prose's.** The block
    above `THROW_MISS_CHANCE` used to say **"one throw in two"** and argue that "a rate leaves *the other half*
    of the throws exactly as accurate" — the constant has been **`0.9`**, so one throw in ten is honest. The
    comment has been rewritten to the value (it described a character the game does not have: "capable, and
    occasionally wrong" against a rig that is wrong nine times out of ten), and **the number itself was left
    alone on the user's instruction**, because a 2026-10-23 log shows rigs `missed on purpose` on nearly every
    throw and that is what the game actually feels like. **Whether nine in ten is the wanted balance is open**:
    `0.5` is the figure the original prose described, `0` is fully accurate, and the constant is the only dial
    either way. Nothing else reads it — `rollMiss` is the sole caller.
42. **The miss *width* is a flat band, and the comment used to describe a ladder.** `THROW_MISS_STUDS_MAX`'s
    block claimed "spread across five to ten, **most misses are small and a full-width one is occasional**";
    `rollMiss` draws `MIN + math.random() * (MAX - MIN)`, so every width in the band is equally likely — and the
    band is **7–10**, not 5–10 (the `_MIN` block's own "Placeholder — 5" was two revisions stale as well). Both
    comments now state the flat band and the real floor. **A weighted band was considered and refused**: the
    range already varies throw to throw, which is the property that stops a tell, and weighting it would change
    how the rigs feel without anything in a log to say it improved. If a session ever reads the wide throws as
    too uniform, this is the place to add weight — not `THROW_MISS_CHANCE`. **One decision per throw is
    unchanged and now stated where it is enforced**: `rollMiss` is called once from
    `createWindupTracker.beginWindup`, the release re-applies the stored offset rather than drawing again, and a
    per-tick or per-second roll is a body changing its mind during its own hold.

**Found by the 2026-10-23 stats-board pass. Item 43 is a feature nobody has opened; 44 is the reason it needed
almost no server code; 45 is what it cannot show.**

43. **The stats board has not been seen in Studio, and three things about it are only answerable there.** Hold
    `Tab` for a `lightPanelTheme` panel — rows grouped by side, ranked by points — built from
    `BadgeService`'s per-round ledger through `MatchStatsService` and the `matchStats` function. **The geometry
    is the open question**: six fraction-width columns (`COLUMNS` in `MatchStatsController`) on a panel that is
    the shop's `0.62 × 0.72`, a 26-pixel row, and whether a long player name reads better truncated than
    scaled. Nothing in this file can answer any of it. **The empty state and the one-ping delay are also
    unobserved**: the first hold of a session draws no rows until the function answers, and a player off a side
    sees `no one is on a side yet`. The lines to read are `[Stats] board up — hold Tab to read the round` at
    boot and, with that file's `DEBUG` on, `[Stats] board answered — N row(s)`.
44. **The data already existed; the board added one read and no counters.** `BadgeService` has kept a
    per-body tally of `throws`, `hits`, `catches` and `dodges` since the badge work, incremented at exactly the
    four call sites where each fact becomes true (`BallService.throwBall` only when a ball left,
    `BallComponent`'s catch branch only on a real catch, `DodgeService.requestDodge` past every gate,
    `RoundService.registerHit` inside the round gate). **So the prompt's premise — "the round stats are
    scattered across different services with no single source of truth" — was false**, and building a second
    tally would have been a second chance to miss a call site. What was added is `BadgeService.tally()`
    (read-only) plus the formula. **The cost is a naming debt that is now written down**: a service named for
    the ribbons owns the ledger a scoreboard reads. If a third non-badge reader ever appears, the ledger wants
    extracting into its own service and both readers pointing at it — the counters are already shaped for that
    (`RoundCounters`, cleared at both boundaries by `clearAll`).
45. **The board is every body on a side — players and rigs — and round-only.** *The first version listed players
    only and the report came back "I see no stats for the rigs", against a round that had none on the human
    side.* A rig is in the tally (`keyOf` folds a character to its `Player` and leaves a rig as its `Model`), it
    has a side, and it is most of what a round is played against, so leaving it off is the one omission a
    scoreboard cannot afford. **Rigs are read from `rigsOnASide()`** — world-filtered, side-validated, shared
    with `RoundService` and `MatchService` — rather than from the tally, so a rig that has not thrown yet is
    still on the board. **They are not marked as rigs**, on the reason the kill cam gives: the whole NPC system
    is built to be hard to tell from people, and the scoreboard would be the one tell. **The round-only half is
    `BadgeService`'s clearing**: it wipes on the `Playing` edge *and* after the fifteen-second badge window, so
    the board reads `0` through most of an intermission. That is right for an in-match overlay and wrong for a
    results screen — do not extend this panel to fill the gap the deleted end-of-round board left, because the
    numbers it would need are exactly the ones `clearAll` has just thrown away. The two lifetimes would have to
    part company first.
46. **`Tab` opened Roblox's leaderboard, and there were two faults rather than one.** The report came back as
    "the disable fails silently"; the code said something more specific. `CoreGuiController` never called
    `SetCoreGuiEnabled` at all — it wrote `Enabled = false` on the `PlayerListConfiguration` child and reported
    behind `DEBUG`, which is off, so **no captured log had ever shown whether it took**. And
    `MatchStatsController`'s binding returned `ContextActionResult.Pass`, which is the opposite of claiming a
    key — so the press reached the player-list CoreScript whatever the configuration said. **Both are fixed**:
    the legacy call is now pcall-retried (50 × 0.1 s, the same five seconds the configuration watch gives),
    both `Enabled` and `Open` are written on the config object (the second is the state `Tab` toggles), and the
    binding sinks. **Three independent levers, on purpose**: the legacy call is a *request* whose result cannot
    be read, the configuration is a *value* whose result can, and the sink does not depend on either. **The
    lines a run should now show** are `[CoreGui] PlayerList disabled — attempt N, enabled now reads false` and
    `[CoreGui] PlayerList disabled at mount — enabled reads false, open reads false`; a `true` in either
    read-back is the finding. **Unverified**: whether the engine re-enables the list on respawn or at a round
    boundary (nothing in this project does, and no re-assert is wired), and whether `Open` is writable on this
    build — if it is not, `[CoreGui] could not write the player list's settings` says so.
47. **The end-of-round teleport moved the whole server, and `teams` is not the gate that fixes it.** The
    report was lobby players being cut back to a lobby spawn at every round end. Two teleport sites matter
    and only one was wrong: `teleportTeamsToArena` already iterated `playersInRound()`, while `teleportAll`
    walked `Players.GetPlayers()` with a practice-zone skip — so a never-opted-in spectator and a
    *surrendered* player were both moved, to a spawn that is not where they were standing. **The asymmetry
    the report described is the diagnosis**: `transitionAround` publishes `ROUND_TRANSITION_ATTRIBUTE` to
    `this.teams` alone, so the wipe covered exactly the players who were supposed to move and none of the
    ones who were not. **`teams` could not be the fix**, because `surrender` deliberately leaves the player
    on their side (`rosterOutcome` needs the side), so a gate on `teams` would still yank them. **The fix
    is a capture, not a query**: `gameLoop` reads `playedThisRound = playersInRound()` **above**
    `activePlayers.clear()` and passes it to `teleportAll(roster, to)`, so both ends of the round move one
    list by construction and there is no second definition of "participant" to drift. **`returnToLobby` and
    `surrender` needed no roster change** — both already release the match and call `eliminate`, which is
    what takes the player out of `activePlayers`; the teleport was reading the wrong list, not a stale one.
    **Unverified without Studio**: whether a spectator standing mid-lobby is now left exactly in place
    across a round end, and whether the surrender prompt's return is visibly unaffected. Open items remain
    around respawn, since a player with no `Character` is still skipped.
48. **The cover was published to a list the move did not use, so an opted-out player saw the boundary's
    grid twice.** The same report's second half: with `teleportAll` fixed, a player who joined, pressed
    Return to Lobby and then watched the round end *still saw the transition play* — because
    `transitionAround` bumped `ROUND_TRANSITION_ATTRIBUTE` on `this.teams`, which keeps a surrendered
    player on purpose, while the move took `playersInRound()`, which no longer contains them. **The
    correction is structural rather than a second filter**: `transitionAround(roster, move, options)` now
    takes the roster and hands that same array into the move, so the cover and the move are one set by
    construction — a caller cannot cover one list and move another. `teleportTeamsToArena(players)` takes
    the list too, so neither boundary reads `activePlayers` for itself. **Two side effects, both wanted**:
    a practice-zone player who holds a roster seat no longer gets a round-start grid over a move they were
    never in, and the round-start cover is now `playersInRound()` rather than `teams` (identical in the
    ordinary case, which is why the split survived). **The next pass added "an empty roster skips the cover"
    and that was wrong — see item 51.** That guard read the wait as the cover's own, when it is also the
    window `LobbyRigService.promoteWalkers` needs before the move; it is gone, and the comment that argued
    for it is corrected. **Unverified**: whether the two
    grids a surrender used
    to produce are now visibly one (the surrender's own bump, then nothing at the boundary), and whether
    `TRANSITION_CONFIG.WIPE_AT_ROUND_END` off leaves a surrendered player seeing nothing at all — it
    should, and that is the setting that would show it most plainly.
49. **The round-end move now says who it took, because three reports have asked the same question and the log
    could not answer it.** `teleportAll` prints one line per round end — `[Round] lobby move — N bod(ies) of M
    to (x, y, z): names` — and a line per participant it *could not* move
    (`… has no body to move; their next body lands in the lobby`). The distinction is the whole point: a body
    left on the court is either a player who was not in the roster at all, or a player who is in it and has no
    body yet, and nothing in the old output separated those two. **A participant missing from the move line is
    the finding**; a participant *on* it who still ended up on the court is a client or camera fault, not a
    server one. **Also closed: `handlePlayerJoined` now asks `finished` as well as the phase.** `finishRound`
    sets `finished` inside the round's own loop, while the phase does not become `Intermission` until the next
    turn of `gameLoop` — so a body handed back in that frame would have been placed on its **side's arena
    spawn**, on the court that was just played, a fraction of a second before the round-end cover and the move
    to the lobby. A body that arrives after the round is decided belongs in the lobby. **Unverified**: whether
    that window is reachable at all on a live server (a `LoadCharacterAsync` resumption lands on a frame step,
    and the phase change is the next one, so it may be a single frame wide) — the line above is what would show
    it if it is.
50. **A rig was restored onto a lobby pad during a live round, and its next respawn put a body in the
    lobby.** The line is `23:46:09.035 [Rig] ThunderPix64: back on side A's pad` in a round that ran
    `23:44:58 → 23:47:34` — `placeParked`'s **lobby** branch, in the middle of a match, for a seat freed by
    `prospeed1: no side after 5s`. That rig died at `23:46:48.778`, and `RespawnBehavior` rebuilds a rig at
    its *recorded home* — which was now the pad — so the replacement appeared in the lobby, on side A, in
    front of a match it could not rejoin. **Two changes, one for each half.**
    **(1) The respawn asks where the rig belongs now**: if the round is playing and the corpse had a side,
    the rebuild is placed on one of that side's arena spawns (`npc/arenaSpawns.ts`, a fresh read of the place
    file, +3 studs, the same lift every other mover uses) and that point becomes the new home. Everything
    else — no side, no round — keeps the recorded home, which is the behaviour it always had. This makes the
    reported symptom impossible regardless of how a home got to be wrong, and it self-heals every home
    already wrong in a running server.
    **(2) `placeParked` no longer reads the phase for itself.** It takes `playing` from `rebalance`, which
    had already read it to choose between the two spawners, so one call can no longer hold two opinions; the
    same one-read-per-call fix was applied at `onPlayerLeft`'s refill. The pad branch now prints the phase it
    was told — `back on side A's pad (phase "Intermission")` — because **the root cause is not proven**:
    nothing in this repository writes `ROUND_STATE_ATTRIBUTE` other than `RoundService`'s two boundaries, so
    a phase of `Intermission` at `23:46:09` should have been impossible, and the next log with that line in it
    will say which of the two it was. **Unverified**: whether a rig respawning into the arena during a round
    is visible as a refresh rather than a body walking in (it is a cut, as every rig arrival is), and whether
    the pad line now ever prints a phase other than `Intermission`.
51. **Two rigs were left standing in the lobby for a whole round, and the cause was a guard added two passes
    earlier.** The round that opened `23:58:35.619 … (players A: 0, B: 0; rigs A: 3, B: 3)` has **no
    `[Round] transition — cover in …` line**, where every earlier round start had one: item 48's "an empty
    roster skips the cover" had decided a grid over nobody was wasted time. `LobbyRigService.promoteWalkers`
    runs **on the phase attribute's change** and is `task.spawn`ed, so it lands a few milliseconds after the
    phase is published — `23:58:35.646`, one millisecond *after* `arena freeze` printed. It writes
    `TEAM_ATTRIBUTE` on the rigs still walking so `teleportTeamsToArena` picks them up; with no cover the
    move had already happened on the publish frame, so those two were promoted *after* the bodies left. They
    were not moved, and `promoteWalkers` had removed their walk tag, so nothing downstream snapped them in
    either — `moveWalkersToArena` only looks at walkers — and they stood in the lobby, on a side, for the
    whole round. **The fix is the revert**: the cover runs whenever the boundary has one, and an empty roster
    only means nobody sees it; `transitionAround`'s comment now states that the wait is also the promote
    window, so the shortcut is not re-derived. **`TRANSITION_CONFIG.ENABLED` off still moves at once** and
    still has that race — a debugging switch, unchanged, now named in the comment rather than discovered.
    **New line, because the count was the missing evidence**: `[Round] arena move — N player(s) and M rig(s)
    to their side's spawn`, printed at every round start. A round of eight bodies reading `6 rig(s)` there is
    the finding, and it is the one thing this log could not say. **Unverified**: that the restored cover puts
    all eight in the arena on a rigs-only round (it should — the promote now has 0.86 s), and whether
    `moveWalkersToArena` is still needed at all now that the promote is reliable.

52. **Every rig in the lobby stood still in its walking clip, and the fact was an edge with only one ending.**  **REVERSED by item 104** — the mechanism this item introduced is deleted; the rig's walking fact is intent, not a measured speed.
    The report was a client one — "the NPCs render as walking when they are completely still" — and the
    client was innocent: `RigAnimationController` reads `AnimMoving` off the rig and `applyBodyRender` swaps
    the clip the moment it changes, so a client that draws walking is being *told* walking.
    `NpcService` published that fact as `loop.runningSpeed > NPC_CONFIG.RIG_MOVING_SPEED`, and
    `runningSpeed` was written only by `Humanoid.Running` — "fires when the speed at which a `Humanoid` is
    running changes". **That is an edge on the speed, not a level**, and it was being read as if the last
    edge were always the stop. Three of the ways a rig here stops need not be a speed change the engine
    publishes: `MoveTo` at the body's own position (the stop every behaviour uses — `SeekBehavior.stand`,
    `WalkToJoinPadBehavior`'s arrival), an arrival inside the engine's own tolerance, and the engine's
    eight-second give-up. A rig whose last published speed was a walking speed therefore kept `AnimMoving`
    true for the rest of its life. **The lobby is where it showed** because a placeholder walks to its pad
    exactly once and then never moves again, and it is the rigs the player is looking at through the whole
    intermission. **The fix is the engine's other edge**, `Humanoid.MoveToFinished` — "fires when the
    `Humanoid` finishes walking to a goal declared by `Humanoid:MoveTo()`", which fires on arrival *and* on
    the give-up, and only ever when the engine has stopped the body. `NpcLoop.moveToFinished` is the new
    subscription, held and dropped exactly as `running` is; `NpcLoop.runningSpeed` now has two writers and
    says so. **A walk issued afterwards re-asserts through `Running`**, so the pair cannot leave a *walking*
    rig standing — the only direction it can be wrong in is the benign one. **New line**:
    `[NPC] <name>: <why> with the speed still N.NN studs/s — published as standing from here`, where `why`
    names **which** clear found it (`the walk ended`, `taken out of the world`, `placed by a mover` — see item
    53), printed **once per rig** and only when the speed being cleared was a walking one, so a session either
    prints it once per rig (the fault was real, and this is the branch clearing it) or prints nothing (the
    engine was reporting its own stops and something else is wrong). **Unverified**: that this is the whole
    cause. Nothing about the animation itself is observable from a server log — the clip swap is client-side
    — so the proof is the user's eyes plus either shape of that line. **And one mechanism of the same class is
    left standing, named rather than hidden**: `MoveToFinished` only fires for a body that was *walking*, so a
    rig that is shoved into motion and then comes to rest by physics has no edge to end it at all — it keeps
    publishing *moving* until the next walk ends. A rig pressed against something it cannot pass is the other
    half of the same allowance: it keeps publishing *moving* until `MoveToFinished`'s eight-second give-up,
    which is what Roblox's own script gives a player pushing a wall. Both are the benign direction — a body
    that is trying to move — and both would show in the same log line if they ever fired for a body that was
    not. **Both are closed by item 79**, which is the watchdog this note asked for.
    **Also corrected here, because they were argued from the same fact**: the essay in
    `publishAnimation` that claimed `Running` "fires `0` when the body stops", the note that called a blocked
    rig "not moving" where a player reports a walk (a measured world speed reports the shove and the push, so
    the direction of that cost was written backwards), `NPC_ANIM_MOVING_ATTRIBUTE`, `RIG_MOVING_SPEED`,
    `animationFor`'s note on where a rig's half of the fact comes from, and `ThrowBehavior`'s
    `moveThenPlant` note that said a shove could not delay it.

53. **Still one rig walking on the spot per session — and it was the one a player's arrival stands down.**  **REVERSED by item 104** — the parked-rig case is now one of the two boundary clears, not a third caller of a speed clear.
    The next log (`00:21`) was the proof item 52 asked for, and it disproved half of it. **Seven of eight
    rigs printed the new line, and every one printed it with the engine's last speed still at
    15.93–31.00 studs/s** — so `Running` does *not* report a stop, `MoveToFinished` is the only stop edge
    there is, and the clear works. But the report survived, so `MoveToFinished` was not the whole story: the
    eighth rig, **`CosmicChaos12`, printed nothing at all**, because it never finished a walk. It was stood
    down for `prospeed1`'s arrival at `30.998` — `[Rig] CosmicChaos12: … stood down (A) — parked (1 waiting,
    "Random girl" kept for it)` — and refilled onto a pad at `36.016`. **Exactly one rig per session goes
    through that path** (one stood down per person already in the server), which is why the fault was always
    one rig, and it is the only body whose lifecycle the two fixes below both touch.
    **Two faults, one on each side, and the client one is a plain bug.**
    **(a) The server kept a speed across a park.** `parkRig` reparents the body into `ServerStorage` without
    issuing a stop, and `NpcService.run` stops turning for it in the same breath — so neither `Running` nor
    `MoveToFinished` could fire while it was away, and the speed it had when it left was still there when it
    came back. `clearWalk` is now the **one statement of "this rig is standing"**, with **three** callers:
    the end of a walk, the out-of-world gate in `run`, and `announcePlaced` (a `PivotTo` moves a body without
    changing its speed, so a placement can end the truth without either edge firing). All three only ever
    withdraw a speed the body is not travelling at — `Running` re-asserts on the next change of speed — and
    the line names which one found it.
    **(b) The client never dressed the rig again.** `RigAnimationController` watched rigs on the `NPC` tag's
    added-signal and dropped the row on `AncestryChanged` leaving `Workspace`. **A parked rig keeps its `NPC`
    tag**, so neither `CollectionService` signal fires in either direction: the row was dropped on the way
    out, its `AncestryChanged` handler was disconnected with it, and nothing watched the body on the way back.
    `destroyBodyRender` had already destroyed its tracks, so that one rig stood for the rest of the session in
    whatever pose the destroyed tracks left it in — a stride, if it was parked mid-walk, which reads exactly
    as "it is playing the walk while standing still". **The fix is that leaving the world and being destroyed
    are two different disposals**: `undress` tears the renderer down and keeps the row, and only `Parent ===
    undefined` (the engine's own `Destroy`, which clears parents down the whole subtree) calls `forget`.
    `apply` now refuses to dress a body that is out of the world, so a parked rig costs nothing while away,
    and the `AncestryChanged` handler re-enters `apply` when the rig comes back — the one place a renderer is
    built from published state.
    **And every placement now issues the engine's own stop, not only the fact's withdrawal.** Clearing the
    field alone would have been a claim the body did not honour: a rig snapped into the arena by
    `moveWalkersToArena` still carries the `WalkToPoint` it was given in the lobby, so it would have gone on
    walking toward a pad in another room while every client drew it standing — the opposite error, and a worse
    one, because the body would be in the wrong place. `announcePlaced` therefore does
    `MoveTo(root.Position)` — the idiom `SeekBehavior.stand` and `WalkToJoinPadBehavior`'s arrival both use —
    before withdrawing the fact, and all five of its callers are movers saying *this is where the body belongs
    now*: `RoundService.teleportTeamsToArena`, `returnRigsToLobby`, `LobbyRigService.moveWalkersToArena`,
    `placeParked` in both forms, and `standOnPad`.
    **Unverified**: the animation still cannot be seen from a log. What the next session proves: `[NPC]
    CosmicChaos12: taken out of the world with the speed still …` (a), plus that rig animating correctly once
    it is back on a pad (b). **A third mechanism is possible and NOT fixed**: if
    `Humanoid.Running` ever fires a nonzero speed for a body that is not walking (a `WalkSpeed` write, say),
    nothing would clear it until the next walk ends, because there is no walk to end. Ruling that out needs
    `humanoid:GetPropertyChangedSignal("WalkToPoint")` — "a `MoveTo` was issued and has not finished" is the
    one fact that would clamp it, and it is refused for now because if that signal ever failed, no rig would
    publish *moving* at all and the R6 idle-clip fault of `02a0ad4` would be back. The three clears above
    cover the reported case without that risk.

54. **The Match Stats board was blank, and the reason it stayed blank for a whole session is that nothing in
    the output could tell its three possible causes apart.** The report was *"pressing Tab shows the panel
    frame but no rows, all game"*. **What was checked against the source, and found correct**, because a
    prompt asked for four of them specifically: `BadgeService.tally()` **already counts rigs** — `keyOf` folds
    a character to its `Player` and leaves a rig as its own `Model` — so no tally change was needed and none
    was made; `MatchStatsService.board()` already walks **both** `Players.GetPlayers()` (side on the `Player`)
    and `rigsOnASide()` (side on the model) and passes both through the same `rowFor`, so the points formula,
    the `?? 0` and the side filter are identical for a rig and a person; the sides really are the same two
    strings on both ends (`TEAM_A`/`TEAM_B` are `"A"`/`"B"`, which is what `SIDES` on the client groups by);
    and the remote's plumbing is the library's own and **is** reachable — `events.Server.OnFunction` is
    `Get(name):SetCallback(fn)` (`ServerDefinitionBuilder:OnFunction`), `CallServerAsync` returns a
    `TS.Promise` that `then`/`catch` chain on, and `InferServerCallback` types the handler as
    `(player: Player) => R`. **The server was not short of rigs, and the answer was sound** — which the next
    log proved outright (see below).
    **Three premises in the prompt were wrong and are worth recording.** (i) *"the UI may assume every row is
    a `Player`"* — it cannot: `MatchStatsRow` is two strings and five numbers, built by the server from
    `Player.Name`/`Model.Name`, and the client neither looks a name up nor branches on what a body is. (ii)
    *"ensure the UI does not load a player headshot or avatar"* — there is no `ImageLabel` anywhere in this
    panel, so there was nothing to guard. (iii) *"players use `DisplayName`"* — they deliberately do not:
    `MatchStatsRow.name` is `Player.Name`, on the convention `hitImpact`/`teamWipe`/`LAST_HIT_BY_*` all keep,
    and switching to `DisplayName` would make a row's identity disagree with every other line of text in the
    game. **What was actually wrong, and both are ways the panel could be empty with nobody able to tell
    which:** the *"no one is on a side yet"* line was a row appended to the `ScrollingFrame`, so the one
    message that explains an empty board lived inside the frame that has no height of its own until the
    layout gives it one — **an empty board and a board that never got an answer therefore looked identical**,
    which is exactly the question this report asked; and a promise that *fulfilled* with nothing set
    `this.last = undefined`, so the next `render` indexed `undefined` inside a `then` block whose `catch`
    reports it as `board request failed` — i.e. **a client-side throw was announced as a transport failure**. 
    Fixed: the empty state is now a `TextLabel` built once in the content band beside the list (not inside
    it), showing **"Waiting for players…"**, switched by `Visible` against `list.Visible` so exactly one of
    the two is ever on screen — **and it is now two sentences rather than one** (see the end of this item);
    and `receive` validates the answer with `typeIs(rows, "table")` before storing
    it, so a void answer becomes the empty state rather than a throw in a callback. **The server now says
    what it answers**: `[Stats] board for <name> — N row(s), A n / B m, k with points`, or a `warn` naming
    *0 rows*, both wrapped in `pcall` so a throw is reported against the board instead of vanishing into an
    `OnServerEvent` traceback the client experiences as a sixty-second silence. **One line per press** — the
    board is asked for on a `Begin` and never polled, so this is not a per-turn cost. **A Luau trap found
    while writing that line, and worth knowing**: `new Map()` compiles to a plain table here and
    `map.get(k)` to `map[k]`, so `map.size()` emits a generic `for` over a table and **raises** — `tally()`
    is safe to index and not safe to count, which is why the line counts `rows` instead.
    **The next session answered it, and the answer was "N rows with a blank panel".** The server printed
    `[Stats] board for prospeed1 — 8 row(s), A 4 / B 4, 6 with points` while the panel showed its column
    headings and nothing else, and the rig/person split, the side grouping and the points formula were all
    visibly right as the intermission filled the sides (`0 rows` → `1` → `3` → `4` → `5` → `8`, `A 0/B 1` to
    `A 4/B 4`). So **the data path was never the fault** and neither was the tally: the client received the
    board and drew it nowhere. Two faults, found in that order:
    **(a) The rows frame had no height.** `addRowList` had copied `addShelf`'s "take the rest" — a zero `Size`
    plus `UIFlexItem{FlexMode = Fill}` — on the argument that this is how a `UIListLayout` spells `flex: 1`.
    That holds for the plain `Frame`s it was copied from (`addContentBand`, `addFillColumn`, both of which do
    visibly fill) and **not for a `ScrollingFrame`**: the frame kept the height it was given, which was nought,
    so the headings above it drew and the eight rows built into it every press had nowhere to be. The
    empty-state label was invisible for the same reason, which is why the panel looked identical whether the
    server had answered or not. **The fix is arithmetic rather than flex**: `Size = (1, 0, 1, -(ROW_HEIGHT +
    ROW_GAP + 2 × SHOP_CONFIG.PAD_Y))`, everything the band has less the heading strip, the gap and the band's
    own vertical padding — subtracting the padding is right *both* ways of reading `UIPadding`, and erring
    short is a gap at the bottom of a list that scrolls where erring long would cut the last row in half.
    **(b) The board was the project's only `ServerAsyncFunction`.** Every remote in this game that has ever
    been seen to work is a `ClientToServerEvent` or a `ServerToClientEvent` — the dodge, the catch, the sprint,
    the drop, the vote, the chest, `teamWipe`, `hitImpact`, `perfectDodge` — and the board's round trip is the
    one call shape here with no observed success. It is now **`matchStats`** (client → server, no payload) and
    **`matchStatsBoard`** (server → the one client that asked), which is `openPowerChest`/`chestResult`'s shape
    in the same file. The correlation id the library used to match a reply to its request is gone and its
    absence is argued: the payload is a *snapshot*, so a stale answer can only be an older board.
    **And a client-side line, once per session**: `[Stats] board answered — N row(s), M drawn into a frame
    W×H px (visible yes/no)`, read a frame after the answer so the layouts have run. **A frame of `W×0` is the
    whole diagnosis**, and it is the number that was in no output for four sessions. `DEBUG` stays off in that
    file; this line is not behind it, on the same reasoning as every boot count in this project — a fault that
    prints nothing is a fault that costs a session.
    **Still unverified**: that (a) is what the screenshot showed and that (b) was ever actually breaking. Neither
    can be settled without Studio, and the two were fixed together because the panel could not distinguish them.
    If the board now draws, the new line says `8 row(s), 9 drawn into a frame …×N px` — nine children because the
    two side headings are inside the rows frame and are counted as drawn content.
    **And the panel now says which of its two empty states it is in, which is the change that stops this
    costing another session.** *"Waiting for players…"* means the board has never been answered; *"Nobody is on
    a side yet."* means an answer arrived and the round has not filled. Those are the same pixels and wholly
    different faults — the first is the transport, the second is the roster — and one sentence for both is why
    four reports of "the board is empty" could not say which. The flag is `MatchStatsController.answered`,
    written by `receive` and read by `render`.

55. **The lobby spawned a full roster and then parked one rig per player — the deficit is now drawn, not
    thinned.** `seedLobby` cloned one rig per seat the match allows (eight) and then called `reserveSeat` for
    every player already connected, each of which found a rig, stood it down and parked it. **The lobby a
    player saw was always right — seven rigs for one person — and the eight bodies were built to produce
    seven.** The `08:56` log is the whole of it on two adjacent lines: eight `[Rig] … lobby spawn, side …`
    lines, then `[Rig] NeonBandit: prospeed1 arrived — stood down (B) — parked`, then
    `[Rig] up — 8 placeholder rig(s) (8 seat(s))` over a lobby of seven. Each of those eight is a template
    clone, a `[RigTemplate] spawn` audit, an `NpcService` loop, eight behaviour tags, a burst and a walk.
    **The same shape with eight players connected builds eight bodies and parks all eight**, which is the
    case that made the count indefensible. **The fix is an ordering, not a new rule**: `seedLobby` now records
    a pending seat for every player *first* (`reserveSeatAtSeed`) and then draws only what each side still has
    open (`MATCH_MAX_PER_TEAM − playersOn − pendingOn`). Nought rigs is now reachable, and the record the old
    comment was defending is untouched — `pending` holds a player and a side either way, so
    `releaseSeatIfUnused`, `onPlayerLeft`, `releasePendingSeats` and `refillAtRoundStart` cannot tell the two
    ways in apart. **A join after the seed is unchanged**, and it is the case parking exists for: the body the
    player displaces already exists, so `reserveSeat` still parks it (criterion 5: seven rigs plus one joiner
    is six rigs, one parked, eight seats). **The side an undecided player's seat is booked on is now chosen**
    — `seatForNewcomer` takes the emptier side — where the old seed booked whichever side the *first
    walk-tagged rig the collection happened to offer* had been sent to, which at boot was arbitrary by
    construction. Verified against a table of cases rather than in Studio: 0 players → 8 rigs, 1 → 7 (3 on
    the player's own side, 4 on the other, so that pad reads four bodies including them), 2 → 6, 4 → 4
    (2 and 2), 8 → 0, 8 seated 4/4 → 0, and a ninth player with eight seated → 0. **The two deficits can
    differ by up to `MATCH_MAX_PER_TEAM`** — eight players all on `A` is nought rigs for `A` and four for
    `B` — so the alternation runs the fuller side alone once the other is spent. **Unverified in Studio at the
    time.** **The consequence named here is what the next report turned out to be** — a player who never
    chooses lost their reserved seat after `SEAT_RESERVATION_SECONDS` and the lobby refilled to eight rigs —
    and item 56 is that term's removal.

56. **Seven rigs became eight five seconds into the intermission, and the cause was a clock that had stopped
    meaning what it was written for.** The `09:11` log is four consecutive lines and they are the whole
    fault: `[Rig] up — 7 placeholder rig(s) for 1 player(s) of 8 seat(s) (3 open on A, 4 on B)`, then
    `prospeed1: no side after 5s — the seat on A is a rig's again`, then `VelvetVenom8 … lobby spawn, side A`
    and `refill — VelvetVenom8 to side A (seats held before: A 3, B 4)`. So the deficit rule from item 55
    worked exactly as written and was undone by `SEAT_RESERVATION_SECONDS`.
    **That term was correct for the lobby it was written in and is wrong for this one.** It existed because a
    full roster was spawned and one rig stood down per player: a joining player's seat was then a *hole* in a
    lobby that had already built the body for it, so a hole nobody filled left a pad permanently a rig short,
    and five seconds of grace was the repair. **Deficit spawning inverted the meaning of the record** — it is
    no longer a hole, it is the player's own body, standing in the lobby, and rigs are only built for the
    seats nobody is in. Expiring it therefore repairs nothing; it conjures an extra rig beside a person who is
    already there. Removed: `holdSeat` sets no timer, `releaseSeatIfUnused` is deleted, and
    `NPC_CONFIG.SEAT_RESERVATION_SECONDS` is deleted with a note in its place saying why (its doc is kept as
    the record of the reversal).
    **A record is now released by exactly three real events**: choosing a side (`syncSeats`), leaving
    (`onPlayerLeft`), and the whistle (`releasePendingSeats`, because a round is played by eight bodies and a
    spectator who has not chosen is not one of them).
    **And removing the term exposed the second half, which no single log had shown yet: the whistle takes every
    record, so nothing would put them back.** The intermission *after* a round begins with eight arena rigs and
    nobody holding a seat, and would have stayed at eight rigs beside one person for the whole intermission —
    the same fault one round later, with no line in the output to say so. `bookSeats` is the repair: an
    intermission-only sweep in `rebalanceBody`, before either count is read, that calls `reserveSeatAtSeed` for
    every connected player. It is the mirror of `syncSeats` (which syncs the roster half of the ledger) applied
    to the half that is not in the roster, and on a settled intermission every lookup misses, so the common turn
    is one `Players.GetPlayers()` read and no write. The parked rig is still the mechanism there — booking a
    seat on a side that is over its cap makes `releaseRigs` park one — so the join path and the repair path
    produce the same lobby by the same arithmetic.
    **Now true for the whole intermission rather than for five seconds**: rigs in the lobby =
    `MATCH_MAX_PER_TEAM × 2 − Players.GetPlayers().size()`, for as long as the intermission lasts, however long
    that is. **Unverified in Studio** — this is the third pass at the same count and it needs one session to
    confirm: `[Rig] up — 7 placeholder rig(s) for 1 player(s)` with no `no side after …` line following it, and
    no eighth `lobby spawn` in the intermission. The round itself still fields eight rigs, which is `RoundService`'s
    business and was not touched.

57. **A body could be left with no track at all, and the renderer recorded a failure as a success — which is why
    it froze in its rest pose.** `applyBodyRender` assigned `render.playing = clip` **before** it looked the track
    up, and the guard at the top of the function returns when the wanted clip equals `playing`. So a clip whose
    asset would not load — a moderated id, one this place does not own — was remembered as *being worn*, and every
    later call answered "already playing this" and returned without starting anything. The body then had zero
    tracks: the default rest pose, arms at the sides, which is the reported symptom exactly. **Two shapes, both
    reproduced against a model of the old and new control flow:**

    - **held in a state whose clip cannot be dressed** (`throw` is the one, because a charge holds it for a second
      and a mark holds it for `THROW_CLIP_SECONDS`) — old: `playing` set, nothing started, every later call an
      early return, **rest pose until the state changed**; new: `walk` is kept;
    - **the first clip a body is ever asked for is the broken one** — old: **rest pose for the life of the body**;
      new: the locomotion floor is played instead.

    **The fix is an ordering plus a separate memory.** `trackFor` is resolved *before* anything is stopped, so a
    state a body cannot dress now costs it nothing; the attempt is remembered in `BodyRender.unplayable`, which is
    the idea the old comment was right about ("remembering the attempt is what stops every change from trying again
    for a clip that will never exist") in a field that does not also claim the body is wearing it. And **a
    locomotion floor** was added: when the wanted clip cannot be dressed *and nothing is playing at all*,
    `animationFor` now supplies idle/walk/run/jump — the same pure rule `bodyClipFor` ends on, so the fallback and
    the ordinary answer cannot disagree. A body already wearing something keeps it, which is the direction this has
    to err in: an outdated clip is a body behind its state, no clip is a body that looks broken.

    **A second freeze, found while fixing the first, and it needs no broken asset at all.** `Play(fadeTime, weight,
    speed)` keeps the track's own speed when the third argument is omitted, and these tracks are reused for the life
    of the body. A windup that was **cancelled** — a rig's `windup cancelled — the turns stopped`, a player letting
    go of the key — leaves the throw track at `AdjustSpeed(0)` from `holdThrowAtWindup`, and nothing cleared it
    because the release path only runs for a throw that *was* released. The next throw therefore replayed a clip
    that `IsPlaying` and never advanced: a body stuck on its cocked pose. `Play(fade, 1, 1)` is now the reset, and
    a one-shot also gets `TimePosition = 0` (a *cycle* is deliberately not rewound — restarting the walk on every
    state change is legs that hitch each time the body is asked to move).

    **The overlay half of that request was built, and then removed at the user's decision — the scaffold is gone
    and the finding is kept, because it is the part worth having.** Roblox does blend two playing tracks per
    **limb**: "where two playing animations direct the target to move the same limb in different ways, the
    `AnimationTrack` with the highest priority will show" (Roblox, `AnimationTrack`). So the *obvious* asset is the
    wrong one: **a legs-only walk under a whole-body throw changes nothing**, because the throw keys the legs too and
    is the higher rung, so it owns them; **an upper-body-only throw over a whole-body walk is what would work**, the
    walk keeping the legs because nothing else keys them and the throw taking the arms because both do. **So the
    asset such a feature needs is an upper-body-only aim/throw clip, not a legs-only walk** — and if it is ever
    wanted again, that is the fact to start from rather than the one the request assumed.
    **Removed in full**: `UPPER_BODY_ONLY_R15` from `animation.config.ts`, `upperBodyIdFor` and `canLayerUnder` from
    `shared/animation.ts`, and `underlay`/`armTracks`/`applyUnderlay`/`underlayFor`/`armTrackFor` from
    `bodyAnimation.ts` — with `bodyRenderPlays` and `destroyBodyRender` back to walking `tracks` alone. **One track
    per state is the pipeline again, on both bodies**, and nothing at runtime can print an overlay line because the
    line itself is gone. **A reader who finds the notes above in some future archaeology should not read the removal
    as a retreat**: the reason is that the feature needs an authored asset nobody has made, and dead scaffolding for
    an unowned asset is a second path through the renderer that no session exercises.
    **Unverified**: whether any of the reported freezes was the load-failure one. The proof is a rig that used to
    freeze and now does not, plus a warn of the form `[Animation] clip <id> would not load` in a session that froze
    — **no such line has ever been pasted**, which is why the ordering fix and the speed reset are both stated as
    defects the source proves rather than as a diagnosis of that specific report.

58. **A rig hit drew no VFX in the practice zone, and the request's diagnosis was wrong in every part — the
    finding is what the file could not see, not what it computed.** The request said `hitVfx` used
    `Players.GetPlayerFromCharacter(victim)` and a `TEAM_ATTRIBUTE` check, that a rig therefore resolved to
    `nil`, and that the code fell back to a missing `HitNeutral` template. **None of that is in the file and none
    of it ever was**: the role is decided by two string comparisons against `LocalPlayer.Name` — the shape the
    request asked for — `bodyOf` already resolved rigs (by `NPC_TAG`, before this pass), the bystander branch
    already drew `HitVictim`, and `NEUTRAL_TEMPLATE_NAME` was a constant **no line reads any more** (it was
    live when §16 item 14's log was taken, which is how that warning was ever printed; the reader still went
    out with the fallthrough fix below). So the honest answer
    to "what was the blocker" is that the source shows no blocker on this path, and the change below is made for
    a different and narrower reason.

    **The real defect found is a fallthrough.** The `victim === localPlayer.Name` branch called `playOn` and did
    not return, so a client drawing its *own* red burst went on into the spectator branch, resolved the same body
    again by name, and played the same red on it a second time — and `playOn` destroys the previous clone on a
    body before cloning the new one, so every red the local player wore was torn down and restarted in the frame
    it was made. That reads as a stutter, never as "no effect", which is why it survived; it is fixed with the
    `return` the other two branches already had.

    **And the reason this could not be diagnosed from a session is that every diagnostic in the file was behind
    `DEBUG`, which is `false`.** A hit has four ways to draw nothing — the event never arrived, no body by that
    name, a body with no `HumanoidRootPart`, a template missing from `ReplicatedStorage` — and from the seat all
    four are the same nothing. Only the missing template was ever warned about. **Two of the remaining three are
    now `warn`ed**: `warnNoBody` (once per name, naming the seat, so the line itself proves the event arrived)
    and the missing-anchor case in `playOn` (once per body name). The template warning stays once-per-name by
    name and every-time by print, because a template can be added to the place file mid-session.

    **`bodyOf` was widened, and it is a hedge rather than a proven fix.** The tag walk was *stricter than the
    thing that sends the event*: `BallComponent`'s body test is a `Model` with a `Humanoid` and never consults
    `NPC_TAG`, so a hand-placed or untagged rig in a practice zone is a body the server reports a hit for and a
    name this client could not resolve. The walk of `Workspace` that follows the tag search requires a `Humanoid`,
    which is what keeps it from matching a map part called `PlaceholderRig3` — the decoy the old comment refused a
    walk over. **Unproven**: `PracticeZoneService` creates no rigs at all, and every rig this codebase spawns is
    tagged at creation (`NpcService` and `RespawnBehavior` both `AddTag(NPC_TAG)`), so the untagged-rig case may
    not exist in this place file. It is cheap and it removes a way for the client to be narrower than the server.

    **Two candidate causes left unproven, both outside this file and neither touched**: `registerHit` sends
    `hitImpact` only `if (thrower !== undefined)`, and `throwerOf` resolves a rig only through `rigsInRound()`,
    which is `Playing`-gated — so **a rig's throw at a body in a practice zone produces no event at all**. That is
    the mirror of the reported case (a player throwing at a rig), which *is* sent, so it is not the answer here;
    and `resolveTags` skips a dead `Humanoid`, so a hit landing on a body already at `Health <= 0` is silent.
    **To settle it in one session**: set `DEBUG = true` at the top of `hitVfx.ts` and the log will say which of
    the four it is on the first rig hit.

59. **A surrendered player's seat was booked back as a *reservation*, so the round they left played 4-vs-3 for the
    rest of its life — "3 players on blue when I left", and the promise in the output was a rig that was never
    made.** `RoundService.surrender` releases the roster seat and prints *"a rig takes their place"*; the fill it
    relies on is `LobbyRigService.topUpDuringRound`, which asks `seatsHeld(side) < MATCH_MAX_PER_TEAM` on every
    quarter-second turn of the seat poll. **`seatsHeld` counts rigs, opted-in players *and reservations*** — and
    `syncSeats`'s carry-over, written for the intermission's `clear`, cannot tell a roster emptied at a round
    boundary from a roster that shrank because one player walked out mid-round. So the surrenderer's seat became a
    `pending` entry on the side they had just left, `seatsHeld` answered *full*, and no rig was ever spawned. It is
    the one number that could have said so, and it was counted for a body standing in the lobby.

    **Reproduced against the log's own arithmetic before touching anything.** A model of `seatsHeld` / `rebalance` /
    `topUpDuringRound` replaying that session's four events — seed with one connected player, the player opting into
    B (which is what parks a rig off B at 18:51:03.327 and refills A at 18:51:03.330, both matching the log), the
    whistle's 4-and-3, the surrender — prints `A 4 / B 3` and *"nothing short, no rig made"* under the old code and
    `A 4 / B 4` under the new one. The same model run one boundary further still reports **7 rigs for 1 player**,
    which is the regression test for item 55. Nothing in `RoundService` changed for this.

    **The rule was already arbitrated in this file, and this was the writer that missed it.** `releasePendingSeats`
    drops every reservation at the whistle, on the grounds that *a round is played by eight bodies and a spectator
    who has not chosen is not one of them* — and it explicitly rejects the alternative of teaching `rebalance` to
    ignore `pending`, because a definition that changes meaning depending on who is asking is how two callers come
    to disagree. `onPlayerArrived` refuses to reserve anything while `Playing` for the same reason. So the fix is
    the third instance of the same refusal: **`syncSeats` does not create a reservation during a round**, and a
    surrendered player's seat reads empty from the moment they are off the roster, which is what lets the round's
    own fill take it. The lobby's accounting gets them back at the next whistle, because `bookSeats` re-makes a
    record for every connected body the roster does not hold and `rebalanceBody` runs it before it counts.

    **Why this keeps coming back, stated once rather than discovered again.** "The seat" has two definitions in this
    codebase and they are both correct: `RoundService` counts *participants*, `LobbyRigService` counts *people
    present*, and `pending` is the only place they meet. Every bug in this family has been one service using the
    other's answer — a player over a cap read as a misplaced rig (item 18's predecessor), a cleared roster leaving
    an eighth rig (item 55), a seat clock putting the rig back (item 56), and this. **The test to apply to any future
    change here: during `Playing`, `pending` must be empty, and anything that writes it during a round is a leak.**
    `RoundService`'s surrender therefore needs no code at all, which is why it was never the file to change — its
    comment claiming the poll fills the seat "within a quarter of a second" was true of the poll and false of the
    count it reads.

60. **A hit on a hand-made rig drew its effect on the wrong body, because `hitImpact` carried a `Name` where it
    needed an identity — seven models called `Rig` is seven answers to "which body".** The report was the practice
    zone: the burst appeared on the rigs the lobby spawned and never on the seven a person had cloned. **The log
    shows the server doing its job** — `Rig was tagged by DodgeballBall on LeftUpperArm` followed by
    `Humanoid was hit by DodgeballBall on LeftUpperArm` — so the tag resolved, `registerHit` ran, and the event
    went out with `victim = "Rig"`, `thrower = "prospeed1"`. It was the receiving end that could not answer: a
    name in `Workspace` is not unique, so a lookup by name can only ever return *a* body of that name.

    **The fallback added in item 58 is what turned "nothing" into "the wrong body", and that is worth stating
    plainly.** Before it, an untagged rig resolved to `undefined` and the effect was silently skipped; after it,
    the walk found the *first* model called `Rig` and drew there, which from the seat is the same nothing on the
    rig you hit. The change was right about the cause it was aimed at and wrong about the instrument — a walk
    that answers "is there a body by this name" cannot answer "which body was hit". What it did buy is the pair
    of warnings that made the question answerable at all: no `[VFX]` line appears in the log *for those hits*,
    which says `bodyOf` returned something and `playOn` drew — the effect was going somewhere.

    **The fix is an identity beside the name, not instead of it.** `registerHit` mints `BODY_ID_ATTRIBUTE` — a
    per-instance id from a `WeakMap` plus a counter, written onto the body the first time it is hit — and sends it
    as a fourth `hitImpact` field. `hitVfx.bodyOf` resolves on the id first, tag walk then workspace walk, and only
    falls through to the names if no body carries it. **The names stay** because they are what the log is compared
    against and what `hitConfirm` tests against `LocalPlayer.Name`, and the field was appended rather than woven
    in because a Luau handler ignores arguments it does not declare — so `hitConfirm` did not change at all.

    **The `WeakMap` and the attribute are a deliberate pair, and the split is the design.** The client cannot see
    the map, so it needs something on the instance; but an attribute is inherited by a duplicate, so a model
    copied after it had been hit would hand two live bodies one id. Keying the record by instance closes that: a
    duplicate has no entry and gets a fresh id on its first hit. **Two windows are named rather than hidden.** A
    duplicate made after a hit carries the old value until one of the two is hit again; and a body's *very first*
    hit relies on the attribute write reaching the client before the remote call does, which is ordering Roblox
    does not document — a loss there is a fall-through to the name arms, which is the behaviour this item
    replaced rather than a new failure. Both are only reachable for bodies a person placed by hand.

    **Cheap where it is common and dear only where it is needed.** Every rig the lobby spawns wears `NPC_TAG`, so
    the id is found in the tag walk and the workspace scan never runs; the scan happens only for an untagged body,
    which is exactly the hand-placed case that asked for the id. `warnNoBody` now prints the id too, because "no
    body by that name" and "seven bodies by that name and the id matched none of them" are different faults, and
    `""` in that field says the payload predated it.

61. **The Match Stats board is still empty, and this pass did not find the cause — it found the reason nobody could.
    What it did fix is one way for a board holding eight rows to draw none.** Four sessions have now reported
    "the board is empty" and every one of them ended with a plausible story instead of a number: the server's
    `[Stats] board for <name> — 8 row(s)` is the *only* line the chain ever produced, and it says nothing about
    what arrived at the client or what the client did with it. **So this pass is instrumentation first and a fix
    second, and the two are deliberately separable** — the next session's output names the fault instead of
    inviting a fifth story.

    **The one provable defect: rows whose `side` is neither `"A"` nor `"B"` were dropped in silence.**
    `MatchStatsRow.side` is documented as *"the raw `TEAM_ATTRIBUTE` — `"A"`, `"B"` or `""`"*, and `render`
    filtered against a literal `SIDES = ["A", "B"]`, so a body nobody has sided matched neither pass and vanished —
    a board that holds eight rows and draws nought, which is exactly the report. `TEAM_A`/`TEAM_B` are `"A"`/`"B"`
    (`services/round/team.ts`), so this is **not** the cause of this particular report, and it is fixed anyway
    because it is a live way for the same symptom to arrive from a different place: the sides are now read from
    the payload, `SIDES` is only the order, and an unknown side draws under its own heading in the primary ink.

    **The four failures the instrumentation separates** — each is a different file, and all four are invisible
    from the seat:

    | what the output says | what it means |
    | --- | --- |
    | `[Stats] asking — …` then nothing from the client, and **no** server line | the request never left |
    | the server's `[Stats] sending N row(s) to …`, then **no** client `received` line | the answer never arrived — `SendToPlayer`, the listener, or the event pair |
    | `[Stats] received — 8 row(s); first { … }` with a `side`/`points` that reads wrong | the payload's shape |
    | `[Stats] drew 8 of 8 … into 612×0 px` | the rows frame has no height |

    **And each of those is now also on screen**, because a sentence beats a blank panel: the geometry line prints
    the resolved pixels of the panel, the content band, the rows frame and the empty label one second after mount,
    `render`'s whole body and every single row are wrapped so a throw names the body it happened on and puts a
    sentence up rather than half a table, and **a press that is not answered in two seconds says so in the output
    and on the panel** — which is the one case that was previously indistinguishable from a board that works.

    **The rows frame now has both a flex fill and the arithmetic height, and that is the one change made without a
    proven cause.** `addShelf` gives a `ScrollingFrame` a zero size and `UIFlexItem{FlexMode = Fill}` and the
    shop's grid fills its pane — so the *claim* recorded in item 54's neighbourhood, that a `ScrollingFrame` is not
    resized by a flex item, is contradicted by a working panel in the same codebase. Both are now set, and the
    pair is chosen for the direction each fails in: if the flex applies it wins, and if it does not the frame keeps
    an explicit height. **Neither answer is nought**, which is the only outcome this panel cannot survive — and
    nought is what `1, -44` of a zero-height band produces on its own.

    **What the report asked for and does not exist: a `DisplayName`/`UserId` access on a rig.** `MatchStatsRow` is
    two strings and five numbers, and `addRow`/`fillCells` read nothing else — no `Player`, no avatar, no
    `PlayerGui`. The rig is not the problem, the *payload* is, and a `pcall` around the row loop was worth adding
    for the diagnostic rather than for the error.

62. **The board's pipeline is proven end to end and the pixels are still missing — so this pass marks the depths
    with colour and prints the one number that was never in a log.** The session's output settles everything the
    previous five passes argued about:

    ```
    19:25:46.901  [Stats] drew 0 of 0 row(s) … (list hidden, empty shown)
    19:25:46.914  [Stats] board for prospeed1 — 8 row(s), A 4 / B 4, 4 with points     <- 13 ms after the press
    19:25:46.930  [Stats] received — 8 row(s); first { name=prospeed1 side=B points=0 }
    19:25:46.934  [Stats] drew 8 of 8 row(s) into 644×270 px (list shown, empty hidden)
    19:25:14.550  [Stats] geometry — panel 664×398, content 664×314, rows frame 644×270 (visible yes), empty 0×0
    ```

    **So: the round trip is 33 ms, the payload is right, eight rows are created, the scrolling frame is 644×270 and
    reports itself visible.** Every number is consistent — `314 − (26 + 2 + 16) = 270`, `664 × 0.015` of padding
    gives 644 — which means the layout ran exactly as designed. The remaining question is not "does the code
    draw" but **"where are those pixels"**, and no log line in this project has ever contained a position.

    **Two things were proven wrong, and both were hypotheses in the request.** There is **no diagnostic label** —
    every diagnostic this file emits is a `print`/`warn` to the Output window, which is why the player could read
    them; there was never a white-on-white label. And the rows are not an ink problem either:
    `lightPanelTheme()` is `textPrimary #141414` on `panel #FFFFFF`, near-black on white.

    **What the log did prove is a real bug of exactly that shape, one frame over: `empty 0×0`.** The empty-state
    label was declared `(1, 0, 0, 52)` **with `AutomaticSize.Y`**, and it resolved to nothing — so on the press,
    for the 33 ms before the answer arrived, the panel showed `list hidden, empty shown` and the thing shown was
    zero pixels tall. `AutomaticSize` is gone and the height is the constant. **That is the state a player is in
    whenever the payload is empty or slow, and it looked identical to a broken board.**

    **Three 4-pixel bars, one per depth.** `_MarkerPanel` red in the panel, `_MarkerContent` green in the content
    band, `_MarkerRows` blue in the scrolling area — `LayoutOrder = -1` (each lives in a `UIListLayout`, which
    positions its children and overrides `Position`) and `ZIndex = 100` (above the panel's own furniture at 10).
    **The user's answer is the diagnosis**: none → the panel is not on screen; red only → the content band is not;
    red and green without blue → the scrolling area is not; all three without rows → the rows' ink or height;
    all three with rows → it was never broken. The blue bar is spared by `renderBody`'s clearing loop, which
    otherwise destroys it on the first press.

    **And the probe now prints where, not just how big**: the panel's `AbsolutePosition`, its `Visible`, its
    `ZIndex`, its parent's `ClassName`/`Name`/`Enabled`/`DisplayOrder`/`ScreenInsets`, the content band's and the
    rows frame's positions, the empty label's position and text, and — on the first press that has rows — the
    **first row's** resolved rectangle, `Visible`, `ZIndex` and its first cell's `TextColor3` and
    `TextTransparency`. **The expected panel corner is `≈(204, 77)`**, arithmetic from this log: the panel is
    `0.62 × 0.72` of the viewport anchored at its centre, so `664/0.62 = 1071` wide and `398/0.72 = 553` tall,
    and `(1071 − 664)/2 = 203.5`, `(553 − 398)/2 = 77.4`. Anything else on that line is the answer.

63. **The board's rows were drawn underneath the panel. `ZIndex`, and one line of `raiseZIndex` explains all six
    sessions.** A screenshot settled it in one glance: the title, the column headings, the red bar, the green bar,
    the blue bar and the footer all visible — and **nothing between the blue bar and the footer**. That is the
    fourth of the five answers the markers were built to collect, and it points at the one difference between the
    things that were visible and the things that were not:

    | what | when it was built | `ZIndex` | visible |
    | --- | --- | --- | --- |
    | panel background, bands, headings strip, its six cells | at mount | `10` | yes |
    | the three markers | at mount | `100` | yes |
    | the empty label | at mount | `10` | yes (when shown) |
    | **a side heading, a row frame, a row's six cells** | **on a press** | **`1`** | **no** |

    **`raiseZIndex(panel, PANEL_Z_INDEX)` flattens every descendant that exists at the moment it runs to `10`** —
    `for (const descendant of root.GetDescendants()) … descendant.ZIndex = z`. It is called once, at the end of
    `mount`, and it is over before the first press. Everything `render` builds afterwards kept the `ZIndex`
    default of `1`, and `ZIndex` is compared **flattened across the `ScreenGui` rather than against a sibling**:
    a child whose number is below its parent's is drawn *behind* the parent, and this panel's background is
    opaque white (`#FFFFFF`). **The rows were in the tree, at the right size, at the right position, reporting
    `Visible = true`, and painted under the paper.** That is why `drew 8 of 8 row(s) into 644×270 px (list shown)`
    and a blank panel were both true at once, and why every previous pass could verify the loop and still lose
    the pixels.

    **The fix is three `ZIndex` writes, all copied from the container rather than from a constant.** `addRow` sets
    `line.ZIndex = parent.ZIndex`, `fillCells` sets `cell.ZIndex = row.ZIndex` (which covers the row's six labels
    *and* rebuilds the headings strip correctly), and `renderBody` sets the per-side heading to `list.ZIndex`.
    **Copied and not written as `10`**, because the number that matters is "whatever level `raiseZIndex` put this
    panel's furniture on" — a literal would be a second authority on the panel's depth and the two would disagree
    the first time `PANEL_Z_INDEX` moved. At equal `ZIndex` the tree order decides, and a child draws after its
    parent's background; the headings strip is the proof, since it is at `10` under a panel at `10` and has always
    been visible.

    **Two other things this pass proved, both of which were hypotheses and neither of which was true.** There is no
    diagnostic *label* anywhere in this panel — every diagnostic is a `print`/`warn` to the Output window, which
    is why the player could read them, so the "white on a light panel" theory had no subject. And the rows are not
    an ink problem: `lightPanelTheme()` is `textPrimary #141414` on `panel #FFFFFF`.

    **What the previous pass did fix, and it was real:** the empty label's `AutomaticSize.Y` resolved to `0×0` on a
    live log (`empty 0×0 (visible no)`), so the state a player saw for the 33 ms before an answer — `list hidden,
    empty shown` — was a zero-height label. That is "an empty box" all by itself, and it is the state a press
    shorter than the round trip never leaves.

    **`SHOW_MARKERS` is now a single switch** (`MatchStatsController.ts`, top of file) so the three bars can go in
    one edit. They are left on for one confirming session: rows plus three bars means the diagnosis was right.

64. **The board renders, and the dotted background the next request asked for cannot be built without either a
    texture this repository does not have or a change to a file that request forbade.** The panel now wears a
    `UIGradient` — a white-to-`card` wash, three stops of its own palette, one instance. **The dots are not here,
    and the three reasons are worth keeping because they will be asked for again:**

    - **A full-size `GuiObject` child of this panel is eaten by its `UIListLayout`.** The panel stacks its bands
      with a list layout, and a list layout positions every `GuiObject` child *and reserves its height*. A pattern
      sized `(1, 1)` would consume the panel's whole height and push the header, content and footer off the bottom.
      **Not a theory**: item 62's three diagnostic bars are `(1, 0, 0, 4)` children of these same frames, and each
      shifted its siblings down by four pixels — visible in the screenshot that closed item 63. A *modifier* is not
      a child: `UIGradient` is a `UIComponent` like the `UIShadow` the panel already wears, it takes part in no
      layout, and `raiseZIndex` does not see it.
    - **No dot texture exists** — `assets/` is three ability PNGs, no `ScaleType.Tile` appears anywhere in `src/`, and
      `IMAGES_CONFIG` is the logo plus three icons. **`rbxassetid://0` renders nothing**, so the request's fallback
      would satisfy the shape of the change and none of its purpose: the panel would look exactly as bland as it
      did, and the next reader would have to prove that before believing it.
    - **A gradient cannot be made into a lattice, checked against the typings rather than remembered.** These
      typings' `UIGradient` is the modern one — `Type: Linear | Radial | Conical`, `TileMode: Clamp | Repeat |
      Mirror`, `Scale` — and **every combination repeats in one direction**: `Linear` + `Repeat` is stripes,
      `Radial` + `Repeat` is concentric rings about the centre, `Conical` + `Repeat` is wedges. A dot *grid* needs
      two directions, one `UIComponent` has one, and two `UIGradient`s on one object is one `UIGradient`.

    **The procedural grid was rejected on the request's own reasoning and the arithmetic backs it**: a dot every
    16 px on a 664×398 sheet is 41 × 25 = **1,025 `Frame`s**, built once and never destroyed. This panel rebuilds
    eight rows of six labels per press and that is affordable at ~50 instances; a thousand is a different decision.

    **The two unlocks, neither taken.** A `pattern?: string` argument on `addPanelFrame` inserting the texture
    *outside* the band layout is the honest fix and is a change to `panelChrome.ts`. The other is a mirror frame in
    the HUD `ScreenGui` with the sheet's white moved onto it — which needs a copy of the panel's anchor, size **and**
    `UISizeConstraint` to stay aligned on every viewport, and leaves the shadow in the wrong place: **two
    authorities on one rectangle**, which is the shape of every layout bug this panel has had.

    **A texture, when one is drawn, needs alpha-bleed and not just alpha.** `images.config.ts` records that Roblox
    sets fully transparent pixels to **black** on upload, so a naive dot tile at `ImageTransparency = 0.9` lays a
    uniform 10% black veil over the sheet — a dirty panel rather than a pattern. 16×16 PNG, dots in `#DCE0E6`,
    background transparent **and bled**.

65. **A panel is two frames now, and the reason is that a decoration layer cannot be a child of a frame that owns a
    layout.** `addPanelFrame` builds a **sheet** — the visible rectangle, with the corner, the hairline, the shadow
    and the viewport constraint — and inside it an optional tiled **`Pattern`** `ImageLabel` and a **`Content`**
    frame that owns the `UIListLayout`. It returns the content frame, and the bands stack as they always did.

    **The forcing fact was measured two passes ago and misread as a curiosity.** A `GuiObject` child of a frame with
    a `UIListLayout` is *laid out*: the list positions it **and reserves its height**. Three 4-pixel diagnostic bars
    each pushed their siblings down by exactly 4 px, which is visible in the screenshot that closed item 63 — so a
    backdrop sized `(1, 1)` would have consumed the whole panel and pushed every band off the bottom. **That is why
    the texture was refused in item 64, and it is why the structure had to change rather than the technique.**

    **The request's own version of this change would have hidden all three panels, and that is worth recording.**
    It asked for `addPanelFrame` to return the content frame *and* for existing callers to keep working unchanged —
    but every caller ends with `panel.Parent = getHudScreenGui()`, which is the line that puts a panel on screen.
    With a content frame in hand that line moves **the content out of the sheet and leaves the sheet parentless**: a
    panel built perfectly and never drawn. So the return stayed the content frame and the parenting became
    `mountPanel(content, into)`, which resolves the sheet through `panelSheet` — **one line changed in each of
    three files**, and the structure knowledge stayed in `panelChrome` instead of being copied into three mounts.

    **`paintSheet` moved with it, and it had to.** A `UIGradient` on a frame with `BackgroundTransparency = 1` paints
    nothing, and the content frame is exactly that — so the gradient goes on the sheet, found by `panelSheet`. Had
    this been missed the gradient would have silently stopped existing, which is item 65 repeating item 63 one layer
    up.

    **The stops are a calibration ramp and not a design.** `#FFFFFF → #D8DCE4 → #A8B0BC` — deliberately loud, so
    "did the build change" is answerable by looking. **Item 64's stops were the real fault**: `#FFFFFF → #F5F5F7 →
    #E8EBF0` is about one RGB step per ten pixels down a 400-pixel sheet, which is below what a person sees, so
    *"no visible change"* was a true statement about an invisible gradient rather than about a stale build. **The
    lesson is the one this file keeps relearning: a change designed to be subtle cannot also be a change used to
    prove a pipeline is live.** The tasteful version is one edit away and is named in the comment.

    **`pattern?: string` is ready and unused, on purpose.** `PATTERN_TEXTURE` in `MatchStatsController` is
    `undefined`, so the panel wears the gradient and nothing else; setting it to an uploaded `rbxassetid://…` adds
    the tiled layer with no other change. **The art's contract is one sentence and it is in both files**: a 16×16
    PNG, dots on a transparent background, alpha channel kept **and alpha-bled** — Roblox sets fully transparent
    pixels to black, so an un-bled tile at `ImageTransparency = 0.85` is a 15% black veil over the whole sheet.

66. **Each side's heading now carries that side's score, read from the attributes the round already publishes — and
    the interesting part is the three-state distinction, not the number.** `headingText` renders
    `Team B  ·  3`; `scoreOn` answers a `number` or `undefined`, and the heading spends the difference as `—`. **`0`
    prints as `0`**, because an intermission board is legitimately all noughts and a `—` there would claim ignorance
    when there was an answer.

    **`undefined` rather than `0` is why this is not `ScoreHudController.scoreOf`.** That helper returns `number`,
    flooring a missing attribute to nought — right for a HUD bar that always draws a number, wrong for a board that
    has a state to render for "not yet". Two helpers with the same name and different contracts would be worse than
    two names, so neither is shared.

    **The score is read at draw time and never travels in the payload.** `MatchStatsRow` is one *body's* line;
    `ScoreA`/`ScoreB` are the round's own facts and are already on the `RoundStatus` folder where the HUD bar reads
    them. Adding them to `matchStatsBoard` would be a second copy of a number the client can see — and no
    subscription either, because `render` runs on the press and on the answer, so the value is sampled exactly when
    it is drawn.

    **The separator is `·`, not the em-dash the reference used**, and the reason is that `—` is the placeholder: a
    join of `—` would render an unpublished score as `Team B — —`, which reads as a fault. `·` is already this
    panel's separator in the footer sentence.

    **The reference's other three features were reported and not built**: a coloured swatch per side (one `Frame` and
    a `UICorner` per heading, and the side's colour is already available from `teamColourOf`), a grey band per side
    (the heading label would gain a `BackgroundColor3` and the section a `UIPadding`), and dashed row borders (a
    `UIStroke` per row, which does not do dashes — it would need a tiled image, the same asset problem item 65
    records). All three are restyles of proven-working structure and none of them was asked for twice.

72. **`practiceThrow`: a drill rig that throws at the person in its bay, with a `3 2 1` countdown. And first, the
    state it landed in, because the tree it landed on is not the tree the last handoff described.**

    **The rollback was a hard reset to `dfdb36b` and it took the whole practice feature with it** — not just the
    source, and that distinction is the useful part:

    | gone | left |
    | --- | --- |
    | `server/npc/practiceBay.ts` and `client/practiceCountdown.ts` (both files, entirely) | `AlwaysThrowBehavior.ts`, untouched and working |
    | `PRACTICE_BAY_TAG`, `NEXT_THROW_AT_ATTRIBUTE`, `THROWN_FROM_BAY_ATTRIBUTE` from `shared/constants.ts` | `CHARGING_ATTRIBUTE` and `THROW_WALK_ATTRIBUTE`, the charge telegraph the drill reuses |
    | §15 items **67–71**, i.e. the design notes for the bay rule, the footprint fix and the three-state rig→bay rule | §15 items 58–66, so `hitVfx`, the panel chrome and the team-score heading are all still recorded |

    **So "the practiceBay work rolled back" was narrower than it sounds and wider than it sounds at once**: nothing
    that landed in a commit was touched, and *every* uncommitted practice file and every handoff item describing them
    went. **A reader who consults items 67–71 will find they do not exist.** That is why this item re-argues the
    footprint rule from scratch rather than citing them.

    **The feature, in one table.** A rig wears `practiceThrow` (a rig tag, painted, not a `Behavior_*` string) and
    stands in a `practiceBay` (a part, painted):

    | rig | what it does |
    | --- | --- |
    | in a bay, player in that bay | throws at the nearest one; countdown runs |
    | in a bay, nobody in it | idles; countdown cleared; **the decision deadline is deleted, not just cleared** |
    | in no bay | idles; countdown cleared; logs `the rig is in no bay` |
    | not wearing `practiceThrow` | nothing — the behaviour is never entered |
    | wearing `Behavior_AlwaysThrowing` | **unchanged** — that code stays, and a rig wearing both throws twice |

    **The delete on the second and third rows is not tidiness.** Without it a rig whose player walked out keeps the
    deadline it banked while they were there, so the turn they step back in it arms and throws — a throw with no
    countdown at all, which is the one thing a telegraph cannot be.

    **The dispatch answer is that there is no new dispatch.** `NpcService`'s list *is* the dispatch — the loop keys on
    `behavior.tag` — so a tag that is not `Behavior_*` needs an entry and nothing else. A second pass would have been
    a second place a rig's tags are read and a second place `onStopped`/`onDied` could be forgotten. **The one
    consequence is in the MicroProfiler labels**: they dropped a fixed nine-character prefix, which would have turned
    `practiceThrow` into a band called `Npc.tick.ceThrow`, so that is now `behaviorScopeName` and tests for the
    prefix.

    **`beginWindup` gained an optional `trueAim`, and it is asked for by exactly one caller.** A drill that rolls
    `NPC_CONFIG.THROW_MISS_CHANCE` is a drill trying to miss, and a drill exists to be practised against. The flag
    defaults off, so both existing call sites behave byte for byte as before — **what bounds the exception is that it
    has to be argued for at the call site**, where a round rig passing it silently would be invisible.

    **A drill's ball dies at the edge of its bay**, by a marker written at the release
    (`THROWN_FROM_BAY_ATTRIBUTE`, set for a `practiceThrow` thrower and **cleared for anybody else's** so a player who
    throws a picked-up drill ball does not inherit it) and a branch in the existing `settleLooseBalls` sweep. Route (a)
    of the two offered: route (b), parenting the ball to the bay, would freeze its ownership and physics for a
    question about where it is.

    **The countdown publishes a *number*, and not the number a reader might expect.** `NEXT_THROW_AT_ATTRIBUTE` is an
    **instant** from `Workspace.GetServerTimeNow()`, written at the three moments the deadline moves (arm, commit,
    release) and **only while the rig has a target** — a rig doing nothing has nothing to telegraph. A duration on the
    wire is already wrong when it lands by an amount the receiver cannot measure; an instant is one subtraction. **It
    is a second telegraph beside `CHARGING_ATTRIBUTE`, not a spelling of it** — see §11 — and a rig mid-windup has
    both set.

    **`client/practiceCountdown.ts` is a plain module started from `main.client.ts`**, not a controller, so
    `flamework.build` is unchanged: `practiceThrow`'s two tag signals, one `BillboardGui` per rig built on the first
    frame that has a digit, and a `Heartbeat` doing `ceil(at - GetServerTimeNow())`. **It walks `watched` and not
    `rows`** — a loop over the rigs that already have a box would never draw the one that was about to arm. **Gated on
    `practiceThrow` and not on `NPC`**, so no round's rig is ever walked; and every drill is drawn regardless of
    distance, because a countdown is a telegraph of the rig's own clock rather than of the viewer's neighbourhood.

    **Three of the prompt's own premises were wrong**, recorded because the next spec will make the same assumptions:
    the tag count was **twenty-four → twenty-six** and not 25 → 26 (two tags, not one — `practiceBay` came back with
    the feature); §15 items 67–71 **did not exist** to be read as design notes; and `beginWindup` had **no `trueAim`
    parameter**, nor did `headingToward`, `aimAt` or `moveThenPlant` exist anywhere in the tree — they were part of
    what the rollback removed. The three constants the prompt wanted in `npc.config.ts` were split instead: the cadence
    is there, and the two the *rendering* owns are in the client module, because that file's header promises it is
    read on the server alone.

    **What a drill's ball does not do is hurt anybody inside a `practiceZone`.** `BallComponent.handleTouch` vetoes
    the contact — *"in a practice zone — carried on past them"* — so a drill throw passes through the person it was
    aimed at and dies at the bay's edge. That veto is the follow-up's to remove, and removing it without the ragdoll
    means a drill kills the person practising.

73. **The drill said nothing, ever — and that was the feature's own worst diagnostic.** A live session showed
    `[Zone] up — practiceZone: 1 tagged part(s)` and a rig printing
    `[Rig] Behavior_Throwing: throw — charge 0.38 … 11.5 studs to the left (missed on purpose)`, which is
    `AlwaysThrowBehavior` and not the drill at all — the rig is literally *named* `Behavior_Throwing`. **Not one line
    from `PracticeThrowBehavior` in the whole session**, and that was the finding rather than the absence of one.

    **Why it was silent, and why that is a defect rather than a quiet design.** The gate stands the rig down with
    `windups.cancelWindup(model, reason)`, and `cancelWindup` **returns early when there is no hold to cancel** — so a
    drill with no bay, and a drill with an empty bay, both printed nothing at all, forever. Four different faults
    produce that one silence: the `practiceThrow` tag missing, no `practiceBay` part in the place, a bay painted on a
    `Folder` or `Model` (whose *descendant parts* then become separate bays, per `taggedParts`), or simply an empty
    bay. **A feature whose ordinary failure is indistinguishable from its ordinary success is the exact fault
    `TAGS.md` opens with**, and this pass is the correction.

    **Two lines, and they answer different questions.** `practiceBay.reportDrills()` runs once from
    `NpcService.onStart` and prints
    `[Drill] up — practiceThrow: N rig(s), practiceBay: M tagged thing(s), K usable part(s)` — the *tagged thing*
    against *usable part* split is `BallSpawnerService.report`'s, and it is what makes "wrong instance class" legible
    as distinct from "you forgot". It also `warn`s unprompted for the two states that cannot work: drill tags with no
    bay anywhere, and bays with no drill tag. Then the behaviour prints **edge-triggered** per-rig lines —
    `[Drill] <rig>: standing down — nobody is in its bay`, and for the place-file fault
    `[Drill] <rig>: wears practiceThrow but is in no practiceBay — it will not throw. Its position: (…)`, and
    `[Drill] <rig>: armed — <player> is in its bay`. Edge-triggered because an empty bay is a state that lasts for
    minutes; the sequence `no bay … empty bay … armed` is a person walking into a bay, and one that stops at `no bay`
    is a place file to fix.

    **The throw line moved from `[Rig]` to `[Drill]`, and this session is why.** Both other throwing behaviours print
    `[Rig]`, so `[Rig] Behavior_Throwing: throw` was a line that could not be attributed without knowing the source
    file. The prefix now says which behaviour spoke.

    **What the same log makes worth stating plainly for the next session.** A rig wearing only
    `Behavior_AlwaysThrowing` keeps throwing on its timer at `standInPoint` with a deliberate miss no matter what
    geometry it stands in — that is its contract and it was left alone. **It is not the drill and cannot become one
    by standing in a bay**; only `practiceThrow` reads `practiceBay`. If a session shows `[Rig]` throw lines and no
    `[Drill]` ones, the drill tag is not on the rig — and the new boot line now says so in one line rather than
    leaving it to be inferred.

74. **The diagnostics landed and immediately found the fault — and it was not in the code.** The next session printed
    `[Drill] up — practiceThrow: 1 rig(s), practiceBay: 1 tagged thing(s), 1 usable part(s)`, so the tag was on the rig
    and the bay part existed. Then, four seconds apart:

    ```
    11:32:29.141  [Drill] Behavior_Throwing: standing down — nobody is in its bay      <- bayOf FOUND a bay
    11:32:33.588  [Drill] Behavior_Throwing: wears practiceThrow but is in no practiceBay … (52, 97, 542)
    ```

    **Same rig, same session: in its bay at boot, outside it four seconds later.** `bayOf` is a pure function of the
    rig's `HumanoidRootPart` and the bay's `CFrame`/`Size`, so something *moved* — and the warn could not say which,
    because it knew the rig's position and nothing about the bay.

    **`describeNearestBay` is the answer to that, and it prints the four numbers that settle it**: the bay's name,
    its centre, its size, and **the horizontal gap from the rig to the bay's *footprint*** — clamped to the
    half-extents, so it reads `0.0` inside and the true distance outside, rather than the centre-to-centre figure that
    would call a rig standing comfortably inside a twenty-stud bay "ten studs away". **`Anchored` travels with it**,
    because an unanchored bay is a floor slab any body can shove and the tag's own contract never mentioned it.

    **The two candidate causes, and how one run tells them apart.** If the gap is non-zero and `Anchored` reads true,
    **the rig moved** — and the most likely reason is a movement tag: `Behavior_AlwaysSeeking` and `Behavior_Pickup`
    walk a rig to loose balls and the practice area stocks them, which is a rig leaving its own bay on purpose. If
    `Anchored` reads false, the **bay** moved and the fix is to anchor it. **A drill must stand still to stay in a bay**
    — that is a genuine constraint of the design and it belongs in any future spec for this feature.

    **The fault line is once per rig and the state lines are not**, and the split is deliberate: `reportedStray` holds
    the rigs already warned, because leaving the bay is a mistake to fix once and a rig that oscillates across its own
    edge would otherwise warn every second. The `standing down — nobody is in its bay` / `armed — <player> is in its
    bay` pair keeps every transition, because those two are what a person is actually watching for.

    *(Superseded by item 75 — `describeNearestBay` and `reportedStray` no longer exist. The reading above is what they
    established, and it is what made the rule change visible.)*

75. **The rule was wrong, and the Studio reading is what proved it: the rig never moved.** The Properties panel showed
    `Behavior_Throwing` at **`(52.111, 93.825, 541.974)`**, tags `Behavior_Respawn` + `NPC` + `practiceThrow`, pivot
    offset `(0, −3, 0)`. My own warn had printed its `HumanoidRootPart` at **`(52, 97, 542)`** — the same place, three
    studs up, exactly as the pivot offset predicts. **So the rig was never outside its bay because it wandered; it was
    never inside it.** The `standing down — nobody is in its bay` at boot means `bayOf` *did* answer with a bay once,
    and the honest conclusion is that the answer was never reliable — a part found once and not a second later, with
    the rig provably stationary in between, is a rule resting on a coincidence.

    **Which half of the rule was strict was the mistake.** The original asked two questions — *am I in a bay* and *is
    somebody in that bay* — and made both mandatory. **The user's requirement was only ever the second one**: *"they
    should ONLY throw when the player is in the bay."* The box is what a person painted to practise in; the rig is a
    fixture beside it, and requiring the two to be co-located made a drill work only in the layouts that happened to
    line up.

    **`targetFor(rig)` is now the whole gate and the whole aim**, and the rig's own bay is a *preference*:

    | order | rule |
    | --- | --- |
    | 1 | the rig's own bay (`bayOf`) — so two drills beside two boxes each take their own |
    | 2 | otherwise any bay, nearest to the rig first |
    | 3 | nobody in any bay → idle, countdown cleared, deadline forgotten |

    **Nobody in a bay is still the only thing that silences a drill**, which is the requirement verbatim, and this is
    *not* the `practiceZone` fallback that was rejected in item 74's neighbourhood — that one armed every drill in the
    area off one box around the whole floor. A bay is a small painted rectangle and a person outside every one of them
    is not being thrown at by anything.

    **Removed with the rule**: `describeNearestBay` (it existed to explain a rig being outside its box, which is no
    longer a fault), the `reportedStray` set (same reason), and `PracticeThrowBehavior`'s `no bay` warn. What is left is
    one pair of edge-triggered lines — `standing down — nobody is standing in a bay` and
    `armed — <player> is in <bay>` — plus the throw line, so **a drill that says nothing at all is a drill that never
    ticked**, which is a much better silence than the four-cause one it replaced.

    **The next session then showed the remaining failure was geometric and unreadable**: `[Drill] up — practiceThrow: 1
    rig(s), practiceBay: 1 tagged thing(s), 1 usable part(s)`, `[Zone] prospeed1: entered a practiceZone`, and no
    `armed` line afterwards — the box existed, was a `BasePart`, and **nobody was ever over it**. From the code's point
    of view that is indistinguishable from an empty bay, a missing tag, or a rig that never ticked, and it cost two
    sessions. **So the boot line now prints every bay's centre and size**, and the stand-down line prints the
    measurement itself — `nearestPlayerBayGap`, in `practiceBay.ts` — as
    *"prospeed1 is 40.2 studs outside "PracticeBay", which is centred at (52.0, 93.5, 542.0) with size 12.0×1.0×12.0;
    prospeed1 is at (48.0, 96.0, 500.0)"*. **Three pairs of numbers are enough to fix a misplaced box without another
    round trip**, which is the standard this project's diagnostics should be held to.

    **That line is keyed on the measured gap rather than on the latch**, and the distinction is load-bearing: a pure
    latch prints once at boot, when the player has no `Character` yet, and then says nothing for the rest of the
    session. A stud of movement reprints, so the line speaks the moment a body appears and stays quiet while somebody
    stands still.

    **Resolved 2026-10-26: the bay part was not anchored.** It was found on the first tick and had slid out from under
    the rig by the fourth, which is exactly the "not `Anchored`" case the diagnostic above was written to expose. No
    code changed for it — `practiceBay`'s tag contract does not mention anchoring, and it probably should: a bay is a
    floor slab, and every body that stands on one can move it.

76. **A practice zone is a place to practise catching now, not a place to stand.** The ball no longer passes through a
    practising player; it contacts them, tags them, plays the impact sound, sends `registerHit`'s `hitImpact` to every
    client, and can be caught inside the catch window. **The only thing suppressed is the health write**, which is one
    line at one site — and that single refusal is the whole of "no kills in a practice zone".

    *(The spec for this pass called it item 73. Items 73–75 are the three `practiceThrow` passes and are already
    written; item 72 is the drill itself. This is 76.)*

    **The veto that came out, and what it cost while it was there.** `BallComponent.handleTouch` refused the contact
    outright — `in a practice zone — carried on past them` — for a good reason that turned out to be the wrong half of
    the rule: the collision group stops the *bounce* (`PracticePlayer` against `Ball` does not collide) but a group does
    not suppress `Touched`, so without a veto a ball would sail through a practice player and *tag* them on the way.
    **What that made impossible was catching**: `canCatch` is only reachable from that funnel, so the one thing a person
    in a practice zone might want to work on was the one thing the veto forbade — and with no contact there was no sound
    and no impact effect either, so there was no evidence a ball had arrived at all.

    **The rule moved from the contact to the damage, and the two are now separate questions.** Everything up to and
    including the tag happens exactly as it does anywhere else; **a tag is not a death** — that is what this file's
    deferral is for — so tagging a practice player is simply the truth about a ball that touched them, and a catch can
    still take it back.

    | site | what it is | gate |
    | --- | --- | --- |
    | `BallComponent.landHit` | the ball's damage — the only place throw damage is written | `if (isPractising(character)) return;` before `TakeDamage` |
    | `RoundService.resolveCaughtThrower` | a **caught throw kills the thrower** — the second kill path, and the one nothing in the spec named | `!isPractising(thrower)` |

    **One helper, `isPractising(body)`, because there are two sites in two services** and a rule written twice is a rule
    that will disagree with itself the first time one of them changes. It lives in
    `services/zone/practiceZoneMembership.ts` — **a plain module rather than an export from `PracticeZoneService`,
    because importing the service file from `RoundService` created a service-to-service module edge that reordered
    Flamework's generated reflection manifest** without adding an entry to it. A predicate with no state does not need
    to live behind a decorator, and keeping it out of one keeps a generated file clean. It reads the published
    `PracticeZone` attribute rather than the geometry — the same trade the dodge gate, the catch prompt and the Freeze
    splash already make, and the reason it is not a bounds walk on a ball's landing. **It answers `false` for a rig on
    purpose**: the request was about a person practising, and a zone that silently made every NPC in it immortal would
    be a second rule nobody asked for. A drill's ball that misses its player and lands on a **rig inside the zone** still
    kills that rig, and `Behavior_Respawn` rebuilds it.

    **The alternative that was ruled out, recorded so the next session does not re-derive it: do not make the death
    *safe* — prevent it.** `SetStateEnabled(Enum.HumanoidStateType.Dead, false)`, a direct `Humanoid.Health` write, a
    `PlatformStand`, or any "safe damage" wrapper would all be a second state machine to debug, and every one of them
    leaves `Died`, `BreakJointsOnDeath` and the anchored-root anomaly still in play. **The gate stops `TakeDamage` from
    being called at all, so the victim's `Humanoid` never enters the Dead state** — which is the only reliable way to
    avoid the death-state bugs. A grep of the whole diff for `SetStateEnabled`, `BreakJointsOnDeath` and `PlatformStand`
    returns nothing, and the only `Health` mention added anywhere is the pre-existing `humanoid.Health > 0` guard with
    `&& !isPractising(thrower)` appended.

    **The catch-path gate is technically unreachable today and is still right.** `resolveCaughtThrower` already needs
    both ends to be in the round, and `teamOf` answers `undefined` for anybody standing in a zone — which is the guard
    item 75's predecessor records being added after a *"when alwaysCatchNPC catches my ball, I die"* report. What the
    new gate covers is the case that guard cannot: a player who already has a side **walks into** the zone mid-round
    and catches there. One attribute read per catch is the whole cost.

    **Freeze was checked and needs nothing.** `FreezeService` writes no health at all — it is a status, not a kill — and
    `BallComponent.splashSpares` already leaves practice players out of the splash. **Pierce and MultiBall were
    checked and need nothing** either: a Pierce ball cannot be caught and pierces rather than tags, and MultiBall
    supplies ordinary balls. `DevService` has no kill override.

    **Two consequences that are *not* fixed here, both verified in source and both reported rather than changed:**

    - **No impact VFX from a drill's throw.** `registerHit` sends `hitImpact` before the round gate, so the cosmetic
      half reaches a practice zone — but only when the thrower resolves, and `throwerOf`'s rig arm walks
      `rigsInRound()`, a `Playing`-gated list. A drill throwing during intermission has no resolvable name, so no
      payload is sent. The **sound** does fire (`playImpactSound` at the contact, ungated). Making the VFX appear means
      either resolving a rig outside a round or sending a payload with no thrower — both a decision, neither asked for.
    - **No `CATCH IT!` prompt for a practising player.** `catchPrompt.refresh` shows the word when the ball's
      `BALL_TAGGED_TEAM_ATTRIBUTE` equals the local player's `Team`, and a practice player has no team, so the tag
      writes `""` and the prompt's off state is permanent. **The catch itself works** — `canCatch` asks only about the
      ball's ability and the player's window — but nothing tells them when to press. The drill's `3 2 1` countdown is
      the timing cue in the meantime.

77. **A drill could not be named, so half of item 76 was invisible and the other half did not fire.** Two symptoms, one
    cause: `throwerOf` resolved a rig only by walking `rigsInRound()`, which returns `[]` unless a round is `Playing`.
    A `practiceThrow` drill throws during an intermission, so:

    - `registerHit` sent no `hitImpact` (the send is `if (thrower !== undefined)`), so a drill's hit on a player drew
      **no VFX** — the tag and the impact *sound* fired, which is why it read as "the hit works but nothing shows";
    - `resolveCaughtThrower` had nobody to punish, so a caught drill ball **cost the drill nothing**.

    **The identity on the ball is a token, not a name — the spec for this pass said `Name` and that is wrong.**
    `BallService.throwBall` writes `ThrowerId = tokenOf(model)`, and `tokenOf` returns the model's `THROWER_TOKEN`: a
    `UserId` as text for a player, a GUID for a rig. So route (a) was taken **but matching on the token**, exactly as the
    round's own arm already does. Matching on a name would have been a second, weaker identity that a renamed rig or two
    rigs sharing an alias would get wrong.

    **`drillOf(throwerToken)` is the new arm, and it is deliberately narrow**: `CollectionService.GetTagged(PRACTICE_THROW_TAG)`,
    filtered to a `Model` in `Workspace`, matched on `THROWER_TOKEN`. **Only a rig wearing the tag** — a plain `NPC` rig
    must not become the attributed thrower of a ball that hit somebody in the lobby, because `hitVfx` draws per role from
    the two names and a made-up attacker draws a burst on the wrong body.

    **`throwerOf` now falls through to it, and the breadth of that is bounded by its other callers**, which is worth
    recording because widening a resolver is the kind of change that bites from the side:

    | caller | what the drill arm changes |
    | --- | --- |
    | `registerHit` | **the fix** — `hitImpact` now sends, so the VFX draws |
    | `resolveCaughtThrower` | nothing on its own; see the ordering note below |
    | `isFriendlyFire` | nothing — it returns `false` before that unless a round is `Playing`, and a drill has no side |
    | `BallComponent.score` | nothing — it follows with `isActive`, which is still `rigsInRound`'s question, so a drill's hit records a career hit and **never a run** and never grows the crown |

    **The catch needed the branch placed above the phase guard, and that is the subtle half.** Even with `throwerOf`
    resolving the drill, `resolveCaughtThrower`'s first line is `if (this.state !== RoundState.Playing) return;` — and a
    practice catch happens during an intermission, so the rig would still never have died. **`drillOf` is therefore asked
    before any round guard**, and the drill branch pays the cost and returns: no score, no side, no `LAST_HIT_BY_*` (a rig
    has no client to read them).

    **`killCaughtDrill` uses `TakeDamage` and nothing else**, on exactly the terms the round's catch death does — `Died`
    fires, `NpcService` ends the loop and calls `onDied` on every behaviour, and `Behavior_Respawn` rebuilds the body at
    its post, which is the same door a landed ball sends a rig through. It also sends the **existing** `caughtThrow`
    event, because `client/hitVfx.ts` already draws red on a thrower's body from it and resolves that body *by name* —
    its own doc records the rig case as "nearly every catch in a round against rigs". **No client change was needed and
    none was made.**

    **The practice gate is not asked in the drill branch, deliberately.** `isPractising` spares a *player*; this branch is
    only ever reached for a rig, which is never practising. A rig caught between rounds dies inside a practice zone or
    out of it, which is what keeps "no deaths in the zone" a rule about people rather than a haven for every body on the
    floor.

    **A caught drill ball does not leave a loose ball behind.** `BallService.catchBall` → `attachToHand` welds it to the
    catcher's hand, so it leaves `Workspace` and `settleLooseBalls` (which only walks balls whose parent *is*
    `Workspace`) never sees it. Its `THROWN_FROM_BAY_ATTRIBUTE` marker survives the catch, and that is fine in both
    directions: if the player *drops* it, the ball returns to `Workspace` and the bay-edge rule destroys it as any drill
    ball; if they *throw* it, `throwBallBody` clears the marker because the thrower does not wear `practiceThrow`. See
    item 76's ball half.

78. **Every shop purchase is behind an "are you sure?", and the send is now unreachable without one.** A tester bought
    something by accident: pressing a tile or the chest button fired `purchaseCosmetic` / `openPowerChest` on the *single*
    click, and there is no refund path. So the button now arms a dialog and only `ShopController.confirm` reaches the
    server.

    *(The spec called this item 77; 77 is the drill-identity pass and 76 the practice zone. This is 78.)*

    **Two call sites, both moved, and the payloads are unchanged.** `requestChest` still sends `SendToServer()` and
    `requestPurchase` still sends `SendToServer(def.id)` — the emitted Luau is checked for exactly those two lines and for
    the fact that neither is reachable except through `confirm`. **The pending action is a discriminated union**
    (`{ kind: "chest"; cost } | { kind: "cosmetic"; def }`) captured at the press, **not re-derived from the current tab**
    when the dialog is confirmed: the player can switch tabs behind a modal, and a confirm that asked "which tab am I on"
    would buy something they were not looking at.

    **The dialog is a sibling of the panel in `HudGui`, not a child of it**, and that is the load-bearing choice. A child
    would be clipped by the content band's `ClipsDescendants` and could not dim the panel it was drawn inside. It is built
    once at mount and toggled with `Visible`, and it lives in `ui/confirmModal.ts` rather than in
    `ShopController` — see the forward note below for why that address is the right one.

    **`MODAL_Z_INDEX = 20` is a rung of its own, and §15 item 63 is why that is written down.** `ZIndex` is compared
    flattened across the `ScreenGui`, so the overlay only has to beat `PANEL_Z_INDEX` (10) — but `raiseZIndex(overlay, 20)`
    is called **after the whole tree is built**, because a child below its parent's number draws *behind* it. That is
    exactly the stats board's bug one generation on, and the reason nothing in this dialog is created after that call: the
    title and the message are `Text` labels whose *text* changes reactively and whose instances never do.

    **`addPanelFrame` was the wrong builder and the reason is its size** — it hardcodes `SHOP_CONFIG.PANEL_SIZE`, 62 % by
    72 % of the screen, because it exists to be *the* panel. A confirmation at two thirds of the screen reads as a second
    shop. What is reused is everything that is not the size: `addElevation` for the shadow, `raiseZIndex` for the layering,
    `SHOP_CONFIG`'s padding and gap, and the same `lightPanelTheme`.

    **The backdrop is a `TextButton`, and so is the dialog, and both are deliberate.** Only a `GuiButton` *consumes* input
    — a `Frame` lets the click fall through to the shop's tiles underneath while the player believes the dialog is
    blocking them. The dialog is a `TextButton` with `AutoButtonColor = false` and no action for the same reason read the
    other way: a `Frame` would let a click on the dialog's own face reach the backdrop and cancel the question the player
    was in the middle of reading.

    **Confirm is the palette's `success` green and Cancel its `error` red**, and neither needed a `**Placeholder.**` colour:
    `lightPanelTheme` already carries both, and the shop already uses `error` for its close button and `success` for a won
    item. Blue was refused — it is the panel's *selected* state, so a blue Confirm would read as "this tab is open".

    **Double-click protection is big-ui's own `loading` prop**, which is documented as showing a spinner *and blocking
    activations*, and is `UsedAs<boolean>` so it can react. It is raised the instant Confirm is pressed and cleared in
    `ask` rather than on a reply — so the answer to "when does this re-arm" is "when there is a new question", not
    "sometime after a reply that may never arrive". A `disabled` prop would not have worked at all: big-ui reads its props
    at construction.

    **What was checked and left alone.** The inventory's two remotes are `equipRemote` (wearing a cosmetic) and
    `poolRemote` (a chest-pool toggle) — **neither spends anything**, so neither gained a dialog. No server file, no
    economy config and no remote changed.

79. **A rig hit by a ball kept walking on the spot, and it is the mechanism §15 item 52 named and left standing.**  **REVERSED by item 104** — the watchdog this item added is deleted, along with the reading it corrected; a shoved rig was never asked to walk and now simply stands.
    `Humanoid.Running` is an edge on a *speed*; `Humanoid.MoveToFinished` is an edge on a *walk*. **A physics shove is
    neither** — a ball moves a planted rig, the engine reports a change of speed, and nothing follows, because no walk
    was issued and so no walk can finish. The rig keeps that speed for the rest of its life and every client draws it
    walking where it stands.

    **The `practiceThrow` drill is what surfaced it.** A drill issues no `MoveTo` at all, so `MoveToFinished` can never
    fire for it however long it lives; the older rigs masked the fault because they walk constantly and every walk ends
    on an edge that also clears it. Item 52 predicted the failure and item 53 fixed the parts of it that had an edge;
    this closes the part that has none.

    **`watchForStaleWalk` runs from `publishAnimationBody`**, which is the per-rig turn the loop already takes at
    `THROW_TICK_SECONDS` (0.1 s) — no new loop, no `Heartbeat`. It compares the body's **`AssemblyLinearVelocity`**
    against `NPC_CONFIG.RIG_STALE_WALK_SPEED` and calls the existing `clearWalk` once the body has been still for
    `RIG_STALE_WALK_TURNS` in a row.

    | decision | value | why |
    | --- | --- | --- |
    | which velocity | `AssemblyLinearVelocity` | `Humanoid.MoveDirection` is the property `Humanoid:Move()` writes and reads **zero** for every rig here — item 52's own recorded finding — and it is the wrong kind of fact anyway: a shoved body has no intent to move |
    | horizontal or whole vector | **whole** | a rig knocked into the air has near-zero horizontal travel for its entire arc, and "measured still" is read by the publisher as *standing*, which would fire the `off the floor while standing` line and dress a falling body as standing on its feet |
    | threshold | `1` stud/s | `**Placeholder.**` Below every walk in the game (`WALK_TO_PAD_SPEED` is 16) and above every decay curve's tail |
    | debounce | `3` turns = 0.3 s | `**Placeholder.**` The engine accelerates a real walk from a standstill, so the first turn of one legitimately reads near-zero; without the debounce the watchdog would flicker `AnimMoving` at the top of every walk |

    **`stillTurns` is reset the moment the body travels again**, so the count is consecutive by construction and a rig
    nudged repeatedly cannot accumulate its way to a false stop. **The `Running` subscription is untouched** — the pair
    is complementary, and a body setting off again re-asserts through that edge.

    **It costs a standing rig nothing**: the first branch returns before any velocity read, so the ordinary rig pays one
    number comparison per turn, and only a rig already published as walking pays the `AssemblyLinearVelocity` read.

    **One behaviour is deliberately changed, and it is the other half of item 52's note: a rig pressed into a wall now
    stops animating after 0.3 s instead of walking on the spot until `MoveToFinished`'s eight-second give-up.** Item 52
    defended the old reading as "the allowance Roblox's own script gives a player pushing a wall"; the honest reading is
    that a body animating travel through ground it is not moving across is the same fault as a shove read as a walk.
    The essay in `publishAnimation` that argued for it is corrected rather than deleted, and the direction of the error
    is unchanged — the watchdog can only ever publish a moving rig as standing, never the reverse.

    **New line, once per rig** through `clearWalk`'s existing once-only print:
    `[NPC] <name>: the body had stopped travelling with the speed still N.NN studs/s — published as standing from
    here`. The `why` is its own phrase so a log distinguishes a walk that ended from a body that was never walking —
    a behaviour's bug from a physics one.

    **Unverified**: that a shoved drill really does get a `Running` edge. Nothing in a server log shows the
    `AnimMoving` attribute itself, so the proof is the user's eyes plus that line appearing once per rig after a hit.

80. **Why a bounced ball cannot be caught: `Armed` goes false on the first non-body contact, and `handleTouch` returns
    on it before the catch branch is ever consulted.** The report was *"it bounces off the rig but has not hit the
    ground, and the catch never works"*. The answer is **Hypothesis A, in a stronger form than the hypothesis states** —
    the tag is not merely *cleared* making `canCatch` false; the ball is **taken out of play**, and the guard that does
    it is the first line of the method.

    | where | what it is |
    | --- | --- |
    | `BallComponent.handleTouch:300` | `if (instance.GetAttribute("Armed") !== true) return;` — **the whole method**, including the catch branch, is behind this |
    | `:454` | `this.instance.SetAttribute("Armed", false)` — the last line of the world branch, after `resolveTags` |
    | `:426` | `resolveTags(throwerId)` — the world branch is where every tag becomes a death |
    | `:779` | `this.bounceOff(struck)` — **the bounce off a body, which does *not* disarm** |

    **So the two bounces are not the same event, and that distinction is the whole diagnosis.** A ball that touches a
    **body** is tagged and deflected and stays armed — it is still catchable. A ball that touches **anything else** — the
    floor, a wall, a prop, another ball once it owes a tag — runs the world branch, resolves its tags and disarms, and
    from that instant no `Touched` can reach `canCatch`. That is by design (`handleTouch`'s own doc: *"It is the next
    contact that is not a body that ends the throw"*), so a "bounced ball" is catchable **only if it bounced off a body
    and has touched nothing else**.

    **Hypotheses B and C are false, and both are verifiable rather than argued.**
    - **B — the window closes on a bounce.** The window is `CatchService`'s own `os.clock()` expiry keyed on the
      *character*, opened by `attemptCatch` and read by `isCatching`. Nothing on the ball's path writes it, so a bounce
      cannot shorten it.
    - **C — the practice zone or a team check refuses.** `CatchService` contains **no reference** to `isPractising`,
      `PRACTICE_ZONE_ATTRIBUTE`, `TEAM_ATTRIBUTE` or `isFriendlyFire`. `BallComponent.canCatch` reads the ball's
      ability, its parent and the window — no team, no zone. The one `TEAM_ATTRIBUTE` read in the file (`:657`) *writes*
      `BALL_TAGGED_TEAM_ATTRIBUTE` for the client's `CATCH IT!` prompt; it is display and never a gate.

    **The prompt's own warning is the other live candidate and is now traceable**: a `practiceThrow` ball carries
    `THROWN_FROM_BAY_ATTRIBUTE`, and `settleLooseBalls` destroys it the first tenth of a second it is outside every bay —
    **airborne or not**. If that is what is happening, the fix is in the despawn timing and not in the catch path at all.

    **The trace, which is the deliverable and not the fix.** Two `TRACE_CATCH` constants — one in `BallComponent`, one in
    `CatchService`, both `true`, both marked TEMPORARY — plus one line in `BallService.settleLooseBalls`. Every early
    return on both sides now names itself:

    ```
    [Catch] <ball>: NOT catchable — out of play (Armed not true), touch on a body (X)     ← hypothesis A, ball side
    [Catch] <ball>: refused for X — not in the world (parent …)                          ← in somebody's hand
    [Catch] <ball>: refused for X — no catch window open                                 ← timing
    [Catch] X: REFUSED — a ball is already in hand (…)                                   ← a full hand cannot catch
    [Catch] X: REFUSED — still in the catch cycle, 0.62s to go                           ← a second press does nothing
    [Catch] X: REFUSED — catch blocked (frozen, dodging, or just dodged)
    [Catch] X: window OPENED for 0.60s — waiting for a ball to touch                     ← the input was accepted
    [Catch] <ball>: DESTROYED mid-air at the bay edge — Armed true, 22 studs/s           ← the despawn suspect
    ```

    **Read the pair together**: `window OPENED` with no ball line means the input was fine and no eligible ball arrived
    inside the window; `NOT catchable` means the ball was already spent. **Removal is one boolean per file.**

    **Diagnosis pending a live log.** Nothing here is confirmed in Studio.

81. **"Can I catch my own ball after it bounces off a rig?" — no. `BallComponent.handleTouch:531` refuses it, and the
    code says why in the comment above that line. The bounce physics, on the other hand, do allow the ball to come
    back.**

    **The rule is the thrower-token comparison, and it sits one branch above the catch:**

    ```
    :513  const struck = this.struckBodyPart(humanoid, otherPart);
    :529  const throwerId = this.instance.GetAttribute("ThrowerId");
    :530  const token = character.GetAttribute(THROWER_TOKEN);
    :531  if (typeIs(throwerId, "string") && throwerId !== "" && throwerId === token) return;   ← the block
    :549  if (this.canCatch(struck, character)) { … }                                          ← never reached
    ```

    **It returns silently, above `canCatch` — so a self-catch is not "refused with a reason", it is unreachable.** And
    the comment at `:522` shows this exact scenario was considered when it was written: *"Nobody is hurt by their own
    ball, and nobody catches it either — **including off the rebound**, which is the case that matters now that balls
    come off people."*

    **Nothing else blocks it, and each was checked rather than assumed:**

    | rule | verdict |
    | --- | --- |
    | `CatchService.attemptCatch` | **no thrower check at all** — living humanoid, free hand, `blocksCatch`, cycle, then open. It never sees a ball |
    | `isFriendlyFire` | irrelevant — it is at `:602`, *after* both `:531` and `canCatch`, so a self-contact never reaches it |
    | `PICKUP_LOCKED_UNTIL` (2.0 s, `DROP_PICKUP_LOCKOUT`) | **not a catch rule.** Stamped by `makeInert` on a *dropped* ball and read by `BallPickupService`; the catch path does not read it |

    **The physics do return the ball.** `bounceOff` reflects the velocity about the unit vector from the **part's centre
    to the ball** — a deflection rather than a surface mirror — and multiplies by `BOUNCE_FACTOR = 0.7`. A ball arriving
    at a rig's front face has its `separation` pointing back at the thrower, so the reflection sends it back along its
    approach at 70 % of the incoming speed. **It does not drop.** Two gates and gravity limit it: `BOUNCE_MIN_SPEED`
    and `BOUNCE_MIN_SEPARATION` both return *without* bouncing, and at the 46 studs the drill throws from, a ball at
    0.7 × speed is very likely to meet the floor first — which disarms it anyway (item 80).

    **So the answer is a rule, not a physics limit — and at drill range the physics would usually have decided it too.**
    This is recorded as a decision rather than a bug: `:522`'s comment already argues it, and the argument holds (a
    player who can catch their own throw has a free re-arm). **The prompt's premise that catching has an 8-stud radius
    is false**: there is no radius anywhere in the catch path — `CATCH_CONFIG` carries only `WINDOW_SECONDS` (1) and
    `CATCH_ANIMATION_SECONDS`, catching is `Touched`-only, and no client assist measures distance.

    **One trace line added, because item 80's trace was blind to this guard**: `:531` is a bare `return`, so the whole
    scenario produced no output at all — indistinguishable from a ball that never came back. It now prints
    `[Catch] <ball>: refused for <name> — it is their own throw`, under the same `TRACE_CATCH` flag.

82. **Item 81's answer was a rule, and the rule is now split: you can catch your own rebound and still cannot hurt
    yourself with it. Plus an eight-stud catch radius, and five seconds of grace before a drill's ball dies.**

    **1 — the self-catch split.** The thrower-token comparison is no longer a `return`; it is a flag, and the thrower's
    contact now offers the catch before refusing everything else:

    ```
    if ownThrow then
        if self:tryCatch(character, struck) then return end   -- the catch
        return                                                -- no damage, no tag, no bounce
    end
    ```

    **The ordering is the whole of it.** A thrower with an open window takes the ball; one without falls through to the
    `return` and the ball passes through them exactly as before — no tag, no damage, no bounce. **Falling through into
    the tag branch instead would let a player kill themselves with the one ball the game promised they could not.** The
    old comment argued *"nobody catches it either — including off the rebound"*, and that half is now wrong; it is
    rewritten rather than deleted, with the playtest reason in it (a rebound you can take back is the best thing the
    throw does; refusing it reads as the game snatching the ball away).

    **Cannot be a shield**: a self-catch spends the window through `tryCatch` → `consume`, so it costs the same second
    and takes the same one ball.

    **2 — the eight-stud radius.** `CATCH_CONFIG.CATCH_RADIUS_STUDS = 8` (**Placeholder.**), searched by
    `CatchService`'s one `RunService.Heartbeat` and executed by `BallService.catchByProximity`.

    | decision | choice | why |
    | --- | --- | --- |
    | where the loop lives | `CatchService`, **one connection for the service** | a `task.spawn` per press is a thread per catcher per press with its own cancellation problem, and a window can be *extended* rather than reopened — the loop asks `this.windows` instead, so `size() === 0` is the entire idle cost |
    | what it iterates | the open **windows**, not `Players` | work scales with how many people are pressing catch |
    | where the handler lives | `BallService.catchHandlers`, registered by `BallComponent` | resolution needs the *component*; asking Flamework for it from a service is an instance→component lookup this project uses nowhere and which would tie a table it could own to a framework API |
    | how the catch executes | `BallComponent.tryCatch` — **one method, both doors** | the `Touched` branch and the radius branch must spend the window, attach, credit the badge and resolve the thrower in one order; a second copy in `CatchService` is the pairing this project has already paid for once |

    **`canCatch` gained an `Armed` test, and it is not redundant.** The `Touched` door is behind `handleTouch`'s own
    `Armed` guard; **the proximity door is not**, so without it an eight-stud radius would sweep up any spent ball lying
    on the floor beside a catcher — a player picking a ball up off the ground by pressing catch while looking at the sky.
    `canCatch` is where both doors pass, so the rule is stated there.

    **3 — the bay despawn grace.** `NPC_CONFIG.BAY_DESPAWN_GRACE_SECONDS = 5` (**Placeholder.**) and a
    `BallService.leftBayAt` map. The ball is stamped the first sweep it is seen outside every bay; the entry is deleted
    the moment it is back inside one or the moment it leaves `Workspace` (caught, held, parked), and the destroy fires
    once the deadline passes. **Not an attribute**: how long a ball has been outside a bay is a rule the client does not
    run, and an attribute would replicate a number nobody reads. **`os.clock` and not `GetServerTimeNow`**, the one
    deviation from the idea that produced it — that clock exists for deadlines crossing the wire, this one never leaves
    the server, and the sweep it lives in already runs on `os.clock`.

    **The three interact by design rather than by luck.** The grace period is what makes the radius able to catch a drill
    ball at all (before it, the ball died a tenth of a second after crossing the bay edge); the radius is what makes the
    self-catch reachable (a rebound that comes back near the thrower but not into them); and the self-catch is reachable
    at zero studs as well, through `Touched`, because the token guard no longer returns before `canCatch`.

    **Trace**: `[Catch] <name>: caught by PROXIMITY — within 8 studs`, `[Catch] <ball>: refused for <name> — not armed
    (the throw is over)`, `[Catch] <ball>: own throw reached <name> — no window, no damage`, and
    `[Catch] <ball>: DESTROYED N.Ns after leaving the bay`. The bay line has its own flag (`TRACE_BAY_DESPAWN`) so the
    settle loop can be silenced without touching the other two.

    **Unverified**: that eight studs feels right, and that a proximity catch reads as a catch rather than a vacuum.

83. **A catch no longer teleports the ball into the hand. It is pulled there, and the weld happens on arrival.**
    The report was *"when I catch or pick up a ball it snaps to my hand in one frame — it looks like a teleport"*.
    `attachToHand` wrote the ball's `CFrame` to the grip and welded it, both in the frame the catch was decided, so
    the ball was in two places in two frames with nothing in between. It is now **three phases — decide, pull,
    weld** — and only the middle one is new.

    **Phase 1, decide, is unchanged and still authoritative.** `BallComponent.tryCatch` spends the window, calls
    `BallService.catchBall`, credits the badge and resolves the thrower, all on the frame of the contact.
    `catchBall` answers `true` for "a ball has been caught", which is what it answered before; the only refusal that
    still answers `false` is a body with no right hand, because that one falls straight through `beginPull` into
    `attachToHand` and is refused there. **Nothing about a catch waits for the ball to arrive** — a drill still dies
    on the decide frame, and a catch that resolved on the weld would let it live another fifth of a second and make
    the outcome depend on geometry the decision had already stopped caring about.

    **Phase 2, pull, is one `AlignPosition` and one map.** `BallService.pulling` is a `Map<BasePart, Pull>`;
    `beginPull` creates an `Attachment` on the ball (at `Vector3.zero`) and an `AlignPosition` beside it, puts the
    ball in the map, and returns. A single `RunService.Heartbeat` — `pumpPulls` — walks the map every frame.

    | decision | choice | why |
    | --- | --- | --- |
    | `AlignPosition` mode | `OneAttachment`, target written into `Position` | `TwoAttachment` needs a second `Attachment` parented to a **body part that can be destroyed mid-pull** — a catcher dying during a catch is exactly the leak this feature has to avoid — and buys nothing, because the arrival test already reads the hand's position every frame. One instance, on the ball, dying with the ball |
    | the loop | **one `Heartbeat` over the map** | a `task.spawn` per catch is a thread per catch with its own cancellation problem; `pulling.size() === 0` is the entire idle cost of having none in flight |
    | arrival | **distance *and* timeout** | `PULL_ARRIVAL_STUDS` 1.5 ends an ordinary pull; `PULL_TIMEOUT_SECONDS` 1.5 is the fail-safe, because `AlignPosition` applies a *force* and a ball behind geometry would otherwise never arrive. A caught ball hovering in the world forever is worse than a snap |
    | target freshness | rewritten every frame | a catcher walking, or one whose idle animation moves the arm, is a target that moves under a constraint told where to aim once |
    | the pull's numbers | `MaxVelocity` 60, `Responsiveness` 30, `MaxForce` 10000, `RigidityEnabled = false` — all **Placeholder.** | 60 studs/s is the visible travel (eight studs in about an eighth of a second); 30 closes the remaining distance briskly without overshooting into a visible vibration; 10 000 beats gravity and a ball's own momentum but still loses to an anchored wall, which is what the timeout answers. `RigidityEnabled` would make it a teleport with extra steps |

    **Phase 3, weld, is the old path untouched.** `completePull` destroys the constraint and the attachment *first*
    (so nothing is left on a ball that is about to be re-parented into a hand) and then calls `attachToHand`, which is
    still the only way into a hand: grip offset, `WeldConstraint` named `DodgeballGrip`, `Massless`, no query, ability
    cleared, `heldBalls` entry. **The pull changed where the ball is when that runs, and nothing else about it.**

    **The one behaviour that moved, and it should be watched.** The catch *sound* and the `AnimCatch` mark used to be
    published on the decide frame; they are now published on the weld frame, because the sound is the ball *landing* in
    a hand and a reach that started at the decision would be a body grabbing at something already in its hand. The
    delay is the pull, at most a fifth of a second, and reads as the reach following the ball in. `PICKUP_COUNT_ATTRIBUTE`
    moved with them, for a harder reason: a count of balls *in a hand* must not be moved by one still in the air.
    **Item 84 reverses the sound and keeps the mark**: heard in the game, "the ball landing" reads as a delay between
    pressing and hearing, so the sound is emitted on the decide frame again and only the reach still waits for the
    arrival it is a picture of.

    **A ball mid-pull is not a loose ball, and that is two skips rather than one.** `settleLooseBalls` skips it (the
    bay grace would otherwise destroy it mid-flight, and the rolling resistance would fight the constraint for the same
    body), and `catchByProximity` skips it. **The second is not redundant with `canCatch`'s `Armed` test**: the window
    is spent for the *original* catcher, but a **second** player with an open window would otherwise be able to take a
    ball already travelling to somebody else's hand. `Armed` going false at the start of the pull closes both doors;
    the skip is the cheap half, one map lookup before the distance sum on a loop that runs every frame.

    **The leak, named, because it is the classic "invisible force" bug.** An `AlignPosition` on a re-parented or
    destroyed ball keeps dragging it toward a hand that no longer exists. **An entry's lifetime is exactly its
    constraint's**: `clearPull` is the single teardown and both exits call it, `pumpPulls` checks `ball` and
    `pull.hand` for `IsDescendantOf(Workspace)` every frame and *abandons* rather than completes, and `beginPull`
    refuses a ball already in the map so no second constraint can be made. An abandoned ball is left loose, unarmed,
    collidable — a ball somebody can pick up again — rather than destroyed, because nothing about the failure is the
    ball's fault.

    **Nothing here touches the trajectory preview or `CHARGING_ATTRIBUTE`.** The preview solves `shared/throw.ts` from
    the thrower's hand at the moment of a throw; a pull moves a ball toward a hand *after* a catch, when there is no
    charge and no aim to disagree with.

    **Comments corrected in the same pass, because they argued for the old shape**: `BallComponent.canCatch`'s *"the
    refusal has to sit above the weld"* (now above the *pull*, and the weld's ability clear is a fifth of a second
    later), `BallComponent.resolveCatch`'s *"after `catchBall` has taken the ball into the catcher's hand"*,
    `CATCH_ANIMATION_ATTRIBUTE`'s list of callers, `SOUND_CONFIG.CATCH`'s *"where exactly"*, and
    `BallService.catchBall`'s whole essay about being the confirmation site — which is now `completePull`'s.

    **Unverified**: whether the pull *feels* right, whether the ball arrives at the hand or overshoots it, and whether
    a fast catch (a ball at 90 studs/s, turned around by `MaxForce` 10 000) still reads as a pull rather than a snap.
    The numbers are the ones to move if it does not.

84. **The pull was fighting the wrong thing. A caught ball now stops dead, a ball caught on the body is welded on the
    spot, the numbers came down, and the catch sound moved back to the frame the catch is decided.**
    The report was *"the ball bounces off the rig and the radius yanks it back — like a yo-yo"*, plus *"floaty when far
    away"* and *"the sound plays late"*.

    **The prompt's diagnosis was wrong, and the correction is the whole pass.** It said physics pushed the ball away
    and the constraint reeled it back. `bounceOff` never runs on a catch: the catch branch sits **above** the tag branch
    in `handleTouch` (`BallComponent:594` vs `bounceOff` at `:830`), so a caught ball is never bounced. What actually
    happened is the opposite — the pull sets `CanCollide = false` and then asked an `AlignPosition` *force* to beat the
    ball's own momentum. **A force cannot arrest ninety studs a second inside one frame**, so the ball carried straight
    *through* the catcher and was dragged back out from behind them. That is the yo-yo, and no amount of gain fixes it.

    **1 — the ball stops dead before the constraint takes over.** `beginPull` now writes
    `AssemblyLinearVelocity`/`AssemblyAngularVelocity` to zero alongside `CanCollide = false`. The honest statement:
    the ball has been caught, so it is not travelling anywhere. Every pull is then the same shape — a ball at rest,
    dragged to a hand — and this is why `PULL_MAX_FORCE` could be halved rather than raised.

    **2 — a catch with no journey to draw is welded where it is.** Two conditions, one branch, because they are one
    rule:

    | condition | why |
    | --- | --- |
    | `instant` — `tryCatch`'s `contact === "touch"` | the ball is *on* the catcher; there is nothing to animate, and this is the case that produced the yo-yo at zero studs |
    | `≤ PULL_INSTANT_STUDS` (3) from the hand | a proximity catch at six studs is nearly as bad and the contact door cannot have caught it. Three studs is a body's width: below it a weld is a ball settling, above it there is real travel |

    `tryCatch` gained `contact: "touch" | "proximity"` — **which door**, which is the one thing the two callers know and
    the ball does not. The word is translated to `instant` exactly once, at the `catchBall` boundary, where "how it
    arrived" stops mattering and "must not travel" starts.

    **3 — the numbers came down, and the ratios are the point.** `PULL_MAX_VELOCITY` 60 → **45**,
    `PULL_RESPONSIVENESS` 30 → **20**, `PULL_MAX_FORCE` 10 000 → **5 000**, `PULL_TIMEOUT_SECONDS` → **0.5**
    (**Placeholder.** at each). Velocity and responsiveness multiply, so a ball dragged fast *and* corrected hard
    arrived in two frames and the travel was invisible — "floaty" was a ball that reached its ceiling immediately and
    then drifted. The timeout is set from below by the velocity: 45 studs/s over eight studs is 0.18 s, so half a second
    is nearly three times the worst honest journey and still a *filter* rather than a duration.

    **4 — the catch sound moved to the decide frame.** It was emitted in `completePull`, on the argument that the sound
    is the ball landing in a hand. In the game that reads as a delay between pressing and hearing. It is now emitted by
    `tryCatch` immediately after `catchBall` answers, at **the ball's position** — for a proximity catch up to eight
    studs from the hand — through `BallService.emitCatchSound`, a one-line command that keeps `CATCH_EMITTER_NAME`
    beside the sound it names. **`markCatchAnimation` deliberately stays on the weld**, because the reach is a picture
    of the ball arriving, not of the press.

    **5 — the trace found the log, and that was the other finding of the pass.** `[Catch] … NOT catchable — out of
    play (Armed not true), touch on …` printed on **every touch of every spent ball** — a ball rolling through a crowd
    of rigs is several lines a frame, forty a second, forever. The pass's own log is roughly nine hundred of those to
    thirty useful lines. **It now prints only when the body it touched has an open catch window**, which is exactly the
    case worth asking about: a spent ball touching somebody who is *trying* to catch it. `TRACE_CATCH` still gates it,
    and the other two catch lines are untouched.

    **Nothing here touches the trajectory preview, `CHARGING_ATTRIBUTE`, the bay grace, or the catch decision's timing.**
    The drill still dies on the decide frame; `catchByProximity` and `settleLooseBalls` still skip a ball in `pulling`.

    **Unverified**: whether 45/20/5 000 reads as *snappy but visible* rather than as a small teleport; whether a
    three-stud instant weld is invisible in play; and whether the sound now arriving on the press makes the weld look
    late instead of the sound — the two cannot both be early, and only a player can say which one they notice.

85. **A caught ball's trail now stops where it was caught and fades out, instead of vanishing in one frame.**
    The report was *"the trail cuts out mid-air when I catch"*.

    **The cause was one word in a comment, and the comment was wrong.** `BallTrail.setArmed`'s doc said disabling a
    trail leaves its existing segments "to expire on their own lifetime", so a caught ball's trail *faded* where it was
    caught. `Trail.Enabled` is documented as *whether the trail will be drawn* and that is the whole of it: off is
    off, immediately. So the arc the ball flew in on disappeared on the frame the catch was decided, and the ball that
    arrived in the hand had no trail either — a throw's entire visible history gone at once, at the moment the player
    had just done something they liked.

    **The prompt's recommended shape — clone the trail onto a ghost part — cannot work, and the reason is worth
    keeping.** A `Trail` draws the path *it* recorded, and that path is engine state belonging to the instance.
    `Clone()` copies the eight properties and none of the history, so a cloned trail on a fresh part draws nothing at
    all. **The only thing that can go on drawing an arc is the ribbon that drew it**, which is why the ribbons are
    *moved*.

    | decision | choice | why |
    | --- | --- | --- |
    | what is frozen | the ball's own ribbons, with their own attachments, re-parented to an invisible part posing at the ball's `CFrame` | a clone has no history; a move keeps the instance that owns the arc |
    | enabled or disabled on the ghost | **enabled** | a stationary enabled trail records only zero-length samples, which `MinLength` refuses, so nothing new is drawn and the recorded segments age out over each layer's own `Lifetime` — core in `TRAIL_LIFETIME`, haze in `TRAIL_HALO_LIFETIME`, so the haze outlives the streak exactly as it does in the air. Disabling is the cut this pass exists to remove |
    | where it is called | `BallService.beginPull`, `kind === "catch"` | the single funnel both catch doors pass through, **and the last frame before anything moves the ball**: an instant weld teleports it on that same frame, a pull starts dragging it on the next. A trail still on the ball would draw the journey into the hand and then be cut by the weld |
    | pickups | not frozen | a ball off the floor has been lying still with its ribbons disarmed since it landed — there is no arc to preserve, and a holder would be a part parked to draw nothing |
    | cleanup | `Debris.AddItem(holder, longestLifetime + 0.5)` | the holder outlives every segment by half a second, so the fade is never cut off at its tail. `FROZEN_TRAIL_GRACE` is a module const and not config: it is not a look |
    | naming | `FrozenTrail`, a part in `Workspace` | the house rule from `CATCH_EMITTER_NAME`: a part parked with no owner is findable in the Explorer only by its name, so "no frozen trails remain" is checkable |

    **The attachments move with the ribbons and are not copied, which is the detail that keeps a ball clean.** The next
    hand to hold the ball builds a fresh set of ribbons under the same names, so leaving the old attachments behind
    would put a second `FlightTrailA0` on every ball that had ever been caught. Moving them instead means the ball is
    left with nothing, and `ribbonsOf` answering "empty" is what lets `BallTrail.attach` build rather than adopt.

    **This also fixes the pull's other half.** During a pull the ball used to carry its armed trail into the hand, so a
    caught ball drew a second arc — the catch itself — before the weld cut it. Now the ball is bare for the journey
    (it is not a throw any more) and the arc it *was* stays where it was caught.

    **Comments corrected in the same pass, because they argued for the old behaviour**: `setArmed`'s "left to expire on
    their own lifetime" (now says plainly that disabling is a cut, and points at `freeze`), the class doc's "there is
    nothing to clean up" (one set now leaves the ball, and it is `Debris`'s), and §7's pointer to the class doc stands.

    **Unverified, and it is the risk to name**: whether a `Trail`'s recorded history survives a re-parent with its
    `Attachment0`/`Attachment1` re-homed. Nothing about that is in the typings — the typings say only that `Enabled`
    is a boolean and `Lifetime` a number — and the engine's own behaviour is the only authority. If the history does
    **not** survive, the frozen holder draws nothing and the result is exactly today's behaviour plus one invisible
    part for a second; if it does, the arc stays and fades. **`BallTrail.freeze` is the one line to delete if the
    playtest shows no change**, and its call site in `beginPull` with it.

86. **The drill's `charge 0.00` was not a broken calculation — it was a *correct* calculation for a bad aim point.
    The drill now aims at hand height on the body, and 39.5 studs costs `~0.50`.**
    The report was *"the drill throws with minimum charge, so the ball falls short and bounces"*, and the spec named
    `trueAim` as the suspect.

    **`trueAim` is innocent, and so is the distance.** `beginWindup` computes
    `chargeForRange(distance, point.Y − muzzle.Y)` on every call — `trueAim` only decides whether `point` is the aim
    point or a `rollMiss` offset of it. The distance in the log (`39.5`) is the flat muzzle-to-aim distance, measured
    the same way the release measures it. What was wrong is the **third** argument to that solve: the height.

    **The arithmetic reproduces both log lines to two decimals, which is how this stopped being a guess.** With
    `BALL_GRAVITY` 50, `CHARGE_PEAK_HEIGHT` 0.5 and `THROW_MUZZLE_HEIGHT` 2.5, a muzzle 2.5 studs *above* the aim point
    gives a flight of 0.488 s, and the minimum speed of 80 studs/s covers **41 studs** in it:

    | range | rise −2.5 (what it did) | rise 0 (what it does) |
    | --- | --- | --- |
    | 32.0 | **charge 0.00**, 66 studs/s | charge 0.28, 113 studs/s |
    | 39.5 | **charge 0.01**, 81 studs/s | charge 0.50, 140 studs/s |
    | 50.0 | charge 0.19 | charge 0.81 |
    | 59.4 | charge 0.35 | **charge 1.00** (capped, wants 210) |

    **And the ball was already reaching the player, which the spec's premise denies.** In the same log, the throw at
    `15:25:01.413` is followed by `prospeed1 was tagged by DodgeballBall on LowerTorso` at `15:25:01.891` — **478 ms
    later, against a solved flight of 488 ms.** That is a direct hit in the air on the point it was aimed at, followed
    by a catch at `15:25:02.172`. Nothing bounced. **A drill aimed at a root and a ball that reaches a root are the
    same event**, and the "short ball rolling into me" was a spent ball from an earlier throw.

    **The cause is a decision the charged throw invalidated, and two comments still argued for it.**
    `ThrowBehavior`'s `ThrowLine` doc says *"a rig aims downhill… `sighting.aimPoint` is a body's root — about two and
    a half studs lower"*, and `playerInBay` said the root is *"what a ball leaving at head height arrives **down**
    onto"*. Both were true of the **lob** this game threw before `CHARGE_PEAK_HEIGHT` came down to half a stud. A
    charged throw is flat, so "arrive down onto" is no longer a thing it does: aiming 2.5 studs low now means *solve
    for the slowest ball that still drops 2.5 studs over this distance*, and below 41 studs that answer is the floor —
    which is also why the drill's windup was 12 ms and it had no telegraph at all.

    **The fix is one function and one paragraph.** `playerInBay` answers `at` as `root + THROW_MUZZLE_HEIGHT` — the
    height a ball leaves a hand, applied to the body it is aimed at — so on level ground the rise is **zero** and the
    charge describes the *distance* rather than the *drop*. Both comments are rewritten rather than deleted.

    **Two costs, stated because they are the trade rather than an oversight.** The aim point is now at head height on
    a standing body (the muzzle is `root + 2.5`, and so is the target), so a drill throw arrives at the upper body
    rather than at the hip; and the flat solve caps at **~57 studs**, so the far corner of a 55×56 bay is `charge 1.0`
    and a couple of studs short. Both are one edit to set back.

    **The windup follows the charge, confirmed in source rather than assumed.** `createWindupTracker` writes
    `until: now + charge × RIG_CHARGE_SECONDS` and the tick releases when `now >= windup.until`, so 0.01 → 0.50 turns
    a 12 ms hold into **0.63 s** — a drill that finally telegraphs. The release re-reads `windup.charge` and passes it
    to `throwBall` unchanged, so the solved charge is the thrown charge.

    **Left alone, and recorded**: round rigs still aim at a root through `detectEnemy`, so they still bottom out below
    ~41 studs — a rig that closes to 30 studs throws the softest ball in the game. That is the same defect in a
    different caller, out of scope here, and it is the next item for whoever wants it. **Also drifted, not fixed**:
    `planChargedThrow`'s doc still claims a full hold reaches 150 studs and quotes `CHARGE_MIN_SPEED = 45` and a
    `THROW_MAX_SPEED` of 336, while the config says 80 and 200 — at which a full hold with the drop reaches ~97 studs,
    which the round-rig line `charge 0.90 at 91.6 studs` corroborates.

    **Unverified**: that the `3 2 1` countdown followed by a 0.63 s hold reads as one telegraph rather than two, and
    that a head-height ball is what a player practising a catch actually wants.

87. **The drill's countdown drew `3 2 1` and then a second `1` — item 86 made the hold long enough to be visible, and
    the digits were counting it.** The report was *"why is it skipping 3 to 1 sometimes? It will often just show 1
    while in the bay."*

    **The digits were right and the span they were drawn over was wrong.** `NEXT_THROW_AT_ATTRIBUTE` is republished
    when a windup opens, because the next throw *is* the release then rather than the decision — and a hold is
    `charge × RIG_CHARGE_SECONDS`. Item 86 took the drill's charge from `0.01` to `0.50`–`0.63` (the new log's
    `charge 0.63 at 44.5 studs` is that pass landing), so the hold went from **12 ms to 0.79 s**. The client rounds
    the remaining time up, so a 0.79 s deadline can only ever be `1`: every cycle drew `3 2 1` → `1`, the last number
    repeated, and the ball arrived while the board still claimed a second to go.

    **Nothing was skipping.** The server publishes a whole `cadence` (5 s) on the turn a rig arms and stands down by
    clearing both the deadline and the decision time, so a player walking into a bay always gets a full wait and each
    of `3`, `2`, `1` gets a full second. What reads as `3 → 1` is the phantom `1` after it.

    **The fix is a hide, not a clamp, because the hold already has a telegraph and it is not this one.**
    `client/practiceCountdown` now hides the board the moment `CHARGING_ATTRIBUTE` is a number:
    `client/chargeEffect.ts` draws that charge on the rig's *hand*, over every `NPC_TAG` body, so a drill's windup is
    the hand lighting up for 0.79 s before the ball. **That is the module's own doc, which has said all along**: *"a
    person watching a drill sees a number counting down, then a hand lighting up, then a ball."* The republished
    deadline quietly contradicted it, and this is the reconciliation.

    **THE HIDE IS GONE AGAIN — item 88.** It was the right answer to a server counting the wrong thing, and item 88
    moved the count onto the throw itself: the deadline is now the release and the windup is started a hold early, so
    the `1` on the board is the second the rig spends winding up and hiding it would remove the best part. Its
    comment in `practiceCountdown` says so rather than being deleted, because "why did this come and go" is the
    question the next reader will have.

    **Two comments argued for the old behaviour and are rewritten.** `publishDeadline`'s *"the cycle a client draws is
    therefore `cadence → 3 2 1 → hold → throw`"* — which was describing the bug as a feature — and `draw`'s *"there is
    deliberately no second path that hides a number"*. Both are rewritten again by item 88 for the shape that survived.

    **Unverified**: whether `3 2 1` followed by a board that vanishes and a hand that lights reads as one countdown or
    as a countdown that ended early. **Item 88 answered it the other way**: the digits count through the windup and end
    on the ball, so the question is moot.

88. **The drill's countdown now counts the *throw*: the windup is started one hold early so it plays during the `1` and
    the ball leaves on `0`.** The report was *"the windup has to happen during the last second"*, after item 87.

    **What was wrong was one number's meaning.** `NEXT_THROW_AT_ATTRIBUTE` said *when the ball comes* and the drill was
    publishing *when the windup starts*, then republishing the hold's length on top of it. So the board drew
    `3 2 1` → `1` and the ball arrived after the number had already promised it. The fix is not a display fix: it is to
    make the published instant the release and to schedule everything else backwards from it.

    | before | after |
    | --- | --- |
    | `nextDecisionAt` = when to start winding up | **`nextThrowAt`** = when the ball leaves |
    | windup started at `due` | windup started at **`due − hold`** |
    | released at `windup.until` | released at **`due`** |
    | three `publishDeadline` sites, one of them the hold | **two**: the arming turn and the release that re-arms |

    **The hold is asked for rather than predicted, which is the part worth reading.** `createWindupTracker` grew
    `holdFor(model, aimPoint)`, and `beginWindup`'s own four lines of solve became a shared `holdOf` returning
    `{ charge, distance, duration }` that both call. So the drill starts its windup on the last turn before
    `due − hold`, using *the same arithmetic the windup is about to run* on the same muzzle and the same point — the
    two cannot disagree, which they would if this file had its own copy of `chargeForRange(distance, rise) ×
    RIG_CHARGE_SECONDS`. It is asked every turn rather than stored when the cycle armed, because the answer depends on
    where the player is standing and that plan would be five seconds stale.

    **The deadline wins over the hold when they disagree, deliberately.** A target that walks during the hold makes
    `beginWindup`'s solve differ from the `holdFor` that scheduled it, so `windup.until` lands a few hundredths either
    side of `due`. The release reads `due` (`windup.until` is only the fallback for a hold with no deadline behind it),
    because the number a player has been watching is worth more than a hold of exactly `charge × RIG_CHARGE_SECONDS`.
    The cost of the disagreement is that a hold can be cut short or held a fraction long — invisible, and the fireball
    effect is driven by the charge rather than by the hold's length.

    **The cycle is now `cadence`, not `cadence + hold`.** `PRACTICE_THROW_CADENCE_SECONDS` (5) was the wait *before*
    the windup; it is now the interval between balls, so a drill throws every 5 s instead of every 5.79 s. Recorded
    because it is a real change in pace, small enough that it needs no separate number.

    **Item 87's client-side hide is reverted**, and its comment says why in the file rather than being deleted: the
    digits must run *through* the windup for "the windup happens during the `1`" to be true, and hiding the board on
    `CHARGING_ATTRIBUTE` would remove exactly the second the player wants to see counted. What is left in
    `practiceCountdown` is the arithmetic it always had — `ceil(at − GetServerTimeNow())` — reading an attribute that
    finally means what the module's doc says it means.

    **One edge, stated**: a rig whose windup is cancelled mid-hold (frozen, ball stolen, player left) keeps its stale
    `nextThrowAt` — the retry semantics are `ThrowBehavior`'s and unchanged, so a cancelled hold costs one decision
    rather than a whole interval — which means the next windup starts on the next tick and the ball can arrive up to one
    tick (0.1 s) after its own deadline. That cycle also draws no digits, because the cancellation clears the deadline
    and only a release republishes one. Both are the price of not throwing from a cancelled hold.

    **Unverified**: that the `1` and the lit hand line up frame for frame, and that a 5 s cycle feels right now that it
    excludes the hold.

89. **Two drills threw at the same player because `targetFor`'s fallback handed a rig *anybody's* bay. A rig is now
    bound to one bay and only that bay arms it.** The report was *"both throwing NPCs are throwing at me; a rig is only
    supposed to throw at a player if they are in the rig's zone, and rigs don't share zones"*.

    **The log is unambiguous and it was not an AI problem.** Every line is `(x2)` — two rigs printing the same
    stand-down, the same `armed`, the same bay — and `15:59:02.981`/`.982` are **two throws in the same millisecond**
    at the same player, `64.5` studs with heading `(-1.00, 0, -0.07)` and `39.6` studs with `(1.00, 0, 0.02)`. Two rigs
    on opposite sides of one person, from two bays at `X = 130.5` and `X = 75.0`.

    **What did it, in three lines of the old `targetFor`.** The rule was three passes: the rig's own bay; then a bay
    overlapping it; then **every other bay, nearest to the rig**. The third pass was added when this place file had
    *one* bay and *one* rig that was not standing on it — a rule that could never otherwise fire. **With two bays it
    fires wrongly**: the rig beside box B has an empty own bay, so pass three hands it whoever is in box A, and both
    drills shoot at the same person. A fallback that lets a rig throw into another rig's box is not a fallback.

    | | before | after |
    | --- | --- | --- |
    | which bay a rig may use | its own, **else any occupied one** | its own, **else the nearest** — decided by geography, never by who is available |
    | what silences a rig | nobody in *any* bay | nobody in **its** bay |
    | a rig with no bay at all | threw at whoever was nearest | silent, and says so |

    **The concession to the old layout survives, in a form that cannot cross zones.** `bayOf(rig) ?? nearestBayTo(rig)`:
    a rig planted *beside* its box is still bound to that box, because it is the closest one — but which box that is
    never depends on where a player happens to be standing. **The cost is stated in the function's own doc**: a drill
    whose bay was deleted or which was moved away from every box goes quiet instead of shooting at whoever is nearest.
    That is a *diagnosable* silence, which the old behaviour was not.

    **The diagnostic was lying too, for the same reason, and is fixed with it.** `nearestPlayerBayGap()` measured the
    player against whichever bay was nearest *to the player* — so with two bays it printed the box they were standing
    in and called them `0.9 studs outside`, while the rig printing the line was bound to the other one. That is why
    both rigs looked identical in the log. It is now **`rigBayGap(rig)`**: the same binding `targetFor` uses, the
    player's distance from *that* bay, and a distinct sentence for a rig bound to no bay (`and this rig is not standing
    on or near any of the 2 bay(s) … move it over a bay`). A diagnostic that names a bay the rig cannot use is worse
    than none.

    **Unverified**: that both rigs in this place file really are on (or nearest) their own box. The fix depends on it,
    and if one goes quiet the new stand-down line names the bay it chose and where the person is relative to it — which
    is the reading that settles whether the box or the rig needs moving.

90. **The dodge's round half was the *phase*, not membership, so a lobby spectator could dodge for the length of
    somebody else's round.** The report was *"when the round starts I can dodge in the lobby even though I am not in
    the match"* — asking for the rule to be *in a practice area, **or** in the round being played*.

    **Both ends of the rule were already written; one of them was the wrong fact.** `DodgeService.requestDodge` gated
    on `ROUND_STATE_ATTRIBUTE === PLAYING` — a fact about the *server*, true for everybody — or the practice-zone
    attribute. The client's `roundZone.inRoundOrZone` asked the identical phase. So opting out, never joining, or
    surrendering out of a round all still bought the mechanic, and the only thing that could silence a dodge in the
    lobby was being outside a zone that is not the lobby.

    **The missing half is `IN_ROUND_ATTRIBUTE`** — the round's own statement that it has *this player* in it, published
    since 2026-10-20 at the four places membership changes and cleared in `eliminate`. A dodge now needs the phase
    **and** that attribute, or a zone.

    | | before | after |
    | --- | --- | --- |
    | server gate | `phase === Playing` \|\| zone | `(phase === Playing && player.InRound)` \|\| zone |
    | client gate | `inRound()` \|\| zone | `isParticipant(player)` \|\| zone |
    | a rig | phase (no player to ask) | **unchanged** — phase, because a rig has no membership |

    **The client now asks `isParticipant`, which is the predicate the camera's shift-lock, the aim assist, the dock,
    the `afk` rule and `killCam` all already use.** One rule, six readers, rather than a seventh copy of "in the
    round". The server cannot call a `client/` helper, so it asks the two facts itself — **the same two**, which is what
    keeps a press from being allowed locally and refused on the wire.

    **A consequence worth naming**: a player eliminated mid-round loses the dodge with `IN_ROUND_ATTRIBUTE`. That is
    the rule as stated — out of the round is out — and it closes the case the item was reported for, where a spectator
    wandered the lobby dodging during a live match. A dev testing in the lobby needs a practice zone, which is what
    the zone was built for.

    **A comment argued for the old shape and is rewritten, at length.** `roundZone.inRoundOrZone`'s doc said the two
    questions were *deliberately* kept apart — the camera and the dodge asking "is the game being played around me",
    the team ring and the surrender prompt asking "am I still in it" — on the grounds that `activePlayers` had never
    been replicated and was not going to be. It is replicated; the paragraph now says so, and says that the dodge was
    asking the first question because the second could not be asked, not because it was the right one. The `roundZone`
    header's claim that "the camera and the dodge want the same rule" is corrected the same way: they no longer do.

    **Untouched deliberately**: `SuperService.inRoundOrZone`, which gates a super ability's catch and throw on the
    phase or a zone and is `BallService`'s borrowed copy of the same idea. It is the same defect in a different
    mechanic and it wants its own decision — a power is bought and carried, where a dodge is not — so it is recorded
    here rather than changed silently.

    **Unverified**: that the *feel* is right, which for this one is really a question about the lobby. A player waiting
    for a round now has no dodge at all; if that reads as the mechanic being broken rather than as the lobby being a
    lobby, the answer is a zone on the waiting floor and not a looser rule.

91. **A wall that stops dodgeballs and lets everybody walk through it: `BallBarrier`.** A loose ball bounces off
    it, and a body that walks into it carrying a ball loses the ball, with a spawn poof.

    **The group is the whole of "stops balls, not bodies".** A new `BallWall` group, left collidable against `Ball`
    — so a loose ball bounces, by the engine, with no code of ours — and registered non-collidable against
    `Character`, `PracticePlayer`, `DUCK_GROUP`, `Default`, `Barrier` and itself. Assigned by
    `CollisionGroups.applyBallWallGroupsBody`, called from `applyBarrierGroups` so both walls are one pass at every
    round boundary. **Three character rows rather than one** because a body can be in any of the three, and missing
    one would be a wall that only stops players mid-duck.

    **The trigger is the *barrier's* `Touched`, and the spec's two recommendations were both wrong about that.**

    | the spec said | what the source says |
    | --- | --- |
    | check it in `BallComponent.handleTouch` | that method's **first line** returns for a ball whose `Armed` is not `true`, and a held ball is never armed — `attachToHand` runs `makeInert`. A barrier branch there would have to sit *above* the guard that stops spent balls doing anything at all |
    | held balls have `CanCollide = false`, so maybe `Touched` won't fire | true of the **ball**, which is why it is not what is listened to. The **character** is `CanCollide = true`, its pair with the wall is non-colliding **by group**, and a group suppresses collision rather than `Touched` — the fact the duck's head and the midline wall both already design around. A body interpenetrates the wall and the wall still hears it arrive |

    So `BallService.watchBallBarriers` connects each tagged part's `Touched` — the walk at boot plus the tag's
    added-signal, so a wall tagged mid-session works — and `ballMetWall` resolves the contact to a body (`Model`
    ancestor **with a `Humanoid`**, which is what stops a loose ball resting against the wall resolving to the arena
    folder), looks it up in `heldBalls`, and calls `playSpawnPoof(undefined, ball.CFrame)` then `removeBall(body)`.
    **`removeBall` is the whole teardown**: map entry, the ball and everything parented to it, and the holder's
    armed power.

    **The poof is anchored at the ball's `CFrame`, not at the body.** `playSpawnPoof` takes a `Model` and a ball is
    a `BasePart`, so the body would be the only thing it could take — and `anchorOf` would then put the burst at the
    chest, a body-length from the hand that actually vanished.

    **Destroyed rather than dropped**, deliberately: a dropped ball lands on the far side of the wall, gets picked
    up, and is carried straight back in — and the wall would become a way to hand a ball to somebody behind it.

    **Flags, and they are the mirror of `CharacterBarrier`'s.** `CanCollide` true (the bounce), `CanTouch` true (**the
    ball-losing rule runs on it**; a `CanTouch = false` wall is one a player carries a ball through with nothing
    happening), `CanQuery` true (a throw will bounce off it, so the aim arc should stop there — where the midline is
    `CanQuery = false` because a ball crosses *it*).

    **A loose ball is not this rule's business and the code says so**: the handler finds a body, does not find one
    for a ball parented to `Workspace`, and returns. The bounce is the physics engine's, which is why there is no
    line of code in the game that bounces a ball off this wall.

    **Untouched**: `CharacterBarrier`, the throw, the catch, the pull, the trail, `CHARGING_ATTRIBUTE` and the
    trajectory preview. The new group adds no row to any existing pair.

    **Unverified, and both need Studio**: that a character's `Touched` really does fire against a wall whose group
    is non-collidable with it — the duck precedent is a *colliding* pair in non-colliding groups, so the mechanism is
    the same but this exact configuration has not been watched — and that the poof reads as the ball vanishing rather
    than as the player being hit. If the contact does not fire, the fallback is the barrier running
    `GetPartBoundsInBox` for bodies on a tick, which is the option that was rejected for touching more systems.

    **THE CONTACT DID NOT FIRE — item 92 replaced the whole detection half.** The `Touched` version is withdrawn and
    the `GetPartBoundsInBox` fallback named above is what shipped.

92. **`BallBarrier` did nothing when tagged: the group was only ever assigned at a round boundary, and the held-ball rule
    was hung on a `Touched` that never fires.** Both halves replaced. The report was *"nothing happens when I tag a
    part"* — loose balls sailed through and players walked through carrying a ball.

    **Two faults, and item 91 introduced both.**

    | fault | what it was | what it is |
    | --- | --- | --- |
    | the group | assigned only by `applyBarrierGroups`, which `RoundService` calls at a **round boundary** — so a wall tagged mid-session, or on a server nobody started a round on, stayed in `Default` | assigned at **boot**, on the **tag's added-signal**, *and* at the boundary |
    | the detection | the wall's own `Touched`, on the claim that a collision group suppresses collision rather than contact | `GetPartBoundsInBox` on one `Heartbeat`, over a registry of walls |

    **The group fault explains both reported symptoms at once, and neither of them is the one item 91 predicted.** A
    part still in `Default` collides with `Default` — so it stops the player and passes the ball, which is exactly
    backwards. Item 91's failure mode was written as "a part that reads `Default` … collides with the character", and
    that half was right; what it did not say is that the same part also stops bouncing a ball, because `Default` is
    not `Ball` and the row that matters is `BallWall` ↔ `Ball`.

    **The `Touched` claim is withdrawn rather than re-argued.** Item 91 said a collision group suppresses collision
    rather than contact, citing the duck's head — and this time the measurement is the user's report. Whatever the
    engine's truth is, **a wall deliberately made non-collidable with every body is the worst possible place to build
    a rule on a contact event**, and the comment in `CollisionGroups` now says so in those words rather than
    defending the old reading.

    **Two mechanisms because a loose ball and a held ball are not the same kind of thing**, and this is the shape
    worth keeping:

    - **loose → physics.** `BallWall` ↔ `Ball` is **collidable**, written out explicitly rather than left to the
      engine default (item 91 relied on the default, which left the feature's one load-bearing row invisible in the
      file). The engine bounces the ball and **there is no code for it** — a query would miss a ball crossing a thin
      wall between frames in exactly the way a solver cannot.
    - **held → geometry.** A welded ball is `CanCollide = false` and its pair with the wall is non-collidable, so
      nothing the engine does could notice it. `pumpBallWalls` asks `GetPartBoundsInBox` instead.

    **The reverse of either would break the pair**, which is why they are not "one rule written twice": a physics
    held ball needs `CanCollide = true` on a welded part, which is the held-ball shove bug `attachToHand` exists to
    prevent; a queried loose ball stops bouncing on the frame the query misses.

    **`isHeld` takes a ball, not a character** — the prompt asked for that to be checked, and it is `isHeld(ball:
    BasePart)` walking the whole map. The sweep has a *character*, so it uses `heldBalls.has(character)`, which is the
    right question and the cheaper one. `isHeld` is unchanged for `cleanupRoundBalls`, which genuinely has a ball.

    **One `Heartbeat` over a registry, not a connection or a query per wall.** `wallOverlap` is one `OverlapParams`
    built on the instance rather than per call. The registry is kept by the tag's two signals plus a boot walk, and a
    wall that has left the world is dropped on the frame the sweep notices rather than queried for ever.

    **Cost, stated**: with no `BALL_BARRIER_TAG` part anywhere the loop is a set-size check and returns — a place file
    that never paints one pays nothing. With one wall it is one bounds query per frame; with N walls, N. That is the
    number to watch if somebody ever paints a hundred.

    **A ball can squeak past a corner or a gap**, and that is geometry rather than a fault: the wall stops balls where
    somebody painted it. The fix is a wider wall, never a larger box — an inflated box would destroy balls that
    bounced off the visible edge and never crossed anything.

    **`CharacterBarrier` and `BallBarrier` stay two tags**, and collapsing them into one part with a `Side` attribute
    is the wrong default even though they are siblings: they are opposites on every axis (`CanTouch`, `CanQuery`, and
    which group is collidable), so one part carrying both would need an attribute that switches all three — and the
    two walls are *never* in the same place, which is the whole reason one stops bodies at the midline and the other
    stops balls at a practice-area entrance.

    **Unverified**: that the ball bounces at all — the group row is now explicit and the contact-half of the theory is
    withdrawn, so this is the one thing the pass cannot claim. Emitted Luau shows
    `Workspace:CollisionGroupSetCollidable(BALL_WALL_GROUP, BALL_GROUP, true)` and
    `[Collision] ball barrier tagged — <name> = BallWall` on the tag, which is the evidence that the group took.

93. **The wall was in the right group and the ball still went through: a collision group says which pairs the engine
    *considers*, and `CanCollide` is the switch that makes it consider them.** The report was *"I can still throw the
    ball across past the wall"*, with a log proving `BallBarrier = BallWall` and `BallWall` in `Workspace`'s group
    list.

    **So the group half of item 92 was right and the log was the thing that said so** — which is why the fault had to
    be in the part's own flags or in the physics. `dressBallWall` now forces the four properties the tag owns and
    **warns naming any it had to correct**, in `MatchService.prepare`'s shape:

    | property | what it is for | what breaks without it |
    | --- | --- | --- |
    | `Anchored = true` | stays where it was painted | it falls out of the world and the engine deletes it at `FallenPartsDestroyHeight` — a wall that is gone looks exactly like a wall nothing collides with |
    | `CanCollide = true` | **the bounce** | the group row is a rule about a part that is solid to nothing. **This is the likely cause of the report**: an invisible marker is usually painted with `CanCollide = false` |
    | `CanTouch = true` | reports contacts at all | inert to every contact rule — and the first version of this feature *was* a contact rule |
    | `CanQuery = true` | the aim arc stops here | a preview that draws itself through a wall a throw would bounce off |

    **The second limit is geometry and no rule can lift it, so it is reported rather than hidden.** Roblox does not
    sweep a collision between frames: at `THROW_MAX_SPEED` (200) a ball covers **3.3 studs a frame**, so a wall one
    stud thick is passed through without the two ever overlapping — a full-charge throw goes through while a lob
    bounces, which reads as the wall being unreliable rather than thin. `reportBallWallThickness` warns with the
    number to build to. **The fix is a thicker part, not a smarter script**: growing the part from code would move
    its faces into the room it was placed to seal, and a query-based backstop is the thing this feature already
    refused once for the loose-ball case.

    **One line of evidence was missing and is now printed.** The boot read-back named `Barrier`/`Default` and
    `Character`/`Character` but not the row the ball wall actually lives on, so a log could say which group every part
    was in and not whether the row took. `[Collision] BallWall/Ball collides — service true, world true` is now
    printed beside them, and it is the one number that separates "the matrix is wrong" from "the matrix is right and
    something else is".

    **Not changed**: the matrix, the sweep, the tag, `CharacterBarrier`. Item 92's two mechanisms stand.

    **Unverified**: which of the two remaining causes it was. A log from the next session answers it in one pass —
    a `corrected CanCollide` warning names the first, a `studs thick` warning names the second, and no warning at all
    with the ball still crossing would mean something neither this pass nor the last one has found.

94. **Four players on one side were landing on four spawns drawn at random, which meant two could share a part and
    the closest spot to the balls went to whoever rolled it.** `RoundService.arenaSpawnFor` is now the *claim and
    order* funnel: a player takes the nearest spawn part still unclaimed, and no two players on a side share one.

    **The reconnaissance, because the shape of the fix was decided by it.** `arenaSpawnFor` was already the single
    funnel — `admitWithCover` (mid-round admission), the `CharacterAdded` handler (respawn), `teleportTeamsToArena`
    (the round start) and the same loop's rig pass all reached it — so the claim and the sort went there and nothing
    else had to change. **No claim system existed**; `getRandomTeamSpawn` drew `math.random` over the team folder's
    direct `BasePart` children and was the only picker.

    **The one thing the brief had wrong, and it would have failed silently.** One of the three *player* call sites
    passes an `Instance` that is not a `Player`: `admitWithCover` does `character.PivotTo(this.arenaSpawnFor(character))`
    because the character is what it holds. A `participant.IsA("Player")` test would therefore have classified every
    mid-round admission as a rig — no claim, random draw — and the only evidence would have been two players sharing a
    spawn part in a case nobody was testing. The question is asked with `Players.GetPlayerFromCharacter` instead,
    which is the call `teamOf` already makes one line above for exactly this reason.

    **The sort is a minimum distance to *any* `MatchSpawner`, not an average of them all.** A part is good if it is
    near *at least one* place balls appear; an average ranks a spot halfway between two spawners above one standing
    beside a third, which is the opposite of "near the action" whenever a spawner has no balls beside it. It is also
    the question a player asks — how far do I walk for a ball. `spawnsNearestFirst` reads the spawners through
    `taggedPartsInWorkspace(MATCH_SPAWNER_TAG)` per call and caches nothing, so a spawner moved in Studio moves the
    ordering with it. **An arena with no `MatchSpawner` at all is not an error**: the folder's own order comes back
    untouched, and the claim still runs, so uniqueness survives and only the preference does not.

    **The registry is `Map<Player, BasePart>` rather than the brief's `Map<TeamLabel, Set<BasePart>>`**, and the
    direction is the reason. Every question this is asked is player-side — *free this one's spot* — and that is
    `delete` when the key is the player. A per-team set answers the part-side question with `has` and then needs a
    second map to answer the release, which is two records to keep in step for one fact. The part-side question is
    answered by reading the values once into a `Set` per spawn, which is a handful of comparisons against a side of
    at most a few parts.

    **Three release points, and each is a different way a body leaves a reservation behind:**

    | where | which departure | what it would otherwise cost |
    | --- | --- | --- |
    | `eliminate` | a hit, a surrender, an AFK return — all three arrive here | a mid-round admission finds the side's best spots reserved for players watching from the lobby |
    | `Players.PlayerRemoving` | a leaver, who is neither an elimination nor a round end | a part a side can never use again — a slow leak towards a shortage that does not exist |
    | `finishRound` | the round itself, on the same reasoning as `surrendered` | an intermission that never ends carries the finished round's reservations into the next one |

    **A player releases their old claim inside `arenaSpawnFor`, before taking a new one.** A Dodge-and-Seek death is
    the case: that mode converts its dead rather than eliminating them, so the same player comes back through the
    funnel and would otherwise hold two parts. **They do not get their old spot back** — they take the nearest free
    one, so the front row stays occupied by whoever is alive rather than being parked for a corpse.

    **More players than parts is a warning and a placement, not an `error()`.** Two bodies on one spawn part push
    apart on the first tick; a round that raised instead is four players waiting for somebody to add a part. The line
    is `[Round] team A: 4 spawn part(s) for 5 player(s) — X has no free one and is sharing a spot`, and **the extra
    body claims nothing**, because a part two people are standing on is not a reservation and recording one would let
    whichever of them leaves first free a spot the other is still on.

    **Two module helpers came out of it and one of them was already overdue.** `getRandomTeamSpawn` split into
    `requiredTeamSpawns` (the lookup and its two errors) and `randomSpawn` (the draw), so "raise" and "pick" are no
    longer one function that does both. `liftOf` is the three-stud spawn lift, which was inline at three sites in this
    file and is now written once — the rig side wrote its own at the time, on the argument that folding it in would
    make this file own a number `npc/arenaSpawns.ts` exists to keep its distance from.

    **Withdrawn by item 95: the exclusion of rigs, and the reason given for it.** This pass claimed for players only,
    on the argument that a rig is a body the server placed whose spot means nothing to it. Item 95 is the correction:
    a rig *is* a placeholder for a player, so four of them on a side is four bodies arriving in one pile, and a rig
    drawing its own part put every rig wherever the dice said while the players filled the front row. The registry is
    keyed on the body now, both kinds claim, and the whole rule lives in `services/round/arenaSpawns.ts` so that
    `RespawnBehavior` reaches the same claim instead of a second copy of it.

    **Not changed**: how players are assigned to sides, `LobbyRigService`'s lobby draw, the drill, the bay, the catch
    and the pull. The trajectory preview and `CHARGING_ATTRIBUTE` were untouched — no throw, aim or charge code was
    read except `arena.config.ts`'s spawn note.

    **Unverified**: the ordering, the uniqueness and the warning are all readings of the code. A round log proves the
    first two cheaply — `[Round] arena move — N player(s) and M rig(s) to their side's spawn` lands right after the
    claims are made, so the acceptance test is four bodies on one side and two of them standing on the same part,
    which would print the `sharing a spot` line.

95. **Rigs claim arena spawns exactly as players do, and item 94's "a rig reserves nothing" was wrong about what a
    rig is.** A rig is a placeholder for a player, so four of them on a side is four bodies arriving in one pile —
    the fault the claims exist for — and a rig drawing its own part opened a round with every rig where the dice put
    it while the players filled the front row. Both kinds now claim, both are sorted nearest-the-balls first, and the
    whole rule is one module: `services/round/arenaSpawns.ts`.

    **The reconnaissance is what made this more than a type change, and it found a second entry point.** A rig reaches
    the arena by two different roads. `teleportTeamsToArena` sends it through `arenaSpawnFor` like a player — but a rig
    that *dies mid-round* is rebuilt by `RespawnBehavior` and placed by `arenaSpawnForRig` in `npc/arenaSpawns.ts`,
    which was a **second copy of the spawn rule**: its own walk of the same `ArenaSpawns/<side>` folders and a
    `math.random` at the end. So changing the map's key alone would have left the important case — the rig that dies
    and comes back — still drawing at random and claiming nothing. `npc/arenaSpawns.ts` is **deleted**; the rig path
    resolves its parts and then calls the same `claimArenaSpawn` the round calls.

    **That second road is also why the registry could not stay in `RoundService`.** `RespawnBehavior` has no service to
    call: it is constructed by `NpcService`, and `RoundService` is the service that injects `NpcService`, so reaching
    back would be a cycle at run time — the exact constraint `npc/arenaSpawns.ts` was written to work around. The claim
    map therefore moved to a leaf module both can import, and `npc/arenaSpawns.ts`'s whole reason to exist went with
    the duplicate. It is not a Flamework service (a map, no injected state, nothing to start), so `flamework.build` is
    untouched — the `SpawnShield.ts` precedent.

    **The map is `Map<Model, BasePart>` and the key is the body**, which is the change the old key made impossible: a
    rig has no `Player` at all, so a player-keyed registry could only ever describe half the arena. A character is a
    `Model` and a rig is a `Model`, so one key type serves both forms the round is handed — and it is handed both:
    `admitWithCover` passes a *character*, while the round start and the respawn pass a `Player`. **There is now no
    `Players.GetPlayerFromCharacter` in the spawn path at all**, which also removes item 94's own special case; both
    of the tests that suggest themselves (`GetPlayerFromCharacter`, `IsA("Player")`) answer "nobody" for a real body.

    **A claim dies with its body, and that is the price of keying on it.** A rig is destroyed and re-cloned on death,
    so the replacement is a new key; a Dodge-and-Seek player comes back on a new character, likewise. Five release
    sites, one per way a body stops being a body:

    | where | which body | why there |
    | --- | --- | --- |
    | `handleDeath` | a player's, on the death edge | covers every player death, including the mode that converts instead of eliminating — the old character's part would otherwise be reserved for the round with no instance left to name it by |
    | `eliminate` | a player's, on surrender and AFK | the two exits that are not deaths; a death has already released, so the second delete is a no-op |
    | `Players.PlayerRemoving` | a player's | a leaver is neither an elimination nor a round end |
    | `RespawnBehavior.onDied` | a rig's, **on the death edge, not in the rebuild** | the rebuild runs two seconds later and only if there is a template to copy, so a rig killed with no template would have leaked its part for the round |
    | `finishRound` | all of them | the backstop, on the same reasoning as `surrendered` |

    **Nothing prunes the map**, deliberately: a live-parent scan would be right about the common case and wrong about
    the rebuild that claims for a rig *before* parenting it, so the release is explicit at each body's death and
    `clearArenaSpawns` is what catches anything else.

    **The overflow warning says `body(s)` now**, because it is not four players it is short of: `[Round] team A: 4
    spawn part(s) for 5 body(s) — X has no free one and is sharing a spot`. The extra body still claims nothing, for
    the reason item 94 gives.

    **Not changed**: how teams are assigned, `LobbyRigService`'s lobby draw (a lobby is where people wait, not where a
    round starts, so it keeps the plain draw and claims nothing), the map geometry, and a rig's visual and physical
    properties. The trajectory preview and `CHARGING_ATTRIBUTE` are untouched — no throw, aim or charge code was read.

    **Unverified**: everything below is a reading of the code, and the emitted Luau confirms the wiring rather than the
    behaviour. Four rigs on a side landing on four different parts, the parts filling from the ball spawners
    outwards, and the `sharing a spot` line on overflow are all Studio answers. **The log line to watch is
    `RespawnBehavior`'s own `[NPC] <name>: back — …`**, which prints the position the rebuild placed the rig at; two
    rigs rebuilt in the same round printing the same coordinates is the failure, and the flag that turns that line on
    is `DEBUG = false` at the top of `RespawnBehavior.ts`.

96. **A round's result was wiped out from under it: ten seconds now stand between the whistle and the lobby, and the
    coins it paid are read out in the notification stack.** The window is `ARENA_CONFIG.CELEBRATION_SECONDS`, and
    the toast is `+14 Coins!` held for the same ten seconds.

    **The brief had the timing wrong in one place that mattered.** `finishRound` does **not** call
    `transitionAround` — it is synchronous and reaches nothing but the folder, the economy, the stats and the badges.
    The transition is `gameLoop`'s, at the top of the *intermission* turn, and the countdown loop leaves for it by
    `break`ing on `this.finished`. So the hold is a `holdCelebration()` awaited there, guarded on `this.finished` —
    which is what stops a server's very first intermission celebrating a round that never happened.

    **`finished` could not be the lock, and neither could the phase.** At the instant `finishRound` runs the phase is
    *still* `"Playing"`, so everything gated on it — throws, catches, damage, rig targets, spawners, dodges, powers —
    is still live; and at the instant the celebration starts the phase is `"Intermission"`, which is a state the
    ordinary intermission also has. What the phase buys is free and complete: by publishing `"Intermission"` *before*
    the hold, all eight of its `=== "Playing"` readers close at once and nothing new is needed for the rigs, the
    spawners or the powers. What it cannot express is the three refusals the accept criteria name — **there is no phase
    gate on a throw, a catch or a hit anywhere in this codebase today** — so those three get one new attribute,
    `CELEBRATING_ATTRIBUTE`, and `roundCelebrating()` in `roundStatus.ts` as their single reader.

    | refusal | where | why there |
    | --- | --- | --- |
    | a player's throw | `BallService.throwForPlayer` | **not** `throwBallBody`, which is the shared path: a gate there would refuse the practice bay's drills for ten seconds every time an unrelated match ended. The arena's own NPCs need nothing — `detect.ts` already answers "not playing" and they stop with no target |
    | a catch | `CatchService.blocksCatch` | beside the frozen check, because both are a state the body is in rather than a clock like the dodge pair |
    | a ball doing damage | `BallComponent.landHit` | beside the practice zone's refusal and deliberately not folded into it: a ball already in the air when the whistle went can land ten seconds later, and the practice exemption is about *where* a body is while this one is about *when* |

    **Movement is untouched, and that is a fact rather than a decision to re-take.** Nothing freezes at this boundary
    — `transitionAround`'s `holdEveryoneFor` is used only at the round's *start* — so walking and jumping in the
    window cost no code at all. It is the three refusals above that had to be written.

    **The coin delta is an attribute, not a return value.** `EconomyService.onRoundEnded` already computes `coins`
    per player and publishes the wallet on the next line, so `ROUND_EARNED_COINS_ATTRIBUTE` is written from the same
    local number — the ledger and the line item cannot disagree. A return value was the obvious shape and it does not
    survive the caller: `finishRound` would be holding a per-player clipboard for ten seconds on behalf of a toast.

    **The change signal *is* the notification, which is why the value is cleared** — in `holdCelebration`, at the end
    of the window, not at the next round's start. Two rounds paying the same amount is ordinary, an attribute written
    to the value it already holds fires no signal, and the symptom would be a toast that appeared every *other* round,
    which the player would read as the economy failing. `CurrencyHudController` does the listening, because it is
    already the wallet's readout and already holds the local player, its scope and an attribute subscription.

    **`hudToast.ts` is not the notification HUD and was not used.** That brief was wrong in a way worth recording: the
    file builds a big-ui `Alert` for a bottom-centre column and has had **no caller at all** since `hitConfirm`'s toast
    was deleted (`hitConfirm.ts:97`) — it is dead code, and reviving it would have put a second toast system beside
    the live one. The live one is `client/notifications.ts`: `pushNotification(text)`, a plain module, already used by
    the AFK prompt, the camera unlock and the return-to-lobby card. It gained one optional argument —
    `pushNotification(text, holdSeconds = HOLD_SECONDS)` — so the round's reward is readable for the window it exists
    in while every other notification keeps its three-second glance. **That file's `HOLD_SECONDS` doc now says it is
    the default rather than the rule.**

    **The wording is `+14 Coins!`, with a singular guard** (`+1 Coin!`), and a nought is not announced at all — a
    surrendered player's halved payout can round to zero and `+0 Coins!` reads as a bug.

    **Not changed**: how the economy computes a payout, the wipe, the transition's timing, `hudToast.ts` (left dead
    rather than quietly deleted — that is a separate call, **taken in item 97**).

    **Two side effects of publishing `"Intermission"` ten seconds earlier than the move, both cosmetic and both
    named rather than hidden.** `LobbyRigService.watchPhase` reacts to the phase change by handing its work to its own
    thread, so the lobby's rigs begin refilling during the celebration rather than a tick before the transition — from
    the seats that is rigs walking out while the players stay. And a practice-zone player's *catch* is refused for the
    ten seconds, because `blocksCatch` and `landHit` have no way to tell a bay from the arena; their *throw* is not,
    which is the one that would have been noticed.

    **Unverified**: the ten seconds feeling right, the toast appearing at all, and the winner's banner still being
    legible behind it. All three are Studio answers. The log line that says the machinery ran is
    `Intermission started`, which now prints before the hold instead of a tick before the transition — so a session
    where it prints and the wipe arrives ten seconds later is the whole of the server-side proof.

97. **`ui/hudToast.ts` is deleted, and the celebration has rigs in it now — two things that turned out to be the
    same problem.** The deletion was the easy half. The wander was not: **the seek behaviour is not running during
    the celebration at all**, so putting the stroll in `SeekBehavior.tick` alone would have done nothing at all.

    **The finding that changed the shape of this pass.** The prompt's premise was that the rigs stand still during
    the hold because `detectEnemy` returns nobody and no balls are loose. Both of those are true, and neither is why
    they do not move: on the phase edge to `"Intermission"`, `LobbyRigService.watchPhase` calls
    `setGameplayBehaviors(false)`, which **strips `BEHAVIOR_SEEKING` off every rig holding a side** — so the behaviour
    is never ticked, and the body has no walk to keep or lose. That same thread also queues
    `sendRigsToTheirPads` a cover's length later, which is what item 96 recorded as rigs walking out while the
    players stay. One `awaitCelebration()` at the top of that thread fixes both, and it is the whole of why the
    wander is visible.

    **The wait is a poll of the attribute, not a sleep on the constant.** `CELEBRATING_ATTRIBUTE` is written and
    cleared by the round, so reading it ends the rig side of the boundary when the window really ends rather than
    when a second copy of `CELEBRATION_SECONDS` thinks it should. A tenth of a second at a time, only in the one
    window per round where the flag is up, and a missing folder returns at once — which is every ordinary
    intermission and the first one of a server's life.

    **The wander lives in `SeekBehavior`, as one branch at the top of `tick`.** The recommendation was right for the
    reason it gave — that file already owns every `MoveTo` and the speed sums — and the placement has a second
    argument: it goes *above* the held-ball branch, because `pickupWalk` is the other thing that moves a body and a
    rig that ends the round carrying a ball reaches that branch first. A wander placed with the ball search would
    have left exactly the most visible rigs standing about. `return`, not a fall-through, is what makes "no chasing,
    no fetching, no throwing" true by construction.

    | the number | value | what it is for |
    | --- | --- | --- |
    | `WANDER_EVERY_SECONDS` | 2 | how often a new point is picked — about five moves in the window |
    | `WANDER_RADIUS_STUDS` | 20 | how far from where it stands; a stroll, not a lap |
    | `WANDER_ARRIVED_STUDS` | 3 | close enough to call it arrived and pick again |
    | `WANDER_STUCK_STUDS` | 2 | less than this travelled since the last pick and the body hops |
    | `WANDER_PROBE_UP_STUDS` / `_DOWN_STUDS` | 6 / 12 | the downward ray's span at the candidate |
    | `WANDER_MAX_STEP_STUDS` | 4 | how far the surface found may be from the rig's own feet |
    | `WANDER_TRIES` | 6 | candidates before the turn gives up |

    All **Placeholder.**, and every one of them is a *tuning* number rather than a rule — the only invariant in the
    set is `WANDER_MAX_STEP_STUDS`, which is what stops a rig walking at a wall: a probe that only asked "is there a
    surface here" would happily accept the top of a barrier or a platform nobody can climb to.

    **The point is uniform over the disc rather than uniform in two axes.** Drawing X and Z and rejecting what falls
    outside would bias every rig towards the corners of its own square; the angle plus a `sqrt`-scaled radius puts as
    many picks in the outer ring as in the middle. Invisible in one turn, obvious over ten seconds.

    **A stuck body hops, and only a stuck body.** `Jump` is a request rather than a velocity, so a rig under a roof
    simply stays down; setting it on every pick would be a field of bouncing bodies. In practice the re-pick is what
    unsticks a rig — a body against a wall never arrives, so it is offered a new point every two seconds — and the
    hop is for the case a wall is low enough to get over.

    **The stroll ends where it stands.** The first turn after `roundCelebrating()` answers `false` clears the walk
    and issues `MoveTo` at the rig's own position — the same stop `stand` uses — so a rig is never left walking to a
    point it was given as a party trick, and the ordinary round pays one comparison for it.

    **The deletion.** `mountToast`, `toastOffset` and `ToastOptions` had no importers; the module's only remaining
    mentions were six comments naming it as the owner of a fact, all corrected in this pass —
    `panels.ts`, `HitLogController.ts` (two), `SuperHudController.ts`, `panelChrome.ts` and `hitConfirm.ts`, which now
    point at `notifications.ts` and `SuperHudController` instead. §4's source map, §9's GUI table and §9's cluster
    inventory were updated, and item 36 — which left this decision open — is answered there. **`ui/hudTheme.ts`'s
    `applyUiFont` is now dead**, and kept: it documents a *library's* shape rather than the game's, and its doc now
    says plainly that it has no caller and why it is still here.

    **Not changed**: the duration, anything a player sees or may do in the window, `pushNotification`,
    `pickupWalk` and every other walk, and the lobby's own behaviour — which is only *delayed* by the celebration,
    never skipped.

    **Unverified**: whether the rigs read as "running around" or as "milling about", whether any of them spend the
    window pressed against a wall, and whether twenty studs is the right reach. The log lines that say the machinery
    ran are `Intermission started` followed ten seconds later by a wall of `[Rig] <name>: standing down — behaviours
    off` — and the absence of that wall during the hold is the deferral working.

98. **The ball still crossed the barrier, and the log the user sent saying so was the fix describing itself.** Nothing was
    broken, and **nothing was broken by the two deletions** — `ui/hudToast.ts` and `npc/arenaSpawns.ts` are client UI and a
    relocated server module, neither of which collision code has ever imported, `out/` holds no orphaned `.luau` for
    either, and the build was green throughout. The five lines were the item-93 diagnostics reporting in full:
    `BallWall/Ball collides — service true, world true`, all ten groups registered, `was not set up as a ball wall —
    corrected CanCollide, CanTouch, CanQuery` (**the flags had been wrong, and that is now fixed**), and then

    > `ball wall "…Zones.BallBarrier" is 2.00 studs thick on its thinnest axis, and a ball at THROW_MAX_SPEED covers
    > 3.33 studs a frame — a fast throw can pass through it without ever overlapping.`

    **That last line was the whole fault, and the previous pass had decided to report it rather than fix it.** Item 93's
    argument was that growing the part "would be inventing geometry" and that a thicker part was the user's job. What it
    actually did was put a number in the output and ask a web developer to leave Studio, find a part in the Explorer,
    read `5.0` off a `warn`, and type it into a size field — and the same fault came back. **`thickenBallWall` now does
    it**: the part's thinnest axis is grown to `ceil(THROW_MAX_SPEED / 60) + 1` — five today — symmetrically about the
    centre it already had, with a warning naming both numbers and the per-face intrusion (1.50 studs a side for the
    2 → 5 correction the log reported).

    **The tag now owns five properties rather than four, and the fifth is the same kind of thing as the other four:** a
    silent, one-property failure whose fix is mechanical, on a part whose tag already says what it is for. **The number
    is derived rather than tunable on purpose** — raise `THROW_MAX_SPEED` and the wall follows, with no second constant
    to keep in step. It is idempotent: a wall already thick enough returns in silence, so the boot pass and every round
    boundary after it say nothing.

    **Both halves of the pair were re-verified rather than assumed.** A thrown ball is `CanCollide = true`
    (`BallService:2332`, and `dropBall`'s `:1030` for a ball put down), so with the wall's flags forced the group row is
    now a rule about two solid parts. The held-ball half never depended on any of this — `pumpBallWalls` asks where the
    ball is, and that is why item 92's two mechanisms stay two.

    **What the log did *not* contain, said plainly so the next report is cheaper**: no error, no stack trace, no
    missing-group line, and no `[Round]`/`[Rig]` output. If something *other* than the barrier is also wrong, that
    session's log is the thing to send — these five lines only ever described one part.

    **Unverified**: whether the ball now bounces. Five studs against a 3.33-stud step guarantees an overlapping frame,
    which is as far as reasoning goes — the bounce itself is the engine's and the user's eyes are the only proof. A
    session that prints `Grown to 5.0 studs on that axis` at boot and then holds a full-charge throw at the wall is the
    whole of the test.

99. **The mystery box is a prize now: five visual layers instead of a coloured cube, in `vfx/mysteryBoxVfx.ts`.** The
    brief asked for five and there were six, because the `Highlight` already existed and counts as one — **and then the
    ring was removed, which brings it back to five in the module plus the `Highlight` and the `?` faces in `place`.** See
    the end of this item for why the ring went.

    | layer | what it is | what it says | lifetime |
    | --- | --- | --- | --- |
    | aura | `ParticleEmitter` on an `Attachment` at the box's centre, 6/s, warm white sparkles | *this is alive* | the box's |
    | pillar | `Beam` from the box's top face, 12 studs up, opening 0.9 → 2.2 | *over here*, across the arena | the box's |
    | light | `PointLight`, range 12, brightness pulsing 0.45–1.9 | *it is glowing, not painted* | the box's |
    | spawn burst | `playSpawnPoof` **plus** `Emit(26)` in the box's colour | *it just arrived* | `Debris` |
    | prize burst | `Emit(32)`, coloured by `AbilityKind` | *you got the Freeze one* | `Debris` |

    **The brief was wrong about where the animations live and about the ring, and both corrections are the interesting
    part.** It wanted `stepMotion` extended and a `Beam` ring "between two attachments on opposite sides" — a `Beam`
    between two points is a straight ribbon, so that construction draws a bar *through* the box, not a ring round it. A
    real torus is a mesh, and the brief's own rule forbids new assets; the answer is two crossed bars, which read as an
    orbital band from any angle a player can stand at and need no upload. And the animation went into `stepMotion` as
    asked — **no `TweenService` anywhere**, and no second loop: `stepMotion` already owns the clock and already runs
    once a frame while a box is out, so it hands `animateMysteryBoxVfx` its `time()` reading rather than letting a
    second module take a third one.

    **The one design decision worth arguing: the ring bars are *not* children of the box, and everything else is.** A
    part's children are destroyed with it, so the aura, the pillar and the light need no teardown at all —
    `remove`, `sweepField` and `forgetLostSpawns` are unchanged in that respect. The bars could have had the same deal,
    except that a `BasePart`'s `CFrame` is unambiguously **world space** under `Workspace` and *not* unambiguously world
    space when its parent is another `BasePart`. Betting on that reading would have put the ring at twice its offset and
    rotated it about the wrong origin if the bet was wrong, and nothing in this repo settles the question. So the bars
    live in `Workspace`, are placed each frame from the pose `stepMotion` has just written, and `disposeMysteryBoxVfx`
    exists — called from all three teardown paths, idempotent, and named for the fact that it is the one leak this
    otherwise-all-children design could have.

    **Two smaller things the pass fixed on the way.** `place` hard-coded `Color3.fromHSV(0, …)` — pure red — and let the
    rainbow correct it up to a third of a second later, which is a glitch on the one frame a player is most likely to
    be looking at the box: `shadeNow()` is now the cycle's arithmetic out of its loop, called by both `place` and
    `cycleColours` so the two cannot disagree. And the six `?` glyphs got `TextStrokeColor3` /
    `TextStrokeTransparency = 0.5`, because the box is `HSV(hue, 0.65, 1)` and an unbroken white glyph vanishes against
    the yellows and greens of the wheel — a legibility fix, not decoration. **The `?` faces were kept**, as the brief
    asked: `FACE_DECAL_ID` is still `""` and the text branch is still the stand-in that an uploaded texture replaces.

    **The aim guide cannot see any of it, and that was checked rather than assumed.** All four ring/burst holder parts
    are `CanQuery = false`, and `Beam`, `ParticleEmitter`, `Attachment` and `PointLight` all extend `Instance` — not
    `BasePart` — so they are invisible to every raycast in the game. The bars are also untagged, so `looseBalls` (which
    filters on the `Ball` tag) cannot mistake them for a ball a rig should fetch. **No risk to the trajectory preview or
    `CHARGING_ATTRIBUTE`**: no throw, aim or charge code was read.

    **`mystery.config.ts` is untouched.** `HOVER_*`, `RAINBOW_*` and `FACE_DECAL_ID` are all still read by the motion and
    colour loops, so nothing became irrelevant as the brief suspected. The new numbers live in the VFX module as
    **Placeholder.** constants, on the argument that a purely visual tuning number belongs beside the code that spends
    it — the same split `notifications.ts` makes for the toast stack's geometry.

    **Cost, since it was asked for.** Three boxes at `MAX_TOTAL`, plus the practice floor's unbounded ones: one emitter
    at 6/s and one at nothing (the bursts are manual), two 12-triangle bars, one beam with ten segments, one light. Per
    box, per frame: two `CFrame` writes for the bars plus one `Brightness` write. Per box, per colour step (3/s): two
    `Color3` writes and one `ColorSequence` allocation.

    **Unverified**: every pixel of it. Whether the pillar reads as a beacon or as a smoky column at `PILLAR_ALPHA_BASE`
    (0.55), whether 32 sparkles is a pop or a fog, and whether `rbxasset://textures/particles/sparkles_main.dds`
    resolves on this client — that last one is the only *functional* unknown, and the fallback is deleted-line simple:
    no `Texture` draws a soft square that still reads as a mote.

    **The ring was wrong, and the report was four words: *"remove the sticks poking out"*.** The two crossed `Neon` bars
    were the one layer built from a guess rather than from a measurement, and the guess was that they would read as an
    orbital band. They read as sticks, for a reason that should have been obvious before the first line was written: **a
    solid ring round a box has to be wider than the box, so its silhouette from any angle a player can stand at is two
    nubs — and two *straight* bars are the worst version of that, because they end abruptly in mid-air with nothing
    connecting them.** A ring that reads as a ring is a torus, a torus is a mesh, and a mesh is an upload the brief
    forbade. **The equator is simply unmarked now, and that is the honest answer rather than a smaller ring.**

    **Removing it made the module strictly better, which is the part worth recording.** The bars were the only layer
    that was not a child of the box — they lived in `Workspace` because a `BasePart`'s `CFrame` is unambiguously world
    space under `Workspace` and *not* unambiguously so under another `BasePart` — so they needed
    `disposeMysteryBoxVfx` and a call in all three teardown paths, and `stepMotion` needed a `pose` local to hand the
    animation. **All three of those are gone.** Every layer that is left is a child of the box, the three teardown paths
    are byte-for-byte what they were before this pass, `stepMotion` is back to its original one-line `CFrame` write plus
    one `Brightness` call, and `animateMysteryBoxVfx` lost its third argument. The look is now aura, pillar, light and
    two bursts, and **nothing in it is a `BasePart`** — which is a second, unplanned win: `Attachment`, `Beam`,
    `ParticleEmitter` and `PointLight` all extend `Instance`, so the aim guide cannot see any of the layer by
    construction rather than by a `CanQuery` flag somebody has to remember.

    **Not changed**: the aura, the pillar, the light, both bursts, the two `?` faces, the `Highlight`, and every
    constant that survives. `mystery.config.ts` is still untouched.

100. **The celebration now says whether you won, and the loading screen is gone.** The word is `VICTORY`, `DEFEAT` or
     `DRAW` in the middle of the screen for the length of `ARENA_CONFIG.CELEBRATION_SECONDS`; the join overlay was
     deleted along with its `ScreenGui` and both of its doc references.

     **Three attributes are read, and each answers a question the other two cannot.** `CELEBRATING_ATTRIBUTE` is
     *when* — the hold is the only window this word belongs in. `ROUND_WINNER_ATTRIBUTE` is *what* — and it cannot
     carry the window on its own, because it is written when the round is decided and cleared only at the **next
     round's start**, so a word drawn off it alone would still be on screen through the lobby transition. The local
     player's `TEAM_ATTRIBUTE` is *whether it is good news*, which is a fact about this player rather than about the
     round: the same winner is a victory for one side and a defeat for the other.

     **Two derivation rules are load-bearing and both are commented in the module.** The **draw is tested first** —
     `"draw"` equals neither side's label, so a "does the winner match my side" check written first would tell *both*
     teams they lost a drawn round. And **an empty winner is "no result", not a loss**: the attribute is cleared to `""`
     at every round start, so a client that mounts mid-round or reads a stale window would otherwise get `DEFEAT` over
     a round it is still playing. A player with **no side at all sees nothing** — a spectator is not a loser.

     **A plain module, not a controller, and the brief asked for a controller.** `main.client.ts` is a list of
     `startX()` calls for exactly this kind of thing — `perfectDodge`, `catchPrompt`, `returnToLobby`, `hitConfirm`,
     `enemyView` — and the file's own note says why: **Flamework records an exported class in `flamework.build` whether
     or not it is decorated**, so a class here would buy a manifest entry and nothing else. There is no lifecycle to own,
     nothing to inject, and one pair of subscriptions.

     **The letters are the theme's ink, not green and gold, and the reason is in the code rather than in taste.**
     `actionSplash.ts` argues at length that the colour carries no meaning on purpose — the *word* is the message — and
     more concretely **this game already spends red on team A** (`TEAM_COLORS`, `PREMIUM.sideA`), so a red `DEFEAT`
     would collide with the scoreboard's own vocabulary and a green `VICTORY` would be a colour the Premium Sports
     palette does not have. `PREMIUM.gold` is cyan. **The style is `styleSplashText` unchanged**, with
     `strokeThickness: 6` rather than the action splash's `4` because this box is 240 pixels tall against the splash's
     150 — the same relative weight, which is the rule that file already applies to the catch prompt.

     **The box is sized in `Scale` rather than in pixels plus a `UISizeConstraint`**, which is the opposite of every
     other fixed-pixel HUD in this client and is right here: those take pixels because a big-ui panel needs a definite
     width and then cap themselves against the viewport, while a centred line of `TextScaled` text needs no definite
     width at all. 86% across leaves room for the outline, which is drawn *outside* the glyphs.

     **The loading screen went with it, and the prompt's instructions for it were wrong in two places.** There was no
     `startLoadingScreen()` call to remove — `LoadingScreenController` was a `@Controller` and Flamework loaded it from
     `Flamework.addPaths("src/client/controllers")`. And `SplashGui` was not shared with the wipe: `getSplashScreenGui`
     had exactly one caller, so the accessor, `SPLASH_GUI_NAME` and `SPLASH_DISPLAY_ORDER` all went, and
     **`TRANSITION_DISPLAY_ORDER` moved from `2` to `1`** because a rung held empty under a component that has to beat
     exactly one other is a number that lies about what it is for. Seventeen doc passages in `screenGui.ts` asserted a
     join splash existed and were rewritten; `HitLogController` and `RoundService` each cited the controller as the
     worked example of the `task.wait`-accumulation rule and now cite the rule instead.

     **`git diff --stat flamework.build` is not silent, and it cannot be: it is one line, the deleted controller.**
     That is the change the constraint was meant to catch if it were accidental — a deliberate deletion is exactly what
     it should show, and the *absence* of a second line is the evidence that the overlay did not need a controller.

     **Not changed**: the hold's duration, the coin toast, the transition wipe, and the server — every attribute read
     here was already published.

     **Unverified**: whether the word is legible against a bright court at 86% width, whether 240 pixels of box is
     "large" or "too large" on a phone in portrait, and **whether the game looks right with no join cover at all** —
     that last one is the real risk of this pass and it is a first-impression question rather than a logic one. A client
     now sees the lobby, the HUD and its own body appear as they replicate, which is what the overlay was hiding.

101. **Score Rush has a mercy rule at 20 and a warning at 15.** A lead of `MERCY_RULE_LEAD` ends the round on the
     spot; five points earlier the losing side is told, once, in the notification stack.

     **The config file is `shared/config/gameMode.config.ts`**, inside `GAME_MODE_CONFIG` beside `SCORE_RUSH_TARGET`
     (30) — not `arena.config.ts`. **Both numbers are below the target**, and that is the point rather than a
     coincidence: the rule only ever earns its keep if it fires before the target does, and a lead of twenty is
     already a rout.

     **`outcome` cannot print, so the log line is the round's.** `ScoreRushMode.outcome` is a *query* the loop makes
     once a second, so a mode that printed would print a line per tick — and `finishRound` is the only thing that
     knows a decision has become final. The two therefore have to agree about *when* the mercy rule fired, and the
     way they agree is **one exported function, `mercyWinner(scores)`, called by both**: the mode returns its answer
     and `finishRound` prints `[Round] Team A won by mercy rule (20-point lead)` from the same comparison. Written
     twice, a change to one would leave the log describing a rout the other did not end on; `RoundService` already
     imports from that module, so the shared helper costs no new dependency. **Nothing is added to the `GameMode`
     interface** — a `why` on `outcome` would be ceremony for one line, and only one of the three modes scores.

     **The warning is a plain client module, not a method on `ScoreHudController`.** The bar's own doc is emphatic
     that it reads "the pair the round publishes and nothing else" — no phase, no mode — and a warning needs all
     three. Two subscribers to one fact is the shape `main.client.ts` already documents for `hitVfx` and `hitConfirm`
     ("neither should have to know the other exists"), so `client/mercyWarning.ts` is started from the boot beside
     `celebration.ts` and the bar's doc stays true.

     **The reset hangs off `ROUND_STATE_ATTRIBUTE`, not off the scores falling to nought, and the reason is a real
     replication hazard.** The server clears both score attributes as a round ends and the two writes replicate
     *separately*, so a client can legitimately observe `A = 0` beside a stale `B = 15` and compute a fifteen-point
     lead out of a round that is already over — a spurious warning arriving exactly as the round ends. **The phase is
     written once per boundary and cannot be seen half-applied**, so `hasWarned` is cleared on the `Playing` edge and
     the warning is only evaluated while the phase is `Playing`. That also means the flag cannot be reset by anything
     but a new round.

     **The window is `[MERCY_WARNING_LEAD, MERCY_RULE_LEAD)`** — at or above 15, below 20. The upper bound is not
     decoration: a lead that has already reached 20 is a round ending in the same second, and "the round is nearly
     over" printed *as* it ends is worse than silence. Both bounds are the shared config, so the warning cannot drift
     from the rule it warns about.

     **Every client draws it, so both sides see it.** The losing side is who it informs, but the leader is about to
     be handed a win it should be able to anticipate; publishing it from the server would be a remote and a second
     copy of a rule for a sentence the client derives from two numbers it already has. The leading side is **named**
     — `Warning: Team A is 15 points ahead!` — via `sideNameOf` with the published mode id, so a mode with different
     side names is still right.

     **Not changed**: how points are scored, the target, the celebration hold, and `notifications.ts` — the toast it
     already offered took no change.

     **Two testing supports came with it, because neither threshold is reachable by playing.** `!dev score <a|b>
     <points> [<other>]` (`RoundService.devSetScore`) sets a side's points outright — the shape `!dev setMoney` uses,
     and for its reason: the *value* is what is under test and no sequence of hits reliably lands on 15-and-not-16. It
     takes a side and a value both, refuses four ways with a message naming what was wrong (missing argument, not a
     side, not a whole number, a mode that keeps no score), and **refuses outside a playing round** — `scores` is
     cleared at both ends of a round's life, so a value set in an intermission would be wiped before it could be read,
     and saying so is better than letting the next tick silently erase it. It deliberately does **not** end the round
     itself: setting 20 lets the loop's own `roundOutcome` fire `finishRound` through exactly the path a real rout
     takes.

     **The optional third argument and the confirmation line both exist because of one misread test.** The first pass
     printed `score set — A 15, B 5 (lead 10)` and that was read as a warning that had failed to appear: the rule is
     about the *lead*, and `A 15` with `B` on 5 is a lead of ten, so nothing was broken and the message did not say so.
     Two changes: `!dev score a 15 0` sets both sides **in one write, published once**, so the state the warning wants
     is one command rather than two calls that also flash an intermediate pair past the client; and the confirmation
     names the band the lead landed in — `below the 15-point warning`, `the 15-point warning fires on the client`, `the
     20-point mercy rule fires on the next tick` — through `RoundService.thresholdOf`. Both bands read the same two
     config constants the rule and the client use, so the line cannot drift from them.

     **The warning has a sound** — `AUDIO_CONFIG.MERCY_WARNING` (`rbxassetid://118488367803012`) at
     `MERCY_WARNING_VOLUME` 0.8, played by `client/mercyWarning.ts` on the same frame as the toast. It is the one clip
     in `AUDIO_CONFIG` that is a *goad* rather than a reward: a five-point notice is useless to somebody watching the
     ball, so it has to beat the round's music (0.3) rather than sit with the cues a player is already looking at. The
     `Sound` is made once at boot in `SoundService` and `PreloadAsync`'d by name, because a warning whose clip is still
     downloading has warned nobody. **It is a fifth copy of `perfectDodge`'s six-line `makeSound`**, which that file
     already names as the place a consolidation pass should start from.

     **Unverified**: the clip's *character* — whether it reads as an alarm beside the round music and is distinct from
     `PERFECT_DODGE`. The three to listen to together are this, `PERFECT_DODGE` and `COUNTDOWN_BEEP`: the things that
     play *at* a player rather than with them.

     **Unverified**: whether 20/15 is the right pair — both are **Placeholder.**, and the ratio to a 30-point target
     is the thing to play rather than reason about. Whether a round can *reach* 15 cleanly in a normal match is the
     same question from the other end: if most rounds end 6–4 on the clock, this rule and its warning will never
     appear at all, and the numbers to move are the two in `gameMode.config.ts`.

102. **The mercy warning is a standing line in the round-status band now, not only a toast.** A toast fades; the
     state it describes does not. The lead that triggers it stands for as long as the opponent fails to close it, so a
     player who looked away for the two seconds the toast was up had no way back to the fact — and the band is the one
     element on screen for the whole of a round that is already about the round's state.

     **The rule was extracted rather than copied.** `mercyWarningFor(scoreA, scoreB)` is now an export of
     `client/mercyWarning.ts` returning `{ leading, lead }` when the lead is inside `[MERCY_WARNING_LEAD,
     MERCY_RULE_LEAD)`, and **both readers ask it** — the toast and sound from that file, the band line from
     `RoundStatusController`. Two copies of the window would be two things to keep in step, and the whole point of the
     band is that it says the same thing the toast said. A plain export rather than a service, because it is four
     lines and has no state; the argument for the window lives at the function and the two former copies of it now
     point there.

     **The figure is the lead that is standing, not the threshold.** Both readers used to print `MERCY_WARNING_LEAD`
     verbatim, so a catch that carried the lead from 13 to 18 announced "15 points ahead" beside a scoreboard reading
     18–0. `mercyWarningFor` returns the number it judged, and both use it.

     **Two `Computed`s and a `Hydrate`, and each part is load-bearing.** `warningLine` turns phase + both scores +
     the mode id into `Team A +15` (or `""`), reading every value before any branch for the reason the clock's own
     `Computed` gives; `warningVisible` exists only because `Hydrate` takes `UsedAs<boolean>` rather than a callback;
     and `Hydrate` is what makes `Visible` and `TextColor3` tracked at all, since `Text` takes its props at
     construction. **`Visible` doubles as the space**: `Card`'s own `UIListLayout` charges its 8px `childGap` between
     *placed* children, so a zero-height label left visible would hold a gap open under the clock for the whole match,
     and an invisible child is not laid out.

     **The band gates on the phase as well as the window**, which the toast does not need to: the scores outlive the
     round that set them by however long the server takes to clear the pair, so a band reading only the lead could sit
     on `Team A +15` through an intermission describing a round nobody is in.

     **The colour is the leading side's** (`PREMIUM.sideA` / `sideB`), not a new "warning" colour: `premiumTheme`
     refuses a success/warning/error trio on purpose, and the one thing the line is about is a side the palette
     already has a colour for — the score plate a few pixels above says the same name in the same colour. The line is
     `overline` (11px) under the clock's 14px, which is both the hierarchy the fact has and the width budget: the band
     is 100px, and the same words at 14px would wrap to two lines and grow the card mid-round.

     **Also corrected in passing**: the comment at `addViewportConstraint` in that file argued about `HUD_WIDTH` as a
     "fixed 360px". The value is `100` and has been; the paragraph had outlived it, which is the drift this file keeps
     warning about.

     **Unverified, and two distinct claims**: that `UIListLayout` skips invisible children (taken from the engine's
     documented behaviour and the reason the card does not grow, but not seen), and that `Team A +15` fits one line at
     11px in 92px of usable width (arithmetic, not a measurement). Nothing here has been looked at in Studio.

103. **Every diagnostic in the game goes through `shared/logger.ts`, and the per-file `const DEBUG` flags are gone.**
     **The premise worth correcting first: this was not a new problem.** `debug.config.ts` records a logging pass on
     2026-10-19 that set all 74 flags to `false` by hand, for frame time in the Output panel. That mechanism worked, and
     it had a fault that only matters in a published game: **Roblox does not strip `print` or `warn` from a published
     place**, so 74 flags set `false` in a *diagnostic* sense still left several hundred `print` calls running on live
     servers for an audience of nobody. The flags decided Studio verbosity; nothing decided production, and nothing
     could, because a publish was not a state any of them could see.

     **Four functions, one gate.** `logInfo` and `logWarn` branch on `IS_STUDIO` (read once from `RunService.IsStudio()`)
     and do nothing else on a server; `logError` always emits, and is the only tier that survives production;
     `logDebug` emits only when Studio *and* `DEBUG_CONFIG.VERBOSE_LOGS`. That last pairing is what let the 74 flags go:
     the noisy tier they used to gate is one config value now, so bringing it back is a single edit rather than 74 —
     and `debug.config.ts`'s complaint about a switch somebody had to remember to flip is answered rather than
     repeated.

     **`logWarn` is silent in production, deliberately.** A warning reads as "somebody should look at this", and a live
     server's log stream has no reader, so the decision is not to throw information away but to stop producing
     information nobody reads. **`logError` is the exception and it is narrow**: 14 call sites, all in `StatsService` and
     `EconomyService`, all persistence — a store that would not open, a read or write that failed, a record another
     server had claimed, a shutdown that ran out of time. Those are data loss, they are invisible from inside the game
     (the player simply plays on blank figures), and silencing them would leave the only record of them in a session
     that happened to be in Studio. `grep -rn logError src/` is the whole list, by design.

     **The sweep: 596 `print` and 105 `warn` call sites across 98 files**, every one now through the logger, verified by
     counting raw calls in the emitted Luau — zero outside `logger.luau` itself. 219 single-statement verbose sites
     became `logDebug`; 178 multi-statement blocks kept a guard, because a block that computes its message (a
     `string.format`, a `GetFullName`, a packed layout) would otherwise build it on a live server and discard it — those
     guard on `DEBUG_LOGGING`, and 29 functions whose entire body is a diagnostic early-return on `LOGGING_ENABLED`.
     **That is the one place this file has a fifth and sixth export**: a function cannot stop its arguments being
     evaluated, so the flag has to be readable for the sites where the argument is the expensive part.

     **Two behaviour changes, both intended and both narrow.** The 74 `const DEBUG` declarations are deleted along with
     their one-line doc comments, and `debug.config.ts`'s opening block — which documented the per-file convention — is
     rewritten to describe what replaced it, since a comment arguing for a decision that no longer exists is the fault
     this file warns about. And the client and server boots each gain `[Boot] Logging active — running in Studio`, which
     is a claim about the half that is *meant* to talk and cannot appear on a server.

     **What the prompt got wrong, recorded because two of the three mattered.** It named `RoundService`,
     `BallComponent` and `NpcService` as files with `const DEBUG = true`; none of them had it — `RoundService` and
     `BallComponent` had no flag at all, `NpcService` and `BallService` had `false`, and only `MysteryBoxService` of the
     five was `true`. It asked for `(...args: defined[])` where `print` is declared `(...params: Array<unknown>)` in
     `@rbxts/types`, so the narrower type would have needed a cast at every site. And it asked for the pass to be
     recorded as §15 item 100, which already existed — this is item 103.

     **Unverified, and it is the only claim that matters to the person who reported the lag**: whether a published
     server is now cheaper. Everything above is arithmetic over call sites and a read of the emitted Luau; the frame
     cost that motivated it is a MicroProfiler reading nobody has taken. `DEBUG_CONFIG.PROFILE` is the switch for that
     reading, and it is still `false`.

104. **A rig animates walking if and only if a behaviour asked it to, and the velocity reading is deleted — items 52,
     53 and 79 are REVERSED, not superseded by a better version of themselves.**

     **Those three items are the record of a mechanism that was repaired three times and never worked**, and they are
     left in place as history: item 52 subscribed to `Humanoid.Running`'s speed as an edge and added
     `MoveToFinished` as the stop; item 53 found the rig a player's arrival stands down still walking, because
     parking it fires neither edge; item 79 added a watchdog that counted three turns of physical stillness to catch
     a shove, because a shoved rig is neither walking nor finishing a walk. **Nothing in this repository now does any
     of that**, so read those three as the argument for what replaced them rather than as a description of the code.
     The failure they share is the lesson: **a watch on a body enumerates the ways a body can move, and the next
     report adds one.** Each repair moved the surprise rather than removing it.

     **The rule now, in one sentence: a rig animates walking iff a behaviour has set the intent, and physical velocity
     is not consulted at all.** `NpcLoop.walking` is the store, its doc names the three failures above so nobody has
     to re-derive a velocity reading to understand why it exists, and it has exactly five writers — the two helpers
     `walkTo` and `standAt`, the world gate in `NpcService.run`, `announcePlaced` for a body a mover has put
     somewhere, and `stopWalking`, which the two lobby boundary paths call. **`publishAnimationBody` reads
     `loop.walking`** and the emitted Luau is `local moving = loop.walking`.

     **Deleted in full**: `watchForStaleWalk`, `stillTurns`, `staleReported`, `runningSpeed`, the
     `Humanoid.Running` subscription, the `Humanoid.MoveToFinished` subscription (it existed only for the walk, and
     the prompt's question — keep or delete — is answered *delete*, because with intent stored there is no edge left
     for it to end), both connection fields, and `RIG_MOVING_SPEED`, `RIG_STALE_WALK_SPEED` and
     `RIG_STALE_WALK_TURNS` from `npc.config.ts`. `NpcService.forget` no longer hangs up anything, which is the whole
     of what it lost.

     **How a behaviour is given the two commands, and why the prompt's signature could not be used.** It asks for
     `walkTo(loop, position)` exported to the behaviour modules — but **a behaviour never receives the loop**:
     `tick(model, humanoid)` is handed a model and a humanoid, and the loop is one per rig, private to `NpcService`
     and created when the rig is tagged. So the two helpers are built once per loop and handed to `tick` as a third
     argument, `NpcMoves` in `Behavior.ts`. That is the same pair with the loop kept where it belongs; the interface
     is deliberately two methods wide (`walkTo`, `standAt`) with no `setWalking(value)`, because a setter would let a
     call site publish a walk it never issued, which is the original bug wearing a new coat.

     **Every one of the twelve `MoveTo` sites in `behaviors/` is routed** and `grep` returns none outside the
     helpers: `SeekBehavior` (two stops — its own `stand`, and the wander cleanup — and five walks: the pickup
     carry-through, the pickup window, the wander point, the mystery box, and the ball), `WalkToJoinPadBehavior`
     (three stops, one walk), `DodgeBehavior` (one run).

     **The one behaviour that could not clear its own walk, named: `DodgeBehavior`.** Every other walker ends its walk
     on something it observes — arrival, a lost target, a full hand — but a run has no arrival edge: the behaviour is
     asked only on its own interval and `MoveToFinished` is no longer consulted. Leaving it to whichever behaviour
     ticks next happens to work only because every rig wearing `Behavior_Dodging` also wears `Behavior_Seeking`, which
     is an accident of `GAMEPLAY_BEHAVIORS` and would break silently the first time a rig was painted with one tag
     and not the other. So the run remembers the point it was aimed at in `DodgeBehavior`'s `runTo`, and `finishRun`
     stands the body once it gets there — a **position** check against a point this behaviour issued, not a timer and
     not a velocity, so a rig another behaviour has since walked somewhere else is left alone.

     **The safety net was not added.** The prompt's `!loop.hasTickedThisTurn` rule guards a rig whose behaviours are
     not running at all — and the case that actually needed guarding (`DodgeBehavior`) *is* ticking, so the rule
     would not have caught it while adding a second generation of watchdog for the boundary case the two explicit
     clears already handle.

     **Both boundary paths were needed, and neither covered the other.** `setGameplayBehaviors` clears on the
     branch that strips the six tags, because the loop only notices a removed tag on its *next* turn and the report
     was a rig animating a walk for a tenth of a second after the round had ended. `parkRig` clears *before* the
     reparent, because a body in `ServerStorage` is not simulated and a `MoveTo` against it means nothing — and
     because a humanoid carries its `WalkToPoint` across a `Parent` write, so a rig parked mid-approach would have set
     off again on its next refill. Clearing at spawn covers neither: a restored rig is not spawned, it is the same
     body and the same loop.

     **`NPC_ANIM_MOVING_ATTRIBUTE` changed meaning rather than name** — it is the intent now, which is what its own
     doc had been apologising for since the measurement went in ("the name is kept although it is a slight lie"). No
     client changed: `RigAnimationController` reads the attribute and `animationFor` gets a boolean either way.

     **"All models", recorded as a standing rule rather than a note about rigs.** The player half already obeyed this
     — `LocomotionAnimationController` answers from `MoveDirection` and the given walk speed and has read no velocity
     since 2026-10-19 — so the pass changed nothing there and says so in `BodyState.moving` instead: **a body animates
     walking iff something told it to walk**, the player's "something" being input and a rig's being `walkTo`, and a
     third kind of animated model is to answer the same way and never from what it is doing.

     **Unverified**: all four cases the prompt names need a session — a shoved standing rig, a pad walk, a tag cleared
     mid-walk, and a parked rig returning. Nothing here has been watched in Studio.

105. **The round has a song now, layered over the room, and it repeats from its own middle.**

     **The premise needed correcting before anything was written: `MusicController` already had a track called
     `roundMusic`, and `AUDIO_CONFIG` already had `ROUND_MUSIC` and `ROUND_MUSIC_VOLUME`.** Those are the arena
     ambience — a crowd and a room tone, which the config's own doc calls "a room full of people". So the task's
     proposed `ROUND_MUSIC_VOLUME = 0.4` was a direct collision with the ambience's `0.3`, and reusing the name would
     have silently retuned the crowd. **The new track is named for what it is instead**: `ROUND_SONG_ID`,
     `ROUND_SONG_VOLUME` and `ROUND_SONG_FADE_SECONDS`, with the `Sound` called `RoundSong` beside the existing
     `RoundMusic`.

     **Additive, and nothing about the ambience moved.** Its id, its volume, its five-second clock-driven fades, its
     `Looped = true` and the `roundMusic.Stop()` on the round-end edge are all byte-identical; `git diff` on those
     lines is empty. The two are independent instances under `SoundService` and **under no `SoundGroup`** — there is
     no such group anywhere in this project, and the file argues against one at length, so per-track volumes are the
     only knobs.

     **The loop-from-the-middle rule, which is the feature and reads like a bug if you do not know it**: the first
     play is the whole track, `0` to the end; **every repeat after that runs from `TimeLength / 2` to the end**, so
     the first pass is twice as long as every later one. `Looped` is `false` on this `Sound` — the engine's own loop
     restarts at `0`, which is the one thing this track must not do — and the repeat is a single `Ended` handler
     connected once at creation. **`TimeLength` is read inside that handler rather than cached**, because a `Sound`'s
     length is `0` until the asset loads: by the time `Ended` has fired the track has just played through, so the
     value is known if it is ever going to be, and it cannot go stale the way a value read at mount could. A length
     still at `0` logs a `logWarn` and loops from `0` rather than being silent, and that warning names the line to
     check if the loop is ever seen restarting from the beginning.

     **The fade is counted on the existing `Heartbeat`, not tweened, and the reason is a race rather than taste.** The
     task asked for a `TweenService` fade followed by `Stop()`, which would need a `task.delay` for the stop — and that
     delay keeps running across a phase change, so a round ending and the next beginning inside 1.5 s (trivial for a
     dev forcing matches) would have the old round's delayed stop silence the new round's track. Counting the ramp in a
     third `Heartbeat` connection has no second timer to get out of step: the stop happens on the frame the volume
     reaches zero, and a phase that returns to `Playing` before the fade completes turns the ramp around so the zero is
     never reached. It also keeps the file to one fade mechanism, which the class doc demands ("do not simplify any of
     this into a tween"). **A third connection rather than more lines in the room's**, because that loop returns early
     once its own volume settles — putting the song's fade behind it would mean the fade only advanced on frames the
     *room* changed, so it would appear to work in testing and fail on the round-end edge, the only moment it matters.

     **The two knobs for the user's mix, named.** `ROUND_SONG_VOLUME` (0.4, `audio.config.ts:144`) is the music;
     `ROUND_MUSIC_VOLUME` (0.3, `audio.config.ts:82`) is the ambience. There is no master knob — no `SoundGroup`
     exists — so those two are the whole mix, and the song is set above the room on the argument that the room is
     texture and the song is content. Both must stay under `ROUND_WHISTLE_VOLUME` (0.6) and `COUNTDOWN_BEEP_VOLUME`
     (0.5), because those are cues.

     **Unverified, and it is the one number this pass cannot know**: whether `sound.TimeLength` is non-zero when
     `Ended` fires on the first play. If it is zero, the `logWarn` will say so and the fix is a `Loaded` signal to
     seed it. Also unverified: that both tracks sit together acceptably, that 1.5 s is not abrupt, and that the small
     gap at the loop point is acceptable — that gap is the accepted cost of a handler-driven loop rather than two
     staggered `Sound`s.

106. **"The crowd is not playing" — investigated, and the cause is NOT in the code that was suspected. No fix
     applied; instrumentation added instead.**

     **The report was that the arena ambience (`RoundMusic`) is inaudible during a round while the new song plays.**
     The three candidate causes were: the ambience's `Volume` written to 0 by the new code, `roundVolume` shared with
     `songProgress`, or the ambience's `Sound` stopped on the entering edge. **None of the three is present**, and the
     evidence is `git diff -U0` on `MusicController.ts`: the only lines that mention `roundMusic.` anywhere in the
     pass are two that *read* it to build a log string. There is no new write, no new `Stop()`, and no new `Play()`.
     The two ramps are separate fields (`roundFadeInElapsed` / `writtenRound` against `songProgress` / `writtenSong`)
     in separate connections, and neither reads the other. **The ambience's code path is byte-identical to the commit
     before the song existed.**

     **The log could not have confirmed anything, and that is itself the finding.** It contains **zero** `[Music]`
     lines and no mention of `song`, `Song`, `music`, `Music`, `RoundSong` or `RoundMusic` — because every one of
     this file's log lines is behind `DEBUG_LOGGING`, which is `IsStudio() && DEBUG_CONFIG.VERBOSE_LOGS` and
     `VERBOSE_LOGS` ships `false`. The pasted log is also server-only after `23:34:41`; the client's Output stops
     there, so the round's client-side lines were never captured. A claim that "the log confirms" a mix fault was
     being read off a file with no mix lines in it.

     **So this pass adds the instrument rather than a guess, and deliberately makes no behavioural change.** Two
     `logInfo` lines, both always printed in Studio (not `logDebug` — the silent-by-default tier is the tier that
     failed to answer this):

     - on the `Playing` edge: `[Music] Playing — ambience "RoundMusic" 0.00 (playing true), song "RoundSong" 0.00
       (playing true)` — proves the edge ran and both instances are running. **Every volume there is 0 by design**,
       which is why the prompt's proposed line on this edge would have proved nothing.
     - once per round, on the frame the ambience's ramp completes: `[Music] round mix — ambience 0.30 (playing true,
       loaded true, 42.0s), song 0.40 (playing true, loaded true, 97.3s)` — and that one line separates all three
       remaining explanations. **`playing false`**: it is not running. **`loaded false` or `0.0s`**: the asset is the
       problem and no volume in this file will fix it. **Both playing at their configured volumes**: nothing is
       broken and the crowd is being *masked* by the song, which is a question for `ROUND_MUSIC_VOLUME` (0.3,
       `audio.config.ts:82`) and `ROUND_SONG_VOLUME` (0.4, `audio.config.ts:144`) — not for this file.

     **Why no fix was applied, stated plainly.** A change made without a demonstrated cause is the "patch on a patch"
     this project has been bitten by three times on the rig-walk problem (items 52, 53, 79, all reversed by 104). The
     one thing this pass *could* do blind — lower the song, raise the crowd — is a mix decision for the user's ears,
     not a defect to correct. **The next session's `[Music] round mix` line names the cause in one grep.**

     **What is now known not to be the cause**: this pass's own diff, which is the ambience path untouched.

107. **The crowd was never missing — it was MASKED by the song, and the fix is the mix, not the code.** The player
     reported "nothing from the first track at all" a second time. The second investigation could rule the code out
     completely, by three facts rather than by elimination:

     1. **The song is heard, and `roundMusic.Play()` sits in the same `if` block as `roundSong.Play()`** — lines 464
        and 476 of `MusicController`, one branch, no early return between them. If one ran, both ran.
     2. **The ambience's volume does reach its configured value.** The round clock starts at
        `ARENA_CONFIG.ROUND_SECONDS` (`RoundService:4397`), so `ramp` is past its `ROUND_FADE_SECONDS` window and
        returns the base within five seconds of the round starting.
     3. **No asset failed.** `PreloadAsync` logs `[Music] sound did not load — <id>` on any failure, and the 886-line
        session log contains no such line, no `[Music]` line of any kind, and no mention of `song`, `music`,
        `RoundSong` or `RoundMusic` — because every `[Music]` line was behind `DEBUG_LOGGING` (Studio **and**
        `VERBOSE_LOGS`, which ships `false`).

     **So the fault was the numbers I chose, and the reasoning behind them was wrong in a way worth recording.** The
     song shipped at `0.4`, *above* the room's `0.3`, justified in this file as "the room is texture and the song is
     content". **That is backwards for a broadband bed**: crowd noise does not sit underneath a melody at comparable
     level, it is masked out of existence, so a mix that is measurably fine was perceptually a solo. The report
     "the first track is gone" is exactly what masking sounds like from the player's seat, and no amount of reading
     `Volume` would have shown it.

     **The correction**: `ROUND_MUSIC_VOLUME` **0.3 → 0.55**, `ROUND_SONG_VOLUME` **0.4 → 0.25**, so the room is the
     louder of the two. Both config comments are rewritten rather than left standing — the song's doc argued the
     ordering that has now been reversed, and the room's doc called the pair "a taste question", which this turn
     disproved. **The rule now written down: keep the crowd above the song.**

     **And the line that would have ended this in one run**: `[Music] tracks — "IntermissionMusic" 0.30 (43.0s),
     "RoundMusic" 0.55 (37.5s), "RoundSong" 0.25 (97.3s)`, printed once per client **inside the `PreloadAsync`
     callback** rather than beside it — `PreloadAsync` does not wait, so a report on the next line would read
     `0.0s` for good assets and send the next reader after a fault that does not exist. It reports `TimeLength`, so
     a genuinely silent asset shows as `0.0s` and is distinguishable from a mix problem for ever after. It is
     `logInfo` deliberately: the silent-by-default tier is the tier that failed to answer this twice.

     **Unverified**: that 0.55/0.25 is the right pair by ear, and — still — that the crowd's asset contains audio.
     The `[Music] tracks` line answers the second one on the next run.

108. **A rig stood in the jump clip for ever because `FloorMaterial` was asked a question it cannot answer.** The
     report: a rig on a join pad, animated as jumping, permanently.

     **`animationFor` answers `"jump"` for any body that is not grounded**, and a rig's grounded fact is one attribute
     with one writer — `publishAnimationBody`, from `humanoid.FloorMaterial !== Enum.Material.Air`. **`Air` is two
     different facts wearing one value**: a body genuinely in the air, and a body **the engine is not simulating**,
     which never reports a floor because nothing is running the contact solver for it. The second is not hypothetical
     — this file's own `ownForServer` doc names it ("a rig with an anchored root, or one welded to anything anchored
     cannot be walked by `MoveTo` either"), and the boot audit warns about it on every one of the templates:
     *"spawn clears this on every clone, but a copy dragged into the world by hand keeps it and cannot be simulated"*.
     A hand-placed rig — which is exactly what a `practiceThrow` drill is, and what several lobby models are until they
     are cloned — sits in that state for its whole life, publishes `AnimGrounded = false` once, and never publishes
     anything else, because the write is gated on a *change*. **One write, then a jump clip for the rest of the
     session**, with nothing in the log to say so: the diagnostic line had already printed once at spawn and a
     non-changing attribute prints nothing.

     **The fix is one line of combination rather than a new mechanism.** The state is now asked as well —
     `humanoid:GetState()`, the same read `LocomotionAnimationController` uses for its deferral, so this follows the
     player side instead of inventing a rule — and a body is airborne **only** when the state says `Freefall` or
     `Jumping`. `FloorMaterial` can still make a body grounded and can never make it airborne on its own. So an
     unsimulated rig (any state that is neither of those, with `Air` beneath it) reads grounded and stands, a genuinely
     falling rig still animates the fall, and the frame or two after a `PivotTo` — material not caught up, body never
     left the ground — no longer flashes the jump clip.

     **The diagnostic learned the same distinction.** `[NPC] <name>: off the floor while standing — Air, state
     <State>, owned by <owner>` now prints the state, because `Freefall` and `Physics` are different faults with
     different fixes: the first is a body that has fallen out of the world and needs catching, the second is an
     anchored rig and needs the place file fixing.

     **Unverified**: that this was the fault in the session that reported it. It accounts for every case the log shows
     — rigs handed to the world by hand, `Air` at spawn — but the same symptom has a second possible cause (a rig that
     falls out of the world and never lands), and that one is `Freefall` rather than a mystery. The state on the line
     tells them apart next time.

109. **The per-head record is an opaque white card with black text, and its lifetime is a post-game window rather
     than the intermission's length.** Two changes in one file, and the second was the one with a fault behind it.

     > **SUPERSEDED by item 112 — the card this item built is gone, and so is the record it went behind.** What it
     > diagnosed is still right: three passes went into styling a surface whose problem is that a `BillboardGui` is
     > drawn in the world, so its apparent size is a function of the viewer's distance to the body wearing it. Item 112
     > is the pass that stopped styling and deleted the surface.

     **The card did not exist.** `StatsBillboardController` had no container at all: the record was a big-ui `Text`
     parented straight into a `BillboardGui`, drawn onto the arena in the palette's *white* with a cyan halo from
     `applyTextGlow`. A comment in the file justified the white ink on the grounds that "the pill behind a head is the
     palette's plum" — **there was no pill**, which is why the halo was needed and why the line was unreadable the
     moment the background stopped being a static lobby. So a `Frame` named `Card` was added, filling the billboard
     canvas, with `BackgroundColor3 = hudTheme().colors.panel` (the palette's `paper`, `#FFFFFF`) and
     `BackgroundTransparency = 0`; the label moved inside it, took `hudTheme().colors.textPrimary` as its ink, and
     **lost its halo** — a stroke that existed only to make text legible against a transparent background, and the
     one thing on this element that a solid panel makes wrong.

     **`hudTheme()` rather than the `theme` the method is handed**, and that is deliberate rather than an oversight:
     the parameter is `premiumHudTheme()` (the plum direction), and a plum card is the surface the halo was
     compensating for. The paper theme is the one whose panel is white and whose ink is black, so it is asked for by
     name. **`textPrimary` is `Color3.fromRGB(0, 0, 0)`** — the prompt predicted `#141414`; big-ui's palette says
     otherwise, and the theme wins, because a near-black invented in this file would be a colour nothing else knows.

     **One style, permanently.** No per-outcome branch, no gold/red/grey: the resulting construction contains no
     `Color3` literal at all, only the two theme reads, which is what makes "no variants" checkable rather than
     promised.

     **The fault behind the second half: the card was gated on the phase, and the phase is the wrong clock twice
     over.** `Enabled` was `state === "Intermission"`, so the record was **absent for the ten seconds of celebration**
     — the phase is still `Playing` then, and that is the one stretch of a post-game where everybody is standing
     still with nothing to do — and then **stayed up for the whole intermission**, which is a card about a round
     nobody is in any more. Replaced by one window armed by `CELEBRATING_ATTRIBUTE` (written by `finishRound`, the
     earliest client-visible "the round is over") and closed by whichever of two boundaries arrives first:
     **`ARENA_CONFIG.POST_GAME_CARD_SECONDS` (15, `arena.config.ts`)** or **the next `Playing` edge**. A
     `cardGeneration` token makes a stale `task.delay` a no-op, so a round ending inside an unfinished window cannot
     have its card closed by the *previous* round's timer — the same class of bug the round song's fade avoids by
     not being a tween.

     **Which of the two transition problems was fixed: erased-with-host, not hidden-by-wipe — and the other one turns
     out to be impossible in this shape.** The card is a `BillboardGui` adorned to a head, so a `PivotTo` carries it
     and a destroyed body takes it with it; the window being *state* in `mount` rather than per-body means a respawned
     character gets a new billboard that is already inside the open window. But a `BillboardGui` renders in the 3D
     pass and is **drawn under every `ScreenGui`**, and the transition grid is a `ScreenGui` at `DisplayOrder` 1
     (`RoundTransitionController`, `TRANSITION_DISPLAY_ORDER`). **No `ZIndex` and no `AlwaysOnTop` can lift a
     billboard above a `ScreenGui`**, so the card cannot be made to render over the wipe without ceasing to be a label
     on a head. It survives the transition; the wipe covers it for the ~2.6 s it covers everything. `AlwaysOnTop`
     stays `false` — the file's argument that a body behind a wall is a body you cannot read still holds — and the
     limit is written at `makeBillboard` so the next reader does not try.

     **Also changed**: the badge strip and the record now share one window (the strip's own is 15 s server-side, and
     the two are one slot above a head, so two clocks could disagree); the record no longer returns for the rest of
     the intermission once the strip is empty; and `mountBadges` hides the *card* rather than the bare label, so an
     empty white slab is never left above a head while badges are up.

     **Unverified**: that the white panel is legible against a real arena, and that the card is up during the
     celebration and again in the lobby — the two frames to look at are the first second of the celebration hold and
     the first second after the wipe opens. **A round that starts inside fifteen seconds ends the window early, by
     design.**

     > **CORRECTED by item 110.** The white card was put on the wrong element — the hit/out record — and has been
     > moved to the round's *badges*, which is what "the post-game card" actually meant. The record is back to
     > transparent lettering with its halo, and its phase gate is restored. Read item 110 for the current state; this
     > item is kept because the *argument* about the phase gate missing the celebration is still the reason the badge
     > strip is styled as a card rather than as lettering. **Item 112 is where this ended: the card was withdrawn and
     > the strip is lettering again — so the phase-gate argument below is moot, because the strip no longer competes
     > with a record for the same slot.**

110. **The white card was on the wrong element. It is now the round's BADGES, the record is back to how it was, and the
     killer's record has its own card on the left during a kill cam.**

     > **HALF-SUPERSEDED by items 111 and 112.** The kill-cam card described here survives, smaller. The badge card does
     > not: item 111 deleted it and item 112 put the strip back as plain lettering, so everything here about a badge
     > *surface* describes a design that was tried twice and withdrawn twice.

     **The correction.** Item 109 put an opaque panel and a fifteen-second timer behind the hit/out **record** — the
     `Hits: n | Outs: n | Ratio: n` line above a head. That was the wrong element: the record is a standing fact about a
     body and reads correctly as lettering with its halo, which is what it is; **what needs a surface is the badges**,
     because those are the round's verdict on a player and they were bright neon text over a moving court with nothing
     behind them. `StatsBillboardController` was reverted to its pre-109 state by `git checkout` (the diff is empty),
     which restored `PREMIUM.text`, `applyTextGlow`, `Enabled = state === "Intermission"`, and deleted the card and the
     timer.

     **The badges UI is not a separate controller, and that is the prompt's error worth recording.** It is
     `StatsBillboardController.mountBadges` — the same `BillboardGui` on the same head, one slot with two contents. So
     there was no "badges UI" to find elsewhere; the badge *list* is the container, and it is now the card:
     `BackgroundColor3 = hudTheme().colors.panel` (the palette's paper, `#FFFFFF`), `BackgroundTransparency = 0`, a
     `UICorner` and a `UIPadding`, with the padding doing the work of turning a background into a card.

     **The badge ink had to change with it, and the loss is real rather than glossed.** `BADGE_COLOURS` was written
     explicitly "for a label with no background behind it" — bright, high-contrast, `neutral` at `#F2F2F2`. On white,
     nine units from the paper, that colour **vanishes**. So both lines take `hudTheme().colors.textPrimary` and the
     tone survives only as **opacity** on the description (`1 - BADGE_DESCRIPTION_CONTRAST`, the same ratio the old
     dimming used). **A praise badge and a rib badge now look the same**, and `BADGE_COLOURS` is exported and used by
     nothing on this side. Getting tone back means changing the surface, not the ink.

     **No timer was added, because the window already exists and it is the server's.** `BadgeService.publish` writes
     `BADGES_ATTRIBUTE`, clears it after `BADGE_WINDOW_SECONDS` (15) or on the next `Playing` edge, and `show` already
     answers `list.Visible = hasBadges`. A client-side copy of that clock would be a second timer that could disagree
     with the channel it describes — so `ARENA_CONFIG.POST_GAME_CARD_SECONDS`, added by item 109 and read by nothing
     after the revert, was **deleted** rather than left as dead config.

     **New: the attacker's record, on the left, during a kill cam** — `enemyView.ts`, a `Frame` named `EnemyRecord`
     anchored `(0, 0)` at `UDim2.fromOffset(LEFT_INSET, TOP_INSET)` in `getFullScreenGui()`, so it shares the caption's
     GUI and its reasoning: the HUD plane hides itself for a shot, so an element that must be visible *for the length of
     a shot* cannot live on the HUD plane. It is paper white with `textPrimary` ink — the only element in that file
     that is not plum — because it is a scorecard rather than a caption, and the caption's own stats line is a
     `caption`-sized footnote under a name. Left because the centre is taken: the caption is anchored `(0.5, 0)` and
     the top-left is the one part of the screen that is empty for exactly as long as this is up.

     **It shows `Hits`, `Outs` and `Ratio`, not `Catches`.** The codebase has no per-player catch count —
     `STAT_HITS`, `STAT_OUTS` and `STAT_RATIO` are the whole set — and the ratio is the number that answers "how good
     was this body" anyway. It is written on the shot **and live afterwards for a catch too**, which is a deliberate
     divergence from the caption: a catch's caption is a fixed sentence with no numbers in it (`caught your shot!`), but
     the card is a record and freezing it exactly when the record changed would be backwards.

     **The caption's own stats line was left alone, so the figures appear twice during a shot** — once small and centred,
     once large and on the left. That is stated rather than hidden: removing the caption's line is a two-line change
     (and its `STAT_HITS` subscription), and it was not taken because "add a panel" is what was asked for.

     **Unverified**: that the card reads well at the left edge on a phone, that white-on-arena is legible, and that the
     badge card's padding survives a strip long enough to wrap to its fourth row.

111. **`StatsBillboardController` is deleted. The per-head record and the round's badges are gone from every model,
     and the kill cam's left card got smaller.**

     > **REVERTED by item 112 — read that one, not this.** The deletion was a misreading: the badges were wanted, and
     > the record above heads was the thing to delete. This item is kept because its diagnosis of the *size* problem
     > is right and it is the third pass in a row to try to fix it with styling; item 112 records what the answer
     > actually was (letters, not paper).

     **The complaint and the evidence.** A screenshot of an intermission with a pale panel over most of the centre of
     the screen, `sniper` on it twice and a badge description under it — that is the badge strip, drawn per head, at a
     `BillboardGui` scale that turns four short lines into a wall. **Three passes of styling had gone into that strip
     (items 109 and 110) and all three were answering the wrong question**: the problem was never the colour of the
     surface, it was that a `BillboardGui` is drawn *in the world*, so its apparent size is a function of how close the
     camera happens to be to the body wearing it, and there is no layout that survives that. Deleting it is the fix
     that should have been reached two passes earlier.

     **So the whole controller is gone**, by `Remove-Item` rather than by disabling it: the per-head hit/out record, the
     badge strip, the card, the padding, `HEAD_WAIT_SECONDS`, the tag walk over rigs, the `CharacterAdded` mounts — 661
     lines. `flamework.build` loses exactly one line, which is the honest record of a controller that no longer exists
     and is the one case where a moved manifest is correct.

     **What that leaves behind, stated rather than discovered later.** `BADGES_ATTRIBUTE` and `CROWN_ATTRIBUTE` now have
     **no client reader at all**. `BadgeService` still derives and publishes a badge set that nothing draws;
     `CROWN_ATTRIBUTE` still drives `EconomyService.checkMilestones` and is otherwise inert. Both are labelled in
     `shared/constants.ts` and `shared/badges.ts`, and `BadgeService`'s header now says the choice explicitly: keep the
     derivation because it is the written half, and **delete the service and its five writers if no display is ever
     built** — do not leave it running for ever on the assumption that something will read it.

     **Fourteen comments named the deleted file and every one of them was rewritten or had the name dropped** — the
     sweep is the part that makes a deletion finished rather than merely compiled. Two kinds: citations of the bridge
     pattern (attribute read is a sample, not a dependency) where the citation was a list of examples, so the deleted
     name came out and the survivors stayed; and claims that had become false — `DodgeService`'s "a rig has a head for
     the badge strip to hang over", `rigTemplate`'s "a `Head`, because the client hangs the billboard on one" (the
     `Head` check survives at `warn`, but for the reason it always mattered: a rig without a head is assembled wrong),
     and `RoundService`'s "the badge strip is drawn above every head in the round".

     **The kill cam's record card shrank, and the heading is what went.** `150` wide with a `Stats` title above three
     15-pixel lines and `10` of padding became `132` wide, three 13-pixel lines, a `2`-pixel gap, `8` of padding and
     `2` at the top. **The title was the tallest row in the box and said nothing** — `Hits:`, `Outs:` and `Ratio:` name
     themselves. **Unverified**: whether this is small enough; the remaining levers are `RECORD_LINE_GAP` and the type
     size, both one number.

112. **Item 111 was wrong and is reverted: the badge strip is back above every head, smaller, and the hits/outs
     record above heads is what actually gets deleted.**

     **The message that corrected it**: "I don't see the badges anymore", with three `[Badge] … nothing shown — only
     rib badges` lines attached. **Those lines were not the fault** — they are rule 3 working, on players who had
     earned nothing but `sprayAndPray`. The fault was mine: item 111 deleted the only renderer the badges had.
     "That is not needed anymore for all models" meant the *record*, not the strip, and the pale slab in the
     screenshot was the badge card being too big rather than the badges being unwanted.

     **So `StatsBillboardController` is restored from `HEAD` and cut back to one job.** `flamework.build` is
     byte-identical to `HEAD` again. What was removed from the restored file: the big-ui `Text` record label, the
     `watchCount`/`countOf` bridge, `describe`, `STAT_HITS`/`STAT_OUTS`, `premiumHudTheme`, `PREMIUM`,
     `applyTextGlow`, and the `theme` parameter that existed to hand those colours down. What is left is the badge
     list and its mount. **That deletion is the one the owner asked for**: `Hits: n | Outs: n | Ratio: n` above a
     head was a second copy of what the kill cam's card says, in the worse place.

     **The card went with it, and this is the answer to "huge space at the top".** Item 110's white `Frame` —
     `BackgroundTransparency = 0`, `UICorner`, `UIPadding` — is gone; the list is transparent lettering again.
     **The empty band was the card**: the list measures the height of its *rows* and anchors its bottom edge to the
     canvas centre, so whatever the layout reserved above the rows showed as blank white panel with the text bunched
     at the bottom. A background over a body is a surface whose size every viewer re-derives from their own distance
     to that body, which is why three passes of styling never made it look right. Letters with their tone colour
     are the material for this; a card is the material for a screen-space panel.

     **Smaller, by type rather than by box.** `BADGE_NAME_SIZE` 16 → **14**, `BADGE_DESCRIPTION_SIZE` 12 → **11**,
     the line gap 1 → **0**, the row gap 5 → **3**, the canvas width 380 → **300** (`BILLBOARD_SIZE` is the
     truncation width and the height is a box nothing is drawn in). **`BADGE_COLOURS` is read again** — the neon
     table written for lettering over the world, restored along with the letters.

     **The two billboard constants moved house.** `BILLBOARD_OFFSET_Y` and `BILLBOARD_MAX_DISTANCE` were deleted from
     `ARENA`/`STATS_CONFIG` by item 111 and are now local constants in the controller: they are that billboard's
     layout, nothing on the server reads them, and the size of the box should not need a shared config entry to
     change.

     **Unverified**: whether `14`/`11` is small enough. The levers, in order of effect: the description size, then
     the row gap, then dropping the description line — the last is the one the owner has already declined once.

113. **The badge strip's vertical alignment was wrong in both of its auto-sized frames, and that is what the empty
     band and the clipped description were.**

     **The prompt described the healthiest possible version of this bug**: it reported a white container with empty
     space at the top, text at the bottom and the last line clipped — against a build where the container no longer
     existed (item 112 removed it). Both facts are true at once, which is why this item exists: **the container was
     removed and the misalignment that made it look broken was not**, so the next surface put behind this list would
     have broken in exactly the same way.

     **`UIListLayout.VerticalAlignment` was `Bottom` on the badge list and left at its default `Center` on each
     row**, in frames that size themselves. That is the one arrangement that cannot resolve in one pass: the layout
     needs the frame's height to place children against the bottom or middle of it, and the frame's height is the
     sum of those children. The engine settles it a row late, so with a background the strip showed **a blank band
     along the top and its last description hanging past the bottom edge.** Both are now `Top` — the list and the
     row — where the height is an answer rather than an input. **`Top` at the list does not mean the strip grows down
     over the body**: the list's own `AnchorPoint = (0.5, 1)` still pins its bottom edge to the canvas centre, which
     is what makes the whole strip grow upward.

     **The list's `Position` is now an offset rather than a scale**, half of `BILLBOARD_SIZE` on each axis. It was
     `fromScale(0.5, 0.5)` beside an offset `Size` — the one inconsistency the comment above it already argued
     against, since a scale resolved against a `LayerCollector` is the part that is easy to get wrong. The canvas'
     centre is now stated rather than resolved.

     **Nothing here sizes by arithmetic and nothing needs to**: the list, each row and each line are all
     `AutomaticSize.Y`, every label carries a `TextSize` (never `TextScaled`), and `TextTruncate = AtEnd` is what
     keeps a long description one line. There is no `UIPadding` and no container, so the "symmetric padding" half of
     the pattern does not apply — the strip has no edges to keep text off.

     **Unverified**: that the strip now reads as a tight block in Studio. This one is worth the owner's eyes,
     because the last three passes here were each judged from a screenshot and each was wrong about the cause.

114. **The white card is back, and this time the layout underneath it is one that can work: `AutomaticSize.XY` at
     the centre of an oversized canvas, `Top` at both layouts, nothing sized by scale inside an auto parent.**

     **What the screenshot showed**: green and white text mashed together, rows drawn on top of one another. Item
     113 had fixed the *alignments* but left the strip on the arrangement behind them — a list anchored to its own
     bottom edge at the canvas centre, sized `300 × auto`, with rows at `Size = (1, 0, 0, 0)`. **That row size was
     the overlap**: a scale-width child inside a frame that is deciding its own width is a circular question, and
     the engine's answer is a row with no width and a position it re-resolves each frame — so the two lines of a
     badge and the next badge all landed in the same place.

     **The structure now**, and every link of it is standard: a `Card` `Frame` with `AutomaticSize.XY`,
     `AnchorPoint (0.5, 0.5)`, `Position (0.5, 0.5)` on a `400 × 400` canvas, `hudTheme().colors.panel` at
     `BackgroundTransparency = 0`, a `UIPadding` of `8`; a transparent list with `AutomaticSize.XY` inside it; a
     row per badge with `AutomaticSize.XY` and **no `Size` at all**; two `TextLabel`s with `AutomaticSize.XY`,
     `TextSize` 14 and 11, `TextWrapped` off and **no `TextTruncate`** — an auto-width label has no width to
     truncate against, so the card grows to the longest sentence instead, which is what hugging the text means.

     **Both layouts are `Top`, and that is stated twice in the file because it has now been the bug twice.**
     `Bottom` (item 110's card) and the default `Center` (the rows) both need a frame's height in order to place
     children against it while the height is the children — the arrangement settles a frame late, which is what
     produced the empty band at the top of the old card and the clipped last line. Row size by scale is written
     down beside it as the second hazard.

     **The ink is the theme's, not literals**: `hudTheme().colors.panel` is `#FFFFFF` and
     `hudTheme().colors.textPrimary` is `#000000` — exactly the values the request named — and both come from the
     palette so the card is the same white as every other panel. **`BADGE_COLOURS` is deleted** from
     `shared/badges.ts`: it was a table of three bright colours "for a label with no background behind it", and on
     paper `neutral` (`#F2F2F2`) is nine units from the page. `tone` still exists and still decides whether a set
     is published at all (the rib rule); it no longer chooses a colour anywhere.

     **The hierarchy is size and weight, not colour**: the name in `UI_FONT` (`GothamBlack`) at 14, the
     description in `GothamMedium` at 11. One ink, two weights — the alternative, dimming the description's colour,
     is exactly what stops working on white.

     **Two things to look at in Studio**: whether the card sits over the face on a short body (the answer is
     `BILLBOARD_OFFSET_Y`, not a different anchor — the card is centred on the canvas by design), and whether the
     longest description makes the card too wide for a phone, since nothing truncates any more.

115. **The perfect dodge fired on the dodger's own ball, and the side filter item 40 asked for landed beside it.**
     Both halves are the class item 40 names — a contact that writes no tag — and the own throw is the member the log
     actually showed.

     **The evidence, from one server session.** Eleven of the twelve `[Dodge] prospeed1: perfect dodge` lines were
     preceded within ~50 ms by `[Catch] DodgeballBall: own throw reached prospeed1 — no window, no damage`; the
     twelfth was `own throw reached VelvetVenom8`, an enemy rig's ball passing prospeed1, which is the behaviour
     worth keeping. `BallComponent.handleTouch`'s own-throw branch offers the catch and then `return`s **before any
     tag is written**, so `BALL_TAGGED_BODIES_ATTRIBUTE` is empty for that contact and item 38's tag gate cannot end
     the watch on it. **The watch had no thrower filter at all** — it sampled every entry of `armedBalls()` and
     measured the closest approach of all of them, which is what the twelve lines were reporting.

     **Two filters, in `DodgeService.watchForPerfectDodge`, both before the ball is sampled.** Own throw compares the
     ball's `ThrowerId` with the body's `THROWER_TOKEN` — the same two strings `BallComponent` compares to refuse
     self-damage, so "this ball is mine" has one definition rather than two. Same side compares the new
     `BALL_THROWER_SIDE_ATTRIBUTE` with the dodger's own side, resolved as `(GetPlayerFromCharacter(model) ?? model)`
     because a player's `TEAM_ATTRIBUTE` is on the `Player` and a rig's is on the rig. **`""` is not compared**: a
     lobby throw and a practice-zone player's throw have no side, and treating "no side" as a value would make two
     side-less bodies teammates — their own throws are still caught by the first filter. A drill's ball at a
     practice-zone player is the one case neither filter answers, and it is still open.

     **The stamp is written in `BallService.throwBallBody` beside `ThrowerId`** — same function, a comment apart —
     through the file's own `sideOfBody`, so a ball caught and re-thrown carries the new thrower's label and a ball
     that outlives a round change cannot carry the old one. It lives on the ball rather than being asked of the round
     at read time for item 40's cycle reason. **`RoundService.throwerOf`'s note that the stamp "was rejected" is
     corrected there**, because the code now does it and a comment arguing against its own codebase is the fault this
     file keeps recording; the rig scan stays, because a caller there needs the *body* and not a label.

     **`PERFECT_DISTANCE` is `8`, and its own doc said `4`.** The 2.5–7.7-stud figures are all below the shipped
     threshold, so this was never a threshold bug — the sentence above the constant was stale, and now says eight and
     records the mismatch. `PERFECT_WINDOW_SECONDS` is still 0.6 and is still `deadline`'s only term; `PREDICTED_HIT_RADIUS` is
     untouched and used only by `stillOnCourse`.

     **The skip lines are `logDebug` and once per ball per watch**, held in `skipped`, because a spent ball near the
     dodger would otherwise print on every frame of the window. **Unverified in Studio**: that a bounce-back no
     longer captions — the evidence is the *absence* of the perfect-dodge line, or
     `[Dodge] DodgeballBall: skipped — prospeed1 is its own thrower` with `VERBOSE_LOGS` on — and that an enemy
     rig's ball still does, which is the twelfth line's shape. No client module changed: if the filters hold, the
     caption and its clip simply stop appearing on the wrong ball.

116. **Four of a MultiBall window's five spent balls now leave the arena once they land.**
     `BALL_DESPAWN_ON_LAND_ATTRIBUTE` is written by `BallService.throwBallBody` — `true` when the window still holds
     a throw after the spend, cleared when it does not — and read by `BallService.settleLooseBalls`, which destroys a
     marked ball that is disarmed and `isOnGround`, with the ordinary spawn poof.

     **The first cut cashed the marker in `BallComponent`'s world branch, and the report was that it was too fast.**
     That branch is the end of the *throw*, not the end of the ball's fall: a tagged throw can be finished by another
     *ball*, so a shot into a rig's chest can end at head height a frame after the tag. The log is exact — a ball
     tagged the rig at `17.860` and was `ended on DodgeballBall — 1 tag(s)` at `17.877`, and the throw was gone
     beside the body it hit. **The destroy moved to the sweep**, which already walks every loose ball and already owns
     `isOnGround`; the ball is allowed to fall and is taken when it is resting on something.

     **The arithmetic, unchanged by that move.** `consumeMultiBallBall` returns a boolean — "there was a window to
     spend" — and it answers `true` for the fifth throw too, because it closes the window on the way out. So the
     survivor cannot be read from that return; the test is `isMultiBallActive` **after** `refillFromBuff(model,
     true)`, which is the same question that decides whether a replacement ball is supplied. Throws 1–4 find the
     window open and are marked; throw 5 finds it closed and is not. **A player who dies after three throws leaves
     zero balls from that window** — those three landed and went, and the window never reached its survivor. Keeping
     one in that case would need either a per-owner "last thrown ball" record to unmark on `clearMultiBall`, or a
     first-throw-survives rule, which needs the count *before* the spend and a second query on `SuperService`.

     **The marker is re-decided on every throw, not only written when true**, because a ball is thrown, caught and
     thrown again. Leaving an earlier `true` on a ball that becomes somebody's fifth throw would destroy the one ball
     the window was meant to leave behind; `undefined` is written instead, so an ordinary ball carries nothing.

     **A caught ball is untouched**: a catch goes to a hand, where the sweep does not look. If the catcher throws it,
     the marker is decided again by *their* window, so a MultiBall ball re-thrown by somebody with no window is an
     ordinary ball. A marked ball that is **dropped** instead keeps the marker and will be taken on the floor — the
     consequence of the rule as asked rather than a second one.

     **The poof is the bay despawn's**, `playSpawnPoof(undefined, ball.CFrame)`: a ball is a `BasePart` with no body
     for the helper to find a torso on, so it is anchored to the ball's own frame. `BallTrail`'s ribbons and
     attachments are children of the ball and go with it; the `Destroying` hook sees `Armed` false and stays silent;
     the pending `scheduleBallExpiry` timer is guarded on `Parent === undefined` and no-ops; the bay timer's row is
     deleted on the way out, as it is for a ball that leaves the world.

     **Unverified in Studio**: one window leaving exactly one ball on the floor and four poofs. The landing line
     `[Ball] DodgeballBall #N: ended on <part> — N tag(s)` prints for all five, before any despawn; with
     `VERBOSE_LOGS` on the four marked ones add `despawned on landing — a MultiBall throw with the window open` on
     the tick after they touch down; the fifth prints the landing line, no despawn line, and is still in
     `Workspace`. The visible check is the ball staying with the model it hit and vanishing once it reaches the
     floor.

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

**The 2026-10-23 perfect-dodge pass is half recorded below, and the halves are worth telling apart.**
The **server** rule was seen running — five reports in one fifty-second session, four from rigs and one from a
player, with no error anywhere — so `[Dodge] <name>: perfect dodge — the ball missed by N studs` is an
observed line and the player branch that sends the event is observed too. **But one of those five was a false
positive** (§15 item 38): `prospeed1`'s report came 281 ms after the same body was tagged, and the fix — a
tag-list gate and a health gate — has been simulated rather than seen. **Nothing on the client half is
observed**: `client/perfectDodge.ts` prints only behind its own `DEBUG`, so the caption, its position and the
`h6` size are still readings of the code. §15 item 38 says which flag to switch to close that gap.

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
  *absence*, and the reason item 14 exists. **The code that printed it has since been removed**:
  the spectator branch was changed to `HitVictim` at the user's request, and the neutral name went
  with it (§15 item 58), so this line can no longer be produced. What it still confirms is the fact
  it was about — there was no neutral template in the place file on that date — which is the reason
  the bystander case is red rather than white for a reason other than taste.
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

**The 2026-10-24 rig-animation reports did confirm one engine fact outright, and it is the kind of thing that
is only ever learned this way.** `Humanoid.Running` does **not** report a stop: in the `00:21` session,
**seven of the eight rigs** printed `[NPC] <name>: the walk ended with the speed still N.NN studs/s …`, with
the values `15.93`, `16.00`, `16.00`, `15.96`, `30.96`, `31.00` and `30.30` — full walk and sprint speed, at
the instant the engine had finished the walk. So a rig's walking fact cannot be read from that event alone,
`Humanoid.MoveToFinished` is the only stop edge there is, and the belief that `Running` fires `0` at a stop
(which `NPC_ANIM_MOVING_ATTRIBUTE` and `NpcService.publishAnimation` both argued from) was wrong. **The eighth
rig printed nothing**, and that absence was the diagnostic: it was the one stood down and parked for the
first player's arrival, so it never finished a walk at all — see §15 item 53. **What is still not confirmed is
the animation itself**, and nothing in a server log ever will confirm it: whether a given clip is on screen is
the client's answer, so the proof for both items 52 and 53 is the user's eyes on the lobby.

---

## Appendix — the other documents, and how far to trust them

| Document | What it is | State |
|---|---|---|
| `HANDOFF.md` | this file | current as of **2026-10-24**, against `6ce8770` plus the uncommitted work from the same day (§15 items 52–59: a rig's walking fact given a real stop edge, a parked rig's speed cleared on its way out of the world and on every placement, a client that had stopped dressing such a rig rather than forgetting it, a Match Stats board given an empty state that can be seen and a server line that says how many rows it answered with, a lobby that draws only the seat deficit instead of a full roster it then parks, the removal of the seat-reservation clock that was putting the eighth rig back five seconds into an intermission, the animation renderer's failure-as-success fixed along with its cancelled-windup speed reset, a hit-VFX pass that found the `victim` branch falling through into the spectator branch, warned about the two silent ways a rig hit draws nothing, and widened the body lookup past `NPC_TAG` alone, and a surrendered player's seat no longer booked back as a lobby reservation — which is why the round they left still had a body missing, and a `hitImpact` that carries an id beside the victim's name, because seven models called `Rig` are seven answers to "which body was hit"). **The 2026-10-24 passes touched §15 and §16 only.** **The 2026-10-23 pass** (against `f062372` plus six uncommitted files from the same day — the mobile cluster's glass face and rim glow, the cooldown ring, the caught-throw caption, the round's admission strip, the loading screen's title) brought **§4, §9, §10, §15 and §16** in step: §4's map lost two deleted controllers and gained `MobileControls`, `ui/glow.ts` and `client/enemyView.ts`; §9's inventory table was corrected the same way; §10 gained two stories and a completed list; §15 items 34–37 and §16 a note saying it confirmed nothing. **§5–§8, §11–§14, §17 and §18 stand as their own revisions left them** — §11's power-slot paragraph in particular predates the 2026-10-19 shuffle (`f699436`) and should be read against the code before it is trusted. §5's round lifecycle and §17's walk-speed table are the two most likely to have drifted since, because both describe code the later items changed. **§15 has since run on to item 102 (2026-10-26), and the map above has not followed it**: three files exist that §4 does not list (`server/vfx/mysteryBoxVfx.ts`, `client/celebration.ts`, `client/mercyWarning.ts`), `client/controllers/hud/LoadingScreenController.ts` and `client/ui/hudToast.ts` no longer exist, and `client/controllers/hud/RoundStatusController.ts` has grown a mercy line and two score subscriptions §4 knows nothing about. **Check §4 against the tree before trusting it**, and take §15 items 94–102 as the account of what moved |
| `TAGS.md` | the register of every `CollectionService` tag (its table *is* the count), with why the strings cannot be imported from each other | current as of **2026-10-23**, which added one row to its "not tags, but the same trap" table: `"Hit"` / `"Catch"`, the two values of `LAST_HIT_BY_CAUSE_ATTRIBUTE` and the only pair on that list whose disagreement is a wrong *sentence* rather than a wrong lookup. Its "why there are copies" section is the thing to read before touching the `Ball` tag |
| `SHOP-PANEL-BRIEFING.md` | a briefing for a visual-capable model debugging the shop panel rendering almost empty, with exact colours and the layout tree | **a record, not a description.** It documents the retired mock (five tabs, a box picture with odds); the panel was rewritten onto the economy and `ui/panelChrome.ts`, and a caveat banner at the top now says so. Kept because **§7's arithmetic still holds** (the panel really does collapse below ~700 px of viewport height) and §8's ruled-out list is still worth not re-treading. §5 and §6 were corrected on 2026-10-16 for the shared GUI's region, which is a *device* decision now (§9) |
| `README.md` | upstream roblox-ts boilerplate — its entire content is the line `First commit` | says nothing about this project; ignore it |
| `tools/pattern/` | the Node renderer and PNG output used to design the ring pattern (`shared/ringPattern.ts`) | one-off design tooling, not part of the build |
