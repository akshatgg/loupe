'use strict';

// Pure rectangle math for the region-selection overlay: moving, resizing
// from a handle, and free-drawing a new rectangle, all clamped to the
// source's own bounds and never allowed to collapse under MIN_REGION_SIZE
// mid-gesture (not just at confirm time). Everything here operates in the
// overlay's own local coordinate space (0,0 at the target's top-left, in
// points) -- the overlay window is sized 1:1 in points to the target
// display, so no scale conversion happens here; region.js in main.js is
// what rebases the confirmed rectangle back into global screen coordinates.
//
// This file is required directly by test/region-geometry.test.js and is
// ALSO the source the region overlay's renderer script
// (src/renderer/region/region.js) keeps in sync with by hand -- renderer
// files are plain browser scripts with no `require`, so the two copies
// cannot literally share one file (see editor.js's sampleCamera for the
// same project convention: small pure display/interaction math is
// duplicated into the renderer rather than shared).
const { MIN_REGION_SIZE } = require('./region');

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

// Pulls a rect fully inside bounds, shrinking it first if it's larger than
// bounds in either dimension.
function clampRect(rect, bounds) {
  const width = clamp(rect.width, 0, bounds.width);
  const height = clamp(rect.height, 0, bounds.height);
  const x = clamp(rect.x, 0, bounds.width - width);
  const y = clamp(rect.y, 0, bounds.height - height);
  return { x, y, width, height };
}

function moveRect(rect, dx, dy, bounds) {
  const x = clamp(rect.x + dx, 0, bounds.width - rect.width);
  const y = clamp(rect.y + dy, 0, bounds.height - rect.height);
  return { x, y, width: rect.width, height: rect.height };
}

// handle is one of n/s/e/w/ne/nw/se/sw, naming which edge(s) are being
// dragged. Each edge is clamped independently against the opposite edge
// (offset by minSize) and against bounds, so the rectangle can never be
// resized past the source's edge or collapsed under the minimum -- during
// the drag, not just once the pointer is released.
function resizeRect(handle, startRect, dx, dy, bounds, minSize = MIN_REGION_SIZE) {
  let left = startRect.x;
  let top = startRect.y;
  let right = startRect.x + startRect.width;
  let bottom = startRect.y + startRect.height;
  if (handle.includes('w')) left = clamp(left + dx, 0, right - minSize);
  if (handle.includes('e')) right = clamp(right + dx, left + minSize, bounds.width);
  if (handle.includes('n')) top = clamp(top + dy, 0, bottom - minSize);
  if (handle.includes('s')) bottom = clamp(bottom + dy, top + minSize, bounds.height);
  return { x: left, y: top, width: right - left, height: bottom - top };
}

// A free-draw gesture: `anchor` is the fixed point (where the drag started),
// `point` is the current pointer position. Behaves like resizeRect anchored
// at whichever corner the drag started from, so it inherits the same
// live minimum-size and bounds clamping.
function drawRect(anchor, point, bounds, minSize = MIN_REGION_SIZE) {
  let x1 = clamp(point.x, 0, bounds.width);
  let y1 = clamp(point.y, 0, bounds.height);
  if (Math.abs(x1 - anchor.x) < minSize) {
    const dir = x1 >= anchor.x ? 1 : -1;
    x1 = clamp(anchor.x + dir * minSize, 0, bounds.width);
  }
  if (Math.abs(y1 - anchor.y) < minSize) {
    const dir = y1 >= anchor.y ? 1 : -1;
    y1 = clamp(anchor.y + dir * minSize, 0, bounds.height);
  }
  const x = Math.min(anchor.x, x1);
  const y = Math.min(anchor.y, y1);
  return { x, y, width: Math.abs(x1 - anchor.x), height: Math.abs(y1 - anchor.y) };
}

// Converts a window source's global-space bounds into the overlay's local
// coordinate space (relative to the target display's own origin), clamped
// to the target's bounds -- a window can extend past the edge of the
// display it mostly sits on, or (rarely) span two displays.
function windowFitRect(win, target, bounds) {
  const rect = { x: win.x - target.x, y: win.y - target.y, width: win.width, height: win.height };
  return clampRect(rect, bounds);
}

module.exports = { clamp, clampRect, moveRect, resizeRect, drawRect, windowFitRect };
