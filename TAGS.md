# Tags

**Every `CollectionService` tag in the game, in one place, because the strings cannot be imported
from each other and nothing in the build catches a typo.**

A tag is a string that lives on an instance and is read by whatever asks for it. There is no type
across files, no compiler check, and no runtime warning: a renamed tag does not fail, it *stops
matching*, and the code that reads it goes quiet in exactly the way a working path also looks quiet.
This file is the list.

**Register re-verified against the source 2026-10-11** (commit `9e2e971`): every row below was
re-derived — the tag string, its source of truth, and at least one reader — and the prose that
describes those rows was corrected where it disagreed. What "re-verified" does **not** cover is the
place file: whether a part actually wears a tag is a Studio fact, marked *painted in Studio* row by
row, and no read of `src/` can confirm it.

**Earlier revisions, for the record.** The revision *before* 2026-10-06 was three tags short —
`MatchJoinA`, `MatchJoinB` and `ShiftLockZone` (now `practiceZone`) — and described `CharacterBarrier`
and `MatchSpawner` in terms of a map that is no longer cloned. The 2026-10-06 revision (commit
`5bcc374`) was itself three tags short of this register: `mysterySpawnPrize`, whose service landed
after it, and the two behaviours for seeking and dodging. Those three are what the register below
grew by.

**Landed in `390e8e8`.** The six `Behavior_*` tags became nine. The catch and throw behaviours were
split into an always-on variant and a gated one, so `Behavior_Catching` and
`Behavior_Throwing` now name the **gated** behaviours, and `Behavior_AlwaysCatching` /
`Behavior_AlwaysThrowing` name the always-on ones — the behaviour those two original strings used to
describe. The dodge behaviour was then split the same way, but **without moving any string**: the new
`Behavior_AlwaysDodging` is the always-on variant, and `Behavior_Dodging` keeps the chance-gated
behaviour it has always had. The register and the sections below describe the source as it stands;
commit `9e2e971` predates all of it, so **a place-file rig still wearing `Behavior_Catching` or
`Behavior_Throwing` is now dispatched to different code than it was** (see the catching section
below), while **a rig wearing `Behavior_Dodging` dodges exactly as often as it did**.

**Working-tree change, not in any commit yet.** A **tenth** behaviour tag — `Behavior_WalkToJoinPad` —
walks a placeholder rig from a lobby spawn to a join pad, and `LobbyRigService` is the thing that spawns
those rigs at all. **Rigs are therefore no longer only painted in Studio**: eight of them are cloned from
a `ServerStorage` template at server start and spawned through `NpcService.spawn`, so the `NPC` row below
gains a third author, and the section on the walk tag says what the new one does. **The lobby is also kept
full rather than merely seeded**: each player arriving stands one rig down and holds that rig's seat until
they take a side of their own, and each departure puts a rig back in the seat that was freed — so the
number of `Team`-bearing rigs in the lobby tracks `MATCH_MAX_PER_TEAM` per side rather than being fixed at
boot. Nothing else in the register moves: no string changed, and no existing tag changed meaning.

**And a placeholder rig's tag set now changes with the phase — the one thing here a reader should know
before reading a log.** The same rig wears `Behavior_WalkToJoinPad` and nothing else while the lobby is
open, and the **six** gameplay tags — `Behavior_Catching`, `Behavior_Dodging`, `Behavior_Seeking`,
`Behavior_Pickup`, `Behavior_Throwing`, `Behavior_Respawn`, the **gated** half of each pair and never an
`Always*` — from the moment it is holding a side inside a round until that round ends. A rig on a side
that is *not* inside a round wears none of the six: the walk is over and the round has not started. Both
transitions go through `LobbyRigService.setGameplayBehaviors`, which prints one line per rig per edge
(`playing — six behaviours on` / `standing down — behaviours off`), and **no tag was added or redefined
by any of it** — the rigs are the newest wearers of tags that already existed, which is why the count
below is still twenty.

**So what a given rig wears, in one line each:** `Behavior_WalkToJoinPad` **while it is walking to its
pad** and nothing else; nothing at all once it has arrived and no round is on; the six above while it
holds a side inside a round; and both of those from the moment it dies, because `RespawnBehavior` copies
the corpse's tag set onto the body that replaces it. That last sentence is the shape every tag-set bug in
this file has taken so far — see the walk section below for the one it caused.

**Both transitions go through `LobbyRigService.setGameplayBehaviors`**, which prints one line per rig per edge
(`playing — six behaviours on` / `standing down — behaviours off`), and **no gameplay tag was added or
redefined by any of it** — the rigs are the newest wearers of tags that already existed. What *was* added
later is the keep-out pair, `SideKeepOutA` and `SideKeepOutB`, which is why the count below reads twenty-three
rather than twenty-one: two painted boxes that say which region of the court a rig may fetch a ball from.
Nothing else in the register moved for it.

**Working-tree change, 2026-10-13: the boxes' meaning is inverted, and seeking is split in two.** The pair was
added as a *denylist* — a rig read the other side's box and skipped the balls inside it, so every remaining ball
in `Workspace` stayed a candidate, which is how a round rig came to walk into the lobby for one. Both boxes now
read as an **allowlist**, one per side, and a rig fetches only inside its own. That alone would leave the
practice rigs with no region at all, so **`Behavior_AlwaysSeeking` is a new tag** for them: it reads
`practiceZone` instead of the side boxes. The two tags carry the same behaviour — one factory in
`SeekBehavior.ts`, parameterised by a region — and differ in nothing else. **No string was renamed**: the tag
strings are painted in the place file, so `SideKeepOutA` still says keep-out while meaning "A's fetch region",
which the tags' own docs in `shared/constants.ts` now state outright.

## Why there are copies at all

Two separate reasons, and they are why this cannot be one shared constant:

