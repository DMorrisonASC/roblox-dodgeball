import { Workspace } from "@rbxts/services";
import { DEBUG_CONFIG } from "shared/config/debug.config";
import { THROW_FEEDBACK_CONFIG } from "shared/config/throwFeedback.config";

/**
 * How long the anchor outlives the last particle, in seconds.
 *
 * `FreezeService`'s number for the same job, and it is small on purpose: the timer below already adds the
 * emission window and the longest a particle can live, so what this covers is the gap between the *last
 * particle's birth* and the moment the anchor may go. Destroying it on the exact frame that particle expires
 * would cut it off a frame early, and a margin much larger than a frame or two would leave an invisible part in
 * the world for no reason at all.
 */
const BURST_CLEANUP_MARGIN = 0.25;

/**
 * What the anchor is called, so a leftover can be found — and attributed to *this* effect.
 *
 * `SoundEmitter`'s rule, and the reason it is not a shared name: the way to check that nothing was left
 * behind is to search the world for a name, and that check only says which event leaked if each event has
 * its own. `FreezeBurst` is the other one today.
 */
const BURST_ANCHOR_NAME = "ThrowWindBurst";

/**
 * One gust of air at the point a ball left a hand.
 *
 * **The server builds the emitter, and every client simulates it — which is not the same thing as "the server
 * draws it", and the difference is the whole of a bug this file had.** Particles are simulated by whoever
 * renders them, so what has to reach a client is the *emitter*: an instance, replicated like any other. An
 * emission *event* is a different thing — `ParticleEmitter:Emit()` is documented as "cause the ParticleEmitter
 * to instantly emit the given number of particles" and nowhere as replicated — and this effect was built as
 * `Rate = 0` plus one `Emit` call, so the server got the gust it had asked itself for while every client got an
 * emitter with nothing to do. `BallService`'s own note about it said "built by the server, so everybody sees
 * it"; what everybody saw was an empty part. See the emission below for what replaced it, and note that the
 * shape is unchanged: it is still one emitter, built here, with no wire.
 *
 * **`SoundEmitter`'s sibling, and the comparison is what hid the bug.** A `Sound` is *played* by whoever owns
 * it and heard by everyone, so `emitSound`'s server-side build does give everybody the sound — the two calls
 * look like the same trick and are not. An emitter's *properties* replicate; its *emission* is simulated
 * locally by each client from those properties, which is why the rate below is the thing that works.
 *
 * **A module beside `SoundEmitter` rather than a method on `BallService`**, and the argument is that file's:
 * there is no state here, nothing to start and nothing to inject, so a method on a two-thousand-line service
 * would be a decorator around a construction. `FreezeService` keeps its own burst as a private method because
 * it belongs to that ability's file; this one belongs to the throw, and `BallService` already reaches out of
 * itself for its sound. The two files are siblings in shape on purpose — read `emitSound` beside this one.
 *
 * **A rate for a quarter of a second, which is the difference between a gust and a jet.** The emitter is
 * `Enabled` with `Rate = COUNT / WIND_BURST_EMIT_SECONDS`, so it stops on its own the moment the gust's budget
 * is spent — a continuous emitter left running on the anchor would keep firing for as long as the anchor lived,
 * which is weather rather than an event. The emission therefore starts when the anchor *enters the world*,
 * which is why the parenting comes first: an emitter that is not in the world emits nothing at all.
 *
 * **The anchor is aimed up, and the aim is set rather than left to a default.** What the emitter has is
 * `EmissionDirection`, a *face*, and the typings do not state which way a fresh emitter faces — so both are
 * set: `Front`, with the anchor's `LookVector` pointing at the sky. At the 180° spread in the config this
 * makes no visible difference, since a sphere has no forward; it is set anyway because "the axes are up and
 * down" is then a fact about the code rather than something nobody chose.
 *
 * **The anchor is there to be a `CFrame` in the world and nothing else**, so it is invisible, weightless,
 * collisionless, and — the flag that is easy to forget — not casting a shadow, because an invisible part
 * that draws a shadow on the floor is a visible artifact in the shape of the thing nobody can see. All three
 * of `SoundEmitter`'s care flags are here for the same reason they are there: the ball this was thrown from
 * is still in the air a stud away, and a touchable or queryable part here is a fresh surface for it to hit
 * and a fresh thing for the aim guide's sweep to stop on.
 *
 * **Nothing about it is stored and no caller may hold it.** The burst is over in less than half a second and
 * there is no row, no map and no owner: the timer below is its whole lifecycle, exactly as `SoundEmitter`'s
 * is for a sound, which is why a round boundary has nothing here to sweep. The function returns `void` rather
 * than the anchor for that reason — a return value would be an invitation to start treating it as state.
 *
 * @param at Where the gust leaves from — the launch point, as a `CFrame`. Only its position is used: a shell
 * that goes out in every direction has no orientation, and taking the ball's rotation would tie its poles to
 * the throw for no one's benefit.
 * @param subject What the diagnostic line calls this event, for a human reading the output. The thrower's
 * name is the useful one, because the interesting fact at a throw is *who* it was.
 */
