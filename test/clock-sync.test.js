'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { createClockSync } = require('../src/main/clock-sync');

test('nothing maps before the first sample', () => {
  const sync = createClockSync();
  assert.strictEqual(sync.hasSample(), false);
  assert.strictEqual(sync.toHelper(10), null);
});

test('the smallest arrival delay wins, so the estimate converges on the true offset', () => {
  // The helper clock is the main clock minus 225,902 s (a Mac that has slept:
  // mach_absolute_time vs mach_continuous_time), and lines take 0.4..8 ms
  // to arrive.
  const trueOffset = 225902;
  const sync = createClockSync();
  const delays = [0.008, 0.0031, 0.0004, 0.0052, 0.0009];
  delays.forEach((delay, i) => {
    const helperTime = 1000 + i;
    sync.observe(helperTime, helperTime + trueOffset + delay);
  });
  assert.ok(Math.abs(sync.offset() - (trueOffset + 0.0004)) < 1e-6);
  // A main-process moment maps to within the quickest delivery.
  const local = 1010 + trueOffset;
  assert.ok(Math.abs(sync.toHelper(local) - 1010) <= 0.0004 + 1e-6);
});

test('non-numeric samples are ignored', () => {
  const sync = createClockSync();
  sync.observe(undefined, 5);
  sync.observe(1, NaN);
  sync.observe('1', 5);
  assert.strictEqual(sync.hasSample(), false);
  sync.observe(1, 5);
  assert.strictEqual(sync.offset(), 4);
  assert.strictEqual(sync.samples(), 1);
});