1. **A Flamework component's `tag` is a decorator argument**, and Flamework reads it at build time
   from the source text. It has to be a literal, so no file can import it — including the file that
   declares it. This is why `BallComponent`'s `tag: "Ball"` is the source of truth and the seven
   `const BALL_TAG = "Ball"` declarations beside it are copies.
2. **Some tags are painted by a person in Studio's Tag Editor**, on parts in the place file. There is
   no code to import from: the "source of truth" is a tag on an instance, and the code that reads it
   is the only record of the contract.

**What this is not:** a naming convention. `NPC` is capitalised and `Behavior_Catching` is
underscored because they were written on different days, and changing either now is a rename across
a place file that no build touches.

## The register

| Tag | Source of truth | Who sets it | Who reads it |
| --- | --- | --- | --- |
| `Ball` | `BallComponent` decorator, `tag: "Ball"` | `BallFactory.finish` — nothing else | 7 files, listed below |
| `RoundBall` | `BallSpawnerService`, `ROUND_BALL_TAG` | `BallSpawnerService.spawn` | `BallSpawnerService.roundBallCount` (the budget) and `cleanupRoundBalls` (the sweep) |
| `MatchSpawner` | `shared/constants.ts`, `MATCH_SPAWNER_TAG` | *painted in Studio* | `BallSpawnerService.report` and `.tick` |
| `CharacterBarrier` | `shared/constants.ts`, `CHARACTER_BARRIER_TAG` | *painted in Studio* | `CollisionGroups.applyBarrierGroups`, called by `RoundService` at **every round boundary** |
| `practiceZone` | `shared/constants.ts`, `PRACTICE_ZONE_TAG` | *painted in Studio* | `PracticeZoneService.insideZone` / `.insideZoneAt` on the server — the tracker that publishes the attribute; `MysteryBoxService` calls `insideZoneAt` to ask whether a spawn point is on a practice floor; and **`AlwaysSeekingBehavior` reads the tag itself to ask whether a loose ball is inside the zone** — the practice half of the seek split, and the only reader of this tag that is a behaviour. **On the client** the rule is `client/roundZone.ts` (`inTaggedZone`), which the camera (`ShiftLock.checkZone`) and the dodge input (`DodgeController`) both ask — plus `ShiftLock.reportZoneParts`, which reads the tag a second time for its own count. One of the two tags a client reads |
| `mysterySpawnPrize` | `shared/constants.ts`, `MYSTERY_SPAWN_TAG` | *painted in Studio* | `MysteryBoxService.report`, `.tick` and `forgetLostSpawns`. It also asks `PracticeZoneService.insideZoneAt(spawn.Position)` whether a spawn point is on a practice floor — **a question about the spawn, asked of the zone, not a second reader of this tag** |
| `MatchJoinA` | `shared/constants.ts`, `MATCH_JOIN_A_TAG` | *painted in Studio* — the part's flags are then forced from code | `MatchService.mountSide` |
| `MatchJoinB` | `shared/constants.ts`, `MATCH_JOIN_B_TAG` | as above | as above |
| `SideKeepOutA` | `shared/constants.ts`, `SIDE_KEEP_OUT_A_TAG` | *painted in Studio* — **invisible, `Anchored`, non-collide, non-query, non-touch**; its `Size` and `CFrame` are the whole of the region | `npc/sideZones.ts` — `fetchRegionFor` (**a rig on A reads this box**, and fetches only inside it) and `zoneCounts` (the boot line). **The reading was inverted 2026-10-13**: the pair used to be a denylist — a rig read the *other* side's box and skipped the balls inside it, so every other ball in `Workspace` stayed a candidate — and is now the allowlist that says where each side may fetch. The string is unchanged because it is painted, so **the name says "keep-out" and means "A's fetch region"** |
| `SideKeepOutB` | `shared/constants.ts`, `SIDE_KEEP_OUT_B_TAG` | as above | as above, **read by a rig on B** |
| `MatchJoinTouched` | `MatchService`, `DEBOUNCE_TAG` | `MatchService.touched`, on a **character** | `MatchService.touched` |
| `NPC` | `shared/constants.ts`, `NPC_TAG` — re-exported by `npc/Behavior.ts`, which is where every server reader still imports it from | `NpcService.spawn` — called by `LobbyRigService` for the lobby's placeholders, and by anything else that spawns a rig — `RespawnBehavior`, or painted in Studio. **Never the `PlaceholderRig` template in `ServerStorage`**: `LobbyRigService` finds that by *name*, so it needs no tag, and a tag on it is the one studio-side fault this register has cost a session — the world-blind scan hands the template a loop, and (before `NpcService.ensureToken` refused it) a `ThrowerToken` that **every clone inherited**, which makes one token stand for eight rigs | `NpcService`, `CollisionGroups`, `BallService`, `RoundService`, `OutlineService` — **and `client/controllers/character/RigAnimationController`, which is what animates the rigs** |
| `Behavior_Catching` | `npc/Behavior.ts`, `BEHAVIOR_CATCHING` | `NpcService.spawn` / `RespawnBehavior` / painted — **plus `LobbyRigService`, which puts it on every lobby placeholder that is holding a side while a round is on** | `NpcService`'s per-behavior gate — and **gated since the catch/throw split**: a per-window 50 % decision, not the always-on window this string used to name. See the section below |
| `Behavior_AlwaysCatching` | `npc/Behavior.ts`, `BEHAVIOR_ALWAYS_CATCHING` | `NpcService.spawn` / `RespawnBehavior` / painted — **never the placeholders** | as above — **the always-on catcher, which is the behaviour `Behavior_Catching` used to name** |
| `Behavior_Throwing` | `npc/Behavior.ts`, `BEHAVIOR_THROWING` | `NpcService.spawn` / `RespawnBehavior` / painted — **plus `LobbyRigService`**, for the placeholders (see `Behavior_Catching`) | `NpcService`'s per-behavior gate — **gated since the split**: it turns to face an enemy and throws at it, and issues itself no ball. See the section below |
| `Behavior_AlwaysThrowing` | `npc/Behavior.ts`, `BEHAVIOR_ALWAYS_THROWING` | `NpcService.spawn` / `RespawnBehavior` / painted — **never the placeholders** | as above — **the always-on thrower, which is the behaviour `Behavior_Throwing` used to name** |
| `Behavior_Pickup` | `npc/Behavior.ts`, `BEHAVIOR_PICKUP` | `NpcService.spawn` / `RespawnBehavior` / painted — **plus `LobbyRigService`**, for the placeholders (see `Behavior_Catching`) | `NpcService`'s per-behavior gate |
| `Behavior_Seeking` | `npc/Behavior.ts`, `BEHAVIOR_SEEKING` | as above — **plus `LobbyRigService`**, for the placeholders (see `Behavior_Catching`) | `NpcService`'s per-behavior gate — and **the *round* seek, which fetches only inside the rig's own side's box since 2026-10-13**: this string used to name a seek that fetched from anywhere in `Workspace`. `createRoundSeekBehavior` in `SeekBehavior.ts` reads `npc/sideZones.fetchRegionFor`, so a rig on A never walks for a ball outside `SideKeepOutA`, whatever room it is standing in |
| `Behavior_AlwaysSeeking` | `npc/Behavior.ts`, `BEHAVIOR_ALWAYS_SEEKING` | *painted in Studio* — **never the placeholders**, which wear `Behavior_Seeking` while a round is on | `NpcService`'s per-behavior gate — and **the *practice* seek**, `AlwaysSeekingBehavior.ts`, which fetches only inside a `practiceZone`-tagged part and nowhere else. A rig with no side has no half of the court, which is why the practice rigs need a tag of their own. **The name is a Placeholder and the odd one out**: every other `Always*` tag is the ungated twin of a gated one, and seeking has no gate — `Behavior_PracticeSeeking` would say what this is. See the section below |
| `Behavior_Dodging` | `npc/Behavior.ts`, `BEHAVIOR_DODGING` | as above — **plus `LobbyRigService`**, for the placeholders (see `Behavior_Catching`) | `NpcService`'s per-behavior gate — and **the chance-gated dodger, whose meaning this split did not change** (a sibling was added beside it rather than it moved). See the section below |
| `Behavior_AlwaysDodging` | `npc/Behavior.ts`, `BEHAVIOR_ALWAYS_DODGING` | as above — **never the placeholders** | as above — **the always-on dodger**, which answers yes to every ball it can move away from |
| `Behavior_Respawn` | `npc/Behavior.ts`, `BEHAVIOR_RESPAWN` | as above — **plus `LobbyRigService`**, for the placeholders (see `Behavior_Catching`) | `NpcService`'s per-behavior gate, which calls `onDied` when a loop ends with no health left |
| `Behavior_WalkToJoinPad` | `npc/Behavior.ts`, `BEHAVIOR_WALK_TO_JOIN_PAD` | `LobbyRigService`, through `NpcService.spawn` | `NpcService`'s per-behavior gate — and `WalkToJoinPadBehavior` itself, which reads the rig's `WalkToJoinPad` (a `Vector3` destination) and `WalkToJoinPadSide` (the side to take **on arrival**) attributes. **It is the one behaviour tag that writes `Team`**, which is what makes the walker a round participant the moment it stands on the pad |

