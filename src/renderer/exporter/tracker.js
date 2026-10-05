// The hidden tracking window's entry point: follows what is under a hidden
// area through a stretch of one recording. Main (src/main/ipc/track.js) opens
// this page for one follow: it asks for the job, decodes the recording's
// frames with the exporter's decoder, hands each one -- scaled down, as
// brightness -- to core/track.js, and sends back where the box went as a
// thinned path, or why it couldn't. Main closes the window afterwards (or to
// cancel).
//
// job = { video, rotation, start, end, rect: { x, y, w, h } }
//   video: file:// URL; start/end: recording seconds; rect: fractions of the
//   recording's picture
// result = { path: [{ t, x, y }], lostAt, frames, seconds }
//   lostAt: the recording time at which what was under the box was lost
//   (the path stops just before), or null when it was followed to the end

import { openRecording } from './demux.js';
import { openVideoSource } from './video-source.js';
import {
  createTracker, simplifyPath, SEARCH_PX, LOST_SCORE, MIN_DETAIL, MAX_PATH_POINTS
} from '../../core/track.js';

const bridge = window.loupeTracker;

// The longest side of the pictures the tracker compares. The box moves by
// whole pixels of these, and is looked for within SEARCH_PX of them a frame.
const WORK_PX = 960;
const PROGRESS_EVERY_MS = 100;
// Something passing over what's followed (the cursor, a tooltip) hides it for
// a moment: only when it stays gone this long is it lost.
const LOST_GRACE_SECONDS = 0.5;
// How far the thinned path may stray from the followed one, in tracker pixels.
const PATH_TOLERANCE_PX = 0.75;

// The times of the frames to look at: the one on screen at `start`, then
// every frame shown before `end`.
function frameTimes(samples, start, end) {
  const times = samples.map((s) => s.time).sort((a, b) => a - b);
  let first = 0;
  while (first + 1 < times.length && times[first + 1] <= start) first++;
  const out = [];
  for (let i = first; i < times.length && (i === first || times[i] < end); i++) {
    if (i === first || times[i] > times[i - 1]) out.push(times[i]);
  }
  return out;
}

async function follow(job) {
  const began = performance.now();
  const label = 'the recording';
  const demuxed = await openRecording(job.video, label);
  const source = await openVideoSource(demuxed, label, { rotation: job.rotation });
  try {
    const times = frameTimes(demuxed.video.samples, job.start, job.end);
    if (!times.length) throw new Error('There is no picture in this part of the recording.');

    let width = 0;
    let height = 0;
    let ctx = null;
    let luma = null;
    let tracker = null;
    let box = null; // the box in tracker pixels, where it was last found
    // Only the part of the picture the tracker can reach is scaled down and
    // read back (the rest of `luma` is never looked at).
    const read = (frame) => {
      const reach = SEARCH_PX + 2;
      const x0 = Math.max(0, Math.floor(box.x) - reach);
      const y0 = Math.max(0, Math.floor(box.y) - reach);
      const x1 = Math.min(width, Math.ceil(box.x + box.w) + reach);
      const y1 = Math.min(height, Math.ceil(box.y + box.h) + reach);
      if (x1 <= x0 || y1 <= y0) return;
      const kx = frame.displayWidth / width;
      const ky = frame.displayHeight / height;
      ctx.drawImage(frame, x0 * kx, y0 * ky, (x1 - x0) * kx, (y1 - y0) * ky, x0, y0, x1 - x0, y1 - y0);
      const { data } = ctx.getImageData(x0, y0, x1 - x0, y1 - y0);
      const w = x1 - x0;
      for (let y = y0; y < y1; y++) {
        let at = ((y - y0) * w) * 4;
        const row = y * width;
        for (let x = x0; x < x1; x++, at += 4) {
          luma[row + x] = (data[at] * 77 + data[at + 1] * 150 + data[at + 2] * 29) >> 8;
        }
      }
    };

    const points = []; // { t, x, y }: the box's corner in tracker pixels
    let lostSince = null;
    let lostAt = null;
    let lastReport = 0;
    let frames = 0;
    for (let k = 0; k < times.length; k++) {
      const frame = await source.frameAt(times[k]);
      const t = Math.min(job.end, Math.max(job.start, times[k]));
      frames++;
      if (!tracker) {
        const scale = Math.min(1, WORK_PX / Math.max(frame.displayWidth, frame.displayHeight));
        width = Math.max(1, Math.round(frame.displayWidth * scale));
        height = Math.max(1, Math.round(frame.displayHeight * scale));
        const canvas = new OffscreenCanvas(width, height);
        ctx = canvas.getContext('2d', { alpha: false, willReadFrequently: true });
        ctx.imageSmoothingQuality = 'high';
        luma = new Uint8Array(width * height);
        tracker = createTracker({ width, height });
        box = { x: job.rect.x * width, y: job.rect.y * height, w: job.rect.w * width, h: job.rect.h * height };
        read(frame);
        const first = tracker.start(luma, box);
        if (first.detail < MIN_DETAIL) {
          throw new Error('There’s nothing under the box to follow. Put it over something with detail, like text, and try again.');
        }
        points.push({ t, x: box.x, y: box.y });
      } else {
        read(frame);
        const r = tracker.step(luma);
        if (r.score < LOST_SCORE) {
          lostSince ??= t;
          if (t - lostSince >= LOST_GRACE_SECONDS) { lostAt = lostSince; break; }
        } else {
          lostSince = null;
          box.x = r.x;
          box.y = r.y;
          if (t > points.at(-1).t) points.push({ t, x: r.x, y: r.y });
        }
      }
      const now = performance.now();
      if (now - lastReport > PROGRESS_EVERY_MS || k === times.length - 1) {
        lastReport = now;
        bridge.progress({ frame: k + 1, total: times.length });
      }
    }
    // Gone by the end without the grace running out: it stopped there.
    if (lostAt === null && lostSince !== null && points.length > 1) lostAt = lostSince;
    if (points.length < 2) {
      if (lostSince !== null) throw new Error('What’s under the box changes straight away, so it couldn’t be followed.');
      // A still stretch: one picture, so the box stays where it is.
      points.push({ t: Math.max(job.end, points[0].t + 1e-3), x: points[0].x, y: points[0].y });
    }
    // Thinned in the tracker's pixels (a pixel is the same step both ways),
    // then stored as fractions of the picture.
    const path = simplifyPath(points, PATH_TOLERANCE_PX, { max: MAX_PATH_POINTS })
      .map((p) => ({ t: p.t, x: p.x / width, y: p.y / height }));
    return { path, lostAt, frames, seconds: (performance.now() - began) / 1000 };
  } finally {
    source.close();
  }
}

async function run() {
  bridge.done(await follow(await bridge.job()));
}

run().catch((err) => {
  console.error(err);
  bridge.fail(err?.message ?? String(err));
});
