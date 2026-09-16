// The camera: which part of a recording is on screen at each moment. A port
// of src/main/camera.js (the v1 solver) and live-camera.js, driven by the
// project's zoom segments instead of raw scroll keyframes, and aware of the
// output's shape: when the video is narrower or wider than the recording
// (9:16 of a 16:10 screen, say), the visible rect has the video's shape and
// pans to keep the cursor in view even with no zoom at all.
//
// Everything is in the source's own time and points (like the cursor track),
// so trimming, cutting or speeding up the video never moves the camera
// relative to what was recorded.

export const SAMPLE_RATE = 120;

// Critically damped spring: x(t) = 1 - (1 + t/TAU) * exp(-t/TAU).
// Reaching 95% at 400ms needs TAU = 0.0843 exactly, so 0.082 clears it with
// margin at 95.5%.
export const TAU = 0.082;

// The inner 50% of the visible rect. Cursor movement inside it moves nothing.
export const DEAD_ZONE_FRACTION = 0.5;

export const SMOOTH_CUTOFF_HZ = 1.2;

// Output shapes within this fraction of the source's are treated as the
// source's own shape: the export size is rounded to even pixels, and v1
// simply stretched that last pixel rather than cropping for it.
const SAME_ASPECT_TOLERANCE = 0.005;

export function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

export function sampleCount(duration, sampleRate = SAMPLE_RATE) {
  return Math.max(1, Math.round(duration * sampleRate) + 1);
}

// The visible rect's size (source points) at zoom `z` for a view of shape
// `aspect` (width / height; null means the source's own shape). At 1x it is
// the largest rect of that shape that fits inside the source.
export function viewSize(z, width, height, aspect = null) {
  const src = width / height;
  if (!aspect || Math.abs(aspect / src - 1) < SAME_ASPECT_TOLERANCE) {
    return { vw: width / z, vh: height / z };
  }
  if (aspect < src) {
    const vh = height / z;
    return { vw: vh * aspect, vh };
  }
  const vw = width / z;
  return { vw, vh: vw / aspect };
}

// One step of the zoom spring, mutating `spring` ({position, velocity}).
export function springStep(spring, target, dt) {
  // Semi-implicit Euler: update velocity first, then position with it.
  const accel = (target - spring.position) / (TAU * TAU) - (2 * spring.velocity) / TAU;
  spring.velocity += accel * dt;
  spring.position += spring.velocity * dt;
}

// The camera moves the MINIMUM distance that puts the cursor back on the
// dead-zone boundary, and never more. That is what makes typing produce
// exactly zero movement. Mutates `cam` ({x, y}).
export function followStep(cam, z, mx, my, { width, height, aspect = null }) {
  const { vw, vh } = viewSize(z, width, height, aspect);
  const dw = vw * DEAD_ZONE_FRACTION;
  const dh = vh * DEAD_ZONE_FRACTION;

  if (mx < cam.x - dw / 2) cam.x = mx + dw / 2;
  else if (mx > cam.x + dw / 2) cam.x = mx - dw / 2;
  if (my < cam.y - dh / 2) cam.y = my + dh / 2;
  else if (my > cam.y + dh / 2) cam.y = my - dh / 2;

  cam.x = clamp(cam.x, vw / 2, width - vw / 2);
  cam.y = clamp(cam.y, vh / 2, height - vh / 2);
}

// The zoom targets over time for a source's zoom segments, as the v1-style
// keyframe list ({t, zoom}) the spring follows: each zoom's level from its
// start, back to 1x at its end. A recorded zoom that still has the keyframes
// it was migrated from replays those instead, so it moves exactly as v1 did.
export function zoomTargets(zooms, duration) {
  const out = [];
  const sorted = [...zooms].sort((a, b) => a.start - b.start);
  for (const z of sorted) {
    if (Array.isArray(z.keyframes) && z.keyframes.length) {
      for (const k of z.keyframes) out.push({ t: k.t, zoom: k.zoom });
      // A migrated zoom that was still zoomed in when the recording stopped
      // had no closing keyframe in v1; adding one at the very end would move
      // the last sample.
      if (z.keyframes.at(-1).zoom > 1 && z.end < duration - 1e-9) out.push({ t: z.end, zoom: 1 });
    } else {
      out.push({ t: z.start, zoom: z.level }, { t: z.end, zoom: 1 });
    }
  }
  // Stable: a zoom's return to 1x sorts before a zoom starting at that moment.
  return out.sort((a, b) => a.t - b.t);
}

