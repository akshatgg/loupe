// A clip's look: position, size, rotation, crop and colour (src/core/look.js,
// setClipLook in src/core/project.js).
import test from 'node:test';
import assert from 'node:assert/strict';
import * as P from '../src/core/project.js';
import { clipTransform, clipColor, cssFilter, tintOf, isPlain, transformMatrix, COLOR_FILTERS } from '../src/core/look.js';

test('a clip without a look is drawn as it is', () => {
  const clip = { id: 'c1', source: 'main', start: 0, end: 5 };
  assert.deepEqual(clipTransform(clip), { x: 0, y: 0, scale: 1, rotate: 0, flipH: false, flipV: false, crop: { left: 0, top: 0, right: 0, bottom: 0 } });
  assert.equal(cssFilter(clipColor(clip)), 'none');
  assert.equal(tintOf(clipColor(clip)), null);
  assert.equal(isPlain(clip), true);
});

test('colour: sliders and preset looks become one canvas filter; warm and cool add a tint', () => {
  assert.equal(cssFilter({ brightness: 0.2, contrast: -0.5, saturation: 1, filter: 'none' }), 'brightness(1.2) contrast(0.5) saturate(2)');
  assert.equal(cssFilter({ brightness: 0, contrast: 0, saturation: 0, filter: 'bw' }), 'grayscale(1)');
  assert.match(cssFilter({ brightness: 0, contrast: 0, saturation: 0, filter: 'sepia' }), /sepia\(0\.8\)/);
  assert.ok(tintOf({ filter: 'warm' }).color.startsWith('rgba(255'), 'warm: orange');
  assert.ok(tintOf({ filter: 'cool' }).color.startsWith('rgba(0'), 'cool: blue');
  for (const f of COLOR_FILTERS) assert.equal(typeof cssFilter({ brightness: 0, contrast: 0, saturation: 0, filter: f }), 'string');
});

test('the transform about the picture’s middle: move, scale, rotate, flip', () => {
  const content = { x: 100, y: 50, w: 400, h: 200 };
  // Half size, moved a quarter of the width right: the middle at (400, 150).
  let m = transformMatrix({ x: 0.25, y: 0, scale: 0.5, rotate: 0, flipH: false, flipV: false }, content);
  const apply = ([a, b, c, d, e, f], px, py) => [a * px + c * py + e, b * px + d * py + f];
  assert.deepEqual(apply(m, 300, 150), [400, 150], 'the middle moved');
  assert.deepEqual(apply(m, 100, 50), [300, 100], 'the top-left corner a half-size step in');
  m = transformMatrix({ x: 0, y: 0, scale: 1, rotate: 90, flipH: false, flipV: false }, content);
  const [x, y] = apply(m, 500, 150); // the right edge's middle
  assert.ok(Math.abs(x - 300) < 1e-9 && Math.abs(y - 350) < 1e-9, `rotated a quarter turn clockwise: ${x}, ${y}`);
  m = transformMatrix({ x: 0, y: 0, scale: 1, rotate: 0, flipH: true, flipV: false }, content);
  assert.deepEqual(apply(m, 100, 50), [500, 50], 'flipped left to right');
});

test('setClipLook: patches merge, bad values are refused, reset puts it back', () => {
  let p = P.createProject({ main: { width: 100, height: 100, duration: 10 } });
  const id = p.clips[0].id;
  p = P.setClipLook(p, id, { transform: { scale: 1.5, crop: { left: 0.1 } }, color: { filter: 'bw' } });
  assert.equal(p.clips[0].transform.scale, 1.5);
  assert.equal(p.clips[0].transform.crop.left, 0.1);
  assert.equal(p.clips[0].color.filter, 'bw');
  p = P.setClipLook(p, id, { transform: { rotate: 45 } });
  assert.equal(p.clips[0].transform.scale, 1.5, 'kept');
  assert.throws(() => P.setClipLook(p, id, { transform: { scale: 0 } }), /Scale/);
  assert.throws(() => P.setClipLook(p, id, { transform: { crop: { left: 0.6 } } }), /Crop/);
  assert.throws(() => P.setClipLook(p, id, { color: { filter: 'rainbow' } }), /Colour filter/);
  assert.throws(() => P.setClipLook(p, id, { color: { brightness: 3 } }), /Brightness/);
  p = P.setClipLook(p, id, { transform: null, color: null });
  assert.equal(isPlain(p.clips[0]), true);
  // A split keeps the look on both halves.
  p = P.setClipLook(p, id, { color: { filter: 'sepia' } });
  p = P.splitAt(p, 5);
  assert.deepEqual(p.clips.map((c) => c.color?.filter), ['sepia', 'sepia']);
});
