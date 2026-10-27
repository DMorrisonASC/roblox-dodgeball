import Fusion from "@rbxts/fusion-3.0";
import { Players } from "@rbxts/services";
import { CATCH_ANIMATION_ATTRIBUTE } from "shared/constants";
import { events } from "shared/networking";
import { logDebug } from "shared/logger";
import { createActionSplash } from "./ui/actionSplash";
import { getHudScreenGui } from "./ui/screenGui";

/**
 * # The action splash — "HIT!" and "CAUGHT IT!", Wii Sports style
 *
 * **A splash, not a toast, and the difference is the whole of this revision.** The pixels that say a hit
 * landed are `hitVfx`'s, drawn on the victim's body; this is the *word* for it, on the local player's own
 * screen, and it exists because a gold burst on a rig fifteen studs away is a thing you have to *be looking
 * at* to notice. It used to be a two-line `Alert` in the bottom-centre toast column — a receipt, read in the
 * same order and the same voice as a cooldown warning. It is now a short line high on the screen that **pops**:
 * a `Back`-eased scale that overshoots past full size and settles back, holds, and fades. The change is
 * physical rather than cosmetic, because a success is a moment rather than a statement about the game's state.
 * See `ui/actionSplash.ts` for the five steps, the easing that decides how it feels, and the box the word is
 * drawn in — **this file decides *which word* and *when*, and that file decides what a splash is made of**.
 *
 * **The event is `hitImpact`, and that choice is the whole of whether this works at all.** `roundHit` — the
 * event the hit feed reads — is sent only for hits with a person at both ends (`RoundService.logHit` is
 * reached only when the thrower is a `Player` *and* the victim is), so a player's throw that lands on a rig
 * produces no `roundHit` at all — and a rig is most of what a player hits in a round against them. **A "you
 * hit" splash built on the feed's event would be silent for exactly the hits a player cares about.** See
 * `networking.ts` on `hitImpact`.
 *
 * **It fires in every phase, which is both a feature and the way this is tuned.** `hitImpact` is sent before
 * `registerHit`'s round gate, so a hit on a practice dummy splashes exactly as a hit in a round does — a
 * player practising gets the feedback they get in a match, and the splash is a thing that has to be *watched*
 * to be judged, which needs somewhere a player can throw without a round's clock running.
 *
 * **It subscribes in its own right rather than being called from `HitLogController`.** That reader is the
 * feed's, and the feed is about the *round* rather than about the player: it draws the same list on every
 * machine and deliberately no longer knows who is playing it. It also reads the event this one cannot use. So
 * the decision "this hit was mine" is made here, by comparing the thrower's name against
 * `Players.LocalPlayer.Name` — one comparison, against a payload that already carries the name.
 *
 * **Nothing needs resolving and nothing needs looking up**, which is worth stating because `hitVfx` does far
 * more work for less: the splash draws a word out of a fixed ladder, so the payload has to answer only *was this
 * mine* and *was it powered* — the thrower's name and an ability string, both of which the wire carries.
 * **The ability is resolved on the server rather than here**, because the attributes that record it
 * (`BALL_ABILITY_ATTRIBUTE` on the ball, `ARMED_ABILITY_ATTRIBUTE` on the thrower) are gone by the time the
 * impact is drawn — the ball has been destroyed and the arm has been spent — so a client reading them reads
 * nothing. **There is no unresolved-name case to decide here at all**, unlike every other reader of a body in
 * this codebase: the variant that read the victim's name went with the `Alert`, because a word that has to be
 * laid out around a name of unknown length is a word whose size depends on who was hit.
 *
 * **The catch half reads an attribute rather than an event, and that is what the server actually publishes.**
 * There is no "you caught one" event addressed to the catcher: `caughtThrow` is about the *thrower* being
 * punished — it goes out from `RoundService.resolveCaughtThrower`, past guards that drop a friendly catch and
 * a catch between rounds, so a client listening to it would splash for enemy catches only and stay silent for
 * a ball taken out of the air in the lobby. What *every* catch publishes is `CATCH_ANIMATION_ATTRIBUTE` on the
 * body that caught, set to `"catch"` by `BallService.completePull` when the ball reaches the hand — the one place
 * a ball ends up in a hand, whoever caught it. **So the local character's own attribute is the signal**, watched
 * per character because a new body is a new attribute holder. The cost is stated at the listener: two catches
 * inside one mark's window are one attribute *value*, so the second writes nothing and this module hears nothing.
 *
 * ## How one throw becomes one caption
 *
 * **Hits are collected, not splashed.** A throw can take several bodies at once — a Pierce ball goes through a
 * line, a MultiBall throw is one throw on several paths — and every body is its own `hitImpact`. Drawing per
 * event would show `HIT!` three times in a fifth of a second and never say the thing worth saying, so the events
 * are counted into a tally and captioned once, {@link HIT_WINDOW_SECONDS} after the **last** of them. Nothing is
 * buffered: the tally is two numbers and a token, because the caption only ever depends on *how many* and *was
 * it powered*.
 *
 * **The caption is a ladder, and power is a second axis.** `HIT!` → `DOUBLE HIT!` → `TRIPLE HIT!` →
 * `MULTI HIT!` for a plain throw, `SMASH!` → `RAMPAGE!` for one that carried an ability — see
 * {@link textForHits}, which is the whole rule, and the constants beside it for the thresholds. **A catch is not
 * on the ladder**: it is one ball in one pair of hands, so there is no count to escalate and it keeps its own
 * single word.
 *
 * **`WIPEOUT!` outranks everything, and it is the one caption this client cannot work out for itself.** It means
 * the throw removed the last member of a team — a fact about the round's roster rather than about any one body —
 * so the server confirms it with its own event, sent to the thrower alone. It also cancels a tally in flight and
 * refuses the hits for a moment after it, because those hits are the ones it is *about*.
 *
 * ## What this is not
 *
 * - **Not a VFX, and nothing is cloned.** Text on the screen: no template, no `ReplicatedStorage` lookup, no
 *   `Debris`. See `hitVfx` for the pixels.
 * - **Not fired when the player is hit.** Being hit is the red effect on your own body and nothing here. Only
 *   the thrower sees a confirmation, because a confirmation is about having *done* something.
 * - **Not a change to the hit log, the damage or the effects.** It reads `hitImpact`, an event the server
 *   already sends; the only server change this feature ever needed was moving that send ahead of the round gate
 *   so it fires in every phase — see `RoundService.registerHit`. The round's records, the damage and `hitVfx`
 *   are untouched.
 * - **Not queued.** A second *throw* replaces the splash on screen rather than waiting behind the first — see
 *   `ActionSplash.pop` in `ui/actionSplash.ts` for why that is the right trade for MultiBall, and for the
 *   generation token that makes an interrupted sequence stop rather than hide the splash that replaced it.
 *   **Hits within one throw are not replaced at all: they are summed** — see the aggregation section above for
 *   the window and the token.
 * - **Not a toast any more.** The `Alert`-based toast, its column slot and the two-second hold are all gone —
 *   `ui/hudToast.ts` went with the last of them and has since been deleted; what replaces them are the splash's
 *   own five steps, in `ui/actionSplash.ts`, and a hold short enough to be a beat rather than a message.
 * - **Not a scoreboard.** The caption says *how big the throw was*, once, and then it is gone — nothing here
 *   totals a match, remembers a best, or reports anything to the server. A count that is still on screen when
 *   the next throw lands has already been replaced.
 */
