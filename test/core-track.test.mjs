// Following what's under a hidden area (src/core/track.js), the path it
// stores on the annotation (src/core/project.js) and where the box is drawn
// along it (src/core/layers/annotations.js).
import test from 'node:test';
import assert from 'node:assert';
import {
  createTracker, simplifyPath, positionAt, shiftPath, LOST_SCORE, MIN_DETAIL, MAX_PATH_POINTS
} from '../src/core/track.js';
import * as P from '../src/core/project.js';
import * as A from '../src/core/layers/annotations.js';
import { buildTimeline } from '../src/core/timeline.js';
import { drawFrame, exportSize } from '../src/core/compose.js';
import { mockContext } from './support/mock-canvas.mjs';

const W = 320;
const H = 200;
const near = (a, b, eps, what = '') => assert.ok(Math.abs(a - b) <= eps, `${what} ${a} is not within ${eps} of ${b}`);

// A repeatable random number source.
function random(seed) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

// A patch of random light and dark cells, `cell` pixels across.
function texture(w, h, cell, seed) {
  const rnd = random(seed);
  const cols = Math.ceil(w / cell);
  const cells = Array.from({ length: cols * Math.ceil(h / cell) }, () => (rnd() < 0.5 ? 30 : 225));
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) out[y * w + x] = cells[Math.floor(y / cell) * cols + Math.floor(x / cell)];
  }
  return out;
}

// A plain grey frame with `patch` (pw x ph) drawn at (x, y); noise jitters
// every pixel a little, as a video encoder does.
function frame(patch, pw, ph, x, y, { noise = 0, seed = 1, bg = 128 } = {}) {
  const out = new Uint8Array(W * H).fill(bg);
  if (patch) {
    for (let j = 0; j < ph; j++) {
      for (let i = 0; i < pw; i++) {
        const fx = Math.round(x) + i;
        const fy = Math.round(y) + j;
        if (fx >= 0 && fx < W && fy >= 0 && fy < H) out[fy * W + fx] = patch[j * pw + i];
      }
    }
  }
  if (noise) {
    const rnd = random(seed);
    for (let i = 0; i < out.length; i++) out[i] = Math.max(0, Math.min(255, out[i] + Math.round((rnd() - 0.5) * 2 * noise)));
  }
  return out;
}

test('a textured patch moving at a known speed is followed to within a pixel', () => {
  const patch = texture(60, 30, 4, 7);
  const tracker = createTracker({ width: W, height: H });
  // The box is a little bigger than the patch, as a person draws it.
  const box = { x: 16, y: 36, w: 68, h: 38 };
  const first = tracker.start(frame(patch, 60, 30, 20, 40, { noise: 4 }), box);
  assert.ok(first.detail > MIN_DETAIL, `detail ${first.detail}`);
  assert.deepStrictEqual([first.x, first.y], [16, 36]);
  for (let i = 1; i <= 60; i++) {
    const x = 20 + 3 * i;
    const y = 40 + 1.5 * i;
    const r = tracker.step(frame(patch, 60, 30, x, y, { noise: 4, seed: i + 1 }));
    assert.ok(r.score > LOST_SCORE, `frame ${i}: score ${r.score}`);
    near(r.x, Math.round(x) - 4, 1, `frame ${i} x`);
    near(r.y, Math.round(y) - 4, 1, `frame ${i} y`);
  }
});

test('a fast move inside the search window is found; the box keeps its fractional offset', () => {
  const patch = texture(40, 40, 3, 11);
  const tracker = createTracker({ width: W, height: H });
  tracker.start(frame(patch, 40, 40, 100, 60), { x: 100.4, y: 59.6, w: 40, h: 40 });
  const r = tracker.step(frame(patch, 40, 40, 100 + 45, 60 - 40));
  near(r.x, 145.4, 1e-9, 'x');
  near(r.y, 19.6, 1e-9, 'y');
  assert.ok(r.score > 0.9);
});

