'use strict';

const { ZOOM_MIN } = require('./zoom');

const SAMPLE_RATE = 120;

// Critically damped spring. Response reaches ~95% at about 4.7 * TAU,
// so 0.082 gives the ~400ms settle specified in TRD 4.2.
const TAU = 0.082;

// The inner 50% of the visible rect. Cursor movement inside it moves nothing.
const DEAD_ZONE_FRACTION = 0.5;

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

function sampleCount(duration, sampleRate) {
  return Math.max(1, Math.round(duration * sampleRate) + 1);
}

function easeZoom(keyframes, duration, sampleRate = SAMPLE_RATE) {
  const n = sampleCount(duration, sampleRate);
  const dt = 1 / sampleRate;
  const out = new Float64Array(n);
  let position = ZOOM_MIN;
  let velocity = 0;
  let target = ZOOM_MIN;
  let next = 0;

  for (let i = 0; i < n; i++) {
    const t = i * dt;
    while (next < keyframes.length && keyframes[next].t <= t) {
      target = keyframes[next].zoom;
      next++;
    }
    // Semi-implicit Euler: update velocity first, then position with it.
    const accel = (target - position) / (TAU * TAU) - (2 * velocity) / TAU;
    velocity += accel * dt;
    position += velocity * dt;
    out[i] = position;
  }
  return out;
}

function resampleCursor(track, duration, sampleRate = SAMPLE_RATE) {
  const n = sampleCount(duration, sampleRate);
  const dt = 1 / sampleRate;
  const xs = new Float64Array(n);
  const ys = new Float64Array(n);
  if (track.length === 0) return { xs, ys };

  let j = 0;
  for (let i = 0; i < n; i++) {
    const t = i * dt;
    while (j < track.length - 1 && track[j + 1].t <= t) j++;
    const a = track[j];
    const b = track[j + 1];
    if (!b || t <= a.t) {
      xs[i] = a.x;
      ys[i] = a.y;
      continue;
    }
    const f = (t - a.t) / (b.t - a.t);
    xs[i] = a.x + (b.x - a.x) * f;
    ys[i] = a.y + (b.y - a.y) * f;
  }
  return { xs, ys };
}

// The camera moves the MINIMUM distance that puts the cursor back on the
// dead-zone boundary, and never more. That is what makes typing produce
// exactly zero movement.
function solvePath(zoomSamples, cursor, { width, height }) {
  const n = zoomSamples.length;
  const cx = new Float64Array(n);
  const cy = new Float64Array(n);
  let camX = width / 2;
  let camY = height / 2;

  for (let i = 0; i < n; i++) {
    const z = zoomSamples[i];
    const vw = width / z;
    const vh = height / z;
    const dw = vw * DEAD_ZONE_FRACTION;
    const dh = vh * DEAD_ZONE_FRACTION;
    const mx = cursor.xs[i];
    const my = cursor.ys[i];

    if (mx < camX - dw / 2) camX = mx + dw / 2;
    else if (mx > camX + dw / 2) camX = mx - dw / 2;
    if (my < camY - dh / 2) camY = my + dh / 2;
    else if (my > camY + dh / 2) camY = my - dh / 2;

    camX = clamp(camX, vw / 2, width - vw / 2);
    camY = clamp(camY, vh / 2, height - vh / 2);

    cx[i] = camX;
    cy[i] = camY;
  }
  return { cx, cy };
}

module.exports = {
  easeZoom, resampleCursor, solvePath, clamp, sampleCount,
  SAMPLE_RATE, TAU, DEAD_ZONE_FRACTION
};
