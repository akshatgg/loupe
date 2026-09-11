'use strict';

const { ZOOM_MIN } = require('./zoom');

const SAMPLE_RATE = 120;

// Critically damped spring: x(t) = 1 - (1 + t/TAU) * exp(-t/TAU).
// Reaching 95% at 400ms needs TAU = 0.0843 exactly, so 0.082 clears it with
// margin at 95.5%. The 0.085 originally specified lands at 94.84% and misses.
const TAU = 0.082;

// The inner 50% of the visible rect. Cursor movement inside it moves nothing.
const DEAD_ZONE_FRACTION = 0.5;

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

function sampleCount(duration, sampleRate) {
  return Math.max(1, Math.round(duration * sampleRate) + 1);
}

// One step of the zoom spring, mutating `spring` ({position, velocity}).
// Shared by easeZoom below and by live-camera.js, so the on-screen zoom
// frame during recording eases exactly the way the rendered video will.
function springStep(spring, target, dt) {
  // Semi-implicit Euler: update velocity first, then position with it.
  const accel = (target - spring.position) / (TAU * TAU) - (2 * spring.velocity) / TAU;
  spring.velocity += accel * dt;
  spring.position += spring.velocity * dt;
}

function easeZoom(keyframes, duration, sampleRate = SAMPLE_RATE) {
  const n = sampleCount(duration, sampleRate);
  const dt = 1 / sampleRate;
  const out = new Float64Array(n);
  const spring = { position: ZOOM_MIN, velocity: 0 };
  let target = ZOOM_MIN;
  let next = 0;

  for (let i = 0; i < n; i++) {
    const t = i * dt;
    while (next < keyframes.length && keyframes[next].t <= t) {
      target = keyframes[next].zoom;
      next++;
    }
    springStep(spring, target, dt);
    out[i] = spring.position;
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
// One step of that dead-zone follow, mutating `cam` ({x, y}) for zoom `z`
// and cursor (mx, my). Shared with live-camera.js, like springStep.
function followStep(cam, z, mx, my, { width, height }) {
  const vw = width / z;
  const vh = height / z;
  const dw = vw * DEAD_ZONE_FRACTION;
  const dh = vh * DEAD_ZONE_FRACTION;

  if (mx < cam.x - dw / 2) cam.x = mx + dw / 2;
  else if (mx > cam.x + dw / 2) cam.x = mx - dw / 2;
  if (my < cam.y - dh / 2) cam.y = my + dh / 2;
  else if (my > cam.y + dh / 2) cam.y = my - dh / 2;

  cam.x = clamp(cam.x, vw / 2, width - vw / 2);
  cam.y = clamp(cam.y, vh / 2, height - vh / 2);
}

function solvePath(zoomSamples, cursor, bounds) {
  const n = zoomSamples.length;
  const cx = new Float64Array(n);
  const cy = new Float64Array(n);
  const cam = { x: bounds.width / 2, y: bounds.height / 2 };

  for (let i = 0; i < n; i++) {
    followStep(cam, zoomSamples[i], cursor.xs[i], cursor.ys[i], bounds);
    cx[i] = cam.x;
    cy[i] = cam.y;
  }
  return { cx, cy };
}

const SMOOTH_CUTOFF_HZ = 1.2;

function alphaFor(cutoffHz, sampleRate) {
  return 1 - Math.exp((-2 * Math.PI * cutoffHz) / sampleRate);
}

// Forward pass then backward pass. Running the same filter in both
// directions cancels the phase shift, so the output has zero lag.
function smoothPath(arr, alpha) {
  const n = arr.length;
  if (n === 0) return new Float64Array(0);

  const forward = new Float64Array(n);
  let acc = arr[0];
  for (let i = 0; i < n; i++) {
    acc += alpha * (arr[i] - acc);
    forward[i] = acc;
  }

  const out = new Float64Array(n);
  acc = forward[n - 1];
  for (let i = n - 1; i >= 0; i--) {
    acc += alpha * (forward[i] - acc);
    out[i] = acc;
  }
  return out;
}

function solveCamera({ keyframes, cursorTrack, duration, width, height, sampleRate = SAMPLE_RATE }) {
  const zoom = easeZoom(keyframes, duration, sampleRate);
  const cursor = resampleCursor(cursorTrack, duration, sampleRate);
  const raw = solvePath(zoom, cursor, { width, height });
  const alpha = alphaFor(SMOOTH_CUTOFF_HZ, sampleRate);
  const cx = smoothPath(raw.cx, alpha);
  const cy = smoothPath(raw.cy, alpha);

  const dt = 1 / sampleRate;
  const out = new Array(zoom.length);
  for (let i = 0; i < zoom.length; i++) {
    const z = zoom[i];
    const vw = width / z;
    const vh = height / z;
    // Re-clamp: smoothing can push the frame past the screen edge, which
    // would render as black bars.
    out[i] = {
      t: i * dt,
      zoom: z,
      cx: clamp(cx[i], vw / 2, width - vw / 2),
      cy: clamp(cy[i], vh / 2, height - vh / 2)
    };
  }
  return out;
}

module.exports = {
  easeZoom, resampleCursor, solvePath, smoothPath, alphaFor, solveCamera,
  springStep, followStep,
  clamp, sampleCount,
  SAMPLE_RATE, TAU, DEAD_ZONE_FRACTION, SMOOTH_CUTOFF_HZ
};
