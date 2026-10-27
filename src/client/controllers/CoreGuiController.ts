import { Controller, OnStart } from "@flamework/core";
import { StarterGui } from "@rbxts/services";
import { DEBUG_LOGGING, logInfo, logWarn } from "shared/logger";

/**
 * How long to keep looking for the player list's configuration object, in seconds.
 *
 * **A bound on a wait, not a polling interval to be tuned.** The object is created by Roblox's own CoreScripts,
 * which start after this client's controllers do, so it may be a frame behind the mount or several seconds
 * behind it — and this is the window in which "not yet" has to be told apart from "not this build". Five
 * seconds is generous against the boot it is waiting on and short enough that the log line at the end of it is
 * still about the session it was written in.
 */
const WATCH_SECONDS = 5;

/**
 * How many times the **legacy** disable is asked for before the attempt is called a failure, and how long
 * between asks. **Placeholder — 50 × 0.1 s, which is the same five seconds as {@link WATCH_SECONDS}.**
 *
 * **The two bounds are equal on purpose**: the configuration watch and the legacy request are two attempts at
 * one outcome, so a client where both fail should say so in one report rather than one message at four seconds
 * and another at nine. Fifty is `5 / 0.1` written out rather than a distinction — what it buys is that a client
 * whose CoreGui is not ready on the first frame (the ordinary case, since Roblox's own scripts start after this
 * controller) has a hundred milliseconds per try to get there, and a client where the call raises for another
 * reason is not retried for the rest of the session.
 */
const LEGACY_ATTEMPTS = 50;
const LEGACY_RETRY_SECONDS = 0.1;

/**
 * The client's own decisions about Roblox's built-in UI: **which of the engine's surfaces this game turns off.**
 *
 * **One file owns them, rather than a line in whichever controller happened to be nearest.** The player list was
 * disabled from `ShiftLock` for one revision, which is a camera controller — and a reader who opened that file
 * for the shoulder lock found a paragraph about team identity and a `GetService` for a service the camera has no
 * interest in. The two decisions are different in kind: the backpack genuinely belongs to that file, because `~`
 * is also the backpack's key and one of the two had to give, where this is a whole-screen question that belongs
 * to the game rather than to a subsystem.
 *
 * **Only the player list is turned off here, and the rest of the chrome is deliberately left alone.** Health,
 * chat, the topbar, the emotes menu and the rest are all still there: this game has no argument with them, and a
 * file that switched off CoreGui wholesale would be one nothing could be added back to. The backpack is not here
 * either — `ShiftLock` keeps it, for the reason above.
 *
 * **It sits at the root of the controllers tree and not under a family**, which is the one file here that does.
 * Every other controller serves a subject the folders name — audio, camera, character, hud, input — and this one
 * serves none of them: it governs the *engine's* UI, which is the thing the HUD is an alternative to rather than
 * a part of. Filing it under `hud` would say it draws something.
 */
@Controller()
export class CoreGuiController implements OnStart {
	public onStart(): void {
		// **Spawned rather than done inline, which is what every controller here does — but not for the reason
		// the others give.** They spawn because their mounts yield (a `WaitForChild`, a service that is not up
		// yet); nothing below yields: `GetService` and a property write are both synchronous. It is spawned for
		// the shape, and for the report — the ignition sequence is not the place to emit a warning about a
		// cosmetic setting, and a controller whose whole mount is one call has no reason to be the one file that
		// does it differently. Said plainly rather than left as a comment that would be copied and be false.
		task.spawn(() => this.mount());
	}

