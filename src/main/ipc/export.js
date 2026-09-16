'use strict';
// Export (docs/EDITOR-V2.md section 6), main-process side.
//
// The picture and sound are made in a hidden window (src/renderer/exporter)
// with WebCodecs, the same way on macOS and Windows. This module decides what
// to export and where (buildJob), runs one export at a time in that window
// (createExportRunner), writes the bytes it sends to disk, and exposes it to
// the editor as export:start / export:cancel with export:progress events
// (registerExportIpc).
//
// The file is written as "<name>.part" and renamed only once the export has
// finished, so a failed, cancelled or crashed export never leaves a file
// behind that looks like a finished video.

const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const RESOLUTIONS = ['720p', '1080p', '1440p', '4k'];
const CODECS = ['h264', 'hevc'];
const QUALITIES = ['high', 'balanced', 'small'];
const FRAME_RATES = [24, 25, 30, 50, 60];
// Limits on what the export page may ask main to write: positions inside a
// (very generous) file size, chunks no bigger than the muxer ever sends.
const MAX_FILE_BYTES = 256 * 1024 ** 3;
const MAX_WRITE_BYTES = 64 * 1024 * 1024;

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

// The editor is not a trust boundary: only known values get through.
// `preset` is what the v1 editor calls the resolution.
function validateExportOptions(raw) {
  if (raw !== undefined && !isPlainObject(raw)) throw new Error('Export options must be an object.');
  const opts = raw ?? {};
  const resolution = opts.resolution ?? opts.preset;
  if (resolution !== undefined && !RESOLUTIONS.includes(resolution)) {
    throw new Error(`Unknown export size: ${JSON.stringify(resolution)}`);
  }
  if (opts.codec !== undefined && !CODECS.includes(opts.codec)) {
    throw new Error(`Unknown video format: ${JSON.stringify(opts.codec)}`);
  }
  if (opts.quality !== undefined && !QUALITIES.includes(opts.quality)) {
    throw new Error(`Unknown export quality: ${JSON.stringify(opts.quality)}`);
  }
  if (opts.fps !== undefined && !FRAME_RATES.includes(opts.fps)) {
    throw new Error(`Unsupported frame rate: ${JSON.stringify(opts.fps)}`);
  }
  return { resolution, codec: opts.codec, quality: opts.quality, fps: opts.fps };
}

// src/core is ES modules; require() of them works in this Node, but only
// once they're needed, so the rest of main starts without them.
let core = null;
function loadCore() {
  core ??= {
    project: require('../../core/project.js'),
    compose: require('../../core/compose.js')
  };
  return core;
}

// A file named by project.json, which people can edit: it must stay a plain
// relative name inside the recording's folder.
function recordingFile(base, name, what) {
  if (typeof name !== 'string' || !name || path.isAbsolute(name) ||
      name.split(/[\\/]/).includes('..')) {
    throw new Error(`The project names an invalid ${what} file: ${JSON.stringify(name)}`);
  }
  return path.join(base, name);
}

const fileUrlIfExists = (file) => (fs.existsSync(file) ? pathToFileURL(file).href : null);

// project.json in `dir` (v1 or v2) + options -> { job, out, project }.
// `job` is everything the export page needs, with every file as a file://
// URL so Windows paths load too; `out` is where the video goes.
function buildJob(dir, rawOptions, { out } = {}) {
  const { project: P, compose } = loadCore();
  const opts = validateExportOptions(rawOptions);
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(path.join(dir, 'project.json'), 'utf8'));
  } catch {
    throw new Error("Couldn't read this recording's project file.");
  }
  let project = P.loadProjectData(raw);
  const exportPatch = {};
  for (const key of ['resolution', 'codec', 'quality', 'fps']) {
    if (opts[key] !== undefined) exportPatch[key] = opts[key];
  }
  project = P.setExport(project, exportPatch);

  const sources = {};
  for (const key of new Set(project.clips.map((c) => c.source))) {
    const meta = project.sources[key];
    const base = path.resolve(dir, meta.dir ?? '.');
    const video = recordingFile(base, meta.video, 'video');
    if (!fs.existsSync(video)) {
      throw new Error(`The recording's video file is missing (${path.basename(video)}).`);
    }
    sources[key] = {
      video: pathToFileURL(video).href,
      cursor: meta.cursor ? fileUrlIfExists(recordingFile(base, meta.cursor, 'cursor')) : null,
      systemAudio: meta.systemAudio ? fileUrlIfExists(recordingFile(base, meta.systemAudio, 'sound')) : null
    };
  }

  const bg = project.style.background;
  const background = bg.type === 'image' && typeof bg.value === 'string'
    ? fileUrlIfExists(path.resolve(dir, bg.value)) : null;

  const { width, height } = compose.exportSize(project);
  const ex = project.export;
  const job = {
    project, sources, background,
    resolution: ex.resolution, codec: ex.codec, quality: ex.quality, fps: ex.fps
  };
  return { job, project, out: out ?? path.join(dir, `export-${width}x${height}.mp4`) };
}

function cancelledError() {
  const err = new Error('Export cancelled.');
  err.cancelled = true;
  return err;
}

