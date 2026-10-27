import { ContentProvider, ReplicatedStorage, SoundService } from "@rbxts/services";
import { AUDIO_CONFIG } from "shared/config/audio.config";
import { GAME_MODE_CONFIG } from "shared/config/gameMode.config";
import { ROUND_MODE_ATTRIBUTE, ROUND_SCORE_A_ATTRIBUTE, ROUND_SCORE_B_ATTRIBUTE, ROUND_STATE_ATTRIBUTE, ROUND_STATUS_FOLDER } from "shared/constants";
import { sideNameOf, isGameModeId } from "shared/gameMode";
import { pushNotification } from "./notifications";

/**
 * **The one line that tells a side the round is about to be taken away from it: `Warning: Team A is 15 points
 * ahead!`**
 *
 * **Why it exists.** `GAME_MODE_CONFIG.MERCY_RULE_LEAD` ends a Score Rush round the moment one side leads by twenty,
 * and a rule that ends a game without saying so is a rule that reads as the game breaking: the score is 20–0, the
 * screen cuts to the lobby, and nobody watching has been told that was coming. Five points of warning is a few
 * exchanges of play — enough to try something, and enough that the end reads as an ending rather than as a fault.
 *
 * **A plain module rather than a method on `ScoreHudController`, and the precedent is in `main.client.ts`.** The
 * score bar draws two numbers and its own doc is emphatic that it reads the pair "and nothing else", with no phase
 * and no mode. This is a *different sentence about the same fact*, and two subscribers to one fact is the accepted
 * shape here — `hitVfx` and `hitConfirm` read one event and the boot's own note says "neither should have to know
 * the other exists". Bolting a notification onto the readout would also mean the bar could no longer say it reads no
 * phase, which is a property worth more than the two subscriptions this costs.
 *
 * **Every client runs this, so both sides see it.** The losing side is the one it informs, but the leading side is
 * about to be handed a win it should be able to anticipate, and the alternative — publishing the warning from the
 * server as an attribute and drawing it for one side — would be a remote and a second copy of a rule for a sentence
 * the client can derive from two numbers it already has.
 *
 * **The toast is not the whole warning any more, and the split is deliberate.** A toast fades, and the state it
 * describes does not: the lead that triggered it stands for as long as the opponent fails to close it. So
 * `RoundStatusController` holds a line for as long as {@link mercyWarningFor} says the warning is standing, while
 * this file keeps the two things a line cannot do — the sound that makes a player look up, and the sentence with the
 * side's name in it. **The rule is shared and the presentation is not**, which is why the reader of that rule is
 * exported from here rather than copied into the band.
 *
 * **Nothing here ends anything.** The round is decided by `ScoreRushMode.outcome` on the server; this file only
 * chooses when to say so. A client that never ran would lose the warning and nothing else.
 */

/** The word `ROUND_STATE_ATTRIBUTE` carries while a round is being played. See `RoundService.gameLoop`. */
const PLAYING = "Playing";

/** A numeric attribute on the round's status folder, or `0` — the same reader `ScoreHudController` keeps. */
function scoreOf(folder: Instance, name: string): number {
	const value = folder.GetAttribute(name);

	return typeIs(value, "number") ? value : 0;
}

/** The mercy warning standing at a pair of scores: which side is ahead, and by how much. */
export interface MercyWarning {
	/** The side that is ahead, as the label the score attributes use. */
	readonly leading: "A" | "B";
	/** How far ahead, in points. Always inside the window, so `MERCY_WARNING_LEAD` or more. */
	readonly lead: number;
}

/**
 * **Whether the mercy warning is standing, and about whom — the rule, in one place, for both readers of it.**
 *
 * **There are two readers now and the first reason this is a function is that they must not disagree.** This module
 * announces the warning once, as a toast and a sound; `RoundStatusController` holds it on the HUD for as long as it
 * is true. Those are two different jobs on one fact, and the alternative — the band asking this module whether to
 * draw, the module deciding whether to speak — is two copies of a comparison that would drift the first time either
 * window moved. It is a plain export rather than a service because it is four lines and has no state.
 *
 * **The window is `[MERCY_WARNING_LEAD, MERCY_RULE_LEAD)`** — at or above fifteen, below twenty. The upper bound is
 * not decoration: a lead that has already reached the mercy threshold is a round about to end in the same second, and
 * a warning that the round is nearly over, shown as the round ends, is worse than silence. **Both numbers come from
 * the shared config**, so this cannot drift from the rule it warns about — and the rule itself is decided elsewhere,
 * by `ScoreRushMode.outcome` on the server, from the same `MERCY_RULE_LEAD`.
 *
 * **The lead is returned rather than assumed to be the threshold.** A warning fires on the write that carries the lead
 * across fifteen, and a score can cross it by more than one — a catch, a multi-hit exchange — so a caller that
 * announced `MERCY_WARNING_LEAD` verbatim would say "15 points ahead" while the scoreboard said 18. The pair of
 * numbers is passed in rather than a folder read here, so the caller keeps the attribute access and this stays a
 * function of the thing it is judging.
 */
