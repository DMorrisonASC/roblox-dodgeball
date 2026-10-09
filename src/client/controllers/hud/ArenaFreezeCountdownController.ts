import { Controller, OnStart } from "@flamework/core";
import { Card, Text } from "@rbxts/big-ui";
import Fusion from "@rbxts/fusion-3.0";
import { ContentProvider, Players, ReplicatedStorage, RunService, SoundService, TweenService } from "@rbxts/services";
import { ARENA_CONFIG } from "shared/config/arena.config";
import { AUDIO_CONFIG } from "shared/config/audio.config";
import { TRANSITION_CONFIG, TRANSITION_COVER_SECONDS } from "shared/config/transition.config";
import { ROUND_STATE_ATTRIBUTE, ROUND_STATUS_FOLDER, TEAM_ATTRIBUTE } from "shared/constants";
import { PLAYING, spectating } from "../../panels";
import { getHudScreenGui } from "../../ui/screenGui";
import { HudTheme, hudTheme } from "../../ui/hudTheme";
import { addViewportConstraint } from "../../ui/viewportConstraint";

/** Prints on mount — the line that says the controller ran at all. */
const DEBUG = true;

/**
 * Where the countdown sits in the `ZIndex` order: **above every HUD label, below every panel.**
 *
 * The ladder as the rest of the client writes it down: the ordinary HUDs leave `ZIndex` at its default of
 * `1` — this stack, the score bar, the coin readout, the cooldown card, the spectator label, both toasts —
 * the dock is `5` (`DockController`), the shop and inventory panels are `SHOP_CONFIG.PANEL_Z_INDEX` (`10`),
 * the round-result panel is `20`, and the loading overlay is `30`. The two full-screen GUIs, the join splash
 * and the transition grid, are not on the ladder at all: they order whole `ScreenGui`s by `DisplayOrder`,
 * which beats any `ZIndex` inside either tree — which is why the wipe covers this countdown while it closes,
 * and why nothing here has to know about it.
 *
 * **`2` is the smallest number that says what this is.** It clears every default-`1` label, so the countdown
 * can never be drawn behind the power slot it sits above, and it stays under the dock and the panels so a
 * player who opens the shop mid-freeze sees the panel rather than a number burnt through it. A number in the
 * middle of the screen does not need to fight a panel for the screen; it needs to be legible against the
 * world.
 */
const COUNTDOWN_Z_INDEX = 2;

/**
 * The height of the box one number is drawn in: **one cell, and it is the only fixed size in the element.**
 *
 * **It exists so that the two labels can occupy one cell.** The card lays its children out with a
 * `UIListLayout`, and a list is a *sequence* — while a cross is two numbers in the same place. What a list does
 * let you choose is the gap between cells, so the gap is set to minus this height: the second cell is pulled
 * back by exactly the height of the first and the two land on top of each other. Everything else about the
 * element's box is derived — its width is the widest number's, its height is this plus the card's padding.
 *
 * **`60` rather than the type scale's own line height, and the argument is the coupling rather than the
 * number.** The tallest variant big-ui has is `h4` at `42`, so every variant fits inside this cell — which
 * means the variant can be changed at the label without anybody having to remember that this number is tied to
 * it. A cell of `28`, the `h6` line height, would be exactly right today and wrong the first time a bigger
 * number is asked for.
 *
 * **What this is not: a box the text is confined to.** `ClipsDescendants` is off and the outgoing number
 * finishes at `OUT_SCALE` — well past this height — deliberately, because it is leaving the *screen* rather
 * than the box.
 */
const LABEL_HEIGHT = 60;

/**
 * How long one number takes to cross into the next, in seconds. **Placeholder — 0.35.**
 *
 * **The motion has to finish inside the second it belongs to, with room left to read.** The number changes on
 * the second's boundary, so anything at or above `1` would have two numbers overlapping permanently — the
 * cross would become the state rather than the transition between two states. At 0.35 the number is moving
 * for the first third of its second and standing still for the remaining two thirds, and that split is what
 * makes a countdown readable: the movement draws the eye to the tick, the stillness lets the tick be read.
 */
const CROSS_SECONDS = 0.35;

/**
 * How far the outgoing number has travelled when it has crossed. **Placeholder — 1.85.**
 *
 * **Big enough to read as passing the camera rather than as growing**, which is the whole of "cross zoom":
 * the number is not being emphasised, it is being left behind. A value near `1` would be a pulse — the size
 * change would sit inside the noise of the fade — and something well past `2` would leave the screen edge
 * before its fade finished, which reads as a slide rather than as depth.
 */
const OUT_SCALE = 1.85;

/**
 * Where the incoming number starts. **Placeholder — 0.6.**
 *
 * **The far end of the same axis, so the two numbers read as one motion through the screen.** The outgoing
 * one is coming at the viewer and the incoming one is behind it and still on its way; a `1` here would put
 * the new number at full size immediately and the cross would be a fade with a zoom on one side of it.
 */