export function startHitConfirm(): void {
	// **Said at boot**, for the reason `hitVfx` says its own: a module with a subscription and no Flamework
	// controller around it is started by hand from `main.client.ts`, and a toast that never fires and one that
	// was never wired print the same nothing.
	logDebug(`[HUD] splash up — "${HIT_TEXT}" … "${WIPEOUT_TEXT}" on a throw I land, "${CATCH_TEXT}" on every catch`);

	const scope = Fusion.scoped();

	// **Built once here, at mount, rather than on the frame a hit lands.** The first splash is the one moment
	// that must not pay for anything: a `Frame`, a label, a stroke and a `UIScale` are a handful of instance
	// constructions, and doing them inside a `hitImpact` handler would put them in the same frame as the impact
	// the player is watching. The price is an invisible label over the game for a session — `Visible = false` and
	// `TextTransparency = 1` until the first success — which is the cheaper of the two.
	//
	// **The theme is not read here any more.** It was, for two colours passed straight into the splash's
	// constructor; `createActionSplash` reads `hudTheme()` itself on every call, which is what makes a palette
	// change one file rather than a search for the arguments that used to carry it.
	const splash = createActionSplash(scope, getHudScreenGui());

	// **The tally a splash is drawn from.** A throw can land on several bodies — a Pierce ball goes through
	// three — and each body is its own `hitImpact`, so a splash per event would say `HIT!` three times in a
	// fifth of a second and never say the thing worth saying. Hits are counted for {@link HIT_WINDOW_SECONDS}
	// and the total is captioned once.
	const tally = { count: 0, power: false };

	// **The token that ends a tally, bumped by every hit and by a wipe.** A `task.delay` cannot be cancelled,
	// so the token is how a later hit both *extends* the window and disowns the earlier timer — the pattern
	// `ActionSplash.pop` already uses for its own sequence. An object rather than two `let`s so a closure cannot
	// capture one half of the tally and disagree with the other.
	let tallyToken = 0;

	// **A wipe owns the caption, so nothing that hit before it may arrive after it and take it back.** The two
	// events travel on separate remotes and nothing here guarantees their order; without this, a `HIT!` sent a
	// millisecond before the wipe could be delivered after it and replace `WIPEOUT!` when its window closed.
	let wipeGuardUntil = 0;

	events.Client.Get("hitImpact").Connect((_victim, thrower, ability) => {
		// **The whole trigger: this client is the thrower.** Not the victim — that is the red effect and no
		// splash — not a bystander, and not a rig's throw that landed on somebody else. The comparison is
		// against the name the payload carries, which is the player's name when the throw was a player's.
		//
		// **The victim's name is deliberately not read.** The caption is a count, not a roll call; a name would
		// have to be laid out beside the word and would make the splash's size depend on who was hit.
		// `hitVfx` still says *who* — it draws the burst on the body.
		if (thrower !== Players.LocalPlayer.Name) return;

		// **A wipe already owns the screen.** These are the hits the wipe is *about*, so dropping the count
		// costs nothing — see `wipeGuardUntil` for why the order cannot be assumed.
		if (os.clock() < wipeGuardUntil) return;

		tally.count += 1;

		// **A power anywhere in the window makes the whole window a power.** A Pierce ball names itself on
		// every body it touches, so in the ordinary case this is the same value three times; `||` keeps a
		// mixed window — one marked ball and one plain one inside the same 0.15 s — reading as the power it
		// contained rather than as whichever landed last.
		tally.power = tally.power || ability !== "";

		tallyToken += 1;
		const token = tallyToken;

		task.delay(HIT_WINDOW_SECONDS, () => {
			if (token !== tallyToken) return;

			const count = tally.count;
			const power = tally.power;

			tally.count = 0;
			tally.power = false;

			const text = textForHits(count, power);

			splash.pop(text);

			logDebug(`[HUD] splash — ${text} (${count} hit(s)${power ? ", power" : ""})`);
		});
	});

	events.Client.Get("teamWipe").Connect((thrower) => {
		// **Server-confirmed, and the only caption the server decides.** See `networking.ts` on `teamWipe`:
		// a client cannot know that the body it just hit was the last one on its side, nor what a mode makes
		// of an empty side, so the answer has to come from the machine that owns the round.
		if (thrower !== Players.LocalPlayer.Name) return;

		// **The window the throw opened is closed rather than flushed.** It is holding the hits that *are*
		// this wipe, so flushing it would draw `MULTI HIT!` and then `WIPEOUT!` on top of it — two captions
		// for one throw, the smaller one first.
		tallyToken += 1;
		tally.count = 0;
		tally.power = false;

		wipeGuardUntil = os.clock() + WIPE_GUARD_SECONDS;

		splash.pop(WIPEOUT_TEXT);

		logDebug(`[HUD] splash — ${WIPEOUT_TEXT}`);
	});

	watchOwnCatch(() => {
		splash.pop(CATCH_TEXT);

		logDebug(`[HUD] splash — ${CATCH_TEXT}`);
	});
}

