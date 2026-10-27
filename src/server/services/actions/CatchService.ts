import { OnStart, Service } from "@flamework/core";
import { Players, RunService } from "@rbxts/services";
import { ACTION_CONFIG } from "shared/config/action.config";
import { CATCH_CONFIG } from "shared/config/catch.config";
import { DEBUG_CONFIG } from "shared/config/debug.config";
import { CATCHING_ATTRIBUTE, CATCH_READY_AT, DODGE_READY_AT } from "shared/constants";
import { resolveDodgeable } from "shared/dodge";
import { events } from "shared/networking";
import { DEBUG_LOGGING, logDebug, logInfo } from "shared/logger";
import { lockoutElapsed } from "./actionLock";
import { DevService } from "../../dev/DevService";
import { FreezeService } from "./FreezeService";
import { extendReadyAt, publishReadyAt } from "./readyAt";
import { BallService } from "../ball/BallService";
import { WalkSpeedService } from "../character/WalkSpeedService";
import { DodgeService } from "./DodgeService";
import { roundCelebrating } from "../round/roundStatus";

/**
 * TEMPORARY — **the input half of the catch trace.** Set to `false`, or delete this block and its call sites, once the
 * log has been read. See `BallComponent`'s `TRACE_CATCH` for the ball half.
 *
 * **Two flags rather than one shared constant**, and the reason is that the two files answer different questions: this
 * one says whether the *press* was accepted and a window opened, that one says whether the *ball* was eligible at all.
 * A single flag would still work — but a shared module for a temporary diagnostic is more to remove than two booleans.
 *
 * **What it proves, on this side.** `attemptCatch` already prints at `DEBUG_LOGGING` for most of its refusals, but `DEBUG_LOGGING` is
 * off in every shipped file, so a real session shows nothing at all. This prints on the outcome that matters — window
 * opened, or refused and why — so the log can be read against the ball's side without turning on a per-refresh line.
 */
const TRACE_CATCH = true;

/**
 * How long a catch keeps the pair busy: the window, plus the lockout a dodge is refused for after
 * it closes.
 *
 * A sum rather than a value of its own, derived here rather than written into a config, because
 * both halves are already shared — the window is this service's own clock and the tail is the
 * pair's rule — so there is nothing left to choose and nothing to keep in step. The client adds up
 * the same two config values, which is what keeps the readout and the rule moving together.
 */
const CATCH_BUSY_SECONDS = CATCH_CONFIG.WINDOW_SECONDS + ACTION_CONFIG.ACTION_LOCKOUT_SECONDS;

/**
 * Catch windows, decided by the server.
 *
 * An attempt does not catch anything by itself — it opens a window, and the ball
 * that arrives inside that window is the one caught. That is what makes catching
 * a read of the throw rather than a reaction to the ball's arrival: `BallComponent` asks
 * {@link isCatching} when a ball touches a catchable part, and {@link consume}s
 * the window so one attempt catches one ball. **And the window is also a shield** — see
 * `catch.config.ts`, which spells out the consequence of every limb catching: any body
 * contact while it is open is a catch, so it defends as well as reads.
 *
 * Everything is keyed on the **model**, never the player. A catcher is any living
 * humanoid — an NPC differs from a player's character in nothing but the player
 * behind it — so the player path is just the remote handler below, which hands us
 * the model, and an NPC's AI makes the very same call directly. The one thing
 * keyed on a player is the dev flag, because that is where flags live: see
 * {@link alwaysCatching}.
 */
interface CatchWindow {
	/** `os.clock` seconds at which this window stops counting. */
	expiresAt: number;

	/**
	 * Fires if the catcher dies before the window is spent.
	 *
	 * Kept rather than merely connected so that closing the window closes this too:
	 * a catching NPC asks for a window every tick, and one listener per request
	 * would pile up thousands of watches on a humanoid that only dies once.
	 */
	death: RBXScriptConnection;
}

@Service()
export class CatchService implements OnStart {	/**
	 * Every open window, keyed on the model that is catching.
	 *
	 * An entry only exists while a window is open: it is spent by a catch, dropped
	 * when it expires, and dropped when its catcher dies or leaves.
	 */
	private readonly windows = new Map<Model, CatchWindow>();

