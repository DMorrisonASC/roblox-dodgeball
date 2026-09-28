import { OnStart, Service } from "@flamework/core";
import { CollectionService, Players, ReplicatedStorage } from "@rbxts/services";
import {
	ROUND_MODE_ATTRIBUTE,
	ROUND_STATE_ATTRIBUTE,
	ROUND_STATUS_FOLDER,
	TEAM_ATTRIBUTE,
} from "shared/constants";
import { GameModeId, isGameModeId, teamColourOf } from "shared/gameMode";
import { OUTLINE_CONFIG } from "../../config/outline.config";
import { NPC_TAG } from "../../npc/Behavior";

/** Prints a line as an outline is put on. Silent about the ones that were already there. */
const DEBUG = true;

/**
 * What the outline is called, and the whole of how one is recognised again.
 *
 * A `Highlight` on its own is indistinguishable from a highlight something else made, so
 * the name is what makes {@link applyOutline} idempotent: a second pass over a rig or a
 * ball that already wears one finds this name and stops. `ObjectOutline` rather than
 * `CharacterOutline`, because it now adorns both and the ball is not a character — the
 * name should not say it is.
 */
const OUTLINE_NAME = "ObjectOutline";

/**
 * The tag a ball carries, watched so every ball is outlined the moment it is tagged.
 *
 * **Must match the `tag` in `BallComponent`'s decorator**, which is the source of truth:
 * the decorator is what turns a ball into a component, and Flamework reads that literal at
 * build time, so it cannot be imported from here. This is therefore a copy rather than a
 * shared constant — exactly as it is in `BallService` and `BallPickupService`, which are
 * the other two readers of a name that three files have to agree on.
 */
const BALL_TAG = "Ball";

/**
 * The phase name that means a round is on.
 *
 * **Must match the string `RoundService` publishes** on `ROUND_STATE_ATTRIBUTE`: a phase goes out as
 * its own name, and those names are `RoundState`'s members by convention rather than by
 * construction — so there is no constant to import and this is a copy. `StatsService` keeps the
 * same one for the same reason, which makes this the third file to spell it out.
 */
const PLAYING = "Playing";

/**
 * Outlines every rig and every ball in the game — players, NPCs, and the balls they throw.
 *
 * Built on the **server** so the outline is part of what replicates: every client sees
 * it on every rig and every ball without a remote and without a client script, and a
 * thing this service never touched is a thing nobody outlines. The alternative — each
 * client outlining what it can see — would be the same rendering, with a per-client hook
 * and a per-client chance to disagree about it.
 *
 * One `Highlight` does all the work, for a rig and for a ball alike. It draws the
 * adornee's own silhouette, so the accessories and anything in a character's hands are
 * covered by saying nothing about them, and there is no second copy of the mesh to keep
 * in step with the first. The whole lifecycle is therefore "put one on when a thing
 * appears" — a `Highlight` is destroyed with what it adorns, so nothing has to be taken
 * off again, and nothing has to be pooled for the ball's comings and goings.
 *
 * **A player's outline is also painted with their side's colour**, so two teams are readable at a
 * glance rather than only by who is throwing at whom. That is the one part of this service that has
 * to *watch* something instead of reacting once: a side can change under a player mid-round — Dodge
 * and Seek turns dodgers into seekers as it goes — and a colour that arrived with the body and was
 * never revisited would be a colour outliving the side it described.
 *
 * **Rigged NPCs and balls are not painted.** They are on nobody's side, and the default colour is
 * what tells them apart from somebody who is playing. See {@link outlineColourFor}.
 */
@Service()
export class OutlineService implements OnStart {
	public onStart(): void {
		Players.PlayerAdded.Connect((player) => this.watch(player));

		// A player already in the game when this service started never fires the
		// added-signal, so the ones already here are walked rather than waited for. The
		// same scan-and-subscribe `NpcService` does for its tag, for the same reason.
		for (const player of Players.GetPlayers()) this.watch(player);

		// The two tags, watched identically. A rig and a ball differ in what they are,
		// not in how they are found: both are tagged, and both arrive through the same
		// pair of mechanisms. See {@link watchTag}.
		this.watchTag(NPC_TAG);
		this.watchTag(BALL_TAG);

		// Spawned rather than done inline: the round's status folder is made by `RoundService.onStart`
		// and which of the two services runs first is not defined, so waiting for it here would be a
		// yield in `onStart` — which this codebase keeps out of service startup for exactly that
		// reason. See {@link followRound}.
		task.spawn(() => this.followRound());
	}

