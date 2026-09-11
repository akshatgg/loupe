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

// Zoom removal in the editor is non-destructive. recordedZoomKeyframes keeps
// every zoom made while recording, never edited; removedZooms lists the
// segments removed since, in order; zoomKeyframes -- what the camera solver
// and export read -- is always the one derived from the other two. So a
// removal can be undone, or all of them restored, even after the editor has
// been closed and reopened. (Removal used to rewrite zoomKeyframes in place,
// which lost the zoom for good on a single stray click.)
function withZoomHistory(project) {
  return {
    ...project,
    // A project from before this existed: whatever it has now becomes the
    // baseline. Anything it already lost can't be brought back.
    recordedZoomKeyframes: Array.isArray(project.recordedZoomKeyframes)
      ? project.recordedZoomKeyframes : project.zoomKeyframes,
    removedZooms: Array.isArray(project.removedZooms) ? project.removedZooms : []
  };
}

function rederive(project) {
  return {
    ...project,
    zoomKeyframes: project.removedZooms.reduce(deleteSegment, project.recordedZoomKeyframes)
  };
}

function removeZoom(project, segment) {
  const p = withZoomHistory(project);
  return rederive({ ...p, removedZooms: [...p.removedZooms, segment] });
}

function undoRemoveZoom(project) {
  const p = withZoomHistory(project);
  return rederive({ ...p, removedZooms: p.removedZooms.slice(0, -1) });
}

function restoreAllZooms(project) {
  return rederive({ ...withZoomHistory(project), removedZooms: [] });
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

module.exports = {
  zoomSegments, deleteSegment, validateSegment,
  removeZoom, undoRemoveZoom, restoreAllZooms
};
