import test from 'node:test';
import assert from 'node:assert';
import * as G from '../src/core/gif.js';
import { createGifWriter } from '../src/renderer/exporter/gif.js';
import { parseGif } from './e2e/media-parse.mjs';

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
