'use strict';
const test = require('node:test');
const assert = require('node:assert');
const {
  clamp, clampRect, moveRect, resizeRect, drawRect, windowFitRect
} = require('../src/main/region-geometry');
const { MIN_REGION_SIZE } = require('../src/main/region');

const BOUNDS = { x: 0, y: 0, width: 1000, height: 800 };

test('clamp clamps to the given range', () => {
  assert.strictEqual(clamp(5, 0, 10), 5);
  assert.strictEqual(clamp(-5, 0, 10), 0);
  assert.strictEqual(clamp(15, 0, 10), 10);
});

test('clampRect shrinks and repositions an out-of-bounds rect', () => {
  const rect = { x: 900, y: 700, width: 300, height: 300 };
  const clamped = clampRect(rect, BOUNDS);
  assert.strictEqual(clamped.width, 300);
  assert.strictEqual(clamped.height, 300);
  assert.strictEqual(clamped.x, 700); // bounds.width - width
  assert.strictEqual(clamped.y, 500);
});

test('moveRect translates and stays inside bounds', () => {
  const rect = { x: 100, y: 100, width: 200, height: 150 };
  assert.deepStrictEqual(moveRect(rect, 50, 20, BOUNDS), { x: 150, y: 120, width: 200, height: 150 });
});

test('moveRect cannot push the rect past the bounds edge', () => {
  const rect = { x: 100, y: 100, width: 200, height: 150 };
  const moved = moveRect(rect, 10000, 10000, BOUNDS);
  assert.strictEqual(moved.x, BOUNDS.width - rect.width);
  assert.strictEqual(moved.y, BOUNDS.height - rect.height);
});

test('resizeRect grows from the se handle', () => {
  const rect = { x: 100, y: 100, width: 200, height: 150 };
  const resized = resizeRect('se', rect, 50, 30, BOUNDS);
  assert.deepStrictEqual(resized, { x: 100, y: 100, width: 250, height: 180 });
});

test('resizeRect moves the opposite edge for nw', () => {
  const rect = { x: 100, y: 100, width: 200, height: 150 };
  const resized = resizeRect('nw', rect, -20, -10, BOUNDS);
  assert.deepStrictEqual(resized, { x: 80, y: 90, width: 220, height: 160 });
});

test('resizeRect never collapses below the minimum size mid-drag', () => {
  const rect = { x: 100, y: 100, width: 200, height: 150 };
  // Drag the east edge far enough left to try to cross the west edge.
  const resized = resizeRect('e', rect, -10000, 0, BOUNDS);
  assert.strictEqual(resized.width, MIN_REGION_SIZE);
  assert.strictEqual(resized.x, 100);
});

test('resizeRect never pushes past the bounds edge', () => {
  const rect = { x: 100, y: 100, width: 200, height: 150 };
  const resized = resizeRect('se', rect, 10000, 10000, BOUNDS);
  assert.strictEqual(resized.x + resized.width, BOUNDS.width);
  assert.strictEqual(resized.y + resized.height, BOUNDS.height);
});

test('resizeRect on a single edge (n) only moves that edge', () => {
  const rect = { x: 100, y: 100, width: 200, height: 150 };
  const resized = resizeRect('n', rect, 999, -30, BOUNDS);
  assert.strictEqual(resized.x, 100);
  assert.strictEqual(resized.width, 200);
  assert.strictEqual(resized.y, 70);
  assert.strictEqual(resized.height, 180);
});

test('drawRect grows a rect from an anchor toward the pointer', () => {
  const anchor = { x: 200, y: 200 };
  const rect = drawRect(anchor, { x: 500, y: 400 }, BOUNDS);
  assert.deepStrictEqual(rect, { x: 200, y: 200, width: 300, height: 200 });
});

test('drawRect handles dragging up and to the left of the anchor', () => {
  const anchor = { x: 500, y: 400 };
  const rect = drawRect(anchor, { x: 200, y: 200 }, BOUNDS);
  assert.deepStrictEqual(rect, { x: 200, y: 200, width: 300, height: 200 });
});

test('drawRect enforces the minimum size even while the pointer sits on the anchor', () => {
  const anchor = { x: 500, y: 400 };
  const rect = drawRect(anchor, { x: 500, y: 400 }, BOUNDS);
  assert.strictEqual(rect.width, MIN_REGION_SIZE);
  assert.strictEqual(rect.height, MIN_REGION_SIZE);
});

test('drawRect clamps to bounds when the anchor sits at the edge', () => {
  const anchor = { x: 0, y: 0 };
  const rect = drawRect(anchor, { x: -500, y: -500 }, BOUNDS);
  assert.strictEqual(rect.x, 0);
  assert.strictEqual(rect.y, 0);
  assert.strictEqual(rect.width, MIN_REGION_SIZE);
  assert.strictEqual(rect.height, MIN_REGION_SIZE);
});

test('windowFitRect converts a window\'s global bounds to overlay-local space', () => {
  const target = { x: 0, y: 0, width: 1470, height: 956 };
  const win = { x: 40, y: 80, width: 900, height: 700 };
  assert.deepStrictEqual(windowFitRect(win, target, { x: 0, y: 0, width: 1470, height: 956 }),
    { x: 40, y: 80, width: 900, height: 700 });
});

test('windowFitRect clamps a window that overhangs the target bounds', () => {
  const target = { x: 0, y: 0, width: 1000, height: 800 };
  const win = { x: 900, y: 700, width: 400, height: 300 };
  const rect = windowFitRect(win, target, { x: 0, y: 0, width: 1000, height: 800 });
  assert.strictEqual(rect.width, 400);
  assert.strictEqual(rect.height, 300);
  assert.strictEqual(rect.x, 600);
  assert.strictEqual(rect.y, 500);
});

test('windowFitRect rebases a window from a display with a non-zero origin', () => {
  // A window on a display that sits to the right of the primary one.
  const target = { x: 1470, y: 0, width: 1920, height: 1080 };
  const win = { x: 1470 + 100, y: 50, width: 800, height: 600 };
  const rect = windowFitRect(win, target, { x: 0, y: 0, width: 1920, height: 1080 });
  assert.deepStrictEqual(rect, { x: 100, y: 50, width: 800, height: 600 });
});