	/**
	 * Devs catching with the window held open, keyed on the player because that is
	 * where the flag lives.
	 *
	 * Kept apart from {@link windows} on purpose: an endless window is not a long
	 * one. It has no expiry to store and no clock to compare against, so a sentinel
	 * in the time map would mean every reader of that map having to know about the
	 * sentinel. Checked first instead, and the map is then never consulted.
	 */
	private readonly alwaysCatching = new Set<Player>();

	/**
	 * When each model's last catch window stopped counting, keyed on the model.
	 *
	 * Written in **one** place, {@link consume}, which is already the only way a window is
	 * spent, dropped or found expired — so there is no path that closes a window without
	 * leaving a time here. Read by {@link getLastCatchWindowCloseTime}, which is what a dodge
	 * is gated on.
	 */
	private readonly lastCatchCloseAt = new Map<Model, number>();

	/**
	 * When each model's catch *cycle* ends, keyed on the model.
	 *
	 * **Not the window's expiry.** A window is how long a catch is possible; a cycle is the window
	 * plus the lockout that follows it, and it is what a second press is refused by — so holding
	 * the key is one attempt rather than a permanently open window, which is what "press E to
	 * catch" has to mean for a catch to be a read of the throw.
	 *
	 * A press inside the cycle changes nothing: no window opens, no window is extended, and this
	 * stamp does not move. A catch that lands still ends only the window — the cycle is what the
	 * player owes between attempts, not what the ball pays off.
	 */
	private readonly catchReadyAt = new Map<Model, number>();

	constructor(
		private readonly dev: DevService,
		private readonly dodges: DodgeService,
		private readonly balls: BallService,
		private readonly freezes: FreezeService,
		private readonly speeds: WalkSpeedService,
	) {
		// The dodge is gated on the catch, and this is where the catch side of that is handed
		// over: the two services are gated on each other, and Flamework errors on a circular
		// dependency, so exactly one of them can hold the other. This one holds the dodge
		// service — which is what lets {@link attemptCatch} ask it directly — and gives itself
		// back the other way, as the thing the dodge service asks about catch windows.
		//
		// In the constructor rather than `onStart` so that there is no frame in which one
		// service is running and the other has not been told about it.
		//
		// **`BallService` is held for one question, and it is not the same problem.** The dodge
		// pairing needed breaking by hand because it is mutual; the ball is an ordinary one-way
		// ask — see {@link attemptCatch} — and `BallService` knows nothing about catching, so
		// there is nothing here to untangle.
		this.dodges.watchCatchState(this);

		// **And the stamina pool, which is a third thing that has to be able to see this window.**
		// A catch is an *attempt* — a body with its hands up — and `WalkSpeedService` holds the pool's
		// recovery for as long as one is open, so that recovering stamina and standing there ready to
		// catch are not things a player can do at once. Handed over on `watchCatchState`'s own terms
		// rather than injected into that service: the pool is keyed by *player* and a catch window is
		// keyed by *model*, so the service that owns the pool asks about the model it already has
		// instead of being given a second way to find one.
		//
		// Deliberately **not** an injection the other way — `WalkSpeedService` knows nothing about
		// catching, and giving it a reason to would be a dependency pointing the wrong way down a graph
		// it sits at the bottom of. See its `watchCatchState`.
		this.speeds.watchCatchState(this);
	}

