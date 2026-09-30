import { Controller, OnStart } from "@flamework/core";
import { Text } from "@rbxts/big-ui";
import Fusion from "@rbxts/fusion-3.0";
import { ContentProvider, Players, ReplicatedStorage } from "@rbxts/services";
import { ROUND_STATUS_FOLDER } from "shared/constants";
import { hudTheme } from "../../ui/hudTheme";
import { getSplashScreenGui } from "../../ui/screenGui";
import { addViewportConstraint } from "../../ui/viewportConstraint";

/** Prints the mount line and the dismissal line — the two that say this controller did anything. */
const DEBUG = true;

/** What the game is called, in the one place the client writes it. */
const TITLE = "DODGEBALL Hero";

/**
 * The splash image: the full-viewport background the title sits on.
 *
 * **A file-local constant and not a config entry.** `shared/config/` is for numbers and strings
 * somebody *tunes*, or that more than one file has to agree on. This is one asset id, read in one
 * place, with no second reader to keep in step — a config file for it would be a file to open for a
 * string nothing else can see.
 *
 * **Its state is worth knowing, because the way it fails is silent.** The asset behind this id is
 * `title-screen-AI`, uploaded by this project's own account, and it is a *fresh* upload — so Roblox
 * may still be processing it, and while it is, an `ImageLabel` pointed at it draws nothing and
 * reports nothing. That is why the `PreloadAsync` call below exists.
 */
const LOADING_BACKGROUND = "rbxassetid://105758313826117";

/**
 * Where the overlay sits in the ZIndex order: **above everything else the game draws.**
 *
 * The ladder as it stands: the ordinary HUDs leave `ZIndex` at its default of `1`, the shop panel
 * is `SHOP_CONFIG.PANEL_Z_INDEX` (`10`), and the round-result panel is
 * `RoundResultController`'s `PANEL_Z_INDEX` (`20`) — which describes itself as being above everything
 * this game draws, and was, until this. This takes the next number up and the two files below it are
 * left alone, because a loading screen is not a third panel competing for the screen: it is what is
 * in front of the game while there is no game to look at yet.
 *
 * **Every instance this file makes carries it too, and that is the `raiseZIndex` rule rather than
 * tidiness.** Roblox only draws a child above its parent when the child's `ZIndex` is at least the
 * parent's, so an overlay at `30` with labels left at `1` would paint its own background *over* its
 * own text. The two panels need a helper that walks their subtree because big-ui's `Card` builds
 * children they never hold; this file builds its own `Frame` and asks `Text` for its labels, so the
 * number is written on each one as it is made and nothing has to be walked. See `raiseZIndex` in
 * `RoundResultController` for the trap itself.
 */
const LOADING_Z_INDEX = 30;

/**
 * How long the screen waits before giving up and letting the player in anyway, in seconds.
 *
 * **A fallback, not a duration.** Nothing about the dismissal is timed: the screen goes as soon as
 * the three signals below are in, whenever that is, and this is only the number at which a screen
 * that is *never* going to be satisfied stops being a loading screen and starts being a wall. A
 * broken server, a folder that was never published, a character that never spawned — all of them
 * end here, on a line that says which of the three was missing, rather than in a player staring at
 * a title card for ever.
 *
 * Fifteen seconds because a slow join is real and this must not be the thing that cuts one short:
 * the longest anything else in the client waits is `ThrowController`'s ten-second `WaitForChild` on
 * the throw remotes, and a fallback shorter than a legitimate wait would turn a slow join into a
 * screen that gives up on a game that was about to arrive.
 */
const LOADING_TIMEOUT_SECONDS = 15;

/**
 * How long the overlay stays up at minimum, in seconds, once the signals are in.
 *
 * **Polish, not function.** Nothing decides anything with this number: the screen is dismissed by
 * the three signals and never by the clock, and a join that satisfies them instantly would otherwise
 * flash a full-screen frame for one frame — which reads as a glitch rather than as a loading screen,
 * and is at its most visible in Studio, where everything is already local. Half a second is long
 * enough to read as a transition and short enough that a real join never notices it.
 */
const MINIMUM_DISPLAY_SECONDS = 0.5;

/** How often the three signals are re-read while waiting, in seconds. See {@link mount}. */
const POLL_SECONDS = 0.1;

