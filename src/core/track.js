// Following what is under a box from frame to frame, for a hidden area that
// stays on what it hides when the window scrolls or moves (the "follow"
// option of a blur annotation, docs/EDITOR-V2.md).
//
// Pure arithmetic on greyscale pictures; the frames are decoded and scaled
// down by whoever calls this (src/renderer/exporter/tracker.js).
//
//   const tracker = createTracker({ width, height });
//   tracker.start(luma, { x, y, w, h })   -> { x, y, detail }
//   tracker.step(luma)                    -> { x, y, score }
//
// `luma` is width * height brightness values (0..255), row by row. The box is
// in the same pixels. start() remembers the picture under the box; each step
// looks for it within SEARCH_PX of where it was last (block matching: the
// place with the smallest average difference wins) and reports the box's new
// top-left corner. It moves by whole pixels, so the pictures should be big
// enough that one pixel is a small step.
//
// `score` is 1 for a perfect match and falls to 0 as the difference nears
// how much the remembered picture itself varies; under LOST_SCORE what was
// there is gone (it scrolled out, or something covered it). `detail` is how
// much the picture under the box varies at all: under MIN_DETAIL there is
// nothing to hold on to (a blank area matches everywhere).
//
// The remembered picture is refreshed a little with every good match, so a
// slow change (a highlight, a blinking caret, text being typed) is followed
// rather than lost.
//
// Also here, because the path the tracker makes is stored on the annotation:
//   simplifyPath(points, tolerance)  thins per-frame positions to keyframes
//   positionAt(path, t)              where the box is at source time t
//   shiftPath(path, dx, dy)          the whole path moved by an offset

export const SEARCH_PX = 48;
export const LOST_SCORE = 0.5;
export const MIN_DETAIL = 3;
// How much of each good match is mixed into the remembered picture.
export const REFRESH = 0.06;
// A match this good or better refreshes the remembered picture.
const REFRESH_SCORE = 0.75;
// At most this many points of the box are compared per place tried (a grid
// over the box), so a large box costs no more than a small one.
const MAX_SAMPLES = 1600;
const MIN_BOX_PX = 4;
// A match this close to the remembered picture (as a share of how much that
// picture varies), found within NEAR_PX of where it was expected, is taken
// without looking any further.
const NEAR_PX = 4;
const NEAR_ENOUGH = 0.35;
// The most keyframes a stored path may have (core/project.js checks it).
export const MAX_PATH_POINTS = 600;

export function createTracker({ width, height, search = SEARCH_PX }) {
  if (!(Number.isInteger(width) && Number.isInteger(height) && width > 0 && height > 0)) {
    throw new Error('The tracker needs a picture size.');
  }
  let template = null; // Float32Array, tw * th
  let tw = 0;
  let th = 0;
  let step = 1; // the sample grid's spacing
  let spread = 1; // how much the template varies (mean distance from its mean)
  let px = 0; // where the template was last found (whole pixels)
  let py = 0;
  let vx = 0; // how far it moved in the last step
  let vy = 0;
  let offX = 0; // box top-left minus template top-left
  let offY = 0;

  function measureSpread() {
    let sum = 0;
    for (let i = 0; i < template.length; i++) sum += template[i];
    const mean = sum / template.length;
    let dev = 0;
    for (let i = 0; i < template.length; i++) dev += Math.abs(template[i] - mean);
    return dev / template.length;
  }

  // The summed difference between the template and the picture at (x, y),
  // over a grid of every `stride`-th point (each row of the grid starts a
  // little further along, so a regular pattern can't hide between the
  // points); gives up once it passes `limit`.
  function difference(luma, x, y, limit, stride) {
    let sum = 0;
    for (let j = 0, r = 0; j < th; j += stride, r++) {
      const row = (y + j) * width + x;
      const trow = j * tw;
      for (let i = (r * 3) % stride; i < tw; i += stride) {
        const d = luma[row + i] - template[trow + i];
        sum += d < 0 ? -d : d;
      }
      if (sum > limit) return sum;
    }
    return sum;
  }

  // How many points that grid has.
  function gridSize(stride) {
    let n = 0;
    for (let j = 0, r = 0; j < th; j += stride, r++) n += Math.ceil((tw - ((r * 3) % stride)) / stride);
    return n;
  }

  function start(luma, rect) {
    if (luma.length < width * height) throw new Error('The picture is smaller than the tracker was made for.');
    const x0 = Math.max(0, Math.round(rect.x));
    const y0 = Math.max(0, Math.round(rect.y));
    const x1 = Math.min(width, Math.round(rect.x + rect.w));
    const y1 = Math.min(height, Math.round(rect.y + rect.h));
    tw = x1 - x0;
    th = y1 - y0;
    if (tw < MIN_BOX_PX || th < MIN_BOX_PX) {
      template = null;
      return { x: rect.x, y: rect.y, detail: 0 };
    }
    template = new Float32Array(tw * th);
    for (let j = 0; j < th; j++) {
      for (let i = 0; i < tw; i++) template[j * tw + i] = luma[(y0 + j) * width + x0 + i];
    }
    step = Math.max(1, Math.ceil(Math.sqrt((tw * th) / MAX_SAMPLES)));
    spread = measureSpread();
    px = x0;
    py = y0;
    vx = 0;
    vy = 0;
    offX = rect.x - x0;
    offY = rect.y - y0;
    return { x: rect.x, y: rect.y, detail: spread };
  }

  // The best place among x0..x1, y0..y1 on the grid, starting from (sx, sy):
  // only a clearly better place replaces it, so a still picture never makes
  // the box wander.
  // (gx, gy), when given, is a guess tried next -- where it would be had it
  // kept moving as it last did -- so that most other places are given up on
  // after a few rows.
  function best(luma, sx, sy, x0, x1, y0, y1, stride, gx = sx, gy = sy) {
    const margin = gridSize(stride) * 0.25;
    let low = difference(luma, sx, sy, Infinity, stride);
    let bx = sx;
    let by = sy;
    if ((gx !== sx || gy !== sy) && gx >= x0 && gx <= x1 && gy >= y0 && gy <= y1) {
      const d = difference(luma, gx, gy, low - margin, stride);
      if (d < low - margin) { low = d; bx = gx; by = gy; }
    }
    for (let y = y0; y <= y1 && low > 0; y++) {
      for (let x = x0; x <= x1; x++) {
        if (x === sx && y === sy) continue;
        const d = difference(luma, x, y, low - margin, stride);
        if (d < low - margin) { low = d; bx = x; by = y; }
      }
    }
    return { x: bx, y: by, low };
  }

  function stepTo(luma) {
    if (!template) return { x: px + offX, y: py + offY, score: 0 };
    const minX = Math.max(0, px - search);
    const maxX = Math.min(width - tw, px + search);
    const minY = Math.max(0, py - search);
    const maxY = Math.min(height - th, py + search);
    // Roughly: first just around where it would be had it kept moving as it
    // last did, and, unless that is a good match already, everywhere in
    // reach. Then exactly, around the rough answer.
    const gx = Math.max(minX, Math.min(maxX, px + vx));
    const gy = Math.max(minY, Math.min(maxY, py + vy));
    let found = best(luma, px, py, Math.max(minX, gx - NEAR_PX), Math.min(maxX, gx + NEAR_PX),
      Math.max(minY, gy - NEAR_PX), Math.min(maxY, gy + NEAR_PX), step, gx, gy);
    if (found.low / gridSize(step) > NEAR_ENOUGH * Math.max(spread, MIN_DETAIL)) {
      found = best(luma, px, py, minX, maxX, minY, maxY, step, found.x, found.y);
    }
    if (step > 1) {
      const near = Math.abs(found.x - px) <= step && Math.abs(found.y - py) <= step;
      found = best(luma, near ? px : found.x, near ? py : found.y,
        Math.max(minX, found.x - step), Math.min(maxX, found.x + step),
        Math.max(minY, found.y - step), Math.min(maxY, found.y + step), 1);
    }
    const mad = found.low / gridSize(step > 1 ? 1 : step);
    const score = Math.max(0, 1 - mad / Math.max(spread, MIN_DETAIL));
    if (score < LOST_SCORE) return { x: px + offX, y: py + offY, score };
    vx = found.x - px;
    vy = found.y - py;
    px = found.x;
    py = found.y;
    if (score >= REFRESH_SCORE) {
      for (let j = 0; j < th; j++) {
        const row = (py + j) * width + px;
        const trow = j * tw;
        for (let i = 0; i < tw; i++) template[trow + i] += (luma[row + i] - template[trow + i]) * REFRESH;
      }
      spread = measureSpread();
    }
    return { x: px + offX, y: py + offY, score };
  }

  return { start, step: stepTo };
}

