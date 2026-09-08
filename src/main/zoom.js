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
  return { target: ZOOM_MIN, keyframes: [], lastCursor: { x: NaN, y: NaN } };
}

// Positive dy means scroll up, which zooms in. Exponential so one notch feels
// like the same amount of zoom at 1.2x as it does at 3.5x.
function applyScroll(state, { t, dy, x, y }) {
  const next = clamp(state.target * Math.exp(dy * SENSITIVITY), ZOOM_MIN, ZOOM_MAX);
  const zoomChanged = next !== state.target;
  const cursorMoved =
    Math.abs(x - state.lastCursor.x) >= CURSOR_EPSILON ||
    Math.abs(y - state.lastCursor.y) >= CURSOR_EPSILON;

  state.target = next;
  state.lastCursor = { x, y };

  if (!zoomChanged && !cursorMoved) return false;

  state.keyframes.push({ t, zoom: next, cx: x, cy: y });
  return true;
}

module.exports = { createZoomState, applyScroll, ZOOM_MIN, ZOOM_MAX, SENSITIVITY };