	/**
	 * Starts watching the round, so that a side or a mode changing repaints everybody.
	 *
	 * **Only the phase and the mode are watched, and not the clock.** Those two are what change the
	 * *answer* to "what colour is this rig"; `ROUND_TIME_ATTRIBUTE` changes once a second and would
	 * repaint every character on the server to arrive at the colour it already had.
	 *
	 * The paint at the end is not redundant with {@link watch}. A player already in the game when
	 * this service started was dressed before this method could run, and at that moment the folder
	 * may not have existed — so `outlineColourFor` read "no round" and drew them in the default
	 * colour. This is what corrects that once the round's channel is open.
	 */
	private followRound(): void {
		const status = ReplicatedStorage.WaitForChild(ROUND_STATUS_FOLDER);

		const repaintAll = () => {
			for (const player of Players.GetPlayers()) {
				const character = player.Character;
				if (character) paint(character, player);
			}
		};

		status.GetAttributeChangedSignal(ROUND_STATE_ATTRIBUTE).Connect(repaintAll);
		status.GetAttributeChangedSignal(ROUND_MODE_ATTRIBUTE).Connect(repaintAll);

		repaintAll();
	}

	/**
	 * Outlines everything wearing `tag`: what is in the world now, and what arrives later.
	 *
	 * One method for both tags because there is one behaviour — a `Highlight` on the
	 * instance, once — and the only thing that differs between a rig and a ball is which
	 * tag it wears. Neither half is redundant: a rig or a ball tagged before this service
	 * started never fires the signal, and one tagged afterwards is never in the initial
	 * `GetTagged`.
	 *
	 * Balls churn through this constantly — a fresh one is welded into a hand on every
	 * throw — and that is fine. The signal fires, a highlight is created, and both go away
	 * with the ball; there is nothing to keep in step and nothing to pool.
	 */
	private watchTag(tag: string): void {
		for (const instance of CollectionService.GetTagged(tag)) applyOutline(instance);

		CollectionService.GetInstanceAddedSignal(tag).Connect((instance) => applyOutline(instance));
	}

	/**
	 * Arranges an outline for `player`: one now, if they already have a character, and
	 * one on every character they are given afterwards.
	 *
	 * Per **character** rather than per player, because a character is what the outline
	 * hangs off and characters are replaced on every death. Subscribing on `PlayerAdded`
	 * alone would leave the first character outlined and every respawn bare.
	 *
	 * It also arranges for the outline to be *coloured*: {@link dress} does both halves, and the
	 * `TEAM_ATTRIBUTE` subscription below covers the one case a new body cannot — a side changing
	 * while the player keeps the body they already have.
	 */
	private watch(player: Player): void {
		player.CharacterAdded.Connect((character) => dress(player, character));

		// **Once per player, not once per character**, and that is what keeps this from needing a
		// connection per respawn and a table to hold them in. `TEAM_ATTRIBUTE` lives on the *player*,
		// so its signal outlives every body that player is given — a character is replaced on every
		// death, and a connection made per character would have to be tracked and dropped as each
		// one died.
		//
		// The character may be `undefined` when this fires — an attribute can change while a player
		// is dead — in which case there is nothing wearing an outline to repaint, and the
		// `CharacterAdded` above will dress whatever comes next with the colour this read.
		player.GetAttributeChangedSignal(TEAM_ATTRIBUTE).Connect(() => {
			const character = player.Character;
			if (character) paint(character, player);
		});

		const character = player.Character;
		if (character) dress(player, character);
	}
}

/**
 * The outline on `target`, if it has one.
 *
 * The one place {@link OUTLINE_NAME} is matched against, so the idempotence check in
 * {@link applyOutline} and the lookup in {@link paint} cannot disagree about what counts as an
 * outline — they did when this was two copies of the same three lines.
 */
function findOutline(target: Instance): Highlight | undefined {
	const existing = target.FindFirstChild(OUTLINE_NAME);
	if (existing === undefined || !existing.IsA("Highlight")) return undefined;

	return existing;
}

/**
 * Puts an outline around `target`, once — in the default colour, which a player's side may then
 * overpaint. See {@link paint} for the half that decides what colour it should be.
 *
 * Takes any `Instance` because an outlined thing is not always a character: a rig is a
 * `Model` and a ball is a `BasePart`, and `Highlight.Adornee` accepts either. It draws
 * whatever silhouette the adornee has, so nothing here has to know which it was handed.
 *
 * `FillTransparency = 1` is what makes this an outline rather than a tint: the fill is
 * gone and only the edge is drawn. `Occluded` rather than `AlwaysOnTop` is the other half
 * of the look — the outline is hidden by whatever hides the thing it adorns, so a rig or a
 * ball behind a wall is one nobody can see, and nobody sees it *through* the wall either.
 * That matters at least as much for the ball as for the rig: an outline that showed
 * through geometry would be a free read on where a throw is coming from.
 *
 * Idempotent by name, and that is load-bearing twice over: `CharacterAdded` can fire for a
 * character this has already dressed, and a tag signal can deliver an instance this has
 * already seen — a second highlight would be a second edge on every silhouette.
 *
 * Nothing is taken off again. The highlight is a child of what it adorns, so it goes away
 * with it, which is what makes the ball's churn — a fresh ball welded into a hand on every
 * throw — cost one `Highlight` and nothing else.
 */
