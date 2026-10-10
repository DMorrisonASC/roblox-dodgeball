import { Controller, OnStart } from "@flamework/core";
import { Players, Workspace } from "@rbxts/services";
import { SERVER_FOLDER_NAME, startAfterimage, stopAfterimage } from "shared/afterimage";
import { AFTERIMAGE_SOURCE_ATTRIBUTE, AFTERIMAGE_WINDOW_ATTRIBUTE } from "shared/constants";

/** Prints the local emit starting and stopping, and one line about the hide pass. Nothing per ghost. */
const DEBUG = true;

/**
 * This client's own afterimage trail, and the pass that keeps the server's copy of it out of the way.
 *
 * **Why this exists, which is what to read before deleting it.** A ghost is built by cloning the body's parts,
 * so a ghost is a copy of *the copy of the body that the machine building it can see* — and on the server
 * that copy trails the player's authoritative one by the network round trip. On a dash of the full fifteen
 * studs the server printed `dashed 5.6 of 15.0 studs`: its own travel measurement of a dash the client
 * completed, made from the same delayed copy the ghosts are made from. So a server-built trail of *your* body
 * is drawn 2–9 studs behind you and its window closes a hop before you actually stop, which at any close
 * camera puts the whole thing at or behind the lens — the player sees it only once they have stopped and
 * turned, which is the complaint this file answers. Built here instead, the trail is placed from the same
 * interpolated body this client is already drawing, so it cannot be anywhere else.
 *
 * **`TeamRingController` is the same fault found and fixed for the rings** — a world-space decoration
 * positioned *from a body*, where the body moves on the machine that owns it. Read its class doc for the
 * argument; what is different here is only that the trail keeps a server path as well, because every *other*
 * client is looking at it.
 *
 * **What this is not.** It is not a second set of rules: the interval, the lifetime, the transparency, the
 * clone filter and the movement gate are all `ACTION_CONFIG`'s and `shared/afterimage.ts`'s — the same file
 * the server runs. And it is not a decision-maker: this controller never decides that a dodge happened. It
 * listens for `AFTERIMAGE_WINDOW_ATTRIBUTE`, which the server publishes from the one function that already
 * knows a window opened, so a refused dodge — an empty charge, no round, a cooldown — emits nothing here
 * either. **And it is not the emitter for anybody else**: every other body's trail is the server's, including
 * every other player's, and drawing those here as well would be a third trail rather than a better one.
 */
@Controller()
export class AfterimageController implements OnStart {
	/** The body this client is emitting for. Replaced on every respawn. */
	private character?: Model;

	/** Whose ghosts to hide, which is this player's own `UserId`. Set in {@link onStart}. */
	private userId = -1;

	onStart(): void {
		// **No `WaitForChild` and no yield anywhere in this file.** A controller's `onStart` runs inside the
		// ignition sequence, so a yield in one controller delays every controller after it. Everything below is
		// therefore either already true or arranged to be noticed when it becomes true — the character is the
		// ordinary case of that, as is the folder the server's ghosts go in.
		const localPlayer = Players.LocalPlayer;
		this.userId = localPlayer.UserId;

		const existing = localPlayer.Character;
		if (existing !== undefined) this.watchCharacter(existing);

		localPlayer.CharacterAdded.Connect((character) => this.watchCharacter(character));
		localPlayer.CharacterRemoving.Connect((character) => this.forgetCharacter(character));

		this.watchServerGhosts();
	}

	/**
	 * Follows one body's window for as long as that body is the local player's.
	 *
	 * **The attribute is read on arrival as well as watched**, because a client can arrive in the middle of a
	 * window: a respawn into an open catch, or a reconnect. An edge-only listener would leave such a body
	 * emitting nothing until the window closed and opened again.
	 *
	 * The connection made here is deliberately not stored and not disconnected. It belongs to the *character*,
	 * which is destroyed on the next death, and a signal connection to a destroyed instance goes with it —
	 * which is the one case where a connection's cleanup is free rather than three explicit ones.
	 */
	private watchCharacter(character: Model): void {
		this.character = character;

		character.GetAttributeChangedSignal(AFTERIMAGE_WINDOW_ATTRIBUTE).Connect(() => this.syncWindow(character));
		this.syncWindow(character);
	}

	/** Stops emitting for a body that is leaving the world, so no loop outlives the thing it was drawing. */
	private forgetCharacter(character: Model): void {
		if (this.character !== character) return;

		this.character = undefined;
		stopAfterimage(character);
	}

	/** Starts or stops this client's own emit, following the server's attribute. See {@link watchCharacter}. */
	private syncWindow(character: Model): void {
		// A late signal from a body that has already been replaced: the attribute changed for a model this
		// client has stopped caring about, and emitting for it would put a trail on a corpse.
		if (character !== this.character) return;

		if (character.GetAttribute(AFTERIMAGE_WINDOW_ATTRIBUTE) === true) {
			if (startAfterimage(character) && DEBUG) print(`[Afterimage] emitting locally for ${character.Name}`);

			return;
		}

		stopAfterimage(character);
	}

