'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { MIN_REGION_SIZE, validateRegion, clampRegionToBounds } = require('../src/main/region');

test('a well-formed region passes through unchanged', () => {
  const region = { x: 10, y: 20, width: 600, height: 400 };
  assert.deepStrictEqual(validateRegion(region), region);
});

test('a negative origin is allowed (a display left of or above the primary one)', () => {
  const region = { x: -500, y: -100, width: 200, height: 200 };
  assert.deepStrictEqual(validateRegion(region), region);
});

test('non-finite x/y/width/height are rejected', () => {
  for (const bad of [
    { x: NaN, y: 0, width: 100, height: 100 },
    { x: 0, y: Infinity, width: 100, height: 100 },
    { x: 0, y: 0, width: '100', height: 100 },
    { x: 0, y: 0, width: 100, height: undefined }
  ]) {
    assert.throws(() => validateRegion(bad));
  }
});

test('a region below the minimum size is rejected', () => {
  assert.throws(() => validateRegion({ x: 0, y: 0, width: 2, height: 3 }));
  assert.throws(() => validateRegion({ x: 0, y: 0, width: MIN_REGION_SIZE - 1, height: 100 }));
});

test('a region exactly at the minimum size is accepted', () => {
  const region = { x: 0, y: 0, width: MIN_REGION_SIZE, height: MIN_REGION_SIZE };
  assert.deepStrictEqual(validateRegion(region), region);
});

test('undefined/null input is rejected, not thrown as a TypeError from destructuring', () => {
  assert.throws(() => validateRegion(undefined));
  assert.throws(() => validateRegion(null));
});

test('clampRegionToBounds pulls a region back inside its bounds', () => {
  const bounds = { x: 0, y: 0, width: 1000, height: 800 };
  const region = { x: 950, y: 750, width: 200, height: 150 };
  const clamped = clampRegionToBounds(region, bounds);
  assert.strictEqual(clamped.x, 800);
  assert.strictEqual(clamped.y, 650);
  assert.strictEqual(clamped.width, 200);
  assert.strictEqual(clamped.height, 150);
});

test('clampRegionToBounds leaves an in-bounds region untouched', () => {
  const bounds = { x: 0, y: 0, width: 1000, height: 800 };
  const region = { x: 100, y: 100, width: 200, height: 150 };
  assert.deepStrictEqual(clampRegionToBounds(region, bounds), region);
});

test('clampRegionToBounds works against a negative-origin display', () => {
  const bounds = { x: -1000, y: 0, width: 800, height: 600 };
  const region = { x: -50, y: 500, width: 300, height: 200 };
  const clamped = clampRegionToBounds(region, bounds);
  assert.strictEqual(clamped.x, -500); // bounds.x + bounds.width - region.width
  assert.strictEqual(clamped.y, 400); // bounds.y + bounds.height - region.height
});
