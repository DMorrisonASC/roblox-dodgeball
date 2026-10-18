import Fusion from "@rbxts/fusion-3.0";
import { Players, TweenService } from "@rbxts/services";
import { CATCH_ANIMATION_ATTRIBUTE } from "shared/constants";
import { events } from "shared/networking";
import { hudTheme, UI_FONT } from "./ui/hudTheme";
import { getHudScreenGui } from "./ui/screenGui";
import { addViewportConstraint } from "./ui/viewportConstraint";

/** Prints once at boot, and one line per confirmation. */
const DEBUG = true;

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
 * See {@link playSplash} for the five steps and {@link SPLASH_EASING} for the one that decides how it feels.
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
 * body that caught, set to `"catch"` by `BallService.catchBall` — the one place a ball ends up in a hand,
 * whoever caught it. **So the local character's own attribute is the signal**, watched per character because a
 * new body is a new attribute holder. The cost is stated at the listener: two catches inside one mark's window
 * are one attribute *value*, so the second writes nothing and this module hears nothing.
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
 *   {@link playSplash} for why that is the right trade for MultiBall, and for the generation token that makes an
 *   interrupted sequence stop rather than hide the splash that replaced it. **Hits within one throw are not
 *   replaced at all: they are summed** — see the aggregation section above for the window and the token.
 * - **Not a toast any more.** `mountToast`, its column slot and the two-second hold are all gone with the
 *   `Alert`; what replaces them are the splash's own five steps, below, and a hold short enough to be a beat
 *   rather than a message.
 * - **Not a scoreboard.** The caption says *how big the throw was*, once, and then it is gone — nothing here
 *   totals a match, remembers a best, or reports anything to the server. A count that is still on screen when
 *   the next throw lands has already been replaced.
 */
export function startHitConfirm(): void {
	// **Said at boot**, for the reason `hitVfx` says its own: a module with a subscription and no Flamework
	// controller around it is started by hand from `main.client.ts`, and a toast that never fires and one that
	// was never wired print the same nothing.
	if (DEBUG) print(`[HUD] splash up — "${HIT_TEXT}" … "${WIPEOUT_TEXT}" on a throw I land, "${CATCH_TEXT}" on every catch`);

	const theme = hudTheme();
	const scope = Fusion.scoped();

	// **Built once here, at mount, rather than on the frame a hit lands.** The first splash is the one moment
	// that must not pay for anything: a `Frame`, a label, a stroke and a `UIScale` are a handful of instance
	// constructions, and doing them inside a `hitImpact` handler would put them in the same frame as the impact
	// the player is watching. The price is an invisible label over the game for a session — `Visible = false` and
	// `TextTransparency = 1` until the first success — which is the cheaper of the two.
	const parts = buildSplash(scope, theme.colors.onAccent, theme.colors.trough);

	// **The tally a splash is drawn from.** A throw can land on several bodies — a Pierce ball goes through
	// three — and each body is its own `hitImpact`, so a splash per event would say `HIT!` three times in a
	// fifth of a second and never say the thing worth saying. Hits are counted for {@link HIT_WINDOW_SECONDS}
	// and the total is captioned once.
	const tally = { count: 0, power: false };

	// **The token that ends a tally, bumped by every hit and by a wipe.** A `task.delay` cannot be cancelled,
	// so the token is how a later hit both *extends* the window and disowns the earlier timer — the pattern
	// `playSplash` already uses for its own sequence. An object rather than two `let`s so a closure cannot
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

			playSplash(parts, text);

			if (DEBUG) print(`[HUD] splash — ${text} (${count} hit(s)${power ? ", power" : ""})`);
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

		playSplash(parts, WIPEOUT_TEXT);

		if (DEBUG) print(`[HUD] splash — ${WIPEOUT_TEXT}`);
	});

	watchOwnCatch(() => {
		playSplash(parts, CATCH_TEXT);

		if (DEBUG) print(`[HUD] splash — ${CATCH_TEXT}`);
	});
}

/** What the splash is made of, named once so the two functions below cannot disagree about it. */
interface SplashParts {
	/**
	 * **The wrapper, and it is the thing whose `Visible` is toggled.**
	 *
	 * The label has a `Visible` too, and turning *that* on while the wrapper is hidden draws nothing at all —
	 * which is what this module did for the length of one edit. A child's visibility is a fact about the child;
	 * a hidden parent hides it regardless, so the parent is the only one worth writing.
	 */
	readonly frame: Frame;

