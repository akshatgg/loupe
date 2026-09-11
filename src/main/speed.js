'use strict';

const { buildMap, toOutput, toSource } = require('./timemap');

// Per-stretch speed (PRD FR-18..FR-22). Segments live in RECORDING time
// (t_src, like zoom keyframes and the cursor), as {srcStart, srcEnd, rate};
// timemap.js turns them into the recording <-> video time map. Everything
// the exporter needs is derived from that map here, in one tested place, and
// handed to bin/render as data -- the Swift side does no timing math.

const SPEED_MIN = 0.25;
const SPEED_MAX = 8;
const MIN_SEGMENT_SECONDS = 0.1;
const EXPORT_FPS = 60;
// TRD §6.1: a ramp is approximated by this many constant-rate slices, for
// the audio (AVFoundation can only scale a time range by a constant).
const RAMP_SLICES = 10;
const EPS = 1e-9;

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

// The editor is not a trust boundary: every paint is checked here. A drag
// past either end of the recording is clamped rather than refused.
function validateSpeedPaint(raw, duration) {
  const { srcStart, srcEnd, rate } = raw ?? {};
  if (!isNum(srcStart) || !isNum(srcEnd)) {
    throw new Error(`Invalid speed range: ${JSON.stringify(raw)}`);
  }
  if (!isNum(rate) || rate < SPEED_MIN || rate > SPEED_MAX) {
    throw new Error(`Speed must be between ${SPEED_MIN}x and ${SPEED_MAX}x, got ${JSON.stringify(rate)}`);
  }
  const start = Math.max(0, srcStart);
  const end = Math.min(duration, srcEnd);
  if (end - start < MIN_SEGMENT_SECONDS) {
    throw new Error(`Speed range too short: ${start}..${end}`);
  }
  return { srcStart: start, srcEnd: end, rate };
}

// Painting a speed over a range replaces whatever was there, trimming or
// splitting any segment it overlaps; 1x just puts the range back to normal.
// Touching segments at the same rate merge, so painting a stretch in two
// drags doesn't leave a ramp down to 1x and back up at the seam.
function paintSpeed(segments, { srcStart, srcEnd, rate }) {
  const out = [];
  for (const s of segments) {
    if (s.srcEnd <= srcStart || s.srcStart >= srcEnd) { out.push({ ...s }); continue; }
    if (s.srcStart < srcStart) out.push({ ...s, srcEnd: srcStart });
    if (s.srcEnd > srcEnd) out.push({ ...s, srcStart: srcEnd });
  }
  if (rate !== 1) out.push({ srcStart, srcEnd, rate });
  out.sort((a, b) => a.srcStart - b.srcStart);

  const merged = [];
  for (const s of out) {
    if (s.srcEnd - s.srcStart < MIN_SEGMENT_SECONDS - EPS) continue;
    const prev = merged.at(-1);
    if (prev && prev.rate === s.rate && s.srcStart - prev.srcEnd <= 1e-6) prev.srcEnd = s.srcEnd;
    else merged.push(s);
  }
  return merged;
}

// The source-time edges of one segment's constant-rate slices: RAMP_SLICES
// across each ramp (same ramp length timemap.js uses), the middle as one.
function sliceEdges(seg, rampSeconds) {
  const ramp = Math.min(rampSeconds, (seg.srcEnd - seg.srcStart) / 2);
  const edges = [seg.srcStart];
  if (ramp > 0) {
    for (let i = 1; i <= RAMP_SLICES; i++) edges.push(seg.srcStart + (ramp * i) / RAMP_SLICES);
    for (let i = RAMP_SLICES; i >= 0; i--) edges.push(seg.srcEnd - (ramp * i) / RAMP_SLICES);
  } else {
    edges.push(seg.srcEnd);
  }
  return edges.filter((t, i) => i === 0 || t - edges[i - 1] > EPS);
}

// Everything the exporter needs:
//  - frames: for each output frame k (at k/fps in the video), which moment
//    of the recording it shows. Fast stretches skip frames, slow ones hold.
//  - audio: constant-rate slices of the recording's sound; rate is each
//    slice's exact recording/video duration ratio from the map, so the
//    stretched audio comes out the same length as the video.
function retimePlan(segments, duration, rampMs, fps = EXPORT_FPS) {
  const map = buildMap(segments, duration, rampMs);
  const count = Math.max(1, Math.ceil(map.outputDuration * fps - 1e-6));
  const frames = new Array(count);
  for (let k = 0; k < count; k++) frames[k] = Math.min(duration, toSource(map, k / fps));

  const audio = [];
  for (const seg of segments) {
    const edges = sliceEdges(seg, rampMs / 1000);
    for (let i = 1; i < edges.length; i++) {
      const a = edges[i - 1];
      const b = edges[i];
      audio.push({ srcStart: a, srcEnd: b, rate: (b - a) / (toOutput(map, b) - toOutput(map, a)) });
    }
  }
  return { fps, outputDuration: map.outputDuration, frames, audio };
}

function outputDuration(segments, duration, rampMs) {
  return segments.length ? buildMap(segments, duration, rampMs).outputDuration : duration;
}

module.exports = {
  SPEED_MIN, SPEED_MAX, EXPORT_FPS,
  validateSpeedPaint, paintSpeed, retimePlan, outputDuration
};
