/**
 * The names and keys that more than one file has to agree on: what the ball is called, the
 * attributes a ball, a player and the round carry, and the folder the round's state is
 * published on.
 *
 * Everything a person would change to alter how the game *feels* lives in
 * `shared/config/` instead — the ball and its throws in `ball.config.ts`, the
 * dash in `dodge.config.ts`, the catch in `catch.config.ts`, the round in
 * `arena.config.ts`.
 *
 * What is left here is what code has to *agree* on rather than choose: a part name
 * several files match against, and an attribute key. Those are not tuning
 * choices. `BALL_SIZE` is the one number in here, and it is here because it
 * is what the ball *is* rather than how it behaves — the aim guide's spherecast
 * radius and the solve's aim offset are both derived from it.
 */

/**
 * Name of the ball part that gets welded to a player's hand and then thrown.
 *
 * Shared so the client can tell whether the local player is currently holding
 * a ball (and therefore whether a click should throw one).
 */
export const BALL_NAME = "DodgeballBall";

/**
 * Tag marking an arena part as a barrier that stops **characters** and lets everything else through.
 *
 * **A name a person sets in Studio and code has to agree with**, which is what puts it next to
 * `BALL_NAME` rather than among the tags below it — this is not a label code puts on something, it
 * is a label somebody paints on a part in the place file. It is read in exactly one place
 * (`collision/CollisionGroups.ts`, as the map is placed) and that is a reason to keep its rules
 * here in its own comment, not to keep the constant private to that file.
 *
 * **`CanTouch` and `CanQuery` are load-bearing, and both are the counter-intuitive pair.** A ball
 * crossing this wall must not report a world contact — a `Touched` event would disarm it mid-flight
 * and score the throw as a miss — so the part is **`CanTouch = false`**. And the aim guide walks the
 * world with a spherecast, so **`CanQuery = false`** is what lets the preview pass through the wall
 * and go on telling the truth about where a throw will land. Turning either one back on to "make the
 * wall more solid" reintroduces both bugs: a wall the ball bounces off mid-arena, and a guide that
 * stops at the centre line. See `SoundEmitter`'s note on the same two flags, kept for the same
 * reason — and see `collision/CollisionGroups.ts` for this wall beside the other one.
 *
 * **This is not the arena's edge.** An edge wall is a `Default` part with all three of `CanCollide`,
 * `CanTouch` and `CanQuery` true and **no tag at all**: `Default` collides with `Default`, which is
 * exactly what stopping characters *and* balls means. Tagging one would invite a reader to route it
 * through this wall's code and silently take the balls out of it.
 */
export const CHARACTER_BARRIER_TAG = "CharacterBarrier";

/**
 * Tag marking a part as a wall that stops **dodgeballs** and lets every body walk through it.
 *
 * **The sibling of {@link CHARACTER_BARRIER_TAG} and the opposite wall on both axes it can differ on.** That one
 * is solid to bodies and transparent to balls; this one is solid to balls and transparent to bodies. A pair of
 * walls with one job each, rather than one wall with a mode — which is why there are two tags and not an attribute
 * on one tag.
 *
 * **`CanCollide`, `CanTouch` and `CanQuery` are all true, and the collision/group assignment forces them.** They are
 * not left to the place file, because a wall painted as an invisible marker usually has `CanCollide = false` and then
 * the group row is a rule about a part that is solid to nothing — **the reported symptom was a ball thrown straight
 * through a wall whose log said `BallBarrier = BallWall`, which is correct and useless on its own.**
 * `CollisionGroups.dressBallWall` sets `Anchored`, `CanCollide`, `CanTouch` and `CanQuery` and warns naming any it had
 * to correct, in `MatchService.prepare`'s shape.
 *
 * **`CanQuery` is true so the aim guide's spherecast stops here**: if a throw will bounce off a wall, an arc that drew
 * itself through the wall would be the lie `CHARACTER_BARRIER_TAG` exists to prevent in the other direction. That is
 * the opposite of the midline wall's `CanQuery = false`, and correct for the opposite reason.
 *
 * **A wall thinner than a fast ball's travel per frame cannot stop it, and the tag now lifts that limit instead of
 * reporting it.** Roblox does not sweep a collision between frames: at `THROW_MAX_SPEED` a ball covers ~3.3 studs per
 * frame, so a 1- or 2-stud wall is passed through without the two ever overlapping. `CollisionGroups.thickenBallWall`
 * grows the part along its thinnest axis to `ceil(THROW_MAX_SPEED / 60) + 1` studs — five today — centred where the
 * part already was, and warns naming both numbers. **A thicker part is still the fix; the difference is that the tag
 * makes it rather than asking.** It was a warning for one pass, and that pass cost a round-trip: the user was told to
 * go and edit a size in Studio and reported the same fault back.
 *
 * **It is not `CanCollide = true` alone that keeps a player out, and the collision group is what does it.** The
 * wall is `CanCollide = true` and yet a body walks through, because `collision/CollisionGroups.ts` puts these
 * parts in a group that does not collide with any character group. A reader who finds the wall solid in Studio and
 * "fixes" it by turning `CanCollide` off takes the ball's bounce with it, and one who removes the tag takes the
 * group away — leaving a wall that collides with `Default` and therefore with the character too. **The tag is the
 * group**; see `applyBallWallGroups`.
 *
 * **The ball in a hand is a different mechanism, and it is geometric.** A welded ball is `CanCollide = false` and its
 * pair with this wall is non-collidable by group, so no contact happens at all — the first version hung the rule on
 * the wall's `Touched` and that is why *"nothing happens when I tag a part"* was reported. `BallService.pumpBallWalls`
 * asks where the ball is instead. **Two mechanisms because a loose ball is a body and a held ball is not**: a query
 * cannot catch a ball crossing a thin wall between frames, and a solver cannot see a welded one. **That is why the
 * thickness matters and the sweep is not a substitute for it** — the sweep answers "is a held ball inside the wall",
 * which is a question about a body that is always somewhere; the bounce is the engine's and the engine needs the two
 * to actually overlap.
 */
export const BALL_BARRIER_TAG = "BallBarrier";

/**
 * Tag marking a part the **aim preview** passes through and the **physics** does not.
 *
 * **A label somebody paints on a part in the place file**, exactly like {@link CHARACTER_BARRIER_TAG}
 * above. What it is for: the invisible walls around the stadium that stop a thrown ball leaving the map.
 * Those walls are solid, so the swept sphere the aim guide draws with hits them and the arc stops a few
 * studs in front of the thrower — the guide then describes a throw that bounces off a wall nobody can
 * see, and a player reads it as the game refusing to aim.
 *
 * **Read by `client/controllers/input/ThrowController`, in its exclusion list**, which is the same list
 * `aimPoint`'s raw ray and the assist's sight test both use. Ignored by the aim preview, obeyed by the
 * ball: nothing here touches collision, collision groups or the server, so a ball thrown at one of these
 * walls bounces exactly as it did before this tag existed.
 *
 * **`CanQuery = false` is the mechanism and this tag is the statement, and both are wanted.** A part with
 * `CanQuery = false` is invisible to *every* query in the game — the guide's spherecast, the aim ray, the
 * sight test, the probes — which is the cheapest possible version of this fix and the one to prefer. What
 * the tag adds is the part of that property a file can hold: a fact a reader can grep, a name that
 * survives somebody re-enabling the flag "to make the wall more solid", and a reason written down. **With
 * `CanQuery = false` this tag changes nothing about the preview**, and that is the intended pairing rather
 * than a redundancy to remove: the flag is the behaviour, the tag is the intent.
 *
 * **Not {@link CHARACTER_BARRIER_TAG}, and the difference is the whole reason this one exists.** That tag
 * means *characters and not balls*: `CollisionGroups.applyBarrierGroups` puts its parts in the `Barrier`
 * group, which is registered non-collidable against `Ball`, so a stadium wall wearing it would let every
 * ball straight out of the map. An edge wall and a midline wall are opposites on the axis that matters
 * here, and this tag is the one that says "stops the ball" — see that tag's own note on why an edge is
 * deliberately untagged, and `TAGS.md` for what happens when the two are confused.
 */
export const AIM_IGNORE_TAG = "AimIgnore";

/**
 * A lobby part that turns the custom shift lock on while a player stands inside it.
 *
 * **A label somebody paints on a part in the place file**, exactly like {@link CHARACTER_BARRIER_TAG}
 * above and for the same reason: the box is level design rather than a number, and moving it is a
 * Studio edit. Read in one place — `client/controllers/camera/ShiftLock.ts`, which checks it in every
 * phase, so a zone is a zone whenever a player is standing in one.
 *
 * **The part's dimensions *are* the zone.** There is no separate radius or extent: the check asks
 * whether any part of the local player's body overlaps the part's own box, so it is whatever size and
 * rotation the builder gave it. Any number of them may exist; a player inside any one of them is
 * inside the zone.
 *
 * **Anywhere in `Workspace`, and only in `Workspace`.** The check walks the whole tag with no path,
 * name or model assumed — loose at the top level, in a folder, inside a model, all of them count
 * equally, and nothing is expected to be called "Lobby". What it does *not* count is a part that is
 * outside the world: a tagged part in an arena that has been loaded but not yet placed is still
 * returned by `GetTagged` (a `Clone` copies its tags — the same fact `BallSpawnerService` had to guard
 * against), and its box would be evaluated at those coordinates anyway. So the part has to be a
 * descendant of `Workspace`, exactly as the spawners require. A box that is not in the world is not
 * somewhere a player can walk.
 *
 * **`CanTouch = false`, and that is not what stops the detection.** It is tempting to read it as
 * "this part is inert, so nothing will find the player in it" — the opposite is true. Nothing here
 * uses `Touched` at all: the check is a box overlap, which needs neither touch events nor collisions,
 * and `CanTouch = false` is there to stop the part generating touch events *at all* — an invisible box
 * that reported touches would be handing `Touched` to every ball, rig and character passing through it
 * for no reason. **`CanQuery = false`** is the other half, on the same reasoning as the barrier's: the
 * aim guide walks the world with a spherecast, and a zone would otherwise be something the preview
 * stopped on. Neither flag affects the overlap check.
 *
 * **No collision group**, unlike the barrier: this part is not meant to affect anything, and a group
 * would be a statement that it does.
 *
 * **A rename, and not an alias.** This was `SHIFT_LOCK_ZONE_TAG = "ShiftLockZone"` until the
 * practice-zone work. The old string is deliberately **not** accepted alongside the new one: a reader
 * that matched either would keep a half-repainted place file working for exactly as long as it took
 * somebody to notice, and what that hides is the failure this whole file exists to warn about — a tag
 * that stops matching goes quiet in the same way a working path does. So the value changed, the
 * constant's name changed with it, and a part still wearing the old string reads as **no zone at all**.
 * `[ShiftLock] up — N practiceZone part(s)` is the line that says which of the two you have.
 */
export const PRACTICE_ZONE_TAG = "practiceZone";

/**
 * Tag on **one bay of the practice floor** — the box a single drill rig owns, and the whole of what decides
 * whether that rig throws.
 *
 * **A bay is a footprint, not a box, and that distinction cost three rounds before it was written down.** The
 * first version of this feature asked `Workspace.GetPartBoundsInBox` about the bay's own `CFrame` and `Size`,
 * which is a *three-dimensional* test — and a bay painted on a floor is a slab an inch thick, so a rig's
 * `HumanoidRootPart` (about three studs up) **did not intersect it at all**. Three symptoms came out of one
 * mistake: the rig was not recognised as being in its bay, a player standing in it was not either, and a ball
 * leaving the hand at head height was "out of bounds" on its first settle turn and destroyed at the muzzle.
 * **`npc/practiceBay.ts` is where the rule now lives**, as a vertical prism over the part's X/Z footprint with
 * height ignored entirely — which is what a person painting a box on a floor is drawing anyway.
 *
 * **The part's flags are the same contract as a zone's, for the same reasons**: `CanTouch = false` and
 * `CanQuery = false`, so a bay is somewhere bodies stand rather than a surface — a queryable one would be
 * something the aim guide's cast stopped on, and a touchable one would hand `Touched` to every ball that
 * crossed it. **No collision group**, because a bay does not affect anything; it is a place, not a wall.
 *
 * **Anywhere in `Workspace` counts and nothing outside it does**, exactly as {@link PRACTICE_ZONE_TAG} argues:
 * a tagged part still sitting inside an unplaced arena is returned by `GetTagged`, and a box that is not in the
 * world is not somewhere a player can walk.
 *
 * **Placeholder**: rename the string and the place file together. No alias is accepted, and the reason is the
 * one written out at length on `PRACTICE_ZONE_TAG` — a reader that matched both spellings would keep a
 * half-repainted place file working for exactly as long as it took somebody to notice.
 */
export const PRACTICE_BAY_TAG = "practiceBay";