	public onStart() {
		events.Server.OnEvent("catch", (player) => {
			// The arrival line, printed before anything is decided. A press that produces
			// no output at all and a press that produces the wrong output look identical
			// from the player's seat, and this is the one line that says the event got here
			// — so its absence means the key or the wire, never the catch itself.
			logDebug(`[Catch] ${player.Name} asked to catch`);

			const character = player.Character;
			if (!character) {
				logDebug(`[Catch] ${player.Name}: no character to catch with`);
				if (TRACE_CATCH) logInfo(`[Catch] ${player.Name}: REFUSED — no character yet`);
				return;
			}

			if (!this.attemptCatch(character) && TRACE_CATCH) {
				logInfo(`[Catch] ${player.Name}: REFUSED — see the line above for why`);
			}
		});

		// A window that outlives its catcher would be a catch waiting to happen on a
		// model nobody owns any more.
		Players.PlayerRemoving.Connect((player) => {
			const character = player.Character;
			if (character) this.forget(character);
		});

		// **The eight-stud radius, and it costs one map-size check on the frames where nobody is catching.**
		//
		// **A single connection for the whole service rather than a loop per window.** A `task.spawn` per press would be
		// one thread per catcher per press, each with its own `task.wait` and its own cancellation problem — and a
		// window can be *extended* rather than reopened (`attemptCatch`'s extension branch), so a per-press loop would
		// have to know whether it was still the live one. This loop asks the table instead: `windows` is the record of
		// which windows are open, so an empty table is the whole of "nobody is catching" and the early return below is
		// the entire idle cost.
		//
		// **It iterates the open windows rather than `Players`**, so the work scales with how many people are pressing
		// catch rather than with how many are on the server — and it is keyed by the *model*, which is what the radius
		// needs anyway.
		//
		// **The window is not closed here.** A proximity catch goes through `BallComponent.tryCatch` → `consume`, which
		// is the same call a `Touched` catch makes, so "one ball per window" is one rule rather than two that have to
		// agree. This loop only asks; the ball's own resolution does the rest.
		RunService.Heartbeat.Connect(() => {
			if (this.windows.size() === 0) return;

			for (const [model] of this.windows) {
				const root = model.FindFirstChild("HumanoidRootPart");
				if (root === undefined || !root.IsA("BasePart")) continue;

				if (this.balls.catchByProximity(model, root.Position, CATCH_CONFIG.CATCH_RADIUS_STUDS)) {
					// TEMPORARY — remove with `TRACE_CATCH`. **Distinguishes a radius catch from a `Touched` one**, which
					// is the question this feature will be judged on: if this never prints, the ball is not passing within
					// eight studs and the radius is not the reason a catch did or did not happen.
					if (TRACE_CATCH) {
						logInfo(`[Catch] ${model.Name}: caught by PROXIMITY — within ${CATCH_CONFIG.CATCH_RADIUS_STUDS} studs`);
					}
				}
			}
		});
	}

