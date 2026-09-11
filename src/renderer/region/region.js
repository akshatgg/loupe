'use strict';

// Pure rectangle math, kept in sync BY HAND with src/main/region-geometry.js
// (which test/region-geometry.test.js exercises directly). Renderer scripts
// here are plain browser scripts with no `require`, so the two files can't
// literally share one module -- see editor.js's sampleCamera for the same
// established project convention of duplicating a small piece of pure
// display/interaction math into the renderer.
const MIN_REGION_SIZE = 40;

function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

function moveRect(rect, dx, dy, bounds) {
  const x = clamp(rect.x + dx, 0, bounds.width - rect.width);
  const y = clamp(rect.y + dy, 0, bounds.height - rect.height);
  return { x, y, width: rect.width, height: rect.height };
}

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

// ---- DOM wiring ---------------------------------------------------------
//
// This overlay is driven entirely by the control bar, via main.js: there is
// no confirm/cancel/preset UI of its own any more -- Start/Back live on the
// bar (src/renderer/bar/), and "Full screen"/"Rectangle"/"Draw" are buttons
// there too. This window's only jobs are (1) show the live dashed outline +
// handles for whatever rect main.js last told it to show, and (2) report
// every drag/resize/draw change back to main.js as it happens, so the bar's
// Start button always has the current rectangle to hand to recorder.start().

const rectEl = document.getElementById('rect');
const readoutEl = document.getElementById('readout');

let target = null;      // the display's own global-space {x,y,width,height}
let bounds = null;      // {x:0, y:0, width, height} -- the overlay's own local bounds
let rect = null;        // the current selection, in overlay-local points, or null

// Drag state. Only one of these is active at a time; `dragMode` is null
// between gestures.
let dragMode = null;     // 'move' | 'resize' | 'draw' | null
let dragHandle = null;
let dragOrigin = null;   // pointer position, in local coords, at gesture start
let dragStartRect = null;
let drawAnchor = null;

function defaultRect(b) {
  const width = Math.round(b.width * 0.8);
  const height = Math.round(b.height * 0.8);
  return { x: Math.round((b.width - width) / 2), y: Math.round((b.height - height) / 2), width, height };
}

function toLocal(e) {
  return { x: e.clientX, y: e.clientY };
}

function pointInRect(p, r) {
  return p.x >= r.x && p.x <= r.x + r.width && p.y >= r.y && p.y <= r.y + r.height;
}

function render() {
  if (!rect) {
    rectEl.hidden = true;
    return;
  }
  rectEl.hidden = false;
  rectEl.style.left = `${rect.x}px`;
  rectEl.style.top = `${rect.y}px`;
  rectEl.style.width = `${rect.width}px`;
  rectEl.style.height = `${rect.height}px`;
  readoutEl.textContent = `${Math.round(rect.width)} × ${Math.round(rect.height)} pt`;
}

// Reports the current rect back to main.js, in the SAME global screen-point
// space bin/sources reports source x/y in (the overlay's local space is
// target-relative). A one-way `send`, not `invoke`: main.js has nothing to
// hand back, and this fires on every pointermove of a drag.
function reportLive() {
  if (!rect || rect.width < MIN_REGION_SIZE || rect.height < MIN_REGION_SIZE) return;
  window.loupe.reportAreaLive({
    x: target.x + rect.x, y: target.y + rect.y,
    width: rect.width, height: rect.height
  });
}

function setRect(next, { silent = false } = {}) {
  rect = next;
  render();
  if (!silent) reportLive();
}

document.addEventListener('pointerdown', (e) => {
  if (e.button !== 0) return;
  const p = toLocal(e);
  const handle = e.target.dataset ? e.target.dataset.handle : undefined;
  if (handle && rect) {
    dragMode = 'resize';
    dragHandle = handle;
    dragOrigin = p;
    dragStartRect = rect;
  } else if (rect && pointInRect(p, rect)) {
    dragMode = 'move';
    dragOrigin = p;
    dragStartRect = rect;
  } else {
    dragMode = 'draw';
    drawAnchor = p;
    setRect({ x: p.x, y: p.y, width: 0, height: 0 }, { silent: true });
  }
  e.preventDefault();
});

document.addEventListener('pointermove', (e) => {
  if (!dragMode) return;
  const p = toLocal(e);
  if (dragMode === 'move') {
    setRect(moveRect(dragStartRect, p.x - dragOrigin.x, p.y - dragOrigin.y, bounds));
  } else if (dragMode === 'resize') {
    setRect(resizeRect(dragHandle, dragStartRect, p.x - dragOrigin.x, p.y - dragOrigin.y, bounds));
  } else if (dragMode === 'draw') {
    setRect(drawRect(drawAnchor, p, bounds));
  }
});

document.addEventListener('pointerup', () => {
  dragMode = null;
  dragHandle = null;
  dragStartRect = null;
  drawAnchor = null;
});

// Applies a {mode, rect} command from main.js: 'full' is never sent here
// (main.js hides this whole window instead -- see setAreaMode in main.js),
// 'draw' clears the rect so the next drag anywhere free-draws a fresh one,
// and 'rect' shows either the rect main.js already knew about (the user's
// last-drawn one) or, the first time, a centered default.
function applyCommand({ mode, rect: nextRect }) {
  if (mode === 'draw') {
    setRect(null, { silent: true });
  } else {
    setRect(nextRect ?? defaultRect(bounds), { silent: true });
  }
}

window.loupe.onRegionCommand(applyCommand);

// Escape (= the bar's Back) is a global shortcut main.js holds while this
// window is up -- not a keydown here, since this window is shown inactive
// and so wouldn't hear the key until it had been clicked.

async function init() {
  const data = await window.loupe.regionInit();
  target = data.target;
  bounds = { x: 0, y: 0, width: target.width, height: target.height };
  applyCommand({ mode: data.mode, rect: data.rect });
}

init();