/**
 * Tag on a **rig** — the one that makes it a drill: it throws at a player standing in its own
 * {@link PRACTICE_BAY_TAG} and at nobody else.
 *
 * **Deliberately not named `Behavior_*`, and that is cosmetic rather than structural.** The tag *is* the
 * dispatch key, exactly as `Behavior_AlwaysThrowing` is: `NpcService`'s list of behaviours is keyed on
 * `behavior.tag`, so this string turns on `PracticeThrowBehavior` in precisely the same way, and the
 * `[Rig]`/`[NPC]` output cannot tell the two apart. The name says **what the rig is for** rather than which
 * module runs it, because that is the question a person painting it in Studio is actually asking. See
 * `PracticeThrowBehavior` for why the drill needs a tag of its own rather than a mode on the always-thrower:
 * the always-thrower has no target and never had one, and giving it one would have meant a rig that behaves
 * differently depending on geography it cannot see.
 *
 * **It is painted on the rig before `NPC`**, for the rule `NpcService.spawn` writes down — `NPC` is what starts
 * the rig, so a tag arriving after it is a tag whose behaviour misses the turn it could have run on. Painted by
 * hand in Studio that ordering is whatever the Tag Editor did, and the cost is one tick: the loop asks
 * `HasTag` every turn, so a behaviour tag added later starts on the next.
 *
 * **`Behavior_AlwaysThrowing` is not retired by this tag existing.** The user stopped painting it on drills
 * rather than the code being removed, so the two are independent: a rig wearing both runs both, and that is
 * left alone deliberately — a mutual-exclusion rule is one nobody asked for, and the double throw it produces
 * is the honest reading of a rig wearing two throwing tags.
 *
 * **Read in three places, and they agree because they import this**: `PracticeThrowBehavior` (is this rig a
 * drill), `BallService.throwBallBody` (mark the ball this rig throws, see
 * {@link THROWN_FROM_BAY_ATTRIBUTE}), and `client/practiceCountdown.ts` (is this rig one to draw a countdown
 * over).
 */
export const PRACTICE_THROW_TAG = "practiceThrow";

/**
 * Tag marking a place a mystery box appears.
 *
 * **Read by `server/services/mystery/MysteryBoxService.ts` alone**, and it is the second tag in this file
 * whose contract is "put it where you want the thing" — see {@link MATCH_SPAWNER_TAG}, which is the first.
 * The part is a *placement decision* and nothing more: the service reads where it is and puts a box there,
 * so a spawn point can be moved, regrouped or nested and it is still a spawn point.
 *
 * **`CanQuery = false` and `CanCollide = false` on the part, so a spawn point is not felt even though it is
 * somewhere players walk.** The aim guide's cast must pass through one, and nothing should be able to stand
 * on it. It needs no `CanTouch` — the *box* is what is touched, and the part itself never has to report
 * anything.
 *
 * **Inside a `practiceZone` a tagged part behaves differently, and that is a rule about where the part is
 * rather than about the part.** A spawn point in a zone is stocked continuously instead of rolled for, so
 * the same tagged part is a rare thing on the field and a fixture on a practice floor. The service does the
 * bounds test; nothing about the tag or the part changes.
 */
export const MYSTERY_SPAWN_TAG = "mysterySpawnPrize";

/**
 * Tag marking a model as one `NpcService` manages — and, now, the tag a client finds rigs by.
 *
 * **It lived in `server/npc/Behavior.ts` and is here because a client needs it.** The four
 * `Behavior_*` tags are still declared there, beside the behaviors they switch on, and that is where
 * they belong: `NpcService` is their only reader in the game. This one stopped being like them when
 * rigs became something a client animates — `RigAnimationController` finds the rigs it dresses by
 * exactly this string — and a client file cannot require a *server* module: everything under
 * `src/server` is mapped into `ServerScriptService`, which does not exist on a client at all. So the
 * constant moved to the file that exists for names two machines must agree on, and `Behavior.ts`
 * re-exports it, so the eight server files that read it did not have to change.
 *
 * **The entry point of the behavior system rather than a behavior itself**: a model wearing this is
 * managed, and each `Behavior_*` tag on it enables one mechanic — a rig wearing this and no behavior
 * tag is managed and does nothing. `TAGS.md` records the ordering rule (behaviors on first, this last)
 * and why a rig is managed only while it is in the world.
 */
export const NPC_TAG = "NPC";

/**
 * Which power a collected mystery box is paying for, on the `Player`. Empty string for none.
 *
 * **Published by `SuperService`, which holds the prize, and written with the rest of that readout** — see
 * its `publish`. This is now the *whole* of the prize's publication: there is no clock behind it, because a
 * box's power is held until it is used or lost rather than for a fixed ten seconds, so this attribute is a
 * state rather than the start of a countdown. `MYSTERY_POWER_ENDS_AT_ATTRIBUTE` was the second half of the
 * pair and is gone with the timer it described.
 *
 * **A string rather than the row itself, because a client cannot read a `Map`.** The kind is one of the
 * words in `shared/ability.ts`, which is the same vocabulary the mark remote speaks — so a client that
 * already knows how to name an ability does not need to learn a second one to say what a box gave. The HUD
 * reads it for two things: what the power slot shows while a prize is held, and the moment the reveal flash
 * has to run — a change to a non-empty value is a pickup, and it is the only thing that starts one.
 */
export const MYSTERY_POWER_ATTRIBUTE = "MysteryPower";

/**
 * Marks a whitelisted dev, on the `Player`. Read as `=== true`, so an absent attribute means no.
 *
 * **The string `DevService` has always written, in the shared file so the client can read it without
 * spelling it a second time.** The client has to know *before* it binds a key, and one fact shared by two
 * machines written out twice is the copy this arrangement exists to avoid — `DevService` now imports this
 * name instead of defining its own. It is a `Player` attribute like the two above, read by anything that
 * can see the `Player`, which is the property `DevService` chose it for in the first place.
 *
 * **What a client is allowed to believe it means: which keys to listen for, and nothing else.** A key
 * bound on the strength of this attribute is a convenience for a developer. What any press actually does
 * is decided on the server, which asks `DevService.isDev` — reading this same attribute for itself — and
 * never trusts that this machine saw the flag at all.
 */
export const IS_DEV_ATTRIBUTE = "IsDev";

/**
 * Tags marking the two parts a player walks into to pick a side for the next match.
 *
 * **One tag per side, and the split is the whole rule: the part you touch is the side you ask for.**
 * There used to be one `MatchJoin` part, and the service placed whoever touched it on whichever side
 * was emptier — the player said "I would like to play" and `MatchService` chose the team. These two say
 * what the one part could not: **the player chooses**, by walking up to the sign they want, and
 * touching the *other* part moves them again until the match starts. A choice made by walking is one
 * visible in the lobby and needs no menu, which is why this is two parts rather than one part and a
 * prompt.
 *
 * **A label somebody paints on a part in the place file**, exactly like {@link CHARACTER_BARRIER_TAG}
 * and {@link PRACTICE_ZONE_TAG} above, and read in one place — `services/match/MatchService.ts`,
 * which decorates the part, connects its `Touched` and puts that side's counts sign above it.
 *
 * **`CanTouch = true` on both, and that is the exception rather than an oversight.** The barrier and
 * the zone are deliberately `CanTouch = false`, so that an invisible box does not hand touch events to
 * every ball that crosses it; these parts' whole job *is* the touch, so they are the case the other two
 * are the rule against. `CanQuery = false` for the reason both of them have it — the aim guide casts
 * through the world, and a lobby prop must not be what the preview stops on. `CanCollide = false`,
 * because a lobby is somewhere people walk.
 *
 * **And `Anchored = true`, which the old lobby spawn was not.** That part walked off the bottom of the
 * world and the engine destroyed it at `FallenPartsDestroyHeight`, with no Lua on the stack and nothing
 * in the output — the failure these parts must not repeat. `MatchService` sets all four from code and
 * warns when it has had to, so the trap is a line in the log rather than an afternoon.
 *
 * **A side's own part, and nothing else.** These say *which side*, not *which match*: the roster is
 * still cleared at the end of every match, so a player picks again next time, and both tags are read
 * by the server only — nothing on the client needs to know which part is which side.
 */
export const MATCH_JOIN_A_TAG = "MatchJoinA";

/** The other side's part. See {@link MATCH_JOIN_A_TAG}. */
export const MATCH_JOIN_B_TAG = "MatchJoinB";

/**
 * Tag marking the region a rig **may** fetch a ball from — **one box per side, painted in Studio.**
 *
 * **Inverted 2026-10-13, and the inversion is the whole of it: this used to be a no-go box.** A rig used to
 * read the *other* side's box and skip the balls inside it, which excluded one region and left every other
 * ball in `Workspace` a candidate — so a round rig would cross to the enemy's half, or walk into the practice
 * court or the lobby, for a loose ball, and the report that produced this change is a rig walking to the lobby
 * for one. The reading now is the rule the user asked for: **a round rig fetches only what is inside the box
 * painted for its own side**, and a ball anywhere else is not a candidate at all. `npc/sideZones.ts` finds the
 * parts; `SeekBehavior` owns the test.
 *
 * **What it is still for.** A ball that ends up on the far side of the court is unreachable, and the way
 * `Behavior_Seeking` discovers that is the expensive way: `MoveTo` walks a straight line and cannot go round
 * anything, so a rig sent after it crosses the midline, is stopped by the barrier, and spends its whole
 * patience pressed against a wall before giving up on that ball and choosing another. An allow-list skips
 * those balls *before* the rig sets off, which is what stops the walk being made at all.
 *
 * **And the cost is the other direction, which is a place-file fact rather than a code one.** A box that does
 * not cover everything a rig on that side can walk to makes the rig ignore balls it *could* reach — quieter
 * than a rig pressed against a wall, and worse, because a side whose box is missing or too small simply stops
 * fetching. The two counts on the boot line are the only warning there is; see `LobbyRigService`.
 *
 * **The names are kept although "keep-out" now reads backwards.** The strings are painted in the place file,
 * and a rename would silently stop matching — the failure `PRACTICE_ZONE_TAG` above writes down at length — so
 * the constant keeps its name and this doc carries the correction.
 *
 * **The side is in the tag rather than in an attribute**, exactly as the join parts above work — and the pair
 * is why a server that finds only one of them can name which one is missing rather than saying "something is
 * wrong with the arena".
 *
 * **`Anchored`, and invisible, and all four flags the join parts use, for the reasons that doc gives**: a box
 * somebody can walk into must not collide, must not hand `Touched` to every ball that crosses it, and must not
 * be what the aim preview stops on. Its `CFrame` and `Size` *are* the region — there is nothing else to
 * configure, and moving it in Studio is the configuration.
 */
export const SIDE_KEEP_OUT_A_TAG = "SideKeepOutA";

/** The other side's box. See {@link SIDE_KEEP_OUT_A_TAG}. */
export const SIDE_KEEP_OUT_B_TAG = "SideKeepOutB";

/**
 * Tag marking a piece of arena that keeps match balls beside it.
 *
 * **A marker, and the only thing read from it is where it is.** `BallSpawnerService` puts one ball
 * beside each tagged part while a match is running, so a spawner is a *placement decision* — where the
 * balls should be — and placing one is done in Studio by tagging a part, with nothing to write and
 * nothing to register. Several are independent, and the tag is how the loop finds them all without
 * being told about any of them. It reads the part's `Position` and `Size` and nothing else, so the
 * part needs to be somewhere a ball can lie rather than shaped in any particular way.
 *
 * **Named for the match, and that is the whole reason for the name.** The tag used to be
 * `BallSpawner`, which said nothing about *which* game wanted the balls — and a practice court wants
 * its own floor stocked without a match running, so that service needs a tag of its own. Naming this
 * one for the context it belongs to is what leaves room for the second, and it had to be done before
 * the second existed rather than after: a rename once two services read the tag is a rename with a
 * broken half in the middle.
 *
 * **A label somebody paints on a part in the place file**, exactly like {@link CHARACTER_BARRIER_TAG}
 * and {@link PRACTICE_ZONE_TAG} above — and, like the join tags below, it may equally be put on a
 * folder, because every reader goes through `taggedPartsInWorkspace`, which expands a container into
 * the parts inside it.
 *
 * **`Anchored = true`, which the old lobby spawn was not, and the three flags off.** That part walked
 * off the bottom of the world and the engine destroyed it at `FallenPartsDestroyHeight`, with nothing
 * in the output — the failure a spawner must not repeat, because a part that has fallen is a part with
 * no balls beside it and no evidence that anything went wrong. `CanCollide`, `CanTouch` and `CanQuery`
 * are all `false` so that a floor marker is not something to walk into, is not handed touch events it
 * has no use for, and is not what the aim guide's spherecast stops on.
 *
 * **Nothing sets any of that from code**, unlike the join parts — the spawner only reads the part — so
 * these are the flags to give it in the place file.
 */
export const MATCH_SPAWNER_TAG = "MatchSpawner";

/**
 * Attribute naming whoever a ball belongs to, carried on the **thrower's model**.
 *
 * The value is a string token rather than a `UserId`, because a thrower is not
 * always a player: a player's token is their `UserId` as text and an NPC's is a
 * GUID. The ball's own `ThrowerId` attribute is a copy of whichever one threw
 * it, so the immunity check can be a single string comparison that never has to
 * ask what kind of thing the thrower was. See `BallService.tokenOf` and
 * `BallComponent`.
 */
export const THROWER_TOKEN = "ThrowerToken";

/**
 * Attribute on a **`Player`** naming the team they are on for the round in progress.
 *
 * Written by `RoundService` at the start of every playing phase, and read by anything that
 * needs to know who is on which side — a HUD, a per-team spawn. An attribute rather than a
 * service field for that reason: the answer is visible to the client without a remote, and it
 * survives the player's character being replaced, which a character attribute would not.
 *
 * The value is a team label, and the two are `"A"` and `"B"`. A player between rounds — or
 * one who joined while a round was already under way — has no attribute at all, which is how
 * a reader tells "not playing" from "playing for somebody".
 */
