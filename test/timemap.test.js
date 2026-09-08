'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { buildMap, toOutput, toSource, rateAt } = require('../src/main/timemap');

const near = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} !== ${b}`);

test('with no segments the map is the identity', () => {
  const map = buildMap([], 10);
  for (const t of [0, 0.5, 3.3, 9.9, 10]) near(toOutput(map, t), t);
  near(map.outputDuration, 10);
});

test('a 2x segment halves that regions output duration', () => {
  const map = buildMap([{ srcStart: 2, srcEnd: 6, rate: 2 }], 10, 0);
  near(map.outputDuration, 8);
  near(toOutput(map, 2), 2);
  near(toOutput(map, 6), 4);
  near(toOutput(map, 10), 8);
});

test('a 0.5x segment doubles that regions output duration', () => {
  const map = buildMap([{ srcStart: 0, srcEnd: 4, rate: 0.5 }], 10, 0);
  near(map.outputDuration, 14);
});

test('the map is strictly increasing', () => {
  const map = buildMap([{ srcStart: 1, srcEnd: 3, rate: 8 }], 10);
  for (let i = 1; i < map.table.length; i++) {
    assert.ok(map.table[i] > map.table[i - 1], `not increasing at ${i}`);
  }
});

test('toSource round-trips toOutput', () => {
  const map = buildMap([{ srcStart: 2, srcEnd: 5, rate: 3 }], 12);
  for (const t of [0, 1, 2.5, 4, 5, 8, 11.5]) near(toSource(map, toOutput(map, t)), t, 1e-3);
});

test('rate is 1.0 outside every segment', () => {
  const segs = [{ srcStart: 2, srcEnd: 6, rate: 4 }];
  near(rateAt(0, segs, 200), 1);
  near(rateAt(8, segs, 200), 1);
});

test('rate ramps continuously from 1.0 at each segment edge', () => {
  const segs = [{ srcStart: 2, srcEnd: 6, rate: 4 }];
  near(rateAt(2, segs, 200), 1);
  near(rateAt(6, segs, 200), 1);
  near(rateAt(4, segs, 200), 4);
  assert.ok(rateAt(2.1, segs, 200) > 1 && rateAt(2.1, segs, 200) < 4);
});

test('ramps are clamped so they never exceed half the segment', () => {
  const segs = [{ srcStart: 1, srcEnd: 1.1, rate: 4 }];
  const mid = rateAt(1.05, segs, 200);
  assert.ok(mid > 1 && mid <= 4, `mid rate ${mid} out of range`);
  near(rateAt(1, segs, 200), 1);
  near(rateAt(1.1, segs, 200), 1);
});

test('zero-duration map returns 0 for all conversions', () => {
  const map = buildMap([], 0);
  near(toOutput(map, 0), 0);
  near(toSource(map, 0), 0);
  near(map.outputDuration, 0);
});

test('buildMap throws on segment with zero rate', () => {
  assert.throws(
    () => buildMap([{ srcStart: 0, srcEnd: 1, rate: 0 }], 10),
    /rate must be.*> 0/
  );
});

test('buildMap throws on segment with negative rate', () => {
  assert.throws(
    () => buildMap([{ srcStart: 0, srcEnd: 1, rate: -1 }], 10),
    /rate must be.*> 0/
  );
});

test('buildMap throws on segment with infinite rate', () => {
  assert.throws(
    () => buildMap([{ srcStart: 0, srcEnd: 1, rate: Infinity }], 10),
    /rate must be.*finite/
  );
});

test('buildMap throws on segment with NaN rate', () => {
  assert.throws(
    () => buildMap([{ srcStart: 0, srcEnd: 1, rate: NaN }], 10),
    /rate must be.*finite/
  );
});