const IN_SCALE = 0.6;

/**
 * How long "Start" holds before it fades, in seconds. **Placeholder — 0.6.**
 *
 * **It appears at the exact moment the freeze lifts, so it is competing with the player's own ability to
 * move** — the one word in this sequence that is *in the way* rather than informative. Long enough to be read
 * at a glance (one short word at the size `h6` gives it, and a word is recognised in well under a quarter of
 * a second), short enough that a player already running is not still looking at it. Under half a second would
 * be a flash on the one state that matters most; much over a second would put it in front of a round that has
 * already begun.
 */
const START_HOLD_SECONDS = 0.6;

/**
 * How long "Start" takes to leave, in seconds. **Placeholder — 0.25.**
 *
 * **A fade rather than the cut the numbers get.** Every number is *replaced* by the next one, so nothing is
 * ever removed without something arriving to cover it; "Start" is the end of the sequence and there is
 * nothing behind it, so a straight hide would be the same hard pop `RoundTransitionController` argues against
 * for the wipe — an instant removal is the cut the cover exists to hide.
 */
const START_FADE_SECONDS = 0.25;

/**
 * The last state of the sequence.
 *
 * **A word rather than `0`, because the count is a *wait* and a wait ends by ending rather than by reaching
 * nought.** `0` would be a number arriving at the exact moment it stops being true — a countdown that says
 * "nought seconds left" for a fifth of a second and then vanishes — where "Start" is the instruction the whole
 * sequence was counting towards. The sequence is `N, N-1, …, 1, Start`: for a three-second freeze that is
 * **`3`, `2`, `1`, `Start`.**
 */
const START_TEXT = "Start";

/**
 * The arena-freeze countdown: one number in the middle of the screen, each crossing into the next, ending on
 * "Start".
 *
 * **What it is counting.** A round begins by moving every player in it from the lobby to a spawn and then
 * holding them where they land for `ARENA_CONFIG.ARENA_FREEZE_SECONDS`, so a round's opening seconds are for
 * looking around rather than for already being somewhere. Until this existed the hold was invisible: a player
 * simply could not walk, and the only thing the game said about it was the absence of motion. This is the
 * sentence the delay was missing.
 *
 * **It derives the freeze rather than reading it, and the derivation is exact in length by construction.** The
 * server holds players for `holdFor` seconds measured from the teleport, and `holdFor` *is*
 * `ARENA_CONFIG.ARENA_FREEZE_SECONDS` — the same constant this file counts, read from the same shared module.
 * That is not two durations that happen to agree, it is one duration written in two places, which is the
 * arrangement `RoundService.transitionAround` and `ARENA_CONFIG`'s own doc both describe. Nothing needed to be
 * published for it and nothing was.
 *
 * **When it starts is derived from the same fact `ShiftLock` uses.** The phase is published *before* the
 * transition runs — deliberately, and it is why a camera that believed it immediately would snap into the
 * shoulder lock while its player was still standing in the lobby. So the `Playing` edge arrives a cover early,
 * and waiting `TRANSITION_COVER_SECONDS` from that event puts the first number on the tick the bodies land.
 * That is `ShiftLock.phaseDelay`'s number read the same way from the same constant, and with
 * `TRANSITION_CONFIG.ENABLED` off there is no cover and the delay is zero — `phaseDelay`'s reading of the same
 * switch, for the same reason.
 *
 * **What it deliberately is not.** It is not keyed on `ROUND_TRANSITION_ATTRIBUTE`, the *other* cue the server
 * sends and the one `RoundTransitionController` uses — that cue exists so the grid closes *before* the move, and
 * a countdown keyed on it would start a cover-length too early. It does not watch the freeze from the server,
 * because there is nothing to watch: the hold is a key in `WalkSpeedService`'s speed sum, applied and released
 * inside one `async` method, and no attribute describes it. And it changes nothing about the round — the
 * freeze, its duration, `ArenaFreeze`, `RoundService` and `TRANSITION_CONFIG` are all read-only from here.
 *
 * **The one thing it cannot get exactly right, said plainly.** The server never publishes the instant the hold
 * *ends*, so the countdown's anchor is the moment the client heard the phase plus the cover's own length. The
 * count's *duration* is exact — both ends are the same constant — but its *phase* can be one replication step
 * late, which is the same step `TRANSITION_COVER_SECONDS` already budgets a latency grace for. A client that
 * wanted better would need a published instant, and that attribute is not worth adding to the round for a
 * countdown.
 */
@Controller()
export class ArenaFreezeCountdownController implements OnStart {
	/** The round folder and the local player, kept so the edge handler and the start guard can read them. */
	private status?: Instance;
	private player?: Player;