export const TEAM_ATTRIBUTE = "Team";

/**
 * Attribute on a **`Player`** saying the round in progress still has them **in** it, as `true`.
 *
 * **The same question `TEAM_ATTRIBUTE` is asked for, and it is a different question.** A side is
 * what a body *wears*; being in the round is `RoundService`'s `activePlayers`, and the two part
 * company twice, both times on purpose:
 *
 * 1. **A surrender.** `MatchService.release` frees the roster seat and `RoundService.eliminate`
 *    takes them out of the round, while `teams` deliberately keeps the entry so `rosterOutcome`
 *    still counts them as one of their side's bodies. The side therefore stays on the `Player`
 *    until the next whistle clears it, and a reader that treats "has a side" as "is playing" goes
 *    on offering them the round they have just left.
 * 2. **An elimination.** Out of the round, standing in the lobby, still wearing the side — the
 *    same reading, with no request behind it.
 *
 * **Published rather than derived on the client, because there is nothing to derive it from.**
 * `activePlayers` is server-side and never replicated, and a client-side guess ("my body spawned
 * in the lobby, so I am out") is wrong for a respawn mode, where a dead player is still in the
 * round and comes back to it. So the server says it, at exactly the four places membership
 * changes: cleared for everybody where `assignTeams` clears the side, written where a player is
 * added to `activePlayers` (the round-start loop and `admitWithCover`), and cleared in
 * `eliminate` — the one method that takes somebody out of a live round.
 *
 * **Absent, not `false`, when they are out**, which is `TEAM_ATTRIBUTE`'s convention and the same
 * reason: an attribute's absence is the client's one test.
 */
export const IN_ROUND_ATTRIBUTE = "InRound";

/**
 * Attribute on a **ball** naming the side of the body it has tagged, or `""` when it has tagged nobody.
 *
 * **Written by `BallComponent` at the moment of the tag and cleared wherever the tag list is**: a re-arm (a
 * new throw), a resolution on the world (the tags became deaths) and a catch (the tags were released). So
 * "this attribute is a label" and "this ball owes somebody a death" are the same instant, which is the only
 * reading a reader needs to act on.
 *
 * **Published for one reader: the client's `CATCH IT!` prompt**, which shows itself only to players on that
 * side. It is *not* part of the catch rule — the server decides catchability from the ball's ability, its
 * parent and the catcher's own window, and a body is free to catch a ball it has been tagged by (that is
 * exactly the save the prompt is advertising). See `BallComponent.handleTouch` for both halves.
 *
 * **An attribute rather than an event**, for `TEAM_ATTRIBUTE`'s reason: every client can see it with no
 * remote, and the value is a *state* that ends when the tag does, so a client that joins mid-flight reads the
 * truth rather than missing a message.
 */
export const BALL_TAGGED_TEAM_ATTRIBUTE = "BallTaggedTeam";

/**
 * Attribute on a **ball** naming the bodies it has tagged, `|`-joined, or `""` when it has tagged nobody.
 *
 * **Written and cleared at exactly the same moments as {@link BALL_TAGGED_TEAM_ATTRIBUTE}** — the tag itself, a
 * re-arm, a resolution on the world and a catch — because the two are one statement of state read by two
 * different questions. `BallComponent.publishTaggedBodies` is the writer, and it is called beside every mutation
 * of the list, so "the list is empty" and "the attribute is empty" cannot drift apart.
 *
 * **Published for the one reader that has to know whether a *particular body* was hit: the perfect dodge's
 * measurement.** `DodgeService.watchForPerfectDodge` opens when a dash starts, and a ball that tagged the body
 * *before* that instant is invisible to any geometric test it can run afterwards — the body has dashed away, so
 * the ball is several studs from where it stood. The log that found this had a body tagged at `20:15:30.512` and
 * a "perfect dodge" reported against it at `20:15:30.793`, 281 ms later: the body was already hit and the watch
 * knew nothing about it. **The tag list is the only signal that answers "was this body hit", which is why it is
 * published rather than the list staying private.** See that method for what the alternative cost.
 *
 * **A name list rather than a count or a set of ids.** The name is the identity every other cross-service fact
 * about a body uses — `hitImpact` and `teamWipe` compare model names against `Players.LocalPlayer.Name` — and a
 * model name is the player's name for a character and the rig's own for a rig, so one string answers both. It is
 * a *string* rather than an array because attributes cannot carry tables.
 */
export const BALL_TAGGED_BODIES_ATTRIBUTE = "BallTaggedBodies";

/**
 * Attribute on a **`Player`** holding the server-time instant at which their next dodge is allowed.
 *
 * `Workspace:GetServerTimeNow()` seconds, written by `DodgeService` at the moment a dodge is
 * *accepted*. A refused dodge writes nothing — it was not charged for — so a reader watching this
 * attribute sees the bar restart only when the clock really did.
 *
 * An *instant* on the shared clock rather than a remaining time, because the reader can subtract it
 * from its own reading of that same clock. A duration would be as stale as the moment it was sent,
 * and an attribute carries no send time to correct it by.
 *
 * **Nothing reads it on a client any more**, since the readout that drew it as a bar was deleted; it stays
 * published for `DUCK_READY_AT`'s reason, which is that the writer of a cooldown is the service that owns it.
 */
export const DODGE_READY_AT = "DodgeReadyAt";

/**
 * Attribute on a **`Player`** holding the server-time instant at which their catch counts as ready
 * again.
 *
 * Written by `CatchService` when a catch window opens or is extended, and it covers the window
 * **plus** `ACTION_CONFIG.ACTION_LOCKOUT_SECONDS` — the tail after a catch in which a dodge is
 * refused. So the span this covers is the one the two actions share rather than a lock on catching:
 * a catch is possible again before the instant passes, because the tail shuts the *dodge*.
 *
 * On the player for the same reason as {@link DODGE_READY_AT}: a character is replaced on every
 * death and these clocks are not.
 */
export const CATCH_READY_AT = "CatchReadyAt";

/**
 * Attribute on a **`Player`** holding the server-time instant at which their next duck counts as ready
 * again, on {@link DODGE_READY_AT}'s terms exactly: an *instant* on the shared clock, written by
 * `DuckService` when a duck is accepted, and covering the duck **plus** `ACTION_CONFIG.ACTION_LOCKOUT_SECONDS`
 * — the tail after a duck in which the dodge and the catch are refused.
 *
 * Nothing reads it yet, and it is published anyway for `readyAt.ts`'s reason: the writer of a cooldown is
 * always the service that owns it, and a HUD that wanted a third bar should not be the thing that makes
 * the state exist. One line here, and no reader to keep in step with it.
 */
export const DUCK_READY_AT = "DuckReadyAt";

/**
 * Attribute on a **`Player`** holding how much sprint stamina they have left, in seconds.
 *
 * On the player for the same reason as {@link DODGE_READY_AT}: the pool outlives the character, so
 * dying does not hand out a fresh one. Written by `WalkSpeedService` at a throttled rate rather than
 * on every change — see the note below — and read by `SuperHudController`, which draws the pool as a
 * row of segments.
 *
 * **A level, where the two instants above are deadlines, and the difference is deliberate.** A
 * deadline has to be converted into a fraction against a clock the reader does not share exactly,
 * which is why {@link DODGE_READY_AT} is an instant and why its comment argues against sending a
 * duration. A stamina pool has no clock in it at all: the reader draws the value it is given, so
 * there is nothing to convert and nothing to go stale. The price is that this is a sample rather
 * than a prediction — up to one write interval behind — which on a three-second pool at ten writes
 * a second is a few per cent of a bar, and is the same order as the bar's own pixel width.
 *
 * The alternative, an instant like the two above, cannot describe the recovery pause: "refilling,
 * reaching full at T" is one value, and "stopped for another 0.3s and then refilling" is not — so
 * encoding that as a deadline needs a second attribute to say which of the two states the pool is
 * in. A level says both with one number, and the pause is simply the value not moving.
 */
export const STAMINA_ATTRIBUTE = "Stamina";

/**
 * The `ReplicatedStorage` folder the round's state is published on.
 *
 * **The HUD's whole channel.** `RoundService` writes the two attributes below on it and the
 * client reads them; nothing is ever sent, because attributes replicate on their own — so the
 * HUD needs no remote and no reference to the service that owns the round, and the round needs
 * no reference to the HUD. A folder by this name in `ReplicatedStorage` is the agreement.
 */
export const ROUND_STATUS_FOLDER = "RoundStatus";

/**
 * Attribute on {@link ROUND_STATUS_FOLDER}: which phase the round is in.
 *
 * The value is the phase's *name* as text — the one vocabulary the HUD has — so a reader can
 * print it without knowing what any of the phases mean. The names are the members of
 * `RoundState` by convention rather than by construction; they are written by hand in
 * `RoundService`.
 */
export const ROUND_STATE_ATTRIBUTE = "State";

/**
 * Attribute on {@link ROUND_STATUS_FOLDER}: whole seconds left in the phase.
 *
 * Written when the phase's clock is set and again after every second comes off it, so a reader
 * is never more than a tick behind. It does **not** move while rounds are paused — a stopped
 * countdown is the honest reading of a paused round, and nothing has to tell the client that.
 */
export const ROUND_TIME_ATTRIBUTE = "TimeRemaining";

/**
 * Attribute on {@link ROUND_STATUS_FOLDER}: who won the round that has just ended.
 *
 * A team's label, or `"draw"` — the same two words `RoundService` prints, because the round's
 * vocabulary is its own business and this is only a channel for it. Written when a round is
 * decided and left standing through the intermission that follows, which is where it is read; a
 * reader must not assume it means anything *during* a round, and the HUD does not.
 */
export const ROUND_WINNER_ATTRIBUTE = "Winner";

/**
 * Attribute on {@link ROUND_STATUS_FOLDER}: **the round is over and its result is being held for a moment.**
 *
 * A boolean, written by `RoundService.finishRound` and cleared when `ARENA_CONFIG.CELEBRATION_SECONDS` has
 * elapsed. Between the two, players are still standing in the arena and can walk and jump — and nothing else
 * is allowed to happen: no throw leaves a hand, no catch opens, and a ball that lands does no damage. See
 * `roundCelebrating` in `server/services/round/roundStatus.ts`, which is the one reader, and
 * `ARENA_CONFIG.CELEBRATION_SECONDS` for why the window exists at all.
 *
 * **A separate attribute rather than a fourth phase name**, which is the shape this was first written as and
 * the one that costs more than it buys. The phase already says `Intermission` while this is true — which is
 * what stops the rigs fighting, the spawners stocking and the powers arming, all without a line of code —
 * so a `Celebrating` phase would have had to be taught to every one of those eight `=== "Playing"` readers as
 * a second accepted value, and a phase the rest of the game has never heard of is a word that means nothing
 * to anybody who reads it. What this adds is the three refusals the phase cannot express, and it adds them
 * only where they belong.
 */
export const CELEBRATING_ATTRIBUTE = "Celebrating";

/**
 * Attributes on the **`RoundStatus` folder** holding each side's points, as numbers.
 *
 * **The one thing about a Score Rush round the client was never told.** `RoundService.scores` has been a
 * server-side `Map<TeamLabel, number>` since the mode was written — written on every hit and every catch,
 * read only to `print` a line and by the mode itself, and never published. There was no scoreboard because
 * there was nothing to draw one from.
 *
 * **Two attributes rather than one joined string or a folder of two children.** `ROUND_TIME_ATTRIBUTE` and
 * `COINS_ATTRIBUTE` are both bare numbers, and a reader of this wants a number rather than a string to split;
 * a folder would be a second instance to create, hold and clean up for two integers. The pair is written
 * together on every change — see `RoundService.publishScores` — so no reader sees one side newer than the
 * other.
 *
 * **`A` and `B` rather than a team name, because the sides are not teams.** A round is two arbitrary sides
 * whose *names* change per mode (`MODE_SIDE_NAMES`) and whose colours do not (`TEAM_COLORS`: A is red and B is
 * blue in every mode); `TEAM_A`/`TEAM_B` are the stable labels underneath both, and these names use them for
 * the same reason the server's own map is keyed by them.
 */
export const ROUND_SCORE_A_ATTRIBUTE = "ScoreA";

/** The other side's points. See {@link ROUND_SCORE_A_ATTRIBUTE}. */
export const ROUND_SCORE_B_ATTRIBUTE = "ScoreB";