/** How fast the dots cycle, in seconds per step. */
const SPINNER_STEP_SECONDS = 0.4;

/** How many dots the spinner cycles through, ending on this many and starting again at one. */
const SPINNER_STEPS = 3;

/**
 * The three signals, as one line — see {@link LoadingScreenController} for what each one proves.
 *
 * Written as a read of all three at once rather than as a chain of conditions, because the sentence
 * is about *how far* the join has got and the order the three become true in is not fixed.
 */
function sentenceFor(replicated: boolean, published: boolean, spawned: boolean): string {
	if (replicated && published && spawned) return "Ready";

	// The server's own boot is the one that gates everything else here: until the round folder
	// exists there is no game to be put into, whatever the client has finished downloading.
	return published ? "Getting you in" : "Contacting the server";
}

/** Whether one of the three signals is in, for the timeout line. */
function satisfied(signal: Fusion.Value<boolean>): string {
	return Fusion.peek(signal) ? "yes" : "no";
}

/**
 * The full-screen overlay that covers the join, and the three signals that take it away.
 *
 * **What "ready" means is three observable facts, and none of them is a clock.** The screen is not a
 * minimum-display-time advert and it is not a fixed number of seconds: it is up for exactly as long
 * as these are not all true, and then it is gone.
 *
 * 1. **The client's own replication has finished** — `game.IsLoaded()`, or `game.Loaded`. This is
 *    the client's answer about the client, and it is the one signal here that is not about our game
 *    at all: until the DataModel has loaded there is no world to stand in and nothing the other two
 *    signals could even be read from.
 * 2. **The server has published its first state** — the `RoundStatus` folder exists. That folder is
 *    made by `RoundService` at ignite, so its presence is the whole of "the round system booted",
 *    and it is a *fact about the running server* rather than a guess about how long a server takes.
 *    Nothing about this screen has to know what a round is; it reads the same folder the HUDs read.
 * 3. **The local player has a body** — `Players.LocalPlayer.Character`, or `CharacterAdded`. This is
 *    what the player is actually waiting to see: the character landing in the lobby. A screen that
 *    went away before this would hand over to exactly the pop-in it exists to cover.
 *
 * **It waits for the three concurrently**, each in its own thread, so a slow one cannot delay the
 * others being noticed — and the loop below only reads them, which keeps the timeout authoritative
 * rather than something a blocked wait could outlive.
 *
 * **It never hangs for ever.** {@link LOADING_TIMEOUT_SECONDS} dismisses the screen whatever the
 * signals say, and says which of them were missing on the way out.
 *
 * **It is a second `ScreenGui`, and that reverses the decision this file opened with.** The first
 * version mounted into the shared one (`getHudScreenGui`), on the argument that `PlayerGui`
 * collecting a GUI per feature is how a game ends up with six of them and no way to tell them apart.
 * That argument is about *panels* — things that sit in a corner and want the safe region — and it
 * does not survive a full-screen image: `ScreenInsets` belongs to the `ScreenGui` and applies to
 * everything inside it, so nothing parented into the shared GUI can cover the strip under Roblox's
 * topbar, and a splash that stops a few pixels short of the top of the screen shows a band of the
 * game through it. That reads as broken, not as deliberate.
 *
 * **So the whole screen moves, and not just the image.** A `ScreenGui` at a higher `DisplayOrder`
 * draws over every pixel of the one below it — `DisplayOrder` orders whole GUIs and beats any
 * `ZIndex` inside either tree — so an image in the new GUI with the title left behind in the shared
 * one would simply cover the title. Image and text therefore share the new GUI, ordered against each
 * other by `ZIndex` and by which of them was parented first, and the shared GUI keeps the other nine
 * HUDs exactly as they were. See {@link getSplashScreenGui} for the helper, and for why this had to
 * be a second GUI rather than a flag on the first.
 */
@Controller()
export class LoadingScreenController implements OnStart {
	/**
	 * The overlay, while there is one.
	 *
	 * **Kept rather than fired and forgotten, and this is the whole of the "a re-show is possible"
	 * structure.** There is no re-show today: the screen is dismissed once, at the join, and nothing
	 * puts it back. Holding it here is what would let a later owner reach for it — to put it back up
	 * over a `LoadCharacter`, say — without this class having to be reopened. As it stands the field
	 * is written once and cleared on dismissal, and a re-show would go through {@link mount} again
	 * rather than through anything new.
	 */
	private overlay: Frame | undefined;

