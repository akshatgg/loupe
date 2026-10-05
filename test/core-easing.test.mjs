import test from 'node:test';
import assert from 'node:assert/strict';
import { valueAt, setKeyframeEase, KEYFRAME_EASES } from '../src/core/keyframes.js';
import { buildTimeline, buildSpeedMap, RAMP_SECONDS } from '../src/core/timeline.js';
import { solveCamera, cameraAt } from '../src/core/camera.js';
import * as P from '../src/core/project.js';

const near = (a, b, eps, what) => assert.ok(Math.abs(a - b) <= eps, `${what}: ${a} vs ${b}`);
const kf = (ease) => [{ t: 0, v: 0 }, ease ? { t: 1, v: 10, ease } : { t: 1, v: 10 }];

test('each easing shapes the way to a keyframe; all meet at both ends', () => {
  for (const ease of KEYFRAME_EASES) {
    near(valueAt(kf(ease), 0, 0), 0, 1e-9, `${ease} start`);
    near(valueAt(kf(ease), 1, 0), 10, 1e-9, `${ease} end`);
  }
  near(valueAt(kf('linear'), 0.25, 0), 2.5, 1e-9, 'linear');
  near(valueAt(kf('ease-in'), 0.5, 0), 2.5, 1e-9, 'ease-in is behind halfway');
  near(valueAt(kf('ease-out'), 0.5, 0), 7.5, 1e-9, 'ease-out is ahead halfway');
  near(valueAt(kf('hold'), 0.99, 0), 0, 1e-9, 'hold stays put');
  near(valueAt(kf(undefined), 0.5, 0), 5, 1e-9, 'smooth is halfway at half');
  assert.ok(valueAt(kf(undefined), 0.25, 0) < 2.5, 'smooth starts slowly');
  near(valueAt(kf('smooth'), 0.25, 0), valueAt(kf(undefined), 0.25, 0), 1e-12, 'smooth is the default');
});

test('setKeyframeEase changes one keyframe; smooth is stored as nothing', () => {
  const list = [{ t: 0, v: 0 }, { t: 1, v: 10 }, { t: 2, v: 5 }];
  const eased = setKeyframeEase(list, 1, 'hold');
  assert.deepEqual(eased, [{ t: 0, v: 0 }, { t: 1, v: 10, ease: 'hold' }, { t: 2, v: 5 }]);
  assert.deepEqual(setKeyframeEase(eased, 1, 'smooth'), list);
});

const base = () => P.createProject({ main: { width: 1920, height: 1080, duration: 20 }, createdAt: 0 });

test('a clip keyframe takes an easing, validated in plain words', () => {
  let p = base();
  const id = p.clips[0].id;
  p = P.setClipKeyframe(p, id, 'scale', 1, 1);
  p = P.setClipKeyframe(p, id, 'scale', 3, 2);
  p = P.setClipKeyframeEase(p, id, 'scale', 3, 'ease-out');
  assert.equal(p.clips[0].keyframes.scale[1].ease, 'ease-out');
  P.validateProject(JSON.parse(JSON.stringify(p)));
  assert.throws(() => P.setClipKeyframeEase(p, id, 'scale', 3, 'bouncy'), /Keyframe easing/);
  assert.throws(() => P.setClipKeyframeEase(p, id, 'x', 3, 'linear'), /no keyframe/);
});

test('a speed stretch keeps the usual ramps unless it has its own', () => {
  const usual = buildSpeedMap([{ start: 2, end: 6, rate: 2 }], 10);
  const same = buildSpeedMap([{ start: 2, end: 6, rate: 2, rampIn: RAMP_SECONDS, rampOut: RAMP_SECONDS }], 10);
  near(usual.outputDuration, same.outputDuration, 1e-12, 'explicit usual ramps change nothing');
  const sudden = buildSpeedMap([{ start: 2, end: 6, rate: 2, rampIn: 0, rampOut: 0 }], 10);
  near(sudden.outputDuration, 2 + 2 + 4, 1e-9, 'at once: exactly half the time');
  assert.equal(sudden.pieces.some((x) => x.table), false, 'no ramp pieces');
  const slowIn = buildSpeedMap([{ start: 2, end: 6, rate: 2, rampIn: 1.5, rampOut: 0 }], 10);
  assert.ok(slowIn.outputDuration > usual.outputDuration, 'a long ramp in takes longer to get there');
  assert.equal(slowIn.pieces.filter((x) => x.table).length, 1);
});

