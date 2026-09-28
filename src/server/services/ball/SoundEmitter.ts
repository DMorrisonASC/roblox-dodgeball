import { Workspace } from "@rbxts/services";
import { DEBUG_CONFIG } from "shared/config/debug.config";
import { SOUND_CONFIG } from "shared/config/sound.config";

/**
 * How long an emitter lives, in seconds.
 *
 * **The whole lifetime, not a backstop, and generously long on purpose.** It has to cover the clip
 * itself, the delay before a client learns there is a sound to play, and whatever is left of an asset
 * download that had not finished when the sound was created — because the one failure this number
 * exists to prevent is a client's copy of the clip being cut off part-way. The price is a speck of an
 * anchored part sitting in `Workspace` for this long after every impact and every catch: invisible,
 * untouchable, unqueryable, and unable to be collided with. See {@link emitSound} for why that is the
 * cheaper of the two failures. Bring the number down if a busy round ever makes it matter, but not
 * below a whole clip plus a second.
 */
const SOUND_CLEANUP_SECONDS = 10;

/**
 * Plays one short positional sound at a point in the world, and tidies the emitter away afterwards.
 *
 * **One function, two events, and it was a private method on `BallComponent` until the catch needed
 * it.** That is the whole of the decision to extract: this was never about a ball landing on
 * somebody, it is about a *moment* — somewhere in the world something happened, and everyone near it
 * should hear so — and an impact and a catch are two of those. What forced it is not tidiness but
 * direction: `BallService` would otherwise have had to reach into a *component* to play a sound, and
 * a component is attached to one instance while this question is about a point that has nothing to do
 * with which ball it was. Extracted, the caller supplies the three things that are genuinely the
 * caller's: where, which id, and what to call the emitter.
 *
 * **A module and not a service, deliberately.** There is no state here, nothing to start, nothing to
 * inject, nothing to shut down — a service would be a decorator around four lines of construction.
 * The house already keeps this shape in this folder (`BallTrail`, `ballExpiry`, `ThrowProbe`,
 * `actionLock`, `readyAt`), and this imports a config and nothing else.
 *
 * **The name is the caller's, and that is what keeps the leftover check honest.** An emitter is a
 * bare part in `Workspace` with nothing else to distinguish it — invisible, tiny, parented to the
 * world at large rather than to anything that says what it is. So the way to check that none has been
 * left behind is to search for one name, and that check only tells you which *event* leaked if each
 * event has its own name. A single shared name would make "no emitters remain" a true statement about
 * the wrong thing.
 *
 * **A part rather than an `Attachment`, and that is a smaller claim than the comment here used to
 * make.** It said whether the engine places audio at an attachment's `WorldCFrame` could not be read
 * out of the typings. It nearly can: `Sound.RollOffMaxDistance` and `RollOffMinDistance` are
 * documented as applying *only* to sounds "parented to a `BasePart` or `Attachment`", which is the
 * engine saying an attachment is a legitimate origin for a positional sound. An attachment would also
 * be strictly tidier — it has no size, no mass, no collision and no rendering, so four of the
 * properties below would have nothing to be set to. It is not being changed here for one reason: the
 * part is the version that has been built and read back on the impact path, and switching it would be
 * a change to a working path for looks. Worth revisiting on its own, not in passing.
 *
 * **`CanTouch = false` is load-bearing rather than cosmetic.** This is a `BasePart` in `Workspace`
 * with a live ball still bouncing around nearby, and a touchable one is a fresh surface for that ball
 * to hit — which fires a `Touched` handler, which plays another sound, which makes another emitter.
 * `CanQuery = false` is the same care aimed at the raycasts instead of the physics: the aim guide
 * casts along the very line a ball has just travelled.
 *
 * **None of those flags has anything to do with audio**, which is worth saying because three `false`s
 * around a `Sound` look like they might. `CanTouch` gates `Touched` and `TouchEnded`, `CanCollide`
 * gates collision, each per its own documentation; a `Sound` in the tree plays whatever its parent
 * happens to be doing physically. Setting them is about not disturbing the game, not about letting
 * the sound out.
 *
 * **`PlayOnRemove` is deliberately not used, and it was the first candidate.** It is the usual idiom
 * for a fire-and-forget sound: set the flag, destroy the instance, and the engine plays it on the way
 * out. What that leaves behind is a sound being played by an instance no longer in the tree, and
 * whether the engine still places it where it was is the one question about a *positional* sound that
 * cannot be answered from this repository. The version below keeps the sound parented for the whole
 * clip, which makes "you hear it where it happened" a fact about the running code rather than a
 * belief about the engine.
 *
 * **The emitter's life is one timer, and `Ended` deliberately does not end it.** This used to be two
 * paths to one outcome — `Ended` for the ordinary case, the timer behind it — and the ordinary case
 * was the bug. `Ended` is documented as *"fires when the `Sound` has completed playback and stopped"*,
 * which is a fact about the **server's** copy of the sound: the machine that owns the instance. It
 * says nothing about when a client heard anything. A client learns that a sound is playing when the
 * `Playing` change replicates to it, and starts its own clock from there, so it is always behind the
 * server — and the typings say the same thing from the other side, because `Sound.TimePosition` is
 * `NotReplicated`, so a client cannot be handed the server's position and kept in step with it.
 *
 * A destroy timed off the server's clock therefore lands while clients are still playing. A client
 * that is merely behind hears the last part of the clip cut off; a client that had not finished
 * loading the asset when the sound was created has not started at all, and after the destroy it never
 * will. That combination — audible sometimes, truncated when it is — is the whole of the report this
 * arrangement was rewritten in response to, and it is worth being clear that the emission was never
 * the problem: `BallService` prints `caught a dodgeball` on the line immediately above its call into
 * here, so the call itself is proven live by the log.
 *
 * So the timer is the lifetime, and its length is the only thing that has to be right — see
 * {@link SOUND_CLEANUP_SECONDS}. It destroys the **emitter**, which takes the sound with it: one call
 * rather than two, and no way for the sound to go while the emitter is left behind.
 *
 * **The roll-off is this file's and the id is the caller's**, and that split is the point. "As far as
 * a shout and no further" is a property of the game rather than of the event — a catch and a head hit
 * should carry the same distance — so two call sites setting their own number is how that stops being
 * true. Which *sound* it is, on the other hand, is the only thing that differs between events, so it
 * is the one thing passed in.
 *
 * @param at Where the sound is heard from. A point rather than a part, because the interesting thing
 * about it is its position and nothing else — see the note above about not being tied to an instance.
 * @param subject What the diagnostic line calls this event, for a human reading the output. Not used
 * for anything else; a part's own name is the useful one at an impact and the *catcher's* name is the
 * useful one at a catch, and only the caller knows which.
 * @param soundId The asset to play.
 * @param emitterName What to call the throwaway part, so a leftover can be found and attributed.
 */
