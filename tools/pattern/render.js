// Standalone pattern renderer — a diagnostic, not part of the game build.
//
// Renders a circle-of-circles construction to a PNG so the geometry can be *looked at* rather than
// argued about. Run with `node tools/pattern/render.js`, then open the files it writes.
//
// No dependencies: the PNG is written by hand (zlib is in Node, the rest is the format's four
// chunks). Everything is 8-bit greyscale, which is all this needs.

const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

const CRC_TABLE = (() => {
	const table = new Int32Array(256);
	for (let n = 0; n < 256; n++) {
		let c = n;
		for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
		table[n] = c;
	}
	return table;
})();

function crc32(buf) {
	let c = 0xffffffff;
	for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
	return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
	const head = Buffer.alloc(8);
	head.writeUInt32BE(data.length, 0);
	head.write(type, 4, "ascii");
	const crc = Buffer.alloc(4);
	crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
	return Buffer.concat([head, data, crc]);
}

function writePng(file, width, height, gray) {
	const raw = Buffer.alloc((width + 1) * height);
	for (let y = 0; y < height; y++) {
		raw[y * (width + 1)] = 0; // filter: none
		for (let x = 0; x < width; x++) raw[y * (width + 1) + 1 + x] = gray[y * width + x];
	}

	const ihdr = Buffer.alloc(13);
	ihdr.writeUInt32BE(width, 0);
	ihdr.writeUInt32BE(height, 4);
	ihdr[8] = 8; // bit depth
	ihdr[9] = 0; // colour type: greyscale
	fs.writeFileSync(
		file,
		Buffer.concat([
			Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
			chunk("IHDR", ihdr),
			chunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
			chunk("IEND", Buffer.alloc(0)),
		]),
	);
}

/**
 * The construction under test.
 *
 * Layer `j` is a ring of `N` circles: every circle is radius `b*j` with its centre `a*j` from the origin,
 * at angle `2*pi*k/N + phase(j)`. A pixel is black when the number of circles containing it is **odd** —
 * the even-odd rule, which is what makes the lenses alternate rather than merge into blobs.
 *
 * `rgba` changes the *encoding* and nothing else: with it the ink is white on transparent, which is what the
 * ring's texture needs; without it the ink is black on white, which is what can actually be looked at in a
 * viewer. Both come out of the same parity test, so a proof read off one is a proof of the other.
 */