	private mount(): void {
		/**
		 * **The default player list is turned off, because this game already answers the question it answers, and
		 * answers it better.**
		 *
		 * A side is drawn three times over, all of it from the one table of `TEAM_COLORS`: on the body
		 * (`OutlineService` recolours a character's `Highlight` per team), on the floor (the team ring
		 * `TeamRingController` keeps under every player) and on the score bar's two circles. That is this game's
		 * own answer to "who is on my side", in the map's own red and blue.
		 *
		 * **The default list has nothing to add to it, because this project never joins Roblox's team system.**
		 * `RoundService` keeps its own map of player to side and publishes it as `TEAM_ATTRIBUTE`; nothing anywhere
		 * sets `Player.Team`, and nothing reads `Teams`. The player list groups its rows by that property, so for
		 * this game it is a flat column of names laid over the readout that actually says who is who — one more
		 * surface in the engine's own visual language, over a HUD that already says everything the game means to
		 * say.
		 *
		 * **Disabled rather than restyled**, which is the same call `ShiftLock` makes about the backpack and for
		 * the same reason: it is Roblox's surface, drawn in Roblox's language, and there is nothing this game wants
		 * to say in it.
		 *
		 * **"A custom leaderboard would be a second score display" was the argument here, and it has been
		 * narrowed rather than dropped.** That sentence was written when the only thing the game scored was a
		 * *side* — and against a score bar, a second list of numbers would have been two answers to one question.
		 * The stats board (`MatchStatsController`, on hold-`Tab`) is not that: it ranks **people** by what they
		 * themselves did — throws, hits, catches, dodges — which is a question nothing else on screen answers, and
		 * it is asked of the round's own ledger rather than of the score. So the default list is still off, and
		 * what replaced it answers something different rather than the same thing twice. **The part of the
		 * original argument that survives is the surface**: this is still Roblox's page, still drawn in Roblox's
		 * language, and nothing of this game's sides is in it.
		 */
		this.disablePlayerList();
	}

	/**
	 * Asks the engine to hide the default player list — **twice, through the two levers the engine documents,
	 * because one of them has been observed not to be enough.**
	 *
	 * **The report that forced this: `Tab` opened the default leaderboard.** The configuration path below was
	 * already here and already wrote `Enabled = false`, and its own read-back is the only evidence it ever took.
	 * It prints behind `DEBUG_LOGGING`, which is off, so nothing in a captured log said whether it worked — and a
	 * leaderboard that is *enabled* still owns `Tab`. So there are now three changes, and none of them is a
	 * guess about which one is missing:
	 *
	 * 1. **The legacy call, retried** ({@link retryLegacyPlayerListOff}). `SetCoreGuiEnabled` is the documented
	 *    request and it is the one that reaches Roblox's CoreScripts; it can raise while those scripts are still
	 *    coming up, which is the standard reason this call is wrapped in a pcall-retry loop everywhere it appears.
	 * 2. **`Open = false` as well as `Enabled = false`** ({@link applyPlayerList}). These are two different
	 *    properties on `PlayerListConfiguration`: `Enabled` gates the element, `Open` is the state `Tab` toggles.
	 *    Writing both means the outcome does not depend on which one this build honours.
	 * 3. **Both paths report, unconditionally.** A cosmetic setting that cannot be verified is a setting this
	 *    file's own `pcall` paragraph calls "a cosmetic setting reporting itself as a fault" — the difference
	 *    here is that a *silent* success and a *silent* failure looked identical, which is the one thing a log
	 *    must never allow.
	 *
	 * **What the third lever is, and where it lives**: `MatchStatsController` now returns
	 * `Enum.ContextActionResult.Sink` from its `Tab` binding rather than `Pass`, so the panel works whether or
	 * not this file succeeded. That is the belt this file cannot hold — see that binding's own note.
	 *
	 * **Both levers are kept rather than one being chosen**, and the reason is the asymmetry of the failure:
	 * the legacy call is a *request* whose result is not readable, and the configuration is a *value* whose
	 * result is. Between them, one of the two has to be observable, and the pair costs a pcall and a property
	 * write once per session.
	 */
	private disablePlayerList(): void {
		this.retryLegacyPlayerListOff();
		this.watchPlayerListConfiguration();
	}