	/** The scope the overlay was built in, kept for the same reason {@link overlay} is. */
	private scope: Fusion.Scope<unknown> | undefined;

	public onStart(): void {
		// Spawned rather than done inline, for the reason every other HUD gives: mounting yields
		// (`getSplashScreenGui` waits for `PlayerGui`), and a controller's `onStart` is the wrong
		// place to hold up the rest of the client's boot. This one is *first* in the boot in most
		// sessions, which makes it the least acceptable place of all to block.
		task.spawn(() => this.mount());
	}

	private mount(): void {
		const theme = hudTheme();
		const player = Players.LocalPlayer;
		const scope = Fusion.scoped();

		this.scope = scope;

		// **The three signals, as three `Value`s rather than three waits.** Each is seeded from the
		// world as it is *now*, because on a fast machine any of them may already be true by the time
		// this runs — a join that has already loaded its DataModel, or a client that mounted after the
		// character spawned, must not then sit waiting for a signal that has been and gone.
		const replicated = Fusion.Value(scope, game.IsLoaded());
		const published = Fusion.Value(scope, ReplicatedStorage.FindFirstChild(ROUND_STATUS_FOLDER) !== undefined);
		const spawned = Fusion.Value(scope, player.Character !== undefined);

		// 1. The client's own replication. `IsLoaded` is asked first rather than waiting on the event,
		//    and the connection is pushed to the scope so a screen that gives up at the timeout does
		//    not leave a live connection behind it.
		if (!Fusion.peek(replicated)) {
			scope.push(game.Loaded.Connect(() => replicated.set(true)));
		}

		// 2. The server's first publish. `WaitForChild` rather than a connection, because this is a
		//    child *arriving* in a container this client does not own — and with the same number the
		//    outer loop is running on, so a folder that never comes back reports as missing rather
		//    than yielding for ever. `FindFirstChild` above is the "already there" case.
		if (!Fusion.peek(published)) {
			task.spawn(() => {
				const folder = ReplicatedStorage.WaitForChild(ROUND_STATUS_FOLDER, LOADING_TIMEOUT_SECONDS);
				published.set(folder !== undefined);
			});
		}

		// 3. The character. A connection rather than `CharacterAdded.Wait()`, and that is a real
		//    difference rather than a style: `Wait` cannot be cancelled, so a screen dismissed at the
		//    timeout would leave a thread parked on the next spawn for the rest of the session. Pushed
		//    to the scope, this is dropped with the scope instead.
		if (!Fusion.peek(spawned)) {
			scope.push(player.CharacterAdded.Connect(() => spawned.set(true)));
		}

		// The status line, derived from the three rather than updated by whichever signal lands
		// first. **Every read is at the top, before any branching** — Fusion derives a `Computed`'s
		// dependencies from the `use` calls that actually run, so a read inside an `if` is a
		// subscription that only exists while that branch is taken. See `RoundStatusController` and
		// the handoff's notes on the same trap.
		const status = Fusion.Computed(scope, (use) => {
			const hasWorld = use(replicated);
			const hasServer = use(published);
			const hasBody = use(spawned);

			return sentenceFor(hasWorld, hasServer, hasBody);
		});

		// The spinner, as a number of dots rather than a frame index, so the loop that drives it has
		// nothing to index into and cannot run off the end of anything.
		const spinner = Fusion.Value(scope, "");

		// **The overlay is a `Frame` and not a big-ui `Card`.** A card is a floating surface with a
		// corner radius and a shadow around it, sized to its contents — which is the opposite of a
		// thing whose job is to cover the whole viewport. Raw Fusion for the coverage, big-ui for the
		// type inside it.
		//
		// The colour is the theme's `surface`, and **it now covers the whole viewport, including the
		// strip under Roblox's own topbar** — the reverse of what this comment said while the overlay
		// lived in the shared GUI. That earlier argument, that the topbar is Roblox's chrome and not
		// this game's, is right for every HUD and wrong for this one: on a screen whose whole job is
		// to be covered, stopping short of the top is not respect, it is a band of the game showing
		// through what is pretending to be a covered screen. The GUI this mounts into has no insets
		// at all — see `getSplashScreenGui` — and the surface is what shows behind the image, and
		// stands in for it entirely if the image never loads.
		const overlay = Fusion.New(scope, "Frame")({
			Name: "LoadingOverlay",
			Size: UDim2.fromScale(1, 1),
			Position: UDim2.fromScale(0, 0),
			BackgroundColor3: theme.colors.surface,
			BackgroundTransparency: 0,
			BorderSizePixel: 0,
			ZIndex: LOADING_Z_INDEX,

			// **`Active = false`, and no `TextBox` anywhere in this subtree.** A `GuiObject` only
			// takes pointer input while it is `Active`, and only a focused `TextBox` takes the
			// keyboard. `Modal` is deliberately not set either — that is the property that actually
			// takes input away, and this screen has no reason to take any: it is a picture, and every
			// key the player presses while it is up should reach the input controllers behind it
			// exactly as it would with no overlay at all.
			Active: false,
			Selectable: false,
		});

		// **The splash image, and it is the overlay's first child for a reason that is load-bearing
		// twice over.** It has to be parented *before* `content` because two siblings at the same
		// `ZIndex` are drawn in the order they were parented — the rule `ShopController` relies on for
		// its own bands — and it cannot simply be given a *lower* `ZIndex` than the overlay instead,
		// because a child below its parent's `ZIndex` is drawn behind the parent's own background,
		// which is the opaque surface above. Same number, parented earlier, is the whole of the
		// ordering.
		//
		// **`Crop` and not `Fit`, and this is the line somebody will change back.** `Fit` scales the
		// image until all of it is visible, so anything whose aspect ratio is not the screen's leaves
		// bars of the game showing through — on a phone, or on a 16:9 monitor with a square splash,
		// exactly the failure this whole change is about. `Crop` scales until the *screen* is covered
		// and lets the overflow fall off the edges, which is what "cover the full viewport" means.
		const background = Fusion.New(scope, "ImageLabel")({
			Name: "Background",
			Image: LOADING_BACKGROUND,
			ScaleType: Enum.ScaleType.Crop,
			Size: UDim2.fromScale(1, 1),
			Position: UDim2.fromScale(0, 0),
			BackgroundTransparency: 1,
			BorderSizePixel: 0,
			ZIndex: LOADING_Z_INDEX,
			Active: false,
			Selectable: false,
		});

		background.Parent = overlay;

		// What the overlay's contents are centred in. A second frame rather than padding on the
		// overlay, because a layout on the overlay would lay its children out across the whole screen
		// rather than around the middle of it.
		const content = Fusion.New(scope, "Frame")({
			Name: "Content",
			AnchorPoint: new Vector2(0.5, 0.5),
			Position: UDim2.fromScale(0.5, 0.5),
			Size: UDim2.fromOffset(0, 0),
			AutomaticSize: Enum.AutomaticSize.XY,
			BackgroundTransparency: 1,
			ZIndex: LOADING_Z_INDEX,
			Active: false,
			Selectable: false,
		});

		// The same bound every other HUD carries, and for the same reason: this content is sized to
		// its own text, and a title is a string somebody edits. See `viewportConstraint`.
		addViewportConstraint(scope, content);

		// Flexbox rather than two hand-computed positions — see the handoff's UI standard.
		Fusion.New(scope, "UIListLayout")({
			FillDirection: Enum.FillDirection.Vertical,
			HorizontalAlignment: Enum.HorizontalAlignment.Center,
			VerticalAlignment: Enum.VerticalAlignment.Center,
			SortOrder: Enum.SortOrder.LayoutOrder,
			Padding: new UDim(0, theme.spacing.sm),
		}).Parent = content;

		const title = Text(scope, { text: TITLE, variant: "h4", wrap: false });
		title.LayoutOrder = 1;
		title.ZIndex = LOADING_Z_INDEX;
		title.TextColor3 = theme.colors.textPrimary;
		// Sized to its own text, for the reason `ControlsLegendController` gives: big-ui's default is
		// a label the full width of its parent, and a parent sized to the label and a label sized to
		// the parent is a circle that Roblox resolves by guessing.
		title.Size = UDim2.fromOffset(0, 0);
		title.AutomaticSize = Enum.AutomaticSize.XY;
		// Gamepad selection is input too, and a label is a thing a selection can land on: with this
		// left true the `A` button would be swallowed by a line of text while the screen was up.
		title.Selectable = false;
		title.Parent = content;

		const statusLabel = Text(scope, { text: status, variant: "body1", wrap: false });
		statusLabel.LayoutOrder = 2;
		statusLabel.ZIndex = LOADING_Z_INDEX;
		statusLabel.TextColor3 = theme.colors.textSecondary;
		statusLabel.Size = UDim2.fromOffset(0, 0);
		statusLabel.AutomaticSize = Enum.AutomaticSize.XY;
		statusLabel.Selectable = false;
		statusLabel.Parent = content;

		const spinnerLabel = Text(scope, { text: spinner, variant: "body1", wrap: false });
		spinnerLabel.LayoutOrder = 3;
		spinnerLabel.ZIndex = LOADING_Z_INDEX;
		spinnerLabel.TextColor3 = theme.colors.accent;
		spinnerLabel.Size = UDim2.fromOffset(0, 0);
		spinnerLabel.AutomaticSize = Enum.AutomaticSize.XY;
		spinnerLabel.Selectable = false;
		spinnerLabel.Parent = content;

		content.Parent = overlay;

		// **The GUI is fetched here rather than at the top of the method**, because it is the last
		// thing needed and the first thing that has to be waited for — `getSplashScreenGui` waits on
		// `PlayerGui`. A mount that yields should yield as late as it can, so the whole overlay is
		// built before anything asks for the screen it is going on.
		const splash = getSplashScreenGui();

		overlay.Parent = splash;

		this.overlay = overlay;

		if (DEBUG) {
			print(`[HUD] loading screen up — waiting on replication, ${ROUND_STATUS_FOLDER} and the character`);
		}

		// The dots, on a loop that ends itself: it stops the first time the overlay has no parent,
		// which is what the dismissal below leaves behind. Nothing has to cancel it and nothing
		// cancelled can be forgotten.
		task.spawn(() => {
			let step = 0;

			while (overlay.Parent !== undefined) {
				task.wait(SPINNER_STEP_SECONDS);

				step = step % SPINNER_STEPS;
				spinner.set(string.rep(".", step + 1));

				step += 1;
			}
		});

		// **There was a `Logo` `ImageLabel` built here, and it became the background above.** The
		// reason it could never have shown is worth keeping, because it was the same asset and the
		// fault was structural: it was parented to `content`, which is `AutomaticSize.XY` — a parent
		// that sizes itself to its children — so a child sized `scale(1, 1)` *of* that parent is the
		// circular case `ControlsLegendController` warns about, and Roblox resolves it by guessing. It
		// was also a child of the `UIListLayout`'s stack, whose whole job is to give each child a slot
		// at its own size. A full-viewport image wants the overlay, where `scale(1, 1)` means the
		// viewport and nothing depends on a size that is still being decided.
		//
		// **Whether the logo ever arrived, said out loud, because an `ImageLabel` that cannot fetch
		// its content does nothing at all.** No error, no warning, no broken-image placeholder — an
		// empty box exactly the size the label was given, which is indistinguishable from a label
		// that was never built, and from a download that has not finished yet. Three completely
		// different faults, one appearance. That is the same silent-failure shape as a refused
		// contact, and it costs the same hours: "Roblox is still processing the asset", "the id is
		// wrong" and "the screen went away first" all look like this from the player's seat.
		//
		// The **instance** rather than the id, which is what `PreloadAsync` is for: the label already
		// references the image, so this starts no fetch of its own — it only asks to be *told* when
		// the one already in flight finishes. `ImageLabel.IsLoaded` answers the same question on
		// demand, but it can only be asked about *now*, and by the time anybody looks the screen is
		// gone.
		//
		// **Gated the other way round from most diagnostics here.** The failure is ungated, because it
		// is the answer to the question the screen is being looked at for, and it stays useful after
		// the screen has gone; the success is behind `DEBUG`, because it is only interesting while
		// tuning the asset. See `LOADING_BACKGROUND` for the asset itself.
		ContentProvider.PreloadAsync([background], (contentId, status) => {
			if (status !== Enum.AssetFetchStatus.Success) {
				warn(`[HUD] splash background did not load — ${contentId} (${status.Name})`);
			} else if (DEBUG) {
				print(`[HUD] splash background loaded — ${contentId}`);
			}
		});

		this.waitForTheSignals(replicated, published, spawned, splash);
	}

