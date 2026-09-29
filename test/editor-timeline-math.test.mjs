// The editor timeline's arithmetic (src/renderer/editor/timeline-math.js) and
// store (store.js): output/source mapping across cuts, reorder and speed,
// zoom placement and room, snapping, ruler steps, undo through the store.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as P from '../src/core/project.js';
import { buildTimeline } from '../src/core/timeline.js';
import * as M from '../src/renderer/editor/timeline-math.js';
import { createStore } from '../src/renderer/editor/store.js';

const near = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} is not ${b}`);

function project() {
  return P.createProject({ main: { width: 1000, height: 600, duration: 20, video: 'raw.mov' }, createdAt: 0 });
}
const layoutOf = (p) => M.clipLayout(p, buildTimeline(p));

test('source <-> output inside a clip follows cuts, reorder and speed', () => {
  let p = P.cutRange(project(), 5, 10); // clips 0-5, 10-20
  let L = layoutOf(p);
  assert.equal(L.length, 2);
  near(M.outputInClip(p, L, 1, 12), 7);
  near(M.sourceInClip(p, L, 1, 7), 12);
  p = P.moveClip(p, 1, 0);
  L = layoutOf(p);
  near(M.outputInClip(p, L, 0, 12), 2);
  near(M.outputInClip(p, L, 1, 3), 13);
  p = P.paintSpeed(project(), { start: 0, end: 20, rate: 2 });
  L = layoutOf(p);
  const tl = buildTimeline(p);
  near(M.sourceInClip(p, L, 0, 5), tl.toSource(5).t, 1e-4);
  assert.equal(M.clipIndexAt(L, 1000), 0);
  near(M.rateAt(p, L, 5), 2, 1e-3);
});

test('a zoom shows once per clip it overlaps and not where it was cut', () => {
  let p = P.addZoom(project(), { start: 2, end: 14 });
  p = P.cutRange(p, 5, 10);
  const pieces = M.zoomPieces(p, layoutOf(p));
  assert.deepEqual(pieces.map((x) => [x.clipIndex, x.srcStart, x.srcEnd, x.outStart, x.outEnd]), [[0, 2, 5, 2, 5], [1, 10, 14, 5, 9]]);
  const speed = M.speedPieces(P.paintSpeed(p, { start: 1, end: 3, rate: 2 }), layoutOf(p));
  assert.equal(speed.length, 1);
});

test('new zooms stay inside their clip and out of other zooms', () => {
  let p = P.addZoom(project(), { start: 8, end: 10 });
  let L = layoutOf(p);
  assert.deepEqual(M.newZoomRange(p, L, 3), { source: 'main', start: 3, end: 5 });
  assert.equal(M.newZoomRange(p, L, 9), null, 'inside a zoom');
  // A click just before another zoom slides back to fit.
  assert.deepEqual(M.newZoomRange(p, L, 7.5), { source: 'main', start: 6, end: 8 });
  // A drag over the next zoom stops at it.
  assert.deepEqual(M.newZoomRange(p, L, 5, 12), { source: 'main', start: 5, end: 8 });
  p = P.cutRange(project(), 5, 10);
  L = layoutOf(p);
  assert.deepEqual(M.newZoomRange(p, L, 4, 7), { source: 'main', start: 4, end: 5 }, 'stops at the clip end');
  assert.equal(M.newZoomRange(p, L, 4.95, 4.96), null, 'too short');
});

test('moving and resizing a zoom keeps it in its room', () => {
  let p = P.addZoom(project(), { start: 2, end: 4 });
  p = P.addZoom(p, { start: 10, end: 12 });
  const [a, b] = p.zooms;
  assert.deepEqual(M.movedZoom(p, a, 9), { start: 8, end: 10 });
  assert.deepEqual(M.movedZoom(p, b, 1), { start: 4, end: 6 });
  assert.deepEqual(M.resizedZoom(p, a, 'end', 15), { start: 2, end: 10 });
  assert.deepEqual(M.resizedZoom(p, a, 'start', 3.99), { start: 3.9, end: 4 });
  assert.deepEqual(M.zoomRoom(p, 'main', 7), { lo: 4, hi: 10 });
});

test('snapping, reorder index, ruler steps and times', () => {
  assert.equal(M.snap(5.05, [0, 5, 9], 0.1), 5);
  assert.equal(M.snap(5.3, [0, 5, 9], 0.1), 5.3);
  const p = P.moveClip(P.splitAt(P.splitAt(project(), 5), 10), 0, 0);
  const L = layoutOf(p);
  assert.ok(M.snapPoints(p, L, { playhead: 3 }).includes(3));
  assert.equal(M.insertionIndex(L, 0, 16), 2);
  assert.equal(M.insertionIndex(L, 2, 1), 0);
  assert.equal(M.insertionIndex(L, 1, 6), 1);
  assert.deepEqual(M.tickStep(50), { major: 2, minor: 0.4 });
  assert.equal(M.tickStep(1000).major, 0.1);
  assert.equal(M.formatTime(7.46, { fraction: true }), '0:07.4');
  assert.equal(M.formatTime(65), '1:05');
  assert.equal(M.formatTime(3723), '1:02:03');
  assert.equal(M.formatTime(NaN), '0:00');
});

test('the store records edits for undo, drops a dead selection, and reports refused edits', () => {
  const saved = [];
  const errors = [];
  const store = createStore(project(), { save: (p) => saved.push(p), onError: (e) => errors.push(e.message) });
  const seen = [];
  store.subscribe((what) => seen.push(what));
  const next = store.apply((p) => P.addZoom(p, { start: 1, end: 3 }));
  store.select({ kind: 'zoom', id: next.zooms[0].id });
  // A drag is one step.
  for (const end of [4, 5, 6]) store.apply((p) => P.updateZoom(p, 'z1', { end }), { gesture: 'drag' });
  store.endGesture();
  assert.equal(store.project.zooms[0].end, 6);
  store.undo();
  assert.equal(store.project.zooms[0].end, 3);
  store.undo();
  assert.equal(store.project.zooms.length, 0);
  assert.equal(store.selection, null, 'the selected zoom is gone');
  store.redo();
  assert.equal(store.project.zooms.length, 1);
  assert.equal(store.apply((p) => P.deleteClip(p, 'c1')), null);
  assert.match(errors[0], /at least one clip/);
  assert.equal(saved.length, 7, 'every change, drags and undo included, is saved');
  assert.equal(store.tl.duration, 20);
  assert.ok(seen.includes('selection') && seen.includes('project'));
});

test('a zoom reaching over a cut shows only the time that still plays', () => {
  const p = P.cutRange(project(), 5, 10); // recording 5-10 s is gone
  const pieces = M.rangePieces(p, layoutOf(p), 'main', 3, 12);
  near(M.shownLength(pieces), 4, 1e-6); // 3-5 and 10-12
});

test('a trim edge dragged past the clip still has a place on the timeline as it was', () => {
  let p = P.cutRange(project(), 5, 10); // clips 0-5, 10-20
  const L = layoutOf(p);
  // Inside the clip, as outputInClip.
  near(M.outputAtSource(p, L, 1, 12), 7);
  // Past its start (the part trimmed away earlier) and end: not clamped.
  near(M.outputAtSource(p, L, 1, 8), 3);
  near(M.outputAtSource(p, L, 0, 7), 7);
  // With a speed change it follows the same (eased) mapping as inside a clip.
  p = P.paintSpeed(project(), { start: 0, end: 20, rate: 2 });
  near(M.outputAtSource(p, layoutOf(p), 0, 10), M.outputInClip(p, layoutOf(p), 0, 10));
});

test('typed times: seconds, m:ss, h:mm:ss, with fractions', () => {
  assert.strictEqual(M.parseTime('90'), 90);
  assert.strictEqual(M.parseTime('1:30'), 90);
  assert.strictEqual(M.parseTime(' 0:01 '), 1);
  assert.strictEqual(M.parseTime('1:30.5'), 90.5);
  assert.strictEqual(M.parseTime('0:01:30'), 90);
  assert.strictEqual(M.parseTime('1:02:03.25'), 3723.25);
  assert.strictEqual(M.parseTime('2.5'), 2.5);
  assert.strictEqual(M.parseTime('1,5'), 1.5);
  for (const bad of ['', 'abc', '1:', ':30', '1:60', '1:2:3:4', '-3', '1:30s', '1::30']) {
    assert.strictEqual(M.parseTime(bad), null, bad);
  }
});

test('cut by times: what to remove, latest first so earlier times stay put', () => {
  // Keep only 0:01-1:30 of a 3-minute video.
  assert.deepStrictEqual(M.cutRanges(180, 1, 90, 'keep'), { ranges: [[90, 180], [0, 1]] });
  // Keep from the very start / to the very end: one cut.
  assert.deepStrictEqual(M.cutRanges(180, 0, 90, 'keep'), { ranges: [[90, 180]] });
  assert.deepStrictEqual(M.cutRanges(180, 30, 180, 'keep'), { ranges: [[0, 30]] });
  // Remove the middle.
  assert.deepStrictEqual(M.cutRanges(180, 90, 120, 'remove'), { ranges: [[90, 120]] });
  // Refusals, in words.
  assert.match(M.cutRanges(180, 90, 90, 'remove').error, /after/);
  assert.match(M.cutRanges(180, 100, 90, 'remove').error, /after/);
  assert.match(M.cutRanges(180, 90, 200, 'remove').error, /3:00 long/);
  assert.match(M.cutRanges(180, 0, 180, 'remove').error, /whole video/);
  assert.match(M.cutRanges(180, 0, 180, 'keep').error, /already/);
  assert.match(M.cutRanges(180, null, 10, 'keep').error, /From/);
  assert.match(M.cutRanges(180, 1, null, 'keep').error, /To/);
});

test('a selected audio clip stays selected through other edits, and goes when it is deleted', () => {
  const p = P.addAudioClip(project(), { file: 'music/a.mp3', start: 0, fileDuration: 5 });
  const store = createStore(p);
  store.select({ kind: 'audio', id: 'a1' });
  store.apply((q) => P.setTitle(q, 'Demo'));
  assert.deepEqual(store.selection, { kind: 'audio', id: 'a1' });
  store.apply((q) => P.removeAudioClip(q, 'a1'));
  assert.equal(store.selection, null);
});
