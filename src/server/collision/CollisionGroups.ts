import { CollectionService, PhysicsService, Players, Workspace } from "@rbxts/services";
import { BALL_BARRIER_TAG, CHARACTER_BARRIER_TAG } from "shared/constants";
import { BALL_CONFIG } from "shared/config/ball.config";
import { DEBUG_CONFIG } from "shared/config/debug.config";
import { DUCK_GROUP } from "shared/duck";
import { taggedPartsInWorkspace } from "shared/taggedParts";
import { NPC_TAG } from "../npc/Behavior";

/** The group characters belong to. Assigned by {@link followCharacters}; nothing else joins it. */
const CHARACTER_GROUP = "Character";

/** The group a midline wall belongs to. Assigned by {@link applyBarrierGroups}, at every round boundary, and never to anything else. */
const BARRIER_GROUP = "Barrier";

/**
 * The group a **ball** wall belongs to — the sibling of {@link BARRIER_GROUP} and its opposite.
 *
 * **A group of its own rather than a flag on `Barrier`, because the two walls want opposite rows.** `Barrier`
 * collides with every character group and not with `Ball`; this one collides with `Ball` and with no character
 * group at all. Writing both rules into one group would need a boolean per pair, which is what a group already is.
 *
 * **What makes the ball's half work is that the ball is already somewhere of its own.** A wall that collides with
 * `Default` collides with the floor, the props and the character parts — so a wall that stops *only* balls has to
 * be told which parts are balls, and `BALL_GROUP` is that fact. This row could not have been written before the
 * ball had a group, which is why the wall arrived after it.
 */
const BALL_WALL_GROUP = "BallWall";

/**
 * The group every ball belongs to. Assigned by {@link assignPart}, and by nothing else.
 *
 * **This is a reversal, and the file's own argument for the old arrangement is quoted below rather
 * than deleted.** Balls used to stay in `Default`, on the reasoning that the *character* was the one
 * that could afford to move — and that held for exactly as long as there was one rule about what a
 * ball may pass through. There are now two, and they point in opposite directions: a ball must pass
 * the midline wall **and** must pass a player standing in a practice zone, while still hitting an
 * ordinary character and still bouncing off an edge wall. `Default` cannot say that, because the
 * practice player is *also* made of `Default` parts — the floor they stand on and the arena around
 * them — so a rule stated against `Default` cannot tell the two apart. One of the two had to move, and
 * this time it is the ball.
 *
 * **What makes it affordable is that a collision group and `CanCollide` are different switches.**
 * `BallService` turns `CanCollide` on and off through a ball's whole life — held, thrown, landed — and
 * none of that changes; the group only decides *which pairs* the engine will ever consider. So a ball
 * is `Ball` from the moment it is made, whatever state it is in.
 */
const BALL_GROUP = "Ball";

/**
 * The group a character standing in a practice zone belongs to. Assigned by `PracticeZoneService`, and
 * only for as long as the body is in the zone — see {@link setPracticePlayer}.
 *
 * **A second character group rather than a flag on one part**, because the rule it carries is about
 * *pairs*: a practice player must not collide with a ball, and — like every other character — must
 * not collide with any other character, while still colliding with the world and the midline exactly
 * as an ordinary body does. The one thing that makes the group worth having now is the ball half: a
 * group is the only mechanism the engine offers for a statement about a pair, and the alternative —
 * `NoCollisionConstraint` between this body and every ball in flight — would have to be rebuilt on
 * every throw and undone on every landing.
 */
const PRACTICE_GROUP = "PracticePlayer";

/**
 * What the engine calls the group every part is in until something says otherwise.
 *
 * Named rather than left implicit, because the ball's half of the matrix is a rule about `Default`
 * and a reader should be able to see that word in the call rather than have to know it.
 */
const DEFAULT_GROUP = "Default";

/**
 * The tag every ball carries.
 *
 * **Must match the `tag` in `BallComponent`'s decorator**, which is what turns a ball into a
 * component. The same copy `BallService`, `BallPickupService`, `BallSpawnerService`, `BallFactory`
 * and `OutlineService` each keep, for the same reason: Flamework reads the decorator at build time,
 * so the literal cannot be imported. Here it is the rule that keeps a ball *out* of the character
 * group — the bug this file shipped without for one round. See {@link assignPart}.
 */
const BALL_TAG = "Ball";

/** Whether {@link startCollisionGroups} has already run. A second call does nothing at all. */
let started = false;

/**
 * The arena's two walls, and the collision groups that make the midline one possible.
 *
 * **Two walls, opposites on almost every flag, and that is the whole subject of this file.** A
 * midline wall stops characters crossing to the enemy side and lets balls through. An edge wall
 * stops characters *and* balls. The flags differ on `CanTouch` and `CanQuery`, and copying either
 * wall's setup onto the other produces a bug that is silent in the direction of the copy: an edge
 * wall wearing the midline's flags lets balls out of the arena, and a midline wall wearing the
 * edge's bounces balls off the centre line and stops the aim guide there. See
 * {@link CHARACTER_BARRIER_TAG} for the flags themselves.
 *
 * **The edge wall has no code here, and that is deliberate rather than unfinished.** It needs no
 * group, no tag and no assignment: a `Default` part with `CanCollide`, `CanTouch` and `CanQuery` all
 * true already stops characters and balls alike, because `Default` collides with `Default`. The
 * whole of it is a part in the map template. The one thing a reader might do here — route it through
 * {@link applyBarrierGroups} "so that both walls go through the same code" — is the change that takes
 * the balls out of it.
 *
 * **Why two groups and not one, since the wall only has to be told apart from a ball.** The cheaper
 * design — leave characters in `Default` and put the wall in a group that collides with `Default` —
 * cannot work, and the reason is the ball: balls *are* `Default`, so a wall that collides with
 * `Default` collides with them too. For the wall to know a character from a ball, one of the two has
 * to be somewhere else, and it is not going to be the ball: it is `Default` by construction and its
 * collision is toggled per state all over `BallService`. So the character moves, `Character` exists
 * entirely for the wall's sake, and the row of the matrix that makes the ball's half work is
 * `Barrier` against `Default`, off.
 *
 * **A module called from `main.server.ts` rather than a service.** Registering a group is not
 * something a feature *asks for*; it is a fact about the world that has to be true before anything
 * reads the groups — `main.server.ts` registers them ahead of `Flamework.ignite()`, because a
 * service's `onStart` is where the first of those reads happens. And membership is a fact about
 * characters rather than about any one system. The alternative considered was hanging the assignment
 * off `WalkSpeedService`, which already has a per-body hook; that would have made one service
 * responsible for walk speed *and* for collision membership, for no gain beyond not having this file.
 */
