import { Controller, OnStart } from "@flamework/core";
import Net from "@rbxts/net";
import { ContextActionService, Players } from "@rbxts/services";
import { DUCKING_ATTRIBUTE } from "shared/constants";
import { events } from "shared/networking";
import { logDebug } from "shared/logger";

/**
 * The action name the duck is bound under.
 *
 * A name rather than the key, because `ContextActionService` identifies a binding by this string and
 * nothing else — an unbind for a test or a menu takes the same name. Spelled once, here, for the reason
 * `ThrowController`'s `ACTION_NAME` is.
 */
const ACTION_NAME = "DuckDodgeball";

/** The client half of the duck remote, as the declarations build it. */
type ClientRemotes = Net.Util.GetClientRemotes<Net.Util.GetDeclarationDefinitions<typeof events>>;

/**
 * `Z` starts a duck. **The client asks; the server decides everything else.**
 *
 * **Why this file holds no state at all.** A duck has a duration, a cooldown and a set of things it
 * refuses, and not one of them is here — this class owns one key and one fire, and it does not know
 * whether its request was granted, how long the duck will last, or whether one is running. That is not
 * an omission: the duck is a **hit exemption**, which is the single thing in this game a client must not
 * be able to grant itself, so the authority has to be entirely server-side and a client that tracked the
 * state would be a second copy of it waiting to disagree. A client that tracked it could also *show* it,
 * and the animation is not drawn from here either — it is drawn from the attribute the server writes, by
 * the renderer both bodies share. See `DuckService` and `client/bodyAnimation.ts`.
 *
 * **No prediction, for `DodgeController`'s reason.** The dash is the server's and this has no dash to
 * predict — the body plants rather than moves — so there is nothing here that could be drawn early and
 * then corrected. What the player sees is the clip the server's own attribute starts, which is a
 * round-trip later than the press and is the same latency every other action in this game has.
 *
 * **A press is refused by the server for six reasons and this class does not know any of them** — a
 * freeze, a dash in flight, an open catch window, either lockout, its own cooldown, and being off the
 * ground. Each of those is argued where it lives; the point of them being there and not here is that the
 * rigs reach the same method and neither path can drift from the other.
 */
@Controller()
export class DuckController implements OnStart {
	private readonly player = Players.LocalPlayer;
	private duckRemote?: ClientRemotes["duck"];

	public onStart(): void {
		ContextActionService.BindAction(
			ACTION_NAME,
			(_actionName, inputState) => {
				// **`Begin` only, and `End` is deliberately not bound.** The key is a trigger and not a
				// hold: the duck's length is the server's number, so a release that arrived early would
				// either do nothing or — worse — be a second input the server had to have an opinion about.
				// A held `Z` reports one `Begin`, so the one press is the one request.
				if (inputState !== Enum.UserInputState.Begin) return Enum.ContextActionResult.Pass;

				// **No ball required — and the throw path's gate is deliberately *not* copied here.** A throw
				// needs something to throw; a duck is for a ball thrown *at* you, so an empty hand is exactly
				// the body that wants one. Requiring a ball was the first version of this line, copied from
				// `ThrowController` where it is correct, and it was a bug that read as a dead key: `Pass`, no
				// print, and nothing anywhere saying why. **Every exit below prints**, which is the rule this
				// file learned the hard way.
				//
				// **The only question asked here is whether there is a body at all.** `Pass` rather than
				// `Sink` for that, because nothing was used up; every other reason a duck can fail is the
				// server's, and each of those refuses out loud.
				const character = this.player.Character;
				if (!character) {
					logDebug(`[Duck] no character to duck with`);
					return Enum.ContextActionResult.Pass;
				}

				// **Already ducking: swallowed rather than sent, and said out loud.** The server would refuse
				// it and the line would say nothing a reader does not already know — but a press that
				// vanishes silently is the fault this file exists to be able to explain, so even the
				// deliberate swallow prints. The attribute is the authority and this is a read of it, not a
				// second copy of the state.
				if (character.GetAttribute(DUCKING_ATTRIBUTE) === true) {
					logDebug(`[Duck] ${this.player.Name}: already ducking — press swallowed`);
					return Enum.ContextActionResult.Sink;
				}

				this.getDuckRemote().SendToServer();

				logDebug(`[Duck] ${this.player.Name}: asked to duck`);

				return Enum.ContextActionResult.Sink;
			},
			false,
			Enum.KeyCode.Z,
		);

		// **Printed once at boot, and it is the line that answers "the key does nothing".** A key that is
		// dead for *this* reason prints nothing ever, and one that is dead because the press never arrived
		// prints this and nothing after it — so the presence or absence of this single line splits the two
		// causes apart. Copied verbatim in spirit from `CatchController`, whose comment makes the same
		// argument about the same class of bug, and deliberately **not** paired with a `UserInputService`
		// listener on `Z`: `ContextActionService` marks the inputs it consumes as processed too, so a press
		// that works and a press the chat ate report the same thing and the second listener cannot tell them
		// apart.
		logDebug(`[Duck] ${Enum.KeyCode.Z.Name} bound — ${ACTION_NAME}`);
	}

	/**
	 * The remote, made once and kept.
	 *
	 * Lazy for `DodgeController`'s reason: the declaration builds the instance on the client, and asking
	 * for it at boot would be asking before the server has made its own end of it. See `shared/networking`
	 * for the declarations both sides read.
	 */
	private getDuckRemote(): ClientRemotes["duck"] {
		if (this.duckRemote === undefined) {
			this.duckRemote = events.Client.Get("duck");
		}

		return this.duckRemote;
	}
}
