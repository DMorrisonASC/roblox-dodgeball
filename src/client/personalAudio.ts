import { ContentProvider, Players, SoundService } from "@rbxts/services";
import { AUDIO_CONFIG } from "shared/config/audio.config";
import { DEBUG_CONFIG } from "shared/config/debug.config";
import { PICKUP_COUNT_ATTRIBUTE, SUPER_MULTI_BALL_COUNT_ATTRIBUTE } from "shared/constants";

/**
 * The two sounds a player makes that **only that player hears**: collecting a ball, and spending a power.
 *
 * **Why these two are here rather than on the server, and it is not a small correction.** `SoundEmitter`'s
 * sounds are *world events*: a ball hitting a wall, a throw leaving a hand, a catch. They are positioned at
 * the point they happened, they roll off with distance, and being audible to everybody in range is the
 * whole reason they exist — that is how a player learns a ball is coming from somewhere they are not
 * looking. A pickup is not that. Eight players and eight rigs each collecting a ball is a continuous
 * texture of clicks scattered across the arena, positioned so that each one is faint and none of them is
 * *yours*; the information a player actually needs is "my hand changed", and that is a fact about one
 * machine. Two sounds with forty emitters a round are not a louder version of the same message, they are a
 * different and worse one.
 *
 * **`SoundService` is what makes them non-positional, and it is a property of the parent.** A `Sound` is
 * heard at a point in the world when it hangs off a `BasePart` or an `Attachment`, and at one constant
 * volume from anywhere otherwise — which is what a sound the player made with their own hand should be. The
 * three other client sounds in this project parent here for the same reason and argue it in their own
 * files: `MusicController`, `elevation.ts` and `ThrowController`'s charge. `PlayerGui` is the other
 * candidate and is wrong for a different reason — it is torn down and rebuilt on every respawn, and these
 * are instances made once for the session.
 *
 * **Client-side by construction rather than by convention, and that is the part worth stating.** Nothing
 * here is sent to the server and nothing on the server knows these exist, so "only I hear my pickup" is
 * true because of *where the instance lives*: this client's `SoundService`, and nowhere else. There is no
 * filter to get wrong, no ownership check to forget, and no reply to wait for.
 *
 * **A file of functions and not a Flamework controller**, which is `hitVfx`, `hitConfirm`, `catchPrompt` and
 * `returnToLobby`'s reason stated in `main.client.ts`: Flamework records an exported class in
 * `flamework.build` whether or not it is decorated, and adding a controller is a change to a generated
 * record for a module whose whole job is two subscriptions. It is started from the boot beside those four.
 *
 * **Both sounds are one instance each, restarted rather than layered.** A second pickup inside a clip
 * rewinds the same `Sound` instead of making a second one, because the alternative — a pool — buys nothing
 * a player can hear and costs a lifetime to manage: two pickups a tenth of a second apart are one event with
 * a stutter, not two events. See {@link play}.
 */

/**
 * The pickup sound, or `undefined` before {@link startPersonalAudio} has run.
 *
 * Module-level because the two subscriptions below are closures made once, and a controller field is not
 * available to a file that has no controller. It is also what makes the two play functions total: a call
 * that arrives before the boot did nothing rather than throwing.
 */
let pickupSound: Sound | undefined;

/** The spent-power sound. See {@link pickupSound}. */
let abilitySound: Sound | undefined;

/**
 * Whether the boot call has already run.
 *
 * **A guard rather than a promise that the boot runs once**, because the two failure modes of running twice
 * are both silent: two sets of `Sound` instances in `SoundService` with the same names, and two
 * subscriptions to each attribute — which is a sound played twice for every pickup, the exact fault this
 * module is here to avoid. `main.client.ts` calls it once and nothing else calls it at all, so the flag is
 * cheap insurance against the second caller somebody adds in a year.
 */
let started = false;

/**
 * Starts the two sounds and the two subscriptions that fire them.
 *
 * Called once from `main.client.ts`, beside the four other plain modules the boot wires up.
 */