export function startCollisionGroups(): void {
	if (started) return;
	started = true;

	registerGroups();
	followCharacters();

	// **The ball walls, grouped now and grouped again every time one is tagged — which is the whole of what was
	// missing.** The sibling wall is assigned by `applyBarrierGroups`, which `RoundService` calls at a round
	// boundary: that is fine for a wall that only matters while a round is being played, and it is **wrong for this
	// one**, because a ball wall is a thing somebody tags and then walks into with a ball to see what happens. With
	// no round started, nothing had ever assigned the group, so the part stayed `Default` — and the reported
	// symptom (*"nothing happens when I tag a part"*) is exactly that: a wall that is in the wrong group.
	//
	// **A boot pass as well as the signal**, because a wall painted into the place file is already tagged by the
	// time this runs and would otherwise wait for the signal that will never re-fire. The boundary pass is kept as
	// well, since the same part can be re-created by a round's clean-up in a place file that still clones geometry.
	applyBallWallGroups();
	CollectionService.GetInstanceAddedSignal(BALL_BARRIER_TAG).Connect((instance) => {
		if (instance.IsA("BasePart")) assignBallWall(instance);
	});
}

/**
 * Registers the two groups and states the matrix, **in both of the places Roblox keeps them**.
 *
 * **`Workspace` is the home that matters, and this file used to use `PhysicsService` alone.** The
 * two APIs are documented as the same idea at different scopes: `PhysicsService`'s says it "sets the
 * collision status between two groups", while the pair `Workspace` inherits from `WorldRoot` says
 * "in **this world**". What settles it is `WorldModel.UseWorkspaceCollisionGroups`, which asks
 * whether a `WorldModel` should use "**`Workspace` collision groups** or its own independent
 * collision groups" — so `Workspace` has a registry and a matrix of its own, and a part in
 * `Workspace` obeys those. The first version of this file registered with `PhysicsService` alone and
 * demonstrably did not take: a ball thrown at a wall in the `Barrier` group bounced off it, and the
 * two rows set to `false` were the ones that did nothing while the row that collides looked right.
 *
 * **`PhysicsService` is still set as well, and that is deliberate rather than leftover.** The two
 * registries are separate stores as far as anything in this repository can tell, registering in both
 * is the same three booleans either way, and doing it twice is harmless — whereas being wrong about
 * which one governs costs a Studio run to find out. The two prints below put the answer on the
 * record, which is what will let the redundant half be deleted rather than kept out of caution.
 *
 * **Guarded rather than wrapped in `pcall`.** `IsCollisionGroupRegistered` answers exactly the
 * question the guard is asking, so a second call is a no-op instead of an error — and this runs at
 * boot, where an error would take the server with it. The matrix assignment is repeated on a second
 * call and that is harmless: it sets the same three booleans to the same three values.
 */
