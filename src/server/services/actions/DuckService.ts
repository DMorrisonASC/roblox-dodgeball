import { OnStart, Service } from "@flamework/core";
import { ACTION_CONFIG } from "shared/config/action.config";
import { DUCK_CONFIG } from "shared/config/duck.config";
import { CATCH_READY_AT, DODGE_READY_AT, DUCKING_ATTRIBUTE, DUCK_READY_AT } from "shared/constants";
import { resolveDodgeable } from "shared/dodge";
import { DUCK_GROUP, duckExemptParts, setDuckGroup } from "shared/duck";
import { events } from "shared/networking";
import { lockoutElapsed } from "./actionLock";
import { extendReadyAt, publishReadyAt } from "./readyAt";
import type { CatchState } from "./DodgeService";
import { DodgeService } from "./DodgeService";
import { FreezeService } from "./FreezeService";
import { WalkSpeedService } from "../character/WalkSpeedService";

/** Prints every duck, every refusal and every exemption. Off never — a duck is a handful of lines a round. */
const DEBUG = true;

/**
 * The duck's two numbers, **read from the config that both machines share.**
 *
 * They were constants of this file until the clip had to be stretched to match the state, and they moved
 * because a number the client also reads cannot live in a server module. Nothing about the reasoning moved
 * with them — it is all beside the values in `duck.config.ts`, which is where a tuning number belongs in
 * this codebase and where the two of them are also read as a *pair*, since the fraction of a round a body
 * can be ducking is `DURATION / (DURATION + COOLDOWN)` and neither number means much alone.
 *
 * Bound to local names rather than spelled out at each use, because this file's comments and its log lines
 * both talk about "the duration" and "the cooldown" and `DUCK_CONFIG.DURATION_SECONDS` in the middle of a
 * sentence is a worse read for no gain. **There is one copy of each value and it is in the config** — these
 * two are reads, not a second place to change a number.
 */
const DUCK_DURATION_SECONDS = DUCK_CONFIG.DURATION_SECONDS;
const DUCK_COOLDOWN_SECONDS = DUCK_CONFIG.COOLDOWN_SECONDS;

/**
 * The name the duck's walk-speed contribution is stored under.
 *
 * A named contribution rather than a write, because `WalkSpeedService` is the only owner of that number
 * — see its class comment — and the duck has to be removable without disturbing the sprint, the freeze
 * or the round's arena freeze. Same shape as `FreezeService`'s `"Frozen"`.
 */
const DUCK_SPEED_KEY = "Duck";

/**
 * The contribution itself, in studs per second — **and it is not zero, which is worth reading twice.**
 *
 * `0` would do nothing at all: the service *sums* its contributions, so `Base + Sprint + 0` is still a
 * walking body. What stops the body is a number large enough to take any possible sum to or below zero,
 * and `WalkSpeedService` clamps the result at zero — so this is "cannot walk" written as arithmetic that
 * does not have to know what anything else contributed. `FreezeService` reached the same shape for the
 * same reason and its value is the same magnitude; it is copied rather than shared because two services
 * that both wrote one constant would be one edit away from a freeze that ducks, or the reverse.
 */
const DUCK_SPEED = -1000;

/**
 * What a duck has to know about the catch window, answered by whoever owns it.
 *
 * **The shape `DodgeService`'s `CatchState` established, and here for its reason**: the duck must refuse
 * while a catch window is open, and `CatchService` must refuse while a duck is up — and a constructor
 * dependency in both directions is a cycle. So the duck is handed this interface by `watchCatchState`,
 * which is the same registration `DodgeService` takes. Declared as **methods**, because the only thing
 * that implements it is `CatchService` passed as an instance, and a class's methods satisfy a method
 * signature where an object literal would not.
 */
export interface DuckCatchState {
	/** Whether `model` has a catch window open at this instant. */
	isCatching(model: Model): boolean;

	/** `os.clock` seconds at which `model`'s catch window stopped counting, or `undefined`. */
	getLastCatchWindowCloseTime(model: Model): number | undefined;
}

/**
 * What another service has to know about a duck to gate itself on one.
 *
 * **The counterpart of `DodgeService`'s `CatchState`, in the other direction, and it exists for the
 * same mechanical reason**: `DuckService` injects `DodgeService` — it has to ask whether a dash is in
 * flight before it starts — so `DodgeService` cannot inject `DuckService` back. `DodgeService` takes
 * this by registration instead, and `CatchService`, `BallService` and `BallPickupService` inject the
 * service directly, because none of them is on this side of the loop.
 *
 * **Two methods rather than one**, because the two questions are asked at different moments: "is it up
 * right now" gates a *contact*, and "when did it end" gates the lockout the other actions share — see
 * `actionLock.lockoutElapsed`, which is measured from an action's *end* and not its start.
 */