	/**
	 * Waits for the three signals, gives up at the timeout, and takes the screen away.
	 *
	 * **It destroys the `ScreenGui`, not the overlay frame, and that is why it is handed the GUI.**
	 * The splash GUI is never shared and holds nothing but this screen, so the GUI *is* the thing
	 * that exists only for the loading screen and the only thing worth reclaiming.
	 *
	 * **A poll rather than three chained waits, and the timeout is the reason.** Awaiting them in
	 * turn would make the *order* the waits happen to be written in decide how long the screen stays
	 * up, and each wait would have to be given a share of the budget — which is a number nobody can
	 * choose correctly. Reading three booleans is free, and it keeps the timeout the single
	 * authority over when this ends.
	 *
	 * The wait is measured by **adding up what `task.wait` actually returned** rather than by reading
	 * a clock. `os.clock` counts CPU time — a trap this codebase has already been caught by once, see
	 * the note in `ThrowProbe.ts` — and the value `task.wait` returns *is* the elapsed time, so there
	 * is nothing here that a clock would tell us more accurately.
	 */
	private waitForTheSignals(
		replicated: Fusion.Value<boolean>,
		published: Fusion.Value<boolean>,
		spawned: Fusion.Value<boolean>,
		splash: ScreenGui,
	): void {
		const ready = () => Fusion.peek(replicated) && Fusion.peek(published) && Fusion.peek(spawned);

		let elapsed = 0;

		while (elapsed < LOADING_TIMEOUT_SECONDS && !ready()) {
			elapsed += task.wait(POLL_SECONDS);
		}

		// **The line that makes a stuck join diagnosable**, and the only reason the timeout is a
		// failure worth printing rather than a silent shrug: it says which of the three never
		// arrived, which is the difference between a server that did not boot, a character that was
		// never spawned, and a client that never finished loading.
		if (!ready()) {
			warn(
				`[HUD] loading screen dismissed by the ${LOADING_TIMEOUT_SECONDS}s timeout — ` +
					`replication ${satisfied(replicated)}, ${ROUND_STATUS_FOLDER} ${satisfied(published)}, ` +
					`character ${satisfied(spawned)}`,
			);
		}

		// The minimum display time, counted from the mount rather than from the signals landing, so
		// the two never add up to more than the number says.
		if (elapsed < MINIMUM_DISPLAY_SECONDS) {
			task.wait(MINIMUM_DISPLAY_SECONDS - elapsed);
		}

		// **The GUI is destroyed, and not only the overlay — that is the choice worth recording.**
		// The splash GUI is never shared and holds nothing but this screen, so it exists only for this
		// screen and goes with it. Keeping it would leave an empty `ScreenGui` in `PlayerGui` for the
		// rest of the session, which is indistinguishable from a leak; destroying it costs nothing,
		// because a future re-show gets a fresh one from `getSplashScreenGui` in a single
		// `FindFirstChild`, which is exactly what that helper's find-or-create shape is for.
		//
		// `Destroy` takes the overlay with it — a destroyed parent destroys its descendants — which is
		// why this destroys the GUI rather than the frame: there is nothing else in the GUI, so one
		// call is one thing to remember rather than two things that have to agree. The dots loop above
		// stops on its next tick, because the overlay it is watching no longer has a parent.
		splash.Destroy();

		this.overlay = undefined;

		// Ungated, unlike the mount line, because it is the answer to the one thing anybody checks
		// about a loading screen: how long it was up. It is also what makes the acceptance test in
		// Studio a reading rather than a stopwatch.
		print(
			`[HUD] loading screen down — ${string.format("%.2f", elapsed)}s, ` +
				`replication ${satisfied(replicated)}, ${ROUND_STATUS_FOLDER} ${satisfied(published)}, ` +
				`character ${satisfied(spawned)}`,
		);
	}
}