function render(size, opts) {
	const {
		N,
		a,
		b,
		layers,
		phase = () => 0,
		oddIsBlack = true,
		geometric = false,
		growth = 0.75,
		clipScale = 1,
		hole = 0,
		rgba = false,
	} = opts;

	// Two scaling laws. Linear: band j is at radius a*j with circles of radius b*j, so the pattern is
	// self-similar only in the sense that every band has the same shape. Geometric: band j is the whole
	// pattern scaled by growth^j, which gives a fixed number of *visible* bands and a clean centre.
	const scaleOf = (j) => (geometric ? Math.pow(growth, j) : j);

	// The world is scaled so the whole pattern fits: the outermost band reaches (a + b) * scaleOf(top).
	const top = geometric ? layers - 1 : layers;
	const outer = (a + b) * scaleOf(top);
	const clipR = (a + b) * scaleOf(top) * clipScale;

	// The transparent middle. Band radii are all multiples of the first band, so the figure is a continuum
	// out to its outer reach and there is no band-free centre to leave out — the hole is a *cut*, taken as a
	// fraction of that same reach so that it means the same thing whatever the band count is.
	const innerR = hole * outer;
	const toPx = (v) => ((v + outer) / (2 * outer)) * size;
	const toWorld = (px) => (px / size) * 2 * outer - outer;

	const parity = new Uint8Array(size * size);

	for (let j = geometric ? 0 : 1; j <= top; j++) {
		const s = scaleOf(j);
		const c = a * s;
		const r = b * s;
		const theta0 = phase(j);

		for (let k = 0; k < N; k++) {
			const t = (2 * Math.PI * k) / N + theta0;
			const cx = c * Math.cos(t);
			const cy = c * Math.sin(t);

			// Only the pixels inside this circle's own box are tested: with a hundred layers this is the
			// difference between a second and a minute.
			const x0 = Math.max(0, Math.floor(toPx(cx - r)));
			const x1 = Math.min(size - 1, Math.ceil(toPx(cx + r)));
			const y0 = Math.max(0, Math.floor(toPx(cy - r)));
			const y1 = Math.min(size - 1, Math.ceil(toPx(cy + r)));
			const r2 = r * r;

			for (let y = y0; y <= y1; y++) {
				const wy = toWorld(y);
				const dy = wy - cy;
				const row = y * size;
				for (let x = x0; x <= x1; x++) {
					const dx = toWorld(x) - cx;
					if (dx * dx + dy * dy <= r2) parity[row + x] ^= 1;
				}
			}
		}
	}

	// White, or black, with everything outside the two circles left alone — which for the rgba encoding means
	// `(0, 0, 0, 0)`, a transparent pixel, because a fresh `Uint8Array` is zeroed.
	const ink = oddIsBlack ? 1 : 0;
	const pixels = rgba ? new Uint8Array(size * size * 4) : new Uint8Array(size * size).fill(255);

	for (let y = 0; y < size; y++) {
		const wy = toWorld(y);
		for (let x = 0; x < size; x++) {
			const wx = toWorld(x);
			const d2 = wx * wx + wy * wy;
			if (d2 > clipR * clipR) continue; // the big circle, outside
			if (d2 < innerR * innerR) continue; // and inside, the hole
			if (parity[y * size + x] !== ink) continue;

			if (rgba) {
				const offset = (y * size + x) * 4;
				pixels[offset] = 255;
				pixels[offset + 1] = 255;
				pixels[offset + 2] = 255;
				pixels[offset + 3] = 255;
			} else {
				pixels[y * size + x] = 0;
			}
		}
	}

	return pixels;
}

/**
 * The same file, with an alpha channel — 8-bit RGBA, colour type 6, four bytes per pixel.
 *
 * This exists for one output: the ring's texture, which has to be white ink on nothing at all, because
 * `Texture.Color3` is a tint and a tint multiplies. See `ringProof` for why the thing that gets *looked at* is
 * the greyscale one instead.
 */
function writePngRgba(file, width, height, rgba) {
	const raw = Buffer.alloc((width * 4 + 1) * height);
	for (let y = 0; y < height; y++) {
		raw[y * (width * 4 + 1)] = 0; // filter: none
		for (let x = 0; x < width * 4; x++) raw[y * (width * 4 + 1) + 1 + x] = rgba[y * width * 4 + x];
	}

	const ihdr = Buffer.alloc(13);
	ihdr.writeUInt32BE(width, 0);
	ihdr.writeUInt32BE(height, 4);
	ihdr[8] = 8; // bit depth
	ihdr[9] = 6; // colour type: truecolour with alpha
	fs.writeFileSync(
		file,
		Buffer.concat([
			Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
			chunk("IHDR", ihdr),
			chunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
			chunk("IEND", Buffer.alloc(0)),
		]),
	);
}

/** Puts several renders in one image, so one look compares four candidates. */
function sheet(file, tiles, size, gap) {
	const cols = Math.ceil(Math.sqrt(tiles.length));
	const rows = Math.ceil(tiles.length / cols);
	const width = cols * size + (cols - 1) * gap;
	const height = rows * size + (rows - 1) * gap;
	const sheet = new Uint8Array(width * height).fill(200);

	tiles.forEach((tile, index) => {
		const tx = (index % cols) * (size + gap);
		const ty = Math.floor(index / cols) * (size + gap);
		for (let y = 0; y < size; y++)
			for (let x = 0; x < size; x++) sheet[(ty + y) * width + tx + x] = tile[y * size + x];
	});

	writePng(file, width, height, sheet);
}

