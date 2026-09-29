import { Service } from "@flamework/core";
import { ServerStorage, Workspace } from "@rbxts/services";
import { findModel } from "shared/find";
import { MAP_CONFIG } from "shared/config/map.config";
import { applyBarrierGroups } from "../collision/CollisionGroups";

/** Prints a line per load and unload. A swap is the whole of what this service does. */
const DEBUG = true;

/**
 * The map a round is played in: one at a time, cloned in from `ServerStorage` and destroyed again.
 *
 * **`ServerStorage` rather than `Workspace`, and that is the whole trick.** A map sitting in
 * `Workspace` is loaded for the entire life of the server, so the places a round can be played in
 * would be fixed at the moment the place file was saved. Keeping the arenas in `ServerStorage`
 * makes the map *something the server puts there*, which is what allows swapping at all — and
 * `ServerStorage` does not replicate, so the arenas waiting their turn cost no traffic to clients
 * who cannot see them anyway.
 *
 * **The clone is played in, never the template.** The model in `ServerStorage` is never parented
 * anywhere, never modified and never destroyed, so a round cannot damage the map the next round
 * will be built from. Broken arena geometry stays broken for the rest of the server, and the fix is
 * to edit the template rather than to restart.
 *
 * **One map alive at a time, enforced here rather than promised.** {@link loadMap} unloads before
 * it loads, so no call can leave two arenas in `Workspace` and no caller has to remember to unload
 * first. That is the whole reason the pair is one method: the failure it prevents is two arenas
 * interpenetrating, which looks like broken geometry rather than like a mistake anybody could read.
 *
 * **Cloning and placing are two steps, because an intermission is not a round.** A map is cloned
 * when an intermission begins — the expensive half of a swap, paid while nothing is happening — and
 * is parented into `Workspace` only when the round is about to start. An arena sitting in
 * `Workspace` for the whole of an intermission is an arena every client can see, and that every
 * client is streamed, for a round that has not begun. {@link placeCurrent} is the second step.
 */
@Service()
export class MapService {
	/**
	 * The clone this service is holding, if any. The one and only map.
	 *
	 * **It is a child of `Workspace` only between {@link placeCurrent} and {@link unloadCurrent}**,
	 * and the gap is deliberate rather than incidental: the arena is cloned while the intermission is
	 * idle, and stays out of the world — so it is drawn by nobody and replicated to nobody — until
	 * the round it belongs to is about to begin. See {@link loadMap}.
	 */
	private current: Model | undefined;

	/** How far the rotation has got. See {@link pickNext}. */
	private nextIndex = 0;

	/**
	 * Clones `name`'s map and takes charge of it, replacing whatever this service was holding.
	 *
	 * **It clones and holds; it does not place.** The clone is left unparented, and
	 * {@link placeCurrent} is what puts it in `Workspace` — the round does that at its own boundary,
	 * so an intermission is not spent with an arena in the world in front of every client. See the
	 * note on the class for why the two halves are separate.
	 *
	 * **Unload first, then clone.** The two halves of the first step are one operation because they
	 * have to be: a caller cannot get it wrong, because there is no way to load without the unload
	 * happening.
	 *
	 * **A missing map is a warning, not an error.** This runs at the top of an intermission, inside
	 * the round's own loop, and throwing here would kill that loop — the cycle would stop for the
	 * rest of the server's life. So the caller is told the load did not happen (it gets
	 * `undefined`), the output says which name and which folder, and the *round* fails loudly later
	 * at the point it actually needs a map, which is the teleport. Failing where the need is rather
	 * than where the mistake was is deliberate: the message still names the missing thing, and the
	 * behaviour is still a round that refuses to start.
	 */
	public loadMap(name: string): Model | undefined {
		this.unloadCurrent();

		// **A structural exception, and this is the justification for it.** `ServerStorage.Maps` is the
		// root of the game's own storage rather than somewhere a person arranges, so it is looked up as
		// a child of the service — the alternative is a `GetDescendants()` walk over every arena
		// template in the place, once per intermission, to find a folder whose name is already a shared
		// config constant (`MAP_CONFIG.MAPS_FOLDER`). The *map* inside it is searched for rather than
		// assumed to be a child; see below.
		const root = ServerStorage.FindFirstChild(MAP_CONFIG.MAPS_FOLDER);
		if (root === undefined) {
			warn(`[Map] ServerStorage.${MAP_CONFIG.MAPS_FOLDER} is missing — nothing loaded`);
			return undefined;
		}

		// **Searched for rather than looked up as a child.** `root.FindFirstChild(name)` answers about
		// one level, and a map someone has filed inside a grouping folder in `ServerStorage.Maps` would
		// read as "nobody has built this map yet" — a warning about a model sitting a folder away. The
		// same search is used for the map's own contents; see `shared/find.ts` for why the class has to
		// be part of the question rather than a check on the answer.
		const template = findModel(root, name);
		if (template === undefined) {
			warn(`[Map] "${name}" is not a Model anywhere under ServerStorage.${MAP_CONFIG.MAPS_FOLDER} — nothing loaded`);
			return undefined;
		}

		const loaded = template.Clone();

		// **Not parented, and that is the whole reason this is two methods.** The clone stays out of
		// the world until `placeCurrent`, so an arena nobody is playing in is drawn by nobody and
		// streamed to nobody — see the note on the class. Nothing here needs it in a DataModel:
		// a part's `CFrame` is world-space whether or not its model has a parent, so the spawn
		// lookups that read this model work exactly the same while it is still in hand.
		this.current = loaded;

		if (DEBUG) print(`[Map] loaded "${name}"`);

		return loaded;
	}

