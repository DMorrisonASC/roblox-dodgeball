/**
 * Everything about the arena: where it is, what its spawns are called, and how
 * long a round and the gap between rounds last.
 *
 * Imports nothing, and holds no geometry of its own — the spawns are parts that
 * already exist in the place file, and these are the names the round logic looks
 * them up by. Renaming a spawn in Studio without renaming it here is a spawn
 * that can no longer be found.
 */
export const ARENA_CONFIG = {
	/**
	 * The arena a round is played in: the `Model` in `Workspace` with this name.
	 *
	 * **A permanent part of the world, and that is the newest structure this project has had.** The
	 * arena used to be cloned from `ServerStorage` into `Workspace` when a round started and destroyed
	 * when it ended, so which arena a round played in was an entry in a rotation list held in a map
	 * config — that config and the service that read it have both since been deleted, because the arena
	 * stopped needing them the moment it stayed put. There is now one arena, it sits in the
	 * place file like the lobby does, and nothing is cloned or destroyed per round — so this is a name
	 * to *look something up by* rather than a name to load.
	 *
	 * **The version suffix is real and has already moved once**: `ArenaV1` was replaced wholesale by
	 * `ArenaV2`, which is what the arenas are for — a new one is a new model rather than an edit to the
	 * old one, and this line is the whole of what a swap costs in code. The `Model` class is part of the
	 * lookup rather than an assumption; a `Folder` wearing the name reads as no arena at all.
	 *
	 * **A direct child of `Workspace`, deliberately, and this is the one lookup in the round that pins
	 * a location rather than searching for one.** Everything else searches a subtree — see
	 * `shared/find.ts` for why — because what it wants may be nested anywhere inside something else.
	 * The arena has no such parent: it is at the root of the world, and saying so is what makes the
	 * round's own `[Round] arena resolved` line print a path worth reading.
	 */
	ARENA_NAME: "ArenaV2",

	/**
	 * **Placeholder.** The middle of the arena, in world studs. Nothing reads it:
	 * spawn placement is done by the spawn parts named below.
	 */
	CENTER: new Vector3(0, 0, 0),

	/** **Placeholder.** How far from {@link ARENA_CONFIG.CENTER} a generated spawn ring would sit, in studs. */
	SPAWN_RADIUS: 30,

	/** **Placeholder.** How high above a generated spawn point a model would be dropped in, in studs. */
	SPAWN_HEIGHT: 40,

	/**
	 * The part a player is put on between rounds.
	 *
	 * Looked up by name **anywhere in `Workspace`**, so this and the part have to agree — a loose
	 * part at the root works, and so does one nested inside a lobby model, which is how lobbies tend
	 * to be built. It is the one part the round reads that the arena does not own: the arena is a
	 * `Model` at the root of the world and the lobby is a sibling of it, which is why
	 * `RoundService.lobbySpawn` walks the whole of `Workspace` while the team spawns are read from
	 * inside the arena.
	 *
	 * **Keep this part out of the arena.** The walk does not skip anything inside `ArenaV1` — it used
	 * to skip a copy inside the round's map, and there is no per-round map any more — so a
	 * `LobbySpawn` under the arena would be found, and every intermission would put the players in the
	 * arena to wait.
	 *
	 * **A missing one stops the intermission, not the session — and this used to say the opposite.**
	 * The entry here argued that a missing spawn was an error rather than a silent fallback, because a
	 * round that starts with everyone in the wrong place is worse than one that does not start. The
	 * *rule* is still that, and it is still enforced: nobody is ever put somewhere else instead, and
	 * no round begins. What was wrong was the mechanism. The error was thrown from inside the round's
	 * own loop, so one absent part took the loop down for the rest of the server's life and left the
	 * HUD reading `Intermission — 0s` for ever — a much worse outcome than the one the rule existed
	 * to prevent. `RoundService.waitForLobby` holds the intermission instead, names the missing part,
	 * and resumes the moment it turns up.
	 */
	LOBBY_SPAWN_NAME: "LobbySpawn",

	/**
	 * The folder inside the arena holding the places a player may wait between rounds.
	 *
	 * `ArenaV2/LobbySpawns`, a folder of `BasePart`s — one per valid spot, put there by hand. Which of
	 * them a player gets is picked at random, exactly as a side's spawn is, which is what stops everybody
	 * arriving in one pile; see `RoundService.lobbySpawn`.
	 *
	 * **This is what {@link ARENA_CONFIG.LOBBY_SPAWN_NAME} used to be, and it replaced it.** The lobby
	 * was one part looked up by name anywhere in `Workspace`, which was one place to stand for a whole
	 * lobby; it is a folder of them now, inside the arena, which makes the lobby a thing the arena has
	 * rather than a thing the world happens to contain. The old name is left in place until the code
	 * that still reads it goes with it.
	 *
	 * **Searched for anywhere inside the arena rather than required at a path**, for the reason
	 * {@link ARENA_CONFIG.ARENA_SPAWNS_FOLDER} gives about `ArenaSpawns`: the *structure* — a folder of
	 * parts — is the contract, and where it happens to sit is not. See `shared/find.ts`.
	 *
	 * Missing, or holding no parts, **holds the intermission rather than erroring**: nobody can be put
	 * in a lobby that is not there, and the round's own loop is the one place a throw must never come
	 * from. See `RoundService.waitForLobby`.
	 */
	LOBBY_SPAWNS_FOLDER: "LobbySpawns",

	/**
	 * The folder inside the arena holding one folder of spawn parts per side.
	 *
	 * `ArenaV1/ArenaSpawns/A` and `.../B`, each a folder of `BasePart`s — one part per place a player
	 * on that side may start, put there by hand. Which of them a player gets is picked at random,
	 * which is what stops a side arriving in a single pile; see `RoundService.getRandomTeamSpawn`.
	 *
	 * **Inside the arena rather than at `Workspace` root**, so the arena carries its own spawns and
	 * nothing about spawning sits outside it to be kept in step with it. The lobby is the exception,
	 * and it is the one part the round reads that the arena does not own — see
	 * {@link ARENA_CONFIG.LOBBY_SPAWN_NAME}.
	 *
	 * **Searched for inside the arena rather than required at a path.** `ArenaV1.ArenaSpawns` is where
	 * it is today, but tidying it into a grouping folder of the arena's own breaks nothing: the
	 * *structure* — an `ArenaSpawns` folder with an `A` and a `B` inside it — is the interface, and
	 * where it happens to sit is not. See `shared/find.ts`.
	 *
	 * **A folder of folders rather than a naming convention**, because the parts inside need no names
	 * at all: they are picked by position, so `Spawn1`…`Spawn9` would be nine names to keep right for
	 * no benefit, and adding a tenth spawn is dropping in a part rather than naming it.
	 *
	 * Missing, or holding no parts, is an **error** rather than a fallback — the same rule the lobby
	 * spawn follows and for the same reason: a round that cannot place its players should not start.
	 * `RoundService.arenaProblem` names the arena it looked in, so the fix is obvious.
	 */
	ARENA_SPAWNS_FOLDER: "ArenaSpawns",

	/**
	 * The sub-folder of {@link ARENA_CONFIG.ARENA_SPAWNS_FOLDER} holding team A's spawn parts.
	 *
	 * A plain `"A"` / `"B"`, because those labels are already the round's own vocabulary — they are
	 * what `TEAM_ATTRIBUTE` carries — so the folder is named after the side itself rather than after
	 * a second word for it that would then have to be kept in step.
	 */
	ARENA_TEAM_FOLDER_A: "A",

	/** Team B's. Same rules as {@link ARENA_CONFIG.ARENA_TEAM_FOLDER_A}. */
	ARENA_TEAM_FOLDER_B: "B",

	/**
	 * How many players have to be present for an intermission to run out and a round to begin.
	 *
	 * **The intermission freezes below this rather than skipping.** A server with one player in it
	 * would otherwise cycle intermission → round → intermission for ever, each round starting with
	 * nobody to play it and ending a moment later — a churn of teleports and messages that says
	 * nothing. Holding the clock where it stands means the round that does start is the round that
	 * was already counting down, not a fresh one, and a server that fills up thirty seconds later
	 * still gets that intermission's vote.
	 *
	 * A *round* is not gated by this, only its start: two players dropping to one mid-round play the
	 * round out, because a round that stopped when somebody disconnected would be a round whose
	 * result depended on somebody else's connection. Two is the number because a game needs an
	 * opponent — it is not a balance setting, and there is nothing here to tune.
	 */
	MIN_PLAYERS: 2,

	/**
	 * How long the gap between rounds lasts, in seconds.
	 *
	 * Counted down a second at a time, so this is a whole number of seconds by
	 * construction and a fractional one would be rounded in the HUD rather than in
	 * the clock. Read by `RoundService`.
	 */
	INTERMISSION_SECONDS: 16,

	/**
	 * How long a round lasts, in seconds.
	 *
	 * The same shape as {@link ARENA_CONFIG.INTERMISSION_SECONDS}: a whole number
	 * of seconds, counted down one at a time.
	 */
	ROUND_SECONDS: 150,

	/**
	 * How long every player is held still from the moment they are put on their spawn, in seconds.
	 *
	 * **Measured from the landing, not from the end of the transition.** They arrive under the cover and are
	 * held where they land, so this is the length of the round's opening beat and the transition happens inside
	 * it — a body cannot walk off its spawn while nobody can see it. The number is therefore comparable with
	 * the transition's own length rather than added to it; see `TRANSITION_OPEN_SECONDS`, which is the cover's
	 * and is the figure to compare it against.
	 *
	 * **The round's clock starts when this ends**, on the same tick — not because two durations were made
	 * equal but because they are one statement, one line apart. See `RoundService.transitionAround`, which
	 * waits this out in full and then starts the round.
	 *
	 * **It is independent of the transition, and that is deliberate.** The two run their own clocks rather
	 * than sharing the longer of them, so making the wipe slower, faster or switching it off entirely cannot
	 * change how long players are held — the number below is the whole of it. The one thing to keep in mind is
	 * the comparison with `TRANSITION_OPEN_SECONDS`: at or above it, the freeze outlasts the cover and the
	 * round's clock starts on the tick the hold lifts, which is the arrangement these numbers are meant to be
	 * in. Below it, the freeze ends behind the cover and the tail of the wipe hides players who are free to
	 * move — harmless to the round, but it is what the separation costs.
	 *
	 * **Five seconds, and it is a placeholder that costs the round nothing.** The timer is not running yet, so
	 * nothing is subtracted from `ROUND_SECONDS` — the only thing it spends is five seconds of the players'
	 * time, which is what it exists to spend: long enough to land, look, and see where you are standing.
	 */
	ARENA_FREEZE_SECONDS: 5,

	/**
	 * How long a player waits for a body after dying inside a round, in seconds.
	 *
	 * **Placeholder — three is the ask.** This is the delay an in-round death gets, and the reason the project
	 * owns every character load: `RespawnTime` is the engine's one clock for every death, so asking it for an
	 * instant respawn outside a round — nought — is asking it for one inside a round as well, and it does not
	 * know a round exists to be told otherwise. See `Players.CharacterAutoLoads` in `main.server.ts` for the
	 * switch and `RespawnService` for the mechanism.
	 *
	 * **What it delays, and what it deliberately does not.** It delays the `respawn` branch of
	 * `RoundService.handleDeath` — Score Rush's answer, and Dodge and Seek's — which is the one death in the
	 * game that hands the body straight back. It does **not** delay the load a joining player gets, a death
	 * outside a round, or an eliminated player in Team Elimination: those three want a body *now*, and all
	 * three are the same call to `RespawnService.loadNow` with a different reason on it.
	 *
	 * **Chosen against the round's clock rather than against feel.** A round is `ROUND_SECONDS` long, this is
	 * what a death costs out of it, and it is also the number the dying player watches counting down — so the
	 * figure to compare it against is the one above it.
	 */
	RESPAWN_DELAY_SECONDS: 3,
} as const;
