import { Controller, OnStart } from "@flamework/core";
import Fusion from "@rbxts/fusion-3.0";
import { ContentProvider, ReplicatedStorage, RunService, SoundService } from "@rbxts/services";
import { AUDIO_CONFIG } from "shared/config/audio.config";
import { ROUND_STATE_ATTRIBUTE, ROUND_STATUS_FOLDER, ROUND_TIME_ATTRIBUTE } from "shared/constants";

/** Prints the mount line, every cue, and one line per fade boundary. The lines the Studio acceptance run reads. */
const DEBUG = true;

/**
 * The two phases this controller cares about, spelled out.
 *
 * **Copied rather than imported**, for the reason `BallSpawnerService` and `OutlineService` copy them: the
 * phase goes out as its own *name*, and those names are `RoundState`'s members by convention rather than by
 * construction — so there is no constant to import and this is the fourth file to spell it out. See
 * `RoundStatusController`, which is the HUD doing the same thing.
 *
 * **`Playing` is the new half of the pair, and the test it makes is not the same test.** The round's three
 * sounds are keyed on `Playing` rather than on "not the intermission", because those answer different
 * questions: anything that is not an intermission would otherwise start the round's music, on the strength
 * of a word that has not been published yet. Only one phase means a round is being played, so only one
 * comparison can be allowed to mean it. See {@link roundVolume}.
 */
const PLAYING = "Playing";
const INTERMISSION = "Intermission";

/**
 * A clock's last few seconds expressed as a volume — the whole of both fades, as a pure function.
 *
 * Linear, and linear on purpose rather than for want of a better idea. A curve would be smoother — a
 * real fade-in is usually closer to exponential, because loudness is perceived logarithmically — but the
 * honest reading of "fade over five seconds" is a ramp, and a curve here would be a second opinion nobody
 * asked for that also makes the boundary harder to check. What matters is that it is **continuous at both
 * ends**: a clock at or above `window` gives exactly full volume, and a clock at 0 gives exactly zero, so
 * there is no step at the point a player is listening for one.
 *
 * **Clamped at the bottom and trusted at the top, which is not an oversight.** The clock is a number from
 * another machine and a negative one would read as a negative volume, which is undefined behaviour rather
 * than silence; above the window the comparison below has already returned.
 *
 * **One function for both tracks, so the two fades cannot drift apart.** They are the same shape over
 * different windows and different bases — the intermission's cue to a round starting, and the round's cue
 * to it ending — and a second copy of this arithmetic is exactly where an off-by-one would live: in the
 * one place nobody looks, because each copy reads correctly on its own.
 */
function ramp(base: number, remaining: number, window: number): number {
	const left = math.max(remaining, 0);

	if (left > window) return base;

	return base * (left / window);
}

/**
 * The intermission track's volume for the current moment.
 *
 * **The entry ramp is folded into the base rather than tested before it, so the two fades compose as a
 * product.** Both windows can be read at once — the ramp is unfinished while the clock still says a large
 * number — and a product is the only composition that keeps both ends exact: at full ramp it is the clock's
 * fade alone, and at either extreme it is zero however incomplete the other term is. An ordering that
 * checked the ramp first and returned early would suspend the fade out for the length of the ramp, which is
 * invisible at today's numbers (2 seconds against a 30-second intermission, and the fade out only starts at
 * 5) and is the difference between "reaches silence" and "reaches a third of the way down" the day somebody
 * shortens an intermission. **The round's fade reads the same way**, so there is one rule in this file
 * rather than two that happen to agree.
 *
 * **The clock drives the fade out and a stopwatch drives the fade in, which is not a contradiction.**
 * The fade out has to freeze when the intermission freezes — see {@link MusicController}'s note on
 * tweens — because it is counting down to something that can be postponed. The fade in is over in
 * the first two seconds of an intermission that has just *begun*, and beginning is not something the
 * clock can postpone: a server that freezes has music, and music arriving smoothly is right whether
 * or not the countdown is moving.
 *
 * @param phase The round's phase, as `RoundService` publishes it.
 * @param time The phase's clock, in seconds remaining.
 * @param fadeInProgress 0 at the moment the intermission begins, 1 once the entry ramp is done — and
 * 1 for a player who was not there to see it begin. See {@link MusicController.mount}.
 */