	/**
	 * Opens a catch window on `model`, or extends one already open.
	 *
	 * Returns whether one opened, which is the same question as whether `model` can
	 * catch at all: a catcher is a living humanoid, exactly what a dodge needs — so
	 * the model is resolved and checked with the same helper, and the two rules
	 * cannot drift apart.
	 *
	 * The public entry point for both paths. A player reaches it through the remote
	 * above; an NPC's AI calls this directly.
	 */
	public attemptCatch(model: Model): boolean {
		const humanoid = resolveDodgeable(model)?.humanoid;
		if (!humanoid || humanoid.Health <= 0) {
			logDebug(`[Catch] ${model.Name}: no living humanoid to catch with`);
			// TEMPORARY — remove with `TRACE_CATCH`.
			if (TRACE_CATCH) logInfo(`[Catch] ${model.Name}: REFUSED — no living humanoid`);

			return false;
		}

		// **A free hand is what catches, and this is where that is decided.** The client refuses
		// the same press for the same reason and never fires — see `CatchController` — which is the
		// responsive half and saves the round trip. But a prediction is not a rule: a remote can be
		// fired by hand, and this is the half that a crafted call meets.
		//
		// Keyed on the **model**, like every other hand rule in the game, so an NPC is held to it
		// without a line of its own — `CatchBehavior` asks through this same call, and a rig holding
		// a ball is refused here exactly as a character is. That is a decision and not an accident: a
		// catch does not join the ball already in the hand, it *replaces* it — see
		// `BallService.attachToHand` — so a rig allowed to catch while armed would be trading the ball
		// it was issued for the one it caught.
		//
		// **`InfiniteCatch` does not lift this, and it is checked above the dev's window for exactly
		// that reason.** That flag moves the window's *clock* — one press, an endless window instead of
		// `CATCH_CONFIG.WINDOW_SECONDS` — and a free hand is not a clock: it is a state the dev can be
		// in or not, the same way a player can. A dev testing a catch empties their hand with `1` first,
		// which keeps the test honest rather than exempting the tester from the rule under test.
		// The lockouts below hold for a dev too, for the same reason.
		//
		// Ahead of {@link blocksCatch} rather than behind it because it is the one that cannot be waited
		// out: a lockout expires on its own, and a ball in the hand does not. (This used to rest on
		// "everybody is handed a ball on join", which stopped being true when players started fetching
		// their own off the arena floor — see `JoinService` — so the ordering rests on the wait alone.)
		const held = this.balls.getHeldBall(model);
		if (held) {
			// Named, and with its `Armed` flag, because those two facts are the whole diagnosis when a
			// rig will not catch. **Only `giveBall` arms a ball**, and for a rig the only thing that
			// calls it is `ThrowBehavior` — so an armed ball stuck in a catcher's hand means something
			// issued it a ball, whether or not that rig was meant to have a throwing tag. An inert ball
			// is the other case entirely: a catch or a pickup that has not been dropped yet, and which
			// `CatchBehavior` takes out of the hand on its next tick.
			if (DEBUG_LOGGING) {
				logInfo(
					`[Catch] ${model.Name}: refused — ${held.Name} is already in hand` +
						` (Armed ${held.GetAttribute("Armed")})`,
				);
			}

			// TEMPORARY — remove with `TRACE_CATCH`. **The most likely refusal on the input side for a player who
			// has just picked a ball up**: a hand that already holds one cannot catch another, because a catch
			// replaces the ball in the hand rather than joining it.
			if (TRACE_CATCH) {
				logInfo(`[Catch] ${model.Name}: REFUSED — a ball is already in hand (${held.Name})`);
			}

			return false;
		}

		// Before anything opens, and before the dev's endless window: this gates the *entry*
		// into catching, so it holds for a dev exactly as it holds for anybody else — the dev
		// flags move each action's own clock, and this is not one of those. See
		// {@link lockoutElapsed}.
		if (this.blocksCatch(model)) {
			// TEMPORARY — remove with `TRACE_CATCH`. `blocksCatch` prints its own reason at `DEBUG_LOGGING`, which is off in a
			// shipped session; this line is what makes the refusal visible. A frozen catcher, a dodge in flight and a
			// dodge that ended a moment ago are the three ways in.
			if (TRACE_CATCH) logInfo(`[Catch] ${model.Name}: REFUSED — catch blocked (frozen, dodging, or just dodged)`);

			return false;
		}

		// A dev testing a catch does not need good timing: with the flag on, one press
		// is a window that stays open until a ball arrives.
		if (this.holdOpenForDev(model)) return true;

		const now = os.clock();
		const player = Players.GetPlayerFromCharacter(model);

		// **The cycle gates a key press, and only a key press.** It exists to make a second press
		// inside the window a press that does nothing, so it belongs to the model somebody is
		// holding the key for. An NPC has no key: its AI asks on a timer of its own
		// (`CatchBehavior`), and asking that often is *how* it keeps a window open — each attempt
		// re-stamps the window, so the rig is a catcher continuously rather than a catcher only
		// while a cycle happens to be open. Gated here, an NPC would spend most of its time in the
		// gap between cycles, and whether it caught the ball would come down to when the ball
		// arrived.
		if (player !== undefined) {
			const readyAt = this.catchReadyAt.get(model);
			if (readyAt !== undefined && now < readyAt) {
				logDebug(`[Catch] ${model.Name}: still in the catch cycle`);

				// TEMPORARY — remove with `TRACE_CATCH`. **A press inside the cycle does nothing at all**, so a player
				// mashing catch after a bounce lands every press but the first in here and sees no window open. The
				// remaining wait is printed because it is the number that distinguishes "just missed" from "the cycle
				// never reset".
				if (TRACE_CATCH) {
					logInfo(
						`[Catch] ${model.Name}: REFUSED — still in the catch cycle, ` +
							`${string.format("%.2f", readyAt - now)}s to go`,
					);
				}

				return false;
			}

			// The cycle starts here, where the attempt has been accepted and nothing below can
			// refuse it, and it is published from the same value — so the client's bar and this
			// guard cannot be talking about two different waits.
			this.catchReadyAt.set(model, now + CATCH_BUSY_SECONDS);
			publishReadyAt(model, CATCH_READY_AT, CATCH_BUSY_SECONDS);

			// The mirror of the dodge's own write. A catch cycle shuts *dodging* for as long as it
			// runs, so the dodge bar is told the same wait the catch bar is, and the two readouts
			// cannot disagree about whether the pair is busy.
			//
			// "At least" rather than outright, because the wait behind that bar can be longer than
			// this one — a catch must never bring a longer cooldown forward.
			//
			// Reached only where the cycle really opened: a press refused by a dodge returns above,
			// and so does a dev's endless window, which is not a cycle at all.
			extendReadyAt(model, DODGE_READY_AT, CATCH_BUSY_SECONDS);
		}

		const open = this.windows.get(model);

		// Already catching: the window is *extended*, not replaced. Nothing else
		// changes, and in particular the death watch is not registered again — a
		// catching NPC asks for this every tick, so one watch per request would leave
		// it holding thousands of listeners for a death that happens once.
		if (open) {
			open.expiresAt = now + CATCH_CONFIG.WINDOW_SECONDS;

			// **A window can be extended *after* its trail has stopped, and this branch used to answer for
			// that.** An expired window is left in the table until somebody asks about it, so a rig that
			// stopped catching for longer than one window and then started again arrives here rather than at
			// the branch below — and while the body left a trail, that mattered: `startAfterimage` answered
			// whether *this* call had started one, and the timer was armed only when it had, because arming a
			// second timer for the same window would have left two threads counting down the same expiry.
			//
			// **There is no trail to arm now** — that removal is documented at the branch below — so the
			// extension above is exactly what it reads as: a new expiry, and nothing else. A window that runs
			// out on its own is still nobody's business but {@link isCatching}'s, which has always been what
			// decides expiry; the trail was the only thing here that needed a timer, and it is gone.

			return true;
		}

		// The window dies with the catcher. `Once` because a humanoid dies once.
		//
		// Built as a local before it is stored, and that is what the trail's timer used to hang on: the record
		// is the *token* for this window, so a timer armed with it could tell "my window is still the one open"
		// from "my window was spent and another has taken its place" without a second map to keep. That timer
		// went with the trail — the note below is where — so the local now buys nothing but a name for a thing
		// that is otherwise created and stored in one breath.
		const window: CatchWindow = {
			expiresAt: now + CATCH_CONFIG.WINDOW_SECONDS,
			death: humanoid.Died.Once(() => this.forget(model)),
		};

		this.windows.set(model, window);

		// TEMPORARY — remove with `TRACE_CATCH`. **The line that says the input was accepted.** If this prints and the
		// ball never follows with its own line, the window opened and no eligible ball arrived inside it — so look at
		// what the ball was doing (`Armed`, `not in the world`, `no catch window open`) rather than at the press.
		if (TRACE_CATCH) {
			logInfo(
				`[Catch] ${model.Name}: window OPENED for ${string.format("%.2f", CATCH_CONFIG.WINDOW_SECONDS)}s` +
					` — waiting for a ball to touch`,
			);
		}

		// **And the window itself is published, which is what the two visible halves of a catch are read from.**
		// `CATCHING_ATTRIBUTE` is a *state* rather than an event: it is up for as long as a window is open,
		// which is longer than the animation mark below and shorter than the catch cycle the client's bar shows.
		// Two readers, one per kind of body — `AimFacingController` turns the local player onto the camera and
		// `CatchBehavior` turns a rig onto the ball — and one signal between them is the whole reason it is an
		// attribute rather than two client-side models that could disagree.
		//
		// **Set on open and never on the extension branch above**, on exactly the argument the animation mark
		// makes: a rig holding a window open asks every tick, and a property written twenty times a second with
		// the value it already holds is twenty replication candidates for one fact. Absence is "not catching",
		// and {@link consume} is the only thing that writes it.
		model.SetAttribute(CATCHING_ATTRIBUTE, true);

		// **And the body is marked as mid-catch, which is what the catch's own clip is played from — the
		// *attempt*, with no ball anywhere near it.**
		//
		// **A catch and an attempt are the same animation, so they are the same mark**, and the mark's one writer
		// is `BallService.markCatchAnimation` — reached from here when a window opens and from `catchBall` when
		// the ball actually arrives. A body reaching for a ball it never gets is doing the same thing as one that
		// gets it, and the press has no other feedback at all.
		//
		// **Written here rather than above the branch, and that placement is the whole of the rule.** The line
		// below this one extends a window that is already open — which a rig with `AlwaysCatching` asks for
		// *every tick*, deliberately, because that is how it holds a window open continuously. A mark written on
		// the extension would be a mark rewritten twenty times a second for the whole of that rig's life, which
		// is a rig frozen in a catch pose rather than a rig catching. A *new* window is the event worth drawing:
		// a press that was accepted, or a gated rig's first ask after its last window closed. The successful
		// catch draws it again from `BallService`, on top of this.
		this.balls.markCatchAnimation(model, "attempt");

		// **No trail opens with the window, and nothing is armed for when it ends.**
		//
		// Opening a window used to start the afterimage right here and arm the one timer that stopped it when
		// a window ran out on its own. The trail was removed — the cue stood for "this body is mid-action"
		// and a catch and a dodge are not the same action to read, so a body trailing behind it said *dodge*
		// while the body was in fact reaching for a ball — the two cues are one cue, and only one of the two
		// actions is a dodge, so the cue belongs to the dodge and was briefly taken away from it and given
		// back. `shared/afterimage.ts` is untouched and is the dodge's again; what was removed here is the
		// catch's own two asks and its stop.
		//
		// **What this costs:** there is nothing drawn at the instant a catch *begins*. The catch pose from
		// {@link markCatchAnimation} above is now the whole of that feedback, and a body that is catching
		// looks like a body that is standing there until the ball actually arrives.
		//
		// The window itself is unchanged: it opens here, re-asks extend it, and {@link isCatching} expires it
		// lazily. The trail was the only part of it that could not be lazy about *when it was noticed*, which
		// is why it had a timer and the window does not.

		logDebug(`[Catch] ${model.Name}: window open`);

		return true;
	}