export interface DuckState {
	/** Whether `model` is ducking at this instant. */
	isDucking(model: Model): boolean;

	/** `os.clock` seconds at which `model`'s last duck ended, or `undefined` if it has never ducked. */
	getLastDuckEndTime(model: Model): number | undefined;
}

/** One duck in flight: everything the end has to put back, and when it happens. */
interface DuckRun {
	/**
	 * Every part this duck moved, with the collision group it was in before.
	 *
	 * **Remembered per part rather than assumed to be `Character`.** That is where a body part is in this
	 * codebase, because `CollisionGroups.followCharacters` put it there — but a hard-coded write-back
	 * would be a guess about a rig somebody else arranged, and the failure would be a body permanently in
	 * the wrong group after one duck.
	 */
	readonly previousGroups: Map<BasePart, string>;

	/** The root this duck anchored, kept so the end does not have to find it again. */
	readonly root: BasePart;

	/** What `root.Anchored` was before this service set it. */
	readonly rootWasAnchored: boolean;

	/** `os.clock` seconds at which this duck ends. */
	readonly endsAt: number;
}

/**
 * Ducking, decided by the server — **the whole of the mechanic's server half.**
 *
 * **What a duck is, in one paragraph.** A body plants, tucks its head and arms, and stops being able to
 * do anything else for {@link DUCK_DURATION_SECONDS}. For that window the head and the arms do not
 * collide with any ball, so a ball thrown at them passes rather than bouncing and rather than being
 * counted; **the torso, the legs and the root still collide and still hit.** That is the whole trade:
 * mobility and every other action, given up for a narrow evasion of one height band.
 *
 * **Two mechanisms, and they are one rule.** `shared/duck.ts` moves the exempt parts into a collision
 * group the ball does not collide with — that is what makes the ball *pass* — and `BallComponent`
 * refuses the contact that still fires, because a collision group does not suppress `Touched`. Either
 * half alone is wrong in a visible way: a veto alone leaves the ball bouncing off a head the game says
 * it missed, and the group alone leaves it counted.
 *
 * **The stance is two writes and a third.** `WalkSpeedService` gets a contribution far below any total,
 * which the service clamps to zero; the root is anchored, which is what stops a body being *pushed* —
 * a speed sum alone would leave a shoved body sliding; and every action gate asks
 * {@link DuckService.isDucking} before acting, which is the half that cannot be done with physics at
 * all. The anchor is `FreezeService`'s mechanism, taken for its reason: a speed of zero cannot hold a
 * body against a force, and an anchored root cannot be moved by one.
 *
 * **The state is published on the body and the cooldown on the `Player`**, which is `readyAt.ts`'s rule
 * and not a detail: a character is replaced on every death and the cooldown is not, and an NPC has no
 * `Player` behind it and needs no readout. So `DUCKING_ATTRIBUTE` — the fact every other system asks —
 * is on the model, for a player and a rig alike.
 */
@Service()
export class DuckService implements OnStart, DuckState {
	/** The duck each model has in flight. See {@link DuckRun} for what the end has to undo. */
	private readonly ducks = new Map<Model, DuckRun>();

	/** When each model last *started* a duck, purely to time {@link DUCK_COOLDOWN_SECONDS}. */
	private readonly lastDuckAt = new Map<Model, number>();

	/**
	 * When each model's last duck *ended*, which is a different fact from {@link lastDuckAt} and exists
	 * for exactly the reason `DodgeService` keeps its own pair: the cooldown is measured from the start
	 * and the lockout from the end, and the action lock is timed from an end. See `actionLock`.
	 */
	private readonly lastDuckEndAt = new Map<Model, number>();

	/** What the catch window looks like from here, registered by `CatchService`. */
	private catchState?: DuckCatchState;

	constructor(
		private readonly speeds: WalkSpeedService,
		private readonly freezes: FreezeService,
		private readonly dodges: DodgeService,
	) {}

	public onStart(): void {
		events.Server.OnEvent("duck", (player) => {
			const character = player.Character;
			if (!character) return;

			this.requestDuck(character);
		});

		// **The other direction of the pair, registered rather than injected.** `DodgeService` cannot
		// hold this service — this service holds it — so it is handed the two answers it needs instead,
		// which is the arrangement `DodgeService.watchCatchState` already uses one file over.
		this.dodges.watchDuckState(this);
	}

	/** Hands this service the catch window's two answers. See {@link DuckCatchState}. */
	public watchCatchState(state: DuckCatchState): void {
		this.catchState = state;
	}

	/** Whether `model` is ducking at this instant. The question every action gate asks. */
	public isDucking(model: Model): boolean {
		return this.ducks.has(model);
	}

