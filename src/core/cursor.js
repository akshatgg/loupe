// The recorded cursor (cursor.bin) and the few questions the picture asks of
// it: where is it at time t, smoothed or not, and has it been sitting still.
//
// cursor.bin is 16-byte little-endian records: float32 t, float32 x, float32
// y (source points, like everything else), uint8 shape, 3 bytes padding --
// the format src/main/project.js writes.

export const CURSOR_RECORD_BYTES = 16;
export const SHAPE_NAMES = ['arrow', 'ibeam', 'pointinghand', 'resize'];

// A cursor that hasn't moved further than this (points)...
export const IDLE_DISTANCE = 2;
// ...for this long is idle, and fades out over IDLE_FADE_SECONDS.
export const IDLE_SECONDS = 1.5;
export const IDLE_FADE_SECONDS = 0.3;

// Smoothing: resampled at this rate and low-passed (zero phase, like the
// camera) at this cutoff -- enough to take out hand jitter and the steps of a
// 60Hz sampled track without visibly lagging a deliberate move.
const SMOOTH_RATE = 120;
const SMOOTH_CUTOFF_HZ = 5;

export function parseCursorTrack(data) {
  const bytes = data instanceof ArrayBuffer ? new Uint8Array(data)
    : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out = [];
  for (let at = 0; at + CURSOR_RECORD_BYTES <= bytes.byteLength; at += CURSOR_RECORD_BYTES) {
    out.push({
      t: view.getFloat32(at, true),
      x: view.getFloat32(at + 4, true),
      y: view.getFloat32(at + 8, true),
      shape: SHAPE_NAMES[view.getUint8(at + 12)] ?? 'arrow'
    });
  }
  return out;
}

function nearestIndex(track, t) {
  let lo = 0;
  let hi = track.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (track[mid].t <= t) lo = mid;
    else hi = mid;
  }
  return Math.abs(track[lo].t - t) <= Math.abs(track[hi].t - t) ? lo : hi;
}

// Nearest sample to t -- the same lookup Render.swift's sampleCursor does,
// so a migrated project draws the cursor where v1 did.
export function cursorAt(track, t) {
  if (!track || track.length === 0) return null;
  return track[nearestIndex(track, t)];
}

function lowpass(arr, alpha) {
  const n = arr.length;
  const fwd = new Float64Array(n);
  let acc = arr[0];
  for (let i = 0; i < n; i++) { acc += alpha * (arr[i] - acc); fwd[i] = acc; }
  const out = new Float64Array(n);
  acc = fwd[n - 1];
  for (let i = n - 1; i >= 0; i--) { acc += alpha * (fwd[i] - acc); out[i] = acc; }
  return out;
}

// Precomputes what smoothing and idle-hiding need, once per track.
export function prepareCursor(track) {
  if (!track || track.length === 0) return { track: [], xs: null, ys: null, lastMove: null, t0: 0 };
  const t0 = track[0].t;
  const n = Math.max(1, Math.ceil((track.at(-1).t - t0) * SMOOTH_RATE) + 1);
  const xs = new Float64Array(n);
  const ys = new Float64Array(n);
  let j = 0;
  for (let i = 0; i < n; i++) {
    const t = t0 + i / SMOOTH_RATE;
    while (j < track.length - 1 && track[j + 1].t <= t) j++;
    const a = track[j];
    const b = track[j + 1];
    const f = b && b.t > a.t ? Math.min(1, Math.max(0, (t - a.t) / (b.t - a.t))) : 0;
    xs[i] = a.x + ((b ?? a).x - a.x) * f;
    ys[i] = a.y + ((b ?? a).y - a.y) * f;
  }
  const alpha = 1 - Math.exp((-2 * Math.PI * SMOOTH_CUTOFF_HZ) / SMOOTH_RATE);
  // For idleness, when the cursor last moved noticeably: a sample moved if it
  // is more than IDLE_DISTANCE from where the cursor was when it last moved.
  const lastMove = new Float64Array(track.length);
  let anchor = track[0];
  for (let i = 0; i < track.length; i++) {
    const s = track[i];
    if (Math.hypot(s.x - anchor.x, s.y - anchor.y) > IDLE_DISTANCE) anchor = s;
    lastMove[i] = anchor.t;
  }
  return { track, xs: lowpass(xs, alpha), ys: lowpass(ys, alpha), lastMove, t0 };
}

// The cursor position at t: raw nearest sample, or the smoothed path.
export function cursorPosition(prepared, t, smooth) {
  const { track } = prepared;
  if (track.length === 0) return null;
  const i = nearestIndex(track, t);
  if (!smooth) return { x: track[i].x, y: track[i].y, shape: track[i].shape };
  const pos = Math.min(prepared.xs.length - 1, Math.max(0, (t - prepared.t0) * SMOOTH_RATE));
  const k = Math.min(prepared.xs.length - 2, Math.floor(pos));
  if (k < 0) return { x: prepared.xs[0], y: prepared.ys[0], shape: track[i].shape };
  const f = pos - k;
  return {
    x: prepared.xs[k] + (prepared.xs[k + 1] - prepared.xs[k]) * f,
    y: prepared.ys[k] + (prepared.ys[k + 1] - prepared.ys[k]) * f,
    shape: track[i].shape
  };
}

// 1 while the cursor is in use, easing to 0 once it has sat still for
// IDLE_SECONDS. A click counts as use.
export function cursorOpacity(prepared, t, clicks = []) {
  const { track } = prepared;
  if (track.length === 0) return 0;
  // Last sample at or before t.
  let lo = 0;
  let hi = track.length - 1;
  if (track[0].t > t) return 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (track[mid].t <= t) lo = mid;
    else hi = mid - 1;
  }
  let active = prepared.lastMove[lo];
  for (const c of clicks) if (c.t <= t && c.t > active) active = c.t;
  const still = t - active - IDLE_SECONDS;
  if (still <= 0) return 1;
  return Math.max(0, 1 - still / IDLE_FADE_SECONDS);
}
