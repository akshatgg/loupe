'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { zoomSegments, deleteSegment, validateSegment } = require('../src/main/segments');

test('no keyframes means no segments', () => {
  assert.deepStrictEqual(zoomSegments([], 10), []);
});

test('a zoom in and back out is one segment', () => {
  const kf = [
    { t: 2, zoom: 2, cx: 0, cy: 0 },
    { t: 5, zoom: 1, cx: 0, cy: 0 }
  ];
  const segs = zoomSegments(kf, 10);
  assert.strictEqual(segs.length, 1);
  assert.strictEqual(segs[0].start, 2);
  assert.strictEqual(segs[0].end, 5);
  assert.strictEqual(segs[0].peak, 2);
});

test('a zoom left open runs to the end of the recording', () => {
  const segs = zoomSegments([{ t: 3, zoom: 3, cx: 0, cy: 0 }], 8);
  assert.strictEqual(segs[0].end, 8);
});

test('the peak is the highest zoom reached inside the segment', () => {
  const kf = [
    { t: 1, zoom: 1.5, cx: 0, cy: 0 },
    { t: 2, zoom: 3.2, cx: 0, cy: 0 },
    { t: 3, zoom: 2, cx: 0, cy: 0 },
    { t: 4, zoom: 1, cx: 0, cy: 0 }
  ];
  assert.strictEqual(zoomSegments(kf, 10)[0].peak, 3.2);
});

test('two separate zooms produce two segments', () => {
  const kf = [
    { t: 1, zoom: 2, cx: 0, cy: 0 }, { t: 2, zoom: 1, cx: 0, cy: 0 },
    { t: 5, zoom: 2, cx: 0, cy: 0 }, { t: 6, zoom: 1, cx: 0, cy: 0 }
  ];
  assert.strictEqual(zoomSegments(kf, 10).length, 2);
});

test('deleting a segment removes its keyframes and leaves the rest', () => {
  const kf = [
    { t: 1, zoom: 2, cx: 0, cy: 0 }, { t: 2, zoom: 1, cx: 0, cy: 0 },
    { t: 5, zoom: 2, cx: 0, cy: 0 }, { t: 6, zoom: 1, cx: 0, cy: 0 }
  ];
  const left = deleteSegment(kf, { start: 1, end: 2 });
  assert.strictEqual(left.length, 2);
  assert.strictEqual(left[0].t, 5);
});

test('deleting a segment never leaves the video zoomed in', () => {
  const kf = [{ t: 3, zoom: 3, cx: 0, cy: 0 }];
  assert.deepStrictEqual(deleteSegment(kf, { start: 3, end: 8 }), []);
});

test('validateSegment accepts a well-formed segment', () => {
  assert.deepStrictEqual(validateSegment({ start: 1, end: 2 }), { start: 1, end: 2 });
});

test('validateSegment rejects a non-finite start', () => {
  assert.throws(() => validateSegment({ start: -Infinity, end: 8 }), /Invalid segment start/);
});

test('validateSegment rejects a non-finite end', () => {
  assert.throws(() => validateSegment({ start: 1, end: Infinity }), /Invalid segment end/);
});

test('validateSegment rejects NaN', () => {
  assert.throws(() => validateSegment({ start: NaN, end: 1 }), /Invalid segment start/);
});

test('validateSegment rejects non-numeric fields', () => {
  assert.throws(() => validateSegment({ start: '1', end: 2 }), /Invalid segment start/);
});

test('validateSegment rejects start after end', () => {
  assert.throws(() => validateSegment({ start: 5, end: 2 }), /start \(5\) is after end \(2\)/);
});

test('validateSegment rejects a missing/malformed payload entirely', () => {
  assert.throws(() => validateSegment(null), /Invalid segment start/);
  assert.throws(() => validateSegment(undefined), /Invalid segment start/);
  assert.throws(() => validateSegment({}), /Invalid segment start/);
});

// The exact attack from the finding: this must never reach deleteSegment.
test('validateSegment rejects the wipe-every-keyframe payload', () => {
  assert.throws(() => validateSegment({ start: -Infinity, end: Infinity }));
});

// ---- non-destructive zoom removal -----------------------------------------
const { removeZoom, undoRemoveZoom, restoreAllZooms } = require('../src/main/segments');

// Two zooms: 2x over 1..3s and 3x over 5..7s.
const RECORDED = [
  { t: 1, zoom: 2, cx: 0, cy: 0 }, { t: 3, zoom: 1, cx: 0, cy: 0 },
  { t: 5, zoom: 3, cx: 0, cy: 0 }, { t: 7, zoom: 1, cx: 0, cy: 0 }
];
const fresh = () => ({
  zoomKeyframes: RECORDED.map((k) => ({ ...k })),
  recordedZoomKeyframes: RECORDED.map((k) => ({ ...k })),
  removedZooms: []
});

test('removing a zoom drops it from the video but keeps the recorded original', () => {
  const p = removeZoom(fresh(), { start: 1, end: 3 });
  assert.deepStrictEqual(p.zoomKeyframes, RECORDED.slice(2));
  assert.deepStrictEqual(p.recordedZoomKeyframes, RECORDED);
  assert.deepStrictEqual(p.removedZooms, [{ start: 1, end: 3 }]);
});

test('undo brings back the most recently removed zoom, one at a time', () => {
  let p = removeZoom(removeZoom(fresh(), { start: 1, end: 3 }), { start: 5, end: 7 });
  assert.deepStrictEqual(p.zoomKeyframes, []);
  p = undoRemoveZoom(p);
  assert.deepStrictEqual(p.zoomKeyframes, RECORDED.slice(2));
  p = undoRemoveZoom(p);
  assert.deepStrictEqual(p.zoomKeyframes, RECORDED);
  assert.deepStrictEqual(undoRemoveZoom(p).zoomKeyframes, RECORDED, 'nothing left to undo is a no-op');
});

test('restore brings every removed zoom back at once', () => {
  const p = restoreAllZooms(removeZoom(removeZoom(fresh(), { start: 1, end: 3 }), { start: 5, end: 7 }));
  assert.deepStrictEqual(p.zoomKeyframes, RECORDED);
  assert.deepStrictEqual(p.removedZooms, []);
});

test('a project from before this keeps its current zooms as the baseline', () => {
  // No recordedZoomKeyframes / removedZooms fields at all.
  const legacy = { zoomKeyframes: RECORDED.map((k) => ({ ...k })) };
  const p = undoRemoveZoom(removeZoom(legacy, { start: 5, end: 7 }));
  assert.deepStrictEqual(p.zoomKeyframes, RECORDED);
});

test('removal never mutates the project it was given', () => {
  const before = fresh();
  const snapshot = JSON.stringify(before);
  removeZoom(before, { start: 1, end: 3 });
  assert.strictEqual(JSON.stringify(before), snapshot);
});