export function emitWindBurst(at: CFrame, subject: string): void {
	if (!THROW_FEEDBACK_CONFIG.WIND_BURST_ENABLED) return;

	const anchor = new Instance("Part");
	anchor.Name = BURST_ANCHOR_NAME;
	// Forward is up, so the emitter's own direction is the sky — see the note above on why the face is set
	// rather than left to a default.
	anchor.CFrame = CFrame.lookAt(at.Position, at.Position.add(new Vector3(0, 1, 0)));
	anchor.Size = new Vector3(0.1, 0.1, 0.1);
	anchor.Anchored = true;
	anchor.CanCollide = false;
	anchor.CanTouch = false;
	anchor.CanQuery = false;
	anchor.Massless = true;
	anchor.CastShadow = false;
	// Invisible, and that is not tidiness: the part exists to carry the emitter, and a visible one would be a
	// small box sitting in the middle of the gust. The emitter is its child so that one `Destroy` takes both.
	anchor.Transparency = 1;

	const emitter = new Instance("ParticleEmitter");
	emitter.Texture = THROW_FEEDBACK_CONFIG.WIND_BURST_TEXTURE;
	// **A rate over a short window rather than one `Emit` call, and this is the line that makes the gust visible
	// to everybody.** What replicates is the emitter — its properties — and every client simulates particles from
	// them; the engine's own words for this property are "Particles emit automatically when the emitter is
	// Enabled with a non-zero Rate", which is the mechanism a server-made campfire runs on. The window is what
	// keeps it a one-shot: once `WIND_BURST_EMIT_SECONDS` of budget is spent the emitter has nothing left to
	// make, and the anchor's timer takes the whole thing away. See the file comment for what the old `Rate = 0`
	// plus `Emit` pair cost.
	emitter.Rate = THROW_FEEDBACK_CONFIG.WIND_BURST_COUNT / THROW_FEEDBACK_CONFIG.WIND_BURST_EMIT_SECONDS;
	emitter.Enabled = true;
	emitter.EmissionDirection = Enum.NormalId.Front;
	emitter.Lifetime = new NumberRange(THROW_FEEDBACK_CONFIG.WIND_BURST_LIFETIME);
	emitter.Speed = new NumberRange(THROW_FEEDBACK_CONFIG.WIND_BURST_SPEED);
	emitter.Drag = THROW_FEEDBACK_CONFIG.WIND_BURST_DRAG;

	// One number in the config, two here: the emitter takes a horizontal and a vertical spread separately,
	// and this gust wants the same number in both — the whole sphere, which is what makes it air displaced
	// rather than a jet in one direction.
	const spread = THROW_FEEDBACK_CONFIG.WIND_BURST_SPREAD_ANGLE;
	emitter.SpreadAngle = new Vector2(spread, spread);

	emitter.Size = THROW_FEEDBACK_CONFIG.WIND_BURST_SIZE;
	emitter.Transparency = THROW_FEEDBACK_CONFIG.WIND_BURST_TRANSPARENCY;
	// A `Color3` in the config and a sequence here, for `FreezeService`'s reason: one colour is what the
	// effect is, and the emitter wants the lifetimed form.
	emitter.Color = new ColorSequence(THROW_FEEDBACK_CONFIG.WIND_BURST_COLOR);
	emitter.LightEmission = THROW_FEEDBACK_CONFIG.WIND_BURST_LIGHT_EMISSION;
	// The near-weightless fall, as a scale on the world's own gravity so a map that has turned it down gets
	// air that respects the world it is in. See the config entry for why it is nearly zero.
	emitter.Acceleration = new Vector3(
		0,
		-Workspace.Gravity * THROW_FEEDBACK_CONFIG.WIND_BURST_GRAVITY_SCALE,
		0,
	);
	emitter.Parent = anchor;

	// Parented last, with every property already set — `SoundEmitter`'s rule. **And here the parenting *is* the
	// emission**: the emitter is enabled with a rate, so the gust begins on the frame this part enters the world
	// and needs no call of its own. That is the whole of the fix — see the file comment.
	anchor.Parent = Workspace;

	// **One timer, and it is the effect's entire lifetime.** Two things have to be over before the anchor may go:
	// the emission, which runs for `WIND_BURST_EMIT_SECONDS`, and then the last particle's own life. Keeping the
	// anchor for the two added together is exactly that, and the `Destroy` takes the emitter with it, so there is
	// one call rather than two and no way for the emitter to be left behind.
	task.delay(
		THROW_FEEDBACK_CONFIG.WIND_BURST_EMIT_SECONDS +
			THROW_FEEDBACK_CONFIG.WIND_BURST_LIFETIME +
			BURST_CLEANUP_MARGIN,
		() => anchor.Destroy(),
	);

	// Behind the verbosity gate, like the other one-shots: the burst is built for every throw and says
	// nothing anybody needs unless a leftover is being hunted.
	if (DEBUG_CONFIG.VERBOSE_LOGS) print(`[Burst] ${subject}: wind at a throw`);
}