	/**
	 * `os.clock` seconds at which `model`'s last duck ended, or `undefined`.
	 *
	 * **Public because the other actions are gated on it**, which is `DodgeService.getLastDodgeEndTime`'s
	 * shape and its reason: `lockoutElapsed` measures *from an end*, so the fact has to be the end and
	 * not the start, and it has to be readable by a service that does not own the duck.
	 */
	public getLastDuckEndTime(model: Model): number | undefined {
		return this.lastDuckEndAt.get(model);
	}

	/**
	 * The entry point for both paths — the remote handler above and a rig's `Behavior_Ducking` call the
	 * same method, so neither has to be a player.
	 *
	 * **Every refusal is asked here rather than by the caller**, which is the one rule `DodgeService` and
	 * `CatchService` both keep: a caller that had to check for itself would be a second copy of the rules
	 * with a different answer, and the rig path would have to be kept in step with the player's.
	 *
	 * **A duck is refused by a dash, a catch window, a freeze, either lockout, its own cooldown — and by
	 * the air.** The last one is the one worth arguing: a duck is a *plant*, and everything it does is
	 * about a body standing on the ground with its head down. Allowing it mid-air would be a body that
	 * drops its walk speed while falling and anchors itself in the air, which is not a crouch but a
	 * freeze — and the exemption would then apply to a body the animator is drawing a jump on.
	 *
	 * Returns whether a duck started, so a rig's behaviour can stamp its own cooldown on the same answer
	 * a player's request gets.
	 */
	public requestDuck(model: Model): boolean {
		const entity = resolveDodgeable(model);
		const humanoid = entity?.humanoid;
		if (!entity || !humanoid || humanoid.Health <= 0) {
			// **Every refusal in this method prints, and this one is why.** It was silent, and silence is
			// the fault the rest of this codebase spends the most words on: a duck that did nothing for
			// this reason looked exactly like a key that was never pressed, and there was nothing anywhere
			// to tell them apart. See `DodgeService.blocksDodge` for the same rule stated from the other
			// side — *"a refusal that says how far past the action it happened turns 'not allowed' into a
			// measurement"*.
			warn(`[Duck] ${model.Name}: refused — no living humanoid`);
			return false;
		}

		const now = os.clock();

		if (this.ducks.has(model)) {
			if (DEBUG) print(`[Duck] ${model.Name}: refused — already ducking`);
			return false;
		}

		if (this.freezes.isFrozen(model)) {
			if (DEBUG) print(`[Duck] ${model.Name}: refused — frozen`);
			return false;
		}

		// **The dash first, because it is the action whose clock this one shares.** A duck during a dash
		// would be a body anchored part-way through a 15-stud move, which reads as a dodge that stopped;
		// refusing is also what makes "committed" true in the direction a player will try first.
		if (this.dodges.isDodging(model)) {
			if (DEBUG) print(`[Duck] ${model.Name}: refused — mid-dash`);
			return false;
		}

		if (this.catchState?.isCatching(model) === true) {
			if (DEBUG) print(`[Duck] ${model.Name}: refused — a catch window is open`);
			return false;
		}

		// **Both lockouts, asked the way every other action asks them.** A duck is a fourth asker of the
		// shared `ACTION_LOCKOUT_SECONDS` and, from the other side, a setter of it: the duck's own end
		// stamps `lastDuckEndAt`, which the dodge and the catch then read. See `actionLock`.
		//
		// **Both print their elapsed figure**, which is `DodgeService.blocksDodge`'s shape and its reason:
		// "not allowed" and "not allowed, 0.2 s after a dodge you just made" are different reports, and only
		// one of them is worth chasing.
		const sinceDodge = lockoutElapsed(this.dodges.getLastDodgeEndTime(model));
		if (sinceDodge !== undefined) {
			if (DEBUG) {
				print(
					`[Duck] ${model.Name}: refused — the dash ended ` +
						`${string.format("%.2f", sinceDodge)}s ago`,
				);
			}

			return false;
		}

		const sinceCatch = lockoutElapsed(this.catchState?.getLastCatchWindowCloseTime(model));
		if (sinceCatch !== undefined) {
			if (DEBUG) {
				print(
					`[Duck] ${model.Name}: refused — the catch window closed ` +
						`${string.format("%.2f", sinceCatch)}s ago`,
				);
			}

			return false;
		}

		const last = this.lastDuckAt.get(model);
		if (last !== undefined && now - last < DUCK_COOLDOWN_SECONDS) {
			if (DEBUG) print(`[Duck] ${model.Name}: refused — ${string.format("%.2f", DUCK_COOLDOWN_SECONDS - (now - last))}s of cooldown left`);
			return false;
		}

		// The ground, which is `FloorMaterial` rather than a state: a body in the air reports `Air`, and
		// every state where a body is standing reports what it is standing on.
		if (humanoid.FloorMaterial === Enum.Material.Air) {
			if (DEBUG) print(`[Duck] ${model.Name}: refused — not on the ground`);
			return false;
		}

		this.startDuck(model, entity.root, humanoid, now);

		return true;
	}