function intermissionVolume(phase: string, time: number, fadeInProgress: number): number {
	if (phase !== INTERMISSION) return 0;

	return ramp(
		AUDIO_CONFIG.INTERMISSION_MUSIC_VOLUME * fadeInProgress,
		time,
		AUDIO_CONFIG.INTERMISSION_FADE_OUT_SECONDS,
	);
}

/**
 * The round track's volume for the current moment: up from silence at the start of a round, and back down
 * to it over the last {@link AUDIO_CONFIG.ROUND_FADE_SECONDS} of the round's clock.
 *
 * **It fades in, and this reverses what stood here.** The argument was that the track needed no ramp
 * because a round beginning is already unmistakable — the arena is moved and everybody is held still — so
 * a ramp would be a second cue for an event that has one. **That was wrong about what this track is.** It
 * is a room full of people, and a room that is suddenly there at full volume reads as a *sting*: something
 * has happened. Ramping it up reads as the room filling, which is what a round starting is, and it is the
 * only cue a player gets that the round has begun before anything has happened in it. The old argument is
 * kept here rather than deleted, because the shape of it — "the event already has a cue" — is worth
 * recognising the next time it comes up about a sound, and is sometimes right.
 *
 * **The two fades compose as a product, in the same shape {@link intermissionVolume} uses.** They cannot
 * both be partly through at today's numbers — five seconds in against a hundred and fifty out — but
 * composing them rather than ordering them is what keeps "silent at the start" and "silent at the end"
 * true at *any* round length, including a dev's three-second one. See that function for the argument; the
 * rule is deliberately the same in both, not copied twice into two places that could drift.
 *
 * **Keyed on `Playing` and not on "not the intermission"**, which is the whole reason {@link PLAYING}
 * exists in this file. A phase this controller has never heard of — a lobby, a warm-up, a word added to
 * `RoundState` next month — gets no round music, which is the safe direction to be wrong in. The
 * alternative default would put a round's track over whatever that phase turns out to be, and the only
 * thing that would notice is a player hearing music at the wrong time.
 */
function roundVolume(phase: string, time: number, fadeInProgress: number): number {
	if (phase !== PLAYING) return 0;

	return ramp(AUDIO_CONFIG.ROUND_MUSIC_VOLUME * fadeInProgress, time, AUDIO_CONFIG.ROUND_FADE_SECONDS);
}

/**
 * The round's audio: two tracks, a countdown and a whistle, one `Sound` each per client.
 *
 * **Nothing here is sent anywhere.** Every client runs this controller, makes its own four `Sound`s, and
 * decides its own volumes from `ReplicatedStorage`'s two attributes — the same two the HUDs already read.
 * There is no remote, no server-side sound, and nothing to keep in step: the phase and the clock *are* the
 * channel. See `sound.config.ts`, which is the other audio in this game and is the opposite case — six ids
 * a *server* hands to `SoundEmitter` and plays at a position in the world.
 *
 * **The two tracks point in opposite directions, and that is the shape of the file.** The intermission
 * track fades *out* over the last five seconds of the intermission: it is the music a player hears while
 * nothing is happening, and it leaves as a cue to get ready. The round track plays for the length of a
 * round and fades out over its last five seconds, with the countdown beeping over it. Every cue here is
 * driven by the same clock, which is what makes them line up without anybody keeping them in step.
 *
 * **The fades follow the clock and not the wall clock, and that is the whole reason none of this is a
 * `TweenService` tween.** A phase can be *held* — a server below `MIN_PLAYERS`, or a dev with rounds
 * paused — and while it is held the clock does not move. A tween runs on real time regardless: it would
 * keep fading through the freeze, reach silence, and then sit in silence while the HUD said there were
 * still several seconds to go. Reading `ROUND_TIME_ATTRIBUTE` means every fade **freezes with the clock**,
 * at whatever volume it had reached, and resumes with it. **Do not "simplify" any of this into a tween.**
 *
 * **A joining player hears the moment they joined, not the fade they missed.** The values are seeded from
 * the attributes as they are *now*: a player who arrives mid-intermission gets the volume that clock
 * implies and no entry ramp, one who arrives mid-round gets the round's track already playing at the
 * volume *its* clock implies, and one who arrives during a fade hears it where it is. Being present for a
 * fade is the only way to hear it begin, and nothing here pretends otherwise.
 *
 * **The round's track is stopped rather than left silent; the intermission's is not.** Both are
 * `Looped = true`, and both play at zero volume whenever their phase is not the current one — so for the
 * length of a round there is a silent `Sound` looping in `SoundService` that nobody will ever hear. The
 * round's is `Stop()`ped the moment the round ends. **The difference is one `if`, and it is here rather
 * than fixed because that would be this change deciding something about the intermission's track** — the
 * argument for starting it once and never again is in `mount`, and it is a real argument about a track
 * restarting from the top. A reader who wants the two consistent now knows where to look.
 */