	/**
	 * **The legacy request, retried until the engine accepts it** — `StarterGui:SetCoreGuiEnabled(PlayerList,
	 * false)`, wrapped because that call raises on a client whose CoreGui is not up yet.
	 *
	 * **The loop is bounded and the failure is loud**, which is the whole difference from the version this
	 * replaces: a single unguarded call that raised would have taken the rest of `mount` with it — there is
	 * nothing else in this controller's mount, so what it took was the report — and a single guarded call would
	 * have been silent. Fifty tries at a tenth of a second is five seconds, the same window
	 * {@link WATCH_SECONDS} gives the configuration path, so a client where both fail says so once.
	 *
	 * **A success prints the read-back**, because `SetCoreGuiEnabled` is a request to the CoreScripts rather than
	 * a write to a setting: the call returning without raising means it was *accepted*, and the read-back is the
	 * only evidence of what the engine then did with it. A `true` there is the finding that sends a reader to the
	 * configuration path rather than to this one.
	 *
	 * **Spawned rather than run inline**, because the first attempt is deliberately made immediately — the common
	 * case is a CoreGui that is already up — but a retry must not hold the frame it started on.
	 */
	private retryLegacyPlayerListOff(): void {
		task.spawn(() => {
			for (let attempt = 1; attempt <= LEGACY_ATTEMPTS; attempt++) {
				const [ok, err] = pcall(() => {
					StarterGui.SetCoreGuiEnabled(Enum.CoreGuiType.PlayerList, false);
				});

				if (ok) {
					logInfo(`[CoreGui] PlayerList disabled — attempt ${attempt}, enabled now reads ${StarterGui.GetCoreGuiEnabled(Enum.CoreGuiType.PlayerList)}`);

					return;
				}

				// **The reason on the way out only**, so fifty identical lines from a client that is simply early
				// do not bury the one that matters.
				if (attempt === LEGACY_ATTEMPTS) {
					logWarn(
						`[CoreGui] SetCoreGuiEnabled(PlayerList) refused ${LEGACY_ATTEMPTS} times over ` +
							`${LEGACY_ATTEMPTS * LEGACY_RETRY_SECONDS}s — the list may stay. ${tostring(err)}`,
					);

					return;
				}

				task.wait(LEGACY_RETRY_SECONDS);
			}
		});
	}

