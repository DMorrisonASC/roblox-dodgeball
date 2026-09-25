/**
 * Everything about the dodge: how far it goes, how long it takes, how often it
 * can be used, and how long the client gives you to ask for one.
 *
 * Imports nothing. Read by `DodgeService` for the move itself and by
 * `DodgeController` for the double-tap — the tab window is a *timing*, not a
 * rule, and the server never sees a key press.
 */
export const DODGE_CONFIG = {
	/**
	 * How far a dodge moves the model, in studs.
	 *
	 * Applied by the server, which is the only machine that can move a model; the
	 * client only says *which way*, because it is the only machine that can see the
	 * keys. So this is the one place the size of a dodge is decided.
	 *
	 * Read together with {@link DODGE_CONFIG.DURATION}: a dodge is specified as a
	 * distance covered in a time, because the distance is the thing you can see on
	 * the field and a speed is not. The speed the physics is actually handed is
	 * derived from the pair — see {@link DODGE_SPEED}.
	 */
	DISTANCE: 20,

	/**
	 * How long a dodge takes, in seconds.
	 *
	 * Read with {@link DODGE_CONFIG.DISTANCE}: the distance is what the move is
	 * measured by, so this sets how *fast* the dash covers it rather than how far it
	 * goes. Long enough to read as a committed step, short enough that nothing can
	 * steer through it.
	 */
	DURATION: 0.2,

	/** How long a model must wait before it can dodge again, in seconds. */
	COOLDOWN: 1.5,

	/**
	 * How long the client gives you to double-tap a movement key, in seconds.
	 *
	 * Client-side only, and a *timing* rather than a rule: the server never sees a
	 * key press and does not care how the direction was chosen. Two taps of the same
	 * key inside this window are one dodge request, sent once.
	 */
	DOUBLE_TAP_WINDOW: 0.5,

	/**
	 * The dodge flourish for an R6 rig, as an asset id.
	 *
	 * A placeholder standing in until a real clip is bought, which is why it lives
	 * here rather than in the rig: swapping in the finished animation is an edit to
	 * this string and nothing else. The `rbxassetid://` prefix is required — the
	 * loader treats a bare number as a name and finds nothing.
	 *
	 * Paired with {@link DODGE_CONFIG.DODGE_ANIMATION_R15}: a rig can wear only one
	 * of the two, and an R6 clip on an R15 rig does not load at all, so the server
	 * picks by `Humanoid.RigType` rather than playing both and hoping.
	 */
	DODGE_ANIMATION_R6: "",

	/** The dodge flourish for an R15 rig, as an asset id. See {@link DODGE_CONFIG.DODGE_ANIMATION_R6}. */
	DODGE_ANIMATION_R15: "",
} as const;

/**
 * Speed the dash is driven at, in studs per second.
 *
 * Derived, not tuned: {@link DODGE_CONFIG.DISTANCE} over
 * {@link DODGE_CONFIG.DURATION}. Change either of those and this follows, which is
 * why the figure is never written by hand.
 *
 * It is a velocity because it is applied as one — a `LinearVelocity` constraint on
 * the root part, held for the duration and then destroyed — rather than a `PivotTo`
 * that puts the model somewhere new in a single step. A model that has been *moved*
 * is still trying to walk wherever the humanoid was taking it and walks back; a
 * model that is *moving* has nothing to walk back from.
 */
export const DODGE_SPEED = DODGE_CONFIG.DISTANCE / DODGE_CONFIG.DURATION;
