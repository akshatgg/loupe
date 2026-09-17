import test from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'node:module';
import * as P from '../src/core/project.js';
import { buildTimeline, buildSpeedMap, mapToOutput, mapToSource } from '../src/core/timeline.js';

const require = createRequire(import.meta.url);
const timemap = require('../src/main/timemap.js');
const speed = require('../src/main/speed.js');

const near = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} !== ${b}`);
const MAIN = { width: 1600, height: 1000, duration: 20 };
const fresh = () => P.createProject({ main: MAIN });

test('with one clip and no speed, output time is source time', () => {
  const tl = buildTimeline(fresh());
  near(tl.duration, 20);
  for (const t of [0, 0.5, 7.25, 19.99]) {
    assert.deepStrictEqual(tl.toSource(t), { clipIndex: 0, source: 'main', t });
    near(tl.toOutput('main', t), t);
  }
  assert.deepStrictEqual(tl.toSource(25), { clipIndex: 0, source: 'main', t: 20 });
  assert.deepStrictEqual(tl.toSource(-1), { clipIndex: 0, source: 'main', t: 0 });
  assert.deepStrictEqual(tl.clipBounds(), [{ clipIndex: 0, outStart: 0, outEnd: 20 }]);
});

test('speed maps match v1 timemap.js, ramps included', () => {
  const v1 = [
    { srcStart: 1, srcEnd: 4, rate: 3 }, { srcStart: 4, srcEnd: 4.3, rate: 0.5 },
    { srcStart: 6, srcEnd: 6.25, rate: 8 }, { srcStart: 10, srcEnd: 19, rate: 0.25 }
  ];
  const map = timemap.buildMap(v1, 20);
  const mine = buildSpeedMap(v1.map((s) => ({ start: s.srcStart, end: s.srcEnd, rate: s.rate })), 20);
  near(mine.outputDuration, map.outputDuration, 1e-9);
  for (let t = 0; t <= 20; t += 0.0173) {
    near(mapToOutput(mine, t), timemap.toOutput(map, t), 1e-9);
    near(mapToSource(mine, mapToOutput(mine, t)), t, 1e-9);
  }
});

test('the frame plan of a speed-only project matches v1 speed.js retimePlan', () => {
  const segs = [{ srcStart: 2, srcEnd: 6, rate: 4 }, { srcStart: 8, srcEnd: 9.5, rate: 0.5 }];
  const v1 = speed.retimePlan(segs, 20, 200, 60);
  let p = fresh();
  for (const s of segs) p = P.paintSpeed(p, { start: s.srcStart, end: s.srcEnd, rate: s.rate });
  const tl = buildTimeline(p);
  near(tl.duration, v1.outputDuration, 1e-9);
  const plan = tl.framePlan(60);
  assert.strictEqual(plan.length, v1.frames.length);
  plan.forEach((f, k) => near(f.t, v1.frames[k], 1e-6));
});

test('the audio plan matches v1 speed.js slices and adds up to the video', () => {
  const segs = [{ srcStart: 2, srcEnd: 6, rate: 4 }];
  const v1 = speed.retimePlan(segs, 20, 200, 60);
  const p = P.paintSpeed(fresh(), { start: 2, end: 6, rate: 4 });
  const tl = buildTimeline(p);
  const plan = tl.audioPlan();
  // v1 lists only the segment's slices; outside it everything is 1x.
  const fast = plan.filter((s) => s.rate !== 1);
  assert.strictEqual(fast.length, v1.audio.filter((s) => Math.abs(s.rate - 1) > 1e-12).length);
  for (const s of fast) {
    const match = v1.audio.find((a) => Math.abs(a.srcStart - s.srcStart) < 1e-9);
    assert.ok(match, `no v1 slice at ${s.srcStart}`);
    near(s.srcEnd, match.srcEnd, 1e-9);
    near(s.rate, match.rate, 1e-6);
  }
  const total = plan.reduce((sum, s) => sum + (s.srcEnd - s.srcStart) / s.rate, 0);
  near(total, tl.duration, 1e-9);
  // Contiguous in output time.
  for (let i = 1; i < plan.length; i++) {
    const prev = plan[i - 1];
    near(plan[i].outStart, prev.outStart + (prev.srcEnd - prev.srcStart) / prev.rate, 1e-9);
  }
});

test('cuts, speed and reordering round-trip between output and source time', () => {
  let p = P.appendRecording(fresh(), 'src2', { width: 800, height: 600, duration: 6 });
  p = P.paintSpeed(p, { start: 3, end: 9, rate: 2 });
  p = P.paintSpeed(p, { source: 'src2', start: 1, end: 3, rate: 0.5 });
  p = P.cutRange(p, 1, 2);
  p = P.splitAt(p, 8);
  p = P.moveClip(p, 3, 0);
  const tl = buildTimeline(p);
  const bounds = tl.clipBounds();
  assert.strictEqual(bounds.length, 4);
  near(bounds.at(-1).outEnd, tl.duration);
  for (let i = 1; i < bounds.length; i++) near(bounds[i].outStart, bounds[i - 1].outEnd, 1e-12);
  for (let o = 0; o < tl.duration; o += 0.01) {
    const s = tl.toSource(o);
    const clip = p.clips[s.clipIndex];
    assert.ok(s.t >= clip.start - 1e-9 && s.t <= clip.end + 1e-9);
    near(tl.toOutput(s.source, s.t), o, 1e-6);
  }
  // Output 1..2 was cut before any reordering, while main played at 1x: that
  // is main's 1..2, which now has no output time.
  assert.strictEqual(tl.toOutput('main', 1.5), null);
  near(tl.toOutput('main', 0.5), bounds[1].outStart + 0.5, 1e-9);
  // The appended recording, moved first, plays first.
  assert.strictEqual(tl.toSource(0).source, 'src2');
});

test('clip boundaries belong to the next clip', () => {
  const p = P.moveClip(P.splitAt(fresh(), 5), 1, 0);
  const tl = buildTimeline(p);
  assert.deepStrictEqual(tl.toSource(15), { clipIndex: 1, source: 'main', t: 0 });
  near(tl.toSource(14.999999).t, 20, 1e-5);
  assert.deepStrictEqual(tl.toSource(20), { clipIndex: 1, source: 'main', t: 5 });
});

test('framePlan has one entry per output frame and follows clip order', () => {
  const p = P.moveClip(P.cutRange(fresh(), 10, 15), 1, 0);
  const tl = buildTimeline(p);
  const plan = tl.framePlan(30);
  assert.strictEqual(plan.length, Math.ceil(15 * 30));
  near(plan[0].t, 15);
  assert.strictEqual(plan[0].clipIndex, 0);
  near(plan[150].t, 0);
  assert.strictEqual(plan[150].clipIndex, 1);
  near(plan.at(-1).t, 10 - 1 / 30, 1e-9);
  assert.throws(() => tl.framePlan(0), /fps/);
});

test('an unknown source is an error, not a silent zero', () => {
  const p = fresh();
  assert.throws(() => buildTimeline({ ...p, clips: [{ id: 'c1', source: 'gone', start: 0, end: 1 }] }), /Unknown source/);
});