	/**
	 * The cue at the end of the count: **the same whistle a round ends on**, blown at the round's other
	 * boundary.
	 *
	 * **Made once for the client's session rather than once per round**, which is `MusicController`'s rule for
	 * its own four sounds and holds here for the same reason: a `Sound` rebuilt at a round's start would be an
	 * instance per round in a service nothing cleans, and it would restart the clip mid-blow if the phase
	 * flickered. It is a field rather than a local because {@link cross} is where it fires, and it is optional
	 * only because the reference outlives the spawn that creates it — the mount makes the sound before it
	 * subscribes to the phase, so no run can begin without one behind it.
	 */
	private whistle?: Sound;

	/** Whether a count is running, which is what the card's `Visible` reads. */
	private counting?: Fusion.Value<boolean>;

	/** The two labels and the scale on each, and which of them is in front — see {@link cross}. */
	private readonly labels = new Array<TextLabel>();
	private readonly scales = new Array<UIScale>();
	private front = 0;

	/** The frame loop for the run, and the delay that will start one. */
	private loop?: RBXScriptConnection;
	private scheduled?: thread;

	/** When the current run's count began, on the client's own clock. See the class doc for why that clock. */
	private startedAt = 0;

	/**
	 * Which run is current, so a callback that outlives its run can tell.
	 *
	 * **The token `ShiftLock` cites `ThrowStateToastController` for**, and the case is the same shape: the fade
	 * at the end of a run finishes on a timer, and a run that began during that timer would be hidden by the
	 * previous run's parting shot. A late callback that finds a different number does nothing at all, where a
	 * boolean "is it running" would be true for the *new* run and hide it.
	 */
	private runId = 0;

	/** What the labels are currently showing, so a frame that has not crossed a boundary does nothing. */
	private showing = "";

	public onStart(): void {
		// Spawned rather than done inline, on every other HUD controller's argument: mounting waits for the
		// round folder, which the *server* creates, and a controller's `onStart` is the wrong place to hold up
		// the rest of the client's boot.
		task.spawn(() => this.mount());
	}

