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

module.exports = { zoomSegments, deleteSegment };
