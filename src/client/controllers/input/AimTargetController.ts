import { Controller, OnStart } from "@flamework/core";
import Fusion from "@rbxts/fusion-3.0";
import { Players, RunService, UserInputService, Workspace } from "@rbxts/services";
import { AIM_CONFIG } from "shared/config/aim.config";
import { aiming } from "../../aiming";

/** Prints a line as a target is lit and as it goes out. Silent while a target stays the same. */
const DEBUG = true;

/**
 * What the outline is called, and the whole of how one is found.
 *
 * **Must match `OUTLINE_NAME` in `OutlineService`**, which is the source of truth: the name is what
 * makes that service idempotent, and it is private to it, so this is a copy rather than a shared
 * constant — exactly as the `"Ball"` tag is copied in `BallFactory`, `BallService` and
 * `BallPickupService`, which are the other files that have to agree on a name they cannot import.
 *
 * Note it is `ObjectOutline` and not `CharacterOutline`: the same highlight adorns the balls, and
 * the name says what it is rather than what it most often sits on.
 */
const OUTLINE_NAME = "ObjectOutline";

/**
 * What a target's fill goes back to when the glow comes off — and it does not matter what this is.
 *
 * The fill is set back to invisible in the same breath, so this colour is never seen. It is a
 * definite value rather than a remembered one because nothing here should have to hold a second
 * piece of state to restore a property whose only visible value is transparency `1`.
 */
const RESTORE_FILL_COLOR = Color3.fromRGB(255, 255, 255);

/** The transparency a fill is at when it is not being used. See {@link RESTORE_FILL_COLOR}. */
const RESTORE_FILL_TRANSPARENCY = 1;

/** How long between crosshair rays, in seconds. See {@link AIM_CONFIG.TARGET_UPDATE_HZ}. */
const CAST_INTERVAL = 1 / AIM_CONFIG.TARGET_UPDATE_HZ;

/**
 * Fills the model under the crosshair with colour, for as long as the local player is aiming.
 *
 * **Client-side, and entirely an opinion.** Nothing here is sent anywhere and nothing is asked of
 * the server: it reads the camera, finds what the crosshair is on, and changes one property on a
 * highlight the server already put there. Every client does the same thing with its own camera, so
 * each player sees their own aim and nobody else's — which is what makes it free.
 *
 * **It does not create a `Highlight`, and that is the load-bearing decision.** Roblox draws one
 * highlight per model; a second one is not two effects but an undefined choice between them, so a
 * glow of its own would fight the outline for the slot rather than sit inside it. Instead this
 * fills the outline's own highlight in — `OutlineService` leaves the fill at transparency `1`, so
 * the outline is an empty shape waiting to be filled, and filling it is the whole of the glow. The
 * black edge is untouched and stays exactly what it was.
 *
 * **What it is aimed at is asked of the world, not of the game.** A model with a humanoid is a
 * target, whatever it is: no team, no health, no tag, nothing about whether hitting it means
 * anything. The glow answers "what is the crosshair on", and the moment it started answering
 * "what may I throw at" it would be a second, quieter copy of the throw's rules.
 *
 * See `client/aiming.ts` for how it knows whether the player is aiming.
 */
@Controller()
export class AimTargetController implements OnStart {
	private readonly player = Players.LocalPlayer;

	/**
	 * The model currently glowing, if any.
	 *
	 * One at a time, held so it can be put out again: the previous target is restored *before* the
	 * new one is lit, so there is never a frame with two models glowing and never one left lit
	 * because the aim moved off it. `undefined` means nothing is glowing.
	 */
	private currentTarget: Model | undefined;

	/** The next `os.clock` second at which the crosshair ray may be cast again. */
	private nextCastAt = 0;

	/** The flag as last reported, so only its transitions are printed. Diagnostic scaffolding. */
	private lastAiming = false;

	/** The last ray-and-target report, so only a change at either end of it is printed. */
	private lastRayReport = "";