	private mount(): void {
		const scope = Fusion.scoped();

		const player = Players.LocalPlayer;
		this.player = player;

		const theme = hudTheme();

		// The folder the phase is published on, waited for rather than assumed — the same first line as
		// `ShiftLock` and `RoundTransitionController`.
		const status = ReplicatedStorage.WaitForChild(ROUND_STATUS_FOLDER);
		this.status = status;

		/**
		 * Whether the local player is in the round being counted into, as far as this machine can tell.
		 *
		 * **`TEAM_ATTRIBUTE` is the proxy, and it is the honest one available.** The server's own answer is a
		 * `Set` of active players inside `RoundService`, which no client can read. What a client *can* see is
		 * this attribute, written at the start of every playing phase and **absent** for a player who is between
		 * rounds or who joined while one was under way — which is exactly the distinction this needs. A player
		 * with no team was not teleported into the arena and is not being held, so a number telling them how long
		 * they cannot move would be a lie about a body standing in the lobby.
		 *
		 * **A `Value` fed by the attribute's change signal**, the bridge `StatsBillboardController` and
		 * `RespawnHudController` both build: an attribute read inside a `Computed` is a *sample* rather than a
		 * dependency, so the one connection has to exist for the reactive form to be true.
		 */
		const onTeam = Fusion.Value(scope, typeIs(player.GetAttribute(TEAM_ATTRIBUTE), "string"));

		scope.push(
			player.GetAttributeChangedSignal(TEAM_ATTRIBUTE).Connect(() => {
				onTeam.set(typeIs(player.GetAttribute(TEAM_ATTRIBUTE), "string"));
			}),
		);

		// Whether a count is running, which only this controller writes.
		const counting = Fusion.Value(scope, false);
		this.counting = counting;

		/**
		 * Whether the countdown should be on screen, as a function of three facts rather than four connections.
		 *
		 * **The spectator flag is the second half of the exclusion, and it covers two of the three cases the
		 * brief names.** `RoundService` sets `SPECTATING_ATTRIBUTE` for a player whose character dies during a
		 * round *and* for one who joins while a round is already under way — so "dead" and "watching" are the
		 * same fact as far as a client is concerned, and `panels.ts` already holds the mirror of it for exactly
		 * this kind of reader. "Not in the arena" is the team attribute above. A player who dies mid-count
		 * therefore loses the countdown on the frame the server says so, and keeps the *respawn* countdown, which
		 * is the readout that is actually true about them by then.
		 *
		 * **Reactive rather than sampled once when a run starts**, which is the difference between a player who
		 * dies seeing a number for a body they do not have and one who does not. Both `use()` calls are hoisted
		 * to the top, as every `use()` must be: a `use()` after an early return is a subscription that exists
		 * only while that branch is taken.
		 */
		const visible = Fusion.Computed(scope, (use) => {
			const countingNow = use(counting);
			const onTeamNow = use(onTeam);

			return countingNow && onTeamNow && !use(spectating);
		});

		// **The two labels are built before the card**, because `Card` takes its children at construction and
		// parents them itself — the order `CooldownHudController`'s rows are built in, and there is nothing above
		// them to own afterwards.
		this.labels.push(this.addLabel(scope, theme));
		this.labels.push(this.addLabel(scope, theme));

		/**
		 * **The countdown is a card, transparent, and every number about its box is derived.**
		 *
		 * A `Card` is what the rest of this screen is made of — it brings the padding, the corner and the
		 * `UIListLayout` that the HUD's boxes are built from — and this is that same box with its fill switched
		 * off: `BackgroundTransparency = 1`, and `elevation: 0` so the library does not draw the hairline it
		 * would otherwise put round it. **A transparent card with a border is an outline with nothing inside
		 * it**, which is the shape `RoundStatusController` argues against at its own stroke — the board there is
		 * taken off during play, and leaving its edge behind was the thing not to do.
		 *
		 * **No child of the card is placed by hand.** The width is the widest number's, the height is
		 * {@link LABEL_HEIGHT} plus the padding, and the layout is what centres both inside the content box. The
		 * only two sizes written by hand are on the element itself: the sizing pair below, which is the same
		 * correction `CooldownHudController` makes to its container, because a `Card` given no `size` is built
		 * full-width with an automatic height and this element wants both axes automatic.
		 *
		 * **`Position` and `AnchorPoint` on the card are the element's place on the screen and nothing else's.**
		 * They are stated once, on the outermost thing, and nothing inside reads them: the number does not move
		 * relative to the card when the card's size changes, which is what makes the two of them a *placement*
		 * rather than a layout.
		 */
		const card = Card(scope, {
			padding: theme.spacing.sm,
			// `0` and not the library's default, so that a box with no fill draws no border of any kind.
			elevation: 0,
			children: this.labels,
		});

		card.Name = "ArenaFreezeCountdown";
		card.Size = UDim2.fromOffset(0, 0);
		card.AutomaticSize = Enum.AutomaticSize.XY;
		card.Position = UDim2.fromScale(0.5, 0.5);
		card.AnchorPoint = new Vector2(0.5, 0.5);
		card.BackgroundTransparency = 1;
		// **Carried on the card as well as on the labels**, which is not tidiness: Roblox draws a child above its
		// parent only when the child's `ZIndex` is at least the parent's, so labels left at the default under a
		// card at `2` would be drawn behind the card's own corner and padding. See `raiseZIndex` in
		// `panelChrome.ts` for the rule and what it costs when it is missed.
		card.ZIndex = COUNTDOWN_Z_INDEX;

		/**
		 * **The one thing a layout cannot do by itself, written as a layout anyway.**
		 *
		 * A `UIListLayout` is a *sequence*: each child is placed after the last, which is the one arrangement a
		 * cross cannot use — the two numbers have to occupy the same cell, one leaving while the other arrives.
		 * No `FillDirection` will do that and a grid has no z-axis either. **What a list does let you choose is
		 * the gap between cells, so the gap here is the cell itself**: the second one is pulled back by exactly
		 * its own height, and two cells become one. With both labels at {@link LABEL_HEIGHT} that lands the
		 * second on the first to the pixel.
		 *
		 * **The alternatives were worse, and this is why the shape is worth stating.** Anchoring each label at
		 * the centre of a parent that auto-sizes around them is a circle — the box would be derived from children
		 * whose position is a fraction of that box. Hand-placing them is what this change is a correction to. And
		 * the gap is a number either way; this one is stated *once*, on the layout, where the other two spell it
		 * out on every child.
		 *
		 * **Nothing here depends on what the layout does with a hidden child.** One cell is visible at rest and
		 * two during a cross, and because the second cell costs the content box nothing, the card is one cell
		 * tall in both states either way.
		 */
		const layout = card.FindFirstChildOfClass("UIListLayout");

		if (layout !== undefined) {
			// `Card` has already made this vertical and sorted it by `LayoutOrder`; what it is told here is how
			// to centre what it lays out, and that the second cell is the first.
			layout.HorizontalAlignment = Enum.HorizontalAlignment.Center;
			layout.VerticalAlignment = Enum.VerticalAlignment.Center;
			layout.Padding = new UDim(0, -LABEL_HEIGHT);
		}

		// **Shown only while a count is running**, through the same `Computed` that decides it — one value, read
		// by the one element rather than a connection per reader. It is `Hydrate` because `Card` hands back a
		// finished instance, and a reactive value merely *assigned* to one of its properties is never tracked as
		// a property at all — the trap `CooldownHudController` documents at its own container.
		Fusion.Hydrate(scope, card)({ Visible: visible });

		// The viewport bound every HUD here carries: the element brings its own limit rather than trusting that
		// the screen will be big enough. A few characters will never bind it — it is here because the rule is the
		// rule, and the element that opts out is the one that gets forgotten.
		addViewportConstraint(scope, card);

		card.Parent = getHudScreenGui();

		/**
		 * **The round's opening whistle: the same clip, at the same volume, as the round ending.**
		 *
		 * `AUDIO_CONFIG.ROUND_WHISTLE` and `ROUND_WHISTLE_VOLUME` are read rather than repeated, so "the same
		 * sound" is a property of the config rather than a promise between two files — a whistle that changes
		 * changes at both boundaries at once. What the two blows share is the *meaning*: a round boundary is the
		 * same event seen from either side, so one clip answers both and a player learns one cue rather than two.
		 *
		 * **It is made here rather than asked for from `MusicController`**, and that is a decision about the
		 * instant rather than about which file owns audio. That controller blows the end because the end is a
		 * phase edge and it is the file that watches phases; the *start* has no such edge to watch, because the
		 * instant the arena freeze runs out is published nowhere and this file is the only thing on the client
		 * that derives it. Routing the cue through that controller would mean either a call between two
		 * controllers or a second copy of the timing — and either one would put the sound a frame or more behind
		 * the word it is supposed to land on, which is the one thing the brief asked to avoid.
		 *
		 * **Parented to `SoundService` and not `PlayerGui`**, for `MusicController`'s reason stated at its own
		 * sounds: `PlayerGui` is torn down and rebuilt on a respawn, which is exactly what an instance made once
		 * for the session must not be sitting inside. Nothing positional is wanted here either — a whistle is
		 * heard at one volume from anywhere, which is why it is in a service and not on a part.
		 *
		 * **Every property is applied in code**, which `sound.config.ts` argues for the server's emitters: a
		 * `Sound` authored in the place file is one a reader has to open the place to understand, and one a
		 * re-sync can quietly change. Four lines say what the whole sound is.
		 */
		const whistle = new Instance("Sound");
		whistle.Name = "RoundStartWhistle";
		whistle.SoundId = AUDIO_CONFIG.ROUND_WHISTLE;
		whistle.Looped = false;
		whistle.Volume = AUDIO_CONFIG.ROUND_WHISTLE_VOLUME;
		whistle.Parent = SoundService;

		this.whistle = whistle;

		// **Preloaded, because the instant it is needed is not negotiable.** The cue fires with the word
		// "Start", and a clip that only begins downloading at that point is a clip that arrives late — on the
		// first round of a session it would be silent. `MusicController` preloads the same id for its
		// end-of-round blow, so this is usually a no-op; it is here anyway because the two files make their own
		// `Sound`s and neither can rely on the other having asked first.
		ContentProvider.PreloadAsync([whistle], (contentId, fetchStatus) => {
			if (fetchStatus !== Enum.AssetFetchStatus.Success) {
				warn(`[HUD] round-start whistle did not load — ${contentId} (${fetchStatus.Name})`);
			}
		});

		/**
		 * The phase edge, and the edge is why this file reads the attribute rather than `panels.ts`.
		 *
		 * **`panels.ts` holds the client's mirror of the phase because a `Computed` needs a *value***, and it
		 * argues at length against a second subscription per reader — but a countdown has a *start* rather than a
		 * state, and there is no way to hear "it just became `Playing`" from something the HUDs read as a level.
		 * So this is one more reader of one attribute, which is what every other edge-watcher in the client
		 * already is: `ShiftLock`, `MusicController` and `DockController` each do the same.
		 *
		 * **The seed fires nothing, deliberately**, and a client that boots into a round already under way is the
		 * case it answers: the freeze it would have counted is long over, and a countdown for it would be a
		 * number about a moment the player was not there for. That is `RoundTransitionController`'s rule about its
		 * own counter, reached the same way.
		 */
		scope.push(
			status.GetAttributeChangedSignal(ROUND_STATE_ATTRIBUTE).Connect(() => {
				// **Leaving `Playing` cancels, and that includes a round that ends mid-count.** A round can end in
				// its own first seconds — the roster can empty, or a mode's condition can fire — and a number left
				// counting down over a round that is over is worse than no readout at all.
				if (phaseOf(status) !== PLAYING) {
					this.cancel();

					return;
				}

				this.schedule();
			}),
		);

		if (DEBUG) {
			print(
				`[HUD] arena freeze countdown up — ${ARENA_CONFIG.ARENA_FREEZE_SECONDS}s in whole seconds from ` +
					`the ${PLAYING} edge, delayed by ${TRANSITION_CONFIG.ENABLED ? TRANSITION_COVER_SECONDS : 0}s`,
			);
		}
	}

