'use strict';

// A region crop travels through the app as logical points in the SAME
// global screen coordinate space bin/sources reports source x/y in (see
// Sources.swift's SourceOut.x/y comment). It reaches this trust boundary
// two ways: as part of record:start's rawOpts (the renderer -- picker or
// overlay -- is not a trust boundary, same reasoning as validateStartOptions
// in main.js), and via the region-selection overlay's own region:confirm
// channel. Both funnel through validateRegion so a malformed or
// out-of-bounds rectangle can never reach recorder.start()/bin/capture.
//
// A "few tens of points square" per the brief; 40 was chosen as a round
// number comfortably above "a mistake" (a handful of points) while still
// well under any real crop a user would actually want.
const MIN_REGION_SIZE = 40;

function isFiniteNumber(n) {
  return typeof n === 'number' && Number.isFinite(n);
}

// Validates a region rectangle's own shape (finite numbers, positive size at
// or above the minimum). x/y may legitimately be negative -- same as
// validateStartOptions's ox/oy -- because a display left of or above the
// primary display has a negative origin, and a crop drawn against it
// inherits that sign.
function validateRegion(region) {
  const { x, y, width, height } = region ?? {};
  if (!isFiniteNumber(x)) throw new Error(`Invalid region x: ${JSON.stringify(x)}`);
  if (!isFiniteNumber(y)) throw new Error(`Invalid region y: ${JSON.stringify(y)}`);
  if (!isFiniteNumber(width) || width < MIN_REGION_SIZE) {
    throw new Error(`Invalid region width: ${JSON.stringify(width)}`);
  }
  if (!isFiniteNumber(height) || height < MIN_REGION_SIZE) {
    throw new Error(`Invalid region height: ${JSON.stringify(height)}`);
  }
  return { x, y, width, height };
}

// A region only makes sense inside the bounds it was drawn against (the
// target display's own global-space rectangle). Used by the region:confirm
// IPC handler, which receives coordinates the overlay computed itself --
// still worth checking, since the overlay renderer is not a trust boundary
// either.
function clampRegionToBounds(region, bounds) {
  const x = Math.max(bounds.x, Math.min(region.x, bounds.x + bounds.width - region.width));
  const y = Math.max(bounds.y, Math.min(region.y, bounds.y + bounds.height - region.height));
  const width = Math.min(region.width, bounds.width);
  const height = Math.min(region.height, bounds.height);
  return { x, y, width, height };
}

module.exports = { MIN_REGION_SIZE, validateRegion, clampRegionToBounds };
