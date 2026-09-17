// The parts of GIF export that are plain arithmetic on pixels (the exporter's
// gif.js does the drawing and uses the vendored gifenc for palettes and LZW):
//
//  - frame delays that add up to the video's real length (GIF delays are
//    whole hundredths of a second, so 15 fps can't be 6.67 cs every frame);
//  - mapping RGBA to a 256-colour palette, optionally with ordered dithering
//    so gradients (the default background) don't band. Ordered, not
//    error-diffusion: the same picture always dithers the same way, so still
//    stretches don't shimmer from frame to frame;
//  - deciding when the picture has changed enough (a new scene) to need a
//    new palette;
//  - frame differencing: only pixels that changed are drawn again, the rest
//    are transparent, and a frame with no change is merged into the one
//    before.

// 4x4 Bayer matrix, values 0..15.
const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];
// How far dithering may push a channel either way. About the gap between
// neighbouring colours of a 256-colour palette spread over a gradient.
const DITHER_SPREAD = 20;

// Centiseconds for a frame showing output frames [from, to) at `fps`.
// Rounding the running total, not each frame, keeps the sum exact.
export function delayCs(from, to, fps) {
  return Math.round((to * 100) / fps) - Math.round((from * 100) / fps);
}

// Nearest palette index for every 15-bit colour, filled in as needed.
// palette: [[r, g, b], ...]
export function createColorMap(palette) {
  const cache = new Int16Array(32768).fill(-1);
  const flat = new Int32Array(palette.length * 3);
  palette.forEach((c, i) => { flat[i * 3] = c[0]; flat[i * 3 + 1] = c[1]; flat[i * 3 + 2] = c[2]; });
  const n = palette.length;

  function search(r, g, b) {
    let best = 0;
    let bestD = Infinity;
    for (let i = 0; i < n; i++) {
      const dr = flat[i * 3] - r;
      const dg = flat[i * 3 + 1] - g;
      const db = flat[i * 3 + 2] - b;
      const d = dr * dr + dg * dg + db * db;
      if (d < bestD) { bestD = d; best = i; }
    }
    return best;
  }

  // r, g, b are 0..255 (already clamped).
  function index(r, g, b) {
    const key = (r >> 3) << 10 | (g >> 3) << 5 | (b >> 3);
    let i = cache[key];
    if (i < 0) {
      // The middle of the 8x8x8 cell stands for all of it.
      i = search((r >> 3) * 8 + 4, (g >> 3) * 8 + 4, (b >> 3) * 8 + 4);
      cache[key] = i;
    }
    return i;
  }

  // Squared distance from a colour to its palette entry.
  function error(r, g, b) {
    const i = index(r, g, b);
    const dr = flat[i * 3] - r;
    const dg = flat[i * 3 + 1] - g;
    const db = flat[i * 3 + 2] - b;
    return dr * dr + dg * dg + db * db;
  }

  return { palette, index, error };
}

const clamp = (v) => (v < 0 ? 0 : v > 255 ? 255 : v);

// RGBA (Uint8ClampedArray / Uint8Array) -> Uint8Array of palette indices.
export function mapToPalette(rgba, width, height, map, { dither = false, out = null } = {}) {
  const index = out ?? new Uint8Array(width * height);
  let p = 0;
  for (let y = 0; y < height; y++) {
    const row = (y & 3) << 2;
    for (let x = 0; x < width; x++, p++) {
      const o = p * 4;
      if (dither) {
        const d = ((BAYER[row | (x & 3)] + 0.5) / 16 - 0.5) * DITHER_SPREAD;
        index[p] = map.index(clamp(Math.round(rgba[o] + d)), clamp(Math.round(rgba[o + 1] + d)), clamp(Math.round(rgba[o + 2] + d)));
      } else {
        index[p] = map.index(rgba[o], rgba[o + 1], rgba[o + 2]);
      }
    }
  }
  return index;
}

// Average colour distance (0..441) from a sample of the picture's pixels to
// the palette: small while the palette still suits the picture, large once
// something new is on screen.
export function paletteError(rgba, map, { step = 61 } = {}) {
  let sum = 0;
  let n = 0;
  for (let o = 0; o + 3 < rgba.length; o += step * 4) {
    sum += Math.sqrt(map.error(rgba[o], rgba[o + 1], rgba[o + 2]));
    n++;
  }
  return n ? sum / n : 0;
}