	/**
	 * Asks the engine to hide the default player list **through its configuration object** — the path that
	 * writes a setting rather than requesting one.
	 *
	 * **Through `CoreGuiConfiguration`, which is the current mechanism rather than the older one.** Two
	 * documented paths reach this setting — this service's `PlayerListConfiguration.Enabled`, and
	 * `StarterGui:SetCoreGuiEnabled(Enum.CoreGuiType.PlayerList, false)`. The service is the one that *is* the
	 * setting; the legacy call is a request to Roblox's CoreScripts for the same result, and it is what
	 * `ShiftLock` uses for the backpack because there is no configuration object for the backpack. It is reached
	 * by `GetService` because the class is tagged **`NotCreatable, NotReplicated`** — it cannot be added from the
	 * Explorer and it will never be listed there as an ordinary service, which is why searching the place file
	 * for it finds nothing. That is a fact about how it is exposed rather than a sign that the build lacks it.
	 *
	 * **`pcall`'d and type-proved, for the reason `ShiftLock.cameraSettings` gives for its own service lookup
	 * rather than out of caution.** The typings prove the *type* exists — `CoreGuiConfiguration` and
	 * `PlayerListConfiguration` are both in the installed dump, and `DataModel.GetService`'s service map accepts
	 * the name — and they cannot prove that this client *exposes* the service at runtime, which only the engine
	 * can answer: a build older than the service raises here rather than returning nothing. So the lookup and the
	 * proof are separated the way that file separates them, and what comes back is checked rather than asserted.
	 *
	 * **And the guard is what stops a cosmetic setting from reporting itself as a fault.** There is nothing else
	 * in this controller for a raise to take with it — the mount is this one call — so what the guard buys is not
	 * collateral, it is the *report*: a red error and a traceback, once per session, on a client where the player
	 * list simply stays visible. A named warning says which of the two lookups failed and what the consequence is,
	 * which is the line worth having in a log.
	 *
	 * **The property is not the handle on this build, and two rounds of it were spent learning that.** The first
	 * version read `PlayerListConfiguration` once, found it nil and gave up; the log said it was 71 milliseconds
	 * into the client's boot, so the second version read the timing as the cause — the CoreScripts that create
	 * these objects not being up yet — and waited. **That was wrong, and the next run said so.** This is what the
	 * service actually held, at mount and again five seconds later, unchanged:
	 *
	 *     [CoreGui] no PlayerListConfiguration at mount — CoreGuiConfiguration holds
	 *               PlayerListConfiguration <PlayerListConfiguration>,
	 *               CapturesViewConfiguration <CapturesViewConfiguration>,
	 *               SelfViewConfiguration <SelfViewConfiguration>
	 *
	 * The object was sitting under the service the whole time, named and classed exactly as the dump describes —
	 * while the *property* that is documented to point at it read `nil` at mount and was still `nil` when the
	 * watch window closed. So there is nothing to wait for: {@link applyPlayerList} looks the object up as a
	 * child, and what is watched for is a child arriving rather than a property being set.
	 *
	 * **What is *not* claimed is why the engine leaves a documented reference unset.** That is not something this
	 * repository can read, and inventing a reason for it would be the same mistake as reading the last one as a
	 * race. What is known is narrow and enough: the child exists, it is the class the dump names, and the two
	 * properties the dump puts on that class are `Enabled` (inherited from `BaseCoreGuiConfiguration`) and `Open`
	 * (its own).
	 *
	 * **A property assignment rather than a request**, which is why the read-back in {@link applyPlayerList} is a
	 * cheap assertion rather than the load-bearing half it is at `ShiftLock`'s backpack call: `SetCoreGuiEnabled`
	 * asks the CoreScripts to do something, so printing the read-back there is the only evidence it was done;
	 * this writes the setting itself. **Both read-backs are now printed unconditionally** — see
	 * {@link applyPlayerList} for the run that made that necessary — because a `true` would say the engine kept
	 * the list, and that is the line that sends the next reader somewhere else entirely.
	 *
	 * **The connection is not disconnected**, deliberately: it fires when the object is created, which happens
	 * once, and a second firing would only re-assert a setting nothing else in this game writes.
	 */
	private watchPlayerListConfiguration(): void {
		const [ok, found] = pcall(() => game.GetService("CoreGuiConfiguration"));

		if (!ok || !typeIs(found, "Instance") || !found.IsA("CoreGuiConfiguration")) {
			logWarn(`[CoreGui] no CoreGuiConfiguration — the default player list stays. ${tostring(found)}`);

			return;
		}

		if (this.applyPlayerList(found, "at mount")) return;

		// **What the service holds while it waits**, which is the line that says whether the other two
		// configuration objects are there: if they are and the player list's is not, this build does not carry
		// one and the legacy call is the only path left.
		if (DEBUG_LOGGING) {
			logInfo(`[CoreGui] no PlayerListConfiguration at mount — ${found.GetFullName()} holds ${describe(found)}`);
		}

		// **Watching the children rather than the property**, which is the same correction: a changed-signal on a
		// property this build never sets would never fire, and the object appearing is a child being added.
		found.ChildAdded.Connect(() => this.applyPlayerList(found, "on arrival"));

		task.delay(WATCH_SECONDS, () => {
			if (this.applyPlayerList(found, `after ${WATCH_SECONDS}s`)) return;

			logWarn(
				`[CoreGui] still no PlayerListConfiguration ${WATCH_SECONDS}s in — the list stays. ` +
					`${found.GetFullName()} holds ${describe(found)}`,
			);
		});
	}