test('a patch that vanishes scores under the lost threshold, and the box stays where it was', () => {
  const patch = texture(60, 30, 4, 3);
  const tracker = createTracker({ width: W, height: H });
  tracker.start(frame(patch, 60, 30, 50, 50), { x: 50, y: 50, w: 60, h: 30 });
  const seen = tracker.step(frame(patch, 60, 30, 54, 50));
  assert.ok(seen.score > 0.9);
  const gone = tracker.step(frame(null, 0, 0, 0, 0, { noise: 4 }));
  assert.ok(gone.score < LOST_SCORE, `score ${gone.score}`);
  assert.deepStrictEqual([gone.x, gone.y], [seen.x, seen.y]);
  // A different picture in its place is not it either.
  const other = tracker.step(frame(texture(60, 30, 4, 99), 60, 30, 54, 50));
  assert.ok(other.score < LOST_SCORE, `score ${other.score}`);
});

test('a still scene never makes the box drift, even with noise, even over a blank area', () => {
  const patch = texture(60, 30, 4, 5);
  const tracker = createTracker({ width: W, height: H });
  tracker.start(frame(patch, 60, 30, 120, 80, { noise: 6 }), { x: 118, y: 78, w: 64, h: 34 });
  for (let i = 0; i < 80; i++) {
    const r = tracker.step(frame(patch, 60, 30, 120, 80, { noise: 6, seed: i + 2 }));
    assert.deepStrictEqual([r.x, r.y], [118, 78], `frame ${i}`);
    assert.ok(r.score > 0.8);
  }
  const blank = createTracker({ width: W, height: H });
  const first = blank.start(frame(null, 0, 0, 0, 0), { x: 40, y: 40, w: 50, h: 20 });
  assert.ok(first.detail < MIN_DETAIL, 'nothing to hold on to, and it says so');
  for (let i = 0; i < 10; i++) {
    const r = blank.step(frame(null, 0, 0, 0, 0, { noise: 2, seed: i }));
    assert.deepStrictEqual([r.x, r.y], [40, 40]);
  }
});

test('slow change in what is followed is tolerated: the remembered picture is refreshed', () => {
  const a = texture(60, 30, 4, 21);
  const b = texture(60, 30, 4, 22);
  const tracker = createTracker({ width: W, height: H });
  tracker.start(frame(a, 60, 30, 30, 90), { x: 30, y: 90, w: 60, h: 30 });
  // Over 150 frames the patch turns from one texture into another while moving.
  let last;
  for (let i = 1; i <= 150; i++) {
    const k = i / 150;
    const mixed = a.map((v, j) => Math.round(v * (1 - k) + b[j] * k));
    last = tracker.step(frame(mixed, 60, 30, 30 + i, 90));
    assert.ok(last.score > LOST_SCORE, `frame ${i}: score ${last.score}`);
  }
  near(last.x, 180, 1, 'x');
  near(last.y, 90, 1, 'y');
});

test('a box that is off the picture or too small has nothing to follow', () => {
  const tracker = createTracker({ width: W, height: H });
  const r = tracker.start(frame(texture(60, 30, 4, 1), 60, 30, 0, 0), { x: -30, y: 10, w: 32, h: 20 });
  assert.strictEqual(r.detail, 0);
  assert.strictEqual(tracker.step(frame(null, 0, 0, 0, 0)).score, 0);
  assert.throws(() => createTracker({ width: 0, height: 10 }));
});

test('a box partly off the picture follows the part that is on it', () => {
  const patch = texture(60, 30, 4, 8);
  const tracker = createTracker({ width: W, height: H });
  tracker.start(frame(patch, 60, 30, -20, 50), { x: -20, y: 50, w: 60, h: 30 });
  const r = tracker.step(frame(patch, 60, 30, -8, 56));
  near(r.x, -8, 1, 'x');
  near(r.y, 56, 1, 'y');
});

// ---------------------------------------------------------------- paths

test('positionAt: straight lines between keyframes, held before the first and after the last', () => {
  const path = [{ t: 2, x: 0.1, y: 0.2 }, { t: 4, x: 0.3, y: 0.2 }, { t: 5, x: 0.3, y: 0.6 }];
  assert.deepStrictEqual(positionAt(path, 0), { x: 0.1, y: 0.2 });
  assert.deepStrictEqual(positionAt(path, 2), { x: 0.1, y: 0.2 });
  const mid = positionAt(path, 3);
  near(mid.x, 0.2, 1e-9);
  near(mid.y, 0.2, 1e-9);
  const late = positionAt(path, 4.75);
  near(late.x, 0.3, 1e-9);
  near(late.y, 0.5, 1e-9);
  assert.deepStrictEqual(positionAt(path, 9), { x: 0.3, y: 0.6 });
  assert.deepStrictEqual(positionAt([{ t: 1, x: 0.5, y: 0.5 }], 7), { x: 0.5, y: 0.5 });
});

