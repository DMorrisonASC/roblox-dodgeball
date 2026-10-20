import { OnStart, Service } from "@flamework/core";
import { CollectionService, Players, ReplicatedStorage } from "@rbxts/services";
import { ARENA_CONFIG } from "shared/config/arena.config";
import { DEBUG_CONFIG } from "shared/config/debug.config";
import { TRANSITION_CONFIG, TRANSITION_COVER_SECONDS } from "shared/config/transition.config";
import {
	ROUND_MODE_ATTRIBUTE,
	ROUND_STATE_ATTRIBUTE,
	ROUND_STATUS_FOLDER,
	TEAM_ATTRIBUTE,
} from "shared/constants";
import { teamColourOf } from "shared/gameMode";
import { OUTLINE_CONFIG } from "../../config/outline.config";
import { NPC_TAG } from "../../npc/Behavior";
import { sideOfRig } from "../../npc/rigs";

/** Prints a line as an outline is put on. Silent about the ones that were already there. */
const DEBUG = false; // off for frame time — see shared/config/debug.config.ts

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
 * shared constant, and one copy among several — every file that has to find a ball spells
 * the name out, so all of them have to agree with the decorator.
 */
const BALL_TAG = "Ball";

/**
 * The phase name that means a round is on.
 *
 * **Must match the string `RoundService` publishes** on `ROUND_STATE_ATTRIBUTE`: a phase goes out as
 * its own name, and those names are `RoundState`'s members by convention rather than by
 * construction — so there is no constant to import and this is a copy. `StatsService` keeps the same
 * one for the same reason, and so does every other file that has to test the phase: the word is
 * written out in each of them rather than imported from one.
 */
const PLAYING = "Playing";

/**
 * How long after a phase change the round moves every body — at a boundary that is covered.
 *
 * **Read from the transition's own numbers rather than waited for, because there is no signal for "the move
 * has happened".** `RoundService.transitionAround` announces the transition, waits
 * `TRANSITION_COVER_SECONDS` and only then calls `moveEveryone`, and nothing publishes an edge when it does.
 * So this reads the same constant the round waits — which is exactly the reading
 * `LobbyRigService.refillAtRoundStart` makes of the cover, for the same reason and from the same import.
 *
 * **`covered` is what each boundary answers for itself**, and it is the round's answer rather than a
 * preference here: `transitionAround` treats an absent `wipe` as `true`, which is the round start, and the
 * round's end passes `TRANSITION_CONFIG.WIPE_AT_ROUND_END`. With the wipe switched off entirely both
 * boundaries move at once and this is nought.
 */
function moveDelay(covered: boolean): number {
	if (!TRANSITION_CONFIG.ENABLED || !covered) return 0;

	return TRANSITION_COVER_SECONDS;
}

/**
 * How long after the whistle a rig in the round may act: the move, plus the hold the round keeps everybody in
 * once they have landed.
 *
 * **Two numbers added rather than a third duration kept in step**, and both are the round's own. The hold is
 * `ARENA_CONFIG.ARENA_FREEZE_SECONDS` measured from the move, and it is the *same* constant
 * `LobbyRigService.refillAtRoundStart` delays by before it hands a rig its six gameplay behaviours — so this
 * is the instant a rig starts playing rather than standing, which is the instant its colour belongs with. See
 * {@link paintRig} for why the colour is timed to the playing rather than to the phase.
 *
 * The round start is always a covered boundary — `transitionAround` defaults `wipe` to `true` and the round
 * start passes no option at all — which is why this is {@link moveDelay} called with `true` rather than a
 * parameter of its own.
 */
