// A clip's finer colour tools: warmth, tint, highlights, shadows, a curve,
// dark corners, sharpening (src/core/grade.js; validated in project.js;
// the shader in layers/lut-gl.js mirrors gradePixel).
import test from 'node:test';
import assert from 'node:assert/strict';
import * as P from '../src/core/project.js';
import { clipColor, isPlain } from '../src/core/look.js';
import {
  IDENTITY_CURVE, MAX_CURVE_POINTS, curvePoints, isIdentityCurve, evalCurve, curveTable, whiteBalance, toneWeights,
  luma, needsGrade, gradePixel, vignetteStops, histogram, addCurvePoint, moveCurvePoint, removeCurvePoint
} from '../src/core/grade.js';

const near = (a, b, eps, what) => assert.ok(Math.abs(a - b) <= eps, `${what}: ${a} vs ${b}`);
const S = [{ x: 0, y: 0 }, { x: 0.25, y: 0.15 }, { x: 0.75, y: 0.85 }, { x: 1, y: 1 }];

test('a clip without the new settings: all at rest, nothing to grade', () => {
  const c = clipColor({ id: 'c1' });
  assert.deepEqual([c.temperature, c.tint, c.highlights, c.shadows, c.vignette, c.sharpen, c.curve], [0, 0, 0, 0, 0, 0, null]);
  assert.equal(needsGrade(c), false);
  assert.equal(needsGrade({ brightness: 0.4, filter: 'bw' }), false, 'the older settings are not this pass’s');
  assert.equal(needsGrade({ ...c, curve: IDENTITY_CURVE.map((p) => ({ ...p })) }), false, 'a straight curve is no curve');
  for (const [r, g, b] of [[0, 0, 0], [0.2, 0.5, 0.9], [1, 1, 1]]) assert.deepEqual(gradePixel([r, g, b], c), [r, g, b]);
  for (const k of ['temperature', 'tint', 'highlights', 'shadows', 'sharpen']) assert.equal(needsGrade({ ...c, [k]: 0.1 }), true, k);
  assert.equal(needsGrade({ ...c, curve: S }), true);
  assert.equal(needsGrade({ ...c, vignette: 0.5 }), false, 'dark corners are drawn over the picture, not in the pass');
  assert.equal(isPlain({ id: 'c1', color: { vignette: 0.5 } }), false, 'but the clip is no longer plain');
  assert.equal(isPlain({ id: 'c1', color: { temperature: 0.2 } }), false);
  assert.equal(isPlain({ id: 'c1', color: { curve: S } }), false);
  assert.equal(isPlain({ id: 'c1', color: { temperature: 0, curve: null } }), true);
});

test('the curve: a straight one returns what goes in', () => {
  assert.deepEqual(curvePoints(null), IDENTITY_CURVE);
  assert.deepEqual(curvePoints(undefined), IDENTITY_CURVE);
  assert.equal(isIdentityCurve(null), true);
  assert.equal(isIdentityCurve(S), false);
  for (let k = 0; k <= 20; k++) near(evalCurve(IDENTITY_CURVE, k / 20), k / 20, 1e-12, `identity at ${k / 20}`);
  const table = curveTable(IDENTITY_CURVE);
  assert.equal(table.length, 256);
  near(table[0], 0, 1e-6, 'black');
  near(table[128], 128 / 255, 1e-6, 'the middle');
  near(table[255], 1, 1e-6, 'white');
});

test('the curve: an S darkens the darks and brightens the brights, smoothly and never backwards', () => {
  assert.ok(evalCurve(S, 0.2) < 0.2 - 0.03, `darks darker: ${evalCurve(S, 0.2)}`);
  assert.ok(evalCurve(S, 0.8) > 0.8 + 0.03, `brights brighter: ${evalCurve(S, 0.8)}`);
  near(evalCurve(S, 0.5), 0.5, 1e-9, 'the middle stays');
  for (const p of S) near(evalCurve(S, p.x), p.y, 1e-12, 'through its points');
  let last = -1;
  for (let k = 0; k <= 200; k++) {
    const y = evalCurve(S, k / 200);
    assert.ok(y >= last - 1e-12, `never turns back (${k / 200})`);
    assert.ok(y >= 0 && y <= 1);
    last = y;
  }
  // A steep step between two points must not overshoot (monotone, not a plain spline).
  const step = [{ x: 0, y: 0 }, { x: 0.45, y: 0.02 }, { x: 0.55, y: 0.98 }, { x: 1, y: 1 }];
  for (let k = 0; k <= 200; k++) {
    const y = evalCurve(step, k / 200);
    assert.ok(y >= -1e-12 && y <= 1 + 1e-12, `no overshoot at ${k / 200}: ${y}`);
  }
  // Left of the first point and right of the last it is flat.
  const lifted = [{ x: 0.2, y: 0.1 }, { x: 0.8, y: 0.9 }];
  assert.equal(evalCurve(lifted, 0), 0.1);
  assert.equal(evalCurve(lifted, 1), 0.9);
  const [r, g, b] = gradePixel([0.2, 0.5, 0.8], { curve: S });
  assert.ok(r < 0.2 && b > 0.8, 'on each of red, green and blue');
  near(g, 0.5, 1e-9, 'green in the middle');
});