function registerGroups(): void {
	if (!PhysicsService.IsCollisionGroupRegistered(CHARACTER_GROUP)) {
		PhysicsService.RegisterCollisionGroup(CHARACTER_GROUP);
	}

	if (!PhysicsService.IsCollisionGroupRegistered(BARRIER_GROUP)) {
		PhysicsService.RegisterCollisionGroup(BARRIER_GROUP);
	}

	if (!PhysicsService.IsCollisionGroupRegistered(BALL_GROUP)) {
		PhysicsService.RegisterCollisionGroup(BALL_GROUP);
	}

	if (!PhysicsService.IsCollisionGroupRegistered(PRACTICE_GROUP)) {
		PhysicsService.RegisterCollisionGroup(PRACTICE_GROUP);
	}

	if (!Workspace.IsCollisionGroupRegistered(CHARACTER_GROUP)) {
		Workspace.RegisterCollisionGroup(CHARACTER_GROUP);
	}

	if (!Workspace.IsCollisionGroupRegistered(BARRIER_GROUP)) {
		Workspace.RegisterCollisionGroup(BARRIER_GROUP);
	}

	if (!Workspace.IsCollisionGroupRegistered(BALL_GROUP)) {
		Workspace.RegisterCollisionGroup(BALL_GROUP);
	}

	if (!Workspace.IsCollisionGroupRegistered(PRACTICE_GROUP)) {
		Workspace.RegisterCollisionGroup(PRACTICE_GROUP);
	}

	if (!PhysicsService.IsCollisionGroupRegistered(BALL_WALL_GROUP)) {
		PhysicsService.RegisterCollisionGroup(BALL_WALL_GROUP);
	}

	if (!Workspace.IsCollisionGroupRegistered(BALL_WALL_GROUP)) {
		Workspace.RegisterCollisionGroup(BALL_WALL_GROUP);
	}

	// **`DUCK_GROUP` is registered here, with the other groups, rather than down beside the duck's own
	// row — and the ordering is load-bearing rather than tidy.** The character block below writes pairs
	// that name it as a body group, and the engine *raises* "Both collision groups must be registered"
	// for a row naming a group it has not seen — an error, not a return. Thrown from the middle of this
	// function it takes the whole of `startCollisionGroups` with it, and that call sits before
	// `Flamework.ignite()` in `main.server.ts`: no matrix, no character membership, and no services at
	// all. A group called {@link DUCK_GROUP} is a group like any other and belongs where the others are
	// made.
	if (!PhysicsService.IsCollisionGroupRegistered(DUCK_GROUP)) {
		PhysicsService.RegisterCollisionGroup(DUCK_GROUP);
	}

	if (!Workspace.IsCollisionGroupRegistered(DUCK_GROUP)) {
		Workspace.RegisterCollisionGroup(DUCK_GROUP);
	}

	// **Only the rows that are not the engine's defaults, stated as the exceptions they are.** A
	// freshly registered group collides with everything, so the first line below is already true
	// without being said — stated anyway, because it is the row the wall exists for. The two rows that
	// follow it are the exceptions: the midline lets `Default` (the arena, the props, the edge walls)
	// through, and lets another wall through, and nothing else about the wall is special.
	PhysicsService.CollisionGroupSetCollidable(BARRIER_GROUP, CHARACTER_GROUP, true);
	PhysicsService.CollisionGroupSetCollidable(BARRIER_GROUP, DEFAULT_GROUP, false);
	PhysicsService.CollisionGroupSetCollidable(BARRIER_GROUP, BARRIER_GROUP, false);

	Workspace.CollisionGroupSetCollidable(BARRIER_GROUP, CHARACTER_GROUP, true);
	Workspace.CollisionGroupSetCollidable(BARRIER_GROUP, DEFAULT_GROUP, false);
	Workspace.CollisionGroupSetCollidable(BARRIER_GROUP, BARRIER_GROUP, false);

	// **Character bodies pass through each other — everywhere, always, and this block is the whole of
	// that rule.** The three groups a character can be made of are `Character` (a player's body or a
	// rig's, accessories included), `PracticePlayer` (the same body while it stands in a practice zone)
	// and `DUCK_GROUP` (the head and arms, for the length of a duck), and no two of them collide —
	// whatever state a round or a zone is in. The old rule let a practice player through another
	// practice player and nobody else; the new one lets every character through every character, which
	// is the user's decision and not something this file argues with.
	//
	// **What this is not: a change to the ball, the wall, or the world.** `Ball` still collides with
	// `Character` (a ball must hit a body), `Barrier` still collides with every character group (a body
	// is stopped by the midline), and every character group still collides with `Default` (a body
	// stands on the floor and against a wall). Those rows are the engine's defaults and are deliberately
	// not written here — writing the exceptions and only the exceptions is what lets this block be read
	// as the whole of what "characters pass through each other" changes about physics.
	PhysicsService.CollisionGroupSetCollidable(CHARACTER_GROUP, CHARACTER_GROUP, false);
	PhysicsService.CollisionGroupSetCollidable(CHARACTER_GROUP, PRACTICE_GROUP, false);
	PhysicsService.CollisionGroupSetCollidable(CHARACTER_GROUP, DUCK_GROUP, false);
	PhysicsService.CollisionGroupSetCollidable(PRACTICE_GROUP, PRACTICE_GROUP, false);
	PhysicsService.CollisionGroupSetCollidable(PRACTICE_GROUP, DUCK_GROUP, false);
	PhysicsService.CollisionGroupSetCollidable(DUCK_GROUP, DUCK_GROUP, false);

	Workspace.CollisionGroupSetCollidable(CHARACTER_GROUP, CHARACTER_GROUP, false);
	Workspace.CollisionGroupSetCollidable(CHARACTER_GROUP, PRACTICE_GROUP, false);
	Workspace.CollisionGroupSetCollidable(CHARACTER_GROUP, DUCK_GROUP, false);
	Workspace.CollisionGroupSetCollidable(PRACTICE_GROUP, PRACTICE_GROUP, false);
	Workspace.CollisionGroupSetCollidable(PRACTICE_GROUP, DUCK_GROUP, false);
	Workspace.CollisionGroupSetCollidable(DUCK_GROUP, DUCK_GROUP, false);

	// **The two rows the ball needs, and the practice zone is now the only place a character's
	// collision with a *ball* depends on where they stand.** `Ball` against `Character` stays the
	// engine's default (colliding), so a ball still hits an ordinary body; `Ball` against
	// `PracticePlayer` is off, which is the whole of what the zone's group still does for a ball.
	//
	// **`Barrier` against `Ball` is the row the `Ball` group forced, and it is not new behaviour.** It
	// used to be spelled `Barrier` against `Default`, back when every ball was a `Default` part. The
	// old row is deliberately **left in place below**: `Default` still holds the arena, the loose props
	// and the edge walls, and the midline's job of letting *props* through is unchanged. What would be
	// a bug is removing it — a ball is no longer `Default`, so the old row alone would no longer let a
	// ball through the wall, and the two rows are now about two different populations.
	PhysicsService.CollisionGroupSetCollidable(BARRIER_GROUP, BALL_GROUP, false);
	PhysicsService.CollisionGroupSetCollidable(BALL_GROUP, PRACTICE_GROUP, false);

	Workspace.CollisionGroupSetCollidable(BARRIER_GROUP, BALL_GROUP, false);
	Workspace.CollisionGroupSetCollidable(BALL_GROUP, PRACTICE_GROUP, false);

	// ------------------------------------------------------------- the ball wall
	//
	// **The other wall, row for row the opposite of the one above.** `BallWall` against `Ball` is colliding, so a
	// loose ball *bounces*; every other row here is turned off, which is the whole of what "it only stops balls"
	// means. `Default` is off even though the midline's row against `Default` is off for the opposite reason: that
	// one lets *props* through a wall that stops bodies, and this one lets props through a wall that stops balls.
	// Nothing but a ball touches it either way.
	//
	// **The character rows are why a player walks through, and they are three rather than one** because a body can
	// be in any of three groups — `Character`, `PracticePlayer` (standing in a zone) or `DUCK_GROUP` (the head and
	// arms, mid-duck). Missing one would be a wall that stops a player only while they are ducking, which is the
	// kind of fault that reads as the wall being intermittent.
	//
	// **The `Ball` row is written out rather than left to the engine's default, which is a reversal.** The default
	// is collidable and the first version relied on it, on the argument that "the rows that are not defaults are
	// stated as the exceptions they are". That reads well and it left the one row the feature exists for *invisible
	// in this file* — so when a ball sailed through a wall, nothing here could say whether the row was on, and the
	// answer had to be found by testing. A feature's load-bearing row is worth a line that can be read and one that
	// would break if somebody ever wrote a `false` here by accident.
	//
	// **Nothing here is about `Touched`, and the first version's claim that it was is withdrawn.** That comment said
	// a group suppresses collision rather than contact, and the ball-losing rule was hung off the barrier's own
	// `Touched` on the strength of it. The report that closed this — *"nothing happens when I tag a part"* — is what
	// a contact that never fires looks like, and the rule now runs off geometry instead: see
	// `BallService.pumpBallWalls`, which asks where the ball *is* rather than waiting to be told it touched
	// something. **A wall that is deliberately non-collidable with every body is the worst possible place to rely on
	// a contact event**, and that is worth remembering the next time a rule wants one.
	PhysicsService.CollisionGroupSetCollidable(BALL_WALL_GROUP, BALL_GROUP, true);
	PhysicsService.CollisionGroupSetCollidable(BALL_WALL_GROUP, CHARACTER_GROUP, false);
	PhysicsService.CollisionGroupSetCollidable(BALL_WALL_GROUP, PRACTICE_GROUP, false);
	PhysicsService.CollisionGroupSetCollidable(BALL_WALL_GROUP, DUCK_GROUP, false);
	PhysicsService.CollisionGroupSetCollidable(BALL_WALL_GROUP, DEFAULT_GROUP, false);
	PhysicsService.CollisionGroupSetCollidable(BALL_WALL_GROUP, BARRIER_GROUP, false);
	PhysicsService.CollisionGroupSetCollidable(BALL_WALL_GROUP, BALL_WALL_GROUP, false);

	Workspace.CollisionGroupSetCollidable(BALL_WALL_GROUP, BALL_GROUP, true);
	Workspace.CollisionGroupSetCollidable(BALL_WALL_GROUP, CHARACTER_GROUP, false);
	Workspace.CollisionGroupSetCollidable(BALL_WALL_GROUP, PRACTICE_GROUP, false);
	Workspace.CollisionGroupSetCollidable(BALL_WALL_GROUP, DUCK_GROUP, false);
	Workspace.CollisionGroupSetCollidable(BALL_WALL_GROUP, DEFAULT_GROUP, false);
	Workspace.CollisionGroupSetCollidable(BALL_WALL_GROUP, BARRIER_GROUP, false);
	Workspace.CollisionGroupSetCollidable(BALL_WALL_GROUP, BALL_WALL_GROUP, false);

	// ---------------------------------------------------------------- the duck
	//
	// **The duck's one row, and it is the whole of what a duck changes about physics.** A ducking body's
	// head and arms are moved out of `Character` and into `DUCK_GROUP` for the length of the duck, and the
	// pair below is the *only* one that stops colliding with a *ball* — a ducking body still collides with
	// the world, the midline and props exactly as it did, and its passing through other characters is the
	// general character rule in the block above rather than anything the duck adds. See `shared/duck.ts`
	// for which parts move, and `DuckService` for when.
	//
	// **A group rather than a per-ball constraint, and the practice zone is why that is knowable.** The
	// other shape — `CollisionIgnore.between(ball, part)` for every part and every ball in flight — needs
	// a registry of what is in the air, a change to the throw, and cleanup that holds the handles it was
	// handed: `CollisionIgnore.clear` takes *every* ignore off a part, the thrower's own and a Pierce
	// ball's included, so it cannot be used for this. A group is one row, the engine applies it to every
	// ball in the world the instant the group is written, and undoing it is writing the group back.
	//
	// **A collision group does not suppress `Touched`, and the duck needs that to be true.** It is the
	// same engine fact the practice-zone note above relies on and the arena barrier is built on: the ball
	// stops *bouncing* off a ducking head, and the contact still fires — which is what lets
	// `BallComponent` refuse it. **The two halves are one rule**: a veto alone would leave the ball
	// visibly bouncing off a body the game says it missed, and the group alone would leave it counting.
	//
	// **The group itself is registered at the top of this function, with the other groups**, because the
	// character block above names it as a body group and a row naming an unregistered group is an error
	// rather than a no-op. Only the duck's own row lives here.
	PhysicsService.CollisionGroupSetCollidable(DUCK_GROUP, BALL_GROUP, false);
	Workspace.CollisionGroupSetCollidable(DUCK_GROUP, BALL_GROUP, false);

	// **The rows nothing else can catch, printed for the same reason the wall's are.** A group is a
	// name the engine either accepted or did not, and a row that failed to take is a rule that is
	// *silently* absent: a ball bouncing off somebody in a practice zone, and two characters who still
	// stop at each other. Both look like "the collision matrix is half working", which is the hardest
	// kind of report to act on.
	print(
		`[Collision] ${BALL_GROUP}/${PRACTICE_GROUP} collides — service ` +
			`${PhysicsService.CollisionGroupsAreCollidable(BALL_GROUP, PRACTICE_GROUP)}, ` +
			`world ${Workspace.CollisionGroupsAreCollidable(BALL_GROUP, PRACTICE_GROUP)}`,
	);

	print(
		`[Collision] ${PRACTICE_GROUP}/${PRACTICE_GROUP} collides — service ` +
			`${PhysicsService.CollisionGroupsAreCollidable(PRACTICE_GROUP, PRACTICE_GROUP)}, ` +
			`world ${Workspace.CollisionGroupsAreCollidable(PRACTICE_GROUP, PRACTICE_GROUP)}`,
	);

	print(
		`[Collision] ${CHARACTER_GROUP}/${CHARACTER_GROUP} collides — service ` +
			`${PhysicsService.CollisionGroupsAreCollidable(CHARACTER_GROUP, CHARACTER_GROUP)}, ` +
			`world ${Workspace.CollisionGroupsAreCollidable(CHARACTER_GROUP, CHARACTER_GROUP)}`,
	);

	// **Both registries, printed rather than assumed.** Two `true`s mean one store behind two sets
	// of method names and the redundant half above can go; `world false` would mean the two are
	// separate and `Workspace` is the one that counts. Either way the answer stops being a guess.
	print(
		`[Collision] ${BARRIER_GROUP} registered — service ${PhysicsService.IsCollisionGroupRegistered(BARRIER_GROUP)}, ` +
			`world ${Workspace.IsCollisionGroupRegistered(BARRIER_GROUP)}`,
	);

	// **And the row the ball wall lives on, read back from both — because that line was the missing evidence for a
	// whole session.** `BallWall`/`Ball` is the *entire* loose-ball rule: `true` is a ball bouncing and `false` is a
	// ball thrown straight through, and when the report came in the log could say which group every part was in but
	// not whether the row had taken. It is the one number that separates "the matrix is wrong" from "the matrix is
	// right and something else is", and it costs one line at boot.
	print(
		`[Collision] ${BALL_WALL_GROUP}/${BALL_GROUP} collides — service ` +
			`${PhysicsService.CollisionGroupsAreCollidable(BALL_WALL_GROUP, BALL_GROUP)}, ` +
			`world ${Workspace.CollisionGroupsAreCollidable(BALL_WALL_GROUP, BALL_GROUP)}`,
	);

	// The row the ball's half depends on, read back from both: `false` is the answer that lets a
	// ball through a wall, and `true` on either side is this feature not working.
	print(
		`[Collision] ${BARRIER_GROUP}/${DEFAULT_GROUP} collides — service ` +
			`${PhysicsService.CollisionGroupsAreCollidable(BARRIER_GROUP, DEFAULT_GROUP)}, ` +
			`world ${Workspace.CollisionGroupsAreCollidable(BARRIER_GROUP, DEFAULT_GROUP)}`,
	);

	// **The world's own list of what it knows, by name.** This is the print that answers the
	// question the two above can only circle: a group missing from this list is a group no part in
	// `Workspace` can meaningfully join, whatever `IsCollisionGroupRegistered` says about it — so
	// `Default` alone here means the registration went into the other store and the assignment on
	// every barrier part has been a name the world has never heard of. Read as names rather than as
	// the raw tables the API answers with, because the names are the whole of what is being asked.
	const known: string[] = [];

	for (const group of Workspace.GetRegisteredCollisionGroups()) {
		const name = (group as Record<string, unknown>)["name"];

		if (typeIs(name, "string")) known.push(name);
	}

	print(`[Collision] ${Workspace.Name} knows: ${known.join(", ")}`);
}