Twenty-three tags. Of them, **four are the same rule** — a tag that only means something while the part is
in the world — and the rule is now enforced by the reader rather than repeated in each one: see the
four sections below that say so.

**`mysterySpawnPrize` is the one that is a fact about a *place* rather than about a part.** Nothing of
the tagged part is used except where it is, and the same part in two different places means two
different things: on the field it is a spawn point rolled for at `MYSTERY_CONFIG.SPAWN_CHANCE`, and
inside a `practiceZone` it is a fixture restocked a couple of seconds after each collection. Which of
the two it is is asked of the zone — `PracticeZoneService.insideZone`, the one function in the game
that answers that question — so moving the part moves the rule with it, and there is deliberately no
second tag for the zoned case. `MysteryBoxService.report` prints how many of the tagged parts are on a
practice floor, which is the number that explains why nothing is happening on the field.

**There is no player tag.** "Is this a person?" is `Players.GetPlayerFromCharacter`, which is a
question about the player list rather than about the instance — so the player side of the game never
appears in this file.

## `Ball` — the one with eight spellings

- **Source of truth:** `@Component({ tag: "Ball" })` in `src/server/components/BallComponent.ts`.
  That literal is what attaches the component to a ball, so it is also the definition of what a ball
  *is* to Flamework.
- **The copies** — every one is `const BALL_TAG = "Ball"`, in:
  `CollisionGroups` · `BallComponent` · `BallFactory` · `BallPickupService` · `BallService` ·
  `BallSpawnerService` · `OutlineService`.
- **Set by:** `BallFactory.finish` (`ball.AddTag(BALL_TAG)`). It is the only `AddTag("Ball")` in the
  game, so a ball that lacks the tag is a ball that did not come from the factory.
- **Read by**, and each reader is asking its own question:
  - `BallComponent.isBall` — is this part a ball? (also accepts `Name === BALL_NAME`)
  - `CollisionGroups.assignPart` — keep a ball out of the `Character` group
  - `BallPickupService` — find the loose balls to offer a pickup on
  - `BallService` — take the round's balls out of every hand at the end of an intermission
  - `BallSpawnerService.countLoose` — count what is lying near a spawner
  - `OutlineService.watchTag` — outline every ball as it arrives
