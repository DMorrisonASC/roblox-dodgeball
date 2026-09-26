import Fusion from "@rbxts/fusion-3.0";

/**
 * Whether the local player is aiming a throw: one value, written by one controller and read by
 * another.
 *
 * **A module rather than a wire between the two controllers.** `ThrowController` is the only thing
 * that knows when the aim guide is up, and `AimTargetController` is the only thing that wants to
 * know — but neither should hold the other. A controller reaching into a controller is a
 * construction-order dependency, and Flamework's container is the wrong place to encode "the glow
 * follows the guide": that is a fact about the game, not about boot order.
 *
 * So the state lives in nobody's file. `ThrowController` writes it, `AimTargetController` reads it,
 * and the two stay as unaware of each other as they were. This is the same shape as
 * `client/ui/screenGui.ts`, which is how two HUD controllers share one `ScreenGui` without either
 * of them owning it.
 *
 * **A `Value` and not a plain boolean** because it is a signal in the Fusion sense: it is what the
 * reactive graph would watch if this ever grew a second reader, and the client's other shared state
 * is already Fusion's. Nothing observes it, so nothing has a scope that has to be kept alive — the
 * reader polls it with `Fusion.peek`, which builds no graph edge and so cannot outlive anything.
 * See `AimTargetController` for why that is deliberate.
 *
 * The scope is this module's own, made once and never destroyed, because the value lives exactly as
 * long as the module does. There is nothing here to clean up and no owner to hand it to.
 */
const scope = Fusion.scoped();

/** `true` for as long as the local player's aim guide is up — see `ThrowController.updateGuide`. */
export const aiming = Fusion.Value(scope, false);