/**
 * Puts every character in the game into {@link CHARACTER_GROUP}, and every body after this one.
 *
 * **Two populations, and neither is the other's special case.** Players arrive as a `Player` and
 * then as bodies; rigs arrive as a `Model` that something has tagged, whether that was a person in
 * Studio, `NpcService.spawn`, or `RespawnBehavior` putting a rig back after a death. The scan and
 * subscribe below is the pattern `NpcService` and `OutlineService` both use, and for the reason they
 * use it: a rig tagged in Studio before Play never fires the added-signal, and neither does a player
 * who was already in the game when the server started.
 *
 * A respawned player is blocked by the wall for the same reason a first life is — membership is
 * re-established on every `CharacterAdded` rather than being a property of the body that was there
 * when the round began.
 */
function followCharacters(): void {
	for (const player of Players.GetPlayers()) follow(player);
	Players.PlayerAdded.Connect((player) => follow(player));

	for (const instance of CollectionService.GetTagged(NPC_TAG)) assign(instance);
	CollectionService.GetInstanceAddedSignal(NPC_TAG).Connect((instance) => assign(instance));

	// **And the balls, which neither population above covers.** A ball that is simply *in the world* —
	// one the spawner has just put on the floor — arrives as a tagged part with no character above it, so
	// nothing here had ever touched one: the only balls this file saw were the ones a `DescendantAdded`
	// caught *inside* a body, which is the held case. Under the old matrix that was harmless, because
	// `Default` was where a ball belonged anyway. It is not harmless now. A ball's group is what decides
	// whether it can touch a practice player, so a loose ball left in `Default` would be the one thing on
	// the field still able to hit somebody standing in a zone — and it would be the ball they are most
	// likely to meet, since it is the one lying on the floor next to them.
	//
	// `assignPart` rather than `assign`, so the ball rule is the same line for a thrown ball, a held one
	// and a spawned one — one function, and it is the one that knows a ball never joins a body's group.
	for (const instance of CollectionService.GetTagged(BALL_TAG)) assignPart(instance);
	CollectionService.GetInstanceAddedSignal(BALL_TAG).Connect((instance) => assignPart(instance));
}

