/**
 * The team ring's artwork — a halo, a band, and the rosette on it — drawn into RGBA pixel buffers.
 *
 * **All three are pixels rather than parts, and that is forced rather than chosen.** A ring is an annulus: a disc
 * with a hole. There is no primitive for that — a `Cylinder` part is a solid disc, there is no torus, and a part
 * cannot be given a hole — so the only routes to one are an image whose middle is transparent, or a band built
 * out of many small parts. The rosette needs pixels whichever way that goes. So the shape lives in an image, the
 * parts carrying the images are invisible bodies, and what makes the result read as *light* rather than as a
 * sticker is bloom on the bright pixels plus the gradient underneath them.
 *
 * **The ink is white, always, and the colour arrives as a tint.** `Texture.Color3` multiplies, so white is the
 * only ink that takes the team's colour — black stays black at every team colour there is, silently. The one
 * exception is deliberate and is the halo: it is a glow rather than a colour, so it is drawn white and tinted a
 * near-white (`RING_CONFIG.HALO_COLOR`) instead of the team's colour.
 *
 * **The rosette's rule is a parity, and that is the whole of it.** A pixel of the figure takes ink when an *odd*
 * number of the `PETALS * BANDS` circles contain it — the even-odd rule, equivalently the symmetric difference
 * of the discs. Asking "is it in a circle" fills the disc solid, because one band alone covers its own annulus
 * several times over; asking "is it in all of them" gives nothing. Only the parity makes the lenses alternate.
 *
 * **And its bands must be aligned.** Offsetting band `j` by half a step (`j * pi / PETALS`) looks like the
 * ingredient that makes the bands interlock and is not: it produces a swirl. Offsetting by a whole step does
 * nothing at all, because `PETALS` circles one step apart are the same `PETALS` circles. There are only those
 * two cases, and the aligned one is the figure this wants.
 *
 * **One unit, everywhere, and that is the thing that has already gone wrong here once.** Every distance in this
 * file is a fraction of the image's own inscribed radius: `1` is the rim, `0` the centre. The previous version of
 * the band mask compared a distance in those fractions against a radius in *pixels*, which silently skipped
 * every pixel there is — a fully transparent texture, a ring with nothing on it, and no error anywhere. That is
 * why every painter here returns the number of pixels it inked: **zero is never a setting, it is a bug**, and the
 * caller refuses it rather than drawing nothing.
 */

/** The halo: a radial gradient, brightest at the centre and gone by the rim. */
export interface RingHaloParameters {
	/** The image is this many pixels square, and the glow is inscribed in it. */
	readonly RESOLUTION: number;

	/** How sharply the glow gives way: `1` is a cone from the middle, higher is tighter to the centre. */
	readonly FALLOFF: number;
}

/** The band and the rosette on it. Both distances are fractions of the image's own inscribed radius. */
export interface RingBandParameters {
	/** The image is this many pixels square, and the band's outer edge is the rim of it. */
	readonly RESOLUTION: number;

	/** Where the band starts, as a fraction of its outer edge. The hole in the middle is `1` minus this. */
	readonly INNER_RADIUS: number;

	/**
	 * The band's opacity at the hole, as a fraction of its opacity at the rim.
	 *
	 * **This is what makes the band a turned edge rather than a flat sticker.** At `1` the band is one flat
	 * strength from hole to rim, which reads as a coloured cut-out; lower, and the ring is dimmer inside and full
	 * strength at its outer edge, which is how a rim catches light. The pixels are still white — the tint is the
	 * caller's — so this is purely how much of the colour comes through where.
	 */
	readonly INNER_ALPHA: number;

	/** The rosette's ink as a fraction of the band's opacity. Low is a texture; high is a pattern. */
	readonly PATTERN_CONTRAST: number;

	/** How many circles are in each ring of the rosette — the petal count. */
	readonly PETALS: number;

	/** How many rings of circles the rosette has, counted outward from the centre. */
	readonly BANDS: number;

	/** The rosette's circles' radius, as a fraction of their distance from the centre. */
	readonly CIRCLE_RATIO: number;

	/** Whether odd coverage is the figure's ink. False draws it in negative. */
	readonly ODD_IS_INK: boolean;

	/**
	 * How many triangles point inward from the band, or `0` for none.
	 *
	 * **These are the ring's teeth.** Their bases sit on the band, apexes at the centre's direction, and they are
	 * what makes a thin outline read as something made rather than as something drawn — a bare circle has no scale
	 * and no direction, and a ring of teeth has both.
	 */
	readonly TRIANGLES: number;

	/** How far inward a triangle reaches from the band, as a fraction of the picture's rim radius. */
	readonly TRIANGLE_DEPTH: number;

	/** How much of the gap between two neighbours each triangle fills at its base, `0` to `1`. */
	readonly TRIANGLE_SPREAD: number;

