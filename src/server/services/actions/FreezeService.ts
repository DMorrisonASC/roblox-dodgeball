import { Service } from "@flamework/core";
import { Workspace } from "@rbxts/services";
import { SUPER_CONFIG } from "shared/config/super.config";
import { WalkSpeedService } from "../character/WalkSpeedService";
import { overrideOutlineColour } from "../visual/OutlineService";

/** Prints every freeze and every release, with what the body was doing before. */
const DEBUG = true;

/**
 * The named contribution a freeze makes to a body's walk speed.
 *
 * A key rather than a write, because `WalkSpeedService` is the only owner of that number — the sprint
 * adds its own contribution to the same sum, and a direct `Humanoid.WalkSpeed = 0` here would be a
 * second owner of a figure the sprint is already moving. See that service's doc for the sum.
 */
const FROZEN_SPEED_KEY = "Frozen";

/**
 * What that contribution is worth, in studs per second.
 *
 * **A large negative number rather than `0`, and the reason is the sum.** A body's walk speed is its
 * base plus everything added to it — `Base: 20, Sprint: 15 -> 35` — so a contribution of zero would
 * leave somebody mid-sprint sprinting while frozen. This is far below any total the game can produce,
 * and `WalkSpeedService` clamps the sum at zero, so the result is exactly "cannot walk" without this
 * file having to know what the base is or what else happens to be on the body.
 */
const FROZEN_SPEED = -1000;

/**
 * What this service remembers about one frozen body, so that the release can undo exactly what the
 * freeze did.
 *
 * **The two recorded facts are the ones that cannot be read back at release time.** A body is not
 * "unanchored" when the freeze ends — it is returned to what it was, and a root that was already
 * anchored for some other reason (a builder's rig, a script's platform) must stay anchored. The same
 * goes for the jump state, which has a getter but only tells the truth *before* this service touches
 * it.
 */
interface FrozenBody {
	/** The root that was anchored, kept so the release does not have to find it again. */
	root: BasePart;
	/** What `root.Anchored` was before this service set it. */
	rootWasAnchored: boolean;
	/** Whether the humanoid was allowed to enter the jumping state before this service said no. */
	jumpingWasEnabled: boolean;
	/**
	 * The colour the body's outline was wearing, or nothing if it had no outline to repaint.
	 *
	 * **The third thing that cannot be read back at release time, for the same reason as the other two:**
	 * by then the outline is blue because *this* service is what made it blue, so a release that read the
	 * body instead of this would leave a team-coloured character wearing the freeze's colour for good.
	 * See `OutlineService.overrideOutlineColour`, which is the read-and-write this records.
	 */
	outlineColour: Color3 | undefined;
}

/**
 * Holds bodies exactly where they are for a few seconds: the third super ability's effect, and the
 * only mechanic in this game that stops somebody moving.
 *
 * **Keyed on the `Model`, which is what makes it work for a rig as well as a player.** This is not a
 * preference; it is the arrangement two services already reached for the same reason — `BallService`
 * keeps hands by model ("a catcher can be an NPC… the only thing that genuinely needs a `Player` is the
 * throw remote's handler") and `WalkSpeedService` keeps speeds by model ("so a `Player` and an NPC rig
 * go through the same path and neither needs a lookup table of its own"). A freeze is a fact about a
 * *body*, and a body is a model with a humanoid in it — that is the whole definition, and it is the
 * same definition `BallComponent` uses to decide a contact was a body. A second map keyed on `Player`
 * would be a second answer to "who is frozen", free to disagree with the first.
 *
 * **A freeze is an anchored root, and that is the mechanism.** `WalkSpeed = 0` cannot hold a falling
 * body: it governs the humanoid's own mover, which only ever pushes along the ground, and gravity is
 * the physics solver's business rather than the humanoid's. So the three parts of a freeze are a
 * walk-speed contribution of nothing (through {@link WalkSpeedService}), the jumping state disabled,
 * and **the root part anchored** — and it is the anchor that does the work, because an anchored
 * assembly is not simulated at all. It cannot walk, cannot be pushed, cannot fall, and it keeps the
 * pose it was in, which is exactly "held mid-air, not ragdolled". It is also the cheapest thing to
 * undo: one property, back to what it was.
 *
 * **The fourth part is the only one that is presentation: the body's own outline, recoloured.** A blue
 * edge is what says "this body is not moving *because of something*" rather than "this body has
 * stopped", and it is written onto the `Highlight` the body already wears rather than by adding one —
 * the engine draws one outline per model and its choice between two is undefined. See
 * `OutlineService.overrideOutlineColour` for the write, and {@link unfreeze} for the restore.
 *
 * **`PlatformStand` is deliberately not used**, and it fails both halves of the requirement rather
 * than being merely unfashionable: a humanoid in `PlatformStanding` still falls (the state stops its
 * mover, not gravity) and it goes limp, which is a ragdoll.
 *
 * **Every freeze has a clock, and that is the only thing that removes a body from the map.** A body
 * whose owner disconnects, whose rig is respawned, or whose humanoid dies before the timer fires leaves
 * an entry that the timer still clears — `unfreeze` is written to be safe for a body that is already
 * gone. So there is no path by which an entry can outlive the duration it was given.
 */