test('editing the curve: points are added in order, move between their neighbours, and the ends stay', () => {
  const added = addCurvePoint(IDENTITY_CURVE, 0.5, 0.7);
  let { points } = added;
  const { index } = added;
  assert.equal(index, 1);
  assert.deepEqual(points, [{ x: 0, y: 0 }, { x: 0.5, y: 0.7 }, { x: 1, y: 1 }]);
  assert.deepEqual(IDENTITY_CURVE, [{ x: 0, y: 0 }, { x: 1, y: 1 }], 'the original untouched');
  points = moveCurvePoint(points, 1, 2, -3);
  assert.ok(points[1].x < 1 && points[1].x > 0.9 && points[1].y === 0, `kept left of the next point and inside: ${JSON.stringify(points[1])}`);
  points = moveCurvePoint(points, 0, 0.4, 0.3);
  assert.deepEqual(points[0], { x: 0, y: 0.3 }, 'an end moves up and down only');
  assert.deepEqual(removeCurvePoint(points, 0), points, 'the ends can’t be removed');
  assert.equal(removeCurvePoint(points, 1).length, 2);
  let full = IDENTITY_CURVE;
  for (let k = 1; k < MAX_CURVE_POINTS - 1; k++) full = addCurvePoint(full, k / MAX_CURVE_POINTS, 0.5).points;
  assert.equal(full.length, MAX_CURVE_POINTS);
  assert.equal(addCurvePoint(full, 0.99, 0.5), null, 'no more than 8');
  assert.equal(addCurvePoint(IDENTITY_CURVE, 0, 0.5), null, 'not on top of another');
});

test('warmth raises red against blue; tint moves green against red and blue; greys keep their brightness', () => {
  assert.deepEqual(whiteBalance(0, 0), [1, 1, 1]);
  const warm = whiteBalance(0.6, 0);
  assert.ok(warm[0] > 1 && warm[2] < 1 && warm[0] / warm[2] > 1.3, `warm: ${warm}`);
  const cold = whiteBalance(-0.6, 0);
  assert.ok(cold[2] > cold[0], `cold: ${cold}`);
  const magenta = whiteBalance(0, 0.6);
  assert.ok(magenta[1] < magenta[0] && magenta[1] < magenta[2], `towards magenta: ${magenta}`);
  const green = whiteBalance(0, -0.6);
  assert.ok(green[1] > green[0], `towards green: ${green}`);
  for (const g of [warm, cold, magenta, green, whiteBalance(1, 1), whiteBalance(-1, -1)]) near(luma(g), 1, 1e-9, 'a grey as bright as before');
  const grey = [0.5, 0.5, 0.5];
  const out = gradePixel(grey, { temperature: 0.6 });
  assert.ok(out[0] > grey[0] && out[2] < grey[2], `a grey pixel warmed: ${out}`);
  const coldOut = gradePixel(grey, { temperature: -0.6 });
  assert.ok(coldOut[0] / coldOut[2] < out[0] / out[2]);
});

test('brightening shadows lifts dark pixels far more than bright ones; highlights the other way round', () => {
  const w = toneWeights(0.1);
  assert.ok(w.shadows > 0.75 && w.highlights < 0.05, JSON.stringify(w));
  assert.ok(toneWeights(0.9).highlights > 0.75 && toneWeights(0.9).shadows < 0.05);
  const lift = (v, color) => gradePixel([v, v, v], color)[0] - v;
  const dark = lift(0.1, { shadows: 1 });
  const bright = lift(0.9, { shadows: 1 });
  assert.ok(dark > 0.2, `a dark pixel lifted: ${dark}`);
  assert.ok(bright >= 0 && bright < dark / 20, `a bright one hardly: ${bright}`);
  assert.ok(lift(0.1, { shadows: -1 }) < 0, 'and darkened the other way');
  const hiBright = lift(0.8, { highlights: -1 });
  const hiDark = lift(0.1, { highlights: -1 });
  assert.ok(hiBright < -0.2 && Math.abs(hiDark) < Math.abs(hiBright) / 20, `highlights pulled down: ${hiBright}, darks left: ${hiDark}`);
  for (const v of [0, 0.3, 1]) for (const c of gradePixel([v, v, v], { shadows: 1, highlights: 1 })) assert.ok(c >= 0 && c <= 1, 'kept in range');
});