/**
 * Attribute on **each `Player`**: **a count of the wipes that player has been covered for**, bumped the
 * instant before the server moves them.
 *
 * **Per player rather than one counter on the folder, and that is what makes "a wipe is something that
 * happens to you" the shape of the code.** The cue used to be a single number on {@link ROUND_STATUS_FOLDER}
 * that every client read and then filtered for itself — `roundZone.onASide` deciding whether it applied —
 * which put a *judgement* on the client and left "is this for me" answerable differently on two machines.
 * The server now names the players it covers: **the round's own roster at each boundary**, and **one player
 * when they opt into a round already under way**. A player who has not opted in is never written to, so
 * there is nothing for their client to decide and nothing for the two ends to disagree about.
 *
 * **A counter of its own rather than the phase, and the reason is still the whole point of it.** The phase is
 * published *early* on purpose: an intermission announces itself before the lobby is even looked up, because
 * a phase that is held must not read as the previous one (`RoundService` says so at length). The teleport
 * then happens later — after the lobby resolves, after the held balls are dealt with — so a wipe keyed on the
 * phase would play and finish inside that gap and cover nothing at all. This is written immediately before
 * the move instead, which is what lets the client's cover close *around* the cut rather than after it.
 *
 * A number rather than a boolean because the count is the useful part: **any change is a wipe**, so a client
 * needs no notion of which boundary it is at, and a client that mounts mid-transition reads its own current
 * value and waits for the next one — which is why a player who boots into a round already under way sees no
 * cover for a move they were never part of.
 */
export const ROUND_TRANSITION_ATTRIBUTE = "Transition";

/**
 * Attribute on {@link ROUND_STATUS_FOLDER}: which mode the round is being played as.
 *
 * The mode's **id** — a `GameModeId`, such as `"DodgeAndSeek"` — and not its display name, which
 * is what this used to carry. The id is the stable key: it is what a reader looks a mode *up* by,
 * and both the name shown on screen and the names of its two sides come from tables keyed by it
 * (`GAME_MODE_NAMES` and `MODE_SIDE_NAMES`, both in `shared/gameMode.ts`). Publishing the display
 * name instead would put the presentation on the wire and leave a client unable to look up
 * anything else about the mode it is being told about.
 *
 * Written when a vote **closes**, not when the round starts, and that is the useful moment: the
 * intermission following the vote is exactly when a player wants to know what they are about to
 * play, and a value written at the opening whistle would tell them a second too late. A reader
 * must therefore not assume it describes the round in progress — between the vote closing and the
 * round beginning it describes the round to come. It is also what a client uses to know which
 * mode's side names to ink a result with, so a stale value would mislabel a winner.
 */
export const ROUND_MODE_ATTRIBUTE = "Mode";

/**
 * Attribute on {@link ROUND_STATUS_FOLDER}: whether the vote is open right now.
 *
 * A boolean rather than a deadline on the shared clock, because the vote does not run on the
 * shared clock — it runs on the *intermission*'s, and that clock stops when a dev pauses rounds.
 * A reader given an instant it could subtract would draw a countdown that kept running while the
 * round it belongs to was held up.
 *
 * The HUD's whole reason for showing the buttons, and the only thing it needs: the options come
 * from {@link ROUND_VOTE_OPTIONS_ATTRIBUTE}.
 */
export const ROUND_VOTE_OPEN_ATTRIBUTE = "VoteOpen";

/**
 * Attribute on {@link ROUND_STATUS_FOLDER}: the modes the open vote is offering.
 *
 * The ids, comma-joined — see `encodeModeIds` in `shared/gameMode.ts` for why a string rather than
 * a list, and for the pair of helpers that keep the two sides of the encoding together.
 *
 * Published by the server from its own registry, which is what makes the client a renderer of
 * whatever the server can actually run: a mode that has been designed but not written is simply
 * absent from this string, so the button for it does not exist rather than existing and doing
 * nothing.
 */
export const ROUND_VOTE_OPTIONS_ATTRIBUTE = "VoteOptions";

/**
 * The stem of the attribute holding **how many votes one mode has** — the whole name is this plus
 * the mode's id; see {@link voteCountAttribute}.
 *
 * **One attribute per option rather than one holding them all**, which is the opposite of what
 * {@link ROUND_VOTE_OPTIONS_ATTRIBUTE} does with the same modes. The option list is one fact that
 * changes once a window, so it travels as one string; a count is one number per option and changes
 * on every vote, so each is its own key. What that buys is that the client can watch the option it
 * is drawing and nothing else — a vote for one mode repaints one label rather than all three — and
 * that a count stays a number instead of a digit inside a string somebody has to split.
 *
 * **Written for every option, zeros included.** "Nobody has voted for this yet" is then a number the
 * client reads rather than the absence of an attribute it has to learn to interpret — the same
 * reason {@link ROUND_VOTE_OPEN_ATTRIBUTE} is seeded shut rather than published late.
 */
export const ROUND_VOTE_COUNT_PREFIX = "VoteCount";

/**
 * The attribute name holding `id`'s vote count. See {@link ROUND_VOTE_COUNT_PREFIX}.
 *
 * **A function so that the name is built in one place.** The server writes these and the client
 * asks for them, and two concatenations of the same prefix are two places for a typo to sit and
 * still compile: a publisher writing `VoteCountDodgeAndSeek` against a reader asking for
 * `VoteCountsDodgeAndSeek` is a count that stays at zero for ever, silently.
 *
 * Takes a plain `string` rather than a `GameModeId`: this builds a *key*, and the id handed to it
 * has already been through `isGameModeId` or `decodeModeIds` by the time anyone does.
 */
export function voteCountAttribute(id: string): string {
	return `${ROUND_VOTE_COUNT_PREFIX}${id}`;
}

/**
 * There used to be a `SPECTATING_ATTRIBUTE` here — "`Spectating`", on the `Player` — and it is worth a
 * line of its own to say why there is not one now, because its absence is a decision rather than a gap.
 *
 * **Spectating was removed, not renamed or moved.** `RoundService` set it for a player whose character
 * died during a round and for one who joined while a round was already under way, and the client's only
 * use of it was to hide the ability readouts and show "You're out — spectating". Score Rush respawns, so
 * a dead player re-enters rather than sitting the round out, and the flag was the reason a player could
 * idle instead of play. The two remaining facts it stood for are both already published elsewhere and
 * neither needs an attribute: *who is in the round* is `RoundService`'s `activePlayers` (server-side,
 * never replicated) and *a round is being played* is `ROUND_STATE_ATTRIBUTE` on the status folder.
 *
 * **So a client can no longer tell "a round is on" from "I am in it", and that is the accepted cost.**
 * See `panels.ts`'s `sessionHudVisible`, which now gates on the phase or a practice zone and nothing
 * else, and says what that means for a player who is out of the round.
 */

/**
 * Attribute on a **`Player`** saying their body is standing inside a practice zone right now.
 *
 * Written by `PracticeZoneService`, which is the zone's owner on this side: it is the only thing that
 * runs the bounds test, and every rule that cares about the zone reads this rather than asking the
 * question again. **A fact rather than a query** is the whole point — the dodge gate can then afford
 * to check it, the dock can watch it, and a ball's contact handler can consult it without any of them
 * paying for a `GetPartBoundsInBox` walk on their own hot path.
 *
 * On the player rather than the character, for the reason every other player attribute is: a character
 * is replaced on respawn, and standing in a zone outlives the body that happened to be standing there.
 * The service re-detects and re-publishes on `CharacterAdded`, so a body that respawns inside the zone
 * keeps the fact rather than waiting for the next tick to relearn it.
 *
 * The client reads it too — `DockController` for the dock, and it is what `roundZone.ts` is expected to
 * become the source for. The client's own bounds test lives on because the camera needs an answer on
 * its own tick rather than at replication's, and the two can differ by at most the tracker's interval.
 */
export const PRACTICE_ZONE_ATTRIBUTE = "PracticeZone";

/**
 * Attribute on a **`Player`** holding the instant their next body arrives, on the engine's shared clock.
 *
 * **An instant rather than a countdown, and on the player rather than on a folder**, which is the shape the
 * action cooldowns already use: `RespawnService` writes `Workspace:GetServerTimeNow() + the delay`, and the
 * client subtracts the same clock per frame — so the readout is smooth, needs no remote, and cannot drift
 * from the timer it is describing. `0` is the empty case, which every reader treats as "no body is on its
 * way" rather than as a countdown of zero.
 *
 * **Written and cleared by one service**, so the three moments a wait can end — the timer firing, the round
 * ending, the player leaving — are three lines in `RespawnService` rather than a rule each caller keeps.
 */
export const RESPAWN_AT_ATTRIBUTE = "RespawnAt";

/**
 * Attribute on a **body** — a rig, or a character — holding the identity a hit on it travels as.
 *
 * **Written by the server the first time that body is hit, and read by `hitVfx` to find the body again.** The
 * reason is a report of "cloned rig ×7, no hit effect", and the cause was the payload: `hitImpact` carries the
 * victim's **`Name`**, and a name is not an identity. Seven copies of one model are seven models called `Rig`,
 * so the client's lookup answered with whichever copy the collection walk offered first — or with nothing at
 * all, before the walk existed — and the burst either landed on a body nobody had hit or on no body at all.
 * See `hitVfx.bodyOf`, which resolves this first and the name second.
 *
 * **The server keeps the authority, and this attribute is only the client's handle on it.** `registerHit` holds
 * a `WeakMap` from the body to its id, so the id is a fact about *that instance* even though the attribute can
 * be copied — a `Model` duplicated in Studio inherits every attribute its source had, which would otherwise
 * give two bodies one identity. A duplicate is corrected the first time it is hit, because it has no entry in
 * that map and is issued a fresh id. **The residual case is named rather than hidden**: between the copy being
 * made and either body being hit again, two live bodies can carry the same value, and the client picks the
 * first. That can only happen to bodies a person made by hand in Studio, and the two are the same body to
 * everybody watching.
 *
 * **A string rather than an `Instance` on the wire, and not because a reference would not work.** A remote can
 * carry an instance reference, and it would be exact — but it would also replace the two names `hitImpact`
 * deliberately sends, which the log is compared against and which `hitConfirm` compares to
 * `LocalPlayer.Name`. An id beside the name costs one field and changes neither reader.
 *
 * **Nothing on the server reads it back except `registerHit`.** It is not a record of a hit and nothing
 * accumulates from it; a body that is never hit never wears one.
 */
export const BODY_ID_ATTRIBUTE = "BodyId";

/**
 * Attribute on a **`Player`** naming the body that landed the latest hit on them — a display name for a
 * player, a rig's own `Name` for a rig — and absent when there is nothing to report.
 *
 * **A string on the player, because the reader is a HUD label drawn over a dead body.** The countdown beside
 * it already reads `RESPAWN_AT_ATTRIBUTE` off the same instance, so this is the second half of one sentence
 * ("waiting `n` seconds, hit by `x`") read from one channel: no remote, no event, nothing to miss while a
 * client is still loading, and the value is already there when the countdown first appears.
 *
 * **It cannot come from `roundHit`.** That event — the feed's, and `HitLogController`'s only source — is sent
 * only for a hit with a person at *both* ends, and in a round played against rigs most hits have a rig at one
 * of them. **`hitImpact` would work and was not used**, because its thrower field is a `Name` and this wants
 * the *display* name for a player; the server is where that difference can be decided.
 *
 * **Written by `RoundService.registerHit`, at the tag**, which is where a hit becomes the round's and where
 * both ends are already resolved — so naming the attacker costs no second lookup. The consequence is
 * deliberate and matches the hit feed: **a throw you catch still leaves its thrower's name here**, because the
 * name was written when the ball tagged you and a catch is a save rather than an erasure.
 *
 * **Cleared in two places, both in `RoundService`**: when a body arrives (that is the end of the wait this
 * attribute dresses) and at the `Playing` edge for the whole roster (a round that has just started has no hits
 * in it). Without the second, a first death of a round could name the previous round's thrower.
 *
 * **`nil` rather than `""` for "nobody".** An attribute's absence is the client's one test, and a second
 * spelling of the same absence is a second thing to keep in step.
 */
export const LAST_HIT_BY_ATTRIBUTE = "LastHitBy";

/**
 * Attribute on a **`Player`** holding *who* landed the latest hit on them, as a {@link THROWER_TOKEN} — the
 * machine-readable half of {@link LAST_HIT_BY_ATTRIBUTE}.
 *
 * **Two attributes rather than one, because a name is not an identity and this one has to be resolvable.** The
 * name beside this is a *display* string: a player is written by `DisplayName` and a rig by its alias, which are
 * the right things to draw and the wrong things to look a body up by. Two accounts can share a display name, a
 * display name is not a `Player.Name`, and a rig's alias is drawn from the same pool of invented names the rigs
 * themselves wear — so "find the body called PixelPhantom23" is a lookup with more than one possible answer, and
 * the answer it picks is the wrong one exactly when two bodies collide.
 *
 * **A token has no such ambiguity**, and both kinds of body already carry one: `JoinService` stamps a
 * character with its player's `UserId` as text, and `NpcService` stamps a rig model with a generated GUID. So
 * the client's rule is the server's own rule, written once in `RoundService.playerFromToken` and mirrored in
 * `client/killCam.ts`: **`tonumber` succeeding means a person**, and anything else is matched against the tag's
 * models. That is what makes the kill cam able to track a rig at all — a rig has no `Player` to ask.
 *
 * **Written and cleared exactly where its neighbour is**, in `RoundService`: written in `registerHit` at the
 * tag, cleared when a body arrives and at the `Playing` edge for the whole roster. Two attributes with one
 * lifetime, kept in one place rather than two, so a stale killer cannot outlive a stale name.
 *
 * **Its only reader is the kill cam.** Nothing draws this: it exists to be resolved to a `Model` and followed.
 */
export const LAST_HIT_BY_TOKEN_ATTRIBUTE = "LastHitByToken";