@Controller()
export class MusicController implements OnStart {
	public onStart(): void {
		// Spawned rather than done inline: mounting waits for the round folder, and a controller's
		// `onStart` is the wrong place to hold up the rest of the client's boot.
		task.spawn(() => this.mount());
	}

	private mount(): void {
		const status = ReplicatedStorage.WaitForChild(ROUND_STATUS_FOLDER);
		const scope = Fusion.scoped();

		// **Seeded from the attributes as they are now, not left at a default.** The folder exists
		// before this runs and already carries both values, so reading them here is what makes a
		// joining player's first frame correct rather than the first *change* correct — the pattern
		// `RoundStatusController` uses, for the same reason it documents.
		const initialPhase = status.GetAttribute(ROUND_STATE_ATTRIBUTE);
		const initialTime = status.GetAttribute(ROUND_TIME_ATTRIBUTE);

		// An unset phase reads as `""`, which is neither of the two words this file knows and so plays
		// nothing. Silence is the safe direction to be wrong in: the alternative default would put
		// music over a round.
		const phase = Fusion.Value(scope, typeIs(initialPhase, "string") ? initialPhase : "");
		const time = Fusion.Value(scope, typeIs(initialTime, "number") ? initialTime : 0);

		// **The entry ramp, armed by the phase *changing* and by nothing else.** A player who mounts
		// into an intermission that is already running never sees a transition, so this starts at 1
		// and stays there: they hear the music that is playing, not a fade in they were not present
		// for. Accumulated from `Heartbeat`'s own delta rather than read from a clock — see the tick.
		// **Annotated `number` rather than inferred, and that is not decoration.** `AUDIO_CONFIG` is
		// `as const`, so these identifiers' values are literal types — `2` and `5` — and without the
		// annotation each variable would take its literal and every assignment to it, the reset at its own
		// phase edge and the accumulation in the tick, would be an error against it.
		let fadeInElapsed: number = AUDIO_CONFIG.INTERMISSION_FADE_IN_SECONDS;

		// **A second ramp for the round's track, and a separate variable rather than one shared ramp.**
		// The two belong to different phases and are armed by different edges. An intermission ending and a
		// round beginning are the same instant, so the *edges* cannot overlap — but the ramps can, and do,
		// for five seconds: a dev forcing a match while the intermission's music is still coming back would
		// have one accumulator restarted by the round while the intermission's track was still reading it.
		// One variable would then be two fades fighting over one number, which is the failure this file's
		// notes about `SoundGroup`s and `Sound` ownership keep coming back to.
		//
		// **Seeded *complete* rather than at zero**, which is the joining-player rule: a client that mounts
		// into a round that is already running must hear the ambience at the volume it has reached, not a
		// fade-in it was not there for. The phase edge below sets it to zero, so the ramp belongs to the
		// round *starting* and to nothing else. See {@link AUDIO_CONFIG.ROUND_FADE_IN_SECONDS}.
		let roundFadeInElapsed: number = AUDIO_CONFIG.ROUND_FADE_IN_SECONDS;

		// The phase as last seen, so a *change* can be told from a phase that was already this one.
		let lastPhase = Fusion.peek(phase);

		/**
		 * The last whole second the countdown beeped for, and the whole of the guard against the same
		 * second beeping twice.
		 *
		 * **`undefined` means "nothing has beeped in this round yet"**, which is what makes the first low
		 * reading of a round beep rather than be compared against a number left over from the last one.
		 *
		 * **Nothing seeds it, and that is the mid-round-join case answered rather than dodged.** A player
		 * who joins with seven seconds to go must not hear a beep for the seven they missed; starting
		 * `undefined` gets that for free, because the next change is to six, six is not `undefined`, and
		 * six beeps. Seeding it from the current reading would have to be right about the same thing by a
		 * different route, and would be wrong for a client whose first reading arrives in the same
		 * replication batch as the phase change rather than after it.
		 *
		 * **Why a guard is needed at all, given the attribute only changes once a second.** Because
		 * "changed" is a claim about replication rather than about the clock: a re-publish of the same
		 * value, a reconnect, a first delivery that counts as a change — any of those can present the same
		 * integer twice, and a beep is a *cue*, so hearing one twice for one second is worse than missing
		 * it. The comparison is exact because the values are whole seconds, which is what the attribute
		 * publishes.
		 */
		let lastBeepSecond: number | undefined = undefined;

		// The last volume written to each track, so the per-frame loop can skip identical writes. See the
		// tick for why that matters. `-1` rather than the track's real starting volume, so the first frame
		// writes whatever the phase and clock actually imply.
		let writtenIntermission = -1;
		let writtenRound = -1;

		// **Four `Sound`s, made once and never made again.** Once per client for the session rather than
		// once per round: a `Sound` rebuilt at a round's start would restart the track from the top
		// whenever the phase flickered, and would leave an instance per round in a service nothing cleans.
		//
		// **`SoundService` and not `PlayerGui`.** A `Sound`'s positional behaviour — `RollOff`,
		// `EmitterSize` — applies when it is parented to a `BasePart` or an `Attachment`; anywhere else it
		// is heard at one volume from anywhere, which is what a piece of music and a referee's whistle are.
		// `PlayerGui` would work for the same reason and is worse: it is torn down and rebuilt on a
		// respawn, which is exactly what an instance created once must not be sitting inside. The server's
		// impact sounds are parented to a throwaway part on purpose — they *are* a place. These are the
		// opposite case and the opposite parent, and that is the whole of the difference.
		//
		// **The four are under `SoundService` together and under no `SoundGroup`, which is deliberate.**
		// A `SoundGroup` would be a shared volume multiplier, and the one thing the round-end edge must not
		// have is the whistle and the track arguing over a number neither of them owns. They are four
		// independent instances; the engine mixes them, and nothing here has to.
		const intermissionMusic = this.makeSound("IntermissionMusic", AUDIO_CONFIG.INTERMISSION_MUSIC, true, 0);
		const roundMusic = this.makeSound("RoundMusic", AUDIO_CONFIG.ROUND_MUSIC, true, 0);

		// The two cues are at a fixed volume and are never faded — they are *events*, not beds, and a cue
		// that fades is a cue nobody hears. The overlap with the tracks is handled by them being louder
		// than the tracks rather than by ducking, which is argued in `audio.config.ts` beside their
		// volumes.
		const beep = this.makeSound(
			"CountdownBeep",
			AUDIO_CONFIG.COUNTDOWN_BEEP,
			false,
			AUDIO_CONFIG.COUNTDOWN_BEEP_VOLUME,
		);
		const whistle = this.makeSound(
			"RoundWhistle",
			AUDIO_CONFIG.ROUND_WHISTLE,
			false,
			AUDIO_CONFIG.ROUND_WHISTLE_VOLUME,
		);

		// **The intermission track is started once, at zero volume, and never started again**: the volume
		// is the only thing that changes from here, which is what makes its fade a fade rather than a run
		// of restarts. `Play` before the asset has arrived is not a mistake — the engine plays it when it
		// can — and the preload below is what makes "when it can" mean the next frame rather than several
		// seconds into an intermission that may already be over.
		//
		// **The round's track is the one that is not started here**, because a client can mount into a
		// round that is already playing: that case is the seed below, and it starts the track the same way
		// the phase edge does.
		intermissionMusic.Play();

		if (Fusion.peek(phase) === PLAYING) {
			// **A joining player hears the round they joined**, at the volume its clock implies — full for
			// a round that has just started, partway down for one that is nearly over. Nothing is sent
			// anywhere to make this true; it is one read of an attribute the HUD is already reading, and
			// the expression is the same one the phase edge uses, so a round is started identically
			// whether this client was there for the beginning or not.
			//
			// **`1` for the ramp, not `0`, and that is the whole of the difference from the phase edge.**
			// The ramp belongs to the round *beginning*, and a client that arrives in the middle of one
			// missed that — what it should hear is the room as it already is. See where
			// `roundFadeInElapsed` is declared for the same rule stated once.
			writtenRound = roundVolume(PLAYING, Fusion.peek(time), 1);
			roundMusic.Volume = writtenRound;
			roundMusic.Play();

			if (DEBUG) print(`[Music] mounted into a round — round audio up at ${string.format("%.2f", writtenRound)}`);
		}

		ContentProvider.PreloadAsync([intermissionMusic, roundMusic, beep, whistle], (contentId, status_) => {
			if (status_ !== Enum.AssetFetchStatus.Success) {
				warn(`[Music] sound did not load — ${contentId} (${status_.Name})`);
			} else if (DEBUG) {
				print(`[Music] sound loaded — ${contentId}`);
			}
		});

		scope.push(
			status.GetAttributeChangedSignal(ROUND_STATE_ATTRIBUTE).Connect(() => {
				const value = status.GetAttribute(ROUND_STATE_ATTRIBUTE);
				if (!typeIs(value, "string")) return;

				// **The intermission's edge: the entry ramp, unchanged.**
				if (value === INTERMISSION && lastPhase !== INTERMISSION) {
					fadeInElapsed = 0;

					if (DEBUG) {
						print(`[Music] ${INTERMISSION} — fading in over ${AUDIO_CONFIG.INTERMISSION_FADE_IN_SECONDS}s`);
					}
				}

				// **The round's edge, and the only place the round's three sounds change state.** Both
				// halves are keyed on `Playing` itself rather than on "not the intermission", so a phase
				// this file has never heard of neither starts nor stops anything — see `roundVolume`.
				if (value === PLAYING && lastPhase !== PLAYING) {
					// **A new round, so the countdown starts again from nothing.** Without this the guard
					// would still be holding the previous round's last second, and a round whose clock
					// reached `1` last time would be silent on its way to `1` this time.
					lastBeepSecond = undefined;

					// **And the room comes up from silence over its own ramp**, which is the cue this change
					// is about: the phase flips, the arena is held still, and the ambience rises underneath
					// for five seconds. Armed *here* and not at mount, which is what makes the ramp belong
					// to a round starting rather than to a client connecting.
					roundFadeInElapsed = 0;

					// Stopped as well as started: a dev forcing a match immediately after an early end
					// would otherwise hear the last round's whistle over the first seconds of this one.
					whistle.Stop();

					// **The volume the ramp implies right now, which is exactly zero.** The track therefore
					// starts inaudible and the tick below brings it up, so there is no frame of full-volume
					// ambience before the fade begins — which is the whole of what the fade is for. `writtenRound`
					// is set to the same number so the tick's first frame is not a write of a value the
					// property already holds.
					writtenRound = roundVolume(PLAYING, Fusion.peek(time), 0);
					roundMusic.Volume = writtenRound;
					roundMusic.Play();

					if (DEBUG) {
						print(`[Music] ${PLAYING} — round audio rising over ${AUDIO_CONFIG.ROUND_FADE_IN_SECONDS}s`);
					}
				}

				if (lastPhase === PLAYING && value !== PLAYING) {
					// **The two that must not survive the end go first, and the whistle goes last.** The
					// order is not cosmetic: the whistle is the sound that says the round is over, and
					// starting it before the others have stopped would put it over the top of the thing it
					// is announcing.
					//
					// The beep is stopped rather than merely left un-triggerable because one may be *in
					// flight*: the cue for the second the round died on could be a few hundred milliseconds
					// into its clip, and "neither the music nor the beep survives a round ending" is the
					// requirement, not "the beep never starts again".
					beep.Stop();
					roundMusic.Stop();

					// **No fade here, and none is needed for the two kinds of end to come out right.** A
					// round the clock ended has already faded to exactly zero — that is what the last five
					// seconds of `roundVolume` do — so stopping it is inaudible. A round ended early by an
					// elimination or a disconnect stops wherever it was, at volume, which is the abrupt cut
					// the cue sheet asks for.
					//
					// **Nothing distinguishes the two cases, because nothing has to.** The fade is only ever
					// the clock's work, so the volume at this moment already *is* which kind of end it was —
					// and it is printed for that reason, so a reader of the log can tell without a branch
					// existing to tell them.
					whistle.Play();

					if (DEBUG) {
						print(`[Music] ${value} — music out at ${string.format("%.2f", writtenRound)}, whistle`);
					}
				}

				lastPhase = value;
				phase.set(value);
			}),
		);

		scope.push(
			status.GetAttributeChangedSignal(ROUND_TIME_ATTRIBUTE).Connect(() => {
				const value = status.GetAttribute(ROUND_TIME_ATTRIBUTE);
				if (!typeIs(value, "number")) return;

				time.set(value);

				// **The beep, on the clock's own change signal and on nothing else.** This is the one
				// subscription on the client that already fires exactly once a second, which is the rate
				// the cue is defined at — so it rides the channel rather than polling it, and a second
				// loop counting seconds alongside the clock would be a second answer to one question.
				//
				// **The phase gate comes first, and it is a gate rather than a formality.** The
				// intermission's clock is published on this same attribute and counts down through the
				// same low numbers, so without it every intermission would finish with ten beeps. The
				// reading used is the phase this client currently holds; the two attributes are written
				// separately at a round's end, about a tick apart — the intermission's first clock write
				// follows its phase change by a whole second — so a client is not in danger of mistaking
				// one for the other, and the cost if it ever did is one beep.
				if (Fusion.peek(phase) !== PLAYING) return;

				// **The window: inclusive at the top, exclusive at the bottom.** Ten beeps — the clock
				// reading 10, 9 … 1. Zero does not beep, because at zero the round is over rather than
				// about to be, and the round-end edge has its own cue; one cue per event rather than two.
				if (value > AUDIO_CONFIG.COUNTDOWN_SECONDS || value <= 0) return;

				// **The guard.** Nothing is remembered but the last second that beeped, so this is a
				// comparison rather than a count, and it is reset by the phase edge rather than here.
				if (value === lastBeepSecond) return;

				lastBeepSecond = value;
				beep.Play();

				if (DEBUG) print(`[Music] ${value}s left — beep`);
			}),
		);

		/**
		 * The volumes, once per frame.
		 *
		 * **`Heartbeat` rather than a throttled loop, and the reason is the intermission's fade in.** Both
		 * fade *outs* move in five steps because the clock does — one second per value, which is what
		 * "driven by the phase's clock" means, and a staircase is the honest shape of it. The fade in has
		 * no clock to be driven by, so it is driven by this loop, and a 10 Hz loop would give it ten steps
		 * of a twentieth of the volume each, which is audible on a sustained track. Per frame costs two
		 * comparisons and an add when nothing is happening.
		 *
		 * **Each property is written only when its number changes**, which is what makes a per-frame
		 * connection cheap here: for the whole of a phase outside the fade windows the answer is the same
		 * every frame and nothing is written at all. The comparison is exact rather than approximate
		 * because the inputs are — the same phase and the same clock reading recompute the same float, and
		 * a fade that is settling does so at the same rate in both.
		 *
		 * **One connection for both tracks**, because they read the same two values: two connections would
		 * subscribe to one question twice, and the second would be where a reader looked for a difference
		 * that does not exist.
		 */
		scope.push(
			RunService.Heartbeat.Connect((delta) => {
				if (fadeInElapsed < AUDIO_CONFIG.INTERMISSION_FADE_IN_SECONDS) {
					fadeInElapsed = math.min(fadeInElapsed + delta, AUDIO_CONFIG.INTERMISSION_FADE_IN_SECONDS);
				}

				// **The round's ramp, advanced on the same tick and by the same rule** — a stopwatch rather
				// than the clock, for the reason the intermission's is: the beginning of a phase is not
				// something the clock can postpone, so a ramp driven by the round's clock would stall at
				// whatever fraction it had reached the moment a dev held rounds up, and the ambience would
				// sit at a third of its volume for as long as the hold lasted.
				if (roundFadeInElapsed < AUDIO_CONFIG.ROUND_FADE_IN_SECONDS) {
					roundFadeInElapsed = math.min(roundFadeInElapsed + delta, AUDIO_CONFIG.ROUND_FADE_IN_SECONDS);
				}

				const progress = math.min(fadeInElapsed / AUDIO_CONFIG.INTERMISSION_FADE_IN_SECONDS, 1);
				const roundProgress = math.min(roundFadeInElapsed / AUDIO_CONFIG.ROUND_FADE_IN_SECONDS, 1);
				const currentPhase = Fusion.peek(phase);
				const remaining = Fusion.peek(time);

				const wantedIntermission = intermissionVolume(currentPhase, remaining, progress);

				if (wantedIntermission !== writtenIntermission) {
					// The boundary worth a line, because it is the one the acceptance test listens for:
					// the clock reaching the fade window with the music still up. Printed on the edge
					// rather than per step, and only when the fade actually begins.
					if (
						DEBUG &&
						currentPhase === INTERMISSION &&
						remaining === AUDIO_CONFIG.INTERMISSION_FADE_OUT_SECONDS &&
						wantedIntermission < writtenIntermission
					) {
						print(`[Music] ${AUDIO_CONFIG.INTERMISSION_FADE_OUT_SECONDS}s of intermission left — fading out`);
					}

					writtenIntermission = wantedIntermission;
					intermissionMusic.Volume = wantedIntermission;
				}

				const wantedRound = roundVolume(currentPhase, remaining, roundProgress);

				if (wantedRound === writtenRound) return;

				// The round's own boundary, in the shape of the line above. Not printed for a track that
				// is not playing: `roundVolume` answers 0 the moment the phase leaves `Playing`, which is
				// a change worth writing to the property and not worth announcing.
				if (
					DEBUG &&
					currentPhase === PLAYING &&
					remaining === AUDIO_CONFIG.ROUND_FADE_SECONDS &&
					wantedRound < writtenRound
				) {
					print(`[Music] ${AUDIO_CONFIG.ROUND_FADE_SECONDS}s of round left — fading out`);
				}

				writtenRound = wantedRound;
				roundMusic.Volume = wantedRound;
			}),
		);

		if (DEBUG) {
			print(
				`[Music] up — ${string.format("%.2f", intermissionMusic.Volume)} intermission, ` +
					`${string.format("%.2f", roundMusic.Volume)} round, ` +
					`phase ${Fusion.peek(phase) === "" ? "(unset)" : Fusion.peek(phase)}`,
			);
		}
	}

	/**
	 * One `Sound` for this client, parented to `SoundService`, with every property applied in code.
	 *
	 * **Applied in code rather than authored in Studio**, which `sound.config.ts` argues at length for the
	 * server's emitters: a `Sound` authored in the place file is one a reader has to open the place to
	 * understand, and one a re-sync can quietly change. Four lines here say what the whole sound is.
	 *
	 * **`Looped` is a parameter rather than something each caller remembers.** It is the one property that
	 * separates the two tracks from the two cues, and the failure it guards against is asymmetric: a
	 * non-looping track stops after one play, which is audible and obvious, while a *looping* whistle blows
	 * for the whole intermission. Making the call sites say which they are puts the difference where it can
	 * be read.
	 */
	private makeSound(name: string, id: string, looped: boolean, volume: number): Sound {
		const sound = new Instance("Sound");
		sound.Name = name;
		sound.SoundId = id;
		sound.Looped = looped;
		sound.Volume = volume;
		sound.Parent = SoundService;

		return sound;
	}
}
