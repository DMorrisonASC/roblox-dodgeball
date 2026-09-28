import { Service } from "@flamework/core";
import { ServerStorage, Workspace } from "@rbxts/services";
import { MAP_CONFIG } from "shared/config/map.config";

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
 */
@Service()
export class MapService {
	/** The clone currently in `Workspace`, if any. The one and only map. */
	private current: Model | undefined;

	/** How far the rotation has got. See {@link pickNext}. */
	private nextIndex = 0;

	/**
	 * Puts `name`'s map into `Workspace`, replacing whatever is there.
	 *
	 * **Unload first, then load.** The two are one operation because they have to be — see the note
	 * on the class. A caller cannot get this wrong, because there is no way to load without the
	 * unload happening.
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

		const root = ServerStorage.FindFirstChild(MAP_CONFIG.MAPS_FOLDER);
		if (root === undefined) {
			warn(`[Map] ServerStorage.${MAP_CONFIG.MAPS_FOLDER} is missing — nothing loaded`);
			return undefined;
		}

		const template = root.FindFirstChild(name);
		if (template === undefined || !template.IsA("Model")) {
			warn(`[Map] "${name}" is not a Model in ServerStorage.${MAP_CONFIG.MAPS_FOLDER} — nothing loaded`);
			return undefined;
		}

		const loaded = template.Clone() as Model;
		loaded.Parent = Workspace;

		this.current = loaded;

		if (DEBUG) print(`[Map] loaded "${name}"`);

		return loaded;
	}

	/**
	 * Destroys the map in `Workspace`, if there is one.
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

	/** The map in `Workspace`, or nothing if none is loaded. */
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
