// Freeze frames and reversed clips (src/core/timeline.js, src/core/project.js).
import test from 'node:test';
import assert from 'node:assert/strict';
import * as P from '../src/core/project.js';
import { buildTimeline } from '../src/core/timeline.js';

const project = (duration = 10) => P.createProject({ main: { width: 100, height: 100, duration, mic: true } });
const near = (a, b, eps = 1e-6, what = '') => assert.ok(Math.abs(a - b) <= eps, `${what} ${a} vs ${b}`);

test('a freeze frame holds one moment for its seconds, splitting the clip it lands in', () => {
  let p = P.freezeFrame(project(10), 4, 2);
  assert.deepEqual(p.clips.map((c) => [c.start, c.end, c.hold ?? null]), [[0, 4, null], [4, 4, 2], [4, 10, null]]);
  const tl = buildTimeline(p);
  near(tl.duration, 12);
  for (const o of [4, 4.5, 5.99]) {
    const at = tl.toSource(o);
    assert.equal(at.clipIndex, 1);
    near(at.t, 4, 1e-9, `held at ${o}`);
  }
  near(tl.toSource(6.5).t, 4.5, 1e-9, 'then the video carries on');
  near(tl.toOutput('main', 4.5), 6.5, 1e-9, 'moments map past the hold');
  // Silent while held: no sound slice covers it.
  const plan = tl.audioPlan();
  assert.ok(plan.every((s) => s.outStart + (s.srcEnd - s.srcStart) / s.rate <= 4 + 1e-9 || s.outStart >= 6 - 1e-9));
  // Frames while held all show the moment.
  const frames = tl.framePlan(10).slice(40, 60);
  assert.ok(frames.every((f) => Math.abs(f.t - 4) < 1e-9));
  // At the very start: a hold before the first clip.
  p = P.freezeFrame(project(10), 0, 1);
  assert.deepEqual(p.clips.map((c) => c.hold ?? null), [1, null]);
});

test('a freeze frame is trimmed, split and cut by its seconds', () => {
  let p = P.freezeFrame(project(10), 4, 2);
  const hold = p.clips[1];
  p = P.setHold(p, hold.id, 3);
  near(buildTimeline(p).duration, 13);
  assert.throws(() => P.setHold(p, hold.id, 0), /Freeze/);
  p = P.splitAt(p, 5);
  assert.deepEqual(p.clips.map((c) => c.hold ?? null), [null, 1, 2, null]);
  p = P.cutRange(p, 4.5, 6);
  assert.deepEqual(p.clips.map((c) => c.hold ?? null), [null, 0.5, 1, null]);
  near(buildTimeline(p).duration, 11.5);
});

test('a reversed clip plays its moments backwards, silently, and maps both ways', () => {
  let p = P.cutRange(project(10), 4, 6); // 0-4, 6-10
  p = P.setClipReverse(p, p.clips[1].id, true);
  const tl = buildTimeline(p);
  near(tl.duration, 8);
  near(tl.toSource(4).t, 10, 1e-9, 'starts at its end');
  near(tl.toSource(5).t, 9, 1e-9);
  near(tl.toSource(7.999).t, 6.001, 1e-6, 'ends at its start');
  near(tl.toOutput('main', 9), 5, 1e-9);
  assert.ok(tl.audioPlan().every((s) => s.srcStart < 4 + 1e-9), 'its sound is left out');
  assert.equal(P.setClipReverse(p, p.clips[1].id, false).clips[1].reverse, false);
  assert.throws(() => P.setClipReverse(P.freezeFrame(project(), 2, 1), P.freezeFrame(project(), 2, 1).clips[1].id, true), /freeze/i);
});