	public onStart(): void {
		// Per frame, and the ray inside it is what gets throttled. The order matters: whether the
		// player is aiming is a table read, so it is asked *before* the throttle — which is what
		// makes releasing the aim put the glow out on the frame it happens, rather than up to
		// `CAST_INTERVAL` later. See `AIM_CONFIG.TARGET_UPDATE_HZ`.
		RunService.Heartbeat.Connect(() => this.update());

		// **A death is the one case the aiming flag cannot cover on its own.** A character that has
		// just been killed keeps both its hand and the ball in it for a beat, so the guide stays up,
		// the flag stays true, and the body would sit there lit until it was taken out of the world
		// — and it can be a while. The flag is still the right signal for everything else; this is
		// the one moment where "the same window as the guide" is not quite the window wanted.
		this.player.CharacterAdded.Connect((character) => this.watchDeath(character));

		const character = this.player.Character;
		if (character) this.watchDeath(character);

		// The line that says this controller ran at all, for the same reason the catch prints its
		// bind and the HUDs print that they are up: "nothing happens" has two completely different
		// causes — this never started, or it started and found nothing to do — and this is the line
		// that tells them apart. If it is missing from the output, nothing below it can be trusted.
		if (DEBUG) print(`[Aim] up — watching the aiming flag`);
	}

	/** One turn of the loop: keep the glow on what the crosshair is on, or put it out. */
	private update(): void {
		const isAiming = Fusion.peek(aiming);

		// Printed on the transition rather than per frame: this is the first question asked of a glow
		// that does nothing, and a line a frame would bury the answer. `flag: false` and never `true`
		// means the guide is never up — an empty hand, most often, since a round starting now destroys
		// held balls.
		if (isAiming !== this.lastAiming) {
			this.lastAiming = isAiming;
			if (DEBUG) print(`[Aim] flag: ${isAiming}`);
		}

		if (!isAiming) {
			this.clear();
			return;
		}

		const now = os.clock();
		if (now < this.nextCastAt) return;

		this.nextCastAt = now + CAST_INTERVAL;

		const target = this.targetUnderCrosshair();

		// The common case, and the reason the glow does not flicker: a target that has not changed
		// is left exactly as it is, so nothing is written to it and nothing is re-lit.
		if (target === this.currentTarget) return;

		// Out with the old before the new goes on, so the two can never both be lit.
		this.clear();
		if (target) this.setGlow(target, true);

		this.currentTarget = target;
	}

	/**
	 * Puts the glow out on whatever is currently lit.
	 *
	 * Safe to call at any time and as often as wanted — every frame, in fact, since that is how the
	 * aim being released is noticed. A call with nothing lit is a nil comparison and nothing else.
	 */
	private clear(): void {
		const target = this.currentTarget;
		if (!target) return;

		this.setGlow(target, false);
		this.currentTarget = undefined;
	}

	/**
	 * Turns `target`'s fill on or off, in the highlight the outline already gave it.
	 *
	 * **A missing highlight is a state, not an error.** A rig that has not been outlined yet, a ball
	 * that has just been made, a character in the middle of respawning — all of them are unlit, and
	 * the write below is skipped rather than faked. Nothing is created here, on purpose: this
	 * controller owns no instances at all, so there is nothing of its own to leak and nothing to
	 * clean up beyond the one property it writes. It is *reported*, though, and that is the one thing
	 * worth saying loudly: a skipped write and a ray that hit nothing look identical from outside
	 * this file, and they have completely different causes.
	 *
	 * Both properties are written together in each direction, which is what keeps the glow a single
	 * state rather than two that can disagree: a fill that was invisible but the wrong colour is a
	 * glow waiting to appear the next time something set one of them.
	 */
	private setGlow(target: Model, on: boolean): void {
		const highlight = target.FindFirstChild(OUTLINE_NAME);
		if (!highlight || !highlight.IsA("Highlight")) {
			// **The case that used to be silent, and so the case that used to be indistinguishable
			// from "the ray never hit anything".** The write is skipped and there is nothing to see,
			// so this line is the whole of the diagnosis for a glow that does nothing on a model
			// sitting under the crosshair.
			if (DEBUG) print(`[Aim] ${target.Name}: ${on ? "lit" : "out"}=false — no ${OUTLINE_NAME} to write`);
			return;
		}

		if (on) {
			highlight.FillColor = AIM_CONFIG.TARGET_GLOW_COLOR;
			highlight.FillTransparency = AIM_CONFIG.TARGET_FILL_TRANSPARENCY;
		} else {
			highlight.FillColor = RESTORE_FILL_COLOR;
			highlight.FillTransparency = RESTORE_FILL_TRANSPARENCY;
		}

		// `=true` is the load-bearing half: it says the write reached a real `Highlight`. A `true`
		// here with nothing on screen is therefore a *rendering* question and not a logic one, and
		// that is the fork this whole line exists to expose.
		if (DEBUG) print(`[Aim] ${target.Name}: ${on ? "lit" : "out"}=true`);
	}