/**
 * Box-downsamples a square render by an integer factor.
 *
 * Not a nicety: a texture on a small disc is seen minified, so the honest preview of a ring is the render
 * *after* the average, not before it. Judging one at 512 is judging something nobody will ever look at.
 */
function shrink(src, srcSize, factor) {
	const size = srcSize / factor;
	const out = new Uint8Array(size * size);

	for (let y = 0; y < size; y++) {
		for (let x = 0; x < size; x++) {
			let total = 0;
			for (let sy = 0; sy < factor; sy++)
				for (let sx = 0; sx < factor; sx++) total += src[(y * factor + sy) * srcSize + x * factor + sx];
			out[y * size + x] = Math.round(total / (factor * factor));
		}
	}

	return out;
}

const SIZE = 460;
const GAP = 8;
const out = (name) => path.join(__dirname, name);

// **Two offsets were tested, and the sweep reversed the first guess.**
//
// Half a step per band (`j*pi/N`) was expected to be the interlock ingredient. It is not: it makes
// alternating bands offset, which reads as a *rotational swirl* — pretty, but not the reference.
// The full step (`j*2*pi/N`) is a no-op on the set of angles (N circles one step apart are the same N
// circles), so it means *every band aligned*, and that is what the reference image is: radial chains
// of leaves, no swirl. Kept both so the difference can be looked at side by side.
const halfStep = (N) => (j) => j * (Math.PI / N);
const fullStep = (N) => (j) => j * ((2 * Math.PI) / N);

const candidates = [
	{ label: "N30 b0.40 L9", opts: { N: 30, a: 1, b: 0.4, layers: 9, phase: fullStep(30) } },
	{ label: "N30 b0.35 L11", opts: { N: 30, a: 1, b: 0.35, layers: 11, phase: fullStep(30) } },
	{ label: "N24 b0.40 L8", opts: { N: 24, a: 1, b: 0.4, layers: 8, phase: fullStep(24) } },
	{ label: "N30 b0.45 L10", opts: { N: 30, a: 1, b: 0.45, layers: 10, phase: fullStep(30) } },
];

sheet(
	out("candidates.png"),
	candidates.map((c) => render(SIZE, c.opts)),
	SIZE,
	GAP,
);

console.log("wrote", out("candidates.png"));
candidates.forEach((c) => console.log(" -", c.label, JSON.stringify({ ...c.opts, phase: undefined })));

// The pick from the sweeps: 30 petals, bands at radius 1,2,...9 with circles of radius 0.4,0.8,...3.6,
// all aligned, clipped to the circle of radius (a + b*L) = 4.6. Bold enough to read at any size and the
// leaves still interlock down to the centre star.
const CHOSEN = { N: 30, a: 1, b: 0.4, layers: 9, phase: fullStep(30), clipScale: 1 };

writePng(out("pattern.png"), 900, 900, render(900, CHOSEN));
console.log("wrote", out("pattern.png"), JSON.stringify({ ...CHOSEN, phase: undefined }));

// -----------------------------------------------------------------------------------------------------------
// The ring: the figure as the team ring wears it.
//
// **These numbers are kept in step by hand with `RING_CONFIG.PATTERN`**, which is what the game draws — this
// script is JavaScript and cannot import the TypeScript config, so the numbers exist in two places and the
// game's copy is the authority. The label below prints them, so comparing the two is a glance.
//
// **Two outputs for one geometry, and the difference matters.** `ring.png` is the asset: white ink on a
// transparent ground, because `Texture.Color3` is a tint and a tint multiplies. `ring-proof.png` is the *same
// parity, the same two circles* in black on white, because a white figure on a transparent ground is invisible
// in every viewer there is — so the thing that gets looked at cannot be the asset.
//
// `layers` is the knob for how much of the figure the ring wears: 2 is a clean ring of 30 petals, 4 is two rows
// of interlocking diamonds, 9 is the full lace band of the rosette. See the sheet below for all three.
const RING = { N: 30, a: 1, b: 0.4, layers: 4, hole: 0.43, clipScale: 0.98 };
const RING_RESOLUTION = 256;

