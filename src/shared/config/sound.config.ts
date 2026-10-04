/**
 * The sounds of the game: three for what a ball lands on, and three for what a body does — a throw, a
 * catch and a dodge.
 *
 * **Asset ids, not files.** A `SoundId` is a reference to something Roblox hosts, so none of this is
 * in the repository and none of it can be: Rojo syncs a directory tree into the place, and an `.mp3`
 * sitting in one would arrive as a file nobody can play. Uploading is a Studio step, and these six
 * strings are the only trace of it here.
 *
 * **Why the sounds are built in code rather than kept as a template.** The obvious alternative — a
 * `Sound` made in Studio under a template and cloned at the impact — is out because `rojo build` does
 * not carry the roll-off properties through a `.model.json`. A cloned emitter would therefore be
 * audible across the whole map with nothing in the file to say why, and the fix would look like a
 * bug in the engine. Every value below is applied in `SoundEmitter` instead, where it can be read.
 *
 * Imports nothing. A config that depended on a service would be a service, and these ids mean the
 * same thing on both machines even though only the server plays them.
 *
 * **Every id here is a `Placeholder.` in the sense of unmeasured rather than unread** — the file's
 * usual marker means "nothing reads this yet", and these are read immediately. What is unverified is
 * the audio: they have not been heard in the game. What to listen for is that the six are
 * *distinguishable* — a head hit, a body hit, a ball hitting the arena, a throw, a catch and a dodge
 * are six different events and should not sound like six takes of one.
 *
 * **Three of the six are the ball's and three are a body's**, which is the split worth knowing when
 * one of them is wrong. The hits are things that happened *to* the ball; a throw, a catch and a dodge
 * report something a body did, and they are the three that can be heard while nothing is being hit.
 * They exist for the same reason — the action is otherwise visible only from the seat of whoever did
 * it — and none of the three is a hit, so none should end up borrowing a hit's id.
 */
export const SOUND_CONFIG = {
	/** **Placeholder.** A ball landing on a head. */
	HEAD_HIT: "rbxassetid://94605664308282",

	/** **Placeholder.** A ball landing on a torso, an arm or a leg. */
	BODY_HIT: "rbxassetid://89922075635474",

	/**
	 * **Placeholder.** A ball landing on the arena — the floor, a wall, a prop.
	 *
	 * The impact that is not a *body*: a thrown ball that misses, a ball rolling to a stop, a stray
	 * ball dropping out of the air. It plays where the ball stopped.
	 */
	WORLD_HIT: "rbxassetid://85922186245400",

	/**
	 * **Placeholder.** A ball leaving a hand.
	 *
	 * **The third sound a body makes, and the first one in time.** A throw is the beginning of the
	 * sequence the other two report — the catch reads it, the dodge avoids it — and it is played for
	 * the same reason they are: a throw is plain from the thrower's own seat and from very few others,
	 * so everybody near the launch point is told a ball is on its way. That is information no impact
	 * can carry, because an impact is the end of the story rather than the start of it.
	 *
	 * Played on the server at the launch point, from the same emitter as everything else — see
	 * `SoundEmitter.emitSound`. The position is the ball itself at the moment it is given velocity,
	 * which is the last instant it is in the hand and already the first instant it is not; see
	 * `BallService.throwBall` for the line and for why the ball is asked rather than the plan.
	 *
	 * **A rig's throw plays it too, and that is the default rather than an oversight** — the same
	 * answer {@link SOUND_CONFIG.CATCH} gives, for the same reason: this sits on the throw path, which
	 * a rig and a player share, so nothing here has to know which of them threw. If a round full of
	 * throwing rigs turns out to be noisy, muting them is one condition at the call site.
	 */
	THROW: "rbxassetid://81276543313696",

	/**
	 * **Placeholder.** A ball taken cleanly out of the air.
	 *
	 * **One of the three sounds here that are not the ball's, and that is the whole of why it exists.**
	 * The hits report something that happened *to* the ball; this reports something a body did, and it
	 * is played so that everybody near the catch knows a throw was read. That is information no hit
	 * can carry, because a successful catch is otherwise invisible from anywhere but the catcher's own
	 * seat — the ball simply stops, and an unfired throw looks much the same.
	 *
	 * It is played on the server, at the catcher, from the same emitter as an impact — see
	 * `SoundEmitter.emitSound`. Where exactly is the ball's position at the moment the catch is
	 * confirmed, which is the hand: see `BallService.catchBall` for why that is the honest point
	 * rather than a convenience.
	 *
	 * **A rig catching plays it too, and that is the default rather than an oversight.** A catch is a
	 * catch whoever made it, and `CatchBehavior` asks through the same gate a player does, so the
	 * sound is the only thing that would have to know the difference. If a round full of rigs turns
	 * out to be noisy, muting NPCs is one condition at the call site — not a second id and not a
	 * per-catcher volume.
	 */
	CATCH: "rbxassetid://102568616462839",

	/**
	 * **Placeholder.** A dodger getting clear.
	 *
	 * The last of the three sounds a body makes, and it is in the same business as a throw and a
	 * catch: reporting an action rather than an event, for everyone nearby rather than for the one who
	 * did it. Where a throw says a ball is on its way and a catch says that one was read, this is news
	 * that somebody moved — and it is aimed at the people who are watching for the throw rather than
	 * at the person who left.
	 *
	 * Played on the server at the dodger, from the same emitter as everything else — see
	 * `SoundEmitter.emitSound`. `DodgeService.requestDodge` is where the moment and the position are
	 * decided, and both are worth reading: the position is the part whose position the model's
	 * position *is*, and the moment is the one after the dash exists rather than the one a key was
	 * pressed.
	 *
	 * **Only a player can dodge today, so unlike the catch there is no rig version of this to mute.**
	 * That is a fact about the AI rather than a rule about dodging — nothing in `DodgeService` is
	 * player-only, and a rig that was taught to dodge would start making this sound with no change
	 * here.
	 */
	DODGE: "rbxassetid://129695013340139",

	/**
	 * How far away an impact is still audible, in studs.
	 *
	 * Long, deliberately: this is a game about reading a throw you may not be looking at, and a ball
	 * landing behind you is information rather than noise. The arena is a few hundred studs across, so
	 * this reaches a good part of it from anywhere in it.
	 *
	 * **Placeholder.** It has not been heard with a full server. If a busy round becomes a wall of
	 * impacts, this is the number to bring down rather than the volume — see
	 * {@link SOUND_CONFIG.ROLL_OFF_MIN_DISTANCE}.
	 */
	ROLL_OFF_MAX_DISTANCE: 250,

	/**
	 * How far away an impact is at full volume, in studs.
	 *
	 * Something like a person's reach, so that a ball landing at your feet is unattenuated and one
	 * landing across the arena is background. Between this and
	 * {@link SOUND_CONFIG.ROLL_OFF_MAX_DISTANCE} the engine falls the volume off on its own curve,
	 * which is the whole reason to set these two rather than a `Volume`: a flat volume is audible
	 * everywhere or nowhere, and the difference between near and far is most of what a positional
	 * sound is for.
	 */
	ROLL_OFF_MIN_DISTANCE: 15,
} as const;