// Above this average distance the scene has changed and gets its own palette.
export const NEW_PALETTE_ERROR = 6;

// Every `stride`th pixel of every `stride`th row, for a faster palette search.
export function subsample(rgba, width, height, stride = 2) {
  const w = Math.ceil(width / stride);
  const h = Math.ceil(height / stride);
  const out = new Uint8Array(w * h * 4);
  let p = 0;
  for (let y = 0; y < height; y += stride) {
    for (let x = 0; x < width; x += stride) {
      const o = (y * width + x) * 4;
      out[p++] = rgba[o]; out[p++] = rgba[o + 1]; out[p++] = rgba[o + 2]; out[p++] = 255;
    }
  }
  return out;
}

// Frame differencing. A pixel is left as it is on screen when what the GIF
// would draw there comes out the same (same palette colour), or when the
// colour already shown is as close to the picture now as a fresh draw would
// be, give or take `tolerance` (compression noise flickering between two
// neighbouring palette colours). Judging by what is shown against the
// picture NOW matters twice over: during a fade each step is small, and a
// screen drawn with a poorer palette (or dithered) can differ from a new
// picture of almost the same colour -- a dark title card over a dark editor
// -- by more than the step; comparing sources alone left those behind as a
// faint copy of the old picture.
// Unchanged pixels become `transparentIndex`, so the frame before shows
// through and the GIF carries only what changed.
//
// screen = { source, drawn }: per pixel, the source RGB when last drawn and
// the palette RGB shown. createScreen() starts it from a fully drawn frame.
export const NOISE_TOLERANCE = 6;

export function createScreen(rgba, index, palette) {
  const n = index.length;
  const screen = { source: new Uint8Array(n * 3), drawn: new Uint8Array(n * 3) };
  for (let p = 0, o = 0, s = 0; p < n; p++, o += 4, s += 3) {
    const c = palette[index[p]];
    screen.source[s] = rgba[o]; screen.source[s + 1] = rgba[o + 1]; screen.source[s + 2] = rgba[o + 2];
    screen.drawn[s] = c[0]; screen.drawn[s + 1] = c[1]; screen.drawn[s + 2] = c[2];
  }
  return screen;
}

// Marks unchanged pixels of `index` transparent and records the changed ones
// in `screen`. Returns how many changed; with 0 nothing was touched.
export function keepUnchanged(rgba, index, palette, transparentIndex, screen, tolerance = NOISE_TOLERANCE) {
  const { source, drawn } = screen;
  const n = index.length;
  const same = new Uint8Array(n);
  let changed = 0;
  for (let p = 0, o = 0, s = 0; p < n; p++, o += 4, s += 3) {
    const c = palette[index[p]];
    if (c[0] === drawn[s] && c[1] === drawn[s + 1] && c[2] === drawn[s + 2]) {
      same[p] = 1;
      continue;
    }
    // Largest channel difference: shown vs now, and a fresh draw vs now.
    const shownOff = Math.max(Math.abs(rgba[o] - drawn[s]), Math.abs(rgba[o + 1] - drawn[s + 1]), Math.abs(rgba[o + 2] - drawn[s + 2]));
    const drawOff = Math.max(Math.abs(rgba[o] - c[0]), Math.abs(rgba[o + 1] - c[1]), Math.abs(rgba[o + 2] - c[2]));
    if (shownOff <= drawOff + tolerance) {
      same[p] = 1;
    } else {
      changed++;
    }
  }
  if (changed === 0) return 0;
  for (let p = 0, o = 0, s = 0; p < n; p++, o += 4, s += 3) {
    if (same[p]) {
      index[p] = transparentIndex;
    } else {
      const c = palette[index[p]];
      source[s] = rgba[o]; source[s + 1] = rgba[o + 1]; source[s + 2] = rgba[o + 2];
      drawn[s] = c[0]; drawn[s + 1] = c[1]; drawn[s + 2] = c[2];
    }
  }
  return changed;
}
