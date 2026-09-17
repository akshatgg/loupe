import test from 'node:test';
import assert from 'node:assert';
import * as G from '../src/core/gif.js';
import { createGifWriter } from '../src/renderer/exporter/gif.js';
import { parseGif } from './e2e/media-parse.mjs';
import { quantize } from '../src/vendor/gifenc/gifenc.mjs';

test('frame delays add up to the exact length', () => {
  // 15 fps is 6.67 cs a frame: 7, 6, 7, 7, 6, 7, ...
  let total = 0;
  for (let k = 0; k < 150; k++) total += G.delayCs(k, k + 1, 15);
  assert.strictEqual(total, 1000);
  assert.deepStrictEqual([0, 1, 2].map((k) => G.delayCs(k, k + 1, 15)), [7, 6, 7]);
  // A merged stretch gets the whole span.
  assert.strictEqual(G.delayCs(3, 18, 15), 100);
});

test('mapping to a palette picks the nearest colour', () => {
  const map = G.createColorMap([[0, 0, 0], [255, 255, 255], [255, 0, 0]]);
  const rgba = new Uint8Array([10, 10, 10, 255, 250, 240, 245, 255, 240, 10, 10, 255]);
  assert.deepStrictEqual([...G.mapToPalette(rgba, 3, 1, map)], [0, 1, 2]);
  assert.ok(G.paletteError(rgba, map, { step: 1 }) < 25);
  const blue = new Uint8Array([0, 0, 255, 255]);
  assert.ok(G.paletteError(blue, map, { step: 1 }) > G.NEW_PALETTE_ERROR);
});

test('ordered dithering mixes neighbouring colours for an in-between shade, the same way every time', () => {
  const map = G.createColorMap([[96, 96, 96], [112, 112, 112]]);
  const w = 16;
  const h = 16;
  const rgba = new Uint8Array(w * h * 4).fill(104);
  const plain = G.mapToPalette(rgba, w, h, map);
  assert.strictEqual(new Set(plain).size, 1, 'without dithering one colour');
  const dithered = G.mapToPalette(rgba, w, h, map, { dither: true });
  const ones = dithered.reduce((n, v) => n + v, 0);
  assert.ok(ones > w * h * 0.3 && ones < w * h * 0.7, `about half and half, got ${ones}`);
  assert.deepStrictEqual(G.mapToPalette(rgba, w, h, map, { dither: true }), dithered);
});

test('frame differencing redraws what looks different, ignores noise, and leaves no ghosts in a fade', () => {
  const palette = [[20, 20, 20], [60, 60, 60], [200, 200, 200]];
  const map = G.createColorMap(palette);
  const frame = (...values) => new Uint8Array(values.flatMap((v) => [v, v, v, 255]));
  const indexOf = (rgba) => G.mapToPalette(rgba, rgba.length / 4, 1, map);
  // Text (200) on a dark background (20).
  let rgba = frame(200, 20, 20);
  const screen = G.createScreen(rgba, indexOf(rgba), palette);
  // Compression noise: nothing to draw.
  rgba = frame(198, 22, 21);
  assert.strictEqual(G.keepUnchanged(rgba, indexOf(rgba), palette, 3, screen), 0);
  // The text fades out a little at a time; every step whose palette colour
  // differs is drawn, so at the end the screen shows the background.
  for (const v of [150, 110, 80, 50, 35, 25, 20]) {
    rgba = frame(v, 20, 20);
    const index = indexOf(rgba);
    const changed = G.keepUnchanged(rgba, index, palette, 3, screen);
    if (changed) assert.deepStrictEqual([...index.subarray(1)], [3, 3], 'the background stays transparent');
  }
  assert.deepStrictEqual([...screen.drawn.subarray(0, 3)], [20, 20, 20], 'no ghost of the text is left');
});

test('subsample', () => {
  const rgba = new Uint8Array(4 * 4 * 4).map((_, i) => i % 256);
  const half = G.subsample(rgba, 4, 4, 2);
  assert.strictEqual(half.length, 2 * 2 * 4);
  assert.deepStrictEqual([...half.subarray(4, 7)], [...rgba.subarray(8, 11)]);
});

function solid(w, h, [r, g, b]) {
  const out = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) { out[i * 4] = r; out[i * 4 + 1] = g; out[i * 4 + 2] = b; out[i * 4 + 3] = 255; }
  return out;
}

test('the GIF writer merges still frames, makes a palette per scene and streams the file in order', async () => {
  const chunks = [];
  const writer = createGifWriter({
    width: 32, height: 20, fps: 15, dither: false,
    write: async (position, bytes) => { chunks.push({ position, bytes: bytes.slice() }); }
  });
  const red = [220, 40, 40];
  const blue = [40, 80, 220];
  // 15 frames: 0-4 red (identical), 5-9 blue, 10-14 red again.
  for (let k = 0; k < 15; k++) {
    await writer.addFrame(solid(32, 20, k < 5 || k >= 10 ? red : blue), k);
  }
  const result = await writer.finish(15);
  assert.strictEqual(result.frames, 3);
  assert.strictEqual(result.palettes, 3, 'red, then blue, then red again each needed a new palette');
  let at = 0;
  for (const c of chunks) {
    assert.strictEqual(c.position, at, 'written in order with no gaps');
    at += c.bytes.byteLength;
  }
  assert.strictEqual(at, result.bytes);
  const file = new Uint8Array(at);
  for (const c of chunks) file.set(c.bytes, c.position);
  const gif = parseGif(file);
  assert.strictEqual(gif.width, 32);
  assert.strictEqual(gif.height, 20);
  assert.strictEqual(gif.loops, 0, 'loops forever');
  assert.deepStrictEqual(gif.frames.map((f) => f.delayCs), [33, 34, 33]);
  assert.strictEqual(gif.frames.reduce((n, f) => n + f.delayCs, 0), 100);
  assert.ok(gif.globalPalette > 0);
  assert.strictEqual(gif.frames[0].localPalette, 0, 'the first frame uses the global palette');
  assert.ok(gif.frames[1].localPalette > 0, 'a new scene carries its own');
  assert.strictEqual(gif.frames[0].transparent, null, 'the first frame is drawn whole');
  assert.ok(gif.frames.slice(1).every((f) => f.transparent !== null && f.dispose === 1), 'later frames draw over the last');
});

