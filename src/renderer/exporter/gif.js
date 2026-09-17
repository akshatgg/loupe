// GIF export: each output frame is drawn by the pipeline, reduced to 256
// colours and written with the vendored gifenc.
//
//  - A palette is made for the first frame and made again only when the
//    picture changes enough that it no longer suits it (a new scene), so a
//    recording that goes from a dark editor to a bright web page keeps its
//    colours without paying for a colour table on every frame.
//  - Only what changed is drawn: pixels that still look like what is on
//    screen are left transparent (the last palette entry) over the frame
//    before, which is kept ("do not dispose"). A screen recording changes in
//    small places, so this is most of the saving.
//  - A frame with nothing changed isn't written; the frame before it is
//    shown for longer instead.
//
//   createGifWriter({ width, height, fps, dither, write }) ->
//     { addFrame(rgba, k), finish(frameCount) -> { bytes, frames, palettes } }
//
// `write(position, bytes)` receives the file in order; only the frame waiting
// for its length to be known is kept in memory.

import { GIFEncoder, quantize } from '../../vendor/gifenc/gifenc.mjs';
import {
  delayCs, createColorMap, mapToPalette, paletteError, NEW_PALETTE_ERROR, subsample,
  keepUnchanged, createScreen
} from '../../core/gif.js';

// One entry is kept free for transparency.
const MAX_COLOURS = 255;
const DO_NOT_DISPOSE = 1;

export function createGifWriter({ width, height, fps, dither = true, write }) {
  const gif = GIFEncoder();
  let position = 0;
  let written = 0;
  let palettes = 0;
  let globalPalette = null;
  let map = null;
  let screen = null;
  // The frame waiting to be written: it can't be until its length is known.
  let pending = null;

  async function flushPending(endFrame) {
    if (!pending) return;
    const first = written === 0;
    gif.writeFrame(pending.index, width, height, {
      delay: delayCs(pending.from, endFrame, fps) * 10,
      // The first palette is the file's global one; later ones travel with
      // their frames only when they differ.
      palette: first || pending.palette !== globalPalette ? pending.palette : null,
      transparent: !first,
      transparentIndex: pending.transparentIndex,
      dispose: DO_NOT_DISPOSE,
      repeat: 0
    });
    if (first) globalPalette = pending.palette;
    written++;
    pending = null;
    const bytes = gif.bytes();
    gif.stream.reset();
    await write(position, bytes);
    position += bytes.byteLength;
  }

  return {
    // rgba: output frame k's pixels.
    async addFrame(rgba, k) {
      let next = map;
      if (!next || paletteError(rgba, next) > NEW_PALETTE_ERROR) {
        next = createColorMap(quantize(subsample(rgba, width, height), MAX_COLOURS));
        // The transparent entry goes last; its colour is never drawn.
        next.writePalette = [...next.palette, [0, 0, 0]];
      }
      const transparentIndex = next.palette.length;
      const index = mapToPalette(rgba, width, height, next, { dither });
      if (screen) {
        // Nothing to draw: the frame before is shown for longer.
        if (keepUnchanged(rgba, index, next.palette, transparentIndex, screen) === 0) return;
      } else {
        screen = createScreen(rgba, index, next.palette);
      }
      if (next !== map) palettes++;
      map = next;
      await flushPending(k);
      pending = { from: k, index, palette: map.writePalette, transparentIndex };
    },
    async finish(frameCount) {
      await flushPending(frameCount);
      gif.finish();
      const bytes = gif.bytes();
      gif.stream.reset();
      await write(position, bytes);
      position += bytes.byteLength;
      return { bytes: position, frames: written, palettes };
    }
  };
}
