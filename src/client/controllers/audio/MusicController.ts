import { Controller, OnStart } from "@flamework/core";
import Fusion from "@rbxts/fusion-3.0";
import { ContentProvider, ReplicatedStorage, RunService, SoundService } from "@rbxts/services";
import { ROUND_STATE_ATTRIBUTE, ROUND_STATUS_FOLDER, ROUND_TIME_ATTRIBUTE } from "shared/constants";

/** Prints the mount line and one line per fade boundary. The lines the Studio acceptance run reads. */
const DEBUG = true;

/**
 * The phase that means the intermission is running.
 *
 * Copied rather than imported, for the reason `BallSpawnerService` and `OutlineService` copy it: the
 * phase goes out as its own *name*, and those names are `RoundState`'s members by convention rather
 * than by construction — so there is no constant to import and this is the fourth file to spell it
 * out. See `RoundStatusController`, which is the HUD doing the same thing.
 */
const INTERMISSION = "Intermission";

/**
 * The track.
 *
 * **The real id, not a placeholder** — unlike the volume below, which is a starting guess. Asset ids
 * are the one thing in this file that cannot be tuned by ear, so the one that is known is written
 * down as known.
 *
 * A file-local constant rather than an entry in `shared/config/sound.config.ts`, which is where the
 * *other* sound ids live. That file exists for the ids a server hands to `emitSound`, and it is read
 * by files that have nothing to do with this one; this id is read here and nowhere else.
 */
const INTERMISSION_MUSIC = "rbxassetid://93779774227857";

/** **Placeholder.** The starting volume; tune by ear. */
const INTERMISSION_MUSIC_VOLUME = 0.3;

/**
 * How long before the round the music fades out, in seconds **of the intermission clock**.
 *
 * See {@link volumeFor} for why the clock and not a stopwatch: this window is a *cue*, and a cue
 * that does not freeze when the round does is a cue that lies.
 */
const FADE_OUT_SECONDS = 5;

/**
 * How long the music takes to come back, in seconds, after the intermission begins.
 *
 * **Deliberately not the same number as {@link FADE_OUT_SECONDS}, and the asymmetry is the design
 * rather than a coincidence.** The two fades are doing different jobs. The fade *out* is the last
 * thing a player hears before a round starts: it is a cue, it is doing the work of telling them to
 * get ready, and five seconds is long enough to notice and short enough to still be a warning. The
 * fade *in* does no work at all beyond not clicking — it exists because a track that starts at full
 * volume out of silence pops, and a couple of seconds of ramp is all that prevents it. A symmetric
 * number would be a compromise between two unrelated requirements, and the shorter of the two is
 * the one that has to give: a 2-second fade *out* is not a cue, and a 5-second fade *in* is a track
 * that arrives late for no reason. **If a single number ever replaces these two, it was chosen apart
 * — say so there, and pick it for the cue, not for the click.**
 */
const FADE_IN_SECONDS = 2;

/**
 * The volume for the current moment — the whole of the fade, as a pure function of three numbers.
 *
 * Linear, and linear on purpose rather than for want of a better idea. A curve would be smoother —
 * a real fade-in is usually closer to exponential, because loudness is perceived logarithmically —
 * but the honest reading of "fade in over 2 seconds" is a ramp, and a curve here would be a second
 * opinion nobody asked for that also makes the two boundaries harder to check. What matters is that
 * it is **continuous at both ends**: `time = FADE_OUT_SECONDS` gives exactly full volume from either
 * side, and `time = 0` gives exactly zero, so there is no step at the point a player is listening
 * for one.
 *
 * **The fade-in is checked first, and that ordering is not cosmetic.** Both windows can be read at
 * once — the fade-in is `fadeInProgress < 1` while the clock still says a large number — so with the
 * checks in any other order the entry ramp would be multiplied away by the "full volume" case it
 * shares a moment with. The two windows cannot overlap at today's numbers (2 seconds against a
 * 30-second intermission, and the fade out only starts at 5), so the ordering changes nothing today;
 * it is the thing that keeps a *shorter* intermission from silently dropping the entry ramp.
 *
 * **The clock drives the fade out and a stopwatch drives the fade in, which is not a contradiction.**
 * The fade out has to freeze when the intermission freezes — see {@link MusicController}'s note on
 * tweens — because it is counting down to something that can be postponed. The fade in is over in
 * the first two seconds of an intermission that has just *begun*, and beginning is not something the
 * clock can postpone: a server that freezes has music, and music arriving smoothly is right whether
 * or not the countdown is moving.
 *
 * @param phase The round's phase, as `RoundService` publishes it.
 * @param time The intermission clock, in seconds remaining.
 * @param fadeInProgress 0 at the moment the intermission begins, 1 once the entry ramp is done — and
 * 1 for a player who was not there to see it begin. See {@link MusicController.mount}.
 */