test('ramps longer than the stretch are scaled to fit it', () => {
  const map = buildSpeedMap([{ start: 2, end: 3, rate: 4, rampIn: 2, rampOut: 2 }], 10);
  const ramps = map.pieces.filter((x) => x.table);
  near(ramps[0].b - ramps[0].a, 0.5, 1e-9, 'half each');
  near(ramps[1].b - ramps[1].a, 0.5, 1e-9, 'half each');
  assert.ok(map.pieces.every((x) => x.b >= x.a));
});

test('setSpeedRamp shapes the stretches in a range and changes the video’s length', () => {
  let p = P.paintSpeed(base(), { start: 2, end: 6, rate: 2 });
  const before = buildTimeline(p).duration;
  p = P.setSpeedRamp(p, { start: 0, end: 20, rampIn: 0, rampOut: 0 });
  assert.equal(p.speed[0].rampIn, 0);
  near(buildTimeline(p).duration, 18, 1e-9, 'sudden');
  assert.ok(before > 18, 'the usual ramps took a little longer');
  p = P.setSpeedRamp(p, { start: 0, end: 20 });
  assert.equal('rampIn' in p.speed[0], false, 'back to the usual');
  assert.throws(() => P.setSpeedRamp(p, { start: 10, end: 12, rampIn: 1 }), /no speed change/);
  assert.throws(() => P.setSpeedRamp(p, { start: 0, end: 20, rampIn: 9 }), /ramp in/);
});

test('painting beside a shaped stretch keeps its shape and does not merge with it', () => {
  let p = P.paintSpeed(base(), { start: 2, end: 6, rate: 2 });
  p = P.setSpeedRamp(p, { start: 2, end: 6, rampIn: 1, rampOut: 0 });
  p = P.paintSpeed(p, { start: 6, end: 8, rate: 2 });
  assert.equal(p.speed.length, 2);
  assert.equal(p.speed[0].rampIn, 1);
  P.validateProject(JSON.parse(JSON.stringify(p)));
});

test('a snappy zoom gets there sooner than a smooth one, a gentle one later', () => {
  const at = (ease) => {
    const zooms = [{ id: 'z1', source: 'main', start: 2, end: 8, level: 3, follow: false, x: 960, y: 540, recorded: false, ...(ease ? { ease } : {}) }];
    const track = solveCamera({ zooms, cursorTrack: [{ t: 0, x: 960, y: 540 }], duration: 10, width: 1920, height: 1080 });
    return cameraAt(track, 2.15, { width: 1920, height: 1080 }).zoom;
  };
  assert.ok(at('snappy') > at(undefined) + 0.1, `snappy ${at('snappy')} vs smooth ${at(undefined)}`);
  assert.ok(at('gentle') < at(undefined) - 0.1, `gentle ${at('gentle')} vs smooth ${at(undefined)}`);
  near(at('smooth'), at(undefined), 1e-12, 'smooth is the default');
});

test('a zoom takes an easing; anything else is refused', () => {
  let p = P.addZoom(base(), { start: 1, end: 3 });
  p = P.updateZoom(p, 'z1', { ease: 'snappy' });
  assert.equal(P.validateProject(JSON.parse(JSON.stringify(p))).zooms[0].ease, 'snappy');
  assert.throws(() => P.updateZoom(p, 'z1', { ease: 'wobbly' }), /Zoom easing/);
});