	readonly label: TextLabel;
	readonly scale: UIScale;
	readonly stroke: UIStroke;
}

/**
 * **The one splash, built once and reused**, because there is at most one of these on screen at a time.
 *
 * **A `Frame` wrapper with a `UIScale` on it, and the *why* is the whole of decision two.** The three ways to
 * grow a piece of text are a `Size` tween, a `UIScale`, and `TextScaled` — and `TextScaled` is not an animation
 * at all, it is how the label *fits* its box, so it is the wrong tool for the growth. A `Size` tween would
 * re-run that fitting on every frame, and the text would be re-measured and re-kerned sixty times during a
 * 0.15-second pop, which is where a "snap" starts to shimmer. **`UIScale` is a transform**: the layout size is
 * decided once (a fixed pixel box, capped by the viewport) and the scale multiplies it afterwards, so the pop
 * costs nothing per frame and the text is measured exactly once. That is the one that snaps.
 *
 * **`TextScaled` is still what sizes the letters within that box**, which is the responsive requirement rather
 * than a preference: the label fills its frame and the frame is capped by {@link addViewportConstraint}, so a
 * phone gets smaller letters and an ultrawide gets no larger than {@link SPLASH_WIDTH}. A pixel font size here
 * would be one number that is right on exactly one screen.
 *
 * **The stroke is the legibility half**, and it wraps the *letters* rather than the label — see
 * `ApplyStrokeMode.Contextual` in the body, which is the whole difference between an outline and a black box.
 * **The pair is white text inside the theme's near-black outline**, which is the one combination that survives
 * a bright court, a dark rig and everything between. **The colour carries no meaning on purpose**: the two
 * outcomes are told apart by their words, because a caption that is up for half a second cannot also spend that
 * half-second teaching a colour code. Both colours come from the theme — **nothing here is a
 * `Color3.fromRGB`**, which is the rule that keeps a palette change to one file.
 */
function buildSplash(scope: Fusion.Scope<unknown>, textColour: Color3, outline: Color3): SplashParts {
	const frame = Fusion.New(scope, "Frame")({
		Name: SPLASH_NAME,
		// **Anchored in the middle and placed high**, not at `0.5, 0.5`: the crosshair and the arena's own
		// centre are what the player is looking at, and a word over them is a word in the way. `0.26` of the
		// region is the upper third, above the line the throw arc is read along and below the round's top
		// readouts — see `screenGui.ts`'s `COLUMN_TOP_INSET` for the band it must clear.
		AnchorPoint: new Vector2(0.5, 0.5),
		Position: new UDim2(0.3, 0, SPLASH_TOP_FRACTION, 0),
		Size: UDim2.fromOffset(SPLASH_WIDTH, SPLASH_HEIGHT),
		BackgroundTransparency: 1,
		Visible: false,
	});

	// **The phone and ultrawide caps, in one call**, because a pixel box is correct on the screen it was chosen
	// on and only there: 760 pixels is two thirds of a 1080p width and wider than a phone's whole viewport.
	addViewportConstraint(scope, frame, { maxFraction: SPLASH_MAX_FRACTION });

	const label = Fusion.New(scope, "TextLabel")({
		Name: "Word",
		Parent: frame,
		Size: UDim2.fromScale(1, 1),
		BackgroundTransparency: 1,
		Font: UI_FONT,
		// **The colour the word will be, written once here rather than per splash.** Both outcomes are white
		// now, so there is nothing for a `playSplash` call to decide — a colour argument on it would be a
		// parameter with one value, which is a knob that lies about being a knob.
		//
		// **The text starts empty rather than at one of the ladder's words**, because there is no default
		// caption: the word is chosen per throw by `textForHits`, and a label holding `HIT!` until then would
		// be a third place the ladder is written, one that would keep saying `HIT!` if the ladder changed.
		Text: "",
		TextColor3: textColour,
		TextScaled: true,
		TextWrapped: true,
		TextXAlignment: Enum.TextXAlignment.Center,
		TextYAlignment: Enum.TextYAlignment.Center,
		// **Transparent until a splash plays**, so the label existing changes nothing on screen.
		TextTransparency: 1,
	});

	// Plain `Instance`s rather than `Fusion.New`, because neither is a value the graph ever drives: the scale is
	// written by a tween and read by nobody, and the stroke is configured once. `Fusion.New` exists to make a
	// property reactive, and a reactive property here would fight the tween for the same number.
	const stroke = new Instance("UIStroke");
	stroke.Name = "Outline";
	// **`Contextual`, which is the whole of "outline the letters" — and the fix for a black box around the
	// word.** `Border` is the other mode, and it strokes the *element's own rectangle*: a label is a 760 × 150
	// invisible box with a line of text somewhere inside it, so a `Border` stroke draws that box and puts
	// nothing around the glyphs at all. On anything meant to outline text the mode is always `Contextual`;
	// `Border` is for panels and buttons.
	stroke.ApplyStrokeMode = Enum.ApplyStrokeMode.Contextual;
	stroke.Color = outline;
	stroke.Thickness = SPLASH_STROKE_THICKNESS;
	stroke.Transparency = 1;
	stroke.Parent = label;

	const scale = new Instance("UIScale");
	scale.Name = "Pop";
	scale.Scale = 1;
	// **On the frame, not on the label.** A `UIScale` grows its instance about that instance's anchor point, so
	// the frame's `AnchorPoint` of `(0.5, 0.5)` is what makes the word expand from its own centre rather than
	// from a corner — and the frame is the thing with the anchor.
	scale.Parent = frame;

	frame.Parent = getHudScreenGui();

	return { frame: frame, label: label, scale: scale, stroke: stroke };
}