export function startPersonalAudio(): void {
	if (started) return;
	started = true;

	const pickup = makeSound("BallPickup", AUDIO_CONFIG.BALL_PICKUP, AUDIO_CONFIG.BALL_PICKUP_VOLUME);
	const ability = makeSound("AbilityConsumed", AUDIO_CONFIG.ABILITY_CONSUMED, AUDIO_CONFIG.ABILITY_CONSUMED_VOLUME);

	pickupSound = pickup;
	abilitySound = ability;

	// **Preloaded, because the first pickup of a session can arrive before the clip does.** A sound whose
	// asset is still in flight when `Play` is called is a sound that arrives after the moment it describes —
	// or not at all — and unlike the UI tones in `elevation.ts` these cannot wait for a pointer to reach them:
	// a player walking over a ball in the first second of a round has done nothing unusual. The window is
	// only generous if the load starts at boot, which is here. The same warn-on-failure the charge sound
	// uses, and for the same reason: a wrong id is the one fault that cannot be heard as anything but
	// silence.
	ContentProvider.PreloadAsync([pickup, ability], (contentId, fetchStatus) => {
		if (fetchStatus !== Enum.AssetFetchStatus.Success) {
			warn(`[Audio] personal sound did not load — ${contentId} (${fetchStatus.Name})`);
		}
	});

	watchPickups();
	watchMultiBalls();
}

/**
 * Plays the spent-power sound.
 *
 * **Exported because one of its two callers cannot watch anything.** A MultiBall window is announced by the
 * state the server publishes — see {@link watchMultiBalls} — but a marked ball leaving a hand is an *action*
 * this client is in the middle of taking, so the throw site calls this directly rather than an attribute
 * changing a round trip later. `ThrowController.releaseThrow` is the only caller; see it for why the read
 * that decides is the ball's own and not the player's intent.
 */
export function playAbilityConsumed(): void {
	play(abilitySound, "spent a power");
}

/**
 * A `Sound` for this client, parented to `SoundService`, with every property applied in code.
 *
 * **Applied in code rather than authored in Studio**, which `MusicController.makeSound` and `sound.config.ts`
 * both argue: a `Sound` authored in the place file is one a reader has to open the place to understand, and
 * one a re-sync can quietly change.
 *
 * **`Looped = false` and `PlaybackSpeed = 1` are stated rather than left to the default.** The loop is the
 * one that would be a bug rather than a preference — a pickup that looped would click until something
 * stopped it — and the speed is worth a line because the *other* client sound in the game derives its speed
 * from the charge and this one deliberately does not: these two are played as uploaded.
 */
function makeSound(name: string, id: string, volume: number): Sound {
	const sound = new Instance("Sound");
	sound.Name = name;
	sound.SoundId = id;
	sound.Looped = false;
	sound.PlaybackSpeed = 1;
	sound.Volume = volume;
	sound.Parent = SoundService;

	return sound;
}

/**
 * Plays `sound` from the beginning, whatever it was doing.
 *
 * **`Stop` before `Play`, and the order is the whole of it.** `Sound:Play()` on a clip that is already
 * playing does nothing — it is not a restart — so a player who collects a second ball before the first
 * clip has finished would hear nothing at all for the second, which is the worst possible answer: the sound
 * would be reliably present only for slow pickups. `Stop` rewinds and silences, `Play` starts from there.
 *
 * **One instance per event is a decision, not a shortcut.** Overlapping would need a pool of copies, and
 * what it would buy is two pickups a tenth of a second apart heard as two clips on top of each other —
 * which is not more information than one restarted clip, it is the same information with a smear on it.
 *
 * The log line is gated on `VERBOSE_LOGS` and names the id, for `SoundEmitter`'s reason: which clip was
 * chosen is the one part of this that cannot be heard in the output.
 */
function play(sound: Sound | undefined, what: string): void {
	if (!sound) return;

	sound.Stop();
	sound.Play();

	if (DEBUG_CONFIG.VERBOSE_LOGS) print(`[Audio] ${what} — ${sound.SoundId}`);
}

/**
 * Reads one of this project's numeric attributes, or nought.
 *
 * **Validated rather than trusted**, the way `SuperHudController.multiBallLeftOf` and `abilityOn` both are:
 * the value comes from a server that could be a newer build, and `0` is the answer that makes nothing
 * happen rather than the answer that breaks a watcher. A body that has never collected anything has no
 * attribute at all, which is the same answer as `0` and the same empty case.
 */