/**
 * **Calls `onCatch` when this client's own body catches a ball** — the one success the server publishes as an
 * attribute rather than as an event addressed to the catcher.
 *
 * **Per character, because the attribute holder is.** `CATCH_ANIMATION_ATTRIBUTE` lives on the model that
 * caught, and a player's model is replaced on every death — so a connection made once at boot would be
 * watching a body that is no longer in the world. The old connection is dropped on `CharacterAdded` before the
 * new one is made, which is what keeps a session of deaths from accumulating listeners on dead bodies.
 *
 * **`"catch"` and not `"attempt"`**, which is the whole distinction the attribute was made a string for: an
 * attempt is a window opening, and a splash for reaching would fire on every failed reach. `undefined` — the
 * mark expiring — is the third value and is ignored like everything that is not `"catch"`.
 *
 * **The window this cannot see, stated rather than left to be found:** a second catch inside a live mark
 * writes `"catch"` over `"catch"`, and a property written with the value it already holds raises no changed
 * signal — so two catches closer together than `CATCH_CONFIG.CATCH_ANIMATION_SECONDS` splash once. That is the
 * attribute's own behaviour and every other reader has it too; the alternative is a per-catch event, which is a
 * new network message for one word on one screen.
 */
function watchOwnCatch(onCatch: () => void): void {
	const player = Players.LocalPlayer;

	let connection: RBXScriptConnection | undefined;

	const watch = (character: Model) => {
		connection?.Disconnect();

		connection = character.GetAttributeChangedSignal(CATCH_ANIMATION_ATTRIBUTE).Connect(() => {
			if (character.GetAttribute(CATCH_ANIMATION_ATTRIBUTE) !== "catch") return;

			onCatch();
		});
	};

	player.CharacterAdded.Connect(watch);

	// **A character that already exists**, which is the ordinary case by the time this module starts: the module
	// is started from `main.client.ts`, and a client reconnecting into a live round can have both a body and a
	// `CharacterAdded` that fired before it got here. Without this line the first catch after a reconnect would
	// be silent until the next death.
	if (player.Character !== undefined) watch(player.Character);
}

