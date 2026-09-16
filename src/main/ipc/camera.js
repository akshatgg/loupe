'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { reserveDuration, durationElement } = require('../webm');
const { WEBCAM_FILE } = require('../recording-v2');

// The webcam bubble: a small round always-on-top window showing the camera
// (src/renderer/camera/), opened when the bar is armed so the user can see
// themselves before pressing Start, and recording webcam.webm with
// MediaRecorder while the screen records. It is kept out of the screen
// recording like the bar: its window id goes to bin/capture --exclude-window
// on macOS (main.js adds mediaSourceId() to the list), and on Windows the
// window opts out of capture itself (`excludeFromCapture`).
//
// Lifecycle, driven by main.js:
//   open({deviceId})  arm: window up, camera preview running
//   start(dir)        recording started: the page starts MediaRecorder
//   finish()          Stop: the page stops, the last chunk lands, the file is
//                     closed and given its duration; resolves
//                     { file, startLocal, width, height } or null
//   close()           Back/teardown: window closed, anything unfinished dropped
//
// Alignment (see clock-sync.js for the other half): the page reports, with
// camera:started, how many milliseconds ago on its own clock MediaRecorder's
// start event fired (performance.now() - event.timeStamp, both on the page's
// clock). This process subtracts that from its own clock on arrival:
//
//   startLocal = now() - startedAgoMs / 1000
//
// which leaves only the IPC hop (well under a millisecond) unaccounted for.
// recorder.stop() maps startLocal into source time for
// sources.main.webcam.offset. What cannot be measured from here is the
// camera's own capture latency (the time between light hitting the sensor
// and the frame reaching MediaRecorder, typically one to three frames).
//
// The page is not trusted any more than other renderers: every message is
// checked to come from the bubble's own webContents, during a session, with
// sane values.

const MAX_CHUNK_BYTES = 64 * 1024 * 1024;
const STOP_TIMEOUT_MS = 5000;
const BUBBLE_SIZE = 180;

function isPositiveInt(v, max) {
  return Number.isInteger(v) && v > 0 && v <= max;
}

function toBuffer(data) {
  if (Buffer.isBuffer(data)) return data;
  if (data instanceof Uint8Array) return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  return null;
}

// camera access on macOS is a TCC permission like the microphone; Windows
// only has a system-wide switch, and 'denied' is all it can say.
function cameraAccess(systemPreferences, platform = process.platform) {
  const status = () => {
    try {
      return systemPreferences.getMediaAccessStatus('camera');
    } catch {
      return 'unknown';
    }
  };
  return {
    granted: () => (platform === 'win32' ? status() !== 'denied' : status() === 'granted'),
    request: async () => {
      if (platform === 'darwin' && typeof systemPreferences.askForMediaAccess === 'function') {
        return systemPreferences.askForMediaAccess('camera');
      }
      return platform === 'win32' ? status() !== 'denied' : status() === 'granted';
    }
  };
}