/** The ring's construction with the alignment spelled out — the default phase is already the aligned one. */
const asRing = (over) => ({ ...RING, phase: fullStep(RING.N), ...over });

writePngRgba(out("ring.png"), RING_RESOLUTION, RING_RESOLUTION, render(RING_RESOLUTION, asRing({ rgba: true })));
writePng(out("ring-proof.png"), 512, 512, render(512, asRing({})));

// The choices that were open — **and read at the size the ring is actually seen at.** A six-stud disc on a floor
// is a few hundred pixels across from a playing camera and not much over a hundred from a wide one, so the
// candidates are shown here after a box downsample, which is roughly what a mipmapped texture on a small disc
// shows. The first sweep of these was judged at full size, and the band count is the knob that came out of it:
// **it is how many rows of leaves the ring wears**, and the answer has to hold up at the far end of that range
// of camera distances, which is why the pick is four rows rather than the full nine.
const ringCandidates = [
	{ label: "N30 b9 hole43 lace", opts: { layers: 9 } },
	{ label: "N30 b4 hole43 two rows", opts: { layers: 4 } },
	{ label: "N30 b2 hole43 petals", opts: { layers: 2 } },
	{ label: "N30 b9 hole55", opts: { layers: 9, hole: 0.55 } },
];

const TILE = 400;
const SHRINK = 2;

sheet(
	out("ring-candidates.png"),
	ringCandidates.map((c) => shrink(render(TILE, asRing(c.opts)), TILE, SHRINK)),
	TILE / SHRINK,
	GAP,
);

console.log("wrote", out("ring.png"), "|", out("ring-proof.png"), "|", out("ring-candidates.png"));
console.log("ring:", JSON.stringify(RING));
ringCandidates.forEach((c) => console.log(" -", c.label, JSON.stringify({ ...RING, ...c.opts })));

// -----------------------------------------------------------------------------------------------------------
// The ring as the game now draws it: a halo, a band, and the rosette inside it — composited at the config's own
// opacities over a floor, which is what the player actually sees. A single flat image cannot show this: it is
// three translucent layers, and whether it reads as light or as paint is a property of the composition.
//
// **A hand-kept copy of `RING_CONFIG`, like the numbers above it.** The script cannot import the TypeScript, so the
// config is the authority and this is the preview; the label prints what it used.
const LAYERS = {
	RESOLUTION: 256,
	HALO_RADIUS: 6,
	HALO_FALLOFF: 2,
	HALO_TRANSPARENCY: 0.7,
	HALO_COLOR: [236, 244, 255],
	RING_RADIUS: 3,
	RING_THICKNESS: 0.3,
	RING_TRANSPARENCY: 0.3,
	BAND_INNER_ALPHA: 0.45,
	PATTERN_CONTRAST: 0.55,
	TRIANGLES: 24,
	TRIANGLE_DEPTH: 1,
	TRIANGLE_SPREAD: 0.55,
	TRIANGLE_ALPHA: 0.5,
	PETALS: 16,
	BANDS: 2,
	CIRCLE_RATIO: 0.4,
};

/** `colour` over `base` at `alpha`, per channel. */
const over = (base, colour, alpha) => base.map((value, index) => value * (1 - alpha) + colour[index] * alpha);

/** Whether the rosette covers a point, in the band picture's own fractions — rim `1`, centre `0`. */
function rosetteAt(x, y, opts) {
	const reach = (1 + opts.CIRCLE_RATIO) * opts.BANDS;
	let count = 0;

	for (let band = 1; band <= opts.BANDS; band++) {
		const distance = band / reach;
		const radius = (opts.CIRCLE_RATIO * band) / reach;

		for (let petal = 0; petal < opts.PETALS; petal++) {
			const angle = (2 * Math.PI * petal) / opts.PETALS;
			const dx = x - distance * Math.cos(angle);
			const dy = y - distance * Math.sin(angle);
			if (dx * dx + dy * dy <= radius * radius) count++;
		}
	}

	return count % 2 === 1;
}