/**
 * Attribute on a **`Player`** holding **where** the latest hit on them came from, as a world position — the third
 * of the three, and the one that outlives its subject.
 *
 * **The kill cam's fallback, and the reason it needs one.** It watches the *body* a token resolves to, and that
 * body can be gone before the camera's first frame: a rig is destroyed and re-cloned by `RespawnBehavior`, and a
 * player who kills you and then dies immediately has their character replaced. `client/killCam.ts` already keeps
 * the last place it *saw* a killer standing, so a body destroyed **mid**-shot is not a problem — but a body
 * destroyed **before** the shot begins has never been seen, and the camera used to give up there and leave
 * Roblox's own death camera in charge. This is the place the hit came from, recorded at the hit, which is the one
 * moment it is certainly knowable.
 *
 * **A position rather than a body, because the reader may have no body to ask.** The thrower's
 * `HumanoidRootPart.Position` at the tag — where they were standing when they threw — which is what "shot from
 * over there" means to a player watching. The framing is the camera's: `KILL_CAM_CONFIG.OFFSET` is applied to this
 * point exactly as it is applied to a followed killer's root, so a held shot and a tracking one look like the same
 * shot rather than two different ones.
 *
 * **Written and cleared exactly where its two neighbours are**, in `RoundService`: written in `registerHit` at the
 * tag, cleared when a body arrives and at the `Playing` edge for the whole roster. `nil` where the thrower could
 * not be resolved — the same absence `LAST_HIT_BY_TOKEN_ATTRIBUTE` writes, and for the same reason.
 *
 * **Read by the kill cam alone.** Nothing draws this: it exists to be a camera position.
 */
export const LAST_HIT_BY_POSITION_ATTRIBUTE = "LastHitByPosition";

/**
 * Attribute on a **`Player`** holding **how** the latest hit on them happened: `"Hit"` for a ball that landed, or
 * `"Catch"` for a throw of theirs that somebody caught. The fourth of the family, and the one that changes what the
 * death cam says.
 *
 * **The three attributes beside this one describe a death the cam can *show*; this one describes a death it has to
 * *explain*.** A caught throw kills its thrower — the catcher's side gets the point and the thrower is out — and
 * "Hits: 4 | Outs: 1" about the catcher is a true sentence that answers a question nobody asked. `"Catch"` is what
 * lets the caption say `caught your shot!` instead.
 *
 * **It is written on two different people, and that is the one thing to get right.** The hit path
 * (`RoundService.registerHit`) writes the family on the **victim**, at the tag. The catch path
 * (`RoundService.resolveCaughtThrower`) writes it on the **thrower**, because the thrower is the one who dies — the
 * catcher is unharmed and is the *killer* for this attribute's purposes, which is why the name, token and position
 * written at that moment all describe the catcher. Both readers are the same reader: `client/enemyView.ts` asks the
 * **local player's** own copy, and the local player is whoever is dying.
 *
 * **Two values as literals between two files**, which is `roundZone`'s `PLAYING`/`SIDE_A` convention: the server
 * writes `"Hit"` or `"Catch"`, the client compares against `"Catch"`, and a typo in one of them is a death that
 * reads as one it is not. Declared here so a third value has an obvious place to be written down.
 *
 * **Cleared exactly where its three neighbours are** — when a body arrives, and at the `Playing` edge for the whole
 * roster — so a stale cause cannot outlive a stale name. That matters more here than for the others: a `"Catch"`
 * left on a player would caption their *next* death, from something else entirely, as a catch.
 *
 * **Its only reader is `client/enemyView.ts`.** Nothing draws the value itself.
 */
export const LAST_HIT_BY_CAUSE_ATTRIBUTE = "LastHitByCause";

/**
 * Attribute on a **ball** holding the `os.clock` time before which nobody may pick it up.
 *
 * Written by `BallService.dropBall`, read by `BallPickupService`. On the ball rather than
 * on the player who dropped it, because it is the *ball* that needs the beat — it is in
 * the air and has not settled — so somebody else walking over it inside the window is
 * blocked by it too. A per-player table would have said the opposite of what the window
 * is for.
 */
export const PICKUP_LOCKED_UNTIL = "PickupLockedUntil";

/**
 * Attribute on a **character** counting the balls it has collected off the floor.
 *
 * Written by `BallService.pickupBall` — the one entry point in the game that is *only* a pickup — and read by
 * one thing: `client/personalAudio`, which plays the pickup sound when the number goes up.
 *
 * **The whole reason it exists is that a client cannot otherwise tell a pickup from a catch.** A ball
 * arrives in a hand four ways — collected off the arena, caught out of the air, handed over at the start
 * of a round, and refilled by a MultiBall window — and all four end in the same place: `attachToHand`
 * parents the ball to the character, so `Character.ChildAdded` fires for every one of them and says
 * nothing about which happened. The sound wanted is the pickup's alone, so the *server*, which does know,
 * publishes the one word the client cannot work out. See `pickupBall` for the write.
 *
 * **A count rather than a boolean, because a boolean has to be cleared and the clear is a second event.**
 * A flag would need a matching "I have heard it" write or every pickup after the first would read the
 * same `true`; a number that only ever goes up makes each pickup a distinct value, so the client's
 * watcher needs no handshake in either direction. It is also *self-describing in a log*: the tenth
 * pickup of a life reads as ten.
 *
 * **On the body and not on the `Player`**, which is the opposite of {@link SUPER_MULTI_BALL_COUNT_ATTRIBUTE}
 * and worth the contrast. That one is a currency a player owns, so it outlives every body it was bought
 * in. This one is a fact about a pair of hands: it resets at a respawn because the hands do, and it is
 * written for a rig as readily as for a player because `pickupBall` is handed nothing but a body and
 * needs no `IsA("Player")` branch to say so. The client watches its own character and therefore never
 * sees a rig's copy.
 */
export const PICKUP_COUNT_ATTRIBUTE = "PickupCount";

/**
 * Attribute on a **ball** naming the super ability it is carrying, or `""` for an ordinary ball.
 *
 * Written in two places and read in three, which is the whole of its life:
 *
 * - **Written** by `BallService.markHeldBall`, when the player holding the ball presses the ability
 *   key — and by `BallService.attachToHand`, which *clears* it. That clear is the load-bearing half:
 *   a ball arriving in a hand is an ordinary ball again, whether it arrived by catch, by pickup or by
 *   a hand-out, so a mark cannot survive into a throw nobody asked for.
 * - **Read** by `abilityOn`, which is the only reader that decides anything; by `BallService`'s drop
 *   and throw paths, which are the two ways a marked ball can leave a hand and therefore the two that
 *   decide what the mark cost — the throw spends, the drop forfeits — and they are also why a box's
 *   prize is spent on the *throw* and not on the press: `SuperService.spendMysteryPrize` is called from
 *   the throw path, for a dev's throw as much as anybody's; and by the HUD, which says which ability is
 *   loaded.
 *
 * **On the ball rather than on the player, because the ability belongs to the *throw* and not to the
 * thrower.** A player can hold a charge and an ordinary ball at the same time, and the ball is the
 * thing that flies. It is also what makes the forfeit rule survivable: a marked ball that is dropped
 * is destroyed, so a mark cannot be carried over to the next ball by accident.
 *
 * `""` rather than removing the attribute, which is the convention `ThrowerId` already uses — an
 * empty string is one case for a reader to handle, where an absent attribute is two.
 */
export const BALL_ABILITY_ATTRIBUTE = "BallAbility";

/**
 * Attribute on a **`Player`** saying an ability is armed and waiting for a ball to carry it, or `""`.
 *
 * **The dev shortcut's state, and the reason it is on the player rather than the character.** A dev in
 * Studio has no ball to mark and often no round to mark one in, so the ability is armed *before* there
 * is anything to put it on — and an arm on the character would be thrown away by the first death,
 * which is precisely the moment somebody testing something is most likely to hit. On the player it
 * survives a respawn, and it survives a round ending: it is cleared by the ball that takes it up and
 * by nothing else. See `BallService.attachToHand` for where it moves onto a ball, and `markHeldBall`
 * for where it is set.
 *
 * **One string, so one arm at a time, and that is deliberate rather than incidental.** Arming Pierce
 * and then arming something else *replaces* it rather than queueing behind it: an arm means "this is
 * what the next ball will be", and the next ball can only be one thing. A list would be a claim that
 * a ball can carry several abilities at once, which nothing here implements.
 *
 * `""` for no arm, the convention {@link BALL_ABILITY_ATTRIBUTE} uses, so every reader has one empty
 * case instead of two.
 */
export const ARMED_ABILITY_ATTRIBUTE = "ArmedAbility";

/**
 * Attribute on a **`Player`** holding how many times they have hit somebody with a throw.
 *
 * Written by `StatsService` when a record is loaded and again after every hit, and read by the kill cam's
 * record card (`client/enemyView.ts`) — which is why it is on the **player** and not the character: the record
 * outlives every body it was earned in.
 *
 * **A round's count, not a session's.** Only a hit thrown while a round is being played reaches the
 * record — see `StatsService.isRoundActive` — so this figure and {@link STAT_OUTS} are counted under
 * one rule and can be read against each other.
 *
 * An attribute rather than a remote, for the reason the round's state is one: it replicates on its
 * own, so the HUD needs no remote, no reply to wait for, and no reference to the service that owns
 * the numbers.
 */
export const STAT_HITS = "StatHits";

/** How many times a player has been eliminated. See {@link STAT_HITS}. */
export const STAT_OUTS = "StatOuts";

/**
 * Hits over hits and outs together, from `0` to `1`, published beside the two counts by
 * `StatsService`.
 *
 * **Derived here and sent, rather than worked out by each reader.** Two readers dividing the same
 * two numbers is two chances to disagree about a player's own record, and a player with neither
 * figure has to read as `0` rather than as a division by zero — one rule, stated once.
 */
export const STAT_RATIO = "StatRatio";

/**
 * Attribute on a **`Player`** holding how many hits in a row they are currently on.
 *
 * Written by `SuperService` on every change to the streak and read by the super HUD, which is why it
 * is on the **player**: a run of hits outlives the body it was earned in, and dying is one of the
 * things that *ends* a streak rather than something that should take the readout with it.
 *
 * **Sent even though a client could count hits itself, because it could not count *these* hits.**
 * Only a throw made during a round counts, a throw that lands on nobody breaks the run, and whether a
 * throw landed on anybody at all is something only the ball's own contact knows — so a client-side
 * count would be a second implementation of a rule, free to disagree with the one that grants the
 * charge.
 */
export const SUPER_STREAK_ATTRIBUTE = "SuperStreak";

/**
 * Attribute on a **`Player`** saying they are holding a charge — one earned ability, not yet used.
 *
 * A boolean rather than a count, because only one is ever held: reaching the target while already
 * holding one grants nothing further, and the rule that says so lives where the target is reached.
 *
 * Beside {@link SUPER_STREAK_ATTRIBUTE} and for its reasons, including the one about the pair: they
 * are two halves of one readout, and a reader that saw a new streak beside a stale charge would be
 * showing a state that never existed.
 */
export const SUPER_CHARGE_ATTRIBUTE = "SuperCharge";

/**
 * Attribute on a **`Player`** saying they are wearing the crown — three hits, or the most on their side.
 *
 * **On the player rather than on the body**, for {@link SUPER_STREAK_ATTRIBUTE}'s reason and for one
 * more: the crown is derived from a count that outlives a body, so putting it on the character would
 * mean recomputing a server-side answer in every client the moment somebody respawned. Here a respawn
 * costs nothing at all — the player keeps the attribute. **Nothing on the client reads it since 2026-10-27**: the
 * billboard that drew the crown was deleted (`HANDOFF.md` §15 item 111), so today this is a server-side fact with no
 * picture.
 *
 * **A boolean rather than the count**, because the count is already published beside it: a client that
 * wanted to answer the question for itself would need every other player's count *and* side, and two
 * clients could then disagree about who is hot. The server decides, and this is the decision.
 */
export const CROWN_ATTRIBUTE = "Crown";

/**
 * Attribute on a **`Player`**, or on a rig's **`Model`**, holding the badges that body earned in the round
 * that has just finished — one comma-joined string of ids, and `""` for none.
 *
 * **The one fact the badge system publishes, and it is published to both kinds of body.** A player's badges
 * go on the `Player` and a rig's on the `Model`, for `CROWN_ATTRIBUTE`'s reason: the answer outlives a body,
 * and a respawn then costs a display nothing but a re-read. A rig *is* a body and is replaced whole,
 * so its attribute dies with it — which is correct, because a rig's round ends with the rig.
 *
 * **Read by `StatsBillboardController` and by nothing else**, which is the whole display: one row per id, a name
 * and a description, above the head of the body wearing it — for the first fifteen seconds of the intermission
 * and no longer.
 *
 * **An attribute rather than a remote**, for the reason `STAT_HITS` gives: it replicates on its own, so the
 * display needs nothing to ask and nothing to wait for. **A string rather than children or JSON**, and
 * `""` rather than an absent attribute — both argued at `shared/badges.ts`, which owns the encoding and the
 * vocabulary.
 *
 * **It has a lifetime and only one.** Written by `BadgeService.onRoundEnded` at the moment the round is
 * decided, cleared fifteen seconds later or at the next round's `Playing` edge, whichever comes first, and
 * never written during play. See that service for the window and for the rule that a set made only of rib
 * badges is published as the empty string.
 */
export const BADGES_ATTRIBUTE = "Badges";