	/**
	 * One number's box, with its own scale and its own cell, invisible until it is used.
	 *
	 * **Nothing here is positioned, and that is the whole of this file's placement rule.** The width is the
	 * text's (`AutomaticSize.X`), the height is {@link LABEL_HEIGHT}, and the card's layout is what puts the box
	 * in the middle of the element. The two labels are the same box in the same cell, which is what a cross is.
	 *
	 * **`AutomaticSize.X` and not `XY`, because the height is load-bearing.** `AutomaticSize` is one value for
	 * both axes rather than a pair — see `panelChrome.ts` — so an automatic height would make `LABEL_HEIGHT` a
	 * fiction, and the gap that collapses the two cells into one is measured against that height. The text hugs
	 * its width, the cell is a fixed height, and the text is centred in it both ways: `align` across, and
	 * `TextYAlignment` down.
	 *
	 * **Both text properties are set imperatively rather than through a `Value`**, and that is the state
	 * machine's shape rather than a shortcut: the text changes on a *clock* boundary rather than in response to
	 * anything reactive, and the two labels swap roles when it does. A `Value` per label would be Fusion
	 * tracking two strings so that a loop could write one of them — the same fact spelled with more machinery.
	 *
	 * **The colour is written onto the returned instance rather than passed as a prop.** big-ui's `Text.color`
	 * is a palette *vocabulary* — `"primary"`, `"errorMain"` and so on — resolved against big-ui's own palette,
	 * and an unrecognised value falls through to the default silently rather than erroring. A `Color3` belongs on
	 * the instance, which is what the other HUDs do too.
	 *
	 * **`onAccent` is the theme's white.** There is no entry called `white`, and the spec's rule is to use one if
	 * it exists rather than to add one: `Palette.common.white` is already mapped as `onAccent` for text drawn on
	 * a filled surface, and this is the same ink for the same reason — a foreground that has to stay legible on
	 * whatever is behind it. Adding a second name for the same value would be the semantic drift `coin`'s doc
	 * argues against.
	 */
	private addLabel(scope: Fusion.Scope<unknown>, theme: HudTheme): TextLabel {
		const label = Text(scope, {
			text: "",
			variant: "h6",
			align: Enum.TextXAlignment.Center,
		});

		label.Name = "Number";
		label.Size = UDim2.fromOffset(0, LABEL_HEIGHT);
		label.AutomaticSize = Enum.AutomaticSize.X;
		// **The default, written down because it is now load-bearing.** The cell is taller than the text, so it is
		// this that puts the number on the screen's centre line rather than above it — see `LABEL_HEIGHT`.
		label.TextYAlignment = Enum.TextYAlignment.Center;
		label.TextColor3 = theme.colors.onAccent;
		label.TextTransparency = 1;
		label.Visible = false;
		// Carried on the labels as well as the card — see the note where the card's own `ZIndex` is set.
		label.ZIndex = COUNTDOWN_Z_INDEX;

		this.scales.push(Fusion.New(scope, "UIScale")({ Parent: label, Scale: 1 }));

		return label;
	}

