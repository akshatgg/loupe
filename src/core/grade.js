// A clip's finer colour tools (clip.color, beside look.js's brightness,
// contrast, saturation, preset looks and LUT; all optional, 0 = as recorded):
//
//   temperature  -1 colder (bluer) .. 1 warmer (redder)
//   tint         -1 greener .. 1 more magenta
//   highlights   -1 darker .. 1 brighter, on the bright parts only
//   shadows      -1 darker .. 1 brighter, on the dark parts only
//   curve        up to 8 points [{ x, y }] (0..1, left to right) that every
//                channel's value goes through: x in, y out; null = straight
//   sharpen      0..1: edges made crisper
//   vignette     0..1: the corners darkened
//
// The maths here is the reference: layers/lut-gl.js does gradePixel in one
// shader pass (and adds the sharpening, which needs a pixel's neighbours);
// layers/frame.js draws the dark corners over the picture from
// vignetteStops. In order: white balance, shadows and highlights, the curve
// -- then the LUT, if any.

export const MAX_CURVE_POINTS = 8;
export const IDENTITY_CURVE = [{ x: 0, y: 0 }, { x: 1, y: 1 }];
// How far a full shadows / highlights slider moves the parts it is for.
export const TONE_REACH = 0.4;
// How much of a pixel's difference from its neighbours full sharpening adds.
export const SHARPEN_REACH = 1.5;

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

// Brightness as the eye weighs red, green and blue (Rec. 709).
export const LUMA = [0.2126, 0.7152, 0.0722];
export const luma = ([r, g, b]) => LUMA[0] * r + LUMA[1] * g + LUMA[2] * b;

// ---- the curve

export function curvePoints(curve) {
  return Array.isArray(curve) && curve.length >= 2 ? curve : IDENTITY_CURVE;
}

export function isIdentityCurve(curve) {
  return curvePoints(curve).every((p) => Math.abs(p.x - p.y) < 1e-9);
}

// The slope at each point of a monotone cubic through them (Fritsch and
// Carlson): smooth like a spline, but never dipping or overshooting between
// two points, so a curve that rises stays rising.
const slopeCache = new WeakMap();
function slopes(points) {
  let m = slopeCache.get(points);
  if (m) return m;
  const n = points.length;
  const d = [];
  for (let i = 0; i < n - 1; i++) d.push((points[i + 1].y - points[i].y) / (points[i + 1].x - points[i].x));
  m = new Array(n);
  m[0] = d[0];
  m[n - 1] = d[n - 2];
  for (let i = 1; i < n - 1; i++) m[i] = d[i - 1] * d[i] <= 0 ? 0 : (d[i - 1] + d[i]) / 2;
  for (let i = 0; i < n - 1; i++) {
    if (d[i] === 0) { m[i] = 0; m[i + 1] = 0; continue; }
    const a = m[i] / d[i];
    const b = m[i + 1] / d[i];
    const s = a * a + b * b;
    if (s > 9) {
      const t = 3 / Math.sqrt(s);
      m[i] = t * a * d[i];
      m[i + 1] = t * b * d[i];
    }
  }
  slopeCache.set(points, m);
  return m;
}

// The curve's height at x (0..1): flat left of its first point and right of
// its last.
export function evalCurve(curve, x) {
  const points = curvePoints(curve);
  const n = points.length;
  if (x <= points[0].x) return points[0].y;
  if (x >= points[n - 1].x) return points[n - 1].y;
  let i = 0;
  while (i < n - 2 && x > points[i + 1].x) i++;
  const p0 = points[i];
  const p1 = points[i + 1];
  const w = p1.x - p0.x;
  const t = (x - p0.x) / w;
  const m = slopes(points);
  const t2 = t * t;
  const t3 = t2 * t;
  const y = (2 * t3 - 3 * t2 + 1) * p0.y + (t3 - 2 * t2 + t) * w * m[i] +
    (-2 * t3 + 3 * t2) * p1.y + (t3 - t2) * w * m[i + 1];
  return clamp01(y);
}

// The curve as n heights for inputs 0..1 (what the shader looks up).
const tableCache = new WeakMap();
export function curveTable(curve, n = 256) {
  const points = curvePoints(curve);
  const hit = tableCache.get(points);
  if (hit && hit.length === n) return hit;
  const table = new Float32Array(n);
  for (let i = 0; i < n; i++) table[i] = evalCurve(points, i / (n - 1));
  tableCache.set(points, table);
  return table;
}

