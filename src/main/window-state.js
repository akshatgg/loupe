'use strict';

const fs = require('node:fs');
const path = require('node:path');

// Where Loupe's own windows were last left (the picker, the editor, the
// Library, Settings), so each opens there again, at the size it was.
//
// Stored in userData/window-state.json as { [name]: { x, y, width, height,
// maximized } }. A remembered place is only used when enough of it is still
// on a connected display: a window saved on an external monitor that has
// since been unplugged opens at its default size, centred on the main
// display, rather than somewhere nobody can reach it.

// How much of a window must be on a display for its old place to count.
const MIN_VISIBLE = { width: 120, height: 60 };
const SAVE_DELAY_MS = 500;

const finite = (v) => typeof v === 'number' && Number.isFinite(v);

function overlap(a, b) {
  const w = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  return { width: Math.max(0, w), height: Math.max(0, h) };
}

// The bounds to open a window with: the saved ones when they are sane and
// still visible on one of `workAreas` ([{ x, y, width, height }]), otherwise
// just the default size (Electron centres a window given no position).
// `defaults`: { width, height, minWidth?, minHeight? }.
function restoreBounds(saved, defaults, workAreas) {
  const size = { width: defaults.width, height: defaults.height };
  if (!saved || typeof saved !== 'object') return size;
  const { x, y, width, height } = saved;
  if (![x, y, width, height].every(finite)) return size;
  const minW = defaults.minWidth ?? 200;
  const minH = defaults.minHeight ?? 150;
  if (width < minW || height < minH || width > 20000 || height > 20000) return size;
  const bounds = { x: Math.round(x), y: Math.round(y), width: Math.round(width), height: Math.round(height) };
  const visible = (workAreas ?? []).some((area) => {
    const o = overlap(bounds, area);
    return o.width >= MIN_VISIBLE.width && o.height >= MIN_VISIBLE.height;
  });
  if (!visible) return size;
  // Bigger than every display now (a smaller screen): the default size.
  const fits = workAreas.some((a) => bounds.width <= a.width && bounds.height <= a.height);
  return fits ? bounds : size;
}

function createWindowState({ file, screen, delayMs = SAVE_DELAY_MS }) {
  let cache = null;
  let timer = null;

  function read() {
    if (cache) return cache;
    try {
      const parsed = JSON.parse(fs.readFileSync(file(), 'utf8'));
      cache = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch {
      cache = {};
    }
    return cache;
  }

  function write() {
    clearTimeout(timer);
    timer = null;
    try {
      const target = file();
      fs.mkdirSync(path.dirname(target), { recursive: true });
      const tmp = `${target}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(read(), null, 2));
      fs.renameSync(tmp, target);
    } catch (err) {
      // Forgetting where a window was is not worth bothering anyone about.
      console.warn('Loupe: could not save window positions:', err.message);
    }
  }

  function workAreas() {
    try {
      return screen().getAllDisplays().map((d) => d.workArea);
    } catch {
      return [];
    }
  }

  // BrowserWindow options for window `name`: its remembered bounds, or the
  // defaults. Spread into the constructor options.
  function options(name, defaults) {
    return { ...defaults, ...restoreBounds(read()[name], defaults, workAreas()) };
  }

  // Remembers `win`'s place as `name` whenever it moves or resizes, and
  // maximises it again if it was left maximised.
  function track(win, name) {
    if (read()[name]?.maximized) win.maximize();
    const remember = () => {
      try {
        if (win.isDestroyed() || win.isMinimized() || win.isFullScreen()) return;
        const maximized = win.isMaximized();
        // Maximised, the size to go back to is the one before.
        read()[name] = maximized ? { ...read()[name], maximized } : { ...win.getNormalBounds(), maximized };
      } catch {
        return; // a window already on its way out
      }
      clearTimeout(timer);
      timer = setTimeout(write, delayMs);
    };
    for (const ev of ['resize', 'move', 'maximize', 'unmaximize']) win.on(ev, remember);
    win.on('close', () => {
      remember();
      if (timer) write();
    });
    return win;
  }

  return { options, track, flush: () => { if (timer) write(); } };
}

module.exports = { createWindowState, restoreBounds, MIN_VISIBLE };