// Only plain numbers and short strings come back from the page.
function cleanReport(p) {
  const out = {};
  if (!isPlainObject(p)) return out;
  for (const [k, v] of Object.entries(p)) {
    if (typeof k !== 'string' || k.length > 32) continue;
    if ((typeof v === 'number' && Number.isFinite(v)) || typeof v === 'boolean' ||
        (typeof v === 'string' && v.length <= 64)) out[k] = v;
  }
  return out;
}

function createExportRunner({ BrowserWindow, preload, page, show = false }) {
  let active = null;

  function start(job, out, { onProgress = () => {} } = {}) {
    if (active) return Promise.reject(new Error('An export is already in progress.'));
    const part = `${out}.part`;
    const state = { part, out, settled: false, done: null, writes: Promise.resolve(), handle: null, win: null };
    active = state;

    state.done = new Promise((resolve, reject) => {
      const finish = async (err, summary) => {
        if (state.settled) return;
        state.settled = true;
        // Let writes already under way land (or fail) before closing the file.
        await state.writes.catch(() => {});
        await state.handle?.close().catch(() => {});
        if (state.win && !state.win.isDestroyed()) state.win.destroy();
        if (!err) {
          try {
            await fs.promises.rename(part, out);
          } catch (e) {
            err = new Error(`Couldn't save the video (${e.message}).`);
          }
        }
        if (err) await fs.promises.unlink(part).catch(() => {});
        if (active === state) active = null;
        if (err) reject(err);
        else resolve({ ...cleanReport(summary), file: out });
      };
      state.finish = finish;

      fs.promises.open(part, 'w').then((handle) => {
        state.handle = handle;
        if (state.settled) return;
        const win = new BrowserWindow({
          show, width: 480, height: 270, title: 'Loupe — Exporting',
          webPreferences: {
            preload, sandbox: true, contextIsolation: true, nodeIntegration: false,
            // A hidden window's timers are throttled by default, which would
            // slow the export to a crawl.
            backgroundThrottling: false
          }
        });
        state.win = win;
        const ipc = win.webContents.ipc;
        ipc.handle('exporter:job', () => job);
        ipc.handle('exporter:write', (_e, position, bytes) => {
          if (!Number.isSafeInteger(position) || position < 0 || position > MAX_FILE_BYTES) {
            throw new Error('Invalid write position.');
          }
          if (!(bytes instanceof Uint8Array) || bytes.byteLength > MAX_WRITE_BYTES) {
            throw new Error('Invalid write.');
          }
          if (state.settled) throw cancelledError();
          const write = state.writes.then(() => handle.write(bytes, 0, bytes.byteLength, position));
          state.writes = write.catch((e) => { finish(new Error(`Couldn't write the video (${e.message}).`)); });
          return write.then(() => undefined);
        });
        ipc.on('exporter:progress', (_e, p) => {
          if (!state.settled) onProgress(cleanReport(p));
        });
        ipc.handle('exporter:done', async (_e, summary) => {
          await state.writes;
          finish(null, summary);
        });
        ipc.on('exporter:fail', (_e, message) => {
          finish(new Error(typeof message === 'string' && message ? message.slice(0, 500) : 'The export failed.'));
        });
        win.webContents.on('render-process-gone', () => finish(new Error('The export stopped unexpectedly.')));
        win.on('closed', () => finish(cancelledError()));
        Promise.resolve(win.loadFile(page)).catch((e) => finish(new Error(`Couldn't start the export (${e.message}).`)));
      }).catch((e) => finish(new Error(`Couldn't create the video file (${e.message}).`)));
    });
    return state.done;
  }

  // Stops the export in progress, if any; resolves once its partial file is
  // gone. Safe to call at any time.
  async function cancel() {
    const state = active;
    if (!state) return false;
    await Promise.all([state.finish(cancelledError()), state.done.catch(() => {})]);
    return true;
  }

  return { start, cancel, busy: () => active !== null };
}

// export:start resolves with { file, frames, seconds, ... } once the video is
// saved; progress goes to the window that asked, as export:progress.
// `beforeStart` runs first (main flushes the editor's pending project save,
// since the job is built from project.json on disk). export:reveal shows the
// last exported file in Finder/Explorer -- only that file, whatever the
// renderer asks, so it can't be used to open arbitrary folders.
function registerExportIpc({ ipcMain, runner, projectDir, beforeStart = () => {}, shell = null }) {
  let lastFile = null;
  ipcMain.handle('export:start', async (event, rawOptions) => {
    if (runner.busy()) throw new Error('An export is already in progress.');
    const dir = projectDir();
    if (!dir) throw new Error('There is no recording open to export.');
    await beforeStart();
    const { job, out } = buildJob(dir, rawOptions);
    const sender = event.sender;
    const result = await runner.start(job, out, {
      onProgress: (p) => { if (!sender.isDestroyed?.()) sender.send('export:progress', p); }
    });
    lastFile = result.file;
    return result;
  });
  ipcMain.handle('export:cancel', () => runner.cancel());
  ipcMain.handle('export:reveal', () => {
    if (!shell || !lastFile || !fs.existsSync(lastFile)) return false;
    shell.showItemInFolder(lastFile);
    return true;
  });
}

module.exports = {
  validateExportOptions, buildJob, createExportRunner, registerExportIpc,
  RESOLUTIONS, CODECS, QUALITIES
};
