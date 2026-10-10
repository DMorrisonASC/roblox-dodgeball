/**
 * The audio this client plays: the two tracks, the round's two cues, and the numbers that shape them.
 *
 * **Not `sound.config.ts`, and the reason is its own doc.** That file is the six ids a *server* hands to
 * `SoundEmitter` — positional impact sounds, with a roll-off distance and a minimum distance under them,
 * read by a machine that is placing a sound at a point in the world. It says so at the top. Everything here
 * is the opposite case: played locally, at one volume, from nowhere in particular, by one controller on one
 * machine. Sharing a file would mean a reader asking which of the twelve values are the server's and which
 * are the client's, and getting no answer from the layout.
 *
 * **What is here rather than in the controller, and why that changed.** The intermission track's id and
 * volume *were* file-local constants in `MusicController`, on the argument that they were read in exactly
 * one file and nowhere else — an argument that was true and that `sound.config.ts` does not share, because
 * six ids read by one service would still be six ids a person tunes by ear. Three more ids and six more
 * numbers arrived in the same file with the round's audio, and tuning audio is not a code change: it is
 * somebody in Studio with the game running, changing a number and listening. That is what this file is for,
 * and it is why the two values that were already there moved in with the rest.
 *
 * **Ids are the one thing here that cannot be tuned by ear**, so the ones that are known are written as
 * known and the ones that are guessed are marked. Every number below is a starting point that has not been
 * heard in the game.
 *
 * Imports nothing, for `sound.config.ts`'s reason: a config that depended on a service would be a service.
 */
