/**
 * The team ring: the three layers drawn on the ground under each player for the length of a round.
 *
 * **Shared rather than server-only, because the ring is drawn by each client.** The first version of this was a
 * server part and it was wrong for a reason worth recording: the ring is positioned *from a body*, and a
 * player's body is simulated on their own machine — so a server-positioned ring is placed from the server's
 * delayed view and replicated back out, which leaves it trailing by roughly two trips. At running speed that is
 * several studs, and it looks like the ring is chasing the player. Drawn locally, each client places the ring
 * from the same interpolated body it is already drawing.
 *
 * **The colours are not here, and that is deliberate.** The ring and its pattern are drawn in the player's side
 * colour, and the side colours are `TEAM_COLORS` in `shared/gameMode.ts` — one pair for the whole game, read
 * through `teamColourOf`, which is the same source the character outline paints from. A second table here would
 * be a second answer to "what colour is team A", and the ring and the outline either side of it would be free to
 * disagree. The one exception is {@link RING_CONFIG.HALO_COLOR}, which is not a team colour at all.
 *
 * **The ring is geometry now, and that is the fourth answer this file has had.** It was a drawn figure, then an
 * uploaded asset tinted with the team colour, then drawn again at runtime into an `EditableImage`, and now it is
 * made of ordinary parts. The reasoning that put it back on the drawing board is worth keeping: what was wanted
 * was three layers with *independent* opacity and a radial gradient, and neither is something an uploaded image can
 * give — a gradient would have to be baked into the asset, and two layers cannot share one part's face because only
 * one `Texture` renders per face. Drawn, the whole thing is parametric and each layer has its own number. That is
 * all still true, and it is still what {@link RING_CONFIG.DRAWN_RING} describes; what retired it as the default is
 * that **on the client it produced nothing visible at all**, repeatedly, while every count the painter reported
 * came back non-zero. Geometry has no such failure mode, so the parts ring is what draws, and the painted ring is
 * kept one switch away for a client where it works. `shared/ringPattern.ts` is the painter; this file is the only
 * description of what either version draws.
 */
