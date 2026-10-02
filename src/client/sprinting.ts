import Fusion from "@rbxts/fusion-3.0";

/**
 * The sprint key state: the one thing `SprintController` knows and `LocomotionAnimationController`
 * needs.
 *
 * **A module rather than a wire between the two controllers**, which is the arrangement `aiming.ts`
 * documents at length and for the same reason: the sprint keys are read in one place and the moving clip
 * is chosen in another, neither should hold the other, and Flamework's container is the wrong place to
 * encode "the legs follow the key". A controller reaching into a controller is a construction-order
 * dependency, and that is a fact about the boot rather than about the game.
 *
 * **Not a second read of the key.** `UserInputService.IsKeyDown` where the clip is chosen would be a
 * second copy of the key list, and the two would drift the first time a third key was bound — which has
 * already happened twice to this binding: `LeftAlt` was bound and removed when the operating system took
 * the focus with it, and `RightAlt` was bound and removed when it turned out to be the OS's composition
 * key. See `SPRINT_KEYS` for both, and for why the list has to be read rather than guessed at.
 *
 * **The key rather than the sprint the server granted, and those are different facts.** The server owns
 * the pool and refuses a sprint it will not pay for; the client owns the key. This is the key, because
 * that is what the animation is showing — see `LocomotionAnimationController.wantedClip` for the rule it
 * drives, and for what that choice knowingly costs.
 *
 * A `Value` and not a plain variable, for `aiming.ts`'s reason: it is a signal in the Fusion sense. It is
 * never *observed* — the animation polls it with `Fusion.peek`, which builds no graph edge and so cannot
 * outlive anything — and nothing here owns a scope to hand over. The scope is this module's own, made
 * once and never destroyed, because the value lives exactly as long as the module does.
 */
const scope = Fusion.scoped();

/** `true` while a sprint key is held. Written by `SprintController`, read by the animation. */
export const sprinting = Fusion.Value(scope, false);