function volumeFor(phase: string, time: number, fadeInProgress: number): number {
	if (phase !== INTERMISSION) return 0;

	if (fadeInProgress < 1) return INTERMISSION_MUSIC_VOLUME * fadeInProgress;

	// Clamped rather than trusted: the clock is a number from another machine, and a negative one
	// would read as a negative volume, which is undefined behaviour rather than silence.
	const remaining = math.max(time, 0);

	if (remaining > FADE_OUT_SECONDS) return INTERMISSION_MUSIC_VOLUME;

	return INTERMISSION_MUSIC_VOLUME * (remaining / FADE_OUT_SECONDS);
}

/**
 * The intermission music: one `Sound` per client, faded by the round's own clock.
 *
 * **Nothing here is sent anywhere.** Every client runs this controller, makes its own `Sound`, and
 * decides its own volume from `ReplicatedStorage`'s two attributes — the same two the HUDs already
 * read. There is no remote, no server-side sound, and nothing to keep in step: the intermission
 * clock *is* the channel.
 *
 * **The fade follows the clock and not the wall clock, and that is the whole reason this is not a
 * `TweenService` tween.** The intermission can be *held* — a server below `MIN_PLAYERS`, or a dev
 * with rounds paused — and while it is held the clock does not move. A tween runs on real time
 * regardless: it would keep fading through the freeze, reach silence, and then sit in silence while
 * the HUD said there were still several seconds to go. Reading `ROUND_TIME_ATTRIBUTE` means the
 * fade **freezes with the clock**, at whatever volume it had reached, and resumes with it. **Do not
 * "simplify" this into a tween.**
 *
 * **A joining player hears the moment they joined, not the fade they missed.** The values are seeded
 * from the attributes as they are *now* and the entry ramp starts already finished, so a player who
 * arrives mid-intermission gets full volume, one who arrives during the fade out gets the volume the
 * clock implies, and one who arrives mid-round gets silence.
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

		// An unset phase reads as `""`, which is not `"Intermission"` and so is silent. Silence is the
		// safe direction to be wrong in: the alternative default would put music over a round.
		const phase = Fusion.Value(scope, typeIs(initialPhase, "string") ? initialPhase : "");
		const time = Fusion.Value(scope, typeIs(initialTime, "number") ? initialTime : 0);

		// **The entry ramp, armed by the phase *changing* and by nothing else.** A player who mounts
		// into an intermission that is already running never sees a transition, so this starts at 1
		// and stays there: they hear the music that is playing, not a fade in they were not present
		// for. Accumulated from `Heartbeat`'s own delta rather than read from a clock — see the tick.
		let fadeInElapsed = FADE_IN_SECONDS;

		// The phase as last seen, so a *change* can be told from a phase that was already this one.
		let lastPhase = Fusion.peek(phase);

		scope.push(
			status.GetAttributeChangedSignal(ROUND_STATE_ATTRIBUTE).Connect(() => {
				const value = status.GetAttribute(ROUND_STATE_ATTRIBUTE);
				if (!typeIs(value, "string")) return;

				if (value === INTERMISSION && lastPhase !== INTERMISSION) {
					fadeInElapsed = 0;
					if (DEBUG) print(`[Music] ${INTERMISSION} — fading in over ${FADE_IN_SECONDS}s`);
				} else if (value !== INTERMISSION && lastPhase === INTERMISSION) {
					if (DEBUG) print(`[Music] ${value} — music out`);
				}

				lastPhase = value;
				phase.set(value);
			}),
		);

		scope.push(
			status.GetAttributeChangedSignal(ROUND_TIME_ATTRIBUTE).Connect(() => {
				const value = status.GetAttribute(ROUND_TIME_ATTRIBUTE);
				if (typeIs(value, "number")) time.set(value);
			}),
		);

		// **`SoundService`, because this is non-positional.** A `Sound`'s own `RollOff`/positional
		// behaviour only applies when it is parented to a `BasePart` or an `Attachment`; in
		// `SoundService` it is heard at the same volume from anywhere, which is what a piece of music
		// is. The server's impact sounds are parented to a throwaway part on purpose — they *are* a
		// place. This is the opposite case and the opposite parent, and that is the whole difference.
		const sound = new Instance("Sound");
		sound.Name = "IntermissionMusic";
		sound.SoundId = INTERMISSION_MUSIC;
		sound.Looped = true;
		sound.Volume = 0;
		sound.Parent = SoundService;

		// Started once, at zero volume, and never started again: the volume is the only thing that
		// changes from here. `Play` before the asset has arrived is not a mistake — the engine plays
		// it when it can — and the preload below is what makes "when it can" mean the next frame
		// rather than several seconds into an intermission that may already be over.
		sound.Play();

		ContentProvider.PreloadAsync([sound], (contentId, status_) => {
			if (status_ !== Enum.AssetFetchStatus.Success) {
				warn(`[Music] track did not load — ${contentId} (${status_.Name})`);
			} else if (DEBUG) {
				print(`[Music] track loaded — ${contentId}`);
			}
		});

		/**
		 * The volume, once per frame.
		 *
		 * **`Heartbeat` rather than a throttled loop, and the reason is the fade in.** The fade out
		 * moves in five steps because the clock does — one second per value, which is what "driven by
		 * the intermission clock" means, and a staircase is the honest shape of it. The fade in has
		 * no clock to be driven by, so it is driven by this loop, and a 10 Hz loop would give it ten
		 * steps of a twentieth of the volume each, which is audible on a sustained track. Per frame
		 * costs one comparison and an add when nothing is happening.
		 *
		 * **The property is written only when the number changes**, which is what makes a per-frame
		 * connection cheap here: for the whole of an intermission outside the two windows the answer
		 * is the same every frame and nothing is written at all. The comparison is exact rather than
		 * approximate because the inputs are — the same phase and the same clock reading recompute
		 * the same float, and a fade that is settling does so at the same rate in both.
		 */
		let written = -1;

		scope.push(
			RunService.Heartbeat.Connect((delta) => {
				if (fadeInElapsed < FADE_IN_SECONDS) {
					fadeInElapsed = math.min(fadeInElapsed + delta, FADE_IN_SECONDS);
				}

				const progress = math.min(fadeInElapsed / FADE_IN_SECONDS, 1);
				const currentPhase = Fusion.peek(phase);
				const remaining = Fusion.peek(time);
				const wanted = volumeFor(currentPhase, remaining, progress);

				if (wanted === written) return;

				// The boundary worth a line, because it is the one the acceptance test listens for:
				// the clock reaching `FADE_OUT_SECONDS` with the music still up. Printed on the edge
				// rather than per step, and only when the fade actually begins.
				if (DEBUG && currentPhase === INTERMISSION && remaining === FADE_OUT_SECONDS && wanted < written) {
					print(`[Music] ${FADE_OUT_SECONDS}s left — fading out`);
				}

				written = wanted;
				sound.Volume = wanted;
			}),
		);

		if (DEBUG) {
			print(
				`[Music] up — ${string.format("%.2f", Fusion.peek(sound.Volume))} volume, ` +
					`phase ${Fusion.peek(phase) === "" ? "(unset)" : Fusion.peek(phase)}`,
			);
		}
	}
}
