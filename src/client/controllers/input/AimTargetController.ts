import { Controller, OnStart } from "@flamework/core";
import Fusion from "@rbxts/fusion-3.0";
import { Players, RunService } from "@rbxts/services";
import { AIM_CONFIG } from "shared/config/aim.config";
import { TEAM_ATTRIBUTE } from "shared/constants";
import { aiming, predictedTargets } from "../../aiming";
import { inRound } from "../../roundZone";

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

/** What `TEAM_ATTRIBUTE` holds for each side. Two literals between two files, spelled the same way. */
const SIDE_A = "A";
const SIDE_B = "B";

/** One side, as a client reads it off an attribute. See {@link sideOfBody}. */
type SideLabel = typeof SIDE_A | typeof SIDE_B;

/**
 * `label` as a side, or nothing — **the validation {@link sideOfBody} is a branch away from meaning nothing
 * without**.
 *
 * An attribute is a string anybody can write, so `Team = "Red"` is not a side, it is a string that happens to
 * be a colour. The same reading `npc/rigs.ts`'s `sideOfRig` and `roundZone.onASide` make on their own copies:
 * a value that is not one of the two labels reads as "no side", and every caller here treats that as "leave
 * it alone" rather than as a third side.
 */
function asSide(label: unknown): SideLabel | undefined {
	if (label === SIDE_A || label === SIDE_B) return label;

	return undefined;
}

/**
 * **Which side a body is on, read from wherever that side actually lives** — the client's copy of the rule the
 * server keeps in `npc/detect.ts` (`sideOf`) and `RoundService.teamOf`.
 *
 * **Two branches, because the attribute is written in two different places.** `RoundService.assignTeams` writes
 * `TEAM_ATTRIBUTE` on the **`Player`** — the roster is player-keyed and a character is replaced on every death —
 * while a **rig** carries its own, painted in Studio or written by the pad and the respawn. So a reader that
 * asked the model in both cases would read every player's character as side-less; under the equality test below
 * that is the same answer as "not a teammate", which is how a rule like this one goes quietly wrong.
 * `GetPlayerFromCharacter` is the branch that tells the two apart, and it is nullable by design: `undefined`
 * means "this model is not a player's character", and for this file that means a rig.
 *
 * **A `Model | Player` rather than a `Model`**, because the local player's own side is asked of the `Player`:
 * `Players.LocalPlayer` is the one body in the game the client can read directly, and it is a `Player` rather
 * than a character model — which also makes this answer survive a death, since a player with no character still
 * has a side.
 *
 * **A copy rather than a shared helper, and the reasons are worth naming.** The server's read lives beside
 * `TEAM_A`/`TEAM_B`/`TeamLabel`, which are in `server/services/round/team.ts` — a client cannot import that —
 * and `npc/rigs.ts`'s `sideOfRig` is a server module that walks `CollectionService`, which is far more than a
 * hint about a line colour should drag into the client. A new `shared/` module would have to carry its own copy
 * of the two labels anyway, so extracting this would move four lines and duplicate the same pair in a *third*
 * place — and it would touch `detect.ts` and `rigs.ts`, which this change has no other business in. If a fourth
 * reader ever appears, the change to make first is to move the labels themselves to `shared/`; this file is not
 * the place to half-make it. `client/roundZone.ts` records the same trade for its own two literals.
 */
function sideOfBody(body: Model | Player): SideLabel | undefined {
	if (body.IsA("Player")) return asSide(body.GetAttribute(TEAM_ATTRIBUTE));

	const player = Players.GetPlayerFromCharacter(body);
	const label = player !== undefined ? player.GetAttribute(TEAM_ATTRIBUTE) : body.GetAttribute(TEAM_ATTRIBUTE);

	return asSide(label);
}

