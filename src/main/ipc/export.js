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
//
// Each finished export is remembered in the recording's folder
// (exports.json, newest first) so the editor can list "Recent exports".

const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { resolveBackgroundFile } = require('./background');
const { audioFileUrls } = require('./project-files');
const { writeSubtitlesBeside } = require('./captions');

const FORMATS = ['mp4', 'webm', 'gif'];
const RESOLUTIONS = ['720p', '1080p', '1440p', '4k'];
const CODECS = ['h264', 'hevc'];
const QUALITIES = ['high', 'balanced', 'small'];
const FRAME_RATES = [24, 25, 30, 50, 60];
const GIF_WIDTHS = [480, 720, 960];
const GIF_FRAME_RATES = [10, 15, 20];
const SIZE_LIMIT_MB = [1, 4000];
const RECENT_FILE = 'exports.json';
const MAX_RECENT = 10;
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
  if (opts.format !== undefined && !FORMATS.includes(opts.format)) {
    throw new Error(`Unknown export format: ${JSON.stringify(opts.format)}`);
  }
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
  // Captions: burn them into the picture (undefined = as the project shows
  // them), and/or save a .srt beside the video.
  for (const key of ['burnCaptions', 'subtitles']) {
    if (opts[key] !== undefined && typeof opts[key] !== 'boolean') {
      throw new Error(`Export option ${key} must be true or false.`);
    }
  }
  if (opts.sizeLimit !== undefined && opts.sizeLimit !== null &&
      !(Number.isFinite(opts.sizeLimit) && opts.sizeLimit >= SIZE_LIMIT_MB[0] && opts.sizeLimit <= SIZE_LIMIT_MB[1])) {
    throw new Error(`The size limit must be from ${SIZE_LIMIT_MB[0]} to ${SIZE_LIMIT_MB[1]} MB.`);
  }
  if (opts.gifWidth !== undefined && !GIF_WIDTHS.includes(opts.gifWidth)) {
    throw new Error(`Unsupported GIF width: ${JSON.stringify(opts.gifWidth)}`);
  }
  if (opts.gifFps !== undefined && !GIF_FRAME_RATES.includes(opts.gifFps)) {
    throw new Error(`Unsupported GIF frame rate: ${JSON.stringify(opts.gifFps)}`);
  }
  if (opts.dither !== undefined && typeof opts.dither !== 'boolean') {
    throw new Error('Dithering must be on or off.');
  }
  const out = { resolution, codec: opts.codec, quality: opts.quality, fps: opts.fps };
  // Only named when given, so callers that predate them see the same shape.
  for (const key of ['format', 'sizeLimit', 'gifWidth', 'gifFps', 'dither']) {
    if (opts[key] !== undefined) out[key] = opts[key];
  }
  if (opts.burnCaptions !== undefined) out.burnCaptions = opts.burnCaptions;
  if (opts.subtitles) out.subtitles = true;
  return out;
}

// src/core is ES modules; require() of them works in this Node, but only
// once they're needed, so the rest of main starts without them.
let core = null;
function loadCore() {
  core ??= {
    project: require('../../core/project.js'),
    plan: require('../../core/export-plan.js')
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
  const { project: P, plan } = loadCore();
  const opts = validateExportOptions(rawOptions);
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(path.join(dir, 'project.json'), 'utf8'));
  } catch {
    throw new Error("Couldn't read this recording's project file.");
  }
  let project = P.loadProjectData(raw);
  const exportPatch = {};
  for (const key of ['format', 'resolution', 'codec', 'quality', 'fps', 'sizeLimit', 'gifWidth', 'gifFps', 'dither']) {
    if (opts[key] !== undefined) exportPatch[key] = opts[key];
  }
  project = P.setExport(project, exportPatch);
  if (opts.burnCaptions !== undefined) project = P.setCaptions(project, { show: opts.burnCaptions });

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
      systemAudio: meta.systemAudio ? fileUrlIfExists(recordingFile(base, meta.systemAudio, 'sound')) : null,
      webcam: meta.webcam?.file ? fileUrlIfExists(recordingFile(base, meta.webcam.file, 'webcam')) : null,
      keys: meta.keys ? fileUrlIfExists(recordingFile(base, meta.keys, 'keyboard shortcuts')) : null
    };
  }

  // Only a bundled wallpaper or a picture copied into this project (see
  // ipc/background.js), never any other path project.json might name.
  const bg = project.style.background;
  const bgFile = bg.type === 'image' ? resolveBackgroundFile(dir, bg.value) : null;
  const background = bgFile ? pathToFileURL(bgFile).href : null;

  const ex = project.export;
  const size = plan.outputSize(project, ex);
  const job = {
    project, sources, background,
    // Music and voiceover takes, checked to be inside this project's folder.
    audioFiles: audioFileUrls(dir, project),
    format: ex.format, resolution: ex.resolution, codec: ex.codec, quality: ex.quality, fps: ex.fps,
    sizeLimit: ex.sizeLimit, gifWidth: ex.gifWidth, gifFps: ex.gifFps, dither: ex.dither
  };
  return { job, project, subtitles: opts.subtitles === true, out: out ?? path.join(dir, plan.exportFileName(ex, size)) };
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
        // A size-limited export may have run twice, the second pass shorter:
        // the file ends where the page says the last pass ended.
        if (!err && Number.isSafeInteger(summary?.bytes) && summary.bytes > 0 && state.handle) {
          await state.handle.truncate(summary.bytes).catch((e) => { err = new Error(`Couldn't save the video (${e.message}).`); });
        }
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