	/**
	 * Waits out the cover and starts the count, or starts it at once with the transition switched off.
	 *
	 * **The guard at the far end is not redundant**, and it is the shape `ShiftLock` uses for the same reason:
	 * nothing but the folder and the player are captured, so a timer that fires after the phase has moved on
	 * reads the *current* attribute rather than the one that scheduled it. A round that ends inside the cover
	 * would otherwise start a countdown for a round that no longer exists. Cancelling any pending delay on the
	 * way in is the other half — two phase changes in quick succession produce one count, not two.
	 */
	private schedule(): void {
		if (this.scheduled !== undefined) task.cancel(this.scheduled);

		const delay = TRANSITION_CONFIG.ENABLED ? TRANSITION_COVER_SECONDS : 0;
		const player = this.player;

		this.scheduled = task.delay(delay, () => {
			this.scheduled = undefined;

			const status = this.status;
			if (status === undefined || !player) return;
			if (phaseOf(status) !== PLAYING) return;
			// The team check is repeated here rather than trusted from the edge: a player can be moved onto a
			// side *during* the cover — that is what joining is — and the arrival that matters is the one at the
			// moment the bodies land.
			if (!typeIs(player.GetAttribute(TEAM_ATTRIBUTE), "string")) return;

			this.begin();
		});
	}