export function emitSound(at: CFrame, subject: string, soundId: string, emitterName: string): void {
	const emitter = new Instance("Part");
	emitter.Name = emitterName;
	emitter.Anchored = true;
	emitter.CanCollide = false;
	emitter.CanTouch = false;
	emitter.CanQuery = false;
	// Belt and braces beside `Anchored`: a part that cannot fall has no mass that matters, and
	// saying so keeps a ball passing through from being told about a body it should push.
	emitter.Massless = true;
	emitter.Transparency = 1;
	emitter.Size = new Vector3(0.05, 0.05, 0.05);
	emitter.CFrame = at;

	// **Parented last, with every property already set.** A part that arrives touchable and is made
	// untouchable on the following line is one the solver has already seen, and a contact made inside
	// that window is exactly the second sound this arrangement exists to prevent.
	emitter.Parent = Workspace;

	const sound = new Instance("Sound");
	sound.SoundId = soundId;
	sound.RollOffMaxDistance = SOUND_CONFIG.ROLL_OFF_MAX_DISTANCE;
	sound.RollOffMinDistance = SOUND_CONFIG.ROLL_OFF_MIN_DISTANCE;
	sound.Parent = emitter;

	// Started, and then left entirely alone for `SOUND_CLEANUP_SECONDS`. There is deliberately no
	// `Ended` handler here — see the note above on whose clip `Ended` actually describes.
	sound.Play();

	task.delay(SOUND_CLEANUP_SECONDS, () => emitter.Destroy());

	// The id rather than "a sound played", because which id was chosen is the one part of this that
	// cannot be heard in the output — a head hit and a body hit are distinguishable by ear, a wrong
	// id is not.
	if (DEBUG_CONFIG.VERBOSE_LOGS) print(`[Sound] ${subject}: ${soundId}`);
}