	/** A triangle's opacity where it meets the band. It fades to nothing at its apex. */
	readonly TRIANGLE_ALPHA: number;
}

/**
 * What the band's image received, so that a layer which drew nothing can be reported rather than guessed at.
 *
 * `band` counts the pixels the solid band inked, `pattern` the ones the rosette overwrote with its own opacity, and
 * `triangles` the ones the teeth added. They are separate because "the outline is missing", "the figure is missing"
 * and "the teeth are missing" are three different faults with three different causes, and one total would hide two
 * of them inside the third.
 */
export interface RingBandInk {
	readonly band: number;
	readonly pattern: number;
	readonly triangles: number;
}

/** White, and the alpha that means "as opaque as the image gets". */
const FULL = 255;

/**
 * Writes one white pixel at `alpha`.
 *
 * Declared above its callers rather than at the bottom of the file, which is this project's rule for a module:
 * roblox-ts emits a forward declaration at the top and the body at its source position, so a function defined
 * below its first *call* is a `nil` call if that call happens while the module is being required. Nothing here
 * does that, and keeping the order obvious means nothing later can start.
 */
function writeInk(pixels: buffer, offset: number, alpha: number): void {
	buffer.writeu8(pixels, offset, FULL);
	buffer.writeu8(pixels, offset + 1, FULL);
	buffer.writeu8(pixels, offset + 2, FULL);
	buffer.writeu8(pixels, offset + 3, alpha);
}

/**
 * Draws the halo into `pixels`, and answers how many pixels it inked.
 *
 * **The gradient is the point of this layer.** A glow is a falloff, not a shape: a flat translucent disc reads as
 * a grey circle, while the same disc fading to nothing by its rim reads as light — and on a floor, with bloom on
 * top of it, it reads as something being lit rather than something being painted.
 *
 * The alpha is `(1 - r) ^ FALLOFF`, which is `1` at the centre and `0` at the rim for any positive falloff, so
 * the glow never ends in a hard edge. Nothing outside the rim is written at all.
 */
export function paintHalo(pixels: buffer, parameters: RingHaloParameters): number {
	const { RESOLUTION, FALLOFF } = parameters;
	const half = RESOLUTION / 2;
	let inked = 0;

	for (let row = 0; row < RESOLUTION; row++) {
		const y = (row + 0.5 - half) / half;

		for (let column = 0; column < RESOLUTION; column++) {
			const x = (column + 0.5 - half) / half;
			const radius = math.sqrt(x * x + y * y);

			if (radius >= 1) continue;

			const alpha = math.clamp(math.round(math.pow(1 - radius, FALLOFF) * FULL), 0, FULL);
			if (alpha <= 0) continue;

			writeInk(pixels, (row * RESOLUTION + column) * 4, alpha);

			inked++;
		}
	}

	return inked;
}

/**
 * Draws the band and the rosette on it into `pixels`, and answers what each of the two inked.
 *
 * **The rosette is drawn *into* the band, at lower opacity, and that is what makes it a texture.** It is not a
 * second layer sitting on top: a band pixel the figure covers is rewritten at `PATTERN_CONTRAST` of the band's
 * opacity, so the figure shows as the floor coming through the band slightly more. That reads as detail in the
 * band rather than as a second, competing shape — which is what the version that drew the figure at full
 * opacity got wrong.
 *
 * The band's outer edge is the rim of the image and its inner edge is `INNER_RADIUS`, so the caller sets the
 * hole by sizing the part and choosing the two radii in studs; nothing here knows about studs at all.
 */
