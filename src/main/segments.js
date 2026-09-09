'use strict';

const { ZOOM_MIN } = require('./zoom');

// A segment is a span during which the target zoom is above 1.0x.
function zoomSegments(keyframes, duration) {
  const segments = [];
  let open = null;

  for (const kf of keyframes) {
    if (kf.zoom > ZOOM_MIN) {
      if (!open) open = { start: kf.t, end: duration, peak: kf.zoom };
      else open.peak = Math.max(open.peak, kf.zoom);
    } else if (open) {
      open.end = kf.t;
      segments.push(open);
      open = null;
    }
  }
  if (open) segments.push(open);
  return segments;
}

function deleteSegment(keyframes, segment) {
  return keyframes.filter((kf) => kf.t < segment.start || kf.t > segment.end);
}

// The renderer is not a trust boundary the main process can rely on: unlike
// record:start's rawOpts (validated by validateStartOptions in main.js
// against the shape the app itself produces), a compromised or buggy
// renderer can call project:deleteZoom with whatever it likes, and
// deleteSegment above has no bounds of its own -- {start: -Infinity, end:
// Infinity} wipes every keyframe. Mirrors validateStartOptions's style:
// finite numbers only, plus the one additional invariant a segment carries
// that a bare coordinate does not -- start must not be after end.
function validateSegment(segment) {
  const { start, end } = segment ?? {};
  if (typeof start !== 'number' || !Number.isFinite(start)) {
    throw new Error(`Invalid segment start: ${JSON.stringify(start)}`);
  }
  if (typeof end !== 'number' || !Number.isFinite(end)) {
    throw new Error(`Invalid segment end: ${JSON.stringify(end)}`);
  }
  if (start > end) {
    throw new Error(`Invalid segment: start (${start}) is after end (${end})`);
  }
  return { start, end };
}

module.exports = { zoomSegments, deleteSegment, validateSegment };