test('simplifyPath keeps the corners of a path and drops what lies on the lines between', () => {
  const points = [];
  for (let i = 0; i <= 100; i++) points.push({ t: i / 10, x: 0.1 + 0.004 * i, y: 0.2 });
  for (let i = 1; i <= 100; i++) points.push({ t: 10 + i / 10, x: 0.5, y: 0.2 + 0.003 * i });
  const out = simplifyPath(points, 0.001);
  assert.deepStrictEqual(out.map((p) => p.t), [0, 10, 20]);
  // Every original point is within the tolerance of the thinned path.
  for (const p of points) {
    const q = positionAt(out, p.t);
    assert.ok(Math.hypot(q.x - p.x, q.y - p.y) <= 0.001 + 1e-12);
  }
  // A point that moves at a changing speed along a line is not on the
  // straight-in-time line, so it is kept.
  const eased = Array.from({ length: 51 }, (_, i) => ({ t: i / 50, x: (i / 50) ** 2, y: 0 }));
  const thinned = simplifyPath(eased, 0.01);
  assert.ok(thinned.length > 2 && thinned.length < 20, `${thinned.length} points`);
  for (const p of eased) near(positionAt(thinned, p.t).x, p.x, 0.01 + 1e-12);
});

test('simplifyPath: short paths pass through; `max` widens the tolerance until few enough are left', () => {
  assert.deepStrictEqual(simplifyPath([], 0.1), []);
  assert.deepStrictEqual(simplifyPath([{ t: 0, x: 1, y: 2, score: 1 }], 0.1), [{ t: 0, x: 1, y: 2 }]);
  const rnd = random(4);
  const wild = Array.from({ length: 5000 }, (_, i) => ({ t: i / 60, x: rnd(), y: rnd() }));
  const out = simplifyPath(wild, 0.0001, { max: 300 });
  assert.ok(out.length <= 300 && out.length >= 2, `${out.length} points`);
  assert.strictEqual(out[0].t, 0);
  assert.strictEqual(out.at(-1).t, wild.at(-1).t);
  for (let i = 1; i < out.length; i++) assert.ok(out[i].t > out[i - 1].t);
});

test('shiftPath moves every point by the same amount', () => {
  assert.deepStrictEqual(shiftPath([{ t: 1, x: 0.25, y: 0.5 }, { t: 2, x: 0.5, y: 0.5 }], 0.25, -0.25),
    [{ t: 1, x: 0.5, y: 0.25 }, { t: 2, x: 0.75, y: 0.25 }]);
});

// ---------------------------------------------------------------- the project

const MAIN = { width: 1600, height: 1000, duration: 10 };
function project() {
  const p = P.createProject({ main: MAIN });
  return P.setStyle(p, { padding: 0, radius: 0, shadow: 0, background: { type: 'none', value: null }, cursor: { show: false } });
}
const PATH = [{ t: 2, x: 0.2, y: 0.7 }, { t: 4, x: 0.4, y: 0.7 }, { t: 6, x: 0.4, y: 0.3 }];

test('a hidden area may carry a path to follow; it survives saving and loading', () => {
  let p = P.addAnnotation(project(), { type: 'blur', start: 2, end: 8, x: 0.2, y: 0.7, w: 0.3, h: 0.1 });
  const id = p.annotations[0].id;
  assert.ok(!('path' in p.annotations[0]) && !('follow' in p.annotations[0]), 'none unless asked for');
  p = P.updateAnnotation(p, id, { follow: true, path: PATH });
  assert.deepStrictEqual(p.annotations[0].path, PATH);
  assert.strictEqual(p.annotations[0].follow, true);
  const loaded = P.loadProjectData(JSON.parse(JSON.stringify(p)));
  assert.strictEqual(loaded.version, 2);
  assert.deepStrictEqual(loaded.annotations[0].path, PATH);
  // Stop following: the path is gone, not left behind as an empty field.
  p = P.updateAnnotation(p, id, { follow: undefined, path: undefined });
  assert.ok(!('path' in p.annotations[0]) && !('follow' in p.annotations[0]));
  assert.deepStrictEqual([p.annotations[0].x, p.annotations[0].y], [0.2, 0.7]);
});