/**
 * The three layers over a floor, as greyscale so it can be looked at.
 *
 * The band's hole is `RING_RADIUS - RING_THICKNESS` of the radius; the rosette is drawn *into* the band at
 * `PATTERN_CONTRAST` of the band's own opacity, so its pixels are ones the floor shows through more — the same
 * thing the painter does, and the reason it reads as texture rather than as a second shape.
 */
function composeLayers(size, opts, team, floor) {
	const out = new Uint8Array(size * size);
	const half = size / 2;
	const inner = (opts.RING_RADIUS - opts.RING_THICKNESS) / opts.RING_RADIUS;
	const bandAlpha = 1 - opts.RING_TRANSPARENCY;
	const patternAlpha = bandAlpha * opts.PATTERN_CONTRAST;
	const background = [floor, floor, floor + 4];

	for (let row = 0; row < size; row++) {
		for (let column = 0; column < size; column++) {
			const x = (column + 0.5 - half) / half;
			const y = (row + 0.5 - half) / half;
			const radius = Math.hypot(x, y) * opts.HALO_RADIUS;

			let pixel = background;

			// 1. The halo, under everything, fading to nothing by its own radius.
			if (radius < opts.HALO_RADIUS) {
				const falloff = Math.pow(1 - radius / opts.HALO_RADIUS, opts.HALO_FALLOFF);
				pixel = over(pixel, opts.HALO_COLOR, falloff * (1 - opts.HALO_TRANSPARENCY));
			}

			// 2. The band and 3. the rosette in it, both in the band picture's fractions.
			const fraction = radius / opts.RING_RADIUS;

			if (fraction <= 1 && fraction >= inner) {
				const px = (x * opts.HALO_RADIUS) / opts.RING_RADIUS;
				const py = (y * opts.HALO_RADIUS) / opts.RING_RADIUS;

				// The bevel, the same way the painter does it: the band's strength ramps from `BAND_INNER_ALPHA` at the
				// hole to full at the rim, and the rosette is that same strength times its own contrast.
				const depth = Math.min(1, Math.max(0, (fraction - inner) / (1 - inner)));
				const shade = opts.BAND_INNER_ALPHA + (1 - opts.BAND_INNER_ALPHA) * depth;
				const alpha = (rosetteAt(px, py, opts) ? patternAlpha : bandAlpha) * shade;

				pixel = over(pixel, team, alpha);
			}

			// 4. The teeth, in the same polar terms the painter uses: an angle that widens with radius, from nothing
			// at the apex to its full width where it meets the outline.
			const apex = inner - opts.TRIANGLE_DEPTH / opts.RING_RADIUS;

			if (opts.TRIANGLES > 0 && apex > 0 && fraction <= inner && fraction >= apex) {
				const depth = (fraction - apex) / (inner - apex);
				const step = (2 * Math.PI) / opts.TRIANGLES;
				const angle = Math.atan2(y, x);
				const offset = Math.abs(angle - Math.round(angle / step) * step);

				if (offset <= (opts.TRIANGLE_SPREAD * step * depth) / 2) {
					pixel = over(pixel, team, opts.TRIANGLE_ALPHA * depth);
				}
			}

			out[row * size + column] = Math.round((pixel[0] + pixel[1] + pixel[2]) / 3);
		}
	}

	return out;
}

const PREVIEW = 320;

sheet(
	out("ring-layers.png"),
	[
		composeLayers(PREVIEW, LAYERS, [158, 58, 52], 58), // Team Elimination A, on a dark floor
		composeLayers(PREVIEW, LAYERS, [56, 92, 152], 58), // and B
		composeLayers(PREVIEW, LAYERS, [158, 58, 52], 190), // A again, on a light floor
		composeLayers(PREVIEW, LAYERS, [178, 104, 46], 190), // and Dodge and Seek's A
	],
	PREVIEW,
	GAP,
);

console.log("wrote", out("ring-layers.png"), "| halos:", JSON.stringify(LAYERS));