function createCameraBubble({
  BrowserWindow, ipcMain, preload, page, excludeFromCapture = () => {},
  getWorkArea = () => null, now, onChange = () => {}
}) {
  let win = null;
  let deviceId = null;
  let error = null;
  let session = null;

  function newSession(dir) {
    return {
      dir,
      file: path.join(dir, WEBCAM_FILE),
      fd: null,
      writes: Promise.resolve(),
      bytes: 0,
      firstChunk: true,
      durationOffset: null,
      timecodeScale: null,
      startLocal: null,
      width: 0,
      height: 0,
      finishing: false,
      stopped: null, // resolves when the page reports camera:stopped
      resolveStopped: null,
      durationMs: null
    };
  }

  const fromBubble = (event) => Boolean(win && !win.isDestroyed() && event?.sender === win.webContents);

  function fail(message) {
    error = message;
    const toClose = win;
    win = null;
    if (session) abortSession();
    if (toClose && !toClose.isDestroyed()) toClose.close();
    onChange();
  }

  function abortSession() {
    const s = session;
    session = null;
    if (!s) return;
    s.resolveStopped?.();
    // A recording the project will never point at is not worth keeping.
    s.writes = s.writes.then(() => {
      if (s.fd !== null) fs.closeSync(s.fd);
      s.fd = null;
      return fs.promises.unlink(s.file);
    }).catch(() => {});
  }

  ipcMain.handle('camera:init', (event) => (fromBubble(event) ? { deviceId } : null));

  ipcMain.handle('camera:started', (event, info) => {
    if (!fromBubble(event) || !session || session.startLocal !== null) return;
    const ago = Number(info?.startedAgoMs);
    if (!Number.isFinite(ago) || ago < 0 || ago > 60000) return;
    session.startLocal = now() - ago / 1000;
    session.width = isPositiveInt(info.width, 16384) ? info.width : 0;
    session.height = isPositiveInt(info.height, 16384) ? info.height : 0;
  });

  ipcMain.handle('camera:chunk', (event, data) => {
    if (!fromBubble(event) || !session) return;
    const buf = toBuffer(data);
    if (!buf || buf.length === 0 || buf.length > MAX_CHUNK_BYTES) return;
    const s = session;
    // Chunks are written strictly in arrival order.
    s.writes = s.writes.then(() => {
      if (s.fd === null) return;
      let bytes = buf;
      if (s.firstChunk) {
        s.firstChunk = false;
        const reserved = reserveDuration(buf);
        bytes = reserved.chunk;
        s.durationOffset = reserved.durationOffset;
        s.timecodeScale = reserved.timecodeScale;
      }
      fs.writeSync(s.fd, bytes, 0, bytes.length, s.bytes);
      s.bytes += bytes.length;
    }).catch((err) => {
      error = `camera file: ${err.message}`;
    });
  });

  ipcMain.handle('camera:stopped', (event, info) => {
    if (!fromBubble(event) || !session) return;
    const ms = Number(info?.durationMs);
    if (Number.isFinite(ms) && ms > 0 && ms < 24 * 3600 * 1000) session.durationMs = ms;
    session.resolveStopped?.();
  });

  ipcMain.handle('camera:error', (event, info) => {
    if (!fromBubble(event)) return;
    const message = typeof info?.message === 'string' ? info.message.slice(0, 200) : 'camera error';
    fail(message);
  });

  function open(opts = {}) {
    deviceId = typeof opts.deviceId === 'string' ? opts.deviceId : null;
    error = null;
    if (win && !win.isDestroyed()) return win;
    // Bottom-right of the screen the user is working on, clear of the edge.
    const area = getWorkArea();
    const margin = 24;
    const position = area
      ? { x: Math.round(area.x + area.width - BUBBLE_SIZE - margin),
          y: Math.round(area.y + area.height - BUBBLE_SIZE - margin) }
      : {};
    const w = new BrowserWindow({
      width: BUBBLE_SIZE, height: BUBBLE_SIZE, ...position,
      frame: false, transparent: true, hasShadow: false, resizable: false,
      movable: true, skipTaskbar: true, fullscreenable: false,
      // Like the bar: never takes focus from the app being recorded.
      focusable: false, show: false, backgroundColor: '#00000000',
      webPreferences: { preload }
    });
    win = w;
    excludeFromCapture(w);
    w.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    w.setAlwaysOnTop(true, 'screen-saver');
    w.loadFile(page);
    w.once('ready-to-show', () => { if (!w.isDestroyed()) w.showInactive(); });
    w.once('closed', () => {
      if (win === w) {
        win = null;
        if (session && !session.finishing) abortSession();
        onChange();
      }
    });
    return w;
  }

  // The window's CGWindowID (macOS) for --exclude-window, or null.
  function windowId() {
    if (!win || win.isDestroyed()) return null;
    return win.getMediaSourceId().split(':')[1] ?? null;
  }

  function start(dir) {
    if (!win || win.isDestroyed() || session) return false;
    const s = newSession(dir);
    try {
      fs.mkdirSync(dir, { recursive: true });
      s.fd = fs.openSync(s.file, 'w');
    } catch (err) {
      error = `camera file: ${err.message}`;
      return false;
    }
    s.stopped = new Promise((resolve) => { s.resolveStopped = resolve; });
    session = s;
    win.webContents.send('camera:command', { action: 'start' });
    return true;
  }

  async function finish() {
    const s = session;
    if (!s) { close(); return null; }
    s.finishing = true;
    const w = win;
    if (w && !w.isDestroyed()) {
      // Gone from the screen at once; the page keeps running until the last
      // chunk is in.
      w.hide();
      w.webContents.send('camera:command', { action: 'stop' });
      let timer;
      await Promise.race([
        s.stopped,
        new Promise((resolve) => { timer = setTimeout(resolve, STOP_TIMEOUT_MS); })
      ]);
      clearTimeout(timer);
    }
    if (session === s) session = null;
    await s.writes;
    if (w && !w.isDestroyed()) w.close();
    if (w === win) win = null;

    const ok = s.fd !== null && s.bytes > 0 && s.startLocal !== null;
    if (s.fd !== null) {
      try {
        if (ok && s.durationOffset !== null && s.durationMs !== null) {
          const el = durationElement(s.durationMs, s.timecodeScale);
          fs.writeSync(s.fd, el, 0, el.length, s.durationOffset);
        }
      } catch (err) {
        error = `camera file: ${err.message}`;
      }
      fs.closeSync(s.fd);
      s.fd = null;
    }
    if (!ok) {
      await fs.promises.unlink(s.file).catch(() => {});
      return null;
    }
    return { file: WEBCAM_FILE, startLocal: s.startLocal, width: s.width, height: s.height };
  }

  function close() {
    // Stop runs finish() and then tears everything down, which lands here:
    // the page is still sending its last chunk, so finish() closes the
    // window itself once that is in (or its timeout passes).
    if (session?.finishing) return;
    const w = win;
    win = null;
    if (session && !session.finishing) abortSession();
    if (w && !w.isDestroyed()) w.close();
  }

  return {
    open, start, finish, close, windowId,
    isOpen: () => Boolean(win && !win.isDestroyed()),
    isRecording: () => Boolean(session && session.startLocal !== null),
    error: () => error
  };
}

module.exports = { createCameraBubble, cameraAccess, BUBBLE_SIZE };
