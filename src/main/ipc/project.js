'use strict';
// The editor's project file (docs/EDITOR-V2.md section 3), main-process side.
//
// The editor holds the whole project in memory, makes every edit with the
// pure core (src/core/project.js) and sends the result back here to be kept.
// That replaces v1's one-handler-per-action IPC: there are only two calls,
//
//   project:load -> { project (v2), sources: { [key]: { video, cursor,
//                    systemAudio, webcam, keys, missing } } as file:// URLs,
//                    migrated, folder (file:// URL of the project folder) }
//   project:save (project) -> { saved: true }   (checked; written shortly after)
//   project:written -> { ok } | { ok: false, message }   (event, after each write)
//
// A v1 project.json is migrated in memory on load and written as v2 on the
// first save, so opening an old recording without changing anything leaves
// its file as it was.
//
// Saves are debounced: dragging a zoom's edge sends dozens of projects a
// second and only the last one needs to reach the disk. Each write goes to a
// temporary file that is then renamed over project.json, so a crash or a
// full disk mid-write never leaves a half-written project behind. Export and
// closing the editor flush a pending save first.

const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const SAVE_DELAY_MS = 400;
// A project is a few kilobytes; anything near this is not one.
const MAX_PROJECT_BYTES = 16 * 1024 * 1024;

let core = null;
function loadCore() {
  core ??= require('../../core/project.js');
  return core;
}

// A file named by project.json, which people can edit: it must stay a plain
// relative name inside the recording's folder.
function recordingFile(base, name) {
  if (typeof name !== 'string' || !name || path.isAbsolute(name) ||
      name.split(/[\\/]/).includes('..')) return null;
  return path.join(base, name);
}

const fileUrl = (file) => (file && fs.existsSync(file) ? pathToFileURL(file).href : null);

// Recordings are saved in a folder named by the moment they started (ms), which
// becomes the default title of a migrated project.
function createdAtFor(dir) {
  const n = Number(path.basename(dir));
  if (Number.isSafeInteger(n) && n > 1e12) return n;
  try {
    return Math.round(fs.statSync(path.join(dir, 'project.json')).birthtimeMs) || null;
  } catch {
    return null;
  }
}

function readProject(dir) {
  const file = path.join(dir, 'project.json');
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    throw new Error(err.code === 'ENOENT'
      ? "This recording's project file is missing."
      : "This recording's project file couldn't be read.");
  }
  const project = loadCore().loadProjectData(raw, { createdAt: createdAtFor(dir) });
  return { project, migrated: raw.version !== project.version };
}

// Everything the editor's preview needs to load, per recording, as file://
// URLs (so Windows paths work). A missing video is reported, not thrown: the
// editor says so in plain words and still shows the rest.
function sourceFiles(dir, project) {
  const out = {};
  for (const [key, meta] of Object.entries(project.sources)) {
    const base = path.resolve(dir, meta.dir ?? '.');
    const video = recordingFile(base, meta.video);
    out[key] = {
      video: fileUrl(video),
      cursor: meta.cursor ? fileUrl(recordingFile(base, meta.cursor)) : null,
      systemAudio: meta.systemAudio ? fileUrl(recordingFile(base, meta.systemAudio)) : null,
      webcam: meta.webcam?.file ? fileUrl(recordingFile(base, meta.webcam.file)) : null,
      keys: meta.keys ? fileUrl(recordingFile(base, meta.keys)) : null,
      missing: !video || !fs.existsSync(video)
    };
  }
  return out;
}

const folderUrl = (dir) => pathToFileURL(path.join(dir, path.sep)).href;

function writeAtomic(dir, project) {
  const file = path.join(dir, 'project.json');
  const tmp = path.join(dir, `.project.json.${process.pid}.tmp`);
  fs.writeFileSync(tmp, `${JSON.stringify(project, null, 2)}\n`);
  try {
    fs.renameSync(tmp, file);
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    throw err;
  }
}

// Plain words for a save that failed on disk.
function saveErrorMessage(err) {
  switch (err?.code) {
    case 'ENOENT': return "This recording's folder is gone, so your changes can't be saved. It may have been moved, renamed or deleted.";
    case 'ENOSPC': return 'The disk is full, so your changes can’t be saved. Free up some space and try again.';
    case 'EACCES': case 'EPERM': case 'EROFS':
      return 'Loupe isn’t allowed to write to this recording’s folder, so your changes can’t be saved.';
    default: return `Your changes couldn’t be saved (${err?.message ?? 'unknown error'}).`;
  }
}