export function easeZoom(keyframes, duration, sampleRate = SAMPLE_RATE) {
  const n = sampleCount(duration, sampleRate);
  const dt = 1 / sampleRate;
  const out = new Float64Array(n);
  const spring = { position: 1, velocity: 0 };
  let target = 1;
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

export function resampleCursor(track, duration, sampleRate = SAMPLE_RATE, fallback = { x: 0, y: 0 }) {
  const n = sampleCount(duration, sampleRate);
  const dt = 1 / sampleRate;
  const xs = new Float64Array(n).fill(fallback.x);
  const ys = new Float64Array(n).fill(fallback.y);
  if (!track || track.length === 0) return { xs, ys };

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

export function alphaFor(cutoffHz, sampleRate) {
  return 1 - Math.exp((-2 * Math.PI * cutoffHz) / sampleRate);
}

// Forward pass then backward pass. Running the same filter in both
// directions cancels the phase shift, so the output has zero lag.
export function smoothPath(arr, alpha) {
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

// The zoom (if any) whose [start, end) holds each sample, as an index into
// `sorted`, or -1.
function activeZoomIndex(sorted, n, sampleRate) {
  const out = new Int32Array(n).fill(-1);
  for (let k = 0; k < sorted.length; k++) {
    const z = sorted[k];
    const from = Math.max(0, Math.ceil(z.start * sampleRate - 1e-9));
    const to = Math.min(n, Math.ceil(z.end * sampleRate - 1e-9));
    for (let i = from; i < to; i++) out[i] = k;
  }
  return out;
}

// The camera track for one source: [{t, zoom, cx, cy}] at `sampleRate`.
//  - zooms: that source's zoom segments ({start, end, level, follow, x, y,
//    keyframes?}). While a zoom with follow=false is active the camera heads
//    for its pinned point instead of following the cursor.
//  - aspect: the output's width / height, or null for the source's shape.
// With the source's shape, no fixed zooms and a migrated project's zooms,
// this is exactly src/main/camera.js's solveCamera.
export function solveCamera({ zooms = [], cursorTrack = [], duration, width, height, aspect = null, sampleRate = SAMPLE_RATE }) {
  const bounds = { width, height, aspect };
  const zoom = easeZoom(zoomTargets(zooms, duration), duration, sampleRate);
  const cursor = resampleCursor(cursorTrack, duration, sampleRate);
  const n = zoom.length;
  const sorted = [...zooms].sort((a, b) => a.start - b.start);
  const active = activeZoomIndex(sorted, n, sampleRate);

  const rawX = new Float64Array(n);
  const rawY = new Float64Array(n);
  const cam = { x: width / 2, y: height / 2 };
  for (let i = 0; i < n; i++) {
    const z = active[i] >= 0 ? sorted[active[i]] : null;
    if (z && z.follow === false) {
      const { vw, vh } = viewSize(zoom[i], width, height, aspect);
      cam.x = clamp(z.x, vw / 2, width - vw / 2);
      cam.y = clamp(z.y, vh / 2, height - vh / 2);
    } else {
      followStep(cam, zoom[i], cursor.xs[i], cursor.ys[i], bounds);
    }
    rawX[i] = cam.x;
    rawY[i] = cam.y;
  }

  const alpha = alphaFor(SMOOTH_CUTOFF_HZ, sampleRate);
  const cx = smoothPath(rawX, alpha);
  const cy = smoothPath(rawY, alpha);

  const dt = 1 / sampleRate;
  const out = new Array(n);
  for (let i = 0; i < n; i++) {
    const z = zoom[i];
    const { vw, vh } = viewSize(z, width, height, aspect);
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

// The camera at source time t: the nearest sample, as Render.swift did (the
// track is 120Hz, denser than any output frame rate).
export function cameraAt(track, t, { width, height } = {}) {
  if (!track || track.length === 0) return { t, zoom: 1, cx: (width ?? 0) / 2, cy: (height ?? 0) / 2 };
  const step = track.length > 1 ? track[1].t - track[0].t : 1;
  const i = clamp(Math.round((t - track[0].t) / step), 0, track.length - 1);
  return track[i];
}

// The visible rect (source points) for a camera sample.
export function viewRect(sample, width, height, aspect = null) {
  const zoom = sample.zoom > 0 ? sample.zoom : 1;
  const { vw, vh } = viewSize(zoom, width, height, aspect);
  return { x: sample.cx - vw / 2, y: sample.cy - vh / 2, width: vw, height: vh };
}

// ---------------------------------------------------------------- live

// solveCamera run causally, one frame at a time, so the on-screen zoom frame
// shown DURING recording matches what the rendered video will show: the same
// zoom spring and dead-zone follow, stepped at the same SAMPLE_RATE. The one
// thing it can't do live is the final zero-phase smoothing pass -- that needs
// the future -- so the live frame leads the rendered camera by a hair on fast
// cursor moves, never by more.
export function createLiveCamera({ width, height, aspect = null }) {
  return {
    bounds: { width, height, aspect },
    spring: { position: 1, velocity: 0 },
    cam: { x: width / 2, y: height / 2 },
    cursor: { x: width / 2, y: height / 2 }
  };
}

// Advances the camera by `dt` seconds toward zoom `target`, following
// `cursor` (area-local points, or null to keep the last known one), and
// returns the visible rect in the same area-local points.
export function stepLiveCamera(live, { target, cursor, dt }) {
  if (cursor && Number.isFinite(cursor.x) && Number.isFinite(cursor.y)) {
    live.cursor = { x: cursor.x, y: cursor.y };
  }
  // Sub-step at the solver's own rate: exact parity with easeZoom when
  // called at 1/SAMPLE_RATE, and stable through a long frame hitch.
  const steps = Math.max(1, Math.ceil(dt * SAMPLE_RATE - 1e-9));
  const h = dt / steps;
  for (let i = 0; i < steps; i++) {
    springStep(live.spring, target, h);
    followStep(live.cam, live.spring.position, live.cursor.x, live.cursor.y, live.bounds);
  }

  const zoom = live.spring.position;
  const { vw, vh } = viewSize(zoom, live.bounds.width, live.bounds.height, live.bounds.aspect);
  return {
    zoom,
    rect: { x: live.cam.x - vw / 2, y: live.cam.y - vh / 2, width: vw, height: vh }
  };
}