// Editing it (the curve editor in the Clip panel). Points keep this far
// apart, so they stay in order.
const GAP = 0.01;
const tidy = (v) => Math.round(clamp01(v) * 1000) / 1000;

// A point added at (x, y): { points, index }, or null when there are already
// 8 or one sits there.
export function addCurvePoint(curve, x, y) {
  const points = curvePoints(curve);
  if (points.length >= MAX_CURVE_POINTS) return null;
  const px = tidy(x);
  if (points.some((p) => Math.abs(p.x - px) < GAP)) return null;
  const index = points.findIndex((p) => p.x > px);
  const at = index < 0 ? points.length : index;
  const next = points.map((p) => ({ ...p }));
  next.splice(at, 0, { x: px, y: tidy(y) });
  return { points: next, index: at };
}

// Point i moved to (x, y): kept between its neighbours; the first and last
// move up and down only.
export function moveCurvePoint(curve, i, x, y) {
  const points = curvePoints(curve).map((p) => ({ ...p }));
  const last = points.length - 1;
  if (i < 0 || i > last) return points;
  if (i > 0 && i < last) points[i].x = tidy(Math.max(points[i - 1].x + GAP, Math.min(points[i + 1].x - GAP, x)));
  points[i].y = tidy(y);
  return points;
}

// Without point i; the first and last stay.
export function removeCurvePoint(curve, i) {
  const points = curvePoints(curve);
  if (i <= 0 || i >= points.length - 1) return points;
  return points.filter((_, k) => k !== i);
}

// ---- warmth and tint

// What red, green and blue are each multiplied by (the diagonal of the
// colour matrix), scaled so a grey stays as bright as it was.
export function whiteBalance(temperature = 0, tint = 0) {
  if (!temperature && !tint) return [1, 1, 1];
  const g = [1 + 0.3 * temperature + 0.1 * tint, 1 - 0.3 * tint, 1 - 0.3 * temperature + 0.1 * tint];
  const l = luma(g);
  return g.map((v) => v / l);
}

// ---- shadows and highlights

// How much of each a pixel of brightness l (0..1) is: dark pixels are all
// shadow, bright ones all highlight, the middle hardly either.
export function toneWeights(l) {
  const v = clamp01(l);
  return { shadows: (1 - v) * (1 - v), highlights: v * v };
}

// ---- together

// Whether a colour has anything for the shader pass to do (the dark corners
// are drawn over the picture instead).
export function needsGrade(color) {
  if (!color) return false;
  return Boolean(color.temperature || color.tint || color.highlights || color.shadows || color.sharpen) ||
    !isIdentityCurve(color.curve);
}

// One pixel [r, g, b] (0..1) through the colour: the reference the shader
// mirrors. (Sharpening is not here: it needs the pixel's neighbours.)
export function gradePixel(rgb, color) {
  const gains = whiteBalance(color?.temperature ?? 0, color?.tint ?? 0);
  let out = [rgb[0] * gains[0], rgb[1] * gains[1], rgb[2] * gains[2]];
  const shadows = color?.shadows ?? 0;
  const highlights = color?.highlights ?? 0;
  if (shadows || highlights) {
    const w = toneWeights(luma(out));
    const lift = TONE_REACH * (shadows * w.shadows + highlights * w.highlights);
    out = out.map((v) => v + lift);
  }
  out = out.map(clamp01);
  if (!isIdentityCurve(color?.curve)) out = out.map((v) => evalCurve(color.curve, v));
  return out;
}

// ---- dark corners

// The stops of a radial gradient of black from the picture's middle (0) to
// its corners (1): [[where, how dark], ...]; none when off.
export function vignetteStops(amount) {
  if (!(amount > 0)) return [];
  const a = Math.min(1, amount);
  return [[0.35, 0], [0.6, 0.12 * a], [0.8, 0.4 * a], [1, 0.85 * a]];
}

// ---- the histogram

// How many pixels of RGBA bytes are at each of `bins` brightnesses, dark to
// bright.
export function histogram(data, bins = 64) {
  const out = new Uint32Array(bins);
  for (let i = 0; i + 3 < data.length; i += 4) {
    const l = (LUMA[0] * data[i] + LUMA[1] * data[i + 1] + LUMA[2] * data[i + 2]) / 255;
    out[Math.min(bins - 1, Math.floor(l * bins))]++;
  }
  return out;
}