export function mercyWarningFor(scoreA: number, scoreB: number): MercyWarning | undefined {
	const lead = math.abs(scoreA - scoreB);

	if (lead < GAME_MODE_CONFIG.MERCY_WARNING_LEAD) return undefined;
	if (lead >= GAME_MODE_CONFIG.MERCY_RULE_LEAD) return undefined;

	return { leading: scoreA > scoreB ? "A" : "B", lead };
}

/**
 * The warning's `Sound`: **one instance for the session, in `SoundService`, with every property applied in code.**
 *
 * **A fifth copy of these six lines, and that is named rather than hidden.** `MusicController` has a private
 * `makeSound`, `personalAudio` has the same function, `perfectDodge` has a third, and `elevation`, `ShopController`,
 * `ThrowController` and `ArenaFreezeCountdownController` each build their `Sound` inline. `perfectDodge`'s copy says
 * "if that pass ever happens, this is the file to start from" — this one is written to match it, because consolidating
 * seven is a pass of its own that touches files this change has no business in.
 *
 * **`SoundService` rather than `PlayerGui`**, for that function's reason: a `Sound` is positional only when it hangs
 * off a `BasePart` or an `Attachment`, and `PlayerGui` is rebuilt on every respawn while this instance is made once
 * for the session.
 *
 * **Made once and restarted, not made per warning.** A warning fires at most once a round, so a per-warning instance
 * would be one construction per round — cheap — but a *fresh* `Sound` has not been preloaded, so the first warning of
 * a session could arrive late or silently, which for a five-point notice is the whole cue missed. One instance made
 * at boot is also what lets the client's own `PreloadAsync` in `onStart` have something to fetch.
 *
 * **`Looped = false` and `PlaybackSpeed = 1` stated rather than defaulted**, as every sibling does: the loop is the
 * one that would be a bug rather than a preference — an alarm that kept sounding after the round ended would be the
 * worst thing in this file — and the speed is written because the charge sound is the one client clip that derives
 * its speed from a mechanic.
 */
function makeSound(): Sound {
	const sound = new Instance("Sound");
	sound.Name = "MercyWarning";
	sound.SoundId = AUDIO_CONFIG.MERCY_WARNING;
	sound.Looped = false;
	sound.PlaybackSpeed = 1;
	sound.Volume = AUDIO_CONFIG.MERCY_WARNING_VOLUME;
	sound.Parent = SoundService;

	return sound;
}

/**
 * Plays the warning's clip from the beginning.
 *
 * **`Stop` before `Play`**, for `personalAudio.play`'s reason even though the trigger here is once a round: the rule
 * is one line and a second copy that skipped it would be a copy somebody later copies from. There is nothing to
 * restart in practice — `hasWarned` guarantees one firing per round and a round outlasts any clip — but the pair is
 * the house shape and the cost of it is a `Stop` on a silent sound.
 *
 * **No `Ended` cleanup.** The instance belongs to `SoundService` for the life of the client; destroying it would mean
 * building an unpreloaded one for the next round, which is the late-clip fault {@link makeSound} exists to avoid.
 */
function play(sound: Sound): void {
	sound.Stop();
	sound.Play();
}

/**
 * **Wires the warning to the two score attributes. Called once, from the client's boot.**
 *
 * **Three attributes are read, and the third is what makes "once per round" honest.** The scores say *whether* the
 * lead is there; `ROUND_STATE_ATTRIBUTE` says *which round it is in* — and, crucially, gives an unambiguous edge to
 * reset on. Deriving the reset from the scores falling to nought was the obvious alternative and it is not safe: the
 * server clears both attributes as a round ends and the two writes replicate separately, so a client can see
 * `A = 0` beside a stale `B = 15` and compute a fifteen-point lead out of a round that is over. **The phase is
 * written once per boundary and cannot be observed half-applied**, so it is the edge used here.
 *
 * **`hasWarned` is a plain local rather than state on the controller**, because there is exactly one of these per
 * client and it is the lifetime of the module. It is reset when a `Playing` phase is published, which is the moment
 * the scores for the round it describes have already been cleared.
 *
 * **The window itself is {@link mercyWarningFor}'s, and this function only asks it.** The bounds and the argument for
 * them used to be written here; they moved when the round-status band started reading the same rule, so that the
 * sentence a player hears and the line a player can see for the rest of the round cannot disagree about when the
 * warning is standing. Two copies of `[MERCY_WARNING_LEAD, MERCY_RULE_LEAD)` would be two things to keep in step.
 *
 * **Spawned rather than inline**, because the status folder is made by the *server* and waiting for it yields — the
 * same reason every other plain module in the boot defers its own mount.
 */