/**
 * Keeps `player`'s current body, and every body they get afterwards, in the character group.
 *
 * **The body's own `DescendantAdded` connection, held so that it can be dropped when the body is.**
 * Accessories and tools are not there when `CharacterAdded` fires — a hat is added a moment later,
 * and a tool can be added at any point in the life of the body — so the character's parts are not
 * the whole set that has to carry the group, and a hat left in `Default` is a hat the midline lets
 * through.
 *
 * **It fires for things that are not body parts at all, and the ball is the one that matters.** A
 * ball welded into the hand arrives as a descendant of the character, so this connection is what
 * first painted balls `Character` — see {@link assignPart} for what that cost. The exclusion belongs
 * there rather than here because a rig's held ball never comes through this connection, and one rule
 * in one place covers both.
 *
 * That connection dies with the character it belongs to, but *whether* the engine disconnects an
 * instance's connections when it is destroyed is engine behaviour this repository cannot read out of
 * the typings, so it is dropped by hand on `CharacterRemoving` — one connection per respawn is cheap
 * to avoid, and the signal is one this function is already listening to.
 */
function follow(player: Player): void {
	let added: RBXScriptConnection | undefined;

	const prepare = (character: Model) => {
		added?.Disconnect();
		added = character.DescendantAdded.Connect((descendant) => assign(descendant));

		assign(character);
	};

	player.CharacterAdded.Connect(prepare);
	player.CharacterRemoving.Connect(() => {
		added?.Disconnect();
		added = undefined;
	});

	// The player who was already here: their body will never fire `CharacterAdded` again, and it is
	// the same one-closure-for-both-routes arrangement `WalkSpeedService` uses for the same reason.
	const current = player.Character;
	if (current) prepare(current);
}