function applyOutline(target: Instance): void {
	if (!OUTLINE_CONFIG.ENABLED) return;

	const existing = findOutline(target);
	if (existing !== undefined) return;

	const highlight = new Instance("Highlight");
	highlight.Name = OUTLINE_NAME;
	highlight.FillTransparency = 1;
	highlight.OutlineTransparency = 0;
	highlight.OutlineColor = OUTLINE_CONFIG.COLOR;
	highlight.DepthMode = Enum.HighlightDepthMode.Occluded;
	highlight.Adornee = target;
	highlight.Parent = target;

	if (DEBUG) print(`[Outline] ${target.Name}: outlined`);
}

/**
 * Gives `character` an outline and its player's side colour — the whole of what happens when a
 * player is handed a body.
 *
 * Both halves, in this order, because the colour is a property *of* the outline: painting first
 * would be painting nothing, since a fresh character has no outline until {@link applyOutline}
 * has made one.
 */
function dress(player: Player, character: Model): void {
	applyOutline(character);
	paint(character, player);
}

/**
 * Paints `character`'s outline in the colour its player's side is drawn in.
 *
 * **A missing outline is a state, not an error** — the same rule `AimTargetController` applies to
 * the same highlight, for the same reason. A rig that has not been dressed yet, or one dressed
 * while the whole system was switched off in `OUTLINE_CONFIG`, has nothing to paint; there is
 * nothing to do about it here either, because the next `dress` will make one.
 */
function paint(character: Model, player: Player): void {
	const highlight = findOutline(character);
	if (highlight === undefined) return;

	highlight.OutlineColor = outlineColourFor(player);
}

/**
 * The colour `player`'s outline should be, right now.
 *
 * **Everything that cannot name a side lands on the default colour, and the lobby is the important
 * case.** Outside a round nobody has a side that means anything: `TEAM_ATTRIBUTE` is left standing
 * from the round that has just finished and is never cleared, so a colour read from it between
 * rounds would be a claim about a game that is over. That is why the phase is checked *first* — and
 * it is also why waiting for a round looks exactly like waiting for one to end, which is the
 * honest answer: in neither of them is anybody on a team.
 *
 * The default is what an NPC rig and a ball wear too, and that is a feature rather than a gap: it
 * means "not on a side", and it is how a player tells a rig apart from a person at a distance.
 */
function outlineColourFor(player: Player): Color3 {
	if (!isPlaying()) return OUTLINE_CONFIG.COLOR;

	const label = player.GetAttribute(TEAM_ATTRIBUTE);
	if (!typeIs(label, "string")) return OUTLINE_CONFIG.COLOR;

	const mode = currentMode();
	if (mode === undefined) return OUTLINE_CONFIG.COLOR;

	return teamColourOf(mode, label) ?? OUTLINE_CONFIG.COLOR;
}

/** The round's status folder, or nothing before `RoundService` has made it. */
function statusFolder(): Instance | undefined {
	return ReplicatedStorage.FindFirstChild(ROUND_STATUS_FOLDER);
}

/**
 * Whether a round is being played.
 *
 * Asked of the folder rather than of `RoundService`, the way `StatsService` asks it: nothing here
 * has to be told when a round starts or ends, and the round needs no reference to the outline. A
 * folder that does not exist yet — the first moments of a server's life — is not a round either.
 */
function isPlaying(): boolean {
	return statusFolder()?.GetAttribute(ROUND_STATE_ATTRIBUTE) === PLAYING;
}

/**
 * Which mode the round is being played as, or nothing if no vote has named one yet.
 *
 * The attribute holds a mode **id**, so this doubles as the check that it names a mode this build
 * has — see `ROUND_MODE_ATTRIBUTE`. `undefined` is the ordinary answer for the first round of a
 * server's life, and it lands on the default colour like everything else that cannot name a side.
 */
function currentMode(): GameModeId | undefined {
	const value = statusFolder()?.GetAttribute(ROUND_MODE_ATTRIBUTE);
	if (!typeIs(value, "string") || !isGameModeId(value)) return undefined;

	return value;
}
