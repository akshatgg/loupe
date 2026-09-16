// GIF export: each output frame is drawn by the pipeline, reduced to 256
// colours and written with the vendored gifenc. A palette is made for the
// first frame and made again only when the picture changes enough that it no
// longer suits it (a new scene), so a recording that goes from a dark editor
// to a bright web page keeps its colours without paying for a colour table on
// every frame. Frames identical to the one before are merged into one longer
// frame, which is most of a screen recording.
//
//   createGifWriter({ width, height, fps, dither, write }) ->
//     { addFrame(rgba, k), finish() -> { bytes, frames, palettes } }
//
// `write(position, bytes)` receives the file in order; nothing but the frame
// waiting to be merged is kept in memory.

import { GIFEncoder, quantize } from '../../vendor/gifenc/gifenc.mjs';
import {
  delayCs, createColorMap, mapToPalette, paletteError, NEW_PALETTE_ERROR, samePixels, subsample
} from '../../core/gif.js';

export function createGifWriter({ width, height, fps, dither = true, write }) {
  const gif = GIFEncoder();
  let position = 0;
  let written = 0;
  let palettes = 0;
  let globalPalette = null;
  let map = null;
  // The frame waiting to be written: it can't be until its length is known.
  let pending = null;

  async function flushPending(endFrame) {
    if (!pending) return;
    const delay = delayCs(pending.from, endFrame, fps) * 10;
    gif.writeFrame(pending.index, width, height, {
      delay,
      // The first palette is the file's global one; later ones travel with
      // their frames.
      palette: pending.palette === globalPalette && written > 0 ? null : pending.palette,
      repeat: 0
    });
    if (written === 0) globalPalette = pending.palette;
    written++;
    const bytes = gif.bytes();
    gif.stream.reset();
    await write(position, bytes);
    position += bytes.byteLength;
  }

  return {
    // rgba: the output frame k's pixels (a fresh array each call).
    async addFrame(rgba, k) {
      if (pending && samePixels(pending.rgba, rgba)) return;
      await flushPending(k);
      if (!map || paletteError(rgba, map) > NEW_PALETTE_ERROR) {
        map = createColorMap(quantize(subsample(rgba, width, height), 256));
        palettes++;
      }
      pending = {
        from: k, rgba, palette: map.palette,
        index: mapToPalette(rgba, width, height, map, { dither })
      };
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