test('dark corners: clear in the middle, darkest at the corners, darker with more', () => {
  assert.deepEqual(vignetteStops(0), []);
  const stops = vignetteStops(0.5);
  assert.equal(stops[0][1], 0, 'clear in the middle');
  assert.ok(stops.at(-1)[0] === 1 && stops.at(-1)[1] > 0.3);
  for (let i = 1; i < stops.length; i++) assert.ok(stops[i][0] > stops[i - 1][0] && stops[i][1] >= stops[i - 1][1]);
  assert.ok(vignetteStops(1).at(-1)[1] > stops.at(-1)[1]);
  assert.ok(vignetteStops(1).at(-1)[1] <= 1);
});

test('the histogram counts how many pixels are at each brightness', () => {
  // Two black pixels, one white, one mid grey (RGBA bytes).
  const data = new Uint8ClampedArray([0, 0, 0, 255, 0, 0, 0, 255, 255, 255, 255, 255, 128, 128, 128, 255]);
  const bins = histogram(data, 4);
  assert.deepEqual([...bins], [2, 0, 1, 1]);
  assert.equal(histogram(data).length, 64);
});

test('the project checks the new settings; older projects open unchanged; Reset colour clears them', () => {
  let p = P.createProject({ main: { width: 100, height: 100, duration: 10 } });
  const id = p.clips[0].id;
  // A project from before these settings.
  const old = P.setClipLook(p, id, { color: { brightness: 0.2, filter: 'warm', lut: null, lutMix: 1 } });
  const opened = P.validateProject(JSON.parse(JSON.stringify(old)));
  assert.deepEqual(opened.clips[0].color, { brightness: 0.2, filter: 'warm', lut: null, lutMix: 1 });
  assert.equal(opened.version, 2);
  p = P.setClipLook(p, id, { color: { temperature: 0.4, tint: -0.2, highlights: -0.5, shadows: 0.5, vignette: 0.3, sharpen: 0.6, curve: S } });
  assert.deepEqual(clipColor(p.clips[0]).curve, S);
  assert.equal(clipColor(p.clips[0]).temperature, 0.4);
  const bad = (color, re) => assert.throws(() => P.setClipLook(p, id, { color }), re);
  bad({ temperature: 2 }, /Warmth must be a number from -1 to 1/);
  bad({ tint: 'green' }, /Tint must be a number from -1 to 1/);
  bad({ highlights: -3 }, /Highlights must be a number from -1 to 1/);
  bad({ shadows: 1.5 }, /Shadows must be a number from -1 to 1/);
  bad({ vignette: -0.1 }, /Dark corners must be a number from 0 to 1/);
  bad({ sharpen: 2 }, /Sharpen must be a number from 0 to 1/);
  bad({ curve: 'steep' }, /curve must be a list of 2 to 8 points/);
  bad({ curve: [{ x: 0, y: 0 }] }, /curve must be a list of 2 to 8 points/);
  bad({ curve: Array.from({ length: 9 }, (_, k) => ({ x: k / 8, y: k / 8 })) }, /curve must be a list of 2 to 8 points/);
  bad({ curve: [{ x: 0, y: 0 }, { x: 0.6, y: 0.5 }, { x: 0.4, y: 0.7 }, { x: 1, y: 1 }] }, /points must go from left to right/);
  bad({ curve: [{ x: 0, y: 0 }, { x: 1, y: 1.4 }] }, /Curve point height must be a number from 0 to 1/);
  bad({ curve: [{ x: 0, y: 0 }, 5] }, /curve point is not an object/);
  assert.equal(P.setClipLook(p, id, { color: { curve: null } }).clips[0].color.curve, null, 'no curve is fine');
  p = P.setClipLook(p, id, { color: null });
  assert.equal(p.clips[0].color, undefined);
  assert.equal(isPlain(p.clips[0]), true, 'Reset colour: as recorded again');
});
