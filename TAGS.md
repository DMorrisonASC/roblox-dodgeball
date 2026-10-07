# Tags

**Every `CollectionService` tag in the game, in one place, because the strings cannot be imported
from each other and nothing in the build catches a typo.**

A tag is a string that lives on an instance and is read by whatever asks for it. There is no type
across files, no compiler check, and no runtime warning: a renamed tag does not fail, it *stops
matching*, and the code that reads it goes quiet in exactly the way a working path also looks quiet.
This file is the list.

**Re-verified against the source 2026-10-06** (commit `5bcc374`, with the economy work uncommitted).
The previous revision was three tags short — `MatchJoinA`, `MatchJoinB` and `ShiftLockZone` (now
`practiceZone`) — and
described `CharacterBarrier` and `MatchSpawner` in terms of a map that is no longer cloned.

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
| `practiceZone` | `shared/constants.ts`, `PRACTICE_ZONE_TAG` | *painted in Studio* | `client/roundZone.ts` — the only tag read on the client, asked by `ShiftLock` and by the dodge input |
| `MatchJoinA` | `shared/constants.ts`, `MATCH_JOIN_A_TAG` | *painted in Studio* — the part's flags are then forced from code | `MatchService.mountSide` |
| `MatchJoinB` | `shared/constants.ts`, `MATCH_JOIN_B_TAG` | as above | as above |
| `MatchJoinTouched` | `MatchService`, `DEBOUNCE_TAG` | `MatchService.touched`, on a **character** | `MatchService.touched` |
| `NPC` | `npc/Behavior.ts`, `NPC_TAG` | `NpcService.spawn`, `RespawnBehavior`, or painted in Studio | `NpcService`, `CollisionGroups`, `BallService`, `RoundService`, `OutlineService` |
| `Behavior_Catching` | `npc/Behavior.ts`, `BEHAVIOR_CATCHING` | `NpcService.spawn` / `RespawnBehavior` / painted | `NpcService`'s per-behavior gate |
| `Behavior_Throwing` | `npc/Behavior.ts`, `BEHAVIOR_THROWING` | as above | as above |
| `Behavior_Pickup` | `npc/Behavior.ts`, `BEHAVIOR_PICKUP` | as above | as above |
| `Behavior_Respawn` | `npc/Behavior.ts`, `BEHAVIOR_RESPAWN` | as above | as above |

Thirteen tags. Of them, **four are the same rule** — a tag that only means something while the part is
in the world — and the rule is now enforced by the reader rather than repeated in each one: see the
four sections below that say so.

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
- **The in-code comments already disagree about the count**, which is the clearest argument for this
  file: `OutlineService` says "three files have to agree", `BallSpawnerService` and `BallComponent`
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
camera and the dodge input, and it is still the **only tag read on the client**. On the server
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

## `NPC` and the four `Behavior_*` tags

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
| `"Armed"` | `BallFactory` sets the first value; `BallService` sets it on a hand-out and a throw | `BallComponent`, `BallPickupService`, `BallSpawnerService`, `CatchBehavior`, `CatchService` |
| `"ThrowerId"` | `BallService.throwBall` | `BallComponent`, `BallFactory` (cleared to `""`) |
| `"StatsRecorded"` | `BallComponent` | — (one file, and read nowhere else; it exists so a ball cannot score twice) |
| `"ObjectOutline"` | `OutlineService` (`OUTLINE_NAME`) | `AimTargetController` |
| `"Playing"` / `"Intermission"` | `RoundService` publishes them as the phase name | **server:** `BallSpawnerService`, `MatchService`, `StatsService`, `SuperService`, `OutlineService`. **client:** `RoundStatusController`, `RoundResultController`, `StatsBillboardController`, `TeamRingController`, `MusicController`, `ShiftLock` |
| `"LobbySpawn"` | `shared/config/arena.config.ts` (`LOBBY_SPAWN_NAME`) | `RoundService`, in the `DescendantRemoving` watcher that traces the part's disappearance. **Nothing reads this name as a spawn any more** — the lobby is a folder of `LobbySpawns` parts — so the only reason the string still exists is that watcher, which is scaffolding worth deleting once the part is traced |
| `DodgeballBall` | `shared/constants.ts` (`BALL_NAME`) | **imported, not copied** |
| `THROWER_TOKEN`, `ROUND_STATE_ATTRIBUTE`, `ROUND_TIME_ATTRIBUTE`, `ROUND_MODE_ATTRIBUTE`, `TEAM_ATTRIBUTE`, `SPECTATING_ATTRIBUTE`, `RESPAWN_AT_ATTRIBUTE`, `COINS_ATTRIBUTE`, `OWNED_POWERS_ATTRIBUTE`, `OWNED_COSMETICS_ATTRIBUTE`, `CROWN_ATTRIBUTE`, `STAT_HITS` / `STAT_OUTS` / `STAT_RATIO`, `BALL_ABILITY_ATTRIBUTE`, `ARMED_ABILITY_ATTRIBUTE`, `CHARACTER_BARRIER_TAG`, `MATCH_JOIN_A_TAG` / `MATCH_JOIN_B_TAG`, `MATCH_SPAWNER_TAG`, `PRACTICE_ZONE_TAG` | `shared/constants.ts` | **imported, not copied.** This is the list to check first: every one of them is read by two files or more, and every one of them is a *string* that a typo would silently break |

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
