'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { createPauseTracker, toSourcePauses, clipsFromPauses } = require('../src/main/pauses');

test('pause and resume record a range; double presses change nothing', () => {
  const p = createPauseTracker();
  assert.strictEqual(p.resume(1), false, 'nothing to resume');
  assert.strictEqual(p.pause(2), true);
  assert.strictEqual(p.pause(3), false, 'already paused');
  assert.strictEqual(p.isPaused(), true);
  assert.strictEqual(p.resume(5), true);
  assert.strictEqual(p.isPaused(), false);
  assert.deepStrictEqual(p.ranges(10), [{ start: 2, end: 5 }]);
});

test('the paused total includes a pause still running, which is what the bar timer leaves out', () => {
  const p = createPauseTracker();
  p.pause(1); p.resume(3);
  p.pause(10);
  assert.strictEqual(p.pausedTotal(10), 2);
  assert.strictEqual(p.pausedTotal(14), 6);
  // Elapsed shown on the bar = wall time - paused total, and it stands still
  // while paused.
  assert.strictEqual(20 - p.pausedTotal(20), 20 - 12);
  assert.strictEqual(21 - p.pausedTotal(21), 20 - 12);
});

test('a pause still open at stop ends at the stop', () => {
  const p = createPauseTracker();
  p.pause(4);
  assert.deepStrictEqual(p.ranges(9), [{ start: 4, end: 9 }]);
});

test('ranges map into source time, clamp to the recording, merge and drop slivers', () => {
  const toSource = (t) => t - 100;
  const ranges = [
    { start: 95, end: 101 },        // starts before the recording: clamped to 0
    { start: 103, end: 105 },
    { start: 104, end: 106 },       // overlaps the one before: merged
    { start: 107, end: 107.001 },   // shorter than a frame: dropped
    { start: 108, end: 130 }        // runs past the end: clamped to duration
  ];
  assert.deepStrictEqual(toSourcePauses(ranges, toSource, 20), [
    { start: 0, end: 1 }, { start: 3, end: 6 }, { start: 8, end: 20 }
  ]);
});

test('ranges that cannot be mapped are left out rather than guessed', () => {
  assert.deepStrictEqual(toSourcePauses([{ start: 1, end: 2 }], () => null, 10), []);
});

test('clips are the recording minus its pauses', () => {
  assert.deepStrictEqual(clipsFromPauses(10, []), [
    { id: 'clip-1', source: 'main', start: 0, end: 10 }
  ]);
  assert.deepStrictEqual(clipsFromPauses(10, [{ start: 2, end: 3 }, { start: 6, end: 10 }]), [
    { id: 'clip-1', source: 'main', start: 0, end: 2 },
    { id: 'clip-2', source: 'main', start: 3, end: 6 }
  ]);
  assert.deepStrictEqual(clipsFromPauses(10, [{ start: 0, end: 4 }]), [
    { id: 'clip-1', source: 'main', start: 4, end: 10 }
  ]);
});
