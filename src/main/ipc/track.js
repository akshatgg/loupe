'use strict';
// "Follow what's under it" for a hidden area (docs/EDITOR-V2.md), main-process
// side.
//
// The recording's frames are decoded in a hidden window, the same way export
// decodes them (src/renderer/exporter/tracker.js, with the exporter's
// decoder), and matched from frame to frame by src/core/track.js. This module
// decides what to follow (buildTrackJob, from project.json on disk), runs one
// follow at a time in that window (createTrackRunner), checks what comes back
// and hands the editor the path as track:start's result, with track:progress
// events on the way (registerTrackIpc).
//
// Nothing is written here: the editor stores the path on the annotation as
// one edit, so cancelling or a failure leaves the project as it was.

const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

let core = null;
function loadCore() {
  core ??= {
    project: require('../../core/project.js'),
    track: require('../../core/track.js')
  };
  return core;
}

// The editor is not a trust boundary: it names an annotation, nothing more.
function validateTrackRequest(raw) {
  if (!isPlainObject(raw) || typeof raw.id !== 'string' || !raw.id || raw.id.length > 64) {
    throw new Error('Invalid request to follow a hidden area.');
  }
  return { id: raw.id };
}

// project.json in `dir` + { id } -> what the page needs: the recording as a
// file:// URL, and the box and the stretch of the recording to follow.
function buildTrackJob(dir, rawRequest) {
  const { project: P } = loadCore();
  const { id } = validateTrackRequest(rawRequest);
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(path.join(dir, 'project.json'), 'utf8'));
  } catch {
    throw new Error("Couldn't read this recording's project file.");
  }
  const project = P.loadProjectData(raw);
  const a = project.annotations.find((x) => x.id === id);
  if (!a || a.type !== 'blur') throw new Error('That hidden area is no longer in the video.');
  const meta = project.sources[a.source];
  const base = path.resolve(dir, meta.dir ?? '.');
  // A file named by project.json, which people can edit: a plain relative
  // name inside the recording's folder (as ipc/export.js checks it).
  const name = meta.video;
  if (typeof name !== 'string' || !name || path.isAbsolute(name) || name.split(/[\\/]/).includes('..')) {
    throw new Error(`The project names an invalid video file: ${JSON.stringify(name)}`);
  }
  const video = path.join(base, name);
  if (!fs.existsSync(video)) throw new Error(`The recording's video file is missing (${path.basename(video)}).`);
  return {
    id,
    video: pathToFileURL(video).href,
    rotation: meta.rotation ?? 0,
    start: a.start,
    end: a.end,
    rect: { x: a.x, y: a.y, w: a.w, h: a.h }
  };
}

// What the page says it found, checked: a path the project would accept,
// inside the stretch that was asked for.
function cleanTrackResult(raw, job) {
  const { track: T } = loadCore();
  if (!isPlainObject(raw) || !Array.isArray(raw.path) || raw.path.length < 2 || raw.path.length > T.MAX_PATH_POINTS) {
    throw new Error('The follow came back without a usable path.');
  }
  const eps = 1e-3;
  let last = -Infinity;
  const points = raw.path.map((pt) => {
    const ok = isPlainObject(pt) && [pt.t, pt.x, pt.y].every(Number.isFinite) &&
      pt.t >= job.start - eps && pt.t <= job.end + eps && pt.t > last &&
      pt.x >= -1 && pt.x <= 2 && pt.y >= -1 && pt.y <= 2;
    if (!ok) throw new Error('The follow came back without a usable path.');
    last = pt.t;
    return { t: Math.max(0, pt.t), x: pt.x, y: pt.y };
  });
  let lostAt = null;
  if (raw.lostAt !== null && raw.lostAt !== undefined) {
    if (!Number.isFinite(raw.lostAt) || raw.lostAt < job.start - eps || raw.lostAt > job.end + eps) {
      throw new Error('The follow came back without a usable path.');
    }
    lostAt = raw.lostAt;
  }
  const count = (v) => (Number.isFinite(v) && v >= 0 ? v : 0);
  return { path: points, lostAt, frames: count(raw.frames), seconds: count(raw.seconds) };
}

