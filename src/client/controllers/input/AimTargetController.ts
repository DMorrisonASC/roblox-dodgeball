import { Controller, OnStart } from "@flamework/core";
import Fusion from "@rbxts/fusion-3.0";
import { Players, RunService } from "@rbxts/services";
import { AIM_CONFIG } from "shared/config/aim.config";
import { aiming, predictedTarget } from "../../aiming";

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

/**
 * Fills the model this throw would land on with colour, for as long as the local player is aiming.
 *
 * **Client-side, and entirely an opinion.** Nothing here is sent anywhere and nothing is asked of
 * the server: it reads what the drawn arc would hit and changes one property on a highlight the
 * server already put there. Every client does the same thing with its own throw, so each player
 * sees their own aim and nobody else's — which is what makes it free.
 *
 * **It does not create a `Highlight`, and that is the load-bearing decision.** Roblox draws one
 * highlight per model; a second one is not two effects but an undefined choice between them, so a
 * glow of its own would fight the outline for the slot rather than sit inside it. Instead this
 * fills the outline's own highlight in — `OutlineService` leaves the fill at transparency `1`, so
 * the outline is an empty shape waiting to be filled, and filling it is the whole of the glow. The
 * black edge is untouched and stays exactly what it was.
 *
 * **What lights up is what the arc would hit, and that is a reversal.** This used to cast its own
 * ray from the camera through the mouse and light whatever the crosshair was on. That is a straight
 * line from the eye; a throw is a ballistic arc from the muzzle. The two agree about the aim point
 * and disagree about everything between it and the hand, so **a tree standing on the arc but not on
 * the ray left a model glowing while the ball was certain to hit the tree** — the preview promising
 * a throw that could not happen. Worse, it was the only part of the preview that was doing that: the
 * landing marker has always been drawn from the arc, so a blocked throw put the *marker* on the
 * trunk and the *glow* on the body behind it, and the two disagreed in plain sight.
 *
 * The question is therefore "where does this throw land", and the answer was already being computed
 * one file away — `ThrowController`'s arc, rebuilt every frame from the same plan the server will
 * run, whose `hit` is the first thing the ball's own swept sphere meets. That answer arrives as
 * `predictedTarget` rather than being recomputed here, because recomputing it would mean rebuilding
 * the plan: the arc mode, the ignore list, the sweep radius and the ceiling. Four things that all
 * have to match or the glow would be describing a different throw from the one being drawn — and
 * this controller has no business knowing any of them.
 *
 * **What it is aimed at is still asked of the world, not of the game.** A model with a humanoid is a
 * target, whatever it is: no team, no health, no tag, nothing about whether hitting it means
 * anything. The glow answers "where is this throw going", and the moment it started answering "what
 * may I throw at" it would be a second, quieter copy of the throw's rules. The *arc* is the throw's
 * geometry, which is exactly why it is the right input and the wrong place for any judgement to sit.
 *
 * See `client/aiming.ts` for both halves of what it reads, and `ThrowController.updateGuide` for
 * where they are written.
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

	/** The flag as last reported, so only its transitions are printed. Diagnostic scaffolding. */
	private lastAiming = false;

	public onStart(): void {
		// Per frame, and nothing is throttled any more. The arc this reads is rebuilt every frame
		// whether or not anybody is looking at it, so reading the answer is a table lookup and the
		// glow is exactly as fresh as the guide that drew it. It used to cast its own ray on an
		// `AIM_CONFIG.TARGET_UPDATE_HZ` clock, because a raycast a frame was not worth a cosmetic —
		// that clock, and the ray, are gone with the ray's last reader.
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

	/** One turn of the loop: keep the glow on what the throw would hit, or put it out. */
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

		// This is still asked first, and no longer for the throttle's sake: the flag is this
		// controller's own question, and asking it before the answer is what puts the glow out on the
		// frame the aim is released.
		if (!isAiming) {
			this.clear();
			return;
		}

		// **The whole of the input.** `undefined` here is the ordinary answer rather than a failure:
		// it means the arc reaches no body, which is what a throw at a wall, a floor or the sky is.
		const target = Fusion.peek(predictedTarget);

		// The common case, and the reason the glow does not flicker: a target that has not changed
		// is left exactly as it is, so nothing is written to it and nothing is re-lit. It covers
		// `undefined === undefined` too, so a stretch of aiming at scenery writes nothing at all.
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
	 * worth saying loudly: a skipped write and an arc that hit nothing look identical from outside
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
			// from "the arc never hit anything".** The write is skipped and there is nothing to see,
			// so this line is the whole of the diagnosis for a glow that does nothing on a model the
			// throw is heading straight for.
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

	/** Puts the glow out when `character` dies — see {@link onStart} for why this is hooked. */
	private watchDeath(character: Model): void {
		const humanoid = character.FindFirstChildWhichIsA("Humanoid");
		if (!humanoid) return;

		humanoid.Died.Connect(() => this.clear());
	}
}