	/** Starts the duck: moves the parts, plants the body, and remembers what to put back. */
	private startDuck(model: Model, root: BasePart, humanoid: Humanoid, now: number): void {
		const previousGroups = setDuckGroup(duckExemptParts(model, humanoid), DUCK_GROUP);
		const rootWasAnchored = root.Anchored;

		// **The plant.** A contribution far below any sum plus an anchored root, which is `FreezeService`'s
		// pair and its reasoning: the speed is what stops the body choosing to walk, and the anchor is what
		// stops anything else moving it. Without the anchor a ducking body shoved by a ball or another
		// player slides out of the ball's path, which would make the duck a dodge with extra steps.
		this.speeds.addModifier(model, DUCK_SPEED_KEY, DUCK_SPEED);
		root.Anchored = true;

		model.SetAttribute(DUCKING_ATTRIBUTE, true);

		const run: DuckRun = {
			previousGroups,
			root,
			rootWasAnchored,
			endsAt: now + DUCK_DURATION_SECONDS,
		};

		this.ducks.set(model, run);
		this.lastDuckAt.set(model, now);

		publishReadyAt(model, DUCK_READY_AT, DUCK_DURATION_SECONDS + ACTION_CONFIG.ACTION_LOCKOUT_SECONDS);

		// **Both other actions' bars are pushed out too**, which is what `DodgeService` does to the catch
		// and `CatchService` to the dodge: the three share one lockout, so a readout that reported only
		// its own action would show a bar refilling while the pair was still shut.
		extendReadyAt(model, DODGE_READY_AT, DUCK_DURATION_SECONDS + ACTION_CONFIG.ACTION_LOCKOUT_SECONDS);
		extendReadyAt(model, CATCH_READY_AT, DUCK_DURATION_SECONDS + ACTION_CONFIG.ACTION_LOCKOUT_SECONDS);

		// **A death ends a duck, and this is the hook that catches it.** A body that dies mid-duck would
		// otherwise leave an anchored root on a corpse and an entry in the map for a model nobody will ask
		// about again — and, more visibly, a corpse held in the air where a fall would have put it.
		humanoid.Died.Once(() => this.stopDuck(model, "died"));

		task.delay(DUCK_DURATION_SECONDS, () => {
			// A newer duck owns the entry by now; its own timer is the one that ends it, so this leaves it
			// alone rather than cutting the newer stance short. Same guard `BallService`'s throw mark uses.
			if (this.ducks.get(model) !== run) return;

			this.stopDuck(model, "time");
		});

		if (DEBUG) {
			print(
				`[Duck] ${model.Name}: ducking for ${string.format("%.2f", DUCK_DURATION_SECONDS)}s ` +
					`(cooldown ${string.format("%.2f", DUCK_COOLDOWN_SECONDS)}s, ` +
					`${previousGroups.size()} part(s) out of the way)`,
			);
		}
	}

	/**
	 * Ends a duck: everything {@link startDuck} did, undone.
	 *
	 * **Idempotent and safe to call on a model this service has never seen**, because three different
	 * things call it — the timer, the death hook, and nothing else — and each has to be able to call it
	 * unconditionally rather than knowing whether a duck was ever up. That is `DodgeService.endDash`'s
	 * shape.
	 *
	 * **The group restore is the load-bearing half.** A part left in `DUCK_GROUP` after the duck would be
	 * a body that is permanently intangible to balls at the head and arms — the exemption would outlive
	 * the stance and the mechanic would be a permanent shield granted by one press.
	 */
	private stopDuck(model: Model, reason: string): void {
		const run = this.ducks.get(model);
		if (run === undefined) return;

		this.ducks.delete(model);

		for (const [part, group] of run.previousGroups) {
			if (part.Parent !== undefined) part.CollisionGroup = group;
		}

		run.root.Anchored = run.rootWasAnchored;

		this.speeds.removeModifier(model, DUCK_SPEED_KEY);

		model.SetAttribute(DUCKING_ATTRIBUTE, undefined);

		// **Stamped on every end, including a death**, because the lockout is what the other two actions
		// read and a body that died mid-duck should not be able to dash the instant it respawns. The model
		// is a different one after a respawn, so the stamp is about the body that ducked and no more.
		this.lastDuckEndAt.set(model, os.clock());

		if (DEBUG) print(`[Duck] ${model.Name}: duck over — ${reason}`);
	}
}