/**
 * **The five steps, and the token that lets a second success interrupt the first.**
 *
 * 1. **Reset** — scale to `0`, text and stroke opaque, visible. Everything the previous splash left is
 *    overwritten in one resumption, so a splash that was interrupted mid-fade does not inherit an alpha.
 * 2. **Pop in** — scale to {@link SPLASH_OVERSHOOT} in {@link SPLASH_IN_SECONDS}, **`Back`/`Out`**, which is
 *    the one that makes it feel like a Wii Sports caption: the curve overshoots past the target and settles
 *    back onto it, so the word arrives *at* the viewer rather than growing toward them.
 * 3. **Settle** — back to `1.0` in {@link SPLASH_SETTLE_SECONDS}. The overshoot in step 2 is the snap; this is
 *    the rebound that leaves the word at its resting size, and it is `Quad` rather than `Back` so the rebound
 *    does not add a *second* bounce — one overshoot reads as impact, two read as a wobble.
 * 4. **Hold** — {@link SPLASH_HOLD_SECONDS}, long enough to read a caption without becoming a message.
 * 5. **Fade** — text and stroke to fully transparent, `Quad`/`In`, then `Visible = false`. The outline fades
 *    with the letters rather than after them, because an outline that outlived its word would be a visible
 *    outline of nothing.
 *
 * **Replace rather than queue, and the reason is MultiBall.** A rig's MultiBall window throws five times in a
 * few seconds, and a player can land two of them inside a tenth of a second; a queue would still be drawing
 * the first `HIT!` while the second hit is being read, which is a splash describing an older moment than the
 * one on screen. **Replacing can cut the first one short, and that is the trade taken**: the newest success is
 * the one worth showing, and the splash is a caption rather than a message, so nothing is lost by retiring it
 * early. What *would* break is the interrupted sequence's own timers — they are still sleeping — so every
 * splash carries {@link splashToken}'s value, and a sequence whose token is stale returns at its next step
 * instead of hiding or fading the splash that replaced it. That is the same "a timer can only be ignored"
 * pattern `LobbyRigService`'s dismissal used, moved here when the toast went.
 */