/**
 * Puts `instance` — and everything inside it — in the character group, apart from the balls.
 *
 * **Both cases, because both are what the callers have.** A body arrives as a `Model` whose parts are
 * already there, and a hat or a tool arrives as a *part* inside one. Handling only the first would
 * leave a character's accessories in `Default`, and handling only the second would leave the body
 * itself there — which is the version of this that looks like it works, because the wall still stops
 * a character whose *torso* is in the group, and lets through a rig whose parts are not.
 */
function assign(instance: Instance): void {
	assignPart(instance);

	for (const descendant of instance.GetDescendants()) {
		assignPart(descendant);
	}
}

/**
 * Puts one part in `group` — `Character` unless a caller says otherwise — **except that a ball always
 * goes in {@link BALL_GROUP}.**
 *
 * **A ball in a hand is not part of the body, and this is the rule that says so.** `attachToHand`
 * parents a held ball *into the character model* — that is what a weld needs — so collecting a ball
 * fires the character's `DescendantAdded`, and without this rule the ball is painted `Character` along
 * with the hand holding it. It is then thrown still wearing that group, and since `Barrier` collides
 * with `Character` by design, it bounces off the midline: a wall that lets balls through letting
 * through every ball except the ones that had passed through somebody's hands. That is exactly what
 * one round of live testing looked like — the matrix reading `false` on the Default row while the
 * thrown ball stopped.
 *
 * **It used to `return` here rather than assign, and the difference is the practice zone.** Leaving the
 * ball in `Default` was enough while the only rule about a ball was the wall's. It is not enough for a
 * rule that has to tell a *body* from the *floor it stands on*, because both are `Default` — see
 * {@link BALL_GROUP} for the whole of that argument. So the ball now has a group of its own, and this
 * branch is what puts it there.
 *
 * **Checked here rather than at the call sites**, because all of them walk through this function: the
 * connection that catches a collected ball, the walk that catches a rig holding one, and the practice
 * zone's own re-application are one rule, and this is the one place it can be stated once. See
 * {@link BALL_TAG}.
 */
function assignPart(instance: Instance, group = CHARACTER_GROUP): void {
	if (!instance.IsA("BasePart")) return;

	if (instance.HasTag(BALL_TAG)) {
		instance.CollisionGroup = BALL_GROUP;
		return;
	}

	instance.CollisionGroup = group;
}

/**
 * Puts `model` — and everything inside it — into the practice group, or restores it to the character
 * group. Called by `PracticeZoneService` on the way in, and on the way out.
 *
 * **Why this is exported and why it is here.** A group is a rule about a *pair*, so naming one is a
 * statement about what a body may be stopped by; this function exists so the statement is made next to
 * the matrix that makes it true, rather than in the service that happens to know where the body is
 * standing. The service has one job — deciding who is in a zone — and this file keeps every consequence
 * of that decision about collision.
 *
 * **`practice = false` restores rather than merely un-setting**, and that matters: a body that left the
 * zone has to end up in `Character` specifically, because that is the group the midline, the ball rules
 * and {@link follow} all assume an ordinary character is in. Setting it to `Default` would be a body
 * that collides with everything and can be hit by nothing — the worst of both.
 *
 * **A ball is skipped, which is {@link assignPart}'s rule arriving from the other side.** A ball in a
 * practice player's hand is a descendant of that character, so an unconditional walk would repaint it
 * `PracticePlayer` — and it would then be thrown still wearing that, passing through the practice
 * players it was never in and colliding with the one it belongs to.
 *
 * **Walked rather than tracked.** There is no list of "the parts that were assigned practice", and
 * there does not need to be: the body's parts are the answer, and re-walking is cheap for the handful
 * of bodies ever in a zone. A list would be a second source of truth that every respawn would have to
 * invalidate.
 */
export function setPracticePlayer(model: Model, practice: boolean): void {
	const group = practice ? PRACTICE_GROUP : CHARACTER_GROUP;

	assignPart(model, group);

	for (const descendant of model.GetDescendants()) assignPart(descendant, group);
}

/**
 * Puts every part in `Workspace` wearing {@link CHARACTER_BARRIER_TAG} into the `Barrier` group.
 *
 * **Assigned here rather than in Studio, and that is not a preference.** A collision group set on a
 * part in the place file is a *name*, and the group it names is registered by this file at boot — so
 * the part would be relying on a registration from a session that has since ended, or on somebody
 * having set the same thing up by hand in the DataModel. Assigning it from the tag makes the wall
 * correct because the code ran, rather than because the file agreed.
 *
 * **It finds its parts by tag, and that replaced walking a container.** It used to take a root — the
 * map first, then the arena — and walk its `GetDescendants()`, which made the wall's *place* part of
 * the rule: a barrier outside that one container was never visited, and the container also had to be
 * the right *class*, which quietly turned "the arena is a `Folder`" into "there are no barriers".
 * Both of those were found the first time a real place file disagreed with the assumption — the
 * second the moment the arena stopped being a cloned `Model`. A tag is the opposite kind of rule: it
 * says what a part *is*, so a wall can be moved, grouped, nested or reorganised and it is still a
 * wall. This is the shape `ShiftLock.checkZone` and `BallSpawnerService.tick` already use — and since
 * `taggedPartsInWorkspace`, the two of them and this pass all expand a container the same way, so
 * tagging the folder the walls live in is the same act as tagging each wall.
 *
 * **`Workspace` is the scope, which is the half the tag alone cannot say — and that half belongs to
 * `taggedPartsInWorkspace` now rather than to this pass.** What stood here was the paragraph
 * explaining why a tagged wall outside the world is not a wall; it moved into that function, because
 * the three readers that need it were each writing out their own version of it.
 *
 * **The old argument against a tag search is gone rather than ignored.** It was that a search
 * filtered to `Workspace` would find nothing, because the round's map was still a clone out of the
 * world when the pass ran. That was true while a map was cloned in per round, and it stopped being
 * true when the arena became a permanent part of the place: nothing is cloned, so anything tagged is
 * already somewhere a player can walk into it.
 *
 * **The read-back is the point of the line rather than a flourish on it.** Reported always rather
 * than behind a flag, because an arena with no barrier is a legitimate state (a midline nobody has
 * built yet): the count saying zero is the evidence that the pass ran, and each part's name with its
 * resulting group is the evidence that the assignment *took*. A part still reading `Default` after
 * this ran is a name the engine did not accept — which otherwise looks exactly like a pass that never
 * found the tag — and a wall whose *other* half is the thing being hit shows up here too, as a part
 * that is not in the list.
 */