@Service()
export class FreezeService {
	/** Every body currently held, and what it will take to let it go. */
	private readonly frozen = new Map<Model, FrozenBody>();

	constructor(private readonly speeds: WalkSpeedService) {}

	/** Whether `model` is frozen right now. The question every action asks before acting. */
	public isFrozen(model: Model): boolean {
		return this.frozen.has(model);
	}

	/**
	 * Holds `model` in place for `seconds`, and answers whether it took hold.
	 *
	 * **A second freeze on a body that is already held moves the clock and nothing else.** The
	 * mechanism is applied idempotently — one contribution under one key, one anchored root, the
	 * jumping state already off — but what the *first* freeze recorded about the body is what the
	 * release has to restore, which is why the previous entry is read rather than the body. Reading the
	 * body would record "this root was anchored", because this service is the thing that anchored it,
	 * and the release would leave somebody hanging in the air.
	 *
	 * Returns `false` for a model with no living humanoid, for `WalkSpeedService.addModifier`'s reason:
	 * there is nowhere for a freeze to go, so nothing is stored either — and `freezeInRadius` uses that
	 * answer rather than filtering twice.
	 */
	public freeze(model: Model, seconds: number): boolean {
		const humanoid = model.FindFirstChildWhichIsA("Humanoid");
		const root = humanoid?.RootPart;
		if (!humanoid || !root || humanoid.Health <= 0) return false;

		const previous = this.frozen.get(model);

		// **Read before anything is applied**, because anchoring the root is what is being recorded. The
		// same rule covers the outline below: a body that is already blue must not record blue as "what it
		// was", or its release would leave a team-coloured character wearing the freeze's colour for good.
		// `previous` short-circuits the whole of that line, including the write, which is right — a body
		// already frozen is already wearing the colour it would be painted.
		const rootWasAnchored = previous ? previous.rootWasAnchored : root.Anchored;
		const jumpingWasEnabled = previous
			? previous.jumpingWasEnabled
			: humanoid.GetStateEnabled(Enum.HumanoidStateType.Jumping);
		const outlineColour = previous
			? previous.outlineColour
			: overrideOutlineColour(model, SUPER_CONFIG.FREEZE_OUTLINE_COLOR);

		this.speeds.addModifier(model, FROZEN_SPEED_KEY, FROZEN_SPEED);
		humanoid.SetStateEnabled(Enum.HumanoidStateType.Jumping, false);
		// And the jump that was already in flight is dropped, so a body frozen on the way up does not
		// finish the jump the instant it thaws. The state being disabled is what stops a *new* one.
		humanoid.Jump = false;
		root.Anchored = true;

		// **A fresh entry rather than a mutated one, so a timer can tell whether it is still the freeze
		// it was scheduled for.** A later splash replaces this object, and the earlier timer then finds
		// somebody else's entry here and leaves the body alone — which is what stops the first splash of
		// two cutting the second one short.
		const entry: FrozenBody = { root, rootWasAnchored, jumpingWasEnabled, outlineColour };
		this.frozen.set(model, entry);

		if (previous) {
			if (DEBUG) print(`[Freeze] ${model.Name}: still frozen — the clock restarted`);
		} else {
			// **One watcher per body, and both are the rule rather than a tidy-up.** A freeze is defined
			// to clear when its body dies, and a body that leaves the world cannot be thawed by anything —
			// so both are the same call, and neither fires twice for one freeze because they are connected
			// once. Connections on an instance die with it, so there is nothing to disconnect.
			humanoid.Died.Connect(() => this.unfreeze(model));
			model.Destroying.Connect(() => this.unfreeze(model));

			if (DEBUG) print(`[Freeze] ${model.Name}: frozen for ${string.format("%.2f", seconds)}s`);
		}

		task.delay(seconds, () => {
			// Superseded by a later freeze: that one owns the release now, and its own timer will do it.
			if (this.frozen.get(model) !== entry) return;

			this.unfreeze(model);
		});

		return true;
	}

