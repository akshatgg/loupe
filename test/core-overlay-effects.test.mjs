// An overlay's effects: how it blends with the video, a shape it is cut to,
// and a green screen (src/core/overlay-effects.js; validated in project.js;
// drawn by layers/overlays.js).
import test from 'node:test';
import assert from 'node:assert/strict';
import * as P from '../src/core/project.js';
import {
  OVERLAY_BLENDS, MASK_SHAPES, overlayEffects, compositeOf, hexToRgb, chroma, keyRange, keyAlpha, maskAlpha
} from '../src/core/overlay-effects.js';
import { draw } from '../src/core/layers/overlays.js';

const base = () => {
  let p = P.createProject({ main: { width: 1920, height: 1080, duration: 20 } });
  p = P.addOverlay(p, { kind: 'image', file: 'media/logo.png', start: 0 });
  return p;
};

test('an overlay without effects is drawn as before: normal blend, no mask, no green screen', () => {
  const old = { id: 'o1', kind: 'image' };
  assert.deepEqual(overlayEffects(old), {
    blend: 'normal', mask: { shape: 'none', feather: 0 },
    key: { on: false, color: '#00ff00', tolerance: 0.5, softness: 0.2 }
  });
  assert.equal(compositeOf('normal'), 'source-over');
  assert.equal(compositeOf('add'), 'lighter', 'add is the canvas’s "lighter"');
  assert.equal(compositeOf('soft-light'), 'soft-light');
  assert.deepEqual(OVERLAY_BLENDS, ['normal', 'multiply', 'screen', 'overlay', 'soft-light', 'add']);
  assert.deepEqual(MASK_SHAPES, ['none', 'rectangle', 'ellipse']);
});

test('a new overlay carries the defaults; a part of the green screen merges with the rest', () => {
  const p = base();
  assert.equal(p.overlays[0].blend, 'normal');
  assert.deepEqual(p.overlays[0].mask, { shape: 'none', feather: 0 });
  assert.equal(p.overlays[0].key.on, false);
  assert.deepEqual(overlayEffects({ key: { on: true } }).key, { on: true, color: '#00ff00', tolerance: 0.5, softness: 0.2 });
});

test('a project saved before effects existed still opens, unchanged', () => {
  const p = base();
  const { blend, mask, key, ...old } = p.overlays[0];
  assert.ok(blend && mask && key);
  const saved = JSON.parse(JSON.stringify({ ...p, overlays: [old] }));
  const opened = P.validateProject(saved);
  assert.deepEqual(opened.overlays[0], old, 'nothing added, nothing lost');
  assert.equal(P.updateOverlay(opened, 'o1', { opacity: 0.5 }).overlays[0].opacity, 0.5, 'and can still be edited');
});