	/**
	 * Puts the map this service is holding into `Workspace`.
	 *
	 * **The second half of a swap, and the half only the round can decide.** {@link loadMap} builds
	 * the arena where nobody can see it; this is what makes it the world the round happens in, so it
	 * belongs at the round boundary — after the map has been checked over, and before the first
	 * teleport — rather than at the intermission that cloned it. Between the two calls the map is
	 * real, valid and findable through {@link getCurrent}; it is just not in the world.
	 *
	 * **Idempotent, so the caller does not have to keep track.** Called twice, the second call finds
	 * the map already parented and does nothing. Called with nothing loaded — a map whose name nobody
	 * has built yet — it does nothing either. That is the same bargain {@link unloadCurrent} offers,
	 * and for the same reason: the boundary calls both unconditionally, and a rule every caller has
	 * to remember is a rule somebody forgets once.
	 */
	public placeCurrent(): void {
		const current = this.current;
		if (current === undefined) return;
		if (current.Parent === Workspace) return;

		// **The barriers are assigned before the map enters the world, and that is the whole reason
		// this line is above the parenting rather than below it.** The arena becomes collidable the
		// moment it is in `Workspace`, so a wall that joined a physics step still wearing `Default`
		// would stop a thrown ball for a frame — and the ball is the one thing a midline wall must
		// never do. Out here there is no step to be caught by: the pass runs on a model nothing is
		// simulating yet. See `collision/CollisionGroups.ts` for the two walls and their flags.
		applyBarrierGroups(current);

		current.Parent = Workspace;

		if (DEBUG) print(`[Map] placed "${current.Name}"`);
	}

	/**
	 * Destroys the map this service is holding, in the world or still in hand.
	 *
	 * **Destroyed rather than un-parented and kept.** The clone is disposable by construction: the
	 * template it came from is untouched and is what the next round will be built from, so there is
	 * nothing worth carrying over between rounds — and a map kept alive between them would be the map
	 * that just finished rather than the map that is next.
	 *
	 * Safe with nothing loaded, which is what lets {@link loadMap} call it unconditionally — a guard
	 * at the call site would be a rule somebody has to remember, and this is exactly the rule that
	 * gets forgotten once and leaves two arenas overlapping for a round.
	 */
	public unloadCurrent(): void {
		const current = this.current;
		if (current === undefined) return;

		// Read before the destroy, not after: the name is for the print, and reading it off an
		// instance that has just been torn down is the kind of thing that works until it does not.
		const name = current.Name;

		current.Destroy();
		this.current = undefined;

		if (DEBUG) print(`[Map] unloaded "${name}"`);
	}

	/**
	 * The map this service is holding, or nothing if none is loaded.
	 *
	 * **Answers while the map is still out of the world, deliberately.** The round boundary asks this
	 * to check a map over *before* {@link placeCurrent} puts it in `Workspace`, and the spawn lookups
	 * ask it during a round, after — so both of them want "the map this service is looking after"
	 * rather than "the child of `Workspace`", and one of the two callers is asking about a model no
	 * player can see yet.
	 */
	public getCurrent(): Model | undefined {
		return this.current;
	}

	/**
	 * The next map name, rotating through {@link MAP_CONFIG.MAP_NAMES} in order.
	 *
	 * **Sequential rather than random, and that is a playtesting decision.** With two maps, random
	 * is happy to pick the same arena twice or three times running — which is precisely the run you
	 * must *not* get when you are checking that the second map works. A rotation guarantees every
	 * map is played and that no two rounds running use the same one, which for a list of two or
	 * three is the thing "random" was wanted for anyway.
	 *
	 * One map behaves identically either way, so this costs nothing today. **To make it random,
	 * replace the middle of this method with `names[math.random(0, names.size() - 1)]`** — nothing
	 * else reads the index, and the empty-list case below still applies.
	 *
	 * An empty list warns and returns `""`, which is not a name any map will match, so `loadMap`
	 * refuses it in the same breath. That is the reason it returns rather than throwing, the same
	 * reason `loadMap` warns: this is called from inside the round's loop.
	 */
	public pickNext(): string {
		const names = MAP_CONFIG.MAP_NAMES;

		if (names.size() === 0) {
			warn("[Map] MAP_CONFIG.MAP_NAMES is empty — there is no map to pick");
			return "";
		}

		const name = names[this.nextIndex % names.size()];

		this.nextIndex = (this.nextIndex + 1) % names.size();

		return name;
	}
}
