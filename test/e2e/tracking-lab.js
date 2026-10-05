// The fixture for tracking-blur.e2e.js, made with WebCodecs on a hidden page
// (as lab.js makes the export fixtures): a recording in which a textured
// block crosses a plain background at a known speed.
//
//   trackingLab.makeMovingBlock({ name, width, height, fps, duration, block, marker, still, moveFor, velocity, goneAt })
//
// The picture at recording time t:
//   - a plain grey background
//   - a small textured marker that never moves, where the block starts (so
//     it is under the block at first, and uncovered once the block has left)
//   - the block: random light and dark cells, at
//       block.x + velocity.x * m, block.y + velocity.y * m   (whole pixels)
//     where m = clamp(t - still, 0, moveFor): still at first, then moving,
//     then still again; from `goneAt` on it is not drawn at all.

import { Muxer, ArrayBufferTarget } from '../../src/vendor/mp4-muxer/mp4-muxer.mjs';

const CELL = 4;

function texture(w, h, seed) {
  const canvas = new OffscreenCanvas(w, h);
  const ctx = canvas.getContext('2d');
  let s = seed >>> 0;
  for (let y = 0; y < h; y += CELL) {
    for (let x = 0; x < w; x += CELL) {
      s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
      ctx.fillStyle = s / 4294967296 < 0.5 ? '#141414' : '#ececec';
      ctx.fillRect(x, y, CELL, CELL);
    }
  }
  return canvas;
}

function blockAt(t, { block, still, moveFor, velocity }) {
  const m = Math.max(0, Math.min(moveFor, t - still));
  return { x: Math.round(block.x + velocity.x * m), y: Math.round(block.y + velocity.y * m) };
}

async function makeMovingBlock(o) {
  const { name, width, height, fps, duration, block, marker, goneAt } = o;
  const target = new ArrayBufferTarget();
  const muxer = new Muxer({
    target, video: { codec: 'avc', width, height, frameRate: fps }, fastStart: false, firstTimestampBehavior: 'offset'
  });
  let error = null;
  const encoder = new VideoEncoder({
    output: (chunk, meta) => muxer.addVideoChunk(chunk, meta),
    error: (e) => { error = e; }
  });
  encoder.configure({ codec: 'avc1.640028', width, height, bitrate: 6e6, framerate: fps, avc: { format: 'avc' } });
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext('2d', { alpha: false });
  const blockPicture = texture(block.w, block.h, 7);
  const markerPicture = texture(marker.w, marker.h, 99);
  const count = Math.round(duration * fps);
  for (let i = 0; i < count; i++) {
    const t = i / fps;
    ctx.fillStyle = '#7c8794';
    ctx.fillRect(0, 0, width, height);
    ctx.drawImage(markerPicture, marker.x, marker.y);
    if (t < goneAt) {
      const at = blockAt(t, o);
      ctx.drawImage(blockPicture, at.x, at.y);
    }
    const frame = new VideoFrame(canvas, { timestamp: Math.round(t * 1e6) });
    encoder.encode(frame, { keyFrame: i % fps === 0 });
    frame.close();
    while (encoder.encodeQueueSize > 4) await new Promise((resolve) => setTimeout(resolve, 1));
  }
  await encoder.flush();
  encoder.close();
  if (error) throw error;
  muxer.finalize();
  const file = new Uint8Array(target.buffer);
  await window.labHost.save(name, file);
  return { frames: count, bytes: file.byteLength };
}

window.trackingLab = { makeMovingBlock };
window.trackingLabReady = true;