	/**
	 * Hides the server's ghosts of this player's own body, on this client only.
	 *
	 * **`LocalTransparencyModifier` rather than destroying the ghost, and the difference is not taste.** The
	 * server tweens every layer of a ghost from the moment it is made to the moment it is destroyed — that is
	 * the fade — and each of those writes replicates. A locally destroyed ghost would therefore be put back by
	 * the next write, several times a second for the whole life of the ghost, so destroying it locally is not a
	 * hide here: it is a flicker. The modifier is the property the engine uses for exactly this purpose — it is
	 * how a first-person camera keeps the local body out of its own view — it is applied only where it is
	 * written, and replication does not touch it.
	 *
	 * **Both kinds of layer, because a ghost has two of them.** `Transparency` on a part does not touch the
	 * `Decal`s parented to it, so hiding the parts alone would leave faces and any printed accessories hanging
	 * in the air — the same trap the fade itself had to avoid. `Texture` extends `Decal`, so those two classes
	 * cover everything a ghost can carry.
	 *
	 * **The folder is found rather than waited for.** It is the server's, made when the first ghost of the
	 * session is, which may be minutes after this runs and may never happen in a place where nobody dodges — so
	 * the absence is a non-event rather than a yield, and the arrival is noticed on `Workspace`.
	 */
	private watchServerGhosts(): void {
		const existing = Workspace.FindFirstChild(SERVER_FOLDER_NAME);
		if (existing?.IsA("Folder")) {
			this.hookGhostFolder(existing);
			return;
		}

		Workspace.ChildAdded.Connect((child) => {
			if (child.Name !== SERVER_FOLDER_NAME || !child.IsA("Folder")) return;

			this.hookGhostFolder(child);
		});
	}

	/** Sweeps what is already in the folder, then watches what arrives. */
	private hookGhostFolder(folder: Folder): void {
		if (DEBUG) print(`[Afterimage] watching ${folder.GetFullName()} for this body's own ghosts`);

		for (const descendant of folder.GetDescendants()) this.inspect(descendant);

		folder.DescendantAdded.Connect((descendant) => this.inspect(descendant));
	}

	/**
	 * Decides about one instance that has just arrived in the server's folder, and hides it if it belongs to
	 * this player's body.
	 *
	 * **Two shapes of arrival, because a ghost is a model with parts inside it.** A ghost's model carries the
	 * mark and arrives before the parts do — a parent instance and its properties are replicated before its
	 * children, which is what makes the attribute readable by the time a part appears — so a part is normally
	 * decided about on its own. The model's own case is still handled, for the one ordering that would leave a
	 * ghost of this body standing: a model that arrives with parts already inside it, which is what the sweep
	 * in {@link hookGhostFolder} and this branch together cover.
	 *
	 * **Nothing is subscribed to per ghost.** A connection per ghost would be one per ghost in the world — forty
	 * a second while trails are running — for a decision that has to be made once, so the mark is read when the
	 * instance arrives and never watched. Both paths are idempotent: an instance seen twice is hidden twice and
	 * costs one write.
	 */
	private inspect(descendant: Instance): void {
		if (descendant.IsA("Model")) {
			if (this.isMine(descendant)) this.hideGhost(descendant);

			return;
		}

		if (!this.isLayer(descendant)) return;

		const ghost = descendant.FindFirstAncestorOfClass("Model");
		if (ghost !== undefined && this.isMine(ghost)) descendant.LocalTransparencyModifier = 1;
	}

	/**
	 * Whether a ghost was copied from this player's own body.
	 *
	 * **Absent counts as no**, which is the whole reason no client ever hides a rig's trail and no client ever
	 * hides another player's: the mark is only written for a body a player owns. See the attribute's own doc in
	 * `shared/constants.ts`.
	 */
	private isMine(ghost: Model): boolean {
		return ghost.GetAttribute(AFTERIMAGE_SOURCE_ATTRIBUTE) === this.userId;
	}

	/** Hides every layer of a ghost, for the case where its parts arrived with it or before the sweep. */
	private hideGhost(ghost: Model): void {
		for (const descendant of ghost.GetDescendants()) {
			if (!this.isLayer(descendant)) continue;

			descendant.LocalTransparencyModifier = 1;
		}
	}

	/** A ghost's two kinds of layer: the parts, and the faces printed on them. See {@link watchServerGhosts}. */
	private isLayer(instance: Instance): instance is BasePart | Decal {
		return instance.IsA("BasePart") || instance.IsA("Decal");
	}
}