function playDelay(): number {
	return moveDelay(true) + ARENA_CONFIG.ARENA_FREEZE_SECONDS;
}

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
 * **And so is a rig, and that is a reversal of what stood here.** The paragraph this replaces said rigged
 * NPCs were on nobody's side and were left in the default colour. That was true while a rig could not play:
 * a rig now takes a side and fights a round (`npc/rigs.ts` reads the side off the rig, `RoundService` counts
 * it as a participant), so a viewer who cannot tell a rig on A from a rig on B — or from a practice dummy —
 * cannot follow a round that is half made of rigs. A rig is therefore painted with its side's colour, and the
 * rules it is painted under are worth stating here because they are not the player's:
 *
 * - **A rig is coloured exactly when the round is playing and it holds a valid side.** The `Team` attribute is
 *   a *seat* and not a state: it is painted in Studio or written by the pad and the respawn, and it stands
 *   through the intermission — `RoundService.assignTeams` clears a *player's* side at the next whistle and
 *   there is no equivalent write for a rig, because a rig's side is not the round's to clear. So the phase,
 *   not the attribute, is what separates "on a team right now" from "holds a seat on one".
 * - **A rig with no side is not painted**, which is what `sideOfRig`'s validation buys and what every
 *   practice dummy and every rig in a half-built map relies on: an unvalidated attribute anybody can write is
 *   not a side until it reads as one.
 * - **The colour arrives with the round's opening hold and leaves at the move back to the lobby** — see
 *   {@link followPhase}, which is where both edges are argued.
 *
 * **Balls are not painted**, and that half is unchanged: a ball is on nobody's side, and the default colour is
 * what tells one from a body that is playing. See {@link paintRig} for the rig half and {@link outlineColourFor}
 * for the player's.
 */
@Service()
export class OutlineService implements OnStart {
	/**
	 * Whether the rigs are wearing their side's colour — see {@link followPhase}.
	 *
	 * **A field rather than a question asked of the folder, because the answer is "the round is past its
	 * opening hold"**, which is not a fact anybody publishes: the phase goes out before the cover closes and
	 * before the hold begins, so the two edges below are timed against the round's own numbers instead. Every
	 * paint on the rig path reads this — the phase edges that set it, a rig arriving, a rig's side changing —
	 * so there is one answer rather than one per caller.
	 */
	private rigsPlaying = false;