/**
 * Whether two target lists name the same bodies in the same order.
 *
 * **By contents, because the list is a fresh table every frame** — see `client/aiming.ts`. Comparing
 * the tables themselves would report a change every frame and redo the work forever, and the work is
 * not free: it writes to instances.
 *
 * Order is part of the comparison rather than sorted away. Both sides are built by walking the same
 * flight in the same direction, so a difference in order is a difference in the arc.
 */
function sameTargets(a: Array<Model>, b: Array<Model>): boolean {
	if (a.size() !== b.size()) return false;

	for (let index = 0; index < a.size(); index++) {
		if (a[index] !== b[index]) return false;
	}

	return true;
}

/**
 * Fills every body this throw would reach with colour, for as long as the local player is aiming.
 *
 * **Every body, not only the one it stops on, because a Pierce ball reaches more than one.** For every
 * other throw those are the same thing — the arc ends on the first body it meets — so this reads as it
 * always did. A Pierce ball goes *through* the bodies in its line and stops on the world behind them,
 * so lighting only the first left every other body in the line unlit while naming a body the ball was
 * never going to stop on, and those bodies are the whole point of the ability. See {@link retarget}
 * for the trap that opens the moment more than one body is lit at once.
 *
 * **Client-side, and entirely an opinion.** Nothing here is sent anywhere and nothing is asked of
 * the server: it reads what the drawn arc would hit and changes one property on a highlight the
 * server already put there. Every client does the same thing with its own throw, so each player
 * sees their own aim and nobody else's — which is what makes it free.
 *
 * **It does not create a `Highlight`, and that is the load-bearing decision.** Roblox draws one
 * highlight per model; a second one is not two effects but an undefined choice between them, so a
 * glow of its own would fight the outline for the slot rather than sit inside it. Instead this
 * recolours the highlight the outline already gave it — the instance is already on every rig and
 * every ball, and all this does is change the colour its edge is drawn in.
 *
 * **The signal is the edge and not the fill, and that is a reversal.** The glow used to lay a white
 * fill over the whole body. The landing marker is drawn *on* that body, and it is the quiet, precise
 * end of the preview — so washing the body toward white left a grey disc sitting on near-white, and
 * the one thing the preview exists to tell you was the one thing it made hard to read. An edge is a
 * contour rather than a surface: it says "this one" while leaving every pixel the marker is read
 * against exactly as it was. Nothing here writes a fill at all any more, so a lit target's *surface*
 * is identical to an unlit one's.
 *
 * **The edge colour is the one piece of state this controller has to remember**, and it is worth
 * knowing why the fill did not need to. A fill restored to any value at all was invisible, so a
 * constant cost nothing — the old code said so in as many words. An edge colour *means* something:
 * it is how a body says whose side it is on, so putting back a constant would repaint somebody in the
 * wrong colour. See {@link setGlow} for the rule that keeps the restore honest.
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
 * The question is therefore "where does this throw go", and the answer was already being computed one
 * file away — `ThrowController`'s arc, rebuilt every frame from the same plan the server will run,
 * whose hit is the first thing the ball's own swept sphere meets and whose passed-through list is
 * every body a Pierce ball goes through instead. That answer arrives as `predictedTargets` rather than
 * being recomputed here, because recomputing it would mean rebuilding the plan: the arc mode, the
 * ignore list, the sweep radius and the ceiling. Four things that all have to match or the glow would
 * be describing a different throw from the one being drawn — and this controller has no business
 * knowing any of them.
 *
 * **What it lights is what the arc would reach *and could hurt*, and that is a reversal.** The
 * paragraph this replaces said the glow asked the world for a target and never for a team: a model
 * with a humanoid was a target, whatever it was, on the grounds that the moment the glow answered
 * "what may I throw at" it would be a second, quieter copy of the throw's rules. **The user's rule for
 * this feature is the opposite — a teammate should not be highlighted while you aim at them — and the
 * old argument had the friendly-fire rule wrong.** It is not a second set of rules beside the throw's,
 * it is the *same* rule seen from the aim side, and `RoundService.isFriendlyFire` is the one place it
 * is written: a body on your own side is a body this throw cannot hurt, so it is a body the hint must
 * not point at. A hint that pointed at it would be promising a hit the game refuses — the same
 * disagreement between the preview and the throw this controller exists to prevent, with the *rules*
 * rather than the arc as the thing that moved.
 *
 * **Client-side, and the reason is what a wrong outline costs.** It is cosmetic: it cannot deal
 * damage, cannot fake a hit, cannot move a body, and every client works out its own answer for its own
 * aim. The server owns the *fact*, and it already acts on it — `isFriendlyFire` refuses the throw
 * itself, before any damage — so a server-side version of this filter would enforce nothing the game
 * does not already enforce. What it would cost is a per-frame report of where every client is aiming,
 * so that the server could suppress a line. The hint is the client's opinion about what to draw; the
 * rule it follows is the server's. See {@link hittable}.
 *
 * **What is still asked of the world is the geometry.** The arc names the bodies in the throw's path
 * and nothing else, and the filter below only ever *removes* bodies from that list — so scenery, a body
 * with no side, the drawn path and the landing marker are exactly what they were.
 *
 * See `client/aiming.ts` for both halves of what it reads, and `ThrowController.updateGuide` for
 * where they are written.
 */