// Only plain numbers come back as progress.
function cleanProgress(p) {
  const out = {};
  if (!isPlainObject(p)) return out;
  for (const key of ['frame', 'total']) {
    if (Number.isFinite(p[key]) && p[key] >= 0) out[key] = p[key];
  }
  return out;
}

function createTrackRunner({ BrowserWindow, preload, page, show = false }) {
  let active = null;

  // Resolves with the checked result, or { cancelled: true }; rejects with
  // why it failed, in words for the person.
  function start(job, { onProgress = () => {} } = {}) {
    if (active) return Promise.reject(new Error('A hidden area is already being followed.'));
    const state = { settled: false, win: null, finish: null, done: null };
    active = state;
    state.done = new Promise((resolve, reject) => {
      state.finish = (err, result) => {
        if (state.settled) return;
        state.settled = true;
        if (state.win && !state.win.isDestroyed()) state.win.destroy();
        if (active === state) active = null;
        if (err) reject(err);
        else resolve(result);
      };
      const win = new BrowserWindow({
        show, width: 480, height: 270, title: 'Loupe — Following',
        webPreferences: {
          preload, sandbox: true, contextIsolation: true, nodeIntegration: false,
          // A hidden window's timers are throttled by default.
          backgroundThrottling: false
        }
      });
      state.win = win;
      const ipc = win.webContents.ipc;
      ipc.handle('tracker:job', () => job);
      ipc.on('tracker:progress', (_e, p) => {
        if (!state.settled) onProgress(cleanProgress(p));
      });
      ipc.on('tracker:done', (_e, raw) => {
        try {
          state.finish(null, cleanTrackResult(raw, job));
        } catch (e) {
          state.finish(e);
        }
      });
      ipc.on('tracker:fail', (_e, message) => {
        state.finish(new Error(typeof message === 'string' && message ? message.slice(0, 500) : 'Following the hidden area failed.'));
      });
      win.webContents.on('render-process-gone', () => state.finish(new Error('Following the hidden area stopped unexpectedly.')));
      win.on('closed', () => state.finish(null, { cancelled: true }));
      Promise.resolve(win.loadFile(page)).catch((e) => state.finish(new Error(`Couldn't start following (${e.message}).`)));
    });
    return state.done;
  }

  // Stops the follow in progress, if any. Safe to call at any time.
  async function cancel() {
    const state = active;
    if (!state) return false;
    state.finish(null, { cancelled: true });
    await state.done.catch(() => {});
    return true;
  }

  return { start, cancel, busy: () => active !== null };
}

// track:start({ id }) resolves with { path, lostAt, frames, seconds, start,
// rect } -- the path for the editor to store, and the box it was made for so
// the editor can tell whether the annotation changed meanwhile -- or with
// { cancelled: true }. `beforeStart` runs first (main flushes the editor's
// pending project save: the job is built from project.json on disk).
function registerTrackIpc({ ipcMain, runner, projectDir, beforeStart = () => {} }) {
  ipcMain.handle('track:start', async (event, rawRequest) => {
    const request = validateTrackRequest(rawRequest);
    if (runner.busy()) throw new Error('A hidden area is already being followed.');
    const dir = projectDir();
    if (!dir) throw new Error('There is no recording open.');
    await beforeStart();
    const job = buildTrackJob(dir, request);
    const sender = event.sender;
    const result = await runner.start(job, {
      onProgress: (p) => { if (!sender.isDestroyed?.()) sender.send('track:progress', p); }
    });
    if (result.cancelled) return { cancelled: true };
    return { ...result, id: job.id, start: job.start, rect: job.rect };
  });
  ipcMain.handle('track:cancel', () => runner.cancel());
}

module.exports = { validateTrackRequest, buildTrackJob, cleanTrackResult, createTrackRunner, registerTrackIpc };