test('a small change costs a small frame', async () => {
  let file = new Uint8Array(0);
  const writer = createGifWriter({
    width: 200, height: 120, fps: 10, dither: true,
    write: async (position, bytes) => {
      const next = new Uint8Array(Math.max(file.length, position + bytes.length));
      next.set(file);
      next.set(bytes, position);
      file = next;
    }
  });
  // A diagonal gradient, then a small square moving over it.
  const base = new Uint8ClampedArray(200 * 120 * 4);
  for (let y = 0; y < 120; y++) {
    for (let x = 0; x < 200; x++) {
      const o = (y * 200 + x) * 4;
      base[o] = x; base[o + 1] = y * 2; base[o + 2] = 128; base[o + 3] = 255;
    }
  }
  for (let k = 0; k < 5; k++) {
    const frame = base.slice();
    for (let y = 50; y < 60; y++) {
      for (let x = 20 + k * 30; x < 30 + k * 30; x++) {
        const o = (y * 200 + x) * 4;
        frame[o] = 255; frame[o + 1] = 255; frame[o + 2] = 255;
      }
    }
    await writer.addFrame(frame, k);
  }
  await writer.finish(5);
  const gif = parseGif(file);
  assert.strictEqual(gif.frames.length, 5);
  assert.strictEqual(gif.frames.reduce((n, f) => n + f.delayCs, 0), 50);
  const [first, ...rest] = gif.frames;
  for (const f of rest) assert.ok(f.bytes * 5 < first.bytes, `a moved square is ${f.bytes} bytes, the whole picture ${first.bytes}`);
});

// What a viewer sees after each frame, following exporter/gif.js's addFrame,
// plus the palette in use (to compare with drawing the frame afresh).
function simulateGif(frames, w, h, dither) {
  let map = null;
  let screen = null;
  let shown = null;
  for (const rgba of frames) {
    let next = map;
    if (!next || G.paletteError(rgba, next) > G.NEW_PALETTE_ERROR) next = G.createColorMap(quantize(G.subsample(rgba, w, h), 255));
    const transparent = next.palette.length;
    const index = G.mapToPalette(rgba, w, h, next, { dither });
    if (screen) {
      if (G.keepUnchanged(rgba, index, next.palette, transparent, screen) === 0) continue;
    } else {
      screen = G.createScreen(rgba, index, next.palette);
      shown = new Uint8Array(w * h * 3);
    }
    map = next;
    for (let p = 0; p < w * h; p++) if (index[p] !== transparent) shown.set(next.palette[index[p]], p * 3);
  }
  return { shown, map };
}

function fakeScreen(w, h, seed) {
  const out = new Uint8ClampedArray(w * h * 4);
  let s = seed;
  const rnd = () => (s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      // Dark editor with a sidebar and lines of coloured text.
      const text = y % 12 < 6 && rnd() < 0.45;
      const c = text ? [120 + rnd() * 110, 120 + rnd() * 110, 130 + rnd() * 110] : x < w / 4 ? [38, 40, 46] : [28, 30, 34];
      out.set([c[0], c[1], c[2], 255], (y * w + x) * 4);
    }
  }
  return out;
}

test('no ghost of an earlier picture is left behind a title card or the next page', () => {
  const w = 96;
  const h = 64;
  const before = fakeScreen(w, h, 7);
  const card = solid(w, h, [22, 26, 36]);
  const after = fakeScreen(w, h, 99);
  const mix = (a, b, f) => a.map((v, i) => (i % 4 === 3 ? 255 : Math.round(v * (1 - f) + b[i] * f)));
  const frames = [before, before];
  for (let k = 1; k <= 6; k++) frames.push(mix(before, card, k / 6));
  frames.push(card, card);
  for (let k = 1; k <= 6; k++) frames.push(mix(card, after, k / 6));
  frames.push(after, after);
  const off = (a, i, b, j) => Math.max(Math.abs(a[i] - b[j]), Math.abs(a[i + 1] - b[j + 1]), Math.abs(a[i + 2] - b[j + 2]));
  for (const dither of [false, true]) {
    for (const n of [10, frames.length]) {
      const { shown, map } = simulateGif(frames.slice(0, n), w, h, dither);
      const now = frames[n - 1];
      // Every pixel on screen is as close to the picture as drawing it afresh
      // with the same palette, give or take compression noise.
      const fresh = G.mapToPalette(now, w, h, map, { dither });
      let ghosts = 0;
      for (let p = 0; p < w * h; p++) {
        const drawn = map.palette[fresh[p]];
        if (off(shown, p * 3, now, p * 4) > off(drawn, 0, now, p * 4) + G.NOISE_TOLERANCE) ghosts++;
      }
      assert.strictEqual(ghosts, 0, `dither ${dither}, after frame ${n}`);
    }
  }
});
