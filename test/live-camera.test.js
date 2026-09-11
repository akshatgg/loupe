'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { createLiveCamera, stepLiveCamera } = require('../src/main/live-camera');
const { easeZoom, SAMPLE_RATE } = require('../src/main/camera');

const BOUNDS = { width: 1600, height: 1000 };
const DT = 1 / SAMPLE_RATE;

function settle(cam, input, seconds = 2) {
  let view;
  for (let i = 0; i < seconds * SAMPLE_RATE; i++) view = stepLiveCamera(cam, { dt: DT, ...input });
  return view;
}

test('at rest the frame is the whole recorded area', () => {
  const cam = createLiveCamera(BOUNDS);
  const view = stepLiveCamera(cam, { target: 1, cursor: { x: 300, y: 200 }, dt: DT });
  assert.strictEqual(view.zoom, 1);
  assert.deepStrictEqual(view.rect, { x: 0, y: 0, width: 1600, height: 1000 });
});

test('the live zoom eases exactly like the rendered video does', () => {
  // Same keyframes easeZoom (the renderer's path) sees: 2x from t=0.5s.
  const expected = easeZoom([{ t: 0.5, zoom: 2 }], 1.5);
  const cam = createLiveCamera(BOUNDS);
  for (let i = 0; i < expected.length; i++) {
    const target = i * DT >= 0.5 ? 2 : 1;
    const { zoom } = stepLiveCamera(cam, { target, cursor: null, dt: DT });
    assert.strictEqual(zoom, expected[i], `sample ${i}`);
  }
});

test('at 2x with the cursor centred, the frame is the middle half', () => {
  const cam = createLiveCamera(BOUNDS);
  const view = settle(cam, { target: 2, cursor: { x: 800, y: 500 } });
  assert.ok(Math.abs(view.zoom - 2) < 1e-3);
  assert.ok(Math.abs(view.rect.width - 800) < 1);
  assert.ok(Math.abs(view.rect.height - 500) < 1);
  assert.ok(Math.abs(view.rect.x - 400) < 1);
  assert.ok(Math.abs(view.rect.y - 250) < 1);
});

test('the frame follows the cursor into a corner but never leaves the area', () => {
  const cam = createLiveCamera(BOUNDS);
  const view = settle(cam, { target: 3, cursor: { x: 1590, y: 990 } });
  const { x, y, width, height } = view.rect;
  assert.ok(x >= 0 && y >= 0);
  assert.ok(x + width <= 1600 + 1e-9 && y + height <= 1000 + 1e-9);
  assert.ok(1590 >= x && 1590 <= x + width, 'cursor stays in shot horizontally');
  assert.ok(990 >= y && 990 <= y + height, 'cursor stays in shot vertically');
});

test('a long frame hitch does not destabilise the spring', () => {
  const cam = createLiveCamera(BOUNDS);
  const view = stepLiveCamera(cam, { target: 4, cursor: null, dt: 0.5 });
  assert.ok(Number.isFinite(view.zoom));
  assert.ok(view.zoom >= 1 && view.zoom <= 4.05, `zoom ${view.zoom}`);
});

test('with no cursor seen yet the frame zooms on the centre', () => {
  const cam = createLiveCamera(BOUNDS);
  const view = settle(cam, { target: 2, cursor: null });
  assert.ok(Math.abs(view.rect.x + view.rect.width / 2 - 800) < 1);
  assert.ok(Math.abs(view.rect.y + view.rect.height / 2 - 500) < 1);
});