	/**
	 * Opens an endless window for a dev, if this is one and the flag is on.
	 *
	 * Player characters only, and not by choice: the flag lives on a `Player`, so an
	 * NPC never has one. That is the entire difference between a dev's catch and
	 * anybody else's here.
	 *
	 * Reached on every attempt, so the state is re-established each time the key is
	 * pressed — there is nothing to keep in step.
	 */
	private holdOpenForDev(model: Model): boolean {
		const player = Players.GetPlayerFromCharacter(model);
		if (!player || !this.dev.getFlag(player, "InfiniteCatch")) return false;

		this.alwaysCatching.add(player);

		// **The endless window is still a window, so it is published like one.** Reached on every press by a dev
		// holding the flag, so this is one write per press rather than one per tick — the value is already `true`
		// after the first, and a repeat of it is no change. Cleared by {@link consume}, which is where the flag
		// going off lands, so the dev's whole exit path is `isCatching` reading the flag and consuming.
		model.SetAttribute(CATCHING_ATTRIBUTE, true);

		// **The dev's endless window draws no trail either**, from the same removal — see the note on the
		// normal branch above. This one is worth a line of its own because it was the case with no timer at
		// all: an endless window has no expiry to aim a stop at, so its trail ended where the window ended,
		// through {@link consume} on the flag going off or on a catch. *That* path is still live and still
		// matters — it is one of the five ways a window closes, and it is where the dodge lockout is stamped
		// too — it simply no longer has a trail to switch off on the way through.

		// An endless window is not a length, so there is nothing to count down: the readout is told
		// the wait is over rather than left showing the remains of whatever window came before it.
		publishReadyAt(model, CATCH_READY_AT, 0);

		// **And the attempt draws, like any other.** This method is reached on *every* press by a dev holding
		// the flag — the cycle gate below it is what refuses a second press for everybody else, and a dev is
		// deliberately not held to it — so this is one mark per press rather than one per tick: the press is the
		// event, and it is the only thing here that repeats.
		this.balls.markCatchAnimation(model, "attempt");

		logDebug(`[Catch] ${model.Name}: endless window open (dev)`);

		return true;
	}