test('a path that is not well formed is refused', () => {
  const p = P.addAnnotation(project(), { type: 'blur', start: 2, end: 8, x: 0.2, y: 0.7, w: 0.3, h: 0.1 });
  const id = p.annotations[0].id;
  const bad = (patch, why) => assert.throws(() => P.updateAnnotation(p, id, patch), /follow|path/i, why);
  bad({ path: 'no' }, 'not a list');
  bad({ path: [] }, 'empty');
  bad({ path: [{ t: 1, x: 0.1 }] }, 'a point without y');
  bad({ path: [{ t: 1, x: 0.1, y: NaN }] }, 'not a number');
  bad({ path: [{ t: -1, x: 0.1, y: 0.1 }] }, 'before the recording');
  bad({ path: [{ t: 1, x: 5, y: 0.1 }] }, 'far off the picture');
  bad({ path: [{ t: 2, x: 0.1, y: 0.1 }, { t: 2, x: 0.2, y: 0.1 }] }, 'not in time order');
  bad({ path: [{ t: 3, x: 0.1, y: 0.1 }, { t: 2, x: 0.2, y: 0.1 }] }, 'backwards');
  bad({ path: [null] }, 'not a point');
  bad({ follow: 'yes', path: PATH }, 'follow is true or false');
  bad({ path: Array.from({ length: MAX_PATH_POINTS + 1 }, (_, i) => ({ t: i, x: 0, y: 0 })) }, 'too many points');
  // Only hidden areas follow.
  const q = P.addAnnotation(project(), { type: 'box', start: 2, end: 8 });
  assert.throws(() => P.updateAnnotation(q, q.annotations[0].id, { follow: true, path: PATH }), /hidden area/);
  assert.throws(() => P.loadProjectData({ ...JSON.parse(JSON.stringify(q)), annotations: [{ ...q.annotations[0], path: PATH }] }));
  // The most allowed is fine.
  P.updateAnnotation(p, id, { follow: true, path: Array.from({ length: MAX_PATH_POINTS }, (_, i) => ({ t: i / 100, x: 0, y: 0 })) });
});

test('a followed hidden area is drawn where its path puts it at that moment', () => {
  let p = P.addAnnotation(project(), { type: 'blur', start: 2, end: 8, x: 0.2, y: 0.7, w: 0.3, h: 0.1 });
  p = P.updateAnnotation(p, p.annotations[0].id, { follow: true, path: PATH });
  const tl = buildTimeline(p);
  const at = (outT) => {
    const ctx = mockContext();
    const state = drawFrame(ctx, { project: p, tl, outT, frames: { main: { displayWidth: 3200, displayHeight: 2000 } }, size: exportSize(p), assets: {} });
    return { state, box: A.annotationGeometry(ctx, state, p.annotations[0]).box };
  };
  const { state, box: first } = at(2);
  const W0 = state.content.w;
  const H0 = state.content.h;
  near(first.x - state.content.x, 0.2 * W0, 0.01, 'x at the start');
  near(first.y - state.content.y, 0.7 * H0, 0.01, 'y at the start');
  near(first.w, 0.3 * W0, 0.01, 'the size is the annotation\'s');
  const mid = at(3).box;
  near(mid.x - state.content.x, 0.3 * W0, 0.01, 'halfway along the first leg');
  const corner = at(5).box;
  near(corner.x - state.content.x, 0.4 * W0, 0.01, 'x on the second leg');
  near(corner.y - state.content.y, 0.5 * H0, 0.01, 'y on the second leg');
  const after = at(7.5).box;
  near(after.y - state.content.y, 0.3 * H0, 0.01, 'held at the last point');
  // Without a path it stays put, as before.
  const q = P.updateAnnotation(p, p.annotations[0].id, { follow: undefined, path: undefined });
  const ctx = mockContext();
  const s = drawFrame(ctx, { project: q, tl: buildTimeline(q), outT: 5, frames: { main: { displayWidth: 3200, displayHeight: 2000 } }, size: exportSize(q), assets: {} });
  near(A.annotationGeometry(ctx, s, q.annotations[0]).box.x - s.content.x, 0.2 * s.content.w, 0.01, 'x without a path');
});