/**
 * **Which caption a closed window earned — the whole escalation rule, in one place.**
 *
 * **Power first, then count.** The order is the ladder's rather than a preference: a powered throw never says
 * `DOUBLE HIT!`, because the power is the more interesting fact about it and the count is already implied by
 * `SMASH!` / `RAMPAGE!`. Then the counts, highest first, so one comparison cannot swallow another.
 *
 * **`count` is never zero when this is called** — a window is only closed after a hit opened it, and both the
 * closer and the wipe reset the tally after reading it. The last line is therefore the one-body case and not a
 * defensive default; if a future caller ever reached it with `0`, `HIT!` would still be the honest answer for
 * "one or fewer".
 */
function textForHits(count: number, power: boolean): string {
	if (power) return count >= RAMPAGE_BODIES ? RAMPAGE_TEXT : SMASH_TEXT;
	if (count >= MULTI_HIT_BODIES) return MULTI_HIT_TEXT;
	if (count === TRIPLE_HIT_BODIES) return TRIPLE_HIT_TEXT;
	if (count === DOUBLE_HIT_BODIES) return DOUBLE_HIT_TEXT;

	return HIT_TEXT;
}

/**
 * **The caption ladder — every word the splash can say for a throw, and the only place they are written.**
 *
 * **Escalation by count, then by power, and the wipe outranks both.** A single throw is one caption however
 * many bodies it took, which is why these read as a ladder rather than as labels for events: `HIT!` is the
 * floor and `WIPEOUT!` is the ceiling, and a player is meant to feel the number go up. The thresholds are in
 * the constants below rather than here, so a caption and the count that earns it are one line each.
 *
 * **One English string per outcome and no localisation**, on the module doc's rule: the game's text is English,
 * and a splash is the last place to start a second mechanism. **`HIT!` is the user's own choice after watching
 * `TAG!` on screen** — the earlier argument for `TAG!` is recorded rather than re-litigated, because the person
 * who watches the caption is the one who decides what it says.
 */