	// **`armAfterimageTimer` stood here.** One timer per open window, and its whole job was to stop the trail
	// when a window ran out on its own rather than being spent by a catch or dropped by a death — the case
	// {@link isCatching} cannot report, because it only finds an expired window when somebody asks about it.
	// With no trail there is no emission to stop, so the timer went, and its re-arming and its identity test
	// against {@link windows} went with it.
	//
	// **What it did not do is expire the window**, and that is why nothing replaces it: expiry was, and still
	// is, lazy and {@link isCatching}'s alone. A window that runs out with nobody asking about it leaves one
	// stale entry in the table until the next ask — which is the cost the trail was paying for, and the only
	// reason it needed a thread of its own.

	/**
	 * Whether `model` has a catch window open at this instant.
	 *
	 * Expiry is decided here rather than on a timer: the only moment a window
	 * matters is the moment a ball arrives to test it, and a stale entry is dropped
	 * as it is found — so a window nobody ever tests against costs nothing.
	 */
	public isCatching(model: Model): boolean {
		// The endless case first, and the flag asked afresh rather than remembered:
		// that is what makes `!dev InfiniteCatch off` take effect on the next ball
		// instead of on the next press.
		const player = Players.GetPlayerFromCharacter(model);
		if (player && this.alwaysCatching.has(player)) {
			if (this.dev.getFlag(player, "InfiniteCatch")) return true;

			// The flag has gone off, so the endless window stops counting here — a close like
			// any other, and it goes through `consume` so that it is recorded like any other.
			this.consume(model);
		}

		const window = this.windows.get(model);
		if (!window) return false;

		// Not `until`: that is a Luau keyword, and roblox-ts rejects it as an
		// identifier outright ("Invalid Luau identifier!").
		const expiresAt = window.expiresAt;

		if (os.clock() > expiresAt) {
			logDebug(`[Catch] ${model.Name}: window expired`);

			// Closed through `consume` so the death watch goes with the window: an
			// expired window must not leave a listener behind.
			this.consume(model);
			return false;
		}

		return true;
	}