	/**
	 * Counts `ARENA_FREEZE_SECONDS` down to "Start", one whole second at a time, and then gets out of the way.
	 *
	 * **One frame loop, held as a field and disconnected when the run ends.** The loop is not the animation — it
	 * is the *edge detector* for it: one tween per state change is the whole of the motion, and a tween per frame
	 * would be a fade nobody asked for. A run owns one connection and nothing else, so there is no per-run scoped
	 * container here the way `RoundTransitionController` builds one for its grid: that grid is 241 instances to
	 * throw away, and this is one connection to disconnect.
	 *
	 * **The clock is the client's own, started the frame the delay expires.** `time()` rather than
	 * `Workspace:GetServerTimeNow()`, because the server never publishes the instant the hold *ends* — there is no
	 * instant to compare against, and inventing one is the published attribute this design exists to avoid. See
	 * the class doc for what that costs: the length is exact and only the phase of the sequence can be a step
	 * late.
	 */
	private begin(): void {
		this.resetLabels();

		this.startedAt = time();
		this.showing = "";
		this.front = 0;
		this.counting?.set(true);

		const token = ++this.runId;
		this.loop = RunService.RenderStepped.Connect(() => this.advance(token));

		// Once on the spot, so the first number is up on the frame the freeze starts rather than one frame later —
		// the same reason `RespawnHudController` writes its label outside its own guard.
		this.advance(token);
	}

	/**
	 * The per-frame step: decide what the clock says, cross into it if it changed, and end the run once "Start"
	 * has had its hold.
	 *
	 * **The number is the second the player is *in*.** With 4.2 seconds left the reading is `5`, and it stays `5`
	 * until it is true that four seconds remain — `math.ceil` rather than `floor`, and a comparison against the
	 * previous *string* rather than against the previous second. That last part is what makes the boundary exact:
	 * the cross fires when the rounded number moves, not on a timer that would have to be kept in step with it.
	 */
	private advance(token: number): void {
		if (token !== this.runId) return;

		const elapsed = time() - this.startedAt;
		const left = ARENA_CONFIG.ARENA_FREEZE_SECONDS - elapsed;

		if (left > 0) {
			const text = tostring(math.ceil(left));
			if (text !== this.showing) this.cross(text, false);

			return;
		}

		if (this.showing !== START_TEXT) {
			this.cross(START_TEXT, true);

			return;
		}

		if (elapsed - ARENA_CONFIG.ARENA_FREEZE_SECONDS < START_HOLD_SECONDS) return;

		this.finish(token);
	}

	/**
	 * Crosses into `text`: the number in front zooms out and fades, and `text` fades in from behind it.
	 *
	 * **Two labels rather than one resetting, which is the difference between a cross and a pop.** One label
	 * cannot be in two states at once, so a single label would have to finish fading out before it could start
	 * fading in — a blink with a gap, and the gap would have to be half the animation for the motion to fit
	 * inside the second. Two labels overlap by construction: one is leaving while the other arrives, which is what
	 * "the number coming toward the viewer and passing" actually looks like.
	 *
	 * **`Out` on the arrival and `In` on the departure, and the split is the physics rather than taste.** The
	 * incoming label decelerates into its size — it is settling where it belongs — while the outgoing one
	 * accelerates away, which is what something passing the camera does. Swapping them would make the number
	 * arrive with a snap and leave gently, i.e. exactly backwards.
	 *
	 * **"Start" arrives at rest scale rather than from behind.** It is the end of the sequence, so nothing is
	 * crossing *through* it: the last number still zooms out — that is the cross, and it belongs to the number —
	 * but the word fades in at the size it will hold. Anything else would promise a fourth number that is not
	 * coming.
	 *
	 * **One tween per property per label, so four per crossing and none per frame**, which is the shape the
	 * brief asks for and the only one that reads as motion: a tween started every frame would restart sixty times
	 * a second and the numbers would never appear to move at all.
	 */
	private cross(text: string, isStart: boolean): void {
		this.showing = text;

		const leaving = this.labels[this.front];
		const arriving = this.labels[1 - this.front];
		const leavingScale = this.scales[this.front];
		const arrivingScale = this.scales[1 - this.front];

		this.front = 1 - this.front;

		// **The departing number is drawn over the arriving one, which is the near-ness the zoom is pretending
		// at.** Both labels share a cell now, so this is the only thing that decides which of the two is in
		// front: without it they tie, and the engine breaks a tie on child order — which never changes while the
		// pair's roles swap every crossing. Stated here, on the crossing, because that is when it changes.
		leaving.ZIndex = COUNTDOWN_Z_INDEX + 1;
		arriving.ZIndex = COUNTDOWN_Z_INDEX;

		// The outgoing number, if there is one: the first number of a count has nothing behind it, and both labels
		// start hidden.
		if (leaving.Visible) {
			const away = new TweenInfo(CROSS_SECONDS, Enum.EasingStyle.Quad, Enum.EasingDirection.In);

			TweenService.Create(leavingScale, away, { Scale: OUT_SCALE }).Play();
			TweenService.Create(leaving, away, { TextTransparency: 1 }).Play();
		}

		arriving.Text = text;
		arriving.Visible = true;
		arriving.TextTransparency = 1;
		arrivingScale.Scale = isStart ? 1 : IN_SCALE;

		const into = new TweenInfo(CROSS_SECONDS, Enum.EasingStyle.Quad, Enum.EasingDirection.Out);

		TweenService.Create(arrivingScale, into, { Scale: 1 }).Play();
		TweenService.Create(arriving, into, { TextTransparency: 0 }).Play();

		/**
		 * **The cue, on the frame the word arrives and nowhere else.** The `Start` crossing *is* the round's
		 * opening whistle: the freeze has just run out, which is the instant the round's clock begins, and this
		 * is the same frame the word appears on. Firing it from a clock instead would be a second derivation of
		 * an instant this class already owns, and two derivations are two things that can disagree.
		 *
		 * **It fires whether or not the countdown is visible**, because the cue belongs to the round rather than
		 * to the body: a player who died during the freeze still hears the round begin, which is the honest thing
		 * for it to say. A round that never begins is the other case and is answered earlier rather than here —
		 * `cancel` takes the run away before this frame, so there is nothing left to fire.
		 *
		 * **Exactly once per run**, which falls out of {@link advance} comparing against the word rather than
		 * counting frames: the crossing into `Start` is the last change of text a run makes, and the frames after
		 * it only decide when to leave.
		 */
		if (isStart) {
			this.whistle?.Play();

			// Printed once per round, and the number is the point of it: elapsed time at the moment of the cue,
			// which should read `ARENA_FREEZE_SECONDS` to the hundredth. That line beside the server's own hold
			// print is what says whether this client's freeze and the server's ended together — the one thing
			// about the timing that cannot be checked from the source alone.
			if (DEBUG) print(`[HUD] start — round whistle at ${string.format("%.2f", time() - this.startedAt)}s`);
		}
	}