export const AUDIO_CONFIG = {
	/**
	 * The intermission's track, and the volume it plays at.
	 *
	 * **Moved here from `MusicController` unchanged** — same id, same volume, same meaning. It fades *out*
	 * over the last {@link AUDIO_CONFIG.INTERMISSION_FADE_OUT_SECONDS} of the intermission and *in* over the
	 * first {@link AUDIO_CONFIG.INTERMISSION_FADE_IN_SECONDS} of it. See that pair for why those two numbers
	 * are not equal.
	 */
	INTERMISSION_MUSIC: "rbxassetid://93779774227857",

	/** **Placeholder.** The intermission track's level, against the round's. Tune by ear. */
	INTERMISSION_MUSIC_VOLUME: 0.3,

	/**
	 * How long the intermission track takes to come back, in seconds, after an intermission begins.
	 *
	 * **Deliberately not the same number as {@link AUDIO_CONFIG.INTERMISSION_FADE_OUT_SECONDS}, and the
	 * asymmetry is the design rather than a coincidence.** The two fades are doing different jobs. The fade
	 * *out* is the last thing a player hears before a round starts: it is a cue, it is doing the work of
	 * telling them to get ready, and five seconds is long enough to notice and short enough to still be a
	 * warning. The fade *in* does no work at all beyond not clicking — it exists because a track that starts
	 * at full volume out of silence pops, and a couple of seconds of ramp is all that prevents it. A
	 * symmetric number would be a compromise between two unrelated requirements, and the shorter of the two
	 * is the one that has to give: a 2-second fade *out* is not a cue, and a 5-second fade *in* is a track
	 * that arrives late for no reason. **If a single number ever replaces these two, it was chosen apart —
	 * say so there, and pick it for the cue, not for the click.**
	 */
	INTERMISSION_FADE_IN_SECONDS: 2,

	/**
	 * How long before the round the intermission track fades out, in seconds **of the intermission clock**.
	 *
	 * The clock and not a stopwatch, because this window is a *cue*: a dev holding rounds up freezes the
	 * countdown, and a cue that does not freeze with it is a cue that lies. See `MusicController` for the
	 * full argument, which is also why neither fade here is a `TweenService` tween.
	 */
	INTERMISSION_FADE_OUT_SECONDS: 5,

	/**
	 * The round's track: a room full of people, running under the round. **The id this task asked for.**
	 *
	 * Plays while the round is `Playing`, loops for as long as it lasts, rises from silence over the first
	 * {@link AUDIO_CONFIG.ROUND_FADE_IN_SECONDS} of the round, and falls to silence over the last
	 * {@link AUDIO_CONFIG.ROUND_FADE_SECONDS} of it. Stopped — not left looping at silence — the moment the
	 * round ends, whatever ended it.
	 *
	 * **The fade in is not decoration on this particular track.** A crowd bed that appears at full volume
	 * the instant a round begins reads as a *sting*: a thing that happened. Ramping it up over five seconds
	 * reads as the room filling, which is what a round starting is, and it is also the one cue a player gets
	 * that the round has begun before anything has happened in it — the phase changes, the arena is held
	 * still, and this comes up underneath. See `roundVolume` for how it composes with the fade out.
	 */
	ROUND_MUSIC: "rbxassetid://76122240800540",

	/** **Placeholder.** The round track's level. The louder of the two tracks is a taste question, not a fact. */
	ROUND_MUSIC_VOLUME: 0.3,

	/**
	 * How long the round's track takes to come up from silence, in seconds, after the round begins.
	 *
	 * **Measured from the phase change, on a stopwatch, and not from the round's clock** — which is the same
	 * exception the intermission's fade in makes and for the same reason: the beginning of a phase is not
	 * something the clock can postpone. A ramp driven by the round's clock would freeze at whatever fraction
	 * it had reached the moment a dev held rounds up, leaving the ambience stuck at a third of its volume
	 * and staying there; see `MusicController`'s tick.
	 *
	 * **Five seconds, which is deliberately the same number as the fade out**, and the symmetry is the one
	 * place the intermission's pair does not apply. There the two fades do different jobs (a cue and a
	 * click-avoider) and the asymmetry is argued for. Here both are the same job seen at the two ends of a
	 * round: a room that fills and a room that empties, so the ear should not be able to tell which end of
	 * the round it is listening to.
	 *
	 * **A joining player does not hear this ramp**, only the ambience it has already reached — see
	 * `MusicController.mount`. They missed the round starting.
	 */
	ROUND_FADE_IN_SECONDS: 5,

	/**
	 * How long before the round's end its music fades out, in seconds **of the round's clock**.
	 *
	 * **The window is `[T-5, T-0]`, and it reaches silence rather than merely getting quieter.** At the clock
	 * reading 5 the track is at full volume, at 4 the first step down is audible, and at 0 it is exactly
	 * silent — see `roundVolume` in the controller, which is linear and clamps at both ends so there is no
	 * step at the point a player is listening for one.
	 *
	 * **Because the clock is whole seconds, this is a six-step staircase rather than a smooth ramp**, which is
	 * the honest shape of "driven by the round's clock" and is the same staircase the intermission's fade
	 * already is. A smooth fade would have to be a tween, and a tween keeps running through a dev's pause —
	 * see `MusicController` for why that is fatal rather than merely imperfect.
	 *
	 * **Not to be confused with the round ending**: an end that is not the clock running out is an *early*
	 * end, and the track is stopped where it stands rather than faded from wherever the clock happened to be.
	 * Nothing implements that distinction, because nothing has to: the fade is only ever the clock's work, so
	 * a round stopped at 90 seconds simply stops at full volume. See the controller's note on the round-end
	 * edge.
	 */
	ROUND_FADE_SECONDS: 5,

	/**
	 * The countdown beep, and the volume it fires at.
	 *
	 * **Loud, relative to the tracks, on purpose.** It fires once a second over the music, and for its first
	 * five seconds that music is at *full* volume — the fade only begins at T-5, which is halfway through the
	 * countdown. So the beep has to be readable over a track at the top of its range rather than over a fade
	 * on its way out, and the honest knob for that is this number: ducking the music under each beep would
	 * mean a second gain factor fighting the fade, which is the one thing the fade is allowed to be.
	 */
	COUNTDOWN_BEEP: "rbxassetid://105641611062077",

	/** **Placeholder.** The beep's level, against both tracks. Tune by ear. */
	COUNTDOWN_BEEP_VOLUME: 0.5,

	/**
	 * How many seconds before the end the beep starts, in seconds **of the round's clock**.
	 *
	 * **Ten, so the countdown is ten beeps rather than a warning and then a gap.** The window is `(0, 10]`
	 * inclusive at the far end and exclusive at zero — the clock reading 10 beeps, and 1 beeps, and 0 does
	 * not, because the round is over at that point rather than about to be. See `MusicController` for the
	 * trigger and for the guard that stops one second beeping twice.
	 */
	COUNTDOWN_SECONDS: 10,

	/**
	 * The referee's whistle, and the volume it blows at.
	 *
	 * **The end of a round is fired on the phase edge and not on the clock**, which is what makes it work for a
	 * natural end and an early one without a second path: an elimination and a disconnect both publish the same
	 * phase change the clock running out does. See `MusicController` for the one case that would argue otherwise
	 * and why it does not.
	 *
	 * **It blows at both boundaries of a round, and the second one is the exception to that rule.** The start
	 * is fired by `ArenaFreezeCountdownController` on the frame the arena freeze runs out and the word "Start"
	 * arrives on screen — which is *not* the phase edge and cannot be, because the instant the freeze ends is
	 * not published anywhere; the countdown derives it, and it is the only thing on the client that knows it.
	 *
	 * **One clip for the two ends is the whole point of the pairing.** What a player hears is a round boundary,
	 * and a boundary is the same event from either side, so a second clip invented for the start would be two
	 * sounds to learn for one fact. It is also the vocabulary this game already uses: `MatchService` calls the
	 * moment a round's teams are set "the opening whistle".
	 */
	ROUND_WHISTLE: "rbxassetid://121765271775197",

	/**
	 * **Placeholder.** The whistle's level. A referee should be heard over everything.
	 *
	 * **At the round's start it is competing with less than at its end**, which is worth knowing before this
	 * number is moved: the ambience is only just beginning to rise from silence at that point and the freeze
	 * behind it is a countdown with no sound of its own, so the start is the easy half of the job. An end that
	 * happens while the round's track is still at full volume is the hard half, and this number is set for
	 * that one.
	 */
	ROUND_WHISTLE_VOLUME: 0.6,

	/**
	 * The two sounds the *interface* makes: one when the pointer arrives on something pressable, one when
	 * it is pressed.
	 *
	 * **Here rather than in `sound.config.ts`, for the reason that file gives about itself** — it is the six
	 * ids a *server* hands to `SoundEmitter` and plays at a position in the world. These two are played by the
	 * client, at the client, for the client: the same case as the four entries above them, which is why they
	 * are in the same file rather than in a third one.
	 *
	 * **Two sounds and one pressable element is the whole design.** The hover tone is a *contact* noise — it
	 * says the pointer has found something — and the select tone is the *commitment*, which is why they are
	 * different pitches rather than the same clip at two volumes: a player who has learned the first one can
	 * hear whether a press landed without looking at the border.
	 *
	 * **Neither id is a `Placeholder.` in the sense of being invented** — they were supplied — so what is
	 * unverified about them is not their spelling but their *character*: whether two short UI tones are
	 * distinguishable from each other and pleasant at the volumes below, which is a thing only a screen and a
	 * pair of ears can answer.
	 */
	UI_HOVER: "rbxassetid://96431637382556",
	UI_SELECT: "rbxassetid://132150186435903",

	/**
	 * **Placeholder.** Both UI volumes, against the music and the cues above.
	 *
	 * Quieter than every other entry in this file on purpose, and the reason is frequency rather than taste: a
	 * hover tone fires every time the pointer crosses a tile, which on a shelf is several times a second, so
	 * the same level that suits a once-a-round whistle would be a room full of clicks. Tune by ear, and tune
	 * the *hover* one first — it is the one that will be wrong.
	 */
	UI_HOVER_VOLUME: 0.25,
	UI_SELECT_VOLUME: 0.35,

	/**
	 * The chest's award sound: what plays when a Power Chest hands something over.
	 *
	 * **Not part of the pair above, and it is the difference between feedback and an event.** The two UI tones
	 * answer the pointer, and they are so frequent that their whole volume argument is about not being a room
	 * full of clicks. This one fires when a player has just spent fifty coins and been given something, which
	 * happens a few times an hour — so it is allowed to be an *event* rather than a detail, and it is the one
	 * interface sound here that carries information rather than acknowledgement.
	 *
	 * **It fires on a grant and nothing else, so its absence is meaningful.** A duplicate and a refusal are both
	 * "you got nothing", and a sound on those would be the panel telling the player something happened when
	 * nothing did — the same argument the toast column makes about drawing a refusal it did not have a sentence
	 * for.
	 */
	CHEST_GRANT: "rbxassetid://98790672104771",

	/** **Placeholder.** The award's level, against the two UI tones above it. Tune by ear. */
	CHEST_GRANT_VOLUME: 0.5,

	/**
	 * The charge sound: the build-up a player hears while holding the throw, with the click that ends it
	 * landing exactly when the charge completes.
	 *
	 * **The one id in this file whose *duration* is part of the mechanic.** Every other clip here could be
	 * swapped for one of any length and only the ear would notice. This one is played at
	 * `TimeLength / BALL_CONFIG.CHARGE_SECONDS`, so how long it is against the charge is what decides how fast
	 * it plays and how far its pitch moves. See `ThrowController.chargePlaybackSpeed`, which derives that speed
	 * rather than being told it: the consequence worth knowing on this line is that **swapping the file is
	 * safe** — the speed follows whatever arrives — but a *longer* clip is a more shifted one, and a clip cut
	 * to `CHARGE_SECONDS` long is the only one that plays unshifted, because a ratio of one resamples nothing.
	 * A clip appreciably longer than the charge will be heard as a sped-up version of itself rather than as
	 * itself, which is a decision about the file and not about any number here.
	 *
	 * **The click is the end of the sound, and that is what makes it a charge sound.** What it tells the player
	 * is "the throw is ready", so a clip that builds towards something other than a payoff — or that puts the
	 * payoff somewhere before the end — would be this sound saying the wrong thing. Nothing in the code can
	 * check that, so it is written here for whoever replaces the id.
	 *
	 * **Supplied rather than invented**, so what is unverified about it is not the spelling but the character:
	 * whether a build-up compressed to fit a one-second charge reads as a charge or as a gulp. That is an ear
	 * judgement, and it is the reason the derived speed is printed whenever `DEBUG` is on in `ThrowController`.
	 */
	THROW_CHARGE: "rbxassetid://134302747911283",

	/**
	 * **Placeholder.** The charge sound's level, against the round's bed underneath it.
	 *
	 * **Louder than the bed, quieter than the whistle**, which is the shape every volume in this file has: the
	 * round's track sits at its own level for the whole round, so a charge *under* that would be a sound the
	 * player has to strain for while holding a button. But this is not a cue either — it fires on every throw
	 * anybody charges, which inside one round is several times — so it is set as feedback rather than as an
	 * event. **Expect it to want to be quieter than it first seems**: it is the only sound here a player can
	 * make happen deliberately, repeatedly, and at a moment of their own choosing.
	 */
	THROW_CHARGE_VOLUME: 0.4,
} as const;
