'use strict';

// The "what's in shot" frame shown on screen while recording. main.js steps
// live-camera.js (the same math the rendered video uses) and pushes the
// visible rect here, in this window's own local points -- the window covers
// exactly the recorded area. Click-through and excluded from the capture;
// this page only draws.

const frameEl = document.getElementById('frame');
const badgeEl = document.getElementById('badge');

// Below this the video is effectively un-zoomed, so there's no frame to show.
const ZOOMED = 1.02;
const BADGE_MARGIN = 10;

let fadeTimer = null;
let wasZoomed = false;

function placeBadge(rect) {
  // Inside the frame's top-left corner, so it can't run off a screen edge.
  badgeEl.style.left = `${rect.x + BADGE_MARGIN}px`;
  badgeEl.style.top = `${rect.y + BADGE_MARGIN}px`;
}

window.loupe.onShotUpdate(({ zoom, rect }) => {
  const zoomed = zoom >= ZOOMED;
  badgeEl.textContent = `${zoom.toFixed(1)}×`;

  if (zoomed) {
    clearTimeout(fadeTimer);
    frameEl.hidden = false;
    frameEl.style.left = `${rect.x}px`;
    frameEl.style.top = `${rect.y}px`;
    frameEl.style.width = `${rect.width}px`;
    frameEl.style.height = `${rect.height}px`;
    badgeEl.hidden = false;
    badgeEl.classList.remove('fading');
    placeBadge(rect);
  } else if (wasZoomed) {
    // Back at 1.0x: drop the frame, but leave "1.0×" up for a moment so
    // it's clear the zoom really went all the way out.
    frameEl.hidden = true;
    badgeEl.textContent = '1.0×';
    placeBadge({ x: 0, y: 0 });
    fadeTimer = setTimeout(() => {
      badgeEl.classList.add('fading');
      fadeTimer = setTimeout(() => { badgeEl.hidden = true; }, 300);
    }, 900);
  }
  wasZoomed = zoomed;
});