	/**
	 * Ends a run that reached "Start": stops the loop, fades the word out, and takes the countdown down.
	 *
	 * **The hide is on a timer rather than on the tween's signal**, with {@link runId} as the guard. A run that
	 * began during the fade must not be hidden by the previous run's parting shot, and a token check is the
	 * smallest thing that says so — `ShiftLock` cites `ThrowStateToastController` for the same pattern and the
	 * same reason. A callback that arrives to find a different run does nothing at all, where a boolean "is it
	 * running" would be true of the new run and would hide it.
	 */
	private finish(token: number): void {
		this.stopLoop();

		const label = this.labels[this.front];
		const leaving = new TweenInfo(START_FADE_SECONDS, Enum.EasingStyle.Quad, Enum.EasingDirection.In);

		TweenService.Create(label, leaving, { TextTransparency: 1 }).Play();

		task.delay(START_FADE_SECONDS, () => {
			if (token !== this.runId) return;

			label.Visible = false;
			this.showing = "";
			this.counting?.set(false);
		});
	}

	/**
	 * Takes the countdown off the screen at once, for a round that ended mid-count.
	 *
	 * **No fade, unlike {@link finish}**, and the difference is what is on screen behind it: a round that has just
	 * ended is covered by the transition grid, so the number is being removed from a screen nobody can see — and
	 * a fade would either run behind the cover and be pointless, or outlive it and be a number floating over the
	 * lobby. The token is bumped so any callback still in flight retires with the run it belonged to.
	 */
	private cancel(): void {
		this.stopLoop();
		this.runId++;
		this.showing = "";
		this.counting?.set(false);
	}

	/** Stops the frame loop. The instances stay — they belong to the mount, not to a run. */
	private stopLoop(): void {
		const loop = this.loop;
		this.loop = undefined;

		if (loop !== undefined) loop.Disconnect();
	}

	/**
	 * Puts both labels back to their resting state before a count begins.
	 *
	 * **Necessary because the labels outlive the run that used them.** A round that ended mid-cross leaves a label
	 * scaled up and another mid-fade; a new round would inherit whatever the last one was doing, and the first
	 * frame of the count would show a half-faded number at the wrong size. Resetting on the way in is cheaper than
	 * cleaning up on every way out, and it is the one place that has to be right.
	 */
	private resetLabels(): void {
		for (let index = 0; index < this.labels.size(); index++) {
			const label = this.labels[index];

			label.Visible = false;
			label.TextTransparency = 1;
			this.scales[index].Scale = 1;
		}
	}
}

/**
 * What the round folder says the phase is, or `undefined` if it says nothing readable.
 *
 * A free function rather than a method, because it reads an `Instance` and nothing else — and the same three
 * lines exist in `ShiftLock`, which keeps its own copy for the same reason: a helper exported across two
 * controllers to save one `typeIs` would be a module that exists to hold one expression.
 */
function phaseOf(status: Instance): string | undefined {
	const phase = status.GetAttribute(ROUND_STATE_ATTRIBUTE);

	return typeIs(phase, "string") ? phase : undefined;
}