	/**
	 * `os.clock` seconds at which `model`'s catch window stopped counting, or `undefined` if
	 * it has never had one open.
	 *
	 * Public because the dodge is gated on it; handed over as part of
	 * {@link DodgeService.watchCatchState} rather than the dodge service reaching in here.
	 */
	public getLastCatchWindowCloseTime(model: Model): number | undefined {
		return this.lastCatchCloseAt.get(model);
	}

	/**
	 * Whether `model`'s dodge is in the way of a catch: in flight now, or ended within the
	 * lockout.
	 *
	 * The mirror of the check `DodgeService` makes on this service, and deliberately written
	 * the same way — ask the owner for its clock, apply the shared lockout — so the two rules
	 * cannot be read as two different rules. {@link lockoutElapsed} is that shared lockout.
	 */
	private blocksCatch(model: Model): boolean {
		// **Frozen first, and for the reason `DodgeService.blocksDodge` gives from the other side**: the two
		// things below are clocks that expire on their own, and a freeze is a state that has to be waited
		// out. A frozen body hears that it is frozen rather than that its dodge ended a moment ago.
		if (this.freezes.isFrozen(model)) {
			logDebug(`[Catch] ${model.Name}: refused — frozen`);

			return true;
		}

		// **And nobody catches a round that is over.** Same window as the throw's refusal and the same argument
		// from the other side — see `ARENA_CONFIG.CELEBRATION_SECONDS` and `roundCelebrating` — and it is placed
		// beside the frozen check because that check is the same kind of thing: a state the body is in, not a
		// clock that expires on its own like the dodge pair below. A ceiling catch in the last second of a round
		// would otherwise open a window ten seconds into a result nobody is playing for, and hand the catcher a
		// ball they cannot throw (`BallService.throwBallBody` refuses it for exactly this long).
		if (roundCelebrating()) {
			logDebug(`[Catch] ${model.Name}: refused — the round is celebrating`);

			return true;
		}

		if (this.dodges.isDodging(model)) {
			logDebug(`[Catch] ${model.Name}: refused — a dodge is in flight`);
			return true;
		}

		const since = lockoutElapsed(this.dodges.getLastDodgeEndTime(model));
		if (since === undefined) return false;

		logDebug(`[Catch] ${model.Name}: refused — a dodge ended ${string.format("%.2f", since)}s ago`);

		return true;
	}

