/**
 * Everything about the catch: how long an attempt stays open, and what a catch
 * can be made with.
 *
 * Imports nothing. The window is the server's; the catchable parts are the
 * body-part names a ball has to touch, matched against whatever rig the catcher
 * happens to be wearing.
 */

/**
 * The parts a catch can be made with: the torso and the arms, and nothing else.
 *
 * Both rig types are named, because a catch that worked on R15 and not on R6
 * would be a rule that changed with the avatar — R15 splits each limb into upper
 * and lower halves, R6 calls them "Right Arm". Legs and the head are absent on
 * purpose: they are what you throw *at*, so if they could catch, a catch would
 * stop being a read of the throw.
 *
 * `HumanoidRootPart` is deliberately absent too, and for a sharper reason than the
 * rest: it sits *inside* the torso, so a ball in contact with it is in contact with
 * the torso as well and a report against it alone means nothing happened.
 * `BallComponent` skips it by name before this set is ever consulted.
 *
 * Treated as read-only. A `Set` is mutable whatever the assertion says, so this is
 * a rule the readers keep rather than one the type enforces.
 */
const CATCHABLE_PARTS = new Set<string>([
	"Torso",
	"UpperTorso",
	"LowerTorso",
	"LeftUpperArm",
	"LeftLowerArm",
	"Left Arm",
	"RightUpperArm",
	"RightLowerArm",
	"Right Arm",
]);

export const CATCH_CONFIG = {
	/**
	 * How long a catch attempt stays open, in seconds.
	 *
	 * An attempt is a *window*, not a catch: the press opens it, and the ball that
	 * arrives inside it is the one caught. Long enough to cover a read of the throw,
	 * short enough that it is a read rather than a shield — and one window catches
	 * one ball, so holding the key buys nothing.
	 */
	WINDOW_SECONDS: 0.4,

	/** {@link CATCHABLE_PARTS} — the body parts a catch can be made with. */
	CATCHABLE_PARTS,
} as const;