	/**
	 * Lets `model` go: the anchor, the outline, the jump state and the walk speed.
	 *
	 * **Safe to call for a body that is already gone, which is why three things call it** — the clock, a
	 * death, and the body being destroyed. A model that has left the world has nothing left to reverse:
	 * there is no root to unanchor and no humanoid to un-silence. The row is dropped either way, and
	 * that is the half that matters, because it is what keeps the map from growing.
	 *
	 * **The contribution is removed first and unconditionally**, because it is the one thing this
	 * service wrote into somebody else's map: `removeModifier` is a documented no-op for a body that has
	 * already been forgotten, and skipping it would be the one way this file could leave a trace behind.
	 */
	public unfreeze(model: Model): void {
		const entry = this.frozen.get(model);
		if (!entry) return;

		this.frozen.delete(model);
		this.speeds.removeModifier(model, FROZEN_SPEED_KEY);

		if (model.Parent === undefined) return;

		entry.root.Anchored = entry.rootWasAnchored;

		// **The outline is the third thing put back, and a missing one is deliberately not an error.** A
		// body with no `Highlight` has nothing to restore, which is what the `undefined` recorded at the
		// freeze means — `OutlineService.overrideOutlineColour` creates nothing to make a restore
		// possible, because a second `Highlight` on a model is an undefined choice between two outlines
		// rather than two effects. In practice every rig and every character is dressed the moment it
		// arrives, so there is almost always a colour here.
		if (entry.outlineColour !== undefined) overrideOutlineColour(model, entry.outlineColour);

		const humanoid = model.FindFirstChildWhichIsA("Humanoid");
		if (humanoid) humanoid.SetStateEnabled(Enum.HumanoidStateType.Jumping, entry.jumpingWasEnabled);

		if (DEBUG) print(`[Freeze] ${model.Name}: released`);
	}

	/**
	 * Releases every frozen body. Called when a round ends.
	 *
	 * **Everything, rather than the round's participants**, for the reason the MultiBall window is
	 * cleared the same way: a freeze is a fact about a body, and a body that is frozen when the round
	 * ends is frozen whether or not it was playing in it. A round boundary is the one moment in the game
	 * where "everybody" is the right answer, because it is the one moment when nothing carries over.
	 */
	public unfreezeAll(): void {
		// Snapshotted, because `unfreeze` deletes from the map this is walking.
		const models: Array<Model> = [];
		this.frozen.forEach((_entry, model) => models.push(model));

		for (const model of models) this.unfreeze(model);
	}

	/**
	 * Freezes every body within `radius` of `origin`, except the ones `isExcluded` answers for, and
	 * answers with the bodies it took hold of.
	 *
	 * **The exclusion is the caller's, and that is a decision rather than a layering accident.** What
	 * must not freeze is "the thrower and their own side", and half of that rule belongs to the round —
	 * `RoundService.isFriendlyFire` is the single statement of who is on whose side, and this service
	 * cannot borrow it: the round already depends on *this* one, because it clears freezes when it ends.
	 * So the caller, which holds the thrower's token and the round's answer both, passes the test in, and
	 * this method is left with the part that is only about bodies.
	 *
	 * **A radius is a sphere of *parts*.** `GetPartBoundsInRadius` answers with every part whose bounds
	 * overlap the sphere — every limb of every body, and every wall, prop and loose ball besides — so
	 * this walks each of them back to the model it belongs to, keeps the ones that are bodies, and
	 * freezes each once. The test for "is this a body" is the one `BallComponent` makes of a single
	 * contact: a model with a `Humanoid` in it. (A thrown ball is a bare part in `Workspace` with no
	 * model above it, so it falls out here without a rule of its own.)
	 *
	 * **Nothing is passed to the query as a filter**, which is worth saying because the alternative
	 * looks tidier: an `Include` list would have to be the bodies inside the radius, which is the list
	 * this method exists to work out.
	 */
	public freezeInRadius(
		origin: Vector3,
		radius: number,
		isExcluded: (model: Model) => boolean,
	): Array<Model> {
		const caught: Array<Model> = [];
		const seen = new Set<Model>();

		for (const part of Workspace.GetPartBoundsInRadius(origin, radius)) {
			const model = part.FindFirstAncestorWhichIsA("Model");
			if (!model || seen.has(model)) continue;

			// Marked seen before the tests, so a body is examined once however many of its parts are in
			// the sphere — a torso, two arms and a head are four answers to one question.
			seen.add(model);

			if (isExcluded(model)) continue;
			if (!model.FindFirstChildWhichIsA("Humanoid")) continue;

			if (this.freeze(model, SUPER_CONFIG.FREEZE_DURATION_SECONDS)) caught.push(model);
		}

		if (DEBUG && caught.size() > 0) {
			print(`[Freeze] splash at ${origin} — caught ${caught.size()} bod(ies)`);
		}

		return caught;
	}
}
