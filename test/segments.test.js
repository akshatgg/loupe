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