/**
 * Attribute on a **`Player`** holding how many coins they own.
 *
 * Written by `EconomyService` when a record loads and after every change, and read by the client's
 * coin readout — which is why it is on the **player** and not the character: the wallet outlives every
 * body it was filled in. An attribute rather than a remote, for the reason `STAT_HITS` gives: it
 * replicates on its own, so the HUD needs nothing to ask and nothing to wait for.
 *
 * **A number, never negative.** Every write is clamped to at least nought, so a reader that renders
 * the raw value cannot draw a debt that does not exist.
 */
export const COINS_ATTRIBUTE = "Coins";

/**
 * Attribute on a **`Player`** holding how many coins the round that has just ended paid *them*, as a number.
 *
 * **The delta, not the balance** — `COINS_ATTRIBUTE` is the ledger and this is one round's line in it.
 * `EconomyService.onRoundEnded` writes both from the same local `coins` value, so the two cannot disagree
 * about what was earned; nothing else writes this, and nothing reads `COINS_ATTRIBUTE` to derive it (a
 * difference of two balances would also swallow every purchase made between rounds).
 *
 * **An attribute rather than a return value or a remote**, for `COINS_ATTRIBUTE`'s reason: it replicates on
 * its own, so the client's reward toast needs nothing to ask and nothing to wait for. A return from
 * `onRoundEnded` was the obvious alternative and it does not survive the caller — `RoundService.finishRound`
 * has no clipboard and no business holding one per player for ten seconds while a toast draws.
 *
 * **The change signal *is* the "you were paid" edge**, which is why the value is cleared at the end of
 * `ARENA_CONFIG.CELEBRATION_SECONDS` rather than left standing. Two rounds paying the same amount is an
 * ordinary Tuesday, and an attribute written to the value it already holds fires no signal — so without the
 * clear the second toast would simply not exist, and the bug would look like the *round* failing to pay.
 */
export const ROUND_EARNED_COINS_ATTRIBUTE = "RoundEarnedCoins";

/**
 * Attribute on a **`Player`** holding everything they own that affects gameplay, as one `|`-joined string.
 *
 * **`OwnedPowers` until the record folded powers into items**, and that is a rename of the *fact* rather
 * than a tidy-up: this attribute has always meant "what the server says you own", and the record field it
 * is published from is now `items` — one set holding the three powers today and whatever else
 * gameplay-affecting arrives, with no new attribute and no second packed string for it.
 *
 * **Both sides ship together, so changing the wire name costs nothing worth protecting.** An older client
 * is not a case to carry: it would ask for `OwnedPowers`, find no such attribute, and read its own
 * collection as empty — which is the same answer it already gives for "not published yet".
 *
 * **A packed string rather than one attribute per item**, so adding an item costs nothing here and an
 * unowned one is simply a word that is absent. The delimiter is private to `shared/economy.ts`, which is
 * the only reader and writer; the empty case is `""` — "owns none of them" — rather than an absent
 * attribute.
 *
 * **Ownership, not loadout.** What a player *owns* is permanent and decided by the server; which one is
 * on the ball in their hand is `BALL_ABILITY_ATTRIBUTE`, a different fact on a different instance. A
 * reader that means *powers* specifically asks for one by name — `shared/economy.ts`'s `ownsPower` is that
 * question, and with this set wider than powers it is the only honest way to ask it.
 */
export const OWNED_ITEMS_ATTRIBUTE = "OwnedItems";

/**
 * Attribute on a **`Player`** holding the subset of their powers the item box may grant, as one
 * `|`-joined string.
 *
 * **The same shape as {@link OWNED_ITEMS_ATTRIBUTE}, and deliberately not the same attribute.** What a
 * player *owns* is permanent and decided by the server; what the *box may give them* is a choice they
 * make and can change — the distinction `OWNED_ITEMS_ATTRIBUTE` already draws between ownership and the
 * ball in somebody's hand, applied to a second question. It is separate because the two facts have
 * different lifetimes and different authors: ownership only ever grows and only the server writes it,
 * while a pool shrinks and grows again and the player is the one deciding.
 *
 * **The empty string is a real value and means "the box has nothing to give".** Unlike the equipped
 * attributes, where `""` means "no cosmetic", there is no default to fall back to here: the pool *is*
 * the player's decision, and turning every power off is one of the states it can be in. The server always
 * writes it from the record, so `""` on a player who has loaded is never "not published yet" — see
 * `EconomyService.publish`.
 *
 * Joined with the same helper the owned set uses, `joinItems` in `shared/economy.ts`, because this is
 * the same *kind* of value: a set of `AbilityKind` packed into one attribute. A second packing convention
 * for the same data would be a second thing to keep in step for no gain.
 */
export const POWER_POOL_ATTRIBUTE = "PowerPool";

/**
 * Attribute on a **`Player`** holding the cosmetic ids they own, as one `|`-joined string.
 *
 * The same shape as {@link OWNED_ITEMS_ATTRIBUTE} and for its reason: one packed string means a new
 * cosmetic costs no new attribute, and the empty case is `""`. Earnable and premium items share the
 * one id space, so this says *which ids* without saying how each was obtained.
 */
export const OWNED_COSMETICS_ATTRIBUTE = "OwnedCosmetics";

/**
 * Attribute on a **`Player`** holding the trail cosmetic they have equipped, or `""` for the default.
 *
 * **One attribute per slot rather than one packed string, which is the opposite of the call
 * {@link OWNED_COSMETICS_ATTRIBUTE} makes — and the difference is what the value *is*.** Ownership is a
 * *set*: several ids at once, so packing them into one string is the only way to keep them in one
 * attribute. Equipped is a *choice*, one id per slot, so a packed string would have to carry the slot as
 * well as the id — a second delimiter and a second convention inside `shared/economy.ts`, which is the
 * file whose whole job is to be the one place a shape is agreed. An attribute whose *name* is the slot
 * and whose *value* is the id needs neither.
 *
 * **`""` is a real value here rather than an absent attribute.** It means "no cosmetic — the default",
 * and it is written rather than removed so that `EquippedTrail = ""` and no such attribute at all are
 * not two spellings of one fact. That is the empty-string convention `BALL_ABILITY_ATTRIBUTE` and a
 * ball's `ThrowerId` already use.
 *
 * **Published by `EconomyService`, read by the Inventory panel, written by nobody else.** The server is
 * the only writer for the reason `OWNED_ITEMS_ATTRIBUTE` gives: what a player wears is decided by the
 * record the client cannot reach.
 */
export const EQUIPPED_TRAIL_ATTRIBUTE = "EquippedTrail";

/**
 * Attribute on a **`Player`** holding the elimination cosmetic they have equipped, or `""`.
 *
 * The elimination slot's own attribute, on {@link EQUIPPED_TRAIL_ATTRIBUTE}'s terms: stored and
 * published today, drawn nowhere yet, because no elimination cosmetic has a render path. See
 * `EconomyService.equipCosmetic` for why the state is still written.
 */
export const EQUIPPED_ELIMINATION_ATTRIBUTE = "EquippedElimination";

/**
 * Attribute on a **`Player`** holding the balls left in their MultiBall window, or `0` for no window.
 *
 * **`0` means "no window", which is one empty case rather than an absent attribute beside a present
 * one** — the convention `BALL_ABILITY_ATTRIBUTE` and `ARMED_ABILITY_ATTRIBUTE` already use.
 *
 * **On the player, because a MultiBall window is the player's rather than any ball's.** Nothing a ball
 * carries can say whether its thrower still has a window open, so this is the only thing a player can
 * read about the ability — and now it is the *whole* of what there is to read.
 *
 * **It used to be published beside a deadline**, `SUPER_MULTI_BALL_ENDS_AT_ATTRIBUTE`, which carried the
 * `Workspace:GetServerTimeNow()` instant the window closed so a HUD could count down to it. The window
 * has no clock any more — it lasts until the count is spent, whatever that takes — so that attribute is
 * gone and this one is no longer half of a pair. **The consequence for a reader is that a non-zero count
 * is now the only signal that a window is running**, which is why the power slot draws the MultiBall
 * icon from this number rather than from anything about a prize: see `SuperHudController`.
 */
export const SUPER_MULTI_BALL_COUNT_ATTRIBUTE = "SuperMultiBallCount";

/**
 * Attribute on a **`Player`** saying *a power is armed and unspent* — the fact `SuperHudController` draws
 * its `READY` text from.
 *
 * `true` rather than a kind, and it is the HUD's question rather than the game's: the word "ready" is not
 * a power's name, and the two things that make it true (a marked ball in hand, a MultiBall window with
 * throws left) already publish what they are — `BALL_ABILITY_ATTRIBUTE` on the ball, and
 * `SUPER_MULTI_BALL_COUNT_ATTRIBUTE` on the player. A reader that wants the *kind* has those; this is one
 * boolean for a label that says one word. See `SuperService.armPower` for the two sources, the "done"
 * trigger each of them has, and the four ways this is cleared.
 *
 * **Written only by `SuperService.publish`**, which is the same one-writer rule the rest of the HUD's
 * readout follows: every attribute goes out together, so a client can never see a READY text beside a
 * prize that has already been spent.
 */
export const POWER_READY_ATTRIBUTE = "PowerReady";

/** Diameter of the ball, in studs. */
export const BALL_SIZE = 2.5;

/**
 * Attribute on a **character `Model`** saying that the server has a dodge window open on it.
 *
 * **The one thing a client cannot work out for itself, which is why it is published at all.** A window is
 * opened and closed by `DodgeService` — a dash's `DURATION`, and the early exits from it — and none of that
 * reaches a client as state. A client that wanted to know would have to re-derive those rules from its own
 * input and from the cooldown stamps, which is the second copy of a server rule this project does not keep.
 * So the server says so instead, from `afterimage.ts` — the one function that already knows a window has
 * opened. See `startAfterimage` and `publishWindow`.
 *
 * **A catch window is *not* published, because a catch draws no trail.** `CatchService` used to open one and
 * to be published by the same path; both halves were removed on request, so a catching body is untrailed on
 * every machine and its client draws nothing. The attribute itself is unchanged — it answers about whoever
 * opens a window, and that is the dodge alone.
 *
 * **On the character rather than on the player, and that is what makes it self-clearing.** A window is a fact
 * about a *body*: an attribute on the body dies with the body it describes, so there is no state to clear on
 * a respawn and none a new body could inherit from an old one. A fact that has to outlive a death belongs on
 * the player instead — `TEAM_ATTRIBUTE` is that choice, made for that reason.
 *
 * **Absent means "no window", and only a body a player owns is ever given one** — a rig has no client
 * watching it, and a catching rig opens a window every tick. Written `false` when a window closes rather than
 * removed, so a reader compares against a value instead of interpreting a nil.
 */
export const AFTERIMAGE_WINDOW_ATTRIBUTE = "AfterimageWindow";

/**
 * Attribute on a **ghost `Model`** naming the player whose body it was copied from, by `UserId`.
 *
 * **How a client finds the server's copies of its own trail so it can hide them.** The trail of a player's
 * own body exists twice — built on their client for their screen, built on the server for everybody else's —
 * and both arrive on the dodger's own screen, so one of them has to be hidden there. This is the only thing a
 * ghost carries that says whose it is, and it is a `UserId` rather than a name because a rig and a player can
 * share a name. See `AfterimageController`.
 *
 * **Absent means "no player's body"**, which covers every rig's ghost and every player's ghost during the
 * frames before this has replicated — both of which read as "not mine", so no client ever hides a rig's
 * trail and a late attribute hides rather than doubles.
 */
export const AFTERIMAGE_SOURCE_ATTRIBUTE = "AfterimageSource";

/**
 * The five attributes a **rig `Model`** carries while it is doing something, which are what a client
 * animates it from. Together they are the rig's animation state, published by the server.
 *
 * **A rig is animated by the clients looking at it, and these are what they are told.** The server does
 * not play a rig's clips: a rig's `Animator` is the server's, so a track started there replicates every
 * CFrame change of every rig to every client — traffic and stutter for rigs nobody is looking at. The
 * middle way is this one: the server owns the *state*, because it is the only machine that can know it,
 * and each client dresses the rig it can see. See `NpcService.publishAnimation` for the writer and
 * `RigAnimationController` for the reader.
 *
 * **These are the facts a clip is decided from, and `DODGE_DIRECTION_ATTRIBUTE` below is the exception that
 * proves the rule rather than a sixth member of the set.** `animationFor`'s vocabulary is smaller still — the
 * facts *it* branches on are the two requests, the ground and the freeze — because a *shared* mapping between
 * a player and a rig can only branch on facts both of them have: a state that existed on one side and not the
 * other would be a mapping that could not be shared, which is the whole point of it. A dash direction is a fact
 * neither side's locomotion decision has any use for: it does not change which locomotion clip a body wears, it
 * changes which *action* clip draws over it, and it is published by the service that runs the dash rather than
 * by `NpcService`. So it lives beside these rather than among them, and an animation state added here still has
 * to justify itself against `animationFor`.
 *
 * **Every fact here is a *request* or a *window*, and never a measurement, which is the property that replaced a
 * published speed.** A measurement has no natural edge to be written on: it would have to be banded to satisfy
 * the guard in {@link NpcService.writeAttribute}, and a band floored to zero cannot tell "creeping" from
 * "standing". The two movement facts come from what the server *asked the rig to do* — see
 * `NPC_ANIM_MOVING_ATTRIBUTE` — and the rest are edges by construction.
 *
 * **Five attributes rather than one packed value.** Each is a scalar, so Roblox replicates only the one
 * that changed, which is exactly what "bytes per rig per change" means; and none of them needs a packing
 * convention that a reader on the other side could get wrong. The alternative considered and rejected was
 * one integer of bit fields, or one delimited string: it saves nothing on the wire — a change is one
 * scalar either way — and it puts an unpacking step, and that step's bugs, on every client. The project's
 * own convention is the same one, an attribute per fact, as {@link ROUND_SCORE_A_ATTRIBUTE} beside its
 * sibling, and the client renderer asks for five names it can see.
 *
 * **On the rig rather than on a folder or the wire**, for the reason the round's attributes are on a
 * folder: attributes replicate on their own, so the renderer needs no remote, no reply and no reference
 * to `NpcService` — and this is a fact about a *model in the world*, which is what an instance attribute
 * is for. A rig that is out of the world is not published at all (the gate `NpcService.run` keeps), so a
 * parked template in `ServerStorage` wears no state and no client animates it.
 */