@Controller()
export class AimTargetController implements OnStart {
	private readonly player = Players.LocalPlayer;

	/**
	 * The models currently glowing, in the order the arc meets them. Empty when nothing is glowing.
	 *
	 * **A list, because a Pierce ball reaches more than one body.** Every other throw stops on the one
	 * body it reaches, so this holds at most one entry and reads as the single target it replaced. A
	 * Pierce throw passes *through* the bodies in its line, and the glow has to light all of them or it
	 * is describing a throw that stops where the ball will not.
	 *
	 * Held so that it can be put out again: a body that stops being a target has its colour restored,
	 * and the bodies that are still targets are left exactly as they are — never cleared and re-lit,
	 * for the reason {@link retarget} gives.
	 */
	private currentTargets: Array<Model> = [];

	/**
	 * The edge colour the glow replaced on each body currently lit, keyed by that body.
	 *
	 * **A table rather than one slot, because the glow can be on several bodies at once** — one entry
	 * per model in {@link currentTargets}, dropped in the same breath that body is put out.
	 *
	 * Held across frames rather than read at the moment of the restore, which is the whole point:
	 * by then the value on the instance is the glow's own, and what has to be put back is what was
	 * there before it. See {@link setGlow} for the case where something else has written the property
	 * in the meantime and this must *not* be put back.
	 */
	private readonly replacedOutline = new Map<Model, Color3>();

	/** The flag as last reported, so only its transitions are printed. Diagnostic scaffolding. */
	private lastAiming = false;

	/**
	 * The teammates the hint last declined to light, as one string, so only a *change* is printed.
	 *
	 * A field rather than a per-frame line, for the reason `lastAiming` is one: this runs on every frame
	 * the aim is up, and a line a frame buries the answer it is there to give. See {@link reportSkip}.
	 */
	private lastSkipReport = "";

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

	/** One turn of the loop: keep the glow on what the throw would reach, or put it out. */
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

		// **The whole of the input.** An empty list here is the ordinary answer rather than a failure:
		// it means the arc reaches no body, which is what a throw at a wall, a floor or the sky is. The
		// usual length is one, and more than one means the throw is going through the bodies in its
		// line rather than stopping on the first.
		//
		// **And the bodies this player's side cannot hurt are taken out of it**, which is the one place the
		// glow has an opinion about anything but the arc: a teammate is not a body the game will let the ball
		// land on. The phase, the thrower's side and the target's are all checked in there, and a body that
		// fails to name a side is left exactly as it was. See {@link hittable}.
		const targets = this.hittable(Fusion.peek(predictedTargets));