export const RING_CONFIG = {
	/**
	 * Whether the rings are drawn at all. **Placeholder — on.**
	 *
	 * Off means nothing is built rather than something invisible existing: no parts, no position loop, no entries
	 * to clean up. The same reading `OUTLINE_CONFIG.ENABLED` gets, and for the same reason.
	 */
	ENABLED: true,

	/**
	 * How far the halo reaches, in studs — its radius, not its diameter. **Placeholder — 6, twice the ring.**
	 *
	 * **This is the painted ring's halo; the parts ring does not have one.** It had a stepped one — see
	 * `TeamRingController.partsRing` — and on the floor it read as a large white circle with the ring on top of
	 * it. A part cannot hold a gradient, so a part-built halo is a few flat discs, and a few flat discs six studs
	 * wide are a disc rather than a fall-off. Bloom over the outline does that job with no parts and no edge, so
	 * the halo below belongs to the `EditableImage` version that {@link RING_CONFIG.DRAWN_RING} turns on.
	 *
	 * The halo is the layer that makes the ring read as light rather than as paint, and light with a hard edge
	 * reads as neither: it wants to be much larger than the thing it is glowing around, and to have given up
	 * almost all of its brightness by the time it gets there. See {@link RING_CONFIG.HALO_FALLOFF}.
	 */
	HALO_RADIUS: 6,

	/**
	 * The halo's opacity at its very centre, from `0` (nothing) to `1` (solid). **Placeholder — 0.7.**
	 *
	 * Only the centre is at this value: the gradient falls to nothing by the rim, so the average is a good deal
	 * lower and this is really "how bright the middle of the glow is".
	 */
	HALO_TRANSPARENCY: 0.7,

	/**
	 * How sharply the halo gives way, as the exponent of `(1 - radius)`. **Placeholder — 2.**
	 *
	 * `1` is a cone from the middle — a visible even wash across the whole disc. Higher values keep the light
	 * near the centre and let the rim go dark sooner, which is what a glow around something bright looks like.
	 * Below `1` would make it *brighter* towards the rim, which is a ring, and there is already one of those.
	 */
	HALO_FALLOFF: 2,

	/**
	 * The halo's colour. **A near-white, not a team colour, and that is the point.**
	 *
	 * A glow is light rather than paint, so it stays close to white in every team's hands — a halo in the team's
	 * own colour would read as a second, softer copy of the ring rather than as the light coming off it. This one
	 * is very slightly cold, which is the direction the reference's glow leans.
	 *
	 * **This is the only colour in this file.** Everything else is tinted with `teamColourOf`.
	 */
	HALO_COLOR: Color3.fromRGB(236, 244, 255),

	/**
	 * The ring's outer radius, in studs — half its width. **Placeholder — 3, a six-stud ring.**
	 *
	 * A ring is read by looking at the ground near somebody's feet, so it wants to be wider than the feet and
	 * narrower than the space two players need to stand apart: wide enough that a body standing in it is
	 * unmistakably the thing it belongs to, small enough that two players passing do not look like one person with
	 * two rings.
	 */
	RING_RADIUS: 3,

	/**
	 * How wide the ring's outline is, in studs. **Placeholder — 0.3, and this is the knob for thickening it.**
	 *
	 * **The ring is an outline, not a band with a hole in it.** Everything inside the outline is the floor, the halo
	 * and the teeth — nothing else is drawn there — so this number is the whole of how heavy the circle looks: raise
	 * it towards `RING_RADIUS` and the ring fills in from the middle outward, lower it and the ring becomes a wire.
	 *
	 * It was `1.5`, half the radius, which is a *band*: the hole was 1.5 studs across and the ring read as a disc
	 * with a hole rather than as a circle on the floor. See {@link RING_CONFIG.TRIANGLES} for what lives in the
	 * space that freed up.
	 */
	RING_THICKNESS: 0.3,

	/**
	 * The band's opacity at its hole, as a fraction of its opacity at the rim. **Placeholder — 0.45.**
	 *
	 * **The bevel, and the thing that stops the ring reading as a coloured cut-out.** At `1` the band is one flat
	 * strength from hole to rim; lower, and the ring is dimmer inside and full strength at its outer edge, which is
	 * how a rim catches light. It is a *shade of the band* rather than a second colour — every pixel of the picture
	 * is white and the tint is the side's, so this only says how much of it comes through where.
	 */
	BAND_INNER_ALPHA: 0.45,

	/**
	 * How many teeth point inward from the outline, or `0` for none. **Placeholder — 12.**
	 *
	 * **The teeth are what the space inside the outline is for.** A bare circle has no scale and no direction; a ring
	 * of them has both, and it is the difference between a hoop lying on the floor and something with a front. Their
	 * width is `TRIANGLE_SPREAD` of the gap between two of them, so this is how many there are and that is how fat
	 * each one is.
	 */
	TRIANGLES: 12,

	/**
	 * How many straight pieces the outline is made of. **Placeholder — 16.**
	 *
	 * **The outline is parts, not a picture, so it is a polygon.** This is how round the circle looks: 8 reads as an
	 * octagon, 16 as a circle at the distance a ring is seen from, and much past that the pieces are too short to
	 * matter. Each is cut a little longer than its share of the circumference, so the corners meet rather than
	 * leaving slivers of floor showing between them.
	 */
	SEGMENTS: 16,

	/**
	 * Whether each tooth is flipped end for end. **Placeholder — false.**
	 *
	 * **A correction knob rather than a style.** A `WedgePart`'s slope runs along one of its axes, and which end of
	 * that is the point is a fact about the engine's geometry — cheaper to flip than to argue about. If the teeth
	 * come out pointing away from the middle instead of in at it, this is the switch.
	 */
	TOOTH_FLIP: false,

	/**
	 * How far inward each tooth reaches, in studs. **Placeholder — 1.**
	 *
	 * Under `RING_RADIUS - RING_THICKNESS` or the teeth meet in the middle and the ring's hole closes; the flat
	 * middle that is left at this value is what the halo shows through.
	 */
	TRIANGLE_DEPTH: 1,

	/**
	 * How much of the gap between two neighbouring teeth each one fills at its base, `0` to `1`. **Placeholder — 0.55.**
	 *
	 * `1` joins them into a solid gear with no gaps at the rim; well below that they become spines. This is the
	 * "fatter or thinner teeth" knob, as distinct from {@link RING_CONFIG.TRIANGLE_DEPTH}, which is their length.
	 */
	TRIANGLE_SPREAD: 0.55,

	/**
	 * A tooth's opacity where it meets the outline, fading to nothing at its apex. **Placeholder — 0.5.**
	 *
	 * Kept below `BAND_INNER_ALPHA` so a tooth reads as *hanging off* the outline rather than as a bright spoke
	 * competing with it, and so the fade inward looks like light falling off rather than a drawn gradient.
	 */
	TRIANGLE_ALPHA: 0.5,

	/**
	 * How thick each layer's plate is, in studs. **Placeholder — 0.02, and it is deliberately thin.**
	 *
	 * The plates are invisible — see {@link RING_CONFIG.PLATE_TRANSPARENCY} — so nothing of them is ever seen;
	 * what this number actually sets is how far above the floor the picture on each plate floats, because a
	 * `Texture` sits on the plate's top face. A thin plate therefore has the layers closer to the floor rather
	 * than buried in it. It was `0.25` when the plate *was* the visible disc, which is a different job.
	 */
	PLATE_THICKNESS: 0.02,

	/**
	 * How much of each plate is see-through, from `0` (solid) to `1` (invisible). **Placeholder — 1, and it has to
	 * stay 1.**
	 *
	 * **On, in the sense of invisible, and not a tuning knob** — and the one number in this file that has already
	 * caused a bug by being changed. A ring is an annulus and there is no primitive for one, so the shape lives
	 * entirely in the picture on the plate. A *visible* plate does not add a body to the ring: it adds a solid
	 * disc, so the small plate fills the ring's own hole and the large one becomes a second, bigger circle around
	 * it — a plain glowing circle with the pictures buried under it, which is exactly what was reported. The plates
	 * exist to carry a picture, hold it at a height and stand it up.
	 */
	PLATE_TRANSPARENCY: 1,

	/**
	 * How far apart the layers are stacked, in studs, centre to centre. **Placeholder — 0.05.**
	 *
	 * **Must be greater than {@link RING_CONFIG.PLATE_THICKNESS},** or the plates intersect and the pictures
	 * inside each other's geometry. Beyond that the number is about transparent sorting: two pictures at the same
	 * height are drawn in an order the engine picks per frame, and a stack that flickers is worse than a stack
	 * that is a little too tall.
	 */
	LAYER_GAP: 0.05,

	/**
	 * How far above the ground the bottom plate's centre sits, in studs. **Placeholder — 0.15.**
	 *
	 * A picture exactly *on* the floor is half-buried in it and lost to z-fighting with the surface it is lying
	 * on; a little above, the same picture reads as being painted on the floor. Much further up and it starts to
	 * look like something floating rather than something marked — and at knee height, which is where this once
	 * was, it reads as neither.
	 */
	FLOOR_LIFT: 0.50,

	/**
	 * How see-through the outline and the teeth are, from `0` (solid) to `1` (gone). **Placeholder — 0.3.**
	 *
	 * The outline is meant to be a bright solid shape — the visible circle — so this is low; what keeps it from
	 * reading as a flat sticker is the halo under it and the bloom over it, not transparency through it.
	 */
	RING_TRANSPARENCY: 0.3,

	/**
	 * The rosette on the band, as a fraction of the band's own opacity. **Placeholder — 0.55.**
	 *
	 * **This is the number to raise if the detail is too faint to see**, and the one to lower if the band starts
	 * looking like a waffle. The figure is drawn *into* the band at this fraction of the band's opacity at the same
	 * radius, so its pixels are ones the floor shows through more — detail in the band rather than a second shape
	 * competing with it. At `1` the band *is* the figure; at `0` it vanishes.
	 *
	 * **It was `0.35` and was raised once it could be seen.** The old number was chosen against a version of this
	 * where the band's own strength was flat, and a faint figure on a flat band is a grey wash; on a bevel, where
	 * the rim is full strength, the same figure needs more contrast to read at all against the bright outer edge.
	 */
	PATTERN_CONTRAST: 0.55,

	/**
	 * The rosette's own geometry: how many petals, how many rings of them, and how fat each circle is.
	 *
	 * These are the numbers from the drawn figure the ring started with, and they still describe the same thing —
	 * see `shared/ringPattern.ts` for the parity rule that turns rings of circles into lenses, and for why the
	 * bands must be aligned rather than offset by half a step.
	 */
	PATTERN: {
		/**
		 * How many pixels square each layer's image is. **Placeholder — 256.**
		 *
		 * One resolution for both layers, because the halo's gradient and the band's edge are compared by eye at
		 * the same distance and a mismatch there is a visible soft edge against a hard one. The cost is a few
		 * hundred thousand pixel tests once per client; the noise floor of the difference is far below the size of
		 * the features being drawn.
		 */
		RESOLUTION: 256,

		/**
		 * How many circles are in each ring — the petal count. **Placeholder — 16, and that is about the band, not
		 * about the figure.**
		 *
		 * The rosette is drawn across the whole picture and then masked by the band, so only its outer rows are
		 * ever seen — and a band `RING_THICKNESS` wide shows them at whatever size the petals were drawn. At 30 the
		 * petals came out around a third of a stud each and the band read as a lattice of tiny cells rather than as
		 * detail; at 16 each one is a broad spoke wide enough to survive being seen at all. **Fewer and broader is
		 * the whole of this choice.**
		 */
		PETALS: 16,

		/**
		 * How many rings of circles there are, counted outward from the centre — and so how many rows of petals the
		 * figure has. **Placeholder — 2.**
		 *
		 * Two rings is one row of petals visible in the band. More rows stack up inside it and the texture turns
		 * back into a lattice, which is what the `16 / 2` pair is avoiding; fewer than two and the figure is a
		 * single ring of circles with nothing interlocking.
		 */
		BANDS: 2,

		/**
		 * Each circle's radius, as a fraction of its distance from the centre. **Placeholder — 0.4.**
		 *
		 * The one shape knob, and dimensionless, so every ring of circles has the same leaves rather than leaves
		 * that shrink outward. Below `sin(pi / PETALS)` — about `0.1` at 30 — the circles within a ring stop
		 * touching and the figure comes apart into separate circles.
		 */
		CIRCLE_RATIO: 0.4,

		/** Whether odd coverage is the figure's ink. **Placeholder — true**; false draws it in negative. */
		ODD_IS_INK: true,
	},

	/**
	 * Whether to draw the ring's pictures into an `EditableImage` and hang them on a plate.
	 *
	 * **`false`, and the reason is worth writing down.** With this on, the ring is painted at runtime: a halo
	 * gradient, an outlined rosette and teeth, all of them pixels in an editable image worn as a `Texture` on a
	 * disc. That produces the best-looking ring of the two — a real gradient, a real rosette, no polygon edges —
	 * and on the client it was built against it produced *nothing visible at all*, repeatedly, while every count
	 * the painter reported came back non-zero. The parts ring beside it is drawn from ordinary geometry, and
	 * geometry has no feature that can be unavailable, no content id that can fail, and nothing that renders as an
	 * invisible texture over a disc that is definitely there.
	 *
	 * **Turn this on to try the painted ring again**; `build` uses it whenever it yields pictures, and falls back
	 * to the parts ring when it does not. The layer counts printed once a round say which of the two you got.
	 */
	DRAWN_RING: false,

	/**
	 * Where the ring goes when its body is in the air the moment it is made, in studs below the root.
	 *
	 * **Placeholder — 3, which is roughly a body's own root height.** A body in the air has no ground to measure,
	 * and a ring at the feet is a better answer than none. A wrong guess here is *self-correcting*: the height is
	 * recomputed from the body every frame, so the first frame the player lands puts it exactly on the floor.
	 */
	FALLBACK_DROP: 3,
} as const;
