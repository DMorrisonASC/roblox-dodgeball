# Tags

**Every `CollectionService` tag in the game, in one place, because the strings cannot be imported
from each other and nothing in the build catches a typo.**

A tag is a string that lives on an instance and is read by whatever asks for it. There is no type
across files, no compiler check, and no runtime warning: a renamed tag does not fail, it *stops
matching*, and the code that reads it goes quiet in exactly the way a working path also looks quiet.
This file is the list.

## Why there are copies at all

Two separate reasons, and they are why this cannot be one shared constant:

1. **A Flamework component's `tag` is a decorator argument**, and Flamework reads it at build time
   from the source text. It has to be a literal, so no file can import it — including the file that
   declares it. This is why `BallComponent`'s `tag: "Ball"` is the source of truth and the six other
   `const BALL_TAG = "Ball"` declarations are copies.
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
| `RoundBall` | `BallSpawnerService`, `ROUND_BALL_TAG` | `BallSpawnerService.spawn` | `BallSpawnerService.cleanupRoundBalls` |
| `BallSpawner` | `BallSpawnerService`, `SPAWNER_TAG` | *painted in Studio* | `BallSpawnerService.tick` |
| `CharacterBarrier` | `shared/constants.ts`, `CHARACTER_BARRIER_TAG` | *painted in Studio* | `CollisionGroups.applyBarrierGroups` |
| `NPC` | `npc/Behavior.ts`, `NPC_TAG` | `NpcService.spawn`, `RespawnBehavior`, or painted in Studio | `NpcService`, `CollisionGroups`, `RoundService`, `OutlineService` |
| `Behavior_Catching` | `npc/Behavior.ts`, `BEHAVIOR_CATCHING` | `NpcService.spawn` / `RespawnBehavior` / painted | `NpcService`'s per-behavior gate |
| `Behavior_Throwing` | `npc/Behavior.ts`, `BEHAVIOR_THROWING` | as above | as above |
| `Behavior_Pickup` | `npc/Behavior.ts`, `BEHAVIOR_PICKUP` | as above | as above |
| `Behavior_Respawn` | `npc/Behavior.ts`, `BEHAVIOR_RESPAWN` | as above | as above |

**There is no player tag.** "Is this a person?" is `Players.GetPlayerFromCharacter`, which is a
question about the player list rather than about the instance — so the player side of the game never
appears in this file.

## `Ball` — the one with eight copies

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
  itself. The real number is eight occurrences of the string, including the decorator.

## `RoundBall` — the round's furniture

A **second** tag rather than a reuse of `Ball`, because the two answer different questions: `Ball`
means "this is a dodgeball — pick it up, throw it, hit people with it", and every ball carries it;
`RoundBall` means "this one is part of the arena's furniture and goes when the round does", and only
`BallSpawnerService` applies it.

Swept by `cleanupRoundBalls` at the end of a round, which **leaves a ball that is in somebody's hand
alone** — destroying a ball out of a hand would take it from a player mid-action for a reason that
has nothing to do with them. The tag comes off before the destroy, so a ball on its way out is not
counted as the round's for the frame in between.

## `BallSpawner` — painted, not written

Marks a part as a piece of arena that keeps loose balls around it. Read by `tick`, and the read has a
second condition worth knowing: the part must also be **a descendant of `Workspace`**. `MapService`
clones the next arena during an intermission and holds it out of the world, and a `Clone` carries its
tags — so without that check the loop would stock an arena nobody can see, dropping balls into empty
space.

A misspelling is silent: that part is never topped up, and nothing says so.

## `CharacterBarrier` — painted, not written

Marks the arena's midline wall. Read by `CollisionGroups.applyBarrierGroups` as the map is placed.

**The tag and the part's flags are one contract.** The wall only works because `CanTouch` and
`CanQuery` are `false` on it — that is what lets a ball cross without reporting a world contact and
lets the aim guide pass through. A misspelled tag makes the wall a plain `Default` part: characters
cross it and balls bounce off it, which is the exact symptom pair described in
`shared/constants.ts`.

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

## Cloning

`Clone()` copies tags, and two places depend on knowing that:

- `MapService` clones arenas out of `ServerStorage` — the clone arrives with every tag the template
  had, which is why `BallSpawnerService` has to check the world, above.
- `RespawnBehavior` clones the corpse to build the replacement, strips the tags off the template, and
  puts them back on the rig at the end of the life — so a rig that gains a behaviour tag while alive
  keeps it through death.

## Not tags, but the same trap

These are the other strings two or more files have to agree on. They are listed rather than
duplicated — the source of truth is the file named.

| String | Source of truth | Also spelled out in |
| --- | --- | --- |
| `"Armed"` | `BallFactory` sets the first value; `BallService` sets it on a hand-out and a throw | `BallComponent`, `BallPickupService`, `BallSpawnerService`, `CatchBehavior`, `CatchService` |
| `"ThrowerId"` | `BallService.throwBall` | `BallComponent`, `BallFactory` (cleared to `""`) |
| `"StatsRecorded"` | `BallComponent` | — (one file) |
| `"ObjectOutline"` | `OutlineService` (`OUTLINE_NAME`) | `AimTargetController` |
| `"Playing"` / `"Intermission"` | `RoundService` publishes them as the phase name | `BallSpawnerService`, `OutlineService`, `StatsService`, and the client's `RoundStatusController`, `RoundResultController`, `StatsBillboardController` |
| `DodgeballBall` | `shared/constants.ts` (`BALL_NAME`) | **imported, not copied** — the one of these that is a real shared constant |
| `THROWER_TOKEN`, `ROUND_STATE_ATTRIBUTE`, `TEAM_ATTRIBUTE`, `SPECTATING_ATTRIBUTE`, `CHARACTER_BARRIER_TAG` | `shared/constants.ts` | **imported, not copied** |

## How to check

- **Studio:** the Tag Editor lists every tag a place actually has, which catches a tag that is painted
  but misspelled. `CollectionService:GetAllTags()` in the command bar answers the same question as
  data.
- **In code:** searching for the string is the only way, which is precisely why the copies are worth
  having written down. When one of them changes, change all of them — including the literals inside
  `GetAttribute(...)` calls, which are not `const`s and do not show up in a search for the constant's
  name.
- **In the log:** every tag this game prints comes with the instance it was read from, so a warm-up
  round exercises most of this list.
