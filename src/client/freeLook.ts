import Fusion from "@rbxts/fusion-3.0";

/**
 * Whether the player has taken the custom camera off by hand: the one fact `ShiftLock` publishes and
 * the camera toast reads.
 *
 * **A module rather than a wire between two controllers**, for the reason `aiming.ts` sets out at
 * length. `ShiftLock` owns the release and the toast is the only thing that wants to say so, and
 * neither should hold the other: a controller reaching into a controller is a construction-order
 * dependency, and "the toast says what the camera just did" is a fact about the game rather than
 * about boot order. So the fact lives in nobody's file — `ShiftLock` writes it, the toast reads it,
 * and the two stay as unaware of each other as they were.
 *
 * **A publication rather than the state itself, and the difference is deliberate.** `ShiftLock` holds
 * the boolean, because it is the thing that decides whether the camera is held and it needs its own
 * answer on the tick it changes rather than on the reactive graph's next turn. This is that same
 * answer said out loud, written on every change so something else can react to it. Nothing reads this
 * back *into* the camera's decision, which is what makes it impossible for the two to disagree: there
 * is one decision and one copy of it.
 *
 * **`true` means the custom camera is off and the player has the ordinary one.** The name is the
 * state the player chose rather than the mechanism — see `SHIFT_LOCK_CONFIG` and `ShiftLock` for the
 * mechanism, which is two engine settings and a cursor.
 *
 * **It starts `false`, which is the truth at boot**: nobody has pressed anything yet, and a client
 * that arrives between rounds is unlocked anyway. The round boundary puts it back to `false` at every
 * round start, so the value is always the one the round's own rule implies.
 *
 * The scope is this module's own, made once and never destroyed, because the value lives exactly as
 * long as the module does — the same arrangement `aiming.ts` makes, and for the same reason.
 */
const scope = Fusion.scoped();

/** `true` while the player's own `~` release is in force. See this module's doc. */
export const freeLook = Fusion.Value(scope, false);
