// The Captions panel's and captions track's arithmetic
// (src/renderer/editor/captions-math.js): pieces across cuts, transcript
// order, the caption on screen, and drags kept between neighbours.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as P from '../src/core/project.js';
import { buildTimeline } from '../src/core/timeline.js';
import { clipLayout } from '../src/renderer/editor/timeline-math.js';
import * as C from '../src/renderer/editor/captions-math.js';

const near = (a, b, eps = 1e-3) => assert.ok(Math.abs(a - b) < eps, `${a} is not ${b}`);

function project(segments = [
  { id: 'a', source: 'main', start: 1, end: 3, text: 'One' },
  { id: 'b', source: 'main', start: 4, end: 7, text: 'Two' },
  { id: 'c', source: 'main', start: 12, end: 14, text: 'Three' }
]) {
  const p = P.createProject({ main: { width: 1000, height: 600, duration: 20, video: 'raw.mov' }, createdAt: 0 });
  return P.setCaptions(p, { segments });
}
const layoutOf = (p) => clipLayout(p, buildTimeline(p));
const seg = (p, id) => p.captions.segments.find((s) => s.id === id);

test('a caption shows once per clip it overlaps and not where it was cut', () => {
  const p = P.cutRange(project(), 5, 10);
  const pieces = C.captionPieces(p, layoutOf(p));
  assert.deepEqual(pieces.map((x) => [x.seg.id, x.outStart, x.outEnd]), [['a', 1, 3], ['b', 4, 5], ['c', 7, 9]]);
});

test('the transcript lists captions in the order they play, cut ones last', () => {
  let p = P.cutRange(project(), 0.5, 3.5); // "One" is cut out
  p = P.splitAt(p, 5);
  p = P.moveClip(p, 2, 0); // the part with "Three" (8..20 s) now plays first
  const rows = C.transcriptRows(p, layoutOf(p));
  assert.deepEqual(rows.map((r) => r.seg.id), ['c', 'b', 'a']);
  assert.equal(rows[2].outStart, null);
  near(rows[0].outStart, 4);
});

test('the caption on screen at a moment follows the edited video', () => {
  const p = P.cutRange(project(), 0, 2);
  const tl = buildTimeline(p);
  assert.equal(C.captionIdAt(p, tl, 0.5), 'a');
  assert.equal(C.captionIdAt(p, tl, 1.5), null);
  assert.equal(C.captionIdAt(p, tl, 2.5), 'b');
  assert.equal(C.captionIdAt(p, tl, 2.5), 'b', 'cached answer is the same');
});

test('dragging an edge stays between the neighbouring captions and keeps a minimum length', () => {
  const p = project();
  assert.deepEqual(C.captionRoom(p, seg(p, 'b')), { lo: 3, hi: 12 });
  assert.deepEqual(C.resizedCaption(p, seg(p, 'b'), 'start', 2), { start: 3 });
  assert.deepEqual(C.resizedCaption(p, seg(p, 'b'), 'start', 6.99), { start: 6.9 });
  assert.deepEqual(C.resizedCaption(p, seg(p, 'b'), 'end', 15), { end: 12 });
  near(C.resizedCaption(p, seg(p, 'b'), 'end', 3).end, 4.1);
  assert.deepEqual(C.resizedCaption(p, seg(p, 'c'), 'end', 30), { end: 20 });
  assert.deepEqual(C.movedCaption(p, seg(p, 'b'), 10), { start: 9, end: 12 });
  assert.deepEqual(C.movedCaption(p, seg(p, 'b'), 0), { start: 3, end: 6 });
});

test('a new caption at the playhead fits the gap, or there is none on a caption', () => {
  const p = project();
  const L = layoutOf(p);
  assert.equal(C.newCaptionRange(p, L, 2), null);
  assert.deepEqual(C.newCaptionRange(p, L, 8), { source: 'main', start: 8, end: 10 });
  assert.deepEqual(C.newCaptionRange(p, L, 11.5), { source: 'main', start: 10, end: 12 });
  assert.deepEqual(C.newCaptionRange(p, L, 3.2), { source: 'main', start: 3, end: 4 });
});

test('a new transcription replaces only the recordings it covered', () => {
  const old = [{ id: 'x', source: 'main', start: 1, end: 2, text: 'old' }, { id: 'y', source: 'src2', start: 0, end: 1, text: 'keep' }];
  const fresh = [{ id: 'z', source: 'main', start: 0.5, end: 1, text: 'new' }];
  assert.deepEqual(C.replaceSegments(old, ['main'], fresh).map((s) => s.id), ['z', 'y']);
});