function playSplash(parts: SplashParts, text: string): void {
	splashToken += 1;
	const token = splashToken;

	// **Stop what the last splash is still doing, and this is not the same job as the token.** The token makes
	// an interrupted *sequence* return at its next step; it cannot stop a tween that is already running, and a
	// fade in flight would go on driving `TextTransparency` to `1` underneath the opaque word this call is about
	// to write. So the tweens are cancelled here — before the reset — and every tween a splash starts is
	// recorded for exactly this line.
	for (const running of activeTweens) running.Cancel();

	activeTweens = new Array<Tween>();

	// **The word, and not its colour.** The label's colour is white for both outcomes and is written once, in
	// `buildSplash`, so there is nothing here for a call to decide — see that function for why the difference
	// between a hit and a catch is the word rather than the colour.
	parts.label.Text = text;
	parts.label.TextTransparency = 0;
	// **The wrapper, not the label** — a hidden parent hides its children whatever their own `Visible` says.
	// See `SplashParts.frame`.
	parts.frame.Visible = true;
	parts.stroke.Transparency = SPLASH_STROKE_TRANSPARENCY;
	parts.scale.Scale = 0;

	task.spawn(() => {
		const popIn = TweenService.Create(
			parts.scale,
			new TweenInfo(SPLASH_IN_SECONDS, SPLASH_EASING, Enum.EasingDirection.Out),
			{ Scale: SPLASH_OVERSHOOT },
		);
		activeTweens.push(popIn);
		popIn.Play();
		popIn.Completed.Wait();
		if (token !== splashToken) return;

		const settle = TweenService.Create(
			parts.scale,
			new TweenInfo(SPLASH_SETTLE_SECONDS, SPLASH_SETTLE_EASING, Enum.EasingDirection.Out),
			{ Scale: 1 },
		);
		activeTweens.push(settle);
		settle.Play();
		settle.Completed.Wait();
		if (token !== splashToken) return;

		task.wait(SPLASH_HOLD_SECONDS);
		if (token !== splashToken) return;

		const fadeInfo = new TweenInfo(SPLASH_OUT_SECONDS, SPLASH_OUT_EASING, Enum.EasingDirection.In);
		const fadeText = TweenService.Create(parts.label, fadeInfo, { TextTransparency: 1 });
		const fadeStroke = TweenService.Create(parts.stroke, fadeInfo, { Transparency: 1 });
		activeTweens.push(fadeText);
		activeTweens.push(fadeStroke);
		fadeText.Play();
		fadeStroke.Play();
		fadeText.Completed.Wait();
		if (token !== splashToken) return;

		parts.frame.Visible = false;
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

/** The splash's name in the GUI, so it can be found by the same name in a log or the Explorer. */
const SPLASH_NAME = "ActionSplash";

/**
 * The splash's box, in pixels, and **the one pair of numbers here that is a design size rather than a tuned
 * one.** `TextScaled` fills whatever box it is given, so this is "how big the word is", and the viewport cap
 * below is what turns it into "how big it may be *here*".
 *
 * **760 × 150 is a word about a seventh of a 1080p screen tall** — big enough to read without looking away
 * from the arena, small enough that it covers nothing the next throw needs. **Placeholder.**
 */
const SPLASH_WIDTH = 760;
const SPLASH_HEIGHT = 150;

/**
 * Where the splash sits, as a fraction of the region the HUD is in — **the upper third, not the middle.**
 *
 * **The middle of the screen is where the game is being aimed at.** The aim sight is at `(0.5, 0.5)`, the throw
 * arc is read along the centre line, and the body being thrown at is on it; a word over that is a word in the
 * way of the next throw. `0.26` clears the round's own top readouts — a column starting 14 pixels below the top
 * and about 90 pixels tall in the worst case, see `screenGui.ts`'s `COLUMN_TOP_INSET` — and stays well above the
 * crosshair. **Placeholder.**
 */
const SPLASH_TOP_FRACTION = 0.26;

/**
 * The most of the viewport the splash may take — **the phone and ultrawide cap**, handed to
 * {@link addViewportConstraint} and read there as "whichever is tighter" against the pixel box above.
 *
 * **86 % across leaves a margin**, because a label touching both edges is clipped by a pixel of rounding on a
 * narrow screen; **24 % down is a quarter of the screen's height**, which is what stops a landscape phone from
 * giving the word a box taller than the arena is drawn on. Neither binds at a desktop size, which is the point
 * of a cap rather than a size. **Placeholder.**
 */
const SPLASH_MAX_FRACTION = new Vector2(0.86, 0.24);

/**
 * How thick the word's outline is, in pixels. **Placeholder — 4.**
 *
 * **An outline rather than a shadow**, because what it has to survive is a bright court behind bright letters:
 * a shadow separates a word from a *dark* background, an outline separates it from any background at all.
 */
const SPLASH_STROKE_THICKNESS = 4;

/**
 * How opaque the outline is while the word is up — `0` is fully opaque, so this is very slightly transparent.
 * **Placeholder — 0.15.**
 *
 * **Not full strength, and the reason is taste rather than legibility.** A black outline at full opacity around
 * a 150-pixel word reads as a sticker; a breath of transparency lets the court into the edge, and the letters
 * stay the loudest thing in the frame.
 */
const SPLASH_STROKE_TRANSPARENCY = 0.15;

/**
 * How long the pop takes, in seconds. **Placeholder — 0.15.**
 *
 * **Short enough to be a snap rather than a grow.** A scale animation reads as *something happening* until about
 * a fifth of a second; past that it reads as an element arriving, which is a different feeling. This is the one
 * number to lengthen if a hit ever reads as twitchy, and shortening it past about a tenth loses the overshoot
 * entirely — at that point the eye sees only the final size.
 */
const SPLASH_IN_SECONDS = 0.15;

/** The rebound from the overshoot back to rest, in seconds. **Placeholder — 0.1.** */
const SPLASH_SETTLE_SECONDS = 0.1;

/**
 * How far past full size the pop goes, as a scale. **Placeholder — 1.15.**
 *
 * **A small overshoot, because the easing already overshoots.** `Back`/`Out` travels past its destination and
 * returns to it, so the visible peak is this number plus the curve's own excursion. Larger and the word reads
 * as a punch-in on a combat hit rather than as a confirmation; smaller and the overshoot is invisible beside the
 * easing's own.
 */
const SPLASH_OVERSHOOT = 1.15;

/** How long the word rests at full size before fading, in seconds. **Placeholder — 0.5.** */
const SPLASH_HOLD_SECONDS = 0.5;

/** How long the fade takes, in seconds. **Placeholder — 0.2.** */
const SPLASH_OUT_SECONDS = 0.2;

/**
 * **The easing the pop uses — the number that decides whether this reads as arcade or as UI.**
 *
 * **`Back`/`Out`, and `Elastic` was considered and refused.** `Elastic` is the more literally "Wii Sports"
 * curve, and it is too bouncy for the frequency: a hit lands several times a round and a MultiBall window can
 * land three inside two seconds, so a curve that wobbles for half a second is a curve that is *still wobbling*
 * when the next hit arrives — the splashes would overlap into one vibrating word. `Back` overshoots once and
 * stops, which is the arcade feel with a shape that survives being played every few seconds.
 *
 * **Placeholder**, in the sense that it is the value to change if the splash reads wrong: `Quad` is the calm
 * alternative and `Quint` the sharper one. It is a *constant* rather than a literal inside the tween because
 * the settle and the fade have styles beside it, and three `Enum.EasingStyle` literals in one function is how a
 * person ends up editing the wrong one.
 */
const SPLASH_EASING: Enum.EasingStyle = Enum.EasingStyle.Back;

/**
 * The easing the rebound uses. **`Quad` rather than `Back`, deliberately.**
 *
 * **One overshoot reads as impact; two read as a wobble.** The pop already carries the overshoot, so running
 * the settle on `Back` as well would add a second, smaller bounce *after* the word had arrived — which is the
 * `Elastic` problem in miniature. `Quad`/`Out` closes the last fifteen per cent smoothly.
 */
const SPLASH_SETTLE_EASING: Enum.EasingStyle = Enum.EasingStyle.Quad;

/**
 * The easing the fade uses — `Quad`/`In`, so the word leaves slowly and then is gone rather than dropping at
 * once. **Placeholder.**
 */
const SPLASH_OUT_EASING: Enum.EasingStyle = Enum.EasingStyle.Quad;

/**
 * Bumped by every splash, and captured by every step of the sequence that plays one.
 *
 * **The house pattern for a run of timers that cannot be cancelled.** A tween already playing and a
 * `task.wait` already sleeping can only be *ignored*, so each step acts only while the token it captured is
 * still current — which is what makes "replace" work: an interrupted splash returns at its next step instead
 * of hiding or fading the splash that replaced it. See {@link playSplash}.
 */
let splashToken = 0;

/**
 * Every tween the splash has started and not yet finished — **the list that lets a replacement stop the last
 * one mid-flight.**
 *
 * **The token alone is not enough, which is why this exists beside it.** A token stops a *sequence* from
 * taking its next step; a tween that is already playing goes on writing its property until it finishes, and a
 * fade cancelled only politically would keep the word invisible under a splash that had just made it opaque.
 * `Tween.Cancel()` is the only thing that stops one.
 *
 * **Rebuilt rather than trimmed.** The list holds at most three tweens and is thrown away by the next splash,
 * so there is nothing to prune — and this build's `Array` has no `clear` to prune with. A finished tween left
 * on the list is harmless: `Cancel()` on a completed tween does nothing.
 */
let activeTweens = new Array<Tween>();