export function startMercyWarning(): void {
	task.spawn(() => {
		const folder = ReplicatedStorage.WaitForChild(ROUND_STATUS_FOLDER);

		// **The clip is made before the first round can need it, and asked for by name.**
		// `ContentProvider:PreloadAsync` on the instance rather than on the id, because the `Sound` already references
		// it — this starts no fetch of its own, it only asks to be told when the one that mounting began has finished.
		// The alternative is the fault `personalAudio` records for the ball pickup: a warning is a *five-point* notice,
		// and a clip that arrives after the enemy has already scored twice more has warned nobody.
		const sound = makeSound();

		ContentProvider.PreloadAsync([sound], (contentId, status) => {
			if (status !== Enum.AssetFetchStatus.Success) {
				warn(`[Audio] mercy warning did not load — ${contentId} (${status.Name})`);
			}
		});

		/** Whether this round has already been warned about. Cleared at every `Playing` edge. */
		let hasWarned = false;

		const refresh = () => {
			if (folder.GetAttribute(ROUND_STATE_ATTRIBUTE) !== PLAYING) return;

			const warning = mercyWarningFor(scoreOf(folder, ROUND_SCORE_A_ATTRIBUTE), scoreOf(folder, ROUND_SCORE_B_ATTRIBUTE));

			if (warning === undefined) return;
			if (hasWarned) return;

			hasWarned = true;

			// **The leading side is named**, because "somebody is fifteen ahead" is a sentence a player has to look at
			// the scoreboard to finish. The name comes from the shared mode table rather than from a hard-coded
			// "Team A", so a mode that calls its sides something else is still right — and the mode id is read here
			// rather than subscribed to, because it is only needed at the instant this line is built.
			//
			// **The figure is the lead that is standing, not `MERCY_WARNING_LEAD`.** The warning fires on the write
			// that carries the lead across fifteen, and a write can carry it across by more than one — announcing the
			// constant there would have this line say fifteen while the scoreboard beside it said eighteen.
			const mode = folder.GetAttribute(ROUND_MODE_ATTRIBUTE);
			const name =
				typeIs(mode, "string") && isGameModeId(mode)
					? sideNameOf(mode, warning.leading)
					: `Team ${warning.leading}`;

			pushNotification(`Warning: ${name} is ${warning.lead} points ahead!`);

			// **The sound and the line are one announcement, written as two statements with nothing between them.**
			// `pushNotification` builds its label and starts a fade synchronously and `Play` starts the clip on the same
			// tick, so the two land on the same frame — `perfectDodge`'s pairing, and the order here is the reading order
			// of the sentence: the thing you read, then the thing you hear. The sound is what makes a player who is
			// watching the ball rather than the corner of the screen look up at all.
			play(sound);
		};

		// **The phase first, and its handler resets before it asks.** A `Playing` publish is a new round, so the flag
		// has to be clear before any score of that round is considered — which is why the reset is in this handler
		// rather than inside `refresh`, where it would be a branch every score change has to pass through.
		folder.GetAttributeChangedSignal(ROUND_STATE_ATTRIBUTE).Connect(() => {
			if (folder.GetAttribute(ROUND_STATE_ATTRIBUTE) === PLAYING) hasWarned = false;

			refresh();
		});

		// **The score handlers defer by one resumption point, and the reason is a pair of writes that is not a pair on
		// the wire.** `RoundService.publishScores` sets both score attributes back to back, but attributes replicate
		// one at a time and `GetAttributeChangedSignal` fires once per attribute — so a handler that read immediately
		// could catch the pair with one of the two writes applied. Concretely: a dev setting `A 15` and `B 20` from a
		// standing start would, if the `A` write landed first, be read as `A 15, B 0` — a fifteen-point lead that never
		// existed — and the warning would fire for a state the server never held.
		//
		// **`hasWarned` is what makes that worse than a stray toast.** The flag latches once a round, so a transient
		// read does not just print a wrong sentence, it spends the round's only warning and the real one at twenty
		// never arrives. One deferred frame costs nothing against a five-point notice and makes the read independent
		// of which write lands first. The phase handler above stays immediate: it resets a flag and writes nothing,
		// and the boundary it watches is a single attribute.
		folder.GetAttributeChangedSignal(ROUND_SCORE_A_ATTRIBUTE).Connect(() => task.defer(refresh));
		folder.GetAttributeChangedSignal(ROUND_SCORE_B_ATTRIBUTE).Connect(() => task.defer(refresh));

		refresh();
	});
}