export function paintRing(pixels: buffer, parameters: RingBandParameters): RingBandInk {
	const {
		RESOLUTION,
		INNER_RADIUS,
		INNER_ALPHA,
		PATTERN_CONTRAST,
		PETALS,
		BANDS,
		CIRCLE_RATIO,
		ODD_IS_INK,
		TRIANGLES,
		TRIANGLE_DEPTH,
		TRIANGLE_SPREAD,
		TRIANGLE_ALPHA,
	} = parameters;
	const half = RESOLUTION / 2;
	const innerSquared = INNER_RADIUS * INNER_RADIUS;

	// **The bevel: how much of the band's strength shows at this radius.** `0` at the hole, `1` at the rim, and
	// `INNER_ALPHA` is the dimmest it gets — which is the whole difference between a turned rim and a flat
	// coloured cut-out. Both passes below use this same function, so the figure's contrast is the same fraction of
	// the band's at every radius rather than drifting across them.
	const shadeOf = (distanceSquared: number) => {
		const depth = (math.sqrt(distanceSquared) - INNER_RADIUS) / (1 - INNER_RADIUS);

		return INNER_ALPHA + (1 - INNER_ALPHA) * math.clamp(depth, 0, 1);
	};

	// The band first, as a solid annulus: pixels inside the rim and outside the hole.
	let band = 0;

	for (let row = 0; row < RESOLUTION; row++) {
		const y = (row + 0.5 - half) / half;

		for (let column = 0; column < RESOLUTION; column++) {
			const x = (column + 0.5 - half) / half;
			const distance = x * x + y * y;

			if (distance > 1) continue;
			if (distance < innerSquared) continue;

			writeInk(pixels, (row * RESOLUTION + column) * 4, math.round(FULL * shadeOf(distance)));

			band++;
		}
	}

	// The rosette: one parity flag per pixel, toggled once per circle that covers it. See the file doc for why
	// the parity and not a count — a count is never read, and would be more work for the same answer.
	const parity = buffer.create(RESOLUTION * RESOLUTION);
	const reach = (1 + CIRCLE_RATIO) * BANDS;
	const toPixel = (fraction: number) => fraction * half + half - 0.5;

	for (let index = 1; index <= BANDS; index++) {
		const distance = index / reach;
		const radius = (CIRCLE_RATIO * index) / reach;

		for (let petal = 0; petal < PETALS; petal++) {
			const angle = (2 * math.pi * petal) / PETALS;
			const centreX = distance * math.cos(angle);
			const centreY = distance * math.sin(angle);

			// Only the pixels inside this circle's own box are visited, which is what keeps the figure to a few
			// hundred thousand tests rather than a few million: one circle covers a fraction of one band.
			const left = math.max(0, math.ceil(toPixel(centreX - radius)));
			const right = math.min(RESOLUTION - 1, math.floor(toPixel(centreX + radius)));
			const top = math.max(0, math.ceil(toPixel(centreY - radius)));
			const bottom = math.min(RESOLUTION - 1, math.floor(toPixel(centreY + radius)));
			const radiusSquared = radius * radius;

			for (let row = top; row <= bottom; row++) {
				const dy = (row + 0.5 - half) / half - centreY;
				const rowOffset = row * RESOLUTION;

				for (let column = left; column <= right; column++) {
					const dx = (column + 0.5 - half) / half - centreX;
					if (dx * dx + dy * dy > radiusSquared) continue;

					const pixel = rowOffset + column;

					buffer.writeu8(parity, pixel, buffer.readu8(parity, pixel) === 0 ? 1 : 0);
				}
			}
		}
	}

	let pattern = 0;
	const ink = ODD_IS_INK ? 1 : 0;

	for (let row = 0; row < RESOLUTION; row++) {
		const y = (row + 0.5 - half) / half;

		for (let column = 0; column < RESOLUTION; column++) {
			const x = (column + 0.5 - half) / half;
			const distance = x * x + y * y;

			if (distance > 1) continue;
			if (distance < innerSquared) continue;

			const pixel = row * RESOLUTION + column;
			if (buffer.readu8(parity, pixel) !== ink) continue;

			// **The figure is a fraction of the band *at this radius*** rather than a flat strength of its own, so
			// the bevel runs through it: the petals are dimmer inside and brighter at the rim exactly as the band
			// under them is, and the two cannot come apart at some radius the eye reads as a seam.
			writeInk(pixels, pixel * 4, math.round(FULL * shadeOf(distance) * PATTERN_CONTRAST));

			pattern++;
		}
	}

	// The teeth: `TRIANGLES` of them, bases on the outline's inner edge, apexes toward the centre. In polar terms a
	// triangle is an angle that widens with radius, from nothing at the apex to its full width at the base — which
	// is why this pass is an `atan2` and a comparison rather than any geometry.
	let triangles = 0;
	const apex = INNER_RADIUS - TRIANGLE_DEPTH;

	if (TRIANGLES > 0 && TRIANGLE_DEPTH > 0 && apex > 0) {
		const step = (2 * math.pi) / TRIANGLES;
		const spread = math.clamp(TRIANGLE_SPREAD, 0, 1) * step;
		const apexSquared = apex * apex;

		for (let row = 0; row < RESOLUTION; row++) {
			const y = (row + 0.5 - half) / half;

			for (let column = 0; column < RESOLUTION; column++) {
				const x = (column + 0.5 - half) / half;
				const distance = x * x + y * y;

				if (distance > innerSquared) continue;
				if (distance < apexSquared) continue;

				const radius = math.sqrt(distance);
				const depth = (radius - apex) / (INNER_RADIUS - apex);

				// How far this pixel is from the nearest tooth's centreline, against how wide the tooth is here.
				const angle = math.atan2(y, x);
				const offset = math.abs(angle - math.round(angle / step) * step);
				if (offset > (spread * depth) / 2) continue;

				writeInk(pixels, (row * RESOLUTION + column) * 4, math.round(FULL * TRIANGLE_ALPHA * depth));

				triangles++;
			}
		}
	}

	return { band: band, pattern: pattern, triangles: triangles };
}