// ---------------------------------------------------------------- paths

// Where a followed box is at source time t: between the two keyframes around
// t, in a straight line; before the first or after the last, it stays there.
// `path` is [{ t, x, y }] in time order.
export function positionAt(path, t) {
  const n = path.length;
  if (t <= path[0].t) return { x: path[0].x, y: path[0].y };
  if (t >= path[n - 1].t) return { x: path[n - 1].x, y: path[n - 1].y };
  let lo = 0;
  let hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (path[mid].t <= t) lo = mid;
    else hi = mid;
  }
  const a = path[lo];
  const b = path[hi];
  const k = b.t > a.t ? (t - a.t) / (b.t - a.t) : 0;
  return { x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k };
}

export function shiftPath(path, dx, dy) {
  return path.map((p) => ({ t: p.t, x: p.x + dx, y: p.y + dy }));
}

function thin(points, tolerance) {
  const n = points.length;
  const keep = new Uint8Array(n);
  keep[0] = 1;
  keep[n - 1] = 1;
  const stack = [[0, n - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    if (b - a < 2) continue;
    const pa = points[a];
    const pb = points[b];
    const span = pb.t - pa.t;
    let worst = 0;
    let at = -1;
    for (let i = a + 1; i < b; i++) {
      const k = span > 0 ? (points[i].t - pa.t) / span : 0;
      const d = Math.hypot(points[i].x - (pa.x + (pb.x - pa.x) * k), points[i].y - (pa.y + (pb.y - pa.y) * k));
      if (d > worst) { worst = d; at = i; }
    }
    if (worst > tolerance) {
      keep[at] = 1;
      stack.push([a, at], [at, b]);
    }
  }
  return points.filter((p, i) => keep[i]);
}

// The fewest of `points` ([{ t, x, y }], in time order) that still put the
// box within `tolerance` of every one of them when played back with
// positionAt. The first and last are always kept. With `max`, the tolerance
// is widened until no more than that many are left.
export function simplifyPath(points, tolerance, { max = Infinity } = {}) {
  if (points.length <= 2) return points.map((p) => ({ t: p.t, x: p.x, y: p.y }));
  let tol = Math.max(0, tolerance);
  let out = thin(points, tol);
  for (let i = 0; out.length > max && i < 40; i++) {
    tol = tol > 0 ? tol * 2 : 1e-6;
    out = thin(points, tol);
  }
  if (out.length > max) {
    // Still too many (a path that never settles): keep evenly spaced ones.
    const every = (out.length - 1) / (max - 1);
    out = Array.from({ length: max }, (_, i) => out[Math.round(i * every)]);
  }
  return out.map((p) => ({ t: p.t, x: p.x, y: p.y }));
}