	/**
	 * The model the crosshair is on, or nothing.
	 *
	 * **The same ray the aim guide casts, through the same point — and that is the whole of this
	 * method's honesty.** The guide aims from the **mouse**, not from the middle of the screen: see
	 * `ThrowController.getAimTarget`, which is `ViewportPointToRay` at
	 * `UserInputService.GetMouseLocation()`. A ray down the camera's `LookVector` is therefore a
	 * completely different line, and one that lights whatever happens to be in the centre of the
	 * screen rather than what the player is pointing at. The glow exists to answer "what is my aim
	 * on", so it has to be cast along the line the throw actually uses.
	 *
	 * **The guide's own parts are not filtered out, and do not need to be.** They sit along the arc
	 * and would otherwise be exactly what a ray down the aim line hits first — but `AimGuide` sets
	 * `CanQuery = false` on them, which takes them out of every raycast in the game rather than out
	 * of this one. See `AimGuide`.
	 *
	 * A hit that is not part of a humanoid model is not a target, and that is the whole rule: a ball
	 * on the floor, a tree, a wall, the sky. A ball *held* by somebody resolves to their model and
	 * lights them, which is right — it is their model, hanging where their body is.
	 */
	private targetUnderCrosshair(): Model | undefined {
		const camera = Workspace.CurrentCamera;
		if (!camera) return undefined;

		// From the pointer, not from the screen's centre. See the note above: these are two
		// different lines and only one of them is where the throw is aimed.
		const mouse = UserInputService.GetMouseLocation();
		const ray = camera.ViewportPointToRay(mouse.X, mouse.Y);

		const params = new RaycastParams();
		params.FilterType = Enum.RaycastFilterType.Exclude;
		// The local player's own body, so the crosshair can never land on the thrower: a ray that
		// starts inside a character and is not told to ignore it hits that character every time.
		params.FilterDescendantsInstances = this.player.Character ? [this.player.Character] : [];
		params.IgnoreWater = true;

		const result = Workspace.Raycast(ray.Origin, ray.Direction.mul(AIM_CONFIG.TARGET_MAX_DISTANCE), params);

		// The nearest *model* the hit is inside, then a humanoid in it. Both halves are needed: the
		// first is what says "this is a body rather than scenery", and the second is what says the
		// body is a character rather than a prop that happens to be assembled as a model.
		const model = result?.Instance.FindFirstAncestorWhichIsA("Model");
		if (!model || !model.FindFirstChildWhichIsA("Humanoid")) {
			this.reportRay(result, undefined);
			return undefined;
		}

		this.reportRay(result, model);

		return model;
	}

	/**
	 * Prints what the ray hit and what that came to, when either end of it changes.
	 *
	 * **Both halves in one line, because they fail differently.** A ray that hit nothing and a ray
	 * that hit a wall report the same target — none — and mean completely different things: the first
	 * is an aim or a filter problem, the second is geometry in the way. Printed on change rather than
	 * per cast only because a cast is fifteen a second and a steady aim is not.
	 *
	 * Diagnostic scaffolding. Delete once the glow is trusted.
	 */
	private reportRay(result: RaycastResult | undefined, target: Model | undefined): void {
		const hit = result ? `${result.Instance.GetFullName()} at ${math.floor(result.Distance)} studs` : "nil";
		const report = `${hit} -> ${target ? target.Name : "nil"}`;
		if (report === this.lastRayReport) return;

		this.lastRayReport = report;
		if (DEBUG) print(`[Aim] ray: ${report}`);
	}

	/** Puts the glow out when `character` dies — see {@link onStart} for why this is hooked. */
	private watchDeath(character: Model): void {
		const humanoid = character.FindFirstChildWhichIsA("Humanoid");
		if (!humanoid) return;

		humanoid.Died.Connect(() => this.clear());
	}
}
