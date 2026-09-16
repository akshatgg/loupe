import test from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import * as C from '../src/core/camera.js';
import { migrate } from '../src/core/project.js';
import { parseCursorTrack } from '../src/core/cursor.js';

const require = createRequire(import.meta.url);
const v1Camera = require('../src/main/camera.js');
const v1Live = require('../src/main/live-camera.js');

const near = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} !== ${b}`);
const V1 = JSON.parse(readFileSync(new URL('./fixtures/v1-project-zooms.json', import.meta.url), 'utf8'));
const CURSOR = parseCursorTrack(readFileSync(new URL('./fixtures/v1-cursor.bin', import.meta.url)));
const SCREEN = { width: 1600, height: 1000 };

test('a migrated real project gets exactly the v1 camera track', () => {
  const p = migrate(V1);
  const m = p.sources.main;
  const before = v1Camera.solveCamera({
    keyframes: V1.zoomKeyframes, cursorTrack: CURSOR, duration: m.duration, width: m.width, height: m.height
  });
  const after = C.solveCamera({ zooms: p.zooms, cursorTrack: CURSOR, duration: m.duration, width: m.width, height: m.height });
  assert.strictEqual(after.length, before.length);
  for (let i = 0; i < before.length; i++) {
    assert.deepStrictEqual(after[i], before[i], `sample ${i}`);
  }
  // And it really zooms: the fixture reaches 4x.
  assert.ok(Math.max(...after.map((s) => s.zoom)) > 3.9);
});

test('a plain zoom eases to its level from its start and back after its end', () => {
  const zooms = [{ start: 1, end: 3, level: 2, follow: true, x: 0, y: 0 }];
  const track = C.solveCamera({ zooms, cursorTrack: [], duration: 5, ...SCREEN });
  const at = (t) => track[Math.round(t * C.SAMPLE_RATE)];
  near(at(0.9).zoom, 1);
  assert.ok(at(1.5).zoom > 1.95);
  near(at(2.99).zoom, 2, 1e-3);
  near(at(4.5).zoom, 1, 1e-3);
  // It is the v1 solver fed the equivalent keyframes.
  const v1 = v1Camera.solveCamera({ keyframes: [{ t: 1, zoom: 2 }, { t: 3, zoom: 1 }], cursorTrack: [], duration: 5, ...SCREEN });
  track.forEach((s, i) => assert.deepStrictEqual(s, v1[i]));
});

test('back-to-back zooms go straight from one level to the next', () => {
  const targets = C.zoomTargets([
    { start: 2, end: 4, level: 3 }, { start: 0, end: 2, level: 2 }
  ], 10);
  assert.deepStrictEqual(targets, [{ t: 0, zoom: 2 }, { t: 2, zoom: 1 }, { t: 2, zoom: 3 }, { t: 4, zoom: 1 }]);
  const zoom = C.easeZoom(targets, 5);
  assert.ok(zoom[Math.round(2.5 * C.SAMPLE_RATE)] > 2.5);
});

test('a fixed zoom pins the view on its point whatever the cursor does', () => {
  const cursorTrack = [{ t: 0, x: 100, y: 100 }, { t: 3, x: 1500, y: 900 }, { t: 6, x: 100, y: 900 }];
  const zooms = [{ start: 0.5, end: 5.5, level: 2, follow: false, x: 500, y: 300 }];
  const track = C.solveCamera({ zooms, cursorTrack, duration: 6, ...SCREEN });
  for (const t of [2.5, 3, 4]) {
    const s = track[Math.round(t * C.SAMPLE_RATE)];
    near(s.cx, 500, 0.5);
    near(s.cy, 300, 0.5);
  }
  // The same zoom following the cursor goes where the cursor is.
  const follow = C.solveCamera({ zooms: [{ ...zooms[0], follow: true }], cursorTrack, duration: 6, ...SCREEN });
  assert.ok(follow[3 * C.SAMPLE_RATE].cx > 1100);
});

test('a pinned point too near the edge is clamped so the view stays on the recording', () => {
  const zooms = [{ start: 0, end: 5, level: 2, follow: false, x: 0, y: 0 }];
  const s = C.solveCamera({ zooms, cursorTrack: [], duration: 5, ...SCREEN })[3 * C.SAMPLE_RATE];
  near(s.cx, 400, 0.5);
  near(s.cy, 250, 0.5);
});

test('a narrower output pans across the recording to follow the cursor without zooming', () => {
  const aspect = 9 / 16;
  const left = C.solveCamera({ cursorTrack: [{ t: 0, x: 50, y: 500 }], duration: 3, ...SCREEN, aspect });
  const right = C.solveCamera({ cursorTrack: [{ t: 0, x: 1550, y: 500 }], duration: 3, ...SCREEN, aspect });
  const end = 2 * C.SAMPLE_RATE;
  const vw = 1000 * aspect;
  near(left[end].zoom, 1);
  near(left[end].cx, vw / 2, 1);
  near(right[end].cx, 1600 - vw / 2, 1);
  // Full height, so no vertical movement is possible.
  near(left[end].cy, 500);
  const rect = C.viewRect(right[end], 1600, 1000, aspect);
  near(rect.width, vw);
  near(rect.height, 1000);
  assert.ok(rect.x + rect.width <= 1600 + 1e-9);
});

test('viewSize fits the output shape inside the recording', () => {
  assert.deepStrictEqual(C.viewSize(1, 1600, 1000), { vw: 1600, vh: 1000 });
  assert.deepStrictEqual(C.viewSize(2, 1600, 1000, 1), { vw: 500, vh: 500 });
  const wide = C.viewSize(1, 1600, 1000, 21 / 9);
  near(wide.vw, 1600);
  near(wide.vh, 1600 / (21 / 9));
  // Within half a percent of the source shape: the source shape.
  assert.deepStrictEqual(C.viewSize(1, 1470, 956, 1660 / 1080), { vw: 1470, vh: 956 });
});

test('cameraAt takes the nearest sample, and centres an empty track', () => {
  const track = C.solveCamera({ zooms: [], cursorTrack: [], duration: 1, ...SCREEN });
  assert.strictEqual(C.cameraAt(track, 0.504), track[60]);
  assert.strictEqual(C.cameraAt(track, 99), track.at(-1));
  assert.deepStrictEqual(C.cameraAt([], 1, SCREEN), { t: 1, zoom: 1, cx: 800, cy: 500 });
});

test('the live camera steps exactly like v1 live-camera.js', () => {
  const a = C.createLiveCamera(SCREEN);
  const b = v1Live.createLiveCamera(SCREEN);
  for (let i = 0; i < 400; i++) {
    const input = { target: i > 60 && i < 300 ? 3 : 1, cursor: { x: (i * 7) % 1600, y: (i * 3) % 1000 }, dt: i % 50 === 0 ? 0.1 : 1 / 120 };
    assert.deepStrictEqual(C.stepLiveCamera(a, input), v1Live.stepLiveCamera(b, input), `step ${i}`);
  }
});

test('the live camera matches the solved zoom for the same targets', () => {
  const expected = C.easeZoom([{ t: 0.5, zoom: 2 }], 1.5);
  const live = C.createLiveCamera(SCREEN);
  for (let i = 0; i < expected.length; i++) {
    const { zoom } = C.stepLiveCamera(live, { target: i / C.SAMPLE_RATE >= 0.5 ? 2 : 1, cursor: null, dt: 1 / C.SAMPLE_RATE });
    assert.strictEqual(zoom, expected[i]);
  }
});