	public onStart(): void {
		Players.PlayerAdded.Connect((player) => this.watch(player));

		// A player already in the game when this service started never fires the
		// added-signal, so the ones already here are walked rather than waited for. The
		// same scan-and-subscribe `NpcService` does for its tag, for the same reason.
		for (const player of Players.GetPlayers()) this.watch(player);

		// The two tags, found and watched by the same pair of mechanisms, and *dressed* differently: a rig
		// wears its side's colour as well as its outline, a ball wears the outline alone. The difference is a
		// callback rather than a second walk of the tag. See {@link watchTag}.
		this.watchTag(NPC_TAG, (instance) => this.dressRig(instance));
		this.watchTag(BALL_TAG, applyOutline);

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
	 * **The players are repainted on the edge itself and the rigs are not**, which is the one thing here a
	 * reader should know: a player in a round is dressed the moment the whistle goes, and a rig's colour
	 * waits on the round's own opening hold. {@link followPhase} is that second half.
	 *
	 * The paint at the end is not redundant with {@link watch}. A player already in the game when
	 * this service started was dressed before this method could run, and at that moment the folder
	 * may not have existed — so `outlineColourFor` read "no round" and drew them in the default
	 * colour. This is what corrects that once the round's channel is open.
	 *
	 * **The rigs get no equivalent paint at the end, and the gap is named rather than papered over.** A
	 * service that mounted with a round already past its hold would leave the rigs in the default colour
	 * until the next edge — but the round's own loop opens on an intermission (`RoundService.gameLoop`), so
	 * there is no such moment for it to mount in, and inventing a "how far into a round am I" read for a
	 * case that cannot happen is state with no owner.
	 */
	private followRound(): void {
		const status = ReplicatedStorage.WaitForChild(ROUND_STATUS_FOLDER);

		const repaintAll = () => {
			for (const player of Players.GetPlayers()) {
				const character = player.Character;
				if (character) paint(character, player);
			}
		};

		status.GetAttributeChangedSignal(ROUND_STATE_ATTRIBUTE).Connect(() => {
			repaintAll();
			this.followPhase();
		});
		// **The mode is watched for the assignment edge, not for the colour.** The colour no longer depends on
		// the mode — see `TEAM_COLORS` — but a round starting is what writes the mode, and that is the moment the
		// labels this paints from are written. It costs one repaint per round on a handful of highlights, which
		// is why it is kept rather than reasoned away. **Nothing here is needed for the rigs**: a rig's colour is
		// its side's, and no side depends on the mode.
		status.GetAttributeChangedSignal(ROUND_MODE_ATTRIBUTE).Connect(repaintAll);

		repaintAll();
	}

	/**
	 * The rigs' half of a phase change: **when they start wearing their side's colour, and when it comes off.**
	 *
	 * **A rig's colour is not the phase's, and the two delays are the whole of that.** A player is dressed at
	 * the whistle because the player *is* in the round from that instant. A rig is not: the whistle is followed
	 * by the cover, then the move into the arena, and then the hold — and a rig has none of the six behaviours
	 * that would let it act until the hold is over, which is the same constant `LobbyRigService` withholds them
	 * for. A rig painted at the whistle would be a rig standing at its pad in the lobby wearing its side, in
	 * plain sight — the lobby is *inside* the arena — and a rig painted at the move would be a team-coloured
	 * body standing inert for the whole hold, reading as a rig already playing. The colour therefore arrives
	 * with the *playing*, on {@link playDelay}'s clock.
	 *
	 * **And it leaves at the other boundary's move**, which is the instant the rigs are teleported back to the
	 * lobby. The phase leaves `Playing` *before* `RoundService.transitionAround` closes the cover, so stripping
	 * the colour on the edge itself would un-paint rigs standing in the arena for the length of the cover and
	 * in full view; waiting that cover out puts the strip on the same tick as `returnRigsToLobby`, behind the
	 * screens. The flag goes down at once either way — the phase is what decides whether the colour is allowed
	 * — and only the *paint* waits.
	 *
	 * **One timer per boundary, and neither is cancelled.** A round is a minute long and these are seconds, so
	 * there is no edge for a stale timer to land on; and both of them read {@link paintRigs}, which asks the
	 * current flag, so a timer that did fire out of turn would paint the answer that is true when it runs.
	 */
	private followPhase(): void {
		if (!isPlaying()) {
			this.rigsPlaying = false;
			task.delay(moveDelay(TRANSITION_CONFIG.WIPE_AT_ROUND_END), () => this.paintRigs());

			return;
		}

		task.delay(playDelay(), () => {
			this.rigsPlaying = true;
			this.paintRigs();
		});
	}

	/**
	 * Repaints every rig in the game — the whole-tag walk {@link dressRig} does one body at a time.
	 *
	 * **The `NPC` tag rather than `rigsOnASide`**, and that is the difference that matters: a rig that has
	 * lost its side has to go back to the default colour, and a list of rigs that hold a side cannot name it.
	 * The tag is the only list that holds both, and it is a handful of models.
	 */
	private paintRigs(): void {
		for (const instance of CollectionService.GetTagged(NPC_TAG)) {
			if (instance.IsA("Model")) paintRig(instance, this.rigsPlaying);
		}
	}

	/**
	 * Gives a rig its outline and its side's colour, and keeps the colour following the side.
	 *
	 * **The attribute is watched as well as the body, because a rig's side can arrive long after it does.** A
	 * placeholder spawned into the lobby walks to its pad and is given a side on arrival
	 * (`WalkToJoinPadBehavior`'s arrival branch), and a rig the round teleports in is given one inside the
	 * cover window (`LobbyRigService.moveWalkersToArena`) — so a colour applied once, when the rig appeared,
	 * would be the default colour for the whole life of the rig.
	 *
	 * **Nothing is remembered about the connection**, for the reason {@link watch} gives about the player's:
	 * the signal is on the rig and lives exactly as long as it does, and there are a handful of rigs. A rig's
	 * body is replaced on death (`RespawnBehavior` clones a template), and that replacement arrives through
	 * the tag signal above rather than through this connection — which is why a rig that dies and comes back
	 * mid-round is coloured again without anything here having to know a death happened.
	 *
	 * **An instance wearing the tag that is not a `Model` is left alone**, the same test `npc/rigs.ts` makes:
	 * a tag is a string anybody can put on anything.
	 */
	private dressRig(instance: Instance): void {
		if (!instance.IsA("Model")) return;

		applyOutline(instance);
		paintRig(instance, this.rigsPlaying);

		instance.GetAttributeChangedSignal(TEAM_ATTRIBUTE).Connect(() => paintRig(instance, this.rigsPlaying));
	}

	/**
	 * Outlines everything wearing `tag`: what is in the world now, and what arrives later.
	 *
	 * **One method for both tags, because the *arrival* is one problem twice** — a `Highlight` on the
	 * instance, once — and the only thing that differs between a rig and a ball is what else that instance
	 * needs doing to it afterwards: nothing for a ball, and a side's colour for a rig. That difference is the
	 * `dress` callback and not a second walk of the tag, so the pair of mechanisms below — the initial
	 * `GetTagged` and the added-signal — stays written once. Neither half is redundant: a rig or a ball tagged
	 * before this service started never fires the signal, and one tagged afterwards is never in the initial
	 * `GetTagged`.
	 *
	 * Balls churn through this constantly — a fresh one is welded into a hand on every
	 * throw — and that is fine. The signal fires, a highlight is created, and both go away
	 * with the ball; there is nothing to keep in step and nothing to pool.
	 */
	private watchTag(tag: string, dress: (instance: Instance) => void): void {
		for (const instance of CollectionService.GetTagged(tag)) dress(instance);

		CollectionService.GetInstanceAddedSignal(tag).Connect(dress);
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
 * Draws `target`'s outline in `colour` for as long as the caller needs it, and answers with the colour
 * it was wearing so the caller can put it back.
 *
 * **The one way something other than this service is allowed to repaint an outline, and it exists
 * because a `Highlight` cannot be duplicated.** The engine draws one outline per adornee: a second
 * `Highlight` on the same model is not two effects but an undefined choice between them — the decision
 * `AimTargetController` documents on the client, which is why *it* recolours rather than creates.
 * A server-side override has one advantage over that one: this file owns both the name and the lookup,
 * so a caller needs neither a second copy of the name nor a second implementation of the search.
 *
 * **Returned rather than remembered here**, because how long an override lasts is the caller's
 * question and not this file's: the aim glow releases its colour when the aim moves off a body, and the
 * freeze releases it when the body thaws. This service has nothing to keep in step for either of them.
 *
 * **A missing outline is a state and not an error**, for {@link paint}'s reason: a body that has not
 * been dressed has nothing to recolour, and the caller is told that by the `undefined` rather than
 * having to ask first. Nothing is created here to make an override possible — creating one would be the
 * second `Highlight` this whole arrangement exists to avoid.
 */
export function overrideOutlineColour(target: Instance, colour: Color3): Color3 | undefined {
	const highlight = findOutline(target);
	if (highlight === undefined) return undefined;

	const previous = highlight.OutlineColor;
	highlight.OutlineColor = colour;

	return previous;
}

/**
 * Puts an outline around `target`, once — in the default colour, which a player's side, or a rig's, may then
 * overpaint. See {@link paint} and {@link paintRig} for the two halves that decide what colour it should be.
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
	// Scope: Outline.paint — one highlight per character, respawns included.
	if (DEBUG_CONFIG.PROFILE) debug.profilebegin("Outline.paint");
	paintBody(character, player);
	if (DEBUG_CONFIG.PROFILE) debug.profileend();
}

/**
 * The body of {@link paint}, split off **only** so the scope above can wrap it.
 *
 * `paint` is a module-level function rather than a method, so there is nothing to rename but the function
 * itself; the name `paintBody` is internal and the exported/called name is unchanged. `OutlineService`'s
 * other paths (`applyOutline`, the breathing loop) are left alone: this is the one that a `CharacterAdded`
 * fires, so it is the one that can be repeated in the same frame by a respawn, and the band is there to
 * say whether that is where a hitch comes from.
 */
function paintBody(character: Model, player: Player): void {
	const highlight = findOutline(character);
	if (highlight === undefined) return;

	highlight.OutlineColor = outlineColourFor(player);
}

/**
 * Paints `rig`'s outline with the side it is playing for — or back to the default when it is not playing for
 * one.
 *
 * **`playing` is the caller's answer to "is this rig in a round right now", and it is passed in rather than
 * asked here because it is not a fact about the rig.** A rig's `Team` attribute is a *seat*: it is painted in
 * Studio, written by the pad on arrival, copied by the respawn, and it stands through the intermission —
 * `RoundService.assignTeams` clears a *player's* side at the next whistle and has no write for a rig, because
 * a rig's side is not the round's to clear. So the attribute answers "who would this rig play for", an answer
 * that is the same between rounds, while the phase *and* the round's opening hold answer "is it playing",
 * which is what a colour is a claim about. See {@link followPhase} for the two edges that decide it.
 *
 * **A rig with no side is not painted**, and the validation is `sideOfRig`'s rather than a second read of the
 * attribute here: a label that is not `"A"` or `"B"` is not a side, so a practice dummy — and a rig in a
 * half-built map wearing `Team = "Red"` — falls to the default colour, which is what "not on a side" looks
 * like everywhere else in this service.
 *
 * **Written only when the colour would change**, which is what makes the whole-tag repaint on a phase edge
 * cost nothing for the rigs that are already right, and what makes the line below a line about a *transition*
 * rather than about a walk. That line is worth having unasked: "did that rig get a colour, and which one" is
 * the whole of what this feature is judged on, and the Explorer cannot answer it for you.
 *
 * **What it deliberately does not do is ask whether somebody else is holding the colour.**
 * `FreezeService` writes this same property through `overrideOutlineColour` while a body is held in a block
 * of ice, and a repaint landing during a freeze would replace the ice colour with the side's. The two cannot
 * meet as this stands: the rig repaints are the two phase edges and a rig's own side changing, and nothing is
 * frozen at the instant the round's hold ends. It is named rather than guarded, because the guard would be a
 * lookup of "is this body frozen" in a service with no business knowing — and the freeze's restore is
 * unconditional, so the worst case is a held rig wearing its side's colour instead of the ice's for the rest
 * of its freeze, which is a cosmetic loss with a correct end.
 */
function paintRig(rig: Model, playing: boolean): void {
	const highlight = findOutline(rig);
	if (highlight === undefined) return;

	const side = playing ? sideOfRig(rig) : undefined;
	const colour = side !== undefined ? (teamColourOf(side) ?? OUTLINE_CONFIG.COLOR) : OUTLINE_CONFIG.COLOR;
	if (colour === highlight.OutlineColor) return;

	highlight.OutlineColor = colour;

	if (DEBUG) print(`[Outline] ${rig.Name}: ${side !== undefined ? `side ${side}` : "no side"}`);
}

/**
 * The colour `player`'s outline should be, right now.
 *
 * **Everything that cannot name a side lands on the default colour, and the lobby is the important
 * case.** Outside a round nobody has a side that means anything: `TEAM_ATTRIBUTE` still holds the side
 * a player finished the last round on — `RoundService.assignTeams` clears it, but at the *next* whistle
 * rather than at the last one, so it stands through the intermission — and a colour read from it between
 * rounds would be a claim about a game that is over. That is why the phase is checked *first* — and it
 * is also why waiting for a round looks exactly like waiting for one to end, which is the honest answer:
 * in neither of them is anybody on a team.
 *
 * The default is what a ball wears too — and what a rig wears whenever it is not playing for a side, which
 * is either a rig with no side or any rig between rounds. It means "not on a side", and it is what tells a
 * body that is playing from one that is not. **The rig's rule is not quite this one, and the difference is
 * worth knowing**: a rig wears its colour only once the round's opening hold is over, so it is a *rig* the
 * phase does not dress on the whistle — see {@link paintRig} and {@link followPhase}.
 */
function outlineColourFor(player: Player): Color3 {
	if (!isPlaying()) return OUTLINE_CONFIG.COLOR;

	const label = player.GetAttribute(TEAM_ATTRIBUTE);
	if (!typeIs(label, "string")) return OUTLINE_CONFIG.COLOR;

	return teamColourOf(label) ?? OUTLINE_CONFIG.COLOR;
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
