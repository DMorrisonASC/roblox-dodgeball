import Fusion from "@rbxts/fusion-3.0";

/**
 * Whether a charged throw is being held, and when it started — **the one fact the throw and the catch
 * share.**
 *
 * **A module rather than a wire between the two controllers**, which is `aiming.ts`'s argument and
 * `roundZone.ts`'s as well: `ThrowController` owns the charge and `CatchController` owns the `E` key, and a
 * controller reaching into a controller is a construction-order dependency that Flamework's container is the
 * wrong place to encode. So the fact lives in nobody's file and both of them read it.
 *
 * **This is deliberately *not* a file about aim, and it is separate from `aiming.ts` for that reason.** That
 * module's two values are what the *preview* tells the glow; this is what one *input* tells another, and
 * `panels.ts` states the rule the hard way — a module that grows a fact belonging to a different question
 * keeps the name of the question it started with, "and the name is currently a reader's first wrong idea
 * about what belongs here". Two small files is the answer, not one file with a stretched name.
 *
 * **Why the state itself is here, rather than a request that the throw's loop consumes.** The obvious shape —
 * the catch sets "please cancel", and the next frame notices — was considered first and thrown away, because
 * of the one case it cannot cover: **a player who presses `E` *instead of* letting go can put the press and
 * the release inside a single frame**, and a request consumed on the following frame would let the throw go
 * off in between. The cancellation has to be visible to the release handler *in the same frame*, and the only
 * way to arrange that without registering a callback from one controller into another is for the cancelling
 * to be a write to the state the release handler already reads. So the charge's start instant lives here:
 * the fact is shared, the write is shared, and there is nothing left that can be out of step.
 *
 * **Not a boolean beside a clock**, which is the pair this replaced. `undefined` means "no throw is being
 * held" and a number means "held since then" — one value, one meaning, and no way for two halves to disagree
 * about whether a charge exists. Every reader treats it the same way: `peek` it, compare with `undefined`,
 * and read the number as an `os.clock` instant. See `ThrowController.currentCharge` for the division that
 * turns it into a charge.
 *
 * The scope is this module's own, made once and never destroyed, because the value lives exactly as long as
 * the module does — `aiming.ts` makes the same call for the same reason. Nothing observes it, so it builds no
 * graph edge that could outlive anything; both readers poll with `Fusion.peek`.
 */
const scope = Fusion.scoped();

/**
 * `os.clock` seconds at which the live charge began, **or `undefined` when no throw is being held.**
 *
 * Written by three places, all of which are answering "is a throw being held": `ThrowController` begins and
 * ends charges here, and `CatchController` clears it to cancel one. Read by `ThrowController`'s frame loop
 * and release handler, and by `CatchController`'s key handler.
 */
export const chargeStartedAt = Fusion.Value<number | undefined>(scope, undefined);