function countOn(instance: Instance, attribute: string): number {
	const value = instance.GetAttribute(attribute);

	return typeIs(value, "number") ? value : 0;
}

/**
 * Fires the pickup sound when **this player's own character** collects a ball.
 *
 * **The counter is the server's, and it is the only way to get this right.** A ball arrives in a hand four
 * ways — collected off the arena, caught out of the air, handed over at the start of a round, refilled by a
 * MultiBall window — and all four end with `BallService.attachToHand` parenting the ball to the character.
 * So `Character.ChildAdded` fires for all four and cannot say which happened; a sound hung on it would fire
 * on catches (already a sound on the server, at the catcher, which is where that one belongs), on every
 * round's hand-out, and on every MultiBall refill. `pickupBall` is the one server method that is *only* a
 * pickup, so it is the one that publishes, and this reads what it published. See
 * `PICKUP_COUNT_ATTRIBUTE` for why a counter and not a flag.
 *
 * **Only the local player's character is watched**, which is the whole of the "do not play this for other
 * players or rigs" requirement: `Players.LocalPlayer.Character` is this client's body, there is no second
 * subscription anywhere, and a rig's copy of the same attribute is on an instance nothing here holds.
 * Nothing has to filter, so nothing can filter wrongly.
 *
 * **A body that arrives later is wired when it arrives.** A character can already exist when this module
 * starts (it runs at client boot, which is before the first spawn only by convention), and every respawn
 * makes a new `Model` with a new attribute table — so the current body is wired if it is there and
 * `CharacterAdded` covers the rest. A connection to a destroyed body's attribute signal dies with the body
 * rather than needing to be disconnected by hand.
 */
function watchPickups(): void {
	const player = Players.LocalPlayer;

	const watch = (character: Model) => {
		// **Seeded with the count as it stands**, so the first change seen is a pickup rather than the state
		// this body arrived with. Without it, a body that spawned holding a ball would be checked against a
		// remembered nought and report a collection that never happened.
		let last = countOn(character, PICKUP_COUNT_ATTRIBUTE);

		character.GetAttributeChangedSignal(PICKUP_COUNT_ATTRIBUTE).Connect(() => {
			const count = countOn(character, PICKUP_COUNT_ATTRIBUTE);

			if (count > last) play(pickupSound, `${player.Name} collected a ball`);

			last = count;
		});
	};

	const current = player.Character;
	if (current) watch(current);

	player.CharacterAdded.Connect(watch);
}

/**
 * Fires the ability sound when a MultiBall window **opens**, read from what the server publishes.
 *
 * **Not the key press, and the difference is the whole of decision three.** MultiBall can be reached two
 * ways — the dev shortcut's own key, and the power key that spends whatever the mystery box rolled — and
 * both are only *requests*: the server refuses them for a player who does not own the power, has no charge
 * and no prize, or is not in a round. A sound at the key would therefore fire on refusals, teaching a
 * player that a press always works, and it would need two hooks to cover two keys. The attribute the server
 * publishes when a window opens is one signal, already confirmed, and it is the same one
 * `SuperHudController` draws the MultiBall icon from.
 *
 * **Only the transition from nothing to something**, because the same attribute moves on the way out too:
 * every throw spent publishes a decremented count, and the last one publishes `0`. Those are throws, not
 * spends — the window was announced when it opened — so a count that went *down* is silent, and so is the
 * close. `last === 0` rather than a comparison against the previous value alone, because a window is
 * always opened from nought: nothing raises the count except `SuperService.activateMultiBall`, which is the
 * one thing this sound is for.
 *
 * **A refused second press is therefore silent by construction.** `activateMultiBall` answers `false` for a
 * window that is already open, publishes nothing, and the count does not move — see that method for the
 * rule, and note that this needs no copy of it.
 */
function watchMultiBalls(): void {
	const player = Players.LocalPlayer;
	let last = countOn(player, SUPER_MULTI_BALL_COUNT_ATTRIBUTE);

	player.GetAttributeChangedSignal(SUPER_MULTI_BALL_COUNT_ATTRIBUTE).Connect(() => {
		const count = countOn(player, SUPER_MULTI_BALL_COUNT_ATTRIBUTE);

		if (count > 0 && last === 0) play(abilitySound, `${player.Name} opened a MultiBall window`);

		last = count;
	});
}
