/**
 * The two actions that cannot be taken at the same time: how long the one that has
 * just finished keeps the other shut, and how a body looks while either of them is
 * happening.
 *
 * Imports nothing. It is a file of its own rather than an entry in
 * `dodge.config.ts` or `catch.config.ts` because it belongs to neither: what it
 * describes is the *pair*, and the lockout below has to be the same in both
 * directions or the two rules would disagree about who is allowed to act. The
 * afterimage values at the bottom are here for that same reason and not for
 * convenience — one trail for both windows, so a reader asking "how does a body look
 * while it is acting" has one file to open, and each of the two services keeps the
 * imports it already had instead of gaining one for numbers it shares.
 */
export const ACTION_CONFIG = {
	/**
	 * How long after one action ends the other stays shut, in seconds.
	 *
	 * One value, read by both services — `DodgeService` applies it to a catch that has
	 * just closed, `CatchService` to a dodge that has just ended.
	 *
	 * Measured from the moment the first action **ended**, never from when it started:
	 * a dash and a catch window are different lengths, so a lockout timed from the
	 * start would be shorter than this for one of them and longer for the other.
	 *
	 * Deliberately short — long enough that a player cannot dodge out of a catch they
	 * have already committed to, or catch a ball they have just dodged past, and short
	 * enough that it never reads as a cooldown of its own. Nothing about it changes
	 * either action; it only decides the moment each one may begin.
	 */
	ACTION_LOCKOUT_SECONDS: 0.5,

	/**
	 * How often a moving body leaves a ghost behind it, in seconds.
	 *
	 * **Placeholder — 0.025, which is 40 Hz. Halved from 0.05, and the argument for 0.05 is recorded here
	 * rather than deleted because it is the argument that was wrong.**
	 *
	 * **The arithmetic that made 0.05 look right, and the sentence in it that does not hold.** A dash is
	 * {@link DODGE_CONFIG.DURATION} — **0.2s** — over {@link DODGE_CONFIG.DISTANCE} — **15 studs** — so a
	 * dash moves at **75 studs/s**, and this interval decides how far apart the copies are: 0.05s is **3.75
	 * studs**. The old note concluded that a body is "about two studs wide", so at 20 Hz the copies were
	 * close enough. **They are not, and the width that matters is not the body's.** What has to overlap is
	 * each *part* along the direction of travel, and the parts that carry a character's silhouette are
	 * boxes about **one stud** through — an arm, a leg, the torso's own depth. At 3.75 studs apart, three
	 * studs of empty arena sat between every pair, which is the gap this is here to close.
	 *
	 * **What 0.025 buys, measured against that.** Spacing is **1.875 studs** — under the body's two-stud
	 * width, so the copies now touch as silhouettes. Per dash: the ghost at t=0 plus eight more inside the
	 * window, so **nine**, where 0.05 gave four. Per trail alive at once: the lifetime below over this,
	 * **fourteen**.
	 *
	 * **And what it does not buy, stated rather than left to be discovered.** 1.875 studs is still wider
	 * than the one-stud parts, so a limb will still show a gap between copies — about nine tenths of a stud
	 * of arena at the thinnest. Making *every* part overlap needs spacing under a stud, which is 0.0125s:
	 * **sixteen per dash and twenty-eight alive per trail**, and that is where the lifetime below becomes
	 * the binding number rather than this one. So this is a deliberate stopping point at half the old
	 * interval rather than the value that closes the last gap — see `ACTION_CONFIG.AFTERIMAGE_LIFETIME_SECONDS`
	 * for why the second halving belongs there and not here.
	 *
	 * **A rate, not a distance**, deliberately: the movement gate in `afterimage.ts` decides whether a ghost
	 * is worth leaving at all, and this decides how often that question is asked. Raising this lowers the
	 * cost of a trail; lowering it thickens the trail, but never past what the gate allows — which is the
	 * point of separating the two.
	 */
	AFTERIMAGE_INTERVAL_SECONDS: 0.025,

	/**
	 * How long a ghost lasts, in seconds.
	 *
	 * **Placeholder — 0.35.**
	 *
	 * **The ghost's whole life, not a delay before it goes.** It fades from
	 * {@link ACTION_CONFIG.AFTERIMAGE_START_TRANSPARENCY} to nothing across exactly this long and is
	 * destroyed the moment it arrives — so this is both how far behind a body its trail reaches and how many
	 * ghosts one trail has alive at once: at {@link ACTION_CONFIG.AFTERIMAGE_INTERVAL_SECONDS} it is
	 * **fourteen** per trail, where the interval before it was halved gave seven. Longer is a longer tail and
	 * more parts alive; shorter hugs the body. It is deliberately longer than a single dash, so that a dodge's
	 * ghosts are all still visible while the dash is happening — a ghost that expired inside the dash would
	 * leave a trail shorter than the movement that made it.
	 *
	 * **Unchanged in this revision, and it is the number this reviewer would change first — as a note rather
	 * than as an edit.** Three things point at it. It decides how many ghosts a trail has alive, so it is
	 * what the ghost cap is really made of; at the new interval, a sustained trail holds fourteen ghosts
	 * because of this and not because of the rate. And the *length* of a dodge's trail is not governed by it
	 * at all: a dodge emits for 0.2s and then stops, so its trail is nine ghosts over 15 studs however long
	 * they then take to fade. Cutting this to 0.2s would leave a trail **eight** alive instead of fourteen,
	 * which would let the cap come back down to 56 for the same seven trails — the same visual shape with a
	 * little over half the parts. It is left alone because the task that halved the interval asked for the
	 * lifetime to be left alone, and because a trail whose oldest ghosts fade *during* the dash is a
	 * different look rather than a strictly better one.
	 */
	AFTERIMAGE_LIFETIME_SECONDS: 0.35,

	/**
	 * How transparent a ghost's layers start, from `0` (a solid copy) to `1` (nothing).
	 *
	 * **Placeholder — 0.75.**
	 *
	 * **A faint echo rather than a second body, and this is the number that decides which.** A ghost is a
	 * copy of something that is *also still on screen*, so anything near solid reads as a duplicate of the
	 * character — two players where there is one — rather than as where the character was. `0.75` leaves a
	 * quarter of the body's colour: visible as a shape against the arena, unmistakably not a body. It is also
	 * a *floor* rather than an assignment, so a layer that was already fainter than this keeps its own value
	 * and a ghost is never more solid than the thing it is imitating. See `afterimage.ts`.
	 */
	AFTERIMAGE_START_TRANSPARENCY: 0,

	/**
	 * How far a body must move before it leaves another ghost, in studs.
	 *
	 * **Placeholder — 0.5, and its relationship to the interval above changed when that was halved.**
	 *
	 * **The gate that makes this a trail rather than a stack, and it exists for one case: a rig that catches
	 * continuously.** A catch window is held open by re-asking for it every tick, so an NPC can have one open
	 * for as long as it lives — on the interval alone, a *standing* catcher would pile identical ghosts onto
	 * one spot for minutes. A ghost where the last ghost already is adds nothing to a smear, so this costs a
	 * moving body nothing and costs a stationary one only what it was never owed.
	 *
	 * **It cannot suppress anything at dash speed, which is the whole answer the gap complaint needed.** A
	 * dash moves at 75 studs/s and covers **1.875 studs** in one 0.025s interval — nearly four times this
	 * threshold — so the gate is passed on every interval of every dash and was never the reason for the
	 * spacing.
	 *
	 * **What the halving did change is where the boundary sits for everything slower.** At 0.05s a walking
	 * body at the base 20 studs/s covered a stud between ghosts and cleared this by a factor of two. At
	 * 0.025s it covers **exactly 0.5 studs**, which is this number to the stud: the boundary is now *at*
	 * walking speed rather than comfortably below it, and anything slower than a walk leaves ghosts every
	 * other interval instead of every one. That is a real consequence of the change and it is left standing
	 * deliberately — the complaint was about a dash, a walking body's trail was already at this density
	 * before, and lowering this threshold would put more ghosts on the screen for the slowest bodies, which
	 * are the ones whose parts are least spread out and need the fewest.
	 */
	AFTERIMAGE_MIN_MOVEMENT_STUDS: 0.1,

	/**
	 * How many ghosts may be alive in the world at once.
	 *
	 * **Placeholder — 98, and it was 48. The halving of the interval is what moved it.**
	 *
	 * **The number is derived, not tuned, and this is the derivation**: the lifetime above over the interval
	 * above is how many ghosts one trail holds alive — 0.35 / 0.025 = **fourteen** — and this is *trails ×
	 * that*. The busy round is four rigs and two players all acting at once, six trails, which is **84**;
	 * seven trails is 98, and that is where this sits. **Any change to the interval or the lifetime changes
	 * fourteen, and this number has to move with it** — which is exactly the trap the old 48 fell into: it was
	 * six trails at the old rate's seven-a-trail, and it silently became a cap of three trails when the rate
	 * doubled.
	 *
	 * **Why it is raised rather than left to bind.** Left at 48, a six-trail round runs at 48 of the 84
	 * ghosts it asked for: the spawn is skipped and the trails thin out, and the thinning happens in the
	 * busiest moment — which is precisely when a cue that says "somebody just dodged" is worth having. The
	 * part of the cap worth keeping is the part that stops the world growing without limit, and 98 anchored
	 * ghosts is not unbounded; it is about 1,500 parts at fifteen parts a ghost. **The cost of raising it is
	 * real and is a throughput cost rather than a parts cost**: a saturated cap recycles 98 / 0.35 = **280
	 * ghosts a second**, which is 4,200 `BasePart`s created and destroyed a second and the same number of
	 * tweens, all of it replicated to every client. That is the number to watch, and I have no measurement of
	 * what this place's clients will do with it — see `AFTERIMAGE_LIFETIME_SECONDS` for the lever that
	 * reduces it without touching the spacing, which is the one I would reach for before lowering this.
	 *
	 * **Over budget a ghost is not made at all**, rather than an old one being destroyed to make room.
	 * Skipping thins the trails of whoever is over the line; evicting would delete a copy out of the middle
	 * of a smear while its neighbours kept going, which is the one failure a motion cue cannot afford. See
	 * `afterimage.ts`.
	 */
	AFTERIMAGE_MAX_GHOSTS: 198,
} as const;
