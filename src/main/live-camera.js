'use strict';

const { springStep, followStep, SAMPLE_RATE } = require('./camera');
const { ZOOM_MIN } = require('./zoom');

// camera.js's solveCamera run causally, one frame at a time, so the on-screen
// zoom frame shown DURING recording matches what the rendered video will show:
// the same zoom spring and the same dead-zone cursor follow, stepped at the
// same SAMPLE_RATE. The one thing it can't do live is solveCamera's final
// zero-phase smoothing pass -- that needs the future -- so the live frame
// leads the rendered camera by a hair on fast cursor moves, never by more.

function createLiveCamera({ width, height }) {
  return {
    bounds: { width, height },
    spring: { position: ZOOM_MIN, velocity: 0 },
    cam: { x: width / 2, y: height / 2 },
    cursor: { x: width / 2, y: height / 2 }
  };
}

// Advances the camera by `dt` seconds toward zoom `target`, following
// `cursor` (area-local points, or null to keep the last known one), and
// returns the visible rect in the same area-local points.
function stepLiveCamera(live, { target, cursor, dt }) {
  if (cursor && Number.isFinite(cursor.x) && Number.isFinite(cursor.y)) {
    live.cursor = { x: cursor.x, y: cursor.y };
  }
  // Sub-step at the renderer's own rate: exact parity with easeZoom when
  // called at 1/SAMPLE_RATE, and stable through a long frame hitch.
  const steps = Math.max(1, Math.ceil(dt * SAMPLE_RATE - 1e-9));
  const h = dt / steps;
  for (let i = 0; i < steps; i++) {
    springStep(live.spring, target, h);
    followStep(live.cam, live.spring.position, live.cursor.x, live.cursor.y, live.bounds);
  }

  const zoom = live.spring.position;
  const width = live.bounds.width / zoom;
  const height = live.bounds.height / zoom;
  return {
    zoom,
    rect: { x: live.cam.x - width / 2, y: live.cam.y - height / 2, width, height }
  };
}

module.exports = { createLiveCamera, stepLiveCamera };
