import Fusion from "@rbxts/fusion-3.0";

/**
 * The two things `ThrowController` knows and `AimTargetController` needs: whether the player is
 * aiming, and what the drawn arc would hit.
 *
 * **Three more have been added since, and the shape of the file has not changed with them** — which is
 * the point of naming it as a module rather than as a wire between two controllers. It is now "what
 * `ThrowController` publishes that other client modules need": `predictedLanding` for
 * `AimFacingController`, which turns the body onto where the throw would land, and
 * `aimSessionStartedAt` for the mobile assist's latch, which `ShiftLock.followTarget` reads through
 * `aimAssist.latchedTarget()`. **The first sentence above is kept because it is where the file came
 * from**, and a reader who finds a fourth value here deserves to know which two it started as.
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

/**
 * Where the drawn arc would come to rest, in world space, or nothing while nothing is being charged.
 *
 * **Published for the same reason `predictedTargets` is, and with the same rule behind it: this is the
 * arc's own answer, not a second one.** The landing marker has always been placed from `arc.contact ??
 * arc.landing` — where the ball's edge first touches something, or where the path ends when it touches
 * nothing — and `AimFacingController` needs exactly that point to know which way the player is throwing.
 * Publishing it from `ThrowController.updateGuide`, beside the two values it already publishes, is what
 * stops the body's facing from answering the question with a raycast of its own: **a second aim line is
 * the failure this whole arrangement exists to prevent**, because the two would agree on the day they were
 * written and drift apart the first time the arc's radius, gravity or exclusion list changed.
 *
 * **`undefined` rather than a zero or the camera's focus**, because "no throw is being charged" has no
 * landing place to name, and a sentinel like `Vector3.zero` would put the facing's target at the middle of
 * the world the moment a player let go. The reader treats `undefined` as "not my business".
 *
 * **A `Vector3` and not the `Trajectory`**, so the reader cannot be tempted to walk the arc or re-solve it.
 * The one thing the facing wants is the point the throw lands on, and that is what this is.
 *
 * **Not a signal anybody subscribes to**: like the two values above, it is polled with `Fusion.peek` by the
 * one reader, which builds no graph edge and so cannot outlive anything.
 */
export const predictedLanding = Fusion.Value<Vector3 | undefined>(scope, undefined);

/**
 * **`os.clock` seconds at which the player's current *aim* began, or nothing when they have no ball in hand
 * — the key the mobile assist's latch is held under.**
 *
 * **A second key beside `chargeStartedAt`, because the assist now starts before the hold does.** The latch
 * used to be keyed on the charge, which was sound while the assist only ran during a hold: the hold was the
 * unit of aiming, so a body was picked once per hold and never re-picked. Once the camera turns onto a target
 * while the player is still only *looking* at one, the hold is no longer the unit — an aim can last for
 * several seconds and end in no throw at all — so the latch needs a key of its own that starts when the
 * player becomes able to throw and survives the press.
 *
 * **Written by `ThrowController.updateGuide` and nobody else**, which is the same rule `aiming` and
 * `predictedTargets` follow: this is a fact the throw controller has and other client modules need. It opens
 * when the assist may act — **alive and in the round** (`isParticipant`), or holding a ball in a practice zone —
 * and closes when it may not: a death, a round ending, a surrender. `releaseThrow` does not touch it.
 *
 * **It used to be the hand, and the 2026-10-21 report is the correction.** An aim session opened on "a ball is
 * in the hand" and closed when the hand emptied, which meant the camera would not turn onto an enemy until the
 * player had picked a ball up — and threw the latch away on every release. The round is the right unit: a player
 * is aiming at the room for as long as they are in it, and the body they are watching before they collect a ball
 * is the body they throw at after.
 *
 * **Read by `aimAssist.latchedTarget()`**, which is what `ShiftLock.followTarget` asks once a frame. A latch
 * whose session is not this value belongs to an aim that is over, and answers nothing — which is how the
 * camera stops following without a "stop" write anywhere, exactly as the charge-keyed version did.
 *
 * **Not the charge, and not derived from one.** A player can aim for a minute and never press; a charge can
 * end and leave the player still aiming at the same body. Tying the two together is what made the assist be
 * off whenever somebody was not holding the button.
 */
export const aimSessionStartedAt = Fusion.Value<number | undefined>(scope, undefined);
