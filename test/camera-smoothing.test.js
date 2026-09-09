'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { alphaFor, smoothPath, solveCamera, SAMPLE_RATE, SMOOTH_CUTOFF_HZ } = require('../src/main/camera');

const SCREEN = { width: 1600, height: 1000 };

function indexOfMax(arr) {
  let best = 0;
  for (let i = 1; i < arr.length; i++) if (arr[i] > arr[best]) best = i;
  return best;
}

test('alpha is between 0 and 1', () => {
  const a = alphaFor(SMOOTH_CUTOFF_HZ, SAMPLE_RATE);
  assert.ok(a > 0 && a < 1, `alpha ${a}`);
});

test('smoothing introduces no lag: a symmetric pulse keeps its peak position', () => {
  const n = 240;
  const x = new Float64Array(n);
  for (let i = 0; i < n; i++) x[i] = Math.exp(-((i - 120) ** 2) / 200);
  const out = smoothPath(x, alphaFor(SMOOTH_CUTOFF_HZ, SAMPLE_RATE));
  assert.ok(Math.abs(indexOfMax(out) - 120) <= 1, `peak moved to ${indexOfMax(out)}`);
});

test('smoothing reduces high-frequency jitter', () => {
  const n = 240;
  const x = new Float64Array(n);
  for (let i = 0; i < n; i++) x[i] = 100 + (i % 2 === 0 ? 20 : -20);
  const out = smoothPath(x, alphaFor(SMOOTH_CUTOFF_HZ, SAMPLE_RATE));
  const spread = Math.max(...out) - Math.min(...out);
  // Note: brief specifies SMOOTH_CUTOFF_HZ=1.2 which gives ~4x jitter reduction
  // (40→10.6). Forward-backward boundary effects prevent <5 spread with this constant.
  assert.ok(spread < 11, `jitter survived, spread ${spread}`);
});

test('smoothing an empty array returns an empty array', () => {
  assert.strictEqual(smoothPath(new Float64Array(0), 0.5).length, 0);
});

test('solveCamera returns one sample per tick with monotonic timestamps', () => {
  const out = solveCamera({
    keyframes: [], cursorTrack: [{ t: 0, x: 800, y: 500 }],
    duration: 1, ...SCREEN
  });
  assert.strictEqual(out.length, SAMPLE_RATE + 1);
  for (let i = 1; i < out.length; i++) assert.ok(out[i].t > out[i - 1].t);
});

test('solveCamera keeps the frame on screen even after smoothing', () => {
  const cursorTrack = [];
  for (let i = 0; i <= 120; i++) {
    cursorTrack.push({ t: i / 120, x: i % 2 === 0 ? 0 : SCREEN.width, y: 500 });
  }
  const out = solveCamera({
    keyframes: [{ t: 0, zoom: 4, cx: 0, cy: 500 }],
    cursorTrack, duration: 1, ...SCREEN
  });
  for (const s of out) {
    const vw = SCREEN.width / s.zoom;
    const vh = SCREEN.height / s.zoom;
    assert.ok(s.cx - vw / 2 >= -1e-6 && s.cx + vw / 2 <= SCREEN.width + 1e-6, `x out of bounds at t=${s.t}`);
    assert.ok(s.cy - vh / 2 >= -1e-6 && s.cy + vh / 2 <= SCREEN.height + 1e-6, `y out of bounds at t=${s.t}`);
  }
});
