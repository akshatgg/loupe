'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { createZoomState, applyScroll, ZOOM_MIN, ZOOM_MAX } = require('../src/main/zoom');

const near = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} !== ${b}`);

test('starts fully zoomed out', () => {
  assert.strictEqual(createZoomState().target, ZOOM_MIN);
});

test('scrolling up zooms in', () => {
  const s = createZoomState();
  applyScroll(s, { t: 1, dy: 10, x: 100, y: 100 });
  assert.ok(s.target > ZOOM_MIN);
});

test('scrolling down from rest stays clamped at the minimum', () => {
  const s = createZoomState();
  applyScroll(s, { t: 1, dy: -10, x: 100, y: 100 });
  assert.strictEqual(s.target, ZOOM_MIN);
});

test('never exceeds the maximum', () => {
  const s = createZoomState();
  for (let i = 0; i < 500; i++) applyScroll(s, { t: i * 0.01, dy: 30, x: 100, y: 100 });
  assert.strictEqual(s.target, ZOOM_MAX);
});

test('equal scroll up then down returns to the starting zoom', () => {
  const s = createZoomState();
  for (let i = 0; i < 5; i++) applyScroll(s, { t: i * 0.01, dy: 10, x: 100, y: 100 });
  const peak = s.target;
  assert.ok(peak > 1.2 && peak < ZOOM_MAX, `peak ${peak} should be mid-range`);
  for (let i = 0; i < 5; i++) applyScroll(s, { t: 1 + i * 0.01, dy: -10, x: 100, y: 100 });
  near(s.target, ZOOM_MIN);
});

test('records a keyframe carrying the cursor position', () => {
  const s = createZoomState();
  applyScroll(s, { t: 4.25, dy: 10, x: 1420, y: 880 });
  assert.strictEqual(s.keyframes.length, 1);
  const k = s.keyframes[0];
  assert.strictEqual(k.t, 4.25);
  assert.strictEqual(k.cx, 1420);
  assert.strictEqual(k.cy, 880);
  assert.ok(k.zoom > ZOOM_MIN);
});

test('emits no keyframe when already clamped and the cursor has not moved', () => {
  const s = createZoomState();
  applyScroll(s, { t: 1, dy: -10, x: 100, y: 100 });
  applyScroll(s, { t: 2, dy: -10, x: 100, y: 100 });
  assert.strictEqual(s.keyframes.length, 0);
});

test('emits a keyframe when clamped but the cursor moved', () => {
  const s = createZoomState();
  applyScroll(s, { t: 1, dy: -10, x: 100, y: 100 });
  applyScroll(s, { t: 2, dy: -10, x: 400, y: 400 });
  assert.strictEqual(s.keyframes.length, 1);
});

test('cumulative sub-epsilon cursor drift eventually emits a keyframe', () => {
  const s = createZoomState();
  // Seed the baseline.
  applyScroll(s, { t: 0, dy: -10, x: 0, y: 0 });
  // Each step moves 0.9px, below CURSOR_EPSILON, but accumulates against the
  // fixed baseline rather than the previous raw sample.
  for (let i = 1; i <= 200; i++) {
    applyScroll(s, { t: i, dy: -10, x: i * 0.9, y: 0 });
  }
  assert.ok(s.keyframes.length > 0, 'drift should eventually produce a keyframe');
});

test('a non-emitting call does not move the cursor baseline', () => {
  const s = createZoomState();
  applyScroll(s, { t: 0, dy: -10, x: 0, y: 0 });
  // Below epsilon, does not emit, must not move the baseline.
  applyScroll(s, { t: 1, dy: -10, x: 0.5, y: 0 });
  assert.strictEqual(s.keyframes.length, 0);
  // Another small step; cumulative from the ORIGINAL baseline (0) is now
  // 0.9, still below epsilon, so still no emit.
  applyScroll(s, { t: 2, dy: -10, x: 0.9, y: 0 });
  assert.strictEqual(s.keyframes.length, 0);
  // Crossing epsilon from the original baseline emits.
  applyScroll(s, { t: 3, dy: -10, x: 1.1, y: 0 });
  assert.strictEqual(s.keyframes.length, 1);
});

test('a non-finite dy is ignored and leaves target usable', () => {
  const s = createZoomState();
  const before = s.target;
  const result = applyScroll(s, { t: 1, dy: NaN, x: 100, y: 100 });
  assert.strictEqual(result, false);
  assert.strictEqual(s.target, before);
  assert.strictEqual(s.keyframes.length, 0);

  // A normal event afterwards must still work.
  applyScroll(s, { t: 2, dy: 10, x: 100, y: 100 });
  assert.ok(s.target > before);
});