// One store for the app: the project last loaded for a folder, and at most
// one pending (debounced) save. The write happens after project:save has
// already answered, so its outcome is reported separately: onError(err, dir)
// when one fails, and every write -- done or failed -- to the listeners added
// with onWritten(fn({ dir, error })), which registerProjectIpc uses to tell
// the editor (so it says "Couldn't save" rather than "All changes saved").
function createProjectStore({ delayMs = SAVE_DELAY_MS, onError = () => {} } = {}) {
  const writeListeners = new Set();
  const written = (dir, error = null) => {
    for (const fn of writeListeners) fn({ dir, error });
  };
  // dir -> the recordings as loaded. The editor can't change which files a
  // project points at (a renderer that could would be able to make the
  // exporter read any file on disk), so every save keeps these.
  const known = new Map();
  // dir -> a name given from the Library while the editor had the project
  // open. The editor is told, but a save it sent before hearing would put
  // the old name back, so saves carry this name until one arrives with it.
  const titles = new Map();
  let pending = null; // { dir, project }
  let timer = null;

  function load(dir) {
    if (typeof dir !== 'string' || !dir) throw new Error('There is no recording open.');
    if (pending?.dir === dir) {
      try { flush(); } catch { /* reported; the file on disk is what opens */ }
    } else {
      flushOther(dir);
    }
    const { project, migrated } = readProject(dir);
    known.set(dir, project.sources);
    titles.delete(dir);
    // `folder` (a file:// URL ending in "/") is where the editor finds the
    // music and voiceover files the project names.
    return { project, sources: sourceFiles(dir, project), migrated, folder: folderUrl(dir) };
  }

  // Checks the project now (so the editor hears about a bad one), writes it
  // a moment later.
  function save(dir, raw) {
    if (typeof dir !== 'string' || !dir) throw new Error('There is no recording open.');
    if (!known.has(dir)) throw new Error('Open the recording before saving it.');
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('That is not a project.');
    const size = JSON.stringify(raw).length;
    if (size > MAX_PROJECT_BYTES) throw new Error('That project is too large to save.');
    let project = loadCore().validateProject({ ...raw, version: loadCore().VERSION, sources: known.get(dir) });
    if (titles.has(dir)) {
      if (project.title === titles.get(dir)) titles.delete(dir);
      else project = { ...project, title: titles.get(dir) };
    }
    flushOther(dir);
    pending = { dir, project };
    clearTimeout(timer);
    timer = setTimeout(() => {
      try {
        flush();
      } catch {
        // Already reported through onError.
      }
    }, delayMs);
    return project;
  }

  // Writes the pending save now, if any. Throws if it can't be written; the
  // project stays pending, so closing the editor or the next edit tries again.
  function flush() {
    clearTimeout(timer);
    timer = null;
    if (!pending) return false;
    const { dir, project } = pending;
    pending = null;
    try {
      writeAtomic(dir, project);
    } catch (err) {
      pending ??= { dir, project };
      onError(err, dir);
      written(dir, err);
      throw err;
    }
    written(dir);
    return true;
  }

  // Another recording's save still waiting is written before this one takes
  // its place. If that fails (its folder is gone) it was reported and is
  // dropped: it must not stop this recording from opening or saving.
  function flushOther(dir) {
    if (!pending || pending.dir === dir) return;
    try {
      flush();
    } catch {
      if (pending?.dir !== dir) pending = null;
    }
  }

  // The recordings the open project may use, as loaded plus any added since.
  function sources(dir) {
    return known.get(dir) ?? null;
  }

  // Another recording joins the project in `dir` as `key` (Add recording,
  // ipc/append-recording.js). Only main adds one, from a folder it checked,
  // so the page still can't point the project at other files.
  function addSource(dir, key, meta) {
    if (!known.has(dir)) throw new Error('Open the recording before adding another one to it.');
    known.set(dir, { ...known.get(dir), [key]: meta });
  }

  // The Library renamed the open project (already written to disk by then).
  function retitle(dir, title) {
    if (!known.has(dir)) return;
    titles.set(dir, title);
    if (pending?.dir === dir) pending = { dir, project: { ...pending.project, title } };
  }

  function onWritten(fn) {
    writeListeners.add(fn);
    return () => writeListeners.delete(fn);
  }

  return { load, save, flush, sources, addSource, retitle, onWritten, pending: () => pending !== null };
}

// Each write is reported to the window that last loaded or saved that
// folder's project, as project:written { ok } | { ok: false, message }.
function registerProjectIpc({ ipcMain, store, projectDir }) {
  const senders = new Map(); // dir -> webContents
  store.onWritten?.(({ dir, error }) => {
    const sender = senders.get(dir);
    if (!sender || sender.isDestroyed?.()) return;
    sender.send('project:written', error ? { ok: false, message: saveErrorMessage(error) } : { ok: true });
  });
  ipcMain.handle('project:load', (event) => {
    const dir = projectDir();
    const loaded = store.load(dir);
    if (event?.sender) senders.set(dir, event.sender);
    return loaded;
  });
  ipcMain.handle('project:save', (event, project) => {
    const dir = projectDir();
    store.save(dir, project);
    if (event?.sender) senders.set(dir, event.sender);
    return { saved: true };
  });
}

module.exports = {
  createProjectStore, registerProjectIpc, readProject, sourceFiles, writeAtomic, saveErrorMessage, SAVE_DELAY_MS
};