	/**
	 * Turns the player list off if its configuration object is there, and answers whether it did.
	 *
	 * **It looks the object up as a *child*, which is the correction the log forced.** The documented way in is
	 * the service's own `PlayerListConfiguration` property, and on this build that reads `nil` while the object
	 * itself is present under the service — see `disablePlayerList` for the two runs that established it. The
	 * child is therefore the handle that exists, and it is the class the dump names, so the property written here
	 * is the one the dump puts on that class.
	 *
	 * **Nothing is proved about *why* the property is unset**, and the comment says so rather than guessing a
	 * third time: what is known is that the child is there, that it is a `PlayerListConfiguration`, and that
	 * `Enabled` is inherited onto it from `BaseCoreGuiConfiguration`.
	 *
	 * **Written to be called up to three times a session** — at mount, when a child arrives, and once at the end
	 * of the watch window — so it does nothing at all when the object is absent, and re-asserting `Enabled = false`
	 * on an object that is already off costs nothing.
	 *
	 * **`when` is the part of the report that matters**, because the other question it answers is *when* the object
	 * appears: `at mount` is the healthy case, `on arrival` is the object having been created after this client's
	 * controllers came up, and `after Ns` is the last look before the report says it never came at all.
	 */
	private applyPlayerList(config: CoreGuiConfiguration, when: string): boolean {
		const playerList = config.FindFirstChild("PlayerListConfiguration");
		if (playerList === undefined || !playerList.IsA("PlayerListConfiguration")) return false;

		// **Two properties, because they are two different levers.** `Enabled` gates the element — the
		// documentation on `BaseCoreGuiConfiguration` says "whether the built-in CoreGui element controlled by
		// this configuration object is enabled" — while `PlayerListConfiguration.Open` is "whether the built-in
		// player list is currently open", which is the state `Tab` toggles. Writing both means the answer does
		// not depend on which one this build treats as authoritative, and the cost is one more assignment.
		//
		// **`pcall`'d as a pair, and the guard is what keeps a new lever from taking an old one with it.** These
		// are property *writes* on an engine object whose writability is not something the typings can promise —
		// `Enabled` is inherited and `Open` is this class's own — so a refusal would otherwise raise out of this
		// method, out of `watchPlayerListConfiguration`, and into the mount thread: the child watch and its
		// five-second report would never be set up, and the failure would be a missing log line rather than a
		// warning. The object being found is still a `true`, because what this method answers is "is there
		// something here to write to" — a refused write is reported where it happens.
		const [wrote, err] = pcall(() => {
			playerList.Enabled = false;
			playerList.Open = false;
		});

		// **Unconditional rather than behind `DEBUG_LOGGING`, which is the change the missing log forced.** The read-back
		// is the only evidence this setting took, and a `true` here is the finding that sends a reader to the
		// legacy path — a line that is off by default is a line that is not there on the run where it matters.
		// The engine may also *accept* the write and keep the list, which is exactly what this prints and the
		// `Debug` variant never could.
		logInfo(
			`[CoreGui] PlayerList disabled ${when} — ` +
				`enabled reads ${playerList.Enabled}, open reads ${playerList.Open}`,
		);

		if (!wrote) logWarn(`[CoreGui] could not write the player list's settings ${when} — ${tostring(err)}`);

		return true;
	}
}

/**
 * What the service holds, as names and classes, for one log line.
 *
 * **A free function rather than a method**, because it reads an `Instance` and nothing else — the shape and the
 * reason `phaseOf` gives in `ArenaFreezeCountdownController`, which keeps its own three lines rather than
 * exporting a helper for one expression. **The classes are the point, not the names**: this service is documented
 * to hold three configuration objects, and seeing which kinds are present is how "the player list's is not up
 * yet" is told apart from "this build does not carry one" — a name alone would not say that.
 */
function describe(config: CoreGuiConfiguration): string {
	const parts = new Array<string>();

	for (const child of config.GetChildren()) {
		parts.push(`${child.Name} <${child.ClassName}>`);
	}

	return parts.size() === 0 ? "nothing" : parts.join(", ");
}