	/**
	 * Drops everything this service holds about `model`: its window and its catch cycle.
	 *
	 * For the two moments a model stops being a catcher for good — its humanoid dying and its
	 * player leaving. Every map here is keyed on the model, so an entry that outlives it is never
	 * read again and never cleared; these are the two that are dropped together because they are
	 * the whole of what this service holds against one *catcher*.
	 *
	 * **`lastCatchCloseAt` is the one this deliberately leaves standing.** {@link consume} records
	 * the moment the window stopped counting rather than clearing the row, because the dodge reads
	 * it through {@link getLastCatchWindowCloseTime} — handed over by
	 * {@link DodgeService.watchCatchState} — *after* the window has closed, so deleting the row
	 * here would throw away the answer it is there to give.
	 *
	 * **A spent window does not come through here.** A ball caught inside the window ends the
	 * window and nothing else, because the cycle is what the player owes between attempts and a
	 * good catch does not pay it off. See {@link consume}.
	 */
	private forget(model: Model): void {
		this.consume(model);
		this.catchReadyAt.delete(model);
	}

	/**
	 * Spends `model`'s window, so one attempt cannot catch two balls.
	 *
	 * Also how a window is dropped without being spent — on expiry, on death, on
	 * leaving — because a window that was never spent simply goes away. The death
	 * watch goes with it, so nothing outlives the window it belonged to.
	 */
	public consume(model: Model): void {
		const now = os.clock();

		// An endless window is spent the way any other is spent — one press is still
		// one catch — so leaving the set is part of spending it.
		const player = Players.GetPlayerFromCharacter(model);
		const endless = player !== undefined && this.alwaysCatching.delete(player);

		const window = this.windows.get(model);

		// Nothing was open: most calls are the catch asking after a ball that never came,
		// and a close that never happened must not be recorded as one.
		if (!window && !endless) return;

		if (window) {
			window.death.Disconnect();
			this.windows.delete(model);
		}

		// **The published window comes off here, and here is the only place that can be said of.** Every close
		// path already passes through this method — a ball caught, an expiry found by {@link isCatching}, a
		// death, a departure, and the dev's flag going off — so one clear covers the whole list, and no exit
		// path had to learn that the attribute exists. That is the same argument the removed trail made for
		// being stopped here, and it is why this is not written at each of the five sites.
		model.SetAttribute(CATCHING_ATTRIBUTE, undefined);

		// **When the window stopped counting**, which is not the same thing as this instant:
		// an expired window is only noticed by whoever next asks, and recording *that* moment
		// would make a window that ended a minute ago look like it had just closed — and would
		// shut the dodge for half a second for no reason. So the earlier of the two: its own
		// expiry, or the moment it was spent or dropped. An endless window has no expiry, so
		// for that one it is now.
		this.lastCatchCloseAt.set(model, window ? math.min(now, window.expiresAt) : now);

		// **The trail used to stop here**, and this was the point every close passed through: a window spent
		// by a catch, dropped when the catcher died, dropped when the player left, found expired by
		// {@link isCatching}, and the endless window's close. Putting it here rather than in each of those was
		// the same argument this method's own doc makes about `lastCatchCloseAt` — one writer, so no path
		// could close a window and leave a body still emitting behind it.
		//
		// `stopAfterimage` is gone because nothing emits any more; the starts were the two branches of
		// {@link attemptCatch} and {@link holdOpenForDev}, and each of those carries the note where it stood.
		// Worth recording what this shape bought while it existed: all five closes above were covered by one
		// line, and none of them had to know the trail existed at all.
	}
}