		// The common case, and the reason the glow does not flicker: a set of targets that has not
		// changed is left exactly as it is, so nothing is written to it and nothing is re-lit. It
		// covers "nothing, again" too, so a stretch of aiming at scenery writes nothing at all. The
		// comparison is by contents because the published list is a fresh table every frame — see
		// {@link sameTargets}.
		if (sameTargets(targets, this.currentTargets)) return;

		this.retarget(targets);

		this.currentTargets = targets;
	}

	/**
	 * Moves the glow from the bodies wearing it to the bodies in `targets`, one body at a time.
	 *
	 * **Bodies in both lists are left alone, and that is not tidiness.** Putting everything out and
	 * lighting the whole new list again would look equivalent and is not: lighting a body that is
	 * already lit remembers the *glow* colour as the colour to restore, so when the aim finally moves
	 * off it the edge is "restored" to the white it already wears — a body left outlined in the glow
	 * colour for the rest of the round, with nothing on screen to say why. With a single target that
	 * could not happen, because the old one was always put out before the new one went on; with a list
	 * it happens on any aim that adds or drops a body while holding another, which is every sweep
	 * across a crowd.
	 */
	private retarget(targets: Array<Model>): void {
		for (const model of this.currentTargets) {
			if (!targets.includes(model)) this.setGlow(model, false);
		}

		for (const model of targets) {
			if (!this.currentTargets.includes(model)) this.setGlow(model, true);
		}
	}

	/**
	 * `targets` without the bodies on the local player's own side — **the friendly-fire rule seen from the aim
	 * side, and the whole of what the glow knows about teams.**
	 *
	 * **A body on your own side is not something this throw can hurt, so it is not something the guide points
	 * at.** `RoundService.isFriendlyFire` refuses a same-side contact outright, before any damage, so a glow on
	 * a teammate is the hint promising a hit the game will not deliver. See this controller's class doc for the
	 * reading of that rule and for why the filter lives here rather than on the server.
	 *
	 * **Three preconditions, and each one is a case the rule must not claim.** A round has to be playing,
	 * because a side only means something in one — `isFriendlyFire` gates on the phase for exactly this reason,
	 * and `RoundService.assignTeams` leaves the last round's labels standing on every player through the
	 * intermission, so a check without the phase would read a lobby throw at a former teammate as friendly. The
	 * thrower has to *have* a side, because there is otherwise nobody to be friendly with. And the **target**
	 * has to have one: a body with no side — a lobby spectator, a rig nobody painted, a practice dummy — is
	 * highlighted exactly as it was, which is `isFriendlyFire`'s own answer about a side-less body. That is why
	 * the test is an equality of two valid labels rather than "is this body's side not mine".
	 *
	 * **The thrower's own body cannot be in the list to begin with.** `ThrowController` puts the local character
	 * in the arc's ignore list, so the guide can never reach it — and the equality test would answer it anyway,
	 * since this player is on their own side.
	 *
	 * **Nothing is remembered between frames but the report**, and the lists are rebuilt every frame anyway: the
	 * input is a fresh table a frame, so a filter that cached its answer would have to key it on the aim.
	 */
	private hittable(targets: Array<Model>): Array<Model> {
		// Outside a round nobody is on a side: `sideOfBody` would answer from a label that outlived its round —
		// see above, and `isFriendlyFire`'s own phase gate.
		const mine = inRound() ? sideOfBody(this.player) : undefined;
		if (mine === undefined) {
			this.reportSkip([]);

			return targets;
		}

		const hittable: Array<Model> = [];
		const skipped: Array<string> = [];

		for (const model of targets) {
			if (sideOfBody(model) === mine) {
				skipped.push(model.Name);
				continue;
			}

			hittable.push(model);
		}

		this.reportSkip(skipped);

		return hittable;
	}

	/**
	 * Prints the teammates the hint has just declined to light, when that set changes.
	 *
	 * **Because a glow that did not happen and an arc that hit nothing look identical from the outside**, which
	 * is the same fork {@link setGlow} prints for its missing-highlight case and the reason both lines exist:
	 * "aiming at my own side does nothing" and "my aim is broken" are one silence apart. Printed on the
	 * transition rather than per frame, since this is asked on every frame the aim is up.
	 *
	 * The empty report is passed in while nothing is being skipped, so the field is cleared — which is what lets
	 * the next skip print again rather than being suppressed as a repeat.
	 */
	private reportSkip(skipped: Array<string>): void {
		const report = skipped.size() === 0 ? "" : skipped.join(", ");
		if (report === this.lastSkipReport) return;

		this.lastSkipReport = report;
		if (!DEBUG) return;

		if (report === "") print(`[Aim] nothing skipped`);
		else print(`[Aim] skipped on own side: ${report}`);
	}

	/**
	 * Puts the glow out on everything currently lit.
	 *
	 * Safe to call at any time and as often as wanted — every frame, in fact, since that is how the
	 * aim being released is noticed. A call with nothing lit is a size check and nothing else.
	 */
	private clear(): void {
		if (this.currentTargets.size() === 0) return;

		for (const model of this.currentTargets) this.setGlow(model, false);

		this.currentTargets = [];
	}

	/**
	 * Lights `target`, or puts it out, by recolouring the edge of the highlight it already wears.
	 *
	 * **A missing highlight is a state, not an error.** A rig that has not been outlined yet, a ball
	 * that has just been made, a character in the middle of respawning — all of them are unlit, and
	 * the write below is skipped rather than faked. Nothing is created here, on purpose: this
	 * controller owns no instances at all, so there is nothing of its own to leak and nothing to
	 * clean up beyond the one property it writes. It is *reported*, though, and that is the one thing
	 * worth saying loudly: a skipped write and an arc that hit nothing look identical from outside
	 * this file, and they have completely different causes.
	 *
	 * **The old colour goes back only if it is still ours to put back.** That condition is the whole
	 * of the care this needs, and it is not hypothetical: `OutlineService` writes this same property
	 * from the server whenever somebody's side changes — a round starting, a Dodge and Seek conversion
	 * — so an aim that is being held while that happens is a lit target whose edge the server has
	 * already taken back. If the edge is still the glow colour then nothing else has written it and
	 * the remembered value is the truth; if it is not, somebody with better information has already
	 * decided what that player is, and this leaves their answer alone. An unconditional restore would
	 * put a stale side colour onto a player who had been converted mid-aim, and would keep it there
	 * until the next phase change — a quietly wrong state of exactly the kind that a client writing
	 * and then un-writing a replicated property can produce.
	 *
	 * **The fill is not touched at all**, which is the point of the change rather than an omission:
	 * `OutlineService` leaves it at transparency `1` and nothing here paints it, so the surface the
	 * landing marker is read against is the body's own.
	 */
	private setGlow(target: Model, on: boolean): void {
		// **The remembered colour is taken out first, so the early return below cannot strand it.** A body
		// that was destroyed while it was lit — an NPC rig removed mid-round, a character respawning —
		// has no highlight left to write to, and the write below is skipped for it. Taking the entry out
		// here keeps its lifetime exactly "while this body is lit", rather than one entry per body that
		// died while somebody was aiming at it for the rest of the session.
		const replaced = this.replacedOutline.get(target);
		this.replacedOutline.delete(target);

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
			this.replacedOutline.set(target, highlight.OutlineColor);
			highlight.OutlineColor = AIM_CONFIG.TARGET_GLOW_COLOR;
		} else if (highlight.OutlineColor === AIM_CONFIG.TARGET_GLOW_COLOR) {
			// Still ours, so nothing has repainted it while the aim was held — see the note above.
			// No remembered colour would mean this body was never lit by this controller, in which case
			// there is nothing to put back and the colour already on the instance belongs there.
			highlight.OutlineColor = replaced ?? highlight.OutlineColor;
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