test('effects are checked: bad values are refused in plain words', () => {
  const p = base();
  const set = (patch) => P.updateOverlay(p, 'o1', patch);
  assert.equal(set({ blend: 'multiply' }).overlays[0].blend, 'multiply');
  assert.deepEqual(set({ mask: { shape: 'ellipse', feather: 0.3 } }).overlays[0].mask, { shape: 'ellipse', feather: 0.3 });
  assert.equal(set({ key: { on: true, color: '#00ff00', tolerance: 0.4, softness: 0.1 } }).overlays[0].key.on, true);
  assert.throws(() => set({ blend: 'difference' }), /Blend must be one of normal, multiply/);
  assert.throws(() => set({ mask: { shape: 'star', feather: 0 } }), /Mask shape must be one of none, rectangle, ellipse/);
  assert.throws(() => set({ mask: { shape: 'ellipse', feather: 2 } }), /Mask edge softness must be a number from 0 to 1/);
  assert.throws(() => set({ mask: 'ellipse' }), /mask must be an object/);
  assert.throws(() => set({ key: { on: 'yes' } }), /Green screen on must be true or false/);
  assert.throws(() => set({ key: { on: true, color: 'green' } }), /Green screen colour must be a colour like #00ff00/);
  assert.throws(() => set({ key: { on: true, color: '#0f0' } }), /Green screen colour must be a colour like #00ff00/);
  assert.throws(() => set({ key: { on: true, tolerance: -1 } }), /Green screen tolerance must be a number from 0 to 1/);
  assert.throws(() => set({ key: { on: true, softness: 3 } }), /Green screen softness must be a number from 0 to 1/);
});

test('green screen: see-through at the key colour, solid far from it, smooth between', () => {
  const key = { on: true, color: '#00ff00', tolerance: 0.5, softness: 0.2 };
  assert.deepEqual(hexToRgb('#00ff00'), [0, 1, 0]);
  assert.equal(keyAlpha([0, 1, 0], key), 0, 'the key colour itself');
  for (const [name, rgb] of [['red', [1, 0, 0]], ['blue', [0, 0, 1]], ['white', [1, 1, 1]], ['black', [0, 0, 0]], ['skin', [0.9, 0.7, 0.6]]]) {
    assert.equal(keyAlpha(rgb, key), 1, `${name} stays`);
  }
  // From green toward grey: never less see-through further away, and
  // somewhere in between only partly.
  const { inner, outer } = keyRange(key);
  assert.ok(outer > inner);
  let last = -1;
  let partial = 0;
  for (let k = 0; k <= 100; k++) {
    const s = k / 100; // 0: green, 1: grey
    const a = keyAlpha([0.5 * s, 1 - 0.5 * s, 0.5 * s], key);
    assert.ok(a >= last - 1e-12, `alpha rises steadily (${s})`);
    assert.ok(a - Math.max(last, 0) < 0.2, `without a jump (${s})`);
    if (a > 0.01 && a < 0.99) partial++;
    last = a;
  }
  assert.equal(last, 1);
  assert.ok(partial >= 5, `a soft edge: ${partial} steps partly see-through`);
});

test('green screen: a darker or brighter patch of the screen is still removed (chroma, not brightness)', () => {
  const key = { on: true, color: '#00ff00', tolerance: 0.5, softness: 0.2 };
  assert.ok(keyAlpha([0, 0.7, 0], key) < 0.05, 'a shaded part of the screen');
  assert.ok(keyAlpha([0.25, 1, 0.25], key) < 0.3, 'a bright, washed part');
  // Brightness alone does not move a colour's chroma.
  const [cb, cr] = chroma([0.2, 0.2, 0.2]);
  assert.ok(Math.abs(cb) < 1e-6 && Math.abs(cr) < 1e-6, 'greys have none');
  // More tolerance removes more; softness widens the edge only.
  const edge = [0.3, 0.75, 0.3];
  assert.ok(keyAlpha(edge, { ...key, tolerance: 0.9 }) < keyAlpha(edge, { ...key, tolerance: 0.1 }));
  assert.equal(keyRange({ ...key, softness: 0 }).inner, keyRange(key).inner);
  // Another key colour works the same way.
  assert.equal(keyAlpha([0, 0, 1], { ...key, color: '#0000ff' }), 0);
  assert.equal(keyAlpha([0, 1, 0], { ...key, color: '#0000ff' }), 1);
});

test('a mask: inside the shape solid, outside gone, feather softens the edge', () => {
  assert.equal(maskAlpha(0.02, 0.02, { shape: 'none', feather: 0 }), 1);
  assert.equal(maskAlpha(0.02, 0.02, { shape: 'rectangle', feather: 0 }), 1, 'a hard rectangle is the whole box');
  const hard = { shape: 'ellipse', feather: 0 };
  assert.equal(maskAlpha(0.5, 0.5, hard), 1, 'the middle');
  assert.equal(maskAlpha(0.02, 0.02, hard), 0, 'a corner of the box');
  assert.equal(maskAlpha(0.5, 0.02, hard), 1, 'the top of the oval');
  const soft = { shape: 'ellipse', feather: 0.5 };
  assert.equal(maskAlpha(0.5, 0.5, soft), 1);
  const a = maskAlpha(0.5, 0.125, soft); // three quarters of the way out
  assert.ok(Math.abs(a - 0.5) < 1e-9, `half-way through the soft edge: ${a}`);
  const rect = { shape: 'rectangle', feather: 0.5 };
  assert.equal(maskAlpha(0.5, 0.5, rect), 1);
  assert.ok(Math.abs(maskAlpha(0.125, 0.5, rect) - 0.5) < 1e-9, 'half-way in from the left edge');
  assert.equal(maskAlpha(0, 0.5, rect), 0, 'the edge itself');
});

// A context that records what the overlay layer asks of it.
function recorder() {
  const calls = [];
  const ctx = {
    calls,
    set globalAlpha(v) { calls.push(['alpha', v]); },
    set globalCompositeOperation(v) { calls.push(['blend', v]); }
  };
  for (const m of ['save', 'restore', 'translate', 'rotate', 'drawImage', 'beginPath', 'ellipse', 'clip']) {
    ctx[m] = (...args) => calls.push([m, ...args]);
  }
  return ctx;
}
const stateFor = (patch) => {
  const p = P.updateOverlay(base(), 'o1', { x: 0, y: 0, scale: 1, ...patch });
  return { project: p, outT: 1, size: { width: 1920, height: 1080 }, frames: { '@overlay:o1': { width: 100, height: 100 } } };
};

test('drawing: a plain overlay is one drawImage, as before; a blend sets the canvas operation; an oval clips', () => {
  let ctx = recorder();
  draw(ctx, stateFor({}));
  assert.deepEqual(ctx.calls.map((c) => c[0]), ['save', 'alpha', 'translate', 'drawImage', 'restore']);
  ctx = recorder();
  draw(ctx, stateFor({ blend: 'add' }));
  assert.deepEqual(ctx.calls.find((c) => c[0] === 'blend'), ['blend', 'lighter']);
  ctx = recorder();
  draw(ctx, stateFor({ mask: { shape: 'ellipse', feather: 0 } }));
  const names = ctx.calls.map((c) => c[0]);
  assert.ok(names.indexOf('ellipse') > 0 && names.indexOf('clip') > names.indexOf('ellipse') && names.indexOf('drawImage') > names.indexOf('clip'), names.join(' '));
  const e = ctx.calls.find((c) => c[0] === 'ellipse');
  assert.deepEqual(e.slice(1, 5), [0, 0, 540, 540], 'the oval fills the picture’s box');
  // Green screen without a GPU (this test runner): drawn unkeyed, not dropped.
  ctx = recorder();
  draw(ctx, stateFor({ key: { on: true, color: '#00ff00', tolerance: 0.5, softness: 0.2 } }));
  assert.equal(ctx.calls.filter((c) => c[0] === 'drawImage').length, 1);
});
