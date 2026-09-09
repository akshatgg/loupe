'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { easeZoom, resampleCursor, solvePath, SAMPLE_RATE } = require('../src/main/camera');

const near = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} !== ${b}`);
const SCREEN = { width: 1600, height: 1000 };

function constantCursor(x, y, n) {
  return { xs: new Float64Array(n).fill(x), ys: new Float64Array(n).fill(y) };
}

test('zoom starts at 1.0 with no keyframes', () => {
  const z = easeZoom([], 1, SAMPLE_RATE);
  near(z[0], 1);
  near(z[z.length - 1], 1);
});

test('zoom reaches 95 percent of its target within 400ms', () => {
  const z = easeZoom([{ t: 0, zoom: 3, cx: 0, cy: 0 }], 1, SAMPLE_RATE);
  const at400ms = z[Math.round(0.4 * SAMPLE_RATE)];
  assert.ok(at400ms >= 1 + 0.95 * 2, `reached only ${at400ms}`);
});

test('zoom is critically damped and does not overshoot', () => {
  const z = easeZoom([{ t: 0, zoom: 3, cx: 0, cy: 0 }], 3, SAMPLE_RATE);
  const peak = Math.max(...z);
  assert.ok(peak <= 3 * 1.01, `overshot to ${peak}`);
});

test('cursor resampling interpolates between samples', () => {
  const track = [{ t: 0, x: 0, y: 0 }, { t: 1, x: 120, y: 240 }];
  const { xs, ys } = resampleCursor(track, 1, SAMPLE_RATE);
  near(xs[Math.round(0.5 * SAMPLE_RATE)], 60, 1);
  near(ys[Math.round(0.5 * SAMPLE_RATE)], 120, 1);
});

test('cursor resampling holds the last known value past the end of the track', () => {
  const track = [{ t: 0, x: 10, y: 20 }];
  const { xs, ys } = resampleCursor(track, 1, SAMPLE_RATE);
  near(xs[xs.length - 1], 10);
  near(ys[ys.length - 1], 20);
});

test('at 1.0x the camera is pinned to screen centre', () => {
  const n = 120;
  const z = new Float64Array(n).fill(1);
  const { cx, cy } = solvePath(z, constantCursor(50, 50, n), SCREEN);
  for (let i = 0; i < n; i++) {
    near(cx[i], SCREEN.width / 2);
    near(cy[i], SCREEN.height / 2);
  }
});

test('a cursor sitting inside the dead zone moves the camera exactly zero', () => {
  const n = 120;
  const z = new Float64Array(n).fill(2);
  // At 2x the visible rect is 800x500 and the dead zone is 400x250 around
  // screen centre, so (850, 550) is comfortably inside it.
  const { cx, cy } = solvePath(z, constantCursor(850, 550, n), SCREEN);
  for (let i = 0; i < n; i++) {
    assert.strictEqual(cx[i], SCREEN.width / 2);
    assert.strictEqual(cy[i], SCREEN.height / 2);
  }
});

test('the camera follows a cursor that leaves the dead zone', () => {
  const n = 120;
  const z = new Float64Array(n).fill(2);
  const { cx } = solvePath(z, constantCursor(1500, 500, n), SCREEN);
  assert.ok(cx[0] > SCREEN.width / 2, 'camera should have moved right');
});

test('the visible frame never leaves the screen at any zoom', () => {
  const n = 240;
  const z = new Float64Array(n);
  for (let i = 0; i < n; i++) z[i] = 1 + 3 * (i / n);
  const xs = new Float64Array(n);
  const ys = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    xs[i] = i % 2 === 0 ? -500 : 3000;
    ys[i] = i % 2 === 0 ? -500 : 3000;
  }
  const { cx, cy } = solvePath(z, { xs, ys }, SCREEN);
  for (let i = 0; i < n; i++) {
    const vw = SCREEN.width / z[i];
    const vh = SCREEN.height / z[i];
    assert.ok(cx[i] - vw / 2 >= -1e-6 && cx[i] + vw / 2 <= SCREEN.width + 1e-6, `x out of bounds at ${i}`);
    assert.ok(cy[i] - vh / 2 >= -1e-6 && cy[i] + vh / 2 <= SCREEN.height + 1e-6, `y out of bounds at ${i}`);
  }
});