// ---------------------------------------------------------------- recent exports

// exports.json holds [{ name, format, width, height, duration, bytes, at }],
// newest first. Only a plain file name is kept: the list travels with the
// recording's folder and can't point anywhere outside it.
function readRecentFile(dir) {
  try {
    const list = JSON.parse(fs.readFileSync(path.join(dir, RECENT_FILE), 'utf8'));
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

const isPlainName = (name) => typeof name === 'string' && name.length > 0 && name.length <= 255 &&
  path.basename(name) === name && !name.includes('\\') && name !== '..' && name !== '.';

// The exports that still exist, with their full paths, newest first.
function recentExports(dir) {
  const out = [];
  for (const e of readRecentFile(dir)) {
    if (!isPlainName(e?.name) || !FORMATS.includes(e.format)) continue;
    const file = path.join(dir, e.name);
    let stat;
    try {
      stat = fs.statSync(file);
    } catch {
      continue;
    }
    if (!stat.isFile()) continue;
    const num = (v) => (Number.isFinite(v) ? v : null);
    out.push({
      file, name: e.name, format: e.format, width: num(e.width), height: num(e.height),
      duration: num(e.duration), bytes: stat.size, at: num(e.at)
    });
  }
  return out;
}

// Adds a finished export to the front (an export over the same file replaces
// its old entry). A folder that can't be written only loses the list.
function rememberExport(dir, result, { now = Date.now() } = {}) {
  const name = path.basename(result.file);
  const entry = {
    name, format: result.format ?? path.extname(name).slice(1),
    width: result.width, height: result.height, duration: result.duration,
    bytes: result.bytes, at: now
  };
  const list = [entry, ...readRecentFile(dir).filter((e) => e?.name !== name)].slice(0, MAX_RECENT);
  try {
    const tmp = path.join(dir, `${RECENT_FILE}.tmp`);
    fs.writeFileSync(tmp, JSON.stringify(list, null, 2));
    fs.renameSync(tmp, path.join(dir, RECENT_FILE));
  } catch (e) {
    console.warn('Loupe: could not remember the export:', e.message);
  }
  return entry;
}

// export:start resolves with { file, frames, seconds, ... } once the video is
// saved; progress goes to the window that asked, as export:progress.
// `beforeStart` runs first (main flushes the editor's pending project save,
// since the job is built from project.json on disk). export:reveal shows the
// last exported file in Finder/Explorer -- only that file, whatever the
// renderer asks, so it can't be used to open arbitrary folders.
// `onExported(file)` hears of every finished export (main's list of files
// that may be shared, copied or dragged).
function registerExportIpc({ ipcMain, runner, projectDir, beforeStart = () => {}, shell = null, onExported = () => {} }) {
  let lastFile = null;
  ipcMain.handle('export:start', async (event, rawOptions) => {
    if (runner.busy()) throw new Error('An export is already in progress.');
    const dir = projectDir();
    if (!dir) throw new Error('There is no recording open to export.');
    await beforeStart();
    const { job, out, project, subtitles } = buildJob(dir, rawOptions);
    const sender = event.sender;
    const result = await runner.start(job, out, {
      onProgress: (p) => { if (!sender.isDestroyed?.()) sender.send('export:progress', p); }
    });
    lastFile = result.file;
    onExported(result.file);
    if (subtitles) {
      // The video is saved either way; a subtitle problem is reported beside it.
      try {
        result.subtitles = await writeSubtitlesBeside(result.file, project);
      } catch (err) {
        result.subtitlesError = `Couldn't save the subtitles (${err.message}).`;
      }
    }
    if (path.dirname(result.file) === dir) rememberExport(dir, result);
    return result;
  });
  // The open recording's earlier exports that still exist, newest first.
  ipcMain.handle('export:recent', () => {
    const dir = projectDir();
    return dir ? recentExports(dir) : [];
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
  recentExports, rememberExport,
  FORMATS, RESOLUTIONS, CODECS, QUALITIES
};