export function applyBarrierGroups(): void {
	// Scope: Collision.applyBarrierGroups — every round boundary, so it should be a spike, not a level.
	if (DEBUG_CONFIG.PROFILE) debug.profilebegin("Collision.applyBarrierGroups");
	applyBarrierGroupsBody();
	if (DEBUG_CONFIG.PROFILE) debug.profileend();
}

/**
 * The body of {@link applyBarrierGroups}, split off **only** so the scope above can wrap it.
 *
 * **Why a second function rather than the pair written into the body.** The function's work is a walk of
 * the midline walls with early exits per part; the split makes the scope's pairing structural instead of
 * depending on there being no `return` between `begin` and `end`. The cost is one call per boundary —
 * which is the point of measuring it here: this runs a handful of times a round, and if it is showing up
 * in a recording at all it is because it is doing something it should not, not because it is called often.
 */
function applyBarrierGroupsBody(): void {
	let assigned = 0;
	let report = "";

	// **The arena's walls, wherever they are tagged — on the parts, or on a folder holding them, and only
	// where there is a world for them to be in.** That last half is `taggedPartsInWorkspace`'s now; see it
	// for why a wall outside `Workspace` is not a wall.
	for (const part of taggedPartsInWorkspace(CHARACTER_BARRIER_TAG)) {
		part.CollisionGroup = BARRIER_GROUP;
		assigned++;

		// Built as a local rather than nested inside the print's own template: roblox-ts compiles
		// each template literal to a Luau interpolated string, so nesting one puts backticks inside
		// backticks — which parses, and quietly renders as nothing.
		const described = `${part.Name} = ${part.CollisionGroup}`;
		report = report === "" ? described : `${report}, ${described}`;
	}

	const suffix = report === "" ? "" : `: ${report}`;

	print(`[Collision] ${assigned} barrier part(s) in ${Workspace.Name}${suffix}`);

	applyBallWallGroups();
}

/**
 * **The ball wall's half of the barrier pass: every `BALL_BARRIER_TAG` part goes into {@link BALL_WALL_GROUP}.**
 *
 * **Called from two places, and the second is the fix this feature needed.** `applyBarrierGroups` runs at every
 * round boundary and calls this, so the walls are re-asserted once a round like their sibling. But **a ball wall is
 * a thing somebody tags and then walks into with a ball to see what happens**, and a round boundary can be minutes
 * away — or never, on a server nobody has started a game on. With no pass run at all the part stayed in `Default`,
 * which collides with every character and with `Default`, and the reported symptom (*"nothing happens when I tag a
 * part"*) is exactly that. So `startCollisionGroups` calls {@link applyBallWallGroups} at boot and groups each part
 * again the moment the tag arrives.
 *
 * **A second count and a second line rather than one combined report**, because the two numbers answer different
 * questions. `0 barrier part(s)` is a midline nobody has built; `0 ball barrier part(s)` is a practice floor with no
 * backstop. One number could not say which wall is missing, and the whole point of these two prints is that a rule
 * that is *silently* absent looks exactly like a rule that is working.
 *
 * **The read-back earns its place here for a sharper reason than on the other wall.** That one's failure is a body
 * walking through the centre line; this one's is a ball sailing through a wall the builder expected it to bounce off
 * *and* a body being stopped dead by a wall that was supposed to be a ghost. A part that reads `Default` after this
 * ran is the second of those — `Default` collides with the character — so the name and the group beside it are the
 * evidence that the wall is a ghost rather than a wall.
 */
export function applyBallWallGroups(): void {
	let assigned = 0;
	let report = "";

	for (const part of taggedPartsInWorkspace(BALL_BARRIER_TAG)) {
		dressBallWall(part);
		assigned++;

		// Built as a local rather than nested inside the print's own template: roblox-ts compiles each template
		// literal to a Luau interpolated string, so nesting one puts backticks inside backticks — which parses, and
		// quietly renders as nothing.
		const described = `${part.Name} = ${part.CollisionGroup}`;
		report = report === "" ? described : `${report}, ${described}`;
	}

	const suffix = report === "" ? "" : `: ${report}`;

	print(`[Collision] ${assigned} ball barrier part(s) in ${Workspace.Name}${suffix}`);
}

/**
 * **One part into the ball wall's group, the moment its tag arrives** — see {@link applyBallWallGroups} for why the
 * boundary pass alone was not enough.
 *
 * Separated from the walk because the two callers have different inputs: a pass has a list, the added-signal has one
 * instance. The alternative — the signal calling the walk — would re-report every wall in the world every time one
 * was tagged, which buries the line that matters (this part, this group) in a list of the others.
 */
function assignBallWall(part: BasePart): void {
	if (!part.IsDescendantOf(Workspace)) return;

	dressBallWall(part);

	print(`[Collision] ball barrier tagged — ${part.Name} = ${part.CollisionGroup}`);
}

