import Fusion from "@rbxts/fusion-3.0";

/**
 * The two things `ThrowController` knows and `AimTargetController` needs: whether the player is
 * aiming, and what the drawn arc would hit.
 *
 * **A module rather than a wire between the two controllers.** `ThrowController` is the only thing
 * that knows either answer, and `AimTargetController` is the only thing that wants them — but
 * neither should hold the other. A controller reaching into a controller is a
 * construction-order dependency, and Flamework's container is the wrong place to encode "the glow
 * follows the guide": that is a fact about the game, not about boot order.
 *
 * So the state lives in nobody's file. `ThrowController` writes both, `AimTargetController` reads
 * both, and the two stay as unaware of each other as they were. This is the same shape as
 * `client/ui/screenGui.ts`, which is how two HUD controllers share one `ScreenGui` without either
 * of them owning it.
 *
 * **Two values rather than one object.** They change on different clocks and answer different
 * questions — the flag flips when a ball appears in a hand or leaves it, the target changes as the
 * aim sweeps — and nothing reads them as a pair, so nothing would be gained by tying them together.
 *
 * **`Value`s and not plain variables** because they are signals in the Fusion sense: they are what
 * the reactive graph would watch if either ever grew a second reader, and the client's other shared
 * state is already Fusion's. Nothing observes them, so nothing has a scope that has to be kept alive
 * — the readers poll with `Fusion.peek`, which builds no graph edge and so cannot outlive anything.
 * See `AimTargetController` for why that is deliberate.
 *
 * The scope is this module's own, made once and never destroyed, because the values live exactly as
 * long as the module does. There is nothing here to clean up and no owner to hand it to.
 */
const scope = Fusion.scoped();

/** `true` for as long as the local player's aim guide is up — see `ThrowController.updateGuide`. */
export const aiming = Fusion.Value(scope, false);

/**
 * The models the *drawn arc* would reach, in the order it meets them. Empty if it would reach no body
 * at all.
 *
 * **Written from the arc rather than from the crosshair, which is the whole reason it exists.** The
 * crosshair ray and the throw are two different lines: the ray is straight, from the camera, and the
 * throw is a ballistic arc from the muzzle. They agree on the aim point and disagree about
 * everything between it and the hand — so a tree standing on the arc but not on the ray used to
 * leave a model glowing while the ball was certain to hit the tree. See `AimTargetController` for
 * the full account, and `ThrowController.updateGuide` for where this is computed.
 *
 * **A list rather than one model, because a Pierce ball does not stop at the first body.** Every
 * other throw stops on the one body it reaches, so this holds exactly one entry — or none — and reads
 * as it always did. A Pierce throw goes *through* the bodies in its line and stops on the world
 * behind them, so "what is this aim on" has more than one true answer, and lighting only the first
 * one was the glow describing a throw that stops where the ball will not.
 *
 * **Rewritten every frame, so it is compared by contents and never by reference.** Two frames with
 * the same bodies in the same order hand over two different tables; a reader that tested `===` would
 * conclude something had changed every frame and redo its work forever. `AimTargetController` is the
 * only reader, and it does exactly that comparison.
 *
 * Empty rather than absent for "nothing would be reached": that is the ordinary case — a throw at a
 * wall, at the floor or at the sky — and not a state of not knowing yet.
 */
export const predictedTargets = Fusion.Value<Array<Model>>(scope, []);
