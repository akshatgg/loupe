'use strict';

// Pure rectangle math, kept in sync BY HAND with src/main/region-geometry.js
// (which test/region-geometry.test.js exercises directly). Renderer scripts
// here are plain browser scripts with no `require`, so the two files can't
// literally share one module -- see editor.js's sampleCamera for the same
// established project convention of duplicating a small piece of pure
// display/interaction math into the renderer.
const MIN_REGION_SIZE = 40;

function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

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

function windowFitRect(win, target, bounds) {
  const rect = { x: win.x - target.x, y: win.y - target.y, width: win.width, height: win.height };
  return clampRect(rect, bounds);
}

// ---- DOM wiring ---------------------------------------------------------

const rectEl = document.getElementById('rect');
const readoutEl = document.getElementById('readout');
const confirmBtn = document.getElementById('confirm');
const cancelBtn = document.getElementById('cancel');
const presetFullBtn = document.getElementById('presetFull');
const presetWindowBtn = document.getElementById('presetWindow');
const presetDrawBtn = document.getElementById('presetDraw');
const windowMenu = document.getElementById('windowMenu');

let target = null;      // the display's own global-space {x,y,width,height}
let bounds = null;      // {x:0, y:0, width, height} -- the overlay's own local bounds
let windows = [];        // window sources, for the "Fit a window" preset
let rect = null;         // the current selection, in overlay-local points, or null

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
    confirmBtn.disabled = true;
    return;
  }
  rectEl.hidden = false;
  rectEl.style.left = `${rect.x}px`;
  rectEl.style.top = `${rect.y}px`;
  rectEl.style.width = `${rect.width}px`;
  rectEl.style.height = `${rect.height}px`;
  readoutEl.textContent = `${Math.round(rect.width)} × ${Math.round(rect.height)} pt`;
  confirmBtn.disabled = rect.width < MIN_REGION_SIZE || rect.height < MIN_REGION_SIZE;
}

function setRect(next) {
  rect = next;
  render();
}

async function confirm() {
  if (!rect || confirmBtn.disabled) return;
  const globalRegion = {
    x: target.x + rect.x, y: target.y + rect.y,
    width: rect.width, height: rect.height
  };
  await window.loupe.regionConfirm(globalRegion);
}

async function cancel() {
  await window.loupe.regionCancel();
}

// Window titles are the OS's own, and any process picks its own -- built
// with textContent, never innerHTML, the same rule the picker's source list
// already follows.
function buildWindowMenu() {
  windowMenu.textContent = '';
  if (windows.length === 0) {
    const none = document.createElement('div');
    none.className = 'none';
    none.textContent = 'No open windows found.';
    windowMenu.appendChild(none);
    return;
  }
  for (const win of windows) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.setAttribute('role', 'menuitem');
    btn.textContent = win.app ? `${win.app} — ${win.title}` : win.title;
    btn.onclick = () => {
      setRect(windowFitRect(win, target, bounds));
      windowMenu.hidden = true;
      presetWindowBtn.setAttribute('aria-pressed', 'false');
    };
    windowMenu.appendChild(btn);
  }
}

presetFullBtn.onclick = () => {
  windowMenu.hidden = true;
  setRect({ x: 0, y: 0, width: bounds.width, height: bounds.height });
};

presetWindowBtn.onclick = () => {
  const opening = windowMenu.hidden;
  windowMenu.hidden = !opening;
  presetWindowBtn.setAttribute('aria-pressed', String(opening));
};

presetDrawBtn.onclick = () => {
  windowMenu.hidden = true;
  // Clears the rectangle entirely -- the next pointerdown on empty space
  // (anywhere, now that nothing is selected) starts a fresh free-draw drag.
  setRect(null);
};

confirmBtn.onclick = () => { confirm(); };
cancelBtn.onclick = () => { cancel(); };

document.addEventListener('pointerdown', (e) => {
  if (e.button !== 0) return;
  if (e.target.closest('#toolbar') || e.target.closest('#windowMenu')) return;
  windowMenu.hidden = true;
  presetWindowBtn.setAttribute('aria-pressed', 'false');

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
    setRect({ x: p.x, y: p.y, width: 0, height: 0 });
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

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    e.preventDefault();
    cancel();
  } else if (e.key === 'Enter') {
    e.preventDefault();
    confirm();
  }
});

async function init() {
  const data = await window.loupe.regionInit();
  target = data.target;
  windows = (data.windows || []).filter((s) => s.kind === 'window');
  bounds = { x: 0, y: 0, width: target.width, height: target.height };
  buildWindowMenu();
  setRect(defaultRect(bounds));
}

init();