/**
 * **Every property a ball wall needs, forced on it, with anything it had to correct said out loud.**
 *
 * **This is the fix for *"I can still throw the ball across past the wall"*, and the group was not the fault.** The
 * log said `BallBarrier = BallWall` — the right group, correctly applied — and the ball still crossed, because a
 * **collision group says which pairs the engine will *consider* and `CanCollide` is the switch that makes it
 * consider them at all.** A part painted as an invisible wall very often has `CanCollide = false`, since that is
 * what an invisible marker usually wants to be, and then the correct group row is a rule about a part that is not
 * solid to anything. **Two switches, one rule, and the log only ever showed one of them.**
 *
 * **So the tag owns the flags, exactly as `MatchService.prepare` owns a join part's four.** That function's argument
 * is this one's: the fault is silent and the fix is one property, so a part that was not set up right is worth a
 * line, and the line names which property it was. Four properties, and each one is a way for the wall to be invisible
 * in a different sense:
 *
 * - **`Anchored = true`** — an unanchored barrier falls out of the world and is destroyed at
 *   `FallenPartsDestroyHeight`, which looks exactly like a wall nothing collides with. The same trap the old lobby
 *   spawn fell into; see `MatchService.prepare`.
 * - **`CanCollide = true`** — the bounce. Without it the group row is decoration.
 * - **`CanTouch = true`** — not needed by either rule as they are written (the held-ball case is geometric), but a
 *   part that cannot be touched is a part that reports nothing to every contact rule in the game, and the first
 *   version of this feature *was* a contact rule. Cheap insurance against the wall being silently inert to a future
 *   one.
 * - **`CanQuery = true`** — the aim arc stops at a wall a throw would bounce off. That is the wall's contract, and a
 *   `CanQuery = false` barrier draws a preview that lies.
 * - **And `Size`, on the thinnest axis** — see {@link thickenBallWall}, which is the fifth and the one this function
 *   used to refuse. A wall thinner than a ball's own step is a wall the engine never sees the ball touch, and the
 *   refusal to grow it cost a round-trip: the warning below told the user to go and edit a part in Studio, twice,
 *   which is the answer this project keeps rejecting for everything else. The tag owns the flags; it may as well own
 *   the one number that makes them mean anything.
 *
 * **Every correction is reported and none is silent**, which is the whole of why five forced properties are
 * acceptable where one would not be: a part that was set up right says nothing, and a part that was not says exactly
 * what was wrong with it. Nobody is left wondering why their wall is not the size they painted.
 */
function dressBallWall(part: BasePart): void {
	const corrected = new Array<string>();

	if (!part.Anchored) corrected.push("Anchored");
	if (!part.CanCollide) corrected.push("CanCollide");
	if (!part.CanTouch) corrected.push("CanTouch");
	if (!part.CanQuery) corrected.push("CanQuery");

	part.Anchored = true;
	part.CanCollide = true;
	part.CanTouch = true;
	part.CanQuery = true;

	part.CollisionGroup = BALL_WALL_GROUP;

	if (corrected.size() > 0) {
		warn(
			`[Collision] "${part.GetFullName()}" was not set up as a ball wall — corrected ${corrected.join(", ")}. ` +
				`The tag owns these flags; see BALL_BARRIER_TAG.`,
		);
	}

	thickenBallWall(part);
}

/**
 * **Grows a ball wall along its thinnest axis until a ball cannot step over it, and says so when it had to.**
 *
 * **Roblox does not sweep a part's collision between frames.** A ball moves `speed / 60` studs every frame, and if
 * that is longer than the wall is thick the ball is on one side and then the other with no overlap in between — the
 * engine never sees them touch, so nothing bounces. At `THROW_MAX_SPEED` (200) that is **3.3 studs per frame**, and a
 * wall painted 1 or 2 studs thick is a wall a full-charge throw goes straight through while a lob bounces off it,
 * which reads as the wall being unreliable rather than as it being thin.
 *
 * **This used to be a warning and nothing more, and that was the wrong call.** The argument was that growing the part
 * "would be inventing a wall" — the same argument that says a script should not move a face a person placed. What it
 * actually did was leave the *reported* fix in Studio, where the user had to find a part, read a number out of the
 * output and type it in, twice, on a wall that was otherwise configured correctly. **The tag now owns the size for
 * exactly the reason it owns the four flags**: it is a silent, one-property failure with a mechanical fix, and the
 * person who tagged the part has already said what they wanted it to do.
 *
 * **The number is derived rather than tunable, and that is deliberate.** It is
 * `ceil(THROW_MAX_SPEED / 60) + 1` — one whole frame of travel, rounded up, plus a stud of margin — so raising the
 * throw speed raises this with it and there is no second constant to keep in step. A literal here would be a number
 * that silently stops being safe the day somebody tunes a throw.
 *
 * **Symmetric about the centre, because there is no honest way to grow it asymmetrically.** "Outward" would mean
 * knowing which side of the wall is the room it was placed to seal, and nothing on a tagged part says that. Growing
 * both faces by the same amount keeps the part exactly where it was put and states the cost: half the added thickness
 * on each side, which for the two-to-five correction the log reported is a stud and a half per face.
 *
 * **The thinnest axis, and the diagonal is deliberately not the unit.** A ball crossing at an angle travels a little
 * further inside the wall, but the axis a throw aimed squarely at it has to cross is the thinnest one, and that is
 * the figure that decides whether the collision is ever registered.
 *
 * **The floors and ceilings of it, named.** A barrier someone paints flat — thin in `Y` — gets thicker *upwards and
 * downwards* rather than wider, which is what its own geometry says it is; a wall that has to stop a ball is still a
 * wall that has to be thicker than a ball's step, and no axis is a special case. Nothing here moves the part, changes
 * its orientation, or touches an axis that is already thick enough.
 */
function thickenBallWall(part: BasePart): void {
	const safe = math.ceil(BALL_CONFIG.THROW_MAX_SPEED / 60) + 1;
	const size = part.Size;

	const thinnest = math.min(size.X, math.min(size.Y, size.Z));
	if (thinnest >= safe) return;

	// One axis grows and the other two are written back untouched, which is cheaper to read than a branch per axis.
	const grown =
		size.X === thinnest
			? new Vector3(safe, size.Y, size.Z)
			: size.Y === thinnest
				? new Vector3(size.X, safe, size.Z)
				: new Vector3(size.X, size.Y, safe);

	part.Size = grown;

	const perFace = (safe - thinnest) / 2;

	warn(
		`[Collision] ball wall "${part.GetFullName()}" was ${string.format("%.2f", thinnest)} studs thick on its ` +
			`thinnest axis — thinner than a ball's own step, so a fast throw passed through it without ever ` +
			`overlapping. Grown to ${string.format("%.1f", safe)} studs on that axis: ` +
			`${string.format("%.2f", perFace)} studs into each face, centred where the part already was. ` +
			`The tag owns this; see BALL_BARRIER_TAG.`,
	);
}
