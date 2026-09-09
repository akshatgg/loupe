'use strict';

const ZOOM_MIN = 1.0;
const ZOOM_MAX = 4.0;

// Per pixel of scroll delta. A mouse notch is ~10px, giving ~1.16x per notch,
// so 1.0x to 4.0x is about nine notches.
const SENSITIVITY = 0.015;

const CURSOR_EPSILON = 1;

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

function createZoomState() {
  return { target: ZOOM_MIN, keyframes: [], lastCursor: null };
}

// Positive dy means scroll up, which zooms in. Exponential so one notch feels
// like the same amount of zoom at 1.2x as it does at 3.5x.
function applyScroll(state, { t, dy, x, y }) {
  // A degenerate dy (NaN, +/-Infinity, or an undefined-derived value) would
  // corrupt state.target permanently, since clamp(NaN, ...) is NaN and NaN
  // poisons every future computation. Reject it here instead, before target
  // is touched.
  if (!Number.isFinite(dy)) return false;

  const next = clamp(state.target * Math.exp(dy * SENSITIVITY), ZOOM_MIN, ZOOM_MAX);
  const zoomChanged = next !== state.target;
  state.target = next;

  // A non-finite cursor position wouldn't corrupt state.target (it's already
  // committed above), but it would get written into a keyframe's cx/cy,
  // handing the downstream renderer a NaN camera position. Unlike dy, a bad
  // x/y should only cost us the keyframe, not the zoom change: the next
  // event with usable coordinates will emit a keyframe carrying the current
  // (accumulated) target, so nothing is lost.
  if (!Number.isFinite(x) || !Number.isFinite(y)) return false;

  // First call ever: seed the baseline from this event's position and treat
  // the cursor as not having moved yet.
  if (state.lastCursor === null) {
    state.lastCursor = { x, y };
  }

  const cursorMoved =
    Math.abs(x - state.lastCursor.x) >= CURSOR_EPSILON ||
    Math.abs(y - state.lastCursor.y) >= CURSOR_EPSILON;

  if (!zoomChanged && !cursorMoved) return false;

  // lastCursor tracks the last COMMITTED position, so it only moves on an
  // emitting call. Otherwise small movements accumulate against a fixed
  // baseline until they cross CURSOR_EPSILON.
  state.lastCursor = { x, y };

  state.keyframes.push({ t, zoom: next, cx: x, cy: y });
  return true;
}

module.exports = { createZoomState, applyScroll, ZOOM_MIN, ZOOM_MAX, SENSITIVITY };