/**
 * **Whether the server has asked the rig to move** — the request, published as a fact, and the attribute this
 * set was rebuilt around.
 *
 * **There was a banded *speed* here (`"AnimSpeed"`), and this is what replaced it.** The speed was the rig's
 * measured velocity, floored into five-stud bands so that `writeAttribute`'s change guard could hold — and the
 * floor meant every speed under five studs a second was published as *nought*, which is the same value a rig
 * standing perfectly still publishes. A rig creeping to a ball, sliding out of a hit, or nudging itself into
 * position therefore slid along in the standing clip, and no client could tell. The other end of the same
 * arithmetic was worse: with the line drawn anywhere on that range, a rig's clip changed when its *velocity*
 * wobbled rather than when it was told to do something, and every change costs a crossfade — so a rig could walk
 * with neither clip fully worn. See `animationFor` in `shared/animation.ts` for the whole of the record.
 *
 * **The fact is now genuinely a request, which took four attempts to arrive at.** A *request* is what a player's
 * body has — `MoveDirection`, written by the client's own input — and the rig's half was written as one twice
 * before landing on a measurement: `Humanoid.MoveDirection` and `Humanoid:GetMoveVelocity()` are both documented as
 * the *input*-driven pair, and both read zero for every rig in this game, because every walk here is a
 * `Humanoid:MoveTo()` and a behaviour has no input to report. Two play sessions of every rig wearing its idle clip
 * while walking is what that cost.
 *
 * **The measurement that replaced them was `Humanoid.Running`'s speed, and it was wrong for a reason worth keeping.**
 * It answers what the body *did*, and the question is what the body was *told*. Three reports followed — a shoved
 * rig animating a walk it was never asked for, a rig parked mid-walk coming back still walking, and a rig whose
 * walker was stripped at a round boundary with nobody left to correct it — and each was patched by watching the body
 * harder rather than by asking it anything. **The value published here is now the rig's own intent**: it is true when
 * a behaviour has asked the body to walk and false when one has told it to stand, and nothing consults a speed. See
 * `NpcLoop.walking` in `NpcService` for the three reports and for why a store of what a body was told cannot be
 * surprised the way a watch on the body always can be.
 *
 * **The name is finally the right name.** "Asked to move" is what a player is and what a rig now is, so the two
 * bodies answer one question for one decision (`animationFor`), which is the property this set of attributes exists
 * to give. It was kept through the measurement years because renaming it would have touched both sides of the wire
 * to fix a word; there is no such debt left.
 */
export const NPC_ANIM_MOVING_ATTRIBUTE = "AnimMoving";

/**
 * **Whether the request above is a sprint** — the other half of `NPC_ANIM_MOVING_ATTRIBUTE`, and the only thing
 * that can separate the two moving clips once the request decides *whether* a body is moving.
 *
 * **Asked of `WalkSpeedService` rather than worked out here, and that is the correction.** The obvious reading
 * would be "is the walk speed above its base", which needs to know the base — and the base is a per-rig number
 * (16 for a rig, 20 for a player), so that comparison is a threshold that a reader has to keep in step with a
 * config. The sprint is a *named contribution* on the walk speed, the service that owns the sum is the one that
 * knows which contributions are on, and the rig's sprint is the same key a player's is. See
 * `WalkSpeedService.isSprinting`.
 */
export const NPC_ANIM_SPRINTING_ATTRIBUTE = "AnimSprinting";

/** Whether the rig is standing on something. Part of the state above; see it for the whole. */
export const NPC_ANIM_GROUNDED_ATTRIBUTE = "AnimGrounded";

/** Whether the rig is frozen — held, and unable to choose where it goes. See the state above. */
export const NPC_ANIM_FROZEN_ATTRIBUTE = "AnimFrozen";

/** Whether the rig has a ball in hand, which is what a rig with one is about to throw. See the state above. */
export const NPC_ANIM_THROWING_ATTRIBUTE = "AnimThrowing";

/**
 * Whether the body is **mid-throw** — the ball has just left its hand — for as long as the throw's own
 * clip is worth playing.
 *
 * **A different fact from `NPC_ANIM_THROWING_ATTRIBUTE` immediately above, and the two names being one
 * letter apart is the point rather than sloppiness.** `AnimThrowing` is a *condition*: this body is
 * holding a ball and its next act is to throw it, true for as long as the ball is in the hand. This is an
 * *event*: the ball has gone, and the body is playing the motion that sent it. A throwing rig does both
 * in sequence — the hold pose while it carries the ball, then the throw — and a body can be one without
 * ever being the other.
 *
 * **Written by `BallService` at the release and cleared a moment later**, which is why it is named beside
 * the animation state rather than among it: the four attributes above are `NpcService`'s, published while
 * a rig's loop runs, and this one belongs to the throw — the single funnel a player's click and a rig's
 * behaviour both arrive through, so it is marked for every body that throws rather than for rigs alone.
 * See {@link BALL_CONFIG.THROW_ANIMATION_SECONDS} for how long it stays up, and `RigAnimationController`,
 * which plays the clip for exactly that window.
 *
 * **Absent means "not throwing"**, so a body that has never thrown and one whose throw has just finished
 * read alike — the same convention the four above use.
 */
export const THROW_ANIMATION_ATTRIBUTE = "AnimThrow";

/**
 * Whether the body is **mid-catch, and which half of one** — `"attempt"` while it is reaching, `"catch"` once
 * the ball is in its hand — for as long as the catch's own clip is worth playing.
 *
 * ## The value is the cause, not a flag
 *
 * **The type is a string rather than `true` because the two halves of a catch have to be told apart on the
 * client, and a boolean has only one value to say them with.** An attempt and a successful catch play the same
 * clip — they *are* the same animation, a body reaching — so nothing downstream of this attribute could
 * distinguish them: the clip does not change when the ball arrives, which means the clip's own edge fires once,
 * on the attempt, and the success is invisible.
 *
 * **And the value has to *differ* for the second write to be seen at all.** An attribute rewritten with the
 * value it already holds fires no `AttributeChanged` — see `catchShockwave.ts`, whose doc has said so since
 * before this change — so two writes of `true` are one event. Writing `"catch"` over `"attempt"` is a different
 * value, so it **does** fire, and that is the whole reason this is a string: **the type is what makes the second
 * event observable.** A flag could not, whatever fired it.
 *
 * ## The two causes, and the two callers
 *
 * Both halves go through one writer, `BallService.markCatchAnimation(model, cause)`, and the value is its
 * argument:
 *
 * - **`"attempt"`** — written by `CatchService` when a catch *window* opens, at both of its sites: the ordinary
 *   new-window branch and the endless window a dev holds open. A press that catches nothing is still a body
 *   reaching, and the clip is the only feedback a press has.
 * - **`"catch"`** — written by `BallService.completePull`, which is where a caught ball reaches the hand, once it
 *   has actually arrived. The *decision* to catch it is taken earlier (`BallService.catchBall`, on the frame the
 *   contact is resolved) so that the throw is resolved without waiting for the ball; the mark waits, because it is
 *   a picture of the ball arriving.
 *
 * A catch landing inside an earlier mark's window restarts this clock rather than stacking a second mark — see
 * `BallService.markCatchAnimation`, which owns both ends — so **`"catch"` written over an `"attempt"` is the ordinary
 * sequence rather than an edge case**: a body reaches on the press and is told it succeeded a fraction of a
 * second later.
 *
 * **Absent means "not catching"** and is the third value the client sees, written by the same timer that set it.
 * See {@link CATCH_CONFIG.CATCH_ANIMATION_SECONDS} for how long it stays up, `client/bodyAnimation.ts` for the
 * one reader and the clip, and `client/catchShockwave.ts` for the reader that acts on *which* cause it was
 * rather than on the fact that there is one.
 */
export const CATCH_ANIMATION_ATTRIBUTE = "AnimCatch";

/**
 * The two halves of a catch, as the values {@link CATCH_ANIMATION_ATTRIBUTE} takes.
 *
 * **Declared here beside the attribute and typed rather than spelled out at each end**, which is the argument
 * `HitDirection` makes about the wire: a literal union written in two files is two places for the two strings to
 * drift apart. `BallService` writes it, `client/bodyAnimation.ts` validates it, and `client/catchShockwave.ts`
 * acts on it.
 */
export type CatchCause = "attempt" | "catch";

/**
 * **Whether this body has a catch *window* open right now** — `true` from the moment `CatchService` opens one
 * until the moment it stops counting, and absent at every other time.
 *
 * ## Why it exists, and why it is not {@link CATCH_ANIMATION_ATTRIBUTE}
 *
 * The animation mark above is `true`-shaped for a *clip*: it is written when a window opens and again when a
 * ball arrives, and it lapses after `CATCH_CONFIG.CATCH_ANIMATION_SECONDS` (0.6 s) whatever the window is doing
 * — and it is deliberately **not rewritten when a window is extended**, because a rig holding a window open by
 * asking every tick would then hold a catch pose for its whole life. So it cannot answer "is this body catching
 * now": a 1 s window with 0.6 s of mark leaves 0.4 s in which a catching body is marked as not catching, and a
 * window extended past its first second is marked as nothing at all.
 *
 * **This attribute is the window itself**, and it has exactly one writer and two readers:
 *
 * - **Written by `CatchService`** — `true` in the two places a window opens (the ordinary branch of
 *   `attemptCatch` and the endless window a dev holds), cleared in `consume`, which is the *one* path every
 *   close goes through: a ball caught, an expiry found, a death, a departure, and a dev's flag going off.
 * - **Read by `client/controllers/character/AimFacingController`**, which turns the local player's body onto
 *   the camera while it is set, and by **`server/npc/behaviors/CatchBehavior`**, which turns a rig onto the ball
 *   it is waiting for. One signal for both bodies is the whole point: "catching" is one state and the two kinds
 *   of body must not be able to disagree about it.
 *
 * **A `true` flag rather than a number or a word**, unlike the animation mark, because nothing reads it for a
 * degree. Every reader asks one question — is a window open — and a value with more in it would be a value each
 * reader has to narrow before it can answer.
 *
 * **An attribute rather than a Fusion value on the client**, because the window is the *server's* fact: a press
 * that the server refuses (no free hand, a dodge lockout, a freeze) must not turn the player's body, and a
 * client-side model of the window would turn it for the whole of a press that never opened anything. The server
 * is also the only side that can publish it for a rig.
 */
export const CATCHING_ATTRIBUTE = "Catching";

/**
 * **What a rig is winding up** — the charge it is holding, as a fraction of a full hold, for as long as it holds
 * it. A number from `0` to `1`, written by the one behaviour that runs a windup on the body.
 *
 * ## Who writes it, and who reads it
 *
 * **Written on the server, read on every client, and the two halves are deliberately not the same code.**
 * A rig is driven by `ThrowBehavior` (and its practice twin, `AlwaysThrowBehavior`), which is the only thing
 * that knows a windup exists; the pixels are each client's business, and `client/chargeEffect.ts` draws the
 * looping effect on the rig's hand for as long as this is set. Nothing is sent to describe the effect — the
 * attribute is the whole of the client's discovery, exactly as {@link CATCH_ANIMATION_ATTRIBUTE} is for the
 * catch and {@link DUCKING_ATTRIBUTE} is for the duck.
 *
 * ## A number rather than a boolean — a reversal, recorded
 *
 * **This was a `true` flag, and the argument for it was written out here: "the only question the effect asks is
 * 'is one being held', and a boolean is that question."** That was right for as long as it was true, and it
 * stopped being true when a second effect arrived that needed to know *how much* — a fire ball that overlays the
 * hold above 90 %. **A threshold cannot be asked of a flag**, and the alternatives are both worse than widening
 * this one: a second attribute would carry the same event in two places and could disagree with itself, and a
 * client-side model of a rig's hold is not available at all — nothing on this side knows how long a windup lasts,
 * because the *server* solved it from a distance.
 *
 * **The value costs nothing to publish because it is already in hand at the moment of the write.** The tracker
 * solves the hold before it sets anything, so this is the same write with a number in it instead of `true`, and
 * the client's read is unchanged in shape: absent means "not winding up", and a value means "winding up, by this
 * much".
 *
 * **A rig's number is constant for the whole of its hold, and a player's is not — which is the one place the two
 * bodies differ.** A rig's charge is *solved* rather than measured (`chargeForRange` answers a distance with one
 * number at the instant the rig decides), so a rig is above a threshold for the whole of its windup or never;
 * a player's rises through the hold on a clock and crosses thresholds on the way. Nothing reads this for a
 * player — see the asymmetry below.
 *
 * **Absent means "not winding up"**, the convention every attribute in this block uses, written with `undefined`
 * rather than with `0` so that "holding nothing" and "not holding" are not two spellings of one state.
 *
 * ## The asymmetry, stated because it is the design rather than an oversight
 *
 * **A player's charge is not published.** A player's hold is measured on their own machine
 * (`client/throwing.ts` owns the start instant) and the server learns nothing until the release arrives carrying
 * the number — so the player's *own* effects are drawn by the client that owns the body, computed from that one
 * value, and **a player does not telegraph their charge to anybody else**. A rig's does, and that is the point of
 * the windup: a rig holds for the length of a throw a player would have held, so a person watching sees it
 * coming, which is what makes a rig dodgeable. Publishing a player's charge would be a new remote and new server
 * state, and it is not this.
 */