const HIT_TEXT = "HIT!";
const DOUBLE_HIT_TEXT = "DOUBLE HIT!";
const TRIPLE_HIT_TEXT = "TRIPLE HIT!";
const MULTI_HIT_TEXT = "MULTI HIT!";
const SMASH_TEXT = "SMASH!";
const RAMPAGE_TEXT = "RAMPAGE!";
const WIPEOUT_TEXT = "TEAM WIPE!!";

/**
 * The word a catch says — **`CAUGHT IT!`, the user's own phrasing**, and two words rather than one. Nothing in
 * this file assumes a count: the label is `TextScaled` in a box wide enough for either, so a phrase and a
 * syllable are the same case here. **It is deliberately not on the ladder**: a catch is one ball in one pair of
 * hands, so there is no number to escalate and no power to weigh.
 */
const CATCH_TEXT = "CAUGHT IT!";

/**
 * **How many bodies a throw has to take to earn each count caption** — the numbers the request named, which is
 * why they are not marked placeholder. They are constants rather than literals inside {@link textForHits} so
 * that the ladder can be read in one place and re-tuned in one place, and so the comparisons below cannot drift
 * from the words.
 */
const DOUBLE_HIT_BODIES = 2;
const TRIPLE_HIT_BODIES = 3;
const MULTI_HIT_BODIES = 4;

/**
 * **How many bodies a *powered* throw has to take to reach `RAMPAGE!`** — the second axis of the ladder, and a
 * lower bar than {@link MULTI_HIT_BODIES} on purpose. The power is already the escalation: one or two bodies
 * with a Pierce or a MultiBall is a play that could not have been made without it, and three is a ball going
 * through a line. Asking a powered throw for four would make `RAMPAGE!` the rarer caption than `MULTI HIT!`,
 * which inverts the ladder.
 */
const RAMPAGE_BODIES = 3;

/**
 * How long a throw's hits are collected before one caption is drawn, in seconds. **Placeholder — 0.15.**
 *
 * **A window rather than a per-hit caption, because a throw is one event to the player.** A Pierce ball tags
 * three bodies within the same or adjacent frames, and each one is a separate `hitImpact`; drawing per event
 * would show `HIT!` three times and never `TRIPLE HIT!`. **The window restarts on every hit**, so it is
 * "0.15 s after the *last* body", not "0.15 s after the first" — a burst of hits in one resolution is then
 * always one caption, whatever the ordering of the events.
 *
 * **Short enough to hide behind the impact.** The burst on the last body is already drawing when this closes,
 * and a caption that arrives a fifth of a second after the hit reads as the game catching up. Longer, and the
 * player has looked away; shorter, and two bodies of one Pierce ball can land either side of it — the exact
 * split this exists to prevent.
 */
const HIT_WINDOW_SECONDS = 0.15;

/**
 * How long after a wipe a hit is ignored, in seconds. **Placeholder — 0.4.**
 *
 * **Because `hitImpact` and `teamWipe` are two remote calls and their order is not promised.** A wipe is
 * announced from `eliminate`, which runs one frame after the hit that caused it — so on the wire the hits come
 * first almost always, and "almost" is not a rule. If one arrived late it would open a new window and close it
 * with `HIT!` **over** `WIPEOUT!`, which is the one caption that must not be replaced. This is comfortably
 * longer than {@link HIT_WINDOW_SECONDS} because it only has to outlast a window that the wipe already
 * cancelled.
 */
const WIPE_GUARD_SECONDS = 0.4;

/**
 * **The splash's text is not this module's shape.** The word's box, its position, its outline and the whole
 * five-step pop moved to `ui/actionSplash.ts` when a second caller wanted the same look — see that file for the
 * geometry and the easing, and `ActionSplash.pop` for the sequence. What stays here is the ladder, the window
 * and the wiring: **which word**, and **when**, rather than what a splash is made of.
 */