- **When a copy is wrong, the failure is silent and partial.** The worst one is `isBall`: a ball the
  tag reader no longer recognises stops being a ball, and a ball in somebody's hand is then answered
  as a *body* — see the guard at the top of `BallComponent.handleTouch`, which exists for that case.
  The others each fail in their own quiet way: a ball not counted, not swept, not outlined.
- **Two ways in, deliberately.** `isBall` accepts the tag *or* the name (`DodgeballBall`), because
  the name is what a ball is called in the log and a hand-built part with one and not the other
  should be treated as a ball. Being wrong in that direction costs a throw; the other direction
  costs a body.
- **The in-code comments disagree about the count, and each is a different number**, which is the
  clearest argument for this file: `OutlineService` deliberately names no number at all ("every file
  that has to find a ball"), `BallSpawnerService` and `BallComponent`
  each name three others, and `CollisionGroups` names five — none of them names `BallComponent`
  itself. The real number is **eight occurrences of the string** — seven `const`s in seven files plus
  the decorator — and none of the comments says that.

## `RoundBall` — the round's furniture

A **second** tag rather than a reuse of `Ball`, because the two answer different questions: `Ball`
means "this is a dodgeball — pick it up, throw it, hit people with it", and every ball carries it;
`RoundBall` means "this one is part of the arena's furniture and goes when the round does", and only
`BallSpawnerService` applies it.

It has **two readers, with two jobs**, and they are deliberately not the same call:

- `roundBallCount` reads it **raw** (`CollectionService.GetTagged`), not through `taggedParts`,
  because the question is "how many of the match's balls exist right now" and the answer has to be
  the same set the sweep will look at. It is the number the spawner's budget is spent against —
  `MATCH_BALL_COUNT` minus this — so a ball destroyed on impact is replaced and the count cannot
  drift.
- `cleanupRoundBalls` sweeps it at the end of a round, and **leaves a ball that is in somebody's hand
  alone** — destroying a ball out of a hand would take it from a player mid-action for a reason that
  has nothing to do with them. The tag comes off before the destroy, so a ball on its way out is not
  counted as the round's for the frame in between — and that ordering is what `BallService.isHeld`
  is asked about, from the other side.

**A misspelling here is invisible until the arena is full of last round's balls**, which is the
symptom to look for: the sweep finds nothing, the budget stays spent, and the spawner stops putting
anything out.

## `MatchSpawner` — painted, not written

Marks a part as a piece of arena that keeps loose balls around it. The name itself lives in
`shared/constants.ts` (`MATCH_SPAWNER_TAG`) rather than in the service that reads it, because the boot
diagnostic prints it — see `BallSpawnerService.report`, and see the constant for why it is named for
the match rather than for balls.

Read by `report` and `tick`, both through **`taggedPartsInWorkspace`**, which brings two rules with
it that used to be written out at the call site:

- **A tag on a folder counts.** `taggedParts` expands a container into the `BasePart`s inside it, so
  the tag may be painted on the pad or on a folder holding several pads. That is the reading anyone
  building an arena would expect, and it is why the tag does not have to be on a part.
- **The part must be a descendant of `Workspace`.** The rule is unchanged, but the *reason* in the
  previous revision of this file is now historical twice over: `MapService` no longer clones an arena
  and holds it out of the world — **it has since been deleted outright** — and the arena is permanent.
  The guard stays because
  the tag is still a DataModel-wide fact: a tagged part parked in `ServerStorage`, or in a
  half-built arena nobody has placed yet, is not somewhere a ball can lie, and `GetTagged` answers
  about it exactly as loudly as it answers about the parts you can see. `PRACTICE_ZONE_TAG`'s own
  doc makes the same argument for the same reason.

A misspelling is silent: that part is never topped up, and nothing says so — except the count in the
`[Spawner] up` line, which is the one place a zero is visible.

## `CharacterBarrier` — painted, not written

Marks the arena's midline wall. Read by `CollisionGroups.applyBarrierGroups`, which puts every
tagged part into the `Barrier` collision group.

**When it is read has changed, and it changed for a reason worth keeping.** It used to be read as a
side effect of `MapService.placeCurrent` putting the arena into the world, which was the only place
the tag was ever consulted. With nothing placed per round, a tagged wall would have kept whatever
group the place file gave it — and its whole point is that it stops **characters and not balls**, so
a wall in the wrong group stops both. `RoundService` therefore calls `applyBarrierGroups()` at every
round boundary: idempotent, tag-driven, and once a round rather than once at boot because this
project's place files are edited while a server is running.

The read goes through `taggedPartsInWorkspace`, so a tag on a folder works, and the pass is also
**class-unchecked** — it finds its parts by tag, so neither where the arena sits nor what class it is
can matter. That was forced by a real place file whose arena is a `Folder`: the old version handed
the arena over and skipped the pass unless it was a `Model`, so the wall was never assigned at all
and one warning a round was the only evidence.

**The tag and the part's flags are one contract.** The wall only works because `CanTouch` and
`CanQuery` are `false` on it — that is what lets a ball cross without reporting a world contact and
lets the aim guide pass through. A misspelled tag makes the wall a plain `Default` part: characters
cross it and balls bounce off it, which is the exact symptom pair described in
`shared/constants.ts`.

**And the edge is not this.** An arena edge wall is a `Default` part with all three of `CanCollide`,
`CanTouch` and `CanQuery` true and **no tag at all**, which is what stopping characters *and* balls
means. Tagging one would invite a reader to route it through this wall's code and silently take the
balls out of it.

## `practiceZone` — painted, and now a rule rather than a camera

A lobby part that makes a place to practise. Standing inside one: the custom shift lock is forced, a
dodge works, **players do not collide with each other**, **balls do not hit players** (they hit rigs
and the world as usual), **a Freeze splash leaves players alone**, and the Shop and Inventory are
hidden. **Renamed from `ShiftLockZone`**, and the code side of that is mechanical while the Studio side
is not — see the note at the end of this section.

**What changed, and why the paragraph that used to stand here had to go.** The zone used to be purely
a camera: *"nothing on the server has an opinion about it"* was true, and every rule above makes it
false. Six of the seven are enforced on the server, and five of those six are decisions that cannot be
made per frame on a client.

**Two halves, one fact.** `client/roundZone.ts` answers "in a round, or in a practice zone" for the
camera and the dodge input, and **`NPC` is the only other tag any client reads** — see that row, and
see why: a rig's animation state is published as attributes *on the rig*, so the renderer has to be
able to find the rigs before there is anything to watch, and the tag is how. On the server
`PracticeZoneService` owns membership: it runs the same bounds test on a tick, and publishes the answer
as **`PracticeZone` on the `Player`**. Everything else reads that attribute — the dodge gate, the ball's
contact handler, the Freeze splash, the dock — so the zone costs **one query per player per tick** no
matter how many rules are asking, and no two rules can come to different answers about the same body.
The two detections can differ by at most one interval (0.1 s); the client's is kept only because the
camera needs an answer on its own tick rather than at replication's.

Two lookups, for two different questions:

- **Once, at mount**, `taggedParts` (the whole DataModel, no `Workspace` filter) — purely to print
  `[ShiftLock] up — N practiceZone part(s)`. That count is the diagnostic: the commonest cause of "the
  zone does nothing" is that nothing wears the tag at all, and a zero is the answer. `MatchService`
  prints its own counts in the same shape for the same reason. **It is a snapshot taken once, at
  mount** — a part tagged afterwards will never appear in it, so paint the part before starting the
  session if that line is what you are reading.
- **Ten times a second**, `taggedPartsInWorkspace` — the real check. The workspace half of that
  helper was this loop's own guard before the helper existed, and the expansion is paid on every tick,
  which is the one thing worth knowing about it here.

**The Studio half of the rename is the one no build can catch.** The tag string lives on parts in the
place file, so renaming the constant changes what the code *asks for* and nothing about what the parts
*wear*: until the parts are repainted in the Tag Editor — and any copy of the map or saved environment
with them — the zone is not detected at all, and the symptom is "nothing happens in the practice
area", which reads exactly like a code bug. The count in the line above is how you tell the two apart.

**The part's dimensions *are* the zone.** There is no separate radius: the check is
`Workspace.GetPartBoundsInBox(zone.CFrame, zone.Size, params)` with the character excluded, so the
zone is whatever size and rotation the builder gave it, and any number of them may exist. It does
**not** use `Touched` — which is why `CanTouch = false` on a zone is not what stops the detection.
(The opposite reading is tempting: an invisible box that reported touches would be handing `Touched`
to every ball, rig and character that passed through it for no reason.) `CanQuery = false` for the
barrier's reason: the aim guide's spherecast must not stop on a lobby prop.

**No collision group**, unlike the barrier: this part is not meant to affect anything, and a group
would be a statement that it does.

## `MatchJoinA` / `MatchJoinB` — painted, not written, and the code then mutates the part

The two parts a player walks into to pick a side for the next match. One tag per side, and the split
is the whole rule: **the part you touch is the side you ask for.** There used to be one `MatchJoin`
part that placed whoever touched it on whichever side was emptier — the player said "I would like to
play" and `MatchService` chose the team. These two are what let the player choose, and touching the
*other* part moves them again until the match starts.

**These are the one pair of tags whose parts the code writes to.** `MatchService.prepare` forces four
properties — `Anchored = true`, `CanCollide = false`, `CanTouch = true`, `CanQuery = false` — and
**warns naming any property it had to correct**, so the trap is a line in the log rather than an
afternoon. `Anchored` is the one that matters: the old lobby spawn was unanchored, walked off the
bottom of the world, and was destroyed by the engine at `FallenPartsDestroyHeight` with no Lua on the
stack and nothing in the output. A join part that drifts is a join part that stops answering, and the
symptom is "touching it does nothing to me".

`CanTouch = true` is the exception rather than an oversight — this part's whole job *is* the touch,
so it is the case the barrier and the zone are the rule against.

The parts are found with `taggedParts`, so the tag may equally be on the pad or on a folder holding
it — the warning that used to stand here, telling the reader the tag belonged on the part and not
around it, is gone because the case it described now works. `mountSide` also mounts a `BillboardGui`
(`MatchJoinCounts`) above each part and prints `[Match] up — <tag>: N part(s)`.

Both tags are read by the **server only**; nothing on the client needs to know which part is which
side.

## `MatchJoinTouched` — the one tag that is state rather than a label

`MatchService`'s debounce, and it is unlike every other entry in this file: nobody paints it, no
instance in the place file wears it, and it is **not a marker at all — it is a window**. `Touched`
fires per body part and again as a body moves about, so one step into a sign would otherwise be six
opt-ins. The first touch adds this tag to the **character** for
`MATCH_TOUCH_DEBOUNCE_SECONDS` (0.5 s) and a touch that arrives while it is on is ignored.

**One window covers both parts**, deliberately. The mark lives on the character rather than on the
sign it touched, so a body crossing straight from the `A` sign into the `B` one inside the window
gets one event rather than a side switch at random. The price is the same walk when it *is* meant —
a switch wants a pause between the two touches.

It is worth having in this file despite being code-only, because it is a tag on a **character**, and
a reader who knows the rest of this list will not expect that.

## `NPC` and the ten `Behavior_*` tags

`NPC` is the entry point; a `Behavior_*` tag enables one mechanic. A rig wearing `NPC` and no
behaviour tag is managed and does nothing.

**The order they go on is load-bearing, and it is the one rule in this file that is not about
spelling.** `NpcService` starts a loop when `NPC` **arrives** on a model, so the behaviour tags must
be in place first — `spawn` and `RespawnBehavior` both add the behaviours first and `NPC` last for
that reason. A tag that is *already* on a model cannot arrive, which is why `RespawnBehavior`
removes every tag from the replacement and re-adds them rather than trusting `Clone` to have carried
them.

`GetInstanceRemovedSignal(NPC_TAG)` is what stops a loop, so taking `NPC` off a rig retires it.

**A rig is managed only while it is in `Workspace`, and that is the second condition on this tag.**
It is the same rule `MatchSpawner` and `practiceZone` need, arriving on the other kind of tag, and it
is needed for the same reason: `CollectionService` answers about the whole DataModel, so a rig inside
an arena template parked in `ServerStorage` wears `NPC` exactly as the rigs standing in the arena do.
`NpcService.run` skips a rig that is out of the world and `RoundService.roundParticipants` filters
this tag the same way.

`NpcService` was the reader where the rule was missing, and **what it cost is not visible in the
code, so it is written down here**: a rig out of the world is still simulated, so its behaviors ran,
`ThrowBehavior.prepare` handed it a ball, and every throw it made parented that ball to `Workspace` —
which is where a thrown ball goes. A parked map template in `ServerStorage` therefore put balls into
the world out of nowhere, at the coordinates its rigs had been saved at, with nothing in the output
to say where they came from. It was found by the user, reported as "ball appear out of nowhere when
testplay", and fixed by the world gate.

**Two tags can be one mechanic, and `Behavior_Seeking` with `Behavior_Pickup` is that case.** The
seeker walks the rig to the nearest loose ball and stops once the ball is inside a picker's reach;
the picker takes whatever is in that reach. Either tag alone is a working rig that does nothing
useful — with seeking only it crosses the arena and stands beside a ball it will never take, and with
pickup only it collects what happens to roll within `PICKUP_RADIUS` of wherever it is standing. That
belongs in this file because nothing in the build knows the two belong together: they are independent
strings, and the system that runs them is deliberately independent as well.

**And the seeker now reserves the ball it sets off for, which is a change to this tag's behaviour though not
to its string.** `npc/ballClaims.ts` is a `Map` from ball to rig: a rig that has chosen a ball writes down
that it has, every other rig sees that ball as taken and chooses the next nearest, and a rig whose turn
finds *every* ball claimed **stands** instead of joining the pile. Nothing is sent between rigs — the claim
*is* the agreement — and a claim is not a lock on the ball: whoever is inside `PICKUP_RADIUS` when a pickup
runs takes it, so a snatch is possible and repairs itself on the loser's next turn. A claim lasts exactly as
long as the walk: renewed on every turn of it, released on pickup, on give-up, on the target ceasing to be
loose, and on death — plus `NPC_CONFIG.CLAIM_SECONDS` of silence as the net for the one route no hook
covers, a `Behavior_Seeking` tag that is simply removed at a round boundary.

**And two tags can be a mechanic that never runs — which now turns on *which catcher* a rig wears, where
it used to be the only catching tag there was.** An open catch window refuses a dodge outright
(`DodgeService.blocksDodge`), so a dodging tag beside a catching one is either starved or merely
rationed:

- **`Behavior_AlwaysCatching` starves *any* dodger.** Its window is held open continuously, so
  `Behavior_Dodging` and `Behavior_AlwaysDodging` alike never get an opening — the rig catches and
  nothing else. Not a bug and not a special case anywhere, but a combination nobody would guess from
  the tag names, which is why it stays written down.
- **`Behavior_Catching` rations them instead.** The gated catcher rolls once per window whether it is
  a catcher at all, and asks only when the roll says yes *and* a ball is in its detection radius — so
  it leaves the window **closed** for roughly the other half of the timeline, and a closed window is
  exactly what a dodge needs. A rig wearing it and `Behavior_AlwaysDodging` dodges in **every** gap;
  one wearing it and the gated `Behavior_Dodging` dodges in about half of them. Either way the two
  actions are still mutually exclusive *at any instant* (the gate is unchanged, and still
  `DodgeService`'s): the rig catches while its window is open and dodges in the gaps, never both at
  once. **This is the one place the catch/throw split changed a documented behaviour, and it is the
  point of that split** — see the note at the head of this file and `CatchBehavior`.

The same gate is why a dodge cannot interrupt a catch: the two actions are mutually exclusive by
design, for a player and for a rig alike — the difference being that a player chooses, and a rig
cannot.

**And the two catchers disagree about the ball in the hand, which is the second place the split changed a
documented behaviour.** `Behavior_AlwaysCatching` puts down whatever it has just caught on its very next
tick: a pure catcher needs a free hand, and dropping is what gives it one. `Behavior_Catching` **keeps
it**, because the rigs that wear it are the lobby placeholders — they wear `Behavior_Pickup` and
`Behavior_Throwing` beside it, and what empties their hand is the *throw*. That difference is a rig that
plays against the version this replaced, which picked a loose ball up and put it straight back down twice a
second for a whole round: never walking (it never left the ball), never throwing (its hand was empty half
the time), and reading in the log as a rig that follows balls around. **The price, for anybody reading a tag
set rather than this file:** a rig wearing `Behavior_Catching` and *not* `Behavior_Throwing` takes one ball
and keeps it for the rest of the round — a full hand cannot catch and cannot pick up, and nothing puts that
ball down. See `AlwaysCatchBehavior`'s tick, where the rule lives and is argued.

**A death does not cost a rig its side.** `RespawnBehavior.onDied` reads the corpse's `Team` and writes it
on the replacement, beside the tags it already carried over — without it a rig came back as a body the round
does not count, never teleported, and one whose `detectEnemy` side read `undefined`, which made every rig on
the field an enemy and every player a friend. `Team` is an attribute rather than a tag, so this is written
here only because `Behavior_Respawn` is the tag that owns the rebuild.

## `Behavior_WalkToJoinPad` — the one tag whose destination is written on the rig

A rig wearing it walks to the point named by its own **`WalkToJoinPad`** attribute and stands there,
taking the side named by **`WalkToJoinPadSide`** on arrival. The first is a `Vector3` and the second a
`TeamLabel` (`"A"` / `"B"`), both written by `LobbyRigService` when it spawns the rig, which makes this
the only behaviour in the game whose target is *handed to it* rather than found by it: the others ask the
world a question — where is a ball, is one coming at me, is one within reach — and this one is told.
The reason is the one that keeps the lobby out of the behaviour: a join pad is a fact about the *lobby*,
and a behaviour that looked one up would have to know which tag a pad wears, that there are two sides,
and where they are. Handing it a point means it can be told to walk anywhere, and being handed the side
means it does not have to work out which of two identically-tagged pads it is standing on.

**`WalkToJoinPad` and `WalkToJoinPadSide` are attribute names, not tags**, so neither is a row in the
register above — they are named here because they are the other half of this tag's contract, and a
reader grepping either string will find it in two files. Their source of truth is
`WalkToJoinPadBehavior.ts`, which reads them; the writer of both is `LobbyRigService`. Nothing on the
client knows they exist.

**What the tag does not do, and what it does the moment it is done.** The walk is the whole of it: the
body is moved with `Humanoid.MoveTo` and nothing else about it is touched on the way. Arriving is the one
thing that changes anything — the arrival branch writes the rig's `Team` from `WalkToJoinPadSide`, and
that single write is what turns the body from a placeholder into a round participant, because
`npc/rigs.ts` reads exactly that attribute and nothing else.

**A rig still walking is therefore on no side at all, and its writer has to allow for that.** It is a
body crossing a lobby floor that the round ignores — which is the correct reading: it holds a *seat*
rather than a post, and the seat it holds is the one it is walking *towards*. `LobbyRigService` counts it
that way, from the same attribute the arrival branch will act on, so the seat it is about to take is
neither double-filled while it walks nor reported short.

**The tag comes off the rig the moment it arrives, and the behaviour takes it off itself.** That is the
arrival branch: the walk is over, the side is written, and `WalkToJoinPadBehavior` removes its own tag from
the body — so "a rig wearing this" means *a rig on its way to a pad* and nothing else. `LobbyRigService` relies
on exactly that reading (`moveWalkersToArena` is its list of rigs that have not arrived, and it strips the tag
from any that are still walking when a round opens).

**And this is load-bearing rather than tidy, which one live bug is worth remembering for.** The tag comes off
because `RespawnBehavior` hands the replacement the *corpse's* tag set: a corpse of a rig that had arrived
still wore this tag, and the replacement also inherits the rig's attributes from the template it was cloned
from — so a rig killed mid-round came back wearing "walk to a pad" **with** a pad to walk to, and set off from
the arena towards the lobby the moment it stood up. The old shape (an `arrived` flag inside the behaviour)
could not have prevented it: the state is keyed by the model, and a rebuilt rig is a new model. No tag, no
bug — and `RespawnBehavior` also clears the destination attributes on a rebuilt rig that holds a side, so the
two halves of the instruction cannot survive a death together.

**The order rule above applies to it like any other behaviour tag.** `LobbyRigService` spawns through
`NpcService.spawn`, which adds behaviour tags first and `NPC` last, so the tag is in place before the
loop that will run it starts — the same rule, and the same reason, as every other entry in this file.

**On its own it is inert; beside a seek tag it is a tug of war** — `Behavior_Seeking` for a round rig, `Behavior_AlwaysSeeking` for a practice one that wears both. Both move the body with
`Humanoid.MoveTo`, and whichever ticks later in a turn wins — so a rig wearing this and `Seeking` walks
to a ball and then back to its pad, for as long as the balls last. Nothing refuses the combination,
because the two tags are independent strings and no runtime check could know which of two destinations
somebody meant. Written down here for the same reason the catch/dodge interaction is: it is a
combination nobody would guess from the tag names.

## `SideKeepOutA` / `SideKeepOutB` — the two boxes that say which region of the court a rig fetches from

Two invisible parts, one per side, whose **`Size` and `CFrame` are the whole of the region**. **The reading was
inverted on 2026-10-13 and this section is written from the new side of it**: a rig on A fetches inside the box
tagged `SideKeepOutA` and nowhere else. It used to be the other way round — a rig on A read `SideKeepOutB` and
skipped the balls inside it — which excluded one region and left every other ball in `Workspace` a candidate.
The pair exists because `MoveTo` cannot go round anything, so a ball the rig can see and not reach is a ball it
walks at for a whole stall budget; a region it may fetch inside is what stops the walk being made at all. See
`SeekBehavior`'s own doc for why every cheap way of asking "is that ball reachable" is worse than a painted box.

**The side is in the tag rather than in an attribute**, so a server that finds only one of the pair can name
which one is missing: `LobbyRigService` prints both counts on its boot line (`fetch boxes N + N`) and warns by
name when one is absent. **A place with no box for a side is a side that fetches nothing** — that changed with
the reading: it used to mean every ball was worth chasing. The warning is still a line rather than a refusal to
spawn anything, because a place file is not something the server can repair, but what it is reporting is now a
broken round rather than an ugly one.

**A rig reads its own side's box, and only its own.** A ball on the other half is not a candidate, which is the
point for the same reason it always was: reaching it means walking at a barrier. **A rig with no `Team` has no
box at all** — a placeholder still walking to its pad, a hand-tagged rig with no side — so the round variant
fetches nothing on its behalf, and a practice-area rig needs the tag that reads the practice zone instead:
`Behavior_AlwaysSeeking`, in `AlwaysSeekingBehavior.ts`. That split, and the reason a practice rig and a round
rig could not keep sharing one tag, is the section above the register.

## Cloning

`Clone()` copies tags, and two places depend on knowing that:

- **`RespawnBehavior` clones the corpse to build the replacement**, strips the tags off the template,
  and puts them back on the rig at the end of the life — so a rig that gains a behaviour tag while
  alive keeps it through death. This is the live case, and it is the reason the `NPC`-arrives rule
  above exists.
- **`MapService` used to clone arenas out of `ServerStorage`**, which is where the previous revision
  of this file's "the clone arrives wearing every tag the template had" note came from. That is
  historical, and it has gone a step further: **`MapService` has been deleted** and the arena is
  permanent. The *lesson* is not historical,
  though, and it is why the world guard exists in three readers — a clone, a parked template and a
  half-built arena all wear their tags from outside the world.

**What this is not:** a reason to filter by `IsDescendantOf(Workspace)` everywhere. A reader that
wants everything — the `N`-count diagnostic in `ShiftLock`, for instance — should say so; the four
rules above are about readers that are *acting* on what they find.

## Not tags, but the same trap

These are the other strings two or more files have to agree on. They are listed rather than
duplicated — the source of truth is the file named.

| String | Source of truth | Also spelled out in |
| --- | --- | --- |
| `"Armed"` | `BallFactory` sets the first value; `BallService` sets it on a hand-out and a throw | `BallComponent`, `BallPickupService`, `BallSpawnerService`, `CatchBehavior`, `CatchService`, `DodgeBehavior` (its own `ARMED_ATTRIBUTE` copy) |
| `"ThrowerId"` | `BallService.throwBall` | `BallComponent`, `BallFactory` (cleared to `""`) |
| `"StatsRecorded"` | `BallComponent` | — (one file, and read nowhere else; it exists so a ball cannot score twice) |
| `"ObjectOutline"` | `OutlineService` (`OUTLINE_NAME`) | `AimTargetController` |
| `"Playing"` / `"Intermission"` | `RoundService` publishes them as the phase name | **server:** `BallSpawnerService`, `MatchService`, `StatsService`, `SuperService`, `OutlineService`, `MysteryBoxService`, `DodgeService`. **client:** `RoundStatusController`, `RoundResultController`, `StatsBillboardController`, `TeamRingController`, `MusicController`, `ShiftLock`, `roundZone.ts`, and `panels.ts` (which spells both and is what `DockController` and `ArenaFreezeCountdownController` read them through) |
| `"LobbySpawn"` | `shared/config/arena.config.ts` (`LOBBY_SPAWN_NAME`) | `RoundService`, in the `DescendantRemoving` watcher that traces the part's disappearance. **Nothing reads this name as a spawn any more** — the lobby is a folder of `LobbySpawns` parts — so the only reason the string still exists is that watcher, which is scaffolding worth deleting once the part is traced |
| `DodgeballBall` | `shared/constants.ts` (`BALL_NAME`) | **imported, not copied** |
| `THROWER_TOKEN`, `ROUND_STATE_ATTRIBUTE`, `ROUND_TIME_ATTRIBUTE`, `ROUND_MODE_ATTRIBUTE`, `TEAM_ATTRIBUTE`, `RESPAWN_AT_ATTRIBUTE`, `COINS_ATTRIBUTE`, `OWNED_ITEMS_ATTRIBUTE`, `OWNED_COSMETICS_ATTRIBUTE`, `CROWN_ATTRIBUTE`, `STAT_HITS` / `STAT_OUTS` / `STAT_RATIO`, `BALL_ABILITY_ATTRIBUTE`, `ARMED_ABILITY_ATTRIBUTE`, `CHARACTER_BARRIER_TAG`, `MATCH_JOIN_A_TAG` / `MATCH_JOIN_B_TAG`, `MATCH_SPAWNER_TAG`, `PRACTICE_ZONE_TAG` | `shared/constants.ts` | **imported, not copied.** This is the list to check first: every one of them is read by two files or more, and every one of them is a *string* that a typo would silently break |

**The distinction that matters:** the tag strings in this file are the ones that *cannot* be imported
— a Flamework decorator literal, or a string painted on an instance in Studio. Everything in the
table above is imported from `shared/constants.ts` and is here only because it is the same kind of
mistake waiting to happen, one `GetAttribute("Typos")` at a time.

## How to check

- **Studio:** the Tag Editor lists every tag a place actually has, which catches a tag that is painted
  but misspelled. `CollectionService:GetAllTags()` in the command bar answers the same question as
  data.
- **In code:** searching for the string is the only way, which is precisely why the copies are worth
  having written down. When one of them changes, change all of them — including the literals inside
  `GetAttribute(...)` calls, which are not `const`s and do not show up in a search for the constant's
  name.
- **Tag constants are `export const`** (`NPC_TAG`, `MATCH_JOIN_A_TAG`, …) **or a module-private
  `const`** (`BALL_TAG`, `ROUND_BALL_TAG`, `DEBOUNCE_TAG`). The private ones are the copies; the
  exported ones are the sources of truth. A grep for `const [A-Z_]*TAG[A-Z_]* = "` finds both.
- **In the log:** every tag this game prints comes with the instance it was read from, and the four
  count lines are the ones to grep for when a tag looks dead — `[Spawner] up … N tagged thing(s), M
  usable part(s)`, `[Match] up — <tag>: N part(s)`, `[ShiftLock] up — N practiceZone part(s)`, and
  `[Round] cleared N held balls`.