export const CHARGING_ATTRIBUTE = "Charging";

/**
 * Attribute on a **drill rig's `Model`**: the server time at which its next throw is expected, from
 * `Workspace.GetServerTimeNow()` — and **absent** when the rig is not armed.
 *
 * **A second telegraph, and it is a different question from {@link CHARGING_ATTRIBUTE} rather than a nicer
 * spelling of it.** The charge answers *"how much of a hold is this body holding"* — it exists for the whole of
 * a windup and its value is a 0..1 fraction. This answers *"when does the next ball leave"*, and it exists
 * **before** the hold starts: a drill's cycle is `cadence → windup → throw`, and the only number that can
 * describe the first third of it is an absolute instant. Both are published for the same reason — a rig's throw
 * is meant to be dodgeable, and a dodge needs to be seen coming — and neither can be derived from the other,
 * which is why a rig in the middle of a windup has *both* set at once.
 *
 * **A number rather than a countdown**, because a number is what survives the wire. Sending "3 seconds" would
 * be sending an answer that starts decaying the moment it is sent, on a link whose latency is not measured
 * here; sending the instant it lands at lets every client do the one subtraction with the clock both machines
 * share. `GetServerTimeNow` is that clock — `os.clock` is per-machine and `os.time` is whole seconds, and a
 * countdown rounded to the second would spend most of its life a second out.
 *
 * **Cleared rather than set to `0`**, and that is the whole of the client's rule. `0` is a real timestamp that
 * happened in 1970; "no countdown" is an absence, and a reader that had to test both would be a reader with two
 * spellings of one state — the argument {@link LAST_HIT_BY_CAUSE_ATTRIBUTE} makes about `nil` versus `""`.
 *
 * **Published at the three moments the deadline really moves** — the cycle arming, the windup starting, and the
 * throw re-arming the cycle — and **only while the rig has somebody to throw at**, which is the correction that
 * keeps a number off a rig that is doing nothing. See `PracticeThrowBehavior.publishDeadline`, which is the one
 * writer, and `client/practiceCountdown.ts`, which is the one reader.
 */
export const NEXT_THROW_AT_ATTRIBUTE = "NextThrowAt";

/**
 * Attribute on a **ball**, `true` when it was thrown by a {@link PRACTICE_THROW_TAG} rig — **the marker that
 * makes a drill's ball die at the edge of its bay.**
 *
 * **A marker on the ball rather than a question asked of the thrower on every turn, and the difference is what
 * a pickup does.** A ball is legitimate property: a player can pick a drill's ball up and throw it, and a rule
 * that resolved "did this come from a bay" by looking up `ThrowerId` would then have to care who is holding it
 * and when it changed hands. **The fact is decided once, at the release, and cleared at the next release** —
 * `BallService.throwBallBody` writes it *and* writes `undefined` for a thrower without the tag, so a player who
 * throws a ball they picked up out of a bay does not inherit the death sentence with it.
 *
 * **Read by one thing**, the settle sweep (`BallService.settleLooseBalls`), which destroys the ball the first
 * turn it is outside every bay. The sweep is where it belongs because it already walks every loose ball ten
 * times a second for the rolling resistance, so this costs one attribute read on a loop that exists; a
 * `Touched`-style edge would need a listener per ball and would miss the case that matters most, a ball that
 * leaves a bay without touching anything.
 *
 * **Why a dead ball is the right answer rather than letting it roll**, stated because it is a choice a reader
 * would otherwise assume: a drill's ball is thrown by a body that never leaves its bay, so a ball that has left
 * the bay is a ball that will be fetched from across the practice floor by a rig that is supposed to be standing
 * still — or, worse, rolled somewhere a person picks it up. `insideAnyBay` is the test, and it answers `true`
 * when no bay exists anywhere, which is what stops this from destroying every ball in a place file that has none.
 */
export const THROWN_FROM_BAY_ATTRIBUTE = "ThrownFromBay";

/**
 * The three shapes a rig's throw can take — **the vocabulary {@link THROW_WALK_ATTRIBUTE} carries.**
 *
 * A rig that plants to throw is a stationary target for the whole of its windup, and a person can read and
 * time that; so two of the three shapes walk, and they walk differently:
 *
 * - **`moveAndAim`** walks through the hold and throws on the move. The charge is solved again at the release
 *   against the distance the release measured, so the ball is solved from where the body *is*.
 * - **`moveThenPlant`** walks its carry-through and then stops, and the hold refuses to release while the body
 *   is still moving (`NPC_ANIM_MOVING_ATTRIBUTE`). That refusal is the whole difference between this and
 *   `moveAndAim`, and it is what makes the shape read as a body taking a step and planting.
 * - **`plantNow`** stands and throws. This is the shape every rig had before the three-way split, and it is
 *   still the one `AlwaysThrowBehavior` takes: that rig's hand is never filled by a pickup, so it has no
 *   carry-through to walk and never draws a shape at all.
 *
 * **Drawn once, on the turn the shape is decided, and never re-decided.** See
 * `NPC_CONFIG.THROW_MOVE_AND_AIM_CHANCE` and `NPC_CONFIG.THROW_CARRY_THROUGH_CHANCE`, which are two
 * cumulative bands of a single roll so that the three shares are absolute and cannot overlap; `ThrowBehavior`
 * is the only place a shape is chosen.
 */
export type ThrowWalk = "moveAndAim" | "moveThenPlant" | "plantNow";

/**
 * Attribute on a **rig's `Model`** holding which of the three {@link ThrowWalk} shapes this hold took.
 *
 * **A second attribute rather than a word inside {@link CHARGING_ATTRIBUTE}, and that is forced rather than
 * tidy.** The charge is a *number* and the client reads it as one — absent means "not winding up", a value
 * means "winding up, by this much" — so a shape written into that attribute would be a string where every
 * reader of it expects a number.
 *
 * **It travels on the body because the two halves of the question live in two behaviours.** `SeekBehavior`
 * owns where a rig walks and `ThrowBehavior` owns the hold, and neither holds a reference to the other; the
 * fact is about a *body* for the length of a hold, which is the same class of fact as the charge beside it and
 * the same reason it is published rather than passed.
 *
 * **What each side does with it, one line each.** `ThrowBehavior.beginWindup` writes it, and the *release*
 * reads its own copy off its own record rather than off this attribute — because the release happens after
 * `endWindup` has cleared it. `SeekBehavior`'s pickup walk reads it on its own turn and does one of three
 * things: keeps walking (`moveAndAim`), is told nothing at all and falls through to its ordinary leg
 * (`moveThenPlant`, which is what lets a walking rig keep walking to wherever it was going), or stands
 * (`plantNow`).
 *
 * **`endWindup` is its only clearer**, exactly as it is for the charge: a hold that ends for any reason — a
 * release, the target going away, an expiry — ends with both attributes gone, so a rig cannot be left wearing
 * a shape it is no longer throwing by.
 *
 * **Re-added after a revert dropped it and left its two readers in place**, which is why this doc is terser
 * than its neighbours in this block: the original was lost with the revert rather than recovered, so the
 * paragraphs above are read off `ThrowBehavior` and `SeekBehavior` — the two files that use it — rather than
 * restored from the file it used to sit in.
 */
export const THROW_WALK_ATTRIBUTE = "ThrowWalk";

/**
 * Attribute on a **rig's `Model`** holding the power a collected mystery box is paying for, or `""` for
 * none.
 *
 * **The rig's half of the mystery prize, and deliberately a different mechanic wearing a related name.** A
 * player's box writes a prize in `SuperService` and that prize is consumed by a *press*; a rig has no key to
 * press, so its prize waits here on the model and is consumed by the rig's *next throw* — see `ThrowBehavior`
 * and `AlwaysThrowBehavior`, which read this and hand it to `BallService.markHeldBall` or
 * `BallService.activateMultiBall`. The two prizes are different mechanics sharing a noun; a reader must not
 * treat this as the player's mystery prize under another spelling.
 *
 * **One slot, and `""` is the empty case.** A rig with a full slot ignores a box — no queue, no overwrite —
 * and the slot is cleared after the throw that spends it, success or failure, so a refused mark or a refused
 * throw cannot strand the rig with a prize it can never use. The value is one of the words in
 * `shared/ability.ts`, the same vocabulary a player's prize speaks, and `pendingAbilityOn` is the one reader
 * that narrows the raw string back to that vocabulary.
 *
 * **On the model rather than in a record, because a rig has nothing to persist.** It is a fact about the
 * body — the same class of fact as {@link CHARGING_ATTRIBUTE}, which is also a rig-model attribute — and it
 * dies with the body it is written on. It is *not* the player's {@link SUPER_CHARGE_ATTRIBUTE}, a boolean on
 * a `Player`; the two differ in the same way {@link CHARGING_ATTRIBUTE} and {@link SUPER_CHARGE_ATTRIBUTE}
 * do, and a reader asking "is this body charging a throw" is not asking the question this answers.
 *
 * **A client could read it, and nothing does yet.** It is a string a rig wears like the rest of its published
 * state, so the day a rig's pending power should show on its body — a glow, an icon — the fact is already on
 * the model and needs no remote to be seen.
 */
export const PENDING_ABILITY_ATTRIBUTE = "PendingAbility";

/**
 * Which way a body that is mid-dash went, as one of `DodgeDirection`'s four words — on the **dodging
 * model**, player or rig, for the length of the dash.
 *
 * **The fact the dodge clips need and nothing on the client can work out.** The four dodge clips are
 * directional, and the direction of a dash is decided by `DodgeService` on the server from the request
 * the client sent: the client knows which way it *asked* to go, and not which way the dash actually went
 * — a refusal, a heading the server flattened away, or a dash replaced by a newer one all produce a
 * different answer from what was asked for.
 *
 * **Written by `DodgeService` and not by `NpcService`, which is why it is not named among the four
 * above.** `NpcService` publishes a rig's *condition* while its loop runs; a dash is an action any body
 * can take, a player's character included, and the service that runs it is the service that writes this.
 * The renderer reads it on the same `AttributeChanged` connection it reads the rest of the state on, so
 * no wiring in the renderer is specific to it.
 *
 * **Set at the start of the dash and cleared when it ends, which is the whole of its lifetime.** Absent
 * means "not dashing", so a body that has never dodged and one whose dash has just finished read the
 * same way — and a reader that arrives mid-dash reads the direction rather than having to infer one.
 * A dodge that is replaced by a newer dodge has the newer direction written over it, which is correct:
 * the clip should follow the dash that is actually in flight.
 *
 * **The direction is relative to the body's facing, not to the world** — see `dodgeDirectionOf`, which is
 * where the four words are defined and where the frame they are measured in is argued.
 */
export const DODGE_DIRECTION_ATTRIBUTE = "DodgeDirection";

/**
 * Whether a body is ducking **right now**, on the **ducking model** — player or rig, for the length of
 * the duck.
 *
 * **A flag rather than an end time, and the two readers are why.** The hit test and every action gate
 * want the same thing — "is this body ducking at this instant" — and a countdown written into the
 * attribute would make each of them compare it against a clock. The server's `os.clock` is not the
 * client's, and an attribute is a value that replicates, so a number in here would be read by a
 * different machine's clock than wrote it; an end time published as an instant would need
 * `GetServerTimeNow`, and then every asker carries a subtraction. One boolean with no arithmetic in it
 * is the smaller thing, and the service already owns the clock that ends it.
 *
 * **Server-written, which is what makes it unforgeable.** A client cannot author it: an attribute a
 * client writes on its own character does not replicate, so the only value the server ever sees is its
 * own. That is the property `PRACTICE_ZONE_ATTRIBUTE` has, and it is the whole reason the input path is
 * a *request* — see the `duck` remote.
 *
 * **What reads it.** `BallComponent.handleTouch` asks it of the body a contact resolved to, and refuses
 * the contact when the resolved part is an exempt limb; `DodgeService`, `CatchService`, `BallService`'s
 * throw path and `BallPickupService` each ask it before acting, which is what makes a duck a committed
 * stance rather than a free extra; and `client/bodyAnimation.ts` reads it as the body's fourth published
 * action mark, which is how one clip reaches both bodies.
 */
export const DUCKING_ATTRIBUTE = "Ducking";

